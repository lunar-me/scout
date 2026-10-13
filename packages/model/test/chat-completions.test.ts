/**
 * The chat-completions provider, against the shapes measured on a live gateway
 * on 2026-09-03. The transport is faked; the host's live verification script is
 * what re-checks the wire.
 *
 * The payloads below are verbatim excerpts of real responses, so a field name
 * changing under us is a diff against something that was actually observed
 * rather than against something someone remembered.
 */

import { describe, expect, test } from 'bun:test';
import { compareDecimal, type Clock } from '@outcrawl/scout-core';

import { shouldFailOver } from '../src/harness';
import {
  ChatCompletionsProvider,
  readUsage,
  type ChatCompletionsProviderOptions,
  type CostFallbackEvent,
  type ProviderRouting,
  type StructuredOutputMode,
} from '../src/chat-completions';
import { CostLedger } from '../src/ledger';
import { ModelClient } from '../src/client';
import { ModelCancelledError, ModelProviderError, ModelTimeoutError, ModelUnusableError, type ModelRequest } from '../src/provider';
import { costOf, ratesIn, type RateCard } from '../src/rates';
import {
  HttpTransportError,
  systemHttpGet,
  systemHttpPost,
  type HttpGet,
  type HttpPost,
  type HttpResponse,
} from '../src/http';

const COMPLETIONS_URL = 'https://gateway.example/v1/chat/completions';
const GENERATION_URL = 'https://gateway.example/v1/generation';

/**
 * The provider under test: a gateway with a generation record, every model on
 * 'strict' and no routing block, unless a test says otherwise.
 */
function gateway(options: Partial<ChatCompletionsProviderOptions> = {}): ChatCompletionsProvider {
  return new ChatCompletionsProvider({
    name: 'gateway',
    url: COMPLETIONS_URL,
    apiKey: 'k',
    generationUrl: GENERATION_URL,
    ...options,
  });
}

/** A routing block with no order and no exclusions: only the schema guard. */
const ROUTED: ProviderRouting = { order: [], ignore: () => [] };

/** The wire shape per model, as a host's table would choose it. */
const MODES: Readonly<Record<string, StructuredOutputMode>> = {
  'planner-model': 'tool_choice',
  'brain-model': 'json_object',
};
const outputMode = (model: string): StructuredOutputMode => MODES[model] ?? 'strict';

const REQUEST: ModelRequest = {
  model: 'hands-model',
  system: 'reply with JSON',
  prompt: 'pick an action',
  schema: { type: 'object', properties: { actions: { type: 'array' } }, required: ['actions'] },
  maxTokens: 512,
  timeoutMs: 30_000,
};

function posting(response: HttpResponse): { post: HttpPost; sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    post: (request) => {
      sent.push(request);
      return Promise.resolve(response);
    },
  };
}

/**
 * A 200 shaped exactly like the measured one, with usage overridable.
 *
 * `usage.cost` is the STRING `'0.00000245'` because that is what the real
 * transport hands the provider: `systemHttpPost` returns the number's JSON
 * source text for every key the provider names in `exactNumberKeys`. The
 * measured value, the rank-0 hands model, 2026-09-25.
 */
function ok(usage: Record<string, unknown>, extra: Record<string, unknown> = {}): HttpResponse {
  return {
    status: 200,
    body: {
      id: 'gen-1788473464-VscY105DrU0t2IE7jEB3',
      object: 'chat.completion',
      model: 'hands-model',
      provider: 'provider-a',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          native_finish_reason: 'STOP',
          message: { role: 'assistant', content: '{"actions":[]}', refusal: null, reasoning: null },
        },
      ],
      usage: { cost: '0.00000245', ...usage },
      ...extra,
    },
  };
}

describe('the request', () => {
  test('sends response_format.json_schema with strict, and a Bearer credential', async () => {
    const { post, sent } = posting(ok({ prompt_tokens: 10, completion_tokens: 5 }));
    await gateway({ apiKey: 'secret-key', httpPost: post }).complete(REQUEST);

    const request = sent[0] as { url: string; headers: Record<string, string>; body: Record<string, unknown> };
    expect(request.url).toBe(COMPLETIONS_URL);
    expect(request.headers['authorization']).toBe('Bearer secret-key');
    expect(request.body['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'outcrawl_reply', strict: true, schema: REQUEST.schema },
    });
    // System and user as two messages, which is the protocol here rather than
    // a top-level `system` field.
    expect(request.body['messages']).toEqual([
      { role: 'system', content: 'reply with JSON' },
      { role: 'user', content: 'pick an action' },
    ]);
  });

  /**
   * An endpoint that does not route sends no routing field at all: a plain
   * chat-completions server may reject a key it does not know, and a gateway
   * that does route would read even an empty block as a request.
   * MUTATION THIS CATCHES: `provider: { require_parameters: true }` (or a
   * per-request order) sent without a host routing block.
   */
  test('with no routing, no provider key is sent, with or without a schema, in every mode', async () => {
    const { post, sent } = posting(ok({ prompt_tokens: 10, completion_tokens: 5 }));
    const provider = gateway({ httpPost: post, outputMode });
    const { schema: _omitted, ...plain } = REQUEST;

    await provider.complete(REQUEST);
    await provider.complete(plain);
    await provider.complete({ ...REQUEST, providerOrder: ['provider-a'] });
    await provider.complete({ ...REQUEST, model: 'planner-model' });
    await provider.complete({ ...REQUEST, model: 'brain-model' });

    expect(sent).toHaveLength(5);
    for (const request of sent as { body: Record<string, unknown> }[]) {
      expect('provider' in request.body).toBe(false);
    }
  });
});

