/**
 * A CDP client over one WebSocket: commands with deadlines, flat sessions,
 * and events routed by session. It is the whole of what `@outcrawl/scout-cdp`
 * needs from a connection (see its `CdpPage`), and it uses the runtime's own
 * global `WebSocket`, so Scout carries no socket dependency.
 *
 * Errors are told apart by `name`, which is how the binding and the agent loop
 * read them: `CdpError` (the browser refused), `CdpTimeoutError` (it did not
 * answer in time, carrying `method`), `CdpClosedError` (the socket went) and
 * `CdpTargetGoneError` (the page a command was sent to went away first).
 */
import type { CdpPage } from '@outcrawl/scout-cdp';
import { isRecord } from '@outcrawl/scout-core';

type Params = Record<string, unknown>;
type Handler = (params: Params) => void;

/** The browser refused a command. */
export class CdpError extends Error {
  override readonly name = 'CdpError';
  readonly method: string;
  readonly code: number;

  constructor(method: string, code: number, message: string) {
    super(`${method} failed (${String(code)}): ${message}`);
    this.method = method;
    this.code = code;
  }
}

/** A command went unanswered past its deadline. */
export class CdpTimeoutError extends Error {
  override readonly name = 'CdpTimeoutError';
  readonly method: string;

  constructor(method: string, timeoutMs: number) {
    super(`${method} did not answer within ${String(timeoutMs)}ms`);
    this.method = method;
  }
}

/** The connection to the browser closed. */
export class CdpClosedError extends Error {
  override readonly name = 'CdpClosedError';

  constructor(reason: string) {
    super(`the CDP connection closed: ${reason}`);
  }
}

/** The page a command was sent to went away before it answered. */
export class CdpTargetGoneError extends Error {
  override readonly name = 'CdpTargetGoneError';
  readonly method: string;

  constructor(method: string) {
    super(`${method} was not answered: the page it was sent to went away first`);
    this.method = method;
  }
}

interface Pending {
  readonly method: string;
  readonly sessionId: string | undefined;
  readonly resolve: (value: Params) => void;
  readonly reject: (error: Error) => void;
  /** Stops the deadline. */
  readonly settle: () => void;
}

export interface CdpConnectionOptions {
  /** How long the socket may take to open. Default 15 s. */
  readonly openTimeoutMs?: number;
  /** Per-command deadline. Default 30 s; `0` disables it. */
  readonly commandTimeoutMs?: number;
}

