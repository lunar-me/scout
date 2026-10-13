/**
 * The snapshot race, and the four things that must stay true about it.
 *
 * Measured in production, twice, on one task against `www.saucedemo.com`: one
 * run died `failed` / `error` on step 2 in 3.6 s with a 1,513-token prompt,
 * having shown the model a committed-but-unrendered React shell; the other
 * completed the same task in 15 steps. `Page.navigate` resolves on commit and
 * nothing on the agent path waited for anything after it, so the tree the model
 * read had no controls in it, and the model did the only reasonable thing with
 * a page like that — `{"type":"fail"}`, which the loop honoured as its own
 * failure.
 *
 * Everything below is either a law about the fix or a law about its cost. The
 * cost matters as much as the fix: a settle that slows down every read that
 * lands on a page which has already finished would be paid for on every step of
 * every run. What bounds it is not emptiness — that gate is what served a nav
 * bar as a finished page — but STATE: a tree that has not moved since a settle
 * answered it is not settled again.
 */

import { describe, expect, test } from 'bun:test';

import type { Action } from '../src/actions';
import { LockHeldError, PageSession, runAgent } from '../src/loop';
import { DEFAULT_SETTLE_POLICY, settleTree, unrenderedNotice } from '../src/settle';
import type { AxTree } from '../src/snapshot';
import { VirtualClock, catalogueTree, harness, node, refOf, tree } from './support';

const CAPS = { steps: 8, budget: '2.00', duration: '5m' };
const done: Action = { type: 'done', summary: 'finished' };

/**
 * A committed document with nothing in it — the shell the failing production
 * run was shown. `genericContainer` is not actionable and not labelling, so the
 * filter promotes nothing out of it: exactly the tree that reads as "no input
 * fields are visible".
 */
function shell(revision: number): AxTree {
  return tree(
    node({
      role: 'RootWebArea',
      name: 'Swag Labs',
      children: [node({ role: 'genericContainer', name: `react-root-${String(revision)}` })],
    }),
    'https://www.saucedemo.com/',
  );
}

/** The same page once React has hydrated: two fields and a button. */
const rendered = tree(
  node({
    role: 'RootWebArea',
    name: 'Swag Labs',
    children: [
      node({ role: 'textbox', name: 'Username' }),
      node({ role: 'textbox', name: 'Password' }),
      node({ role: 'button', name: 'Login' }),
    ],
  }),
  'https://www.saucedemo.com/',
);

/**
 * A real page with nothing to act on: a 404 body. Stable across reads, which is
 * the ONLY thing that separates it from an unrendered page — it is smaller than
 * the shell above, so any rule based on size would call it broken and hang on
 * it once per step for the whole budget.
 */
const sparse = tree(
  node({
    role: 'RootWebArea',
    name: 'Not Found',
    children: [node({ role: 'StaticText', name: 'Not Found' })],
  }),
  'https://www.saucedemo.com/missing',
);

/**
 * THE STATE THAT BROKE THE FIRST CUT OF THIS FIX, measured against the shipped
 * binary: for 100-250 ms after a commit, `Outcrawl.getAXTree` answers with a
 * root-only tree at the site's REAL url, and holds it hash-stable across reads
 * 100 ms apart. Its hash is byte-identical to `about:blank`'s, because
 * `hashSnapshot` excludes the url.
 */
const rootOnly = tree(node({ role: 'RootWebArea', name: 'Swag Labs' }), 'https://www.saucedemo.com/');

/** Where every tab starts, and where every run whose first action is a navigate begins. */
const blank = tree(node({ role: 'RootWebArea' }), 'about:blank');

