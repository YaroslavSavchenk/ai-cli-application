/**
 * `web/src/ui/files.ts` — RENAMING a file or a folder from the Files panel
 * (Nocturne part B13, `.claude/plans/nocturne/PLAN-B13.md` § 2 Client, user
 * decisions D1–D4), driven through the REAL panel, the REAL row menu, the REAL
 * `ui/rename-model.ts` and the REAL `state.ts` on the DOM double in
 * `tests/fake-dom.ts`, against the fake `FsGateway` of `tests/fs-fixture.ts`.
 *
 * WHAT CAN GO SILENTLY WRONG, and is pinned here:
 *
 *   1. the two doors (F2 and the menu's `Rename`) disagreeing about a row — an
 *      anchor or a folder holding a project offered by one and not the other;
 *   2. the row opening somewhere else than in place, or with the extension
 *      selected, so typing a name throws the `.ts` away;
 *   3. a cancel that posts, a same-name Enter that posts, an Enter that posts
 *      twice;
 *   4. a refusal that eats the typed text, or a success that leaves open
 *      folders, the selection or a dirty editor tab on the OLD path (D3);
 *   5. F2 taken from a focused terminal.
 *
 * NOT claimed (browser work, `/verify-terminal`): that the row is legible, that
 * a real `<input>` shows the selection, that the note wraps without moving a
 * pane, and anything the server does with the request (`tests/fs-rename.test.ts`).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project, SessionInfo } from '../shared/protocol.ts';
import { byClass, byKey, dispatch, installDom, textsOf, type FakeElement } from './fake-dom.ts';
import { APP_CSS, declaredTokens, mySections, stripComments, usedTokens } from './tokens-helpers.ts';
import { FakeApiError, PROJ, makeFixture, settle } from './fs-fixture.ts';

const fx = makeFixture();
const dom = installDom();

const here = dirname(fileURLToPath(import.meta.url));
const FILES_SRC = readFileSync(join(here, '..', 'web', 'src', 'ui', 'files.ts'), 'utf8');
const MAIN_SRC = readFileSync(join(here, '..', 'web', 'src', 'main.ts'), 'utf8');
const API_SRC = readFileSync(join(here, '..', 'web', 'src', 'api.ts'), 'utf8');

type EditorTab =
  | { kind: 'file'; path: string }
  | { kind: 'diff'; hash: string; path: string; root: string };
interface EditorSlot {
  kind: 'editor';
  id: string;
  tabs: EditorTab[];
  active: number;
}
interface ViewLike {
  id: string;
  root: unknown;
  slots: unknown[];
  focused: number;
}
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
  newEditorSlot(tabs: EditorTab[]): EditorSlot;
  editorFileId(path: string): string;
}
interface FilesModule {
  initFilesPanel(host: unknown, onLeaveScreen: () => void, fs: unknown): { render(): void };
}
interface MenuModule {
  isRowMenuOpen(): boolean;
  closeRowMenu(): void;
}
interface RenameModel {
  RENAME_FAILED_TEXT: string;
  RENAME_SESSION_NOTE: string;
  RENAME_UNSAVED_TAKEN: string;
}

const st = (await import(new URL('../web/src/state.ts', import.meta.url).href)) as StateModule;
const F = (await import(new URL('../web/src/ui/files.ts', import.meta.url).href)) as FilesModule;
const CM = (await import(new URL('../web/src/ui/context-menu.ts', import.meta.url).href)) as MenuModule;
const RM = (await import(new URL('../web/src/ui/rename-model.ts', import.meta.url).href)) as RenameModel;

/** A terminal pane: `.pane` + `.term-host` + xterm's helper textarea. */
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

