/**
 * Caps: `{ budget }` required, `{ steps, duration }` optional, and every one
 * that is present enforced.
 *
 * The customer sets a ceiling before spending rather than disputing a bill
 * afterwards, and since failures cost more than successes — agents flail,
 * retry and loop — the same ceiling protects our margin. A cap firing is a
 * normal outcome, not an incident: the run ends `capped` and returns whatever
 * it collected.
 *
 * ONE of the three is required, and it is money. See `AgentCaps` in
 * `@outcrawl/scout-core` for the argument; the short form is that this file had
 * already conceded it in code. {@link CapLedger.budgetRemainingMs} converts
 * remaining credits into a MILLISECOND deadline, and `loop.ts`'s settle wait is
 * clamped by `Math.min(policy, durationRemaining, budgetRemaining)` — one
 * `Math.min` over two readings of one quantity. A budget bounds seconds AND
 * model usage AND bandwidth; a duration bounds seconds only and leaves the
 * invoice unbounded.
 *
 * An absent ceiling is `Infinity`, never a large sentinel, and it arrives
 * through core's `capStepCeiling` / `capDurationCeilingMs` so that every
 * comparison in this file is against the same reading a validator produced.
 *
 * Budget is a decimal string end to end. `0.1 + 0.2 === 0.30000000000000004`
 * in binary64, and a rounding error discovered in a reconciliation months
 * later is unattributable, so credits never touch a float.
 */

import {
  addDecimal,
  type AgentCaps,
  browserTimeCredits,
  capBudgetError,
  capDurationCeilingMs,
  capDurationError,
  type CapName,
  capStepCeiling,
  type Clock,
  compareDecimal,
  divideDecimal,
  isDecimalString,
  MS_PER_MINUTE,
  multiplyDecimal,
  parseDuration,
  type ValidationResult,
  ZERO_CREDITS,
} from '@outcrawl/scout-core';

/* ------------------------------------------------------------------ *
 * Pricing: a port the host fills
 * ------------------------------------------------------------------ */

/**
 * Who pays for a run's model usage. `plan` is the host's own price tier: the
 * runtime carries it (a resumed run is priced at the tier it started under)
 * and hands it back to {@link RunPricing}, and never reads it. `byok` is true
 * when the user's own model key served the run, so the provider bills them.
 */
export interface ModelPricing {
  readonly plan: string;
  readonly byok: boolean;
}

/**
 * What a run is charged for: the rates and the model conversion a
 * {@link CapLedger} prices a run with. A PORT: the runtime holds no price of
 * its own, and the host that bills the run hands it the same price list it
 * bills with, so the cap and the invoice are one arithmetic.
 *
 * Every field is required. An optional rate reads as "this deployment does not
 * charge for time", which is the shape that made the budget cap a no-op the
 * first time.
 */
export interface RunPricing {
  /** Credits per minute the run is open. A ratio's numerator over {@link MS_PER_MINUTE}. */
  readonly creditsPerMinute: string;
  /** Credits per byte relayed through a proxy exit, both directions summed. */
  readonly creditsPerByte: string;
  /** Whose price converts the run's model usage. */
  readonly model: ModelPricing;
  /** Provider USD as credits at `model`'s price. Throws on a negative `usd`. */
  modelCredits(usd: string, model: ModelPricing): string;
  /**
   * The most provider USD that `credits` pays for at `model`'s price: the
   * largest `usd` with `modelCredits(usd, model) <= credits`, and zero for a
   * non-positive `credits`.
   */
  modelUsdFundedBy(credits: string, model: ModelPricing): string;
}

/**
 * `value`, split into `units` and `scale` such that `value === units / 10^scale`,
 * exactly. The one parse {@link unitsFunded} needs. `isDecimalString` has
 * already validated every string this sees, so a whole part is always present.
 */
function parseDecimal(value: string): { readonly units: bigint; readonly scale: number } {
  const [whole, fraction = ''] = value.split('.');
  return { units: BigInt(whole + fraction), scale: fraction.length };
}

/**
 * `floor(remaining x per / credits)`: how many whole UNITS `remaining` credits
 * fund at a rate of `credits` per `per` units — exact, for milliseconds (1
 * credit per 60,000) and bytes (0.000002 per 1) alike. DERIVED from the
 * ledger's own injected rates every time, never a copied constant.
 *
 * A ratio rather than a per-unit rate because browser time is quoted per
 * minute and one credit a minute is not a terminating decimal per
 * millisecond. BigInt throughout: a clamp that rounds the wrong way is the
 * incident this exists to close.
 *
 * A rate of `'0'` funds UNLIMITED units rather than dividing by zero.
 */
export function unitsFunded(remaining: string, credits: string, per = '1'): number {
  const rate = parseDecimal(credits);
  if (rate.units === 0n) {
    return Number.POSITIVE_INFINITY;
  }
  const funds = parseDecimal(remaining);
  const quantum = parseDecimal(per);
  // (funds.units / 10^fs) x (quantum.units / 10^qs) / (rate.units / 10^rs)
  const numerator = funds.units * quantum.units * 10n ** BigInt(rate.scale);
  const denominator = rate.units * 10n ** BigInt(funds.scale + quantum.scale);
  const units = numerator / denominator;
  return units > BigInt(Number.MAX_SAFE_INTEGER) ? Number.POSITIVE_INFINITY : Number(units);
}

/** What a run measured, in the units its three metered terms are billed in. */
export interface RunTermsMeasured {
  /** Provider USD of the run's model calls. */
  readonly modelCostUsd: string;
  /** Integer milliseconds the run was open. */
  readonly measuredMs: number;
  /** Bytes relayed through a residential exit. */
  readonly bandwidthBytes: number;
  /** The price list the terms are priced at, its `model` the pricing the run started under. */
  readonly pricing: RunPricing;
}

