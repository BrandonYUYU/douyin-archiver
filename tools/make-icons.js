/**
 * tools/make-icons.js — regenerate the extension icons.
 *
 * The extension needs real icons for two reasons: the toolbar button otherwise
 * shows a generic puzzle piece, and chrome.notifications.create() requires an
 * iconUrl, so captcha alerts would silently fail without one.
 *
 * Rather than commit opaque binaries nobody can edit, the icons are generated
 * from this script — a minimal PNG encoder (zlib + CRC32, no dependencies). Run:
 *
 *     node tools/make-icons.js
 *
 * It writes real .png files, so you can open them in any image viewer:
 *   extension/icons/icon16.png, icon32.png, icon48.png, icon128.png
 *   docs/icon-preview.png      (512px, big enough to actually look at)
 *
 * Design: the accent blue from popup.css, with a white download-arrow glyph
 * (archive = pull things down and keep them).
 *
 * Why the file extension is `.js` and not `.mjs`: both mean "this is an ES
 * module". `.mjs` says so by itself, while `.js` relies on "type": "module" in
 * package.json — which this project sets, so `.js` is enough and one fewer thing
 * to explain. See docs/javascript-for-this-project.md §7.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = join(ROOT, 'extension', 'icons');
const DOCS_DIR = join(ROOT, 'docs');

/** Sizes Chrome asks for: toolbar, retina toolbar, extensions page, store/notification. */
const SIZES = [16, 32, 48, 128];

/** Not used by the extension — purely so a human can see the icon clearly. */
const PREVIEW_SIZE = 512;

const BG = [26, 111, 212, 255]; // #1a6fd4, matches --accent
const FG = [255, 255, 255, 255];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** @param {(x: number, y: number) => number[]} shade */
function png(size, shade) {
  // Each row is prefixed with a filter byte (0 = none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = shade(x, y);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
      offset += 4;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // bytes 10-12 stay zero: deflate, no filter, no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** A rounded-square background with a white download arrow. */
function glyph(size) {
  const radius = size * 0.22;
  const stemWidth = Math.max(2, Math.round(size * 0.14));
  const arrowHalf = size * 0.26;

  return (x, y) => {
    // Rounded corners: transparent outside the radius.
    const cx = Math.min(x, size - 1 - x);
    const cy = Math.min(y, size - 1 - y);
    if (cx < radius && cy < radius) {
      const dx = radius - cx;
      const dy = radius - cy;
      if (dx * dx + dy * dy > radius * radius) return [0, 0, 0, 0];
    }

    const px = x + 0.5 - size / 2;
    const py = y + 0.5 - size / 2;

    // Vertical stem of the arrow.
    const inStem = Math.abs(px) <= stemWidth / 2 && py >= -size * 0.30 && py <= size * 0.06;

    // Triangular head: widest at the top of the head, converging downward.
    const headTop = size * 0.02;
    const headBottom = size * 0.30;
    const inHead =
      py >= headTop &&
      py <= headBottom &&
      Math.abs(px) <= arrowHalf * (1 - (py - headTop) / (headBottom - headTop));

    return inStem || inHead ? FG : BG;
  };
}

mkdirSync(ICON_DIR, { recursive: true });
mkdirSync(DOCS_DIR, { recursive: true });

for (const size of SIZES) {
  const file = join(ICON_DIR, `icon${size}.png`);
  writeFileSync(file, png(size, glyph(size)));
  console.log(`wrote ${file}`);
}

const preview = join(DOCS_DIR, 'icon-preview.png');
writeFileSync(preview, png(PREVIEW_SIZE, glyph(PREVIEW_SIZE)));
console.log(`wrote ${preview}  (preview only — open this one to see the design)`);
