/**
 * OC-284: AN EXTRACTION'S INPUT IS BOUNDED BY ITS SHARE OF THE RUN'S BUDGET.
 *
 * The agent's `extract` sends the page it is reading, and on the agent path
 * that is the WHOLE accessibility tree, unclipped (`renderPage` in
 * `./client.ts` argues why no per-node clip). Nothing bounded the total, so
 * one extraction could spend most of a run. Measured: BU Bench run
 * `run_4d5f46de-8be6-42f8-895a-7c8782ebbd07` (a frontier-model lab arm, 2026-10-01), ONE
 * extract over a 500-row Wikipedia history page, 160,864 step input tokens,
 * 354 of the run's 600 credits, and the answer was then guessed. Over every
 * agent run in the 7 days to 2026-10-01 12:42Z (n=3,767 extract steps, 1,208
 * runs) 18 extractions spent more than 20% of their run's budget on extract
 * input alone, and 21 steps carried 100k+ input tokens, 6 of them customers'.
 *
 * The bound is MONEY, not a fixed token count: the loop hands the client a
 * provider-USD allowance ({@link EXTRACT_INPUT_SHARE} of it is spent on input)
 * and the client turns it into tokens at ITS OWN slug's input rate, so a
 * failover to a dearer rank reads a smaller page rather than a dearer one.
 *
 * The bound is spent in UTF-8 bytes, not an average characters/token ratio.
 * On 2026-10-01 the first extract calls in three production history-page runs
 * used 45,201–49,439 input tokens against ceilings of 38,663–38,866: the old
 * 2.5 chars/token estimate was not a ceiling. Byte-tokenizers can split text
 * down to individual bytes, including numeric references and Unicode.
 * This bounds supplied text, not undocumented provider message framing.
 *
 * Over the ceiling the page is CUT, never truncated blind, and never silently:
 * {@link boundPage} keeps the lines that carry the words of the request first,
 * each with the row around it, then the top of the page, marks every gap, and
 * heads the page with a sentence saying what was cut. The caller gets the
 * counts back ({@link PageCut}) for the step record and the next prompt.
 *
 * Billing is untouched by any of this: the run is charged the provider's
 * stated cost of the request actually sent, which is the cut one.
 */

/**
 * The share of an extraction's USD allowance spent on INPUT tokens. The rest
 * is headroom for the reply, which is billed per token emitted and bounded by
 * the extraction reply ceiling (`DEFAULT_EXTRACT_TOKENS` in `./client.ts`).
 */
export const EXTRACT_INPUT_SHARE = 0.9;

/**
 * The minimum input-token allowance, even when the money-derived ceiling is
 * smaller. The intentional 5k floor is unchanged; conservative byte accounting
 * can use fewer actual tokens, and must not claim a measured token count.
 */
export const EXTRACT_FLOOR_TOKENS = 5_000;

/**
 * A row's whole subtree is kept with a matching line while it fits in this
 * many characters. When native filtering flattened away the row containers,
 * keep up to this much contiguous leaf-sibling context on each side instead:
 * labels and values can be many small nodes away from the matching text.
 * Neither path can include a whole oversized table or escape the byte budget.
 */
const ROW_BLOCK_CHARS = 800;

/**
 * A matching subtree this small is a piece of a row, not a row: a link with
 * text children ("→Euthanasia" in a revision summary). It brings sibling
 * context like a leaf does. Measured on OC-284's same-shape probes
 * (2026-10-02): without this, 8 of 10 matching revisions on
 * Categorical_imperative's history were sent without their dates.
 */
const ROW_FRAGMENT_CHARS = 200;

/** The share of the cut page spent on the top of the page, before anything else. */
const HEAD_SHARE = 0.1;

/**
 * The rarity weight kept by a word the extraction instruction adds and the
 * customer's task does not have. The task names what is wanted; the words an
 * instruction adds mostly describe the reply ("full", "text", "editor",
 * "provide"), and on a long page such a word can sit on fewer lines than the
 * subject and take its place. Measured on OC-284's four captured histories
 * (2026-10-04): "full" (1 line) and "text" (4) took a 7,000-byte cut from
 * "Aquinas" (5). Halved rather than dropped: when the instruction is the only
 * thing naming the subject, it still ranks.
 */
