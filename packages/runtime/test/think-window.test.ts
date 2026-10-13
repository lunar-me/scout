/**
 * The think window, and the two things the loop is allowed to do with it.
 *
 * MEASURED IN PRODUCTION, 2026-09-07: the Hacker News read spent 9.9 s of its
 * 13.7 s inside `page.think` (72.1%) and the saucedemo checkout 17.3 s of 34.2 s
 * (50.7%) — with the page held at `VirtualTimePolicy::kPause` for every
 * millisecond of it, because `think` is called inside `session.withLock`. The
 * checkout also spent 15 steps and 15 model calls on a flow a person does in
 * four gestures, three of those steps being "type the username", "type the
 * password", "press Login" against one unchanging form.
 *
 * So two switches, and a law for each:
 *
 *   `liveThink` releases the freeze across the model call — and REPLACES the
 *   guarantee it gives up. The freeze made `validateAction` against the shown
 *   tree equivalent to a validation against the live page; without it the loop
 *   must re-read and re-check, heal through `AxNode.xpath` where it can, and
 *   look again where it cannot.
 *
 *   `program` lets one reply carry a short sequence — and STOPS it the instant
 *   the page stops matching what the model was shown. Every test about the abort
 *   below asserts on what reached the browser, not on what the prompt said,
 *   because a documented abort rule is not an abort rule.
 *
 * The frozen arm is the control and it has laws here too: it must keep the old
 * guarantee, keep the old prompt sentence, and pay nothing for machinery it
 * does not use.
 */

import { describe, expect, test } from 'bun:test';

import type { Action } from '../src/actions';
import { MAX_PROGRAM, chainAbort, refreshChoice, runAgent } from '../src/loop';
import type { AxNode, AxTree } from '../src/snapshot';
import { hashSnapshot, nodeRef } from '../src/snapshot';
import { harness, node, refOf, tree } from './support';

const CAPS = { steps: 8, budget: '2.00', duration: '5m' };
const done: Action = { type: 'done', summary: 'finished' };

/* ------------------------------------------------------------------ *
 * Pages
 * ------------------------------------------------------------------ */

/**
 * The login form, with every node's reference under the caller's control.
 *
 * `ids` is what makes the re-render case expressible: a React re-render
 * recreates the same elements with FRESH backend node ids and an identical
 * accessibility shape, so the two trees differ in nothing this file can see
 * except their references — and `hashSnapshot` excludes references by design.
 */
function form(ids: readonly [number, number, number], url = 'https://www.saucedemo.com/'): AxTree {
  return tree(
    node({
      role: 'RootWebArea',
      name: 'Swag Labs',
      children: [
        { ...node({ role: 'textbox', name: 'Username' }), ref: nodeRef(0, ids[0]), xpath: '/html/body/form/input[1]' },
        { ...node({ role: 'textbox', name: 'Password' }), ref: nodeRef(0, ids[1]), xpath: '/html/body/form/input[2]' },
        { ...node({ role: 'button', name: 'Login' }), ref: nodeRef(0, ids[2]), xpath: '/html/body/form/button' },
      ],
    }),
    url,
  );
}

/** The page the login lands on: a different document at a different url. */
const inventory = tree(
  node({
    role: 'RootWebArea',
    name: 'Swag Labs',
    children: [node({ role: 'button', name: 'Add to cart' })],
  }),
  'https://www.saucedemo.com/inventory.html',
);

const LOGIN = form([11, 12, 13]);
/** The same page, re-rendered: identical shape, not one reference in common. */
const RERENDERED = form([21, 22, 23]);