/** Every key that reaches the window — "the row spent it" means none do. */
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
function project(id: string, name: string, path = `/work/${name}`): Project {
  return { id, name, path, createdAt: new Date().toISOString() } as Project;
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

const dirRow = (rel: string): FakeElement | null => byKey(root, `fdir:${PROJ}/${rel}`);
const fileRow = (rel: string): FakeElement | null => byKey(root, `ffile:${PROJ}/${rel}`);
const rows = (): FakeElement[] => byClass(root, 'files-row');
const newRow = (): FakeElement | undefined => byClass(root, 'is-new')[0];
const errRow = (): FakeElement | undefined => byClass(root, 'is-newerr')[0];
const noteRow = (): FakeElement | undefined => byClass(root, 'is-newnote')[0];
const nameField = (): FakeElement => byClass(root, 'files-newname')[0] as FakeElement;
const labels = (): string[] => textsOf(dom.body, 'cm-label');
const items = (): FakeElement[] => byClass(dom.body, 'cm-item');

function rightClick(el: FakeElement): void {
  dispatch(el, 'contextmenu', { clientX: 40, clientY: 120 });
}
function activate(label: string): void {
  const list = items();
  const i = list.findIndex((b) => textsOf(b, 'cm-label')[0] === label);
  assert.notEqual(i, -1, `no entry called ${label}: ${labels().join(', ')}`);
  for (let step = 0; step < i; step += 1) {
    dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: 'ArrowDown' });
  }
  dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: 'Enter' });
}
function choose(on: FakeElement, label: string): void {
  rightClick(on);
  activate(label);
}
/** F2 on a row, the keyboard's way: focus it, then press. */
function f2(on: FakeElement, init: Record<string, unknown> = {}): ReturnType<typeof dispatch> {
  on.focus();
  return dispatch(on, 'keydown', { key: 'F2', ...init });
}
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

