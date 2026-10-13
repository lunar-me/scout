import { afterEach, describe, expect, test } from 'bun:test';

import { Scout, type ScoutResult } from '../src/index';
import { clickOn, fakeBrowser, fakeModel, isStep, role, type FakeBrowser, type FakeModel } from './support';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
});

function servers(steps: readonly unknown[], cost?: string): { browser: FakeBrowser; model: FakeModel } {
  const browser = fakeBrowser();
  const model = fakeModel({ steps, ...(cost === undefined ? {} : { cost }) });
  cleanup.push(browser.stop, model.stop);
  return { browser, model };
}

const CLICK_MORE = clickOn('More');
const DONE = { reasoning: 'the status line says so', actions: [{ type: 'done', summary: 'All stories loaded.' }] };

/** The server learns of a client's close a moment after the client sends it. */
async function closedSockets(browser: FakeBrowser): Promise<void> {
  for (let tries = 0; tries < 50 && browser.openSockets() > 0; tries += 1) await Bun.sleep(10);
  expect(browser.openSockets()).toBe(0);
}

async function scripted(browser: FakeBrowser, scout: Scout, task: string): Promise<ScoutResult> {
  const result = await scout.run(task, { caps: { steps: 6, duration: '1m' } });
  await closedSockets(browser);
  return result;
}

describe('a scripted two-step task, end to end over a CDP socket and an HTTP model endpoint', () => {
  test('clicks, then finishes with the answer; the page saw the click and the tab is closed after', async () => {
    const { browser, model } = servers([CLICK_MORE, DONE]);
    const steps: string[] = [];
    const scout = new Scout({ browser: { cdpUrl: browser.wsEndpoint }, models: { hands: role(model, 'hands-model') } });
  
    const result = await scout.run('Click More until every story is loaded, then say so.', {
      caps: { steps: 6, duration: '1m' },
      onStep: (step) => steps.push(step.action.method),
    });

    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('task-complete');
    expect(result.data).toBe('All stories loaded.');
    expect(result.steps.map((step) => step.action.method)).toEqual(['click', 'done']);
    expect(steps).toEqual(['click', 'done']);
    expect(browser.clicked()).toBe(true);
    // Every step call went to the hands model with its own key.
    const stepCalls = model.calls.filter(isStep);
    expect(stepCalls.length).toBe(2);
    expect(stepCalls.every((call) => call.model === 'hands-model' && call.authorization === 'Bearer key-for-hands-model')).toBe(true);
    // The tab Scout opened is closed, the browser it was handed is not, and the socket is gone.
    const created = browser.log.filter((entry) => entry.method === 'Target.createTarget').length;
    const closed = browser.log.filter((entry) => entry.method === 'Target.closeTarget').length;
    expect([created, closed]).toEqual([1, 1]);
    expect(browser.log.some((entry) => entry.method === 'Browser.close')).toBe(false);
    expect(browser.targets()).toEqual([]);
    await closedSockets(browser);
    // Only stock CDP reached it: no Outcrawl command, and the tree came from the Accessibility domain.
    expect(browser.log.filter((entry) => entry.method.startsWith('Outcrawl.'))).toEqual([]);
    expect(browser.log.some((entry) => entry.method === 'Accessibility.getFullAXTree')).toBe(true);
  });

  test('an http:// CDP url is resolved through /json/version', async () => {
    const { browser, model } = servers([DONE]);
    const scout = new Scout({ browser: { cdpUrl: browser.httpEndpoint }, models: { hands: role(model, 'hands-model') } });
    const result = await scripted(browser, scout, 'Say whether every story is loaded.');
    expect(result.status).toBe('completed');
    expect(result.data).toBe('All stories loaded.');
  });

  test('cost is unknown when the endpoint states none and no rates are given, and reported when it does', async () => {
    const unpriced = servers([DONE]);
    const unknown = await scripted(
      unpriced.browser,
      new Scout({ browser: { cdpUrl: unpriced.browser.wsEndpoint }, models: { hands: role(unpriced.model, 'hands-model') } }),
      'Say whether every story is loaded.',
    );
    expect(unknown.costUsd).toBeUndefined();

    const priced = servers([DONE], '0.0015');
    const known = await scripted(
      priced.browser,
      new Scout({ browser: { cdpUrl: priced.browser.wsEndpoint }, models: { hands: role(priced.model, 'hands-model') } }),
      'Say whether every story is loaded.',
    );
    expect(known.costUsd).toBeDefined();
    expect(Number(known.costUsd)).toBeGreaterThanOrEqual(0.0015);
  });

  test('a brain decides on its own endpoint and key, and the hands carry it out on theirs', async () => {
    const browser = fakeBrowser();
    const brain = fakeModel({ steps: [], other: () => ({ decision: 'done' }) });
    const hands = fakeModel({ steps: [CLICK_MORE, DONE] });
    cleanup.push(browser.stop, brain.stop, hands.stop);
    const scout = new Scout({
      browser: { cdpUrl: browser.wsEndpoint },
      models: { hands: role(hands, 'hands-model'), brain: role(brain, 'brain-model') },
    });
      await scout.run('Click More until every story is loaded, then say so.', { caps: { steps: 3, duration: '1m' } });
    expect(brain.calls.length).toBeGreaterThan(0);
    expect(brain.calls.every((call) => call.model === 'brain-model' && call.authorization === 'Bearer key-for-brain-model')).toBe(true);
    expect(hands.calls.every((call) => call.model === 'hands-model')).toBe(true);
  });

  test('a separate extract model answers the schema while the hands act', async () => {
    const browser = fakeBrowser();
    const hands = fakeModel({
      steps: [{ reasoning: 'read the headline', actions: [{ type: 'extract', instruction: 'the top story title' }] }, DONE],
    });
    const extract = fakeModel({
      steps: [],
      other: () => ({ title: 'Rewriting our parser cut cold builds by 41%' }),
    });
    cleanup.push(browser.stop, hands.stop, extract.stop);
    const scout = new Scout({
      browser: { cdpUrl: browser.wsEndpoint },
      models: { hands: role(hands, 'hands-model'), extract: role(extract, 'extract-model') },
    });
      const result = await scout.run('Report the title of the top story.', {
      caps: { steps: 4, duration: '1m' },
      schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    });
    expect(extract.calls.length).toBeGreaterThan(0);
    expect(extract.calls.every((call) => call.model === 'extract-model')).toBe(true);
    expect(result.data).toEqual({ title: 'Rewriting our parser cut cold builds by 41%' });
  });
});

