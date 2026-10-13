// Path generation from a kinematic model of human reaching movement.
//
// A pointer stroke is not one smooth glide. Motor control produces a large
// ballistic thrust toward the target followed by a few smaller corrective
// submovements as the hand closes in, and each of those has an asymmetric
// velocity profile - a fast rise and a slower decay. Summing them reproduces
// the three things measured in real strokes that a Bezier cannot: velocity
// peaking around 40% of the way through rather than at the midpoint, a small
// number of distinct velocity maxima, and a wide spread in how direct the
// path is.
//
// Targets measured from 10,395 browser strokes (SERP dataset) and cross-checked
// against 53,293 from Balabit. See CALIBRATION.md.

import { clamp, gaussian, sample, type Distribution, type Rng } from './random.js';
import type { Point } from './types.js';

/** Retained for compatibility; the stroke model no longer uses it. */
export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

export interface StrokeOptions {
  rng: Rng;
  /** Sub-movements in the stroke. Measured: p50 3, p90 8. */
  submovements: Distribution;
  /** Peak lateral departure from the straight line, as a fraction of distance. */
  deviation: Distribution;
  /** Multiplier on the fitted duration, capturing how much strokes vary. */
  durationScale: Distribution;
  /**
   * Gap between emitted samples, in ms. Measured rather than a fixed rate:
   * real streams sit tight against the frame interval and then jump when a
   * frame is missed, giving a coefficient of variation near 1. Sampling the
   * position at these irregular times is what makes step length vary the way
   * it does in recorded strokes - and unlike noise on the speed itself, it
   * leaves the velocity profile intact, because distance and time move
   * together.
   */
  sampleGap: Distribution;
  /**
   * Per-sample positional noise, as a fraction of the step between samples.
   * Scaled to the step rather than fixed in pixels: a fixed amplitude is
   * negligible on long strokes and overwhelming on short ones, which is how
   * an earlier version produced thirty velocity peaks per stroke.
   */
  jitterFrac: number;
  /**
   * Multiplicative noise on each velocity sample. Real strokes vary far more
   * along the direction of travel than across it - step length varies about
   * twice as much as direction does - so lateral jitter alone cannot reproduce
   * the step-length spread.
   */
  speedNoise: number;
}

/** One emitted pointer sample: absolute position, and the gap before it. */
export interface StrokeSample {
  x: number;
  y: number;
  dt: number;
}

// duration_ms = 141.1 * D^0.286, fitted over 10,395 strokes. Sub-linear: a
// stroke three times longer takes only about a third longer, which is the
// speed-accuracy relationship rather than constant velocity.
export function durationForDistance(distance: number): number {
  return 141.1 * Math.pow(Math.max(1, distance), 0.286);
}

/**
 * Lognormal impulse. Asymmetric by construction - rises quickly, decays slowly
 * - which is what makes summed velocity peak before the midpoint.
 */
function lognormalVelocity(t: number, t0: number, mu: number, sigma: number): number {
  const dt = t - t0;
  if (dt <= 1e-6) return 0;
  const z = (Math.log(dt) - mu) / sigma;
  return Math.exp(-0.5 * z * z) / (dt * sigma * Math.SQRT2 * Math.sqrt(Math.PI));
}

/** Normal CDF via a logistic approximation; accurate enough for positioning. */
function normalCdf(z: number): number {
  return 1 / (1 + Math.exp(-1.702 * z));
}

/** Fraction of an impulse's displacement delivered by time t. */
function lognormalProgress(t: number, t0: number, mu: number, sigma: number): number {
  const dt = t - t0;
  if (dt <= 1e-6) return 0;
  return normalCdf((Math.log(dt) - mu) / sigma);
}

/**
 * Build a stroke as timed samples. Velocity comes from the summed impulses;
 * the spatial route is a bow whose depth is drawn from the measured spread.
 */
