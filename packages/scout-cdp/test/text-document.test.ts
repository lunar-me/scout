/**
 * A tab showing a large plain-text file, on a real stock Chromium: the
 * snapshot does not build the file's accessibility tree (which holds the
 * renderer for minutes on a file this size), it says what the file is and
 * shows its opening; `extract` reads the file's text; and nothing asks the
 * site for it again.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { walk, type AgentDeps, type AxTree, type ExtractInput, type ModelPort } from '@outcrawl/runtime';

import { bindAgent, stockFlavor, type CdpPage } from '../src/index';
import { chromiumPath, launchChromium, type StockChromium } from './support/chromium';

/** `count` distinct lowercase words, one per line. */
function wordList(count: number): string {
  const words: string[] = [];
  for (let index = 0; index < count; index++) {
    let word = '';
    for (let n = index + 1; n > 0; n = Math.floor(n / 26)) word += String.fromCharCode(97 + (n % 26));
    words.push(`${word}word`);
  }
  return words.join('\n');
}

/** 1.4 MB: on stock Chromium its accessibility tree takes minutes (see `../src/text-document.ts`). */
const LARGE = wordList(140_000);
const SMALL = wordList(200);

function recordingModel(): { readonly port: ModelPort; readonly inputs: ExtractInput[] } {
  const inputs: ExtractInput[] = [];
  return {
    inputs,
    port: {
      choose: () => Promise.reject(new Error('not driven')),
      extract: (input) => {
        inputs.push(input);
        return Promise.resolve({ data: {} });
      },
    },
  };
}

function names(tree: AxTree): string[] {
  return walk(tree).map((node) => node.name ?? '');
}

describe.skipIf(chromiumPath === undefined)('a tab showing a large plain-text file, on stock Chromium', () => {
  let chrome: StockChromium;
  let server: ReturnType<typeof Bun.serve>;
  const requests: string[] = [];

  beforeAll(async () => {
    chrome = await launchChromium();
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);
        requests.push(pathname);
        if (pathname === '/small.txt') return new Response(SMALL, { headers: { 'content-type': 'text/plain' } });
        if (pathname === '/rows.json') {
          return new Response(JSON.stringify(LARGE.split('\n')), { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' } });
        }
        const cache = pathname === '/kept.txt' ? 'max-age=60' : 'no-store';
        return new Response(LARGE, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': cache } });
      },
    });
  });

  afterAll(async () => {
    await server.stop(true);
    await chrome.close();
  });

  function bind(page: CdpPage, model: ModelPort): AgentDeps {
    return bindAgent(page, { model, tabs: null, files: null, flavor: stockFlavor });
  }

  test('the snapshot names the file and shows its opening without building its tree; extract reads it from the cache', async () => {
    const url = `http://127.0.0.1:${String(server.port)}/kept.txt`;
    const page = await chrome.open(url);
    const model = recordingModel();
    const deps = bind(page, model.port);

    const started = performance.now();
    const shown = names(await deps.snapshot());
    expect(performance.now() - started).toBeLessThan(5_000);
    const lines = LARGE.split('\n');
    // Cut at the last whole line inside 1,000,000 characters.
    const kept = LARGE.lastIndexOf('\n', 1_000_000);
    expect(shown[1]).toBe(
      `This tab shows a text/plain file, not a web page: ${LARGE.length.toLocaleString('en-US')} characters in ` +
        `${lines.length.toLocaleString('en-US')} lines, too large to show here. Below are its first lines only. ` +
        `{"type":"extract"} reads its first ${kept.toLocaleString('en-US')} characters. Scrolling shows nothing more here.`,
    );
    expect(shown[2]).toStartWith(`${lines[0]}\n${lines[1]}\n`);
    expect(shown[2]?.length).toBeLessThan(2_100);

    await deps.extract(undefined, 'the longest word');
    const content = model.inputs[0]?.content;
    expect(content?.kind).toBe('markdown');
    const markdown = content?.kind === 'markdown' ? content.markdown : '';
    expect(markdown).toContain(url);
    expect(markdown).toContain(`\n${lines[50_000]}\n`);
    expect(markdown).toContain('more characters of this file are not included');
    expect(requests.filter((path) => path === '/kept.txt')).toEqual(['/kept.txt']);
  });

  test('a file the browser did not keep is read from the page, and not fetched again', async () => {
    const page = await chrome.open(`http://127.0.0.1:${String(server.port)}/gone.txt`);
    const model = recordingModel();
    const deps = bind(page, model.port);

    expect(names(await deps.snapshot())[1]).toStartWith('This tab shows a text/plain file, not a web page');
    await deps.extract(undefined, 'the longest word');
    const content = model.inputs[0]?.content;
    expect(content?.kind === 'markdown' ? content.markdown : '').toContain(`\n${LARGE.split('\n')[50_000] ?? ''}\n`);
    expect(requests.filter((path) => path === '/gone.txt')).toEqual(['/gone.txt']);
  });

  test('a large JSON file is a text file too', async () => {
    const page = await chrome.open(`http://127.0.0.1:${String(server.port)}/rows.json`);
    const deps = bind(page, recordingModel().port);

    expect(names(await deps.snapshot())[1]).toStartWith('This tab shows a application/json file, not a web page');
  });

  test('a small text file is read from its tree, which shows its text', async () => {
    const page = await chrome.open(`http://127.0.0.1:${String(server.port)}/small.txt`);
    const model = recordingModel();
    const deps = bind(page, model.port);

    const shown = names(await deps.snapshot());
    expect(shown.some((name) => name.startsWith('This tab shows'))).toBe(false);
    expect(shown.join('\n')).toContain(SMALL.split('\n')[100] ?? '');
    await deps.extract(undefined, 'the words');
    expect(model.inputs[0]?.content.kind).toBe('tree');
  });
});
