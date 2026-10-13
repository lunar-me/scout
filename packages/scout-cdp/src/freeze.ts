import type { CdpPage } from './cdp';

/**
 * How long a freeze command waits for the RENDERER to answer it, and the
 * record of one that never did.
 *
 * ── WHY THESE COMMANDS CAN HANG AT ALL ─────────────────────────────────────
 *
 * `Outcrawl.lock` and `Outcrawl.unlock` are `Response::FallThrough()` —
 * `brave/content/browser/devtools/outcrawl_handler.cc:904` and `:931`. The
 * browser half runs there (the `ScopedIgnoreInputEvents` guard, the lock's own
 * deadline, the `lockReleased` event) and then the REPLY is produced by the
 * renderer, in `InspectorOutcrawlAgent::lock`/`unlock`
 * (`brave/third_party/blink/renderer/core/inspector/inspector_outcrawl_agent.cc:357,391`),
 * because the freeze itself is `VirtualTimePolicy::kPause` and only the
 * renderer can set it. So a renderer whose main thread is executing script does
 * not REFUSE the command — it HOLDS it, and every later command on that
 * session queues behind it in the same renderer.
 *
 * That is what killed `run_daaf33c2` on `www.nordstrom.com` on 2026-09-11:
 * `Outcrawl.unlock did not answer within 30000ms` at step 30, then
 * `Outcrawl.lock did not answer within 30000ms` at 31, 32 and 33. Two minutes
 * of a customer's run spent on four replies that were queued behind one busy
 * renderer, and the only thing the customer was told was the method name.
 *
 * ── WHY THE DEADLINE IS THIS SHORT, MEASURED ───────────────────────────────
 *
 * `scripts/.tmp/measure-lock-latency.ts` on the shipped binary in
 * `--headless=new`, 50 lock/unlock cycles over five real sites (example.com,
 * news.ycombinator.com, en.wikipedia.org, bbc.co.uk/news,
 * apple.com/macbook-pro): lock p50 0.38 ms, p99 0.82 ms, max 0.82 ms; unlock
 * max 0.42 ms. A renderer that is going to answer answers in under a
 * millisecond, so five seconds is four orders of magnitude of headroom and
 * cannot refuse a page that was merely slow.
 *
 * ── WHY THERE IS NO PRE-FLIGHT INSTEAD, ALSO MEASURED ──────────────────────
 *
 * `Page.getFrameTree` was the obvious guard and it does not work:
 * `scripts/.tmp/probe-wedged-renderer.ts`, against a page pegging its main
 * thread for 20 s, measured `Page.getFrameTree` HELD alongside the two freeze
 * commands. `Page.getNavigationHistory` and `Target.getTargetInfo` answered in
 * 0 ms throughout — they are browser-process state — but neither of them can
 * say whether a renderer will answer. There is no question that both is cheap
 * and is about the renderer, so the send IS the probe and the deadline is how
 * long we are willing to pay for it.
 *
 * ── WHY ONE HELD COMMAND POISONS THE PAGE, AND WHY THAT IS RECORDED ────────
 *
 * The same measurement: a `Page.getFrameTree` sent while `Outcrawl.lock` was
 * outstanding was held too, and both replies arrived together the instant the
 * main thread freed up. So a second freeze command sent after the first one
 * timed out cannot be answered any sooner than the first — it is strictly a
 * second deadline spent learning the same fact. {@link heldFreezes} remembers
 * the unanswered one and the next freeze command is refused WITHOUT BEING
 * SENT, in zero time, naming the page and how long the renderer has been
 * silent. The entry is cleared by the reply whenever it does arrive, so a page
 * that recovers is usable again on the next step.
 *
 * A REAL TIMER, NOT THE INJECTED CLOCK, and that is not an oversight.
 * `AgentBindingOptions.clock` is the gesture clock — `dispatchGesture` sleeps
 * on it for the dwells a pointer path asks for, and the tests assert those
 * dwells exactly. A test clock resolves `sleep` instantly, so a deadline built
 * on it would beat a reply that was already on its way and charge every lock
 * and unlock of every step one interval it did not need. The reply is a
 * promise; `setTimeout` is the only thing here that has to be wall time, and
 * `AgentBindingOptions.freezeReplyTimeoutMs` is how a test shrinks it — the
 * same seam `CdpConnection`'s `commandTimeoutMs` already is.
 */
export const FREEZE_REPLY_DEADLINE_MS = 5_000;

/**
 * How long the release that lets go of a pressed button is waited for when the
 * plan failed because the renderer never answered one of its input events.
 * The release is still sent — a page must not be left holding a mousedown —
 * but that renderer will not answer it inside the 30 s command deadline
 * either, and a step that waits for it pays the deadline twice. See
 * `dispatchGesture`.
 */
