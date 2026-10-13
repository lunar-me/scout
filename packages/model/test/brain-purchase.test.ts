/**
 * scout-1's brain on a spending run: what it is shown, and where its purchase
 * verbs go. Driven through the real `runAgent` and the real `HarnessModelPort`
 * with a brain plan of the production shape (`brainPlan` in `./support`), so
 * the brain prompt asserted is the one the port sends.
 *
 * Production probe run_f340ace4 (fleet, 2026-10-08 20:40Z, caps.spend 500
 * USD, merchants ["stripe.dev"]): the brain filled `{{secret:card_probe}}`,
 * was refused by the reveal gate ("Open one with purchase.begin ..."), then
 * emitted `callTool` with tool `purchase.begin`, and failed saying the tool
 * was not connected. Its prompt had never offered the verb.
 */
import { describe, expect, test } from 'bun:test';
import {
  SPEND_REFUSAL_MESSAGES,
  secretGrammarFor,
  type Purchase,
  type PurchaseBeginAnswer,
  type PurchaseEndAnswer,
  type RunPurchases,
  type RunSecretAsks,
} from '@outcrawl/scout-core';
import {
  ASK_RULE,
  askWantRule,
  PURCHASE_GRAMMAR,
  PURCHASE_RULE,
  runAgent,
  validateAction,
  type AgentDeps,
  type AskedQuestion,
  type AxTree,
  type StepTrace,
} from '@outcrawl/runtime';

import { HarnessModelPort } from '../src/harness';
import { CostLedger } from '../src/ledger';
import { BRAIN_MODEL as BRAIN, FakeProvider, HANDS_MODEL as HANDS, VirtualClock, brainPlan, cartPage, reply, type ScriptedTurn } from './support';

const CAPS = { steps: 6, budget: '50.00', duration: '5m' };
/** The begin action exactly as every refusal now spells it. */
const BEGIN = '{"type":"purchase.begin","amount":"<checkout total>","currency":"<code>"}';

/** A Stripe checkout page small enough for the raw view: no eyes call. */
const CHECKOUT: AxTree = { ...cartPage(30), url: 'https://checkout.stripe.dev/c/pay/cs_test_1#fid' };

function purchase(): Purchase {
  return {
    id: 'pur_1',
    runId: 'run_1',
    merchant: 'stripe.dev',
    amount: '12.00',
    currency: 'USD',
    card: { source: null, handle: null, provider: null, brand: null, last4: null, providerCardId: null },
    status: 'reserved',
    orderRef: null,
    createdAt: '2026-10-08T00:00:00.000Z',
    settledAt: null,
  };
}

function fakePurchases(
  begins: readonly PurchaseBeginAnswer[],
  ends: readonly PurchaseEndAnswer[] = [],
): RunPurchases & { begun: Parameters<RunPurchases['begin']>[0][]; ended: Parameters<RunPurchases['end']>[0][] } {
  const begun: Parameters<RunPurchases['begin']>[0][] = [];
  const ended: Parameters<RunPurchases['end']>[0][] = [];
  return {
    begun,
    ended,
    begin: async (input) => {
      begun.push(input);
      const answer = begins[begun.length - 1];
      if (answer === undefined) throw new Error('unscripted begin');
      return answer;
    },
    end: async (input) => {
      ended.push(input);
      const answer = ends[ended.length - 1];
      if (answer === undefined) throw new Error('unscripted end');
      return answer;
    },
  };
}

const brain = (decision: Record<string, unknown>): ScriptedTurn => reply(JSON.stringify(decision), {}, '0.002');
const finish = brain({ do: 'done', why: 'done', answer: 'done' });

