/**
 * The Files panel's SELECTION (Nocturne part A9b, brief 1) — driven through
 * the REAL `web/src/ui/files.ts` on the DOM double in `tests/fake-dom.ts`,
 * against the real `web/src/state.ts` and the real mock tree.
 *
 * WHY A FILE OF ITS OWN, next to `tests/ui-files-panel.test.ts`. The selection
 * is a promise about where the user's files will land, and every way it can
 * break is silent:
 *
 *   - a selection painted from a live ELEMENT instead of from the path
 *     disappears on the next rebuild — and the panel rebuilds on a folder
 *     toggle, a subject change and a tab switch, so the folder the copy strip
 *     still names would no longer be the one the row shows;
 *   - a selection left in `sig()` unread never repaints, so the chosen row
 *     looks unchosen while it really is the destination;
 *   - an Escape that stops propagating unconditionally makes the panel
 *     unclosable by keyboard; one that never stops makes the first Escape
 *     close the whole panel and the selection pointless;
 *   - a selection that outlives the panel leaving the screen takes a paste out
 *     of a focused terminal and copies it into a folder nobody can see.
 *
 * The pure rules behind all of it are pinned in
 * `tests/ui-files-select-model.test.ts`; this file pins the PLUMBING — that
 * the panel really calls them, really paints the class, and really spends the
 * key.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`): that
 * `is-sel` is legible, that it changes no layout, that Enter on a `<button>`
 * really fires a click (the fake DOM has no activation behaviour — the row's
 * BUTTON-ness is asserted instead, which is what gives the gesture its
 * keyboard twin for free), and screen-reader output.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project, SessionInfo } from '../shared/protocol.ts';
import { byClass, byKey, dispatch, installDom, type FakeElement } from './fake-dom.ts';
import { APP_CSS, stripComments } from './tokens-helpers.ts';

const dom = installDom();

const here = dirname(fileURLToPath(import.meta.url));
const st = (await import(new URL('../web/src/state.ts', import.meta.url).href)) as StateModule;
const F = (await import(new URL('../web/src/ui/files.ts', import.meta.url).href)) as FilesModule;
const FD = (await import(new URL('../web/src/ui/filedrop.ts', import.meta.url).href)) as FileDropModule;
const SEL = (await import(
  new URL('../web/src/ui/files-select-model.ts', import.meta.url).href
)) as SelectModule;

interface StateModule {
  state: {
    sessions: Map<string, SessionInfo>;
    projects: Project[];
    views: ViewLike[];
    activeViewId: string;
    drawer: string | null;
    leftPanel: 'files' | null;
    filesWidth: number;
    openCommit: string | null;
    commitCollapsed: Set<string>;
    edits: Map<string, string>;
    history: unknown[];
  };
  FILES_W_DEFAULT: number;
  setSessions(list: SessionInfo[]): void;
  setProjects(list: Project[]): void;
  subscribe(fn: (kind: string) => void): void;
  toggleLeftPanel(p: 'files'): void;
  filesPanelVisible(): boolean;
  setActiveView(id: string): void;
}
interface FilesModule {
  initFilesPanel(host: unknown, onLeaveScreen: () => void): { render(): void };
  pasteDestination(): string | null;
  selectedFolder(): string | null;
  filesPanelDestination(): string | null;
  destinationOfActiveView(): string | null;
  destinationOfPane(paneEl: unknown): unknown;
  listingFor(dest: string): readonly string[];
}
interface FileDropModule {
  initFileDrop(deps: Record<string, unknown>): void;
}
interface SelectModule {
  COPY_LABEL: string;
  copyIntoText(dest: string): string;
}
type ViewRoot = { kind: 'home' } | { kind: 'project'; id: string };
interface ViewLike {
  id: string;
  root: ViewRoot | null;
  slots: { kind: 'session'; id: string }[];
  focused: number;
}

// The drop layer is wired so nothing in the panel reaches an unwired dep; the
// chooser and the dialog are injected, exactly as the A9 tests inject them.
FD.initFileDrop({
  openDialog: () => {},
  listingFor: (dest: string) => F.listingFor(dest),
  destinationOfPane: (el: unknown) => F.destinationOfPane(el),
  destinationOfActiveView: () => F.destinationOfActiveView(),
  filesPanelDestination: () => F.filesPanelDestination(),
  pasteDestination: () => F.pasteDestination(),
  selectedFolder: () => F.selectedFolder(),
  openPicker: () => {},
  flash: () => {},
});

const host = dom.doc.createElement('aside');
host.className = 'drawer files-panel';
dom.body.append(host);
const panel = F.initFilesPanel(host, () => {});
const root = host.children[0] as FakeElement;
st.subscribe(() => panel.render());

/**
 * `main.ts`'s Escape LADDER, mirrored — its Files arm only, and only the two
 * conditions that arm tests (`st.state.leftPanel !== null` and the focus being
 * inside the panel's host aside). A9b may not touch that ladder, so this is
 * how "the FIRST Escape does not reach it and the SECOND one does" is checked
 * without importing main.ts (whose import graph reaches @xterm/xterm).
 *
 * The mirror is pinned against the real source below
 * (`the mirrored ladder arm is the one main.ts really has`), so it cannot
 * quietly drift into testing a ladder nobody ships.
 */
