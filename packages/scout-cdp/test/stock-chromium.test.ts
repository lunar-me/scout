/**
 * The binding on a real stock Chromium through `stockFlavor`: snapshot, click,
 * fill, select and scroll change the page, and an out-of-process iframe is
 * read and acted in.
 *
 * Runs only where Playwright's Chromium is installed (`chromiumPath`), headless
 * and closed after each test. It drives a stock browser, never Outcrawl's.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { walk, type AgentDeps, type AxNode, type AxTree } from '@outcrawl/runtime';

import { bindAgent, handsPortFor, stockFlavor, type CdpPage, type HandsPort } from '../src/index';
import { chromiumPath, launchChromium, type StockChromium } from './support/chromium';

const FORM = `<!doctype html><html><head><title>Order</title></head><body style="margin:0">
<h1>Order form</h1>
<label for="name">Name</label> <input id="name" name="name">
<label for="size">Size</label>
<select id="size" name="size"><option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option></select>
<button id="go" type="button" onclick="document.getElementById('out').textContent = 'clicked ' + document.getElementById('name').value">Place order</button>
<p id="out">idle</p>
<div style="height:4000px"></div>
<p>Bottom of the page</p>
</body></html>`;

const silent = { info: (): void => undefined, warn: (): void => undefined };

function nodeNamed(tree: AxTree, role: string, name: string): AxNode {
  const found = walk(tree).find((node) => node.role === role && node.name === name);
  if (found === undefined) throw new Error(`no ${role} "${name}" in the tree`);
  return found;
}

async function evaluate(page: CdpPage, expression: string): Promise<unknown> {
  const reply = await page.send('Runtime.evaluate', { expression, returnByValue: true });
  return (reply['result'] as { value?: unknown } | undefined)?.value;
}

describe.skipIf(chromiumPath === undefined)('stockFlavor on a stock headless Chromium', () => {
  let chrome: StockChromium;
  let hands: HandsPort;

  beforeAll(async () => {
    chrome = await launchChromium();
    const port = handsPortFor({ env: {}, logger: silent });
    if (port === null) throw new Error('agenthands is not installed');
    hands = port;
  });

  afterAll(async () => {
    await chrome.close();
  });

  function bind(page: CdpPage): AgentDeps {
    return bindAgent(page, { model: null, tabs: null, files: null, hands, flavor: stockFlavor });
  }

  test('snapshot, click, fill, select and scroll change the page they name', async () => {
    const page = await chrome.open(`data:text/html,${encodeURIComponent(FORM)}`);
    const deps = bind(page);

    const tree = await deps.snapshot();
    const name = nodeNamed(tree, 'textbox', 'Name');
    const size = nodeNamed(tree, 'combobox', 'Size');
    const order = nodeNamed(tree, 'button', 'Place order');
    expect(nodeNamed(tree, 'heading', 'Order form').ref.frameOrdinal).toBe(tree.root.ref.frameOrdinal);

    await deps.perform({ type: 'fill', ref: name.ref, text: 'Ada' });
    await deps.perform({ type: 'select', ref: size.ref, value: 'Medium' });
    await deps.perform({ type: 'click', ref: order.ref });
    await deps.perform({ type: 'scroll', dy: 1200 });

    expect(await evaluate(page, 'document.getElementById("name").value')).toBe('Ada');
    expect(await evaluate(page, 'document.getElementById("size").value')).toBe('m');
    expect(await evaluate(page, 'document.getElementById("out").textContent')).toBe('clicked Ada');
    expect(Number(await evaluate(page, 'window.scrollY'))).toBeGreaterThan(300);

    const after = await deps.snapshot();
    expect(nodeNamed(after, 'textbox', 'Name').value).toBe('Ada');
    expect(nodeNamed(after, 'combobox', 'Size').value).toBe('Medium');
    expect(walk(after).some((node) => node.role === 'StaticText' && node.name === 'clicked Ada')).toBe(true);
  }, 60_000);

  test('a cross-site iframe is read into the tree and acted in through its own session', async () => {
    const inner = `<!doctype html><html><body><button onclick="this.textContent = 'paid'">Pay</button></body></html>`;
    let port = 0;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request): Response {
        const body =
          new URL(request.url).pathname === '/pay'
            ? inner
            : `<!doctype html><html><body><h1>Checkout</h1><iframe src="http://localhost:${String(port)}/pay"></iframe></body></html>`;
        return new Response(body, { headers: { 'content-type': 'text/html' } });
      },
    });
    port = server.port ?? 0;
    try {
      const page = await chrome.open(`http://127.0.0.1:${String(port)}/`);
      const deps = bind(page);
      const tree = await deps.snapshot();
      const pay = nodeNamed(tree, 'button', 'Pay');
      expect(pay.ref.frameOrdinal).not.toBe(tree.root.ref.frameOrdinal);

      await deps.perform({ type: 'click', ref: pay.ref });

      const after = await deps.snapshot();
      expect(walk(after).some((node) => node.role === 'button' && node.name === 'paid')).toBe(true);
    } finally {
      server.stop(true);
    }
  }, 60_000);
});
