/**
 * The client inside the loop it exists for.
 *
 * Every other test in this package drives `ModelClient` directly. This one wires
 * it into `@outcrawl/runtime`'s own `observe()` and `runAgent()` through
 * `AgentDeps`, with a fake browser and a fake provider, because the ticket's
 * premise was that `AgentDeps.model` is "a callback nothing implements, so
 * `Outcrawl.observe`, `Outcrawl.extract` and `extractJson` cannot run". The
 * proof that it now runs is a run.
 *
 * Nothing here is a mock of the runtime: `observe` and `runAgent` are the real
 * exported functions, and the action-lock discipline they enforce applies.
 */

import { describe, expect, test } from 'bun:test';
import { compareDecimal, type JsonSchema } from '@outcrawl/scout-core';
import {
  DEFAULT_RUN_PRICING,
  observe,
  runAgent,
  type AgentDeps,
  type AxTree,
  type ExtractOutcome,
} from '@outcrawl/runtime';

import { ModelClient } from '../src/client';
import { HarnessModelPort } from '../src/harness';
import { CostLedger } from '../src/ledger';
import { BRAIN_MODEL, FakeProvider, HANDS_MODEL, VirtualClock, brainPlan, cartPage, clickReply, refOf, reply, type ScriptedTurn } from './support';

const MARKDOWN = '# Cart\n\nKettle - £39.50\n\nTotal: £42.00';

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: { total: { type: 'string' } },
  required: ['total'],
};

/**
 * A FINAL extraction's reply on a schema run: the run's own shape as `answer`,
 * beside `complete` and `missing` (`finalAnswerSchema` in `@outcrawl/runtime`,
 * 2f1afab6). The customer still receives `answer` alone; a reply in the bare
 * shape is refused as a schema violation and asked again.
 */
const finalAnswer = (answer: unknown): string => JSON.stringify({ answer, complete: true, missing: '' });

function harness(
  turns: readonly ScriptedTurn[],
  page: AxTree,
): { deps: AgentDeps; provider: FakeProvider; ledger: CostLedger; client: ModelClient } {
  const provider = new FakeProvider(turns);
  const ledger = new CostLedger();
  // TWO clocks, and they measure different things.
  //
  // `clock` is the CLIENT's, and its `sleep` advances on purpose: that is what
  // makes a request deadline testable in microseconds — the losing arm of the
  // client's `Promise.race` resolves immediately having moved the clock by the
  // whole deadline. Which means it moves by 60 s on every successful call too,
  // for a timer that was abandoned.
  //
  // `runClock` is the RUN's, and it must not inherit that. `caps.budget` is
  // priced on elapsed time now, so sharing one double made a two-call run read
  // as two minutes old and trip a 2.00 credit ceiling — a fixture artefact
  // arriving as a billing figure. The run's clock therefore advances only when
  // a test advances it.
  const clock = new VirtualClock();
  const runClock = new VirtualClock();
  const client = new ModelClient({
    provider,
    model: HANDS_MODEL,
    session: { sessionId: 'run-1', accountId: 'acct-9' },
    ledger,
    clock,
  });

  // The client IS the port now — `ModelClient implements ModelPort` — so the
  // loop is driven through it rather than through a wrapper written here.
  //
  // This block used to be that wrapper: it renamed `choose` to `model` and
  // reshaped `extract`'s arguments, which is exactly the seam that was broken in
  // production. A test that adapts around a mismatch proves the mismatch is
  // survivable in the test and nowhere else. `agentDepsFor` in
  // `@outcrawl/worker` is the only adapter, and it now calls the same two
  // methods with the same shapes these lines do.
  const deps: AgentDeps = {
    snapshot: () => page,
    lock: () => undefined,
    unlock: () => undefined,
    perform: () => ({}),
    extract: async (schema, instruction): Promise<ExtractOutcome> => {
      // What a host does: the browser supplies the page, the client supplies the
      // model. `AgentDeps.extract` has no page parameter because the browser is
      // the one that has it. Markdown here rather than the tree only because
      // this fixture is markdown; the worker's binding passes `kind: 'tree'`.
      const result = await client.extract({
        instruction: instruction ?? null,
        schema: schema ?? null,
        content: { kind: 'markdown', markdown: MARKDOWN },
      });
      return { data: result.data, usage: result.usage };
    },
    model: client.choose,
    // What the composition root binds: the session's provider USD, read live
    // off the client's own ledger, so every call — corrections included — is
    // on the run's bill.
    modelCostUsd: () => ledger.totalsFor('run-1').costUsd,
    clock: runClock,
  };

  return { deps, provider, ledger, client };
}

