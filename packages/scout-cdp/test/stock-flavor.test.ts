import { describe, expect, test } from 'bun:test';

import { nodeRef } from '@outcrawl/runtime';
import type { Clock } from '@outcrawl/scout-core';

import { bindAgent, createStockFlavor, outcrawlFlavor, type CdpFlavor, type CdpPage, type HandsPort, type HandsStep } from '../src/index';
import { frameOrdinalOf } from '../src/flavors/stock-ax';

interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown> | undefined;
  readonly at: number;
}

type Script = Record<string, ((params: Record<string, unknown>) => Record<string, unknown>) | undefined>;

/** A clock whose `sleep` advances it, so a test can read when each command went out. */
function steppedClock(): { now(): number; sleep(ms: number): Promise<void> } {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
}

const instant: Clock = { now: () => 0, sleep: async () => undefined };

/** A page that records every command and replies from `script` (`{}` otherwise). `costMs` is each reply's latency on `clock`. */
function fakePage(script: Script, clock: Clock = instant, costMs = 0): { readonly page: CdpPage; readonly sent: Sent[] } {
  const sent: Sent[] = [];
  const page: CdpPage = {
    targetId: 'MAIN',
    sessionId: 'SESSION-MAIN',
    url: () => 'https://shop.test/cart#top',
    async send(method, params) {
      sent.push({ method, params, at: clock.now() });
      if (costMs > 0) await clock.sleep(costMs);
      return script[method]?.(params ?? {}) ?? {};
    },
    async sendBrowser(method, params) {
      sent.push({ method, params, at: clock.now() });
      return {};
    },
    on: () => () => undefined,
  };
  return { page, sent };
}

/* ------------------------------------------------------------------ *
 * One page, two ways: what stock CDP answers, and what the fork answers
 * ------------------------------------------------------------------ */

interface AxSpec {
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly ignored?: boolean;
  readonly props?: Record<string, unknown>;
  readonly children?: readonly number[];
  /** `null` for a node with no DOM node (an inline text box). */
  readonly backend?: number | null;
}

/** `Accessibility.getFullAXTree`'s reply for `nodes`, root first. */
function axReply(nodes: Record<number, AxSpec>): Record<string, unknown> {
  const parentOf = new Map<number, number>();
  for (const [id, spec] of Object.entries(nodes)) for (const child of spec.children ?? []) parentOf.set(child, Number(id));
  return {
    nodes: Object.entries(nodes).map(([key, spec]) => {
      const id = Number(key);
      const parent = parentOf.get(id);
      return {
        nodeId: String(id),
        ignored: spec.ignored ?? false,
        role: { type: 'role', value: spec.role },
        ...(spec.name === undefined ? {} : { name: { type: 'computedString', value: spec.name } }),
        ...(spec.value === undefined ? {} : { value: { type: 'string', value: spec.value } }),
        properties: Object.entries(spec.props ?? {}).map(([name, value]) => ({ name, value: { type: 'boolean', value } })),
        childIds: (spec.children ?? []).map(String),
        ...(spec.backend === null ? {} : { backendDOMNodeId: spec.backend ?? id }),
        ...(parent === undefined ? {} : { parentId: String(parent) }),
      };
    }),
  };
}

// Root first: the document's node is the one with no parent.
const MAIN_AX: Record<number, AxSpec> = {
  1: { role: 'RootWebArea', name: 'Cart', props: { focusable: true, focused: true }, children: [2] },
  2: { role: 'none', ignored: true, children: [3, 10, 20, 25, 30, 40, 50] },
  3: { role: 'heading', name: 'Your cart', children: [4] },
  4: { role: 'StaticText', name: 'Your cart', children: [-1000000001] },
  [-1000000001]: { role: 'InlineTextBox', name: 'Your cart', backend: null },
  10: { role: 'textbox', name: 'Email', value: 'a@b.co', props: { invalid: 'false', required: true, focused: true, readonly: false, multiline: false }, children: [11] },
  11: { role: 'generic', name: '' },
  20: { role: 'LabelText', name: '', children: [21] },
  21: { role: 'StaticText', name: ' Gift \n wrap ' },
  25: { role: 'combobox', name: 'Size', value: 'Small', props: { expanded: false, invalid: 'false' }, children: [26] },
  26: { role: 'MenuListPopup', name: '', children: [27, 28] },
  27: { role: 'option', name: 'Small', props: { selected: true } },
  28: { role: 'option', name: 'Medium', props: { selected: false } },
  30: { role: 'Iframe', name: '' },
  40: { role: 'button', name: 'Pay   now', props: { disabled: true }, children: [41] },
  41: { role: 'StaticText', name: 'Pay now' },
  50: { role: 'generic', name: '', children: [51] },
  51: { role: 'button', name: 'Ghost' },
};

