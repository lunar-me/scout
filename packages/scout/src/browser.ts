/**
 * Opening the browser a run drives, in one of three ways, and handing back one
 * page on a CDP connection Scout owns:
 *
 * - a local Chromium, launched through playwright-core or puppeteer-core,
 *   whichever is installed (both are optional peers);
 * - any CDP endpoint the caller runs;
 * - Outcrawl's cloud browser, allocated through `GET /connect`.
 *
 * Every way gets a fresh tab of its own. Closing undoes exactly what Scout
 * opened: the tab and the connection always, the browser only when Scout
 * launched it or allocated it. A browser the caller passed stays running.
 */
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import type { CdpPage } from '@outcrawl/scout-cdp';
import { isRecord } from '@outcrawl/scout-core';

import { CdpConnection, redact } from './cdp';
import { ScoutBrowserError, ScoutConfigError, type BrowserOption, type LaunchOptions, type OutcrawlOptions, type ScoutLogger } from './options';

export const OUTCRAWL_API_URL = 'https://api.outcrawl.ai';

/** The browser a run drives, open. */
export interface OpenedBrowser {
  readonly kind: 'launch' | 'cdp' | 'outcrawl';
  readonly page: CdpPage;
  /** Committed main-frame navigations on the page so far. */
  pageLoads(): number;
  /** Whether the browser runs on macOS, which decides the select-all chord. */
  readonly mac: boolean;
  /**
   * The session's replay link, on Outcrawl; `undefined` elsewhere or when
   * there is no recording. Read after {@link close}: it is published as the
   * session ends.
   */
  replayUrl(): Promise<string | undefined>;
  /** Whether the caller declined the recording. */
  readonly recordingDeclined: boolean;
  /** Closes what Scout opened, and nothing the caller owns. Never throws. */
  close(): Promise<void>;
}

/** What browser selection reaches outside itself, injectable for tests. */
export interface BrowserEnv {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Loads an optional peer by name, rejecting when it is not installed. */
  readonly importModule: (name: string) => Promise<unknown>;
}

export const SYSTEM_BROWSER_ENV: BrowserEnv = {
  env: process.env,
  // A variable specifier, so a bundler leaves the optional peers unresolved.
  importModule: (name) => import(name),
};

const NO_DRIVER =
  'Scout launches a local browser through playwright-core or puppeteer-core, and neither is installed. ' +
  'Install one: `npm i playwright-core && npx playwright install chromium`, or `npm i puppeteer-core` ' +
  '(which drives your installed Chrome). Or pass browser: { cdpUrl } for a browser you already run, ' +
  "or browser: 'outcrawl' for Outcrawl's cloud browser.";

interface Launched {
  readonly endpoint: string;
  readonly close: () => Promise<void>;
}

interface PlaywrightModule {
  readonly chromium: {
    launch(options: Record<string, unknown>): Promise<{ close(): Promise<void> }>;
  };
}

interface PuppeteerModule {
  launch(options: Record<string, unknown>): Promise<{ wsEndpoint(): string; close(): Promise<void> }>;
}

function asPlaywright(mod: unknown): PlaywrightModule | undefined {
  const candidate = isRecord(mod) && isRecord(mod['chromium']) ? mod : isRecord(mod) && isRecord(mod['default']) ? mod['default'] : undefined;
  return candidate !== undefined && isRecord(candidate['chromium']) && typeof candidate['chromium']['launch'] === 'function'
    ? (candidate as unknown as PlaywrightModule)
    : undefined;
}

function asPuppeteer(mod: unknown): PuppeteerModule | undefined {
  if (!isRecord(mod)) return undefined;
  if (typeof mod['launch'] === 'function') return mod as unknown as PuppeteerModule;
  const fallback = mod['default'];
  return isRecord(fallback) && typeof fallback['launch'] === 'function' ? (fallback as unknown as PuppeteerModule) : undefined;
}

/** A TCP port free on loopback now, for the launched browser's debugging port. */
async function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    server.close(() => {
      resolve(port);
    });
  });
  return await promise;
}

/** `webSocketDebuggerUrl` of the browser at `http://host:port`, waiting for it to come up. */
async function browserEndpoint(httpBase: string, waitMs: number): Promise<string> {
  const deadline = Date.now() + waitMs;
  let last: unknown;
  for (;;) {
    try {
      const response = await fetch(`${httpBase.replace(/\/+$/u, '')}/json/version`);
      const body: unknown = await response.json();
      if (isRecord(body) && typeof body['webSocketDebuggerUrl'] === 'string') return body['webSocketDebuggerUrl'];
      last = `no webSocketDebuggerUrl in ${JSON.stringify(body).slice(0, 200)}`;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= deadline) {
      throw new ScoutBrowserError(`no CDP endpoint answered at ${redact(httpBase)}/json/version: ${String(last)}`);
    }
    await sleep(100);
  }
}

