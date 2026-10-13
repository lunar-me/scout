/**
 * The binding on a real stock Chromium through `stockFlavor`: snapshot, click,
 * fill, select and scroll change the page, and an out-of-process iframe is
 * read and acted in.
 *
 * Runs only where Playwright's Chromium is installed (`chromiumPath`), headless
 * and closed after each test. It drives a stock browser, never Outcrawl's.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { filterTree, runAgent, serializeTree, walk, type AgentDeps, type AxNode, type AxTree, type ModelChoice } from '@outcrawl/runtime';

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

  test.each([
    ['<input type=time name=t>', '19:30', '19:30'],
    ['<input type=time name=t>', '7:30 PM', '19:30'],
    ['<input type=time name=t lang=en-GB>', '19:30', '19:30'],
    ['<input type=date name=t>', 'October 13, 2026', '2026-10-13'],
    ['<input type=datetime-local name=t>', '2026-10-13 19:30', '2026-10-13T19:30'],
    ['<input type=month name=t>', 'October 2026', '2026-10'],
    ['<input type=week name=t>', '2026-W42', '2026-W42'],
  ])('%p filled with %p through its first segment holds %p, and the check confirms it', async (field, text, value) => {
    const page = await chrome.open(`data:text/html,${encodeURIComponent(`<!doctype html><label>When ${field}</label>`)}`);
    const result = await runAgent(
      {
        ...bind(page),
        model: (prompt): ModelChoice => {
          const segment = walk(prompt.tree).find((node) => node.role === 'spinbutton');
          return {
            action: prompt.step === 0 && segment !== undefined ? { type: 'fill', ref: segment.ref, text } : { type: 'fail', reason: 'seen' },
          };
        },
      },
      { task: 'fill it', caps: { steps: 3, budget: '1.00', duration: '1m' }, stepFailures: 3, verify: true },
    );

    expect(await evaluate(page, 'document.querySelector("[name=t]").value')).toBe(value);
    expect(result.steps[0]?.check?.verdict).toBe('confirmed');
  }, 60_000);

  test('a select in each segment of a time input types its value there, as a person chooses it', async () => {
    const page = await chrome.open(`data:text/html,${encodeURIComponent('<!doctype html><label>When <input type=time name=t></label>')}`);
    const deps = bind(page);
    const segments = walk(await deps.snapshot()).filter((node) => node.role === 'spinbutton');
    const [hours, minutes] = segments;
    if (hours === undefined || minutes === undefined) throw new Error('the input drew no segments');

    await deps.perform({ type: 'select', ref: hours.ref, value: '19' });
    await deps.perform({ type: 'select', ref: minutes.ref, value: '30' });

    expect(await evaluate(page, 'document.querySelector("[name=t]").value')).toBe('19:30');
  }, 60_000);

  test('the prompt says how to fill a native date or time input whole, and says nothing of an ARIA one', async () => {
    // The ARIA clock's Minutes sits directly beside the date input's first
    // segment, so a run that joined them would hide the date input's line.
    const page = await chrome.open(
      `data:text/html,${encodeURIComponent(
        '<!doctype html><label>When <input type=time name=t></label>' +
          '<p>Clock <span role=spinbutton tabindex=0 aria-label="Hours" aria-valuenow=1>01</span>:' +
          '<span role=spinbutton tabindex=0 aria-label="Minutes" aria-valuenow=0>00</span><input type=date name=d></p>',
      )}`,
    );
    const lines = serializeTree(filterTree(await bind(page).snapshot())).split('\n');

    const hinted = lines.filter((line) => line.includes('(first part of a '));
    expect(hinted).toHaveLength(2);
    expect(hinted[0]).toContain('spin "Hours Hours"="0" (first part of a time field: fill it with the whole time, as HH:MM)');
    expect(hinted[1]).toContain('(first part of a date field: fill it with the whole date, as YYYY-MM-DD)');
  }, 60_000);

  describe('a submit the browser refuses', () => {
    // httpbin's pizza form, cut to the field that blocks it, plus the page's
    // own watch on everything a validity read could disturb: `invalid` events,
    // calls into the validation API and its getters from the page's world,
    // and its globals.
    const PIZZA = `<!doctype html><html><head><title>Order</title><script>
window.seen = { invalid: 0, calls: 0, globals: 0 };
document.addEventListener('invalid', function () { seen.invalid += 1; }, true);
[HTMLInputElement, HTMLFormElement, HTMLButtonElement, HTMLTextAreaElement, Element, Node, Document].forEach(function (type) {
  var proto = type.prototype;
  ['checkValidity', 'reportValidity', 'closest', 'getRootNode'].forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(proto, key)) return;
    var original = proto[key];
    proto[key] = function () { seen.calls += 1; return original.apply(this, arguments); };
  });
  ['validity', 'validationMessage', 'willValidate', 'labels', 'form', 'elements', 'noValidate', 'formNoValidate', 'activeElement'].forEach(function (key) {
    var d = Object.getOwnPropertyDescriptor(proto, key);
    if (d === undefined || d.get === undefined) return;
    Object.defineProperty(proto, key, { configurable: true, enumerable: d.enumerable, get: function () { seen.calls += 1; return d.get.call(this); } });
  });
});
seen.globals = Object.getOwnPropertyNames(window).length;
</script></head><body>
<form method="post" action="/done">
<p><label>Customer name: <input name="custname"></label></p>
<p><label>Preferred delivery time: <input type=time min="11:00" max="21:00" step="900" name="delivery"></label></p>
<p><button>Submit order</button></p>
</form></body></html>`;

    async function served<T>(use: (url: string) => Promise<T>): Promise<T> {
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: (request) =>
          new Response(new URL(request.url).pathname === '/done' ? '<h1>Order received</h1>' : PIZZA, {
            headers: { 'content-type': 'text/html' },
          }),
      });
      try {
        return await use(`http://127.0.0.1:${String(server.port)}/`);
      } finally {
        server.stop(true);
      }
    }

    test('is told to the model with the field and the browser\'s own message', async () => {
      await served(async (url) => {
        const page = await chrome.open(url);
        const deps = bind(page);
        const prompts: string[] = [];
        const result = await runAgent(
          {
            ...deps,
            model: (prompt): ModelChoice => {
              prompts.push(prompt.text);
              const hours = walk(prompt.tree).find((node) => node.role === 'spinbutton' && (node.name ?? '').startsWith('Hours'));
              const submit = walk(prompt.tree).find((node) => node.role === 'button' && node.name === 'Submit order');
              if (prompt.step === 0 && hours !== undefined) return { action: { type: 'fill', ref: hours.ref, text: '07:30' } };
              if (prompt.step === 1 && submit !== undefined) return { action: { type: 'click', ref: submit.ref } };
              return { action: { type: 'fail', reason: 'seen' } };
            },
          },
          { task: 'order a pizza for 07:30', caps: { steps: 4, budget: '1.00', duration: '1m' }, stepFailures: 3, verify: true },
        );

        expect(await evaluate(page, 'document.querySelector("[name=delivery]").value')).toBe('07:30');
        expect(page.url()).toBe(url);
        expect(result.steps[1]?.check?.verdict).toBe('contradicted');
        expect(prompts[2]).toContain(
          'click the button "Submit order" -> no effect: nothing on the page changed; the browser did not send the form, ' +
            'because a field is invalid: "Preferred delivery time:": Value must be 11:00',
        );
      });
    }, 60_000);

    test('is read without anything the page can observe', async () => {
      await served(async (url) => {
        const page = await chrome.open(url);
        const deps = bind(page);
        const tree = await deps.snapshot();
        const hours = walk(tree).find((node) => node.role === 'spinbutton' && (node.name ?? '').startsWith('Hours'));
        const submit = nodeNamed(tree, 'button', 'Submit order');
        if (hours === undefined) throw new Error('no Hours segment');
        await deps.perform({ type: 'fill', ref: hours.ref, text: '7' });
        const before = await evaluate(page, 'JSON.stringify([seen.invalid, seen.calls, Object.getOwnPropertyNames(window).length])');

        const refused = await deps.refusedSubmit?.(submit.ref, 'click');
        const pressed = await deps.refusedSubmit?.(hours.ref, 'enter');

        expect(refused?.fields).toEqual([
          {
            label: 'Preferred delivery time:',
            message: 'Please enter a valid value. The field is incomplete or has an invalid date.',
          },
        ]);
        expect(pressed).toEqual(refused);
        const after = await evaluate(page, 'JSON.stringify([seen.invalid, seen.calls, Object.getOwnPropertyNames(window).length])');
        expect(after).toBe(before);
        expect(JSON.parse(String(before))).toEqual([0, 0, Number(await evaluate(page, 'seen.globals'))]);
        // The control: the same reads made from the page's own world are seen.
        await evaluate(page, 'document.forms[0].elements[1].validationMessage; document.forms[0].checkValidity()');
        const seen = JSON.parse(String(await evaluate(page, 'JSON.stringify([seen.invalid, seen.calls])'))) as number[];
        expect(seen[0]).toBe(1);
        expect(seen[1]).toBeGreaterThan(0);
      });
    }, 60_000);
  });
});
