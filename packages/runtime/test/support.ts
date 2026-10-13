import { compareDecimal, multiplyDecimal, ZERO_CREDITS, type Clock, type JsonSchema, type WallClock } from '@outcrawl/scout-core';

import type { Action } from '../src/actions';
import type { CapState, ModelPricing, RunPricing } from '../src/caps';
import type {
  AgentDeps,
  AgentPrompt,
  ChallengeResolution,
  ChallengeSolving,
  ExtractBound,
  ExtractSelection,
  ExtractOutcome,
  LockReleaseReason,
  ModelChoice,
  PerformOutcome,
  RunFile,
  TabInfo,
} from '../src/loop';
import type { DocumentProbe } from '../src/settle';
import type { AxNode, AxState, AxTree, NodeRef } from '../src/snapshot';
import { nodeRef } from '../src/snapshot';

/**
 * A round price list for tests, and no host's real one: one credit a minute
 * open, 0.000002 credits a relayed byte (2,000 a GB), and 100 credits a
 * provider dollar at every tier except `double`, which is 200 — so a test can
 * see which tier priced a run. Both conversions are exact, so a funded dollar
 * figure prices back to exactly the credits that funded it.
 */
export function testPricing(model: ModelPricing = { plan: 'test', byok: false }): RunPricing {
  const perUsd = (pricing: ModelPricing): string => (pricing.plan === 'double' ? '200' : '100');
  return Object.freeze({
    creditsPerMinute: '1',
    creditsPerByte: '0.000002',
    model: Object.freeze({ plan: model.plan, byok: model.byok }),
    modelCredits(usd: string, pricing: ModelPricing): string {
      if (compareDecimal(usd, ZERO_CREDITS) < 0) throw new RangeError(`model cost must not be negative, got ${usd}`);
      return pricing.byok ? ZERO_CREDITS : multiplyDecimal(usd, perUsd(pricing));
    },
    modelUsdFundedBy(credits: string, pricing: ModelPricing): string {
      if (compareDecimal(credits, ZERO_CREDITS) <= 0) return ZERO_CREDITS;
      return multiplyDecimal(credits, pricing.plan === 'double' ? '0.005' : '0.01');
    },
  });
}

/**
 * Monotonic, injected. Every duration in the loop reads this, so a cap can be
 * tripped in microseconds instead of waited for.
 */
export class VirtualClock implements Clock {
  #now: number;

  constructor(start = 0) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    this.#now += ms;
  }

  sleep(ms: number): Promise<void> {
    this.#now += ms;
    return Promise.resolve();
  }
}

/**
 * Monotonic and FRACTIONAL, because `Clock.now()` is.
 *
 * Every other fake clock in this repo advances by whole numbers, and that is
 * precisely why a fractional `durationMs` reached production and made every
 * `POST /v1/agent` answer 500: the meter requires an integer count of
 * milliseconds, a real run measured 4708.518583999998, and no test could
 * produce a value that was not already an integer. A fake tidier than reality
 * tests nothing, so this one is deliberately untidy.
 */
export class FractionalClock implements Clock {
  #now: number;
  readonly #step: number;

  constructor(start = 0.5, step = 1.618033988749895) {
    this.#now = start;
    this.#step = step;
  }

  now(): number {
    return this.#now;
  }

  /** Advances by the irrational step, so no accumulation lands on an integer. */
  tick(times = 1): void {
    this.#now += this.#step * times;
  }

  advance(ms: number): void {
    this.#now += ms;
  }

  sleep(ms: number): Promise<void> {
    this.#now += ms;
    return Promise.resolve();
  }
}

/** Wall time, separately controllable: it can step where the monotonic clock cannot. */
export class FixedWallClock implements WallClock {
  #epochMs: number;

  constructor(epochMs = Date.parse('2026-08-30T09:00:00.000Z')) {
    this.#epochMs = epochMs;
  }

  now(): number {
    return this.#epochMs;
  }

  set(epochMs: number): void {
    this.#epochMs = epochMs;
  }
}

/**
 * What a previous attempt spent, as a resumed ledger is seeded with. Every
 * field defaults to a run that has spent nothing at the `test` tier, so a test
 * names only the quantities it is about.
 */
