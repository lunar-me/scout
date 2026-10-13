/**
 * `stockFlavor`: the binding on any Chrome or Chromium, over plain CDP.
 *
 * Every member of {@link CdpFlavor} is built from domains every Chromium
 * speaks, and nothing in this file sends a command outside them:
 *
 *   * THE TREE is `Accessibility.getFullAXTree` per frame, filtered into the
 *     wire shape {@link axTreeFromCdp} reads; see `./stock-ax`.
 *   * THE FRAME ORDINAL comes from `Page.getFrameTree`: the session's root
 *     frame, numbered by `frameOrdinalOf`.
 *   * A POINTER PATH is one `Input.dispatchMouseEvent` `mouseMoved` per
 *     sample, sent at the sample's planned offset, with the held buttons on
 *     every move of a drag. A WHEEL PATH is one `mouseWheel` per sample.
 *     Presses, releases and keys are stock commands already and go out as
 *     planned.
 *
 * WHAT STOCK CDP CANNOT DO, and how the binding behaves without it:
 *
 *   * NO FREEZE. `lock` and `unlock` are `null`, so the binding sends neither
 *     and the page runs between the read the model saw and the action on it:
 *     timers fire, animations move, content can re-render. A reference still
 *     names the DOM node it named (a `backendNodeId` lives as long as its
 *     node), and every action measures the node's box and hit-tests it at the
 *     moment it acts, so a click lands on the node referenced or is refused
 *     as covered or gone. What is lost is the guarantee that the node still
 *     SHOWS what the model read: a list that recycles its rows, or a page that
 *     replaces the node, can move under a reference while the model thinks.
 *   * NO RELEASE OR CHALLENGE EVENTS: `lockReleased` and `challengeSolving`
 *     are `null`. There is no freeze to lose, and no browser-side challenge
 *     hold to wait out.
 *   * NETWORK EVENTS ONLY IF THE HOST ENABLED THE `Network` DOMAIN on the
 *     session. The binding never enables it (it costs renderer memory); when
 *     it is on, its events tell the settle a still-parsing document is
 *     receiving, and when it is off the settle waits no longer than its
 *     budget.
 *   * INPUT TIMING IS HOST-SIDE. The fork queues a whole path in the browser;
 *     here each sample is its own command, so a slow connection delays the
 *     samples behind it rather than the path arriving whole. Wheel phases and
 *     momentum have no stock field and are not sent.
 */
import { systemClock, type Clock } from '@outcrawl/scout-core';

import type { CdpPage } from '../cdp';
import type { CdpFlavor } from '../flavor';
import type { MouseButtonParams, PointerPathParams, WheelPathParams } from '../hands';
import { frameOrdinalOf, framesOf, stockAxTree } from './stock-ax';

/** `Input.dispatchMouseEvent`'s `buttons` bitmask, read the way the fork reads it: the lowest held button. */
function buttonOf(buttons: number): MouseButtonParams['button'] | 'none' {
  if (buttons & 1) return 'left';
  if (buttons & 2) return 'right';
  if (buttons & 4) return 'middle';
  if (buttons & 8) return 'back';
  if (buttons & 16) return 'forward';
  return 'none';
}

/**
 * Sends each sample at its offset from the first, on `clock`. A sample whose
 * moment has passed (the previous reply was slow) goes at once; the order is
 * never changed.
 */
async function paced<T extends { readonly offsetMs: number }>(
  path: readonly T[],
  clock: Clock,
  send: (sample: T) => Promise<unknown> | undefined,
): Promise<void> {
  const start = clock.now();
  const first = path[0]?.offsetMs ?? 0;
  for (const sample of path) {
    const wait = start + (sample.offsetMs - first) - clock.now();
    if (wait > 0) await clock.sleep(wait);
    await send(sample);
  }
}

function pointerPath(session: CdpPage, params: PointerPathParams, clock: Clock): Promise<void> {
  const buttons = params.buttons ?? 0;
  const button = buttonOf(buttons);
  const pointerType = params.pointerType ?? 'mouse';
  return paced(params.path, clock, (sample) =>
    session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: sample.x,
      y: sample.y,
      button,
      buttons,
      pointerType,
      // A held button with no pressure reads 0.5, what real hardware reports
      // while pressed; `Input.dispatchMouseEvent` would otherwise send 0.
      ...(sample.pressure !== undefined ? { force: sample.pressure } : buttons !== 0 ? { force: 0.5 } : {}),
    }),
  );
}

function wheelPath(session: CdpPage, params: WheelPathParams, clock: Clock): Promise<void> {
  return paced(params.path, clock, (sample) => {
    const deltaX = sample.deltaX ?? 0;
    const deltaY = sample.deltaY ?? 0;
    // A phase-only sample (the gesture's begin or end) moves nothing, and
    // stock CDP has no phase to carry.
    if (deltaX === 0 && deltaY === 0) return undefined;
    return session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: params.x,
      y: params.y,
      deltaX,
      deltaY,
      modifiers: params.modifiers ?? 0,
      pointerType: 'mouse',
    });
  });
}

export interface StockFlavorOptions {
  /** The clock input paths are paced on. Absent: real time. */
  readonly clock?: Clock;
}

/** A stock flavor pacing its input paths on `options.clock`. {@link stockFlavor} is the real-time one. */
export function createStockFlavor(options: StockFlavorOptions = {}): CdpFlavor {
  const clock = options.clock ?? systemClock;
  return {
    name: 'stock',
    axTree: stockAxTree,
    async frameOrdinal(session) {
      const frame = framesOf(await session.send('Page.getFrameTree'))[0];
      if (frame === undefined) throw new Error('Page.getFrameTree returned no frame for this session');
      return {
        frameOrdinal: frameOrdinalOf(frame.id),
        frameId: frame.id,
        ...(frame.parentId === undefined ? {} : { parentFrameOrdinal: frameOrdinalOf(frame.parentId) }),
      };
    },
    lock: null,
    unlock: null,
    lockReleased: null,
    async dispatch(session, step) {
      switch (step.command) {
        case 'Outcrawl.dispatchPointerPath':
          return pointerPath(session, step.params, clock);
        case 'Outcrawl.dispatchWheelPath':
          return wheelPath(session, step.params, clock);
        case 'Input.dispatchMouseEvent':
        case 'Input.dispatchKeyEvent':
          return session.send(step.command, step.params);
      }
    },
    challengeSolving: null,
    networkEvents: [
      'Network.requestWillBeSent',
      'Network.responseReceived',
      'Network.dataReceived',
      'Network.loadingFinished',
      'Network.loadingFailed',
    ],
  };
}

/** The binding on any Chrome or Chromium, over plain CDP. */
export const stockFlavor: CdpFlavor = createStockFlavor();
