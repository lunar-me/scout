/**
 * THE TEXT OF THE PDF A TAB IS SHOWING.
 *
 * ── Why the tree has none of it ────────────────────────────────────────────
 *
 * A tab on a PDF holds no document of the PDF's. Chromium hands
 * `application/pdf` to its viewer: the top frame keeps an embedder shell, a
 * child frame runs the viewer's toolbar, and the file is drawn by the PDF
 * plugin in a frame below that. Measured on stock Chromium 156 (2026-10-13,
 * n=1, a 90-page public statistics report): `Accessibility.getFullAXTree` gave
 * 6 nodes on the top frame, 644 on the viewer frame (toolbar buttons and page
 * thumbnails, the document title the only text), and 5 on the plugin's frame,
 * whose `EmbeddedObject` had no children, still none after
 * `Accessibility.enable` and 5 s. The plugin's text is not in any accessibility
 * tree CDP can read, so no filter in this binding drops it, and the agent was
 * reading toolbar labels: 23 to 209 characters at 14 of 14 decision points on
 * PDF tabs in one production run (2026-10-13).
 *
 * ── Where the text comes from: the bytes the browser already holds ─────────
 *
 * `Page.getResourceContent` on the top frame for its own URL returns the PDF
 * file, whole. It is answered from the HTTP cache with a cache-only load
 * (Blink's `InspectorResourceContentLoader`), so it never goes to the network.
 * Measured on stock Chromium 156 against a local server that counted requests
 * (2026-10-13, n=1 per arm, a 2,629,759-byte PDF): served with
 * `max-age=3600`, with no cache headers, and with `no-cache`, it returned all
 * 2,629,759 bytes in 51-75 ms with 0 requests reaching the server and no new
 * Resource Timing entry in the page; under `Emulation.setVirtualTimePolicy`
 * `pause` it still answered, in 75 ms. Served with `no-store` it answered
 * "Resource was not cached", again with 0 requests.
 *
 * So a PDF the browser did not keep cannot be read here: one served
 * `no-store`, or one larger than its cache keeps (Chromium's in-memory cache,
 * which an off-the-record profile uses, takes no entry over an eighth of its
 * total size; that bound is from its source, not measured here). That is
 * stated to the model rather than worked around: the other ways to the bytes
 * are worse. `Network.getResponseBody` on the top frame's Document request
 * returns the embedder shell (716 bytes of HTML, measured), and the plugin
 * frame's own stream request carries the file only if `Network` was enabled in that frame
 * before it loaded, which means auto-attaching to every out-of-process frame of
 * every page. A re-fetch (`Network.loadNetworkResource`) reaches the site: the
 * same server saw one more GET with `Sec-Fetch-Dest: empty` and
 * `Sec-Fetch-Mode: no-cors` (measured, same arms).
 *
 * `Page.getResourceContent` needs the Page domain, which a host enables on
 * every tab it drives; it is enabled here, once, if a read finds it off.
 *
 * ── What the binding does with it ──────────────────────────────────────────
 *
 * {@link PdfDocuments.read} reads and parses the PDF once per document (the
 * parser is `extractPdfText` in `@outcrawl/scout-core`, no network and no
 * clock), and `extract` reads the text instead of the viewer's toolbar. The
 * snapshot carries one line saying the tab shows a PDF and that `extract`
 * reads it, because a model shown only a toolbar concludes the page is empty.
 */
import { extractPdfText, isRecord, type PdfRefusal } from '@outcrawl/scout-core';

import type { CdpPage } from './cdp';

/**
 * The largest PDF read, in bytes. The bytes cross the CDP socket as base64
 * and are parsed in this process: 2.6 MB parsed in 154 ms (measured, the PDF
 * above), so this bound is about 2 s of parsing.
 */
export const PDF_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The most PDF text handed to `extract`, in characters, cut at a line. The
 * 90-page report above is 540,133 characters, so a long report fits whole.
 * The extraction's own spend allowance cuts further, by relevance to the ask.
 */
export const PDF_TEXT_MAX_CHARS = 1_000_000;

/**
 * How long `extract` waits for the read. A cached 2.6 MB PDF answered in under
 * 100 ms (measured); this bounds a read the renderer is slow to serve, which
 * then goes ahead without the PDF rather than holding the step.
 */
export const PDF_READ_DEADLINE_MS = 10_000;

/**
 * How long the snapshot waits for its one `Page.getFrameTree`. That command is
 * answered by the renderer and is held while the renderer runs script
 * (`./freeze.ts`), so the snapshot bounds it, goes ahead without a PDF line,
 * and asks the same pending read again next time rather than sending another.
 */
export const PDF_FRAME_READ_DEADLINE_MS = 1_000;

const PDF_MIME_TYPE = 'application/pdf';

/** `promise`'s value, or `undefined` once `ms` have passed. A real timer: see `./freeze.ts`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  const late = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => late.resolve(undefined), ms);
  try {
    return await Promise.race([promise, late.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/** What a read of the tab's PDF came to. */
