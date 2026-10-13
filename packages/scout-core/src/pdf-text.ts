/**
 * PDF TEXT, WITHOUT A PDF LIBRARY.
 *
 * A browser does not show a PDF as a document. Chromium hands
 * `application/pdf` to its PDF viewer, and the tab's own document is an
 * embedder shell: about 160 characters of HTML around one `<embed>`, an
 * `innerText` of 0 characters, and an accessibility tree that holds the
 * viewer's toolbar and none of the file's text. The text exists only in the
 * file's bytes, so the bytes are what this reads: bytes in, text out, no
 * network and no clock.
 *
 * Two readers use it: a scrape of a PDF URL, which turns the text into a
 * document, and the agent's browser binding, which reads the PDF its tab is
 * showing for `extract` (`@outcrawl/scout-cdp`, `pdf-document.ts`).
 *
 * ── Why this file exists rather than a dependency ──────────────────────────
 *
 * This package has zero third-party runtime dependencies. pdf.js is 350 kB of
 * rasteriser we would use 4% of. What a text layer actually needs is the object
 * graph, `FlateDecode`, the page tree, the eight text-showing operators and
 * `/ToUnicode`, and that is what is here. `node:zlib` is its one import.
 *
 * ── What it does NOT do, and says so out loud ──────────────────────────────
 *
 * No OCR and no rasterising, so a scanned PDF has no text to find; and no
 * decryption, so a PDF with `/Encrypt` in its trailer cannot be read at all.
 * Both are REFUSALS ({@link PdfExtraction}) and never an empty string, because
 * an empty string is indistinguishable from a blank page.
 *
 * ── The xref table is deliberately not parsed ──────────────────────────────
 *
 * Reading a PDF properly means the xref table, which is three formats (classic
 * table, cross-reference stream, hybrid) plus incremental-update chains, and
 * every one of them is routinely wrong in files that render fine — writers
 * truncate, concatenate and rewrite them. So this scans the whole file for
 * `N G obj`, SKIPPING THE INTERIOR OF EVERY STREAM IT FINDS so that compressed
 * bytes cannot forge an object header, and keeps the definition at the highest
 * file offset. That is the same rule an incremental update encodes, arrived at
 * without trusting a table.
 */

import { inflateRawSync, inflateSync } from 'node:zlib';

/* ------------------------------------------------------------------ *
 * The answer
 * ------------------------------------------------------------------ */

/**
 * Why a PDF produced no text. The scrape service hands it to its customer
 * verbatim as `details.reason` (`UnrepresentableReason` there is this type),
 * so this union is that wire field's one spelling. What the four members mean
 * FOR A PDF:
 *
 *   `not-a-pdf` — the bytes do not begin `%PDF-`. Usually an origin that
 *   served an HTML error page under a `.pdf` URL, or a login wall.
 *
 *   `encrypted` — the trailer names an `/Encrypt` dictionary. Even an
 *   owner-password PDF with no user password is encrypted on the wire, and
 *   nothing here decrypts.
 *
 *   `no-text-layer` — the file parsed, its pages were found, and they contain
 *   no text-showing operators worth anything. A scan. OCR is the answer and
 *   there is none here.
 *
 *   `unreadable` — the object graph could not be walked far enough to find a
 *   page. A truncated download, or a writer this parser does not understand.
 */
export type PdfRefusal = 'encrypted' | 'no-text-layer' | 'not-a-pdf' | 'unreadable';

export type PdfExtraction =
  | {
      readonly ok: true;
      /** Page texts joined by a blank line, line breaks preserved. */
      readonly text: string;
      readonly pages: number;
      /** `/Info /Title`, when the document declared one worth having. */
      readonly title?: string;
    }
  | {
      readonly ok: false;
      readonly refusal: PdfRefusal;
    };

/**
 * Text below this many characters over the whole document is not a text layer.
 *
 * A scanned page is rarely empty — a page number, a stamp, one stray glyph —
 * so the floor is not zero. It cannot be much above zero either, and the
 * number comes from the corpus rather than from taste: the smallest real PDF
 * in the probe, `w3.org/…/dummy.pdf`, has a text layer of exactly **14
 * characters** (`Dummy PDF file`). 4 is below that with room to spare and
 * above a bare folio.
 */
const MIN_TEXT_LAYER_CHARS = 4;

/* ------------------------------------------------------------------ *
 * Values
 * ------------------------------------------------------------------ */

interface PdfName {
  readonly kind: 'name';
  readonly name: string;
}
interface PdfRef {
  readonly kind: 'ref';
  readonly num: number;
}
interface PdfBytes {
  readonly kind: 'bytes';
  readonly bytes: Uint8Array;
}
interface PdfOperator {
  readonly kind: 'op';
  readonly op: string;
}
/** A dictionary followed by `stream`; `from`/`to` bracket the raw, still-encoded bytes. */
interface PdfStream {
  readonly kind: 'stream';
  readonly dict: PdfDict;
  readonly from: number;
  readonly to: number;
}
/** Keys are `/Name`s without the slash. A Map, not a Record: the keys are the file's. */
type PdfDict = Map<string, PdfValue>;
type PdfValue =
  | null
  | boolean
  | number
  | PdfName
  | PdfRef
  | PdfBytes
  | PdfStream
  | PdfOperator
  | PdfDict
  | readonly PdfValue[];

const isDict = (value: PdfValue | undefined): value is PdfDict => value instanceof Map;
const isRef = (value: PdfValue | undefined): value is PdfRef =>
  typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'ref';
const isName = (value: PdfValue | undefined): value is PdfName =>
  typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'name';
const isStream = (value: PdfValue | undefined): value is PdfStream =>
  typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'stream';
const isBytes = (value: PdfValue | undefined): value is PdfBytes =>
  typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'bytes';

/* ------------------------------------------------------------------ *
 * The lexer
 * ------------------------------------------------------------------ */

const SPACE = 0x20;
const LF = 0x0a;
const CR = 0x0d;

function isWhite(c: number): boolean {
  return c === SPACE || c === LF || c === CR || c === 0x09 || c === 0x0c || c === 0x00;
}

/** `()<>[]{}/%` — the characters that end a token without being part of it. */
function isDelimiter(c: number): boolean {
  return (
    c === 0x28 ||
    c === 0x29 ||
    c === 0x3c ||
    c === 0x3e ||
    c === 0x5b ||
    c === 0x5d ||
    c === 0x7b ||
    c === 0x7d ||
    c === 0x2f ||
    c === 0x25
  );
}

/**
 * One position in one byte range.
 *
 * A class rather than a closure because the content-stream machine below reads
 * and rewinds it across a dozen call sites, and a shared mutable cursor is what
 * a lexer is.
 */
class Cursor {
  pos: number;
  constructor(
    readonly b: Uint8Array,
    pos = 0,
    readonly end = b.length,
  ) {
    this.pos = pos;
  }

