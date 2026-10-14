/**
 * The provider seam and the error taxonomy.
 *
 * One method, `complete`, because every call this product makes is the same
 * shape: one system prompt, one user prompt, an optional JSON schema the reply
 * must satisfy, and a deadline. There is no conversation to maintain — the agent
 * loop re-renders the whole prompt from the tree and the history on every step
 * (`renderPrompt` in `@outcrawl/runtime`), which is what makes a step's result
 * reproducible and therefore cacheable.
 *
 * ── Why the errors are a closed taxonomy ─────────────────────────────────────
 *
 * The five failures below are five different decisions:
 *
 * - {@link ModelTimeoutError} — nobody answered inside the budget. Nothing was
 *   billed. Retry, or give the next step a bigger slice.
 * - {@link ModelProviderError} — the provider answered with a refusal to serve:
 *   a bad key, a rate limit, a 400 naming our own malformed schema, a 529. It
 *   carries `retryable` because that is the only question the caller has.
 * - {@link ModelUnusableError} — the provider answered, was billed, and the
 *   answer cannot be used: a policy refusal, or a reply truncated at
 *   `max_tokens` mid-JSON. Tokens were spent, so this failure has a cost
 *   attached and the ledger records it.
 * - {@link ModelSchemaError} — the text is not the JSON that was promised, or
 *   is JSON that does not satisfy the schema. **This is an error and never an
 *   empty result.** A silent `{}` here is indistinguishable from a page that
 *   genuinely contained nothing, and it is the failure mode that makes an
 *   extraction pipeline look like it works.
 * - {@link ModelConfigError} — no key, no rate for the model being asked for.
 *   A deployment problem, surfaced at construction rather than mid-run.
 */

import type { Usage } from '@outcrawl/scout-core';

/**
 * One image sent alongside the prompt.
 *
 * Raw base64 with no `data:` prefix, because the two wire shapes disagree about
 * where the prefix goes and only one of them wants it: a chat-completions wire
 * takes a whole data URL (`data:image/png;base64,…`) and a messages-style wire
 * takes the media type and the payload as separate fields. Storing the prefixed
 * form here would make one of the two clients strip a string it was handed, which is the kind of
 * asymmetry that survives until a `data:image/png;base64,data:image/png;…`
 * reaches a provider and is billed for.
 *
 * PNG and JPEG only. Both providers document more formats, and narrowing to the
 * two they agree on costs nothing today — the only caller screenshots a browser
 * — while a union that admits a format one of them refuses turns a compile-time
 * fact into a 400 at run time.
 */
export interface ModelImage {
  readonly mediaType: 'image/png' | 'image/jpeg';
  /** Raw base64. No `data:` prefix; see {@link ModelImage}. */
  readonly base64: string;
}

/**
 * How hard a model is asked to think, as a provider-neutral request field.
 *
 * ── Why this is here at all: it is the biggest single cost lever ─────────────
 *
 * REASONING TOKENS ARE BILLED AS OUTPUT. Measured against the live gateway on
 * the rank-0 hands model's preview release — scout-1's rank-0 actuator — with the loop's
 * own `renderPrompt` output at 1,880-1,937 prompt tokens and
 * `AGENT_REPLY_SCHEMA`, one action call:
 *
 *     unset (provider default)   2,284 reasoning   2,422 completion   $0.0004389
 *     effort 'high'              1,785             1,898              $0.00036142
 *     effort 'medium'            1,593             1,750              $0.0003377
 *     effort 'low'                 249               366              $0.00013238
 *     effort 'none'                  0               120              $0.00009304
 *
 * Every arm chose the same node on the same page. That is ~30 reasoning tokens
 * per token of answer at the default, for a call whose entire job is to pick one
 * action out of a bounded list of actionable nodes.
 *
 * ── And it is a CORRECTNESS lever, not only a cost one ──────────────────────
 *
 * `max_tokens` covers reasoning. At `ModelClient`'s 1,024 default the same call
 * returns `finish_reason: "length"` with an EMPTY content string at the provider
 * default and at `'medium'`, and returns `stop` with a valid action at `'low'`
 * (256 reasoning tokens) and `'none'` (0). So lowering effort fixes the
 * truncation that gave scout-1 twelve step failures in twelve steps, without
 * raising any ceiling.
 *
 * ── THERE IS NO `exclude` FIELD, AND THAT IS DELIBERATE ─────────────────────
 *
 * The gateway accepts `reasoning: {exclude: true}`, it reads exactly like the
 * fix, and it is not one. MEASURED on the same call: 1,096 reasoning tokens
 * still billed, merely absent from the response body. Anyone optimising this
 * later would reach for it first, watch the reasoning vanish from the reply, and
 * conclude they had won while paying the same bill with the evidence deleted. It
 * is not offered here so that it cannot be reached for.
 */