describe('a page that has not rendered is waited for, not acted on', () => {
  test('the model is shown the rendered tree, and the wait happened on a LIVE page', async () => {
    const clock = new VirtualClock();
    const h = harness({
      clock,
      // Commit, then hydration two polls later.
      snapshot: (n) => (n < 2 ? shell(n) : rendered),
      model: () => ({ action: done }),
    });

    const result = await runAgent(h.deps, { task: 'log in', caps: CAPS, stepFailures: 3 });

    expect(result.status).toBe('completed');
    // What the model actually read: the login form, not the shell. This is the
    // whole defect — the failing run was shown a tree with no controls.
    const shown = h.prompts[0]?.tree;
    expect(shown?.root.children?.map((child) => child.name)).toEqual([
      'Username',
      'Password',
      'Login',
    ]);
    // THE PAGE WAS RUNNING FOR THE POLLS. `liveTouches` counts page operations
    // that reached an unfrozen page, and the settle is the only thing in the
    // system that is supposed to produce any: the lock is
    // `VirtualTimePolicy::kPause`, so a poll under the freeze would be polling a
    // page whose timers are stopped and could never see it render.
    expect(h.browser.liveTouches).toBeGreaterThan(0);
    // And the freeze was retaken for the read the model was given: every
    // acquire was released, including the one the settle dropped.
    expect(h.balance.acquired).toBe(h.balance.released);
    expect(h.browser.frozen).toBe(false);
    // Seconds, not the run. Two polls at 50 ms and 100 ms.
    expect(clock.now()).toBeLessThan(1_000);
  });

  test('a settled page is settled ONCE, and the next step on it pays nothing', async () => {
    const clock = new VirtualClock();
    const page = catalogueTree();
    let reads = 0;
    /** How many page reads the run had taken by the time each step was asked. */
    const readsWhenAsked: number[] = [];
    const h = harness({
      clock,
      snapshot: (n) => {
        reads = n + 1;
        return page;
      },
      model: (_prompt, step) => {
        readsWhenAsked.push(reads);
        return step === 0
          ? { action: { type: 'click', ref: refOf(page, 'Widget A') } }
          : { action: done };
      },
    });

    const result = await runAgent(h.deps, { task: 'search', caps: CAPS, stepFailures: 3 });

    // STEP ONE pays the proof: the locked read, four polls of a live page at
    // 0/50/150/250 ms, and the re-read the model is given. Six reads and 250 ms
    // — `growthQuietMs` exactly, because the sleep is capped at the moment the
    // quiet window elapses rather than doubling past it. This is the price of
    // the fix, stated as a number rather than described.
    expect(readsWhenAsked[0]).toBe(6);
    expect(h.browser.liveTouches).toBe(4);
    expect(clock.now()).toBe(DEFAULT_SETTLE_POLICY.growthQuietMs);

    // STEP TWO PAYS NOTHING. Its read hashes identically to the tree the settle
    // already answered, so no poll and no wait: one read, and the clock has not
    // moved since step one. Delete the `quiescentHash` bound in `loop.ts` and
    // this becomes six reads and another 250 ms on every step of every run.
    expect(readsWhenAsked[1]).toBe(7);
    expect(clock.now()).toBe(DEFAULT_SETTLE_POLICY.growthQuietMs);

    // AND THE PRICE IS ON THE TRACE, which is the only way anyone can audit it
    // in production. Present on the step that paid, absent on the step that did
    // not, so a run's added latency is the sum of a field rather than a claim.
    expect(result.steps[0]?.settle?.verdict).toBe('actionable');
    expect(result.steps[0]?.settle?.waitedMs).toBe(DEFAULT_SETTLE_POLICY.growthQuietMs);
    expect(result.steps[0]?.settle?.polls).toBe(4);
    expect(result.steps[1]?.settle).toBeUndefined();
  });


  test('a legitimately sparse page is handed over at once, not treated as broken', async () => {
    const clock = new VirtualClock();
    const h = harness({ clock, tree: sparse, model: () => ({ action: done }) });

    const result = await runAgent(h.deps, { task: 'read the page', caps: CAPS, stepFailures: 3 });

    expect(result.status).toBe('completed');
    // It settled on STABILITY: a quarter-second of one unchanging hash, not the
    // ten-second budget. A rule that read "small" as "broken" would spend the
    // whole budget here, on every read, and then tell the model the page never
    // rendered. Measured: 350 ms, the first poll at or past `quietMs`.
    expect(clock.now()).toBeGreaterThanOrEqual(DEFAULT_SETTLE_POLICY.quietMs);
    expect(clock.now()).toBeLessThan(DEFAULT_SETTLE_POLICY.budgetMs / 4);
    expect(h.prompts[0]?.notice).toBeUndefined();
  });

  test('a root-only tree at a real url is never accepted as quiet, however still it holds', async () => {
    const clock = new VirtualClock();
    // Hash-stable and empty for six polls — past `quietMs` — and then the form
    // arrives. This is the measured post-commit state, and accepting it is
    // exactly the production failure: the model is handed a tree with no
    // controls and refuses.
    const h = harness({
      clock,
      snapshot: (n) => (n < 6 ? rootOnly : rendered),
      model: () => ({ action: done }),
    });

    const result = await runAgent(h.deps, { task: 'log in', caps: CAPS, stepFailures: 3 });

    expect(result.status).toBe('completed');
    expect(h.prompts[0]?.tree.root.children?.map((child) => child.name)).toEqual([
      'Username',
      'Password',
      'Login',
    ]);
    // It waited past the quiet window rather than settling inside it, which is
    // the whole difference between this and the sparse page above — and the two
    // trees hash identically, so only the url and the child count separate them.
    expect(clock.now()).toBeGreaterThan(DEFAULT_SETTLE_POLICY.quietMs);
  });

  test('about:blank is accepted at once: it cannot grow content, so waiting is waiting for nothing', async () => {
    const clock = new VirtualClock();
    const h = harness({
      clock,
      tree: blank,
      // What a run on a fresh tab actually does: navigate away from it.
      model: (_prompt, step) =>
        step === 0 ? { action: { type: 'navigate', url: 'https://www.saucedemo.com/' } } : { action: done },
    });

    const result = await runAgent(h.deps, { task: 'log in', caps: CAPS, stepFailures: 3 });

    expect(result.status).toBe('completed');
    // Root-only and empty, exactly like the unrendered document above, and
    // hash-identical to it. Accepted in zero time because the URL says it is
    // blank by definition. Without this, every run whose first action is a
    // navigate would pay the whole settle budget before its first step.
    expect(clock.now()).toBeLessThan(DEFAULT_SETTLE_POLICY.quietMs);
    expect(h.prompts[0]?.notice).toBeUndefined();
  });

  test('a root-only document at a NEW url is settled, not mistaken for the about:blank already answered', async () => {
    const clock = new VirtualClock();
    /**
     * `run_…`, `www.nordstrom.com`, 2026-09-11. The run starts on
     * `about:blank`, whose settle answers `blank` in zero milliseconds, and
     * then navigates into Imperva's interstitial: 252,998 bytes of one
     * obfuscated script, ZERO rendered text, so a root-only tree at
     * nordstrom's own address. `hashSnapshot` excludes the url, so that
     * document hashes IDENTICALLY to the `about:blank` the settle had just
     * answered — and the loop declared it already-settled, showed it to the
     * model unwaited and with no notice, and the customer's first result was
     * "No product categories, featured products, or navigation links were
     * found in the provided accessibility tree." Steps 1, 2 and 3 of that run
     * carry the same `snapshotHash` as step 0 and no settle at all; the real
     * page turned up at step 4 with 14,265 characters, because Imperva clears
     * itself in about 1.7 s.
     */
    const impervaShell = tree(node({ role: 'RootWebArea' }), 'https://www.nordstrom.com/');
    const arrived = tree(
      node({
        role: 'RootWebArea',
        name: 'Nordstrom',
        children: [node({ role: 'link', name: 'Women' }), node({ role: 'link', name: 'Designer' })],
      }),
      'https://www.nordstrom.com/',
    );

    let navigated = false;
    let shellReads = 0;
    const h = harness({
      clock,
      snapshot: () => {
        if (!navigated) return blank;
        shellReads += 1;
        // Three reads of the shell, then the vendor's own reload lands.
        return shellReads <= 3 ? impervaShell : arrived;
      },
      perform: (action) => {
        if (action.type === 'navigate') navigated = true;
      },
      model: (_prompt, step) =>
        step === 0
          ? { action: { type: 'navigate', url: 'https://www.nordstrom.com' } }
          : { action: done },
    });

    const result = await runAgent(h.deps, { task: 'browse three products', caps: CAPS, stepFailures: 3 });

    expect(result.status).toBe('completed');
    // THE WHOLE POINT. The second step's model call must see the page, not the
    // interstitial that happened to hash like the blank tab the run started
    // on. Without the url in the quiescence key this is the root-only shell
    // and the model is asked to extract products from one node.
    expect(h.prompts[1]?.tree.root.children?.map((child) => child.name)).toEqual([
      'Women',
      'Designer',
    ]);
    // And the wait is on the trace, which is how it is audited in production:
    // the step that paid for the interstitial says so.
    expect(result.steps[1]?.settle).toBeDefined();
    expect(result.steps[1]?.settle?.verdict).toBe('actionable');
  });

  test('a read that throws is waited out, not charged as a failed step', async () => {
    const clock = new VirtualClock();
    let thrown = 0;
    const h = harness({
      clock,
      // The measured 30-130 ms after a commit: the browser answers
      // `Outcrawl.getAXTree` with -32000 and there is no tree at all.
      snapshot: (n) => {
        if (n < 3) {
          thrown += 1;
          throw new Error('Outcrawl.getAXTree failed (-32000): No accessibility tree was produced');
        }
        return rendered;
      },
      model: () => ({ action: done }),
    });

    const result = await runAgent(h.deps, { task: 'log in', caps: CAPS, stepFailures: 3 });

    expect(thrown).toBe(3);
    expect(result.status).toBe('completed');
    // ONE step, and no error on it. Before the settle, that window cost a step
    // and a slice of `stepFailures` — and with `stepFailures: null` it ended the
    // run outright, on a page that was about to be perfectly readable.
    expect(result.stepsUsed).toBe(1);
    expect(result.steps[0]?.error).toBeUndefined();
  });

  test('settle is refused while the lock is held, because a frozen page cannot render', async () => {
    const h = harness({ tree: rendered, model: () => ({ action: done }) });
    const session = new PageSession(h.deps);

    await session.withLock(async () => {
      await expect(session.settle(DEFAULT_SETTLE_POLICY)).rejects.toThrow(LockHeldError);
    });
    // Refused before it read anything: the only page operation was the freeze
    // itself.
    expect(h.events).toEqual(['lock', 'unlock']);
  });
});

