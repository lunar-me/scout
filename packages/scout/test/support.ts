/**
 * Two fakes on real sockets: a chat-completions endpoint
 * that answers from a script, and a CDP browser that serves one scripted page.
 * Scout reaches both exactly as it reaches the real thing, over HTTP and a
 * WebSocket, so a test through them exercises its whole assembly.
 */
import type { Server, ServerWebSocket } from 'bun';

import { isRecord } from '@outcrawl/scout-core';

/* ------------------------------------------------------------------ *
 * The model endpoint
 * ------------------------------------------------------------------ */

export interface ModelCall {
  readonly model: string;
  readonly authorization: string | null;
  /** The JSON Schema the reply was asked for in, when one was. */
  readonly schema: Record<string, unknown> | undefined;
  readonly body: Record<string, unknown>;
}

/** Decides one reply: the JSON text the model "said", or `undefined` to fail the call. */
export type Reply = (call: ModelCall, index: number) => unknown;

export interface FakeModel {
  readonly baseURL: string;
  readonly calls: ModelCall[];
  stop(): void;
}

/** The schema a call asked its reply in: a strict response format's, or the forced tool's parameters. */
function schemaOf(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const format = body['response_format'];
  if (isRecord(format) && isRecord(format['json_schema']) && isRecord(format['json_schema']['schema'])) {
    return format['json_schema']['schema'];
  }
  const tools = body['tools'];
  const tool = Array.isArray(tools) && isRecord(tools[0]) && isRecord(tools[0]['function']) ? tools[0]['function'] : undefined;
  return tool !== undefined && isRecord(tool['parameters']) ? tool['parameters'] : undefined;
}

/** Every message's text in `call`, joined: what the model was shown. */
export function promptOf(call: ModelCall): string {
  const messages = Array.isArray(call.body['messages']) ? call.body['messages'] : [];
  return messages
    .map((message: unknown) => {
      const content = isRecord(message) ? message['content'] : undefined;
      if (typeof content === 'string') return content;
      return Array.isArray(content) ? content.map((part: unknown) => (isRecord(part) && typeof part['text'] === 'string' ? part['text'] : '')).join('\n') : '';
    })
    .join('\n');
}

/** The `[ref]` the page's tree gave the node named `name`, as the model was shown it. */
export function refIn(call: ModelCall, name: string): string {
  const match = new RegExp(`"${name}"[^\\n\\[]*\\[(\\d+-\\d+)\\]`, 'u').exec(promptOf(call));
  if (match?.[1] === undefined) throw new Error(`the prompt shows no ${name}: ${promptOf(call).slice(0, 2000)}`);
  return match[1];
}

/** A step that clicks the node named `name`. */
export function clickOn(name: string): Reply {
  return (call) => ({ reasoning: `press ${name}`, actions: [{ type: 'click', ref: refIn(call, name) }] });
}

/** Whether `call` is an agent step (its reply schema has `actions`). */
export function isStep(call: ModelCall): boolean {
  return isRecord(call.schema?.['properties']) && 'actions' in call.schema['properties'];
}

/** Whether `call` derives a schema from the task. */
export function isSuggestion(call: ModelCall): boolean {
  return isRecord(call.schema?.['properties']) && 'schema' in call.schema['properties'] && !isStep(call);
}

/**
 * A chat-completions endpoint under `/v1`. Agent steps are answered from
 * `steps` in order (a function is called with the request, to read the page
 * it was shown); a schema suggestion gets a small schema; anything else from
 * `other`. `cost` is stated per call when given. `refuse` answers a call
 * 400 the way a gateway refuses a mode it does not support. A reply comes
 * back in the shape it was asked for: a forced tool call, or content.
 */
