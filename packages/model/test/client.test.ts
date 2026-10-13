/**
 * The client, driven through every outcome a step can have.
 *
 * The negative cases are the point of this file. A model client that returns an
 * empty object when the model wrote prose looks identical to one working on a
 * blank page, so each failure here asserts on a rejection through `thrownBy`,
 * which fails loudly if the call returned instead of throwing.
 */

import { describe, expect, test } from 'bun:test';
import type { JsonSchema } from '@outcrawl/scout-core';
import {
  hashSnapshot,
  renderPrompt,
  type AgentPrompt,
  type AxTree,
} from '@outcrawl/runtime';

import { MAX_SCHEMA_CORRECTIONS, ModelClient, replyShape, type ModelCallEvent, type WithdrawnCall } from '../src/client';
import { BRAIN_SCHEMA } from '../src/brain';
import { CostLedger } from '../src/ledger';
import { validate } from '../src/schema';
import {
  ModelConfigError,
  ModelProviderError,
  ModelSchemaError,
  ModelTimeoutError,
  ModelUnusableError,
  ZERO_TOKENS,
} from '../src/provider';
import {
  FakeProvider,
  VirtualClock,
  cartPage,
  clickReply,
  node,
  promptFor,
  refOf,
  reply,
  thrownBy,
  type ScriptedTurn,
} from './support';

const MODEL = 'hands-model';

/**
 * A host pipeline's extraction seam, the shape a renderer calls with a page's
 * markdown and the customer's schema. Inlined: this package depends on no
 * renderer, and the client must satisfy the seam exactly.
 */
interface PipelineDeps {
  readonly extractJson: ((opts: { markdown: string; schema: JsonSchema }) => Promise<unknown>) | null;
}

/**
 * `true` only when two types are mutually assignable. A type-level assertion,
 * used once below: `expect` cannot compare types, and an ordinary assignment is
 * too weak for the case that matters. The tuple wrapping defeats distribution
 * over unions.
 */
type SameShape<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

function clientWith(
  turns: readonly ScriptedTurn[],
  options: {
    ledger?: CostLedger;
    sessionId?: string;
  } = {},
): {
  client: ModelClient;
  provider: FakeProvider;
  ledger: CostLedger;
  clock: VirtualClock;
  /** Every event the client emitted, in order. Captured rather than printed:
   * a mechanism this suite cannot see is a mechanism that can stop firing
   * without a failure. */
  corrections: readonly { attempt: number; violations: readonly string[]; purpose: string; shape?: string }[];
  repairs: readonly Record<string, unknown>[];
  resends: readonly { attempt: number; cause: unknown; purpose: string }[];
  /** Every `onCall` line, in order. */
  calls: readonly ModelCallEvent[];
  /** Every `onWithdrawn` report, in order. */
  withdrawn: readonly WithdrawnCall[];
} {
  const provider = new FakeProvider(turns);
  const ledger = options.ledger ?? new CostLedger();
  const clock = new VirtualClock();
  const corrections: { attempt: number; violations: readonly string[]; purpose: string; shape?: string }[] = [];
  const repairs: Record<string, unknown>[] = [];
  const resends: { attempt: number; cause: unknown; purpose: string }[] = [];
  const calls: ModelCallEvent[] = [];
  const withdrawn: WithdrawnCall[] = [];
  const client = new ModelClient({
    provider,
    model: MODEL,
    session: { sessionId: options.sessionId ?? 'sess-1', accountId: 'acct-1' },
    ledger,
    clock,
    onCorrection: (event) => corrections.push({ ...event }),
    onRepair: (event) => repairs.push({ ...event }),
    onResend: (event) => resends.push({ ...event }),
    onCall: (event) => calls.push(event),
    onWithdrawn: (call) => withdrawn.push(call),
  });
  return { client, provider, ledger, clock, corrections, repairs, resends, calls, withdrawn };
}

/** A prompt that carries caps, which is what `runAgent` always sends. */
function cappedPrompt(page: AxTree, elapsedMs = 0, step = 0): AgentPrompt {
  const base = {
    task: 'check out',
    step,
    tree: page,
    snapshotHash: hashSnapshot(page),
    history: [],
    caps: {
      limits: { steps: 10, budget: '2.00', duration: '5s' },
      used: { steps: step, credits: '0.10', charged: '0.10', pages: 0, bandwidthBytes: 0, modelCostUsd: '0', plan: 'builder', byok: false, elapsedMs, parkedMs: 0 },
    },
  } satisfies Omit<AgentPrompt, 'text'>;
  return { ...base, text: renderPrompt(base) };
}