const INSTRUCTION_ONLY_WEIGHT = 0.5;

/**
 * Request words that say nothing about WHERE on a page the answer is.
 * Weighting by rarity (see {@link boundPage}) already silences any word that
 * is on most lines; these are the ones that are RARE on a page and still
 * locate nothing, so rarity alone ranks them above the subject:
 *   * grammar, and the schema's own vocabulary;
 *   * how an agent is told to work: "open", "use", "tools", "web", "one",
 *     "then", "finish" ("With ONE extract action ... do not use web tools");
 *   * the names of fields to report ("date", "time", "user", "name"). A row
 *     carries a field's VALUE, not its name; the name is on a label or in
 *     chrome ("click on its date", "Find edits by user").
 * Measured on OC-284's history page (2026-10-04, 13,210 lines): "time" and
 * "user" are on 1 line each, "tools" 2, "use" 3, "Aquinas" 5; at the live
 * allowance of run_86f08a2e (6,499 characters sent) the cut sent 0 of the 5
 * dated Aquinas rows.
 */
const STOPWORDS: Readonly<Record<string, true>> = Object.fromEntries(
  (
    'the and for with that this from what which whose who are was were all any each every only list ' +
    'extract return give find page into their there them they its not but has have had per about ' +
    'mentions mention mentioned value values field fields string number object array type properties ' +
    'items required description ' +
    'open use using click visit navigate then finish done stop action actions step steps tool tools web ' +
    'site website pages tab tabs one other another please don ' +
    'date dates time times user users name names'
  )
    .split(' ')
    .map((word) => [word, true]),
);

/** What a cut did, for the step record and the model. Counts of the PAGE body only. */
export interface PageCut {
  readonly pageChars: number;
  readonly sentChars: number;
  readonly pageLines: number;
  readonly sentLines: number;
  /** Request words whose every line on the page was sent; absent when none. */
  readonly wordsAllSent?: readonly string[];
  /** Request words on no line of the page; absent when none. */
  readonly wordsAbsent?: readonly string[];
  /**
   * Request words on the page none of whose lines were sent; absent when
   * none. An answer about these words cannot be known from this read.
   */
  readonly wordsUnsent?: readonly string[];
}

export interface BoundPageOptions {
  /** The most UTF-8 bytes the returned text may have, header included. */
  readonly maxBytes: number;
  /** The request: instruction and schema text. Its words rank the lines. */
  readonly ask: string;
  /**
   * The customer's own task, when the extraction serves an agent run (it is
   * also inside `ask`). A word only the extraction instruction adds weighs
   * {@link INSTRUCTION_ONLY_WEIGHT}: see there.
   */
  readonly task?: string;
  /**
   * `tree` lines open with their depth (`serializeTree`), which is what lets a
   * match bring its whole row; `markdown` has no depth, so a match brings its
   * neighbours.
   */
  readonly kind: 'tree' | 'markdown';
}

/** The page as sent, and what was cut from it — `cut` absent when nothing was. */
export interface BoundPage {
  readonly text: string;
  readonly cut?: PageCut;
}

function wordList(words: readonly string[]): string {
  return words.map((word) => `"${word}"`).join(', ');
}

function cutHeader(cut: PageCut): string {
  // What the cut provably did NOT drop. Without it an extraction asked for
  // every row carrying a word cannot tell "all of them" from "all I was shown",
  // and calls a complete answer incomplete (OC-284, run_8f78fa77, 2026-10-02).
  const coverage =
    (cut.wordsAllSent === undefined ? '' :
      `Every line of the FULL page containing any of the whole words ${wordList(cut.wordsAllSent)} is below. `) +
    (cut.wordsAbsent === undefined ? '' :
      `These whole words are on no line of the FULL page: ${wordList(cut.wordsAbsent)}. `) +
    (cut.wordsUnsent === undefined ? '' :
      `These whole words are on the FULL page but on NO line below: ${wordList(cut.wordsUnsent)}. `);
  return (
    `[THIS PAGE WAS CUT to fit this extraction's share of the run's budget: ${String(cut.sentLines)} of ` +
    `${String(cut.pageLines)} lines (${String(cut.sentChars)} of ${String(cut.pageChars)} characters) are below. ` +
    'Lines carrying the words of the request were kept first, each with the row around it, then the top ' +
    'of the page; "[N lines omitted]" marks each place lines were dropped. ' + coverage +
    'Answer only from what is below. ' +
    'Where the answer needs a part of the page that is not here, leave it out rather than guess. ' +
    'Do not claim coverage of omitted text; report any resulting gaps in the answer.]'
  );
}

