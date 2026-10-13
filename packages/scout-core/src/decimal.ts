/**
 * Exact decimal arithmetic on strings.
 *
 * Money and meters are never floats. `BilledResources.credits` and
 * `UsageEventRow.quantity` are decimal strings precisely so a value cannot pass
 * through binary64 and come back a fraction of a cent different, and every
 * operation on them has to preserve that.
 *
 * One implementation for every place that needs it — the agent loop's budget
 * cap, a host's meter, and its billing — because two independent
 * implementations of money addition is how they disagree by a cent in a
 * reconciliation nobody can attribute: a wrong number that looks right.
 *
 * Everything here is bigint underneath. No `Number` appears in an arithmetic
 * path, only in the scale bookkeeping, where the values are small integers.
 */

/** Signed, arbitrary scale. Wider than a budget, because meters accumulate. */
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

export const ZERO_CREDITS = '0';

/** A decimal as exact integer units at a scale: `value === units / 10^scale`. */
export interface DecimalParts {
  readonly units: bigint;
  readonly scale: number;
}

export function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_PATTERN.test(value);
}

/** `value` as {@link DecimalParts}. Throws on anything {@link isDecimalString} rejects. */
export function decimalParts(value: string): DecimalParts {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new TypeError(`credits must be a decimal string, got ${JSON.stringify(value)}`);
  }
  const dot = value.indexOf('.');
  if (dot < 0) {
    return { units: BigInt(value), scale: 0 };
  }
  return {
    units: BigInt(value.slice(0, dot) + value.slice(dot + 1)),
    scale: value.length - dot - 1,
  };
}