export function generateStroke(
  from: Point,
  to: Point,
  opts: StrokeOptions,
): StrokeSample[] {
  const rng = opts.rng;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) return [{ x: to.x, y: to.y, dt: 0 }];

  const duration = Math.max(
    60,
    durationForDistance(distance) * sample(opts.durationScale, rng),
  );

  // One ballistic thrust plus corrections. The thrust carries most of the
  // distance and starts early; corrections are smaller, later, and cluster
  // toward the end where the hand is homing in.
  // The profile stores the observable - velocity peaks counted in a recorded
  // stroke - but lateral wander between impulses registers as extra peaks, so
  // slightly fewer impulses are injected than the target count.
  const n = Math.max(1, Math.round(sample(opts.submovements, rng) * 1.45));
  // Each impulse carries its own slight lateral direction. Real strokes wander:
  // corrections do not aim exactly down the straight line, which lengthens the
  // path without pushing its widest point any further off course. A single
  // smooth bow cannot do both.
  const bumps: Array<{
    t0: number; w: number; mu: number; sigma: number; lat: number;
  }> = [];
  // How much of the distance the opening thrust actually covers. Usually most
  // of it, sometimes overshooting past the target, and sometimes falling well
  // short so that a large later correction carries the rest. That spread is
  // what puts the measured peak-velocity position anywhere from p10 0.13 to
  // p90 0.81 rather than always at the thrust.
  const primaryShare = clamp(gaussian(0.9, 0.34, rng), 0.2, 1.35);
  bumps.push({
    t0: 0,
    w: primaryShare,
    mu: Math.log(0.66) + gaussian(0, 0.42, rng),
    sigma: clamp(0.40 + gaussian(0, 0.11, rng), 0.20, 0.80),
    lat: gaussian(0, 0.06, rng),
  });
  for (let i = 1; i < n; i++) {
    bumps.push({
      // Corrections land progressively later in the stroke.
      t0: clamp(0.2 + (i / n) * 0.65 + gaussian(0, 0.08, rng), 0.05, 0.95),
      // Occasionally a correction rivals the thrust, which is what puts the
      // measured peak-velocity position as late as p90 0.81 on some strokes.
      w: (0.05 + Math.abs(gaussian(0, 0.3, rng))) * (n > 1 ? 1 : 0),
      mu: Math.log(0.16) + gaussian(0, 0.22, rng),
      sigma: clamp(0.34 + gaussian(0, 0.11, rng), 0.16, 0.75),
      lat: gaussian(0, 0.26, rng),
    });
  }

  // Lay out the sample times first, then evaluate the stroke at those times.
  const gaps: number[] = [];
  let elapsed = 0;
  while (elapsed < duration && gaps.length < 600) {
    const g = Math.max(1, sample(opts.sampleGap, rng));
    gaps.push(g);
    elapsed += g;
  }
  if (gaps.length < 4) {
    while (gaps.length < 4) gaps.push(duration / 4);
    elapsed = gaps.reduce((a, b) => a + b, 0);
  }
  const steps = gaps.length;

  // A browser emits a move only when the pointer actually moves, so a long gap
  // in real data means the hand hesitated - little displacement, not a large
  // one. Treating the whole gap as travel time inverts that and makes step
  // length far more variable than it is in recorded strokes. Anything past
  // roughly one and a half frames is counted as dwell: the clock advances, the
  // stroke does not.
  const MOTION_CAP_MS = 26;
  const motion = gaps.map((g) => Math.min(g, MOTION_CAP_MS));
  const motionTotal = motion.reduce((a, b) => a + b, 0) || 1;
  const times: number[] = [];
  let running = 0;
  for (const m of motion) {
    running += m;
    times.push(Math.min(1, running / motionTotal));
  }
  // Signed amplitudes: the thrust carries 1 + overshoot of the distance and the
  // corrections carry the remainder, which is negative whenever the thrust went
  // too far. Position is the weighted sum of each impulse's progress, so it can
  // pass the target and come back - it is not forced to be monotonic.
  const corrWeight = bumps.slice(1).reduce((a, b) => a + b.w, 0);
  const remainder = 1 - primaryShare;
  const amp = bumps.map((b, i) =>
    i === 0 ? primaryShare : corrWeight > 0 ? (remainder * b.w) / corrWeight : 0,
  );

  // Impulses are lognormal, so their displacement is not finished at t=1. Left
  // truncated, whatever distance remains gets dumped into the final step and
  // the stroke arrives accelerating, where a real one decelerates onto the
  // target. Stretch the window until the impulses have almost run out.
  const totalAt = (t: number): number => {
    let p = 0;
    for (let k = 0; k < bumps.length; k++) {
      const b = bumps[k]!;
      p += amp[k]! * lognormalProgress(t, b.t0, b.mu, b.sigma);
    }
    return p;
  };
  // Bounded: stretched too far the stroke grows a long tail where the pointer
  // crawls a fraction of a pixel per sample, which no real stream contains.
  let tMax = 1;
  for (let k = 0; k < 5 && totalAt(tMax) < 0.93; k++) tMax *= 1.15;

  const progress: number[] = [];
  const lateral: number[] = [];
  for (let i = 0; i < steps; i++) {
    const t = times[i]! * tMax;
    let p = 0;
    let q = 0;
    for (let k = 0; k < bumps.length; k++) {
      const b = bumps[k]!;
      const done = lognormalProgress(t, b.t0, b.mu, b.sigma);
      p += amp[k]! * done;
      q += amp[k]! * done * b.lat;
    }
    progress.push(p);
    lateral.push(q);
  }

  // Perturb how much of the stroke each sample advances. Applied to the
  // increments rather than the positions, so it varies step length along the
  // direction of travel - which is where real strokes vary most - without
  // pushing the path sideways.
  if (opts.speedNoise > 0) {
    let prev = 0;
    let acc = 0;
    for (let i = 0; i < progress.length; i++) {
      const inc = progress[i]! - prev;
      prev = progress[i]!;
      acc += inc * (1 + gaussian(0, opts.speedNoise, rng));
      progress[i] = acc;
    }
  }
  // Lateral drift must also resolve to zero, or the stroke misses the target.
  const latEnd = lateral[lateral.length - 1]!;
  for (let i = 0; i < lateral.length; i++) {
    lateral[i] = lateral[i]! - latEnd * ((i + 1) / lateral.length);
  }
  // Normalise so the stroke ends exactly on the target.
  const end = progress[progress.length - 1]!;
  if (Math.abs(end) > 1e-6) {
    for (let i = 0; i < progress.length; i++) progress[i] = progress[i]! / end;
  }

  // Spatial route: a bow off the straight line, depth drawn from the measured
  // deviation spread, which is heavy-tailed - most strokes are nearly direct
  // and a few wander a long way.
  const nx = -dy / distance;
  const ny = dx / distance;
  // Scaled down because the weave below and the per-impulse lateral drift both
  // contribute to how far the stroke departs from the straight line; the
  // profile figure is the total, not the bow alone.
  const bow =
    distance * clamp(sample(opts.deviation, rng), 0, 1.6) * 0.72 * (rng() < 0.5 ? -1 : 1);

  // A slow lateral weave on top of the bow. Real strokes reach a path/straight
  // ratio near 2 while their widest departure stays under half the distance,
  // which a single arc cannot produce - length has to come from repeated small
  // excursions rather than one big one. Kept to one or two cycles so it adds
  // path without chopping the speed profile into extra peaks.
  const weaveCycles = 1 + Math.floor(rng() * 2);
  const weaveAmp = Math.abs(gaussian(0, 0.09, rng)) * (rng() < 0.55 ? 1 : 0);
  const weavePhase = rng() * Math.PI * 2;

  const out: StrokeSample[] = [];
  // Mean step, used to scale the jitter so it stays a fixed share of motion.
  const meanStep = distance / Math.max(1, steps);
  // Anchor the bow to the first emitted sample rather than to p=0. Velocity is
  // non-zero by the first sample, so p0 > 0; without this the stroke would
  // start already displaced from the straight line, rotating the chord and
  // inflating its apparent deviation.
  const p0 = progress[0]!;
  const span = Math.max(1e-6, 1 - p0);
  for (let i = 0; i < steps; i++) {
    const p = progress[i]!;
    const u = (p - p0) / span;
    const weave =
      Math.sin(2 * Math.PI * weaveCycles * u + weavePhase) -
      Math.sin(weavePhase) * (1 - u) -
      Math.sin(2 * Math.PI * weaveCycles + weavePhase) * u;
    const arc =
      Math.sin(Math.PI * u) * bow +
      lateral[i]! * distance +
      weave * weaveAmp * distance;
    // Micro-jitter. Real strokes reverse direction on more than half their
    // samples and sit further off their own smoothed centreline than any
    // analytic curve does. Kept small relative to the step so it perturbs
    // direction without breaking the speed profile into extra peaks.
    const jx = gaussian(0, meanStep * opts.jitterFrac, rng);
    const jy = gaussian(0, meanStep * opts.jitterFrac, rng);
    out.push({
      // Deliberately not rounded: real pointer streams are almost entirely
      // fractional, and integer-only coordinates are a distinguishable pattern.
      x: from.x + dx * p + nx * arc + jx,
      y: from.y + dy * p + ny * arc + jy,
      dt: gaps[i]!,
    });
  }
  // Drop samples that do not move the pointer a meaningful fraction of a pixel.
  // A browser reports motion, not the passage of time, so a stalled sample is
  // not something a real stream contains - and rounded to integers it would
  // read as a random one-pixel jerk.
  const kept: StrokeSample[] = [];
  let lastX = from.x;
  let lastY = from.y;
  let carried = 0;
  for (const sm of out) {
    if (Math.hypot(sm.x - lastX, sm.y - lastY) < 0.35 && kept.length) {
      carried += sm.dt;
      continue;
    }
    sm.dt += carried;
    carried = 0;
    lastX = sm.x;
    lastY = sm.y;
    kept.push(sm);
  }
  if (!kept.length) kept.push(out[out.length - 1]!);
  // Land exactly on the target.
  const last = kept[kept.length - 1]!;
  last.x = to.x;
  last.y = to.y;
  return kept;
}
