/**
 * The row context menu (Nocturne part A9b, brief 2) — the REAL
 * `web/src/ui/context-menu.ts` and the REAL `web/src/ui/files.ts` that opens
 * it, driven on the DOM double in `tests/fake-dom.ts`.
 *
 * WHY THIS FILE EXISTS. The menu's decisions are pinned DOM-free next door
 * (`tests/ui-context-menu-model.test.ts`: which entries, what they are called,
 * where the box goes, where the arrows go). What lives here is everything that
 * can only be wrong in a browser, and every one of those ways is silent:
 *
 *   1. a `contextmenu` listener that acts one node too wide takes the SYSTEM
 *      menu away from a terminal — xterm's own `contextmenu` handler puts the
 *      selection in its helper textarea so the system Copy/Paste act on it, and
 *      an app that called `preventDefault()` there would break copying out of a
 *      session with no error anywhere;
 *   2. a menu that is not removed on close, or whose window/document listeners
 *      outlive it, leaves a stale Escape handler swallowing the key for a menu
 *      nobody can see, and grows one leak per right-click;
 *   3. a menu anchored to a row the panel then rebuilds points at the wrong
 *      folder while still naming the right one;
 *   4. an Escape that does not stop propagating closes the whole Files panel
 *      behind the menu (`main.ts`'s ladder), and one that stops it always makes
 *      the panel unclosable;
 *   5. a disabled entry rendered with the `disabled` attribute cannot be
 *      reached by the arrows at all — and the one-line explanation under its
 *      label is the entire reason it is on the menu (user decision 3);
 *   6. geometry: the fake DOM measures nothing, so a module that positioned
 *      itself by reading the document could not be tested — `menuPosition()`
 *      has to be what the DOM really applies.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`): that
 * the card is legible, that it changes no layout, that a real `<button>`
 * activates on Enter/Space (the fake DOM activates nothing — the module's own
 * handler is the single path and is asserted instead), that a right-click
 * inside a terminal really reaches xterm, and screen-reader output.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project, SessionInfo } from '../shared/protocol.ts';
import {
  byClass,
  byKey,
  descendants,
  dispatch,
  installDom,
  setRect,
  textsOf,
  FakeElement,
  type FakeNode,
} from './fake-dom.ts';
import { PROJ, makeFixture, settle, type Gateway } from './fs-fixture.ts';

/** The real panel against the fake backend of part B2 (`tests/fs-fixture.ts`). */
const fx = makeFixture();
import { APP_CSS, declaredTokens, frontendFiles, stripComments, usedTokens } from './tokens-helpers.ts';

const dom = installDom();

/**
 * THE ONE SEAM THIS FILE NEEDS. `ui/context-menu.ts` measures the card once
 * after appending it to the body, and the fake DOM answers only the rect a
 * test set — so the test sets it at the moment the module appends, which is
 * the single instant between creation and measurement. No change to
 * `tests/fake-dom.ts` was needed for it: `body.append` is an ordinary method.
 */
let menuSize = { w: 200, h: 96 };
const realAppend = dom.body.append.bind(dom.body);
(dom.body as unknown as { append(...n: (FakeNode | string)[]): void }).append = (...nodes) => {
  realAppend(...nodes);
  for (const n of nodes) {
    if (n instanceof FakeElement && n.classList.contains('cm-menu')) {
      setRect(n, { left: 0, top: 0, width: menuSize.w, height: menuSize.h });
    }
  }
};

const here = dirname(fileURLToPath(import.meta.url));
const st = (await import(new URL('../web/src/state.ts', import.meta.url).href)) as StateModule;
const F = (await import(new URL('../web/src/ui/files.ts', import.meta.url).href)) as FilesModule;
const FD = (await import(new URL('../web/src/ui/filedrop.ts', import.meta.url).href)) as FileDropModule;
const CM = (await import(new URL('../web/src/ui/context-menu.ts', import.meta.url).href)) as MenuModule;
const M = (await import(
  new URL('../web/src/ui/context-menu-model.ts', import.meta.url).href
)) as ModelModule;

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
  activeView(): ViewLike | null;
  openFile(root: ViewRoot, path: string, label: string): string;
  filesPanelVisible(): boolean;
  slotTabIds(slot: unknown): string[];
}
interface Dest {
  path: string;
  name: string;
}
interface FilesModule {
  initFilesPanel(host: unknown, onLeaveScreen: () => void, fs: Gateway): { render(): void };
  selectedFolder(): Dest | null;
  listingFor(dest: Dest): Promise<readonly string[]>;
  destinationOfPane(paneEl: unknown): unknown;
  destinationOfActiveView(): Dest | null;
  filesPanelDestination(): Dest | null;
  pasteDestination(): Dest | null;
}

/** The NAME half of a destination: what A9b showed, and what these tests read. */
function destName(d: Dest | null): string | null {
  return d === null ? null : d.name;
}
interface FileDropModule {
  initFileDrop(deps: Record<string, unknown>): void;
}
interface MenuModule {
  isRowMenuOpen(): boolean;
  closeRowMenu(): void;
}
interface ModelModule {
  COPY_NOTE: string;
  PASTE_NOTE: string;
  MENU_MARGIN: number;
  itemsFor(row: { dir: boolean; name: string; open: boolean }): { label: string }[];
  menuPosition(
    at: { x: number; y: number },
    size: { w: number; h: number },
    vp: { w: number; h: number },
  ): { x: number; y: number };
}
type ViewRoot = { kind: 'home' } | { kind: 'project'; id: string };
interface ViewLike {
  id: string;
  root: ViewRoot | null;
  slots: unknown[];
  focused: number;
}

/** The drop layer, wired so the copy-files entry has a real path to follow. */
const picked: ((files: { name: string; size?: number }[]) => void)[] = [];
const offered: { dest: Dest; items: unknown[] }[] = [];
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

const host = dom.doc.createElement('aside');
host.className = 'drawer files-panel';
dom.body.append(host);
const panel = F.initFilesPanel(host, () => {}, fx.gateway);
const root = host.children[0] as FakeElement;
st.subscribe(() => panel.render());

