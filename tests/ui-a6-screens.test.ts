/**
 * The commit view (Nocturne A6, re-pointed by A10) driven through the REAL
 * `web/src/ui/commit-view.ts` on the shared DOM double, against the REAL
 * `web/src/state.ts`, `ui/util.ts`, `ui/icons.ts`, the A6 models and
 * `ui/files-mock.ts`.
 *
 * WHY, next to `ui-commit-model.test.ts`. That file pins the arithmetic; this
 * one pins the PLUMBING, which is where the silent regressions live: a back
 * button that closes nothing, a file block whose fold state disagrees with the
 * Files panel row that folded it, an `Open file` that opens nothing, a screen
 * that leaves the keyboard on <body>. Every one of those keeps the model tests
 * green.
 *
 * THE EDITOR HALF OF THIS FILE IS GONE WITH THE EDITOR COLUMN (part A10): a
 * file is a PANE now, so its body is pinned in `tests/ui-file-pane.test.ts`,
 * its chrome in `tests/ui-pane-a10.test.ts` and its tab chip in
 * `tests/ui-tabs-a10.test.ts`.
 *
 * Plus the shell wiring in `web/src/main.ts` and the pane-area guard in
 * `web/src/ui/panes.ts`, read from the source — main.ts's import graph reaches
 * @xterm/xterm, a browser bundle. Each assertion is written so that deleting
 * the wiring it names fails it.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, colour, a pane really reflowing a PTY, focus policy, scrolling,
 * screen-reader output.
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

interface Slot {
  kind: 'session' | 'file' | 'diff';
  id?: string;
  path?: string;
  hash?: string;
}
interface View {
  id: string;
  root: { kind: 'home' } | { kind: 'project'; id: string } | null;
  slots: Slot[];
  focused: number;
}
interface StateModule {
  state: {
    openCommit: string | null;
    commitCollapsed: Set<string>;
    edits: Map<string, string>;
    views: View[];
    activeViewId: string;
  };
  subscribe(fn: (kind: string) => void): void;
  openCommitView(hash: string): void;
  closeCommitView(): void;
  toggleCommitFile(hash: string, path: string): void;
  commitFileCollapsed(hash: string, path: string): boolean;
  activeView(): View | null;
  openFile(root: { kind: 'home' }, path: string, label: string): string;
  openDiff(root: { kind: 'home' }, hash: string, path: string): string;
  closeSlot(viewId: string, index: number): boolean;
  editorFileId(path: string): string;
  editorDirty(id: string | null): boolean;
  setEdit(id: string, text: string): void;
  saveEdit(id: string): string | null;
}

const st = (await import(new URL('../web/src/state.ts', import.meta.url).href)) as StateModule;
const CV = (await import(new URL('../web/src/ui/commit-view.ts', import.meta.url).href)) as {
  initCommitView(
    host: unknown,
    onLeaveScreen: () => void,
    onOpenPane: () => void,
  ): { render(): void };
  /** The one diff renderer, shared with a diff PANE (ui/file-pane.ts). */
  diffBody(hash: string, path: string): FakeElement;
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
dom.body.append(commitHost);

/** The view leaves in two directions; main.ts points both at the pane area. */
let handBacks = 0;
let paneHandovers = 0;
const view = CV.initCommitView(
  commitHost,
  () => {
    handBacks += 1;
  },
  () => {
    paneHandovers += 1;
  },
);

/** The shell's own dispatch: the screen re-renders on every change. */
st.subscribe(() => {
  view.render();
});

const commitRoot = commitHost.children[0] as FakeElement;

