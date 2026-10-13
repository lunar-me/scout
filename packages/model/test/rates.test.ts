/**
 * The cost arithmetic, over a rate card the test builds.
 *
 * Costs are pinned to figures computed by hand from per-million prices, so a
 * change to the arithmetic shows up as a changed number rather than as a
 * plausible one. The production card's own content is checked with the host's
 * configuration.
 *
 * `multiplyDecimal` is exercised here too. It lives in `@outcrawl/core` beside
 * `addDecimal`, because money arithmetic belongs in one place, and this is its
 * first consumer.
 */

import { describe, expect, test } from 'bun:test';
import { addDecimal, compareDecimal, multiplyDecimal } from '@outcrawl/scout-core';

import { ModelConfigError, type TokenUsage } from '../src/provider';
import { costOf, ratesIn, tokensAsMillions, type RateCard } from '../src/rates';

/**
 * A frontier-priced brain, a mid-priced hands model, and one whose provider
 * bills no cache lines at all. USD per million tokens.
 */
const CARD: RateCard = {
  'brain-model': { input: '5', output: '25', cacheRead: '0.50', cacheWrite: '6.25', inputModalities: ['text', 'image'] },
  'hands-model': { input: '2', output: '10', cacheRead: '0.20', cacheWrite: '2.50', inputModalities: ['text', 'image'] },
  'extract-model': { input: '0.04', output: '0.15', cacheRead: null, cacheWrite: null, inputModalities: ['text'] },
};

function usage(partial: Partial<TokenUsage>): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...partial,
  };
}

describe('exact decimal multiplication', () => {
  test('is exact where the float is not', () => {
    expect(0.1 * 0.2).not.toBe(0.02);
    expect(multiplyDecimal('0.1', '0.2')).toBe('0.02');
    expect(multiplyDecimal('1.1', '1.1')).toBe('1.21');
  });

  test('keeps the sum of the scales, because that is where the product is exact', () => {
    expect(multiplyDecimal('0.001', '0.002')).toBe('0.000002');
    expect(multiplyDecimal('2', '3')).toBe('6');
    expect(multiplyDecimal('1.50', '2')).toBe('3.00');
  });

  test('survives magnitudes a double cannot represent', () => {
    // 2^53 + 1 doubled. A float would have lost the odd unit before the multiply.
    expect(multiplyDecimal('9007199254740993', '2')).toBe('18014398509481986');
  });

  test('refuses anything that is not a decimal string', () => {
    expect(() => multiplyDecimal('2', '')).toThrow(TypeError);
    expect(() => multiplyDecimal('1e6', '2')).toThrow(TypeError);
  });
});

describe('token counts as millions', () => {
  test('moves the decimal point rather than dividing', () => {
    expect(tokensAsMillions(0)).toBe('0');
    expect(tokensAsMillions(1)).toBe('0.000001');
    expect(tokensAsMillions(1234)).toBe('0.001234');
    expect(tokensAsMillions(1_000_000)).toBe('1.000000');
    expect(tokensAsMillions(2_500_000)).toBe('2.500000');
  });

  test('rejects a count that is not a count', () => {
    expect(() => tokensAsMillions(-1)).toThrow(TypeError);
    expect(() => tokensAsMillions(1.5)).toThrow(TypeError);
  });
});

describe('the rate card', () => {
  test('an unpriced model is a hard failure, never a free one', () => {
    expect(() => ratesIn(CARD, 'unlisted-model')).toThrow(ModelConfigError);
    expect(() => ratesIn(CARD, 'unlisted-model')).toThrow(/rate card/);
  });

  /**
   * MUTATION THIS CATCHES: a `null` cache line priced as zero when the wire
   * reports tokens on it, which would under-bill every call from the day the
   * provider started charging a line the card says does not exist.
   */
  test('a card with no cache line refuses cache tokens rather than pricing them free', () => {
    const rates = ratesIn(CARD, 'extract-model');
    expect(costOf(usage({ inputTokens: 1000, outputTokens: 100 }), rates).total).toBe('0.00005500');
    expect(() => costOf(usage({ cacheReadTokens: 1 }), rates)).toThrow(ModelConfigError);
    expect(() => costOf(usage({ cacheWriteTokens: 1 }), rates)).toThrow(ModelConfigError);
  });
});

describe('pricing a call', () => {
  test("prices a provider's documented example usage block, line by line", () => {
    // The usage block from a provider's API reference, priced at a frontier
    // model's published rates: $5 in, $25 out, $0.50 cache read, $6.25 cache
    // write, all per million tokens.
    //   input      2095 * 5    / 1e6 = 0.010475
    //   output      503 * 25   / 1e6 = 0.012575
    //   cacheRead  2051 * 0.50 / 1e6 = 0.00102550
    //   cacheWrite 2051 * 6.25 / 1e6 = 0.01281875
    const cost = costOf(
      usage({ inputTokens: 2095, outputTokens: 503, cacheReadTokens: 2051, cacheWriteTokens: 2051 }),
      ratesIn(CARD, 'brain-model'),
    );

    expect(cost.input).toBe('0.010475');
    expect(cost.output).toBe('0.012575');
    expect(cost.cacheRead).toBe('0.00102550');
    expect(cost.cacheWrite).toBe('0.01281875');
    expect(cost.total).toBe('0.03689425');
  });

  test('does not price reasoning tokens on top of output tokens', () => {
    // "Always <= `output_tokens`; `output_tokens - thinking_tokens` approximates
    // the non-reasoning output" — thinking tokens are a subset of the output
    // count, so charging them again would inflate every reasoning-heavy step by
    // most of its output cost.
    const rates = ratesIn(CARD, 'hands-model');
    const withThinking = costOf(usage({ outputTokens: 500, reasoningTokens: 400 }), rates);
    const withoutThinking = costOf(usage({ outputTokens: 500 }), rates);

    expect(withThinking.total).toBe(withoutThinking.total);
    expect(withThinking.total).toBe('0.005000');
  });

  test('a call with no tokens costs zero, at every line', () => {
    const cost = costOf(usage({}), ratesIn(CARD, 'brain-model'));
    expect(compareDecimal(cost.total, '0')).toBe(0);
  });

  test('accumulates exactly over a long run where a float would drift', () => {
    const rates = ratesIn(CARD, 'hands-model');
    let exact = '0';
    let drifting = 0;
    for (let step = 0; step < 1000; step += 1) {
      const cost = costOf(usage({ inputTokens: 700, outputTokens: 70 }), rates);
      // core's `addDecimal`, not a second implementation written here: two
      // implementations of money addition is how they disagree by a cent in a
      // reconciliation nobody can attribute.
      exact = addDecimal(exact, cost.total);
      drifting += Number(cost.total);
    }
    // 1000 steps at 700 * $2/MTok + 70 * $10/MTok = $0.0021 each.
    expect(exact).toBe('2.100000');
    expect(drifting).not.toBe(2.1);
  });
});
