/**
 * Lock discipline around a captcha solve, and around a lock the browser took
 * away without being asked.
 *
 * Two things are being defended here and they pull in opposite directions.
 * A frozen page cannot run a vendor challenge script, so an in-page solve needs
 * the freeze down. And the freeze can end without this process asking — the
 * browser releases on `timeout`, `navigated`, `rendererGone` and `sessionEnded`
 * — in which case a refcount that still says "locked" is worse than no lock at
 * all, because the run looks identical to a correct one.
 *
 * So `harness().browser` is the browser's own view rather than the session's:
 * `frozen` is what `VirtualTimePolicy::kPause` is actually doing, and
 * `liveTouches` counts page operations that reached an unfrozen page. Every
 * test below asserts against that, not against `session.locked`, because
 * `session.locked` agreeing with itself is exactly the bug.
 *
 * Everything here runs against an injected fake, which is the right shape for
 * refcount arithmetic and the wrong shape for any claim about what the browser
 * does. The browser-side claims these tests are built on are measured
 * separately by `scripts/probe-lock-release.ts` against the real binary, and
 * where a test's reasoning depends on one, it cites it. Two of them were
 * written here as confident comments and turned out false: that `navigated`
 * fires only on a cross-process navigation (it fires on every cross-document
 * one), and, by omission, that a released page returns to normal speed (until
 * `inspector_outcrawl_agent.cc` was fixed it ran ~1400x, which would have made
 * every in-page solve fail as a slow provider).
 */
import { describe, expect, test } from 'bun:test';

import type { Action } from '../src/actions';
import type { AgentInterrupt, ChallengeResolution, ChallengeSolving, LockReleaseReason, ToolPort } from '../src/loop';
import { LOOK_TOOL } from '../src/look';
import {
  LockLostError,
  LockNotHeldError,
  PageFrozenError,
  PageSession,
  SolveInProgressError,
  runAgent,
} from '../src/loop';
import { catalogueTree, harness, refOf } from './support';

const page = catalogueTree();
const click: Action = { type: 'click', ref: refOf(page, 'Search') };
const done: Action = { type: 'done', summary: 'finished' };
const CAPS = { steps: 8, budget: '2.00', duration: '5m' };

function inpage(challengeId = 'c1'): ChallengeSolving {
  return {
    t: 120,
    challengeId,
    detector: 'recaptcha',
    kind: 'inpage',
    url: 'https://example.com/login',
    frameId: 'F1',
    sitekey: '6Le-wvk',
  };
}

function navigation(challengeId = 'n1'): ChallengeSolving {
  return {
    t: 40,
    challengeId,
    detector: 'cloudflare',
    kind: 'navigation',
    url: 'https://example.com/',
    frameId: 'F1',
  };
}

const SOLVED: ChallengeResolution = { solved: true, elapsedMs: 4200 };
const EXHAUSTED: ChallengeResolution = { solved: false, reason: 'exhausted', elapsedMs: 31000 };

/**
 * A solve the test holds open by hand.
 *
 * `entered` resolves when the provider was really called and `open` releases
 * it, so a concurrency assertion awaits a signal the code emits rather than
 * guessing how many microtasks deep an await chain happens to be. Counting
 * ticks against an implementation detail is how a concurrency test starts
 * passing for the wrong reason.
 */
function gate(resolution: ChallengeResolution = SOLVED) {
  const entered = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<ChallengeResolution>();
  return {
    entered: entered.promise,
    open(): void {
      opened.resolve(resolution);
    },
    async run(): Promise<ChallengeResolution> {
      entered.resolve();
      return opened.promise;
    },
  };
}

/* ------------------------------------------------------------------ *
 * A solve cannot start while the page is frozen
 * ------------------------------------------------------------------ */

describe('an in-page solve cannot start while the page is frozen', () => {
  test('the bare provider call is refused, and refused rather than hung', async () => {
    // The refusal is the point. `VirtualTimePolicy::kPause` would stop the
    // vendor's challenge script too, so a solve started here makes no progress
    // and the operation dies on the lock's own deadline instead — 30 s by
    // default, clamped to [1000, 300000] and impossible to disable. That
    // failure is indistinguishable from a slow provider, which is why it is a
    // hard error and not a wait.
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      solveChallenge: () => SOLVED,
    });
    const session = new PageSession(h.deps);

    const refusal = await session.withLock(async () => {
      return session.solve(inpage()).then(
        () => undefined,
        (error: unknown) => error,
      );
    });

    expect(refusal).toBeInstanceOf(PageFrozenError);
    expect((refusal as PageFrozenError).operation).toBe('solve(recaptcha)');
    expect((refusal as PageFrozenError).challengeId).toBe('c1');
    // The provider was never asked. A timeout would have asked and waited.
    expect(h.events).not.toContain('solve');
    expect(h.balance.acquired).toBe(1);
    expect(h.balance.released).toBe(1);
  });

  test('a navigation-kind solve is NOT refused, because nothing in it touches the page', async () => {
    // Grounded in the browser half rather than in symmetry: the challenge is
    // held as a `content::NavigationThrottle` DEFER at `WillProcessResponse`,
    // so no document has committed and no page script runs during the hold.
    // Refusing this would be superstition.
    let frozenDuringSolve: boolean | undefined;
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      solveChallenge: () => {
        frozenDuringSolve = h.browser.frozen;
        return SOLVED;
      },
    });
    const session = new PageSession(h.deps);

    const resolution = await session.withLock(async () => session.solve(navigation()));

    expect(resolution).toEqual(SOLVED);
    expect(frozenDuringSolve).toBe(true);
  });

  test('the same challenge through withSolve succeeds, on a page that is really live', async () => {
    let frozenDuringSolve: boolean | undefined;
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      solveChallenge: () => {
        frozenDuringSolve = h.browser.frozen;
        return SOLVED;
      },
    });
    const session = new PageSession(h.deps);

    const resolution = await session.withLock(async () => session.withSolve(inpage()));

    expect(resolution).toEqual(SOLVED);
    expect(frozenDuringSolve).toBe(false);
    expect(h.events).toEqual(['lock', 'unlock', 'solve', 'lock', 'unlock']);
  });

  test('a solve arriving DURING the lock round trip still finds a frozen page', async () => {
    // The window nobody had looked at, and the one every other test in this file
    // skips over by awaiting `withLock` before doing anything.
    //
    // `deps.lock()` freezes the page the moment the browser handles it, but the
    // refcount cannot rise until the promise resolves - a whole CDP round trip
    // later. Read naively, `locked` says false for that whole window about a
    // page that is already frozen, so a solve arriving in it was neither refused
    // nor released: it ran against `VirtualTimePolicy::kPause` and would have
    // died on the challenge deadline, reported as a slow provider.
    //
    // Reachable in production, not contrived: the step that has just navigated
    // is exactly what produces a `challengeSolving`, and the next step's `lock`
    // is in flight when it arrives. Found by the wiring test in
    // `packages/agent/test/challenge-lock.test.ts`, which emits the event
    // without yielding first.
    let frozenDuringSolve: boolean | undefined;
    const opened = Promise.withResolvers<void>();
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      // Holds the `lock` command open, standing in for the round trip.
      lock: () => opened.promise,
      solveChallenge: () => {
        frozenDuringSolve = h.browser.frozen;
        return SOLVED;
      },
    });
    const session = new PageSession(h.deps);

    const held = Promise.withResolvers<void>();
    const step = session.withLock(async () => held.promise);
    // No await between the two: the solve is dispatched while the acquire is
    // still outstanding, which is the whole point.
    const solving = session.withSolve(inpage());
    opened.resolve();

    expect(await solving).toEqual(SOLVED);
    expect(frozenDuringSolve).toBe(false);
    // The freeze went down for the solve and came back for the caller's step,
    // rather than the solve running under a freeze nobody had counted.
    expect(h.events).toEqual(['lock', 'unlock', 'solve', 'lock']);
    expect(session.locked).toBe(true);

    held.resolve();
    await step;
    expect(session.acquires).toBe(session.releases + session.dropped);
  });
});