/** Everything else on screen a right-click must be left alone on. */
const pane = dom.doc.createElement('div');
pane.className = 'pane';
const term = dom.doc.createElement('div');
term.className = 'term-host';
pane.append(term);
const strip = dom.doc.createElement('div');
strip.className = 'tabstrip';
const status = dom.doc.createElement('div');
status.className = 'statusline';
dom.body.append(pane, strip, status);

/**
 * `main.ts`'s Escape ladder, mirrored (the same mirror
 * `tests/ui-files-select.test.ts` uses, and pinned against the real source
 * there): brief 2 may not touch that ladder, so this is how "the menu's own
 * Escape never reaches it" is checked without importing main.ts.
 */
let ladderSaw = 0;
dom.win.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  ladderSaw += 1;
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
  return { id, name, path: `/work/${name}`, createdAt: new Date().toISOString() } as Project;
}

/** A live session in a project — the panel's normal world, header `api`. */
async function liveSession(): Promise<void> {
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
function focusSession(id: string): void {
  const v = st.state.views.find((x) =>
    x.slots.some((s) => (s as { kind: string; id?: string }).kind === 'session' && (s as { id: string }).id === id),
  );
  if (v !== undefined) st.state.activeViewId = v.id;
}

const row = (path: string): FakeElement => byKey(root, `fdir:${PROJ}/${path}`) as FakeElement;
const fileRow = (path: string): FakeElement => byKey(root, `ffile:${PROJ}/${path}`) as FakeElement;
const menuEl = (): FakeElement | undefined => byClass(dom.body, 'cm-menu')[0];
const items = (): FakeElement[] => byClass(dom.body, 'cm-item');
const labels = (): string[] => textsOf(dom.body, 'cm-label');
/** Every row wearing the chosen-folder class, by `data-k`. */
const selectedRows = (): string[] =>
  byClass(root, 'is-sel').map((n) => (n.getAttribute('data-k') ?? '').replace(`:${PROJ}/`, ':'));

/** Right-click a row, at a point. */
function rightClick(el: FakeElement, x = 40, y = 120): ReturnType<typeof dispatch> {
  return dispatch(el, 'contextmenu', { clientX: x, clientY: y });
}

/**
 * The tree these tests expect: since part B2 nothing is open until somebody
 * opens it, and the panel's open set is instance state that outlives one test,
 * so it is restored the way a user would — one click per folder, each awaiting
 * its listing, and the selection those clicks made cleared afterwards.
 */
const OPEN_AT_START = ['web', 'web/src', 'server'];
async function openTree(): Promise<void> {
  for (const path of OPEN_AT_START) {
    const r = row(path);
    if (r !== null && r.getAttribute('aria-expanded') === 'false') {
      r.click();
      await settle();
    }
  }
  dispatch(root, 'keydown', { key: 'Escape' });
}

beforeEach(() => {
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
  ladderSaw = 0;
  dom.doc.activeElement = dom.body;
  fx.reset();
  panel.render();
  dispatch(root, 'keydown', { key: 'Escape' }); // clear whatever was chosen
});

afterEach(() => {
  CM.closeRowMenu();
});

// ---------------------------------------------------------------------------
// Where it opens, and where it must not
// ---------------------------------------------------------------------------

test('a right-click on a FOLDER row opens the menu with that folder s entries', async () => {
  await liveSession();
  assert.ok(row('web') !== null, 'non-vacuity: the mock tree has a `web` folder row');
  const e = rightClick(row('web'));
  assert.equal(e.defaultPrevented, true, 'the system menu must not open over ours');
  const box = menuEl() as FakeElement;
  assert.ok(box !== undefined, 'a menu');
  assert.equal(CM.isRowMenuOpen(), true);
  assert.equal(box.getAttribute('role'), 'menu');
  assert.equal(box.getAttribute('aria-label'), 'actions for web', 'a NAME, never a path');
  assert.deepEqual(
    labels(),
    M.itemsFor({ dir: true, name: 'web', open: true }).map((i) => i.label),
    'the entries are the model s, in its order',
  );
  for (const it of items()) assert.equal(it.getAttribute('role'), 'menuitem');
});

test('a right-click on the folder MARK inside the row opens it too (an SVG is not an HTMLElement)', async () => {
  // MEASURED in a real browser (headless Edge, 2026-09-16, part A9b brief 2):
  // the delegated listener narrowed its target with `instanceof HTMLElement`,
  // and an `SVGElement` is not one — so a right-click landing on the folder
  // mark, a third of the row's height, opened NOTHING and was not even
  // prevented. Since the gate of 2026-09-16 the double tells the same truth —
  // `tests/fake-dom.ts` marks everything `createElementNS` makes and answers
  // `false` for `instanceof HTMLElement` — so the behaviour below fails on its
  // own, and the source guard is pinned beside it.
  await liveSession();
  const mark = byClass(row('web'), 'files-folder')[0] as FakeElement;
  assert.ok(mark !== undefined, 'non-vacuity: the row really carries a folder mark');
  const e = dispatch(mark, 'contextmenu', { clientX: 20, clientY: 120 });
  assert.equal(e.defaultPrevented, true);
  assert.equal(menuEl()?.getAttribute('aria-label'), 'actions for web');
  assert.match(
    FILES_SRC,
    /e\.target instanceof Element \? e\.target : null/,
    'the guard must admit every Element, not only HTML ones',
  );
});

test('a right-click on a FILE row opens the file entries', async () => {
  await liveSession();
  rightClick(fileRow('README.md'));
  assert.equal(menuEl()?.getAttribute('aria-label'), 'actions for README.md');
  assert.deepEqual(
    labels(),
    M.itemsFor({ dir: false, name: 'README.md', open: false }).map((i) => i.label),
  );
});

test('every row says it opens a menu: aria-haspopup on folder AND file rows', async () => {
  // The house rule, 7 for 7 before this one (main.ts, projects.ts, github.ts,
  // settings.ts twice, statusline.ts, update.ts): a control that opens a popup
  // advertises it. A row opens `role="menu"`, so the value is `menu`.
  await liveSession();
  const rows = byClass(root, 'files-row');
  assert.ok(rows.length >= 4, `non-vacuity: ${rows.length} rows`);
  assert.ok(rows.some((r) => r.classList.contains('is-dir')), 'non-vacuity: folder rows');
  assert.ok(rows.some((r) => r.classList.contains('is-file')), 'non-vacuity: file rows');
  for (const r of rows) {
    assert.equal(
      r.getAttribute('aria-haspopup'),
      'menu',
      `${r.getAttribute('data-k')} opens a menu without saying so`,
    );
  }
});

test('a right-click ANYWHERE else is not even prevented — the system menu opens as it does today', async () => {
  await liveSession();
  const elsewhere: [string, FakeElement][] = [
    ['the panel background', byClass(root, 'files-copy')[0] as FakeElement],
    ['the tree body', byClass(root, 'files-body')[0] as FakeElement],
    ['the panel root', root],
    ['a pane', pane],
    ['a terminal', term],
    ['the tab strip', strip],
    ['the statusline', status],
  ];
  for (const [what, el] of elsewhere) {
    assert.ok(el !== undefined, `non-vacuity: ${what} is on screen`);
    const e = dispatch(el, 'contextmenu', { clientX: 10, clientY: 10 });
    assert.equal(e.defaultPrevented, false, `the app took the right-click on ${what}`);
    assert.equal(menuEl(), undefined, `a menu opened on ${what}`);
  }
});

test('the copy strip is not a row either: a right-click on it opens nothing', async () => {
  await liveSession();
  const e = dispatch(byKey(root, 'fcopy') as FakeElement, 'contextmenu', {});
  assert.equal(e.defaultPrevented, false);
  assert.equal(menuEl(), undefined);
});

// ---------------------------------------------------------------------------
// What a right-click does to the selection
// ---------------------------------------------------------------------------

test('a right-click on a folder row SELECTS it and does NOT toggle it', async () => {
  await liveSession();
  assert.equal(row('web').getAttribute('aria-expanded'), 'true', 'non-vacuity: `web` starts open');
  rightClick(row('web'));
  assert.deepEqual(selectedRows(), ['fdir:web'], 'Explorer s behaviour: the row is chosen');
  assert.equal(destName(F.selectedFolder()), 'web');
  assert.equal(
    row('web').getAttribute('aria-expanded'),
    'true',
    'the toggle belongs to the primary click; the menu names it instead',
  );
});

test('a right-click on a FILE row selects nothing, and leaves the chosen folder alone', async () => {
  await liveSession();
  row('server').click();
  assert.deepEqual(selectedRows(), ['fdir:server'], 'non-vacuity: something is chosen');
  CM.closeRowMenu();
  rightClick(fileRow('README.md'));
  assert.deepEqual(selectedRows(), ['fdir:server'], 'right-clicking a file is not a way to lose it');
});

test('the selection a right-click makes is PAINTED — the repaint really happens', async () => {
  // The gesture changes the selection and NOTHING else, so only `sig()`
  // reading the selection makes the row repaint (pinned as source in
  // tests/ui-files-select.test.ts; this is the behaviour behind it).
  await liveSession();
  rightClick(row('web/src'));
  assert.deepEqual(selectedRows(), ['fdir:web/src']);
  assert.equal(row('web/src').getAttribute('aria-current'), 'true');
});

test('the menu is anchored to the row the repaint LEFT behind, so Escape can hand the keyboard back', async () => {
  await liveSession();
  rightClick(row('web'));
  const fresh = row('web');
  assert.equal(fresh.isConnected, true, 'non-vacuity: the row survived the repaint');
  dispatch(items()[0] as FakeElement, 'keydown', { key: 'Escape' });
  assert.equal(dom.doc.activeElement, fresh, 'the keyboard goes back to the row that is on screen');
});

// ---------------------------------------------------------------------------
// The keyboard twin
// ---------------------------------------------------------------------------

test('the ContextMenu key and shift+F10 on a focused row open the menu — and nothing else does', async () => {
  await liveSession();
  for (const init of [{ key: 'ContextMenu' }, { key: 'F10', shiftKey: true }]) {
    const r = row('web');
    r.focus();
    const e = dispatch(r, 'keydown', init);
    assert.equal(e.defaultPrevented, true, `${init.key} must be owned by the row`);
    assert.equal(e.cancelBubble, true, 'and spent there, so no window handler sees it');
    assert.ok(menuEl() !== undefined, `${init.key} opened nothing`);
    assert.equal(menuEl()?.getAttribute('aria-label'), 'actions for web');
    CM.closeRowMenu();
  }
});

test('plain F10, the ctrl variants and AltGr leave the row alone', async () => {
  await liveSession();
  const noes: Record<string, unknown>[] = [
    { key: 'F10' },
    { key: 'F10', shiftKey: true, ctrlKey: true },
    { key: 'F10', shiftKey: true, altKey: true },
    { key: 'F10', shiftKey: true, ctrlKey: true, altKey: true, altGraph: true },
    { key: 'ContextMenu', ctrlKey: true },
    { key: 'ContextMenu', altKey: true, ctrlKey: true, altGraph: true },
  ];
  for (const init of noes) {
    const r = row('web');
    r.focus();
    const e = dispatch(r, 'keydown', init);
    assert.equal(e.defaultPrevented, false, `the row took ${JSON.stringify(init)}`);
    assert.equal(menuEl(), undefined, `a menu opened on ${JSON.stringify(init)}`);
  }
});

test('the keyboard opens it at the row s leading edge and bottom', async () => {
  await liveSession();
  const r = row('server');
  setRect(r, { left: 12, top: 300, width: 260, height: 26 });
  r.focus();
  dispatch(r, 'keydown', { key: 'ContextMenu' });
  const want = M.menuPosition({ x: 12, y: 326 }, menuSize, { w: 1600, h: 900 });
  assert.equal(menuEl()?.style.left, `${want.x}px`);
  assert.equal(menuEl()?.style.top, `${want.y}px`);
});

test('the browser s OWN contextmenu after the chord is swallowed by the menu itself', async () => {
  // Windows sends WM_CONTEXTMENU off the APPS key even when the keydown was
  // prevented, and by then the keyboard is on the first entry — so the event's
  // target is INSIDE the card, which lives on `document.body`, where
  // `ui/files.ts`'s delegated listener on the PANEL ROOT can never see it:
  // `closest('.files-row')` would be null, the listener would return without
  // preventing anything, and the SYSTEM menu would open on top of ours. The
  // menu's own listener is therefore where the guard lives.
  await liveSession();
  const r = row('web');
  r.focus();
  dispatch(r, 'keydown', { key: 'ContextMenu' });
  const first = items()[0] as FakeElement;
  assert.ok(first !== undefined, 'non-vacuity: a menu with entries is up');
  assert.equal(dom.doc.activeElement, first, 'non-vacuity: the keyboard is inside the menu');
  const e = dispatch(first, 'contextmenu', { clientX: 40, clientY: 140 });
  assert.equal(e.defaultPrevented, true, 'the system menu would have opened over ours');
  assert.equal(byClass(dom.body, 'cm-menu').length, 1, 'and nothing was reopened');
  assert.equal(menuEl()?.getAttribute('aria-label'), 'actions for web', 'the same menu');

  // A contextmenu on a ROW while the menu is open still replaces it.
  const e2 = rightClick(row('server'));
  assert.equal(e2.defaultPrevented, true);
  assert.equal(byClass(dom.body, 'cm-menu').length, 1);
  assert.equal(menuEl()?.getAttribute('aria-label'), 'actions for server');
});

test('a FILE row answers the chord too', async () => {
  await liveSession();
  const r = fileRow('web/src/Pane.tsx');
  r.focus();
  dispatch(r, 'keydown', { key: 'ContextMenu' });
  assert.equal(menuEl()?.getAttribute('aria-label'), 'actions for Pane.tsx');
});

// ---------------------------------------------------------------------------
// Roving focus
// ---------------------------------------------------------------------------

test('the first entry holds the keyboard on open, and it is the only tab stop', async () => {
  await liveSession();
  rightClick(row('web'));
  const list = items();
  assert.ok(list.length >= 3, `non-vacuity: ${list.length} entries`);
  assert.equal(dom.doc.activeElement, list[0]);
  assert.deepEqual(
    list.map((b) => b.tabIndex),
    [0, ...list.slice(1).map(() => -1)],
    'one tab stop: the arrows move inside the menu, Tab leaves it',
  );
});

test('the arrows wrap in both directions, Home and End jump, disabled entries included', async () => {
  await liveSession();
  rightClick(row('web'));
  const list = items();
  const n = list.length;
  const at = (): number => list.findIndex((b) => b === dom.doc.activeElement);
  const key = (k: string): void => {
    dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: k });
  };
  assert.equal(at(), 0);
  key('ArrowDown');
  assert.equal(at(), 1, 'and the second entry is a DISABLED one — the arrows reach it');
  assert.equal(list[1]?.getAttribute('aria-disabled'), 'true');
  key('ArrowUp');
  assert.equal(at(), 0);
  key('ArrowUp');
  assert.equal(at(), n - 1, 'up off the first wraps to the last');
  key('ArrowDown');
  assert.equal(at(), 0, 'down off the last wraps to the first');
  key('End');
  assert.equal(at(), n - 1);
  key('Home');
  assert.equal(at(), 0);
  // The roving tabindex follows the keyboard, or Tab would re-enter at the top.
  key('End');
  assert.deepEqual(
    list.map((b) => b.tabIndex),
    [...list.slice(0, n - 1).map(() => -1), 0],
  );
});

