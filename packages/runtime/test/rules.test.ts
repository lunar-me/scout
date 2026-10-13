import { describe, expect, test } from 'bun:test';

import { compileRules } from '@outcrawl/scout-core';

import type { Action } from '../src/actions';
import type { ModelChoice } from '../src/loop';
import { renderPrompt, runAgent } from '../src/loop';
import { RuleBlockedError, checkRules, renderRules } from '../src/rules';
import type { AxTree } from '../src/snapshot';
import { harness, node, refOf, tree } from './support';

const CAPS = { steps: 8, budget: '2.00', duration: '5m' };

/**
 * A checkout page shaped the way the AX tree really renders one: the total's
 * label and the total's number are two adjacent `StaticText` nodes, and the
 * commit button's own label carries no number at all. A page where the number
 * sat on the button would be the easy case and is not the common one.
 */
function checkoutPage(total: string): AxTree {
  return tree(
    node({
      role: 'RootWebArea',
      name: 'Checkout',
      children: [
        node({ role: 'heading', name: 'Order summary' }),
        node({ role: 'StaticText', name: 'Order total' }),
        node({ role: 'StaticText', name: total }),
        node({ role: 'textbox', name: 'Card number', value: '4242 4242 4242 4242' }),
        node({ role: 'button', name: 'Place order' }),
        node({ role: 'button', name: 'Back' }),
      ],
    }),
    'https://shop.example.com/checkout',
  );
}

function script(...choices: readonly ModelChoice[]) {
  return (_prompt: unknown, step: number): ModelChoice =>
    choices[step] ?? { action: { type: 'done', summary: 'finished' } };
}

describe('a spend ceiling BLOCKS the dispatch rather than warning about it', () => {
  test('a £249.99 order under a £200 ceiling never reaches the page', async () => {
    const page = checkoutPage('£249.99');
    const placeOrder: Action = { type: 'click', ref: refOf(page, 'Place order') };
    const h = harness({ tree: page, model: script({ action: placeOrder }) });

    const result = await runAgent(h.deps, {
      task: 'buy the thing',
      caps: CAPS,
      stepFailures: null,
      rules: compileRules(['Never spend over £200']),
    });

    // THE ASSERTION THIS WHOLE SLICE EXISTS FOR: the browser was never asked to
    // do it. `performed` is the harness's record of what crossed
    // `AgentDeps.perform`, which in production is input through `agenthands`,
    // and `events` is every boundary crossing in order — so a click that was
    // refused after landing would show up in both.
    expect(h.performed).toEqual([]);
    expect(h.events).not.toContain('perform');

    // And the refusal is on the run's own evidence, naming the customer's rule
    // and the number that tripped it, so a replay says why.
    const step = result.steps[0];
    expect(step?.error).toContain('rule blocked this action');
    expect(step?.error).toContain('Never spend over £200');
    expect(step?.error).toContain('GBP 249.99');
    expect(step?.error).toContain('GBP 200.00');
  });

  test('the same page under the same ceiling dispatches when the total fits', async () => {
    // The control arm, and it is what separates a gate from a brick: a rule
    // that refused every checkout would pass the test above and be useless.
    const page = checkoutPage('£150.00');
    const placeOrder: Action = { type: 'click', ref: refOf(page, 'Place order') };
    const h = harness({ tree: page, model: script({ action: placeOrder }) });

    await runAgent(h.deps, {
      task: 'buy the thing',
      caps: CAPS,
      stepFailures: null,
      rules: compileRules(['Never spend over £200']),
    });

    expect(h.performed).toEqual([placeOrder]);
  });

  test('a commit whose amount cannot be read is refused, not waved through', () => {
    // FAILING TOWARD BLOCKING. The page is a checkout by URL and carries a card
    // field, so the classifier says this click may commit — and there is no
    // total anywhere to check against the ceiling. Passing it would be the one
    // outcome the customer cannot recover from.
    const page = tree(
      node({
        role: 'RootWebArea',
        name: 'Checkout',
        children: [
          node({ role: 'textbox', name: 'Card number', value: '' }),
          node({ role: 'button', name: 'Continue' }),
        ],
      }),
      'https://shop.example.com/checkout',
    );
    const refusal = checkRules(compileRules(['Never spend over £200']), {
      action: { type: 'click', ref: refOf(page, 'Continue') },
      node: node({ role: 'button', name: 'Continue', ref: refOf(page, 'Continue') }),
      tree: page,
      history: [],
    });

    expect(refusal?.evidence).toContain('no amount could be read');
  });

  test('a total in another currency is refused rather than converted', () => {
    const page = checkoutPage('$249.99');
    const refusal = checkRules(compileRules(['Never spend over £200']), {
      action: { type: 'click', ref: refOf(page, 'Place order') },
      node: node({ role: 'button', name: 'Place order', ref: refOf(page, 'Place order') }),
      tree: page,
      history: [],
    });

    // There is no FX rate anywhere in this product. Guessing one is the only
    // thing worse than refusing.
    expect(refusal?.evidence).toContain('USD 249.99');
    expect(refusal?.evidence).toContain('converts between currencies');
  });

  test('a ceiling does not gate a dispatch that commits nothing', () => {
    const page = checkoutPage('£249.99');
    const refusal = checkRules(compileRules(['Never spend over £200']), {
      action: { type: 'fill', ref: refOf(page, 'Card number'), text: '4242' },
      node: node({ role: 'textbox', name: 'Card number', ref: refOf(page, 'Card number') }),
      tree: page,
      history: [],
    });

    expect(refusal).toBeUndefined();
  });
});

