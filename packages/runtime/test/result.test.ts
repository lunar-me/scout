import { describe, expect, test } from 'bun:test';

import type { Action } from '../src/actions';
import type { CacheInfo, StepTrace } from '../src/result';
import { answerMarksGap,
  aggregateCache,
  evaluateSchema,
  evaluateSubstance,
  mergeData,
  mergeUsage,
  resolveStatus,
  toWireResult,
  toWireStep,
  totalCredits,
} from '../src/result';
import { nodeRef } from '../src/snapshot';

function step(index: number, overrides: Partial<StepTrace> = {}): StepTrace {
  const action: Action = { type: 'click', ref: nodeRef(0, index + 1) };
  return {
    index,
    action,
    cache: { status: 'MISS', reason: 'no action cache attached' },
    elapsedMs: 10,
    snapshotHash: 'ax1:deadbeef',
    credits: '0.01',
    spent: `${String(index + 1)}.00`,
    pages: index + 1,
    durationMs: (index + 1) * 1_000,
    bandwidthBytes: 0,
    usage: { inputTokens: 100, outputTokens: 10 },
    at: '2026-08-30T09:00:00.000Z',
    ...overrides,
  };
}

describe('usage sums, and the cache verdict is not summed', () => {
  test('counters add and absent counters stay absent', () => {
    expect(mergeUsage({ inputTokens: 10 }, { inputTokens: 5, outputTokens: 2 })).toEqual({
      inputTokens: 15,
      outputTokens: 2,
    });
    expect(mergeUsage({}, {})).toEqual({});
  });

  test('a run is only a HIT when every step hit', () => {
    const hit: CacheInfo = { status: 'HIT' };
    expect(aggregateCache([step(0, { cache: hit }), step(1, { cache: hit })]).status).toBe('HIT');
    expect(aggregateCache([step(0, { cache: hit }), step(1)]).status).toBe('MISS');
  });

  test('the mixed verdict says how mixed, because that is the number being read', () => {
    const mixed = aggregateCache([step(0, { cache: { status: 'HIT' } }), step(1)]);
    expect(mixed.reason).toBe('1 of 2 steps replayed from cache');
  });

  test('a run with the cache off says so rather than reporting a miss', () => {
    const off: CacheInfo = { status: 'DISABLED', reason: 'cache disabled for this run' };
    expect(aggregateCache([step(0, { cache: off })]).status).toBe('DISABLED');
  });

  test('credits total exactly across the trace', () => {
    expect(totalCredits([step(0), step(1), step(2)])).toBe('0.03');
  });
});

