/**
 * The page representation.
 *
 * Token costs measured on one catalogue page, from
 * `docs/specs/2026-08-29-product-surface.md` §6.4: a screenshot is ~50,000
 * tokens to a frontier model, raw HTML 9,824, the full accessibility tree
 * 5,951, and the tree filtered to interactive roles 742. The filter in this
 * file is the difference between the last two numbers, so it is not a tidying
 * pass — it is most of what a run costs.
 *
 * Three things live here: the node reference, the filter, and the hash the
 * action cache keys on.
 */

import { createHash } from 'node:crypto';

import type { NodeRef as WireNodeRef } from '@outcrawl/scout-core';

import { NATIVE_DATE_FORMAT, type NativeDateKind } from './native-date';

/* ------------------------------------------------------------------ *
 * The node reference
 * ------------------------------------------------------------------ */

declare const nodeRefBrand: unique symbol;

/**
 * A frame-qualified node reference. **Never a bare `backendNodeId`.**
 *
 * `DOMNodeIds::IdToNodeMap()` in Blink is a per-*renderer-process* static, and
 * cross-origin iframes run in separate renderer processes under Site
 * Isolation. Two nodes in two frames can therefore carry the same
 * `backendNodeId`, and an action resolved from the wrong one lands on the
 * wrong element. That bug is intermittent, cross-origin only and very
 * confusing to find, so the frame ordinal is part of the reference rather than
 * an argument travelling beside it.
 *
 * The brand is phantom — nothing carries it at runtime. It exists so a raw
 * integer or an ad-hoc object literal cannot be passed where a reference is
 * expected: `nodeRef()` is the only way to mint one, which makes validation
 * unavoidable rather than customary.
 */
export interface NodeRef {
  /**
   * The browser's own `FrameTreeNodeId` for the owning frame — NOT a position
   * in the stitched tree, which is what this comment used to say.
   *
   * The distinction is load-bearing and this file had it wrong. The PDL
   * (`0010-tenancy.patch`, `FilteredAXNode.ref`) declares it "the browser's own
   * FrameTreeNodeId, which is unique for the life of the browser process and
   * never reused". It is browser-GLOBAL and monotonic, not per-page and not
   * zero-based: on a long-lived worker it climbs into the tens of thousands, and
   * a top document is very rarely 0.
   *
   * That global uniqueness is exactly what makes multi-tab work safe. If the
   * ordinal were a position in one page's tree, every tab's main frame would be
   * 0 and a reference minted on tab A would resolve against tab B. Because it is
   * a browser-wide id, tab A's nodes simply cannot be mistaken for tab B's, and
   * a stale cross-tab reference fails validation instead of clicking the wrong
   * thing on the wrong page.
   *
   * Not to be confused with `startCapture`'s frame ordinal, which is a DIFFERENT
   * space: client-chosen, and 0 there does mean the main frame.
   */
  readonly frameOrdinal: number;
  /**
   * The id `Outcrawl.getAXTree` minted for this node: `ui::AXNodeData::id`,
   * NOT a DevTools backend node id, despite the name this field has carried
   * since it was written. Meaningless without the frame ordinal.
   *
   * Signed. Blink numbers AX objects that have no DOM node behind them —
   * list markers, generated content, anonymous boxes — from near `INT_MIN/2`
   * DOWNWARD, so a perfectly ordinary page yields ids like `-1000000073`.
   */
  readonly backendNodeId: number;
  readonly [nodeRefBrand]: 'NodeRef';
}

/**
 * Mints a reference. Both halves must be integers and `frameOrdinal` at least
 * 0. `backendNodeId` may be negative — see the field — but never 0, which is
 * `ui::kInvalidAXNodeID`: a zero id is a resolution failure that has been
 * allowed to travel.
 */
export function nodeRef(frameOrdinal: number, backendNodeId: number): NodeRef {
  if (!Number.isInteger(frameOrdinal) || frameOrdinal < 0) {
    throw new RangeError(`frameOrdinal must be a non-negative integer, got ${String(frameOrdinal)}`);
  }
  if (!Number.isInteger(backendNodeId) || backendNodeId === 0) {
    throw new RangeError(`backendNodeId must be a non-zero integer, got ${String(backendNodeId)}`);
  }
  return { frameOrdinal, backendNodeId } as unknown as NodeRef;
}

/**
 * The runtime half of the type-level guarantee. Model output arrives as
 * `unknown`, where the compiler cannot help, so every reference crossing that
 * boundary is checked here.
 */