beforeEach(() => {
  st.state.openCommit = null;
  st.state.commitCollapsed = new Set();
  st.state.edits = new Map();
  st.state.views = [];
  st.state.activeViewId = '';
  handBacks = 0;
  paneHandovers = 0;
  dom.doc.activeElement = dom.body;
  view.render();
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

// The ORDER is open-then-close (one layout pass); this test states the END
// STATE both orders share, and the order itself is pinned by 'both openers
// open the pane BEFORE closing the view' below.
test('`Open file` leaves the view closed and the file open as a PANE of its folder tab', () => {
  st.openCommitView(C0.hash);
  (byKey(commitRoot, `diffopen:${F1.path}`) as FakeElement).click();
  assert.equal(st.state.openCommit, null, 'the pane lives in the row the view was covering');
  const v = st.activeView() as View;
  assert.deepEqual(v.root, { kind: 'home' }, 'no session, no project: the file lands at Home');
  assert.deepEqual(v.slots, [{ kind: 'file', path: F1.path }]);
  assert.equal(handBacks, 0, 'this is not the way BACK; it is the way into the file');
  assert.equal(paneHandovers, 1, 'and the keyboard goes with it');
});

test('`Changes` opens the read-only diff pane for that file in that commit', () => {
  st.openCommitView(C0.hash);
  (byKey(commitRoot, `diffchanges:${C0.hash}:${F0.path}`) as FakeElement).click();
  assert.equal(st.state.openCommit, null);
  assert.deepEqual((st.activeView() as View).slots, [
    { kind: 'diff', hash: C0.hash, path: F0.path },
  ]);
  assert.equal(paneHandovers, 1, 'a diff has no field to land in, so the pane takes the keyboard');
});

test('a full tab keeps the screen and says so, instead of closing for a pane it never opened', () => {
  st.openCommitView(C0.hash);
  // Four panes already: the fifth cannot land anywhere.
  st.state.views = [
    {
      id: 'home',
      root: { kind: 'home' },
      slots: ['one', 'two', 'three', 'four'].map((n) => ({ kind: 'file' as const, path: `full/${n}.ts` })),
      focused: 0,
    },
  ];
  st.state.activeViewId = 'home';
  (byKey(commitRoot, `diffopen:${F1.path}`) as FakeElement).click();
  assert.equal(st.state.openCommit, C0.hash, 'the screen is still up');
  assert.equal(paneHandovers, 0, 'and nothing took the keyboard away from it');
  assert.equal((st.activeView() as View).slots.length, 4, 'no fifth pane was opened');
});

test('both openers open the pane BEFORE closing the view — one layout pass, not two', () => {
  // The pane area is covered while the pane is added, so ui/panes.ts refuses
  // to build anything; closing the view then unhides the grid and the deferred
  // render draws the new layout ONCE. The other order builds the panes twice.
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'commit-view.ts'), 'utf8');
  for (const [key, opener, call] of [
    ['diffopen', 'openFile', 'st.openFile('],
    ['diffchanges', 'changes', 'st.openDiff('],
  ] as [string, string, string][]) {
    const from = src.indexOf(`const ${opener} = button(`);
    assert.notEqual(from, -1, `non-vacuity: the ${key} handler was found`);
    const body = src.slice(from, src.indexOf('});', from));
    assert.ok(
      body.indexOf(call) < body.indexOf('st.closeCommitView()'),
      `${key}: the pane is opened before the view closes`,
    );
    assert.ok(body.includes('onOpenPane()'), `${key}: and the keyboard follows it`);
  }
});

test('a file from a commit lands in the tab the view was standing over', () => {
  // The root is the ACTIVE tab's own (the Files panel that opened this commit
  // was reading the same tab); a project tab keeps its files together.
  st.state.views = [
    { id: 'home', root: { kind: 'home' }, slots: [], focused: 0 },
    { id: 'proj', root: { kind: 'project', id: 'p1' }, slots: [], focused: 0 },
  ];
  st.state.activeViewId = 'proj';
  st.openCommitView(C0.hash);
  (byKey(commitRoot, `diffopen:${F1.path}`) as FakeElement).click();
  assert.equal(st.state.activeViewId, 'proj');
  assert.deepEqual((st.activeView() as View).slots, [{ kind: 'file', path: F1.path }]);
  assert.deepEqual(
    st.state.views.map((v) => v.slots.length),
    [0, 1],
    'and Home was left alone',
  );
});

// ---------------------------------------------------------------------------
// The shell wiring (web/src/main.ts) and the pane-area guard (ui/panes.ts)
// ---------------------------------------------------------------------------

const MAIN = readFileSync(join(here, '..', 'web', 'src', 'main.ts'), 'utf8');
const PANES = readFileSync(join(here, '..', 'web', 'src', 'ui', 'panes.ts'), 'utf8');

