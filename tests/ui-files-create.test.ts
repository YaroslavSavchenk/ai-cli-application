/**
 * `web/src/ui/files.ts` — creating a file or a folder from the Files panel
 * (Nocturne part A9c, `.claude/plans/nocturne/PLAN-B2.md` §6a and §6b), driven through the
 * REAL panel, the REAL row menu and the REAL `ui/fs-model.ts` on the DOM
 * double in `tests/fake-dom.ts`, against the fake `FsGateway` of
 * `tests/fs-fixture.ts`.
 *
 * WHY THIS FILE EXISTS, next to `ui-context-menu.test.ts` (which menu opens
 * where) and `ui-files-panel.test.ts` (how the tree loads). What A9c adds is a
 * piece of state that lives for a few seconds between a menu and a POST, and
 * every way it can be wrong is silent:
 *
 *   1. a name row drawn at the wrong indent, or inside a folder nobody opened,
 *      promises a place the file will not be created in;
 *   2. a client rule that is not mirrored sends the server a name it is
 *      certain to refuse — and one that is mirrored WRONG refuses a name the
 *      server would have taken;
 *   3. an Enter that posts twice creates one thing and refuses the second with
 *      a conflict the user never typed;
 *   4. a blur that COMMITS writes to the filesystem because somebody clicked
 *      away; a repaint that loses the typed text makes a refusal unreadable;
 *   5. an Escape that does not stop propagating spends one keystroke on three
 *      rungs of the ladder (the name row, the selection, the panel);
 *   6. a create left standing across a tab switch, a root change or a hidden
 *      panel is a post aimed at a folder nobody is looking at any more.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`): that
 * the row is legible, that it really changes no layout (the CSS block is read
 * as source below), that a real `<input>` takes a keystroke, screen-reader
 * output, and anything the server does with the request.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project, SessionInfo } from '../shared/protocol.ts';
import { byClass, byKey, dispatch, installDom, textsOf, type FakeElement } from './fake-dom.ts';
import { APP_CSS, declaredTokens, mySections, stripComments, usedTokens } from './tokens-helpers.ts';
import {
  FakeApiError,
  PROJ,
  PROJ2,
  makeFixture,
  settle,
  type CreateCall,
  type Gateway,
} from './fs-fixture.ts';

const fx = makeFixture();
const dom = installDom();

const here = dirname(fileURLToPath(import.meta.url));
const FILES_SRC = readFileSync(join(here, '..', 'web', 'src', 'ui', 'files.ts'), 'utf8');

const st = (await import(new URL('../web/src/state.ts', import.meta.url).href)) as StateModule;
const F = (await import(new URL('../web/src/ui/files.ts', import.meta.url).href)) as FilesModule;
const FD = (await import(new URL('../web/src/ui/filedrop.ts', import.meta.url).href)) as FileDropModule;
const CM = (await import(new URL('../web/src/ui/context-menu.ts', import.meta.url).href)) as MenuModule;

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
  slotTabIds(slot: unknown): string[];
}
interface Dest {
  path: string;
  name: string;
}
interface FilesModule {
  initFilesPanel(host: unknown, onLeaveScreen: () => void, fs: Gateway): { render(): void };
  selectedFolder(): Dest | null;
  pasteDestination(): Dest | null;
  destinationOfActiveView(): Dest | null;
  filesPanelDestination(): Dest | null;
  destinationOfPane(paneEl: unknown): unknown;
  listingFor(dest: Dest): Promise<readonly string[]>;
}
interface FileDropModule {
  initFileDrop(deps: Record<string, unknown>): void;
}
interface MenuModule {
  isRowMenuOpen(): boolean;
  closeRowMenu(): void;
}
interface ViewLike {
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
const pane = dom.doc.createElement('div');
pane.className = 'pane';
const termHost = dom.doc.createElement('div');
termHost.className = 'term-host';
const termInput = dom.doc.createElement('textarea');
termHost.append(termInput);
pane.append(termHost);
dom.body.append(pane);

const host = dom.doc.createElement('aside');
host.className = 'drawer files-panel';
dom.body.append(host);
const panel = F.initFilesPanel(host, () => {}, fx.gateway);
const root = host.children[0] as FakeElement;
st.subscribe(() => panel.render());

/**
 * `main.ts`'s Escape ladder, mirrored (the same mirror the menu tests use):
 * A9c may not touch that ladder, so this is how "the name row's Escape never
 * reaches it" is checked without importing main.ts.
 */
let ladderSaw = 0;
dom.win.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  ladderSaw += 1;
});

/**
 * EVERY key that reaches the window, not just Escape. The `?` overlay, the
 * shortcuts chord and the ctrl+alt family all live on window listeners, so
 * "the name row spends the key itself" is only true if nothing at all arrives
 * up there — an Enter that bubbled would be read by whatever is listening the
 * day after this test was written.
 */
