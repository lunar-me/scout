import { readFileSync } from 'node:fs';

const { results } = JSON.parse(readFileSync(process.argv[2] || '/tmp/wheelmeasure/raw.json', 'utf8'));

const stat = (a) => {
  if (!a.length) return { n: 0 };
  const s = [...a].sort((x, y) => x - y);
  const mean = a.reduce((p, c) => p + c, 0) / a.length;
  const sd = Math.sqrt(a.reduce((p, c) => p + (c - mean) ** 2, 0) / a.length);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: a.length, mean: +mean.toFixed(2), sd: +sd.toFixed(2),
    min: +s[0].toFixed(2), p50: +q(0.5).toFixed(2), max: +s[s.length - 1].toFixed(2),
  };
};

function analyse(r) {
  // A row that read nothing back from the page, e.g. the locked refusal, which
  // asserts an error message rather than an event stream.
  if (!r.wheel) return { label: r.label, refusal: r.refusal };
  const w = r.wheel;
  const dy = w.map((e) => Math.abs(e.dy));
  const gaps = w.slice(1).map((e, i) => e.ts - w[i].ts);
  const ratios = w.filter((e) => e.dy !== 0).map((e) => e.wdy / e.dy);
  const cancelable = w.map((e) => e.cancelable);
  const cTrue = cancelable.filter(Boolean).length;
  // Runs of cancelable values, as the browser's own gesture segmentation:
  // kPhaseBegan is blocking, kPhaseChanged inside an async transaction is not.
  let runs = [];
  for (const c of cancelable) {
    if (runs.length && runs[runs.length - 1].v === c) runs[runs.length - 1].n++;
    else runs.push({ v: c, n: 1 });
  }
  // Frames in which scroll position moved, per wheel event: the animated vs
  // direct device signature.
  let movedFrames = 0;
  for (let i = 1; i < r.frames.length; i++) {
    if (r.frames[i].sy !== r.frames[i - 1].sy) movedFrames++;
  }
  const eventsPerFrame = {};
  for (const e of w) eventsPerFrame[e.frame] = (eventsPerFrame[e.frame] || 0) + 1;
  const perFrame = Object.values(eventsPerFrame);
  const dms = [...new Set(w.map((e) => e.dm))];
  const fractional = dy.filter((d) => !Number.isInteger(d)).length;
  const mult40 = dy.filter((d) => d % 40 === 0).length;
  const travel = w.length ? (w[w.length - 1].sy - w[0].sy) : 0;

  // Per-gesture, where the column knows how many gestures it dispatched. This is
  // the acceptance number: a real device delivers ONE cancelable wheel event and
  // ONE `scrollend` per gesture, and the injected baseline delivers one of each
  // per EVENT. A total alone cannot tell those apart.
  const perGesture = r.gestures
    ? {
        gestures: r.gestures,
        cancelable_per_gesture: +(cTrue / r.gestures).toFixed(3),
        scrollend_per_gesture: +(r.scrollend.length / r.gestures).toFixed(3),
      }
    : {};

  return {
    label: r.label,
    events: w.length,
    wall_ms: r.wall,
    travel_px: travel,
    absDeltaY: stat(dy),
    ratio_wdy_dy: stat(ratios),
    ratio_distinct: [...new Set(ratios.map((x) => +x.toFixed(3)))].slice(0, 8),
    gap_ms: stat(gaps),
    deltaMode: dms,
    integer_deltas_pct: dy.length ? +(100 * (1 - fractional / dy.length)).toFixed(1) : null,
    multiple_of_40_pct: dy.length ? +(100 * mult40 / dy.length).toFixed(1) : null,
    cancelable_true: cTrue,
    cancelable_false: w.length - cTrue,
    cancelable_runs: runs.slice(0, 8).map((x) => `${x.v ? 'T' : 'F'}x${x.n}`).join(' '),
    scrollend_events: r.scrollend.length,
    scrollend_after_wheel_n: r.scrollend.map((x) => x.w).slice(0, 12),
    scroll_events: r.scrollEvents.length,
    frames_scroll_moved: movedFrames,
    frames_total: r.frames.length,
    wheels_per_frame: stat(perFrame),
    pointer_events: r.pointer.length,
    ...perGesture,
    ...(r.sent === undefined ? {} : { samples_sent: r.sent, dispatch_calls: r.calls }),
    ...(r.refusal === undefined ? {} : { refusal: r.refusal }),
  };
}

const out = {};
for (const k of Object.keys(results)) out[k] = analyse(results[k]);
console.log(JSON.stringify(out, null, 1));
