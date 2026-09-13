/**
 * The two A6 screens driven through the REAL modules on the shared DOM double:
 * `web/src/ui/commit-view.ts` and `web/src/ui/editor.ts`, against the REAL
 * `web/src/state.ts`, `ui/util.ts`, `ui/icons.ts`, the two A6 models and
 * `ui/files-mock.ts`.
 *
 * WHY, next to `ui-commit-model.test.ts` / `ui-editor-model.test.ts`. Those
 * pin the arithmetic; this file pins the PLUMBING, which is where the silent
 * regressions live: a back button that closes nothing, a file block whose fold
 * state disagrees with the Files panel row that folded it, a × that raises the
 * tab it was meant to close, a textarea rebuilt on every keystroke (the caret
 * would jump), a Save that writes nowhere, a diff tab that renders an editable
 * field. Every one of those keeps the model tests green.
 *
 * Plus the shell wiring in `web/src/main.ts` and the pane-area guard in
 * `web/src/ui/panes.ts`, read from the source — main.ts's import graph reaches
 * @xterm/xterm, a browser bundle. Each assertion is written so that deleting
 * the wiring it names fails it.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, colour, the 46% split actually reflowing a PTY, focus policy,
 * scrolling, screen-reader output.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  byClass,
  byKey,
  descendants,
  dispatch,
  installDom,
  textsOf,
  type FakeElement,
} from './fake-dom.ts';

const dom = installDom();
const here = dirname(fileURLToPath(import.meta.url));

interface Tab {
  id: string;
  label: string;
  path: string;
  hash?: string;
}
interface StateModule {
  state: {
    openCommit: string | null;
    commitCollapsed: Set<string>;
    editor: { tabs: Tab[]; active: string | null };
    edits: Map<string, string>;
  };
  subscribe(fn: (kind: string) => void): void;
  openCommitView(hash: string): void;
  closeCommitView(): void;
  toggleCommitFile(hash: string, path: string): void;
  commitFileCollapsed(hash: string, path: string): boolean;
  openEditorTab(id: string, label: string, path: string, hash?: string): void;
  closeEditorTab(id: string): void;
  editorFileId(path: string): string;
  editorDirty(id: string | null): boolean;
  editorVisible(): boolean;
  setEditorActive(id: string): void;
  setEdit(id: string, text: string): void;
  saveEdit(id: string): string | null;
}

const st = (await import(new URL('../web/src/state.ts', import.meta.url).href)) as StateModule;
const CV = (await import(new URL('../web/src/ui/commit-view.ts', import.meta.url).href)) as {
  initCommitView(
    host: unknown,
    onLeaveScreen: () => void,
    onOpenEditor: () => void,
  ): { render(): void };
};
const ED = (await import(new URL('../web/src/ui/editor.ts', import.meta.url).href)) as {
  initEditor(host: unknown): { render(): void; focusBody(): void };
};
const MODEL = (await import(new URL('../web/src/ui/commit-model.ts', import.meta.url).href)) as {
  blockDomId(hash: string, path: string): string;
};
const MOCK = (await import(new URL('../web/src/ui/files-mock.ts', import.meta.url).href)) as {
  MOCK_COMMITS: {
    hash: string;
    message: string;
    author: string;
    when: string;
    files: { path: string; add: number; del: number }[];
  }[];
  mockFileContent(path: string): string | null;
  saveMockFile(path: string, text: string): void;
};

const C0 = MOCK.MOCK_COMMITS[0] as (typeof MOCK.MOCK_COMMITS)[number];
const F0 = C0.files[0] as { path: string; add: number; del: number };
const F1 = C0.files[1] as { path: string; add: number; del: number };

const commitHost = dom.doc.createElement('section');
const editorHost = dom.doc.createElement('section');
dom.body.append(commitHost, editorHost);

let handBacks = 0;
const editor = ED.initEditor(editorHost);
const view = CV.initCommitView(
  commitHost,
  () => {
    handBacks += 1;
  },
  () => editor.focusBody(),
);

/** The shell's own dispatch: both screens re-render on every change. */
st.subscribe(() => {
  view.render();
  editor.render();
});

const commitRoot = commitHost.children[0] as FakeElement;
const editorRoot = editorHost.children[0] as FakeElement;

beforeEach(() => {
  st.state.openCommit = null;
  st.state.commitCollapsed = new Set();
  st.state.editor = { tabs: [], active: null };
  st.state.edits = new Map();
  handBacks = 0;
  dom.doc.activeElement = dom.body;
  view.render();
  editor.render();
});

// ---------------------------------------------------------------------------
// The commit view
// ---------------------------------------------------------------------------

test('a closed commit view renders nothing at all', () => {
  assert.equal(byClass(commitRoot, 'commit-vmsg').length, 0);
  assert.equal(byClass(commitRoot, 'diff-block').length, 0);
});

test('an opened commit fills the header: message, author, when, branch, hash, totals, five blocks', () => {
  st.openCommitView(C0.hash);
  assert.equal(textsOf(commitRoot, 'commit-vmsg')[0], C0.message);
  assert.equal(textsOf(commitRoot, 'commit-vauthor')[0], C0.author);
  assert.equal(textsOf(commitRoot, 'commit-avatar')[0], C0.author.charAt(0).toUpperCase());
  assert.ok(commitRoot.textContent.includes(`committed ${C0.when}`));
  assert.equal(textsOf(commitRoot, 'commit-branch')[0], 'main');
  assert.equal(textsOf(commitRoot, 'commit-vhash')[0], C0.hash);

  const sum = byClass(commitRoot, 'commit-vsum')[0] as FakeElement;
  const add = C0.files.reduce((a, f) => a + f.add, 0);
  const del = C0.files.reduce((a, f) => a + f.del, 0);
  assert.ok(sum.textContent.includes(`${C0.files.length} files changed`));
  assert.ok(sum.textContent.includes(`+${add}`));
  assert.ok(sum.textContent.includes(`-${del}`));
  assert.equal(byClass(commitRoot, 'commit-bar-b').length, 5, 'the bar is always five blocks');

  // The avatar is decoration; the name beside it is the content.
  assert.equal((byClass(commitRoot, 'commit-avatar')[0] as FakeElement).getAttribute('aria-hidden'), 'true');
});

test('the header says, quietly and once, that the commit is an example', () => {
  st.openCommitView(C0.hash);
  assert.deepEqual(textsOf(commitRoot, 'commit-note'), [
    'Example commit until the view reads your repository.',
  ]);
  // ONE render site, so part B3 removes it by deleting one function and one
  // argument — not by hunting branches.
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'commit-view.ts'), 'utf8');
  assert.equal(src.split('placeholderNote(').length - 1, 2, 'one definition, one call site');
});