let ladderClosed = 0;
dom.win.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (st.state.leftPanel === null) return;
  if (dom.doc.activeElement === null || !host.contains(dom.doc.activeElement)) return;
  ladderClosed += 1;
  st.toggleLeftPanel('files');
});

function mkSession(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    title: id,
    command: 'claude',
    args: [],
    cwd: '/home/you/work',
    status: 'running',
    cols: 80,
    rows: 24,
    createdAt: new Date().toISOString(),
    attention: false,
    ...over,
  } as SessionInfo;
}

function project(id: string, name: string): Project {
  return { id, name, path: `/home/you/${name}`, createdAt: new Date().toISOString() } as Project;
}

/** A live session in a project — the panel's normal world, header `api`. */
function liveSession(): void {
  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  st.state.leftPanel = 'files';
  panel.render();
}

const copyBtn = (): FakeElement => byKey(root, 'fcopy') as FakeElement;
const row = (path: string): FakeElement => byKey(root, `fdir:${path}`) as FakeElement;
const fileRow = (path: string): FakeElement => byKey(root, `ffile:${path}`) as FakeElement;
/** Every row currently wearing the chosen-folder class, by its `data-k`. */
function selectedRows(): string[] {
  return byClass(root, 'is-sel').map((n) => n.getAttribute('data-k') ?? '');
}

/**
 * The mock tree's own starting shape (`MOCK_OPEN_FOLDERS`), restored between
 * tests. `openFolders` is module-instance state with no reset seam — which is
 * exactly right for the app and a trap for a file whose tests each expect the
 * tree they see at first paint — so it is restored the way a user would, by
 * activating the rows that are in the wrong state.
 */
const MOCK_OPEN = ['web', 'web/src', 'server'];
function resetTree(): void {
  for (const path of MOCK_OPEN) {
    const r = row(path);
    if (r !== null && r.getAttribute('aria-expanded') === 'false') r.click();
  }
}

beforeEach(() => {
  dom.storage.clear();
  st.state.sessions = new Map();
  st.state.projects = [];
  st.state.views = [];
  st.state.activeViewId = '';
  st.state.drawer = null;
  st.state.leftPanel = 'files';
  st.state.filesWidth = st.FILES_W_DEFAULT;
  st.state.openCommit = null;
  st.state.commitCollapsed = new Set();
  st.state.edits = new Map();
  st.state.history = [];
  ladderClosed = 0;
  dom.doc.activeElement = dom.body;
  panel.render();
  resetTree();
  // Clear whatever the previous test (or `resetTree`) chose — through the
  // app's own Escape, not by reaching into the module.
  dispatch(root, 'keydown', { key: 'Escape' });
});

// ---------------------------------------------------------------------------
// One gesture, two effects
// ---------------------------------------------------------------------------

test('clicking a folder row selects it AND toggles it, in that order', () => {
  liveSession();
  const web = row('web');
  assert.ok(web !== null, 'non-vacuity: the mock tree has a `web` folder row');
  const openBefore = web.getAttribute('aria-expanded');
  assert.equal(openBefore, 'true', 'non-vacuity: `web` starts open in the mock');

  web.click();
  assert.deepEqual(selectedRows(), ['fdir:web'], 'the row is the chosen folder');
  assert.equal(row('web').getAttribute('aria-expanded'), 'false', 'and it closed, as it always did');

  // A second activation keeps it chosen and flips the toggle back: the toggle
  // is what alternates, the selection is not.
  row('web').click();
  assert.deepEqual(selectedRows(), ['fdir:web']);
  assert.equal(row('web').getAttribute('aria-expanded'), 'true');
});