const winKeys: string[] = [];
dom.win.addEventListener('keydown', (e) => {
  winKeys.push(e.key);
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
function focusSession(id: string): void {
  const v = st.state.views.find((x) =>
    x.slots.some(
      (s) =>
        (s as { kind: string; id?: string }).kind === 'session' && (s as { id: string }).id === id,
    ),
  );
  if (v !== undefined) st.state.activeViewId = v.id;
}

const dirRow = (rel: string): FakeElement => byKey(root, `fdir:${PROJ}/${rel}`) as FakeElement;
const fileRow = (rel: string): FakeElement => byKey(root, `ffile:${PROJ}/${rel}`) as FakeElement;
const rows = (): FakeElement[] => byClass(root, 'files-row');
const newRow = (): FakeElement | undefined => byClass(root, 'is-new')[0];
const errRow = (): FakeElement | undefined => byClass(root, 'is-newerr')[0];
const nameField = (): FakeElement => byClass(root, 'files-newname')[0] as FakeElement;
const menuEl = (): FakeElement | undefined => byClass(dom.body, 'cm-menu')[0];
const items = (): FakeElement[] => byClass(dom.body, 'cm-item');
const labels = (): string[] => textsOf(dom.body, 'cm-label');
const background = (): FakeElement => byClass(root, 'files-body')[0] as FakeElement;

/** Right-click a row (or the background), at a point. */
function rightClick(el: FakeElement): void {
  dispatch(el, 'contextmenu', { clientX: 40, clientY: 120 });
}

/** Walk the roving focus to an entry and press Enter on it — the keyboard path. */
function activate(label: string): void {
  const list = items();
  const i = list.findIndex((b) => textsOf(b, 'cm-label')[0] === label);
  assert.notEqual(i, -1, `no entry called ${label}`);
  for (let step = 0; step < i; step += 1) {
    dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: 'ArrowDown' });
  }
  dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: 'Enter' });
}

/** Open the menu on a folder row (or the background) and choose one entry. */
function choose(on: FakeElement, label: string): void {
  rightClick(on);
  activate(label);
}

/** Type into the name row the way a person does, then press Enter. */
function type(text: string): void {
  nameField().value = text;
}
function pressEnter(): ReturnType<typeof dispatch> {
  return dispatch(nameField(), 'keydown', { key: 'Enter' });
}
function pressEscape(el: FakeElement): ReturnType<typeof dispatch> {
  return dispatch(el, 'keydown', { key: 'Escape' });
}

const OPEN_AT_START = ['web', 'web/src', 'server'];

/** A live session in a project — the panel's normal world, header `api`. */
async function liveSession(): Promise<void> {
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

beforeEach(async () => {
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
  ladderSaw = 0;
  winKeys.length = 0;
  dom.doc.activeElement = dom.body;
  fx.reset();
  panel.render();
  pressEscape(root);
  await settle();
});

afterEach(() => {
  CM.closeRowMenu();
});

// ---------------------------------------------------------------------------
// The entries (§6a)
// ---------------------------------------------------------------------------

test('a FOLDER row offers New file and New folder; a FILE row offers neither', async () => {
  await liveSession();
  rightClick(dirRow('web'));
  // `Delete` is the last entry since B10a, so the three A9c entries are the
  // ones before it.
  assert.deepEqual(labels().slice(-4, -1), ['New file', 'New folder', 'Refresh']);
  CM.closeRowMenu();
  rightClick(fileRow('README.md'));
  for (const label of ['New file', 'New folder', 'Refresh']) {
    assert.equal(
      labels().includes(label),
      false,
      `a file row must not offer ${label}: ${labels().join(', ')}`,
    );
  }
});

test('the panel s BACKGROUND offers them too — the root is a folder like any other', async () => {
  await liveSession();
  rightClick(background());
  assert.deepEqual(labels(), ['Copy files here…', 'New file', 'New folder', 'Refresh']);
});

// ---------------------------------------------------------------------------
// The name row (§6b)
// ---------------------------------------------------------------------------

test('New folder puts one name row INSIDE the folder, at the child indent, with the keyboard', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  const row = newRow() as FakeElement;
  assert.ok(row !== undefined, 'a name row');
  assert.equal(byClass(root, 'is-new').length, 1, 'exactly one');
  // Right AFTER the folder's own row: the thing being named is visibly inside
  // the folder that will hold it.
  const all = rows();
  assert.equal(all.indexOf(row), all.indexOf(dirRow('web')) + 1);
  // rowIndent(depth) = 8 + depth * 14, and `web` is a child of the root, so its
  // own children sit at depth 1.
  assert.equal(row.style.paddingLeft, '22px');
  assert.equal(dirRow('web').style.paddingLeft, '8px', 'non-vacuity: the parent is one step out');
  // The field is the label, and it has the keyboard on the repaint that made it.
  const input = nameField();
  assert.equal(input.tagName, 'INPUT');
  assert.equal(input.getAttribute('aria-label'), 'new folder name');
  assert.equal(input.spellcheck, false);
  assert.equal(input.getAttribute('autocapitalize'), 'off');
  assert.equal(input.readOnly, false);
  assert.equal(dom.doc.activeElement, input, 'it takes the keyboard on the repaint that made it');
  // The KIND is visible before a letter is typed: a folder wears the mark.
  assert.equal(byClass(row, 'files-folder').length, 1);
  assert.equal(byClass(row, 'files-icon').length, 0);
});

test('New file wears the plain file glyph and says so to a screen reader', async () => {
  await liveSession();
  choose(dirRow('web'), 'New file');
  const row = newRow() as FakeElement;
  assert.equal(nameField().getAttribute('aria-label'), 'new file name');
  assert.equal(byClass(row, 'files-icon').length, 1, 'a file mark, with no type to claim yet');
  assert.equal(byClass(row, 'files-folder').length, 0);
  const icon = byClass(row, 'files-icon')[0];
  assert.equal(icon?.getAttribute('data-icon'), 'file', 'the plain file glyph (B12)');
  assert.equal(icon?.getAttribute('data-kind'), 'plain');
  assert.equal(icon?.getAttribute('aria-hidden'), 'true');
});

