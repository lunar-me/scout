/**
 * The wander stop, replayed against the page states production actually served.
 *
 * `fixtures/recorded-page-states.json` is every page read of bench run
 * 20260908135402's predecessor 20260908122325 — 282 reads across 12 tasks,
 * dumped by `OUTCRAWL_TREE_LOG` and re-hashed with the production
 * `hashSnapshot`. This file replays each recorded SEQUENCE through the real
 * loop and asserts two things and no others:
 *
 *   - the runs that capped stop early, with `loop-detected`;
 *   - the runs that finished are untouched, down to the step count.
 *
 * The trees are rebuilt rather than shipped: 15MB of raw AX dumps would be a
 * fixture nobody reads, and the loop consults exactly one property of a tree
 * here — whether this read hashes like the last one. So each recorded hash
 * becomes one synthetic page carrying that hash in a `StaticText` name, cached
 * by hash, and two rebuilt trees are identical if and only if the two real
 * reads were. That is `price-settle-policy.ts`'s technique and it is exact for
 * the question being asked.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import type { Action } from '../src/actions';
import type { ModelChoice } from '../src/loop';
import { NO_PROGRESS_TOLERANCE, runAgent } from '../src/loop';
import type { AxTree } from '../src/snapshot';
import { hashSnapshot } from '../src/snapshot';
import { harness, node, refOf, tree } from './support';

interface RecordedRun {
  readonly task: string;
  readonly steps: number;
  readonly capSteps: number;
  readonly outcome: string;
  readonly stopReason: string;
  readonly pass: boolean;
  readonly page: readonly { readonly url: string; readonly hash: string }[];
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/recorded-page-states.json', import.meta.url), 'utf8'),
) as { readonly runs: readonly RecordedRun[] };

/**
 * The first run in which this guard actually fired: six rows on the replacement
 * actuator, once the bench clock was slack enough for steps to bind. Four
 * stopped `loop-detected`. Replayed for the same reason the corpus above is —
 * a change that stops reproducing these stops has broken something a customer
 * paid for.
 */
const ga = JSON.parse(
  readFileSync(new URL('./fixtures/recorded-page-states-ga.json', import.meta.url), 'utf8'),
) as { readonly runs: readonly RecordedRun[] };

const CAPS = { budget: '10.00', duration: '60m' };

/**
 * One page per recorded hash, memoised so a repeated read returns the SAME
 * tree — a frozen page, which is what the recording shows.
 */
const pages = new Map<string, AxTree>();
function pageFor(hash: string, url: string): AxTree {
  const held = pages.get(hash);
  if (held !== undefined) {
    return held;
  }
  const built = tree(
    node({
      role: 'RootWebArea',
      name: 'replay',
      children: [
        node({ role: 'StaticText', name: hash }),
        node({ role: 'button', name: 'Act' }),
      ],
    }),
    url,
  );
  pages.set(hash, built);
  return built;
}

/**
 * Replays one recorded run: read i returns the tree recorded at step i, and the
 * model clicks the one button on every step.
 *
 * The recording carries reads and no actions, so that one click is the WORST
 * CASE for counting a return: every time a recorded tree comes back, the
 * replay has repeated a step it took there. Any real run with the same reads
 * took the same or more varied actions, so it stops no earlier than this.
 *
 * `ceiling` defaults to the run's own recorded step count, which is what makes
 * a run the rule never touches end `max-steps` having used exactly the steps it
 * really used. The production-firing replay passes the run's REAL `capSteps`
 * instead: those runs were stopped by the guard well inside a 60-step ceiling,
 * and replaying them against a ceiling equal to their own length would let
 * `max-steps` win the race and prove nothing. Past the last recorded read the
 * page holds still, which is what it was doing when production stopped.
 */
async function replay(run: RecordedRun, ceiling = run.steps) {
  let cursor = 0;
  const h = harness({
    tree: pageFor(run.page[0]?.hash ?? '', run.page[0]?.url ?? ''),
    snapshot: () => {
      const state = run.page[Math.min(cursor, run.page.length - 1)];
      return pageFor(state?.hash ?? '', state?.url ?? '');
    },
    model: (prompt, step): ModelChoice => {
      cursor = step + 1;
      return { action: { type: 'click', ref: refOf(prompt.tree, 'Act') } };
    },
  });
  return runAgent(h.deps, {
    task: run.task,
    caps: { ...CAPS, steps: ceiling },
    stepFailures: null,
  });
}

