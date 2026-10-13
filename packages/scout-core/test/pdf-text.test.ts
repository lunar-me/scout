import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';

import { extractPdfText } from '../src/pdf-text';

/**
 * A PDF, assembled here rather than checked in.
 *
 * Built rather than committed because the interesting cases are structural —
 * an encrypted trailer, a compressed content stream, a `/ToUnicode` CMap, a
 * page with drawing operators and no text — and a binary fixture hides which
 * of those a failure is about. Every byte below is visible in the test that
 * needs it.
 *
 * NO XREF TABLE, deliberately: the parser does not read one, and a fixture
 * that carried a valid one would let a regression that starts depending on it
 * pass here and fail on the web, where xref tables are routinely wrong.
 */
type PdfObject = string | { readonly dict: string; readonly stream: Uint8Array };

function pdfOf(objects: readonly PdfObject[], trailer = '/Root 1 0 R'): Uint8Array {
  const parts: Uint8Array[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  objects.forEach((object, index) => {
    const num = index + 1;
    if (typeof object === 'string') {
      parts.push(Buffer.from(`${num} 0 obj\n${object}\nendobj\n`, 'latin1'));
      return;
    }
    parts.push(
      Buffer.from(`${num} 0 obj\n<< ${object.dict} /Length ${object.stream.length} >>\nstream\n`, 'latin1'),
    );
    parts.push(object.stream);
    parts.push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
  });
  parts.push(Buffer.from(`trailer\n<< ${trailer} >>\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

const CATALOG = '<< /Type /Catalog /Pages 2 0 R >>';
const PAGES = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

/** One page whose resources name object 5 as `/F1` and whose content is object 4. */
const PAGE = '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>';

function onePage(content: string | Uint8Array, font = HELVETICA): Uint8Array {
  const stream = typeof content === 'string' ? Buffer.from(content, 'latin1') : content;
  return pdfOf([CATALOG, PAGES, PAGE, { dict: '', stream }, font]);
}

describe('a PDF with a text layer comes back as text', () => {
  test('the shown strings are the text, in order', () => {
    const result = extractPdfText(
      onePage('BT /F1 12 Tf 72 720 Td (Hello, world.) Tj ET'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('Hello, world.');
    expect(result.pages).toBe(1);
  });

  test('a baseline that moves down is a line break, and one that does not is not', () => {
    // Two `Tj` on one baseline, then `T*` to the next. A reader must get one
    // line and then another, not one run-on line and not four.
    const result = extractPdfText(
      onePage(
        'BT /F1 12 Tf 14 TL 72 720 Td (Hello,) Tj ( world.) Tj T* (Second line.) Tj ET',
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('Hello, world.\nSecond line.');
  });

  test('a horizontal jump is a space and a kern is not', () => {
    // `Left` advances the pen 4 glyphs; the jump to 272 is far beyond it, so a
    // word ended. The `TJ` kern of -30 thousandths is 0.36 units at 12 pt and
    // must not break `mid` into two words.
    const result = extractPdfText(
      onePage('BT /F1 12 Tf 72 700 Td (Left) Tj 200 0 Td [(mi) -30 (d)] TJ ET'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('Left mid');
  });

  test('a FlateDecode content stream is inflated', () => {
    const raw = Buffer.from('BT /F1 12 Tf 72 720 Td (Compressed content.) Tj ET', 'latin1');
    const page = pdfOf([
      CATALOG,
      PAGES,
      PAGE,
      { dict: '/Filter /FlateDecode', stream: deflateSync(raw) },
      HELVETICA,
    ]);

    const result = extractPdfText(page);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('Compressed content.');
  });

  test('a font with a /ToUnicode CMap is read through it, not as its bytes', () => {
    // THE CASE A SUBSET FONT MAKES ORDINARY. The codes are 1..6 — glyph
    // indices into a subset, meaningless as characters — and the CMap is the
    // only thing that says they spell `PDF ok`. Reading the bytes would give
    // six control characters.
    const cmap = Buffer.from(
      [
        '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
        '1 begincodespacerange <00> <ff> endcodespacerange',
        '3 beginbfchar <01> <0050> <02> <0044> <04> <0020> endbfchar',
        '2 beginbfrange <03> <03> <0046> <05> <06> <006f> endbfrange',
        'endcmap end end',
      ].join('\n'),
      'latin1',
    );
    const page = pdfOf([
      CATALOG,
      PAGES,
      PAGE,
      {
        dict: '',
        stream: Buffer.from(
          'BT /F1 12 Tf 72 720 Td (\x01\x02\x03\x04\x05\x06) Tj ET',
          'latin1',
        ),
      },
      '<< /Type /Font /Subtype /Type1 /BaseFont /AAAAAA+Sub /ToUnicode 6 0 R >>',
      { dict: '', stream: cmap },
    ]);

    const result = extractPdfText(page);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `<05> <06>` is a range whose destination increments: `o`, then `p`.
    expect(result.text).toBe('PDF op');
  });

  test('a simple font is one byte per code even when its /ToUnicode declares a two-byte codespace', () => {
    // What common writers emit for a simple TrueType font: a `<0000> <FFFF>`
    // codespace and one-byte codes mapped as `<0041>`. Pairing the bytes of
    // `(Hello)` into two-byte codes finds nothing in the map and loses the text.
    const cmap = Buffer.from(
      [
        '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
        '1 begincodespacerange <0000> <FFFF> endcodespacerange',
        '4 beginbfchar <0048> <0048> <0065> <0065> <006C> <006C> <006F> <006F> endbfchar',
        'endcmap end end',
      ].join('\n'),
      'latin1',
    );
    const page = pdfOf([
      CATALOG,
      PAGES,
      PAGE,
      { dict: '', stream: Buffer.from('BT /F1 12 Tf 72 720 Td (Hello) Tj ET', 'latin1') },
      '<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAA+Serif /Encoding /WinAnsiEncoding /ToUnicode 6 0 R >>',
      { dict: '', stream: cmap },
    ]);

    const result = extractPdfText(page);

    expect(result).toEqual({ ok: true, text: 'Hello', pages: 1 });
  });

  test('a page that exists ONLY inside an object stream is still found', () => {
    // A modern writer puts the catalog, the page tree and the page itself in a
    // compressed `/ObjStm` and the xref in a stream. NOTHING at the top level
    // of this file is a `/Type /Page`, so the loose-object fallback cannot
    // rescue it: a parser that only scans for `N 0 obj` sees a file with no
    // pages, which is a blank document rather than an error.
    const inner = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      PAGE,
    ];
    let body = '';
    const pairs: string[] = [];
    inner.forEach((object, index) => {
      pairs.push(`${index + 1} ${body.length}`);
      body += `${object} `;
    });
    const header = `${pairs.join(' ')} `;
    const payload = deflateSync(Buffer.from(header + body, 'latin1'));
    const content = Buffer.from(
      'BT /F1 12 Tf 72 720 Td (Inside an object stream.) Tj ET',
      'latin1',
    );

    const file = Buffer.concat([
      Buffer.from('%PDF-1.5\n', 'latin1'),
      Buffer.from(`4 0 obj\n<< /Length ${content.length} >>\nstream\n`, 'latin1'),
      content,
      Buffer.from(`\nendstream\nendobj\n5 0 obj\n${HELVETICA}\nendobj\n`, 'latin1'),
      Buffer.from(
        `6 0 obj\n<< /Type /ObjStm /N 3 /First ${header.length} /Filter /FlateDecode /Length ${payload.length} >>\nstream\n`,
        'latin1',
      ),
      payload,
      Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'),
    ]);

    const result = extractPdfText(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('Inside an object stream.');
  });
});

describe('a PDF that cannot be read says so', () => {
  test('an encrypted PDF refuses instead of returning mojibake', () => {
    const page = pdfOf(
      [
        CATALOG,
        PAGES,
        PAGE,
        { dict: '', stream: Buffer.from('BT /F1 12 Tf 72 720 Td (ciphertext) Tj ET', 'latin1') },
        HELVETICA,
        '<< /Filter /Standard /V 2 /R 3 /Length 128 >>',
      ],
      '/Root 1 0 R /Encrypt 6 0 R',
    );

    const result = extractPdfText(page);

    expect(result).toEqual({ ok: false, refusal: 'encrypted' });
  });

  test('a page with drawing operators and no text refuses as a scan', () => {
    // What a scanned page is: an image painted over the whole media box, and
    // not one text-showing operator. Returning `''` here would be reported as
    // a 200 with a blank body, which is the defect this whole file closes.
    const result = extractPdfText(onePage('q 612 0 0 792 0 0 cm /Im0 Do Q'));

    expect(result).toEqual({ ok: false, refusal: 'no-text-layer' });
  });

  test('an HTML error page served as application/pdf refuses as not a PDF', () => {
    const result = extractPdfText(
      Buffer.from('<!doctype html><title>403 Forbidden</title>', 'latin1'),
    );

    expect(result).toEqual({ ok: false, refusal: 'not-a-pdf' });
  });

  test('a PDF header with nothing behind it refuses as unreadable', () => {
    const result = extractPdfText(Buffer.from('%PDF-1.7\ntrailer\n<< >>\n%%EOF\n', 'latin1'));

    expect(result).toEqual({ ok: false, refusal: 'unreadable' });
  });
});