describe('usage', () => {
  /**
   * MUTATION THIS CATCHES: `inputTokens: promptTotal` — passing `prompt_tokens`
   * straight through, which is right for a provider with disjoint counters and
   * which this provider must NOT do.
   *
   * `TokenUsage.inputTokens` is documented as excluding both cache figures.
   * Some protocols report three disjoint counters; chat-completions reports
   * `prompt_tokens` as the TOTAL and `cached_tokens` as a subset of it.
   * Measured on 2026-09-03: 63 prompt tokens x $0.0000003 =
   * `upstream_inference_prompt_cost` 0.0000189 exactly, with no separate cached
   * line item, which is only consistent with containment.
   *
   * Pass it through and every cached input token is priced twice — once at the
   * full input rate here, again at the cache-read rate in `costOf`. On the agent
   * loop, where each step re-sends an identical system preamble and task, cached
   * input is the majority of the spend, so the overcharge GROWS with exactly the
   * thing prompt caching exists to make cheap. And it looks plausible: no error,
   * no warning, a number in the right order of magnitude.
   */
  test('de-overlaps prompt_tokens, because cached tokens are inside it', () => {
    const usage = readUsage({
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 },
      completion_tokens_details: { reasoning_tokens: 12 },
    });

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      reasoningTokens: 12,
    });
    // The three input counters sum back to what the provider reported. That is
    // the invariant `costOf` depends on and the one the mutation breaks.
    expect(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens).toBe(1000);
  });

  test('a negative result is clamped rather than trusted', () => {
    // Impossible from a correct provider, and `tokensAsMillions` throws on a
    // negative count — which would crash a step inside the action lock, on a
    // frozen page, two frames from the cause.
    const usage = readUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 99 } });
    expect(usage.inputTokens).toBe(0);
  });

  test('an absent usage block is zeros, not undefined arithmetic', () => {
    expect(readUsage(undefined).inputTokens).toBe(0);
    expect(readUsage({ prompt_tokens: 'lots' }).inputTokens).toBe(0);
  });
});

describe('the reply', () => {
  /**
   * MUTATION THIS CATCHES: reading the request id from the response HEADERS,
   * which is what `systemHttpPost` exposes.
   *
   * Measured: the gateway sends NO `request-id` header — it lists it in
   * `access-control-expose-headers` and never sets it. The id a support ticket
   * is answered by is the body's `id` (`gen-…`). Read it from the header and
   * `CostEntry.requestId` is null for every gateway call, which is the field
   * that exists so a disputed charge can be traced to the provider's own record.
   */
  test('takes the generation id from the body, because there is no header', async () => {
    const { post } = posting(ok({ prompt_tokens: 10, completion_tokens: 5 }));
    const response = await gateway({ httpPost: post }).complete(REQUEST);

    expect(response.requestId).toBe('gen-1788473464-VscY105DrU0t2IE7jEB3');
    expect(response.text).toBe('{"actions":[]}');
    expect(response.stopReason).toBe('stop');
  });

  /**
   * MUTATION THIS CATCHES: dropping `length` from UNUSABLE_FINISH_REASONS, or
   * keying the guard on another protocol's `max_tokens` instead.
   *
   * Measured: truncation is a 200 with `finish_reason: "length"` and
   * `native_finish_reason: "MAX_TOKENS"`, carrying usage. Return that text and
   * the client hands `JSON.parse` a fragment, then reports the parse failure as
   * the model's fault — while the tokens were billed either way.
   */
  test('a reply truncated at max_tokens is unusable, not text', async () => {
    const { post } = posting({
      status: 200,
      body: {
        id: 'gen-1788473797-41inEiGQZjZNj6CU084k',
        choices: [
          {
            finish_reason: 'length',
            native_finish_reason: 'MAX_TOKENS',
            message: { role: 'assistant', content: '## Navigating the Digital', refusal: null },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8, cost: '0.0000032' },
      },
    });

    const thrown: unknown = await gateway({ httpPost: post })
      .complete(REQUEST)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ModelUnusableError);
    const error = thrown as ModelUnusableError;
    expect(error.message).toMatch(/truncated/);
    // The upstream's own word, because "length" does not say which provider cut
    // the reply off.
    expect(error.message).toMatch(/MAX_TOKENS/);
    // Billed, so counted — tokens and the USD the provider stated. Leaving this
    // out understates spend on exactly the runs someone is investigating.
    expect(error.usage.outputTokens).toBe(8);
    expect(error.costUsd).toBe('0.0000032');
  });

  /**
   * MUTATIONS THIS CATCHES: a brain decision lost to a junk tail after it
   * (the brain model on one upstream: a valid decision, then `<invoke>` to the
   * cap), and a
   * salvage that leaks into calls that did not ask for it.
   */
  test('a truncated reply holding one complete JSON object is kept only when the request asks', async () => {
    const body = {
      id: 'gen-salvage',
      choices: [
        {
          finish_reason: 'length',
          message: { role: 'assistant', content: '<invoke>{"do":"act","a":{"type":"click","ref":"0-11"}}<invoke><invoke><invoke', refusal: null },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 1000, cost: '0.01' },
    };
    const asked = await gateway({ httpPost: posting({ status: 200, body }).post }).complete({
      ...REQUEST,
      salvageTruncated: true,
    });
    expect(asked.text).toBe('{"do":"act","a":{"type":"click","ref":"0-11"}}');
    expect(asked.stopReason).toBe('length-salvaged');
    expect(asked.costUsd).toBe('0.01');

    const plain: unknown = await gateway({ httpPost: posting({ status: 200, body }).post })
      .complete(REQUEST)
      .catch((error: unknown) => error);
    expect(plain).toBeInstanceOf(ModelUnusableError);
  });

  /**
   * MUTATION THIS CATCHES: a cut reply that cannot be looked up because its id was lost.
   */
  test('a cut reply keeps its generation id', async () => {
    const cut: unknown = await gateway({
      httpPost: posting({
        status: 200,
        body: { id: 'gen-cut', choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'prose <invoke name="act">', refusal: null } }], usage: { prompt_tokens: 10, completion_tokens: 1000, cost: '0.01' } },
      }).post,
    })
      .complete({ ...REQUEST, salvageTruncated: true })
      .catch((error: unknown) => error);
    expect(cut).toBeInstanceOf(ModelUnusableError);
    expect((cut as ModelUnusableError).requestId).toBe('gen-cut');
  });

  test('a populated refusal is unusable and names why', async () => {
    const { post } = posting(
      ok(
        { prompt_tokens: 4, completion_tokens: 0 },
        {
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: null, refusal: 'policy: violent content' },
            },
          ],
        },
      ),
    );

    const thrown: unknown = await gateway({ httpPost: post })
      .complete(REQUEST)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ModelUnusableError);
    expect((thrown as ModelUnusableError).message).toMatch(/violent content/);
  });
});