const capped = fixture.runs.filter((run) => run.outcome === 'capped');
const finished = fixture.runs.filter((run) => run.outcome !== 'capped');

describe('a run that stops moving the page stops', () => {
  test('the fixture is the real recording, hashed by the real hash', () => {
    // Guards the replay itself: a fixture whose hashes were not production
    // hashes would make every assertion below a statement about nothing.
    expect(fixture.runs).toHaveLength(12);
    expect(fixture.runs.reduce((sum, run) => sum + run.page.length, 0)).toBe(282);
    for (const run of fixture.runs) {
      expect(run.page).toHaveLength(run.steps);
      for (const state of run.page) {
        expect(state.hash).toMatch(/^ax\d+:[0-9a-f]{64}$/);
      }
    }
    // And the rebuild preserves the only relation the loop reads.
    const [first, second] = [pageFor('ax1:a', 'https://x/'), pageFor('ax1:b', 'https://x/')];
    expect(hashSnapshot(first)).not.toBe(hashSnapshot(second));
    expect(hashSnapshot(pageFor('ax1:a', 'https://x/'))).toBe(hashSnapshot(first));
  });

  test.each(capped.map((run) => [run.task, run] as const))(
    '%s capped at its ceiling and now stops on the stall',
    async (_task, run) => {
      const result = await replay(run);

      expect(result.stopReason).toBe('loop-detected');
      expect(result.stepsUsed).toBeLessThan(run.steps);
      // Not a cap: `cappedBy` unset is what keeps a killed wander out of the
      // caller's ceiling accounting, and out of `status: 'capped'`.
      expect(result.cappedBy).toBeUndefined();
      expect(result.status).toBe('failed');
      // The reason is TRUE and it is specific. A guard that fired and reported
      // `task-complete` — or nothing — is the failure mode this asserts against.
      // A stall that came back to a tree says so rather than claiming a frozen
      // page: `wv-arxiv-14`'s read 14 is a return, see the pinned stops below.
      expect(result.error).toMatch(
        new RegExp(
          `the page has not changed across ${String(NO_PROGRESS_TOLERANCE + 1)} consecutive reads|` +
            `for ${String(NO_PROGRESS_TOLERANCE)} consecutive steps since step \\d+ the run only came back`,
        ),
      );
    },
  );

  test('it stops where the measurement says it stops, to the step', async () => {
    // The three capped runs go identical at reads 5, 5 and 15, and
    // `wv-arxiv-14`'s read 14 is already a return to a tree it clicked on, so
    // the cut lands at 30, 30 and 39 of 60. Pinned as numbers rather than as an
    // inequality: this is the saving, and a change that quietly halves it
    // should fail here.
    const stops = new Map<string, number>();
    for (const run of capped) {
      stops.set(run.task, (await replay(run)).stepsUsed);
    }
    expect(stops).toEqual(
      new Map([
        ['wv-allrecipes-10', 30],
        ['wv-amazon-16', 30],
        ['wv-arxiv-14', 39],
      ]),
    );
    // 81 of the 180 steps those three runs spent, and every one of them was a
    // model call on a page that had not changed, or had only come back.
    expect(capped.reduce((sum, run) => sum + run.steps, 0) - [...stops.values()].reduce((a, b) => a + b, 0)).toBe(81);
  });

  test.each(finished.map((run) => [run.task, run] as const))(
    '%s finished for real and is not touched',
    async (_task, run) => {
      const result = await replay(run);

      // THE HARD CONSTRAINT. Every one of these ran to its recorded depth
      // without the rule firing — `wv-allrecipes-40` included, which held one
      // page for 17 identical reads and is the row that PASSES at exactly 60
      // steps in the sweep, and `wv-allrecipes-3`, which passed here. Under the
      // replay's one repeated click, which is the worst case for a return.
      expect(result.stopReason).toBe('max-steps');
      expect(result.stepsUsed).toBe(run.steps);
    },
  );
});