/* ------------------------------------------------------------------ *
 * Release, solve, retake
 * ------------------------------------------------------------------ */

describe('release-solve-retake respects the refcount rather than working around it', () => {
  test('the caller keeps its frame and gets the freeze back', async () => {
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      solveChallenge: () => SOLVED,
    });
    const session = new PageSession(h.deps);

    await session.withLock(async (locked) => {
      await locked.perform(click);
      await session.withSolve(inpage());
      expect(session.locked).toBe(true);
      expect(h.browser.frozen).toBe(true);
      // The frame never lapsed, so this is still the caller's own lock.
      await locked.perform(click);
    });

    expect(h.events).toEqual([
      'lock',
      'perform',
      'unlock',
      'solve',
      'lock',
      'perform',
      'unlock',
    ]);
    // Both performs landed on a frozen page. That is the guarantee.
    expect(h.browser.liveTouches).toBe(0);
    expect(session.acquires).toBe(2);
    expect(session.releases).toBe(2);
    expect(session.dropped).toBe(0);
    expect(session.lostLock).toBeUndefined();
  });

  test('the freeze comes back after a solve that FAILED', async () => {
    // Asserting on the input that fails, not only the one that passes: a step
    // continuing past an exhausted solve is entitled to the same guarantee it
    // started with, and dropping the retake here would be invisible until a
    // customer's action landed on a live page.
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      solveChallenge: () => EXHAUSTED,
    });
    const session = new PageSession(h.deps);

    await session.withLock(async (locked) => {
      const resolution = await session.withSolve(inpage());
      expect(resolution).toEqual(EXHAUSTED);
      expect(h.browser.frozen).toBe(true);
      await locked.perform(click);
    });

    expect(h.browser.liveTouches).toBe(0);
    expect(session.acquires).toBe(2);
    expect(session.releases).toBe(2);
  });

  test('the freeze comes back after the provider throws, and the throw is not swallowed', async () => {
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      solveChallenge: () => {
        throw new Error('provider 502');
      },
    });
    const session = new PageSession(h.deps);

    await session.withLock(async () => {
      await expect(session.withSolve(inpage())).rejects.toThrow('provider 502');
      expect(h.browser.frozen).toBe(true);
    });

    expect(session.acquires).toBe(2);
    expect(session.releases).toBe(2);
  });

  test('a nested withLock during a solve is refused: it would freeze the challenge script', async () => {
    let nested: unknown;
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      solveChallenge: async () => {
        nested = await session.withLock(async () => undefined).then(
          () => undefined,
          (error: unknown) => error,
        );
        return SOLVED;
      },
    });
    const session = new PageSession(h.deps);

    await session.withLock(async () => session.withSolve(inpage()));

    expect(nested).toBeInstanceOf(SolveInProgressError);
    expect((nested as SolveInProgressError).challengeIds).toEqual(['c1']);
    // No second freeze was taken while the challenge script was running.
    expect(h.events.filter((event) => event === 'lock')).toHaveLength(2);
  });

  test('a page touch during a solve is refused: the frame is open but the freeze is down', async () => {
    let touched: unknown;
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      solveChallenge: async () => {
        touched = await session.perform(click).then(
          () => undefined,
          (error: unknown) => error,
        );
        return SOLVED;
      },
    });
    const session = new PageSession(h.deps);

    await session.withLock(async () => session.withSolve(inpage()));

    expect(touched).toBeInstanceOf(SolveInProgressError);
    expect((touched as SolveInProgressError).operation).toBe('perform(click)');
    expect(h.browser.liveTouches).toBe(0);
  });

  test('a page touch with no frame at all is still LockNotHeld, not SolveInProgress', async () => {
    const h = harness({ tree: page, model: () => ({ action: done }) });
    const session = new PageSession(h.deps);
    await expect(session.perform(click)).rejects.toThrow(LockNotHeldError);
  });

  test('concurrent in-page solves share one release, and the last one out retakes', async () => {
    // Keyed by challenge id rather than by arrival order: the first `withSolve`
    // is still in its `unlock` round trip when the second reaches the provider,
    // so a queue hands the gates out backwards.
    const one = gate();
    const two = gate();
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      solveChallenge: async (challenge) => (challenge.challengeId === 'c1' ? one : two).run(),
    });
    const session = new PageSession(h.deps);

    await session.withLock(async (locked) => {
      const solvingFirst = session.withSolve(inpage('c1'));
      const solvingSecond = session.withSolve(inpage('c2'));
      await Promise.all([one.entered, two.entered]);

      expect(session.solving).toEqual(['c1', 'c2']);
      expect(h.browser.frozen).toBe(false);

      // First out is not last out. Retaking here would re-freeze the page under
      // a challenge script that is still running.
      one.open();
      await solvingFirst;
      expect(h.browser.frozen).toBe(false);

      two.open();
      await solvingSecond;
      expect(h.browser.frozen).toBe(true);

      await locked.perform(click);
    });

    expect(h.events).toEqual(['lock', 'unlock', 'solve', 'solve', 'lock', 'perform', 'unlock']);
    expect(h.browser.liveTouches).toBe(0);
    expect(session.acquires).toBe(2);
    expect(session.releases).toBe(2);
  });

  test('a top-level withLock started during a solve waits instead of freezing the page under it', async () => {
    const held = gate();
    const order: string[] = [];
    let solveActive = false;
    let frozenDuringSolve = false;
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      // The discriminating assertion, and it does not depend on scheduling: if
      // `withLock` freezes rather than waiting, this fires while the solve is
      // still outstanding.
      lock: () => {
        if (solveActive) {
          frozenDuringSolve = true;
        }
      },
      solveChallenge: async () => {
        solveActive = true;
        const resolution = await held.run();
        order.push('solve done');
        solveActive = false;
        return resolution;
      },
    });
    const session = new PageSession(h.deps);

    // No frame open: an in-page challenge solved concurrently with the loop,
    // which is the weaker half of the invisibility story in the spec.
    const solving = session.withSolve(inpage());
    await held.entered;
    expect(h.browser.frozen).toBe(false);

    const stepping = session.withLock(async (locked) => {
      order.push('step started');
      await locked.perform(click);
    });

    held.open();
    await Promise.all([solving, stepping]);

    // The step was delayed, not failed. A delay is invisible to the caller,
    // which is the requirement; a failed step is not.
    expect(frozenDuringSolve).toBe(false);
    expect(order).toEqual(['solve done', 'step started']);
    expect(h.browser.liveTouches).toBe(0);
  });

  test('no solver configured resolves unsupported without taking the freeze down', async () => {
    const h = harness({ tree: page, model: () => ({ action: done }) });
    const session = new PageSession(h.deps);

    await session.withLock(async () => {
      expect(await session.withSolve(inpage())).toEqual({ solved: false, reason: 'unsupported' });
      expect(h.browser.frozen).toBe(true);
    });

    expect(h.events).toEqual(['lock', 'unlock']);
  });

  test('a failed retake is recorded rather than left as a frame believing in a freeze', async () => {
    let locks = 0;
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      solveChallenge: () => SOLVED,
      lock: () => {
        locks += 1;
        if (locks === 2) {
          throw new Error('renderer would not pause');
        }
      },
    });
    const session = new PageSession(h.deps);

    let touched: unknown;
    await expect(
      session.withLock(async () => {
        await session.withSolve(inpage());
        touched = await session.perform(click).then(
          () => undefined,
          (error: unknown) => error,
        );
      }),
    ).rejects.toThrow('renderer would not pause');

    expect(session.lostLock).toBe('retakeFailed');
    expect(touched).toBeUndefined();
    // One acquire, one release, and the acquire that failed is not counted.
    expect(session.acquires).toBe(1);
    expect(session.releases).toBe(1);
    expect(session.dropped).toBe(0);
    // No unlock against a page that was never frozen again.
    expect(h.events).toEqual(['lock', 'unlock', 'solve', 'lock']);
  });

  test('a release that FAILED leaves no retake owed, and no freeze unaccounted for', async () => {
    // The mirror of the test above, and the one the implementation did not
    // have. `#suspendReleased` is set before the `unlock` is awaited - it has
    // to be, so a concurrent solve arriving during the round trip does not
    // release a second time - which means an `unlock` that throws leaves a
    // retake owed for a freeze that was never taken down. The retake then
    // acquires a second freeze against one release, and
    // `acquires === releases + dropped` stops being true, which is the
    // invariant every other accounting assertion here rests on.
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      solveChallenge: () => SOLVED,
      unlock: () => {
        throw new Error('renderer would not resume');
      },
    });
    const session = new PageSession(h.deps);

    let touched: unknown;
    await expect(
      session.withLock(async () => {
        await session.withSolve(inpage()).catch(() => undefined);
        touched = await session.perform(click).then(
          () => undefined,
          (error: unknown) => error,
        );
        throw new Error('step gave up');
      }),
    ).rejects.toThrow('step gave up');

    // The freeze never came down, so the provider was never called: a solve on
    // a frozen page is the deadlock this file exists to refuse.
    expect(h.events).toEqual(['lock', 'unlock']);
    expect(session.lostLock).toBe('releaseFailed');
    expect(touched).toBeInstanceOf(LockLostError);
    expect(session.acquires).toBe(1);
    expect(session.releases).toBe(0);
    expect(session.dropped).toBe(1);
    expect(session.acquires).toBe(session.releases + session.dropped);
  });
});