describe('errors', () => {
  /**
   * MUTATION THIS CATCHES: reading `error.type` — another protocol's string
   * discriminator — instead of `error.code`.
   *
   * Measured: `{"error":{"message":"… is not a valid model ID","code":400}}` with
   * `code` as a NUMBER. Reading `type` yields `undefined`, so every gateway
   * failure collapses to `http_<status>` and an operator loses the one field that
   * distinguishes our bug from the provider's.
   */
  test('reads the numeric code and the message from the error envelope', async () => {
    const { post } = posting({
      status: 400,
      body: { error: { message: 'nope-model is not a valid model ID', code: 400 } },
    });

    const thrown: unknown = await gateway({ httpPost: post })
      .complete(REQUEST)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ModelProviderError);
    const error = thrown as ModelProviderError;
    // The provider's name, then the code: one prefix per configured provider.
    expect(error.providerCode).toBe('gateway_400');
    expect(error.message).toMatch(/not a valid model ID/);
    // A 400 will fail identically next time. Retrying burns the same money.
    expect(error.retryable).toBe(false);
  });

  test('429 and 5xx are retryable, other 4xx are not', async () => {
    for (const [status, retryable] of [
      [401, false],
      [429, true],
      [500, true],
      [503, true],
    ] as const) {
      const { post } = posting({ status, body: { error: { message: 'x', code: status } } });
      const thrown: unknown = await gateway({ httpPost: post })
        .complete(REQUEST)
        .catch((error: unknown) => error);
      expect((thrown as ModelProviderError).retryable).toBe(retryable);
    }
  });

  test('our own deadline is a timeout, not a provider failure', async () => {
    const post: HttpPost = () =>
      Promise.reject(new HttpTransportError('https://gateway.example/', new Error('slow'), true));

    const thrown: unknown = await gateway({ httpPost: post })
      .complete(REQUEST)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ModelTimeoutError);
  });

  test('a transport failure is status 0 and retryable, because nothing was billed', async () => {
    const post: HttpPost = () =>
      Promise.reject(new HttpTransportError('https://gateway.example/', new Error('ECONNRESET'), false));

    const thrown: unknown = await gateway({ httpPost: post })
      .complete(REQUEST)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ModelProviderError);
    expect((thrown as ModelProviderError).status).toBe(0);
    expect((thrown as ModelProviderError).retryable).toBe(true);
  });

  /**
   * A hedge's loser, withdrawn. Both halves of the real transport can take the
   * abort — the request (before headers) and the body read (the gateway sends
   * headers early and pads the body) — and both must report a cancellation.
   * MUTATIONS THIS CATCHES: the request half reporting a `transport_error`, and
   * the body half swallowing the abort into `body = undefined`, which reads as
   * the provider's `unparseable_response` — retryable, so the client would
   * resend a call nobody wants.
   */
  test("the caller's withdrawal is a cancellation, before the headers and mid-body", async () => {
    // Before the headers: a real loopback socket that never answers.
    const asked = Promise.withResolvers<void>();
    const held = Promise.withResolvers<Response>();
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        asked.resolve();
        return held.promise;
      },
    });
    try {
      const abort = new AbortController();
      const call = gateway({
        httpPost: systemHttpPost,
        url: `http://127.0.0.1:${String(server.port)}/v1/chat/completions`,
      }).complete({ ...REQUEST, timeoutMs: 60_000, signal: abort.signal });
      await asked.promise;
      abort.abort();
      expect(await call.catch((error: unknown) => error)).toBeInstanceOf(ModelCancelledError);
    } finally {
      // A handler still pending holds `stop` open; answer it to nobody first.
      held.resolve(new Response('{}'));
      await server.stop(true);
    }

    // Mid-body: headers returned, padding sent, the reply not yet generated.
    // `fetch` is replaced for this half only because a real socket cannot say
    // when the client has its headers; the body errors on the abort exactly as
    // a real fetch body does.
    const realFetch = globalThis.fetch;
    const headers = Promise.withResolvers<void>();
    globalThis.fetch = ((_: unknown, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('\n  \n'));
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
        },
      });
      headers.resolve();
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch;
    try {
      const abort = new AbortController();
      const call = gateway({ httpPost: systemHttpPost }).complete({
        ...REQUEST,
        timeoutMs: 60_000,
        signal: abort.signal,
      });
      await headers.promise;
      abort.abort();
      expect(await call.catch((error: unknown) => error)).toBeInstanceOf(ModelCancelledError);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  /**
   * MUTATION THIS CATCHES: not checking `payload.error` on a 2xx.
   *
   * The gateway surfaces upstream failures that arrive after the response has
   * started as a 200 with a populated `error`. Ignore it and `choices` is
   * missing, so a `no_choices` error is raised naming nothing — losing the
   * upstream's own message, which is the only thing that says which provider
   * broke.
   */
  test('a 200 carrying an error is an error, with the message kept', async () => {
    const { post } = posting({
      status: 200,
      body: { id: 'gen-x', error: { message: 'upstream is down', code: 502 } },
    });

    const thrown: unknown = await gateway({ httpPost: post })
      .complete(REQUEST)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ModelProviderError);
    expect((thrown as ModelProviderError).message).toMatch(/upstream is down/);
    expect((thrown as ModelProviderError).requestId).toBe('gen-x');
  });

  /**
   * MUTATION THIS CATCHES: dropping the upstream code from the inline error, so
   * the chain reads the wire's 200 and never demotes. The body is the one
   * production received on 2026-09-24 (run_41d1229b-44fd-404b-9d1e-326c4be4bc94).
   */
  test('an upstream 502 inside a 200 is an error the chain fails over on', async () => {
    const { post } = posting({
      status: 200,
      body: {
        id: 'gen-z',
        error: {
          code: 502,
          message: 'Upstream error from provider-a: The server had an error while processing your request.',
        },
      },
    });

    const thrown: unknown = await gateway({ httpPost: post })
      .complete(REQUEST)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ModelProviderError);
    expect((thrown as ModelProviderError).status).toBe(200);
    expect(shouldFailOver(thrown)).toBe(true);
  });

  test('a 2xx with no choices is an error, not an empty answer', async () => {
    const { post } = posting({ status: 200, body: { id: 'gen-y', choices: [] } });

    const thrown: unknown = await gateway({ httpPost: post })
      .complete(REQUEST)
      .catch((error: unknown) => error);

    expect((thrown as ModelProviderError).providerCode).toBe('no_choices');
  });
});

