/**
 * The hedge (`HarnessPortOptions.hedgeMs`): the same model asked again beside
 * a slow call, first valid answer wins, the loser withdrawn — and the bill.
 *
 * Every provider call here is held open until the test settles it, and time
 * moves only when the test moves it, so each case states exactly which call
 * answered when. `FakeProvider` answers at once and `VirtualClock` jumps every
 * deadline, which is right for the chain's own tests and cannot express "the
 * primary is still thinking when the threshold passes".
 */

import { describe, expect, test } from 'bun:test';
import { compareDecimal, type Clock } from '@outcrawl/scout-core';
import { runAgent, type AgentDeps } from '@outcrawl/runtime';

import type { ModelCallEvent, WithdrawnCall } from '../src/client';
import {
  HarnessModelPort,
  MODEL_HEDGE_ENV,
  modelHedgeMsFrom,
  type FailoverEvent,
  type ModelPlan,
} from '../src/harness';
import { CostLedger } from '../src/ledger';
import {
  ModelCancelledError,
  ModelConfigError,
  ModelProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from '../src/provider';
import { VirtualClock, cartPage, clickReply, promptFor, refOf, thrownBy } from './support';

const SESSION = { sessionId: 'job_hedge', accountId: 'acct_hedge' } as const;
const HANDS = 'hands-model';
const FALLBACK = 'hands-fallback';
const HEDGE_MS = 4_000;
/** Rank 0's measured action deadline and extraction hedge threshold. */
const ACTION_DEADLINE_MS = 12_000;
const EXTRACT_HEDGE_MS = 15_000;

/** The actuator chain the hedge races: no brain, no planner. */
const CHAIN: ModelPlan = {
  actuators: [
    {
      model: HANDS,
      rank: 0,
      callsPerStep: 1,
      actionDeadlineMs: ACTION_DEADLINE_MS,
      extractHedgeMs: EXTRACT_HEDGE_MS,
      replyReasoning: true,
    },
    { model: FALLBACK, rank: 1, callsPerStep: 1, replyReasoning: true },
    { model: 'hands-fallback-2', rank: 2, callsPerStep: 1, replyReasoning: true },
  ],
};

/** One held call: settle it from the test. Honours the signal as the real transport does. */
interface HeldCall {
  readonly model: string;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (response: ModelResponse) => void;
  readonly reject: (error: unknown) => void;
}

class HeldProvider implements ModelProvider {
  readonly name = 'held';
  readonly calls: HeldCall[] = [];

  complete(request: ModelRequest): Promise<ModelResponse> {
    const { promise, resolve, reject } = Promise.withResolvers<ModelResponse>();
    // What `chat-completions.ts` does when `http.ts` reports a caller abort.
    request.signal?.addEventListener('abort', () => reject(new ModelCancelledError()), { once: true });
    this.calls.push({ model: request.model, signal: request.signal, resolve, reject });
    return promise;
  }
}

/** Sleeps that end only when the test advances past them. */
class HeldClock implements Clock {
  #now = 0;
  readonly #timers: { readonly at: number; readonly resolve: () => void }[] = [];

  now(): number {
    return this.#now;
  }

  sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#timers.push({ at: this.#now + ms, resolve });
    return promise;
  }

  async advance(ms: number): Promise<void> {
    this.#now += ms;
    for (const timer of this.#timers.filter((each) => each.at <= this.#now)) {
      timer.resolve();
    }
    await drain();
  }
}

/**
 * Every continuation queued so far, run. A zero-delay macrotask, not a wait on
 * real time: the port's own promise chain is several microtasks deep per
 * settlement, and yielding once to the event loop runs all of them.
 */
async function drain(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  await promise;
}