export function fakeModel(options: {
  readonly steps: readonly (unknown | Reply)[];
  readonly other?: Reply;
  readonly cost?: string;
  readonly refuse?: (call: ModelCall) => boolean;
}): FakeModel {
  const calls: ModelCall[] = [];
  let step = 0;
  const server: Server<undefined> = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
        return new Response('not found', { status: 404 });
      }
      const body: unknown = await request.json();
      if (!isRecord(body)) return new Response('bad body', { status: 400 });
      const call: ModelCall = {
        model: String(body['model']),
        authorization: request.headers.get('authorization'),
        schema: schemaOf(body),
        body,
      };
      calls.push(call);
      if (options.refuse?.(call) === true) {
        return Response.json({ error: { message: 'Provider returned error', code: 400 } }, { status: 400 });
      }
      let content: unknown;
      if (isStep(call)) {
        const scripted = options.steps[step];
        content = typeof scripted === 'function' ? (scripted as Reply)(call, calls.length - 1) : scripted;
        step += 1;
      } else if (isSuggestion(call)) {
        content = { schema: { type: 'object', properties: { answer: { type: 'string' } } } };
      } else {
        content = options.other?.(call, calls.length - 1);
      }
      if (content === undefined) {
        return Response.json({ error: { message: `the script has no reply for call ${String(calls.length)}`, code: 400 } }, { status: 400 });
      }
      return Response.json({
        id: `gen-${String(calls.length)}`,
        model: call.model,
        choices: [
          body['tools'] === undefined
            ? { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) } }
            : {
                index: 0,
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'outcrawl_reply', arguments: JSON.stringify(content) } }],
                },
              },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          ...(options.cost === undefined ? {} : { cost: Number(options.cost) }),
        },
      });
    },
  });
  return { baseURL: `http://127.0.0.1:${String(server.port)}/v1`, calls, stop: () => void server.stop(true) };
}

/* ------------------------------------------------------------------ *
 * The CDP browser
 * ------------------------------------------------------------------ */

type Params = Record<string, unknown>;

export interface CdpLog {
  readonly method: string;
  readonly sessionId: string | undefined;
  readonly params: Params;
}

export interface FakeBrowser {
  /** `ws://` for the browser target. */
  readonly wsEndpoint: string;
  /** `http://` serving `/json/version`. */
  readonly httpEndpoint: string;
  readonly log: CdpLog[];
  /** Whether the page's "More" button has been clicked. */
  clicked(): boolean;
  /** WebSockets currently open to this browser. */
  openSockets(): number;
  /** Targets alive, by id. */
  targets(): readonly string[];
  stop(): void;
}

const QUAD = [100, 200, 260, 200, 260, 240, 100, 240];

/** One `Accessibility.AXNode`. */
function axNode(id: number, role: string, name: string, childIds: readonly number[], parentId?: number): Params {
  return {
    nodeId: String(id),
    ignored: false,
    role: { type: 'role', value: role },
    name: { type: 'computedString', value: name },
    backendDOMNodeId: id,
    childIds: childIds.map(String),
    ...(parentId === undefined ? {} : { parentId: String(parentId) }),
  };
}

/**
 * A stock Chromium holding one page: a list with a "More" button that, once
 * clicked, shows "All stories loaded". It speaks only stock CDP: its tree is
 * `Accessibility.getFullAXTree`, its input `Input.dispatchMouseEvent`.
 */