describe('observe', () => {
  test('returns reviewable actions with their heal paths, and executes nothing', async () => {
    const page = cartPage(11_000);
    const checkout = refOf(page, 'Checkout');
    const coupon = refOf(page, 'Coupon');
    const { deps, ledger } = harness(
      [
        reply(
          JSON.stringify({
            reasoning: 'checkout is the goal; the coupon field is the other thing you can do here',
            actions: [
              { type: 'click', ref: `0-${String(checkout.backendNodeId)}` },
              { type: 'fill', ref: `0-${String(coupon.backendNodeId)}`, text: 'SAVE10' },
            ],
          }),
          { inputTokens: 800, outputTokens: 60 },
          '0.0022',
        ),
      ],
      page,
    );

    const result = await observe(deps, { instruction: 'check out' });

    expect(result.actions).toEqual([
      { type: 'click', ref: checkout },
      { type: 'fill', ref: coupon, text: 'SAVE10' },
    ]);
    // The cache unit, in core's wire form, carrying the XPath a later session
    // heals against.
    expect(result.observed).toEqual([
      {
        ref: '0-11001',
        description: 'click the button "Checkout"',
        method: 'click',
        xpath: '/html/body/div[1]/button[1]',
      },
      {
        ref: '0-11002',
        description: 'fill the textbox "Coupon" with "SAVE10"',
        method: 'fill',
        args: ['SAVE10'],
        xpath: '/html/body/div[1]/input[1]',
      },
    ]);
    expect(result.reasoning).toContain('checkout is the goal');
    expect(result.usage.inputTokens).toBe(800);
    expect(result.cache.status).toBe('MISS');
    expect(ledger.totalsFor('run-1').costUsd).toBe('0.0022');
  });
});