export function capState(over: Partial<CapState> = {}): CapState {
  return {
    steps: 0,
    credits: '0',
    charged: '0',
    pages: 0,
    bandwidthBytes: 0,
    modelCostUsd: '0',
    plan: 'test',
    byok: false,
    elapsedMs: 0,
    parkedMs: 0,
    ...over,
  };
}

/* ------------------------------------------------------------------ *
 * Tree building
 * ------------------------------------------------------------------ */

export interface NodeSpec {
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly state?: AxState;
  /** Defaults to a fresh id in frame 0. */
  readonly ref?: NodeRef;
  readonly xpath?: string;
  readonly href?: string;
  readonly children?: readonly AxNode[];
}

let nextBackendNodeId = 1;

/** A fresh reference. Ids are per-renderer-process, so the frame is explicit. */
export function ref(frameOrdinal = 0): NodeRef {
  nextBackendNodeId += 1;
  return nodeRef(frameOrdinal, nextBackendNodeId);
}

export function node(spec: NodeSpec): AxNode {
  const self = spec.ref ?? ref();
  return {
    ref: self,
    role: spec.role,
    ...(spec.name !== undefined ? { name: spec.name } : {}),
    ...(spec.value !== undefined ? { value: spec.value } : {}),
    ...(spec.state !== undefined ? { state: spec.state } : {}),
    xpath: spec.xpath ?? `/html/body/*[${String(self.backendNodeId)}]`,
    ...(spec.children !== undefined ? { children: spec.children } : {}),
    ...(spec.href !== undefined ? { href: spec.href } : {}),
  };
}

export function tree(root: AxNode, url = 'https://example.com/'): AxTree {
  return { url, root };
}

/**
 * A page shaped like the measured one: generic containers with nothing to say,
 * an `InlineTextBox` under every `StaticText`, text repeating its own
 * container's accessible name, and a hidden subtree.
 */
export function catalogueTree(extra: readonly AxNode[] = []): AxTree {
  return tree(
    node({
      role: 'RootWebArea',
      name: 'Acme store',
      children: [
        node({
          role: 'genericContainer',
          children: [
            node({
              role: 'banner',
              children: [
                node({
                  role: 'heading',
                  name: 'Acme store',
                  children: [
                    node({
                      role: 'StaticText',
                      name: 'Acme store',
                      children: [node({ role: 'InlineTextBox', name: 'Acme store' })],
                    }),
                  ],
                }),
                node({
                  role: 'link',
                  name: 'Home',
                  children: [node({ role: 'StaticText', name: 'Home' })],
                }),
              ],
            }),
            node({
              role: 'main',
              children: [
                node({
                  role: 'paragraph',
                  children: [
                    node({
                      role: 'StaticText',
                      name: 'Free shipping over 50',
                      children: [
                        node({ role: 'InlineTextBox', name: 'Free shipping' }),
                        node({ role: 'InlineTextBox', name: 'over 50' }),
                      ],
                    }),
                  ],
                }),
                node({ role: 'searchbox', name: 'Search', value: 'widget' }),
                node({ role: 'button', name: 'Search' }),
                node({ role: 'link', name: 'Widget A' }),
                node({ role: 'button', name: 'Add to basket', state: { disabled: true } }),
                node({
                  role: 'genericContainer',
                  state: { hidden: true },
                  children: [node({ role: 'button', name: 'Cookie settings' })],
                }),
                ...extra,
              ],
            }),
          ],
        }),
      ],
    }),
  );
}

/* ------------------------------------------------------------------ *
 * The injected browser
 * ------------------------------------------------------------------ */

