/**
 * The disk follow of a file pane (Nocturne part B4, user decision D3), driven
 * through the REAL `web/src/ui/file-pane.ts` and `ui/editor-store.ts` on the
 * shared DOM double with the file backend a plain fake
 * (`tests/helpers/editor-fixture.ts`; shared setup:
 * `tests/helpers/ui-file-pane-fixture.ts`). Split from
 * `tests/ui/ui-file-pane.test.ts`.
 *
 * What: ONE recorded 5 s interval; a clean tab on screen re-reads with its
 * stamp and is taken over by a changed file; a dirty tab, a parked body, a
 * hidden window, a body with a request out and one that failed are left
 * alone; a follow answer never overwrites a keystroke or a newer save; a
 * disposed body is never asked again. The interval is recorded by the DOM
 * double and ticked by hand — nothing waits on a clock.
 *
 * Why: unsaved text OVERWRITTEN from disk by the follow, or a follow that
 * keeps asking about a file whose pane is gone, fails silently.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, colour, scrolling, the gutter really lining up with the text, and
 * the browser's own `beforeunload` card.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { byClass, textsOf, type FakeElement, typeInto as type } from '../helpers/fake-dom.ts';
import { settle } from '../helpers/fs-fixture.ts';
import { NOT_TEXT_TEXT, NO_READ_TEXT } from '../helpers/editor-fixture.ts';
import {
  dom,
  st,
  FP,
  ES,
  ed,
  PATH,
  OTHER,
  ORIGINAL,
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
// The disk follow (user decision D3)
// ---------------------------------------------------------------------------

test('the follow is ONE recorded 5 s interval, and a clean tab on screen re-reads with its stamp', async () => {
  const root = await mount(PATH);
  const before = dom.win.intervals.length;
  assert.ok(before >= 1, 'the store armed its timer');
  assert.equal(
    (dom.win.intervals[0] as { ms: number }).ms,
    ES.FOLLOW_MS,
    'the one rhythm the store owns',
  );
  await mount(OTHER);
  assert.equal(dom.win.intervals.length, before, 'a second body arms no second timer');

  ed.reads.length = 0;
  const stamp = ed.stampOf(PATH);
  // Through the RECORDED timer, not around it: the rhythm the app really runs
  // on is the function that interval holds.
  (dom.win.intervals[0] as { fn: () => void }).fn();
  await settle();
  assert.ok(
    ed.reads.includes(`${PATH} if=${stamp}`),
    `the stamp rides along: ${ed.reads.join(', ')}`,
  );
  // Unchanged: no text in the answer, nothing repainted.
  assert.equal((field(root) as FakeElement).value, ORIGINAL);
});

test('a changed file is taken over: new text, new numbers, caret clamped, scroll kept', async () => {
  const root = await mount(PATH);
  const ta = field(root) as FakeElement;
  ta.selectionStart = 30;
  ta.selectionEnd = 30;
  ta.scrollTop = 120;
  ed.setFile(PATH, 'one\ntwo\n');
  ES.followTick();
  await settle();
  assert.equal(ta.value, 'one\ntwo\n');
  assert.equal((byClass(root, 'pane-gutter')[0] as FakeElement).textContent, '1\n2\n3');
  assert.equal(ta.selectionStart, 'one\ntwo\n'.length, 'the caret went to the end, not to 0');
  assert.equal(ta.scrollTop, 120, 'and the reader keeps their place');
});

test('a DIRTY tab is never polled — typed text is not overwritten by the disk', async () => {
  const root = await mount(PATH);
  type(field(root) as FakeElement, 'mine\n');
  ed.setFile(PATH, 'theirs\n');
  ed.reads.length = 0;
  ES.followTick();
  await settle();
  assert.deepEqual(ed.reads, [], 'a dirty body is not even asked');
  assert.equal((field(root) as FakeElement).value, 'mine\n');
});

test('a keystroke that lands while a follow read is out is not overwritten by the answer', async () => {
  const root = await mount(PATH);
  const ta = field(root) as FakeElement;
  const id = st.editorFileId(PATH);
  // The file changed on disk, so the follow answer really carries text.
  ed.setFile(PATH, 'theirs\n');
  ed.holdRead();
  ES.followTick();
  assert.equal(ed.reads.length, 2, 'non-vacuity: the follow read is out');
  // The tab was clean when the question left; it is dirty when it answers.
  type(ta, 'mine\n');
  ed.releaseReads();
  await settle();
  assert.equal(ta.value, 'mine\n', 'typed text is never overwritten from disk (D3)');
  assert.equal(st.editText(id), 'mine\n');
  assert.equal(saveBtn(root).textContent, 'Save');
});

test('a follow answer that lands AFTER a save replaces neither the saved text nor the newer stamp', async () => {
  const root = await mount(PATH);
  const ta = field(root) as FakeElement;
  const id = st.editorFileId(PATH);
  // Another window changed the file: the follow read that goes out now will
  // come back with THOSE bytes and THAT stamp.
  ed.setFile(PATH, 'their version\n');
  ed.reads.length = 0;
  ed.holdRead();
  ES.followTick();
  assert.equal(ed.reads.length, 1, 'non-vacuity: the read is really out');

  // While it is out the user types and lands a save: the normal one is refused
  // (the file moved), Overwrite writes their text and a NEW stamp comes back.
  type(ta, 'mine\n');
  saveBtn(root).click();
  await settle();
  act(root, 'Overwrite').click();
  await settle();
  const saved = ed.stampOf(PATH);
  assert.equal(ed.fileText(PATH), 'mine\n', 'non-vacuity: the save landed');
  assert.equal(st.editorDirty(id), false);

  // Only NOW does the read from before the save answer.
  ed.releaseReads();
  await settle();
  assert.equal(ta.value, 'mine\n', 'the pre-save bytes may not come back on screen');
  assert.equal(st.editorDirty(id), false, 'and the tab is still clean');

  // And the stamp the body holds is the SAVE's, not the read's — the next save
  // is compared against the version that is really on disk, so it is not
  // refused and cannot be answered by writing stale text over it.
  type(ta, 'mine again\n');
  saveBtn(root).click();
  await settle();
  assert.equal(
    ed.writes[ed.writes.length - 1]?.expect,
    saved,
    'the stamp the save came back with survived the older answer',
  );
  assert.deepEqual(textsOf(root, 'pane-fmsg'), [], 'so nothing was refused');
  assert.equal(ed.fileText(PATH), 'mine again\n');
});

test('a follow refused while the tab was typed into keeps the field and the text', async () => {
  const root = await mount(PATH);
  const ta = field(root) as FakeElement;
  const id = st.editorFileId(PATH);
  // The refusal is armed before the question leaves: this read is on its way
  // when the user starts typing.
  ed.failRead(PATH, 403, NO_READ_TEXT);
  ed.holdRead();
  ES.followTick();
  type(ta, 'typed while it was out\n');
  ed.releaseReads();
  await settle();

  assert.ok(field(root) !== null, 'the work is in that field: it may not be taken away');
  assert.equal((field(root) as FakeElement).value, 'typed while it was out\n');
  assert.equal(st.editText(id), 'typed while it was out\n');
  assert.deepEqual(textsOf(root, 'pane-fempty'), [], 'no sentence where the file was');
  assert.equal(saveBtn(root).textContent, 'Save', 'and the text can still be written');
  assert.equal(saveBtn(root).disabled, false);
});

test('a PARKED body (its tab is not up) and a HIDDEN window are both left alone', async () => {
  const root = await mount(PATH);
  ed.reads.length = 0;

  // Parked = detached, which is exactly how ui/editor-pane.ts keeps a tab
  // nobody is looking at.
  dom.body.replaceChildren();
  ES.followTick();
  await settle();
  assert.deepEqual(ed.reads, [], 'a body that is not on screen asks nothing');

  dom.body.replaceChildren(root);
  dom.doc.visibilityState = 'hidden';
  ES.followTick();
  await settle();
  assert.deepEqual(ed.reads, [], 'a background window is not a screen anybody reads');

  dom.doc.visibilityState = 'visible';
  ES.followTick();
  await settle();
  assert.equal(ed.reads.length, 1, 'non-vacuity: the same body does ask when it may');
});

test('a body with a request still out is skipped, and one that failed is never re-asked', async () => {
  const root = await mount(PATH);
  ed.reads.length = 0;
  ed.holdRead();
  ES.followTick();
  assert.equal(ed.reads.length, 1);
  ES.followTick();
  assert.equal(ed.reads.length, 1, 'one request at a time');
  ed.releaseReads();
  await settle();

  // A file that became unreadable: the sentence replaces the field, the TAB
  // stays, and the follow lets it be (no stamp to compare any more).
  ed.failRead(PATH, 415, NOT_TEXT_TEXT);
  ES.followTick();
  await settle();
  assert.deepEqual(textsOf(root, 'pane-fempty'), [NOT_TEXT_TEXT]);
  assert.equal(field(root), null);
  ed.reads.length = 0;
  ES.followTick();
  await settle();
  assert.deepEqual(ed.reads, [], 'a refused question is not asked every five seconds');
});

test('dispose() takes the body out of the follow — a closed pane asks nothing ever again', async () => {
  const body = FP.filePaneBody(PATH, () => {});
  dom.body.append(body.root);
  await settle();
  const before = ES.followerCount();
  assert.ok(before >= 1, 'non-vacuity: it was registered');
  body.dispose();
  assert.equal(ES.followerCount(), before - 1);
  ed.reads.length = 0;
  ES.followTick();
  await settle();
  assert.deepEqual(ed.reads, []);
});
