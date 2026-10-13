/**
 * Purchase money as the agent sees it: the spend cap, the purchase record, the
 * purchase actions a model emits and the ports a host binds for them (wire
 * contract §3, §4 approval, §7).
 *
 * MONEY IS NEVER A `Number`. On the wire it is an exact decimal string plus an
 * ISO 4217 currency. Minor-unit conversion, merchant matching and the
 * card-reveal gate are the host's.
 */

import type { CardBrand } from './secrets';
import type { RunSecretAskWant } from './types';

const CURRENCY_PATTERN = /^[A-Z]{3}$/u;

export function isCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_PATTERN.test(value);
}

/** Luhn checksum over a string of ASCII digits. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/**
 * True when `text` carries a Luhn-valid 13-19 digit number, written solid or
 * in groups split by single spaces or dashes (`4242 4242 4242 4242`,
 * `3782-822463-10005`).
 *
 * A candidate is a run of adjacent groups. Every group but the last has at
 * least four digits and the last at least three, which is every printed PAN
 * layout and none of the date or phone layouts (`2026-10-08 2026-10-15` is
 * sixteen digits that are a date twice, and a tenth of such pairs are
 * Luhn-valid). A single group longer than 19 digits is an identifier, not a
 * card, and is not searched inside. Linear in the text: at most 19 groups
 * are joined from any start.
 *
 * Answers a boolean and nothing else, on purpose: the caller's refusal must
 * never be able to echo the digits it found.
 */
export function containsCardNumber(text: string): boolean {
  const runs = text.match(/\d+(?:[ -]\d+)*/gu);
  if (runs === null) return false;
  for (const run of runs) {
    const groups = run.split(/[ -]/u);
    for (let start = 0; start < groups.length; start += 1) {
      let digits = '';
      for (let end = start; end < groups.length; end += 1) {
        const group = groups[end] as string;
        if (end > start && (groups[end - 1] as string).length < 4) break;
        digits += group;
        if (digits.length > 19) break;
        if (digits.length >= 13 && group.length >= 3 && digits[0] !== '0' && luhnValid(digits)) return true;
      }
    }
  }
  return false;
}

/** `caps.spend` as submitted. Exact decimal strings. */
export interface SpendCapRequest {
  readonly limit: string;
  readonly currency: string;
  readonly perPurchase?: string;
}

export const PURCHASE_STATUSES = ['reserved', 'completed', 'declined', 'abandoned', 'unknown'] as const;

export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

export function isPurchaseStatus(value: unknown): value is PurchaseStatus {
  return typeof value === 'string' && (PURCHASE_STATUSES as readonly string[]).includes(value);
}

/** What `purchase.end` may settle to: every status but the open one. */
export const PURCHASE_OUTCOMES = ['completed', 'declined', 'abandoned', 'unknown'] as const;

export type PurchaseOutcome = (typeof PURCHASE_OUTCOMES)[number];