export function isNodeRef(value: unknown): value is NodeRef {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { frameOrdinal?: unknown; backendNodeId?: unknown };
  return (
    typeof candidate.frameOrdinal === 'number' &&
    Number.isInteger(candidate.frameOrdinal) &&
    candidate.frameOrdinal >= 0 &&
    typeof candidate.backendNodeId === 'number' &&
    Number.isInteger(candidate.backendNodeId) &&
    candidate.backendNodeId !== 0
  );
}

export function sameRef(a: NodeRef, b: NodeRef): boolean {
  return a.frameOrdinal === b.frameOrdinal && a.backendNodeId === b.backendNodeId;
}

/**
 * The wire form — `@outcrawl/scout-core`'s `NodeRef`, `"<frameOrdinal>-<backendNodeId>"`.
 *
 * The struct is loop-internal; the string is what crosses a package boundary:
 * `ObservedAction`, the action cache, the API. This function and
 * `parseNodeRef` are the only two places the two forms meet.
 */
export function formatNodeRef(ref: NodeRef): WireNodeRef {
  return `${ref.frameOrdinal}-${ref.backendNodeId}`;
}

/**
 * Reads the wire form back. Returns `undefined` rather than throwing: the
 * input is a stored string from the action cache or an API body, so malformed
 * input is a data condition to handle, not a programming error to crash on.
 *
 * The second component is **signed**, and that is not a tolerance — it is the
 * only correct reading. `Outcrawl.getAXTree` mints refs from `ui::AXNodeData`'s
 * `id`, not from a DevTools backend node id, and Blink hands out NEGATIVE ids
 * for AX objects with no DOM node behind them: list markers, generated content,
 * anonymous layout boxes. `AXObjectCacheImpl::GenerateAXID` starts near
 * `INT_MIN/2` and counts DOWN, so a generated node reads as `2--1000000073`.
 *
 * An earlier version required `> 0`, which is the right guard for the backend
 * node id this field is misnamed after and the wrong one for what it holds. It
 * rejected every generated node, and because the caller in `agent-deps` throws
 * rather than drops, one list marker anywhere in the tree failed the whole
 * agent run. Found by the first end-to-end run against a real page.
 *
 * Zero stays refused: `ui::kInvalidAXNodeID` is 0.
 */
export function parseNodeRef(wire: string): NodeRef | undefined {
  const match = /^(\d+)-(-?\d+)$/.exec(wire);
  if (match === null) {
    return undefined;
  }
  const frameOrdinal = Number(match[1]);
  const backendNodeId = Number(match[2]);
  if (!Number.isSafeInteger(frameOrdinal) || !Number.isSafeInteger(backendNodeId)) {
    return undefined;
  }
  if (frameOrdinal < 0 || backendNodeId === 0) {
    return undefined;
  }
  return { frameOrdinal, backendNodeId } as unknown as NodeRef;
}

/* ------------------------------------------------------------------ *
 * The tree
 * ------------------------------------------------------------------ */

/** Accessibility state worth spending tokens on. Everything else is dropped. */
export interface AxState {
  readonly disabled?: boolean;
  readonly checked?: boolean | 'mixed';
  readonly expanded?: boolean;
  readonly selected?: boolean;
  readonly required?: boolean;
  /**
   * WHAT THIS FORK PUTS HERE DOES NOT MEAN INVALID. Do not read it, and do not
   * write a rule against it, until the emitter is fixed.
   *
   * Measured on 2026-09-08 against the shipped binary with
   * `packages/runtime/scripts/probe-error-signals.ts`, on `saucedemo.com`:
   * 3 of 13 nodes on the login page and 8 of 55 on the inventory page arrive
   * with `invalid: true`, and every one of them is an ordinary control — both
   * textboxes, the Login button, the sort combobox and all six Add-to-cart
   * buttons. Nothing on either page is in an invalid state.
   *
   * Two consequences, and the second is now fixed one layer up:
   *
   * 1. `./verify.ts` does not consult it. An outcome check that trusted it
   *    contradicted a Login click that had really logged in and navigated.
   * 2. `serializeTree` no longer renders it — see the exclusion note there,
   *    landed in `2ae9103`. Until that commit every prompt this product had
   *    ever sent told the model that most controls on the page were invalid,
   *    which is tokens spent to misinform on the live path. It is dropped at
   *    RENDER and deliberately not at TRANSPORT: `agent-deps.ts` still forwards
   *    it in `BOOLEAN_STATE_KEYS`, because deleting it there would make
   *    `probe-error-signals.ts` report zero and read as a fixed emitter.
   *
   * The remaining fix is in the emitter or in the fork's own AX mapping, which
   * is why it is still not made here. This is the field's definition, where
   * every reader meets it, so the measurement lives here rather than in a
   * commit message — and the exclusion above carries its own deletion
   * condition: drop it when the probe reports zero against a fixed fork.
   */
  readonly invalid?: boolean;
  readonly readonly?: boolean;
  readonly multiline?: boolean;
  /** Deliberately excluded from `hashSnapshot`. See the note there. */
  readonly focused?: boolean;
  /** Filtered out by default: the model cannot act on what it cannot see. */
  readonly hidden?: boolean;
  /** Chromium's own `ignored` flag on the AX node. */
  readonly ignored?: boolean;
  /**
   * Renderer paint suppression, including ancestor zero opacity. Not viewport
   * clipping and not AX exclusion: retain keyboard-operable controls and label
   * invisible prose honestly rather than treating it as visible confirmation.
   */
  readonly paintHidden?: boolean;
  /** Native text has a real click target or an associated enabled label control. */
  readonly pointable?: boolean;
  /**
   * The first segment of a native date/time input, by the input's kind. Set
   * by the binding only where the element is one of Blink's own date-time
   * segments, never from a name, because a fill of the whole value works only
   * there (`nativeDatePlan` in the binding). Rendered as how to fill it.
   */
  readonly nativeDate?: NativeDateKind;
}