describe('the reasoning field is sent only when asked for', () => {
  /** `posting` records whole requests; only the body is ever asserted on. */
  const bodiesOf = (sent: readonly unknown[]): Record<string, unknown>[] => {
    const bodies: Record<string, unknown>[] = [];
    for (const request of sent) {
      if (request !== null && typeof request === 'object' && 'body' in request) {
        const body = request.body;
        if (body !== null && typeof body === 'object') {
          bodies.push(body as Record<string, unknown>);
        }
      }
    }
    return bodies;
  };

  test('no reasoning config sends NO reasoning key at all', async () => {
    const { post, sent } = posting(ok({ prompt_tokens: 10, completion_tokens: 5 }));
    await gateway({ httpPost: post }).complete(REQUEST);

    // The guarantee every caller relies on: a client that configures nothing
    // sends the bytes it sent before this field existed. An empty
    // `reasoning: {}` would pass a looser assertion and is a DIFFERENT request —
    // providers key prompt caches on the serialised body, and an empty object
    // reads as "enabled at the default" to some upstreams.
    expect('reasoning' in (bodiesOf(sent)[0] ?? {})).toBe(false);
  });

  test('effort, the separate reasoning ceiling and the off switch each go on the wire', async () => {
    const { post, sent } = posting(ok({ prompt_tokens: 10, completion_tokens: 5 }));
    const provider = gateway({ httpPost: post });

    await provider.complete({ ...REQUEST, reasoning: { effort: 'none' } });
    await provider.complete({ ...REQUEST, reasoning: { maxTokens: 128 } });
    await provider.complete({ ...REQUEST, reasoning: { enabled: false } });

    const bodies = bodiesOf(sent);
    expect(bodies[0]?.['reasoning']).toEqual({ effort: 'none' });
    // `maxTokens` -> `max_tokens` INSIDE the reasoning object, and the request's
    // own `max_tokens` is untouched: they are independent ceilings, measured to
    // be honoured independently.
    expect(bodies[1]?.['reasoning']).toEqual({ max_tokens: 128 });
    expect(bodies[1]?.['max_tokens']).toBe(512);
    expect(bodies[2]?.['reasoning']).toEqual({ enabled: false });
  });

  /**
   * AN ABSENT CEILING SENDS NO KEY, on the same grounds as the reasoning field
   * above: providers key prompt caches on the serialised body, and
   * `max_tokens: null` is a different request from one that never mentioned it.
   *
   * The reason the field became optional is measured: `packages/captcha`'s
   * vision port set 800 and 36 of 222 thrown looks came back `the reply was cut
   * off at max_tokens`. The gateway's own default is the rest of the model's
   * context, which is the ceiling that actually knows the model.
   *
   * MUTATION THIS CATCHES: keeping `max_tokens: request.maxTokens` in the
   * literal. The wire then carries the key with an undefined value, which is
   * exactly the ambiguity this asserts against.
   */
  test('an absent reply ceiling sends NO max_tokens key at all', async () => {
    const { post, sent } = posting(ok({ prompt_tokens: 10, completion_tokens: 5 }));
    const { maxTokens: _omitted, ...uncapped } = REQUEST;

    await gateway({ httpPost: post }).complete(uncapped);

    expect('max_tokens' in (bodiesOf(sent)[0] ?? {})).toBe(false);
  });
});