function gapLine(omitted: number): string {
  return `[${String(omitted)} lines omitted]`;
}

/**
 * Lower-cased words of three or more letters or digits, stopwords out,
 * deduplicated. URLs are left out: a URL in a request says where to go, not
 * what to find, and its words ("title", "500", "action") were rarer on
 * OC-284's history pages than the words the task asked about, and took the
 * budget from them (2026-10-02).
 */
export function askTerms(ask: string): readonly string[] {
  const words = ask.replace(/https?:\/\/\S+/gu, ' ').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return [...new Set(words.filter((word) => STOPWORDS[word] !== true))];
}

/**
 * The page, cut to `maxBytes` when it is longer, otherwise returned
 * BYTE-IDENTICAL with no header: a page that fits is the page.
 *
 * ONE CALL, NOT A CHUNKED SERIES. Chunking would buy the whole page at the
 * price of several calls, each with the fixed prompt overhead and a merge
 * step, which is the cost this exists to bound; a relevance-first single read
 * keeps the bounded cost and still puts the answer's lines in front of the
 * model when the request names them.
 *
 * Ranked by the request's words weighted by rarity on THIS page (inverse line
 * frequency): a word on every row ("revision", "edit") ranks nothing, a word on
 * three rows ("Aquinas") ranks those three. Lines are emitted in document
 * order whichever pass kept them, so the model reads one coherent page.
 */