describe('runAgent', () => {
  test('runs a step, extracts against the schema, and charges the run for both calls', async () => {
    const page = cartPage(13_000);
    const { deps, provider, ledger } = harness(
      [
        reply(
          JSON.stringify({
            reasoning: 'the total is on the page already',
            actions: [{ type: 'extract', instruction: 'the order total', final: true }],
          }),
          { inputTokens: 900, outputTokens: 30 },
          '0.0021',
        ),
        reply(finalAnswer({ total: '£42.00' }), { inputTokens: 300, outputTokens: 15 }, '0.00075'),
      ],
      page,
    );

    const result = await runAgent(deps, {
      task: 'find the order total',
      caps: { steps: 5, budget: '2.00', duration: '5m' },
      // No host price list: at cost, one credit per provider dollar.
      // Today's behaviour, stated: one failed step ends the run. These tests assert
      // exactly that, so they name it rather than inheriting it.
      stepFailures: null,
      schema: SCHEMA,
      // What this test is about is the CLIENT's charges reaching the run's
      // ledger. `caps.budget` is priced on wall-clock time as well now, and
      // this harness's `VirtualClock` is advanced by the settle's own sleeps —
      // so leaving the settle on would put ten virtual seconds a read into a
      // number that is here to show what two model calls cost. Same
      // justification as `loop.test.ts`'s duration test, one ceiling along.
      settle: false,
    });

    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('schema-satisfied');
    expect(result.data).toEqual({ total: '£42.00' });
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.action).toEqual({ type: 'extract', instruction: 'the order total', final: true });
    expect(provider.calls).toBe(2);

    // Both calls are on the bill, attributed to the one session, and the two
    // purposes are told apart.
    expect(ledger.totals().calls).toBe(2);
    expect(ledger.entries().map((row) => row.purpose)).toEqual(['action', 'extract']);
    // The provider's own figures, summed exactly.
    expect(ledger.totals().costUsd).toBe('0.00285');
    // And the same spend reaches the run's bill: the run carries the provider
    // USD the ledger saw, and its credits are that USD at the price list's
    // model rate (at cost here) — no per-step or per-page term beside it, and
    // no time term on a clock this test never advanced.
    expect(result.modelCostUsd).toBe('0.00285');
    expect(result.billedModelCostUsd).toBe('0.00285');
    expect(result.credits).toBe(DEFAULT_RUN_PRICING.modelCredits('0.00285', DEFAULT_RUN_PRICING.model));
  });

  test('model spend actually trips the budget cap, and the bill stops at the ceiling', async () => {
    const page = cartPage(15_000);
    const { deps, provider, ledger } = harness(
      [clickReply(refOf(page, 'Checkout'), { inputTokens: 900, outputTokens: 30 }, '0.06')],
      page,
    );

    // One step costs $0.06, which is 0.06 credits at cost. The ceiling is
    // 0.05, so the run gets exactly one step
    // and then stops — on the MODEL spend, which is what this test exists to
    // prove. `settle: false` keeps the settle's virtual seconds out of it:
    // `caps.budget` is priced on time too, and with the render-wait on, the
    // budget would trip on time before a token was ever weighed and this test
    // would pass without testing anything.
    const result = await runAgent(deps, {
      task: 'check out',
      caps: { steps: 5, budget: '0.05', duration: '5m' },
      // Today's behaviour, stated: one failed step ends the run. These tests assert
      // exactly that, so they name it rather than inheriting it.
      stepFailures: null,
      settle: false,
    });

    expect(result.status).toBe('capped');
    expect(result.stopReason).toBe('max-budget');
    expect(result.cappedBy).toBe('budget');
    // The whole call was spent and is recorded; the budget is a hard ceiling on
    // the bill, so only the part it funds is billed.
    expect(result.modelCostUsd).toBe('0.06');
    expect(compareDecimal(result.billedModelCostUsd, '0.06')).toBe(-1);
    expect(compareDecimal(result.credits, '0.05')).toBe(0);
    expect(result.steps).toHaveLength(1);
    // Stopped by the ceiling, not by the script running out: exactly one call was
    // made and the second step never happened.
    expect(provider.calls).toBe(1);
    expect(ledger.totals().calls).toBe(1);
  });

  test('a model that answers with prose ends the run with a reason, keeping what was collected', async () => {
    const page = cartPage(14_000);
    const prose = 'The total looks like about forty-two pounds.';
    const { deps, ledger } = harness(
      [
        reply(
          JSON.stringify({ actions: [{ type: 'extract', instruction: 'the order total', final: true }] }),
          { inputTokens: 900, outputTokens: 30 },
        ),
        // TWICE, because an extraction that fails the schema is now told what
        // was wrong and asked again — see `ModelClient.extract`. A model that
        // answers with the identical prose the second time ends the extraction,
        // which is what this test is about and what the run still does.
        reply(prose, { inputTokens: 300, outputTokens: 12 }),
        reply(prose, { inputTokens: 300, outputTokens: 12 }),
      ],
      page,
    );

    const result = await runAgent(deps, {
      task: 'find the order total',
      caps: { steps: 5, budget: '2.00', duration: '5m' },
      // Today's behaviour, stated: one failed step ends the run. These tests assert
      // exactly that, so they name it rather than inheriting it.
      stepFailures: null,
      schema: SCHEMA,
    });

    // Not a success with empty data: the run stops and says why. An extraction
    // that quietly returned `{}` here would have produced `status: 'partial'`
    // with a schema that looked simply unsatisfied by the page.
    expect(result.status).toBe('failed');
    expect(result.stopReason).toBe('error');
    expect(result.error).toMatch(/not valid JSON/);
    expect(result.data).toBeUndefined();
    // Both refused extractions are billed and both are recorded.
    expect(ledger.entries().map((row) => row.outcome)).toEqual(['ok', 'schema', 'schema']);
  });
});

