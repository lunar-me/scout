/**
 * What the model is told about a verification the browser handled, and what it
 * is shown after one.
 *
 * Production 2026-09-25, run_… on a fleet Mac (n=1, from its step records
 * and replay):
 *
 *   18:03:19Z  the in-page solve on a search engine's /sorry failed (chal.3). Nothing
 *              told the model; steps 2-15 clicked the checkbox and VERIFY.
 *   18:04:18Z  the solver's token was delivered and the page's callback
 *              submitted the form (chal.4). The results page committed at
 *              18:04:19.8Z and its results arrived at 18:04:20.8Z.
 *   step 16    read the page in between — 356 characters, 7 nodes, settled in
 *              253 ms — and the model gave up on its belief that nothing it
 *              tried had worked.
 */

import { describe, expect, test } from 'bun:test';

import type { Action } from '../src/actions';
import { runAgent, type ChallengeSolving, type PageSession } from '../src/loop';
import { toWireStep, type StepTrace } from '../src/result';
import type { AxTree } from '../src/snapshot';
import { VirtualClock, capState, harness, node, refOf, tree } from './support';
import type { RunIntent } from '../src/resume';

const CAPS = { steps: 8, budget: '2.00', duration: '5m' };
const SORRY_URL = 'https://www.search.example/sorry/index?continue=https://www.search.example/search%3Fq%3Dsocks';
const SEARCH_URL = 'https://www.search.example/search?q=socks';

const sorry = tree(
  node({
    role: 'RootWebArea',
    name: 'https://www.search.example/search?q=socks',
    children: [
      node({ role: 'StaticText', name: 'Our systems have detected unusual traffic from your computer network.' }),
      node({ role: 'checkbox', name: "I'm not a robot" }),
    ],
  }),
  SORRY_URL,
);

/** The results page as it first commits: its chrome, none of its results. */
const skeleton = tree(
  node({ role: 'RootWebArea', name: 'socks - Search', children: [node({ role: 'link', name: 'Search home' })] }),
  SEARCH_URL,
);

const results = tree(
  node({
    role: 'RootWebArea',
    name: 'socks - Search',
    children: [
      node({ role: 'link', name: 'Search home' }),
      node({ role: 'link', name: 'Result one' }),
      node({ role: 'link', name: 'Result two' }),
      node({ role: 'link', name: 'Result three' }),
    ],
  }),
  SEARCH_URL,
);

const HOLD: ChallengeSolving = {
  t: 120,
  challengeId: 'chal.4',
  detector: 'recaptcha',
  kind: 'inpage',
  url: 'https://www.search.example/recaptcha/enterprise/anchor',
  frameId: 'F1',
  sitekey: '6LfwuyUTAAAAAOAmoS0fdqijC2PbbdH4kjq62Y1b',
};

const done: Action = { type: 'done', summary: 'finished' };
const clickBox: Action = { type: 'click', ref: refOf(sorry, "I'm not a robot") };

/** A run whose first step is interrupted by `HOLD`, the solve answered by `solve`. */
async function runWithHold(
  solve: (
    clock: VirtualClock,
  ) => { solved: true } | { solved: false; reason: 'exhausted' | 'unsupported'; superseded?: true; leftToPage?: true },
  snapshot: (clock: VirtualClock) => AxTree,
  steps: number,
): Promise<{ notices: string[]; trees: AxTree[]; steps: readonly StepTrace[] }> {
  const clock = new VirtualClock();
  let session: PageSession | undefined;
  const h = harness({
    clock,
    solveChallenge: () => solve(clock),
    snapshot: () => snapshot(clock),
    model: async (_prompt, step) => {
      if (step === 0) {
        // The hold fires while the step holds the page, exactly as a widget
        // loading under a step does; `withSolve` takes the freeze down for it.
        if (session === undefined) throw new Error('no session was handed out');
        await session.withSolve(HOLD);
      }
      return { action: step + 1 < steps ? clickBox : done };
    },
  });
  const result = await runAgent(h.deps, {
    task: 'report the first three results for socks',
    caps: CAPS,
    stepFailures: 3,
    onSession: (created) => {
      session = created;
    },
  });
  return {
    notices: h.prompts.map((prompt) => prompt.notice ?? ''),
    trees: h.prompts.map((prompt) => prompt.tree),
    steps: result.steps,
  };
}

