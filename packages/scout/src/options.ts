/**
 * What a caller hands Scout, and the checks that refuse a bad configuration
 * before any browser opens or any model is called.
 *
 * Scout has no defaults for models: no model id, no provider and no base URL.
 * Every role it uses is named by the caller.
 */
import type { StructuredOutputMode, RateCard } from '@outcrawl/model';
import type { HandsPort } from '@outcrawl/scout-cdp';
import { capBudgetError, capDurationError, isRecord, type AgentStep, type JsonSchema } from '@outcrawl/scout-core';

/** One model in one role, on any endpoint that speaks the chat-completions protocol (`POST /chat/completions`). */
export interface RoleModel {
  /** The model id, exactly as the endpoint expects it. */
  readonly model: string;
  /**
   * The endpoint's base URL, the part before `/chat/completions`, for example
   * `https://api.example.com/v1` or `http://localhost:11434/v1`.
   */
  readonly baseURL: string;
  /** The endpoint's key, sent as a bearer token. An empty string sends none for a local server. */
  readonly apiKey: string;
  /** How hard the model may think, for a model that takes a reasoning effort. Absent sends none. */
  readonly effort?: 'minimal' | 'low' | 'medium' | 'high';
  /**
   * How a JSON reply is asked for:
   * - `'tool_choice'` (the default) forces one function call whose parameters
   *   are the schema. Function calling is the most widely supported way to get
   *   structured output across chat-completions endpoints.
   * - `'json_object'` asks for any JSON and spells the schema out in the
   *   prompt, for an endpoint without function calling.
   * - `'strict'` sends a strict `json_schema` response format, for an endpoint
   *   that supports it.
   *
   * An endpoint that refuses the mode answers 400, and the run's error names
   * this option.
   */
  readonly structuredOutput?: StructuredOutputMode;
  /** Extra headers sent with every request to this endpoint. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Which model does what. Only `hands` is required.
 *
 * - `hands` reads the page and acts on it: every step's click, type, scroll or
 *   read. It is called on every step, so it decides most of a run's speed and cost.
 * - `brain` (optional) decides every step from a compact view of the page and
 *   the run so far, and `hands` carries the decision out. A stronger model here
 *   helps long, multi-page tasks.
 * - `eyes` (optional) answers questions about a screenshot when the agent asks
 *   to look at the page. It must accept images. Absent, the agent works from the
 *   page's accessibility tree only.
 * - `extract` (optional) reads a page into the answer or into your schema.
 *   Absent, `hands` does it.
 */
export interface ScoutModels {
  readonly hands: RoleModel;
  readonly brain?: RoleModel;
  readonly eyes?: RoleModel;
  readonly extract?: RoleModel;
  /**
   * Prices per model, so a run can report what it cost and be held to
   * `caps.budget`. Keys are model ids; every role's model must be listed.
   * Absent, cost is reported only where the endpoint states it per call, and
   * `caps.budget` is refused.
   */
  readonly rates?: RateCard;
}

/** A local browser Scout starts and stops itself. */
export interface LaunchOptions {
  /** Run without a window. Default `true`. */
  readonly headless?: boolean;
  /**
   * The Chrome or Chromium to run. Absent: Playwright's own Chromium with
   * playwright-core, or the installed Chrome with puppeteer-core.
   */
  readonly executablePath?: string;
  /** Extra command-line switches for the browser. */
  readonly args?: readonly string[];
  /** Which installed library launches it. Absent: playwright-core if installed, then puppeteer-core. */
  readonly driver?: 'playwright' | 'puppeteer';
}

/** Outcrawl's cloud browser. */
export interface OutcrawlOptions {
  /** Absent: the `OUTCRAWL_API_KEY` environment variable. */
  readonly apiKey?: string;
  /** Your own proxy URL for the session's traffic, instead of an Outcrawl exit. */
  readonly proxy?: string;
  /** Record the session for replay. Default `true`; `false` records nothing. */
  readonly record?: boolean;
  /** The API's base URL. Default `https://api.outcrawl.ai`. */
  readonly baseUrl?: string;
}

/**
 * Where the agent runs:
 * - `{ launch: {...} }` or `{}`: a local Chromium, started and closed by Scout;
 * - `{ cdpUrl }`: any browser you already run, over CDP (`ws://...` or `http://host:port`);
 * - `'outcrawl'` or `{ outcrawl: {...} }`: Outcrawl's cloud browser.
 */
export type BrowserOption =
  | { readonly launch?: LaunchOptions }
  | { readonly cdpUrl: string }
  | 'outcrawl'
  | { readonly outcrawl: OutcrawlOptions };

/** Where Scout says what it is doing. Any structured logger fits. */
export interface ScoutLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

export interface ScoutOptions {
  readonly browser: BrowserOption;
  readonly models: ScoutModels;
  /**
   * The input planner: how clicks, typing and scrolling are turned into
   * browser input. Absent: the agenthands planner on a local or CDP browser,
   * and plain input on Outcrawl, whose browser plans input itself.
   */
  readonly hands?: HandsPort;
  readonly logger?: ScoutLogger;
}

/** When a run stops. Reaching a cap is a normal ending: the result carries what was found. */
export interface RunCaps {
  /** Most actions. Default 40. */
  readonly steps?: number;
  /** Wall clock, `<n>ms` | `<n>s` | `<n>m` | `<n>h`. Default `'10m'`. */
  readonly duration?: string;
  /** Most model spend, in USD as a decimal string such as `"0.50"`. Requires `models.rates`. */
  readonly budget?: string;
}

export interface RunOptions {
  readonly caps?: RunCaps;
  /** The answer's JSON Schema. Absent: the answer is the agent's own summary. */
  readonly schema?: JsonSchema;
  /** Stops the run. It ends as `cancelled` with what it found so far. */
  readonly signal?: AbortSignal;
  /** Called with each step as it is recorded. Must not throw. */
  readonly onStep?: (step: AgentStep) => void;
}

/** A configuration Scout cannot run with. The message says what to pass. */
export class ScoutConfigError extends Error {
  override readonly name = 'ScoutConfigError';
}

/** The browser could not be started, reached or connected to. */
export class ScoutBrowserError extends Error {
  override readonly name = 'ScoutBrowserError';
}

/** How a role asks for JSON when it names no `structuredOutput`. See {@link RoleModel.structuredOutput}. */
export const DEFAULT_STRUCTURED_OUTPUT = 'tool_choice' satisfies StructuredOutputMode;

export const DEFAULT_STEPS = 40;
export const DEFAULT_DURATION = '10m';

const ROLES = ['hands', 'brain', 'eyes', 'extract'] as const;
export type Role = (typeof ROLES)[number];

function checkRole(role: Role, value: unknown): RoleModel | undefined {
  if (value === undefined) {
    if (role === 'hands') {
      throw new ScoutConfigError(
        'models.hands is required: the model that reads the page and acts on it. Pass ' +
          "{ hands: { model: 'your-model-id', baseURL: 'https://your-endpoint/v1', apiKey: '...' } }. " +
          'Scout has no default model.',
      );
    }
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ScoutConfigError(`models.${role} must be an object { model, baseURL, apiKey }`);
  }
  const { model, baseURL, apiKey, effort, structuredOutput, headers } = value;
  if (typeof model !== 'string' || model.trim() === '') {
    throw new ScoutConfigError(`models.${role}.model must be the model id your endpoint expects, as a non-empty string`);
  }
  if (typeof baseURL !== 'string' || !/^https?:\/\/[^/]/u.test(baseURL)) {
    throw new ScoutConfigError(
      `models.${role}.baseURL must be the endpoint's http(s) base URL, the part before /chat/completions ` +
        `(got ${JSON.stringify(baseURL)})`,
    );
  }
  if (typeof apiKey !== 'string') {
    throw new ScoutConfigError(`models.${role}.apiKey must be a string; pass '' for an endpoint that takes no key`);
  }
  if (effort !== undefined && effort !== 'minimal' && effort !== 'low' && effort !== 'medium' && effort !== 'high') {
    throw new ScoutConfigError(`models.${role}.effort must be one of minimal, low, medium, high`);
  }
  if (
    structuredOutput !== undefined &&
    structuredOutput !== 'strict' &&
    structuredOutput !== 'tool_choice' &&
    structuredOutput !== 'json_object'
  ) {
    throw new ScoutConfigError(`models.${role}.structuredOutput must be one of strict, tool_choice, json_object`);
  }
  if (headers !== undefined && (!isRecord(headers) || Object.values(headers).some((v) => typeof v !== 'string'))) {
    throw new ScoutConfigError(`models.${role}.headers must map header names to strings`);
  }
  return value as unknown as RoleModel;
}

/** The models, checked: each role's shape, and the rate card covering every model it names. */
export function checkModels(models: unknown): ScoutModels {
  if (!isRecord(models)) {
    throw new ScoutConfigError('models is required: { hands: { model, baseURL, apiKey }, brain?, eyes?, extract? }');
  }
  for (const key of Object.keys(models)) {
    if (key !== 'rates' && !(ROLES as readonly string[]).includes(key)) {
      throw new ScoutConfigError(`models.${key} is not a role. Roles: ${ROLES.join(', ')}; prices go in models.rates`);
    }
  }
  const roles = ROLES.map((role) => [role, checkRole(role, models[role])] as const);
  const rates = models['rates'];
  if (rates !== undefined) {
    if (!isRecord(rates)) {
      throw new ScoutConfigError('models.rates must map each model id to its prices');
    }
    for (const [role, entry] of roles) {
      if (entry !== undefined && rates[entry.model] === undefined) {
        throw new ScoutConfigError(
          `models.rates has no entry for ${JSON.stringify(entry.model)} (models.${role}). ` +
            'With rates given, every role\'s model needs prices, or its cost would read as zero.',
        );
      }
    }
  }
  return models as unknown as ScoutModels;
}

/** The browser option, checked. */
export function checkBrowser(browser: unknown): BrowserOption {
  if (browser === 'outcrawl') return browser;
  if (!isRecord(browser)) {
    throw new ScoutConfigError(
      "browser is required: { launch: {} } for a local Chromium, { cdpUrl: 'ws://...' } for a browser you run, " +
        "or 'outcrawl' for Outcrawl's cloud browser",
    );
  }
  const kinds = ['launch', 'cdpUrl', 'outcrawl'].filter((key) => browser[key] !== undefined);
  if (kinds.length > 1) {
    throw new ScoutConfigError(`browser names ${kinds.join(' and ')}; pass exactly one`);
  }
  const unknown = Object.keys(browser).filter((key) => !['launch', 'cdpUrl', 'outcrawl'].includes(key));
  if (unknown.length > 0) {
    throw new ScoutConfigError(`browser.${unknown[0] ?? ''} is not an option; pass launch, cdpUrl or outcrawl`);
  }
  if (browser['cdpUrl'] !== undefined) {
    const url = browser['cdpUrl'];
    if (typeof url !== 'string' || !/^(wss?|https?):\/\/[^/]/u.test(url)) {
      throw new ScoutConfigError(`browser.cdpUrl must be a ws(s):// or http(s):// URL (got ${JSON.stringify(url)})`);
    }
  }
  const launch = browser['launch'];
  if (launch !== undefined) {
    if (!isRecord(launch)) throw new ScoutConfigError('browser.launch must be an object');
    const driver = launch['driver'];
    if (driver !== undefined && driver !== 'playwright' && driver !== 'puppeteer') {
      throw new ScoutConfigError("browser.launch.driver must be 'playwright' or 'puppeteer'");
    }
    const args = launch['args'];
    if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))) {
      throw new ScoutConfigError('browser.launch.args must be an array of strings');
    }
  }
  const outcrawl = browser['outcrawl'];
  if (outcrawl !== undefined && !isRecord(outcrawl)) {
    throw new ScoutConfigError('browser.outcrawl must be an object { apiKey?, proxy?, record?, baseUrl? }');
  }
  return browser as unknown as BrowserOption;
}

/** The caps a run is held to: the caller's, with the step and time guards filled in. */
export function checkCaps(caps: RunCaps | undefined, priced: boolean): {
  readonly steps: number;
  readonly duration: string;
  readonly budget: string | undefined;
} {
  const steps = caps?.steps ?? DEFAULT_STEPS;
  if (!Number.isInteger(steps) || steps < 1) {
    throw new ScoutConfigError(`caps.steps must be a positive whole number (got ${String(caps?.steps)})`);
  }
  const duration = caps?.duration ?? DEFAULT_DURATION;
  const durationError = capDurationError(duration);
  if (durationError !== undefined) throw new ScoutConfigError(durationError);
  const budget = caps?.budget;
  if (budget !== undefined) {
    if (!priced) {
      throw new ScoutConfigError(
        'caps.budget needs prices: pass models.rates with every role\'s model, or bound the run with caps.steps and caps.duration',
      );
    }
    const budgetError = capBudgetError(budget);
    if (budgetError !== undefined) {
      throw new ScoutConfigError(budgetError.replace('decimal credit string', 'decimal USD string'));
    }
  }
  return { steps, duration, budget };
}
