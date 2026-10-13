/**
 * WHAT A HOST ADDS TO A BOUND PAGE.
 *
 * The binding drives a page on its own: it reads the tree, aims and dispatches
 * input, navigates, photographs. A host that runs pages for others adds
 * behaviour around that: it moves a run to another network when a site
 * refuses the one it is on, solves checks a site puts in front of a page,
 * films the session, and keeps secrets out of everything a model sees. Each of
 * those is a hook here.
 *
 * Every hook is optional, and an absent hook is the portable behaviour: no
 * route changes, no solving, no recording, nothing masked.
 */
import type { Clock } from '@outcrawl/scout-core';
import type {
  AxTree,
  ChallengeResolution,
  ChallengeSolving,
  NodeRef,
  SiteCheckResult,
  SiteCheckSighting,
  TextCaptchaSighting,
  ToolPort,
} from '@outcrawl/runtime';

import type { CdpPage } from './cdp';
import type { HandsContext, HandsPort, HandsStep } from './hands';

export interface BindingHooks {
  /** Built once per tab, when the tab's binding is: the hooks that ride one page. */
  tab?(tab: BoundTab): TabHooks;
  /** A challenge the browser holds a page for, answered by the host (`AgentDeps.solveChallenge`). */
  readonly solveChallenge?: (challenge: ChallengeSolving) => Promise<ChallengeResolution>;
  /** Wraps the run's composed tool port, e.g. to scrub what a tool answered. */
  tools?(port: ToolPort): ToolPort;
  /** The error a step gets when the binding was given no model. */
  modelUnavailable?(attempted: 'model' | 'extract'): Error;
}

/** The hooks of one tab. */
export interface TabHooks {
  readonly exits?: TabExits;
  readonly captcha?: TabCaptcha;
  readonly recording?: TabRecording;
  readonly masking?: TabMasking;
}

/**
 * One bound tab, as a hook may use it. Readers of the binding's own state
 * (`parsingSince`, `challengeAt`) are functions: they answer at the moment of
 * the call.
 */
export interface BoundTab {
  readonly page: CdpPage;
  readonly clock: Clock;
  /** When the main frame's current document committed, while its `DOMContentLoaded` has not fired. */
  parsingSince(): number | undefined;
  /** When the browser last held this tab for a challenge, on the binding's clock. */
  challengeAt(): number | undefined;
  /** One navigation of this tab, waited for to its commit, with this tab's exit hooks applied. */
  load(target: string, load: LoadRequest): Promise<LoadResult>;
  /** The layout viewport of `target`, CSS px. */
  viewport(target: CdpPage): Promise<{ readonly width: number; readonly height: number }>;
  /** `box` (viewport CSS px of `target`) in document coordinates, for a clipped screenshot. */
  documentClip<T extends { readonly x: number; readonly y: number }>(target: CdpPage, box: T): Promise<T>;
  /** What the input planner needs about `target`'s page: its viewport and where the pointer is. */
  contextFor(view: { readonly width: number; readonly height: number }, target: CdpPage): HandsContext;
  /** One planned input step to `target`, resent while the browser says it reached no renderer. */
  forward(step: HandsStep, target: CdpPage): Promise<void>;
  /** Where the last dispatched path left the pointer, per session. */
  readonly pointers: WeakMap<CdpPage, { readonly x: number; readonly y: number }>;
  /** The out-of-process frames this tab has confirmed, by frame ordinal. */
  framePages(): ReadonlyMap<number, CdpPage>;
  /** The url a confirmed frame was attached at. */
  frameUrl(frame: CdpPage): string | undefined;
  /** This tab's own frame ordinal. */
  sessionFrame(): Promise<number>;
}

/** One navigation, as {@link BoundTab.load} takes it. */
export interface LoadRequest {
  readonly method: AgentNavigateObservation['method'];
  /** Names the load in a failure: `navigate(<url>)`, `reload of <url>`. */
  readonly verb: string;
  /** Where a moved run resumes when this load fails; the target unless given. */
  readonly resumeAt?: string;
  /** The most this load may wait for its commit: what a cap left it. */
  readonly ceilingMs?: number;
}

/** Where a load committed (`undefined`: nothing did), and the status its document carried when a hook saw it. */
export interface LoadResult {
  readonly url: string | undefined;
  readonly status: number | null;
}

/** One agent `navigate`, as {@link TabExits.navigated} is told it. */
export interface AgentNavigateObservation {
  readonly url: string;
  /**
   * `navigate`, the model's; `reload`, a reload key performed as a navigate to
   * the document's url; `warm`, the site's origin loaded by an exit hook before
   * a cold navigate's one retry.
   */
  readonly method: 'navigate' | 'reload' | 'warm';
  readonly status: number | null;
  readonly commitMs: number | null;
  /** `committed`; `no-commit` (the commit budget ran out); `refused` (the network wrote the answer); `failed` (the browser reported an error). */
  readonly outcome: 'committed' | 'no-commit' | 'refused' | 'failed';
  /**
   * Present, `true`, on a `no-commit` whose wait a run's cap cut short: not a
   * route that never committed.
   */
  readonly cutByCap?: true;
  /**
   * For a `failed` navigate whose `Page.navigate` the browser never answered:
   * what the exit hook's liveness probe said (`dead`, `alive`), or absent when
   * none ran. See {@link TabExits.alive}.
   */
  readonly exitProbe?: 'dead' | 'alive';
  /** The browser's `net::ERR_*` code for a `failed` navigate, else `null`. Never the message, which names the URL. */
  readonly netError: string | null;
  /** For a commit that is the browser's error page: what the request failed of (`Network.ErrorReason`, `'Failed'`…), else `null`. */
  readonly errorPage: string | null;
}

