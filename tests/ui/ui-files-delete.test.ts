/**
 * MANY rows chosen, and a permanent DELETE (Nocturne part B10a, user decision
 * 2026-09-20, `memory/decisions/b10a-multi-select-and-delete.md`) — driven
 * through the REAL `web/src/ui/files.ts`, the REAL `ui/context-menu.ts`, the
 * REAL `ui/delete-dialog.ts` and the REAL `ui/statusline.ts` on the DOM double,
 * against the fake `FsGateway` of `tests/helpers/fs-fixture.ts` (shared setup:
 * `tests/helpers/ui-files-delete-fixture.ts`). This file: choosing many rows,
 * the menu entry, the confirmation, and the shell's wiring (read as source:
 * `main.ts`'s import graph reaches xterm).
 *
 * WHY THIS FILE EXISTS. Delete is the app's first act with no way back: no
 * trash, no undo, and one confirmation between a keystroke and gone bytes.
 * Every way it can go wrong is silent and expensive —
 *
 *   - a gesture that acts on MORE rows than the question counted;
 *   - a selection that keeps a row the user cannot see, or drops one they can;
 *   - a confirmation that can be answered by the Enter key it opened under.
 *
 * Elsewhere: the request and what the tree does with its answer in
 * `tests/ui/ui-files-delete-request.test.ts`; the Delete key in
 * `tests/ui/ui-files-delete-key.test.ts`; the hundred-row cap and Copy on a
 * selection in `tests/ui/ui-files-delete-caps.test.ts`.
 *
 * The pure rules are pinned next door (`tests/ui/ui-delete-model.test.ts`,
 * `tests/ui/ui-files-select-model.test.ts`, `tests/ui/ui-context-menu-model.test.ts`);
 * this file pins the PLUMBING — that the panel really calls them, really sends
 * what the question promised, and really says what happened.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`): that
 * the chosen rows are legible, that the dialog is readable, that a real Enter
 * activates a `<button>` (the fake DOM has no activation behaviour), and
 * screen-reader output.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { byClass, byKey, dispatch, FakeElement } from '../helpers/fake-dom.ts';
import { PROJ } from '../helpers/fs-fixture.ts';
import { readSource } from '../helpers/helpers.ts';
import {
  fx,
  dom,
  DD,
  root,
  liveSession,
  dirRow,
  fileRow,
  body,
  chosen,
  rowKeys,
  rightClick,
  menuBox,
  menuItems,
  menuLabels,
  menuEntry,
  dialog,
  dialogTitle,
  dialogSub,
  dialogButton,
  deleteFromMenu,
  sorted,
  resetWorld,
} from '../helpers/ui-files-delete-fixture.ts';

/** main.ts bootstraps the whole app on import, so its wiring is read as source. */
const MAIN = readSource('web', 'src', 'main.ts');

beforeEach(async () => {
  await resetWorld();
});

// ---------------------------------------------------------------------------
// Choosing many rows
// ---------------------------------------------------------------------------

test('ctrl+click ADDS a row and does not open or toggle it; a plain click replaces everything', async () => {
  await liveSession();
  fileRow('README.md').click();
  assert.deepEqual(chosen(), ['ffile:README.md']);

  const web = dirRow('web');
  const openBefore = web.getAttribute('aria-expanded');
  dispatch(web, 'click', { ctrlKey: true });
  assert.deepEqual(sorted(chosen()), ['fdir:web', 'ffile:README.md']);
  assert.equal(
    dirRow('web').getAttribute('aria-expanded'),
    openBefore,
    'ctrl+click chooses; it does not open or close the folder under the pointer',
  );

  // The same row again takes it back OUT, and the rest is untouched.
  dispatch(dirRow('web'), 'click', { ctrlKey: true });
  assert.deepEqual(chosen(), ['ffile:README.md']);

  // A plain click is how a multi-selection is thrown away.
  dispatch(dirRow('server'), 'click', { ctrlKey: true });
  assert.equal(chosen().length, 2);
  fileRow('LICENSE').click();
  assert.deepEqual(chosen(), ['ffile:LICENSE']);
});

