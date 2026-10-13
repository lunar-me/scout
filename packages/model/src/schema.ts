/**
 * Schemas, in both directions.
 *
 * A caller hands us arbitrary JSON Schema — `ScrapeRequest.jsonOptions.schema`
 * comes straight from an API body. The provider accepts a strict subset. So
 * there are two jobs here and they are not the same job:
 *
 * **Out:** {@link constrainSchema} reduces the caller's schema to the subset the
 * provider will compile, because an unsupported keyword is a 400 and a 400 in
 * the middle of a crawl is a failed page. The supported and unsupported lists
 * are transcribed from a frontier provider's structured-outputs documentation
 * ("Supported features" / "Not supported"), read 2026-09-02:
 *
 * > * All basic types: object, array, string, integer, number, boolean, null
 * > * `enum` ... `const` ... `anyOf` and `allOf` ... `$ref`, `$def`, and
 * >   `definitions` (external `$ref` not supported) ... `default` ...
 * >   `required` and `additionalProperties` (must be set to `false` for objects)
 * > * String formats: `date-time`, `time`, `date`, `duration`, `email`,
 * >   `hostname`, `uri`, `ipv4`, `ipv6`, `uuid`
 * > * Array `minItems` (only values 0 and 1 supported)
 *
 * > Not supported: Recursive schemas; Complex types within enums; External
 * > `$ref`; Numerical constraints (such as `minimum`, `maximum`, `multipleOf`);
 * > String constraints (`minLength`, `maxLength`); Array constraints beyond
 * > `minItems` of 0 or 1; `additionalProperties` set to anything other than
 * > `false`. "If you use an unsupported feature, you'll receive a 400 error."
 *
 * A dropped constraint is not silently forgotten: its meaning is appended to the
 * field's `description`, which is the same thing that provider's own SDKs do
 * ("Update descriptions with constraint info ... Validate responses against your
 * original schema (with all constraints)"). The model then still knows the field
 * must be at least 100, it just is not held to it by the grammar.
 *
 * **Back:** {@link validate} checks the reply against the caller's **original**
 * schema, constraints included. This is the half that matters. Constrained
 * decoding is a strong guarantee but it is not a total one — the same page names
 * two documented holes, `stop_reason: "refusal"` and `stop_reason:
 * "max_tokens"`, where the output "may not match your schema" — and beyond that,
 * every constraint we just dropped is now unenforced. A pipeline that trusts the
 * grammar and skips this step returns a half-filled object as a success.
 */

import { isRecord } from '@outcrawl/scout-core';

/** The exact ten the structured-outputs page lists. Membership only. */
const SUPPORTED_FORMATS: Readonly<Record<string, true>> = {
  'date-time': true,
  time: true,
  date: true,
  duration: true,
  email: true,
  hostname: true,
  uri: true,
  ipv4: true,
  ipv6: true,
  uuid: true,
};

/**
 * Keywords the provider rejects, mapped to how each reads as prose. The value
 * receives the constraint's own value, so `minimum: 100` becomes "at least 100"
 * in the description the model is shown.
 */
const DROPPED_KEYWORDS: Readonly<Record<string, (value: unknown) => string>> = {
  minimum: (v) => `at least ${JSON.stringify(v)}`,
  maximum: (v) => `at most ${JSON.stringify(v)}`,
  exclusiveMinimum: (v) => `greater than ${JSON.stringify(v)}`,
  exclusiveMaximum: (v) => `less than ${JSON.stringify(v)}`,
  multipleOf: (v) => `a multiple of ${JSON.stringify(v)}`,
  minLength: (v) => `at least ${JSON.stringify(v)} characters`,
  maxLength: (v) => `at most ${JSON.stringify(v)} characters`,
  maxItems: (v) => `at most ${JSON.stringify(v)} items`,
  uniqueItems: () => 'all items distinct',
  minProperties: (v) => `at least ${JSON.stringify(v)} properties`,
  maxProperties: (v) => `at most ${JSON.stringify(v)} properties`,
};