describe('the agent step', () => {
  test('a well-formed reply becomes a validated action, priced and attributed', async () => {
    const page = cartPage(100);
    const checkout = refOf(page, 'Checkout');
    const { client, provider, ledger } = clientWith([
      clickReply(checkout, { inputTokens: 1000, outputTokens: 100 }, '0.003'),
    ]);

    const choice = await client.choose(promptFor(page));

    expect(choice.action).toEqual({ type: 'click', ref: checkout });
    expect(choice.reasoning).toBe('the Checkout button is the only way forward');
    expect(choice.usage?.inputTokens).toBe(1000);
    expect(choice.usage?.outputTokens).toBe(100);
    expect(choice.cache?.status).toBe('MISS');
    expect(provider.calls).toBe(1);

    // Recorded at the USD the provider stated for the call, under the session.
    expect(ledger.totalsFor('sess-1').costUsd).toBe('0.003');
    expect(ledger.entries()[0]?.accountId).toBe('acct-1');
    expect(ledger.entries()[0]?.purpose).toBe('action');
  });

  test('a flat action at the top level is wrapped into actions, not refused for the missing bracket', async () => {
    // Measured production shape, 7 occurrences / 6 runs: the whole reply WAS
    // the action, with `type`/`ref`/`text` as siblings of nothing — schema
    // violation `$.actions: required property is missing`.
    const page = cartPage(220);
    const checkout = refOf(page, 'Checkout');
    const { client, provider, repairs } = clientWith([
      reply(
        JSON.stringify({
          type: 'click',
          ref: `${String(checkout.frameOrdinal)}-${String(checkout.backendNodeId)}`,
          reasoning: 'only one thing to click',
        }),
      ),
    ]);

    const choice = await client.choose(promptFor(page));

    expect(choice.action).toEqual({ type: 'click', ref: checkout });
    expect(choice.reasoning).toBe('only one thing to click');
    expect(provider.calls).toBe(1);
    expect(repairs).toEqual([{ repair: 'wrapped-bare-action' }]);
  });

  test('an object with no legal action type is still refused, not guessed into one', async () => {
    const page = cartPage(221);
    const { client, repairs } = clientWith([
      reply(JSON.stringify({ ref: '0-2', text: 'hello' })),
      reply(JSON.stringify({ ref: '0-2', text: 'hello' })),
    ]);

    const thrown = await thrownBy(client.choose(promptFor(page)));

    expect(thrown).toBeInstanceOf(ModelSchemaError);
    expect(repairs).toEqual([]);
  });

  test('a goal update with a status this schema does not accept is dropped, the action is not', async () => {
    // Measured production shape: `$.goal.status: "active" is not one of
    // ["done","failed"]` — the model marking a sub-goal in progress, which
    // needs no update at all under PLAN_RULES.
    const page = cartPage(222);
    const checkout = refOf(page, 'Checkout');
    const { client, repairs } = clientWith([
      reply(
        JSON.stringify({
          actions: [{ type: 'click', ref: `${String(checkout.frameOrdinal)}-${String(checkout.backendNodeId)}` }],
          goal: { id: 'g1', status: 'active' },
        }),
      ),
    ]);

    const choice = await client.choose(promptFor(page));

    expect(choice.action).toEqual({ type: 'click', ref: checkout });
    expect(choice.envelope).toBeUndefined();
    expect(repairs).toEqual([{ repair: 'dropped-invalid-goal-status', status: 'active' }]);
  });

  /**
   * The two shapes `run_c251827d` (production, 2026-10-01 12:26Z) sent when
   * the loop asked it to close an open sub-goal, each refused as a schema
   * error until the step ceiling ended the run.
   */
  test('a goal update nested on an action moves to the reply, and the action stands', async () => {
    const page = cartPage(223);
    const { client, repairs } = clientWith([
      reply(
        JSON.stringify({
          actions: [{ type: 'done', summary: 'custname: X', goal: { id: 'g1', status: 'done', summary: 'extracted' } }],
        }),
      ),
    ]);

    const choice = await client.choose(promptFor(page));

    expect(choice.action).toEqual({ type: 'done', summary: 'custname: X' });
    expect(choice.envelope?.goal).toEqual({ id: 'g1', status: 'done', summary: 'extracted' });
    expect(repairs).toEqual([{ repair: 'hoisted-goal-from-actions' }]);
  });

  // The prompt's rule reads "Any action may also carry "finding"", and a small
  // hands model under `tool_choice` wrote it on the action (2026-10-13). The
  // refusal cost a call and the retry dropped the finding.
  test('a finding written on the chosen action is kept as the reply finding, not refused', async () => {
    const page = cartPage(225);
    const checkout = refOf(page, 'Checkout');
    const ref = `${String(checkout.frameOrdinal)}-${String(checkout.backendNodeId)}`;
    const { client, provider } = clientWith([
      reply(JSON.stringify({ actions: [{ type: 'click', ref, finding: 'heading: Secure Area' }] })),
    ]);

    const choice = await client.choose(promptFor(page));

    expect(provider.calls).toBe(1);
    expect(choice.action).toEqual({ type: 'click', ref: checkout });
    expect(choice.envelope?.finding).toBe('heading: Secure Area');
  });

  test('a finding the reply already carries wins over one nested on the action', async () => {
    const page = cartPage(226);
    const checkout = refOf(page, 'Checkout');
    const ref = `${String(checkout.frameOrdinal)}-${String(checkout.backendNodeId)}`;
    const { client } = clientWith([
      reply(JSON.stringify({ finding: 'reply level', actions: [{ type: 'click', ref, finding: 'nested' }] })),
    ]);

    const choice = await client.choose(promptFor(page));

    expect(choice.envelope?.finding).toBe('reply level');
  });

  test('a goal update written as an action becomes the reply goal, not a failed step', async () => {
    const page = cartPage(224);
    const { client, provider } = clientWith([
      reply(JSON.stringify({ actions: [{ type: 'goal', id: 'g1', status: 'done', summary: 'answer recorded' }] })),
    ]);

    const choice = await client.choose(promptFor(page));

    expect(provider.calls).toBe(1);
    expect(choice.envelope?.goal).toEqual({ id: 'g1', status: 'done', summary: 'answer recorded' });
    // Nothing else was asked for, so nothing that touches the page is done.
    expect(choice.action).toEqual({ type: 'wait', seconds: 1 });
  });

  test('an alternative that fails the action schema is dropped, the choice is not', async () => {
    // Measured production shape: `$.actions[1].type: required property is
    // missing; $.actions[1].reasoning: unexpected property` — a stray
    // alternative should never have sunk a reply whose actual choice was
    // fine, which is exactly what happened before this repair: the
    // whole-object schema check ran before the per-item alternative
    // tolerance ever got a turn.
    const page = cartPage(223);
    const checkout = refOf(page, 'Checkout');
    const { client, repairs } = clientWith([
      reply(
        JSON.stringify({
          actions: [
            { type: 'click', ref: `${String(checkout.frameOrdinal)}-${String(checkout.backendNodeId)}` },
            { reasoning: 'or maybe this instead' },
          ],
        }),
      ),
    ]);

    const choice = await client.choose(promptFor(page));

    expect(choice.action).toEqual({ type: 'click', ref: checkout });
    expect(choice.alternatives).toBeUndefined();
    expect(repairs).toEqual([{ repair: 'dropped-invalid-alternative', count: 1 }]);
  });

  test('narration around the JSON object is stripped before the parser sees it', async () => {
    // Measured production shape: `JSON Parse error: Unexpected identifier
    // "The"` — 7 of 38 "not valid JSON" failures were this exact family
    // (also "I", "IThe", "TheThe"), which is the JSON parser reading the
    // first word of a sentence where a value was expected.
    const page = cartPage(224);
    const checkout = refOf(page, 'Checkout');
    const action = JSON.stringify({
      actions: [{ type: 'click', ref: `${String(checkout.frameOrdinal)}-${String(checkout.backendNodeId)}` }],
    });
    const { client, provider, repairs } = clientWith([
      reply(`The correct move is to click checkout: ${action}\n\nThat should complete the purchase.`),
    ]);

    const choice = await client.choose(promptFor(page));

    expect(choice.action).toEqual({ type: 'click', ref: checkout });
    expect(provider.calls).toBe(1);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.['repair']).toBe('stripped-json-wrapper');
  });

  test('text with no JSON object anywhere in it is still refused, with the real parser error', async () => {
    const page = cartPage(225);
    const { client, repairs } = clientWith([
      reply('The button should be clicked next.'),
      reply('The button should be clicked next.'),
    ]);

    const thrown = await thrownBy(client.choose(promptFor(page)));

    expect(thrown).toBeInstanceOf(ModelSchemaError);
    expect((thrown as ModelSchemaError).violations[0]).toContain('is not valid JSON');
    expect(repairs).toEqual([]);
  });

  test('the request carries the action grammar as a provider-enforced schema', async () => {
    const page = cartPage(200);
    const { client, provider } = clientWith([clickReply(refOf(page, 'Checkout'))]);

    await client.choose(promptFor(page));

    const sent = provider.requests[0];
    expect(sent?.model).toBe(MODEL);
    expect(sent?.schema?.['type']).toBe('object');
    // The vocabulary comes from ACTION_TYPES rather than a hand-written list, so
    // an action added to the runtime cannot silently be unrequestable here.
    // Resolved through `$defs`, because the element is declared once and
    // referenced by `actions`, `then` and `also` — see AGENT_REPLY_SCHEMA for
    // why three inlined copies would blow the provider's parameter cap.
    const schema = sent?.schema as {
      $defs?: { action?: { properties?: Record<string, { enum?: string[] }> } };
      properties?: Record<string, { items?: { $ref?: string } }>;
    };
    const element = schema.$defs?.action;
    expect(element?.properties?.['type']?.enum).toContain('click');
    expect(element?.properties?.['type']?.enum).toContain('done');
    for (const field of ['actions', 'then', 'also']) {
      expect(schema.properties?.[field]?.items?.$ref).toBe('#/$defs/action');
    }
    // `tab` is the argument of `focusTab` and `closeTab`, and its absence made
    // both of them unemittable while the prompt kept offering them: the model
    // could name the action and not its target, `validateAction` refused it,
    // and the run spent a step and a slice of `stepFailures` on a grammar we
    // published and did not supply.
    expect(element?.properties?.['tab']).toBeDefined();
    // `click`'s point and `drag`'s ends. Under `additionalProperties: false`
    // plus `strict: true` an undeclared field is ungrammatical, so without
    // these the two verbs are in the enum and cannot be written.
    expect(validate({ type: 'click', at: { x: 412, y: 230 } }, element as Record<string, unknown>)).toEqual([]);
    expect(validate({ type: 'drag', from: '0-12', to: { x: 600, y: 400 } }, element as Record<string, unknown>)).toEqual(
      [],
    );
    expect(validate({ type: 'drag', from: { x: 1 }, to: '0-9' }, element as Record<string, unknown>)).not.toEqual([]);
    // The envelope. Every one of these was declared in the runtime and
    // ungrammatical here, so `findings` and `goals` never populated on any run
    // this client has ever driven.
    for (const field of ['finding', 'ruledOut', 'goal', 'plan']) {
      expect(schema.properties?.[field]).toBeDefined();
    }
    // The rendered prompt is passed through untouched: it is what makes a step
    // reproducible and therefore cacheable.
    expect(sent?.prompt).toBe(renderPrompt({ ...promptFor(page) }));
  });

  test('the envelope reaches the loop instead of being stripped with the action', async () => {
    const page = cartPage(210);
    const checkout = refOf(page, 'Checkout');
    const { client } = clientWith([
      reply(
        JSON.stringify({
          reasoning: 'buying it, and noting the price before this page goes',
          actions: [{ type: 'click', ref: `${String(checkout.frameOrdinal)}-${String(checkout.backendNodeId)}` }],
          finding: 'the kettle is 39.50 at shop.bench',
          ruledOut: 'the toasters category is empty',
          goal: { id: 'g1', status: 'done', summary: 'kettle priced' },
          plan: [{ id: 'g2', goal: 'price it at the second vendor', site: 'other.test' }],
          then: [{ type: 'press', key: 'Enter' }],
          also: [{ type: 'extract', tab: 't2', instruction: 'the price' }],
        }),
        { inputTokens: 1000, outputTokens: 100 },
      ),
    ]);

    const choice = await client.choose(promptFor(page));

    // Every one of these was unreachable in production: the schema forbade the
    // model from emitting it, and `validateAction` rebuilds the action from
    // scratch so anything that arrived was stripped before the loop saw it.
    expect(choice.envelope?.finding).toBe('the kettle is 39.50 at shop.bench');
    expect(choice.envelope?.ruledOut).toBe('the toasters category is empty');
    expect(choice.envelope?.goal).toEqual({ id: 'g1', status: 'done', summary: 'kettle priced' });
    expect(choice.envelope?.plan).toEqual([
      { id: 'g2', goal: 'price it at the second vendor', site: 'other.test' },
    ]);
    // Raw, and that is the contract: each element is validated against the tree
    // of the tab it is about at the moment it is dispatched, so a parsed
    // `Action` here would be a reference accepted against no page at all.
    expect(choice.envelope?.then).toEqual([{ type: 'press', key: 'Enter' }]);
    expect(choice.envelope?.also).toEqual([{ type: 'extract', tab: 't2', instruction: 'the price' }]);
    // And the action itself is untouched by any of it.
    expect(choice.action).toEqual({ type: 'click', ref: checkout });
  });

  test('a reply with no envelope carries none, so a single-action step is unchanged', async () => {
    const page = cartPage(211);
    const { client } = clientWith([clickReply(refOf(page, 'Checkout'))]);

    const choice = await client.choose(promptFor(page));

    // Absent rather than an empty object. The loop spreads this over
    // `parseEnvelope(choice.action)`, and an empty object present would still
    // read as "the client split the envelope out", which is a different claim
    // from "there was none".
    expect(choice.envelope).toBeUndefined();
  });

  test('prose where JSON was promised is an error, not an empty result', async () => {
    const page = cartPage(300);
    const prose = "I'd click the Checkout button now.";
    // TWICE, because one refused reply is now told what was wrong and asked
    // again — see `MAX_SCHEMA_CORRECTIONS`. A model that writes the same prose
    // after being shown the violation is the terminal case, and that is what
    // this asserts: an error, never an empty result.
    const { client, ledger } = clientWith([
      reply(prose, { inputTokens: 900, outputTokens: 20 }, '0.002'),
      reply(prose, { inputTokens: 900, outputTokens: 20 }, '0.002'),
    ]);

    const thrown = await thrownBy(client.choose(promptFor(page)));

    expect(thrown).toBeInstanceOf(ModelSchemaError);
    expect((thrown as ModelSchemaError).violations[0]).toMatch(/not valid JSON/);
    expect((thrown as ModelSchemaError).sample).toContain('Checkout button');
    // Billed, so recorded — BOTH of them. A schema failure that vanished from
    // the ledger would understate spend on exactly the runs someone is
    // investigating, and a correction that billed invisibly would be worse
    // still: it is a call this code chose to make.
    expect(ledger.totals().calls).toBe(2);
    expect(ledger.entries().map((row) => row.outcome)).toEqual(['schema', 'schema']);
    expect(ledger.totals().costUsd).toBe('0.004');
  });

  test('valid JSON of the wrong shape is an error too', async () => {
    const page = cartPage(400);
    const empty = JSON.stringify({ actions: [] });
    const { client } = clientWith([reply(empty), reply(empty)]);

    const thrown = await thrownBy(client.choose(promptFor(page)));

    expect(thrown).toBeInstanceOf(ModelSchemaError);
    expect((thrown as ModelSchemaError).violations.join(' ')).toMatch(/at least 1 items/);
  });

  test('an action naming a node outside the snapshot is refused, never guessed at', async () => {
    const page = cartPage(500);
    const stale = JSON.stringify({
      actions: [{ type: 'click', ref: '0-99999' }],
    });
    const { client } = clientWith([reply(stale), reply(stale)]);

    const thrown = await thrownBy(client.choose(promptFor(page)));

    expect(thrown).toBeInstanceOf(ModelSchemaError);
    expect((thrown as ModelSchemaError).violations.join(' ')).toMatch(/not in the snapshot/);
  });

  test('an unusable alternative is dropped while the chosen action stands', async () => {
    const page = cartPage(600);
    const checkout = refOf(page, 'Checkout');
    const { client } = clientWith([
      reply(
        JSON.stringify({
          actions: [
            { type: 'click', ref: `0-${String(checkout.backendNodeId)}` },
            { type: 'click', ref: '0-4242' },
          ],
        }),
      ),
    ]);

    const choice = await client.choose(promptFor(page));

    expect(choice.action).toEqual({ type: 'click', ref: checkout });
    expect(choice.alternatives).toBeUndefined();
  });

  test('a provider refusal is billed and reported, not swallowed', async () => {
    const page = cartPage(700);
    const { client, ledger } = clientWith([
      new ModelUnusableError(
        'refusal',
        'general_harms: declined',
        { inputTokens: 500, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        '0.0011',
      ),
    ]);

    const thrown = await thrownBy(client.choose(promptFor(page)));

    expect(thrown).toBeInstanceOf(ModelUnusableError);
    expect(ledger.entries()[0]?.outcome).toBe('unusable');
    // A refusal is a 200 the provider charges for, at the cost it stated.
    expect(ledger.totals().costUsd).toBe('0.0011');
    expect(ledger.totals().billed).toBe(1);
  });

  test('a provider error propagates with its retry verdict and costs nothing', async () => {
    const page = cartPage(800);
    const { client, ledger } = clientWith([
      new ModelProviderError({
        status: 429,
        providerCode: 'rate_limit_error',
        message: 'slow down',
        retryable: true,
      }),
    ]);

    const thrown = await thrownBy(client.choose(promptFor(page)));

    expect(thrown).toBeInstanceOf(ModelProviderError);
    expect((thrown as ModelProviderError).retryable).toBe(true);
    expect(ledger.entries()[0]?.outcome).toBe('provider');
    expect(ledger.totals().costUsd).toBe('0');
  });

  test('a provider that never answers loses to the client deadline', async () => {
    const page = cartPage(900);
    const { client, provider, ledger } = clientWith([{ hang: true }]);

    const thrown = await thrownBy(client.choose(promptFor(page)));

    expect(thrown).toBeInstanceOf(ModelTimeoutError);
    expect((thrown as ModelTimeoutError).timeoutMs).toBe(60_000);
    expect(provider.calls).toBe(1);
    expect(ledger.entries()[0]?.outcome).toBe('timeout');
    // Nothing was billed: the provider never answered.
    expect(ledger.totals().costUsd).toBe('0');
    expect(ledger.totals().billed).toBe(0);
  });

  test("a call that outlived its deadline is the house's spend at an estimate, never the run's", async () => {
    const page = cartPage(900);
    const { client, ledger, withdrawn } = clientWith([{ hang: true }]);

    expect(await thrownBy(client.choose(promptFor(page)))).toBeInstanceOf(ModelTimeoutError);

    // The run: nothing. The gateway bills a non-streaming request that was sent
    // and then abandoned, so the house reports it.
    expect(ledger.totals().costUsd).toBe('0');
    expect(withdrawn).toMatchObject([
      { model: MODEL, purpose: 'action', outcome: 'timeout', costSource: 'estimate', elapsedMs: 60_000 },
    ]);
  });

  test('a call never sent because no duration was left is nobody\'s spend', async () => {
    const { client, withdrawn } = clientWith([]);

    expect(await thrownBy(client.choose(cappedPrompt(cartPage(1000), 5_200, 3)))).toBeInstanceOf(ModelTimeoutError);
    expect(withdrawn).toEqual([]);
  });

  test('every provider call is exactly one line, with the outcome the ledger recorded', async () => {
    const page = cartPage(950);
    const checkout = refOf(page, 'Checkout');

    // Answered: one line, attempt 1, its tokens and price.
    const answered = clientWith([clickReply(checkout, { inputTokens: 1000, outputTokens: 100 }, '0.003')]);
    await answered.client.choose(promptFor(page));
    expect(answered.calls).toEqual([
      {
        provider: 'fake',
        model: MODEL,
        purpose: 'action',
        attempt: 1,
        hedge: false,
        outcome: 'ok',
        // `VirtualClock` moves by the abandoned deadline race, so the figure is
        // the fixture's; that a number is reported is what is checked here.
        latencyMs: expect.any(Number),
        usage: { ...ZERO_TOKENS, inputTokens: 1000, outputTokens: 100 },
        costUsd: '0.003',
      },
    ]);

    // Refused, corrected, answered: two lines, counted up, each with its own outcome.
    const corrected = clientWith([
      reply(JSON.stringify({ actions: [{ type: 'click', ref: '0-999999' }] }), {}, '0.001'),
      clickReply(checkout, {}, '0.002'),
    ]);
    await corrected.client.choose(promptFor(page));
    expect(corrected.calls.map((call) => [call.attempt, call.outcome, call.costUsd])).toEqual([
      [1, 'schema', '0.001'],
      [2, 'ok', '0.002'],
    ]);
    expect(corrected.calls[0]?.error).toContain('does not satisfy the schema');

    // Never answered: one line, at the deadline, unbilled.
    const stalled = clientWith([{ hang: true }]);
    await thrownBy(stalled.client.choose(promptFor(page)));
    expect(stalled.calls.map((call) => [call.outcome, call.latencyMs, call.costUsd])).toEqual([['timeout', 60_000, '0']]);
    expect(stalled.calls.length).toBe(stalled.ledger.entries().length);
  });

  test('a run with no duration left never starts a call it cannot use', async () => {
    const page = cartPage(1000);
    const { client, provider } = clientWith([]);

    const thrown = await thrownBy(client.choose(cappedPrompt(page, 5_200, 3)));

    expect(thrown).toBeInstanceOf(ModelTimeoutError);
    expect(provider.calls).toBe(0);
  });

  /**
   * The production shape, 2026-09-24 from 12Z: the gateway answers HTTP 200
   * with `{"error":{"code":502,"message":"Upstream error from provider-a: …"}}`.
   * It was 7-16% of every agent step and neither `choose` nor the chain acted
   * on it, so each one was a failed step and three in a row ended the run
   * (run_41d1229b-44fd-404b-9d1e-326c4be4bc94: steps 0-3, all four this).
   */
  const inlineUpstream502 = (): ModelProviderError =>
    new ModelProviderError({
      status: 200,
      providerCode: 'gateway_502',
      message: 'Upstream error from provider-a: The server had an error while processing your request.',
      retryable: true,
      upstreamStatus: 502,
    });

  /** A transport failure that never reached HTTP: nothing upstream said it was down. */
  const transportFailure = (): ModelProviderError =>
    new ModelProviderError({ status: 0, providerCode: 'network', message: 'socket hang up', retryable: true });

  test('a transport failure is resent to the same model once, after a wait', async () => {
    const page = cartPage(1100);
    const checkout = refOf(page, 'Checkout');
    const { client, provider, clock, resends } = clientWith([transportFailure(), clickReply(checkout)]);

    const choice = await client.choose(promptFor(page));

    expect(choice.action).toEqual({ type: 'click', ref: checkout });
    expect(provider.calls).toBe(2);
    expect(provider.requests[1]?.model).toBe(provider.requests[0]?.model);
    expect(resends.map((event) => [event.attempt, event.purpose])).toEqual([[1, 'action']]);
    // Not immediately: in production a re-ask inside 0.5 s failed the same way
    // 39 of 39 times. The wait is the only sleep that is not a call deadline.
    expect(clock.slept.filter((ms) => ms !== 60_000)).toEqual([2_000]);
  });

  /**
   * An upstream that SAID it is down goes to the chain at once: on 2026-10-02,
   * 8 of 14 action resends after an upstream 5xx from the rank-0 hands model's provider failed again, each after the
   * 2 s wait (fleet, 08:38–18:15Z).
   */
  test('an upstream 5xx inside a 200 is thrown at once on an action, for the chain to demote', async () => {
    const page = cartPage(1200);
    const { client, provider, clock, resends } = clientWith([inlineUpstream502(), clickReply(refOf(page, 'Checkout'))]);

    const thrown = await thrownBy(client.choose(promptFor(page)));

    expect(thrown).toBeInstanceOf(ModelProviderError);
    expect((thrown as ModelProviderError).upstreamStatus).toBe(502);
    expect(provider.calls).toBe(1);
    expect(resends).toEqual([]);
    expect(clock.slept.filter((ms) => ms !== 60_000)).toEqual([]);
  });

  test('a transport failure that persists is thrown after one resend', async () => {
    const page = cartPage(1250);
    const { client, provider } = clientWith([transportFailure(), transportFailure()]);

    const thrown = await thrownBy(client.choose(promptFor(page)));

    expect(thrown).toBeInstanceOf(ModelProviderError);
    expect(provider.calls).toBe(2);
  });

  test('no resend when the run has less duration left than the wait', async () => {
    const page = cartPage(1300);
    // 5 s cap, 3.5 s used: 1.5 s left, under the 2 s wait.
    const { client, provider, resends } = clientWith([transportFailure(), clickReply(refOf(page, 'Checkout'))]);

    const thrown = await thrownBy(client.choose(cappedPrompt(page, 3_500, 1)));

    expect(thrown).toBeInstanceOf(ModelProviderError);
    expect(provider.calls).toBe(1);
    expect(resends).toEqual([]);
  });
});

