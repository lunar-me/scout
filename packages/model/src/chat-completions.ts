/**
 * The chat-completions protocol, as verified against a live gateway on
 * 2026-09-03 rather than from memory of the protocol it resembles. One
 * provider class for any endpoint that speaks it; what is specific to one
 * gateway (its URL, its routing block, which wire shape each model needs) is
 * configuration the host passes in.
 *
 * ── The one semantic that must not be got wrong: prompt_tokens overlaps ──────
 *
 * `TokenUsage.inputTokens` is documented in `./provider` as "Uncached input
 * tokens. Excludes both cache figures", and that contract is protocol-specific.
 * This protocol reports `prompt_tokens` as the TOTAL and
 * `prompt_tokens_details.cached_tokens` as a subset of it.
 *
 * Measured, so this is not an appeal to the spec. The extract model, 63 prompt
 * tokens, 158 completion tokens, returned:
 *
 * ```json
 * "cost_details": { "upstream_inference_prompt_cost": 0.0000189,
 *                   "upstream_inference_completions_cost": 0.000395 }
 * ```
 *
 * and 63 x $0.0000003 = $0.0000189 exactly, 158 x $0.0000025 = $0.000395
 * exactly. The full `prompt_tokens` is what was priced at the uncached rate,
 * with no separate cached line item, which is only consistent with
 * `cached_tokens` being contained in it.
 *
 * So {@link readUsage} SUBTRACTS. Passing `prompt_tokens` through as
 * `inputTokens` would price every cached input token twice — once at the full
 * input rate here and again at the cache-read rate in `costOf` — and on the
 * agent loop, where each step re-sends a prompt whose system preamble and task
 * are identical, cached input is the majority of the spend. The error would be
 * an overcharge that grows with exactly the thing prompt caching exists to make
 * cheap, and it would look plausible in every log line.
 *
 * A negative result is clamped to zero rather than trusted: if a provider ever
 * reports `cached_tokens > prompt_tokens` the arithmetic is wrong somewhere and
 * a negative token count would flow into `tokensAsMillions`, which throws on
 * it. Clamping keeps the run alive and the cost understated by a rounding
 * error; the alternative is a crash mid-step on a frozen page.
 *
 * ── Errors and truncation, both measured ─────────────────────────────────────
 *
 * The error envelope is `{"error":{"message":"...","code":400}}` with `code` as
 * a NUMBER, not a string discriminator. A bad model id is a 400 with "... is
 * not a valid model ID"; a bad credential is a 401 with "User not found.". So
 * {@link providerError} reads the numeric code and the message and does not
 * look for a `type` field that never appears.
 *
 * Truncation arrives as `finish_reason: "length"` with
 * `native_finish_reason: "MAX_TOKENS"` and a 200, with usage reported. That is
 * a `max_tokens` stop and is treated as one: {@link ModelUnusableError},
 * carrying the usage, because the tokens were billed and any JSON in the reply
 * is truncated. A client that returned that text would hand `JSON.parse` a
 * fragment and report the parse failure as the model's fault.
 *
 * ── The request id is in the body, not a header ──────────────────────────────
 *
 * `systemHttpPost` reads the `request-id` header. A gateway may send no such
 * header — measured: the response headers were `x-generation-id` plus its CDN's,
 * and `request-id` appeared only in `access-control-expose-headers` without
 * ever being set. The id a support ticket is answered by is the body's `id`
 * (`gen-…`), so it is read from there. Leaving it absent would have made
 * `CostEntry.requestId` null for every call, which is the field that exists so
 * a disputed charge can be traced back to the provider's own record of it.
 */

import { decimalFromJsonNumber, isRecord, systemClock, type Clock } from '@outcrawl/scout-core';

import {
  HttpTransportError,
  asString,
  systemHttpGet,
  systemHttpPost,
  type HttpGet,
  type HttpPost,
} from './http';
import {
  ModelCancelledError,
  ModelConfigError,
  ModelProviderError,
  ModelTimeoutError,
  ModelUnusableError,
  ZERO_TOKENS,
  type CostSource,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ReasoningConfig,
  type TokenUsage,
} from './provider';
import { costOf, ratesIn, type RateCard } from './rates';

/**
 * The waits before each generation lookup: three tries, 1.5 s of waiting in
 * all. The record can answer 404 for a moment right after the call that
 * created it, so the first miss is not the last word; three misses are, and
 * the call is priced from the list instead. Bounded because the customer's
 * reply is already here and is waiting on accounting.
 */
const GENERATION_LOOKUP_WAITS_MS: readonly number[] = [0, 500, 1_000];

/** One lookup's own deadline. Short, for the reason above. */
const GENERATION_LOOKUP_TIMEOUT_MS = 1_000;

/** The generation record's key for the USD charged. */
const TOTAL_COST_KEY = 'total_cost';

