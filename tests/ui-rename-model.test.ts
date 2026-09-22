/**
 * `web/src/ui/rename-model.ts` — the pure rules of B13's rename
 * (`.claude/plans/nocturne/PLAN-B13.md` § 2 Client, user decisions D1–D4 of
 * 2026-09-22): which part of the old name the input pre-selects, the new path,
 * how paths and selection keys follow a rename, who may be renamed, and the
 * sentences.
 *
 * This file carries the part's full mutation probe, so every branch is pinned
 * from both sides: the prefix-sibling trap (`/a/bc` next to `/a/b`), root-level
 * paths, dot-files and trailing dots, folder keys vs file keys, the anchor.
 *
 * NOT claimed here (needs the panel, phase 2): that F2 or the menu opens a name
 * row, that the input selects the stem, or that a commit reaches the server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RENAME_FAILED_TEXT,
  RENAME_SESSION_NOTE,
  canRename,
  containsProject,
  hasSessionInside,
  isSameName,
  remapKeys,
  remapPath,
  renameMessage,
  renamedPath,
  stemRange,
} from '../web/src/ui/rename-model.ts';
import { EMPTY, rowKey, type Selection } from '../web/src/ui/files-select-model.ts';

/** What `stemRange` selects, as the text a user would see highlighted. */
const picked = (name: string, isDir: boolean): string => {
  const r = stemRange(name, isDir);
  return name.slice(r.start, r.end);
};

const sel = (keys: string[], anchor: string | null): Selection => ({ keys: new Set(keys), anchor });
const keysOf = (s: Selection): string[] => [...s.keys].sort();

// ---------------------------------------------------------------------------
// stemRange
// ---------------------------------------------------------------------------

test('stemRange: a FILE selects the part before the LAST dot', () => {
  assert.deepEqual(stemRange('main.ts', false), { start: 0, end: 4 });
  assert.equal(picked('main.ts', false), 'main');
  assert.deepEqual(stemRange('archive.tar.gz', false), { start: 0, end: 11 });
  assert.equal(picked('archive.tar.gz', false), 'archive.tar');
  assert.equal(picked('a.b', false), 'a');
  assert.equal(picked('a..b', false), 'a.');
});

test('stemRange: a FILE with no dot is selected whole', () => {
  assert.deepEqual(stemRange('README', false), { start: 0, end: 6 });
  assert.deepEqual(stemRange('x', false), { start: 0, end: 1 });
});

test('stemRange: a leading-dot name is selected whole — it has no stem', () => {
  assert.deepEqual(stemRange('.env', false), { start: 0, end: 4 });
  assert.deepEqual(stemRange('.gitignore', false), { start: 0, end: 10 });
  // Only dots before the last dot: still no stem.
  assert.deepEqual(stemRange('..x', false), { start: 0, end: 3 });
  assert.deepEqual(stemRange('...x', false), { start: 0, end: 4 });
  assert.deepEqual(stemRange('...', false), { start: 0, end: 3 });
});

test('stemRange: a dot-file WITH an extension selects its own name, keeps the extension', () => {
  assert.deepEqual(stemRange('.env.local', false), { start: 0, end: 4 });
  assert.equal(picked('.env.local', false), '.env');
  assert.equal(picked('..x.md', false), '..x');
});

test('stemRange: trailing dots — the empty extension after the last dot is kept', () => {
  assert.deepEqual(stemRange('foo.', false), { start: 0, end: 3 });
  assert.deepEqual(stemRange('foo..', false), { start: 0, end: 4 });
  assert.equal(picked('foo..', false), 'foo.');
  // `.` alone and `x.` at the edges.
  assert.deepEqual(stemRange('.', false), { start: 0, end: 1 });
  assert.deepEqual(stemRange('x.', false), { start: 0, end: 1 });
});

test('stemRange: a FOLDER is selected whole, dots or not', () => {
  for (const name of ['src', 'v1.2', 'my.folder.d', '.config', '..x', 'x.']) {
    assert.deepEqual(stemRange(name, true), { start: 0, end: name.length }, name);
  }
  // Non-vacuity: the same names as FILES are not all selected whole.
  assert.deepEqual(stemRange('v1.2', false), { start: 0, end: 2 });
});

test('stemRange: an empty name answers an empty range, not a negative one', () => {
  assert.deepEqual(stemRange('', false), { start: 0, end: 0 });
  assert.deepEqual(stemRange('', true), { start: 0, end: 0 });
});

test('stemRange: counts UTF-16 units, as setSelectionRange does', () => {
  assert.deepEqual(stemRange('café.txt', false), { start: 0, end: 4 });
  assert.deepEqual(stemRange('😀.md', false), { start: 0, end: 2 });
});