export interface ReasoningConfig {
  /**
   * The level, in the provider's own vocabulary. NOT every slug takes every
   * value: the gateway publishes `reasoning.supported_efforts` per model and
   * rejects a level outside it, so a caller choosing one per slug is choosing
   * from that list. `'none'` is unavailable on one measured cheap model
   * (`['xhigh','high']`), and two others (a frontier planner candidate and a
   * cheap hands candidate) are
   * `mandatory: true` and cannot be disabled at all — though both CAN be
   * lowered, which is the opposite of how `mandatory` reads.
   */
  readonly effort?: 'max' | 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';
  /**
   * A ceiling on reasoning tokens, SEPARATE from {@link ModelRequest.maxTokens}
   * and measured to be honoured as one: the rank-0 hands model at `maxTokens: 4096` with this
   * at 128 returned 242 reasoning tokens and a valid action, against 2,284
   * unset. A budget rather than a level, for a provider that maps it to one.
   */
  readonly maxTokens?: number;
  /**
   * `false` turns reasoning off outright, where the slug permits it. Distinct
   * from `effort: 'none'` because not every slug publishes a `'none'` level and
   * some accept the flag instead; measured equivalent on the rank-0 hands model (0 reasoning
   * tokens either way) and the only lever that works on the cheap model above
   * whose published efforts stop at `high`.
   */
  readonly enabled?: boolean;
}

/**
 * One earlier turn of a conversation, verbatim as it was sent or received.
 *
 * BYTE-IDENTICAL REPLAY IS THE CALLER'S JOB AND THE WHOLE POINT. A prompt cache
 * is keyed on the serialised prefix: a user turn re-rendered with one changed
 * byte, or an assistant turn re-serialised from its parsed JSON, misses the
 * cache from that turn on. Replay the user text exactly as sent and the
 * assistant text exactly as the provider returned it (`ModelResponse.text`).
 */
export interface ModelTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/**
 * The one call. Stateless unless {@link ModelRequest.turns} carries a thread:
 * no conversation id, no server-side continuation, the whole conversation is
 * re-sent every call.
 */