describe('a domain rule blocks the navigation before the browser is sent', () => {
  test('a denied host never reaches perform', async () => {
    const page = checkoutPage('£10.00');
    const h = harness({
      tree: page,
      model: script({ action: { type: 'navigate', url: 'https://www.ebay.com/itm/1' } }),
    });

    const result = await runAgent(h.deps, {
      task: 'find it',
      caps: CAPS,
      stepFailures: null,
      rules: compileRules(['Never use ebay.com']),
    });

    expect(h.performed).toEqual([]);
    // Subdomains are covered: the rule said `ebay.com` and the model tried
    // `www.ebay.com`.
    expect(result.steps[0]?.error).toContain('www.ebay.com is covered by the denied host ebay.com');
  });

  test('an allow-list refuses everything it does not name, and admits subdomains', async () => {
    const page = checkoutPage('£10.00');
    const allowed = compileRules(['Only use github.com']);

    const off = harness({
      tree: page,
      model: script({ action: { type: 'navigate', url: 'https://gitlab.com/x' } }),
    });
    await runAgent(off.deps, {
      task: 'read the repo',
      caps: CAPS,
      stepFailures: null,
      rules: allowed,
    });
    expect(off.performed).toEqual([]);

    const on = harness({
      tree: page,
      model: script({ action: { type: 'navigate', url: 'https://docs.github.com/x' } }),
    });
    await runAgent(on.deps, {
      task: 'read the repo',
      caps: CAPS,
      stepFailures: null,
      rules: allowed,
    });
    expect(on.performed).toEqual([{ type: 'navigate', url: 'https://docs.github.com/x' }]);
  });
});

describe('a confirmation rule blocks an irreversible dispatch', () => {
  test('an order commit is refused when the customer asked to be asked first', async () => {
    const page = checkoutPage('£10.00');
    const placeOrder: Action = { type: 'click', ref: refOf(page, 'Place order') };
    const h = harness({ tree: page, model: script({ action: placeOrder }) });

    const result = await runAgent(h.deps, {
      task: 'buy the thing',
      caps: CAPS,
      stepFailures: null,
      rules: compileRules(['Ask me before you place an order']),
    });

    expect(h.performed).toEqual([]);
    expect(result.steps[0]?.error).toContain('irreversible order action');
  });

  test('a rule about messages does not refuse an order', () => {
    const page = checkoutPage('£10.00');
    const refusal = checkRules(compileRules(['Never send a message without asking me']), {
      action: { type: 'click', ref: refOf(page, 'Place order') },
      node: node({ role: 'button', name: 'Place order', ref: refOf(page, 'Place order') }),
      tree: page,
      history: [],
    });

    // Reading a message rule as covering a purchase would be us inventing a
    // restriction the customer did not write.
    expect(refusal).toBeUndefined();
  });
});