/**
 * Which wire shape a schema-constrained request takes is the host's choice per
 * model (`outputMode`); the provider only obeys it. The host's table, and the
 * measurements behind each entry, live with the host's configuration.
 * MUTATION THIS CATCHES: the mode chosen for a schema-less call, or read from
 * anything but the request's model.
 */
describe('outputMode', () => {
  test('is asked for the request model, and only when a schema is sent', async () => {
    const { post } = posting(ok({ prompt_tokens: 10, completion_tokens: 5 }));
    const asked: string[] = [];
    const provider = gateway({
      httpPost: post,
      outputMode: (model) => {
        asked.push(model);
        return outputMode(model);
      },
    });
    const { schema: _omitted, ...plain } = REQUEST;

    await provider.complete({ ...REQUEST, model: 'brain-model' });
    await provider.complete({ ...plain, model: 'planner-model' });

    expect(asked).toEqual(['brain-model']);
  });
});

/**
 * 'json_object' has no provider-side shape guarantee, so the schema must
 * reach the model in the prompt, and the reply is read from `content`.
 * MUTATIONS THIS CATCHES: the schema dropped from the system message (the
 * model then answers in a shape nothing validates against), a json_schema
 * `response_format` sent anyway (the hang this mode exists to avoid), and
 * the routing guard lost.
 */
describe("'json_object' mode", () => {
  test('sends response_format json_object, the routing guard, and the schema in the system message', async () => {
    const { post, sent } = posting(ok({ prompt_tokens: 10, completion_tokens: 5 }));
    await gateway({
      httpPost: post,
      outputMode,
      routing: { order: [], ignore: (model) => (model === 'brain-model' ? ['provider-b'] : []) },
    }).complete({
      ...REQUEST,
      model: 'brain-model',
    });

    const request = sent[0] as {
      body: Record<string, unknown> & { messages: readonly { role: string; content: string }[] };
    };
    expect(request.body['response_format']).toEqual({ type: 'json_object' });
    expect(request.body['tools']).toBeUndefined();
    // The routing guard, plus the exclusions the host's routing names for this model.
    expect(request.body['provider']).toEqual({ require_parameters: true, ignore: ['provider-b'] });
    const system = request.body.messages[0]?.content ?? '';
    expect(system.startsWith(REQUEST.system)).toBe(true);
    expect(system).toContain(JSON.stringify(REQUEST.schema));
  });

  test('a schema-less call to the same model sends the system message untouched', async () => {
    const { post, sent } = posting(ok({ prompt_tokens: 10, completion_tokens: 5 }));
    const { schema: _omitted, ...plain } = REQUEST;
    await gateway({ httpPost: post, outputMode }).complete({
      ...plain,
      model: 'brain-model',
    });

    const request = sent[0] as {
      body: Record<string, unknown> & { messages: readonly { role: string; content: string }[] };
    };
    expect(request.body.messages[0]).toEqual({ role: 'system', content: REQUEST.system });
    expect(request.body['response_format']).toBeUndefined();
  });
});