/**
 * What the network under a tab answered for its main-frame documents: a
 * refusal it wrote in the site's place, a tunnel it could not open, the status
 * a response carried.
 */
export interface ResponseWatch {
  /** Settles once the watch sees responses; awaited before every load. */
  readonly ready: Promise<void>;
  /** The refusal the network wrote as the committed document, if it was one. */
  answerFor(commit: Record<string, unknown>, type: unknown): Error | undefined;
  /** The network's refusal of a tunnel to `url`, if it refused one. */
  tunnelFor(url: string): Error | undefined;
  /** The status the committed document's response carried. */
  statusFor(commit: Record<string, unknown>): number | undefined;
  /** What a request for `url` failed of, when it failed. */
  failureFor(url: string): string | undefined;
}

/** A load whose `Page.navigate` the browser answered with an error. */
export interface FailedLoad {
  readonly target: string;
  readonly resumeAt: string;
  readonly verb: string;
  readonly errorText: string;
  readonly netError: string | null;
  readonly exitProbe: 'dead' | 'alive' | undefined;
}

/** A load that ended without an error: where it committed and what its error page failed of. */
export interface SettledLoad {
  readonly resumeAt: string;
  readonly committed: string | undefined;
  /** `undefined`: no error page; `null`: an error page whose cause was unseen. */
  readonly failure: string | null | undefined;
}

/** A model `navigate` that loaded, as {@link TabExits.landed} judges it. */
export interface LandedLoad {
  readonly target: string;
  readonly first: LoadResult;
  /** What the step may still spend, ms, when the run is capped. */
  readonly allowanceMs: number | undefined;
  /** When the step started, on the binding's clock. */
  readonly enteredAt: number;
  /** The model had filled or selected on the document it navigated away from. */
  readonly midForm: boolean;
}

/** EXITS: the network a run rides, and moving off it. */
export interface TabExits {
  /** The tab's response watch. */
  readonly watch?: ResponseWatch;
  /** Refuses a destination before it is loaded. */
  refusal?(target: string, resumeAt: string): Error | undefined;
  /** Whether the route still answers, asked once when `Page.navigate` went unanswered. */
  alive?(): Promise<boolean | undefined>;
  /** Told every load, once it ended. */
  navigated?(observation: AgentNavigateObservation): void;
  /** The error a failed load throws; `undefined` for the binding's own. May throw instead. */
  failed?(load: FailedLoad): Promise<Error | undefined>;
  /** The error a load that ended throws instead of returning (a move to another route). */
  settled?(load: SettledLoad): Error | undefined;
  /** Judges a model navigate that loaded; may load again (and answers what it loaded) or throw a move. */
  landed?(load: LandedLoad): Promise<LoadResult | undefined>;
  /** Before every action. May throw a move for what the tab already shows. */
  beforeAction?(): Promise<void>;
}

/** CAPTCHA: checks a host knows how to work. */
export interface TabCaptcha {
  /** A text code image in the tab's tree, for the look model to read. */
  findTextCaptcha?(tree: AxTree): Promise<TextCaptchaSighting | undefined>;
  /** The site-check tool (`page.verify`) and the sighting the loop runs before reads. */
  readonly siteCheck?: {
    solve(hands: HandsPort): Promise<SiteCheckResult>;
    sight(): Promise<SiteCheckSighting | undefined>;
  };
}

/** RECORDING: a host filming the session. */
export interface TabRecording {
  /** The binding took (`true`) or is about to release (`false`) the tab's freeze. */
  held?(held: boolean): void;
}

/** Where a clipped shot sits: its top-left in viewport CSS px, and its CSS width. */
export interface ShotRegion {
  readonly origin: { readonly x: number; readonly y: number };
  readonly cssWidth: number;
}

/** MASKING: what a model must never see. */
export interface TabMasking {
  /** A PNG of the tab as a model may see it; may throw to withhold it. `sweep: false` is the cheap pass. */
  shot?(base64: string, region: ShotRegion | undefined, sweep: boolean): Promise<string>;
  /** The tree as a model may see it. */
  tree?(tree: AxTree): AxTree | Promise<AxTree>;
  /** Text as a model may see it. */
  conceal?(text: string): string;
  /** Whether `text` names a secret the host reveals. */
  names?(text: string): boolean;
  /** `written` with every secret it names revealed, for the field at `ref`. */
  reveal?(written: string, ref: NodeRef): Promise<string>;
  /** A field now holds a revealed secret. */
  concealed?(owner: CdpPage, backendNodeId: number): void;
  /** Whether the field holds what was written, compared without exposing a secret. */
  compareWritten?(ref: NodeRef, written: string, compare: (typed: string) => Promise<boolean>): Promise<boolean | undefined>;
}
