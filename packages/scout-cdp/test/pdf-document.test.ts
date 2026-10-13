/**
 * A tab showing a PDF, on a real stock Chromium with its PDF viewer: `extract`
 * reads the PDF's text from the bytes the browser kept, without asking the
 * site for them again, and the snapshot says the tab is a PDF.
 *
 * The PDF is built here and served from a local server that counts requests,
 * because "no second request" is the contract and only the server can see it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { walk, type AgentDeps, type AxTree, type ExtractInput, type ModelPort } from '@outcrawl/runtime';

import { bindAgent, stockFlavor, type CdpPage } from '../src/index';
import { chromiumPath, launchChromium, type StockChromium } from './support/chromium';

/** A one-page PDF with a title and a small table, no xref table (PDF viewers rebuild one). */
function tablePdf(): Uint8Array {
  const content = [
    'BT /F1 12 Tf 72 720 Td (Table 1. Monthly rainfall, millimetres) Tj',
    '0 -16 Td (January 81.2) Tj',
    '0 -16 Td (February 64.0) Tj',
    '0 -16 Td (March 70.5) Tj ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Title (Rainfall Report) >>',
  ];
  const body = objects.map((object, index) => `${String(index + 1)} 0 obj\n${object}\nendobj\n`).join('');
  return Buffer.from(`%PDF-1.4\n${body}trailer\n<< /Root 1 0 R /Info 6 0 R >>\n%%EOF\n`, 'latin1');
}

const PDF = tablePdf();

/** A model that records what each extraction was given and answers `{}`. */
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

function notices(tree: AxTree): string[] {
  return walk(tree)
    .map((node) => node.name ?? '')
    .filter((name) => name.startsWith('This tab shows a PDF'));
}

describe.skipIf(chromiumPath === undefined)('a tab showing a PDF, on stock Chromium', () => {
  let chrome: StockChromium;
  let server: ReturnType<typeof Bun.serve>;
  const requests: string[] = [];

  beforeAll(async () => {
    chrome = await launchChromium({ pdfViewer: true });
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);
        requests.push(pathname);
        if (pathname === '/page.html') {
          return new Response('<!doctype html><title>Plain</title><p>Just a page</p>', { headers: { 'content-type': 'text/html' } });
        }
        const cache = pathname === '/kept.pdf' ? 'max-age=60' : 'no-store';
        return new Response(PDF, { headers: { 'content-type': 'application/pdf', 'cache-control': cache } });
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

  test('extract reads the text the browser kept, with no second request, and the snapshot says so', async () => {
    const url = `http://127.0.0.1:${String(server.port)}/kept.pdf`;
    const page = await chrome.open(url);
    const model = recordingModel();
    const deps = bind(page, model.port);

    await deps.extract(undefined, 'the February rainfall');

    const content = model.inputs[0]?.content;
    expect(content?.kind).toBe('markdown');
    const markdown = content?.kind === 'markdown' ? content.markdown : '';
    expect(markdown).toContain('# Rainfall Report');
    expect(markdown).toContain(url);
    const table = 'Table 1. Monthly rainfall, millimetres\nJanuary 81.2\nFebruary 64.0\nMarch 70.5';
    expect(markdown).toContain(table);
    expect(notices(await deps.snapshot())).toEqual([
      `This tab shows a PDF document "Rainfall Report": 1 page, ${String(table.length)} characters of text. Its text is not shown here; {"type":"extract"} reads it.`,
    ]);
    // The PDF was fetched once, by the navigation. Nothing here asked again.
    expect(requests.filter((path) => path === '/kept.pdf')).toEqual(['/kept.pdf']);
  });

  test('a PDF the browser did not keep is not fetched again: extract reads the tree, and the snapshot says why', async () => {
    const page = await chrome.open(`http://127.0.0.1:${String(server.port)}/gone.pdf`);
    const model = recordingModel();
    const deps = bind(page, model.port);

    await deps.extract(undefined, 'the February rainfall');

    expect(model.inputs[0]?.content.kind).toBe('tree');
    const [notice] = notices(await deps.snapshot());
    expect(notice).toStartWith('This tab shows a PDF document, and its text cannot be read: the browser kept no copy of it');
    expect(requests.filter((path) => path === '/gone.pdf')).toEqual(['/gone.pdf']);
  });

  test('a page that is not a PDF is read from its tree and carries no PDF line', async () => {
    const page = await chrome.open(`http://127.0.0.1:${String(server.port)}/page.html`);
    const model = recordingModel();
    const deps = bind(page, model.port);

    await deps.extract(undefined, 'the text');

    expect(model.inputs[0]?.content.kind).toBe('tree');
    expect(notices(await deps.snapshot())).toEqual([]);
  });
});
