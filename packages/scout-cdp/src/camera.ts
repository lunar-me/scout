/**
 * THE CAMERA: the set-of-marks capture and `page.look`'s reads.
 *
 * `page.look` is two reads, both invisible to the page, and that is the whole
 * design constraint. `Page.captureScreenshot` reads the compositor's frame: no
 * overlay is painted (unlike `capture`, whose marks are painted onto the
 * picture on this side), no scroll, no resize (`captureBeyondViewport: false`),
 * no focus. `DOM.getNodeForLocation` is a DevTools hit test that dispatches no
 * event. The one script is `parentElement`, walked in an ISOLATED world, so a
 * page that patched `Node.prototype` never sees it called.
 */
import type { AxNode, AxTree, LookLocation, LookShot, Mark, MarkBox, NodeRef, PageView, ViewportPoint } from '@outcrawl/runtime';
import { ACTIONABLE_ROLES, filterTree, formatNodeRef, walk } from '@outcrawl/runtime';

import type { CdpPage } from './cdp';
import type { HandsTarget } from './hands';
import type { ShotRegion } from './hooks';
import {
  LOOK_CAPTURE_DEADLINE_MS,
  TEXT_CAPTCHA_CLIP_WIDTH_PX,
  TEXT_CAPTCHA_PAINTED_MIN_B64,
  TEXT_CAPTCHA_PAINT_POLL_MS,
  TEXT_CAPTCHA_PAINT_READS,
} from './look';
import { MEASURE_MARKS, drawResult, type DrawResult } from './marks';
import { ancestorsOf, documentClip, hitAt, onScreenPart, viewport } from './page-reads';
import { paintMarks } from './png-marks';
import { MIN_HITTABLE_PX } from './reach';
import type { Clock } from '@outcrawl/scout-core';

/** What the camera reads a bound page through. */
export interface CameraContext {
  readonly page: CdpPage;
  readonly clock: Clock;
  snapshot(): Promise<AxTree>;
  maskedShot(base64: string, region?: ShotRegion, sweep?: boolean): Promise<string>;
  sessionFor(ref: NodeRef): Promise<{ readonly page: CdpPage; readonly backendNodeId: number }>;
  boxOf(ref: NodeRef): Promise<HandsTarget>;
  sessionFrame(): Promise<number>;
}

/** One bound page's camera. */
export interface PageCamera {
  capture(): Promise<PageView>;
  lookShoot(ref?: NodeRef): Promise<LookShot>;
  shootElement(ref: NodeRef): Promise<LookShot['image']>;
  lookLocate(point: ViewportPoint): Promise<LookLocation | undefined>;
}

