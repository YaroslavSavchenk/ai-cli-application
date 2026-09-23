/**
 * Shared boot for the Files panel tests (`tests/ui/ui-files-panel*.test.ts`,
 * Nocturne A5, live since B2): the fake backend (`makeFixture()`), the DOM
 * double, the REAL `web/src/state.ts`, `ui/files.ts`, `ui/files-model.ts`,
 * `ui/commit-model.ts`, `ui/filedrop.ts` (its picker seam injected, part A9),
 * `ui/commit-store.ts` and `ui/statusline.ts` (where part B10's `Copy` says
 * what happened) — ONE panel mounted on a host — plus the row lookups, the
 * worlds a test stands in (`homeWorld`, `liveSession`) and `resetPanel()`.
 *
 * Module-level on purpose: `makeFixture()`, `installDom()` and the imports of
 * the browser modules must run in this order before any test, once per test
 * file (`node --test` gives every file its own process). Not a test.
 */
import type { Project, SessionInfo } from '../../shared/protocol.ts';
import {
  byClass,
  byKey,
  dispatch,
  installDom,
  type FakeElement,
} from './fake-dom.ts';
import {
  HOME,
  PROJ,
  SCRATCH,
  makeFixture,
  settle,
  type Gateway,
  mkProject as project,
} from './fs-fixture.ts';
import { NOW } from './commits-fixture.ts';

/** The fake backend every test below drives the panel against (`fs-fixture.ts`). */
export const fx = makeFixture();
export const { gateway, entryCalls, changeCalls, commitsCalls, failWith } = fx;

export const dom = installDom();

// The modules are imported through a computed URL: the server tsconfig must
// not walk the browser type graph (web/tsconfig.json owns that).
export const st = (await import(new URL('../../web/src/state.ts', import.meta.url).href)) as StateModule;

/** Sessions that have not exited — the non-vacuity count some tests assert on. */
export const aliveSessionCount = (): number =>
  [...st.state.sessions.values()].filter((x) => x.status !== 'exited').length;
export const F = (await import(new URL('../../web/src/ui/files.ts', import.meta.url).href)) as FilesModule;
export const M = (await import(new URL('../../web/src/ui/files-model.ts', import.meta.url).href)) as ModelModule;
export const MODEL = (await import(new URL('../../web/src/ui/commit-model.ts', import.meta.url).href)) as {
  blockDomId(hash: string, path: string): string;
};
// Part A9: the row-level copy chord goes through this module's picker seam, so
// the panel is driven against the REAL filedrop layer with the chooser (and the
// dialog) injected — exactly the seam `tests/ui/ui-filedrop.test.ts` uses.
export const FD = (await import(new URL('../../web/src/ui/filedrop.ts', import.meta.url).href)) as FileDropModule;
export interface Dest {
  path: string;
  name: string;
}
export interface DropReq {
  dest: Dest;
  items: { name: string; dir: boolean; bytes: number | null }[];
  listing: readonly string[];
}
export interface FileDropModule {
  initFileDrop(deps: Record<string, unknown>): void;
}
/** Every drop the panel handed on, in order. */
export const dropped: DropReq[] = [];
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

