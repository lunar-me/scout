/**
 * The binding on a real stock Chromium through `stockFlavor`: snapshot, click,
 * fill, select and scroll change the page, and an out-of-process iframe is
 * read and acted in.
 *
 * Runs only where Playwright's Chromium is installed (`chromiumPath`), headless
 * and closed after each test. It drives a stock browser, never Outcrawl's.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { filterTree, runAgent, serializeTree, walk, type AgentDeps, type AxNode, type AxTree, type ModelChoice } from '@outcrawl/runtime';

import { bindAgent, encodePng, handsPortFor, stockFlavor, type CdpPage, type FilePort, type HandsPort } from '../src/index';
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

  describe('a form that keeps its own state, the way a framework does', () => {
    // It never reads the DOM at submit: each field reaches its state only
    // through the input and change events a person's typing, choosing and
    // uploading fire, and the submit checks that state alone, the file's
    // bytes included. A fill that set a value without those events would
    // leave a field empty here while the page shows it full.
    const FRAMEWORK_FORM = `<!doctype html><html><head><title>Join</title></head><body>
<form id="f" novalidate>
<p><label>Email * <input id="email" name="email" type="email" required></label></p>
<p><label>Country * <select id="country" name="country" required><option value="">Choose</option><option value="US">United States</option><option value="CA">Canada</option></select></label></p>
<p><label>Date of birth * <input id="dob" name="dob" type="date" required></label></p>
<fieldset><legend>Contact by *</legend><label><input type="radio" name="contact" value="email"> Email</label><label><input type="radio" name="contact" value="phone"> Phone</label></fieldset>
<p><label>Profile picture * <input id="pic" name="pic" type="file" accept="image/*" required></label></p>
<p><button type="submit">Send</button></p>
</form>
<p id="out">not sent</p>
<script>
var state = {};
var form = document.getElementById('f');
['input', 'change'].forEach(function (kind) {
  form.addEventListener(kind, function (event) {
    var field = event.target;
    if (field.type === 'radio') { if (field.checked) state[field.name] = field.value; return; }
    state[field.name] = field.type === 'file' ? field.files[0] : field.value;
  });
});
form.addEventListener('submit', function (event) {
  event.preventDefault();
  var missing = ['email', 'country', 'dob', 'contact', 'pic'].filter(function (name) { return !state[name]; });
  if (missing.length > 0) { document.getElementById('out').textContent = 'missing ' + missing.join(', '); return; }
  state.pic.arrayBuffer().then(function (bytes) {
    var head = Array.from(new Uint8Array(bytes).slice(0, 4)).join(',');
    document.getElementById('out').textContent =
      head === '137,80,78,71' ? 'received ' + state.email + ' ' + state.country + ' ' + state.dob + ' ' + state.contact + ' ' + state.pic.name : 'not a picture';
  });
});
</script></body></html>`;

    /** A run's file space on this machine: what `createFile` writes and `attachFile` stages. */
    function localFiles(): FilePort {
      const held = new Map<string, { readonly name: string; readonly path: string }>();
      const directory = mkdtempSync(join(tmpdir(), 'scout-files-'));
      return {
        list: () => [...held].map(([fileId, file]) => ({ fileId, name: file.name })),
        create: ({ name }) => {
          const fileId = `file_made_${String(held.size + 1)}`;
          const path = join(directory, name);
          writeFileSync(path, encodePng({ width: 8, height: 8, rgba: new Uint8Array(8 * 8 * 4).fill(0xe5) }));
          held.set(fileId, { name, path });
          return { fileId, name };
        },
        stage: async (fileId) => held.get(fileId)?.path,
      };
    }

    test('is filled, given a picture the run made and attached by name, and sent', async () => {
      const page = await chrome.open(`data:text/html,${encodeURIComponent(FRAMEWORK_FORM)}`);
      const files = localFiles();
      const deps = bindAgent(page, { model: null, tabs: null, files, hands, flavor: stockFlavor });
      const find = (tree: AxTree, role: string, name: string): AxNode | undefined =>
        walk(tree).find((node) => node.role === role && (node.name ?? '').startsWith(name));
      const plan: readonly ((tree: AxTree) => ModelChoice['action'] | undefined)[] = [
        (tree) => { const at = find(tree, 'textbox', 'Email'); return at && { type: 'fill', ref: at.ref, text: 'jane.doe@example.com' }; },
        (tree) => { const at = find(tree, 'combobox', 'Country'); return at && { type: 'select', ref: at.ref, value: 'Canada' }; },
        (tree) => { const at = walk(tree).find((node) => node.role === 'spinbutton'); return at && { type: 'fill', ref: at.ref, text: '1990-01-15' }; },
        (tree) => { const at = find(tree, 'radio', 'Email'); return at && { type: 'click', ref: at.ref }; },
        () => ({ type: 'createFile', file: 'profile.png', text: '' }),
        (tree) => { const at = find(tree, 'button', 'Profile picture'); return at && { type: 'attachFile', ref: at.ref, file: 'profile.png' }; },
        (tree) => { const at = find(tree, 'button', 'Send'); return at && { type: 'click', ref: at.ref }; },
      ];
      const result = await runAgent(
        {
          ...deps,
          model: (prompt): ModelChoice => ({ action: plan[prompt.step]?.(prompt.tree) ?? { type: 'done', summary: 'sent' } }),
        },
        { task: 'Fill in every required field of the join form and submit it.', caps: { steps: 10, budget: '1.00', duration: '1m' }, stepFailures: 0 },
      );

      expect(result.steps.map((step) => step.error)).toEqual(result.steps.map(() => undefined));
      expect(await evaluate(page, 'document.getElementById("out").textContent')).toBe(
        'received jane.doe@example.com CA 1990-01-15 email profile.png',
      );
    }, 60_000);
  });

  describe('a chart that shows a value only in the tooltip under the pointer', () => {
    // Two charts with no element per data point, the way charting libraries
    // draw them: a line drawn as ONE svg path under a transparent overlay,
    // whose tooltip is redrawn on the next animation frame after a move, and
    // a bar chart painted on a canvas, whose tooltip waits out a debounce.
    // Each logs every pointer event it receives, so a test can tell a hover
    // from a press.
    const RAIN = [52, 41, 37, 66, 23, 71, 18, 45, 59, 30, 84, 12];
    const SALES = [310, 145, 275, 520, 90];
    const LEFT = 50;
    const STEP = 45;
    const CHARTS = `<!doctype html><html><head><title>Charts</title><style>
body { margin: 0; font: 14px sans-serif }
.tip { position: absolute; display: none; background: #fff; border: 1px solid #888; padding: 2px 6px; pointer-events: none }
</style></head><body>
<h1 style="margin:0;height:40px">Rainfall</h1>
<svg id="line" width="600" height="200" style="display:block"><path id="path" fill="none" stroke="steelblue" stroke-width="2"></path><rect id="over" x="0" y="0" width="600" height="200" fill="transparent"></rect></svg>
<div id="lineTip" class="tip" role="tooltip"></div>
<h2 style="margin:0;height:40px">Sales</h2>
<canvas id="bars" width="300" height="160" style="display:block"></canvas>
<div id="barTip" class="tip" role="tooltip"></div>
<script>
var rain = ${JSON.stringify(RAIN)}, sales = ${JSON.stringify(SALES)};
var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
window.events = [];
['pointermove','pointerdown','pointerup','mousedown','mouseup','click'].forEach(function (kind) {
  document.addEventListener(kind, function (event) { events.push(kind + (event.isTrusted ? '' : ':untrusted')); }, true);
});
document.getElementById('path').setAttribute('d', rain.map(function (v, i) { return (i ? 'L' : 'M') + (${LEFT} + i * ${STEP}) + ' ' + (190 - v * 2); }).join(' '));
var over = document.getElementById('over'), lineTip = document.getElementById('lineTip'), frame = 0;
over.addEventListener('mousemove', function (event) {
  var box = over.getBoundingClientRect(), x = event.clientX - box.left;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(function () {
    var i = Math.max(0, Math.min(rain.length - 1, Math.round((x - ${LEFT}) / ${STEP})));
    lineTip.textContent = months[i] + ': ' + rain[i] + ' mm';
    lineTip.style.left = (box.left + x + 12) + 'px';
    lineTip.style.top = (box.top + 10) + 'px';
    lineTip.style.display = 'block';
  });
});
over.addEventListener('mouseleave', function () { cancelAnimationFrame(frame); lineTip.style.display = 'none'; });
var bars = document.getElementById('bars'), barTip = document.getElementById('barTip'), paint = bars.getContext('2d'), wait = 0;
sales.forEach(function (v, i) { paint.fillStyle = '#4a7'; paint.fillRect(10 + i * 60, 160 - v / 4, 40, v / 4); });
bars.addEventListener('mousemove', function (event) {
  var box = bars.getBoundingClientRect(), x = event.clientX - box.left;
  clearTimeout(wait);
  wait = setTimeout(function () {
    var i = Math.floor((x - 5) / 60);
    if (i < 0 || i >= sales.length) { barTip.style.display = 'none'; return; }
    barTip.textContent = 'Region ' + (i + 1) + ': ' + sales[i] + ' units';
    barTip.style.left = (box.left + x + 12) + 'px';
    barTip.style.top = (box.top + 10) + 'px';
    barTip.style.display = 'block';
  }, 150);
});
bars.addEventListener('mouseleave', function () { clearTimeout(wait); barTip.style.display = 'none'; });
</script></body></html>`;
    /** Where month `i` is drawn on the line chart, in the viewport. */
    const month = (i: number): { x: number; y: number } => ({ x: LEFT + i * STEP, y: 40 + 100 });
    /** The middle of region `i`'s bar on the canvas, in the viewport. */
    const region = (i: number): { x: number; y: number } => ({ x: 30 + i * 60, y: 40 + 200 + 40 + 150 });
    const tooltips = (tree: AxTree): string[] => [
      ...new Set(walk(tree).flatMap((node) => (/^(\w{3}: \d+ mm|Region \d: \d+ units)$/.test(node.name ?? '') ? [node.name ?? ''] : []))),
    ];
    /** The tooltips the tree shows once the page has run the frame the move scheduled. */
    async function shownAfter(page: CdpPage, deps: AgentDeps): Promise<string[]> {
      // The line chart draws its tooltip on the next animation frame: wait on
      // that frame itself rather than on a guessed duration.
      await page.send('Runtime.evaluate', {
        expression: 'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))',
        awaitPromise: true,
      });
      return tooltips(await deps.snapshot());
    }

    test('a hover at a point shows the value under it, and presses nothing', async () => {
      const page = await chrome.open(`data:text/html,${encodeURIComponent(CHARTS)}`);
      const deps = bind(page);
      expect(tooltips(await deps.snapshot())).toEqual([]);

      await deps.perform({ type: 'hover', at: month(2) });
      expect(await shownAfter(page, deps)).toEqual(['Mar: 37 mm']);
      await deps.perform({ type: 'hover', at: month(10) });
      expect(await shownAfter(page, deps)).toEqual(['Nov: 84 mm']);

      const events = (await evaluate(page, 'JSON.stringify(events)')) as string;
      expect(JSON.parse(events)).toContain('pointermove');
      expect(JSON.parse(events).filter((kind: string) => kind !== 'pointermove')).toEqual([]);
    }, 60_000);

    test('through the loop, the step after a hover is shown the tooltip, a debounced one included', async () => {
      const page = await chrome.open(`data:text/html,${encodeURIComponent(CHARTS)}`);
      const deps = bind(page);
      const seen: string[][] = [];
      const plan: readonly ModelChoice['action'][] = [
        { type: 'hover', at: month(5) },
        { type: 'hover', at: region(3) },
        { type: 'hover', at: month(0) },
      ];
      const result = await runAgent(
        {
          ...deps,
          model: (prompt): ModelChoice => {
            seen.push(tooltips(prompt.tree));
            return { action: plan[prompt.step] ?? { type: 'done', summary: 'read' } };
          },
        },
        { task: 'Read the June rainfall, region 4 sales and January rainfall.', caps: { steps: 6, budget: '1.00', duration: '1m' }, stepFailures: 0 },
      );

      expect(result.steps.map((step) => step.error)).toEqual(result.steps.map(() => undefined));
      // A tooltip leaves when the pointer leaves its chart, so each step
      // shows the one value under the pointer now.
      expect(seen).toEqual([[], ['Jun: 71 mm'], ['Region 4: 520 units'], ['Jan: 52 mm']]);
    }, 60_000);
  });

  describe('a click on a target that is not on screen', () => {
    const page = (style: string, body: string, script = ''): string =>
      `data:text/html,${encodeURIComponent(
        `<!doctype html><html><head><title>Reach</title><style>body{margin:0;font:16px sans-serif}${style}</style></head>` +
          `<body>${body}<script>${script}</script></body></html>`,
      )}`;
    const target = '<a id="t" href="#t" onclick="document.title=\'clicked\';return false">Target link</a>';

    test('scrolls a link below the fold into view and clicks it', async () => {
      const tab = await chrome.open(page('', `<p>Top</p><div style="height:2400px"></div>${target}<div style="height:3000px"></div>`));
      const deps = bind(tab);
      await deps.perform({ type: 'click', ref: nodeNamed(await deps.snapshot(), 'link', 'Target link').ref });
      expect(await evaluate(tab, 'document.title')).toBe('clicked');
      expect(Number(await evaluate(tab, 'scrollY'))).toBeGreaterThan(1500);
    }, 60_000);

    test('clicks a link a sticky header is drawn over', async () => {
      const tab = await chrome.open(
        page(
          'header{position:sticky;top:0;height:120px;background:#eee;z-index:5}',
          `<header>Site header</header><div style="height:1600px"></div>${target}<div style="height:3000px"></div>`,
          "scrollTo(0, document.getElementById('t').offsetTop - 40);",
        ),
      );
      const deps = bind(tab);
      const ref = nodeNamed(await deps.snapshot(), 'link', 'Target link').ref;
      // Under the header as the page stands.
      expect(await evaluate(tab, "document.elementFromPoint(20, document.getElementById('t').getBoundingClientRect().top + 5).tagName")).toBe('HEADER');
      await deps.perform({ type: 'click', ref });
      expect(await evaluate(tab, 'document.title')).toBe('clicked');
    }, 60_000);

    test('under a dialog that holds the page still is refused with the dialog and its close control', async () => {
      // A dialog opened over the page locks its scrolling, as a sign-up
      // prompt does: the wheel moves nothing, and closing it is the way on.
      const tab = await chrome.open(
        page(
          'html.locked,html.locked body{overflow:hidden} #d{position:fixed;inset:20% 20%;background:#fff;border:1px solid}',
          `<div id="d" role="dialog" aria-modal="true" aria-label="Sign up"><button onclick="d.remove();document.documentElement.className=''">Close</button></div>` +
            `<div style="height:2400px"></div>${target}<div style="height:3000px"></div>`,
          "document.documentElement.className='locked';",
        ),
      );
      const deps = bind(tab);
      const ref = nodeNamed(await deps.snapshot(), 'link', 'Target link').ref;
      const error = await Promise.resolve()
        .then(() => deps.perform({ type: 'click', ref }))
        .catch((caught: unknown) => caught);
      expect(String(error)).toContain('the page did not scroll: a dialog open over the page');
      expect(String(error)).toMatch(/Close it with button "Close" \[\d+-\d+\], then try again\./);
      expect(await evaluate(tab, 'document.title')).toBe('Reach');
    }, 60_000);

    test('to the side of the viewport is refused without moving the page, and refusals do not stop the run', async () => {
      // An off-canvas menu: its links are laid out left of the viewport until
      // the page slides it in, and no vertical scroll reaches them.
      const links = ['Home', 'Deals', 'Stores', 'Help', 'Account'].map((name) => `<a href="#${name}">${name}</a>`).join('');
      const tab = await chrome.open(
        page(
          'nav{position:fixed;top:0;left:-320px;width:300px;display:flex;flex-direction:column}',
          `<nav>${links}</nav><h1>Shop</h1><div style="height:600px"></div>${target}<div style="height:3000px"></div>`,
        ),
      );
      const deps = bind(tab);
      const menu = new Set(['Home', 'Deals', 'Stores', 'Help', 'Account']);
      const result = await runAgent(
        {
          ...deps,
          model: (prompt): ModelChoice => {
            // Each refused link leaves the page the model is shown, so the
            // next one is always whichever menu link is still listed.
            const next = walk(prompt.tree).find((node) => node.role === 'link' && menu.has(node.name ?? ''));
            if (next !== undefined) return { action: { type: 'click', ref: next.ref } };
            const link = walk(prompt.tree).find((node) => node.role === 'link' && node.name === 'Target link');
            if (prompt.step < 7 && link !== undefined) return { action: { type: 'click', ref: link.ref } };
            return { action: { type: 'done', summary: 'clicked' } };
          },
        },
        { task: 'Open the target link.', caps: { steps: 10, budget: '5.00', duration: '2m' }, stepFailures: 3 },
      );

      const refused = result.steps.filter((step) => step.error !== undefined);
      expect(refused).toHaveLength(5);
      for (const step of refused) {
        expect(step.error).toContain('left of the viewport');
        expect(step.error).toContain('nothing was dispatched');
      }
      expect(result.stopReason).not.toBe('error');
      expect(await evaluate(tab, 'document.title')).toBe('clicked');
    }, 90_000);
  });
});
