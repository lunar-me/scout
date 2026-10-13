// The wheel path's contract, against the built package.
//
// These assert the properties a page can actually read: the gesture structure
// the phase field carries, exact distance, monotone offsets, integer deltas, and
// that a supplied entry point is used INSTEAD of the fallback rather than
// alongside it.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHands,
  generateWheelPath,
  HUMAN,
  HUMAN_WHEEL_MOUSE,
  seededRng,
} from 'agenthands';

const at = { x: 400, y: 300 };

/** Split a path into gestures at each `began`. */
function gestures(samples) {
  const out = [];
  for (const s of samples) {
    if (s.phase === 'began') out.push([]);
    assert.ok(out.length > 0, 'a sample arrived before any gesture began');
    out[out.length - 1].push(s);
  }
  return out;
}

test('every gesture is began, changed*, ended', () => {
  for (const seed of [1, 2, 3, 17, 99]) {
    const path = generateWheelPath(4000, at, HUMAN, seededRng(seed));
    const gs = gestures(path.path);
    assert.ok(gs.length >= 1);
    for (const g of gs) {
      assert.equal(g[0].phase, 'began');
      assert.equal(g[g.length - 1].phase, 'ended');
      for (const s of g.slice(1, -1)) assert.equal(s.phase, 'changed');
      // The lift carries no travel: that is what the platform sends, and a
      // non-zero delta on it would be a scroll nobody asked for.
      assert.equal(g[g.length - 1].deltaY, 0);
    }
  }
});

test('exactly one cancelable-eligible event per gesture', () => {
  // The browser marks a `began` blocking and everything after it non-blocking,
  // so the count of `began` samples IS the count of cancelable wheel events the
  // page will see. A real 134-event trackpad gesture delivers one; the failure
  // this guards against is one per event.
  const path = generateWheelPath(4000, at, HUMAN, seededRng(5));
  const began = path.path.filter((s) => s.phase === 'began').length;
  const ended = path.path.filter((s) => s.phase === 'ended').length;
  const moves = path.path.filter((s) => s.deltaY !== 0).length;
  assert.equal(began, ended);
  assert.ok(began < moves, `${began} gestures for ${moves} moving events`);
});

test('distance lands exactly, in both directions', () => {
  for (const distance of [40, 137, 1600, 4000, 23456]) {
    for (const sign of [1, -1]) {
      const path = generateWheelPath(sign * distance, at, HUMAN, seededRng(11));
      const total = path.path.reduce((p, s) => p + s.deltaY, 0);
      assert.equal(total, sign * distance, `${sign * distance} came out ${total}`);
    }
  }
});

test('offsets start at zero and never go backwards', () => {
  const path = generateWheelPath(4000, at, HUMAN, seededRng(7));
  assert.equal(path.path[0].offsetMs, 0);
  for (let i = 1; i < path.path.length; i++) {
    assert.ok(
      path.path[i].offsetMs >= path.path[i - 1].offsetMs,
      `offset went backwards at ${i}`,
    );
  }
});

test('deltas are integers inside the profile range', () => {
  const path = generateWheelPath(6000, at, HUMAN, seededRng(3));
  for (const s of path.path) {
    assert.ok(Number.isInteger(s.deltaY), `${s.deltaY} is not an integer`);
    assert.equal(s.deltaX, 0);
    const size = Math.abs(s.deltaY);
    assert.ok(size <= HUMAN.wheelDelta.max, `${size} exceeds the sampled max`);
  }
});

test('granularity follows the device the profile describes', () => {
  // Not cosmetic: precise pixels are applied directly and pixels are smooth-
  // scroll animated, measured at 1.00 against 21.75 scroll frames per wheel
  // event. A notched profile sent as precise pixels scrolls like a trackpad.
  assert.equal(
    generateWheelPath(400, at, HUMAN, seededRng(1)).granularity,
    'precisePixel',
  );
  assert.equal(
    generateWheelPath(400, at, HUMAN_WHEEL_MOUSE, seededRng(1)).granularity,
    'pixel',
  );
});

