/**
 * `web/src/ui/files.ts` — the Files panel (Nocturne A5) driven through the REAL
 * module: the grip dragged with real pointer events, the arrow keys pressed,
 * folder rows clicked, tabs switched — against the REAL `web/src/state.ts`,
 * `ui/util.ts`, `ui/icons.ts`, `ui/files-model.ts` and `ui/files-mock.ts`.
 *
 * WHY, next to `tests/ui-files-model.test.ts`. That file pins the model's
 * arithmetic; this one pins the PLUMBING between it and the panel, which is
 * where a silent regression fits: a grip that resizes without pointer capture
 * (the pointer leaves the 6px strip and the drag dies mid-gesture), a drag
 * that never commits (the width is lost on the next chrome rebuild), a width
 * that skips the clamp (a 3px panel or a panel wider than the window), a
 * folder that stops toggling, a tab that renders the other tab's body. Every
 * one of those keeps `ui-files-model.test.ts` green.
 *
 * Plus the shell wiring in `web/src/main.ts` that no unit can reach: the panel
 * is constructed, it is a flex sibling BEFORE the grid (so opening it narrows
 * the panes and the existing fit -> ws `resize` chain fires), the Files button
 * really toggles, and visibility goes through `filesPanelVisible()`. Those are
 * read from the source — main.ts's own import graph reaches @xterm/xterm, a
 * browser bundle — and each assertion is written so that deleting the wiring
 * it names fails it.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, colour, the amber pulse actually animating, that a drag really
 * reflows a PTY, hit-testing, screen-reader output.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project, SessionInfo } from '../shared/protocol.ts';
import {
  byClass,
  byKey,
  dispatch,
  installDom,
  textsOf,
  type FakeElement,
} from './fake-dom.ts';

const dom = installDom();

// The modules are imported through a computed URL: the server tsconfig must
// not walk the browser type graph (web/tsconfig.json owns that).
const here = dirname(fileURLToPath(import.meta.url));
const st = (await import(new URL('../web/src/state.ts', import.meta.url).href)) as StateModule;
const F = (await import(new URL('../web/src/ui/files.ts', import.meta.url).href)) as FilesModule;
const M = (await import(new URL('../web/src/ui/files-model.ts', import.meta.url).href)) as ModelModule;
const MOCK = (await import(new URL('../web/src/ui/files-mock.ts', import.meta.url).href)) as MockModule;
const MODEL = (await import(new URL('../web/src/ui/commit-model.ts', import.meta.url).href)) as {
  blockDomId(hash: string, path: string): string;
};
// Part A9: the row-level copy chord goes through this module's picker seam, so
// the panel is driven against the REAL filedrop layer with the chooser (and the
// dialog) injected — exactly the seam `tests/ui-filedrop.test.ts` uses.
const FD = (await import(new URL('../web/src/ui/filedrop.ts', import.meta.url).href)) as FileDropModule;
interface DropReq {
  dest: string;
  items: { name: string; dir: boolean; bytes: number | null }[];
  listing: readonly string[];
}
interface FileDropModule {
  initFileDrop(deps: Record<string, unknown>): void;
}
/** Every drop the panel handed on, in order. */
const dropped: DropReq[] = [];
FD.initFileDrop({
  openDialog: (req: DropReq) => dropped.push(req),
  listingFor: (dest: string) => F.listingFor(dest),
  destinationOfPane: (el: unknown) => F.destinationOfPane(el),
  destinationOfActiveView: () => F.destinationOfActiveView(),
  filesPanelDestination: () => F.filesPanelDestination(),
  pasteDestination: () => F.pasteDestination(),
  selectedFolder: () => F.selectedFolder(),
  openPicker: (take: (files: readonly { name: string; size?: number }[]) => void) =>
    take([{ name: 'shot.png', size: 7 }]),
  flash: () => {},
});

interface StateModule {
  state: {
    sessions: Map<string, SessionInfo>;
    openCommit: string | null;
    commitCollapsed: Set<string>;
    edits: Map<string, string>;
    projects: Project[];
    views: ViewLike[];
    activeViewId: string;
    drawer: string | null;
    leftPanel: 'files' | null;
    filesWidth: number;
    history: unknown[];
  };
  FILES_W_MIN: number;
  FILES_W_MAX: number;
  FILES_W_DEFAULT: number;
  setSessions(list: SessionInfo[]): void;
  markExited(id: string, exitCode: number): void;
  aliveSessionCount(): number;
  setProjects(list: Project[]): void;
  subscribe(fn: (kind: string) => void): void;
  toggleLeftPanel(p: 'files'): void;
  filesPanelVisible(): boolean;
  openCommitView(hash: string): void;
  closeCommitView(): void;
  commitFileCollapsed(hash: string, path: string): boolean;
  editorFileId(path: string): string;
  slotKey(s: PaneSlot): string;
  slotTabIds(s: PaneSlot): string[];
  newEditorSlot(tabs: EditorTab[]): PaneSlot;
  activeView(): ViewLike | null;
  openFile(root: ViewRoot, path: string, label: string): string;
  openTabAt(viewId: string, slot: number, where: string, tab: EditorTab): string;
  dropZonesFor(v: ViewLike, slot: number, count: number): string[];
  MAX_PANES: number;
}

/** The A10b slot model, restated here so this file never imports the browser graph. */
type EditorTab = { kind: 'file'; path: string } | { kind: 'diff'; hash: string; path: string };
type PaneSlot =
  | { kind: 'session'; id: string }
  | { kind: 'editor'; id: string; tabs: EditorTab[]; active: number };
type ViewRoot = { kind: 'home' } | { kind: 'project'; id: string };
interface ViewLike {
  id: string;
  root: ViewRoot | null;
  slots: PaneSlot[];
  focused: number;
  l3?: 'L' | 'R';
  split?: { col: number; row: number };
}
/** An editor pane holding these files, in strip order, the first one active. */
function ed(...paths: string[]): PaneSlot {
  return st.newEditorSlot(paths.map((path) => ({ kind: 'file', path })));
}

interface FilesModule {
  initFilesPanel(host: unknown, onLeaveScreen: () => void): { render(): void };
  /** Part A9: where a drop, a paste or the header button would copy to. */
  pasteDestination(): string | null;
  /** Part A9b: the folder the user chose, as a NAME. */
  selectedFolder(): string | null;
  filesPanelDestination(): string | null;
  destinationOfActiveView(): string | null;
  destinationOfPane(paneEl: unknown): { dest: string } | { dest: null; why: 'session' | 'tab' };
  listingFor(dest: string): readonly string[];
}
interface ModelModule {
  buildTree(files: readonly { path: string }[]): unknown[];
  treeRows(nodes: readonly unknown[], open: ReadonlySet<string>): { path: string; dir: boolean; busy: boolean }[];
}
interface MockModule {
  MOCK_FILES: { path: string; add?: number; del?: number; editing?: boolean }[];
  MOCK_OPEN_FOLDERS: string[];
  MOCK_COMMITS: {
    hash: string;
    message: string;
    author: string;
    when: string;
    add: number;
    del: number;
    files: { path: string; add: number; del: number }[];
  }[];
  MOCK_BRANCH: string;
}

const host = dom.doc.createElement('aside');
dom.body.append(host);
/** The keyboard hand-back main.ts injects (the real one focuses a terminal). */
let handBacks = 0;
const panel = F.initFilesPanel(host, () => {
  handBacks += 1;
});
const root = host.children[0] as FakeElement;

/** Everything `notify()` emitted since the last reset. */
const kinds: string[] = [];
st.subscribe((k) => {
  kinds.push(k);
  // The shell re-renders the panel on every change (main.ts); without this the
  // A6 screens — which live in state, not in the panel — would never reach it.
  panel.render();
});

function mkSession(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    title: id,
    command: 'claude',
    args: [],
    cwd: '/tmp',
    status: 'running',
    cols: 80,
    rows: 24,
    createdAt: new Date().toISOString(),
    attention: false,
    ...over,
  } as SessionInfo;
}

function project(id: string, name: string): Project {
  return { id, name, path: `/home/tester/${name}`, createdAt: new Date().toISOString() } as Project;
}

/** A live session in a project, with its own view — the panel's normal world. */
function liveSession(): void {
  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  st.state.leftPanel = 'files';
  kinds.length = 0;
  panel.render();
}

const grip = byClass(root, 'files-grip')[0] as FakeElement;
const body = byClass(root, 'files-body')[0] as FakeElement;
const summary = byClass(root, 'files-sum')[0] as FakeElement;

