/**
 * Shared setup for `tests/ui/ui-files-delete*.test.ts` (Nocturne part B10a,
 * `memory/decisions/b10a-multi-select-and-delete.md`): the fake `FsGateway`
 * of `tests/helpers/fs-fixture.ts` and the DOM double, then the REAL
 * `web/src/state.ts`, `ui/files.ts`, `ui/filedrop.ts`, `ui/delete-dialog.ts`,
 * `ui/drop-dialog.ts` and `ui/statusline.ts`; the Files panel with the drop
 * layer wired, the statusline every answer is said on, a project tab with a
 * SECOND project registered inside its tree (the anchor a row may never
 * delete), and the row, menu and dialog helpers. Not a test.
 *
 * Each test file calls `resetWorld()` in its own `beforeEach`.
 */
import assert from 'node:assert/strict';
import type { Project, SessionInfo } from '../../shared/protocol.ts';
import { byClass, byKey, dispatch, installDom, FakeElement } from './fake-dom.ts';
import { PROJ, SCRATCH, makeFixture, settle, type Gateway } from './fs-fixture.ts';

export const fx = makeFixture();
export const dom = installDom();

export const st = (await import(new URL('../../web/src/state.ts', import.meta.url).href)) as StateModule;
export const F = (await import(new URL('../../web/src/ui/files.ts', import.meta.url).href)) as FilesModule;
export const FD = (await import(new URL('../../web/src/ui/filedrop.ts', import.meta.url).href)) as {
  initFileDrop(deps: Record<string, unknown>): void;
};
export const DD = (await import(new URL('../../web/src/ui/delete-dialog.ts', import.meta.url).href)) as {
  isDeleteDialogOpen(): boolean;
  deleteDialogEscape(): void;
};
export const DROP = (await import(new URL('../../web/src/ui/drop-dialog.ts', import.meta.url).href)) as {
  openDropDialog(req: Record<string, unknown>): void;
  dropDialogEscape(): void;
  isDropRunning(): boolean;
};
export const SL = (await import(new URL('../../web/src/ui/statusline.ts', import.meta.url).href)) as {
  initStatusline(container: unknown, deps: { openShortcuts(): void }): { render(): void };
};

