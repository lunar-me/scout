/**
 * The memory ceiling: what a long run's prompt is allowed to grow to, and what
 * happens to the facts it stops rendering.
 *
 * `findings` and `ruledOut` were the only terms in the prompt with no bound of
 * any kind, and they were simultaneously the ONLY copy of what a run had
 * learned — on no `StepTrace`, on no result, in no table. So a ceiling on them
 * is two claims at once and both are tested here: that the prompt stops
 * growing, and that nothing is lost when it does.
 *
 * Nothing below asserts on prompt WORDING. The lines are going to be reworded
 * and a test that breaks on a reworded sentence gets deleted rather than fixed.
 * What is asserted is structure a consumer can observe: which entries render,
 * that a block only ever grows between rewrites, and what comes back on the
 * result.
 */

import { describe, expect, test } from 'bun:test';

import type { Action } from '../src/actions';
import type { ModelChoice } from '../src/loop';
import { renderPrompt, runAgent } from '../src/loop';
import type { Finding, GoalState, RuledOut } from '../src/result';
import { FINDINGS_CHAR_BUDGET, MEMORY_CHAR_BUDGET, boundMemory } from '../src/result';
import { harness, node, refOf, tree } from './support';

const CAPS = { steps: 400, budget: '50.00', duration: '10m' } as const;

const noteLength = (entry: Finding | RuledOut): number =>
  3 + (entry.goal === undefined ? 0 : entry.goal.length + 1) + entry.text.length;

/** Findings of a realistic width: the committed fixtures are 43-49 characters. */
function findings(count: number, from = 0): Finding[] {
  return Array.from({ length: count }, (_, i) => ({
    step: from + i,
    text: `record ${String(from + i)} is dated 2019-04-1${String(i % 10)} and cites 31 sources`,
  }));
}

describe('the ceiling', () => {
  test('a run that has not reached it renders every entry', () => {
    const entries = findings(10);
    const bounded = boundMemory(entries, noteLength);

    expect(bounded.dropped).toEqual([]);
    expect(bounded.kept).toEqual(entries);
  });

  test('a run past it renders the newest entries and withholds the oldest', () => {
    const entries = findings(400);
    const bounded = boundMemory(entries, noteLength);

    const keptChars = bounded.kept.reduce((sum, entry) => sum + noteLength(entry), 0);
    expect(keptChars).toBeLessThanOrEqual(MEMORY_CHAR_BUDGET);
    expect(bounded.dropped.length + bounded.kept.length).toBe(400);
    // The newest survive and the oldest go, which is the only ordering that
    // keeps a block append-only between rewrites.
    expect(bounded.kept.at(-1)).toEqual(entries[399] as Finding);
    expect(bounded.dropped[0]).toEqual(entries[0] as Finding);
  });

  /**
   * THE HYSTERESIS, and the reason this file exists.
   *
   * The three memory blocks sit in the prompt's append-only tier: everything
   * before them is byte-stable, so a growing list extends a provider's prefix
   * cache instead of invalidating it. A ceiling that evicted one entry per
   * append would rewrite the block from its first line on every single step and
   * throw that away — a bound that saves a thousand tokens by costing a cache
   * hit on the whole prefix is not a saving.
   *
   * So: the kept set may only change when the ceiling is CROSSED, and each
   * crossing must buy a long stretch of pure appends. Four hundred entries at
   * ~45 characters is about seven budgets' worth, so a correct implementation
   * rewrites of the order of ten times and a per-append implementation rewrites
   * over three hundred.
   */
  test('the block is rewritten once per crossing, not once per entry', () => {
    const all = findings(400);
    let rewrites = 0;
    let previousKept: readonly Finding[] = [];

    for (let n = 1; n <= all.length; n += 1) {
      const bounded = boundMemory(all.slice(0, n), noteLength);
      const grewByOne =
        bounded.kept.length === previousKept.length + 1 &&
        previousKept.every((entry, i) => entry === bounded.kept[i]);
      if (!grewByOne && n > 1) {
        rewrites += 1;
      }
      previousKept = bounded.kept;
    }

    expect(rewrites).toBeGreaterThan(0);
    expect(rewrites).toBeLessThan(20);
  });

  test('an entry larger than the whole budget still renders: a block that shows nothing is worse', () => {
    const huge: Finding = { step: 0, text: 'x'.repeat(MEMORY_CHAR_BUDGET * 3) };
    const bounded = boundMemory([...findings(200), huge], noteLength);

    expect(bounded.kept).toContain(huge);
  });

  test('pinned entries are never withheld, however old', () => {
    const goals: GoalState[] = [
      { id: 'g1', goal: 'the one still open', status: 'active' },
      ...Array.from({ length: 300 }, (_, i) => ({
        id: `c${String(i)}`,
        goal: `a closed errand number ${String(i)} with a realistic amount of text on it`,
        status: 'done' as const,
        summary: 'confirmed',
      })),
    ];

    const bounded = boundMemory(
      goals,
      (goal) => 7 + goal.id.length + goal.status.length + goal.goal.length,
      (goal) => goal.status !== 'done' && goal.status !== 'failed',
    );

    expect(bounded.dropped.length).toBeGreaterThan(0);
    expect(bounded.dropped.some((goal) => goal.status === 'active')).toBe(false);
    expect(bounded.kept[0]?.id).toBe('g1');
  });
});

