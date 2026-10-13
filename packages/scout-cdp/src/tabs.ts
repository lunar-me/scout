import type { NodeRef, TabId } from '@outcrawl/runtime';
import type { CdpPage } from './cdp';

export type MaybePromise<T> = T | Promise<T>;

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */

/** Why a tab stopped being usable. */
export type TabLossCause =
  /** `Target.targetCrashed`: the renderer died under us. */
  | 'crashed'
  /** `Target.targetDestroyed` for a tab nobody asked to close: the page closed itself. */
  | 'closed-by-page'
  /** This session closed it, or the context it lived in was disposed. */
  | 'closed';

/** One tab leaving, as {@link AgentTabs.onLost} reports it. */
export interface TabLoss {
  readonly id: TabId;
  /** The last URL this tab committed. The only thing left to identify it by. */
  readonly url: string;
  readonly cause: TabLossCause;
}

/**
 * One tab, as the agent binding needs it.
 *
 * Structural rather than `SessionTab` itself, for the reason
 * {@link LockReleaseSink} is: the binding needs a page, an id and a liveness
 * bit, and depending on the browser layer would make this module untestable
 * without a CDP connection behind it. `browser.ts`'s `SessionTab` satisfies it.
 */
export interface AgentTab {
  readonly id: TabId;
  readonly page: CdpPage;
  /** `gone` the moment the target crashed, closed itself, or was closed. */
  readonly state: 'live' | 'gone';
  url(): string;
  title(): string | undefined;
  /**
   * This tab's AX frame ordinal — the browser's `FrameTreeNodeId` for its main
   * frame, memoised.
   *
   * Only ever awaited on a failure path ({@link WrongTabRefError}), which is
   * why it is a promise rather than a field: resolving it eagerly would put an
   * `Outcrawl.getFrameOrdinal` round trip on every tab open, including on the
   * scrape and crawl paths that never mint a reference at all.
   */
  frameOrdinal(): Promise<number>;
}

/**
 * The tabs of one session, page-bearing.
 *
 * This — not `TabControl` — is what {@link AgentBindingOptions.tabs} carries,
 * and the difference is load-bearing. `TabControl` is what the *loop* sees:
 * ids in, ids out, no CDP. A binding that received only ids could not route a
 * `snapshot` or a `click` anywhere, because an id is not a session. So the
 * host passes the page-bearing surface and {@link agentDepsFor} derives the
 * loop's `TabControl` from it, which also means there is exactly one place
 * that knows how a tab id maps to a CDP session.
 */
export interface AgentTabs {
  /** The focused tab. Never a `gone` one: closing or losing the focus moves it. */
  active(): MaybePromise<AgentTab>;
  /** Every live tab, in open order. */
  list(): MaybePromise<readonly AgentTab[]>;
  /** Opens a tab in this session's context and focuses it. */
  open(url: string): Promise<AgentTab>;
  focus(id: TabId): Promise<AgentTab>;
  close(id: TabId): Promise<void>;
  /** Fires for a crash, a self-close and a close. Returns the unsubscribe. */
  onLost(handler: (loss: TabLoss) => void): () => void;
}

/**
 * A tab the session does not have, or does not have any more.
 *
 * Named separately from {@link TabLostError} because the two are different
 * mistakes: this one is a model naming a tab that never existed or has already
 * been closed, which is recoverable by listing tabs; that one is a tab dying
 * under a run that was using it.
 */
export class UnknownTabError extends Error {
  readonly tab: TabId;

  constructor(tab: TabId, known: readonly TabId[]) {
    super(
      `no tab ${JSON.stringify(tab)} in this session. Live tabs: ` +
        `${known.length === 0 ? '(none)' : known.map((id) => JSON.stringify(id)).join(', ')}. ` +
        'Tab ids are minted per session and never reused, so a closed tab does not come back ' +
        'under its old id.',
    );
    this.name = 'UnknownTabError';
    this.tab = tab;
  }
}

/**
 * The tab this call needed is gone.
 *
 * Thrown rather than silently refocusing, and that is the whole point. A
 * five-site task whose third tab crashed and which quietly carried on in the
 * second one produces a confident report about a site it never finished — a
 * wrong answer nobody can see. The loop is entitled to choose the next tab;
 * this binding is not entitled to choose it for the loop.
 */
export class TabLostError extends Error {
  readonly tab: TabId;
  readonly url: string;
  /**
   * Why the tab went.
   *
   * NOT called `cause`: `Error.cause` is the underlying error a failure was
   * chained from, and putting a string enum in it would both need an `override`
   * and quietly change what every reader of `error.cause` in this repo gets.
   */
  readonly lossCause: TabLossCause | 'unknown';

  constructor(tab: TabId, url: string, lossCause: TabLossCause | 'unknown') {
    super(
      `tab ${JSON.stringify(tab)} (${url === '' ? 'no url' : url}) is gone: ${lossCause}. ` +
        'It is not being replaced silently — focus another tab or close the goal that needed ' +
        'this one, because continuing on a different tab would answer for a page this run ' +
        'never finished.',
    );
    this.name = 'TabLostError';
    this.tab = tab;
    this.url = url;
    this.lossCause = lossCause;
  }
}

/**
 * A reference minted on one tab, used while another tab is focused.
 *
 * The refusal itself is {@link CrossFrameRefError}'s and needs no help: frame
 * ordinals are browser-global `FrameTreeNodeId`s, so tab A's nodes are simply
 * not in tab B's ordinal space. What needs help is the DIAGNOSIS. "node
 * 12045-9 belongs to frame 12045 but this session is attached to frame 30112"
 * reads as a stale reference, which is the one thing it is not — the reference
 * is perfectly good and is being used in the wrong place — and a run that
 * believes its references are going stale will re-snapshot forever instead of
 * focusing the tab it meant.
 *
 * So the router catches the frame refusal and re-throws it naming both tabs.
 * The ordinal lookup that identifies the owning tab happens here, on the
 * failure path only, which is why {@link AgentTab.frameOrdinal} is lazy.
 */
export class WrongTabRefError extends Error {
  readonly ref: NodeRef;
  readonly refTab: TabId | null;
  readonly activeTab: TabId;

  constructor(options: {
    readonly ref: NodeRef;
    readonly refTab: TabId | null;
    readonly refTabUrl: string | null;
    readonly activeTab: TabId;
    readonly activeTabUrl: string;
    readonly cause: unknown;
  }) {
    const owner =
      options.refTab === null
        ? 'no tab in this session'
        : `tab ${JSON.stringify(options.refTab)} (${options.refTabUrl ?? 'no url'})`;
    super(
      `node ${options.ref.frameOrdinal}-${options.ref.backendNodeId} was minted on ${owner}, ` +
        `but tab ${JSON.stringify(options.activeTab)} (${options.activeTabUrl}) is focused. ` +
        'This is NOT a stale reference: focus the owning tab and act again, or re-snapshot to ' +
        'get references for the tab that is focused now.',
      { cause: options.cause },
    );
    this.name = 'WrongTabRefError';
    this.ref = options.ref;
    this.refTab = options.refTab;
    this.activeTab = options.activeTab;
  }
}