/**
 * A completion that stated no cost, and how its cost was found instead. For
 * the host's logger: a `generation` is the provider's own figure one request
 * later, an `estimate` is list price, billed because failing the call would be
 * worse, and something an operator must see.
 */
export interface CostFallbackEvent {
  readonly model: string;
  /** The generation id (`gen-…`), when the body carried one. */
  readonly requestId?: string;
  readonly source: Exclude<CostSource, 'provider'>;
  /** Exact decimal USD the call was billed at. */
  readonly costUsd: string;
  readonly usage: TokenUsage;
  /** Generation lookups made. `0` when there was no id to look up. */
  readonly lookups: number;
  /** Why the provider's figure was not found. Present on an `estimate`. */
  readonly reason?: string;
}

/**
 * The schema wrapper's `name`. Required by the protocol and not otherwise
 * meaningful: one constant rather than a per-call string, so a cache key or a
 * provider-side compile cache is not fragmented by a label nobody reads.
 */
const SCHEMA_NAME = 'outcrawl_reply';

/**
 * `finish_reason` values that mean the answer exists and cannot be used.
 *
 * `length` is the measured truncation case. `content_filter` is the protocol's
 * refusal, and some upstreams also surface a non-null `message.refusal`, which
 * {@link ChatCompletionsProvider.complete} checks separately.
 *
 * `stop` is the success case for 'strict' and 'json_object' mode.
 * `tool_calls` is the success case for 'tool_choice' mode (see
 * {@link StructuredOutputMode}) and is deliberately absent from this map — it
 * used to be an impossible value back when this client sent no tools at all;
 * now it is simply not a failure.
 */
const UNUSABLE_FINISH_REASONS: Readonly<Record<string, string>> = {
  length: 'the reply was cut off at max_tokens, so any JSON in it is truncated',
  content_filter: 'the upstream provider filtered the reply on policy grounds',
  error: 'the upstream provider reported an error mid-generation',
};

/**
 * The first complete, parseable `{…}` in `text`, or `undefined`: a scan that
 * balances braces outside strings, so a reply cut mid-way through a second
 * object or a trailing loop of junk still yields the whole first one.
 */