/** Lookahead, lookbehind, backreferences and word boundaries: 400 or worse. */
const UNSUPPORTED_PATTERN = /\(\?[=!<]|\\[bB]|\\[1-9]/;

export interface ConstrainedSchema {
  /** Safe to send. */
  readonly schema: Readonly<Record<string, unknown>>;
  /**
   * What was changed, one line each, as `path: change`. Returned rather than
   * logged: the caller decides whether a dropped constraint is worth telling
   * someone about, and a silent transformation of a customer's schema is how
   * "the extraction ignored my constraint" becomes unexplainable.
   */
  readonly changes: readonly string[];
}

/**
 * Reduce a schema to the provider-supported subset.
 *
 * Structural, not clever: every branch either passes a keyword through, drops it
 * into a description, or rewrites it to the nearest supported equivalent.
 */
export function constrainSchema(schema: Readonly<Record<string, unknown>>): ConstrainedSchema {
  const changes: string[] = [];
  const out = reduce(schema, '$', changes);
  return { schema: out, changes };
}

function reduce(
  node: Readonly<Record<string, unknown>>,
  path: string,
  changes: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const notes: string[] = [];

  for (const [key, value] of Object.entries(node)) {
    const drop = DROPPED_KEYWORDS[key];
    if (drop !== undefined) {
      notes.push(drop(value));
      changes.push(`${path}: dropped ${key} (unsupported by the provider grammar)`);
      continue;
    }

    switch (key) {
      case 'properties': {
        if (!isRecord(value)) {
          break;
        }
        const properties: Record<string, unknown> = {};
        for (const [name, child] of Object.entries(value)) {
          properties[name] = isRecord(child) ? reduce(child, `${path}.${name}`, changes) : child;
        }
        out['properties'] = properties;
        break;
      }
      case '$defs':
      case 'definitions': {
        if (!isRecord(value)) {
          break;
        }
        const defs: Record<string, unknown> = {};
        for (const [name, child] of Object.entries(value)) {
          defs[name] = isRecord(child) ? reduce(child, `${path}#${name}`, changes) : child;
        }
        out[key] = defs;
        break;
      }
      case 'items': {
        out['items'] = isRecord(value) ? reduce(value, `${path}[]`, changes) : value;
        break;
      }
      case 'anyOf':
      case 'allOf': {
        out[key] = Array.isArray(value)
          ? value.map((child, index) =>
              isRecord(child) ? reduce(child, `${path}.${key}[${String(index)}]`, changes) : child,
            )
          : value;
        break;
      }
      case 'oneOf': {
        // Rewritten rather than dropped. `oneOf` is not in the supported list;
        // dropping it would leave a schema that permits anything, which is the
        // opposite of what the caller asked for. `anyOf` is weaker only in that
        // it allows a value matching two branches, and `validate` still holds
        // the reply to the original `oneOf`.
        out['anyOf'] = Array.isArray(value)
          ? value.map((child, index) =>
              isRecord(child) ? reduce(child, `${path}.oneOf[${String(index)}]`, changes) : child,
            )
          : value;
        changes.push(`${path}: rewrote oneOf as anyOf (oneOf is not compiled by the provider)`);
        break;
      }
      case 'not':
      case 'if':
      case 'then':
      case 'else':
      case 'contains':
      case 'patternProperties':
      case 'propertyNames': {
        changes.push(`${path}: dropped ${key} (unsupported by the provider grammar)`);
        break;
      }
      case 'minItems': {
        if (value === 0 || value === 1) {
          out['minItems'] = value;
        } else {
          notes.push(`at least ${JSON.stringify(value)} items`);
          changes.push(`${path}: dropped minItems ${JSON.stringify(value)} (only 0 and 1 compile)`);
        }
        break;
      }
      case 'format': {
        if (typeof value === 'string' && SUPPORTED_FORMATS[value] === true) {
          out['format'] = value;
        } else {
          notes.push(`in ${JSON.stringify(value)} format`);
          changes.push(`${path}: dropped unsupported format ${JSON.stringify(value)}`);
        }
        break;
      }
      case 'pattern': {
        if (typeof value === 'string' && !UNSUPPORTED_PATTERN.test(value)) {
          out['pattern'] = value;
        } else {
          notes.push(`matching ${JSON.stringify(value)}`);
          changes.push(`${path}: dropped pattern with constructs the provider cannot compile`);
        }
        break;
      }
      case 'additionalProperties': {
        // Forced below. Anything other than `false` is a documented 400.
        break;
      }
      default:
        out[key] = value;
    }
  }

  // Objects must say `additionalProperties: false`. An object schema with no
  // `properties` is left alone in that respect too: the docs' own examples write
  // `{"type": "object", "additionalProperties": false}`.
  const isObjectSchema =
    node['type'] === 'object' ||
    (Array.isArray(node['type']) && node['type'].includes('object')) ||
    (node['type'] === undefined && isRecord(node['properties']));
  if (isObjectSchema) {
    if (node['additionalProperties'] !== false) {
      changes.push(`${path}: set additionalProperties false (required for objects)`);
    }
    out['additionalProperties'] = false;
  }

  if (notes.length > 0) {
    const existing = typeof out['description'] === 'string' ? `${out['description']} ` : '';
    out['description'] = `${existing}Must be ${notes.join(', ')}.`;
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Validation, against the original
 * ------------------------------------------------------------------ */

/**
 * Check a value against a schema. Returns violations, most useful first; empty
 * means valid.
 *
 * Deliberately a subset of JSON Schema draft 2020-12: the keywords this product
 * actually receives, plus every constraint {@link constrainSchema} drops — those
 * are precisely the ones the grammar is not enforcing, so they are the ones this
 * has to. An unrecognised keyword is ignored rather than treated as a failure,
 * which is what the specification requires of a validator.
 */
export function validate(value: unknown, schema: Readonly<Record<string, unknown>>): string[] {
  const violations: string[] = [];
  check(value, schema, '$', schema, violations, 0);
  return violations;
}

const MAX_DEPTH = 64;

function typeOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === 'number') {
    return actual === 'number' || actual === 'integer';
  }
  return actual === expected;
}

function resolveRef(ref: string, root: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  if (!ref.startsWith('#/')) {
    return undefined;
  }
  let node: unknown = root;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isRecord(node)) {
      return undefined;
    }
    node = node[segment];
  }
  return isRecord(node) ? node : undefined;
}

