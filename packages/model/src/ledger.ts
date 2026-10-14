/**
 * The cost ledger: every model call, priced, attributable to a session.
 *
 * This exists from the first commit rather than being added later, and that is a
 * decision taken with evidence. The captcha provider layer shipped without one
 * and spent a day billing solves to the wrong API before anybody could say which
 * vendor had been paid what; the fix was a `CostRecord` per attempt with the
 * rate-card figure and the vendor's own figure side by side. Model tokens are
 * the same kind of cost centre, only larger and per-step, so the same shape
 * applies from the start.
 *
 * Three properties are load-bearing:
 *
 * **A failed call that was billed is still recorded.** A policy refusal and a
 * reply truncated at `max_tokens` both cost tokens — the provider documents that
 * a refusal is a 200 and "You'll be billed for the tokens generated". A ledger
 * that only counted successes would understate spend precisely on the runs that
 * went wrong, which is where a cost investigation starts.
 *
 * **A cache hit is recorded as a call that cost nothing.** Not as an absence.
 * The hit rate is the number that says whether the action cache is earning its
 * keep, and an absent entry is indistinguishable from a call that never happened
 * for any other reason.
 *
 * **Totals are accumulated, not derived.** `entries` is bounded, because a
 * worker process handling thousands of sessions cannot hold every call forever;
 * the running totals are updated on the way in and stay exact after detail has
 * been dropped. A bounded log with exact totals is honest. An unbounded one is a
 * leak, and a log that drops entries *and* recomputes totals from what is left
 * silently under-reports.
 */

import { ZERO_CREDITS, addDecimal, systemWallClock, type Timestamp, type WallClock } from '@outcrawl/scout-core';

import {
  ModelCancelledError,
  ModelError,
  ModelSchemaError,
  ModelTimeoutError,
  ModelUnusableError,
  ZERO_TOKENS,
  requestIdOf,
  type CostSource,
  type ModelProvider,
  type TokenUsage,
} from './provider';

/**
 * What the call was for, because each has a different fix. `look` is the
 * text-only actuator asking a cheap vision model about a screenshot
 * (`./look`): part of what an agent run cost, so it belongs in this ledger.
 *
 * `learn` is the post-run site-skill learner (`@outcrawl/worker`'s
 * `skill-learner.ts`), and it is OURS, not the run's: it is recorded under a
 * session key no customer session carries, so {@link CostLedger.totalsFor} on
 * the run's own id — what the run is billed from — never includes it.
 */
export type CallPurpose = 'action' | 'extract' | 'look' | 'learn';

/**
 * How the call ended. `ok` and `hit` are both successes; the rest are failures,
 * and `billed` distinguishes the failures that cost money from the ones that did
 * not, which is the only distinction a bill cares about. `cancelled` is a call
 * withdrawn before it answered — a hedge's loser, or the run's cancel:
 * unbilled to the run, like a timeout, because nothing came back to bill from.
 * What the provider charged us for it is house spend, reported outside this
 * ledger (`ModelClientOptions.onWithdrawn`).
 */
export type CallOutcome = 'ok' | 'hit' | 'unusable' | 'schema' | 'provider' | 'timeout' | 'cancelled';

export interface CostEntry {
  readonly at: Timestamp;
  /**
   * Whose session. The unit a cost is attributed to.
   *
   * The router's `sess_…`, carried unchanged from the edge — see
   * {@link SessionAttribution} in `./client` for why it must be that string
   * and nothing locally minted. This is the join key: the same id names this
   * entry, the `usage_events` rows the request wrote, the worker's
   * `api.request` and `cdp.session_open` lines, and the browser-concurrency
   * lease.
   */
  readonly sessionId: string;
  /** `null` for a run with no account — a local probe, a smoke test. */
  readonly accountId: string | null;
  readonly provider: string;
  readonly model: string;
  readonly purpose: CallPurpose;
  readonly outcome: CallOutcome;
  readonly usage: TokenUsage;
  /**
   * Exact decimal USD. The provider's own figure unless {@link costSource} is
   * `estimate`, which is the list price for a call the provider never priced.
   */
  readonly costUsd: string;
  /** Where {@link costUsd} came from. See `CostSource` in `./provider`. */
  readonly costSource: CostSource;
  /** Wall time inside the provider call. Monotonic clock, so a real duration. */
  readonly elapsedMs: number;
  /**
   * The PROVIDER's id for this call, off the `request-id` response header.
   *
   * Theirs, not ours, and the distinction matters: it is what a support ticket
   * with the provider quotes, and it correlates nothing of ours. Absent when
   * the response carried no header — a cache hit, a timeout before the
   * response, a provider that stopped sending it. `sessionId` above is the id
   * that joins our hops; this one joins to somebody else's logs.
   */
  readonly requestId?: string;
}

