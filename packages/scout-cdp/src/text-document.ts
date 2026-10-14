/**
 * A LARGE PLAIN-TEXT FILE IN THE TOP FRAME: a word list, a CSV export, a JSON
 * dump opened as a page.
 *
 * ── Why the tree is not read ───────────────────────────────────────────────
 *
 * The browser shows such a file as one `<pre>` holding every line, and the
 * accessibility tree of that is a text node and an inline text box per line,
 * built in the renderer. The cost grows faster than the file. Measured on
 * stock chrome-headless-shell 1248 (2026-10-14, n=1 per size, a newline word
 * list served `text/plain`), `Accessibility.getFullAXTree` took 44 ms at 20 KB
 * (4,214 nodes), 533 ms at 100 KB, 1.9 s at 200 KB and 7.4 s at 400 KB; on a
 * 4.2 MB list it had not answered after several minutes, while the navigation
 * itself committed in 0.9 s and `Runtime.evaluate` answered in 1 ms. The fork's
 * `Outcrawl.getAXTree` is the same walk: on production 2026-10-14, BU Bench
 * task 23 opened a 4 MB word list in all three runs, `Outcrawl.getAXTree` did
 * not answer within 30 s, the renderer then held every `Outcrawl.lock` and
 * `Outcrawl.unlock` behind it, and each run ended `page-unresponsive` without
 * the model being called again.
 *
 * So a text document over {@link TEXT_DOCUMENT_TREE_MAX_CHARS} is never handed
 * to the tree. The snapshot gets a tree of three nodes instead: the root, a
 * line saying what the file is and how big, and the file's first
 * {@link TEXT_DOCUMENT_WINDOW_CHARS} characters. A smaller one keeps its tree,
 * which then shows the text itself.
 *
 * ── Where the text comes from ──────────────────────────────────────────────
 *
 * The size is one `Runtime.evaluate` in an isolated world (a number, and the
 * page's own script sees nothing). The text is the bytes the browser kept,
 * from `Page.getResourceContent`, which never goes back to the site (see
 * `./top-frame.ts`). A file the browser did not keep, or one too large for one
 * reply on our socket, is read from its `<pre>` in the same isolated world,
 * {@link TEXT_DOCUMENT_MAX_CHARS} characters at most. `extract` is given that
 * text, as it is given a PDF's.
 */
import { isRecord } from '@outcrawl/scout-core';

import type { CdpPage } from './cdp';
import { readWorld } from './document';
import { cutAtLine, topResource, within, type TopFrame, type TopFrameWatch } from './top-frame';

/**
 * The largest text document whose accessibility tree is read, in characters.
 * 100 KB took 533 ms to build on stock Chromium (header), and the prompt
 * shows a small fraction of a tree that size (`TREE_CHAR_BUDGET` in
 * `@outcrawl/runtime`), so past it the tree costs time and shows nothing the
 * window does not.
 */
export const TEXT_DOCUMENT_TREE_MAX_CHARS = 100_000;

/** The file's opening characters the snapshot shows, cut at a line. */
export const TEXT_DOCUMENT_WINDOW_CHARS = 2_000;

/** The most text handed to `extract`, cut at a line: PDF_TEXT_MAX_CHARS, for the same reason. */
export const TEXT_DOCUMENT_MAX_CHARS = 1_000_000;

/**
 * The longest file read through `Page.getResourceContent`, in characters.
 * One reply carries the whole file and the protocol writes a non-ASCII code
 * unit as six bytes; our socket closes past 128 MiB (`./document.ts`,
 * `DOCUMENT_CHUNK_UNITS`, the same bound). A longer one is read from the page.
 */
const RESOURCE_READ_MAX_CHARS = 8 * 1024 * 1024;

/** How long a read may take before the step goes ahead without it. */
export const TEXT_DOCUMENT_READ_DEADLINE_MS = 10_000;

/** How long the snapshot waits for the one frame-tree read: PDF_FRAME_READ_DEADLINE_MS, for its reason. */
const TEXT_DOCUMENT_FRAME_READ_DEADLINE_MS = 1_000;

/**
 * Whether the browser shows a document of `mimeType` as plain text. HTML,
 * XML and SVG build real documents and are read as pages.
 */
export function isPlainTextMime(mimeType: string): boolean {
  const type = mimeType.toLowerCase();
  if (type === 'text/html' || type === 'text/xml' || type.endsWith('+xml')) return false;
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type.endsWith('+json') ||
    type === 'application/x-ndjson' ||
    type === 'application/javascript' ||
    type === 'application/csv'
  );
}

/** A large text document, read. */
export interface TextDocumentRead {
  readonly url: string;
  readonly mimeType: string;
  /** The whole file's length in characters, as the page holds it. */
  readonly chars: number;
  readonly lines: number;
  /** The text, cut to {@link TEXT_DOCUMENT_MAX_CHARS} at a line. */
  readonly text: string;
  /** Characters past the cut; 0 when the whole file is here. */
  readonly omittedChars: number;
  /** Where the text came from: the browser's cache, or the page's `<pre>` when the cache kept none. */
  readonly source: 'cache' | 'page';
}

/** The text document a tab is showing, when it is too large for the tree. */
export interface TextDocuments {
  /**
   * The top document's text when it is a plain-text file over
   * {@link TEXT_DOCUMENT_TREE_MAX_CHARS}; `undefined` for any other document,
   * which the tree serves.
   */
  large(): Promise<TextDocumentRead | undefined>;
}