export function boundPage(page: string, opts: BoundPageOptions): BoundPage {
  if (Buffer.byteLength(page) <= opts.maxBytes) {
    return { text: page };
  }
  const lines = page.split('\n');
  const count = lines.length;
  const lengths = lines.map((line) => line.length);
  const bytes = lines.map((line) => Buffer.byteLength(line));
  const lower = lines.map((line) => line.toLowerCase());

  const terms = askTerms(opts.ask);
  // Paid for first, at its worst size: every count is bounded by the page's,
  // and every request word is named at most once in each coverage list.
  const named = terms.length === 0 ? {} : { wordsAllSent: terms, wordsAbsent: terms, wordsUnsent: terms };
  const worstHeader =
    Buffer.byteLength(cutHeader({ pageChars: page.length, sentChars: page.length, pageLines: count, sentLines: count, ...named })) + 1;
  const gapCost = gapLine(count).length + 1;
  const budget = opts.maxBytes - worstHeader - gapCost;
  if (budget < 0) throw new RangeError('The extraction allowance cannot fit its instructions and an honest page-cut notice.');

  const kept = new Uint8Array(count);
  let spent = 0;
  /**
   * Keep one line if it fits. Charged an upper bound on the gap markers it
   * can add: a line with no kept neighbour may split one gap into two, so it
   * pays for one marker; a line beside a kept one extends a run and adds none.
   */
  const keep = (at: number): boolean => {
    if (kept[at] === 1) return true;
    const isolated = (at === 0 || kept[at - 1] === 0) && (at === count - 1 || kept[at + 1] === 0);
    const cost = bytes[at]! + 1 + (isolated ? gapCost : 0);
    if (spent + cost > budget) return false;
    kept[at] = 1;
    spent += cost;
    return true;
  };

  // 1. The top of the page: title, heading, what the page is.
  const head = budget * HEAD_SHARE;
  for (let at = 0; at < count && spent < head; at += 1) {
    if (!keep(at)) break;
  }

  // 2. The request's lines, rarest words first, each with its row.
  /** Per request word, the lines of the page carrying it. */
  const hits: number[][] = [];
  if (terms.length > 0) {
    // Match the same Unicode words askTerms emits. Substrings make request
    // words such as "then" rank an unrelated name such as "Arthena" above the
    // actual subject, especially when that accidental match is rare.
    const matches = terms.map((term) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${term}(?=$|[^\\p{L}\\p{N}])`, 'u'));
    const taskWords = opts.task === undefined ? undefined : new Set(askTerms(opts.task));
    const weights: number[] = [];
    for (let t = 0; t < terms.length; t += 1) {
      const carrying: number[] = [];
      for (let at = 0; at < count; at += 1) if (matches[t]!.test(lower[at]!)) carrying.push(at);
      hits.push(carrying);
      const df = carrying.length;
      // A word on a quarter of the page or more locates nothing.
      const rarity = df === 0 || df > count / 4 ? 0 : Math.log((count + 1) / (df + 1));
      weights.push(taskWords === undefined || taskWords.has(terms[t]!) ? rarity : rarity * INSTRUCTION_ONLY_WEIGHT);
    }
    const scored: { at: number; rarest: number; score: number }[] = [];
    for (let at = 0; at < count; at += 1) {
      let score = 0;
      let rarest = 0;
      for (let t = 0; t < terms.length; t += 1) {
        if (weights[t]! > 0 && matches[t]!.test(lower[at]!)) {
          score += weights[t]!;
          rarest = Math.max(rarest, weights[t]!);
        }
      }
      if (score > 0) scored.push({ at, rarest, score });
    }
    // A repeated pair of generic request words must not outrank the one rare
    // locator. Combined relevance breaks ties only after the rarest match.
    scored.sort((a, b) => b.rarest - a.rarest || b.score - a.score || a.at - b.at);
    const blockOf = opts.kind === 'tree' ? treeBlocks(lines, lengths) : markdownBlock(count);
    // One word at a time (lines sharing a rarest weight): every row whole when
    // they all fit, which is the common case and unchanged. When they do not,
    // every matching line is kept first and then each row grows one line a
    // side in turn, so a word's rows SHARE what is left. Whole rows taken in
    // page order gave the first few matches everything and left the rest as a
    // bare line with no date: OC-284's history page at a 7,000-byte allowance
    // sent 3 of the 5 Aquinas rows with their dates, the last 2 without.
    for (let first = 0; first < scored.length && spent < budget; ) {
      let last = first + 1;
      while (last < scored.length && scored[last]!.rarest === scored[first]!.rarest) last += 1;
      const group = scored.slice(first, last);
      first = last;
      const blocks = group.map(({ at }) => blockOf(at));
      const before = spent;
      const snapshot = kept.slice();
      let whole = true;
      for (const [from, to] of blocks) {
        for (let line = from; line < to && whole; line += 1) whole = keep(line);
        if (!whole) break;
      }
      if (whole) continue;
      kept.set(snapshot);
      spent = before;
      const lo = group.map(({ at }) => at);
      const hi = group.map(({ at }) => at + 1);
      for (const { at } of group) keep(at);
      for (let grew = true; grew; ) {
        grew = false;
        for (let g = 0; g < group.length; g += 1) {
          const [from, to] = blocks[g]!;
          if (lo[g]! > from && keep(lo[g]! - 1)) {
            lo[g] = lo[g]! - 1;
            grew = true;
          }
          if (hi[g]! < to && keep(hi[g]!)) {
            hi[g] = hi[g]! + 1;
            grew = true;
          }
        }
      }
    }
  }

  // 3. The rest of the page in order, until it no longer fits.
  for (let at = 0; at < count; at += 1) {
    if (kept[at] === 0 && !keep(at)) break;
  }

  const body: string[] = [];
  let sentLines = 0;
  let sentChars = 0;
  let omitted = 0;
  for (let at = 0; at < count; at += 1) {
    if (kept[at] === 1) {
      if (omitted > 0) body.push(gapLine(omitted));
      omitted = 0;
      body.push(lines[at]!);
      sentLines += 1;
      sentChars += lengths[at]! + 1;
    } else {
      omitted += 1;
    }
  }
  if (omitted > 0) body.push(gapLine(omitted));
  const wordsAllSent = terms.filter((_, t) => hits[t]!.length > 0 && hits[t]!.every((at) => kept[at] === 1));
  const wordsAbsent = terms.filter((_, t) => hits[t]!.length === 0);
  // On the page, but not on one line the extraction was shown.
  const wordsUnsent = terms.filter((_, t) => hits[t]!.length > 0 && hits[t]!.every((at) => kept[at] === 0));
  const cut: PageCut = {
    pageChars: page.length,
    sentChars: Math.max(0, sentChars - 1),
    pageLines: count,
    sentLines,
    ...(wordsAllSent.length === 0 ? {} : { wordsAllSent }),
    ...(wordsAbsent.length === 0 ? {} : { wordsAbsent }),
    ...(wordsUnsent.length === 0 ? {} : { wordsUnsent }),
  };
  return { text: `${cutHeader(cut)}\n${body.join('\n')}`, cut };
}

/**
 * For a `serializeTree` page: the largest ancestor subtree of a line that
 * still fits {@link ROW_BLOCK_CHARS}, as `[from, to)`. A lone leaf, or a
 * fragment no larger than {@link ROW_FRAGMENT_CHARS}, also brings bounded
 * adjacent sibling subtrees: native filtering can erase its row container.
 * Parents and subtree ends come from one stack pass.
 */
function treeBlocks(lines: readonly string[], lengths: readonly number[]): (at: number) => readonly [number, number] {
  const count = lines.length;
  const depth = lines.map((line) => {
    const match = /^(\d+) /.exec(line);
    return match === null ? Number.POSITIVE_INFINITY : Number(match[1]);
  });
  const parent = new Int32Array(count).fill(-1);
  const end = new Int32Array(count).fill(count);
  const stack: number[] = [];
  for (let at = 0; at < count; at += 1) {
    while (stack.length > 0 && depth[stack[stack.length - 1]!]! >= depth[at]!) {
      end[stack.pop()!] = at;
    }
    parent[at] = stack.length > 0 ? stack[stack.length - 1]! : -1;
    stack.push(at);
  }
  const prefix = new Float64Array(count + 1);
  for (let at = 0; at < count; at += 1) prefix[at + 1] = prefix[at]! + lengths[at]! + 1;
  const size = (node: number): number => prefix[end[node]!]! - prefix[node]!;
  return (at) => {
    if (size(at) > ROW_BLOCK_CHARS) return [at, at + 1];
    let node = at;
    while (parent[node]! >= 0 && size(parent[node]!) <= ROW_BLOCK_CHARS) node = parent[node]!;
    if (parent[node]! >= 0 && (end[node] === node + 1 || size(node) <= ROW_FRAGMENT_CHARS)) {
      const container = parent[node]!;
      let from = node;
      let to = end[node]!;
      // Back over whole sibling subtrees: climb from the line before `from`
      // to the sibling that holds it, which must end exactly at `from`.
      while (from > 0) {
        let sibling = from - 1;
        while (sibling >= 0 && parent[sibling] !== container) sibling = parent[sibling]!;
        if (sibling < 0 || end[sibling] !== from || prefix[node]! - prefix[sibling]! > ROW_BLOCK_CHARS) break;
        from = sibling;
      }
      while (to < count && parent[to] === container && prefix[end[to]!]! - prefix[end[node]!]! <= ROW_BLOCK_CHARS) to = end[to]!;
      return [from, to];
    }
    return [node, end[node]!];
  };
}

/** For markdown: the line and its two neighbours, a table row's header context or a sentence's paragraph. */
function markdownBlock(count: number): (at: number) => readonly [number, number] {
  return (at) => [Math.max(0, at - 1), Math.min(count, at + 2)];
}

/**
 * The request-text token ceiling, priced at the model's own input rate and
 * never below {@link EXTRACT_FLOOR_TOKENS}. UTF-8 bytes are a conservative
 * text-token upper bound; overhead is counted in those same units.
 */
export function extractCeiling(
  maxUsd: string,
  inputUsdPerMillion: string,
  overheadBytes: number,
): { readonly tokens: number; readonly pageBytes: number } {
  const perToken = Number(inputUsdPerMillion) / 1_000_000;
  const affordable = perToken > 0 ? Math.floor((Number(maxUsd) * EXTRACT_INPUT_SHARE) / perToken) : Number.POSITIVE_INFINITY;
  const tokens = Math.max(EXTRACT_FLOOR_TOKENS, affordable);
  const pageBytes = Math.max(0, tokens - overheadBytes);
  return { tokens, pageBytes };
}
