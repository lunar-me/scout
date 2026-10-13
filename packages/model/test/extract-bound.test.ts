/**
 * OC-284: an agent extraction's input is bounded by its share of the run's
 * budget, priced at the extraction model's own input rate.
 *
 * The fixture is the shape that cost run_4d5f46de 354 of 600 credits on
 * 2026-10-01: a 500-row revision history, where the one row the task needs is
 * deep in the list and its date sits on a different line from the words that
 * identify it.
 */

import { describe, expect, test } from 'bun:test';
import { finalAnswerFraming, finalAnswerSchema, type AxNode, type AxTree } from '@outcrawl/runtime';

import { ModelClient } from '../src/client';
import { boundPage, EXTRACT_FLOOR_TOKENS, EXTRACT_INPUT_SHARE } from '../src/extract-bound';
import { CostLedger } from '../src/ledger';
import type { ModelProvider, ModelRequest, ModelResponse } from '../src/provider';
import { ZERO_TOKENS } from '../src/provider';
import type { RateCard } from '../src/rates';
import { VirtualClock, node } from './support';

const MODEL = 'extract-model';
/** A frontier extract model's list price, USD per million tokens. */
const RATES: RateCard = {
  [MODEL]: { input: '4', output: '20', cacheRead: '0.20', cacheWrite: '5', inputModalities: ['text', 'image'] },
};
const INPUT_USD_PER_TOKEN = Number(RATES[MODEL]?.input) / 1_000_000;

/** The row the task asks for, at a fixed place deep in the list. */
const NEEDLE_ROW = 377;
const NEEDLE_DATE = '17:51, 11 September 2015';

function historyPage(rows: number): AxTree {
  let id = 10;
  const items: AxNode[] = [];
  for (let row = 0; row < rows; row += 1) {
    const date = row === NEEDLE_ROW ? NEEDLE_DATE : `09:${String(row % 60).padStart(2, '0')}, ${String((row % 28) + 1)} March 2019`;
    const summary =
      row === NEEDLE_ROW ? '{{Thomas Aquinas}} added the portrait of Aquinas' : `copyedit, fixed references in section ${String(row)}`;
    items.push(
      node({
        backendNodeId: (id += 1),
        role: 'listitem',
        xpath: '',
        children: [
          node({ backendNodeId: (id += 1), role: 'link', name: date, xpath: '' }),
          node({ backendNodeId: (id += 1), role: 'link', name: `Editor${String(row)}`, xpath: '' }),
          node({ backendNodeId: (id += 1), role: 'StaticText', name: '(talk | contribs)', xpath: '' }),
          node({ backendNodeId: (id += 1), role: 'StaticText', name: `+${String(row * 7)} bytes`, xpath: '' }),
          node({ backendNodeId: (id += 1), role: 'StaticText', name: summary, xpath: '' }),
        ],
      }),
    );
  }
  return {
    url: 'https://en.wikipedia.org/w/index.php?title=Principle_of_double_effect&action=history&limit=500',
    root: node({
      backendNodeId: 1,
      role: 'RootWebArea',
      name: 'Principle of double effect: Revision history',
      xpath: '/html',
      children: [
        node({ backendNodeId: 2, role: 'heading', name: 'Principle of double effect: Revision history', xpath: '' }),
        node({ backendNodeId: 3, role: 'list', xpath: '', children: items }),
      ],
    }),
  };
}

/**
 * A byte-level tokenizer is the conservative edge of byte-tokenization, not
 * a provider whose assumed chars/token ratio repeats the bound's own guess.
 */
class MeteringProvider implements ModelProvider {
  readonly name = 'fake';
  readonly requests: ModelRequest[] = [];
  /** `subscription`: answers the way OC-286's subscription provider does, at `'0'` USD. */
  constructor(
    readonly answer: string,
    readonly subscription = false,
  ) {}
  complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const inputTokens = Buffer.byteLength(request.system) + Buffer.byteLength(request.prompt) + Buffer.byteLength(JSON.stringify(request.schema));
    return Promise.resolve({
      text: this.answer,
      usage: { ...ZERO_TOKENS, inputTokens },
      costUsd: this.subscription ? '0' : (inputTokens * INPUT_USD_PER_TOKEN).toFixed(12),
      costSource: this.subscription ? 'subscription' : 'provider',
      stopReason: 'end_turn',
    });
  }
}

