/**
 * THE MODEL IS TOLD IT HAS A FILE, or it is told nothing at all.
 *
 * `attachFile` was finished everywhere except the one place that decides
 * whether it can ever be used. The verb is in `ACTION_TYPES`, `validateAction`
 * checks its handle, the loop dispatches it, the worker pushes the body with
 * `DOM.setFileInputFiles` and `UploadStore.destroy` proves the file is gone at
 * the end of the run — and until 2026-09-08 `attachFile` appeared NOWHERE in
 * `loop.ts`: no grammar line beside `TAB_GRAMMAR` / `ASK_GRAMMAR` /
 * `TOOL_GRAMMAR`, and no field on `AgentPrompt` naming a run's handles. A
 * customer could POST a file, be answered with a handle, and the run would
 * never learn either that the file existed or that the verb was available.
 *
 * Nothing failed and nothing could: every test in this package builds its own
 * action object and drives `validateAction` directly, so no suite anywhere was
 * ever in a position to notice that a grammar does not mention something. That
 * is what this file is for, and it is why both halves are asserted — the
 * offering AND the gating. A prompt that always mentioned files would be the
 * other defect, charging every run in production for a verb it cannot use.
 */

import { describe, expect, test } from 'bun:test';

import type { Action } from '../src/actions';
import { MAX_FILE_NAME_CHARS, runAgent } from '../src/loop';
import type { RunFile } from '../src/loop';
import type { AskAnswer } from '../src/result';
import { catalogueTree, harness, refOf } from './support';

const page = catalogueTree();
const done: Action = { type: 'done', summary: 'finished' };
const CAPS = { steps: 4, budget: '2.00', duration: '5m' };

const INVOICE: RunFile = { fileId: 'file_9c1e', name: 'invoice-april.pdf' };
const PASSPORT: RunFile = { fileId: 'file_04af', name: 'passport-scan.jpg' };

