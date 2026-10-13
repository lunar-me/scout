/**
 * The rate card's shape, and the one place a cost is computed.
 *
 * The card itself — which models, at what price — is the host's, injected as a
 * {@link RateCard}. This file only knows what a rate is and how a call is
 * priced against one.
 *
 * Two facts about the counters are baked into the arithmetic and are worth
 * naming, because getting either wrong inflates every invoice quietly:
 *
 * 1. **Cache reads and cache writes are separate line items**, not discounts
 *    applied later, each at its own transcribed rate. A provider's ratios
 *    differ by model and are transcribed rather than derived.
 * 2. **The three input counters must be disjoint by the time they reach
 *    {@link costOf}.** Some protocols report three disjoint counters (input,
 *    cache writes, cache reads, summed for the total). The chat-completions
 *    protocol reports `prompt_tokens` as the TOTAL with `cached_tokens` a
 *    subset of it, so `./chat-completions` subtracts before this file ever
 *    sees the numbers. This function cannot detect the difference: an
 *    overlapping `inputTokens` prices to a plausible number that is too high
 *    by the cached portion, which is the majority of an agent loop's input.
 *
 * And one that is baked into what is *absent*: **thinking tokens are already
 * inside the output count**. So {@link costOf} does not price
 * `reasoningTokens`. Pricing it would double-count every reasoning token, which
 * on a reasoning-heavy agent step is not a rounding error, and the resulting
 * number would look plausible. `TokenUsage` keeps the count for attribution,
 * not for billing.
 *
 * ── Why the arithmetic is exact ──────────────────────────────────────────────
 *
 * `multiplyDecimal` and integer bigints underneath. No cost is ever a float, at
 * any intermediate step. A token count is converted to millions by moving the
 * decimal point six places — string surgery on an integer, which is exact —
 * rather than by dividing by 1e6, which is not.
 */

import { ZERO_CREDITS, addDecimal, multiplyDecimal } from '@outcrawl/scout-core';

import { ModelConfigError, type TokenUsage } from './provider';

/** USD per million tokens, per line item, exactly as its source states it. */
export interface TokenRates {
  /** Uncached input. */
  readonly input: string;
  readonly output: string;
  /**
   * The cache-read (cache hit) line.
   *
   * `null` on the same terms as {@link cacheWrite}: the provider bills NO
   * cache-read line for this model, which is not the same as billing zero.
   * `costOf` refuses rather than pricing at zero if the wire ever reports
   * cache-read tokens for it.
   */
  readonly cacheRead: string | null;
  /**
   * The cache-write line, at the provider's default (five-minute) TTL.
   *
   * `null` means the provider bills NO cache-write line for this model — not
   * that it bills zero. A zero rate is indistinguishable from a decision that
   * the tokens are free, and it would silently become the answer the moment
   * somebody wired a dashboard to it. The distinction also lets a rate check
   * tell a provider that never priced the line from one that has STOPPED
   * reporting a price it used to have.
   */
  readonly cacheWrite: string | null;
  /**
   * What this model will ACCEPT, transcribed from the same source as the
   * prices.
   *
   * THIS FIELD EXISTS BECAUSE ITS ABSENCE SHIPPED A SILENT FAILURE. The one
   * fact "the hands model is text-only" was written down in PROSE beside its
   * entry, and prose is not reachable from code. So the default configuration
   * handed that id to the captcha vision role, which sent a PNG to a model
   * that has never accepted one, and the whole agentic captcha route answered
   * `404 No endpoints found that support image input` on every single
   * challenge on every default host. Nothing validated it because nothing
   * COULD.
   *
   * Narrower than the source on purpose: a model may accept `audio`, `file`
   * and `video` as well, and this package sends exactly two kinds of thing:
   * text, and a PNG screenshot. A modality nobody can send is a modality
   * nobody can validate, so it is not carried.
   */
  readonly inputModalities: readonly ('text' | 'image')[];
}

/**
 * The models a host may name, with their prices, keyed by the model id exactly
 * as the PROVIDER spells it: that string is what goes on the wire, into
 * `CostEntry.model` and into the action cache key, and a second spelling here
 * would silently miss.
 *
 * Deliberately not every model a provider sells: a rate that nobody has checked
 * against its source is worse than a missing one, because a missing one throws
 * {@link ratesIn} and a stale one bills.
 */
export type RateCard = Readonly<Record<string, TokenRates>>;