describe('a page whose CONTENT is late is waited for too, not just an empty one', () => {
  /**
   * THE MEASURED PRODUCTION SHAPE, and the one the old rule could not see: a nav
   * bar painted at commit, the article three polls later.
   *
   * `Diagnose` ran the real `settleTree` with `DEFAULT_SETTLE_POLICY` against 22
   * live pages and got `verdict=actionable` on 22 of 22, `polls=1` on 11, and
   * the served tree under 95% of the settled page's text on 7 — worst case an
   * amazon product page at 1,095 characters against 23,590 settled, 5%. This is
   * `wv-allrecipes-17`: the row failed on the literal "easy to make", which is
   * in the settled tree and not in the one the loop was handed.
   */
  function lateArticle(revision: number): AxTree {
    return tree(
      node({
        role: 'RootWebArea',
        name: 'Easy Vegetarian Spinach Lasagna',
        children: [
          node({ role: 'link', name: 'Recipes' }),
          node({ role: 'link', name: 'Dinners' }),
          ...(revision < 3
            ? []
            : [
                node({ role: 'heading', name: 'Reviews' }),
                node({ role: 'StaticText', name: 'This lasagna was easy to make and delicious.' }),
              ]),
        ],
      }),
      'https://www.allrecipes.com/recipe/229764/easy-vegetarian-spinach-lasagna/',
    );
  }

  test('the model is shown the article, not the nav bar that painted first', async () => {
    const clock = new VirtualClock();
    const h = harness({
      clock,
      snapshot: (n) => lateArticle(n),
      model: () => ({ action: done }),
    });

    const result = await runAgent(h.deps, { task: 'what does the latest review say', caps: CAPS, stepFailures: 3 });

    expect(result.status).toBe('completed');
    // THE WHOLE DEFECT. Two links are `ACTIONABLE_ROLES` members, so the old
    // rule — `survey.actionable > 0` on the first poll, and the callsite gate
    // `!hasActionable(raw)` that never even reached it — handed the model this
    // page with nothing but its nav in it.
    const names = h.prompts[0]?.tree.root.children?.map((child) => child.name) ?? [];
    expect(names).toContain('Reviews');
    expect(names.join(' ')).toContain('easy to make');
    // And it cost 400 ms once: two polls while the article was absent, the poll
    // that saw it arrive at 150 ms, and 250 ms of quiet after that proving
    // nothing further came.
    expect(clock.now()).toBe(400);
    expect(h.balance.acquired).toBe(h.balance.released);

    // AND THE FIXTURE DISCRIMINATES. `settle: false` reproduces what the loop
    // did before this: the page it commits with has two links in it, the old
    // callsite gate `!hasActionable(raw)` was therefore already satisfied, no
    // settle was ever called, and the model was handed the nav bar. If this arm
    // ever starts finding the article, the test above has stopped proving
    // anything and the page is arriving too early to be a late render.
    const unsettled = harness({
      clock: new VirtualClock(),
      snapshot: (n) => lateArticle(n),
      model: () => ({ action: done }),
    });
    await runAgent(unsettled.deps, {
      task: 'what does the latest review say',
      caps: CAPS,
      stepFailures: 3,
      settle: false,
    });
    expect(unsettled.prompts[0]?.tree.root.children?.map((child) => child.name)).toEqual([
      'Recipes',
      'Dinners',
    ]);
  });

  test('a carousel that never stops changing does not hold the loop, because GROWTH is the signal', async () => {
    const clock = new VirtualClock();
    /**
     * Hash-unstable forever and the same size forever: one slide caption swapped
     * for another of identical length. A stability rule can never fire here —
     * this is the live web, where an ad, a ticker or a clock changes the hash on
     * every read — and a high-water mark of content mass is never exceeded, so
     * growth says at once that nothing is arriving.
     */
    const carousel = (n: number): AxTree =>
      tree(
        node({
          role: 'RootWebArea',
          name: 'Shop',
          children: [
            node({ role: 'link', name: 'Home' }),
            node({ role: 'StaticText', name: n % 2 === 0 ? 'Slide A' : 'Slide B' }),
          ],
        }),
        'https://shop.example/',
      );
    const h = harness({ clock, snapshot: carousel, model: () => ({ action: done }) });

    const result = await runAgent(h.deps, { task: 'read the page', caps: CAPS, stepFailures: 3 });

    expect(result.status).toBe('completed');
    expect(clock.now()).toBe(DEFAULT_SETTLE_POLICY.growthQuietMs);
    expect(clock.now()).toBeLessThan(DEFAULT_SETTLE_POLICY.growthBudgetMs);
    expect(h.prompts[0]?.notice).toBeUndefined();
  });

  test('a page that grows forever is handed over as `growing` when the growth ceiling is spent', async () => {
    const clock = new VirtualClock();
    /** A feed that appends a post on every read: real, unbounded growth. */
    const h = harness({
      clock,
      snapshot: (n) =>
        tree(
          node({
            role: 'RootWebArea',
            name: 'Feed',
            children: [
              node({ role: 'link', name: 'Home' }),
              ...Array.from({ length: n + 1 }, (_unused, index) =>
                node({ role: 'StaticText', name: `post number ${String(index)}` }),
              ),
            ],
          }),
          'https://feed.example/',
        ),
      model: () => ({ action: done }),
    });

    const report = await new PageSession(h.deps).settle(DEFAULT_SETTLE_POLICY);

    // NOT `actionable`, and that is the point: the tree is usable and it was
    // still filling in when we stopped waiting for it. A verdict that called
    // this settled would make an unbounded page indistinguishable from a
    // finished one in the trace, which is how late-render loss stayed invisible.
    expect(report.verdict).toBe('growing');
    // Bounded by the GROWTH ceiling, not by `budgetMs`: a page with something to
    // act on is already usable, so the ten-second budget is not the customer's
    // to spend on improving it.
    expect(report.waitedMs).toBe(DEFAULT_SETTLE_POLICY.growthBudgetMs);
    expect(report.waitedMs).toBeLessThan(DEFAULT_SETTLE_POLICY.budgetMs);
    expect(report.grewMs).toBe(DEFAULT_SETTLE_POLICY.growthBudgetMs);
    expect(report.chars).toBeGreaterThan(0);
  });
});

