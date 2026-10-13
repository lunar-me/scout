/**
 * `purchase.begin` and `purchase.end`: what the loop sends the purchases port,
 * and what it does with each answer.
 *
 * The property every test here defends is the one the spend cap stands on:
 * the merchant is the page's, never the model's, and a purchase that needs a
 * person's approval parks the run on a structured question and is decided by
 * the edge at the SAME step, so the edge's idempotency key holds.
 */
import { describe, expect, test } from 'bun:test';

import type { Purchase, PurchaseBeginAnswer, PurchaseEndAnswer, RunPurchases } from '@outcrawl/scout-core';

import type { Action } from '../src/actions';
import { validateAction } from '../src/actions';
import { runAgent } from '../src/loop';
import type { AskAnswer, AskedQuestion, DurableRecord, StepTrace } from '../src/result';
import { catalogueTree, harness, tree, node } from './support';

const CAPS = { steps: 8, budget: '2.00', duration: '5m' };
const CHECKOUT = tree(node({ role: 'RootWebArea', name: 'Checkout' }), 'https://www.staples.com/checkout?cart=9');
const done: Action = { type: 'done', summary: 'bought' };

function purchase(over: Partial<Purchase> = {}): Purchase {
  return {
    id: 'pur_1',
    runId: 'run_1',
    merchant: 'staples.com',
    amount: '84.20',
    currency: 'USD',
    card: { source: null, handle: null, provider: null, brand: null, last4: null, providerCardId: null },
    status: 'reserved',
    orderRef: null,
    createdAt: '2026-10-08T00:00:00.000Z',
    settledAt: null,
    ...over,
  };
}

/** A purchases port that records every call and answers from a script. */
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

/** The model's raw reply, which may carry fields the action has no slot for. */
const raw = (action: Record<string, unknown>): Action => action as unknown as Action;

describe('purchase.begin', () => {
  test('the merchant is the page origin; a merchant the model sends goes nowhere', async () => {
    const purchases = fakePurchases([{ kind: 'opened', purchase: purchase(), replay: false }]);
    const h = harness({
      model: (_prompt, step) => ({
        action:
          step === 0
            ? raw({ type: 'purchase.begin', amount: '84.20', currency: 'USD', merchant: 'attacker.example' })
            : done,
      }),
      tree: CHECKOUT,
    });
    const steps: StepTrace[] = [];
    const result = await runAgent(h.deps, {
      task: 'buy pens', caps: CAPS, stepFailures: 0, purchases, onStep: (step) => steps.push(step),
    });

    expect(result.status).toBe('completed');
    expect(purchases.begun).toEqual([
      { step: 0, amount: '84.20', currency: 'USD', topLevelOrigin: 'https://www.staples.com' },
    ]);
    expect(JSON.stringify(purchases.begun)).not.toContain('attacker');
    expect(JSON.stringify(steps[0]?.action)).not.toContain('merchant');
    // Nothing reached the page: the verb is the port's, not the browser's.
    expect(h.performed).toEqual([]);
    // The next decision is told the purchase is open, by id.
    expect(h.prompts[1]?.text).toContain('Purchase pur_1 is open');
  });

  test('the grammar and rule are offered only to a run with a purchases port', async () => {
    const run = async (purchases?: RunPurchases): Promise<string> => {
      const h = harness({ model: () => ({ action: done }), tree: catalogueTree() });
      await runAgent(h.deps, { task: 't', caps: CAPS, stepFailures: 0, ...(purchases === undefined ? {} : { purchases }) });
      return h.prompts[0]?.text ?? '';
    };
    expect(await run(fakePurchases([]))).toContain('"type":"purchase.begin"');
    expect(await run(fakePurchases([]))).toContain('Before filling any card field, open a purchase');
    expect(await run()).not.toContain('purchase.begin');
  });

  test('without a purchases port the step fails with a sentence, and the run goes on', async () => {
    const h = harness({
      model: (_prompt, step) => ({
        action: step === 0 ? { type: 'purchase.begin', amount: '10.00', currency: 'USD' } : done,
      }),
      tree: CHECKOUT,
    });
    const steps: StepTrace[] = [];
    const result = await runAgent(h.deps, { task: 't', caps: CAPS, stepFailures: 1, onStep: (step) => steps.push(step) });
    expect(steps[0]?.error).toContain('this run has no spend cap');
    expect(result.status).toBe('completed');
  });

  test('a refusal fails the step with its code and message', async () => {
    const purchases = fakePurchases([
      { kind: 'refused', code: 'merchant_not_allowed', message: 'This site is not on the allow-list.' },
    ]);
    const h = harness({
      model: (_prompt, step) => ({
        action: step === 0 ? { type: 'purchase.begin', amount: '10.00', currency: 'USD' } : done,
      }),
      tree: CHECKOUT,
    });
    const steps: StepTrace[] = [];
    await runAgent(h.deps, { task: 't', caps: CAPS, stepFailures: 1, purchases, onStep: (step) => steps.push(step) });
    expect(steps[0]?.error).toBe('merchant_not_allowed: This site is not on the allow-list.');
  });
});

