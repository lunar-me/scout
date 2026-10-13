// Wheel measurement, against a real browser.
//
// Answers the question this library could not answer from JavaScript: what does
// a page see that separates an injected scroll from a real device's? Five
// columns, all delivering the SAME deltas at the SAME cadence, so that anything
// that differs is the entry point and not the model.
//
//   hw_realphase     real macOS CGEvent scrolls, phases as a device sends them
//   hw_allbegan      the same events, every one stamped phase=began - which is
//                    what Input.dispatchMouseWheel does. If the tell reproduces
//                    here, the cause is the phase field and not CDP.
//   hw_nophase       no phase at all: the shape a notched wheel has, where
//                    MouseWheelPhaseHandler synthesises the phase itself.
//   cdp_same_deltas  Input.dispatchMouseWheel, one call per delta.
//   agenthands       this library's scroll(), fallback route.
//
// USAGE
//
//   clang -O2 -framework ApplicationServices -o scrollpost scrollpost.c
//   python3 -m http.server 8099          # serving this directory
//   <browser> --remote-debugging-port=9333 http://127.0.0.1:8099/probe.html
//   node measure.mjs <browserPid> [passive] > raw.json
//   node analyze.mjs raw.json
//
// The hardware columns post to the macOS HID event tap and warp the cursor over
// the window, so the browser must be FRONTMOST and the posting process must hold
// Accessibility permission. Zero wheel events in a hardware column means one of
// those two was not true, not that the events were rejected.
//
// `passive` registers the page's wheel listener passive-only, which is worth
// running: it makes Blink send every wheel event non-blocking and pins
// `cancelable` to false for hardware and injection alike. `scrollend` separates
// them either way.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { Cdp, Session, pageLike } from './cdp.mjs';
import { createHands, HUMAN } from 'agenthands';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCROLLPOST = path.join(HERE, 'scrollpost');
const PORT = Number(process.env.CDP_PORT ?? 9333);
const BROWSER_PID = process.argv[2];
const PASSIVE = process.argv[3] === 'passive';
const DISTANCE = 1600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!BROWSER_PID) {
  console.error('usage: node measure.mjs <browserPid> [passive]');
  process.exit(2);
}

const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const cdp = await Cdp.connect(ver.webSocketDebuggerUrl);
const targets = await cdp.send('Target.getTargets');
const page = targets.targetInfos.find((t) => t.type === 'page' && t.url.includes('probe'));
if (!page) {
  console.error('no page target is showing probe.html');
  process.exit(2);
}
const { sessionId } = await cdp.send('Target.attachToTarget', {
  targetId: page.targetId,
  flatten: true,
});
const s = new Session(cdp, sessionId);
await s.send('Runtime.enable');
await s.send('Page.enable');
await s.send('Page.navigate', {
  url: `http://127.0.0.1:8099/probe.html${PASSIVE ? '?passive=1' : ''}`,
});
await sleep(1500);

