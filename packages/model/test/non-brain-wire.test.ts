/**
 * The bytes a NON-BRAIN plan puts on the wire, pinned against a golden.
 *
 * Brain mode adds a third model role, a multi-turn provider request and new
 * port paths. None of that may move one byte of what a plan without a brain
 * slot sends: a host's hands-only baselines keep running while brain work
 * lands, and a change to their prompts or call sequence would corrupt them. So
 * this drives the real `HarnessModelPort` through the real
 * `ChatCompletionsProvider` with a scripted transport and compares every
 * request (url, headers, timeout, body — the rendered prompt included) and the
 * order they were made in.
 *
 * Plans, one per code path: an actuator chain alone (a failover and an
 * extraction, reasoning off), a planner called on trouble and stall only, a
 * frontier actor on `json_object` with low reasoning and no `reasoning` reply
 * field, and a planner answering through a forced tool call.
 *
 * Regenerate ONLY from a tree whose non-brain behaviour is known-good:
 * `UPDATE_GOLDEN=1 bun test ./test/non-brain-wire.test.ts`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';
import type { Clock } from '@outcrawl/scout-core';
import { hashSnapshot, nodeRef, renderPrompt, type AgentPrompt, type AxTree, type StepTrace } from '@outcrawl/runtime';

import { ChatCompletionsProvider, type StructuredOutputMode } from '../src/chat-completions';
import { HarnessModelPort, type ModelPlan, type PlanModel } from '../src/harness';
import type { HttpPost, HttpRequest, HttpResponse } from '../src/http';
import { CostLedger } from '../src/ledger';
import type { ReasoningConfig } from '../src/provider';
import type { RateCard, TokenRates } from '../src/rates';
import { node } from './support';

const GOLDEN = new URL('./fixtures/non-brain-wire.golden.json', import.meta.url);

class StillClock implements Clock {
  now(): number {
    return 0;
  }
  sleep(): Promise<void> {
    return Promise.resolve();
  }
}

/* ------------------------------------------------------------------ *
 * The plans
 * ------------------------------------------------------------------ */

/** The hands chain: a measured rank 0, then two fallbacks. */
const HANDS: readonly PlanModel[] = [
  { model: 'hands-model', rank: 0, callsPerStep: 1, actionDeadlineMs: 12_000, extractHedgeMs: 15_000, replyReasoning: true },
  { model: 'hands-fallback', rank: 1, callsPerStep: 1, replyReasoning: true },
  { model: 'hands-fallback-2', rank: 2, callsPerStep: 1, replyReasoning: true },
];

/** A planner over the hands chain, called on trouble and stall only, never on start. */
const planner = (model: string, replyReasoning: boolean): PlanModel => ({
  model,
  rank: 0,
  callsPerStep: 0.34,
  triggers: ['trouble', 'stall'],
  replyReasoning,
});

const PLANS = {
  actuators: { actuators: HANDS },
  'trouble-planner': { actuators: HANDS, planner: planner('planner-model', false) },
  'frontier-actor': { actuators: [{ model: 'frontier-model', rank: 0, callsPerStep: 1, replyReasoning: false }] },
  'tool-planner': { actuators: HANDS, planner: planner('tool-planner-model', true) },
} as const satisfies Record<string, ModelPlan>;

/** How each model is asked for structured output; every other model is `strict`. */
const MODES: Readonly<Record<string, StructuredOutputMode>> = {
  'planner-model': 'json_object',
  'frontier-model': 'json_object',
  'tool-planner-model': 'tool_choice',
};
const outputMode = (model: string): StructuredOutputMode => MODES[model] ?? 'strict';

const textRate: TokenRates = { input: '0.25', output: '1', cacheRead: null, cacheWrite: null, inputModalities: ['text'] };
const frontierRate: TokenRates = { input: '4', output: '20', cacheRead: '0.4', cacheWrite: '5', inputModalities: ['text', 'image'] };
const RATES: RateCard = {
  'hands-model': textRate,
  'hands-fallback': { ...textRate, inputModalities: ['text', 'image'] },
  'hands-fallback-2': { ...textRate, inputModalities: ['text', 'image'] },
  'planner-model': frontierRate,
  'frontier-model': frontierRate,
  'tool-planner-model': frontierRate,
};