describe('a verification that failed on the page', () => {
  test('is said plainly on every read of that page, and names no vendor', async () => {
    const { notices } = await runWithHold(() => ({ solved: false, reason: 'exhausted' }), () => sorry, 3);

    expect(notices[0]).not.toContain('verification');
    expect(notices[1]).toContain('Automatic verification did not succeed on this page');
    // The solver owns the check: the model is told not to solve it by hand, and
    // is NOT told the task is forbidden. Production 2026-09-27, run_…:
    // "do not interact with it" came back as "system instructions prevent
    // interacting with the CAPTCHA" in a customer-facing failure.
    expect(notices[1]).toContain('not by you');
    expect(notices[1]).not.toContain('do not interact with it');
    // A fresh check is attempted automatically on a new load (7 days to
    // 2026-09-27: 27 of 46 sessions whose failed reCAPTCHA solve was followed
    // by another minted the later one).
    expect(notices[1]).toContain('navigate to this page again once');
    // And the honest ending names the site's check, not the harness.
    expect(notices[1]).toContain("the site's verification check could not be passed");
    // Still standing on the same page: a once-only sentence is buried by the
    // next read, and the run it came from clicked for thirteen steps.
    expect(notices[2]).toContain('Automatic verification did not succeed on this page');
    for (const notice of notices) expect(notice).not.toMatch(/capmonster|2captcha|nocaptcha|task-api/i);
  });

  /**
   * Production 2026-09-25 18:55Z, run_… (n=1): the notice stood on
   * /sorry, the model opened another tab, came back, found no notice — it
   * was kept for one url and cleared by the read of the other — and clicked
   * "I'm not a robot" twice.
   */
  test('survives a visit elsewhere and is said again on return', async () => {
    const clock = new VirtualClock();
    const elsewhere = tree(node({ role: 'RootWebArea', name: 'Datasheets', children: [node({ role: 'link', name: 'Home' })] }), 'https://datasheets.test/');
    let current: AxTree = sorry;
    let session: PageSession | undefined;
    const h = harness({
      clock,
      solveChallenge: () => ({ solved: false, reason: 'exhausted' }),
      snapshot: () => current,
      model: async (_prompt, step) => {
        if (step === 0) {
          if (session === undefined) throw new Error('no session was handed out');
          await session.withSolve(HOLD);
        }
        // Step 1 leaves; step 2 is elsewhere and comes back; step 3 is /sorry again.
        if (step === 1) current = elsewhere;
        if (step === 2) current = sorry;
        return { action: step < 3 ? { type: 'wait', seconds: 1 } : done };
      },
    });
    await runAgent(h.deps, {
      task: 'report the first three results for socks',
      caps: CAPS,
      stepFailures: 3,
      onSession: (created) => {
        session = created;
      },
    });
    const notices = h.prompts.map((prompt) => prompt.notice ?? '');

    expect(notices[1]).toContain('Automatic verification did not succeed on this page');
    expect(notices[2]).not.toContain('Automatic verification did not succeed');
    expect(notices[3]).toContain('Automatic verification did not succeed on this page');
  });

  /**
   * The reload is offered ONCE per page. Each load buys a fresh, paid solver
   * attempt, and a sentence repeated on every read of a failed url advised a
   * reload after every failed reload (AnswerHeldReview F1 probe: reload advice
   * on prompts [false,true,true,true,true,true,true] across six failed loads).
   *
   * The PAGE is the origin and path. a search engine's /sorry carries a fresh token in
   * its query on every block (re-review R1: run_…, run_… and
   * run_… came back on new tokens), so a count keyed on the exact url
   * restarted at 1 after every reload and the loop stayed open.
   */
  test('offers one reload per page, then says the fresh load was refused too', async () => {
    const clock = new VirtualClock();
    const reloaded = tree(sorry.root, `${SORRY_URL}&q=EhAgAQ-fresh-token#after-reload`);
    let current: AxTree = sorry;
    let session: PageSession | undefined;
    const h = harness({
      clock,
      solveChallenge: () => ({ solved: false, reason: 'exhausted' }),
      snapshot: () => current,
      model: async (_prompt, step) => {
        if (session === undefined) throw new Error('no session was handed out');
        // A failed check on the first load; the model reloads, and the fresh
        // load (new query token, new fragment) fails its check too.
        if (step === 0) {
          await session.withSolve({ ...HOLD, challengeId: 'chal.4' });
          return { action: { type: 'wait', seconds: 1 } };
        }
        if (step === 1) {
          current = reloaded;
          await session.withSolve({ ...HOLD, challengeId: 'chal.5' });
          return { action: { type: 'navigate', url: reloaded.url } };
        }
        return { action: step < 3 ? { type: 'wait', seconds: 1 } : done };
      },
    });
    await runAgent(h.deps, {
      task: 'report the first three results for socks',
      caps: CAPS,
      stepFailures: 3,
      onSession: (created) => {
        session = created;
      },
    });
    const notices = h.prompts.map((prompt) => prompt.notice ?? '');

    expect(h.prompts[2]?.tree.url).toBe(reloaded.url);
    expect(notices.filter((notice) => notice.includes('navigate to this page again once'))).toHaveLength(1);
    expect(notices[1]).toContain('navigate to this page again once');
    expect(notices[2]).toContain('a fresh load was also refused');
    expect(notices[3]).toContain('a fresh load was also refused');
    expect(notices[3]).toContain("the site's verification check could not be passed");
  });

  /**
   * Loads are what the count is about, not failure notes: two checks failing
   * on ONE load have not been reloaded yet (re-review R2).
   */
  test('two checks failing on one load still offer the reload', async () => {
    const clock = new VirtualClock();
    let session: PageSession | undefined;
    const h = harness({
      clock,
      solveChallenge: () => ({ solved: false, reason: 'exhausted' }),
      snapshot: () => sorry,
      model: async (_prompt, step) => {
        if (step === 0) {
          if (session === undefined) throw new Error('no session was handed out');
          await session.withSolve({ ...HOLD, challengeId: 'chal.4' });
          await session.withSolve({ ...HOLD, challengeId: 'chal.5' });
        }
        return { action: step < 1 ? { type: 'wait', seconds: 1 } : done };
      },
    });
    await runAgent(h.deps, {
      task: 'report the first three results for socks',
      caps: CAPS,
      stepFailures: 3,
      onSession: (created) => {
        session = created;
      },
    });
    const notices = h.prompts.map((prompt) => prompt.notice ?? '');

    expect(notices[1]).toContain('navigate to this page again once');
    expect(notices[1]).not.toContain('a fresh load was also refused');
  });
});

