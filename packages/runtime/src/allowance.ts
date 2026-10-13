/**
 * The ACCOUNT's ceiling, as a run can see it.
 *
 * `CapLedger` beside this file answers "has this RUN reached the ceiling its
 * caller wrote", which is the only question the loop asked until 2026-09-08.
 * This answers the other one: "does the WORKSPACE still have credits". They are
 * different ceilings owned by different people, and collapsing them was never an
 * option — a run whose `caps.budget` is nine tenths unspent can still belong to
 * an account that has nothing left, and telling that customer `max-budget`
 * would be a lie about a number they chose.
 *
 * ## What was wrong
 *
 * Nothing enforced the account's balance at all. `CreditBalance.exhausted` was
 * computed by Postgres, returned by `/v1/credits` and read by NOTHING — "an
 * exhausted pool refuses no work today", in the handler's own words — so
 * `caps.budget` was the only bound between an account and unbounded spend, and
 * that number is chosen by the CALLER. A caller who sends a large budget was
 * not bounded by their balance in any way. Measured on production 2026-09-08:
 * the owner's own account was serving requests at roughly -191 credits.
 *
 * ## Why the number is DELIVERED and not read
 *
 * Because this process cannot read it. A fleet Mac holds a ticket secret and no
 * database credential, and `worker/src/control-store.ts` refuses
 * `creditBalance` by name for that reason. So the allowance arrives on the
 * dispatch the edge already makes — `X-Outcrawl-Account-Credits`, set by the
 * tier that has just computed it to decide admission — and this class subtracts
 * what the run spends from it locally. No round trip per step, and no round trip
 * per run beyond the one that was already happening.
 *
 * ## It is THIS RUN's share, not the account's whole balance
 *
 * The edge hands each run `min(caps.budget, what the account has left − what
 * its other open runs still hold)` and holds that share in the account's
 * `Quota` object until the run ends (`RunAllowance` in `@outcrawl/server`).
 * Before that every run was handed the whole balance, so N runs started
 * together could spend N times it — each one drawing down its own private copy
 * of the same number. A resume offer carries the share on the run's cumulative
 * scale (earlier attempts' spend plus the new share), matching the ledger the
 * resumed run is seeded with.
 *
 * ## The rule, and it is not a new one
 *
 * STOP BEFORE STARTING A STEP YOU CANNOT AFFORD. A step's cost is known only
 * after the model returns, so an exact stop is not available to anybody; the
 * ceiling is therefore tested at the TOP of a step, exactly as `CapLedger` tests
 * `caps.budget`, and the residual is one step. That convention is `docs/AGENTS.md`'s
 * detect-and-stop contract and this file does not invent a second one.
 */

import { ZERO_CREDITS, addDecimal, compareDecimal, isDecimalString } from '@outcrawl/scout-core';

/**
 * What the account may still spend when a run begins, or `null` for a run with
 * no account ceiling.
 *
 * `null` has three producers and one meaning to this file — no account ceiling
 * applies — and all three are stated where they are made rather than here: an
 * admin workspace with unlimited credits, a ledger read that failed (admission
 * itself lapses open in that case and says so at length), and a caller that is
 * not the edge at all, such as a monitor check or a test.
 */
export type AccountCredits = string | null;

/**
 * The account's remaining allowance, drawn down by what this run spends.
 *
 * Constructed once per run from the delivered figure. `spent` is read from the
 * ledger the run is already keeping, so the two numbers cannot disagree about
 * what this run has cost: there is one figure, it is the one on the invoice, and
 * this class subtracts rather than counts.
 */
export class AccountAllowance {
  /**
   * This run's share of the account at the instant it was dispatched, or
   * `null` for a run with no account ceiling.
   *
   * Signed. A NEGATIVE starting allowance is a real and reachable state — an
   * account can be past its allowance when a run is dispatched, because the
   * figure the edge compared was up to `CREDITS_CACHE_TTL_MS` old — and it is
   * not clamped to zero. Clamping would hide the one case where the residual is
   * already spent, and {@link exhausted} answers the same way for both.
   */
  readonly startedWith: AccountCredits;

  constructor(credits: AccountCredits) {
    if (credits !== null && !isSignedDecimal(credits)) {
      // A TypeError and not a silent `null`, on `CapLedger`'s precedent for a
      // malformed cap: a value that reached here and is not a decimal came from
      // a host that is constructing this wrong, and reading it as "no ceiling"
      // would turn one bad caller into an unenforced ceiling for every run it
      // starts. Every seam that can receive one from OUTSIDE this process —
      // `accountAllowanceOf` in `@outcrawl/api` — has already turned an
      // unparseable header into `null` with its reasons written down, so this
      // is unreachable from the wire and reachable only from our own code.
      throw new TypeError(
        `account credits must be a signed decimal string or null, got ${JSON.stringify(credits)}`,
      );
    }
    this.startedWith = credits;
  }

  /**
   * What is left after `spent`, or `null` when no ceiling applies.
   *
   * Exact decimal arithmetic throughout: the allowance is money, and a
   * subtraction that went through binary64 would be a ceiling that disagrees
   * with the ledger it was computed from by a fraction nobody can reconcile.
   */
  remaining(spent: string): AccountCredits {
    const started = this.startedWith;
    if (started === null) return null;
    return addDecimal(started, `-${spent}`);
  }

  /**
   * Whether a run that has spent `spent` may start another step.
   *
   * REACHED, not exceeded, and the comparison is `<= 0` rather than `< 0`: an
   * allowance of exactly zero buys nothing further, so the run stops there
   * rather than starting a step it cannot pay for. That is the same boundary
   * `CapLedger.tripped` draws for `caps.budget` — "a budget of `1.00` with
   * `1.00` already spent buys nothing further" — and drawing it differently here
   * would mean two ceilings in one loop disagreeing about what a spent ceiling
   * is.
   *
   * A run with no account ceiling is never exhausted by this, which is what
   * makes an admin workspace unaffected: `null` is not a small number and there
   * is no comparison for it to lose.
   */
  exhausted(spent: string): boolean {
    const left = this.remaining(spent);
    return left !== null && compareDecimal(left, ZERO_CREDITS) <= 0;
  }
}

/**
 * The grammar `MONTHLY_CREDITS` produces: optionally signed, exact, no exponent.
 *
 * Signed, unlike `isDecimalString` from core, and that is the whole reason this
 * exists beside it. A remaining allowance is a DIFFERENCE and can legitimately
 * be negative; core's validator guards amounts that are charged, where a sign is
 * a bug. Using the stricter one here would reject exactly the overdrawn account
 * this file has to be able to stop.
 */
function isSignedDecimal(value: string): boolean {
  return value.startsWith('-') ? isDecimalString(value.slice(1)) : isDecimalString(value);
}