  /** Whitespace and `%` comments. Comments are legal between any two tokens. */
  skip(): void {
    for (;;) {
      while (this.pos < this.end && isWhite(this.b[this.pos] ?? 0)) this.pos += 1;
      if (this.pos < this.end && this.b[this.pos] === 0x25) {
        while (this.pos < this.end && this.b[this.pos] !== LF && this.b[this.pos] !== CR) {
          this.pos += 1;
        }
        continue;
      }
      return;
    }
  }
}

/** A bare keyword: `obj`, `endstream`, `Tj`, `true`. */
function readKeyword(c: Cursor): string {
  const from = c.pos;
  while (c.pos < c.end) {
    const ch = c.b[c.pos] ?? 0;
    if (isWhite(ch) || isDelimiter(ch)) break;
    c.pos += 1;
  }
  return latin1(c.b, from, c.pos);
}

function latin1(b: Uint8Array, from: number, to: number): string {
  let out = '';
  // Chunked, because `String.fromCharCode(...huge)` blows the argument limit
  // and a 2 MB content stream reaches it.
  for (let at = from; at < to; at += 4096) {
    out += String.fromCharCode(...b.subarray(at, Math.min(at + 4096, to)));
  }
  return out;
}

function readName(c: Cursor): PdfName {
  c.pos += 1;
  let name = '';
  while (c.pos < c.end) {
    const ch = c.b[c.pos] ?? 0;
    if (isWhite(ch) || isDelimiter(ch)) break;
    if (ch === 0x23 && c.pos + 2 < c.end) {
      const hex = latin1(c.b, c.pos + 1, c.pos + 3);
      const code = Number.parseInt(hex, 16);
      if (Number.isFinite(code)) {
        name += String.fromCharCode(code);
        c.pos += 3;
        continue;
      }
    }
    name += String.fromCharCode(ch);
    c.pos += 1;
  }
  return { kind: 'name', name };
}

/** `(text \(with\) escapes)`, nesting honoured, returned as bytes. */
function readLiteralString(c: Cursor): PdfBytes {
  c.pos += 1;
  const out: number[] = [];
  let depth = 1;
  while (c.pos < c.end) {
    const ch = c.b[c.pos] ?? 0;
    c.pos += 1;
    if (ch === 0x5c) {
      const esc = c.b[c.pos] ?? 0;
      c.pos += 1;
      if (esc === 0x6e) out.push(LF);
      else if (esc === 0x72) out.push(CR);
      else if (esc === 0x74) out.push(0x09);
      else if (esc === 0x62) out.push(0x08);
      else if (esc === 0x66) out.push(0x0c);
      else if (esc >= 0x30 && esc <= 0x37) {
        let code = esc - 0x30;
        for (let taken = 0; taken < 2; taken += 1) {
          const next = c.b[c.pos] ?? 0;
          if (next < 0x30 || next > 0x37) break;
          code = code * 8 + (next - 0x30);
          c.pos += 1;
        }
        out.push(code & 0xff);
      } else if (esc === CR) {
        if (c.b[c.pos] === LF) c.pos += 1;
      } else if (esc !== LF) out.push(esc);
      continue;
    }
    if (ch === 0x28) depth += 1;
    if (ch === 0x29) {
      depth -= 1;
      if (depth === 0) break;
    }
    out.push(ch);
  }
  return { kind: 'bytes', bytes: Uint8Array.from(out) };
}