test('`Open on GitHub` is an unavailable BUTTON whose reason is readable, never a fake address', () => {
  st.openCommitView(C0.hash);
  const gh = byClass(commitRoot, 'commit-gh')[0] as FakeElement;
  assert.equal(gh.textContent, 'Open on GitHub');
  assert.equal(gh.tagName, 'BUTTON', 'a link would promise a remote no datum in this app knows yet');
  assert.equal(gh.getAttribute('href'), null);
  // `aria-disabled`, not `disabled`: a disabled control is skipped by the very
  // reader the sentence is for.
  assert.equal(gh.getAttribute('aria-disabled'), 'true');
  assert.equal(gh.disabled, false, 'it stays reachable by the keyboard');
  assert.equal(gh.title, 'Available when the view reads your repository');

  // The explanation is real TEXT the button points at, not a tooltip only a
  // pointer can find.
  const why = byClass(commitRoot, 'sr-only')[0] as FakeElement | undefined;
  assert.notEqual(why, undefined, 'the explanation is an element, not only a tooltip');
  assert.equal((why as FakeElement).id, gh.getAttribute('aria-describedby'));
  assert.ok(((why as FakeElement).id ?? '') !== '', 'non-vacuity: it really has an id');
  assert.equal((why as FakeElement).textContent, 'Available when the view reads your repository');

  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'commit-view.ts'), 'utf8');
  assert.equal(/el\('a'|setAttribute\('href'|\.href =/.test(src), false, 'not even a `#`');
});

test('the two back controls carry a DRAWN chevron and plain words, never a glyph in the sentence', () => {
  st.openCommitView(C0.hash);
  const back = byKey(commitRoot, 'commit:back') as FakeElement;
  assert.equal(back.tagName, 'BUTTON');
  assert.equal(back.textContent, 'Back to sessions', 'the label is words only');
  const svg = back.children[0] as FakeElement;
  assert.equal(svg.tagName, 'SVG');
  assert.equal(svg.getAttribute('aria-hidden'), 'true', 'the chevron is geometry');
});

test('Back to sessions closes the view and hands the keyboard back', () => {
  st.openCommitView(C0.hash);
  (byKey(commitRoot, 'commit:back') as FakeElement).click();
  assert.equal(st.state.openCommit, null);
  assert.equal(handBacks, 1, 'without this the focus falls to <body>');
  assert.equal(byClass(commitRoot, 'commit-vmsg').length, 0, 'and the view is empty again');
});

test('one collapsible block per file: path, numbers, caret, and the diff itself', () => {
  st.openCommitView(C0.hash);
  const blocks = byClass(commitRoot, 'diff-block');
  assert.equal(blocks.length, C0.files.length);
  assert.deepEqual(textsOf(commitRoot, 'diff-path'), C0.files.map((f) => f.path));

  const first = blocks[0] as FakeElement;
  assert.ok(first.textContent.includes(`+${F0.add}`));
  assert.ok(first.textContent.includes(`-${F0.del}`));
  const toggle = byKey(commitRoot, `diff:${C0.hash}:${F0.path}`) as FakeElement;
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'a commit opens fully expanded');
  assert.equal((toggle.children[0] as FakeElement).textContent, '▾');
  assert.equal((toggle.children[0] as FakeElement).getAttribute('aria-hidden'), 'true');

  // The diff rows: a number, a sign and the text, with the kind on the row.
  const rows = byClass(first, 'diff-line');
  assert.ok(rows.length > 5, `non-vacuity: ${rows.length} diff rows`);
  const kinds = new Set(rows.map((r) => r.dataset.kind));
  assert.ok(kinds.has('add') && kinds.has('ctx'), 'the ground of a row is its meaning');
  assert.equal((byClass(first, 'diff-n')[0] as FakeElement).textContent, '1');
});

test('a file block folds and unfolds, and only its own diff goes with it', () => {
  st.openCommitView(C0.hash);
  const before = byClass(commitRoot, 'diff-line').length;
  const inFirst = byClass(byClass(commitRoot, 'diff-block')[0] as FakeElement, 'diff-line').length;
  assert.ok(inFirst > 0 && before > inFirst, 'non-vacuity: two blocks with diffs');

  (byKey(commitRoot, `diff:${C0.hash}:${F0.path}`) as FakeElement).click();
  assert.equal(st.commitFileCollapsed(C0.hash, F0.path), true);
  assert.equal(byClass(commitRoot, 'diff-line').length, before - inFirst);
  const toggle = byKey(commitRoot, `diff:${C0.hash}:${F0.path}`) as FakeElement;
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal((toggle.children[0] as FakeElement).textContent, '▸');
  assert.equal(byClass(commitRoot, 'diff-block').length, C0.files.length, 'the block itself stays');

  toggle.click();
  assert.equal(byClass(commitRoot, 'diff-line').length, before, 'and the diff comes back');
});

test('opening another commit starts with every block open again', () => {
  const second = MOCK.MOCK_COMMITS[1] as (typeof MOCK.MOCK_COMMITS)[number];
  st.openCommitView(C0.hash);
  st.toggleCommitFile(C0.hash, F0.path);
  assert.equal(st.state.commitCollapsed.size, 1);
  st.closeCommitView();
  st.openCommitView(second.hash);
  assert.equal(st.state.commitCollapsed.size, 0, 'a stale fold can never hide another commit');
  assert.deepEqual(textsOf(commitRoot, 'diff-path'), second.files.map((f) => f.path));
});

// The ORDER is open-then-close since the fixer's round (one layout pass); this
// test states the END STATE both orders share, and the order itself is pinned
// by 'both openers open the tab BEFORE closing the view' below.
test('`Open file` leaves the view closed and the file open in the editor', () => {
  st.openCommitView(C0.hash);
  (byKey(commitRoot, `diffopen:${F1.path}`) as FakeElement).click();
  assert.equal(st.state.openCommit, null, 'the editor lives in the row the view was covering');
  assert.deepEqual(
    st.state.editor.tabs.map((t) => [t.id, t.label, t.path]),
    [[`f:${F1.path}`, F1.path.split('/').pop(), F1.path]],
  );
  assert.equal(st.editorVisible(), true);
  assert.equal(handBacks, 0, 'the keyboard belongs to the editor here, not to a terminal');
});

test('`Open file` hands the keyboard to the text it just opened', () => {
  // The button is destroyed with the screen it stood on; without the hand-over
  // `document.activeElement` is <body> and the next keystroke reaches nothing.
  st.openCommitView(C0.hash);
  (byKey(commitRoot, `diffopen:${F1.path}`) as FakeElement).click();
  const ta = byKey(editorRoot, 'etext') as FakeElement;
  assert.notEqual(ta, null, 'non-vacuity: the file really opened');
  assert.equal(dom.doc.activeElement, ta, 'the keyboard is in the file, not on <body>');
});

test('`Changes` hands the keyboard to the editor (a diff has no field to land in)', () => {
  st.openCommitView(C0.hash);
  (byKey(commitRoot, `diffchanges:${C0.hash}:${F0.path}`) as FakeElement).click();
  assert.equal(byClass(editorRoot, 'editor-text').length, 0, 'non-vacuity: nothing to type into');
  assert.equal(
    editorRoot.contains(dom.doc.activeElement),
    true,
    'so the tab chip takes the keyboard instead of <body>',
  );
  assert.equal(dom.doc.activeElement, byKey(editorRoot, `etab:d:${C0.hash}:${F0.path}`));
});

