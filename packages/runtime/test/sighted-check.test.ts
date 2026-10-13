/**
 * A check the host sights on the page is worked before the page is read, as
 * the browser works a vendor widget without being asked.
 *
 * Stealth Bench task 15, `run_…` (2026-10-07, n=1): the model read
 * every answer through Shein's "I am human" box and never called
 * `page.verify`; the judge saw the box in the last two screenshots and failed
 * the run.
 */

import { describe, expect, test } from 'bun:test';

import type { Action } from '../src/actions';
import { runAgent } from '../src/loop';
import type { StepTrace } from '../src/result';
import { SITE_CHECK_TOOL, siteCheckToolPort, type SiteCheckResult, type SiteCheckSighting } from '../src/site-check';
import type { AxTree } from '../src/snapshot';
import { harness, node, tree } from './support';

const CAPS = { steps: 8, budget: '2.00', duration: '5m' };
const RESULTS_URL = 'https://us.shein.com/pdsearch/running%20shoes/';

const boxed = tree(
  node({
    role: 'RootWebArea',
    name: 'Running Shoes | SHEIN USA',
    children: [node({ role: 'StaticText', name: 'Please click to complete the following actions to verify you are human' }), node({ role: 'checkbox', name: 'I am human' })],
  }),
  RESULTS_URL,
);

const results = tree(
  node({
    role: 'RootWebArea',
    name: 'Running Shoes | SHEIN USA',
    children: [node({ role: 'link', name: 'Lightweight Breathable Mesh Sneakers' }), node({ role: 'StaticText', name: '$5.61' })],
  }),
  RESULTS_URL,
);

const wait: Action = { type: 'wait', seconds: 1 };
const done: Action = { type: 'done', summary: 'Lightweight Breathable Mesh Sneakers, $5.61' };

interface Page {
  /** Whether Shein's box is on the page. */
  boxed: boolean;
  readonly calls: string[];
}

/**
 * A run of `actions` (then `done`) on a page that shows Shein's box while
 * `page.boxed`, with the sighted-check port wired as the worker wires it: one
 * port for the model's tool and the loop's sighting.
 */
async function run(
  page: Page,
  solve: () => SiteCheckResult,
  actions: readonly Action[],
): Promise<{ steps: readonly StepTrace[]; notices: string[]; trees: AxTree[] }> {
  const sight = (): Promise<SiteCheckSighting | undefined> => {
    page.calls.push('sight');
    return Promise.resolve(page.boxed ? { kind: 'shein', url: RESULTS_URL } : undefined);
  };
  const port = siteCheckToolPort({
    solve: () => {
      page.calls.push('solve');
      return Promise.resolve(solve());
    },
    sight,
  });
  const h = harness({
    snapshot: () => (page.boxed ? boxed : results),
    model: (_prompt, step) => {
      page.calls.push('model');
      return { action: actions[step] ?? done };
    },
  });
  const result = await runAgent({ ...h.deps, tools: port, sightedCheck: port }, { task: 'first running shoes result on shein', caps: CAPS, stepFailures: 3 });
  return { steps: result.steps, notices: h.prompts.map((prompt) => prompt.notice ?? ''), trees: h.prompts.map((prompt) => prompt.tree) };
}

describe('a check the host sights before a page read', () => {
  test("Shein's box is worked before the read, and the step records it solved", async () => {
    const page: Page = { boxed: true, calls: [] };
    const { steps, notices, trees } = await run(
      page,
      () => {
        page.boxed = false;
        return { outcome: 'solved', detail: "Shein's check was ticked and let the page through.", touched: true };
      },
      [wait],
    );

    // Worked before the model was asked anything, once.
    expect(page.calls.slice(0, 3)).toEqual(['sight', 'solve', 'model']);
    expect(page.calls.filter((call) => call === 'solve')).toHaveLength(1);
    // The model is shown the page the check led to, and told why.
    expect(trees[0]?.url).toBe(RESULTS_URL);
    expect(JSON.stringify(trees[0])).toContain('Lightweight Breathable Mesh Sneakers');
    expect(notices[0]).toContain('completed for you automatically');
    // The judge's trace shows the solve on the step it preceded.
    expect(steps[0]?.verification).toEqual([{ outcome: 'solved', vendor: 'shein' }]);
    expect(steps.slice(1).every((step) => step.verification === undefined)).toBe(true);
  });

  test('a check the solver refuses is recorded failed and not worked again on that page', async () => {
    const page: Page = { boxed: true, calls: [] };
    const { steps, notices } = await run(
      page,
      () => ({ outcome: 'refused', detail: "Shein's check did not accept the clicks.", touched: true }),
      [wait, wait],
    );

    expect(page.calls.filter((call) => call === 'solve')).toHaveLength(1);
    // Sighted again on every later read, and left alone.
    expect(page.calls.filter((call) => call === 'sight').length).toBeGreaterThanOrEqual(3);
    expect(steps[0]?.verification).toEqual([{ outcome: 'failed', vendor: 'shein', reason: 'rejected' }]);
    expect(steps.slice(1).every((step) => step.verification === undefined)).toBe(true);
    expect(notices[0]).toContain('Automatic verification did not succeed on this page');
  });

  test('a page with no check costs one sighting per read and nothing else', async () => {
    const page: Page = { boxed: false, calls: [] };
    const { steps } = await run(
      page,
      () => {
        throw new Error('nothing to solve');
      },
      [wait, wait],
    );

    const models = page.calls.filter((call) => call === 'model').length;
    expect(page.calls.filter((call) => call === 'sight')).toHaveLength(models);
    expect(page.calls).not.toContain('solve');
    expect(steps.every((step) => step.verification === undefined)).toBe(true);
  });

  test("a check the model has just worked with page.verify is the model's, and the browser leaves it", async () => {
    const page: Page = { boxed: false, calls: [] };
    const verify: Action = { type: 'callTool', tool: SITE_CHECK_TOOL, arguments: {} };
    const { steps } = await run(
      page,
      () => {
        // The model's call opens the box and the page refuses it.
        page.boxed = true;
        return { outcome: 'refused', detail: "Shein's check did not accept the clicks.", touched: true };
      },
      [verify, wait, wait],
    );

    // Sighted on every read after the call, never worked by the browser.
    expect(page.calls.filter((call) => call === 'solve')).toHaveLength(1);
    expect(page.calls.filter((call) => call === 'sight').length).toBeGreaterThanOrEqual(3);
    expect(steps.every((step) => step.verification === undefined)).toBe(true);
  });

  test('a sighted check shares the run allowance with the model, and an untouched one spends none of it', async () => {
    let touched = false;
    const page: Page = { boxed: true, calls: [] };
    const port = siteCheckToolPort({
      maxCalls: 1,
      solve: () => Promise.resolve({ outcome: 'unreadable', detail: 'not painted yet', touched }),
      sight: () => Promise.resolve(page.boxed ? { kind: 'px', url: RESULTS_URL } : undefined),
    });

    // Nothing touched: no record, and the allowance is still whole.
    expect(await port.workSighted()).toBeUndefined();
    touched = true;
    expect(await port.workSighted()).toEqual({ kind: 'inpage', detector: 'px', solved: false, reason: 'exhausted' });
    const after = await port.call(SITE_CHECK_TOOL, {});
    expect(after.isError).toBe(true);
    expect(after.text).toContain('has been used 1 of 1 times');
  });
});
