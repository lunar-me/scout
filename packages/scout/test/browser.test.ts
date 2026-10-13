import { afterEach, describe, expect, test } from 'bun:test';

import { Scout, ScoutBrowserError, ScoutConfigError, type BrowserOption } from '../src/index';
import { setInternals } from '../src/scout';
import { clickOn, fakeBrowser, fakeModel, role, type FakeBrowser, type FakeModel } from './support';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
});

const DONE = { reasoning: 'nothing to do', actions: [{ type: 'done', summary: 'done' }] };
const CLICK_MORE = clickOn('More');

function setup(steps: readonly unknown[] = [DONE]): { browser: FakeBrowser; model: FakeModel } {
  const browser = fakeBrowser();
  const model = fakeModel({ steps });
  cleanup.push(browser.stop, model.stop);
  return { browser, model };
}

interface Drivers {
  readonly playwright?: unknown;
  readonly puppeteer?: unknown;
  readonly env?: Record<string, string | undefined>;
}

function scoutWith(browserOption: BrowserOption, model: FakeModel, drivers: Drivers): Scout {
  const scout = new Scout({ browser: browserOption, models: { hands: role(model, 'hands-model') } });
  setInternals(scout, {
    browserEnv: {
      env: drivers.env ?? {},
      importModule: async (name) => {
        const found = name === 'playwright-core' ? drivers.playwright : name === 'puppeteer-core' ? drivers.puppeteer : undefined;
        if (found === undefined) throw new Error(`Cannot find package '${name}'`);
        return found;
      },
    },
  });
  return scout;
}

/** puppeteer-core's shape: `launch` resolving to a browser with `wsEndpoint()` and `close()`. */
function fakePuppeteer(browser: FakeBrowser): { module: unknown; launched: Record<string, unknown>[]; closed: () => number } {
  const launched: Record<string, unknown>[] = [];
  let closed = 0;
  return {
    module: {
      launch: async (options: Record<string, unknown>) => {
        launched.push(options);
        return {
          wsEndpoint: () => browser.wsEndpoint,
          close: async () => {
            closed += 1;
          },
        };
      },
    },
    launched,
    closed: () => closed,
  };
}

/**
 * playwright-core's shape: `chromium.launch`. Like the real one it serves CDP
 * on the `--remote-debugging-port` it is given, here by answering
 * `/json/version` there with the fake browser's socket.
 */
function fakePlaywright(browser: FakeBrowser): { module: unknown; launched: Record<string, unknown>[]; closed: () => number } {
  const launched: Record<string, unknown>[] = [];
  let closed = 0;
  return {
    module: {
      chromium: {
        launch: async (options: Record<string, unknown>) => {
          launched.push(options);
          const args = Array.isArray(options['args']) ? (options['args'] as string[]) : [];
          const port = Number(args.find((arg) => arg.startsWith('--remote-debugging-port='))?.split('=')[1]);
          const debug = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => Response.json({ webSocketDebuggerUrl: browser.wsEndpoint }) });
          return {
            close: async () => {
              closed += 1;
              void debug.stop(true);
            },
          };
        },
      },
    },
    launched,
    closed: () => closed,
  };
}

describe('a local launch', () => {
  test('with neither driver installed, says which to install and what else to pass', async () => {
    const { model } = setup();
    const scout = scoutWith({ launch: {} }, model, {});
    const error = await scout.run('anything').catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ScoutBrowserError);
    const message = (error as Error).message;
    expect(message).toContain('playwright-core');
    expect(message).toContain('puppeteer-core');
    expect(message).toContain('npm i');
    expect(message).toContain('cdpUrl');
  });

  test('a named driver that is not installed is named', async () => {
    const { browser, model } = setup();
    const scout = scoutWith({ launch: { driver: 'puppeteer' } }, model, { playwright: fakePlaywright(browser).module });
    await expect(scout.run('anything')).rejects.toThrow("driver is 'puppeteer', and puppeteer-core is not installed");
  });

  test('playwright-core is preferred when both are installed, headless by default, and the launched browser is closed', async () => {
    const { browser, model } = setup();
    const playwright = fakePlaywright(browser);
    const puppeteer = fakePuppeteer(browser);
    const scout = scoutWith({ launch: {} }, model, { playwright: playwright.module, puppeteer: puppeteer.module });
    const result = await scout.run('anything');
    expect(result.status).toBe('completed');
    expect(playwright.launched.length).toBe(1);
    expect(puppeteer.launched.length).toBe(0);
    expect(playwright.launched[0]?.['headless']).toBe(true);
    expect(playwright.closed()).toBe(1);
  });

  test('puppeteer-core is used when it is the one installed, with the caller\'s executable and args', async () => {
    const { browser, model } = setup();
    const puppeteer = fakePuppeteer(browser);
    const scout = scoutWith({ launch: { headless: false, executablePath: '/opt/chrome', args: ['--lang=en-GB'] } }, model, {
      puppeteer: puppeteer.module,
    });
    await scout.run('anything');
    expect(puppeteer.launched[0]).toMatchObject({ headless: false, executablePath: '/opt/chrome' });
    expect(puppeteer.launched[0]?.['args']).toContain('--lang=en-GB');
    expect(puppeteer.closed()).toBe(1);
  });

  test('the launched browser is closed when the run throws', async () => {
    const { browser, model } = setup();
    const puppeteer = fakePuppeteer(browser);
    const scout = scoutWith({ launch: {} }, model, { puppeteer: puppeteer.module });
    browser.stop();
    await expect(scout.run('anything')).rejects.toThrow(ScoutBrowserError);
    expect(puppeteer.closed()).toBe(1);
  });
});