test('both openers open the tab BEFORE closing the view — one layout pass, not two', () => {
  // Closing first rebuilds every pane at full width and then shrinks them to
  // 46% a moment later: one extra dispose/attach and a full scrollback replay
  // per pane. With the tab opened first the grid is still hidden, so nothing
  // moves until the single pass that unhides and narrows it.
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'commit-view.ts'), 'utf8');
  for (const key of ['diffopen', 'diffchanges']) {
    const from = src.indexOf(`const ${key === 'diffopen' ? 'openFile' : 'changes'} = button(`);
    assert.notEqual(from, -1, `non-vacuity: the ${key} handler was found`);
    const body = src.slice(from, src.indexOf('});', from));
    assert.ok(
      body.indexOf('st.openEditorTab(') < body.indexOf('st.closeCommitView()'),
      `${key}: the tab is opened before the view closes`,
    );
    assert.ok(body.includes('onOpenEditor()'), `${key}: and the keyboard follows it`);
  }
});

test('`Changes` opens the read-only diff tab for that file in that commit', () => {
  st.openCommitView(C0.hash);
  (byKey(commitRoot, `diffchanges:${C0.hash}:${F0.path}`) as FakeElement).click();
  assert.equal(st.state.openCommit, null);
  assert.deepEqual(st.state.editor.tabs, [
    { id: `d:${C0.hash}:${F0.path}`, label: F0.path.split('/').pop(), path: F0.path, hash: C0.hash },
  ]);
});

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

test('with no tabs the editor draws nothing', () => {
  assert.equal(st.editorVisible(), false);
  assert.equal(byClass(editorRoot, 'editor-tab').length, 0);
  assert.equal(byClass(editorRoot, 'editor-text').length, 0);
});

test('a file tab: the name on the chip, the path and Save on the right, gutter and text below', () => {
  st.openEditorTab(st.editorFileId('web/src/Pane.tsx'), 'Pane.tsx', 'web/src/Pane.tsx');
  assert.deepEqual(textsOf(editorRoot, 'editor-tab-pick'), ['Pane.tsx']);
  assert.equal(textsOf(editorRoot, 'editor-path')[0], 'web/src/Pane.tsx');

  const ta = byKey(editorRoot, 'etext') as FakeElement;
  assert.equal(ta.tagName, 'TEXTAREA', 'a real field, so every browser editing key works');
  assert.equal(ta.value, MOCK.mockFileContent('web/src/Pane.tsx'));
  const gutter = byClass(editorRoot, 'editor-gutter')[0] as FakeElement;
  assert.equal(
    gutter.textContent.split('\n').length,
    ta.value.split('\n').length,
    'one number per line',
  );
  assert.equal(gutter.getAttribute('aria-hidden'), 'true');

  // Clean file: the button is a statement, and it does nothing.
  const save = byKey(editorRoot, 'esave') as FakeElement;
  assert.equal(save.textContent, 'Saved');
  assert.equal(save.disabled, true);
});

test('the editor says, quietly and once, that the content is an example', () => {
  st.openEditorTab(st.editorFileId('web/src/App.tsx'), 'App.tsx', 'web/src/App.tsx');
  assert.deepEqual(textsOf(editorRoot, 'editor-note'), [
    'Example content until the editor reads your files.',
  ]);
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'editor.ts'), 'utf8');
  assert.equal(src.split('placeholderNote(').length - 1, 2, 'one definition, one call site');
});

test('typing marks the tab dirty, grows the gutter, and does NOT rebuild the textarea', () => {
  st.openEditorTab(st.editorFileId('web/src/App.tsx'), 'App.tsx', 'web/src/App.tsx');
  const ta = byKey(editorRoot, 'etext') as FakeElement;
  assert.equal(byClass(editorRoot, 'editor-dirty').length, 0);

  ta.value = 'one\ntwo\nthree';
  dispatch(ta, 'input');
  assert.equal(st.editorDirty('f:web/src/App.tsx'), true);
  assert.equal(byClass(editorRoot, 'editor-dirty').length, 1, 'the amber dot is the whole warning');
  assert.equal((byClass(editorRoot, 'editor-gutter')[0] as FakeElement).textContent, '1\n2\n3');
  assert.equal(byKey(editorRoot, 'etext'), ta, 'the caret would jump if this were rebuilt');
  assert.equal((byKey(editorRoot, 'esave') as FakeElement).textContent, 'Save');
  assert.equal((byKey(editorRoot, 'esave') as FakeElement).disabled, false);

  // A second keystroke changes nothing structural either.
  ta.value = 'one\ntwo\nthree\nfour';
  dispatch(ta, 'input');
  assert.equal(byKey(editorRoot, 'etext'), ta);
  assert.equal((byClass(editorRoot, 'editor-gutter')[0] as FakeElement).textContent, '1\n2\n3\n4');
});

test('Save writes the text back and the button becomes a statement again', () => {
  const path = 'web/src/store.ts';
  const before = MOCK.mockFileContent(path) ?? '';
  st.openEditorTab(st.editorFileId(path), 'store.ts', path);
  const ta = byKey(editorRoot, 'etext') as FakeElement;
  ta.value = 'saved by the test\n';
  dispatch(ta, 'input');
  (byKey(editorRoot, 'esave') as FakeElement).click();

  assert.equal(st.editorDirty(`f:${path}`), false);
  assert.equal(MOCK.mockFileContent(path), 'saved by the test\n', 'it reaches the mock map');
  assert.equal((byKey(editorRoot, 'esave') as FakeElement).textContent, 'Saved');
  assert.equal(byClass(editorRoot, 'editor-dirty').length, 0);

  // A second Save with nothing to write is a no-op, not a second write.
  (byKey(editorRoot, 'esave') as FakeElement).click();
  assert.equal(MOCK.mockFileContent(path), 'saved by the test\n');

  // Re-opening the tab shows what was saved.
  st.closeEditorTab(`f:${path}`);
  st.openEditorTab(st.editorFileId(path), 'store.ts', path);
  assert.equal((byKey(editorRoot, 'etext') as FakeElement).value, 'saved by the test\n');

  MOCK.saveMockFile(path, before); // leave the module as we found it
});

test('every tab control is a real button with a name, and the × does not raise the tab', () => {
  st.openEditorTab(st.editorFileId('a/one.ts'), 'one.ts', 'a/one.ts');
  st.openEditorTab(st.editorFileId('a/two.ts'), 'two.ts', 'a/two.ts');
  const pick = byKey(editorRoot, 'etab:f:a/one.ts') as FakeElement;
  const close = byKey(editorRoot, 'eclose:f:a/two.ts') as FakeElement;
  assert.equal(pick.tagName, 'BUTTON');
  assert.equal(close.tagName, 'BUTTON');
  assert.equal(close.getAttribute('aria-label'), 'Close two.ts');
  assert.equal(pick.getAttribute('aria-pressed'), 'false');

  close.click();
  assert.deepEqual(st.state.editor.tabs.map((t) => t.id), ['f:a/one.ts']);
  assert.equal(st.state.editor.active, 'f:a/one.ts', 'closing the active tab lands on the first left');
  assert.equal(textsOf(editorRoot, 'editor-path')[0], 'a/one.ts', 'and the body followed it');
});

