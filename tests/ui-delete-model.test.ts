/**
 * `web/src/ui/delete-model.ts` — the pure rules behind the app's first
 * DESTRUCTIVE act (Nocturne B10a, user decision 2026-09-20): which rows a
 * Delete is about, what the one confirmation says, what the statusline says
 * afterwards, which rows stay selected when part of a batch failed, and which
 * folders have to be re-read.
 *
 * WHY every sentence is pinned byte for byte: the delete is PERMANENT (no
 * trash, no undo), so the confirmation is the only stop there is. A question
 * that says "3 items" about 5, or names a folder that is not their parent, is
 * a lie the user cannot take back — and a question is exactly the kind of
 * string a refactor edits without thinking.
 *
 * NOT claimed here: that the dialog appears, that the request is sent, that a
 * byte is removed (that is the server's `tests/fs-delete.test.ts` and the
 * panel's own DOM tests).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DELETE_ITEMS, type FsDeleteResult } from '../shared/protocol.ts';
import { FS_DELETE_TOO_MANY } from '../server/fsdelete.ts';
import {
  DELETE_RUNNING,
  NOTHING_DELETED,
  TOO_MANY_TO_COPY,
  TOO_MANY_TO_DELETE,
  copiedFlash,
  deleteQuestion,
  deleteSubLine,
  deletedFlash,
  failedKeys,
  itemsFor,
  parentsOf,
  pathsOf,
  type DeleteItem,
} from '../web/src/ui/delete-model.ts';

const ROOT = '/home/you/projects/app';

/** A file row under `${ROOT}/<parent>`. */
const file = (parent: string, name: string): DeleteItem => ({
  path: `${ROOT}/${parent}/${name}`,
  name,
  dir: false,
  parentName: parent,
  parentPath: `${ROOT}/${parent}`,
});

/** A folder row under `${ROOT}/<parent>`. */
const dir = (parent: string, name: string): DeleteItem => ({
  path: `${ROOT}/${parent}/${name}`,
  name,
  dir: true,
  parentName: parent,
  parentPath: `${ROOT}/${parent}`,
});

const keyOf = (i: DeleteItem): string => `${i.dir ? 'fdir' : 'ffile'}:${i.path}`;
const rows = (...items: DeleteItem[]): { key: string; item: DeleteItem }[] =>
  items.map((item) => ({ key: keyOf(item), item }));

const README: DeleteItem = {
  path: `${ROOT}/README.md`,
  name: 'README.md',
  dir: false,
  parentName: 'app',
  parentPath: ROOT,
};
const WEB: DeleteItem = {
  path: `${ROOT}/web`,
  name: 'web',
  dir: true,
  parentName: 'app',
  parentPath: ROOT,
};
const MAIN = file('src', 'main.ts');
const UTIL = file('src', 'util.ts');
const ICONS = dir('src', 'icons');
const INDEX = file('server', 'index.ts');

const NOTHING_UNDELETABLE = (): boolean => false;

// ---------------------------------------------------------------------------
// itemsFor — Explorer's rule
// ---------------------------------------------------------------------------

test('itemsFor: a click INSIDE the selection is about the WHOLE selection', () => {
  const visible = rows(MAIN, UTIL, ICONS, INDEX);
  const got = itemsFor({
    clicked: keyOf(UTIL),
    selection: [keyOf(MAIN), keyOf(UTIL), keyOf(INDEX)],
    visible,
    undeletable: NOTHING_UNDELETABLE,
  });
  assert.deepEqual(pathsOf(got), [MAIN.path, UTIL.path, INDEX.path]);
});

test('itemsFor: a click OUTSIDE the selection is about that row ALONE', () => {
  const visible = rows(MAIN, UTIL, ICONS, INDEX);
  const got = itemsFor({
    clicked: keyOf(ICONS),
    selection: [keyOf(MAIN), keyOf(UTIL), keyOf(INDEX)],
    visible,
    undeletable: NOTHING_UNDELETABLE,
  });
  assert.deepEqual(pathsOf(got), [ICONS.path], 'the selection is not what was pointed at');
});