export function fakeBrowser(): FakeBrowser {
  const log: CdpLog[] = [];
  const sockets = new Set<ServerWebSocket<undefined>>();
  const targets = new Map<string, string>();
  let clicked = false;
  let nextTarget = 1;

  const axTree = (): Params => ({
    nodes: [
      axNode(1, 'RootWebArea', 'News', [3, clicked ? 4 : 2]),
      axNode(3, 'heading', 'Rewriting our parser cut cold builds by 41%', [], 1),
      clicked ? axNode(4, 'StaticText', 'All stories loaded', [], 1) : axNode(2, 'button', 'More', [], 1),
    ],
  });

  const answer = (method: string, params: Params): Params | { error: string } => {
    switch (method) {
      case 'Browser.getVersion':
        return { product: 'FakeChrome/1.0', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) FakeChrome/1.0' };
      case 'Target.createTarget': {
        const targetId = `TARGET-${String(nextTarget++)}`;
        targets.set(targetId, '');
        return { targetId };
      }
      case 'Target.attachToTarget': {
        const targetId = String(params['targetId']);
        const session = `SESSION-${targetId}`;
        targets.set(targetId, session);
        return { sessionId: session };
      }
      case 'Target.closeTarget':
        targets.delete(String(params['targetId']));
        return { success: true };
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'FRAME-0', url: 'https://news.test/' } } };
      case 'Accessibility.getFullAXTree':
        return axTree();
      case 'DOMSnapshot.captureSnapshot':
        return { error: 'DOMSnapshot is not served by this fake' };
      case 'Page.getLayoutMetrics':
        return {
          cssLayoutViewport: { clientWidth: 1280, clientHeight: 800, pageX: 0, pageY: 0 },
          cssVisualViewport: { clientWidth: 1280, clientHeight: 800, pageX: 0, pageY: 0, offsetX: 0, offsetY: 0, scale: 1, zoom: 1 },
          cssContentSize: { x: 0, y: 0, width: 1280, height: 800 },
        };
      case 'DOM.getBoxModel':
        return { model: { content: QUAD, padding: QUAD, border: QUAD, margin: QUAD, width: 160, height: 40 } };
      case 'DOM.describeNode':
        return { node: { backendNodeId: 2, nodeType: 1, nodeName: 'BUTTON', localName: 'button', attributes: [] } };
      case 'DOM.getNodeForLocation':
        return { backendNodeId: clicked ? 4 : 2, frameId: 'FRAME-0' };
      case 'Runtime.evaluate':
        return { result: { type: 'object', value: { readyState: 'complete', url: 'https://news.test/', title: 'News' } } };
      case 'Input.dispatchMouseEvent':
        if (params['type'] === 'mouseReleased') clicked = true;
        return {};
      default:
        return method.startsWith('Outcrawl.') ? { error: `'${method}' wasn't found` } : {};
    }
  };

  const server: Server<undefined> = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, srv) {
      const url = new URL(request.url);
      if (url.pathname === '/json/version') {
        return Response.json({ Browser: 'FakeChrome/1.0', webSocketDebuggerUrl: `ws://127.0.0.1:${String(srv.port)}/devtools/browser/fake` });
      }
      if (srv.upgrade(request)) return undefined;
      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, data) {
        const frame: unknown = JSON.parse(String(data));
        if (!isRecord(frame) || typeof frame['id'] !== 'number' || typeof frame['method'] !== 'string') return;
        const params = isRecord(frame['params']) ? frame['params'] : {};
        const sessionId = typeof frame['sessionId'] === 'string' ? frame['sessionId'] : undefined;
        log.push({ method: frame['method'], sessionId, params });
        const result = answer(frame['method'], params);
        ws.send(
          JSON.stringify(
            'error' in result && typeof result.error === 'string'
              ? { id: frame['id'], error: { code: -32601, message: result.error } }
              : { id: frame['id'], result, ...(sessionId === undefined ? {} : { sessionId }) },
          ),
        );
      },
    },
  });

  return {
    wsEndpoint: `ws://127.0.0.1:${String(server.port)}/devtools/browser/fake`,
    httpEndpoint: `http://127.0.0.1:${String(server.port)}`,
    log,
    clicked: () => clicked,
    openSockets: () => sockets.size,
    targets: () => [...targets.keys()],
    stop: () => void server.stop(true),
  };
}

/** A role on the fake endpoint. */
export function role(model: FakeModel, id: string): { model: string; baseURL: string; apiKey: string } {
  return { model: id, baseURL: model.baseURL, apiKey: `key-for-${id}` };
}
