// The wheel timing model, as a path.
//
// WHY A PATH AND NOT A LOOP
//
// A scroll device does not emit independent wheel events. It emits GESTURES:
// the platform stamps the first event of a gesture, every event after it, and
// the lift at the end, and the browser reads those stamps to decide where one
// scroll starts and the previous one finished. On macOS the field is
// `NSEvent.phase`, and Chromium carries it as `WebMouseWheelEvent::phase`.
//
// `Input.dispatchMouseWheel` has no parameter for it. It stamps every event
// `kPhaseBegan` and then sends a synthetic `kPhaseEnded` behind it, so each
// event is a complete one-event gesture. Two things a page can read fall out of
// that, both measured against a real trackpad on a real build:
//
//   | signal                        | trackpad | dispatchMouseWheel |
//   |-------------------------------|----------|--------------------|
//   | cancelable wheel events       | 1 of 134 | 199 of 199         |
//   | `scrollend` events            | 1        | 136                |
//
// `scrollend` needs no wheel listener at all to observe. Neither signal can be
// reached from JavaScript, and neither is a property of the timing model in this
// file: they are properties of where the event enters the input stack, which is
// why `Outcrawl.dispatchWheelPath` exists. This module produces the path; that
// command is the entry point.
//
// Everything the cadence and the deltas are drawn from is measured and lives in
// `profile.ts`. See CALIBRATION.md.

import { type InputProfile } from './profile.js';
import { sample, type Rng } from './random.js';

/**
 * Phase of a wheel sample, in the spellings `Outcrawl.dispatchWheelPath` takes.
 *
 * A gesture is `began`, then `changed` for every event after the first, then a
 * zero-delta `ended` for the lift. `stationary` is a real device's "fingers
 * down, not moving" and `cancelled` is a gesture the platform abandoned; this
 * model emits neither, and they exist in the type because a caller replaying a
 * recorded human may have captured them.
 */
export type WheelPhase = 'began' | 'changed' | 'stationary' | 'ended' | 'cancelled';

/** One wheel event, placed on the gesture's own clock. */
export interface WheelSample {
  /** Milliseconds from the start of the path. Non-decreasing; the first is 0. */
  offsetMs: number;
  /** CSS pixels. Positive scrolls the content down, as `mouse.wheel` does. */
  deltaX: number;
  deltaY: number;
  phase: WheelPhase;
  /**
   * macOS momentum, for a caller replaying a recorded gesture that had one.
   *
   * NOT SYNTHESISED HERE, deliberately. Momentum is a decaying delta ramp after
   * the fingers lift, and no momentum sample exists in this library's corpus -
   * the trackpad capture behind `wheelDelta` and `wheelEventGap` holds two
   * gestures and records no phase at all. Inventing a decay constant is exactly
   * the kind of guess this project replaced everywhere else, and it is not
   * needed: a scroll that ends without momentum is what a slow deliberate drag
   * produces, which is the common case and a real device shape.
   */
  momentumPhase?: 'began' | 'changed' | 'ended' | 'cancelled';
}

/**
 * A whole scroll - one or more gestures separated by the measured pause - ready
 * for a single `Outcrawl.dispatchWheelPath` call.
 *
 * Every field name is that command's parameter name, so the object goes over
 * the wire verbatim and no caller writes a mapping step. `path` rather than
 * `samples` for exactly that reason: measured against the shipped binary, the
 * object with a `samples` field is refused with `Failed to deserialize
 * params.path - BINDINGS: mandatory field missing`, which is a rename nobody
 * discovers until the first real scroll.
 */
export interface WheelPath {
  /** Viewport-relative CSS pixels. One point for the whole path. */
  x: number;
  y: number;
  path: WheelSample[];
  /**
   * `precisePixel` for a continuous device, `pixel` for a notched wheel.
   *
   * This is not a style knob. Chrome applies a precise-pixel scroll directly and
   * smooth-scroll ANIMATES a pixel one, and the difference is visible from the
   * page as scroll frames per wheel event: measured 1.00 for a real trackpad and
   * 21.75 for a real notched mouse on macOS, against the same 40px per event and
   * the same `deltaY`/`wheelDeltaY` pair in both. `Input.dispatchMouseWheel`
   * always sends precise-pixel, so a wheel-mouse profile sent through it emits
   * notch-sized deltas with trackpad physics.
   */
  granularity: 'precisePixel' | 'pixel';
}

/** Dispatches a path through a browser entry point that takes phases. */
export type WheelPathDispatcher = (path: WheelPath) => Promise<unknown>;

/**
 * Builds the gestures for a scroll of `deltaY` CSS pixels.
 *
 * Positive scrolls down. Distance lands exactly: the last event of the last
 * gesture is trimmed to whatever remains.
 *
 * The cadence goes in as `offsetMs` rather than as sleeps, so it is not subject
 * to a timer floor or to transport latency. That is the point of the batched
 * entry point: `scroll()`'s fallback route has to subtract a measured timer
 * overhead from every gap and dispatch without awaiting, because the CDP
 * round-trip is ~10ms against a measured 9.46ms cadence and would otherwise set
 * the floor. Here the browser holds the whole path and dispatches each sample at
 * its requested instant off one start time, so no such correction applies and
 * none is made.
 */
export function generateWheelPath(
  deltaY: number,
  at: { x: number; y: number },
  profile: InputProfile,
  rng: Rng,
): WheelPath {
  const direction = Math.sign(deltaY);
  let remaining = Math.abs(deltaY);
  const samples: WheelSample[] = [];
  let t = 0;

  while (remaining >= 1) {
    // One gesture: a run of events, then the lift, then the pause before the
    // next gesture starts.
    let budget = Math.max(1, Math.round(sample(profile.wheelGestureEvents, rng)));
    let first = true;

    while (budget > 0 && remaining >= 1) {
      if (!first) {
        t += sample(profile.wheelEventGap, rng);
      }
      // Integers, because that is what a real device reports: the macOS builder
      // reads its continuous deltas with `CGEventGetIntegerValueField`, and the
      // measured capture was 100% integer.
      const step = Math.max(1, Math.round(sample(profile.wheelDelta, rng)));
      const emit = Math.min(step, Math.round(remaining));
      samples.push({
        offsetMs: t,
        deltaX: 0,
        deltaY: direction * emit,
        phase: first ? 'began' : 'changed',
      });
      remaining -= emit;
      budget -= 1;
      first = false;
    }

    // The lift. Zero delta, which is what the platform sends and what the
    // browser needs to close the scroll transaction and fire one `scrollend`.
    // A gesture without it leaves the transaction open, which is its own tell in
    // the opposite direction.
    t += sample(profile.wheelEventGap, rng);
    samples.push({ offsetMs: t, deltaX: 0, deltaY: 0, phase: 'ended' });

    if (remaining >= 1) {
      t += sample(profile.wheelGesturePause, rng);
    }
  }

  return {
    x: at.x,
    y: at.y,
    path: samples,
    granularity: profile.wheelGranularity ?? 'precisePixel',
  };
}