/**
 * The production failure of run_58b17565-02be-4973-9552-f07fab6331d8, reproduced
 * and then fixed.
 *
 * The customer asked for three Nordstrom products. Eleven steps in, the model
 * answered `{"actions":[{"type":"click","ref":{"frameOrdinal":0,
 * "backendNodeId":0}}]}` — a PLACEHOLDER reference — for the fourth time in a
 * row, `resolveRef` refused it (correctly: it is not a node, and guessing is
 * what self-heal does), `ModelSchemaError` escaped `choose`, and the run ended
 * `failed`/`error` having spent 2.7202 credits and 11 steps and delivered
 * nothing. Six of those eleven steps died of a schema violation the model was
 * never told about.
 *
 * The violation is one line and it is exactly the correction needed. These two
 * tests are the two halves of the bound: the first asks again with the
 * violation attached, and the second stops asking when the answer does not
 * change.
 */
describe('a malformed reply is corrected rather than fatal', () => {
  test('the violation is fed back, the model fixes it, and the run continues', async () => {
    const page = cartPage(16_000);
    const checkout = refOf(page, 'Checkout');
    const { deps, provider, ledger } = harness(
      [
        // THE PRODUCTION REPLY, in the wire form a model writes. A zero
        // `backendNodeId` is not a node: `parseNodeRef` refuses it and is right to.
        reply(
          JSON.stringify({
            reasoning: 'clicking through to the product',
            actions: [{ type: 'click', ref: '0-0' }],
          }),
          { inputTokens: 900, outputTokens: 20 },
        ),
        // Told what was wrong, the model names a node that is actually there.
        reply(
          JSON.stringify({
            reasoning: 'the Checkout button is the only way forward',
            actions: [{ type: 'extract', instruction: 'the order total', final: true }],
          }),
          { inputTokens: 950, outputTokens: 25 },
        ),
        reply(finalAnswer({ total: '£42.00' }), { inputTokens: 300, outputTokens: 15 }),
      ],
      page,
    );

    // `stepFailures: 0` is the sharpest possible statement of the defect: ONE
    // failed step ends this run. Before the correction existed the first reply
    // was that failed step and the run came back `failed`/`error` with the
    // production error string. It must now complete.
    const result = await runAgent(deps, {
      task: 'browse three products and bring their details',
      caps: { steps: 5, budget: '2.00', duration: '5m' },
      stepFailures: 0,
      schema: SCHEMA,
      settle: false,
    });

    expect(result.status).toBe('completed');
    expect(result.data).toEqual({ total: '£42.00' });
    // Not a second step: the correction happens inside the one `choose`, with
    // the page still frozen and `stepFailures` untouched.
    expect(result.steps).toHaveLength(1);
    expect(provider.calls).toBe(3);

    // The second request carried the violation, which is the whole mechanism:
    // a retry on unchanged input would be the temperature-zero fixed point the
    // captcha solver refuses to pay for.
    const corrected = provider.requests[1]?.prompt ?? '';
    expect(corrected).toContain('"0-0"');
    // Verbatim, and it is why the ask can come back different: the first
    // request cannot have contained it.
    expect(provider.requests[0]?.prompt).not.toContain('"0-0"');

    // Both action calls are billed and both are in the ledger — the refused one
    // was charged by the provider whatever we did with it.
    expect(ledger.entries().map((row) => row.outcome)).toEqual(['schema', 'ok', 'ok']);
  });

  test('the same violation twice ends the STEP with an honest reason, not the run', async () => {
    const page = cartPage(17_000);
    const bad = reply(
      JSON.stringify({ actions: [{ type: 'click', ref: '0-0' }] }),
      { inputTokens: 900, outputTokens: 20 },
    );
    const { deps, provider } = harness(
      [
        bad,
        // Told exactly what was wrong and unmoved by it. There is nothing left
        // to say, so the step ends here rather than buying a third identical
        // reply.
        bad,
        reply(
          JSON.stringify({ actions: [{ type: 'extract', instruction: 'the order total', final: true }] }),
          { inputTokens: 950, outputTokens: 25 },
        ),
        reply(finalAnswer({ total: '£42.00' }), { inputTokens: 300, outputTokens: 15 }),
      ],
      page,
    );

    // Production's number. The step fails once, `stepFailures` absorbs it, and
    // the next step is the one that works.
    const result = await runAgent(deps, {
      task: 'browse three products and bring their details',
      caps: { steps: 5, budget: '2.00', duration: '5m' },
      stepFailures: 3,
      schema: SCHEMA,
      settle: false,
    });

    expect(result.status).toBe('completed');
    expect(result.data).toEqual({ total: '£42.00' });
    // Two steps: the one that could not be corrected, and the one that worked.
    expect(result.steps).toHaveLength(2);
    // Exactly two action calls on the failed step, not three: a repeat is the
    // non-retryable case and is spotted rather than paid for again.
    expect(provider.calls).toBe(4);

    // The failed step says what happened, and it says both halves: what was
    // wrong AND that the model was told and did not change its answer. That is
    // the difference between an honest step failure and today's run-ending
    // mystery.
    const failed = result.steps[0]?.error ?? '';
    expect(failed).toContain('"0-0"');
    expect(failed).toContain('told exactly this');
    // The RUN did not end on it, which is the whole ticket.
    expect(result.stopReason).not.toBe('error');
  });
});