test('an arrow inside the menu is spent there — nothing behind it reads it', async () => {
  await liveSession();
  rightClick(row('web'));
  const e = dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: 'ArrowDown' });
  assert.equal(e.defaultPrevented, true);
  assert.equal(e.cancelBubble, true);
});

// ---------------------------------------------------------------------------
// What the entries do
// ---------------------------------------------------------------------------

/** Activate the entry with this label, by the keyboard, the way a user would. */
function activate(label: string): void {
  const list = items();
  const i = list.findIndex((b) => textsOf(b, 'cm-label')[0] === label);
  assert.notEqual(i, -1, `no entry called ${label}`);
  for (let step = 0; step < i; step += 1) {
    dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: 'ArrowDown' });
  }
  dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: 'Enter' });
}

test('Close on an open folder closes it — the same toggle the primary click performs', async () => {
  await liveSession();
  rightClick(row('web'));
  assert.deepEqual(labels()[0], 'Close', 'non-vacuity: the folder is open, so the entry says Close');
  activate('Close');
  assert.equal(menuEl(), undefined, 'a choice closes the menu');
  assert.equal(row('web').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(selectedRows(), ['fdir:web'], 'and the folder stays the chosen one');

  rightClick(row('web'));
  assert.deepEqual(labels()[0], 'Open', 'a closed folder offers the other half of the same toggle');
  activate('Open');
  assert.equal(row('web').getAttribute('aria-expanded'), 'true');
});

test('Open on a file row opens it as a tab of its root folder s tab', async () => {
  await liveSession();
  rightClick(fileRow('web/src/store.ts'));
  activate('Open');
  const v = st.activeView() as ViewLike;
  assert.deepEqual(
    v.slots.map((s) => st.slotTabIds(s)),
    [[`f:${PROJ}/web/src/store.ts`]],
    'one editor pane, holding that file at its ABSOLUTE path (part B2)',
  );
});

test('Open beside splits the focused pane — the menu s half of ctrl+alt+enter', async () => {
  await liveSession();
  fileRow('web/src/store.ts').click();
  assert.equal((st.activeView() as ViewLike).slots.length, 1, 'non-vacuity: one pane to split');
  rightClick(fileRow('web/src/Pane.tsx'));
  activate('Open beside');
  assert.equal((st.activeView() as ViewLike).slots.length, 2, 'the file took a split beside it');
});

test('Copy files here… opens the chooser for THAT folder, not for the panel s root', async () => {
  await liveSession();
  assert.equal(destName(F.pasteDestination()), 'api', 'non-vacuity: the panel s own root is `api`');
  rightClick(row('web/src'));
  activate('Copy files here…');
  assert.equal(picked.length, 1, 'the native chooser, once');
  (picked[0] as (f: { name: string }[]) => void)([{ name: 'a.txt' }]);
  // One listing later: since part B2 the conflict question is asked against
  // the REAL folder before the dialog opens.
  await settle();
  assert.equal(offered.length, 1);
  assert.deepEqual(
    offered[0]?.dest,
    { path: `${PROJ}/web/src`, name: 'src' },
    'the row s own folder: the NAME it shows, the PATH part B10 posts to',
  );
});

test('a DISABLED entry is aria-disabled, carries its sentence, and does nothing at all', async () => {
  await liveSession();
  rightClick(row('web'));
  const list = items();
  const off = list.filter((b) => b.getAttribute('aria-disabled') === 'true');
  assert.equal(off.length, 2, 'Copy and Paste, until part B10');
  for (const b of off) {
    assert.equal(b.disabled, false, 'never the `disabled` attribute: the arrows must reach it');
    assert.equal(b.hasAttribute('disabled'), false);
    assert.equal(byClass(b, 'cm-sub').length, 1, 'the sentence is the reason it is on the menu');
  }
  const notes = textsOf(dom.body, 'cm-sub');
  assert.deepEqual(notes, [M.COPY_NOTE, M.PASTE_NOTE], 'verbatim from the model');

  // Activating one does NOTHING and the menu STAYS OPEN — the note is the
  // answer, and taking the menu away would hide it.
  const before = st.state.views.length;
  activate('Copy');
  assert.ok(menuEl() !== undefined, 'the menu stays up');
  assert.equal(picked.length, 0);
  assert.equal(offered.length, 0);
  assert.equal(st.state.views.length, before);
  assert.equal(row('web').getAttribute('aria-expanded'), 'true', 'and nothing toggled');
});

test('Enter and Space are spent on the menu: prevented, and never read behind it', async () => {
  // A `<button>`'s own activation IS the default action of these keys (Enter on
  // keydown, Space on keyup), so without `preventDefault()` a real browser
  // activates the entry a SECOND time — one keystroke, two actions — and
  // without `stopPropagation()` a window handler behind the menu reads a key
  // the menu already spent. The fake DOM activates nothing by itself, which is
  // why both are asserted on the event and not on the effect. MEASURED (gate,
  // 2026-09-16): dropping both lines left the whole suite green.
  await liveSession();
  rightClick(row('web'));
  const e = dispatch(items()[0] as FakeElement, 'keydown', { key: 'Enter' });
  assert.equal(e.defaultPrevented, true, 'a browser would activate the entry twice');
  assert.equal(e.cancelBubble, true);

  // The same for Space, and on a DISABLED entry — which does nothing at all,
  // but must not hand the key on to anything behind it either.
  rightClick(row('web'));
  dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: 'ArrowDown' });
  const off = dom.doc.activeElement as FakeElement;
  assert.equal(off.getAttribute('aria-disabled'), 'true', 'non-vacuity: a disabled entry');
  const d = dispatch(off, 'keydown', { key: ' ' });
  assert.equal(d.defaultPrevented, true, 'Space would scroll the page behind the menu');
  assert.equal(d.cancelBubble, true);
  assert.ok(menuEl() !== undefined, 'and the menu is still up');
});