function hexDigit(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

function readHexString(c: Cursor): PdfBytes {
  c.pos += 1;
  const out: number[] = [];
  let high = -1;
  while (c.pos < c.end) {
    const ch = c.b[c.pos] ?? 0;
    c.pos += 1;
    if (ch === 0x3e) break;
    const digit = hexDigit(ch);
    if (digit < 0) continue;
    if (high < 0) high = digit;
    else {
      out.push(high * 16 + digit);
      high = -1;
    }
  }
  // An odd number of digits: the trailing one is a high nibble. Per spec.
  if (high >= 0) out.push(high * 16);
  return { kind: 'bytes', bytes: Uint8Array.from(out) };
}

const MAX_DEPTH = 64;

/**
 * One object at the cursor, or `undefined` at a closer (`]`, `>>`) or the end.
 *
 * The same function serves the file's object graph and a page's content stream,
 * which is why bare keywords come back as {@link PdfOperator} rather than being
 * rejected: in the graph the only ones that appear are `true`/`false`/`null`
 * and the `obj`/`stream` structure the caller reads itself, and in a content
 * stream every operator is one.
 */
function parseValue(c: Cursor, depth = 0): PdfValue | undefined {
  c.skip();
  if (c.pos >= c.end || depth > MAX_DEPTH) return undefined;
  const ch = c.b[c.pos] ?? 0;

  if (ch === 0x2f) return readName(c);
  if (ch === 0x28) return readLiteralString(c);
  if (ch === 0x5b) {
    c.pos += 1;
    const items: PdfValue[] = [];
    for (;;) {
      c.skip();
      if (c.pos >= c.end) break;
      if (c.b[c.pos] === 0x5d) {
        c.pos += 1;
        break;
      }
      const item = parseValue(c, depth + 1);
      if (item === undefined) break;
      items.push(item);
    }
    return items;
  }
  if (ch === 0x5d || ch === 0x7d) {
    c.pos += 1;
    return undefined;
  }
  if (ch === 0x3c) {
    if (c.b[c.pos + 1] === 0x3c) return parseDict(c, depth);
    return readHexString(c);
  }
  if (ch === 0x3e) {
    // A stray `>>` with no dictionary open. Consume it so callers advance.
    c.pos += c.b[c.pos + 1] === 0x3e ? 2 : 1;
    return undefined;
  }
  if (ch === 0x7b) {
    c.pos += 1;
    return parseValue(c, depth + 1);
  }
  if ((ch >= 0x30 && ch <= 0x39) || ch === 0x2b || ch === 0x2d || ch === 0x2e) {
    return parseNumberOrRef(c);
  }

  const word = readKeyword(c);
  if (word === 'true') return true;
  if (word === 'false') return false;
  if (word === 'null') return null;
  if (word === '') {
    // Not whitespace, not a delimiter we handle, and zero-length: an unusable
    // byte. Step over it rather than spinning.
    c.pos += 1;
    return undefined;
  }
  return { kind: 'op', op: word };
}

function parseDict(c: Cursor, depth: number): PdfDict {
  c.pos += 2;
  const dict: PdfDict = new Map();
  for (;;) {
    c.skip();
    if (c.pos >= c.end) break;
    if (c.b[c.pos] === 0x3e && c.b[c.pos + 1] === 0x3e) {
      c.pos += 2;
      break;
    }
    if (c.b[c.pos] !== 0x2f) {
      // A malformed entry. Consume one value so the loop makes progress rather
      // than reading the same byte forever.
      if (parseValue(c, depth + 1) === undefined && c.pos < c.end) c.pos += 1;
      continue;
    }
    const key = readName(c);
    const value = parseValue(c, depth + 1);
    if (value === undefined) continue;
    dict.set(key.name, value);
  }
  return dict;
}

/** A number, or `N G R` when the three tokens are there. */
function parseNumberOrRef(c: Cursor): PdfValue {
  const from = c.pos;
  while (c.pos < c.end) {
    const ch = c.b[c.pos] ?? 0;
    if ((ch >= 0x30 && ch <= 0x39) || ch === 0x2b || ch === 0x2d || ch === 0x2e || ch === 0x45 || ch === 0x65) {
      c.pos += 1;
      continue;
    }
    break;
  }
  const text = latin1(c.b, from, c.pos);
  const value = Number.parseFloat(text);
  const number = Number.isFinite(value) ? value : 0;
  if (!Number.isInteger(number) || number < 0 || text.includes('.')) return number;

  const save = c.pos;
  c.skip();
  const genFrom = c.pos;
  while (c.pos < c.end && (c.b[c.pos] ?? 0) >= 0x30 && (c.b[c.pos] ?? 0) <= 0x39) c.pos += 1;
  if (c.pos > genFrom) {
    const afterGen = c.pos;
    c.skip();
    if (c.b[c.pos] === 0x52) {
      const after = c.b[c.pos + 1] ?? SPACE;
      if (isWhite(after) || isDelimiter(after) || c.pos + 1 >= c.end) {
        c.pos += 1;
        return { kind: 'ref', num: number };
      }
    }
    c.pos = afterGen;
  }
  c.pos = save;
  return number;
}

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

/**
 * `FlateDecode`, tolerantly.
 *
 * Two tolerances, both measured against real files rather than imagined: a
 * writer that emitted a raw deflate stream with no zlib header (`inflateRaw`),
 * and a stream whose declared `/Length` overran into the `endstream` keyword,
 * which `inflateSync` rejects wholesale — `finishFlush: Z_SYNC_FLUSH` returns
 * the prefix it did decode instead of nothing at all.
 */
function flate(bytes: Uint8Array): Uint8Array | null {
  try {
    return inflateSync(bytes);
  } catch {
    /* fall through */
  }
  try {
    return inflateSync(bytes, { finishFlush: 2 });
  } catch {
    /* fall through */
  }
  try {
    return inflateRawSync(bytes, { finishFlush: 2 });
  } catch {
    return null;
  }
}

function asciiHexDecode(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  let high = -1;
  for (const ch of bytes) {
    if (ch === 0x3e) break;
    const digit = hexDigit(ch);
    if (digit < 0) continue;
    if (high < 0) high = digit;
    else {
      out.push(high * 16 + digit);
      high = -1;
    }
  }
  if (high >= 0) out.push(high * 16);
  return Uint8Array.from(out);
}

function ascii85Decode(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  let group: number[] = [];
  for (let at = 0; at < bytes.length; at += 1) {
    const ch = bytes[at] ?? 0;
    if (isWhite(ch)) continue;
    if (ch === 0x7e) break;
    if (ch === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (ch < 0x21 || ch > 0x75) continue;
    group.push(ch - 0x21);
    if (group.length === 5) {
      let value = 0;
      for (const digit of group) value = value * 85 + digit;
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      group = [];
    }
  }
  if (group.length > 1) {
    const short = group.length;
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const full = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    for (let taken = 0; taken < short - 1; taken += 1) out.push(full[taken] ?? 0);
  }
  return Uint8Array.from(out);
}

function runLengthDecode(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  let at = 0;
  while (at < bytes.length) {
    const length = bytes[at] ?? 128;
    at += 1;
    if (length === 128) break;
    if (length < 128) {
      for (let taken = 0; taken <= length; taken += 1) out.push(bytes[at + taken] ?? 0);
      at += length + 1;
      continue;
    }
    const repeated = bytes[at] ?? 0;
    at += 1;
    for (let taken = 0; taken < 257 - length; taken += 1) out.push(repeated);
  }
  return Uint8Array.from(out);
}

/** The variable-code LZW of the PDF spec: early change, 9..12 bits, 256 clear, 257 EOD. */
function lzwDecode(bytes: Uint8Array, earlyChange: boolean): Uint8Array {
  const out: number[] = [];
  let table: number[][] = [];
  const reset = (): void => {
    table = [];
    for (let code = 0; code < 256; code += 1) table.push([code]);
    table.push([], []);
  };
  reset();
  let width = 9;
  let previous: number[] | null = null;
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= width) {
      const code = (buffer >> (bits - width)) & ((1 << width) - 1);
      bits -= width;
      if (code === 256) {
        reset();
        width = 9;
        previous = null;
        continue;
      }
      if (code === 257) return Uint8Array.from(out);
      let entry: number[];
      const known = table[code];
      if (known !== undefined && code < table.length) entry = known;
      else if (previous !== null) entry = [...previous, previous[0] ?? 0];
      else return Uint8Array.from(out);
      out.push(...entry);
      if (previous !== null) table.push([...previous, entry[0] ?? 0]);
      previous = entry;
      const limit = table.length + (earlyChange ? 1 : 0);
      if (limit >= 512 && width < 10) width = 10;
      if (limit >= 1024 && width < 11) width = 11;
      if (limit >= 2048 && width < 12) width = 12;
    }
  }
  return Uint8Array.from(out);
}

/**
 * PNG and TIFF predictors, which a `/FlateDecode` stream may be filtered
 * through. Object streams and cross-reference streams routinely are, and
 * skipping this turns them into noise rather than into an error.
 */
function undoPredictor(data: Uint8Array, parms: PdfDict, resolve: Resolve): Uint8Array {
  const predictor = numberOf(resolve(parms.get('Predictor')), 1);
  if (predictor <= 1) return data;
  const colors = numberOf(resolve(parms.get('Colors')), 1);
  const bpc = numberOf(resolve(parms.get('BitsPerComponent')), 8);
  const columns = numberOf(resolve(parms.get('Columns')), 1);
  const pixelBytes = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);

  if (predictor === 2) {
    if (bpc !== 8) return data;
    for (let row = 0; row + rowBytes <= data.length; row += rowBytes) {
      for (let at = pixelBytes; at < rowBytes; at += 1) {
        data[row + at] = ((data[row + at] ?? 0) + (data[row + at - pixelBytes] ?? 0)) & 0xff;
      }
    }
    return data;
  }

  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  let previous = new Uint8Array(rowBytes);
  for (let row = 0; row < rows; row += 1) {
    const tag = data[row * (rowBytes + 1)] ?? 0;
    const from = row * (rowBytes + 1) + 1;
    const line = data.subarray(from, from + rowBytes);
    const decoded = new Uint8Array(rowBytes);
    for (let at = 0; at < rowBytes; at += 1) {
      const raw = line[at] ?? 0;
      const left = at >= pixelBytes ? (decoded[at - pixelBytes] ?? 0) : 0;
      const up = previous[at] ?? 0;
      const upLeft = at >= pixelBytes ? (previous[at - pixelBytes] ?? 0) : 0;
      let value = raw;
      if (tag === 1) value = raw + left;
      else if (tag === 2) value = raw + up;
      else if (tag === 3) value = raw + ((left + up) >> 1);
      else if (tag === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      decoded[at] = value & 0xff;
    }
    out.set(decoded, row * rowBytes);
    previous = decoded;
  }
  return out;
}