beforeEach(() => {
  dom.storage.clear();
  st.state.sessions = new Map();
  st.state.projects = [];
  st.state.views = [];
  st.state.activeViewId = '';
  st.state.drawer = null;
  st.state.history = [];
  st.state.leftPanel = 'files';
  st.state.filesWidth = st.FILES_W_DEFAULT;
  host.style.width = `${st.FILES_W_DEFAULT}px`;
  grip.setAttribute('aria-valuenow', String(st.FILES_W_DEFAULT));
  kinds.length = 0;
  handBacks = 0;
  dropped.length = 0;
  st.state.openCommit = null;
  st.state.commitCollapsed = new Set();
  st.state.edits = new Map();
  dom.doc.activeElement = dom.body;
  // A9b: activating a folder row SELECTS it, and a selection outlives every
  // rebuild on purpose — so a row a previous test clicked would still be the
  // paste destination here. Escape on the panel root is the app's own way to
  // clear it (and does nothing when nothing is selected).
  dispatch(root, 'keydown', { key: 'Escape' });
});

// ---------------------------------------------------------------------------
// The grip: drag, keyboard, commit
// ---------------------------------------------------------------------------

test('the grip is a real separator control: role, bounds, current value, keyboard-reachable', () => {
  assert.equal(grip.getAttribute('role'), 'separator');
  assert.equal(grip.getAttribute('aria-orientation'), 'vertical');
  assert.equal(grip.getAttribute('aria-valuemin'), '200');
  assert.equal(grip.getAttribute('aria-valuemax'), '520');
  assert.equal(grip.getAttribute('aria-valuenow'), '300');
  assert.equal(grip.tabIndex, 0, 'a control that only exists under a pointer is forbidden here');
  assert.equal(host.style.width, '300px', 'the panel is as wide as the state says at construction');
});

test('dragging the grip resizes live, and only the RELEASE commits the width', () => {
  dispatch(grip, 'pointerdown', { clientX: 100, pointerId: 7 });
  assert.ok(grip.hasPointerCapture(7), 'capture, so the pointer may leave the 6px strip');
  dispatch(grip, 'pointermove', { clientX: 150, pointerId: 7 });
  assert.equal(st.state.filesWidth, 350);
  assert.equal(host.style.width, '350px');
  assert.equal(grip.getAttribute('aria-valuenow'), '350');
  assert.deepEqual(kinds, [], 'a notify per pointermove would rebuild the chrome at 60Hz');

  dispatch(grip, 'pointerup', { clientX: 150, pointerId: 7 });
  assert.deepEqual(kinds, ['panel'], 'the release commits exactly once');
  assert.equal(grip.hasPointerCapture(7), false, 'and gives the pointer back');
  assert.equal(st.state.filesWidth, 350, 'the committed width is the dragged one');
});

test('a drag past either bound stops at the bound, it does not run away', () => {
  dispatch(grip, 'pointerdown', { clientX: 100, pointerId: 1 });
  dispatch(grip, 'pointermove', { clientX: 4000, pointerId: 1 });
  assert.equal(st.state.filesWidth, st.FILES_W_MAX);
  assert.equal(host.style.width, '520px');
  dispatch(grip, 'pointermove', { clientX: -4000, pointerId: 1 });
  assert.equal(st.state.filesWidth, st.FILES_W_MIN);
  assert.equal(host.style.width, '200px');
  dispatch(grip, 'pointerup', { clientX: -4000, pointerId: 1 });
});

test('a pointermove without a captured drag changes nothing (the grip is not a hover slider)', () => {
  dispatch(grip, 'pointermove', { clientX: 900, pointerId: 3 });
  assert.equal(st.state.filesWidth, 300);
  assert.equal(host.style.width, '300px');
  assert.deepEqual(kinds, []);

  // A non-primary button never starts one either.
  dispatch(grip, 'pointerdown', { clientX: 100, pointerId: 3, button: 2 });
  assert.equal(grip.hasPointerCapture(3), false);
  dispatch(grip, 'pointermove', { clientX: 900, pointerId: 3 });
  assert.equal(st.state.filesWidth, 300);
});

test('after the release the drag is over: a stray move is ignored', () => {
  dispatch(grip, 'pointerdown', { clientX: 100, pointerId: 2 });
  dispatch(grip, 'pointermove', { clientX: 120, pointerId: 2 });
  dispatch(grip, 'pointerup', { clientX: 120, pointerId: 2 });
  kinds.length = 0;
  dispatch(grip, 'pointermove', { clientX: 500, pointerId: 2 });
  assert.equal(st.state.filesWidth, 320, 'the width the user let go of');
  assert.deepEqual(kinds, []);
});

test('a cancelled pointer (the OS took it) ends the drag like a release', () => {
  dispatch(grip, 'pointerdown', { clientX: 100, pointerId: 5 });
  dispatch(grip, 'pointermove', { clientX: 140, pointerId: 5 });
  kinds.length = 0;
  dispatch(grip, 'pointercancel', { clientX: 140, pointerId: 5 });
  assert.equal(grip.hasPointerCapture(5), false);
  assert.deepEqual(kinds, ['panel']);
  assert.equal(st.state.filesWidth, 340);
});

test('the keyboard is the twin of the drag: arrows nudge 16px, Home resets, both commit', () => {
  dispatch(grip, 'keydown', { key: 'ArrowRight' });
  assert.equal(st.state.filesWidth, 316);
  assert.equal(host.style.width, '316px');
  dispatch(grip, 'keydown', { key: 'ArrowLeft' });
  dispatch(grip, 'keydown', { key: 'ArrowLeft' });
  assert.equal(st.state.filesWidth, 284);
  assert.deepEqual(kinds, ['panel', 'panel', 'panel'], 'every nudge is a committed width');

  const e = dispatch(grip, 'keydown', { key: 'Home' });
  assert.equal(st.state.filesWidth, st.FILES_W_DEFAULT);
  assert.equal(e.defaultPrevented, true, 'Home must not scroll the shell');

  const other = dispatch(grip, 'keydown', { key: 'PageUp' });
  assert.equal(other.defaultPrevented, false, 'keys the grip does not own are left alone');
});

test('Enter resets the width too, and the title promises exactly what the grip does', () => {
  // The pane dividers (ui/panes.ts) promise 'double-click or enter resets it.'
  // and implement Enter; this separator must not diverge from its own twin.
  st.state.filesWidth = 500;
  const e = dispatch(grip, 'keydown', { key: 'Enter' });
  assert.equal(st.state.filesWidth, st.FILES_W_DEFAULT);
  assert.equal(e.defaultPrevented, true);
  assert.match(grip.title, /home, enter or double-click/, `the title still hides a gesture: ${grip.title}`);
});

test('the keyboard cannot nudge past the bounds either', () => {
  st.state.filesWidth = st.FILES_W_MIN;
  for (let i = 0; i < 3; i += 1) dispatch(grip, 'keydown', { key: 'ArrowLeft' });
  assert.equal(st.state.filesWidth, st.FILES_W_MIN);
  st.state.filesWidth = st.FILES_W_MAX;
  for (let i = 0; i < 3; i += 1) dispatch(grip, 'keydown', { key: 'ArrowRight' });
  assert.equal(st.state.filesWidth, st.FILES_W_MAX);
});

test('double-clicking the grip resets the width', () => {
  st.state.filesWidth = 480;
  dispatch(grip, 'dblclick');
  assert.equal(st.state.filesWidth, st.FILES_W_DEFAULT);
  assert.equal(host.style.width, '300px');
  assert.deepEqual(kinds, ['panel']);
});

// ---------------------------------------------------------------------------
// What it renders
// ---------------------------------------------------------------------------

test('with no session at all the panel is still up, headed Home', () => {
  // User decision 2026-09-15: the Files panel no longer waits for a session.
  st.state.leftPanel = 'files';
  st.state.drawer = null;
  panel.render();
  assert.equal(st.filesPanelVisible(), true);
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'a name, never a path');
  assert.ok(byClass(root, 'files-row').length >= 10, 'and the tree is really drawn');
});

test('exited sessions with no pane of their own leave the header on Home', () => {
  // Added by the test gate (2026-09-15). `setSessions([])` is not the only
  // empty world: sessions that ENDED stay in state (state.ts markExited keeps
  // them and their pane). With no view focused, the alive-scan finds nothing.
  st.setProjects([project('p1', 'api')]);
  st.setSessions([
    mkSession('s1', { projectId: 'p1', status: 'exited' }),
    mkSession('s2', { title: 'notes', status: 'exited' }),
  ]);
  st.state.views = [];
  st.state.activeViewId = '';
  st.state.leftPanel = 'files';
  st.state.drawer = null;
  panel.render();
  assert.equal(st.filesPanelVisible(), true, 'no session is a condition any more');
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'nothing alive, so nothing to name');
  assert.ok(byClass(root, 'files-row').length >= 10, 'and the tree is drawn all the same');
});

