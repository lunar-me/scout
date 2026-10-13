/**
 * Where each link on the page goes, for an extraction that asks.
 *
 * `Outcrawl.getAXTree` carries no URL for a link: `FilteredAXNode` is ref,
 * role, name, value, state, xpath and children (`0010-tenancy.patch`, the
 * `FilteredAXNode` type). So a model asked for a link's destination had
 * nothing to read. Measured on the 2026-09-24 failure probes: IW17-download
 * (`run_7959d045`) asked `extract` for "the href attribute" nine times and got
 * `""` nine times, then opened a guessed URL that failed; IW11-hover
 * (`run_e95b4c92`) asked three times for the 'View profile' href and got `""`
 * three times.
 *
 * ── What it costs, and who pays ─────────────────────────────────────────────
 *
 * Measured 2026-09-24 over the steps of 199 recorded runs (the 90 agentab
 * WebVoyager rows and the failure probes): each step's URL from run_records,
 * the page re-fetched by plain HTTP GET, o200k tokens. An absolute href beside
 * every link line would cost the ACTION prompt a median 938 tokens per step
 * against a median 3,971, on a prompt capped at `TREE_CHAR_BUDGET`, so it is
 * never shown there. On EXTRACTION it is shown only when the instruction or
 * the schema asks for a destination ({@link asksForDestination}): 60 of the
 * 397 recorded extracts did. A reference page is where an unconditional read
 * would hurt — LinksReview measured +110k to +151k tokens on Wikipedia and
 * WHATWG spec pages — so the destinations shown are also bounded to
 * {@link EXTRACT_HREF_CHAR_BUDGET} characters, in document order, with the
 * rest stated as omitted. At that bound 365 of the 374 recorded extracts
 * whose page could be re-fetched would have shown every destination.
 *
 * Absolute rather than path-relative, although relative would save a median
 * 396 tokens per extract: this is the text an answer is copied from, and a
 * task that asks for "the link" wants one a person can open. A link inside an
 * iframe is resolved against that frame's own document, which a model handed
 * a path and the top page's URL would get wrong. And never clipped: a URL cut
 * short is a wrong URL, so a destination is shown whole or not at all.
 *
 * ── Why this cannot be seen by the page ─────────────────────────────────────
 *
 * The read is `DOM.describeNode` on each owning session's document with
 * `depth: -1, pierce: true`, which returns every element's attributes and
 * every document's `baseURL`, same-process iframes included. In the protocol
 * this browser ships (M152 `DOM.pdl`, `command describeNode`): "Describes
 * node given its id, does not require domain to be enabled. Does not start
 * tracking any objects, can be used for automation." In the implementation
 * (`inspector_dom_agent.cc`, `InspectorDOMAgent::describeNode`): the node is
 * found by `DOMNodeIds::NodeForId`, and `BuildObjectForNode` is called with a
 * null `nodes_map`, so `Bind` returns 0 without assigning an id and every
 * child is built the same way — no `DOM.enable`, no mutation observers, no
 * node ids pushed. It runs no script, dispatches no event and forces no
 * layout: `isNodeScrollable` reads a `LayoutBox` that already exists. The
 * attributes come from `Element::Attributes()`, the same read the fork's own
 * AX snapshot already makes for every element (`AXObject::SerializeHTMLAttributesForSnapshot`,
 * cited at `BuildXPath` in the patch). One side effect, found by LinksReview:
 * `IdentifiersFactory::IntIdForNode` mints a backendNodeId, and with it
 * `NodeRareData`, for every node described, including nodes with no AX
 * object; `getAXTree` already does the same for every AX-backed node on every
 * step. No page-visible surface for it is known; the one indirect channel,
 * `performance.measureUserAgentSpecificMemory` on a cross-origin-isolated
 * page, is not measured.
 *
 * Rejected, with reasons measured in source:
 *
 * - `DOMSnapshot.captureSnapshot` calls
 *   `UpdateLifecycleToCompositingInputsClean` before it walks, a style and
 *   layout pass the page did not ask for, and it has no attribute filter — its
 *   parameters are computed styles, paint order, DOM rects and colours.
 * - An isolated world still runs script, and script cannot run at all while the
 *   page is frozen for a model call (`page.ts`), which is exactly when
 *   `extract` reads the tree. `DOM.*` answers under the freeze: the click path
 *   already calls `DOM.getBoxModel` there.
 *
 * ── Which session, which document ───────────────────────────────────────────
 *
 * A `backendNodeId` is an id in ONE renderer, so each node is looked up only
 * in the description built by the session `owner` names for its frame — the
 * same resolution every action uses (`sessionFor` in `./page-binding.ts`),
 * which for a frame other than the session's own asks the flavor's frame
 * ordinal and arms the browser-side `Target.setAutoAttach` exactly as any
 * action on an iframe ref already does. A session's document is `tree.root`
 * for `top`, whose tree this is; for an out-of-process frame it is the root of
 * that session's own tree (`LinkHrefRead.axTree`). That is sound because Blink uses a
 * node's DOMNodeId as its AXID (`AXObjectCacheImpl`, "If there is a DOM node,
 * use its dom_node_id"), which is what makes every ref a `backendNodeId` in
 * the first place. A description whose root is not a document names nothing
 * this code can resolve against, so its nodes keep no href rather than a
 * guessed one.
 */