function numberOf(value: PdfValue | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

type Resolve = (value: PdfValue | undefined) => PdfValue | undefined;

/* ------------------------------------------------------------------ *
 * The document
 * ------------------------------------------------------------------ */

/** `N G obj`, anywhere in the file. Stream interiors are skipped by the caller. */
const OBJECT_HEADER = /(\d{1,10})[\s\0]+(\d{1,5})[\s\0]+obj\b/g;

interface Definition {
  readonly value: PdfValue;
  /** Byte offset of the definition, so the LATEST one in the file wins. */
  readonly at: number;
}

class PdfDocument {
  readonly #objects = new Map<number, Definition>();
  readonly #decoded = new Map<number, Uint8Array | null>();
  readonly trailers: PdfDict[] = [];

  constructor(readonly bytes: Uint8Array) {}

  resolve: Resolve = (value) => {
    let current = value;
    for (let hops = 0; hops < 32 && isRef(current); hops += 1) {
      current = this.#objects.get(current.num)?.value;
    }
    return isRef(current) ? undefined : current;
  };

  define(num: number, value: PdfValue, at: number): void {
    const existing = this.#objects.get(num);
    if (existing !== undefined && existing.at > at) return;
    this.#objects.set(num, { value, at });
  }

  get(num: number): PdfValue | undefined {
    return this.#objects.get(num)?.value;
  }

  entries(): IterableIterator<[number, Definition]> {
    return this.#objects.entries();
  }

  /** A stream's bytes, filters applied. `null` when a filter is one we do not have. */
  streamBytes(stream: PdfStream, cacheKey?: number): Uint8Array | null {
    if (cacheKey !== undefined) {
      const hit = this.#decoded.get(cacheKey);
      if (hit !== undefined) return hit;
    }
    const out = this.#decodeStream(stream);
    if (cacheKey !== undefined) this.#decoded.set(cacheKey, out);
    return out;
  }

  #decodeStream(stream: PdfStream): Uint8Array | null {
    let data = this.bytes.subarray(stream.from, stream.to);
    const filterValue = this.resolve(stream.dict.get('Filter'));
    const filters = (
      Array.isArray(filterValue) ? filterValue : filterValue === undefined ? [] : [filterValue]
    ).map((entry) => this.resolve(entry));
    const parmsValue = this.resolve(stream.dict.get('DecodeParms'));
    const parmsList = Array.isArray(parmsValue) ? parmsValue : [parmsValue];

    for (let step = 0; step < filters.length; step += 1) {
      const filter = filters[step];
      if (!isName(filter)) return null;
      const parms = this.resolve(parmsList[step] ?? (filters.length === 1 ? parmsList[0] : undefined));
      switch (filter.name) {
        case 'FlateDecode':
        case 'Fl': {
          const inflated = flate(data);
          if (inflated === null) return null;
          data = inflated;
          break;
        }
        case 'LZWDecode':
        case 'LZW': {
          const early = isDict(parms) ? numberOf(this.resolve(parms.get('EarlyChange')), 1) : 1;
          data = lzwDecode(data, early !== 0);
          break;
        }
        case 'ASCIIHexDecode':
        case 'AHx':
          data = asciiHexDecode(data);
          break;
        case 'ASCII85Decode':
        case 'A85':
          data = ascii85Decode(data);
          break;
        case 'RunLengthDecode':
        case 'RL':
          data = runLengthDecode(data);
          break;
        case 'Crypt':
          break;
        default:
          // DCTDecode, JPXDecode, CCITTFaxDecode: an image, never a content
          // stream. Refusing is right — decoding it would be OCR's job.
          return null;
      }
      if (isDict(parms)) data = undoPredictor(data, parms, this.resolve);
    }
    return data;
  }
}

/**
 * Every `N G obj` in the file, with stream interiors skipped.
 *
 * The skip is what makes a whole-file scan safe: a compressed stream contains
 * arbitrary bytes, and `12 0 obj` appears in 2 MB of deflate output about as
 * often as you would expect. Because a stream's extent is known the moment its
 * dictionary is read, every match inside one is discarded before it can define
 * anything.
 */
function scanObjects(doc: PdfDocument, src: string): void {
  const bytes = doc.bytes;
  OBJECT_HEADER.lastIndex = 0;
  let skipUntil = 0;
  for (;;) {
    const match = OBJECT_HEADER.exec(src);
    if (match === null) break;
    if (match.index < skipUntil) continue;
    const num = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isFinite(num)) continue;

    const cursor = new Cursor(bytes, match.index + match[0].length);
    const value = parseValue(cursor);
    if (value === undefined) continue;

    cursor.skip();
    const save = cursor.pos;
    const keyword = readKeyword(cursor);
    if (keyword === 'stream' && isDict(value)) {
      // The EOL after `stream` is CRLF or LF, never a bare CR. Per spec, and
      // getting it wrong shifts every byte of the stream by one.
      if (bytes[cursor.pos] === CR) cursor.pos += 1;
      if (bytes[cursor.pos] === LF) cursor.pos += 1;
      const from = cursor.pos;
      const to = streamEnd(doc, src, value, from);
      doc.define(num, { kind: 'stream', dict: value, from, to }, match.index);
      skipUntil = to;
      OBJECT_HEADER.lastIndex = to;
      continue;
    }
    cursor.pos = save;
    doc.define(num, value, match.index);
  }
}

/**
 * Where a stream's bytes end.
 *
 * `/Length` FIRST, and `endstream` only as the fallback, because binary content
 * legitimately contains the nine bytes `endstream`. But `/Length` is also the
 * field writers get wrong, so it is only believed when the bytes it points at
 * are actually followed by the keyword.
 */
function streamEnd(doc: PdfDocument, src: string, dict: PdfDict, from: number): number {
  const declared = doc.resolve(dict.get('Length'));
  if (typeof declared === 'number' && declared >= 0 && from + declared <= doc.bytes.length) {
    const at = from + declared;
    const tail = src.slice(at, at + 20);
    if (/^[\r\n\s]*endstream/.test(tail)) return at;
  }
  const found = src.indexOf('endstream', from);
  if (found === -1) return doc.bytes.length;
  let at = found;
  if (src[at - 1] === '\n') at -= 1;
  if (src[at - 1] === '\r') at -= 1;
  return at;
}

/**
 * Objects that live inside `/Type /ObjStm`, which is where a modern writer puts
 * the page tree. Skipping this reads a 2020s PDF as a file with no pages in it.
 */
