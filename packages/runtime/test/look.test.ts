/**
 * `page.look`: what a text-only actuator gets back when it asks to see.
 *
 * The failure it answers, measured on the failure probes (fleet 54476fe6,
 * 2026-09-24): PG2 0/3 — a code painted on a canvas, which the tree and every
 * `extract` of it read as nothing; one run invented a tool called `img2txt`.
 */
import { describe, expect, test } from 'bun:test';

import type { LookAim, LookAnswer, LookCamera, LookQuestion, LookShot, LookVision } from '../src/look';
import { DEFAULT_LOOKS_PER_RUN, LOOK_TOOL, MAX_FAILED_LOOKS, lookAllowance, looksTaken, lookToolPort } from '../src/look';
import type { ModelChoice } from '../src/loop';
import { runAgent } from '../src/loop';
import { formatNodeRef, nodeRef } from '../src/snapshot';
import { harness, node, tree } from './support';

const SHOT: LookShot = {
  image: { mediaType: 'image/png', base64: 'iVBORw0KGgo=' },
  viewport: { width: 1200, height: 800 },
};

function camera(overrides: Partial<LookCamera> = {}): LookCamera & { shots: number; aims: { aim?: LookAim; awaitPaint?: boolean }[] } {
  const state = {
    shots: 0,
    aims: [] as { aim?: LookAim; awaitPaint?: boolean }[],
    async shoot(aim?: LookAim, awaitPaint?: boolean): Promise<LookShot> {
      state.shots += 1;
      state.aims.push({ ...(aim === undefined ? {} : { aim }), ...(awaitPaint === undefined ? {} : { awaitPaint }) });
      return aim?.region === undefined ? SHOT : { ...SHOT, region: aim.region };
    },
    async locate(): Promise<undefined> {
      return undefined;
    },
    ...overrides,
  };
  return state;
}

function vision(reply: (q: LookQuestion) => LookAnswer): LookVision & {
  asked: LookQuestion[];
} {
  const asked: LookQuestion[] = [];
  return {
    asked,
    async ask(question) {
      asked.push(question);
      return reply(question);
    },
  };
}