test('itemsFor: no clicked row (a keyboard Delete) is the whole selection', () => {
  const visible = rows(MAIN, UTIL, ICONS);
  const got = itemsFor({
    clicked: null,
    selection: [keyOf(ICONS), keyOf(MAIN)],
    visible,
    undeletable: NOTHING_UNDELETABLE,
  });
  assert.deepEqual(pathsOf(got), [MAIN.path, ICONS.path], 'tree order, not selection order');
});

test('itemsFor: no clicked row and NOTHING selected is nothing at all', () => {
  const got = itemsFor({
    clicked: null,
    selection: [],
    visible: rows(MAIN, UTIL),
    undeletable: NOTHING_UNDELETABLE,
  });
  assert.deepEqual(got, []);
});

test('itemsFor: the order is ALWAYS `visible` (an ancestor before its children)', () => {
  const visible = rows(ICONS, MAIN, UTIL, INDEX);
  const got = itemsFor({
    clicked: null,
    selection: [keyOf(INDEX), keyOf(MAIN), keyOf(ICONS)],
    visible,
    undeletable: NOTHING_UNDELETABLE,
  });
  assert.deepEqual(pathsOf(got), [ICONS.path, MAIN.path, INDEX.path]);
});

test('itemsFor: an UNDELETABLE row is dropped — here, and nowhere else', () => {
  const visible = rows(WEB, MAIN, UTIL);
  const got = itemsFor({
    clicked: null,
    selection: [keyOf(WEB), keyOf(MAIN), keyOf(UTIL)],
    visible,
    undeletable: (p) => p === WEB.path,
  });
  assert.deepEqual(pathsOf(got), [MAIN.path, UTIL.path]);
  // …and the question then counts what is left, not what was selected.
  assert.equal(deleteQuestion(got), 'Delete 2 items from src? This cannot be undone.');
});

test('itemsFor: clicking an undeletable row alone means NOTHING to delete', () => {
  const got = itemsFor({
    clicked: keyOf(WEB),
    selection: [],
    visible: rows(WEB, MAIN),
    undeletable: (p) => p === WEB.path,
  });
  assert.deepEqual(got, []);
});

test('itemsFor: a selection that is ALL anchors comes back empty', () => {
  const got = itemsFor({
    clicked: keyOf(WEB),
    selection: [keyOf(WEB)],
    visible: rows(WEB, MAIN),
    undeletable: () => true,
  });
  assert.deepEqual(got, []);
});

test('itemsFor: a key with no VISIBLE row yields no item (nothing is invented)', () => {
  const got = itemsFor({
    clicked: null,
    selection: [keyOf(MAIN), 'ffile:/home/you/collapsed/gone.ts'],
    visible: rows(MAIN, UTIL),
    undeletable: NOTHING_UNDELETABLE,
  });
  assert.deepEqual(pathsOf(got), [MAIN.path]);
});

test('itemsFor: a FOLDER key and a FILE key of the same path are different rows', () => {
  const asFile: DeleteItem = { ...ICONS, dir: false };
  const visible = rows(ICONS, asFile);
  const got = itemsFor({
    clicked: null,
    selection: [`ffile:${ICONS.path}`],
    visible,
    undeletable: NOTHING_UNDELETABLE,
  });
  assert.deepEqual(
    got.map((i) => i.dir),
    [false],
    'the prefix is the identity, not the path',
  );
});

// ---------------------------------------------------------------------------
// pathsOf / parentsOf
// ---------------------------------------------------------------------------

test('pathsOf: the exact paths of the request, in the items’ order', () => {
  assert.deepEqual(pathsOf([ICONS, MAIN, INDEX]), [ICONS.path, MAIN.path, INDEX.path]);
  assert.deepEqual(pathsOf([MAIN, ICONS]), [MAIN.path, ICONS.path], 'order is not sorted away');
  assert.deepEqual(pathsOf([]), []);
});

