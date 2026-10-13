import { describe, expect, test } from 'bun:test';

import {
  MAX_RULES,
  MAX_RULE_LENGTH,
  compileRule,
  compileRules,
  readAmounts,
  rulesView,
  validateRules,
} from '../src/rules';
import type { RuleGate } from '../src/rules';

/** The gate a rule compiled to, or the warning that says why it did not. */
function gateOf(text: string): RuleGate | string | null {
  const rule = compileRule(text);
  return rule.gate ?? rule.unenforceable;
}

describe('a spend ceiling is extracted from the phrasings people write', () => {
  test.each([
    ['Never spend over £200', 'GBP', '200.00'],
    ["Don't spend more than £200", 'GBP', '200.00'],
    ['Do not spend above $50', 'USD', '50.00'],
    ['spend limit of 200 GBP', 'GBP', '200.00'],
    ['Never pay more than €100', 'EUR', '100.00'],
    ['max spend £20', 'GBP', '20.00'],
    ['budget of £200', 'GBP', '200.00'],
    ['keep purchases under $500', 'USD', '500.00'],
    ['no purchase over £1,299.99', 'GBP', '1299.99'],
  ] as const)('%s becomes a ceiling of %s %s', (text, currency, amount) => {
    expect(gateOf(text)).toEqual({ kind: 'spend_ceiling', currency, amount });
  });

  test('an amount with no currency is guidance WITH A WARNING, never a silent gate', () => {
    // The single likeliest way a customer believes they have a ceiling and does
    // not. A number with no unit cannot be compared against a page total, so
    // binding it would be the exact defect this file exists to prevent.
    const rule = compileRule('never spend over 200');
    expect(rule.class).toBe('guidance');
    expect(rule.gate).toBeNull();
    expect(rule.unenforceable).toContain('no currency');
  });

  test('a floor is not a ceiling and says so', () => {
    expect(compileRule('spend at least £200').unenforceable).toContain('MINIMUM');
  });

  test('two different amounts in one rule is one gate too many', () => {
    expect(compileRule('spend under £200 but never under £50').unenforceable).toContain(
      'different amounts',
    );
  });
});

describe('a domain rule is extracted with its direction', () => {
  test.each([
    ['Only use amazon.co.uk', 'allow', ['amazon.co.uk']],
    ['stay on example.com', 'allow', ['example.com']],
    ['only browse github.com and docs.github.com', 'allow', ['github.com', 'docs.github.com']],
    ['Never visit facebook.com', 'deny', ['facebook.com']],
    ["Don't go to twitter.com or reddit.com", 'deny', ['twitter.com', 'reddit.com']],
    ['avoid ebay.com', 'deny', ['ebay.com']],
  ] as const)('%s becomes %s of %s', (text, mode, hosts) => {
    expect(gateOf(text)).toEqual({ kind: 'domain', mode, hosts });
  });

  test('a host with no direction is guidance with a warning', () => {
    expect(compileRule('prefer amazon.co.uk').unenforceable).toContain('does not say whether');
  });

  test('a decimal is not a host', () => {
    // `200.00` and `e.g` both look host-shaped to a lazy regex, and a domain
    // gate built out of one would refuse every navigation on the run.
    expect(readAmounts('under £200.00').length).toBe(1);
    expect(compileRule('keep the total under £200.00').gate).toEqual({
      kind: 'spend_ceiling',
      currency: 'GBP',
      amount: '200.00',
    });
  });
});

describe('a confirmation rule is extracted per irreversible class', () => {
  test.each([
    ['Ask me before you buy anything', ['order']],
    ["Don't place an order without checking with me", ['order']],
    ['never submit a payment without my approval', ['payment']],
    ['confirm with me before sending any message', ['message']],
    ["don't create accounts", ['account']],
  ] as const)('%s becomes a confirmation gate over %s', (text, classes) => {
    expect(gateOf(text)).toEqual({ kind: 'confirm_irreversible', classes });
  });

  test('an unnamed class means every class', () => {
    expect(gateOf('ask me before doing anything irreversible')).toEqual({
      kind: 'confirm_irreversible',
      classes: ['payment', 'order', 'message', 'account', 'handoff'],
    });
  });
});

describe('two constraints in one sentence are refused rather than approximated', () => {
  test('a host-scoped ceiling compiles to nothing and says to split it', () => {
    // Neither half is the rule: the ceiling alone applies it to every site, the
    // deny alone forbids a £5 order the sentence permits. Enforcing either
    // would be us deciding for them, silently.
    const rule = compileRule('never spend over £200 on ebay.com');
    expect(rule.class).toBe('guidance');
    expect(rule.unenforceable).toContain('Split it into two rules');
  });

  test('and split, both halves are enforced', () => {
    const set = compileRules(['never spend over £200', 'never use ebay.com']);
    expect(set.map((rule) => rule.class)).toEqual(['enforced', 'enforced']);
  });
});

describe('ordinary guidance is quiet', () => {
  test.each([
    'Be polite in any message you send',
    'Prefer results in English',
    'Always read the whole page before deciding',
  ])('%s is guidance with no warning', (text) => {
    const rule = compileRule(text);
    expect(rule.class).toBe('guidance');
    expect(rule.unenforceable).toBeNull();
  });
});

describe('the split is what the customer is shown', () => {
  test('every rule carries its class, its enforcement in English, and its text verbatim', () => {
    const view = rulesView(
      compileRules(['  Never spend over £200  ', 'never spend over 200', 'Be polite']),
    );

    expect(view.enforced).toBe(1);
    expect(view.guidance).toBe(2);
    expect(view.rules[0]).toEqual({
      // Trimmed, never reworded: a rule the customer cannot recognise is one
      // they cannot audit.
      text: 'Never spend over £200',
      class: 'enforced',
      enforcement: 'blocks any dispatch that would commit more than GBP 200.00',
      gate: { kind: 'spend_ceiling', currency: 'GBP', amount: '200.00' },
      unenforceable: null,
    });
    expect(view.rules[1]?.class).toBe('guidance');
    expect(view.rules[1]?.unenforceable).toContain('no currency');
    expect(view.rules[2]?.unenforceable).toBeNull();
  });
});

describe('the wire form', () => {
  test('an empty array is valid and is not the same as absent', () => {
    // Absent means "use the workspace default". `[]` means "this run runs under
    // no rules", which a customer is entitled to say out loud.
    expect(validateRules([])).toEqual({ ok: true, value: [] });
  });

  test('a blank rule, a non-string and a novel are each refused by name', () => {
    expect(validateRules(['  ']).ok).toBe(false);
    expect(validateRules([1]).ok).toBe(false);
    expect(validateRules('never spend over £200').ok).toBe(false);
    expect(validateRules([`${'x'.repeat(MAX_RULE_LENGTH + 1)}`]).ok).toBe(false);
    expect(validateRules(new Array<string>(MAX_RULES + 1).fill('be polite')).ok).toBe(false);
  });
});
