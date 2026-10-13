/**
 * The finish doors against what the run has left to spend.
 *
 * Two directions, both measured on BU Bench V1 (`bufull-web-20261001`,
 * n=100, 2026-10-01):
 *
 *   - EARLY, a `done` that names conditions it never confirmed is declined
 *     once while most of the budget is unspent: 7 failed runs stopped on such
 *     a gap after 10-27% of their budget.
 *   - LATE, past the pace line, no door holds a finish for the plan: 16 runs
 *     had a `done` declined after 80% of their budget, each decline a whole
 *     step of what was left, two of them pushed into `max-budget` by it.
 *
 * Asserted on what a caller observes: how many steps the run took, what it
 * returned, its status, and which step the loop held.
 */
import { describe, expect, test } from 'bun:test';

import type { Action } from '../src/actions';
import { validateAction } from '../src/actions';
import type { ModelChoice } from '../src/loop';
import { runAgent, runShare } from '../src/loop';
import { catalogueTree, harness, refOf } from './support';

const page = catalogueTree();
const click: Action = { type: 'click', ref: refOf(page, 'Search') };
const BUDGET = { steps: 30, budget: '10.00', duration: '10m' };

describe('a done that lists unconfirmed conditions', () => {
  test('is declined once while most of the budget is unspent, and the next finish stands', async () => {
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice =>
        step === 0
          ? { action: { type: 'done', summary: 'Shop A', unconfirmed: ['it opened before 1990'] } as Action }
          : step === 1
            ? { action: click }
            : { action: { type: 'done', summary: 'Shop B, opened 1987', unconfirmed: ['the exact street'] } as Action },
    });

    const result = await runAgent(h.deps, { task: 'the shop that opened before 1990', caps: BUDGET, stepFailures: null, settle: false });

    expect(result.stepsUsed).toBe(3);
    expect(result.steps[0]?.held).toBe('unconfirmed');
    // The decline names what was left open, so the model can go and confirm it.
    expect(h.prompts[1]?.text ?? '').toContain('it opened before 1990');
    expect(result.data).toBe('Shop B, opened 1987');
    expect(result.status).toBe('completed');
  });

  test('stands at once when half the budget is already spent', async () => {
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice =>
        step < 3 ? { action: click } : { action: { type: 'done', summary: 'Shop A', unconfirmed: ['the street'] } as Action },
      perform: () => ({ credits: '2' }),
    });

    const result = await runAgent(h.deps, { task: 'the shop', caps: BUDGET, stepFailures: null, settle: false });

    // 6 of 10 credits spent before the finish.
    expect(result.stepsUsed).toBe(4);
    expect(result.steps.some((step) => step.held === 'unconfirmed')).toBe(false);
    expect(result.data).toBe('Shop A');
  });

  test('a done that confirms everything is not held', async () => {
    const h = harness({
      tree: page,
      model: (): ModelChoice => ({ action: { type: 'done', summary: 'Shop A' } }),
    });

    const result = await runAgent(h.deps, { task: 'the shop', caps: BUDGET, stepFailures: null, settle: false });

    expect(result.stepsUsed).toBe(1);
    expect(result.data).toBe('Shop A');
  });

  test('the list is read leniently: a malformed one never costs the finish', () => {
    const checked = (unconfirmed: unknown) => validateAction({ type: 'done', summary: 's', unconfirmed }, page);

    expect(checked(['a', '', 3, ' b '])).toEqual({ ok: true, value: { type: 'done', summary: 's', unconfirmed: ['a', 'b'] } });
    expect(checked('the street')).toEqual({ ok: true, value: { type: 'done', summary: 's', unconfirmed: ['the street'] } });
    expect(checked({ street: true })).toEqual({ ok: true, value: { type: 'done', summary: 's' } });
  });
});