test('stemRange hands out a fresh range every call', () => {
  const a = stemRange('a.b', false);
  a.end = 99;
  assert.deepEqual(stemRange('a.b', false), { start: 0, end: 1 });
  const b = stemRange('dir', true);
  b.end = 99;
  assert.deepEqual(stemRange('dir', true), { start: 0, end: 3 });
});

// ---------------------------------------------------------------------------
// renamedPath, isSameName
// ---------------------------------------------------------------------------

test('renamedPath: same parent, new last segment', () => {
  assert.equal(renamedPath('/home/you/web/main.ts', 'app.ts'), '/home/you/web/app.ts');
  assert.equal(renamedPath('/a/b', 'c'), '/a/c');
  assert.equal(renamedPath('/a/b/c/d', 'e'), '/a/b/c/e');
});

test('renamedPath: a root-level path stays at the root, with one slash', () => {
  assert.equal(renamedPath('/b', 'c'), '/c');
  assert.equal(renamedPath('/tmp', 'temp'), '/temp');
});

test('renamedPath: a trailing slash on the old path does not become a segment', () => {
  assert.equal(renamedPath('/a/b/', 'c'), '/a/c');
});

test('renamedPath: the name is placed verbatim — dots, spaces, case', () => {
  assert.equal(renamedPath('/a/readme', 'README'), '/a/README');
  assert.equal(renamedPath('/a/x', '.env'), '/a/.env');
  assert.equal(renamedPath('/a/x', 'my file.txt'), '/a/my file.txt');
});

test('isSameName: the exact old name is a no-op; a case-only change is not', () => {
  assert.equal(isSameName('/a/readme', 'readme'), true);
  assert.equal(isSameName('/a/readme', 'README'), false);
  assert.equal(isSameName('/a/readme', 'readme2'), false);
  assert.equal(isSameName('/a/readme', 'a'), false, 'the parent name is not the name');
  assert.equal(isSameName('/a/b/', 'b'), true, 'a trailing slash is not a segment');
  assert.equal(isSameName('/b', 'b'), true, 'root level');
  assert.equal(isSameName('/a/b', ''), false);
});

// ---------------------------------------------------------------------------
// remapPath
// ---------------------------------------------------------------------------

test('remapPath: the renamed path itself becomes the new one', () => {
  assert.equal(remapPath('/a/b', '/a/b', '/a/c'), '/a/c');
});

test('remapPath: everything UNDER it follows, however deep', () => {
  assert.equal(remapPath('/a/b/x', '/a/b', '/a/c'), '/a/c/x');
  assert.equal(remapPath('/a/b/x/y/z.ts', '/a/b', '/a/c'), '/a/c/x/y/z.ts');
  // A longer new name and a shorter one: the rest is spliced, not re-measured.
  assert.equal(remapPath('/a/b/x', '/a/b', '/a/longer'), '/a/longer/x');
  assert.equal(remapPath('/a/long/x', '/a/long', '/a/s'), '/a/s/x');
});

test('remapPath: a PREFIX SIBLING is a different row and keeps its path', () => {
  assert.equal(remapPath('/a/bc', '/a/b', '/a/z'), '/a/bc');
  assert.equal(remapPath('/a/bc/x', '/a/b', '/a/z'), '/a/bc/x');
  assert.equal(remapPath('/a/b.ts', '/a/b', '/a/z'), '/a/b.ts');
  assert.equal(remapPath('/a/b-old', '/a/b', '/a/z'), '/a/b-old');
});

test('remapPath: parents, siblings and unrelated paths are unchanged', () => {
  assert.equal(remapPath('/a', '/a/b', '/a/c'), '/a');
  assert.equal(remapPath('/a/c', '/a/b', '/a/d'), '/a/c');
  assert.equal(remapPath('/x/a/b', '/a/b', '/a/c'), '/x/a/b', 'the old path in the middle');
  assert.equal(remapPath('/', '/a/b', '/a/c'), '/');
  assert.equal(remapPath('', '/a/b', '/a/c'), '');
});

test('remapPath: root-level renames', () => {
  assert.equal(remapPath('/b', '/b', '/c'), '/c');
  assert.equal(remapPath('/b/x', '/b', '/c'), '/c/x');
  assert.equal(remapPath('/bx', '/b', '/c'), '/bx');
});

test('remapPath: only the LEADING occurrence is rewritten', () => {
  // `/a/b/a/b` under `/a/b`: the tail repeats the old path and must stay.
  assert.equal(remapPath('/a/b/a/b', '/a/b', '/a/c'), '/a/c/a/b');
});

// ---------------------------------------------------------------------------
// remapKeys
// ---------------------------------------------------------------------------