test('a CLOSED folder is opened — and fetched — before the row is drawn in it', async () => {
  await liveSession();
  assert.equal(dirRow('shared').getAttribute('aria-expanded'), 'false', 'non-vacuity: closed');
  assert.equal(fx.entryCalls.includes(`${PROJ}/shared`), false, 'and never listed yet');
  choose(dirRow('shared'), 'New file');
  assert.equal(
    dirRow('shared').getAttribute('aria-expanded'),
    'true',
    'a name row in a closed folder is a promise about a place nobody can see',
  );
  assert.deepEqual(fx.entryCalls, [`${PROJ}/shared`]);
  await settle();
  const all = rows();
  assert.equal(all.indexOf(newRow() as FakeElement), all.indexOf(dirRow('shared')) + 1);
  assert.equal((newRow() as FakeElement).style.paddingLeft, '22px');
  assert.ok(byKey(root, `fdir:${PROJ}/shared/empty`) !== null, 'the listing landed around it');
});

test('the ROOT s name row sits at the top of the tree, at depth 0, and opens nothing', async () => {
  await liveSession();
  const before = fx.entryCalls.length;
  choose(background(), 'New folder');
  const row = newRow() as FakeElement;
  assert.equal(rows().indexOf(row), 0, 'the root has no row: its children start the tree');
  assert.equal(row.style.paddingLeft, '8px');
  assert.equal(fx.entryCalls.length, before, 'the root is already listed — nothing is fetched');
});

test('ONE at a time: a second choice moves the row, it never draws two', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  type('half-typed');
  choose(dirRow('server'), 'New file');
  assert.equal(byClass(root, 'is-new').length, 1);
  const all = rows();
  assert.equal(all.indexOf(newRow() as FakeElement), all.indexOf(dirRow('server')) + 1);
  assert.equal(nameField().value, '', 'the new row starts empty: it is a different question');
  assert.equal(nameField().getAttribute('aria-label'), 'new file name');
});

// ---------------------------------------------------------------------------
// Enter: what is posted
// ---------------------------------------------------------------------------

test('Enter posts {dir, name, kind} exactly ONCE', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  type('docs');
  pressEnter();
  assert.deepEqual(fx.createCalls, [{ dir: `${PROJ}/web`, name: 'docs', kind: 'folder' }]);
  await settle();
  assert.equal(fx.createCalls.length, 1, 'one gesture, one create');
});

test('a create for the ROOT posts the root s own path', async () => {
  await liveSession();
  choose(background(), 'New file');
  type('TODO.md');
  pressEnter();
  assert.deepEqual(fx.createCalls, [{ dir: PROJ, name: 'TODO.md', kind: 'file' }]);
  await settle();
});

test('Enter while the request is out posts nothing more', async () => {
  await liveSession();
  fx.holdCreate();
  choose(dirRow('web'), 'New folder');
  type('docs');
  pressEnter();
  await settle();
  pressEnter();
  pressEnter();
  assert.equal(fx.createCalls.length, 1, 'a second Enter must not post a second create');
  fx.releaseCreate();
  await settle();
});

// ---------------------------------------------------------------------------
// Validation, inline (§6b)
// ---------------------------------------------------------------------------

test('each client rule shows its sentence under the row, and costs NO request', async () => {
  await liveSession();
  const cases: [string, string][] = [
    ['', 'Type a name first.'],
    ['a/b', 'A name cannot contain a slash.'],
    ['a\\b', 'A name cannot contain a slash.'],
    ['..', 'That name is not allowed.'],
    ['x', 'That name is not allowed.'],
    ['x'.repeat(256), 'That name is too long.'],
  ];
  for (const [typed, sentence] of cases) {
    choose(dirRow('web'), 'New file');
    type(typed);
    pressEnter();
    const err = errRow() as FakeElement;
    assert.ok(err !== undefined, `no sentence for ${JSON.stringify(typed)}`);
    assert.equal(textsOf(err, 'files-name')[0], sentence);
    // Directly beneath the name row, at the same indent: nothing else moved.
    const all = rows();
    assert.equal(all.indexOf(err), all.indexOf(newRow() as FakeElement) + 1);
    assert.equal(err.style.paddingLeft, (newRow() as FakeElement).style.paddingLeft);
    assert.equal(nameField().value, typed, 'the text stays: the next thing you do is fix it');
    assert.equal(dom.doc.activeElement, nameField(), 'and so does the keyboard');
    assert.deepEqual(fx.createCalls, [], `${JSON.stringify(typed)} reached the server`);
  }
  // Non-vacuity: a name the rules allow really does post.
  type('ok.md');
  pressEnter();
  assert.equal(fx.createCalls.length, 1);
  await settle();
});

test('a name the server refuses shows the SERVER s sentence, and keeps the text', async () => {
  await liveSession();
  fx.failCreate(); // 409 That name is already taken.
  choose(dirRow('web'), 'New folder');
  type('src');
  pressEnter();
  await settle();
  assert.equal(fx.createCalls.length, 1, 'the client rules had nothing to say about it');
  assert.equal(textsOf(errRow() as FakeElement, 'files-name')[0], 'That name is already taken.');
  assert.equal(nameField().value, 'src', 'the typed name survives the repaint that drew the refusal');
  assert.equal(nameField().readOnly, false, 'and the field is editable again');
  assert.equal(dom.doc.activeElement, nameField());
  assert.equal((newRow() as FakeElement).classList.contains('is-busy'), false);
  // Fixing the name and pressing Enter again is the whole recovery.
  fx.createFails = null;
  type('src2');
  pressEnter();
  await settle();
  assert.deepEqual(fx.createCalls.slice(-1), [{ dir: `${PROJ}/web`, name: 'src2', kind: 'folder' }]);
  assert.equal(newRow(), undefined, 'and the row is gone');
});

