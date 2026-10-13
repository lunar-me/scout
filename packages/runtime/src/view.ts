/**
 * The page as PIXELS, and the one thing pixels cannot carry.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Input tokens are this product's dominant cost, and on content-heavy pages the
 * accessibility tree IS the page: measured on a live 571-comment Hacker News
 * thread, `StaticText` is 42,473 tokens (43%) against 55,308 (57%) of actionable
 * lines, because the site renders about five anchors per comment. So pruning
 * text saves 43% and not 90%, and the only remaining lever is to stop sending
 * the tree at all.
 *
 * A viewport screenshot of that page is two 768px tiles — about 516 tokens by
 * the vendor arithmetic in `@outcrawl/captcha`'s `estimateImageTokens` —
 * against 97,781 for the tree. That is the whole prize.
 *
 * ── The gap this type closes ────────────────────────────────────────────────
 *
 * Every action carries a {@link NodeRef}: `[frameOrdinal-backendNodeId]`, minted
 * by the browser. A vision model cannot emit one. It can emit "the third button"
 * or a pixel coordinate, and both are unusable:
 *
 *   * a coordinate survives neither re-render NOR reflow, cannot be validated at
 *     all — a 40px miss lands on the wrong element and reports success — and
 *     cannot be cached, because `healAction` heals an `ObservedAction.xpath`
 *     and there is nothing to heal about a pixel;
 *   * a description is `Outcrawl.observe`'s problem, and costs a model call.
 *
 * So the page is marked: numbered badges are painted over the actionable
 * elements, the model answers with a NUMBER, and the number is resolved back to
 * the real reference HERE, before `validateAction` ever sees it. The map is
 * built from the same `Outcrawl.getAXTree` the text arm reads — the tree is
 * still READ every step, it is simply not SENT. Tokens are what crosses the
 * wire, not what we look at.
 *
 * A mark number that no badge on the screenshot carries is refused in these
 * same terms by {@link unknownMark}; anything else unresolvable fails exactly
 * as an unusable `ref` fails, and `renderPrompt` shows the model its own error
 * on the next step.
 *
 * ── The fold, which is the real risk ────────────────────────────────────────
 *
 * A viewport image is 1,032 tokens and roughly 0.4% of a 149,000px thread. An
 * agent that does not know the page continues below the fold concludes a control
 * does not exist and gives up. The tree arm never had this problem because the
 * tree is the whole document.
 *
 * The answer is the one advantage of reading the tree locally: we know EXACTLY
 * what is off-screen, so {@link markLegend} states it — scroll offset, document
 * height, and the count of actionable elements above and below the viewport.
 * Twenty tokens, derived rather than guessed.
 */

import type { NodeRef } from './snapshot';
import { formatNodeRef, parseNodeRef } from './snapshot';

/** Viewport-relative CSS-pixel geometry, as the page reported it. */
export interface MarkBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * One numbered badge, and what it points at.
 *
 * `n` is 1-based and stable only within one capture. It has to be: the whole
 * point is that it is small enough to read off an image, and a document-stable
 * id would be a `backendNodeId` again.
 */
export interface Mark {
  readonly n: number;
  readonly ref: NodeRef;
  readonly role: string;
  readonly name?: string;
  readonly box: MarkBox;
}

/** How much of the document one capture covers, in CSS pixels. */
export interface ViewGeometry {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly scroll: { readonly x: number; readonly y: number };
  readonly document: { readonly width: number; readonly height: number };
}

/**
 * What the model is shown instead of a tree.
 *
 * The image is raw base64 with no `data:` prefix, matching
 * `@outcrawl/model`'s `ModelImage` exactly, because the two providers disagree
 * about where the prefix goes and a doubled prefix is a thing that reaches a
 * provider and gets billed.
 */
export interface PageView {
  readonly image: { readonly mediaType: 'image/png'; readonly base64: string };
  /** On-screen and resolvable. A badge nobody can see is a token wasted. */
  readonly marks: readonly Mark[];
  readonly geometry: ViewGeometry;
  /**
   * Actionable elements the image does NOT show, above and below the viewport.
   *
   * Not a nicety. This is the difference between "there is no Next button" and
   * "the Next button is 400px below the fold", and the model cannot tell those
   * apart from pixels alone.
   */
  readonly offscreen: { readonly above: number; readonly below: number };
  /** Draw + composite + capture + erase, measured. The arm's wall-time tax. */
  readonly captureMs: number;
  /** PNG pixel size, for the tile arithmetic. Not always the CSS viewport. */
  readonly pixels: { readonly width: number; readonly height: number };
}

/**
 * The prompt block that replaces the serialised tree.
 *
 * NUMBER-ONLY, deliberately, and this is the load-bearing choice in the whole
 * arm. A legend carrying `role` and `name` per mark would cost roughly eight
 * tokens times the on-screen actionable count — 640 tokens on a Hacker News
 * comments page — and, worse, it would reproduce precisely the 57% of the tree
 * that pruning `StaticText` could not remove. The saving would then come from
 * viewport-scoping rather than from the image, and the experiment would answer
 * a different question than the one asked.
 *
 * So identity comes from the picture. The text carries only what a picture
 * cannot: the numbers exist, what they mean, and what is off-screen.
 */