export interface AxNode {
  readonly ref: NodeRef;
  /** ARIA role name: `button`, `link`, `textbox`, `heading`, `StaticText`. */
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly state?: AxState;
  /**
   * Absolute XPath, and required rather than optional because it is the heal
   * path. A `NodeRef` is provably valid only while the page is frozen and dies
   * when a node is genuinely recreated; a cached action replayed in a later
   * session has nothing else to resolve against. An emitter that cannot
   * produce one says so with `''` rather than by silently omitting the field.
   */
  readonly xpath: string;
  /**
   * Where this element links to: absolute, resolved against the base URL of
   * its OWN document, which inside an iframe is not the page's. Any role can
   * carry one, because `<a href role="button">` is a link to the browser and a
   * button to the accessibility tree.
   *
   * Never set by `Outcrawl.getAXTree`, whose nodes carry no URL. The worker
   * reads it for an extraction that asks for a destination
   * (`worker/src/link-hrefs.ts`), so the action prompt, which is capped in
   * characters, spends nothing on it. Deliberately NOT part of
   * {@link hashSnapshot}: the hash keys the action cache on what the actor is
   * shown, and the actor is not shown this.
   */
  readonly href?: string;
  readonly children?: readonly AxNode[];
}

export interface AxTree {
  /** Final URL of the top document. Part of the cache key; not part of the hash. */
  readonly url: string;
  readonly root: AxNode;
  /**
   * What the read of link destinations did, on a tree it ran on. Absent on
   * every other tree, which is every tree the action prompt reads.
   *
   * `read` with `omitted` counts destinations that were read and not shown
   * because the extraction's budget for them ran out; `unread` means none were
   * read, and `why` says why. Both are stated to the model by
   * {@link serializeTree}, because a line without `->` must not be read as a
   * link that goes nowhere when the truth is that nobody looked.
   */
  readonly hrefs?: HrefRead;
}

export type HrefRead =
  | { readonly outcome: 'read'; readonly omitted: number }
  | { readonly outcome: 'unread'; readonly why: string };

/** The line that states what {@link AxTree.hrefs} withheld, or `undefined` when nothing was. */
function hrefNotice(read: HrefRead | undefined): string | undefined {
  if (read === undefined || (read.outcome === 'read' && read.omitted === 0)) {
    return undefined;
  }
  return read.outcome === 'read'
    ? `[${String(read.omitted)} more link destinations were read and not shown, to fit this extraction's ` +
        'budget for them. Their lines are the ones without -> after the last line that has one; a missing -> ' +
        'there means not shown, not nowhere.]'
    : `[Link destinations were not read on this page (${read.why}), so no line carries ->. A missing -> ` +
        'here means not read, not nowhere: say the destination could not be read rather than guessing one.]';
}

/* ------------------------------------------------------------------ *
 * Roles
 * ------------------------------------------------------------------ */

/**
 * Roles a model may act on. Kept even when unnamed — an icon button with no
 * accessible name is exactly the node an agent has to reach.
 */
export const ACTIONABLE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

/** Roles that label the page. Kept only when they carry a name. */
export const LABELLING_ROLES: ReadonlySet<string> = new Set([
  'alert',
  'caption',
  'heading',
  'image',
  'LabelText',
  'status',
  'StaticText',
  'tooltip',
]);