export interface ModelRequest {
  /** Names the model exactly. Never a family alias resolved provider-side. */
  readonly model: string;
  /** The contract the reply must satisfy. Ours, not the caller's. */
  readonly system: string;
  /**
   * Earlier conversation turns, oldest first, starting with `user` and
   * alternating. Sent between {@link system} and {@link prompt}, which stays the
   * final user turn. Absent (or empty) is a one-shot call, exactly as before
   * this field existed. A provider that cannot carry a thread REFUSES a request
   * with turns (`ModelConfigError`) rather than dropping them: a conversation
   * silently reduced to its last message is a different question.
   */
  readonly turns?: readonly ModelTurn[];
  /**
   * Ask the provider to cache the stable prefix: explicit
   * `cache_control` breakpoints on the system block, the last earlier user
   * turn, and — when {@link tail} is set — the final prompt, so the next call
   * reads it back once it is replayed as a turn. Absent or false sends no
   * breakpoint. This, {@link turns} and {@link tail} all absent → the request
   * body is byte-identical to the body before any of them existed.
   */
  readonly cache?: boolean;
  /** The rendered prompt. `renderPrompt` output, or the extraction body. */
  readonly prompt: string;
  /**
   * Text sent after {@link prompt} in the same user message, as its own part
   * and OUTSIDE the cached prefix: the part of this ask that is never replayed
   * (the brain's element list, whose refs mean nothing once the page moves).
   * With {@link cache}, the prompt part carries the breakpoint and is replayed
   * byte-identically as the next call's turn, so it is written to cache once
   * at 1.25x instead of being paid in full now and written again later.
   */
  readonly tail?: string;
  /**
   * The upstream providers to try first for THIS request, in order, with
   * fallbacks left on (the gateway's `provider.order`). Absent sends the body
   * exactly as before. Per request, never per deployment: the brain's call
   * is routed to one upstream (BrainRoute, 2026-10-02 21:41-21:51Z, n=37
   * vs 48: p50 1.64 s vs 2.36 s, cache hits 34/34) while the hands' routing
   * stays untouched — which a deployment-wide upstream setting would not do.
   */
  readonly providerOrder?: readonly string[];
  /**
   * A reply cut off at `max_tokens` whose text already holds one complete
   * JSON object is returned as that object instead of thrown unusable. Brain
   * calls only: a frontier brain model on one upstream was measured writing a valid decision
   * and then repeating `<invoke>` to the 1,000-token cap (BrainCache,
   * 2026-10-03 00:20-00:27Z, 5 truncations in one 52x3), and every such cut
   * became a hands-only step. Absent: a truncation throws, as before.
   */
  readonly salvageTruncated?: boolean;
  /**
   * Images the prompt refers to. Absent means a text-only call, which is every
   * caller but the captcha solver.
   *
   * ORDERED AFTER THE TEXT ON THE WIRE, in both clients, because the gateway says
   * so in terms: "Due to how the content is parsed, we recommend sending the
   * text prompt first, then the images"
   * (the gateway's image-understanding guide, read
   * 2026-09-06). A messages-style provider has no such rule, so one order satisfies both and
   * there is nothing per-provider to remember.
   *
   * NOT CACHEABLE, AND THAT IS THE COST MODEL RATHER THAN A LIMITATION. A caller
   * that sends a fresh screenshot every step re-pays full input rate for it
   * every step: a 400x580 crop is six 768x768 tiles at 258 tokens each, 1548
   * tokens, against a few hundred for the instructions around it. Whoever prices
   * a loop that uses this should price the image cold and treat a warm prefix as
   * the rounding it is.
   */
  readonly images?: readonly ModelImage[];
  /**
   * When present, the reply is constrained to this schema by the provider
   * rather than merely requested in prose. Already reduced to the subset the
   * provider supports — see `./schema`. Callers pass their own schema to the
   * client, not to a provider.
   */
  readonly schema?: Readonly<Record<string, unknown>>;
  /**
   * Ceiling on the reply, or ABSENT for the provider's own.
   *
   * ── OPTIONAL, BECAUSE A CALLER'S CEILING TRUNCATED VALID ANSWERS ──────────
   *
   * It was required, and `packages/captcha`'s vision port paid for that:
   * measured over 229 recorded solve attempts, 36 of 222 thrown looks — 16% —
   * came back `the reply was cut off at max_tokens, so any JSON in it is
   * truncated`. Each was a paid, billed call discarded for a number the caller
   * had chosen on arithmetic about how it expected the model to serialise.
   *
   * A ceiling is only safely set by whoever knows how verbosely the model
   * writes, which is the provider. So absent sends nothing where the vendor
   * allows it, and a caller that genuinely needs to bound output — the agent
   * loop does, per purpose — still states a number.
   *
   * A MESSAGES-STYLE PROVIDER IS THE EXCEPTION AND IT IS THE VENDOR'S, not ours:
   * its API rejects a request without `max_tokens`, so a provider for it supplies
   * its own generous default rather than making every caller carry one.
   */
  readonly maxTokens?: number;
  /**
   * How much the model may think before it answers. Absent sends nothing and
   * gets the provider's own default, which is what every call did before this
   * field existed.
   *
   * See {@link ReasoningConfig}. This is the second cost lever and the one that
   * was never pulled: a snapshot budget bounds INPUT, and on an app-shaped page
   * the reasoning term is the dominant OUTPUT cost.
   */
  readonly reasoning?: ReasoningConfig;
  /**
   * Sampling temperature. Absent sends nothing and takes the provider's own
   * default, which is what every call in this repo did before this field
   * existed — and that default is not ours and is not zero.
   *
   * THE ABSENCE OF THIS FIELD WAS A MEASURED DEFECT, not a simplification.
   * Every call this fleet makes is schema-constrained: there is one right
   * answer shape and, for the vision and actuator roles, one right answer.
   * Sampling at a provider default turns that into a distribution. Measured on
   * a real reCAPTCHA anchor through the shipped `WIDGET_SYSTEM_PROMPT` and
   * `WIDGET_REPLY_SCHEMA`, 20 trials per cell:
   *
   *   a small frontier model, provider default      17/20 clicks inside the
   *                                                  checkbox, click y 52-80 px
   *   a small frontier model, temperature 0         20/20, click y 57 px every
   *                                                  single time
   *
   * Same image, same prompt, same schema. Three of twenty solves were being
   * thrown away to sampling noise on a target the model can hit perfectly.
   *
   * Left OPTIONAL rather than defaulted to 0 here, because a default in this
   * interface would silently change every existing caller's behaviour from one
   * release to the next, and because `reasoning` above sets the precedent:
   * absent means "send nothing". The decision belongs at the call site, where
   * it can be read.
   */
  readonly temperature?: number;
  /** Remaining budget in ms, from the caller's clock. */
  readonly timeoutMs: number;
  /**
   * Aborts the request when the caller no longer wants its answer — the losing
   * arm of a hedged action or extract call (`HarnessPortOptions.hedgeMs`), or
   * the run's cancel. Absent on every other call. A provider that honours it stops the transport and throws
   * {@link ModelCancelledError}; one that does not is cut loose by
   * `ModelClient`, which stops waiting either way.
   */
  readonly signal?: AbortSignal;
}