/**
 * AgentFirst re-pilot, scout-1, 2026-09-28: BrowseComp run_… and
 * run_…, BU Bench run_… and Odysseys run_… each gave up on
 * a search engine's /sorry page the first time its check failed, without one query on
 * another search engine.
 */
describe('a give-up on a page whose verification failed', () => {
  const failAction: Action = { type: 'fail', reason: "The site's verification check could not be passed." };

  const bing = tree(
    node({ role: 'RootWebArea', name: 'socks - Search', children: [node({ role: 'link', name: 'Socks result' })] }),
    'https://www.bing.com/search?q=socks',
  );
  const toBing: Action = { type: 'navigate', url: 'https://www.bing.com/search?q=socks' };

  /** Step 0 holds a failing solve on the wall; `model` also says which page the next read shows. */
  async function run(
    model: (step: number) => { action: Action; next?: AxTree },
    first: AxTree,
    resume?: RunIntent,
  ) {
    let session: PageSession | undefined;
    let current = first;
    let asked = 0;
    const h = harness({
      solveChallenge: () => ({ solved: false, reason: 'exhausted' }),
      snapshot: () => current,
      // This harness's own prompt count: a resumed run's step indices continue the attempt's.
      model: async () => {
        const step = asked++;
        if (step === 0 && current === sorry) {
          if (session === undefined) throw new Error('no session was handed out');
          await session.withSolve(HOLD);
        }
        const chosen = model(step);
        if (chosen.next !== undefined) current = chosen.next;
        return { action: chosen.action };
      },
    });
    const result = await runAgent(h.deps, {
      task: 'report the first three results for socks',
      caps: resume === undefined ? CAPS : { ...CAPS, steps: CAPS.steps + resume.steps.length },
      stepFailures: 3,
      verify: false,
      ...(resume === undefined ? {} : { resume }),
      onSession: (created) => {
        session = created;
      },
    });
    return { result, notices: h.prompts.map((prompt) => prompt.notice ?? '') };
  }

  test('is declined once, with another search engine named; the second give-up is accepted', async () => {
    const { result, notices } = await run((step) => ({ action: step === 0 ? clickBox : failAction }), sorry);

    expect(notices).toHaveLength(3);
    expect(notices[2]).toContain('Your fail was not accepted yet');
    expect(notices[2]).toContain('another search engine');
    expect(result.stopReason).toBe('gave-up');
  });

  test('on a page with no failed verification, a give-up ends the run at once', async () => {
    const { result, notices } = await run(() => ({ action: failAction }), results);

    expect(notices).toHaveLength(1);
    expect(result.stopReason).toBe('gave-up');
  });

  test('after leaving the wall for another site, a give-up there is accepted at once', async () => {
    const { result, notices } = await run(
      (step) => (step === 0 ? { action: clickBox } : step === 1 ? { action: toBing, next: bing } : { action: failAction }),
      sorry,
    );

    expect(notices).toHaveLength(3);
    expect(result.stopReason).toBe('gave-up');
  });

  test('the decline is said on the next prompt only, not on the other site after it (AgentReview P2)', async () => {
    const { notices } = await run(
      (step) =>
        step === 0
          ? { action: clickBox }
          : step === 1
            ? { action: failAction }
            : step === 2
              ? { action: toBing, next: bing }
              : step === 3
                ? { action: clickBox }
                : { action: done },
      sorry,
    );

    expect(notices[2]).toContain('Your fail was not accepted yet');
    expect(notices[3]).not.toContain('Your fail was not accepted yet');
    expect(notices[4]).not.toContain('Your fail was not accepted yet');
  });

  test('a resumed run is not declined a second time (AgentReview P3)', async () => {
    const attempt = await run((step) => ({ action: step === 0 ? clickBox : failAction }), sorry);
    const steps = attempt.result.steps.slice(0, 2);
    expect(steps.filter((step) => step.held === 'gate-fail')).toHaveLength(1);

    const resumed: RunIntent = {
      id: 'run-1',
      task: 'report the first three results for socks',
      memory: { goals: [], findings: [], ruledOut: [] },
      steps,
      used: capState({ steps: steps.length }),
      irreversible: [],
      reacquisitions: 1,
    };
    const { result, notices } = await run((step) => ({ action: step === 0 ? clickBox : failAction }), sorry, resumed);

    expect(notices).toHaveLength(2);
    expect(result.stopReason).toBe('gave-up');
  });
});