async function liveSession(extra: Project[] = []): Promise<void> {
  st.setProjects([project('p1', 'api'), project('p2', 'tools'), ...extra]);
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
  fx.renameCalls.length = 0;
  fx.entryCalls.length = 0;
  winKeys.length = 0;
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
// Opening the row: two doors, one row, in place
// ---------------------------------------------------------------------------

test('F2 on a file row opens the name row IN PLACE, pre-filled, with the STEM selected', async () => {
  await liveSession();
  const before = rows();
  const at = before.indexOf(fileRow('README.md') as FakeElement);
  const indent = (fileRow('README.md') as FakeElement).style.paddingLeft;
  const e = f2(fileRow('README.md') as FakeElement);
  assert.equal(e.defaultPrevented, true, 'the key is spent');
  assert.deepEqual(winKeys, [], 'and stopped: nothing behind the panel reads it');
  const row = newRow() as FakeElement;
  assert.ok(row !== undefined, 'a name row');
  assert.equal(byClass(root, 'is-new').length, 1);
  assert.equal(fileRow('README.md'), null, 'the row itself is replaced, not duplicated');
  assert.equal(rows().indexOf(row), at, 'at the same place in the tree');
  assert.equal(rows().length, before.length, 'nothing added, nothing moved');
  assert.equal(row.style.paddingLeft, indent, 'at the same indent');
  const input = nameField();
  assert.equal(input.value, 'README.md');
  assert.equal(input.getAttribute('aria-label'), 'new name for file');
  assert.equal(dom.doc.activeElement, input, 'it has the keyboard');
  assert.deepEqual([input.selectionStart, input.selectionEnd], [0, 6], 'README selected, .md kept');
  // The kind's own mark, not the create row's plain glyph.
  assert.equal(byClass(row, 'files-icon').length, 1);
  assert.equal(byClass(row, 'files-folder').length, 0);
});

test('the menu s Rename on a folder opens the same row, with the WHOLE name selected', async () => {
  await liveSession();
  const at = rows().indexOf(dirRow('server') as FakeElement);
  choose(dirRow('server') as FakeElement, 'Rename');
  assert.equal(dirRow('server'), null);
  const row = newRow() as FakeElement;
  assert.equal(rows().indexOf(row), at);
  const input = nameField();
  assert.equal(input.value, 'server');
  assert.equal(input.getAttribute('aria-label'), 'new name for folder');
  assert.equal(dom.doc.activeElement, input);
  assert.deepEqual([input.selectionStart, input.selectionEnd], [0, 6]);
  assert.equal(byClass(row, 'files-folder').length, 1, 'a folder wears the folder mark');
  assert.equal(fx.renameCalls.length, 0, 'opening the row asks nothing');
});

test('Rename sits directly above Delete in the row menu', async () => {
  await liveSession();
  rightClick(fileRow('README.md') as FakeElement);
  const l = labels();
  assert.equal(l[l.length - 1], 'Delete');
  assert.equal(l[l.length - 2], 'Rename');
});

test('the stem is selected on the FIRST focus only — a repaint puts back what the user had', async () => {
  await liveSession();
  f2(fileRow('README.md') as FakeElement);
  const input = nameField();
  input.setSelectionRange(3, 3);
  type('READ.md');
  // A repaint that has nothing to do with the row: a listing lands.
  (dirRow('web') as FakeElement).click();
  await settle();
  const fresh = nameField();
  assert.equal(fresh.value, 'READ.md', 'the typed text survived the rebuild');
  assert.equal(dom.doc.activeElement, fresh, 'and the keyboard with it');
  assert.deepEqual([fresh.selectionStart, fresh.selectionEnd], [3, 3], 'not re-selected');
});

// ---------------------------------------------------------------------------
// The cancels
// ---------------------------------------------------------------------------

test('Escape cancels: no request, the row is back, and the keyboard is on it', async () => {
  await liveSession();
  f2(fileRow('README.md') as FakeElement);
  type('other.md');
  const e = pressEscape(nameField());
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(winKeys, [], 'one effect per press: the ladder never saw it');
  assert.equal(newRow(), undefined);
  assert.ok(fileRow('README.md') !== null, 'the row is drawn again under its old name');
  assert.equal(dom.doc.activeElement, fileRow('README.md'));
  assert.equal(fx.renameCalls.length, 0);
});

test('blur cancels, never commits, and leaves the keyboard where the user put it', async () => {
  await liveSession();
  f2(fileRow('README.md') as FakeElement);
  type('other.md');
  termInput.focus();
  nameField().blur();
  // `blur()` on the fake only fires when the field still holds the focus, so
  // fire it the way the browser does when the focus has already moved.
  dispatch(nameField() ?? termInput, 'blur');
  await settle();
  assert.equal(newRow(), undefined, 'the row is gone');
  assert.equal(fx.renameCalls.length, 0, 'and nothing was posted');
  assert.equal(dom.doc.activeElement, termInput, 'the terminal keeps the keyboard');
});

test('any menu opening cancels it', async () => {
  await liveSession();
  f2(fileRow('README.md') as FakeElement);
  type('half');
  rightClick(dirRow('web') as FakeElement);
  assert.equal(newRow(), undefined);
  assert.ok(fileRow('README.md') !== null);
  assert.equal(fx.renameCalls.length, 0);
});

test('ONE name row at a time: New file after F2 replaces the rename, and F2 replaces a create', async () => {
  await liveSession();
  f2(fileRow('README.md') as FakeElement);
  choose(dirRow('web') as FakeElement, 'New file');
  assert.equal(byClass(root, 'is-new').length, 1);
  assert.equal(nameField().getAttribute('aria-label'), 'new file name');
  assert.ok(fileRow('README.md') !== null, 'the renamed row is back');
  f2(fileRow('LICENSE') as FakeElement);
  assert.equal(byClass(root, 'is-new').length, 1);
  assert.equal(nameField().getAttribute('aria-label'), 'new name for file');
  assert.equal(nameField().value, 'LICENSE');
});

// ---------------------------------------------------------------------------
// Enter
// ---------------------------------------------------------------------------

test('the SAME name sends nothing: the row closes and the keyboard is back on it', async () => {
  await liveSession();
  f2(fileRow('README.md') as FakeElement);
  pressEnter();
  await settle();
  assert.equal(fx.renameCalls.length, 0);
  assert.equal(newRow(), undefined);
  assert.equal(dom.doc.activeElement, fileRow('README.md'));
});

test('a client rule refuses under the input and costs no request', async () => {
  await liveSession();
  f2(fileRow('README.md') as FakeElement);
  type('a/b');
  pressEnter();
  assert.equal(fx.renameCalls.length, 0);
  assert.deepEqual(textsOf(errRow() as FakeElement, 'files-name'), ['A name cannot contain a slash.']);
  assert.equal(nameField().value, 'a/b', 'the text stays');
  assert.equal(dom.doc.activeElement, nameField());
});

test('a TAKEN name: the server s 409 sentence under the input, the text kept, nothing moved', async () => {
  await liveSession();
  fx.renameFails = new FakeApiError(409, 'Something with that name already exists here.');
  f2(fileRow('README.md') as FakeElement);
  type('LICENSE');
  pressEnter();
  await settle();
  assert.deepEqual(fx.renameCalls, [{ path: `${PROJ}/README.md`, name: 'LICENSE' }]);
  assert.deepEqual(textsOf(errRow() as FakeElement, 'files-name'), [
    'Something with that name already exists here.',
  ]);
  assert.equal(nameField().value, 'LICENSE', 'the typed text stays');
  assert.equal(nameField().readOnly, false, 'and can be edited again');
  assert.equal(dom.doc.activeElement, nameField(), 'with the keyboard in it');
  // The refusal is ONE row under the input, not a dialog.
  assert.equal(byClass(dom.body, 'modal-scrim').length, 0);
});

test('a failure with no sentence of its own reads the app s own line', async () => {
  await liveSession();
  fx.renameFails = new FakeApiError(500, 'HTTP 500');
  f2(fileRow('README.md') as FakeElement);
  type('X.md');
  pressEnter();
  await settle();
  assert.deepEqual(textsOf(errRow() as FakeElement, 'files-name'), [RM.RENAME_FAILED_TEXT]);
});

test('Enter while the request is out posts nothing more, and the field is read-only', async () => {
  await liveSession();
  fx.holdRename();
  f2(fileRow('README.md') as FakeElement);
  type('X.md');
  pressEnter();
  assert.equal(nameField().readOnly, true);
  assert.ok((newRow() as FakeElement).classList.contains('is-busy'));
  pressEnter();
  assert.equal(fx.renameCalls.length, 1);
  fx.releaseRename();
  await settle();
});

test('success: ONE request, the parent refetched ONCE, and the new row selected and focused', async () => {
  await liveSession();
  f2(fileRow('web/DESIGN.md') as FakeElement);
  type('NOTES.md');
  pressEnter();
  await settle();
  assert.deepEqual(fx.renameCalls, [{ path: `${PROJ}/web/DESIGN.md`, name: 'NOTES.md' }]);
  assert.deepEqual(fx.entryCalls, [`${PROJ}/web`], 'the parent, once, and nothing else');
  assert.equal(newRow(), undefined, 'the name row is gone');
  assert.equal(fileRow('web/DESIGN.md'), null, 'the old name left the tree');
  const made = fileRow('web/NOTES.md') as FakeElement;
  assert.ok(made !== null, 'the listing brought the new name');
  assert.ok(made.classList.contains('is-sel'), 'it is the selection');
  assert.equal(dom.doc.activeElement, made, 'and it has the keyboard');
});

test('a renamed folder comes back OPEN, with the folders open under it still open', async () => {
  await liveSession();
  assert.ok(fileRow('web/src/App.tsx') !== null, 'non-vacuity: web/src is open');
  choose(dirRow('web') as FakeElement, 'Rename');
  type('site');
  pressEnter();
  await settle();
  assert.deepEqual(fx.entryCalls, [PROJ], 'only the parent (the root) is re-read');
  assert.equal(dirRow('web'), null);
  assert.equal((dirRow('site') as FakeElement).getAttribute('aria-expanded'), 'true');
  assert.equal((dirRow('site/src') as FakeElement).getAttribute('aria-expanded'), 'true');
  assert.ok(fileRow('site/src/App.tsx') !== null, 'its rows are there, from the moved cache');
  assert.equal(dom.doc.activeElement, dirRow('site'));
});

test('a selection under a renamed folder follows it', async () => {
  await liveSession();
  (fileRow('web/src/App.tsx') as FakeElement).focus();
  dispatch(fileRow('web/src/App.tsx') as FakeElement, 'keydown', { key: ' ', ctrlKey: true });
  (fileRow('web/package.json') as FakeElement).focus();
  dispatch(fileRow('web/package.json') as FakeElement, 'keydown', { key: ' ', ctrlKey: true });
  assert.ok((fileRow('web/src/App.tsx') as FakeElement).classList.contains('is-sel'));
  f2(dirRow('web') as FakeElement);
  type('site');
  pressEnter();
  await settle();
  // The renamed row becomes THE selection (it is what the user just acted on);
  // the old keys are gone, not left naming a place that is not there.
  const sel = rows().filter((r) => r.classList.contains('is-sel'));
  assert.deepEqual(sel.map((r) => r.getAttribute('data-k')), [`fdir:${PROJ}/site`]);
});

test('an answer that lands after a cancel still moves what is keyed by the old path', async () => {
  await liveSession();
  fx.holdRename();
  choose(dirRow('web') as FakeElement, 'Rename');
  type('site');
  pressEnter();
  rightClick(dirRow('server') as FakeElement); // a menu cancels the row
  CM.closeRowMenu();
  fx.releaseRename();
  await settle();
  assert.equal(dom.doc.activeElement === dirRow('site'), false, 'no focus is stolen');
  assert.equal((dirRow('site') as FakeElement).getAttribute('aria-expanded'), 'true');
  assert.equal((dirRow('site/src') as FakeElement).getAttribute('aria-expanded'), 'true');
});

// ---------------------------------------------------------------------------
// Who may be renamed (D2) — both doors, one predicate
// ---------------------------------------------------------------------------

test('a project root and a folder that HOLDS a project: no Rename, and F2 does nothing', async () => {
  await liveSession([project('p3', 'srv', `${PROJ}/server`), project('p4', 'ui', `${PROJ}/web/src`)]);
  for (const rel of ['server', 'web', 'web/src']) {
    // Looked up FRESH each time: a right-click repaints the tree, and a key
    // pressed on a detached row reaches no listener at all (a vacuous pass).
    rightClick(dirRow(rel) as FakeElement);
    assert.equal(labels().includes('Rename'), false, `${rel}: ${labels().join(', ')}`);
    CM.closeRowMenu();
    const row = dirRow(rel) as FakeElement;
    assert.ok(row.isConnected, 'non-vacuity: the row is on screen');
    const e = f2(row);
    assert.equal(e.defaultPrevented, false, 'the key is not spent');
    assert.equal(newRow(), undefined, 'and no row opens');
  }
  // Non-vacuity: a plain sibling folder IS renamable by both doors.
  rightClick(dirRow('launcher') as FakeElement);
  assert.ok(labels().includes('Rename'));
  CM.closeRowMenu();
  f2(dirRow('launcher') as FakeElement);
  assert.ok(newRow() !== undefined);
});

test('a MULTI-selection has no Rename entry; F2 renames the focused row alone', async () => {
  await liveSession();
  (fileRow('README.md') as FakeElement).click();
  dispatch(fileRow('LICENSE') as FakeElement, 'click', { ctrlKey: true });
  rightClick(fileRow('LICENSE') as FakeElement);
  assert.equal(labels().includes('Rename'), false, labels().join(', '));
  assert.ok(labels().includes('Delete'), 'non-vacuity: this IS the row menu');
  CM.closeRowMenu();
  f2(fileRow('LICENSE') as FakeElement);
  assert.equal(nameField().value, 'LICENSE');
  assert.equal(byClass(root, 'is-new').length, 1);
});

test('F2 with a TERMINAL focused is left for the PTY — not prevented, no row', async () => {
  await liveSession();
  termInput.focus();
  const e = dispatch(termInput, 'keydown', { key: 'F2' });
  assert.equal(e.defaultPrevented, false);
  assert.equal(newRow(), undefined);
  assert.deepEqual(winKeys, ['F2'], 'it travels on untouched');
});

test('F2 with a modifier is not the rename key', async () => {
  await liveSession();
  for (const mod of ['ctrlKey', 'altKey', 'shiftKey']) {
    const e = f2(fileRow('README.md') as FakeElement, { [mod]: true });
    assert.equal(e.defaultPrevented, false, mod);
    assert.equal(newRow(), undefined, mod);
  }
});

test('F2 while a dialog is up is not the panel s: not prevented, no row (test gate)', async () => {
  await liveSession();
  const scrim = dom.doc.createElement('div');
  scrim.className = 'modal-scrim';
  dom.body.append(scrim);
  try {
    const e = f2(fileRow('README.md') as FakeElement);
    assert.equal(e.defaultPrevented, false);
    assert.equal(newRow(), undefined);
  } finally {
    scrim.remove();
  }
  // Non-vacuity: the same F2 with the dialog gone opens the row.
  const e = f2(fileRow('README.md') as FakeElement);
  assert.equal(e.defaultPrevented, true);
  assert.notEqual(newRow(), undefined);
});

test('F2 on the Changes tab or the tab strip does nothing', async () => {
  await liveSession();
  const filesTab = byKey(root, 'ftab:files') as FakeElement;
  const e = f2(filesTab);
  assert.equal(e.defaultPrevented, false);
  assert.equal(newRow(), undefined);
});

// ---------------------------------------------------------------------------
// D4: a session working inside the folder
// ---------------------------------------------------------------------------

test('D4: a folder with a live session inside gets the note; a file and an idle folder do not', async () => {
  await liveSession();
  st.setSessions([
    mkSession('s1', { projectId: 'p1' }),
    mkSession('s2', { projectId: 'p2' }),
    mkSession('s3', { cwd: `${PROJ}/web/src` }),
    mkSession('s4', { cwd: `${PROJ}/launcher`, status: 'exited' }),
  ]);
  focusSession('s1');
  panel.render();
  await settle();
  f2(dirRow('web') as FakeElement);
  assert.deepEqual(textsOf(noteRow() as FakeElement, 'files-name'), [RM.RENAME_SESSION_NOTE]);
  assert.equal(errRow(), undefined, 'a note, not a refusal');
  pressEscape(nameField());
  f2(dirRow('launcher') as FakeElement);
  assert.equal(noteRow(), undefined, 'an EXITED session is not working anywhere');
  pressEscape(nameField());
  f2(fileRow('web/src/App.tsx') as FakeElement);
  assert.equal(noteRow(), undefined, 'a file has no session inside it');
  pressEscape(nameField());
  // A prefix sibling is not inside: `server` vs a session in `server2`.
  st.setSessions([mkSession('s1', { projectId: 'p1' }), mkSession('s5', { cwd: `${PROJ}/server2` })]);
  focusSession('s1');
  panel.render();
  await settle();
  f2(dirRow('server') as FakeElement);
  assert.equal(noteRow(), undefined);
});

// ---------------------------------------------------------------------------
// D3: editor tabs follow
// ---------------------------------------------------------------------------

test('D3: a DIRTY file tab follows a file rename and a folder rename with its text; a diff tab does not', async () => {
  await liveSession();
  const v = st.state.views.find((x) => x.id === st.state.activeViewId) as ViewLike;
  const design = `${PROJ}/web/DESIGN.md`;
  const app = `${PROJ}/web/src/App.tsx`;
  const diff: EditorTab = { kind: 'diff', hash: 'a'.repeat(40), path: 'web/src/App.tsx', root: PROJ };
  v.slots.push(st.newEditorSlot([{ kind: 'file', path: design }, { kind: 'file', path: app }, diff]));
  st.state.edits.set(st.editorFileId(design), 'typed in design\n');
  st.state.edits.set(st.editorFileId(app), 'typed in app\n');
  panel.render();

  f2(fileRow('web/DESIGN.md') as FakeElement);
  type('NOTES.md');
  pressEnter();
  await settle();
  const slot = v.slots[v.slots.length - 1] as EditorSlot;
  assert.deepEqual(slot.tabs[0], { kind: 'file', path: `${PROJ}/web/NOTES.md` });
  assert.equal(st.state.edits.get(st.editorFileId(`${PROJ}/web/NOTES.md`)), 'typed in design\n');
  assert.equal(st.state.edits.has(st.editorFileId(design)), false, 'nothing left on the old id');

  f2(dirRow('web') as FakeElement);
  type('site');
  pressEnter();
  await settle();
  const after = (v.slots[v.slots.length - 1] as EditorSlot).tabs;
  assert.deepEqual(after, [
    { kind: 'file', path: `${PROJ}/site/NOTES.md` },
    { kind: 'file', path: `${PROJ}/site/src/App.tsx` },
    diff,
  ]);
  assert.equal(st.state.edits.get(st.editorFileId(`${PROJ}/site/NOTES.md`)), 'typed in design\n');
  assert.equal(st.state.edits.get(st.editorFileId(`${PROJ}/site/src/App.tsx`)), 'typed in app\n');
  assert.equal(st.state.edits.size, 2, 'every text moved, none duplicated');
});

test('B4: unsaved text already open AT the new name is never overwritten — refused before any request', async () => {
  await liveSession();
  // A tab still open on a file deleted outside the app, holding typed text.
  const ghost = `${PROJ}/NEW.md`;
  st.state.edits.set(st.editorFileId(ghost), 'ghost text\n');
  st.state.edits.set(st.editorFileId(`${PROJ}/README.md`), 'readme text\n');
  f2(fileRow('README.md') as FakeElement);
  type('NEW.md');
  pressEnter();
  await settle();
  assert.equal(fx.renameCalls.length, 0, 'nothing was sent');
  assert.deepEqual(textsOf(errRow() as FakeElement, 'files-name'), [RM.RENAME_UNSAVED_TAKEN]);
  assert.equal(nameField().value, 'NEW.md', 'the typed text stays');
  assert.equal(dom.doc.activeElement, nameField());
  assert.equal(st.state.edits.get(st.editorFileId(ghost)), 'ghost text\n');
  assert.equal(st.state.edits.get(st.editorFileId(`${PROJ}/README.md`)), 'readme text\n');
  // Another name is fine.
  type('OTHER.md');
  pressEnter();
  await settle();
  assert.deepEqual(fx.renameCalls, [{ path: `${PROJ}/README.md`, name: 'OTHER.md' }]);
});

test('B4: a FOLDER rename onto a name with unsaved text UNDER it is refused too', async () => {
  await liveSession();
  st.state.edits.set(st.editorFileId(`${PROJ}/site/src/a.ts`), 'deep text\n');
  f2(dirRow('web') as FakeElement);
  type('site');
  pressEnter();
  await settle();
  assert.equal(fx.renameCalls.length, 0);
  assert.deepEqual(textsOf(errRow() as FakeElement, 'files-name'), [RM.RENAME_UNSAVED_TAKEN]);
  // A prefix sibling is not "under": `sit` is allowed.
  type('sit');
  pressEnter();
  await settle();
  assert.equal(fx.renameCalls.length, 1);
});

test('a rename opened on a CHILD while its folder s rename was in flight sends the path that exists now', async () => {
  await liveSession();
  fx.holdRename();
  choose(dirRow('web') as FakeElement, 'Rename');
  type('site');
  pressEnter();
  // A second rename, on a row inside the folder that is being renamed.
  f2(fileRow('web/src/App.tsx') as FakeElement);
  assert.equal(nameField().value, 'App.tsx');
  fx.releaseRename();
  await settle();
  assert.ok(newRow() !== undefined, 'the second name row survived the folder moving');
  assert.equal(nameField().value, 'App.tsx');
  assert.equal(dom.doc.activeElement, nameField(), 'with the keyboard in it');
  type('Main.tsx');
  pressEnter();
  await settle();
  assert.deepEqual(fx.renameCalls, [
    { path: `${PROJ}/web`, name: 'site' },
    { path: `${PROJ}/site/src/App.tsx`, name: 'Main.tsx' },
  ]);
  assert.ok(fileRow('site/src/Main.tsx') !== null);
});

// ---------------------------------------------------------------------------
// Wiring, style and copy
// ---------------------------------------------------------------------------

test('the gateway, the api call and main.ts agree on one rename', () => {
  assert.match(FILES_SRC, /rename\(path: string, name: string\): Promise<FsRenameResponse>;/);
  assert.match(MAIN_SRC, /rename: api\.fsRename,/);
  assert.match(API_SRC, /export function fsRename\(path: string, name: string\)/);
  assert.match(API_SRC, /'\/api\/fs\/rename'/);
  // F2 lives on the panel's own listener only — nothing binds it globally.
  assert.equal(/'F2'/.test(MAIN_SRC), false, 'main.ts must not bind F2');
});

test('the note row is styled with tokens only and never changes a width', () => {
  const [files] = mySections(['Files panel']);
  const css = stripComments((files as { body: string }).body);
  const block = /\.files-row\.is-newnote\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.ok(block !== '', 'the Files-panel section styles .is-newnote');
  assert.equal(/(?:^|[\n;])\s*width:/.test(block), false, 'no width of its own');
  const mine = [
    /\.files-row\.is-newnote\s*\{[^}]*\}/,
    /\.files-row\.is-newnote \.files-name\s*\{[^}]*\}/,
  ]
    .map((re) => re.exec(css)?.[0] ?? '')
    .join('\n');
  assert.equal(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/.test(mine), false, mine);
  const declared = declaredTokens();
  for (const t of usedTokens(mine)) assert.ok(declared.has(t), `undeclared token ${t}`);
  assert.ok(usedTokens(mine).length >= 2);
  assert.ok(APP_CSS.includes('.files-row.is-newnote'), 'non-vacuity');
});

test('nothing the rename row says carries a path, a key name or a command', async () => {
  await liveSession();
  fx.renameFails = new FakeApiError(409, 'Something with that name already exists here.');
  f2(fileRow('README.md') as FakeElement);
  type('LICENSE');
  pressEnter();
  await settle();
  const said = [
    nameField().getAttribute('aria-label') ?? '',
    textsOf(errRow() as FakeElement, 'files-name')[0] ?? '',
    RM.RENAME_FAILED_TEXT,
    RM.RENAME_SESSION_NOTE,
    'new name for folder',
  ];
  for (const s of said) {
    assert.ok(s.length > 0);
    assert.equal(/[/\\]/.test(s), false, `a path: ${s}`);
    assert.equal(/ctrl\+|shift\+|\balt\b|F2|F10/i.test(s), false, `a key name: ${s}`);
    assert.equal(/claude|explorer|windows|xterm|POST|HTTP/i.test(s), false, `a command: ${s}`);
  }
});