export function firstJsonObject(text: string): string | undefined {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (char === '\\') index += 1;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        const candidate = text.slice(start, index + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

/**
 * Which wire shape gets a schema-constrained reply out of a model. Chosen per
 * model by the host ({@link ChatCompletionsProviderOptions.outputMode}), by
 * live measurement, and only where 'strict' was measured to FAIL.
 *
 *   'strict'       `response_format: json_schema, strict: true`. The default,
 *                  and the right one for every model the host does not name:
 *                  same body shape, same bytes as before this type existed.
 *   'tool_choice'  a single FORCED function tool, `parameters` = the schema
 *                  VERBATIM, no `strict` flag on the function. Non-strict
 *                  tool parameters are never held to the strict-schema rules,
 *                  so a schema that breaks them travels unmodified.
 *   'json_object'  `response_format: {type: 'json_object'}` (valid JSON, no
 *                  shape guarantee) plus the schema spelled out in the system
 *                  prompt (see {@link systemContent}); `ModelClient`'s own
 *                  validation and corrections hold the shape.
 *
 * The tool's description is part of the measurement: with
 * `'Record the reply.'`, a frontier model as actor nested a top-level property
 * inside an array item on 8/16 calls; the sentence {@link schemaFields} sends
 * scored 30/32 (2026-09-24, commit 2eb0352).
 */
export type StructuredOutputMode = 'strict' | 'tool_choice' | 'json_object';

/**
 * A gateway's upstream routing block (`provider` in the request body), for an
 * endpoint that routes one model across several upstreams. Absent, no routing
 * field is sent at all, which is what a plain endpoint expects.
 */
export interface ProviderRouting {
  /**
   * Upstreams a schema call tries first, in order, with fallbacks on. Empty
   * leaves the choice to the gateway. A per-request
   * `ModelRequest.providerOrder` overrides it.
   */
  readonly order: readonly string[];
  /**
   * Upstreams a model is never served from, on every call to it, with or
   * without a schema. Empty for a model with no exclusions.
   */
  readonly ignore: (model: string) => readonly string[];
}

export interface ChatCompletionsProviderOptions {
  /**
   * The name every ledger row and `model.call` line carries for this provider,
   * and the prefix of a numeric error code (`<name>_400`).
   */
  readonly name: string;
  /** The chat-completions URL. */
  readonly url: string;
  /**
   * The key. A constructor argument and never read from the environment here:
   * the host is the one place in the process that knows a variable exists.
   * Never logged, never included in an error message, never in a URL.
   */
  readonly apiKey: string;
  /**
   * The gateway's per-generation record (`<url>?id=<gen id>`, answering
   * `data.total_cost`), asked when a completion stated no `usage.cost`.
   * Absent, such a call is priced from {@link rates} straight away.
   */
  readonly generationUrl?: string;
  /**
   * Headers sent after `authorization` on every completion, in order (traffic
   * attribution, for a gateway that keeps it). Not a credential.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** The wire shape per model; `'strict'` for a model it does not name. See {@link StructuredOutputMode}. */
  readonly outputMode?: (model: string) => StructuredOutputMode;
  /** The gateway's routing block. See {@link ProviderRouting}. */
  readonly routing?: ProviderRouting;
  /**
   * The list prices a completion that stated no cost is billed at, as an
   * estimate. Absent, or a model not on it, bills `'0'` with the reason.
   */
  readonly rates?: RateCard;
  /** Injected for tests. Defaults to the real transport. */
  readonly httpPost?: HttpPost;
  /** The generation lookup's transport. Injected for tests; defaults to the real one. */
  readonly httpGet?: HttpGet;
  /** Waits between generation lookups. Injected for tests; defaults to real time. */
  readonly clock?: Clock;
  /**
   * Called once per completion that stated no `usage.cost`, after its cost was
   * found another way. The host wires it to its logger; absent, the ledger's
   * `costSource` is the only trace.
   */
  readonly onCostFallback?: (event: CostFallbackEvent) => void;
}

export class ChatCompletionsProvider implements ModelProvider {
  readonly name: string;
  readonly #apiKey: string;
  readonly #httpPost: HttpPost;
  readonly #httpGet: HttpGet;
  readonly #clock: Clock;
  readonly #onCostFallback: (event: CostFallbackEvent) => void;
  readonly #url: string;
  readonly #generationUrl: string | undefined;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #outputMode: (model: string) => StructuredOutputMode;
  readonly #routing: ProviderRouting | undefined;
  readonly #rates: RateCard;

  constructor(options: ChatCompletionsProviderOptions) {
    this.name = options.name;
    this.#apiKey = options.apiKey;
    this.#httpPost = options.httpPost ?? systemHttpPost;
    this.#httpGet = options.httpGet ?? systemHttpGet;
    this.#clock = options.clock ?? systemClock;
    this.#onCostFallback = options.onCostFallback ?? (() => undefined);
    this.#url = options.url;
    this.#generationUrl = options.generationUrl;
    this.#headers = options.headers ?? {};
    this.#outputMode = options.outputMode ?? (() => 'strict');
    this.#routing = options.routing;
    this.#rates = options.rates ?? {};
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const mode: StructuredOutputMode = request.schema === undefined ? 'strict' : this.#outputMode(request.model);
    const body = {
      model: request.model,
      // ABSENT MEANS ABSENT. A gateway defaults an omitted `max_tokens` to
      // what is left of the model's context, which is the provider's own
      // ceiling and the only one that knows the model. See
      // `ModelRequest.maxTokens`: a ceiling of the caller's truncated 36 of
      // 222 thrown captcha looks.
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
      messages: messagesFor(request, mode),
      ...(request.schema === undefined
        ? withoutProviders(this.#routing, request.model)
        : request.providerOrder === undefined
          ? schemaFields(request.schema, mode, this.#routing, this.#routing?.order ?? [], request.model)
          : schemaFields(request.schema, mode, this.#routing, request.providerOrder, request.model, true)),
      ...(request.reasoning === undefined ? {} : { reasoning: reasoningBody(request.reasoning) }),
      // Only when the caller set it. An explicit `undefined` and an absent key
      // are not the same request body to every upstream, and providers key
      // prompt caches on the serialised prefix — the same argument
      // `userContent` makes for the bare string.
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    };

    let response;
    try {
      response = await this.#httpPost({
        url: this.#url,
        body,
        headers: { authorization: `Bearer ${this.#apiKey}`, ...this.#headers },
        timeoutMs: request.timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        // `usage.cost` is the call's price in USD and is billed from; see
        // `readCost`. Its digits must survive the parse.
        exactNumberKeys: [COST_KEY],
      });
    } catch (cause) {
      if (cause instanceof HttpTransportError && cause.timedOut) {
        throw new ModelTimeoutError(request.timeoutMs, cause);
      }
      if (cause instanceof HttpTransportError && cause.cancelled) {
        throw new ModelCancelledError(cause);
      }
      // The provider never answered, so nothing was billed and a retry is
      // plausible. Status 0 says "below HTTP" rather than pretending to one.
      throw new ModelProviderError({
        status: 0,
        providerCode: 'transport_error',
        message: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
      });
    }

    if (response.status < 200 || response.status >= 300) {
      throw providerError(this.name, response.status, response.body);
    }

    const payload = isRecord(response.body) ? response.body : undefined;
    if (payload === undefined) {
      throw new ModelProviderError({
        status: response.status,
        providerCode: 'unparseable_response',
        message: 'a 2xx response whose body was not a JSON object',
        retryable: true,
      });
    }

    const usage = readUsage(payload['usage']);
    // The generation id, from the body. See the module comment: there is no
    // `request-id` header to read.
    const requestId = asString(payload['id']);
    const statedUsd = readCost(payload['usage']);

    // A 200 whose `error` is populated. A gateway documents this for upstream
    // failures that arrive after the response has started, and it is not the
    // same thing as a non-2xx: tokens may already have been billed.
    const inlineError = isRecord(payload['error']) ? payload['error'] : undefined;
    if (inlineError !== undefined) {
      const upstream = inlineError['code'];
      throw new ModelProviderError({
        status: response.status,
        providerCode: errorCode(this.name, inlineError, response.status),
        message: asString(inlineError['message']) ?? 'no message',
        retryable: true,
        // The fault the body names, so the chain can demote on an upstream 502
        // that arrived as a 200. See `ModelProviderError.upstreamStatus`.
        ...(typeof upstream === 'number' && Number.isInteger(upstream) && upstream >= 100 && upstream <= 599
          ? { upstreamStatus: upstream }
          : {}),
        ...(requestId === undefined ? {} : { requestId }),
        // Whatever the body says it charged, so the run pays for it; an inline
        // error that states no cost was not billed as far as anyone can tell.
        ...(statedUsd === undefined ? {} : { costUsd: statedUsd }),
      });
    }

    const choices: unknown = payload['choices'];
    const choice = Array.isArray(choices) && isRecord(choices[0]) ? choices[0] : undefined;
    if (choice === undefined) {
      throw new ModelProviderError({
        status: response.status,
        providerCode: 'no_choices',
        message: 'a 2xx response carrying no choices',
        retryable: true,
        ...(requestId === undefined ? {} : { requestId }),
        ...(statedUsd === undefined ? {} : { costUsd: statedUsd }),
      });
    }

    // From here on the call produced a generation, which is billed whether or
    // not the reply is usable. A response that did not state its cost is
    // priced another way rather than failed: the answer exists and was paid
    // for, and the customer's call is not the place to settle accounting.
    const cost =
      statedUsd === undefined
        ? await this.#resolveCost(request.model, usage, requestId)
        : { usd: statedUsd, source: 'provider' as const };

    const message = isRecord(choice['message']) ? choice['message'] : undefined;

    // Checked before `finish_reason`, because a refusal is more specific: it
    // names why, and the finish reason for a refused generation is `stop`.
    const refusal = message === undefined ? undefined : asString(message['refusal']);
    if (refusal !== undefined) {
      throw new ModelUnusableError('refusal', refusal, usage, cost.usd, cost.source, requestId);
    }

    // `native_finish_reason` is the upstream's own word — `MAX_TOKENS`, `STOP`,
    // `SAFETY` — and it goes into the message because "length" alone does not
    // tell an operator which upstream cut the reply off.
    const finishReason = asString(choice['finish_reason']) ?? 'unknown';
    const native = asString(choice['native_finish_reason']);
    const unusable = UNUSABLE_FINISH_REASONS[finishReason];
    if (finishReason === 'length' && request.salvageTruncated === true) {
      const salvaged = firstJsonObject(replyText(mode, message));
      if (salvaged !== undefined) {
        return {
          text: salvaged,
          usage,
          costUsd: cost.usd,
          costSource: cost.source,
          stopReason: 'length-salvaged',
          ...(requestId === undefined ? {} : { requestId }),
        };
      }
    }
    if (unusable !== undefined) {
      throw new ModelUnusableError(
        finishReason,
        native === undefined ? unusable : `${unusable} (upstream reported ${native})`,
        usage,
        cost.usd,
        cost.source,
        requestId,
      );
    }

    return {
      text: replyText(mode, message),
      usage,
      costUsd: cost.usd,
      costSource: cost.source,
      stopReason: finishReason,
      ...(requestId === undefined ? {} : { requestId }),
    };
  }

  /**
   * The cost of a completion that did not state one: the gateway's generation
   * record, asked up to three times, else the list price, else `'0'`. Never
   * throws — see {@link CostSource}.
   */
  async #resolveCost(
    model: string,
    usage: TokenUsage,
    requestId: string | undefined,
  ): Promise<{ readonly usd: string; readonly source: Exclude<CostSource, 'provider'> }> {
    let reason = this.#generationUrl === undefined ? 'this provider has no generation record to look up' : 'the response carried no generation id to look up';
    let lookups = 0;
    if (requestId !== undefined && this.#generationUrl !== undefined) {
      for (const waitMs of GENERATION_LOOKUP_WAITS_MS) {
        if (waitMs > 0) {
          await this.#clock.sleep(waitMs);
        }
        lookups += 1;
        const found = await this.#lookUpGeneration(this.#generationUrl, requestId);
        if (found.usd !== undefined) {
          this.#onCostFallback({ model, requestId, source: 'generation', costUsd: found.usd, usage, lookups });
          return { usd: found.usd, source: 'generation' };
        }
        reason = found.reason;
      }
      reason = `the generation lookup failed ${String(lookups)} times, last: ${reason}`;
    }
    const estimate = listPriceEstimate(this.#rates, model, usage);
    this.#onCostFallback({
      model,
      ...(requestId === undefined ? {} : { requestId }),
      source: 'estimate',
      costUsd: estimate.usd,
      usage,
      lookups,
      reason: estimate.unpriced === undefined ? reason : `${reason}; and no list price either: ${estimate.unpriced}`,
    });
    return { usd: estimate.usd, source: 'estimate' };
  }

  /** One generation lookup: the USD it states, or why there is none. */
  async #lookUpGeneration(
    generationUrl: string,
    requestId: string,
  ): Promise<{ readonly usd: string; readonly reason?: never } | { readonly usd?: never; readonly reason: string }> {
    let response;
    try {
      response = await this.#httpGet({
        url: `${generationUrl}?id=${encodeURIComponent(requestId)}`,
        headers: { authorization: `Bearer ${this.#apiKey}` },
        timeoutMs: GENERATION_LOOKUP_TIMEOUT_MS,
        // Money: its digits must survive the parse, as `usage.cost`'s do.
        exactNumberKeys: [TOTAL_COST_KEY],
      });
    } catch (cause) {
      return { reason: cause instanceof Error ? cause.message : String(cause) };
    }
    if (response.status < 200 || response.status >= 300) {
      return { reason: `HTTP ${String(response.status)}` };
    }
    const usd = isRecord(response.body) ? exactUsd(response.body['data'], TOTAL_COST_KEY) : undefined;
    return usd === undefined ? { reason: 'the generation record stated no data.total_cost' } : { usd };
  }
}

