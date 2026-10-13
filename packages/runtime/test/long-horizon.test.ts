/**
 * The long horizon: a plan the model revises, sub-goals that complete
 * independently, a memory that outlives compaction, and caps that bound one
 * sub-goal without bounding the run.
 *
 * Every test here drives the real `runAgent` against the fake browser. None of
 * them asserts on prompt wording — the prompt is going to keep changing, and a
 * test that breaks when a sentence is reworded is a test that will be deleted
 * rather than fixed. They assert on what the loop DID: goal statuses, collected
 * data, stop reasons, page counts, and what the browser was actually asked to do.
 */

import { describe, expect, test } from 'bun:test';

import type { Action } from '../src/actions';
import type { AgentPrompt, ModelChoice } from '../src/loop';
import { compactHistory, PLANNING_STEP_THRESHOLD, runAgent } from '../src/loop';
import { toWireStep } from '../src/result';
import type { StepTrace } from '../src/result';
import { nodeRef, type AxTree } from '../src/snapshot';
import { FractionalClock, harness, node, refOf, tree } from './support';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const CAPS = { steps: 40, budget: '10.00', duration: '10m' } as const;

function storePage(url: string, ...buttons: readonly string[]): AxTree {
  return tree(
    node({
      role: 'RootWebArea',
      name: 'store',
      children: buttons.map((name) => node({ role: 'button', name })),
    }),
    url,
  );
}

/**
 * The same store with a marker that MOVES, for the long compaction runs below.
 *
 * A 30-step run whose page is byte-identical on every read is a stalled run,
 * and `NO_PROGRESS_TOLERANCE` now ends one at 26 reads — correctly. These tests
 * are about compaction and not about stalling, so their scaffolding has to be a
 * run that gets somewhere, which is also what a real 30-step run is.
 */
function movingStore(step: number): AxTree {
  return tree(
    node({
      role: 'RootWebArea',
      name: 'store',
      children: [node({ role: 'button', name: 'Buy' }), node({ role: 'StaticText', name: `item ${String(step)}` })],
    }),
    'https://a.example/',
  );
}

/**
 * A reply exactly as the production client delivers one: the model's whole JSON
 * object forwarded as `action`, envelope fields and all.
 *
 * This shape is the one that matters. A client that split the envelope out into
 * `ModelChoice.envelope` is also supported, but nothing in production does that,
 * so a test suite that only exercised the split path would prove the loop works
 * for a caller that does not exist.
 */
function reply(action: Action, envelope: Record<string, unknown> = {}): ModelChoice {
  return { action: { ...action, ...envelope } as Action };
}

/* ------------------------------------------------------------------ *
 * Plan
 * ------------------------------------------------------------------ */

describe('the plan is stated and revised, not re-derived every step', () => {
  test('a plan stated on the first reply survives, and revision cannot reopen a closed goal', async () => {
    const page = storePage('https://a.example/', 'Buy');
    const seen: AgentPrompt[] = [];
    const h = harness({
      tree: page,
      model: (prompt, step): ModelChoice => {
        seen.push(prompt);
        if (step === 0) {
          return reply(
            { type: 'click', ref: refOf(page, 'Buy') },
            {
              plan: [
                { id: 'g1', goal: 'buy socks', site: 'a.example' },
                { id: 'g2', goal: 'buy a tent', site: 'b.example' },
              ],
            },
          );
        }
        if (step === 1) {
          return reply(
            { type: 'click', ref: refOf(page, 'Buy') },
            { goal: { id: 'g1', status: 'done', summary: 'conf #A1' } },
          );
        }
        // A revision that restates g1 as if it were fresh, reorders, and adds a
        // third goal. g1 must stay closed: a reopened purchase is a second
        // purchase.
        if (step === 2) {
          return reply(
            { type: 'click', ref: refOf(page, 'Buy') },
            {
              plan: [
                { id: 'g2', goal: 'buy a tent', site: 'b.example' },
                { id: 'g3', goal: 'buy a mug', site: 'c.example' },
                { id: 'g1', goal: 'buy socks', site: 'a.example' },
              ],
            },
          );
        }
        return reply(
          { type: 'fail', reason: 'stop here' },
          { goal: { id: 'g2', status: 'failed', summary: 'out of stock' } },
        );
      },
    });

    const result = await runAgent(h.deps, { task: 'buy things', caps: CAPS, stepFailures: 2 });

    const byId = new Map(result.goals.map((goal) => [goal.id, goal]));
    expect(byId.get('g1')?.status).toBe('done');
    expect(byId.get('g1')?.summary).toBe('conf #A1');
    // g3 is ACTIVE rather than pending, and that is the derived-active rule
    // working: the last step closed g2 as failed, g1 was already done, so the
    // first goal that is neither leaves the model pointed at g3 with no field
    // anywhere having been set to say so.
    expect(byId.get('g3')?.status).toBe('active');
    expect(byId.get('g2')?.status).toBe('failed');
    // Order follows the revision, and the closed goal keeps its place in it.
    expect(result.goals.map((goal) => goal.id)).toEqual(['g2', 'g3', 'g1']);
  });

  test('a closed goal the revision omits is still reported: the customer paid for it', async () => {
    const page = storePage('https://a.example/', 'Buy');
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice => {
        if (step === 0) {
          return reply(
            { type: 'click', ref: refOf(page, 'Buy') },
            { plan: [{ id: 'g1', goal: 'buy socks' }, { id: 'g2', goal: 'buy a tent' }] },
          );
        }
        if (step === 1) {
          return reply(
            { type: 'click', ref: refOf(page, 'Buy') },
            { goal: { id: 'g1', status: 'done', summary: 'conf #A1' } },
          );
        }
        // g1 is simply absent from the revision.
        if (step === 2) {
          return reply(
            { type: 'click', ref: refOf(page, 'Buy') },
            { plan: [{ id: 'g2', goal: 'buy a tent' }] },
          );
        }
        return reply({ type: 'fail', reason: 'stop' }, {});
      },
    });

    const result = await runAgent(h.deps, { task: 'buy things', caps: CAPS, stepFailures: 2 });
    const g1 = result.goals.find((goal) => goal.id === 'g1');
    expect(g1?.status).toBe('done');
    expect(g1?.summary).toBe('conf #A1');
  });

  test('the active sub-goal is derived, so it advances the moment one closes', async () => {
    const page = storePage('https://a.example/', 'Buy');
    const activeAt: (string | undefined)[] = [];
    const h = harness({
      tree: page,
      model: (prompt, step): ModelChoice => {
        activeAt.push(prompt.memory?.goals.find((goal) => goal.status === 'active')?.id);
        if (step === 0) {
          return reply(
            { type: 'click', ref: refOf(page, 'Buy') },
            { plan: [{ id: 'g1', goal: 'one' }, { id: 'g2', goal: 'two' }] },
          );
        }
        if (step === 1) {
          return reply(
            { type: 'click', ref: refOf(page, 'Buy') },
            { goal: { id: 'g1', status: 'done', summary: 'ok' } },
          );
        }
        return reply(
          { type: 'fail', reason: 'stop' },
          { goal: { id: 'g2', status: 'failed', summary: 'no' } },
        );
      },
    });

    await runAgent(h.deps, { task: 'two things', caps: CAPS, stepFailures: 2 });
    // Step 0 had no plan yet; step 1 was working g1; step 2 had already moved to g2.
    expect(activeAt).toEqual([undefined, 'g1', 'g2']);
  });
});

/* ------------------------------------------------------------------ *
 * Sub-goal completion
 * ------------------------------------------------------------------ */

