# @outcrawl/model

The LLM client: one class behind an injected provider, schema-constrained output, and every
call's provider-stated USD recorded in a per-session cost ledger. `ModelClient
implements ModelPort` (the `@outcrawl/runtime` seam), so a shape disagreement with the host is a
compile error rather than an Agent run with no brain.

It names no model. The host injects all three things that are concrete: the **plan** (which
models run, by role — actuator chain, planner, brain — with each model's measured deadline,
extraction hedge, upstream order and reply schema), the **rate card** (list prices, for
estimates only), and the **provider** (the endpoint and its key).

## Surface

```ts
import { ChatCompletionsProvider, CostLedger, HarnessModelPort, type ModelPlan } from '@outcrawl/model';
```

| Export | What it is |
| --- | --- |
| `ModelClient`, `ModelClientOptions`, `ModelCallOptions`, `SessionAttribution`, `ExtractResult` | The client. One instance holds one provider, one model (plus an optional extraction model) and one session's identity, and stamps that identity on every ledger row it writes. |
| `AGENT_REPLY_SCHEMA`, `AGENT_SYSTEM_PROMPT`, `AGENT_REPLY_SCHEMA_WITHOUT_REASONING`, `AGENT_SYSTEM_PROMPT_WITHOUT_REASONING`, `EXTRACT_SYSTEM_PROMPT`, `extractPromptText` | The action and extraction prompts and reply schemas, exported so a measurement sends the real ones. The `_WITHOUT_REASONING` pair is what `replyReasoning: false` sends, for a model whose provider refuses a reply schema that asks for its reasoning. |
| `NO_ACTION_CACHE` | The cache verdict every choice carries: this client has no action cache. A host that caches wraps the port. |
| `ModelCallEvent`, `WithdrawnCall`, `WithdrawnBasis` | One line per provider call (`onCall`), and one report per withdrawn call (`onWithdrawn`) as house spend at an estimate. |
| `HarnessModelPort`, `HarnessPortOptions`, `ModelPlan`, `PlanModel`, `PlanTrigger`, `PLAN_TRIGGERS` | The port that runs an injected plan: the actuator chain with failover and cooldown, the planner on its triggers, and the brain when the plan has one. `providerFor` gives one slot its own provider. |
| `shouldFailOver`, `FailoverEvent`, `FailoverTrigger` | The closed failover decision and the operator line for each demotion and recovery. |
| `MODEL_HEDGE_ENV`, `modelHedgeMsFrom`, `EnvLookup` | The one variable this package reads, from an injected environment: the action-call hedge threshold (below). |
| `planDigestFrom`, `PlanDigest`, `PlanView` | What the planner is shown: the run's state, never the page. |
| `BRAIN_SCHEMA`, `BRAIN_SYSTEM_PROMPT`, `EYES_SCHEMA`, `EYES_SYSTEM_PROMPT`, `readBrief`, `readDecision`, `Brief`, `BrainDecision` | Brain mode's contract (`src/brain.ts`): a frontier model decides each step from a compact brief, the actuator chain is its eyes and hands. |
| `ChatCompletionsProvider`, `ChatCompletionsProviderOptions`, `ProviderRouting`, `StructuredOutputMode`, `CostFallbackEvent` | The one wire this package speaks: a chat-completions endpoint, named, keyed and (optionally) routed by the host. Its key is a constructor option; it never reads the environment. |
| `readCost`, `readUsage`, `firstJsonObject` | Reading a chat-completions reply: the exact-decimal stated cost, the de-overlapped token counters, the first complete JSON object in a text. |
| `HttpTransportError`, `systemHttpPost`, `systemHttpGet`, `asString`, `HttpPost`, `HttpGet`, `HttpRequest`, `HttpGetRequest`, `HttpResponse` | The injected HTTP seam, with the caller's remaining budget on every request. |
| `CostLedger`, `CostLedgerOptions`, `CostEntry`, `CostTotals`, `CallOutcome`, `CallPurpose`, `reportingProvider`, `ProviderCall` | Per-session cost accounting: entries plus running totals, at the provider's own per-call USD (`ModelResponse.costUsd`). Its total is what a run or a monitor check is billed for model usage (W44). `flatRateProviders` names the providers whose calls draw on a flat-rate subscription. |
| `costOf`, `ratesIn`, `tokensAsMillions`, `RateCard`, `TokenRates`, `CostBreakdown` | The host's rate card and the one place a cost is ESTIMATED from it: the last-resort bill for a completion that stated no cost (marked `costSource: 'estimate'`), a withdrawn call's house estimate, and an extraction's `maxUsd` cut. |
| `constrainSchema`, `validate`, `ConstrainedSchema` | Schema constraint on the way out, validation against the caller's original schema on the way back. |
| `toCoreUsage`, `ZERO_TOKENS`, `TokenUsage` | Usage counters. Read the first invariant before touching these. |
| `ModelError`, `ModelConfigError`, `ModelProviderError`, `ModelSchemaError`, `ModelTimeoutError`, `ModelUnusableError`, `ModelCancelledError`, `CostSource` | Failure modes, separated because they have different fixes. |
| `ModelProvider`, `ModelRequest`, `ModelResponse`, `ModelTurn`, `ModelImage`, `ReasoningConfig` | The provider seam. |
| `ModelPageLook`, `ModelPageLookOptions`, `LOOK_SYSTEM_PROMPT`, `LOOK_REPLY_SCHEMA`, `LOOK_TIMEOUT_MS`, `renderLookPrompt`, `parseLookReply` | The vision half of the agent's `page.look` tool: one screenshot and one question to an image model the host names, recorded in the ledger as purpose `look`. |

Subpath exports: `@outcrawl/model/{provider,http,chat-completions,rates,schema,ledger,client,harness,brain}`.

## Composition

- **The plan.** `HarnessModelPort({ plan, provider, rates?, session, ledger, ... })`. `plan.actuators`
  is never empty and is in ascending rank order: rank 0 is asked first and each next rank is the
  failover. `plan.planner` and `plan.brain` are optional. A host that pins one model for debugging
  hands in a one-model plan; this package reads no model id from anywhere else.
- **The rate card.** `rates` on `ModelClientOptions`, `HarnessPortOptions` and
  `ModelPageLookOptions`. Read for estimates only, never for a bill; absent, or a model not on it,
  makes no estimate. `ModelPageLook` with a card refuses a model that is not on it or takes no
  image.
- **The provider.** One client holds one provider. A plan whose slots live behind different
  providers passes `providerFor(model)` to the port, so each slot's client gets its own.
- `OUTCRAWL_MODEL_HEDGE_MS` (`MODEL_HEDGE_ENV`, read by `modelHedgeMsFrom` from an injected
  environment) — optional, off when unset or `0`; otherwise whole milliseconds, at most 60000.
  When rank 0 of an agent's action chain has not answered this many milliseconds in, the same
  model is asked the same question again beside it; the first valid answer is the step's and the
  other call is aborted. While it is on, a rank-0 extraction is hedged the same way at its model's
  `PlanModel.extractHedgeMs` (15 s for the production rank-0 hands model). The hedge never demotes
  and never decides a failure: a primary that fails mid-hedge fails exactly as an unhedged call
  does. Every call is billed as it always was (an answered loser at its stated cost, an aborted
  one at `0`, like a timeout), and the run's budget clamp is unchanged. A malformed value is a
  `ModelConfigError`.
- Every agent action, extraction, planner and brain call made through the port is one
  `onCall` event (model, purpose, attempt, hedge, outcome, latency, tokens, USD). Calls made
  outside it emit only what their own client is given.

## Invariants

- **A chat-completions reply's `prompt_tokens` includes the cache counters;
  `TokenUsage.inputTokens` excludes them, so `readUsage` subtracts.** A messages-style provider
  reports three disjoint counters; a chat-completions wire reports `prompt_tokens` as the total
  and `prompt_tokens_details.cached_tokens` as a subset of it. Passing it straight through prices
  every cached input token twice — once at the full input rate in the provider, again at the
  cache-read rate in `costOf` — and `costOf` cannot detect it. A negative result is clamped to
  zero rather than trusted, because a negative count would flow into `tokensAsMillions`, which
  throws.
- **No cost is ever a float, at any intermediate step.** Exact-decimal arithmetic over
  `multiplyDecimal` from `@outcrawl/core` and integer bigints underneath; token counts become
  millions by moving the decimal point, not by dividing by `1e6`. Rate-card figures are stored as
  the strings the provider's own page shows (`'6.25'`, not `6.25`) so a reviewer can diff them.
- **`reasoningTokens` is counted and never priced.** Thinking tokens are already inside
  `output_tokens`; the count is kept for attribution.
- **This client has no action cache.** Every choice carries `NO_ACTION_CACHE`; a host that caches
  actions wraps the port, and records its hits in the ledger itself.
- **Prose where JSON was promised is a `ModelSchemaError`, never an empty object.** An empty
  extraction is indistinguishable from a page that genuinely had nothing on it.
- **A supplied extraction allowance bounds request text, not the bill.** `extract.maxUsd`
  becomes an input-token allowance at the selected model's rate, with an intentional
  5,000-token floor. UTF-8 bytes conservatively bound supplied text; system, instructions,
  schema, cut notices and correction suffixes are included. A schema correction reselects
  from the original page with its suffix reserved. Provider-added framing and the summed
  cost of correction attempts are not claimed as bounded by this text ceiling. Cuts are
  explicit in the model prompt and returned metadata; unbounded callers stay unbounded.
- **A refused ACTION reply is told what was wrong and asked again, inside the same step.**
  `ModelSchemaError.violations` is one line per fault, written for this reader — "ref must be a
  frame-qualified NodeRef from nodeRef(frameOrdinal, backendNodeId), got
  {"frameOrdinal":0,"backendNodeId":0}" — and `choose` appends them to the prompt and re-asks, at
  most `MAX_SCHEMA_CORRECTIONS` times. It costs no step: `perform` has not been called, the page
  is still frozen and every `ref` in the prompt is still valid. **This is not the retry
  `@outcrawl/captcha`'s solver refuses** ("A REPEATED FAILURE AT TEMPERATURE ZERO CANNOT BE
  RETRIED") — that rule is about re-asking UNCHANGED input, and the next ask here carries the
  violation. Two bounds end it, both with the reason on the error: the SAME violations twice (the
  model read the correction and did not act on it, so the input is unchanged after all) and the
  count. Either way the STEP fails and `stepFailures` absorbs it; the run is not ended by a
  correctable mistake. Measured cause: `run_58b17565-02be-4973-9552-f07fab6331d8` lost a
  customer's task, 2.7202 credits and 11 steps because six of those steps died of a violation the
  model was never shown.
- **A failed call that was billed is still recorded.** A policy refusal and a reply truncated at
  `max_tokens` both cost tokens. `CallOutcome` separates `ok`, `hit`, `unusable`, `schema`,
  `provider` and `timeout`, and `billed` distinguishes the failures that cost money.
- **A cache hit is recorded as a call that cost nothing, not as an absence.** An absent entry is
  indistinguishable from a call that never happened for any other reason. (`hit` is the host
  cache's outcome; this client never writes it.)
- **Ledger totals are accumulated, never derived.** `entries` is bounded, and the running totals
  are updated on the way in so they stay exact after detail has been dropped.
- **The key is injected, never read here and never logged.**

## Testing

```sh
cd packages/model
bun test ./test
```

The offline suite is the whole suite. Checks against real providers, real keys and the
production rate card live with the host's plan, not here.

## Gaps

- **A verb in `ACTION_TYPES` is not emittable until every field of its `Action` member is named in
  `ACTION_SCHEMA`, and nothing checks that.** The schema is a literal and the action union is a
  type, so the two can disagree silently — and have, twice. First `focusTab`/`closeTab` with no
  `tab` property (that comment is still in `src/client.ts`); then on 2026-09-08 `attachFile`, `ask`
  and `callTool` with no `file`, `question`, `options`, `tool` or `arguments`, which cost three
  whole features at once: each had a working route, a working verb and a green suite, and nothing
  the MODEL did could reach any of them. Under `additionalProperties: false` plus the provider's
  `strict: true`, a property this object does not name cannot appear in a reply at all, so the model
  read a grammar telling it to attach a file, could not produce one, and spent the step being told
  "file must be a non-empty string". **No test in this repository can see this class of defect**:
  every suite drives `validateAction` with an object it built itself, so none of them asks the
  provider to compile the schema. Both were found by reading the schema against `ACTION_TYPES`.
- **`src/schema.ts`'s transcription describes one provider's documented contract, not what our
  wire enforces — measured, because it predicts a total outage that does not happen.** That file
  quotes `additionalProperties` "set to anything other than `false`" as unsupported and a
  documented 400, and `arguments` in the reply schema is deliberately `{ type: 'object',
  additionalProperties: true }` because a remote tool's argument object is the REMOTE server's
  schema and cannot be enumerated here. Read together, those two facts predict that every action
  call 400s. They do not: `POST /chat/completions` with `strict: true` and this exact schema
  answered **HTTP 200 on all three models of the production actuator chain** (ranks 0, 1 and 2),
  measured 2026-09-08, n=3. `required: ['type']` passed on the same three calls, so strict mode
  as these models implement it does not demand that every property be required either. Both are
  **tolerated, not guaranteed**: the transcription is right about its source and wrong as a
  prediction about the gateway, and neither observation transfers to routing actions at another
  provider directly. Note also that `AGENT_REPLY_SCHEMA` does not pass through `constrainSchema`
  — only a caller's extract schema does — so nothing rewrites it on the way out.
- **This client does not convert USD to credits, by design (W44, 2026-09-25).** The plan tiers carry a volume discount, so one process-wide rate would be wrong for two tiers out of three. The run's own `CapLedger` in `@outcrawl/runtime` does it instead: `ModelBinder.costUsd` (the ledger total above) x `MODEL_MARKUP` (1.70), at the run's plan price per credit from `PLAN_PRICES` in `@outcrawl/core` (`modelCredits`; Free at the Builder price, zero on the customer's own key), and `AgentCaps.budget` holds the run against that figure along with browser time and bandwidth. A monitor check's judge is billed the same way at the monitor's plan.