/** The part of each term a budget funds, in the same units, priced. */
export interface RunTermsFunded {
  readonly billedModelCostUsd: string;
  readonly billedMs: number;
  readonly billedBandwidthBytes: number;
  readonly modelTerm: string;
  readonly timeTerm: string;
  readonly bandwidthTerm: string;
}

function bandwidthCredits(bytes: number, creditsPerByte: string): string {
  return bytes === 0 ? ZERO_CREDITS : multiplyDecimal(String(bytes), creditsPerByte);
}

function minDecimal(a: string, b: string): string {
  return compareDecimal(a, b) <= 0 ? a : b;
}

function positivePart(value: string): string {
  return compareDecimal(value, ZERO_CREDITS) > 0 ? value : ZERO_CREDITS;
}

/**
 * How much of each metered term `available` credits fund: model usage, browser
 * time and bandwidth. THE ONE ALLOCATION, used by {@link CapLedger.billing}
 * and by the control plane's settlement of a run no machine settled
 * (`billControlPlaneSettlement` in `@outcrawl/persistence`), so the rows a
 * capped run is billed in agree whichever of the two writes them.
 *
 * When the budget funds everything, every term is billed as measured. When it
 * does not, each term is funded IN PROPORTION to its measured price, then any
 * rounding remainder tops up model, time and bandwidth in that order. The
 * total is the same either way: all of `available`, to the unit.
 *
 * Proportional since the billing audit of 2026-10-03. Funding the terms in a fixed order instead put
 * the WHOLE charge of a capped run on `model_cost_usd` and billed its browser
 * time and bandwidth as zero (production 2026-10-03, n=3: a 9 s run capped at
 * 1.50 read `browserMinutes: 0`, `bandwidthBytes: 0` on `GET /v1/sessions`
 * for 12,208 relayed bytes). The customer total was exact, the split was not.
 *
 * Every billed quantity is floored to its own unit (12-place USD, whole
 * milliseconds, whole bytes), so the priced terms never sum past `available`.
 */
export function fundRunTerms(available: string, measured: RunTermsMeasured): RunTermsFunded {
  const { modelCostUsd, measuredMs, bandwidthBytes, pricing } = measured;
  const { creditsPerMinute, creditsPerByte } = pricing;
  const modelFull = pricing.modelCredits(modelCostUsd, pricing.model);
  const timeFull = browserTimeCredits(measuredMs, creditsPerMinute);
  const bandwidthFull = bandwidthCredits(bandwidthBytes, creditsPerByte);
  const total = addDecimal(addDecimal(modelFull, timeFull), bandwidthFull);
  const funds = positivePart(available);
  if (compareDecimal(total, funds) <= 0) {
    return {
      billedModelCostUsd: modelCostUsd,
      billedMs: measuredMs,
      billedBandwidthBytes: bandwidthBytes,
      modelTerm: modelFull,
      timeTerm: timeFull,
      bandwidthTerm: bandwidthFull,
    };
  }

  // Each term's share of what is available, in credits. The last share is
  // what the first two leave, so the shares never sum past `funds` whichever
  // way `divideDecimal` rounded.
  const share = (term: string): string => divideDecimal(multiplyDecimal(funds, term), total);
  const modelShare = minDecimal(modelFull, share(modelFull));
  const timeShare = minDecimal(timeFull, minDecimal(share(timeFull), positivePart(addDecimal(funds, `-${modelShare}`))));
  const bandwidthShare = minDecimal(
    bandwidthFull,
    positivePart(addDecimal(addDecimal(funds, `-${modelShare}`), `-${timeShare}`)),
  );

  // A term funded up to `credits`, floored to its own unit and priced back.
  const fundModel = (credits: string): { usd: string; term: string } => {
    if (compareDecimal(credits, modelFull) >= 0) return { usd: modelCostUsd, term: modelFull };
    const usd = pricing.modelUsdFundedBy(credits, pricing.model);
    return { usd, term: pricing.modelCredits(usd, pricing.model) };
  };
  const fundTime = (credits: string): number =>
    Math.min(measuredMs, unitsFunded(credits, creditsPerMinute, MS_PER_MINUTE));
  const fundBandwidth = (credits: string): number => Math.min(bandwidthBytes, unitsFunded(credits, creditsPerByte));

  let model = fundModel(modelShare);
  let billedMs = fundTime(timeShare);
  let billedBandwidthBytes = fundBandwidth(bandwidthShare);

  // The flooring remainder, topped up in the old order so a capped run still
  // bills its budget to the unit. Never below what the proportional pass
  // funded: a term re-derived from its own rounded price can come back one
  // unit short (172,598 ms prices to 2.876633, which funds 172,597).
  const priced = (): string =>
    addDecimal(
      addDecimal(model.term, browserTimeCredits(billedMs, creditsPerMinute)),
      bandwidthCredits(billedBandwidthBytes, creditsPerByte),
    );
  const toppedModel = fundModel(addDecimal(model.term, positivePart(addDecimal(funds, `-${priced()}`))));
  if (compareDecimal(toppedModel.term, model.term) > 0) model = toppedModel;
  billedMs = Math.max(
    billedMs,
    fundTime(addDecimal(browserTimeCredits(billedMs, creditsPerMinute), positivePart(addDecimal(funds, `-${priced()}`)))),
  );
  billedBandwidthBytes = Math.max(
    billedBandwidthBytes,
    fundBandwidth(
      addDecimal(bandwidthCredits(billedBandwidthBytes, creditsPerByte), positivePart(addDecimal(funds, `-${priced()}`))),
    ),
  );

  return {
    billedModelCostUsd: model.usd,
    billedMs,
    billedBandwidthBytes,
    modelTerm: model.term,
    timeTerm: browserTimeCredits(billedMs, creditsPerMinute),
    bandwidthTerm: bandwidthCredits(billedBandwidthBytes, creditsPerByte),
  };
}