/**
 * The list price of a call, from the transcribed rate card, for a call the
 * provider never priced. `'0'`, with the reason, when the card cannot price it
 * — an unlisted model, or a cache line the card has no price for.
 */
function listPriceEstimate(
  rates: RateCard,
  model: string,
  usage: TokenUsage,
): { readonly usd: string; readonly unpriced?: string } {
  try {
    return { usd: costOf(usage, ratesIn(rates, model)).total };
  } catch (error) {
    if (error instanceof ModelConfigError) {
      return { usd: '0', unpriced: error.message };
    }
    throw error;
  }
}

/**
 * `error.code` is a number here, not a symbolic `error.type` string, so it is
 * rendered as `<provider name>_<code>` rather than passed through as if it were
 * a symbolic name a reader could look up.
 */
function errorCode(name: string, error: Record<string, unknown>, status: number): string {
  const code: unknown = error['code'];
  if (typeof code === 'number' && Number.isInteger(code)) {
    return `${name}_${String(code)}`;
  }
  return asString(code) ?? `http_${String(status)}`;
}

/**
 * `ReasoningConfig` on the wire. Only the fields the caller set: an explicit
 * `undefined` in a JSON body is not the same as an absent key to every
 * upstream, and this is the object that decides whether a call costs 2,284
 * reasoning tokens or none.
 *
 * `maxTokens` -> `max_tokens`, which is the vendor's spelling and NOT the
 * request's own `max_tokens`: it is a second, independent ceiling, measured to
 * be honoured as one. See {@link ReasoningConfig}.
 *
 * There is no `exclude` key because {@link ReasoningConfig} does not offer one.
 * Measured: `exclude: true` billed 1,096 reasoning tokens on a call that
 * reported none. It hides the spend, it does not remove it.
 */