describe('page.look reads pixels for a text-only actuator', () => {
  test('a painted code comes back as text, with the screenshot sent to the vision model', async () => {
    const eyes = vision(() => ({ answer: 'ZQ-4471-MBX', found: true, usage: { inputTokens: 1338, outputTokens: 29 } }));
    const port = lookToolPort({ camera: camera(), vision: eyes });

    const out = await port.call(LOOK_TOOL, { question: 'What code is painted on the canvas?' });

    expect(out.isError).toBe(false);
    expect(out.text).toContain('ZQ-4471-MBX');
    expect(out.usage).toEqual({ inputTokens: 1338, outputTokens: 29 });
    expect(eyes.asked[0]?.image).toEqual(SHOT.image);
    // No explicit charge: a look's provider cost reaches the bill through the
    // host's model cost ledger like every other model call, never a second charge.
    expect(out.credits).toBeUndefined();
  });

  test('a position becomes a viewport point and the reference painted there', async () => {
    const day = nodeRef(7, 4242);
    const located: { x: number; y: number }[] = [];
    const port = lookToolPort({
      camera: camera({
        async locate(point) {
          located.push(point);
          return { ref: day, role: 'link', name: '15' };
        },
      }),
      vision: vision(() => ({ answer: '15', found: true, point: { x: 718, y: 312 }, usage: {} })),
    });

    const out = await port.call(LOOK_TOOL, { question: 'Where is day 15?' });

    // 0-1000 of the picture, and the picture IS the viewport: no device scale.
    expect(located).toEqual([{ x: 862, y: 250 }]);
    expect(out.text).toContain(`[${formatNodeRef(day)}] link "15"`);
    expect(out.text).toContain(`use ref "${formatNodeRef(day)}"`);
  });

  test('a position with nothing addressable under it says so rather than naming a node', async () => {
    const port = lookToolPort({
      camera: camera(),
      vision: vision(() => ({ answer: 'a rectangle', found: true, point: { x: 500, y: 500 }, usage: {} })),
    });
    const out = await port.call(LOOK_TOOL, { question: 'Where is the shape I drew?' });
    expect(out.text).toContain('(600, 400)');
    // Nothing to name by reference, so the answer offers the point itself.
    expect(out.text).toContain('{"type":"click","at":{"x":600,"y":400}}');
    expect(out.text).not.toContain('use ref');
  });

  test('what is not on screen is reported as not visible, not as an answer', async () => {
    const port = lookToolPort({
      camera: camera(),
      vision: vision(() => ({ answer: 'The page shows a login form.', found: false, usage: {} })),
    });
    const out = await port.call(LOOK_TOOL, { question: 'What is the price?' });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('not visible on screen');
  });

  test('a named element is photographed alone, and a point on it is a point in the viewport', async () => {
    const eyes = vision(() => ({ answer: 'the blue swatch', found: true, point: { x: 500, y: 250 }, usage: {} }));
    const located: { x: number; y: number }[] = [];
    const lens = camera({
      async shoot(aim) {
        return aim?.ref === undefined ? SHOT : { ...SHOT, region: { x: 120, y: 80, width: 240, height: 160 } };
      },
      async locate(point) {
        located.push(point);
        return undefined;
      },
    });
    const port = lookToolPort({ camera: lens, vision: eyes });
    await port.call(LOOK_TOOL, { question: 'Where is the blue swatch?', ref: '7-4242' });
    expect(eyes.asked[0]?.enlarged).toBe(true);
    // 500/1000 of 240 px from x 120, 250/1000 of 160 px from y 80.
    expect(located).toEqual([{ x: 240, y: 120 }]);
  });
});

describe('a look may take ONE retake: closer, or once the page has drawn', () => {
  test('a zoom box is photographed enlarged, widened, and the second answer is the answer', async () => {
    const lens = camera();
    let call = 0;
    const eyes = vision(() => {
      call += 1;
      return call === 1
        ? { answer: 'too small', found: true, zoom: { x0: 500, y0: 500, x1: 600, y1: 550 }, usage: { inputTokens: 1300, outputTokens: 20 } }
        : { answer: '1874, 1903, 1929', found: true, usage: { inputTokens: 1200, outputTokens: 30 } };
    });
    const port = lookToolPort({ camera: lens, vision: eyes });

    const out = await port.call(LOOK_TOOL, { question: 'Which years are printed in the scan?' });

    expect(eyes.asked.map((q) => q.retake === true)).toEqual([true, false]);
    // 500-600 x 500-550 of a 1200x800 viewport is x 600-720, y 400-440; widened by 15%, at least 12 px.
    expect(lens.aims[1]?.aim?.region).toEqual({ x: 582, y: 388, width: 156, height: 64 });
    expect(eyes.asked[1]?.enlarged).toBe(true);
    expect(out.text).toContain('1874, 1903, 1929');
    expect(out.text).toContain(`(2 of ${String(DEFAULT_LOOKS_PER_RUN)})`);
    expect(out.usage).toEqual({ inputTokens: 2500, outputTokens: 50 });
  });

  test('content not drawn yet is photographed again once the camera has waited for its paint', async () => {
    const lens = camera();
    let call = 0;
    const eyes = vision(() => {
      call += 1;
      return call === 1
        ? { answer: 'the chart is empty', found: false, unpainted: true, usage: {} }
        : { answer: '38.6', found: true, usage: {} };
    });
    const port = lookToolPort({ camera: lens, vision: eyes });
    const out = await port.call(LOOK_TOOL, { question: 'What value is above the April bar?', ref: '7-4242' });
    expect(lens.aims.map((shot) => shot.awaitPaint === true)).toEqual([false, true]);
    expect(lens.aims[1]?.aim?.ref).toEqual(lens.aims[0]?.aim?.ref);
    expect(out.text).toContain('38.6');
  });

  test('the last call of the allowance is never spent on a retake', async () => {
    const lens = camera();
    const eyes = vision(() => ({ answer: 'blurry', found: true, zoom: { x0: 0, y0: 0, x1: 100, y1: 100 }, usage: {} }));
    const port = lookToolPort({ camera: lens, vision: eyes, maxLooks: 1 });
    const out = await port.call(LOOK_TOOL, { question: 'q' });
    expect(eyes.asked.map((q) => q.retake === true)).toEqual([false]);
    expect(lens.shots).toBe(1);
    expect(out.text).toContain('(1 of 1)');
  });

  test('a retake that fails leaves the first answer standing', async () => {
    let shots = 0;
    const lens = camera({
      async shoot() {
        shots += 1;
        if (shots > 1) throw new Error('the page produced no frame');
        return SHOT;
      },
    });
    const port = lookToolPort({ camera: lens, vision: vision(() => ({ answer: 'roughly 40', found: true, unpainted: true, usage: {} })) });
    const out = await port.call(LOOK_TOOL, { question: 'q' });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('roughly 40');
  });
});

