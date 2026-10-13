/**
 * The fan's two gates.
 *
 * `planFan` decides which of a reply's tab-qualified actions may run at all,
 * and `fanAbort` decides whether each survivor still matches the tab it was
 * chosen against. Both are pure, so every case here is exact.
 *
 * The case that matters most is the hash one. `hashSnapshot` excludes node
 * references by design, so a re-render that recreates every node produces a
 * tree with an IDENTICAL hash and not one live reference in common — and any
 * gate that short-circuited on hash equality would call that the cheap case and
 * act on a dead reference. That is the failure the action lock exists to
 * remove, so it is asserted here rather than trusted to a comment.
 */

import { describe, expect, test } from 'bun:test';

import { MAX_FAN, fanAbort, planFan, type FanTab } from '../src/fan';
import { hashSnapshot, nodeRef, serializeTree, type AxNode, type AxTree } from '../src/snapshot';

function leaf(id: number, role: string, name: string, disabled = false): AxNode {
  return {
    ref: nodeRef(0, id),
    role,
    name,
    xpath: `/html/body/*[${String(id)}]`,
    ...(disabled ? { state: { disabled: true } } : {}),
  };
}

/** A page with one button and one price line. `idBase` shifts every node id. */
function vendor(url: string, idBase: number, price: string, buttonName = 'Add to basket'): AxTree {
  return {
    url,
    root: {
      ref: nodeRef(0, idBase),
      role: 'RootWebArea',
      name: 'Kettle',
      xpath: '/html',
      children: [leaf(idBase + 1, 'StaticText', `Price: ${price}`), leaf(idBase + 2, 'button', buttonName)],
    },
  };
}

const FOCUSED = vendor('https://one.test/kettle', 100, '39.50');
const T2 = vendor('https://two.test/kettle', 200, '41.00');
const T3 = vendor('https://three.test/kettle', 300, '37.95');

const OTHERS: readonly FanTab[] = [
  { tab: 't2', tree: T2 },
  { tab: 't3', tree: T3 },
];

function plan(also: readonly unknown[], limit = MAX_FAN) {
  return planFan({
    also,
    focused: { tab: 't1', tree: FOCUSED },
    others: OTHERS,
    live: ['t1', 't2', 't3', 't4'],
    limit,
  });
}

describe('planFan', () => {
  test('a tab-qualified action runs against the tree of the tab it names', () => {
    const result = plan([
      { tab: 't2', type: 'extract', instruction: 'the price' },
      { tab: 't3', type: 'click', ref: nodeRef(0, 302) },
    ]);

    expect(result.refused).toEqual([]);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.tab).toBe('t2');
    // `extract` names no node and still reads the page, so it is gated — the
    // tree it was chosen from has to be carried to the dispatch.
    expect(result.steps[0]?.chosenFrom).toBe(T2);
    // And the click's reference resolved in t3's tree, not the focused one:
    // node 302 exists only there.
    expect(result.steps[1]?.action).toEqual({ type: 'click', ref: nodeRef(0, 302) });
    expect(result.steps[1]?.chosenFrom).toBe(T3);
  });

  test('an element naming a tab nobody read is refused, not dispatched', () => {
    // t4 is LIVE — it is in `live` — and the model was shown no page for it.
    // Dispatching would be acting on a page nobody read, which is the failure
    // the whole lock discipline exists to prevent arriving by a new door.
    const result = plan([{ tab: 't4', type: 'click', ref: nodeRef(0, 402) }]);

    expect(result.steps).toEqual([]);
    expect(result.refused[0]?.tab).toBe('t4');
    expect(result.refused[0]?.reason).toMatch(/were not shown a page for/);
  });

  test('the focused tab is refused: the head action is already driving it', () => {
    const result = plan([{ tab: 't1', type: 'click', ref: nodeRef(0, 102) }]);

    expect(result.steps).toEqual([]);
    expect(result.refused[0]?.reason).toMatch(/names the focused tab/);
  });

  test('one action per tab per reply', () => {
    const result = plan([
      { tab: 't2', type: 'click', ref: nodeRef(0, 202) },
      { tab: 't2', type: 'extract', instruction: 'the price' },
    ]);

    // Two concurrent locks on one tab is a self-deadlock, and two mutations
    // against one tree read is the race with extra steps.
    expect(result.steps).toHaveLength(1);
    expect(result.refused[0]?.reason).toMatch(/second action for tab t2/);
  });

  test('elements past the width ceiling are dropped AND reported', () => {
    const result = plan(
      [
        { tab: 't2', type: 'extract' },
        { tab: 't3', type: 'extract' },
      ],
      1,
    );

    // Unlike `then`, whose useful prefix is what the model meant, a dropped
    // element here is a site not visited. Silence would be the arm reporting a
    // speed-up for work it declined to do.
    expect(result.steps).toHaveLength(1);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.reason).toMatch(/at most 1 other tabs/);
  });

  test('focusTab is refused and openTab needs no tab', () => {
    const result = plan([
      { type: 'openTab', url: 'https://four.test/' },
      { tab: 't2', type: 'focusTab' },
    ]);

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.action).toEqual({ type: 'openTab', url: 'https://four.test/' });
    expect(result.steps[0]?.tab).toBeUndefined();
    // An `openTab` reads no page, so nothing has to be re-checked before it.
    expect(result.steps[0]?.chosenFrom).toBeUndefined();
    expect(result.refused[0]?.reason).toMatch(/focusTab is not one of/);
  });

  test('a reference from the wrong tab does not resolve', () => {
    // Node 102 is the focused tab's button. Aimed at t2 it is a reference read
    // from one page and used on another, and `validateAction` against t2's tree
    // is what refuses it — before any of the per-tab CDP defences are reached.
    const result = plan([{ tab: 't2', type: 'click', ref: nodeRef(0, 102) }]);

    expect(result.steps).toEqual([]);
    expect(result.refused[0]?.reason).toMatch(/unusable/);
  });
});