test('remapKeys: a renamed FOLDER takes its key and every key under it along', () => {
  const before = sel(
    [rowKey('/a/b', true), rowKey('/a/b/x', true), rowKey('/a/b/x/f.ts', false), rowKey('/a/other.ts', false)],
    rowKey('/a/b/x/f.ts', false),
  );
  const after = remapKeys(before, '/a/b', '/a/c');
  assert.deepEqual(keysOf(after), [
    'fdir:/a/c',
    'fdir:/a/c/x',
    'ffile:/a/c/x/f.ts',
    'ffile:/a/other.ts',
  ].sort());
  assert.equal(after.anchor, 'ffile:/a/c/x/f.ts');
});

test('remapKeys: a renamed FILE keeps its `ffile:` kind', () => {
  const after = remapKeys(sel([rowKey('/a/f.ts', false)], rowKey('/a/f.ts', false)), '/a/f.ts', '/a/g.ts');
  assert.deepEqual(keysOf(after), ['ffile:/a/g.ts']);
  assert.equal(after.anchor, 'ffile:/a/g.ts');
});

test('remapKeys: a FOLDER key stays `fdir:` — kind comes from the key, not the path', () => {
  const after = remapKeys(sel([rowKey('/a/b.d', true)], rowKey('/a/b.d', true)), '/a/b.d', '/a/c.d');
  assert.deepEqual(keysOf(after), ['fdir:/a/c.d']);
  assert.equal(after.anchor, 'fdir:/a/c.d');
});

test('remapKeys: the anchor follows even when it is the renamed row itself', () => {
  const after = remapKeys(sel([rowKey('/a/b', true)], rowKey('/a/b', true)), '/a/b', '/a/c');
  assert.equal(after.anchor, 'fdir:/a/c');
});

test('remapKeys: an anchor OUTSIDE the renamed folder stays put', () => {
  const after = remapKeys(sel([rowKey('/a/b/x', false), rowKey('/q', true)], rowKey('/q', true)), '/a/b', '/a/c');
  assert.equal(after.anchor, 'fdir:/q');
  assert.deepEqual(keysOf(after), ['fdir:/q', 'ffile:/a/c/x']);
});

test('remapKeys: a prefix-sibling key is untouched', () => {
  const after = remapKeys(
    sel([rowKey('/a/bc', true), rowKey('/a/bc/x', false)], rowKey('/a/bc', true)),
    '/a/b',
    '/a/z',
  );
  assert.deepEqual(keysOf(after), ['fdir:/a/bc', 'ffile:/a/bc/x']);
  assert.equal(after.anchor, 'fdir:/a/bc');
});

test('remapKeys: a no-anchor selection stays no-anchor', () => {
  const after = remapKeys(sel([rowKey('/a/b', true)], null), '/a/b', '/a/c');
  assert.equal(after.anchor, null);
  assert.deepEqual(keysOf(after), ['fdir:/a/c']);
});

test('remapKeys: a key that is not a tree row is kept as it is', () => {
  // A state row has no path (`keyPath` answers ''), so it is never "under"
  // anything — even a key whose text happens to contain the old path.
  const after = remapKeys(sel(['loading:/a/b', 'name-row'], 'loading:/a/b'), '/a/b', '/a/c');
  assert.deepEqual(keysOf(after), ['loading:/a/b', 'name-row']);
  assert.equal(after.anchor, 'loading:/a/b');
});

test('remapKeys: the empty selection maps to an empty one', () => {
  const after = remapKeys(EMPTY, '/a/b', '/a/c');
  assert.equal(after.keys.size, 0);
  assert.equal(after.anchor, null);
});

test('remapKeys: root-level folder rename', () => {
  const after = remapKeys(sel([rowKey('/b/x', false), rowKey('/bx', false)], rowKey('/b/x', false)), '/b', '/c');
  assert.deepEqual(keysOf(after), ['ffile:/bx', 'ffile:/c/x']);
  assert.equal(after.anchor, 'ffile:/c/x');
});

test('remapKeys returns a NEW value and leaves the old one alone', () => {
  const keys = [rowKey('/a/b', true)];
  const before = sel(keys, keys[0] as string);
  const after = remapKeys(before, '/a/b', '/a/c');
  assert.notEqual(after, before);
  assert.notEqual(after.keys, before.keys);
  assert.deepEqual(keysOf(before), ['fdir:/a/b']);
  assert.equal(before.anchor, 'fdir:/a/b');
  // Even when nothing matched: still a fresh Set.
  const same = remapKeys(before, '/zzz', '/yyy');
  assert.notEqual(same.keys, before.keys);
  assert.deepEqual(keysOf(same), ['fdir:/a/b']);
  // And it works on the frozen EMPTY without touching it.
  remapKeys(EMPTY, '/a', '/b');
  assert.equal(EMPTY.keys.size, 0);
});

// ---------------------------------------------------------------------------
// canRename (D2 + single row)
// ---------------------------------------------------------------------------

