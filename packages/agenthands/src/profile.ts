// Measured human input profile.
//
// Every constant below was captured from real human sessions, not chosen by
// hand. See CALIBRATION.md for the method and the raw numbers, and harness/
// for the tooling to re-measure on your own hardware.
//
// Capture: 6 sessions, 1255 pointermove events, 25 clicks, 83 keystrokes,
// macOS trackpad, Chromium-family browser, 90x34px targets, August 2026.

import type { Distribution } from './random.js';

export interface InputProfile {
  name: string;

  // Landing offsets from element centre, as a FRACTION of element size, so the
  // spread scales with the control instead of being clamped away on small ones.
  clickOffsetX: Distribution;
  clickOffsetY: Distribution;

  // Milliseconds between pointerdown and pointerup. Humans are tightly
  // clustered here - high variance is as suspicious as none.
  clickDwell: Distribution;

  // Pause after the cursor arrives, before pressing.
  clickSettle: Distribution;

  // Keystroke hold time, and the gap between consecutive keydowns.
  keyDwell: Distribution;
  keyFlight: Distribution;

  // Probability a gap between keys is a "thinking" pause, and its shape.
  keyPauseChance: number;
  keyPause: Distribution;

  // Pointer event emission rate, kept for the wheel path and for reference.
  moveRateHzMin: number;
  moveRateHzMax: number;

  // Gap between emitted pointer samples, in ms.
  sampleGap: Distribution;

  // Per-sample positional noise, as a fraction of the inter-sample step.
  jitterFrac: number;

  // Multiplicative noise on each sample's advance along the stroke.
  speedNoise: number;

  // How far the path bows away from a straight line, as a fraction of distance.
  // Measured spread, not a fixed value: most strokes are nearly direct and a
  // few wander a long way.
  deviation: Distribution;

  // Corrective sub-movements after the ballistic thrust.
  submovements: Distribution;

  // Multiplier on the fitted duration-for-distance law.
  durationScale: Distribution;

  // Probability that a move sample lands in a frame the compositor misses.
  // Real pointer hardware reports independently of the display, so now and then
  // several samples pile into one frame and arrive as a single pointermove
  // carrying the rest in getCoalescedEvents(). Injected input never does this
  // on its own: every dispatch gets its own frame, so getCoalescedEvents()
  // returns exactly 1 forever, which is itself the tell. Both directions are
  // detectable - always 1 is robotic, but so is a high average, because that
  // would mean the display is dropping most of its frames.
  frameDropChance: number;

  // How many samples a missed frame swallows.
  frameDropBurst: Distribution;

  // Pixels of scroll per wheel tick - a PLATFORM constant, not a taste knob.
  // The browser derives wheelDeltaY from the tick count alone, so deltaY and
  // wheelDeltaY are locked in a fixed ratio on real hardware (macOS:
  // kScrollbarPixelsPerCocoaTick = 40, giving wheelDeltaY = -3 * deltaY).
  // Used to size the fallback whole-tick scroll, and to check that a browser
  // derives ticks from the delta. See CALIBRATION.md.
  wheelTickPx: number;

  // Pixels of scroll carried by one wheel event, and the gap between events
  // inside a single gesture. Continuous devices report many small deltas;
  // reproducing them needs a browser that derives ticks from the delta.
  wheelDelta: Distribution;
  wheelEventGap: Distribution;

  // Wheel events in one gesture, and the pause before the next gesture.
  wheelGestureEvents: Distribution;
  wheelGesturePause: Distribution;

  // Which scroll granularity this device reports, and therefore whether Chrome
  // applies the scroll directly or smooth-scroll ANIMATES it. A continuous
  // device sends precise pixels and is applied directly; a notched wheel sends
  // pixels and is animated. Measured on macOS at the same 40px per event: 1.00
  // scroll frames per wheel event for a trackpad, 21.75 for a notched mouse.
  //
  // Only reachable through a batched entry point that carries it.
  // `Input.dispatchMouseWheel` hardcodes precise pixels, so over plain CDP a
  // wheel-mouse profile emits notch-sized deltas with trackpad physics.
  //
  // Optional so that a caller's own hand-written profile keeps compiling; absent
  // means `precisePixel`, which is what a continuous device reports and what
  // every stock CDP wheel event already is.
  wheelGranularity?: 'precisePixel' | 'pixel';
}

