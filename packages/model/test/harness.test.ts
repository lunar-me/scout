/**
 * The harness port: when it gives up on one model, and the boundary that keeps
 * the expensive model away from the page.
 *
 * Every test here names the mutation it catches. Two of them are the reason this
 * file exists rather than being folded into `client.test.ts`:
 *
 * - A failover that is invisible to the customer is also invisible to a test
 *   that only asserts "the run succeeded". The assertion has to be WHICH model
 *   answered, which is why these read `FakeProvider.requests`.
 * - The planner boundary is worth a measured 69x and is enforced by a type. A
 *   type is checked at compile time and deleted by the next person in a hurry,
 *   so the runtime consequence is asserted too: the planner's prompt does not
 *   contain the page.
 */

import { describe, expect, test } from 'bun:test';
import { ExtractionFailedError, isOutcrawlError, type Clock } from '@outcrawl/scout-core';

import { nodeRef, type StepTrace } from '@outcrawl/runtime';

import {
  FAILOVER_COOLDOWN_MS,
  HarnessModelPort,
  STALL_STEPS,
  planDigestFrom,
  shouldFailOver,
  type FailoverEvent,
  type ModelPlan,
} from '../src/harness';
import { CostLedger } from '../src/ledger';
import {
  ModelConfigError,
  ModelProviderError,
  ModelSchemaError,
  ModelTimeoutError,
  ModelUnusableError,
  ZERO_TOKENS,
  type ModelResponse,
} from '../src/provider';
import {
  FakeProvider,
  VirtualClock,
  cartPage,
  clickReply,
  promptFor,
  refOf,
  reply,
  thrownBy,
} from './support';

const SESSION = { sessionId: 'job_harness', accountId: 'acct_harness' } as const;

const HANDS = 'hands-model';
const FALLBACK = 'hands-fallback';
const FALLBACK_2 = 'hands-fallback-2';
const PLANNER = 'planner-model';

/**
 * A three-rank actuator chain with no brain and no planner, which is also what
 * a brain step falls back to. Rank 0 carries a measured 12 s action deadline;
 * the lower ranks keep the client's own ceiling.
 */
const CHAIN: ModelPlan = {
  actuators: [
    { model: HANDS, rank: 0, callsPerStep: 1, actionDeadlineMs: 12_000, replyReasoning: true },
    { model: FALLBACK, rank: 1, callsPerStep: 1, replyReasoning: true },
    { model: FALLBACK_2, rank: 2, callsPerStep: 1, replyReasoning: true },
  ],
};

/** A port over a scripted provider, with every demotion captured. */
function portFor(
  provider: FakeProvider,
  clock?: Clock,
): { port: HarnessModelPort; failovers: FailoverEvent[]; ledger: CostLedger } {
  const failovers: FailoverEvent[] = [];
  const ledger = new CostLedger();
  const port = new HarnessModelPort({
    plan: CHAIN,
    provider,
    session: SESSION,
    ledger,
    onFailover: (event) => failovers.push(event),
    ...(clock === undefined ? {} : { clock }),
  });
  return { port, failovers, ledger };
}

/**
 * Time only the test moves. A model call's deadline race and the client's
 * resend wait both resolve at once and cost no time here, so the cooldown is
 * measured in exactly the milliseconds a test advances and nothing else.
 */
class StillClock implements Clock {
  #now = 0;

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    this.#now += ms;
  }

  sleep(): Promise<void> {
    return Promise.resolve();
  }
}

/** The gateway's inline upstream fault, as production received it on 2026-09-24. */
const inline502 = (): ModelProviderError =>
  new ModelProviderError({
    status: 200,
    providerCode: 'gateway_502',
    message: 'Upstream error from provider-a',
    retryable: true,
    upstreamStatus: 502,
  });

const rateLimit = (): ModelProviderError =>
  new ModelProviderError({
    status: 429,
    providerCode: 'rate_limit_error',
    message: 'slow down',
    retryable: true,
  });

/* ------------------------------------------------------------------ *
 * The failover decision
 * ------------------------------------------------------------------ */

