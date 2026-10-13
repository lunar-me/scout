/**
 * THE FILTERED ACCESSIBILITY TREE, BUILT FROM PLAIN CDP.
 *
 * The Outcrawl browser answers one command with the tree the agent reads: a
 * walk of every frame below the session's own, Blink's accessibility nodes
 * filtered to what a model can act on or read, each carrying a
 * `"<frameOrdinal>-<backendNodeId>"` reference. {@link axTreeFromCdp} reads
 * that wire shape. This module produces the same shape from the stock
 * domains, so the binding above cannot tell which browser it is driving:
 *
 *   * `Page.getFrameTree` lists the frames in the session's renderer.
 *   * `Accessibility.getFullAXTree({frameId})` reads each one. Blink's AX node
 *     id is the DOM node id, so the reference is the same number the fork
 *     mints, and the role is the same spelling (Blink's CDP role names).
 *   * `DOM.getFrameOwner` and `DOM.describeNode` join a child frame to the
 *     `<iframe>` that embeds it. A frame in another renderer (an
 *     out-of-process iframe) is read through its own target session, attached
 *     for the read and detached after it.
 *   * `DOMSnapshot.captureSnapshot` supplies what the AX domain does not: the
 *     HTML attributes the heal path (`xpath`) is built from, the paint state
 *     (`visibility`, `opacity`), click targets and labelled controls. Without
 *     it the tree is still complete; those fields are absent or `''`.
 *
 * The filter is the fork's own, rule for rule: dropped roles, ignored nodes
 * skipped with their children promoted, actionable roles kept, labelling roles
 * kept when named and not repeating their container's name, the root always
 * kept, and a refusal rather than a truncation past `maxNodes` or the depth
 * bound.
 */
import { ACTIONABLE_ROLES, DROPPED_ROLES, LABELLING_ROLES } from '@outcrawl/runtime';

import type { CdpPage } from '../cdp';

/** The fork's default node ceiling, used when the caller names none. */
export const DEFAULT_MAX_NODES = 20_000;

/** The fork's recursion bound: the DOM is page-controlled, the walk is recursive. */
export const MAX_DEPTH = 300;

/** Roles whose name is the text itself, so they can duplicate their container's. */
const TEXT_ROLES: ReadonlySet<string> = new Set(['StaticText', 'text', 'LabelText', 'caption']);

/** Elements that are HTML "interactive content": a label's activation does not pass through them. */
const INTERACTIVE_TAGS: ReadonlySet<string> = new Set(['a', 'button', 'details', 'embed', 'iframe', 'input', 'label', 'select', 'textarea']);

/** Elements a `<label>` can label. */
const LABELABLE_TAGS: ReadonlySet<string> = new Set(['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea']);

/** The heal path's attribute preference, most stable first. The fork's own list. */
const XPATH_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'name', 'aria-label', 'placeholder', 'href', 'type'] as const;

const ELEMENT_NODE = 1;

/** The heal path's 256-byte bound is on the UTF-8 value, as the fork measures it. */
const UTF8 = new TextEncoder();

/* ------------------------------------------------------------------ *
 * Frame ordinals
 * ------------------------------------------------------------------ */

/**
 * Frame ordinals, by CDP frame id. The fork's ordinal is the browser's
 * `FrameTreeNodeId`: an integer unique for the life of the browser and never
 * reused, which is what lets a reference from one tab be refused on another.
 * Stock CDP names frames by a string token with the same lifetime, so the
 * ordinal is the order this process first saw each token: process-wide, so
 * every session and every binding agrees on it, and never reused.
 */
const ordinals = new Map<string, number>();

export function frameOrdinalOf(frameId: string): number {
  let ordinal = ordinals.get(frameId);
  if (ordinal === undefined) {
    ordinal = ordinals.size + 1;
    ordinals.set(frameId, ordinal);
  }
  return ordinal;
}

/* ------------------------------------------------------------------ *
 * Reading the CDP replies
 * ------------------------------------------------------------------ */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numbers(value: unknown): readonly number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number') ? (value as number[]) : [];
}