describe('purchase approval', () => {
  const question = { kind: 'approval', purchase: 'pur_1', merchant: 'staples.com', amount: '84.20', currency: 'USD' } as const;

  test('parks with ask.kind approval, then begins again at the SAME step and proceeds', async () => {
    const purchases = fakePurchases([
      { kind: 'approval_required', question },
      { kind: 'opened', purchase: purchase(), replay: false },
    ]);
    const asked: AskedQuestion[] = [];
    const records: DurableRecord[] = [];
    let deliver: ((reply: AskAnswer) => void) | undefined;
    const h = harness({
      model: (_prompt, step) => ({
        action: step === 0 ? { type: 'purchase.begin', amount: '84.20', currency: 'USD' } : done,
      }),
      tree: CHECKOUT,
    });
    const steps: StepTrace[] = [];
    const run = runAgent(h.deps, {
      task: 'buy pens', caps: CAPS, stepFailures: 0, purchases,
      onStep: (step) => steps.push(step),
      onRecord: (record) => { records.push(record); },
      onAsk: (q) => {
        asked.push(q);
        return new Promise<AskAnswer>((resolve) => { deliver = resolve; });
      },
    });
    for (let turn = 0; turn < 400 && deliver === undefined; turn += 1) await Promise.resolve();

    // PARKED on the structured question, which is what the edge writes to
    // pause.ask, and the human-readable string beside it.
    expect(asked).toHaveLength(1);
    expect(asked[0]?.ask).toEqual(question);
    expect(asked[0]?.question).toBe('Approve a purchase of 84.20 USD at staples.com?');
    const recorded = records.find((record) => record.kind === 'question');
    expect((recorded?.body as AskedQuestion | undefined)?.ask?.kind).toBe('approval');
    expect(purchases.begun).toHaveLength(1);
    expect(h.browser.frozen).toBe(false);

    deliver?.({ answer: 'approved' });
    const result = await run;

    expect(result.status).toBe('completed');
    // The same step both times: the edge's (run, step) key holds.
    expect(purchases.begun.map((call) => call.step)).toEqual([0, 0]);
    expect(purchases.begun[1]).toEqual(purchases.begun[0]);
    expect(purchases.begun[1]?.approvalExpired).toBeUndefined();
    expect(steps.map((step) => step.error)).toEqual([undefined, undefined]);
    // The finding closes the park on the run row (the edge waits for it).
    expect(records.filter((record) => record.kind === 'finding' && record.step === 0)).toHaveLength(1);
    expect(h.prompts[1]?.text).toContain('Purchase pur_1 is open');
  });

  test('nobody answering begins again with approvalExpired and fails approval_timed_out', async () => {
    const purchases = fakePurchases([
      { kind: 'approval_required', question },
      { kind: 'refused', code: 'approval_timed_out', message: 'Nobody answered this purchase approval in time.' },
    ]);
    const h = harness({
      model: (_prompt, step) => ({
        action: step === 0 ? { type: 'purchase.begin', amount: '84.20', currency: 'USD' } : done,
      }),
      tree: CHECKOUT,
    });
    const steps: StepTrace[] = [];
    await runAgent(h.deps, {
      task: 'buy pens', caps: CAPS, stepFailures: 1, purchases,
      onStep: (step) => steps.push(step),
      onAsk: async () => ({ answer: undefined }),
    });
    expect(purchases.begun).toEqual([
      { step: 0, amount: '84.20', currency: 'USD', topLevelOrigin: 'https://www.staples.com' },
      { step: 0, amount: '84.20', currency: 'USD', topLevelOrigin: 'https://www.staples.com', approvalExpired: true },
    ]);
    expect(steps[0]?.error).toBe('approval_timed_out: Nobody answered this purchase approval in time.');
  });
});