function reasoningBody(reasoning: ReasoningConfig): Record<string, unknown> {
  return {
    ...(reasoning.effort === undefined ? {} : { effort: reasoning.effort }),
    ...(reasoning.maxTokens === undefined ? {} : { max_tokens: reasoning.maxTokens }),
    ...(reasoning.enabled === undefined ? {} : { enabled: reasoning.enabled }),
  };
}

/**
 * The user message: a bare string when there is no image, a parts array when
 * there is.
 *
 * THE BARE STRING IS NOT AN OPTIMISATION AND MUST STAY. Every text-only caller
 * in this repo — the agent step and the extraction — goes through here, and a
 * one-element `[{type:'text'}]` array is a different request body for the same
 * request. Providers key prompt caches on the serialised prefix, so switching
 * every existing call to the array form would miss the cache on the first call
 * after deploy for every session at once, for a change that buys nothing.
 *
 * Text first, then images, per the vendor's own instruction quoted on
 * {@link ModelRequest.images}.
 */
function userContent(request: ModelRequest): unknown {
  if (request.images === undefined || request.images.length === 0) {
    return request.prompt;
  }
  return [
    { type: 'text', text: request.prompt },
    ...request.images.map((image) => ({
      type: 'image_url',
      // A whole data URL, which is the form this API takes: "Images:
      // `data:image/jpeg;base64,{base64_data}`". `ModelImage` stores the payload
      // unprefixed, so the prefix is built exactly once, here.
      image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
    })),
  ];
}