describe('past the pace line, no door holds a finish for the plan', () => {
  test('a done with a sub-goal still open is honoured, and the goal is closed failed for it', async () => {
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice =>
        step === 0
          ? { action: { ...click, plan: [{ id: 'g1', goal: 'list every item' }] } as unknown as Action }
          : step < 5
            ? { action: { type: 'scroll', dy: 100 * step } }
            : { action: { type: 'done', summary: 'four of the items' } },
      // 1.70 a click: 8.50 of 10 (85%) before the finish.
      perform: () => ({ credits: '1.70' }),
    });

    const result = await runAgent(h.deps, { task: 'list every item', caps: BUDGET, stepFailures: null, settle: false });

    expect(result.stepsUsed).toBe(6);
    expect(result.data).toBe('four of the items');
    expect(result.stopReason).toBe('task-complete');
    // Honest about the plan it did not finish.
    expect(result.status).toBe('partial');
  });

  test('a long run that never stated a plan is not declined for one', async () => {
    const h = harness({
      tree: page,
      // A different scroll each step: the same click twelve times on a page
      // that never moves is a loop the stall guard stops (`stallTolerance`).
      model: (_prompt, step): ModelChoice => (step < 12 ? { action: { type: 'scroll', dy: 100 * (step + 1) } } : { action: { type: 'done', summary: 'the answer' } }),
      // 0.70 a click: 8.40 of 10 (84%) after the twelve clicks.
      perform: () => ({ credits: '0.70' }),
    });

    const result = await runAgent(h.deps, { task: 'find the answer', caps: BUDGET, stepFailures: null, settle: false });

    expect(result.stepsUsed).toBe(13);
    expect(result.data).toBe('the answer');
  });

  test('before the pace line the plan door still declines, as it always has', async () => {
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice => (step < 12 ? { action: click } : { action: { type: 'done', summary: 'the answer' } }),
    });

    const result = await runAgent(h.deps, { task: 'find the answer', caps: BUDGET, stepFailures: null, settle: false });

    expect(result.stepsUsed).toBe(14);
    expect(result.steps[12]?.error ?? '').toContain('never stated a plan');
  });
});

describe('the step ceiling counts as spending the run', () => {
  /**
   * Production `run_…` (2026-10-01 12:26Z, default agent): answer
   * recorded by a final extract at step 3, then final extracts and `done`s
   * held for an open sub-goal, with failed steps between them (a click here), until
   * 12 of 12 steps ended it `capped` on 2.5 of 42 credits.
   */
  test('a run whose answer is recorded is not held into its step cap for an open sub-goal', async () => {
    const tasked = (step: number): ModelChoice => {
      if (step === 0) {
        return { action: { ...click, plan: [{ id: 'g1', goal: 'submit and read the name' }] } as unknown as Action };
      }
      const turn = (step - 1) % 3;
      if (turn === 0) {
        return { action: { type: 'extract', instruction: 'the name', final: true } };
      }
      if (turn === 1) {
        return { action: { type: 'done', summary: 'name: X' } };
      }
      return { action: click };
    };
    const h = harness({
      tree: page,
      model: (_prompt, step) => tasked(step),
      extract: (schema) =>
        'complete' in ((schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {})
          ? { data: { answer: 'name: X', complete: true, missing: '' } }
          : { data: 'name: X' },
    });

    const result = await runAgent(h.deps, {
      task: 'submit the form and read the name back',
      caps: { steps: 9, budget: '50.00', duration: '10m' },
      stepFailures: null,
      settle: false,
    });

    expect(result.cappedBy).toBeUndefined();
    expect(result.stopReason).toBe('task-complete');
    expect(result.data).toBe('name: X');
  });

  test('runShare takes the largest of credits, time and steps', () => {
    const limits = { budget: '42.00', durationMs: 300_000, maxSteps: 12 };
    expect(runShare({ credits: '2.5', elapsedMs: 50_000, steps: 10 }, limits)).toBeCloseTo(10 / 12);
    expect(runShare({ credits: '2.5', elapsedMs: 50_000, steps: 10 }, { ...limits, maxSteps: Infinity })).toBeCloseTo(50_000 / 300_000);
  });
});