/**
 * The pricing a ledger applies when its host names none: AT COST. A credit is
 * one provider dollar of model usage, browser time and bandwidth are free, and
 * a run whose own model key served it (`byok`) costs nothing. So `caps.budget`
 * reads as a ceiling on model spend in dollars, which is what a run on the
 * user's own browser and keys is bounded by. A host that bills its runs passes
 * its own price list on every run.
 */
export const DEFAULT_RUN_PRICING: RunPricing = Object.freeze({
  creditsPerMinute: ZERO_CREDITS,
  creditsPerByte: ZERO_CREDITS,
  model: Object.freeze({ plan: 'at-cost', byok: false }),
  modelCredits(usd: string, model: ModelPricing): string {
    if (compareDecimal(usd, ZERO_CREDITS) < 0) {
      throw new RangeError(`model cost must not be negative, got ${usd}`);
    }
    return model.byok ? ZERO_CREDITS : usd;
  },
  modelUsdFundedBy(credits: string): string {
    return compareDecimal(credits, ZERO_CREDITS) > 0 ? credits : ZERO_CREDITS;
  },
});

/**
 * One reading of what a run is billed: each metered quantity as MEASURED and
 * as BILLED, and the credits the billed quantities price to. The two differ
 * only where `caps.budget` stopped paying. See {@link CapLedger.billing}.
 */
