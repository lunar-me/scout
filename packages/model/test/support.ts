/**
 * Fixtures. Nothing here opens a socket, and the provider is a fake with a
 * scripted queue so every failure path is reachable without a key.
 */

import type { Clock } from '@outcrawl/scout-core';
import {
  hashSnapshot,
  nodeRef,
  renderPrompt,
  type AgentPrompt,
  type AxNode,
  type AxState,
  type AxTree,
  type NodeRef,
  type StepTrace,
} from '@outcrawl/runtime';

import type { ModelPlan, PlanModel } from '../src/harness';
import {
  ZERO_TOKENS,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type TokenUsage,
} from '../src/provider';

/* ------------------------------------------------------------------ *
 * Plans
 * ------------------------------------------------------------------ */

/** The rank-0 hands (actuator) model in every literal plan below. */
export const HANDS_MODEL = 'hands-model';
/** The brain model in {@link brainPlan}. */
export const BRAIN_MODEL = 'brain-model';

/**
 * A brain over a three-rank hands chain, the shape a host's brain plan has:
 * the rank-0 hands model carries a measured action deadline and extract hedge,
 * the brain asks for no `reasoning` field and is routed to its own upstream
 * first. `null` is the same chain with no brain (the hands alone).
 */
export function brainPlan(
  brain: { readonly model?: string; readonly effort?: PlanModel['effort'] } | null = {},
): ModelPlan {
  // The cost gate's expected calls per step: a brain step also calls the eyes.
  const callsPerStep = brain === null ? 1 : 2;
  const actuators: readonly PlanModel[] = [
    { model: HANDS_MODEL, rank: 0, callsPerStep, actionDeadlineMs: 12_000, extractHedgeMs: 15_000, replyReasoning: true },
    { model: 'hands-fallback', rank: 1, callsPerStep, replyReasoning: true },
    { model: 'hands-fallback-2', rank: 2, callsPerStep, replyReasoning: true },
  ];
  if (brain === null) return { actuators };
  return {
    actuators,
    brain: {
      model: brain.model ?? BRAIN_MODEL,
      rank: 0,
      callsPerStep: 1,
      effort: brain.effort ?? 'medium',
      providerOrder: ['provider-a'],
      replyReasoning: false,
    },
  };
}

/** Monotonic, injected: a 60s deadline is reached in microseconds. */
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

  /** Every `sleep` asked for, in order: the per-call deadline race and any wait. */
  readonly slept: number[] = [];

  /**
   * Resolves immediately, having moved the clock. That is what makes the
   * client's `Promise.race` deadline testable: a provider that never settles
   * loses the race in the same tick instead of in a minute.
   */
  sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    this.#now += ms;
    return Promise.resolve();
  }
}

/* ------------------------------------------------------------------ *
 * Trees
 * ------------------------------------------------------------------ */

export interface NodeSpec {
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly xpath: string;
  /** Explicit, because a session boundary is exactly a change of these. */
  readonly backendNodeId: number;
  readonly children?: readonly AxNode[];
  readonly state?: AxState;
}

export function node(spec: NodeSpec): AxNode {
  return {
    ref: nodeRef(0, spec.backendNodeId),
    role: spec.role,
    ...(spec.name !== undefined ? { name: spec.name } : {}),
    ...(spec.value !== undefined ? { value: spec.value } : {}),
    xpath: spec.xpath,
    ...(spec.children !== undefined ? { children: spec.children } : {}),
    ...(spec.state !== undefined ? { state: spec.state } : {}),
  };
}

/**
 * A one-button page, with the backend node ids under the caller's control.
 *
 * `idBase` is the point: the same page fetched in a second session carries
 * different ids for the same elements, because `DOMNodeIds::IdToNodeMap()` is a
 * per-renderer-process static. The XPaths are stable. That is precisely the
 * situation an action cache in front of the model has to survive, so it is
 * the fixture.
 */