/** A `Page.Frame` and its children, as far as this reads them. */
interface FrameInfo {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly url: string;
}

/** Every frame of a `Page.getFrameTree` reply, root first, depth first. */
export function framesOf(reply: Record<string, unknown>): readonly FrameInfo[] {
  const out: FrameInfo[] = [];
  const visit = (tree: unknown): void => {
    if (!isObject(tree) || !isObject(tree['frame'])) return;
    const frame = tree['frame'];
    const id = frame['id'];
    if (typeof id !== 'string') return;
    const url = typeof frame['url'] === 'string' ? frame['url'] : '';
    const fragment = typeof frame['urlFragment'] === 'string' ? frame['urlFragment'] : '';
    out.push({ id, parentId: typeof frame['parentId'] === 'string' ? frame['parentId'] : undefined, url: url + fragment });
    const children = tree['childFrames'];
    if (Array.isArray(children)) for (const child of children) visit(child);
  };
  visit(reply['frameTree']);
  return out;
}

/** One `Accessibility.AXNode`, as far as this reads it. */
interface AxIn {
  readonly id: string;
  readonly ignored: boolean;
  readonly role: string;
  readonly name: string;
  readonly value: string;
  readonly props: ReadonlyMap<string, unknown>;
  readonly childIds: readonly string[];
  readonly backendNodeId: number | undefined;
  readonly parentId: string | undefined;
}

function axValue(value: unknown): unknown {
  return isObject(value) ? value['value'] : undefined;
}

function axNodeOf(raw: unknown): AxIn | undefined {
  if (!isObject(raw) || typeof raw['nodeId'] !== 'string') return undefined;
  const role = axValue(raw['role']);
  const name = axValue(raw['name']);
  const value = axValue(raw['value']);
  const props = new Map<string, unknown>();
  const properties = raw['properties'];
  if (Array.isArray(properties)) {
    for (const property of properties) {
      if (isObject(property) && typeof property['name'] === 'string') props.set(property['name'], axValue(property['value']));
    }
  }
  const childIds = raw['childIds'];
  const backend = raw['backendDOMNodeId'];
  return {
    id: raw['nodeId'],
    ignored: raw['ignored'] === true,
    role: typeof role === 'string' ? role : '',
    name: typeof name === 'string' ? name : '',
    value: typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '',
    props,
    childIds: Array.isArray(childIds) ? childIds.filter((id): id is string => typeof id === 'string') : [],
    backendNodeId: typeof backend === 'number' ? backend : undefined,
    parentId: typeof raw['parentId'] === 'string' ? raw['parentId'] : undefined,
  };
}

/** What `DOMSnapshot.captureSnapshot` says about one document. */
interface DomDocument {
  readonly index: ReadonlyMap<number, number>;
  readonly parent: readonly number[];
  readonly type: readonly number[];
  /** Lower-cased `nodeName`. */
  readonly tag: readonly string[];
  /** Flat name/value pairs per node. */
  readonly attributes: readonly (readonly string[])[];
  readonly clickable: ReadonlySet<number>;
  readonly checked: ReadonlySet<number>;
  /** Computed `visibility` and `opacity`, for nodes with a layout object. */
  readonly style: ReadonlyMap<number, { readonly visibility: string; readonly opacity: string }>;
  /** Element by `id` attribute, the first in document order: what a label's `for` names. */
  readonly byId: ReadonlyMap<string, number>;
}

/** The facts of one session's snapshot: each local document by frame id, and each child frame's owner. */
interface DomFacts {
  readonly documents: ReadonlyMap<string, DomDocument>;
  /** Child frame id -> `backendNodeId` of its `<iframe>`. */
  readonly owners: ReadonlyMap<string, number>;
}

function rareSet(value: unknown): ReadonlySet<number> {
  return new Set(isObject(value) ? numbers(value['index']) : []);
}