function expandObjectStreams(doc: PdfDocument): void {
  const streams: { num: number; stream: PdfStream; at: number }[] = [];
  for (const [num, definition] of doc.entries()) {
    const value = definition.value;
    if (!isStream(value)) continue;
    const type = doc.resolve(value.dict.get('Type'));
    if (isName(type) && type.name === 'ObjStm') {
      streams.push({ num, stream: value, at: definition.at });
    }
  }
  for (const { num, stream, at } of streams) {
    const data = doc.streamBytes(stream, num);
    if (data === null) continue;
    const count = numberOf(doc.resolve(stream.dict.get('N')), 0);
    const first = numberOf(doc.resolve(stream.dict.get('First')), 0);
    const header = new Cursor(data, 0, Math.min(first, data.length));
    const pairs: { num: number; offset: number }[] = [];
    for (let taken = 0; taken < count; taken += 1) {
      const objNum = parseValue(header);
      const offset = parseValue(header);
      if (typeof objNum !== 'number' || typeof offset !== 'number') break;
      pairs.push({ num: objNum, offset });
    }
    for (const pair of pairs) {
      const start = first + pair.offset;
      if (start >= data.length) continue;
      const cursor = new Cursor(data, start);
      const value = parseValue(cursor);
      if (value === undefined) continue;
      // The container's own file offset: an object inside a stream is exactly
      // as recent as the stream that carries it.
      doc.define(pair.num, value, at);
    }
  }
}

/** Classic `trailer` dictionaries plus every cross-reference stream's own dict. */
function collectTrailers(doc: PdfDocument, src: string): void {
  const pattern = /trailer\b/g;
  for (;;) {
    const match = pattern.exec(src);
    if (match === null) break;
    const cursor = new Cursor(doc.bytes, match.index + match[0].length);
    const dict = parseValue(cursor);
    if (isDict(dict)) doc.trailers.push(dict);
  }
  for (const [, definition] of doc.entries()) {
    const value = definition.value;
    if (!isStream(value)) continue;
    const type = doc.resolve(value.dict.get('Type'));
    if (isName(type) && type.name === 'XRef') doc.trailers.push(value.dict);
  }
}

/* ------------------------------------------------------------------ *
 * The page tree
 * ------------------------------------------------------------------ */

interface PdfPage {
  readonly dict: PdfDict;
  /** `/Resources`, inherited down the tree when the leaf does not carry one. */
  readonly resources: PdfDict | undefined;
}

const MAX_PAGES = 5_000;

function collectPages(doc: PdfDocument): PdfPage[] {
  const pages: PdfPage[] = [];
  const root = findCatalog(doc);
  const tree = root === undefined ? undefined : doc.resolve(root.get('Pages'));
  if (isDict(tree)) {
    walkPageTree(doc, tree, undefined, pages, new Set<PdfDict>(), 0);
  }
  if (pages.length > 0) return pages;

  // No walkable tree. Every `/Type /Page` in object-number order is a worse
  // ordering than the tree's and an infinitely better one than none.
  const loose: { num: number; page: PdfPage }[] = [];
  for (const [num, definition] of doc.entries()) {
    const value = definition.value;
    if (!isDict(value)) continue;
    const type = doc.resolve(value.get('Type'));
    if (!isName(type) || type.name !== 'Page') continue;
    const resources = doc.resolve(value.get('Resources'));
    loose.push({ num, page: { dict: value, resources: isDict(resources) ? resources : undefined } });
  }
  loose.sort((left, right) => left.num - right.num);
  return loose.map((entry) => entry.page);
}

function findCatalog(doc: PdfDocument): PdfDict | undefined {
  // Last trailer first: that is the most recent incremental update.
  for (let at = doc.trailers.length - 1; at >= 0; at -= 1) {
    const root = doc.resolve(doc.trailers[at]?.get('Root'));
    if (isDict(root) && root.has('Pages')) return root;
  }
  for (const [, definition] of doc.entries()) {
    const value = definition.value;
    if (!isDict(value)) continue;
    const type = doc.resolve(value.get('Type'));
    if (isName(type) && type.name === 'Catalog') return value;
  }
  return undefined;
}

function walkPageTree(
  doc: PdfDocument,
  node: PdfDict,
  inherited: PdfDict | undefined,
  into: PdfPage[],
  seen: Set<PdfDict>,
  depth: number,
): void {
  if (seen.has(node) || depth > 64 || into.length >= MAX_PAGES) return;
  seen.add(node);
  const own = doc.resolve(node.get('Resources'));
  const resources = isDict(own) ? own : inherited;
  const kids = doc.resolve(node.get('Kids'));
  const type = doc.resolve(node.get('Type'));

  if (Array.isArray(kids)) {
    for (const kid of kids) {
      const child = doc.resolve(kid);
      if (isDict(child)) walkPageTree(doc, child, resources, into, seen, depth + 1);
    }
    return;
  }
  if (isName(type) && type.name === 'Pages') return;
  into.push({ dict: node, resources });
}

/* ------------------------------------------------------------------ *
 * Fonts
 * ------------------------------------------------------------------ */

/**
 * `0x80`–`0x9f` of WinAnsiEncoding, which is where it and Latin-1 disagree.
 *
 * Thirty-two entries, and they are the ones that show: smart quotes, the em
 * dash and the ellipsis are in this block, so without it a quoted sentence in
 * any Word-produced PDF comes back with control characters in it.
 */
const WIN_ANSI_HIGH: Readonly<Record<number, string>> = {
  0x80: '\u20ac', 0x82: '\u201a', 0x83: '\u0192', 0x84: '\u201e', 0x85: '\u2026',
  0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02c6', 0x89: '\u2030', 0x8a: '\u0160',
  0x8b: '\u2039', 0x8c: '\u0152', 0x8e: '\u017d', 0x91: '\u2018', 0x92: '\u2019',
  0x93: '\u201c', 0x94: '\u201d', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
  0x98: '\u02dc', 0x99: '\u2122', 0x9a: '\u0161', 0x9b: '\u203a', 0x9c: '\u0153',
  0x9e: '\u017e', 0x9f: '\u0178',
};

interface Font {
  /** Codes are two bytes: a Type0 (composite) font. A simple font's code is one byte. */
  readonly wide: boolean;
  /** `/ToUnicode`, when the font carried one. */
  readonly toUnicode: Map<number, string> | null;
  /** Glyph advances by code, in thousandths of an em, as the font declared them. */
  readonly widths: Map<number, number>;
  /** `/MissingWidth` or `/DW`, for a code the table does not name. */
  readonly defaultWidth: number;
}

/** One decoded glyph: the characters it stands for, and how far the pen moves. */
interface Glyph {
  readonly text: string;
  /** Advance in thousandths of an em, before `Tfs`, `Tc`, `Tw` and `Tz`. */
  readonly width: number;
  /** True for a single-byte code 32, the only code `Tw` applies to. */
  readonly isSpaceCode: boolean;
}

/**
 * `/ToUnicode` is the only honest source of characters, and a font without one
 * is read as Latin-1 — which is right for a simple font (the code IS the byte)
 * and impossible for a composite one, where a code is a glyph index into a
 * subset nobody outside the file has the table for. An unmapped wide code
 * contributes nothing rather than a plausible wrong letter.
 *
 * THE WIDTHS ARE NOT DECORATION. Without them there is no way to tell a kern
 * from a word gap, and the first version of this file could not: `dummy.pdf`
 * came back as `Dumm y PDF fi le`, because every `Td` between two glyph runs
 * was read as a space. The pen position is the only thing that distinguishes
 * them, and the pen position needs the advance of everything already drawn.
 */