function hedgedPort(hedgeMs: number | undefined, signal?: AbortSignal): {
  port: HarnessModelPort;
  provider: HeldProvider;
  clock: HeldClock;
  ledger: CostLedger;
  failovers: FailoverEvent[];
  calls: ModelCallEvent[];
  resends: unknown[];
  withdrawn: WithdrawnCall[];
} {
  const provider = new HeldProvider();
  const clock = new HeldClock();
  const ledger = new CostLedger();
  const failovers: FailoverEvent[] = [];
  const calls: ModelCallEvent[] = [];
  const resends: unknown[] = [];
  const withdrawn: WithdrawnCall[] = [];
  const port = new HarnessModelPort({
    plan: CHAIN,
    provider,
    session: SESSION,
    ledger,
    clock,
    onFailover: (event) => failovers.push(event),
    onCall: (event) => calls.push(event),
    onResend: (event) => resends.push(event),
    onWithdrawn: (call) => withdrawn.push(call),
    ...(hedgeMs === undefined ? {} : { hedgeMs }),
    ...(signal === undefined ? {} : { signal }),
  });
  return { port, provider, clock, ledger, failovers, calls, resends, withdrawn };
}

const page = cartPage(40_000);
const checkout = refOf(page, 'Checkout');

/** A 503 the chain demotes on. */
const upstreamDown = (): ModelProviderError =>
  new ModelProviderError({ status: 503, providerCode: 'unavailable', message: 'upstream down', retryable: true });

const cartTotal = (costUsd = '0'): ModelResponse => ({
  text: JSON.stringify({ data: '£42.00' }),
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  costUsd,
  costSource: 'provider',
  stopReason: 'stop',
});