test('a focused pane whose session EXITED, with nothing else alive, is headed Home', () => {
  // Added by the test gate (2026-09-15). The real path: state.ts markExited
  // flips status in place and reconcileViews KEEPS the dead pane, so after the
  // last session quits the focused pane still points at an exited session.
  // Until this change the panel was hidden in exactly that state; now it is on
  // screen, and the brief says the header reads `Home` when nothing is alive.
  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  st.state.leftPanel = 'files';
  st.state.drawer = null;
  panel.render();
  assert.equal(textsOf(root, 'files-proj')[0], 'api', 'non-vacuity: it starts on the live one');

  st.markExited('s1', 0);
  panel.render();
  assert.equal(st.filesPanelVisible(), true, 'the panel survives the exit');
  assert.equal(st.aliveSessionCount(), 0, 'non-vacuity: nothing is running');
  assert.equal(
    textsOf(root, 'files-proj')[0],
    'Home',
    'a dead session is not what a mock file tree is about',
  );
});

test('the Projects drawer takes the left side, and closing it gives the panel back', () => {
  liveSession();
  assert.equal(textsOf(root, 'files-proj')[0], 'api', 'non-vacuity: the panel is up');

  // Projects opens: only one left panel at a time. The panel stops rebuilding
  // (the chrome hides its aside) but nothing about the wish is written.
  st.state.drawer = 'projects';
  st.setProjects([project('p1', 'renamed')]);
  panel.render();
  assert.equal(st.filesPanelVisible(), false);
  assert.equal(st.state.leftPanel, 'files', 'the drawer never writes the wish');
  assert.equal(textsOf(root, 'files-proj')[0], 'api', 'a hidden panel does not rebuild itself');

  st.state.drawer = null;
  panel.render();
  assert.equal(st.filesPanelVisible(), true, 'closing Projects brings Files back by itself');
  assert.equal(textsOf(root, 'files-proj')[0], 'renamed', 'and it repaints what it missed');
});

test('a live session fills the panel: the summary the model computes, then the tree', () => {
  liveSession();
  assert.deepEqual(textsOf(root, 'files-num').slice(0, 2), ['+26', '-10']);
  assert.equal(textsOf(root, 'files-sum-text')[0], 'since last commit in 5 files');
  assert.equal(summary.hidden, false);

  const expected = M.treeRows(M.buildTree(MOCK.MOCK_FILES), new Set(MOCK.MOCK_OPEN_FOLDERS));
  const rows = byClass(root, 'files-row');
  assert.equal(rows.length, expected.length, 'one row per row the model produced');
  assert.ok(rows.length >= 10, 'non-vacuity: the tree really has rows');
  assert.deepEqual(
    rows.map((r) => r.textContent.replace(/^[▾▸]/, '').trim()),
    expected.map((r) => {
      const f = MOCK.MOCK_FILES.find((x) => x.path === r.path);
      const name = r.path.split('/').pop() as string;
      if (r.dir) return name;
      const badge = badgeLabel(name);
      const nums = (f?.add ?? 0) > 0 || (f?.del ?? 0) > 0 ? `+${f?.add ?? 0}-${f?.del ?? 0}` : '';
      return `${badge}${name}${nums}`;
    }),
    'every row prints its badge, its NAME (never a path) and its numbers',
  );
});

function badgeLabel(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const table: Record<string, string> = {
    ts: 'TS',
    tsx: 'TSX',
    js: 'JS',
    jsx: 'JSX',
    mjs: 'JS',
    md: 'MD',
    json: '{ }',
    ps1: 'PS',
  };
  return table[ext] ?? '·';
}

test('the header names the project of the focused session, and the session itself when it has none', () => {
  liveSession();
  assert.equal(textsOf(root, 'files-proj')[0], 'api');

  // A fresh world: the ACTIVE view deliberately keeps a dead pane (state.ts
  // reconcileViews skips it), so a bare setSessions would leave the header on
  // the session that is gone — which is the pane's own story, not the panel's.
  st.state.views = [];
  st.state.activeViewId = '';
  st.setSessions([mkSession('s2', { title: 'scratch shell', command: 'bash' })]);
  panel.render();
  assert.equal(
    textsOf(root, 'files-proj')[0],
    'scratch shell',
    'a project-less session says what it is — never a path, never blank',
  );
});

test('a dead focused pane does not blank the header — it names what is left, or says there is nothing', () => {
  // state.ts reconcileViews keeps the ACTIVE view's dead pane on purpose, so
  // with a second session alive the panel stays on screen while its focused
  // session is gone. A headerless tree is a tree about nothing.
  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' }), mkSession('s2', { title: 'notes' })]);
  st.state.leftPanel = 'files';
  panel.render();
  assert.equal(textsOf(root, 'files-proj')[0], 'api', 'non-vacuity: it starts on the focused one');

  // `s1` ends; the ACTIVE view keeps its pane, `s2` is still running.
  st.setSessions([mkSession('s2', { title: 'notes' })]);
  st.state.views = [
    { id: 'v1', root: null, slots: [{ kind: 'session', id: 's1' }], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
  ];
  st.state.activeViewId = 'v1';
  panel.render();
  assert.equal(st.filesPanelVisible(), true, 'non-vacuity: the panel is still up');
  assert.equal(textsOf(root, 'files-proj')[0], 'notes', 'the first session still alive');

  // The last rung. Since the panel no longer needs a session (user decision
  // 2026-09-15) this state is on screen, not theoretical: the header falls
  // back to the panel's default root, said as a NAME.
  st.setSessions([]);
  panel.render();
  assert.equal(st.filesPanelVisible(), true, 'the panel survives the last session');
  assert.equal(textsOf(root, 'files-proj')[0], 'Home');

  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'files.ts'), 'utf8');
  // A11 turned the lookup into one `subject()` the header and `repoKnown()`
  // both read; the constant it falls back to is still the guard here.
  assert.match(src, /name: 'Home', home: true/);
  assert.equal(/return '';/.test(src), false, 'a blank header is never an answer');
});

test('the amber pulse is on the edited file and every folder above it, and nowhere else', () => {
  liveSession();
  const busy = byClass(root, 'files-row')
    .filter((r) => r.classList.contains('is-busy'))
    .map((r) => (r.textContent.replace(/^[▾▸]/, '') || '').trim());
  assert.deepEqual(busy, ['web', 'src', 'TSXPane.tsx+4-2'], 'the spine of the one edited file');
});

test('a folder row toggles its subtree; a file row opens that file as a PANE (A10)', () => {
  liveSession();
  const server = byKey(root, 'fdir:server') as FakeElement;
  assert.equal(server.tagName, 'BUTTON');
  assert.equal(server.getAttribute('aria-expanded'), 'true');
  const before = byClass(root, 'files-row').length;

  server.click();
  assert.equal((byKey(root, 'fdir:server') as FakeElement).getAttribute('aria-expanded'), 'false');
  assert.equal(byClass(root, 'files-row').length, before - 3, 'the three server/ files went with it');
  assert.equal(
    byClass(root, 'files-row').some((r) => r.textContent.includes('ws.ts')),
    false,
  );

  (byKey(root, 'fdir:server') as FakeElement).click();
  assert.equal(byClass(root, 'files-row').length, before, 'and come back');

  // A10b: the file lands as a TAB of the editor pane of its root folder's tab
  // — here the focused session's project (A10 opened a pane per file; the user
  // asked for one pane with a strip instead).
  const file = byKey(root, 'ffile:web/src/Pane.tsx') as FakeElement;
  assert.equal(file.tagName, 'BUTTON', 'a row that opens a file is a button, not a hover');
  file.click();
  const v = st.activeView() as ViewLike;
  assert.deepEqual(v.root, { kind: 'project', id: 'p1' }, 'the project of the focused session');
  assert.deepEqual(shapeOf(v), ['*web/src/Pane.tsx']);
  assert.equal(st.state.activeViewId, v.id, 'and the app goes there');

  panel.render();
  assert.equal(
    (byKey(root, 'ffile:web/src/Pane.tsx') as FakeElement).classList.contains('is-open'),
    true,
    'the tree says where the panes are standing',
  );
  assert.equal(
    (byKey(root, 'ffile:web/src/store.ts') as FakeElement).classList.contains('is-open'),
    false,
    'and only there',
  );

  // Opening the same file twice must not spend a second pane — or a second
  // CHIP — on a copy: the second click RAISES what is already open (A10b).
  (byKey(root, 'ffile:web/src/store.ts') as FakeElement).click();
  assert.deepEqual(shapeOf(st.activeView()), ['web/src/Pane.tsx *web/src/store.ts'],
    'the second file is a TAB of the same pane, and it is the one showing');
  (byKey(root, 'ffile:web/src/Pane.tsx') as FakeElement).click();
  assert.equal((st.activeView() as ViewLike).slots.length, 1, 'still one pane');
  assert.deepEqual(shapeOf(st.activeView()), ['*web/src/Pane.tsx web/src/store.ts'],
    'and the first file was raised where it stood, never opened twice');
});

// ---------------------------------------------------------------------------
// A file row as a source: click, drag, chord (Nocturne A10)
// ---------------------------------------------------------------------------

/** The panes of the tab the app is standing in. */
function slotsNow(): PaneSlot[] {
  return (st.activeView() as ViewLike).slots;
}