test('a profile without a granularity is treated as continuous', () => {
  const { wheelGranularity, ...noGranularity } = HUMAN;
  assert.equal(wheelGranularity, 'precisePixel');
  assert.equal(
    generateWheelPath(400, at, noGranularity, seededRng(1)).granularity,
    'precisePixel',
  );
});

test('a path is the dispatchWheelPath parameter object, field for field', () => {
  // The one thing about this object no JavaScript assertion elsewhere can see:
  // it goes over the wire verbatim, so a field name is part of the contract.
  // Measured against the shipped binary, an object whose sample array is named
  // `samples` is refused outright -- "Failed to deserialize params.path -
  // BINDINGS: mandatory field missing at position 1987" -- and every other
  // assertion in this file passes regardless. Hence the exact key sets.
  const p = generateWheelPath(400, at, HUMAN, seededRng(1));
  assert.deepEqual(Object.keys(p).sort(), ['granularity', 'path', 'x', 'y']);
  assert.ok(p.path.length > 0);
  for (const s of p.path) {
    assert.deepEqual(Object.keys(s).sort(), ['deltaX', 'deltaY', 'offsetMs', 'phase']);
  }
});

test('same seed, same path', () => {
  const a = generateWheelPath(3000, at, HUMAN, seededRng(42));
  const b = generateWheelPath(3000, at, HUMAN, seededRng(42));
  assert.deepEqual(a, b);
  const c = generateWheelPath(3000, at, HUMAN, seededRng(43));
  assert.notDeepEqual(a, c);
});

test('scroll uses the wheel path and not the fallback', async () => {
  const calls = { wheel: 0, paths: [] };
  const hands = createHands(fakePage(calls), {
    seed: 9,
    start: { x: 120, y: 240 },
    wheelPath: async (path) => {
      calls.paths.push(path);
    },
  });

  await hands.scroll(2000);
  assert.equal(calls.paths.length, 1, 'expected one path for one scroll');
  // The failure being guarded: a probe or a fallback event slipping out
  // alongside the path. Any `mouse.wheel` call here is an event with no phase.
  assert.equal(calls.wheel, 0, 'mouse.wheel was used despite a wheelPath');
  const path = calls.paths[0];
  assert.equal(path.x, 120);
  assert.equal(path.y, 240);
  assert.equal(
    path.path.reduce((p, s) => p + s.deltaY, 0),
    2000,
  );
});

test('scroll falls back to mouse.wheel with no entry point', async () => {
  const calls = { wheel: 0, paths: [] };
  const hands = createHands(fakePage(calls), { seed: 9 });
  await hands.scroll(200);
  assert.ok(calls.wheel > 0, 'the fallback dispatched nothing');
});

test('a scroll shorter than a pixel does nothing at all', async () => {
  const calls = { wheel: 0, paths: [] };
  const hands = createHands(fakePage(calls), {
    seed: 9,
    wheelPath: async (path) => {
      calls.paths.push(path);
    },
  });
  await hands.scroll(0.4);
  assert.equal(calls.paths.length, 0);
  assert.equal(calls.wheel, 0);
});

test('a refused dispatch is raised, not swallowed into the fallback', async () => {
  // `Outcrawl.dispatchWheelPath` refuses while `Outcrawl.lock` is held, because
  // the lock drops every input event before the renderer sees it. Retrying on
  // `mouse.wheel()` there would dispatch into the same void and report success,
  // so the rejection has to come back out of `scroll()` as itself.
  const calls = { wheel: 0, paths: [] };
  const hands = createHands(fakePage(calls), {
    seed: 9,
    wheelPath: async () => {
      throw new Error('This session holds an action lock; unlock before dispatching input');
    },
  });
  await assert.rejects(hands.scroll(2000), /action lock/);
  assert.equal(calls.wheel, 0, 'the fallback ran behind a refused path');
});

function fakePage(calls) {
  return {
    mouse: {
      async move() {},
      async down() {},
      async up() {},
      async wheel() {
        calls.wheel += 1;
      },
    },
    keyboard: { async down() {}, async up() {}, async press() {} },
    locator() {
      throw new Error('not used');
    },
    // No `evaluate`, so the fallback route takes its whole-tick branch without
    // waiting on a probe that cannot answer.
  };
}