function childOf(page: AxTree, name: string): AxNode {
  const found = page.root.children?.find((child) => child.name === name);
  if (found === undefined) {
    throw new Error(`no child named ${name}`);
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * The ladder, on its own
 * ------------------------------------------------------------------ */

describe('refreshChoice decides what a live think window did to a choice', () => {
  test('an unchanged page is the cheap rung', () => {
    const click: Action = { type: 'click', ref: refOf(LOGIN, 'Login') };
    expect(refreshChoice(click, LOGIN, LOGIN, hashSnapshot(LOGIN))).toEqual({ rung: 'same' });
  });

  test('A RE-RENDER WITH AN IDENTICAL HASH IS NOT THE CHEAP RUNG', () => {
    // The trap this ladder was built around. `hashSnapshot` excludes node
    // references — it must, or the action cache would never hit on a second
    // visit — so these two trees hash IDENTICALLY while sharing no live
    // reference at all. A ladder that trusted the hash would dispatch a click
    // at a dead backend node id and call it the free case.
    expect(hashSnapshot(RERENDERED)).toBe(hashSnapshot(LOGIN));

    const click: Action = { type: 'click', ref: refOf(LOGIN, 'Login') };
    const verdict = refreshChoice(click, LOGIN, RERENDERED, hashSnapshot(LOGIN));

    expect(verdict.rung).toBe('xpath');
    if (verdict.rung !== 'xpath') {
      throw new Error('unreachable');
    }
    // Healed onto the reference the live page actually has.
    expect(verdict.action).toEqual({ type: 'click', ref: childOf(RERENDERED, 'Login').ref });
  });

  test('a changed page whose named node held is acted on without a model call', () => {
    const grown = tree(
      { ...LOGIN.root, children: [...(LOGIN.root.children ?? []), node({ role: 'alert', name: 'Epic sadface' })] },
      LOGIN.url,
    );
    const click: Action = { type: 'click', ref: refOf(LOGIN, 'Login') };
    expect(refreshChoice(click, LOGIN, grown, hashSnapshot(LOGIN))).toEqual({ rung: 'node' });
  });

  test('a navigation is stale even when the new page offers the same control', () => {
    // The reason the url is checked FIRST and on its own. Both pages have a
    // node named `Add to cart`; healing onto it would be acting on the page
    // AFTER the one the model read, which is the exact TOCTOU failure the
    // freeze exists to prevent, wearing the costume of a successful heal.
    // The same nodes verbatim — only the url differs, so the url check is the
    // only thing that can make this stale.
    const twin = tree(inventory.root, 'https://www.saucedemo.com/cart.html');
    const click: Action = { type: 'click', ref: refOf(inventory, 'Add to cart') };
    const verdict = refreshChoice(click, inventory, twin, hashSnapshot(inventory));
    expect(verdict.rung).toBe('stale');
  });

  test('a node that is simply gone is stale, and says so', () => {
    const emptied = tree({ ...LOGIN.root, children: [] }, LOGIN.url);
    const click: Action = { type: 'click', ref: refOf(LOGIN, 'Login') };
    const verdict = refreshChoice(click, LOGIN, emptied, hashSnapshot(LOGIN));
    expect(verdict.rung).toBe('stale');
    if (verdict.rung !== 'stale') {
      throw new Error('unreachable');
    }
    expect(verdict.reason).toContain('Login');
  });

  test('a disabled node is not the same node', () => {
    const disabled = tree(
      {
        ...LOGIN.root,
        children: (LOGIN.root.children ?? []).map((child) =>
          child.name === 'Login' ? { ...child, state: { disabled: true } } : child,
        ),
      },
      LOGIN.url,
    );
    const click: Action = { type: 'click', ref: refOf(LOGIN, 'Login') };
    // The reference still resolves, so only the identity check can catch this:
    // a click on a disabled button is an input the page discards and a step the
    // run pays for.
    expect(refreshChoice(click, LOGIN, disabled, hashSnapshot(LOGIN)).rung).toBe('stale');
  });

  test('an ambiguous xpath is refused rather than guessed', () => {
    const twins = tree(
      {
        ...LOGIN.root,
        children: [
          { ...node({ role: 'button', name: 'Login' }), ref: nodeRef(0, 31), xpath: '/html/body/form/button' },
          { ...node({ role: 'button', name: 'Login' }), ref: nodeRef(0, 32), xpath: '/html/body/form/button' },
        ],
      },
      LOGIN.url,
    );
    const click: Action = { type: 'click', ref: refOf(LOGIN, 'Login') };
    expect(refreshChoice(click, LOGIN, twins, hashSnapshot(LOGIN)).rung).toBe('stale');
  });
});

/* ------------------------------------------------------------------ *
 * The abort rule, on its own
 * ------------------------------------------------------------------ */

describe('chainAbort is the abort rule', () => {
  const fill: Action = { type: 'fill', ref: refOf(LOGIN, 'Password'), text: 'secret_sauce' };

  test('same document, same node: the sequence continues', () => {
    expect(chainAbort(fill, LOGIN, LOGIN)).toBeUndefined();
  });

  test('a key press with no reference is held to the url clause alone', () => {
    // What makes `fill` then `press Enter` expressible at all.
    expect(chainAbort({ type: 'press', key: 'Enter' }, LOGIN, LOGIN)).toBeUndefined();
    expect(chainAbort({ type: 'press', key: 'Enter' }, LOGIN, inventory)).toContain('navigated');
  });

  test('a navigation under the sequence stops it', () => {
    expect(chainAbort(fill, LOGIN, inventory)).toContain('navigated');
  });

  test('a re-render under the sequence stops it', () => {
    // Same shape, same hash, dead references. There is no heal here on purpose:
    // healing a chained element would be acting twice on a memory of a page.
    expect(chainAbort(fill, LOGIN, RERENDERED)).toContain('gone');
  });

  test('an action that replaces the page cannot be chained at all', () => {
    expect(chainAbort({ type: 'navigate', url: 'https://example.com/' }, LOGIN, LOGIN)).toContain(
      'cannot be chained',
    );
    expect(chainAbort(done, LOGIN, LOGIN)).toContain('cannot be chained');
    expect(chainAbort({ type: 'extract', instruction: 'read it' }, LOGIN, LOGIN)).toContain(
      'cannot be chained',
    );
  });
});

/* ------------------------------------------------------------------ *
 * The loop, on the live arm
 * ------------------------------------------------------------------ */

describe('the page runs while the model thinks', () => {
  test('THE FREEZE IS DOWN FOR THE MODEL CALL AND BACK UP FOR THE ACTION', async () => {
    const frozenWhileThinking: boolean[] = [];
    const frozenWhileActing: boolean[] = [];
    const h = harness({
      tree: LOGIN,
      perform: () => {
        frozenWhileActing.push(h.browser.frozen);
      },
      model: (_prompt, step) => {
        frozenWhileThinking.push(h.browser.frozen);
        return step === 0
          ? { action: { type: 'click', ref: refOf(LOGIN, 'Login') } }
          : { action: done };
      },
    });

    const result = await runAgent(h.deps, {
      task: 'log in',
      caps: CAPS,
      stepFailures: 3,
      liveThink: true,
      settle: false,
    });

    expect(result.status).toBe('completed');
    // The whole point: the page was RUNNING for every model call.
    expect(frozenWhileThinking).toEqual([false, false]);
    // And frozen again for the input, which is not negotiable — an action
    // dispatched to a live page is an action racing the page it acts on.
    expect(frozenWhileActing).toEqual([true]);
    // Every freeze accounted for: the release around the think is a release,
    // and the retake is an acquire.
    expect(h.balance.acquired).toBe(h.balance.released);
    expect(h.browser.frozen).toBe(false);
  });

  test('the frozen arm still holds the freeze across the think, and says so', async () => {
    const frozenWhileThinking: boolean[] = [];
    const h = harness({
      tree: LOGIN,
      model: () => {
        frozenWhileThinking.push(h.browser.frozen);
        return { action: done };
      },
    });

    await runAgent(h.deps, { task: 'log in', caps: CAPS, stepFailures: 3, settle: false });

    expect(frozenWhileThinking).toEqual([true]);
    // The prompt's promise matches what the loop is doing. A run told the page
    // is frozen while it is not is a run being lied to about the one guarantee
    // it is asked to rely on.
    expect(h.prompts[0]?.text).toContain('The page is frozen while you think');
    expect(h.prompts[0]?.pageLive).toBeUndefined();
  });

  test('the live arm does not promise a frozen page', async () => {
    const h = harness({ tree: LOGIN, model: () => ({ action: done }) });

    await runAgent(h.deps, {
      task: 'log in',
      caps: CAPS,
      stepFailures: 3,
      liveThink: true,
      settle: false,
    });

    expect(h.prompts[0]?.text).not.toContain('The page is frozen while you think');
    expect(h.prompts[0]?.text).toContain('The page keeps running while you think');
  });

  test('A RE-RENDER UNDER THE THINK IS HEALED, NOT RE-ASKED', async () => {
    // The economics of the whole change: this page moved under the answer and
    // it cost ZERO extra model calls, because the xpath heal is a walk of a
    // tree the loop had already read.
    let reads = 0;
    const h = harness({
      snapshot: () => {
        reads += 1;
        // Read 1 is what the model is shown; every read after it is the
        // re-rendered page.
        return reads <= 1 ? LOGIN : RERENDERED;
      },
      model: (_prompt, step) =>
        step === 0 ? { action: { type: 'click', ref: refOf(LOGIN, 'Login') } } : { action: done },
    });

    const result = await runAgent(h.deps, {
      task: 'log in',
      caps: CAPS,
      stepFailures: 3,
      liveThink: true,
      settle: false,
    });

    expect(result.status).toBe('completed');
    // ONE model call for the acting step, not two.
    expect(h.events.filter((event) => event === 'model')).toHaveLength(2);
    // And the click went to the LIVE reference, not the dead one it was chosen
    // with. This is the assertion that separates a heal from a hope.
    expect(h.performed).toEqual([{ type: 'click', ref: childOf(RERENDERED, 'Login').ref }]);
    expect(result.steps[0]?.reflex).toEqual({ rung: 'xpath', reobserves: 0, chained: 0 });
    // The cache unit records the node that was ACTED on, so a replay's heal
    // path does not point at a node that was already gone.
    expect(result.steps[0]?.observed?.ref).toBe('0-23');
  });

  test('a navigation under the think costs ONE re-look, and the second look sees the new page', async () => {
    let reads = 0;
    const seen: string[] = [];
    const h = harness({
      snapshot: () => {
        reads += 1;
        return reads <= 1 ? LOGIN : inventory;
      },
      model: (prompt) => {
        seen.push(prompt.tree.url);
        // The first answer names a node on the login page; by the time it
        // arrives the browser is on the inventory page.
        return prompt.tree.url === LOGIN.url
          ? { action: { type: 'click', ref: refOf(LOGIN, 'Login') } }
          : { action: done };
      },
    });

    const result = await runAgent(h.deps, {
      task: 'log in',
      caps: CAPS,
      stepFailures: 3,
      liveThink: true,
      settle: false,
    });

    expect(result.status).toBe('completed');
    // Two model calls on ONE step: the answer that went stale, and the answer
    // to the page as it is. The step count does not move — the run is charged
    // for the tokens, not for a second step.
    expect(seen).toEqual([LOGIN.url, inventory.url]);
    expect(result.stepsUsed).toBe(1);
    expect(result.steps[0]?.reflex).toEqual({ rung: 'same', reobserves: 1, chained: 0 });
    // The stale click never reached the browser.
    expect(h.performed).toEqual([]);
    // And the model was told WHY it was being asked again, or it would answer
    // the same way twice.
    expect(h.prompts[1]?.text).toContain('The page changed while you were answering');
  });

  test('a page that keeps moving fails the step rather than paying for it repeatedly', async () => {
    let reads = 0;
    const h = harness({
      // Every read is a different url, so no answer can survive validation.
      snapshot: () => {
        reads += 1;
        return tree(LOGIN.root, `https://www.saucedemo.com/?read=${String(reads)}`);
      },
      model: (prompt) => ({
        action: { type: 'click', ref: refOf(prompt.tree, 'Login') },
      }),
    });

    const result = await runAgent(h.deps, {
      task: 'log in',
      caps: CAPS,
      stepFailures: 1,
      liveThink: true,
      settle: false,
    });

    // Bounded: two model calls per step, then the step fails and
    // `stepFailures` decides the run. Nothing was clicked on a page nobody had
    // read.
    expect(h.performed).toEqual([]);
    expect(result.status).toBe('failed');
    expect(result.steps[0]?.error).toContain('kept changing');
  });
});

/* ------------------------------------------------------------------ *
 * Motor programs
 * ------------------------------------------------------------------ */

describe('one reply can carry a short sequence', () => {
  test('TYPE-THEN-ENTER IS ONE MODEL CALL AND ONE STEP', async () => {
    const h = harness({
      tree: LOGIN,
      model: (_prompt, step) =>
        step === 0
          ? {
              action: { type: 'fill', ref: refOf(LOGIN, 'Username'), text: 'standard_user' },
              envelope: {
                then: [
                  { type: 'fill', ref: refOf(LOGIN, 'Password'), text: 'secret_sauce' },
                  { type: 'click', ref: refOf(LOGIN, 'Login') },
                ],
              },
            }
          : { action: done },
    });

    const result = await runAgent(h.deps, {
      task: 'log in',
      caps: CAPS,
      stepFailures: 3,
      program: 2,
      settle: false,
    });

    expect(result.status).toBe('completed');
    // Three dispatches, one model call, one step. That is the whole saving:
    // the production run spent three steps and three prompts on this.
    expect(h.performed).toEqual([
      { type: 'fill', ref: refOf(LOGIN, 'Username'), text: 'standard_user' },
      { type: 'fill', ref: refOf(LOGIN, 'Password'), text: 'secret_sauce' },
      { type: 'click', ref: refOf(LOGIN, 'Login') },
    ]);
    expect(result.steps[0]?.reflex?.chained).toBe(2);
    expect(result.stepsUsed).toBe(2);
  });

  test('THE TAIL IS DROPPED WHEN THE PAGE MOVES, AND THE MODEL IS TOLD', async () => {
    // The head click navigates. The chained click was chosen against the login
    // page and would land on whatever happens to be at that node id on the
    // inventory page — which is the failure this rule exists to make
    // impossible.
    let navigated = false;
    const h = harness({
      snapshot: () => (navigated ? inventory : LOGIN),
      perform: (action) => {
        if (action.type === 'click') {
          navigated = true;
        }
      },
      model: (_prompt, step) =>
        step === 0
          ? {
              action: { type: 'click', ref: refOf(LOGIN, 'Login') },
              envelope: { then: [{ type: 'click', ref: refOf(LOGIN, 'Username') }] },
            }
          : { action: done },
    });

    const result = await runAgent(h.deps, {
      task: 'log in',
      caps: CAPS,
      stepFailures: 3,
      program: 2,
      settle: false,
    });

    expect(result.status).toBe('completed');
    // ONE click reached the browser. The tail never ran.
    expect(h.performed).toEqual([{ type: 'click', ref: refOf(LOGIN, 'Login') }]);
    // Not a failure: the sequence was a bet on the page holding still and the
    // loop is the thing that checks.
    expect(result.steps[0]?.error).toBeUndefined();
    expect(result.steps[0]?.reflex?.chained).toBe(0);
    expect(result.steps[0]?.reflex?.abortReason).toContain('navigated');
    // And the model finds out on the next prompt, or it would act next on a
    // page it believes it has already filled in.
    expect(h.prompts[1]?.text).toContain('rest dropped');
  });

  test('the sequence is clamped, however long the model makes it', async () => {
    const extra = Array.from({ length: 6 }, () => ({
      type: 'fill',
      ref: refOf(LOGIN, 'Password'),
      text: 'x',
    }));
    const h = harness({
      tree: LOGIN,
      model: (_prompt, step) =>
        step === 0
          ? {
              action: { type: 'fill', ref: refOf(LOGIN, 'Username'), text: 'standard_user' },
              envelope: { then: extra },
            }
          : { action: done },
    });

    await runAgent(h.deps, {
      task: 'log in',
      caps: CAPS,
      stepFailures: 3,
      program: 99,
      settle: false,
    });

    expect(h.performed).toHaveLength(1 + MAX_PROGRAM);
  });

  test('a run that did not ask for sequences ignores one it is offered', async () => {
    const h = harness({
      tree: LOGIN,
      model: (_prompt, step) =>
        step === 0
          ? {
              action: { type: 'fill', ref: refOf(LOGIN, 'Username'), text: 'standard_user' },
              envelope: { then: [{ type: 'click', ref: refOf(LOGIN, 'Login') }] },
            }
          : { action: done },
    });

    const result = await runAgent(h.deps, { task: 'log in', caps: CAPS, stepFailures: 3, settle: false });

    expect(h.performed).toHaveLength(1);
    // Nothing paid, nothing recorded, prompt unchanged: a run on neither arm is
    // the run this replaced.
    expect(result.steps[0]?.reflex).toBeUndefined();
    expect(h.prompts[0]?.text).not.toContain('"then"');
  });

  test('the grammar offers the sequence only to a run that enabled it', async () => {
    const h = harness({ tree: LOGIN, model: () => ({ action: done }) });
    await runAgent(h.deps, { task: 'log in', caps: CAPS, stepFailures: 3, program: 2, settle: false });
    expect(h.prompts[0]?.text).toContain('"then"');
    expect(h.prompts[0]?.text).toContain('up to 2 further actions');
    // The rule states the stop condition in the same breath as the affordance.
    expect(h.prompts[0]?.text).toContain('STOPS the moment');
  });
});