export const UNANSWERED_RELEASE_WAIT_MS = 1_000;

/**
 * HOW LONG A FREEZE COMMAND HELD BEHIND A NAVIGATION IS WAITED FOR.
 *
 * A different hold from the one {@link FREEZE_REPLY_DEADLINE_MS} bounds, with a
 * different end. MEASURED on the fleet (browser 152.1.94.117-outcrawl.18,
 * 2026-09-25, `/connect` probes, n=1 per arm): while a main-frame navigation is
 * in flight, `Outcrawl.lock` and `Runtime.evaluate` are both held and answered
 * at its commit — 8,536 ms for a renderer-initiated navigation to an 8-second
 * response, 8,056 ms for a `Page.navigate` — while `Page.getNavigationHistory`
 * answered in 83 ms. The renderer is not busy: DevTools does not deliver it
 * anything until the navigation finishes. So the lock a gesture retakes after a
 * click on a link to a slow page is held for as long as that page takes to
 * answer, and at 5 s it was recorded as a busy renderer and every later freeze
 * on the tab refused unsent. That is the whole of `run_3f611656`,
 * `run_ce3c2def` and `run_662eb1bf` (2026-09-25): a click on a search result or
 * a site link, "Outcrawl.lock was not answered", then two or three steps
 * refused until the navigation committed 25-35 s later.
 *
 * THE END IS NOT A STOP. `Page.stopLoading` was measured to release the held
 * command (sent 3 s into a 20-second navigation: answered in 88 ms, the lock
 * 9 ms later), but stopping a load the customer's page, or the model, started
 * is an input no person makes and a page a person would have waited for is
 * lost with it. So a navigation still not committed after this long is LEFT
 * TO LOAD: the call throws {@link StillLoadingError}, which the loop does not
 * charge as a failed step, the step is told the tab is still loading, and the
 * next step's freeze goes out again rather than being refused — the held
 * command is not recorded in {@link heldFreezes}, because its reply comes at
 * the commit, not from a renderer that stopped answering. Twenty seconds is
 * four times the healthy-renderer deadline and inside the 30 s CDP command
 * deadline.
 */
export const NAVIGATION_FREEZE_HOLD_MS = 20_000;

/**
 * HOW MANY {@link NAVIGATION_FREEZE_HOLD_MS} HOLDS ONE NAVIGATION GETS before
 * the model is given a turn on the tab while it loads.
 *
 * Each expired hold is a {@link StillLoadingError}, which the loop does not
 * charge and which reaches no model turn. Unbounded, a navigation that never
 * commits (a server that holds the connection open) would repeat 20 s waits
 * until the budget ran out, with the model never asked (ByoProxyReview P2,
 * 2026-09-26). So after this many — about a minute — the next lock does not
 * freeze: the step reads the page the tab still displays, live, with a notice
 * saying it is still loading, and the model can go back, go elsewhere or
 * stop. That read is possible, MEASURED on the fleet 2026-09-26 (`/connect`,
 * `heldprobe.mjs`, n=1): 0.8 s into a renderer-initiated navigation to a
 * 10-second response, `Outcrawl.getAXTree` answered in 398 ms with the old
 * document's tree and `Page.captureScreenshot` in 416 ms, while
 * `DOM.getDocument` was held 10,299 ms, to the commit. The loop charges a
 * further run of these as failures, so the model's turn is where it ends.
 */
export const LOADING_HOLDS_BEFORE_TURN = 3;

/**
 * HOW LONG THE BROWSER HOLDS THE FREEZE BEFORE RELEASING IT ITSELF.
 *
 * A DIFFERENT QUESTION FROM {@link FREEZE_REPLY_DEADLINE_MS}, and conflating
 * the two is the mistake this comment exists to prevent. That one is how long
 * we wait to be told the page froze; this one is how long the freeze LASTS.
 *
 * ── WHY NOT THE BROWSER'S OWN DEFAULT ──────────────────────────────────────
 *
 * `kDefaultLockTimeoutMs` in the fork is 30 000
 * (`outcrawl_handler.cc:910`, clamped to [1000, 300000]), and this option was
 * plumbed and never set, so every production run took it. But the loop holds
 * the lock ACROSS THE MODEL CALL by design — `loop.ts` argues that at length —
 * and `ModelClient`'s own `DEFAULT_TIMEOUT_MS` is 60 000. So the freeze was
 * guaranteed to expire under any model call past thirty seconds, and the step
 * then died on `LockLostError ... (timeout)` with the page live and every
 * reference in the model's hands stale.
 *
 * MEASURED, the owner's task rerun against the live nordstrom storefront on
 * 2026-09-11 with the brain model of that day: model calls of 30-45 s, and
 * SIX of thirteen steps lost to `LockLostError ... (timeout)`. A ceiling that
 * is shorter than the one thing it is required to span is not a safety net,
 * it is a scheduled failure.
 *
 * ── WHY 120 s ──────────────────────────────────────────────────────────────
 *
 * Twice the model client's 60 s deadline, which is the only unbounded-looking
 * thing inside the frame, leaving the snapshot, the action and
 * `snapshotAfterAction` a full model call's worth of headroom on top. Well
 * inside the fork's 300 s clamp, so it is never silently rewritten, and still
 * a real ceiling: a page frozen forever is worse than one never frozen, which
 * is why the fork refuses to let the deadline be disabled at all.
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 120_000;

/** One freeze command a page's renderer has not answered, and when it went out. */
interface HeldFreeze {
  readonly method: string;
  readonly sinceMs: number;
}

