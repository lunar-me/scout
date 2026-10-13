/**
 * The two schema directions.
 *
 * `constrainSchema` is asserted against the provider's published "Not supported"
 * list: each keyword named there must be gone from the schema that is sent, and
 * its meaning must survive in the description. `validate` is asserted mostly on
 * inputs that FAIL, because a validator that only ever sees valid input is
 * indistinguishable from `return []`.
 */

import { describe, expect, test } from 'bun:test';

import { constrainSchema, validate } from '../src/schema';

describe('reducing a schema to the supported subset', () => {
  test('strips every keyword the provider documents as unsupported', () => {
    const { schema, changes } = constrainSchema({
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 10, multipleOf: 2 },
        name: { type: 'string', minLength: 3, maxLength: 40 },
        tags: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 9, uniqueItems: true },
      },
      required: ['count'],
    });

    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    for (const keyword of ['minimum', 'maximum', 'multipleOf']) {
      expect(properties['count']?.[keyword]).toBeUndefined();
    }
    expect(properties['name']?.['minLength']).toBeUndefined();
    expect(properties['tags']?.['maxItems']).toBeUndefined();
    expect(properties['tags']?.['uniqueItems']).toBeUndefined();
    // "Array `minItems` (only values 0 and 1 supported)": 3 is not one of them.
    expect(properties['tags']?.['minItems']).toBeUndefined();
    expect(changes.length).toBeGreaterThan(0);
  });

  test('keeps a dropped constraint as prose, so the model still knows about it', () => {
    const { schema } = constrainSchema({
      type: 'object',
      properties: { price: { type: 'number', minimum: 100, description: 'Ticket price.' } },
    });

    const price = (schema['properties'] as Record<string, Record<string, unknown>>)['price'];
    expect(price?.['description']).toBe('Ticket price. Must be at least 100.');
  });

  test('keeps minItems when it is 0 or 1', () => {
    const zero = constrainSchema({ type: 'array', items: { type: 'string' }, minItems: 0 });
    const one = constrainSchema({ type: 'array', items: { type: 'string' }, minItems: 1 });
    expect(zero.schema['minItems']).toBe(0);
    expect(one.schema['minItems']).toBe(1);
  });

  test('forces additionalProperties false on every object, at every depth', () => {
    const { schema } = constrainSchema({
      type: 'object',
      properties: {
        nested: { type: 'object', properties: { deep: { type: 'object', properties: {} } } },
        list: { type: 'array', items: { type: 'object', properties: { x: { type: 'string' } } } },
      },
      additionalProperties: true,
    });

    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(schema['additionalProperties']).toBe(false);
    expect(properties['nested']?.['additionalProperties']).toBe(false);
    expect(
      ((properties['nested']?.['properties'] as Record<string, Record<string, unknown>>)['deep'])?.[
        'additionalProperties'
      ],
    ).toBe(false);
    expect((properties['list']?.['items'] as Record<string, unknown>)['additionalProperties']).toBe(false);
  });

  test('filters string formats to the ten the provider compiles', () => {
    const { schema, changes } = constrainSchema({
      type: 'object',
      properties: {
        when: { type: 'string', format: 'date-time' },
        colour: { type: 'string', format: 'hex-colour' },
      },
    });

    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['when']?.['format']).toBe('date-time');
    expect(properties['colour']?.['format']).toBeUndefined();
    expect(properties['colour']?.['description']).toBe('Must be in "hex-colour" format.');
    expect(changes.some((line) => line.includes('unsupported format'))).toBe(true);
  });

  test('drops a regex with constructs the provider cannot compile, keeps a simple one', () => {
    const simple = constrainSchema({ type: 'string', pattern: '^[A-Z]{2}\\d+$' });
    expect(simple.schema['pattern']).toBe('^[A-Z]{2}\\d+$');

    // Lookahead is on the "NOT supported" list, alongside backreferences and
    // word boundaries.
    const lookahead = constrainSchema({ type: 'string', pattern: '^(?=.*\\d)\\w+$' });
    expect(lookahead.schema['pattern']).toBeUndefined();
    expect(lookahead.changes.join(' ')).toMatch(/cannot compile/);
  });

  test('rewrites oneOf as anyOf rather than dropping it', () => {
    // Dropping it would leave a schema that permits anything, which is the
    // opposite of what the caller asked for.
    const { schema, changes } = constrainSchema({
      oneOf: [{ type: 'string' }, { type: 'number', minimum: 0 }],
    });

    expect(schema['oneOf']).toBeUndefined();
    const branches = schema['anyOf'] as readonly Record<string, unknown>[];
    expect(branches.map((branch) => branch['type'])).toEqual(['string', 'number']);
    expect(branches[1]?.['minimum']).toBeUndefined();
    expect(changes.join(' ')).toMatch(/oneOf/);
  });

  test('recurses into $defs so a referenced shape is reduced too', () => {
    const { schema } = constrainSchema({
      type: 'object',
      properties: { item: { $ref: '#/$defs/item' } },
      $defs: { item: { type: 'object', properties: { qty: { type: 'integer', minimum: 1 } } } },
    });

    const defs = schema['$defs'] as Record<string, Record<string, unknown>>;
    const item = defs['item'];
    expect(item?.['additionalProperties']).toBe(false);
    expect((item?.['properties'] as Record<string, Record<string, unknown>>)['qty']?.['minimum']).toBeUndefined();
  });
});