test('shift+click takes the whole run between the anchor and the row, and opens nothing', async () => {
  await liveSession();
  // The anchor is set with ctrl+click, so the tree is not collapsed under the
  // gesture and `visible` is the same list at both ends of the range.
  dispatch(dirRow('web'), 'click', { ctrlKey: true });
  const keys = rowKeys();
  const from = keys.indexOf('fdir:web');
  const to = keys.indexOf('fdir:server');
  assert.ok(from !== -1 && to !== -1 && to > from, `non-vacuity: ${keys.join(', ')}`);
  const expanded = dirRow('web').getAttribute('aria-expanded');

  dispatch(dirRow('server'), 'click', { shiftKey: true });
  assert.deepEqual(chosen(), keys.slice(from, to + 1), 'the whole run, in tree order');
  assert.equal(
    dirRow('web').getAttribute('aria-expanded'),
    expanded,
    'a range must not toggle the folder at either end',
  );

  // A second shift+click re-measures from the SAME anchor rather than growing.
  dispatch(fileRow('README.md'), 'click', { shiftKey: true });
  const readme = keys.indexOf('ffile:README.md');
  assert.deepEqual(chosen(), keys.slice(from, readme + 1));
});

test('every chosen row says so twice: the class and aria-current, on files as well as folders', async () => {
  await liveSession();
  fileRow('README.md').click();
  dispatch(dirRow('server'), 'click', { ctrlKey: true });
  dispatch(fileRow('web/src/App.tsx'), 'click', { ctrlKey: true });
  assert.equal(chosen().length, 3);
  const current = byClass(root, 'files-row')
    .filter((n) => n.getAttribute('aria-current') === 'true')
    .map((n) => (n.getAttribute('data-k') ?? '').replace(`:${PROJ}/`, ':'));
  assert.deepEqual(current, chosen(), 'the colour and the attribute are one fact');
  // And a row that is NOT chosen carries no attribute at all — an absent
  // attribute is the honest "not chosen", never `aria-current="false"`.
  assert.equal(fileRow('LICENSE').getAttribute('aria-current'), null);
});

test('ctrl+a takes every VISIBLE row, shift+↑↓ extends, ctrl+space toggles the focused row', async () => {
  await liveSession();
  const keys = rowKeys();
  dispatch(root, 'keydown', { key: 'a', ctrlKey: true });
  assert.deepEqual(chosen(), keys, 'every row on screen, and nothing hidden inside a closed folder');

  dispatch(root, 'keydown', { key: 'Escape' });
  assert.deepEqual(chosen(), []);

  // The arrows move the keyboard; shift extends from the anchor as it goes.
  // The anchor is chosen with ctrl+click: a plain click on the first row is a
  // folder toggle, and the list the range is measured over would change.
  const firstKey = keys[0]?.replace(':', `:${PROJ}/`) ?? '';
  dispatch(byKey(root, firstKey) as FakeElement, 'click', { ctrlKey: true });
  // The repaint REPLACED that row, so the keyboard goes on the fresh one — a
  // detached element holds no focus anything can act on.
  const first = byKey(root, firstKey) as FakeElement;
  first.focus();
  dispatch(first, 'keydown', { key: 'ArrowDown', shiftKey: true });
  assert.deepEqual(chosen(), keys.slice(0, 2));
  const second = dom.doc.activeElement as FakeElement;
  assert.equal(
    (second.getAttribute('data-k') ?? '').replace(`:${PROJ}/`, ':'),
    keys[1],
    'the keyboard follows the range',
  );
  dispatch(second, 'keydown', { key: 'ArrowDown', shiftKey: true });
  assert.deepEqual(chosen(), keys.slice(0, 3));
  // Back up, and the range SHRINKS — it is measured from the anchor, not grown.
  dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: 'ArrowUp', shiftKey: true });
  assert.deepEqual(chosen(), keys.slice(0, 2));

  // A plain arrow moves the keyboard and leaves the selection alone.
  const before = chosen();
  dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: 'ArrowDown' });
  assert.deepEqual(chosen(), before);

  // ctrl+space adds the row the keyboard is on, wherever the selection was.
  dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: ' ', ctrlKey: true });
  assert.equal(chosen().length, before.length + 1);
  // The repaint replaced that row and handed the keyboard to the fresh one, so
  // the second press is read off `activeElement` again.
  dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: ' ', ctrlKey: true });
  assert.equal(chosen().length, before.length, 'and takes it back out');
});