/**
 * A view's panes as one readable picture: a session id, or the file tabs of an
 * editor pane in strip order, the ACTIVE one starred (A10b: a file is a TAB of
 * a pane, not a pane).
 */
function shapeOf(v: ViewLike | null): string[] {
  if (v === null) return [];
  return v.slots.map((s) =>
    s.kind === 'session'
      ? `session ${s.id}`
      : s.tabs
          .map((t, i) => `${i === s.active ? '*' : ''}${t.kind === 'file' ? t.path : `${t.hash}:${t.path}`}`)
          .join(' '),
  );
}

/** Is this file open ANYWHERE at all — as a tab of any pane of any tab? */
function anyFileSlot(): boolean {
  return st.state.views.some((v) =>
    v.slots.some((slot) => st.slotTabIds(slot).some((id) => id.startsWith('f:'))),
  );
}

/**
 * Force a rebuild. The panel repaints on a SIGNATURE, so a test that pokes
 * `state.views` directly (instead of going through an action that notifies)
 * must drop the cache the way hiding and re-showing the panel does.
 */
function repaint(): void {
  st.state.leftPanel = null;
  panel.render();
  st.state.leftPanel = 'files';
  panel.render();
}

test('with nothing running, a file row opens into the Home tab — never a nameless one', () => {
  st.state.leftPanel = 'files';
  panel.render();
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'non-vacuity: the Home subject');

  (byKey(root, 'ffile:web/src/store.ts') as FakeElement).click();
  const v = st.activeView() as ViewLike;
  assert.deepEqual(v.root, { kind: 'home' });
  assert.equal(st.state.views[0]?.id, v.id, 'Home is the fixed first tab');
  assert.deepEqual(shapeOf(v), ['*web/src/store.ts']);
});

test('a session WITHOUT a project sends its files to Home (the A10 gap B2 closes)', () => {
  st.setProjects([]);
  st.setSessions([mkSession('s9', { title: 'scratch shell', command: 'bash' })]);
  st.state.leftPanel = 'files';
  panel.render();
  assert.equal(textsOf(root, 'files-proj')[0], 'scratch shell', 'non-vacuity: not the Home subject');

  (byKey(root, 'ffile:web/src/store.ts') as FakeElement).click();
  assert.deepEqual((st.activeView() as ViewLike).root, { kind: 'home' });
});

test('a file row is a pointer drag source — and says so, naming its keyboard twin', async () => {
  liveSession();
  const file = byKey(root, 'ffile:web/src/Pane.tsx') as FakeElement;
  assert.match(file.title, /ctrl\+alt\+enter/, `the row must name its twin: ${file.title}`);
  assert.match(file.title, /Drag/);

  // A drag past the threshold must NOT also fire the row's click (ui/dnd.ts
  // swallows it), so the file does not open twice and in the wrong place.
  dispatch(file, 'pointerdown', { clientX: 10, clientY: 10, pointerId: 4 });
  assert.equal(file.classList.contains('is-dragging'), false, 'not yet: 0px is not a drag');
  dispatch(dom.body, 'pointermove', { clientX: 60, clientY: 40, pointerId: 4 });
  assert.equal(file.classList.contains('is-dragging'), true, 'the row recedes once picked up');
  assert.equal(byClass(dom.body, 'drag-ghost').length, 1, 'one ghost, carrying the name');
  assert.equal(byClass(dom.body, 'drag-ghost')[0]?.textContent, 'Pane.tsx', 'a NAME, never a path');

  dispatch(dom.body, 'pointerup', { clientX: 60, clientY: 40, pointerId: 4 });
  assert.equal(byClass(dom.body, 'drag-ghost').length, 0, 'the ghost goes with the gesture');
  assert.equal(file.classList.contains('is-dragging'), false);
  assert.equal(anyFileSlot(), false, 'a drag onto nothing opens nothing');
  // ui/dnd.ts swallows the click that a finished drag would otherwise fire,
  // for 80ms of REAL time. Wait it out, or the next test's click is eaten.
  await new Promise((r) => setTimeout(r, 90));
});

test('ctrl+alt+enter on a focused row splits the focused pane — the twin of the edge drop', () => {
  liveSession();
  // One pane in the project tab: the only split it offers is left/right.
  (byKey(root, 'ffile:web/src/store.ts') as FakeElement).click();
  const v = st.activeView() as ViewLike;
  assert.equal(v.slots.length, 1, 'non-vacuity: one pane to split');

  const file = byKey(root, 'ffile:web/src/Pane.tsx') as FakeElement;
  file.focus();
  const e = dispatch(file, 'keydown', { key: 'Enter', ctrlKey: true, altKey: true });
  assert.equal(e.defaultPrevented, true, 'the row owns the chord, so nothing else may act on it');
  assert.deepEqual(shapeOf(st.activeView()), ['*web/src/Pane.tsx', '*web/src/store.ts'],
    'the new file took the left half of the pane it split — its OWN editor pane');
  assert.equal(slotsNow().length, 2, 'the chord splits; it never adds to the strip');
});

test('the chord is ctrl+alt+enter only: AltGr, plain Enter and ctrl+enter are left alone', () => {
  liveSession();
  const file = byKey(root, 'ffile:web/src/Pane.tsx') as FakeElement;
  file.focus();
  for (const init of [
    { key: 'Enter' },
    { key: 'Enter', ctrlKey: true },
    { key: 'Enter', altKey: true },
    // AltGr reports as ctrl+alt on European layouts: taking it would make a
    // keyboard character untypeable (frontend-terminal-quirks).
    { key: 'Enter', ctrlKey: true, altKey: true, altGraph: true },
    { key: 'w', ctrlKey: true, altKey: true },
  ]) {
    const e = dispatch(file, 'keydown', init);
    assert.equal(e.defaultPrevented, false, `${JSON.stringify(init)} is not this row's key`);
  }
  assert.equal(anyFileSlot(), false, 'and nothing opened');
});

test('`is-open` follows the TABS, in any tab, active chip or not (A10b)', () => {
  // The A10 spelling of this asked whether the file was a PANE (`slotKey`).
  // Since A10b a file is a CHIP in a strip and a pane's key is its own `e:<n>`,
  // so that question could never say yes again — a silently dead class.
  liveSession();
  const isOpen = (path: string): boolean =>
    (byKey(root, `ffile:${path}`) as FakeElement).classList.contains('is-open');
  assert.equal(isOpen('web/src/Pane.tsx'), false, 'non-vacuity: nothing is open yet');

  (byKey(root, 'ffile:web/src/Pane.tsx') as FakeElement).click();
  panel.render();
  assert.equal(isOpen('web/src/Pane.tsx'), true);

  // A second file joins the same strip. The first one is no longer the ACTIVE
  // chip, and it is still open — the class is about the file being on screen's
  // strip, not about which chip is up.
  (byKey(root, 'ffile:web/src/store.ts') as FakeElement).click();
  panel.render();
  assert.deepEqual(shapeOf(st.activeView()), ['web/src/Pane.tsx *web/src/store.ts']);
  assert.equal(isOpen('web/src/Pane.tsx'), true, 'a background chip is open too');
  assert.equal(isOpen('web/src/store.ts'), true);
  assert.equal(isOpen('web/src/TabStrip.tsx'), false, 'and only the files that are really open');

  // Another tab entirely: the row still says the file is on screen, because it
  // is. The class is about the FILE, not about which tab is in front.
  st.state.views.push({ id: 'v-other', root: null, slots: [], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } });
  st.state.activeViewId = 'v-other';
  repaint();
  assert.equal(isOpen('web/src/Pane.tsx'), true, 'open somewhere is open');

  // And it goes away with the strip: the panel must never ground a row for a
  // file nothing shows.
  const owner = st.state.views.find((v) => v.slots.some((x) => x.kind === 'editor')) as ViewLike;
  owner.slots = owner.slots.filter((x) => x.kind !== 'editor');
  repaint();
  assert.equal(isOpen('web/src/Pane.tsx'), false);
  assert.equal(isOpen('web/src/store.ts'), false);
});

test('the header follows the VIEW root while a FILE pane is focused, not the tab\'s session', () => {
  // The trap this closes: a folder tab holding a file pane beside a terminal
  // from another project would flip the header to that project the moment the
  // file pane took the focus — a tree headed by a folder it is not about.
  st.setProjects([project('p1', 'api'), project('p2', 'tools')]);
  st.setSessions([mkSession('s1', { projectId: 'p2' })]);
  st.state.views = [
    {
      id: 'vf',
      root: { kind: 'project', id: 'p1' },
      slots: [ed('web/src/Pane.tsx'), { kind: 'session', id: 's1' }],
      focused: 0,
      l3: 'L',
      split: { col: 0.5, row: 0.5 },
    },
  ];
  st.state.activeViewId = 'vf';
  st.state.leftPanel = 'files';
  repaint();
  assert.equal(textsOf(root, 'files-proj')[0], 'api', "the FILE pane's tab, not the terminal's project");

  // Focus the terminal instead: now the session's project is the subject.
  (st.state.views[0] as ViewLike).focused = 1;
  repaint();
  assert.equal(textsOf(root, 'files-proj')[0], 'tools');
});