function client(
  answer = JSON.stringify({ data: NEEDLE_DATE }),
  subscription = false,
): {
  client: ModelClient;
  provider: MeteringProvider;
  ledger: CostLedger;
} {
  const provider = new MeteringProvider(answer, subscription);
  const ledger = new CostLedger();
  return {
    client: new ModelClient({
      provider,
      model: MODEL,
      rates: RATES,
      session: { sessionId: 'sess-1', accountId: 'acct-1' },
      ledger,
      clock: new VirtualClock(),
    }),
    provider,
    ledger,
  };
}

const INSTRUCTION = 'The date of the revision whose edit summary mentions Aquinas';

describe('the extraction input bound (OC-284)', () => {

  test('a 500-row page over the ceiling is cut, says so, and keeps the matching row with its date', async () => {
    const maxUsd = '0.05';
    const { client: extractor, provider } = client();

    const result = await extractor.extract({
      instruction: INSTRUCTION,
      schema: null,
      content: { kind: 'tree', tree: historyPage(500) },
      maxUsd,
    });

    const prompt = provider.requests[0]!.prompt;
    const ceilingTokens = Math.floor((Number(maxUsd) * EXTRACT_INPUT_SHARE) / INPUT_USD_PER_TOKEN);
    // Bounded: the whole request, system prompt included, fits the ceiling.
    expect(provider.requests[0]!.system.length + prompt.length).toBeLessThanOrEqual(ceilingTokens);
    // Told: the extraction model reads that the page was cut and how much.
    expect(prompt).toContain('THIS PAGE WAS CUT');
    expect(prompt).toMatch(/\[\d+ lines omitted\]/);
    // Relevant first: row 377 survives, and its date — on another line of the
    // same row — came with it, though row 377 is far past any prefix.
    expect(prompt).toContain('added the portrait of Aquinas');
    expect(prompt).toContain(NEEDLE_DATE);
    // Reported: the counts come back for the step record.
    const cut = result.cut!;
    expect(cut.ceilingTokens).toBe(ceilingTokens);
    expect(cut.sentChars).toBeLessThan(cut.pageChars);
    expect(cut.sentLines).toBeLessThan(cut.pageLines);
  });

  test('a rare locator keeps nearby labels in a flattened tree ahead of repeated generic word pairs', () => {
    const rows = Array.from({ length: 40 }, (_, row) => [
      '1 txt "inventory record"',
      ...Array.from({ length: 20 }, () => '1 txt "auxiliary metadata"'),
      `1 txt "received=${row === 35 ? '2026-10-02T09:00Z' : 'unknown'}"`,
      ...Array.from({ length: 20 }, () => '1 txt "auxiliary metadata"'),
      `1 txt "${row === 35 ? 'zircon' : 'ordinary'}"`,
      ...Array.from({ length: 20 }, () => '1 txt "auxiliary metadata"'),
      `1 txt "batch=${row === 35 ? 'B-719' : 'unknown'}"`,
    ].join('\n'));
    const bounded = boundPage(`0 doc "Warehouse"\n${rows.join('\n')}`, {
      maxBytes: 5000,
      ask: 'Find the inventory record for zircon',
      kind: 'tree',
    });
    expect(bounded.text).toContain('zircon');
    expect(bounded.text).toContain('received=2026-10-02T09:00Z');
    expect(bounded.text).toContain('batch=B-719');
    expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(5000);
  });

  test('whole Unicode query words keep their value instead of accidental substrings in unrelated names', () => {
    const page = [
      'Header',
      ...['Arthena', 'OpenBarry', 'Cartwright', 'unforgivable'].flatMap((name) => [
        'x'.repeat(700), name, 'x'.repeat(700),
      ]),
      'x'.repeat(700), '«ÅNGSTRÖM»', 'receipt=R-719',
      'x'.repeat(700), '«ÅNGSTRÖM»', 'received=2026-10-02',
    ].join('\n');
    const bounded = boundPage(page, {
      maxBytes: 2500,
      ask: 'then open art org ångström',
      kind: 'markdown',
    });
    expect(bounded.text).toContain('«ÅNGSTRÖM»');
    expect(bounded.text).toContain('receipt=R-719');
    expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(2500);
  });

  test('a cut names only words whose every line was sent, and words on no line of the page', () => {
    // run_8f78fa77 (2026-10-02): every "Aquinas" row was sent, the extraction
    // could not know that and held a complete five-row answer as incomplete.
    // "edit" is on every row, so a cut cannot have sent all of its lines.
    const page = [
      'History',
      ...Array.from({ length: 200 }, (_, row) =>
        `${String(row)} 09:00, 1 March 2019 edit ${row % 50 === 7 ? 'refer to Aquinas' : 'copyedit references'}`),
    ].join('\n');
    const bounded = boundPage(page, { maxBytes: 2000, ask: 'edit Aquinas photo', kind: 'markdown' });

    expect(bounded.cut?.wordsAllSent).toEqual(['aquinas']);
    expect(bounded.cut?.wordsAbsent).toEqual(['photo']);
    expect(bounded.text).toContain('containing any of the whole words "aquinas" is below');
    expect(bounded.text).toContain('on no line of the FULL page: "photo"');
    expect(bounded.text.match(/refer to Aquinas/g)).toHaveLength(4);
    expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(2000);
    // "edit" lines were partly sent, so "edit" is not named as unseen.
    expect(bounded.cut?.wordsUnsent).toBeUndefined();
  });

  test('a cut that sends no line with a request word names it as unseen', () => {
    // run_e3925abe (2026-10-02): a final read sent 435 of 236,860 characters,
    // no "Aquinas" row, and answered "none found" as complete.
    const page = ['History', `refer to Aquinas ${'x'.repeat(3000)}`, ...Array.from({ length: 100 }, () => 'copyedit')].join('\n');
    const bounded = boundPage(page, { maxBytes: 2000, ask: 'Aquinas photo', kind: 'markdown' });

    expect(bounded.cut?.wordsUnsent).toEqual(['aquinas']);
    expect(bounded.text).toContain('on the FULL page but on NO line below: "aquinas"');
    expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(2000);
  });

  test('a keyword inside a small link still brings its flattened row, date included', () => {
    // Categorical_imperative history (2026-10-02): summaries are section links
    // with text children, so the match was a 3-line subtree, not a leaf, and
    // 8 of 10 matching revisions were sent without their dates.
    const row = (n: number, date: string, summary: readonly string[]) => [
      `1 a "${date}" [1-${String(n)}]`, '1 a "Editor" [1-2]', '1 txt "("', '1 a "talk" [1-3]', '1 txt ")"',
      '1 txt "25,740 bytes"', '1 txt "+1,193"', '1 txt ". ."', '1 txt "("', ...summary, '1 txt ")"',
    ];
    const lines = ['0 doc "Revision history"'];
    for (let n = 0; n < 300; n += 1) {
      lines.push(...(n % 60 === 30
        ? row(n, `05:${String(n % 60).padStart(2, '0')}, ${String(n % 28 + 1)} September 2006`, ['1 a "→Theft" [1-9]', '2 txt "→"', '2 txt "Theft"'])
        : row(n, `09:00, 1 March 2019`, ['1 txt "copyedit"'])));
    }
    const bounded = boundPage(lines.join('\n'), {
      maxBytes: 12_000,
      ask: 'Open https://en.wikipedia.org/w/index.php?title=History&action=history&limit=500 and list revisions whose summary mentions theft, with date',
      kind: 'tree',
    });

    for (const n of [30, 90, 150, 210, 270]) {
      expect(bounded.text).toContain(`"05:30, ${String(n % 28 + 1)} September 2006"`);
    }
    expect(bounded.cut).toBeDefined();
    expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(12_000);
  });


  test('at a small allowance the subject keeps its dated rows over rarer task boilerplate and reply words', () => {
    // run_86f08a2e / run_cb051823 (2026-10-04, scout-1): 6,499 and 7,031
    // characters of the history were sent and 0 of the 5 dated Aquinas rows,
    // because "tools", "use", "one", "time", "user" (task and field words) and
    // the instruction's "full"/"text" each sit on fewer lines than "Aquinas".
    const subject = new Map([
      [60, '{{Thomas Aquinas}}'], [140, 'removed Category:Thomas Aquinas'], [220, 'Quick-adding category Thomas Aquinas'],
      [300, 'snobot - Robot-assisted disambiguation: Aquinas'], [380, 'refer to Aquinas'],
    ]);
    const noise = new Map([
      [20, 'Ticking time bomb'], [30, 'Use this bot'], [40, 'one more tools fix'], [50, 'full rewrite'],
      [70, 'text tidy'], [80, 'text tidy'], [90, 'text tidy'], [100, 'text tidy'],
      [110, 'merged revisions'], [120, 'merged revisions'], [130, 'Find edits by user'],
    ]);
    const lines = ['0 doc "Revision history"', '1 a "Find edits by user" [1-1]', '1 txt "External tools:"', '1 btn "Compare selected revisions" [1-5]'];
    for (let n = 0; n < 450; n += 1) {
      const date = subject.has(n) ? `17:${String(n % 60).padStart(2, '0')}, ${String(n % 28 + 1)} May 2009` : '09:00, 1 March 2019';
      lines.push(
        `1 a "${date}" [1-${String(n)}]`, '1 a "Editor" [1-2]', '1 txt "("', '1 a "talk" [1-3]', '1 txt "|"', '1 a "contribs" [1-4]',
        '1 txt ")"', '1 txt ". ."', '1 txt "("', '1 txt "25,740 bytes"', '1 txt ")"', '1 txt "("', '1 txt "+1,193"', '1 txt ")"',
        '1 txt ". ."', '1 txt "("', `1 txt "${subject.get(n) ?? noise.get(n) ?? 'copyedit'}"`, '1 txt ")"',
      );
    }
    const page = lines.join('\n');
    const task = 'Open https://en.wikipedia.org/w/index.php?title=Principle_of_double_effect&action=history&limit=500. With ONE extract action on that page (do not use web tools, do not open other pages), list every revision whose edit summary mentions Aquinas, image, picture or photo, with its date and time. Then finish.';
    const dated = (text: string): number => [...subject.keys()].filter((n) => text.includes(`"17:${String(n % 60).padStart(2, '0')}, ${String(n % 28 + 1)} May 2009"`)).length;
    for (const instruction of [
      'List every revision whose edit summary mentions Aquinas, with its date and time (and user). For each, provide the full edit summary text.',
      // The shape that sent 0 of 5 when the instruction's words ranked first
      // (bundle 4e2751ac, 2026-10-02): only the task names the subject.
      'extract all revisions',
    ]) {
      const bounded = boundPage(page, { maxBytes: 7000, ask: `${task} ${instruction} {}`, task, kind: 'tree' });
      expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(7000);
      expect(dated(bounded.text)).toBe(5);
    }
  });

  test('a page under the ceiling is sent byte-identical, with no header and no cut', async () => {
    const bounded = client();
    const whole = client();
    const page = historyPage(20);

    const result = await bounded.client.extract({
      instruction: INSTRUCTION,
      schema: null,
      content: { kind: 'tree', tree: page },
      maxUsd: '0.05',
    });
    await whole.client.extract({ instruction: INSTRUCTION, schema: null, content: { kind: 'tree', tree: page } });

    expect(bounded.provider.requests[0]!.prompt).toBe(whole.provider.requests[0]!.prompt);
    expect(bounded.provider.requests[0]!.prompt).not.toContain('THIS PAGE WAS CUT');
    expect(result.cut).toBeUndefined();
  });

  test('a run with nothing left retains the intentional 5k ceiling and the relevant row', async () => {
    const { client: extractor, provider } = client();

    const result = await extractor.extract({
      instruction: INSTRUCTION,
      schema: null,
      content: { kind: 'tree', tree: historyPage(500) },
      maxUsd: '0',
    });

    expect(result.cut?.ceilingTokens).toBe(EXTRACT_FLOOR_TOKENS);
    const sent = provider.requests[0]!;
    expect(Buffer.byteLength(sent.system) + Buffer.byteLength(sent.prompt) + Buffer.byteLength(JSON.stringify(sent.schema))).toBeLessThanOrEqual(EXTRACT_FLOOR_TOKENS);
    expect(sent.prompt).toContain('added the portrait of Aquinas');
  });

  /**
   * The subscription path (OC-286) bills every call at `'0'` USD. The ceiling
   * is priced at the model's LIST input rate (the host's rate card), never at
   * what a call was billed, so a free call is neither unbounded ("$0 a token,
   * any page is affordable") nor a zero ceiling — it reads exactly the page the
   * same allowance buys through the gateway.
   */
  test('a $0 subscription call is cut at the list price, exactly as a billed one', async () => {
    const free = client(undefined, true);
    const billed = client();
    const input = { instruction: INSTRUCTION, schema: null, content: { kind: 'tree', tree: historyPage(500) }, maxUsd: '0.05' } as const;

    const freeResult = await free.client.extract(input);
    const billedResult = await billed.client.extract(input);

    expect(freeResult.cut?.ceilingTokens).toBe(Math.floor((0.05 * EXTRACT_INPUT_SHARE) / INPUT_USD_PER_TOKEN));
    expect(free.provider.requests[0]!.prompt).toBe(billed.provider.requests[0]!.prompt);
    expect(freeResult.cut).toEqual(billedResult.cut!);
    expect(free.ledger.entries()[0]!.costUsd).toBe('0');
  });

  test('multibyte page text, instructions and schema corrections all fit the supplied-text ceiling', async () => {
    // A number is no text and no items: the one wrong `data` that is still corrected.
    const { client: extractor, provider } = client('{"data": 5}');
    let attempts = 0;
    provider.complete = async (request) => {
      provider.requests.push(request);
      return {
        text: attempts++ === 0 ? '{"data": 5}' : '{"data": "found"}',
        usage: ZERO_TOKENS, costUsd: '0', costSource: 'provider', stopReason: 'end_turn',
      };
    };
    const result = await extractor.extract({
      instruction: 'Find the 密碼 field and report it.',
      schema: null,
      content: { kind: 'markdown', markdown: Array.from({ length: 2000 }, (_, i) => `row ${String(i)}: 密碼 漢字 ${String(i * 7919)}`).join('\n') },
      maxUsd: '0',
    });
    expect(provider.requests).toHaveLength(2);
    for (const sent of provider.requests) {
      expect(Buffer.byteLength(sent.system) + Buffer.byteLength(sent.prompt) + Buffer.byteLength(JSON.stringify(sent.schema))).toBeLessThanOrEqual(EXTRACT_FLOOR_TOKENS);
    }
    expect(result.cut?.ceilingTokens).toBe(EXTRACT_FLOOR_TOKENS);
  });

  test('final-answer policy and reasoning do not displace customer evidence from a bounded request', async () => {
    const task = 'Report the receipt for zircon';
    const labels = Array.from({ length: 180 }, (_, i) => `amber${String(i)}`);
    const instruction = `Report the receipt.\n${finalAnswerFraming(task, {
      reasoning: `I considered ${labels.join(' ')}.`,
      elapsedMs: 12000,
    })}`;
    const page = [
      ...labels.map((label) => `${label} receipt=ordinary`),
      'zircon receipt=R-719',
    ].join('\n');
    const { client: extractor, provider } = client();
    provider.complete = async (request) => {
      provider.requests.push(request);
      return {
        text: JSON.stringify({
          answer: request.prompt.includes('zircon receipt=R-719') ? 'R-719' : 'not found',
          complete: true,
          missing: '',
        }),
        usage: ZERO_TOKENS, costUsd: '0', costSource: 'provider', stopReason: 'end_turn',
      };
    };
    const result = await extractor.extract({
      instruction,
      schema: finalAnswerSchema(undefined)!,
      content: { kind: 'markdown', markdown: page },
      selection: { task, instruction: 'Report the receipt.', schema: null },
      maxUsd: '0',
    });
    expect(result.data).toEqual({ answer: 'R-719', complete: true, missing: '' });
    const sent = provider.requests[0]!;
    expect(Buffer.byteLength(sent.system) + Buffer.byteLength(sent.prompt) + Buffer.byteLength(JSON.stringify(sent.schema))).toBeLessThanOrEqual(EXTRACT_FLOOR_TOKENS);
  });
});
