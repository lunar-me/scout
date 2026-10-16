import { describe, expect, test } from 'bun:test';

import { CostLedger } from '../src/ledger';
import { ModelPageLook, parseLookReply } from '../src/look';
import type { RateCard } from '../src/rates';
import { FakeProvider, reply } from './support';

const IMAGE = { mediaType: 'image/png', base64: 'iVBORw0KGgo=' } as const;
const SESSION = { sessionId: 'sess_look', accountId: 'acct_1' };
const LOOK_MODEL = 'look-model';

/** A host's card: one image-capable model, one text-only model. */
const RATES: RateCard = {
  [LOOK_MODEL]: { input: '0.5', output: '3', cacheRead: null, cacheWrite: null, inputModalities: ['text', 'image'] },
  'hands-model': { input: '0.25', output: '0.75', cacheRead: null, cacheWrite: null, inputModalities: ['text'] },
};

describe('the look model', () => {
  test('a text-only model is refused at construction, saying why', () => {
    expect(() => new ModelPageLook({ provider: new FakeProvider(), model: 'hands-model', rates: RATES })).toThrow(
      'accepts text only',
    );
  });

  test('a model missing from the card is refused rather than billed as free', () => {
    expect(() => new ModelPageLook({ provider: new FakeProvider(), model: 'unpriced-model', rates: RATES })).toThrow(
      'no rate card entry',
    );
  });
});

describe('one look is one image call, recorded as look spend', () => {
  test('the screenshot rides the call, constrained and at temperature 0, and the answer is parsed', async () => {
    const provider = new FakeProvider([
      reply(
        JSON.stringify({ answer: 'ZQ-4471-MBX', found: true, x: -1, y: -1 }),
        { inputTokens: 1338, outputTokens: 29 },
        '0.000378',
      ),
    ]);
    const ledger = new CostLedger();
    const eyes = new ModelPageLook({ provider, model: LOOK_MODEL, rates: RATES, ledger, session: SESSION });

    const answer = await eyes.ask({ question: 'What code is painted?', image: IMAGE });

    expect(answer.answer).toBe('ZQ-4471-MBX');
    expect(answer.point).toBeUndefined();
    expect(answer.usage.inputTokens).toBe(1338);
    const sent = provider.requests[0];
    expect(sent?.images).toEqual([IMAGE]);
    expect(sent?.temperature).toBe(0);
    expect(sent?.schema).toBeDefined();
    expect(sent?.prompt).toContain('What code is painted?');
    const [entry] = ledger.entries();
    expect(entry?.purpose).toBe('look');
    expect(entry?.outcome).toBe('ok');
    // The provider's own stated figure, never re-priced from a table.
    expect(entry?.costUsd).toBe('0.000378');
  });

  test('an unusable reply fails the look and is still recorded as billed', async () => {
    const provider = new FakeProvider([
      reply('I think it says ZQ', { inputTokens: 1338, outputTokens: 5 }, '0.000342'),
    ]);
    const ledger = new CostLedger();
    const eyes = new ModelPageLook({ provider, model: LOOK_MODEL, rates: RATES, ledger, session: SESSION });
    await expect(eyes.ask({ question: 'q', image: IMAGE })).rejects.toThrow('not JSON');
    expect(ledger.entries().map((entry) => [entry.outcome, entry.costUsd])).toEqual([['unusable', '0.000342']]);
  });
});

describe('the reply', () => {
  test('a position is kept only on the grid and only when something was found', () => {
    expect(parseLookReply('{"answer":"15","found":true,"x":718,"y":312}').point).toEqual({ x: 718, y: 312 });
    expect(parseLookReply('{"answer":"","found":true,"x":-1,"y":-1}').point).toBeUndefined();
    expect(parseLookReply('{"answer":"","found":true,"x":1400,"y":312}').point).toBeUndefined();
    expect(parseLookReply('{"answer":"no","found":false,"x":500,"y":500}').point).toBeUndefined();
  });

  test('a retake is a zoom box that is a box on the grid, or "unpainted"; anything else is no retake', () => {
    expect(parseLookReply('{"answer":"","found":true,"x":-1,"y":-1,"zoom":[100,200,300,260],"unpainted":false}').zoom).toEqual({
      x0: 100,
      y0: 200,
      x1: 300,
      y1: 260,
    });
    expect(parseLookReply('{"answer":"","found":true,"x":-1,"y":-1,"zoom":[300,200,100,260],"unpainted":false}').zoom).toBeUndefined();
    expect(parseLookReply('{"answer":"","found":true,"x":-1,"y":-1,"zoom":[100,200,1300,260],"unpainted":false}').zoom).toBeUndefined();
    expect(parseLookReply('{"answer":"","found":true,"x":-1,"y":-1,"zoom":[],"unpainted":false}').zoom).toBeUndefined();
    expect(parseLookReply('{"answer":"empty chart","found":false,"x":-1,"y":-1,"zoom":[],"unpainted":true}').unpainted).toBe(true);
    // A provider without strict output may leave the retake out altogether.
    expect(parseLookReply('{"answer":"x","found":true,"x":-1,"y":-1}')).toEqual({ answer: 'x', found: true });
  });
});