describe('public scout-1 bills its brain exactly like any other model call', () => {
  /**
   * MUTATIONS THIS CATCHES: a brain call kept off the session's ledger (the
   * run would be served the brain and billed the hands), a brain call billed twice,
   * or a brain call priced on a different conversion from every other model
   * call. The run's model USD must be the ledger's, to the digit, and its
   * credits that USD at the price list's model rate. The fleet's per-plan
   * rates are checked in packages/model-config/test/billing.test.ts.
   */
  {
    test("a brain-mode run's billed credits equal its ledger", async () => {
      const page = cartPage(16_000);
      const checkout = refOf(page, 'Checkout');
      const provider = new FakeProvider([
        // Step 0: the brain names the listed Checkout button; it runs directly.
        reply(JSON.stringify({ do: 'act', a: { type: 'click', ref: `0-${String(checkout.backendNodeId)}` } }), { inputTokens: 1_900, outputTokens: 120 }, '0.0034'),
        // Step 1: the brain says it in words; the hands ground it.
        reply(JSON.stringify({ do: 'say', say: 'click Checkout again' }), { inputTokens: 2_100, outputTokens: 60 }, '0.0031'),
        clickReply(checkout, { inputTokens: 900, outputTokens: 30 }, '0.0002'),
        // Step 2: the brain ends the run.
        reply(JSON.stringify({ do: 'done', why: 'checked out', answer: 'checked out' }), { inputTokens: 2_300, outputTokens: 40 }, '0.0029'),
      ]);
      const ledger = new CostLedger();
      const port = new HarnessModelPort({
        plan: brainPlan(),
        provider,
        session: { sessionId: 'run-brain', accountId: 'acct-9' },
        ledger,
        clock: new VirtualClock(),
        actionReasoning: { enabled: false },
      });
      const deps: AgentDeps = {
        snapshot: () => page,
        lock: () => undefined,
        unlock: () => undefined,
        perform: () => ({}),
        extract: () => Promise.reject(new Error('no extraction in this run')),
        model: port.choose,
        modelCostUsd: () => ledger.totalsFor('run-brain').costUsd,
        clock: new VirtualClock(),
      };

      const result = await runAgent(deps, {
        task: 'check out',
        caps: { steps: 5, budget: '50.00', duration: '5m' },
        stepFailures: null,
        settle: false,
      });

      expect(result.status).toBe('completed');
      // Three brain calls and one hands call, each on the run's ledger.
      expect(provider.requests.map((request) => request.model)).toEqual([
        BRAIN_MODEL,
        BRAIN_MODEL,
        HANDS_MODEL,
        BRAIN_MODEL,
      ]);
      expect(ledger.totalsFor('run-brain').calls).toBe(4);
      expect(ledger.totalsFor('run-brain').costUsd).toBe('0.0096');
      expect(result.modelCostUsd).toBe(ledger.totalsFor('run-brain').costUsd);
      expect(result.billedModelCostUsd).toBe('0.0096');
      expect(result.credits).toBe(DEFAULT_RUN_PRICING.modelCredits('0.0096', DEFAULT_RUN_PRICING.model));
      // byok: the same USD bills nothing when the customer's key served it.
      expect(compareDecimal(DEFAULT_RUN_PRICING.modelCredits('0.0096', { ...DEFAULT_RUN_PRICING.model, byok: true }), '0')).toBe(0);
    });
  }
});

