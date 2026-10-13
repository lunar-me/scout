/**
 * The chat-completions request body, pinned to the byte for every shape of
 * call this package makes (OC-306).
 *
 * `ModelRequest.turns` and `.cache` were added for the brain's multi-turn,
 * prompt-cached conversation. Every existing caller sets neither,
 * and for them the serialised body must not move by one byte: providers key
 * prompt caches on the serialised prefix, so a reshaped body for an unchanged
 * request would cold-miss every warm cache in the fleet on the first call after
 * deploy, for no gain. The digests below were computed from the bodies the
 * provider built at d795061f, BEFORE either field existed, and a test that
 * fails here names a body that changed.
 *
 * RE-PINNED 2026-10-08 (OC-375 wallet): the actor bodies now carry the action
 * schema with `purchase.begin`/`purchase.end` in its `type` enum and the
 * `amount`/`currency` properties. The only difference from the d795061f
 * bodies is that schema (checked against non-brain-wire.golden.json); warm
 * prompt caches cold-miss once on the deploy that carries it.
 *
 * RE-PINNED 2026-10-13 (OC-340): the model ids here are role names now
 * (`hands-model`, `brain-model`, ...), and the routing and wire shape per
 * model are injected the way a host injects them. The digests moved with the
 * ids and nothing else: the same pins over the production ids, digests
 * unchanged since 2026-10-08, live with the host's configuration tests and
 * still pass against this provider.
 *
 * The bodies are produced through the real `ModelClient` where a real caller
 * goes through it (actor, extract, planner), and through the provider directly
 * for the vision shape, so the pin covers what the client actually
 * hands the provider and not a hand-typed approximation of it.
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import type { PageView } from '@outcrawl/runtime';

import { ModelClient, extractPromptText } from '../src/client';
import { ChatCompletionsProvider, type StructuredOutputMode } from '../src/chat-completions';
import type { HttpPost, HttpResponse } from '../src/http';
import { ModelConfigError, type ModelRequest } from '../src/provider';
import { FakeProvider, cartPage, promptFor, reply } from './support';

/** The wire shape per model, as a host's table chooses it: one model per mode. */
const MODES: Readonly<Record<string, StructuredOutputMode>> = {
  'planner-model': 'tool_choice',
  'brain-model': 'json_object',
};

/** The upstream the brain model is never served from. */
const BRAIN_EXCLUDED = ['provider-b'] as const;

/** A 200 whose content no schema accepts: only the FIRST body is pinned. */
const REPLY: HttpResponse = {
  status: 200,
  body: {
    id: 'gen-body-pin',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }],
    usage: { cost: '0.000001', prompt_tokens: 1, completion_tokens: 1 },
  },
};

function capture(): { readonly provider: ChatCompletionsProvider; readonly bodies: string[] } {
  const bodies: string[] = [];
  const post: HttpPost = (request) => {
    // What `systemHttpPost` puts on the wire, exactly.
    bodies.push(JSON.stringify(request.body));
    return Promise.resolve(REPLY);
  };
  const provider = new ChatCompletionsProvider({
    name: 'gateway',
    url: 'https://gateway.example/v1/chat/completions',
    apiKey: 'k',
    httpPost: post,
    outputMode: (model) => MODES[model] ?? 'strict',
    routing: { order: [], ignore: (model) => (model === 'brain-model' ? BRAIN_EXCLUDED : []) },
  });
  return { provider, bodies };
}

function digest(body: string | undefined): string {
  return createHash('sha256')
    .update(body ?? '')
    .digest('hex');
}

