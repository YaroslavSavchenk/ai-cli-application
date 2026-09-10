#!/usr/bin/env node
// make-icon.mjs - deterministically generate the app icon set. No deps.
//
//   node make-icon.mjs                 regenerate every output, then re-read + verify
//   node make-icon.mjs --check         verify only: every committed output must
//                                      still match a fresh render (exit 1 otherwise)
//   node make-icon.mjs --preview <dir> write icon-preview-<size>.png (16/32/48/256)
//                                      into <dir> for a visual check; writes
//                                      nothing else and verifies nothing
//   --check and --preview are mutually exclusive (exit 1): --preview verifies
//   nothing, so the combination would exit 0 having checked nothing.
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
// Design (Nocturne; source of truth: design_handoff_session_manager/app-icon.svg,
// geometry transcribed below from its 256-unit viewBox):
//   - dark rounded tile, vertical gradient #232532 (top) -> #161826 (bottom)
//     (#161826 = --color-bg), rounded corners
//   - 1px tile edge                        #3f424d (--color-neutral-800)
//   - blurple chevron, round caps + joins  #b5abfc (--color-accent)
//   - light cursor block                   #e9e9ed (--color-neutral-100)
//   - everything OUTSIDE the rounded tile is fully transparent (alpha 0) --
//     unlike the old phosphor icon, which was an opaque square, so alpha is
//     now load-bearing at the corners and along the tile margin.
//
// ICO format: classic ICO with 4 BMP-format entries (16/32/48/256), 32bpp
// BGRA bottom-up XOR data + a 1bpp AND mask whose bit is SET for every pixel
// with alpha 0, so a legacy consumer that ignores the alpha channel still
// punches out the transparent corners; the 32bpp alpha channel stays
// authoritative for everyone else. The 256 entry is deliberately BMP, not
// PNG-compressed, for maximum consumer compatibility.
// The 16px art is a hand-placed pixel map (AA mush is unacceptable at that
// size); 32/48/256 are the same mark rendered with 4x4 supersampling.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const APP_ICO = join(SCRIPT_DIR, 'app.ico');
const WEB_PUBLIC = join(REPO_ROOT, 'web', 'public');
const SIZES = [16, 32, 48, 256];

// Palette (Nocturne). Straight (non-premultiplied) RGB; alpha is carried
// separately, exactly as PNG and 32bpp ICO expect.
const TILE_TOP = [0x23, 0x25, 0x32]; // tile gradient, top
const TILE_BOTTOM = [0x16, 0x18, 0x26]; // tile gradient, bottom (--color-bg)
const EDGE = [0x3f, 0x42, 0x4d]; // 1px tile edge (--color-neutral-800)
const ACCENT = [0xb5, 0xab, 0xfc]; // chevron (--color-accent)
const CURSOR_FG = [0xe9, 0xe9, 0xed]; // cursor block (--color-neutral-100)

// --- Geometry in unit space (0..1), transcribed from app-icon.svg (256 box) --

const U = (v) => v / 256; // svg user unit -> unit space

const TILE = { x0: U(8), y0: U(8), x1: U(248), y1: U(248), r: U(56) };
const CHEVRON = {
  p0: [U(84), U(92)],
  p1: [U(128), U(128)],
  p2: [U(84), U(164)],
  hw: U(10), // stroke-width 20, round caps + joins
};
const CURSOR = { x0: U(136), y0: U(156), x1: U(176), y1: U(174), r: U(6) };

// --- 16px: hand pixel map --------------------------------------------------
// Anti-aliasing turns this mark to mush at 16px, so the smallest entry is
// authored by hand: the tile is full-bleed with a 1px corner cut (' ' =
// transparent), the chevron is 2px thick, the cursor is a 4x2 block. No
// intermediate shades are needed -- every pixel is one of the four colours.
//   ' ' transparent   '#' tile edge   '.' tile fill (gradient by row)
//   'C' chevron       'B' cursor block

const MAP16 = [
  ' ############## ',
  '#..............#',
  '#..............#',
  '#..............#',
  '#..............#',
  '#....CC........#',
  '#.....CC.......#',
  '#......CC......#',
  '#......CC......#',
  '#.....CC.......#',
  '#....CC..BBBB..#',
  '#........BBBB..#',
  '#..............#',
  '#..............#',
  '#..............#',
  ' ############## ',
];

// --- Rasterisation ---------------------------------------------------------

// Signed distance to a rounded rect (negative inside), unit space.
function sdRoundRect(px, py, r) {
  const hx = (r.x1 - r.x0) / 2;
  const hy = (r.y1 - r.y0) / 2;
  const qx = Math.abs(px - (r.x0 + hx)) - (hx - r.r);
  const qy = Math.abs(py - (r.y0 + hy)) - (hy - r.r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r.r;
}

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return Math.hypot(ex, ey);
}

// Round-capped stroke along the two chevron segments; their union at p1 is
// exactly the round join the svg asks for.
function chevronHit(x, y) {
  if (distToSegment(x, y, CHEVRON.p0, CHEVRON.p1) <= CHEVRON.hw) return true;
  return distToSegment(x, y, CHEVRON.p1, CHEVRON.p2) <= CHEVRON.hw;
}