describe('a brain finish closes its plan', () => {
  /**
   * MUTATIONS THIS CATCHES: a brain done that reaches the loop's finish gate
   * with its sub-goals open — refused three times, then force-closed `failed`
   * and reported `partial` with a complete answer (live10 on main 600e4e28,
   * 4 of 10 correct runs, 2026-10-02); and a port that closes the plan on a
   * step that is not the finish.
   */
  test('a 3-goal plan and a correct done end completed, with no refused done', async () => {
    const page = cartPage(17_000);
    const checkout = refOf(page, 'Checkout');
    const provider = new FakeProvider([
      reply(
        JSON.stringify({
          do: 'act',
          a: { type: 'click', ref: `0-${String(checkout.backendNodeId)}` },
          need: ['cart opened', 'checked out', 'total reported'],
          plan: [
            { id: 'g1', goal: 'open the cart' },
            { id: 'g2', goal: 'check out' },
            { id: 'g3', goal: 'report the total' },
          ],
        }),
        {},
        '0.003',
      ),
      reply(JSON.stringify({ do: 'done', why: 'checked out; total on the page', answer: 'Checked out; the total is £42.00' }), {}, '0.003'),
    ]);
    const ledger = new CostLedger();
    const port = new HarnessModelPort({
      plan: brainPlan(),
      provider,
      session: { sessionId: 'run-goals', accountId: 'acct-9' },
      ledger,
      clock: new VirtualClock(),
      actionReasoning: { enabled: false },
    });
    const result = await runAgent(
      {
        snapshot: () => page,
        lock: () => undefined,
        unlock: () => undefined,
        perform: () => ({}),
        extract: () => Promise.reject(new Error('no extraction in this run')),
        model: port.choose,
        modelCostUsd: () => ledger.totalsFor('run-goals').costUsd,
        clock: new VirtualClock(),
      },
      { task: 'check out and report the total', caps: { steps: 8, budget: '50.00', duration: '5m' }, stepFailures: null, settle: false },
    );

    expect(result.status).toBe('completed');
    expect(result.steps.filter((step) => (step.error ?? '').startsWith('done was refused'))).toHaveLength(0);
    expect(result.goals.map((goal) => [goal.id, goal.status])).toEqual([
      ['g1', 'done'],
      ['g2', 'done'],
      ['g3', 'done'],
    ]);
    // Two brain calls: the plan, and the finish that closed it.
    expect(provider.requests).toHaveLength(2);
  });
});

