/**
 * The media viewer's pure rules (Nocturne D7, `.claude/plans/nocturne/PLAN-D7.md`):
 * `web/src/ui/media-model.ts` (which body a file gets, the media URL, the
 * change stamp, Fit / 100 %, the size readings), `fmtBytes` in
 * `web/src/ui/format-model.ts`, and the `:text` id of an SVG's text view in
 * `web/src/ui/editor-model.ts` / `ui/slots-model.ts`.
 *
 * How: the functions imported and called — no DOM, no state.
 *
 * Why: the `:text` id is the key unsaved text lives under; an id that does
 * not round-trip back to its path would name the wrong file in the unsaved
 * question and lose the text on a rename. A media URL that carried anything
 * but a ticket would leak; a stamp that missed a field would never reload.
 *
 * NOT claimed: how the viewer looks or decodes (`tests/ui/ui-media-pane.test.ts`
 * drives the body on the DOM double; the browser itself is the user's
 * dev-window check in PLAN-D7 § Phases 3).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fitLabel,
  fitTitle,
  mediaPlan,
  mediaStamp,
  mediaUrl,
  nextFit,
  sizeReadings,
} from '../../web/src/ui/media-model.ts';
import { fmtBytes } from '../../web/src/ui/format-model.ts';
import { fileIdParts, filePathOf, fileTab, fileTabId, tabIdOf } from '../../web/src/ui/editor-model.ts';
import { tabTitle } from '../../web/src/ui/slots-model.ts';

const SVG = '/home/you/art/logo.svg';
const PNG = '/home/you/build/renders/smoke/front.png';
const TXT = '/home/you/notes/todo.md';

// ---------------------------------------------------------------------------
// Which body
// ---------------------------------------------------------------------------

test('every image, video and PDF extension gets a viewer plan; everything else none', () => {
  const rows: [string, string | null][] = [
    ['a.png', 'image'],
    ['a.JPG', 'image'],
    ['a.jpeg', 'image'],
    ['a.gif', 'image'],
    ['a.webp', 'image'],
    ['a.avif', 'image'],
    ['a.bmp', 'image'],
    ['a.ico', 'image'],
    ['a.svg', 'image'],
    ['a.mp4', 'video'],
    ['a.webm', 'video'],
    ['a.mov', 'video'],
    ['a.m4v', 'video'],
    ['a.mkv', 'video'],
    ['a.ogv', 'video'],
    ['a.pdf', 'pdf'],
    ['a.mp3', null],
    ['a.ts', null],
    ['Makefile', null],
  ];
  for (const [name, kind] of rows) {
    assert.equal(mediaPlan(`/home/you/${name}`)?.kind ?? null, kind, name);
  }
});

test('only an SVG offers Edit as text, and only a picture swaps live', () => {
  assert.equal(mediaPlan(SVG)?.editAsText, true);
  assert.equal(mediaPlan('/home/you/LOGO.SVG')?.editAsText, true, 'case-insensitive');
  assert.equal(mediaPlan(PNG)?.editAsText, false);
  assert.equal(mediaPlan(PNG)?.swapsLive, true, 'a picture refreshes by itself (decision 23)');
  assert.equal(mediaPlan('/home/you/a.mp4')?.swapsLive, false, 'a video says Reload instead');
  assert.equal(mediaPlan('/home/you/a.pdf')?.swapsLive, false, 'a PDF says Reload instead');
});

// ---------------------------------------------------------------------------
// The URL and the stamp
// ---------------------------------------------------------------------------

test('the media URL carries the encoded path and the ticket — nothing else', () => {
  const url = mediaUrl('/home/you/a b&c#d.png', 'ab12');
  assert.equal(url, '/api/fs/media?path=%2Fhome%2Fyou%2Fa%20b%26c%23d.png&t=ab12');
  assert.equal(/token|auth/i.test(url), false, 'the app token never goes into a src');
});

test('the change stamp moves when ANY of size, mtimeMs or ino moves', () => {
  const base = { size: 10, mtimeMs: 1000, ino: 7 };
  const s = mediaStamp(base);
  assert.equal(mediaStamp({ ...base }), s, 'the same bytes are the same stamp');
  for (const k of ['size', 'mtimeMs', 'ino'] as const) {
    assert.notEqual(mediaStamp({ ...base, [k]: base[k] + 1 }), s, `${k} alone is a change`);
  }
});

// ---------------------------------------------------------------------------
// Fit / 100 % and the size line
// ---------------------------------------------------------------------------

test('the one switch flips between Fit and 100 %, naming the mode on screen', () => {
  assert.equal(nextFit('fit'), 'actual');
  assert.equal(nextFit(nextFit('fit')), 'fit');
  assert.equal(fitLabel('fit'), 'Fit');
  assert.equal(fitLabel('actual'), '100 %');
  assert.equal(fitTitle('fit'), 'Show at 100 %', 'the tooltip says what a press does');
  assert.equal(fitTitle('actual'), 'Fit to the pane');
});

test('the size readings are pixels then bytes, and only the bytes while no pixel size is known', () => {
  assert.deepEqual(sizeReadings(1920, 1080, 284 * 1024), ['1920 × 1080', '284 KB']);
  assert.deepEqual(sizeReadings(0, 0, 4.2 * 1024 * 1024), ['4.2 MB'], 'a PDF, or a picture not decoded yet');
  assert.deepEqual(sizeReadings(300, 0, 812), ['812 B'], 'half a size is no size');
});

test('fmtBytes: bytes, then KB/MB/GB 1024 apart, one decimal only below 10', () => {
  const rows: [number, string][] = [
    [0, '0 B'],
    [812, '812 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [9.96 * 1024, '10 KB'],
    [284 * 1024, '284 KB'],
    [1023.9 * 1024, '1 MB'],
    [4.2 * 1024 * 1024, '4.2 MB'],
    [48 * 1024 * 1024, '48 MB'],
    [3 * 1024 ** 3, '3 GB'],
    [-5, '0 B'],
    [Number.NaN, '0 B'],
  ];
  for (const [n, want] of rows) assert.equal(fmtBytes(n), want, String(n));
});

// ---------------------------------------------------------------------------
// The text view's id (frozen: `fileTabId(path) + ':text'`)
// ---------------------------------------------------------------------------

test('the text view of a media file is `fileTabId(path) + ":text"`, and round-trips', () => {
  const id = fileTabId(SVG, true);
  assert.equal(id, `${fileTabId(SVG)}:text`, 'the frozen id');
  assert.notEqual(id, fileTabId(SVG), 'the picture and its text never collide');
  assert.deepEqual(fileIdParts(id), { path: SVG, asText: true });
  assert.equal(filePathOf(id), SVG, 'the unsaved question names the file, not the suffix');
  assert.deepEqual(fileIdParts(fileTabId(SVG)), { path: SVG, asText: false });
});

test('a non-media file has ONE view: asText is ignored, and a `:text` name is just a name', () => {
  assert.equal(fileTabId(TXT, true), fileTabId(TXT), 'no second id for the same text editor');
  assert.deepEqual(fileTab(TXT, true), { kind: 'file', path: TXT }, 'the builder drops the flag');
  const odd = '/home/you/notes/plan:text';
  assert.deepEqual(fileIdParts(fileTabId(odd)), { path: odd, asText: false });
});

test('tabIdOf and the chip title follow the text view', () => {
  const text = fileTab(SVG, true);
  assert.deepEqual(text, { kind: 'file', path: SVG, asText: true });
  assert.equal(tabIdOf(text), fileTabId(SVG, true));
  assert.equal(tabIdOf(fileTab(SVG)), fileTabId(SVG));
  assert.equal(tabTitle(text), 'logo.svg (text)', 'the chip says which of the two it is');
  assert.equal(tabTitle(fileTab(SVG)), 'logo.svg');
});