describe('five sub-goals are five completions and one report', () => {
  test('done is refused while a sub-goal is open, and the refusal names it', async () => {
    const page = storePage('https://a.example/', 'Buy');
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice => {
        if (step === 0) {
          return reply(
            { type: 'click', ref: refOf(page, 'Buy') },
            { plan: [{ id: 'g1', goal: 'buy socks' }, { id: 'g2', goal: 'buy a tent' }] },
          );
        }
        if (step === 1) {
          // Bought one thing, saw a confirmation, declared the whole task done.
          // This is the single largest long-horizon failure.
          return reply(
            { type: 'done', summary: 'all finished' },
            { goal: { id: 'g1', status: 'done', summary: 'conf #A1' } },
          );
        }
        // Told which goal is open, it closes it honestly and then finishes.
        if (step === 2) {
          return reply(
            { type: 'done', summary: 'one of two' },
            { goal: { id: 'g2', status: 'failed', summary: 'no stock anywhere' } },
          );
        }
        throw new Error('the run should have ended');
      },
    });

    const result = await runAgent(h.deps, { task: 'buy two things', caps: CAPS, stepFailures: 3 });

    expect(result.stopReason).toBe('task-complete');
    // The refusal is a RECORDED step, not a hidden retry.
    expect(result.steps[1]?.error).toContain('done was refused');
    expect(result.steps[1]?.error).toContain('g2');
    expect(result.goals.map((goal) => `${goal.id}:${goal.status}`)).toEqual([
      'g1:done',
      'g2:failed',
    ]);
  });

  test('with no plan, done still ends the run: a single-goal task is unaffected', async () => {
    const page = storePage('https://a.example/', 'Buy');
    const h = harness({
      tree: page,
      model: (): ModelChoice => reply({ type: 'done', summary: 'got it' }),
    });
    const result = await runAgent(h.deps, { task: 'one thing', caps: CAPS, stepFailures: 1 });
    expect(result.stopReason).toBe('task-complete');
    expect(result.goals).toEqual([]);
  });

  /**
   * Production, 7 days to 2026-09-27 14:00Z: 21 runs ENDED on "done was
   * refused: N sub-goal(s) still open" (7 on customer accounts), because each
   * refusal was charged to `stepFailures`. `run_…` (Cambridge
   * Dictionary) answered "2 meanings" at step 4 with four goals open, closed
   * one goal per reply as it was told to, and was failed on the fourth
   * refusal with its answer thrown away.
   */
  test('a model closing one goal per finish is not failed for the refusals it is working through', async () => {
    const page = storePage('https://a.example/', 'Buy');
    const ids = ['g1', 'g2', 'g3', 'g4', 'g5'];
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice =>
        step === 0
          ? reply({ type: 'click', ref: refOf(page, 'Buy') }, { plan: ids.map((id) => ({ id, goal: `errand ${id}` })) })
          : reply({ type: 'done', summary: 'the answer is 2' }, { goal: { id: ids[step - 1], status: 'done', summary: 'ok' } }),
    });

    const result = await runAgent(h.deps, { task: 'five errands', caps: CAPS, stepFailures: 3 });

    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('task-complete');
    expect(result.goals.every((goal) => goal.status === 'done')).toBe(true);
    expect(result.steps.filter((step) => step.error?.includes('done was refused') === true)).toHaveLength(4);
  });

  test('a finish insisted on without closing anything is honoured as partial, with the open goals failed by the loop', async () => {
    const page = storePage('https://a.example/', 'Buy');
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice =>
        step === 0
          ? reply(
              { type: 'click', ref: refOf(page, 'Buy') },
              { plan: [{ id: 'g1', goal: 'find it' }, { id: 'g2', goal: 'count it' }] },
            )
          : reply({ type: 'done', summary: 'the answer is 2' }),
    });

    const result = await runAgent(h.deps, { task: 'two errands', caps: CAPS, stepFailures: 3 });

    // Held a bounded number of times, then the answer is returned rather than
    // thrown away, and the run does not call itself completed — and says why
    // it is partial, in the one field a run's reason travels in.
    expect(result.stopReason).toBe('task-complete');
    expect(result.status).toBe('partial');
    expect(result.error ?? '').toContain('sub-goals of its own plan still open');
    expect(result.data).toBe('the answer is 2');
    expect(result.goals.map((goal) => goal.status)).toEqual(['failed', 'failed']);
    expect(result.steps.filter((step) => step.error?.includes('done was refused') === true)).toHaveLength(3);
  });

  /**
   * Review F2: on a one-string schema (WebVoyager's `{answer: string}`) the
   * honoured finish read the `failed` statuses the LOOP had just written as the
   * model's own "I could not find it", refused to take the summary as the
   * answer, and ended `failed` with no data.
   */
  test('on a one-string schema, the honoured finish returns its summary as the answer, as partial', async () => {
    const page = storePage('https://a.example/', 'Buy');
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice =>
        step === 0
          ? reply(
              { type: 'click', ref: refOf(page, 'Buy') },
              { plan: [{ id: 'g1', goal: 'find it' }, { id: 'g2', goal: 'count it' }, { id: 'g3', goal: 'report it' }] },
            )
          : reply({ type: 'done', summary: 'the answer is 2' }),
    });

    const result = await runAgent(h.deps, {
      task: 'how many meanings',
      schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
      caps: CAPS,
      stepFailures: 3,
    });

    expect(result.status).toBe('partial');
    expect(result.stopReason).toBe('task-complete');
    expect(result.data).toEqual({ answer: 'the answer is 2' });
    expect(result.goals.map((goal) => goal.status)).toEqual(['failed', 'failed', 'failed']);
  });

  test('a plan the model itself closed failed is still its report of not finding the answer', async () => {
    const page = storePage('https://a.example/', 'Buy');
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice =>
        step === 0
          ? reply({ type: 'click', ref: refOf(page, 'Buy') }, { plan: [{ id: 'g1', goal: 'find it' }] })
          : reply(
              { type: 'done', summary: 'the page is behind a captcha' },
              step === 1 ? { goal: { id: 'g1', status: 'failed', summary: 'captcha' } } : {},
            ),
    });

    const result = await runAgent(h.deps, {
      task: 'how many meanings',
      schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
      caps: CAPS,
      stepFailures: 3,
    });

    expect(result.data).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Memory and compaction
 * ------------------------------------------------------------------ */

describe('compaction keeps what a later step needs', () => {
  test('a finding recorded at step 1 is still in the prompt at step 30', async () => {
    let lateFindings: readonly string[] = [];
    let cursor = 0;
    const h = harness({
      tree: movingStore(0),
      snapshot: () => movingStore(cursor),
      model: (prompt, step): ModelChoice => {
        cursor = step + 1;
        if (step === 1) {
          return reply(
            { type: 'click', ref: refOf(prompt.tree, 'Buy') },
            { finding: 'the tent is $289.00 and ships in 3 days' },
          );
        }
        // `>=` and not `===`: this is a 40-step run that never states a plan,
        // so the loop declines its first finish and asks for one. The second
        // `done` is honoured — see `planOwedNotice` for why the demand is made
        // once — which keeps this test about compaction rather than about that.
        if (step >= 30) {
          lateFindings = (prompt.memory?.findings ?? []).map((finding) => finding.text);
          return reply({ type: 'done', summary: 'done' });
        }
        return reply({ type: 'click', ref: refOf(prompt.tree, 'Buy') });
      },
    });

    const result = await runAgent(h.deps, { task: 'compare', caps: CAPS, stepFailures: 1 });

    expect(result.stopReason).toBe('task-complete');
    // Twenty-nine steps later, and the price is still there.
    expect(lateFindings).toEqual(['the tent is $289.00 and ships in 3 days']);
  });

  test('the step that produced a finding is compacted away while the finding is not', async () => {
    let lateText = '';
    let sawOriginalStep = true;
    let cursor = 0;
    const h = harness({
      tree: movingStore(0),
      snapshot: () => movingStore(cursor),
      model: (prompt, step): ModelChoice => {
        cursor = step + 1;
        if (step === 0) {
          return reply(
            { type: 'click', ref: refOf(prompt.tree, 'Buy') },
            { finding: 'coupon code SPRING20 works at checkout' },
          );
        }
        if (step === 25) {
          lateText = prompt.text;
          sawOriginalStep = prompt.text.includes('  0 click');
          return reply({ type: 'done', summary: 'done' });
        }
        return reply({ type: 'click', ref: refOf(prompt.tree, 'Buy') });
      },
    });

    await runAgent(h.deps, { task: 'shop', caps: CAPS, stepFailures: 1 });

    // The verbatim step line is gone...
    expect(sawOriginalStep).toBe(false);
    // ...and what it taught is not. This is the whole point of compaction.
    expect(lateText).toContain('coupon code SPRING20 works at checkout');
  });

  test('compaction keeps each distinct failure once and drops the repeats', () => {
    const steps: StepTrace[] = [];
    for (let i = 0; i < 30; i += 1) {
      steps.push({
        index: i,
        action: { type: 'scroll', dy: 100 },
        cache: { status: 'MISS', reason: 'x' },
        elapsedMs: 1,
        snapshotHash: 'h',
        credits: '0',
        spent: '0',
        pages: 0,
        durationMs: 0,
        bandwidthBytes: 0,
        usage: {},
        at: '2026-09-04T00:00:00.000Z',
        ...(i % 3 === 0 ? { error: 'the quick-buy button 500s' } : {}),
        ...(i === 4 ? { error: 'the size dropdown does not update the price' } : {}),
      });
    }

    const lines = compactHistory(steps, 8).join('\n');
    // The two regions do different jobs, so they are asserted separately: the
    // roll-up dedupes, the verbatim tail deliberately does not.
    const [rolledUp = '', verbatim = ''] = lines.split('Most recent steps:');

    // Eight steps in the compacted region failed the same way; the roll-up says
    // it once. That single line is the whole compression.
    expect(rolledUp.match(/the quick-buy button 500s/g)).toHaveLength(1);
    expect(rolledUp).toContain('the size dropdown does not update the price');
    // Steps 0-21 are compacted: 8 quick-buy failures plus the dropdown one is
    // 9 failed, 13 succeeded. Both numbers are stated so the model can tell
    // "I have been at this a while" from "I just started".
    expect(rolledUp).toContain('13 succeeded, 9 failed');
    // The tail stays verbatim, repeats and all, because its job is stopping an
    // immediate repeat rather than summarising.
    expect(verbatim).toContain('  29 scroll the page by 0,100');
    // The middle is gone from both.
    expect(lines).not.toContain('  12 scroll');
  });

  test('a short history is not compacted at all: nothing to gain, wording to lose', () => {
    const steps: StepTrace[] = [0, 1, 2].map((index) => ({
      index,
      action: { type: 'scroll', dy: 100 },
      cache: { status: 'MISS', reason: 'x' },
      elapsedMs: 1,
      snapshotHash: 'h',
      credits: '0',
      spent: '0',
      pages: 0,
      durationMs: 0,
      bandwidthBytes: 0,
      usage: {},
      at: '2026-09-04T00:00:00.000Z',
    }));
    const lines = compactHistory(steps, 8);
    expect(lines[0]).toBe('Already done:');
    expect(lines).toHaveLength(4);
  });

  test('two clicks on different nodes read as different steps in the history', () => {
    const click = (index: number, backendNodeId: number, description: string): StepTrace => ({
      index,
      action: { type: 'click', ref: nodeRef(1, backendNodeId) },
      observed: { ref: `1-${backendNodeId}`, description, method: 'click', xpath: '' },
      cache: { status: 'MISS', reason: 'x' },
      elapsedMs: 1,
      snapshotHash: 'h',
      credits: '0',
      spent: '0',
      pages: 0,
      durationMs: 0,
      bandwidthBytes: 0,
      usage: {},
      at: '2026-10-13T00:00:00.000Z',
    });
    const [, submitted, loggedOut] = compactHistory(
      [click(0, 232, 'click the button "Submit"'), click(1, 851, 'click the link "Log out"')],
      8,
    );
    expect(submitted).toContain('"Submit"');
    expect(loggedOut).toContain('"Log out"');
  });
});

