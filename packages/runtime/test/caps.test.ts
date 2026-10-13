import { describe, expect, test } from 'bun:test';

import {
  addDecimal,
  browserTimeCredits,
  compareDecimal,
  isDecimalString,
  multiplyDecimal,
  parseDuration,
  ZERO_CREDITS,
} from '@outcrawl/scout-core';

import {
  CapLedger,
  GoalLedger,
  capStopReason,
  validateCaps,
} from '../src/caps';
import { VirtualClock, capState, testPricing } from './support';

describe('credits are decimal strings, because binary64 gets money wrong', () => {
  test('the canonical float failure does not happen here', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(addDecimal('0.1', '0.2')).toBe('0.3');
  });

  test('a ten-step accumulation stays exact where the float drifts', () => {
    let exact = ZERO_CREDITS;
    let float = 0;
    for (let i = 0; i < 10; i += 1) {
      exact = addDecimal(exact, '0.07');
      float += 0.07;
    }
    expect(exact).toBe('0.70');
    expect(float).not.toBe(0.7);
    // The drift is real, not a display artefact, and it is in the direction
    // that overcharges: the ledger would bill for credits nobody spent.
    expect(float - 0.7).toBeGreaterThan(0);
    expect(Number(exact)).not.toBe(float);
  });

  test('mixed scales add without losing the finer one', () => {
    expect(addDecimal('2', '0.005')).toBe('2.005');
    expect(addDecimal('0.10', '0.2')).toBe('0.30');
    expect(addDecimal('1.999999', '0.000001')).toBe('2.000000');
  });

  test('a charge finer than a cent still accumulates exactly', () => {
    // Per-token pricing produces amounts a two-decimal budget cannot express.
    let spent = ZERO_CREDITS;
    for (let i = 0; i < 1000; i += 1) {
      spent = addDecimal(spent, '0.000001');
    }
    expect(spent).toBe('0.001000');
    expect(compareDecimal(spent, '0.001')).toBe(0);
  });

  test('comparison is by value, not by scale', () => {
    expect(compareDecimal('0.30', '0.3')).toBe(0);
    expect(compareDecimal('2', '2.00')).toBe(0);
    expect(compareDecimal('0.10', '0.2')).toBe(-1);
    expect(compareDecimal('10', '9.99')).toBe(1);
  });

  test('a value that is not a decimal string is refused rather than coerced', () => {
    expect(isDecimalString('2.00')).toBe(true);
    expect(isDecimalString('2.00 credits')).toBe(false);
    expect(isDecimalString(2)).toBe(false);
    expect(() => addDecimal('2', '')).toThrow(TypeError);
  });
});

