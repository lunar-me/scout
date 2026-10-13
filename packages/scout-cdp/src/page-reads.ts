/**
 * Reads of one CDP session that need nothing but the session: its viewport,
 * a box in document coordinates, how far it can scroll, the part of a box on
 * screen, the DevTools hit test, and the isolated-world reads of an element.
 * None of them dispatches an event or runs script in the page's own world.
 */
import type { NodeRef, ViewportPoint } from '@outcrawl/runtime';

import type { CdpPage } from './cdp';
import type { HandsTarget } from './hands';
import { clientViewportOf } from './input';
import { LOOK_ANCESTOR_LIMIT, LOOK_OBJECT_GROUP, LOOK_WORLD } from './look';
import { MAX_REACH_GESTURE_PX, MAX_REACH_TOTAL_PX, PAINTED_DESCENDANT_DEPTH, type DescribedElement } from './reach';

/**
 * `Page.getLayoutMetrics`'s client viewport, on `target` — the SAME session
 * `boxOf` reads the box on, never `page` unconditionally. An out-of-process
 * iframe's own viewport is what its `DOM.getBoxModel` box is relative to
 * (see `dispatchGesture`'s coordinate-space note), so comparing that box
 * against the MAIN page's viewport size would compare two unrelated rulers.
 */
export async function viewport(
  target: CdpPage,
): Promise<{ readonly width: number; readonly height: number }> {
  return clientViewportOf(await target.send('Page.getLayoutMetrics'));
}

/**
 * The `Page.captureScreenshot` clip that photographs `box`, a rect in
 * `target`'s viewport CSS px (what `getBoundingClientRect` and
 * `DOM.getBoxModel` answer). The clip is in DOCUMENT coordinates, so the
 * scroll offset is added, as Playwright's own screenshot does and as
 * {@link hitAt} does for the hit test (the layout viewport's `pageX/pageY`;
 * the visual viewport's differs only under a pinch zoom, which nothing here
 * makes). Without it every photograph on a page scrolled by S px is of what
 * lies S px above the box: fleet `/connect` 2026-10-06 19:27Z (sxs-1),
 * Shein's check on a page scrolled 44.5 px, the "hint strip" photograph held
 * the instruction text and page.verify read "4 of 8 icons" on every picture,
 * the same shape as Stealth Bench `sess_2f70c9f1`'s "4 of 7" (that run's
 * scroll offset was not recorded).
 */
export async function documentClip<T extends { readonly x: number; readonly y: number }>(target: CdpPage, box: T): Promise<T> {
  const css = (await target.send('Page.getLayoutMetrics'))['cssLayoutViewport'];
  const pageX = typeof css === 'object' && css !== null && 'pageX' in css ? css.pageX : undefined;
  const pageY = typeof css === 'object' && css !== null && 'pageY' in css ? css.pageY : undefined;
  if (typeof pageX !== 'number' || typeof pageY !== 'number') {
    throw new TypeError('Page.getLayoutMetrics cssLayoutViewport has no numeric pageX/pageY');
  }
  return { ...box, x: box.x + pageX, y: box.y + pageY };
}

/**
 * A scroll request bounded to what the wheel can deliver, as `[dx, dy]`.
 *
 * Within one gesture ({@link MAX_REACH_GESTURE_PX}) it is returned as asked.
 * Past that, on the document (`target` given): back up or left by no more
 * than the scroll offset, since nothing is above the top; down or right by
 * no more than the room left, or one gesture, whichever is more, since a
 * feed grows under the wheel. Everything is held to
 * {@link MAX_REACH_TOTAL_PX}, the most one step scrolls. A layout reply
 * without the sizes leaves only that ceiling.
 */
