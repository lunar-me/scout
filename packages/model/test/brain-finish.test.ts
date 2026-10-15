/**
 * scout-1's brain finishing with a doubt in its answer, through the real
 * `runAgent` and the real `HarnessModelPort` (brain plan of the production
 * shape). Since ws/doubt-off (2026-10-15) the brain has no `unconfirmed`
 * list: the loop's door reads the answer's own words (`admittedGaps`), and
 * still declines a hedged finish once while most of the run is unspent.
 */
import { describe, expect, test } from 'bun:test';
import { runAgent, type AgentDeps, type StepTrace } from '@outcrawl/runtime';

import { HarnessModelPort } from '../src/harness';
import { CostLedger } from '../src/ledger';
import { BRAIN_MODEL as BRAIN, FakeProvider, VirtualClock, brainPlan, cartPage, reply, type ScriptedTurn } from './support';

const brain = (decision: Record<string, unknown>): ScriptedTurn => reply(JSON.stringify(decision), {}, '0.002');

describe('a scout-1 brain finish that states its own doubt', () => {
  /**
   * MUTATIONS THIS CATCHES: the prose door dropped with the list (the hedged
   * finish accepted at once); the door firing twice; a list reaching the
   * step record from the brain; the hedge cut from the recorded summary.
   */
  test('is declined once, carries no list, and the next finish stands', async () => {
    const hedged = 'The cart has a Coupon field. Whether it takes a discount code was not verified.';
    const second = 'The cart has a Coupon field. I could not confirm that it takes a discount code.';
    const provider = new FakeProvider([
      brain({ do: 'done', why: 'the cart shows it', answer: hedged, unconfirmed: ['it takes a discount code'] }),
      brain({ do: 'done', why: 'no page states it', answer: second }),
    ]);
    const ledger = new CostLedger();
    const port = new HarnessModelPort({
      plan: brainPlan(),
      provider,
      session: { sessionId: 'run-doubt', accountId: 'acct-9' },
      ledger,
      clock: new VirtualClock(),
      actionReasoning: { enabled: false },
    });
    const deps: AgentDeps = {
      snapshot: () => cartPage(30),
      lock: () => undefined,
      unlock: () => undefined,
      perform: () => ({}),
      extract: () => Promise.reject(new Error('no extraction in this run')),
      model: port.choose,
      modelCostUsd: () => ledger.totalsFor('run-doubt').costUsd,
      clock: new VirtualClock(),
    };
    const steps: StepTrace[] = [];
    const result = await runAgent(deps, {
      task: 'does the cart have a coupon field that takes a discount code',
      caps: { steps: 6, budget: '50.00', duration: '5m' },
      stepFailures: 1,
      settle: false,
      onStep: (step) => steps.push(step),
    });

    expect(provider.requests.map((request) => request.model)).toEqual([BRAIN, BRAIN]);
    expect(steps.map((step) => step.held)).toEqual(['unconfirmed', undefined]);
    expect(steps[0]?.error ?? '').toContain('its answer states 1 unconfirmed part(s)');
    expect(steps.map((step) => step.action)).toEqual([
      { type: 'done', summary: hedged },
      { type: 'done', summary: second },
    ]);
    // The decline quotes the brain's own sentence back to it.
    expect(JSON.stringify(provider.requests[1] ?? null)).toContain('Whether it takes a discount code was not verified.');
    expect(result.status).toBe('completed');
    expect(result.data).toBe(second);
  });
});