export function domFactsOf(reply: Record<string, unknown>): DomFacts {
  const strings = Array.isArray(reply['strings']) ? (reply['strings'] as unknown[]) : [];
  const text = (at: unknown): string => (typeof at === 'number' && typeof strings[at] === 'string' ? (strings[at] as string) : '');
  const raw = Array.isArray(reply['documents']) ? reply['documents'].filter(isObject) : [];
  const documents = new Map<string, DomDocument>();
  const owners = new Map<string, number>();
  for (const document of raw) {
    const nodes = isObject(document['nodes']) ? document['nodes'] : {};
    const backend = numbers(nodes['backendNodeId']);
    const index = new Map<number, number>();
    backend.forEach((id, at) => index.set(id, at));
    const attributeLists = Array.isArray(nodes['attributes']) ? nodes['attributes'] : [];
    const layout = isObject(document['layout']) ? document['layout'] : {};
    const layoutNodes = numbers(layout['nodeIndex']);
    const layoutStyles = Array.isArray(layout['styles']) ? layout['styles'] : [];
    const style = new Map<number, { visibility: string; opacity: string }>();
    layoutNodes.forEach((node, at) => {
      const values = numbers(layoutStyles[at]);
      style.set(node, { visibility: text(values[0]), opacity: text(values[1]) });
    });
    const attributes = backend.map((_, at) => numbers(attributeLists[at]).map(text));
    const byId = new Map<string, number>();
    attributes.forEach((list, node) => {
      for (let at = 0; at + 1 < list.length; at += 2) {
        const value = list[at + 1];
        if (list[at] === 'id' && value !== undefined && !byId.has(value)) byId.set(value, node);
      }
    });
    documents.set(text(document['frameId']), {
      index,
      parent: numbers(nodes['parentIndex']),
      type: numbers(nodes['nodeType']),
      tag: numbers(nodes['nodeName']).map((name) => text(name).toLowerCase()),
      attributes,
      clickable: rareSet(nodes['isClickable']),
      checked: rareSet(nodes['inputChecked']),
      style,
      byId,
    });
    const content = isObject(nodes['contentDocumentIndex']) ? nodes['contentDocumentIndex'] : {};
    const ownerAt = numbers(content['index']);
    const childAt = numbers(content['value']);
    ownerAt.forEach((node, at) => {
      const child = raw[childAt[at] ?? -1];
      const owner = backend[node];
      if (child !== undefined && owner !== undefined) owners.set(text(child['frameId']), owner);
    });
  }
  return { documents, owners };
}

/* ------------------------------------------------------------------ *
 * DOM facts the AX domain does not carry
 * ------------------------------------------------------------------ */

function attribute(dom: DomDocument, node: number, name: string): string | undefined {
  const list = dom.attributes[node] ?? [];
  for (let at = 0; at + 1 < list.length; at += 2) {
    if (list[at] === name) return list[at + 1];
  }
  return undefined;
}

/** The fork's quoting rule: an attribute value that would need escaping is skipped, never emitted broken. */
function quotable(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value !== '' &&
    !value.includes('"') &&
    !value.includes('\n') &&
    UTF8.encode(value).length <= 256
  );
}

/**
 * The heal path, by the fork's rule: `//*[@id="…"]`, else the tag qualified by
 * the most stable attribute it has, else `''`. Never positional: a positional
 * path breaks on any insertion above the node.
 */
function xpathOf(dom: DomDocument | undefined, backendNodeId: number | undefined): string {
  const node = backendNodeId === undefined ? undefined : dom?.index.get(backendNodeId);
  if (dom === undefined || node === undefined || dom.type[node] !== ELEMENT_NODE) return '';
  const id = attribute(dom, node, 'id');
  if (quotable(id)) return `//*[@id="${id}"]`;
  const tag = dom.tag[node] ?? '';
  if (tag === '') return '';
  for (const name of XPATH_ATTRIBUTES) {
    const value = attribute(dom, node, name);
    if (quotable(value)) return `//${tag}[@${name}="${value}"]`;
  }
  return '';
}

/**
 * Whether the node is painted invisible, `undefined` when it has no layout
 * object: computed `visibility` other than `visible`, or `opacity: 0` on it or
 * any rendered ancestor. Viewport position is not paint state.
 */
