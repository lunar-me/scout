import { parseNodeRef, type AxNode, type AxState, type AxTree } from '@outcrawl/runtime';

/* ------------------------------------------------------------------ *
 * Wire -> AxTree
 * ------------------------------------------------------------------ */

/**
 * `Outcrawl.AXNodeState` as it arrives.
 *
 * Every field is `unknown` on purpose. The names come from the PDL so a reader
 * can check them against it, and the types do not, because nothing has looked
 * at the values yet — `checked` in particular is a string here and a
 * `boolean | 'mixed'` by the time it is an `AxState`.
 */
type WireAxState = { readonly [K in keyof AxState]?: unknown };

/** `Outcrawl.FilteredAXNode` as it arrives. Same reasoning as {@link WireAxState}. */
type WireAxNode = {
  readonly ref?: unknown;
  readonly role?: unknown;
  readonly name?: unknown;
  readonly value?: unknown;
  readonly state?: unknown;
  readonly xpath?: unknown;
  readonly children?: unknown;
};

/**
 * `Outcrawl.AXNodeState` fields that are plain booleans on both sides.
 *
 * `invalid` IS KNOWN WRONG ON THE WAY IN, and it is passed through anyway
 * because this function's job is transport and the defect is upstream of it.
 * Measured on 2026-09-08 with `packages/runtime/scripts/probe-error-signals.ts`
 * against the shipped binary on `saucedemo.com`: 3 of 13 nodes on the login
 * page and 8 of 55 on the inventory page arrive with `invalid: true`, and every
 * one is an ordinary control — both textboxes, the Login button, the sort
 * combobox, all six Add-to-cart buttons. Nothing on either page is invalid.
 *
 * It was not inert. `serializeTree` rendered state into the prompt, so until
 * `2ae9103` every agent run this fleet had served told the model that most of
 * the controls it was looking at were invalid. `serializeTree` now excludes it.
 *
 * IT IS STILL FORWARDED HERE, ON PURPOSE. Dropping it from this list would make
 * `packages/runtime/scripts/probe-error-signals.ts` — which reads
 * `node.state?.invalid` through this very mapping — report zero, which reads as
 * a fixed emitter rather than a hidden field: tonight's defect, installed
 * inside the instrument built to detect it. Transport stays honest and the
 * exclusion lives at render, with its own deletion condition: remove it when
 * the probe reports zero against a fixed fork, and not before.
 *
 * The remaining fix belongs to whoever owns the fork's AX mapping; until then
 * nothing may conclude anything from this field, and `@outcrawl/runtime`'s
 * outcome check deliberately does not read it. See the note on
 * `AxState.invalid` in `packages/runtime/src/snapshot.ts`.
 */
const BOOLEAN_STATE_KEYS = [
  'disabled',
  'expanded',
  'selected',
  'required',
  'invalid',
  'readonly',
  'multiline',
  'focused',
  'hidden',
  'ignored',
  'paintHidden',
  'pointable',
] as const satisfies readonly (keyof AxState)[];

function stateFromCdp(raw: unknown, at: string): AxState | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError(`Outcrawl.getAXTree: ${at}.state is not an object`);
  }
  // Object-ness is the only thing this asserts; the type it asserts to says
  // `unknown` about every field, so nothing below is trusted.
  const wire = raw as WireAxState;
  const state: { -readonly [K in keyof AxState]?: AxState[K] } = {};

  for (const key of BOOLEAN_STATE_KEYS) {
    const value = wire[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'boolean') {
      throw new TypeError(`Outcrawl.getAXTree: ${at}.state.${key} is ${typeof value}, not boolean`);
    }
    state[key] = value;
  }

  // `checked` is the one field whose wire type is not its TS type. The PDL
  // spells it a string because it is a tri-state; mapping it by truthiness
  // would turn "false" into `true`, which reads as a ticked checkbox on every
  // unticked one and is exactly the sort of bug a passing test suite keeps.
  const checked = wire.checked;
  if (checked !== undefined) {
    if (checked === 'true') {
      state.checked = true;
    } else if (checked === 'false') {
      state.checked = false;
    } else if (checked === 'mixed') {
      state.checked = 'mixed';
    } else {
      throw new TypeError(
        `Outcrawl.getAXTree: ${at}.state.checked is ${JSON.stringify(checked)}, ` +
          'expected "true", "false" or "mixed"',
      );
    }
  }

  return Object.keys(state).length === 0 ? undefined : state;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new TypeError(`Outcrawl.getAXTree: ${label} is ${typeof value}, not string`);
  }
  return value;
}