describe('guidance is guidance: it reaches the prompt and gates nothing', () => {
  test('a guidance rule never refuses a dispatch', async () => {
    const page = checkoutPage('£249.99');
    const placeOrder: Action = { type: 'click', ref: refOf(page, 'Place order') };
    const h = harness({ tree: page, model: script({ action: placeOrder }) });

    await runAgent(h.deps, {
      task: 'buy the thing',
      caps: CAPS,
      stepFailures: null,
      rules: compileRules(['Prefer sellers with good reviews']),
    });

    expect(h.performed).toEqual([placeOrder]);
  });

  test('both classes are in the prompt and the enforced ones say they are enforced', async () => {
    const page = checkoutPage('£10.00');
    const h = harness({ tree: page, model: script({ action: { type: 'done', summary: 'x' } }) });

    await runAgent(h.deps, {
      task: 'buy the thing',
      caps: CAPS,
      stepFailures: null,
      rules: compileRules(['Never spend over £200', 'Prefer sellers with good reviews']),
    });

    const text = h.prompts[0]?.text ?? '';
    expect(text).toContain('ENFORCED');
    expect(text).toContain('Never spend over £200');
    expect(text).toContain('GUIDANCE');
    expect(text).toContain('Prefer sellers with good reviews');
  });

  test('a run with no rules renders the prompt it rendered before rules existed', () => {
    const page = checkoutPage('£10.00');
    const base = {
      task: 'buy the thing',
      step: 0,
      tree: page,
      snapshotHash: 'ax1:0',
      history: [],
    } as const;

    // The switch-is-off guarantee, asserted rather than hoped: an absent rule
    // set and an empty one both render the byte-identical string.
    expect(renderPrompt({ ...base, rules: [] })).toBe(renderPrompt(base));
    expect(renderRules([])).toBe('');
  });
});

describe('the refusal is legible to a human and to the model', () => {
  test('RuleBlockedError names the rule, the evidence and the enforcement', () => {
    const error = new RuleBlockedError({
      rule: 'Never spend over £200',
      gate: { kind: 'spend_ceiling', currency: 'GBP', amount: '200.00' },
      evidence: 'this dispatch would commit GBP 249.99',
    });

    expect(error.message).toContain('Never spend over £200');
    expect(error.message).toContain('GBP 249.99');
    // The model is told the class, not just the refusal, so it does not spend a
    // second step discovering that arguing is not an option.
    expect(error.message).toContain('ENFORCED, not advice');
  });
});