export function cartPage(idBase: number): AxTree {
  return {
    url: 'https://shop.example.com/cart',
    root: node({
      role: 'RootWebArea',
      name: 'Cart',
      xpath: '/html',
      backendNodeId: idBase,
      children: [
        node({
          role: 'button',
          name: 'Checkout',
          xpath: '/html/body/div[1]/button[1]',
          backendNodeId: idBase + 1,
        }),
        node({
          role: 'textbox',
          name: 'Coupon',
          xpath: '/html/body/div[1]/input[1]',
          backendNodeId: idBase + 2,
        }),
      ],
    }),
  };
}

export function promptFor(tree: AxTree, task = 'check out', step = 0, history: readonly StepTrace[] = []): AgentPrompt {
  const base = {
    task,
    step,
    tree,
    snapshotHash: hashSnapshot(tree),
    history,
  };
  return { ...base, text: renderPrompt(base) };
}

/** The reference of the first node with this name. Throws rather than guessing. */
export function refOf(tree: AxTree, name: string): NodeRef {
  const found = find(tree.root, name);
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
    const found = find(child, name);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * The fake provider
 * ------------------------------------------------------------------ */

export type ScriptedTurn = ModelResponse | Error | { readonly hang: true };

/**
 * A provider with a scripted queue.
 *
 * Two properties matter for the tests that use it: it counts calls, so "the
 * step did not reach the provider" is an assertion rather than a belief; and it
 * fails when the script runs out, so a test that expected one call and got two
 * fails instead of silently reusing the last answer.
 */
export class FakeProvider implements ModelProvider {
  readonly name = 'fake';
  readonly requests: ModelRequest[] = [];
  readonly #turns: ScriptedTurn[];

  constructor(turns: readonly ScriptedTurn[] = []) {
    this.#turns = [...turns];
  }

  get calls(): number {
    return this.requests.length;
  }

  push(turn: ScriptedTurn): void {
    this.#turns.push(turn);
  }

  complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const turn = this.#turns.shift();
    if (turn === undefined) {
      return Promise.reject(
        new Error(`the fake provider was called ${String(this.requests.length)} times; the script has run out`),
      );
    }
    if (turn instanceof Error) {
      return Promise.reject(turn);
    }
    if ('hang' in turn) {
      // Never settles. The client's own deadline is the only thing that can end
      // this, which is the point of the case.
      return new Promise<ModelResponse>(() => undefined);
    }
    return Promise.resolve(turn);
  }
}

/** A reply billed at `costUsd`, the exact USD the provider stated for it. */
export function reply(text: string, usage: Partial<TokenUsage> = {}, costUsd = '0'): ModelResponse {
  return {
    text,
    usage: { ...ZERO_TOKENS, ...usage },
    costUsd,
    costSource: 'provider',
    stopReason: 'end_turn',
  };
}

/** A well-formed agent reply naming a node that is in the tree. */
export function clickReply(ref: NodeRef, usage: Partial<TokenUsage> = {}, costUsd = '0'): ModelResponse {
  return reply(
    JSON.stringify({
      reasoning: 'the Checkout button is the only way forward',
      actions: [
        { type: 'click', ref: `${String(ref.frameOrdinal)}-${String(ref.backendNodeId)}` },
      ],
    }),
    usage,
    costUsd,
  );
}

/* ------------------------------------------------------------------ *
 * Negative assertions
 * ------------------------------------------------------------------ */

/**
 * The error a promise rejected with, or a loud failure if it resolved.
 *
 * `try { await p } catch (e) { assert on e }` is the trap: a promise that wrongly
 * *succeeds* skips the catch, every assertion inside it never runs, and the test
 * passes while proving nothing. This throws on a resolution, so the only way past
 * it is a real rejection.
 */
export async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  let resolved: { value: unknown } | undefined;
  try {
    resolved = { value: await promise };
  } catch (thrown) {
    return thrown;
  }
  throw new Error(`expected a rejection, but the call returned ${JSON.stringify(resolved.value)}`);
}
