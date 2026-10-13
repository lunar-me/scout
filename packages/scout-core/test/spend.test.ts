import { describe, expect, test } from 'bun:test';

import { containsCardNumber } from '../src/spend';

/** Standard test PANs: Visa, Mastercard, Amex, Discover, a 19-digit Visa. */
const PANS = ['4242424242424242', '5555555555554444', '378282246310005', '6011111111111117', '4000000000000000006'];

describe('containsCardNumber', () => {
  test('finds a Luhn-valid PAN solid, grouped by spaces or dashes, and inside a sentence', () => {
    for (const pan of PANS) {
      expect(containsCardNumber(pan)).toBe(true);
      expect(containsCardNumber(`pay with ${pan.replace(/(\d{4})(?=\d)/gu, '$1 ')} please`)).toBe(true);
      expect(containsCardNumber(`card:${pan.replace(/(\d{4})(?=\d)/gu, '$1-')}.`)).toBe(true);
    }
    expect(containsCardNumber('Amex 3782-822463-10005 exp 12/28')).toBe(true);
    expect(containsCardNumber('order 12345 then 4242 4242 4242 4242')).toBe(true);
  });

  test('ignores Luhn failures, short numbers, dates, phones and long identifiers', () => {
    expect(containsCardNumber('4242424242424241')).toBe(false);
    expect(containsCardNumber('call +44 7700 900123 or 0800 123 4567')).toBe(false);
    // Sixteen digits that are two dates, Luhn-valid as a run, and not a card.
    const dates = '2026-10-08 2026-10-18';
    expect(containsCardNumber(dates.replace(/\D/gu, ''))).toBe(true);
    expect(containsCardNumber(dates)).toBe(false);
    expect(containsCardNumber('trace 4242424242424242424242424242')).toBe(false);
    expect(containsCardNumber('budget 250.00 USD, order #1234567')).toBe(false);
  });
});
