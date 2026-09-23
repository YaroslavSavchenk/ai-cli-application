/**
 * Shared setup for `tests/ui/ui-context-menu*.test.ts` (Nocturne parts A9b
 * brief 2, A9c, B10a): the DOM double installed at import with the one seam
 * the menu needs (the card's measured size, set the instant the module
 * appends it), the REAL `web/src/state.ts`, `ui/files.ts`, `ui/filedrop.ts`,
 * `ui/context-menu.ts` and `ui/context-menu-model.ts` imported after it, the
 * Files panel on the fake backend of `tests/helpers/fs-fixture.ts`, the drop
 * layer wired so the copy-files entry has a real path, the rest of the screen
 * a right-click must be left alone on, and the row/menu helpers. Not a test.
 *
 * Each test file registers its own hooks: `beforeEach(() => resetWorld())`
 * and an `afterEach` that closes the menu.
 */
import assert from 'node:assert/strict';
import type { Project, SessionInfo } from '../../shared/protocol.ts';
import {
  byClass,
  byKey,
  dispatch,
  installDom,
  setRect,
  textsOf,
  FakeElement,
  type FakeNode,
} from './fake-dom.ts';
import { PROJ, makeFixture, settle, type Gateway, mkSession, mkProject as project } from './fs-fixture.ts';
import { FILES_PANEL_SOURCES, readSources } from './helpers.ts';

/** The real panel against the fake backend of part B2 (`tests/helpers/fs-fixture.ts`). */
export const fx = makeFixture();

export const dom = installDom();

/**
 * THE ONE SEAM THIS FILE NEEDS. `ui/context-menu.ts` measures the card once
 * after appending it to the body, and the fake DOM answers only the rect a
 * test set — so the test sets it at the moment the module appends, which is
 * the single instant between creation and measurement. No change to
 * `tests/helpers/fake-dom.ts` was needed for it: `body.append` is an ordinary method.
 */
export let menuSize = { w: 200, h: 96 };
export const realAppend = dom.body.append.bind(dom.body);
(dom.body as unknown as { append(...n: (FakeNode | string)[]): void }).append = (...nodes) => {
  realAppend(...nodes);
  for (const n of nodes) {
    if (n instanceof FakeElement && n.classList.contains('cm-menu')) {
      setRect(n, { left: 0, top: 0, width: menuSize.w, height: menuSize.h });
    }
  }
};

export const st = (await import(new URL('../../web/src/state.ts', import.meta.url).href)) as StateModule;
export const F = (await import(new URL('../../web/src/ui/files.ts', import.meta.url).href)) as FilesModule;
export const FD = (await import(new URL('../../web/src/ui/filedrop.ts', import.meta.url).href)) as FileDropModule;
export const CM = (await import(new URL('../../web/src/ui/context-menu.ts', import.meta.url).href)) as MenuModule;
export const M = (await import(
  new URL('../../web/src/ui/context-menu-model.ts', import.meta.url).href
)) as ModelModule;

export interface StateModule {
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
  activeView(): ViewLike | null;
  openFile(root: ViewRoot, path: string, label: string): string;
  filesPanelVisible(): boolean;
  slotTabIds(slot: unknown): string[];
}
export interface Dest {
  path: string;
  name: string;
}
export interface FilesModule {
  initFilesPanel(host: unknown, onLeaveScreen: () => void, fs: Gateway): { render(): void };
  selectedFolder(): Dest | null;
  listingFor(dest: Dest): Promise<readonly string[]>;
  destinationOfPane(paneEl: unknown): unknown;
  destinationOfActiveView(): Dest | null;
  filesPanelDestination(): Dest | null;
  pasteDestination(): Dest | null;
}

/** The NAME half of a destination: what A9b showed, and what these tests read. */
export function destName(d: Dest | null): string | null {
  return d === null ? null : d.name;
}
export interface FileDropModule {
  initFileDrop(deps: Record<string, unknown>): void;
}
export interface MenuModule {
  isRowMenuOpen(): boolean;
  closeRowMenu(): void;
}
export interface ModelModule {
  COPY_NOTE: string;
  PASTE_NOTE: string;
  MENU_MARGIN: number;
  itemsFor(row: {
    dir: boolean;
    name: string;
    open: boolean;
    deletable?: boolean;
    renamable?: boolean;
    count?: number;
  }): { label: string }[];
  itemsForRoot(name: string): { label: string }[];
  menuPosition(
    at: { x: number; y: number },
    size: { w: number; h: number },
    vp: { w: number; h: number },
  ): { x: number; y: number };
}
export type ViewRoot = { kind: 'home' } | { kind: 'project'; id: string };
export interface ViewLike {
  id: string;
  root: ViewRoot | null;
  slots: unknown[];
  focused: number;
}