function paintHiddenOf(dom: DomDocument | undefined, backendNodeId: number | undefined): boolean | undefined {
  const node = backendNodeId === undefined ? undefined : dom?.index.get(backendNodeId);
  if (dom === undefined || node === undefined) return undefined;
  const own = dom.style.get(node);
  if (own === undefined) return undefined;
  if (own.visibility !== 'visible') return true;
  for (let at: number | undefined = node; at !== undefined && at >= 0; at = dom.parent[at]) {
    if (dom.style.get(at)?.opacity === '0') return true;
  }
  return false;
}

function isDisabled(dom: DomDocument, node: number): boolean {
  return attribute(dom, node, 'disabled') !== undefined;
}

function isInteractive(dom: DomDocument, node: number): boolean {
  const tag = dom.tag[node] ?? '';
  if (!INTERACTIVE_TAGS.has(tag)) return false;
  if (tag === 'a') return attribute(dom, node, 'href') !== undefined;
  if (tag === 'input') return attribute(dom, node, 'type')?.toLowerCase() !== 'hidden';
  return true;
}

function isLabelable(dom: DomDocument, node: number): boolean {
  const tag = dom.tag[node] ?? '';
  return LABELABLE_TAGS.has(tag) && !(tag === 'input' && attribute(dom, node, 'type')?.toLowerCase() === 'hidden');
}

function isDescendant(dom: DomDocument, node: number, ancestor: number): boolean {
  for (let at = dom.parent[node]; at !== undefined && at >= 0; at = dom.parent[at]) {
    if (at === ancestor) return true;
  }
  return false;
}

/** The control a `<label>` labels: its `for` target, else its first labelable descendant. */
function labelControl(dom: DomDocument, label: number): number | undefined {
  const target = attribute(dom, label, 'for');
  if (target !== undefined) {
    const node = dom.byId.get(target);
    return node !== undefined && isLabelable(dom, node) ? node : undefined;
  }
  for (let node = label + 1; node < dom.type.length && isDescendant(dom, node, label); node += 1) {
    if (dom.type[node] === ELEMENT_NODE && isLabelable(dom, node)) return node;
  }
  return undefined;
}

/**
 * A checkbox or radio's state as its label shows it. A radio whose group has
 * nothing checked reads `mixed`, which is Blink's own rule for the label.
 */
function checkedOf(dom: DomDocument, input: number): 'true' | 'false' | 'mixed' {
  if (dom.checked.has(input)) return 'true';
  if (attribute(dom, input, 'type')?.toLowerCase() !== 'radio') return 'false';
  const group = attribute(dom, input, 'name');
  if (group === undefined || group === '') return 'mixed';
  for (const other of dom.checked) {
    if (attribute(dom, other, 'type')?.toLowerCase() === 'radio' && attribute(dom, other, 'name') === group) return 'false';
  }
  return 'mixed';
}

/**
 * For text and label nodes: whether a pointer on it does something (a click
 * target that is not the document or body, or a label of an enabled control),
 * and the state of a checkable control it labels. A styled checkbox is often
 * `display:none` behind its label, so the label is what carries it.
 */
function textTarget(dom: DomDocument | undefined, backendNodeId: number | undefined): { readonly pointable: boolean; readonly checked?: 'true' | 'false' | 'mixed' } {
  const start = backendNodeId === undefined ? undefined : dom?.index.get(backendNodeId);
  if (dom === undefined || start === undefined) return { pointable: false };
  let pointable = false;
  for (let at: number | undefined = start; at !== undefined && at >= 0; at = dom.parent[at]) {
    if (dom.type[at] === ELEMENT_NODE && dom.clickable.has(at) && !isDisabled(dom, at)) {
      const tag = dom.tag[at];
      pointable = tag !== 'html' && tag !== 'body';
      break;
    }
  }
  for (let at: number | undefined = start; at !== undefined && at >= 0; at = dom.parent[at]) {
    if (dom.type[at] !== ELEMENT_NODE) continue;
    if (dom.tag[at] === 'label') {
      const control = labelControl(dom, at);
      if (control === undefined || isDisabled(dom, control)) break;
      pointable = true;
      const type = attribute(dom, control, 'type')?.toLowerCase();
      if (dom.tag[control] === 'input' && (type === 'checkbox' || type === 'radio')) {
        return { pointable, checked: checkedOf(dom, control) };
      }
      break;
    }
    if (isInteractive(dom, at)) break;
  }
  return { pointable };
}

