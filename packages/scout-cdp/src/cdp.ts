/**
 * The CDP surface the binding is written against: three methods and two ids,
 * not a page object with behaviour. Every binding that drives a page needs raw
 * CDP eventually, so an abstraction that hid the protocol would be bypassed on
 * its first interesting call and then maintained anyway.
 *
 * `send` and `sendBrowser` are separate on purpose: target and browser-context
 * commands exist only on the browser target, and one `send` would put half of
 * them down a session that cannot serve them.
 *
 * Any CDP client satisfies it: a host's own connection, a page session over
 * `chrome --remote-debugging-port`, or a test double.
 */

/** One page: a CDP target plus the flat session attached to it. */
export interface CdpPage {
  /** Raw CDP on this page's flat session, e.g. `Page.navigate`. */
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Browser-level CDP, no session: target and browser-context lifecycle. */
  sendBrowser(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Subscribes to an event on this page's session. Returns the unsubscribe. */
  on(method: string, handler: (params: Record<string, unknown>) => void): () => void;
  readonly targetId: string;
  readonly sessionId: string;
  /** Final URL as last observed by this page, updated on navigation. */
  url(): string;
  /**
   * A flat session already attached to another target on the SAME
   * connection, wrapped as a `CdpPage` of its own: an out-of-process iframe
   * announced by `Target.setAutoAttach`'s `Target.attachedToTarget`.
   *
   * Optional so a test double built to prove one thing need not grow it.
   * Absent, the binding treats it as a failed attach: the owning session
   * cannot be established, and a reference into that frame is refused rather
   * than resolved against the wrong renderer.
   */
  forSession?(sessionId: string, targetId: string): CdpPage;
}

/**
 * Whether `error` is a CDP command that went unanswered past its deadline, for
 * `method`. Read by shape (`name` and `method`), not by class, so any client's
 * timeout error that carries the two counts.
 */
export function isCdpTimeout(error: unknown, method: string): boolean {
  return error instanceof Error && error.name === 'CdpTimeoutError' && Reflect.get(error, 'method') === method;
}