const CHILD_AX: Record<number, AxSpec> = {
  101: { role: 'RootWebArea', name: 'Widget', children: [102] },
  102: { role: 'button', name: 'Apply', props: { pressed: 'true' }, children: [103] },
  103: { role: 'StaticText', name: 'Apply' },
};

/** One `DOMSnapshot` document: `[backendNodeId, parentIndex, nodeType, nodeName, attributes, layout?]` rows. */
type DomRow = readonly [number, number, number, string, readonly string[], (readonly [string, string])?];

function snapshotReply(documents: readonly { frameId: string; rows: readonly DomRow[]; clickable: number[]; checked: number[]; content?: [number, number] }[]): Record<string, unknown> {
  const strings: string[] = [];
  const at = (text: string): number => {
    const found = strings.indexOf(text);
    if (found >= 0) return found;
    strings.push(text);
    return strings.length - 1;
  };
  return {
    documents: documents.map((document) => {
      const laidOut = document.rows.flatMap((row, index) => (row[5] === undefined ? [] : [[index, row[5]] as const]));
      return {
        frameId: at(document.frameId),
        nodes: {
          backendNodeId: document.rows.map((row) => row[0]),
          parentIndex: document.rows.map((row) => row[1]),
          nodeType: document.rows.map((row) => row[2]),
          nodeName: document.rows.map((row) => at(row[3])),
          attributes: document.rows.map((row) => row[4].map(at)),
          isClickable: { index: document.clickable },
          inputChecked: { index: document.checked },
          contentDocumentIndex: document.content === undefined ? { index: [], value: [] } : { index: [document.content[0]], value: [document.content[1]] },
        },
        layout: { nodeIndex: laidOut.map(([index]) => index), styles: laidOut.map(([, style]) => [at(style[0]), at(style[1])]) },
      };
    }),
    strings,
  };
}

const SHOWN = ['visible', '1'] as const;

const SNAPSHOT = snapshotReply([
  {
    frameId: 'MAIN',
    rows: [
      [1, -1, 9, '#document', []],
      [6, 0, 1, 'HTML', [], SHOWN],
      [7, 1, 1, 'BODY', [], SHOWN],
      [3, 2, 1, 'H1', [], SHOWN],
      [4, 3, 3, '#text', [], SHOWN],
      [10, 2, 1, 'INPUT', ['id', 'email', 'type', 'email'], SHOWN],
      [20, 2, 1, 'LABEL', [], SHOWN],
      [22, 6, 1, 'INPUT', ['type', 'checkbox', 'style', 'display:none']],
      [21, 6, 3, '#text', [], SHOWN],
      [25, 2, 1, 'SELECT', ['name', 'size'], SHOWN],
      [27, 9, 1, 'OPTION', ['value', 's'], SHOWN],
      [28, 9, 1, 'OPTION', ['value', 'm'], SHOWN],
      [30, 2, 1, 'IFRAME', ['src', '/widget'], SHOWN],
      [40, 2, 1, 'BUTTON', ['data-testid', 'pay', 'disabled', ''], SHOWN],
      [41, 13, 3, '#text', [], SHOWN],
      [50, 2, 1, 'DIV', ['style', 'opacity:0'], ['visible', '0']],
      [51, 15, 1, 'BUTTON', ['type', 'button'], SHOWN],
    ],
    clickable: [5, 6, 7, 9, 13, 16],
    checked: [7],
    content: [12, 1],
  },
  {
    frameId: 'CHILD',
    rows: [
      [100, -1, 9, '#document', []],
      [104, 0, 1, 'HTML', [], SHOWN],
      [105, 1, 1, 'BODY', [], SHOWN],
      [102, 2, 1, 'BUTTON', ['name', 'apply'], SHOWN],
      [103, 3, 3, '#text', [], SHOWN],
    ],
    clickable: [3],
    checked: [],
  },
]);

const FRAME_TREE = {
  frameTree: {
    frame: { id: 'MAIN', url: 'https://shop.test/cart', urlFragment: '#top' },
    childFrames: [{ frame: { id: 'CHILD', parentId: 'MAIN', url: 'https://shop.test/widget' } }],
  },
};

const STOCK_PAGE: Script = {
  'Page.getFrameTree': () => FRAME_TREE,
  'DOMSnapshot.captureSnapshot': () => SNAPSHOT,
  'Accessibility.getFullAXTree': (params) => axReply(params['frameId'] === 'CHILD' ? CHILD_AX : MAIN_AX),
};

/**
 * What the fork's `Outcrawl.getAXTree` answers for the same page, by its own
 * rules: the ignored wrapper, the empty label and the iframe's document are
 * passed through, text repeating its container's name is dropped, names are
 * whitespace-collapsed, every laid-out node carries its paint state, the
 * label text carries its hidden checkbox, the toggle's pressed state is its
 * checked state, and the child frame's nodes carry the child frame's ordinal.
 */
