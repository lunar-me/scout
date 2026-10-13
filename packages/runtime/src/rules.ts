/**
 * Rule enforcement: the gate that stops a dispatch reaching the page.
 *
 * `@outcrawl/scout-core`'s `rules.ts` turns a customer's sentence into a
 * {@link RuleGate}. This file is the other half — it EVALUATES one against the
 * action about to be dispatched, and answers with a refusal or with nothing.
 *
 * ── WHY THIS IS A GATE AND NOT A PROMPT LINE ─────────────────────────────────
 *
 * "Never spend over £200" sitting in a prompt is advice, and a model under
 * pressure weighs advice against everything else it was told. The rules a
 * customer cares most about are precisely the ones that must not be weighable:
 * a spend ceiling, a site restriction and a confirmation requirement on
 * something that cannot be undone. So those three are checked HERE, in code,
 * immediately before the dispatch, and a tripped gate refuses.
 *
 * The rest of a customer's rules are guidance and go in the prompt, where the
 * model can and sometimes will trade them away. `rules.get` tells the customer
 * which of their rules landed in which class, because a rule they believe is
 * enforced and which is only advice is the worst outcome available here.
 *
 * ── IT FAILS TOWARD BLOCKING, AND THE ASYMMETRY IS TOTAL ─────────────────────
 *
 * The same argument {@link classifyIrreversible} makes, one layer up. A false
 * block costs a step: the refusal is recorded as the step's error, the model
 * reads it on the very next prompt through `compactHistory`, and it can choose
 * a compliant action instead. A false pass costs a stranger's money, on their
 * card, against a rule we told them was enforced. So:
 *
 *   * a commit whose amount cannot be read at all is BLOCKED under a spend
 *     ceiling, and the refusal says the amount was unreadable rather than
 *     claiming the page was over the limit;
 *   * a total in a currency the ceiling is not stated in is BLOCKED, because
 *     there is no FX rate anywhere in this system and converting by guess is
 *     the one thing worse than refusing.
 *
 * ── KNOWN GAP, stated rather than papered over ───────────────────────────────
 *
 * The domain gate binds to `navigate` and `openTab`, which is every URL this
 * package sends a browser to *by name*. It does NOT catch a `click` on a link
 * that happens to navigate cross-host, because an `AxNode` carries `role`,
 * `name`, `value` and `xpath` and no href — the target URL of a link is not in
 * the tree the model was shown, so there is nothing to compare. A strict
 * allow-list therefore constrains where the agent GOES deliberately, not every
 * page a click can land it on. What still holds on the page it lands on is the
 * spend ceiling and the confirmation gate, which are the two that guard money.
 * Closing this properly needs an href on the snapshot and belongs there.
 */

import {
  compareDecimal,
  type CompiledRule,
  describeGate,
  readAmounts,
  type RuleAmount,
  type RuleGate,
  type RuleIrreversibleClass,
  type RuleSet,
} from '@outcrawl/scout-core';

import type { Action } from './actions';
import { describeAction } from './actions';
import type { IrreversibleKind, IrreversibleQuestion } from './resume';
import { classifyIrreversible } from './resume';
import type { AxTree } from './snapshot';
import { walk } from './snapshot';

/* ------------------------------------------------------------------ *
 * The refusal
 * ------------------------------------------------------------------ */

/**
 * The rule set of a run with no rules.
 *
 * One frozen array rather than a fresh `[]` per step. Every dispatch site
 * consults `req.rules ?? NO_RULES`, and a run of two hundred steps that
 * allocated an empty array per site would be paying for a feature it declined.
 */
export const NO_RULES: RuleSet = Object.freeze([]);

/** Why one rule refused one dispatch. Never a verdict without evidence. */
export interface RuleRefusal {
  /** The customer's own sentence, verbatim. This is what they can audit. */
  readonly rule: string;
  readonly gate: RuleGate;
  /**
   * WHAT WAS OBSERVED that made the gate trip: the amount read and where it
   * was read from, the host, or the label the irreversible classifier matched.
   * A refusal a human cannot audit is a refusal nobody will trust enough to
   * keep, which is the argument {@link IrreversibleMark.evidence} already
   * makes about marks.
   */
  readonly evidence: string;
}

/**
 * Thrown at the dispatch site, so the action never reaches the page.
 *
 * A throw and not a return, on the precedent the write-ahead irreversible mark
 * already sets in `loop.ts`: awaited before `perform`, uncaught, so a refusal
 * takes the dispatch down with it. The step is recorded FAILED with this
 * message, `compactHistory` shows the model on the next prompt, and
 * `AgentRunRequest.stepFailures` bounds a model that keeps trying the forbidden
 * thing. No new stop reason and no new state machine: a rule block is a step
 * the run is told about and can recover from, which is what makes it safe to
 * fail toward blocking.
 */
