// Replay of measured pointer strokes.
//
// The parametric model in path.ts reproduces every marginal distribution that
// was measured, and a gradient-boosted classifier still separates it from real
// strokes at AUC 0.90 against a human-vs-human floor of 0.53. Matching each
// statistic one at a time does not match the joint distribution, and that is
// what a classifier keys on.
//
// Replaying recorded shapes does match it: same classifier, same held-out
// participants, AUC 0.57. This carries a cost the parametric model does not -
// a finite set of shapes, which repeat if used enough - so strokes are drawn
// without replacement until the corpus is exhausted.

import type { Rng } from './random.js';
import type { Point } from './types.js';
import type { StrokeSample } from './path.js';
import { durationForDistance } from './path.js';

export interface CorpusStroke {
  // Unit-length shape, x1000. The stroke runs (0,0) -> (1000,0) before warping.
  p: Array<[number, number]>;
  // Milliseconds before each subsequent sample.
  g: number[];
  // Distance in pixels the stroke was recorded at.
  d: number;
  // Index of the person who made the stroke, where the corpus records it.
  k?: number;
}

export interface StrokeCorpus {
  strokes: CorpusStroke[];
  source?: string;
  license?: string;
}

// Beyond this much rescaling the replayed stroke stops matching how a stroke of
// the requested length is actually made, so the parametric model is used
// instead. Roughly a factor of 1.6 either way.
const MAX_LOG_RESCALE = 0.48;

export class CorpusPlayer {
  private readonly strokes: CorpusStroke[];
  // Indices sorted by recorded distance, so the closest match can be found by
  // binary search. Warping a stroke away from the distance it was recorded at
  // is the only step that measurably degrades it, so the search is worth doing
  // properly rather than sampling a few candidates.
  private readonly byDistance: number[];
  private readonly used: boolean[];
  private remainingCount: number;
  /**
   * Index of the stroke returned by the last successful call. Exposed so a
   * caller validating the corpus can group results by their true source; the
   * player picks by distance, not in request order.
   */
  lastIndex = -1;

  constructor(
    corpus: StrokeCorpus,
    private readonly rng: Rng,
    private readonly preferPerson?: number,
  ) {
    this.strokes = corpus.strokes;
    this.byDistance = this.strokes
      .map((_, i) => i)
      .sort((a, b) => this.strokes[a]!.d - this.strokes[b]!.d);
    this.used = new Array(this.strokes.length).fill(false);
    this.remainingCount = this.strokes.length;
  }

  /** Number of shapes not yet played in this session. */
  get remaining(): number {
    return this.remainingCount;
  }

  /** Pick an unplayed stroke recorded near `distance`, or null if none fits. */
  private take(distance: number): CorpusStroke | null {
    if (!this.remainingCount) {
      this.used.fill(false);
      this.remainingCount = this.strokes.length;
    }
    const n = this.byDistance.length;
    if (!n) return null;

    // Binary search for where this distance falls, then walk outwards for the
    // nearest stroke still unplayed.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.strokes[this.byDistance[mid]!]!.d < distance) lo = mid + 1;
      else hi = mid;
    }
    let left = lo - 1;
    let right = lo;
    let best = -1;
    let bestDelta = Infinity;
    while (left >= 0 || right < n) {
      let at = -1;
      if (right >= n) at = left--;
      else if (left < 0) at = right++;
      else {
        const dl = Math.abs(this.strokes[this.byDistance[left]!]!.d - distance);
        const dr = Math.abs(this.strokes[this.byDistance[right]!]!.d - distance);
        at = dl <= dr ? left-- : right++;
      }
      const idx = this.byDistance[at]!;
      const delta = Math.abs(Math.log(this.strokes[idx]!.d / distance));
      // Everything further out is a worse match, so stop once past the limit.
      if (delta > MAX_LOG_RESCALE && best >= 0) break;
      if (this.used[idx]) continue;
      // A stroke by the persona's own person is worth a little rescaling to
      // keep, but not much: warping is the one step that degrades a replay, so
      // a far shape of theirs is worse than a close shape of someone else's.
      const own = this.preferPerson !== undefined && this.strokes[idx]!.k === this.preferPerson;
      const scored = own ? delta * 0.45 : delta;
      if (scored < bestDelta) {
        bestDelta = scored;
        best = idx;
      }
      // A match this close cannot be meaningfully improved on.
      if (bestDelta < 0.01) break;
    }
    if (best < 0 || bestDelta > MAX_LOG_RESCALE) return null;
    this.used[best] = true;
    this.remainingCount -= 1;
    this.lastIndex = best;
    return this.strokes[best]!;
  }

  /**
   * Warp a recorded stroke onto the requested endpoints. Rotation and scaling
   * preserve the shape; timing is rescaled by the same duration-for-distance
   * law the recorded strokes follow, so the stroke keeps its own rhythm.
   */
  stroke(from: Point, to: Point): StrokeSample[] | null {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1) return null;
    const s = this.take(distance);
    if (!s || s.p.length < 2) return null;

    const ca = dx / distance;
    const sa = dy / distance;
    const scale = distance / 1000;
    // Only the distance law is applied. The recorded stroke already carries a
    // real draw from the duration spread, so sampling durationScale on top
    // would apply that variation twice.
    //
    // Near the stroke's own distance the gaps are left exactly as recorded.
    // They are whole milliseconds; scaling them by a factor near 1 turns them
    // into fractions and quietly smooths the acceleration profile, which is
    // measurable even though the factor is within a few percent of unity.
    const ratio = durationForDistance(distance) / durationForDistance(s.d);
    const tScale = Math.abs(Math.log(ratio)) < 0.05 ? 1 : ratio;

    const out: StrokeSample[] = [];
    for (let i = 0; i < s.p.length; i++) {
      const ux = s.p[i]![0] * scale;
      const uy = s.p[i]![1] * scale;
      out.push({
        x: from.x + ux * ca - uy * sa,
        y: from.y + ux * sa + uy * ca,
        dt:
          i === 0
            ? 0
            : tScale === 1
              ? (s.g[i - 1] ?? 16)
              : Math.max(1, Math.round((s.g[i - 1] ?? 16) * tScale)),
      });
    }
    const last = out[out.length - 1]!;
    last.x = to.x;
    last.y = to.y;
    return out;
  }
}