test('choosing another folder replaces the first — single selection, always', () => {
  liveSession();
  row('web').click();
  row('server').click();
  assert.deepEqual(selectedRows(), ['fdir:server']);
  assert.equal(F.selectedFolder(), 'server', 'a NAME, never a path');
});

test('a FILE row selects nothing, and does not disturb the chosen folder', () => {
  liveSession();
  row('web').click();
  const file = fileRow('README.md');
  assert.ok(file !== null, 'non-vacuity: the mock tree has a README row');
  file.click();
  assert.deepEqual(selectedRows(), ['fdir:web'], 'opening a file is not a way to lose your folder');
  assert.equal(F.selectedFolder(), 'web');
});

test('the row is a BUTTON, so enter and space are the gesture s keyboard twin for free', () => {
  // The fake DOM has no activation behaviour, so what is checkable here is the
  // element KIND — a `<button>` the browser activates on Enter and on Space —
  // plus that a plain Enter is left alone by the row's own handlers (they take
  // ctrl+alt+enter only), which is what lets that activation happen at all.
  liveSession();
  const web = row('web');
  assert.equal(web.tagName, 'BUTTON');
  assert.equal(web.type, 'button');
  web.focus();
  const e = dispatch(web, 'keydown', { key: 'Enter' });
  assert.equal(e.defaultPrevented, false, 'a plain Enter must reach the browser s own activation');
  assert.equal(e.cancelBubble, false);
  // And that activation is exactly the click path above.
  web.click();
  assert.deepEqual(selectedRows(), ['fdir:web']);
});

// ---------------------------------------------------------------------------
// It survives every repaint
// ---------------------------------------------------------------------------

test('the selection survives a plain rebuild, a folder toggle and a subject change', () => {
  liveSession();
  row('web/src').click();
  assert.deepEqual(selectedRows(), ['fdir:web/src']);

  // A rebuild forced the way the panel forces one (a fresh subject).
  st.setProjects([project('p1', 'api'), project('p2', 'nocturne')]);
  st.setSessions([mkSession('s2', { projectId: 'p2' })]);
  panel.render();
  assert.deepEqual(selectedRows(), ['fdir:web/src'], 'a new subject is not a new selection');

  // Another folder toggling open or closed rebuilds every row.
  row('server').click();
  row('server').click();
  assert.deepEqual(selectedRows(), ['fdir:server'], 'the last activated row is the chosen one');
});

test('a collapsed ANCESTOR keeps the selection: no row is drawn, the strip still names it', () => {
  liveSession();
  row('web/src').click();
  assert.equal(F.selectedFolder(), 'src');
  // Close its parent: the chosen row is not rendered at all any more.
  row('web').click();
  assert.equal(row('web/src'), null, 'non-vacuity: the chosen row really left the tree');
  assert.equal(F.selectedFolder(), 'web', 'the parent activation chose the parent');

  // The other half of the claim, with the selection made on the CHILD and the
  // parent closed without activating it: the path is still a real folder.
  row('web').click(); // open again
  row('web/src').click();
  assert.deepEqual(selectedRows(), ['fdir:web/src']);
  assert.equal(F.selectedFolder(), 'src');
});