// Measured values. Offsets are pixel measurements divided by the target size
// they were captured against (90x34), which converts them to fractions.
export const HUMAN: InputProfile = {
  name: 'measured-2026-08',

  clickOffsetX: { mean: 8.07 / 90, sd: 15.04 / 90, min: -0.42, max: 0.42 },
  clickOffsetY: { mean: 2.26 / 34, sd: 5.29 / 34, min: -0.4, max: 0.4 },

  // Quantiles pooled from Balabit (n=148,860 clicks) and the SERP browser
  // dataset (n=2,901); the two agree closely on both centre and spread. An
  // earlier 25-click sample put sd at 13.7, which was far too tight - real
  // click dwell has a long right tail.
  clickDwell: {
    mean: 105,
    sd: 38,
    min: 45,
    max: 420,
    quantiles: [
      [0.02, 50], [0.10, 72], [0.25, 82], [0.50, 100],
      [0.75, 128], [0.90, 168], [0.98, 240], [0.997, 380],
    ],
  },
  clickSettle: { mean: 150, sd: 70, min: 40, max: 400 },

  // KeyRecs, 99 participants: n=197,718 dwells typing a known string. Confirms
  // the earlier 83-keystroke sample almost exactly (median 91 vs mean 83.7)
  // and only widens the tail.
  keyDwell: {
    mean: 96,
    sd: 31,
    min: 25,
    max: 260,
    quantiles: [
      [0.02, 48], [0.10, 63], [0.25, 75], [0.50, 91],
      [0.75, 112], [0.90, 137], [0.98, 178], [0.997, 240],
    ],
  },

  // Down-to-down. The earlier sample topped out at 260ms, which truncated a
  // tail that is genuinely long even when the typist knows the string
  // (KeyRecs fixed-text, n=177,634: median 216, p90 616). Values here sit
  // between that and the faster cadence measured filling a form field, since
  // typing an address you know by heart is quicker than a random string.
  keyFlight: {
    mean: 165,
    sd: 120,
    min: 30,
    max: 900,
    quantiles: [
      [0.02, 45], [0.10, 75], [0.25, 105], [0.50, 150],
      [0.75, 225], [0.90, 360], [0.98, 620], [0.997, 880],
    ],
  },

  keyPauseChance: 0.035,
  keyPause: { mean: 300, sd: 140, min: 140, max: 610 },

  moveRateHzMin: 60,
  moveRateHzMax: 80,

  // SERP, n=189,418 gaps measured strictly within a stroke. A tight core on
  // the frame interval, and only 6% of samples past 30ms. An earlier figure
  // put the CV at 0.95, but that filtered gaps loosely and swept in the pauses
  // *between* strokes; within a stroke it is 0.58.
  sampleGap: {
    mean: 19, sd: 11, min: 8, max: 120,
    quantiles: [
      [0.02, 10], [0.10, 15], [0.25, 16], [0.50, 17],
      [0.75, 17], [0.90, 19], [0.94, 23], [0.98, 56],
    ],
  },

  jitterFrac: 0,
  speedNoise: 0,

  // Measured over 10,395 browser strokes (SERP), cross-checked against 53,293
  // from Balabit, which agrees on all three to within a few percent.
  deviation: {
    mean: 0.16, sd: 0.2, min: 0.004, max: 1.5,
    quantiles: [
      [0.10, 0.020], [0.25, 0.042], [0.50, 0.092],
      [0.75, 0.207], [0.90, 0.474], [0.98, 1.436],
    ],
  },
  submovements: {
    mean: 3.6, sd: 2.6, min: 1, max: 16,
    quantiles: [
      [0.10, 1], [0.25, 1], [0.50, 3], [0.75, 5], [0.90, 8], [0.98, 15],
    ],
  },
  durationScale: {
    mean: 1.05, sd: 0.6, min: 0.3, max: 3.2,
    quantiles: [
      [0.10, 0.42], [0.25, 0.66], [0.50, 0.97],
      [0.75, 1.42], [0.90, 2.15], [0.98, 3.0],
    ],
  },

  // Measured: 1255 pointermove events, mean 1.01 coalesced, max 7. Singles
  // dominate; bursts are rare and small. See CALIBRATION.md.
  frameDropChance: 0.011,
  frameDropBurst: { mean: 2.6, sd: 1.3, min: 2, max: 7 },

  // Platform constant: kScrollbarPixelsPerCocoaTick.
  wheelTickPx: 40,

  // Measured: 174 wheel events, macOS TRACKPAD - a continuous device, which
  // reports many small deltas in long runs. For a wheel mouse, which reports
  // discrete notches far more slowly, use HUMAN_WHEEL_MOUSE instead.
  // Pooled from two sources that measure this differently.
  //
  // A local capture read e.deltaY directly (n=174, mean 7.13, max 27) - exact,
  // but one device. The SERP browser dataset (216 trackpad-style sessions,
  // n=2,963) does not record deltaY at all, so per-event travel was recovered
  // by differencing scrollY between wheel events; those pages ran at 0.9 zoom,
  // and undoing it makes 100% of the values integers, which is the signature
  // of real device deltas and confirms the reconstruction. It reports a median
  // of 11 and a max of 40.
  //
  // The derived figures run about 2x the direct ones, consistent with that
  // logger sampling wheel events at ~32ms against a real ~9.5ms cadence, so
  // each logged event absorbs part of its neighbours. The centre therefore
  // stays near the direct measurement, which has no such bias, while the tail
  // follows the larger sample - a 174-event capture cannot see a p98.
  wheelDelta: {
    mean: 9.5,
    sd: 7.4,
    min: 1,
    max: 40,
    quantiles: [
      [0.02, 1], [0.10, 2], [0.25, 4], [0.50, 8],
      [0.75, 14], [0.90, 22], [0.98, 33],
    ],
  },
  wheelEventGap: { mean: 9.46, sd: 13.86, min: 0.4, max: 143.9 },

  // WEAKLY SAMPLED - the trackpad capture held only 2 gestures. The wheel-mouse
  // equivalents below rest on ~50,000 bursts across two datasets.
  wheelGestureEvents: { mean: 87, sd: 24, min: 20, max: 140 },
  wheelGesturePause: { mean: 271, sd: 150, min: 90, max: 900 },

  // A trackpad is continuous: `kCGScrollWheelEventIsContinuous` is set, so
  // web_input_event_builders_mac.mm takes its precise-pixel branch and the
  // scroll is applied without animation.
  wheelGranularity: 'precisePixel',
};