/**
 * Token counts exactly as the provider reported them, before any pricing.
 *
 * Separate from core's `Usage` on purpose: `Usage` is the customer-facing shape
 * and has no field for cache *writes*, which are billed at a premium and are
 * therefore load-bearing for cost. Collapsing them early is how a cost number
 * becomes unexplainable.
 */
export interface TokenUsage {
  /** Uncached input tokens. Excludes both cache figures, per the provider docs. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input tokens read from the provider's prompt cache. Billed at 0.1x. */
  readonly cacheReadTokens: number;
  /** Input tokens written to the provider's prompt cache. Billed at 1.25x. */
  readonly cacheWriteTokens: number;
  /** Reasoning/thinking tokens, when the provider reports them separately. */
  readonly reasoningTokens: number;
}

export const ZERO_TOKENS: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

/**
 * Where a call's USD came from.
 *
 * - `provider` — the response stated it (the gateway's `usage.cost`). The normal case.
 * - `generation` — the response did not, and the gateway's own record of the
 *   generation (`GET /api/v1/generation?id=…`, `data.total_cost`) did. Still
 *   the provider's figure, found one request later.
 * - `estimate` — neither said, so the call is priced from the host's rate card
 *   (`costOf(usage, ratesIn(rates, model))`). The one figure here that is ours
 *   and not the provider's, which is why it is named on every row it reaches.
 * - `subscription` — the call drew on one of our flat-rate subscriptions
 *   (subscription OAuth, lab arms only, OC-286), so nothing was billed per
 *   call. The figure is `'0'`, or, where the provider states one, the call's
 *   WOULD-BE list price (a lab brain on a subscription: its caps bind as on a
 *   metered key). Named so neither is mistaken for a call the provider forgot
 *   to price or billed, and so no reconciliation attributes it to the gateway.
 *
 * A missing cost never fails a call (W44 review, finding 3): the customer's
 * answer exists and was paid for, and accounting that cannot find its number
 * is an operator problem, logged loudly, not a customer failure.
 */