/* ------------------------------------------------------------------ *
 * Recovery
 * ------------------------------------------------------------------ */

describe('a wrong turn is a state to back out of', () => {
  test('the model records what did not work and the loop keeps telling it', async () => {
    const page = storePage('https://a.example/', 'Quick buy', 'Add to cart');
    let promptAtRetry = '';
    const h = harness({
      tree: page,
      perform: (action): void => {
        if (action.type === 'click' && action.ref?.backendNodeId === refOf(page, 'Quick buy').backendNodeId) {
          throw new Error('quick buy returned 500');
        }
      },
      model: (prompt, step): ModelChoice => {
        if (step === 0 || step === 1) {
          return reply({ type: 'click', ref: refOf(page, 'Quick buy') });
        }
        if (step === 2) {
          return reply(
            { type: 'click', ref: refOf(page, 'Add to cart') },
            { ruledOut: 'quick buy 500s, use the normal cart flow' },
          );
        }
        promptAtRetry = prompt.text;
        return reply({ type: 'done', summary: 'bought it the other way' });
      },
    });

    const result = await runAgent(h.deps, { task: 'buy it', caps: CAPS, stepFailures: 3 });

    expect(result.stopReason).toBe('task-complete');
    // Both wrong turns are recorded, not hidden.
    expect(result.steps[0]?.error).toContain('quick buy returned 500');
    expect(result.steps[1]?.error).toContain('quick buy returned 500');
    // And the dead end is carried forward as an instruction, not as two log lines.
    expect(promptAtRetry).toContain('quick buy 500s, use the normal cart flow');
    expect(promptAtRetry).toContain('Already ruled out');
  });

  test('a ruled-out note survives past the compaction window that eats its step', async () => {
    const page = storePage('https://a.example/', 'Buy');
    let lateText = '';
    const h = harness({
      tree: page,
      model: (prompt, step): ModelChoice => {
        if (step === 0) {
          return reply(
            { type: 'click', ref: refOf(page, 'Buy') },
            { ruledOut: 'site search returns nothing for multi-word titles' },
          );
        }
        if (step === 20) {
          lateText = prompt.text;
          return reply({ type: 'done', summary: 'done' });
        }
        return reply({ type: 'click', ref: refOf(page, 'Buy') });
      },
    });

    await runAgent(h.deps, { task: 'find a book', caps: CAPS, stepFailures: 1 });
    expect(lateText).toContain('site search returns nothing for multi-word titles');
  });
});

/* ------------------------------------------------------------------ *
 * Per-sub-goal caps
 * ------------------------------------------------------------------ */

describe('one stuck sub-goal does not eat the budget for the others', () => {
  test('a goal that spends its share is closed and the run moves to the next', async () => {
    const page = storePage('https://a.example/', 'Buy');
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice => {
        if (step === 0) {
          return reply(
            { type: 'click', ref: refOf(page, 'Buy') },
            {
              plan: [
                { id: 'g1', goal: 'the stuck one' },
                { id: 'g2', goal: 'the reachable one' },
              ],
            },
          );
        }
        // g1 never closes. Without per-goal caps this spends the whole run.
        const active = _prompt.memory?.goals.find((goal) => goal.status === 'active')?.id;
        if (active === 'g2') {
          return reply(
            { type: 'done', summary: 'did the second one' },
            { goal: { id: 'g2', status: 'done', summary: 'conf #B2' } },
          );
        }
        return reply({ type: 'click', ref: refOf(page, 'Buy') });
      },
    });

    const result = await runAgent(h.deps, {
      task: 'two things',
      caps: { steps: 20, budget: '10.00', duration: '10m' },
      stepFailures: 3,
      goalCaps: { kind: 'share' },
    });

    const byId = new Map(result.goals.map((goal) => [goal.id, goal]));
    expect(byId.get('g1')?.status).toBe('failed');
    expect(byId.get('g1')?.summary).toBe('goal-cap:steps');
    // The point: the second goal was reached and completed.
    expect(byId.get('g2')?.status).toBe('done');
    expect(result.stopReason).toBe('task-complete');
    // And the RUN cap never fired: the run stopped because it finished.
    expect(result.cappedBy).toBeUndefined();
  });

  test('per-goal shares never sum past the run ceiling', async () => {
    const page = storePage('https://a.example/', 'Buy');
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice =>
        step === 0
          ? reply(
              { type: 'click', ref: refOf(page, 'Buy') },
              {
                plan: [
                  { id: 'g1', goal: 'one' },
                  { id: 'g2', goal: 'two' },
                  { id: 'g3', goal: 'three' },
                ],
              },
            )
          : reply({ type: 'click', ref: refOf(page, 'Buy') }),
    });

    const result = await runAgent(h.deps, {
      task: 'three stuck things',
      caps: { steps: 12, budget: '10.00', duration: '10m' },
      stepFailures: 3,
      goalCaps: { kind: 'share' },
    });

    // The property under test is that the shares are bounded BY the run cap,
    // not that they exhaust it. With 12 steps and 3 goals each share is 4, so
    // two goals burn theirs and the RUN cap fires during the third — the run
    // never runs 3 x 12. A per-goal ceiling may only ever stop a goal sooner
    // than the run would have.
    expect(result.stepsUsed).toBeLessThanOrEqual(12);
    expect(result.cappedBy).toBe('steps');
    const cappedGoals = result.goals.filter((goal) => goal.summary === 'goal-cap:steps');
    expect(cappedGoals.map((goal) => goal.id)).toEqual(['g1', 'g2']);
    // The third was reached and was still working when the run ended, which is
    // the difference from today: it would never have been started at all.
    expect(result.goals.find((goal) => goal.id === 'g3')?.status).toBe('active');
  });

  test('a budget share is enforced without dividing money', async () => {
    const page = storePage('https://a.example/', 'Buy');
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice =>
        step === 0
          ? reply(
              { type: 'click', ref: refOf(page, 'Buy') },
              { plan: [{ id: 'g1', goal: 'one' }, { id: 'g2', goal: 'two' }] },
            )
          : reply({ type: 'click', ref: refOf(page, 'Buy') }),
      // Every click costs a credit: an expensive action the browser reports.
      perform: () => ({ credits: '1.00' }),
    });

    const result = await runAgent(h.deps, {
      task: 'two expensive things',
      caps: { steps: 40, budget: '4.00', duration: '10m' },
      stepFailures: 3,
      goalCaps: { kind: 'share' },
    });

    const g1 = result.goals.find((goal) => goal.id === 'g1');
    expect(g1?.summary).toBe('goal-cap:budget');
    // Half of the remaining 4.00 is 2.00, so g1 stops there rather than at 4.00.
    expect(Number(result.steps.filter((step) => step.goal === 'g1').length)).toBeLessThanOrEqual(3);
  });

  test('more sub-goals than the run has steps still terminates and still tries some', async () => {
    // The share floor is Math.max(1, ...): without it, ten goals over five steps
    // gives every goal a ceiling of zero, so each trips before taking a step and
    // the loop closes all ten having attempted none — strictly worse than today,
    // where at least the first few get a go. This also pins that the close-and-
    // continue path cannot spin: it advances without counting a step.
    const page = storePage('https://a.example/', 'Buy');
    const plan = Array.from({ length: 10 }, (_unused, i) => ({
      id: `g${String(i + 1)}`,
      goal: `thing ${String(i + 1)}`,
    }));
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice =>
        step === 0
          ? reply({ type: 'click', ref: refOf(page, 'Buy') }, { plan })
          : reply({ type: 'click', ref: refOf(page, 'Buy') }),
    });

    const result = await runAgent(h.deps, {
      task: 'ten things, five steps',
      caps: { steps: 5, budget: '10.00', duration: '10m' },
      stepFailures: 5,
      goalCaps: { kind: 'share' },
    });

    expect(result.cappedBy).toBe('steps');
    expect(result.stepsUsed).toBe(5);
    // The property the floor protects: goals are ATTEMPTED, not mass-closed.
    // With a floor of zero every one of the ten trips before taking a step, so
    // all ten come back failed having never been tried — and the run then burns
    // its five steps with no active goal at all. Asserting "some step had a
    // goal" would NOT catch that, because step 0 is where the plan is stated and
    // carries g1 either way. What differs is how many survive.
    const closed = result.goals.filter(
      (goal) => goal.status === 'done' || goal.status === 'failed',
    );
    expect(closed.length).toBeLessThan(10);
    expect(result.goals.some((goal) => goal.status === 'pending')).toBe(true);
    // And more than one goal actually got worked inside the five steps.
    expect(new Set(result.steps.map((step) => step.goal)).size).toBeGreaterThan(1);
  });

  test('with no goalCaps the run behaves exactly as it always did', async () => {
    const page = storePage('https://a.example/', 'Buy');
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice =>
        step === 0
          ? reply(
              { type: 'click', ref: refOf(page, 'Buy') },
              { plan: [{ id: 'g1', goal: 'one' }, { id: 'g2', goal: 'two' }] },
            )
          : reply({ type: 'click', ref: refOf(page, 'Buy') }),
    });

    const result = await runAgent(h.deps, {
      task: 'two things',
      caps: { steps: 6, budget: '10.00', duration: '10m' },
      stepFailures: 3,
    });

    // No goal was closed by a cap; the RUN cap is what stopped it.
    expect(result.goals.every((goal) => goal.summary === undefined)).toBe(true);
    expect(result.cappedBy).toBe('steps');
  });
});

