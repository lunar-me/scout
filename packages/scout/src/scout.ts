/**
 * `new Scout({ browser, models }).run(task)`: the hosted agent's loop, model
 * harness and browser binding, assembled on the caller's browser and models.
 */
import { bindLockReleases, bindAgent, handsPortFor, stockFlavor, type HandsPort } from '@outcrawl/scout-cdp';
import type { AgentGoal, AgentStatus, AgentStep, AgentStopReason, JsonSchema, Usage } from '@outcrawl/scout-core';
import { runAgent, toWireResult, toWireStep, type AgentResult, type Finding } from '@outcrawl/runtime';

import { openBrowser, SYSTEM_BROWSER_ENV, type BrowserEnv } from './browser';
import { buildModels, type RunModels } from './models';
import {
  checkBrowser,
  checkCaps,
  checkModels,
  ScoutBrowserError,
  ScoutConfigError,
  type BrowserOption,
  type RunOptions,
  type ScoutLogger,
  type ScoutModels,
  type ScoutOptions,
} from './options';
import { plainHands } from './plain-hands';

/**
 * What a run returns: the hosted agent's result, plus the step trace and the
 * cost in USD as far as it is known.
 */
export interface ScoutResult<T = unknown> {
  readonly id: string;
  /**
   * `completed`; `partial` (fell short, see `error` for what is missing);
   * `capped` (a cap you set was reached); `failed`.
   */
  readonly status: AgentStatus;
  /**
   * The answer. With a schema, schema-shaped (partly filled on a partial run);
   * without one, the agent's own summary. Absent when the task asked nothing.
   */
  readonly data?: T;
  readonly stopReason: AgentStopReason;
  /** On a `partial` or `failed` run: what went wrong or what is still missing. */
  readonly error?: string;
  /** Every step, in order: the action, its outcome, the url. */
  readonly steps: readonly AgentStep[];
  readonly stepsUsed: number;
  /** The plan the agent made and how each part ended. Absent when it made none. */
  readonly goals?: readonly AgentGoal[];
  /** Facts the run established along the way, including on a run that ended early. */
  readonly findings: readonly Finding[];
  /** A schema derived from the task, when you passed none. Adopt it to get a table next time. */
  readonly suggestedSchema?: JsonSchema;
  readonly usage: Usage;
  readonly durationMs: number;
  /** Pages the run loaded. */
  readonly pages: number;
  /**
   * What the run's model calls cost, in USD. Absent when it is not known: an
   * endpoint stated no cost for a call and `models.rates` has no price for it.
   */
  readonly costUsd?: string;
  /** On Outcrawl: watch the run. Absent elsewhere, or when the recording was declined. */
  readonly replayUrl?: string;
  /** On Outcrawl: present when you declined the recording with `record: false`. */
  readonly recordingDeclined?: true;
}

/** What a test may swap: how a local browser's driver and the environment are found. */
export interface ScoutInternals {
  readonly browserEnv: BrowserEnv;
}

const internals = new WeakMap<Scout, ScoutInternals>();

/** Test seam, not exported from the package. */
export function setInternals(scout: Scout, override: ScoutInternals): void {
  internals.set(scout, override);
}

/** No ceiling: without prices a budget is refused, so the run is bounded by steps and time. */
const UNPRICED_BUDGET = '1000000000';

/** Consecutive failed steps a run absorbs before it stops, as the hosted agent does. */
const STEP_FAILURES = 3;

export class Scout {
  readonly #browser: BrowserOption;
  readonly #models: ScoutModels;
  readonly #hands: HandsPort | undefined;
  readonly #logger: ScoutLogger | undefined;