/* ------------------------------------------------------------------ *
 * Collection: every frame below a session
 * ------------------------------------------------------------------ */

interface AxFrame {
  readonly ordinal: number;
  /** The frame's committed URL, fragment included. */
  readonly url: string;
  readonly nodes: ReadonlyMap<string, AxIn>;
  readonly rootId: string | undefined;
  readonly dom: DomDocument | undefined;
}

interface Collection {
  readonly frames: AxFrame[];
  /** `"<frameIndex>:<ownerAxId>"` -> the index of the frame that `<iframe>` embeds. */
  readonly childFrames: Map<string, number>;
}

async function attempt<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

/**
 * Reads `session`'s frame and every frame below it into `into`, and returns
 * the index of the session's own frame. Frames in this renderer come from its
 * frame tree; a frame in another renderer is reached through the `<iframe>`
 * that embeds it, on a session of its own.
 */
async function collect(session: CdpPage, into: Collection): Promise<number | undefined> {
  const locals = framesOf(await session.send('Page.getFrameTree'));
  if (locals.length === 0) return undefined;
  const snapshot = await attempt(() => session.send('DOMSnapshot.captureSnapshot', { computedStyles: ['visibility', 'opacity'] }));
  const facts = snapshot === undefined ? undefined : domFactsOf(snapshot);

  const indexOf = new Map<string, number>();
  for (const frame of locals) {
    const reply = await attempt(() => session.send('Accessibility.getFullAXTree', { frameId: frame.id }));
    const nodes = new Map<string, AxIn>();
    let rootId: string | undefined;
    for (const raw of Array.isArray(reply?.['nodes']) ? reply['nodes'] : []) {
      const node = axNodeOf(raw);
      if (node === undefined) continue;
      nodes.set(node.id, node);
      if (rootId === undefined && node.parentId === undefined) rootId = node.id;
    }
    indexOf.set(frame.id, into.frames.length);
    into.frames.push({ ordinal: frameOrdinalOf(frame.id), url: frame.url, nodes, rootId, dom: facts?.documents.get(frame.id) });
  }

  // Child frames in this renderer, joined to the `<iframe>` that embeds them.
  for (const frame of locals) {
    const parent = frame.parentId === undefined ? undefined : indexOf.get(frame.parentId);
    const child = indexOf.get(frame.id);
    if (parent === undefined || child === undefined) continue;
    const owner =
      facts?.owners.get(frame.id) ??
      (await attempt(async () => (await session.send('DOM.getFrameOwner', { frameId: frame.id }))['backendNodeId']));
    if (typeof owner === 'number') into.childFrames.set(`${String(parent)}:${String(owner)}`, child);
  }

  // Frames in other renderers: an `<iframe>` with no frame of this renderer
  // behind it, read through a session of its own.
  const forSession = session.forSession?.bind(session);
  if (forSession !== undefined) {
    for (const frame of locals) {
      const index = indexOf.get(frame.id);
      if (index === undefined) continue;
      for (const node of into.frames[index]?.nodes.values() ?? []) {
        if (node.role !== 'Iframe' || node.backendNodeId === undefined) continue;
        const key = `${String(index)}:${node.id}`;
        if (into.childFrames.has(key)) continue;
        const described = await attempt(() => session.send('DOM.describeNode', { backendNodeId: node.backendNodeId }));
        const frameId = isObject(described?.['node']) ? described['node']['frameId'] : undefined;
        if (typeof frameId !== 'string' || indexOf.has(frameId)) continue;
        const attached = await attempt(() => session.sendBrowser('Target.attachToTarget', { targetId: frameId, flatten: true }));
        const sessionId = attached?.['sessionId'];
        if (typeof sessionId !== 'string') continue;
        try {
          const child = await attempt(() => collect(forSession(sessionId, frameId), into));
          if (child !== undefined) into.childFrames.set(key, child);
        } finally {
          await attempt(() => session.sendBrowser('Target.detachFromTarget', { sessionId }));
        }
      }
    }
  }
  return indexOf.get(locals[0]?.id ?? '');
}