describe('a verification that succeeded, then another check on the same page failed', () => {
  /**
   * Production 2026-09-27 15:26-15:27Z, run_… (n=1): the page's
   * reCAPTCHA was minted at 15:26:54; a second check the browser saw on the
   * same page hit its deadline at 15:27:51, and the next prompt said only
   * that verification had failed and the site was refusing us. The model gave
   * up on a page whose check had been passed.
   */
  test('the model is told both, and that the page may already work', async () => {
    const clock = new VirtualClock();
    let session: PageSession | undefined;
    let solves = 0;
    const h = harness({
      clock,
      solveChallenge: () => (solves++ === 0 ? { solved: true } : { solved: false, reason: 'timeout' }),
      snapshot: () => sorry,
      model: async (_prompt, step) => {
        if (step === 0 || step === 1) {
          if (session === undefined) throw new Error('no session was handed out');
          await session.withSolve({ ...HOLD, challengeId: `chal.${String(step + 4)}` });
        }
        return { action: step < 2 ? { type: 'wait', seconds: 1 } : done };
      },
    });
    await runAgent(h.deps, {
      task: 'solve the check on this page and report what it says',
      caps: CAPS,
      stepFailures: 3,
      onSession: (created) => {
        session = created;
      },
    });
    const notices = h.prompts.map((prompt) => prompt.notice ?? '');

    expect(notices[1]).toContain('was completed for you automatically');
    expect(notices[2]).toContain('Automatic verification did not succeed on this page');
    expect(notices[2]).toContain('completed for you automatically earlier');
    expect(notices[2]).toContain('the page may already work');
  });

  /**
   * What run_… actually had: both outcomes landed before the next read,
   * so ONE drain saw the success and then the failure, and the last note won.
   */
  test('says so when the success and the failure are drained on the same read', async () => {
    const clock = new VirtualClock();
    let session: PageSession | undefined;
    let solves = 0;
    const h = harness({
      clock,
      solveChallenge: () => (solves++ === 0 ? { solved: true } : { solved: false, reason: 'timeout' }),
      snapshot: () => sorry,
      model: async (_prompt, step) => {
        if (step === 0) {
          if (session === undefined) throw new Error('no session was handed out');
          await session.withSolve({ ...HOLD, challengeId: 'chal.5' });
          await session.withSolve({ ...HOLD, challengeId: 'chal.4' });
        }
        return { action: step < 2 ? { type: 'wait', seconds: 1 } : done };
      },
    });
    await runAgent(h.deps, {
      task: 'solve the check on this page and report what it says',
      caps: CAPS,
      stepFailures: 3,
      onSession: (created) => {
        session = created;
      },
    });
    const notices = h.prompts.map((prompt) => prompt.notice ?? '');

    expect(notices[1]).toContain('Automatic verification did not succeed on this page');
    expect(notices[1]).toContain('completed for you automatically earlier');
    expect(notices[2]).toContain('completed for you automatically earlier');
  });

  test('a page whose only check failed is not told it may already work', async () => {
    const { notices } = await runWithHold(() => ({ solved: false, reason: 'exhausted' }), () => sorry, 3);
    expect(notices[1]).not.toContain('completed for you automatically earlier');
  });
});