describe("'tool_choice' mode: the request", () => {
  test('sends a forced single function tool, no response_format', async () => {
    const { post, sent } = posting(ok({ prompt_tokens: 10, completion_tokens: 5 }));
    await gateway({ httpPost: post, outputMode, routing: ROUTED }).complete({
      ...REQUEST,
      model: 'planner-model',
    });

    const request = sent[0] as { body: Record<string, unknown> };
    expect(request.body['response_format']).toBeUndefined();
    // The schema travels VERBATIM as the tool's parameters; the description's
    // wording is a measured prompt, not a contract, so it is not pinned here.
    expect(request.body['tools']).toMatchObject([
      { type: 'function', function: { name: 'outcrawl_reply', parameters: REQUEST.schema } },
    ]);
    expect((request.body['tools'] as readonly unknown[]).length).toBe(1);
    // FORCED, not 'auto' — `schemaFields`'s doc comment measured why 'auto'
    // is not offered as a fallback here.
    expect(request.body['tool_choice']).toEqual({ type: 'function', function: { name: 'outcrawl_reply' } });
    // The same provider-routing guard as strict mode — MEASURED to combine
    // cleanly with `tools`/`tool_choice` live, 2026-09-24.
    expect(request.body['provider']).toEqual({ require_parameters: true });
  });

  test('the system message is unchanged: the tool carries the schema, not the prompt', async () => {
    const { post, sent } = posting(ok({ prompt_tokens: 10, completion_tokens: 5 }));
    await gateway({ httpPost: post, outputMode }).complete({
      ...REQUEST,
      model: 'planner-model',
    });

    const request = sent[0] as { body: { messages: readonly { role: string; content: string }[] } };
    expect(request.body.messages[0]).toEqual({ role: 'system', content: REQUEST.system });
  });
});

describe("'tool_choice' mode: the reply", () => {
  /** Shaped exactly like the gateway's tool-call response, measured 2026-09-24. */
  function toolCallOk(args: string): HttpResponse {
    return {
      status: 200,
      body: {
        id: 'gen-tool-1',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            native_finish_reason: 'tool_use',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'outcrawl_reply', arguments: args } }],
            },
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 8, cost: '0.0000044' },
      },
    };
  }

  test('extracts the SAME JSON document a strict-mode reply would carry in `content`', async () => {
    const action = { actions: [{ type: 'click', ref: '0-42' }] };
    const { post } = posting(toolCallOk(JSON.stringify(action)));

    const response = await gateway({ httpPost: post, outputMode }).complete({
      ...REQUEST,
      model: 'planner-model',
    });

    expect(JSON.parse(response.text)).toEqual(action);
  });

  // `tool_calls` used to be an impossible `finish_reason` for this client —
  // the module comment said so. MUTATION THIS CATCHES: `tool_calls` being
  // added back to `UNUSABLE_FINISH_REASONS`, which would make every
  // 'tool_choice'-mode reply throw `ModelUnusableError` on its own success
  // case.
  test('finish_reason "tool_calls" does not throw ModelUnusableError', async () => {
    const { post } = posting(toolCallOk('{"actions":[]}'));
    await expect(
      gateway({ httpPost: post, outputMode }).complete({
        ...REQUEST,
        model: 'planner-model',
      }),
    ).resolves.toBeDefined();
  });

  // The model declined the forced call — not expected against a provider
  // that honours `tool_choice`, but the transport must degrade to an empty,
  // invalid document rather than throw, so `client.ts`'s EXISTING correction
  // path (`JSON.parse('')` fails -> `ModelSchemaError` -> retry) gets to run
  // exactly as it does for a malformed strict-mode reply. Nothing about that
  // path is mode-aware, and this is the fact that lets it stay that way.
  test('a reply with no tool_calls becomes empty text, not a throw', async () => {
    const { post } = posting({
      status: 200,
      body: {
        id: 'gen-tool-2',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: null } }],
        usage: { prompt_tokens: 20, completion_tokens: 0, cost: '0.000004' },
      },
    });

    const response = await gateway({ httpPost: post, outputMode }).complete({
      ...REQUEST,
      model: 'planner-model',
    });

    expect(response.text).toBe('');
  });
});

/**
 * Every model this table does not name must be completely unaffected — the
 * whole point of choosing the wire shape from the model rather than from a
 * caller-supplied flag. MUTATION THIS CATCHES: `schemaFields`'s `mode ===
 * 'strict'` branch drifting from the body `'the request'`'s test above
 * already pins for the untouched code path.
 */
describe('strict mode is unaffected for every model not in the table', () => {
  test('a model the host names no mode for still sends response_format json_schema strict, no tools', async () => {
    const { post, sent } = posting(ok({ prompt_tokens: 10, completion_tokens: 5 }));
    await gateway({ httpPost: post, outputMode, routing: ROUTED }).complete({
      ...REQUEST,
      model: 'hands-model',
    });

    const request = sent[0] as { body: Record<string, unknown> };
    expect(request.body['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'outcrawl_reply', strict: true, schema: REQUEST.schema },
    });
    expect(request.body['tools']).toBeUndefined();
    expect(request.body['provider']).toEqual({ require_parameters: true });
  });
});

