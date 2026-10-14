/**
 * THE TAB'S TOP DOCUMENT, as its last main-frame commit described it.
 *
 * Shared by the readers of a top document the accessibility tree cannot
 * serve: `./pdf-document.ts` (the tree is the PDF viewer's toolbar) and
 * `./text-document.ts` (the tree of a large plain-text file never finishes
 * building). Both decide by the commit's `mimeType` and read by its frame id,
 * url and loader id, so both need the same answer to "what is the top frame
 * showing", from the same events.
 */
import { isRecord } from '@outcrawl/scout-core';

import type { CdpPage } from './cdp';

export interface TopFrame {
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

/** `promise`'s value, or `undefined` once `ms` have passed. A real timer: see `./freeze.ts`. */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  const late = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => late.resolve(undefined), ms);
  try {
    return await Promise.race([promise, late.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/** `text` cut to `max` characters at a line, and how many were left out. */
export function cutAtLine(text: string, max: number): { readonly text: string; readonly omittedChars: number } {
  if (text.length <= max) return { text, omittedChars: 0 };
  const line = text.lastIndexOf('\n', max);
  const at = line > 0 ? line : max;
  return { text: text.slice(0, at), omittedChars: text.length - at };
}

/** The top frame of one tab, kept current by its commits. */
export interface TopFrameWatch {
  /**
   * The top frame, waiting up to `waitMs` for the one frame-tree read a
   * binding made after its document's commit needs; `undefined` when that
   * read has not answered or the commit did not describe itself.
   */
  current(waitMs: number): Promise<TopFrame | undefined>;
}

/** Watches `page`'s main-frame commits. One per tab, shared by every reader. */
export function topFrameWatch(page: CdpPage): TopFrameWatch {
  // `undefined` until a commit is seen, `null` for a commit that did not
  // describe itself. A commit replaces it, so a navigation never leaves a
  // stale document behind; that rests on the host having enabled the Page
  // domain, which both hosts do on every tab they drive.
  let top: TopFrame | null | undefined;
  page.on('Page.frameNavigated', (params) => {
    const frame = params['frame'];
    if (isRecord(frame) && frame['parentId'] === undefined) {
      top = topFrameOf(frame) ?? null;
    }
  });
  /** The one frame-tree read, while it runs. */
  let topRead: Promise<void> | undefined;

  return {
    /**
     * Read from the frame tree ONCE, only when this binding was made after
     * the commit of the document it is showing (a tab the page opened,
     * attached late); every later document arrives as a commit.
     */
    async current(waitMs) {
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
    },
  };
}

/**
 * The bytes the browser kept for `frame`'s document, from `Page.getResourceContent`:
 * answered from the HTTP cache with a cache-only load, so it never reaches the
 * site (measured for `./pdf-document.ts`; its header has the numbers). A
 * document the browser did not keep comes back as why, as a clause.
 */
export async function topResource(
  page: CdpPage,
  frame: TopFrame,
): Promise<{ readonly content: string; readonly base64Encoded: boolean } | { readonly why: string }> {
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
  return { content, base64Encoded: reply['base64Encoded'] === true };
}