describe('a verification whose document the page replaced by itself', () => {
  /**
   * Production 2026-09-25, dictionary.cambridge.org run_… (n=1): the
   * Cloudflare challenge cleared itself at the same url, so a failure note
   * would have told the model the real page was refusing us.
   */
  test('is not reported as a failed verification on the page it left', async () => {
    const { notices } = await runWithHold(
      () => ({ solved: false, reason: 'exhausted', superseded: true }),
      () => results,
      3,
    );

    expect(notices.some((notice) => notice.includes('Automatic verification did not succeed'))).toBe(false);
  });
});

describe("a Cloudflare challenge page left to clear itself", () => {
  /**
   * Nothing is bought for Cloudflare's own challenge page without chlPageData
   * (captcha `isUnclearableChallengePage`); the page may still clear at the
   * same url, so the real page must not carry a failed-verification notice.
   */
  test('is not reported as a failed verification', async () => {
    const { notices } = await runWithHold(
      () => ({ solved: false, reason: 'unsupported', leftToPage: true }),
      () => results,
      3,
    );

    expect(notices.some((notice) => notice.includes('Automatic verification did not succeed'))).toBe(false);
  });
});

describe('a tool call made while a verification is being solved', () => {
  /**
   * Production 2026-09-25 18:53Z (run_… web.search, run_…
   * page.look; n=2): both were refused "not performed" because the page gate
   * treated a tool call as a page action. Neither touches the page.
   */
  test('goes through; page actions are still refused (see the test above)', async () => {
    const clock = new VirtualClock();
    let session: PageSession | undefined;
    const called: string[] = [];
    const h = harness({
      clock,
      solveChallenge: async () => {
        await clock.sleep(1_000);
        return { solved: true };
      },
      snapshot: () => sorry,
      model: (_prompt, step) => {
        if (step === 0) {
          if (session === undefined) throw new Error('no session was handed out');
          void session.withSolve(HOLD);
          return { action: { type: 'callTool', tool: 'web.search', arguments: { query: 'socks' } } };
        }
        return { action: done };
      },
    });
    await runAgent(
      {
        ...h.deps,
        tools: {
          list: () => [{ name: 'web.search', description: 'search the web', inputSchema: { type: 'object' } }],
          call: (tool) => {
            called.push(tool);
            return { isError: false, text: 'three results' };
          },
        },
      },
      {
        task: 'report the first three results for socks',
        caps: CAPS,
        stepFailures: 3,
        onSession: (created) => {
          session = created;
        },
      },
    );

    expect(called).toEqual(['web.search']);
  });
});

