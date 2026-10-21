/**
 * shared/media-kind.ts — which files the media viewer opens and the
 * Content-Type each is served as (Nocturne D7, `.claude/plans/nocturne/PLAN-D7.md`).
 *
 * How: the two functions imported and called; no server, no I/O. Lives in
 * tests/server/ like the other shared-module test (claude-compat.test.ts):
 * tests/README.md § Layout has no folder for shared/.
 *
 * Why it matters: the server serves GET /api/fs/media with exactly this type
 * and refuses everything outside the table, and the browser opens a media tab
 * for exactly these kinds — a wrong row is a picture shown as nothing, or a
 * text file served as an image.
 *
 * NOT claimed: that a browser renders each type (`/verify-terminal`, the
 * user's Windows check).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaContentType, mediaKind } from '../../shared/media-kind.ts';

const TABLE: [string, 'image' | 'video' | 'pdf', string][] = [
  ['png', 'image', 'image/png'],
  ['jpg', 'image', 'image/jpeg'],
  ['jpeg', 'image', 'image/jpeg'],
  ['gif', 'image', 'image/gif'],
  ['webp', 'image', 'image/webp'],
  ['avif', 'image', 'image/avif'],
  ['bmp', 'image', 'image/bmp'],
  ['ico', 'image', 'image/x-icon'],
  ['svg', 'image', 'image/svg+xml'],
  ['mp4', 'video', 'video/mp4'],
  ['webm', 'video', 'video/webm'],
  ['mov', 'video', 'video/quicktime'],
  ['m4v', 'video', 'video/mp4'],
  ['mkv', 'video', 'video/x-matroska'],
  ['ogv', 'video', 'video/ogg'],
  ['pdf', 'pdf', 'application/pdf'],
];

test('every extension in the table has its kind and its content type', () => {
  for (const [ext, kind, type] of TABLE) {
    const path = `/home/you/work/file.${ext}`;
    assert.equal(mediaKind(path), kind, ext);
    assert.equal(mediaContentType(path), type, ext);
  }
});

test('the extension is matched case-insensitively', () => {
  assert.equal(mediaKind('/home/you/Photo.JPG'), 'image');
  assert.equal(mediaContentType('/home/you/Clip.Mp4'), 'video/mp4');
  assert.equal(mediaKind('/home/you/Doc.PDF'), 'pdf');
});

test('a file outside the table, audio included, is no media kind', () => {
  for (const path of [
    '/home/you/notes.txt',
    '/home/you/song.mp3',
    '/home/you/sound.ogg',
    '/home/you/a.wav',
    '/home/you/page.html',
    '/home/you/x.png.txt',
  ]) {
    assert.equal(mediaKind(path), null, path);
    assert.equal(mediaContentType(path), null, path);
  }
});

test('only the last segment counts: no extension, a dot folder, a dotfile', () => {
  assert.equal(mediaKind('/home/you/Makefile'), null, 'no extension');
  assert.equal(mediaKind('/home/you/pics.png/readme'), null, 'a dot in a FOLDER name');
  assert.equal(mediaKind('/home/you/.png'), null, 'a dotfile named like an extension');
  assert.equal(mediaKind('/home/you/file.'), null, 'a trailing dot');
  assert.equal(mediaKind('C:\\Users\\you\\a.png'), 'image', 'a Windows separator');
  assert.equal(mediaKind('C:\\pics.png\\readme'), null, 'a Windows dot folder');
});