async function brainRun(
  turns: readonly ScriptedTurn[],
  extra: {
    purchases?: RunPurchases;
    onAsk?: (question: AskedQuestion) => Promise<{ answer: string }>;
    /** The run's secret grammar: fixed, or as of each prompt (a secret that arrives mid-run). */
    secretGrammar?: string | (() => string | undefined);
    /** A spend cap and a person to ask for a card: the run `ask want card` is offered on. */
    secretAsks?: RunSecretAsks;
    /** No brain in the plan: the hands model alone, as the hands path's prompt and schema. */
    brainOff?: true;
  } = {},
): Promise<{ provider: FakeProvider; steps: StepTrace[]; performed: unknown[]; status: string }> {
  const provider = new FakeProvider(turns);
  const ledger = new CostLedger();
  const port = new HarnessModelPort({
    plan: brainPlan(extra.brainOff === undefined ? {} : null),
    provider,
    session: { sessionId: 'run-spend', accountId: 'acct-9' },
    ledger,
    clock: new VirtualClock(),
    actionReasoning: { enabled: false },
  });
  const performed: unknown[] = [];
  const grammar = extra.secretGrammar;
  const deps: AgentDeps = {
    snapshot: () => CHECKOUT,
    lock: () => undefined,
    unlock: () => undefined,
    perform: (action) => {
      performed.push(action);
      return {};
    },
    extract: () => Promise.reject(new Error('no extraction in this run')),
    model: port.choose,
    modelCostUsd: () => ledger.totalsFor('run-spend').costUsd,
    clock: new VirtualClock(),
    ...(grammar === undefined ? {} : { secretGrammar: typeof grammar === 'string' ? () => grammar : grammar }),
  };
  const steps: StepTrace[] = [];
  const result = await runAgent(deps, {
    task: 'buy the test product',
    caps: extra.secretAsks === undefined ? CAPS : { ...CAPS, spend: { limit: '100.00', currency: 'USD' } },
    stepFailures: 1,
    settle: false,
    onStep: (step) => steps.push(step),
    ...(extra.purchases === undefined ? {} : { purchases: extra.purchases }),
    ...(extra.onAsk === undefined ? {} : { onAsk: extra.onAsk }),
    ...(extra.secretAsks === undefined ? {} : { secretAsks: extra.secretAsks }),
  });
  return { provider, steps, performed, status: result.status };
}

/** Everything the brain read on its first call: system turn, replayed turns, the step, its tail. */
function brainSaw(provider: FakeProvider, index = 0): string {
  const request = provider.requests.filter((entry) => entry.model === BRAIN)[index];
  return JSON.stringify(request ?? null);
}