function glyphsOf(font: Font | null, bytes: Uint8Array): Glyph[] {
  const out: Glyph[] = [];
  const step = font?.wide === true ? 2 : 1;
  for (let at = 0; at + step <= bytes.length; at += step) {
    const code = step === 2 ? ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0) : (bytes[at] ?? 0);
    const mapped = font?.toUnicode?.get(code);
    const text =
      mapped ?? (step === 1 ? (WIN_ANSI_HIGH[code] ?? String.fromCharCode(code)) : '');
    out.push({
      text,
      width: font?.widths.get(code) ?? font?.defaultWidth ?? DEFAULT_GLYPH_WIDTH,
      isSpaceCode: step === 1 && code === 0x20,
    });
  }
  return out;
}

/**
 * The advance to assume for a glyph nothing declares a width for.
 *
 * The standard 14 fonts carry no `/Widths` array at all, so this is what a
 * `/Helvetica` page is measured with. 500 is the mean advance of Helvetica's
 * lowercase alphabet; it is wrong per glyph and right on average, which is all
 * a word-gap threshold needs.
 */
const DEFAULT_GLYPH_WIDTH = 500;

/**
 * A font's codes, widths and `/ToUnicode`.
 *
 * ONLY A TYPE0 FONT HAS TWO-BYTE CODES. A simple font (Type1, TrueType, Type3)
 * is one byte per code by definition, whatever its `/ToUnicode` declares as a
 * codespace: common writers emit `<0000> <FFFF>` there for a simple TrueType
 * font and map its one-byte codes as `<0041>`. Reading that codespace as the
 * code width paired every two bytes of text into a code no map holds, and a
 * 114-page court opinion (TrueType, WinAnsi, `/ToUnicode` on every font) came
 * back as 13 characters, five bullets; read a byte at a time it is the text
 * `pdftotext` gives (measured 2026-10-13, n=1).
 */
function buildFont(doc: PdfDocument, dict: PdfDict): Font {
  const subtype = doc.resolve(dict.get('Subtype'));
  const composite = isName(subtype) && subtype.name === 'Type0';

  let toUnicode: Map<number, string> | null = null;
  const cmapValue = doc.resolve(dict.get('ToUnicode'));
  if (isStream(cmapValue)) {
    const data = doc.streamBytes(cmapValue);
    if (data !== null) toUnicode = parseCMap(data);
  }

  const widths = new Map<number, number>();
  let defaultWidth = DEFAULT_GLYPH_WIDTH;

  if (composite) {
    const descendants = doc.resolve(dict.get('DescendantFonts'));
    const descendant = Array.isArray(descendants) ? doc.resolve(descendants[0]) : undefined;
    if (isDict(descendant)) {
      defaultWidth = numberOf(doc.resolve(descendant.get('DW')), 1000);
      readCidWidths(doc, doc.resolve(descendant.get('W')), widths);
    }
  } else {
    const table = doc.resolve(dict.get('Widths'));
    if (Array.isArray(table)) {
      const first = numberOf(doc.resolve(dict.get('FirstChar')), 0);
      for (let at = 0; at < table.length; at += 1) {
        const width = doc.resolve(table[at]);
        if (typeof width === 'number') widths.set(first + at, width);
      }
      const descriptor = doc.resolve(dict.get('FontDescriptor'));
      defaultWidth = isDict(descriptor)
        ? numberOf(doc.resolve(descriptor.get('MissingWidth')), 0)
        : 0;
    }
  }

  return { wide: composite, toUnicode, widths, defaultWidth };
}

/** `/W`: `[ c [w …] ]` names consecutive codes, `[ first last w ]` names a run. */
function readCidWidths(doc: PdfDocument, table: PdfValue | undefined, into: Map<number, number>): void {
  if (!Array.isArray(table)) return;
  for (let at = 0; at < table.length; ) {
    const start = doc.resolve(table[at]);
    const second = doc.resolve(table[at + 1]);
    if (typeof start !== 'number') break;
    if (Array.isArray(second)) {
      for (let step = 0; step < second.length; step += 1) {
        const width = doc.resolve(second[step]);
        if (typeof width === 'number') into.set(start + step, width);
      }
      at += 2;
      continue;
    }
    const width = doc.resolve(table[at + 2]);
    if (typeof second !== 'number' || typeof width !== 'number') break;
    // Runs are legitimately long — a CJK subset names 20,000 codes — but a
    // corrupt pair must not be allowed to allocate for hours.
    const last = Math.min(second, start + 65_535);
    for (let code = start; code <= last; code += 1) into.set(code, width);
    at += 3;
  }
}

/**
 * A `/ToUnicode` CMap: `begincodespacerange`, `beginbfchar`, `beginbfrange`.
 *
 * Destinations are UTF-16BE, which is why a ligature maps to more than one
 * character — `fi` in a LaTeX paper is one code and two letters, and reading
 * only the first is how "definition" becomes "denition".
 */
function parseCMap(data: Uint8Array): Map<number, string> {
  const map = new Map<number, string>();
  const cursor = new Cursor(data);
  const stack: PdfValue[] = [];

  for (;;) {
    if (cursor.pos >= cursor.end) break;
    const value = parseValue(cursor);
    if (value === undefined) {
      if (cursor.pos >= cursor.end) break;
      continue;
    }
    if (typeof value !== 'object' || value === null || !('kind' in value) || value.kind !== 'op') {
      stack.push(value);
      if (stack.length > 512) stack.splice(0, stack.length - 512);
      continue;
    }
    const op = value.op;
    if (op === 'begincodespacerange') {
      // Consumed and not used: a code's width is the font's (`buildFont`), never
      // this range's, which writers routinely declare two bytes wide for a
      // one-byte simple font.
      for (;;) {
        const low = parseValue(cursor);
        if (!isBytes(low)) break;
        const high = parseValue(cursor);
        if (!isBytes(high)) break;
      }
      stack.length = 0;
      continue;
    }
    if (op === 'beginbfchar') {
      for (;;) {
        const from = parseValue(cursor);
        if (!isBytes(from)) break;
        const to = parseValue(cursor);
        if (isBytes(to)) map.set(codeOf(from.bytes), utf16be(to.bytes));
        else if (isName(to)) map.set(codeOf(from.bytes), to.name);
        else break;
      }
      stack.length = 0;
      continue;
    }
    if (op === 'beginbfrange') {
      for (;;) {
        const low = parseValue(cursor);
        if (!isBytes(low)) break;
        const high = parseValue(cursor);
        if (!isBytes(high)) break;
        const target = parseValue(cursor);
        const start = codeOf(low.bytes);
        const stop = codeOf(high.bytes);
        if (stop < start || stop - start > 65_535) break;
        if (isBytes(target)) {
          const text = utf16be(target.bytes);
          const last = text.length === 0 ? 0 : (text.codePointAt(text.length - 1) ?? 0);
          const prefix = text.slice(0, text.length - (last > 0xffff ? 2 : 1));
          for (let code = start; code <= stop; code += 1) {
            map.set(code, prefix + String.fromCodePoint(last + (code - start)));
          }
        } else if (Array.isArray(target)) {
          for (let code = start; code <= stop; code += 1) {
            const entry = target[code - start];
            if (isBytes(entry)) map.set(code, utf16be(entry.bytes));
          }
        } else break;
      }
      stack.length = 0;
      continue;
    }
    stack.length = 0;
  }
  return map;
}

