/**
 * The one network seam, deliberately smaller than `fetch`.
 *
 * Identical in shape to `@outcrawl/captcha`'s `src/http.ts`, and deliberately a
 * copy rather than a shared import: a model client that depends on the captcha
 * package to make an HTTP request is a dependency edge nobody reading the graph
 * would predict, and `@outcrawl/core` is not the home either — it is documented
 * as having no runtime beyond validation, and `fetch` is runtime. Two thirty-line
 * transports with the same contract are cheaper than either mistake. The
 * contract is what matters and it is stated here in full.
 *
 * The narrow seam buys two things a raw `fetch` injection does not:
 *
 * **The timeout is a number, not an `AbortSignal`.** A signal built by
 * `AbortSignal.timeout()` runs on real time, which would make every deadline
 * test sleep for the length of the deadline. Passing the remaining budget as
 * milliseconds keeps the client on the injected {@link Clock} and lets a test
 * drive a virtual one.
 *
 * **A non-2xx body is still parsed.** A messages-style provider API puts the actionable error
 * type in the body of a 4xx, not in the status alone:
 *
 * ```json
 * { "type": "error",
 *   "error": { "type": "not_found_error", "message": "..." },
 *   "request_id": "req_..." }
 * ```
 *
 * — the provider's API error reference, read 2026-09-02. A client
 * that throws on `!response.ok` before reading the body turns
 * `invalid_request_error` (our schema is wrong, retrying will not help) and
 * `overloaded_error` (retry with backoff) into the same opaque HTTP failure.
 */

/** One JSON HTTP call, with the caller's remaining budget attached. */
export interface HttpRequest {
  readonly url: string;
  readonly body: unknown;
  /**
   * Sent verbatim. The keys a messages-style provider API needs are its API
   * key, its version header and `content-type`; a credential lives here and
   * nowhere else, which is what makes it easy to keep out of a log line.
   */
  readonly headers: Readonly<Record<string, string>>;
  /** Remaining budget in ms. A request that cannot finish must not start. */
  readonly timeoutMs: number;
  /**
   * Object keys whose NUMBER values come back as their JSON SOURCE TEXT — the
   * string `"2e-7"`, not the binary64 `2e-7` — so money on the wire reaches
   * `decimalFromJsonNumber` in `@outcrawl/core` without passing through a
   * float. The gateway states each call's USD as `usage.cost`, a JSON number
   * that may be written in exponent form, and that figure is what the call is
   * billed from. Every other number parses as usual.
   */
  readonly exactNumberKeys?: readonly string[];
  /**
   * The caller's own abort, beside the deadline: a hedged call whose other arm
   * answered first. An abort through it raises {@link HttpTransportError} with
   * `cancelled` set, never `timedOut` and never a malformed body.
   */
  readonly signal?: AbortSignal;
  /**
   * Return the body as {@link HttpResponse.text} and do not parse it. For a
   * streamed wire (a subscription backend that answers Server-Sent Events only), whose
   * body is not one JSON document.
   */
  readonly rawText?: boolean;
}

export interface HttpResponse {
  readonly status: number;
  /** Parsed JSON, or `undefined` when the body was absent or not JSON. */
  readonly body: unknown;
  /**
   * `request-id`, when the transport saw one. Every response of a messages-style
   * provider API carries it and support tickets are answered by it, so it is
   * worth the one line (the provider's API error reference, `#request-id`).
   */
  readonly requestId?: string;
  /** The unparsed body, present only when {@link HttpRequest.rawText} asked for it. */
  readonly text?: string;
}

export type HttpPost = (request: HttpRequest) => Promise<HttpResponse>;

/** A JSON GET: {@link HttpRequest} with no body. */
export type HttpGetRequest = Omit<HttpRequest, 'body'>;

export type HttpGet = (request: HttpGetRequest) => Promise<HttpResponse>;

/**
 * Raised when the transport itself failed — DNS, connection reset, or the
 * timeout elapsing. Distinct from a provider error, because the provider never
 * answered: no tokens were billed and a retry is always plausible.
 */
export class HttpTransportError extends Error {
  override readonly name = 'HttpTransportError';
  readonly url: string;
  /** True when the failure was our own deadline rather than the network's. */
  readonly timedOut: boolean;
  /** True when the caller aborted through {@link HttpRequest.signal}. */
  readonly cancelled: boolean;

