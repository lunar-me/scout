import type { Clock } from '@outcrawl/scout-core';
import type { CdpPage } from './cdp';
import { outcrawlFlavor, type CdpFlavor } from './flavor';
import type { HandsStep } from './hands';

/**
 * Tabs a FAN element is holding the freeze on, and how many nested holds.
 *
 * ── Why a release on these must never reach the run's `PageSession` ────────
 *
 * `jobs.ts` binds `Outcrawl.lockReleased` on EVERY tab of a session into the
 * ONE `PageSession` the run holds — `bindEveryTab`, and it is right to: the
 * loop drives whichever tab is focused, so a release on any tab the loop might
 * be holding has to reach the refcount that believes in that freeze. While the
 * loop drove one tab at a time that was exact, because only the focused tab
 * ever held a lock and therefore only the focused tab ever emitted.
 *
 * A fan breaks that assumption by design. An element takes its OWN tab's lock,
 * and every release of it emits on that tab: our own `unlock` as `explicit`, a
 * click that navigates as `navigated`, a dying renderer as `rendererGone`.
 * Routed to the run's session those become a lost lock on a freeze that is
 * still perfectly held — `PageSession.noteLockReleased` reads an unexpected
 * `explicit` at depth > 0 as the browser taking the lock away, correctly,
 * because normally nobody but the session releases mid-frame — and the focused
 * tab's step then fails for something that happened on a different page.
 *
 * So while an element holds a tab, that tab's releases are swallowed here. The
 * loss is not lost: a dead tab reaches the loop through
 * {@link AgentTabs.onLost}, and a tab that navigated is caught by `fanAbort`
 * on the next read, which is the gate that exists for exactly this.
 *
 * A COUNT rather than a flag, and keyed on the page rather than held in a
 * closure, for {@link selfReleases}'s reason: {@link bindLockReleases} is
 * wired separately by the host and has to be able to see it.
 */
export const fanHolds = new WeakMap<CdpPage, { held: number }>();

/**
 * Anything that takes `Outcrawl.lockReleased`. `PageSession` satisfies it.
 *
 * Structural rather than `PageSession` itself, because the only thing this
 * module needs is the intake method, and depending on the class would make the
 * binding untestable without constructing a session around a second set of
 * deps.
 */
export interface LockReleaseSink {
  noteLockReleased(reason: string): void;
}

/**
 * Freezes this module dropped on purpose, and the `lockReleased{explicit}`
 * echoes still owed for them.
 *
 * A pointer gesture has to take the freeze down (the path commands refuse under
 * it), and the browser emits `lockReleased` for every release including the
 * client's own. `PageSession.noteLockReleased` reads an unexpected `explicit`
 * at depth > 0 as a lost lock — correctly, because normally nobody but the
 * session releases mid-frame. This binding is the exception: it released, it
 * retakes before `perform` returns, and the frame above never saw a live page
 * it could act on. Keyed on the page rather than held in the closure so that
 * {@link bindLockReleases}, which the caller wires separately, can see it.
 */
export const selfReleases = new WeakMap<CdpPage, { owed: number }>();

/**
 * The substring the browser puts in the error for an input event it discarded
 * before the renderer. Pinned by a test, because both halves are literals.
 *
 * The browser's copy is `kInputNotForwardedToken` in
 * `content/browser/devtools/protocol/input_handler.cc` (captured in
 * `0008-headless-automation.patch`). Change one without the other and this
 * binding stops resending, silently, which is the exact failure the refusal
 * was added to remove.
 */
export const INPUT_NOT_FORWARDED = 'outcrawl:input-not-forwarded';

/**
 * How long {@link agentDepsFor}'s `dispatchGesture` keeps resending one input
 * event the browser refused, and how long it waits between attempts.
 *
 * NOT A SLEEP, AND THE DIFFERENCE IS THE WHOLE POINT. A fixed idle before the
 * first keystroke also makes the loss go away — `--first-delay 250` measured
 * 0/20 — and is not a fix, because its failure mode is a slower machine: the
 * window it has to outlast is the time from a navigation's commit to the
 * renderer's first frame reaching cc, which is a property of the page and the
 * host, not a constant. This loop instead waits for exactly the observed
 * condition to clear and no longer: the first attempt the browser accepts is
 * the last one, on any machine, and a widget that never accepts produces a
 * thrown error rather than a missing character.
 *
 * The interval only sets how much CDP traffic the wait costs. 5 ms over a
 * loopback socket is ~40 round trips across a typical paint-holding window and
 * none across an already-painted page, which is the common case: a refusal is
 * observed on roughly one fill in four and only for its first event.
 *
 * TWO BOUNDS, AND BOTH ARE NECESSARY. The deadline is generous because
 * exceeding it is a real failure worth reporting loudly rather than a number to
 * tune: two seconds of a widget refusing every keystroke is a page that is not
 * going to take input. The attempt cap exists because the deadline is measured
 * on an INJECTED clock, and a clock is not obliged to move — the test clock in
 * `packages/worker/test/agent-deps.test.ts` returns a constant `now`, and
 * against it a time-only bound is an infinite loop. That was not a
 * hypothetical: a mutation that widened the retry to every error hung the test
 * suite for fifteen minutes instead of failing, which is a bound that does not
 * exist. Whichever fires first ends the wait, so the loop terminates on a
 * frozen clock and on a machine slow enough that 400 round trips outlast two
 * seconds.
 */
const RESEND_POLL_MS = 5;
const RESEND_DEADLINE_MS = 2_000;
const RESEND_MAX_ATTEMPTS = RESEND_DEADLINE_MS / RESEND_POLL_MS;

