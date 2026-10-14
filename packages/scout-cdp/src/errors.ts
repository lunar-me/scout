import { ACTIONABLE_ROLES, formatNodeRef, RefusedActionError, type NodeRef } from '@outcrawl/runtime';
import type { HandsTarget } from './hands';
import type { DescribedElement } from './reach';

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ */

/**
 * An input action arrived with no `agenthands` port configured.
 *
 * POINTER. The tempting alternative is `Input.dispatchMouseEvent` at the centre
 * of the box: one command, no dependency, and it clicks. It is also a teleport
 * to an integer coordinate with zero-variance timing, no coalesced-event list
 * and `PointerEvent.pressure` 0.0 where real hardware reports 0.5 — measured
 * against our own binary, and the exact signature `dispatchPointerPath` exists
 * to avoid. Through a residential exit that costs the IP, and the IP is the
 * expensive part of the request.
 *
 * KEYBOARD, and this half is newer because nobody had looked at it. The
 * tempting alternative is `Input.insertText`, which is what this binding did
 * until now: the whole string arrives at once, with no `keydown`, no `keyup`
 * and no per-character timing, so a page listening for keystrokes sees a value
 * appear from nowhere. `Input.dispatchKeyEvent` twice in a row is not better —
 * it is a 0 ms hold, and the measured median human hold is 91 ms. A 0 ms hold
 * is not a fast typist; it is not a typist.
 *
 * The failure mode being refused here is not the synthetic input; it is the
 * SILENT DOWNGRADE. A fallback means a worker that lost its hands configuration
 * keeps answering 200 while quietly burning the pool, and the first symptom is
 * a block rate that climbs for a week. This codebase has found that class of
 * bug repeatedly. So the binding refuses, loudly, at the top of the action,
 * before it has spent a round trip or frozen anything it cannot then use.
 *
 * A worker in this state also says so AT STARTUP, with `host.no_hands`. This
 * error is the second line of defence, not the first: an absent capability that
 * only announces itself on the request that needed it is the defect that put
 * `/v1/agent` in production selling a pointer it did not have.
 */
export class HandsUnavailableError extends Error {
  /** The action type that needed hands: `click`, `hover`, `scroll`, `drag`, `fill`, `press`. */
  readonly action: string;

  constructor(action: string) {
    const pointer = action === 'click' || action === 'hover' || action === 'scroll' || action === 'drag';
    super(
      `${action} is ${pointer ? 'pointer' : 'keyboard'} input and this worker has no ` +
        'agenthands port configured. Refusing rather than falling back to ' +
        `${pointer ? 'Input.dispatchMouseEvent' : 'Input.insertText'}: ` +
        `a zero-variance synthetic ${pointer ? 'click' : 'keystroke'} through a residential ` +
        'exit burns the exit, and a silent downgrade from human to synthetic input is ' +
        'invisible until the block rate moves. See the host.no_hands line at startup.',
    );
    this.name = 'HandsUnavailableError';
    this.action = action;
  }
}

/**
 * `attachFile` cannot reach the file it named.
 *
 * Two causes, one class, two messages: this run was granted no files at all,
 * or it holds no file under that handle. Both are step failures the model
 * reads on its next prompt rather than run-ending throws, because naming a
 * file that does not exist is an ordinary wrong guess and the model can pick
 * again — the same treatment a bad node reference gets.
 *
 * What it must never be is a NO-OP. An `attachFile` that silently did nothing
 * would leave the run submitting an empty form and reporting the step a
 * success, and the customer would see a task fail three steps later on a page
 * whose state nobody can explain from the trace.
 */
export class FilesUnavailableError extends Error {
  constructor(why: string) {
    super(`attachFile: ${why}`);
    this.name = 'FilesUnavailableError';
  }
}