import type { Clock, JsonSchema } from '@outcrawl/scout-core';
import type { AxNode, AxTree, NodeRef } from '@outcrawl/runtime';
import { ACTIONABLE_ROLES, parseNodeRef, walk } from '@outcrawl/runtime';

import type { CdpPage } from './cdp';

/**
 * Characters of ` ->"<url>"` shown per extraction, in document order; past it
 * whole destinations are dropped and counted. 30,000 characters is about
 * 13,000 o200k tokens at the 2.29 characters per token measured on hrefs, and
 * fitted every destination on 365 of 374 recorded extracts (2026-09-24).
 */
export const EXTRACT_HREF_CHAR_BUDGET = 30_000;

/**
 * How long the whole read may take before the extraction goes ahead without
 * it. It is optional enrichment, and without this every command in it would
 * wait out the connection's 30 s default (`cdp.ts`). Renderer-side
 * describeNode latency on a large page is NOT measured — no browser may run
 * here — so this is a ceiling chosen against the model call it precedes, not a
 * fitted number.
 */
export const LINK_HREF_DEADLINE_MS = 2_500;

/**
 * Past this many accessibility nodes the read is not attempted. The deadline
 * above bounds how long the extraction waits, but it cannot cancel work the
 * renderer has started, and a describeNode still building a very large page
 * would hold the renderer the next step's snapshot needs. 20,000 is the fork's
 * own default `getAXTree` ceiling (`kDefaultMaxNodes`), the size it treats as
 * a large page; a DOM has at least as many nodes as its tree has kept.
 */
export const LINK_HREF_MAX_NODES = 20_000;

/**
 * Places a person can be sent. `javascript:` is code; `data:`, `blob:` and
 * custom schemes are content or app hand-offs, and an opaque-path scheme keeps
 * spaces, quotes and brackets verbatim, which on a line whose grammar the model
 * trusts is a channel for a page to write instructions it cannot see.
 */
const DESTINATION_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ftp:', 'mailto:', 'tel:']);

/**
 * `hyperlink`, `permalink`, `linked` and `backlinks` included: `\w*link` has no
 * boundary before `link` on purpose. A false positive ("downloads per week")
 * costs one read; a false negative costs the answer.
 */
const ASKS_FOR_DESTINATION =
  /\b(?:\w*link(?:s|ed)?|urls?|uris?|hrefs?|downloads?|websites?|web ?address(?:es)?|destinations?)\b/i;

/**
 * JSON Schema's own ways of saying "a URL", which is how a customer declares
 * one the standard way: Pydantic's `HttpUrl` emits `format: "uri"`, zod's
 * `.url()` the same.
 */
const URL_FORMATS: ReadonlySet<string> = new Set(['uri', 'uri-reference', 'iri', 'iri-reference', 'url']);

/**
 * Whether an extraction asks where something goes: its instruction, or a
 * property name, title, description or URL `format` in its schema
 * (`productUrl`, `download_link`, `{format: "uri"}`). Only then are
 * destinations read and paid for.
 */