  constructor(url: string, cause: unknown, timedOut: boolean, method: 'GET' | 'POST' = 'POST', cancelled = false) {
    super(`${method} ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.url = url;
    this.timedOut = timedOut;
    this.cancelled = cancelled;
    this.cause = cause;
  }
}

/**
 * The real transport.
 *
 * `AbortSignal.timeout` rather than a `setTimeout` + `AbortController` pair
 * because the runtime owns that timer and clears it on settle; the manual
 * version leaks one per request, and an agent fleet makes a lot of requests.
 */
export const systemHttpPost: HttpPost = (request) => send('POST', request, JSON.stringify(request.body));

/** The real GET, on {@link systemHttpPost}'s exact terms. */
export const systemHttpGet: HttpGet = (request) => send('GET', request, undefined);

async function send(method: 'GET' | 'POST', request: HttpGetRequest, body: string | undefined): Promise<HttpResponse> {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method,
      headers: body === undefined ? request.headers : { ...request.headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }),
      signal:
        request.signal === undefined
          ? AbortSignal.timeout(request.timeoutMs)
          : AbortSignal.any([AbortSignal.timeout(request.timeoutMs), request.signal]),
    });
  } catch (cause) {
    // `AbortSignal.timeout` aborts with a `TimeoutError` DOMException. Naming it
    // matters: a timeout is the one transport failure that is our own fault and
    // is fixed by a larger budget rather than by a retry.
    const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
    throw new HttpTransportError(request.url, cause, timedOut, method, !timedOut && request.signal?.aborted === true);
  }

  // Read the body whatever the status says. See the module comment.
  //
  // ── AN ABORT DURING THE BODY READ IS A TIMEOUT, NOT A MALFORMED BODY ─────
  //
  // The catch here used to swallow every failure into `body = undefined`,
  // which `./chat-completions` then reports as `unparseable_response` — a
  // MALFORMED PROVIDER RESPONSE, marked retryable. For a genuine syntax error
  // that is right. For our own deadline it is a lie about whose fault it is,
  // and it hides the one transport failure a larger budget would fix.
  //
  // MEASURED 2026-09-10. The gateway answers a slow non-streaming request with
  // headers immediately, then whitespace keep-alive padding, then the JSON —
  // one measured reply opened with 120 bytes of newlines and spaces before a
  // valid object 15.6 s later. So `fetch` resolves 200 long before the body
  // exists, and an `AbortSignal.timeout` built from the remaining solve budget
  // fires HERE rather than above. Standalone repro, same model and provider,
  // aborted at 5 s: fetch did not throw, status 200, and the body read threw
  // `TimeoutError`.
  //
  // The cost of getting this wrong was 19 of 24 attempts in one production
  // run reported as `model provider refused (200 unparseable_response)` when
  // every one of them was our own clock. Padding alone is harmless; padding
  // plus a mid-body abort is what manufactures the false accusation.
  //
  // SAME TEST AS ABOVE, deliberately: `TimeoutError` is what
  // `AbortSignal.timeout` raises, and both halves of one request must agree
  // on what a timeout looks like.
  let parsed: unknown;
  let raw: string | undefined;
  try {
    const text = await response.text();
    if (request.rawText === true) {
      raw = text;
    }
    const exact = request.exactNumberKeys ?? [];
    parsed =
      request.rawText === true
        ? undefined
        : exact.length === 0
          ? JSON.parse(text)
        : // The reviver's third argument is TC39's JSON.parse source-text
          // access (shipped in JavaScriptCore and V8): `context.source` is the
          // number exactly as the provider wrote it.
          JSON.parse(text, (key: string, value: unknown, context?: { readonly source?: string }) =>
            typeof value === 'number' && exact.includes(key) && context?.source !== undefined
              ? context.source
              : value,
          );
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'TimeoutError') {
      throw new HttpTransportError(request.url, cause, true, method);
    }
    // The caller's abort lands here for the same reason the deadline does:
    // the gateway sends headers first, so a hedge's loser is usually aborted
    // mid-body. It is a withdrawal, not a malformed reply.
    if (request.signal?.aborted === true) {
      throw new HttpTransportError(request.url, cause, false, method, true);
    }
    parsed = undefined;
  }
  const requestId = response.headers.get('request-id');
  return {
    status: response.status,
    body: parsed,
    ...(raw === undefined ? {} : { text: raw }),
    ...(requestId === null ? {} : { requestId }),
  };
}

/**
 * A non-empty string, or nothing. Provider payloads arrive as `unknown` and stay
 * that way; `isRecord` comes from `@outcrawl/core` rather than being defined
 * again here.
 */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