const ev = async (e) => {
  const r = await s.send('Runtime.evaluate', {
    expression: e,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

const geom = await ev(
  `(()=>({ix:innerWidth,iy:innerHeight,sx:screenX,sy:screenY,passive:!!window.__passive}))()`,
);
const px = geom.sx + Math.round(geom.ix / 2);
const py = geom.sy + Math.round(geom.iy / 2);
process.stderr.write(`cursor target ${px},${py} passiveListener=${geom.passive}\n`);

// One shared delta sequence for every column, drawn from a fixed seed so a
// re-run is comparable to the last one.
const deltas = [];
let travelled = 0;
let seed = 20250831;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
while (travelled < DISTANCE) {
  const d = Math.max(1, Math.min(Math.round(3 + rnd() * 18), DISTANCE - travelled));
  deltas.push(d);
  travelled += d;
}

const results = {};

async function run(label, fn) {
  await ev('scrollTo(0,0)');
  await sleep(400);
  await ev('__reset()');
  const t0 = Date.now();
  // A column that knows something the page cannot - the gesture count of the
  // path it dispatched, say - returns it, and it is carried through to the
  // analysis rather than printed and lost.
  const extra = (await fn()) ?? {};
  const wall = Date.now() - t0;
  const W = JSON.parse(await ev('JSON.stringify(__W)'));
  process.stderr.write(
    `${label}: ${W.wheel.length} wheel, ${W.scrollend.length} scrollend, ${wall}ms\n`,
  );
  results[label] = { label, wall, ...W, ...extra };
}

function post(lines, units = 'pixel') {
  return new Promise((res, rej) => {
    const c = spawn(SCROLLPOST, [BROWSER_PID, String(px), String(py), 'hid', units], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    c.on('exit', (code) => (code === 0 ? res() : rej(new Error('scrollpost exit ' + code))));
    c.stdin.end(lines.join('\n') + '\n');
  });
}

await run('hw_realphase', async () => {
  const lines = [`1 0 ${-deltas[0]} 10`];
  for (const d of deltas.slice(1)) lines.push(`2 0 ${-d} 10`);
  lines.push('4 0 0 10');
  await post(lines);
  await sleep(800);
});

await run('hw_allbegan', async () => {
  await post(deltas.map((d) => `1 0 ${-d} 10`));
  await sleep(800);
});

await run('hw_nophase', async () => {
  await post(deltas.map((d) => `0 0 ${-d} 10`));
  await sleep(800);
});

await run('cdp_same_deltas', async () => {
  const p = pageLike(s, { x: Math.round(geom.ix / 2), y: Math.round(geom.iy / 2) });
  const inflight = [];
  for (const d of deltas) {
    // Not awaited, for the same reason scroll()'s fallback does not await: the
    // round trip is ~10ms against a measured 9.46ms cadence.
    inflight.push(p.mouse.wheel(0, d));
    await sleep(6);
  }
  await Promise.all(inflight);
  await sleep(800);
});

await run('agenthands', async () => {
  const hands = createHands(
    pageLike(s, { x: Math.round(geom.ix / 2), y: Math.round(geom.iy / 2) }),
    { profile: HUMAN, seed: 11 },
  );
  await hands.scroll(DISTANCE);
  await sleep(800);
});

// The wired route: the same library, the same profile, the same seed, dispatched
// through `Outcrawl.dispatchWheelPath` instead of `Input.dispatchMouseWheel`.
// Everything upstream of the entry point is held constant against the
// `agenthands` column above, so a difference here is the entry point.
//
// The dispatcher is the whole wiring, and it is one line because the path object
// IS the command's parameter object.
await run('outcrawl_wheelpath', async () => {
  const at = { x: Math.round(geom.ix / 2), y: Math.round(geom.iy / 2) };
  const dispatched = [];
  const hands = createHands(pageLike(s, at), {
    profile: HUMAN,
    seed: 11,
    start: at,
    wheelPath: (path) => {
      dispatched.push(path);
      return s.send('Outcrawl.dispatchWheelPath', path);
    },
  });
  await hands.scroll(DISTANCE);
  await sleep(800);
  // The gesture count the page cannot see, so `cancelable` and `scrollend` can
  // be read PER GESTURE rather than as bare totals.
  const samples = dispatched.flatMap((p) => p.path);
  return {
    calls: dispatched.length,
    gestures: samples.filter((x) => x.phase === 'began').length,
    lifts: samples.filter((x) => x.phase === 'ended').length,
    sent: samples.length,
  };
});

// The refusal, measured rather than trusted. `dispatchWheelPath` is refused
// while `Outcrawl.lock` is held because the lock's own `ScopedIgnoreInputEvents`
// drops every event before the renderer sees it, so a command that reported
// success would be lying. A driver that fell back to `mouse.wheel()` here would
// dispatch into the same void and report success, which is the failure this
// check exists to catch.
//
// ON ITS OWN TARGET, and not because of tidiness. Measured on this binary: after
// `Outcrawl.unlock`, `Runtime.evaluate` on that frame never returns again -
// baseline 0ms, 0ms while locked, then two consecutive 8s timeouts after the
// unlock. Every column above reads its results with `Runtime.evaluate`, so a
// lock taken on the probe page would end the run rather than measure it.
{
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const locked = new Session(cdp, attached.sessionId);
  const hands = createHands(pageLike(locked, { x: 100, y: 100 }), {
    profile: HUMAN,
    seed: 11,
    start: { x: 100, y: 100 },
    wheelPath: (path) => locked.send('Outcrawl.dispatchWheelPath', path),
  });
  await locked.send('Outcrawl.lock', {});
  let refusal = null;
  try {
    await hands.scroll(DISTANCE);
  } catch (e) {
    refusal = e.message;
  }
  results.locked_refusal = { label: 'locked_refusal', refusal };
  process.stderr.write(`locked_refusal: ${refusal ?? 'NO REFUSAL - the lock was ignored'}\n`);
  // Not unlocked, and the target is not closed: unlocking is what wedges the
  // frame, and this tab exists only to hold the lock.
}

console.log(JSON.stringify({ geom, results }, null, 1));
process.exit(0);