/**
 * The action names a node in a different frame than this session is attached
 * to.
 *
 * `DOMNodeIds::IdToNodeMap()` is a per-**renderer-process** static, and under
 * Site Isolation a cross-origin iframe is a different renderer process. Two
 * live nodes in two frames therefore routinely carry the same
 * `backendNodeId`. Sending another frame's id to `DOM.getBoxModel` on this
 * session does not fail — it resolves against whatever node happens to hold
 * that id in this renderer, and the click lands somewhere real and wrong. That
 * is why the frame ordinal is half of the reference rather than an argument
 * travelling beside it, and why the check is here rather than assumed upstream.
 *
 * Reaching an out-of-process frame needs a CDP session attached to that
 * frame. `pageBinding` now attaches one itself when the frame is an
 * out-of-process iframe of ITS OWN tab — see `sessionFor` — so this error
 * fires only when no session can be established at all: a reference minted
 * on a genuinely different tab (`tabbedBinding`'s `asTabRefusal` relabels
 * that case; see {@link WrongTabRefError}), or a frame ordinal no live frame
 * of this tab will confirm.
 */
export class CrossFrameRefError extends Error {
  readonly ref: NodeRef;
  readonly sessionFrameOrdinal: number;

  constructor(
    ref: NodeRef,
    sessionFrameOrdinal: number,
    reach?: { readonly confirmed: readonly number[]; readonly attached: number; readonly unanswered: number },
  ) {
    super(
      `node ${ref.frameOrdinal}-${ref.backendNodeId} belongs to frame ${ref.frameOrdinal}, ` +
        `but this session is attached to frame ${sessionFrameOrdinal}. Backend node ids are ` +
        'per-renderer-process and collide across frames under Site Isolation, so resolving ' +
        'this id here would silently act on a different element. Attach a session to the ' +
        'owning frame instead.' +
        // WHAT THIS TAB COULD REACH, when discovery ran. Measured 2026-09-23: this
        // refusal still fired in production on a checkout whose popup is a
        // cross-origin iframe, while the same discovery confirmed every iframe it
        // was shown on the fleet's own binary -- and without this sentence the
        // two could not be told apart from the run record. It is also the answer
        // a customer reading the error needs: which frames were in reach.
        (reach === undefined
          ? ''
          : ` Frames this tab could reach: [${reach.confirmed.join(', ')}]; ` +
            `${String(reach.attached)} iframe session(s) attached, ` +
            `${String(reach.unanswered)} of them never confirmed a frame.`),
    );
    this.name = 'CrossFrameRefError';
    this.ref = ref;
    this.sessionFrameOrdinal = sessionFrameOrdinal;
  }
}

/**
 * An action reached `perform` that `perform` does not execute.
 *
 * `extract` is routed to `AgentDeps.extract` by the loop and `done`/`fail` end
 * the run without touching the page. One arriving here means the loop changed
 * or a caller is driving `perform` directly, and returning an empty
 * `PerformOutcome` would record a step that did nothing as a step that
 * succeeded — a run that reports `done` having performed no action at all.
 */
export class UnperformableActionError extends Error {
  readonly action: string;

  constructor(action: string) {
    super(
      `perform(${action}) is not a page action: 'extract' is routed to AgentDeps.extract and ` +
        "'done'/'fail' terminate the run. Refusing rather than succeeding silently.",
    );
    this.name = 'UnperformableActionError';
    this.action = action;
  }
}

/**
 * The node an action named could not be brought inside the viewport, so no
 * coordinate exists that would land on it.
 *
 * ── Why this is a named outcome and not a click into space ──────────────────
 *
 * `DOM.getBoxModel` answers in VIEWPORT coordinates (measured 110/110 by
 * the since-deleted `measure-input-fidelity.ts`; the fork's PDL says so for the pointer path it
 * feeds). Nothing scrolled before the aim, so a node below the fold was
 * dispatched at its document position — `y=2216` in an 841 px window on
 * `sess_560d235c-5a93-4d0d-9fc8-82f227db0bf3` — and the browser clamps or
 * drops it. The page did not change, the accessibility tree came back
 * byte-identical, the model re-read it and chose the same node again. Four
 * bench rows spent 29, 29, 34 and 37 consecutive reads that way and ended
 * `loop-detected`.
 *
 * So the silence was the expensive part: a click that hit nothing was recorded
 * as a step that worked. This error is what the run observes instead. It is
 * caught by the loop as the step's `error`, `compactHistory` renders it into
 * the very next prompt under "Distinct failures already seen, do not repeat
 * them", and `stepFailures` bounds a model that keeps choosing it — the same
 * recovery path a bad node reference and a refused rule already take. Naming a
 * real outcome rather than failing quietly is what `loop-detected` and
 * `account-exhausted` do for a run; this does it for a step.
 */