test('parentsOf: every parent once, in items order', () => {
  assert.deepEqual(parentsOf([MAIN, UTIL, INDEX]), [`${ROOT}/src`, `${ROOT}/server`]);
  assert.deepEqual(parentsOf([INDEX, MAIN, UTIL, ICONS]), [`${ROOT}/server`, `${ROOT}/src`]);
  assert.deepEqual(parentsOf([README, WEB]), [ROOT], 'one folder, read once');
  assert.deepEqual(parentsOf([]), []);
});

// ---------------------------------------------------------------------------
// The one confirmation — byte for byte
// ---------------------------------------------------------------------------

test('deleteQuestion: ONE FILE names it, and says what cannot be undone', () => {
  assert.equal(deleteQuestion([README]), 'Delete README.md? This cannot be undone.');
});

test('deleteQuestion: ONE FOLDER says what goes with it', () => {
  assert.equal(
    deleteQuestion([WEB]),
    'Delete web and everything inside it? This cannot be undone.',
  );
});

test('deleteQuestion: N items from ONE folder name that folder', () => {
  assert.equal(
    deleteQuestion([MAIN, UTIL, ICONS]),
    'Delete 3 items from src? This cannot be undone.',
  );
});

test('deleteQuestion: N items from SEVERAL folders name none of them', () => {
  assert.equal(deleteQuestion([MAIN, UTIL, INDEX]), 'Delete 3 items? This cannot be undone.');
});

test('deleteQuestion: the count is the ITEMS’ count, whatever they are', () => {
  assert.equal(deleteQuestion([MAIN, UTIL]), 'Delete 2 items from src? This cannot be undone.');
  assert.equal(
    deleteQuestion([MAIN, UTIL, ICONS, file('src', 'a.ts')]),
    'Delete 4 items from src? This cannot be undone.',
  );
});

test('deleteQuestion: a shared parent with NO name is not named (honesty rule)', () => {
  const at = (name: string): DeleteItem => ({
    path: `/${name}`,
    name,
    dir: false,
    parentName: '',
    parentPath: '/',
  });
  assert.equal(deleteQuestion([at('a.ts'), at('b.ts')]), 'Delete 2 items? This cannot be undone.');
});

test('deleteQuestion carries no path, in any of its four shapes', () => {
  const shapes = [
    deleteQuestion([README]),
    deleteQuestion([WEB]),
    deleteQuestion([MAIN, UTIL, ICONS]),
    deleteQuestion([MAIN, UTIL, INDEX]),
  ];
  for (const s of shapes) assert.equal(s.includes('/'), false, s);
  assert.equal(new Set(shapes).size, 4, 'non-vacuity: four distinct sentences');
});

test('deleteSubLine: only when there are SEVERAL items and at least one folder', () => {
  assert.equal(
    deleteSubLine([MAIN, ICONS]),
    'Folders are deleted with everything inside them.',
  );
  assert.equal(deleteSubLine([ICONS, dir('src', 'img')]), 'Folders are deleted with everything inside them.');
  // Files only: there is nothing extra to say.
  assert.equal(deleteSubLine([MAIN, UTIL, INDEX]), null);
  // One folder: the question already said "and everything inside it".
  assert.equal(deleteSubLine([ICONS]), null);
  assert.equal(deleteSubLine([README]), null);
  assert.equal(deleteSubLine([]), null);
});

// ---------------------------------------------------------------------------
// The flash
// ---------------------------------------------------------------------------

test('deletedFlash: one item, gone, is named', () => {
  assert.equal(deletedFlash(1, 1, 'README.md'), 'Deleted README.md.');
  assert.equal(deletedFlash(1, 1, 'web'), 'Deleted web.');
});

test('deletedFlash: one item with no name still counts', () => {
  assert.equal(deletedFlash(1, 1, null), 'Deleted 1 item.');
});