/**
 * One explicit cache breakpoint (`cache_control`). The 5-minute TTL (no `ttl`
 * key): a brain step answers in seconds, so the next read lands well inside it
 * and every read refreshes it, and a 5-minute write is billed at 1.25x input
 * against 2x for `"ttl":"1h"` (the gateway's prompt-caching guide, "Cache TTL
 * Options", read 2026-10-02).
 */
const CACHE_BREAKPOINT = { type: 'ephemeral' } as const;

/**
 * The `messages` array: system, then {@link ModelRequest.turns}, then the
 * current prompt as the final user message.
 *
 * NEITHER `turns` NOR `cache` → EXACTLY THE TWO MESSAGES EVERY CALLER HAS
 * ALWAYS SENT, byte for byte (`test/chat-completions-body.test.ts` pins it):
 * system as a bare string, then {@link userContent}. Turns alone add plain
 * `{role, content}` string messages between them and change nothing else.
 *
 * `cache: true` → EXPLICIT BREAKPOINTS, two against the vendor's four, per
 * "Explicit cache breakpoints" in the gateway's prompt-caching guide
 * (read 2026-10-02: "Place `cache_control` directly on individual content blocks … There is a
 * limit of four explicit breakpoints"). Each carrier becomes a parts array
 * because a breakpoint lives on a content PART, never on a message:
 *
 *   1. the system block, so the stable instructions are a hit from the second
 *      call on — for every thread that shares them;
 *   2. the LAST USER TURN in `turns`. This call writes the entry ending there;
 *      the next call's breakpoint 2 sits one exchange later and reads it back
 *      (the vendor looks up to 20 blocks behind a breakpoint), so each call
 *      pays full rate only for the newest exchange and its own prompt.
 *
 * The FINAL user message is NOT marked. The one thread caller (the brain,
 * `brain.ts`) replays a compact form of each step, never the prompt it sent —
 * the page brief in it is sent once — so an entry written there would never
 * be read and would only pay the cache-write premium (1.25x) on every call.
 * Images on the final message are therefore never in the cached prefix.
 * Assistant turns stay plain strings. Explicit breakpoints rather than the
 * top-level automatic `cache_control` because the guide limits automatic
 * caching to a few upstreams, while per-block breakpoints work across every
 * upstream that supports caching at all.
 *
 * Below the model's minimum cacheable prefix (1,024-4,096 tokens by model, per
 * the same page) the breakpoints are accepted and nothing is cached; usage then
 * reports zero cache reads and writes rather than failing.
 *
 * STICKY ROUTING keeps a cached thread on the upstream that holds its cache:
 * the gateway keys it on the first system and first non-system message, which
 * are fixed for a thread. It is NOT used when the body names `provider.order`
 * (same page, "Provider Sticky Routing"), which {@link schemaFields} does only
 * when the host's {@link ProviderRouting.order} or the request names one.
 */
function messagesFor(request: ModelRequest, mode: StructuredOutputMode): readonly unknown[] {
  const system = systemContent(request, mode);
  const user = finalContent(request);
  const turns = request.turns ?? [];
  checkTurns(turns);
  if (request.cache !== true) {
    return [
      { role: 'system', content: system },
      ...turns.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: user },
    ];
  }
  const lastUser = turns.findLastIndex((turn) => turn.role === 'user');
  return [
    { role: 'system', content: [{ type: 'text', text: system, cache_control: CACHE_BREAKPOINT }] },
    ...turns.map((turn, index) =>
      index === lastUser
        ? { role: turn.role, content: [{ type: 'text', text: turn.content, cache_control: CACHE_BREAKPOINT }] }
        : { role: turn.role, content: turn.content },
    ),
    { role: 'user', content: user },
  ];
}

/**
 * The final user message. Without `tail`, {@link userContent} unchanged. With
 * it: the prompt as its own part — carrying the breakpoint when `cache` is
 * set, so the next call reads it back once it is replayed as a turn — then any
 * images, then the tail, which no breakpoint covers.
 */
function finalContent(request: ModelRequest): unknown {
  if (request.tail === undefined) {
    return userContent(request);
  }
  const prompt =
    request.cache === true
      ? { type: 'text', text: request.prompt, cache_control: CACHE_BREAKPOINT }
      : { type: 'text', text: request.prompt };
  const images = (request.images ?? []).map((image) => ({
    type: 'image_url',
    image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
  }));
  return [prompt, ...images, { type: 'text', text: request.tail }];
}