function forkPayload(): Record<string, unknown> {
  const main = frameOrdinalOf('MAIN');
  const child = frameOrdinalOf('CHILD');
  const shown = { paintHidden: false };
  return {
    url: 'https://shop.test/cart#top',
    frameOrdinals: [main, child],
    root: {
      ref: `${String(main)}-1`,
      role: 'RootWebArea',
      xpath: '',
      name: 'Cart',
      children: [
        { ref: `${String(main)}-3`, role: 'heading', xpath: '', name: 'Your cart', state: shown },
        {
          ref: `${String(main)}-10`,
          role: 'textbox',
          xpath: '//*[@id="email"]',
          name: 'Email',
          value: 'a@b.co',
          state: { required: true, focused: true, paintHidden: false },
        },
        { ref: `${String(main)}-21`, role: 'StaticText', xpath: '', name: 'Gift wrap', state: { paintHidden: false, pointable: true, checked: 'true' } },
        {
          ref: `${String(main)}-25`,
          role: 'combobox',
          xpath: '//select[@name="size"]',
          name: 'Size',
          value: 'Small',
          state: { expanded: false, paintHidden: false },
          children: [
            { ref: `${String(main)}-27`, role: 'option', xpath: '', name: 'Small', state: { selected: true, paintHidden: false } },
            { ref: `${String(main)}-28`, role: 'option', xpath: '', name: 'Medium', state: { selected: false, paintHidden: false } },
          ],
        },
        { ref: `${String(child)}-102`, role: 'button', xpath: '//button[@name="apply"]', name: 'Apply', state: { checked: 'true', paintHidden: false } },
        { ref: `${String(main)}-40`, role: 'button', xpath: '//button[@data-testid="pay"]', name: 'Pay now', state: { disabled: true, paintHidden: false } },
        { ref: `${String(main)}-51`, role: 'button', xpath: '//button[@type="button"]', name: 'Ghost', state: { paintHidden: true } },
      ],
    },
  };
}

const UNBOUND = { model: null, tabs: null, files: null, clock: instant } as const;

const STOCK_DOMAINS = /^(Accessibility|DOM|DOMSnapshot|Input|Page|Runtime|Target|Emulation|Network)\./;

describe('the stock tree is the fork tree', () => {
  test('one page snapshots identically through the stock flavor and through the fork', async () => {
    const stock = await bindAgent(fakePage(STOCK_PAGE).page, { ...UNBOUND, flavor: createStockFlavor({ clock: instant }) }).snapshot();
    const fork = await bindAgent(fakePage({ 'Outcrawl.getAXTree': forkPayload }).page, { ...UNBOUND, flavor: outcrawlFlavor }).snapshot();

    expect(stock).toEqual(fork);
    expect(await createStockFlavor().axTree(fakePage(STOCK_PAGE).page, {})).toEqual(forkPayload());
  });

  test('a tree past maxNodes is refused, not truncated', async () => {
    await expect(createStockFlavor().axTree(fakePage(STOCK_PAGE).page, { maxNodes: 3 })).rejects.toThrow('exceeded maxNodes (3)');
  });

  test("the frame ordinal is the session's own frame, numbered as its references are", async () => {
    const flavor = createStockFlavor();
    expect(await flavor.frameOrdinal(fakePage(STOCK_PAGE).page)).toEqual({ frameOrdinal: frameOrdinalOf('MAIN'), frameId: 'MAIN' });
    const nested = fakePage({ 'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'CHILD', parentId: 'MAIN', url: 'https://pay.test/' } } }) });
    expect(await flavor.frameOrdinal(nested.page)).toEqual({
      frameOrdinal: frameOrdinalOf('CHILD'),
      frameId: 'CHILD',
      parentFrameOrdinal: frameOrdinalOf('MAIN'),
    });
  });
});

const quad = [100, 200, 260, 200, 260, 240, 100, 240];

const CLICK_PLAN: readonly HandsStep[] = [
  {
    command: 'Outcrawl.dispatchPointerPath',
    params: { path: [{ x: 20, y: 20, offsetMs: 0 }, { x: 90, y: 150, offsetMs: 8 }, { x: 150, y: 220, offsetMs: 16 }], pointerType: 'mouse' },
  },
  { command: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 150, y: 220, button: 'left', buttons: 1, clickCount: 1, force: 0.5 }, delayMs: 40 },
  { command: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 150, y: 220, button: 'left', buttons: 0, clickCount: 1 }, delayMs: 80 },
];