test('deletedFlash: a whole batch counts, and names nothing', () => {
  assert.equal(deletedFlash(3, 3, null), 'Deleted 3 items.');
  assert.equal(deletedFlash(3, 3, 'main.ts'), 'Deleted 3 items.', 'a batch names no single row');
  assert.equal(deletedFlash(2, 2, null), 'Deleted 2 items.');
});

test('deletedFlash: a PARTIAL batch says both numbers', () => {
  assert.equal(deletedFlash(2, 3, null), 'Deleted 2 of 3 items.');
  assert.equal(deletedFlash(1, 3, 'main.ts'), 'Deleted 1 of 3 items.');
  assert.equal(deletedFlash(99, 100, null), 'Deleted 99 of 100 items.');
});

test('deletedFlash: nothing went, at any size, is the one sentence', () => {
  assert.equal(deletedFlash(0, 3, null), NOTHING_DELETED);
  assert.equal(deletedFlash(0, 1, 'README.md'), NOTHING_DELETED);
  assert.equal(NOTHING_DELETED, 'Nothing was deleted.');
});

test('deletedFlash carries no path', () => {
  const all = [
    deletedFlash(1, 1, 'README.md'),
    deletedFlash(1, 1, null),
    deletedFlash(3, 3, null),
    deletedFlash(2, 3, null),
    deletedFlash(0, 3, null),
  ];
  for (const s of all) assert.equal(s.includes('/'), false, s);
  assert.equal(new Set(all).size, 5, 'non-vacuity: five distinct sentences');
});

// ---------------------------------------------------------------------------
// copiedFlash — the other act that reads a whole selection (part D4)
// ---------------------------------------------------------------------------

test('copiedFlash: ONE row is named, never counted', () => {
  assert.equal(copiedFlash(1, 1, 'README.md'), 'Copied README.md to the clipboard.');
  assert.equal(copiedFlash(1, 1, 'web'), 'Copied web to the clipboard.');
  // The name is the row's, whatever the mapping count says: one row that went
  // is one row, and `0 of 1` is not a sentence this function ever says (the
  // panel flashes its own B10 failure line when NOTHING reached the clipboard).
  assert.equal(copiedFlash(0, 1, 'README.md'), 'Copied README.md to the clipboard.');
});

test('copiedFlash: a whole batch counts, and names nothing', () => {
  assert.equal(copiedFlash(3, 3, 'README.md'), 'Copied 3 items to the clipboard.');
  assert.equal(copiedFlash(2, 2, 'main.ts'), 'Copied 2 items to the clipboard.');
  assert.equal(copiedFlash(100, 100, 'x'), 'Copied 100 items to the clipboard.');
});

test('copiedFlash: a PARTIAL batch says both numbers (a path with no Windows form)', () => {
  assert.equal(copiedFlash(2, 3, 'README.md'), 'Copied 2 of 3 items to the clipboard.');
  assert.equal(copiedFlash(1, 2, 'x'), 'Copied 1 of 2 items to the clipboard.');
  assert.equal(copiedFlash(99, 100, 'x'), 'Copied 99 of 100 items to the clipboard.');
});

test('copiedFlash carries no path, and reads as the same vocabulary as deletedFlash', () => {
  const all = [
    copiedFlash(1, 1, 'README.md'),
    copiedFlash(3, 3, 'README.md'),
    copiedFlash(2, 3, 'README.md'),
  ];
  for (const line of all) {
    assert.equal(line.includes('/'), false, line);
    assert.match(line, /^Copied .*\.$/, `a plain sentence: ${line}`);
  }
  assert.equal(new Set(all).size, 3, 'non-vacuity: three distinct sentences');
});

// ---------------------------------------------------------------------------
// failedKeys — what stays selected
// ---------------------------------------------------------------------------

const ok: FsDeleteResult = { ok: true };
const bad = (status: number): FsDeleteResult => ({ ok: false, status, error: 'It is no longer there.' });