test('picking a tab swaps the body; closing the last one empties the editor', () => {
  st.openEditorTab(st.editorFileId('a/one.ts'), 'one.ts', 'a/one.ts');
  st.openEditorTab(st.editorFileId('a/two.ts'), 'two.ts', 'a/two.ts');
  (byKey(editorRoot, 'etab:f:a/one.ts') as FakeElement).click();
  assert.equal(st.state.editor.active, 'f:a/one.ts');
  assert.equal((byKey(editorRoot, 'etab:f:a/one.ts') as FakeElement).getAttribute('aria-pressed'), 'true');
  assert.equal(
    (byKey(editorRoot, 'etab:f:a/one.ts') as FakeElement).parentNode?.classList.contains('is-on'),
    true,
    'the active tab sits on the terminal ground',
  );

  (byKey(editorRoot, 'eclose:f:a/one.ts') as FakeElement).click();
  (byKey(editorRoot, 'eclose:f:a/two.ts') as FakeElement).click();
  assert.equal(st.editorVisible(), false);
  assert.equal(byClass(editorRoot, 'editor-tab').length, 0);
  assert.equal(byClass(editorRoot, 'editor-text').length, 0, 'no stale body behind a hidden column');
});

test('closing a dirty tab drops its unsaved text (A6 has no confirm — part B4 does)', () => {
  const path = 'web/src/TabStrip.tsx';
  st.openEditorTab(st.editorFileId(path), 'TabStrip.tsx', path);
  const ta = byKey(editorRoot, 'etext') as FakeElement;
  ta.value = 'typed but never saved\n';
  dispatch(ta, 'input');
  assert.equal(st.state.edits.size, 1);
  (byKey(editorRoot, `eclose:f:${path}`) as FakeElement).click();
  assert.equal(st.state.edits.size, 0, 'the edit goes with the tab it belonged to');

  // The gap is written down where the next part will find it, and it names all
  // FOUR doors typed text falls out of — a confirm on the tab alone would make
  // the other three read as bugs.
  const src = readFileSync(join(here, '..', 'web', 'src', 'state.ts'), 'utf8');
  assert.match(src, /KNOWN GAP, part B4[\s\S]*unsaved changes/);
  const gap = src.slice(src.indexOf('KNOWN GAP, part B4'), src.indexOf('export function closeEditorTab'));
  for (const door of ['reload', 'clos', 'grace']) {
    assert.ok(gap.includes(door), `the known gap names the ${door} door too`);
  }
});

test('a diff tab is read-only: diff rows, the commit it belongs to, and no field at all', () => {
  st.openEditorTab(`d:${C0.hash}:${F0.path}`, 'ws.ts', F0.path, C0.hash);
  assert.equal(byClass(editorRoot, 'editor-text').length, 0, 'a diff cannot be typed into');
  assert.equal(byClass(editorRoot, 'editor-gutter').length, 0);
  assert.equal(byKey(editorRoot, 'esave'), null, 'and there is nothing to save');
  assert.equal(textsOf(editorRoot, 'editor-meta')[0], `Changes in ${C0.hash}`);
  assert.ok(byClass(editorRoot, 'diff-line').length > 3, 'it renders the same rows the view does');
});

test('an open commit view hides the editor, and closing it brings the editor back', () => {
  st.openEditorTab(st.editorFileId('a/one.ts'), 'one.ts', 'a/one.ts');
  assert.equal(st.editorVisible(), true);
  st.openCommitView(C0.hash);
  assert.equal(st.editorVisible(), false, 'the two never share the pane area');
  st.closeCommitView();
  assert.equal(st.editorVisible(), true);
  assert.equal(textsOf(editorRoot, 'editor-path')[0], 'a/one.ts', 'with the same tab up');
});

// ---------------------------------------------------------------------------
// The shell wiring (web/src/main.ts) and the pane-area guard (ui/panes.ts)
// ---------------------------------------------------------------------------

const MAIN = readFileSync(join(here, '..', 'web', 'src', 'main.ts'), 'utf8');
const PANES = readFileSync(join(here, '..', 'web', 'src', 'ui', 'panes.ts'), 'utf8');

test('main.ts builds both screens as flex siblings of the grid, in the v3 order', () => {
  assert.ok(MAIN.includes('function buildShell'), 'non-vacuity: main.ts still builds the shell');
  assert.match(MAIN, /const editor = initEditor\(editorAside\);/);
  // Two hand-overs: back to the terminal, or INTO the editor a file was just
  // opened in (the button that was clicked goes away with the screen).
  assert.match(
    MAIN,
    /const commitView = initCommitView\(commitAside, requestTerminalFocus, \(\) => editor\.focusBody\(\)\);/,
  );
  assert.match(
    MAIN,
    /main\.append\(projAside, filesAside, commitAside, editorAside, grid, sessAside\);/,
    'the editor stands BEFORE the panes (v3 DOM order), both inside the middle row',
  );
});

test('ONE owner decides who occupies the pane area, and it runs BEFORE the panes do', () => {
  // Order matters: when a commit view closes, the grid must already be visible
  // by the time ui/panes.ts is asked to render, or the rebuild it refuses
  // while hidden would be refused for good.
  const layout = MAIN.indexOf('st.subscribe(applyScreenLayout);');
  const panes = MAIN.indexOf('initPanes(grid,');
  assert.ok(layout !== -1 && panes !== -1, 'non-vacuity: both wirings were found');
  assert.ok(layout < panes, 'the layout owner subscribes first');

  const body = MAIN.slice(MAIN.indexOf('function applyScreenLayout'), layout);
  assert.match(body, /commitAside\.hidden = !commitOpen;/);
  assert.match(body, /editorAside\.hidden = !st\.editorVisible\(\);/);
  assert.match(body, /grid\.classList\.toggle\('is-narrow', st\.editorVisible\(\)\);/);
  assert.match(body, /grid\.hidden = commitOpen;/);
  assert.match(body, /if \(wasHidden && !grid\.hidden\) refreshPaneArea\(\);/);
  assert.match(MAIN, /applyScreenLayout\(\);\n\s*updateChrome\(\);/, 'and once at boot');
});