/** The isolated-world size probe: length and line count of the shown text, and whether it has all arrived. */
const SIZE_EXPRESSION =
  "(() => { const text = document.documentElement?.textContent ?? ''; let lines = text.length === 0 ? 0 : 1; " +
  "for (let at = text.indexOf('\\n'); at !== -1; at = text.indexOf('\\n', at + 1)) lines += 1; " +
  'return { chars: text.length, lines, complete: document.readyState === "complete" }; })()';

async function evaluateIn(page: CdpPage, contextId: number, expression: string): Promise<unknown> {
  const reply = await page.send('Runtime.evaluate', { expression, contextId, returnByValue: true });
  if (reply['exceptionDetails'] !== undefined) throw new Error('the text read threw in its isolated world');
  const result = reply['result'];
  return isRecord(result) ? result['value'] : undefined;
}

/** The text the browser kept for `frame`'s document, decoded, or `undefined` when it kept none. */
async function cachedText(page: CdpPage, frame: TopFrame): Promise<string | undefined> {
  const reply = await topResource(page, frame);
  if ('why' in reply) return undefined;
  return reply.base64Encoded ? Buffer.from(reply.content, 'base64').toString('utf8') : reply.content;
}

interface Reading {
  readonly loaderId: string;
  readonly pending: Promise<TextDocumentRead>;
}

/** Reads the large text document `page`'s top frame is showing, once per document. */
export function textDocuments(page: CdpPage, watch: TopFrameWatch, deadlineMs = TEXT_DOCUMENT_READ_DEADLINE_MS): TextDocuments {
  let reading: Reading | undefined;

  async function readOnce(frame: TopFrame, contextId: number, size: { readonly chars: number; readonly lines: number }): Promise<TextDocumentRead> {
    const cached = size.chars <= RESOURCE_READ_MAX_CHARS ? await cachedText(page, frame) : undefined;
    const whole =
      cached ??
      (await evaluateIn(page, contextId, `(document.documentElement?.textContent ?? '').slice(0, ${String(TEXT_DOCUMENT_MAX_CHARS)})`));
    const text = typeof whole === 'string' ? whole : '';
    const cut = cutAtLine(text, TEXT_DOCUMENT_MAX_CHARS);
    const chars = cached === undefined ? size.chars : text.length;
    return {
      url: frame.url,
      mimeType: frame.mimeType,
      chars,
      lines: size.lines,
      text: cut.text,
      omittedChars: chars - cut.text.length,
      source: cached === undefined ? 'page' : 'cache',
    };
  }

  return {
    async large() {
      const frame = await watch.current(TEXT_DOCUMENT_FRAME_READ_DEADLINE_MS);
      if (frame === undefined || !isPlainTextMime(frame.mimeType)) return undefined;
      if (reading?.loaderId === frame.loaderId) return await reading.pending;
      // The size is probed on every snapshot until the file is big: a file
      // still arriving reads small first, and a small verdict kept would hand
      // the finished 4 MB file to the tree. A probe that cannot answer (the
      // document went in a navigation) leaves the tree to answer, as before.
      let contextId: number;
      let probed: unknown;
      try {
        contextId = await readWorld(page);
        probed = await evaluateIn(page, contextId, SIZE_EXPRESSION);
      } catch {
        return undefined;
      }
      if (!isRecord(probed) || typeof probed['chars'] !== 'number' || typeof probed['lines'] !== 'number') return undefined;
      if (probed['chars'] <= TEXT_DOCUMENT_TREE_MAX_CHARS) return undefined;
      const size = { chars: probed['chars'], lines: probed['lines'] };
      const pending = readOnce(frame, contextId, size);
      // Kept only once the file has all arrived (a read of a file still
      // loading is the part that had arrived), and dropped if it fails.
      if (probed['complete'] === true) {
        const kept: Reading = { loaderId: frame.loaderId, pending };
        reading = kept;
        pending.catch(() => {
          if (reading === kept) reading = undefined;
        });
      }
      const read = await within(pending, deadlineMs);
      if (read === undefined) throw new Error(`reading the ${frame.mimeType} document took longer than ${String(deadlineMs / 1000)} s`);
      return read;
    },
  };
}

/**
 * The snapshot's lines for a large text document: what it is, how big, that
 * only its opening is shown, and that `extract` reads the file.
 */
export function textDocumentNotice(read: TextDocumentRead): string {
  const kept =
    read.omittedChars === 0 ? 'the whole file' : `its first ${(read.chars - read.omittedChars).toLocaleString('en-US')} characters`;
  return (
    `This tab shows a ${read.mimeType} file, not a web page: ${read.chars.toLocaleString('en-US')} characters in ` +
    `${read.lines.toLocaleString('en-US')} lines, too large to show here. Below are its first lines only. ` +
    `{"type":"extract"} reads ${kept}. Scrolling shows nothing more here.`
  );
}

/** The first {@link TEXT_DOCUMENT_WINDOW_CHARS} characters, cut at a line, with what follows counted. */
export function textDocumentWindow(read: TextDocumentRead): string {
  const shown = cutAtLine(read.text, TEXT_DOCUMENT_WINDOW_CHARS);
  return `${shown.text}\n[... ${(read.chars - shown.text.length).toLocaleString('en-US')} more characters]`;
}

/** What `extract` is given for a large text document: its text, introduced. */
export function textDocumentMarkdown(read: TextDocumentRead): string {
  const cut =
    read.omittedChars === 0
      ? ''
      : `\n\n[The text stops here: ${read.omittedChars.toLocaleString('en-US')} more characters of this file are not included.]`;
  return (
    `${read.mimeType} file ${read.url}, ${read.chars.toLocaleString('en-US')} characters in ${read.lines.toLocaleString('en-US')} lines. ` +
    `Its text, exactly as the file holds it:\n\n${read.text}${cut}`
  );
}