test('canRename: exactly one renamable row', () => {
  assert.equal(canRename({ renamable: true, count: 1 }), true);
});

test('canRename: never a row that is not renamable, whatever the count', () => {
  for (const count of [0, 1, 2]) assert.equal(canRename({ renamable: false, count }), false, `count ${count}`);
});

test('canRename: never a multi-selection, never nothing', () => {
  for (const count of [0, 2, 3, 100]) assert.equal(canRename({ renamable: true, count }), false, `count ${count}`);
});

// ---------------------------------------------------------------------------
// containsProject (D2's "a folder that CONTAINS one")
// ---------------------------------------------------------------------------

test('containsProject: the project folder itself, or any folder above it', () => {
  assert.equal(containsProject('/a/b', ['/a/b']), true, 'equal');
  assert.equal(containsProject('/a', ['/a/b']), true, 'parent');
  assert.equal(containsProject('/a', ['/a/b/c/d']), true, 'grand-parent');
  assert.equal(containsProject('/', ['/a/b']), true, 'the filesystem root holds everything');
  assert.equal(containsProject('/a', ['/q', '/a/b']), true, 'any of them');
});

test('containsProject: a prefix sibling, a child or an unrelated folder does not', () => {
  assert.equal(containsProject('/a/b', ['/a/bc']), false, 'sibling prefix');
  assert.equal(containsProject('/a/bc', ['/a/b']), false, 'the other way round');
  assert.equal(containsProject('/a/b/c', ['/a/b']), false, 'a folder INSIDE a project');
  assert.equal(containsProject('/x', ['/a/b', '/q']), false);
  assert.equal(containsProject('/a/b', []), false, 'no projects');
});

test('containsProject: trailing slashes on either side are ignored', () => {
  assert.equal(containsProject('/a/b/', ['/a/b']), true);
  assert.equal(containsProject('/a/b', ['/a/b/']), true);
  assert.equal(containsProject('/a/', ['/a/b/']), true);
  assert.equal(containsProject('/a/b/', ['/a/bc/']), false);
});

// ---------------------------------------------------------------------------
// hasSessionInside (D4)
// ---------------------------------------------------------------------------

test('hasSessionInside: a session AT the folder or UNDER it counts', () => {
  assert.equal(hasSessionInside(['/a/b'], '/a/b'), true);
  assert.equal(hasSessionInside(['/a/b/x/y'], '/a/b'), true);
  assert.equal(hasSessionInside(['/q', '/a/b/x'], '/a/b'), true, 'any of them');
});

test('hasSessionInside: a prefix sibling, a parent or an unrelated cwd does not', () => {
  assert.equal(hasSessionInside(['/a/bc'], '/a/b'), false);
  assert.equal(hasSessionInside(['/a'], '/a/b'), false);
  assert.equal(hasSessionInside(['/q', '/a/c'], '/a/b'), false);
  assert.equal(hasSessionInside([], '/a/b'), false);
});

test('hasSessionInside: trailing slashes on either side are ignored', () => {
  assert.equal(hasSessionInside(['/a/b/'], '/a/b'), true);
  assert.equal(hasSessionInside(['/a/b/x'], '/a/b/'), true);
  assert.equal(hasSessionInside(['/a/bc/'], '/a/b/'), false);
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

test('the sentences are exactly the spec words', () => {
  assert.equal(RENAME_FAILED_TEXT, 'The app could not rename that.');
  assert.equal(
    RENAME_SESSION_NOTE,
    'A session is working inside this folder. It keeps running; its folder shows the old name.',
  );
});

test('the sentences carry no path, no key name, no product', () => {
  for (const s of [RENAME_FAILED_TEXT, RENAME_SESSION_NOTE]) {
    assert.equal(s.includes('/'), false, s);
    assert.equal(/\bF2\b|Enter|Escape/i.test(s), false, s);
    assert.equal(/claude/i.test(s), false, s);
  }
});

test('renameMessage: the server\'s own sentence passes through (D1 among them)', () => {
  const d1 = 'Something with that name already exists here.';
  assert.equal(renameMessage({ message: d1 }), d1);
  assert.equal(renameMessage({ status: 409, message: d1 }), d1);
  assert.equal(renameMessage(new Error('That folder cannot be renamed.')), 'That folder cannot be renamed.');
});

test('renameMessage: anything that is not a sentence becomes the app\'s own', () => {
  for (const err of [
    null,
    undefined,
    'Something with that name already exists here.',
    42,
    {},
    { message: 42 },
    { message: 'HTTP 500.' },
    { message: 'not found' },
    { message: 'ENOENT: no such file' },
    { message: 'Two lines.\nHere.' },
    { message: '' },
  ]) {
    assert.equal(renameMessage(err), RENAME_FAILED_TEXT, JSON.stringify(err) ?? String(err));
  }
});
