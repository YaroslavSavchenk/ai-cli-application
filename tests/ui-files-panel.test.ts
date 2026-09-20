/**
 * `web/src/ui/files.ts` — the Files panel (Nocturne A5, live since B2) driven
 * through the REAL module: the grip dragged with real pointer events, the
 * arrow keys pressed, folder rows clicked, tabs switched — against the REAL
 * `web/src/state.ts`, `ui/util.ts`, `ui/icons.ts`, `ui/files-model.ts`,
 * `ui/fs-model.ts` and, for the Commits tab only, `ui/files-mock.ts`.
 *
 * THE BACKEND IS A FAKE `FsGateway` (part B2). The panel takes it injected, so
 * the whole file browser — lazy listings, the states they pass through, the
 * generation that drops a late answer, the Changes tab and its poll — is
 * driven here with no HTTP, no module stubbing and no clock: a test awaits the
 * fake's own promises. The fixture keeps the A5 names (`README.md`, `web`,
 * `src`, `server`) so the assertions below still read the same.
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
import {
  FakeApiError,
  HOME,
  NO_REPO,
  PROJ,
  PROJ2,
  SCRATCH,
  makeFixture,
  repoAnswer,
  settle,
  type Changes,
  type Entry,
  type Gateway,
} from './fs-fixture.ts';

/** The fake backend every test below drives the panel against (`fs-fixture.ts`). */
const fx = makeFixture();
const { gateway, entryCalls, changeCalls, failWith } = fx;

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
interface Dest {
  path: string;
  name: string;
}
interface DropReq {
  dest: Dest;
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
  listingFor: (dest: Dest) => F.listingFor(dest),
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
  initFilesPanel(host: unknown, onLeaveScreen: () => void, fs: Gateway): { render(): void };
  /** Part A9: where a drop, a paste or the header button would copy to. */
  pasteDestination(): Dest | null;
  /** Part A9b: the folder the user chose — a real folder behind its name. */
  selectedFolder(): Dest | null;
  filesPanelDestination(): Dest | null;
  destinationOfActiveView(): Dest | null;
  destinationOfPane(paneEl: unknown): { dest: Dest } | { dest: null; why: 'session' | 'tab' };
  listingFor(dest: Dest): Promise<readonly string[]>;
  /** Part B10: show what a drop landed, if the panel is showing that folder. */
  refreshAfterDrop(dest: Dest): void;
}


interface ModelModule {
  buildTree(files: readonly { path: string }[]): unknown[];
  treeRows(nodes: readonly unknown[], open: ReadonlySet<string>): { path: string; dir: boolean; busy: boolean }[];
}
interface MockModule {
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
const panel = F.initFilesPanel(
  host,
  () => {
    handBacks += 1;
  },
  gateway,
);
const root = host.children[0] as FakeElement;

/**
 * The statusline, because part B10's `Copy` SAYS what happened there and
 * nowhere else. It is the same double `tests/ui-dnd-a10.test.ts` uses: the
 * real module, in a host of its own, read back through `.status-flash`.
 */
const statusHost = dom.doc.createElement('div');
dom.body.append(statusHost);
const SL = (await import(new URL('../web/src/ui/statusline.ts', import.meta.url).href)) as {
  initStatusline(container: unknown, deps: { openShortcuts(): void }): { render(): void };
};
SL.initStatusline(statusHost, { openShortcuts: () => {} });
// Its 15 s uptime ticker is recorded like every timer in the double, and the
// `Changes` poll is counted by READING that list — so the statusline's own
// interval is taken back off it here, where it is created and never used.
dom.win.intervals.length = 0;

function flashText(): string {
  return byClass(statusHost, 'status-flash')[0]?.textContent ?? '';
}

/** Fire every recorded timer, which is what takes a flash back down. */
function clearFlash(): void {
  const due = [...dom.win.timers];
  dom.win.timers.length = 0;
  for (const t of due) t.fn();
}

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
    cwd: SCRATCH,
    status: 'running',
    cols: 80,
    rows: 24,
    createdAt: new Date().toISOString(),
    attention: false,
    ...over,
  } as SessionInfo;
}

function project(id: string, name: string): Project {
  return { id, name, path: `/work/${name}`, createdAt: new Date().toISOString() } as Project;
}

/**
 * Which root the panel is standing in right now, so a test can name a row by
 * the same relative path it always did. The KEYS are absolute since part B2 —
 * `dirRow`/`fileRow` build them, and one test below pins that outright.
 */
let rootNow = HOME;

function dirRow(rel: string): FakeElement {
  return byKey(root, `fdir:${rootNow}/${rel}`) as FakeElement;
}
function fileRow(rel: string): FakeElement {
  return byKey(root, `ffile:${rootNow}/${rel}`) as FakeElement;
}
/**
 * The NAME half of a destination — what A9/A9b showed, and what every
 * assertion below reads. Part B2 added the PATH behind it; the parity test at
 * the end of this file is the one place both halves are pinned together.
 */
function destName(d: { name: string } | null): string | null {
  return d === null ? null : d.name;
}

/** A tab path with the root's prefix cut, so the pane shapes stay readable. */
function short(path: string): string {
  return path.startsWith(`${rootNow}/`) ? path.slice(rootNow.length + 1) : path;
}

/**
 * Open these folders, the way a user does — one click per folder, each
 * awaiting its listing — and then drop the selection those clicks made (A9b:
 * activating a folder row chooses it). The tree starts CLOSED since part B2:
 * there is no `MOCK_OPEN_FOLDERS` to seed it with any more, and a panel that
 * guessed which real folders to open would be guessing about a filesystem.
 */
async function expand(...rels: string[]): Promise<void> {
  for (const rel of rels) {
    const row = dirRow(rel);
    // Idempotent on purpose: the panel's open set is instance state that
    // outlives one test (so is the app's), and a second click would CLOSE the
    // folder the caller asked to see.
    if (row === null || row.getAttribute('aria-expanded') === 'true') continue;
    row.click();
    await settle();
  }
  dispatch(root, 'keydown', { key: 'Escape' });
}

/** Close this folder if it is open, then open it again — one fresh listing. */
async function reopen(rel: string): Promise<void> {
  const row = dirRow(rel);
  if (row.getAttribute('aria-expanded') === 'true') {
    row.click();
    await settle();
  }
  dirRow(rel).click();
  await settle();
}

/** The panel at Home with nothing running: its very first state. */
async function homeWorld(): Promise<void> {
  rootNow = HOME;
  // Through HIDDEN first: that is how the app reaches this state (the panel is
  // toggled, or the Projects drawer gives the left side back), and it is what
  // makes the panel re-read its root and re-ask git instead of trusting a
  // cache from whatever the last test left behind.
  st.state.leftPanel = null;
  panel.render();
  st.state.leftPanel = 'files';
  kinds.length = 0;
  panel.render();
  await settle();
}

/** A live session in a project, with its own view — the panel's normal world. */
async function liveSession(): Promise<void> {
  rootNow = PROJ;
  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  focusSession('s1');
  st.state.leftPanel = 'files';
  kinds.length = 0;
  panel.render();
  await settle();
  await expand('web', 'web/src', 'server');
}

/**
 * Stand in the session's own tab, the way launching one does. Since part B2
 * (user decision 2026-09-16) the panel follows the FOCUSED pane and nothing
 * else: with the fixed `Home` tab active it shows HOME, however many sessions
 * are running in other tabs — which is a claim of its own further down.
 */
function focusSession(id: string): void {
  const v = st.state.views.find((x) =>
    x.slots.some((s) => s.kind === 'session' && s.id === id),
  );
  if (v !== undefined) st.state.activeViewId = v.id;
}

const grip = byClass(root, 'files-grip')[0] as FakeElement;
const body = byClass(root, 'files-body')[0] as FakeElement;
const summary = byClass(root, 'files-sum')[0] as FakeElement;

beforeEach(() => {
  dom.storage.clear();
  fx.reset();
  rootNow = HOME;
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
  // The WISHED tab is panel-instance state that outlives one test (part B2
  // item 6: it is restored when a repository answers again), so every test
  // starts from the same wish — pressed, the way a user sets it.
  (byKey(root, 'ftab:files') as FakeElement | null)?.click();
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

test('with no session at all the panel is still up, headed Home', async () => {
  // User decision 2026-09-15: the Files panel no longer waits for a session.
  st.state.drawer = null;
  await homeWorld();
  assert.equal(st.filesPanelVisible(), true);
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'a name, never a path');
  assert.deepEqual(
    textsOf(root, 'files-name'),
    ['web', 'server', 'launcher', 'shared', 'README.md', 'LICENSE'],
    'and the tree is really drawn — the HOME folder, learned from the first listing',
  );
});

test('exited sessions with no pane of their own leave the header on Home', async () => {
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
  st.state.drawer = null;
  await homeWorld();
  assert.equal(st.filesPanelVisible(), true, 'no session is a condition any more');
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'nothing alive, so nothing to name');
  assert.ok(byClass(root, 'files-row').length >= 6, 'and the tree is drawn all the same');
});

