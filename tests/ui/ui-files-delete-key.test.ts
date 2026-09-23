/**
 * The Delete KEY of Nocturne part B10a
 * (`memory/decisions/b10a-multi-select-and-delete.md`): it acts on the
 * selection or the focused row, says nothing on an anchor (the HOME row
 * included), refuses while a copy is still writing, and is left alone inside
 * a name row, under a dialog, and with Alt held.
 *
 * Driven through the REAL `web/src/ui/files.ts`, `ui/context-menu.ts`,
 * `ui/delete-dialog.ts` and `ui/statusline.ts` on the DOM double, against the
 * fake `FsGateway` of `tests/helpers/fs-fixture.ts` (shared setup:
 * `tests/helpers/ui-files-delete-fixture.ts`). Split from
 * `tests/ui/ui-files-delete.test.ts`.
 *
 * Why: a Delete key that fires while a copy is still writing the same folders,
 * or that a terminal chord reaches, deletes what the user never chose.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`): that
 * the chosen rows are legible, that the dialog is readable, that a real Enter
 * activates a `<button>` (the fake DOM has no activation behaviour), and
 * screen-reader output.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { type Project } from '../../shared/protocol.ts';
import { byClass, byKey, dispatch, FakeElement } from '../helpers/fake-dom.ts';
import { PROJ, settle } from '../helpers/fs-fixture.ts';
import {
  fx,
  dom,
  st,
  DD,
  DROP,
  panel,
  root,
  flashText,
  until,
  clearFlash,
  mkSession,
  liveSession,
  dirRow,
  fileRow,
  chosen,
  rightClick,
  menuBox,
  menuLabels,
  menuEntry,
  dialogTitle,
  dialogButton,
  pressDelete,
  resetWorld,
} from '../helpers/ui-files-delete-fixture.ts';

beforeEach(async () => {
  await resetWorld();
});

// ---------------------------------------------------------------------------
// The Delete key
// ---------------------------------------------------------------------------

test('the Delete key acts on the SELECTION, and on the focused row when nothing is chosen', async () => {
  await liveSession();
  fileRow('README.md').click();
  dispatch(fileRow('LICENSE'), 'click', { ctrlKey: true });
  const e = pressDelete(fileRow('README.md'));
  assert.equal(e.defaultPrevented, true, 'inside the panel the key is the panel s');
  assert.equal(dialogTitle(), 'Delete 2 items from api? This cannot be undone.');
  dialogButton('Cancel').click();

  // Nothing chosen: the row the keyboard is standing on.
  dispatch(root, 'keydown', { key: 'Escape' });
  assert.deepEqual(chosen(), []);
  fileRow('LICENSE').focus();
  pressDelete(fileRow('LICENSE'));
  assert.equal(dialogTitle(), 'Delete LICENSE? This cannot be undone.');
  dialogButton('Delete').click();
  await settle();
  assert.deepEqual(fx.deleteCalls, [[`${PROJ}/LICENSE`]]);
});

test('the Delete key on an ANCHOR asks nothing at all — a key that does not apply says nothing', async () => {
  await liveSession();
  dirRow('shared').click();
  assert.deepEqual(chosen(), ['fdir:shared'], 'non-vacuity: the anchor row IS chosen');
  pressDelete(dirRow('shared'));
  assert.equal(DD.isDeleteDialogOpen(), false, 'no question');
  assert.equal(flashText(), '', 'and no sentence about a key that does not apply');
  assert.deepEqual(fx.deleteCalls, []);
});

test('the HOME folder drawn as a ROW is an anchor too — no Delete entry, and the key says nothing', async () => {
  // The one way home itself becomes a row: a project registered ABOVE it. The
  // row is then neither the panel's own root nor a registered project, and it
  // is still the folder the server refuses by name (`FS_DELETE_ANCHOR`, D3) —
  // so the menu may not offer an act the app knows will be refused.
  fx.tree.set('/home', [{ name: 'you', dir: true }]);
  st.setProjects([
    { id: 'p0', name: 'home', path: '/home', createdAt: new Date().toISOString() } as Project,
  ]);
  st.setSessions([mkSession('s0', { projectId: 'p0', cwd: '/home' })]);
  const v = st.state.views.find((x) =>
    x.slots.some((sl) => (sl as { kind: string; id?: string }).id === 's0'),
  );
  if (v !== undefined) st.state.activeViewId = v.id;
  st.state.leftPanel = 'files';
  panel.render();
  await until(() => byKey(root, 'fdir:/home/you') !== null);

  const homeRow = byKey(root, 'fdir:/home/you') as FakeElement;
  assert.ok(homeRow !== null && homeRow !== undefined, 'non-vacuity: home is drawn as a row');
  rightClick(homeRow);
  assert.equal(menuLabels().includes('Delete'), false, `no Delete: ${menuLabels().join(', ')}`);
  assert.equal(byClass(menuBox() as FakeElement, 'cm-sep').length, 0, 'and no hairline for it');
  dispatch(dom.body, 'keydown', { key: 'Escape' });

  homeRow.click();
  pressDelete(byKey(root, 'fdir:/home/you') as FakeElement);
  assert.equal(DD.isDeleteDialogOpen(), false, 'no question');
  assert.equal(flashText(), '', 'and no sentence about a key that does not apply');
  assert.deepEqual(fx.deleteCalls, []);
});

test('an anchor inside a MANY-row selection is dropped silently, and the question counts the rest', async () => {
  await liveSession();
  dirRow('shared').click();
  dispatch(fileRow('README.md'), 'click', { ctrlKey: true });
  pressDelete(fileRow('README.md'));
  assert.equal(dialogTitle(), 'Delete README.md? This cannot be undone.');
  dialogButton('Delete').click();
  await settle();
  assert.deepEqual(fx.deleteCalls, [[`${PROJ}/README.md`]], 'the anchor never reaches the request');
});

test('a copy that is still writing refuses the delete, in the drop layer s own sentence', async () => {
  await liveSession();
  fileRow('README.md').click();
  // A real run that has not finished, with its card HIDDEN — which is the
  // state the sentence exists for: no scrim on screen, bytes still moving.
  const rows = [{ name: 'a.txt', state: 'copied', dir: false }];
  let finish: (r: unknown) => void = () => {};
  DROP.openDropDialog({
    dest: 'api',
    items: [{ name: 'a.txt', dir: false, bytes: 1 }],
    listing: [],
    returnFocus: null,
    run: {
      plan: () => rows,
      failed: () => 0,
      start: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  DROP.dropDialogEscape();
  assert.equal(DROP.isDropRunning(), true, 'non-vacuity: the copy is still running');
  assert.equal(byClass(dom.body, 'modal-scrim').length, 0, 'and its card is off the screen');

  pressDelete(fileRow('README.md'));
  assert.equal(flashText(), 'A copy is still running.');
  assert.equal(DD.isDeleteDialogOpen(), false);
  assert.deepEqual(fx.deleteCalls, []);

  // Let it finish: `running` is module state, and a copy left in flight would
  // refuse every delete in every test after this one.
  finish(rows);
  await settle();
  assert.equal(DROP.isDropRunning(), false);
  clearFlash();
});

test('the Delete key is left alone inside a name row, and while a dialog is up', async () => {
  await liveSession();
  fileRow('README.md').click();
  // A half-typed name: Delete there is an edit, not a filesystem act.
  rightClick(dirRow('web'));
  menuEntry('New file').click();
  await settle();
  const input = byClass(root, 'files-newname')[0] as FakeElement;
  assert.ok(input !== undefined, 'non-vacuity: the name row is up');
  const typed = dispatch(input, 'keydown', { key: 'Delete' });
  assert.equal(typed.defaultPrevented, false);
  assert.equal(DD.isDeleteDialogOpen(), false);
  dispatch(input, 'keydown', { key: 'Escape' });

  // And with the confirmation itself up, a second Delete stacks nothing.
  fileRow('README.md').click();
  pressDelete(fileRow('README.md'));
  assert.equal(DD.isDeleteDialogOpen(), true);
  const again = pressDelete(fileRow('README.md'));
  assert.equal(again.defaultPrevented, false, 'the panel steps aside while a dialog owns the window');
  assert.equal(byClass(dom.body, 'dd-modal').length, 1, 'one question, never two');
  dialogButton('Cancel').click();
});

test('Alt is never the panel s: alt+Delete and ctrl+alt+arrows pass straight through', async () => {
  await liveSession();
  fileRow('README.md').click();
  const rowEl = fileRow('README.md');
  rowEl.focus();

  // The app owns the PLAIN Delete (with or without shift). Alt+Delete is not
  // this panel's chord, so it is neither swallowed nor answered.
  const alt = dispatch(rowEl, 'keydown', { key: 'Delete', altKey: true });
  assert.equal(alt.defaultPrevented, false);
  assert.equal(DD.isDeleteDialogOpen(), false);
  assert.deepEqual(fx.deleteCalls, []);

  // Ctrl+Alt+↑/↓ belongs to the WINDOW (PROJECT-SCOPE: the app's Ctrl+Alt
  // family moves between panes). With the keyboard on one of this panel's own
  // rows the tree must leave it alone — bubbling out and not moving its own
  // focus — or the chord dies everywhere the Files panel has the keyboard.
  const at = dom.doc.activeElement;
  const chord = dispatch(rowEl, 'keydown', { key: 'ArrowDown', ctrlKey: true, altKey: true });
  assert.equal(chord.defaultPrevented, false, 'the window handler must still see it');
  assert.equal(chord.cancelBubble, false, 'and it must still bubble out of the panel');
  assert.equal(dom.doc.activeElement, at, 'the keyboard did not move inside the tree');

  const plain = dispatch(rowEl, 'keydown', { key: 'ArrowDown', altKey: true });
  assert.equal(plain.defaultPrevented, false);
  assert.equal(dom.doc.activeElement, at);
});