/**
 * The freeze command each page still owes a reply for.
 *
 * Keyed on the page rather than held in the binding's closure because a tabbed
 * binding builds one {@link pageBinding} per tab and a fan element builds
 * another over the same `CdpPage`: the renderer they queue behind is one
 * renderer, so the record of it has to be one record.
 */
export const heldFreezes = new WeakMap<CdpPage, HeldFreeze>();

/**
 * Thrown when a freeze command was held rather than answered, or when one is
 * refused because an earlier one is still outstanding.
 *
 * A distinct name because it is neither a browser that died — `isBrowserLost`
 * in `@outcrawl/runtime` deliberately excludes a held command, the connection
 * is open and every other target on it is healthy — nor a step that was wrong.
 * It is one page whose renderer will not stop long enough to be frozen.
 *
 * `sent` is load-bearing and not diagnostic. A command that WENT OUT already
 * ran its browser half, so `Outcrawl.lockReleased` has been emitted for it and
 * the bookkeeping that counts those echoes still owes one. A command refused
 * before the wire emitted nothing, and a caller that booked an echo for it has
 * to take the booking back or it will swallow the next real lost lock.
 */
export class FreezeNotAnsweredError extends Error {
  readonly sent: boolean;

  constructor(message: string, sent: boolean) {
    super(message);
    this.name = 'FreezeNotAnsweredError';
    this.sent = sent;
  }
}

/**
 * Thrown when a freeze command is still held behind this tab's OWN main-frame
 * navigation after {@link NAVIGATION_FREEZE_HOLD_MS}: the page is loading, not
 * busy, and it is left to load.
 *
 * Not a {@link FreezeNotAnsweredError}, and the difference is what the loop
 * does with it. That one is a renderer executing script, recorded in
 * {@link heldFreezes} so the next freeze is refused unsent; this one is
 * answered at the commit, so nothing is recorded and the next freeze goes
 * out. The runtime matches it BY NAME (`isStillLoading` in
 * `@outcrawl/runtime`'s resume.ts, on `isRendererBusy`'s precedent) and does
 * not charge the step as a failure: nothing the model chose went wrong.
 */
export class StillLoadingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StillLoadingError';
  }
}

/**
 * The scheme of the browser's own network-error page, `chrome-error://chromewebdata/`.
 *
 * A FREEZE IS NEVER SENT TO IT. Measured in production, 30 step errors over 15
 * runs in the 30 days to 2026-09-24: the error page reads fine — its settle is
 * `actionable`, 9 nodes, a Reload button — but `Outcrawl.unlock` sent to it
 * was not answered (run_3f2c2f5d, run_48e96ac9, run_c538da4e, run_b3215816,
 * run_9426fee0), nor was the `Outcrawl.lock` retaken after a click on its
 * Reload button (run_fdbfb45a, run_ebe3efdf, run_cd2d2e4b, run_5fc43a3d,
 * run_72d05009, run_0d4865c9, run_914c730c, run_bfd5ec0b, run_e5bb7ae2), and a
 * held freeze command poisons every later one on the page, so each of those
 * runs lost the page there. WHY that renderer holds the command is not
 * measured. What a freeze protects is a site's own script changing the page
 * between a read and an action, and this page is the browser's, not the
 * site's: there is nothing on it to protect, and the model's way off it is a
 * navigation, which is browser-side.
 */
export const ERROR_PAGE_PREFIX = 'chrome-error://';

/** Resolves when `reply` settles or `ms` of wall time pass, whichever is first. */
export async function within(reply: Promise<unknown>, ms: number): Promise<void> {
  let timer: Timer | undefined;
  try {
    await Promise.race([
      reply,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
