/**
 * A `wait` the page genuinely needs, and everything that must still reach the
 * run while it lasts (AgentClock, 2026-09-28).
 *
 * Production, n=7 runs told to "wait there for N minutes" (15:47-17:55Z): 3
 * ended `completed` before the time asked. The step header said `Elapsed
 * 96512ms`, which the model read as "8 minutes" and as "965 seconds", and a
 * ten-minute wait at ten seconds a step was ~60 model calls. The ceiling is now
 * a minute, which is only sound because every interrupt ends a wait at once and
 * a wait never runs past the caps — each proved here.
 */

import { describe, expect, test } from 'bun:test';

import type { Action } from '../src/actions';
import { MAX_WAIT_SECONDS } from '../src/actions';
import type { ModelChoice, PageSession } from '../src/loop';
import { humanDuration, runAgent } from '../src/loop';
import { VirtualClock, catalogueTree, harness, refOf, testPricing } from './support';

const page = catalogueTree();
const click: Action = { type: 'click', ref: refOf(page, 'Search') };
const done: Action = { type: 'done', summary: 'waited' };
const longWait: Action = { type: 'wait', seconds: MAX_WAIT_SECONDS };

/** A host that waits the way the worker does: until `seconds` pass or `signal` aborts. */
function honouring(onWait: (signal: AbortSignal | undefined) => void) {
  return (action: Action, signal?: AbortSignal): Promise<void> | undefined => {
    if (action.type !== 'wait') return undefined;
    onWait(signal);
    return new Promise<void>((resolve) => {
      if (signal === undefined) return; // never ends early: the red
      if (signal.aborted) resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  };
}

describe('the clock the model reads', () => {
  test('spans are written as a person writes them', () => {
    expect(humanDuration(0)).toBe('0 s');
    expect(humanDuration(59_400)).toBe('59 s');
    expect(humanDuration(60_000)).toBe('1 min');
    expect(humanDuration(96_512)).toBe('1 min 37 s');
    expect(humanDuration(1_800_000)).toBe('30 min');
    expect(humanDuration(3_600_000)).toBe('1 h');
    expect(humanDuration(3_725_000)).toBe('1 h 2 min');
  });

  test('the step header states elapsed time and the time limit in minutes and seconds, never milliseconds', async () => {
    const clock = new VirtualClock();
    const h = harness({
      tree: page,
      clock,
      model: (_prompt, step): ModelChoice => ({ action: step === 0 ? click : done }),
      perform: () => {
        clock.advance(96_000);
      },
    });

    await runAgent(h.deps, { task: 'wait', caps: { steps: 5, budget: '50.00', duration: '30m' }, stepFailures: null, settle: false });

    const second = h.prompts[1]?.text ?? '';
    expect(second).toMatch(/Elapsed 1 min 3\d s of 30 min\./);
    expect(second).not.toMatch(/Elapsed \d+ms/);
  });

  test('the converge notice reads its time limit the same way', async () => {
    const clock = new VirtualClock();
    const h = harness({
      tree: page,
      clock,
      model: (_prompt, step): ModelChoice => ({ action: step === 0 ? click : done }),
      perform: () => {
        clock.advance(100_000);
      },
    });

    await runAgent(h.deps, { task: 'wait', caps: { steps: 5, budget: '50.00', duration: '2m' }, stepFailures: null, settle: false });

    expect(h.prompts[1]?.text ?? '').toMatch(/of its time limit \(1 min 4\d s of 2 min\)/);
  });

  test("the grammar tells the model wait's range", async () => {
    const h = harness({ tree: page, model: (): ModelChoice => ({ action: done }) });
    await runAgent(h.deps, { task: 'wait', caps: { steps: 2, budget: '5.00', duration: '5m' }, stepFailures: null, settle: false });
    expect(h.prompts[0]?.text ?? '').toContain(`{"type":"wait","seconds":N} (let the page run N seconds, 1-${String(MAX_WAIT_SECONDS)};`);
  });
});

describe('a long wait never runs past the caps', () => {
  test('a wait is clamped to what the time limit has left', async () => {
    const clock = new VirtualClock();
    const h = harness({
      tree: page,
      clock,
      model: (_prompt, step): ModelChoice => ({ action: step === 0 ? click : step === 1 ? longWait : done }),
      perform: (action) => {
        if (action.type === 'click') clock.advance(290_000);
      },
    });

    await runAgent(h.deps, { task: 'wait', caps: { steps: 5, budget: '50.00', duration: '5m' }, stepFailures: null, settle: false });

    const waited = h.performed.find((action) => action.type === 'wait');
    expect(waited?.type === 'wait' ? waited.seconds : undefined).toBeLessThanOrEqual(10);
    expect(waited?.type === 'wait' ? waited.seconds : 0).toBeGreaterThan(9);
  });

  test('a wait is clamped to the time the budget has left to pay for', async () => {
    const clock = new VirtualClock();
    const h = harness({
      tree: page,
      clock,
      model: (): ModelChoice => ({ action: longWait }),
    });

    // One credit a minute of browser time: 0.25 credits funds 15 s.
    await runAgent(h.deps, { task: 'wait', caps: { steps: 5, budget: '0.25' }, stepFailures: null, settle: false, pricing: testPricing() });

    const waited = h.performed.find((action) => action.type === 'wait');
    expect(waited?.type === 'wait' ? waited.seconds : 99).toBeLessThanOrEqual(15);
  });
});

describe('everything that must reach a run ends a wait in flight', () => {
  test("the owner's cancel (and a drain, which aborts the same signal) ends the host's wait", async () => {
    const stop = new AbortController();
    let seen: AbortSignal | undefined;
    const h = harness({
      tree: page,
      model: (): ModelChoice => ({ action: longWait }),
      perform: honouring((signal) => {
        seen = signal;
        queueMicrotask(() => stop.abort());
      }),
    });

    const result = await runAgent(h.deps, {
      task: 'wait',
      caps: { steps: 5, budget: '50.00', duration: '30m' },
      stepFailures: null,
      settle: false,
      signal: stop.signal,
    });

    expect(result.stopReason).toBe('cancelled');
    expect(seen?.aborted).toBe(true);
  });

  test('a human taking the page ends the wait, and the run carries on after the hand-back', async () => {
    let session: PageSession | undefined;
    let seen: AbortSignal | undefined;
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice => ({ action: step === 0 ? longWait : done }),
      perform: honouring((signal) => {
        seen = signal;
        queueMicrotask(() => {
          void session?.interrupt('member:jish').then(async (hold) => {
            await hold.release();
          });
        });
      }),
    });

    const result = await runAgent(h.deps, {
      task: 'wait',
      caps: { steps: 5, budget: '50.00', duration: '30m' },
      stepFailures: null,
      settle: false,
      onSession: (created) => {
        session = created;
      },
    });

    expect(seen?.aborted).toBe(true);
    expect(result.stopReason).toBe('task-complete');
  });

  test('agent.control asking for a hold ends the wait, and the listener is gone once the wait is', async () => {
    const listeners = new Set<() => void>();
    let seen: AbortSignal | undefined;
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice => ({ action: step === 0 ? longWait : done }),
      perform: honouring((signal) => {
        seen = signal;
        queueMicrotask(() => {
          for (const listener of listeners) listener();
        });
      }),
    });

    const result = await runAgent(h.deps, {
      task: 'wait',
      caps: { steps: 5, budget: '50.00', duration: '30m' },
      stepFailures: null,
      settle: false,
      onHoldWanted: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });

    expect(seen?.aborted).toBe(true);
    expect(listeners.size).toBe(0);
    expect(result.stopReason).toBe('task-complete');
  });

  test('only a wait is handed a signal', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice => ({ action: step === 0 ? click : done }),
      perform: (_action, signal) => {
        signals.push(signal);
      },
    });
    await runAgent(h.deps, { task: 'click', caps: { steps: 3, budget: '5.00', duration: '5m' }, stepFailures: null, settle: false });
    expect(signals).toEqual([undefined]);
  });
});