describe('the run that fired it in production, replayed', () => {
  // Run 20260908193404, tree e2bb268, the first hands model, 60-step ceiling.
  // These four rows had each spent all 60 steps and returned nothing in BOTH
  // repeats of the published sweep; here they stop at 26, 29, 35 and 34, which
  // is 116 steps and 48.8% of what the ceiling cost them.
  const stopped = ga.runs.filter((run) => run.stopReason === 'loop-detected');

  test.each(stopped.map((run) => [run.task, run] as const))(
    '%s stops on the stall at the step production stopped it',
    async (_task, run) => {
      const result = await replay(run, run.capSteps);
      expect(result.stopReason).toBe('loop-detected');
      // AT OR BEFORE the step production stopped it, never after, and the gap
      // is not slack — it is the one thing this fixture cannot carry. The
      // counter also resets on a finding, and production's model emitted some
      // during these stalls; the replay's does not, so the replay reaches the
      // tolerance sooner. What it pins is that the same recorded page sequence
      // still ends this way, which is the regression worth catching.
      expect(result.stepsUsed).toBeLessThanOrEqual(run.steps);
      expect(result.cappedBy).toBeUndefined();
    },
  );

  test('the four of six, and the two the harness lost', () => {
    expect(stopped.map((run) => run.steps)).toEqual([26, 29, 35, 34]);
    // 116 steps against a 60-step ceiling, which is the measured saving.
    expect(stopped.reduce((sum, run) => sum + (60 - run.steps), 0)).toBe(116);
    // `wv-allrecipes-40` is the one long PASSER that reached the browser, and
    // the guard did not touch it: it died on a CDP 1006 at step 14 with a
    // streak of 13, under the cut. It is recorded here so nobody later reads
    // "the guard did not fire on it" as evidence that it would not have.
    const lost = ga.runs.filter((run) => run.stopReason !== 'loop-detected');
    expect(lost.map((run) => `${run.task}:${run.stopReason}`)).toEqual(['wv-allrecipes-40:error']);
  });
});

describe('the counter is bounded on change, not on depth', () => {
  test('a run that keeps moving the page is never stopped, however deep', async () => {
    let cursor = 0;
    const h = harness({
      // A new page on every read: the deep-but-working run the rule must never
      // reach. 200 steps, eight times the tolerance.
      snapshot: () => pageFor(`ax1:moving-${String(cursor)}`, 'https://example.com/'),
      model: (prompt, step): ModelChoice => {
        cursor = step + 1;
        return { action: { type: 'click', ref: refOf(prompt.tree, 'Act') } };
      },
      tree: pageFor('ax1:moving-0', 'https://example.com/'),
    });
    const result = await runAgent(h.deps, {
      task: 'deep but working',
      caps: { ...CAPS, steps: 200 },
      stepFailures: null,
    });

    expect(result.stopReason).toBe('max-steps');
    expect(result.stepsUsed).toBe(200);
  });

  test('one changed read resets the whole allowance', async () => {
    // Stall for the tolerance minus one, move once, then stall again: two
    // stretches that each fall short must not add up to a stop.
    const half = NO_PROGRESS_TOLERANCE - 1;
    let cursor = 0;
    const h = harness({
      snapshot: () => pageFor(cursor < half ? 'ax1:first' : 'ax1:second', 'https://example.com/'),
      model: (prompt, step): ModelChoice => {
        cursor = step + 1;
        return { action: { type: 'click', ref: refOf(prompt.tree, 'Act') } };
      },
      tree: pageFor('ax1:first', 'https://example.com/'),
    });
    const result = await runAgent(h.deps, {
      task: 'two short stalls',
      caps: { ...CAPS, steps: 2 * half },
      stepFailures: null,
    });

    expect(result.stopReason).toBe('max-steps');
    expect(result.stepsUsed).toBe(2 * half);
  });

  test('the tolerance is the exact boundary', async () => {
    // NO_PROGRESS_TOLERANCE repeats are allowed; the read that makes it one
    // more is the last step the run takes.
    const h = harness({
      snapshot: () => pageFor('ax1:frozen', 'https://example.com/'),
      model: (prompt): ModelChoice => ({ action: { type: 'click', ref: refOf(prompt.tree, 'Act') } }),
      tree: pageFor('ax1:frozen', 'https://example.com/'),
    });
    const result = await runAgent(h.deps, {
      task: 'frozen from the first read',
      caps: { ...CAPS, steps: 500 },
      stepFailures: null,
    });

    expect(result.stopReason).toBe('loop-detected');
    expect(result.stepsUsed).toBe(NO_PROGRESS_TOLERANCE + 1);
  });
});