describe('the cache verdict', () => {
  test('with no cache attached, the miss says so instead of claiming a lookup', async () => {
    const page = cartPage(7000);
    const { client } = clientWith([clickReply(refOf(page, 'Checkout'))]);

    const choice = await client.choose(promptFor(page));

    expect(choice.cache).toEqual({
      status: 'MISS',
      reason: 'no action cache is attached to this client',
    });
  });
});

describe('extraction', () => {
  const schema = {
    type: 'object',
    properties: { title: { type: 'string' }, price: { type: 'number', minimum: 0 } },
    required: ['title', 'price'],
  };

  test('a schema-shaped reply is returned and priced', async () => {
    const { client, ledger } = clientWith([
      reply(JSON.stringify({ title: 'Kettle', price: 39.5 }), { inputTokens: 2000, outputTokens: 40 }, '0.0044'),
    ]);

    const result = await client.extract({
      instruction: null,
      schema,
      content: { kind: 'markdown', markdown: '# Kettle\n\n£39.50' },
    });

    expect(result.data).toEqual({ title: 'Kettle', price: 39.5 });
    expect(result.costUsd).toBe('0.0044');
    expect(ledger.entries()[0]?.purpose).toBe('extract');
  });

  test("a link's destination reaches the extraction model, so a question about a URL has an answer", async () => {
    // The IW17-download shape (run_7959d045, 2026-09-24): nine extracts asked
    // for this href and all nine came back "" because the prompt had no URL.
    const { client, provider } = clientWith([reply(JSON.stringify({ url: 'https://the-internet.herokuapp.com/download/test.pdf' }))]);
    const link = { ...node({ backendNodeId: 7, role: 'link', name: 'test.pdf', xpath: '' }), href: 'https://the-internet.herokuapp.com/download/test.pdf' };
    const page: AxTree = {
      url: 'https://the-internet.herokuapp.com/download',
      root: node({ backendNodeId: 1, role: 'RootWebArea', name: 'The Internet', xpath: '/html', children: [link] }),
    };

    await client.extract({
      instruction: 'the download URL of test.pdf',
      schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      content: { kind: 'tree', tree: page },
    });

    expect(provider.requests[0]?.prompt).toContain('1 a "test.pdf" [0-7] ->"https://the-internet.herokuapp.com/download/test.pdf"');
  });

  /**
   * AN EXTRACTION REPLY IS NOT SIZED LIKE AN ACTION REPLY, and collapsing the
   * two is the measured defect behind `acct_mit`'s `{"ads": []}`.
   *
   * An action reply is one small object whatever the page holds. An extraction
   * reply IS the page's data, so its size is set by how much of the page
   * matched the customer's schema. The extract ceiling was 4096 — the action
   * number, carried across — and on a Facebook Ad Library search returning 26
   * ads the answer measured 9,149-10,689 output tokens on the rank-0 hands
   * model. Every attempt came back `finish_reason: 'length'`
   * and the customer got an empty array.
   *
   * Asserted at the PROVIDER, on the request actually sent, and as an ordering
   * rather than a literal: the number may be retuned, and the thing that must
   * never happen again is an extraction being allowed an action's worth of
   * room.
   */
  test('the extraction ceiling is the larger of the two, on the wire', async () => {
    const page = cartPage(100);
    const { client, provider } = clientWith([
      clickReply(refOf(page, 'Checkout')),
      reply(JSON.stringify({ title: 'Kettle', price: 39.5 })),
    ]);

    await client.choose(cappedPrompt(page));
    await client.extract({
      instruction: null,
      schema,
      content: { kind: 'markdown', markdown: '# Kettle\n\n£39.50' },
    });

    const action = provider.requests[0]?.maxTokens ?? 0;
    const extraction = provider.requests[1]?.maxTokens ?? 0;
    expect(extraction).toBeGreaterThan(action);
    // And large enough for the answer that was measured refused at 4096.
    expect(extraction).toBeGreaterThanOrEqual(10_689);
  });

  test('extractJson matches PipelineDeps.extractJson exactly, not merely loosely', async () => {
    const { client } = clientWith([reply(JSON.stringify({ title: 'Kettle', price: 39.5 }))]);

    // A plain assignment is not enough here: it proves only one direction, so
    // a client that accepted more than the seam passes, or answered something
    // narrower, would still assign cleanly. (Declared as a *method*, the seam's
    // parameters would even be compared bivariantly.) `SameShape` forces mutual
    // assignability, so widening or narrowing either side stops compiling.
    const parameters: SameShape<
      Parameters<NonNullable<PipelineDeps['extractJson']>>,
      Parameters<ModelClient['extractJson']>
    > = true;
    const result: SameShape<
      ReturnType<NonNullable<PipelineDeps['extractJson']>>,
      ReturnType<ModelClient['extractJson']>
    > = true;
    expect([parameters, result]).toEqual([true, true]);

    const deps: Pick<PipelineDeps, 'extractJson'> = { extractJson: client.extractJson };
    expect(await deps.extractJson?.({ markdown: '# Kettle', schema })).toEqual({
      title: 'Kettle',
      price: 39.5,
    });
  });

  /**
   * THE THREE REFUSALS BELOW EACH SCRIPT THE SAME REPLY TWICE, and that is the
   * contract change rather than a fixture detail: an extraction that fails the
   * schema is now told what was wrong and asked again, exactly as an action
   * reply has been since `run_58b17565-02be-4973-9552-f07fab6331d8`. A model
   * that sends the identical violations back ends the extraction on the second
   * ask, so each of these still asserts the violation it was written for, plus
   * the sentence that says the model was told and did not move.
   */
  test('prose instead of JSON fails the extraction rather than emptying it', async () => {
    const prose = 'The kettle costs about forty pounds.';
    const { client, ledger, provider } = clientWith([reply(prose), reply(prose)]);

    const thrown = await thrownBy(client.extractJson({ markdown: '# Kettle', schema }));

    expect(thrown).toBeInstanceOf(ModelSchemaError);
    // Named specifically, not merely "some schema error": a parse failure that
    // was reported as a missing field would pass a looser assertion while the
    // parse path was broken.
    expect((thrown as ModelSchemaError).violations[0]).toMatch(/the extraction is not valid JSON/);
    expect((thrown as ModelSchemaError).violations.at(-1)).toMatch(/unchanged after being told/);
    expect(provider.calls).toBe(2);
    // Both asks are billed and both are in the ledger. A correction that
    // charged invisibly would understate spend on exactly the runs somebody is
    // investigating.
    expect(ledger.entries().map((entry) => entry.outcome)).toEqual(['schema', 'schema']);
  });

  test('JSON missing a required field fails, and the message names the field', async () => {
    const short = JSON.stringify({ title: 'Kettle' });
    const { client } = clientWith([reply(short), reply(short)]);

    const thrown = await thrownBy(client.extractJson({ markdown: '# Kettle', schema }));

    expect(thrown).toBeInstanceOf(ModelSchemaError);
    expect((thrown as ModelSchemaError).violations[0]).toBe(
      '$.price: required property is missing',
    );
  });

  test('a constraint the grammar cannot enforce is still enforced on the way back', async () => {
    // `minimum` is in the provider's "Not supported" list, so it is stripped from
    // the schema that is sent. That makes validating the reply the only thing
    // standing between a negative price and a customer's database.
    const negative = JSON.stringify({ title: 'Kettle', price: -5 });
    const { client, provider } = clientWith([reply(negative), reply(negative)]);

    const thrown = await thrownBy(client.extractJson({ markdown: '# Kettle', schema }));

    const sent = provider.requests[0]?.schema as {
      properties?: { price?: Record<string, unknown> };
    };
    expect(sent.properties?.price?.['minimum']).toBeUndefined();
    expect(sent.properties?.price?.['description']).toBe('Must be at least 0.');
    expect(thrown).toBeInstanceOf(ModelSchemaError);
    expect((thrown as ModelSchemaError).violations[0]).toBe('$.price: expected at least 0, got -5');
  });

  /* ---------------------------------------------------------------- *
   * The 19%: what a strict-JSON extraction does when the reply is
   * malformed or never arrives. Measured on the Facebook Ad Library
   * page, 2026-09-12: 3 of 20 replays of one fixed 47,401-character
   * render failed OUTRIGHT and the customer got an HTTP 500.
   * ---------------------------------------------------------------- */

  /** The customer's own shape: one required array property, items of objects. */
  const adsSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['ads'],
    properties: {
      ads: {
        type: 'array',
        items: {
          type: 'object',
          required: ['libraryId'],
          properties: { libraryId: { type: 'string' } },
        },
      },
    },
  };

  test('a bare array is wrapped into the one required array property, and the repair is reported', async () => {
    const bare = JSON.stringify([{ libraryId: '1576835113754964' }, { libraryId: '981216340658932' }]);
    const { client, provider, repairs } = clientWith([reply(bare)]);

    const data = await client.extractJson({ markdown: '# Ad Library', schema: adsSchema });

    expect(data).toEqual({ ads: [{ libraryId: '1576835113754964' }, { libraryId: '981216340658932' }] });
    // ONE call: the repair is not a retry, and paying for a second generation
    // to fix an envelope we can see is missing would be the wrong trade.
    expect(provider.calls).toBe(1);
    expect(repairs).toEqual([{ repair: 'wrapped-bare-array', property: 'ads', items: 2 }]);
  });

  test('a bare array whose items fail the schema is still refused, with the unrepaired violations', async () => {
    // The guard that stops the wrap from becoming a mask: the array arrives in
    // the same shape as the repairable case, and its ELEMENTS are wrong.
    const wrongItems = JSON.stringify([{ libraryId: 7 }]);
    const { client, provider, repairs } = clientWith([reply(wrongItems), reply(wrongItems)]);

    const thrown = await thrownBy(client.extractJson({ markdown: '# Ad Library', schema: adsSchema }));

    expect(thrown).toBeInstanceOf(ModelSchemaError);
    // The violations the reply EARNED, about the document that actually
    // arrived — not the ones a repaired document would have earned, which would
    // send a reader looking for an `ads` key the model never sent.
    expect((thrown as ModelSchemaError).violations[0]).toBe('$: expected object, got array');
    expect(repairs).toEqual([]);
    expect(provider.calls).toBe(2);
  });

  test('a refused extraction is told what was wrong and asked again about the same page', async () => {
    const { client, provider, corrections } = clientWith([
      reply(JSON.stringify({ title: 'Kettle' })),
      reply(JSON.stringify({ title: 'Kettle', price: 39.5 })),
    ]);

    const data = await client.extractJson({ markdown: '# Kettle\n\n£39.50', schema });

    expect(data).toEqual({ title: 'Kettle', price: 39.5 });
    expect(provider.calls).toBe(2);
    expect(corrections).toEqual([
      { attempt: 1, violations: ['$.price: required property is missing'], purpose: 'extract', shape: '{"w":"w"}' },
    ]);
    // The correction is APPENDED to a byte-identical prefix. On the measured
    // page that prefix is 47,401 characters, so a rebuilt prompt would lose the
    // provider's prompt cache on every correction.
    const first = provider.requests[0]?.prompt ?? '';
    const second = provider.requests[1]?.prompt ?? '';
    expect(second.startsWith(first)).toBe(true);
    expect(second.slice(first.length)).toContain('$.price: required property is missing');
  });

  test('an extraction refused with a new violation stops after one further attempt', async () => {
    const { client, provider, corrections } = clientWith([
      reply(JSON.stringify({ title: 'Kettle' })),
      reply(JSON.stringify({ price: 39.5 })),
    ]);

    const thrown = await thrownBy(client.extractJson({ markdown: '# Kettle', schema }));

    // A DIFFERENT violation each time, so the repeat check does not fire and
    // the budget is the only thing stopping it. Two calls: the extract path's
    // budget is one extra generation, unlike the action path's two, and the
    // reason is a deadline rather than a model — see MAX_EXTRACT_RETRIES.
    expect(provider.calls).toBe(2);
    expect(corrections.map((event) => event.attempt)).toEqual([1]);
    expect((thrown as ModelSchemaError).violations.at(-1)).toBe(
      'still unusable after 1 further attempt(s), so the extraction ends here rather than asking again',
    );
  });

  test('a mid-generation provider error is resent to the same model', async () => {
    const { client, provider, resends } = clientWith([
      new ModelUnusableError('error', 'the upstream provider reported an error mid-generation', ZERO_TOKENS, '0'),
      reply(JSON.stringify({ title: 'Kettle', price: 39.5 })),
    ]);

    const data = await client.extractJson({ markdown: '# Kettle', schema });

    expect(data).toEqual({ title: 'Kettle', price: 39.5 });
    expect(provider.calls).toBe(2);
    expect(resends.map((event) => event.attempt)).toEqual([1]);
    // The SAME model, which is the whole decision: the rank-1 failover was
    // measured returning 11 of 26 ads on the page this fixes, by deduplicating
    // identical creatives, with nothing on the wire to say so.
    expect(provider.requests[1]?.model).toBe(provider.requests[0]?.model);
  });

  test('a refusal is not resent: the model answered and a second ask buys the same decline', async () => {
    const { client, provider, resends } = clientWith([
      new ModelUnusableError('refusal', 'I cannot extract that', ZERO_TOKENS, '0'),
    ]);

    const thrown = await thrownBy(client.extractJson({ markdown: '# Kettle', schema }));

    expect(thrown).toBeInstanceOf(ModelUnusableError);
    expect(provider.calls).toBe(1);
    expect(resends).toEqual([]);
  });

  test('a rate limit is left to the failover chain rather than resent here', async () => {
    // The division of labour, and the mutation this catches is keying the
    // resend on `retryable` alone: a 429 is retryable AND is what
    // `shouldFailOver` demotes on, so resending it here would spend two more
    // calls against the same exhausted bucket before the chain got its turn.
    const { client, provider, resends } = clientWith([
      new ModelProviderError({
        status: 429,
        providerCode: 'rate_limit_error',
        message: 'slow down',
        retryable: true,
      }),
    ]);

    const thrown = await thrownBy(client.extractJson({ markdown: '# Kettle', schema }));

    expect(thrown).toBeInstanceOf(ModelProviderError);
    expect(provider.calls).toBe(1);
    expect(resends).toEqual([]);
  });

  test('a 2xx carrying no usable body is resent exactly once', async () => {
    const unusable = (): ModelProviderError =>
      new ModelProviderError({
        status: 200,
        providerCode: 'unparseable_response',
        message: 'a 2xx response whose body was not a JSON object',
        retryable: true,
      });
    const { client, provider, resends } = clientWith([unusable(), unusable()]);

    const thrown = await thrownBy(client.extractJson({ markdown: '# Kettle', schema }));

    expect(thrown).toBeInstanceOf(ModelProviderError);
    // TWO calls, not three. The bound is a LATENCY bound and the number that
    // sets it is the shipped Python client's own 60 s httpx default, measured
    // against production scrapes of 36-51 s: a third generation puts a slow
    // page past it, and an `httpx` read timeout carries no code, no sentence
    // and no incident id — the failure shape this change exists to remove.
    expect(provider.calls).toBe(2);
    expect(resends.map((event) => event.attempt)).toEqual([1]);
  });
});