export interface RunBilling {
  readonly credits: string;
  readonly measuredMs: number;
  readonly billedMs: number;
  /**
   * The part of {@link measuredMs} the run spent parked on a human, across
   * every attempt. On the bill like any other open minute; off the
   * `caps.duration` clock. See {@link CapLedger.park}.
   */
  readonly parkedMs: number;
  /** Page loads. Reported, no longer priced: an agent run is not billed per page. */
  readonly pages: number;
  readonly bandwidthBytes: number;
  readonly billedBandwidthBytes: number;
  /** Provider USD the run's model calls cost, across every attempt, as the provider stated it. */
  readonly modelCostUsd: string;
  /** The part of {@link modelCostUsd} the budget funded. Equal to it unless the ceiling bound. */
  readonly billedModelCostUsd: string;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * Checks the ceilings. The API validates the whole request through
 * `validateAgentRequest`; this exists because the loop takes caps directly and
 * must not start a run whose SPEND it cannot bound.
 *
 * Refuses exactly what core's validator refuses for the GRAMMAR, sentence for
 * sentence and through the same function, so a caller who hits the loop
 * directly is told what a caller who came through HTTP is told: `budget`
 * required, `steps` and `duration` refused only when present and malformed.
 *
 * It names no budget FLOOR, and that is the one place the two boundaries
 * legitimately differ. `capBudgetError`'s floor is the price of one page on the
 * PUBLISHED rate card, which is what every request crossing the edge is billed
 * at; a {@link CapLedger} may be constructed with any {@link RunPricing} — a
 * test drives a round rate, and a future per-tier rate arrives the same way —
 * so a floor applied here would refuse a ceiling that is perfectly fundable at
 * the pricing the ledger was handed.
 */
export function validateCaps(caps: unknown): ValidationResult<AgentCaps> {
  const errors: string[] = [];
  if (typeof caps !== 'object' || caps === null || Array.isArray(caps)) {
    return { ok: false, errors: ['caps must be an object with a budget'] };
  }
  const input = caps as Record<string, unknown>;

  const budget = input['budget'];
  const budgetError = capBudgetError(budget);
  if (budgetError !== undefined) {
    errors.push(budgetError);
  }
  const steps = input['steps'];
  if (steps !== undefined && (typeof steps !== 'number' || !Number.isInteger(steps) || steps < 1)) {
    errors.push('caps.steps must be a positive integer when present');
  }
  const duration = input['duration'];
  const durationError = capDurationError(duration);
  if (durationError !== undefined) {
    errors.push(durationError);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  // Rebuilt field by field rather than passed through, so an unset ceiling is
  // an ABSENT KEY and not a key holding `undefined`: the difference is visible
  // in JSON, and this value is stored on the run row.
  const value: AgentCaps = { budget: budget as string };
  if (steps !== undefined) {
    value.steps = steps as number;
  }
  if (duration !== undefined) {
    value.duration = duration as string;
  }
  return { ok: true, value };
}

/* ------------------------------------------------------------------ *
 * The ledger
 * ------------------------------------------------------------------ */

export interface CapState {
  readonly steps: number;
  /**
   * TOTAL billable credits spent so far: everything explicitly charged, plus
   * the run's model usage, browser time and bandwidth at the run's pricing.
   * The number the cap tests and the number on the invoice. See
   * {@link CapLedger}.
   *
   * Read by {@link GoalLedger} as a sub-goal's `runSpentAtStart`. NOT what a
   * resume seeds from: see {@link charged}.
   */
  readonly credits: string;
  /**
   * The part of {@link credits} that was EXPLICITLY charged — per-action costs
   * and the agent's own web tools — and therefore the only part a resume has
   * to carry forward as credits.
   *
   * Time, model usage and bandwidth are deliberately not in here. Time is
   * re-derived, because a seeded `elapsedMs` moves the ledger's own start
   * backwards; model usage and bandwidth cannot be re-derived — a re-acquired
   * run's new browser and a new machine's model client start their counters
   * at zero — so they travel as quantities in {@link modelCostUsd} and
   * {@link bandwidthBytes}, and are priced again rather than carried as an
   * anonymous charge.
   */
  readonly charged: string;
  /**
   * Page loads on attempts BEFORE this one. Zero on every ordinary run.
   * Reported, not priced.
   */
  readonly pages: number;
  /**
   * Bytes relayed through a residential exit on attempts BEFORE this one,
   * both directions summed. Zero on every ordinary run. A re-acquired run's
   * new browser context starts its OWN `Outcrawl.getContextBytes` counter at
   * zero, so a previous attempt's bytes travel forward here or a customer's
   * bandwidth spend resets on every browser their task loses.
   */
  readonly bandwidthBytes: number;
  /**
   * Provider USD the run's model calls cost on attempts BEFORE this one,
   * exact. `'0'` on every ordinary run. Required for {@link bandwidthBytes}'s
   * reason: a resumed run's model client starts its own cost ledger at zero.
   */
  readonly modelCostUsd: string;
  /**
   * The price tier the run is priced at ({@link ModelPricing.plan}) and whether
   * the user's own model key served it. Carried so a resumed run — on this
   * machine or another — is priced at the tier it started under, whatever the
   * resuming request says.
   */
  readonly plan: string;
  readonly byok: boolean;
  /**
   * Milliseconds the run has been OPEN, which is the time it is billed for:
   * parks, holds and handovers included.
   */
  readonly elapsedMs: number;
  /**
   * The part of {@link elapsedMs} the run spent parked on a human, across
   * every attempt. Carried apart from it because the two clocks differ:
   * billing counts every open minute, while `caps.duration` does not count a
   * park. Without it a resumed run's duration clock would start from the open
   * time and a park on an earlier attempt would count against the ceiling, so
   * a run that waited an hour on a question and then lost its browser would
   * stop at `max-duration` at once.
   */
  readonly parkedMs: number;
  /**
   * Model calls a lab subscription served on attempts BEFORE this one
   * (OC-286), carried for {@link modelCostUsd}'s reason. Attribution only:
   * this ledger never prices it. Absent reads as none.
   */
  readonly subscriptionCalls?: number;
}

/**
 * Counts what a run has consumed and answers one question: has a ceiling been
 * reached.
 *
 * Reached, not exceeded. A budget of `"1.00"` with `"1.00"` already spent buys
 * nothing further, so the run stops there rather than starting a step it
 * cannot pay for. The customer's ceiling is a ceiling, not a suggestion.
 *
 * ── The budget cap counts what the INVOICE counts (W44, 2026-09-25) ────────
 *
 * An agent run is billed three things, and this class prices all three
 * through the one {@link RunPricing} its host bills with, so the figure that
 * stops the run and the figure on the invoice are one number:
 *
 *   model usage   the provider's USD for every call the run made — read live
 *                 from the host's cost ledger through `modelCostUsd` — as
 *                 credits at the run's price (`RunPricing.modelCredits`)
 *   browser time  `creditsPerMinute` for as long as the run is OPEN, parks,
 *                 holds and handovers included (`browserTimeCredits`)
 *   bandwidth     `creditsPerByte` relayed through a proxy exit
 *
 * plus anything explicitly {@link charge}d (the agent's own `web.*` tools).
 * There is no per-page term and no per-minute agent term any more.
 *
 * It used to be one of those at a time. Measured 2026-09-08: of 26 runs
 * carrying a budget, 12 exceeded it by up to 4.20x, because this class
 * counted only explicit charges while the invoice billed time and pages; and
 * 2026-09-23, `run_…`: reported 6.108400 against 23.999756 charged,
 * the gap exactly its bandwidth. Model spend was the last term the cap could
 * not see, and the largest.
 *
 * Time comes from an injected `Clock`, and model USD, pages and bandwidth
 * from injected readers, because this package cannot count a provider's
 * charge, a page load or a byte honestly — it reads the host's own counters,
 * which are the numbers that bill.
 *
 * A ledger may be SEEDED with what a run already spent, which is what makes a
 * resumed run continue its customer's ceiling instead of being handed a second
 * one. See the `used` parameter. A ledger may also be PARKED while a human has
 * the run. See {@link park}.
 */
export class CapLedger {
  readonly maxSteps: number;
  readonly budget: string;
  readonly durationMs: number;
  /** The plan and key this run is priced at. See {@link CapState.plan}. */
  readonly pricing: RunPricing;

  readonly #clock: Clock;
  readonly #pageLoads: () => number;
  readonly #bandwidthBytesReader: () => number;
  readonly #modelCostUsdReader: () => string;
  readonly #startedAt: number;
  #steps = 0;
  /**
   * Only what was explicitly charged. Time, model usage and bandwidth are
   * priced on demand rather than accumulated, because they are functions of
   * the clock and a counter and an accumulated copy could disagree with either.
   */
  #charged: string = ZERO_CREDITS;
  /** Page loads on previous attempts. See {@link CapState.pages}. */
  #pagesBefore = 0;
  /** Bandwidth bytes measured on previous attempts. See {@link CapState.bandwidthBytes}. */
  #bandwidthBytesBefore = 0;
  /** Model USD on previous attempts. See {@link CapState.modelCostUsd}. */
  #modelCostUsdBefore: string = ZERO_CREDITS;
  /**
   * Parked intervals already closed, on this attempt and every earlier one
   * (seeded from {@link CapState.parkedMs}). Subtracted from the DURATION
   * reading only.
   */
  #parkedMs = 0;
  /** When the current park began, or `undefined` when the run is not parked. */
  #parkedSince: number | undefined;

  /**
   * @param used What this run has ALREADY spent, on a previous attempt whose
   * browser or machine died. Absent on every ordinary run. `elapsedMs` is
   * applied by moving the ledger's own start BACKWARDS, so `duration` and the
   * billed time both measure the run and not the attempt; `parkedMs` starts
   * the park total, so earlier parks stay off `duration` and on the bill. Its
   * `plan` and `byok` WIN over `pricing`'s: a run is priced at the plan it
   * started under.
   *
   * @param pricing The host's price list, its `model` the run's own pricing.
   * Defaults to {@link DEFAULT_RUN_PRICING} (at cost); a billing host always
   * passes its own.
   *
   * @param pageLoads The browser's own committed-navigation counter, reported
   * and not priced.
   *
   * @param bandwidthBytes The browser's own cumulative relayed-byte counter
   * for THIS attempt (`Outcrawl.getContextBytes`), read live by the loop once
   * per step and handed here as a synchronous reader.
   *
   * @param modelCostUsd The provider USD this attempt's model calls have cost
   * so far — every call, retries, corrections, planner and look calls and
   * billed failures included — read live from the host's cost ledger. Defaults
   * to "this host bills no model usage".
   */
  constructor(
    caps: AgentCaps,
    clock: Clock,
    used?: CapState,
    pricing: RunPricing = DEFAULT_RUN_PRICING,
    pageLoads: () => number = () => 0,
    bandwidthBytes: () => number = () => 0,
    modelCostUsd: () => string = () => ZERO_CREDITS,
  ) {
    const validated = validateCaps(caps);
    if (!validated.ok) {
      throw new TypeError(`invalid caps: ${validated.errors.join('; ')}`);
    }
    if (!isDecimalString(pricing.creditsPerMinute) || !isDecimalString(pricing.creditsPerByte)) {
      throw new TypeError('run pricing must be decimal strings');
    }
    // `Infinity` when the caller named no such ceiling, which is what makes
    // `tripped()` below need no branch.
    this.maxSteps = capStepCeiling(validated.value);
    this.budget = validated.value.budget;
    this.durationMs = capDurationCeilingMs(validated.value);
    this.pricing =
      used === undefined
        ? pricing
        : { ...pricing, model: Object.freeze({ plan: used.plan, byok: used.byok }) };
    this.#clock = clock;
    this.#pageLoads = pageLoads;
    this.#bandwidthBytesReader = bandwidthBytes;
    this.#modelCostUsdReader = modelCostUsd;
    this.#startedAt = clock.now() - (used?.elapsedMs ?? 0);
    if (used !== undefined) {
      this.#steps = used.steps;
      this.#pagesBefore = used.pages;
      this.#bandwidthBytesBefore = used.bandwidthBytes;
      if (!isDecimalString(used.modelCostUsd) || used.modelCostUsd.startsWith('-')) {
        throw new TypeError(`a resumed run's modelCostUsd must be a non-negative decimal, got ${used.modelCostUsd}`);
      }
      this.#modelCostUsdBefore = used.modelCostUsd;
      if (!Number.isFinite(used.parkedMs) || used.parkedMs < 0 || used.parkedMs > used.elapsedMs) {
        throw new TypeError(
          `a resumed run's parkedMs must be between 0 and its elapsedMs (${String(used.elapsedMs)}), got ${String(used.parkedMs)}`,
        );
      }
      this.#parkedMs = used.parkedMs;
      // Through `charge`, not by assignment: it is the one place that refuses a
      // non-decimal or negative amount, and a seed read back from a database
      // row deserves that check more than a value the loop just computed does.
      this.charge(used.charged);
    }
  }

  get steps(): number {
    return this.#steps;
  }

  /** Pages this run has loaded, across every browser it has held. */
  get pages(): number {
    return this.#pagesBefore + this.#pageLoads();
  }

  /** Bytes relayed through a residential exit, across every browser this run has held. */
  get bandwidthBytes(): number {
    return this.#bandwidthBytesBefore + this.#bandwidthBytesReader();
  }

  /** Provider USD the run's model calls have cost, across every attempt. */
  get modelCostUsd(): string {
    return addDecimal(this.#modelCostUsdBefore, this.#modelCostUsdReader());
  }

  /**
   * Integer milliseconds this run has been OPEN, which is the reading its
   * browser time is billed FROM — see {@link billing} for how much of it the
   * budget pays for.
   *
   * `Clock.now()` is monotonic and fractional, and a rate card requires an
   * integer count, so the cap prices the SAME rounded reading the invoice does.
   */
  measuredMs(): number {
    return Math.round(this.#clock.now() - this.#startedAt);
  }

  /**
   * Every figure the bill is made of, from ONE reading of each counter.
   *
   * ── The budget is a hard ceiling on what is billed ──────────────────────
   *
   * The caps are tested BEFORE a step, so the step in progress keeps spending
   * — a model call, time, a page's bytes — past the moment the budget runs
   * out. So explicit charges come off the budget first, and what is left funds
   * model usage, browser time and bandwidth IN PROPORTION to their measured
   * prices ({@link fundRunTerms}); a quantity the budget cannot fund is
   * measured and not billed. The billed quantities are what the host meters
   * (`AgentResult.billedMs`, the settlement's model charge,
   * `AgentDeps.onBandwidthBilled`), so the ledger and the invoice stay one
   * figure.
   *
   * Explicit charges are not clamped: they are the agent's own `web.*` calls,
   * each already billed under its own capability.
   */
  billing(): RunBilling {
    const now = this.#clock.now();
    const measuredMs = Math.round(now - this.#startedAt);
    // Rounded like `measuredMs`, and never above it: a park is part of the
    // open time it was measured inside.
    const parkedMs = Math.round(this.#parkedAt(now));
    const pages = this.pages;
    const bandwidthBytes = this.bandwidthBytes;
    const modelCostUsd = this.modelCostUsd;
    const funded = fundRunTerms(addDecimal(this.budget, `-${this.#charged}`), {
      modelCostUsd,
      measuredMs,
      bandwidthBytes,
      pricing: this.pricing,
    });
    const { billedModelCostUsd, billedMs, billedBandwidthBytes } = funded;

    // A zero term is skipped rather than added: `multiplyDecimal` widens the
    // scale, and four invented decimal places on a run that has spent nothing
    // is noise claiming to be precision.
    let credits = this.#charged;
    for (const term of [funded.modelTerm, funded.timeTerm, funded.bandwidthTerm]) {
      if (compareDecimal(term, ZERO_CREDITS) !== 0) {
        credits = addDecimal(credits, term);
      }
    }
    return {
      credits,
      measuredMs,
      billedMs,
      parkedMs,
      pages,
      bandwidthBytes,
      billedBandwidthBytes,
      modelCostUsd,
      billedModelCostUsd,
    };
  }

  /**
   * Bytes actually priced into `credits`: {@link bandwidthBytes}, less any the
   * budget could not fund after charges, model usage and time. EXPRESSED AS
   * BYTES so the same clamped figure is what `AgentDeps.onBandwidthBilled`
   * hands the host to meter.
   */
  get billedBandwidthBytes(): number {
    return this.billing().billedBandwidthBytes;
  }

  /**
   * What this run has cost so far, exact, in the units the invoice charges.
   * The number `AgentResult.credits` reports AND the number {@link tripped}
   * and {@link budgetRemainingMs} test against — one figure. See
   * {@link billing}.
   */
  get credits(): string {
    return this.billing().credits;
  }

  /**
   * Wall clock this run is answerable to for `caps.duration`: everything since
   * it started, LESS every interval it spent parked on a human, on this
   * attempt and every earlier one.
   *
   * Not the billed time. Billing counts every minute the run is open — see
   * {@link measuredMs} — because the browser is held whether or not a human is
   * the one being waited on (owner decision W44, 2026-09-25). A park stops the
   * DURATION clock only, so a question answered at 09:00 does not kill a run
   * that asked it at 02:00 — nor a run that asked it and then lost its browser:
   * `CapState.parkedMs` carries earlier attempts' parks into the seeded ledger.
   */
  elapsedMs(): number {
    const now = this.#clock.now();
    return now - this.#startedAt - this.#parkedAt(now);
  }

  /** Time spent parked on a human so far, across every attempt, including a park still open. */
  #parkedAt(now: number): number {
    const open = this.#parkedSince === undefined ? 0 : now - this.#parkedSince;
    return this.#parkedMs + open;
  }

  /**
   * STOP THE DURATION CLOCK while a human has the run — and keep billing it.
   *
   * Returns the resume, which is idempotent. Re-entrant parks are NOT nested:
   * a second `park` while one is open returns a resume for the open interval.
   *
   * ## Why a parked run does not burn `caps.duration`
   *
   * Because `duration` is protection against OUR loop running away, and the
   * only thing running here is a person deciding: a run that asks a question
   * at 02:00 and is answered at 09:00 must not die at `max-duration` for having
   * asked correctly.
   *
   * ## Why it is still billed
   *
   * The browser is held for every minute of it. Owner decision W44
   * (2026-09-25): browser time is billed at 1 credit a minute for as long as
   * the run is open, "including paused, held and /play-driven time". So a park
   * is bounded by `caps.budget` like any other minute, which also answers the
   * case that used to be unbounded: the live viewer's mid-step handover
   * (`packages/worker/src/live-control.ts` `take`) has no deadline of its own,
   * and now it spends the customer's budget while it lasts.
   *
   * ## What is NOT a park: an `agent.control` hold
   *
   * A hold taken over the API (`agent.control {action:'take'}`) never reaches
   * this method. The host holds the loop at the top of a pass
   * (`AgentRunRequest.beforeStep`), on a running clock and never past what
   * {@link durationMs} and {@link budgetRemainingMs} leave, so it is billed and
   * burns the duration clock alike.
   */
  park(): () => void {
    if (this.#parkedSince === undefined) {
      this.#parkedSince = this.#clock.now();
    }
    let resumed = false;
    return (): void => {
      if (resumed) {
        return;
      }
      resumed = true;
      const since = this.#parkedSince;
      if (since !== undefined) {
        this.#parkedMs += this.#clock.now() - since;
        this.#parkedSince = undefined;
      }
    };
  }

  get state(): CapState {
    const billing = this.billing();
    return {
      steps: this.#steps,
      credits: billing.credits,
      charged: this.#charged,
      pages: billing.pages,
      bandwidthBytes: billing.bandwidthBytes,
      modelCostUsd: billing.modelCostUsd,
      plan: this.pricing.model.plan,
      byok: this.pricing.model.byok,
      elapsedMs: billing.measuredMs,
      parkedMs: billing.parkedMs,
    };
  }

  countStep(): void {
    this.#steps += 1;
  }

  /** Charges credits. Refuses a negative amount: a negative charge is a bug. */
  charge(credits: string): void {
    if (!isDecimalString(credits)) {
      throw new TypeError(`credits must be a decimal string, got ${JSON.stringify(credits)}`);
    }
    if (compareDecimal(credits, ZERO_CREDITS) < 0) {
      throw new RangeError(`credits must not be negative, got ${credits}`);
    }
    this.#charged = addDecimal(this.#charged, credits);
  }

  /**
   * Which ceiling has been reached, or `undefined`. Checked in a fixed order —
   * steps, budget, duration — so a run that trips two at once reports the same
   * one every time and a replay is reproducible.
   */
  tripped(): CapName | undefined {
    if (this.#steps >= this.maxSteps) {
      return 'steps';
    }
    if (budgetExhausted(this.billing(), this.budget)) {
      return 'budget';
    }
    if (this.elapsedMs() >= this.durationMs) {
      return 'duration';
    }
    return undefined;
  }

  /**
   * How much longer the budget can fund browser time, in milliseconds, or `0`
   * once it cannot fund anything.
   *
   * THIS IS WHAT BOUNDS THE OVERSHOOT of a settle wait: the loop clamps the
   * wait to what the budget can still fund, as it clamps it to what
   * `caps.duration` has left. It cannot foresee model usage or bandwidth the
   * wait does not spend.
   *
   * Deliberately `number` and not an exact decimal, and it is the one place in
   * this class where that is allowed: this is a poll deadline, never money.
   * {@link tripped} remains the only authority, and it is exact.
   */
  budgetRemainingMs(): number {
    const billing = this.billing();
    if (budgetExhausted(billing, this.budget)) {
      return 0;
    }
    const remaining = addDecimal(this.budget, `-${billing.credits}`);
    const perMinute = Number(this.pricing.creditsPerMinute);
    // A deployment that charges nothing for time has no budget deadline to
    // compute: waiting is free and clamping it would be clamping to nothing.
    if (!(perMinute > 0)) {
      return Number.POSITIVE_INFINITY;
    }
    return (Number(remaining) / perMinute) * Number(MS_PER_MINUTE);
  }
}

/**
 * The budget can fund nothing further: the bill has reached it, OR some
 * measured quantity is already beyond what the bill could pay for.
 *
 * The second arm is not redundant. Browser time is billed in whole
 * milliseconds and model usage to the provider's twelfth place, so a clamped
 * term can land a few millionths of a credit UNDER the ceiling and stay there:
 * one cent of Builder model usage (3.469388) on a 4.00 budget leaves 31,836.72
 * ms of time, the bill stops at 3.999988, and a cap that compared only the
 * bill to the budget never tripped while the run went on working unbilled.
 */
function budgetExhausted(billing: RunBilling, budget: string): boolean {
  return (
    compareDecimal(billing.credits, budget) >= 0 ||
    compareDecimal(billing.billedModelCostUsd, billing.modelCostUsd) < 0 ||
    billing.billedMs < billing.measuredMs ||
    billing.billedBandwidthBytes < billing.bandwidthBytes
  );
}

/** The stop reason a cap maps to. */
export function capStopReason(cap: CapName): 'max-steps' | 'max-budget' | 'max-duration' {
  switch (cap) {
    case 'steps':
      return 'max-steps';
    case 'budget':
      return 'max-budget';
    case 'duration':
      return 'max-duration';
  }
}

/* ------------------------------------------------------------------ *
 * Per-sub-goal caps
 * ------------------------------------------------------------------ */

/**
 * How a run's ceilings are apportioned between its sub-goals.
 *
 * Absent from a request means no apportionment at all, which is the behaviour
 * every existing caller gets and the right default: a single-goal run has
 * nothing to divide, and dividing it would only invent a second way for it to
 * stop.
 *
 * The problem this solves is specific and was measured on long runs: flat caps
 * over a five-part task let ONE stuck sub-goal spend the ceiling for the other
 * four. The run ends `capped` with one item bought and four never attempted,
 * and the trace shows thirty steps of a model failing at the same checkout. A
 * per-goal ceiling turns that into one failed sub-goal and four attempted ones.
 */
export type GoalCapPolicy =
  /**
   * Each sub-goal gets an equal share of what the run has LEFT at the moment it
   * becomes active. Recomputed per goal rather than divided once up front, so a
   * goal that finishes under budget hands the remainder to the goals after it,
   * and a plan revised from three sub-goals to five re-apportions instead of
   * overcommitting.
   */
  | { readonly kind: 'share' }
  /** The same explicit ceiling for every sub-goal. Never scaled by the run's remainder. */
  | { readonly kind: 'fixed'; readonly caps: AgentCaps };

/**
 * A resolved per-goal ceiling.
 *
 * `share` keeps the budget as the three inputs of a comparison rather than as a
 * computed number, deliberately: the test is
 * `spent * openGoals + runSpentAtStart >= runBudget`, which is algebraically
 * `spent >= (runBudget - runSpentAtStart) / openGoals` but needs only the exact
 * multiply and add that `@outcrawl/scout-core` already provides. Dividing would mean
 * choosing a rounding scale for money, and a division that rounds UP lets the
 * shares sum to more than the run's ceiling — which is the one thing a cap may
 * never do.
 */
type GoalLimit =
  | {
      readonly kind: 'share';
      readonly steps: number;
      readonly durationMs: number;
      readonly openGoals: number;
      readonly runSpentAtStart: string;
      readonly runBudget: string;
    }
  | {
      readonly kind: 'fixed';
      readonly steps: number;
      readonly durationMs: number;
      readonly budget: string;
    };

/**
 * Counts what ONE sub-goal has consumed and answers whether its share is spent.
 *
 * Constructed when a sub-goal becomes active, from the run's state at that
 * moment, and discarded when it closes. The ceiling is frozen at construction
 * on purpose: recomputing "remaining / open" every step would shrink the goal's
 * own ceiling as the goal spent, so a goal would trip against a moving target
 * and a run would stop for a reason no reader could reconstruct.
 *
 * A per-goal ceiling never raises the run's. {@link CapLedger} is checked first
 * and independently; this only ever ends a goal earlier than the run would have.
 *
 * Prices its own model usage, time and bandwidth exactly as {@link CapLedger}
 * does, at the same plan, so a share of the budget is a share of the real
 * bill. `runSpentAtStart` comes off `CapLedger.state.credits`, so the two
 * ledgers apportion the same currency.
 */
export class GoalLedger {
  readonly goalId: string;

  readonly #clock: Clock;
  readonly #startedAt: number;
  readonly #limit: GoalLimit;
  readonly #pricing: RunPricing;
  readonly #pageLoads: () => number;
  readonly #bandwidthBytesReader: () => number;
  readonly #modelCostUsdReader: () => string;
  /** The run's page count when this goal became active. Its own pages are the delta. */
  readonly #pagesAtStart: number;
  /** The run's bandwidth reading when this goal became active. Its own bandwidth is the delta. */
  readonly #bandwidthBytesAtStart: number;
  /** The attempt's model USD reading when this goal became active. Its own spend is the delta. */
  readonly #modelCostUsdAtStart: string;
  #steps = 0;
  #charged: string = ZERO_CREDITS;

  /**
   * @param pricing The run ledger's own {@link CapLedger.pricing}: a goal is
   * priced at the run's plan.
   * @param modelCostUsd The same attempt-level reader the run ledger holds.
   */
  constructor(
    goalId: string,
    policy: GoalCapPolicy,
    run: { readonly caps: AgentCaps; readonly used: CapState },
    openGoals: number,
    clock: Clock,
    pricing: RunPricing = DEFAULT_RUN_PRICING,
    pageLoads: () => number = () => 0,
    bandwidthBytes: () => number = () => 0,
    modelCostUsd: () => string = () => ZERO_CREDITS,
  ) {
    this.goalId = goalId;
    this.#clock = clock;
    this.#pricing = pricing;
    this.#pageLoads = pageLoads;
    this.#bandwidthBytesReader = bandwidthBytes;
    this.#modelCostUsdReader = modelCostUsd;
    this.#pagesAtStart = run.used.pages;
    this.#bandwidthBytesAtStart = run.used.bandwidthBytes;
    this.#modelCostUsdAtStart = modelCostUsd();
    this.#startedAt = clock.now();

    if (policy.kind === 'fixed') {
      const validated = validateCaps(policy.caps);
      if (!validated.ok) {
        throw new TypeError(`invalid goal caps: ${validated.errors.join('; ')}`);
      }
      this.#limit = {
        kind: 'fixed',
        steps: capStepCeiling(validated.value),
        durationMs: capDurationCeilingMs(validated.value),
        budget: validated.value.budget,
      };
      return;
    }

    // At least one, always. A floor of zero would trip the goal before it took
    // a single step, so a plan with more sub-goals than remaining steps would
    // fail every one of them without trying any — strictly worse than today,
    // where at least the first few get attempted.
    const share = Math.max(1, openGoals);
    // An unbounded run apportions unbounded shares: `Infinity / n` is
    // `Infinity`, so a goal under a run with no step ceiling has no step
    // ceiling either, and the budget share below is what still bounds it.
    this.#limit = {
      kind: 'share',
      steps: Math.max(1, Math.floor((capStepCeiling(run.caps) - run.used.steps) / share)),
      // What the run's DURATION clock has left, so parked time is not a share.
      durationMs: Math.max(
        1,
        Math.floor((capDurationCeilingMs(run.caps) - (run.used.elapsedMs - run.used.parkedMs)) / share),
      ),
      openGoals: share,
      runSpentAtStart: run.used.credits,
      runBudget: run.caps.budget,
    };
  }

  get steps(): number {
    return this.#steps;
  }

  /** This sub-goal's own step ceiling. Rendered in the prompt so it is not a surprise. */
  get stepsLimit(): number {
    return this.#limit.steps;
  }

  /**
   * This goal's own billable spend, in the units the invoice charges: its
   * explicit charges plus its own model usage, time and bandwidth at the run's
   * pricing. Zero terms are skipped for {@link CapLedger.billing}'s reason.
   */
  get credits(): string {
    let total = this.#charged;
    const model = this.#pricing.modelCredits(this.modelCostUsd, this.#pricing.model);
    const time = browserTimeCredits(Math.round(this.#clock.now() - this.#startedAt), this.#pricing.creditsPerMinute);
    for (const term of [model, time]) {
      if (compareDecimal(term, ZERO_CREDITS) !== 0) {
        total = addDecimal(total, term);
      }
    }
    const bandwidthBytes = this.bandwidthBytes;
    if (bandwidthBytes !== 0) {
      total = addDecimal(total, multiplyDecimal(String(bandwidthBytes), this.#pricing.creditsPerByte));
    }
    return total;
  }

  /** Model USD spent since this goal became active. */
  get modelCostUsd(): string {
    const delta = addDecimal(this.#modelCostUsdReader(), `-${this.#modelCostUsdAtStart}`);
    return compareDecimal(delta, ZERO_CREDITS) > 0 ? delta : ZERO_CREDITS;
  }

  /** Pages loaded since this goal became active. */
  get pages(): number {
    return Math.max(0, this.#pageLoads() - this.#pagesAtStart);
  }

  /** Bandwidth bytes relayed since this goal became active. */
  get bandwidthBytes(): number {
    return Math.max(0, this.#bandwidthBytesReader() - this.#bandwidthBytesAtStart);
  }

  get state(): CapState {
    return {
      steps: this.#steps,
      credits: this.credits,
      charged: this.#charged,
      pages: this.pages,
      bandwidthBytes: this.bandwidthBytes,
      modelCostUsd: this.modelCostUsd,
      plan: this.#pricing.model.plan,
      byok: this.#pricing.model.byok,
      elapsedMs: this.#clock.now() - this.#startedAt,
      // A goal ledger has no park of its own: the run ledger holds the parks.
      parkedMs: 0,
    };
  }

  countStep(): void {
    this.#steps += 1;
  }

  charge(credits: string): void {
    if (!isDecimalString(credits)) {
      throw new TypeError(`credits must be a decimal string, got ${JSON.stringify(credits)}`);
    }
    if (compareDecimal(credits, ZERO_CREDITS) < 0) {
      throw new RangeError(`credits must not be negative, got ${credits}`);
    }
    this.#charged = addDecimal(this.#charged, credits);
  }

  /** Same fixed order as {@link CapLedger.tripped}, so a replay is reproducible. */
  tripped(): CapName | undefined {
    const limit = this.#limit;
    if (this.#steps >= limit.steps) {
      return 'steps';
    }
    const spent = this.credits;
    const budgetReached =
      limit.kind === 'fixed'
        ? compareDecimal(spent, limit.budget) >= 0
        : compareDecimal(
            addDecimal(multiplyDecimal(spent, String(limit.openGoals)), limit.runSpentAtStart),
            limit.runBudget,
          ) >= 0;
    if (budgetReached) {
      return 'budget';
    }
    return this.#clock.now() - this.#startedAt >= limit.durationMs ? 'duration' : undefined;
  }
}