export function asksForDestination(instruction: string | undefined, schema: JsonSchema | undefined): boolean {
  if (instruction !== undefined && ASKS_FOR_DESTINATION.test(instruction)) {
    return true;
  }
  let asks = false;
  const collect = (value: unknown, propertyNames: boolean): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        collect(item, false);
      }
      return;
    }
    if (asks || typeof value !== 'object' || value === null) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (propertyNames) {
        asks ||= ASKS_FOR_DESTINATION.test(key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[^A-Za-z0-9]+/g, ' '));
      } else if ((key === 'description' || key === 'title') && typeof child === 'string') {
        asks ||= ASKS_FOR_DESTINATION.test(child);
      } else if (key === 'format' && typeof child === 'string') {
        asks ||= URL_FORMATS.has(child);
      }
      collect(child, !propertyNames && key === 'properties');
    }
  };
  collect(schema, false);
  return asks;
}

/** Resolves a ref to the session whose renderer owns its `backendNodeId`. */
export type LinkOwner = (ref: NodeRef) => Promise<{ readonly page: CdpPage; readonly backendNodeId: number }>;

export interface LinkHrefRead {
  readonly owner: LinkOwner;
  /** The session `tree` was read on. */
  readonly top: CdpPage;
  /** An out-of-process frame's own accessibility tree, as the browser's flavor reads it. */
  readonly axTree: (session: CdpPage) => Promise<Record<string, unknown>>;
  /** Applied to each destination before it is shown: the run's secret vault. */
  readonly conceal: (text: string) => string;
  readonly clock: Pick<Clock, 'sleep'>;
}

/** `DOM.Node`, as far as this reads it. Every field is checked before use. */
interface DescribedNode {
  readonly nodeType?: unknown;
  readonly backendNodeId?: unknown;
  readonly localName?: unknown;
  readonly attributes?: unknown;
  readonly baseURL?: unknown;
  readonly documentURL?: unknown;
  readonly children?: unknown;
  readonly shadowRoots?: unknown;
  readonly contentDocument?: unknown;
}

const DOCUMENT_NODE = 9;
const ELEMENT_NODE = 1;

/**
 * Where an `<a>` or `<area>` goes, resolved the way the browser would resolve
 * it: HTML strips ASCII whitespace from a URL attribute before parsing it
 * against the document's base URL. Anything that does not parse to one of
 * {@link DESTINATION_SCHEMES} goes nowhere and yields `undefined`.
 */
