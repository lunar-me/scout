import { describe, expect, test } from 'bun:test';

import { nodeRef, type AgentPrompt } from '@outcrawl/runtime';

import { NoModelError, bindAgent, type CdpFlavor, type CdpPage, type HandsPort, type HandsStep } from '../src/index';

interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown> | undefined;
}

type Script = Record<string, ((params: Record<string, unknown>) => Record<string, unknown>) | undefined>;

/** A page that records every command and replies from `script` (`{}` otherwise). */
interface FakePage {
  readonly page: CdpPage;
  readonly sent: Sent[];
}

function fakePage(script: Script): FakePage {
  const sent: Sent[] = [];
  const handlers = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  let url = 'https://shop.test/';
  const emit = (method: string, params: Record<string, unknown>): void => {
    for (const handler of handlers.get(method) ?? []) handler(params);
  };
  const page: CdpPage = {
    targetId: 'TARGET-1',
    sessionId: 'SESSION-1',
    url: () => url,
    async send(method, params) {
      sent.push({ method, params });
      const reply = script[method]?.(params ?? {}) ?? {};
      if (method === 'Page.navigate' && reply['errorText'] === undefined) {
        url = String(params?.['url']);
        queueMicrotask(() => emit('Page.frameNavigated', { frame: { id: 'TARGET-1', url } }));
      }
      return reply;
    },
    async sendBrowser(method, params) {
      sent.push({ method, params });
      return {};
    },
    on(method, handler) {
      const set = handlers.get(method) ?? new Set();
      handlers.set(method, set);
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
  };
  return { page, sent };
}

const TREE = {
  url: 'https://shop.test/',
  frameOrdinals: [0],
  root: {
    ref: '0-1',
    role: 'RootWebArea',
    name: 'Shop',
    xpath: '/html',
    children: [{ ref: '0-2', role: 'button', name: 'Add to cart', xpath: '/html/body/button[1]' }],
  },
};

const quad = [100, 200, 260, 200, 260, 240, 100, 240];

/** A browser with no `Outcrawl` domain: every fork read and freeze goes by another name. */
const OTHER: CdpFlavor = {
  name: 'other',
  axTree: (session, params) => session.send('Other.tree', params),
  frameOrdinal: (session) => session.send('Other.frame'),
  lock: 'Other.freeze',
  unlock: 'Other.thaw',
  lockReleased: 'Other.thawed',
  dispatch: (session, step) => session.send(`Other.${step.command.split('.')[1] ?? ''}`, step.params),
  challengeSolving: 'Other.held',
  networkEvents: [],
};

const PLAN: readonly HandsStep[] = [
  { command: 'Outcrawl.dispatchPointerPath', params: { path: [{ x: 150, y: 220, offsetMs: 0 }], pointerType: 'mouse' } },
  { command: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 150, y: 220, button: 'left', buttons: 1, clickCount: 1 } },
  { command: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 150, y: 220, button: 'left', buttons: 0, clickCount: 1 } },
];

const hands: HandsPort = {
  click: () => PLAN,
  hover: () => PLAN,
  scroll: () => PLAN,
  drag: () => PLAN,
  type: () => PLAN,
  press: () => PLAN,
};

const instant = { now: (): number => 0, sleep: async (): Promise<void> => undefined };

const UNBOUND = { model: null, tabs: null, files: null, clock: instant } as const;

describe('the browser is reached only through its flavor', () => {
  test('a snapshot, a click and the lock pair send the flavor\'s commands and never an Outcrawl one', async () => {
    const fake = fakePage({
      'Other.tree': () => TREE,
      'Other.frame': () => ({ frameOrdinal: 0, frameId: 'FRAME-0' }),
      'Page.getLayoutMetrics': () => ({ cssLayoutViewport: { clientWidth: 1280, clientHeight: 800, pageX: 0, pageY: 0 } }),
      'DOM.getBoxModel': () => ({ model: { content: quad, border: quad, width: 160, height: 40 } }),
      'DOM.describeNode': () => ({ node: { backendNodeId: 2, nodeType: 1, nodeName: 'BUTTON', attributes: [] } }),
      'DOM.getNodeForLocation': () => ({ backendNodeId: 2, frameId: 'FRAME-0' }),
    });
    const deps = bindAgent(fake.page, { ...UNBOUND, hands, flavor: OTHER });

    const tree = await deps.snapshot();
    await deps.lock?.();
    await deps.perform({ type: 'click', ref: nodeRef(0, 2) });
    await deps.unlock?.();

    expect(tree.root.children?.[0]?.name).toBe('Add to cart');
    const methods = fake.sent.map((entry) => entry.method);
    expect(methods.filter((method) => method.startsWith('Outcrawl.'))).toEqual([]);
    expect(methods).toContain('Other.dispatchPointerPath');
    expect(methods.filter((method) => method === 'Other.freeze' || method === 'Other.thaw')).toEqual([
      'Other.freeze',
      'Other.thaw',
      'Other.freeze',
      'Other.thaw',
    ]);
  });
});

describe('a missing hook is the portable behaviour', () => {
  test('a failed navigate throws the browser\'s own reason when no exit hook answers it, and the hook\'s error when one does', async () => {
    const failing = (): FakePage => fakePage({ 'Page.navigate': () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }) });

    const plain = bindAgent(failing().page, UNBOUND);
    await expect(plain.perform({ type: 'navigate', url: 'https://nowhere.test/' })).rejects.toThrow(
      'navigate(https://nowhere.test/) failed: net::ERR_NAME_NOT_RESOLVED',
    );

    const moved = new Error('moved to another network');
    const hooked = bindAgent(failing().page, {
      ...UNBOUND,
      hooks: { tab: () => ({ exits: { failed: async (load) => (load.netError === 'net::ERR_NAME_NOT_RESOLVED' ? moved : undefined) } }) },
    });
    await expect(hooked.perform({ type: 'navigate', url: 'https://nowhere.test/' })).rejects.toBe(moved);
  });

  test('the tree a model sees passes through the masking hook, and through nothing without one', async () => {
    const script: Script = { 'Outcrawl.getAXTree': () => TREE };
    const shown = await bindAgent(fakePage(script).page, UNBOUND).snapshot();
    expect(shown.root.children?.[0]?.name).toBe('Add to cart');

    const masked = await bindAgent(fakePage(script).page, {
      ...UNBOUND,
      hooks: { tab: () => ({ masking: { tree: (tree) => ({ ...tree, root: { ...tree.root, children: [] } }) } }) },
    }).snapshot();
    expect(masked.root.children).toEqual([]);
  });

  test('a step that needs a model refuses by name when none was given, or with the host\'s own error', async () => {
    const prompt = {} as AgentPrompt;
    await expect(bindAgent(fakePage({}).page, UNBOUND).model(prompt)).rejects.toBeInstanceOf(NoModelError);

    const own = new Error('this host has no model configured');
    await expect(bindAgent(fakePage({}).page, { ...UNBOUND, hooks: { modelUnavailable: () => own } }).model(prompt)).rejects.toBe(own);
  });
});