/**
 * Refuses a thread that is not `user, assistant, user, …, assistant`. The
 * current prompt is the next user message, so a thread ending on `user` would
 * send two user messages in a row, which some upstreams merge and some reject:
 * either way not the conversation the caller recorded.
 */
function checkTurns(turns: NonNullable<ModelRequest['turns']>): void {
  turns.forEach((turn, index) => {
    const expected = index % 2 === 0 ? 'user' : 'assistant';
    if (turn.role !== expected) {
      throw new ModelConfigError(
        `ModelRequest.turns[${String(index)}] is a '${turn.role}' turn where '${expected}' was expected: ` +
          'turns start with user, alternate, and end with assistant, because the prompt is the next user turn.',
      );
    }
  });
  if (turns.length % 2 !== 0) {
    throw new ModelConfigError(
      'ModelRequest.turns ends with a user turn, so the prompt would be a second user message in a row. ' +
        'End the thread with the assistant reply to that turn.',
    );
  }
}

/** A request with no schema sends no routing block, except the exclusions a model always carries. */
function withoutProviders(routing: ProviderRouting | undefined, model: string): Record<string, unknown> {
  const ignore = routing?.ignore(model) ?? [];
  return ignore.length === 0 ? {} : { provider: { ignore } };
}

/**
 * The schema-related wire fields for one mode. {@link ChatCompletionsProvider.complete}
 * does not call this when the caller sent no schema.
 *
 * With a routing block, `provider: {require_parameters: true, ...}` applies to
 * EVERY mode here, not only 'strict': a forced tool call needs an upstream that
 * implements `tools`/`tool_choice` exactly as much as a json_schema call needs
 * one that implements `response_format`. A gateway that serves a model from a
 * POOL picks an upstream per request, and an upstream that does not implement
 * structured outputs takes the request anyway and answers in prose, which
 * arrives here as a well-formed HTTP 200 carrying something the reply parser
 * must reject. `require_parameters` drops any upstream that cannot serve every
 * parameter in the body. It is set ONLY alongside a schema: applied
 * unconditionally it would narrow the pool for plain text calls that do not
 * need narrowing. Why the host's order and exclusions are what they are is
 * recorded with the host's routing configuration.
 */
function schemaFields(
  schema: Readonly<Record<string, unknown>>,
  mode: StructuredOutputMode,
  routing: ProviderRouting | undefined,
  providerOrder: readonly string[],
  model: string,
  /** Set on a per-request order: says outright that fallbacks stay on. */
  allowFallbacks?: true,
): Record<string, unknown> {
  const ignore = routing?.ignore(model) ?? [];
  // No routing block on an endpoint that does not route: a per-request order
  // has nothing to ask.
  const provider =
    routing === undefined
      ? {}
      : {
          provider: {
            require_parameters: true,
            ...(providerOrder.length === 0 ? {} : { order: providerOrder }),
            ...(allowFallbacks === true ? { allow_fallbacks: true } : {}),
            ...(ignore.length === 0 ? {} : { ignore }),
          },
        };
  if (mode === 'tool_choice') {
    return {
      tools: [
        {
          type: 'function',
          function: {
            name: SCHEMA_NAME,
            // Schema-agnostic, and MEASURED: `'Record the reply.'` left a
            // model nesting a top-level property inside an array item on 8/16
            // calls; this sentence scored 30/32. See StructuredOutputMode.
            description:
              'Record the reply, matching the parameters schema exactly — including which object each ' +
              'property belongs to; do not move a property to a different object than the schema places it in.',
            parameters: schema,
          },
        },
      ],
      // FORCED: the one legal value measured working. `'auto'` is a
      // different, weaker request and is not offered here.
      tool_choice: { type: 'function', function: { name: SCHEMA_NAME } },
      ...provider,
    };
  }
  if (mode === 'json_object') {
    return { response_format: { type: 'json_object' }, ...provider };
  }
  return {
    response_format: { type: 'json_schema', json_schema: { name: SCHEMA_NAME, strict: true, schema } },
    ...provider,
  };
}

/**
 * The system message text. Every mode but `'json_object'` sends the caller's
 * text unchanged — `'json_object'` guarantees syntactically valid JSON and
 * nothing about its shape, so the schema has to be spelled out in words
 * instead of enforced.
 *
 * The addendum is schema-agnostic — no field name from any caller's schema
 * appears in it — because it runs for every schema sent to a `'json_object'`
 * slug, the planner's `extract` as well as the actor's reply. The sentence
 * about not moving a property is MEASURED (2026-09-24, commit 2eb0352): a
 * prompt naming only "the schema" left a frontier planner model 1/5
 * first-pass valid, the model nesting the reply's `finding` inside an action.
 */
