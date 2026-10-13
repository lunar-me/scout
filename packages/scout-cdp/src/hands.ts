import type { MaybePromise } from './tabs';

/* ------------------------------------------------------------------ *
 * agenthands: the pointer seam
 * ------------------------------------------------------------------ */

/** `Outcrawl.PointerSample`. `pressure` absent is not `pressure: 0`; see the PDL. */
export type PointerSample = {
  /** CSS pixels, viewport-relative. */
  readonly x: number;
  readonly y: number;
  /** Milliseconds from the first sample. Non-decreasing. */
  readonly offsetMs: number;
  readonly pressure?: number;
};

/** The parameter object `Outcrawl.dispatchPointerPath` takes, verbatim. */
export type PointerPathParams = {
  /** 1..4096 samples. The field is named `path`; anything else fails to deserialise. */
  readonly path: readonly PointerSample[];
  readonly pointerType?: 'mouse' | 'pen';
  /** `Input.dispatchMouseEvent` bitmask: 1 left, 2 right, 4 middle, 8 back, 16 forward. */
  readonly buttons?: number;
};



/** `Outcrawl.WheelPhase`. `none` is legal only alongside a `momentumPhase`. */
export type WheelPhase = 'none' | 'began' | 'changed' | 'stationary' | 'ended' | 'cancelled';

/** `Outcrawl.WheelSample`. */
export type WheelSample = {
  readonly offsetMs: number;
  /** CSS pixels. Positive `deltaY` scrolls the content down. */
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly phase: WheelPhase;
  readonly momentumPhase?: WheelPhase;
};

/** The parameter object `Outcrawl.dispatchWheelPath` takes, verbatim. */
export type WheelPathParams = {
  readonly path: readonly WheelSample[];
  /** One position for the whole gesture: the wheel-latching slop region is 10 CSS px. */
  readonly x: number;
  readonly y: number;
  readonly granularity?: 'precisePixel' | 'pixel';
  /** 1 alt, 2 ctrl, 4 meta, 8 shift. Constant for the whole path by construction. */
  readonly modifiers?: number;
};

/**
 * The button half of a click.
 *
 * `dispatchPointerPath` carries moves only, and the PDL says why: a path that
 * changed its button state mid-flight would stop coalescing, because
 * `WebMouseEvent::CanCoalesce` requires equal modifiers, pointer id and pointer
 * type. So press and release stay on `Input.dispatchMouseEvent` — which is
 * fine for *when* the press is sent, which is `agenthands`'s to decide through
 * {@link HandsStep.delayMs}.
 *
 * IT IS NOT FINE BY DEFAULT, and the comment that used to end here said it was.
 * Timing is not the only observable on a press. Three fields decide whether the
 * button transition matches real hardware, and all three default wrong:
 *
 *   * `force`. MEASURED against our own binary on the fleet Mac: a
 *     `mousePressed` without it delivers `PointerEvent.pressure` **0.0**, and
 *     with `force: 0.5` delivers **0.5**. Real desktop hardware leaves
 *     `PointerDetails::force` at NaN, and Blink's `GetPointerEventPressure`
 *     turns NaN into 0.5 while a button is held — so 0.5 is not an
 *     approximation of real hardware, it is the identical value. The 0.0 comes
 *     from `Input.dispatchMouseEvent` defaulting `force` to 0
 *     (`content/browser/devtools/protocol/input_handler.cc:515`), which this
 *     fork does NOT patch. No physical mouse can report 0.0 on a pressed
 *     button, so a humanised approach path ending in one is a louder tell than
 *     a teleport: everything about the gesture is right except a field only a
 *     synthetic press can produce. `isTrusted` was `true` in both arms of the
 *     probe, so trust is not the discriminator and pressure is the whole of it.
 *   * `clickCount`. Absent means `MouseEvent.detail === 0`. Every real click is
 *     `detail: 1`.
 *   * `buttons`. 1 while held, 0 on release. Coupled to `force`, because Blink
 *     zeroes `pressure` whenever `buttons` is empty, for every pointer type —
 *     which is also why `force` on a `mouseReleased` is a no-op and this
 *     module's planner does not send one.
 */
export type MouseButtonParams = {
  readonly type: 'mousePressed' | 'mouseReleased';
  readonly x: number;
  readonly y: number;
  readonly button: 'left' | 'right' | 'middle' | 'back' | 'forward';
  readonly buttons?: number;
  readonly clickCount?: number;
  readonly modifiers?: number;
  readonly pointerType?: 'mouse' | 'pen';
  /** [0,1]. Send 0.5 on a press; see the note above. Absent is `pressure` 0.0. */
  readonly force?: number;
};

/**
 * One key transition. `Input.dispatchKeyEvent` parameters, verbatim.
 *
 * Built by {@link keyEventParams}, which is the single source of truth for the
 * `code` and `windowsVirtualKeyCode` a named key needs. A planner that filled
 * these in itself would be the second copy of that table.
 */
export type KeyEventParams = {
  readonly type: 'keyDown' | 'keyUp';
  readonly key: string;
  readonly code: string;
  readonly windowsVirtualKeyCode: number;
  readonly nativeVirtualKeyCode: number;
  readonly text?: string;
  /** Held modifiers as CDP's bit field: 2 Control, 4 Meta. Only the select-all chord sets it. */
  readonly modifiers?: number;
  /**
   * Editing commands the renderer runs with this key. The select-all chord
   * needs it on macOS, where Cmd+A is the application menu's shortcut and a
   * synthetic key event never reaches that menu.
   */
  readonly commands?: readonly string[];
};