interface FakeApi {
  readonly baseUrl: string;
  readonly connects: URLSearchParams[];
  readonly sessionReads: { readonly id: string; readonly authorization: string | null; readonly tabsOpen: number }[];
}

/** Outcrawl's API: `/connect` allocates the fake browser; `/v1/sessions/:id` answers its replay link. */
function fakeApi(browser: FakeBrowser, status = 200, linkFromRead = 1): FakeApi {
  const connects: URLSearchParams[] = [];
  const sessionReads: { id: string; authorization: string | null; tabsOpen: number }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/connect') {
        connects.push(url.searchParams);
        if (status !== 200) return Response.json({ error: { code: 'unauthorized', message: 'that key is not valid' } }, { status });
        return Response.json({ sessionId: 'sess_42', wsEndpoint: browser.wsEndpoint, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      }
      const session = /^\/v1\/sessions\/([^/]+)$/u.exec(url.pathname);
      if (session !== null) {
        sessionReads.push({ id: session[1] ?? '', authorization: request.headers.get('authorization'), tabsOpen: browser.targets().length });
        // Like production, the link appears once the session has ended.
        return Response.json(
          sessionReads.length < linkFromRead
            ? { id: session[1], status: 'running' }
            : { id: session[1], replayUrl: `https://outcrawl.ai/replay/${session[1] ?? ''}` },
        );
      }
      return new Response('not found', { status: 404 });
    },
  });
  cleanup.push(() => void server.stop(true));
  return { baseUrl: `http://127.0.0.1:${String(server.port)}`, connects, sessionReads };
}

describe("browser: 'outcrawl'", () => {
  test('allocates through /connect with the key from the environment, and returns the session replay link', async () => {
    const { browser, model } = setup();
    const api = fakeApi(browser);
    const scout = scoutWith({ outcrawl: { baseUrl: api.baseUrl } }, model, { env: { OUTCRAWL_API_KEY: 'oc_test_key' } });
    const result = await scout.run('anything');
    expect(result.status).toBe('completed');
    expect(result.replayUrl).toBe('https://outcrawl.ai/replay/sess_42');
    expect(api.connects.length).toBe(1);
    expect(api.connects[0]?.get('token')).toBe('oc_test_key');
    // Plain input is sent, and the host is asked to plan it.
    expect(api.connects[0]?.get('input')).toBe('natural');
    expect(api.connects[0]?.has('record')).toBe(false);
    expect(api.sessionReads).toEqual([{ id: 'sess_42', authorization: 'Bearer oc_test_key', tabsOpen: 0 }]);
  });

  test('the replay link is read after the session ends, and read again until it is published', async () => {
    const { browser, model } = setup();
    const api = fakeApi(browser, 200, 3);
    const scout = scoutWith({ outcrawl: { baseUrl: api.baseUrl, apiKey: 'k' } }, model, {});
    const result = await scout.run('anything');
    expect(result.replayUrl).toBe('https://outcrawl.ai/replay/sess_42');
    expect(api.sessionReads.length).toBe(3);
    expect(api.sessionReads.every((read) => read.tabsOpen === 0)).toBe(true);
  });

  test('sends plain input there: one pointer move to the target, then press and release', async () => {
    const { browser, model } = setup([CLICK_MORE, DONE]);
    const api = fakeApi(browser);
    const scout = scoutWith({ outcrawl: { baseUrl: api.baseUrl, apiKey: 'oc_test_key' } }, model, {});
    await scout.run('Click More.');
    expect(browser.clicked()).toBe(true);
    const pointer = browser.log
      .filter((entry) => entry.method === 'Input.dispatchMouseEvent')
      .map((entry) => String(entry.params['type']));
    expect(pointer).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  test('record: false is sent, and the result says the recording was declined instead of linking one', async () => {
    const { browser, model } = setup();
    const api = fakeApi(browser);
    const scout = scoutWith({ outcrawl: { baseUrl: api.baseUrl, apiKey: 'k', record: false, proxy: 'http://u:p@proxy.example:8080' } }, model, {});
    const result = await scout.run('anything');
    expect(api.connects[0]?.get('record')).toBe('false');
    expect(api.connects[0]?.get('proxy')).toBe('http://u:p@proxy.example:8080');
    expect(result.replayUrl).toBeUndefined();
    expect(result.recordingDeclined).toBe(true);
    expect(api.sessionReads).toEqual([]);
  });

  test('with no key anywhere, refuses before any request, naming the variable', async () => {
    const { browser, model } = setup();
    const api = fakeApi(browser);
    const scout = scoutWith({ outcrawl: { baseUrl: api.baseUrl } }, model, {});
    const error = await scout.run('anything').catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ScoutConfigError);
    expect((error as Error).message).toContain('OUTCRAWL_API_KEY');
    expect(api.connects.length).toBe(0);
  });

  test("a refused /connect is reported with the API's own reason", async () => {
    const { browser, model } = setup();
    const api = fakeApi(browser, 401);
    const scout = scoutWith({ outcrawl: { baseUrl: api.baseUrl, apiKey: 'bad' } }, model, {});
    await expect(scout.run('anything')).rejects.toThrow('Outcrawl /connect answered 401: that key is not valid');
  });
});
