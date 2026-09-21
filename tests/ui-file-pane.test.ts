/**
 * The body of a file pane and of a diff pane (Nocturne part A10), driven
 * through the REAL `web/src/ui/file-pane.ts` on the shared DOM double, against
 * the REAL `web/src/state.ts`, `ui/util.ts`, `ui/editor-model.ts`,
 * `ui/files-mock.ts`, `ui/commit-store.ts` (with the backend a plain fake) and
 * the commit view's own diff renderer.
 *
 * WHY, next to `tests/ui-editor-model.test.ts`. That file pins the arithmetic
 * (what an id means, how many line numbers a text needs, what Save is called);
 * this one pins the PLUMBING the A6 editor column taught us to distrust:
 *
 *   - a textarea REBUILT on every keystroke (the caret, the selection and the
 *     scroll position would jump on every letter),
 *   - a dirty FLIP that costs a redraw every keystroke instead of one,
 *   - a Save that writes nowhere,
 *   - a path with no example text offering a field to type into, or a Save
 *     that would write a sentence into a file,
 *   - a read-only diff that renders an editable field,
 *   - (part B3) a diff pane that asks nothing, or that repaints the PANE GRID
 *     when its answer lands — a diff arriving may never put a terminal
 *     through a rebuild.
 *
 * The amber dot itself, the header `×` and the pane chrome around this body
 * live in `ui/panes.ts`, which imports @xterm/xterm and cannot be loaded here;
 * they are pinned by source in `tests/ui-pane-a10.test.ts`. What this file
 * proves about the dot is the FACT it draws: the dirty flip, exactly once.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, colour, scrolling, the gutter really lining up with the text.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './helpers.ts';
import { byClass, descendants, dispatch, installDom, textsOf, type FakeElement } from './fake-dom.ts';
import { PROJ, makeFixture, settle } from './fs-fixture.ts';
import { BINARY_PATH, GONE_PATH, GONE_TEXT, HEAD, diffOf } from './commits-fixture.ts';

const dom = installDom();

interface StateModule {
  state: { edits: Map<string, string> };
  editorFileId(path: string): string;
  editorDirty(id: string | null): boolean;
  setEdit(id: string, text: string): void;
  subscribe(fn: (kind: string) => void): void;
}
interface FilePaneModule {
  filePaneBody(
    path: string,
    onDirtyFlip: () => void,
  ): { root: FakeElement; focus(): void; update(): void };
  diffPaneBody(
    root: string,
    hash: string,
    path: string,
  ): { root: FakeElement; focus(): void; update(): void };
}

const st = (await import(new URL('../web/src/state.ts', import.meta.url).href)) as StateModule;
const FP = (await import(new URL('../web/src/ui/file-pane.ts', import.meta.url).href)) as unknown as FilePaneModule;
const MOCK = (await import(new URL('../web/src/ui/files-mock.ts', import.meta.url).href)) as {
  mockFileContent(path: string): string | null;
  saveMockFile(path: string, text: string): void;
};
const STORE = (await import(new URL('../web/src/ui/commit-store.ts', import.meta.url).href)) as {
  setCommitGateway(gw: unknown): void;
};
/** Part B3: a diff pane reads git through the gateway the store owns. */
const fx = makeFixture();
STORE.setCommitGateway(fx.gateway);

const PATH = 'web/src/Pane.tsx';
const NO_TEXT = 'server/nothing-here.ts';
const ORIGINAL = MOCK.mockFileContent(PATH) as string;
/** One file of one commit, as the commit view hands it to a diff tab. */
const DIFF_PATH = 'shared/protocol.ts';

let flips = 0;

function mount(path: string): FakeElement {
  const body = FP.filePaneBody(path, () => {
    flips += 1;
  });
  dom.body.replaceChildren(body.root);
  return body.root;
}

/** The one field a file pane offers, or null when it offers none. */
function field(root: FakeElement): FakeElement | null {
  return descendants(root).find((n) => n.tagName === 'TEXTAREA') ?? null;
}

function type(ta: FakeElement, value: string): void {
  ta.value = value;
  dispatch(ta, 'input');
}

beforeEach(() => {
  st.state.edits = new Map();
  MOCK.saveMockFile(PATH, ORIGINAL);
  flips = 0;
  dom.doc.activeElement = dom.body;
});

test('non-vacuity: the mock really has text for one path and none for the other', () => {
  assert.ok(ORIGINAL.length > 20, 'the example file looks empty');
  assert.equal(MOCK.mockFileContent(NO_TEXT), null, 'the second path must be unknown to the mock');
  assert.ok(diffOf(HEAD, DIFF_PATH).lines.length > 0, 'the fixture commit really has a diff');
});