describe('scout-1 brain on a run with a purchases port', () => {
  /**
   * MUTATIONS THIS CATCHES: the brain's instructions not carrying the verbs
   * or the rule (run_f340ace4); a copy of the grammar drifting from the
   * loop's; the verbs leaking into a run that cannot buy.
   */
  test('the brain is shown the purchase verbs and the rule on a capped run, and neither on an uncapped one', async () => {
    const capped = await brainRun([finish], { purchases: fakePurchases([]) });
    const saw = brainSaw(capped.provider);
    expect(saw).toContain(JSON.stringify(PURCHASE_GRAMMAR).slice(1, -1));
    expect(saw).toContain(JSON.stringify(PURCHASE_RULE).slice(1, -1));

    const uncapped = await brainRun([finish]);
    expect(brainSaw(uncapped.provider)).not.toContain('purchase.begin');
    expect(brainSaw(uncapped.provider)).not.toContain(PURCHASE_RULE.slice(0, 40));
  });

  /**
   * MUTATIONS THIS CATCHES: a brain `purchase.begin` sent to the hands (an
   * extra hands call that may not emit it) or refused as "not run
   * directly"; a merchant taken from anything but the page.
   */
  test('a brain purchase.begin runs directly and reaches the purchases port with the page origin', async () => {
    const purchases = fakePurchases([{ kind: 'opened', purchase: purchase(), replay: false }]);
    const run = await brainRun(
      [brain({ do: 'act', a: { type: 'purchase.begin', amount: '12.00', currency: 'USD', merchant: 'attacker.example' } }), finish],
      { purchases },
    );
    expect(purchases.begun).toEqual([{ step: 0, amount: '12.00', currency: 'USD', topLevelOrigin: 'https://checkout.stripe.dev' }]);
    // The brain alone: no hands call, and nothing reached the page.
    expect(run.provider.requests.map((request) => request.model)).toEqual([BRAIN, BRAIN]);
    expect(run.performed).toEqual([]);
    expect(run.steps[0]?.error).toBeUndefined();
    expect(brainSaw(run.provider, 1)).toContain('Purchase pur_1 is open');
    expect(run.status).toBe('completed');
  });

  test('an uncapped run refuses a brain purchase.begin by name, and the run goes on', async () => {
    const run = await brainRun([brain({ do: 'act', a: { type: 'purchase.begin', amount: '12.00', currency: 'USD' } }), finish]);
    expect(run.steps[0]?.error).toContain('purchase.begin: this run has no spend cap');
    expect(run.status).toBe('completed');
  });

  /**
   * MUTATIONS THIS CATCHES: the run_f340ace4 step 7 shape running as a tool
   * call (and failing as an unconnected tool), or being aliased into the
   * verb instead of refused with the action named.
   */
  test('a callTool naming purchase.begin is refused with the right action named, and the brain then opens it', async () => {
    const purchases = fakePurchases([{ kind: 'opened', purchase: purchase(), replay: false }]);
    const run = await brainRun(
      [
        brain({ do: 'act', a: { type: 'callTool', tool: 'purchase.begin', arguments: {} } }),
        brain({ do: 'act', a: { type: 'purchase.begin', amount: '12.00', currency: 'USD' } }),
        finish,
      ],
      { purchases },
    );
    const redecide = run.provider.requests.filter((request) => request.model === BRAIN)[1];
    expect(redecide?.prompt).toContain(BEGIN);
    expect(redecide?.prompt).toContain('not a tool');
    expect(purchases.begun).toHaveLength(1);
    expect(run.steps[0]?.action).toEqual({ type: 'purchase.begin', amount: '12.00', currency: 'USD' });
  });

  /**
   * run_86d4a00d (2026-10-08): the brain sent this exact shape three times,
   * `value` and all (so did all 17 brain purchase.end replies in 7 runs of
   * the reconstruction, 2026-10-08 22:12-22:16Z), and the loop refused each
   * "value ... got undefined" because `directAction` hands it the VALIDATED
   * action, which names the outcome `outcome`. Three refusals ended the run
   * `error`.
   */
  test('the brain purchase.end production sent settles the purchase, with no hands call', async () => {
    const purchases = fakePurchases(
      [{ kind: 'opened', purchase: purchase(), replay: false }],
      [{ kind: 'settled', purchase: { ...purchase(), status: 'abandoned' }, replay: false }],
    );
    const run = await brainRun(
      [
        brain({ do: 'act', a: { type: 'purchase.begin', amount: '12.00', currency: 'USD' } }),
        brain({ do: 'act', a: { type: 'purchase.end', value: 'abandoned', amount: '12.00', text: '' }, no: 'secret card_probe not granted' }),
        finish,
      ],
      { purchases },
    );
    expect(run.steps[1]?.error).toBeUndefined();
    expect(purchases.ended).toEqual([{ step: 1, outcome: 'abandoned', amountFinal: '12.00' }]);
    expect(run.provider.requests.map((request) => request.model)).toEqual([BRAIN, BRAIN, BRAIN]);
    expect(run.status).toBe('completed');
  });

  /**
   * MUTATIONS THIS CATCHES: a refused brain purchase verb sent to the hands
   * (a hands call for a verb that names no element) or back to the brain
   * without the action spelled out, which cost run_86d4a00d three steps.
   */
  test('a brain purchase.end with no outcome goes back to the brain once with the action spelled out, and settles that step', async () => {
    const purchases = fakePurchases(
      [{ kind: 'opened', purchase: purchase(), replay: false }],
      [{ kind: 'settled', purchase: { ...purchase(), status: 'abandoned' }, replay: false }],
    );
    const run = await brainRun(
      [
        brain({ do: 'act', a: { type: 'purchase.begin', amount: '12.00', currency: 'USD' } }),
        brain({ do: 'act', a: { type: 'purchase.end', amount: '12.00' } }),
        brain({ do: 'act', a: { type: 'purchase.end', value: 'abandoned' } }),
        finish,
      ],
      { purchases },
    );
    const redecide = run.provider.requests.filter((request) => request.model === BRAIN)[2];
    expect(redecide?.prompt).toContain('That purchase.end did not run');
    expect(redecide?.prompt).toContain('{"type":"purchase.end","value":"<completed|declined|abandoned|unknown>"');
    expect(run.provider.requests.map((request) => request.model)).toEqual([BRAIN, BRAIN, BRAIN, BRAIN]);
    expect(run.steps[1]?.error).toBeUndefined();
    expect(purchases.ended).toEqual([{ step: 1, outcome: 'abandoned' }]);
    expect(run.status).toBe('completed');
  });
});