test('a focused pane whose session EXITED, with nothing else alive, is headed Home', () => {
  // Added by the test gate (2026-09-15). The real path: state.ts markExited
  // flips status in place and reconcileViews KEEPS the dead pane, so after the
  // last session quits the focused pane still points at an exited session.
  // Until this change the panel was hidden in exactly that state; now it is on
  // screen, and the brief says the header reads `Home` when nothing is alive.
  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  focusSession('s1');
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

test('the Projects drawer takes the left side, and closing it gives the panel back', async () => {
  await liveSession();
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

test('the Files tab is the gateway s own answer, in the gateway s own order', async () => {
  await liveSession();
  // The panel asked for the root and for each folder that was opened, and for
  // nothing else: no walk, no prefetch, no poll. (`liveSession()` registers the
  // project before the session, so the root passes through Home on the way —
  // that listing is filtered out here and pinned by the root-change tests.)
  assert.deepEqual(
    entryCalls.filter((p) => p !== HOME),
    [PROJ, `${PROJ}/web`, `${PROJ}/web/src`, `${PROJ}/server`],
  );
  assert.equal(summary.hidden, true, 'a folder listing has no commits to be since');
  assert.deepEqual(textsOf(body, 'files-num'), [], 'and no per-row +N -N either');

  const rows = byClass(root, 'files-row');
  assert.ok(rows.length >= 10, 'non-vacuity: the tree really has rows');
  assert.deepEqual(
    rows.map((r) => r.textContent.replace(/^[▾▸]/, '').trim()),
    [
      'web',
      'src',
      'TSXApp.tsx',
      'TSXPane.tsx',
      'TSXTabStrip.tsx',
      'TSstore.ts',
      'MDDESIGN.md',
      '{ }package.json',
      'server',
      'TSpty-pool.ts',
      'TSws.ts',
      'TSpresence.ts',
      'launcher',
      'shared',
      'MDREADME.md',
      '·LICENSE',
    ],
    'every row prints its badge and its NAME — never a path — in the server s order',
  );
  // The KEY is the absolute path (part B2): that is what the row menu, the
  // drop layer and part B10 all act on.
  assert.equal(fileRow('web/src/Pane.tsx').getAttribute('data-k'), `ffile:${PROJ}/web/src/Pane.tsx`);
  assert.equal(
    byClass(root, 'files-name').some((n) => n.textContent.includes('/')),
    false,
    'a path never reaches a label',
  );
});

test('a folder is fetched once per expand, and re-expanding it never flashes Loading…', async () => {
  await liveSession();
  const before = entryCalls.length;
  dirRow('web').click(); // close
  assert.deepEqual(entryCalls.length, before, 'closing asks nothing');

  // Re-opening ALWAYS re-asks (cache-then-revalidate) — but the cached rows
  // are on screen the whole time, so nothing flashes.
  fx.hold();
  dirRow('web').click();
  assert.equal(entryCalls.length, before + 1, 'one request');
  assert.equal(
    byClass(root, 'files-row').some((r) => r.textContent.includes('Loading…')),
    false,
    'a folder that already answered never goes back to Loading…',
  );
  assert.ok(byClass(root, 'files-row').some((r) => r.textContent.includes('DESIGN.md')));
  fx.release();
  await settle();
  assert.equal(entryCalls.length, before + 1, 'and the answer starts no second one');
});

test('a folder that has never answered says Loading…, at the indent of its own children', async () => {
  await liveSession();
  fx.hold();
  dirRow('launcher').click();
  const rows = byClass(root, 'files-row');
  const loading = rows.find((r) => r.textContent === 'Loading…') as FakeElement;
  assert.ok(loading !== undefined, `non-vacuity: ${rows.map((r) => r.textContent).join(' | ')}`);
  assert.equal(loading.tagName, 'DIV', 'a state is not a control: there is nothing to press');
  assert.equal(loading.classList.contains('is-state'), true);
  assert.equal(loading.classList.contains('is-err'), false);
  // The child indent of `launcher`, which is a top-level row: 8 + 1 * 14.
  assert.equal(loading.style.paddingLeft, '22px');
  assert.equal(byClass(loading, 'files-name')[0]?.textContent, 'Loading…', 'it ellipsises like a name');

  fx.release();
  await settle();
  assert.equal(
    byClass(root, 'files-row').some((r) => r.textContent === 'Loading…'),
    false,
    'and the rows replace it in the same place',
  );
  assert.ok(byClass(root, 'files-row').some((r) => r.textContent.includes('launch.ps1')));
});

test('an empty folder says so, a capped one says how many rows are missing', async () => {
  await liveSession();
  // `shared` is the capped folder in the fixture (the fake answers
  // `truncated: 3` for it) and it holds the empty one.
  await expand('shared');
  const note = byClass(root, 'files-row').find((r) => r.textContent.includes('not shown here'));
  assert.equal(note?.textContent, '3 more items are not shown here.');
  assert.equal(note?.classList.contains('is-state'), true);
  assert.equal(note?.tagName, 'DIV');
  assert.equal(
    byClass(root, 'files-row').indexOf(note as FakeElement),
    byClass(root, 'files-row').findIndex((r) => r.textContent.includes('protocol.ts')) + 1,
    'the quiet note is the LAST child of the folder it is about',
  );

  await expand('shared/empty');
  const empty = byClass(root, 'files-row').find((r) => r.textContent === 'Empty folder');
  assert.ok(empty !== undefined, 'an empty folder is a state, not a blank line');
  assert.equal(empty.classList.contains('is-state'), true);
  assert.equal(empty.style.paddingLeft, '36px', 'at the indent its children would have had');
});

test('a folder the server refuses says the SERVER s own sentence, in danger ink', async () => {
  await liveSession();
  failWith.set(`${PROJ}/launcher`, new FakeApiError(403, 'You do not have permission to read this folder.'));
  await reopen('launcher');
  const row = byClass(root, 'files-row').find((r) =>
    r.textContent.includes('You do not have permission'),
  ) as FakeElement;
  assert.ok(row !== undefined, 'the backend s reason is rendered inline, verbatim');
  assert.equal(row.textContent, 'You do not have permission to read this folder.');
  assert.equal(row.classList.contains('is-state'), true);
  assert.equal(row.classList.contains('is-err'), true, 'a refusal is the one state in danger ink');
  assert.equal(row.tagName, 'DIV');
});

test('the ROOT s own states replace the whole tree, in the same words', async () => {
  await homeWorld();
  // The root moves to a project folder that is not there any anymore: the
  // server's own sentence is the WHOLE body, and no stale tree stands behind it.
  rootNow = '/work/gone';
  st.setProjects([{ id: 'p9', name: 'gone', path: '/work/gone', createdAt: '' } as Project]);
  st.setSessions([mkSession('s9', { projectId: 'p9' })]);
  focusSession('s9');
  panel.render();
  await settle();
  const rows = byClass(root, 'files-row');
  assert.equal(rows.length, 1, 'one state row, and no tree behind it');
  assert.equal(rows[0]?.textContent, 'This folder is no longer there.');
  assert.equal(rows[0]?.classList.contains('is-err'), true);
  assert.equal(rows[0]?.style.paddingLeft, '8px', 'the root s own indent');
});

test('a late answer for the root we LEFT never paints over the one we are in', async () => {
  await liveSession();
  fx.hold();
  // The root moves to Home while the project's listing is still in flight.
  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  rootNow = HOME;
  panel.render();
  fx.release();
  await settle();
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'non-vacuity: the root really moved');
  assert.ok(byClass(root, 'files-row').length > 0);
  assert.equal(
    byClass(root, 'files-row').every((r) => (r.getAttribute('data-k') ?? '').includes(HOME)),
    true,
    'every row on screen belongs to the root the header names',
  );
});

test('a root change drops the OLD root s listings: coming back re-reads, it never remembers', async () => {
  // `openFolders`, `listings` and the selection are all keyed by absolute
  // path, so most of them simply stop matching on a root change — but a cache
  // entry does not: it is still the answer for that exact folder, and keeping
  // it is how a panel shows a folder the way it looked two projects ago,
  // silently and with no `Loading…` to say so.
  await homeWorld();
  assert.ok(
    byClass(root, 'files-name').some((n) => n.textContent === 'README.md'),
    'non-vacuity: Home has answered and its rows are drawn',
  );

  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  focusSession('s1');
  panel.render();
  await settle();

  // Back to Home with the answer still travelling: what is on screen in that
  // moment is the whole question.
  fx.hold();
  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  panel.render();
  assert.deepEqual(
    byClass(root, 'files-row').map((r) => r.textContent),
    ['Loading…'],
    'the root is asked again, not answered from before',
  );
  fx.release();
  await settle();
  assert.ok(
    byClass(root, 'files-name').some((n) => n.textContent === 'README.md'),
    'and the answer fills the tree in',
  );
});

test('a late listing is dropped even when it names a folder in the NEW root too', async () => {
  // The GENERATION, not the path, is what makes an answer stale. The root
  // leaves Home and comes back, so the listing still travelling is for the very
  // folder the tree is standing in again — the one case a path comparison
  // cannot see, and the one this app really meets (a click on a session's pane,
  // then back to Home before the first listing has landed).
  await homeWorld();
  let first = true;
  fx.holdIf((c) => {
    if (c.kind !== 'entries' || c.path !== HOME || !first) return false;
    first = false;
    return true;
  });
  // Returning to the panel re-reads the root: THAT listing is the held one, and
  // `holdIf` reads its answer now, so it carries the folder as it is today.
  st.state.leftPanel = null;
  panel.render();
  st.state.leftPanel = 'files';
  panel.render();
  assert.deepEqual(entryCalls.slice(-1), [HOME], 'non-vacuity: one listing is in flight');

  // The folder changes under the app, and the root leaves and comes back.
  fx.tree.set(HOME, [{ name: 'later', dir: true }, { name: 'NOW.md', dir: false }]);
  fx.tree.set(`${HOME}/later`, []);
  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  focusSession('s1');
  panel.render();
  await settle();
  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  panel.render();
  await settle();
  assert.equal(
    byClass(root, 'files-name').some((n) => n.textContent === 'NOW.md'),
    true,
    'non-vacuity: the fresh listing for the root we came back to is on screen',
  );

  fx.release();
  await settle();
  // Not now — and not at the next repaint either, which is where a cache
  // poisoned behind the signature would surface.
  const later = dirRow('later');
  assert.ok(later !== null, 'non-vacuity: the fresh tree is still the one drawn');
  later.click();
  await settle();
  assert.equal(
    byClass(root, 'files-name').some((n) => n.textContent === 'README.md'),
    false,
    'the listing of the root we left never reaches the tree we are in',
  );
  assert.equal(byClass(root, 'files-name').some((n) => n.textContent === 'NOW.md'), true);
});

test('a late REFUSAL for the root we left never replaces the tree we are in', async () => {
  // The failure path of the same rule, and the louder one: an error is drawn
  // instead of the WHOLE folder, so a refusal arriving from the root the panel
  // has left would blank a tree that is perfectly readable.
  await homeWorld();
  let first = true;
  fx.holdIf((c) => {
    if (c.kind !== 'entries' || c.path !== HOME || !first) return false;
    first = false;
    return true;
  });
  // The held answer is READ now, so it is this refusal that travels.
  failWith.set(HOME, new FakeApiError(403, 'You do not have permission to read this folder.'));
  st.state.leftPanel = null;
  panel.render();
  st.state.leftPanel = 'files';
  panel.render();
  failWith.delete(HOME);

  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  focusSession('s1');
  panel.render();
  await settle();
  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  panel.render();
  await settle();
  assert.ok(
    byClass(root, 'files-name').some((n) => n.textContent === 'README.md'),
    'non-vacuity: the root we came back to has answered with its rows',
  );

  fx.release();
  await settle();
  dirRow('web').click();
  await settle();
  assert.equal(
    byClass(root, 'files-row').some((r) => r.textContent.includes('You do not have permission')),
    false,
    'the sentence belongs to the root that asked for it, and that root is gone',
  );
  assert.ok(byClass(root, 'files-name').some((n) => n.textContent === 'DESIGN.md'));
});

test('one listing per folder is in flight at a time: a second ask is dropped, not queued', async () => {
  await homeWorld();
  entryCalls.length = 0;
  fx.hold();
  // Returning to the panel re-reads its root (cache-then-revalidate). Doing it
  // three times while the first answer is still travelling must ask ONCE: a
  // panel the user flips through would otherwise pile up one request per visit,
  // and every one of them would repaint the tree when it landed.
  for (let i = 0; i < 3; i += 1) {
    st.state.leftPanel = null;
    panel.render();
    st.state.leftPanel = 'files';
    panel.render();
  }
  assert.deepEqual(entryCalls, [HOME], 'three returns, one request');

  fx.release();
  await settle();
  // The dedupe is per FLIGHT, not a cache: once the answer has landed the next
  // return asks again, which is the revalidate half of the contract.
  st.state.leftPanel = null;
  panel.render();
  st.state.leftPanel = 'files';
  panel.render();
  assert.deepEqual(entryCalls, [HOME, HOME]);
});

test('a root change prunes the open folders, the cache and a selection outside it', async () => {
  await liveSession();
  dirRow('web/src').click(); // select + toggle: the selection is under the project
  await settle();
  assert.deepEqual(
    F.selectedFolder(),
    { path: `${PROJ}/web/src`, name: 'src' },
    'non-vacuity: it is selected, and it carries the real folder behind its name',
  );

  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  rootNow = HOME;
  panel.render();
  await settle();
  assert.equal(destName(F.selectedFolder()), null, 'a folder nobody can see may not take a paste');
  assert.equal(
    byClass(root, 'files-row').some((r) => r.textContent.includes('App.tsx')),
    false,
    'and the tree is the new root s top level, closed',
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

test('the header names the project of the focused session, and the session itself when it has none', async () => {
  await liveSession();
  assert.equal(textsOf(root, 'files-proj')[0], 'api');

  // A fresh world: the ACTIVE view deliberately keeps a dead pane (state.ts
  // reconcileViews skips it), so a bare setSessions would leave the header on
  // the session that is gone — which is the pane's own story, not the panel's.
  st.state.views = [];
  st.state.activeViewId = '';
  st.setSessions([mkSession('s2', { title: 'scratch shell', command: 'bash' })]);
  focusSession('s2');
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
  focusSession('s1');
  st.state.leftPanel = 'files';
  panel.render();
  assert.equal(textsOf(root, 'files-proj')[0], 'api', 'non-vacuity: it starts on the focused one');

  // `s1` ends; the ACTIVE view keeps its pane, `s2` is still running in
  // ANOTHER tab. Until part B2 the header borrowed that other session's name;
  // since the user decision of 2026-09-16 it does not — the panel lists a real
  // folder now, and the folder of a session nobody is looking at is not what
  // this screen is about. `Home` is the honest answer, and the tab holding s2
  // is one click away.
  st.setSessions([mkSession('s2', { title: 'notes' })]);
  st.state.views = [
    { id: 'v1', root: null, slots: [{ kind: 'session', id: 's1' }], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
  ];
  st.state.activeViewId = 'v1';
  panel.render();
  assert.equal(st.filesPanelVisible(), true, 'non-vacuity: the panel is still up');
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'a dead pane names no other tab s session');

  // And with nothing running at all it is the same answer, from the same rung.
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

test('nothing in the tree pulses: no source says which files a session is touching', async () => {
  // Plan open decision 3 is the user's and is NOT settled by part B2, so
  // `editing` is never set and the amber pulse never shows. The CSS hook and
  // the `busy` field stay exactly where they are, unused, until the source of
  // that fact is chosen — which is why this is a test and not a deletion.
  await liveSession();
  assert.ok(byClass(root, 'files-row').length > 6, 'non-vacuity: there is a tree to look at');
  assert.deepEqual(
    byClass(root, 'files-row').filter((r) => r.classList.contains('is-busy')),
    [],
    'a guessed pulse would be the panel inventing what a session is doing',
  );
  const app = readFileSync(join(here, '..', 'web', 'src', 'styles', 'app.css'), 'utf8');
  assert.match(app, /\.files-row\.is-busy \{/, 'the hook survives for whenever the source arrives');
});

test('a folder row toggles its subtree; a file row opens that file as a PANE (A10)', async () => {
  await liveSession();
  const server = dirRow('server');
  assert.equal(server.tagName, 'BUTTON');
  assert.equal(server.getAttribute('aria-expanded'), 'true');
  const before = byClass(root, 'files-row').length;

  server.click();
  assert.equal((dirRow('server')).getAttribute('aria-expanded'), 'false');
  assert.equal(byClass(root, 'files-row').length, before - 3, 'the three server/ files went with it');
  assert.equal(
    byClass(root, 'files-row').some((r) => r.textContent.includes('ws.ts')),
    false,
  );

  (dirRow('server')).click();
  assert.equal(byClass(root, 'files-row').length, before, 'and come back');

  // A10b: the file lands as a TAB of the editor pane of its root folder's tab
  // — here the focused session's project (A10 opened a pane per file; the user
  // asked for one pane with a strip instead).
  const file = fileRow('web/src/Pane.tsx');
  assert.equal(file.tagName, 'BUTTON', 'a row that opens a file is a button, not a hover');
  file.click();
  const v = st.activeView() as ViewLike;
  assert.deepEqual(v.root, { kind: 'project', id: 'p1' }, 'the project of the focused session');
  assert.deepEqual(shapeOf(v), ['*web/src/Pane.tsx']);
  assert.equal(st.state.activeViewId, v.id, 'and the app goes there');

  panel.render();
  assert.equal(
    (fileRow('web/src/Pane.tsx')).classList.contains('is-open'),
    true,
    'the tree says where the panes are standing',
  );
  assert.equal(
    (fileRow('web/src/store.ts')).classList.contains('is-open'),
    false,
    'and only there',
  );

  // Opening the same file twice must not spend a second pane — or a second
  // CHIP — on a copy: the second click RAISES what is already open (A10b).
  (fileRow('web/src/store.ts')).click();
  assert.deepEqual(shapeOf(st.activeView()), ['web/src/Pane.tsx *web/src/store.ts'],
    'the second file is a TAB of the same pane, and it is the one showing');
  (fileRow('web/src/Pane.tsx')).click();
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
          .map(
            (t, i) =>
              `${i === s.active ? '*' : ''}${t.kind === 'file' ? short(t.path) : `${t.hash}:${t.path}`}`,
          )
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

test('with nothing running, a file row opens into the Home tab — never a nameless one', async () => {
  await homeWorld();
  await expand('web', 'web/src');
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'non-vacuity: the Home subject');

  (fileRow('web/src/store.ts')).click();
  const v = st.activeView() as ViewLike;
  assert.deepEqual(v.root, { kind: 'home' });
  assert.equal(st.state.views[0]?.id, v.id, 'Home is the fixed first tab');
  assert.deepEqual(shapeOf(v), ['*web/src/store.ts']);
});

test('a session WITHOUT a project lists its OWN working directory, headed by its name', async () => {
  // The A10 gap B2 closes: the header says the session's name, the tree lists
  // the folder that session is really running in, and the file still opens
  // into the Home tab (which tab a file lands in is a view-model rule part B4
  // revisits — B2 only makes the ROOT real).
  st.setProjects([]);
  st.setSessions([mkSession('s9', { title: 'scratch shell', command: 'bash' })]);
  focusSession('s9');
  st.state.leftPanel = 'files';
  rootNow = SCRATCH;
  panel.render();
  await settle();
  assert.equal(textsOf(root, 'files-proj')[0], 'scratch shell', 'non-vacuity: not the Home subject');
  assert.deepEqual(
    textsOf(root, 'files-name'),
    ['web', 'server', 'launcher', 'shared', 'README.md', 'LICENSE'],
    'the session s own working directory, listed for real',
  );
  await expand('web', 'web/src');

  fileRow('web/src/store.ts').click();
  assert.deepEqual((st.activeView() as ViewLike).root, { kind: 'home' });
});

test('a file row is a pointer drag source — and says so, naming its keyboard twin', async () => {
  await liveSession();
  const file = fileRow('web/src/Pane.tsx');
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

test('ctrl+alt+enter on a focused row splits the focused pane — the twin of the edge drop', async () => {
  await liveSession();
  // One pane in the project tab: the only split it offers is left/right.
  (fileRow('web/src/store.ts')).click();
  const v = st.activeView() as ViewLike;
  assert.equal(v.slots.length, 1, 'non-vacuity: one pane to split');

  const file = fileRow('web/src/Pane.tsx');
  file.focus();
  const e = dispatch(file, 'keydown', { key: 'Enter', ctrlKey: true, altKey: true });
  assert.equal(e.defaultPrevented, true, 'the row owns the chord, so nothing else may act on it');
  assert.deepEqual(shapeOf(st.activeView()), ['*web/src/Pane.tsx', '*web/src/store.ts'],
    'the new file took the left half of the pane it split — its OWN editor pane');
  assert.equal(slotsNow().length, 2, 'the chord splits; it never adds to the strip');
});

test('the chord is ctrl+alt+enter only: AltGr, plain Enter and ctrl+enter are left alone', async () => {
  await liveSession();
  const file = fileRow('web/src/Pane.tsx');
  file.focus();
  for (const init of [
    { key: 'Enter' },
    { key: 'Enter', altKey: true },
    // AltGr reports as ctrl+alt on European layouts: taking it would make a
    // keyboard character untypeable (frontend-terminal-quirks).
    { key: 'Enter', ctrlKey: true, altKey: true, altGraph: true },
    { key: 'w', ctrlKey: true, altKey: true },
  ]) {
    const e = dispatch(file, 'keydown', init);
    assert.equal(e.defaultPrevented, false, `${JSON.stringify(init)} is not this row's key`);
  }
  // ctrl+enter left this list in B10a: it is the panel's own "add this row to
  // the selection" (the twin of ctrl+space and of a ctrl+click), so it IS
  // taken — and it still opens nothing.
  const toggle = dispatch(file, 'keydown', { key: 'Enter', ctrlKey: true });
  assert.equal(toggle.defaultPrevented, true, 'ctrl+enter chooses the focused row');
  assert.equal(anyFileSlot(), false, 'and nothing opened');
});

test('`is-open` follows the TABS, in any tab, active chip or not (A10b)', async () => {
  // The A10 spelling of this asked whether the file was a PANE (`slotKey`).
  // Since A10b a file is a CHIP in a strip and a pane's key is its own `e:<n>`,
  // so that question could never say yes again — a silently dead class.
  await liveSession();
  const isOpen = (rel: string): boolean => fileRow(rel).classList.contains('is-open');
  assert.equal(isOpen('web/src/Pane.tsx'), false, 'non-vacuity: nothing is open yet');

  (fileRow('web/src/Pane.tsx')).click();
  panel.render();
  assert.equal(isOpen('web/src/Pane.tsx'), true);

  // A second file joins the same strip. The first one is no longer the ACTIVE
  // chip, and it is still open — the class is about the file being on screen's
  // strip, not about which chip is up.
  (fileRow('web/src/store.ts')).click();
  panel.render();
  assert.deepEqual(shapeOf(st.activeView()), ['web/src/Pane.tsx *web/src/store.ts']);
  assert.equal(isOpen('web/src/Pane.tsx'), true, 'a background chip is open too');
  assert.equal(isOpen('web/src/store.ts'), true);
  assert.equal(isOpen('web/src/TabStrip.tsx'), false, 'and only the files that are really open');

  // Another tab entirely — the session's own, which keeps the panel rooted at
  // the same project so the rows are still drawn. The row still says the file
  // is on screen, because it is: the class is about the FILE, not about which
  // tab is in front.
  focusSession('s1');
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

test('a file pane in a ROOTLESS tab is about THAT tab session, not the first alive anywhere', async () => {
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
  await settle();
  assert.equal(
    textsOf(root, 'files-proj')[0],
    'tools',
    "the tab's own session — `api` is another tab's story",
  );

  // And the header and the landing tab can never disagree: the next row opens
  // into the folder the header names.
  rootNow = '/work/tools';
  await expand('web', 'web/src');
  fileRow('web/src/store.ts').click();
  assert.deepEqual((st.activeView() as ViewLike).root, { kind: 'project', id: 'p2' });
});

test('a file pane in a rootless tab with NO session of its own reads Home', async () => {
  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s2', { projectId: 'p1' })]);
  st.state.views = [
    { id: 'vo', root: null, slots: [{ kind: 'session', id: 's2' }], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
    { id: 'vf', root: null, slots: [ed('web/src/Pane.tsx')], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
  ];
  st.state.activeViewId = 'vf';
  st.state.leftPanel = 'files';
  repaint();
  await settle();
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'no folder and no session: Home, not `api`');

  rootNow = HOME;
  await expand('web', 'web/src');
  fileRow('web/src/store.ts').click();
  assert.deepEqual((st.activeView() as ViewLike).root, { kind: 'home' });
});

test('every file row carries a colour-family badge, including the ones behind a closed folder', async () => {
  await liveSession();
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
  await expand('launcher');
  const opened = new Map(byClass(root, 'files-badge').map((b) => [b.textContent, b.dataset.kind]));
  assert.equal(opened.get('PS'), 'ps');
  assert.equal(opened.get('JS'), 'js', 'a .mjs is JavaScript, not an unknown type');
});

test('the caret is decoration: aria-hidden, and the folder row itself states the state', async () => {
  await liveSession();
  for (const c of byClass(root, 'files-caret')) assert.equal(c.getAttribute('aria-hidden'), 'true');
  const web = dirRow('web');
  assert.equal(web.children[0]?.textContent, '▾');
  assert.equal(web.getAttribute('aria-expanded'), 'true');
});

test('only the Commits tab still says what is under it is not the real repository', async () => {
  // Part B2 made the Files tab REAL, so its honesty line is gone with the mock
  // it was about; `Commits` is the last surface drawing `ui/files-mock.ts`
  // under the user's real project name, and it keeps the one line.
  await liveSession();
  assert.deepEqual(textsOf(root, 'files-note'), [], 'a real listing needs no apology');

  (byKey(root, 'ftab:commits') as FakeElement).click();
  assert.deepEqual(textsOf(root, 'files-note'), [
    'Example data until the panel reads your commits.',
  ]);
  assert.equal(
    (body.children[0] as FakeElement).classList.contains('files-note'),
    true,
    'first thing in the body',
  );

  // ONE render site, so B3 removes it by deleting one function and one
  // argument — not by hunting two branches.
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'files.ts'), 'utf8');
  assert.equal(src.split('placeholderNote(').length - 1, 2, 'one definition, one call site');

  (byKey(root, 'ftab:files') as FakeElement).click(); // the tab is panel-local state
});

test('the Commits tab swaps the body and hides the summary; both tabs say which is up', async () => {
  await liveSession();
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
  assert.equal(summary.hidden, true, 'the summary belongs to Changes, not to a folder listing');
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

test('the last session exiting takes the Commits tab away under the user, and lands on Files', async () => {
  await liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  assert.equal(
    (byKey(root, 'ftab:commits') as FakeElement).getAttribute('aria-pressed'),
    'true',
    'non-vacuity: the panel really is standing on Commits',
  );
  assert.equal((byKey(root, 'ftab:commits') as FakeElement).disabled, false);

  st.markExited('s1', 0);
  panel.render();
  await settle();
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
  assert.ok(byClass(root, 'files-row').length >= 6, 'and the tree is what it fell back to');
  assert.equal(byClass(root, 'commit-row').length, 0, 'no commit list survives the fall back');
});

test('a session appearing again gives the Commits tab back, title and all', async () => {
  st.state.leftPanel = 'files';
  panel.render();
  assert.equal(
    (byKey(root, 'ftab:commits') as FakeElement).disabled,
    true,
    'non-vacuity: it starts unavailable',
  );

  await liveSession();
  const commits = byKey(root, 'ftab:commits') as FakeElement;
  assert.equal(commits.disabled, false);
  assert.equal(commits.getAttribute('aria-disabled'), null, 'the reason is gone with the state');
  assert.equal(commits.title, '');

  commits.click();
  assert.equal(commits.getAttribute('aria-pressed'), 'true', 'and it leads somewhere again');
  assert.equal(textsOf(root, 'files-branch')[0], 'main, 5 commits');
  (byKey(root, 'ftab:files') as FakeElement).click(); // the tab is panel-local state
});

test('clicking the disabled Commits tab switches nothing (the fake DOM still fires it)', async () => {
  // fake-dom's click() dispatches whatever the button's `disabled` says — a
  // real browser fires nothing — so this pins the panel's own guard, which is
  // what keeps a stray programmatic click out of a view on nothing.
  await homeWorld();
  const commits = byKey(root, 'ftab:commits') as FakeElement;
  assert.equal(commits.disabled, true, 'non-vacuity: the guard is the subject here');

  commits.click();
  assert.equal(commits.getAttribute('aria-pressed'), 'false');
  assert.equal(commits.classList.contains('is-on'), false);
  assert.equal((byKey(root, 'ftab:files') as FakeElement).getAttribute('aria-pressed'), 'true');
  assert.ok(byClass(root, 'files-row').length >= 6, 'still the tree');
  assert.equal(byClass(root, 'commit-row').length, 0);
});

// ---------------------------------------------------------------------------
// The Changes tab (part B2 §7)
// ---------------------------------------------------------------------------

test('Changes draws the repository s own tree, its summary and nothing about folders', async () => {
  await liveSession();
  const changes = byKey(root, 'ftab:changes') as FakeElement;
  assert.equal(changes.textContent, 'Changes', 'the third tab, between Files and Commits');
  assert.equal(changes.disabled, false, 'the root is inside a repository');

  changes.click();
  await settle();
  assert.equal(summary.hidden, false, 'the summary moved here with the numbers');
  assert.deepEqual(textsOf(root, 'files-num').slice(0, 2), ['+26', '-12']);
  assert.equal(textsOf(root, 'files-sum-text')[0], 'since last commit in 5 files');
  // The header line names the REPOSITORY, never its path — it can be an
  // ancestor of the folder the Files tab lists, which is exactly why it is
  // said out loud.
  assert.equal(textsOf(root, 'files-branch')[0], 'api, main');

  // Repo-relative paths, drawn by the A5 renderer: folders first as they were
  // built, every row a NAME.
  assert.deepEqual(
    byClass(root, 'files-row').map((r) => r.textContent.replace(/^[▾▸]/, '').trim()),
    ['web', 'server', 'MDREADME.md', 'launcher'],
    'the tree starts closed, in git s own order, and an untracked file is one row',
  );
  (byKey(root, 'gdir:web') as FakeElement).click();
  (byKey(root, 'gdir:web/src') as FakeElement).click();
  assert.deepEqual(
    byClass(root, 'files-row')
      .map((r) => r.textContent.replace(/^[▾▸]/, '').trim())
      .slice(0, 4),
    ['web', 'src', 'TSXApp.tsx+12-4', 'TSXPane.tsx+8-6'],
    'a changed file carries its numbers here, where they are about a commit',
  );
  assert.equal(
    byClass(root, 'files-row').some((r) => r.textContent.includes('README.md+')),
    false,
    'an untracked file was never diffed, so it carries no numbers at all',
  );
  (byKey(root, 'ftab:files') as FakeElement).click();
});

test('a changed file row opens the file at its REPOSITORY s path, not the panel root s', async () => {
  await liveSession();
  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  (byKey(root, 'gdir:server') as FakeElement).click();
  (byKey(root, 'gfile:server/ws.ts') as FakeElement).click();
  const tabs = st.state.views.flatMap((v) => v.slots.flatMap((slot) => st.slotTabIds(slot)));
  assert.ok(tabs.includes(`f:${PROJ}/server/ws.ts`), `absolute, from the repo root: ${tabs.join(' ')}`);
  (byKey(root, 'ftab:files') as FakeElement).click();
});

test('the Changes tab s capped note is its LAST row, under the rows it is about', async () => {
  // Same rule as the tree's own cap: the note says what is MISSING from the
  // rows above it, so above them it would be a note about nothing yet.
  fx.changesFor = (r) => (r === PROJ ? repoAnswer({ truncated: 2 }) : NO_REPO);
  await liveSession();
  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  const rows = byClass(body, 'files-row');
  assert.ok(rows.length > 1, 'non-vacuity: there is a tree for the note to be under');
  assert.ok(
    rows.some((r) => r.textContent.includes('web')),
    'non-vacuity: the repository s own rows are the ones above it',
  );
  const note = rows[rows.length - 1] as FakeElement;
  assert.equal(note.textContent, '2 more items are not shown here.');
  assert.equal(note.classList.contains('is-state'), true);
  assert.equal(note.tagName, 'DIV', 'a state is not a control');
  assert.equal(note.style.paddingLeft, '8px', 'at the root s own indent');
  (byKey(root, 'ftab:files') as FakeElement).click();
});

test('a late git answer for the root we LEFT never lights the tabs', async () => {
  // The git answer is also the PROBE: it decides whether `Changes` and
  // `Commits` exist at all. An answer from the repository the panel has already
  // left is therefore the one that would offer a repository at a folder that
  // has none — and open a commit list belonging to somewhere else.
  fx.holdIf((c) => c.kind === 'changes' && c.path === PROJ);
  await liveSession();
  assert.ok(changeCalls.includes(PROJ), 'non-vacuity: the probe for the project went out');

  // Back to Home, which is no repository at all, and its probe answers at once.
  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  rootNow = HOME;
  panel.render();
  await settle();
  assert.ok(changeCalls.includes(HOME), 'non-vacuity: the probe followed the root');

  fx.release();
  await settle();
  // Force the repaint a stale answer would ride in on: the tab states are
  // painted by `rebuild()`, so a cache poisoned behind the signature shows up
  // at the next one, not at the answer itself.
  dirRow('web').click();
  await settle();
  for (const k of ['changes', 'commits']) {
    const b = byKey(root, `ftab:${k}`) as FakeElement;
    assert.equal(b.disabled, true, `${k} may not be lit by the repository we left`);
    assert.equal(b.title, 'No repository at Home');
  }

  // Non-vacuity for the assertion above: a repository answer for THIS root does
  // light them, so "disabled" is a verdict and not the only state reachable here.
  fx.changesFor = () => repoAnswer({ repoRoot: HOME });
  st.state.leftPanel = null;
  panel.render();
  st.state.leftPanel = 'files';
  panel.render();
  await settle();
  assert.equal((byKey(root, 'ftab:commits') as FakeElement).disabled, false);
});

test('a clean repository says so in one sentence, and shows no summary', async () => {
  fx.changesFor = (r) => (r === PROJ ? repoAnswer({ files: [] }) : NO_REPO);
  await liveSession();
  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  assert.equal(summary.hidden, true, '+0 -0 in 0 files says the same thing twice');
  const rows = byClass(root, 'files-row');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.textContent, 'No changes since the last commit.');
  assert.equal(rows[0]?.classList.contains('is-state'), true);
  (byKey(root, 'ftab:files') as FakeElement).click();
});

test('no repository: Changes and Commits are really disabled, and say where', async () => {
  await homeWorld();
  for (const k of ['changes', 'commits']) {
    const b = byKey(root, `ftab:${k}`) as FakeElement;
    assert.equal(b.disabled, true, `${k} is really disabled, not merely dimmed`);
    assert.equal(b.getAttribute('aria-disabled'), 'true');
    assert.equal(b.title, 'No repository at Home', 'and it says why, on hover and aloud');
  }
  assert.equal((byKey(root, 'ftab:files') as FakeElement).disabled, false);
});

test('the probe is REAL: a home folder that IS a repository offers both tabs', async () => {
  // A11's stopgap was "the header does not read Home". Since B2 it is the
  // git answer for the root, so this — a home directory under version
  // control — is a state the panel can now be honest about.
  fx.changesFor = () => ({
    isRepo: true,
    repoRoot: HOME,
    branch: 'main',
    files: [{ path: 'README.md', add: 1, del: 0, status: 'modified' as const }],
    truncated: 0,
  });
  await homeWorld();
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'non-vacuity: this is the Home subject');
  assert.equal((byKey(root, 'ftab:changes') as FakeElement).disabled, false);
  assert.equal((byKey(root, 'ftab:commits') as FakeElement).disabled, false);
  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  assert.equal(textsOf(root, 'files-branch')[0], 'you, main', 'the repository, by NAME');
  (byKey(root, 'ftab:files') as FakeElement).click();
});

test('the panel falls back to Files when the tab it stood on loses its repository', async () => {
  await liveSession();
  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  assert.equal(
    (byKey(root, 'ftab:changes') as FakeElement).getAttribute('aria-pressed'),
    'true',
    'non-vacuity: the panel really is standing on Changes',
  );

  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  rootNow = HOME;
  panel.render();
  await settle();
  assert.equal((byKey(root, 'ftab:changes') as FakeElement).disabled, true);
  assert.equal(
    (byKey(root, 'ftab:files') as FakeElement).getAttribute('aria-pressed'),
    'true',
    'the panel cannot keep standing on a tab that leads nowhere',
  );
});

test('the 5 s poll exists only while Changes is the visible tab and the panel is up', async () => {
  await liveSession();
  assert.equal(dom.win.intervals.length, 0, 'the Files tab polls nothing at all');

  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  assert.equal(dom.win.intervals.length, 1, 'one timer, and only here');
  assert.equal(dom.win.intervals[0]?.ms, 5000, 'CHANGES_POLL_MS');

  const before = changeCalls.length;
  (dom.win.intervals[0] as { fn: () => void }).fn();
  await settle();
  assert.equal(changeCalls.length, before + 1, 'a tick re-asks git');

  // A tick while a request is still in flight is skipped, not queued.
  fx.hold();
  (dom.win.intervals[0] as { fn: () => void }).fn();
  (dom.win.intervals[0] as { fn: () => void }).fn();
  assert.equal(changeCalls.length, before + 2, 'one request, not two');
  fx.release();
  await settle();

  // Hiding the panel drops the timer; so does leaving the tab.
  st.state.leftPanel = null;
  panel.render();
  assert.equal(dom.win.intervals.length, 0, 'a panel nobody can see costs nothing');
  st.state.leftPanel = 'files';
  panel.render();
  await settle();
  assert.equal(dom.win.intervals.length, 1, 'and it comes back with the panel');
  (byKey(root, 'ftab:files') as FakeElement).click();
  assert.equal(dom.win.intervals.length, 0, 'the tab switch clears it');
});

test('Changes refreshes on tab open and on a root change, and the tree does not poll', async () => {
  await liveSession();
  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  const opened = changeCalls.length;
  assert.ok(opened > 0, 'non-vacuity: opening the tab asked');
  const listings = entryCalls.length;

  // A root change asks again — for the NEW root — and re-reads that folder.
  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  rootNow = HOME;
  panel.render();
  await settle();
  assert.equal(changeCalls[changeCalls.length - 1], HOME, 'the probe follows the root');
  assert.ok(entryCalls.length > listings, 'and so does the listing');
});

test('a late git FAILURE for the root we left does not take the current repository away', async () => {
  // `changes` is both the data and the probe, so a stale refusal does two
  // things at once: it blanks the tree and it disables the two tabs — on a root
  // whose own git call answered perfectly well.
  fx.changesFor = (r) =>
    r === PROJ ? new FakeApiError(500, 'The app could not read this repository.') : repoAnswer({ repoRoot: HOME });
  fx.holdIf((c) => c.kind === 'changes' && c.path === PROJ);
  await liveSession();

  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  rootNow = HOME;
  panel.render();
  await settle();
  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  assert.equal(textsOf(root, 'files-branch')[0], 'you, main', 'non-vacuity: this root has a repository');

  fx.release();
  await settle();
  // Force the repaint a stale answer would ride in on: what the tabs and the
  // rows say is painted by `rebuild()`, so a poisoned state surfaces at the
  // next one and not at the answer itself. Opening a folder of this tab's own
  // tree is the cheapest one — it asks git nothing.
  (byKey(root, 'gdir:web') as FakeElement).click();
  await settle();
  assert.equal(
    byClass(root, 'files-row').some((r) => r.textContent.includes('could not read this repository')),
    false,
    'the refusal belongs to the repository we left',
  );
  assert.equal((byKey(root, 'ftab:changes') as FakeElement).disabled, false);
  assert.equal((byKey(root, 'ftab:commits') as FakeElement).disabled, false);
  // Leave the Changes tree as it was found: its open set is the panel's own
  // instance state and outlives one test, exactly as the app's does.
  (byKey(root, 'gdir:web') as FakeElement).click();
  (byKey(root, 'ftab:files') as FakeElement).click();
});

test('the git answer that fails puts the SERVER s sentence where the rows would be', async () => {
  fx.changesFor = (r) =>
    r === PROJ ? new FakeApiError(500, 'The app could not read this repository.') : NO_REPO;
  await liveSession();
  // The tab is disabled — `isRepo` is unknown — so the sentence is reached
  // through the tab that is still standing: the panel never strands the user
  // on a screen with nothing on it.
  assert.equal((byKey(root, 'ftab:changes') as FakeElement).disabled, true);
  assert.equal((byKey(root, 'ftab:changes') as FakeElement).title, 'No repository at api');
});

// ---------------------------------------------------------------------------
// The Commits tab while a commit is open (Nocturne A6)
// ---------------------------------------------------------------------------

test('clicking a commit opens the commit view, and the tab becomes its selected state', async () => {
  await liveSession();
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

test('a file row in the selected state folds that file in the view, and says which state it is in', async () => {
  await liveSession();
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

test('a file row NAMES the block it expands — the block lives in another region', async () => {
  // `aria-expanded` with nothing to point at leaves a reader with "expanded
  // what?": the block is in the commit VIEW, not in this panel.
  await liveSession();
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

test('All commits closes the whole view and hands the keyboard back', async () => {
  await liveSession();
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

test('switching to the Files tab while a commit is open keeps the VIEW open', async () => {
  await liveSession();
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

test('a rebuild keeps the keyboard where it was (folder rows are re-created wholesale)', async () => {
  await liveSession();
  const server = dirRow('server');
  server.focus();
  server.click();
  const after = dirRow('server');
  assert.notEqual(after, server, 'non-vacuity: the row really was rebuilt');
  assert.equal(dom.doc.activeElement, after, 'focus follows the same control, not the panel edge');
});

// ---------------------------------------------------------------------------
// The shell wiring (web/src/main.ts), read from the source
// ---------------------------------------------------------------------------

const MAIN = readFileSync(join(here, '..', 'web', 'src', 'main.ts'), 'utf8');

test('the panel knows no absolute path of its own: home is LEARNED from the first listing', () => {
  // The one request with no path at all is what teaches the app where home is
  // (§4a). A panel that guessed instead would be right on this machine and
  // wrong on the next one, and nothing on screen would say which.
  const src = readFileSync(join(here, '../web/src/ui/files.ts'), 'utf8');
  assert.match(src, /fs\.entries\(\)\s*\n\s*\.then/, 'the home probe carries no path');
  // The prose says `/home/...` where it explains the rule, so the check is on
  // the CODE: a string literal is what a guess would have to be written as.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(
    /['"`]\/home[/'"`]/.test(code),
    false,
    'and no home path is written into the app anywhere',
  );
});

test('main.ts constructs the panel — on the aside it just created', () => {
  assert.ok(MAIN.includes('function buildShell'), 'non-vacuity: main.ts still builds the shell');
  // Since A9 the module also hands main.ts the destination NAMES the drop
  // layer asks for, so the import is a list — `initFilesPanel` must still be
  // in it, whatever else joined it.
  assert.match(MAIN, /import \{[^}]*\binitFilesPanel\b[^}]*\} from '\.\/ui\/files\.ts';/s);
  assert.match(
    MAIN,
    /const filesPanel = initFilesPanel\(filesAside, requestTerminalFocus, \{/,
    'the panel must be initialised with the files aside, or nothing is ever built',
  );
  // Part B2: the backend reaches the panel as an INJECTED gateway, and this is
  // the only module allowed to know those three questions are HTTP.
  assert.match(
    MAIN,
    /entries: api\.fsEntries,\s*\n\s*create: api\.fsCreate,\s*\n\s*changes: api\.gitChanges,/,
    'the three client functions are handed over by name',
  );
  const files = readFileSync(join(here, '..', 'web', 'src', 'ui', 'files.ts'), 'utf8');
  assert.equal(
    /from '\.\.\/api\.ts'/.test(files),
    false,
    'ui/files.ts must never import the API: that is what keeps it drivable here',
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

test('the panel carries a real `Copy files here…` button whose title names the destination', async () => {
  await liveSession();
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

test('focusing a folder row moves the destination to that folder, and the title with it', async () => {
  await liveSession();
  const btn = byKey(root, 'fcopy') as FakeElement;
  const dir = dirRow('web/src');
  assert.ok(dir !== null, 'non-vacuity: the mock tree really has that folder row');

  dir.focus();
  assert.equal(destName(F.pasteDestination()), 'src', 'its own name, never its path');
  assert.equal(btn.title, 'Copy files into src');

  // Focus back out of the panel entirely: the panel s own root answers again.
  const outside = dom.doc.createElement('button');
  dom.body.append(outside);
  outside.focus();
  assert.equal(destName(F.pasteDestination()), 'api');
  assert.equal(btn.title, 'Copy files into api');
  outside.remove();
});

test('the copy button keeps the folder the keyboard came from — it has no other twin', async () => {
  // Clicking or tabbing to `Copy files here…` takes the focus off the folder
  // row, and the folder-row destination has NO button of its own: a
  // destination read from `document.activeElement` at click time would copy
  // into the panel root the title stopped promising a moment ago.
  await liveSession();
  const btn = byKey(root, 'fcopy') as FakeElement;
  const dir = dirRow('web/src');
  dir.focus();
  assert.equal(destName(F.pasteDestination()), 'src', 'non-vacuity: the row really took it');

  btn.focus();
  assert.equal(destName(F.pasteDestination()), 'src', 'the destination survives the gesture that uses it');
  assert.equal(btn.title, 'Copy files into src', 'and the title keeps its word');

  // Anywhere else INSIDE the panel keeps it too: the tabs, the header.
  const tab = byKey(root, 'ftab:files') as FakeElement;
  tab.focus();
  assert.equal(destName(F.pasteDestination()), 'src');

  // Only leaving the panel clears it.
  const outside = dom.doc.createElement('button');
  dom.body.append(outside);
  outside.focus();
  assert.equal(destName(F.pasteDestination()), 'api', 'the panel s own root again');
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

test('ctrl+alt+c on a focused FOLDER row copies into THAT folder', async () => {
  // The strip button sits BEFORE the tree and every row here is a <button>, so
  // no amount of tabbing aims that one button at a nested folder: forward Tab
  // from a row never reaches it, and Shift+Tab walks back through other folder
  // rows, each of which re-notes itself as the destination. The row-level twin
  // is the only keyboard way to copy into `src` at all.
  await liveSession();
  const dir = dirRow('web/src');
  assert.ok(dir !== null, 'non-vacuity: the mock tree really has that folder row');
  assert.equal(dir.title, 'Open or close it. Copy files into it with ctrl+alt+c. Right-click for its actions.', 'the row names its own chord');

  dir.focus();
  const e = dispatch(dir, 'keydown', { key: 'c', ctrlKey: true, altKey: true });
  assert.equal(e.defaultPrevented, true);
  assert.equal(e.cancelBubble, true, 'a key this row spent never reaches the window chord handler');
  // The dialog opens one listing later: since B2 the conflict question is
  // asked against the REAL folder, at drop time.
  await settle();
  assert.equal(dropped.length, 1, 'the picker seam ran and handed its files on');
  const req = dropped[0] as DropReq;
  assert.deepEqual(req.dest, { path: `${PROJ}/web/src`, name: 'src' }, 'the name shown, the path posted');
  assert.deepEqual(req.items, [{ name: 'shot.png', dir: false, bytes: 7 }]);
  assert.deepEqual(
    req.listing,
    ['App.tsx', 'Pane.tsx', 'TabStrip.tsx', 'store.ts'],
    'the folder s own top-level names ask the conflict question',
  );
  clearRowMemory();
});

test('the folder-row chord keeps its AltGr guard, and a FILE row has nothing to do with it', async () => {
  await liveSession();
  // AltGr reports as ctrl+alt on European layouts: typing a character may
  // never open a file chooser.
  const dir = dirRow('web/src');
  dir.focus();
  const altGr = dispatch(dir, 'keydown', { key: 'c', ctrlKey: true, altKey: true, altGraph: true });
  assert.equal(altGr.defaultPrevented, false);
  assert.deepEqual(dropped, []);

  // A FILE row copies nothing: a file is not a destination, and its own chord
  // (ctrl+alt+enter) is a different act.
  const file = fileRow('web/src/Pane.tsx');
  file.focus();
  const onFile = dispatch(file, 'keydown', { key: 'c', ctrlKey: true, altKey: true });
  assert.equal(onFile.defaultPrevented, false);
  assert.deepEqual(dropped, []);
  clearRowMemory();
});

test('with nothing running the destination is `Home`, exactly as the header reads', () => {
  panel.render();
  assert.equal(byClass(root, 'files-proj')[0]?.textContent, 'Home');
  assert.equal(destName(F.filesPanelDestination()), 'Home');
  assert.equal(destName(F.pasteDestination()), 'Home');
  assert.equal((byKey(root, 'fcopy') as FakeElement).title, 'Copy files into Home');
});

test('a SESSION pane s destination: its session s project, else its tab s folder, else nothing', async () => {
  await liveSession();
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
  assert.equal(destName(F.filesPanelDestination()), 'api', 'non-vacuity: the header names the project');
  assert.equal(destName(F.destinationOfPane(pane).dest), 'api');

  v.root = { kind: 'project', id: 'p1' };
  assert.equal(destName(F.destinationOfActiveView()), 'api');
  assert.equal(destName(F.destinationOfPane(pane).dest), 'api');

  // A plain session tab: the session s own project answers for its pane.
  v.root = null;
  assert.equal(destName(F.destinationOfActiveView()), null);
  assert.equal(destName(F.destinationOfPane(pane).dest), 'api');

  // A session with no project falls back to the folder its TAB is rooted at —
  // the drop lands where the tab already says it is.
  st.setSessions([mkSession('s1')]);
  v.root = { kind: 'home' };
  assert.equal(destName(F.destinationOfPane(pane).dest), 'Home');

  st.setProjects([project('p1', 'api')]);
  v.root = { kind: 'project', id: 'p1' };
  assert.equal(destName(F.destinationOfPane(pane).dest), 'api', 'the rooted tab names it');

  // Neither a project nor a rooted tab: since part B2 the session's own
  // WORKING DIRECTORY names it (orchestrator default, §4b) — HISTORY already
  // groups such a session under that folder's last segment, so this is the
  // name the app already uses, not one it invented. A9's refusal is kept for
  // the genuinely nameless case below.
  v.root = null;
  assert.deepEqual(F.destinationOfPane(pane), { dest: { path: SCRATCH, name: 'scratch' } });

  st.setSessions([mkSession('s1', { cwd: '' })]);
  assert.deepEqual(F.destinationOfPane(pane), { dest: null, why: 'session' });
});

test('a FILE pane in a rootless tab borrows the tab s own first session, as the header does', async () => {
  // The panel header already answers this case (`subject()`); a pane that
  // answered null instead would flash a sentence about a session that is not
  // in that pane at all.
  await liveSession();
  const v = st.state.views.find((x) => x.slots.length > 0) as ViewLike;
  st.state.activeViewId = v.id;
  v.root = null;
  v.slots.push(ed('web/src/App.tsx'));
  const filePane = dom.doc.createElement('section');
  filePane.dataset.slot = String(v.slots.length - 1);
  assert.equal(destName(F.destinationOfPane(filePane).dest), 'api', 'the tab s own session names it');

  // Nothing in the tab to borrow a folder from: the refusal is about the TAB.
  st.setSessions([mkSession('s1')]);
  assert.deepEqual(F.destinationOfPane(filePane), { dest: null, why: 'tab' });
});

test('a destination s listing is the REAL folder s own top-level names, read now', async () => {
  // The conflict question is asked against this and nothing else, so it may
  // never carry paths or a recursive walk — and since part B2 it is a fresh
  // request against `dest.path`, never the panel s cache: a stale listing is
  // the one lie that decides whether a file is overwritten.
  await homeWorld();
  entryCalls.length = 0;
  const src = { path: `${HOME}/web/src`, name: 'src' };
  assert.deepEqual(await F.listingFor(src), ['App.tsx', 'Pane.tsx', 'TabStrip.tsx', 'store.ts']);
  assert.deepEqual(entryCalls, [`${HOME}/web/src`], 'one request, for the destination itself');

  const top = await F.listingFor({ path: HOME, name: 'Home' });
  assert.deepEqual(top, ['web', 'server', 'launcher', 'shared', 'README.md', 'LICENSE']);
  assert.ok(top.every((n) => !n.includes('/')), 'names, never paths');
});

test('a listing that FAILS opens the dialog with no conflicts — the drop is not lost', async () => {
  await homeWorld();
  failWith.set(`${HOME}/web`, new FakeApiError(403, 'This folder is outside your home folder.'));
  assert.deepEqual(
    await F.listingFor({ path: `${HOME}/web`, name: 'web' }),
    [],
    'not knowing is read as "no known conflicts", which is the non-destructive answer',
  );
});

test('every destination is the A9/A9b NAME with the real folder behind it (parity)', async () => {
  // The B2 contract in one test: not one VISIBLE string changed — the ghost,
  // the dialog, the strip button and its title all read `.name`, which is what
  // A9 and A9b already showed — and every one of them now carries the PATH
  // part B10's upload posts to.
  await liveSession();
  const v = st.state.views.find((x) => x.slots.length > 0) as ViewLike;
  st.state.activeViewId = v.id;
  v.root = { kind: 'project', id: 'p1' };
  const pane = dom.doc.createElement('section');
  pane.dataset.slot = '0';

  assert.deepEqual(F.filesPanelDestination(), { path: PROJ, name: 'api' });
  assert.deepEqual(F.destinationOfActiveView(), { path: PROJ, name: 'api' });
  assert.deepEqual(F.destinationOfPane(pane), { dest: { path: PROJ, name: 'api' } });
  assert.deepEqual(F.pasteDestination(), { path: PROJ, name: 'api' });

  dirRow('web/src').click(); // select it
  await settle();
  assert.deepEqual(F.selectedFolder(), { path: `${PROJ}/web/src`, name: 'src' });
  assert.deepEqual(F.pasteDestination(), { path: `${PROJ}/web/src`, name: 'src' });
  assert.equal((byKey(root, 'fcopy') as FakeElement).textContent, 'Copy files into src…');
  assert.equal((byKey(root, 'fcopy') as FakeElement).title, 'Copy files into src');
  dispatch(root, 'keydown', { key: 'Escape' });

  // At Home the root's name is the header's own word, never the folder's last
  // segment — one screen, one name.
  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  await homeWorld();
  assert.deepEqual(F.filesPanelDestination(), { path: HOME, name: 'Home' });
  assert.equal((byKey(root, 'fcopy') as FakeElement).title, 'Copy files into Home');
});

test('every row state has a rule, and every rule has a setter (class parity)', () => {
  // A class with no rule paints nothing and no DOM test can see it; a rule
  // with no setter is dead CSS the next reader trusts. Part B2 adds `is-state`
  // and `is-err` to this vocabulary.
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'files.ts'), 'utf8');
  const app = readFileSync(join(here, '..', 'web', 'src', 'styles', 'app.css'), 'utf8');
  // Two other modules put a class on a row of this panel: the drop layer
  // lights the folder under the pointer (`is-drop`), and the in-app drag
  // recedes the row it picked up (`is-dragging`).
  const drop = readFileSync(join(here, '..', 'web', 'src', 'ui', 'filedrop.ts'), 'utf8');
  const dnd = readFileSync(join(here, '..', 'web', 'src', 'ui', 'dnd.ts'), 'utf8');
  const all = `${src}\n${drop}\n${dnd}`;

  /** The `is-*` states a `.files-row` can wear, by the rules that style them. */
  const ruled = new Set<string>();
  for (const m of app.matchAll(/\.files-row((?:\.is-[a-z-]+)+)/g)) {
    for (const c of (m[1] as string).split('.')) if (c.startsWith('is-')) ruled.add(c);
  }
  assert.ok(ruled.size >= 5, `non-vacuity: ${[...ruled].join(', ')}`);
  assert.ok(ruled.has('is-state') && ruled.has('is-err'), 'the two states part B2 adds');

  // Every rule has a setter somewhere in the three modules that dress a row.
  for (const c of ruled) {
    assert.ok(
      new RegExp(`classList\\.(?:add|toggle)\\(\\s*'${c}'`).test(all) ||
        new RegExp(`'files-row[^']*\\b${c}\\b`).test(all),
      `.files-row.${c} is styled but nothing ever sets it`,
    );
  }

  // And the other direction, for the vocabulary this panel owns: a row class
  // the module sets with no rule behind it. `is-file` is deliberately not in
  // this list — it is a MARKER (a file row is styled by `.files-row` plus its
  // badge and name), and it has carried no rule of its own since A6.
  for (const c of ['is-dir', 'is-sel', 'is-busy', 'is-open', 'is-state', 'is-err']) {
    assert.ok(
      new RegExp(`classList\\.(?:add|toggle)\\(\\s*'${c}'`).test(src) ||
        new RegExp(`'files-row[^']*\\b${c}\\b`).test(src),
      `non-vacuity: ui/files.ts never sets ${c}`,
    );
    assert.ok(ruled.has(c), `.files-row.${c} is set but never styled`);
  }

  // Tokens only: the new rules may not carry a colour literal.
  const block = app.slice(app.indexOf('.files-row.is-state'), app.indexOf('.files-row.is-busy'));
  assert.ok(block.length > 100, 'non-vacuity: the block was found');
  assert.equal(/#[0-9a-f]{3,8}\b|rgb\(|oklch\(/i.test(block), false, `a colour literal: ${block}`);
});

test('every sentence the panel can print follows the copy rules', () => {
  // A scan over the strings part B2 added, in the module that prints them:
  // no path, no flag, no command, no key name, and a full stop on a sentence.
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'files.ts'), 'utf8');
  const fsModel = readFileSync(join(here, '..', 'web', 'src', 'ui', 'fs-model.ts'), 'utf8');
  const sentences = [
    'The app could not reach the service.',
    'Loading…',
    'Empty folder',
    'No changes since the last commit.',
    '1 more item is not shown here.',
    '200 more items are not shown here.',
  ];
  assert.ok(src.includes('The app could not reach the service.'), 'non-vacuity');
  assert.ok(fsModel.includes('No changes since the last commit.'), 'non-vacuity');
  for (const line of sentences) {
    assert.equal(/\//.test(line), false, `a path in: ${line}`);
    assert.equal(/--|\bgit\b|\bnpm\b/.test(line), false, `a command or a flag in: ${line}`);
    assert.equal(/ctrl|alt|shift|Escape/i.test(line), false, `a key name in: ${line}`);
    if (line.includes(' ') && /^[A-Z0-9]/.test(line)) {
      assert.ok(line.endsWith('.') || line === 'Empty folder', `no full stop: ${line}`);
    }
  }
  // The title on a disabled tab is a FRAGMENT on a control, so it carries no
  // full stop — and it names the subject, never a path.
  assert.match(src, /return `No repository at \$\{name\}`;/);
});

// ---------------------------------------------------------------------------
// The fix round (part B2, 2026-09-16)
// ---------------------------------------------------------------------------

test('a right-click on a STATE row and on a Changes row is left to the system menu', async () => {
  // A row that has no actions may not EAT the gesture: preventing before the
  // key was read left `Loading…`, a refusal and every `Changes` row with no app
  // menu AND no system menu — a right-click that did nothing at all.
  await liveSession();
  fx.hold();
  dirRow('launcher').click();
  const stateRow = byClass(root, 'files-row').find((r) => r.textContent === 'Loading…') as FakeElement;
  assert.ok(stateRow !== undefined, 'non-vacuity: a state row is on screen');
  const onState = dispatch(stateRow, 'contextmenu', { clientX: 10, clientY: 10 });
  assert.equal(onState.defaultPrevented, false, 'the app took a right-click it has no menu for');
  assert.equal(byClass(dom.body, 'cm-menu').length, 0, 'and opened nothing');
  fx.release();
  await settle();

  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  const changeRow = byKey(root, 'gdir:web') as FakeElement;
  assert.ok(changeRow !== null, 'non-vacuity: a Changes row is on screen');
  const onChange = dispatch(changeRow, 'contextmenu', { clientX: 10, clientY: 10 });
  assert.equal(onChange.defaultPrevented, false, 'a repo-relative row has no actions either');
  assert.equal(byClass(dom.body, 'cm-menu').length, 0);
  (byKey(root, 'ftab:files') as FakeElement).click();
});

test('a changed file row promises only what it does', async () => {
  await liveSession();
  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  const folder = byKey(root, 'gdir:server') as FakeElement;
  if (folder.getAttribute('aria-expanded') !== 'true') folder.click();
  const row = byKey(root, 'gfile:server/ws.ts') as FakeElement;
  assert.ok(row !== null, 'non-vacuity: the changed file row is on screen');
  assert.equal(row.title, 'Open in a pane.', 'no drag, no chord, no menu — so it names none of them');
  assert.equal(row.getAttribute('aria-haspopup'), null, 'it opens no menu');
  // And the TREE row, which really is all three, keeps its own sentence.
  (byKey(root, 'ftab:files') as FakeElement).click();
  assert.match(fileRow('web/src/Pane.tsx').title, /ctrl\+alt\+enter/);
});

test('only a §1d-shaped sentence reaches a row; anything else is the app s own line', async () => {
  // `request()` invents `HTTP <status>` when a body carries no `error`, and an
  // older backend answers the picker's lowercase vocabulary. Neither is a
  // sentence this app wrote, and neither may be printed as one.
  await liveSession();
  for (const [message, shown] of [
    ['not found', 'The app could not reach the service.'],
    ['HTTP 502', 'The app could not reach the service.'],
    ['permission denied', 'The app could not reach the service.'],
    ['You do not have permission to read this folder.', 'You do not have permission to read this folder.'],
  ] as const) {
    failWith.set(`${PROJ}/launcher`, new FakeApiError(500, message));
    await reopen('launcher');
    const row = byClass(root, 'files-row').find((r) => r.classList.contains('is-err')) as FakeElement;
    assert.ok(row !== undefined, `non-vacuity: no refusal row for ${message}`);
    assert.equal(row.textContent, shown, `${message} is rendered as ${row.textContent}`);
  }
  failWith.clear();
  await reopen('launcher');
});

test('moving between two repositories keeps the Changes tab — unknown is not "no"', async () => {
  // `setRoot` drops the old git answer, so for the width of one call the panel
  // does not know. Falling back on "not yet" took the tab away from anyone
  // switching projects — the one tab they were watching, lost twice a click.
  fx.setChanges((r) => (r === PROJ || r === PROJ2 ? repoAnswer({ repoRoot: r }) : NO_REPO));
  await liveSession();
  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  assert.equal(
    (byKey(root, 'ftab:changes') as FakeElement).getAttribute('aria-pressed'),
    'true',
    'non-vacuity: standing on Changes over repository A',
  );

  // Repository B, with its answer held: the tab is still the one on screen.
  fx.hold();
  st.setProjects([project('p1', 'api'), project('p2', 'tools')]);
  st.setSessions([mkSession('s2', { projectId: 'p2' })]);
  focusSession('s2');
  panel.render();
  assert.equal(
    (byKey(root, 'ftab:changes') as FakeElement).getAttribute('aria-pressed'),
    'true',
    'the wished tab survives the unknown window',
  );
  fx.release();
  await settle();
  assert.equal(
    (byKey(root, 'ftab:changes') as FakeElement).getAttribute('aria-pressed'),
    'true',
    'and B s answer keeps it',
  );
  assert.equal((byKey(root, 'ftab:changes') as FakeElement).disabled, false);

  // A root with NO repository is the definite no: only then does it fall back.
  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  rootNow = HOME;
  panel.render();
  await settle();
  assert.equal((byKey(root, 'ftab:files') as FakeElement).getAttribute('aria-pressed'), 'true');
  assert.equal((byKey(root, 'ftab:changes') as FakeElement).disabled, true);

  // …and the wish is remembered: a repository again brings the tab back.
  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  focusSession('s1');
  rootNow = PROJ;
  panel.render();
  await settle();
  assert.equal(
    (byKey(root, 'ftab:changes') as FakeElement).getAttribute('aria-pressed'),
    'true',
    'the tab the user chose comes back with its repository',
  );
  (byKey(root, 'ftab:files') as FakeElement).click();
});

test('the Home tab is HOME, whatever is running in another tab', async () => {
  // User decision 2026-09-16. Until part B2 the last rung was "the first live
  // session anywhere", which only chose a NAME over a mock. It now chooses a
  // FOLDER, and a tree about a session nobody is looking at is a tree about
  // the wrong thing.
  await liveSession();
  assert.equal(textsOf(root, 'files-proj')[0], 'api', 'non-vacuity: the session s tab is up');

  const home = st.state.views.find((v) => v.root !== null && v.root.kind === 'home') as ViewLike;
  assert.ok(home !== undefined, 'non-vacuity: the fixed Home tab exists');
  st.state.activeViewId = home.id;
  rootNow = HOME;
  panel.render();
  await settle();
  assert.equal(st.aliveSessionCount(), 1, 'non-vacuity: the session is still running');
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'the header follows the tab, not the session');
  assert.deepEqual(
    textsOf(root, 'files-name'),
    ['web', 'server', 'launcher', 'shared', 'README.md', 'LICENSE'],
    'and so does the tree',
  );
  assert.deepEqual(F.filesPanelDestination(), { path: HOME, name: 'Home' });
});

// ---------------------------------------------------------------------------
// After a copy, and the clipboard (part B10)
// ---------------------------------------------------------------------------

test('refreshAfterDrop re-reads the ROOT the copy landed in', async () => {
  await liveSession();
  fx.entryCalls.length = 0;
  F.refreshAfterDrop({ path: PROJ, name: 'api' });
  await settle();
  assert.deepEqual(fx.entryCalls, [PROJ], 'exactly one listing, for the folder that changed');
});

test('refreshAfterDrop re-reads an OPEN folder, and asks for nothing else', async () => {
  await liveSession();
  fx.entryCalls.length = 0;
  F.refreshAfterDrop({ path: `${PROJ}/web`, name: 'web' });
  await settle();
  assert.deepEqual(fx.entryCalls, [`${PROJ}/web`]);
});

test('a copy into a folder nobody opened costs NO request at all', async () => {
  await liveSession();
  fx.entryCalls.length = 0;
  // `shared` is in the tree and has never been expanded: there is no listing
  // of it on screen, so re-reading it would be a request thrown away.
  F.refreshAfterDrop({ path: `${PROJ}/shared`, name: 'shared' });
  await settle();
  assert.deepEqual(fx.entryCalls, []);
  // Nor does a folder of another root, or one that is not in the tree at all.
  F.refreshAfterDrop({ path: '/somewhere/else', name: 'else' });
  await settle();
  assert.deepEqual(fx.entryCalls, []);
});

test('the copy that landed is on screen after ONE refresh', async () => {
  await liveSession();
  (fx.tree.get(`${PROJ}/web`) ?? []).push({ name: 'dropped.txt', dir: false });
  F.refreshAfterDrop({ path: `${PROJ}/web`, name: 'web' });
  await settle();
  assert.ok(
    textsOf(root, 'files-name').includes('dropped.txt'),
    'the panel shows what the drop put there',
  );
});

test('Copy on a row: the BACKEND maps the path, the host gets it, and the flash names the row', async () => {
  await liveSession();
  const win = dom.win as unknown as { chrome?: { webview: unknown } };
  const posted: string[] = [];
  const listeners: ((e: { data?: unknown }) => void)[] = [];
  win.chrome = {
    webview: {
      postMessage: (m: string) => posted.push(m),
      addEventListener: (_t: string, fn: (e: { data?: unknown }) => void) => listeners.push(fn),
      removeEventListener: (_t: string, fn: (e: { data?: unknown }) => void) => {
        const i = listeners.indexOf(fn);
        if (i !== -1) listeners.splice(i, 1);
      },
    },
  };
  try {
    dispatch(fileRow('README.md'), 'contextmenu', { clientX: 10, clientY: 10 });
    const copy = byClass(dom.body, 'cm-item').find((b) => b.textContent.startsWith('Copy'));
    assert.ok(copy !== undefined, 'non-vacuity: the menu is open and carries the entry');
    assert.equal(copy.getAttribute('aria-disabled'), null, 'a native window can copy');
    copy.click();
    await settle();
    assert.deepEqual(fx.winPathCalls, [`${PROJ}/README.md`], 'the mapping is the server s');
    assert.deepEqual(posted, ['copy-files\n\\\\wsl.localhost\\Ubuntu\\work\\api\\README.md']);
    for (const fn of [...listeners]) fn({ data: 'copy-files ok 1' });
    await settle();
    assert.equal(flashText(), 'Copied README.md to the clipboard.', 'by NAME, never by path');
  } finally {
    delete win.chrome;
    clearFlash();
  }
});

test('Copy that the host refuses says so, in one sentence, whatever went wrong', async () => {
  await liveSession();
  const win = dom.win as unknown as { chrome?: unknown };
  try {
    // No host at all: the entry is visibly disabled and nothing is asked for.
    dispatch(fileRow('README.md'), 'contextmenu', { clientX: 10, clientY: 10 });
    const copy = byClass(dom.body, 'cm-item').find((b) => b.textContent.startsWith('Copy'));
    assert.equal(copy?.getAttribute('aria-disabled'), 'true');
    assert.ok(
      copy?.textContent.includes('This window cannot put files on the clipboard.'),
      `the note is the one the model owns: ${copy?.textContent}`,
    );
    copy?.click();
    await settle();
    assert.deepEqual(fx.winPathCalls, [], 'a disabled entry asks the server nothing');
    assert.equal(flashText(), '');

    // A host that IS there, and a path the backend will not map (422).
    win.chrome = {
      webview: {
        postMessage: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    };
    fx.winPathFails = new FakeApiError(422, 'That file cannot be reached from Windows.');
    dispatch(fileRow('README.md'), 'contextmenu', { clientX: 10, clientY: 10 });
    const live = byClass(dom.body, 'cm-item').find((b) => b.textContent.startsWith('Copy'));
    assert.equal(live?.getAttribute('aria-disabled'), null);
    live?.click();
    await settle();
    assert.equal(flashText(), 'The app could not copy that to the clipboard.');
    assert.equal(flashText().includes('/'), false, 'and it carries no path');
  } finally {
    delete win.chrome;
    clearFlash();
  }
});
