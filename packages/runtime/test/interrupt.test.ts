/**
 * Taking a running agent's page off it, and giving it back.
 *
 * Everything here asserts against `harness().browser` rather than against
 * `session.locked`, for the reason `lock.test.ts` states at length: `frozen` is
 * what `VirtualTimePolicy::kPause` is actually doing, and a refcount agreeing
 * with itself is exactly the bug. The claim this whole seam rests on is a
 * browser-side one — a frozen renderer DISCARDS input while the CDP command
 * reports success (`ShouldIgnoreWebInputEvents`,
 * `render_widget_host_impl.cc:1635`) — so what these tests defend is the
 * consequence: while a human holds the page, `browser.frozen` is false and the
 * loop performs nothing.
 */
import { describe, expect, test } from 'bun:test';

import type { Action } from '../src/actions';
import { LockLostError, PageHeldError, PageSession, runAgent } from '../src/loop';
import { catalogueTree, harness, refOf } from './support';

const page = catalogueTree();
const click: Action = { type: 'click', ref: refOf(page, 'Search') };
const done: Action = { type: 'done', summary: 'finished' };
const CAPS = { steps: 8, budget: '2.00', duration: '5m' };

/**
 * Drain the microtask queue, with no timer anywhere.
 *
 * A parked `withLock` is awaiting `#idle`, a promise nothing resolves until
 * control is released, so draining microtasks is not a guess at "long enough":
 * it is exhaustive. Every continuation that COULD run has run. A `setTimeout`
 * here would be slower and would prove strictly less.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

describe('PageSession.interrupt', () => {
  test('takes the freeze down, so the human it hands the page to is not typing into a paused renderer', async () => {
    const h = harness({ model: () => ({ action: done }) });
    const session = new PageSession(h.deps);

    let insideDepth: { frozen: boolean; driver: string | undefined } | undefined;
    await session.withLock(async () => {
      expect(h.browser.frozen).toBe(true);
      await session.interrupt('jish@aeonmind');
      insideDepth = { frozen: h.browser.frozen, driver: session.driver };
    });

    expect(insideDepth).toEqual({ frozen: false, driver: 'jish@aeonmind' });
  });

  test('abandons the step in flight: its next page touch throws, and it throws controlTaken', async () => {
    const h = harness({ model: () => ({ action: done }) });
    const session = new PageSession(h.deps);

    let thrown: unknown;
    await session.withLock(async (locked) => {
      await session.interrupt('jish@aeonmind');
      // The shape of a real step: `think` has already returned and `perform` is
      // the next thing that touches the page.
      thrown = await locked.perform(click).then(
        () => undefined,
        (error: unknown) => error,
      );
    });

    expect(thrown).toBeInstanceOf(LockLostError);
    expect((thrown as LockLostError).reason).toBe('controlTaken');
    // And nothing reached the page. This is the assertion the whole design is
    // for: a click the agent chose must not land on a page a human now holds.
    expect(h.performed).toEqual([]);
  });

  test('parks the next step until control is released, and then hands back a FRESH freeze', async () => {
    const h = harness({ model: () => ({ action: done }) });
    const session = new PageSession(h.deps);

    const hold = await session.interrupt('jish@aeonmind');

    let entered = false;
    const parked = session.withLock(async () => {
      entered = true;
    });
    await settle();
    expect(entered).toBe(false);
    expect(h.browser.frozen).toBe(false);

    await hold.release();
    await parked;

    expect(entered).toBe(true);
    // A NEW acquire, not a retake of the one the human's arrival ended. Handing
    // back a freeze over a document the loop never snapshotted is the TOCTOU
    // the lock exists to remove.
    expect(h.balance.acquired).toBe(1);
    expect(session.lostLock).toBeUndefined();
  });

  test('nothing is retaken while control is held: the page stays live for its whole duration', async () => {
    const h = harness({ model: () => ({ action: done }) });
    const session = new PageSession(h.deps);

    await session.withLock(async () => {
      await session.interrupt('jish@aeonmind');
    });

    // `withLock` returned. Its exit path must not have re-frozen the page under
    // the human, and must not have counted a release it did not make.
    expect(h.browser.frozen).toBe(false);
    expect(h.balance).toEqual({ acquired: 1, released: 1 });
    // The identity every count in `PageSession` is checked through.
    expect(session.acquires).toBe(session.releases + session.dropped);
  });

  test('a second driver is refused, and the first keeps the page', async () => {
    const h = harness({ model: () => ({ action: done }) });
    const session = new PageSession(h.deps);

    await session.interrupt('first@example.com');
    const refusal = await session.interrupt('second@example.com').then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(PageHeldError);
    expect((refusal as PageHeldError).heldBy).toBe('first@example.com');
    expect(session.driver).toBe('first@example.com');
    expect(h.browser.frozen).toBe(false);
  });

  test('control taken between steps releases nothing, and still parks the next one', async () => {
    const h = harness({ model: () => ({ action: done }) });
    const session = new PageSession(h.deps);

    // No lock frame open: the page is already live, exactly as it is in the gap
    // between two steps.
    const hold = await session.interrupt('jish@aeonmind');
    expect(h.balance.released).toBe(0);

    let entered = false;
    const parked = session.withLock(async () => {
      entered = true;
    });
    await settle();
    expect(entered).toBe(false);

    await hold.release();
    await parked;
    expect(entered).toBe(true);
  });

  test('release is idempotent, so a viewer that hangs up twice does not free the next step twice', async () => {
    const h = harness({ model: () => ({ action: done }) });
    const session = new PageSession(h.deps);

    const hold = await session.interrupt('jish@aeonmind');
    await hold.release();
    await hold.release();

    expect(session.driver).toBeUndefined();
    await session.withLock(async () => undefined);
    expect(h.balance).toEqual({ acquired: 1, released: 1 });
  });

  test('an unlock that fails unwinds completely rather than promising a page it did not free', async () => {
    const h = harness({
      model: () => ({ action: done }),
      unlock: () => {
        throw new Error('renderer went away');
      },
    });
    const session = new PageSession(h.deps);

    const failed = await session
      .withLock(async () => {
        await session.interrupt('jish@aeonmind');
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // An `AggregateError`, because `withLock`'s own exit path then tries the
    // same `unlock` and fails the same way — which is correct: the unwind must
    // not swallow the reason the step failed.
    const messages =
      failed instanceof AggregateError
        ? failed.errors.map((error: unknown) => (error as Error).message)
        : [(failed as Error).message];
    expect(messages.some((message) => /renderer went away/.test(message))).toBe(true);
    // The three observables of a complete unwind: nobody is driving, the next
    // step is not parked, and the freeze that never came down was not counted
    // as a release.
    expect(session.driver).toBeUndefined();
    expect(h.balance.released).toBe(0);
  });
});

describe('runAgent and a human interrupt', () => {
  test('a human taking control mid-step costs one recorded step and not the run', async () => {
    let session: PageSession | undefined;
    let taken = false;
    const h = harness({
      model: async (_prompt, step) => {
        // Taken during the model call, which is where 5 to 15 seconds of every
        // real step is spent and therefore where a viewer's click almost always
        // lands.
        if (step === 0 && session !== undefined && !taken) {
          taken = true;
          const hold = await session.interrupt('jish@aeonmind');
          // Released immediately so the run can finish inside the test; the
          // point being asserted is what the ABANDONED step cost.
          await hold.release();
        }
        return { action: step === 0 ? click : done };
      },
      perform: () => undefined,
      // The same tree the ref was read from, so the step reaches `perform` and
      // fails for the reason under test rather than on an unusable ref.
      tree: page,
    });

    const steps: { index: number; error?: string }[] = [];
    const result = await runAgent(h.deps, {
      task: 'take control on step 0',
      caps: CAPS,
      stepFailures: 0,
      onSession: (created) => {
        session = created;
      },
      onStep: (step) => steps.push({ index: step.index, ...(step.error === undefined ? {} : { error: step.error }) }),
    });

    // Recorded, with the reason, so a replay can show where the handover
    // interrupted the run.
    expect(steps[0]?.error).toMatch(/controlTaken/);
    // And the agent's chosen click never happened.
    expect(h.performed).toEqual([]);
    // The run carried on and finished, on a tolerance of zero.
    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('task-complete');
  });

});