function destination(attributes: readonly unknown[], base: string): string | undefined {
  let raw: string | undefined;
  for (let at = 0; at + 1 < attributes.length; at += 2) {
    const name = attributes[at];
    const value = attributes[at + 1];
    // SVG's `<a>` may still carry the deprecated `xlink:href`; `href` wins.
    if (typeof value === 'string' && (name === 'href' || (name === 'xlink:href' && raw === undefined))) {
      raw = value;
    }
  }
  if (raw === undefined) {
    return undefined;
  }
  try {
    const url = new URL(raw.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, ''), base);
    return DESTINATION_SCHEMES.has(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Every link element's destination under `root`, keyed by `backendNodeId`. */
function destinationsIn(root: DescribedNode): ReadonlyMap<number, string> {
  const found = new Map<number, string>();
  const stack: { node: DescribedNode; base: string }[] = [{ node: root, base: '' }];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { node } = next;
    let { base } = next;
    if (node.nodeType === DOCUMENT_NODE) {
      const own = typeof node.baseURL === 'string' && node.baseURL !== '' ? node.baseURL : node.documentURL;
      base = typeof own === 'string' ? own : base;
    }
    if (
      node.nodeType === ELEMENT_NODE &&
      (node.localName === 'a' || node.localName === 'area') &&
      typeof node.backendNodeId === 'number' &&
      Array.isArray(node.attributes)
    ) {
      const href = destination(node.attributes, base);
      if (href !== undefined) {
        found.set(node.backendNodeId, href);
      }
    }
    for (const list of [node.children, node.shadowRoots]) {
      if (Array.isArray(list)) {
        for (const child of list) {
          if (typeof child === 'object' && child !== null) {
            stack.push({ node: child as DescribedNode, base });
          }
        }
      }
    }
    if (typeof node.contentDocument === 'object' && node.contentDocument !== null) {
      stack.push({ node: node.contentDocument as DescribedNode, base });
    }
  }
  return found;
}

/** The destinations in `session`'s document, or none when it cannot be read. */
async function describedBy(session: CdpPage, tree: AxTree, read: LinkHrefRead): Promise<ReadonlyMap<number, string>> {
  try {
    let document: number | undefined = tree.root.ref.backendNodeId;
    if (session !== read.top) {
      const root = (await read.axTree(session))['root'];
      const wire = typeof root === 'object' && root !== null ? (root as Record<string, unknown>)['ref'] : undefined;
      document = typeof wire === 'string' ? parseNodeRef(wire)?.backendNodeId : undefined;
    }
    if (document === undefined) {
      return new Map();
    }
    const described = (await session.send('DOM.describeNode', { backendNodeId: document, depth: -1, pierce: true }))['node'];
    return typeof described === 'object' && described !== null && (described as DescribedNode).nodeType === DOCUMENT_NODE
      ? destinationsIn(described as DescribedNode)
      : new Map();
  } catch {
    // The page moved on under the read. Its links keep no destination, which
    // the extraction prompt states is possible.
    return new Map();
  }
}

/**
 * Destinations by frame ordinal, then by `backendNodeId` in that frame's
 * renderer. Only frames holding an actionable node are read, and each owning
 * session once, however many frames share its renderer.
 */
async function destinationsByFrame(
  tree: AxTree,
  nodes: readonly AxNode[],
  read: LinkHrefRead,
): Promise<ReadonlyMap<number, ReadonlyMap<number, string>>> {
  const representative = new Map<number, NodeRef>();
  for (const node of nodes) {
    if (ACTIONABLE_ROLES.has(node.role) && !representative.has(node.ref.frameOrdinal)) {
      representative.set(node.ref.frameOrdinal, node.ref);
    }
  }
  const framesOf = new Map<CdpPage, number[]>();
  for (const [frame, ref] of representative) {
    try {
      const { page } = await read.owner(ref);
      framesOf.set(page, [...(framesOf.get(page) ?? []), frame]);
    } catch {
      // A frame no session can serve keeps no destinations.
    }
  }
  const byFrame = new Map<number, ReadonlyMap<number, string>>();
  await Promise.all(
    [...framesOf].map(async ([session, frames]) => {
      const found = await describedBy(session, tree, read);
      for (const frame of frames) {
        byFrame.set(frame, found);
      }
    }),
  );
  return byFrame;
}

/**
 * `tree` with `href` on every node whose element links somewhere and could be
 * read — whatever its role, since `<a href role="button">` is still a link —
 * and `hrefs` saying what was withheld. A node the read could not reach (its
 * frame's session is gone, it was replaced since the snapshot) keeps no
 * destination, never a guessed one.
 */
export async function withLinkHrefs(tree: AxTree, read: LinkHrefRead): Promise<AxTree> {
  const nodes = walk(tree);
  if (nodes.length > LINK_HREF_MAX_NODES) {
    return {
      ...tree,
      hrefs: { outcome: 'unread', why: `the page has more than ${LINK_HREF_MAX_NODES.toLocaleString('en-US')} accessibility nodes` },
    };
  }
  if (!nodes.some((node) => ACTIONABLE_ROLES.has(node.role))) {
    return tree;
  }

  const byFrame = await Promise.race([
    destinationsByFrame(tree, nodes, read),
    read.clock.sleep(LINK_HREF_DEADLINE_MS).then(() => undefined),
  ]);
  if (byFrame === undefined) {
    return {
      ...tree,
      hrefs: { outcome: 'unread', why: `reading them took longer than ${String(LINK_HREF_DEADLINE_MS / 1000)} s` },
    };
  }

  // Document order, and a PREFIX: once one destination does not fit, none
  // after it is shown, so the notice can say exactly which lines lack one.
  let spent = 0;
  let omitted = 0;
  const annotate = (node: AxNode): AxNode => {
    const found = byFrame.get(node.ref.frameOrdinal)?.get(node.ref.backendNodeId);
    let href: string | undefined;
    if (found !== undefined) {
      const shown = read.conceal(found);
      const cost = ` ->${JSON.stringify(shown)}`.length;
      if (omitted === 0 && spent + cost <= EXTRACT_HREF_CHAR_BUDGET) {
        spent += cost;
        href = shown;
      } else {
        omitted += 1;
      }
    }
    const children = node.children?.map(annotate);
    return {
      ...node,
      ...(href === undefined ? {} : { href }),
      ...(children === undefined ? {} : { children }),
    };
  };
  const root = annotate(tree.root);
  return { ...tree, root, hrefs: { outcome: 'read', omitted } };
}