const DEFAULT_OPEN_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export class CdpConnection {
  readonly #socket: WebSocket;
  readonly #commandTimeoutMs: number;
  readonly #pending = new Map<number, Pending>();
  /** Event handlers by `${sessionId ?? ''} ${method}`. */
  readonly #handlers = new Map<string, Set<Handler>>();
  #nextId = 1;
  #closed: string | undefined;

  private constructor(socket: WebSocket, commandTimeoutMs: number) {
    this.#socket = socket;
    this.#commandTimeoutMs = commandTimeoutMs;
    socket.addEventListener('message', (event) => {
      this.#receive(event.data);
    });
    socket.addEventListener('close', (event) => {
      this.#fail(`close ${String(event.code)}${event.reason === '' ? '' : ` ${event.reason}`}`);
    });
    socket.addEventListener('error', () => {
      this.#fail('socket error');
    });
  }

  /** Opens a connection to a browser's `webSocketDebuggerUrl`. */
  static async open(endpoint: string, options: CdpConnectionOptions = {}): Promise<CdpConnection> {
    const socket = new WebSocket(endpoint);
    const openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      cleanup();
      socket.close();
      reject(new Error(`no CDP connection to ${redact(endpoint)} within ${String(openTimeoutMs)}ms`));
    }, openTimeoutMs);
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onFail = (): void => {
      cleanup();
      reject(new Error(`could not connect to the CDP endpoint ${redact(endpoint)}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onFail);
      socket.removeEventListener('close', onFail);
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onFail);
    socket.addEventListener('close', onFail);
    await promise;
    return new CdpConnection(socket, options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  }

  /** Whether the socket has closed. */
  get closed(): boolean {
    return this.#closed !== undefined;
  }

  send(method: string, params?: Params, sessionId?: string): Promise<Params> {
    if (this.#closed !== undefined) {
      return Promise.reject(new CdpClosedError(this.#closed));
    }
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<Params>();
    const timer =
      this.#commandTimeoutMs > 0
        ? setTimeout(() => {
            this.#pending.delete(id);
            reject(new CdpTimeoutError(method, this.#commandTimeoutMs));
          }, this.#commandTimeoutMs)
        : undefined;
    this.#pending.set(id, { method, sessionId, resolve, reject, settle: () => clearTimeout(timer) });
    this.#socket.send(
      JSON.stringify({ id, method, ...(params === undefined ? {} : { params }), ...(sessionId === undefined ? {} : { sessionId }) }),
    );
    return promise;
  }

  /** Subscribes to `method` on `sessionId` (absent: the browser target). Returns the unsubscribe. */
  on(method: string, handler: Handler, sessionId?: string): () => void {
    const key = `${sessionId ?? ''} ${method}`;
    let set = this.#handlers.get(key);
    if (set === undefined) {
      set = new Set();
      this.#handlers.set(key, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /** A page on this connection: `targetId` with the flat session `sessionId` already attached. */
  page(targetId: string, sessionId: string, url = 'about:blank'): CdpPage {
    let current = url;
    // The main frame's navigations keep `url()` current without asking the
    // page, which a frozen renderer could not answer.
    this.on(
      'Page.frameNavigated',
      (params) => {
        const frame = params['frame'];
        if (!isRecord(frame) || frame['parentId'] !== undefined) return;
        const next = frame['url'];
        if (typeof next === 'string' && next !== '') current = next;
      },
      sessionId,
    );
    return {
      targetId,
      sessionId,
      url: () => current,
      send: (method, params) => this.send(method, params, sessionId),
      sendBrowser: (method, params) => this.send(method, params),
      on: (method, handler) => this.on(method, handler, sessionId),
      forSession: (childSession, childTarget) => this.page(childTarget, childSession),
    };
  }

  close(): void {
    this.#fail('closed by Scout');
    try {
      this.#socket.close();
    } catch {
      // Already closing.
    }
  }

  #receive(data: unknown): void {
    let frame: unknown;
    try {
      frame = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer));
    } catch {
      return;
    }
    if (!isRecord(frame)) return;
    const id = frame['id'];
    if (typeof id === 'number') {
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      this.#pending.delete(id);
      pending.settle();
      const error = frame['error'];
      if (isRecord(error)) {
        pending.reject(
          new CdpError(
            pending.method,
            typeof error['code'] === 'number' ? error['code'] : 0,
            typeof error['message'] === 'string' ? error['message'] : 'unknown error',
          ),
        );
      } else {
        pending.resolve(isRecord(frame['result']) ? frame['result'] : {});
      }
      return;
    }
    const method = frame['method'];
    if (typeof method !== 'string') return;
    const params = isRecord(frame['params']) ? frame['params'] : {};
    const sessionId = typeof frame['sessionId'] === 'string' ? frame['sessionId'] : undefined;
    if (method === 'Target.detachedFromTarget' && typeof params['sessionId'] === 'string') {
      this.#targetGone(params['sessionId']);
    }
    for (const handler of [...(this.#handlers.get(`${sessionId ?? ''} ${method}`) ?? [])]) {
      handler(params);
    }
  }

  /** A detached session answers nothing more: its owed commands fail now rather than at their deadline. */
  #targetGone(sessionId: string): void {
    for (const [id, pending] of this.#pending) {
      if (pending.sessionId !== sessionId) continue;
      this.#pending.delete(id);
      pending.settle();
      pending.reject(new CdpTargetGoneError(pending.method));
    }
  }

  #fail(reason: string): void {
    if (this.#closed !== undefined) return;
    this.#closed = reason;
    for (const pending of this.#pending.values()) {
      pending.settle();
      pending.reject(new CdpClosedError(reason));
    }
    this.#pending.clear();
  }
}

/** An endpoint as it may be printed: query strings carry tickets and keys. */
export function redact(endpoint: string): string {
  const at = endpoint.indexOf('?');
  return at === -1 ? endpoint : `${endpoint.slice(0, at)}?…`;
}