/**
 * One dispatch in a gesture plan.
 *
 * `delayMs` is idle **before** this dispatch, and it is not a convenience: the
 * dwell between press and release is the click duration, and a plan whose steps
 * were fired back to back would produce a 0 ms click on every element on the
 * internet. Keeping the number in the plan keeps the whole timing model in
 * `agenthands`, which measures it, rather than half here.
 */
export type HandsStep =
  | { readonly command: 'Outcrawl.dispatchPointerPath'; readonly params: PointerPathParams; readonly delayMs?: number }
  | { readonly command: 'Outcrawl.dispatchWheelPath'; readonly params: WheelPathParams; readonly delayMs?: number }
  | { readonly command: 'Input.dispatchMouseEvent'; readonly params: MouseButtonParams; readonly delayMs?: number }
  | { readonly command: 'Input.dispatchKeyEvent'; readonly params: KeyEventParams; readonly delayMs?: number };

/** Viewport-relative CSS-pixel geometry of the element an action names. */
export interface HandsTarget {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What the planner needs about the page that is not in the target box. */
export interface HandsContext {
  /**
   * Where this binding's last dispatched path left the pointer, if it has
   * dispatched one. Absent means the pointer position is unknown, and a plan
   * that starts from an unknown position has to start somewhere plausible
   * rather than teleporting to the target.
   */
  readonly from?: { readonly x: number; readonly y: number };
  /** CSS layout viewport, so a planned path cannot leave the window. */
  readonly viewport: { readonly width: number; readonly height: number };
}

/** A wheel gesture: over a container when `target` is set, over the page otherwise. */
export interface HandsScrollRequest {
  readonly target?: HandsTarget;
  readonly dx: number;
  readonly dy: number;
}

/**
 * The timing model, injected. `agenthands` is the production implementation.
 *
 * This is a **planner, not a driver**: it returns the parameter objects the
 * browser's commands take and this binding dispatches them verbatim. That split
 * is the whole point. The PDL is explicit that samples are dispatched verbatim
 * — it is what makes those commands correct for replaying a captured human
 * during a takeover, where re-modelling measured input would replace human
 * signal with modelled signal. A driver that "helpfully" resampled, clamped or
 * re-timed a path would destroy exactly the property the commands were added
 * for.
 *
 * **Keyboard is here too, and it is not a separate port.** The owner's
 * requirement is one input layer that every action routes through, and two
 * ports would be two things to bind and one of them would eventually be left
 * unbound — which is the entire history of this file. `type` and `press` take
 * no {@link HandsContext} because a keystroke has no geometry and does not move
 * the pointer.
 *
 * There is no default implementation and no fallback, for pointer OR keyboard.
 * See {@link HandsUnavailableError}.
 */
export interface HandsPort {
  click(target: HandsTarget, context: HandsContext): MaybePromise<readonly HandsStep[]>;
  hover(target: HandsTarget, context: HandsContext): MaybePromise<readonly HandsStep[]>;
  scroll(request: HandsScrollRequest, context: HandsContext): MaybePromise<readonly HandsStep[]>;
  /**
   * Press inside `from`, move to inside `to` with the button HELD, release.
   *
   * The held stretch is ONE `Outcrawl.dispatchPointerPath` carrying
   * `buttons: 1`, which the fork turns into `kLeftButtonDown` on every move's
   * modifiers and `button: kLeft` on the event (`PointerPathModifiers` and
   * `PointerPathButton`, `0010-tenancy.patch:8442-8488`) — so the page sees
   * `pointermove`/`mousemove` with `buttons === 1` through the whole path,
   * coalesced exactly as a real drag's are, and `pressure` 0.5 because the
   * samples carry none (NaN, `0010-tenancy.patch:9491-9495`). Press and
   * release are `Input.dispatchMouseEvent` for the reason the PDL gives
   * (`0010-tenancy.patch:2631-2636`): a path that changed button state
   * mid-flight would stop coalescing. `from` and `to` are boxes on screen, in
   * the dispatch session's viewport; a point is a small box around it.
   */
  drag(from: HandsTarget, to: HandsTarget, context: HandsContext): MaybePromise<readonly HandsStep[]>;
  /**
   * What `fill` types: `text`, per character, with measured dwell, flight and
   * OVERLAP.
   *
   * `replace: true` opens with a select-all chord — the platform's modifier
   * held, A pressed under it — so the first character types over what the
   * field held. Without it a fill appended, and a model that re-filled a wrong
   * value doubled it instead of fixing it. `replace: false` sends no chord:
   * for focus that holds no text of its own, where select-all selects the
   * whole document (see `performFill`).
   *
   * Overlap is why this returns a flat step list rather than one step per
   * character: 17% of recorded keystrokes have the next key going down before
   * the current one comes up, and a per-character shape could not express it.
   */
  type(text: string, options: { readonly replace: boolean }): MaybePromise<readonly HandsStep[]>;
  /** One key, down and up, with the measured hold between them. */
  press(key: string): MaybePromise<readonly HandsStep[]>;
}