export type PdfDocumentRead =
  | {
      readonly outcome: 'read';
      readonly url: string;
      /** `/Info /Title`, when the file declares one. */
      readonly title?: string;
      readonly pages: number;
      /** The text layer, cut to {@link PDF_TEXT_MAX_CHARS} at a line. */
      readonly text: string;
      /** Characters of text past the cut; 0 when the whole text is here. */
      readonly omittedChars: number;
    }
  | {
      readonly outcome: 'unread';
      readonly url: string;
      /** Why there is no text, as a clause: "it is encrypted". */
      readonly why: string;
    };

/** The PDF a tab is showing, if it is showing one. */
export interface PdfDocuments {
  /**
   * The top document's read, waiting up to {@link PDF_READ_DEADLINE_MS};
   * `undefined` when the top document is not a PDF.
   */
  read(): Promise<PdfDocumentRead | undefined>;
  /**
   * Whether the top document is a PDF, and its read if one has settled.
   * Starts the read and never waits for it: the snapshot asks this.
   */
  peek(): Promise<{ readonly url: string; readonly read: PdfDocumentRead | undefined } | undefined>;
}

interface TopFrame {
  readonly id: string;
  readonly url: string;
  readonly mimeType: string;
  readonly loaderId: string;
}

function topFrameOf(frame: unknown): TopFrame | undefined {
  if (!isRecord(frame)) return undefined;
  const { id, url, mimeType, loaderId } = frame;
  return typeof id === 'string' && typeof url === 'string' && typeof mimeType === 'string' && typeof loaderId === 'string'
    ? { id, url, mimeType, loaderId }
    : undefined;
}

const REFUSALS: Readonly<Record<PdfRefusal, string>> = {
  encrypted: 'it is encrypted',
  'no-text-layer': 'it has no text layer: its pages are images, a scan',
  'not-a-pdf': 'the bytes the browser holds for it are not a PDF',
  unreadable: 'its structure could not be read',
};

/** `text` cut to `max` characters at a line, and how many were left out. */
function cutAtLine(text: string, max: number): { readonly text: string; readonly omittedChars: number } {
  if (text.length <= max) return { text, omittedChars: 0 };
  const line = text.lastIndexOf('\n', max);
  const at = line > 0 ? line : max;
  return { text: text.slice(0, at), omittedChars: text.length - at };
}

/** A read that ended this way is final for its document; any other is tried again. */
interface Settled {
  readonly read: PdfDocumentRead;
  readonly final: boolean;
}

/**
 * One document's read: still running, or settled. `earlier` is the attempt a
 * retry replaced, which the snapshot shows until the retry settles.
 */
interface Reading {
  readonly loaderId: string;
  readonly pending: Promise<Settled>;
  settled?: Settled;
  readonly earlier?: Settled;
}

