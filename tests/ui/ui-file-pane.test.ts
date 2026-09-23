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
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, colour, scrolling, the gutter really lining up with the text, and
 * the browser's own `beforeunload` card.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from '../helpers/helpers.ts';
import { byClass, descendants, dispatch, installDom, textsOf, type FakeElement } from '../helpers/fake-dom.ts';
import { PROJ, makeFixture, settle } from '../helpers/fs-fixture.ts';
import { BINARY_PATH, GONE_PATH, GONE_TEXT as DIFF_GONE_TEXT, HEAD, diffOf } from '../helpers/commits-fixture.ts';
import {
  CHANGED_TEXT,
  GONE_TEXT,
  NOT_TEXT_TEXT,
  NO_READ_TEXT,
  NO_WRITE_TEXT,
  TOO_LARGE_TEXT,
  makeEditor,
} from '../helpers/editor-fixture.ts';

const dom = installDom();

interface StateModule {
  state: { edits: Map<string, string> };
  editorFileId(path: string): string;
  editorDirty(id: string | null): boolean;
  editText(id: string): string | undefined;
  setEdit(id: string, text: string): void;
  subscribe(fn: (kind: string) => void): void;
}
interface Body {
  root: FakeElement;
  focus(): void;
  update(): void;
  dispose(): void;
}
interface FilePaneModule {
  filePaneBody(path: string, onDirtyFlip: () => void): Body;
  diffPaneBody(root: string, hash: string, path: string): Body;
}

const st = (await import(new URL('../../web/src/state.ts', import.meta.url).href)) as StateModule;
const FP = (await import(new URL('../../web/src/ui/file-pane.ts', import.meta.url).href)) as unknown as FilePaneModule;
const STORE = (await import(new URL('../../web/src/ui/commit-store.ts', import.meta.url).href)) as {
  setCommitGateway(gw: unknown): void;
};
const ES = (await import(new URL('../../web/src/ui/editor-store.ts', import.meta.url).href)) as {
  setEditorGateway(gw: unknown): void;
  followerCount(): number;
  followTick(): void;
  FOLLOW_MS: number;
};

/** Part B3: a diff pane reads git through the gateway the commit store owns. */
const fx = makeFixture();
STORE.setCommitGateway(fx.gateway);
/** Part B4: a file pane reads and writes through the gateway this store owns. */
const ed = makeEditor();
ES.setEditorGateway(ed.gateway);

/** The shape every path in the app has since part B2: absolute. */
const PATH = '/home/you/web/src/Pane.tsx';
const OTHER = '/home/you/web/src/App.tsx';
const ORIGINAL = 'export function Pane() {\n  return null;\n}\n';
/** One file of one commit, as the commit view hands it to a diff tab. */
const DIFF_PATH = 'shared/protocol.ts';

let flips = 0;
let live: Body[] = [];

/** Build a body, put it on screen, and let its read land. */
async function mount(path: string): Promise<FakeElement> {
  const body = FP.filePaneBody(path, () => {
    flips += 1;
  });
  live.push(body);
  // APPEND, never replace: two bodies on screen at once is a real state (two
  // panes of one file), and detaching one would silently take it out of the
  // disk follow — the very rule several cases below are about.
  dom.body.append(body.root);
  await settle();
  return body.root;
}

/** The one field a file pane offers, or null when it offers none. */
function field(root: FakeElement): FakeElement | null {
  return descendants(root).find((n) => n.tagName === 'TEXTAREA') ?? null;
}

function saveBtn(root: FakeElement): FakeElement {
  return byClass(root, 'pane-save')[0] as FakeElement;
}

/** The two answers a conflict offers, by label. */
function act(root: FakeElement, label: string): FakeElement {
  const hit = byClass(root, 'pane-fact').find((b) => b.textContent === label);
  assert.ok(hit !== undefined, `no ${label} button in the bar`);
  return hit;
}

function type(ta: FakeElement, value: string): void {
  ta.value = value;
  dispatch(ta, 'input');
}