export function pageCamera(context: CameraContext): PageCamera {
  const { page, clock, snapshot, maskedShot, sessionFor, boxOf, sessionFrame } = context;

  /**
   * The set-of-marks read: measure every candidate's rect, photograph the
   * page as it is, and paint numbered badges onto the PICTURE on this host.
   *
   * ── Nothing is drawn into the page ──────────────────────────────────────
   *
   * This used to append a `div#outcrawl-marks` of outlines and badges to the
   * live document for the length of the screenshot. A vendor-named node in a
   * real site's DOM is a stealth failure whatever it looks like, so the page
   * is now only READ, and `./png-marks` paints the badges onto the bytes.
   *
   * ── Why the rects are resolved by XPATH and not by node id ──────────────
   *
   * A badge has to be positioned, which means a box, and a box per node means
   * a `DOM.getBoxModel` round trip per node — 60 to 80 of them on a Hacker
   * News comments page, inside a step budget measured in hundreds of
   * milliseconds. `AxNode.xpath` is already on every node, for the heal path,
   * so one `Runtime.evaluate` resolves them all with `document.evaluate` and
   * returns every rect in a single reply.
   *
   * ── Why an isolated world ───────────────────────────────────────────────
   *
   * `Page.createIsolatedWorld` shares the DOM and nothing else, so the page's
   * own script cannot see our helper, cannot trip over a variable of ours,
   * and a patched `document.evaluate` in the main world is never called.
   *
   * ── Why with the page LIVE ──────────────────────────────────────────────
   *
   * `PageSession.capture` enforces lock depth 0: measured 2026-09-07, a
   * capture under `Outcrawl.lock` of a page with a dirtied layer never
   * answers. With no overlay nothing is dirtied any more, but the seam's
   * contract is unchanged and this function is what it calls.
   */
  async function capture(): Promise<PageView> {
    const started = clock.now();
    const tree = filterTree(await snapshot());
    const candidates = walk(tree)
      .filter((node) => ACTIONABLE_ROLES.has(node.role) && node.xpath !== '')
      .map((node, index) => ({
        n: index + 1,
        xpath: node.xpath,
        ref: node.ref,
        role: node.role,
        ...(node.name === undefined ? {} : { name: node.name }),
      }));

    const frameTree = await page.send('Page.getFrameTree');
    const frame = frameTree['frameTree'];
    let frameId = '';
    if (typeof frame === 'object' && frame !== null && 'frame' in frame) {
      const inner = frame.frame;
      if (typeof inner === 'object' && inner !== null && 'id' in inner) {
        frameId = typeof inner.id === 'string' ? inner.id : '';
      }
    }
    if (frameId === '') {
      throw new TypeError('Page.getFrameTree returned no top frame id');
    }
    const world = await page.send('Page.createIsolatedWorld', {
      frameId,
      worldName: 'outcrawl-marks',
      grantUniveralAccess: false,
    });
    const contextId = world['executionContextId'];
    if (typeof contextId !== 'number') {
      throw new TypeError('Page.createIsolatedWorld returned no executionContextId');
    }

    const measured = await evaluateInWorld(
      contextId,
      `(${MEASURE_MARKS})(${JSON.stringify(candidates.map(({ n, xpath }) => ({ n, xpath })))})`,
    );

    const shot = await page.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    const captured = shot['data'];
    if (typeof captured !== 'string' || captured === '') {
      throw new TypeError('Page.captureScreenshot returned no data');
    }
    const raw = Buffer.from(captured, 'base64');
    if (raw.length < 24) {
      throw new TypeError('Page.captureScreenshot returned no PNG');
    }

    const byNumber = new Map(candidates.map((candidate) => [candidate.n, candidate]));
    const marks: Mark[] = [];
    let above = 0;
    let below = 0;
    for (const rect of measured.rects) {
      const candidate = byNumber.get(rect.n);
      if (candidate === undefined) continue;
      if (rect.where === 'above') {
        above += 1;
        continue;
      }
      if (rect.where === 'below') {
        below += 1;
        continue;
      }
      if (rect.where !== 'visible') continue;
      const box: MarkBox = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      marks.push({
        n: rect.n,
        ref: candidate.ref,
        role: candidate.role,
        ...(candidate.name === undefined ? {} : { name: candidate.name }),
        box,
      });
    }

    // Device pixels per CSS pixel, from the picture itself: the screenshot
    // covers `innerWidth` (scrollbar included), and falls back to the client
    // width when the page did not report one.
    const pixelWidth = raw.readUInt32BE(16);
    const cssWidth = measured.frameWidth > 0 ? measured.frameWidth : measured.geometry.viewport.width;
    // Secret and card fields painted out FIRST, so the badges drawn after stay
    // readable on top of the grey; withheld when one cannot be placed.
    const maskedBase64 = await maskedShot(
      captured,
      cssWidth > 0 ? { origin: { x: 0, y: 0 }, cssWidth } : undefined,
    );
    const masked = maskedBase64 === captured ? raw : Buffer.from(maskedBase64, 'base64');
    const painted =
      marks.length === 0 || cssWidth <= 0
        ? masked
        : paintMarks(
            masked,
            marks.map((mark) => ({ n: mark.n, ...mark.box })),
            pixelWidth / cssWidth,
          );

    return {
      image: { mediaType: 'image/png', base64: painted === masked ? maskedBase64 : painted.toString('base64') },
      marks,
      geometry: measured.geometry,
      offscreen: { above, below },
      captureMs: clock.now() - started,
      pixels: { width: painted.readUInt32BE(16), height: painted.readUInt32BE(20) },
    };
  }

  /** `Runtime.evaluate` in the marks world, with the reply shape checked. */
  async function evaluateInWorld(contextId: number, expression: string): Promise<DrawResult> {
    const reply = await page.send('Runtime.evaluate', {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: true,
    });
    if ('exceptionDetails' in reply) {
      throw new Error(`the marks overlay threw: ${JSON.stringify(reply['exceptionDetails'])}`);
    }
    const result = reply['result'];
    if (typeof result !== 'object' || result === null || !('value' in result)) {
      throw new TypeError('Runtime.evaluate returned no value for the marks overlay');
    }
    return drawResult(result.value);
  }

  async function lookShoot(ref?: NodeRef): Promise<LookShot> {
    const view = await viewport(page);
    let focus: HandsTarget | undefined;
    if (ref !== undefined) {
      const { page: session } = await sessionFor(ref);
      if (session !== page) {
        throw new Error(
          `[${formatNodeRef(ref)}] is inside an out-of-process frame, whose box is not in this ` +
            'viewport\'s coordinates. Ask without "ref" and name the element in the question.',
        );
      }
      const shown = onScreenPart(await boxOf(ref), view);
      if (shown.width < MIN_HITTABLE_PX || shown.height < MIN_HITTABLE_PX) {
        throw new Error(
          `[${formatNodeRef(ref)}] is not on screen, and a look never scrolls — scrolling is an input. ` +
            'Scroll it into view first, then look again.',
        );
      }
      focus = shown;
    }
    const pending = page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    // A reply that arrives after the deadline must not become an unhandled
    // rejection; the race below has already decided the look.
    pending.catch(() => undefined);
    const shot = await Promise.race([
      pending,
      clock.sleep(LOOK_CAPTURE_DEADLINE_MS).then((): never => {
        throw new Error(
          `the page produced no frame within ${String(LOOK_CAPTURE_DEADLINE_MS)} ms (a page frozen ` +
            'mid-paint produces none until it runs again). Look again on the next step.',
        );
      }),
    ]);
    const base64 = shot['data'];
    if (typeof base64 !== 'string' || base64 === '') {
      throw new TypeError('Page.captureScreenshot returned no data');
    }
    return {
      image: { mediaType: 'image/png', base64: await maskedShot(base64) },
      viewport: view,
      ...(focus === undefined ? {} : { focus }),
    };
  }

  /**
   * One element, photographed alone from the compositor's frame: the look
   * camera's discipline (no overlay, no scroll, no resize), clipped to the
   * element's on-screen box and upscaled so a small code image reaches the
   * vision model at a readable size. Never re-fetches the image: a captcha's
   * URL mints a new code on every request.
   *
   * TAKEN ONLY ONCE THE IMAGE HAS PAINTED. The tree settles without the
   * image (an `alt=""` image has no line in it), so the first read on a fresh
   * page can photograph an empty box. Production BU #10, 2026-10-02 16:53Z
   * (n=2 runs, 7 reads): every first read on a freshly loaded gate, taken
   * ~0.5 s after commit, returned the same "7482" while the replay shows
   * "Sa3x" painted 2 s later, and was refused (3 of 3); every read of a
   * refreshed image passed (4 of 4). So the clip is re-taken until two in a
   * row are identical and not near-empty. That an empty box is the cause is
   * inferred from those reads, not measured on the capture itself.
   */
  async function shootElement(ref: NodeRef): Promise<LookShot['image']> {
    let previous: string | undefined;
    for (let attempt = 0; ; attempt += 1) {
      const view = await viewport(page);
      const shown = onScreenPart(await boxOf(ref), view);
      if (shown.width < MIN_HITTABLE_PX || shown.height < MIN_HITTABLE_PX) {
        throw new Error('the code image is not on screen');
      }
      const scale = Math.min(4, Math.max(1, TEXT_CAPTCHA_CLIP_WIDTH_PX / shown.width));
      const pending = page.send('Page.captureScreenshot', {
        format: 'png',
        clip: { ...(await documentClip(page, shown)), scale },
        captureBeyondViewport: false,
      });
      pending.catch(() => undefined);
      const shot = await Promise.race([
        pending,
        clock.sleep(LOOK_CAPTURE_DEADLINE_MS).then((): never => {
          throw new Error(`the page produced no frame within ${String(LOOK_CAPTURE_DEADLINE_MS)} ms`);
        }),
      ]);
      const base64 = shot['data'];
      if (typeof base64 !== 'string' || base64 === '') {
        throw new TypeError('Page.captureScreenshot returned no data');
      }
      if (base64 === previous && base64.length >= TEXT_CAPTCHA_PAINTED_MIN_B64) {
        return { mediaType: 'image/png', base64: await maskedShot(base64, { origin: { x: shown.x, y: shown.y }, cssWidth: shown.width }) };
      }
      if (attempt + 1 >= TEXT_CAPTCHA_PAINT_READS) {
        throw new Error(`the code image had not finished painting after ${String(TEXT_CAPTCHA_PAINT_READS)} captures`);
      }
      previous = base64;
      await clock.sleep(TEXT_CAPTCHA_PAINT_POLL_MS);
    }
  }

  /**
   * The node the model is shown that is painted at `point`: the hit itself
   * when the tree has it, else its nearest ancestor that the tree has — a
   * `<span>` inside a `<button>` has no line of its own, the button does.
   *
   * Read against `filterTree(snapshot())`, the tree the model is shown with
   * the loop's default filter, so a reference handed back is one
   * `validateAction` will accept.
   *
   * A tree node is accepted only when its FRAME is served by `page`: the hit
   * test ran in `page`'s renderer, and backend ids are per renderer, so an
   * out-of-process frame's node with the same id — an ad or embed the run
   * never touched — is a different element (`CrossFrameRefError`'s collision)
   * and is passed over for the next ancestor instead.
   */
  async function lookLocate(point: ViewportPoint): Promise<LookLocation | undefined> {
    const hit = await hitAt(page, point);
    if (hit === undefined) {
      return undefined;
    }
    const shown = new Map<number, AxNode[]>();
    for (const node of walk(filterTree(await snapshot()))) {
      const same = shown.get(node.ref.backendNodeId);
      if (same === undefined) shown.set(node.ref.backendNodeId, [node]);
      else same.push(node);
    }
    const own = await sessionFrame();
    const served = new Map<number, boolean>();
    const pick = async (backendNodeId: number): Promise<AxNode | undefined> => {
      for (const node of shown.get(backendNodeId) ?? []) {
        const ordinal = node.ref.frameOrdinal;
        let here = ordinal === own ? true : served.get(ordinal);
        if (here === undefined) {
          try {
            here = (await sessionFor(node.ref)).page === page;
          } catch {
            here = false;
          }
          served.set(ordinal, here);
        }
        if (here) return node;
      }
      return undefined;
    };
    let found = await pick(hit.backendNodeId);
    if (found === undefined) {
      for (const ancestor of await ancestorsOf(page, hit.backendNodeId, hit.frameId)) {
        found = await pick(ancestor);
        if (found !== undefined) break;
      }
    }
    return found === undefined
      ? undefined
      : { ref: found.ref, role: found.role, ...(found.name === undefined ? {} : { name: found.name }) };
  }

  return { capture, lookShoot, shootElement, lookLocate };
}