function systemContent(request: ModelRequest, mode: StructuredOutputMode): string {
  if (mode !== 'json_object' || request.schema === undefined) {
    return request.system;
  }
  return (
    `${request.system}\n\nYour reply MUST be a single JSON object, nothing else (no prose, no code fence), ` +
    'validating against this JSON Schema exactly — including which object each property belongs to; do ' +
    `not move a property to a different object than the schema places it in:\n${JSON.stringify(request.schema)}`
  );
}

/**
 * The error body, read for its code as well as its status.
 *
 * Retry policy is the status, because the numeric `code` observed on both
 * measured failures simply repeats it. 429 and 5xx are the provider asking us
 * to wait; every other 4xx is a request that will fail identically next time,
 * including the 400 for an unknown model id and the 401 for a bad key.
 */
function providerError(name: string, status: number, body: unknown): ModelProviderError {
  const envelope = isRecord(body) ? body : undefined;
  const error = envelope !== undefined && isRecord(envelope['error']) ? envelope['error'] : undefined;
  return new ModelProviderError({
    status,
    providerCode: error === undefined ? `http_${String(status)}` : errorCode(name, error, status),
    message: error === undefined ? 'no error body' : (asString(error['message']) ?? 'no message'),
    retryable: status === 429 || status >= 500,
  });
}

/**
 * The reply text, uniform across modes — what {@link ChatCompletionsProvider.complete}
 * returns as {@link ModelResponse.text} regardless of which wire shape
 * produced it, so a caller reads the same JSON document either way.
 *
 * `'strict'` carries the reply as `message.content`.
 * `'tool_choice'` carries it as the forced call's `function.arguments` — a
 * JSON STRING already, because that is the wire format for a tool call's
 * arguments, and `parameters: schema` in {@link schemaFields} means that
 * string parses into exactly the same shape `'strict'` mode's `content`
 * would have. No further transform: the schema travelled unmodified, so the
 * reply needs none either.
 */
function replyText(mode: StructuredOutputMode, message: Record<string, unknown> | undefined): string {
  if (message === undefined) {
    return '';
  }
  if (mode === 'tool_choice') {
    const toolCalls = message['tool_calls'];
    const first = Array.isArray(toolCalls) && isRecord(toolCalls[0]) ? toolCalls[0] : undefined;
    const fn = first !== undefined && isRecord(first['function']) ? first['function'] : undefined;
    return (fn === undefined ? undefined : asString(fn['arguments'])) ?? '';
  }
  return asString(message['content']) ?? '';
}

/** The `usage` key a gateway states a call's USD price under. */
const COST_KEY = 'cost';

/**
 * The call's price in USD, exactly as the gateway stated it, or `undefined`
 * when the response does not state one.
 *
 * A usage-accounting gateway returns `usage.cost` on every response (its docs,
 * read 2026-09-25; measured on the hands and look models the same day, e.g.
 * `"cost":0.00000245`). It is the figure the call is billed from — never a
 * price table here — and it arrives as the number's JSON SOURCE TEXT because
 * `systemHttpPost` was asked for `exactNumberKeys: ['cost']`. Absent, the
 * provider looks the cost up instead; see `ChatCompletionsProvider.complete`.
 */
export function readCost(value: unknown): string | undefined {
  return exactUsd(value, COST_KEY);
}

/**
 * `value[key]` as exact decimal USD, or `undefined`. The number must arrive as
 * its JSON SOURCE TEXT (the transport's `exactNumberKeys`);
 * `decimalFromJsonNumber` turns `2e-7` into `'0.0000002'` without a float. A
 * value that is not that text (a transport that parsed it into a binary64, a
 * negative, garbage) is refused as absent rather than trusted.
 */
function exactUsd(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const source = value[key];
  if (typeof source !== 'string') {
    return undefined;
  }
  let usd: string;
  try {
    usd = decimalFromJsonNumber(source);
  } catch {
    return undefined;
  }
  return usd.startsWith('-') ? undefined : usd;
}

/**
 * Reads the usage block, de-overlapping `prompt_tokens`. See the module comment
 * for the measurement this subtraction rests on.
 */
export function readUsage(value: unknown): TokenUsage {
  if (!isRecord(value)) {
    return ZERO_TOKENS;
  }
  const promptDetails = isRecord(value['prompt_tokens_details']) ? value['prompt_tokens_details'] : undefined;
  const completionDetails = isRecord(value['completion_tokens_details'])
    ? value['completion_tokens_details']
    : undefined;

  const promptTotal = count(value['prompt_tokens']);
  const cacheReadTokens = count(promptDetails?.['cached_tokens']);
  const cacheWriteTokens = count(promptDetails?.['cache_write_tokens']);

  return {
    inputTokens: Math.max(0, promptTotal - cacheReadTokens - cacheWriteTokens),
    outputTokens: count(value['completion_tokens']),
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: count(completionDetails?.['reasoning_tokens']),
  };
}

/** A token count, or zero. Non-integers are dropped rather than rounded. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}