export interface HarnessOptions {
  /** Called once per step, with the prompt and its 0-based step index. */
  readonly model: (prompt: AgentPrompt, step: number) => ModelChoice | Promise<ModelChoice>;
  readonly snapshot?: (step: number) => AxTree;
  readonly perform?: (action: Action, signal?: AbortSignal, allowanceMs?: number) => PerformOutcome | void | Promise<PerformOutcome | void>;
  readonly extract?: (
    schema: JsonSchema | undefined,
    instruction?: string,
    framing?: string,
    bound?: ExtractBound,
    selection?: ExtractSelection,
  ) => ExtractOutcome | Promise<ExtractOutcome>;
  readonly lock?: () => void | Promise<void>;
  readonly unlock?: () => void | Promise<void>;
  /** Absent leaves `AgentDeps.solveChallenge` undefined, which is the default-off case. */
  readonly solveChallenge?: (
    challenge: ChallengeSolving,
  ) => ChallengeResolution | Promise<ChallengeResolution>;
  readonly clock?: Clock;
  readonly wallClock?: WallClock;
  readonly tree?: AxTree;
  /**
   * Starting tabs. Absent leaves `AgentDeps.tabs` undefined, which is the
   * single-page case every existing test is.
   */
  readonly tabs?: readonly { readonly id: string; readonly url: string }[];
  /** The tree for a given tab, when a test drives more than one page. */
  readonly tabTree?: (tabId: string) => AxTree;
  /**
   * The run's uploaded files, as a SUPPLIER rather than a list.
   *
   * A supplier because the manifest is re-read on every step and a test has
   * to be able to make a later read differ from the first — which is the
   * whole flow `POST /v1/agent/{id}/files` accepting a file mid-run serves.
   * Absent leaves `AgentDeps.files` undefined, which is the state of nearly
   * every run and of every other test in this directory.
   */
  readonly files?: (call: number) => readonly RunFile[];
  /**
   * The document bytes, for the settle's challenge gate.
   *
   * Absent leaves `AgentDeps.document` undefined, which is the state of every
   * other test in this directory and is the host-cannot-read-the-document
   * case: the settle then behaves as it did before the gate existed. Passed
   * through verbatim rather than wrapped, so a test can count its own reads
   * and assert that a page with content never pays for one.
   */
  readonly document?: DocumentProbe;
}

export interface Harness {
  readonly deps: AgentDeps;
  /** Every boundary crossing, in order: `['lock','snapshot','model','perform','unlock']`. */
  readonly events: string[];
  readonly performed: Action[];
  readonly prompts: AgentPrompt[];
  readonly balance: { acquired: number; released: number };
  readonly clock: Clock;
  /** Live tab state, so a test can assert what the loop actually did to the browser. */
  readonly tabState: { open: { id: string; url: string }[]; active: string };
  /**
   * The browser's own view, not the session's. `frozen` is what
   * `VirtualTimePolicy::kPause` is actually doing; `liveTouches` counts page
   * operations that reached an unfrozen page, which is the only way to catch a
   * refcount that believes in a freeze that is gone.
   */
  readonly browser: { frozen: boolean; liveTouches: number };
  /**
   * The browser dropping the lock on its own, as `Outcrawl.lockReleased` does.
   * Unfreezes the page and returns the reason to hand to `noteLockReleased`,
   * so a test cannot simulate one half without the other.
   */
  release(reason: LockReleaseReason): LockReleaseReason;
}

