/**
 * The 'tool_choice' mode through the UNCHANGED pipeline: a real `ModelClient`
 * (`client.ts`, untouched by this work) driven by a real
 * `ChatCompletionsProvider` (`chat-completions.ts`) with a scripted HTTP
 * transport, on a model the host's `outputMode` sends through that mode.
 *
 * `chat-completions.test.ts` proves the wire shape and the text extraction in
 * isolation. This file proves what those two facts are FOR: a tool-call reply
 * resolves into the same result a 'strict' reply would, and a malformed one
 * is corrected by `client.ts`'s EXISTING, mode-unaware correction path.
 */

import { describe, expect, test } from 'bun:test';
import { formatNodeRef } from '@outcrawl/runtime';

import { ModelClient } from '../src/client';
import { CostLedger } from '../src/ledger';
import { ChatCompletionsProvider } from '../src/chat-completions';
import { ModelSchemaError } from '../src/provider';
import type { HttpPost, HttpResponse } from '../src/http';
import { cartPage, promptFor, refOf, thrownBy } from './support';

/** A queue of raw wire responses, one per call, holding the last once exhausted. */
function postingSequence(responses: readonly HttpResponse[]): { post: HttpPost; sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    post: (request) => {
      const response = responses[Math.min(sent.length, responses.length - 1)];
      sent.push(request);
      return Promise.resolve(response ?? responses[responses.length - 1]!);
    },
  };
}

/** A tool-call response shaped exactly like the live gateway's, measured 2026-09-24. */
function toolCallResponse(argumentsJson: string): HttpResponse {
  return {
    status: 200,
    body: {
      id: 'gen-int-1',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          native_finish_reason: 'tool_use',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'outcrawl_reply', arguments: argumentsJson } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 12, cost: '0.0000096' },
    },
  };
}

function clientFor(post: HttpPost) {
  const corrections: { attempt: number; violations: readonly string[] }[] = [];
  const client = new ModelClient({
    provider: new ChatCompletionsProvider({
      name: 'gateway',
      url: 'https://gateway.example/v1/chat/completions',
      apiKey: 'test-key',
      httpPost: post,
      outputMode: (model) => (model === 'planner-model' ? 'tool_choice' : 'strict'),
    }),
    model: 'planner-model',
    session: { sessionId: 'sess-int-1', accountId: 'acct-int-1' },
    ledger: new CostLedger(),
    onCorrection: (event) => corrections.push({ attempt: event.attempt, violations: event.violations }),
  });
  return { client, corrections };
}

describe('a tool_choice-mode reply resolves like a strict-mode reply', () => {
  test('a valid forced tool call becomes the same ModelChoice.action a strict reply would', async () => {
    const page = cartPage(500);
    const checkout = refOf(page, 'Checkout');
    const { post, sent } = postingSequence([
      toolCallResponse(JSON.stringify({ reasoning: 'the button is right there', actions: [{ type: 'click', ref: formatNodeRef(checkout) }] })),
    ]);
    const { client } = clientFor(post);

    const choice = await client.choose(promptFor(page));

    // Exactly the shape `client.test.ts` asserts for a STRICT-mode reply on
    // the identical fixture — proof the two wire shapes converge on the same
    // `Action`, which is the whole point of `replyText` normalizing them.
    expect(choice.action).toEqual({ type: 'click', ref: checkout });
    expect(choice.reasoning).toBe('the button is right there');
    // One call: the forced tool answered validly on the first attempt.
    expect(sent.length).toBe(1);
  });
});

describe('an invalid tool_choice reply is corrected, exactly like a strict-mode one', () => {
  test('a schema-violating first call is corrected on the second, automatically', async () => {
    const page = cartPage(600);
    const checkout = refOf(page, 'Checkout');
    const { post, sent } = postingSequence([
      // First: parses as JSON, fails AGENT_REPLY_SCHEMA (`actions` missing) —
      // the same failure `client.ts`'s `parseAgentReply` raises for a
      // strict-mode reply shaped this way.
      toolCallResponse(JSON.stringify({ reasoning: 'no actions field at all' })),
      // Second: the corrected reply, after being told what was wrong.
      toolCallResponse(JSON.stringify({ actions: [{ type: 'click', ref: formatNodeRef(checkout) }] })),
    ]);
    const { client, corrections } = clientFor(post);

    const choice = await client.choose(promptFor(page));

    expect(choice.action).toEqual({ type: 'click', ref: checkout });
    // TWO calls — the correction path actually ran, not a lucky first pass.
    expect(sent.length).toBe(2);
    expect(corrections.length).toBe(1);
    expect(corrections[0]?.attempt).toBe(1);
    expect(corrections[0]?.violations.join(' ')).toMatch(/actions/);
  });

  test('a reply naming a node outside the snapshot is corrected the same way a strict one is', async () => {
    const page = cartPage(700);
    const checkout = refOf(page, 'Checkout');
    const { post, sent } = postingSequence([
      // A well-formed action, but `ref` names a node this snapshot never
      // showed — `validateAction`'s rejection, not `validate`'s.
      toolCallResponse(JSON.stringify({ actions: [{ type: 'click', ref: '0-999999' }] })),
      toolCallResponse(JSON.stringify({ actions: [{ type: 'click', ref: formatNodeRef(checkout) }] })),
    ]);
    const { client } = clientFor(post);

    const choice = await client.choose(promptFor(page));

    expect(choice.action).toEqual({ type: 'click', ref: checkout });
    expect(sent.length).toBe(2);
  });

  test('exhausting every correction on tool_choice mode still throws ModelSchemaError, never an empty success', async () => {
    const page = cartPage(800);
    // Every attempt is the same unusable reply: no `actions` at all.
    const { post } = postingSequence([toolCallResponse('{"reasoning":"still nothing"}')]);
    const { client } = clientFor(post);

    const thrown = await thrownBy(client.choose(promptFor(page)));

    expect(thrown).toBeInstanceOf(ModelSchemaError);
  });
});