describe('the prompt', () => {
  const page = tree(node({ role: 'RootWebArea', name: 'a page' }), 'https://a.example/');

  function promptWith(memoryFindings: readonly Finding[]): string {
    return renderPrompt({
      task: 'survey the registries',
      step: 300,
      history: [],
      tree: page,
      snapshotHash: 'ax1:test',
      memory: { goals: [], findings: memoryFindings, ruledOut: [] },
    });
  }

  test('says how much it withheld and over which steps, so the model knows a gap exists', () => {
    const rendered = promptWith(findings(400));
    const bounded = boundMemory(findings(400), noteLength);

    expect(rendered).toContain(String(bounded.dropped.length));
    expect(rendered).toContain('steps 0-');
    // And the withheld text really is absent, not merely summarised beside itself.
    expect(rendered).not.toContain((findings(1)[0] as Finding).text);
  });

  test('is flat across an order of magnitude of extra memory', () => {
    const atFourHundred = promptWith(findings(400)).length;
    const atFourThousand = promptWith(findings(4_000)).length;

    // The digest line's own count grows by a few characters; the block does not.
    expect(atFourThousand - atFourHundred).toBeLessThan(40);
  });
});

/**
 * Findings at the width a frontier actuator writes them, which is what the
 * answer is composed from. BU Bench V1, n=100 runs on 2026-10-01: median
 * finding 185 characters, largest total per run 5,896. A run that records a
 * dozen of those has to finish with all of them in front of it, or its answer
 * drops items it found and it re-reads pages it already read.
 */
describe('the findings a research run finishes from', () => {
  const wide = (step: number): string =>
    `item ${String(step)} confirmed at https://source.example/${String(step)}: ${'a listed value, '.repeat(11)}end`;

  test('a dozen wide findings are all in the prompt the run finishes on', async () => {
    const page = tree(node({ role: 'RootWebArea', name: 'index', children: [node({ role: 'button', name: 'Next' })] }));
    const STEPS = 14;
    let last = '';
    const h = harness({
      tree: page,
      model: (prompt, step): ModelChoice => {
        last = prompt.text;
        if (step >= STEPS - 1) {
          return { action: { type: 'done', summary: 'compiled' } };
        }
        return {
          action: { type: 'click', ref: refOf(page, 'Next'), finding: wide(step) } as unknown as Action,
        };
      },
    });

    const result = await runAgent(h.deps, { task: 'compile the list', caps: CAPS, stepFailures: 5 });

    expect(result.findings.length).toBe(STEPS - 1);
    // 13 findings of ~200 characters: past the shared 2,500, inside the
    // findings block's own ceiling. The first one is what the old bound lost.
    expect(result.findings.reduce((sum, entry) => sum + noteLength(entry), 0)).toBeGreaterThan(MEMORY_CHAR_BUDGET);
    for (const finding of result.findings) {
      expect(last).toContain(finding.text);
    }
  });
});

describe('what the ceiling withholds is on the result', () => {
  /**
   * The whole legitimacy of the bound. Before this field existed the prompt was
   * the only copy, so compacting a finding out of it destroyed the finding.
   */
  test('every finding and ruled-out entry a long run emitted comes back, including the compacted ones', async () => {
    const page = tree(node({ role: 'RootWebArea', name: 'store', children: [node({ role: 'button', name: 'Next' })] }));
    const STEPS = 260;
    const h = harness({
      tree: page,
      model: (prompt, step): ModelChoice => {
        const envelope: Record<string, unknown> = {
          finding: `record ${String(step)} is dated 2019-04-1${String(step % 10)} and cites 31 sources`,
        };
        if (step % 10 === 0) {
          envelope['ruledOut'] = `route ${String(step)} does not reach the archive`;
        }
        void prompt;
        if (step >= STEPS - 1) {
          return { action: { type: 'done', summary: 'surveyed', ...envelope } as unknown as Action };
        }
        return {
          action: { type: 'click', ref: refOf(page, 'Next'), ...envelope } as unknown as Action,
        };
      },
    });

    const result = await runAgent(h.deps, { task: 'survey', caps: CAPS, stepFailures: 5 });

    // Every step of this run emitted a finding, so the two counts must agree
    // whatever the loop's own stopping shape does with the last step.
    expect(result.stepsUsed).toBeGreaterThanOrEqual(STEPS);
    expect(result.findings.length).toBe(result.stepsUsed);
    expect(result.ruledOut.length).toBe(Math.ceil(result.stepsUsed / 10));
    // The very first finding — long since compacted out of the prompt — is here.
    expect(result.findings[0]?.text).toContain('record 0 is dated');
    expect(result.findings.at(-1)?.text).toContain(
      `record ${String(result.stepsUsed - 1)} is dated`,
    );
  });

  test('the prompt stopped growing while the record did not', async () => {
    const page = tree(node({ role: 'RootWebArea', name: 'store', children: [node({ role: 'button', name: 'Next' })] }));
    const sizes: number[] = [];
    const h = harness({
      tree: page,
      model: (prompt, step): ModelChoice => {
        sizes.push(prompt.text.length);
        const envelope = {
          finding: `record ${String(step)} is dated 2019-04-1${String(step % 10)} and cites 31 sources`,
        };
        if (step >= 259) {
          return { action: { type: 'done', summary: 'done', ...envelope } as unknown as Action };
        }
        return {
          action: { type: 'click', ref: refOf(page, 'Next'), ...envelope } as unknown as Action,
        };
      },
    });

    const result = await runAgent(h.deps, { task: 'survey', caps: CAPS, stepFailures: 5 });

    const early = sizes[60] as number;
    const late = sizes[250] as number;
    // 190 more steps and 190 more findings; the prompt is not 190 findings bigger.
    expect(late - early).toBeLessThan(FINDINGS_CHAR_BUDGET);
    expect(result.findings.length).toBe(result.stepsUsed);
  });
});