describe('page.look is bounded and fails as a step, never as a run', () => {
  test(`the ${String(DEFAULT_LOOKS_PER_RUN)}th look is the last one a run gets`, async () => {
    const eyes = vision(() => ({ answer: 'x', found: true, usage: {} }));
    const port = lookToolPort({ camera: camera(), vision: eyes });
    for (let i = 0; i < DEFAULT_LOOKS_PER_RUN; i += 1) {
      expect((await port.call(LOOK_TOOL, { question: 'q' })).isError).toBe(false);
    }
    const spent = await port.call(LOOK_TOOL, { question: 'q' });
    expect(spent.isError).toBe(true);
    expect(spent.text).toContain('spent');
    expect(eyes.asked).toHaveLength(DEFAULT_LOOKS_PER_RUN);
  });

  test('the allowance is a share of the budget: a long run gets more, a short one fewer, none gets nothing', async () => {
    const eyes = vision(() => ({ answer: 'x', found: true, usage: {} }));
    const long = lookToolPort({ camera: camera(), vision: eyes, maxLooks: lookAllowance('300.00') });
    for (let i = 0; i < 40; i += 1) {
      expect((await long.call(LOOK_TOOL, { question: 'q' })).isError).toBe(false);
    }
    expect((await long.call(LOOK_TOOL, { question: 'q' })).text).toContain('40 of 40 times this run and is spent');
    expect(lookAllowance('2000')).toBeGreaterThan(lookAllowance('300.00'));
    expect(lookAllowance('60')).toBe(DEFAULT_LOOKS_PER_RUN);
    expect(lookAllowance('20.00')).toBe(2);
    expect(lookAllowance('0.50')).toBe(1);
    expect(lookAllowance('not a number')).toBe(DEFAULT_LOOKS_PER_RUN);
  });

  test('a camera that cannot photograph costs no look', async () => {
    let fail = true;
    const eyes = vision(() => ({ answer: 'x', found: true, usage: {} }));
    const port = lookToolPort({
      camera: camera({
        async shoot() {
          if (fail) throw new Error('the page produced no frame');
          return SHOT;
        },
      }),
      vision: eyes,
      maxLooks: 1,
    });
    const refused = await port.call(LOOK_TOOL, { question: 'q' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('no frame');
    fail = false;
    expect((await port.call(LOOK_TOOL, { question: 'q' })).isError).toBe(false);
  });

  test('a malformed call is refused by name before anything is photographed', async () => {
    const lens = camera();
    const port = lookToolPort({ camera: lens, vision: vision(() => ({ answer: 'x', found: true, usage: {} })) });
    expect((await port.call(LOOK_TOOL, {})).text).toContain('needs "question"');
    expect((await port.call(LOOK_TOOL, { question: 'q', ref: 'the button' })).text).toContain('"F-N"');
    expect(lens.shots).toBe(0);
  });
});

describe('the loop carries a look to the next prompt, into the run usage and onto its step', () => {
  test('the answer is echoed to the model, kept on the step, and its tokens are counted', async () => {
    const page = tree(node({ role: 'RootWebArea', name: 'canvas page', children: [node({ role: 'button', name: 'Go' })] }));
    const port = lookToolPort({
      camera: camera(),
      vision: vision(() => ({ answer: 'ZQ-4471-MBX', found: true, usage: { inputTokens: 1338, outputTokens: 29 } })),
    });
    const h = harness({
      tree: page,
      model: (prompt, step): ModelChoice =>
        step === 0
          ? { action: { type: 'callTool', tool: LOOK_TOOL, arguments: { question: 'What code is painted?' } }, usage: { inputTokens: 10, outputTokens: 1 } }
          : { action: { type: 'done', summary: prompt.toolResults?.map((echo) => echo.text).join(' ') ?? '' }, usage: { inputTokens: 10, outputTokens: 1 } },
    });

    const result = await runAgent({ ...h.deps, tools: port }, { task: 'report the painted code', caps: { steps: 3, budget: '10', duration: '10m' }, stepFailures: null });

    expect(h.prompts[1]?.toolResults?.[0]?.text).toContain('ZQ-4471-MBX');
    expect(h.prompts[1]?.tools?.map((tool) => tool.name)).toContain(LOOK_TOOL);
    // The answer is on the durable step, not only in the next prompt.
    expect(result.steps[0]?.tool?.note).toContain('ZQ-4471-MBX');
    // The look's 1,338 + 29 tokens on top of two actuator calls of 10 + 1.
    expect(result.usage.inputTokens).toBe(1358);
    expect(result.usage.outputTokens).toBe(31);
  });
});

describe('what a look reports when it could not identify the element', () => {
  test('a hit test that throws says so, and never claims nothing is there', async () => {
    const port = lookToolPort({
      camera: camera({
        async locate() {
          throw new Error('No node found at given location');
        },
      }),
      vision: vision(() => ({ answer: '15', found: true, point: { x: 500, y: 500 }, usage: {} })),
    });
    const out = await port.call(LOOK_TOOL, { question: 'Where is day 15?' });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('could not be identified (No node found at given location)');
    expect(out.text).not.toContain('No element with a reference is painted there');
  });
});

describe('the look allowance is per run, across every browser the run holds', () => {
  test('a port seeded with the looks earlier browsers took has only the rest', async () => {
    const eyes = vision(() => ({ answer: 'x', found: true, usage: {} }));
    const port = lookToolPort({ camera: camera(), vision: eyes, taken: DEFAULT_LOOKS_PER_RUN - 1 });
    const last = await port.call(LOOK_TOOL, { question: 'q' });
    expect(last.text).toContain(`(${String(DEFAULT_LOOKS_PER_RUN)} of ${String(DEFAULT_LOOKS_PER_RUN)})`);
    expect((await port.call(LOOK_TOOL, { question: 'q' })).text).toContain('spent');
    expect(eyes.asked).toHaveLength(1);
  });

  test('the durable steps count exactly the looks the port counted', async () => {
    let fail = false;
    const port = lookToolPort({
      camera: camera(),
      vision: {
        async ask() {
          if (fail) throw new Error('provider 502');
          return { answer: 'x', found: true, usage: {} };
        },
      },
    });
    const page = tree(node({ role: 'RootWebArea', name: 'p', children: [node({ role: 'button', name: 'Go' })] }));
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice => {
        // Two answered looks, one the vision model failed, then done.
        fail = step === 2;
        return step < 3
          ? { action: { type: 'callTool', tool: LOOK_TOOL, arguments: { question: 'q' } } }
          : { action: { type: 'done' } };
      },
    });
    const result = await runAgent(
      { ...h.deps, tools: port },
      { task: 't', caps: { steps: 5, budget: '10', duration: '10m' }, stepFailures: null },
    );

    expect(looksTaken(result.steps)).toBe(2);
    // The next browser's port, seeded from those steps, continues the count.
    const next = lookToolPort({ camera: camera(), vision: vision(() => ({ answer: 'x', found: true, usage: {} })), taken: looksTaken(result.steps) });
    expect((await next.call(LOOK_TOOL, { question: 'q' })).text).toContain(`(3 of ${String(DEFAULT_LOOKS_PER_RUN)})`);
  });

  test('a look that took a retake is two calls on resume as well', async () => {
    let call = 0;
    const port = lookToolPort({
      camera: camera(),
      vision: vision(() => {
        call += 1;
        return call === 1 ? { answer: 'small', found: true, zoom: { x0: 0, y0: 0, x1: 500, y1: 500 }, usage: {} } : { answer: 'x', found: true, usage: {} };
      }),
    });
    const page = tree(node({ role: 'RootWebArea', name: 'p', children: [node({ role: 'button', name: 'Go' })] }));
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice =>
        step < 2 ? { action: { type: 'callTool', tool: LOOK_TOOL, arguments: { question: 'q' } } } : { action: { type: 'done' } },
    });
    const result = await runAgent({ ...h.deps, tools: port }, { task: 't', caps: { steps: 4, budget: '10', duration: '10m' }, stepFailures: null });
    // The first look zoomed (2 calls), the second did not (1 call).
    expect(looksTaken(result.steps)).toBe(3);
  });
});