describe('the ledger across sessions', () => {
  test('attributes spend per session while the total stays exact', async () => {
    const ledger = new CostLedger();
    const page = cartPage(8000);
    const checkout = refOf(page, 'Checkout');

    const one = clientWith([clickReply(checkout, { inputTokens: 1000, outputTokens: 100 }, '0.003')], {
      ledger,
      sessionId: 'sess-a',
    });
    await one.client.choose(promptFor(page));

    const two = clientWith([clickReply(checkout, { inputTokens: 3000, outputTokens: 250 }, '0.0085')], {
      ledger,
      sessionId: 'sess-b',
    });
    await two.client.choose(promptFor(page));

    expect(ledger.totalsFor('sess-a').costUsd).toBe('0.003');
    expect(ledger.totalsFor('sess-b').costUsd).toBe('0.0085');
    expect(ledger.totals().costUsd).toBe('0.0115');
    expect(ledger.sessions()).toEqual(['sess-a', 'sess-b']);
    expect(ledger.describe()).toContain('sess-b calls=1 hits=0 billed=1');
  });
});

describe('a refused reply is corrected, bounded, and then it is the step that ends', () => {
  const tree = cartPage(500);
  const checkout = refOf(tree, 'Checkout');
  /**
   * The production reply from `run_58b17565-02be-4973-9552-f07fab6331d8` — a
   * placeholder reference, node 0 of frame 0 — in the wire form a model writes.
   */
  const placeholderRef = JSON.stringify({
    actions: [{ type: 'click', ref: '0-0' }],
  });

  const clientOn = (
    provider: FakeProvider,
    escalated: boolean,
  ): {
    client: ModelClient;
    escalations: unknown[];
    corrections: { attempt: number; violations: readonly string[]; purpose: string }[];
  } => {
    const escalations: unknown[] = [];
    const corrections: { attempt: number; violations: readonly string[]; purpose: string }[] = [];
    return {
      escalations,
      corrections,
      client: new ModelClient({
        provider,
        model: 'hands-model',
        session: { sessionId: 'esc', accountId: null },
        ledger: new CostLedger(),
        actionReasoning: { effort: 'none' },
        onCorrection: (event) => corrections.push({ ...event }),
        ...(escalated
          ? {
              actionReasoningEscalated: { effort: 'medium' },
              onEscalation: (cause: unknown) => escalations.push(cause),
            }
          : {}),
      }),
    };
  };

  test('the violation reaches the second ask, so the second ask is a different question', async () => {
    const provider = new FakeProvider([reply(placeholderRef), clickReply(checkout)]);
    const { client, corrections } = clientOn(provider, false);

    const choice = await client.choose(promptFor(tree));

    expect(choice.action).toEqual({ type: 'click', ref: checkout });
    expect(provider.calls).toBe(2);
    // NO ESCALATED RUNG IS CONFIGURED HERE, and that is the production state:
    // `modelBinderFor` binds `actionReasoning` and nothing else, so before this
    // existed a refused reply had no second ask at all. The correction does not
    // depend on the rung.
    expect(provider.requests[1]?.reasoning).toEqual({ effort: 'none' });
    // The second prompt carries the violation VERBATIM, which is what makes a
    // retry legitimate where the captcha solver's is not: the input changed.
    const violation = corrections[0]?.violations[0] ?? '';
    expect(violation).toContain('"0-0"');
    expect(provider.requests[1]?.prompt).toContain(violation);
    expect(provider.requests[1]?.prompt).toContain('PREVIOUS ANSWER');
    expect(provider.requests[0]?.prompt).not.toContain('PREVIOUS ANSWER');
    expect(corrections).toHaveLength(1);
    expect(corrections[0]?.attempt).toBe(1);
    expect(corrections[0]?.violations).toHaveLength(1);
    // The purpose is on the event so the operator line can state the right
    // consequence: an action correction costs no step, an extract
    // correction costs a second full-page generation.
    expect(corrections[0]?.purpose).toBe('action');
  });

  test('the same violation twice is the non-retryable case, and the reason says so', async () => {
    const provider = new FakeProvider([
      reply(placeholderRef),
      reply(placeholderRef),
      // Never reached: a third ask of a model that already ignored the
      // correction is the spend the captcha solver's rule exists to refuse.
      clickReply(checkout),
    ]);
    const { client } = clientOn(provider, false);

    const thrown = await thrownBy(client.choose(promptFor(tree)));

    expect(provider.calls).toBe(2);
    expect(thrown).toBeInstanceOf(ModelSchemaError);
    const violations = (thrown as ModelSchemaError).violations;
    // BOTH halves in the message the customer and the next prompt will read:
    // what was wrong, and that the model was told and did not move.
    expect(violations[0]).toContain('"0-0"');
    expect(violations.at(-1)).toBe(
      'unchanged after being told exactly this, so the step ends here rather than asking again',
    );
  });

  test('a model wrong a DIFFERENT way each time is bounded rather than endless', async () => {
    const provider = new FakeProvider([
      reply(placeholderRef),
      reply(JSON.stringify({ actions: [] })),
      reply('prose, not JSON at all'),
      clickReply(checkout),
    ]);
    const { client, corrections } = clientOn(provider, false);

    const thrown = await thrownBy(client.choose(promptFor(tree)));

    // The floor plus `MAX_SCHEMA_CORRECTIONS`. The repeat check cannot fire
    // here — every violation is new — so the count is what stops it.
    expect(provider.calls).toBe(MAX_SCHEMA_CORRECTIONS + 1);
    expect(corrections.map((event) => event.attempt)).toEqual([1, 2]);
    expect((thrown as ModelSchemaError).violations.at(-1)).toBe(
      'still unusable after 2 correction(s), so the step ends here rather than asking again',
    );
  });

  test('nothing latches: the next step starts at the floor with a clean prompt', async () => {
    const provider = new FakeProvider([
      reply(placeholderRef),
      clickReply(checkout),
      clickReply(checkout),
    ]);
    const { client } = clientOn(provider, true);

    await client.choose(promptFor(tree, 'check out', 0));
    await client.choose(promptFor(tree, 'check out', 1));

    // Third call is the second step: back at the floor, and with no correction
    // block carried over from a violation that belonged to the previous ask.
    expect(provider.requests[2]?.reasoning).toEqual({ effort: 'none' });
    expect(provider.requests[2]?.prompt).not.toContain('PREVIOUS ANSWER');
  });

  test('a correction also raises the rung when the host configured one', async () => {
    const provider = new FakeProvider([reply(placeholderRef), clickReply(checkout)]);
    const { client } = clientOn(provider, true);

    await client.choose(promptFor(tree));

    // Both levers at once on the one retry: a reply that did not read the page
    // is exactly what the escalated rung is for, and the correction tells it
    // what to read.
    expect(provider.requests[0]?.reasoning).toEqual({ effort: 'none' });
    expect(provider.requests[1]?.reasoning).toEqual({ effort: 'medium' });
  });
});