test('a DIFF pane is about its tab too, and Home reads Home', () => {
  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  st.state.views = [
    {
      id: 'vh',
      root: { kind: 'home' },
      slots: [st.newEditorSlot([{ kind: 'diff', hash: 'a1b2c3d', path: 'web/src/Pane.tsx' }])],
      focused: 0,
      l3: 'L',
      split: { col: 0.5, row: 0.5 },
    },
  ];
  st.state.activeViewId = 'vh';
  st.state.leftPanel = 'files';
  repaint();
  assert.equal(textsOf(root, 'files-proj')[0], 'Home');
  assert.equal(
    (byKey(root, 'ftab:commits') as FakeElement).disabled,
    true,
    'and Home has no repository, however the panel got there',
  );
});

test('a file pane in a ROOTLESS tab is about THAT tab session, not the first alive anywhere', () => {
  // A file reaches a plain session tab by a drop on a terminal pane edge, or by
  // ctrl+alt+enter. The tab has no folder, so the fallback used to name the
  // first live session ANYWHERE — an unrelated project in the header, and the
  // next file opened into that project's folder.
  st.setProjects([project('p1', 'api'), project('p2', 'tools')]);
  st.setSessions([mkSession('s2', { projectId: 'p1' }), mkSession('s1', { projectId: 'p2' })]);
  st.state.views = [
    { id: 'vo', root: null, slots: [{ kind: 'session', id: 's2' }], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
    {
      id: 'vf',
      root: null,
      slots: [ed('web/src/Pane.tsx'), { kind: 'session', id: 's1' }],
      focused: 0,
      l3: 'L',
      split: { col: 0.5, row: 0.5 },
    },
  ];
  st.state.activeViewId = 'vf';
  st.state.leftPanel = 'files';
  repaint();
  assert.equal(
    textsOf(root, 'files-proj')[0],
    'tools',
    "the tab's own session — `api` is another tab's story",
  );

  // And the header and the landing tab can never disagree: the next row opens
  // into the folder the header names.
  (byKey(root, 'ffile:web/src/store.ts') as FakeElement).click();
  assert.deepEqual((st.activeView() as ViewLike).root, { kind: 'project', id: 'p2' });
});

test('a file pane in a rootless tab with NO session of its own reads Home', () => {
  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s2', { projectId: 'p1' })]);
  st.state.views = [
    { id: 'vo', root: null, slots: [{ kind: 'session', id: 's2' }], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
    { id: 'vf', root: null, slots: [ed('web/src/Pane.tsx')], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
  ];
  st.state.activeViewId = 'vf';
  st.state.leftPanel = 'files';
  repaint();
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'no folder and no session: Home, not `api`');

  (byKey(root, 'ffile:web/src/store.ts') as FakeElement).click();
  assert.deepEqual((st.activeView() as ViewLike).root, { kind: 'home' });
});

test('every file row carries a colour-family badge, including the ones behind a closed folder', () => {
  liveSession();
  const badges = byClass(root, 'files-badge');
  assert.ok(badges.length > 0);
  for (const b of badges) assert.equal(b.getAttribute('aria-hidden'), 'true');
  const kindOf = new Map(badges.map((b) => [b.textContent, b.dataset.kind]));
  assert.equal(kindOf.get('TSX'), 'ts');
  assert.equal(kindOf.get('TS'), 'ts', 'one family, two marks');
  assert.equal(kindOf.get('MD'), 'md');
  assert.equal(kindOf.get('{ }'), 'json');
  assert.equal(
    kindOf.get('·'),
    'plain',
    'the neutral chip is on screen too: the mock carries a file whose type the table does not know',
  );

  // The families that only appear once a closed folder is opened.
  (byKey(root, 'fdir:launcher') as FakeElement).click();
  const opened = new Map(byClass(root, 'files-badge').map((b) => [b.textContent, b.dataset.kind]));
  assert.equal(opened.get('PS'), 'ps');
  assert.equal(opened.get('JS'), 'js', 'a .mjs is JavaScript, not an unknown type');
});

test('the caret is decoration: aria-hidden, and the folder row itself states the state', () => {
  liveSession();
  for (const c of byClass(root, 'files-caret')) assert.equal(c.getAttribute('aria-hidden'), 'true');
  const web = byKey(root, 'fdir:web') as FakeElement;
  assert.equal(web.children[0]?.textContent, '▾');
  assert.equal(web.getAttribute('aria-expanded'), 'true');
});

test('both tabs say, quietly and first, that what is under them is not the real repository', () => {
  // The panel carries the user's REAL project name over `ui/files-mock.ts`
  // content. Until B2/B3 read the repository, one plain line per tab keeps
  // that from reading as a report about their files.
  liveSession();
  assert.deepEqual(textsOf(root, 'files-note'), [
    'Example data until the panel reads your files.',
  ]);
  assert.equal(
    (body.children[0] as FakeElement).classList.contains('files-note'),
    true,
    'first thing in the body',
  );

  (byKey(root, 'ftab:commits') as FakeElement).click();
  assert.deepEqual(textsOf(root, 'files-note'), [
    'Example data until the panel reads your commits.',
  ]);
  assert.equal((body.children[0] as FakeElement).classList.contains('files-note'), true);

  // ONE render site, so B2/B3 remove it by deleting one function and one
  // argument — not by hunting two branches.
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'files.ts'), 'utf8');
  assert.equal(src.split('placeholderNote(').length - 1, 2, 'one definition, one call site');

  (byKey(root, 'ftab:files') as FakeElement).click(); // the tab is panel-local state
});

test('the Commits tab swaps the body and hides the summary; both tabs say which is up', () => {
  liveSession();
  const files = byKey(root, 'ftab:files') as FakeElement;
  const commits = byKey(root, 'ftab:commits') as FakeElement;
  assert.equal(files.getAttribute('aria-pressed'), 'true');
  assert.equal(commits.getAttribute('aria-pressed'), 'false');

  commits.click();
  assert.equal(commits.getAttribute('aria-pressed'), 'true');
  assert.equal(files.getAttribute('aria-pressed'), 'false');
  assert.equal(summary.hidden, true, 'a file summary over a commit list would be a lie');
  assert.equal(byClass(root, 'files-row').length, 0);
  assert.equal(textsOf(root, 'files-branch')[0], 'main, 5 commits');

  const rows = byClass(root, 'commit-row');
  assert.equal(rows.length, MOCK.MOCK_COMMITS.length);
  const first = MOCK.MOCK_COMMITS[0] as MockModule['MOCK_COMMITS'][number];
  assert.equal(textsOf(root, 'commit-msg')[0], first.message);
  assert.equal(textsOf(root, 'commit-hash')[0], first.hash);
  assert.ok(rows[0]?.textContent.includes(first.when));
  assert.ok(rows[0]?.textContent.includes(`+${first.add}`));
  // A6: a commit row opens the full commit view.
  assert.equal(rows[0]?.tagName, 'BUTTON', 'a commit row is a control now, not a card');
  assert.equal(rows[0]?.getAttribute('data-k'), `commit:${first.hash}`);

  files.click();
  assert.equal(summary.hidden, false);
  assert.ok(byClass(root, 'files-row').length > 0, 'and the tree comes back');
});

// ---------------------------------------------------------------------------
// The Commits tab at Home (Nocturne A11)
// ---------------------------------------------------------------------------

test('with nothing alive there is no repository, so the Commits tab is not viewable', () => {
  // User decision 2026-09-15: the panel is up from the first paint, headed
  // `Home` — and a home folder is not a repository, so a commit list there
  // would be a view on nothing.
  st.state.leftPanel = 'files';
  st.state.drawer = null;
  panel.render();
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'non-vacuity: this is the Home state');

  const commits = byKey(root, 'ftab:commits') as FakeElement;
  const files = byKey(root, 'ftab:files') as FakeElement;
  assert.equal(commits.disabled, true, 'really disabled, not merely dimmed');
  assert.equal(commits.getAttribute('aria-disabled'), 'true');
  assert.equal(commits.title, 'No repository at Home', 'and it says why, on hover and aloud');
  assert.equal(files.disabled, false, 'the tree is still there to look at');
  assert.equal(files.getAttribute('aria-pressed'), 'true');
});