// Vertical gradient across the TILE's own height (y 8 -> 248), clamped.
function gradientAt(uy) {
  let t = (uy - TILE.y0) / (TILE.y1 - TILE.y0);
  t = Math.max(0, Math.min(1, t));
  return [
    TILE_TOP[0] + (TILE_BOTTOM[0] - TILE_TOP[0]) * t,
    TILE_TOP[1] + (TILE_BOTTOM[1] - TILE_TOP[1]) * t,
    TILE_TOP[2] + (TILE_BOTTOM[2] - TILE_TOP[2]) * t,
  ];
}

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

// Render one size to top-down RGBA (Uint8Array, 4 bytes/px). Pixels outside
// the tile keep RGB 0 and alpha 0.
function render(size) {
  const px = new Uint8Array(size * size * 4);
  const put = (x, y, [r, g, b], a) => {
    const o = (y * size + x) * 4;
    px[o] = Math.round(r); px[o + 1] = Math.round(g); px[o + 2] = Math.round(b); px[o + 3] = a;
  };

  if (size === 16) {
    for (let y = 0; y < 16; y++) {
      const fill = gradientAt((y + 0.5) / 16);
      for (let x = 0; x < 16; x++) {
        const c = MAP16[y][x];
        if (c === ' ') continue; // transparent corner cut
        put(x, y, c === '#' ? EDGE : c === 'C' ? ACCENT : c === 'B' ? CURSOR_FG : fill, 255);
      }
    }
    return px;
  }

  const SS = 4; // 4x4 supersamples per pixel -> box-filtered coverage
  const N = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let tile = 0, chev = 0, cur = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (x + (sx + 0.5) / SS) / size;
          const uy = (y + (sy + 0.5) / SS) / size;
          if (sdRoundRect(ux, uy, TILE) <= 0) tile++;
          if (chevronHit(ux, uy)) chev++;
          if (sdRoundRect(ux, uy, CURSOR) <= 0) cur++;
        }
      }
      if (tile === 0) continue; // outside the tile: alpha 0, RGB 0
      const cx = (x + 0.5) / size, cy = (y + 0.5) / size;
      let color;
      if (sdRoundRect(cx, cy, TILE) * size > -1) {
        // 1px edge ring, decided at final resolution so it stays crisp.
        color = EDGE;
      } else {
        color = gradientAt(cy);
        if (chev) color = mix(color, ACCENT, chev / N);
        if (cur) color = mix(color, CURSOR_FG, cur / N);
      }
      put(x, y, color, Math.round((255 * tile) / N));
    }
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
  // AND mask: 1 = transparent, for legacy consumers that ignore the alpha
  // channel. Rows are bottom-up like the XOR data, MSB = leftmost pixel, each
  // row padded to 4 bytes (the padding stays 0 from alloc).
  const andStart = 40 + size * size * 4;
  const rowBytes = andRowBytes(size);
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y; // stored bottom-up
    for (let x = 0; x < size; x++) {
      if (rgba[(y * size + x) * 4 + 3] === 0) {
        buf[andStart + row * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
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
  "background_color": "#161826",
  "theme_color": "#161826",
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
    // Pixel probes. XOR rows are stored bottom-up, so top-down row y lives at
    // stored row (s - 1 - y); the AND mask is indexed the same way.
    const alphaAt = (x, y) => buf[off + 40 + ((s - 1 - y) * s + x) * 4 + 3];
    const andBitAt = (x, y) =>
      (buf[off + 40 + s * s * 4 + (s - 1 - y) * andRowBytes(s) + (x >> 3)] >> (7 - (x & 7))) & 1;
    // The tile has rounded corners on transparency now: the bottom-left pixel
    // must be fully transparent in BOTH channels of truth.
    if (alphaAt(0, s - 1) !== 0) fail(`entry ${i}: bottom-left pixel alpha ${alphaAt(0, s - 1)}, expected 0`);
    if (andBitAt(0, s - 1) !== 1) fail(`entry ${i}: AND mask bit not set on the transparent bottom-left pixel`);
    // ...and the tile body is really drawn: centre column, just inside the
    // tile's bottom edge (the tile stops at y=248/256, so this is NOT the
    // image's last row for the supersampled sizes).
    const probeX = s >> 1;
    const probeY = Math.floor(TILE.y1 * s) - 2;
    if (alphaAt(probeX, probeY) !== 255) {
      fail(`entry ${i}: pixel (${probeX},${probeY}) alpha ${alphaAt(probeX, probeY)}, expected 255 (tile body)`);
    }
    if (andBitAt(probeX, probeY) !== 0) fail(`entry ${i}: AND mask bit set on an opaque tile pixel`);
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
const previewFlag = process.argv.indexOf('--preview');

// --check verifies committed outputs, --preview writes throwaway PNGs and
// verifies nothing; combining them would silently exit 0 having checked
// nothing. Refuse before anything is rendered or written.
if (checkOnly && previewFlag !== -1) {
  console.error('--check and --preview are mutually exclusive');
  process.exit(1);
}

const outputs = buildOutputs();
const rel = (p) => relative(REPO_ROOT, p);

// --preview <dir>: visual sanity only. Writes icon-preview-<size>.png for
// every ICO size into <dir> and exits; it never touches a committed output
// and never verifies anything (--check semantics are unaffected).
if (previewFlag !== -1) {
  const dir = process.argv[previewFlag + 1];
  if (!dir) {
    console.error('--preview needs a directory argument');
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  for (const size of SIZES) {
    const file = join(dir, `icon-preview-${size}.png`);
    const bytes = encodePng(size, render(size));
    writeFileSync(file, bytes);
    console.log(`preview ${file}  (png, ${bytes.length} bytes)`);
  }
  process.exit(0);
}

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
