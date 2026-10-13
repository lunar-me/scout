import { describe, expect, test } from 'bun:test';

import { secretGrammarFor } from '../src/secrets';

describe('the grammar', () => {
  test('offers each part a card holds and the security code by placeholder only', () => {
    const text = secretGrammarFor([{ handle: 'card', kind: 'card', fields: ['number', 'exp'] }, 'note']) ?? '';
    expect(text).toContain('{{secret:card.exp}} = MM/YY');
    expect(text).toContain('{{secret:card.exp_month}} = MM');
    expect(text).toContain('it holds no name or billing');
    expect(text).toContain('{{secret:card.cvc}}');
    expect(text).toContain('never type, guess or ask for a security code yourself');
    expect(text).toContain('{{secret:note}}');
    expect(secretGrammarFor([])).toBeNull();
  });
});
