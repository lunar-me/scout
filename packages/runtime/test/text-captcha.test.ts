/**
 * The host answers a text-in-image captcha below the model (OC-280): it types
 * the code its reader returned, presses the form's button, and tells the model
 * what happened — and stops after TEXT_CAPTCHA_ATTEMPTS on one page.
 */

import { describe, expect, test } from 'bun:test';

import type { Action } from '../src/actions';
import type { ModelChoice } from '../src/loop';
import { runAgent } from '../src/loop';
import type { AxTree } from '../src/snapshot';
import { formatNodeRef } from '../src/snapshot';
import type { TextCaptchaPort, TextCaptchaSighting } from '../src/text-captcha';
import { TEXT_CAPTCHA_ATTEMPTS, textCaptchaCode } from '../src/text-captcha';
import { harness, node, ref, tree } from './support';

const URL = 'https://pngtree.com/free-text-effect';
const INPUT = ref();
const SUBMIT = ref();
const IMAGE = ref();
const EMAIL = ref();

function gate(typed: string, extraEmpty = false): AxTree {
  return tree(
    node({
      role: 'RootWebArea',
      name: 'Human verification',
      children: [
        node({ role: 'heading', name: 'Please complete the security verification' }),
        node({ role: 'image', ref: IMAGE }),
        ...(extraEmpty ? [node({ role: 'textbox', name: 'Email', ref: EMAIL })] : []),
        node({ role: 'textbox', name: 'Enter the code', ref: INPUT, ...(typed === '' ? {} : { value: typed }) }),
        node({ role: 'button', name: 'Submit', ref: SUBMIT }),
      ],
    }),
    URL,
  );
}

const SITE = tree(node({ role: 'RootWebArea', name: 'Text effects', children: [node({ role: 'link', name: 'Gold 3D text effect' })] }), URL);

const done: ModelChoice = { action: { type: 'done', summary: 'ok' } };

interface Page {
  typed: string;
  cleared: boolean;
}

/** A browser whose gate clears when `accept` says the submitted code is right. */
function browser(accept: (code: string) => boolean, extraEmpty = false) {
  const page: Page = { typed: '', cleared: false };
  return {
    page,
    snapshot: (): AxTree => (page.cleared ? SITE : gate(page.typed, extraEmpty)),
    perform(action: Action): void {
      if (action.type === 'fill' && formatNodeRef(action.ref) === formatNodeRef(INPUT)) page.typed = action.text;
      if ((action.type === 'click' && action.ref !== undefined && formatNodeRef(action.ref) === formatNodeRef(SUBMIT)) || action.type === 'press') {
        page.cleared = accept(page.typed);
        page.typed = '';
      }
    },
  };
}

function port(codes: readonly string[], submit: TextCaptchaSighting['submit'] = SUBMIT) {
  const reads: TextCaptchaSighting[] = [];
  const textCaptcha: TextCaptchaPort = {
    find: (shown) =>
      Promise.resolve(shown.root.name === 'Human verification' ? { image: IMAGE, input: INPUT, submit } : undefined),
    read(sighting) {
      reads.push(sighting);
      const code = codes[reads.length - 1];
      return code === undefined ? Promise.reject(new Error('unreadable')) : Promise.resolve({ code });
    },
  };
  return { textCaptcha, reads };
}

describe('a text captcha the host answers', () => {
  test('the code is typed and submitted without the model, and the model is told on the page behind it', async () => {
    const page = browser((code) => code === 'K7XQ2');
    const { textCaptcha } = port(['K7XQ2']);
    const h = harness({ model: () => done, snapshot: page.snapshot, perform: page.perform });

    const result = await runAgent({ ...h.deps, textCaptcha }, { task: 'list formats', caps: { steps: 6, budget: '10', duration: '10m' }, stepFailures: null });

    expect(h.performed.slice(0, 2)).toEqual([
      { type: 'fill', ref: INPUT, text: 'K7XQ2' },
      { type: 'click', ref: SUBMIT },
    ]);
    // Two host steps, then the model's first prompt is the site.
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]?.tree.root.name).toBe('Text effects');
    expect(h.prompts[0]?.notice).toContain('was read and submitted by Outcrawl');
    expect(result.steps[0]?.reasoning).toContain('Outcrawl');
  });

  test('a refused code is retried on a fresh read, and the page goes to the model after the last attempt', async () => {
    const page = browser(() => false);
    const { textCaptcha, reads } = port(['AAAA1', 'BBBB2', 'CCCC3', 'DDDD4']);
    const h = harness({ model: () => done, snapshot: page.snapshot, perform: page.perform });

    await runAgent({ ...h.deps, textCaptcha }, { task: 't', caps: { steps: 12, budget: '10', duration: '10m' }, stepFailures: null });

    expect(reads).toHaveLength(TEXT_CAPTCHA_ATTEMPTS);
    expect(h.performed.filter((action) => action.type === 'fill').map((action) => (action.type === 'fill' ? action.text : ''))).toEqual([
      'AAAA1',
      'BBBB2',
      'CCCC3',
    ]);
    expect(h.prompts[0]?.tree.root.name).toBe('Human verification');
  });

  test('an unreadable image types nothing and tells the model why', async () => {
    const page = browser(() => true);
    const { textCaptcha } = port([]);
    const h = harness({ model: () => done, snapshot: page.snapshot, perform: page.perform });

    await runAgent({ ...h.deps, textCaptcha }, { task: 't', caps: { steps: 3, budget: '10', duration: '10m' }, stepFailures: null });

    expect(h.performed.filter((action) => action.type === 'fill')).toEqual([]);
    expect(h.prompts[0]?.notice).toContain('could not answer (unreadable)');
  });

  test('a form with another empty field is typed into and left to the model to submit', async () => {
    const page = browser(() => true, true);
    const { textCaptcha } = port(['K7XQ2'], 'model');
    const h = harness({ model: () => done, snapshot: page.snapshot, perform: page.perform });

    await runAgent({ ...h.deps, textCaptcha }, { task: 't', caps: { steps: 3, budget: '10', duration: '10m' }, stepFailures: null });

    expect(h.performed[0]).toEqual({ type: 'fill', ref: INPUT, text: 'K7XQ2' });
    expect(h.performed.some((action) => action.type === 'click' || action.type === 'press')).toBe(false);
    expect(h.prompts[0]?.notice).toContain(`typed this page's text verification code into [${formatNodeRef(INPUT)}]`);
  });
});

describe('textCaptchaCode', () => {
  test('a read code is typed; a sentence or an unreadable answer never is', () => {
    expect(textCaptchaCode(' "k7XQ2" ')).toBe('k7XQ2');
    expect(textCaptchaCode('K 7 X Q 2')).toBe('K7XQ2');
    expect(textCaptchaCode('The image is unreadable')).toBeUndefined();
    expect(textCaptchaCode('3+4=?')).toBeUndefined();
  });
});
