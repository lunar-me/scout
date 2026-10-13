/**
 * One run on a real headless Chromium, launched by playwright-core, against a
 * page served here and the fake model endpoint. It proves the stock CDP flavor
 * and the agenthands planner drive a stock browser: the model is shown the
 * real accessibility tree, its click lands, and the page changes.
 *
 * Skipped when playwright-core or its Chromium is not installed.
 */
import { existsSync } from 'node:fs';

import { afterAll, describe, expect, test } from 'bun:test';

import { Scout } from '../src/index';
import { fakeModel, promptOf, refIn, role, type ModelCall } from './support';

async function chromiumPath(): Promise<string | undefined> {
  try {
    // An optional peer that may be absent: a static import would fail the file instead of skipping it.
    const name = 'playwright-core';
    const playwright = (await import(name)) as { chromium: { executablePath(): string } };
    const path = playwright.chromium.executablePath();
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

const available = (await chromiumPath()) !== undefined;

const PAGE = `<!doctype html><html><head><title>News</title></head><body>
<h1>Rewriting our parser cut cold builds by 41%</h1>
<ol><li>First story</li><li>Second story</li></ol>
<button id="more" onclick="document.getElementById('status').textContent='All stories loaded'; this.remove()">More</button>
<p id="status"></p>
</body></html>`;

const site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }) });
afterAll(() => {
  void site.stop(true);
});

describe.skipIf(!available)('a real headless Chromium', () => {
  test('navigates, reads the real tree, clicks the button and reports what the page then says', async () => {
    const url = `http://127.0.0.1:${String(site.port)}/`;
    let sawStatus = false;
    const model = fakeModel({
      steps: [
        { reasoning: 'open the page', actions: [{ type: 'navigate', url }] },
        (call: ModelCall) => ({ reasoning: 'load the rest', actions: [{ type: 'click', ref: refIn(call, 'More') }] }),
        (call: ModelCall) => {
          sawStatus = promptOf(call).includes('All stories loaded');
          return { reasoning: 'the page says so', actions: [{ type: 'done', summary: 'All stories loaded.' }] };
        },
      ],
    });
    try {
      const scout = new Scout({ browser: { launch: { driver: 'playwright' } }, models: { hands: role(model, 'hands-model') } });
      const result = await scout.run('Open the page, click More, and report what the status line says.', {
        caps: { steps: 6, duration: '2m' },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe('completed');
      expect(result.steps.map((step) => step.action.method)).toEqual(['navigate', 'click', 'done']);
      expect(sawStatus).toBe(true);
      expect(result.data).toBe('All stories loaded.');
      expect(result.pages).toBeGreaterThanOrEqual(1);
    } finally {
      model.stop();
    }
  }, 120_000);
});
