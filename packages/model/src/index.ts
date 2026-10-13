/**
 * `@outcrawl/model` — the model client.
 *
 * `ModelPort` in `@outcrawl/runtime` is the seam a provider is bound to, and
 * `PipelineDeps.extractJson` is the render pipeline's half of it. This package
 * implements both, over an injected provider — and `ModelClient implements
 * ModelPort`, so the day the host's shape and this class's shape disagree is a
 * compile error rather than a production run with no brain.
 *
 * It names no model. Which models run, in which role, with which fallbacks,
 * deadlines and reasoning effort, is a {@link ModelPlan} the host injects; the
 * prices are a {@link RateCard} the host injects; the endpoint is a provider
 * the host constructs.
 *
 * Four things are load-bearing and each has tests:
 *
 * 1. **Output is schema-constrained, then validated against the original
 *    schema.** Prose where JSON was promised is a {@link ModelSchemaError}. It is
 *    never an empty object, because an empty extraction is indistinguishable from
 *    a page that genuinely had nothing on it.
 * 2. **Every call is priced into a ledger, attributable to a session** —
 *    including the failures that were billed. A refusal is a 200 the provider
 *    charges for; a cost centre that only counted successes would understate
 *    spend exactly on the runs someone is investigating.
 * 3. **The price is the provider's own.** Every call carries the USD the
 *    provider stated for it (`ModelResponse.costUsd`, the gateway's
 *    `usage.cost`). A response that states none is priced from the gateway's
 *    generation record, else from the list price, marked
 *    `costSource: 'estimate'` and logged — never failed over accounting.
 * 4. **The key is injected, never read here and never logged.**
 *
 * One protocol, `ChatCompletionsProvider`: every shape in `./chat-completions`
 * was measured against a live gateway, including the one that matters most —
 * `prompt_tokens` overlaps the cache counters there, so it is de-overlapped
 * before the counts are reported.
 */

export {
  AGENT_REPLY_SCHEMA,
  AGENT_REPLY_SCHEMA_WITHOUT_REASONING,
  AGENT_SYSTEM_PROMPT,
  AGENT_SYSTEM_PROMPT_WITHOUT_REASONING,
  EXTRACT_SYSTEM_PROMPT,
  extractPromptText,
  ModelClient,
  NO_ACTION_CACHE,
  type ExtractResult,
  type ModelCallEvent,
  type ModelCallOptions,
  type ModelClientOptions,
  type SessionAttribution,
  type WithdrawnBasis,
  type WithdrawnCall,
} from './client';

export {
  HarnessModelPort,
  MODEL_HEDGE_ENV,
  PLAN_TRIGGERS,
  modelHedgeMsFrom,
  planDigestFrom,
  shouldFailOver,
  type EnvLookup,
  type FailoverEvent,
  type FailoverTrigger,
  type HarnessPortOptions,
  type ModelPlan,
  type PlanDigest,
  type PlanModel,
  type PlanTrigger,
  type PlanView,
} from './harness';

export {
  BRAIN_SCHEMA,
  BRAIN_SYSTEM_PROMPT,
  EYES_SCHEMA,
  EYES_SYSTEM_PROMPT,
  readBrief,
  readDecision,
  type Brief,
  type BrainDecision,
} from './brain';

export {
  ChatCompletionsProvider,
  firstJsonObject,
  readCost,
  readUsage,
  type ChatCompletionsProviderOptions,
  type CostFallbackEvent,
  type ProviderRouting,
  type StructuredOutputMode,
} from './chat-completions';

export {
  HttpTransportError,
  asString,
  systemHttpGet,
  systemHttpPost,
  type HttpGet,
  type HttpGetRequest,
  type HttpPost,
  type HttpRequest,
  type HttpResponse,
} from './http';

export {
  CostLedger,
  reportingProvider,
  type CallOutcome,
  type CallPurpose,
  type CostEntry,
  type CostLedgerOptions,
  type CostTotals,
  type ProviderCall,
} from './ledger';

export {
  LOOK_REPLY_SCHEMA,
  LOOK_SYSTEM_PROMPT,
  LOOK_TIMEOUT_MS,
  ModelPageLook,
  parseLookReply,
  renderLookPrompt,
  type ModelPageLookOptions,
} from './look';

export {
  ModelCancelledError,
  ModelConfigError,
  ModelError,
  ModelProviderError,
  ModelSchemaError,
  ModelTimeoutError,
  ModelUnusableError,
  ZERO_TOKENS,
  toCoreUsage,
  type CostSource,
  type ModelImage,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelTurn,
  type ReasoningConfig,
  type TokenUsage,
} from './provider';

export {
  costOf,
  ratesIn,
  tokensAsMillions,
  type CostBreakdown,
  type RateCard,
  type TokenRates,
} from './rates';

export { constrainSchema, validate, type ConstrainedSchema } from './schema';