async function launchLocal(options: LaunchOptions, deps: BrowserEnv): Promise<Launched> {
  const extra = [...(options.args ?? [])];
  if (!extra.some((arg) => arg.startsWith('--window-size'))) extra.push('--window-size=1280,800');
  const headless = options.headless ?? true;
  const wanted = options.driver === undefined ? (['playwright', 'puppeteer'] as const) : ([options.driver] as const);

  for (const driver of wanted) {
    if (driver === 'playwright') {
      const playwright = asPlaywright(await deps.importModule('playwright-core').catch(() => undefined));
      if (playwright === undefined) continue;
      const port = await freePort();
      const browser = await playwright.chromium
        .launch({
          headless,
          args: [`--remote-debugging-port=${String(port)}`, ...extra],
          ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
        })
        .catch((error: unknown) => {
          throw new ScoutBrowserError(`playwright-core could not launch Chromium: ${String(error)}`, { cause: error });
        });
      try {
        return { endpoint: await browserEndpoint(`http://127.0.0.1:${String(port)}`, 15_000), close: () => browser.close() };
      } catch (error) {
        await browser.close().catch(() => undefined);
        throw error;
      }
    }
    const puppeteer = asPuppeteer(await deps.importModule('puppeteer-core').catch(() => undefined));
    if (puppeteer === undefined) continue;
    const browser = await puppeteer
      .launch({
        headless,
        args: extra,
        defaultViewport: null,
        ...(options.executablePath === undefined ? { channel: 'chrome' } : { executablePath: options.executablePath }),
      })
      .catch((error: unknown) => {
        throw new ScoutBrowserError(`puppeteer-core could not launch Chrome: ${String(error)}`, { cause: error });
      });
    return { endpoint: browser.wsEndpoint(), close: () => browser.close() };
  }
  throw new ScoutBrowserError(
    options.driver === undefined ? NO_DRIVER : `browser.launch.driver is '${options.driver}', and ${options.driver === 'playwright' ? 'playwright-core' : 'puppeteer-core'} is not installed. ${NO_DRIVER}`,
  );
}

interface Allocation {
  readonly sessionId: string;
  readonly endpoint: string;
  readonly base: string;
  readonly apiKey: string;
}

async function allocateOutcrawl(options: OutcrawlOptions, deps: BrowserEnv): Promise<Allocation> {
  const apiKey = options.apiKey ?? deps.env['OUTCRAWL_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    throw new ScoutConfigError(
      "browser: 'outcrawl' needs an Outcrawl API key: set OUTCRAWL_API_KEY, or pass browser: { outcrawl: { apiKey } }. " +
        'Keys are at https://outcrawl.ai.',
    );
  }
  const base = (options.baseUrl ?? OUTCRAWL_API_URL).replace(/\/+$/u, '');
  const query = new URLSearchParams({ token: apiKey, input: 'natural' });
  if (options.proxy !== undefined) query.set('proxy', options.proxy);
  if (options.record === false) query.set('record', 'false');
  let response: Response;
  try {
    response = await fetch(`${base}/connect?${query.toString()}`, { headers: { accept: 'application/json' } });
  } catch (error) {
    throw new ScoutBrowserError(`could not reach ${base}/connect: ${String(error)}`, { cause: error });
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const error = isRecord(body) && isRecord(body['error']) ? body['error'] : undefined;
    const said = typeof error?.['message'] === 'string' ? error['message'] : text.slice(0, 300);
    throw new ScoutBrowserError(`Outcrawl /connect answered ${String(response.status)}: ${said}`);
  }
  const allocation = isRecord(body) && isRecord(body['data']) ? body['data'] : body;
  if (!isRecord(allocation) || typeof allocation['wsEndpoint'] !== 'string' || typeof allocation['sessionId'] !== 'string') {
    throw new ScoutBrowserError(`Outcrawl /connect answered without a wsEndpoint and sessionId: ${text.slice(0, 300)}`);
  }
  return { sessionId: allocation['sessionId'], endpoint: allocation['wsEndpoint'], base, apiKey };
}

/**
 * Waits between reads of the session's replay link. The link is published as
 * the session ends: measured on production 2026-10-13 (n=1), a read during the
 * session answered 200 with no `replayUrl`, and a read after it ended had one.
 * So it is read after the connection closes, a few times.
 */
const REPLAY_READ_WAITS_MS: readonly number[] = [0, 500, 1_000, 2_000, 4_000];