  constructor(options: ScoutOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new ScoutConfigError('new Scout({ browser, models }) needs an options object');
    }
    this.#browser = checkBrowser(options.browser);
    this.#models = checkModels(options.models);
    this.#hands = options.hands;
    this.#logger = options.logger;
  }

  /**
   * Runs `task` to an end and returns what it found. A run that falls short
   * or reaches a cap still returns, with the data it collected; only a
   * configuration or browser that cannot start throws.
   */
  async run<T = unknown>(task: string, options: RunOptions = {}): Promise<ScoutResult<T>> {
    if (typeof task !== 'string' || task.trim() === '') {
      throw new ScoutConfigError('run(task) needs the task in words, as a non-empty string');
    }
    const caps = checkCaps(options.caps, this.#models.rates !== undefined);
    const browserEnv = internals.get(this)?.browserEnv ?? SYSTEM_BROWSER_ENV;
    const logger = this.#logger;
    const runId = crypto.randomUUID();

    const browser = await openBrowser(this.#browser, browserEnv, logger);
    let releaseLocks: (() => void) | undefined;
    let models: RunModels;
    let result: AgentResult<T>;
    try {
      models = buildModels(this.#models, {
        runId,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(logger === undefined ? {} : { logger }),
      });
      const run = models;
      const hands = this.#hands ?? (browser.kind === 'outcrawl' ? plainHands(browser.mac) : localHands(browser.mac, logger));
      const deps = bindAgent(browser.page, {
        model: run.port,
        hands,
        tabs: null,
        files: null,
        flavor: stockFlavor,
        pageLoads: browser.pageLoads,
        ...(run.look === undefined ? {} : { look: run.look }),
      });
      result = await runAgent<T>(
        { ...deps, modelCostUsd: () => run.costUsd() ?? '0' },
        {
          id: runId,
          task,
          caps: { steps: caps.steps, duration: caps.duration, budget: caps.budget ?? UNPRICED_BUDGET },
          stepFailures: STEP_FAILURES,
          verify: true,
          ...(options.schema === undefined ? {} : { schema: options.schema }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.onStep === undefined
            ? {}
            : {
                onStep: (step) => {
                  options.onStep?.(toWireStep(step));
                },
              }),
          onSession: (session) => {
            releaseLocks = bindLockReleases(browser.page, session, stockFlavor);
          },
        },
      );
    } finally {
      releaseLocks?.();
      await browser.close();
    }

    const replayUrl = await browser.replayUrl();
    const wire = toWireResult(
      result,
      browser.recordingDeclined ? 'declined' : replayUrl === undefined ? null : { url: replayUrl },
      browser.pageLoads(),
    );
    const costUsd = models.costUsd();
    return {
      id: wire.id,
      status: wire.status,
      ...(result.data === undefined ? {} : { data: result.data }),
      stopReason: wire.stopReason,
      ...(wire.error === undefined ? {} : { error: wire.error }),
      steps: result.steps.map(toWireStep),
      stepsUsed: wire.stepsUsed,
      ...(wire.goals === undefined ? {} : { goals: wire.goals }),
      findings: result.findings,
      ...(wire.suggestedSchema === undefined ? {} : { suggestedSchema: wire.suggestedSchema }),
      usage: wire.usage,
      durationMs: wire.durationMs,
      pages: wire.pages,
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(wire.replayUrl === undefined ? {} : { replayUrl: wire.replayUrl }),
      ...(wire.recordingDeclined === undefined ? {} : { recordingDeclined: wire.recordingDeclined }),
    };
  }
}

/** The agenthands planner, for a browser that sends input exactly as Scout plans it. */
function localHands(mac: boolean, logger: ScoutLogger | undefined): HandsPort {
  const failures: string[] = [];
  const hands = handsPortFor({
    env: {},
    platform: mac ? 'darwin' : 'linux',
    // The planner's own startup line describes a hosted price list, which is
    // not this run's, so only its warnings reach the caller.
    logger: {
      info: () => undefined,
      warn: (event, fields) => {
        failures.push(event);
        logger?.warn(event, fields);
      },
    },
  });
  if (hands === null) {
    throw new ScoutBrowserError(
      `the input planner could not load (${failures.join(', ')}): agenthands' keystroke data is missing from this install`,
    );
  }
  return hands;
}