const SCROLL_PLAN: readonly HandsStep[] = [
  {
    command: 'Outcrawl.dispatchWheelPath',
    params: { x: 640, y: 400, path: [{ offsetMs: 0, phase: 'began' }, { offsetMs: 16, deltaY: 120, phase: 'changed' }, { offsetMs: 40, phase: 'ended' }] },
  },
];

const hands: HandsPort = {
  click: () => CLICK_PLAN,
  hover: () => CLICK_PLAN,
  scroll: () => SCROLL_PLAN,
  drag: () => CLICK_PLAN,
  type: () => CLICK_PLAN,
  press: () => CLICK_PLAN,
};

describe('the stock flavor speaks only stock CDP', () => {
  test('a snapshot, the lock pair, a click and a scroll send stock commands only, and no freeze', async () => {
    const fake = fakePage({
      ...STOCK_PAGE,
      'Page.getLayoutMetrics': () => ({ cssLayoutViewport: { clientWidth: 1280, clientHeight: 800, pageX: 0, pageY: 0 } }),
      'DOM.getBoxModel': () => ({ model: { content: quad, border: quad, width: 160, height: 40 } }),
      'DOM.describeNode': () => ({ node: { backendNodeId: 10, nodeType: 1, nodeName: 'INPUT', attributes: [] } }),
      'DOM.getNodeForLocation': () => ({ backendNodeId: 10, frameId: 'MAIN' }),
    });
    const flavor: CdpFlavor = createStockFlavor({ clock: instant });
    const deps = bindAgent(fake.page, { ...UNBOUND, hands, flavor });

    await deps.snapshot();
    await deps.lock?.();
    await deps.perform({ type: 'click', ref: nodeRef(frameOrdinalOf('MAIN'), 10) });
    await deps.perform({ type: 'scroll', dy: 120 });
    await deps.unlock?.();

    const methods = fake.sent.map((entry) => entry.method);
    expect(methods.filter((method) => !STOCK_DOMAINS.test(method))).toEqual([]);
    const mouse = fake.sent.filter((entry) => entry.method === 'Input.dispatchMouseEvent').map((entry) => entry.params?.['type']);
    expect(mouse).toEqual(['mouseMoved', 'mouseMoved', 'mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel']);
  });
});

describe('input paths go out at their planned offsets', () => {
  test('a held pointer path is one move per sample, at its offset from the first, holding the button', async () => {
    const clock = steppedClock();
    // Each reply costs 5 ms: a slow reply delays nothing behind it past its own offset.
    const fake = fakePage({}, clock, 5);
    await createStockFlavor({ clock }).dispatch(fake.page, {
      command: 'Outcrawl.dispatchPointerPath',
      params: { path: [{ x: 10, y: 10, offsetMs: 0 }, { x: 20, y: 12, offsetMs: 8 }, { x: 30, y: 15, offsetMs: 21, pressure: 0.7 }], buttons: 1 },
    });
    expect(fake.sent.map(({ method, params, at }) => ({ method, at, params }))).toEqual([
      { method: 'Input.dispatchMouseEvent', at: 0, params: { type: 'mouseMoved', x: 10, y: 10, button: 'left', buttons: 1, pointerType: 'mouse', force: 0.5 } },
      { method: 'Input.dispatchMouseEvent', at: 8, params: { type: 'mouseMoved', x: 20, y: 12, button: 'left', buttons: 1, pointerType: 'mouse', force: 0.5 } },
      { method: 'Input.dispatchMouseEvent', at: 21, params: { type: 'mouseMoved', x: 30, y: 15, button: 'left', buttons: 1, pointerType: 'mouse', force: 0.7 } },
    ]);
  });

  test('a wheel path is one wheel event per moving sample at its offset, and lasts as long as its plan', async () => {
    const clock = steppedClock();
    const fake = fakePage({}, clock);
    await createStockFlavor({ clock }).dispatch(fake.page, {
      command: 'Outcrawl.dispatchWheelPath',
      params: {
        x: 100,
        y: 200,
        modifiers: 8,
        path: [
          { offsetMs: 0, phase: 'began' },
          { offsetMs: 12, deltaY: 40, phase: 'changed' },
          { offsetMs: 30, deltaX: 3, deltaY: 25, phase: 'changed' },
          { offsetMs: 45, phase: 'ended' },
        ],
      },
    });
    expect(fake.sent.map(({ params, at }) => ({ at, params }))).toEqual([
      { at: 12, params: { type: 'mouseWheel', x: 100, y: 200, deltaX: 0, deltaY: 40, modifiers: 8, pointerType: 'mouse' } },
      { at: 30, params: { type: 'mouseWheel', x: 100, y: 200, deltaX: 3, deltaY: 25, modifiers: 8, pointerType: 'mouse' } },
    ]);
    expect(clock.now()).toBe(45);
  });
});