describe('scout-1 hands (brain off) on a run with a purchases port', () => {
  const hands = (actions: readonly Record<string, unknown>[]): ScriptedTurn => reply(JSON.stringify({ reasoning: 'r', actions }), {}, '0.0001');

  /**
   * The paid-scene shape the hands model sent 5 of 8 times (2026-10-08 22:16Z), each
   * refused by the loop's second validation exactly as the brain's was: the
   * client hands the loop the validated action too.
   */
  test('the hands purchase.end the hands model sends settles the purchase', async () => {
    const purchases = fakePurchases(
      [{ kind: 'opened', purchase: purchase(), replay: false }],
      [{ kind: 'settled', purchase: { ...purchase(), status: 'completed', orderRef: 'W123-4567' }, replay: false }],
    );
    const run = await brainRun(
      [
        hands([{ type: 'purchase.begin', amount: '12.00', currency: 'USD' }]),
        hands([{ type: 'purchase.end', value: 'completed', amount: '12.00', text: 'W123-4567' }]),
        hands([{ type: 'done', summary: 'paid, order W123-4567' }]),
      ],
      { purchases, brainOff: true },
    );
    expect(run.provider.requests.map((request) => request.model)).toEqual([HANDS, HANDS, HANDS]);
    expect(run.steps[1]?.error).toBeUndefined();
    expect(purchases.ended).toEqual([{ step: 1, outcome: 'completed', amountFinal: '12.00', orderRef: 'W123-4567' }]);
    expect(run.status).toBe('completed');
  });

  test('a hands purchase.end with no outcome is corrected within the step, told the action to send', async () => {
    const purchases = fakePurchases(
      [{ kind: 'opened', purchase: purchase(), replay: false }],
      [{ kind: 'settled', purchase: { ...purchase(), status: 'abandoned' }, replay: false }],
    );
    const run = await brainRun(
      [
        hands([{ type: 'purchase.begin', amount: '12.00', currency: 'USD' }]),
        hands([{ type: 'purchase.end', amount: '12.00' }]),
        hands([{ type: 'purchase.end', value: 'abandoned' }]),
        hands([{ type: 'done', summary: 'closed' }]),
      ],
      { purchases, brainOff: true },
    );
    expect(run.provider.requests[2]?.prompt).toContain('{"type":"purchase.end","value":"<completed|declined|abandoned|unknown>"');
    expect(run.steps[1]?.error).toBeUndefined();
    expect(purchases.ended).toEqual([{ step: 1, outcome: 'abandoned' }]);
    expect(run.status).toBe('completed');
  });
});

describe('the other loop-only grammar, on the brain path', () => {
  test('the run secret grammar and the ask verb reach the brain only when the run has them', async () => {
    const grammar = secretGrammarFor([{ handle: 'card_probe', kind: 'card', fields: ['number', 'exp'] }]) ?? '';
    const asked: AskedQuestion[] = [];
    const run = await brainRun([brain({ do: 'act', a: { type: 'ask', question: 'Which size?' } }), finish], {
      secretGrammar: grammar,
      onAsk: async (question) => {
        asked.push(question);
        return { answer: 'Large' };
      },
    });
    const saw = brainSaw(run.provider);
    expect(saw).toContain('{{secret:card_probe.number}}');
    expect(saw).toContain(JSON.stringify(ASK_RULE).slice(1, -1));
    // The brain's ask is the loop's ask: parked, answered, no hands call.
    expect(asked.map((question) => question.question)).toEqual(['Which size?']);
    expect(run.provider.requests.map((request) => request.model)).toEqual([BRAIN, BRAIN]);

    const bare = await brainRun([finish]);
    expect(brainSaw(bare.provider)).not.toContain('{{secret:');
    expect(brainSaw(bare.provider)).not.toContain('"type":"ask"');
  });
});