test('the panes refuse to render at all against a hidden grid — the WebGL trap', () => {
  // xterm must open on an attached, MEASURABLE node; constructing a
  // TerminalView on a `display: none` grid can permanently downgrade the WebGL
  // renderer and leaves it at xterm's default 80x24, which `connect()` then
  // sends to a PTY that is not. A rebuild is not the only construction site:
  // `reconcileSlot()` builds one too when a slot's session changes (a swap
  // chord, an exited pane's relaunch resolving), so the guard stands at the TOP
  // of `render()` — one copy, before anything is read or touched.
  assert.match(PANES, /function gridHidden\(\): boolean \{[\s\S]*grid\.hidden !== false;/);
  assert.match(PANES, /export function refreshPaneArea\(\): void \{\s*render\(\);/, 'the replay is the first thing refreshPaneArea does');
  const render = PANES.slice(PANES.indexOf('function render(): void'), PANES.indexOf('function renderEmpty'));
  assert.ok(render.length > 200 && render.length < 2000, 'non-vacuity: the render function was found');
  assert.equal(render.split('if (gridHidden()) return;').length - 1, 1, 'exactly one guard');
  assert.match(
    render,
    /function render\(\): void \{(\s*\/\/[^\n]*\n)*\s*if \(gridHidden\(\)\) return;/,
    'and it is the FIRST statement, so the reconcile path is covered too',
  );
  assert.ok(
    render.indexOf('if (gridHidden()) return;') < render.indexOf('st.activeView()'),
    'nothing is read before the guard',
  );
  assert.match(
    readFileSync(join(here, '..', 'web', 'src', 'styles', 'app.css'), 'utf8'),
    /\[hidden\] \{\s*display: none !important;/,
    'the hidden flag has to be real for the guard to mean anything',
  );
});

test('the grid coming back on screen acks the focused pane\'s attention itself — not the next window activation', () => {
  // applyFocus() early-returns on an unchanged focus key, so after Back the
  // badge raised under the view stayed until the next window focus (verify
  // run 2026-09-13). refreshPaneArea() takes that ack, gated on a visible
  // grid AND a focused window.
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'panes.ts'), 'utf8');
  const fn = /export function refreshPaneArea\(\): void \{[\s\S]*?\n\}/.exec(src);
  assert.ok(fn, 'refreshPaneArea found');
  assert.match(fn[0], /render\(\);/);
  assert.match(fn[0], /if \(gridHidden\(\) \|\| !document\.hasFocus\(\)\) return;/, 'gated on visible grid + focused window');
  assert.match(fn[0], /clearAttentionIfPending\(s\)/, 'acks the focused slot');
  assert.ok(fn[0].indexOf('render();') < fn[0].indexOf('clearAttentionIfPending'), 'render first, ack after');
});

test('a hidden grid acknowledges NO attention badge on a live BEL or an info frame either (verify-terminal A6 b)', () => {
  // The window-focus gate (R2) was not the path a live BEL takes: the
  // onAttention and onInfo acks in slotEvents() decided on "focused pane +
  // document has focus" alone, so a BEL under the commit view was seen 1 ms
  // after it was raised (server.log: attention raised → seen). Both
  // predicates must also ask whether the grid is on screen.
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'panes.ts'), 'utf8');
  const onInfo = /onInfo: \(info: SessionInfo\) => \{[\s\S]*?clearAttentionIfPending\(s\);/.exec(src);
  assert.ok(onInfo, 'onInfo ack block found');
  assert.match(onInfo[0], /document\.hasFocus\(\) &&\s*!gridHidden\(\)/, 'info-frame ack is gated on a visible grid');
  const onAttn = /onAttention: \(\) => \{[\s\S]*?ackSeen\(s, sessionId\);/.exec(src);
  assert.ok(onAttn, 'onAttention ack block found');
  assert.match(onAttn[0], /document\.hasFocus\(\) &&\s*!gridHidden\(\)/, 'live BEL ack is gated on a visible grid');
});

test('a hidden grid acknowledges NO attention badge on window refocus (scope review R2)', () => {
  // Scenario: a session BELs while the commit view covers the panes, the tab
  // strip shows "Needs you", the user alt-tabs away and back. Without the
  // guard the refocus listener acks a terminal that was never on screen and
  // the badge is gone. The deferred applyFocus() on return acks it honestly.
  const listener = PANES.slice(
    PANES.indexOf("window.addEventListener('focus'"),
    PANES.indexOf('function gridHidden'),
  );
  assert.ok(listener.length > 100, 'non-vacuity: the refocus listener was found');
  assert.match(listener, /if \(gridHidden\(\)\) return;/, 'the hidden grid stands down');
  assert.ok(
    listener.indexOf('if (gridHidden()) return;') < listener.indexOf('clearAttentionIfPending'),
    'and it stands BEFORE anything is acknowledged',
  );
});

test('a hidden grid is never MEASURED for a new PTY either (scope review R3)', () => {
  // `New session` (top bar, Ctrl+Alt+T) and the drawer's resume stay reachable
  // while the commit view is up; proposeDims() on a `display: none` terminal
  // falls back to 80x24 and the first screenful lands wrapped in the
  // scrollback, which the later attach reconcile cannot repair.
  const dims = PANES.slice(
    PANES.indexOf('export function focusedPaneDims'),
    PANES.indexOf('function render(): void'),
  );
  assert.ok(dims.length > 100 && dims.length < 1200, 'non-vacuity: the function was found');
  assert.match(dims, /if \(gridHidden\(\)\) \{/);
  assert.match(dims, /st\.state\.sessions\.get\(id\)/, 'the focused session states its own size');
  assert.match(dims, /info\.status === 'running'/, 'and only a running one is believed');
  assert.match(dims, /return lastGoodDims \?\? \{ cols: 80, rows: 24 \};/, 'then the last good dims');
  assert.ok(
    dims.indexOf('if (gridHidden()) {') < dims.indexOf('proposeDims()'),
    'nothing is measured before the guard',
  );
  // And `lastGoodDims` is fed from the one place a view reports its size.
  assert.match(PANES, /onDims: \(cols, rows\) => \{\s*lastGoodDims = \{ cols, rows \};/);
});

test('the grid gives up 46% of the row to the editor, in CSS, not in JS pixels', () => {
  const css = readFileSync(join(here, '..', 'web', 'src', 'styles', 'app.css'), 'utf8');
  assert.match(css, /\.grid\.is-narrow \{\s*flex: 0 0 46%;/);
});

test('Escape closes the commit view, ranked under the dialogs and over the drawers', () => {
  const from = MAIN.indexOf("e.key === 'Escape'");
  assert.notEqual(from, -1, 'non-vacuity: the Escape branch was found');
  const branch = MAIN.slice(from, MAIN.indexOf('// ---- reliability'));
  const arms = branch.split('} else if');
  const commitArm = arms.findIndex((a) => a.includes('st.closeCommitView();'));
  const drawerArm = arms.findIndex((a) => a.includes('st.closeDrawer();'));
  const launchArm = arms.findIndex((a) => a.includes('closeLaunchDialog();'));
  assert.ok(commitArm !== -1 && drawerArm !== -1 && launchArm !== -1, 'non-vacuity: three arms found');
  assert.ok(launchArm < commitArm, 'every dialog outranks the commit view');
  assert.ok(commitArm < drawerArm, 'and the commit view outranks the drawer/panel arms');
  assert.match(arms[commitArm] as string, /!isEditable\(e\.target\)/, 'a field keeps its own Escape');
  assert.match(arms[commitArm] as string, /st\.closeCommitView\(\);[\s\S]*requestTerminalFocus\(\);/);
});

test('the pane chords stand down while the commit view covers the panes', () => {
  // Ctrl+Alt+Arrow, Ctrl+Alt+Shift+Arrow and Ctrl+Alt+1..9 move focus between,
  // swap sessions inside, and switch panes NOBODY CAN SEE while the view is up.
  const from = MAIN.indexOf("if (e.ctrlKey && e.altKey");
  assert.notEqual(from, -1, 'non-vacuity: the chord block was found');
  const block = MAIN.slice(from, MAIN.indexOf("if (e.key === '?'", from));
  assert.match(block, /const paneChord =/);
  assert.match(block, /if \(paneChord && st\.state\.openCommit !== null\) return;/);
  // It has to stand BEFORE the three calls it guards, or it guards nothing.
  const guard = block.indexOf('if (paneChord && st.state.openCommit !== null) return;');
  for (const call of ['st.moveFocus(', 'st.moveSession(', 'st.setActiveViewIndex(']) {
    const at = block.indexOf(call);
    assert.notEqual(at, -1, `non-vacuity: ${call} is in this block`);
    assert.ok(guard < at, `${call} runs after the guard`);
  }
  // And the chords that open something of their own are NOT swallowed.
  assert.ok(block.indexOf('openLaunchDialog();') > guard);
  assert.match(block, /k === 't' \|\| k === 'T'/);
});

test('`paneChord` names EVERY chord that moves a pane, the digits included', () => {
  // Gate addition: "the guard stands before the calls" stays true if the guard
  // covers only the arrows, and Ctrl+Alt+1..9 would still switch to a tab
  // nobody can see. The SET itself is the contract.
  const at = MAIN.indexOf('const paneChord =');
  assert.notEqual(at, -1, 'non-vacuity: the set was found');
  const expr = MAIN.slice(at, MAIN.indexOf(';', at));
  for (const key of ["k === 'ArrowLeft'", "k === 'ArrowRight'", "k === 'ArrowUp'", "k === 'ArrowDown'"]) {
    assert.ok(expr.includes(key), `${key} is a pane chord`);
  }
  assert.match(expr, /k\.length === 1 && k >= '1' && k <= '9'/, 'and so is Ctrl+Alt+1..9');
  // The three handlers this set exists for are exactly the three pane moves —
  // read from the branches that follow, so a fourth one cannot be forgotten.
  const block = MAIN.slice(
    MAIN.indexOf('if (e.ctrlKey && e.altKey'),
    MAIN.indexOf("if (e.key === '?'", at),
  );
  const guarded = ['st.moveFocus(', 'st.moveSession(', 'st.setActiveViewIndex('];
  for (const call of guarded) {
    const keyFor = call === 'st.setActiveViewIndex(' ? "k >= '1' && k <= '9'" : "k === 'ArrowLeft'";
    assert.ok(block.includes(keyFor), `${call} is reached by a key the set names`);
  }
});

test('neither screen is persisted: the UI bag writes the same keys it did in A5', () => {
  const src = readFileSync(join(here, '..', 'web', 'src', 'state.ts'), 'utf8');
  const save = src.slice(src.indexOf('function saveUi'), src.indexOf('function loadUi'));
  assert.ok(save.length > 200, 'non-vacuity: saveUi was found');
  for (const key of ['openCommit', 'editor', 'edits', 'commitCollapsed']) {
    assert.equal(save.includes(key), false, `${key} is a place the user stands, not a preference`);
  }
});

// ---------------------------------------------------------------------------
// Gate additions (test-engineer, A6): the state contract behind the two
// screens — which change notifies, what a re-open keeps, whose edit is dropped,
// and the truth table that decides whether the editor column exists at all.
// ---------------------------------------------------------------------------

/** Everything `notify()` emitted since `kinds.length = 0`. */
const kinds: string[] = [];
st.subscribe((k) => {
  kinds.push(k);
});

test('editorVisible: tabs AND no commit — the full truth table', () => {
  assert.equal(st.editorVisible(), false, 'no tabs, no commit');
  st.openCommitView(C0.hash);
  assert.equal(st.editorVisible(), false, 'no tabs, a commit');
  st.openEditorTab(st.editorFileId('a/one.ts'), 'one.ts', 'a/one.ts');
  assert.equal(st.editorVisible(), false, 'tabs, but the commit covers the row');
  st.closeCommitView();
  assert.equal(st.editorVisible(), true, 'tabs, no commit');
  st.closeEditorTab('f:a/one.ts');
  assert.equal(st.editorVisible(), false, 'the last tab took the column with it');
});

test('every pane-area change notifies `screen`, and a keystroke notifies NOTHING', () => {
  // The kind is what main.ts's one layout owner listens on; a change that
  // stayed silent would leave the grid hidden with nothing over it.
  const only = (fn: () => void): string[] => {
    kinds.length = 0;
    fn();
    return kinds;
  };
  assert.deepEqual(only(() => st.openCommitView(C0.hash)), ['screen']);
  assert.deepEqual(only(() => st.toggleCommitFile(C0.hash, F0.path)), ['screen']);
  assert.deepEqual(only(() => st.closeCommitView()), ['screen']);
  assert.deepEqual(only(() => st.openEditorTab('f:a/one.ts', 'one.ts', 'a/one.ts')), ['screen']);
  assert.deepEqual(only(() => st.openEditorTab('f:a/two.ts', 'two.ts', 'a/two.ts')), ['screen']);
  assert.deepEqual(only(() => st.setEditorActive('f:a/one.ts')), ['screen']);
  assert.deepEqual(only(() => st.setEditorActive('f:a/one.ts')), [], 'raising the raised tab is a no-op');
  assert.deepEqual(only(() => st.setEditorActive('f:ghost.ts')), [], 'and an unknown id changes nothing');
  // A keystroke must not notify: a chrome rebuild per character would take the
  // caret with it (ui/editor.ts updates the gutter in place instead).
  assert.deepEqual(only(() => st.setEdit('f:a/one.ts', 'typed')), []);
  assert.deepEqual(only(() => st.saveEdit('f:a/one.ts')), ['screen'], 'saving is a chrome change');
  assert.deepEqual(only(() => st.saveEdit('f:a/one.ts')), [], 'saving a clean tab changes nothing');
  assert.deepEqual(only(() => st.closeEditorTab('f:a/one.ts')), ['screen']);
  assert.deepEqual(only(() => st.closeEditorTab('f:a/one.ts')), [], 'closing a closed tab is a no-op');
});

test('re-opening the SAME commit keeps the folds; a different one starts fresh', () => {
  st.openCommitView(C0.hash);
  st.toggleCommitFile(C0.hash, F0.path);
  assert.equal(st.state.commitCollapsed.size, 1);

  kinds.length = 0;
  st.openCommitView(C0.hash);
  assert.deepEqual(kinds, [], 'opening what is already open is not a change');
  assert.equal(st.commitFileCollapsed(C0.hash, F0.path), true, 'and it does not unfold the user');
  assert.equal(byClass(commitRoot, 'diff-block').length, C0.files.length);

  const second = MOCK.MOCK_COMMITS[1] as (typeof MOCK.MOCK_COMMITS)[number];
  st.openCommitView(second.hash);
  assert.equal(st.state.commitCollapsed.size, 0, 'another commit inherits no fold');
});

test('closing the commit view empties the fold set — a closed view remembers nothing', () => {
  st.openCommitView(C0.hash);
  st.toggleCommitFile(C0.hash, F0.path);
  st.toggleCommitFile(C0.hash, F1.path);
  assert.equal(st.state.commitCollapsed.size, 2);
  st.closeCommitView();
  assert.equal(st.state.commitCollapsed.size, 0, 'the set cannot grow across visits');
  kinds.length = 0;
  st.closeCommitView();
  assert.deepEqual(kinds, [], 'closing a closed view is a no-op');
  // And the next visit to the SAME commit is fully expanded again.
  st.openCommitView(C0.hash);
  assert.equal(st.commitFileCollapsed(C0.hash, F0.path), false);
});

test('closing a tab drops ONLY its own unsaved text', () => {
  st.openEditorTab(st.editorFileId('a/one.ts'), 'one.ts', 'a/one.ts');
  st.openEditorTab(st.editorFileId('a/two.ts'), 'two.ts', 'a/two.ts');
  st.setEdit('f:a/one.ts', 'one typed');
  st.setEdit('f:a/two.ts', 'two typed');

  st.closeEditorTab('f:a/two.ts');
  assert.equal(st.editorDirty('f:a/two.ts'), false, 'the closed tab took its edit with it');
  assert.equal(st.editorDirty('f:a/one.ts'), true, 'and left the other one alone');
  assert.equal(st.state.edits.get('f:a/one.ts'), 'one typed');
});

test('unsaved text survives a trip through another tab — the edit beats the mock', () => {
  const path = 'web/src/Pane.tsx';
  st.openEditorTab(st.editorFileId(path), 'Pane.tsx', path);
  const ta = byKey(editorRoot, 'etext') as FakeElement;
  ta.value = 'half-typed, never saved\n';
  dispatch(ta, 'input');

  st.openEditorTab(st.editorFileId('web/src/App.tsx'), 'App.tsx', 'web/src/App.tsx');
  assert.equal(
    (byKey(editorRoot, 'etext') as FakeElement).value,
    MOCK.mockFileContent('web/src/App.tsx'),
    'the other tab shows its own text',
  );
  st.setEditorActive(`f:${path}`);
  assert.equal(
    (byKey(editorRoot, 'etext') as FakeElement).value,
    'half-typed, never saved\n',
    'coming back shows what was typed, not what the mock still says',
  );
  assert.equal((MOCK.mockFileContent(path) ?? '').startsWith('half-typed'), false, 'nothing was written');
  assert.equal((byKey(editorRoot, 'esave') as FakeElement).textContent, 'Save');
  assert.equal(byClass(editorRoot, 'editor-dirty').length, 1, 'and the dot came back with it');
});

test('Save writes the ACTIVE tab and nothing else', () => {
  const a = 'web/src/store.ts';
  const b = 'server/ws.ts';
  const beforeA = MOCK.mockFileContent(a) ?? '';
  const beforeB = MOCK.mockFileContent(b) ?? '';
  st.openEditorTab(st.editorFileId(a), 'store.ts', a);
  st.openEditorTab(st.editorFileId(b), 'ws.ts', b);
  st.setEdit(st.editorFileId(a), 'A was typed\n');
  const ta = byKey(editorRoot, 'etext') as FakeElement;
  ta.value = 'B was typed\n';
  dispatch(ta, 'input');

  (byKey(editorRoot, 'esave') as FakeElement).click();
  assert.equal(MOCK.mockFileContent(b), 'B was typed\n', 'the tab that was up is the tab that was written');
  assert.equal(MOCK.mockFileContent(a), beforeA, 'the other tab is untouched on disk');
  assert.equal(st.editorDirty(st.editorFileId(a)), true, 'and it is still dirty');

  MOCK.saveMockFile(a, beforeA);
  MOCK.saveMockFile(b, beforeB);
});

test('a diff tab is never dirty and never saveable, whatever is in the edit map', () => {
  const id = `d:${C0.hash}:${F0.path}`;
  st.openEditorTab(id, 'ws.ts', F0.path, C0.hash);
  assert.equal(byKey(editorRoot, 'esave'), null);
  assert.equal(byClass(editorRoot, 'editor-text').length, 0);
  // The diff body is the commit view's own renderer, so the two can never
  // disagree about what changed in that file.
  const rows = byClass(editorRoot, 'diff-line').length;
  st.closeEditorTab(id);
  st.openCommitView(C0.hash);
  const inBlock = byClass(byClass(commitRoot, 'diff-block')[0] as FakeElement, 'diff-line').length;
  assert.equal(rows, inBlock, 'one renderer, one answer');
});

test('the keyboard lands on the way out when a commit opens, and stays put while folding', () => {
  // The screen changed under the user; the focus has to go somewhere it can
  // leave from, or the keyboard falls to <body> (the rule the drawers follow).
  st.openCommitView(C0.hash);
  assert.equal(dom.doc.activeElement, byKey(commitRoot, 'commit:back'), 'focus lands on the way out');

  // And a fold rebuilds the whole body, so the control that was pressed has to
  // be handed the keyboard back by its `data-k`, not lost with its node.
  const toggle = byKey(commitRoot, `diff:${C0.hash}:${F0.path}`) as FakeElement;
  toggle.focus();
  toggle.click();
  const after = byKey(commitRoot, `diff:${C0.hash}:${F0.path}`) as FakeElement;
  assert.notEqual(after, toggle, 'non-vacuity: the block really was rebuilt');
  assert.equal(dom.doc.activeElement, after, 'the same control keeps the keyboard');

  // Re-rendering an unchanged view does not yank the focus a second time.
  const focused = dom.doc.activeElement;
  view.render();
  assert.equal(dom.doc.activeElement, focused);
});

test('the editor tab strip hands the keyboard back to the control that was pressed', () => {
  st.openEditorTab(st.editorFileId('a/one.ts'), 'one.ts', 'a/one.ts');
  st.openEditorTab(st.editorFileId('a/two.ts'), 'two.ts', 'a/two.ts');
  const pick = byKey(editorRoot, 'etab:f:a/one.ts') as FakeElement;
  pick.focus();
  pick.click();
  const after = byKey(editorRoot, 'etab:f:a/one.ts') as FakeElement;
  assert.notEqual(after, pick, 'non-vacuity: the strip really was rebuilt');
  assert.equal(dom.doc.activeElement, after);
});

test('every commit the list can open really draws — no hash opens a blank screen', () => {
  // The panel opens a commit BY HASH and main.ts hides the pane grid on
  // `openCommit !== null`; a hash the view cannot resolve would leave an empty
  // middle row with no control in it. Every hash the Commits list offers must
  // therefore render a body.
  assert.ok(MOCK.MOCK_COMMITS.length >= 5, 'non-vacuity: there are commits to open');
  for (const c of MOCK.MOCK_COMMITS) {
    st.openCommitView(c.hash);
    assert.equal(textsOf(commitRoot, 'commit-vmsg')[0], c.message, c.hash);
    assert.equal(byClass(commitRoot, 'diff-block').length, c.files.length, c.hash);
    assert.notEqual(byKey(commitRoot, 'commit:back'), null, `${c.hash} has a way out`);
    st.closeCommitView();
  }
});

test('a diff is asked for BY COMMIT: the renderer takes the hash, not only the path', () => {
  // `server/ws.ts` is in two of the mock's commits, and B3's
  // `git show <hash> -- <path>` answers differently for each. The mock has one
  // example diff per path until then — the SIGNATURE is what B3 fills in, so no
  // caller changes when it does.
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'commit-view.ts'), 'utf8');
  assert.match(src, /export function diffBody\(hash: string, path: string\): HTMLElement/);
  assert.match(src, /diffBody\(c\.hash, f\.path\)/, 'the view passes the commit it draws');
  const ed = readFileSync(join(here, '..', 'web', 'src', 'ui', 'editor.ts'), 'utf8');
  assert.match(ed, /diffBody\(active\.hash \?\? '', active\.path\)/, 'and so does the diff tab');

  const shared = MOCK.MOCK_COMMITS.filter((c) => c.files.some((f) => f.path === 'server/ws.ts'));
  assert.ok(shared.length >= 2, `non-vacuity: one path in ${shared.length} commits`);
});

test('every file block draws the rows its own header counts — renderer against header, not model against model', () => {
  // Round-2 regression: the mock counted its numbers with a per-path seed while
  // the renderer drew the unseeded diff, so all 11 blocks stated `+6 -1` over
  // rows that summed to `+4 -2`. The model tests compared model to model and
  // passed. This one counts what diffBody() actually puts on screen.
  let blocks = 0;
  for (const c of MOCK.MOCK_COMMITS) {
    st.openCommitView(c.hash);
    for (const f of c.files) {
      const block = byClass(commitRoot, 'diff-block').find(
        (b) => textsOf(b, 'diff-path')[0] === f.path,
      ) as FakeElement | undefined;
      assert.ok(block, `${c.hash} ${f.path} has a block`);
      const kinds = byClass(block, 'diff-line').map((r) => r.dataset['kind']);
      const add = kinds.filter((k) => k === 'add').length;
      const del = kinds.filter((k) => k === 'del').length;
      assert.deepEqual({ add, del }, { add: f.add, del: f.del }, `${c.hash} ${f.path}`);
      blocks++;
    }
    st.closeCommitView();
  }
  assert.ok(blocks >= 10, `non-vacuity: ${blocks} blocks counted`);
});

test('a hash the view cannot resolve says so AND keeps the way out', () => {
  // The pane grid is hidden on `openCommit !== null`, so an unresolvable hash
  // (B3: a rewritten history, a pruned commit) must never leave an empty middle
  // row with no control in it.
  st.openCommitView('deadbee');
  assert.equal(byClass(commitRoot, 'commit-vmsg').length, 0, 'nothing is invented');
  assert.deepEqual(textsOf(commitRoot, 'commit-missing'), ['This commit is not available.']);
  const back = byKey(commitRoot, 'commit:back') as FakeElement;
  assert.notEqual(back, null, 'the exit is the point of this state');
  assert.equal(dom.doc.activeElement, back, 'and it holds the keyboard');
  back.click();
  assert.equal(st.state.openCommit, null);
  assert.equal(handBacks, 1);
  assert.equal(byClass(commitRoot, 'commit-missing').length, 0, 'and the screen is empty again');
});

test('each file block carries the id the Files panel row points `aria-controls` at', () => {
  st.openCommitView(C0.hash);
  const blocks = byClass(commitRoot, 'diff-block');
  assert.equal(blocks.length, C0.files.length, 'non-vacuity');
  const ids = blocks.map((b) => b.id);
  assert.deepEqual(
    ids,
    C0.files.map((f) => MODEL.blockDomId(C0.hash, f.path)),
    'one id per file, derived from the same key the fold is remembered by',
  );
  assert.equal(new Set(ids).size, ids.length, 'and they are unique');
  for (const id of ids) assert.match(id, /^[A-Za-z][A-Za-z0-9_-]*$/, `${id} is a valid id`);
});

test('a path with no example text draws ONE note — never a numbered diff row', () => {
  // `mockFileContent` answers null for a path it knows nothing about; a
  // sentence rendered as a `+` line would read as content of that file.
  const path = 'server/nothing-here.ts';
  assert.equal(MOCK.mockFileContent(path), null, 'non-vacuity: the mock really has no text');
  st.openEditorTab(`d:${C0.hash}:${path}`, 'nothing-here.ts', path, C0.hash);
  assert.equal(byClass(editorRoot, 'diff-line').length, 0, 'not one diff row');
  assert.deepEqual(textsOf(editorRoot, 'diff-note'), ['There is no example content for this file yet.']);
});

test('a FILE with no example text offers a note instead of a field, and no Save', () => {
  const path = 'server/nothing-here.ts';
  st.openEditorTab(st.editorFileId(path), 'nothing-here.ts', path);
  assert.equal(byClass(editorRoot, 'editor-text').length, 0, 'nothing to type into');
  assert.equal(byClass(editorRoot, 'editor-gutter').length, 0, 'and no numbers beside it');
  assert.equal(byKey(editorRoot, 'esave'), null, 'a Save that writes a sentence would be a lie');
  assert.deepEqual(textsOf(editorRoot, 'editor-empty'), [
    'There is no example content for this file yet.',
  ]);
  // The tab is still a real tab: it opens, it is named, and it closes.
  assert.deepEqual(textsOf(editorRoot, 'editor-path'), [path]);
  (byKey(editorRoot, `eclose:f:${path}`) as FakeElement).click();
  assert.equal(st.editorVisible(), false);
});

test('code surfaces draw plain glyphs — ONE ligature rule, named as a design-system rule', () => {
  // The terminal renders no ligatures; an editor that prints `===` as one long
  // glyph shows code the pane beside it cannot show, and hides the difference
  // between `==` and `===`.
  const css = readFileSync(join(here, '..', 'web', 'src', 'styles', 'app.css'), 'utf8');
  const at = css.indexOf('font-variant-ligatures: none');
  assert.notEqual(at, -1, 'the rule exists');
  assert.equal(
    css.split('font-variant-ligatures').length - 1,
    1,
    'ONE shared rule, not a copy per surface',
  );
  const rule = css.slice(css.lastIndexOf('/*', at), css.indexOf('}', at));
  for (const sel of [
    '.editor-text',
    '.editor-gutter',
    '.editor-path',
    '.diff-t',
    '.diff-path',
    '.commit-fpath',
  ]) {
    assert.ok(rule.includes(`${sel},`) || rule.includes(`${sel} {`), `${sel} is in the rule`);
  }
  assert.match(rule, /DESIGN-SYSTEM RULE[\s\S]*like the terminal/, 'and it says what it is');
});

test('every class the two screens render has a rule in app.css (a typo is an invisible block)', () => {
  // Both screens, in every state they have: an open commit, a file tab and a
  // read-only diff tab.
  const seen = new Set<string>();
  const collect = (root: FakeElement): void => {
    for (const el of [root, ...descendants(root)]) {
      for (const c of el.className.split(/\s+/)) if (c !== '') seen.add(c);
    }
  };
  st.openCommitView(C0.hash);
  collect(commitRoot);
  st.toggleCommitFile(C0.hash, F0.path);
  collect(commitRoot);
  st.closeCommitView();
  st.openEditorTab(st.editorFileId('web/src/Pane.tsx'), 'Pane.tsx', 'web/src/Pane.tsx');
  collect(editorRoot);
  const ta = byKey(editorRoot, 'etext') as FakeElement;
  ta.value = 'dirty\n';
  dispatch(ta, 'input');
  collect(editorRoot);
  st.openEditorTab(`d:${C0.hash}:${F0.path}`, 'ws.ts', F0.path, C0.hash);
  collect(editorRoot);

  assert.ok(seen.size > 25, `non-vacuity: ${seen.size} classes were collected`);
  const css = readFileSync(join(here, '..', 'web', 'src', 'styles', 'app.css'), 'utf8');
  const missing = [...seen].filter((c) => !css.includes(`.${c}`)).sort();
  assert.deepEqual(missing, [], `classes with no rule in app.css: ${missing.join(', ')}`);
});