describe('a page that never renders ends honestly, and never as our error', () => {
  /** A shell that keeps changing, so stability never accepts it either. */
  //
  // `budget: '99.00'` and not '2.00', and the reason is the point of the whole
  // group: a page that never renders spends its whole settle budget on every
  // read, and time is priced now — three reads at ten seconds is 30 s, which is
  // 3.00 credits at the published rate. Against a '2.00' budget these runs stop
  // at `max-budget` after two steps, which is CORRECT and is asserted in
  // `loop.test.ts`; it is simply not what these tests measure. They are about
  // the honest exit on a page that never painted, so the step ceiling has to be
  // the binding one.
  function neverRenders(caps = { steps: 3, budget: '99.00', duration: '5m' }) {
    const clock = new VirtualClock();
    const notices: (string | undefined)[] = [];
    const h = harness({
      clock,
      snapshot: (n) => shell(n),
      model: (prompt) => {
        notices.push(prompt.notice);
        // Exactly what the production model said, on exactly this tree.
        return {
          action: {
            type: 'fail',
            reason: 'No input fields are visible in the provided accessibility tree.',
          },
        };
      },
    });
    return { h, clock, notices, caps };
  }

  test('the refusal is recorded and re-read, and a CAP ends the run', async () => {
    const { h, caps } = neverRenders();

    const result = await runAgent(h.deps, { task: 'log in', caps, stepFailures: 3 });

    // The honest exit. Not `error`: nothing in the fleet misbehaved and the
    // model was never given a page to judge, so blaming either would be false.
    expect(result.stopReason).toBe('max-steps');
    expect(result.status).toBe('capped');
    expect(result.cappedBy).toBe('steps');
    expect(result.error).toBeUndefined();
    // Every step is in the trace with both reasons in it — the model's and ours.
    expect(result.stepsUsed).toBe(3);
    for (const step of result.steps) {
      expect(step.action.type).toBe('fail');
      expect(step.error).toContain('had not rendered');
      expect(step.error).toContain('No input fields are visible');
    }
    expect(h.balance.acquired).toBe(h.balance.released);
  });

  test('the refusal is not charged to stepFailures, or the exit would be `error` again', async () => {
    const { h, caps } = neverRenders();

    // `stepFailures: 0` stops on the first failed step. A declined unrendered
    // read must not be one of those: charged, this run would end
    // `stopReason: 'error'` — the exact conflation the fix exists to remove —
    // and it would blame us for a site that never painted.
    const result = await runAgent(h.deps, { task: 'log in', caps, stepFailures: 0 });

    expect(result.stopReason).toBe('max-steps');
    expect(result.status).toBe('capped');
  });

  test('the notice quotes the measured wait, not a nominal one', async () => {
    const { h, notices, clock, caps } = neverRenders();

    await runAgent(h.deps, { task: 'log in', caps, stepFailures: 3 });

    // The model is never asked about an unrendered page WITHOUT being told: the
    // settle runs before the model call of the very step it belongs to, so the
    // notice is on the first prompt of the run rather than arriving a step late.
    const notice = notices[0];
    expect(notice).toContain('no interactive elements');
    // The real numbers, and the reason they have to be: a model reasons from
    // this sentence, so a nominal or invented figure in it is worse than no
    // sentence at all. Measured on this run: 17 reads over 10.0 s, which is
    // what a 10 s budget escalating to an 800 ms interval produces.
    expect(notice).toMatch(/re-read \d+ time\(s\) over \d+\.\ds/);
    expect(notice).toContain('still changing');
    expect(notice).toContain('2 accessibility node(s)');
    // And the wait is bounded by the policy rather than by the run: three reads
    // at ten seconds each, well inside the five-minute duration cap.
    expect(clock.now()).toBeGreaterThanOrEqual(DEFAULT_SETTLE_POLICY.budgetMs);
    expect(clock.now()).toBeLessThan(4 * DEFAULT_SETTLE_POLICY.budgetMs);
  });

  test('the settle can never overrun the duration cap the caller set', async () => {
    const { h } = neverRenders();

    // A duration cap SHORTER than one settle budget. The settle is clamped to
    // what is left, so the run ends on the ceiling the customer chose rather
    // than on ours.
    const result = await runAgent(h.deps, {
      task: 'log in',
      caps: { steps: 20, budget: '2.00', duration: '2s' },
      stepFailures: 3,
    });

    expect(result.stopReason).toBe('max-duration');
    expect(result.status).toBe('capped');
    expect(result.cappedBy).toBe('duration');
    expect(result.durationMs).toBeLessThan(4_000);
  });

  test('a refusal on a page that DID render is honoured, and says so as `gave-up`', async () => {
    const h = harness({
      tree: rendered,
      model: () => ({ action: { type: 'fail', reason: 'this account is locked out' } }),
    });

    const result = await runAgent(h.deps, { task: 'log in', caps: CAPS, stepFailures: 3 });

    // The model looked at a page it could see and gave a verdict about the task.
    // That is not our error and no longer shares a stop reason with one.
    expect(result.stopReason).toBe('gave-up');
    expect(result.status).toBe('failed');
    expect(result.error).toBe('this account is locked out');
    expect(result.stepsUsed).toBe(1);
  });

  /**
   * IW12's shape (2026-10-04 probes, `run_…`): the document stayed one
   * node through the 10 s settle, and the next three steps — two queued
   * scrolls and a queued read — found it unmoved, so no settle ran on them
   * and nothing told the port the page was still not there.
   *
   * MUTATIONS THIS CATCHES: the verdict missing from the prompt; dropped on a
   * step whose read was quiescent; kept on a page that has since rendered.
   */
  test('the prompt says the document is unrendered, on the quiescent steps after too, and not once it renders', async () => {
    const seen: (string | undefined)[] = [];
    const h = harness({
      clock: new VirtualClock(),
      snapshot: () => (seen.length < 3 ? rootOnly : rendered),
      model: (prompt) => {
        seen.push(prompt.unrendered?.verdict);
        return { action: seen.length < 4 ? { type: 'scroll', dy: 1500 } : done };
      },
    });

    const result = await runAgent(h.deps, { task: 'count the paragraphs', caps: { steps: 6, budget: '99.00', duration: '5m' }, stepFailures: 3 });

    expect(seen).toEqual(['unrendered', 'unrendered', 'unrendered', undefined]);
    // Steps 1 and 2 ran no settle: the document had not moved.
    expect(result.steps.map((step) => step.settle?.verdict)).toEqual(['unrendered', undefined, undefined, 'actionable']);
  });
});