test('a failure with no sentence of its own falls back to the app s own line', async () => {
  await liveSession();
  // `HTTP 500` is what api.ts invents when a body carries no error at all, and
  // the panel's `isSentence` refuses it on purpose: it is not a sentence this
  // app ever wrote.
  fx.failCreate(new FakeApiError(500, 'HTTP 500'));
  choose(dirRow('web'), 'New file');
  type('a.md');
  pressEnter();
  await settle();
  assert.equal(textsOf(errRow() as FakeElement, 'files-name')[0], 'The app could not create it.');
  // And a failure whose message is not a sentence either.
  fx.failCreate(new FakeApiError(0, 'fetch failed'));
  type('b.md');
  pressEnter();
  await settle();
  assert.equal(textsOf(errRow() as FakeElement, 'files-name')[0], 'The app could not create it.');
});

test('the refusal is never a dialog: nothing is added outside the panel', async () => {
  await liveSession();
  const outside = dom.body.children.length;
  fx.failCreate();
  choose(dirRow('web'), 'New folder');
  type('src');
  pressEnter();
  await settle();
  assert.equal(dom.body.children.length, outside, 'a modal would have appended a scrim');
  assert.equal(byClass(dom.body, 'modal-scrim').length, 0);
});

// ---------------------------------------------------------------------------
// In flight (§6b)
// ---------------------------------------------------------------------------

test('while the request is out the field is read-only and the row pulses — and nothing moves', async () => {
  await liveSession();
  fx.holdCreate();
  choose(dirRow('web'), 'New folder');
  type('docs');
  const before = (newRow() as FakeElement).style.paddingLeft;
  pressEnter();
  await settle();
  const row = newRow() as FakeElement;
  assert.equal(nameField().readOnly, true, 'a name that is being created is not one you edit');
  assert.equal(row.classList.contains('is-busy'), true);
  assert.equal(row.classList.contains('is-new'), true, 'still the same row');
  assert.equal(row.style.paddingLeft, before, 'no indent and no height change mid-request');
  assert.equal(nameField().value, 'docs');
  fx.releaseCreate();
  await settle();
  assert.equal(newRow(), undefined);
});

// ---------------------------------------------------------------------------
// Success (§6b)
// ---------------------------------------------------------------------------

test('a created FOLDER is selected, expanded, focused — and its folder refetched once', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  type('docs');
  pressEnter();
  await settle();
  assert.equal(newRow(), undefined, 'the name row is done');
  const made = byKey(root, `fdir:${PROJ}/web/docs`) as FakeElement;
  assert.ok(made !== null, 'the new folder has a row');
  assert.equal(made.getAttribute('aria-expanded'), 'true', 'expanded: its empty state is honest');
  assert.deepEqual(F.selectedFolder(), { path: `${PROJ}/web/docs`, name: 'docs' });
  assert.equal(made.classList.contains('is-sel'), true);
  assert.equal(dom.doc.activeElement, made, 'the keyboard lands on the row that was made');
  assert.equal(
    fx.entryCalls.filter((p) => p === `${PROJ}/web`).length,
    1,
    'the folder it went into is re-read exactly once',
  );
});

test('a created FILE is opened as a pane, and the keyboard lands on its row', async () => {
  await liveSession();
  choose(dirRow('web'), 'New file');
  type('notes.md');
  pressEnter();
  await settle();
  const v = st.activeView() as ViewLike;
  assert.deepEqual(
    v.slots.map((s) => st.slotTabIds(s)),
    [[`f:${PROJ}/web/notes.md`]],
    'one editor pane, holding the new file at its absolute path',
  );
  const made = byKey(root, `ffile:${PROJ}/web/notes.md`) as FakeElement;
  assert.ok(made !== null, 'the new file has a row');
  assert.equal(dom.doc.activeElement, made);
  // The right-click that opened the menu chose the FOLDER (A9b), and creating
  // a file in it changes nothing about that: the destination is still the
  // place the file was made in.
  assert.deepEqual(F.selectedFolder(), { path: `${PROJ}/web`, name: 'web' });
});

test('a create in the ROOT lands in the root s own listing', async () => {
  await liveSession();
  choose(background(), 'New folder');
  type('notes');
  pressEnter();
  await settle();
  const made = byKey(root, `fdir:${PROJ}/notes`) as FakeElement;
  assert.ok(made !== null);
  assert.equal(fx.entryCalls.filter((p) => p === PROJ).length, 1, 'the root, re-read once');
});

// ---------------------------------------------------------------------------
// Escape, blur, and the ladder (§6b)
// ---------------------------------------------------------------------------