// ---------------------------------------------------------------------------
// The menu entry
// ---------------------------------------------------------------------------

test('Delete is on a folder row and on a file row, last, behind ONE hairline', async () => {
  await liveSession();
  rightClick(dirRow('web'));
  assert.equal(menuLabels()[menuLabels().length - 1], 'Delete');
  let seps = byClass(menuBox() as FakeElement, 'cm-sep');
  assert.equal(seps.length, 1, 'one hairline, and only above Delete');
  assert.equal(seps[0]?.getAttribute('role'), 'separator');
  // It is NOT an entry: the roving focus walks buttons only, so the arrows can
  // never stop on a line with nothing to activate.
  assert.equal(menuItems().length, menuLabels().length);
  const box = menuBox() as FakeElement;
  const kids = box.children.filter((c): c is FakeElement => c instanceof FakeElement);
  assert.equal(kids[kids.length - 2]?.className, 'cm-sep', 'the hairline sits directly above it');
  assert.equal(menuEntry('Delete').className, 'cm-item is-danger', 'danger is a class, not a fill');

  rightClick(fileRow('README.md'));
  // B13's `Rename` sits right above the hairline, so `Delete` stays last.
  assert.deepEqual(menuLabels(), ['Open', 'Open beside', 'Copy', 'Rename', 'Delete']);
  seps = byClass(menuBox() as FakeElement, 'cm-sep');
  assert.equal(seps.length, 1);
});

test('an ANCHOR row is offered NO Delete and no hairline, and neither is the panel background', async () => {
  await liveSession();
  // `/work/api/shared` is a registered project: the app knows the server will
  // refuse it, so the entry is absent rather than present and greyed.
  rightClick(dirRow('shared'));
  assert.equal(menuLabels().includes('Delete'), false, menuLabels().join(', '));
  assert.equal(byClass(menuBox() as FakeElement, 'cm-sep').length, 0, 'no entry, no hairline');

  // The ROOT menu is the folder the panel is standing in — an anchor too.
  dispatch(body(), 'contextmenu', { clientX: 10, clientY: 10 });
  assert.deepEqual(menuLabels(), ['Copy files here…', 'New file', 'New folder', 'Refresh']);
});

test('the menu NAMES the count when it is about more than the row it opened on', async () => {
  await liveSession();
  fileRow('README.md').click();
  dispatch(fileRow('LICENSE'), 'click', { ctrlKey: true });
  dispatch(dirRow('server'), 'click', { ctrlKey: true });
  rightClick(fileRow('README.md'));
  assert.equal(menuBox()?.getAttribute('aria-label'), 'actions for 3 selected items');
  // A row OUTSIDE the selection is about itself, and says its own name.
  rightClick(fileRow('web/DESIGN.md'));
  assert.equal(menuBox()?.getAttribute('aria-label'), 'actions for DESIGN.md');
  assert.deepEqual(chosen(), ['ffile:web/DESIGN.md'], 'and it became the selection');
});

// ---------------------------------------------------------------------------
// The confirmation
// ---------------------------------------------------------------------------

test('the question counts what will really go, Cancel deletes nothing, and the keyboard comes back', async () => {
  await liveSession();
  fileRow('README.md').click();
  const row = fileRow('README.md');
  row.focus();
  deleteFromMenu(row);
  assert.equal(DD.isDeleteDialogOpen(), true);
  assert.equal(dialogTitle(), 'Delete README.md? This cannot be undone.');
  assert.equal(dialogSub(), null, 'one file needs no second line');
  assert.equal(dialog()?.getAttribute('aria-modal'), 'true');
  assert.equal(dialog()?.getAttribute('aria-labelledby'), 'dd-title');
  // CANCEL holds the keyboard: a card that opened under a half-pressed Enter
  // may not delete anything.
  assert.equal((dom.doc.activeElement as FakeElement).textContent, 'Cancel');

  dialogButton('Cancel').click();
  assert.equal(DD.isDeleteDialogOpen(), false);
  assert.deepEqual(fx.deleteCalls, [], 'Cancel sends nothing at all');
  assert.deepEqual(chosen(), ['ffile:README.md'], 'and changes no selection');
  assert.equal(dom.doc.activeElement, fileRow('README.md'), 'the keyboard goes back to the row');
});

