/**
 * OC-284, the loop's half: every extraction is handed a fifth of what the
 * run's budget has LEFT, and a cut the model client reports is recorded on the
 * step a customer reads and told to the next prompt.
 */

import { describe, expect, test } from 'bun:test';

import { compareDecimal, type ExtractCut } from '@outcrawl/scout-core';

import type { ExtractBound, ModelChoice } from '../src/loop';
import { runAgent } from '../src/loop';
import { toWireStep } from '../src/result';
import { catalogueTree, harness, testPricing } from './support';

const CUT: ExtractCut = { pageChars: 371_204, sentChars: 90_871, pageLines: 3_006, sentLines: 702, ceilingTokens: 36_412 };

function script(...choices: readonly ModelChoice[]) {
  return (_prompt: unknown, step: number): ModelChoice => choices[step] ?? { action: { type: 'done' } };
}

describe('the extraction bound in the loop (OC-284)', () => {
  test("an extraction may spend a fifth of what the budget has left, and a cut lands on the step and the next prompt", async () => {
    const pricing = testPricing();
    const bounds: (ExtractBound | undefined)[] = [];
    // The run has already spent 0.17 provider USD on models: 17 credits at
    // the test tier, so 83 of 100 are left and a fifth of that is 16.6.
    const h = harness({
      tree: catalogueTree(),
      model: script({ action: { type: 'extract', instruction: 'the revision that added a picture' } }, { action: { type: 'done' } }),
      extract: (_schema, _instruction, _framing, bound) => {
        bounds.push(bound);
        return { data: 'found nothing on the part read', cut: CUT };
      },
    });

    const result = await runAgent(
      { ...h.deps, modelCostUsd: () => '0.17' },
      { task: 'when was the picture added', caps: { steps: 4, budget: '100', duration: '5m' }, stepFailures: null, pricing },
    );

    // A fifth of what is LEFT (83 less the seconds of browser time the step
    // has run), not of the 100 budgeted: between 16.5 and 16.6 credits' worth.
    const maxUsd = bounds[0]?.maxUsd ?? '';
    expect(compareDecimal(maxUsd, pricing.modelUsdFundedBy('16.6', pricing.model))).toBeLessThanOrEqual(0);
    expect(compareDecimal(maxUsd, pricing.modelUsdFundedBy('16.5', pricing.model))).toBeGreaterThan(0);
    expect(bounds).toHaveLength(1);
    // The customer's half: on the step record (`/events`) and the live frame.
    const extracting = result.steps.find((step) => step.action.type === 'extract')!;
    expect(extracting.extractCut).toEqual(CUT);
    expect(toWireStep(extracting).extractCut).toEqual(CUT);
    // And a step whose page was not cut carries nothing.
    expect(result.steps.filter((step) => step.extractCut !== undefined)).toHaveLength(1);
  });

  test('a step whose own model call spent the rest of the budget hands its extraction a zero allowance', async () => {
    const bounds: (ExtractBound | undefined)[] = [];
    let spentUsd = '0';
    const h = harness({
      tree: catalogueTree(),
      model: (_prompt, step) => {
        // The choosing call itself costs 0.06 USD, 6 credits at the test tier:
        // more than the whole 5-credit budget, so by the extraction nothing is
        // left.
        spentUsd = '0.06';
        return step === 0 ? { action: { type: 'extract', instruction: 'anything' } } : { action: { type: 'done' } };
      },
      extract: (_schema, _instruction, _framing, bound) => {
        bounds.push(bound);
        return { data: 'x' };
      },
    });

    await runAgent(
      { ...h.deps, modelCostUsd: () => spentUsd },
      { task: 'anything', caps: { steps: 4, budget: '5', duration: '5m' }, stepFailures: null, pricing: testPricing() },
    );

    expect(bounds).toEqual([{ maxUsd: '0' }]);
  });

  test('an identical cut read is not paid twice, but a targeted follow-up still runs', async () => {
    const reads: string[] = [];
    const h = harness({
      tree: catalogueTree(),
      model: script(
        { action: { type: 'extract', instruction: 'Find picture revisions' } },
        { action: { type: 'extract', instruction: 'Find picture revisions', final: true } },
        { action: { type: 'extract', instruction: 'Find the missing 2015 portrait revision' } },
        { action: { type: 'done' } },
      ),
      extract: (_schema, instruction) => {
        reads.push(instruction ?? '');
        return { data: { answer: instruction }, cut: CUT, credits: '1' };
      },
    });
    const result = await runAgent(h.deps, {
      task: 'Find picture revisions', caps: { steps: 6, budget: '100', duration: '5m' }, stepFailures: null,
      schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
    });
    expect(reads).toEqual(['Find picture revisions', 'Find the missing 2015 portrait revision']);
    expect(result.steps[1]?.error).toBeDefined();
    expect(result.steps.filter((step) => step.extractCut !== undefined)).toHaveLength(2);
    expect(result.data).toEqual({ answer: 'Find the missing 2015 portrait revision' });
  });

  test('a changed page order permits the same targeted read again', async () => {
    const first = catalogueTree();
    const changed = { ...first, root: { ...first.root, children: (first.root.children ?? []).map((child) => ({ ...child, children: [...(child.children ?? [])].reverse() })) } };
    let reads = 0;
    const h = harness({
      snapshot: () => reads === 0 ? first : changed,
      model: script(
        { action: { type: 'extract', instruction: 'Read the first item' } },
        { action: { type: 'extract', instruction: 'Read the first item' } },
        { action: { type: 'done' } },
      ),
      extract: () => ({ data: { answer: ++reads }, cut: CUT }),
    });
    const result = await runAgent(h.deps, {
      task: 'Read the first item after sorting', caps: { steps: 5, budget: '100', duration: '5m' }, stepFailures: null,
      schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
    });
    expect(reads).toBe(2);
    expect(result.data).toEqual({ answer: 2 });
  });

  test('a capped run retains earlier partial observations when narrower reads return empty or negative results', async () => {
    const observations: readonly unknown[] = ['Receipts A-17 and B-28', [], 'No receipts in this excerpt'];
    let reads = 0;
    const h = harness({
      tree: catalogueTree(),
      model: (_prompt, step) => ({ action: { type: 'extract', instruction: `Read receipt group ${String(step)}` } }),
      extract: () => ({ data: observations[reads++], cut: CUT }),
    });
    const result = await runAgent(h.deps, {
      task: 'List the receipts', caps: { steps: 3, budget: '100', duration: '5m' }, stepFailures: null,
    });
    expect(result.status).toBe('capped');
    expect(result.data).toContain('A-17');
    expect(result.data).toContain('B-28');
    expect(result.data).toContain('No receipts in this excerpt');
    // The contradictory outputs remain observations, not a reconciled answer.
    expect(result.stopReason).toBe('max-steps');
  });

  test('a final read cut under the word it asks about is held, not taken as a complete "none"', async () => {
    // run_… (2026-10-02): 435 of 236,860 characters, no "Aquinas" row
    // sent, answered "no revisions found" as complete, and the run ended on it.
    const run = (wordsUnsent: readonly string[]) => {
      const h = harness({
        tree: catalogueTree(),
        model: script(
          { action: { type: 'extract', instruction: 'Every revision whose summary mentions Aquinas', final: true } },
          { action: { type: 'done', summary: 'Could not read every Aquinas revision on the cut page' } },
        ),
        extract: () => ({ data: { answer: 'No revisions found', complete: true, missing: '' }, cut: { ...CUT, wordsUnsent } }),
      });
      return runAgent(h.deps, { task: 'List revisions mentioning Aquinas', caps: { steps: 4, budget: '100', duration: '5m' }, stepFailures: null });
    };

    const held = await run(['aquinas']);
    expect(held.steps[0]?.held).toBe('incomplete-final');
    expect(held.data).not.toBe('No revisions found');
    // A cut that only dropped lines with a word the read did not ask about ends the run as before.
    const kept = await run(['portrait']);
    expect(kept.steps[0]?.held).toBeUndefined();
    expect(kept.data).toBe('No revisions found');
  });

  test('a final whose answer leaves out the recorded observations is asked about once, not taken as the answer', async () => {
    // run_… / run_… (2026-10-02): the first read held all five
    // rows as an incomplete final; a later final about part of the task said
    // "none" as complete, and the run ended on it.
    const rows = 'Reviewed by Alder on 3 May 2019; Reviewed by Birch on 9 June 2020';
    const run = (second: string) => {
      const reads = [{ answer: rows, complete: false, missing: 'the page was cut' }, { answer: second, complete: true, missing: '' }];
      let read = 0;
      const h = harness({
        tree: catalogueTree(),
        model: script(
          { action: { type: 'extract', instruction: 'Every review with its reviewer and date', final: true } },
          { action: { type: 'extract', instruction: 'Reviews mentioning a refund', final: true } },
          { action: { type: 'done', summary: `${rows}. No review mentions a refund.` } },
        ),
        extract: () => ({ data: reads[read++] }),
      });
      return runAgent(h.deps, { task: 'List every review, and any that mention a refund', caps: { steps: 5, budget: '100', duration: '5m' }, stepFailures: null });
    };

    const dropped = await run('No review mentions a refund');
    expect(dropped.steps[1]?.held).toBe('dropped-evidence');
    expect(dropped.status).toBe('completed');
    expect(dropped.data).toContain('Birch');
    // A final that states what was recorded ends the run on it, as before.
    const kept = await run(`${rows}; none mention a refund`);
    expect(kept.steps[1]?.held).toBeUndefined();
    expect(kept.steps).toHaveLength(2);
    expect(kept.data).toContain('Birch');
  });
});