export class OffScreenTargetError extends RefusedActionError {
  readonly ref: NodeRef;
  /** Where the node's box was when the attempt gave up, viewport-relative. */
  readonly box: HandsTarget;
  readonly viewport: { readonly width: number; readonly height: number };
  /**
   * How many scroll gestures were sent trying to reach it. When this is above
   * zero the page HAS moved, so the message says so and does not claim that
   * nothing was dispatched.
   */
  readonly scrolls: number;

  constructor(options: {
    readonly action: string;
    readonly ref: NodeRef;
    readonly box: HandsTarget;
    readonly viewport: { readonly width: number; readonly height: number };
    readonly scrolls: number;
    readonly why: string;
    /** What to do instead, when the cause names something better than another way round. */
    readonly remedy?: string;
  }) {
    const { action, ref, box, viewport, scrolls, why } = options;
    super(
      `off-screen-target: ${action} names node ${ref.frameOrdinal}-${ref.backendNodeId}, whose box is ` +
        `${box.width.toFixed(0)}x${box.height.toFixed(0)} at (${box.x.toFixed(0)}, ${box.y.toFixed(0)}) ` +
        `in a ${String(viewport.width)}x${String(viewport.height)} viewport — ${why}. ` +
        (scrolls === 0
          ? 'There is no coordinate that lands on it, and nothing was dispatched.'
          : `${String(scrolls)} scroll gesture(s) were sent without bringing it into view, so no press ` +
            'was sent, and the page stays where those gestures left it.') +
        ` ${options.remedy ?? 'Reach it another way: a link to the page that shows it, or {"type":"extract"} if you only need to read it.'}`,
      formatNodeRef(ref),
    );
    this.name = 'OffScreenTargetError';
    this.ref = ref;
    this.box = box;
    this.viewport = viewport;
    this.scrolls = scrolls;
  }
}

/** What `DOM.getNodeForLocation` names at a point: the element, and the frame it is in. */
export type Hit = { readonly backendNodeId: number; readonly frameId: string };

/** A node of the tree the model is shown, as a refusal names it: `button "Close" [0-12]`. */
export interface ShownNode {
  readonly ref: NodeRef;
  readonly role: string;
  readonly name?: string;
}

/** What a refusal can say about the thing drawn over a click's target. */
export interface CoverAccount {
  /** `<tag#id> "label"`, the element the hit test named. */
  readonly element: string;
  /** The cover as the tree shows it: the element itself, or its nearest ancestor the tree has. */
  readonly shown?: ShownNode;
  /**
   * What the cover is part of, when that is something over the page rather
   * than the page itself: an open dialog (`<dialog>`, `aria-modal="true"`,
   * or the backdrop of one), or an element fixed or sticky to the viewport (a
   * cookie banner, a sticky bar). Its node in the tree when the tree has it,
   * and the controls in it whose names say they put it away.
   */
  readonly overlay?: {
    readonly kind: 'dialog' | 'fixed';
    readonly node?: ShownNode;
    readonly dismiss: readonly ShownNode[];
  };
  /** How many times a click on this same node has now been refused as covered, this one included. */
  readonly refusals: number;
}

function shownText(node: ShownNode): string {
  return `${node.role}${node.name === undefined || node.name === '' ? '' : ` ${JSON.stringify(node.name.slice(0, 60))}`} [${formatNodeRef(node.ref)}]`;
}

/**
 * An overlay as a refusal names it — what it is, and what puts it away — for
 * a click it covers ({@link CoveredTargetError}) and for a page it holds still
 * ({@link OffScreenTargetError}).
 */