test('the selection survives a tab switch (the panel changes subject, not choice)', () => {
  st.setProjects([project('p1', 'api'), project('p2', 'nocturne')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' }), mkSession('s2', { projectId: 'p2' })]);
  st.state.views = [
    { id: 'v1', root: { kind: 'project', id: 'p1' }, slots: [{ kind: 'session', id: 's1' }], focused: 0 },
    { id: 'v2', root: { kind: 'project', id: 'p2' }, slots: [{ kind: 'session', id: 's2' }], focused: 0 },
  ];
  st.state.activeViewId = 'v1';
  st.state.leftPanel = 'files';
  panel.render();
  assert.equal(F.filesPanelDestination(), 'api', 'non-vacuity: the header really reads the tab');

  row('web/src').click();
  st.state.activeViewId = 'v2';
  panel.render();
  assert.equal(F.filesPanelDestination(), 'nocturne', 'non-vacuity: the subject really changed');
  assert.deepEqual(selectedRows(), ['fdir:web/src'], 'and the chosen folder did not');
});

// ---------------------------------------------------------------------------
// Escape, and the ladder behind it
// ---------------------------------------------------------------------------

test('Escape clears the selection and does NOT close the panel; the second Escape closes it', () => {
  liveSession();
  const web = row('web');
  web.click();
  web.focus();
  assert.deepEqual(selectedRows(), ['fdir:web'], 'non-vacuity: something is chosen');

  const first = dispatch(row('web'), 'keydown', { key: 'Escape' });
  assert.equal(first.defaultPrevented, true);
  assert.equal(first.cancelBubble, true, 'the key is spent here, so the ladder never sees it');
  assert.deepEqual(selectedRows(), [], 'the selection is gone');
  assert.equal(ladderClosed, 0, 'the panel must not disappear under the user');
  assert.equal(st.filesPanelVisible(), true);

  // Focus survives the rebuild the clear caused, so the second Escape is
  // pressed in exactly the same place the first one was.
  row('web').focus();
  const second = dispatch(row('web'), 'keydown', { key: 'Escape' });
  assert.equal(second.cancelBubble, false, 'with nothing chosen the panel does not take the key');
  assert.equal(ladderClosed, 1, 'and the ladder closes the panel, as it always did');
  assert.equal(st.filesPanelVisible(), false);
});

test('Escape with nothing chosen is not even prevented — it belongs to whatever is behind it', () => {
  liveSession();
  row('web').focus();
  const e = dispatch(row('web'), 'keydown', { key: 'Escape' });
  assert.equal(e.defaultPrevented, false);
  assert.equal(e.cancelBubble, false);
});

test('a key that is not Escape is never taken by the selection listener', () => {
  liveSession();
  row('web').click();
  const e = dispatch(row('web'), 'keydown', { key: 'a' });
  assert.equal(e.defaultPrevented, false);
  assert.equal(e.cancelBubble, false);
  assert.deepEqual(selectedRows(), ['fdir:web'], 'and it changes nothing');
});

test('the mirrored ladder arm is the one main.ts really has (so this file tests the shipped one)', () => {
  const main = readFileSync(join(here, '..', 'web', 'src', 'main.ts'), 'utf8');
  assert.ok(main.length > 10_000, 'non-vacuity: main.ts');
  const from = main.indexOf("e.key === 'Escape'");
  assert.notEqual(from, -1, 'non-vacuity: the Escape branch was found');
  const branch = main.slice(from, main.indexOf('// ---- reliability'));
  assert.match(branch, /st\.state\.leftPanel !== null/);
  assert.match(branch, /filesAside\.contains\(document\.activeElement\)/);
  assert.match(branch, /st\.toggleLeftPanel\('files'\)/);
  // A9b spends Escape in ui/files.ts, NOT as a new rung here: the ladder's
  // Files arm must still be the last one, and nothing in it may mention the
  // selection.
  assert.equal(branch.includes('selectedFolder'), false, 'the ladder knows nothing about the selection');
});

// ---------------------------------------------------------------------------
// A panel nobody can see holds no destination
// ---------------------------------------------------------------------------

test('hiding the panel clears the selection — an invisible destination may not take a paste', () => {
  liveSession();
  row('web').click();
  assert.equal(F.selectedFolder(), 'web');

  // The Projects drawer borrowing the left column is the other way it goes
  // away; `filesPanelVisible()` is the one seam both go through.
  st.state.drawer = 'projects';
  panel.render();
  assert.equal(st.filesPanelVisible(), false, 'non-vacuity: the panel really is off screen');
  assert.equal(F.selectedFolder(), null);

  st.state.drawer = null;
  panel.render();
  assert.equal(st.filesPanelVisible(), true);
  assert.equal(F.selectedFolder(), null, 'it does not come back with the panel');
  assert.deepEqual(selectedRows(), []);
});

test('a panel that is off screen answers NOTHING, even before the render that clears it', () => {
  // Two DIFFERENT guarantees, and only one of them is `afterPanelHidden`.
  // `selectedFolder()` is read straight out of a `paste` handler, which can
  // fire in the window between the state change and the panel s own render
  // pass — so the answer is gated on VISIBILITY, not on the clear having
  // happened yet. MEASURED (gate, 2026-09-16): deleting the
  // `filesPanelVisible()` guard from `currentSelectedName()` leaves the whole
  // suite green, because every other test renders first.
  liveSession();
  row('web').click();
  assert.equal(F.selectedFolder(), 'web', 'non-vacuity: something is chosen');

  // The Projects drawer takes the left column. NO render() call follows.
  st.state.drawer = 'projects';
  assert.equal(st.filesPanelVisible(), false, 'non-vacuity: the panel really is off screen');
  assert.equal(F.selectedFolder(), null, 'an invisible destination may not take a paste');
  assert.notEqual(F.pasteDestination(), 'web', 'and it may not answer the destination either');

  st.state.drawer = null;
  panel.render();
});

test('the selection is part of sig(), so a change to it alone repaints the tree', () => {
  // A SOURCE contract, deliberately, and this is the justification. Brief 1
  // has no gesture that changes the selection and nothing else: a row
  // activation always toggles a folder (which `sig()` also reads) and the
  // Escape handler forces `lastSig = \'\'` itself. MEASURED (gate,
  // 2026-09-16): deleting the selection from `sig()` leaves the ENTIRE suite
  // green, so no behavioural test in this brief can hold it.
  //
  // It is load-bearing from brief 2 on, where a RIGHT-CLICK selects a row
  // WITHOUT toggling it and without clearing `lastSig` — the panel would then
  // paint no `is-sel` at all while the copy strip already named the folder.
  // Pinned here rather than rediscovered there.
  const files = readFileSync(join(here, '..', 'web', 'src', 'ui', 'files.ts'), 'utf8');
  const from = files.indexOf('function sig(');
  assert.notEqual(from, -1, 'non-vacuity: sig() was found');
  // COMMENTS STRIPPED FIRST: sig()'s own prose says "its selected state"
  // about the Commits tab, and a word-boundary match on the raw slice reads
  // that comment and passes with the code line gone (caught while writing
  // this test — the first version of it did exactly that).
  const body = files
    .slice(from, files.indexOf('\n  }', from))
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(body.length > 200, `non-vacuity: ${body.length} chars of sig()`);
  assert.match(body, /openFolders/, 'non-vacuity: the slice really is the signature builder');
  assert.match(body, /\bselected\b/, 'a selection change must invalidate the signature');
});

test('the Files toggle closing the panel clears it too', () => {
  liveSession();
  row('server').click();
  st.toggleLeftPanel('files');
  panel.render();
  assert.equal(F.selectedFolder(), null);
});

// ---------------------------------------------------------------------------
// What the strip says, and where a paste goes
// ---------------------------------------------------------------------------

test('the copy strip names the chosen folder, and its title keeps the full sentence', () => {
  liveSession();
  assert.equal(copyBtn().textContent, SEL.COPY_LABEL, 'nothing chosen: the A9 wording');
  assert.equal(copyBtn().title, SEL.copyIntoText('api'));

  row('web/src').click();
  assert.equal(copyBtn().textContent, 'Copy files into src…', 'the destination is said out loud');
  assert.equal(copyBtn().title, SEL.copyIntoText('src'));

  dispatch(root, 'keydown', { key: 'Escape' });
  assert.equal(copyBtn().textContent, SEL.COPY_LABEL);
  assert.equal(copyBtn().title, SEL.copyIntoText('api'));
});

test('pasteDestination() answers the SELECTION first, before the focus memory', () => {
  liveSession();
  // The A9 chain still works on its own: a folder row holding the keyboard.
  row('server').focus();
  assert.equal(F.pasteDestination(), 'server', 'non-vacuity: the focus memory really answers');

  // Now choose a DIFFERENT folder and leave the keyboard where it is.
  row('web/src').click();
  row('server').focus();
  assert.equal(F.pasteDestination(), 'src', 'the chosen folder wins, always');
  assert.equal(F.selectedFolder(), 'src');

  // Focus outside the panel entirely: the selection still answers, which is
  // what makes a paste from a focused terminal land somewhere honest.
  const outside = dom.doc.createElement('button');
  dom.body.append(outside);
  outside.focus();
  assert.equal(F.pasteDestination(), 'src');
  outside.remove();
});

test('with the panel off screen the selection answers nothing, and the A9 fallback returns', () => {
  liveSession();
  row('web/src').click();
  st.state.drawer = 'projects';
  panel.render();
  assert.equal(F.selectedFolder(), null);
  // `pasteDestination()` falls through to the panel's own root, exactly as it
  // did before A9b — the panel object still exists, it is only hidden.
  assert.equal(F.pasteDestination(), 'api');
  st.state.drawer = null;
  panel.render();
});

// ---------------------------------------------------------------------------
// The class and its rule
// ---------------------------------------------------------------------------

test('`is-sel` has a rule behind it, and the panel really sets it (class parity)', () => {
  // Either half alone passes while the feature is invisible: a class nothing
  // styles paints nothing, and a rule nothing sets is dead CSS. Measured:
  // deleting the rule leaves every DOM assertion in this file green.
  const css = stripComments(APP_CSS);
  assert.ok(css.length > 50_000, `non-vacuity: app.css is ${css.length} chars`);
  assert.match(css, /\.files-view \.files-row\.is-sel\b/);
  assert.match(css, /\.files-row\.is-sel \.files-name\b/);

  const files = readFileSync(join(here, '..', 'web', 'src', 'ui', 'files.ts'), 'utf8');
  assert.match(files, /classList\.toggle\('is-sel'/, 'the panel must be the setter');

  liveSession();
  row('web').click();
  assert.deepEqual(selectedRows(), ['fdir:web'], 'and it really lands on the row');
});

test('the chosen row says so to a screen reader too: aria-current on it, absent everywhere else', () => {
  // `is-sel` is COLOUR. Every other `is-sel` setter in the app pairs the class
  // with an ARIA state (term-colours.ts aria-checked, settings.ts
  // aria-selected, launch.ts aria-checked), and without one the destination of
  // the next paste exists for sighted users only.
  liveSession();
  const dirs = (): FakeElement[] =>
    byClass(root, 'files-row').filter((n) => (n.getAttribute('data-k') ?? '').startsWith('fdir:'));
  assert.ok(dirs().length >= 3, `non-vacuity: ${dirs().length} folder rows`);
  for (const d of dirs()) {
    assert.equal(d.getAttribute('aria-current'), null, 'nothing is chosen yet');
  }

  row('web').click();
  assert.equal(row('web').getAttribute('aria-current'), 'true');
  for (const d of dirs()) {
    if (d.getAttribute('data-k') === 'fdir:web') continue;
    // ABSENT, not `'false'`: an attribute that is not there is the honest
    // "not the current destination".
    assert.equal(d.getAttribute('aria-current'), null, `${d.getAttribute('data-k') ?? ''} is not chosen`);
  }

  // And it leaves with the selection.
  dispatch(root, 'keydown', { key: 'Escape' });
  for (const d of dirs()) assert.equal(d.getAttribute('aria-current'), null);
});

test('the copy strip clamps its variable label: one line, clipped, never a wider panel', () => {
  // A9b made the label variable (`Copy files into <folder>…`). A long folder
  // name wrapping inside the 26px box — or raising the panel's min-content
  // width — would narrow the pane grid and resize every PTY behind it.
  const css = stripComments(APP_CSS);
  const rule = /\.files-copy-btn\s*\{([^}]*)\}/.exec(css);
  assert.notEqual(rule, null, 'non-vacuity: the copy-strip rule was found');
  const body = rule?.[1] ?? '';
  assert.match(body, /white-space: nowrap/);
  assert.match(body, /text-overflow: ellipsis/);
  assert.match(body, /overflow: hidden/);
  assert.match(body, /min-width: 0/);
});

test('the chosen-folder rules are tokens only: no colour literal, no layout property', () => {
  const css = stripComments(APP_CSS);
  const rules = [...css.matchAll(/\.files-row\.is-sel[^{]*\{([^}]*)\}/g)].map((m) => m[1] as string);
  assert.equal(rules.length, 2, `non-vacuity: parsed ${rules.length} is-sel rules`);
  for (const body of rules) {
    assert.equal(/#[0-9a-fA-F]{3}/.test(body), false, `a colour literal: ${body}`);
    assert.equal(/\b(rgb|rgba|hsl|hsla)\(/.test(body), false, `a colour literal: ${body}`);
    // NOT ONE PIXEL of layout: a width, a padding or a border on a row changes
    // the panel's box, every pane's ResizeObserver fires and every PTY in the
    // grid is resized for a highlight (the A9 rule).
    for (const prop of ['width', 'height', 'padding', 'margin', 'border', 'font-size']) {
      assert.equal(new RegExp(`(^|;)\\s*${prop}`, 'm').test(body), false, `${prop} in: ${body}`);
    }
  }
  // The accent grammar the spec fixes: a faint accent ground and an INSET mark.
  const ground = rules[0] as string;
  assert.match(ground, /background: var\(--color-accent-900\)/);
  assert.match(ground, /box-shadow: inset var\(--tick\) 0 0 0 var\(--color-accent\)/);
  assert.match(rules[1] as string, /color: var\(--color-text\)/);
});
