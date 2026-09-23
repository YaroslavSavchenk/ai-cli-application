/**
 * The body of a file pane and of a diff pane (Nocturne part A10, made real by
 * part B4), driven through the REAL `web/src/ui/file-pane.ts` on the shared
 * DOM double, against the REAL `web/src/state.ts`, `ui/util.ts`,
 * `ui/editor-model.ts`, `ui/editor-store.ts`, `ui/commit-store.ts` and the
 * commit view's own diff renderer — with the two backends plain fakes
 * (`tests/helpers/editor-fixture.ts`, `tests/helpers/fs-fixture.ts`).
 *
 * WHY, next to `tests/ui/ui-editor-model.test.ts`. That file pins the arithmetic
 * (what an id means, how many line numbers a text needs, what Save is called,
 * where a caret lands); this one pins the PLUMBING the A6 editor column and
 * part B4 taught us to distrust:
 *
 *   - a textarea REBUILT on every keystroke (the caret, the selection and the
 *     scroll position would jump on every letter),
 *   - a dirty FLIP that costs a redraw every keystroke instead of one,
 *   - a Save that writes nowhere, or that writes with no stamp (which is how
 *     two windows silently overwrite each other — user decision D4),
 *   - a file that cannot be read offering a field to type into, or a Save that
 *     would write a sentence into a file,
 *   - unsaved text OVERWRITTEN from disk by the 5 s follow (D3), or a follow
 *     that keeps asking about a file whose pane is gone,
 *   - a read-only diff that renders an editable field,
 *   - (part B3) a diff pane that asks nothing, or that repaints the PANE GRID
 *     when its answer lands — a diff arriving may never put a terminal
 *     through a rebuild.
 *
 * The amber dot itself, the header `×` and the pane chrome around this body
 * live in `ui/panes.ts`, which imports @xterm/xterm and cannot be loaded here;
 * they are pinned by source in `tests/ui/ui-pane-a10.test.ts`. What this file
 * proves about the dot is the FACT it draws: the dirty flip, exactly once.
 *
 * This file: the read, typing, the save (user decision D4), and focus plus
 * what this module may not do. The disk follow (D3) is in
 * `tests/ui/ui-file-pane-follow.test.ts`; the diff half (part B3) and the CSS
 * classes in `tests/ui/ui-file-pane-diff.test.ts`. Shared setup:
 * `tests/helpers/ui-file-pane-fixture.ts`.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, colour, scrolling, the gutter really lining up with the text, and
 * the browser's own `beforeunload` card.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot, readSource } from '../helpers/helpers.ts';
import {
  byClass,
  dispatch,
  textsOf,
  type FakeElement,
  typeInto as type,
} from '../helpers/fake-dom.ts';
import { settle } from '../helpers/fs-fixture.ts';
import { HEAD, diffOf } from '../helpers/commits-fixture.ts';
import {
  CHANGED_TEXT,
  GONE_TEXT,
  NOT_TEXT_TEXT,
  NO_WRITE_TEXT,
  TOO_LARGE_TEXT,
} from '../helpers/editor-fixture.ts';
import {
  dom,
  type Body,
  st,
  FP,
  ES,
  ed,
  PATH,
  OTHER,
  ORIGINAL,
  DIFF_PATH,
  flips,
  live,
  mount,
  field,
  saveBtn,
  act,
  resetPanes,
} from '../helpers/ui-file-pane-fixture.ts';

beforeEach(() => {
  resetPanes();
});

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

test('non-vacuity: the fake disk really holds those two files, and the commit really has a diff', () => {
  assert.equal(ed.fileText(PATH), ORIGINAL);
  assert.notEqual(ed.fileText(OTHER), ed.fileText(PATH));
  assert.ok(diffOf(HEAD, DIFF_PATH).lines.length > 0, 'the fixture commit really has a diff');
});

test('a file body says `Loading…` and then IS the file: one read, the text, the numbers, Save', async () => {
  const body = FP.filePaneBody(PATH, () => {});
  live.push(body);
  dom.body.append(body.root);
  // Before the answer: one quiet line, in the slot the sentence would take.
  assert.deepEqual(textsOf(body.root, 'pane-fempty'), ['Loading…']);
  assert.equal(field(body.root), null, 'no field until there is a file');
  assert.deepEqual(ed.reads, [PATH], 'asked once, with no stamp it does not have');

  await settle();
  const ta = field(body.root);
  assert.ok(ta !== null, 'the file is there now');
  assert.equal(ta.value, ORIGINAL, 'and it holds the file, not a summary of it');
  assert.deepEqual(textsOf(body.root, 'pane-fempty'), [], 'the waiting line is gone');
  assert.equal(byClass(body.root, 'pane-gutter').length, 1, 'one line-number column');
  assert.equal(
    (byClass(body.root, 'pane-gutter')[0] as FakeElement).textContent.split('\n').length,
    ORIGINAL.split('\n').length,
    'one number per line of the text',
  );
  const save = saveBtn(body.root);
  assert.equal(save.textContent, 'Saved', 'a clean file has nothing to write');
  assert.equal(save.disabled, true);
});

test('the body kept the STAMP it read: the next save carries exactly that one', async () => {
  const stamp = ed.stampOf(PATH);
  assert.ok(stamp !== null, 'non-vacuity: the fake disk stamps its files');
  const root = await mount(PATH);
  type(field(root) as FakeElement, 'changed\n');
  saveBtn(root).click();
  await settle();
  assert.equal(ed.writes.length, 1);
  assert.equal(ed.writes[0]?.expect, stamp, 'a save is compared against the bytes it was read from');
});

test('a refusal is ONE sentence, verbatim, in danger ink — no field, no numbers, no Save, no bar', async () => {
  for (const [status, sentence] of [
    [413, TOO_LARGE_TEXT],
    [415, NOT_TEXT_TEXT],
  ] as const) {
    ed.failRead(PATH, status, sentence);
    const root = await mount(PATH);
    assert.deepEqual(textsOf(root, 'pane-fempty'), [sentence], `status ${status}`);
    assert.equal((byClass(root, 'pane-fempty')[0] as FakeElement).classList.contains('is-bad'), true);
    assert.equal(field(root), null, 'nothing to type into');
    assert.equal(byClass(root, 'pane-gutter').length, 0, 'and no numbers beside it');
    assert.equal(byClass(root, 'pane-save').length, 0, 'a Save that writes a sentence would be a lie');
    assert.equal(byClass(root, 'pane-fbar').length, 0, 'and no empty strip of chrome under it');
  }
});

test('a file that is simply GONE keeps the quiet ink: nothing went wrong, there is nothing there', async () => {
  const root = await mount('/home/you/never-existed.ts');
  assert.deepEqual(textsOf(root, 'pane-fempty'), [GONE_TEXT]);
  assert.equal((byClass(root, 'pane-fempty')[0] as FakeElement).classList.contains('is-bad'), false);
});

test('unsaved text beats the disk in a second pane — and that pane still reads ONCE, for the stamp', async () => {
  const first = await mount(PATH);
  type(field(first) as FakeElement, 'typed but never saved\n');
  ed.reads.length = 0;

  const second = await mount(PATH);
  assert.equal((field(second) as FakeElement).value, 'typed but never saved\n');
  assert.deepEqual(ed.reads, [PATH], 'the stamp still has to be fetched, or its Save could not be checked');
  assert.equal(ed.fileText(PATH), ORIGINAL, 'and nothing was written to get there');
  assert.equal(saveBtn(second).textContent, 'Save', 'the second pane opens unsaved, like the first');
});

test('a dirty file whose read fails still shows its unsaved text and offers Overwrite', async () => {
  // The last body of a typed-into file is REBUILT (moveTab, moveTabToSplit, a
  // second pane) after the file went from disk. The work is in `state.edits`,
  // the chip dot is on and the close guard asks about it — so a sentence with
  // no field would leave the user told about text they cannot see or write.
  const gone = '/home/you/deleted-under-the-tab.ts';
  const id = st.editorFileId(gone);
  st.setEdit(id, 'work nobody has on disk\n');
  const root = await mount(gone);

  const ta = field(root);
  assert.ok(ta !== null, 'the unsaved text needs a field to be in');
  assert.equal(ta.value, 'work nobody has on disk\n', 'and it is that text, not a summary');
  assert.deepEqual(textsOf(root, 'pane-fempty'), [], 'the sentence may not take the field');
  assert.deepEqual(textsOf(root, 'pane-fmsg'), [GONE_TEXT], "the read's own sentence, in the bar");
  assert.deepEqual(
    byClass(root, 'pane-fact').map((b) => b.textContent),
    ['Overwrite', 'Load from disk'],
    'the same two answers a 404 on save offers',
  );
  assert.equal(saveBtn(root).textContent, 'Save', 'and there is something to write');

  // Overwrite: a write with NO expect, which is what recreates a gone file.
  act(root, 'Overwrite').click();
  await settle();
  assert.equal(ed.writes.length, 1);
  assert.equal('expect' in (ed.writes[0] as object), false, 'there is no stamp to compare with');
  assert.equal(ed.fileText(gone), 'work nobody has on disk\n', 'the file is back, with the work in it');
  assert.equal(st.editorDirty(id), false);
});

// ---------------------------------------------------------------------------
// Typing
// ---------------------------------------------------------------------------

test('the FIRST keystroke flips the pane to unsaved — and only the first', async () => {
  const root = await mount(PATH);
  const ta = field(root) as FakeElement;
  type(ta, `${ORIGINAL}a`);
  assert.equal(st.editorDirty(st.editorFileId(PATH)), true, 'the file is unsaved now');
  assert.equal(flips, 1, 'the header dot and the tab chip are redrawn once');
  const save = saveBtn(root);
  assert.equal(save.textContent, 'Save');
  assert.equal(save.disabled, false);
  assert.ok(save.classList.contains('is-dirty'), 'and it takes the accent');

  for (let i = 0; i < 19; i += 1) type(ta, `${ORIGINAL}a${i}`);
  assert.equal(flips, 1, 'nineteen more keystrokes redraw nothing: the strip already says it');
});

test('the textarea is the SAME node after twenty keystrokes — the caret never jumps', async () => {
  const root = await mount(PATH);
  const ta = field(root) as FakeElement;
  for (let i = 0; i < 20; i += 1) type(ta, `${ORIGINAL}\nline ${i}`);
  assert.equal(field(root), ta, 'the body was not rebuilt under the user');
  // The gutter DID follow the text: that is the one thing typing may redraw.
  assert.equal(
    (byClass(root, 'pane-gutter')[0] as FakeElement).textContent.split('\n').length,
    `${ORIGINAL}\nline 19`.split('\n').length,
  );
});

// ---------------------------------------------------------------------------
// The save (user decision D4)
// ---------------------------------------------------------------------------

test('Save writes the text to the backend with the stamp it read, says so while it is out, and states it landed', async () => {
  const root = await mount(PATH);
  const ta = field(root) as FakeElement;
  const stamp = ed.stampOf(PATH);
  type(ta, 'const answer = 42;\n');
  ta.selectionStart = 6;
  ta.selectionEnd = 6;
  const save = saveBtn(root);
  ed.holdWrite();
  save.click();
  assert.equal(save.textContent, 'Saving…', 'the control that was pressed reports');
  assert.equal(save.disabled, true, 'and answers nothing twice');
  save.click();
  assert.equal(ed.writes.length, 1, 'a second press while the write is out writes nothing');

  ed.releaseWrites();
  await settle();
  assert.deepEqual(ed.writes, [
    { path: PATH, text: 'const answer = 42;\n', eol: 'lf', bom: false, expect: stamp },
  ]);
  assert.equal(ed.fileText(PATH), 'const answer = 42;\n', 'the text reached the disk');
  assert.equal(st.editorDirty(st.editorFileId(PATH)), false, 'and the file is clean again');
  assert.equal(save.textContent, 'Saved');
  assert.equal(save.disabled, true);
  assert.equal(save.classList.contains('is-dirty'), false);
  assert.equal(ta.selectionStart, 6, 'the caret is where the user left it');
  assert.equal(field(root), ta, 'and the body was not rebuilt to say so');
});

test('the keyboard comes back to the text the save came from — never nowhere', async () => {
  // Disabling the pressed button drops the focus in a browser, so the body
  // reads who held it BEFORE it disables anything. Without that the keyboard
  // is on <body> after every save and the next keystroke reaches no file.
  const root = await mount(PATH);
  const ta = field(root) as FakeElement;
  type(ta, 'typed\n');
  const save = saveBtn(root);
  save.focus();
  assert.equal(dom.doc.activeElement, save, 'non-vacuity: the click leaves it on the button');
  save.click();
  await settle();
  assert.equal(dom.doc.activeElement, ta, 'the keyboard is back in the text it just saved');

  // And a save while the keyboard is somewhere ELSE does not steal it back.
  const elsewhere = dom.doc.createElement('button');
  dom.body.append(elsewhere);
  type(ta, 'typed again\n');
  elsewhere.focus();
  save.click();
  await settle();
  assert.equal(dom.doc.activeElement, elsewhere, 'a landing save may not pull the keyboard away');
});

test('the eol and the bom the read carried are handed BACK, untouched', async () => {
  ed.setFile(OTHER, 'a\nb\n', { eol: 'crlf', bom: true });
  const root = await mount(OTHER);
  type(field(root) as FakeElement, 'a\nb\nc\n');
  saveBtn(root).click();
  await settle();
  assert.equal(ed.writes[0]?.eol, 'crlf', 'a Windows file stays a Windows file');
  assert.equal(ed.writes[0]?.bom, true);
});

test('ctrl+s in the field saves it; every other chord in there is left alone', async () => {
  const root = await mount(PATH);
  const ta = field(root) as FakeElement;
  type(ta, 'saved by keyboard\n');

  // Not ours: no ctrl, ctrl+alt (an app chord), ctrl+shift, altgr.
  for (const init of [
    { key: 's' },
    { key: 's', ctrlKey: true, altKey: true },
    { key: 's', ctrlKey: true, shiftKey: true },
    { key: 's', ctrlKey: true, altGraph: true },
    { key: 'a', ctrlKey: true },
  ]) {
    const e = dispatch(ta, 'keydown', init);
    assert.equal(e.defaultPrevented, false, `${JSON.stringify(init)} must reach the field`);
  }
  assert.equal(ed.writes.length, 0, 'and none of them saved anything');

  const e = dispatch(ta, 'keydown', { key: 's', ctrlKey: true });
  assert.equal(e.defaultPrevented, true, "the browser's own save-page dialog must not open");
  await settle();
  assert.equal(ed.fileText(PATH), 'saved by keyboard\n');
  assert.equal(st.editorDirty(st.editorFileId(PATH)), false);
});

test('409: the conflict bar offers the two answers and the text STAYS unsaved', async () => {
  const root = await mount(PATH);
  type(field(root) as FakeElement, 'my version\n');
  // The file changed under the tab (another window, a git checkout).
  ed.setFile(PATH, 'their version\n');
  saveBtn(root).click();
  await settle();

  assert.deepEqual(textsOf(root, 'pane-fmsg'), [CHANGED_TEXT], "the server's own sentence");
  assert.deepEqual(
    byClass(root, 'pane-fact').map((b) => b.textContent),
    ['Overwrite', 'Load from disk'],
  );
  assert.equal(st.editText(st.editorFileId(PATH)), 'my version\n', 'nothing was dropped');
  assert.equal(ed.fileText(PATH), 'their version\n', 'and nothing was written');
  const save = saveBtn(root);
  assert.equal(save.textContent, 'Save', 'Save is pressable again');
  assert.equal(save.disabled, false);
  assert.ok(field(root) !== null, 'the text is still on screen and still editable');
});

test('Overwrite writes again with NO expect — my text wins — and the bar goes quiet', async () => {
  const root = await mount(PATH);
  type(field(root) as FakeElement, 'my version\n');
  ed.setFile(PATH, 'their version\n');
  saveBtn(root).click();
  await settle();

  act(root, 'Overwrite').click();
  await settle();
  assert.equal(ed.writes.length, 2);
  assert.equal('expect' in (ed.writes[1] as object), false, 'an Overwrite checks nothing');
  assert.equal(ed.fileText(PATH), 'my version\n');
  assert.equal(st.editorDirty(st.editorFileId(PATH)), false);
  assert.deepEqual(textsOf(root, 'pane-fmsg'), [], 'the conflict is over');
  assert.deepEqual(byClass(root, 'pane-fact'), []);
});

test('Load from disk drops the unsaved entry, takes the bytes on disk, and clamps the caret', async () => {
  const root = await mount(PATH);
  const ta = field(root) as FakeElement;
  type(ta, `${ORIGINAL}a lot more typing down here\n`);
  ta.selectionStart = ta.value.length;
  ta.selectionEnd = ta.value.length;
  ed.setFile(PATH, 'short\n');
  saveBtn(root).click();
  await settle();

  act(root, 'Load from disk').click();
  await settle();
  assert.equal(ta.value, 'short\n', 'the file on disk is what is on screen');
  assert.equal(st.editorDirty(st.editorFileId(PATH)), false, 'the unsaved entry is gone');
  assert.equal(ta.selectionStart, 'short\n'.length, 'the caret cannot stand past the end');
  assert.equal(
    (byClass(root, 'pane-gutter')[0] as FakeElement).textContent,
    '1\n2',
    'and the numbers followed',
  );
  assert.deepEqual(textsOf(root, 'pane-fmsg'), []);
  assert.equal(saveBtn(root).textContent, 'Saved');
});

test('a refusal with nothing to choose between is stated in the bar, and Save stays pressable', async () => {
  const root = await mount(PATH);
  type(field(root) as FakeElement, 'cannot land\n');
  ed.failWrite(403, NO_WRITE_TEXT);
  saveBtn(root).click();
  await settle();
  assert.deepEqual(textsOf(root, 'pane-fmsg'), [NO_WRITE_TEXT]);
  assert.deepEqual(byClass(root, 'pane-fact'), [], 'there is no choice to offer');
  assert.equal(saveBtn(root).disabled, false);
  assert.equal(st.editText(st.editorFileId(PATH)), 'cannot land\n', 'still unsaved');
});

test('typing while the write is out keeps the tab UNSAVED — the landing forgets only the text it wrote', async () => {
  // The field stays enabled while a write is out (a save may not freeze the
  // keyboard), so `state.edits` can hold keystrokes NEWER than the bytes that
  // land. Forgetting the whole entry would mark them clean: no dot, `Saved`,
  // no question at any door — and the next follow tick would then overwrite
  // them from disk.
  const root = await mount(PATH);
  const ta = field(root) as FakeElement;
  const id = st.editorFileId(PATH);
  type(ta, 'first version\n');
  ed.holdWrite();
  saveBtn(root).click();
  type(ta, 'first version\nand one more line\n');
  ed.releaseWrites();
  await settle();

  assert.equal(ed.fileText(PATH), 'first version\n', 'the write carried what was pressed');
  assert.equal(st.editorDirty(id), true, 'the newer keystrokes are still unsaved');
  assert.equal(st.editText(id), 'first version\nand one more line\n', 'and they are still there');
  assert.equal(ta.value, 'first version\nand one more line\n');
  assert.equal(saveBtn(root).textContent, 'Save', 'so Save says Save');
  assert.equal(saveBtn(root).disabled, false);

  // The follow must leave that body alone, exactly as any other dirty body.
  ed.reads.length = 0;
  ES.followTick();
  await settle();
  assert.deepEqual(ed.reads, [], 'a dirty body is not polled: the newest text stands');

  // And a save of THAT text does clean the tab (the entry is not stuck).
  saveBtn(root).click();
  await settle();
  assert.equal(st.editorDirty(id), false);
  assert.equal(ed.fileText(PATH), 'first version\nand one more line\n');
});

// ---------------------------------------------------------------------------
// Focus, and what this module may not do
// ---------------------------------------------------------------------------

test('focus() lands in the text, so the pane can be handed the keyboard', async () => {
  const root = await mount(PATH);
  (live[live.length - 1] as Body).focus();
  assert.equal(dom.doc.activeElement, field(root));
});

test('two panes on the SAME file share one unsaved text, and one Save cleans both', async () => {
  const a = await mount(PATH);
  const b = await mount(PATH);
  const bodyB = live[live.length - 1] as Body;
  await settle();
  assert.equal(saveBtn(b).textContent, 'Saved', 'non-vacuity: the second pane opens clean');

  type(field(a) as FakeElement, 'typed in the first pane\n');
  assert.equal(st.state.edits.size, 1, 'one file, one entry — never one per pane');
  bodyB.update();
  assert.equal(saveBtn(b).textContent, 'Save', 'the second pane is unsaved too');
  assert.ok(saveBtn(b).classList.contains('is-dirty'));

  saveBtn(a).click();
  await settle();
  bodyB.update();
  assert.equal(st.state.edits.size, 0, 'the shared entry is gone');
  assert.equal(saveBtn(b).textContent, 'Saved', 'saving in one pane cleans the other');
  assert.equal(ed.fileText(PATH), 'typed in the first pane\n', 'and the text was written once');
});

test('the mock is GONE: no placeholder branch, no invented file content, no api import', () => {
  const src = readSource('web', 'src', 'ui', 'file-pane.ts');
  for (const dead of [
    'files-mock',
    'mockFileContent',
    'saveMockFile',
    'placeholderNote',
    'CANNOT_READ',
    'Example content',
  ]) {
    assert.equal(src.includes(dead), false, `${dead} died with part B4`);
  }
  assert.equal(/from '\.\.\/api\.ts'/.test(src), false, 'the gateway is injected, never imported');
  assert.equal(src.includes('notify('), false, 'no notification from this module');

  // And the module itself is gone from the repository, with every import of
  // it: a placeholder file map is not something to keep "just for tests".
  assert.equal(existsSync(join(projectRoot, 'web', 'src', 'ui', 'files-mock.ts')), false);
  const offenders: string[] = [];
  for (const dir of [join(projectRoot, 'web', 'src'), join(projectRoot, 'web', 'src', 'ui'), ...['ui', 'server', 'release', 'repo', 'helpers'].map((sub) => join(projectRoot, 'tests', sub))]) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      const text = readFileSync(join(dir, name), 'utf8');
      if (/from '[^']*files-mock|files-mock\.ts', import/.test(text)) offenders.push(name);
    }
  }
  assert.deepEqual(offenders, [], `still importing the deleted mock: ${offenders.join(', ')}`);
});