test('main.ts builds the commit screen as a flex sibling of the grid, and NO editor column', () => {
  assert.ok(MAIN.includes('function buildShell'), 'non-vacuity: main.ts still builds the shell');
  // Both hand-overs land in the pane area since A10: back to the panes, or into
  // the pane a file was just opened in. The focused pane knows which it is.
  assert.match(
    MAIN,
    /const commitView = initCommitView\(commitAside, requestTerminalFocus, requestTerminalFocus\);/,
  );
  assert.match(
    MAIN,
    /main\.append\(projAside, filesAside, commitAside, grid, sessAside\);/,
    'the middle row is Projects, Files, the commit screen, the panes and Sessions',
  );
  // The editor column is gone with part A10: a file is a pane, and the grid
  // keeps the whole row (the user's complaint about the half-width panes).
  for (const dead of ['initEditor', 'editorAside', 'is-narrow', 'editorVisible']) {
    assert.equal(MAIN.includes(dead), false, `${dead} died with the editor column`);
  }
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
  assert.ok(render.length > 200 && render.length < 3000, 'non-vacuity: the render function was found');
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
  const onAttn = /onAttention: \(\) => \{[\s\S]*?ackSeen\(pay, sessionId\);/.exec(src);
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
  assert.ok(dims.length > 100 && dims.length < 1600, 'non-vacuity: the function was found');
  assert.match(dims, /if \(!gridHidden\(\) &&/, 'a hidden grid is never measured');
  assert.match(dims, /st\.state\.sessions\.get\(id\)/, 'the focused session states its own size');
  assert.match(dims, /info\.status === 'running'/, 'and only a running one is believed');
  assert.match(dims, /return lastGoodDims \?\? \{ cols: 80, rows: 24 \};/, 'then the last good dims');
  assert.ok(
    dims.indexOf('gridHidden()') < dims.indexOf('proposeDims()'),
    'nothing is measured before the guard',
  );
  // And `lastGoodDims` is fed from the one place a view reports its size.
  assert.match(PANES, /onDims: \(cols, rows\) => \{\s*lastGoodDims = \{ cols, rows \};/);
});

test('nothing narrows the grid any more — the panes keep the whole row (A10)', () => {
  const css = readFileSync(join(here, '..', 'web', 'src', 'styles', 'app.css'), 'utf8');
  assert.equal(css.includes('is-narrow'), false, 'the 46% rule died with the editor column');
  assert.equal(css.includes('.editor-'), false, 'and so did the whole editor family');
  // Non-vacuity: the pane area itself is definitely still styled here.
  assert.match(css, /\.grid \{/);
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
  for (const call of ['st.moveFocus(', 'st.movePane(', 'st.setActiveViewIndex(']) {
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
  const guarded = ['st.moveFocus(', 'st.movePane(', 'st.setActiveViewIndex('];
  for (const call of guarded) {
    const keyFor = call === 'st.setActiveViewIndex(' ? "k >= '1' && k <= '9'" : "k === 'ArrowLeft'";
    assert.ok(block.includes(keyFor), `${call} is reached by a key the set names`);
  }
});

test('neither screen is persisted: the UI bag writes the same keys it did in A5', () => {
  const src = readFileSync(join(here, '..', 'web', 'src', 'state.ts'), 'utf8');
  const save = src.slice(src.indexOf('function saveUi'), src.indexOf('function loadUi'));
  assert.ok(save.length > 200, 'non-vacuity: saveUi was found');
  for (const key of ['openCommit', 'edits', 'commitCollapsed']) {
    assert.equal(save.includes(key), false, `${key} is a place the user stands, not a preference`);
  }
});

// ---------------------------------------------------------------------------
// Gate additions (test-engineer, A6; re-pointed by A10): the state contract
// behind this screen — which change notifies, what a re-open keeps, and whose
// unsaved text a close drops.
// ---------------------------------------------------------------------------

/** Everything `notify()` emitted since `kinds.length = 0`. */
const kinds: string[] = [];
st.subscribe((k) => {
  kinds.push(k);
});

test('the commit view notifies `screen`, a pane notifies `ui`, and a keystroke notifies NOTHING', () => {
  // `screen` is what main.ts's one layout owner listens on (a change that
  // stayed silent would leave the grid hidden with nothing over it); a pane is
  // ordinary pane-area chrome, so it rides `ui` like every other tab change.
  const only = (fn: () => void): string[] => {
    kinds.length = 0;
    fn();
    return kinds;
  };
  assert.deepEqual(only(() => st.openCommitView(C0.hash)), ['screen']);
  assert.deepEqual(only(() => st.toggleCommitFile(C0.hash, F0.path)), ['screen']);
  assert.deepEqual(only(() => st.closeCommitView()), ['screen']);
  // Creating the Home tab is itself a `ui` change; count what OPENING costs,
  // not what the first-ever tab costs.
  st.openFile({ kind: 'home' }, 'seed/first.ts', 'first.ts');
  assert.deepEqual(only(() => st.openFile({ kind: 'home' }, 'a/one.ts', 'one.ts')), ['ui']);
  assert.deepEqual(only(() => st.openDiff({ kind: 'home' }, C0.hash, 'a/one.ts')), ['ui']);
  // A keystroke must not notify: a chrome rebuild per character would take the
  // caret with it (ui/file-pane.ts updates the gutter in place instead).
  assert.deepEqual(only(() => st.setEdit('f:a/one.ts', 'typed')), []);
  assert.deepEqual(only(() => st.saveEdit('f:a/one.ts')), ['ui'], 'saving is a chrome change');
  assert.deepEqual(only(() => st.saveEdit('f:a/one.ts')), [], 'saving a clean file changes nothing');
  const home = st.state.views[0] as View;
  assert.deepEqual(only(() => st.closeSlot(home.id, 0)), ['ui']);
  assert.deepEqual(only(() => st.closeSlot(home.id, 9)), [], 'closing nothing is a no-op');
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

test('closing a file pane leaves every other file’s unsaved text alone', () => {
  st.openFile({ kind: 'home' }, 'a/one.ts', 'one.ts');
  st.openFile({ kind: 'home' }, 'a/two.ts', 'two.ts');
  st.setEdit('f:a/one.ts', 'one typed');
  st.setEdit('f:a/two.ts', 'two typed');
  const home = st.state.views[0] as View;
  const two = home.slots.findIndex((s) => s.path === 'a/two.ts');
  assert.notEqual(two, -1, 'non-vacuity: both files are panes of the Home tab');

  st.closeSlot(home.id, two);
  assert.equal(st.editorDirty('f:a/one.ts'), true, 'the other file is untouched');
  assert.equal(st.state.edits.get('f:a/one.ts'), 'one typed');
  // The closed file was on no other pane, so its text goes with it
  // (PROJECT-SCOPE: dropped when the LAST pane showing that file closes).
  // Still no confirm before B4 owns the disk write; the amber dot is the warning.
  assert.equal(st.state.edits.has('f:a/two.ts'), false);
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
  const fp = readFileSync(join(here, '..', 'web', 'src', 'ui', 'file-pane.ts'), 'utf8');
  assert.match(fp, /diffBody\(hash, path\)/, 'and so does the diff PANE (A10)');

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
  // sentence rendered as a `+` line would read as content of that file. (The
  // FILE half of this rule is pinned in `tests/ui-file-pane.test.ts`.)
  const path = 'server/nothing-here.ts';
  assert.equal(MOCK.mockFileContent(path), null, 'non-vacuity: the mock really has no text');
  const c = MOCK.MOCK_COMMITS.find((x) => x.files.some((f) => f.path === path));
  if (c === undefined) {
    // No mock commit touches an unknown path, so the note is proven through the
    // renderer itself — the same function the view calls per block.
    const body = CV.diffBody(C0.hash, path);
    assert.equal(byClass(body, 'diff-line').length, 0, 'not one diff row');
    assert.deepEqual(textsOf(body, 'diff-note'), ['There is no example content for this file yet.']);
    return;
  }
  st.openCommitView(c.hash);
  assert.deepEqual(textsOf(commitRoot, 'diff-note'), ['There is no example content for this file yet.']);
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
    '.pane-text',
    '.pane-gutter',
    '.pane-dhash',
    '.diff-t',
    '.diff-path',
    '.commit-fpath',
    // Nocturne A7: the Terminal colours preview is a terminal fragment, so it
    // joins the same rule instead of declaring a second copy.
    '.sg-tcprev',
  ]) {
    assert.ok(rule.includes(`${sel},`) || rule.includes(`${sel} {`), `${sel} is in the rule`);
  }
  assert.match(rule, /DESIGN-SYSTEM RULE[\s\S]*like the terminal/, 'and it says what it is');
});

test('every class the commit screen renders has a rule in app.css (a typo is an invisible block)', () => {
  // Every state it has: an open commit, a folded block, and the unresolvable
  // hash. (The file and diff PANES are covered by `tests/ui-file-pane.test.ts`.)
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
  st.openCommitView('deadbee');
  collect(commitRoot);
  st.closeCommitView();

  assert.ok(seen.size > 25, `non-vacuity: ${seen.size} classes were collected`);
  const css = readFileSync(join(here, '..', 'web', 'src', 'styles', 'app.css'), 'utf8');
  const missing = [...seen].filter((c) => !css.includes(`.${c}`)).sort();
  assert.deepEqual(missing, [], `classes with no rule in app.css: ${missing.join(', ')}`);
});