test('Escape cancels the name row and NOTHING else — three presses, three effects', async () => {
  await liveSession();
  dirRow('web').click(); // a click selects the row (A9b)
  await settle();
  assert.deepEqual(F.selectedFolder(), { path: `${PROJ}/web`, name: 'web' }, 'non-vacuity');
  choose(dirRow('web'), 'New file');
  type('half');
  ladderSaw = 0;

  // 1. the name row.
  const first = pressEscape(nameField());
  assert.equal(first.defaultPrevented, true);
  assert.equal(first.cancelBubble, true, 'the key is spent on the name row');
  assert.equal(ladderSaw, 0, 'and main.ts s ladder never sees it');
  assert.equal(newRow(), undefined, 'the row is gone');
  assert.deepEqual(
    F.selectedFolder(),
    { path: `${PROJ}/web`, name: 'web' },
    'the chosen folder is untouched by the first press',
  );
  assert.equal(st.state.leftPanel, 'files', 'and the panel is still there');
  assert.deepEqual(fx.createCalls, [], 'a cancel posts nothing');
  // The keyboard is back INSIDE the panel, which is what makes the next rung
  // reachable at all: the panel's own Escape listener lives on its root.
  assert.equal(dom.doc.activeElement, dirRow('web'), 'back on the row the menu came from');

  // 2. the selection.
  const second = pressEscape(dirRow('web'));
  assert.equal(second.cancelBubble, true);
  assert.deepEqual(F.selectedFolder(), null);
  assert.equal(st.state.leftPanel, 'files');

  // 3. the panel — main.ts's rung, so the key must REACH the window.
  ladderSaw = 0;
  const third = pressEscape(dirRow('web'));
  assert.equal(third.cancelBubble, false, 'with nothing of its own left, the key goes through');
  assert.equal(ladderSaw, 1, 'and the ladder closes the panel');
});

test('a name row for the ROOT hands the keyboard back to a control inside the panel', async () => {
  await liveSession();
  choose(background(), 'New file');
  pressEscape(nameField());
  assert.equal(newRow(), undefined);
  const back = dom.doc.activeElement as FakeElement;
  assert.equal(
    back.closest('.files-view') !== null,
    true,
    'a keyboard on <body> would skip a rung of the ladder',
  );
  assert.equal(back.getAttribute('data-k'), 'fcopy');
});

test('Enter is spent ON the name row: no window handler ever sees it', async () => {
  await liveSession();
  choose(dirRow('web'), 'New file');
  type('notes.md');
  winKeys.length = 0;
  const e = pressEnter();
  assert.equal(e.defaultPrevented, true, 'a bare Enter in a field submits, and there is no form here');
  assert.equal(e.cancelBubble, true, 'the key is the name row s, and it is spent there');
  assert.deepEqual(
    winKeys,
    [],
    'the window is where the ? overlay and the ctrl+alt family listen: a key that arrives there is a second effect on one press',
  );
  assert.equal(fx.createCalls.length, 1, 'non-vacuity: that Enter really did post');
  await settle();
  // And the Enter that is REFUSED by the client rules is spent just as hard:
  // the request is what differs, never who owns the key.
  choose(dirRow('web'), 'New file');
  type('a/b');
  winKeys.length = 0;
  const bad = pressEnter();
  assert.equal(bad.defaultPrevented, true);
  assert.equal(bad.cancelBubble, true);
  assert.deepEqual(winKeys, []);
  assert.equal(fx.createCalls.length, 1, 'non-vacuity: the slash cost no request');
});

test('the panel s own chord steps aside for the name row — one menu, never two', async () => {
  await liveSession();
  for (const init of [{ key: 'ContextMenu' }, { key: 'F10', shiftKey: true }]) {
    choose(dirRow('web'), 'New file');
    type('half');
    assert.equal(dom.doc.activeElement, nameField(), 'non-vacuity: the keyboard is in the input');
    // The input lives INSIDE a `.files-row`, which is exactly what the panel's
    // own chord arm steps aside for: the row owns the gesture, and the name row
    // has no menu of its own. A root menu opening here would also CANCEL the
    // create, which is the silent half of the bug.
    const e = dispatch(nameField(), 'keydown', init);
    assert.equal(byClass(dom.body, 'cm-menu').length, 0, `${init.key} opened a menu over the name row`);
    assert.equal(e.defaultPrevented, false, `${init.key} was taken by the panel`);
    assert.ok(newRow() !== undefined, 'and the half-typed name is still there');
    assert.equal(nameField().value, 'half');
    pressEscape(nameField());
  }
  assert.deepEqual(fx.createCalls, []);
  // A focused ROW still answers the chord with exactly ONE menu: its own.
  dirRow('web').focus();
  dispatch(dirRow('web'), 'keydown', { key: 'ContextMenu' });
  assert.equal(byClass(dom.body, 'cm-menu').length, 1);
  assert.equal(menuEl()?.getAttribute('aria-label'), 'actions for web');
  CM.closeRowMenu();
});

test('blur CANCELS, it never commits', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  type('docs');
  nameField().blur();
  assert.equal(newRow(), undefined, 'the row is gone');
  assert.deepEqual(fx.createCalls, [], 'clicking away must never write to the filesystem');
});