describe('an email address nobody gave the run is never typed into a page', () => {
  /**
   * Production 2026-10-04, IW2 run_… (n=1): asked to add a product to
   * the cart, the run typed "test@example.com" into a store's "$30 off"
   * sign-up form. The same footer form, as the AX tree renders it.
   */
  const store = tree(
    node({
      role: 'RootWebArea',
      name: 'Honey Birdette',
      children: [
        node({ role: 'StaticText', name: 'ENTER YOUR EMAIL & GET $30 OFF.' }),
        node({ role: 'textbox', name: 'EMAIL ADDRESS*' }),
        node({ role: 'button', name: 'GET $30 OFF' }),
        node({ role: 'link', name: 'View Skeletina Set' }),
      ],
    }),
    'https://us.honeybirdette.com/',
  );
  const typeEmail = (text: string): Action => ({ type: 'fill', ref: refOf(store, 'EMAIL ADDRESS*'), text });

  test('a made-up address is refused before the page is touched, with what to do instead', async () => {
    const h = harness({ tree: store, model: script({ action: typeEmail('test@example.com') }) });

    const result = await runAgent(h.deps, {
      task: 'Add any one product to the cart and reach the cart page, closing any discount popup that appears first.',
      caps: CAPS,
      stepFailures: null,
    });

    expect(h.performed).toEqual([]);
    expect(result.steps[0]?.error).toContain('"test@example.com" is an email address that neither the task nor the page gave you');
    expect(result.steps[0]?.error).toContain('close it with its close control or Escape');
  });

  test('an address the task gave is typed', async () => {
    const fill = typeEmail('jane.doe@acme.io');
    const h = harness({ tree: store, model: script({ action: fill }) });

    await runAgent(h.deps, {
      task: 'Join the newsletter as jane.doe@acme.io.',
      caps: CAPS,
      stepFailures: null,
    });

    expect(h.performed).toEqual([fill]);
  });

  test('a task that asks for made-up values gets the made-up address typed', async () => {
    for (const task of ['Sign up for the newsletter with a test email.', 'Fill the sign-up form with dummy values.']) {
      const fill = typeEmail('test@example.com');
      const h = harness({ tree: store, model: script({ action: fill }) });

      const result = await runAgent(h.deps, { task, caps: CAPS, stepFailures: null });

      expect(h.performed).toEqual([fill]);
      expect(result.steps[0]?.error).toBeUndefined();
    }
  });

  /** A volunteer sign-up page: the form the task means, and a newsletter box in the footer. */
  const signup = tree(
    node({
      role: 'RootWebArea',
      name: 'Volunteer sign-up',
      children: [
        node({ role: 'textbox', name: 'Full name', state: { required: true } }),
        node({ role: 'textbox', name: 'Email', state: { required: true } }),
        node({ role: 'textbox', name: 'Work email *' }),
        node({ role: 'button', name: 'Register' }),
        node({ role: 'textbox', name: 'Get our newsletter' }),
      ],
    }),
    'https://volunteers.test/signup',
  );
  const fillTask = 'Open the volunteer page, fill out the registration form and submit it.';

  test('a task that says to fill in and submit a form gets a test-domain address typed into its required fields', async () => {
    for (const field of ['Email', 'Work email *']) {
      const fill: Action = { type: 'fill', ref: refOf(signup, field), text: 'jane.doe@example.com' };
      const h = harness({ tree: signup, model: script({ action: fill }) });

      const result = await runAgent(h.deps, { task: fillTask, caps: CAPS, stepFailures: null });

      expect(h.performed).toEqual([fill]);
      expect(result.steps[0]?.error).toBeUndefined();
    }
  });

  test('on a form task an address at a real domain is refused and the run is told to use example.com', async () => {
    const h = harness({
      tree: signup,
      model: script({ action: { type: 'fill', ref: refOf(signup, 'Email'), text: 'jane.doe@gmail.com' } }),
    });

    const result = await runAgent(h.deps, { task: fillTask, caps: CAPS, stepFailures: null });

    expect(h.performed).toEqual([]);
    expect(result.steps[0]?.error).toContain('"jane.doe@gmail.com"');
    expect(result.steps[0]?.error).toContain('use one at example.com');
  });

  test('on a form task a box the form does not require is still refused', async () => {
    const h = harness({
      tree: signup,
      model: script({ action: { type: 'fill', ref: refOf(signup, 'Get our newsletter'), text: 'jane.doe@example.com' } }),
    });

    const result = await runAgent(h.deps, { task: fillTask, caps: CAPS, stepFailures: null });

    expect(h.performed).toEqual([]);
    expect(result.steps[0]?.error).toContain('close it with its close control or Escape');
  });

  test('a task that only reads a form\u2019s fields does not permit filling them', async () => {
    const h = harness({
      tree: signup,
      model: script({ action: { type: 'fill', ref: refOf(signup, 'Email'), text: 'jane.doe@example.com' } }),
    });

    const result = await runAgent(h.deps, {
      task: 'Complete these steps. 1. Open the volunteer page and list which fields the registration form requires.',
      caps: CAPS,
      stepFailures: null,
    });

    expect(h.performed).toEqual([]);
    expect(result.steps[0]?.error).toContain('neither the task nor the page gave you');
  });
});