/**
 * Labelling roles whose line still carries a reference, because a POINTER on
 * them does something: hovering an image is how a hover card, a zoom or an
 * overlaid "View profile" appears, and clicking a thumbnail is how a gallery
 * opens. They are not {@link ACTIONABLE_ROLES}: the settle, the tree ceiling's
 * reserve and every actionable count keep meaning controls.
 *
 * Measured in production on 2026-09-24 (IW11-hover, fleet 54476fe6,
 * `run_…`, `run_…`, `run_…`): asked to hover the first
 * avatar on the-internet.herokuapp.com/hovers, the model saw three
 * `img "User Avatar"` lines with no reference on any of them, said so ("no
 * backendNode references are provided for them ... Only external links have
 * refs"), and made ids up instead — `1415-231` and `1415-233` refused as not
 * in the snapshot, `1413-311` and `1414-231` landing on nodes with a 0x0 box.
 * 0 of 3 runs hovered the avatar.
 */
const POINTABLE_ROLES: ReadonlySet<string> = new Set(['image']);

/**
 * Dropped outright. `InlineTextBox` is the layout-level duplicate of
 * `StaticText` — 391 of them on the measured page, all redundant.
 */
export const DROPPED_ROLES: ReadonlySet<string> = new Set(['InlineTextBox', 'LineBreak']);

/** Roles whose name is the text itself, so they can duplicate their container's. */
const TEXT_ROLES: ReadonlySet<string> = new Set(['StaticText', 'text', 'LabelText', 'caption']);

/* ------------------------------------------------------------------ *
 * The filter
 * ------------------------------------------------------------------ */

export interface FilterOptions {
  /** Defaults to `ACTIONABLE_ROLES`. */
  readonly actionableRoles?: ReadonlySet<string>;
  /** Defaults to `LABELLING_ROLES`. */
  readonly labellingRoles?: ReadonlySet<string>;
  /** Defaults to `DROPPED_ROLES`. */
  readonly droppedRoles?: ReadonlySet<string>;
  /** Keep nodes flagged hidden or ignored. Default false. */
  readonly keepHidden?: boolean;
  /** Drop text whose name repeats the nearest kept ancestor's. Default true. */
  readonly dedupeText?: boolean;
}

interface ResolvedFilter {
  readonly actionableRoles: ReadonlySet<string>;
  readonly labellingRoles: ReadonlySet<string>;
  readonly droppedRoles: ReadonlySet<string>;
  readonly keepHidden: boolean;
  readonly dedupeText: boolean;
}

function resolveFilter(opts: FilterOptions): ResolvedFilter {
  return {
    actionableRoles: opts.actionableRoles ?? ACTIONABLE_ROLES,
    labellingRoles: opts.labellingRoles ?? LABELLING_ROLES,
    droppedRoles: opts.droppedRoles ?? DROPPED_ROLES,
    keepHidden: opts.keepHidden ?? false,
    dedupeText: opts.dedupeText ?? true,
  };
}

/** Trims and collapses whitespace. `''` becomes absent, not empty. */
function normaliseName(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? undefined : collapsed;
}