test('every word the menu renders is plain: no path, no key name, no product name', async () => {
  await liveSession();
  rightClick(row('web/src'));
  const said = [...labels(), ...textsOf(dom.body, 'cm-sub'), menuEl()?.getAttribute('aria-label') ?? ''];
  assert.ok(said.length >= 5, `non-vacuity: ${said.length} strings`);
  for (const s of said) {
    assert.equal(/[/\\]/.test(s), false, `a path reached the menu: ${s}`);
    assert.equal(/ctrl\+|shift\+|\balt\b|F10/i.test(s), false, `a key name reached the menu: ${s}`);
    assert.equal(/claude|explorer|windows|xterm/i.test(s), false, `a product name: ${s}`);
  }
});

// ---------------------------------------------------------------------------
// Everything that closes it
// ---------------------------------------------------------------------------

test('Escape closes it, returns the keyboard to the row, and never reaches main.ts s ladder', async () => {
  await liveSession();
  row('web').focus();
  dispatch(row('web'), 'keydown', { key: 'ContextMenu' });
  ladderSaw = 0;
  const e = dispatch(items()[0] as FakeElement, 'keydown', { key: 'Escape' });
  assert.equal(e.defaultPrevented, true);
  assert.equal(e.cancelBubble, true, 'the key is spent on the menu');
  assert.equal(ladderSaw, 0, 'the panel behind the menu must not close under the user');
  assert.equal(menuEl(), undefined);
  assert.equal(dom.doc.activeElement, row('web'));
  assert.equal(st.state.leftPanel, 'files', 'the panel is still there');
});