export function overlayAccount(overlay: NonNullable<CoverAccount['overlay']>): { readonly what: string; readonly remedy: string } {
  const node = overlay.node === undefined ? '' : ` (${shownText(overlay.node)})`;
  const close =
    overlay.dismiss.length > 0 ? `Close it with ${overlay.dismiss.map(shownText).join(' or ')}, then try again.` : undefined;
  return overlay.kind === 'dialog'
    ? { what: `a dialog open over the page${node}`, remedy: close ?? 'Answer or close it first: use its own controls, or press Escape.' }
    : { what: `something fixed over the page${node}`, remedy: close ?? 'Close it if it can be closed, or reach this control another way.' };
}

/**
 * A click whose target is drawn under something else, everywhere it is on
 * screen.
 *
 * Dispatched anyway, the press lands on the cover: the target's page does not
 * change and the check reports "nothing on the page changed" about a click
 * that never reached it. MEASURED on the fleet 2026-09-25 (`/connect`, n=1):
 * once a maps site's drawer is open its "Menu" button is painted over by the
 * drawer's logo image — the shape of `run_fa5c9309` (GMap--28), four clicks on
 * "Menu" that each "changed nothing" before the run stopped.
 *
 * ALWAYS A REFUSAL, never a keystroke in the click's place. Focusing the
 * target and pressing Enter would activate a control no pointer could reach,
 * which no person at that screen can do, and it would do it without the
 * model's knowledge on whatever the key means there — a purchase button
 * included. The model is told what is over the target and decides.
 *
 * WHAT IS OVER IT IS NAMED THE WAY THE MODEL CAN ACT ON IT. A bare `<div>`
 * told the model nothing it could click: `run_e3086fc2` (phys.org, 2026-09-26)
 * clicked a breadcrumb four times under a paywall dialog's backdrop, whose own
 * "Skip for now" button was one click away, and `run_cbe2f5bf` (a shopping
 * search) clicked a card's star rating twice under the same card's
 * stretched link `<a class="clickable-card">` — the link whose `role=link`
 * wrapper it had clicked at step 5. So an overlay is called an overlay, with
 * the reference of its closing control when the tree has one, and a cover
 * that is a control is named by its role, name and reference. A SECOND
 * refusal of the same click says so, so the model does not spend a third
 * step on it, and says the node is now left out of the page it is shown
 * while the cover stands (`shown`, from `parkCovered`): MEASURED 2026-09-28,
 * production 7 days, 43 of 194 covered-target steps were such repeats, and
 * `run_bc9b76c6` ended on "refusal 3 of this same click".
 */
export class CoveredTargetError extends RefusedActionError {
  readonly ref: NodeRef;
  readonly cover: CoverAccount;

  constructor(action: string, ref: NodeRef, cover: CoverAccount, shown?: string) {
    const again =
      cover.refusals > 1
        ? ` This is refusal ${String(cover.refusals)} of this same ${action}: sending it again will be refused again, ` +
          `so do something different${shown === undefined ? '' : `; ${shown}`}.`
        : '';
    const control =
      cover.shown !== undefined && ACTIONABLE_ROLES.has(cover.shown.role)
        ? ` What is drawn over it is ${shownText(cover.shown)}, a different control from the one you named. ` +
          `If that is what you meant, click [${formatNodeRef(cover.shown.ref)}]; otherwise reach this one another way.`
        : undefined;
    let next: string;
    const overlay = cover.overlay;
    if (overlay?.kind === 'dialog') {
      const { what, remedy } = overlayAccount(overlay);
      next = ` It is ${what}, and nothing under it can be clicked until it is closed. ${remedy}`;
    } else if (overlay !== undefined) {
      const { what, remedy } = overlayAccount(overlay);
      const closable = overlay.dismiss.length > 0;
      next =
        ` It is part of ${what}, which stays where it is when the page scrolls.` +
        (closable ? ` ${remedy}` : '') +
        (control ?? (closable ? '' : ` ${remedy}`));
    } else if (control !== undefined) {
      next = control;
    } else {
      next =
        (cover.shown === undefined ? '' : ` It belongs to ${shownText(cover.shown)}.`) +
        ' Close or use whatever is open over it, then try again.';
    }
    super(
      `covered-target: ${action} names node ${ref.frameOrdinal}-${ref.backendNodeId}, and everywhere it is ` +
        `on screen something else is drawn on top of it (${cover.element}), so a press there would land on that ` +
        `instead. Nothing was dispatched.${again}${next}`,
      formatNodeRef(ref),
    );
    this.name = 'CoveredTargetError';
    this.ref = ref;
    this.cover = cover;
  }
}