/* ------------------------------------------------------------------ *
 * The browser releasing the lock on its own
 * ------------------------------------------------------------------ */

const UNILATERAL: readonly LockReleaseReason[] = [
  'timeout',
  'navigated',
  'rendererGone',
  'sessionEnded',
];

describe('a lock the browser released on its own is not a lock', () => {
  for (const reason of UNILATERAL) {
    test(`${reason}: the page is not touched live, and the frame does not unlock a lock that is gone`, async () => {
      const h = harness({ tree: page, model: () => ({ action: done }) });
      const session = new PageSession(h.deps);

      let touched: unknown;
      await session.withLock(async (locked) => {
        session.noteLockReleased(h.release(reason));

        // The refcount is unchanged and still says depth 1. `locked` answers
        // for the page instead, which is the whole difference.
        expect(session.locked).toBe(false);
        expect(session.lostLock).toBe(reason);
        expect(session.dropped).toBe(1);

        touched = await locked.perform(click).then(
          () => undefined,
          (error: unknown) => error,
        );
      });

      expect(touched).toBeInstanceOf(LockLostError);
      expect((touched as LockLostError).reason).toBe(reason);
      expect((touched as LockLostError).operation).toBe('perform(click)');
      // Nothing reached a live page, and `unlock` was not sent to a target that
      // may no longer exist.
      expect(h.browser.liveTouches).toBe(0);
      expect(h.events).toEqual(['lock', `released:${reason}`]);
      expect(session.acquires).toBe(1);
      expect(session.releases).toBe(0);
      // acquires === releases + dropped, on every path.
      expect(session.acquires).toBe(session.releases + session.dropped);
    });

    test(`${reason}: a nested withLock is refused rather than nesting onto a freeze that is gone`, async () => {
      // This is the pre-existing bug named in its own right. The refcount sees
      // depth 1, skips the acquire, and hands the inner block a page that is
      // running. Nothing about the run looks wrong.
      const h = harness({ tree: page, model: () => ({ action: done }) });
      const session = new PageSession(h.deps);

      let nested: unknown;
      await session.withLock(async () => {
        session.noteLockReleased(h.release(reason));
        nested = await session
          .withLock(async (inner) => inner.perform(click))
          .then(
            () => undefined,
            (error: unknown) => error,
          );
      });

      expect(nested).toBeInstanceOf(LockLostError);
      expect((nested as LockLostError).operation).toBe('lock');
      expect((nested as LockLostError).reason).toBe(reason);
      expect(h.browser.liveTouches).toBe(0);
      expect(h.events.filter((event) => event === 'lock')).toHaveLength(1);
    });

    test(`${reason}: the next top-level withLock takes a fresh freeze`, async () => {
      const h = harness({ tree: page, model: () => ({ action: done }) });
      const session = new PageSession(h.deps);

      await session.withLock(async () => {
        session.noteLockReleased(h.release(reason));
      });

      await session.withLock(async (locked) => {
        expect(session.lostLock).toBeUndefined();
        expect(session.locked).toBe(true);
        await locked.perform(click);
      });

      expect(h.browser.liveTouches).toBe(0);
      expect(session.acquires).toBe(2);
      expect(session.releases).toBe(1);
      expect(session.dropped).toBe(1);
      expect(session.acquires).toBe(session.releases + session.dropped);
    });
  }

  test('explicit at depth 0 is our own unlock echoing back, not a loss', async () => {
    const h = harness({ tree: page, model: () => ({ action: done }) });
    const session = new PageSession(h.deps);

    await session.withLock(async (locked) => locked.perform(click));
    session.noteLockReleased('explicit');

    expect(session.lostLock).toBeUndefined();
    expect(session.dropped).toBe(0);
    expect(session.acquires).toBe(1);
    expect(session.releases).toBe(1);
  });

  test('explicit under an open frame is an out-of-band unlock, and is a loss', async () => {
    const h = harness({ tree: page, model: () => ({ action: done }) });
    const session = new PageSession(h.deps);

    await session.withLock(async () => {
      session.noteLockReleased(h.release('explicit'));
      expect(session.locked).toBe(false);
      expect(session.lostLock).toBe('explicit');
    });
  });

  test('explicit during a solve is the release the solve itself performed', async () => {
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      solveChallenge: () => {
        // The browser reports our own `unlock` back to us. Treating that as a
        // loss would cancel every retake.
        session.noteLockReleased('explicit');
        return SOLVED;
      },
    });
    const session = new PageSession(h.deps);

    await session.withLock(async (locked) => {
      await session.withSolve(inpage());
      expect(session.lostLock).toBeUndefined();
      expect(h.browser.frozen).toBe(true);
      await locked.perform(click);
    });

    expect(h.browser.liveTouches).toBe(0);
  });

  test('a genuine release during a solve cancels the retake', async () => {
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      solveChallenge: () => {
        session.noteLockReleased('rendererGone');
        return SOLVED;
      },
    });
    const session = new PageSession(h.deps);

    await session.withLock(async () => {
      await session.withSolve(inpage());
      expect(session.lostLock).toBe('rendererGone');
    });

    // Never re-frozen, and no unlock sent to a renderer that is gone. The
    // release happened while the page was already live for the solve, so there
    // was no freeze to account for.
    expect(h.events).toEqual(['lock', 'unlock', 'solve']);
    expect(session.acquires).toBe(1);
    expect(session.releases).toBe(1);
    expect(session.dropped).toBe(0);
  });

  test('navigated during an in-page solve cancels the retake, which is the real shape of it', async () => {
    // The case the `navigation` kind does NOT cover, and the one that actually
    // happens. An in-page reCAPTCHA solve ends with a token written into the
    // widget's own response field - named, not constant: two widgets on a page
    // carry ids `g-recaptcha-response` and `g-recaptcha-response-1` under one
    // shared name, which is why the selector is host-supplied and nothing here
    // hard-codes it. The page's own `data-callback` then submits the form,
    // and that is a cross-document navigation. Measured
    // (`scripts/probe-lock-release.ts --only navigation`), every cross-document
    // navigation emits `lockReleased{navigated}` - same-origin included, which
    // an earlier comment in loop.ts denied - so this event arrives on the
    // ordinary success path of the ordinary challenge.
    //
    // Retaking here would freeze a document the caller has never seen while
    // every reference it read names a node in a document that is gone. The
    // measurement makes that worse than it sounds: after a release the page is
    // not merely live, it is running virtual time at roughly 1400x
    // (`--only burst`: 80158 ticks of a 5 ms interval per 300 ms, and Date.now
    // advancing 428260 ms in 300 ms), so a document reached this way has raced
    // an unbounded distance from the tree the refs came from.
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      solveChallenge: () => {
        session.noteLockReleased(h.release('navigated'));
        return SOLVED;
      },
    });
    const session = new PageSession(h.deps);

    let touched: unknown;
    await session.withLock(async () => {
      expect(await session.withSolve(inpage())).toEqual(SOLVED);
      touched = await session.perform(click).then(
        () => undefined,
        (error: unknown) => error,
      );
    });

    // Solved, and the solve's own result is still returned: the token landed,
    // and losing the lock is not the same as failing the challenge.
    expect(session.lostLock).toBe('navigated');
    expect(touched).toBeInstanceOf(LockLostError);
    expect((touched as LockLostError).reason).toBe('navigated');
    expect(h.events).toEqual(['lock', 'unlock', 'solve', 'released:navigated']);
    expect(h.browser.liveTouches).toBe(0);
    expect(session.acquires).toBe(session.releases + session.dropped);
  });

  test('a release with no frame open is a no-op and does not poison a later frame', async () => {
    const h = harness({ tree: page, model: () => ({ action: done }) });
    const session = new PageSession(h.deps);

    session.noteLockReleased('timeout');
    expect(session.lostLock).toBeUndefined();
    expect(session.dropped).toBe(0);

    await session.withLock(async (locked) => locked.perform(click));
    expect(h.browser.liveTouches).toBe(0);
    expect(session.acquires).toBe(1);
    expect(session.releases).toBe(1);
  });

  test('the first cause wins, so a second release does not double-count', async () => {
    const h = harness({ tree: page, model: () => ({ action: done }) });
    const session = new PageSession(h.deps);

    await session.withLock(async () => {
      session.noteLockReleased(h.release('timeout'));
      session.noteLockReleased('sessionEnded');
      expect(session.lostLock).toBe('timeout');
      expect(session.dropped).toBe(1);
    });
  });
});

