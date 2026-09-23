/**
 * Shared setup for `tests/ui/ui-files-create*.test.ts` (Nocturne part A9c,
 * `.claude/plans/nocturne/PLAN-B2.md` §6a and §6b): the fake `FsGateway` of
 * `tests/helpers/fs-fixture.ts` and the DOM double, then the REAL
 * `web/src/state.ts`, `ui/files.ts`, `ui/filedrop.ts` and `ui/context-menu.ts`;
 * the drop layer wired, a terminal pane on screen (the surface whose keyboard
 * the panel must never take), the Files panel, and the row, menu and
 * name-row helpers. Not a test.
 *
 * Each test file registers its own hooks: `beforeEach` awaits `resetWorld()`,
 * `afterEach` closes the row menu.
 */
import assert from 'node:assert/strict';
import type { Project, SessionInfo } from '../../shared/protocol.ts';
import { byClass, byKey, dispatch, installDom, textsOf, type FakeElement } from './fake-dom.ts';
import { PROJ, makeFixture, settle, type Gateway, mkSession, mkProject as project } from './fs-fixture.ts';
import { readSource } from './helpers.ts';

export const fx = makeFixture();
export const dom = installDom();

export const FILES_SRC = readSource('web', 'src', 'ui', 'files.ts');

export const st = (await import(new URL('../../web/src/state.ts', import.meta.url).href)) as StateModule;
export const F = (await import(new URL('../../web/src/ui/files.ts', import.meta.url).href)) as FilesModule;
export const FD = (await import(new URL('../../web/src/ui/filedrop.ts', import.meta.url).href)) as FileDropModule;
export const CM = (await import(new URL('../../web/src/ui/context-menu.ts', import.meta.url).href)) as MenuModule;

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
  slotTabIds(slot: unknown): string[];
}
export interface Dest {
  path: string;
  name: string;
}
export interface FilesModule {
  initFilesPanel(host: unknown, onLeaveScreen: () => void, fs: Gateway): { render(): void };
  selectedFolder(): Dest | null;
  pasteDestination(): Dest | null;
  destinationOfActiveView(): Dest | null;
  filesPanelDestination(): Dest | null;
  destinationOfPane(paneEl: unknown): unknown;
  listingFor(dest: Dest): Promise<readonly string[]>;
}
export interface FileDropModule {
  initFileDrop(deps: Record<string, unknown>): void;
}
export interface MenuModule {
  isRowMenuOpen(): boolean;
  closeRowMenu(): void;
}
export interface ViewLike {
  id: string;
  root: unknown;
  slots: unknown[];
  focused: number;
}

/** The drop layer, wired so `Copy files here…` has somewhere to go. */
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

/**
 * A terminal pane on screen — the surface whose keyboard this panel must never
 * take (A9c fix round, items 1 and 3). `.pane` + `.term-host` is the shape
 * `ui/panes.ts` builds and the one `ui/files.ts` recognises; the textarea is
 * xterm's own helper, the node that really holds the focus over a PTY.
 */
export const pane = dom.doc.createElement('div');
pane.className = 'pane';
export const termHost = dom.doc.createElement('div');
termHost.className = 'term-host';
export const termInput = dom.doc.createElement('textarea');
termHost.append(termInput);
pane.append(termHost);
dom.body.append(pane);

export const host = dom.doc.createElement('aside');
host.className = 'drawer files-panel';
dom.body.append(host);
export const panel = F.initFilesPanel(host, () => {}, fx.gateway);
export const root = host.children[0] as FakeElement;
st.subscribe(() => panel.render());

export function focusSession(id: string): void {
  const v = st.state.views.find((x) =>
    x.slots.some(
      (s) =>
        (s as { kind: string; id?: string }).kind === 'session' && (s as { id: string }).id === id,
    ),
  );
  if (v !== undefined) st.state.activeViewId = v.id;
}

export const dirRow = (rel: string): FakeElement => byKey(root, `fdir:${PROJ}/${rel}`) as FakeElement;
export const fileRow = (rel: string): FakeElement => byKey(root, `ffile:${PROJ}/${rel}`) as FakeElement;
export const rows = (): FakeElement[] => byClass(root, 'files-row');
export const newRow = (): FakeElement | undefined => byClass(root, 'is-new')[0];
export const errRow = (): FakeElement | undefined => byClass(root, 'is-newerr')[0];
export const nameField = (): FakeElement => byClass(root, 'files-newname')[0] as FakeElement;
export const menuEl = (): FakeElement | undefined => byClass(dom.body, 'cm-menu')[0];
export const items = (): FakeElement[] => byClass(dom.body, 'cm-item');
export const labels = (): string[] => textsOf(dom.body, 'cm-label');
export const background = (): FakeElement => byClass(root, 'files-body')[0] as FakeElement;

/** Right-click a row (or the background), at a point. */
export function rightClick(el: FakeElement): void {
  dispatch(el, 'contextmenu', { clientX: 40, clientY: 120 });
}

/** Walk the roving focus to an entry and press Enter on it — the keyboard path. */
export function activate(label: string): void {
  const list = items();
  const i = list.findIndex((b) => textsOf(b, 'cm-label')[0] === label);
  assert.notEqual(i, -1, `no entry called ${label}`);
  for (let step = 0; step < i; step += 1) {
    dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: 'ArrowDown' });
  }
  dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: 'Enter' });
}

/** Open the menu on a folder row (or the background) and choose one entry. */
export function choose(on: FakeElement, label: string): void {
  rightClick(on);
  activate(label);
}

/** Type into the name row the way a person does, then press Enter. */
export function type(text: string): void {
  nameField().value = text;
}
export function pressEnter(): ReturnType<typeof dispatch> {
  return dispatch(nameField(), 'keydown', { key: 'Enter' });
}
export function pressEscape(el: FakeElement): ReturnType<typeof dispatch> {
  return dispatch(el, 'keydown', { key: 'Escape' });
}

export const OPEN_AT_START = ['web', 'web/src', 'server'];

/** A live session in a project — the panel's normal world, header `api`. */
export async function liveSession(): Promise<void> {
  st.setProjects([project('p1', 'api'), project('p2', 'tools')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' }), mkSession('s2', { projectId: 'p2' })]);
  focusSession('s1');
  st.state.leftPanel = 'files';
  panel.render();
  await settle();
  for (const path of OPEN_AT_START) {
    const r = dirRow(path);
    if (r !== null && r.getAttribute('aria-expanded') === 'false') {
      r.click();
      await settle();
    }
  }
  pressEscape(root); // drop the selection those clicks made
  fx.createCalls.length = 0;
  fx.entryCalls.length = 0;
}

/**
 * The world every test starts from — each file's `beforeEach` awaits it.
 * `extra` runs where a file resets its own window-key recorders (the Escape
 * ladder mirror in `tests/ui/ui-files-create-cancel.test.ts`).
 */
export async function resetWorld(extra?: () => void): Promise<void> {
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
  extra?.();
  dom.doc.activeElement = dom.body;
  fx.reset();
  panel.render();
  pressEscape(root);
  await settle();
}