describe('the hedge', () => {
  test('off by default: a slow primary is waited on, and nothing else is asked', async () => {
    const { port, provider, clock } = hedgedPort(undefined);
    const step = port.choose(promptFor(page));
    await drain();
    // Under rank 0's 12 s action deadline, past any hedge threshold a test here uses.
    await clock.advance(11_000);
    expect(provider.calls.map((call) => call.model)).toEqual([HANDS]);
    provider.calls[0]?.resolve(clickReply(checkout));
    expect((await step).modelRank).toBe(0);

    const extraction = port.extract({ instruction: 'the total', schema: null, content: { kind: 'markdown', markdown: '# Cart' } });
    await drain();
    await clock.advance(30_000);
    expect(provider.calls.map((call) => call.model)).toEqual([HANDS, HANDS]);
    provider.calls[1]?.resolve(cartTotal());
    expect((await extraction).data).toBe('£42.00');
  });

  test('a primary that answers inside the threshold is never hedged', async () => {
    const { port, provider, clock } = hedgedPort(HEDGE_MS);
    const step = port.choose(promptFor(page));
    await drain();
    provider.calls[0]?.resolve(clickReply(checkout, {}, '0.0003'));
    const choice = await step;
    await clock.advance(HEDGE_MS);

    expect(choice.modelRank).toBe(0);
    expect(provider.calls.map((call) => call.model)).toEqual([HANDS]);
  });

  /**
   * OC-240, `run_d26506d1` (2026-09-30): the hedge went to rank 1 and one
   * hedged step cost 2.55 credits of a 3.00 budget — ~16x a rank-0 hands call
   * (median, n=197). MUTATION THIS CATCHES: the second ask going to any model
   * but the primary's, or a hedge win demoting the chain.
   */
  test('a slow primary is hedged with the SAME model; the hedge answers first, the primary is withdrawn: the run pays the primary\'s price once, the house the loser', async () => {
    const { port, provider, clock, ledger, failovers, calls, withdrawn } = hedgedPort(HEDGE_MS);
    const step = port.choose(promptFor(page));
    await drain();
    await clock.advance(HEDGE_MS - 1);
    expect(provider.calls.map((call) => call.model)).toEqual([HANDS]);
    await clock.advance(1);
    expect(provider.calls.map((call) => call.model)).toEqual([HANDS, HANDS]);

    provider.calls[1]?.resolve(clickReply(checkout, { inputTokens: 900 }, '0.0003'));
    const choice = await step;
    await drain();

    expect(choice.action).toEqual({ type: 'click', ref: checkout });
    expect(choice.modelRank).toBe(0);
    // Withdrawn, so it stops costing: the transport saw the abort.
    expect(provider.calls[0]?.signal?.aborted).toBe(true);
    // The winner at its stated price, the loser at zero — exactly what was
    // spent, as the ledger the run is charged from sees it.
    expect(ledger.totalsFor(SESSION.sessionId)).toMatchObject({ calls: 2, billed: 1, costUsd: '0.0003' });
    expect(calls.map((call) => [call.model, call.hedge, call.outcome, call.costUsd]).sort()).toEqual([
      [HANDS, false, 'cancelled', '0'],
      [HANDS, true, 'ok', '0.0003'],
    ]);
    // ...and OURS at an estimate: the gateway bills a withdrawn non-streaming
    // call in full, so it is house spend, reported once and never on the
    // ledger the run is charged from.
    expect(withdrawn.map((call) => [call.model, call.purpose, call.hedge, call.outcome, call.costSource])).toEqual([
      [HANDS, 'action', false, 'cancelled', 'estimate'],
    ]);
    expect(compareDecimal(withdrawn[0]?.costUsd ?? '0', '0')).toBe(1);
    // The primary's own model answered: nothing was demoted.
    expect(failovers).toEqual([]);
  });

  test('a hedge win never demotes: every step starts on the primary and is hedged again', async () => {
    const { port, provider, clock, failovers } = hedgedPort(HEDGE_MS);
    for (let round = 0; round < 3; round += 1) {
      const step = port.choose(promptFor(page));
      await drain();
      await clock.advance(HEDGE_MS);
      provider.calls.at(-1)?.resolve(clickReply(checkout));
      expect((await step).modelRank).toBe(0);
    }
    expect(provider.calls.map((call) => call.model)).toEqual(Array.from({ length: 6 }, () => HANDS));
    expect(failovers).toEqual([]);
  });

  test('a primary that answers after the hedge started still wins, and the hedge is withdrawn', async () => {
    const { port, provider, clock, ledger, failovers, withdrawn } = hedgedPort(HEDGE_MS);
    const step = port.choose(promptFor(page));
    await drain();
    await clock.advance(HEDGE_MS);

    provider.calls[0]?.resolve(clickReply(checkout, {}, '0.0003'));
    const choice = await step;
    await drain();

    expect(choice.modelRank).toBe(0);
    expect(provider.calls[1]?.signal?.aborted).toBe(true);
    expect(ledger.totalsFor(SESSION.sessionId)).toMatchObject({ calls: 2, billed: 1, costUsd: '0.0003' });
    expect(failovers).toEqual([]);
    // The withdrawn hedge is house spend, as a withdrawn primary is.
    expect(withdrawn.map((call) => [call.model, call.hedge])).toEqual([[HANDS, true]]);
  });

  test('a primary that fails over mid-hedge withdraws the hedge and goes down the chain as an unhedged call does', async () => {
    const { port, provider, clock, failovers } = hedgedPort(HEDGE_MS);
    const step = port.choose(promptFor(page));
    await drain();
    await clock.advance(HEDGE_MS);

    provider.calls[0]?.reject(upstreamDown());
    await drain();
    expect(provider.calls[1]?.signal?.aborted).toBe(true);
    expect(provider.calls.map((call) => call.model)).toEqual([HANDS, HANDS, FALLBACK]);
    provider.calls[2]?.resolve(clickReply(checkout));

    expect((await step).modelRank).toBe(1);
    expect(failovers.map((event) => [event.from, event.to, event.trigger])).toEqual([
      [HANDS, FALLBACK, 'provider-fault'],
    ]);
  });

  /**
   * A stall on both arms gives up at the primary's own deadline, not at the
   * hedge's: MUTATION THIS CATCHES waiting out the hedge arm's full deadline
   * after the primary's has passed.
   */
  test('a call that stalls on both arms gives up at the primary\'s deadline, as a lone stall', async () => {
    const { port, provider, clock, failovers } = hedgedPort(HEDGE_MS);
    const step = port.choose(promptFor(page));
    await drain();
    await clock.advance(HEDGE_MS);
    await clock.advance(ACTION_DEADLINE_MS - HEDGE_MS - 1);
    expect(provider.calls.map((call) => call.model)).toEqual([HANDS, HANDS]);
    await clock.advance(1);

    expect(provider.calls[1]?.signal?.aborted).toBe(true);
    expect(provider.calls.map((call) => call.model)).toEqual([HANDS, HANDS, FALLBACK]);
    provider.calls[2]?.resolve(clickReply(checkout));
    expect((await step).modelRank).toBe(1);
    expect(failovers.map((event) => [event.trigger, event.holdMs])).toEqual([['timeout', 0]]);
  });

  test('a primary failure no rank fixes is thrown as today, and the hedge withdrawn', async () => {
    const { port, provider, clock } = hedgedPort(HEDGE_MS);
    const step = port.choose(promptFor(page));
    await drain();
    await clock.advance(HEDGE_MS);

    const credential = new ModelProviderError({
      status: 401,
      providerCode: 'unauthorized',
      message: 'bad key',
      retryable: false,
    });
    provider.calls[0]?.reject(credential);

    expect(await thrownBy(step)).toBe(credential);
    expect(provider.calls[1]?.signal?.aborted).toBe(true);
  });

  test('a hedge that fails first is forgotten: the primary decides the step', async () => {
    const { port, provider, clock, failovers } = hedgedPort(HEDGE_MS);
    const step = port.choose(promptFor(page));
    await drain();
    await clock.advance(HEDGE_MS);

    provider.calls[1]?.reject(upstreamDown());
    await drain();
    provider.calls[0]?.resolve(clickReply(checkout));

    expect((await step).modelRank).toBe(0);
    expect(failovers).toEqual([]);
  });

  /**
   * The reviewer's repro (HedgeReview, 2026-09-28): the primary's transport
   * fails at 9 s and the client waits 2 s to resend; the hedge starts at 10 s
   * and answers at 10.5 s, withdrawing the primary mid-backoff. MUTATION THIS
   * CATCHES: the resend line firing when the backoff ends — in production a
   * `model.action_resent` warning for an ask that was never sent again.
   */
  test('a primary withdrawn during its resend backoff reports no resend and sends nothing', async () => {
    const { port, provider, clock, resends, ledger, withdrawn } = hedgedPort(10_000);
    const step = port.choose(promptFor(page));
    await drain();
    await clock.advance(9_000);
    provider.calls[0]?.reject(
      new ModelProviderError({ status: 0, providerCode: 'transport_error', message: 'reset', retryable: true }),
    );
    await drain();
    await clock.advance(1_000);
    expect(provider.calls.map((call) => call.model)).toEqual([HANDS, HANDS]);
    await clock.advance(500);
    provider.calls[1]?.resolve(clickReply(checkout, {}, '0.0003'));
    expect((await step).modelRank).toBe(0);

    // The primary's backoff ends after it was withdrawn.
    await clock.advance(1_000);
    expect(resends).toEqual([]);
    expect(provider.calls).toHaveLength(2);
    // The transport failure and the hedge's answer; nothing for a resend.
    expect(ledger.entries().map((entry) => [entry.model, entry.outcome])).toEqual([
      [HANDS, 'provider'],
      [HANDS, 'ok'],
    ]);
    // Withdrawn before anything was sent again, so nothing was spent on it.
    expect(withdrawn).toEqual([]);
  });

  /**
   * OC-240, the same run: one rank-0 hands extraction took 54.8 s with nothing
   * beside it. MUTATION THIS CATCHES: an extraction left unhedged, hedged at
   * the action threshold, or hedged onto another model.
   */
  test('an extraction is hedged with the same model at its own measured threshold', async () => {
    const { port, provider, clock, calls } = hedgedPort(HEDGE_MS);
    const extraction = port.extract({ instruction: 'the total', schema: null, content: { kind: 'markdown', markdown: '# Cart' } });
    await drain();
    await clock.advance(EXTRACT_HEDGE_MS - 1);
    expect(provider.calls.map((call) => call.model)).toEqual([HANDS]);
    await clock.advance(1);
    expect(provider.calls.map((call) => call.model)).toEqual([HANDS, HANDS]);

    provider.calls[1]?.resolve(cartTotal('0.0004'));
    expect((await extraction).data).toBe('£42.00');
    await drain();
    expect(provider.calls[0]?.signal?.aborted).toBe(true);
    expect(calls.map((call) => [call.purpose, call.hedge, call.outcome]).sort()).toEqual([
      ['extract', false, 'cancelled'],
      ['extract', true, 'ok'],
    ]);
  });
});