describe('a document still being parsed has not arrived, however still it holds', () => {
  /**
   * Timelines MEASURED through production 2026-10-03 04:24Z (`sess_…`,
   * n=1 each), times from the commit, replayed on a virtual clock through the
   * real `settleTree`. `parsing` is what the host reports from the browser's
   * own `DOMContentLoaded`.
   */
  const page = (url: string, chars: number, links: number): AxTree =>
    tree(
      node({
        role: 'RootWebArea',
        name: 'Page',
        children: [
          ...Array.from({ length: links }, (_unused, index) => node({ role: 'link', name: `link ${String(index)}` })),
          node({ role: 'StaticText', name: 'x'.repeat(chars) }),
        ],
      }),
      url,
    );
  const replay = (clock: VirtualClock, at: (ms: number) => AxTree, parsedAt: number | undefined) =>
    settleTree(() => at(clock.now()), clock, DEFAULT_SETTLE_POLICY, undefined, {
      textFloor: 0,
      read: () => ({ html: '<p>page</p>', textLength: 10_000 }),
      ...(parsedAt === undefined ? {} : { parsing: () => clock.now() < parsedAt }),
    });

  test('github: a 110-character prefix held 1.15 s is not the page', async () => {
    // "Skip to content" alone, held still from 0 to 1,150 ms; the 4,416-char
    // page at 1,150 ms; DOMContentLoaded at 1,573 ms.
    const url = 'https://github.com/rust-lang/rust';
    const at = (ms: number) => (ms < 1_150 ? page(url, 100, 1) : page(url, 4_400, 129));

    const before = await replay(new VirtualClock(), at, undefined);
    // What three runs since 03:00Z extracted from.
    expect(before.verdict).toBe('actionable');
    expect(before.chars).toBeLessThan(200);

    const after = await replay(new VirtualClock(), at, 1_573);
    expect(after.verdict).toBe('actionable');
    expect(after.chars).toBeGreaterThan(4_000);
    expect(after.parsingMs).toBeGreaterThanOrEqual(1_400);
  });

  test('amazon (run_… step 9): a header still growing at the 2.5 s ceiling is not the results', async () => {
    // The header creeps up (883 characters at 2.5 s, `grewMs: 2370`, as the
    // run recorded); the results land with DOMContentLoaded at 2,900 ms.
    const url = 'https://www.amazon.in/s?k=rtx+gaming+laptop&s=review-rank';
    const at = (ms: number) => (ms < 2_900 ? page(url, 820 + Math.floor(ms / 40), 42) : page(url, 18_600, 300));

    const before = await replay(new VirtualClock(), at, undefined);
    expect(before.verdict).toBe('growing');
    expect(before.waitedMs).toBe(DEFAULT_SETTLE_POLICY.growthBudgetMs);
    expect(before.chars).toBeLessThan(2_000);

    const after = await replay(new VirtualClock(), at, 2_900);
    expect(after.verdict).toBe('actionable');
    expect(after.chars).toBeGreaterThan(18_000);
  });

  /**
   * run_… (production 2026-10-03 10:37Z, demoqa, from its replay; times
   * from the settle's start, which was the commit): the document was a 1-node,
   * 8-character tree while its 921 KB module bundle arrived at ~53 KB/s, a body
   * chunk of 64 KiB about every 1.2 s; `DOMContentLoaded` at ~17.3 s, the form
   * drawn just after. The settle stopped at 10 s, `unrendered`, and the run lost
   * four steps.
   */
  const demoqa = 'https://demoqa.com/automation-practice-form';
  const shell = tree(node({ role: 'RootWebArea', name: 'demosite', children: [] }), demoqa);
  const form = page(demoqa, 470, 18);
  const loading = (clock: VirtualClock, opts: { parsedAt: number; renderedAt: number; lastByteAt: number }) =>
    settleTree(() => (clock.now() < opts.renderedAt ? shell : form), clock, DEFAULT_SETTLE_POLICY, undefined, {
      textFloor: 0,
      read: () => ({ html: '<div id="root"></div>', textLength: 8 }),
      parsing: () => clock.now() < opts.parsedAt,
      // The newest 1.2 s chunk boundary at or before now, until the last byte.
      // Asynchronous, as the worker's tab router answers it.
      lastNetworkAt: async () => Math.min(clock.now() - (clock.now() % 1_200), opts.lastByteAt),
    });

  test('demoqa: a document still downloading past the budget is waited for, and read once it has drawn', async () => {
    const report = await loading(new VirtualClock(), { parsedAt: 17_300, renderedAt: 17_500, lastByteAt: 17_300 });
    expect(report.verdict).toBe('actionable');
    expect(report.actionable).toBeGreaterThan(0);
    expect(report.waitedMs).toBeGreaterThan(17_300);
    expect(report.waitedMs).toBeLessThan(20_000);
  });

  test('a document that stops receiving is not waited for past the budget, and the model is told it is still loading', async () => {
    // The network went silent at 4 s and the document never finished.
    const report = await loading(new VirtualClock(), { parsedAt: Number.POSITIVE_INFINITY, renderedAt: Number.POSITIVE_INFINITY, lastByteAt: 4_000 });
    expect(report.verdict).toBe('unrendered');
    expect(report.waitedMs).toBe(DEFAULT_SETTLE_POLICY.budgetMs);
    expect(unrenderedNotice(report)).toContain('STILL LOADING');
  });

  test('a download that never ends is waited for no longer than the loading ceiling', async () => {
    const report = await loading(new VirtualClock(), {
      parsedAt: Number.POSITIVE_INFINITY,
      renderedAt: Number.POSITIVE_INFINITY,
      lastByteAt: Number.POSITIVE_INFINITY,
    });
    expect(report.verdict).toBe('unrendered');
    expect(report.waitedMs).toBe(DEFAULT_SETTLE_POLICY.loadingBudgetMs);
    expect(report.receivingMs).toBeGreaterThan(DEFAULT_SETTLE_POLICY.loadingBudgetMs - 3_000);
    expect(unrenderedNotice(report)).toContain('last received data');
  });

  test('settle: false waits for nothing, a page still arriving included', async () => {
    const clock = new VirtualClock();
    const report = await settleTree(() => shell, clock, { ...DEFAULT_SETTLE_POLICY, budgetMs: 0 }, undefined, {
      textFloor: 0,
      read: () => ({ html: '<div id="root"></div>', textLength: 8 }),
      parsing: () => true,
      lastNetworkAt: () => clock.now(),
    });
    expect(report.waitedMs).toBe(0);
  });

  test('bounded: a document that never finishes parsing is waited for no longer than the budget', async () => {
    const clock = new VirtualClock();
    const url = 'https://slow.example/';
    const report = await replay(clock, () => page(url, 500, 3), Number.POSITIVE_INFINITY);
    expect(report.verdict).toBe('growing');
    expect(report.waitedMs).toBe(DEFAULT_SETTLE_POLICY.budgetMs);
  });
});