describe('how a structured reply is asked for', () => {
  test('by default as one forced function call carrying the schema, with no response format', async () => {
    const { browser, model } = servers([DONE]);
    const scout = new Scout({ browser: { cdpUrl: browser.wsEndpoint }, models: { hands: role(model, 'hands-model') } });
    const result = await scout.run('Say whether every story is loaded.', { caps: { steps: 3, duration: '1m' } });
    expect(result.status).toBe('completed');
    const step = model.calls.find(isStep);
    expect(step?.body['response_format']).toBeUndefined();
    expect(step?.body['tool_choice']).toEqual({ type: 'function', function: { name: 'outcrawl_reply' } });
    const tools = step?.body['tools'] as { function: { name: string; parameters: Record<string, unknown> } }[];
    expect(tools.map((tool) => tool.function.name)).toEqual(['outcrawl_reply']);
    expect(Object.keys(tools[0]?.function.parameters['properties'] ?? {})).toContain('actions');
  });

  test("'strict' still sends a strict json_schema response format", async () => {
    const { browser, model } = servers([DONE]);
    const scout = new Scout({
      browser: { cdpUrl: browser.wsEndpoint },
      models: { hands: { ...role(model, 'hands-model'), structuredOutput: 'strict' } },
    });
    await scout.run('Say whether every story is loaded.', { caps: { steps: 3, duration: '1m' } });
    const step = model.calls.find(isStep);
    expect(step?.body['tools']).toBeUndefined();
    expect((step?.body['response_format'] as { type: string }).type).toBe('json_schema');
  });

  test('a 400 on a structured call is not retried in another mode, and the error names the role and the option', async () => {
    const browser = fakeBrowser();
    const model = fakeModel({ steps: [DONE], refuse: () => true });
    cleanup.push(browser.stop, model.stop);
    const scout = new Scout({ browser: { cdpUrl: browser.wsEndpoint }, models: { hands: role(model, 'hands-model') } });
    const result = await scout.run('Say whether every story is loaded.', { caps: { steps: 8, duration: '1m' } });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Provider returned error');
    expect(result.error).toContain("The hands model (hands-model) was asked for a structured reply in 'tool_choice' mode");
    expect(result.error).toContain("set models.hands.structuredOutput to 'json_object' or 'strict'");
    // Every call went out in the one mode the caller has: nothing switched behind their back.
    expect(model.calls.every((call) => call.body['tool_choice'] !== undefined && call.body['response_format'] === undefined)).toBe(true);
  });
});