test('the last session exiting takes the Commits tab away under the user, and lands on Files', () => {
  liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  assert.equal(
    (byKey(root, 'ftab:commits') as FakeElement).getAttribute('aria-pressed'),
    'true',
    'non-vacuity: the panel really is standing on Commits',
  );
  assert.equal((byKey(root, 'ftab:commits') as FakeElement).disabled, false);

  st.markExited('s1', 0);
  panel.render();
  assert.equal(textsOf(root, 'files-proj')[0], 'Home');
  assert.equal(st.aliveSessionCount(), 0, 'non-vacuity: nothing is running');

  const commits = byKey(root, 'ftab:commits') as FakeElement;
  const files = byKey(root, 'ftab:files') as FakeElement;
  assert.equal(commits.disabled, true);
  assert.equal(commits.getAttribute('aria-disabled'), 'true');
  assert.equal(commits.title, 'No repository at Home');
  assert.equal(commits.getAttribute('aria-pressed'), 'false', 'the panel did not stay on it');
  assert.equal(files.getAttribute('aria-pressed'), 'true');
  assert.equal(files.classList.contains('is-on'), true);
  assert.ok(byClass(root, 'files-row').length >= 10, 'and the tree is what it fell back to');
  assert.equal(byClass(root, 'commit-row').length, 0, 'no commit list survives the fall back');
});

test('a session appearing again gives the Commits tab back, title and all', () => {
  st.state.leftPanel = 'files';
  panel.render();
  assert.equal(
    (byKey(root, 'ftab:commits') as FakeElement).disabled,
    true,
    'non-vacuity: it starts unavailable',
  );

  liveSession();
  const commits = byKey(root, 'ftab:commits') as FakeElement;
  assert.equal(commits.disabled, false);
  assert.equal(commits.getAttribute('aria-disabled'), null, 'the reason is gone with the state');
  assert.equal(commits.title, '');

  commits.click();
  assert.equal(commits.getAttribute('aria-pressed'), 'true', 'and it leads somewhere again');
  assert.equal(textsOf(root, 'files-branch')[0], 'main, 5 commits');
  (byKey(root, 'ftab:files') as FakeElement).click(); // the tab is panel-local state
});

test('clicking the disabled Commits tab switches nothing (the fake DOM still fires it)', () => {
  // fake-dom's click() dispatches whatever the button's `disabled` says — a
  // real browser fires nothing — so this pins the panel's own guard, which is
  // what keeps a stray programmatic click out of a view on nothing.
  st.state.leftPanel = 'files';
  panel.render();
  const commits = byKey(root, 'ftab:commits') as FakeElement;
  assert.equal(commits.disabled, true, 'non-vacuity: the guard is the subject here');

  commits.click();
  assert.equal(commits.getAttribute('aria-pressed'), 'false');
  assert.equal(commits.classList.contains('is-on'), false);
  assert.equal((byKey(root, 'ftab:files') as FakeElement).getAttribute('aria-pressed'), 'true');
  assert.ok(byClass(root, 'files-row').length >= 10, 'still the tree');
  assert.equal(byClass(root, 'commit-row').length, 0);
});

// ---------------------------------------------------------------------------
// The Commits tab while a commit is open (Nocturne A6)
// ---------------------------------------------------------------------------

test('clicking a commit opens the commit view, and the tab becomes its selected state', () => {
  liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  const first = MOCK.MOCK_COMMITS[0] as MockModule['MOCK_COMMITS'][number];

  (byKey(root, `commit:${first.hash}`) as FakeElement).click();
  assert.equal(st.state.openCommit, first.hash, 'the panel opens the view, it does not draw it');

  // The selected state: a back control, the message, the meta line, and one
  // row per file — the commit list itself is gone.
  const sel = byClass(root, 'files-selhd')[0] as FakeElement;
  assert.equal(sel.hidden, false);
  assert.equal(textsOf(root, 'files-selmsg')[0], first.message);
  assert.equal(textsOf(root, 'commit-hash')[0], first.hash);
  assert.ok(sel.textContent.includes(first.author) && sel.textContent.includes(first.when));
  assert.equal(byClass(root, 'commit-row').length, 0, 'the list gave way to the one commit');
  assert.equal(textsOf(root, 'files-branch')[0], `${first.files.length} files changed`);
  assert.deepEqual(textsOf(root, 'commit-fpath'), first.files.map((f) => f.path));
  const nums = byClass(root, 'commit-file')[0] as FakeElement;
  assert.ok(nums.textContent.includes(`+${(first.files[0] as { add: number }).add}`));
});

test('a file row in the selected state folds that file in the view, and says which state it is in', () => {
  liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  const first = MOCK.MOCK_COMMITS[0] as MockModule['MOCK_COMMITS'][number];
  (byKey(root, `commit:${first.hash}`) as FakeElement).click();
  const path = (first.files[0] as { path: string }).path;

  const row = byKey(root, `cfile:${path}`) as FakeElement;
  assert.equal(row.tagName, 'BUTTON');
  assert.equal(row.getAttribute('aria-expanded'), 'true', 'a commit opens fully expanded');
  row.click();
  assert.equal(st.commitFileCollapsed(first.hash, path), true, 'the SAME key the view folds by');
  const after = byKey(root, `cfile:${path}`) as FakeElement;
  assert.equal(after.getAttribute('aria-expanded'), 'false');
  assert.equal(after.classList.contains('is-collapsed'), true, 'a folded file recedes');

  // The other file is untouched.
  const other = (first.files[1] as { path: string }).path;
  assert.equal(st.commitFileCollapsed(first.hash, other), false);
});

test('a file row NAMES the block it expands — the block lives in another region', () => {
  // `aria-expanded` with nothing to point at leaves a reader with "expanded
  // what?": the block is in the commit VIEW, not in this panel.
  liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  const first = MOCK.MOCK_COMMITS[0] as MockModule['MOCK_COMMITS'][number];
  (byKey(root, `commit:${first.hash}`) as FakeElement).click();
  assert.ok(first.files.length > 1, 'non-vacuity: more than one row');
  for (const f of first.files) {
    const row = byKey(root, `cfile:${f.path}`) as FakeElement;
    assert.equal(
      row.getAttribute('aria-controls'),
      MODEL.blockDomId(first.hash, f.path),
      `${f.path}: the id the view gives that block`,
    );
  }
});

test('All commits closes the whole view and hands the keyboard back', () => {
  liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  const first = MOCK.MOCK_COMMITS[0] as MockModule['MOCK_COMMITS'][number];
  (byKey(root, `commit:${first.hash}`) as FakeElement).click();

  const back = byKey(root, 'commit:all') as FakeElement;
  assert.equal(back.textContent, 'All commits', 'words only — the chevron is a drawn mark beside them');
  back.click();
  assert.equal(st.state.openCommit, null, 'one commit is open or none is');
  assert.equal(handBacks, 1);
  assert.equal((byClass(root, 'files-selhd')[0] as FakeElement).hidden, true);
  assert.equal(byClass(root, 'commit-row').length, MOCK.MOCK_COMMITS.length, 'the list is back');
});

test('switching to the Files tab while a commit is open keeps the VIEW open', () => {
  liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  const first = MOCK.MOCK_COMMITS[0] as MockModule['MOCK_COMMITS'][number];
  (byKey(root, `commit:${first.hash}`) as FakeElement).click();

  (byKey(root, 'ftab:files') as FakeElement).click();
  assert.equal(st.state.openCommit, first.hash, 'only the PANEL is gated on the tab, never the view');
  assert.equal((byClass(root, 'files-selhd')[0] as FakeElement).hidden, true);
  assert.ok(byClass(root, 'files-row').length > 0, 'the tree is what the Files tab shows');

  (byKey(root, 'ftab:commits') as FakeElement).click();
  assert.equal((byClass(root, 'files-selhd')[0] as FakeElement).hidden, false, 'and back again');
  st.closeCommitView();
  (byKey(root, 'ftab:files') as FakeElement).click();
});

test('a rebuild keeps the keyboard where it was (folder rows are re-created wholesale)', () => {
  liveSession();
  const server = byKey(root, 'fdir:server') as FakeElement;
  server.focus();
  server.click();
  const after = byKey(root, 'fdir:server') as FakeElement;
  assert.notEqual(after, server, 'non-vacuity: the row really was rebuilt');
  assert.equal(dom.doc.activeElement, after, 'focus follows the same control, not the panel edge');
});

// ---------------------------------------------------------------------------
// The shell wiring (web/src/main.ts), read from the source
// ---------------------------------------------------------------------------

const MAIN = readFileSync(join(here, '..', 'web', 'src', 'main.ts'), 'utf8');

test('main.ts constructs the panel — on the aside it just created', () => {
  assert.ok(MAIN.includes('function buildShell'), 'non-vacuity: main.ts still builds the shell');
  // Since A9 the module also hands main.ts the destination NAMES the drop
  // layer asks for, so the import is a list — `initFilesPanel` must still be
  // in it, whatever else joined it.
  assert.match(MAIN, /import \{[^}]*\binitFilesPanel\b[^}]*\} from '\.\/ui\/files\.ts';/s);
  assert.match(
    MAIN,
    /const filesPanel = initFilesPanel\(filesAside, requestTerminalFocus\);/,
    'the panel must be initialised with the files aside, or nothing is ever built',
  );
});