/**
 * A click on a form control the page has disabled with the `disabled`
 * attribute. The browser runs no activation for a press on one — no `click`,
 * no submit, no toggle — so dispatching it would be a step that did nothing
 * and a "nothing changed" check the model cannot explain.
 *
 * MEASURED 2026-09-26 (production `/connect`, n=1): before hydration a maps
 * site paints a placeholder "Menu", `<button disabled>`, and swaps in the
 * real one about 3 s after navigation. Both refused runs had clicked the
 * placeholder at step 1, and were told it was off screen with "no area to
 * click" — both false. This says what is true and what usually changes it.
 *
 * Only the target's OWN native attribute, on the elements it disables. A
 * control disabled by an ancestor `<fieldset disabled>` is not read (that is an
 * ancestor walk per click) and is pressed as before. `aria-disabled` is a
 * label the page may still act on (a press that explains what is missing), so
 * a click on one is sent.
 */
export class DisabledTargetError extends RefusedActionError {
  readonly ref: NodeRef;

  constructor(action: string, ref: NodeRef, tag: string) {
    super(
      `disabled-target: ${action} names node ${formatNodeRef(ref)}, a <${tag}> the page has disabled, so a ` +
        'press on it does nothing. Nothing was dispatched. A control like this usually enables once the page ' +
        'finishes loading or once what it needs is filled in: read the page again, and act on what it asks ' +
        'for first.',
      formatNodeRef(ref),
    );
    this.name = 'DisabledTargetError';
    this.ref = ref;
  }
}

/** The elements the `disabled` attribute disables, per the HTML spec. */
export const DISABLEABLE_TAGS: Readonly<Record<string, true>> = {
  button: true,
  input: true,
  select: true,
  textarea: true,
  optgroup: true,
  option: true,
  fieldset: true,
};

/**
 * A press on a native `<select>` that opens its list as a popup menu. Nothing
 * is dispatched: choosing an option is `select`, which types the option's first
 * letters into the focused select (Blink's type-ahead, which opens no menu) and
 * needs no popup. See `performSelect`.
 *
 * THE POPUP IS NOT IN THE PAGE AND IT BREAKS THE BROWSER. On macOS, which is
 * every fleet machine, Chromium draws it as a native menu, and while that menu
 * is open the browser cannot close any window whose page has unload handlers:
 * `Target.disposeBrowserContext` for every such context goes unanswered and the
 * context stays in the browser. Measured on the fleet 2026-09-25/26: each of the
 * three episodes (two machines, 22:09Z, 03:52Z and 04:03Z; 77 unanswered
 * disposes) began seconds after an agent clicked the Stack Exchange sort
 * `<select>` (run_7b4e55f3, run_ad66fd22, run_0f0582f6), and both browsers
 * still up at 04:21Z showed a menu-level window on screen. Reproduced on one of them
 * against the fleet's own binary (2026-09-26 04:2x-04:47Z): with a `<select>`
 * menu open, 15/15 disposes of a page with an unload handler got no answer in
 * 40 s, 3/3 of a page without one answered in 5-16 ms, and 9/9 stalled disposes
 * answered once the menu was dismissed (blur, navigate, or disposing the
 * menu's own context). When the menu's own page has an unload handler its
 * context cannot be disposed either (3/3), so nothing ever dismisses the menu:
 * the browser stays wedged until it exits.
 *
 * A `<select multiple>` or one with `size` > 1 is a list box drawn in the page,
 * with no popup, and is pressed like anything else.
 */