describe('a vision reply naming a mark that is not on the screenshot', () => {
  const tree = cartPage(700);
  const checkout = refOf(tree, 'Checkout');
  const coupon = refOf(tree, 'Coupon');
  const box = { x: 10, y: 10, width: 40, height: 20 };
  const view = {
    image: { mediaType: 'image/png', base64: 'iVBORw0KGgo=' },
    marks: [
      { n: 1, ref: checkout, role: 'button', name: 'Checkout', box },
      { n: 2, ref: coupon, role: 'textbox', name: 'Coupon', box },
    ],
    geometry: { viewport: { width: 100, height: 50 }, scroll: { x: 0, y: 0 }, document: { width: 100, height: 50 } },
    offscreen: { above: 0, below: 0 },
    captureMs: 0,
    pixels: { width: 200, height: 100 },
  } as const;

  test('is refused in the marks vocabulary, naming the badges that are on it (run_fe6c0740)', async () => {
    // HarnessAB 2026-09-26, a vision arm: run_fe6c0740 (a maps task, Map--28)
    // answered "ref":"13" and then "19" where no such badge was drawn, and was
    // told "ref must be the reference printed in brackets beside a node,
    // written as a "frame-backendNode" string" — a form the vision arm never
    // shows — until four steps in a row failed and the run ended stop=error.
    const { client, corrections } = clientWith([
      reply(JSON.stringify({ actions: [{ type: 'click', ref: '13' }] })),
      reply(JSON.stringify({ actions: [{ type: 'click', ref: '1' }] })),
    ]);

    const choice = await client.choose({ ...promptFor(tree), view });

    const told = corrections[0]?.violations ?? [];
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('mark 13 is not on this screenshot');
    expect(told[0]).toContain('1-2');
    expect(told[0]).not.toContain('frame-backendNode');
    // A number that IS on it still resolves to its element.
    expect(choice.action).toEqual({ type: 'click', ref: checkout });
  });

  test('a screenshot with no badges says so rather than listing none', async () => {
    const { client } = clientWith([
      reply(JSON.stringify({ actions: [{ type: 'click', ref: '6' }] })),
      reply(JSON.stringify({ actions: [{ type: 'click', ref: '6' }] })),
    ]);

    const thrown = await thrownBy(client.choose({ ...promptFor(tree), view: { ...view, marks: [] } }));

    expect(thrown).toBeInstanceOf(ModelSchemaError);
    expect((thrown as ModelSchemaError).violations[0]).toContain('no numbered badges');
  });
});