describe('an answer that names its own gap does not end completed', () => {
  /**
   * The live reply, replayed (live10 on bundle 5f576d15, 2026-10-03,
   * `run_2d2ea3f1`, hn-ranks-61-70): the brain marked a read final, the
   * extractor answered "61. (missing)" with ranks 62-70 shifted by one and
   * called it complete, and the run ended `completed` on it.
   * MUTATIONS THIS CATCHES: a final read whose answer marks an item missing
   * ending the run; the loop's reason not reaching the brain; a done carrying
   * the same gap reported `completed`.
   */
  test('the final read is kept as a look, the brain is told why, and a gapped done ends partial', async () => {
    const page = cartPage(18_000);
    const checkout = refOf(page, 'Checkout');
    const gapped = '61. (missing)\n62. How accurately calibrated is a forecast?\n63. Lace and Labor: Lessons from the actual Luddites';
    const provider = new FakeProvider([
      reply(JSON.stringify({ do: 'act', a: { type: 'click', ref: `0-${String(checkout.backendNodeId)}` }, need: ['titles ranked 61-63'] }), {}, '0.003'),
      reply(JSON.stringify({ do: 'read', read: 'titles of the stories ranked 61 to 63', final: true }), {}, '0.002'),
      // The extractor's own reply: complete, by its word.
      reply(JSON.stringify({ answer: gapped, complete: true, missing: '' }), {}, '0.0002'),
      reply(JSON.stringify({ do: 'done', why: 'rank 61 not readable', answer: gapped }), {}, '0.003'),
    ]);
    const ledger = new CostLedger();
    const port = new HarnessModelPort({
      plan: brainPlan(),
      provider,
      session: { sessionId: 'run-gap', accountId: 'acct-9' },
      ledger,
      clock: new VirtualClock(),
      actionReasoning: { enabled: false },
    });
    const result = await runAgent(
      {
        snapshot: () => page,
        lock: () => undefined,
        unlock: () => undefined,
        perform: () => ({}),
        extract: async (schema, instruction): Promise<ExtractOutcome> => {
          const out = await port.extract({ instruction: instruction ?? null, schema: schema ?? null, content: { kind: 'tree', tree: page } });
          return { data: out.data, ...(out.usage === undefined ? {} : { usage: out.usage }) };
        },
        model: port.choose,
        modelCostUsd: () => ledger.totalsFor('run-gap').costUsd,
        clock: new VirtualClock(),
      },
      { task: 'list the titles ranked 61 to 63', caps: { steps: 8, budget: '50.00', duration: '5m' }, stepFailures: null, settle: false },
    );

    // The final read did not end the run: the brain was asked again, and told why.
    expect(provider.requests).toHaveLength(4);
    expect(provider.requests[3]?.prompt).toContain('HELD, not the answer');
    // The finish that kept the gap is not `completed`.
    expect(result.status).toBe('partial');
    expect(result.data).toBe(gapped);
  });
});

describe('a typed run takes a JSON finish as its object', () => {
  /**
   * The live reply, replayed (run_df6180ab, bundle 5f576d15, 2026-10-03
   * 01:01Z, schema {title}): the brain's done answer was already the schema's
   * object, the loop wrapped it into the `title` string, it validated, and the
   * run returned `{"title":"{\"title\":...}"}` as `completed`.
   * MUTATION THIS CATCHES: stringifying an object answer into a string field.
   */
  test('a done whose answer is the schema object returns that object', async () => {
    const page = cartPage(19_000);
    const provider = new FakeProvider([
      reply(JSON.stringify({ do: 'done', why: 'title on the page', answer: '{"title":"The Forgetful CPU (Linux on M4)"}' }), {}, '0.003'),
    ]);
    const ledger = new CostLedger();
    const port = new HarnessModelPort({
      plan: brainPlan(),
      provider,
      session: { sessionId: 'run-typed', accountId: 'acct-9' },
      ledger,
      clock: new VirtualClock(),
      actionReasoning: { enabled: false },
    });
    const result = await runAgent(
      {
        snapshot: () => page,
        lock: () => undefined,
        unlock: () => undefined,
        perform: () => ({}),
        extract: () => Promise.reject(new Error('no extraction in this run')),
        model: port.choose,
        modelCostUsd: () => ledger.totalsFor('run-typed').costUsd,
        clock: new VirtualClock(),
      },
      {
        task: 'give the title of the top story',
        schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        caps: { steps: 5, budget: '50.00', duration: '5m' },
       
        stepFailures: null,
        settle: false,
      },
    );
    expect(result.data).toEqual({ title: 'The Forgetful CPU (Linux on M4)' });
    expect(result.status).toBe('completed');
  });
});