/* ------------------------------------------------------------------ *
 * The pages, prompts and replies
 * ------------------------------------------------------------------ */

function page(name: string, base: number): AxTree {
  return {
    url: `https://shop.example.com/${name.toLowerCase()}`,
    root: node({
      role: 'RootWebArea',
      name,
      xpath: '/html',
      backendNodeId: base,
      children: [
        node({ role: 'heading', name: `${name} results`, xpath: '/html/body/h1', backendNodeId: base + 1 }),
        node({ role: 'link', name: 'ASUS TUF A15 - $899.99 - 4.5 stars (1,204)', xpath: '/html/body/a[1]', backendNodeId: base + 2 }),
        node({ role: 'link', name: 'Lenovo LOQ 15 - $749.00 - 4.3 stars (311)', xpath: '/html/body/a[2]', backendNodeId: base + 3 }),
        node({ role: 'textbox', name: 'Search', xpath: '/html/body/input', backendNodeId: base + 4 }),
        node({ role: 'button', name: 'Add to cart', xpath: '/html/body/button', backendNodeId: base + 5 }),
      ],
    }),
  };
}

function trace(index: number, hash: string, extra: Partial<StepTrace> = {}): StepTrace {
  return {
    index,
    action: { type: 'click', ref: nodeRef(0, 102) },
    cache: { status: 'MISS' },
    elapsedMs: 1,
    snapshotHash: hash,
    credits: '0',
    spent: '0',
    pages: 1,
    durationMs: 1,
    usage: {},
    at: '2026-09-24T00:00:00.000Z',
    ...extra,
  } as StepTrace;
}

function prompt(tree: AxTree, step: number, history: readonly StepTrace[]): AgentPrompt {
  const base = {
    task: 'Find the cheapest gaming laptop with at least 4 stars and over 300 reviews; report name and price.',
    today: '2026-10-02',
    step,
    tree,
    snapshotHash: hashSnapshot(tree),
    history,
    schema: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'string' } } },
    caps: {
      limits: { budget: '300', steps: 60, duration: '20m' },
      used: { credits: '1.5', steps: step, elapsedMs: 4_000 * step },
    },
    memory: {
      goals: [{ id: 'g1', goal: 'find candidates', status: 'active' }],
      findings: [{ step: 0, text: 'search page reached' }],
      ruledOut: [],
    },
    tabs: [{ id: 't1', url: tree.url, title: 'Shop', active: true }],
  } as unknown as Omit<AgentPrompt, 'text'>;
  return { ...base, text: renderPrompt(base) } as AgentPrompt;
}

const ok = (content: string, id: string): HttpResponse => ({
  status: 200,
  body: {
    id,
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1200, completion_tokens: 40, cost: '0.0001' },
  },
});