export type CostSource = 'provider' | 'generation' | 'estimate' | 'subscription';

export interface ModelResponse {
  /** The reply text. Under a schema this is a JSON document, still unparsed. */
  readonly text: string;
  readonly usage: TokenUsage;
  /**
   * What this call cost, in USD, as an exact decimal string. The PROVIDER's
   * figure unless {@link costSource} says `estimate`. This is the figure model
   * usage is billed from (x 1.70, at the plan's price per credit).
   */
  readonly costUsd: string;
  /** Where {@link costUsd} came from. */
  readonly costSource: CostSource;
  /** Provider-native, kept verbatim for the record. */
  readonly stopReason: string;
  /** The provider's own request id, for a support ticket. */
  readonly requestId?: string;
}

/**
 * A model provider. `name` appears in every ledger entry, so it is part of the
 * contract rather than a label.
 */
export interface ModelProvider {
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/** Base class, so a caller can catch every model failure and nothing else. */
export class ModelError extends Error {
  /** Tokens billed by the failed call. Zero when the provider never answered. */
  readonly usage: TokenUsage;
  /**
   * USD the provider charged for the failed call, as it stated it. `'0'` when
   * the provider never answered, or answered with an error that carried no
   * charge. A refusal or a truncation is billed, and carries its cost here so
   * the run is charged for it like any other call.
   */
  readonly costUsd: string;
  /** Where {@link costUsd} came from; see {@link CostSource}. */
  readonly costSource: CostSource;

  constructor(message: string, usage: TokenUsage = ZERO_TOKENS, costUsd = '0', costSource: CostSource = 'provider') {
    super(message);
    this.name = 'ModelError';
    this.usage = usage;
    this.costUsd = costUsd;
    this.costSource = costSource;
  }
}

export class ModelTimeoutError extends ModelError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, cause?: unknown) {
    super(`the model did not answer within ${String(Math.round(timeoutMs))}ms`);
    this.name = 'ModelTimeoutError';
    this.timeoutMs = timeoutMs;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export class ModelProviderError extends ModelError {
  /** HTTP status, or 0 when the failure was below HTTP. */
  readonly status: number;
  /** The provider's own error type, e.g. `rate_limit_error`. */
  readonly providerCode: string;
  readonly retryable: boolean;
  readonly requestId?: string;
  /**
   * The status of the FAILURE, which is not always the status of the response.
   *
   * Equal to {@link status} except for a 2xx carrying an inline error, where
   * the provider names the upstream fault in the body instead: the gateway's
   * `{"error":{"code":502,"message":"Upstream error from <upstream>: …"}}` on an
   * HTTP 200. Measured 2026-09-24: that one shape was 7-16% of every production
   * agent step from 12Z on, and because `status` said 200 the failover chain
   * never demoted on it — `shouldFailOver` reads this field, `status` stays
   * the wire truth the ledger and the error text report.
   */
  readonly upstreamStatus: number;

  constructor(opts: {
    status: number;
    providerCode: string;
    message: string;
    retryable: boolean;
    requestId?: string;
    upstreamStatus?: number;
    /** A 2xx carrying an inline error may still have been billed, and says so in `usage.cost`. */
    costUsd?: string;
  }) {
    super(
      `model provider refused (${String(opts.status)} ${opts.providerCode}): ${opts.message}`,
      ZERO_TOKENS,
      opts.costUsd ?? '0',
    );
    this.name = 'ModelProviderError';
    this.status = opts.status;
    this.providerCode = opts.providerCode;
    this.retryable = opts.retryable;
    this.upstreamStatus = opts.upstreamStatus ?? opts.status;
    if (opts.requestId !== undefined) {
      this.requestId = opts.requestId;
    }
  }
}

/** Billed, and unusable. `reason` is provider-native: `refusal`, `max_tokens`. */
export class ModelUnusableError extends ModelError {
  readonly stopReason: string;
  /** The provider's id for the generation, so a cut or refused reply can be looked up (the gateway's `/generation?id=`). */
  readonly requestId?: string;

