/**
 * `{"type":"ask","value":"card"}`: a run that reaches checkout holding no card
 * asks a PERSON for one through the run secret channel, and resumes when it
 * arrives (wire contract §4, `want: "card" | "details"`).
 *
 * The properties defended: the ask is offered only to a run that may buy, can
 * reach a person and holds no card; the question names the open purchase the
 * loop holds; the next prompt names the placeholders that arrived and never a
 * value; nobody answering fails the step with the abandon-and-end-partial
 * instruction, so a run without a card never ends silently wrong.
 */
import { describe, expect, test } from 'bun:test';

import type { Purchase, RunSecretAskWant, RunSecretAsks } from '@outcrawl/scout-core';

import type { Action } from '../src/actions';
import { validateAction } from '../src/actions';
import { askWantRule, runAgent } from '../src/loop';
import type { StepTrace } from '../src/result';
import { harness, node, tree } from './support';

const CAPS = { steps: 8, budget: '2.00', duration: '5m' };
const SPEND = { ...CAPS, spend: { limit: '100.00', currency: 'USD' } };
const CHECKOUT = tree(node({ role: 'RootWebArea', name: 'Checkout' }), 'https://checkout.stripe.dev/c/pay/cs_test_1');
const done: Action = { type: 'done', summary: 'paid' };
const ASK_CARD = '{"type":"ask","value":"card"}';
const ASK_DETAILS = '{"type":"ask","value":"details"}';
const CARD_FIELDS = ['number', 'exp_month', 'exp_year', 'exp', 'name', 'postal_code', 'cvc'];

const OPEN: Purchase = {
  id: 'pur_1a7007d3da7879cfbd31abf3',
  runId: 'run_1',
  merchant: 'stripe.dev',
  amount: '28.80',
  currency: 'USD',
  card: { source: null, handle: null, provider: null, brand: null, last4: null, providerCardId: null },
  status: 'reserved',
  orderRef: null,
  createdAt: '2026-10-08T00:00:00.000Z',
  settledAt: null,
};

/** A run's card asks: what it holds, and a person who adds one (or nobody). */
function fakeAsks(
  arrives: boolean,
  held: Record<RunSecretAskWant, boolean> = { card: false, details: false },
): RunSecretAsks & { asked: { want: RunSecretAskWant; purchase: unknown }[]; held: Record<RunSecretAskWant, boolean> } {
  const asked: { want: RunSecretAskWant; purchase: unknown }[] = [];
  return {
    asked,
    held,
    holds: (want) => held[want],
    ask: async (want, purchase) => {
      asked.push({ want, purchase });
      if (!arrives) return undefined;
      held[want] = true;
      return { for: want, fields: CARD_FIELDS };
    },
  };
}

/** A purchases port that opens {@link OPEN} on every begin. */
const purchases = {
  begin: async () => ({ kind: 'opened' as const, purchase: OPEN, replay: false }),
  end: async () => ({ kind: 'settled' as const, purchase: { ...OPEN, status: 'abandoned' as const }, replay: false }),
};

describe('the ask action, validated', () => {
  test('the wire form {"type":"ask","value":"card"} validates to want, and its own output validates to itself', () => {
    const first = validateAction({ type: 'ask', value: 'card' }, CHECKOUT);
    expect(first).toEqual({ ok: true, value: { type: 'ask', want: 'card' } });
    // Both model ports hand the loop an already-validated action and the loop
    // validates it again: purchase.end's run_… defect.
    const second = first.ok ? validateAction(first.value, CHECKOUT) : first;
    expect(second).toEqual(first);
    expect(validateAction({ type: 'ask', want: 'details', question: 'card please' }, CHECKOUT)).toEqual({
      ok: true,
      value: { type: 'ask', want: 'details' },
    });
  });

  test('a want that is not card or details is refused; a question with an empty value stays a question', () => {
    const refused = validateAction({ type: 'ask', value: 'passport' }, CHECKOUT);
    expect(refused.ok ? '' : refused.errors.join('; ')).toContain(ASK_CARD);
    expect(validateAction({ type: 'ask', want: 'cvc' }, CHECKOUT).ok).toBe(false);
    expect(validateAction({ type: 'ask', question: 'Which size?', value: '' }, CHECKOUT)).toEqual({
      ok: true,
      value: { type: 'ask', question: 'Which size?' },
    });
  });
});

describe('the ask is offered', () => {
  const firstPrompt = async (caps: typeof CAPS, secretAsks?: RunSecretAsks): Promise<string> => {
    const h = harness({ model: () => ({ action: done }), tree: CHECKOUT });
    await runAgent(h.deps, {
      task: 'buy the test product',
      caps,
      stepFailures: 0,
      purchases,
      ...(secretAsks === undefined ? {} : { secretAsks }),
    });
    return h.prompts[0]?.text ?? '';
  };

  test('only with a spend cap, a person to ask, and no card held', async () => {
    const open = await firstPrompt(SPEND, fakeAsks(true));
    expect(open).toContain(ASK_CARD);
    expect(open).toContain(ASK_DETAILS);
    expect(open).toContain(askWantRule(['card', 'details']));

    const holdingCard = await firstPrompt(SPEND, fakeAsks(true, { card: true, details: false }));
    expect(holdingCard).not.toContain(ASK_CARD);
    expect(holdingCard).toContain(ASK_DETAILS);

    expect(await firstPrompt(CAPS, fakeAsks(true))).not.toContain(ASK_CARD);
    expect(await firstPrompt(SPEND)).not.toContain(ASK_CARD);
  });
});