describe('a vision model that keeps failing is withdrawn, not asked forever', () => {
  test(`after ${String(MAX_FAILED_LOOKS)} failed asks page.look refuses for the rest of the run`, async () => {
    let asks = 0;
    const port = lookToolPort({
      camera: camera(),
      vision: {
        async ask() {
          asks += 1;
          throw new Error('provider 502');
        },
      },
    });
    for (let i = 0; i < MAX_FAILED_LOOKS; i += 1) {
      expect((await port.call(LOOK_TOOL, { question: 'q' })).text).toContain('failed to read the screenshot');
    }
    const withdrawn = await port.call(LOOK_TOOL, { question: 'q' });
    expect(withdrawn.isError).toBe(true);
    expect(withdrawn.text).toContain(
      `page.look is unavailable this run: the vision model failed ${String(MAX_FAILED_LOOKS)} times (last: provider 502)`,
    );
    expect(asks).toBe(MAX_FAILED_LOOKS);
  });

  test('a model alternating failed looks with other steps cannot get past the bound', async () => {
    // The reviewer's probe: the loop's stepFailures counts CONSECUTIVE
    // failures, so alternating never trips it; it made 20 vision calls in 40 steps.
    let asks = 0;
    const port = lookToolPort({
      camera: camera(),
      vision: {
        async ask() {
          asks += 1;
          throw new Error('provider 502');
        },
      },
    });
    const page = tree(node({ role: 'RootWebArea', name: 'p', children: [node({ role: 'button', name: 'Go' })] }));
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice =>
        step % 2 === 0
          ? { action: { type: 'callTool', tool: LOOK_TOOL, arguments: { question: 'q' } } }
          : { action: { type: 'scroll', dy: 100 } },
    });
    // Three CONSECUTIVE failures end a run; alternating never reaches them.
    const result = await runAgent(
      { ...h.deps, tools: port },
      { task: 't', caps: { steps: 40, budget: '100', duration: '60m' }, stepFailures: 3 },
    );
    expect(result.stepsUsed).toBeGreaterThan(2 * MAX_FAILED_LOOKS + 1);
    expect(asks).toBe(MAX_FAILED_LOOKS);
  });
});