/**
 * Wheel mouse rather than trackpad. A notched wheel reports discrete ticks in
 * short bursts with long gaps, where a trackpad streams small deltas
 * continuously - a difference of two orders of magnitude in events per
 * gesture, so the two cannot be blended into one profile.
 *
 * Burst structure pooled from Balabit (n=34,965 bursts, RDP capture) and the
 * SERP browser dataset (n=17,851 bursts). The two agree independently:
 * median 2 events per burst, ~48ms apart, with roughly a second between
 * bursts. Timings from the RDP set are quantised at ~15.6ms by its transport,
 * so the browser set carries more weight at the fine end.
 */
export const HUMAN_WHEEL_MOUSE: InputProfile = {
  ...HUMAN,
  name: 'measured-wheel-mouse',

  // One notch per event: a wheel has no sub-tick resolution.
  wheelDelta: { mean: 40, sd: 0, min: 40, max: 40 },

  // A notched wheel is not continuous, so the macOS builder leaves
  // `delta_units` at `kScrollByPixel` and Chrome smooth-scroll animates the
  // result. Measured 21.75 scroll frames per wheel event against a trackpad's
  // 1.00, at identical deltas.
  wheelGranularity: 'pixel',

  wheelEventGap: {
    mean: 64,
    sd: 52,
    min: 14,
    max: 240,
    quantiles: [
      [0.02, 15], [0.10, 16], [0.25, 22], [0.50, 48],
      [0.75, 110], [0.90, 145], [0.98, 228],
    ],
  },

  wheelGestureEvents: {
    mean: 3.2,
    sd: 2.4,
    min: 1,
    max: 20,
    quantiles: [
      [0.10, 1], [0.25, 1], [0.50, 2], [0.75, 4], [0.90, 6], [0.98, 13],
    ],
  },

  wheelGesturePause: {
    mean: 1400,
    sd: 1700,
    min: 240,
    max: 9000,
    quantiles: [
      [0.02, 250], [0.10, 310], [0.25, 400], [0.50, 750],
      [0.75, 1600], [0.90, 3300], [0.98, 8200],
    ],
  },
};

// Faster operator: same shapes, compressed timings. Still within human range,
// but at the quick end of it.
export const HUMAN_FAST: InputProfile = {
  ...HUMAN,
  name: 'measured-fast',
  clickDwell: { mean: 78, sd: 12, min: 55, max: 120 },
  clickSettle: { mean: 90, sd: 45, min: 30, max: 260 },
  keyDwell: { mean: 68, sd: 22, min: 18, max: 140 },
  keyFlight: { mean: 82, sd: 40, min: 12, max: 200 },
  keyPauseChance: 0.02,
  wheelEventGap: { mean: 7, sd: 9, min: 0.4, max: 100 },
  wheelGesturePause: { mean: 180, sd: 100, min: 60, max: 600 },
};