describe('a frozen page is not a stall when something else is moving', () => {
  test('a tool call resets it: the page is frozen across one by design', async () => {
    // Every step calls a tool on a page that never changes. The page is frozen
    // for the duration of a `callTool` — the loop guarantees it — so counting
    // those reads would stop a run whose whole task is off-page.
    const calls: string[] = [];
    const h = harness({
      snapshot: () => pageFor('ax1:frozen', 'https://example.com/'),
      model: (): ModelChoice => ({
        action: { type: 'callTool', tool: 'inbox.read', arguments: {} },
      }),
      tree: pageFor('ax1:frozen', 'https://example.com/'),
    });
    const result = await runAgent(
      {
        ...h.deps,
        tools: {
          list: () => [{ name: 'inbox.read', description: 'read the inbox' }],
          call: (name) => {
            calls.push(name);
            return { text: 'nothing yet', isError: false };
          },
        },
      },
      {
        task: 'poll an inbox',
        caps: { ...CAPS, steps: 3 * NO_PROGRESS_TOLERANCE },
        stepFailures: null,
      },
    );

    expect(result.stopReason).toBe('max-steps');
    expect(result.stepsUsed).toBe(3 * NO_PROGRESS_TOLERANCE);
    expect(calls).toHaveLength(3 * NO_PROGRESS_TOLERANCE);
  });
});

describe('the stop reason reaches the record', () => {
  test('every recorded step is emitted and the run reports loop-detected once', async () => {
    const streamed: string[] = [];
    const durable: string[] = [];
    const click: Action = { type: 'click', ref: refOf(pageFor('ax1:frozen', 'https://example.com/'), 'Act') };
    const h = harness({
      snapshot: () => pageFor('ax1:frozen', 'https://example.com/'),
      model: (): ModelChoice => ({ action: click }),
      tree: pageFor('ax1:frozen', 'https://example.com/'),
    });
    const result = await runAgent(h.deps, {
      task: 'frozen',
      caps: { ...CAPS, steps: 500 },
      stepFailures: null,
      onStep: (step) => streamed.push(String(step.index)),
      onRecord: (frame) => { durable.push(frame.kind); },
    });

    // The steps the run was billed for are the steps its consumers saw: a stop
    // that dropped its last frame would leave an invoice nobody can reconcile.
    expect(streamed).toHaveLength(result.stepsUsed);
    expect(durable.filter((kind) => kind === 'step')).toHaveLength(result.stepsUsed);
    expect(result.stopReason).toBe('loop-detected');
  });
});

describe('a run going round in a circle stops', () => {
  test('the same click on page states the run keeps returning to stops at the same tolerance', async () => {
    // The shape of production run a3ca4c9d: one button clicked 217 times while
    // the page cycled through three states, so no two consecutive reads matched
    // and the frozen-page count never passed 1.
    const cycle = ['ax1:product', 'ax1:minicart', 'ax1:overlay'];
    let cursor = 0;
    const h = harness({
      snapshot: () => pageFor(cycle[cursor % cycle.length] ?? '', 'https://shop.example/products/gel'),
      model: (prompt, step): ModelChoice => {
        cursor = step + 1;
        return { action: { type: 'click', ref: refOf(prompt.tree, 'Act') } };
      },
      tree: pageFor('ax1:product', 'https://shop.example/products/gel'),
    });
    const result = await runAgent(h.deps, {
      task: 'add it to the bag and check out',
      caps: { ...CAPS, steps: 235 },
      stepFailures: null,
    });

    expect(result.stopReason).toBe('loop-detected');
    // One lap to take each step once, then the tolerance in repeats.
    expect(result.stepsUsed).toBe(cycle.length + NO_PROGRESS_TOLERANCE);
    // The owner is told which control it kept pressing, not that the page
    // froze: it did not.
    expect(result.error).toContain('"Act"');
  });

  test('a circle broken by a new page, then a frozen page, is reported as a frozen page', async () => {
    // The sentence is evidence, so it has to describe the stall that ended the
    // run and not one that ended earlier: ten steps of circling, one new page,
    // then a page that never moves.
    const cycle = ['ax1:a', 'ax1:b'];
    let cursor = 0;
    const h = harness({
      snapshot: () =>
        pageFor(cursor < 10 ? (cycle[cursor % cycle.length] ?? '') : 'ax1:frozen', 'https://example.com/'),
      model: (prompt, step): ModelChoice => {
        cursor = step + 1;
        return { action: { type: 'click', ref: refOf(prompt.tree, 'Act') } };
      },
      tree: pageFor('ax1:a', 'https://example.com/'),
    });
    const result = await runAgent(h.deps, {
      task: 'circle, then stall',
      caps: { ...CAPS, steps: 500 },
      stepFailures: null,
    });

    expect(result.stopReason).toBe('loop-detected');
    expect(result.stepsUsed).toBe(10 + NO_PROGRESS_TOLERANCE + 1);
    expect(result.error).toContain('the page has not changed across');
  });

  test('a page that becomes a new state on every click is never a circle', async () => {
    // "Load more": the same button, a different page every time. Only the cap
    // may end it.
    let cursor = 0;
    const h = harness({
      snapshot: () => pageFor(`ax1:grown-${String(cursor)}`, 'https://shop.example/list'),
      model: (prompt, step): ModelChoice => {
        cursor = step + 1;
        return { action: { type: 'click', ref: refOf(prompt.tree, 'Act') } };
      },
      tree: pageFor('ax1:grown-0', 'https://shop.example/list'),
    });
    const result = await runAgent(h.deps, {
      task: 'load every page of the list',
      caps: { ...CAPS, steps: 60 },
      stepFailures: null,
    });

    expect(result.stopReason).toBe('max-steps');
    expect(result.stepsUsed).toBe(60);
  });
});