test('main.ts renders the panel on every state change AND once at boot', () => {
  const sub = MAIN.slice(MAIN.indexOf('st.subscribe('));
  assert.ok(sub.length > 200, 'non-vacuity: the subscribe block was found');
  const block = sub.slice(0, sub.indexOf('// ---- global keyboard'));
  const calls = block.split('filesPanel.render();').length - 1;
  assert.equal(calls, 2, 'once inside subscribe, once for the first paint');
});

test('the Files aside is a flex sibling BEFORE the grid — that is what resizes the panes', () => {
  // The middle row's occupants change with the parts (A6 added the commit
  // view and an editor column; A10 took the editor away again), so what is
  // pinned is the INVARIANT and not the cast: ONE `main.append(...)` call,
  // the Files aside inside it, after the projects drawer and before the grid.
  // That order is what makes opening the panel narrow the grid for real, and
  // therefore what drives the fit -> ws `resize` chain.
  const call = /main\.append\(([^)]*)\);/.exec(MAIN);
  assert.notEqual(call, null, 'the middle row must still be appended in one call');
  const order = (call?.[1] ?? '').split(',').map((s) => s.trim());
  assert.ok(order.length >= 4, `non-vacuity: parsed ${order.join(' ')}`);
  const at = (name: string): number => order.indexOf(name);
  assert.ok(at('projAside') >= 0 && at('filesAside') >= 0 && at('grid') >= 0, order.join(' '));
  assert.ok(at('projAside') < at('filesAside'), 'the Files panel sits after the projects drawer');
  assert.ok(at('filesAside') < at('grid'), 'and BEFORE the grid — a sibling, never an overlay');
  assert.ok(at('grid') < at('sessAside'), 'the sessions drawer stays on the right');
});

test('the Files button is a live toggle, not the disabled placeholder A2 shipped', () => {
  assert.match(MAIN, /button\('tb-btn', 'Files', \(\) => st\.toggleLeftPanel\('files'\)\)/);
  assert.equal(
    /filesBtn\.disabled = true/.test(MAIN),
    false,
    'A5 turned the placeholder into a real control',
  );
});

test('the chrome hides the panel through filesPanelVisible(), never through the wish alone', () => {
  assert.match(MAIN, /const filesShown = st\.filesPanelVisible\(\);/);
  assert.match(MAIN, /filesAside\.hidden = !filesShown;/);
  // `aria-pressed` states what is ON SCREEN; only the CSS class carries the
  // wish. Announcing an open panel while nothing is rendered is a lie to a
  // screen reader, and the wish is true by default from the first paint.
  assert.match(MAIN, /filesBtn\.setAttribute\('aria-pressed', filesShown \? 'true' : 'false'\);/);
  assert.match(MAIN, /filesBtn\.classList\.toggle\('is-on', filesOn\);/);
});

test('the button title names the ONE state the panel is wanted but not on screen', () => {
  // User decision 2026-09-15: no session is required any more, so the only way
  // a wanted panel is off screen is the Projects drawer standing in its place.
  // Source-read, like the rest of this block: main.ts imports @xterm/xterm, so
  // there is no DOM harness that can run updateChrome() under `node --test`.
  assert.match(
    MAIN,
    /filesBtn\.title = filesOn && !filesShown \? 'Hidden while Projects is open' : 'Files';/,
  );
  assert.equal(
    MAIN.includes('Opens when a session is running'),
    false,
    'the old sentence promised a panel that now needs no session',
  );
  assert.equal(MAIN.includes('filesLive'), false, 'and the alive-session read it hung on is gone');
});

test('Escape closes the panel only when the focus is inside it', () => {
  const from = MAIN.indexOf("e.key === 'Escape'");
  assert.notEqual(from, -1, 'non-vacuity: the Escape branch was found');
  const branch = MAIN.slice(from, MAIN.indexOf('// ---- reliability'));
  assert.ok(branch.length > 200 && branch.length < 4000, 'non-vacuity: and it is the handler, not the file');
  assert.match(branch, /filesAside\.contains\(document\.activeElement\)/);
  assert.match(branch, /st\.toggleLeftPanel\('files'\)/);
});

test('Escape hands the keyboard back to the terminal, in BOTH branches that close a surface', () => {
  // The surface that held the focus disappears; without this the focus falls
  // to <body> and typing goes nowhere until the next window activation (the
  // same fix ui-restart-guards.test.ts pins for the restart dialog).
  assert.match(MAIN, /import \{[^}]*requestTerminalFocus[^}]*\} from '\.\/ui\/panes\.ts';/s);
  const from = MAIN.indexOf("e.key === 'Escape'");
  const branch = MAIN.slice(from, MAIN.indexOf('// ---- reliability'));
  const arms = branch.split('} else if');
  const drawerArm = arms.find((a) => a.includes('st.closeDrawer();'));
  const filesArm = arms.find((a) => a.includes("st.toggleLeftPanel('files');"));
  assert.ok(drawerArm !== undefined && filesArm !== undefined, 'non-vacuity: both arms were found');
  assert.match(
    drawerArm,
    /st\.closeDrawer\(\);[\s\S]*handBackKeyboard\(wasProjects \? projectsBtn : sessionsBtn\);/,
  );
  // The Files arm goes through `handBackKeyboard`, which calls
  // requestTerminalFocus() and, when no terminal took the key (the panel is
  // reachable with no session at all), focuses a visible control instead.
  assert.match(filesArm, /st\.toggleLeftPanel\('files'\);[\s\S]*handBackKeyboard\(filesBtn\);/);
  assert.match(
    MAIN,
    /function handBackKeyboard\(fallback: HTMLElement\): void \{[\s\S]*requestTerminalFocus\(\);[\s\S]*fallback\.focus\(\);/,
  );
  // The GUARD, not just the call. main.ts bootstraps the whole app on import
  // and `handBackKeyboard` is a closure-local, so no DOM harness can reach it
  // and this source pin is the only thing standing between the helper and an
  // inverted condition — which would steal the keyboard back FROM a terminal
  // that did take it, the exact bug the helper exists to avoid. Measured: with
  // `a !== null && a !== document.body` the whole suite stayed green.
  assert.match(
    MAIN,
    /const a = document\.activeElement;\s*\n\s*if \(a === null \|\| a === document\.body\) fallback\.focus\(\);/,
  );
});

// ---------------------------------------------------------------------------
// The other half of a badge: its colour pair has to exist
// ---------------------------------------------------------------------------

test('every colour family the model can emit is defined in tokens.css and mapped in app.css', () => {
  // `badgeFor()` only NAMES a family; `--badge-<kind>-bg/fg` and the
  // `[data-kind]` rule are what make the chip visible. A kind added or renamed
  // on one side only renders an unstyled chip, which no DOM test can see.
  const model = readFileSync(join(here, '..', 'web', 'src', 'ui', 'files-model.ts'), 'utf8');
  const tokens = readFileSync(join(here, '..', 'web', 'src', 'styles', 'tokens.css'), 'utf8');
  const app = readFileSync(join(here, '..', 'web', 'src', 'styles', 'app.css'), 'utf8');
  const kinds = new Set(Array.from(model.matchAll(/kind: '([a-z]+)'/g), (m) => m[1] as string));
  assert.ok(kinds.size >= 13, `non-vacuity: found ${kinds.size} families in files-model.ts`);
  assert.ok(kinds.has('plain'), 'the fallback family is one of them');

  const missing: string[] = [];
  for (const k of kinds) {
    if (!tokens.includes(`--badge-${k}-bg:`)) missing.push(`tokens.css --badge-${k}-bg`);
    if (!tokens.includes(`--badge-${k}-fg:`)) missing.push(`tokens.css --badge-${k}-fg`);
    // `plain` is the base rule's own colour, so it needs no data-kind selector.
    if (k !== 'plain' && !app.includes(`.files-badge[data-kind='${k}']`)) {
      missing.push(`app.css .files-badge[data-kind='${k}']`);
    }
  }
  assert.deepEqual(missing, [], 'a badge family with no colours is an invisible mark');
  assert.match(app, /\.files-badge \{[^}]*background: var\(--badge-plain-bg\)/s, 'the base chip IS plain');
});

// ---------------------------------------------------------------------------
// The twin of the Explorer drag, and the destination NAMES (part A9)
// ---------------------------------------------------------------------------

test('the panel carries a real `Copy files here…` button whose title names the destination', () => {
  liveSession();
  const btn = byKey(root, 'fcopy') as FakeElement;
  assert.ok(btn !== null, 'the drag has a visible twin — a gesture-only affordance is forbidden');
  assert.equal(btn.tagName, 'BUTTON');
  assert.equal(btn.textContent, 'Copy files here…');
  assert.equal(btn.title, 'Copy files into api', 'the live destination, by NAME');
  // It is not inside the tree body: it must stay put while the tree scrolls and
  // while the Commits tab hides the summary row.
  assert.equal(byClass(root, 'files-copy')[0]?.contains(btn), true);
  assert.equal(body.contains(btn), false);
});

