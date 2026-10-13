/**
 * WHAT THE BROWSER UNDER THE BINDING SPEAKS BEYOND STOCK CDP.
 *
 * The binding is written against the CDP every Chromium speaks, plus a short
 * list of things a browser may or may not offer: a filtered accessibility tree
 * keyed by frame-qualified references, the id of a session's own frame, a page
 * freeze the binding holds while it reads, input paths dispatched as one
 * gesture, and events for a held challenge and for network activity. A
 * `CdpFlavor` says how this browser does each of them.
 *
 * {@link outcrawlFlavor} is the Outcrawl browser's own `Outcrawl` domain;
 * `stockFlavor` (`./flavors/stock`) builds each of them from plain CDP, for
 * any Chrome or Chromium.
 */
import type { CdpPage } from './cdp';
import type { HandsStep } from './hands';

export interface CdpFlavor {
  /** A name for logs and errors. */
  readonly name: string;
  /**
   * The filtered accessibility tree, in the wire shape {@link axTreeFromCdp}
   * reads: `{url, root, frameOrdinals?}`, every node carrying a
   * `"<frameOrdinal>-<backendNodeId>"` reference.
   */
  axTree(session: CdpPage, params: { readonly maxNodes?: number }): Promise<Record<string, unknown>>;
  /** `{frameOrdinal, frameId}` of the frame `session` is attached to. */
  frameOrdinal(session: CdpPage): Promise<Record<string, unknown>>;
  /**
   * The page-freeze pair, by command name: the binding sends `lock` (with
   * `{timeoutMs}`) before it reads a page and `unlock` before it acts on it.
   * `null` when the browser has no freeze: the binding then sends neither, and
   * the page stays live between a read and the action on it.
   */
  readonly lock: string | null;
  readonly unlock: string | null;
  /**
   * The event the browser sends when it released a freeze itself, with
   * `{reason}`. `null` when the browser has no freeze to release.
   */
  readonly lockReleased: string | null;
  /** One planned input step (see {@link HandsStep}), sent to `session`. */
  dispatch(session: CdpPage, step: HandsStep): Promise<unknown>;
  /** The event the browser sends once per challenge hold it puts on the tab, or `null` when it sends none. */
  readonly challengeSolving: string | null;
  /**
   * Events that say the tab is receiving from the network. The settle reads
   * the last one's time; a browser that sends none makes the settle wait on a
   * still-parsing document no longer than its budget.
   */
  readonly networkEvents: readonly string[];
}

/**
 * The Outcrawl browser: the `Outcrawl` CDP domain.
 *
 * The network events are the session recording's: the browser sends them for
 * a recorded tab without the renderer's `Network` agent (which cost ~400 MB of
 * renderer memory when enabled). v2 streams each body in chunks of at most
 * 64 KiB as it arrives; v1 has request, response and failure rows. A tab that
 * is not recorded sends none.
 */
export const outcrawlFlavor: CdpFlavor = {
  name: 'outcrawl',
  axTree: (session, params) => session.send('Outcrawl.getAXTree', params),
  frameOrdinal: (session) => session.send('Outcrawl.getFrameOrdinal'),
  lock: 'Outcrawl.lock',
  unlock: 'Outcrawl.unlock',
  lockReleased: 'Outcrawl.lockReleased',
  dispatch: (session, step) => session.send(step.command, step.params),
  challengeSolving: 'Outcrawl.challengeSolving',
  networkEvents: [
    'Outcrawl.sessionNetwork',
    'Outcrawl.sessionNetworkRequest',
    'Outcrawl.sessionNetworkResponse',
    'Outcrawl.sessionNetworkBody',
    'Outcrawl.sessionNetworkFinished',
  ],
};
