#!/usr/bin/env node
// make-icon.mjs - deterministically generate the app icon set. No deps.
//
//   node make-icon.mjs           regenerate every output, then re-read + verify
//   node make-icon.mjs --check   verify only: every committed output must
//                                still match a fresh render (exit 1 otherwise)
//
// Outputs (all committed artifacts, regenerated only by this script):
//   launcher/app.ico          Windows shortcut icon (ICO, 16/32/48/256 px)
//   web/public/favicon.ico    web favicon — byte-identical to app.ico
//   web/public/icon-192.png   web icon, 192 px, PNG RGBA (manifest + <link>)
//   web/public/icon-512.png   web icon, 512 px, PNG RGBA (manifest + <link>)
//   web/public/manifest.json  minimal web manifest naming the icon set
//
// The web assets exist to give the Edge `--app` chromeless window a real
// window/taskbar icon; a Chromium app window takes its icon from the page's
// <link rel="icon"> / manifest, so with none it falls back to the Edge logo.
// The manifest intentionally omits `display` and `start_url` so the site is
// NOT installable — this is only about the window icon, never a pinned PWA
// (a pinned PWA would bake in the auto-picked port, which is forbidden).
// PNGs are encoded with node:zlib only (hand-built PNG chunks + CRC-32); no
// npm dependency is introduced.
//
// Design (phosphor instrument panel, see web/DESIGN.md + tokens.css):
//   - near-black warm-graphite square  #101312 (--bg-term), sharp corners
//   - 1px structural border            #3a443d (--edge-strong)
//   - phosphor-green '>_' prompt glyph #7edc93 (--focus)
//
// ICO format: classic ICO with 4 BMP-format entries (16/32/48/256), 32bpp
// BGRA bottom-up XOR data + all-zero 1bpp AND mask (alpha carries
// transparency; the square is fully opaque anyway). The 256 entry is
// deliberately BMP, not PNG-compressed, for maximum consumer compatibility.
// The 16px art is a hand-placed pixel map (AA mush is unacceptable at that
// size); 32/48/256 are the same geometry rendered with 4x4 supersampling.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const APP_ICO = join(SCRIPT_DIR, 'app.ico');
const WEB_PUBLIC = join(REPO_ROOT, 'web', 'public');
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

// --- PNG encoding (node:zlib only) -----------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Encode top-down RGBA to a PNG (8-bit, color type 6, filter None on every
// row). deflate at fixed level 9 for stable output on a given zlib.
function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc(size * (1 + stride));
  for (let y = 0; y < size; y++) {
    const ro = y * (1 + stride);
    raw[ro] = 0; // filter type 0 = None
    for (let x = 0; x < stride; x++) raw[ro + 1 + x] = rgba[y * stride + x];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor + alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Parse a PNG this script would emit back into { width, height, rgba }.
// Verifies the signature, every chunk CRC, the IHDR pixel format, and that
// each scanline uses filter None. Throws on any deviation.
function decodePng(buf) {
  const fail = (m) => { throw new Error(`PNG decode failed: ${m}`); };
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) fail('bad signature');
  let off = 8;
  let width = 0, height = 0, sawIhdr = false, sawIend = false;
  const idat = [];
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const body = buf.subarray(off + 4, off + 8 + len);
    const stored = buf.readUInt32BE(off + 8 + len);
    if (crc32(body) !== stored) fail(`chunk ${type} CRC mismatch`);
    if (type === 'IHDR') {
      sawIhdr = true;
      width = body.readUInt32BE(4);
      height = body.readUInt32BE(8);
      if (body[12] !== 8) fail(`bit depth ${body[12]} != 8`);
      if (body[13] !== 6) fail(`color type ${body[13]} != 6 (RGBA)`);
      if (body[16] !== 0) fail('interlaced');
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(off + 8, off + 8 + len));
    } else if (type === 'IEND') {
      sawIend = true;
    }
    off += 12 + len;
  }
  if (!sawIhdr) fail('no IHDR');
  if (!sawIend) fail('no IEND');
  if (off !== buf.length) fail(`trailing bytes after IEND (${buf.length - off})`);
  const rawInflated = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  if (rawInflated.length !== height * (1 + stride)) fail('inflated size mismatch');
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const ro = y * (1 + stride);
    if (rawInflated[ro] !== 0) fail(`row ${y} filter ${rawInflated[ro]} != None`);
    rawInflated.copy(rgba, y * stride, ro + 1, ro + 1 + stride);
  }
  return { width, height, rgba };
}