/* ------------------------------------------------------------------ *
 * Tabs and pages
 * ------------------------------------------------------------------ */

describe('more than one page', () => {
  test('the model opens, works and closes tabs, and the browser really moved', async () => {
    const trees: Record<string, AxTree> = {
      t1: storePage('https://a.example/', 'Buy'),
      t2: storePage('https://b.example/', 'Order'),
    };
    const h = harness({
      tabs: [{ id: 't1', url: 'https://a.example/' }],
      tabTree: (id) => trees[id] ?? trees['t1']!,
      model: (_prompt, step): ModelChoice => {
        if (step === 0) return reply({ type: 'openTab', url: 'https://b.example/' });
        if (step === 1) return reply({ type: 'click', ref: refOf(trees['t2']!, 'Order') });
        if (step === 2) return reply({ type: 'focusTab', tab: 't1' });
        if (step === 3) return reply({ type: 'closeTab', tab: 't2' });
        return reply({ type: 'done', summary: 'compared both' });
      },
    });

    const result = await runAgent(h.deps, { task: 'compare two sites', caps: CAPS, stepFailures: 0 });

    expect(result.stopReason).toBe('task-complete');
    expect(h.tabState.open.map((tab) => tab.id)).toEqual(['t1']);
    expect(h.tabState.active).toBe('t1');
    // Every step names the tab it ran on, which is what makes a replay honest.
    expect(result.steps[1]?.tab).toBe('t2');
    expect(result.steps[4]?.tab).toBe('t1');

    // The tab must CROSS THE WIRE, not merely exist in the trace. A replay
    // player and an external scorer both read `AgentStep`, and neither can tell
    // which origin a step acted on once focus moves between tabs unless this
    // field arrives with it. `openTab` carries the URL in its description, so
    // the pair is enough to attribute every later step to an origin.
    const wire = result.steps.map(toWireStep);
    expect(wire[1]?.tab).toBe('t2');
    expect(wire[0]?.action.description).toContain('https://b.example/');
    expect(wire[0]?.tab).toBe('t2');
  });

  test('a tab action with no tab control is refused, not silently ignored', async () => {
    const page = storePage('https://a.example/', 'Buy');
    const h = harness({
      tree: page,
      model: (): ModelChoice => reply({ type: 'openTab', url: 'https://b.example/' }),
    });

    const result = await runAgent(h.deps, { task: 'open a tab', caps: CAPS, stepFailures: null });

    expect(result.stopReason).toBe('error');
    expect(result.steps[0]?.error).toContain('needs tab control');
  });

});

/* ------------------------------------------------------------------ *
 * Guarantees that must survive all of the above
 * ------------------------------------------------------------------ */

describe('the existing guarantees still hold', () => {
  test('durationMs is an integer even when the clock is not', async () => {
    // Every other fake clock in this repo advances by whole numbers, which is
    // why a fractional durationMs reached production and 500'd every agent run.
    const clock = new FractionalClock();
    const page = storePage('https://a.example/', 'Buy');
    const h = harness({
      tree: page,
      clock,
      model: (_prompt, step): ModelChoice => {
        clock.tick(3);
        return step === 0
          ? reply({ type: 'click', ref: refOf(page, 'Buy') })
          : reply({ type: 'done', summary: 'done' });
      },
    });

    const result = await runAgent(h.deps, { task: 'x', caps: CAPS, stepFailures: 0 });
    expect(Number.isInteger(result.durationMs)).toBe(true);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  test('the page stays frozen across think and act on every step of a planned run', async () => {
    const page = storePage('https://a.example/', 'Buy');
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice =>
        step === 0
          ? reply(
              { type: 'click', ref: refOf(page, 'Buy') },
              { plan: [{ id: 'g1', goal: 'one' }], finding: 'a price' },
            )
          : reply(
              { type: 'done', summary: 'done' },
              { goal: { id: 'g1', status: 'done', summary: 'ok' } },
            ),
    });

    // `settle: false`: `liveTouches` is the assertion, and the settle polls a
    // LIVE page on purpose — a frozen page cannot render. What this test is for
    // is that THINK and ACT never touch one, which is unchanged.
    await runAgent(h.deps, { task: 'x', caps: CAPS, stepFailures: 0, settle: false });
    expect(h.browser.liveTouches).toBe(0);
    expect(h.balance.acquired).toBe(h.balance.released);
  });

  test('a malformed envelope loses the note, never the action', async () => {
    const page = storePage('https://a.example/', 'Buy');
    const seen: AgentPrompt[] = [];
    const h = harness({
      tree: page,
      model: (prompt, step): ModelChoice => {
        seen.push(prompt);
        return step === 0
          ? reply({ type: 'click', ref: refOf(page, 'Buy') }, {
              plan: 'not an array',
              finding: '',
              goal: { id: 'g1', status: 'maybe' },
            })
          : reply({ type: 'done', summary: 'done' });
      },
    });

    const result = await runAgent(h.deps, { task: 'x', caps: CAPS, stepFailures: 0 });
    // The action ran and the step is not an error: a bad note must not cost a
    // step the customer already paid for.
    expect(result.steps[0]?.error).toBeUndefined();
    expect(h.performed[0]?.type).toBe('click');
    expect(result.goals).toEqual([]);
    // The empty finding is DROPPED, not stored. A model that emits the field
    // because the grammar showed it has not made a finding, and storing it
    // would print a blank bullet in every remaining prompt of the run.
    expect(seen[1]?.memory?.findings ?? []).toEqual([]);
    expect(seen[1]?.text).not.toContain('Found so far');
  });

  test('an envelope split out by the client also works, and wins over the raw object', async () => {
    const page = storePage('https://a.example/', 'Buy');
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice =>
        step === 0
          ? {
              action: { type: 'click', ref: refOf(page, 'Buy') },
              envelope: { plan: [{ id: 'split', goal: 'from the envelope field' }] },
            }
          : reply(
              { type: 'done', summary: 'done' },
              { goal: { id: 'split', status: 'done', summary: 'ok' } },
            ),
    });

    const result = await runAgent(h.deps, { task: 'x', caps: CAPS, stepFailures: 0 });
    expect(result.goals[0]?.id).toBe('split');
    expect(result.goals[0]?.status).toBe('done');
  });
});