test('a press outside closes it; a press inside does not', async () => {
  await liveSession();
  rightClick(row('web'));
  dispatch(items()[0] as FakeElement, 'pointerdown', {});
  assert.ok(menuEl() !== undefined, 'a press on the menu is not a press outside it');
  const e = dispatch(pane, 'pointerdown', {});
  assert.equal(menuEl(), undefined);
  assert.equal(e.defaultPrevented, false, 'and the press still does whatever it does');
});

test('the keyboard moving anywhere else closes it', async () => {
  await liveSession();
  rightClick(row('web'));
  const outside = dom.doc.createElement('button');
  dom.body.append(outside);
  outside.focus();
  assert.equal(menuEl(), undefined);
  outside.remove();
});

test('a scroll, a window resize and the window losing focus each close it', async () => {
  await liveSession();
  for (const type of ['scroll', 'resize', 'blur']) {
    rightClick(row('web'));
    assert.ok(menuEl() !== undefined, `non-vacuity: open before ${type}`);
    dispatch(byClass(root, 'files-body')[0] as FakeElement, type, {});
    assert.equal(menuEl(), undefined, `${type} left the menu standing`);
  }
});

test('a rebuild of the panel closes it — the row it points at is about to be replaced', async () => {
  await liveSession();
  rightClick(row('web'));
  assert.ok(menuEl() !== undefined, 'non-vacuity');
  // A file opening somewhere is a rebuild of every row (it is part of `sig()`)
  // and touches neither the root nor the selection — which is exactly the pair
  // this test is about.
  st.openFile({ kind: 'project', id: 'p1' }, `${PROJ}/README.md`, 'README.md');
  panel.render();
  assert.equal(menuEl(), undefined);
  assert.deepEqual(selectedRows(), ['fdir:web'], 'the SELECTION survives the rebuild; the menu never does');
});

