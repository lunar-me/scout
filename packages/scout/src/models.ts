/**
 * The caller's models, per role, as the agent loop's `ModelPort` and the
 * binding's `page.look` vision: the same `HarnessModelPort` and `ModelPageLook`
 * the hosted agent runs, built from a plan the caller wrote rather than one a
 * host injects.
 */
import {
  ChatCompletionsProvider,
  CostLedger,
  HarnessModelPort,
  ModelClient,
  ModelPageLook,
  ModelProviderError,
  type ModelPlan,
  type ModelProvider,
  type PlanModel,
  type RateCard,
} from '@outcrawl/model';
import type { LookVision, ModelPort } from '@outcrawl/runtime';

import { DEFAULT_STRUCTURED_OUTPUT, type Role, type RoleModel, type ScoutLogger, type ScoutModels } from './options';

/** What a run's models are, bound to one run. */
export interface RunModels {
  readonly port: ModelPort;
  readonly look: LookVision | undefined;
  /** USD every model call of the run cost so far, or `undefined` when some call's price is not known. */
  costUsd(): string | undefined;
}

/**
 * A role's endpoint as a chat-completions provider. Its ledger name is the
 * endpoint's host.
 *
 * A 400 on a call that asked for a structured reply is most often the
 * endpoint not supporting that way of asking, so its error names the role and
 * the option that changes it. It is not retried in another mode: the caller
 * decides which mode their endpoint takes.
 */
function providerFor(
  name: Role,
  role: RoleModel,
  rates: RateCard | undefined,
  onUnpriced: (model: string) => void,
): ModelProvider {
  const base = role.baseURL.replace(/\/+$/u, '');
  const mode = role.structuredOutput ?? DEFAULT_STRUCTURED_OUTPUT;
  const provider = new ChatCompletionsProvider({
    name: new URL(base).host,
    url: `${base}/chat/completions`,
    apiKey: role.apiKey,
    ...(role.headers === undefined ? {} : { headers: role.headers }),
    outputMode: () => mode,
    ...(rates === undefined ? {} : { rates }),
    // The endpoint stated no cost for a call. With a rate card the call is
    // priced from it; without one its cost is unknown, and the run says so
    // rather than reporting a total that reads as complete.
    onCostFallback: (event) => {
      if (event.source === 'estimate' && rates?.[event.model] === undefined) onUnpriced(event.model);
    },
  });
  const others = (['tool_choice', 'json_object', 'strict'] as const).filter((other) => other !== mode);
  return {
    name: provider.name,
    complete: async (request) => {
      try {
        return await provider.complete(request);
      } catch (error) {
        if (!(error instanceof ModelProviderError) || error.status !== 400 || request.schema === undefined) throw error;
        const said = error.message.replace(/^model provider refused \([^)]*\): /u, '');
        throw new ModelProviderError({
          status: error.status,
          providerCode: error.providerCode,
          message:
            `${said}. The ${name} model (${role.model}) was asked for a structured reply in '${mode}' mode and the ` +
            `endpoint refused it; if the endpoint does not support that mode, set models.${name}.structuredOutput ` +
            `to '${others[0] ?? ''}' or '${others[1] ?? ''}'`,
          retryable: error.retryable,
          upstreamStatus: error.upstreamStatus,
          ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
          ...(error.costUsd === '0' ? {} : { costUsd: error.costUsd }),
        });
      }
    },
  };
}

function planModel(role: RoleModel): PlanModel {
  return {
    model: role.model,
    rank: 0,
    callsPerStep: 1,
    replyReasoning: true,
    ...(role.effort === undefined ? {} : { effort: role.effort }),
  };
}

export interface ModelBuildOptions {
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly logger?: ScoutLogger;
}

export function buildModels(models: ScoutModels, options: ModelBuildOptions): RunModels {
  const rates = models.rates;
  const ledger = new CostLedger();
  const session = { sessionId: options.runId, accountId: null };
  const unpriced = new Set<string>();
  const onUnpriced = (model: string): void => {
    if (!unpriced.has(model)) {
      unpriced.add(model);
      options.logger?.warn('scout.cost_unknown', {
        model,
        why: 'the endpoint stated no cost for a call and models.rates has no price for this model',
      });
    }
  };
  const provider = (name: Role, role: RoleModel): ModelProvider => providerFor(name, role, rates, onUnpriced);

  const hands = models.hands;
  const handsProvider = provider('hands', hands);
  const brain = models.brain;
  const plan: ModelPlan = {
    actuators: [planModel(hands)],
    ...(brain === undefined ? {} : { brain: planModel(brain) }),
  };
  const harness = new HarnessModelPort({
    plan,
    // The brain is always asked through the port's own provider, so with a
    // brain that is the brain's endpoint and the hands model is routed to its
    // own through `providerFor`.
    provider: brain === undefined ? handsProvider : provider('brain', brain),
    providerFor: (model) => (model === hands.model ? handsProvider : undefined),
    session,
    ledger,
    ...(rates === undefined ? {} : { rates }),
    ...(hands.effort === undefined ? {} : { actionReasoning: { effort: hands.effort } }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const extract = models.extract;
  const extractor =
    extract === undefined
      ? undefined
      : new ModelClient({
          provider: provider('extract', extract),
          model: extract.model,
          extractModel: extract.model,
          session,
          ledger,
          ...(rates === undefined ? {} : { rates }),
          ...(extract.effort === undefined ? {} : { extractReasoning: { effort: extract.effort } }),
        });
  const port: ModelPort =
    extractor === undefined
      ? harness
      : {
          choose: (prompt) => harness.choose(prompt),
          extract: (input) => extractor.extract(input, options.signal === undefined ? {} : { signal: options.signal }),
          suggestSchema: (task) => harness.suggestSchema(task),
        };

  const eyes = models.eyes;
  const look =
    eyes === undefined
      ? undefined
      : new ModelPageLook({
          provider: provider('eyes', eyes),
          model: eyes.model,
          ledger,
          session,
          ...(rates === undefined ? {} : { rates }),
        });

  return {
    port,
    look,
    costUsd: () => (unpriced.size > 0 ? undefined : ledger.totalsFor(options.runId).costUsd),
  };
}