describe('a document stalled on a request that will not answer is reloaded once', () => {
  /**
   * The shape measured on the 2026-10-04 re-probe (IW21 `run_…`, IW7
   * `run_…`, IW12 `run_…`/`run_…`): the run navigates,
   * the document commits, its last bytes arrive 0.8 s in, and it is still
   * parsing when the 10 s render wait ends, because head requests sit until
   * the site's router answers 503 at ~30 s. A fresh load finishes in about a
   * second.
   */
  const url = 'https://the-internet.herokuapp.com/key_presses';
  const stalled = tree(node({ role: 'RootWebArea', name: 'The Internet' }), url);
  const keyPresses = tree(
    node({ role: 'RootWebArea', name: 'The Internet', children: [node({ role: 'heading', name: 'Key Presses' }), node({ role: 'textbox', name: 'target' })] }),
    url,
  );

  function site(loads: readonly ('stalls' | 'renders' | 'receives')[], landsAt = url) {
    const clock = new VirtualClock();
    let state: 'blank' | (typeof loads)[number] = 'blank';
    let loadedAt = 0;
    const navigated: string[] = [];
    const asked: number[] = [];
    const notices: (string | undefined)[] = [];
    const h = harness({
      clock,
      snapshot: () => (state === 'blank' ? blank : state === 'renders' ? keyPresses : { ...stalled, url: landsAt }),
      perform: (action) => {
        if (action.type === 'navigate') {
          state = loads[navigated.length] ?? 'renders';
          navigated.push(action.url);
          loadedAt = clock.now();
        }
      },
      document: {
        textFloor: 0,
        read: () => ({ html: '<html><head><script src="/js/vendor/jquery-1.11.3.min.js"></script></head></html>', textLength: 0 }),
        parsing: () => state !== 'renders' && state !== 'blank',
        // Silent after 0.8 s, or still receiving now.
        lastNetworkAt: () => (state === 'receives' ? clock.now() : loadedAt + 800),
      },
      model: (prompt, step) => {
        asked.push(step);
        notices.push(prompt.notice);
        return { action: step === 0 ? { type: 'navigate', url } : done };
      },
    });
    return { h, navigated, asked, notices };
  }
  const caps = { steps: 6, budget: '99.00', duration: '5m' };

  /**
   * MUTATIONS THIS CATCHES: the stalled document handed to the model (no
   * reload: the model is asked at step 1 on a 1-node page); the reload done
   * by asking the model; the model not told afterwards.
   */
  test('the host reloads it with no model call, and the model reads the reloaded page and is told', async () => {
    const { h, navigated, asked, notices } = site(['stalls', 'renders']);
    const result = await runAgent(h.deps, { task: 'press Escape', caps, stepFailures: 3 });

    expect(navigated).toEqual([url, url]);
    expect(asked).toEqual([0, 2]);
    expect(result.steps[1]?.action).toEqual({ type: 'navigate', url });
    expect(result.steps[1]?.reasoning).toContain('reloaded by the host');
    expect(result.steps[1]?.settle?.verdict).toBe('unrendered');
    expect(notices[1]).toContain('was reloaded once');
    expect(result.status).toBe('completed');
  });

  /** MUTATION THIS CATCHES: a reload loop on a site that stalls every time. */
  test('once per url: a reload that stalls again goes to the model with the render notice', async () => {
    const { h, navigated, asked, notices } = site(['stalls', 'stalls']);
    await runAgent(h.deps, { task: 'press Escape', caps, stepFailures: 3 });

    expect(navigated).toEqual([url, url]);
    expect(asked).toEqual([0, 2]);
    // Both facts: what the host did, and that the page is still not there.
    expect(notices[1]).toContain('was reloaded once');
    expect(notices[1]).toContain('STILL LOADING');
  });

  /**
   * MUTATIONS THIS CATCHES: a reload of a document that is still arriving
   * (waiting is working); a reload of a url the run did not navigate to (a
   * redirect, or a form post the reload would re-send as a GET).
   */
  test('not while bytes are still arriving, and not on a url the run did not navigate to', async () => {
    const receiving = site(['receives']);
    await runAgent(receiving.h.deps, { task: 'press Escape', caps: { ...caps, steps: 2 }, stepFailures: 3 });
    expect(receiving.navigated).toEqual([url]);
    expect(receiving.asked).toEqual([0, 1]);

    const redirected = site(['stalls'], 'https://the-internet.herokuapp.com/login');
    await runAgent(redirected.h.deps, { task: 'press Escape', caps: { ...caps, steps: 2 }, stepFailures: 3 });
    expect(redirected.navigated).toEqual([url]);
    expect(redirected.asked).toEqual([0, 1]);
  });
});