/** {@link DecimalParts} back to its exact decimal string, at its own scale. */
export function decimalFromParts(decimal: DecimalParts): string {
  if (decimal.scale === 0) {
    return decimal.units.toString();
  }
  const negative = decimal.units < 0n;
  const digits = (negative ? -decimal.units : decimal.units).toString().padStart(decimal.scale + 1, '0');
  const whole = digits.slice(0, digits.length - decimal.scale);
  const fraction = digits.slice(digits.length - decimal.scale);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** Brings two decimals to a common scale so the comparison is exact. */
function align(a: DecimalParts, b: DecimalParts): { a: bigint; b: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  return {
    a: a.units * 10n ** BigInt(scale - a.scale),
    b: b.units * 10n ** BigInt(scale - b.scale),
    scale,
  };
}

/** Exact addition. The result keeps the wider of the two scales. */
export function addDecimal(a: string, b: string): string {
  const aligned = align(decimalParts(a), decimalParts(b));
  return decimalFromParts({ units: aligned.a + aligned.b, scale: aligned.scale });
}

/**
 * Exact multiplication. The result's scale is the **sum** of the two scales,
 * which is the only scale at which a product is exact: `0.001 * 0.002` is
 * `0.000002`, and any narrower result has rounded.
 *
 * No rounding is applied here on purpose. A rate card times a quantity is a
 * number three different consumers reconcile against — the meter, the token
 * cost of a model call, and a captcha rate card amortised per solve — and each
 * rounds at a different point for a different reason. Rounding here would make
 * that decision once, silently, in the wrong place.
 */
export function multiplyDecimal(a: string, b: string): string {
  const left = decimalParts(a);
  const right = decimalParts(b);
  return decimalFromParts({ units: left.units * right.units, scale: left.scale + right.scale });
}

/** -1, 0 or 1. `compareDecimal('0.30', '0.3') === 0`: scale is not value. */
export function compareDecimal(a: string, b: string): number {
  const aligned = align(decimalParts(a), decimalParts(b));
  if (aligned.a < aligned.b) {
    return -1;
  }
  return aligned.a > aligned.b ? 1 : 0;
}

/**
 * Decimal places a credit amount is carried to when a division does not
 * terminate.
 *
 * Six, and derived rather than picked: the finest-grained priced unit is one
 * byte of residential bandwidth, 2,000 credits per 10^9 bytes, which is exactly
 * `0.000002` credits and needs six places and no more.
 */
export const CREDIT_SCALE = 6;

/**
 * `numerator / denominator` for non-negative exact decimals: exact where the
 * quotient terminates within {@link CREDIT_SCALE} places, and rounded half-up
 * at {@link CREDIT_SCALE} where it does not.
 *
 * ONE division for every priced quantity. A host's rate card prices a usage
 * row with it, `CapLedger` prices the run it is enforcing a budget on with it,
 * and a host's model pricing converts provider dollars with it — callers that
 * must round identically, or the figure a run reports and the figure its rows
 * are charged come apart by a micro-credit per term. Model pricing is a ratio
 * the runtime has to evaluate too, and a second copy is the drift this file
 * exists to prevent.
 *
 * Exact when possible because the exact answer is the one a customer can
 * check: three pages cost `'3'`, not `'3.000000'`. Half-up rather than
 * truncation because truncation is a bias in one direction on every charge
 * that does not divide evenly.
 */
export function divideDecimal(numerator: string, denominator: string): string {
  const top = decimalParts(numerator);
  const bottom = decimalParts(denominator);
  if (top.units < 0n || bottom.units < 0n) {
    throw new RangeError(`divideDecimal takes non-negative decimals, got ${numerator} / ${denominator}`);
  }
  if (bottom.units === 0n) {
    throw new RangeError(`divideDecimal cannot divide ${numerator} by zero`);
  }
  // (topUnits / 10^topScale) / (bottomUnits / 10^bottomScale)
  const a = top.units * 10n ** BigInt(bottom.scale);
  const b = bottom.units * 10n ** BigInt(top.scale);
  for (let scale = 0; scale <= CREDIT_SCALE; scale += 1) {
    const shifted = a * 10n ** BigInt(scale);
    if (shifted % b === 0n) {
      return decimalFromParts({ units: shifted / b, scale });
    }
  }
  const shifted = a * 10n ** BigInt(CREDIT_SCALE);
  const whole = shifted / b;
  const remainder = shifted % b;
  return decimalFromParts({ units: remainder * 2n >= b ? whole + 1n : whole, scale: CREDIT_SCALE });
}

/** RFC 8259's number grammar, captured: sign, integer, fraction, exponent. */
const JSON_NUMBER_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * A JSON number's SOURCE TEXT as an exact decimal string, with no float in
 * between.
 *
 * Providers send money as JSON numbers, and JSON numbers may be written in
 * exponent form: a provider's `usage` block has been measured carrying
 * `2e-7` beside `0.00000245` in the same reply (2026-09-25, n=2). `JSON.parse` would turn either into a binary64,
 * which is exactly the conversion this file exists to keep money away from, so
 * the caller hands over the digits it read off the wire and this moves the
 * decimal point: `2e-7` is `'0.0000002'`, `1.5E+3` is `'1500'`.
 *
 * Throws on anything that is not a JSON number, rather than guessing — a cost
 * that cannot be read is a billing failure the caller must see.
 */
export function decimalFromJsonNumber(source: string): string {
  const match = JSON_NUMBER_PATTERN.exec(source);
  if (match === null) {
    throw new TypeError(`not a JSON number: ${JSON.stringify(source)}`);
  }
  const [, sign = '', whole = '0', fraction = '', exponentText] = match;
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) {
    throw new RangeError(`JSON number exponent out of range: ${source}`);
  }
  // digits x 10^(exponent - fraction.length), as units and a scale.
  const digits = BigInt(whole + fraction);
  const shift = exponent - fraction.length;
  const units = shift >= 0 ? digits * 10n ** BigInt(shift) : digits;
  const scale = shift >= 0 ? 0 : -shift;
  const exact = decimalFromParts({ units: sign === '-' ? -units : units, scale });
  return stripTrailingZeros(exact);
}

/** `'0.0000020'` -> `'0.000002'`, `'3.000'` -> `'3'`. Value-preserving. */
export function stripTrailingZeros(value: string): string {
  if (!value.includes('.')) {
    return value === '-0' ? '0' : value;
  }
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '-0' ? '0' : trimmed;
}

/** Milliseconds in the minute a per-minute rate (`creditsPerMinute`) is quoted per. */
export const MS_PER_MINUTE = '60000';

/**
 * Credits for `ms` milliseconds of browser time at `creditsPerMinute`.
 *
 * A per-MINUTE ratio, never a per-second rate: one credit a minute is
 * `0.01666…` a second, which does not terminate, so time is priced as the
 * exact `ms x rate / 60000` through {@link divideDecimal}. A host's rate card
 * prices `ms / 1000` seconds through the same division, which is what lets a
 * run's reported credits equal the row it is charged.
 */
export function browserTimeCredits(ms: number, creditsPerMinute: string): string {
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new RangeError(`browser time must be a non-negative integer of milliseconds, got ${String(ms)}`);
  }
  if (ms === 0) {
    return ZERO_CREDITS;
  }
  return divideDecimal(multiplyDecimal(String(ms), creditsPerMinute), MS_PER_MINUTE);
}