/* ------------------------------------------------------------------ *
 * The prompt is the deliverable: state the model cannot see does nothing
 * ------------------------------------------------------------------ */

describe('the plan and the memory are actually rendered to the model', () => {
  test('the plan block reaches the prompt with every sub-goal and its status', async () => {
    // Without this the whole feature can be inert while every state-machine
    // test above stays green: the loop would track a perfect plan and never
    // show it to the model, which is a plan that changes no behaviour at all.
    const page = storePage('https://a.example/', 'Buy');
    let text = '';
    const h = harness({
      tree: page,
      model: (prompt, step): ModelChoice => {
        text = prompt.text;
        if (step === 0) {
          return reply(
            { type: 'click', ref: refOf(page, 'Buy') },
            {
              plan: [
                { id: 'g1', goal: 'buy socks', site: 'a.example' },
                { id: 'g2', goal: 'buy a tent', site: 'b.example' },
              ],
              finding: 'socks are 12.99',
            },
          );
        }
        if (step === 1) {
          return reply(
            { type: 'click', ref: refOf(page, 'Buy') },
            { goal: { id: 'g1', status: 'done', summary: 'conf #A1' } },
          );
        }
        return reply(
          { type: 'done', summary: 'stop' },
          { goal: { id: 'g2', status: 'failed', summary: 'no stock' } },
        );
      },
    });

    await runAgent(h.deps, { task: 'buy two things', caps: CAPS, stepFailures: 2 });

    // The last prompt the model saw carried the whole plan, with the closed
    // goal's outcome and the active marker it is told to work from.
    expect(text).toContain('Plan:');
    expect(text).toContain('g1 [done] buy socks (a.example) -> conf #A1');
    expect(text).toContain('g2 [active] buy a tent (b.example)');
    expect(text).toContain('Sub-goal rules');
    expect(text).toContain('Work the ACTIVE sub-goal only');
    // And the finding, which is the only surviving record of a page long gone.
    expect(text).toContain('socks are 12.99');
  });

  test('the sub-goal step allowance is shown, so a per-goal cap is not a surprise', async () => {
    const page = storePage('https://a.example/', 'Buy');
    let text = '';
    const h = harness({
      tree: page,
      model: (prompt, step): ModelChoice => {
        text = prompt.text;
        return step === 0
          ? reply(
              { type: 'click', ref: refOf(page, 'Buy') },
              { plan: [{ id: 'g1', goal: 'one' }, { id: 'g2', goal: 'two' }] },
            )
          : reply({ type: 'click', ref: refOf(page, 'Buy') });
      },
    });

    await runAgent(h.deps, {
      task: 'two things',
      caps: { steps: 20, budget: '10.00', duration: '10m' },
      stepFailures: 5,
      goalCaps: { kind: 'share' },
    });

    expect(text).toMatch(/This sub-goal has used \d+ of its \d+ steps/);
  });
});

/* ------------------------------------------------------------------ *
 * Token economics
 * ------------------------------------------------------------------ */

describe('a short run does not pay for long-horizon machinery', () => {
  test('no plan and no findings means no plan block and no sub-goal rules', async () => {
    const page = storePage('https://a.example/', 'Buy');
    let text = '';
    const h = harness({
      tree: page,
      model: (prompt): ModelChoice => {
        text = prompt.text;
        return reply({ type: 'done', summary: 'done' });
      },
    });

    await runAgent(h.deps, { task: 'list the books', caps: CAPS, stepFailures: 0 });

    expect(text).not.toContain('Sub-goal rules');
    expect(text).not.toContain('Plan:');
    expect(text).not.toContain('Found so far');
    expect(text).not.toContain('openTab');
  });

  test('a run whose caps cannot fund a plan is not taught to plan', async () => {
    const page = storePage('https://a.example/', 'Buy');
    let text = '';
    const h = harness({
      tree: page,
      model: (prompt): ModelChoice => {
        text = prompt.text;
        return reply({ type: 'done', summary: 'done' });
      },
    });

    await runAgent(h.deps, {
      task: 'list the books',
      caps: { steps: 6, budget: '1.00', duration: '2m' },
      stepFailures: 0,
    });

    // Six steps cannot complete two sub-goals, so the planning affordance would
    // be teaching a capability the caller's own caps forbid.
    expect(text).not.toContain('"plan":[');
    // The finding affordance IS offered: it pays for itself on a three-step run.
    expect(text).toContain('"finding"');
  });

  test('tab grammar appears only when tab control is bound', async () => {
    const page = storePage('https://a.example/', 'Buy');
    let withTabs = '';
    const h = harness({
      tabs: [{ id: 't1', url: 'https://a.example/' }],
      tabTree: () => page,
      model: (prompt): ModelChoice => {
        withTabs = prompt.text;
        return reply({ type: 'done', summary: 'done' });
      },
    });

    await runAgent(h.deps, { task: 'x', caps: CAPS, stepFailures: 0 });
    expect(withTabs).toContain('"type":"openTab"');
    expect(withTabs).toContain('Open tabs:');
  });
});

/* ------------------------------------------------------------------ *
 * The unearned finish
 * ------------------------------------------------------------------ */

/** Four required fields, the shape of the eval's three-site errand task. */
const FOUR_FIELDS = {
  type: 'object',
  properties: {
    cheapestTravelBook: { type: 'string' },
    cheapestTravelPrice: { type: 'string' },
    backpackPrice: { type: 'string' },
    firstQuoteAuthor: { type: 'string' },
  },
  required: [
    'cheapestTravelBook',
    'cheapestTravelPrice',
    'backpackPrice',
    'firstQuoteAuthor',
  ],
  additionalProperties: false,
} as const;

/**
 * Every required field at once, from one `extract`. What was measured.
 *
 * Every value ANSWERS, and that matters to every test below: the loop's other
 * gate on a satisfied schema refuses to stop on a field that validates and says
 * nothing (`VACUOUS_HOLD_TOLERANCE`), so a fixture with `"unknown"` in it would
 * make every step count here the sum of two mechanisms. The measured production
 * failure was that ONE extract returned all four required fields and the loop
 * called the whole plan finished — which is what these tests are about, and it
 * reproduces on data that is not a non-answer. The vacuity gate is measured on
 * its own fixture in `loop.test.ts`.
 */
const ALL_FOUR = {
  cheapestTravelBook: 'The Road to Little Dribbling',
  cheapestTravelPrice: '£23.21',
  backpackPrice: '£41.00',
  firstQuoteAuthor: 'Albert Einstein',
};