describe('when another model is worth asking', () => {
  /**
   * MUTATION THIS CATCHES: keying failover on `ModelProviderError.retryable`.
   *
   * That flag is right for a RETRY of the same model and wrong for a CHAIN.
   * The gateway answers 400 for an unknown model id, so a preview id withdrawn
   * under us presents as a permanent 400 on every call — non-retryable, and
   * exactly what the next rank is for. The rank-0 hands model is GA, and the
   * preview id it replaced vanished mid-measurement, which is its name, so this
   * is the live case and not a hypothetical.
   */
  test('a withdrawn model fails over even though it is not retryable', () => {
    for (const status of [400, 404]) {
      const thrown = new ModelProviderError({
        status,
        providerCode: 'invalid_request_error',
        message: 'not a valid model ID',
        retryable: false,
      });

      expect(thrown.retryable).toBe(false);
      expect(shouldFailOver(thrown)).toBe(true);
    }
  });

  test('a rate limit, a provider fault and a timeout all fail over', () => {
    expect(shouldFailOver(rateLimit())).toBe(true);
    expect(
      shouldFailOver(
        new ModelProviderError({
          status: 503,
          providerCode: 'overloaded',
          message: 'busy',
          retryable: true,
        }),
      ),
    ).toBe(true);
    expect(shouldFailOver(new ModelTimeoutError(60_000))).toBe(true);
  });

  /**
   * MUTATION THIS CATCHES: failing over on a credential or quota failure.
   *
   * Every rank shares the key and the balance, so trying two more models
   * triples the latency in front of the one error whose text tells an operator
   * what to fix — and it does it on every step of every run for as long as the
   * key is wrong.
   */
  test('a credential or quota failure does not fail over', () => {
    for (const status of [401, 402, 403]) {
      expect(
        shouldFailOver(
          new ModelProviderError({
            status,
            providerCode: 'authentication_error',
            message: 'no',
            retryable: false,
          }),
        ),
      ).toBe(false);
    }
  });

  /**
   * MUTATION THIS CATCHES: treating a refusal as a failure to fail over from.
   *
   * The model answered, the call was billed, and the answer is readable. A
   * refusal is the model's verdict on a page it could see —
   * `AgentStopReason.gave-up` exists to carry exactly that as a first-class
   * outcome — so failing over would bill twice for one answer and turn a verdict
   * into a retry loop. A schema miss is billed and readable too, and a second
   * model is as likely to miss the same grammar.
   */
  test('an answer we were billed for and can read does not fail over', () => {
    expect(shouldFailOver(new ModelUnusableError('refusal', 'I cannot', ZERO_TOKENS, '0'))).toBe(false);
    expect(shouldFailOver(new ModelSchemaError(['no actions'], '{}', ZERO_TOKENS, '0'))).toBe(false);
    expect(shouldFailOver(new ModelConfigError('our own bug'))).toBe(false);
    expect(shouldFailOver(new Error('something else'))).toBe(false);
  });

  /**
   * MUTATION THIS CATCHES: collapsing a TRUNCATION into a refusal, which is what
   * this rule did until a measured pilot caught it.
   *
   * A TRUNCATION IS NOT A REFUSAL. `finish_reason: 'length'` on a reasoning
   * model returns an EMPTY content string: the model spent its whole ceiling
   * thinking and said nothing. There is no verdict to respect, and the next
   * rank has a different reasoning ratio.
   *
   * The cost of getting this wrong was measured, not imagined: with the two
   * collapsed, a three-task pilot recorded twelve failed model calls and ZERO
   * failovers, so ranks 1 and 2 were never asked on a run that could not take a
   * single step. `HARNESS_ACTION_TOKENS` is the real fix and keeps this arm
   * cold; this is the backstop for the next model whose floor nobody measured.
   */
  test('a reply truncated before it said anything does fail over', () => {
    for (const stopReason of ['length', 'max_tokens']) {
      expect(
        shouldFailOver(new ModelUnusableError(stopReason, 'the reply was cut off', ZERO_TOKENS, '0')),
      ).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Failover, end to end
 * ------------------------------------------------------------------ */

describe('the chain in a run', () => {
  /**
   * MUTATION THIS CATCHES: catching the failure and rethrowing, or retrying the
   * same client.
   *
   * `requests[n].model` is the assertion, because the customer-visible result
   * of a successful failover is byte-identical to a run that never failed over
   * — which is the requirement, and which is why asserting the outcome proves
   * nothing.
   */
  test('a rate-limited primary is answered by the next rank, silently', async () => {
    const tree = cartPage(1);
    const provider = new FakeProvider([rateLimit(), clickReply(refOf(tree, 'Checkout'))]);
    const { port, failovers } = portFor(provider);

    const choice = await port.choose(promptFor(tree));

    expect(provider.requests.map((request) => request.model)).toEqual([HANDS, FALLBACK]);
    expect(choice.action.type).toBe('click');
    // Nothing on the wire says a failover happened: no field for it exists.
    expect(Object.keys(choice)).not.toContain('failover');
    expect(Object.keys(choice)).not.toContain('model');
    // The operator, on the other hand, is told exactly once.
    expect(failovers).toHaveLength(1);
    expect(failovers[0]?.from).toBe(HANDS);
    expect(failovers[0]?.to).toBe(FALLBACK);
    expect(failovers[0]?.trigger).toBe('rate-limit');
  });

  /**
   * MUTATION THIS CATCHES: resetting the rank per call, or promoting back to
   * rank 0 before the cooldown has passed.
   *
   * A rate limit does not clear in the seconds between two agent steps, so
   * re-asking the primary every step spends one failed call per step and
   * thrashes the model id in the action-cache key. Inside the cooldown the
   * lower rank keeps the run.
   */
  test('a demotion holds for the cooldown: the primary is not asked again inside it', async () => {
    const tree = cartPage(1);
    const ref = refOf(tree, 'Checkout');
    const provider = new FakeProvider([rateLimit(), clickReply(ref), clickReply(ref), clickReply(ref)]);
    const clock = new StillClock();
    const { port, failovers } = portFor(provider, clock);

    await port.choose(promptFor(tree, 'check out', 0));
    clock.advance(FAILOVER_COOLDOWN_MS - 1);
    await port.choose(promptFor(tree, 'check out', 1));
    await port.choose(promptFor(tree, 'check out', 2));

    expect(provider.requests.map((request) => request.model)).toEqual([
      HANDS,
      FALLBACK,
      FALLBACK,
      FALLBACK,
    ]);
    expect(failovers).toHaveLength(1);
  });

  /**
   * MUTATION THIS CATCHES: a sticky demotion. From 12Z on 2026-09-24 the
   * primary's upstream faults were brief and frequent, and rank 1 is ~17x the
   * per-minute cost, so a demotion that never recovers moves the rest of the
   * run onto the expensive model on the first double failure.
   */
  test('after the cooldown the primary is asked again, and the step records which rank answered', async () => {
    const tree = cartPage(1);
    const ref = refOf(tree, 'Checkout');
    const provider = new FakeProvider([inline502(), clickReply(ref), clickReply(ref)]);
    const clock = new StillClock();
    const { port, failovers } = portFor(provider, clock);

    const demoted = await port.choose(promptFor(tree, 'check out', 0));
    clock.advance(FAILOVER_COOLDOWN_MS);
    const recovered = await port.choose(promptFor(tree, 'check out', 1));

    expect(provider.requests.map((request) => request.model)).toEqual([
      HANDS,
      FALLBACK,
      HANDS,
    ]);
    expect([demoted.modelRank, recovered.modelRank]).toEqual([1, 0]);
    expect(failovers.map((event) => [event.to, event.trigger])).toEqual([
      [FALLBACK, 'provider-fault'],
      [HANDS, 'cooldown-elapsed'],
    ]);
  });

  /**
   * MUTATION THIS CATCHES: a fixed cooldown against an upstream that stays
   * down (one failed primary call per minute, forever), or a doubling that
   * never resets once the primary is back.
   */
  test('a failed recovery doubles the cooldown, and a good one resets it', async () => {
    const tree = cartPage(1);
    const ref = refOf(tree, 'Checkout');
    const provider = new FakeProvider([inline502(), clickReply(ref)]);
    const clock = new StillClock();
    const { port } = portFor(provider, clock);
    /** The model that answered the step: the last one asked. */
    const modelOf = async (step: number): Promise<string | undefined> => {
      await port.choose(promptFor(tree, 'check out', step));
      return provider.requests.at(-1)?.model;
    };

    await modelOf(0); // demoted at t=0, cooldown 60 s
    clock.advance(FAILOVER_COOLDOWN_MS);
    provider.push(inline502());
    provider.push(clickReply(ref));
    expect(await modelOf(1)).toBe(FALLBACK); // probe failed at t=60 s: cooldown 120 s
    clock.advance(FAILOVER_COOLDOWN_MS);
    provider.push(clickReply(ref));
    expect(await modelOf(2)).toBe(FALLBACK); // t=120 s, 60 s into 120: still demoted
    clock.advance(FAILOVER_COOLDOWN_MS);
    provider.push(clickReply(ref));
    expect(await modelOf(3)).toBe(HANDS); // t=180 s: recovered, cooldown back to 60 s
    provider.push(inline502());
    provider.push(clickReply(ref));
    expect(await modelOf(4)).toBe(FALLBACK); // demoted at t=180 s
    clock.advance(FAILOVER_COOLDOWN_MS);
    provider.push(clickReply(ref));
    expect(await modelOf(5)).toBe(HANDS); // 60 s later, not 120
  });

  /**
   * MUTATION THIS CATCHES: the flat 60 s ceiling on an action call, or the
   * short action deadline leaking into extraction.
   *
   * `run_9b6afae6` (2026-09-27 07:32Z) held a page for 60 s on a rank-0 hands
   * action call that never answered and billed the customer a minute of browser
   * time for it. Measured production tail for that model: p99.9 15.6 s over
   * n=11,018 answered calls, and 23 calls that never answered at all; its plan
   * slot carries a 12 s `actionDeadlineMs`. An extraction's reply is the
   * customer's data and keeps the long ceiling.
   */
  test('a stalled action is abandoned at the primary’s measured deadline; a stalled extraction is not', async () => {
    const tree = cartPage(1);
    const actClock = new VirtualClock();
    const acting = new FakeProvider([{ hang: true }, clickReply(refOf(tree, 'Checkout'))]);
    const act = portFor(acting, actClock);

    const choice = await act.port.choose(promptFor(tree));

    expect(actClock.slept[0]).toBe(12_000);
    expect(choice.modelRank).toBe(1);
    expect(act.failovers[0]?.message).toBe('the model did not answer within 12000ms');

    const extractClock = new VirtualClock();
    const extracting = new FakeProvider([{ hang: true }, reply(JSON.stringify({ ads: [] }))]);
    const extract = portFor(extracting, extractClock);
    await extract.port.extract({
      instruction: null,
      schema: { type: 'object', properties: { ads: { type: 'array' } }, required: ['ads'] },
      content: { kind: 'markdown', markdown: '# ads' },
    });

    expect(extractClock.slept[0]).toBe(60_000);
  });

  /**
   * MUTATION THIS CATCHES: holding a demotion for the cooldown after ONE stalled
   * call. On `run_9b6afae6` the held demotion put step 1 on rank 1 at 4.02
   * credits of a 3.00 budget, and the run capped with the answer in hand; 20 of
   * the window's 23 stalls fell while rank 0 was answering other runs normally.
   */
  test('a lone stall is answered by the next rank, and the next step goes back to the primary', async () => {
    const tree = cartPage(1);
    const ref = refOf(tree, 'Checkout');
    const provider = new FakeProvider([{ hang: true }, clickReply(ref), clickReply(ref)]);
    const { port, failovers } = portFor(provider, new StillClock());

    const stalled = await port.choose(promptFor(tree, 'check out', 0));
    const next = await port.choose(promptFor(tree, 'check out', 1));

    expect(provider.requests.map((request) => request.model)).toEqual([HANDS, FALLBACK, HANDS]);
    expect([stalled.modelRank, next.modelRank]).toEqual([1, 0]);
    expect(failovers.map((event) => [event.trigger, event.holdMs])).toEqual([
      ['timeout', 0],
      ['cooldown-elapsed', undefined],
    ]);
  });

  /**
   * MUTATION THIS CATCHES: treating every timeout as lone, which would ask a
   * primary that is really down once per step, 20 s each, forever. The second
   * stall in a row is an outage and holds for the base cooldown (not a doubled
   * one: the return after a lone stall is not a failed probe).
   */
  test('a second stall in a row holds the demotion for the cooldown', async () => {
    const tree = cartPage(1);
    const ref = refOf(tree, 'Checkout');
    const clock = new StillClock();
    const provider = new FakeProvider([
      { hang: true },
      clickReply(ref),
      { hang: true },
      clickReply(ref),
      clickReply(ref),
      clickReply(ref),
    ]);
    const { port, failovers } = portFor(provider, clock);

    await port.choose(promptFor(tree, 'check out', 0));
    await port.choose(promptFor(tree, 'check out', 1));
    clock.advance(FAILOVER_COOLDOWN_MS - 1);
    await port.choose(promptFor(tree, 'check out', 2));
    clock.advance(1);
    await port.choose(promptFor(tree, 'check out', 3));

    expect(provider.requests.map((request) => request.model)).toEqual([
      HANDS,
      FALLBACK,
      HANDS,
      FALLBACK,
      FALLBACK,
      HANDS,
    ]);
    expect(failovers.filter((event) => event.trigger === 'timeout').map((event) => event.holdMs)).toEqual([
      0,
      FAILOVER_COOLDOWN_MS,
    ]);
  });

  test('the chain walks past two dead ranks and answers from the last', async () => {
    const tree = cartPage(1);
    const provider = new FakeProvider([rateLimit(), rateLimit(), clickReply(refOf(tree, 'Checkout'))]);
    const { port, failovers } = portFor(provider);

    await port.choose(promptFor(tree));

    expect(provider.requests.map((request) => request.model)).toEqual([
      HANDS,
      FALLBACK,
      FALLBACK_2,
    ]);
    expect(failovers.map((event) => event.to)).toEqual([FALLBACK, FALLBACK_2]);
  });

  /**
   * MUTATION THIS CATCHES: keying failover on the wire `status`, which is 200
   * for the inline upstream error the gateway sends — the chain then never
   * demotes and the step fails. From 12Z on 2026-09-24 that shape ended 17 of
   * 423 finished acct_bench runs. On an action it fails over at once, unsent
   * again (2026-10-02: 8 of 14 such resends failed again): rank 0 once, then
   * rank 1 answers.
   */
  test('an upstream 502 inside a 200 on an action goes straight to the next rank', async () => {
    const tree = cartPage(1);
    const provider = new FakeProvider([inline502(), clickReply(refOf(tree, 'Checkout'))]);
    const { port, failovers } = portFor(provider, new StillClock());

    const choice = await port.choose(promptFor(tree));

    expect(choice.action.type).toBe('click');
    expect(provider.requests.map((request) => request.model)).toEqual([HANDS, FALLBACK]);
    expect(failovers.map((event) => event.trigger)).toEqual(['provider-fault']);
  });

  /**
   * MUTATION THIS CATCHES: dropping `maxActionTokens` from the client this port
   * mints, which leaves `ModelClient`'s own `DEFAULT_ACTION_TOKENS` of 1024.
   *
   * THIS IS A REGRESSION TEST FOR A MEASURED 0/3. Every model in every chain
   * here is a reasoning model and `max_tokens` covers reasoning tokens, so 1024
   * is below the floor of the one that drives every run: measured through the
   * gateway on a page-shaped prompt, the rank-0 hands model spends
   * 1,529-1,645 reasoning tokens to emit ~50 tokens of JSON, truncates at 1024,
   * and returns an EMPTY content string. A three-task pilot scored 0/3 with
   * twelve steps, twelve failed model calls, zero actions and `about:blank` as
   * the final url — the agent never navigated once.
   *
   * The chain does not rescue it and must not: a truncated reply is a 200 the
   * provider charged for, so `shouldFailOver` refuses to demote, which is why
   * the pilot recorded zero failovers across twelve failures. The ceiling is
   * the fix, and this asserts the number that actually goes on the wire rather
   * than a constant this file could also get wrong.
   */
  test('the reply ceiling clears the actuator reasoning floor', async () => {
    const tree = cartPage(1);
    const provider = new FakeProvider([clickReply(refOf(tree, 'Checkout'))]);
    const { port } = portFor(provider);

    await port.choose(promptFor(tree));

    // 1,684 is the largest completion observed on a real page; anything at or
    // below it truncates the reply to an empty string on the next page in.
    expect(provider.requests[0]?.maxTokens ?? 0).toBeGreaterThan(1_684);
  });

  /**
   * MUTATION THIS CATCHES: removing `maxActionTokens` from `HarnessPortOptions`.
   *
   * This port builds its own clients, so without the option a host that meets a
   * model with a higher reasoning floor again cannot raise the ceiling from
   * outside at all — which is the state the pilot was in, and it is not a state
   * a composition root should be able to be in.
   */
  test('a host can raise the ceiling from outside', async () => {
    const tree = cartPage(1);
    const provider = new FakeProvider([clickReply(refOf(tree, 'Checkout'))]);
    const port = new HarnessModelPort({
      plan: CHAIN,
      provider,
      session: SESSION,
      ledger: new CostLedger(),
      maxActionTokens: 8_192,
    });

    await port.choose(promptFor(tree));

    expect(provider.requests[0]?.maxTokens).toBe(8_192);
  });

  /**
   * MUTATION THIS CATCHES: swallowing the last rank's error, or replacing it
   * with a message of this module's own.
   *
   * When the chain is exhausted the customer gets the provider's own error, and
   * `ModelProviderError`'s text is `model provider refused (<status> <code>):
   * <message>` — which names no model. Rewriting it here is how a model id
   * would end up in a customer-visible string.
   */
  test('an exhausted chain rethrows the last error untouched', async () => {
    const tree = cartPage(1);
    const provider = new FakeProvider([rateLimit(), rateLimit(), rateLimit()]);
    const { port } = portFor(provider);

    const thrown = await thrownBy(port.choose(promptFor(tree)));

    expect(thrown).toBeInstanceOf(ModelProviderError);
    expect(provider.calls).toBe(3);
    for (const slot of CHAIN.actuators) {
      expect((thrown as Error).message).not.toContain(slot.model);
    }
  });

  test('a refusal ends the run on the primary rather than paying twice', async () => {
    const tree = cartPage(1);
    // THE ERROR A PROVIDER RAISES, not a response carrying `stopReason:
    // 'refusal'`. The refusal-to-error mapping lives in `chat-completions.ts`;
    // `ModelClient` never reads `stopReason`, so a bare
    // response with that field is an EMPTY REPLY as far as this code is
    // concerned — which is now told what was wrong and asked again, and so
    // could not have proved the thing this test is named for.
    const provider = new FakeProvider([
      new ModelUnusableError('refusal', 'declined on policy grounds', ZERO_TOKENS, '0'),
    ]);
    const { port, failovers } = portFor(provider);

    const thrown = await thrownBy(port.choose(promptFor(tree)));

    expect(thrown).toBeInstanceOf(ModelUnusableError);
    expect(provider.calls).toBe(1);
    expect(provider.requests[0]?.model).toBe(HANDS);
    expect(failovers).toEqual([]);
  });

  /**
   * THE EXTRACT PATH DOWN THE CHAIN, which nothing drove before this test and
   * which is the only path a `json`-format scrape takes: `pipelineDepsFor`
   * binds `extractJson` to this port's `extract`.
   *
   * MUTATION THIS CATCHES: adding `ModelSchemaError` to `shouldFailOver`, which
   * is the obvious-looking fix for the measured 19% of Ad Library extractions
   * that failed outright and is the WRONG one. AdCountStable measured the
   * rank-1 hands model returning 11 of that page's 26 ads in 4 of
   * 6 replays of one fixed render, because it deduplicates the 8 byte-identical
   * creatives — `stopReason: 'stop'`, no warning, nothing on the wire to
   * separate it from a complete answer. A demotion here would trade a visible
   * 500 for an invisible short answer.
   *
   * So the remedy is inside the client and on the SAME rank: three asks, the
   * violations carried into each one, every call on the primary model.
   */
  test('a malformed extraction is re-asked on the primary and never demoted', async () => {
    const prose = reply('The page lists some ads.');
    const provider = new FakeProvider([prose, prose]);
    const { port, failovers } = portFor(provider);

    const thrown = await thrownBy(
      port.extract({
        instruction: null,
        schema: { type: 'object', required: ['ads'], properties: { ads: { type: 'array' } } },
        content: { kind: 'markdown', markdown: '# Ad Library' },
      }),
    );

    // THE CUSTOMER-VISIBLE FACT, which is the half that used to be missing: a
    // plain `Error` reaches `toOutcrawlError` as `new InternalError(id)`, so
    // every one of these answered HTTP 500 `{"code":"internal"}` and told a
    // customer the service had crashed about a request that commonly succeeds
    // on the next attempt.
    expect(thrown).toBeInstanceOf(ExtractionFailedError);
    expect((thrown as ExtractionFailedError).code).toBe('extraction_failed');
    expect((thrown as ExtractionFailedError).status).toBe(503);
    expect((thrown as ExtractionFailedError).failure).toBe('schema');
    // The violations survive into the sentence the customer reads, including
    // the one that says the model was told and did not move.
    expect((thrown as ExtractionFailedError).detail).toContain('is not valid JSON');
    expect((thrown as ExtractionFailedError).detail).toContain('unchanged after being told');
    expect(failovers).toEqual([]);
    // TWO asks, both on the primary, and two is the right number here: the
    // model sent back the identical violation after being told exactly what it
    // was, which is the one case where re-asking is re-asking UNCHANGED. The
    // correction bound of three is only reached by a model that produces a
    // different fault each time — `client.test.ts` pins that arm.
    expect(provider.requests.map((request) => request.model)).toEqual([HANDS, HANDS]);
  });

  /**
   * The other half, and it demotes for the reason the chain exists: a rate
   * limit is not a reply, and the next rank has a different bucket. Asserted on
   * the extract path specifically because that path had no test at all, so
   * nothing would have caught `extract` being wired past `#withFailover`.
   */
  test('a rate-limited extraction demotes to the next rank', async () => {
    const provider = new FakeProvider([rateLimit(), reply(JSON.stringify({ ads: [] }))]);
    const { port, failovers } = portFor(provider);

    const result = await port.extract({
      instruction: null,
      schema: { type: 'object', required: ['ads'], properties: { ads: { type: 'array' } } },
      content: { kind: 'markdown', markdown: '# Ad Library' },
    });

    expect(result.data).toEqual({ ads: [] });
    expect(provider.requests.map((request) => request.model)).toEqual([HANDS, FALLBACK]);
    expect(failovers.map((event) => event.trigger)).toEqual(['rate-limit']);
  });

  /**
   * THE LINE `extraction_failed` MUST NOT CROSS, and the mutation this catches
   * is the tempting simplification: coding every `ModelError` the chain gives
   * up on.
   *
   * `extraction_failed` promises the customer that retrying is worth it. For a
   * provider refusing our CREDENTIAL — or our billing, or a model we withdrew —
   * that promise is false in a way that costs the customer real attempts, and
   * the honest answer is the one code that means "we have a defect, here is an
   * id": `internal`. So the error stays a plain `Error` and
   * `toOutcrawlError` keeps dropping it to an incident.
   */
  test('a provider refusal that a retry cannot fix is left as ours, not coded retryable', async () => {
    const unauthorized = (): ModelProviderError =>
      new ModelProviderError({
        status: 401,
        providerCode: 'authentication_error',
        message: 'invalid api key',
        retryable: false,
      });
    const provider = new FakeProvider([unauthorized(), unauthorized(), unauthorized()]);
    const { port } = portFor(provider);

    const thrown = await thrownBy(
      port.extract({
        instruction: null,
        schema: { type: 'object', required: ['ads'], properties: { ads: { type: 'array' } } },
        content: { kind: 'markdown', markdown: '# Ad Library' },
      }),
    );

    expect(thrown).not.toBeInstanceOf(ExtractionFailedError);
    expect(thrown).toBeInstanceOf(ModelProviderError);
    // And it is NOT an `OutcrawlError` by duck-typing either: `isOutcrawlError`
    // reads `.code`, and a `providerCode` that happened to collide with a wire
    // code would re-host this as a customer error.
    expect(isOutcrawlError(thrown)).toBe(false);
  });

  /**
   * The mid-generation death, which `ModelClient` resends on the same rank and
   * which reaches the customer coded once the resends are spent. Measured once
   * in 20 replays of the Ad Library page (2026-09-12) and once in
   * AdCountStable's live arm, where it aborted the whole pipeline.
   */
  test('a generation that died mid-stream reaches the customer as a retryable no-answer', async () => {
    const died = (): ModelUnusableError =>
      new ModelUnusableError(
        'error',
        'the upstream provider reported an error mid-generation',
        ZERO_TOKENS,
        '0',
      );
    const provider = new FakeProvider([died(), died()]);
    const { port, failovers } = portFor(provider);

    const thrown = await thrownBy(
      port.extract({
        instruction: null,
        schema: { type: 'object', required: ['ads'], properties: { ads: { type: 'array' } } },
        content: { kind: 'markdown', markdown: '# Ad Library' },
      }),
    );

    expect(thrown).toBeInstanceOf(ExtractionFailedError);
    expect((thrown as ExtractionFailedError).failure).toBe('no-answer');
    // Two asks: the client's call plus its one resend, both on the primary,
    // because this is not a failure another model fixes — and one rather than
    // two because the shipped Python client's 60 s default is the deadline
    // being respected. See MAX_EXTRACT_RETRIES.
    expect(provider.requests.map((request) => request.model)).toEqual([HANDS, HANDS]);
    expect(failovers).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The planner boundary
 * ------------------------------------------------------------------ */

/**
 * A plan with a planner slot: the trigger mechanism belongs to any plan that
 * has a planner, and which host plan (if any) carries one is the host's call.
 */
const PLANNED: ModelPlan = {
  actuators: [{ model: HANDS, rank: 0, callsPerStep: 1, replyReasoning: true }],
  planner: { model: PLANNER, rank: 0, callsPerStep: 0.2, replyReasoning: true },
};

function plannedPort(provider: FakeProvider): { port: HarnessModelPort; failovers: FailoverEvent[] } {
  const failovers: FailoverEvent[] = [];
  const port = new HarnessModelPort({
    plan: PLANNED,
    provider,
    session: SESSION,
    ledger: new CostLedger(),
    onFailover: (event) => failovers.push(event),
  });
  return { port, failovers };
}

const PLAN = reply(JSON.stringify({ strategy: 'go', next: ['go'] }));

/** One recorded step, as the loop hands it back in `AgentPrompt.history`. */
function traced(index: number, snapshotHash: string, extra: Partial<StepTrace> = {}): StepTrace {
  return {
    index,
    action: { type: 'click', ref: nodeRef(0, 2) },
    cache: { status: 'MISS' },
    elapsedMs: 1,
    snapshotHash,
    credits: '0',
    spent: '0',
    pages: 1,
    durationMs: 1,
    usage: {},
    at: '2026-09-24T00:00:00.000Z',
    ...extra,
  } as StepTrace;
}

/**
 * Drives the port through a scripted run: `pages[i]` is the page step `i` sees
 * and `outcome[i]` is what step `i`'s trace records. Returns which steps the
 * planner was asked on.
 *
 * The page number is also written into the root's name, because the snapshot
 * hash is over roles and names, not backend ids: `cartPage(10)` and
 * `cartPage(20)` alone would be the same page state.
 */
async function drive(
  port: HarnessModelPort,
  provider: FakeProvider,
  pages: readonly number[],
  outcome: (step: number) => Partial<StepTrace> = () => ({}),
): Promise<number[]> {
  const asked: number[] = [];
  const history: StepTrace[] = [];
  for (const [step, page] of pages.entries()) {
    const before = provider.requests.length;
    const tree = cartPage(page);
    const named = { ...tree, root: { ...tree.root, name: `Cart ${String(page)}` } };
    const prompt = promptFor(named, 'check out', step, [...history]);
    await port.choose(prompt);
    if (provider.requests.slice(before).some((request) => request.model === PLANNER)) {
      asked.push(step);
    }
    history.push(traced(step, prompt.snapshotHash, outcome(step)));
  }
  return asked;
}

const doneReply = (summary: string): ModelResponse =>
  reply(JSON.stringify({ reasoning: 'finished', actions: [{ type: 'done', summary }] }));

describe('the planner never sees the page', () => {
  /**
   * MUTATION THIS CATCHES: passing `prompt` straight to the planner, or adding
   * `text`/`tree` to `PlanView` so a digest can carry a rendered tree.
   *
   * This is the whole economic argument as a runtime assertion. Input dominates
   * cost and input IS the snapshot — a measured 529,164 input tokens per minute
   * on a real content-heavy run — so a frontier reasoner that saw the tree would
   * cost roughly 69x the per-minute price. The type makes it impossible at
   * compile time; this makes the consequence visible if someone deletes the
   * type.
   */
  test("the planner's prompt contains no node from the tree, and the actuator's does", async () => {
    const tree = cartPage(1);
    const provider = new FakeProvider([
      reply(JSON.stringify({ strategy: 'find the checkout', next: ['open the cart'] })),
      clickReply(refOf(tree, 'Checkout')),
    ]);
    const { port } = plannedPort(provider);

    await port.choose(promptFor(tree, 'check out', 0));

    const [planner, actuator] = provider.requests;
    expect(planner?.model).toBe(PLANNER);
    expect(actuator?.model).toBe(HANDS);

    // The two node names and the page url are the whole of what the fixture's
    // tree says. None of it reaches the planner.
    for (const fromThePage of ['Checkout', 'Coupon', 'textbox', '/html/body']) {
      expect(planner?.prompt ?? '').not.toContain(fromThePage);
    }
    // And the actuator does get the page, or it could not act on it — which is
    // what makes the assertion above a boundary rather than an empty prompt.
    expect(actuator?.prompt ?? '').toContain('Checkout');
  });

  /**
   * MUTATION THIS CATCHES: `planDigestFrom` reducing history to the whole
   * `StepTrace`, or carrying a finding's page text through unbounded.
   *
   * A digest that grows with the run is a digest that costs like a tree by step
   * forty, at 50x the actuator's input rate.
   */
  test('the digest carries counts and outcomes, not nodes', () => {
    const digest = planDigestFrom(
      {
        task: 'check out',
        step: 3,
        history: [],
        memory: {
          goals: [{ goal: 'open the cart', status: 'done' }],
          findings: [{ step: 1, text: 'the total is 42' }],
          ruledOut: [{ step: 2, text: 'the promo box rejects everything' }],
        },
        tabs: [{ id: 'tab_1', url: 'https://shop.example.com/cart', title: 'Cart' }],
        caps: undefined,
        notice: undefined,
      } as unknown as Parameters<typeof planDigestFrom>[0],
      7,
    );

    expect(digest.actionableNodes).toBe(7);
    expect(digest.goals).toEqual([{ goal: 'open the cart', status: 'done' }]);
    expect(digest.findings).toEqual(['the total is 42']);
    expect(digest.ruledOut).toEqual(['the promo box rejects everything']);
    expect(digest.location).toEqual([{ url: 'https://shop.example.com/cart', title: 'Cart' }]);
    // Serialized, because that is the form it is sent in: no key anywhere in it
    // is a tree, a ref or a rendered node line.
    const wire = JSON.stringify(digest);
    expect(wire).not.toContain('xpath');
    expect(wire).not.toContain('backendNodeId');
    expect(wire).not.toContain('frameOrdinal');
  });
});

describe('the planner is asked on events, never on a clock', () => {
  /**
   * MUTATION THIS CATCHES: any clock — `step % N`, a max-gap backstop — or a
   * progress test that misses a new page.
   *
   * A run moving to a new page every step and never failing holds nothing the
   * first plan did not; replayed over 719 production runs, 39.4% of the old
   * timer's calls landed on a step where no trigger held.
   */
  test('a clean run of eight steps asks the planner once, at the start', async () => {
    const pages = [10, 20, 30, 40, 50, 60, 70, 80];
    const provider = new FakeProvider([PLAN]);
    for (const page of pages) {
      provider.push(clickReply(refOf(cartPage(page), 'Checkout')));
    }
    const { port } = plannedPort(provider);

    expect(await drive(port, provider, pages)).toEqual([0]);
  });

  /**
   * MUTATION THIS CATCHES: ignoring `check.verdict`, re-planning on every
   * failed step of one episode, or re-planning when the actuator's own call
   * failed (a provider 502 is not a strategy problem).
   */
  test('a contradicted action triggers exactly one re-plan; a model-call failure triggers none', async () => {
    // Step 2's click is contradicted, and the page does not change (it was
    // contradicted because nothing changed). Step 3 fails again on the same
    // page: same episode, no second plan. Step 5 fails on the provider.
    const pages = [10, 20, 30, 30, 40, 50, 60];
    const provider = new FakeProvider([PLAN]);
    for (const [step, page] of pages.entries()) {
      if (step === 3) {
        provider.push(PLAN);
      }
      provider.push(clickReply(refOf(cartPage(page), 'Checkout')));
    }
    const { port } = plannedPort(provider);

    const asked = await drive(port, provider, pages, (step) => {
      if (step === 2 || step === 3) {
        return {
          check: { verdict: 'contradicted', expected: 'the page to change', saw: 'nothing changed' },
        } as Partial<StepTrace>;
      }
      if (step === 5) {
        return { error: 'model provider refused (502 gateway_502): upstream error' };
      }
      return {};
    });

    expect(asked).toEqual([0, 3]);
  });

  /**
   * MUTATION THIS CATCHES: no stall trigger, a stall counter that a revisited
   * page resets, or a stall that re-fires every step once it has fired.
   */
  test(`${String(STALL_STEPS)} steps without progress trigger one re-plan, then back off`, async () => {
    // Step 0 lands on page 10 and every later step is back on it: no new page,
    // no finding, no goal change, no extract.
    const pages = Array.from({ length: STALL_STEPS * 2 }, () => 10);
    const provider = new FakeProvider([PLAN]);
    for (const [step] of pages.entries()) {
      if (step === STALL_STEPS) {
        provider.push(PLAN);
      }
      provider.push(clickReply(refOf(cartPage(10), 'Checkout')));
    }
    const { port } = plannedPort(provider);

    // Once at the start, once at the first stall; the next is due at twice the
    // stall, which this run does not reach.
    expect(await drive(port, provider, pages)).toEqual([0, STALL_STEPS]);
  });

  /**
   * MUTATION THIS CATCHES: returning a proposed `done` without the planner's
   * judgement, or ignoring a veto.
   */
  test('a proposed done is judged by the planner, and a veto re-asks the actuator once', async () => {
    const tree = cartPage(1);
    const provider = new FakeProvider([
      PLAN,
      doneReply('bought the first item'),
      reply(JSON.stringify({ complete: false, missing: 'the second item is not bought', next: ['buy item 2'] })),
      clickReply(refOf(tree, 'Checkout')),
    ]);
    const { port } = plannedPort(provider);

    const choice = await port.choose(promptFor(tree, 'buy two items', 0));

    expect(provider.requests.map((request) => request.model)).toEqual([
      PLANNER,
      HANDS,
      PLANNER,
      HANDS,
    ]);
    expect(provider.requests[2]?.prompt ?? '').toContain('bought the first item');
    expect(provider.requests[3]?.prompt ?? '').toContain('the second item is not bought');
    expect(choice.action.type).toBe('click');
  });

  /**
   * MUTATION THIS CATCHES: a completion check that can hold a run forever. The
   * actuator sees the page and the planner does not, so its second `done`
   * stands, and a re-proposed `done` on an unchanged page is not judged again.
   */
  test('a judged-complete done stands, and the check is not repeated without progress', async () => {
    const tree = cartPage(1);
    const provider = new FakeProvider([
      PLAN,
      doneReply('bought both items'),
      reply(JSON.stringify({ complete: true })),
      doneReply('bought both items'),
    ]);
    const { port } = plannedPort(provider);

    const first = await port.choose(promptFor(tree, 'buy two items', 0));
    const again = await port.choose(promptFor(tree, 'buy two items', 1, [traced(0, promptFor(tree).snapshotHash)]));

    expect(first.action.type).toBe('done');
    expect(again.action.type).toBe('done');
    expect(provider.requests.map((request) => request.model)).toEqual([
      PLANNER,
      HANDS,
      PLANNER,
      HANDS,
    ]);
  });

  /**
   * MUTATION THIS CATCHES: letting a planner failure propagate, on either call.
   *
   * The actuator still has the page in front of it and the previous plan is
   * still in force. Losing a run because the strategist was rate-limited would
   * make the pair less reliable than the single model it replaced, which is the
   * opposite of what a planner is for.
   */
  test('a planner failure does not fail the step, nor block a done', async () => {
    const tree = cartPage(1);
    const provider = new FakeProvider([rateLimit(), doneReply('done'), rateLimit()]);
    const { port, failovers } = plannedPort(provider);

    const choice = await port.choose(promptFor(tree, 'check out', 0));

    expect(choice.action.type).toBe('done');
    // The planner has no chain of its own, so its failure is absorbed rather
    // than demoting the actuator.
    expect(failovers).toEqual([]);
    expect(provider.requests.map((request) => request.model)).toEqual([PLANNER, HANDS, PLANNER]);
  });

  /**
   * MUTATION THIS CATCHES: a harness with no planner paying for a completion
   * check it has nobody to ask.
   */
  test('a harness with no planner makes exactly one call per step, done included', async () => {
    const provider = new FakeProvider([doneReply('done')]);
    const port = new HarnessModelPort({
      plan: { actuators: PLANNED.actuators },
      provider,
      session: SESSION,
      ledger: new CostLedger(),
    });

    await port.choose(promptFor(cartPage(1), 'check out', 0));

    expect(provider.requests.map((request) => request.model)).toEqual([HANDS]);
  });

  /**
   * MUTATION THIS CATCHES: the port ignoring a planner slot's `triggers` — a
   * plan priced for a narrow subset would silently pay for all four and an A/B
   * would measure the wrong arm.
   */
  test('a planner slot fires only on its own triggers', async () => {
    const plan: ModelPlan = {
      actuators: [{ model: HANDS, rank: 0, callsPerStep: 1, replyReasoning: true }],
      planner: { model: PLANNER, rank: 0, callsPerStep: 0.2, triggers: ['trouble', 'stall'], replyReasoning: true },
    };
    const provider = new FakeProvider([]);
    for (let step = 0; step < STALL_STEPS; step += 1) {
      provider.push(clickReply(refOf(cartPage(10), 'Checkout')));
    }
    provider.push(PLAN);
    provider.push(doneReply('done'));
    const port = new HarnessModelPort({
      plan,
      provider,
      session: SESSION,
      ledger: new CostLedger(),
    });

    // No start plan; the stall still fires; and the done is not judged.
    expect(await drive(port, provider, Array.from({ length: STALL_STEPS + 1 }, () => 10))).toEqual([STALL_STEPS]);
    expect(provider.requests.at(-1)?.model).toBe(HANDS);
  });
});