test('failedKeys: results are index-keyed to the items, and only failures stay', () => {
  const items = [MAIN, ICONS, INDEX];
  assert.deepEqual(failedKeys(items, [ok, bad(403), ok]), [keyOf(ICONS)]);
  assert.deepEqual(failedKeys(items, [bad(404), ok, bad(500)]), [keyOf(MAIN), keyOf(INDEX)]);
});

test('failedKeys: a whole batch that went leaves nothing selected', () => {
  assert.deepEqual(failedKeys([MAIN, ICONS], [ok, ok]), []);
  assert.deepEqual(failedKeys([], []), []);
});

test('failedKeys: a whole batch that failed keeps every row', () => {
  assert.deepEqual(failedKeys([MAIN, ICONS], [bad(403), bad(403)]), [keyOf(MAIN), keyOf(ICONS)]);
});

test('failedKeys: the key carries the row’s KIND — a folder is `fdir:`, a file is `ffile:`', () => {
  assert.deepEqual(failedKeys([ICONS], [bad(403)]), [`fdir:${ICONS.path}`]);
  assert.deepEqual(failedKeys([MAIN], [bad(403)]), [`ffile:${MAIN.path}`]);
});

test('failedKeys: a SHORT results list counts the missing tail as failed', () => {
  const items = [MAIN, ICONS, INDEX];
  assert.deepEqual(failedKeys(items, [ok]), [keyOf(ICONS), keyOf(INDEX)]);
  assert.deepEqual(failedKeys(items, []), [keyOf(MAIN), keyOf(ICONS), keyOf(INDEX)]);
  assert.deepEqual(failedKeys(items, [ok, ok]), [keyOf(INDEX)]);
});

test('failedKeys: a LONGER results list changes nothing — the items are the list', () => {
  assert.deepEqual(failedKeys([MAIN], [ok, bad(403), bad(403)]), []);
});

test('failedKeys: the order is the items’ order', () => {
  const items = [ICONS, MAIN, INDEX, UTIL];
  assert.deepEqual(failedKeys(items, [bad(403), ok, bad(403), bad(403)]), [
    keyOf(ICONS),
    keyOf(INDEX),
    keyOf(UTIL),
  ]);
});

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

test('the cap sentences carry the protocol’s number, and each names its own act', () => {
  assert.equal(MAX_DELETE_ITEMS, 100);
  assert.equal(TOO_MANY_TO_DELETE, 'Too many items. Delete up to 100 at a time.');
  assert.equal(TOO_MANY_TO_COPY, 'Too many items. Copy up to 100 at a time.');
  assert.ok(TOO_MANY_TO_DELETE.includes(String(MAX_DELETE_ITEMS)));
  assert.ok(TOO_MANY_TO_COPY.includes(String(MAX_DELETE_ITEMS)));
});

test('the cap sentence the client says is the one the SERVER says (one refusal, two sides)', () => {
  // The client refuses BEFORE the request and the server refuses a batch that
  // got through anyway (413, `server/fsdelete.ts` FS_DELETE_TOO_MANY). A user
  // who hits the cap twice must not read two different sentences about it.
  assert.equal(TOO_MANY_TO_DELETE, FS_DELETE_TOO_MANY);
  assert.equal(FS_DELETE_TOO_MANY, 'Too many items. Delete up to 100 at a time.');
});

test('DELETE_RUNNING is the one-batch-at-a-time refusal', () => {
  assert.equal(DELETE_RUNNING, 'A delete is still running.');
});

test('no refusal carries a path or a decorative separator', () => {
  for (const s of [TOO_MANY_TO_DELETE, TOO_MANY_TO_COPY, DELETE_RUNNING, NOTHING_DELETED]) {
    assert.equal(s.includes('/'), false, s);
    assert.equal(s.includes(' — ') || s.includes(' · ') || s.includes(' | '), false, s);
  }
});