describe('a finish has to be earned, whoever claims it', () => {
  test('schema satisfaction does not end a run whose sub-goals are open', async () => {
    // The measured production failure, on a run that did everything the
    // planning rules asked: a plan is stated on step 0, then one `extract`
    // returns all four required fields. Before this, the loop stopped
    // `completed` on step 1 with three sub-goals open — the model never claimed
    // to have finished and the loop claimed it for it.
    const page = storePage('https://a.example/', 'Buy');
    const h = harness({
      tree: page,
      extract: () => ({ data: ALL_FOUR }),
      model: (_prompt, step): ModelChoice =>
        step === 0
          ? reply(
              { type: 'extract', instruction: 'all three errands', final: true },
              {
                plan: [
                  { id: 'g1', goal: 'cheapest travel book' },
                  { id: 'g2', goal: 'backpack price' },
                  { id: 'g3', goal: 'first quote author' },
                ],
              },
            )
          : reply({ type: 'extract', instruction: 'all three errands', final: true }),
    });

    const result = await runAgent(h.deps, {
      task: 'three errands on three sites',
      caps: { steps: 12, budget: '10.00', duration: '10m' },
      stepFailures: 3,
      schema: FOUR_FIELDS,
    });

    // It did not stop on the FIRST satisfaction, which is the whole defect: one
    // `extract` on step 1 used to end the run `completed` with three sub-goals
    // open. It is held instead.
    expect(result.stepsUsed).toBeGreaterThan(1);
    // And nothing the model never closed is reported as `done`. The loop closes
    // an abandoned sub-goal `failed` and says why; it never closes one for the
    // model in its favour.
    expect(result.goals.filter((goal) => goal.status === 'done')).toHaveLength(0);
    expect(result.goals.map((goal) => goal.status)).toEqual(['failed', 'failed', 'failed']);
    expect(result.goals[0]?.summary).toContain('never closed');
    // Not discarded. The run is still judged on what it collected — the point
    // is that it stops claiming every sub-goal finished, not that it stops
    // being seen.
    expect(result.data).toEqual(ALL_FOUR);
  });

  test('holding a finished answer open does not spend the run ceiling', async () => {
    // The defect this bound exists for, measured within the hour of the hold
    // being written: the hold was unbounded, so a model that stated a plan and
    // then closed nothing burned its entire ceiling and reported `capped`.
    //
    // Reproduced in-process, and stated that way deliberately. It was first
    // reported as the cause of the eval's `multipage` row capping at 16 of 16,
    // and that attribution was wrong: `multipage` never satisfies its schema, so
    // it cannot reach the hold at all, and it capped before any of this existed.
    // The defect is real and the evidence for it is this test, not that row.
    const page = storePage('https://a.example/', 'Buy');
    const notices: (string | undefined)[] = [];
    const texts: string[] = [];
    const h = harness({
      tree: page,
      extract: () => ({ data: ALL_FOUR }),
      model: (prompt, step): ModelChoice => {
        notices.push(prompt.notice);
        texts.push(prompt.text);
        return step === 0
          ? reply(
              { type: 'extract', instruction: 'all three errands', final: true },
              {
                plan: [
                  { id: 'g1', goal: 'cheapest travel book' },
                  { id: 'g2', goal: 'backpack price' },
                ],
              },
            )
          : reply({ type: 'extract', instruction: 'all three errands', final: true });
      },
    });

    const result = await runAgent(h.deps, {
      task: 'two errands',
      caps: { steps: 40, budget: '10.00', duration: '10m' },
      stepFailures: 3,
      schema: FOUR_FIELDS,
    });

    // Ends on its own, nowhere near the ceiling, rather than at step 40 of 40.
    expect(result.stopReason).toBe('schema-satisfied');
    expect(result.cappedBy).toBeUndefined();
    expect(result.stepsUsed).toBeLessThan(10);
    // And the report says what happened rather than claiming both errands.
    expect(result.goals.map((goal) => goal.status)).toEqual(['failed', 'failed']);
    // And it does NOT call itself completed. A `completed` beside a plan that
    // records two abandoned errands is a result that contradicts itself, and
    // both halves are now on the wire for a customer to read.
    expect(result.status).toBe('partial');
    // And a held run is TOLD it is being held, in the rendered prompt. A hold
    // the model cannot see is a run that stalls for no reason it can act on:
    // closing a sub-goal costs no step, but only if it knows one is open.
    expect(notices[0]).toBeUndefined();
    expect(notices[1]).not.toBeUndefined();
    expect(texts[1]).toContain(notices[1]);
  });

  test('the demand is dropped the moment it is answered, not carried for the rest of the run', async () => {
    // No schema here, deliberately: with nothing to satisfy there is no hold to
    // overwrite the notice, so a demand that is not explicitly cleared when the
    // plan arrives would ride every remaining prompt — telling a run that HAS a
    // plan that it has never stated one, and charging it ~146 tokens a step to
    // read that.
    //
    // Filler clicks for the first `PLANNING_STEP_THRESHOLD` steps: the decline
    // is gated on steps ACTUALLY TAKEN, not merely permitted by the ceiling —
    // see the explicit `done` decline's own comment in `loop.ts` — so a `done`
    // attempted before the run has taken that many steps is not the
    // population this test is about.
    const page = storePage('https://a.example/', 'Buy');
    const notices: (string | undefined)[] = [];
    const h = harness({
      tree: page,
      model: (prompt, step): ModelChoice => {
        notices.push(prompt.notice);
        if (step < PLANNING_STEP_THRESHOLD) {
          return reply({ type: 'click', ref: refOf(page, 'Buy') });
        }
        if (step === PLANNING_STEP_THRESHOLD) {
          return reply({ type: 'done', summary: 'finished' });
        }
        if (step === PLANNING_STEP_THRESHOLD + 1) {
          return reply(
            { type: 'click', ref: refOf(page, 'Buy') },
            { plan: [{ id: 'g1', goal: 'the only outcome' }] },
          );
        }
        return reply(
          { type: 'done', summary: 'finished' },
          { goal: { id: 'g1', status: 'done', summary: 'did it' } },
        );
      },
    });

    const result = await runAgent(h.deps, {
      task: 'one thing',
      caps: { steps: 40, budget: '10.00', duration: '10m' },
      stepFailures: 3,
    });

    // Asked the step after the decline, answered the step after that, gone
    // the step after THAT.
    expect(notices[PLANNING_STEP_THRESHOLD + 1]).not.toBeUndefined();
    expect(notices[PLANNING_STEP_THRESHOLD + 2]).toBeUndefined();
    expect(result.stopReason).toBe('task-complete');
    expect(result.goals.map((goal) => goal.status)).toEqual(['done']);
  });

  test('closing a sub-goal buys the run more room, so real work is never cut off', async () => {
    // Why the bound counts CLOSURES and not steps. A run working through its
    // errands closes one, gets its allowance back, closes the next — so the
    // number of sub-goals a run may complete under a hold is unbounded, and only
    // a run that closes nothing is stopped. The hold is only ever proposed by an
    // extraction that answers, so each step here records the answer again.
    const page = storePage('https://a.example/', 'Buy');
    const h = harness({
      tree: page,
      extract: () => ({ data: ALL_FOUR }),
      model: (_prompt, step): ModelChoice => {
        if (step === 0) {
          return reply(
            { type: 'extract', instruction: 'errands', final: true },
            {
              plan: [
                { id: 'g1', goal: 'one' },
                { id: 'g2', goal: 'two' },
                { id: 'g3', goal: 'three' },
                { id: 'g4', goal: 'four' },
                { id: 'g5', goal: 'five' },
              ],
            },
          );
        }
        // One closure per step, five in a row — more steps under the hold than
        // SCHEMA_HOLD_TOLERANCE would allow if the bound counted steps.
        return reply(
          { type: 'extract', instruction: 'errands', final: true },
          { goal: { id: `g${String(step)}`, status: 'done', summary: `did g${String(step)}` } },
        );
      },
    });

    const result = await runAgent(h.deps, {
      task: 'five errands',
      caps: { steps: 40, budget: '10.00', duration: '10m' },
      stepFailures: 3,
      schema: FOUR_FIELDS,
    });

    expect(result.stopReason).toBe('schema-satisfied');
    // All five closed BY THE MODEL, none by the loop giving up on it.
    expect(result.goals.map((goal) => goal.status)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
    ]);
    expect(result.stepsUsed).toBe(6);
  });

  test('closing every sub-goal honestly is still an exit', async () => {
    // The other half, and the reason the rule above cannot deadlock: the model
    // that cannot do errands two and three says so, and the run ends.
    const page = storePage('https://a.example/', 'Buy');
    const h = harness({
      tree: page,
      extract: () => ({ data: ALL_FOUR }),
      model: (_prompt, step): ModelChoice => {
        if (step === 0) {
          return reply(
            { type: 'extract', instruction: 'errand one', final: true },
            {
              plan: [
                { id: 'g1', goal: 'cheapest travel book' },
                { id: 'g2', goal: 'backpack price' },
              ],
            },
          );
        }
        if (step === 1) {
          return reply(
            { type: 'extract', instruction: 'errand one', final: true },
            { goal: { id: 'g1', status: 'done', summary: 'got it' } },
          );
        }
        return reply(
          { type: 'extract', instruction: 'errand one', final: true },
          { goal: { id: 'g2', status: 'failed', summary: 'login refused' } },
        );
      },
    });

    const result = await runAgent(h.deps, {
      task: 'two errands',
      caps: { steps: 12, budget: '10.00', duration: '10m' },
      stepFailures: 3,
      schema: FOUR_FIELDS,
    });

    expect(result.stopReason).toBe('schema-satisfied');
    expect(result.stepsUsed).toBe(3);
    expect(result.goals.map((goal) => goal.status)).toEqual(['done', 'failed']);
  });

  test('a multi-outcome run that volunteered no plan is asked for one before it may finish', async () => {
    // The population the whole change exists for: the affordance was offered
    // and declined, so the terminal rules were never armed. The loop cannot
    // read the task text, so it does not guess — it declines the finish and
    // asks, and the answer arms everything else.
    const page = storePage('https://a.example/', 'Buy');
    const notices: (string | undefined)[] = [];
    const texts: string[] = [];
    const h = harness({
      tree: page,
      extract: () => ({ data: ALL_FOUR }),
      model: (prompt, step): ModelChoice => {
        notices.push(prompt.notice);
        texts.push(prompt.text);
        // Step 0 fills every required field from one page and states nothing.
        if (step === 0) {
          return reply({ type: 'extract', instruction: 'all of it', final: true });
        }
        // Asked, it answers — and is now under the sub-goal rules for the rest
        // of the run, which is what it had opted itself out of.
        if (step === 1) {
          return reply(
            { type: 'click', ref: refOf(page, 'Buy') },
            {
              plan: [
                { id: 'g1', goal: 'cheapest travel book' },
                { id: 'g2', goal: 'backpack price' },
                { id: 'g3', goal: 'first quote author' },
              ],
            },
          );
        }
        // And a premature `done` is now refused, which it was not before.
        return reply({ type: 'done', summary: 'all finished' });
      },
    });

    const result = await runAgent(h.deps, {
      task: 'three errands on three sites',
      caps: { steps: 20, budget: '10.00', duration: '10m' },
      stepFailures: 3,
      schema: FOUR_FIELDS,
    });

    // Step 0 saw no notice; step 1 was asked. Structural, not wording: the
    // sentence will be reworded and this test should not care.
    expect(notices[0]).toBeUndefined();
    expect(notices[1]).not.toBeUndefined();
    // And it reached the model, not just the prompt object. Asserted as
    // plumbing rather than as a sentence: a demand the loop records and never
    // renders is a demand nothing can answer.
    expect(texts[1]).toContain(notices[1]);
    // Answered on step 1, so the PLAN demand is not made again. Step 2 does
    // carry a notice — the run now has three open sub-goals and a satisfied
    // schema, which is a different demand — so this asserts the two are not the
    // same string rather than that the field is empty.
    expect(notices[2]).not.toBe(notices[1]);
    expect(result.stopReason).not.toBe('schema-satisfied');
    expect(result.steps.some((step) => step.error?.includes('done was refused') === true)).toBe(
      true,
    );
  });

  test('the demand is made once, so it can never strand a run that will not plan', async () => {
    // The bound on the whole mechanism. A model that ignores the demand loses
    // exactly one step and then finishes, so the worst case this change can
    // cost a run is one step — never a cap, never an error.
    const page = storePage('https://a.example/', 'Buy');
    const h = harness({
      tree: page,
      extract: () => ({ data: ALL_FOUR }),
      model: (): ModelChoice => reply({ type: 'extract', instruction: 'all of it', final: true }),
    });

    const result = await runAgent(h.deps, {
      task: 'three errands on three sites',
      caps: { steps: 40, budget: '10.00', duration: '10m' },
      stepFailures: 3,
      schema: FOUR_FIELDS,
    });

    expect(result.stopReason).toBe('schema-satisfied');
    expect(result.stepsUsed).toBe(2);
  });

  test('declining a finish does not spend a caller failure tolerance of zero', async () => {
    // The reason a decline is not routed through the step-failure channel. A
    // caller who tolerates no failed step has a correct single-outcome run, and
    // turning it into `status: failed` would be a worse defect than the one
    // being fixed.
    //
    // Filler clicks before the threshold, on the same reasoning as the first
    // test in this block.
    const page = storePage('https://a.example/', 'Buy');
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice =>
        step < PLANNING_STEP_THRESHOLD
          ? reply({ type: 'click', ref: refOf(page, 'Buy') })
          : reply({ type: 'done', summary: 'done' }),
    });

    const result = await runAgent(h.deps, {
      task: 'one thing',
      caps: { steps: 40, budget: '10.00', duration: '10m' },
      stepFailures: 0,
    });

    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('task-complete');
    // `PLANNING_STEP_THRESHOLD` filler clicks, the declined `done`, and the
    // `done` that lands: none of the filler is a failure and neither is the
    // decline, so `stepFailures: 0` never sees a single one of them.
    expect(result.stepsUsed).toBe(PLANNING_STEP_THRESHOLD + 2);
    expect(result.error).toBeUndefined();
  });

  test('an empty plan does not settle the demand', async () => {
    // `"plan":[]` states nothing about the shape of the task, so it must not
    // buy the finish that stating a plan buys.
    //
    // Driven through `ModelChoice.envelope` and NOT through the raw action,
    // because that is the only path on which an empty plan is reachable:
    // `parsePlan` already returns `undefined` for a list with no usable entry,
    // so the raw-reply path — the one production uses — cannot produce this at
    // all. `envelope` is taken as given and unvalidated, which is where the
    // free ride would be.
    const page = storePage('https://a.example/', 'Buy');
    const notices: (string | undefined)[] = [];
    const h = harness({
      tree: page,
      model: (prompt, step): ModelChoice => {
        notices.push(prompt.notice);
        if (step < PLANNING_STEP_THRESHOLD) {
          return reply({ type: 'click', ref: refOf(page, 'Buy') });
        }
        return { action: { type: 'done', summary: 'done' }, envelope: { plan: [] } };
      },
    });

    const result = await runAgent(h.deps, {
      task: 'one thing',
      caps: { steps: 40, budget: '10.00', duration: '10m' },
      stepFailures: 3,
    });

    expect(notices[PLANNING_STEP_THRESHOLD + 1]).not.toBeUndefined();
    expect(result.stepsUsed).toBe(PLANNING_STEP_THRESHOLD + 2);
  });

  test('a malformed plan on the raw reply does not settle the demand either', async () => {
    // The production path. `parsePlan` skips an entry with no id or no goal and
    // reports the whole plan absent when nothing survives, so a model that
    // emits the field and fills it with rubbish has still stated nothing — and
    // must still be asked.
    const page = storePage('https://a.example/', 'Buy');
    const notices: (string | undefined)[] = [];
    const h = harness({
      tree: page,
      model: (prompt, step): ModelChoice => {
        notices.push(prompt.notice);
        if (step < PLANNING_STEP_THRESHOLD) {
          return reply({ type: 'click', ref: refOf(page, 'Buy') });
        }
        return reply({ type: 'done', summary: 'done' }, { plan: [{ site: 'a.example' }] });
      },
    });

    const result = await runAgent(h.deps, {
      task: 'one thing',
      caps: { steps: 40, budget: '10.00', duration: '10m' },
      stepFailures: 3,
    });

    expect(notices[PLANNING_STEP_THRESHOLD + 1]).not.toBeUndefined();
    expect(result.stepsUsed).toBe(PLANNING_STEP_THRESHOLD + 2);
    expect(result.goals).toEqual([]);
  });

  test('a run too short to fund a plan is never asked for one, and pays nothing', async () => {
    // The cost argument, as a test. The demand is gated on the SAME ceiling
    // that decides whether the planning affordance is offered at all, so a
    // short extraction's prompt is unchanged and its step count is unchanged.
    const page = storePage('https://a.example/', 'Buy');
    const texts: string[] = [];
    const notices: (string | undefined)[] = [];
    const h = harness({
      tree: page,
      extract: () => ({ data: { title: 'It\'s Only the Himalayas', price: '£45.17' } }),
      model: (prompt): ModelChoice => {
        texts.push(prompt.text);
        notices.push(prompt.notice);
        return reply({ type: 'extract', instruction: 'title and price', final: true });
      },
    });

    const result = await runAgent(h.deps, {
      task: 'first book in Travel',
      // The eval's `nav` and `phantom` tasks, both 8 steps.
      caps: { steps: 8, budget: '2.00', duration: '4m' },
      stepFailures: 3,
      schema: {
        type: 'object',
        properties: { title: { type: 'string' }, price: { type: 'string' } },
        required: ['title', 'price'],
      },
    });

    expect(result.stopReason).toBe('schema-satisfied');
    // One step, exactly as before. Not one plus a decline.
    expect(result.stepsUsed).toBe(1);
    expect(notices).toEqual([undefined]);
    expect(texts[0]).not.toContain('has never stated a plan');
    expect(texts[0]).not.toContain('"plan":[');
  });

  test('an honest refusal is untouched: nothing here gates `fail`', async () => {
    // THE REGRESSION GUARD. The eval's `impossible` task asks for two values
    // that are not on the page, and its correct outcome is the model refusing —
    // which is also the behaviour most easily lost, because everything in this
    // describe block exists to stop a run ending early.
    //
    // `fail` is checked before the schema and is gated by NOTHING added here: a
    // run that refuses ends `failed` / `gave-up` on the step it refuses, whatever
    // the plan says and whatever the collected data would have satisfied.
    //
    // `gave-up` and not `error`, since the settle landed: the model's verdict
    // about a page it could see is a different fact from our runtime throwing,
    // and the two no longer share a stop reason.
    const page = storePage('https://a.example/', 'Buy');
    const texts: string[] = [];
    const h = harness({
      tree: page,
      model: (prompt, step): ModelChoice => {
        texts.push(prompt.text);
        return step === 0
          ? reply({ type: 'click', ref: refOf(page, 'Buy') })
          : reply({ type: 'fail', reason: 'the page publishes a UPC and no ISBN-13' });
      },
    });

    const result = await runAgent(h.deps, {
      task: 'the isbn-13 and the author date of birth',
      // The eval's `impossible` caps: over the planning threshold, so this run
      // IS in the population the demand applies to.
      caps: { steps: 14, budget: '3.00', duration: '6m' },
      stepFailures: 3,
      schema: FOUR_FIELDS,
    });

    expect(result.status).toBe('failed');
    expect(result.stopReason).toBe('gave-up');
    expect(result.stepsUsed).toBe(2);
    expect(result.error).toContain('UPC');
    // And the decision to refuse was made on a prompt carrying none of this.
    // Nothing added here can appear before a run first tries to end, so it
    // cannot have tipped a refusal into an invented answer.
    for (const text of texts) {
      expect(text).not.toContain('has never stated a plan');
      expect(text).not.toContain('already satisfies the schema');
    }
  });

  test('a run that never satisfies its schema is untouched, holds and all', async () => {
    // The eval's `multipage` shape. Both the hold and its bound live inside the
    // `schema satisfied` branch, so a run that never fills its schema cannot
    // reach either: it caps exactly as it did before, and a cap-out on such a
    // task is not evidence of anything in this file.
    const page = storePage('https://a.example/', 'Buy');
    const notices: (string | undefined)[] = [];
    const h = harness({
      tree: page,
      // One field of four, forever.
      extract: () => ({ data: { cheapestTravelBook: 'partial only' } }),
      model: (prompt): ModelChoice => {
        notices.push(prompt.notice);
        return reply({ type: 'extract', instruction: 'everything' });
      },
    });

    const result = await runAgent(h.deps, {
      task: 'four fields',
      caps: { steps: 16, budget: '3.00', duration: '6m' },
      stepFailures: 3,
      schema: FOUR_FIELDS,
    });

    expect(result.status).toBe('capped');
    expect(result.stopReason).toBe('max-steps');
    expect(result.stepsUsed).toBe(16);
    // Never asked, never held, because it never claimed to be finished. Named
    // by DEMAND rather than by the field being empty: `notice` also carries the
    // loop's per-step measurements, and this run earns one of them — sixteen
    // extractions returning the identical object is the same answer sixteen
    // times, which is exactly the fact `duplicateResultNotice` exists to state.
    for (const notice of notices) {
      expect(notice ?? '').not.toContain('already satisfies the schema');
      expect(notice ?? '').not.toContain('has never stated a plan');
      expect(notice ?? '').not.toContain('sub-goal(s) you stated are still open');
    }
  });

  /**
   * `run_…`, reduced to its mechanism.
   *
   * The task asked for three stories' comments. The model closed both sub-goals
   * `done` by step 10 — the second with the summary "Extracted top 3 comments
   * for the FIRST story", its own admission — and then took 41 more steps and
   * wrote 17 more `result` records. It reported `status: 'completed'` /
   * `stopReason: 'task-complete'`, which is the pair a run that served all
   * three would have carried, and no field anywhere said otherwise.
   *
   * The `done` gate did not fail: it asks whether any sub-goal is OPEN, and
   * none was. Goal status is whatever the model's envelope said, and `closeGoal`
   * consults no record, step or url. So the fact that makes this answerable is
   * the one on the other side of the plan — the run bought answers its own plan
   * does not account for.
   */
  test('a run that keeps buying answers after closing its plan is partial, not completed', async () => {
    const page = storePage('https://a.example/', 'Buy');
    const h = harness({
      tree: page,
      extract: (_schema, instruction) => ({ data: { comments: instruction ?? 'x' } }),
      model: (_prompt, step): ModelChoice => {
        if (step === 0) {
          return reply(
            { type: 'extract', instruction: 'story 1 comments' },
            { plan: [{ id: 'g1', goal: 'comments for each of the three stories', site: 'a.example' }] },
          );
        }
        // The premature closure: one story served, the whole errand declared
        // done. Exactly what the production run's g2 did at step 10.
        if (step === 1) {
          return reply(
            { type: 'click', ref: refOf(page, 'Buy') },
            { goal: { id: 'g1', status: 'done', summary: 'comments for the FIRST story' } },
          );
        }
        // ...and then it carries on working, with nothing left in the plan to
        // attribute any of it to.
        if (step < 5) {
          return reply({ type: 'extract', instruction: `story ${String(step)} comments` });
        }
        return reply({ type: 'done', summary: 'got the comments' });
      },
    });

    const result = await runAgent(h.deps, {
      task: 'top 3 stories, then the top 3 comments for each',
      caps: CAPS,
      stepFailures: 3,
    });

    // The run genuinely finished on its own `done`, and that is still what
    // stopped it: the stop reason is a fact about the ending and is not being
    // rewritten. What changes is the answer to "did the caller get what they
    // asked for", which is the question `status` exists for.
    expect(result.stopReason).toBe('task-complete');
    expect(result.status).toBe('partial');
    // And the plan is on the result beside it, so the two halves can be read
    // together: one sub-goal, closed `done`, by a summary that says "FIRST".
    expect(result.goals?.map((goal) => goal.status)).toEqual(['done']);
  });

  test('a run that finishes when its plan finishes is untouched and still completed', async () => {
    const page = storePage('https://a.example/', 'Buy');
    const h = harness({
      tree: page,
      extract: () => ({ data: { comments: 'all three' } }),
      model: (_prompt, step): ModelChoice => {
        if (step === 0) {
          return reply(
            { type: 'extract', instruction: 'all three stories' },
            { plan: [{ id: 'g1', goal: 'comments for each of the three stories', site: 'a.example' }] },
          );
        }
        // Closed and finished on the same step, which is the shape of every
        // honest ending: nothing is bought after the plan says it is over.
        return reply(
          { type: 'done', summary: 'got them' },
          { goal: { id: 'g1', status: 'done', summary: 'all three' } },
        );
      },
    });

    const result = await runAgent(h.deps, {
      task: 'top 3 stories, then the top 3 comments for each',
      caps: CAPS,
      stepFailures: 3,
    });

    expect(result.stopReason).toBe('task-complete');
    expect(result.status).toBe('completed');
  });
});