describe('a give-up while a verification is being solved', () => {
  /**
   * Production 2026-09-25 19:12:24Z, run_… (n=1, fleet a5da1cba): the
   * model answered `fail` 2.9 s into a /sorry solve that the solver finished
   * at 9.0 s. The run was over by then, so the token arrived at a closed
   * session (DELIVERY) and was paid for anyway.
   */
  test('is not the end of the run: the next step reads the page the solve left', async () => {
    const clock = new VirtualClock();
    let session: PageSession | undefined;
    // Resolved on a real timer, so the solve is still running when the step's
    // `fail` comes back — as it was in production — and the next step's lock
    // has something to park on.
    let solved = false;
    const h = harness({
      clock,
      solveChallenge: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            solved = true;
            resolve({ solved: true });
          }, 20);
        }),
      snapshot: () => (solved ? results : sorry),
      model: (_prompt, step) => {
        if (step === 0) {
          if (session === undefined) throw new Error('no session was handed out');
          void session.withSolve(HOLD);
          return { action: { type: 'fail', reason: 'The search engine is showing a CAPTCHA' } };
        }
        return { action: done };
      },
    });
    const result = await runAgent(h.deps, {
      task: 'report the first three results for socks',
      caps: CAPS,
      stepFailures: 3,
      onSession: (created) => {
        session = created;
      },
    });

    expect(result.stopReason).not.toBe('gave-up');
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]?.tree.url).toBe(SEARCH_URL);
  });
});

describe('a solve that finishes while the next step is waiting for the page', () => {
  /**
   * Production 2026-09-25 18:35Z, run_… (n=1): the challenge fired
   * under step 0's navigate and was solved at 18:35:30Z while step 1 sat
   * parked on the solve; step 1 then read a 339-character tree in a 253 ms
   * settle — the ordinary window, not the post-solve one — so the outcome had
   * not reached the read it was for. The parked step is woken by the solve
   * ending, and it must find the outcome already there.
   */
  test('is reported on that very step', async () => {
    const clock = new VirtualClock();
    let session: PageSession | undefined;
    let solving: Promise<unknown> | undefined;
    /** The retake after the solve is the next freeze asked for; make it the slow one. */
    let slowNextLock = false;
    const h = harness({
      clock,
      solveChallenge: async () => {
        await clock.sleep(1_000);
        slowNextLock = true;
        return { solved: false, reason: 'exhausted' };
      },
      lock: async () => {
        if (!slowNextLock) return;
        slowNextLock = false;
        await clock.sleep(100);
      },
      snapshot: () => sorry,
      perform: () => {
        // The hold arrives while the action lands and is not awaited by it:
        // the browser's event, answered on its own schedule.
        if (session === undefined) throw new Error('no session was handed out');
        solving = session.withSolve(HOLD);
      },
      model: (_prompt, step) => ({ action: step === 0 ? clickBox : done }),
    });
    await runAgent(h.deps, {
      task: 'report the first three results for socks',
      caps: CAPS,
      stepFailures: 3,
      onSession: (created) => {
        session = created;
      },
    });
    await solving;

    expect(h.prompts[1]?.notice ?? '').toContain('Automatic verification did not succeed on this page');
  });
});

