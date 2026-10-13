// Sampling helpers. Everything here is deterministic given an injected RNG so
// runs can be reproduced from a seed.

export type Rng = () => number;

export const defaultRng: Rng = Math.random;

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

// Box-Muller. Two uniforms in, one normal out.
export function gaussian(mean: number, sd: number, rng: Rng = defaultRng): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface Distribution {
  mean: number;
  sd: number;
  min: number;
  max: number;
  /**
   * Optional empirical quantile curve, as [probability, value] pairs sorted by
   * probability. When present it is sampled by inverse-CDF interpolation and
   * the gaussian parameters above are ignored.
   *
   * Human timing distributions are right-skewed - a floor near the motor limit
   * and a long tail of hesitation - which a gaussian cannot represent. Where a
   * large sample exists, carrying its quantiles is more faithful than fitting
   * a shape the data does not have.
   */
  quantiles?: Array<[number, number]>;
}

export function sample(d: Distribution, rng: Rng = defaultRng): number {
  if (d.quantiles && d.quantiles.length > 1) {
    return clamp(sampleQuantiles(d.quantiles, rng), d.min, d.max);
  }
  return clamp(gaussian(d.mean, d.sd, rng), d.min, d.max);
}

/** Draw from an empirical quantile curve by inverse-CDF interpolation. */
export function sampleQuantiles(
  q: Array<[number, number]>,
  rng: Rng = defaultRng,
): number {
  const u = rng();
  const first = q[0]!;
  const last = q[q.length - 1]!;
  if (u <= first[0]) return first[1];
  if (u >= last[0]) return last[1];
  for (let i = 1; i < q.length; i++) {
    const [p1, v1] = q[i]!;
    const [p0, v0] = q[i - 1]!;
    if (u <= p1) {
      const span = p1 - p0;
      return span <= 0 ? v1 : v0 + ((u - p0) / span) * (v1 - v0);
    }
  }
  return last[1];
}

// Mulberry32 - small seedable PRNG, for reproducible sessions.
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