const toolOk = (args: string, id: string): HttpResponse => ({
  status: 200,
  body: {
    id,
    choices: [{ message: { tool_calls: [{ function: { name: 'outcrawl_reply', arguments: args } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 1200, completion_tokens: 40, cost: '0.0001' },
  },
});

/** An upstream 5xx inside an HTTP 200, the shape that demotes a rank. */
const inline502: HttpResponse = {
  status: 200,
  body: { id: 'gen-502', error: { code: 502, message: 'Upstream error from provider-a' }, usage: { cost: '0' } },
};

const click = (id: number): string =>
  JSON.stringify({ reasoning: 'cheapest qualifying', actions: [{ type: 'click', ref: `0-${String(id)}` }] });
const done = JSON.stringify({ reasoning: 'answered', actions: [{ type: 'done', summary: 'Lenovo LOQ 15 at $749.00' }] });
const plan = JSON.stringify({ strategy: 'sort by price', next: ['sort'], avoid: [] });

/* ------------------------------------------------------------------ *
 * The drive
 * ------------------------------------------------------------------ */

interface Captured {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly body: unknown;
}

async function drive(modelPlan: ModelPlan, script: HttpResponse[], actionReasoning: ReasoningConfig = { enabled: false }): Promise<Captured[]> {
  const captured: Captured[] = [];
  const queue = [...script];
  const httpPost: HttpPost = (request: HttpRequest) => {
    captured.push({ url: request.url, headers: request.headers, timeoutMs: request.timeoutMs, body: request.body });
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error(`script ran out at call ${String(captured.length)}`));
    }
    return Promise.resolve(next);
  };
  const port = new HarnessModelPort({
    plan: modelPlan,
    rates: RATES,
    provider: new ChatCompletionsProvider({
      name: 'gateway',
      url: 'https://gateway.example/v1/chat/completions',
      apiKey: 'sk-test',
      headers: { 'x-title': 'Scout' },
      outputMode,
      routing: { order: [], ignore: () => [] },
      httpPost,
    }),
    session: { sessionId: 'sess_golden', accountId: 'acct_golden' },
    ledger: new CostLedger(),
    clock: new StillClock(),
    actionReasoning,
  });

  const first = page('Search', 100);
  const second = page('Results', 200);
  const third = page('Product', 300);
  const p0 = prompt(first, 0, []);
  await port.choose(p0);
  // A failed step: the planner's `trouble` trigger, and a second page.
  const history1 = [trace(0, p0.snapshotHash, { error: 'click(0-102) failed: element is covered' })];
  const p1 = prompt(second, 1, history1);
  await port.choose(p1);
  await port.extract({
    instruction: 'name and price of every laptop listed',
    schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } } },
    content: { kind: 'tree', tree: second },
  });
  const p2 = prompt(third, 2, [...history1, trace(1, p1.snapshotHash)]);
  await port.choose(p2);
  expect(queue).toHaveLength(0);
  return captured;
}

async function captureAll(): Promise<Record<string, Captured[]>> {
  return {
    // The hands chain alone. Rank 0 answers, then an inline 502 demotes to
    // rank 1, which holds for the extraction and the last step.
    actuators: await drive(PLANS.actuators, [
      ok(click(102), 'gen-1'),
      inline502,
      ok(click(203), 'gen-2'),
      ok(JSON.stringify({ items: ['ASUS TUF A15 $899.99', 'Lenovo LOQ 15 $749.00'] }), 'gen-3'),
      ok(done, 'gen-4'),
    ]),
    // Planner on trouble (step 1), never on start.
    'trouble-planner': await drive(PLANS['trouble-planner'], [
      ok(click(102), 'gen-1'),
      ok(plan, 'gen-p'),
      ok(click(203), 'gen-2'),
      ok(JSON.stringify({ items: ['a'] }), 'gen-3'),
      ok(done, 'gen-4'),
    ]),
    // A frontier actor on 'json_object' with mandatory low reasoning.
    'frontier-actor': await drive(
      PLANS['frontier-actor'],
      [
        ok(click(102), 'gen-1'),
        ok(click(203), 'gen-2'),
        ok(JSON.stringify({ items: ['a'] }), 'gen-3'),
        ok(done, 'gen-4'),
      ],
      { effort: 'low' },
    ),
    // A planner whose reply comes back as a forced tool call.
    'tool-planner': await drive(PLANS['tool-planner'], [
      ok(click(102), 'gen-1'),
      toolOk(plan, 'gen-p'),
      ok(click(203), 'gen-2'),
      ok(JSON.stringify({ items: ['a'] }), 'gen-3'),
      ok(done, 'gen-4'),
    ]),
  };
}

describe('non-brain plans put exactly the bytes they did before brain mode', () => {
  /**
   * MUTATIONS THIS CATCHES: any change to a hands / planner / actor prompt,
   * system turn, schema, reasoning field, cache_control or message shape,
   * timeout, header, failover order, or an extra/missing call — e.g. brain
   * code leaking an eyes call into a plan that has no brain slot.
   */
  test('every request, in order, matches the golden', async () => {
    const captured = await captureAll();
    const text = `${JSON.stringify(captured, null, 1)}\n`;
    if (process.env['UPDATE_GOLDEN'] === '1') {
      writeFileSync(GOLDEN, text);
    }
    expect(existsSync(GOLDEN)).toBe(true);
    expect(text).toBe(readFileSync(GOLDEN, 'utf8'));
  });
});