beforeEach(() => {
  // Whatever the last case held in flight is let go first, so one failure
  // cannot leave every later body waiting for an answer that never comes.
  ed.releaseReads();
  ed.releaseWrites();
  for (const b of live) b.dispose();
  live = [];
  dom.body.replaceChildren();
  st.state.edits = new Map();
  ed.reads.length = 0;
  ed.writes.length = 0;
  ed.setFile(PATH, ORIGINAL);
  ed.setFile(OTHER, 'const a = 1;\n');
  flips = 0;
  dom.doc.activeElement = dom.body;
  dom.doc.visibilityState = 'visible';
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
  const src = readFileSync(join(projectRoot, 'web', 'src', 'ui', 'file-pane.ts'), 'utf8');
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

// ---------------------------------------------------------------------------
// The diff half (part B3)
// ---------------------------------------------------------------------------

test('a diff body is READ-ONLY: diff rows, and no field at all', async () => {
  const body = FP.diffPaneBody(PROJ, HEAD, DIFF_PATH);
  dom.body.replaceChildren(body.root);
  // It says `Loading…` first and asks exactly once, with the root the tab
  // carries and the commit it is about.
  assert.deepEqual(textsOf(body.root, 'diff-note'), ['Loading…']);
  assert.deepEqual(fx.diffCalls, [`${HEAD} ${DIFF_PATH}`]);
  await settle();
  assert.equal(field(body.root), null, 'the changes in a commit are not something to type into');
  assert.equal(byClass(body.root, 'pane-save').length, 0, 'and nothing to save');
  assert.equal(
    byClass(body.root, 'diff-line').length,
    diffOf(HEAD, DIFF_PATH).lines.length,
    'it draws exactly the lines the answer carried',
  );
  // The same renderer, so the pane and the screen it came from cannot disagree.
  assert.equal(byClass(body.root, 'diff-body').length, 1);
  assert.equal(byClass(body.root, 'diff-n').length % 2, 0, 'two gutters per row');
});

test('a diff pane notifies NOTHING — its answer may not put the pane grid through a render', async () => {
  const kinds: string[] = [];
  st.subscribe((k) => kinds.push(k));
  const body = FP.diffPaneBody(PROJ, HEAD, DIFF_PATH);
  dom.body.replaceChildren(body.root);
  await settle();
  assert.ok(byClass(body.root, 'diff-line').length > 0, 'non-vacuity: the answer really landed');
  assert.deepEqual(kinds, [], 'it paints its own node and nothing else');
});

test('a gateway that throws SYNCHRONOUSLY still builds the pane, with the sentence in it', async () => {
  // `encodeURIComponent` throws a URIError on a lone surrogate, and a path is
  // git's verbatim bytes. In a pane that throw would escape the BUILD — the
  // body would never be returned and the tab would show nothing at all.
  STORE.setCommitGateway({
    commit: () => Promise.reject(new Error('not asked here')),
    commitDiff: () => {
      throw new URIError('URI malformed');
    },
  });
  try {
    const body = FP.diffPaneBody(PROJ, HEAD, 'a\ud800b');
    dom.body.replaceChildren(body.root);
    assert.equal(byClass(body.root, 'diff-body').length, 1, 'the pane was built');
    await settle();
    assert.deepEqual(textsOf(body.root, 'diff-note'), ['The app could not reach the service.']);
    assert.equal(byClass(body.root, 'diff-line').length, 0);
  } finally {
    STORE.setCommitGateway(fx.gateway);
  }
});

test('a file body built with no gateway at all still builds, and says the one honest thing', async () => {
  ES.setEditorGateway(null);
  try {
    const root = await mount(PATH);
    assert.deepEqual(textsOf(root, 'pane-fempty'), ['The app could not reach the service.']);
    assert.equal(field(root), null);
  } finally {
    ES.setEditorGateway(ed.gateway);
  }
});

test('a binary file and a refused one each draw ONE note, never a numbered row', async () => {
  const bin = FP.diffPaneBody(PROJ, HEAD, BINARY_PATH);
  dom.body.replaceChildren(bin.root);
  await settle();
  assert.equal(byClass(bin.root, 'diff-line').length, 0);
  assert.deepEqual(textsOf(bin.root, 'diff-note'), ['Binary file.']);

  const gone = FP.diffPaneBody(PROJ, HEAD, GONE_PATH);
  dom.body.replaceChildren(gone.root);
  await settle();
  assert.equal(byClass(gone.root, 'diff-line').length, 0);
  assert.deepEqual(textsOf(gone.root, 'diff-note'), [DIFF_GONE_TEXT], "the server's own sentence");
  assert.equal((byClass(gone.root, 'diff-note')[0] as FakeElement).classList.contains('is-bad'), true);
});

test('every class a file or diff body renders has a rule in app.css', async () => {
  const seen = new Set<string>();
  const collect = (root: FakeElement): void => {
    for (const n of [root, ...descendants(root)]) {
      for (const c of n.className.split(/\s+/)) if (c !== '') seen.add(c);
    }
  };
  const root = await mount(PATH);
  collect(root);
  type(field(root) as FakeElement, 'dirty\n');
  collect(root);
  // The conflict bar and the two refusal inks are classes too.
  ed.setFile(PATH, 'theirs\n');
  saveBtn(root).click();
  await settle();
  collect(root);
  ed.failRead(OTHER, 415, NOT_TEXT_TEXT);
  collect(await mount(OTHER));
  collect(await mount('/home/you/never-existed.ts'));
  const diff = FP.diffPaneBody(PROJ, HEAD, DIFF_PATH);
  collect(diff.root);
  await settle();
  collect(diff.root);
  const bin = FP.diffPaneBody(PROJ, HEAD, BINARY_PATH);
  await settle();
  collect(bin.root);

  assert.ok(seen.size >= 10, `non-vacuity: only ${seen.size} classes were collected`);
  const css = readFileSync(join(projectRoot, 'web', 'src', 'styles', 'app.css'), 'utf8');
  const missing = [...seen].filter((c) => !css.includes(`.${c}`)).sort();
  assert.deepEqual(missing, [], `classes with no rule in app.css: ${missing.join(', ')}`);
});