describe('nothing is sent to a document that has not arrived', () => {
  /**
   * The 2026-10-04 re-probe on d0b9603a (IW21 `run_…`/`run_…`,
   * IW12 `run_…`): the head requests of the-internet hang until the
   * site's router answers 503 at ~30 s, the host's reload hangs the same way,
   * and the run pressed Escape and scrolled on the one-node document still
   * parsing, then reported what Escape "does". Here the document parses for
   * 30 s from each load and then renders.
   */
  const url = 'https://the-internet.herokuapp.com/key_presses';
  const parsing = tree(node({ role: 'RootWebArea', name: 'The Internet' }), url);
  const keyPresses = tree(
    node({ role: 'RootWebArea', name: 'The Internet', children: [node({ role: 'heading', name: 'Key Presses' }), node({ role: 'textbox', name: 'target' })] }),
    url,
  );

  /**
   * MUTATIONS THIS CATCHES: input or a read sent to the parsing document (the
   * press is performed before the page renders); the refusal charged to
   * `stepFailures` (with `stepFailures: 0` the run ends `error`); the model
   * not told; the next read answered from the refused one with no settle, so
   * the page is never waited for (the press is never performed).
   */
  test('a press or a read on it is refused uncharged and the model told; once it renders, the press is sent', async () => {
    const clock = new VirtualClock();
    let loadedAt: number | undefined;
    const rendered = (): boolean => loadedAt !== undefined && clock.now() - loadedAt >= 30_000;
    const notices: (string | undefined)[] = [];
    let extracted = 0;
    const h = harness({
      clock,
      extract: () => {
        extracted += 1;
        return { data: 'nothing' };
      },
      snapshot: () => (loadedAt === undefined ? blank : rendered() ? keyPresses : parsing),
      perform: (action) => {
        if (action.type === 'navigate') loadedAt = clock.now();
      },
      document: {
        textFloor: 0,
        read: () => ({ html: '<html><head><script src="/js/vendor/jquery-1.11.3.min.js"></script></head></html>', textLength: 0 }),
        parsing: () => loadedAt !== undefined && !rendered(),
        // Silent 0.8 s into each load, as measured: the host reloads it once.
        lastNetworkAt: () => (loadedAt === undefined ? undefined : loadedAt + 800),
      },
      model: (prompt, step) => {
        notices.push(prompt.notice);
        if (step === 0) return { action: { type: 'navigate', url } };
        if (prompt.tree.root.children === undefined) {
          return { action: step % 2 === 0 ? { type: 'press', key: 'Escape' } : { type: 'extract', instruction: 'the result text' } };
        }
        return { action: h.performed.some((action) => action.type === 'press') ? done : { type: 'press', key: 'Escape' } };
      },
    });

    const result = await runAgent(h.deps, { task: 'press Escape and report the text', caps: { steps: 12, budget: '99.00', duration: '5m' }, stepFailures: 0 });

    const pressedAt = result.steps.findIndex((step) => step.action.type === 'press' && step.error === undefined);
    // Step 1 is the host's one reload; the model's steps after it, until the
    // reloaded document renders, are refused and say so.
    expect(result.steps[1]?.reasoning).toContain('reloaded by the host');
    const refused = result.steps.slice(2, pressedAt);
    expect(refused.map((step) => step.action.type)).toEqual(['press', 'extract']);
    for (const step of refused) {
      expect(step.error).toContain('was NOT performed: the page is still loading');
    }
    expect(h.performed.filter((action) => action.type === 'press')).toHaveLength(1);
    expect(extracted).toBe(0);
    expect(notices[3]).toContain('was NOT performed');
    expect(result.status).toBe('completed');
  });
});