function codeOf(bytes: Uint8Array): number {
  let code = 0;
  for (const byte of bytes.subarray(0, 4)) code = (code << 8) | byte;
  return code;
}

function utf16be(bytes: Uint8Array): string {
  let out = '';
  for (let at = 0; at + 1 < bytes.length; at += 2) {
    out += String.fromCharCode(((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0));
  }
  if (bytes.length === 1) out += String.fromCharCode(bytes[0] ?? 0);
  return out;
}

/* ------------------------------------------------------------------ *
 * Content streams
 * ------------------------------------------------------------------ */

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

/**
 * Where a line break goes, as a fraction of the font size.
 *
 * A superscript sits about 0.33 em above its baseline and a footnote marker
 * must not start a new line; a set line is a whole leading below, which is
 * 1.0 em or more. 0.5 separates them with margin on both sides.
 */
const LINE_BREAK_EM = 0.5;

/**
 * A horizontal jump this wide, as a fraction of the font size, is a space.
 *
 * Measured against the pen — where the last glyph's advance left it — and not
 * against where the last run started, which is why the font's `/Widths` are
 * read. Justified text stretches word gaps to well over half an em; the tight
 * side of a kern pair is a few hundredths. 0.2 sits between them.
 */
const WORD_GAP_EM = 0.2;

/**
 * Lines of text, assembled from glyph runs and the pen positions they were
 * drawn at.
 *
 * A PDF has no lines and no words: it has glyphs at coordinates. Reading order
 * is recovered from exactly two facts — the baseline moved (a new line) and the
 * pen jumped forward (a space) — and both are decided here so that the operator
 * loop below stays a transcription of the spec.
 */
class TextMachine {
  readonly #lines: string[] = [];
  #line = '';
  #lastY: number | null = null;
  #penX = 0;

  /**
   * A run of text drawn from `x` to `endX` on baseline `y`.
   *
   * `size` is the font size in device space, which is what both thresholds are
   * relative to: the same 6-point jump is a new line in a footnote and a kern
   * in a title.
   */
  show(text: string, x: number, endX: number, y: number, size: number): void {
    const em = Math.max(Math.abs(size), 1);
    if (this.#lastY !== null && Math.abs(y - this.#lastY) >= em * LINE_BREAK_EM) this.newline();
    else if (
      this.#line !== '' &&
      x - this.#penX >= em * WORD_GAP_EM &&
      !/\s$/.test(this.#line) &&
      !/^\s/.test(text)
    ) {
      this.#line += ' ';
    }
    this.#lastY = y;
    this.#penX = endX;
    this.#line += text;
  }

  newline(): void {
    this.#lines.push(this.#line);
    this.#line = '';
  }

  finish(): string {
    if (this.#line !== '') this.newline();
    return this.#lines
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

interface GraphicsState {
  font: Font | null;
  fontSize: number;
  leading: number;
  charSpacing: number;
  wordSpacing: number;
  horizontal: number;
  ctm: Matrix;
}

const MAX_FORM_DEPTH = 8;

/** One content stream, run against one machine. Form XObjects recurse. */
function runContent(
  doc: PdfDocument,
  content: Uint8Array,
  resources: PdfDict | undefined,
  machine: TextMachine,
  fonts: Map<PdfDict, Font>,
  state: GraphicsState,
  depth: number,
): void {
  const cursor = new Cursor(content);
  const operands: PdfValue[] = [];
  const stack: GraphicsState[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;

  const fontDicts = doc.resolve(resources?.get('Font'));
  const xobjects = doc.resolve(resources?.get('XObject'));

  const number = (at: number): number => {
    const value = operands[operands.length - at];
    return typeof value === 'number' ? value : 0;
  };
  /**
   * Draw one string and ADVANCE THE PEN, which is the whole reason this is not
   * three lines: the text matrix after a show is the text matrix before it
   * translated by the sum of the glyph advances, and every space this file
   * emits is decided by comparing that pen to where the next run begins.
   */
  const show = (bytes: Uint8Array): void => {
    const glyphs = glyphsOf(state.font, bytes);
    let text = '';
    let advance = 0;
    for (const glyph of glyphs) {
      text += glyph.text;
      advance +=
        ((glyph.width / 1000) * state.fontSize +
          state.charSpacing +
          (glyph.isSpaceCode ? state.wordSpacing : 0)) *
        state.horizontal;
    }
    const start = multiply(tm, state.ctm);
    tm = multiply([1, 0, 0, 1, advance, 0], tm);
    const end = multiply(tm, state.ctm);
    // The font size AS DRAWN: a page scaled by `cm` or a text matrix moves both
    // the baselines and the thresholds together, so the comparison holds.
    const scale = Math.hypot(start[2], start[3]);
    machine.show(text, start[4], end[4], start[5], state.fontSize * (scale === 0 ? 1 : scale));
  };
  const nextLine = (tx: number, ty: number): void => {
    tlm = multiply([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };

  for (;;) {
    if (cursor.pos >= cursor.end) break;
    const value = parseValue(cursor);
    if (value === undefined) {
      if (cursor.pos >= cursor.end) break;
      continue;
    }
    if (typeof value !== 'object' || value === null || !('kind' in value) || value.kind !== 'op') {
      operands.push(value);
      if (operands.length > 256) operands.splice(0, operands.length - 256);
      continue;
    }

    switch (value.op) {
      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case 'ET':
        machine.newline();
        break;
      case 'Tf': {
        state.fontSize = number(1);
        const name = operands[operands.length - 2];
        state.font = null;
        if (isName(name) && isDict(fontDicts)) {
          const entry = doc.resolve(fontDicts.get(name.name));
          if (isDict(entry)) {
            const cached = fonts.get(entry);
            const font = cached ?? buildFont(doc, entry);
            if (cached === undefined) fonts.set(entry, font);
            state.font = font;
          }
        }
        break;
      }
      case 'TL':
        state.leading = number(1);
        break;
      case 'Tc':
        state.charSpacing = number(1);
        break;
      case 'Tw':
        state.wordSpacing = number(1);
        break;
      case 'Tz':
        state.horizontal = number(1) / 100;
        break;
      case 'Td':
        nextLine(number(2), number(1));
        break;
      case 'TD':
        state.leading = -number(1);
        nextLine(number(2), number(1));
        break;
      case 'Tm':
        tlm = [number(6), number(5), number(4), number(3), number(2), number(1)];
        tm = tlm;
        break;
      case 'T*':
        nextLine(0, -state.leading);
        break;
      case 'Tj': {
        const text = operands[operands.length - 1];
        if (isBytes(text)) show(text.bytes);
        break;
      }
      case "'": {
        nextLine(0, -state.leading);
        const text = operands[operands.length - 1];
        if (isBytes(text)) show(text.bytes);
        break;
      }
      case '"': {
        // `aw ac string "` — the two spacings are operands, and they persist.
        state.wordSpacing = number(3);
        state.charSpacing = number(2);
        nextLine(0, -state.leading);
        const text = operands[operands.length - 1];
        if (isBytes(text)) show(text.bytes);
        break;
      }
      case 'TJ': {
        const array = operands[operands.length - 1];
        if (!Array.isArray(array)) break;
        for (const item of array) {
          if (isBytes(item)) {
            show(item.bytes);
            continue;
          }
          // A positive number closes the gap, a negative one opens it — the
          // sign is inverted by the spec. Moving the pen is enough: the space,
          // if the gap earns one, falls out of the next show's comparison.
          if (typeof item === 'number') {
            const shift = (-item / 1000) * state.fontSize * state.horizontal;
            tm = multiply([1, 0, 0, 1, shift, 0], tm);
          }
        }
        break;
      }
      case 'cm':
        state.ctm = multiply(
          [number(6), number(5), number(4), number(3), number(2), number(1)],
          state.ctm,
        );
        break;
      case 'q':
        stack.push({ ...state });
        break;
      case 'Q': {
        const restored = stack.pop();
        if (restored !== undefined) {
          state.font = restored.font;
          state.fontSize = restored.fontSize;
          state.leading = restored.leading;
          state.horizontal = restored.horizontal;
          state.ctm = restored.ctm;
        }
        break;
      }
      case 'BI':
        skipInlineImage(cursor);
        break;
      case 'Do': {
        const name = operands[operands.length - 1];
        if (depth >= MAX_FORM_DEPTH || !isName(name) || !isDict(xobjects)) break;
        const target = doc.resolve(xobjects.get(name.name));
        if (!isStream(target)) break;
        const subtype = doc.resolve(target.dict.get('Subtype'));
        if (!isName(subtype) || subtype.name !== 'Form') break;
        const body = doc.streamBytes(target);
        if (body === null) break;
        const own = doc.resolve(target.dict.get('Resources'));
        const matrix = doc.resolve(target.dict.get('Matrix'));
        const inner: GraphicsState = { ...state };
        if (Array.isArray(matrix) && matrix.length === 6) {
          const m = matrix.map((entry) => (typeof entry === 'number' ? entry : 0)) as Matrix;
          inner.ctm = multiply(m, state.ctm);
        }
        runContent(doc, body, isDict(own) ? own : resources, machine, fonts, inner, depth + 1);
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }
}

/**
 * `BI … ID <binary> EI`.
 *
 * The bytes between `ID` and `EI` are not tokens, and letting the lexer at them
 * produces hundreds of phantom operators and, worse, phantom strings that land
 * in the output as noise.
 */
function skipInlineImage(cursor: Cursor): void {
  const b = cursor.b;
  while (cursor.pos < cursor.end) {
    if (b[cursor.pos] === 0x49 && b[cursor.pos + 1] === 0x44) {
      cursor.pos += 2;
      break;
    }
    cursor.pos += 1;
  }
  while (cursor.pos < cursor.end) {
    if (
      b[cursor.pos] === 0x45 &&
      b[cursor.pos + 1] === 0x49 &&
      isWhite(b[cursor.pos - 1] ?? 0) &&
      (cursor.pos + 2 >= cursor.end || isWhite(b[cursor.pos + 2] ?? SPACE))
    ) {
      cursor.pos += 2;
      return;
    }
    cursor.pos += 1;
  }
}

/* ------------------------------------------------------------------ *
 * The entry point
 * ------------------------------------------------------------------ */

function textOfPage(doc: PdfDocument, page: PdfPage, fonts: Map<PdfDict, Font>): string {
  const contents = doc.resolve(page.dict.get('Contents'));
  const parts: Uint8Array[] = [];
  const take = (value: PdfValue | undefined): void => {
    const resolved = doc.resolve(value);
    if (!isStream(resolved)) return;
    const body = doc.streamBytes(resolved);
    if (body !== null) parts.push(body);
  };
  if (Array.isArray(contents)) for (const entry of contents) take(entry);
  else take(contents);
  if (parts.length === 0) return '';

  let total = 0;
  for (const part of parts) total += part.length + 1;
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
    joined[at] = LF;
    at += 1;
  }

  const machine = new TextMachine();
  runContent(
    doc,
    joined,
    page.resources,
    machine,
    fonts,
    {
      font: null,
      fontSize: 12,
      leading: 0,
      charSpacing: 0,
      wordSpacing: 0,
      horizontal: 1,
      ctm: IDENTITY,
    },
    0,
  );
  return machine.finish();
}

function documentTitle(doc: PdfDocument): string | undefined {
  for (let at = doc.trailers.length - 1; at >= 0; at -= 1) {
    const info = doc.resolve(doc.trailers[at]?.get('Info'));
    if (!isDict(info)) continue;
    const title = doc.resolve(info.get('Title'));
    if (!isBytes(title)) continue;
    const text = decodeTextString(title.bytes).trim();
    if (text !== '') return text;
  }
  return undefined;
}

/** A PDF text string: UTF-16BE behind a BOM, PDFDoc (≈Latin-1) otherwise. */
function decodeTextString(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return utf16be(bytes.subarray(2));
  let out = '';
  for (const byte of bytes) out += WIN_ANSI_HIGH[byte] ?? String.fromCharCode(byte);
  return out;
}

/**
 * The text layer of a PDF, or the reason there is not one.
 *
 * Pure: bytes in, text out, no network and no clock, which is what lets the
 * regression test build a PDF by hand and assert the characters that come back.
 */
export function extractPdfText(bytes: Uint8Array): PdfExtraction {
  if (bytes.length < 8) return { ok: false, refusal: 'not-a-pdf' };
  const src = latin1(bytes, 0, bytes.length);
  // `%PDF-` within the first kilobyte, not at byte 0: a preamble is legal and
  // some CDNs prepend one.
  if (!src.slice(0, 1024).includes('%PDF-')) return { ok: false, refusal: 'not-a-pdf' };

  const doc = new PdfDocument(bytes);
  scanObjects(doc, src);
  expandObjectStreams(doc);
  collectTrailers(doc, src);

  // BEFORE anything is decoded. Every string and every stream in an encrypted
  // file is ciphertext, so a parser that ploughs on returns confident mojibake.
  for (const trailer of doc.trailers) {
    if (trailer.has('Encrypt')) return { ok: false, refusal: 'encrypted' };
  }

  const pages = collectPages(doc);
  if (pages.length === 0) return { ok: false, refusal: 'unreadable' };

  const fonts = new Map<PdfDict, Font>();
  const texts: string[] = [];
  for (const page of pages) {
    const text = textOfPage(doc, page, fonts);
    if (text !== '') texts.push(text);
  }

  const text = texts.join('\n\n');
  if (text.trim().length < MIN_TEXT_LAYER_CHARS) return { ok: false, refusal: 'no-text-layer' };

  const title = documentTitle(doc);
  return title === undefined
    ? { ok: true, text, pages: pages.length }
    : { ok: true, text, pages: pages.length, title };
}