// --- Web manifest ----------------------------------------------------------
// No `display`/`start_url` => site is not installable => no PWA prompt.

const MANIFEST = `{
  "name": "AI Session Manager",
  "background_color": "#12161d",
  "theme_color": "#1b222c",
  "icons": [
    { "src": "/icon-192.png", "type": "image/png", "sizes": "192x192" },
    { "src": "/icon-512.png", "type": "image/png", "sizes": "512x512" }
  ]
}
`;

// --- Structural checker for ICO (parses the bytes back, throws on any lie) --

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

// PNG structural check: decode on disk and assert it is our logo at `size`.
// Compares DECODED pixels (not raw bytes) so a differing zlib build — which
// can shift the compressed stream — does not produce a false failure while
// still guaranteeing the committed image is correct.
function checkPng(buf, size) {
  const fail = (m) => { throw new Error(`PNG check failed: ${m}`); };
  const { width, height, rgba } = decodePng(buf);
  if (width !== size || height !== size) fail(`dims ${width}x${height}, expected ${size}x${size}`);
  const fresh = render(size);
  for (let i = 0; i < rgba.length; i++) {
    if (rgba[i] !== fresh[i]) fail(`pixel byte ${i}: ${rgba[i]} != ${fresh[i]}`);
  }
}

// --- Output manifest -------------------------------------------------------

function buildOutputs() {
  const ico = buildIco();
  return [
    { path: APP_ICO, bytes: ico, kind: 'ico' },
    { path: join(WEB_PUBLIC, 'favicon.ico'), bytes: ico, kind: 'ico' },
    { path: join(WEB_PUBLIC, 'icon-192.png'), bytes: encodePng(192, render(192)), kind: 'png', size: 192 },
    { path: join(WEB_PUBLIC, 'icon-512.png'), bytes: encodePng(512, render(512)), kind: 'png', size: 512 },
    { path: join(WEB_PUBLIC, 'manifest.json'), bytes: Buffer.from(MANIFEST, 'utf8'), kind: 'json' },
  ];
}

// Structural validation + a same-image assertion against a fresh render.
function validate(out, bytes) {
  if (out.kind === 'ico') {
    checkIco(bytes);
    if (!bytes.equals(out.bytes)) throw new Error('ICO bytes differ from a fresh render');
  } else if (out.kind === 'png') {
    checkPng(bytes, out.size);
  } else if (out.kind === 'json') {
    JSON.parse(bytes.toString('utf8')); // must parse
    if (!bytes.equals(out.bytes)) throw new Error('JSON bytes differ from a fresh render');
  }
}

// --- Main ------------------------------------------------------------------

const checkOnly = process.argv.includes('--check');
const outputs = buildOutputs();
const rel = (p) => relative(REPO_ROOT, p);

if (checkOnly) {
  for (const out of outputs) {
    let onDisk;
    try {
      onDisk = readFileSync(out.path);
    } catch {
      console.error(`--check: ${rel(out.path)} does not exist`);
      process.exit(1);
    }
    try {
      validate(out, onDisk);
    } catch (err) {
      console.error(`--check: ${rel(out.path)}: ${err.message}`);
      process.exit(1);
    }
    console.log(`OK  ${rel(out.path)}  (${out.kind}, ${onDisk.length} bytes)`);
  }
  console.log(`All ${outputs.length} icon outputs match a fresh render.`);
} else {
  mkdirSync(WEB_PUBLIC, { recursive: true });
  for (const out of outputs) {
    writeFileSync(out.path, out.bytes);
    const readBack = readFileSync(out.path);
    validate(out, readBack);
    if (!readBack.equals(out.bytes)) {
      console.error(`write/read-back mismatch: ${rel(out.path)}`);
      process.exit(1);
    }
    console.log(`wrote ${rel(out.path)}  (${out.kind}, ${readBack.length} bytes)`);
  }
  console.log(`Wrote ${outputs.length} icon outputs; all self-verified.`);
}
