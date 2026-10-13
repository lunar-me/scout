/**
 * `page.look`: what a text-only actuator gets back when it asks to see.
 *
 * The failure it answers, measured on the failure probes (fleet 54476fe6,
 * 2026-09-24): PG2 0/3 — a code painted on a canvas, which the tree and every
 * `extract` of it read as nothing; one run invented a tool called `img2txt`.
 */
import { describe, expect, test } from 'bun:test';

import type { LookAnswer, LookCamera, LookQuestion, LookShot, LookVision } from '../src/look';
import { LOOK_TOOL, MAX_FAILED_LOOKS, MAX_LOOKS_PER_RUN, looksTaken, lookToolPort } from '../src/look';
import type { ModelChoice } from '../src/loop';
import { runAgent } from '../src/loop';
import { formatNodeRef, nodeRef } from '../src/snapshot';
import { harness, node, tree } from './support';

const SHOT: LookShot = {
  image: { mediaType: 'image/png', base64: 'iVBORw0KGgo=' },
  viewport: { width: 1200, height: 800 },
};

function camera(overrides: Partial<LookCamera> = {}): LookCamera & { shots: number } {
  const state = {
    shots: 0,
    async shoot(): Promise<LookShot> {
      state.shots += 1;
      return SHOT;
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

  test('a named element is passed to the vision model as its box on the same grid', async () => {
    const eyes = vision(() => ({ answer: 'blue', found: true, usage: {} }));
    const shot = { ...SHOT, focus: { x: 120, y: 80, width: 240, height: 160 } };
    const port = lookToolPort({ camera: camera({ shoot: async () => shot }), vision: eyes });
    await port.call(LOOK_TOOL, { question: 'What colour is it?', ref: '7-4242' });
    expect(eyes.asked[0]?.focus).toEqual({ x0: 100, y0: 100, x1: 300, y1: 300 });
  });
});

describe('page.look is bounded and fails as a step, never as a run', () => {
  test(`the ${String(MAX_LOOKS_PER_RUN)}th look is the last one a run gets`, async () => {
    const eyes = vision(() => ({ answer: 'x', found: true, usage: {} }));
    const port = lookToolPort({ camera: camera(), vision: eyes });
    for (let i = 0; i < MAX_LOOKS_PER_RUN; i += 1) {
      expect((await port.call(LOOK_TOOL, { question: 'q' })).isError).toBe(false);
    }
    const spent = await port.call(LOOK_TOOL, { question: 'q' });
    expect(spent.isError).toBe(true);
    expect(spent.text).toContain('spent');
    expect(eyes.asked).toHaveLength(MAX_LOOKS_PER_RUN);
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
    const port = lookToolPort({ camera: camera(), vision: eyes, taken: MAX_LOOKS_PER_RUN - 1 });
    const last = await port.call(LOOK_TOOL, { question: 'q' });
    expect(last.text).toContain(`(${String(MAX_LOOKS_PER_RUN)} of ${String(MAX_LOOKS_PER_RUN)})`);
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
    expect((await next.call(LOOK_TOOL, { question: 'q' })).text).toContain(`(3 of ${String(MAX_LOOKS_PER_RUN)})`);
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