test('a blur LEAVES the keyboard where the user put it; only Escape brings it back', async () => {
  // The two cancels differ in exactly one thing. A blur is the browser ALREADY
  // moving the keyboard somewhere the user chose — a terminal, another window
  // — and a panel that focused a tree row from inside that transfer would send
  // the next keystrokes to a Files row instead of to a PTY.
  await liveSession();
  choose(dirRow('web'), 'New folder');
  type('docs');
  termInput.focus(); // the click that lands in the terminal
  dispatch(nameField(), 'blur'); // the browser's own notification, after the move
  assert.equal(newRow(), undefined, 'the question is gone');
  assert.deepEqual(fx.createCalls, []);
  assert.equal(dom.doc.activeElement, termInput, 'the panel yanked the keyboard out of a terminal');
  assert.equal(
    (dom.doc.activeElement as FakeElement).closest('.files-view'),
    null,
    'nothing in the panel may hold the keyboard after a blur',
  );

  // ESCAPE is the other caller, and it is a ladder rung: the keyboard has to
  // come back INSIDE the panel, or the next press skips to closing it.
  choose(dirRow('web'), 'New folder');
  type('docs');
  pressEscape(nameField());
  assert.equal(newRow(), undefined);
  assert.ok(
    (dom.doc.activeElement as FakeElement).closest('.files-view') !== null,
    'Escape hands the keyboard back to the panel',
  );
});

test('the row a create made takes the keyboard only while the keyboard is still ours', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  type('docs');
  // The listing that will carry the new row is held, which is the real gap:
  // the create is answered, the tree is not, and a user can click into a
  // terminal in between.
  fx.holdIf((c) => c.kind === 'entries' && c.path === `${PROJ}/web`);
  pressEnter();
  await settle();
  assert.equal(fx.createCalls.length, 1, 'non-vacuity: the create landed');
  termInput.focus();
  fx.release();
  await settle();
  const made = byKey(root, `fdir:${PROJ}/web/docs`) as FakeElement;
  assert.ok(made !== null, 'non-vacuity: the row really did arrive');
  assert.equal(
    dom.doc.activeElement,
    termInput,
    'a row that arrives after the user went to a terminal must not take the keyboard',
  );
  // And the promise is spent, not saved up: the next repaint may not grab it.
  panel.render();
  assert.equal(dom.doc.activeElement, termInput);
});

// ---------------------------------------------------------------------------
// The late answer (§6b): a create the user walked away from
// ---------------------------------------------------------------------------

/**
 * One create whose answer this test holds and then REFUSES. The fixture can
 * hold a success (`holdCreate`) but rejects at call time, and a refusal that
 * lands after a cancel is exactly the case `createToken` exists for — so the
 * gateway's own `create` is swapped for the length of one test and put back.
 */
function deferCreate(): { reject(err: unknown): void; restore(): void } {
  const real = fx.gateway.create.bind(fx.gateway);
  let rej: ((e: unknown) => void) | null = null;
  fx.gateway.create = (dir: string, name: string, kind: 'file' | 'folder') => {
    fx.createCalls.push({ dir, name, kind } satisfies CreateCall);
    return new Promise<{ path: string }>((_res, r) => {
      rej = r;
    });
  };
  return {
    reject(err: unknown): void {
      rej?.(err);
    },
    restore(): void {
      fx.gateway.create = real;
    },
  };
}

test('a create ANSWERED after a cancel re-reads its folder and does nothing else', async () => {
  for (const kind of ['New file', 'New folder'] as const) {
    await liveSession();
    const leaf = kind === 'New file' ? 'notes.md' : 'docs';
    fx.holdCreate();
    choose(dirRow('web'), kind);
    type(leaf);
    pressEnter();
    await settle();
    assert.equal(fx.createCalls.length, 1, `${kind}: non-vacuity, the request is out`);
    const slots = JSON.stringify(st.activeView()?.slots ?? null);
    const chosen = JSON.stringify(F.selectedFolder());
    // The user walks away: Escape, while the server is still writing.
    pressEscape(nameField());
    assert.equal(newRow(), undefined, `${kind}: non-vacuity, the question is gone`);
    // The keyboard is read as a KEY, not as an element: the re-read below
    // rebuilds the rows, so the element that has it afterwards is a fresh one
    // carrying the same promise.
    const backKey = (dom.doc.activeElement as FakeElement).getAttribute('data-k');
    fx.entryCalls.length = 0;
    fx.releaseCreate();
    await settle();
    // THE THING EXISTS ON DISK. The user cancelled the QUESTION, not the
    // create that had already been posted — so the folder it went into is read
    // again, or the tree would keep hiding a file whose name the next attempt
    // is about to be refused for (§1d's 409, with nothing on screen to explain
    // it). Exactly once, and for that folder only.
    assert.deepEqual(fx.entryCalls, [`${PROJ}/web`], `${kind}: the folder must be re-read, once`);
    // NOT asserted: that no row for it appears. The fake writes the new entry
    // into the tree it already handed out, so a row can turn up on the next
    // repaint for reasons that are the fixture's, not the panel's — what the
    // panel owes here is the four effects below, and the re-read above.
    assert.equal(
      (dom.doc.activeElement as FakeElement).getAttribute('data-k'),
      backKey,
      `${kind}: the keyboard followed a create the user had already walked away from`,
    );
    assert.equal(
      JSON.stringify(st.activeView()?.slots ?? null),
      slots,
      `${kind}: a pane opened for a create that was cancelled`,
    );
    assert.equal(JSON.stringify(F.selectedFolder()), chosen, `${kind}: the selection moved`);
    assert.equal(errRow(), undefined, `${kind}: a sentence for a question nobody asked`);
    fx.reset();
  }
});