async function sessionReplayUrl(allocation: Allocation, logger: ScoutLogger | undefined): Promise<string | undefined> {
  let last: unknown;
  for (const wait of REPLAY_READ_WAITS_MS) {
    if (wait > 0) await sleep(wait);
    try {
      const response = await fetch(`${allocation.base}/v1/sessions/${encodeURIComponent(allocation.sessionId)}`, {
        headers: { accept: 'application/json', authorization: `Bearer ${allocation.apiKey}` },
      });
      const body: unknown = await response.json();
      const session = isRecord(body) && isRecord(body['data']) ? body['data'] : body;
      if (response.ok && isRecord(session) && typeof session['replayUrl'] === 'string') return session['replayUrl'];
      last = `status ${String(response.status)}, no replayUrl`;
    } catch (error) {
      last = String(error);
    }
  }
  logger?.warn('scout.no_replay_url', { sessionId: allocation.sessionId, last });
  return undefined;
}

/** Opens the browser `option` names, with one fresh tab attached. */
export async function openBrowser(option: BrowserOption, deps: BrowserEnv, logger?: ScoutLogger): Promise<OpenedBrowser> {
  let endpoint: string;
  let kind: OpenedBrowser['kind'];
  let closeBrowser: (() => Promise<void>) | undefined;
  let allocation: Allocation | undefined;
  let recordingDeclined = false;

  if (option === 'outcrawl' || 'outcrawl' in option) {
    const options = option === 'outcrawl' ? {} : option.outcrawl;
    allocation = await allocateOutcrawl(options, deps);
    endpoint = allocation.endpoint;
    kind = 'outcrawl';
    recordingDeclined = options.record === false;
    logger?.info('scout.browser', { kind, sessionId: allocation.sessionId });
  } else if ('cdpUrl' in option) {
    const url = option.cdpUrl;
    endpoint = /^wss?:/u.test(url) ? url : await browserEndpoint(url, 5_000);
    kind = 'cdp';
    logger?.info('scout.browser', { kind, endpoint: redact(endpoint) });
  } else {
    const launched = await launchLocal(option.launch ?? {}, deps);
    endpoint = launched.endpoint;
    closeBrowser = launched.close;
    kind = 'launch';
    logger?.info('scout.browser', { kind });
  }

  let connection: CdpConnection;
  try {
    connection = await CdpConnection.open(endpoint);
  } catch (error) {
    await closeBrowser?.().catch(() => undefined);
    throw new ScoutBrowserError(String(error instanceof Error ? error.message : error), { cause: error });
  }

  let targetId: string | undefined;
  try {
    const version = await connection.send('Browser.getVersion');
    const userAgent = typeof version['userAgent'] === 'string' ? version['userAgent'] : '';
    const created = await connection.send('Target.createTarget', { url: 'about:blank' });
    const createdId = created['targetId'];
    if (typeof createdId !== 'string') throw new ScoutBrowserError('Target.createTarget answered no targetId');
    targetId = createdId;
    const attached = await connection.send('Target.attachToTarget', { targetId: createdId, flatten: true });
    const sessionId = attached['sessionId'];
    if (typeof sessionId !== 'string') throw new ScoutBrowserError('Target.attachToTarget answered no sessionId');
    const page = connection.page(createdId, sessionId);
    let loads = 0;
    page.on('Page.frameNavigated', (params) => {
      const frame = params['frame'];
      if (isRecord(frame) && frame['parentId'] === undefined) loads += 1;
    });
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    const mac = /Macintosh|Mac OS X/u.test(userAgent);

    const opened = allocation;
    return {
      kind,
      page,
      mac,
      recordingDeclined,
      pageLoads: () => loads,
      replayUrl: () => (opened === undefined || recordingDeclined ? Promise.resolve(undefined) : sessionReplayUrl(opened, logger)),
      close: async () => {
        // The tab is Scout's on every kind of browser; the browser is Scout's
        // only when it launched it (an Outcrawl session ends with its connection).
        if (!connection.closed && closeBrowser === undefined) {
          await connection.send('Target.closeTarget', { targetId: createdId }).catch(() => undefined);
        }
        connection.close();
        await closeBrowser?.().catch((error: unknown) => {
          logger?.warn('scout.browser_close_failed', { error: String(error) });
        });
      },
    };
  } catch (error) {
    if (targetId !== undefined && closeBrowser === undefined) {
      await connection.send('Target.closeTarget', { targetId }).catch(() => undefined);
    }
    connection.close();
    await closeBrowser?.().catch(() => undefined);
    throw error instanceof ScoutBrowserError ? error : new ScoutBrowserError(String(error instanceof Error ? error.message : error), { cause: error });
  }
}