test('opening a second menu leaves exactly one on screen', async () => {
  await liveSession();
  rightClick(row('web'));
  rightClick(row('server'));
  assert.equal(byClass(dom.body, 'cm-menu').length, 1);
  assert.equal(menuEl()?.getAttribute('aria-label'), 'actions for server');
});

test('a second right-click on the SAME row replaces the menu — the primitive does that, not rebuild()', async () => {
  // The test above right-clicks a DIFFERENT row, which changes the selection,
  // repaints the tree and closes the menu through `rebuild()` -> `closeRowMenu()`
  // BEFORE the second one opens. MEASURED (gate, 2026-09-16): deleting the
  // `closeRowMenu()` at the top of `openRowMenu()` left the whole suite green,
  // because that rebuild was quietly doing the primitive's job. A second
  // right-click on the row that is ALREADY chosen changes nothing and rebuilds
  // nothing, so only the primitive can answer.
  await liveSession();
  rightClick(row('web'));
  const winOne = dom.win.handlers.length;
  const docOne = dom.doc.handlers.length;
  assert.equal(byClass(dom.body, 'cm-menu').length, 1, 'non-vacuity: one menu is up');
  assert.deepEqual(selectedRows(), ['fdir:web'], 'non-vacuity: the row is already the chosen one');
  rightClick(row('web'), 300, 400);
  assert.equal(byClass(dom.body, 'cm-menu').length, 1, 'a stale card was left on screen');
  assert.equal(dom.win.handlers.length, winOne, 'the first menu s window listeners outlived it');
  assert.equal(dom.doc.handlers.length, docOne, 'the first menu s document listeners outlived it');
  assert.equal(menuEl()?.style.left, '300px', 'and the one on screen is the new one');
  assert.equal(dom.doc.activeElement, items()[0], 'which holds the keyboard');
});

test('every listener goes with the menu: no leak, no stale Escape', async () => {
  await liveSession();
  const win = () => dom.win.handlers.length;
  const doc = () => dom.doc.handlers.length;
  const baseWin = win();
  const baseDoc = doc();
  rightClick(row('web'));
  assert.ok(win() > baseWin && doc() > baseDoc, 'non-vacuity: the menu really registers listeners');
  CM.closeRowMenu();
  assert.equal(win(), baseWin, 'a window listener outlived the menu');
  assert.equal(doc(), baseDoc, 'a document listener outlived the menu');

  // And a closed menu takes no keys: Escape reaches the window again. Pressed
  // OUTSIDE the panel, because the panel's own Escape (the selection this very
  // right-click made) would legitimately stop it first — the key under test
  // here is the menu's stale capture listener, nothing else.
  ladderSaw = 0;
  dispatch(pane, 'keydown', { key: 'Escape' });
  assert.equal(ladderSaw, 1, 'a stale capture listener would have swallowed it');

  // Ten gestures later the counts are still the baseline.
  for (let i = 0; i < 10; i += 1) {
    rightClick(row('web'));
    CM.closeRowMenu();
  }
  assert.equal(win(), baseWin);
  assert.equal(doc(), baseDoc);
  assert.equal(byClass(dom.body, 'cm-menu').length, 0, 'and no card was left behind');
});

test('hiding the panel takes the menu with it', async () => {
  // `render()`'s hidden branch returns BEFORE `rebuild()`, which is the only
  // other place that closes the menu — so without a close of its own the card
  // would float over a panel that is no longer on screen.
  await liveSession();
  const baseWin = dom.win.handlers.length;
  const baseDoc = dom.doc.handlers.length;
  rightClick(row('web'));
  assert.equal(byClass(dom.body, 'cm-menu').length, 1, 'non-vacuity: a menu is up');
  assert.ok(dom.win.handlers.length > baseWin, 'non-vacuity: it registered window listeners');
  // The Projects drawer borrowing the left column: `filesPanelVisible()` is the
  // one seam both ways of hiding the panel go through.
  st.state.drawer = 'projects';
  panel.render();
  assert.equal(st.filesPanelVisible(), false, 'non-vacuity: the panel really is off screen');
  assert.equal(byClass(dom.body, 'cm-menu').length, 0, 'the card outlived its panel');
  assert.equal(CM.isRowMenuOpen(), false);
  assert.equal(dom.win.handlers.length, baseWin, 'and its window listeners went with it');
  assert.equal(dom.doc.handlers.length, baseDoc, 'and its document listeners too');
  st.state.drawer = null;
  panel.render();
});

// ---------------------------------------------------------------------------
// Geometry: menuPosition is what the DOM applies
// ---------------------------------------------------------------------------

test('the point the DOM applies is menuPosition s, flipped and clamped at the far corner', async () => {
  await liveSession();
  dom.win.innerWidth = 1600;
  dom.win.innerHeight = 900;
  rightClick(row('web'), 1500, 850);
  const want = M.menuPosition({ x: 1500, y: 850 }, menuSize, { w: 1600, h: 900 });
  assert.deepEqual(want, { x: 1300, y: 754 }, 'non-vacuity: this point really flips both ways');
  assert.equal(menuEl()?.style.left, '1300px');
  assert.equal(menuEl()?.style.top, '754px');
});

test('a point with room takes it unchanged, and a tiny viewport clamps to the margin', async () => {
  await liveSession();
  rightClick(row('web'), 120, 200);
  assert.equal(menuEl()?.style.left, '120px');
  assert.equal(menuEl()?.style.top, '200px');
  CM.closeRowMenu();

  // A viewport smaller than the menu: it sits at the inset and is CLIPPED by
  // the window, which is visible, rather than placed at a negative coordinate.
  dom.win.innerWidth = 120;
  dom.win.innerHeight = 80;
  rightClick(row('web'), 100, 70);
  assert.equal(menuEl()?.style.left, `${M.MENU_MARGIN}px`);
  assert.equal(menuEl()?.style.top, `${M.MENU_MARGIN}px`);
});

