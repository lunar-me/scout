// Keyboard timing replayed from recorded streams.
//
// Typing latency is not one distribution: it depends on the physical
// relationship between consecutive keys. Measured over 460,812 real
// transitions, alternating hands runs 160ms, the same hand 180ms, and the same
// finger on a different key 186ms, with row distance adding monotonically on
// top. A single sampled figure cannot produce that structure.
//
// The text a form asks for - an address, a card number - is never the text the
// corpus recorded, so a stream cannot be replayed verbatim. Instead each
// person's real stream is walked in order, taking the next recorded timing
// whose transition matches the one being typed. The values and their sequence
// stay real, which keeps the bursts and hesitations that resampling destroys.

import type { Rng } from './random.js';

export interface KeyboardCorpus {
  // Flat [class, rowDistance, keyCharCode, holdMs, latencyMs] per person.
  people: Array<{ s: number[] }>;
  stride?: number;
  // Population latency multipliers per transition class and row distance. They
  // carry a recorded timing onto a different key pair, which is what makes the
  // corpus usable for text it never contains - an email address or a card
  // number shares no digraphs with English prose.
  classFactor?: number[];
  rowFactor?: number[];
}

export interface KeyTiming {
  /** Milliseconds the key is held down. */
  hold: number;
  /** Milliseconds from this key going down to the next one going down. */
  latency: number;
}

const LOCALITY = 0.15;

const ROWS = ['1234567890-=', "qwertyuiop[]\\", "asdfghjkl;'", 'zxcvbnm,./'];
const ROW_OFFSET = [0, 0.5, 0.75, 1.25];

// Characters reachable only with shift, mapped to the physical key they sit on.
const SHIFTED: Record<string, string> = {
  '~': '`', '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6',
  '&': '7', '*': '8', '(': '9', ')': '0', _: '-', '+': '=', '{': '[',
  '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/',
};

export interface KeyGeometry {
  row: number;
  x: number;
  hand: 'L' | 'R' | 'B';
  finger: number;
}

/** Where a character sits on a QWERTY keyboard, or null if it is not on one. */
export function keyGeometry(ch: string): KeyGeometry | null {
  if (ch === ' ') return { row: 4, x: 5, hand: 'B', finger: 0 };
  const base = SHIFTED[ch] ?? ch.toLowerCase();
  for (let r = 0; r < ROWS.length; r++) {
    const i = ROWS[r]!.indexOf(base);
    if (i < 0) continue;
    const x = i + ROW_OFFSET[r]!;
    const hand = x < 5.2 ? 'L' : 'R';
    let finger: number;
    if (x < 1.5) finger = 1;
    else if (x < 2.5) finger = 2;
    else if (x < 3.5) finger = 3;
    else if (x < 6.6) finger = 4;
    else if (x < 7.6) finger = 3;
    else if (x < 8.6) finger = 2;
    else finger = 1;
    return { row: r, x, hand, finger };
  }
  return null;
}

/** Transition class between two characters, matching the recorded encoding. */
export function transitionClass(a: string, b: string): { cls: number; rowDist: number } {
  const ga = keyGeometry(a);
  const gb = keyGeometry(b);
  if (!ga || !gb) return { cls: 4, rowDist: 0 };
  const rowDist = Math.min(3, Math.round(Math.abs(ga.row - gb.row)));
  if (ga.row === gb.row && ga.x === gb.x) return { cls: 0, rowDist };
  const sameHand = ga.hand === gb.hand && ga.hand !== 'B' && gb.hand !== 'B';
  if (sameHand && ga.finger === gb.finger) return { cls: 1, rowDist };
  if (sameHand) return { cls: 2, rowDist };
  return { cls: 3, rowDist };
}

export class KeyboardPlayer {
  private readonly stream: number[];
  private readonly stride: number;
  private readonly classFactor: number[];
  private readonly rowFactor: number[];
  private at: number;

  constructor(corpus: KeyboardCorpus, person: number, rng: Rng) {
    this.stride = corpus.stride ?? 5;
    this.classFactor = corpus.classFactor ?? [1, 1, 1, 1, 1];
    this.rowFactor = corpus.rowFactor ?? [1, 1, 1, 1];
    const people = corpus.people;
    const p = people[((person % people.length) + people.length) % people.length]!;
    this.stream = p.s;
    // Start somewhere inside this person's stream so two sessions by the same
    // persona do not open with an identical run of timings.
    const n = this.stream.length / this.stride;
    this.at = Math.floor(rng() * n);
  }

  /**
   * Next recorded timing for this transition. Scans forward from where the
   * last one was taken, so consecutive keys keep the rhythm they were typed
   * with rather than being drawn independently.
   */
  next(cls: number, rowDist: number, key?: string): KeyTiming {
    const n = this.stream.length / this.stride;
    const want = key ? key.toLowerCase().charCodeAt(0) : -1;

    // Find the nearest recorded keystroke that matches this transition, and
    // take both its hold and its latency.
    //
    // Three things have to hold at once. The transition must match, because
    // latency depends on which keys follow which - row distance alone moves the
    // median from 151ms to 185ms. The key should match, because hold belongs to
    // the key: a thumb on the space bar behaves nothing like a little finger on
    // 'q'. And both values must come from the SAME keystroke, because their
    // relationship is what produces overlap - a latency shorter than the hold
    // means the next key went down before this one came up, which is 17% of
    // recorded keystrokes and 23% of the independent Aalto set. Reading hold
    // and latency from different entries drops overlap to almost nothing.
    let best = -1;
    let bestScore = Infinity;
    for (let k = 0; k < n; k++) {
      const i = (this.at + k) % n;
      if (this.stream[i * this.stride] !== cls) continue;
      const rd = this.stream[i * this.stride + 1]!;
      const kc = this.stream[i * this.stride + 2]!;
      const score =
        Math.abs(rd - rowDist) * 3 +
        (want >= 0 && kc !== want ? 2.5 : 0) +
        k * LOCALITY;
      if (score < bestScore) {
        bestScore = score;
        best = i;
        if (rd === rowDist && (want < 0 || kc === want)) break;
      }
      if (k > 300 && best >= 0) break;
    }
    if (best < 0) best = this.at % n;
    this.at = (best + 1) % n;

    const srcRow = this.stream[best * this.stride + 1]!;
    const hold = this.stream[best * this.stride + 3]!;
    const latency = this.stream[best * this.stride + 4]!;
    // Any residual row mismatch is corrected with the population factor rather
    // than left to flatten the row/latency relationship.
    const adjust =
      (this.rowFactor[Math.min(3, rowDist)] ?? 1) /
      (this.rowFactor[Math.min(3, srcRow)] ?? 1);
    return { hold, latency: Math.max(12, latency * adjust) };
  }
}