/** The drop layer, wired so the copy-files entry has a real path to follow. */
export const picked: ((files: { name: string; size?: number }[]) => void)[] = [];
export const offered: { dest: Dest; items: unknown[] }[] = [];
FD.initFileDrop({
  openDialog: (req: { dest: Dest; items: unknown[] }) => offered.push(req),
  listingFor: (dest: Dest) => F.listingFor(dest),
  destinationOfPane: (el: unknown) => F.destinationOfPane(el),
  destinationOfActiveView: () => F.destinationOfActiveView(),
  filesPanelDestination: () => F.filesPanelDestination(),
  pasteDestination: () => F.pasteDestination(),
  selectedFolder: () => F.selectedFolder(),
  openPicker: (cb: (files: { name: string; size?: number }[]) => void) => picked.push(cb),
  flash: () => {},
});

export const host = dom.doc.createElement('aside');
host.className = 'drawer files-panel';
dom.body.append(host);
export const panel = F.initFilesPanel(host, () => {}, fx.gateway);
export const root = host.children[0] as FakeElement;
st.subscribe(() => panel.render());

/** Everything else on screen a right-click must be left alone on. */
export const pane = dom.doc.createElement('div');
pane.className = 'pane';
export const term = dom.doc.createElement('div');
term.className = 'term-host';
pane.append(term);
export const strip = dom.doc.createElement('div');
strip.className = 'tabstrip';
export const status = dom.doc.createElement('div');
status.className = 'statusline';
dom.body.append(pane, strip, status);

/** A live session in a project — the panel's normal world, header `api`. */
export async function liveSession(): Promise<void> {
  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  focusSession('s1');
  st.state.leftPanel = 'files';
  panel.render();
  await settle();
  await openTree();
}

/**
 * Stand in the session's own tab, the way launching one does. Since part B2
 * (user decision 2026-09-16) the panel follows the FOCUSED pane and nothing
 * else: with the fixed `Home` tab active it shows HOME, however many sessions
 * are running in other tabs.
 */
export function focusSession(id: string): void {
  const v = st.state.views.find((x) =>
    x.slots.some((s) => (s as { kind: string; id?: string }).kind === 'session' && (s as { id: string }).id === id),
  );
  if (v !== undefined) st.state.activeViewId = v.id;
}

export const row = (path: string): FakeElement => byKey(root, `fdir:${PROJ}/${path}`) as FakeElement;
export const fileRow = (path: string): FakeElement => byKey(root, `ffile:${PROJ}/${path}`) as FakeElement;
export const menuEl = (): FakeElement | undefined => byClass(dom.body, 'cm-menu')[0];
export const items = (): FakeElement[] => byClass(dom.body, 'cm-item');
export const labels = (): string[] => textsOf(dom.body, 'cm-label');
/** Every row wearing the chosen-folder class, by `data-k`. */
export const selectedRows = (): string[] =>
  byClass(root, 'is-sel').map((n) => (n.getAttribute('data-k') ?? '').replace(`:${PROJ}/`, ':'));

/** Right-click a row, at a point. */
export function rightClick(el: FakeElement, x = 40, y = 120): ReturnType<typeof dispatch> {
  return dispatch(el, 'contextmenu', { clientX: x, clientY: y });
}

/**
 * The tree these tests expect: since part B2 nothing is open until somebody
 * opens it, and the panel's open set is instance state that outlives one test,
 * so it is restored the way a user would — one click per folder, each awaiting
 * its listing, and the selection those clicks made cleared afterwards.
 */
export const OPEN_AT_START = ['web', 'web/src', 'server'];
export async function openTree(): Promise<void> {
  for (const path of OPEN_AT_START) {
    const r = row(path);
    if (r !== null && r.getAttribute('aria-expanded') === 'false') {
      r.click();
      await settle();
    }
  }
  dispatch(root, 'keydown', { key: 'Escape' });
}

/**
 * The world every test starts from — each file's `beforeEach` calls it.
 * `extra` runs where a file resets its own counters (the Escape-ladder mirror
 * in `tests/ui/ui-context-menu-close.test.ts`), before the panel re-renders.
 */
export function resetWorld(extra?: () => void): void {
  CM.closeRowMenu();
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
  dom.win.innerWidth = 1600;
  dom.win.innerHeight = 900;
  menuSize = { w: 200, h: 96 };
  picked.length = 0;
  offered.length = 0;
  extra?.();
  dom.doc.activeElement = dom.body;
  fx.reset();
  panel.render();
  dispatch(root, 'keydown', { key: 'Escape' }); // clear whatever was chosen
}

/** Activate the entry with this label, by the keyboard, the way a user would. */
export function activate(label: string): void {
  const list = items();
  const i = list.findIndex((b) => textsOf(b, 'cm-label')[0] === label);
  assert.notEqual(i, -1, `no entry called ${label}`);
  for (let step = 0; step < i; step += 1) {
    dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: 'ArrowDown' });
  }
  dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: 'Enter' });
}

export const FILES_SRC = readSources(...FILES_PANEL_SOURCES);
