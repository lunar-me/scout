/**
 * The ledger.
 *
 * The property worth testing hardest is the one that is easy to get wrong and
 * impossible to notice: detail is bounded, and the totals stay exact after the
 * detail has been dropped. A ledger that recomputed its totals from a trimmed
 * entry list would under-report spend silently, and only on the long runs.
 */

import { describe, expect, test } from 'bun:test';
import type { WallClock } from '@outcrawl/scout-core';

import { CostLedger, type CostEntry } from '../src/ledger';
import { ZERO_TOKENS, type TokenUsage } from '../src/provider';

class SteppingWallClock implements WallClock {
  #epochMs = Date.parse('2026-09-02T10:00:00.000Z');

  now(): number {
    this.#epochMs += 1000;
    return this.#epochMs;
  }
}

function entry(overrides: Partial<Omit<CostEntry, 'at'>> = {}): Omit<CostEntry, 'at'> {
  const usage: TokenUsage = { ...ZERO_TOKENS, inputTokens: 100, outputTokens: 10 };
  return {
    sessionId: 'sess-1',
    accountId: 'acct-1',
    provider: 'fake',
    model: 'hands-model',
    purpose: 'action',
    outcome: 'ok',
    usage,
    costUsd: '0.000300',
    costSource: 'provider',
    elapsedMs: 120,
    ...overrides,
  };
}

describe('recording', () => {
  test('mints the timestamp itself, so entries are orderable', () => {
    const ledger = new CostLedger({ wallClock: new SteppingWallClock() });

    const first = ledger.record(entry());
    const second = ledger.record(entry());

    expect(first.at).toBe('2026-09-02T10:00:01.000Z');
    expect(second.at).toBe('2026-09-02T10:00:02.000Z');
  });

  test('counts a cache hit as a free call rather than as no call', () => {
    const ledger = new CostLedger();

    ledger.record(entry({ outcome: 'hit', usage: ZERO_TOKENS, costUsd: '0' }));

    // An absent entry would be indistinguishable from a call that never happened
    // for some other reason, and the hit rate is the number that says whether the
    // action cache is earning its keep.
    expect(ledger.totals()).toMatchObject({ calls: 1, hits: 1, billed: 0, costUsd: '0' });
  });

  test('counts a billed failure as billed, and a timeout as not', () => {
    const ledger = new CostLedger();

    ledger.record(entry({ outcome: 'unusable', costUsd: '0.000900' }));
    ledger.record(entry({ outcome: 'schema', costUsd: '0.000100' }));
    ledger.record(entry({ outcome: 'timeout', usage: ZERO_TOKENS, costUsd: '0' }));

    expect(ledger.totals().billed).toBe(2);
    expect(ledger.totals().calls).toBe(3);
    expect(ledger.totals().costUsd).toBe('0.001000');
  });

  test('sums token counters across every call', () => {
    const ledger = new CostLedger();

    ledger.record(entry());
    ledger.record(
      entry({ usage: { ...ZERO_TOKENS, inputTokens: 400, cacheReadTokens: 50, reasoningTokens: 5 } }),
    );

    expect(ledger.totals().usage).toEqual({
      inputTokens: 500,
      outputTokens: 10,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
      reasoningTokens: 5,
    });
  });
});

describe('attribution', () => {
  test('keeps a per-session total that sums to the whole', () => {
    const ledger = new CostLedger();

    ledger.record(entry({ sessionId: 'a', costUsd: '0.002000' }));
    ledger.record(entry({ sessionId: 'b', costUsd: '0.000500' }));
    ledger.record(entry({ sessionId: 'a', costUsd: '0.000500' }));

    expect(ledger.totalsFor('a').costUsd).toBe('0.002500');
    expect(ledger.totalsFor('b').costUsd).toBe('0.000500');
    expect(ledger.totals().costUsd).toBe('0.003000');
    expect(ledger.sessions()).toEqual(['a', 'b']);
  });

  test('answers zero for a session nobody has recorded', () => {
    const ledger = new CostLedger();
    expect(ledger.totalsFor('never-seen')).toEqual({
      calls: 0,
      hits: 0,
      billed: 0,
      usage: ZERO_TOKENS,
      costUsd: '0',
      estimatedUsd: '0',
      subscriptionCalls: 0,
    });
  });
});

describe('bounded detail', () => {
  test('drops old entries while the totals stay exact', () => {
    const ledger = new CostLedger({ maxEntries: 10 });

    for (let call = 0; call < 1500; call += 1) {
      ledger.record(entry({ costUsd: '0.000300' }));
    }

    expect(ledger.entries()).toHaveLength(10);
    expect(ledger.totals().calls).toBe(1500);
    // 1500 * 0.0003. Accumulated on the way in, so trimming the log cannot move
    // it — which is the whole reason the totals are not derived from `entries`.
    expect(ledger.totals().costUsd).toBe('0.450000');
    expect(ledger.totals().usage.inputTokens).toBe(150_000);
  });

  test('keeps the most recent entries, which are the ones being investigated', () => {
    const ledger = new CostLedger({ maxEntries: 2 });

    ledger.record(entry({ model: 'first' }));
    ledger.record(entry({ model: 'second' }));
    ledger.record(entry({ model: 'third' }));

    expect(ledger.entries().map((row) => row.model)).toEqual(['second', 'third']);
  });
});

describe('describe', () => {
  test('is one line per session, with the cost at full precision', () => {
    const ledger = new CostLedger();
    ledger.record(entry({ sessionId: 'a', costUsd: '0.000040' }));
    ledger.record(entry({ sessionId: 'a', outcome: 'hit', usage: ZERO_TOKENS, costUsd: '0' }));

    const lines = ledger.describe().split('\n');

    expect(lines).toHaveLength(1);
    // Not rounded to the cent: an agent step can cost $0.00004 and a line that
    // rounded would read `$0.00` for the whole run.
    expect(lines[0]).toBe('a calls=2 hits=1 billed=1 in=100 cached=0 out=10 cost=$0.000040');
  });
});
