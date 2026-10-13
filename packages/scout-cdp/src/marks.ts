import type { ViewGeometry } from '@outcrawl/runtime';

/* ------------------------------------------------------------------ *
 * The marks, measured
 * ------------------------------------------------------------------ */

/**
 * The READ half of the set-of-marks capture, as a function serialised into
 * the page's isolated world: where each candidate is, and nothing else.
 *
 * It used to DRAW too — a `div#outcrawl-marks` of outlines and badges
 * appended to the live `documentElement`, photographed, and removed. That is
 * a vendor-named node in a real site's DOM, visible to any main-world
 * `MutationObserver`, so it is gone: this function creates, appends and
 * writes nothing, and the badges are painted onto the screenshot's bytes on
 * this host (`./png-marks`).
 *
 * A string constant because it does not execute here: it is stringified into
 * `Runtime.evaluate` in an isolated world, where none of this file's imports
 * exist. One argument in, one JSON-serialisable object out.
 *
 * `where` is the classification the fold notice is built from, and it is
 * decided HERE because only the page knows its own scroll position:
 *
 *   `visible`   intersects the viewport, so a badge is painted and the model
 *               can answer with its number;
 *   `above`     scrolled past;
 *   `below`     not reached yet — the count that stops a model concluding a
 *               control does not exist;
 *   `gone`      the xpath resolved to nothing, or to a zero-sized box. Not
 *               painted and not counted.
 *
 * `frameWidth` is `innerWidth` — the viewport the screenshot covers,
 * scrollbar included — which is what turns a CSS rect into device pixels.
 *
 * A DOCUMENT WITH NO ROOT ELEMENT is measured, not thrown on. The viewport
 * comes from `innerWidth`/`innerHeight` when `documentElement` is null, and
 * every candidate then reads `gone`. This used to read
 * `doc.documentElement.clientWidth` unconditionally, and on 2026-09-26
 * (HarnessAB, lab-flashlite-vision) 10 steps in 4 of 20 runs died on exactly
 * that line — `TypeError: Cannot read properties of null (reading
 * 'clientWidth')` at 5:32 — with no action possible; run_b096e7de and
 * run_3f58fc14 each lost four consecutive steps to it and ended
 * `stop=error`. The step has to reach the model, which can wait or navigate;
 * a throw here reaches only `stepFailures`. Why the document had no root
 * was not measured (the failing steps carry no settle report).
 */
export const MEASURE_MARKS = `function (marks) {
  var doc = document;
  var root = doc.documentElement;
  var rects = [];
  var shown = 0;
  var vw = root === null ? window.innerWidth : root.clientWidth;
  var vh = root === null ? window.innerHeight : root.clientHeight;
  for (var i = 0; i < marks.length; i++) {
    var mark = marks[i];
    var node = null;
    try {
      node = doc.evaluate(mark.xpath, doc, null, 9, null).singleNodeValue;
    } catch (error) {
      node = null;
    }
    if (node === null || typeof node.getBoundingClientRect !== 'function') {
      rects.push({ n: mark.n, x: 0, y: 0, width: 0, height: 0, where: 'gone' });
      continue;
    }
    var box = node.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) {
      rects.push({ n: mark.n, x: 0, y: 0, width: 0, height: 0, where: 'gone' });
      continue;
    }
    var where = box.bottom <= 0 ? 'above' : box.top >= vh ? 'below' : 'visible';
    if (where === 'visible') shown++;
    rects.push({ n: mark.n, x: box.left, y: box.top, width: box.width, height: box.height, where: where });
  }
  return {
    rects: rects,
    shown: shown,
    frameWidth: window.innerWidth,
    geometry: {
      viewport: { width: vw, height: vh },
      scroll: { x: window.scrollX, y: window.scrollY },
      document: {
        width: root === null ? vw : Math.max(root.scrollWidth, vw),
        height: root === null ? vh : Math.max(root.scrollHeight, vh)
      }
    }
  };
}`;

/** Where one candidate ended up relative to the viewport. */
type MarkPlacement = 'visible' | 'above' | 'below' | 'gone';

interface DrawnRect {
  readonly n: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly where: MarkPlacement;
}

export interface DrawResult {
  readonly rects: readonly DrawnRect[];
  readonly shown: number;
  /** `innerWidth`, CSS px: the width the screenshot covers. 0 when the page did not say. */
  readonly frameWidth: number;
  readonly geometry: ViewGeometry;
}

/**
 * The measurement's reply, checked rather than asserted.
 *
 * It crosses the same boundary `axTreeFromCdp` crosses and gets the same
 * treatment for the same reason: this is renderer output reaching typed code,
 * and a silently-wrong number here becomes a badge the model can see and the
 * loop cannot resolve.
 */
export function drawResult(value: unknown): DrawResult {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('the marks overlay returned no object');
  }
  if (!('rects' in value) || !Array.isArray(value.rects)) {
    throw new TypeError('the marks overlay returned no rects array');
  }
  if (!('geometry' in value)) {
    throw new TypeError('the marks overlay returned no geometry');
  }
  const rects: DrawnRect[] = [];
  for (const raw of value.rects) {
    if (typeof raw !== 'object' || raw === null) continue;
    if (!('n' in raw) || !('where' in raw)) continue;
    const n = raw.n;
    const where = raw.where;
    if (typeof n !== 'number') continue;
    if (where !== 'visible' && where !== 'above' && where !== 'below' && where !== 'gone') continue;
    rects.push({
      n,
      where,
      x: numberOr(raw, 'x'),
      y: numberOr(raw, 'y'),
      width: numberOr(raw, 'width'),
      height: numberOr(raw, 'height'),
    });
  }
  return {
    rects,
    shown: 'shown' in value && typeof value.shown === 'number' ? value.shown : rects.length,
    frameWidth: numberOr(value, 'frameWidth'),
    geometry: viewGeometry(value.geometry),
  };
}

function numberOr(source: object, key: string): number {
  if (!(key in source)) return 0;
  const value = Reflect.get(source, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function pairOf(source: unknown, first: string, second: string): { a: number; b: number } {
  if (typeof source !== 'object' || source === null) {
    throw new TypeError('the marks overlay returned an incomplete geometry');
  }
  return { a: numberOr(source, first), b: numberOr(source, second) };
}

function viewGeometry(value: unknown): ViewGeometry {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('the marks overlay returned no geometry object');
  }
  const viewport = pairOf(Reflect.get(value, 'viewport'), 'width', 'height');
  const scroll = pairOf(Reflect.get(value, 'scroll'), 'x', 'y');
  const document = pairOf(Reflect.get(value, 'document'), 'width', 'height');
  return {
    viewport: { width: viewport.a, height: viewport.b },
    scroll: { x: scroll.a, y: scroll.b },
    document: { width: document.a, height: document.b },
  };
}