function check(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  path: string,
  root: Readonly<Record<string, unknown>>,
  violations: string[],
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    violations.push(`${path}: schema nesting exceeded ${String(MAX_DEPTH)} levels`);
    return;
  }

  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    const target = resolveRef(ref, root);
    if (target === undefined) {
      violations.push(`${path}: cannot resolve ${ref}`);
      return;
    }
    check(value, target, path, root, violations, depth + 1);
    return;
  }

  const expected = schema['type'];
  if (typeof expected === 'string' && !matchesType(value, expected)) {
    violations.push(`${path}: expected ${expected}, got ${typeOf(value)}`);
    return;
  }
  if (Array.isArray(expected) && !expected.some((one) => typeof one === 'string' && matchesType(value, one))) {
    violations.push(`${path}: expected one of ${expected.join('|')}, got ${typeOf(value)}`);
    return;
  }

  const enumerated = schema['enum'];
  if (Array.isArray(enumerated)) {
    const encoded = JSON.stringify(value);
    // Compared case-insensitively for strings. The provider documents that it
    // "don't guarantee the capitalization of string `enum` and `const` values",
    // with the advice: "Compare enum values case-insensitively". Rejecting a
    // capitalisation difference would fail a run over something the vendor has
    // said it will do.
    const hit = enumerated.some((candidate) => {
      if (typeof candidate === 'string' && typeof value === 'string') {
        return candidate.toLowerCase() === value.toLowerCase();
      }
      return JSON.stringify(candidate) === encoded;
    });
    if (!hit) {
      violations.push(`${path}: ${encoded ?? 'undefined'} is not one of ${JSON.stringify(enumerated)}`);
    }
  }

  if ('const' in schema) {
    const wanted = schema['const'];
    const same =
      typeof wanted === 'string' && typeof value === 'string'
        ? wanted.toLowerCase() === value.toLowerCase()
        : JSON.stringify(wanted) === JSON.stringify(value);
    if (!same) {
      violations.push(`${path}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(value)}`);
    }
  }

  const anyOf = schema['anyOf'];
  if (Array.isArray(anyOf)) {
    const matched = anyOf.some((branch) => {
      if (!isRecord(branch)) {
        return false;
      }
      const branchViolations: string[] = [];
      check(value, branch, path, root, branchViolations, depth + 1);
      return branchViolations.length === 0;
    });
    if (!matched) {
      violations.push(`${path}: matches no branch of anyOf`);
    }
  }

  const oneOf = schema['oneOf'];
  if (Array.isArray(oneOf)) {
    const matches = oneOf.filter((branch) => {
      if (!isRecord(branch)) {
        return false;
      }
      const branchViolations: string[] = [];
      check(value, branch, path, root, branchViolations, depth + 1);
      return branchViolations.length === 0;
    }).length;
    if (matches !== 1) {
      violations.push(`${path}: matches ${String(matches)} branches of oneOf, expected exactly 1`);
    }
  }

  const allOf = schema['allOf'];
  if (Array.isArray(allOf)) {
    for (const [index, branch] of allOf.entries()) {
      if (isRecord(branch)) {
        check(value, branch, `${path}.allOf[${String(index)}]`, root, violations, depth + 1);
      }
    }
  }

  if (typeof value === 'string') {
    checkString(value, schema, path, violations);
  }
  if (typeof value === 'number') {
    checkNumber(value, schema, path, violations);
  }
  if (Array.isArray(value)) {
    const minItems = schema['minItems'];
    if (typeof minItems === 'number' && value.length < minItems) {
      violations.push(`${path}: expected at least ${String(minItems)} items, got ${String(value.length)}`);
    }
    const maxItems = schema['maxItems'];
    if (typeof maxItems === 'number' && value.length > maxItems) {
      violations.push(`${path}: expected at most ${String(maxItems)} items, got ${String(value.length)}`);
    }
    if (schema['uniqueItems'] === true) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) {
        violations.push(`${path}: items must be distinct`);
      }
    }
    const items = schema['items'];
    if (isRecord(items)) {
      for (const [index, item] of value.entries()) {
        check(item, items, `${path}[${String(index)}]`, root, violations, depth + 1);
      }
    }
    return;
  }

  if (isRecord(value)) {
    checkObject(value, schema, path, root, violations, depth);
  }
}