/** One 1x1 PNG, the shape every image caller sends. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const VIEW: PageView = {
  image: { mediaType: 'image/png', base64: PIXEL },
  marks: [],
  geometry: { viewport: { width: 1, height: 1 }, scroll: { x: 0, y: 0 }, document: { width: 1, height: 1 } },
  offscreen: { above: 0, below: 0 },
  captureMs: 0,
  pixels: { width: 1, height: 1 },
};

const PRICES = {
  type: 'object',
  properties: { prices: { type: 'array', items: { type: 'number' } } },
  required: ['prices'],
} as const;

async function actorBody(model: string, withView: boolean, replyReasoning = true): Promise<string | undefined> {
  const { provider, bodies } = capture();
  const client = new ModelClient({ provider, model, replyReasoning, session: { sessionId: 's', accountId: 'a' } });
  const tree = cartPage(1);
  const prompt = promptFor(tree, 'buy the cheapest item');
  await client
    .choose(withView ? { ...prompt, view: VIEW } : prompt)
    .catch(() => undefined);
  return bodies[0];
}

async function extractBody(
  model: string,
  instruction: string | null,
  markdown: string,
  extra: Partial<ConstructorParameters<typeof ModelClient>[0]> = {},
): Promise<string | undefined> {
  const { provider, bodies } = capture();
  const client = new ModelClient({ provider, model, session: { sessionId: 's', accountId: 'a' }, ...extra });
  await client.extract({ instruction, schema: PRICES, content: { kind: 'markdown', markdown } }).catch(() => undefined);
  return bodies[0];
}

describe('the body of every request shape is byte-identical to its pin', () => {
  test('actor, strict json_schema', async () => {
    expect(digest(await actorBody('hands-model', false))).toBe('35d3ce183a28f19500747c76f65cbb010bbb329480ec4ce167933f412cf34447');
  });

  test('actor, forced tool call', async () => {
    expect(digest(await actorBody('planner-model', false))).toBe('6d8bc4e67487c1deedc138cd293191eb5f7b6fb627dfadc75162888ea19dca3c');
  });

  test('actor, json_object with the schema in the system text, no reasoning field in the reply, and an excluded upstream', async () => {
    expect(digest(await actorBody('brain-model', false, false))).toBe('27ffa17bc0ceb4eef442afb3e828c7a4237e7995d67e02a342148087298566f6');
  });

  test('actor with the vision arm: text then image parts', async () => {
    const body = await actorBody('hands-model', true);
    expect(body).toContain('"type":"image_url"');
    expect(digest(body)).toBe('2fed02370b64838f0f5e0f1c88aca2878ab824e98d3938869d20ba7f5f6084be');
  });

  test('extract, strict, no instruction', async () => {
    expect(digest(await extractBody('hands-model', null, '# Cart\n\n- $3.50\n- $12'))).toBe('661ebee67231fb0b571eed0ec54ea2d829d7786a9d323e634fa8cdf241bb03a6');
  });

  test('planner: an extract over a digest, json_object, low effort, temperature 0', async () => {
    const body = await extractBody(
      'brain-model',
      'Write the plan for the next steps.',
      JSON.stringify({ task: 'buy the cheapest item', url: 'https://shop.test/cart', steps: 3 }, null, 1),
      { extractSystemPrompt: 'You are the planner.', extractReasoning: { effort: 'low' }, temperature: 0 },
    );
    expect(digest(body)).toBe('2c4d85099064f6a9344063bde76b5ef197a23b2d707350febbc005cd26a2b575');
  });

  test('vision: provider-direct, images, temperature 0, no max_tokens', async () => {
    const { provider, bodies } = capture();
    const request: ModelRequest = {
      model: 'vision-model',
      system: 'Find the checkbox.',
      prompt: 'Where is the checkbox?',
      images: [{ mediaType: 'image/png', base64: PIXEL }],
      schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
      temperature: 0,
      timeoutMs: 30_000,
    };
    await provider.complete(request).catch(() => undefined);
    expect(bodies[0]).toContain('"type":"image_url"');
    expect(digest(bodies[0])).toBe('5540d0ac4ea1a1f57a935a7d67194148e4625113f6316a77cef84a73595a245e');
  });
});

describe('a cached conversation thread', () => {
  const turns = [
    { role: 'user', content: 'step 1 ask' },
    { role: 'assistant', content: '{"prices":[1]}' },
    { role: 'user', content: 'step 2 ask' },
    { role: 'assistant', content: '{"prices":[2]}' },
  ] as const;
  const base: ModelRequest = { model: 'brain-model', system: 'SYSTEM', prompt: 'step 3 ask', timeoutMs: 30_000 };
  const ephemeral = { type: 'ephemeral' };

  async function sentMessages(request: ModelRequest): Promise<unknown> {
    const { provider, bodies } = capture();
    await provider.complete(request).catch(() => undefined);
    return (JSON.parse(bodies[0] ?? '{}') as { messages?: unknown }).messages;
  }

  test('cache: breakpoints on the system block and the LAST user turn only, never the final prompt', async () => {
    // MUTATION: a breakpoint on an assistant turn or on every user turn, or on
    // the final prompt (which the brain never replays, so it would only pay
    // the cache-write premium on every call).
    expect(await sentMessages({ ...base, turns, cache: true })).toEqual([
      { role: 'system', content: [{ type: 'text', text: 'SYSTEM', cache_control: ephemeral }] },
      { role: 'user', content: 'step 1 ask' },
      { role: 'assistant', content: '{"prices":[1]}' },
      { role: 'user', content: [{ type: 'text', text: 'step 2 ask', cache_control: ephemeral }] },
      { role: 'assistant', content: '{"prices":[2]}' },
      { role: 'user', content: 'step 3 ask' },
    ]);
  });

  test('turns without cache: plain strings, no breakpoint anywhere', async () => {
    expect(await sentMessages({ ...base, turns })).toEqual([
      { role: 'system', content: 'SYSTEM' },
      ...turns,
      { role: 'user', content: 'step 3 ask' },
    ]);
  });

  test('cache with a tail: the prompt part carries the breakpoint, the tail rides after it uncached', async () => {
    // MUTATION: a breakpoint on the tail (an entry nobody reads back) or none
    // on the prompt part (the next call, which replays it as a turn, misses).
    const messages = (await sentMessages({ ...base, turns, cache: true, tail: 'ELEMENTS' })) as { content: unknown }[];
    expect(messages.at(-1)?.content).toEqual([
      { type: 'text', text: 'step 3 ask', cache_control: ephemeral },
      { type: 'text', text: 'ELEMENTS' },
    ]);
  });

  test('a per-request provider order goes on that request only, with fallbacks on', async () => {
    const { provider, bodies } = capture();
    const schema = { type: 'object', properties: { do: { type: 'string' } }, required: ['do'], additionalProperties: false };
    await provider.complete({ ...base, model: 'hands-model', schema, providerOrder: ['provider-a'] });
    await provider.complete({ ...base, model: 'hands-model', schema });
    const sent = bodies.map((body) => JSON.parse(body) as { provider?: unknown });
    expect(sent[0]?.provider).toEqual({ require_parameters: true, order: ['provider-a'], allow_fallbacks: true });
    expect(sent[1]?.provider).toEqual({ require_parameters: true });
  });

  test("a model's excluded upstreams go on every call to it, with or without a schema; other models are untouched", async () => {
    // MUTATION: the exclusion only on the schema path, only with an order, or
    // spread to every model.
    const { provider, bodies } = capture();
    const schema = { type: 'object', properties: { do: { type: 'string' } }, required: ['do'], additionalProperties: false };
    const brain = { ...base, model: 'brain-model' };
    await provider.complete({ ...brain, schema, providerOrder: ['provider-a'] });
    await provider.complete({ ...brain, schema });
    await provider.complete(brain);
    await provider.complete({ ...base, model: 'hands-model', schema });
    const sent = bodies.map((body) => JSON.parse(body) as { provider?: Record<string, unknown> });
    expect(sent[0]?.provider).toEqual({ require_parameters: true, order: ['provider-a'], allow_fallbacks: true, ignore: BRAIN_EXCLUDED });
    expect(sent[1]?.provider).toEqual({ require_parameters: true, ignore: BRAIN_EXCLUDED });
    expect(sent[2]?.provider).toEqual({ ignore: BRAIN_EXCLUDED });
    expect(sent[3]?.provider).toEqual({ require_parameters: true });
  });

  test('a thread that does not alternate user/assistant, ending on assistant, is refused unsent', async () => {
    for (const bad of [[turns[1]], [turns[0]], [turns[0], turns[2]]]) {
      const { provider, bodies } = capture();
      const thrown = await provider.complete({ ...base, turns: bad }).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(ModelConfigError);
      expect(bodies).toHaveLength(0);
    }
  });

  test('ModelClient.extract sends the same thread and cache hint on its correction, and returns the raw reply', async () => {
    // MUTATION: dropping `turns` on the correction, or putting the correction
    // into the thread, would move the cached prefix; replaying anything but
    // `extractPromptText` as the user turn would miss it on the next step.
    const raw = '{"prices": [3.5, 12]}';
    const provider = new FakeProvider([reply('{"prices":"no"}'), reply(raw)]);
    const client = new ModelClient({ provider, model: 'brain-model', session: { sessionId: 's', accountId: 'a' } });
    const input = { instruction: null, schema: PRICES, content: { kind: 'markdown', markdown: '# Cart' } } as const;
    const result = await client.extract(input, { turns, cache: true });

    expect(provider.requests).toHaveLength(2);
    for (const sent of provider.requests) {
      expect(sent.turns).toEqual(turns);
      expect(sent.cache).toBe(true);
    }
    expect(provider.requests[0]?.prompt).toBe(extractPromptText(input));
    expect(provider.requests[1]?.prompt.startsWith(extractPromptText(input))).toBe(true);
    expect(result.text).toBe(raw);
    expect(result.data).toEqual({ prices: [3.5, 12] });
  });
});
