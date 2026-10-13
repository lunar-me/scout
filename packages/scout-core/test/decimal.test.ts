import { describe, expect, test } from 'bun:test';

import { decimalFromJsonNumber } from '../src/decimal';

describe('decimalFromJsonNumber', () => {
  test('a provider cost of 2e-7 is exactly 0.0000002', () => {
    // `usage.cost` arrives as JSON number text; `2e-7` through a float would
    // be 1.9999999999999999e-7.
    expect(decimalFromJsonNumber('2e-7')).toBe('0.0000002');
  });

  test('reads every JSON number spelling without a float', () => {
    expect(decimalFromJsonNumber('0.00000245')).toBe('0.00000245');
    expect(decimalFromJsonNumber('1.5E+3')).toBe('1500');
    expect(decimalFromJsonNumber('0')).toBe('0');
    expect(decimalFromJsonNumber('12.3400')).toBe('12.34');
  });

  test('refuses text that is not a JSON number rather than guessing', () => {
    for (const bad of ['', '.5', '1.', 'NaN', '0x10', '"0.1"']) {
      expect(() => decimalFromJsonNumber(bad)).toThrow();
    }
  });
});