export class NativeSelectPopupError extends RefusedActionError {
  readonly ref: NodeRef;

  constructor(action: string, ref: NodeRef) {
    super(
      `native-select: ${action} names node ${formatNodeRef(ref)}, a dropdown whose list the operating system ` +
        'draws outside the page. Nothing was dispatched. Choose from it with `select` and the option you want — ' +
        'its options are listed under it in the page read.',
      formatNodeRef(ref),
    );
    this.name = 'NativeSelectPopupError';
    this.ref = ref;
  }
}

/** Whether a `<select>` opens its options as a popup menu rather than a list box in the page. */
export function opensPopupMenu(element: DescribedElement): boolean {
  if (element.tag !== 'select' || element.attribute('multiple') !== undefined) return false;
  const size = Number.parseInt(element.attribute('size') ?? '', 10);
  return !(size > 1);
}

/**
 * The node an action named has no box to aim at, so nothing was dispatched.
 *
 * Two causes, both straight from `DOM.getBoxModel`, and they ask different
 * things of the model. MEASURED in production, 30 days to 2026-09-24: 20
 * clicks over 17 runs failed "Could not compute box model" — the node is in
 * the tree but not laid out (a closed menu or listbox, a responsive duplicate
 * hidden at this width) — and 9 over 5 runs failed "No node found for given
 * backend id" — the node was replaced after the page was read. Both used to
 * reach the model as the raw protocol string, which said neither, and
 * run_920a025a clicked the same replaced node on three consecutive steps.
 *
 * Refused rather than healed. The XPath the tree carries could find a
 * replacement, and a node found that way after the page changed is exactly
 * how a click lands on the wrong thing. The next read has the live node.
 */
export class UnmeasurableTargetError extends RefusedActionError {
  readonly ref: NodeRef;
  readonly reason: 'not-rendered' | 'replaced';

  constructor(action: string, ref: NodeRef, reason: 'not-rendered' | 'replaced') {
    super(
      `${action} names node ${formatNodeRef(ref)}, which ` +
        (reason === 'not-rendered'
          ? 'is on the page but not displayed right now (hidden, collapsed, or inside a menu or ' +
            'list that is closed), so it has no position to act on. Open whatever shows it first, ' +
            'or choose an element that is visible.'
          : 'no longer exists: the page replaced it after it was read. Choose it again from the ' +
            'page as it is now; the old reference will not come back.') +
        ' Nothing was dispatched.',
      formatNodeRef(ref),
    );
    this.name = 'UnmeasurableTargetError';
    this.ref = ref;
    this.reason = reason;
  }
}

/**
 * A point-aimed click or a drag the host will not dispatch, and why. Refused
 * before any input: every check below is a read under the freeze.
 *
 * NOT CLAMPED ONTO THE EDGE. A point past the viewport is a model that read a
 * picture at the wrong scale or copied a document coordinate, and the element
 * at the nearest edge is one it never pointed at. The message names the
 * viewport it measured, which is the one fact that model is missing.
 */
export class PointerAimRefusedError extends RefusedActionError {
  readonly reason: 'outside-viewport' | 'nothing-there' | 'embedded-frame' | 'too-short' | 'too-long' | 'split-frames';

  constructor(action: string, reason: PointerAimRefusedError['reason'], detail: string) {
    const message = `${action} refused (${reason}): ${detail} Nothing was dispatched.`;
    // The point or the ends are in `detail`, so the same sentence is the same refusal.
    super(message, message);
    this.name = 'PointerAimRefusedError';
    this.reason = reason;
  }
}

/**
 * A step needed a model and the binding was given none (`model: null`).
 * Refused at the point of use, so a binding with no model still navigates,
 * fills and presses. A host names its own cause through
 * `BindingHooks.modelUnavailable`.
 */
export class NoModelError extends Error {
  /** What was being attempted: `model` or `extract`. */
  readonly attempted: string;

  constructor(attempted: string) {
    super(`${attempted} needs a model and this binding was given none: pass one as \`model\`.`);
    this.name = 'NoModelError';
    this.attempted = attempted;
  }
}