/** A complete browser for the loop: no socket, no CDP, no process. */
export function harness(opts: HarnessOptions): Harness {
  const events: string[] = [];
  const performed: Action[] = [];
  const prompts: AgentPrompt[] = [];
  const balance = { acquired: 0, released: 0 };
  const browser = { frozen: false, liveTouches: 0 };
  const clock = opts.clock ?? new VirtualClock();
  const page = opts.tree ?? catalogueTree();
  const solver = opts.solveChallenge;
  const files = opts.files;
  let snapshots = -1;

  /**
   * The browser's tab table. A test drives it through the loop's actions and
   * asserts on it afterwards, so a tab action that is accepted but does nothing
   * is visible rather than merely green.
   */
  const tabState = {
    open: (opts.tabs ?? []).map((tab) => ({ id: tab.id, url: tab.url })),
    active: opts.tabs?.[0]?.id ?? '',
  };
  let mintedTabs = 0;

  /** Every page operation goes through here, so none can forget to be counted. */
  const touch = (name: string): void => {
    events.push(name);
    if (!browser.frozen) {
      browser.liveTouches += 1;
    }
  };

  const deps: AgentDeps = {
    async lock(): Promise<void> {
      events.push('lock');
      // The hook runs BEFORE the bookkeeping, on both halves. A hook that
      // throws stands for a command that failed, and a failed command changed
      // nothing in the browser: counting the acquire first, or flipping
      // `frozen`, would make the harness claim a freeze that does not exist -
      // in exactly the direction the failure-path tests are checking.
      await opts.lock?.();
      balance.acquired += 1;
      browser.frozen = true;
    },
    async unlock(): Promise<void> {
      events.push('unlock');
      await opts.unlock?.();
      balance.released += 1;
      browser.frozen = false;
    },
    snapshot(): AxTree {
      touch('snapshot');
      snapshots += 1;
      if (opts.tabTree !== undefined) {
        return opts.tabTree(tabState.active);
      }
      return opts.snapshot?.(snapshots) ?? page;
    },
    async model(prompt: AgentPrompt): Promise<ModelChoice> {
      events.push('model');
      prompts.push(prompt);
      return opts.model(prompt, prompt.step);
    },
    async perform(action: Action, signal?: AbortSignal, allowanceMs?: number): Promise<PerformOutcome | void> {
      touch('perform');
      performed.push(action);
      return opts.perform?.(action, signal, allowanceMs);
    },
    async extract(
      schema: JsonSchema | undefined,
      instruction?: string,
      framing?: string,
      bound?: ExtractBound,
      selection?: ExtractSelection,
    ): Promise<ExtractOutcome> {
      touch('extract');
      return opts.extract?.(schema, instruction, framing, bound, selection) ?? { data: undefined };
    },
    clock,
    ...(solver !== undefined
      ? {
          async solveChallenge(challenge: ChallengeSolving): Promise<ChallengeResolution> {
            events.push('solve');
            return solver(challenge);
          },
        }
      : {}),
    ...(opts.wallClock !== undefined ? { wallClock: opts.wallClock } : {}),
    ...(opts.document === undefined ? {} : { document: opts.document }),
    ...(files !== undefined
      ? {
          files: {
            list(): readonly RunFile[] {
              // Counted through `events`, so a test can see WHEN the loop
              // asked: once at the start, and again on every later step.
              events.push('files.list');
              return files(events.filter((event) => event === 'files.list').length - 1);
            },
          },
        }
      : {}),
    ...(opts.tabs !== undefined
      ? {
          tabs: {
            list(): readonly TabInfo[] {
              touch('tabs.list');
              return tabState.open.map((tab) => ({
                id: tab.id,
                url: tab.url,
                active: tab.id === tabState.active,
              }));
            },
            open(url: string): string {
              touch('tabs.open');
              mintedTabs += 1;
              const id = `t${String(mintedTabs + tabState.open.length)}`;
              tabState.open.push({ id, url });
              // Focused on return. That is the published contract, and a fake
              // that did not honour it would let a loop bug through.
              tabState.active = id;
              return id;
            },
            focus(id: string): void {
              touch('tabs.focus');
              if (!tabState.open.some((tab) => tab.id === id)) {
                throw new Error(`no such tab ${id}`);
              }
              tabState.active = id;
            },
            close(id: string): void {
              touch('tabs.close');
              tabState.open = tabState.open.filter((tab) => tab.id !== id);
              if (tabState.active === id) {
                tabState.active = tabState.open[0]?.id ?? '';
              }
            },
          },
        }
      : {}),
  };

  return {
    deps,
    events,
    performed,
    prompts,
    balance,
    clock,
    tabState,
    browser,
    release(reason: LockReleaseReason): LockReleaseReason {
      events.push(`released:${reason}`);
      browser.frozen = false;
      return reason;
    },
  };
}

/** The reference of the first node with this name. Throws rather than returning undefined. */
export function refOf(page: AxTree, name: string): NodeRef {
  const found = find(page.root, name);
  if (found === undefined) {
    throw new Error(`no node named ${name} in the fixture`);
  }
  return found;
}

function find(current: AxNode, name: string): NodeRef | undefined {
  if (current.name === name) {
    return current.ref;
  }
  for (const child of current.children ?? []) {
    const hit = find(child, name);
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}