describe('durations parse to milliseconds', () => {
  test('every unit core declares', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  test('a bare number is refused: an unstated unit is a 1000x waiting to happen', () => {
    expect(() => parseDuration('300')).toThrow(TypeError);
    expect(() => parseDuration('5 minutes')).toThrow(TypeError);
  });
});

describe('caps are validated before a run can start', () => {
  test('all three are required and shaped', () => {
    expect(validateCaps({ steps: 40, budget: '2.00', duration: '5m' }).ok).toBe(true);

    const bad = validateCaps({ steps: 0, budget: 2, duration: '5 minutes' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors).toHaveLength(3);
    }
  });

  test('a run cannot be started with caps it cannot enforce', () => {
    expect(() => new CapLedger({ steps: 1, budget: 'free', duration: '5m' }, new VirtualClock())).toThrow(
      TypeError,
    );
  });
});

describe('the ledger answers one question: has a ceiling been reached', () => {
  const caps = { steps: 3, budget: '1.00', duration: '10s' };

  test('a fresh ledger has tripped nothing', () => {
    const ledger = new CapLedger(caps, new VirtualClock());
    expect(ledger.tripped()).toBeUndefined();
    expect(ledger.credits).toBe('0');
    expect(ledger.steps).toBe(0);
  });

  test('steps trip on the last allowed step, not one after', () => {
    const ledger = new CapLedger(caps, new VirtualClock());
    ledger.countStep();
    ledger.countStep();
    expect(ledger.tripped()).toBeUndefined();
    ledger.countStep();
    expect(ledger.tripped()).toBe('steps');
  });

  test('budget trips when the allowance is consumed, not after it is exceeded', () => {
    const ledger = new CapLedger(caps, new VirtualClock());
    ledger.charge('0.60');
    expect(ledger.tripped()).toBeUndefined();
    ledger.charge('0.40');
    expect(ledger.credits).toBe('1.00');
    // Exactly at the ceiling buys nothing further, so the run stops here
    // rather than starting a step it cannot pay for.
    expect(ledger.tripped()).toBe('budget');
  });

  test('a ceiling the float would sail past still trips', () => {
    // The substitution proof, so this suite fails if the ledger is ever
    // reimplemented on binary64: 0.7 + 0.1 is 0.7999999999999999, which is
    // under 0.8, so a float ledger keeps spending after the customer's
    // ceiling. The exact one stops.
    expect(0.7 + 0.1).toBeLessThan(0.8);

    const ledger = new CapLedger({ steps: 99, budget: '0.80', duration: '10s' }, new VirtualClock());
    ledger.charge('0.7');
    ledger.charge('0.1');
    expect(ledger.credits).toBe('0.8');
    expect(ledger.tripped()).toBe('budget');
  });

  test('duration reads the injected monotonic clock', () => {
    const clock = new VirtualClock(1_000);
    // Its OWN caps, with a budget that cannot bind: the shared `caps` above
    // pairs a one-credit budget with ten seconds, and this test is about the
    // duration clock alone.
    const ledger = new CapLedger({ steps: 3, budget: '999.00', duration: '10s' }, clock);
    clock.advance(9_999);
    expect(ledger.elapsedMs()).toBe(9_999);
    expect(ledger.tripped()).toBeUndefined();
    clock.advance(1);
    expect(ledger.tripped()).toBe('duration');
  });

  test('a negative or malformed charge is a bug, not a credit', () => {
    const ledger = new CapLedger(caps, new VirtualClock());
    expect(() => ledger.charge('-0.01')).toThrow(RangeError);
    expect(() => ledger.charge('lots')).toThrow(TypeError);
    expect(ledger.credits).toBe('0');
  });

  test('two ceilings reached at once report the same one every time', () => {
    const clock = new VirtualClock();
    const ledger = new CapLedger({ steps: 1, budget: '0.01', duration: '1ms' }, clock);
    ledger.countStep();
    ledger.charge('0.01');
    clock.advance(5);
    expect(ledger.tripped()).toBe('steps');
    expect(ledger.tripped()).toBe('steps');
  });

  test('each cap maps to its own stop reason', () => {
    expect(capStopReason('steps')).toBe('max-steps');
    expect(capStopReason('budget')).toBe('max-budget');
    expect(capStopReason('duration')).toBe('max-duration');
  });
});

describe('a budget the bill has run out of is reached, whatever the rounding', () => {
  test('model spend plus time past the budget trips it, and the bill lands on the budget', () => {
    // One cent of model usage at the test tier is 1 credit and a minute open
    // is 1 more: 2 measured against a 1.50 budget. Both terms are funded in
    // proportion (75% each), so the bill is the budget to the unit, and every
    // term is clamped. A cap that compared only the bill to the budget never
    // tripped on a bill a hair under it, and a run held, parked or settling
    // kept going on time the customer is no longer billed for; it trips here
    // because the time is clamped.
    const clock = new VirtualClock();
    const ledger = new CapLedger({ budget: '1.50' }, clock, undefined, testPricing(), undefined, undefined, () => '0.01');
    expect(ledger.tripped()).toBeUndefined();
    clock.advance(60_000);

    const billing = ledger.billing();
    expect(billing.billedMs).toBe(45_000);
    expect(compareDecimal(billing.billedModelCostUsd, '0.0075')).toBe(0);
    expect(compareDecimal(billing.credits, '1.50')).toBe(0);
    expect(ledger.tripped()).toBe('budget');
    expect(ledger.budgetRemainingMs()).toBe(0);
  });

  test('a capped run keeps its split: every term is billed in proportion, none is zeroed', () => {
    // Funded in a fixed order, model usage alone took the whole budget and a
    // capped run was billed 0 browser time and 0 bytes (production
    // 2026-10-03). MUTATION: fund in order -> the time and bytes below are 0
    // and this goes red.
    const clock = new VirtualClock();
    const ledger = new CapLedger({ budget: '1.50' }, clock, undefined, testPricing(), undefined, () => 12_208, () => '0.0151');
    clock.advance(9_065);

    const billing = ledger.billing();
    const pricing = testPricing();
    expect(compareDecimal(billing.credits, '1.50')).toBe(0);
    // Every term is billed, and every term is clamped below what was measured.
    expect(billing.billedMs).toBeGreaterThan(0);
    expect(billing.billedMs).toBeLessThan(9_065);
    expect(billing.billedBandwidthBytes).toBeGreaterThan(0);
    expect(billing.billedBandwidthBytes).toBeLessThan(12_208);
    expect(compareDecimal(billing.billedModelCostUsd, ZERO_CREDITS)).toBe(1);
    expect(compareDecimal(billing.billedModelCostUsd, '0.0151')).toBe(-1);
    // The billed terms are exactly the bill: model + time + bytes = 1.50.
    const priced = addDecimal(
      addDecimal(pricing.modelCredits(billing.billedModelCostUsd, pricing.model), browserTimeCredits(billing.billedMs, '1')),
      multiplyDecimal(String(billing.billedBandwidthBytes), '0.000002'),
    );
    expect(compareDecimal(priced, billing.credits)).toBe(0);
    expect(ledger.tripped()).toBe('budget');
  });

  test('a run under its budget is billed every term as measured', () => {
    const clock = new VirtualClock();
    const ledger = new CapLedger({ budget: '16.00' }, clock, undefined, testPricing(), undefined, () => 12_208, () => '0.00284879');
    clock.advance(9_065);
    const billing = ledger.billing();
    expect(billing.billedMs).toBe(9_065);
    expect(billing.billedBandwidthBytes).toBe(12_208);
    expect(billing.billedModelCostUsd).toBe('0.00284879');
    expect(ledger.tripped()).toBeUndefined();
  });

  test('a ledger nobody prices bills model usage at cost and time and bandwidth at nothing', () => {
    const clock = new VirtualClock();
    const ledger = new CapLedger({ budget: '1.00' }, clock, undefined, undefined, undefined, () => 1_000_000, () => '0.25');
    clock.advance(60_000);
    expect(ledger.credits).toBe('0.25');
    expect(ledger.tripped()).toBeUndefined();
  });
});

describe('the cap prices bandwidth from the browser\u2019s own counter, continuously', () => {
  // Measured on production 2026-09-23, a customer's account, run_…: `agent.get`
  // reported `credits: 6.108400` -- a figure `tripped()` had already tested
  // and passed -- while the session's own metered rows summed to
  // `23.999756`, with `proxy_bytes` alone priced at `17.891356` on 8,945,678
  // bytes. `6.1084` was exactly time plus pages; bandwidth was the entire
  // gap, and the guessed `BandwidthReserve` this suite used to pin reserved
  // only 1.47 credits against it. This suite pins the fix: `credits` now
  // reads the browser's own `Outcrawl.getContextBytes` counter through an
  // injected reader, on exactly `pageLoads`'s terms, and prices it at
  // `RUN_CREDITS_PER_BYTE` -- the published 2,000 credits/GB, asserted
  // against the rate card itself in
  // `packages/persistence/test/rate-card.test.ts` rather than copied here as
  // a second opinion.

  test('a fresh ledger with no bandwidth reader prices no bandwidth, on pageLoads\u2019 own default', () => {
    const ledger = new CapLedger({ budget: '999.00' }, new VirtualClock());
    expect(ledger.bandwidthBytes).toBe(0);
    expect(ledger.credits).toBe('0');
  });

  test('bandwidth is priced at the published rate, exactly the measured incident', () => {
    // 8,945,678 bytes is the measured run_… quantity, and 17.891356 is
    // its measured credit price -- `8,945,678 x 2000 / 1e9`, to the digit.
    const ledger = new CapLedger(
      { budget: '999.00' },
      new VirtualClock(),
      undefined,
      testPricing(),
      undefined,
      () => 8_945_678,
    );
    expect(ledger.bandwidthBytes).toBe(8_945_678);
    expect(ledger.credits).toBe('17.891356');
  });

  test('the reader is injectable, like pageLoads, so a test or a reprice can drive a round number', () => {
    const ledger = new CapLedger(
      { budget: '9999.00' },
      new VirtualClock(),
      undefined,
      testPricing(),
      undefined,
      () => 1_000_000_000, // exactly one GB
    );
    // One GB at 2,000 credits/GB. Scale 6, the sum of the byte-count's scale
    // (0) and the per-byte rate's (6) -- `multiplyDecimal` never rounds a
    // scale away, see `@outcrawl/scout-core`.
    expect(ledger.credits).toBe('2000.000000');
  });

  test('REGRESSION: a budget that clears everything else now trips once bandwidth crosses it too', () => {
    // The measured incident, in miniature. This run's time is negligible on a
    // virtual clock and nothing else is charged, so a budget of '4.50' looks
    // fundable right up until bandwidth arrives on the bill: 2,251,000 bytes
    // at 2,000 credits/GB is 4.502 credits, over '4.50'. Before this class
    // read bandwidth at all, `credits` here was '0' and `tripped()` read
    // `undefined` — the defect measured on run_… in production.
    const ledger = new CapLedger(
      { budget: '4.50' },
      new VirtualClock(),
      undefined,
      testPricing(),
      undefined,
      () => 2_251_000,
    );
    expect(ledger.tripped()).toBe('budget');
  });

  test('resume: bandwidth measured on a dead attempt travels forward, on pages\u2019 exact terms', () => {
    // A re-acquired run's new browser context starts its OWN
    // `Outcrawl.getContextBytes` counter at zero -- the same fact `pages`
    // exists to carry forward -- so `CapState.bandwidthBytes` is what keeps a
    // customer's bandwidth spend from resetting on every browser their task
    // loses.
    const ledger = new CapLedger(
      { budget: '999.00' },
      new VirtualClock(),
      capState({ steps: 4, credits: '10', pages: 3, bandwidthBytes: 5_000_000 }),
    );
    expect(ledger.bandwidthBytes).toBe(5_000_000);

    // And once this attempt's own browser has relayed bytes of its own, the
    // total is the SUM, not the newer figure alone.
    let attemptBytes = 0;
    const resumed = new CapLedger(
      { budget: '999.00' },
      new VirtualClock(),
      capState({ steps: 4, credits: '10', pages: 3, bandwidthBytes: 5_000_000 }),
      undefined,
      undefined,
      () => attemptBytes,
    );
    attemptBytes = 2_000_000;
    expect(resumed.bandwidthBytes).toBe(7_000_000);
  });

  test('a per-byte rate that is not a decimal string is refused at construction, like every other rate', () => {
    expect(
      () =>
        new CapLedger({ budget: '999.00' }, new VirtualClock(), undefined, {
          ...testPricing(),
          creditsPerByte: 'lots',
        }),
    ).toThrow(TypeError);
  });

  test('a sub-goal prices bandwidth the same way the run ledger does, from the same live reading', () => {
    const clock = new VirtualClock();
    const used = capState();
    const goal = new GoalLedger(
      'goal-1',
      { kind: 'fixed', caps: { budget: '999.00' } },
      { caps: { budget: '999.00' }, used },
      1,
      clock,
      testPricing(),
      undefined,
      () => 1_000_000_000,
    );
    expect(goal.bandwidthBytes).toBe(1_000_000_000);
    expect(goal.credits).toBe('2000.000000');
  });

  test('a sub-goal prices only the bandwidth relayed since IT became active', () => {
    const clock = new VirtualClock();
    // The run had already relayed 500,000,000 bytes (1000 credits) before
    // this goal existed -- from a previous goal, say -- and this goal's own
    // share is only what arrives after that baseline.
    const used = capState({ credits: '1000', bandwidthBytes: 500_000_000 });
    let runTotal = 500_000_000;
    const goal = new GoalLedger(
      'goal-2',
      { kind: 'fixed', caps: { budget: '999.00' } },
      { caps: { budget: '999.00' }, used },
      1,
      clock,
      testPricing(),
      undefined,
      () => runTotal,
    );
    expect(goal.bandwidthBytes).toBe(0);
    runTotal = 600_000_000;
    // 100,000,000 new bytes this goal has spent -- 200 credits at the
    // published rate -- not the run's cumulative 600,000,000.
    expect(goal.bandwidthBytes).toBe(100_000_000);
    expect(goal.credits).toBe('200.000000');
  });

  test('REGRESSION: the reported credits and the credits the cap tests are now the SAME number', () => {
    // Measured live, 2026-09-16, against the deployed reserve fix: a
    // $1.50-budget run billed 1.348122 by the ledger's own charge while
    // `credits` -- then reported to the customer -- read 1.9463, ABOVE the
    // ceiling the customer themselves set. This class exposes ONE `credits`,
    // the `billing()` reading, and it is what both `tripped()` and
    // `AgentResult.credits` read.
    const ledger = new CapLedger(
      { budget: '9999.00' },
      new VirtualClock(),
      undefined,
      testPricing(),
      undefined,
      () => 1_000_000_000,
    );
    // 1 GB at the published rate (2000.000000, scale 6).
    expect(ledger.credits).toBe('2000.000000');
    expect(ledger.credits).toBe(ledger.billing().credits);

    const capped = new CapLedger(
      { budget: '1999.50' },
      new VirtualClock(),
      undefined,
      testPricing(),
      undefined,
      () => 1_000_000_000,
    );
    expect(capped.tripped()).toBe('budget');
  });

  test('billedBandwidthBytes clamps bandwidth so it alone can never carry credits past budget', () => {
    // The measured production defect, 2026-09-23: `run_...bc565428` reported
    // 33.817562 against a 40.00 budget while its session billed 42.0914 --
    // 2.09 credits OVER the customer's own ceiling, because the byte count
    // that arrived after the run's last per-step read was metered at close
    // but never priced into what was reported. `billedBandwidthBytes` is the
    // clamp that closes it: bandwidth is capped at exactly what the
    // remaining budget can fund, never a byte more.
    //
    // Non-bandwidth here is an explicit charge of 4 -- `elapsedMs: 0` on a
    // fresh VirtualClock keeps time at zero -- so the whole 40.00 budget less
    // 4 leaves exactly 36.00 credits, which is 18,000,000 bytes at the
    // published rate.
    const ledger = new CapLedger(
      { budget: '40.00' },
      new VirtualClock(),
      undefined,
      testPricing(),
      undefined,
      () => 20_000_000, // more than the 18,000,000 the remaining budget funds
    );
    ledger.charge('4');
    expect(ledger.bandwidthBytes).toBe(20_000_000);
    expect(ledger.billedBandwidthBytes).toBe(18_000_000);
    // 4 (charged) + 18,000,000 x 0.000002 (36) = 40 exactly -- AT the budget,
    // never past it.
    expect(ledger.credits).toBe('40.000000');
    expect(compareDecimal(ledger.credits, ledger.budget)).toBe(0);
    // And the stop reason is still correct: bandwidth genuinely reached the
    // ceiling, so the cap still trips -- clamped AT the budget is still
    // `>= budget`.
    expect(ledger.tripped()).toBe('budget');
  });

  test('the clamp never bills bandwidth below what was actually measured', () => {
    // A run whose bandwidth comfortably fits the remaining budget is not
    // clamped at all -- `billedBandwidthBytes` must equal the raw reading,
    // not a defensive haircut applied indiscriminately.
    const ledger = new CapLedger(
      { budget: '9999.00' },
      new VirtualClock(),
      undefined,
      testPricing(),
      undefined,
      () => 500_000,
    );
    expect(ledger.billedBandwidthBytes).toBe(500_000);
    expect(ledger.bandwidthBytes).toBe(ledger.billedBandwidthBytes);
  });

  test('model usage past the budget is measured and not billed, and bandwidth is never billed negative', () => {
    // One provider dollar on a 2.00 budget at the test tier: 100 credits of
    // model usage, plus 20 credits of bandwidth. The budget is a hard ceiling
    // on what is billed, so each is billed only as far as its proportional
    // share of 2.00 funds it -- never a negative amount to "correct" the
    // overshoot.
    const ledger = new CapLedger({ budget: '2.00' }, new VirtualClock(), undefined, testPricing(), undefined, () => 10_000_000, () => '1');
    const billing = ledger.billing();
    // 2.00 x 20 / 120 of bandwidth: 0.333333 credits, 166,666 whole bytes.
    expect(billing.billedBandwidthBytes).toBe(166_666);
    expect(compareDecimal(billing.credits, '2.00')).toBe(0);
    expect(billing.modelCostUsd).toBe('1');
    expect(compareDecimal(billing.billedModelCostUsd, billing.modelCostUsd)).toBe(-1);
    expect(compareDecimal(billing.billedModelCostUsd, ZERO_CREDITS)).toBe(1);
    expect(ledger.tripped()).toBe('budget');
  });

  test('the clamp is derived from the ledger\u2019s OWN pricing, never a copied constant', () => {
    // A non-default `creditsPerByte` -- '0.000003' instead of the published
    // '0.000002' -- so a clamp computed from a hardcoded inverse of the
    // PUBLISHED rate would divide by the wrong number here and let credits
    // land above budget again for a deployment or a test that injects its
    // own `RunPricing`.
    const pricing = { ...testPricing(), creditsPerByte: '0.000003' };
    const ledger = new CapLedger(
      { budget: '40.00' },
      new VirtualClock(),
      undefined,
      pricing,
      undefined,
      () => 20_000_000, // more than this budget and rate can fund
    );
    ledger.charge('4');
    // Non-bandwidth: 4 charged. Remaining 36.00 credits at 0.000003
    // credits/byte funds exactly 12,000,000 bytes -- not the 18,000,000 the
    // PUBLISHED rate would have funded, which is the number a hardcoded
    // reciprocal would have used instead.
    expect(ledger.billedBandwidthBytes).toBe(12_000_000);
    // 4 + 12,000,000 x 0.000003 (36) = 40 exactly -- AT the budget, never
    // above it.
    expect(ledger.credits).toBe('40.000000');
    expect(compareDecimal(ledger.credits, ledger.budget)).toBe(0);
    expect(ledger.tripped()).toBe('budget');
  });
});

describe('a park is billed: the browser is held for every minute of it (W44)', () => {
  test('a one-minute park bills exactly one browser credit and no model credits', () => {
    const clock = new VirtualClock();
    const ledger = new CapLedger(
      { budget: '999.00' },
      clock,
      undefined,
      testPricing(),
      undefined,
      undefined,
      () => '0',
    );
    const unpark = ledger.park();
    clock.advance(60_000);

    // Read while still parked, and again after the human hands it back: the
    // minute is on the bill either way.
    const parked = ledger.billing();
    expect(parked.credits).toBe('1');
    expect(parked.billedMs).toBe(60_000);
    expect(parked.modelCostUsd).toBe('0');

    unpark();
    const resumed = ledger.billing();
    expect(resumed.credits).toBe('1');
    expect(resumed.billedMs).toBe(60_000);
    expect(resumed.billedModelCostUsd).toBe('0');
    // ...while the customer's duration ceiling did not burn.
    expect(ledger.elapsedMs()).toBe(0);
  });
});
