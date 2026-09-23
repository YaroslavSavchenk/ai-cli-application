/**
 * The DELETE request of Nocturne part B10a
 * (`memory/decisions/b10a-multi-select-and-delete.md`): what is sent, once,
 * in tree order; the rows while it runs; the partial and rejected answers;
 * the parents re-read; where the keyboard lands; the folder cache.
 *
 * Driven through the REAL `web/src/ui/files.ts`, `ui/context-menu.ts`,
 * `ui/delete-dialog.ts` and `ui/statusline.ts` on the DOM double, against the
 * fake `FsGateway` of `tests/helpers/fs-fixture.ts` (shared setup:
 * `tests/helpers/ui-files-delete-fixture.ts`). Split from
 * `tests/ui/ui-files-delete.test.ts`.
 *
 * Why: a second Delete that starts before the first answer matches an
 * index-keyed answer against the wrong list of items; a tree that removes rows
 * optimistically hides a failure; a keyboard that falls to <body> strands the
 * user after a delete.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`): that
 * the chosen rows are legible, that the dialog is readable, that a real Enter
 * activates a `<button>` (the fake DOM has no activation behaviour), and
 * screen-reader output.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, FakeElement } from '../helpers/fake-dom.ts';
import { FakeApiError, PROJ, settle, type DeleteResult } from '../helpers/fs-fixture.ts';
import {
  fx,
  dom,
  DD,
  flashText,
  clearFlash,
  liveSession,
  dirRow,
  fileRow,
  body,
  chosen,
  rowKeys,
  rightClick,
  menuEntry,
  dialogTitle,
  dialogButton,
  deleteFromMenu,
  pressDelete,
  sorted,
  resetWorld,
} from '../helpers/ui-files-delete-fixture.ts';

beforeEach(async () => {
  await resetWorld();
});

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

test('Delete sends exactly the chosen paths, once, in tree order — and says how many went', async () => {
  await liveSession();
  // Three rows under TWO parents: a selection is a tree, not one listing.
  fileRow('web/src/App.tsx').click();
  dispatch(fileRow('web/src/Pane.tsx'), 'click', { ctrlKey: true });
  dispatch(fileRow('README.md'), 'click', { ctrlKey: true });

  deleteFromMenu(fileRow('README.md'));
  dialogButton('Delete').click();
  await settle();

  assert.deepEqual(fx.deleteCalls, [
    [`${PROJ}/web/src/App.tsx`, `${PROJ}/web/src/Pane.tsx`, `${PROJ}/README.md`],
  ], 'ONE request, in the order the tree draws the rows');
  assert.equal(flashText(), 'Deleted 3 items.');
  assert.deepEqual(chosen(), [], 'what went is no longer chosen');
  assert.equal(fileRow('README.md'), null, 'and the rows are gone from the tree');
  assert.equal(fileRow('web/src/App.tsx'), null);
});

test('the rows dim while it runs, a SECOND Delete is refused, and nothing leaves the tree early', async () => {
  await liveSession();
  fileRow('README.md').click();
  fx.holdDelete();
  deleteFromMenu(fileRow('README.md'));
  dialogButton('Delete').click();
  await settle();

  assert.equal(fileRow('README.md').classList.contains('is-busy'), true, 'the row says it is working');
  assert.deepEqual(chosen(), ['ffile:README.md'], 'nothing is removed optimistically');

  pressDelete();
  assert.equal(flashText(), 'A delete is still running.');
  assert.equal(fx.deleteCalls.length, 1, 'one batch at a time');

  fx.releaseDelete();
  await settle();
  assert.equal(flashText(), 'Deleted README.md.');
});

test('the confirmation answered twice is still ONE request — the card is gone, its callback is not', async () => {
  await liveSession();
  fileRow('README.md').click();
  fx.holdDelete();
  deleteFromMenu(fileRow('README.md'));
  const answer = dialogButton('Delete');
  answer.click();
  await settle();
  assert.equal(fx.deleteCalls.length, 1);
  assert.equal(DD.isDeleteDialogOpen(), false, 'non-vacuity: the first press closed the card');

  // The button is off the screen now, and it still carries the callback that
  // sends the batch (a double click, a key repeat, a re-entrant caller). A
  // SECOND batch against the same items may never go out: the answer is
  // index-keyed to ONE list of items, and two in flight cannot be matched.
  answer.click();
  await settle();
  assert.equal(fx.deleteCalls.length, 1, 'one confirmation, one request');

  fx.releaseDelete();
  await settle();
  assert.equal(flashText(), 'Deleted README.md.');
  clearFlash();
});

test('every affected parent is re-read ONCE, and a folder nobody has open is not asked for at all', async () => {
  await liveSession();
  // Two rows under `web/src`, plus the folder `web/src` itself — then that
  // folder is CLOSED from its own menu, which keeps the selection (the row is
  // in it) and hides the two files without dropping them.
  dispatch(fileRow('web/src/App.tsx'), 'click', { ctrlKey: true });
  dispatch(fileRow('web/src/Pane.tsx'), 'click', { ctrlKey: true });
  dispatch(dirRow('web/src'), 'click', { ctrlKey: true });
  rightClick(dirRow('web/src'));
  menuEntry('Close').click();
  await settle();
  assert.equal(fileRow('web/src/App.tsx'), null, 'the two rows are off screen');
  assert.deepEqual(chosen(), ['fdir:web/src'], 'and the chosen row that is left is the folder');

  fx.entryCalls.length = 0;
  deleteFromMenu(dirRow('web/src'));
  // A COLLAPSED row is still part of the act: closing a folder hides rows, it
  // is not a way to change what the user already chose.
  assert.equal(dialogTitle(), 'Delete 3 items? This cannot be undone.');
  dialogButton('Delete').click();
  await settle();

  assert.deepEqual(fx.deleteCalls, [
    [`${PROJ}/web/src`, `${PROJ}/web/src/App.tsx`, `${PROJ}/web/src/Pane.tsx`],
  ]);
  // `web` is open and holds the folder that went: read once. `web/src` is
  // closed, so its own listing is not asked for at all.
  assert.deepEqual(fx.entryCalls, [`${PROJ}/web`]);
});

test('a partial answer: the count says so, the failures stay chosen, and the rows that went are gone', async () => {
  await liveSession();
  fileRow('web/src/App.tsx').click();
  dispatch(fileRow('web/src/Pane.tsx'), 'click', { ctrlKey: true });
  dispatch(fileRow('web/src/store.ts'), 'click', { ctrlKey: true });
  fx.deleteAnswer = (_path, i): DeleteResult =>
    i === 1 ? { ok: false, status: 403, error: 'You do not have permission to delete this.' } : { ok: true };

  deleteFromMenu(fileRow('web/src/App.tsx'));
  dialogButton('Delete').click();
  await settle();

  assert.equal(flashText(), 'Deleted 2 of 3 items.');
  assert.deepEqual(chosen(), ['ffile:web/src/Pane.tsx'], 'what failed is what is still chosen');
  assert.equal(fileRow('web/src/App.tsx'), null);
  assert.ok(fileRow('web/src/Pane.tsx') !== null, 'and it is still in the tree');
});

test('ONE item that failed says the SERVER s own sentence; a shapeless one says the app s', async () => {
  await liveSession();
  fileRow('README.md').click();
  fx.deleteAnswer = (): DeleteResult => ({ ok: false, status: 409, error: 'That item is in use right now.' });
  deleteFromMenu(fileRow('README.md'));
  dialogButton('Delete').click();
  await settle();
  assert.equal(flashText(), 'That item is in use right now.', 'it says WHY, in the server s words');

  // A message that is not one of the server's constant sentences (§1d) is not
  // rendered at all: the app says what it knows in its own voice.
  clearFlash();
  fx.deleteAnswer = (): DeleteResult => ({ ok: false, status: 500, error: 'HTTP 500' });
  deleteFromMenu(fileRow('README.md'));
  dialogButton('Delete').click();
  await settle();
  assert.equal(flashText(), 'Nothing was deleted.');
  assert.deepEqual(chosen(), ['ffile:README.md'], 'and the row is still chosen, and still there');
  assert.ok(fileRow('README.md') !== null);
});

test('a REJECTED request deletes nothing, says so, and leaves the selection exactly as it was', async () => {
  await liveSession();
  fileRow('README.md').click();
  dispatch(fileRow('LICENSE'), 'click', { ctrlKey: true });
  fx.deleteFails = new FakeApiError(413, 'Too many items. Delete up to 100 at a time.');
  deleteFromMenu(fileRow('README.md'));
  dialogButton('Delete').click();
  await settle();

  assert.equal(flashText(), 'Nothing was deleted.');
  assert.deepEqual(sorted(chosen()), ['ffile:LICENSE', 'ffile:README.md']);
  assert.ok(fileRow('README.md') !== null, 'nothing left the tree');
  assert.ok(fileRow('LICENSE') !== null);
});

test('the keyboard never falls to <body>: it lands on the nearest surviving row', async () => {
  await liveSession();
  // A full-keyboard delete: choose the row, press Delete, confirm. The row the
  // keyboard is standing on is about to leave the tree, and a focus dropped on
  // <body> would leave the user with no keyboard at all until they click.
  const keys = rowKeys();
  fileRow('web/src/App.tsx').click();
  // The click repainted the tree, so the keyboard goes on the FRESH row: a
  // detached element is a focus nothing can act on.
  fileRow('web/src/App.tsx').focus();
  pressDelete(fileRow('web/src/App.tsx'));
  dialogButton('Delete').click();
  await settle();

  const now = dom.doc.activeElement as FakeElement;
  assert.notEqual(now, dom.body, 'the keyboard must not fall to <body>');
  const key = (now.getAttribute('data-k') ?? '').replace(`:${PROJ}/`, ':');
  assert.equal(now.classList.contains('files-row'), true, `focus landed on ${now.tagName}.${now.className}`);
  // The row BELOW the one that went, in tree order.
  const after = keys[keys.indexOf('ffile:web/src/App.tsx') + 1];
  assert.equal(key, after, `expected the next row (${after}), got ${key}`);
  assert.equal(now.isConnected, true, 'and it is a row that is really on screen');
});

test('with nothing left to stand on, the keyboard goes to the Files tab, never to <body>', async () => {
  // A folder whose whole listing goes: the panel root's own row set shrinks to
  // the rows around it, and when there is no row at all the tab that is always
  // there takes the keyboard.
  fx.tree.set(PROJ, [{ name: 'only.txt', dir: false }]);
  await liveSession();
  assert.deepEqual(rowKeys(), ['ffile:only.txt'], 'non-vacuity: one row, and it is the one deleted');
  fileRow('only.txt').click();
  fileRow('only.txt').focus();
  pressDelete(fileRow('only.txt'));
  dialogButton('Delete').click();
  await settle();

  const now = dom.doc.activeElement as FakeElement;
  assert.notEqual(now, dom.body);
  assert.equal(now.getAttribute('data-k'), 'ftab:files');
});

test('a deleted FOLDER takes its cache with it: not open, not listed, never re-asked', async () => {
  await liveSession();
  // `web` and `web/src` are both open and both listed.
  assert.ok(fileRow('web/src/App.tsx') !== null, 'non-vacuity: the subtree is expanded');
  dirRow('web').click(); // chooses it (and closes it — the toggle is the click's second effect)
  dirRow('web').click(); // open again, still chosen
  assert.deepEqual(chosen(), ['fdir:web']);
  deleteFromMenu(dirRow('web'));
  dialogButton('Delete').click();
  await settle();
  assert.equal(dirRow('web'), null, 'the folder is gone from the tree');

  // The root is re-read from its own menu: nothing under the gone folder may
  // be asked for, and a folder created again under that name must not be
  // drawn pre-expanded over a dead listing.
  fx.entryCalls.length = 0;
  dispatch(body(), 'contextmenu', { clientX: 10, clientY: 10 });
  menuEntry('Refresh').click();
  await settle();
  const asked = fx.entryCalls.filter((p) => p !== undefined) as string[];
  assert.deepEqual(
    asked.filter((p) => p === `${PROJ}/web` || p.startsWith(`${PROJ}/web/`)),
    [],
    `a path that is gone was asked for again: ${asked.join(', ')}`,
  );
  assert.ok(asked.includes(PROJ), 'non-vacuity: the refresh really ran');

  // And the same name, created again, opens closed and empty.
  fx.tree.set(`${PROJ}/web`, []);
  (fx.tree.get(PROJ) as { name: string; dir: boolean }[]).push({ name: 'web', dir: true });
  dispatch(body(), 'contextmenu', { clientX: 10, clientY: 10 });
  menuEntry('Refresh').click();
  await settle();
  assert.equal(dirRow('web')?.getAttribute('aria-expanded'), 'false', 'a new folder is not pre-expanded');
});

test('a folder whose delete FAILED keeps its cache: still open, still listed, still chosen', async () => {
  await liveSession();
  assert.ok(fileRow('web/src/App.tsx') !== null, 'non-vacuity: the subtree is expanded');
  dirRow('web').click(); // chooses it (and closes it — the click's second effect)
  dirRow('web').click(); // open again, still chosen
  assert.deepEqual(chosen(), ['fdir:web']);

  fx.deleteAnswer = (): DeleteResult => ({
    ok: false,
    status: 403,
    error: 'You do not have permission to delete this.',
  });
  deleteFromMenu(dirRow('web'));
  dialogButton('Delete').click();
  await settle();

  // The prune is for what is GONE. A folder that is still on disk must keep
  // its open state and its listing, or a refusal would silently collapse the
  // subtree the user was working in and re-ask for every listing under it.
  assert.equal(flashText(), 'You do not have permission to delete this.');
  assert.deepEqual(chosen(), ['fdir:web'], 'what failed stays chosen');
  assert.ok(dirRow('web') !== null, 'and it is still in the tree');
  assert.equal(dirRow('web').getAttribute('aria-expanded'), 'true', 'still open');
  assert.ok(fileRow('web/src/App.tsx') !== null, 'and its listing is still under it');
  clearFlash();
});