/**
 * W44: a billed call is charged from the USD the gateway states for it
 * (`usage.cost`), read exactly. A call that states none is still served: its
 * cost comes from the gateway's generation record, else from the list price.
 */
describe("billing: the provider's own per-call cost", () => {
  const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };
  const content = { kind: 'markdown', markdown: '# Kettle' } as const;

  /**
   * The raw body a gateway could send, as TEXT: `"cost":2e-7` is a valid JSON
   * number in exponent form. Parsed into a binary64 it is `2e-7`, whose
   * `String()` is `'2e-7'` — not a decimal the ledger, `modelCredits` or a
   * usage row accepts, and for a longer figure not even the same number.
   *
   * MUTATION THIS CATCHES: the cost read from the parsed float rather than the
   * number's source text — the reviver in `systemHttpPost` returning `value`,
   * or `readCost` doing `String(number)` in place of `decimalFromJsonNumber`.
   *
   * Served over a real loopback socket so the real transport parses the real
   * text: the source-text reading lives in `systemHttpPost`, and a fake
   * `HttpPost` that returned an already-parsed body would skip exactly it.
   */
  test('an exponent-form usage.cost is billed exactly, through the provider, the client and the ledger', async () => {
    const raw =
      '{"id":"gen-cost-exp","object":"chat.completion","model":"hands-model",' +
      '"choices":[{"index":0,"finish_reason":"stop","native_finish_reason":"STOP",' +
      '"message":{"role":"assistant","content":"{\\"title\\":\\"Kettle\\"}","refusal":null}}],' +
      '"usage":{"prompt_tokens":12,"completion_tokens":5,"cost":2e-7}}';
    // The fixture is what it claims to be: the exponent form, on the wire.
    expect(raw).toContain('"cost":2e-7');

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(raw, { headers: { 'content-type': 'application/json' } }),
    });
    try {
      const provider = gateway({
        httpPost: systemHttpPost,
        url: `http://127.0.0.1:${String(server.port)}/v1/chat/completions`,
      });

      const response = await provider.complete(REQUEST);
      expect(response.costUsd).toBe('0.0000002');

      const ledger = new CostLedger();
      const client = new ModelClient({
        provider,
        model: 'hands-model',
        session: { sessionId: 'sess-cost', accountId: 'acct-cost' },
        ledger,
      });
      const result = await client.extract({ instruction: null, schema, content });

      expect(result.costUsd).toBe('0.0000002');
      expect(ledger.entries().map((entry) => [entry.outcome, entry.costUsd])).toEqual([['ok', '0.0000002']]);
      expect(ledger.totalsFor('sess-cost').costUsd).toBe('0.0000002');
      expect(ledger.totals().costUsd).toBe('0.0000002');
    } finally {
      await server.stop(true);
    }
  });

  /** A 200 that answers the call and states no `usage.cost`. */
  const uncosted: HttpResponse = {
    status: 200,
    body: {
      id: 'gen-no-cost',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          native_finish_reason: 'STOP',
          message: { role: 'assistant', content: '{"title":"Kettle"}', refusal: null },
        },
      ],
      usage: { prompt_tokens: 900, completion_tokens: 20 },
    },
  };

  /** Waits recorded, never slept. */
  const instantClock = (): { clock: Clock; waits: number[] } => {
    const waits: number[] = [];
    return {
      waits,
      clock: {
        now: () => 0,
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      },
    };
  };

  /** The list prices a no-cost completion is estimated at. */
  const RATES: RateCard = {
    'hands-model': {
      input: '0.30',
      output: '2.50',
      cacheRead: '0.03',
      cacheWrite: '0.0833333333333333',
      inputModalities: ['text', 'image'],
    },
  };

  /** 900 input at $0.30/MTok + 20 output at $2.50/MTok. */
  const ESTIMATE = costOf(
    { inputTokens: 900, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    ratesIn(RATES, 'hands-model'),
  ).total;

  /**
   * The generation record answers where the response did not. It is 404 for a
   * moment after the call, so the first miss is retried; the second answer is
   * served over a real loopback socket as the raw JSON number, so the real
   * transport's source-text reading of `total_cost` is what is exercised.
   *
   * MUTATION THIS CATCHES: the lookup dropped (the call billed at list price
   * or failed), no retry after the first 404, or `total_cost` read from the
   * parsed float (`exactNumberKeys` not naming it).
   */
  test('no usage.cost: the generation record prices the call exactly, and the call succeeds', async () => {
    let lookups = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        lookups += 1;
        return lookups === 1
          ? new Response('{"error":{"message":"Generation not found","code":404}}', { status: 404 })
          : new Response('{"data":{"id":"gen-no-cost","total_cost":0.00012}}', {
              headers: { 'content-type': 'application/json' },
            });
      },
    });
    try {
      const asked: { url: string; authorization: string | undefined }[] = [];
      const httpGet: HttpGet = (request) => {
        asked.push({ url: request.url, authorization: request.headers['authorization'] });
        return systemHttpGet({
          ...request,
          url: request.url.replace(GENERATION_URL, `http://127.0.0.1:${String(server.port)}/generation`),
        });
      };
      const { clock } = instantClock();
      const events: CostFallbackEvent[] = [];
      const ledger = new CostLedger();
      const client = new ModelClient({
        provider: gateway({
          httpPost: posting(uncosted).post,
          httpGet,
          clock,
          rates: RATES,
          onCostFallback: (event) => events.push(event),
        }),
        model: 'hands-model',
        session: { sessionId: 'sess-no-cost', accountId: 'acct-cost' },
        ledger,
      });

      const result = await client.extract({ instruction: null, schema, content });

      expect(result.data).toEqual({ title: 'Kettle' });
      expect(result.costUsd).toBe('0.00012');
      expect(asked).toEqual([
        { url: `${GENERATION_URL}?id=gen-no-cost`, authorization: 'Bearer k' },
        { url: `${GENERATION_URL}?id=gen-no-cost`, authorization: 'Bearer k' },
      ]);
      expect(ledger.entries().map((entry) => [entry.outcome, entry.costUsd, entry.costSource])).toEqual([
        ['ok', '0.00012', 'generation'],
      ]);
      // The provider's own figure, so none of it is an estimate.
      expect(ledger.totalsFor('sess-no-cost').estimatedUsd).toBe('0');
      expect(events.map((event) => [event.source, event.costUsd])).toEqual([['generation', '0.00012']]);
    } finally {
      await server.stop(true);
    }
  });

  /**
   * The record never answers: the call is billed at the list price, marked an
   * estimate on the ledger, and still succeeds.
   *
   * MUTATION THIS CATCHES: an unbounded or absent retry, a call failed (or
   * billed at '0') when the lookup fails, or an estimate recorded as if it
   * were the provider's figure.
   */
  test('no usage.cost and no generation record: billed at the list-price estimate, and the call succeeds', async () => {
    const gets: string[] = [];
    const httpGet: HttpGet = (request) => {
      gets.push(request.url);
      return Promise.resolve({ status: 404, body: { error: { message: 'Generation not found', code: 404 } } });
    };
    const { clock, waits } = instantClock();
    const events: CostFallbackEvent[] = [];
    const ledger = new CostLedger();
    const client = new ModelClient({
      provider: gateway({
        httpPost: posting(uncosted).post,
        httpGet,
        clock,
        rates: RATES,
        onCostFallback: (event) => events.push(event),
      }),
      model: 'hands-model',
      session: { sessionId: 'sess-estimate', accountId: 'acct-cost' },
      ledger,
    });

    const result = await client.extract({ instruction: null, schema, content });

    const estimate = ESTIMATE;
    expect(compareDecimal(estimate, '0.00032')).toBe(0);

    expect(result.data).toEqual({ title: 'Kettle' });
    expect(result.costUsd).toBe(estimate);
    // Three tries, 1.5 s of waiting between them, then no more.
    expect(gets).toHaveLength(3);
    expect(waits).toEqual([500, 1_000]);
    expect(ledger.entries().map((entry) => [entry.outcome, entry.costUsd, entry.costSource])).toEqual([
      ['ok', estimate, 'estimate'],
    ]);
    expect(ledger.totalsFor('sess-estimate').costUsd).toBe(estimate);
    expect(ledger.totalsFor('sess-estimate').estimatedUsd).toBe(estimate);
    expect(events.map((event) => [event.source, event.costUsd, event.lookups])).toEqual([['estimate', estimate, 3]]);
  });

  /**
   * A provider with no generation record prices a no-cost completion from the
   * card at once, and a model the card does not list bills '0' with the reason
   * rather than failing the call.
   * MUTATIONS THIS CATCHES: a lookup attempted against no URL (or a wait spent
   * on one), and an unlisted model throwing instead of billing '0' with why.
   */
  test('no generation record to ask: the list price straight away, or 0 with the reason', async () => {
    const gets: string[] = [];
    const httpGet: HttpGet = (request) => {
      gets.push(request.url);
      return Promise.resolve({ status: 404, body: {} });
    };
    const { clock, waits } = instantClock();
    const events: CostFallbackEvent[] = [];
    const provider = new ChatCompletionsProvider({
      name: 'gateway',
      url: COMPLETIONS_URL,
      apiKey: 'k',
      httpPost: posting(uncosted).post,
      httpGet,
      clock,
      rates: RATES,
      onCostFallback: (event) => events.push(event),
    });

    const listed = await provider.complete(REQUEST);
    const unlisted = await provider.complete({ ...REQUEST, model: 'unlisted-model' });

    expect(gets).toEqual([]);
    expect(waits).toEqual([]);
    expect([listed.costUsd, listed.costSource]).toEqual([ESTIMATE, 'estimate']);
    expect([unlisted.costUsd, unlisted.costSource]).toEqual(['0', 'estimate']);
    expect(events.map((event) => [event.model, event.lookups])).toEqual([
      ['hands-model', 0],
      ['unlisted-model', 0],
    ]);
    expect(events[1]?.reason).toMatch(/no list price/);
  });
});