export class RuleBlockedError extends Error {
  readonly rule: string;
  readonly gate: RuleGate;
  readonly evidence: string;

  constructor(refusal: RuleRefusal) {
    super(
      `rule blocked this action: ${JSON.stringify(refusal.rule)} — ${refusal.evidence}. This rule is ENFORCED, not advice: ${describeGate(refusal.gate)}`,
    );
    this.name = 'RuleBlockedError';
    this.rule = refusal.rule;
    this.gate = refusal.gate;
    this.evidence = refusal.evidence;
  }
}

/* ------------------------------------------------------------------ *
 * Spend
 * ------------------------------------------------------------------ */

/**
 * Labels next to the number a commit is FOR.
 *
 * Deliberately not "any amount on the page". A shop lists twenty prices and a
 * click on one of them is not a commitment to any of them; what a checkout
 * commits is the total, and the total is labelled. Matching every amount would
 * make a £200 ceiling refuse to buy a £5 item from a page that also advertises
 * a £1,299 laptop, which is a gate nobody could use.
 */
const TOTAL_LABEL =
  /\b(total|subtotal|amount due|amount payable|amount to pay|amount|balance due|order total|grand total|you pay|to pay|charged|price)\b/i;

/** How far past a total's label to look for its number, in flattened tree order. */
const TOTAL_LOOKAHEAD = 4;

interface Attribution {
  readonly amount: RuleAmount;
  /** Where it was read. Goes into the refusal's evidence verbatim. */
  readonly source: string;
}

/**
 * Every amount this dispatch can be held to, with where each came from.
 *
 * Two sources, and both are about the action rather than about the page:
 *
 * 1. THE TARGET'S OWN LABEL. `Pay £249.99` and `Place order — £249.99` are the
 *    commonest checkout buttons on the web and they carry the number the click
 *    commits. This is the strongest signal available, because it is attached to
 *    the node the action lands on.
 * 2. A TOTAL-LABELLED AMOUNT ON THE PAGE. The AX tree renders a total as two
 *    adjacent nodes far more often than as one — `StaticText "Order total"`
 *    then `StaticText "£249.99"` — so a label with no number of its own looks
 *    ahead {@link TOTAL_LOOKAHEAD} nodes for one.
 */
function attributableAmounts(question: IrreversibleQuestion): readonly Attribution[] {
  const found: Attribution[] = [];

  const label = `${question.node?.name ?? ''} ${question.node?.value ?? ''}`.trim();
  if (label !== '') {
    for (const amount of readAmounts(label)) {
      found.push({ amount, source: `the label of the control being used (${label})` });
    }
  }

  const nodes = [...walk(question.tree)];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index] as (typeof nodes)[number];
    const text = `${node.name ?? ''} ${node.value ?? ''}`.trim();
    if (text === '' || !TOTAL_LABEL.test(text)) {
      continue;
    }
    const own = readAmounts(text);
    if (own.length > 0) {
      for (const amount of own) {
        found.push({ amount, source: `the page total (${text})` });
      }
      continue;
    }
    for (let ahead = index + 1; ahead <= index + TOTAL_LOOKAHEAD && ahead < nodes.length; ahead += 1) {
      const next = nodes[ahead] as (typeof nodes)[number];
      const beside = `${next.name ?? ''} ${next.value ?? ''}`.trim();
      const amounts = readAmounts(beside);
      if (amounts.length > 0) {
        for (const amount of amounts) {
          found.push({ amount, source: `the page total (${text} ${beside})` });
        }
        break;
      }
    }
  }

  return found;
}

/* ------------------------------------------------------------------ *
 * Irreversible classes
 * ------------------------------------------------------------------ */

/**
 * The classifier's verdict, mapped to the class a customer can name.
 *
 * Exhaustive over `IrreversibleKind` on purpose: a sixth kind added to
 * `resume.ts` is a compile error here until somebody says whether a customer
 * can forbid it by name. `suspected` maps to `null` because it is not a class
 * anybody asks for — it is what the structural rules produce when the page says
 * a dispatch is consequential and no label matched. See
 * {@link blockedIrreversible} for how it is treated.
 */
const CUSTOMER_CLASS: Readonly<Record<IrreversibleKind, RuleIrreversibleClass | null>> =
  Object.freeze({
    payment: 'payment',
    order: 'order',
    message: 'message',
    account: 'account',
    handoff: 'handoff',
    suspected: null,
  });