describe('the reasoning escalation re-asks once, and only when thinking could help', () => {
  const tree = cartPage(500);
  const checkout = refOf(tree, 'Checkout');

  const clientOn = (
    provider: FakeProvider,
    escalated: boolean,
  ): { client: ModelClient; escalations: unknown[] } => {
    const escalations: unknown[] = [];
    return {
      escalations,
      client: new ModelClient({
        provider,
        model: 'hands-model',
        session: { sessionId: 'esc', accountId: null },
        ledger: new CostLedger(),
        actionReasoning: { effort: 'none' },
        ...(escalated
          ? {
              actionReasoningEscalated: { effort: 'medium' },
              onEscalation: (cause: unknown) => escalations.push(cause),
            }
          : {}),
      }),
    };
  };

  test('a TRUNCATED reply is re-asked at the higher rung and the step still succeeds', async () => {
    // Truncation is the only family escalation still owns: the reply was cut
    // off at `max_tokens`, so there is no violation to feed back — nothing is
    // WRONG with the answer, there simply is not all of it. The input is
    // therefore identical and the effort is the one field that changes.
    const provider = new FakeProvider([
      new ModelUnusableError('max_tokens', 'cut off mid-object', ZERO_TOKENS, '0'),
      clickReply(checkout),
    ]);
    const { client, escalations } = clientOn(provider, true);

    const choice = await client.choose(promptFor(tree));

    expect(choice.action.type).toBe('click');
    expect(provider.calls).toBe(2);
    // The floor was asked first and the retry was asked harder. This is the
    // whole mechanism: cheap by default, expensive only on demand.
    expect(provider.requests[0]?.reasoning).toEqual({ effort: 'none' });
    expect(provider.requests[1]?.reasoning).toEqual({ effort: 'medium' });
    expect(escalations).toHaveLength(1);
    // The retry is the SAME question. A correction block here would be this
    // client inventing a violation the provider never reported.
    expect(provider.requests[1]?.prompt).toBe(provider.requests[0]?.prompt as string);
  });

  test('a REFUSAL is not re-asked: it is a verdict, not a failure to think', async () => {
    const provider = new FakeProvider([
      new ModelUnusableError('refusal', 'declined on policy grounds', ZERO_TOKENS, '0'),
      clickReply(checkout),
    ]);
    const { client, escalations } = clientOn(provider, true);

    await expect(client.choose(promptFor(tree))).rejects.toThrow(ModelUnusableError);
    // Asking a model that understood and declined the same question at a higher
    // price is the one escalation that cannot possibly work.
    expect(provider.calls).toBe(1);
    expect(escalations).toHaveLength(0);
  });

  test('without an escalated rung configured a truncation propagates on the first call', async () => {
    const provider = new FakeProvider([
      new ModelUnusableError('max_tokens', 'cut off mid-object', ZERO_TOKENS, '0'),
      clickReply(checkout),
    ]);
    const { client } = clientOn(provider, false);

    await expect(client.choose(promptFor(tree))).rejects.toThrow(ModelUnusableError);
    expect(provider.calls).toBe(1);
  });

  test('escalation never latches: the next step starts at the floor again', async () => {
    const provider = new FakeProvider([
      new ModelUnusableError('max_tokens', 'cut off mid-object', ZERO_TOKENS, '0'),
      clickReply(checkout),
      clickReply(checkout),
    ]);
    const { client } = clientOn(provider, true);

    await client.choose(promptFor(tree, 'check out', 0));
    await client.choose(promptFor(tree, 'check out', 1));

    // Third call is the second step, and it is back at `none`. A policy that
    // ratcheted up and stayed there would be `actionReasoning` set high with
    // extra machinery.
    expect(provider.requests[2]?.reasoning).toEqual({ effort: 'none' });
  });
});