test('focusing a folder row moves the destination to that folder, and the title with it', () => {
  liveSession();
  const btn = byKey(root, 'fcopy') as FakeElement;
  const dir = byKey(root, 'fdir:web/src') as FakeElement;
  assert.ok(dir !== null, 'non-vacuity: the mock tree really has that folder row');

  dir.focus();
  assert.equal(F.pasteDestination(), 'src', 'its own name, never its path');
  assert.equal(btn.title, 'Copy files into src');

  // Focus back out of the panel entirely: the panel s own root answers again.
  const outside = dom.doc.createElement('button');
  dom.body.append(outside);
  outside.focus();
  assert.equal(F.pasteDestination(), 'api');
  assert.equal(btn.title, 'Copy files into api');
  outside.remove();
});

test('the copy button keeps the folder the keyboard came from — it has no other twin', () => {
  // Clicking or tabbing to `Copy files here…` takes the focus off the folder
  // row, and the folder-row destination has NO button of its own: a
  // destination read from `document.activeElement` at click time would copy
  // into the panel root the title stopped promising a moment ago.
  liveSession();
  const btn = byKey(root, 'fcopy') as FakeElement;
  const dir = byKey(root, 'fdir:web/src') as FakeElement;
  dir.focus();
  assert.equal(F.pasteDestination(), 'src', 'non-vacuity: the row really took it');

  btn.focus();
  assert.equal(F.pasteDestination(), 'src', 'the destination survives the gesture that uses it');
  assert.equal(btn.title, 'Copy files into src', 'and the title keeps its word');

  // Anywhere else INSIDE the panel keeps it too: the tabs, the header.
  const tab = byKey(root, 'ftab:files') as FakeElement;
  tab.focus();
  assert.equal(F.pasteDestination(), 'src');

  // Only leaving the panel clears it.
  const outside = dom.doc.createElement('button');
  dom.body.append(outside);
  outside.focus();
  assert.equal(F.pasteDestination(), 'api', 'the panel s own root again');
  outside.remove();
});

/**
 * Drop the panel's remembered folder row, the way the app does: focus leaving
 * the panel altogether. The memory is module state in `ui/files.ts` and
 * survives a `render()`, so a test that focused a row hands it back.
 */
function clearRowMemory(): void {
  const outside = dom.doc.createElement('button');
  dom.body.append(outside);
  outside.focus();
  outside.remove();
}

test('ctrl+alt+c on a focused FOLDER row copies into THAT folder', () => {
  // The strip button sits BEFORE the tree and every row here is a <button>, so
  // no amount of tabbing aims that one button at a nested folder: forward Tab
  // from a row never reaches it, and Shift+Tab walks back through other folder
  // rows, each of which re-notes itself as the destination. The row-level twin
  // is the only keyboard way to copy into `src` at all.
  liveSession();
  const dir = byKey(root, 'fdir:web/src') as FakeElement;
  assert.ok(dir !== null, 'non-vacuity: the mock tree really has that folder row');
  assert.equal(dir.title, 'Open or close it. Copy files into it with ctrl+alt+c.', 'the row names its own chord');

  dir.focus();
  const e = dispatch(dir, 'keydown', { key: 'c', ctrlKey: true, altKey: true });
  assert.equal(e.defaultPrevented, true);
  assert.equal(e.cancelBubble, true, 'a key this row spent never reaches the window chord handler');
  assert.equal(dropped.length, 1, 'the picker seam ran and handed its files on');
  const req = dropped[0] as DropReq;
  assert.equal(req.dest, 'src', 'its own name, never its path');
  assert.deepEqual(req.items, [{ name: 'shot.png', dir: false, bytes: 7 }]);
  assert.deepEqual(req.listing, F.listingFor('src'), 'the folder s own listing asks the conflict question');
  clearRowMemory();
});

test('the folder-row chord keeps its AltGr guard, and a FILE row has nothing to do with it', () => {
  liveSession();
  // AltGr reports as ctrl+alt on European layouts: typing a character may
  // never open a file chooser.
  const dir = byKey(root, 'fdir:web/src') as FakeElement;
  dir.focus();
  const altGr = dispatch(dir, 'keydown', { key: 'c', ctrlKey: true, altKey: true, altGraph: true });
  assert.equal(altGr.defaultPrevented, false);
  assert.deepEqual(dropped, []);

  // A FILE row copies nothing: a file is not a destination, and its own chord
  // (ctrl+alt+enter) is a different act.
  const file = byKey(root, 'ffile:web/src/Pane.tsx') as FakeElement;
  file.focus();
  const onFile = dispatch(file, 'keydown', { key: 'c', ctrlKey: true, altKey: true });
  assert.equal(onFile.defaultPrevented, false);
  assert.deepEqual(dropped, []);
  clearRowMemory();
});

test('with nothing running the destination is `Home`, exactly as the header reads', () => {
  panel.render();
  assert.equal(byClass(root, 'files-proj')[0]?.textContent, 'Home');
  assert.equal(F.filesPanelDestination(), 'Home');
  assert.equal(F.pasteDestination(), 'Home');
  assert.equal((byKey(root, 'fcopy') as FakeElement).title, 'Copy files into Home');
});

test('a SESSION pane s destination: its session s project, else its tab s folder, else nothing', () => {
  liveSession();
  // The panes on screen are the ACTIVE view's, so that is the view a pane
  // element is asked about; the session's own tab is not the Home tab.
  const v = st.state.views.find((x) => x.slots.length > 0) as ViewLike;
  assert.ok(v !== undefined, 'non-vacuity: the session really got a view');
  st.state.activeViewId = v.id;
  const pane = dom.doc.createElement('section');
  pane.dataset.slot = '0';

  // The ORDER a session pane answers in is the header's own (`subject()`): the
  // session's project first, whatever the tab is rooted at. The two used to
  // disagree — the header read `api` while the ghost over this very pane said
  // `Home` — and one screen may only carry one name.
  v.root = { kind: 'home' };
  assert.equal(F.filesPanelDestination(), 'api', 'non-vacuity: the header names the project');
  assert.deepEqual(F.destinationOfPane(pane), { dest: 'api' });

  v.root = { kind: 'project', id: 'p1' };
  assert.equal(F.destinationOfActiveView(), 'api');
  assert.deepEqual(F.destinationOfPane(pane), { dest: 'api' });

  // A plain session tab: the session s own project answers for its pane.
  v.root = null;
  assert.equal(F.destinationOfActiveView(), null);
  assert.deepEqual(F.destinationOfPane(pane), { dest: 'api' });

  // A session with no project falls back to the folder its TAB is rooted at —
  // the drop lands where the tab already says it is.
  st.setSessions([mkSession('s1')]);
  v.root = { kind: 'home' };
  assert.deepEqual(F.destinationOfPane(pane), { dest: 'Home' });

  st.setProjects([project('p1', 'api')]);
  v.root = { kind: 'project', id: 'p1' };
  assert.deepEqual(F.destinationOfPane(pane), { dest: 'api' }, 'the rooted tab names it');

  // Neither a project nor a rooted tab: no folder this app may name (user
  // decision 4, 2026-09-15), so it is not a target and the drop layer says so
  // instead of guessing a path.
  v.root = null;
  assert.deepEqual(F.destinationOfPane(pane), { dest: null, why: 'session' });
});

test('a FILE pane in a rootless tab borrows the tab s own first session, as the header does', () => {
  // The panel header already answers this case (`subject()`); a pane that
  // answered null instead would flash a sentence about a session that is not
  // in that pane at all.
  liveSession();
  const v = st.state.views.find((x) => x.slots.length > 0) as ViewLike;
  st.state.activeViewId = v.id;
  v.root = null;
  v.slots.push(ed('web/src/App.tsx'));
  const filePane = dom.doc.createElement('section');
  filePane.dataset.slot = String(v.slots.length - 1);
  assert.deepEqual(F.destinationOfPane(filePane), { dest: 'api' }, 'the tab s own session names it');

  // Nothing in the tab to borrow a folder from: the refusal is about the TAB.
  st.setSessions([mkSession('s1')]);
  assert.deepEqual(F.destinationOfPane(filePane), { dest: null, why: 'tab' });
});

test('a destination s listing is the folder s own top-level names', () => {
  // The conflict question is asked against this and nothing else, so it may
  // never carry paths or a recursive walk.
  assert.deepEqual(F.listingFor('src'), ['App.tsx', 'Pane.tsx', 'TabStrip.tsx', 'store.ts']);
  // Anything that is not a folder in the tree is the ROOT of it (`Home`, a
  // project s name) — the A9 mock stands in for the real listing until B2.
  const top = F.listingFor('Home');
  assert.deepEqual(top, ['web', 'server', 'launcher', 'shared', 'README.md', 'LICENSE']);
  assert.deepEqual(F.listingFor('api'), top);
  assert.ok(top.every((n) => !n.includes('/')), 'names, never paths');
});