test('the module reads the viewport from the window, not from a constant', async () => {
  await liveSession();
  dom.win.innerWidth = 700;
  dom.win.innerHeight = 500;
  rightClick(row('web'), 600, 450);
  const want = M.menuPosition({ x: 600, y: 450 }, menuSize, { w: 700, h: 500 });
  assert.equal(menuEl()?.style.left, `${want.x}px`);
  assert.equal(menuEl()?.style.top, `${want.y}px`);
  assert.notEqual(want.x, 600, 'non-vacuity: this narrower window really moves the menu');
});

test('the card is fixed to the viewport, so opening it moves no pixel of the layout', async () => {
  // A width change anywhere in the shell fires every pane's ResizeObserver and
  // resizes every PTY behind it (the A9 rule). The menu lives on the BODY.
  await liveSession();
  rightClick(row('web'));
  assert.equal((menuEl() as FakeElement).parentNode, dom.body, 'the body, never the panel');
  const rule = /\.cm-menu\s*\{([^}]*)\}/.exec(stripComments(APP_CSS))?.[1] ?? '';
  assert.match(rule, /position: fixed/);
  assert.match(rule, /z-index: var\(--z-menu\)/);
});

// ---------------------------------------------------------------------------
// It is not a modal, and it is the only right-click in the app
// ---------------------------------------------------------------------------

const MENU_SRC = frontendFiles(['.ts']).find((f) => f.name === 'web/src/ui/context-menu.ts')?.src ?? '';
const FILES_SRC = frontendFiles(['.ts']).find((f) => f.name === 'web/src/ui/files.ts')?.src ?? '';

test('the menu is NOT a dialog: no scrim, no aria-modal, no tab trap', async () => {
  await liveSession();
  rightClick(row('web'));
  const box = menuEl() as FakeElement;
  assert.equal(box.classList.contains('modal-scrim'), false);
  assert.equal(box.getAttribute('aria-modal'), null);
  assert.equal(box.getAttribute('role'), 'menu', 'never `dialog`');
  // `ui/keys.ts` finds keyboard owners by these selectors; matching either
  // would make every pane a dead file-drop target and stop the terminal
  // taking the keyboard back after an alt-tab.
  assert.equal(box.closest('[role="dialog"], .drawer, .modal-scrim, .boot-overlay'), null);
  const code = MENU_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(code.length > 2_000, `non-vacuity: ${code.length} chars of the module`);
  for (const forbidden of ['modal-scrim', 'aria-modal', 'trapTab']) {
    assert.equal(code.includes(forbidden), false, `the menu must not be a modal: ${forbidden}`);
  }
});

test('only ui/files.ts and the menu card itself register a contextmenu listener', () => {
  // The mirror of the no-`dragstart` pin (tests/ui-filedrop.test.ts): a second
  // right-click handler anywhere — a pane, the tab strip, the terminal host —
  // would take the SYSTEM menu away from xterm, whose own `contextmenu`
  // handler is what makes the system Copy and Paste act on the selection.
  // `ui/context-menu.ts` is the one addition, and it is scoped to the OPEN
  // card only: the browser's own contextmenu for the key that opened the menu
  // targets an entry inside it, out of reach of the panel's delegated listener.
  const rootDir = join(here, '..', 'web', 'src');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|html|css)$/.test(e.name)) files.push(full);
    }
  };
  walk(rootDir);
  assert.ok(files.length >= 20, `non-vacuity: scanned ${files.length} files`);
  const offenders = files.filter((f) => /['"]contextmenu['"]/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(
    offenders.map((f) => f.slice(rootDir.length + 1)).sort(),
    ['ui/context-menu.ts', 'ui/files.ts'],
  );
  // And the menu's one is on its OWN card, registered through `on()` so it is
  // removed with the menu — never on the document, never on anything a
  // terminal is inside of.
  assert.equal(MENU_SRC.split("'contextmenu'").length - 1, 1);
  assert.match(MENU_SRC, /on\(box, 'contextmenu'/);
  // And it is ONE delegated listener, not one per row.
  assert.equal(FILES_SRC.split("addEventListener('contextmenu'").length - 1, 1);
  assert.match(FILES_SRC, /root\.addEventListener\('contextmenu'/);
});

test('main.ts s Escape ladder knows nothing about the menu', () => {
  // The menu owns Escape on its own window CAPTURE listener; a rung in the
  // ladder would be a second owner, and the ladder's length bound in
  // tests/ui-files-panel.test.ts is what A9b promised not to touch.
  const main = frontendFiles(['.ts']).find((f) => f.name === 'web/src/main.ts')?.src ?? '';
  assert.ok(main.length > 10_000, 'non-vacuity: main.ts');
  for (const name of ['RowMenu', 'context-menu', 'cm-menu']) {
    assert.equal(main.includes(name), false, `main.ts must not know the menu: ${name}`);
  }
});

test('the right-click s selection is the MODEL s rule, not a second copy of it', () => {
  // `afterMenuOpen()` is where "a right-click chooses a FOLDER row, a file row
  // chooses nothing" is decided, and tests/ui-files-select-model.test.ts is
  // where it is tested. Inlining the same rule here is behaviour-identical
  // TODAY — MEASURED (gate, 2026-09-16): `selected = dir ? path : selected`
  // left the whole suite green — so this is a SOURCE pin and says so: it is
  // the second place that would have to change when the rule does.
  assert.match(
    FILES_SRC,
    /selected = afterMenuOpen\(selected, \{ dir, path \}\)/,
    'the menu s selection must go through the model',
  );
});

test('the row menu region closes the menu at the top of every rebuild', () => {
  const from = FILES_SRC.indexOf('function rebuild(');
  assert.notEqual(from, -1, 'non-vacuity: rebuild() was found');
  const body = FILES_SRC.slice(from, FILES_SRC.indexOf('const focusKey', from));
  assert.match(body, /closeRowMenu\(\)/, 'the anchor row is about to be replaced');
});

// ---------------------------------------------------------------------------
// The block: class parity, tokens only, no colour literal
// ---------------------------------------------------------------------------

/** Class names a module really ASSIGNS (the `ui-a8-dialogs.test.ts` scanner). */
function assignedClasses(src: string): string[] {
  const out: string[] = [];
  const push = (s: string): void => {
    for (const c of s.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (c !== '') out.push(c);
  };
  for (const re of [
    /\bel\(\s*'[a-zA-Z0-9]+'\s*,\s*'([^']*)'/g,
    /\bbutton\(\s*'([^']*)'/g,
    /\.className\s*=\s*'([^']*)'/g,
    /classList\.(?:add|remove|toggle)\(\s*'([^']*)'/g,
  ]) {
    for (const m of src.matchAll(re)) push(m[1] as string);
  }
  return out;
}