function checkString(
  value: string,
  schema: Readonly<Record<string, unknown>>,
  path: string,
  violations: string[],
): void {
  const minLength = schema['minLength'];
  if (typeof minLength === 'number' && value.length < minLength) {
    violations.push(`${path}: expected at least ${String(minLength)} characters, got ${String(value.length)}`);
  }
  const maxLength = schema['maxLength'];
  if (typeof maxLength === 'number' && value.length > maxLength) {
    violations.push(`${path}: expected at most ${String(maxLength)} characters, got ${String(value.length)}`);
  }
  const pattern = schema['pattern'];
  if (typeof pattern === 'string') {
    let expression: RegExp | undefined;
    try {
      expression = new RegExp(pattern, 'u');
    } catch {
      // An uncompilable pattern is the caller's schema being wrong, not the
      // model's answer being wrong. Reported, and not charged to the reply.
      violations.push(`${path}: schema pattern ${JSON.stringify(pattern)} is not a valid regexp`);
    }
    if (expression !== undefined && !expression.test(value)) {
      violations.push(`${path}: ${JSON.stringify(value)} does not match ${JSON.stringify(pattern)}`);
    }
  }
}

function checkNumber(
  value: number,
  schema: Readonly<Record<string, unknown>>,
  path: string,
  violations: string[],
): void {
  const minimum = schema['minimum'];
  if (typeof minimum === 'number' && value < minimum) {
    violations.push(`${path}: expected at least ${String(minimum)}, got ${String(value)}`);
  }
  const maximum = schema['maximum'];
  if (typeof maximum === 'number' && value > maximum) {
    violations.push(`${path}: expected at most ${String(maximum)}, got ${String(value)}`);
  }
  const exclusiveMinimum = schema['exclusiveMinimum'];
  if (typeof exclusiveMinimum === 'number' && value <= exclusiveMinimum) {
    violations.push(`${path}: expected greater than ${String(exclusiveMinimum)}, got ${String(value)}`);
  }
  const exclusiveMaximum = schema['exclusiveMaximum'];
  if (typeof exclusiveMaximum === 'number' && value >= exclusiveMaximum) {
    violations.push(`${path}: expected less than ${String(exclusiveMaximum)}, got ${String(value)}`);
  }
  const multipleOf = schema['multipleOf'];
  if (typeof multipleOf === 'number' && multipleOf > 0) {
    // Integer arithmetic where both sides are integers; the float path is only
    // reached for genuinely fractional constraints, where an exact answer does
    // not exist in binary64 anyway.
    const exact =
      Number.isInteger(value) && Number.isInteger(multipleOf)
        ? value % multipleOf === 0
        : Math.abs(value / multipleOf - Math.round(value / multipleOf)) < 1e-9;
    if (!exact) {
      violations.push(`${path}: expected a multiple of ${String(multipleOf)}, got ${String(value)}`);
    }
  }
}

function checkObject(
  value: Record<string, unknown>,
  schema: Readonly<Record<string, unknown>>,
  path: string,
  root: Readonly<Record<string, unknown>>,
  violations: string[],
  depth: number,
): void {
  const required = schema['required'];
  if (Array.isArray(required)) {
    for (const name of required) {
      if (typeof name === 'string' && !(name in value)) {
        violations.push(`${path}.${name}: required property is missing`);
      }
    }
  }

  const properties = schema['properties'];
  if (isRecord(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      if (name in value && isRecord(child)) {
        check(value[name], child, `${path}.${name}`, root, violations, depth + 1);
      }
    }
    if (schema['additionalProperties'] === false) {
      for (const name of Object.keys(value)) {
        if (!(name in properties)) {
          violations.push(`${path}.${name}: unexpected property`);
        }
      }
    }
  }

  const minProperties = schema['minProperties'];
  if (typeof minProperties === 'number' && Object.keys(value).length < minProperties) {
    violations.push(`${path}: expected at least ${String(minProperties)} properties`);
  }
  const maxProperties = schema['maxProperties'];
  if (typeof maxProperties === 'number' && Object.keys(value).length > maxProperties) {
    violations.push(`${path}: expected at most ${String(maxProperties)} properties`);
  }
}
