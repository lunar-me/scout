/**
 * The run's date in the prompt.
 *
 * Tasks are written against the day they run ("the last 2 days", "the
 * upcoming weekend"), and a model with no date in front of it guesses one.
 * Asserted: the date the run started on reaches the model, and stays the same
 * date for the whole run even when the wall clock crosses midnight, so the
 * per-run prefix does not change under it.
 */

import { describe, expect, test } from 'bun:test';

import type { ModelChoice } from '../src/loop';
import { runAgent } from '../src/loop';
import { harness, node, refOf, tree } from './support';

const CAPS = { steps: 10, budget: '50.00', duration: '10m' } as const;

describe("the run's date", () => {
  test('every prompt carries the UTC date the run started on, across midnight', async () => {
    const page = tree(node({ role: 'RootWebArea', name: 'news', children: [node({ role: 'button', name: 'Next' })] }));
    // One second before midnight UTC, then an hour per read.
    let now = Date.parse('2026-10-01T23:59:59Z');
    const texts: string[] = [];
    const h = harness({
      tree: page,
      wallClock: {
        now: () => {
          const at = now;
          now += 3_600_000;
          return at;
        },
      },
      model: (prompt, step): ModelChoice => {
        texts.push(prompt.text);
        return step >= 2
          ? { action: { type: 'done', summary: 'listed' } }
          : { action: { type: 'click', ref: refOf(page, 'Next') } };
      },
    });

    await runAgent(h.deps, { task: 'list the articles posted in the last 2 days', caps: CAPS, stepFailures: 5 });

    expect(texts.length).toBe(3);
    for (const text of texts) {
      expect(text).toContain('2026-10-01');
      expect(text).not.toContain('2026-10-02');
    }
  });
});