/**
 * The CSS layout viewport's client size out of a `Page.getLayoutMetrics`
 * reply: what a box from `DOM.getBoxModel` or `DOM.getContentQuads` on the
 * same session is relative to, and what a planned path must stay inside.
 * Refused rather than defaulted, because a guessed viewport is a path that
 * leaves the window.
 */
export function clientViewportOf(metrics: Record<string, unknown>): { readonly width: number; readonly height: number } {
  const css = metrics['cssLayoutViewport'];
  if (
    typeof css !== 'object' ||
    css === null ||
    !('clientWidth' in css) ||
    !('clientHeight' in css)
  ) {
    throw new TypeError('Page.getLayoutMetrics returned no cssLayoutViewport client size');
  }
  const { clientWidth, clientHeight } = css;
  if (typeof clientWidth !== 'number' || typeof clientHeight !== 'number') {
    throw new TypeError('Page.getLayoutMetrics cssLayoutViewport has no numeric client size');
  }
  return { width: clientWidth, height: clientHeight };
}

/**
 * Sends one plan step, resending it while the browser says it discarded the
 * event before the renderer.
 *
 * ## Why resending is safe, and it is not "retry the write and hope"
 *
 * The refusal has one meaning and the browser only produces it in the two
 * places where that meaning holds: the event reached no input router, or the
 * router acked it `kBrowser`/`kNoConsumerExists`, which is by construction
 * the not-dispatched path. So a refused event had NO effect on the page —
 * not a partial one, not a queued one. Resending it is therefore idempotent
 * in the only sense that matters: the page sees the event exactly once, on
 * the attempt that was accepted. If that invariant ever breaks the fix
 * belongs in the browser, because a refusal that sometimes means "delivered"
 * is worse than no refusal at all.
 *
 * ## Why the loop is here and not in the browser
 *
 * The browser could have waited for the widget instead of refusing, and the
 * CDP command would then have been truthful too. It refuses because a wait
 * inside the browser puts the policy in the wrong process: how long an agent
 * step is willing to wait for a page, and whether waiting or failing is the
 * better answer, is the host's question. Refusal also makes the condition
 * visible to every other client of this build instead of hiding it behind a
 * timeout only we can see.
 *
 * The deadline is measured across attempts for ONE step, not for the plan: a
 * 40-character fill is 80 steps and each of them is entitled to the same
 * patience. Only the first event of a fresh navigation is ever refused in
 * practice, so the loop normally runs its body once.
 */
export async function sendUntilForwarded(
  step: HandsStep,
  send: (step: HandsStep) => Promise<unknown>,
  clock: Clock,
): Promise<void> {
  const giveUpAt = clock.now() + RESEND_DEADLINE_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await send(step);
      return;
    } catch (error) {
      const refused =
        error instanceof Error && error.message.includes(INPUT_NOT_FORWARDED);
      if (!refused || attempt >= RESEND_MAX_ATTEMPTS || clock.now() >= giveUpAt) {
        // Rethrown rather than wrapped: the browser's message names the
        // reason it refused, and a step that never landed must fail the
        // action rather than let the caller believe the page was touched.
        throw error;
      }
      await clock.sleep(RESEND_POLL_MS);
    }
  }
}

/**
 * Routes `Outcrawl.lockReleased` into a `PageSession`. Returns the unsubscribe.
 *
 * **The caller must call this**, and this module cannot do it. `runAgent` hands
 * the session out through `AgentRunRequest.onSession` and there is no other
 * route to it: the session is constructed inside the run, after `agentDepsFor`
 * has already returned. So the wiring is:
 *
 * ```ts
 * const deps = agentDepsFor(page, options);
 * let stop: (() => void) | undefined;
 * const result = await runAgent(deps, { ...req, onSession: (s) => { stop = bindLockReleases(page, s); } });
 * stop?.();
 * ```
 *
 * Skipping it is not cosmetic. Without it a lock the browser took away on
 * `timeout`, `navigated` or `rendererGone` is invisible to the session, which
 * goes on believing the page is frozen and acts on node references from a
 * document that has moved — the TOCTOU the lock exists to remove, restored in
 * full.
 *
 * `observe` has no equivalent seam and needs none: it performs nothing, so it
 * never drops the freeze and its whole body is one `withLock`.
 */
export function bindLockReleases(page: CdpPage, session: LockReleaseSink, flavor: CdpFlavor = outcrawlFlavor): () => void {
  // A browser with no freeze has none to take away.
  if (flavor.lockReleased === null) {
    return () => undefined;
  }
  return page.on(flavor.lockReleased, (params) => {
    // BEFORE the reason is even read. While a fan element holds this tab, no
    // release of it describes the freeze the run's `PageSession` is counting —
    // that freeze is on a different tab. Every reason is swallowed, not just
    // `explicit`: a `navigated` here is this tab navigating, and reporting it
    // as the run losing its lock would fail the focused tab's step for
    // something that happened on another page. See {@link fanHolds} for the
    // two channels the loss does travel on.
    if ((fanHolds.get(page)?.held ?? 0) > 0) {
      return;
    }
    const reason = params['reason'];
    // A reason that is not a string is a protocol break, and `unknownRelease`
    // is what the session already does with a reason it does not recognise:
    // certainly not `explicit`, therefore certainly a loss.
    const value = typeof reason === 'string' ? reason : 'unknownRelease';
    if (value === 'explicit') {
      const owed = selfReleases.get(page);
      if (owed !== undefined && owed.owed > 0) {
        owed.owed -= 1;
        return;
      }
    }
    session.noteLockReleased(value);
  });
}