describe('a stall stops before the budget it would spend', () => {
  /**
   * A page that posts back on every click: the same tree, and the same Search
   * button minted under a new backend node id on every read (MEM4
   * `run_…`, 2026-10-04: nodes 484, 770, 1056, 1342, 1628, 1914).
   */
  const postback = (state: string): AxTree =>
    tree(
      node({
        role: 'RootWebArea',
        name: 'Quotes to Scrape',
        children: [
          node({ role: 'StaticText', name: state }),
          node({ role: 'combobox', name: 'Author', value: 'Albert Einstein', xpath: '/html/body/form/select[1]' }),
          node({ role: 'button', name: 'Search', xpath: '/html/body/form/input[3]' }),
        ],
      }),
      'https://quotes.toscrape.com/filter.aspx',
    );
  const clickSearch = (prompt: { readonly tree: AxTree }): ModelChoice => ({ action: { type: 'click', ref: refOf(prompt.tree, 'Search') } });

  /**
   * MEM4's shape: Search clicked again and again on a page that never changes,
   * a fresh node id each time, each step costing 2 credits of a 30-credit
   * budget, so the run can afford 15 steps and 25 stalled ones never come.
   * MUTATIONS THIS CATCHES: the allowance not scaled to the budget (the run
   * ends `max-budget` having spent all 30); repeats keyed on the backend id,
   * which the postback never repeats (same `max-budget`).
   */
  test('the same control pressed on an unchanged page stops loop-detected while budget is left', async () => {
    const h = harness({
      snapshot: () => postback('No quotes found'),
      perform: () => ({ credits: '2.00' }),
      model: clickSearch,
      tree: postback('No quotes found'),
    });
    const result = await runAgent(h.deps, { task: 'count the Einstein quotes', caps: { budget: '30.00', duration: '60m', steps: 500 }, stepFailures: null });

    expect(result.stopReason).toBe('loop-detected');
    expect(result.cappedBy).toBeUndefined();
    // Seven repeats on a page that answered none of them, with the budget
    // for about seven more left: the stall had lasted as long as the rest would.
    expect(result.stepsUsed).toBe(8);
    expect(Number(result.credits)).toBeLessThan(17);
    expect(result.error).toContain('the page has not changed across 8 consecutive reads and the run repeated 7 action(s)');
  });

  /**
   * The shape the replay of production found the budget cut must NOT stop:
   * budget-10 runs reading one page several different ways before answering.
   * MUTATION THIS CATCHES: the budget allowance applied to any stall rather
   * than a stall that repeats itself.
   */
  test('different actions on an unchanged page are not stopped by the budget allowance', async () => {
    const buttons = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'];
    const page = (): AxTree =>
      tree(
        node({
          role: 'RootWebArea',
          name: 'Survey',
          children: buttons.map((name, index) => node({ role: 'button', name, xpath: `/html/body/button[${String(index + 1)}]` })),
        }),
        'https://example.com/survey',
      );
    const h = harness({
      snapshot: page,
      perform: () => ({ credits: '2.00' }),
      model: (prompt, step): ModelChoice =>
        step < buttons.length ? { action: { type: 'click', ref: refOf(prompt.tree, buttons[step] ?? 'First') } } : { action: { type: 'done', summary: 'surveyed' } },
      tree: page(),
    });
    const result = await runAgent(h.deps, { task: 'press each button once', caps: { budget: '30.00', duration: '60m', steps: 500 }, stepFailures: null });

    expect(result.stopReason).toBe('task-complete');
    expect(result.stepsUsed).toBe(buttons.length + 1);
  });
});