function rebuild(node: AxNode, children: readonly AxNode[]): AxNode {
  const name = normaliseName(node.name);
  const value = normaliseName(node.value);
  return {
    ref: node.ref,
    role: node.role,
    ...(name !== undefined ? { name } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(node.state !== undefined ? { state: node.state } : {}),
    ...(node.href !== undefined ? { href: node.href } : {}),
    xpath: node.xpath,
    ...(children.length > 0 ? { children } : {}),
  };
}

/**
 * Decided before recursing, deliberately: keep/drop depends only on the node
 * itself, so the *kept* ancestor's name can be threaded down and the filter is
 * then reproducible on its own output.
 */
function isKept(
  node: AxNode,
  name: string | undefined,
  parentName: string | undefined,
  f: ResolvedFilter,
): boolean {
  if (f.actionableRoles.has(node.role)) {
    return true;
  }
  if (!f.labellingRoles.has(node.role) || name === undefined) {
    return false;
  }
  return !(f.dedupeText && TEXT_ROLES.has(node.role) && name === parentName);
}

function filterNode(node: AxNode, parentName: string | undefined, f: ResolvedFilter): readonly AxNode[] {
  if (f.droppedRoles.has(node.role)) {
    return [];
  }
  if (!f.keepHidden && (node.state?.hidden === true || node.state?.ignored === true)) {
    return [];
  }

  const name = normaliseName(node.name);
  const kept = isKept(node, name, parentName, f);
  const nextParent = kept && name !== undefined ? name : parentName;

  const children: AxNode[] = [];
  for (const child of node.children ?? []) {
    children.push(...filterNode(child, nextParent, f));
  }

  // A container that is neither actionable nor labelling offers the model
  // nothing, so its kept descendants are promoted into its parent instead of
  // paying for a wrapper line each.
  return kept ? [rebuild(node, children)] : children;
}

/**
 * Drops every node that is neither actionable nor labelling and promotes the
 * survivors. The root is always kept as the anchor even when its own role is
 * not, so the result is a tree rather than a forest.
 */
export function filterTree(full: AxTree, opts: FilterOptions = {}): AxTree {
  const f = resolveFilter(opts);
  const rootName = normaliseName(full.root.name);
  const children: AxNode[] = [];
  for (const child of full.root.children ?? []) {
    children.push(...filterNode(child, rootName, f));
  }
  return {
    url: full.url,
    root: rebuild(full.root, children),
    ...(full.hrefs === undefined ? {} : { hrefs: full.hrefs }),
  };
}

/** Every node in the tree, depth-first, parents before children. */
export function walk(tree: AxTree): readonly AxNode[] {
  const out: AxNode[] = [];
  const visit = (node: AxNode): void => {
    out.push(node);
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(tree.root);
  return out;
}

/** Lookup by reference, keyed on the composite so frames cannot collide. */
export function indexTree(tree: AxTree): ReadonlyMap<string, AxNode> {
  const index = new Map<string, AxNode>();
  for (const node of walk(tree)) {
    index.set(formatNodeRef(node.ref), node);
  }
  return index;
}

export function findNode(tree: AxTree, ref: NodeRef): AxNode | undefined {
  return indexTree(tree).get(formatNodeRef(ref));
}

/**
 * Whether two reads of a node are reads of the SAME node.
 *
 * Role and name, and never the reference: the reference is precisely what a
 * heal path replaces, so comparing it here would make `refreshChoice`'s xpath
 * rung unreachable. A node that has become `disabled` is not the same node
 * either — acting on it is an input the page discards and a step the run pays
 * for.
 *
 * Deliberately NOT the whole node: `value` is excluded because a field the
 * model is about to type into may legitimately have changed value under a
 * re-render, and children are excluded because a button whose label span was
 * re-created is the same button.
 *
 * HERE rather than in the loop, and that is not tidying. Three gates now ask
 * this one question of two trees — `refreshChoice` across the think window,
 * `chainAbort` across a motor program, and `fanAbort` across tabs — and the
 * question is about two `AxNode`s and nothing else. A second copy of it is how
 * two gates come to disagree about what "the same node" means, which is the
 * disagreement that decides whether a click lands on the button the model
 * chose.
 */
export function sameNode(before: AxNode, after: AxNode): boolean {
  return (
    before.role === after.role &&
    (before.name ?? '') === (after.name ?? '') &&
    after.state?.disabled !== true
  );
}

/* ------------------------------------------------------------------ *
 * The hash
 * ------------------------------------------------------------------ */

const HASH_VERSION = 'ax1';
const UNIT = '\u001f';
const RECORD = '\u001e';

function canonicalState(state: AxState | undefined): string {
  if (state === undefined) {
    return '';
  }
  const entries: string[] = [];
  for (const [key, value] of Object.entries(state)) {
    // Focus follows the agent's own last action. Hashing it would mean an
    // identical page visited twice never matches itself, which is exactly the
    // repeat-run case the cache exists for.
    if (key === 'focused' || value === undefined) {
      continue;
    }
    entries.push(`${key}=${String(value)}`);
  }
  entries.sort();
  return entries.join(',');
}

function digestNode(node: AxNode): string {
  const children: string[] = [];
  for (const child of node.children ?? []) {
    children.push(digestNode(child));
  }
  // Sorting the child digests is what makes a sibling reordering invisible.
  // The model addresses nodes by reference and never by position, so two trees
  // differing only in sibling order offer it exactly the same moves.
  children.sort();

  const hash = createHash('sha256');
  hash.update(node.role);
  hash.update(UNIT);
  hash.update(normaliseName(node.name) ?? '');
  hash.update(UNIT);
  hash.update(normaliseName(node.value) ?? '');
  hash.update(UNIT);
  hash.update(canonicalState(node.state));
  hash.update(RECORD);
  for (const child of children) {
    hash.update(child);
    hash.update(UNIT);
  }
  return hash.digest('hex');
}

/**
 * The action cache's key input.
 *
 * Three guarantees, all load-bearing for the cache:
 * - identical trees hash identically, in this process and any other;
 * - a sibling reordering that offers the model the same moves does not change it;
 * - an actionable element appearing or disappearing **does** change it. A hash
 *   that ignored a new button would be a cache hit that clicks the wrong thing.
 *
 * Node references are deliberately **not** hashed. Backend node ids are minted
 * per renderer process, so the same page navigated twice carries different
 * ones; hashing them would mean the cache never hit on the repeat runs — crawl
 * and monitor workloads — that it exists to serve. The consequence is that a
 * cached action's `ref` is dead in a later session and must be re-resolved
 * through its XPath.
 *
 * `sha256` from `node:crypto`, not a seeded non-cryptographic hash, because the
 * value is persisted and compared across processes.
 */
export function hashSnapshot(tree: AxTree): string {
  return `${HASH_VERSION}:${digestNode(tree.root)}`;
}

/* ------------------------------------------------------------------ *
 * Serialisation
 * ------------------------------------------------------------------ */

/** Abbreviated role codes. A role with no code is emitted as its own name. */
export const ROLE_CODES: ReadonlyMap<string, string> = new Map([
  ['RootWebArea', 'doc'],
  ['StaticText', 'txt'],
  ['button', 'btn'],
  ['checkbox', 'chk'],
  ['combobox', 'cmb'],
  ['heading', 'h'],
  ['image', 'img'],
  ['LabelText', 'lbl'],
  ['link', 'a'],
  ['listbox', 'lst'],
  ['menuitem', 'mi'],
  ['option', 'opt'],
  ['radio', 'rad'],
  ['searchbox', 'srch'],
  ['spinbutton', 'spin'],
  ['switch', 'sw'],
  ['textbox', 'inp'],
  ['treeitem', 'tree'],
]);

export interface SerializeOptions {
  /** Longest name or value emitted, in characters. Default 120. */
  readonly maxNameLength?: number;
  /** Roles that get a reference emitted. Defaults to `ACTIONABLE_ROLES`. */
  readonly actionableRoles?: ReadonlySet<string>;
  readonly roleCodes?: ReadonlyMap<string, string>;
  /**
   * Total character ceiling on the emitted tree. Absent means unbounded, which
   * is what the extraction path and `observe` want: a customer's answer is read
   * off the whole page, and cropping THAT is cropping the product.
   *
   * Characters and not tokens, deliberately. A token count needs a tokenizer,
   * a tokenizer is per-vendor, and this package has no provider in it. Measured
   * on real rendered prompts the ratio is 2.52 to 3.68 chars per token — 2.90
   * on the 573-comment Hacker News thread that is this repo's worst case — so a
   * caller converting a token budget at 2.5 cannot overshoot it.
   */
  readonly maxChars?: number;
  /**
   * How much of `maxChars` is held back for actionable nodes that fall BEYOND
   * the part of the page that fitted. Defaults to a fifth of `maxChars`.
   *
   * This is the whole difference between a ceiling and a blindfold. A long form
   * puts its submit button at the BOTTOM, so a ceiling that simply stops when
   * it runs out of room drops the one node the step needed and the agent
   * concludes the button does not exist. The reserve buys those nodes back.
   */
  readonly reserveChars?: number;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}\u2026`;
}

/**
 * The state flags the model is shown.
 *
 * `hidden` and `ignored` are excluded because a node that survived filtering is
 * neither, so the flag would be noise on every line that could carry it.
 *
 * ── `invalid` IS EXCLUDED BECAUSE THIS FORK'S IS NOT A FACT ────────────────
 *
 * Measured on 2026-09-08 with `scripts/probe-error-signals.ts` against the
 * shipped binary on `saucedemo.com`: 3 of 13 nodes on the login page and 8 of
 * 55 on the inventory page arrive with `invalid: true`, and every one is an
 * ordinary control — both textboxes, the Login button, the sort combobox, all
 * six Add-to-cart buttons. Nothing on either page is in an invalid state.
 *
 * It was not inert, and that is why this is a change rather than a note. This
 * function renders state into the prompt, so EVERY agent run this fleet has
 * ever served has told the model that most of the controls in front of it are
 * invalid — a field the prompt asks the model to trust, saying the opposite of
 * the truth, on every step of every run. The same shape as the dropped space
 * and the ungrammatical envelope: the failing state renders identically to the
 * passing one from the only vantage anyone was reading from.
 *
 * ── Why it is dropped HERE and still carried on `AxState` ──────────────────
 *
 * The obvious fix is to stop transporting it in `BOOLEAN_STATE_KEYS`, and it is
 * wrong: `probe-error-signals.ts` reads `node.state?.invalid` through the same
 * binding, so a tree that no longer carries the field makes the probe report
 * ZERO — which reads as "the emitter is fixed" when nothing has changed. That
 * is tonight's defect in the instrument built to detect it, and it is the
 * twenty-sixth instance rather than a hypothetical.
 *
 * So the field is still emitted, still hashed by `canonicalState` (so a change
 * in the emitter moves the hash rather than passing unnoticed), still readable
 * by the probe, and no longer spent on tokens or believed by a model. DELETE
 * THIS EXCLUSION when the probe reports zero against a fork whose AX mapping
 * has been fixed — and not before, because the probe reporting zero is the
 * only evidence that would justify it.
 */
function stateProps(state: AxState | undefined): string {
  if (state === undefined) {
    return '';
  }
  const flags: string[] = [];
  for (const [key, value] of Object.entries(state)) {
    if (
      value === false ||
      value === undefined ||
      key === 'hidden' ||
      key === 'ignored' ||
      key === 'invalid'
    ) {
      continue;
    }
    if (key === 'paintHidden') {
      flags.push('not visible: not painted, not a visible confirmation');
      continue;
    }
    if (key === 'nativeDate' && typeof value === 'string' && value in NATIVE_DATE_FORMAT) {
      const kind = value as NativeDateKind;
      const what = kind === 'datetime-local' ? 'date and time' : kind;
      flags.push(`first part of a ${what} field: fill it with the whole ${what}, as ${NATIVE_DATE_FORMAT[kind]}`);
      continue;
    }
    flags.push(value === true ? key : `${key}=${String(value)}`);
  }
  return flags.length > 0 ? ` (${flags.join(' ')})` : '';
}

/**
 * What a ceiling dropped, in the model's own terms.
 *
 * Announced and never silent, because a silently cropped page is how an agent
 * concludes a button does not exist and then spends its whole budget looking
 * for it. The line names the counts, and then it names the ONE thing the model
 * would otherwise get wrong: scrolling cannot help. This representation has no
 * viewport in it — {@link AxNode} carries no geometry at all — so a scroll
 * returns a byte-identical tree, and "scroll for more" would be a lie that
 * costs a step every time it is believed.
 */
function elisionNotice(omittedText: number, omittedActionable: number, total: number): string {
  const omitted = omittedText + omittedActionable;
  return (
    `[${String(omitted)} of ${String(total)} page nodes omitted to fit this step's budget: ` +
    `${String(omittedText)} text, ${String(omittedActionable)} actionable. They are further down the ` +
    'page and SCROLLING WILL NOT REVEAL THEM — this tree has no viewport, so a scroll returns the ' +
    'same lines. To read the whole page use {"type":"extract","instruction":"..."}, which sees all ' +
    'of it; to act on something not listed, navigate to a page that shows it.]'
  );
}

/**
 * The tuple shape the model reads: `depth role "name" (state) [ref] ->"href"`,
 * one node per line. References are emitted for actionable nodes and for
 * {@link POINTABLE_ROLES} only — a reference on a heading is a token spent
 * inviting an action that cannot work.
 *
 * ── Where an iframe begins ───────────────────────────────────────────────────
 *
 * The fork emits an iframe's content in place, promoted under whatever kept
 * node encloses the frame, and drops the `<iframe>` element and the frame's
 * root on the way (neither is actionable or labelling). Without a marker the
 * frame boundary existed only as a change of number inside refs, and only on
 * actionable lines. Measured in production on 2026-09-24 (IW34-iframe,
 * `run_…`, `run_…`, fleet 54476fe6): told to read the text of
 * w3schools' embedded tutorial frame, the extraction model answered `""` on 7
 * of 7 iframe-scoped extracts across two runs — the frame's text WAS in the
 * tree ("HTML is the standard markup language for Web pages."), it simply
 * could not tell which lines were inside the frame. So the first line of each
 * run of a frame's content, where its frame differs from its parent line's,
 * says `(inside iframe)`; the lines nested under it are in that frame too.
 * A page with one frame renders byte-for-byte as before.
 *
 * ── The ceiling ──────────────────────────────────────────────────────────────
 *
 * With `maxChars` set, the emitted tree is bounded in two passes, and the two
 * are chosen because neither alone is correct on both shapes of page:
 *
 * 1. A DOCUMENT-ORDER PREFIX, spending everything but the reserve. Document
 *    order and not a ranking, because it is the only order that keeps a page
 *    readable: each comment's text stays next to its own reply link, and the
 *    depth column still describes a real hierarchy. Measured on a 573-comment
 *    Hacker News thread, ranking by actionability instead keeps 485 of 2,918
 *    links and ZERO labelling text — a page of naked "reply" and "parent" links
 *    with nothing to tell them apart, which is blinder than truncation.
 * 2. THE RESERVE, spent on actionable nodes only, from where the prefix
 *    stopped to the end of the tree. This is the case for a ceiling ranked by
 *    actionability, and it is real: a long form's submit button is at the
 *    bottom, and losing it turns a cost problem into a failed run.
 *
 * Survivors are emitted in document order regardless of which pass claimed
 * them, so the model reads one coherent list, and the elision is stated.
 */
export function serializeTree(tree: AxTree, opts: SerializeOptions = {}): string {
  const maxNameLength = opts.maxNameLength ?? 120;
  const actionableRoles = opts.actionableRoles ?? ACTIONABLE_ROLES;
  const codes = opts.roleCodes ?? ROLE_CODES;

  const lines: string[] = [];
  const isActionable: boolean[] = [];
  const visit = (node: AxNode, depth: number, parentFrame: number): void => {
    let line = `${String(depth)} ${codes.get(node.role) ?? node.role}`;
    if (node.name !== undefined) {
      line += ` ${JSON.stringify(truncate(node.name, maxNameLength))}`;
    }
    if (node.value !== undefined) {
      line += `=${JSON.stringify(truncate(node.value, maxNameLength))}`;
    }
    line += stateProps(node.state);
    if (node.ref.frameOrdinal !== parentFrame) {
      line += ' (inside iframe)';
    }
    const acts = actionableRoles.has(node.role) || node.state?.pointable === true;
    if (acts || POINTABLE_ROLES.has(node.role)) {
      line += ` [${formatNodeRef(node.ref)}]`;
    }
    // Last on the line, so the part every prompt shares reads the same with
    // or without it: a tree read with no hrefs renders byte-for-byte as before.
    //
    // WHOLE, never clipped: a URL cut short is not a shorter URL, it is a
    // wrong one, and this is the text an answer is copied from. The total is
    // bounded where the hrefs are read (`worker/src/link-hrefs.ts`), which
    // drops whole destinations and says so. JSON-quoted like the name and
    // value, so a destination cannot carry a forged `[ref]` or a second `->`.
    if (node.href !== undefined) {
      line += ` ->${JSON.stringify(node.href)}`;
    }
    lines.push(line);
    isActionable.push(acts);
    for (const child of node.children ?? []) {
      visit(child, depth + 1, node.ref.frameOrdinal);
    }
  };
  visit(tree.root, 0, tree.root.ref.frameOrdinal);

  // Paid for out of `maxChars` like the elision notice below, and in practice
  // only ever on an extraction tree, which has no `maxChars`.
  const notice = hrefNotice(tree.hrefs);
  const tail = notice === undefined ? '' : `\n${notice}`;
  const joined = lines.join('\n');
  const maxChars = opts.maxChars === undefined ? undefined : Math.max(0, opts.maxChars - tail.length);
  if (maxChars === undefined || joined.length <= maxChars) {
    return joined + tail;
  }

  // The notice is paid for out of the budget, not added on top of it: a cap
  // that overshoots by the size of its own confession is not a cap. Sized on
  // the real counts, which are not known yet, so the worst case is reserved —
  // every count is bounded by the node count, which is already known.
  const worstNotice = elisionNotice(lines.length, lines.length, lines.length).length + 1;
  const budget = Math.max(0, maxChars - worstNotice);
  const reserve = Math.min(budget, opts.reserveChars ?? Math.floor(maxChars / 5));

  const kept: boolean[] = lines.map(() => false);
  let spent = 0;
  let index = 0;
  for (; index < lines.length; index += 1) {
    const cost = lines[index]!.length + 1;
    if (spent + cost > budget - reserve) {
      break;
    }
    kept[index] = true;
    spent += cost;
  }
  // BACKWARD, from the end of the page toward where the prefix stopped, and
  // the direction is the whole value of the reserve. It looks arbitrary; it is
  // the result of running both. On the real 573-comment Hacker News thread,
  // spending the reserve FORWARD left the survivors spanning document
  // positions 1-500 of 5,704: the budget went on two hundred more identical
  // reply links sitting just past the prefix, and the "More" link that reaches
  // page two was still missing. Backward, the survivors span 1-5,703 and that
  // link is there. The controls a step needs from a page too long to show are
  // TERMINAL — a form's submit, a thread's "More", a list's "Next" — and no
  // other action recovers them: scrolling cannot change this tree. Forward was
  // cheaper-looking and silently removed the ability to page a long thread.
  for (let rest = lines.length - 1; rest >= index; rest -= 1) {
    const cost = lines[rest]!.length + 1;
    if (!isActionable[rest] || spent + cost > budget) {
      continue;
    }
    kept[rest] = true;
    spent += cost;
  }

  let omittedText = 0;
  let omittedActionable = 0;
  const survivors: string[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    if (kept[at] === true) {
      survivors.push(lines[at]!);
    } else if (isActionable[at] === true) {
      omittedActionable += 1;
    } else {
      omittedText += 1;
    }
  }
  survivors.push(elisionNotice(omittedText, omittedActionable, lines.length));
  return survivors.join('\n') + tail;
}