/* ------------------------------------------------------------------ *
 * navigated, which is the sharpest case
 * ------------------------------------------------------------------ */

describe('a navigation-kind solve is not followed by a retake', () => {
  test('the freeze is never released and never retaken; the lock is marked lost', async () => {
    let frozenDuringSolve: boolean | undefined;
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      solveChallenge: () => {
        frozenDuringSolve = h.browser.frozen;
        return SOLVED;
      },
    });
    const session = new PageSession(h.deps);

    let touched: unknown;
    await session.withLock(async (locked) => {
      const resolution = await session.withSolve(navigation());
      expect(resolution).toEqual(SOLVED);
      // Re-locking here would bind the caller to a document it has never seen,
      // with every backendNodeId it read naming a node in a dead one.
      expect(session.lostLock).toBe('navigated');
      expect(session.locked).toBe(false);

      touched = await locked.perform(click).then(
        () => undefined,
        (error: unknown) => error,
      );
    });

    expect(frozenDuringSolve).toBe(true);
    expect(touched).toBeInstanceOf(LockLostError);
    expect((touched as LockLostError).reason).toBe('navigated');
    expect(h.events).toEqual(['lock', 'solve']);
    expect(h.browser.liveTouches).toBe(0);
    expect(session.acquires).toBe(1);
    expect(session.releases).toBe(0);
    expect(session.dropped).toBe(1);
  });

  test('a navigation-kind solve that FAILED marks the lock lost too', async () => {
    // `abandonChallenge` resumes the held navigation and it commits, so the
    // document the caller froze is gone on the failure path exactly as on the
    // success path — a `NavigationThrottle` can only resume, never substitute a
    // response, so neither path hands back the document the caller had.
    // Branching on the resolution here would leave a freeze bound to a document
    // that is gone.
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      solveChallenge: () => EXHAUSTED,
    });
    const session = new PageSession(h.deps);

    await session.withLock(async () => {
      expect(await session.withSolve(navigation())).toEqual(EXHAUSTED);
      expect(session.lostLock).toBe('navigated');
    });

    expect(session.dropped).toBe(1);
    expect(session.releases).toBe(0);
  });

  test('a navigation-kind solve that threw marks the lock lost too', async () => {
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      solveChallenge: () => {
        throw new Error('provider unreachable');
      },
    });
    const session = new PageSession(h.deps);

    await session.withLock(async () => {
      await expect(session.withSolve(navigation())).rejects.toThrow('provider unreachable');
      expect(session.lostLock).toBe('navigated');
    });
  });

  test('a lockReleased{navigated} that does arrive is not counted twice', async () => {
    // Measured, not reasoned: `scripts/probe-lock-release.ts --only navigation`
    // against the built binary reports `navigated` for a same-origin
    // cross-document navigation AND for a cross-site one, and nothing at all
    // for a same-document (hash) navigation, which keeps its freeze. So the
    // event is the common case rather than the rare one and the mark keyed on
    // `kind` has to be harmless behind it, which is what this asserts.
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      solveChallenge: () => {
        session.noteLockReleased(h.release('navigated'));
        return SOLVED;
      },
    });
    const session = new PageSession(h.deps);

    await session.withLock(async () => session.withSolve(navigation()));

    expect(session.lostLock).toBe('navigated');
    expect(session.dropped).toBe(1);
    expect(session.acquires).toBe(1);
    expect(session.releases).toBe(0);
  });

  test('with no frame open there is no freeze to lose', async () => {
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      solveChallenge: () => SOLVED,
    });
    const session = new PageSession(h.deps);

    expect(await session.withSolve(navigation())).toEqual(SOLVED);

    expect(session.lostLock).toBeUndefined();
    expect(session.dropped).toBe(0);
    expect(h.events).toEqual(['solve']);
  });

  test("the lock's own deadline expiring mid-solve wins over the navigated mark", async () => {
    // This is where "the deadline expires during a solve" actually lives, and
    // it is not where it looks like it lives.
    //
    // On the in-page path it cannot happen at all: the freeze comes down first,
    // and `OutcrawlHandler::ReleaseLock` calls `lock_deadline_.Stop()`
    // (`brave/content/browser/devtools/outcrawl_handler.cc:799`) while the
    // renderer half bumps `lock_generation_` so its pending callback is
    // ignored. A released lock has no deadline left to expire.
    //
    // On the navigation path the freeze is held for the whole solve by design,
    // so the deadline runs the whole time - and the spec budgets 5-10 s per
    // provider with failover and retry on top, against a default deadline of
    // 30 s and a hard ceiling of 300 s that cannot be disabled
    // (`outcrawl_handler.cc:62-64`, confirmed by
    // `scripts/probe-lock-release.ts --only deadline`: 50 ms asked for,
    // released at 1001 ms). A long failover chain therefore reaches it.
    //
    // What must not happen is the resolution overwriting the cause. `timeout`
    // is what ended the freeze; `navigated` is what this path would have
    // recorded. Reporting `navigated` would send someone looking at the
    // navigation for a freeze the clock took away.
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      solveChallenge: () => {
        session.noteLockReleased(h.release('timeout'));
        return SOLVED;
      },
    });
    const session = new PageSession(h.deps);

    let touched: unknown;
    await session.withLock(async () => {
      expect(await session.withSolve(navigation())).toEqual(SOLVED);
      touched = await session.perform(click).then(
        () => undefined,
        (error: unknown) => error,
      );
    });

    expect(session.lostLock).toBe('timeout');
    expect((touched as LockLostError).reason).toBe('timeout');
    // The freeze was really up when the deadline took it, so it is a drop, and
    // no unlock is sent afterwards for a lock that is already gone.
    expect(session.acquires).toBe(1);
    expect(session.releases).toBe(0);
    expect(session.dropped).toBe(1);
    expect(h.events).toEqual(['lock', 'solve', 'released:timeout']);
    expect(h.browser.liveTouches).toBe(0);
  });

  test('the recovery is a fresh lock over a fresh snapshot', async () => {
    const first = catalogueTree();
    const second = catalogueTree();
    const trees = [first, second];
    const h = harness({
      tree: first,
      snapshot: (index) => trees[Math.min(index, 1)] ?? first,
      model: () => ({ action: done }),
      solveChallenge: () => SOLVED,
    });
    const session = new PageSession(h.deps);

    await session.withLock(async (locked) => {
      await locked.snapshot();
      await session.withSolve(navigation());
    });

    // The new frame is a new freeze, so the caller reads the document that the
    // navigation actually produced.
    const after = await session.withLock(async (locked) => locked.snapshot());

    expect(after).toBe(second);
    expect(session.lostLock).toBeUndefined();
    expect(h.browser.liveTouches).toBe(0);
    expect(session.acquires).toBe(2);
    expect(session.releases).toBe(1);
    expect(session.dropped).toBe(1);
    expect(session.acquires).toBe(session.releases + session.dropped);
  });

  test('a navigation-kind solve concurrent with an in-page one cancels the retake', async () => {
    const held = gate();
    const h = harness({
      tree: page,
      model: () => ({ action: done }),
      solveChallenge: async (challenge) =>
        challenge.kind === 'inpage' ? held.run() : SOLVED,
    });
    const session = new PageSession(h.deps);

    await session.withLock(async () => {
      const live = session.withSolve(inpage('c1'));
      await held.entered;
      expect(h.browser.frozen).toBe(false);

      await session.withSolve(navigation('n1'));
      expect(session.lostLock).toBe('navigated');

      held.open();
      await live;
      // Retaking would have frozen a document the caller never saw.
      expect(h.browser.frozen).toBe(false);
    });

    expect(h.events).toEqual(['lock', 'unlock', 'solve', 'solve']);
    expect(session.acquires).toBe(1);
    expect(session.releases).toBe(1);
    expect(session.dropped).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Through the loop
 * ------------------------------------------------------------------ */

describe('the discipline holds through runAgent', () => {
  test('a solve driven from inside perform is invisible to the run', async () => {
    // The production shape: the browser holds the operation, the host receives
    // `challengeSolving` and solves against the run's own session.
    let session: PageSession | undefined;
    const h = harness({
      tree: page,
      model: (_prompt, step) => ({ action: step === 0 ? click : done }),
      perform: async () => {
        await session?.withSolve(inpage());
      },
      solveChallenge: () => SOLVED,
    });

    // `settle: false`: the subject is that a solve driven from inside `perform`
    // leaves the run's lock bookkeeping intact, and the event list below is the
    // evidence. A settle adds unlocked polls of a page that, in this fake
    // browser, is fully rendered and cannot grow — noise in front of the
    // sequence under test. The settle's own event shape is asserted in
    // `settle.test.ts`.
    const result = await runAgent(h.deps, {
      task: 'log in',
      caps: CAPS,
      stepFailures: null,
      settle: false,
      onSession: (handed) => {
        session = handed;
      },
    });

    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('task-complete');
    // The step took longer. Nothing else about it changed, and no step failed.
    expect(h.events).toEqual([
      'lock',
      'snapshot',
      'model',
      'perform',
      'unlock',
      'solve',
      'lock',
      'unlock',
      'lock',
      'snapshot',
      'model',
      'unlock',
    ]);
    expect(h.browser.liveTouches).toBe(0);
    expect(result.steps.every((step) => step.error === undefined)).toBe(true);
  });

  test('a lock lost mid-step fails that step instead of acting on a live page', async () => {
    let session: PageSession | undefined;
    const h = harness({
      tree: page,
      model: () => {
        // The model call is the 5-15 s window, which is where the lock's 30 s
        // default deadline actually expires in production.
        session?.noteLockReleased(h.release('timeout'));
        return { action: click };
      },
    });

    const result = await runAgent(h.deps, {
      task: 'search',
      caps: CAPS,
      stepFailures: null,
      // `settle: false`, because `liveTouches` below must be ZERO for the claim
      // this test makes — that a step which lost the lock never touched a live
      // page — and the settle's polls are live touches BY DESIGN.
      settle: false,
      onSession: (handed) => {
        session = handed;
      },
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('released the action-lock (timeout)');
    expect(h.browser.liveTouches).toBe(0);
    expect(h.performed).toEqual([]);
    expect(h.events).toEqual(['lock', 'snapshot', 'model', 'released:timeout']);
  });
});

/**
 * A freeze held behind the tab's own navigation past the host's hold: the
 * worker throws `StillLoadingError` and leaves the page to load (fleet probes,
 * 2026-09-25: `Outcrawl.lock` is answered at the commit, not by a busy
 * renderer). `run_…`, `run_…` and `run_…` were clicks on
 * links to pages that took 25-35 s.
 */
describe('a tab still loading its next page is waited for, not charged', () => {
  function stillLoading(): Error {
    const error = new Error(
      "Outcrawl.lock is waiting on this tab's own navigation: the tab is still loading https://slow.test/ after 20 s. " +
        'It is left to load and nothing was stopped.',
    );
    error.name = 'StillLoadingError';
    return error;
  }

  test('a slow page on a zero tolerance does not fail the run, and the step says the tab is loading', async () => {
    let held = 0;
    const h = harness({
      tree: page,
      lock: () => {
        held += 1;
        if (held <= 2) throw stillLoading();
      },
      model: () => ({ action: done }),
    });

    const result = await runAgent(h.deps, { task: 'read it', caps: CAPS, stepFailures: 0, settle: false });

    expect(result.status).toBe('completed');
    expect(result.steps.slice(0, 2).map((step) => step.error)).toEqual([
      expect.stringContaining('still loading https://slow.test/'),
      expect.stringContaining('still loading https://slow.test/'),
    ]);
    expect(result.steps.at(-1)?.error).toBeUndefined();
  });

  test('a load that never commits reaches a model turn by the fourth step and ends on stepFailures, not the budget', async () => {
    // The worker's shape: three holds expire (StillLoadingError), then a lock
    // answered without a freeze gives the model a turn on the page the tab
    // still shows, and the load still has not committed after it.
    let locks = 0;
    const h = harness({
      tree: page,
      lock: () => {
        locks += 1;
        if (locks !== 1 && locks !== 5) throw stillLoading();
      },
      model: () => ({ action: click }),
    });

    const result = await runAgent(h.deps, { task: 'search', caps: CAPS, stepFailures: 1, settle: false });

    expect(h.prompts).toHaveLength(2);
    expect(result.steps[4]?.error).toBeUndefined();
    expect(result.status).toBe('failed');
    expect(result.cappedBy).toBeUndefined();
    expect(result.steps).toHaveLength(7);
    expect(result.error).toContain('still loading https://slow.test/');
  });
});

/* ------------------------------------------------------------------ *
 * page.look photographs a live page; every other tool keeps the freeze
 * ------------------------------------------------------------------ */

describe('a tool call and the freeze', () => {
  // Re-pilot 2026-09-26: 9 of 12 failed looks died on the capture deadline,
  // because a page frozen mid-frame answers no Page.captureScreenshot.
  function portSeeing(browser: { frozen: boolean }): { port: ToolPort; sawFrozen: Record<string, boolean> } {
    const sawFrozen: Record<string, boolean> = {};
    return {
      sawFrozen,
      port: {
        list: () => [{ name: LOOK_TOOL, description: 'look' }, { name: 'mail.read_code', description: 'mail' }],
        call: (tool) => {
          sawFrozen[tool] = browser.frozen;
          return { isError: false, text: 'ok' };
        },
      },
    };
  }

  test('page.look runs on the live page, and the step gets its freeze back', async () => {
    const h = harness({ tree: page, model: () => ({ action: done }) });
    const { port, sawFrozen } = portSeeing(h.browser);
    const session = new PageSession({ ...h.deps, tools: port });

    await session.withLock(async (locked) => {
      const out = await locked.callTool(LOOK_TOOL, { question: 'what is painted?' });
      expect(out.isError).toBe(false);
      expect(h.browser.frozen).toBe(true);
      await locked.perform(click);
    });

    expect(sawFrozen[LOOK_TOOL]).toBe(false);
    expect(h.browser.liveTouches).toBe(0);
    expect(session.acquires).toBe(session.releases + session.dropped);
  });

  test('a connector tool keeps the page frozen for the whole call', async () => {
    const h = harness({ tree: page, model: () => ({ action: done }) });
    const { port, sawFrozen } = portSeeing(h.browser);
    const session = new PageSession({ ...h.deps, tools: port });

    await session.withLock(async (locked) => {
      await locked.callTool('mail.read_code', {});
    });

    expect(sawFrozen['mail.read_code']).toBe(true);
    expect(session.releases).toBe(1);
  });

  /**
   * Production 2026-09-26 15:09Z, run_… and run_… (a
   * reCAPTCHA demo page, build .22): a solve began while `page.look` had the page
   * live. Both live holders wrote the one `#idle`/`#suspendReleased` pair, so
   * the look's end cleared the solve's `#idle` and re-froze the page under it,
   * and every next step's `withLock` took the freeze without parking and failed
   * on `SolveInProgressError` in 0.3 ms: 11,916 and 5,991 steps recorded in 14 s
   * and 4.5 s, no model call among them. Which half of the race a run sees
   * depends on when the browser's echo of the look's own release arrives:
   * before the solve registers it is ignored and the solve's overwrite of
   * `#suspendReleased` refuses the solve as "frozen"; after, it marks the lock
   * lost, the solve runs, and the loop spins.
   */
  for (const echo of ['early', 'late'] as const) {
    test(`a solve that starts during a look is solved, never frozen, and parks the next step (release echo ${echo})`, async () => {
      let session: PageSession | undefined;
      const held = gate();
      let lookDone = false;
      let frozenUnderSolve = 0;
      // A release sent to a page that is already live means the step's frame
      // unlocked a page the solve had taken down: the look returned to its
      // caller before the solve it overlapped had ended (review F3, mutation M1).
      let unlockOfLivePage = 0;
      let solved: unknown;
      const h = harness({
        tree: page,
        model: (_prompt, step) =>
          step === 0 ? { action: { type: 'callTool', tool: LOOK_TOOL, arguments: { question: 'q' } } } : { action: done },
        solveChallenge: () => held.run(),
        lock: () => {
          // A freeze taken while the solve still holds the page live stops the
          // vendor's script under `kPause`. Opening after a bounded number
          // keeps the broken shape finite instead of hanging the suite.
          if (lookDone && (session?.solving.length ?? 0) > 0 && ++frozenUnderSolve === 25) held.open();
        },
        unlock: () => {
          if (!h.browser.frozen) unlockOfLivePage += 1;
        },
      });
      const port: ToolPort = {
        list: () => [{ name: LOOK_TOOL, description: 'look' }],
        call: async () => {
          const live = session as PageSession;
          if (echo === 'early') live.noteLockReleased('explicit');
          // The host hears `challengeSolving` while the look is photographing.
          const solving = live.withSolve(inpage()).then(
            (resolution) => (solved = resolution),
            (error: unknown) => (solved = error),
          );
          if (echo === 'late') {
            for (let tick = 0; tick < 100 && live.solving.length === 0; tick += 1) await Promise.resolve();
            live.noteLockReleased('explicit');
          }
          await Promise.race([held.entered, solving]);
          lookDone = true;
          // The solve ends on its own clock, not the loop's: once nothing is
          // left to run, which is where a parked loop sits. `setImmediate` is
          // that condition, not a duration.
          setImmediate(() => held.open());
          return { isError: false, text: 'a checkbox' };
        },
      };

      const result = await runAgent(
        { ...h.deps, tools: port },
        {
          task: 'solve the demo',
          caps: { steps: 50, budget: '10', duration: '10m' },
          stepFailures: null,
          settle: false,
          onSession: (handed) => {
            session = handed;
          },
        },
      );

      expect(solved).toEqual(SOLVED);
      expect(frozenUnderSolve).toBe(0);
      expect(result.steps.filter((step) => step.error !== undefined)).toEqual([]);
      expect(result.status).toBe('completed');
      expect(h.prompts).toHaveLength(2);
      expect(h.browser.liveTouches).toBe(0);
      expect(session?.acquires).toBe((session?.releases ?? 0) + (session?.dropped ?? 0));
      expect(unlockOfLivePage).toBe(0);
      // And no freeze outlives the run: a retake after the frame's own release
      // would leave the page frozen at depth 0.
      expect(h.browser.frozen).toBe(false);
    });
  }
});

/* ------------------------------------------------------------------ *
 * A human and this session's own live holders park the loop separately
 * ------------------------------------------------------------------ */

/**
 * Review of ws/agenterrors (2026-09-27, F1): the human's hold and the live
 * holders (a solve, a look) shared one `#idle`/`#wake` slot, and `interrupt`
 * replaced it without resolving the promise already being waited on. Each
 * sequence below is the reviewer's probe, made deterministic: the solve is
 * opened by hand, and `setImmediate` stands for "once nothing else can run".
 */
describe('a human and a solve holding the page at once', () => {
  const settled = <T>(promise: Promise<T>): Promise<T | 'pending'> =>
    Promise.race([promise, new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending')))]);

  test('a viewer takes control while page.look waits on a solve it overlapped: the run carries on', async () => {
    let session: PageSession | undefined;
    const held = gate();
    let handedBack: Promise<void> | undefined;
    const h = harness({
      tree: page,
      model: (_prompt, step) =>
        step === 0 ? { action: { type: 'callTool', tool: LOOK_TOOL, arguments: { question: 'q' } } } : { action: done },
      solveChallenge: () => held.run(),
    });
    const port: ToolPort = {
      list: () => [{ name: LOOK_TOOL, description: 'look' }],
      call: async () => {
        const live = session as PageSession;
        const solving = live.withSolve(inpage());
        await held.entered;
        // With the look parked on the solve: the viewer takes the page, the
        // solve ends under them, and they hand it back.
        setImmediate(() => {
          handedBack = (async () => {
            const hold = await live.interrupt('viewer');
            held.open();
            await solving;
            await hold.release();
          })();
        });
        return { isError: false, text: 'a checkbox' };
      },
    };

    const result = await runAgent(
      { ...h.deps, tools: port },
      {
        task: 'solve the demo',
        caps: { steps: 10, budget: '10', duration: '10m' },
        stepFailures: 3,
        settle: false,
        onSession: (handed) => {
          session = handed;
        },
      },
    );
    await handedBack;

    expect(result.status).toBe('completed');
    expect(h.prompts).toHaveLength(2);
    expect(h.browser.frozen).toBe(false);
    expect(session?.acquires).toBe((session?.releases ?? 0) + (session?.dropped ?? 0));
  }, 10_000);

  test('a human hands back while a solve is still running: the next freeze waits for the solve', async () => {
    const held = gate();
    const h = harness({ tree: page, model: () => ({ action: done }), solveChallenge: () => held.run() });
    const session = new PageSession(h.deps);
    const solving = session.withSolve(inpage());
    await held.entered;
    const hold = await session.interrupt('viewer');
    await hold.release();

    let solvingWhenEntered: number | undefined;
    const next = session.withLock(async (locked) => {
      solvingWhenEntered = session.solving.length;
      return locked.snapshot();
    });
    expect(await settled(next.then(() => 'entered'))).toBe('pending');
    held.open();
    await solving;
    await next;

    expect(solvingWhenEntered).toBe(0);
    expect(h.browser.liveTouches).toBe(0);
  });

  test('a solve that begins while a human holds the page does not strand the handback', async () => {
    const held = gate();
    const h = harness({ tree: page, model: () => ({ action: done }), solveChallenge: () => held.run() });
    const session = new PageSession(h.deps);
    const hold = await session.interrupt('viewer');
    const back = session.awaitHandback().then(() => 'returned' as const);
    const solving = session.withSolve(inpage());
    await held.entered;
    await hold.release();
    held.open();
    await solving;

    expect(await settled(back)).toBe('returned');
  });

  test('control taken from a look that holds the page live is a lost lock, and nothing re-freezes the viewer', async () => {
    const h = harness({ tree: page, model: () => ({ action: done }) });
    let session!: PageSession;
    let hold: AgentInterrupt | undefined;
    const port: ToolPort = {
      list: () => [{ name: LOOK_TOOL, description: 'look' }],
      call: async () => {
        hold = await session.interrupt('viewer');
        return { isError: false, text: 'x' };
      },
    };
    session = new PageSession({ ...h.deps, tools: port });

    await session.withLock(async (locked) => {
      await locked.callTool(LOOK_TOOL, { question: 'q' });
      // The viewer is driving: the page stays live, and this frame's refs
      // are stale by the viewer's hand.
      expect(h.browser.frozen).toBe(false);
      expect(session.lostLock).toBe('controlTaken');
    });
    await hold?.release();

    expect(h.browser.frozen).toBe(false);
    expect(session.acquires).toBe(session.releases + session.dropped);
  });

  /**
   * Re-review of ws/agenterrors 2a370ae4 (F4): the production solve shape. The
   * solve arrives during a frozen step and releases its freeze; the step's next
   * touch is refused and its frame exits while the solve still runs. The frame
   * used to send `unlock` to the already-live page and leave the solve's retake
   * owed at depth 0, so the solve froze the page after it with no frame open —
   * here, under a viewer who had taken control in between.
   */
  test('a step frame that exits mid-solve owes no retake: a viewer who takes control is not frozen by the solve', async () => {
    const held = gate();
    const h = harness({ tree: page, model: () => ({ action: done }), solveChallenge: () => held.run() });
    const session = new PageSession(h.deps);
    let solving: Promise<ChallengeResolution> | undefined;
    await session.withLock(async (locked) => {
      solving = session.withSolve(inpage());
      await held.entered;
      await expect(locked.perform(click)).rejects.toBeInstanceOf(SolveInProgressError);
    });
    const hold = await session.interrupt('viewer');
    held.open();
    await solving;

    expect(h.browser.frozen).toBe(false);
    await hold.release();
    expect(h.browser.frozen).toBe(false);
  });

  test('a step frame that exits mid-solve sends no second unlock and leaves no freeze behind', async () => {
    const held = gate();
    const h = harness({ tree: page, model: () => ({ action: done }), solveChallenge: () => held.run() });
    const session = new PageSession(h.deps);
    let solving: Promise<ChallengeResolution> | undefined;
    await session.withLock(async () => {
      solving = session.withSolve(inpage());
      await held.entered;
    });
    held.open();
    await solving;

    expect(h.events.filter((event) => event === 'lock' || event === 'unlock')).toEqual(['lock', 'unlock']);
    expect(h.browser.frozen).toBe(false);
    expect(session.acquires).toBe(1);
    expect(session.acquires).toBe(session.releases + session.dropped);
  });
});

/* ------------------------------------------------------------------ *
 * page.verify on a page whose check the browser is already solving
 * ------------------------------------------------------------------ */

// Stealth Bench task 11, run_… (2026-10-06 19:25Z): the browser's
// reCAPTCHA hold on Stack Exchange's /nocaptcha minted and the page moved to
// the results, and page.verify, run alongside it, answered "absent ... reach
// the information another way". The model left the results it had.
describe('page.verify and a solve the browser is running on the same page', () => {
  const ABSENT = { isError: true, text: 'page.verify (1 of 3): no check this tool knows is on the page.', note: 'absent: no check' };
  function verifyPort(onCall: () => void = () => undefined): { port: ToolPort; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      port: {
        list: () => [{ name: 'page.verify', description: 'verify' }],
        call: () => {
          calls += 1;
          onCall();
          return ABSENT;
        },
      },
    };
  }

  test('a solve running when it is called is waited for, and its success is the answer', async () => {
    const held = gate();
    const h = harness({ tree: page, model: () => ({ action: done }), solveChallenge: () => held.run() });
    const { port, calls } = verifyPort();
    const session = new PageSession({ ...h.deps, tools: port });

    const out = await session.withLock(async (locked) => {
      const solving = session.withSolve(inpage());
      await held.entered;
      const verifying = locked.callTool('page.verify', {});
      held.open();
      await solving;
      return verifying;
    });

    expect(out.isError).toBe(false);
    expect(out.note).toStartWith('solved:');
    expect(out.text).toContain('recaptcha');
    // The tool's own solvers never touched a page the browser had cleared.
    expect(calls()).toBe(0);
    expect(session.acquires).toBe(session.releases + session.dropped);
  });

  test('a solve that begins while the tool runs and succeeds replaces its "absent"', async () => {
    const held = gate();
    const h = harness({ tree: page, model: () => ({ action: done }), solveChallenge: () => held.run() });
    let solving: Promise<ChallengeResolution> | undefined;
    const { port, calls } = verifyPort(() => {
      solving = session.withSolve(inpage());
    });
    const session = new PageSession({ ...h.deps, tools: port });

    const out = await session.withLock(async (locked) => {
      const verifying = locked.callTool('page.verify', {});
      await held.entered;
      held.open();
      await solving;
      return verifying;
    });

    expect(calls()).toBe(1);
    expect(out.isError).toBe(false);
    expect(out.note).toStartWith('solved:');
  });

  test('a solve that failed leaves the tool\u2019s own answer standing', async () => {
    const held = gate(EXHAUSTED);
    const h = harness({ tree: page, model: () => ({ action: done }), solveChallenge: () => held.run() });
    const { port, calls } = verifyPort();
    const session = new PageSession({ ...h.deps, tools: port });

    const out = await session.withLock(async (locked) => {
      const solving = session.withSolve(inpage());
      await held.entered;
      const verifying = locked.callTool('page.verify', {});
      held.open();
      await solving;
      return verifying;
    });

    expect(calls()).toBe(1);
    expect(out).toEqual(ABSENT);
  });

  test('a success the loop already showed the model is not reported again', async () => {
    const h = harness({ tree: page, model: () => ({ action: done }), solveChallenge: () => SOLVED });
    const { port, calls } = verifyPort();
    const session = new PageSession({ ...h.deps, tools: port });
    await session.withSolve(inpage());
    session.takeChallengeOutcomes();

    const out = await session.withLock(async (locked) => locked.callTool('page.verify', {}));

    expect(calls()).toBe(1);
    expect(out).toEqual(ABSENT);
  });
});