/**
 * Whether a gate over these classes covers this verdict.
 *
 * `suspected` is covered when the gate names `payment` or `order`, and only
 * then. Every structural rule that produces `suspected` is a MONEY signal — a
 * card or credential field on the page, a checkout/billing/confirm URL, a
 * heading naming a purchase — so a customer who forbade unconfirmed payments or
 * orders has forbidden exactly the thing those signals indicate. A customer who
 * only forbade unconfirmed MESSAGES has not, and reading their rule as covering
 * an unlabelled checkout button would be us inventing a restriction they did
 * not write.
 */
function blockedIrreversible(
  kind: IrreversibleKind,
  classes: readonly RuleIrreversibleClass[],
): boolean {
  const named = CUSTOMER_CLASS[kind];
  return named === null
    ? classes.includes('payment') || classes.includes('order')
    : classes.includes(named);
}

/* ------------------------------------------------------------------ *
 * Domain
 * ------------------------------------------------------------------ */

/** The URL an action sends a browser to by name, or `undefined`. */
function navigationTarget(action: Action): string | undefined {
  return action.type === 'navigate' || action.type === 'openTab' ? action.url : undefined;
}

/** A host matches a rule's host and every subdomain of it. Never a substring. */
function hostCovered(host: string, patterns: readonly string[]): string | undefined {
  return patterns.find((pattern) => host === pattern || host.endsWith(`.${pattern}`));
}

/**
 * The domain gate, which needs a URL and NOT a page.
 *
 * Its own function because there is one dispatch site with a URL and no tree:
 * a fan `openTab`, which opens a page that does not exist yet. Every other gate
 * needs the tree the action was validated against, and this one must not be
 * skipped just because that site has none — a run whose rules forbid a host
 * must not be able to reach it by opening it in another tab.
 */
function checkDomain(
  gate: Extract<RuleGate, { kind: 'domain' }>,
  action: Action,
): string | undefined {
  const target =
    action.type === 'navigate' || action.type === 'openTab' ? action.url : undefined;
  if (target === undefined) {
    return undefined;
  }
  let host: string;
  try {
    host = new URL(target).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    // Unreachable through the loop: `validateAction`'s `navigableUrl` has
    // already refused anything `new URL` cannot parse. Refused rather than
    // waved through, because a host we cannot read is a host we cannot check
    // against an allow-list.
    return `the target ${JSON.stringify(target)} has no readable host, so it cannot be checked against this rule`;
  }
  const matched = hostCovered(host, gate.hosts);
  if (gate.mode === 'deny') {
    return matched === undefined ? undefined : `${host} is covered by the denied host ${matched}`;
  }
  return matched === undefined
    ? `${host} is not one of the allowed hosts (${gate.hosts.join(', ')})`
    : undefined;
}

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

function checkGate(
  gate: RuleGate,
  question: IrreversibleQuestion,
  commits: () => { readonly kind: IrreversibleKind; readonly evidence: string } | undefined,
): string | undefined {
  switch (gate.kind) {
    case 'domain':
      return checkDomain(gate, question.action);

    case 'confirm_irreversible': {
      const verdict = commits();
      if (verdict === undefined || !blockedIrreversible(verdict.kind, gate.classes)) {
        return undefined;
      }
      return `this dispatch is an irreversible ${verdict.kind} action and nobody has confirmed it — ${verdict.evidence}`;
    }

    case 'spend_ceiling': {
      const verdict = commits();
      // Only a dispatch that can COMMIT is gated on money, and only the money
      // classes of it: a `message` or `handoff` commit spends nothing, so
      // holding it against a spend ceiling would refuse work the rule permits.
      if (
        verdict === undefined ||
        (verdict.kind !== 'payment' && verdict.kind !== 'order' && verdict.kind !== 'suspected')
      ) {
        return undefined;
      }
      const attributions = attributableAmounts(question);
      const sameCurrency = attributions.filter(
        (entry) => entry.amount.currency === gate.currency,
      );
      if (sameCurrency.length > 0) {
        const worst = sameCurrency.reduce((highest, entry) =>
          compareDecimal(entry.amount.amount, highest.amount.amount) > 0 ? entry : highest,
        );
        if (compareDecimal(worst.amount.amount, gate.amount) > 0) {
          return `this dispatch would commit ${gate.currency} ${worst.amount.amount}, read from ${worst.source}, against your ceiling of ${gate.currency} ${gate.amount}`;
        }
        return undefined;
      }
      if (attributions.length > 0) {
        const other = attributions[0] as Attribution;
        return `this page commits ${other.amount.currency} ${other.amount.amount} (${other.source}) and your ceiling is in ${gate.currency}. Nothing in this product converts between currencies, so the ceiling cannot be checked and the dispatch is refused rather than guessed at — set a ${other.amount.currency} rule if you meant to allow this`;
      }
      return `no amount could be read from the control or from a total on this page, so this dispatch cannot be checked against your ceiling of ${gate.currency} ${gate.amount} — ${verdict.evidence}`;
    }
  }
}