describe('an extract that asked for salvage and was cut at the cap with no JSON', () => {
  const schema = { type: 'object', properties: { do: { type: 'string' } }, required: ['do'] } as const;
  const input = { instruction: null, schema, content: { kind: 'markdown', markdown: 'page' } } as const;
  const cut = () => new ModelUnusableError('length', 'the reply was cut off at max_tokens', ZERO_TOKENS, '0.01');

  /** MUTATIONS THIS CATCHES: an unsalvageable brain cut ending the step with no decision (BrainMeasure N3); the re-ask leaking to calls that never asked for salvage; a second re-ask. */
  test('is asked once more with what went wrong, on the same thread; a call without salvage, or a second cut, throws', async () => {
    const turns = [
      { role: 'user', content: 'step 1' },
      { role: 'assistant', content: '{"do":"act"}' },
    ] as const;
    const provider = new FakeProvider([cut(), reply('{"do":"read"}'), cut(), cut(), cut()]);
    const client = new ModelClient({ provider, model: 'brain-model', session: { sessionId: 's', accountId: 'a' } });

    const result = await client.extract(input, { turns, cache: true, salvageTruncated: true });
    expect(result.data).toEqual({ do: 'read' });
    expect(provider.requests[1]?.prompt).toContain('repeated empty tool-call tags');
    expect(provider.requests[1]?.turns).toEqual(turns);

    await expect(client.extract(input)).rejects.toThrow(ModelUnusableError);
    expect(provider.calls).toBe(3);
    await expect(client.extract(input, { salvageTruncated: true })).rejects.toThrow(ModelUnusableError);
    expect(provider.calls).toBe(5);
  });
});