describe('an action chosen while a verification is being solved', () => {
  /**
   * Production 2026-09-25 18:35:17Z, run_… step 1 (n=1): the model
   * chose a click at (400,300) while chal.5 was being solved, and the page
   * gate refused it — the step record's error is "perform(click) is refused
   * while challenge chal.5 is being solved". So nothing reached the page; but
   * the refusal was charged to `stepFailures` and shown to the model as an
   * internal error. It is neither the model's fault nor a failure.
   */
  test('is not performed, is not charged, and the next read says why and what became of the check', async () => {
    const clock = new VirtualClock();
    let session: PageSession | undefined;
    let solving: Promise<unknown> | undefined;
    const h = harness({
      clock,
      solveChallenge: async () => {
        await clock.sleep(1_000);
        return { solved: true };
      },
      snapshot: () => sorry,
      model: (_prompt, step) => {
        if (step === 0) {
          // The hold arrives after the model has chosen, before dispatch.
          if (session === undefined) throw new Error('no session was handed out');
          solving = session.withSolve(HOLD);
          return { action: clickBox };
        }
        return { action: done };
      },
    });
    const result = await runAgent(h.deps, {
      task: 'report the first three results for socks',
      caps: CAPS,
      // Zero tolerance: charging the refusal would end the run here.
      stepFailures: 0,
      onSession: (created) => {
        session = created;
      },
    });
    await solving;

    expect(h.performed).toEqual([]);
    expect(result.status).toBe('completed');
    expect(result.steps[0]?.error ?? '').toContain('verification check on this page was being handled');
    expect(h.prompts[1]?.notice ?? '').toContain('was completed for you automatically');
  });
});

describe("the page's own control, chosen while a verification was being solved", () => {
  /**
   * Production 2026-10-04, AB1 run_… (n=1): the model chose the demo's
   * "Check" button while the reCAPTCHA solve was running, the gate refused it,
   * the token was delivered 29 s later, and the next step clicked the
   * reCAPTCHA checkbox instead; "Check" was never pressed and the run ran out
   * of budget. The refused click is sent again once the check is completed,
   * when the read after it still shows that control on that page.
   */
  const DEMO_URL = 'https://2captcha.com/demo/recaptcha-v2';
  const form = tree(
    node({
      role: 'RootWebArea',
      name: 'reCAPTCHA V2 demo',
      children: [node({ role: 'button', name: 'Check' })],
    }),
    DEMO_URL,
  );
  const check: Action = { type: 'click', ref: refOf(form, 'Check') };

  async function runRefused(solve: { solved: true } | { solved: false; reason: 'exhausted' }) {
    const clock = new VirtualClock();
    let session: PageSession | undefined;
    let solving: Promise<unknown> | undefined;
    const h = harness({
      clock,
      solveChallenge: async () => {
        await clock.sleep(1_000);
        return solve;
      },
      snapshot: () => form,
      model: (_prompt, step) => {
        if (step === 0) {
          if (session === undefined) throw new Error('no session was handed out');
          solving = session.withSolve(HOLD);
          return { action: check };
        }
        return { action: done };
      },
    });
    const result = await runAgent(h.deps, {
      task: 'solve the check and report the message',
      caps: CAPS,
      stepFailures: 3,
      onSession: (created) => {
        session = created;
      },
    });
    await solving;
    return { h, result };
  }

  test('is sent again once the check is completed, and the model is told so', async () => {
    const { h, result } = await runRefused({ solved: true });

    expect(h.performed).toEqual([check]);
    expect(result.steps[0]?.error ?? '').toContain('verification check on this page was being handled');
    expect(result.steps[1]?.action).toEqual(check);
    expect(result.steps[1]?.error).toBeUndefined();
    // The resend took no model call, so the model's second prompt is the one
    // after it, and it says what happened.
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]?.notice ?? '').toContain('was sent again once the check was done');
  });

  test('is not sent again when the check failed', async () => {
    const { h, result } = await runRefused({ solved: false, reason: 'exhausted' });

    expect(h.performed).toEqual([]);
    expect(result.steps[1]?.action).toEqual(done);
    expect(h.prompts[1]?.notice ?? '').toContain('Automatic verification did not succeed on this page');
  });
});