export interface StateModule {
  state: {
    sessions: Map<string, SessionInfo>;
    projects: Project[];
    views: { id: string; root: unknown; slots: unknown[]; focused: number }[];
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
  filesPanelVisible(): boolean;
}
export interface Dest {
  path: string;
  name: string;
}
export interface FilesModule {
  initFilesPanel(host: unknown, onLeaveScreen: () => void, fs: Gateway): { render(): void };
  pasteDestination(): Dest | null;
  selectedFolder(): Dest | null;
  filesPanelDestination(): Dest | null;
  destinationOfActiveView(): Dest | null;
  destinationOfPane(paneEl: unknown): unknown;
  listingFor(dest: Dest): Promise<readonly string[]>;
}

export const host = dom.doc.createElement('aside');
host.className = 'drawer files-panel';
dom.body.append(host);
export const panel = F.initFilesPanel(host, () => {}, fx.gateway);
export const root = host.children[0] as FakeElement;
st.subscribe(() => panel.render());

// The drop layer, wired like every other Files test: the panel reaches it for
// `Copy files here…` only, and `initFileDrop` keeps that seam from being unset.
FD.initFileDrop({
  openDialog: () => {},
  listingFor: (dest: Dest) => F.listingFor(dest),
  destinationOfPane: (el: unknown) => F.destinationOfPane(el),
  destinationOfActiveView: () => F.destinationOfActiveView(),
  filesPanelDestination: () => F.filesPanelDestination(),
  pasteDestination: () => F.pasteDestination(),
  selectedFolder: () => F.selectedFolder(),
  openPicker: () => {},
  flash: () => {},
});

// The statusline, because every answer this file is about is SAID there.
export const statusHost = dom.doc.createElement('div');
dom.body.append(statusHost);
SL.initStatusline(statusHost, { openShortcuts: () => {} });
dom.win.intervals.length = 0;

export function flashText(): string {
  return byClass(statusHost, 'status-flash')[0]?.textContent ?? '';
}

/**
 * Wait for a CONDITION, with a bound — never for a duration. A batch the size
 * of the cap runs a hundred awaits in sequence, which is more turns than one
 * `settle()` drains; a `sleep` here would be the flaky test this suite refuses.
 */
export async function until(done: () => boolean, passes = 200): Promise<void> {
  for (let i = 0; i < passes && !done(); i += 1) await settle();
}

/** Fire every recorded timer, which is what takes a flash back down. */
export function clearFlash(): void {
  const due = [...dom.win.timers];
  dom.win.timers.length = 0;
  for (const t of due) t.fn();
}

// ---------------------------------------------------------------------------
// The world: a project tab, and a SECOND project registered inside its tree
// (`/work/api/shared`) — the anchor a row may never delete.
// ---------------------------------------------------------------------------

export const ANCHOR = `${PROJ}/shared`;

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

export async function liveSession(): Promise<void> {
  st.setProjects([
    { id: 'p1', name: 'api', path: PROJ, createdAt: new Date().toISOString() } as Project,
    // Registered INSIDE the tree on purpose: its row is an anchor, and the
    // server refuses it too (`server/fsdelete.ts`, FS_DELETE_ANCHOR).
    { id: 'p2', name: 'shared', path: ANCHOR, createdAt: new Date().toISOString() } as Project,
  ]);
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  const v = st.state.views.find((x) =>
    x.slots.some((s) => (s as { kind: string; id?: string }).id === 's1'),
  );
  if (v !== undefined) st.state.activeViewId = v.id;
  st.state.leftPanel = 'files';
  panel.render();
  await settle();
  await expand('web', 'web/src', 'server');
}

/** Open these folders the way a user does, then drop what those clicks chose. */
export async function expand(...rels: string[]): Promise<void> {
  for (const rel of rels) {
    const r = dirRow(rel);
    if (r === null || r.getAttribute('aria-expanded') === 'true') continue;
    r.click();
    await settle();
  }
  dispatch(root, 'keydown', { key: 'Escape' });
}

export const dirRow = (rel: string): FakeElement => byKey(root, `fdir:${PROJ}/${rel}`) as FakeElement;
export const fileRow = (rel: string): FakeElement => byKey(root, `ffile:${PROJ}/${rel}`) as FakeElement;
export const body = (): FakeElement => byClass(root, 'files-body')[0] as FakeElement;

/** The chosen rows, by key with the root's prefix cut, in tree order. */
export function chosen(): string[] {
  return byClass(root, 'is-sel').map((n) =>
    (n.getAttribute('data-k') ?? '').replace(`:${PROJ}/`, ':'),
  );
}

/** Every row the tree is drawing right now, same shortened keys. */
export function rowKeys(): string[] {
  return byClass(root, 'files-row')
    .map((n) => n.getAttribute('data-k') ?? '')
    .filter((k) => k.startsWith('fdir:') || k.startsWith('ffile:'))
    .map((k) => k.replace(`:${PROJ}/`, ':'));
}

// ---- the menu -------------------------------------------------------------

export const rightClick = (el: FakeElement): void => {
  dispatch(el, 'contextmenu', { clientX: 10, clientY: 10 });
};
export const menuBox = (): FakeElement | undefined => byClass(dom.body, 'cm-menu')[0];
export const menuItems = (): FakeElement[] => byClass(dom.body, 'cm-item');
export const menuLabels = (): string[] => menuItems().map((b) => byClass(b, 'cm-label')[0]?.textContent ?? '');
export function menuEntry(label: string): FakeElement {
  const hit = menuItems().find((b) => byClass(b, 'cm-label')[0]?.textContent === label);
  assert.ok(hit !== undefined, `the menu must carry ${label}: ${menuLabels().join(', ')}`);
  return hit;
}

// ---- the dialog -----------------------------------------------------------

export const dialog = (): FakeElement | undefined => byClass(dom.body, 'dd-modal')[0];
export const dialogTitle = (): string => byClass(dom.body, 'dd-title')[0]?.textContent ?? '';
export const dialogSub = (): string | null => byClass(dom.body, 'dd-sub')[0]?.textContent ?? null;
export function dialogButton(label: string): FakeElement {
  const hit = byClass(dom.body, 'dd-ft')[0]
    ?.children.filter((c): c is FakeElement => c instanceof FakeElement)
    .find((b) => b.textContent === label);
  assert.ok(hit !== undefined, `the dialog must carry ${label}`);
  return hit;
}

/** Open the row menu on a row and choose `Delete` — the pointer path. */
export function deleteFromMenu(row: FakeElement): void {
  rightClick(row);
  menuEntry('Delete').click();
}

/** The Delete KEY, pressed wherever the keyboard is standing. */
export function pressDelete(target: FakeElement = root): ReturnType<typeof dispatch> {
  return dispatch(target, 'keydown', { key: 'Delete' });
}

/** Sorted copy, for the assertions that do not care about tree order. */
export function sorted(xs: readonly string[]): string[] {
  return [...xs].sort();
}

/**
 * The world every test starts from — each file's `beforeEach` awaits it.
 * Anything a previous test left open is closed through the app's own doors.
 */
export async function resetWorld(): Promise<void> {
  dom.storage.clear();
  fx.reset();
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
  dom.doc.activeElement = dom.body;
  clearFlash();
  // Anything a previous test left open, closed through the app's own doors.
  if (DD.isDeleteDialogOpen()) DD.deleteDialogEscape();
  panel.render();
  dispatch(root, 'keydown', { key: 'Escape' });
  await settle();
}
