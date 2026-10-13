import { describe, expect, test } from 'bun:test';

import { Scout, ScoutConfigError, type ScoutOptions } from '../src/index';

const HANDS = { model: 'your-model-id', baseURL: 'https://models.example/v1', apiKey: 'k' };

function refused(options: unknown): string {
  try {
    new Scout(options as ScoutOptions);
  } catch (error) {
    expect(error).toBeInstanceOf(ScoutConfigError);
    return (error as Error).message;
  }
  throw new Error('expected the configuration to be refused');
}

describe('models', () => {
  test('a missing hands model is refused, naming what to pass', () => {
    const message = refused({ browser: { launch: {} }, models: {} });
    expect(message).toContain('models.hands is required');
    expect(message).toContain("model: 'your-model-id'");
    expect(message).toContain('baseURL');
    expect(message).toContain('no default model');
  });

  test('no models at all is refused', () => {
    expect(refused({ browser: { launch: {} } })).toContain('models is required');
  });

  test('each role field is checked', () => {
    expect(refused({ browser: { launch: {} }, models: { hands: { ...HANDS, model: '' } } })).toContain('models.hands.model');
    expect(refused({ browser: { launch: {} }, models: { hands: { ...HANDS, baseURL: 'models.example/v1' } } })).toContain(
      'models.hands.baseURL',
    );
    expect(refused({ browser: { launch: {} }, models: { hands: { model: 'm', baseURL: HANDS.baseURL } } })).toContain(
      'models.hands.apiKey',
    );
    expect(refused({ browser: { launch: {} }, models: { hands: { ...HANDS, effort: 'extreme' } } })).toContain('effort');
    expect(refused({ browser: { launch: {} }, models: { hands: HANDS, eyes: { ...HANDS, baseURL: 7 } } })).toContain(
      'models.eyes.baseURL',
    );
  });

  test('an unknown role is refused rather than ignored', () => {
    expect(refused({ browser: { launch: {} }, models: { hands: HANDS, planner: HANDS } })).toContain('models.planner is not a role');
  });

  test('with rates, every role model must be priced', () => {
    const rate = { input: '1', output: '2', cacheRead: null, cacheWrite: null, inputModalities: ['text'] };
    const message = refused({
      browser: { launch: {} },
      models: { hands: HANDS, brain: { ...HANDS, model: 'other-model' }, rates: { 'your-model-id': rate } },
    });
    expect(message).toContain('"other-model"');
    expect(message).toContain('models.brain');
  });

  test('an empty key is allowed for a local endpoint', () => {
    expect(() => new Scout({ browser: { launch: {} }, models: { hands: { ...HANDS, apiKey: '' } } })).not.toThrow();
  });
});

describe('browser', () => {
  test('is required', () => {
    expect(refused({ models: { hands: HANDS } })).toContain('browser is required');
  });

  test('exactly one kind', () => {
    expect(refused({ browser: { launch: {}, cdpUrl: 'ws://localhost:9222' }, models: { hands: HANDS } })).toContain(
      'pass exactly one',
    );
  });

  test('a cdpUrl must be a ws or http url', () => {
    expect(refused({ browser: { cdpUrl: 'localhost:9222' }, models: { hands: HANDS } })).toContain('browser.cdpUrl');
  });

  test('an unknown key and an unknown driver are refused', () => {
    expect(refused({ browser: { chrome: true }, models: { hands: HANDS } })).toContain('browser.chrome is not an option');
    expect(refused({ browser: { launch: { driver: 'selenium' } }, models: { hands: HANDS } })).toContain('driver');
  });

  test("'outcrawl', { outcrawl }, { cdpUrl } and { launch } are each accepted", () => {
    for (const browser of ['outcrawl', { outcrawl: {} }, { cdpUrl: 'http://127.0.0.1:9222' }, { launch: { headless: true } }, {}] as const) {
      expect(() => new Scout({ browser, models: { hands: HANDS } })).not.toThrow();
    }
  });
});

describe('run', () => {
  const scout = new Scout({ browser: { cdpUrl: 'ws://127.0.0.1:1' }, models: { hands: HANDS } });

  test('needs a task', async () => {
    await expect(scout.run('  ')).rejects.toThrow('run(task) needs the task');
  });

  test('caps are checked before any browser is opened', async () => {
    await expect(scout.run('t', { caps: { steps: 0 } })).rejects.toThrow('caps.steps');
    await expect(scout.run('t', { caps: { duration: 'soon' } })).rejects.toThrow('caps.duration');
  });

  test('a budget without prices is refused, saying what bounds the run instead', async () => {
    await expect(scout.run('t', { caps: { budget: '1.00' } })).rejects.toThrow('caps.budget needs prices');
  });
});