test('a REFUSAL that lands after a cancel is not painted at anybody', async () => {
  await liveSession();
  const held = deferCreate();
  try {
    choose(dirRow('web'), 'New folder');
    type('src');
    pressEnter();
    await settle();
    assert.equal(fx.createCalls.length, 1, 'non-vacuity: the request is out');
    pressEscape(nameField());
    assert.equal(newRow(), undefined, 'non-vacuity: the question is gone');
    const back = dom.doc.activeElement;
    held.reject(new FakeApiError(409, 'That name is already taken.'));
    await settle();
    assert.equal(errRow(), undefined, 'a refusal for a name nobody is typing any more');
    assert.equal(newRow(), undefined, 'and no name row came back to carry it');
    assert.equal(
      textsOf(root, 'files-name').includes('That name is already taken.'),
      false,
      'the sentence reached the tree',
    );
    assert.equal(dom.doc.activeElement, back, 'and the keyboard was not yanked back into a dead field');
  } finally {
    held.restore();
  }
});

test('a create answered after the ROOT moved lands in neither tree', async () => {
  await liveSession();
  fx.holdCreate();
  choose(dirRow('web'), 'New file');
  type('notes.md');
  pressEnter();
  await settle();
  assert.equal(fx.createCalls.length, 1, 'non-vacuity: the request is out');
  focusSession('s2');
  panel.render();
  await settle();
  // Read AFTER the switch: the other session is another view, so the pane this
  // watches is the one the late answer could still open a file in.
  const slots = JSON.stringify(st.activeView()?.slots ?? null);
  assert.deepEqual(
    F.filesPanelDestination(),
    { path: PROJ2, name: 'tools' },
    'non-vacuity: the root really moved',
  );
  fx.entryCalls.length = 0;
  fx.releaseCreate();
  await settle();
  assert.deepEqual(fx.entryCalls, [], 'the folder it was made in belongs to a tree nobody is looking at');
  assert.equal(byKey(root, `ffile:${PROJ}/web/notes.md`), null);
  assert.equal(byKey(root, `ffile:${PROJ2}/web/notes.md`), null, 'and it is not invented in the new one');
  assert.equal(
    JSON.stringify(st.activeView()?.slots ?? null),
    slots,
    'no pane opened for a file the panel stopped being about',
  );
  assert.equal(newRow(), undefined);
});

// ---------------------------------------------------------------------------
// Everything else that cancels it (§6b)
// ---------------------------------------------------------------------------

test('a TAB switch cancels it', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  type('docs');
  const changes = byKey(root, 'ftab:changes') as FakeElement;
  assert.equal(changes.disabled, false, 'non-vacuity: the fixture root is a repository');
  changes.click();
  await settle();
  assert.equal(newRow(), undefined);
  (byKey(root, 'ftab:files') as FakeElement).click();
  await settle();
  assert.equal(newRow(), undefined, 'and coming back does not bring the question back');
  assert.deepEqual(fx.createCalls, []);
});

test('a ROOT change cancels it', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  type('docs');
  focusSession('s2');
  panel.render();
  await settle();
  assert.equal(newRow(), undefined, 'the folder it was inside is not even in this tree');
  assert.deepEqual(fx.createCalls, []);
  assert.deepEqual(
    F.filesPanelDestination(),
    { path: PROJ2, name: 'tools' },
    'non-vacuity: the root really moved',
  );
});

test('the panel leaving the screen cancels it', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  type('docs');
  st.state.leftPanel = null;
  panel.render();
  st.state.leftPanel = 'files';
  panel.render();
  await settle();
  assert.equal(newRow(), undefined, 'a question nobody could see must not come back');
  assert.deepEqual(fx.createCalls, []);
});

test('any menu opening cancels it — on a row and on the background alike', async () => {
  await liveSession();
  for (const on of [(): FakeElement => dirRow('server'), background]) {
    choose(dirRow('web'), 'New folder');
    type('docs');
    rightClick(on());
    assert.ok(menuEl() !== undefined, 'the menu is up');
    assert.equal(newRow(), undefined, 'and the half-typed name is not under it');
    CM.closeRowMenu();
  }
  assert.deepEqual(fx.createCalls, []);
});

test('a name row whose folder CLOSES under it is dropped, not left hanging off a shut row', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  assert.ok(newRow() !== undefined, 'non-vacuity');
  // The primary click on the folder closes it, and §6b's own rule is that the
  // folder is open while its name row is up: a row at the child indent under a
  // shut folder would name a place the tree is no longer showing.
  dirRow('web').click();
  await settle();
  assert.equal(dirRow('web').getAttribute('aria-expanded'), 'false');
  assert.equal(newRow(), undefined);
  assert.deepEqual(fx.createCalls, []);
});

test('a name row whose folder LEAVES the tree is dropped too', async () => {
  await liveSession();
  choose(dirRow('web/src'), 'New file');
  assert.ok(newRow() !== undefined, 'non-vacuity');
  // Closing the ANCESTOR takes the row the name row was anchored to off screen
  // entirely: `createRowIndex` answers -1 and the create is dropped rather than
  // drawn somewhere arbitrary.
  dirRow('web').click();
  await settle();
  assert.equal(newRow(), undefined);
  assert.deepEqual(fx.createCalls, []);
});

// ---------------------------------------------------------------------------
// Refresh (§6a)
// ---------------------------------------------------------------------------

test('Refresh on a folder re-asks THAT folder, and nothing else', async () => {
  await liveSession();
  choose(dirRow('web'), 'Refresh');
  assert.deepEqual(fx.entryCalls, [`${PROJ}/web`]);
  await settle();
  // The rows stayed on screen while the new answer travelled (the panel's
  // cache-then-revalidate rule): no `Loading…` flash for a folder that already
  // answered.
  assert.ok(byKey(root, `fdir:${PROJ}/web/src`) !== null);
});