describe('a verification that succeeded on the page', () => {
  test('the next read waits for the page the submit leads to, and says what happened', async () => {
    let solvedAt: number | undefined;
    const { notices, trees } = await runWithHold(
      (clock) => {
        solvedAt = clock.now();
        return { solved: true };
      },
      (clock) => {
        if (solvedAt === undefined) return sorry;
        const since = clock.now() - solvedAt;
        // The submit leaves /sorry after 0.6 s; the results page commits with
        // its chrome only and its results follow a second later — the shape
        // measured in run_…'s replay.
        return since < 600 ? sorry : since < 1_600 ? skeleton : results;
      },
      2,
    );

    expect(trees[1]?.url).toBe(SEARCH_URL);
    expect(trees[1]?.root.children?.map((child) => child.name)).toEqual([
      'Search home',
      'Result one',
      'Result two',
      'Result three',
    ]);
    expect(notices[1]).toContain('was completed for you automatically');
  });
});

/**
 * Production 2026-10-07, run_… (Stealth Bench task 11, n=1): the
 * browser solved the /nocaptcha reCAPTCHA in 45.6 s and the page moved on to
 * the results, the model was told so, and the step trace said nothing: a
 * reader of `/events` saw the challenge page and no outcome.
 */
describe('the step trace', () => {
  test('carries a check the browser solved, with its vendor, on the step that read the page after it', async () => {
    const { steps } = await runWithHold(() => ({ solved: true }), () => results, 2);

    expect(steps[0]?.verification).toBeUndefined();
    expect(steps[1]?.verification).toEqual([{ outcome: 'solved', vendor: 'recaptcha' }]);
    expect(toWireStep(steps[1]!).verification).toEqual([{ outcome: 'solved', vendor: 'recaptcha' }]);
  });

  test('carries a failed check as plainly, and one left to the page as no verdict', async () => {
    const failed = await runWithHold(() => ({ solved: false, reason: 'exhausted' }), () => sorry, 2);
    const left = await runWithHold(() => ({ solved: false, reason: 'unsupported', leftToPage: true }), () => results, 2);

    expect(failed.steps[1]?.verification).toEqual([{ outcome: 'failed', vendor: 'recaptcha', reason: 'exhausted' }]);
    expect(left.steps[1]?.verification).toEqual([{ outcome: 'left', vendor: 'recaptcha', reason: 'unsupported' }]);
  });

  test('carries a check the browser declined to solve as no verdict, not a failure', async () => {
    // Production 2026-10-07 (stealth-full11/12): DataDome and PerimeterX checks
    // the browser never attempted (outcome unsupported, attempted []) were
    // traced 'failed', and the judge failed anntaylor, fiverr, samsclub and
    // seatgeek runs that had read every answer off the page.
    // MUTATION: `unsupported` read as a failed solve.
    const declined = await runWithHold(() => ({ solved: false, reason: 'unsupported' }), () => results, 2);

    expect(declined.steps[1]?.verification).toEqual([{ outcome: 'left', vendor: 'recaptcha', reason: 'unsupported' }]);
  });
});