/** Totals for a scope: the whole ledger, or one session. */
export interface CostTotals {
  readonly calls: number;
  /** Action-cache hits. Included in `calls`; cost `'0'` by construction. */
  readonly hits: number;
  /** Calls that reached a provider and were billed, successful or not. */
  readonly billed: number;
  readonly usage: TokenUsage;
  /** Exact decimal USD. */
  readonly costUsd: string;
  /**
   * The part of {@link costUsd} recorded at `costSource: 'estimate'`: list
   * price, not the provider's figure. `'0'` when every figure was the
   * provider's, which is the normal case.
   */
  readonly estimatedUsd: string;
  /**
   * Calls a FLAT-RATE provider answered or refused (OC-286), included in
   * {@link calls}: one named in `CostLedgerOptions.flatRateProviders`. They
   * drew on a flat-rate subscription, not on a metered key. `0` for every
   * customer run.
   */
  readonly subscriptionCalls: number;
  /**
   * The part of {@link costUsd} recorded at `costSource: 'subscription'`: a
   * WOULD-BE list price nothing billed per call, counted so the run's caps
   * bind as on a metered key. `'0'` for every customer run.
   */
  readonly subscriptionUsd: string;
}

const NO_TOTALS: CostTotals = {
  calls: 0,
  hits: 0,
  billed: 0,
  usage: ZERO_TOKENS,
  costUsd: ZERO_CREDITS,
  estimatedUsd: ZERO_CREDITS,
  subscriptionCalls: 0,
  subscriptionUsd: ZERO_CREDITS,
};

export interface CostLedgerOptions {
  /**
   * How many entries of detail to keep. Totals are unaffected. Default 1024:
   * enough to explain a long agent run in full, small enough that a worker
   * holding one per session does not grow without bound.
   */
  readonly maxEntries?: number;
  readonly wallClock?: WallClock;
  /**
   * Provider names (`ModelProvider.name`) that bill a flat-rate subscription
   * rather than per call, counted in `CostTotals.subscriptionCalls`. Default
   * none.
   */
  readonly flatRateProviders?: readonly string[];
}

function sumTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export class CostLedger {
  readonly #entries: CostEntry[] = [];
  readonly #maxEntries: number;
  readonly #wallClock: WallClock;
  readonly #flatRateProviders: readonly string[];
  /** Per session, so a session's spend is one lookup rather than a scan. */
  readonly #bySession = new Map<string, CostTotals>();
  #totals: CostTotals = NO_TOTALS;

  constructor(options: CostLedgerOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 1024;
    this.#wallClock = options.wallClock ?? systemWallClock;
    this.#flatRateProviders = options.flatRateProviders ?? [];
  }

  /**
   * Record one call. Takes everything but the timestamp, which is the ledger's
   * to mint — an entry whose caller chose its own `at` cannot be ordered against
   * the others.
   */
  record(entry: Omit<CostEntry, 'at'>): CostEntry {
    const stored: CostEntry = { at: new Date(this.#wallClock.now()).toISOString(), ...entry };
    this.#entries.push(stored);
    if (this.#entries.length > this.#maxEntries) {
      this.#entries.shift();
    }

    const billed = stored.outcome !== 'hit' && stored.outcome !== 'timeout' && stored.outcome !== 'cancelled' ? 1 : 0;
    const subscription = this.#flatRateProviders.includes(stored.provider);
    const advance = (from: CostTotals): CostTotals => ({
      calls: from.calls + 1,
      hits: from.hits + (stored.outcome === 'hit' ? 1 : 0),
      billed: from.billed + billed,
      usage: sumTokens(from.usage, stored.usage),
      costUsd: addDecimal(from.costUsd, stored.costUsd),
      estimatedUsd:
        stored.costSource === 'estimate' ? addDecimal(from.estimatedUsd, stored.costUsd) : from.estimatedUsd,
      subscriptionCalls: from.subscriptionCalls + (subscription ? 1 : 0),
      subscriptionUsd:
        stored.costSource === 'subscription' ? addDecimal(from.subscriptionUsd, stored.costUsd) : from.subscriptionUsd,
    });

    this.#totals = advance(this.#totals);
    this.#bySession.set(stored.sessionId, advance(this.#bySession.get(stored.sessionId) ?? NO_TOTALS));
    return stored;
  }

  /** Most recent last. Bounded by `maxEntries`. */
  entries(): readonly CostEntry[] {
    return [...this.#entries];
  }

  totals(): CostTotals {
    return this.#totals;
  }

  /**
   * One session's spend. Zeroes for a session nobody has recorded, rather than
   * `undefined`: "this session cost nothing yet" is the true answer, and a
   * caller forced to handle `undefined` will default it to zero anyway.
   */
  totalsFor(sessionId: string): CostTotals {
    return this.#bySession.get(sessionId) ?? NO_TOTALS;
  }

  /** Sessions this ledger has seen, in first-seen order. */
  sessions(): readonly string[] {
    return [...this.#bySession.keys()];
  }

  /**
   * One line per session, for a log or an operator surface. Costs are printed at
   * full precision on purpose: an agent step can cost $0.00004 and a line that
   * rounded it to the cent would read `$0.00` for the whole run.
   */
  describe(): string {
    const lines: string[] = [];
    for (const [sessionId, totals] of this.#bySession) {
      lines.push(
        `${sessionId} calls=${String(totals.calls)} hits=${String(totals.hits)} ` +
          `billed=${String(totals.billed)} in=${String(totals.usage.inputTokens)} ` +
          `cached=${String(totals.usage.cacheReadTokens)} out=${String(totals.usage.outputTokens)} ` +
          `cost=$${totals.costUsd}` +
          (totals.estimatedUsd === ZERO_CREDITS ? '' : ` estimated=$${totals.estimatedUsd}`) +
          (totals.subscriptionCalls === 0 ? '' : ` subscription=${String(totals.subscriptionCalls)}`) +
          (totals.subscriptionUsd === ZERO_CREDITS ? '' : ` subscriptionUsd=$${totals.subscriptionUsd}`),
      );
    }
    return lines.join('\n');
  }
}

/** How a thrown model call ended, for a ledger entry. */
export function callOutcomeOf(thrown: unknown): CallOutcome {
  if (thrown instanceof ModelTimeoutError) {
    return 'timeout';
  }
  if (thrown instanceof ModelCancelledError) {
    return 'cancelled';
  }
  if (thrown instanceof ModelSchemaError) {
    return 'schema';
  }
  if (thrown instanceof ModelUnusableError) {
    return 'unusable';
  }
  // Anything else that reached here is a provider failure, including a thrown
  // value that is not an Error at all: an injected provider is someone else's
  // code, and "it threw a string" must still land in the ledger as a call.
  return 'provider';
}

/**
 * One provider call as {@link reportingProvider} reports it: a ledger entry
 * without the three fields only the CALLER knows — whose session, whose
 * account, and what the call was for.
 */
export type ProviderCall = Omit<CostEntry, 'at' | 'sessionId' | 'accountId' | 'purpose'>;

/**
 * `provider`, reporting every call it makes at the provider's own USD.
 *
 * For the callers that talk to a {@link ModelProvider} directly rather than
 * through `ModelClient`, and so wrote NO ledger entry and no usage row: the
 * site-skill learner and the captcha vision seams (`ModelWidgetVision`,
 * `ModelFractionVision`). Wrapping the provider rather than each caller is what
 * makes the report cover every call those callers will ever make — a new
 * vision seam built on the same provider is reported without anyone
 * remembering to.
 *
 * A FAILED CALL IS REPORTED TOO, at the cost its error carries
 * (`ModelError.costUsd`), exactly as `ModelClient` records one: a refusal or a
 * truncation is a 200 the provider bills, and a report of successes only would
 * understate spend on precisely the calls that went wrong. A timeout or a
 * transport failure carries `'0'` and is reported at `'0'`; what to do with a
 * zero is the caller's decision. The error is rethrown unchanged.
 *
 * `onCall` runs synchronously on the call's path and must not throw: it is a
 * report, and a solve or a learner call must not fail because a report could
 * not be written.
 */
export function reportingProvider(provider: ModelProvider, onCall: (call: ProviderCall) => void): ModelProvider {
  return {
    name: provider.name,
    complete: async (request) => {
      const started = performance.now();
      try {
        const response = await provider.complete(request);
        onCall({
          provider: provider.name,
          model: request.model,
          outcome: 'ok',
          usage: response.usage,
          costUsd: response.costUsd,
          costSource: response.costSource,
          elapsedMs: performance.now() - started,
          ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
        });
        return response;
      } catch (thrown) {
        const failed = thrown instanceof ModelError ? thrown : undefined;
        onCall({
          provider: provider.name,
          model: request.model,
          outcome: callOutcomeOf(thrown),
          usage: failed?.usage ?? ZERO_TOKENS,
          costUsd: failed?.costUsd ?? ZERO_CREDITS,
          costSource: failed?.costSource ?? 'provider',
          elapsedMs: performance.now() - started,
          ...requestIdOf(thrown),
        });
        throw thrown;
      }
    },
  };
}