/** Reads the PDF `page`'s top frame is showing, once per document. */
export function pdfDocuments(page: CdpPage, deadlineMs = PDF_READ_DEADLINE_MS): PdfDocuments {
  // The top frame as the last main-frame commit described it: `undefined`
  // until a commit is seen, `null` for a document that cannot be a PDF read
  // (a commit that did not describe itself). A commit replaces it, so a
  // navigation never leaves a stale PDF behind; that rests on the host having
  // enabled the Page domain, which both hosts do on every tab they drive.
  let top: TopFrame | null | undefined;
  page.on('Page.frameNavigated', (params) => {
    const frame = params['frame'];
    if (isRecord(frame) && frame['parentId'] === undefined) {
      top = topFrameOf(frame) ?? null;
    }
  });

  let reading: Reading | undefined;
  /** The one frame-tree read, while it runs. */
  let topRead: Promise<void> | undefined;

  /**
   * The top frame. Read from the frame tree ONCE, only when this binding was
   * made after the commit of the document it is showing (a tab the page
   * opened, attached late); every later document arrives as a commit.
   */
  async function currentTop(waitMs: number): Promise<TopFrame | undefined> {
    if (top === undefined) {
      topRead ??= (async () => {
        try {
          const tree = (await page.send('Page.getFrameTree'))['frameTree'];
          // A commit seen meanwhile is newer than this answer.
          if (top === undefined) top = topFrameOf(isRecord(tree) ? tree['frame'] : undefined) ?? null;
        } catch {
          topRead = undefined;
        }
      })();
      await within(topRead, waitMs);
    }
    return top ?? undefined;
  }

  async function bytesOf(frame: TopFrame): Promise<{ readonly bytes: Uint8Array } | { readonly why: string }> {
    const ask = (): Promise<Record<string, unknown>> => page.send('Page.getResourceContent', { frameId: frame.id, url: frame.url });
    let reply: Record<string, unknown>;
    try {
      reply = await ask();
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      if (!/not enabled/iu.test(said)) {
        return { why: /not cached/iu.test(said) ? 'the browser kept no copy of it to read (it was served no-store, or is larger than the cache keeps)' : `the browser could not hand over its bytes (${said})` };
      }
      // `Page.getResourceContent` needs the Page domain. Only a host that did
      // not enable it on this tab reaches this line.
      await page.send('Page.enable').catch(() => undefined);
      try {
        reply = await ask();
      } catch (again) {
        return { why: `the browser could not hand over its bytes (${again instanceof Error ? again.message : String(again)})` };
      }
    }
    const content = reply['content'];
    if (typeof content !== 'string') return { why: 'the browser answered with no bytes' };
    const size = reply['base64Encoded'] === true ? Math.floor((content.length * 3) / 4) : Buffer.byteLength(content, 'latin1');
    if (size > PDF_MAX_BYTES) {
      return { why: `it is ${(size / 1_048_576).toFixed(1)} MB, over the ${String(PDF_MAX_BYTES / 1_048_576)} MB read here` };
    }
    return { bytes: reply['base64Encoded'] === true ? Buffer.from(content, 'base64') : Buffer.from(content, 'latin1') };
  }

  async function readOnce(frame: TopFrame): Promise<Settled> {
    const got = await bytesOf(frame);
    if ('why' in got) return { read: { outcome: 'unread', url: frame.url, why: got.why }, final: false };
    const parsed = extractPdfText(got.bytes);
    if (!parsed.ok) {
      // `unreadable` is also what a truncated file looks like, so it is tried again.
      return { read: { outcome: 'unread', url: frame.url, why: REFUSALS[parsed.refusal] }, final: parsed.refusal !== 'unreadable' };
    }
    const { text, omittedChars } = cutAtLine(parsed.text, PDF_TEXT_MAX_CHARS);
    return {
      read: {
        outcome: 'read',
        url: frame.url,
        ...(parsed.title === undefined ? {} : { title: parsed.title }),
        pages: parsed.pages,
        text,
        omittedChars,
      },
      final: true,
    };
  }

  /** The read for `frame`'s document: the settled one, the running one, or a new one. */
  function started(frame: TopFrame): Reading {
    if (reading !== undefined && reading.loaderId === frame.loaderId && (reading.settled === undefined || reading.settled.final)) {
      return reading;
    }
    const entry: Reading = {
      loaderId: frame.loaderId,
      pending: readOnce(frame).catch(
        (error: unknown): Settled => ({
          read: { outcome: 'unread', url: frame.url, why: `reading it failed (${error instanceof Error ? error.message : String(error)})` },
          final: false,
        }),
      ),
      ...(reading?.loaderId === frame.loaderId && reading.settled !== undefined ? { earlier: reading.settled } : {}),
    };
    void entry.pending.then((settled) => {
      entry.settled = settled;
    });
    reading = entry;
    return entry;
  }

  async function pdfTop(waitMs: number): Promise<TopFrame | undefined> {
    const frame = await currentTop(waitMs);
    return frame !== undefined && frame.mimeType === PDF_MIME_TYPE ? frame : undefined;
  }

  return {
    async read() {
      const frame = await pdfTop(deadlineMs);
      if (frame === undefined) return undefined;
      const settled = await within(started(frame).pending, deadlineMs);
      return settled?.read ?? { outcome: 'unread', url: frame.url, why: `reading it took longer than ${String(deadlineMs / 1000)} s` };
    },

    async peek() {
      const frame = await pdfTop(PDF_FRAME_READ_DEADLINE_MS);
      if (frame === undefined) return undefined;
      const entry = started(frame);
      return { url: frame.url, read: (entry.settled ?? entry.earlier)?.read };
    },
  };
}

/**
 * The snapshot's line for a PDF tab: what it is, how much text it holds, and
 * that `extract` reads it. `read` is `undefined` while the read is running.
 */
export function pdfNotice(read: PdfDocumentRead | undefined): string {
  if (read?.outcome === 'unread') {
    return `This tab shows a PDF document, and its text cannot be read: ${read.why}.`;
  }
  const size =
    read === undefined
      ? ''
      : `${read.title === undefined ? '' : ` "${read.title}"`}: ${read.pages.toLocaleString('en-US')} page${read.pages === 1 ? '' : 's'}, ` +
        `${(read.text.length + read.omittedChars).toLocaleString('en-US')} characters of text`;
  return `This tab shows a PDF document${size}. Its text is not shown here; {"type":"extract"} reads it.`;
}

/** What `extract` is given for a PDF tab: the document's text, introduced. */
export function pdfMarkdown(read: Extract<PdfDocumentRead, { readonly outcome: 'read' }>): string {
  const head = read.title === undefined ? '' : `# ${read.title}\n\n`;
  const cut =
    read.omittedChars === 0
      ? ''
      : `\n\n[The text stops here: ${read.omittedChars.toLocaleString('en-US')} more characters of this PDF are not included.]`;
  return (
    `${head}PDF document ${read.url}, ${read.pages.toLocaleString('en-US')} page${read.pages === 1 ? '' : 's'}. Its text, read from the file: one ` +
    "printed line per line, and a table's columns can come one after another rather than side by side.\n\n" +
    `${read.text}${cut}`
  );
}