describe(`${MODEL_HEDGE_ENV}`, () => {
  test('unset, empty and 0 are off; a whole number of ms up to 60000 is on; anything else is refused', () => {
    expect(modelHedgeMsFrom({})).toBeUndefined();
    expect(modelHedgeMsFrom({ [MODEL_HEDGE_ENV]: '' })).toBeUndefined();
    expect(modelHedgeMsFrom({ [MODEL_HEDGE_ENV]: '0' })).toBeUndefined();
    expect(modelHedgeMsFrom({ [MODEL_HEDGE_ENV]: '4000' })).toBe(4_000);
    // Above the client's general call ceiling. MUTATION THIS CATCHES: accepting
    // 2^31, which `setTimeout` clamps to 1 ms — measured in Bun 1.4.0 — so an
    // operator's "effectively off" would hedge every call about 1 ms in.
    expect(modelHedgeMsFrom({ [MODEL_HEDGE_ENV]: '60000' })).toBe(60_000);
    for (const typo of ['4s', '-1', '2.5', 'on', '60001', '2147483648']) {
      expect(() => modelHedgeMsFrom({ [MODEL_HEDGE_ENV]: typo })).toThrow(ModelConfigError);
    }
  });
});

describe('a hedged step and the budget', () => {
  /**
   * BOTH ARMS PAID, THE CEILING STILL HOLDS. The two replies arrive in the same
   * tick, so neither can be withdrawn and both are billed at their stated
   * price — the worst case a hedge can produce. At cost, one arm's $0.06 is
   * 0.06 credits, inside a 0.10 ceiling; both arms are 0.12, outside it.
   */
  test('a hedged step whose both arms were paid cannot push the run over its budget', async () => {
    const { port, provider, clock, ledger } = hedgedPort(HEDGE_MS);
    const deps: AgentDeps = {
      snapshot: () => page,
      lock: () => undefined,
      unlock: () => undefined,
      perform: () => ({}),
      // Never reached: every step here is a click.
      extract: () => Promise.reject(new Error('this run does not extract')),
      model: port.choose,
      modelCostUsd: () => ledger.totalsFor(SESSION.sessionId).costUsd,
      // The RUN's clock, advanced by nobody: the budget trips on model spend.
      clock: new VirtualClock(),
    };

    const run = runAgent(deps, {
      task: 'check out',
      caps: { steps: 5, budget: '0.10', duration: '5m' },
      stepFailures: null,
      settle: false,
    });
    for (let tick = 0; tick < 50 && provider.calls.length === 0; tick += 1) {
      await drain();
    }
    await clock.advance(HEDGE_MS);
    expect(provider.calls.map((call) => call.model)).toEqual([HANDS, HANDS]);
    provider.calls[0]?.resolve(clickReply(checkout, { inputTokens: 900, outputTokens: 30 }, '0.06'));
    provider.calls[1]?.resolve(clickReply(checkout, { inputTokens: 900, outputTokens: 30 }, '0.06'));
    const result = await run;

    // Both calls were spent and both are on the record...
    expect(ledger.totalsFor(SESSION.sessionId)).toMatchObject({ calls: 2, billed: 2, costUsd: '0.12' });
    expect(result.modelCostUsd).toBe('0.12');
    // ...and the customer is charged the budget and not a credit more.
    expect(result.status).toBe('capped');
    expect(result.cappedBy).toBe('budget');
    expect(compareDecimal(result.credits, '0.10')).toBe(0);
    expect(compareDecimal(result.billedModelCostUsd, result.modelCostUsd)).toBe(-1);
    // The ceiling stopped the run: no second step was asked for.
    expect(result.steps).toHaveLength(1);
    expect(provider.calls).toHaveLength(2);
  });
});