describe('validating a reply against the original schema', () => {
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 2 },
      price: { type: 'number', minimum: 0, multipleOf: 0.01 },
      tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3, uniqueItems: true },
      state: { type: 'string', enum: ['new', 'used'] },
      seller: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    },
    required: ['title', 'price'],
  };

  const valid = {
    title: 'Kettle',
    price: 39.5,
    tags: ['kitchen'],
    state: 'new',
    seller: { name: 'Acme' },
  };

  test('passes a document that satisfies it', () => {
    expect(validate(valid, schema)).toEqual([]);
  });

  test('names a missing required property', () => {
    expect(validate({ title: 'Kettle' }, schema)).toEqual(['$.price: required property is missing']);
  });

  test('catches a wrong type, and says which', () => {
    expect(validate({ ...valid, price: '39.50' }, schema)).toEqual([
      '$.price: expected number, got string',
    ]);
  });

  test('catches every constraint the provider grammar cannot enforce', () => {
    expect(validate({ ...valid, price: -1 }, schema)).toEqual(['$.price: expected at least 0, got -1']);
    expect(validate({ ...valid, title: 'K' }, schema)).toEqual([
      '$.title: expected at least 2 characters, got 1',
    ]);
    expect(validate({ ...valid, tags: [] }, schema)).toEqual(['$.tags: expected at least 1 items, got 0']);
    expect(validate({ ...valid, tags: ['a', 'b', 'c', 'd'] }, schema)).toEqual([
      '$.tags: expected at most 3 items, got 4',
    ]);
    expect(validate({ ...valid, tags: ['a', 'a'] }, schema)).toEqual(['$.tags: items must be distinct']);
  });

  test('catches a value outside an enum', () => {
    expect(validate({ ...valid, state: 'refurbished' }, schema)).toEqual([
      '$.state: "refurbished" is not one of ["new","used"]',
    ]);
  });

  test('accepts an enum value that differs only in capitalisation', () => {
    // The provider states it "don't guarantee the capitalization of string `enum`
    // and `const` values" and advises comparing case-insensitively. Failing a run
    // over something the vendor has said it will do would be our bug, not theirs.
    expect(validate({ ...valid, state: 'New' }, schema)).toEqual([]);
  });

  test('recurses into nested objects and arrays', () => {
    // "integer" rather than "number" in the message: the validator reports the
    // narrowest true description of what arrived, which is what someone reading a
    // violation wants. A whole number still satisfies `type: number`.
    expect(validate({ ...valid, seller: { name: 7 } }, schema)).toEqual([
      '$.seller.name: expected string, got integer',
    ]);
    expect(validate({ ...valid, tags: [1] }, schema)).toEqual(['$.tags[0]: expected string, got integer']);
  });

  test('rejects an unexpected property only where the schema closes the object', () => {
    expect(validate({ ...valid, seller: { name: 'Acme', vat: 'GB1' } }, schema)).toEqual([
      '$.seller.vat: unexpected property',
    ]);
    // The root does not say `additionalProperties: false`, so an extra key there
    // is allowed. A validator that invented that restriction would reject replies
    // the caller's own schema permits.
    expect(validate({ ...valid, extra: true }, schema)).toEqual([]);
  });

  test('resolves an internal $ref, and reports one it cannot', () => {
    const withRef = {
      type: 'object',
      properties: { item: { $ref: '#/$defs/item' } },
      required: ['item'],
      $defs: { item: { type: 'object', properties: { qty: { type: 'integer' } }, required: ['qty'] } },
    };
    expect(validate({ item: { qty: 2 } }, withRef)).toEqual([]);
    expect(validate({ item: {} }, withRef)).toEqual(['$.item.qty: required property is missing']);
    expect(validate({ item: 1 }, { type: 'object', properties: { item: { $ref: '#/$defs/missing' } } })).toEqual([
      '$.item: cannot resolve #/$defs/missing',
    ]);
  });

  test('an integer is a number but a fractional number is not an integer', () => {
    expect(validate(3, { type: 'number' })).toEqual([]);
    expect(validate(3, { type: 'integer' })).toEqual([]);
    expect(validate(3.5, { type: 'integer' })).toEqual(['$: expected integer, got number']);
  });

  test('a null is not an object, which is the classic silent pass', () => {
    expect(validate(null, { type: 'object', properties: {}, required: [] })).toEqual([
      '$: expected object, got null',
    ]);
  });

  test('anyOf reports one violation for the whole union rather than one per branch', () => {
    const union = { anyOf: [{ type: 'string' }, { type: 'number' }] };
    expect(validate('ok', union)).toEqual([]);
    expect(validate(7, union)).toEqual([]);
    expect(validate(true, union)).toEqual(['$: matches no branch of anyOf']);
  });

  test('oneOf counts the branches, so two matches is a failure', () => {
    const exclusive = { oneOf: [{ type: 'number' }, { type: 'integer' }] };
    expect(validate(3.5, exclusive)).toEqual([]);
    expect(validate(3, exclusive)).toEqual(['$: matches 2 branches of oneOf, expected exactly 1']);
  });

  test('an unknown keyword is ignored, as the specification requires', () => {
    expect(validate({ title: 'Kettle', price: 1 }, { ...schema, 'x-vendor-hint': 'anything' })).toEqual([]);
  });
});