describe('purchase.end', () => {
  test('settles with the wire fields mapped, keyed by its own step', async () => {
    const purchases = fakePurchases(
      [{ kind: 'opened', purchase: purchase(), replay: false }],
      [
        { kind: 'settled', purchase: purchase({ status: 'completed', amount: '86.10', orderRef: 'W123' }), replay: false },
        { kind: 'refused', code: 'no_open_purchase', message: 'Nothing is open to close.' },
      ],
    );
    const h = harness({
      model: (_prompt, step) => ({
        action: [
          { type: 'purchase.begin', amount: '84.20', currency: 'USD' },
          raw({ type: 'purchase.end', value: 'completed', amount: '86.10', text: 'W123' }),
          raw({ type: 'purchase.end', value: 'completed' }),
          done,
        ][step] as Action,
      }),
      tree: CHECKOUT,
    });
    const steps: StepTrace[] = [];
    await runAgent(h.deps, { task: 't', caps: CAPS, stepFailures: 1, purchases, onStep: (step) => steps.push(step) });
    expect(purchases.ended).toEqual([
      { step: 1, outcome: 'completed', amountFinal: '86.10', orderRef: 'W123' },
      { step: 2, outcome: 'completed' },
    ]);
    expect(steps[1]?.error).toBeUndefined();
    expect(h.prompts[2]?.text).toContain('Purchase pur_1 is closed as completed');
    expect(steps[2]?.error).toBe('no_open_purchase: Nothing is open to close.');
  });

  /**
   * run_… (2026-10-08): both real ports hand the loop the VALIDATED
   * action, and the loop validates it again. The test above feeds the wire
   * form, which no production port returns, so it never saw that the second
   * pass refused every purchase.end ("value ... got undefined") and three of
   * them ended the run.
   */
  test('settles the action a port already validated, as both model ports return it', async () => {
    const purchases = fakePurchases(
      [{ kind: 'opened', purchase: purchase(), replay: false }],
      [{ kind: 'settled', purchase: purchase({ status: 'abandoned' }), replay: false }],
    );
    const validated = validateAction({ type: 'purchase.end', value: 'abandoned', amount: '84.20', text: '' }, CHECKOUT);
    if (!validated.ok) throw new Error(validated.errors.join('; '));
    const h = harness({
      model: (_prompt, step) => ({
        action: [{ type: 'purchase.begin', amount: '84.20', currency: 'USD' } as Action, validated.value, done][step] as Action,
      }),
      tree: CHECKOUT,
    });
    const steps: StepTrace[] = [];
    const result = await runAgent(h.deps, { task: 't', caps: CAPS, stepFailures: 0, purchases, onStep: (step) => steps.push(step) });
    expect(steps[1]?.error).toBeUndefined();
    expect(purchases.ended).toEqual([{ step: 1, outcome: 'abandoned', amountFinal: '84.20' }]);
    expect(result.status).toBe('completed');
  });
});

describe('validateAction on purchase verbs', () => {
  const page = catalogueTree();
  const errorsOf = (action: Record<string, unknown>): readonly string[] => {
    const result = validateAction(action, page);
    return result.ok ? [] : result.errors;
  };

  test('refuses a float amount, a lowercase currency and an unknown outcome', () => {
    expect(errorsOf({ type: 'purchase.begin', amount: 84.2, currency: 'USD' })[0]).toContain('amount must be the total as a decimal string');
    expect(errorsOf({ type: 'purchase.begin', amount: '$84.20', currency: 'USD' })).toHaveLength(1);
    expect(errorsOf({ type: 'purchase.begin', amount: '84.20', currency: 'usd' })[0]).toContain('ISO 4217');
    expect(errorsOf({ type: 'purchase.end', value: 'refunded' })[0]).toContain('completed, declined, abandoned or unknown');
  });

  test('a purchase at nothing is refused, so the model reads the total first', () => {
    // run_…, 2026-10-08: a page showing no total was opened at "0.00",
    // and every limit then compared against 0.
    for (const amount of ['0', '0.00', '000.0']) {
      expect(errorsOf({ type: 'purchase.begin', amount, currency: 'USD' })[0]).toContain('more than 0');
    }
    expect(errorsOf({ type: 'purchase.begin', amount: '0.01', currency: 'USD' })).toEqual([]);
  });

  test('drops a merchant and maps end fields off the shared schema names', () => {
    expect(validateAction({ type: 'purchase.begin', amount: '84.20', currency: 'USD', merchant: 'x.example' }, page)).toEqual({
      ok: true,
      value: { type: 'purchase.begin', amount: '84.20', currency: 'USD' },
    });
    expect(validateAction({ type: 'purchase.end', value: 'declined', amount: '', text: ' W1 ' }, page)).toEqual({
      ok: true,
      value: { type: 'purchase.end', outcome: 'declined', orderRef: 'W1' },
    });
  });

  test('a purchase.end with no outcome is refused with the action to send spelled out', () => {
    const [refusal] = errorsOf({ type: 'purchase.end', amount: '84.20' });
    expect(refusal).toContain('got undefined');
    expect(refusal).toContain('{"type":"purchase.end","value":"<completed|declined|abandoned|unknown>"');
  });

  test('never echoes a card number in a refusal', () => {
    const pan = '4242424242424242';
    expect(errorsOf({ type: 'purchase.begin', amount: pan + '.00x', currency: 'USD' }).join(' ')).not.toContain(pan);
    expect(errorsOf({ type: 'purchase.end', value: 'completed', text: `order ${pan}` }).join(' ')).not.toContain(pan);
  });
});