export function isPurchaseOutcome(value: unknown): value is PurchaseOutcome {
  return typeof value === 'string' && (PURCHASE_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Where the card a purchase was paid with came from (wallet providers wire
 * §6): a stored card, a run's temporary card (one added by an ask included),
 * or a card minted from a connected card provider.
 */
export const PURCHASE_CARD_SOURCES = ['stored', 'run', 'provider'] as const;

export type PurchaseCardSource = (typeof PURCHASE_CARD_SOURCES)[number];

/**
 * The card a purchase was paid with, by name and network only: never a digit
 * beyond `last4`, never an expiry or a security code. Every field is null
 * until a card is attributed to the purchase: at begin for a run's
 * `wallet.card`, otherwise at the first reveal of a card into it.
 */
export interface PurchaseCard {
  readonly source: PurchaseCardSource | null;
  /** A stored secret's handle, a run secret's name, or a connection's handle. */
  readonly handle: string | null;
  /** The card provider's id, as the host names its providers. Only for source `provider`. */
  readonly provider: string | null;
  /**
   * The network: a stored card's row, a run card's number prefix (read in
   * the machine's memory), or the provider's own answer.
   */
  readonly brand: CardBrand | null;
  readonly last4: string | null;
  /** The provider's own card id: an identifier, not a credential. Only for source `provider`. */
  readonly providerCardId: string | null;
}

/** A purchase record as every route returns it. Never a card digit beyond `last4`. */
export interface Purchase {
  readonly id: string;
  readonly runId: string;
  readonly merchant: string;
  readonly amount: string;
  readonly currency: string;
  readonly card: PurchaseCard;
  readonly status: PurchaseStatus;
  readonly orderRef: string | null;
  readonly createdAt: string;
  readonly settledAt: string | null;
}

/** The `approval` question a paused run carries (contract §4). */
export interface ApprovalQuestion {
  readonly kind: 'approval';
  readonly purchase: string;
  readonly merchant: string;
  readonly amount: string;
  readonly currency: string;
}

/** Why `purchase.begin` (and therefore a card reveal) was refused. */
export const SPEND_REFUSAL_CODES = [
  'merchant_not_allowed',
  'spend_cap_exceeded',
  'per_purchase_exceeded',
  'no_open_purchase',
] as const;

export type SpendRefusalCode = (typeof SPEND_REFUSAL_CODES)[number];

/**
 * Every refusal a purchase step can answer with: the spend-control refusals,
 * and a person declining (or never answering) an approval.
 */
export type SpendStepRefusalCode =
  | 'merchant_not_allowed'
  | 'spend_cap_exceeded'
  | 'per_purchase_exceeded'
  | 'no_open_purchase'
  | 'approval_denied'
  | 'approval_timed_out';

/**
 * `purchase.begin` as a model emits it, its two fields left to fill. Every
 * sentence that sends a model to open a purchase names this whole: told only
 * "Open one with purchase.begin", the brain model emitted it as a `callTool`
 * and failed on a tool that "is not connected" (production, 2026-10-08).
 */
export const PURCHASE_BEGIN_ACTION = '{"type":"purchase.begin","amount":"<checkout total>","currency":"<code>"}';

/** `purchase.end` likewise, in the shared schema's field names (`PurchaseEndAction` in `@outcrawl/runtime`). */
export const PURCHASE_END_ACTION =
  '{"type":"purchase.end","value":"<completed|declined|abandoned|unknown>","amount":"<final total>","text":"<order reference>"}';

/** Said after either action wherever a model might take it for a tool. */
export const ACTION_NOT_A_TOOL = 'an action of its own, not a tool, so never send it through callTool';

/** One sentence per refusal, naming what to do. Never a digit of a card. */
export const SPEND_REFUSAL_MESSAGES: Readonly<Record<SpendRefusalCode, string>> = Object.freeze({
  merchant_not_allowed:
    "This site is not on the run's merchant allow-list, so no purchase can be made here. Add its registrable domain to `merchants` when you start the run.",
  spend_cap_exceeded:
    "This purchase would take the run past its spend cap. Raise `caps.spend.limit` for the run, or buy less.",
  per_purchase_exceeded:
    "This purchase is larger than the run's per-purchase ceiling. Raise `caps.spend.perPurchase`, or split the order.",
  no_open_purchase: `A card is revealed only inside an open purchase on the site it was opened for. Open one first, on the checkout page, with the action ${PURCHASE_BEGIN_ACTION}: ${ACTION_NOT_A_TOOL}.`,
});

/**
 * What `purchase.begin` answers: opened (or the step's replay), a question for
 * a person, a refusal, or a stop.
 *
 * - `opened.cardAsk`: the run pays with a card provider's card and the
 *   provider could not make or read one (down, out of cards, over a limit).
 *   The purchase is open; the run asks its person for a card with this
 *   sentence, which names the provider and why (§5 Failures).
 * - `stopped`: the provider rejected the connection's credential. The
 *   purchase is abandoned, and the run ends `failed` with `stopReason` and
 *   `message` as its error.
 */
export type PurchaseBeginAnswer =
  | { readonly kind: 'opened'; readonly purchase: Purchase; readonly replay: boolean; readonly cardAsk?: string }
  | { readonly kind: 'approval_required'; readonly question: ApprovalQuestion }
  | { readonly kind: 'refused'; readonly code: SpendStepRefusalCode; readonly message: string }
  | { readonly kind: 'stopped'; readonly stopReason: 'wallet-provider-revoked'; readonly message: string };

/** What `purchase.end` answers: the settled purchase (or the step's replay), or nothing open to settle. */
export type PurchaseEndAnswer =
  | { readonly kind: 'settled'; readonly purchase: Purchase; readonly replay: boolean }
  | { readonly kind: 'refused'; readonly code: 'no_open_purchase'; readonly message: string };

/**
 * The runtime's purchases port: one run's `purchase.begin` / `purchase.end`,
 * with the run and account closed over by whoever binds it. `step` with the
 * run is the idempotency key. `topLevelOrigin` is `scheme://host` of the tab's
 * top-level document, read from the page and never from the model: the edge
 * derives the merchant from it.
 */
export interface RunPurchases {
  begin(input: {
    readonly step: number;
    readonly amount: string;
    readonly currency: string;
    readonly topLevelOrigin: string;
    /** The approval this step asked for went unanswered for the whole ask timeout. */
    readonly approvalExpired?: boolean;
  }): Promise<PurchaseBeginAnswer>;
  end(input: {
    readonly step: number;
    readonly outcome: PurchaseOutcome;
    readonly amountFinal?: string;
    readonly orderRef?: string;
  }): Promise<PurchaseEndAnswer>;
}

/**
 * What a run's `ask` for a whole card or billing profile delivered: the run
 * secret name it arrived under, and the placeholder fields that binding
 * actually holds (`number`, `exp`, `cvc`, ...; `email`, `billing.line1`, ...).
 * Never a value.
 */
export interface RunSecretArrival {
  readonly for: string;
  readonly fields: readonly string[];
}

/**
 * The runtime's port for asking a PERSON for a card or a billing profile
 * mid-run (wire contract §4, `want: "card" | "details"`). Bound by the host
 * only for a run with `caps.spend` and a channel to a person; absent, the
 * loop never offers the ask.
 */
export interface RunSecretAsks {
  /**
   * Whether the run holds a whole card (or details) now: run-scoped, a
   * granted stored item of that kind, or a card provider connection whose
   * card has not failed this run.
   */
  holds(want: RunSecretAskWant): boolean;
  /**
   * Park the run on a `secret` question for `want`, naming `purchase` when
   * one is open, until a run secret of that kind arrives under the name the
   * host chose. `undefined` when none arrived by the ask timeout, or the run
   * was cancelled or ended while waiting. `text` replaces the question's
   * sentence: a card provider that could not make the run's card names
   * itself and why (`PurchaseBeginAnswer` `opened.cardAsk`).
   */
  ask(
    want: RunSecretAskWant,
    purchase: Pick<Purchase, 'id' | 'merchant' | 'amount' | 'currency'> | undefined,
    text?: string,
  ): Promise<RunSecretArrival | undefined>;
}