function nodeFromCdp(raw: unknown, at: string): AxNode {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError(`Outcrawl.getAXTree: ${at} is not a node object`);
  }
  const wire = raw as WireAxNode;

  const wireRef = wire.ref;
  if (typeof wireRef !== 'string') {
    throw new TypeError(`Outcrawl.getAXTree: ${at}.ref is ${typeof wireRef}, not string`);
  }
  // Thrown, not dropped. `parseNodeRef` returns undefined because its usual
  // caller is reading stored data, where a bad value is a data condition. Here
  // the producer is the browser we shipped, so a ref that does not parse is a
  // protocol break — and skipping the node would hand the model a tree that
  // disagrees with the page it is looking at, which is worse than failing.
  const ref = parseNodeRef(wireRef);
  if (ref === undefined) {
    throw new TypeError(
      `Outcrawl.getAXTree: ${at}.ref ${JSON.stringify(wireRef)} is not "<frameOrdinal>-<backendNodeId>"`,
    );
  }

  const role = wire.role;
  if (typeof role !== 'string') {
    throw new TypeError(`Outcrawl.getAXTree: ${at}.role is ${typeof role}, not string`);
  }

  // Required on both sides, and `''` is a real value: the emitter says "no
  // XPath could be produced" that way rather than by omitting the field.
  // Substituting a default here would erase the distinction between a node
  // that has a heal path and one that does not.
  const xpath = wire.xpath;
  if (typeof xpath !== 'string') {
    throw new TypeError(`Outcrawl.getAXTree: ${at}.xpath is ${typeof xpath}, not string`);
  }

  const wireChildren = wire.children;
  let children: AxNode[] | undefined;
  if (wireChildren !== undefined) {
    if (!Array.isArray(wireChildren)) {
      throw new TypeError(`Outcrawl.getAXTree: ${at}.children is not an array`);
    }
    children = wireChildren.map((child, index) => nodeFromCdp(child, `${at}.children[${index}]`));
  }

  const name = optionalString(wire.name, `${at}.name`);
  const value = optionalString(wire.value, `${at}.value`);
  const state = stateFromCdp(wire.state, at);

  return {
    ref,
    role,
    xpath,
    ...(name === undefined ? {} : { name }),
    ...(value === undefined ? {} : { value }),
    ...(state === undefined ? {} : { state }),
    ...(children === undefined ? {} : { children }),
  };
}

/**
 * `Outcrawl.getAXTree`'s result, as the runtime's {@link AxTree}.
 *
 * Two shapes differ across the boundary and both fail quietly if mapped by
 * assumption: `ref` is a string on the wire and a branded struct in TS, and
 * `state.checked` is a string tri-state on the wire and `boolean | 'mixed'` in
 * TS. Everything else is carried through verbatim, `xpath: ''` included.
 *
 * `frameOrdinals` is in the result and not part of the tree: it says which
 * frames the walk reached, which is a fact about the TAB rather than the page
 * content, and it includes frames that contributed no node at all. The binding
 * reads it separately with {@link frameOrdinalsOf}.
 */
export function axTreeFromCdp(payload: Record<string, unknown>): AxTree {
  const url = payload['url'];
  if (typeof url !== 'string') {
    throw new TypeError(`Outcrawl.getAXTree: url is ${typeof url}, not string`);
  }
  return { url, root: nodeFromCdp(payload['root'], 'root') };
}

/**
 * `Outcrawl.getAXTree`'s `frameOrdinals` — every frame the walk reached, from
 * the session's own frame down, kept nodes or not — or `undefined` when the
 * reply has no well-formed list. Absent is not empty: an empty set would prove
 * that no frame is below, and a reply that said nothing proves nothing.
 */
export function frameOrdinalsOf(payload: Record<string, unknown>): ReadonlySet<number> | undefined {
  const ordinals = payload['frameOrdinals'];
  if (!Array.isArray(ordinals) || !ordinals.every((value) => Number.isInteger(value))) {
    return undefined;
  }
  return new Set(ordinals as number[]);
}
