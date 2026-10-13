/**
 * Set-of-marks badges painted onto the screenshot's BYTES, on this host, after
 * the capture — never into the page.
 *
 * The vision arm's `capture()` used to append a `div#outcrawl-marks` (outlines
 * and numbered badges) to the live document, photograph it, and erase it. For
 * the length of one screenshot a vendor-named element sat in the DOM of a real
 * site, where any main-world `MutationObserver` sees it arrive and leave.
 * Stealth is non-negotiable, so the overlay is gone: the page is only READ
 * (element rects, in an isolated world), and the model still receives a
 * picture with a numbered badge on every actionable element, because the
 * badges are drawn here.
 *
 * Enough PNG to do that and no more: 8-bit, non-interlaced, truecolour with or
 * without alpha — what Chromium's `Page.captureScreenshot` emits. Anything else
 * throws rather than painting on misread pixels. Output is RGBA.
 */

import { deflateSync, inflateSync } from 'node:zlib';

/** One badge: a mark number and the element's rect, in CSS pixels of the viewport. */
export interface MarkRect {
  readonly n: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A decoded image, always RGBA. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The badge colour the in-page overlay used, so a model sees what it always saw. */
const MARK_RGB = [0xff, 0x00, 0x8c] as const;

/**
 * 3x5 digit glyphs, one string per row. A mark number is the only text a
 * badge carries, so ten glyphs are the whole font.
 */
const DIGITS: Readonly<Record<string, readonly string[]>> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
};

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(png: Buffer): RgbaImage {
  if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) {
    throw new TypeError('not a PNG');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colour = data[9];
      const interlace = data[12];
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) {
        throw new TypeError(`unsupported PNG: bit depth ${String(depth)}, colour type ${String(colour)}, interlace ${String(interlace)}`);
      }
      channels = colour === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (channels === 0 || width === 0 || height === 0) {
    throw new TypeError('PNG has no usable IHDR');
  }
  const stride = width * channels;
  // Capped at exactly the size the header declares, so a malformed or hostile
  // stream cannot inflate past what this decoder will ever read.
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: height * (stride + 1) });
  if (raw.length < height * (stride + 1)) {
    throw new TypeError('PNG image data is truncated');
  }
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[source + i] ?? 0;
      const a = i >= channels ? (pixels[row + i - channels] ?? 0) : 0;
      const b = y > 0 ? (pixels[row - stride + i] ?? 0) : 0;
      const c = y > 0 && i >= channels ? (pixels[row - stride + i - channels] ?? 0) : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + ((a + b) >> 1);
          break;
        case 4:
          value = x + paeth(a, b, c);
          break;
        default:
          throw new TypeError(`PNG row ${String(y)} has unknown filter ${String(filter)}`);
      }
      pixels[row + i] = value & 0xff;
    }
  }
  if (channels === 4) {
    return { width, height, rgba: pixels };
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0, q = 0; p < pixels.length; p += 3, q += 4) {
    rgba[q] = pixels[p] ?? 0;
    rgba[q + 1] = pixels[p + 1] ?? 0;
    rgba[q + 2] = pixels[p + 2] ?? 0;
    rgba[q + 3] = 0xff;
  }
  return { width, height, rgba };
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

export function encodePng(image: RgbaImage): Buffer {
  const stride = image.width * 4;
  const raw = Buffer.alloc(image.height * (stride + 1));
  for (let y = 0; y < image.height; y += 1) {
    raw.set(image.rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    // Level 3: a screenshot is re-encoded once per vision step, and the model
    // is billed on the image's pixels, not its bytes.
    chunk('IDAT', deflateSync(raw, { level: 3 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function fill(image: RgbaImage, x0: number, y0: number, x1: number, y1: number, rgb: readonly number[]): void {
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.min(image.width, Math.ceil(x1));
  const bottom = Math.min(image.height, Math.ceil(y1));
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const at = (y * image.width + x) * 4;
      image.rgba[at] = rgb[0] ?? 0;
      image.rgba[at + 1] = rgb[1] ?? 0;
      image.rgba[at + 2] = rgb[2] ?? 0;
      image.rgba[at + 3] = 0xff;
    }
  }
}

/**
 * The screenshot with an outline round every mark and its number in a badge
 * above it, as the in-page overlay drew them. `scale` is device pixels per CSS
 * pixel: the picture's width over the viewport's.
 */
export function paintMarks(png: Buffer, marks: readonly MarkRect[], scale: number): Buffer {
  const image = decodePng(png);
  const border = Math.max(1, Math.round(2 * scale));
  const cell = Math.max(2, Math.round(2 * scale));
  for (const mark of marks) {
    const x0 = mark.x * scale;
    const y0 = mark.y * scale;
    const x1 = (mark.x + mark.width) * scale;
    const y1 = (mark.y + mark.height) * scale;
    fill(image, x0, y0, x1, y0 + border, MARK_RGB);
    fill(image, x0, y1 - border, x1, y1, MARK_RGB);
    fill(image, x0, y0, x0 + border, y1, MARK_RGB);
    fill(image, x1 - border, y0, x1, y1, MARK_RGB);

    const text = String(mark.n);
    const badgeWidth = (text.length * 4 + 1) * cell;
    const badgeHeight = 7 * cell;
    const left = Math.max(0, x0);
    const top = Math.max(0, y0 - badgeHeight);
    fill(image, left, top, left + badgeWidth, top + badgeHeight, MARK_RGB);
    for (const [index, digit] of [...text].entries()) {
      const glyph = DIGITS[digit] ?? [];
      for (const [row, bits] of glyph.entries()) {
        for (const [col, bit] of [...bits].entries()) {
          if (bit !== '1') continue;
          const gx = left + (1 + index * 4 + col) * cell;
          const gy = top + (1 + row) * cell;
          fill(image, gx, gy, gx + cell, gy + cell, [0xff, 0xff, 0xff]);
        }
      }
    }
  }
  return encodePng(image);
}