test('a file body is the numbers, the text and Save — on the pane, not in a column', () => {
  const root = mount(PATH);
  const ta = field(root);
  assert.ok(ta !== null, 'a known file offers a field');
  assert.equal(ta.value, ORIGINAL, 'and it holds the file, not a summary of it');
  assert.equal(byClass(root, 'pane-gutter').length, 1, 'one line-number column');
  assert.equal(
    (byClass(root, 'pane-gutter')[0] as FakeElement).textContent.split('\n').length,
    ORIGINAL.split('\n').length,
    'one number per line of the text',
  );
  const save = byClass(root, 'pane-save')[0] as FakeElement;
  assert.equal(save.textContent, 'Saved', 'a clean file has nothing to write');
  assert.equal(save.disabled, true);
});

test('the honesty line belongs to the MOCK branch only (part B2)', () => {
  // The real-file branch needs no such line — it says outright that the app
  // cannot read the file. The other branch is still fiction: a path
  // `ui/files-mock.ts` has text for draws a textarea with a Save. A field full
  // of invented source with nothing saying so is the one thing placeholder
  // data must not do, so the line stays exactly there until part B4. (Since
  // part B3 only a test reaches that branch: every path the app hands over is
  // absolute and the mock's keys are repository-relative.)
  assert.deepEqual(textsOf(mount(PATH), 'pane-fnote'), [
    'Example content until the app reads your files.',
  ]);
  assert.deepEqual(textsOf(mount(NO_TEXT), 'pane-fnote'), [], 'the real branch has nothing to apologise for');
  const src = readFileSync(join(projectRoot, 'web', 'src', 'ui', 'file-pane.ts'), 'utf8');
  assert.equal(
    src.split('placeholderNote(').length - 1,
    2,
    'one definition, one call site — part B4 deletes both',
  );
});

test('a file opened from the panel has an absolute path, and no text to show for it', () => {
  // The real B2 shape: `/home/you/web/src/Pane.tsx`, not `web/src/Pane.tsx`.
  const root = mount('/home/you/web/src/Pane.tsx');
  assert.equal(field(root), null, 'nothing to type into until part B4');
  assert.deepEqual(textsOf(root, 'pane-fempty'), ['The app cannot read this file yet.']);
});

test('the FIRST keystroke flips the pane to unsaved — and only the first', () => {
  const root = mount(PATH);
  const ta = field(root) as FakeElement;
  type(ta, `${ORIGINAL}a`);
  assert.equal(st.editorDirty(st.editorFileId(PATH)), true, 'the file is unsaved now');
  assert.equal(flips, 1, 'the header dot and the tab chip are redrawn once');
  const save = byClass(root, 'pane-save')[0] as FakeElement;
  assert.equal(save.textContent, 'Save');
  assert.equal(save.disabled, false);
  assert.ok(save.classList.contains('is-dirty'), 'and it takes the accent');

  for (let i = 0; i < 19; i += 1) type(ta, `${ORIGINAL}a${i}`);
  assert.equal(flips, 1, 'nineteen more keystrokes redraw nothing: the strip already says it');
});

test('the textarea is the SAME node after twenty keystrokes — the caret never jumps', () => {
  const root = mount(PATH);
  const ta = field(root) as FakeElement;
  for (let i = 0; i < 20; i += 1) type(ta, `${ORIGINAL}\nline ${i}`);
  assert.equal(field(root), ta, 'the body was not rebuilt under the user');
  // The gutter DID follow the text: that is the one thing typing may redraw.
  assert.equal(
    (byClass(root, 'pane-gutter')[0] as FakeElement).textContent.split('\n').length,
    `${ORIGINAL}\nline 19`.split('\n').length,
  );
});

test('Save writes the text back through saveMockFile and the button states it again', () => {
  const root = mount(PATH);
  const ta = field(root) as FakeElement;
  type(ta, 'const answer = 42;\n');
  const save = byClass(root, 'pane-save')[0] as FakeElement;
  save.click();
  assert.equal(MOCK.mockFileContent(PATH), 'const answer = 42;\n', 'the text reached the mock');
  assert.equal(st.editorDirty(st.editorFileId(PATH)), false, 'and the file is clean again');
  assert.equal(save.textContent, 'Saved');
  assert.equal(save.disabled, true);
  assert.equal(save.classList.contains('is-dirty'), false);
  assert.equal(dom.doc.activeElement, ta, 'the keyboard stays in the text it just saved');
  assert.equal(field(root), ta, 'and the body was not rebuilt to say so');
});

test('a path with no example text draws a note — no field, no numbers, no Save', () => {
  const root = mount(NO_TEXT);
  assert.equal(field(root), null, 'nothing to type into');
  assert.equal(byClass(root, 'pane-gutter').length, 0, 'and no numbers beside it');
  assert.equal(byClass(root, 'pane-save').length, 0, 'a Save that writes a sentence would be a lie');
  assert.deepEqual(textsOf(root, 'pane-fempty'), ['The app cannot read this file yet.']);
  assert.equal(byClass(root, 'pane-fbar').length, 0, 'and no empty strip of chrome under it');
});