/* ------------------------------------------------------------------ *
 * Emission: the fork's filter
 * ------------------------------------------------------------------ */

type WireChecked = 'true' | 'false' | 'mixed';

interface WireState {
  disabled?: boolean;
  checked?: WireChecked;
  expanded?: boolean;
  selected?: boolean;
  required?: boolean;
  invalid?: boolean;
  readonly?: boolean;
  multiline?: boolean;
  focused?: boolean;
  paintHidden?: boolean;
  pointable?: boolean;
}

/** `Outcrawl.FilteredAXNode`'s wire shape, which {@link axTreeFromCdp} reads. */
export interface WireNode {
  readonly ref: string;
  readonly role: string;
  readonly xpath: string;
  readonly name?: string;
  readonly value?: string;
  readonly state?: WireState;
  readonly children?: readonly WireNode[];
}

interface Build {
  readonly frames: readonly AxFrame[];
  readonly childFrames: ReadonlyMap<string, number>;
  /** Per frame: whether its embedding `<iframe>`, or one above it, is painted invisible. */
  readonly framePaintHidden: boolean[];
  readonly maxNodes: number;
  emitted: number;
  truncated: boolean;
}

/** Blink's `CollapseWhitespaceASCII`, line breaks collapsed like any other run. `''` is absent. */
function normalise(text: string): string {
  return text.replace(/[\t\n\v\f\r ]+/g, ' ').replace(/^ | $/g, '');
}

function refOf(frame: AxFrame, node: AxIn): string {
  const id = Number(node.id);
  return `${String(frame.ordinal)}-${String(Number.isInteger(id) ? id : (node.backendNodeId ?? id))}`;
}

function tristate(value: unknown): WireChecked | undefined {
  return value === 'true' || value === 'false' || value === 'mixed' ? value : undefined;
}

function stateOf(build: Build, frameIndex: number, node: AxIn): WireState | undefined {
  const frame = build.frames[frameIndex];
  const props = node.props;
  const state: WireState = {};
  if (props.get('disabled') === true) state.disabled = true;
  else if (props.get('readonly') === true) state.readonly = true;
  // A toggle button's `aria-pressed` is its checked state in Blink's own model.
  const checked = tristate(props.get('checked')) ?? tristate(props.get('pressed'));
  if (checked !== undefined) state.checked = checked;
  const expanded = props.get('expanded');
  if (typeof expanded === 'boolean') state.expanded = expanded;
  const selected = props.get('selected');
  if (typeof selected === 'boolean') state.selected = selected;
  if (props.get('required') === true) state.required = true;
  const invalid = props.get('invalid');
  if (typeof invalid === 'string' && invalid !== 'false') state.invalid = true;
  if (props.get('multiline') === true) state.multiline = true;
  if (props.get('focused') === true) state.focused = true;
  const framePaint = build.framePaintHidden[frameIndex] === true;
  const paint = paintHiddenOf(frame?.dom, node.backendNodeId);
  if (framePaint || paint !== undefined) state.paintHidden = framePaint || paint === true;
  if (node.role === 'StaticText' || node.role === 'LabelText') {
    const target = textTarget(frame?.dom, node.backendNodeId);
    if (target.pointable) state.pointable = true;
    if (target.checked !== undefined) state.checked = target.checked;
  }
  return Object.keys(state).length === 0 ? undefined : state;
}

