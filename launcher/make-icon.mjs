#!/usr/bin/env node
// make-icon.mjs - deterministically generate launcher/app.ico. No deps.
//
//   node make-icon.mjs           regenerate app.ico, then re-read and verify
//   node make-icon.mjs --check   verify only: app.ico on disk must be
//                                byte-identical to a fresh render AND parse
//                                as a well-formed ICO (exit 1 otherwise)
//
// Design (phosphor instrument panel, see web/DESIGN.md + tokens.css):
//   - near-black warm-graphite square  #101312 (--bg-term), sharp corners
//   - 1px structural border            #3a443d (--edge-strong)
//   - phosphor-green '>_' prompt glyph #7edc93 (--focus)
//
// Format: classic ICO with 4 BMP-format entries (16/32/48/256), 32bpp BGRA
// bottom-up XOR data + all-zero 1bpp AND mask (alpha carries transparency;
// the square is fully opaque anyway). The 256 entry is deliberately BMP,
// not PNG-compressed, for maximum consumer compatibility.
// The 16px art is a hand-placed pixel map (AA mush is unacceptable at that
// size); 32/48/256 are the same geometry rendered with 4x4 supersampling.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'app.ico');
const SIZES = [16, 32, 48, 256];

const BG = [0x10, 0x13, 0x12]; // --bg-term
const EDGE = [0x3a, 0x44, 0x3d]; // --edge-strong
const GREEN = [0x7e, 0xdc, 0x93]; // --focus (phosphor green)

// --- 16px: hand pixel map ('#' border, 'G' glyph, '.' background) ----------

const MAP16 = [
  '################',
  '#..............#',
  '#..............#',
  '#..............#',
  '#..GG..........#',
  '#...GG.........#',
  '#....GG........#',
  '#.....GG.......#',
  '#....GG........#',
  '#...GG.........#',
  '#..GG..........#',
  '#........GGGGG.#',
  '#........GGGGG.#',
  '#..............#',
  '#..............#',
  '################',
];

// --- Vector geometry in unit space (matches the 16px art's proportions) ----

const CHEVRON = { p0: [0.21, 0.28], p1: [0.47, 0.5], p2: [0.21, 0.72], hw: 0.055 };
const CURSOR = { x0: 0.56, x1: 0.86, y0: 0.7, y1: 0.8 }; // underscore block

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return Math.hypot(ex, ey);
}

function glyphHit(x, y) {
  // x,y in unit space. Chevron: round-capped stroke along two segments.
  if (distToSegment(x, y, CHEVRON.p0, CHEVRON.p1) <= CHEVRON.hw) return true;
  if (distToSegment(x, y, CHEVRON.p1, CHEVRON.p2) <= CHEVRON.hw) return true;
  return x >= CURSOR.x0 && x <= CURSOR.x1 && y >= CURSOR.y0 && y <= CURSOR.y1;
}

// Render one size to top-down RGBA (Uint8Array, 4 bytes/px).
function render(size) {
  const px = new Uint8Array(size * size * 4);
  const put = (x, y, [r, g, b]) => {
    const o = (y * size + x) * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
  };

  if (size === 16) {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const c = MAP16[y][x];
        put(x, y, c === '#' ? EDGE : c === 'G' ? GREEN : BG);
      }
    }
    return px;
  }

  const SS = 4; // 4x4 supersamples per pixel -> box-filtered coverage
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (x + (sx + 0.5) / SS) / size;
          const uy = (y + (sy + 0.5) / SS) / size;
          if (glyphHit(ux, uy)) cover++;
        }
      }
      const a = cover / (SS * SS);
      put(x, y, [
        Math.round(BG[0] + (GREEN[0] - BG[0]) * a),
        Math.round(BG[1] + (GREEN[1] - BG[1]) * a),
        Math.round(BG[2] + (GREEN[2] - BG[2]) * a),
      ]);
    }
  }
  // 1px structural border, drawn last at final resolution so it stays crisp.
  for (let i = 0; i < size; i++) {
    put(i, 0, EDGE); put(i, size - 1, EDGE);
    put(0, i, EDGE); put(size - 1, i, EDGE);
  }
  return px;
}

// --- ICO encoding ----------------------------------------------------------

const andRowBytes = (s) => Math.ceil(s / 32) * 4; // 1bpp rows, 32-bit padded
const imageBytes = (s) => 40 + s * s * 4 + andRowBytes(s) * s;

function encodeEntryImage(size, rgba) {
  const buf = Buffer.alloc(imageBytes(size));
  // BITMAPINFOHEADER
  buf.writeUInt32LE(40, 0); // biSize
  buf.writeInt32LE(size, 4); // biWidth
  buf.writeInt32LE(size * 2, 8); // biHeight = XOR + AND
  buf.writeUInt16LE(1, 12); // biPlanes
  buf.writeUInt16LE(32, 14); // biBitCount
  buf.writeUInt32LE(0, 16); // biCompression = BI_RGB
  buf.writeUInt32LE(size * size * 4 + andRowBytes(size) * size, 20); // biSizeImage
  // XOR data: bottom-up BGRA
  let o = 40;
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      buf[o++] = rgba[i + 2]; // B
      buf[o++] = rgba[i + 1]; // G
      buf[o++] = rgba[i]; // R
      buf[o++] = rgba[i + 3]; // A
    }
  }
  // AND mask: already zeroed by alloc (fully opaque; alpha rules anyway).
  return buf;
}

