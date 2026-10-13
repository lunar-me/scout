/**
 * `@outcrawl/scout-cdp`: the browser binding of the Scout agent.
 *
 * {@link bindAgent} binds the agent loop's `AgentDeps` to a page (or a set of
 * tabs) over CDP. What the browser speaks beyond stock CDP is its
 * {@link CdpFlavor}; what a host adds around a page is its {@link BindingHooks}.
 */
export { bindAgent } from './bind';
export { boxFrom } from './page-binding';
export type { BindingOptions } from './options';
export { isCdpTimeout, type CdpPage } from './cdp';
export { outcrawlFlavor, type CdpFlavor } from './flavor';
export { createStockFlavor, stockFlavor, type StockFlavorOptions } from './flavors/stock';
export type {
  AgentNavigateObservation,
  BindingHooks,
  BoundTab,
  FailedLoad,
  LandedLoad,
  LoadRequest,
  LoadResult,
  ResponseWatch,
  SettledLoad,
  ShotRegion,
  TabCaptcha,
  TabExits,
  TabHooks,
  TabMasking,
  TabRecording,
} from './hooks';
export type { FilePort } from './files';
export {
  CoveredTargetError,
  CrossFrameRefError,
  DisabledTargetError,
  FilesUnavailableError,
  HandsUnavailableError,
  NativeSelectPopupError,
  NoModelError,
  OffScreenTargetError,
  PointerAimRefusedError,
  UnmeasurableTargetError,
  UnperformableActionError,
  type CoverAccount,
  type ShownNode,
} from './errors';
export { FreezeNotAnsweredError, StillLoadingError } from './freeze';
export {
  TabLostError,
  UnknownTabError,
  WrongTabRefError,
  type AgentTab,
  type AgentTabs,
  type TabLoss,
  type TabLossCause,
} from './tabs';
export { axTreeFromCdp } from './ax-tree';
export type {
  HandsContext,
  HandsPort,
  HandsScrollRequest,
  HandsStep,
  HandsTarget,
  KeyEventParams,
  MouseButtonParams,
  PointerPathParams,
  PointerSample,
  WheelPathParams,
  WheelPhase,
  WheelSample,
} from './hands';
export { handsPortFor, loadKeystrokeCorpus, type HandsBinderOptions, type HandsLogger } from './hands-planner';
export { MODIFIER_KEYS, editingChord, keyEventParams, type EditingChord, type ModifierKey } from './keyboard';
export {
  INPUT_NOT_FORWARDED,
  bindLockReleases,
  clientViewportOf,
  sendUntilForwarded,
  type LockReleaseSink,
} from './input';
export {
  LANDING_DRAWS,
  MAX_REACH_GESTURE_PX,
  REST_EPSILON_PX,
  SCROLL_PROGRESS_PX,
  SCROLL_REST_POLL_MS,
  SCROLL_REST_TIMEOUT_MS,
} from './reach';
export { CdpResultError, readDocument, readWorld, type DocumentReadyState, type ReadDocument } from './document';
export {
  EXTRACT_HREF_CHAR_BUDGET,
  LINK_HREF_DEADLINE_MS,
  LINK_HREF_MAX_NODES,
  asksForDestination,
  withLinkHrefs,
  type LinkHrefRead,
  type LinkOwner,
} from './link-hrefs';
export { decodePng, encodePng, paintMarks, type MarkRect, type RgbaImage } from './png-marks';
export { dialogReadMs } from './dialog';
export { composeToolPorts } from './tools';
export { childFrameIds, frameTreeId } from './frames';