/** Drain every continuation a parked run could still take. See `park.test.ts`. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) await Promise.resolve();
}

describe('a run that was handed files is told so', () => {
  test('the handle, the name and the verb are all in the prompt', async () => {
    const h = harness({
      model: () => ({ action: done }),
      tree: page,
      files: () => [INVOICE, PASSPORT],
    });

    const result = await runAgent(h.deps, { task: 'file the invoice', caps: CAPS, stepFailures: 0 });

    expect(result.status).toBe('completed');
    const prompt = h.prompts[0];
    expect(prompt).toBeDefined();
    // THE VERB, IN THE GRAMMAR BLOCK, and the assertion is deliberately
    // stricter than "the text mentions attachFile": `FILE_RULE` restates the
    // JSON mid-sentence, exactly as the tool rule restates `callTool`, so a
    // substring check would stay green with the grammar line deleted. The
    // grammar block is the ONE place the reply shape is described — the reply
    // schema is `strict`, so a verb the model is not shown as a legal reply is
    // a verb it cannot emit — and only that block puts the form on a line of
    // its own.
    const grammar = (prompt?.text ?? '')
      .split('\n')
      .slice(1)
      .filter((row) => row.startsWith('  {"type":"'));
    expect(grammar.some((row) => row.startsWith('  {"type":"attachFile",'))).toBe(true);
    // THE HANDLES, both of them, because `AttachFileAction.file` takes one and
    // a model cannot invent it.
    expect(prompt?.text).toContain('file_9c1e');
    expect(prompt?.text).toContain('file_04af');
    // THE NAMES, which is what makes two files a choice rather than a coin
    // toss.
    expect(prompt?.text).toContain('invoice-april.pdf');
    expect(prompt?.text).toContain('passport-scan.jpg');
    // And the structured field, which is what a host reads to render its own
    // prompt on the vision arm or in a replay.
    expect(prompt?.files).toEqual([INVOICE, PASSPORT]);
  });

  test('the model can emit the verb it was offered, and it reaches the page', async () => {
    // The point of a grammar line is a dispatch. A run that is TOLD about a
    // handle and then cannot use it would be this same defect one layer down.
    const h = harness({
      model: (_prompt, step) =>
        step === 0
          ? { action: { type: 'attachFile', ref: refOf(page, 'Search'), file: INVOICE.fileId } }
          : { action: done },
      perform: () => undefined,
      tree: page,
      files: () => [INVOICE],
    });

    const result = await runAgent(h.deps, { task: 'upload it', caps: CAPS, stepFailures: 0 });

    expect(result.status).toBe('completed');
    // Dispatched to the page binding, with the handle the prompt named — the
    // body is fetched below this layer, which is why the loop hands over a
    // handle and never a payload.
    expect(h.performed[0]).toEqual({
      type: 'attachFile',
      ref: refOf(page, 'Search'),
      file: 'file_9c1e',
    });
    expect(result.steps[0]?.error).toBeUndefined();
  });

  test('a filename is quoted and bounded, because a customer typed it', async () => {
    // A filename is customer-controlled text landing in a prompt. Two
    // properties are load-bearing and neither is about what the name SAYS:
    // one manifest entry must not be able to become two lines, and one name
    // must not be able to become a page's worth of tokens.
    const hostile: RunFile = {
      fileId: 'file_evil',
      name: `report" ${'A'.repeat(400)}`,
    };
    const h = harness({
      model: () => ({ action: done }),
      tree: page,
      files: () => [hostile],
    });

    await runAgent(h.deps, { task: 'read it', caps: CAPS, stepFailures: 0 });

    const text = h.prompts[0]?.text ?? '';
    const line = text.split('\n').find((row) => row.includes('file_evil'));
    expect(line).toBeDefined();
    // QUOTED: the name is rendered as a JSON string, so the quote it carries
    // is escaped rather than closing anything.
    expect(line).toContain('\\"');
    // BOUNDED: 120 characters and an ellipsis, not 400.
    expect(line?.length).toBeLessThan(MAX_FILE_NAME_CHARS + 60);
    expect(line).toContain('…');
    expect(text).not.toContain('A'.repeat(MAX_FILE_NAME_CHARS + 1));
    // The HANDLE is intact, because it is the identity and the name is only a
    // label.
    expect(h.prompts[0]?.files?.[0]?.fileId).toBe('file_evil');
  });
});

describe('a run that was handed nothing pays nothing', () => {
  test('no manifest, no grammar line, and no field', async () => {
    const h = harness({ model: () => ({ action: done }), tree: page });

    await runAgent(h.deps, { task: 'just look', caps: CAPS, stepFailures: 0 });

    const prompt = h.prompts[0];
    expect(prompt?.files).toBeUndefined();
    // The GATE, and it is half the feature: every run in production is this
    // run, and a grammar line whose action cannot succeed is a move the model
    // will spend a step on.
    expect(prompt?.text).not.toContain('attachFile');
    expect(prompt?.text).not.toContain('file_');
    expect(prompt?.text).not.toContain('Files attached to this task');
  });

  test('a bound manifest that is empty renders the same bytes as none at all', async () => {
    // The two absences are different states — "this host has no bucket" and
    // "this run holds no file" — and they have to render identically, or the
    // gate would be leaking a fact about the deployment into every prompt.
    const withPort = harness({
      model: () => ({ action: done }),
      tree: page,
      files: () => [],
    });
    const withoutPort = harness({ model: () => ({ action: done }), tree: page });

    await runAgent(withPort.deps, { task: 'just look', caps: CAPS, stepFailures: 0 });
    await runAgent(withoutPort.deps, { task: 'just look', caps: CAPS, stepFailures: 0 });

    // The probe reached its subject: the port really was asked.
    expect(withPort.events).toContain('files.list');
    expect(withoutPort.events).not.toContain('files.list');
    expect(withPort.prompts[0]?.text).toBe(withoutPort.prompts[0]?.text);
  });
});

describe('a file handed to a parked run reaches the next prompt', () => {
  test('the manifest is re-read after a park, so ask-then-upload works', async () => {
    // The flow this exists for: the model asks for a document, the customer
    // uploads one and answers, and the run has to be able to see it. A
    // manifest read once at step 0 would make that silently impossible —
    // `POST /v1/agent/{id}/files` accepts a file for a PARKED run precisely
    // because this is when a person is looking at the run.
    let deliver: ((reply: AskAnswer) => void) | undefined;
    const h = harness({
      model: (_prompt, step) =>
        step === 0
          ? { action: { type: 'ask', question: 'Send me the passport scan?' } }
          : { action: done },
      perform: () => undefined,
      tree: page,
      // Nothing at the start of the run; the scan on every read after it.
      files: (call) => (call === 0 ? [] : [PASSPORT]),
    });

    const run = runAgent(h.deps, {
      task: 'apply for the visa',
      caps: CAPS,
      stepFailures: 0,
      onAsk: async () =>
        new Promise<AskAnswer>((resolve) => {
          deliver = resolve;
        }),
    });

    await settle();

    // Parked, and the first prompt correctly said nothing about files.
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]?.files).toBeUndefined();
    expect(h.prompts[0]?.text).not.toContain('attachFile');

    deliver?.({ answer: 'sent it', answeredBy: 'jish@aeonmind' });
    const result = await run;

    expect(result.status).toBe('completed');
    const second = h.prompts[1];
    expect(second).toBeDefined();
    // THE FILE THAT ARRIVED DURING THE PARK, in the prompt of the step that
    // could use it, with the verb now offered.
    expect(second?.files).toEqual([PASSPORT]);
    expect(second?.text).toContain('file_04af');
    expect(second?.text).toContain('passport-scan.jpg');
    expect(second?.text.split('\n').some((row) => row.startsWith('  {"type":"attachFile",'))).toBe(true);
  });
});

describe('a file handed to a RUNNING run reaches the next prompt', () => {
  test('a file that lands after the first read is offered on the next step, with no park', async () => {
    // IW16, production 2026-09-26 (n=3, fleet 9b8a390aa704): `agent.files`
    // answered 0.34-0.46 s after the submit, which the SDK documents as valid
    // before the run has taken a step. Each run's step-0 trace puts the loop's
    // one manifest read 0.10-0.22 s after `startedAt`, so the only read taken
    // without a park came before the file, and all three runs attached
    // invented handles ('HANDLE', 'file.txt', 'provided_file').
    const h = harness({
      model: (prompt, step) =>
        step === 0
          ? { action: { type: 'wait', seconds: 1 } }
          : prompt.files?.[0] !== undefined
            ? { action: { type: 'attachFile', ref: refOf(page, 'Search'), file: prompt.files[0].fileId } }
            : { action: done },
      perform: () => undefined,
      tree: page,
      // Nothing when the run starts; the invoice on every read after it.
      files: (call) => (call === 0 ? [] : [INVOICE]),
    });

    await runAgent(h.deps, { task: 'upload the invoice', caps: CAPS, stepFailures: 0 });

    expect(h.prompts[0]?.files).toBeUndefined();
    expect(h.prompts[1]?.files).toEqual([INVOICE]);
    expect(h.prompts[1]?.text).toContain('file_9c1e');
    // And the handle it was shown is the one that reaches the page.
    expect(h.performed.find((action) => action.type === 'attachFile')).toEqual({
      type: 'attachFile',
      ref: refOf(page, 'Search'),
      file: 'file_9c1e',
    });
  });
});