/**
 * The rate for a model on a card, or a hard failure.
 *
 * Throws rather than defaulting. An unpriced model that silently costs `'0'`
 * turns a cost centre into a blind spot, and the blind spot appears exactly when
 * someone switches model — the moment the number is most likely to be quoted.
 */
export function ratesIn(card: RateCard, model: string): TokenRates {
  const rates = card[model];
  if (rates === undefined) {
    throw new ModelConfigError(
      `no rate card entry for model ${JSON.stringify(model)}: add it to the rate card from the provider ` +
        'that bills it rather than billing it as free',
    );
  }
  return rates;
}

/**
 * An integer token count as an exact decimal number of millions.
 *
 * `1_234` -> `'0.001234'`. The decimal point is inserted by string surgery on
 * the integer's digits, so nothing is divided and nothing rounds. Named because
 * the six is a unit conversion (per-MTok rates) and not an arbitrary constant.
 */
export function tokensAsMillions(tokens: number): string {
  if (!Number.isInteger(tokens) || tokens < 0) {
    throw new TypeError(`token counts must be non-negative integers, got ${String(tokens)}`);
  }
  if (tokens === 0) {
    return ZERO_CREDITS;
  }
  const digits = String(tokens).padStart(7, '0');
  return `${digits.slice(0, digits.length - 6)}.${digits.slice(digits.length - 6)}`;
}

/** One priced line of a call. Kept per line so a cost can be explained. */
export interface CostBreakdown {
  readonly input: string;
  readonly output: string;
  readonly cacheRead: string;
  readonly cacheWrite: string;
  /** The sum. Exact decimal USD. */
  readonly total: string;
}

/**
 * An ESTIMATE of one call from the transcribed list price. **Never the first
 * choice for a bill.**
 *
 * Model usage is billed from the provider's own per-call figure
 * (`ModelResponse.costUsd`) (W44, 2026-09-25). The one billing path that
 * reaches this is the last resort in `ChatCompletionsProvider`: a completion
 * that stated no cost and whose generation record could not be read either,
 * billed at this figure and marked `costSource: 'estimate'` rather than failed.
 * It also serves non-billing estimates — the captcha router ordering solvers by
 * expected price, bench arms that talk to a gateway which states no cost.
 *
 * Price one call. Four line items summed, no rounding, no currency conversion.
 *
 * The result carries more decimal places than money has, on purpose: a single
 * agent step can cost $0.00004 and rounding each step to the cent would price a
 * thousand-step crawl at zero. Rounding belongs at the invoice, once.
 *
 * A `null` {@link TokenRates.cacheWrite} contributes nothing, and it refuses
 * rather than contributing nothing if the provider actually reported cache-write
 * tokens. That combination — no price on the card, a non-zero count from the
 * wire — means the provider started billing a line this card says does not
 * exist, and every cost quoted for that model from then on would be short by
 * it. Silently pricing it at zero is exactly the blind spot `ratesIn` throws to
 * avoid, one line item further in.
 */
export function costOf(usage: TokenUsage, rates: TokenRates): CostBreakdown {
  const input = multiplyDecimal(tokensAsMillions(usage.inputTokens), rates.input);
  const output = multiplyDecimal(tokensAsMillions(usage.outputTokens), rates.output);
  if (rates.cacheRead === null && usage.cacheReadTokens > 0) {
    throw new ModelConfigError(
      `the provider billed ${String(usage.cacheReadTokens)} cache-read tokens for a model whose ` +
        'rate card says it has no cache-read line. Transcribe its cache-read price into the rate ' +
        'card rather than pricing it as free',
    );
  }
  const cacheRead =
    rates.cacheRead === null
      ? ZERO_CREDITS
      : multiplyDecimal(tokensAsMillions(usage.cacheReadTokens), rates.cacheRead);
  if (rates.cacheWrite === null && usage.cacheWriteTokens > 0) {
    throw new ModelConfigError(
      `the provider billed ${String(usage.cacheWriteTokens)} cache-write tokens for a model whose ` +
        'rate card says it has no cache-write line. Transcribe its cache-write price into the rate ' +
        'card rather than pricing it as free',
    );
  }
  const cacheWrite =
    rates.cacheWrite === null
      ? ZERO_CREDITS
      : multiplyDecimal(tokensAsMillions(usage.cacheWriteTokens), rates.cacheWrite);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: addDecimal(addDecimal(input, output), addDecimal(cacheRead, cacheWrite)),
  };
}