/** The `cm-` section: the last one in app.css, so it runs to the end. */
function cmSection(): string {
  const css = APP_CSS;
  const at = css.indexOf('/* ---- row context menu (Nocturne A9b)');
  assert.notEqual(at, -1, 'non-vacuity: the cm- section header was not found');
  return css.slice(at);
}

test('class parity for cm-: no class without a rule, no rule without a setter, one owner', () => {
  const rules = stripComments(APP_CSS);
  const inTs = new Map<string, string[]>();
  for (const f of frontendFiles(['.ts'])) {
    for (const c of assignedClasses(f.src)) {
      if (!/^cm-[a-z0-9-]+$/.test(c)) continue;
      const owners = inTs.get(c) ?? [];
      if (!owners.includes(f.name)) owners.push(f.name);
      inTs.set(c, owners);
    }
  }
  const inCss = new Set<string>();
  for (const m of rules.matchAll(/\.(cm-[a-z0-9-]+)/g)) inCss.add(m[1] as string);
  assert.ok(inTs.size >= 4 && inCss.size >= 4, `non-vacuity: ts ${inTs.size}, css ${inCss.size}`);

  assert.deepEqual([...inTs.keys()].filter((c) => !inCss.has(c)), [], 'a class no rule styles');
  assert.deepEqual([...inCss].filter((c) => !inTs.has(c)), [], 'a rule no module sets');

  const owners = new Set<string>();
  for (const files of inTs.values()) for (const f of files) owners.add(f);
  assert.deepEqual([...owners], ['web/src/ui/context-menu.ts'], 'a prefix is one block s name');

  // Every rule is a BASE rule (the tests/ui-a8-block-rules.test.ts lesson: a
  // class styled only inside a @media block renders unstyled at every normal
  // window width and no parity guard notices).
  const base = cmSection().replace(/@media[^{]*\{[\s\S]*?\n\}\n/g, '');
  for (const c of inTs.keys()) {
    assert.match(base, new RegExp(`\\.${c}(?![\\w-])`), `${c} is styled only inside a @media block`);
  }
});

test('tokens only: every var() in the cm- section is declared, and it declares none of its own', () => {
  const declared = declaredTokens();
  assert.ok(declared.size >= 100, `non-vacuity: ${declared.size} tokens declared`);
  const block = stripComments(cmSection());
  assert.ok(block.length > 800, `non-vacuity: the cm- section is ${block.length} chars`);
  const used = usedTokens(block);
  assert.ok(used.length >= 10, `non-vacuity: only ${used.length} token reads`);
  assert.deepEqual([...new Set(used)].filter((t) => !declared.has(t)), []);
  assert.deepEqual([...block.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]), []);
});

test('no colour literal in the cm- section or in the module that paints it', () => {
  const offenders: string[] = [];
  for (const m of stripComments(cmSection()).matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/g)) {
    offenders.push(`app.css: ${m[0]}`);
  }
  const code = MENU_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(code.length > 2_000, 'non-vacuity: the module scan found nothing');
  for (const m of code.matchAll(/#[0-9a-fA-F]{6}\b|\b(?:rgba?|hsla?|oklch)\(/g)) {
    offenders.push(`context-menu.ts: ${m[0]}`);
  }
  assert.deepEqual(offenders, [], `a colour decision outside tokens.css: ${offenders.join('; ')}`);
});

test('--z-menu is declared once, sits between the toast and the modals, and is read here only', () => {
  const tokens = readFileSync(join(here, '..', 'web', 'src', 'styles', 'tokens.css'), 'utf8');
  const decl = [...tokens.matchAll(/^\s*--z-menu:\s*(\d+);/gm)];
  assert.equal(decl.length, 1, 'declared exactly once');
  assert.equal(decl[0]?.[1], '47');
  const n = (name: string): number =>
    Number(new RegExp(`--z-${name}:\\s*(\\d+);`).exec(tokens)?.[1] ?? '0');
  assert.ok(n('toast') < 47 && 47 < n('modal'), 'above the toast, below every dialog');
  const readers = [...stripComments(APP_CSS).matchAll(/var\(--z-menu\)/g)];
  assert.equal(readers.length, 1, 'one reader: the menu itself');
  assert.match(stripComments(cmSection()), /z-index: var\(--z-menu\)/);
});

test('the menu wears the row s own rhythm and the popover s elevation — and no icon, no separator', async () => {
  const block = stripComments(cmSection());
  assert.match(block, /min-height: var\(--files-row-h\)/, 'the tree s own 26px row');
  assert.match(block, /background: var\(--color-bg\)/);
  assert.match(block, /border-radius: var\(--radius-md\)/);
  assert.match(block, /box-shadow: var\(--shadow-md\)/);
  assert.match(block, /animation: fadeUp 0\.14s ease/);
  assert.match(block, /prefers-reduced-motion/);
  assert.match(block, /\.cm-item:hover\s*\{\s*background: var\(--color-neutral-900\)/);
  assert.match(block, /\.cm-item\[aria-disabled='true'\]\s*\{\s*color: var\(--color-neutral-700\)/);
  assert.match(block, /\.cm-sub\s*\{\s*color: var\(--color-neutral-600\)/);
  assert.match(block, /outline: var\(--tick\) solid var\(--color-accent\)/, 'the base focus ring');
  // The accent is an outline and a small mark, never a fill (Nocturne rule).
  assert.deepEqual([...block.matchAll(/background:\s*var\(--color-accent\)/g)].map((m) => m[0]), []);
  // No icon and no separator element: the module renders text only.
  await liveSession();
  rightClick(row('web'));
  const drawn = descendants(menuEl() as FakeElement);
  assert.deepEqual(
    [...new Set(drawn.map((n) => n.tagName))].sort(),
    ['BUTTON', 'SPAN'],
    'buttons and their words, nothing else',
  );
});