test('Refresh on the ROOT re-asks the root and the open folders, and drops the cache under it', async () => {
  await liveSession();
  // A folder that was opened and closed again: its listing is still cached, and
  // that cache is what this gesture has to drop.
  dirRow('shared').click();
  await settle();
  dirRow('shared').click();
  await settle();
  assert.equal(dirRow('shared').getAttribute('aria-expanded'), 'false');
  fx.entryCalls.length = 0;

  choose(background(), 'Refresh');
  assert.deepEqual(
    [...fx.entryCalls].sort(),
    [PROJ, `${PROJ}/server`, `${PROJ}/web`, `${PROJ}/web/src`].sort(),
    'the root and every open folder under it — a dropped cache nobody re-asks is a tree stuck on Loading…',
  );
  assert.equal(
    fx.entryCalls.includes(`${PROJ}/shared`),
    false,
    'a closed folder is read when it is next opened',
  );
  await settle();

  // And the closed folder really lost its cache: opening it shows `Loading…`
  // before the answer, which a cached folder never does.
  dirRow('shared').click();
  assert.ok(
    textsOf(root, 'files-name').includes('Loading…'),
    'the cached listing under the root must be gone',
  );
  await settle();
  assert.ok(byKey(root, `fdir:${PROJ}/shared/empty`) !== null);
});

// ---------------------------------------------------------------------------
// The classes, the tokens and the copy
// ---------------------------------------------------------------------------

test('every class the name row wears is styled, and the block is tokens only', () => {
  const [files] = mySections(['Files panel']);
  const css = stripComments((files as { body: string }).body);
  for (const rule of [
    /\.files-row\.is-new\s*\{/,
    /\.files-newname\s*\{/,
    /\.files-row\.is-newerr \.files-name\s*\{/,
  ]) {
    assert.match(css, rule, `the Files-panel section must carry ${rule.source}`);
  }
  // The input must not wear the base field's ground, border or padding: those
  // are what would make this row taller than every other one — and a row that
  // changed the panel's size would resize every PTY in the grid.
  const block = /\.files-newname\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(block, /background:\s*transparent/);
  assert.match(block, /border:\s*none/);
  assert.match(block, /padding:\s*0/);
  assert.match(block, /min-width:\s*0/);
  assert.match(block, /flex:\s*1/);
  // The FACE is the tree's, not the base `input` rule's mono: a name being
  // typed and the same name one repaint later must be one thing on one line.
  assert.match(block, /font-family:\s*inherit/);
  assert.match(block, /font-size:\s*12\.5px/);
  assert.match(
    stripComments(APP_CSS),
    /^input,\nselect,\n[\s\S]*?font-family: var\(--font-mono\);/m,
    'non-vacuity: the base input rule really does impose the mono face',
  );
  assert.equal(
    /(?:^|[\n;])\s*width:/.test(block),
    false,
    'a fixed width would change the panel s own — `min-width: 0` is the only width rule here',
  );
  // Tokens only: no colour literal in the three rules, and every token declared.
  const mine = [
    /\.files-row\.is-new\s*\{[^}]*\}/,
    /\.files-newname\s*\{[^}]*\}/,
    /\.files-row\.is-newerr \.files-name\s*\{[^}]*\}/,
  ]
    .map((re) => re.exec(css)?.[0] ?? '')
    .join('\n');
  assert.equal(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/.test(mine), false, `a colour literal: ${mine}`);
  const declared = declaredTokens();
  for (const t of usedTokens(mine)) assert.ok(declared.has(t), `undeclared token ${t}`);
  assert.ok(usedTokens(mine).length >= 2, `non-vacuity: ${usedTokens(mine).length} tokens read`);
  // Non-vacuity of the scanner itself.
  assert.match(APP_CSS, /\.files-row\s*\{/);
});

test('the classes the module sets and the classes the stylesheet knows are the same three', () => {
  for (const cls of ['files-row is-new', 'files-newname', 'files-row is-newerr']) {
    assert.ok(FILES_SRC.includes(`'${cls}'`), `ui/files.ts must build .${cls}`);
  }
});

test('nothing the name row says carries a path, a key name or a command', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  fx.failCreate();
  type('src');
  pressEnter();
  await settle();
  const said = [
    nameField().getAttribute('aria-label') ?? '',
    textsOf(errRow() as FakeElement, 'files-name')[0] ?? '',
  ];
  // Every client sentence too — they are constants, and this is the sweep that
  // keeps them one vocabulary with the rest of the panel.
  const sentences = [
    'Type a name first.',
    'A name cannot contain a slash.',
    'That name is not allowed.',
    'That name is too long.',
    'The app could not create it.',
  ];
  for (const s of [...said, ...sentences]) {
    assert.ok(s.length > 0, 'non-vacuity: an empty string proves nothing');
    assert.equal(/[/\\]/.test(s), false, `a path reached the panel: ${s}`);
    assert.equal(/ctrl\+|shift\+|\balt\b|F10/i.test(s), false, `a key name: ${s}`);
    assert.equal(
      /claude|explorer|windows|xterm|POST|HTTP/i.test(s),
      false,
      `a command or a product: ${s}`,
    );
  }
  for (const s of sentences) {
    assert.match(s, /^[A-Z].*\.$/, `a refusal is one plain sentence: ${s}`);
  }
  assert.ok(FILES_SRC.includes("'The app could not create it.'"), 'the app s own line lives here');
});
