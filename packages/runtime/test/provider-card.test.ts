/**
 * A run paying with a connected card provider (wallet providers contract §5),
 * as the loop sees `purchase.begin`: a provider that could not make a card
 * raises the existing card ask with the provider's sentence, and a provider
 * that rejected the credential ends the run `failed` with
 * `wallet-provider-revoked` and the edge's sentence as its error.
 */
import { describe, expect, test } from 'bun:test';

import type { Purchase, PurchaseBeginAnswer, RunSecretAskWant, RunSecretAsks } from '@outcrawl/scout-core';

import type { Action } from '../src/actions';
import { runAgent } from '../src/loop';
import type { StepTrace } from '../src/result';
import { harness, node, tree } from './support';

const SPEND = { steps: 8, budget: '2.00', duration: '5m', spend: { limit: '100.00', currency: 'USD' } };
const CHECKOUT = tree(node({ role: 'RootWebArea', name: 'Checkout' }), 'https://checkout.stripe.dev/c/pay/cs_test_1');
const BEGIN: Action = { type: 'purchase.begin', amount: '28.80', currency: 'USD' };
const done: Action = { type: 'done', summary: 'paid' };

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

const ASKED_TEXT =
  'Your agent needs a card to finish a purchase of 28.80 USD at stripe.dev: Privacy.com could not make one because it did not answer or is down right now. Add a card for this run only; it is not saved.';

function purchasesAnswering(answer: PurchaseBeginAnswer) {
  return {
    begin: async () => answer,
    end: async () => ({ kind: 'settled' as const, purchase: { ...OPEN, status: 'abandoned' as const }, replay: false }),
  };
}

function asksRecording(arrives: boolean): RunSecretAsks & { asked: { want: RunSecretAskWant; text: string | undefined }[] } {
  const asked: { want: RunSecretAskWant; text: string | undefined }[] = [];
  return {
    asked,
    holds: () => false,
    ask: async (want, _purchase, text) => {
      asked.push({ want, text });
      return arrives ? { for: 'card', fields: ['number', 'exp', 'cvc'] } : undefined;
    },
  };
}

describe('purchase.begin answered by a card provider', () => {
  test('a provider that made no card raises the card ask with its own sentence, and the arrival is named', async () => {
    const asks = asksRecording(true);
    const h = harness({ model: (_prompt, step) => ({ action: step === 0 ? BEGIN : done }), tree: CHECKOUT });
    const steps: StepTrace[] = [];
    const result = await runAgent(h.deps, {
      task: 'buy the test product',
      caps: SPEND,
      stepFailures: 0,
      purchases: purchasesAnswering({ kind: 'opened', purchase: OPEN, replay: false, cardAsk: ASKED_TEXT }),
      secretAsks: asks,
      onStep: (step) => steps.push(step),
    });
    expect(asks.asked).toEqual([{ want: 'card', text: ASKED_TEXT }]);
    expect(steps[0]?.error).toBeUndefined();
    expect(h.prompts[1]?.text).toContain('A card arrived for this run as card: fill {{secret:card.number}}');
    expect(result.status).toBe('completed');
  });

  test('nobody adding a card after a provider failure fails the step with the abandon instruction', async () => {
    const h = harness({ model: (_prompt, step) => ({ action: step === 0 ? BEGIN : done }), tree: CHECKOUT });
    const steps: StepTrace[] = [];
    await runAgent(h.deps, {
      task: 't',
      caps: SPEND,
      stepFailures: 1,
      purchases: purchasesAnswering({ kind: 'opened', purchase: OPEN, replay: false, cardAsk: ASKED_TEXT }),
      secretAsks: asksRecording(false),
      onStep: (step) => steps.push(step),
    });
    expect(steps[0]?.error).toContain('nobody added a card for this run in time');
    expect(steps[0]?.error).toContain('{"type":"purchase.end","value":"abandoned"}');
  });

  test('a revoked credential stops the run failed with wallet-provider-revoked and the sentence naming the connection', async () => {
    const message =
      'Privacy.com rejected the credential of the card provider connection privacy_ops, so this run stopped before paying. ' +
      'Connect Privacy.com again in Wallet, then start the run again.';
    let modelCalls = 0;
    const h = harness({
      model: () => {
        modelCalls += 1;
        return { action: BEGIN };
      },
      tree: CHECKOUT,
    });
    const result = await runAgent(h.deps, {
      task: 't',
      caps: SPEND,
      stepFailures: 3,
      purchases: purchasesAnswering({ kind: 'stopped', stopReason: 'wallet-provider-revoked', message }),
      secretAsks: asksRecording(true),
    });
    expect(result.status).toBe('failed');
    expect(result.stopReason).toBe('wallet-provider-revoked');
    expect(result.error).toBe(`wallet-provider-revoked: ${message}`);
    // Stopped at once: no step spent retrying a purchase nothing can pay for.
    expect(modelCalls).toBe(1);
  });
});
