// A persona binds one fingerprint to one set of human motor habits.
//
// Drawing freshly from the whole population each session is itself a signal.
// Real typing pace varies 3.6x between people - median latency runs from 86ms
// to 309ms - so an identity that returns typing at a different speed every
// visit is describing someone who is not the same person. A persona pins the
// choice: the same seed always resolves to the same recorded individual, the
// same pace, and the same click character.

import type { StrokeCorpus } from './corpus.js';
import type { KeyboardCorpus } from './keyboard.js';
import { durationForDistance } from './path.js';

export interface Persona {
  /** Stable label, derived from the seed. */
  id: string;
  /** Index of the recorded person whose keystroke stream is replayed. */
  keyboard: number;
  /** Index of the recorded person whose strokes are preferred. */
  mouse: number;
  /**
   * This person's pointer pace, as a multiple of the population's
   * duration-for-distance law. Applied to every stroke they make, including
   * ones borrowed from another person when the corpus has no close match of
   * their own - pace is what a detector can track across sessions, and shape
   * is what has to match the distance being covered.
   */
  pace: number;
  /** Multiplier on click hold time, so the same identity clicks alike. */
  clickPace: number;
}

/** FNV-1a. Any stable string maps to the same persona on every run. */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Median pointer pace of each person in the corpus, relative to the law. */
export function personaPaces(corpus: StrokeCorpus): number[] {
  const per = new Map<number, number[]>();
  for (const s of corpus.strokes) {
    const k = s.k;
    if (k === undefined) continue;
    const dur = s.g.reduce((a, b) => a + b, 0);
    const ratio = dur / durationForDistance(s.d);
    const list = per.get(k);
    if (list) list.push(ratio);
    else per.set(k, [ratio]);
  }
  const out: number[] = [];
  const maxK = Math.max(0, ...per.keys());
  for (let k = 0; k <= maxK; k++) {
    const v = per.get(k);
    if (!v || !v.length) {
      out.push(1);
      continue;
    }
    v.sort((a, b) => a - b);
    out.push(v[v.length >> 1]!);
  }
  // Express relative to the population, so pace 1 is an average mover.
  const all = out.slice().sort((a, b) => a - b);
  const mid = all[all.length >> 1] || 1;
  return out.map((v) => v / mid);
}

export interface PersonaOptions {
  strokes?: StrokeCorpus;
  keystrokes?: KeyboardCorpus;
}

/**
 * Resolve a seed to a persona. Pass the same fingerprint id every session and
 * the identity keeps its habits; pass a new one and you get a different person.
 */
export function createPersona(seed: string | number, opts: PersonaOptions = {}): Persona {
  const text = String(seed);
  const h = hash(text);
  const kbCount = opts.keystrokes?.people.length ?? 1;
  const paces = opts.strokes ? personaPaces(opts.strokes) : [1];
  const mouseCount = paces.length;

  const keyboard = h % kbCount;
  const mouse = (h >>> 8) % mouseCount;
  // Two independent draws from the same hash, so the pointer and keyboard
  // habits of a persona are not forced to come from the same recorded person.
  const clickJitter = 0.85 + (((h >>> 16) & 0xff) / 255) * 0.3;

  return {
    id: text,
    keyboard,
    mouse,
    pace: paces[mouse] ?? 1,
    clickPace: clickJitter,
  };
}