export async function reachable(dx: number, dy: number, target: CdpPage | undefined): Promise<readonly [number, number]> {
  if (Math.max(Math.abs(dx), Math.abs(dy)) <= MAX_REACH_GESTURE_PX) {
    return [dx, dy];
  }
  const metrics = target === undefined ? undefined : await target.send('Page.getLayoutMetrics');
  const css = metrics?.['cssLayoutViewport'];
  const content = metrics?.['cssContentSize'];
  const field = (from: unknown, key: string): number | undefined => {
    const value = typeof from === 'object' && from !== null ? (from as Record<string, unknown>)[key] : undefined;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  const axis = (delta: number, offset: number | undefined, client: number | undefined, size: number | undefined): number => {
    const asked = Math.min(Math.abs(delta), MAX_REACH_TOTAL_PX);
    if (offset === undefined || client === undefined || size === undefined) {
      return Math.sign(delta) * asked;
    }
    const room = delta < 0 ? offset : Math.max(MAX_REACH_GESTURE_PX, size - offset - client);
    return Math.sign(delta) * Math.min(asked, Math.max(0, room));
  };
  return [
    axis(dx, field(css, 'pageX'), field(css, 'clientWidth'), field(content, 'width')),
    axis(dy, field(css, 'pageY'), field(css, 'clientHeight'), field(content, 'height')),
  ];
}

/**
 * The part of a box that is actually on screen.
 *
 * The aim is taken against THIS and never against the raw box, and that is
 * the difference between a click and a click into space.
 * `AgentHandsPort.#landing` picks a point anywhere inside the rect it is
 * given (clamped one pixel inside the edge, deliberately never the centre),
 * so handing it a rect that straddles the fold produces a landing point
 * below the fold for a target that is half visible — the same defect,
 * smaller. Intersecting first makes every landing point on-screen by
 * construction, for a tall element too: an article-length link cannot be
 * "fully in view" at any scroll offset, and clicking the part of it that is
 * showing is exactly what a person does.
 */
export function onScreenPart(
  box: HandsTarget,
  view: { readonly width: number; readonly height: number },
): HandsTarget {
  const left = Math.max(box.x, 0);
  const top = Math.max(box.y, 0);
  const right = Math.min(box.x + box.width, view.width);
  const bottom = Math.min(box.y + box.height, view.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The element `target`'s renderer paints at a VIEWPORT point, or
 * `undefined` when there is none. A DevTools hit test: no event is
 * dispatched and the page runs nothing.
 *
 * `DOM.getNodeForLocation` takes DOCUMENT coordinates — Chromium's
 * `InspectorDOMAgent::getNodeForLocation` runs the point through
 * `DocumentToFrame`, which subtracts the scroll offset, and DevTools' own
 * screencast adds `scrollOffsetX/Y` before calling it — so the layout
 * viewport's `pageX/pageY` is added here. Without it, a point on a page
 * scrolled by S px is hit-tested S px higher than the one it names.
 */
export async function hitAt(
  target: CdpPage,
  point: ViewportPoint,
): Promise<{ readonly backendNodeId: number; readonly frameId: string } | undefined> {
  const metrics = await target.send('Page.getLayoutMetrics');
  const css = metrics['cssLayoutViewport'];
  const pageX = typeof css === 'object' && css !== null && 'pageX' in css ? css.pageX : undefined;
  const pageY = typeof css === 'object' && css !== null && 'pageY' in css ? css.pageY : undefined;
  if (typeof pageX !== 'number' || typeof pageY !== 'number') {
    throw new TypeError('Page.getLayoutMetrics cssLayoutViewport has no numeric pageX/pageY');
  }
  const hit = await target.send('DOM.getNodeForLocation', {
    x: Math.round(point.x + pageX),
    y: Math.round(point.y + pageY),
    includeUserAgentShadowDOM: false,
    ignorePointerEventsNone: false,
  });
  const backendNodeId = hit['backendNodeId'];
  const frameId = hit['frameId'];
  return typeof backendNodeId === 'number' && typeof frameId === 'string' ? { backendNodeId, frameId } : undefined;
}

/**
 * `declaration` called on `backendNodeId` in an isolated world of `frameId`,
 * with the elements `args` name as its arguments. `value` returns what it
 * returned BY VALUE; `node` returns the backend id of the element it
 * returned. `undefined` when a node does not resolve in that world (another
 * frame's, or one the document has dropped), the function threw, or it
 * returned nothing of that kind. The same world `ancestorsOf` reads in: the
 * page's own script sees none of it.
 */
export async function inLookWorld(
  session: CdpPage,
  frameId: string,
  call: {
    readonly on: number;
    readonly declaration: string;
    readonly args?: readonly number[];
    readonly returns: 'value' | 'node';
  },
): Promise<unknown> {
  const world = await session.send('Page.createIsolatedWorld', {
    frameId,
    worldName: LOOK_WORLD,
    grantUniveralAccess: false,
  });
  const executionContextId = world['executionContextId'];
  if (typeof executionContextId !== 'number') return undefined;
  const objectIdOf = (object: unknown): string | undefined =>
    typeof object === 'object' && object !== null && 'objectId' in object && typeof object.objectId === 'string'
      ? object.objectId
      : undefined;
  try {
    const objectIds: string[] = [];
    for (const id of [call.on, ...(call.args ?? [])]) {
      const resolved = await session.send('DOM.resolveNode', {
        backendNodeId: id,
        executionContextId,
        objectGroup: LOOK_OBJECT_GROUP,
      });
      const objectId = objectIdOf(resolved['object']);
      if (objectId === undefined) return undefined;
      objectIds.push(objectId);
    }
    const [self, ...rest] = objectIds;
    const called = await session.send('Runtime.callFunctionOn', {
      objectId: self,
      objectGroup: LOOK_OBJECT_GROUP,
      returnByValue: call.returns === 'value',
      functionDeclaration: call.declaration,
      arguments: rest.map((objectId) => ({ objectId })),
    });
    if (called['exceptionDetails'] !== undefined) return undefined;
    const result = called['result'];
    if (call.returns === 'value') {
      return typeof result === 'object' && result !== null && 'value' in result ? result.value : undefined;
    }
    const objectId = objectIdOf(result);
    if (objectId === undefined) return undefined;
    const node = (await session.send('DOM.describeNode', { objectId }))['node'];
    return typeof node === 'object' && node !== null && 'backendNodeId' in node && typeof node.backendNodeId === 'number'
      ? node.backendNodeId
      : undefined;
  } finally {
    await session.send('Runtime.releaseObjectGroup', { objectGroup: LOOK_OBJECT_GROUP }).catch(() => undefined);
  }
}

/** One element's tag and attributes, read with `DOM.describeNode`. */
export async function elementOf(session: CdpPage, backendNodeId: number): Promise<DescribedElement | undefined> {
  const described = await session.send('DOM.describeNode', { backendNodeId });
  const node = described['node'];
  if (typeof node !== 'object' || node === null) return undefined;
  const tag = 'localName' in node && typeof node.localName === 'string' ? node.localName : '';
  const list = 'attributes' in node && Array.isArray(node.attributes) ? (node.attributes as unknown[]) : [];
  const attributes = new Map<string, string>();
  for (let at = 0; at + 1 < list.length; at += 2) {
    const key = list[at];
    const value = list[at + 1];
    if (typeof key === 'string' && typeof value === 'string') attributes.set(key, value);
  }
  return { tag, attribute: (key) => attributes.get(key) };
}

/**
 * Up to {@link LOOK_ANCESTOR_LIMIT} ancestors' backend ids, nearest first,
 * read in an isolated world on `target` — the renderer the node lives in.
 */
export async function ancestorsOf(target: CdpPage, backendNodeId: number, frameId: string): Promise<readonly number[]> {
  const world = await target.send('Page.createIsolatedWorld', {
    frameId,
    worldName: LOOK_WORLD,
    grantUniveralAccess: false,
  });
  const executionContextId = world['executionContextId'];
  if (typeof executionContextId !== 'number') return [];
  try {
    const resolved = await target.send('DOM.resolveNode', {
      backendNodeId,
      executionContextId,
      objectGroup: LOOK_OBJECT_GROUP,
    });
    const object = resolved['object'];
    const objectId =
      typeof object === 'object' && object !== null && 'objectId' in object ? object.objectId : undefined;
    if (typeof objectId !== 'string') return [];
    const chain = await target.send('Runtime.callFunctionOn', {
      objectId,
      objectGroup: LOOK_OBJECT_GROUP,
      returnByValue: false,
      functionDeclaration: `function () {
        var out = [];
        for (var el = this.parentElement; el !== null && out.length < ${String(LOOK_ANCESTOR_LIMIT)}; el = el.parentElement) out.push(el);
        return out;
      }`,
    });
    const array = chain['result'];
    const arrayId =
      typeof array === 'object' && array !== null && 'objectId' in array ? array.objectId : undefined;
    if (typeof arrayId !== 'string') return [];
    const properties = await target.send('Runtime.getProperties', { objectId: arrayId, ownProperties: true });
    const listed = properties['result'];
    const elements: { index: number; objectId: string }[] = [];
    for (const property of Array.isArray(listed) ? (listed as unknown[]) : []) {
      if (typeof property !== 'object' || property === null) continue;
      const { name, value } = property as { name?: unknown; value?: unknown };
      const id =
        typeof value === 'object' && value !== null && 'objectId' in value ? value.objectId : undefined;
      if (typeof name === 'string' && /^\d+$/.test(name) && typeof id === 'string') {
        elements.push({ index: Number(name), objectId: id });
      }
    }
    elements.sort((a, b) => a.index - b.index);
    const ids: number[] = [];
    for (const element of elements) {
      const described = await target.send('DOM.describeNode', { objectId: element.objectId });
      const node = described['node'];
      if (typeof node === 'object' && node !== null && 'backendNodeId' in node && typeof node.backendNodeId === 'number') {
        ids.push(node.backendNodeId);
      }
    }
    return ids;
  } finally {
    await target.send('Runtime.releaseObjectGroup', { objectGroup: LOOK_OBJECT_GROUP }).catch(() => undefined);
  }
}

/**
 * The pseudo-elements that are only paint of the element they belong to. An
 * event on one goes to that element and does nothing of its own. Every other
 * kind `DOM.describeNode` lists has a press behaviour of its own (`::backdrop`
 * light-dismisses a dialog, `::scroll-button(*)` scrolls a carousel,
 * `::scroll-marker` jumps it, `::interest-button` shows an interest target),
 * so a press that the hit test puts on one of those is on a cover.
 */
export const OWN_PAINT_PSEUDOS: Readonly<Record<string, true>> = { before: true, after: true, marker: true };

/**
 * Every node id inside `ref`, to {@link PAINTED_DESCENDANT_DEPTH} levels, WITH
 * their {@link OWN_PAINT_PSEUDOS}. One read. A pseudo-element is hit-tested as
 * itself but an event on it goes to the element it belongs to, and the
 * stretched-link pattern draws one over a whole card: MEASURED on the fleet
 * 2026-09-26 (`/connect`, n=1), every hit test on Coursera's search card
 * title named the link's own `::before` (`content: ''; position: absolute;
 * inset: 0`), listed in the link's `pseudoElements`, and without them here
 * every click on the card was refused as covered (`run_4b65fe9b`).
 */
export async function descendantsOf(session: CdpPage, ref: NodeRef): Promise<ReadonlySet<number>> {
  const ids = new Set<number>();
  const described = await session.send('DOM.describeNode', {
    backendNodeId: ref.backendNodeId,
    depth: PAINTED_DESCENDANT_DEPTH,
  });
  const queue: unknown[] = [described['node']];
  while (queue.length > 0) {
    const node = queue.pop();
    if (typeof node !== 'object' || node === null) continue;
    if ('backendNodeId' in node && typeof node.backendNodeId === 'number') ids.add(node.backendNodeId);
    if ('children' in node && Array.isArray(node.children)) queue.push(...(node.children as unknown[]));
    if ('pseudoElements' in node && Array.isArray(node.pseudoElements)) {
      for (const pseudo of node.pseudoElements as unknown[]) {
        if (
          typeof pseudo === 'object' &&
          pseudo !== null &&
          'pseudoType' in pseudo &&
          typeof pseudo.pseudoType === 'string' &&
          OWN_PAINT_PSEUDOS[pseudo.pseudoType] === true
        ) {
          queue.push(pseudo);
        }
      }
    }
  }
  return ids;
}