describe('fanAbort', () => {
  test('an identical hash with recreated nodes is REFUSED, not called cheap', () => {
    // The same page, re-rendered: same url, same roles, same names, same
    // structure — and every backend node id reminted, as a React re-render
    // does.
    const rerendered = vendor('https://two.test/kettle', 900, '41.00');
    expect(hashSnapshot(rerendered)).toBe(hashSnapshot(T2));

    const stop = fanAbort({ type: 'click', ref: nodeRef(0, 202) }, T2, rerendered);

    // A gate that consulted the hash would answer `undefined` here and click a
    // node that no longer exists.
    expect(stop).toMatch(/gone from this tab/);
  });

  test('the same node under a changed page is allowed through', () => {
    const moved: AxTree = {
      url: T2.url,
      root: {
        ...T2.root,
        children: [leaf(210, 'StaticText', 'Free delivery today'), leaf(202, 'button', 'Add to basket')],
      },
    };
    expect(hashSnapshot(moved)).not.toBe(hashSnapshot(T2));

    // The page changed and the named node did not, which is the whole point of
    // asking about the node rather than about the page.
    expect(fanAbort({ type: 'click', ref: nodeRef(0, 202) }, T2, moved)).toBeUndefined();
  });

  test('a node that became disabled is not the same node', () => {
    const soldOut: AxTree = {
      url: T2.url,
      root: { ...T2.root, children: [leaf(201, 'StaticText', 'Price: 41.00'), leaf(202, 'button', 'Add to basket', true)] },
    };

    expect(fanAbort({ type: 'click', ref: nodeRef(0, 202) }, T2, soldOut)).toMatch(/disabled/);
  });

  test('a tab that navigated refuses an extract, which names no node', () => {
    const elsewhere = vendor('https://two.test/checkout', 200, '41.00');

    // The url clause is the whole of an extract's gate, and it is the clause
    // that matters most: extracting from a page that moved returns another
    // page's data under this page's name, which is a silent wrong answer.
    expect(fanAbort({ type: 'extract' }, T2, elsewhere)).toMatch(/navigated to/);
    expect(fanAbort({ type: 'extract' }, T2, T2)).toBeUndefined();
  });
});

/**
 * A separate concern from the fan, in this file because it is the same defect
 * class and the same measurement discipline: a field the prompt asks the model
 * to trust, saying the opposite of the truth, on every step of every run.
 */
describe('state the model is shown', () => {
  test('this fork\u2019s invalid flag is never rendered, and is still carried', () => {
    const page: AxTree = {
      url: 'https://saucedemo.test/',
      root: {
        ref: nodeRef(0, 1),
        role: 'RootWebArea',
        name: 'Swag Labs',
        xpath: '/html',
        children: [
          {
            ref: nodeRef(0, 2),
            role: 'textbox',
            name: 'Username',
            xpath: '/html/body/input[1]',
            // Exactly what the shipped binary sends for an ordinary, empty,
            // perfectly valid login field: measured, 3 of 13 nodes on this page.
            state: { invalid: true, required: true },
          },
          {
            ref: nodeRef(0, 3),
            role: 'button',
            name: 'Login',
            xpath: '/html/body/input[3]',
            state: { invalid: true, disabled: true },
          },
        ],
      },
    };

    const rendered = serializeTree(page);

    // The prompt must not say it. Every run this fleet has served said it.
    expect(rendered).not.toContain('invalid');
    // And the flags that ARE facts still render, so this is an exclusion and
    // not a silent loss of the whole state column.
    expect(rendered).toContain('required');
    expect(rendered).toContain('disabled');
    // Still carried on the tree, deliberately: `probe-error-signals.ts` reads
    // `state.invalid` through this shape, so dropping it in transport would
    // make the probe report zero and read as "the emitter is fixed".
    expect(page.root.children?.[0]?.state?.invalid).toBe(true);
  });
});