/**
 * THE RUN'S CANCEL (`HarnessPortOptions.signal`). Production 2026-09-21..28,
 * n=35 cancels: extract steps of 65 and 157 s ran to the end after the owner
 * had asked the run to stop. A call in flight is withdrawn, is not the
 * customer's, and is not a reason to ask another rank. It is the HOUSE's:
 * the gateway bills a withdrawn non-streaming call in full, so it is reported
 * through `onWithdrawn` at an estimate (RunReview R3, 2026-09-28).
 */
describe("the run's cancel", () => {
  test('withdraws the action call in flight: billed nothing, no failover, no second rank asked', async () => {
    const stop = new AbortController();
    const { port, provider, ledger, failovers } = hedgedPort(undefined, stop.signal);
    const step = port.choose(promptFor(page));
    await drain();
    stop.abort();

    expect(await thrownBy(step)).toBeInstanceOf(ModelCancelledError);
    expect(provider.calls.map((call) => call.model)).toEqual([HANDS]);
    expect(provider.calls[0]?.signal?.aborted).toBe(true);
    expect(ledger.totalsFor(SESSION.sessionId)).toMatchObject({ billed: 0, costUsd: '0' });
    expect(failovers).toEqual([]);
  });

  test("a withdrawn call is house spend at what this session last paid for the same ask; the run's bill does not move", async () => {
    const stop = new AbortController();
    const { port, provider, ledger, withdrawn } = hedgedPort(undefined, stop.signal);
    const first = port.choose(promptFor(page));
    await drain();
    provider.calls[0]?.resolve(clickReply(checkout, { inputTokens: 900, outputTokens: 30 }, '0.0021'));
    await first;

    const second = port.choose(promptFor(page));
    await drain();
    stop.abort();
    expect(await thrownBy(second)).toBeInstanceOf(ModelCancelledError);

    // The customer: the answered call, and nothing for the withdrawn one.
    expect(ledger.totalsFor(SESSION.sessionId)).toMatchObject({ calls: 2, billed: 1, costUsd: '0.0021' });
    // The house: the withdrawn call, priced as the same ask one step earlier.
    expect(withdrawn).toMatchObject([
      {
        model: HANDS,
        purpose: 'action',
        outcome: 'cancelled',
        costUsd: '0.0021',
        costSource: 'estimate',
        basis: 'previous-call',
        usage: { inputTokens: 900, outputTokens: 30 },
      },
    ]);
  });

  test('withdraws a hedged pair together', async () => {
    const stop = new AbortController();
    const { port, provider, clock } = hedgedPort(HEDGE_MS, stop.signal);
    const step = port.choose(promptFor(page));
    await drain();
    await clock.advance(HEDGE_MS);
    stop.abort();

    expect(await thrownBy(step)).toBeInstanceOf(ModelCancelledError);
    expect(provider.calls.map((call) => call.signal?.aborted)).toEqual([true, true]);
  });

  test('withdraws the extraction in flight, which is not resent', async () => {
    const stop = new AbortController();
    const { port, provider, resends } = hedgedPort(undefined, stop.signal);
    const extraction = port.extract({
      instruction: null,
      schema: { type: 'object', required: ['ads'], properties: { ads: { type: 'array' } } },
      content: { kind: 'markdown', markdown: '# Ad Library' },
    });
    await drain();
    stop.abort();

    await thrownBy(extraction);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.signal?.aborted).toBe(true);
    expect(resends).toEqual([]);
  });
});