/** A brain reply recorded on dev5 D12 (the brain model's own provider, 2026-10-03 10:08Z) with a namespaced closing tag. */
const RECORDED_NAMESPACED = "The browser is on the FY2018 page, which is the wrong year. I need to go back to the FY2026 page and read the general fund total there.\n\n\n<invoke name=\"navigate\">\n</invoke>\n</function_calls>\n\nCorrection: I must output JSON only.\n\n{\"do\":\"act\",\"a\":{\"type\":\"navigate\",\"url\":\"https://www.harlancounty.example.gov/budget/fy2026\"},\"then\":[{\"read\":\"Total general fund FY2026 adopted budget figure\",\"expect\":\"FY2026 general fund total shown\"}],\"need\":[\"General fund total from the FY2026 adopted budget (not FY2018)\"],\"no\":\"FY2018 page is the wrong year\"}";

describe('a free-text read whose data came back as items', () => {
  /** MUTATION THIS CATCHES: a free-text read answered with an array (the hands model, amazon list reads, 5 of 45) refused and the whole page generated again. */
  test('keeps the items as their JSON text, with no second call', async () => {
    const { client, provider, repairs } = clientWith([reply('{"data":[{"title":"ALG RTX 3050","price":"₹79,990"},{"title":"Nitro 5","price":"₹78,990"}]}')]);
    const result = await client.extract({ instruction: 'each laptop: title, price', schema: null, content: { kind: 'markdown', markdown: 'page' } });
    expect(result.data).toBe('[{"title":"ALG RTX 3050","price":"₹79,990"},{"title":"Nitro 5","price":"₹78,990"}]');
    expect(provider.calls).toBe(1);
    expect(repairs).toEqual([{ repair: 'stringified-free-text' }]);
  });
});

describe('a refused reply as the operator log sees it', () => {
  /**
   * MUTATIONS THIS CATCHES: page data a reply quotes reaching the log (names,
   * prices), and the markup that decides how the parser reads it masked away
   * (the live10 re-asks could not be diagnosed: only the parse error was kept).
   */
  test('keeps its markup and schema keys, masks every other word and figure', () => {
    const shape = replyShape('Asha Rao lives at 12 MG Road; Acer ALG costs ₹79,990.\n\n```json\n{"do":"done","answer":"Acer ALG ₹79,990"}\n```\n<invoke name="act">');
    expect(shape).toBe('w… 9 w…; w… ₹9,9.\n\n```json\n{"do":"done","answer":"w… ₹9,9"}\n```\n<invoke name="act">');
    for (const secret of ['Asha', 'Rao', 'Acer', '79']) expect(shape).not.toContain(secret);
  });
});

describe('a brain reply that carries its decision in tool-call tags', () => {
  const input = { instruction: null, schema: BRAIN_SCHEMA, content: { kind: 'markdown', markdown: 'page' } } as const;
  const brainClient = (provider: FakeProvider) =>
    new ModelClient({ provider, model: 'brain-model', session: { sessionId: 's', accountId: 'a' } });
  // Recorded verbatim from scout-1 brain calls on the brain-hands sims (2026-10-02/03).
  const H1 = "Front page shows items 1-30 only. Ranks 31-35 are on page 2, so I'll open it directly.\n\n\n<invoke>navigate</invoke>\n\n\n<invoke>url</invoke>\n\n\n<invoke>https://news.ycombinator.com/news?p=2</invoke>\n\n\n<invoke>then</invoke>\n\n\n<invoke>read</invoke>\n\n\n<invoke>Titles of items numbered 31 to 35</invoke>";
  const TWICE = "Only 16 kits so far; I need 9 more, so I'll go to page 2.\n\n\n<invoke>{\"do\":\"act\",\"a\":{\"type\":\"click\",\"ref\":\"9-145\"}}</invoke>\n\n\n<invoke>{\"do\":\"act\",\"a\":{\"type\":\"click\",\"ref\":\"9-145\"}}</invoke>";
  const BARE_PARAMETERS = "\n<parameter name=\"do\">read</parameter>\n<parameter name=\"read\">Which height value is labeled \"To Tip\" (vs Architectural)?</parameter>\n<parameter name=\"final\">false</parameter>\n\n<parameter name=\"x\"></parameter>";

  /** MUTATIONS THIS CATCHES: a tagged JSON decision (twice over) or bare parameter blocks refused and re-asked at a whole extra brain call (13 of 166 recorded tagged replies). */
  test('is read off the tags when it maps one to one onto the schema', async () => {
    const provider = new FakeProvider([reply(TWICE), reply(BARE_PARAMETERS)]);
    const client = brainClient(provider);
    expect((await client.extract(input)).data).toEqual({ do: 'act', a: { type: 'click', ref: '9-145' } });
    expect((await client.extract(input)).data).toEqual({ do: 'read', read: 'Which height value is labeled "To Tip" (vs Architectural)?', final: false });
    expect(provider.calls).toBe(2);
  });

  /**
   * MUTATIONS THIS CATCHES: a decision in a reply wrapped other than by plain
   * tool-call tags re-asked at a whole brain call (live10 ea609076, 10:36-10:38Z:
   * 3 of 52 brain calls began with '`' or '<', carried no plain tool-call tag
   * and were re-asked; their text was not recorded, so the wrapped shapes below
   * are built from those parse errors, not copied), and a regression on the
   * recorded namespaced-tag reply (dev5 D12, 10:08Z), which already read.
   */
  test('a decision wrapped in a fence or namespaced tags is read, not asked again', async () => {
    const NS = ['antml', ':'].join('');
    const decision = '{"do":"act","a":{"type":"click","ref":"9-145"}}';
    const shapes = [
      // A fence holding the decision twice: the first-to-last brace strip spans both copies.
      '```json\n' + decision + '\n```\n\n```json\n' + decision + '\n```',
      // A fence followed by prose with a brace of its own.
      '```json\n' + decision + '\n```\nNext: {page 2}.',
      // A namespaced named invoke cut by the stop before its closing tag.
      '<' + NS + 'invoke name="act">\n<' + NS + 'parameter name="a">{"type":"click","ref":"9-145"}</' + NS + 'parameter>\n',
    ];
    const provider = new FakeProvider([...shapes.map((shape) => reply(shape)), reply(RECORDED_NAMESPACED)]);
    const client = brainClient(provider);
    for (let index = 0; index < shapes.length; index += 1) {
      expect((await client.extract(input)).data).toEqual({ do: 'act', a: { type: 'click', ref: '9-145' } });
    }
    expect(((await client.extract(input)).data as { do: string }).do).toBe('act');
    expect(provider.calls).toBe(4);
  });

  /** MUTATION THIS CATCHES: a reply that failed the schema logged with no generation id (all 4 live10 ea609076 re-asks had none). */
  test('a reply that fails the schema reports the generation id it was answered under', async () => {
    const calls: ModelCallEvent[] = [];
    const provider = new FakeProvider([
      { ...reply('not json at all'), requestId: 'gen-schema' },
      reply('{"do":"act","a":{"type":"click","ref":"0-11"}}'),
    ]);
    const client = new ModelClient({ provider, model: 'brain-model', session: { sessionId: 's', accountId: 'a' }, onCall: (event) => calls.push(event) });
    await client.extract(input);
    expect(calls[0]).toMatchObject({ outcome: 'schema', requestId: 'gen-schema' });
  });

  /** MUTATION THIS CATCHES: a cut brain call logged with no id to look it up by (live10 ba341e22: requestId null). */
  test('a failed call reports the generation id the provider gave it', async () => {
    const calls: ModelCallEvent[] = [];
    const provider = new FakeProvider([
      new ModelUnusableError('length', 'cut', { inputTokens: 1, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, '0.01', 'provider', 'gen-cut'),
      reply('{"do":"act","a":{"type":"click","ref":"0-11"}}'),
    ]);
    const client = new ModelClient({ provider, model: 'brain-model', session: { sessionId: 's', accountId: 'a' }, onCall: (event) => calls.push(event) });
    await client.extract(input, { salvageTruncated: true });
    expect(calls[0]).toMatchObject({ outcome: 'unusable', requestId: 'gen-cut' });
  });

  /** MUTATIONS THIS CATCHES: an unmappable tagged reply re-asked with only "Unexpected identifier" (BrainMeasure H1: the re-asked brain dropped the navigate it had tagged and read the page it meant to leave). */
  test('that maps onto nothing is asked again once, told what its tags said', async () => {
    const provider = new FakeProvider([reply(H1), reply('{"do":"act","a":{"type":"navigate","url":"https://news.ycombinator.com/news?p=2"}}')]);
    const result = await brainClient(provider).extract(input);
    expect(result.data).toEqual({ do: 'act', a: { type: 'navigate', url: 'https://news.ycombinator.com/news?p=2' } });
    const asked = provider.requests[1]?.prompt ?? '';
    expect(asked).toContain('tool-call tags');
    expect(asked).toContain('navigate | url | https://news.ycombinator.com/news?p=2 | then | read');
    expect(asked).not.toContain('Unexpected identifier');
  });
});
