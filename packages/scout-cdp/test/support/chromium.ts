/**
 * A stock headless Chromium for the stock-flavor tests, and the smallest flat
 * CDP client that satisfies `CdpPage`.
 *
 * The browser is Playwright's own Chromium build, launched headless with a
 * debugging port so the binding talks raw CDP to it exactly as a Scout user's
 * browser would. {@link chromiumPath} is `undefined` when that build is not
 * installed, and the tests that need it skip.
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';

import { chromium, type Browser } from 'playwright';

import type { CdpPage } from '../../src/index';

/** Playwright's Chromium, when it is installed on this machine. */
export const chromiumPath: string | undefined = (() => {
  try {
    const path = chromium.executablePath();
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
})();

const COMMAND_TIMEOUT_MS = 15_000;

class CdpTimeoutError extends Error {
  override readonly name = 'CdpTimeoutError';
  constructor(readonly method: string) {
    super(`${method} did not answer within ${String(COMMAND_TIMEOUT_MS)}ms`);
  }
}

type Handler = (params: Record<string, unknown>) => void;

/** One WebSocket to the browser, multiplexing flat sessions. */
export class CdpConnection {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  readonly #handlers = new Map<string, Set<Handler>>();
  #next = 0;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => this.#receive(String(event.data)));
  }

  static async open(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)), { once: true });
    await promise;
    return new CdpConnection(socket);
  }

  #receive(data: string): void {
    const message = JSON.parse(data) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: { message?: string };
      sessionId?: string;
    };
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        pending.reject(Object.assign(new Error(message.error.message ?? 'CDP error'), { name: 'CdpError' }));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method === undefined) return;
    for (const handler of this.#handlers.get(`${message.sessionId ?? ''}|${message.method}`) ?? []) {
      handler(message.params ?? {});
    }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = (this.#next += 1);
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      reject(new CdpTimeoutError(method));
    }, COMMAND_TIMEOUT_MS);
    this.#pending.set(id, { resolve, reject, timer });
    this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    return promise;
  }

  on(sessionId: string, method: string, handler: Handler): () => void {
    const key = `${sessionId}|${method}`;
    const set = this.#handlers.get(key) ?? new Set();
    this.#handlers.set(key, set);
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /** `sessionId` on this connection as a `CdpPage`, its URL tracked from its own main-frame commits. */
  page(sessionId: string, targetId: string, initialUrl = ''): CdpPage {
    let url = initialUrl;
    this.on(sessionId, 'Page.frameNavigated', (params) => {
      const frame = params['frame'] as Record<string, unknown> | undefined;
      if (frame !== undefined && frame['parentId'] === undefined && typeof frame['url'] === 'string') url = frame['url'];
    });
    return {
      targetId,
      sessionId,
      url: () => url,
      send: (method, params) => this.send(method, params, sessionId),
      sendBrowser: (method, params) => this.send(method, params),
      on: (method, handler) => this.on(sessionId, method, handler),
      forSession: (child, target) => this.page(child, target),
    };
  }

  close(): void {
    for (const pending of this.#pending.values()) clearTimeout(pending.timer);
    this.#socket.close();
  }
}

async function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    server.close(() => resolve(port));
  });
  return promise;
}

export interface StockChromium {
  readonly connection: CdpConnection;
  /** A new tab on `url`, attached and with the `Page` domain on, once it has loaded. */
  open(url: string): Promise<CdpPage>;
  close(): Promise<void>;
}

/**
 * Launches the stock Chromium headless with a debugging port. Callers must
 * `close()` it. `pdfViewer` launches the full browser in its new headless mode
 * instead of the headless shell, which has no PDF viewer and downloads a PDF.
 */
export async function launchChromium(options: { readonly pdfViewer?: boolean } = {}): Promise<StockChromium> {
  const port = await freePort();
  const browser: Browser = await chromium.launch({
    headless: true,
    ...(options.pdfViewer === true ? { channel: 'chromium' } : {}),
    args: [`--remote-debugging-port=${String(port)}`, '--site-per-process'],
  });
  try {
    const version = (await (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const connection = await CdpConnection.open(version.webSocketDebuggerUrl);
    return {
      connection,
      async open(url) {
        const { targetId } = (await connection.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
        const { sessionId } = (await connection.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
        const page = connection.page(sessionId, targetId, 'about:blank');
        await page.send('Page.enable');
        const loaded = Promise.withResolvers<void>();
        const off = page.on('Page.loadEventFired', () => {
          off();
          loaded.resolve();
        });
        await page.send('Page.navigate', { url });
        await loaded.promise;
        return page;
      },
      async close() {
        connection.close();
        await browser.close();
      },
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