function emitChildren(build: Build, frameIndex: number, node: AxIn, parentName: string, depth: number, out: WireNode[]): void {
  if (depth >= MAX_DEPTH) {
    build.truncated = true;
    return;
  }
  // A frame boundary: the `<iframe>`'s node stands for the child frame's tree,
  // whose nodes carry that frame's ordinal.
  const child = build.childFrames.get(`${String(frameIndex)}:${node.id}`);
  if (child !== undefined) {
    const frame = build.frames[child];
    if (frame?.rootId !== undefined) {
      build.framePaintHidden[child] =
        build.framePaintHidden[frameIndex] === true || paintHiddenOf(build.frames[frameIndex]?.dom, node.backendNodeId) === true;
      emitNode(build, child, frame.rootId, parentName, depth + 1, out);
    }
    return;
  }
  for (const id of node.childIds) emitNode(build, frameIndex, id, parentName, depth + 1, out);
}

function emitNode(build: Build, frameIndex: number, id: string, parentName: string, depth: number, out: WireNode[]): void {
  const frame = build.frames[frameIndex];
  const node = frame?.nodes.get(id);
  if (frame === undefined || node === undefined || DROPPED_ROLES.has(node.role)) return;
  // Ignored is a pass-through, never a subtree drop: its children are
  // promoted. `hidden` is Blink's own not-rendered signal on a node CDP kept.
  const suppressed = node.ignored || node.role === 'none' || node.props.get('hidden') === true;
  const name = normalise(node.name);
  let kept = !suppressed && ACTIONABLE_ROLES.has(node.role);
  if (!kept && !suppressed && LABELLING_ROLES.has(node.role) && name !== '') {
    kept = !(TEXT_ROLES.has(node.role) && name === parentName);
  }
  const nextParent = kept && name !== '' ? name : parentName;
  if (!kept) {
    emitChildren(build, frameIndex, node, nextParent, depth, out);
    return;
  }
  if (build.emitted >= build.maxNodes) {
    build.truncated = true;
    return;
  }
  build.emitted += 1;
  const value = normalise(node.value);
  const state = stateOf(build, frameIndex, node);
  const children: WireNode[] = [];
  emitChildren(build, frameIndex, node, nextParent, depth, children);
  out.push({
    ref: refOf(frame, node),
    role: node.role,
    xpath: xpathOf(frame.dom, node.backendNodeId),
    ...(name === '' ? {} : { name }),
    ...(value === '' ? {} : { value }),
    ...(state === undefined ? {} : { state }),
    ...(children.length === 0 ? {} : { children }),
  });
}

/**
 * The filtered tree of `session`'s frame and every frame below it, in the
 * wire shape `Outcrawl.getAXTree` answers with: `{url, root, frameOrdinals}`.
 * Throws rather than truncates past `maxNodes` or the depth bound: a tree that
 * looks complete and is not is a model reading a page that does not exist.
 */
export async function stockAxTree(session: CdpPage, params: { readonly maxNodes?: number }): Promise<Record<string, unknown>> {
  const collection: Collection = { frames: [], childFrames: new Map() };
  await collect(session, collection);
  const top = collection.frames[0];
  const rootNode = top?.rootId === undefined ? undefined : top.nodes.get(top.rootId);
  if (top === undefined || rootNode === undefined) {
    throw new Error('Accessibility.getFullAXTree produced no tree for this session\'s frame');
  }
  const build: Build = {
    frames: collection.frames,
    childFrames: collection.childFrames,
    framePaintHidden: collection.frames.map(() => false),
    maxNodes: Math.max(1, params.maxNodes ?? DEFAULT_MAX_NODES),
    emitted: 0,
    truncated: false,
  };
  const rootName = normalise(rootNode.name);
  const children: WireNode[] = [];
  emitChildren(build, 0, rootNode, rootName, 0, children);
  if (build.truncated) {
    throw new Error(`Accessibility tree exceeded maxNodes (${String(build.maxNodes)}) or the depth bound (${String(MAX_DEPTH)})`);
  }
  const root: WireNode = {
    ref: refOf(top, rootNode),
    role: rootNode.role,
    xpath: xpathOf(top.dom, rootNode.backendNodeId),
    ...(rootName === '' ? {} : { name: rootName }),
    ...(children.length === 0 ? {} : { children }),
  };
  return {
    url: top.url,
    root,
    frameOrdinals: collection.frames.map((frame) => frame.ordinal),
  };
}