test('unsaved text beats the mock when the same file opens in a second pane', () => {
  const first = mount(PATH);
  type(field(first) as FakeElement, 'typed but never saved\n');
  const second = mount(PATH);
  assert.equal((field(second) as FakeElement).value, 'typed but never saved\n');
  assert.equal(MOCK.mockFileContent(PATH), ORIGINAL, 'and nothing was written to get there');
  const save = byClass(second, 'pane-save')[0] as FakeElement;
  assert.equal(save.textContent, 'Save', 'the second pane opens unsaved, like the first');
});

test('two panes on the SAME file share one unsaved text, and one Save cleans both', () => {
  // Free mixing (user decision 3, 2026-09-15) makes this reachable: the same
  // file can be a pane in two tabs, or twice in one. `state.edits` is keyed by
  // the PATH (`f:<path>` = slotKey), so there is one text and both headers
  // must say the same thing about it. The amber dot itself is pane chrome
  // (ui/panes.ts, source-pinned); what a header reads to draw it is this.
  const a = FP.filePaneBody(PATH, () => {
    flips += 1;
  });
  const b = FP.filePaneBody(PATH, () => {
    flips += 1;
  });
  dom.body.replaceChildren(a.root, b.root);
  const saveA = byClass(a.root, 'pane-save')[0] as FakeElement;
  const saveB = byClass(b.root, 'pane-save')[0] as FakeElement;
  assert.equal(saveB.textContent, 'Saved', 'non-vacuity: the second pane opens clean');

  type(field(a.root) as FakeElement, 'typed in the first pane\n');
  assert.equal(st.state.edits.size, 1, 'one file, one entry — never one per pane');
  assert.equal(st.state.edits.get(st.editorFileId(PATH)), 'typed in the first pane\n');
  assert.equal(st.editorDirty(st.editorFileId(PATH)), true);

  // The chrome redraws both panes on the 'ui' notify (ui/panes.ts
  // reconcileSlot -> body.update()); the second header reads the same entry.
  b.update();
  assert.equal(saveB.textContent, 'Save', 'the second pane is unsaved too');
  assert.equal(saveB.disabled, false);
  assert.ok(saveB.classList.contains('is-dirty'), 'and wears the same accent');

  saveA.click();
  b.update();
  assert.equal(st.state.edits.size, 0, 'the shared entry is gone');
  assert.equal(saveB.textContent, 'Saved', 'saving in one pane cleans the other');
  assert.equal(saveB.disabled, true);
  assert.equal(MOCK.mockFileContent(PATH), 'typed in the first pane\n', 'and the text was written once');
});

test('focus() lands in the text, so the pane can be handed the keyboard', () => {
  const body = FP.filePaneBody(PATH, () => {});
  dom.body.replaceChildren(body.root);
  body.focus();
  assert.equal(dom.doc.activeElement, field(body.root));
});

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
  const src = readFileSync(join(projectRoot, 'web', 'src', 'ui', 'file-pane.ts'), 'utf8');
  assert.equal(src.includes('notify('), false, 'no notification from this module');
  assert.equal(/from '\.\.\/api\.ts'/.test(src), false, 'and no API import: the gateway is injected');
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
  assert.deepEqual(textsOf(gone.root, 'diff-note'), [GONE_TEXT], "the server's own sentence");
  assert.equal((byClass(gone.root, 'diff-note')[0] as FakeElement).classList.contains('is-bad'), true);
});

test('every class a file or diff body renders has a rule in app.css', async () => {
  const seen = new Set<string>();
  const collect = (root: FakeElement): void => {
    for (const n of [root, ...descendants(root)]) {
      for (const c of n.className.split(/\s+/)) if (c !== '') seen.add(c);
    }
  };
  const root = mount(PATH);
  collect(root);
  type(field(root) as FakeElement, 'dirty\n');
  collect(root);
  collect(mount(NO_TEXT));
  const diff = FP.diffPaneBody(PROJ, HEAD, DIFF_PATH);
  collect(diff.root);
  await settle();
  collect(diff.root);
  const bin = FP.diffPaneBody(PROJ, HEAD, BINARY_PATH);
  await settle();
  collect(bin.root);

  assert.ok(seen.size >= 8, `non-vacuity: only ${seen.size} classes were collected`);
  const css = readFileSync(join(projectRoot, 'web', 'src', 'styles', 'app.css'), 'utf8');
  const missing = [...seen].filter((c) => !css.includes(`.${c}`)).sort();
  assert.deepEqual(missing, [], `classes with no rule in app.css: ${missing.join(', ')}`);
});