describe('collected data accumulates rather than replacing', () => {
  test('records merge field by field', () => {
    expect(mergeData({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
    expect(mergeData({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  test('an extraction that returned nothing does not erase what came before', () => {
    expect(mergeData({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  test('a field a later page left empty keeps the value an earlier page gave it', () => {
    const signedIn = { heading: 'Secure Area', message: 'You logged into a secure area!', signedOut: '' };
    const signedOut = { heading: '', message: null, signedOut: 'You logged out of the secure area!' };
    expect(mergeData(signedIn, signedOut)).toEqual({
      heading: 'Secure Area',
      message: 'You logged into a secure area!',
      signedOut: 'You logged out of the secure area!',
    });
  });

  test('an empty value still lands where nothing was held, and a real value always replaces', () => {
    expect(mergeData({ a: '' }, { a: null, b: '' })).toEqual({ a: null, b: '' });
    expect(mergeData({ a: 'old', n: 3 }, { a: 'new', n: 0 })).toEqual({ a: 'new', n: 0 });
  });

  test('a non-record replaces, because there is nothing to merge into', () => {
    expect(mergeData({ a: 1 }, [1, 2])).toEqual([1, 2]);
  });
});

describe('the schema is the verifier', () => {
  const schema = {
    type: 'object',
    required: ['airline', 'price'],
    properties: { airline: { type: 'string' }, price: { type: 'number' } },
  };

  test('all required fields present and correctly typed is satisfaction', () => {
    expect(evaluateSchema(schema, { airline: 'TAP', price: 84 })).toEqual({ satisfied: true, missing: [] });
  });

  test('a missing field is named, so partial can be explained', () => {
    expect(evaluateSchema(schema, { airline: 'TAP' })).toEqual({ satisfied: false, missing: ['price'] });
  });

  test('a field of the wrong declared type is not satisfaction', () => {
    // "84" is not a number, and a caller who asked for one cannot use it.
    expect(evaluateSchema(schema, { airline: 'TAP', price: '84' }).missing).toEqual(['price']);
  });

  test('null counts as absent', () => {
    expect(evaluateSchema(schema, { airline: 'TAP', price: null }).missing).toEqual(['price']);
  });

  test('nothing extracted at all is not satisfaction', () => {
    expect(evaluateSchema(schema, undefined).satisfied).toBe(false);
    expect(evaluateSchema(schema, {}).missing).toEqual(['airline', 'price']);
  });

  test('a schema with no required list is satisfied by any data at all', () => {
    expect(evaluateSchema({ type: 'object' }, { anything: 1 }).satisfied).toBe(true);
    expect(evaluateSchema({ type: 'object' }, {}).satisfied).toBe(false);
  });
});

describe('validating is not answering', () => {
  const answer = {
    type: 'object',
    required: ['answer'],
    properties: { answer: { type: 'string' } },
  };

  test('the validator is unchanged, which is the point of a second function', () => {
    // `required` means PRESENT and `""` is a string. A customer who asks for
    // `{ answer: string }` and wants an empty one is entitled to it, and the
    // verdict on the wire still says so. Anyone tempted to "fix" this instead
    // breaks JSON Schema conformance for every caller.
    expect(evaluateSchema(answer, { answer: '' })).toEqual({ satisfied: true, missing: [] });
    expect(evaluateSchema(answer, { answer: 'not found' }).satisfied).toBe(true);
  });

  test('an empty or stock non-answer is vacuous, and the field is named', () => {
    expect(evaluateSubstance(answer, { answer: '' })).toEqual({
      substantive: false,
      vacuous: ['answer'],
    });
    for (const value of ['   ', 'N/A', 'Not found.', '"unknown"', 'I don\u2019t know', '(none)']) {
      expect(evaluateSubstance(answer, { answer: value }).substantive).toBe(false);
    }
  });

  test('a real answer that CONTAINS a stock phrase is an answer', () => {
    // The whole reason the list is matched against the complete value. Every
    // string here answers the question it was asked; holding any of them would
    // spend a customer's steps re-deriving an answer already given.
    for (const value of [
      'Apple The Grove: not available until Tuesday',
      'No results were shown until the filter was cleared',
      'The recipe has none of the listed allergens, per the label',
      'unknown soldier',
    ]) {
      expect(evaluateSubstance(answer, { answer: value }).substantive).toBe(true);
    }
  });

  test('zero and false are answers; an empty list or record is not', () => {
    const counts = {
      type: 'object',
      required: ['count', 'inStock', 'reviews'],
      properties: {
        count: { type: 'number' },
        inStock: { type: 'boolean' },
        reviews: { type: 'array' },
      },
    };
    expect(
      evaluateSubstance(counts, { count: 0, inStock: false, reviews: ['ok'] }).substantive,
    ).toBe(true);
    // An empty array satisfies `type: array` and reports nothing.
    expect(evaluateSubstance(counts, { count: 0, inStock: false, reviews: [] }).vacuous).toEqual([
      'reviews',
    ]);
  });

  test('the quantifiers mirror the validator, so the two cannot disagree in scope', () => {
    // With `required`, every required field must answer.
    const two = { type: 'object', required: ['a', 'b'], properties: {} };
    expect(evaluateSubstance(two, { a: 'yes', b: '' }).vacuous).toEqual(['b']);
    // With no `required`, satisfaction is "at least one key", so substance is
    // "at least one key that answers".
    expect(evaluateSubstance({ type: 'object' }, { a: '', b: 'yes' }).substantive).toBe(true);
    expect(evaluateSubstance({ type: 'object' }, { a: '', b: 'n/a' }).substantive).toBe(false);
    expect(evaluateSubstance(answer, undefined).substantive).toBe(false);
  });
});

describe('one place decides the status', () => {
  test('a cap outranks everything: the caller chose it', () => {
    expect(resolveStatus({ cap: 'steps', failed: true, hasData: false })).toBe('capped');
    expect(resolveStatus({ cap: 'budget', failed: false, hasData: true, schemaSatisfied: false })).toBe(
      'capped',
    );
  });

  test('a failure with data is partial, without data is failed', () => {
    expect(resolveStatus({ failed: true, hasData: true })).toBe('partial');
    expect(resolveStatus({ failed: true, hasData: false })).toBe('failed');
  });

  test('an unsatisfied schema is partial when something was collected', () => {
    expect(resolveStatus({ failed: false, hasData: true, schemaSatisfied: false })).toBe('partial');
    expect(resolveStatus({ failed: false, hasData: false, schemaSatisfied: false })).toBe('failed');
  });

  test('no schema and no failure is completed: there is nothing left to verify against', () => {
    expect(resolveStatus({ failed: false, hasData: false })).toBe('completed');
    expect(resolveStatus({ failed: false, hasData: true, schemaSatisfied: true })).toBe('completed');
  });

  test('a satisfied schema is not enough for completed when the loop abandoned a sub-goal', () => {
    // A run that stated five errands, delivered one, and had the other four
    // closed for it reports `partial`. `completed` beside a plan recording four
    // abandoned errands is a result that contradicts itself, and both halves
    // are on the wire together now.
    //
    // MUTATION: drop the `abandonedGoals` clause. Every other assertion in this
    // file still passes, and the loop goes back to calling such a run complete.
    expect(
      resolveStatus({ failed: false, hasData: true, schemaSatisfied: true, abandonedGoals: true }),
    ).toBe('partial');
    expect(
      resolveStatus({ failed: false, hasData: false, schemaSatisfied: true, abandonedGoals: true }),
    ).toBe('failed');
    // And it changes nothing for a run that closed its own goals.
    expect(
      resolveStatus({ failed: false, hasData: true, schemaSatisfied: true, abandonedGoals: false }),
    ).toBe('completed');
  });
});

describe('the wire projections', () => {
  const result = {
    id: 'run_1',
    status: 'capped' as const,
    data: { airline: 'TAP' },
    steps: [step(0), step(1, { cache: { status: 'HIT' } })],
    stepsUsed: 2,
    stopReason: 'max-steps' as const,
    cappedBy: 'steps' as const,
    usage: { inputTokens: 200 },
    credits: '0.02',
    charged: '0.01',
    durationMs: 42,
    parkedMs: 0,
    modelCostUsd: '0.01',
    billedModelCostUsd: '0.005',
    pricing: { plan: 'builder' as const, byok: false },
    goals: [],
    findings: [],
    ruledOut: [],
  };

  test('capped survives the crossing, because it is a status core declares', () => {
    const wire = toWireResult(result, { url: 'https://outcrawl.ai/replay/run_1' }, 6);
    expect(wire.status).toBe('capped');
    expect(wire.data).toEqual({ airline: 'TAP' });
    expect(wire.stopReason).toBe('max-steps');
    expect(wire.replayUrl).toBe('https://outcrawl.ai/replay/run_1');
    expect(wire.usage.cache).toEqual({ status: 'MISS', reason: '1 of 2 steps replayed from cache' });
  });

  test('a run with nothing to report omits data, and one with an answer carries it', () => {
    // THE CONTRACT THIS FIXES. `WireAgentResult.data` was declared REQUIRED
    // (`data: unknown`, not `data?:`) and assigned unconditionally here, while
    // production shipped `200 completed` responses with no `data` key at all —
    // `JSON.stringify` erases an `undefined` value. We declared a mandatory
    // field and did not send it.
    //
    // Now the field is optional and the omission is deliberate, on the
    // `replayUrl` precedent above: absent because we meant absent, not because
    // a serializer swallowed it. Absent rather than `null` because `null` is a
    // value a schema'd extraction can legitimately produce, and overloading it
    // would make "the answer is null" and "there was no answer" one reading.
    //
    // MUTATION THIS CATCHES: assign `data` unconditionally again. Every other
    // assertion in this file still passes, the JSON on the wire is identical,
    // and the published type is false again in exactly the way it was.
    const empty = toWireResult({ ...result, data: undefined }, null, 6);
    expect(Object.keys(empty)).not.toContain('data');
    expect(empty.data).toBeUndefined();

    // And the field is not merely droppable: a run that has an answer sends it.
    // Without this line the mutation "never emit data" would also pass.
    const answered = toWireResult({ ...result, data: 'The top story is Foo' }, null, 6);
    expect(Object.keys(answered)).toContain('data');
    expect(answered.data).toBe('The top story is Foo');
  });

  test('a host with no durable store omits replayUrl rather than publishing a dead link', () => {
    // The field is SPREAD, not assigned, so `null` produces an absent key and
    // not the string "null" or an empty string. A host whose replay store is a
    // Map freed at process exit would otherwise hand the customer a link that
    // 404s for the whole retention window; absent reads as "not recorded",
    // a dead link reads as "your product is broken".
    //
    // MUTATION: assign `replayUrl` unconditionally instead of spreading it.
    // Every other assertion in this file still passes and the dead link is back.
    const wire = toWireResult(result, null, 6);
    expect(Object.keys(wire)).not.toContain('replayUrl');
    expect(wire.replayUrl).toBeUndefined();
  });

  test('a declined run says so positively, and is not confused with a lost one', () => {
    // THE WHOLE POINT OF THE FIELD. An absent `replayUrl` had two causes and
    // said nothing about which: a caller who refused a recording, and a
    // recorder that was asked for one and did not deliver. Those are a
    // satisfied request and an incident, and a customer disputing a charge, an
    // auditor checking a compliance boundary and an operator reading a session
    // with no tape all need the difference.
    //
    // MUTATION THIS CATCHES: `recordingDeclined` spread from anything other
    // than the `'declined'` arm — including spreading it whenever the url is
    // absent, which is the tempting shortcut and collapses the two causes
    // straight back together.
    const declined = toWireResult(result, 'declined', 6);
    expect(declined.recordingDeclined).toBe(true);
    // No url, and absent rather than null: a JSON null would land where an SDK
    // types a string.
    expect(Object.keys(declined)).not.toContain('replayUrl');

    // The pair, against ONE difference. A run that WANTED a recording and did
    // not get one is silent here, so the field means "the caller refused" and
    // never merely "there is no recording".
    const lost = toWireResult(result, null, 6);
    expect(Object.keys(lost)).not.toContain('recordingDeclined');
    expect(lost.recordingDeclined).toBeUndefined();
  });

  test('a recorded run carries the url and never claims a refusal', () => {
    // The third state, and the one that must not acquire the field. A recording
    // still SEALING is in exactly this state — `sessions.replay_key` is written
    // the moment the recorder arms, not when it finishes — so a reader seeing a
    // url knows a recording exists and does not have to ask whether it is
    // complete.
    //
    // MUTATION THIS CATCHES: `recordingDeclined` assigned unconditionally, or
    // typed `boolean` and emitted as `false`. Both put a claim about a decision
    // on every result that ever returns.
    const wire = toWireResult(result, { url: 'https://outcrawl.ai/replay/run_1' }, 6);
    expect(wire.replayUrl).toBe('https://outcrawl.ai/replay/run_1');
    expect(Object.keys(wire)).not.toContain('recordingDeclined');
  });

  test('the duration crosses, because it is what the run is billed by', () => {
    // `@outcrawl/api` meters the run's browser time (`context_seconds`, one
    // credit a minute) from this field. It did not used to cross, and with no
    // minute to meter an agent run billed nothing of its own.
    //
    // MUTATION: drop `durationMs` from the projection, or hardcode it to 0.
    // Every other assertion in this file still passes, and an hour of agent
    // work goes back to costing nothing.
    const wire = toWireResult(result, { url: 'https://outcrawl.ai/replay/run_1' }, 6);
    expect(wire.durationMs).toBe(42);
  });

  test('the model charge crosses beside the result, at the figure the budget funded', () => {
    // The settlement meters `model_cost_usd` from this, so it must be the
    // BILLED dollars — what `credits` priced — with the measured dollars
    // beside it, at the plan the run was priced at. Metering the measured
    // figure would bill a capped run past the customer's own ceiling.
    const wire = toWireResult(result, { url: 'https://outcrawl.ai/replay/run_1' }, 6);
    expect(wire.modelCharge).toEqual({ usd: '0.005', measuredUsd: '0.01', plan: 'builder', byok: false });
  });

  test('the credits cross, because the meter could never see bandwidth', () => {
    // Used to assert the OPPOSITE: that `AgentResult.credits` stayed off the
    // wire because `@outcrawl/api`'s `Meter.credits()` was "the one
    // authority" settlement priced the row from. Measured on
    // `run_...d31bfcd6` (2026-09-23, completed, no clamp): `usage_events`
    // for the session summed to `35.201944` credits while `Meter.credits()`
    // — page_load, agent_seconds, context_seconds and tokens, the only
    // kinds `@outcrawl/api` can itself record — settled the row at
    // `12.961200`. `proxy_bytes` is metered by `packages/worker/src`, after
    // this handler has already returned, and no code in `@outcrawl/api` can
    // write it — see `CAPABILITY_METERING`'s own header in that package's
    // `meter.ts`. So "the one authority" was never authoritative about
    // bandwidth at all, and every run whose ceiling `caps.budget` clamped or
    // whose final action was itself bandwidth-heavy settled at a number its
    // own ledger never priced. `AgentResult.credits` — this object's
    // `CapLedger.billing().credits` — IS the one figure that prices
    // every term, and `settleRun` now reads it (falling back to
    // `Meter.credits()` only when a caller's own `RuntimeDeps.run` has no
    // ledger behind it at all — see `AgentResult.credits`'s own header in
    // `@outcrawl/scout-core`).
    //
    // MUTATION: drop `credits` from the projection. Every other assertion in
    // this file still passes, and every run this fix was written for goes
    // back to under-reporting its own bandwidth.
    const wire = toWireResult(result, { url: 'https://outcrawl.ai/replay/run_1' }, 6);
    expect(wire.credits).toBe('0.02');
  });

  test('a step with a node carries the wire ref and its heal path', () => {
    const observed = {
      ref: '0-42' as const,
      description: 'click the button "Pay"',
      method: 'click',
      xpath: '/html/body/button',
    };
    const wire = toWireStep(step(0, { observed, reasoning: 'the only pay button' }));
    expect(wire.action).toEqual(observed);
    expect(wire.reasoning).toBe('the only pay button');
    expect(wire.usage.cache).toEqual({ status: 'MISS', reason: 'no action cache attached' });
  });

  test('a step with no node says so rather than inventing a reference', () => {
    const wire = toWireStep(step(0, { action: { type: 'navigate', url: 'https://example.com/' } }));
    // 0 is Blink's invalid node id, so "0-0" reads as "no node" and the empty
    // xpath as "no heal path". Neither is resolvable, and neither pretends to be.
    expect(wire.action.ref).toBe('0-0');
    expect(wire.action.xpath).toBe('');
    expect(wire.action.description).toBe('navigate to https://example.com/');
  });

  test('the plan crosses, because a five-part task is five completions and one report', () => {
    // `status` carries the report and nothing else: a run that did four errands
    // of five and a run that did one are both `partial`. This is the four.
    //
    // It did not used to cross, and the cost was not the customer's. The eval
    // harness is the only instrument that measures long-horizon behaviour, it
    // reads these frames, and with the plan absent it scored a plan-driven run
    // and a planless one identically. An absence read off that output could not
    // distinguish "no plan was stated" from "plans do not appear here", and one
    // such absence was reported as evidence for a fix that would not have
    // worked.
    //
    // MUTATION: drop the `goals` spread from `toWireResult`. Every other
    // assertion in this file still passes and the feature is invisible again.
    const wire = toWireResult(
      {
        ...result,
        goals: [
          { id: 'g1', goal: 'cheapest travel book', status: 'done', summary: '£23.21', closedAtStep: 4 },
          { id: 'g2', goal: 'backpack price', site: 'saucedemo.com', status: 'active' },
        ],
      },
      { url: 'https://outcrawl.ai/replay/run_1' },
      6,
    );
    expect(wire.goals).toEqual([
      { id: 'g1', goal: 'cheapest travel book', status: 'done', summary: '£23.21', closedAtStep: 4 },
      { id: 'g2', goal: 'backpack price', site: 'saucedemo.com', status: 'active' },
    ]);
  });

  test('a run with no plan omits goals rather than publishing an empty one', () => {
    // Absent reads as "this run had no plan". `[]` reads as "asked, and
    // answered nothing", which is a different and false statement.
    //
    // MUTATION: assign `goals` unconditionally instead of spreading it.
    const wire = toWireResult(result, { url: 'https://outcrawl.ai/replay/run_1' }, 6);
    expect(Object.keys(wire)).not.toContain('goals');
  });

  test('a step names the sub-goal it was working', () => {
    // Same hole as `tab`, same consequence: a scorer reading these frames
    // cannot attribute a step to an outcome without it, so it cannot tell a run
    // that worked three errands from one that worked the first three times.
    //
    // MUTATION: drop the `goal` spread from `toWireStep`.
    expect(toWireStep(step(0, { goal: 'g2' })).goal).toBe('g2');
    expect(Object.keys(toWireStep(step(0)))).not.toContain('goal');
  });
});

describe('an answer that names its own gap', () => {
  /**
   * MUTATIONS THIS CATCHES: a gap marker standing in an item's place missed
   * (live10 5f576d15, run_…: "61. (missing)"), and an ordinary use of
   * the word taken for one — which would turn correct answers `partial`.
   */
  test('is read off item markers, not off the word', () => {
    expect(answerMarksGap('61. (missing)\n62. How accurately calibrated is the gauge?')).toBe('61. (missing)');
    expect(answerMarksGap({ answer: 'Chinese: 中文\nFrench: Not listed on the page' })).toBe('French: Not listed on the page');
    expect(answerMarksGap(['a', '3. not found'])).toBe('3. not found');
    expect(answerMarksGap('The missing persons database lists 40 entries.')).toBeUndefined();
    expect(answerMarksGap('No item was missing from the order; all 3 shipped.')).toBeUndefined();
    expect(answerMarksGap({ price: 3599, title: 'Crucial 16GB' })).toBeUndefined();
    // A whole value that is only the word is a non-answer, held by evaluateSubstance's own door.
    expect(answerMarksGap({ answer: 'Not found.' })).toBeUndefined();
  });

  test('makes a run partial, not completed', () => {
    expect(resolveStatus({ failed: false, hasData: true, answerGap: true })).toBe('partial');
    expect(resolveStatus({ failed: false, hasData: true })).toBe('completed');
  });
});