test('a MANY-row question counts the rows, names their folder when they share one, and warns about folders', async () => {
  await liveSession();
  fileRow('web/src/App.tsx').click();
  dispatch(fileRow('web/src/Pane.tsx'), 'click', { ctrlKey: true });
  dispatch(fileRow('web/src/store.ts'), 'click', { ctrlKey: true });
  deleteFromMenu(fileRow('web/src/App.tsx'));
  assert.equal(dialogTitle(), 'Delete 3 items from src? This cannot be undone.');
  assert.equal(dialogSub(), null, 'files only: there is nothing to warn about');
  dialogButton('Cancel').click();

  // Across two parents, with a folder among them: no single folder to name.
  fileRow('README.md').click();
  dispatch(dirRow('web/src'), 'click', { ctrlKey: true });
  deleteFromMenu(fileRow('README.md'));
  assert.equal(dialogTitle(), 'Delete 2 items? This cannot be undone.');
  assert.equal(dialogSub(), 'Folders are deleted with everything inside them.');
  dialogButton('Cancel').click();
});

test('the irreversible answer wears the danger idiom, and the keyboard starts on Cancel', async () => {
  await liveSession();
  fileRow('README.md').click();
  deleteFromMenu(fileRow('README.md'));
  // Red INK and a red OUTLINE, never the accent button the rest of the app
  // confirms with: the one control on this card that cannot be taken back may
  // not be dressed as the ordinary "yes" (`.btn-danger`, B10a's third button).
  assert.equal(dialogButton('Delete').className, 'btn-danger');
  assert.equal(dialogButton('Cancel').className, 'btn-quiet');
  assert.equal(
    dom.doc.activeElement,
    dialogButton('Cancel'),
    'a card that opened under a half-pressed Enter deletes nothing',
  );
  dialogButton('Cancel').click();
  assert.deepEqual(fx.deleteCalls, []);
});

test('Escape and the backdrop are Cancel, exactly', async () => {
  await liveSession();
  fileRow('README.md').click();
  deleteFromMenu(fileRow('README.md'));
  DD.deleteDialogEscape();
  assert.equal(DD.isDeleteDialogOpen(), false);
  assert.deepEqual(fx.deleteCalls, []);

  deleteFromMenu(fileRow('README.md'));
  const scrim = byClass(dom.body, 'dd-scrim')[0] as FakeElement;
  dispatch(scrim, 'mousedown');
  assert.equal(DD.isDeleteDialogOpen(), false);
  assert.deepEqual(fx.deleteCalls, []);
});

// ---------------------------------------------------------------------------
// The shell's wiring (read as source: main.ts's import graph reaches xterm)
// ---------------------------------------------------------------------------

test('the Escape ladder ranks the confirmation after the folder picker and before the drop dialog', () => {
  assert.ok(MAIN.length > 10_000, 'non-vacuity: main.ts');
  const pick = MAIN.indexOf('} else if (isFolderPickerOpen())');
  const del = MAIN.indexOf('} else if (isDeleteDialogOpen())');
  const drop = MAIN.indexOf('} else if (isDropDialogOpen())');
  assert.ok(pick > 0 && del > 0 && drop > 0, 'all three arms must exist');
  assert.ok(pick < del && del < drop, 'the confirmation can open while a hidden copy still runs');
  // And the panel is really given a delete to call: the gateway is injected,
  // so `ui/files.ts` never imports `../api.ts` (B2 §9).
  assert.match(MAIN, /\n\s*delete: api\.fsDelete,\n/);
});

test('the panel still imports no HTTP of its own — the delete goes through the injected gateway', () => {
  const src = readSource('web', 'src', 'ui', 'files.ts');
  assert.ok(src.length > 10_000, 'non-vacuity: ui/files.ts');
  assert.equal(/from '\.\.\/api\.ts'/.test(src), false, 'the panel may not know about HTTP');
  assert.match(src, /fs\.delete\(pathsOf\(items\)\)/, 'one request, the model s list of paths');
});