export function markLegend(view: PageView): string {
  const { geometry, marks, offscreen } = view;
  const lines = [
    'Page, screenshot. Numbered badges mark every element you can act on. ' +
      'To act on one, answer with its number as "ref" — "ref":"7", not a coordinate and not a name.',
  ];

  const covered =
    geometry.document.height <= geometry.viewport.height
      ? 'The whole page is in this image.'
      : `This image is the VIEWPORT ONLY: ${String(geometry.viewport.height)} of ` +
        `${String(geometry.document.height)} css px, scrolled to y=${String(Math.round(geometry.scroll.y))}.`;
  lines.push(
    `${String(marks.length)} numbered element(s) visible. ${covered}` +
      (offscreen.below > 0 || offscreen.above > 0
        ? ` NOT SHOWN: ${String(offscreen.below)} actionable element(s) below the fold and ` +
          `${String(offscreen.above)} above it. If what you need is not in the image, it may be one of ` +
          `those — scroll rather than concluding it does not exist.`
        : ' Nothing actionable is off-screen.'),
  );
  return lines.join('\n');
}

/**
 * A model reply's `ref` — a mark number — as a real reference.
 *
 * Pass-through for a wire reference, because two things can legitimately arrive
 * here: a mark number from a vision arm, and a `frameOrdinal-backendNodeId`
 * from a model that has seen the wire form in its own history block and copied
 * it. Rejecting the second would fail a step for being right.
 *
 * `undefined` for anything else, which is the caller's cue to leave the value
 * alone and let `validateAction` produce the error message — one validator, one
 * vocabulary.
 */
export function resolveMark(value: unknown, marks: readonly Mark[]): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (parseNodeRef(trimmed) !== undefined) {
    return trimmed;
  }
  const n = markNumber(trimmed);
  const mark = n === undefined ? undefined : marks.find((candidate) => candidate.n === n);
  return mark === undefined ? undefined : formatNodeRef(mark.ref);
}

/**
 * The mark a `ref` names — `7`, or `#7`, because a model told to answer with a
 * number will sometimes answer with the badge as it is drawn — or `undefined`.
 */
function markNumber(value: string): number | undefined {
  const digits = /^#?(\d+)$/.exec(value.trim());
  return digits === null ? undefined : Number(digits[1]);
}

/**
 * The refusal for a reply whose `ref` is a mark number no badge on THIS
 * screenshot carries, or `undefined` when there is nothing to refuse here.
 *
 * In the vocabulary the vision arm was taught. Before this, such a number fell
 * through to `validateAction`, whose refusal asks for "the reference printed in
 * brackets beside a node, written as a "frame-backendNode" string" — the text
 * arm's form, which a vision prompt never shows. Measured, HarnessAB
 * 2026-09-26, lab-flashlite-vision: 6 such refusals in 2 of 20 runs
 * (run_… answered `"13"`, `"19"`, `"13"`; run_… `"3"`, `"4"`,
 * `"6"`), each run ending `stop=error` on four failed steps in a row. The
 * numbers are drawn per capture (`Mark.n`), so a number read off an earlier
 * screenshot is the plausible source — not measured: the images are not kept.
 */
export function unknownMark(action: unknown, marks: readonly Mark[]): string | undefined {
  if (typeof action !== 'object' || action === null || !('ref' in action) || typeof action.ref !== 'string') {
    return undefined;
  }
  const n = markNumber(action.ref);
  if (n === undefined || marks.some((mark) => mark.n === n)) {
    return undefined;
  }
  if (marks.length === 0) {
    return (
      `mark ${String(n)} is not on this screenshot, which has no numbered badges: nothing you can act on is in ` +
      'view. Scroll, navigate or wait instead.'
    );
  }
  return (
    `mark ${String(n)} is not on this screenshot. The badges on it are ${numberRanges(marks.map((mark) => mark.n))}: ` +
    'answer with one of those numbers as "ref". The numbers are redrawn on every screenshot, so one read off an ' +
    'earlier screenshot names nothing now; if what you want is not in this image, scroll to it first.'
  );
}

/** Mark numbers, which are unique per capture, as `1-3, 5, 7-8`. */
function numberRanges(numbers: readonly number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === (sorted[j] ?? 0) + 1) {
      j += 1;
    }
    parts.push(i === j ? String(sorted[i]) : `${String(sorted[i])}-${String(sorted[j])}`);
    i = j + 1;
  }
  return parts.join(', ');
}

/**
 * One reply object with its `ref` resolved through the marks.
 *
 * Returns the input unchanged when there is nothing to do, so the text arm
 * pays not one allocation for this existing.
 */
export function withResolvedMark(action: unknown, marks: readonly Mark[]): unknown {
  if (typeof action !== 'object' || action === null || Array.isArray(action)) {
    return action;
  }
  if (!('ref' in action)) {
    return action;
  }
  const resolved = resolveMark(action.ref, marks);
  return resolved === undefined ? action : { ...action, ref: resolved };
}