function buildIco() {
  const images = SIZES.map((s) => encodeEntryImage(s, render(s)));
  const dir = Buffer.alloc(6 + 16 * SIZES.length);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(SIZES.length, 4);
  let offset = dir.length;
  SIZES.forEach((s, i) => {
    const e = 6 + 16 * i;
    dir.writeUInt8(s === 256 ? 0 : s, e); // bWidth (0 means 256)
    dir.writeUInt8(s === 256 ? 0 : s, e + 1); // bHeight
    dir.writeUInt8(0, e + 2); // bColorCount
    dir.writeUInt8(0, e + 3); // bReserved
    dir.writeUInt16LE(1, e + 4); // wPlanes
    dir.writeUInt16LE(32, e + 6); // wBitCount
    dir.writeUInt32LE(images[i].length, e + 8); // dwBytesInRes
    dir.writeUInt32LE(offset, e + 12); // dwImageOffset
    offset += images[i].length;
  });
  return Buffer.concat([dir, ...images]);
}

// --- Structural checker (parses the bytes back, throws on any lie) ---------

function checkIco(buf) {
  const fail = (m) => { throw new Error(`ICO check failed: ${m}`); };
  if (buf.length < 6) fail('too short for ICONDIR');
  if (buf.readUInt16LE(0) !== 0) fail('ICONDIR.reserved != 0');
  if (buf.readUInt16LE(2) !== 1) fail('ICONDIR.type != 1 (icon)');
  const count = buf.readUInt16LE(4);
  if (count !== SIZES.length) fail(`entry count ${count}, expected ${SIZES.length}`);
  let expectedOffset = 6 + 16 * count;
  for (let i = 0; i < count; i++) {
    const e = 6 + 16 * i;
    const s = SIZES[i];
    const stored = s === 256 ? 0 : s;
    if (buf.readUInt8(e) !== stored || buf.readUInt8(e + 1) !== stored) {
      fail(`entry ${i}: stored dims ${buf.readUInt8(e)}x${buf.readUInt8(e + 1)}, expected ${stored}x${stored}`);
    }
    if (buf.readUInt16LE(e + 4) !== 1) fail(`entry ${i}: planes != 1`);
    if (buf.readUInt16LE(e + 6) !== 32) fail(`entry ${i}: bitcount != 32`);
    const bytes = buf.readUInt32LE(e + 8);
    const off = buf.readUInt32LE(e + 12);
    if (bytes !== imageBytes(s)) fail(`entry ${i}: bytesInRes ${bytes}, expected ${imageBytes(s)}`);
    if (off !== expectedOffset) fail(`entry ${i}: offset ${off}, expected ${expectedOffset}`);
    if (off + bytes > buf.length) fail(`entry ${i}: extends past EOF`);
    // BITMAPINFOHEADER sanity
    if (buf.readUInt32LE(off) !== 40) fail(`entry ${i}: biSize != 40`);
    if (buf.readInt32LE(off + 4) !== s) fail(`entry ${i}: biWidth != ${s}`);
    if (buf.readInt32LE(off + 8) !== s * 2) fail(`entry ${i}: biHeight != ${s * 2} (XOR+AND)`);
    if (buf.readUInt16LE(off + 14) !== 32) fail(`entry ${i}: biBitCount != 32`);
    if (buf.readUInt32LE(off + 16) !== 0) fail(`entry ${i}: biCompression != BI_RGB`);
    // First stored row is the image's BOTTOM row = all border pixels.
    const [br, bg2, bb] = EDGE;
    if (buf[off + 40] !== bb || buf[off + 41] !== bg2 || buf[off + 42] !== br || buf[off + 43] !== 255) {
      fail(`entry ${i}: bottom-left pixel is not the opaque border color`);
    }
    expectedOffset += bytes;
  }
  if (expectedOffset !== buf.length) fail(`file length ${buf.length}, expected ${expectedOffset}`);
}

// --- Main ------------------------------------------------------------------

const checkOnly = process.argv.includes('--check');
const fresh = buildIco();

if (checkOnly) {
  let onDisk;
  try {
    onDisk = readFileSync(OUT);
  } catch {
    console.error(`--check: ${OUT} does not exist`);
    process.exit(1);
  }
  checkIco(onDisk);
  if (!onDisk.equals(fresh)) {
    console.error('--check: app.ico on disk differs from a fresh render');
    process.exit(1);
  }
  console.log(`OK: ${OUT} parses (${SIZES.join('/')} px, 32bpp BMP entries) and is byte-identical to a fresh render (${onDisk.length} bytes).`);
} else {
  writeFileSync(OUT, fresh);
  const readBack = readFileSync(OUT);
  checkIco(readBack);
  if (!readBack.equals(fresh)) {
    console.error('write/read-back mismatch');
    process.exit(1);
  }
  console.log(`Wrote ${OUT}: ${readBack.length} bytes, ${SIZES.length} entries (${SIZES.join('/')} px, 32bpp BMP), checker passed.`);
}