describe('an item recorded again is named as already recorded', () => {
  /**
   * `run_…`, reduced: no schema, and the
   * model recorded Ken Thompson's birth year nine times across steps 47-65 as
   * an object, a string of that object and the bare year in turn. A byte
   * comparison called those different answers, so nothing told it the item was
   * already in hand. MUTATION THIS CATCHES: comparing results by bytes, or
   * never escalating past the first telling.
   */
  test('the same fact in three formats is one item, and a second repeat in a row escalates', async () => {
    const page = storePage('https://en.wikipedia.org/wiki/Ken_Thompson', 'Next');
    const forms: readonly unknown[] = [
      { name: 'Ken Thompson', birthYear: 1943 },
      "{name: 'Ken Thompson', birthYear: 1943}",
      '1943',
    ];
    let extracted = 0;
    const notices: (string | undefined)[] = [];
    const h = harness({
      tree: page,
      extract: () => ({ data: forms[Math.min(extracted++, forms.length - 1)] }),
      model: (prompt, step): ModelChoice => {
        notices.push(prompt.notice);
        return step < 3
          ? reply({ type: 'extract', instruction: "Extract Ken Thompson's birth year from the infobox" })
          : reply({ type: 'done', summary: 'recorded' });
      },
    });

    await runAgent(h.deps, { task: 'the birth year of each scientist', caps: { steps: 8, budget: '3.00' }, stepFailures: 3 });

    // A first recording is not a repeat (a schema-less look still quotes it back).
    expect(notices[1] ?? '').not.toContain('already recorded at step');
    // Step 2's result is the string form: the same item, recorded at step 1.
    expect(notices[2] ?? '').toContain('already recorded at step 1');
    expect(notices[2] ?? '').not.toContain('in a row');
    // Step 3's is the bare year, a second repeat in a row: escalated.
    expect(notices[3] ?? '').toContain('already recorded at step 1');
    expect(notices[3] ?? '').toContain('2 extractions in a row');
  });

  test('a new item between two repeats resets the count', async () => {
    const page = storePage('https://en.wikipedia.org/wiki/Ken_Thompson', 'Next');
    const forms: readonly unknown[] = [
      { name: 'Ken Thompson', birthYear: 1943 },
      { name: 'Ken Thompson', birthYear: 1943 },
      { name: 'Dennis Ritchie', birthYear: 1941 },
      { name: 'Dennis Ritchie', birthYear: 1941 },
    ];
    let extracted = 0;
    const notices: (string | undefined)[] = [];
    const h = harness({
      tree: page,
      extract: () => ({ data: forms[Math.min(extracted++, forms.length - 1)] }),
      model: (prompt, step): ModelChoice => {
        notices.push(prompt.notice);
        return step < 4 ? reply({ type: 'extract', instruction: 'the birth year' }) : reply({ type: 'done', summary: 'recorded' });
      },
    });

    await runAgent(h.deps, { task: 'the birth year of each scientist', caps: { steps: 8, budget: '3.00' }, stepFailures: 3 });

    expect(notices[2] ?? '').toContain('already recorded at step 1');
    expect(notices[3] ?? '').not.toContain('already recorded at step');
    expect(notices[4] ?? '').toContain('already recorded at step 3');
    expect(notices[4] ?? '').not.toContain('in a row');
  });
});