/**
 * The first rule that refuses this dispatch, or `undefined`.
 *
 * Rules are evaluated in the order the customer wrote them and the first
 * refusal wins, so a run that trips two rules at once reports the same one
 * every time and a replay is reproducible — the ordering discipline
 * `CapLedger.tripped` already follows for the same reason.
 *
 * `classifyIrreversible` is called at most once per dispatch, lazily, and
 * shared between the gates that need it. Two of the three classes are defined
 * in terms of "a dispatch that can commit", and that question has exactly one
 * answer in this codebase: a second copy of those rules is how two classifiers
 * come to disagree about whether a click is a payment.
 */
export function checkRules(
  rules: RuleSet,
  question: IrreversibleQuestion,
): RuleRefusal | undefined {
  let verdict: { readonly kind: IrreversibleKind; readonly evidence: string } | undefined;
  let asked = false;
  const commits = (): { readonly kind: IrreversibleKind; readonly evidence: string } | undefined => {
    if (!asked) {
      verdict = classifyIrreversible(question);
      asked = true;
    }
    return verdict;
  };

  for (const rule of rules) {
    if (rule.gate === null) {
      continue;
    }
    const evidence = checkGate(rule.gate, question, commits);
    if (evidence !== undefined) {
      return { rule: rule.text, gate: rule.gate, evidence };
    }
  }
  return undefined;
}

/**
 * The first rule that refuses this NAVIGATION, or `undefined`.
 *
 * Only the domain gates are consulted, because only they are answerable
 * without a page. The one caller is the fan's `openTab` element, which opens a
 * tab that does not exist yet and therefore has no tree to classify against —
 * and which must still not be able to reach a host the customer forbade. Every
 * other dispatch site has a tree and calls {@link checkRules}, which subsumes
 * this.
 */
export function checkNavigationRules(rules: RuleSet, action: Action): RuleRefusal | undefined {
  for (const rule of rules) {
    if (rule.gate === null || rule.gate.kind !== 'domain') {
      continue;
    }
    const evidence = checkDomain(rule.gate, action);
    if (evidence !== undefined) {
      return { rule: rule.text, gate: rule.gate, evidence };
    }
  }
  return undefined;
}

/**
 * The same check, as the throw the dispatch sites want.
 *
 * Three sites call this — the step's head action, each element of a motor
 * program, and each element of a tab fan — and every one of them is a place
 * where the tree the action was validated against and the run's own history
 * are both in hand. That is why the check is here and not inside
 * `PageSession.perform`: `perform` receives an `Action` and nothing else, and a
 * gate that has to guess at the page is not a gate. It is the same reason
 * `AgentRunRequest.onIrreversible` is awaited at the dispatch site rather than
 * at the page boundary.
 */
export function enforceRules(rules: RuleSet, question: IrreversibleQuestion): void {
  const refusal = checkRules(rules, question);
  if (refusal !== undefined) {
    throw new RuleBlockedError(refusal);
  }
}

/* ------------------------------------------------------------------ *
 * The prompt half
 * ------------------------------------------------------------------ */

/**
 * The rules, as the model is told about them.
 *
 * BOTH classes are rendered, and the enforced ones say they are enforced. That
 * is not decoration: a model that knows a ceiling will refuse it does not spend
 * a step discovering the refusal, and a model that knows the rest is guidance is
 * being told the truth about what it is weighing. Empty for an empty rule set,
 * so a run with no rules pays no prompt tokens and `renderPrompt` returns a
 * byte-identical string to the one it returned before this existed.
 */
export function renderRules(rules: RuleSet): string {
  if (rules.length === 0) {
    return '';
  }
  const enforced = rules.filter((rule): rule is CompiledRule & { gate: RuleGate } => rule.gate !== null);
  const guidance = rules.filter((rule) => rule.gate === null);
  const lines: string[] = ['The customer set these rules for this run.'];
  if (enforced.length > 0) {
    lines.push(
      'ENFORCED — these are checked in code before every action and a matching action is REFUSED, whatever you decide:',
    );
    for (const rule of enforced) {
      lines.push(`  - ${rule.text} [${describeGate(rule.gate)}]`);
    }
  }
  if (guidance.length > 0) {
    lines.push('GUIDANCE — follow these; nothing enforces them but the customer asked:');
    for (const rule of guidance) {
      lines.push(`  - ${rule.text}`);
    }
  }
  return lines.join('\n');
}