/** A run's card asks: what it holds, and a person who adds one (or nobody). */
function fakeSecretAsks(
  arrives: boolean,
  held: Record<'card' | 'details', boolean> = { card: false, details: false },
): RunSecretAsks & { asked: { want: string; purchase?: string }[]; held: Record<'card' | 'details', boolean> } {
  const asked: { want: string; purchase?: string }[] = [];
  return {
    asked,
    held,
    holds: (want) => held[want],
    ask: async (want, purchase) => {
      asked.push({ want, ...(purchase === undefined ? {} : { purchase: purchase.id }) });
      if (!arrives) return undefined;
      held[want] = true;
      return { for: want, fields: ['number', 'exp_month', 'exp_year', 'exp', 'name', 'postal_code', 'cvc'] };
    },
  };
}

describe('ask want card, on the brain path', () => {
  /**
   * MUTATIONS THIS CATCHES: the want offered to a run that cannot buy, has
   * nobody to ask, or already holds a card; the brain's copy drifting from
   * the loop's rule.
   */
  test('the brain is offered ask want card only with a spend cap, a person to ask, and no card held', async () => {
    const open = await brainRun([finish], { secretAsks: fakeSecretAsks(true) });
    const saw = brainSaw(open.provider);
    expect(saw).toContain(JSON.stringify(askWantRule(['card', 'details'])).slice(1, -1));
    expect(saw).toContain(JSON.stringify('{"type":"ask","value":"card"}').slice(1, -1));

    const holding = await brainRun([finish], { secretAsks: fakeSecretAsks(true, { card: true, details: false }) });
    expect(brainSaw(holding.provider)).not.toContain(JSON.stringify('{"type":"ask","value":"card"}').slice(1, -1));
    expect(brainSaw(holding.provider)).toContain(JSON.stringify('{"type":"ask","value":"details"}').slice(1, -1));

    const unbound = await brainRun([finish], { purchases: fakePurchases([]) });
    expect(brainSaw(unbound.provider)).not.toContain('\\"value\\":\\"card\\"');
  });

  /**
   * MUTATIONS THIS CATCHES: the brain's `ask want card` sent to the hands or
   * refused on the loop's second validation (purchase.end's run_86d4a00d
   * defect); the arrival not naming its placeholders; the brain's header
   * never refreshed after a secret arrived mid-run.
   */
  test('a brain {"do":"act","a":{"type":"ask","want":"card"}} runs directly and the next step names the placeholders', async () => {
    const asks = fakeSecretAsks(true);
    const run = await brainRun([brain({ do: 'act', a: { type: 'ask', want: 'card' } }), finish], {
      secretAsks: asks,
      secretGrammar: () => (asks.held.card ? (secretGrammarFor([{ handle: 'card', kind: 'card', fields: ['number', 'exp', 'name', 'billing'] }]) ?? undefined) : undefined),
    });
    expect(asks.asked).toEqual([{ want: 'card' }]);
    expect(run.steps[0]?.error).toBeUndefined();
    expect(run.provider.requests.map((request) => request.model)).toEqual([BRAIN, BRAIN]);
    const next = brainSaw(run.provider, 1);
    expect(next).toContain('A card arrived for this run as card: fill {{secret:card.number}}, {{secret:card.exp_month}}');
    expect(next).toContain('{{secret:card.cvc}}');
    expect(next).toContain("The run's secrets changed. Now:");
    expect(next).toContain('{{secret:card.exp}} = MM/YY');
    expect(run.status).toBe('completed');
  });
});

describe('the refusal texts', () => {
  test('the reveal gate names the exact begin action, and says it is not a tool', () => {
    expect(SPEND_REFUSAL_MESSAGES.no_open_purchase).toContain(BEGIN);
    expect(SPEND_REFUSAL_MESSAGES.no_open_purchase).toContain('not a tool');
  });

  test('a callTool naming a purchase verb is refused naming the action; a real tool is not', () => {
    const begin = validateAction({ type: 'callTool', tool: 'purchase.begin', arguments: {} }, CHECKOUT);
    expect(begin.ok ? '' : begin.errors.join('; ')).toContain(BEGIN);
    const end = validateAction({ type: 'callTool', tool: 'purchase.end' }, CHECKOUT);
    expect(end.ok ? '' : end.errors.join('; ')).toContain('{"type":"purchase.end"');
    expect(validateAction({ type: 'callTool', tool: 'web.search', arguments: { query: 'x' } }, CHECKOUT).ok).toBe(true);
  });
});