  constructor(stopReason: string, detail: string, usage: TokenUsage, costUsd: string, costSource: CostSource = 'provider', requestId?: string) {
    super(`the model answered but the answer is unusable (${stopReason}): ${detail}`, usage, costUsd, costSource);
    this.name = 'ModelUnusableError';
    this.stopReason = stopReason;
    if (requestId !== undefined) {
      this.requestId = requestId;
    }
  }
}

/** `{requestId}` when a failed call reached the provider and got a generation id, else `{}`: a ledger/report spread. */
export function requestIdOf(thrown: unknown): { readonly requestId?: string } {
  const requestId = thrown instanceof ModelProviderError || thrown instanceof ModelUnusableError ? thrown.requestId : undefined;
  return requestId === undefined ? {} : { requestId };
}

/**
 * The reply was not the JSON that was promised.
 *
 * Carries the offending text, truncated. A schema failure with no sample of
 * what actually arrived cannot be diagnosed, and this is the error most likely
 * to be read by someone who cannot reproduce it.
 */
export class ModelSchemaError extends ModelError {
  /** What was wrong, one line each. */
  readonly violations: readonly string[];
  /** First 400 characters of the reply. Never the prompt: prompts carry data. */
  readonly sample: string;

  constructor(
    violations: readonly string[],
    text: string,
    usage: TokenUsage,
    costUsd: string,
    costSource: CostSource = 'provider',
  ) {
    super(
      `the model returned output that does not satisfy the schema: ${violations.join('; ')}`,
      usage,
      costUsd,
      costSource,
    );
    this.name = 'ModelSchemaError';
    this.violations = violations;
    this.sample = text.length > 400 ? `${text.slice(0, 400)}...` : text;
  }
}

export class ModelConfigError extends ModelError {
  constructor(message: string) {
    super(message);
    this.name = 'ModelConfigError';
  }
}

/**
 * The caller withdrew the call before it answered: the losing arm of a hedge,
 * or the run's cancel.
 *
 * Carries `'0'`, like a {@link ModelTimeoutError}: nothing came back, so there
 * is no stated cost, and the run is never charged for it. That is the
 * CUSTOMER's side. The gateway bills a non-streaming call in full whether or not
 * the caller aborts, so a call withdrawn after it was sent is reported to the
 * host as house spend at an estimate (`ModelClientOptions.onWithdrawn`). Never
 * failed over and never resent: nobody is waiting for it.
 */
export class ModelCancelledError extends ModelError {
  constructor(cause?: unknown) {
    super('the call was withdrawn before it answered: another model answered first');
    this.name = 'ModelCancelledError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * `TokenUsage` as core spells it, for the surfaces that report usage to a
 * customer. `cachedInputTokens` is the provider's prompt-cache read, which is
 * not the action cache: an action-cache hit never reaches a provider at all and
 * is reported through `Usage.cache` instead.
 */
export function toCoreUsage(usage: TokenUsage, inferenceTimeMs: number): Usage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.reasoningTokens > 0 ? { reasoningTokens: usage.reasoningTokens } : {}),
    ...(usage.cacheReadTokens > 0 ? { cachedInputTokens: usage.cacheReadTokens } : {}),
    inferenceTimeMs,
  };
}