export interface StateModule {
  state: {
    sessions: Map<string, SessionInfo>;
    openCommit: string | null;
    openCommitAt: { root: string; repoRoot: string } | null;
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
  setProjects(list: Project[]): void;
  subscribe(fn: (kind: string) => void): void;
  toggleLeftPanel(p: 'files'): void;
  filesPanelVisible(): boolean;
  openCommitView(hash: string, at: { root: string; repoRoot: string }): void;
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
export type EditorTab = { kind: 'file'; path: string } | { kind: 'diff'; hash: string; path: string };
export type PaneSlot =
  | { kind: 'session'; id: string }
  | { kind: 'editor'; id: string; tabs: EditorTab[]; active: number };
export type ViewRoot = { kind: 'home' } | { kind: 'project'; id: string };
export interface ViewLike {
  id: string;
  root: ViewRoot | null;
  slots: PaneSlot[];
  focused: number;
  l3?: 'L' | 'R';
  split?: { col: number; row: number };
}
/** An editor pane holding these files, in strip order, the first one active. */
export function ed(...paths: string[]): PaneSlot {
  return st.newEditorSlot(paths.map((path) => ({ kind: 'file', path })));
}

export interface FilesModule {
  initFilesPanel(
    host: unknown,
    onLeaveScreen: () => void,
    fs: Gateway,
    now?: () => number,
  ): { render(): void };
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


export interface ModelModule {
  buildTree(files: readonly { path: string }[]): unknown[];
  treeRows(nodes: readonly unknown[], open: ReadonlySet<string>): { path: string; dir: boolean; busy: boolean }[];
}
export const host = dom.doc.createElement('aside');
dom.body.append(host);
/** The keyboard hand-back main.ts injects (the real one focuses a terminal). */
export let handBacks = 0;
export const panel = F.initFilesPanel(
  host,
  () => {
    handBacks += 1;
  },
  gateway,
  () => NOW,
);
/**
 * The selected-commit state reads the ONE answer the commit view fetched
 * (`ui/commit-store.ts`), so the store gets the same fake — exactly as main.ts
 * hands it the same object it hands the panel.
 */
export const STORE = (await import(new URL('../../web/src/ui/commit-store.ts', import.meta.url).href)) as {
  setCommitGateway(gw: unknown): void;
  syncCommit(hash: string | null, root: string | null): void;
};
STORE.setCommitGateway(gateway);

/**
 * The commit VIEW is what asks for an open commit (main.ts renders it first on
 * every notification); this file drives the panel alone, so it stands in for
 * that one call — and for nothing else.
 */
export function viewRender(): void {
  STORE.syncCommit(st.state.openCommit, st.state.openCommitAt?.root ?? null);
}
export const root = host.children[0] as FakeElement;

/**
 * The statusline, because part B10's `Copy` SAYS what happened there and
 * nowhere else. It is the same double `tests/ui/ui-dnd-a10.test.ts` uses: the
 * real module, in a host of its own, read back through `.status-flash`.
 */
export const statusHost = dom.doc.createElement('div');
dom.body.append(statusHost);
export const SL = (await import(new URL('../../web/src/ui/statusline.ts', import.meta.url).href)) as {
  initStatusline(container: unknown, deps: { openShortcuts(): void }): { render(): void };
};
SL.initStatusline(statusHost, { openShortcuts: () => {} });
// Its 15 s uptime ticker is recorded like every timer in the double, and the
// `Changes` poll is counted by READING that list — so the statusline's own
// interval is taken back off it here, where it is created and never used.
dom.win.intervals.length = 0;

export function flashText(): string {
  return byClass(statusHost, 'status-flash')[0]?.textContent ?? '';
}

/** Fire every recorded timer, which is what takes a flash back down. */
export function clearFlash(): void {
  const due = [...dom.win.timers];
  dom.win.timers.length = 0;
  for (const t of due) t.fn();
}

/** Everything `notify()` emitted since the last reset. */
export const kinds: string[] = [];
st.subscribe((k) => {
  kinds.push(k);
  // The shell re-renders the panel on every change (main.ts); without this the
  // A6 screens — which live in state, not in the panel — would never reach it.
  panel.render();
});

export function mkSession(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
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

/**
 * Which root the panel is standing in right now, so a test can name a row by
 * the same relative path it always did. The KEYS are absolute since part B2 —
 * `dirRow`/`fileRow` build them, and one test pins that outright.
 *
 * A test file whose tests assign `rootNow` declares its own `let rootNow` and
 * hands it over with `bindRootNow` (an imported binding cannot be assigned);
 * otherwise the value lives here.
 */
let rootStore = HOME;
let rootAccess = {
  get: (): string => rootStore,
  set: (p: string): void => {
    rootStore = p;
  },
};
export function bindRootNow(access: { get(): string; set(p: string): void }): void {
  rootAccess = access;
}

export function dirRow(rel: string): FakeElement {
  return byKey(root, `fdir:${rootAccess.get()}/${rel}`) as FakeElement;
}
export function fileRow(rel: string): FakeElement {
  return byKey(root, `ffile:${rootAccess.get()}/${rel}`) as FakeElement;
}
/**
 * The NAME half of a destination — what A9/A9b showed, and what every
 * assertion below reads. Part B2 added the PATH behind it; the parity test at
 * the end of this file is the one place both halves are pinned together.
 */
export function destName(d: { name: string } | null): string | null {
  return d === null ? null : d.name;
}

/** A tab path with the root's prefix cut, so the pane shapes stay readable. */
export function short(path: string): string {
  return path.startsWith(`${rootAccess.get()}/`) ? path.slice(rootAccess.get().length + 1) : path;
}

/**
 * Open these folders, the way a user does — one click per folder, each
 * awaiting its listing — and then drop the selection those clicks made (A9b:
 * activating a folder row chooses it). The tree starts CLOSED since part B2:
 * there is no `MOCK_OPEN_FOLDERS` to seed it with any more, and a panel that
 * guessed which real folders to open would be guessing about a filesystem.
 */
export async function expand(...rels: string[]): Promise<void> {
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
export async function reopen(rel: string): Promise<void> {
  const row = dirRow(rel);
  if (row.getAttribute('aria-expanded') === 'true') {
    row.click();
    await settle();
  }
  dirRow(rel).click();
  await settle();
}

/** The panel at Home with nothing running: its very first state. */
export async function homeWorld(): Promise<void> {
  rootAccess.set(HOME);
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
export async function liveSession(): Promise<void> {
  rootAccess.set(PROJ);
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
export function focusSession(id: string): void {
  const v = st.state.views.find((x) =>
    x.slots.some((s) => s.kind === 'session' && s.id === id),
  );
  if (v !== undefined) st.state.activeViewId = v.id;
}

export const grip = byClass(root, 'files-grip')[0] as FakeElement;
export const body = byClass(root, 'files-body')[0] as FakeElement;
export const summary = byClass(root, 'files-sum')[0] as FakeElement;

/** The per-test reset: every Files panel file calls it from its own `beforeEach`. */
export function resetPanel(): void {
  dom.storage.clear();
  fx.reset();
  rootAccess.set(HOME);
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
  st.state.openCommitAt = null;
  st.state.commitCollapsed = new Set();
  st.state.edits = new Map();
  viewRender();
  dom.doc.activeElement = dom.body;
  // A9b: activating a folder row SELECTS it, and a selection outlives every
  // rebuild on purpose — so a row a previous test clicked would still be the
  // paste destination here. Escape on the panel root is the app's own way to
  // clear it (and does nothing when nothing is selected).
  dispatch(root, 'keydown', { key: 'Escape' });
}

/**
 * A view's panes as one readable picture: a session id, or the file tabs of an
 * editor pane in strip order, the ACTIVE one starred (A10b: a file is a TAB of
 * a pane, not a pane).
 */
export function shapeOf(v: ViewLike | null): string[] {
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

/**
 * Force a rebuild. The panel repaints on a SIGNATURE, so a test that pokes
 * `state.views` directly (instead of going through an action that notifies)
 * must drop the cache the way hiding and re-showing the panel does.
 */
export function repaint(): void {
  st.state.leftPanel = null;
  panel.render();
  st.state.leftPanel = 'files';
  panel.render();
}