describe('the ask, performed', () => {
  test('names the open purchase, resumes on arrival, and the next prompt lists the placeholders and the refreshed grammar', async () => {
    const asks = fakeAsks(true);
    const h = harness({
      model: (_prompt, step) => ({
        action:
          step === 0
            ? { type: 'purchase.begin', amount: '28.80', currency: 'USD' }
            : step === 1
              ? ({ type: 'ask', value: 'card' } as unknown as Action)
              : done,
      }),
      tree: CHECKOUT,
    });
    const steps: StepTrace[] = [];
    const result = await runAgent(
      { ...h.deps, secretGrammar: () => (asks.held.card ? 'Secrets: card (placeholders {{secret:card.number}})' : undefined) },
      { task: 'buy the test product', caps: SPEND, stepFailures: 0, purchases, secretAsks: asks, onStep: (step) => steps.push(step) },
    );

    expect(result.status).toBe('completed');
    expect(asks.asked).toEqual([{ want: 'card', purchase: OPEN }]);
    expect(steps[1]?.error).toBeUndefined();
    expect(steps[1]?.action).toEqual({ type: 'ask', want: 'card' });
    const next = h.prompts[2]?.text ?? '';
    expect(next).toContain(
      'A card arrived for this run as card: fill {{secret:card.number}}, {{secret:card.exp_month}}, {{secret:card.exp_year}}, ' +
        '{{secret:card.exp}}, {{secret:card.name}}, {{secret:card.postal_code}}, {{secret:card.cvc}}.',
    );
    expect(next).toContain('Secrets: card (placeholders {{secret:card.number}})');
    // The card arrived, so it is no longer asked for.
    expect(next).not.toContain(ASK_CARD);
    expect(h.prompts[0]?.text).not.toContain('Secrets: card');
  });

  test('with no purchase open the ask names none', async () => {
    const asks = fakeAsks(true);
    const h = harness({
      model: (_prompt, step) => ({ action: step === 0 ? ({ type: 'ask', want: 'card' } as Action) : done }),
      tree: CHECKOUT,
    });
    await runAgent(h.deps, { task: 't', caps: SPEND, stepFailures: 0, purchases, secretAsks: asks });
    expect(asks.asked).toEqual([{ want: 'card', purchase: undefined }]);
  });

  test('a question asking for card details is refused on a run offered the card ask, and allowed once a card is held', async () => {
    const question: Action = { type: 'ask', question: 'Please provide your card details (number, expiry, CVC) to complete the payment.' };
    const run = async (held: boolean): Promise<{ steps: StepTrace[]; asked: number }> => {
      let asked = 0;
      const h = harness({ model: (_prompt, step) => ({ action: step === 0 ? question : done }), tree: CHECKOUT });
      const steps: StepTrace[] = [];
      await runAgent(h.deps, {
        task: 't', caps: SPEND, stepFailures: 1, purchases, secretAsks: fakeAsks(true, { card: held, details: held }),
        onAsk: async () => { asked += 1; return { answer: 'ok' }; }, onStep: (step) => steps.push(step),
      });
      return { steps, asked };
    };
    const refused = await run(false);
    expect(refused.asked).toBe(0);
    expect(refused.steps[0]?.error).toContain(`Send ${ASK_CARD} or ${ASK_DETAILS} instead, with no question.`);
    const allowed = await run(true);
    expect(allowed.asked).toBe(1);
  });

  test('nobody adding a card by the ask timeout fails the step with the abandon and end-partial instruction', async () => {
    const asks = fakeAsks(false);
    const h = harness({
      model: (_prompt, step) => ({
        action:
          step === 0
            ? { type: 'purchase.begin', amount: '28.80', currency: 'USD' }
            : step === 1
              ? ({ type: 'ask', value: 'card' } as unknown as Action)
              : done,
      }),
      tree: CHECKOUT,
    });
    const steps: StepTrace[] = [];
    await runAgent(h.deps, {
      task: 't', caps: SPEND, stepFailures: 1, purchases, secretAsks: asks, onStep: (step) => steps.push(step),
    });
    expect(steps[1]?.error).toContain('nobody added a card for this run in time');
    expect(steps[1]?.error).toContain('{"type":"purchase.end","value":"abandoned"}');
    expect(steps[1]?.error).toContain('end the run partial, saying a card was not provided');
    expect(h.prompts[2]?.text).toContain('nobody added a card for this run in time');
  });
});
