/**
 * MANY rows chosen, and a permanent DELETE (Nocturne part B10a, user decision
 * 2026-09-20, `memory/decisions/b10a-multi-select-and-delete.md`) — driven
 * through the REAL `web/src/ui/files.ts`, the REAL `ui/context-menu.ts`, the
 * REAL `ui/delete-dialog.ts` and the REAL `ui/statusline.ts` on the DOM double,
 * against the fake `FsGateway` of `tests/helpers/fs-fixture.ts`.
 *
 * WHY THIS FILE EXISTS. Delete is the app's first act with no way back: no
 * trash, no undo, and one confirmation between a keystroke and gone bytes.
 * Every way it can go wrong is silent and expensive —
 *
 *   - a gesture that acts on MORE rows than the question counted;
 *   - a selection that keeps a row the user cannot see, or drops one they can;
 *   - a Delete key that fires while a copy is still writing the same folders;
 *   - a second Delete that starts before the first answer, so an index-keyed
 *     answer is matched against the wrong list of items;
 *   - a tree that removes rows optimistically and hides a failure;
 *   - a confirmation that can be answered by the Enter key it opened under.
 *
 * The pure rules are pinned next door (`tests/ui/ui-delete-model.test.ts`,
 * `tests/ui/ui-files-select-model.test.ts`, `tests/ui/ui-context-menu-model.test.ts`);
 * this file pins the PLUMBING — that the panel really calls them, really sends
 * what the question promised, and really says what happened.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`): that
 * the chosen rows are legible, that the dialog is readable, that a real Enter
 * activates a `<button>` (the fake DOM has no activation behaviour), and
 * screen-reader output.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project, SessionInfo } from '../../shared/protocol.ts';
import { byClass, byKey, dispatch, installDom, FakeElement } from '../helpers/fake-dom.ts';
import {
  FakeApiError,
  PROJ,
  SCRATCH,
  makeFixture,
  settle,
  type DeleteResult,
  type Gateway,
} from '../helpers/fs-fixture.ts';

const fx = makeFixture();
const dom = installDom();

const here = dirname(fileURLToPath(import.meta.url));
/** main.ts bootstraps the whole app on import, so its wiring is read as source. */
const MAIN = readFileSync(join(here, '..', '..', 'web', 'src', 'main.ts'), 'utf8');

const st = (await import(new URL('../../web/src/state.ts', import.meta.url).href)) as StateModule;
const F = (await import(new URL('../../web/src/ui/files.ts', import.meta.url).href)) as FilesModule;
const FD = (await import(new URL('../../web/src/ui/filedrop.ts', import.meta.url).href)) as {
  initFileDrop(deps: Record<string, unknown>): void;
};
const DD = (await import(new URL('../../web/src/ui/delete-dialog.ts', import.meta.url).href)) as {
  isDeleteDialogOpen(): boolean;
  deleteDialogEscape(): void;
};
const DROP = (await import(new URL('../../web/src/ui/drop-dialog.ts', import.meta.url).href)) as {
  openDropDialog(req: Record<string, unknown>): void;
  dropDialogEscape(): void;
  isDropRunning(): boolean;
};
const SL = (await import(new URL('../../web/src/ui/statusline.ts', import.meta.url).href)) as {
  initStatusline(container: unknown, deps: { openShortcuts(): void }): { render(): void };
};

interface StateModule {
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
interface Dest {
  path: string;
  name: string;
}
interface FilesModule {
  initFilesPanel(host: unknown, onLeaveScreen: () => void, fs: Gateway): { render(): void };
  pasteDestination(): Dest | null;
  selectedFolder(): Dest | null;
  filesPanelDestination(): Dest | null;
  destinationOfActiveView(): Dest | null;
  destinationOfPane(paneEl: unknown): unknown;
  listingFor(dest: Dest): Promise<readonly string[]>;
}

const host = dom.doc.createElement('aside');
host.className = 'drawer files-panel';
dom.body.append(host);
const panel = F.initFilesPanel(host, () => {}, fx.gateway);
const root = host.children[0] as FakeElement;
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
const statusHost = dom.doc.createElement('div');
dom.body.append(statusHost);
SL.initStatusline(statusHost, { openShortcuts: () => {} });
dom.win.intervals.length = 0;

function flashText(): string {
  return byClass(statusHost, 'status-flash')[0]?.textContent ?? '';
}

/**
 * Wait for a CONDITION, with a bound — never for a duration. A batch the size
 * of the cap runs a hundred awaits in sequence, which is more turns than one
 * `settle()` drains; a `sleep` here would be the flaky test this suite refuses.
 */
async function until(done: () => boolean, passes = 200): Promise<void> {
  for (let i = 0; i < passes && !done(); i += 1) await settle();
}

/** Fire every recorded timer, which is what takes a flash back down. */
function clearFlash(): void {
  const due = [...dom.win.timers];
  dom.win.timers.length = 0;
  for (const t of due) t.fn();
}

// ---------------------------------------------------------------------------
// The world: a project tab, and a SECOND project registered inside its tree
// (`/work/api/shared`) — the anchor a row may never delete.
// ---------------------------------------------------------------------------

const ANCHOR = `${PROJ}/shared`;

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

async function liveSession(): Promise<void> {
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
async function expand(...rels: string[]): Promise<void> {
  for (const rel of rels) {
    const r = dirRow(rel);
    if (r === null || r.getAttribute('aria-expanded') === 'true') continue;
    r.click();
    await settle();
  }
  dispatch(root, 'keydown', { key: 'Escape' });
}

const dirRow = (rel: string): FakeElement => byKey(root, `fdir:${PROJ}/${rel}`) as FakeElement;
const fileRow = (rel: string): FakeElement => byKey(root, `ffile:${PROJ}/${rel}`) as FakeElement;
const body = (): FakeElement => byClass(root, 'files-body')[0] as FakeElement;

/** The chosen rows, by key with the root's prefix cut, in tree order. */
function chosen(): string[] {
  return byClass(root, 'is-sel').map((n) =>
    (n.getAttribute('data-k') ?? '').replace(`:${PROJ}/`, ':'),
  );
}

/** Every row the tree is drawing right now, same shortened keys. */
function rowKeys(): string[] {
  return byClass(root, 'files-row')
    .map((n) => n.getAttribute('data-k') ?? '')
    .filter((k) => k.startsWith('fdir:') || k.startsWith('ffile:'))
    .map((k) => k.replace(`:${PROJ}/`, ':'));
}

// ---- the menu -------------------------------------------------------------

const rightClick = (el: FakeElement): void => {
  dispatch(el, 'contextmenu', { clientX: 10, clientY: 10 });
};
const menuBox = (): FakeElement | undefined => byClass(dom.body, 'cm-menu')[0];
const menuItems = (): FakeElement[] => byClass(dom.body, 'cm-item');
const menuLabels = (): string[] => menuItems().map((b) => byClass(b, 'cm-label')[0]?.textContent ?? '');
function menuEntry(label: string): FakeElement {
  const hit = menuItems().find((b) => byClass(b, 'cm-label')[0]?.textContent === label);
  assert.ok(hit !== undefined, `the menu must carry ${label}: ${menuLabels().join(', ')}`);
  return hit;
}

// ---- the dialog -----------------------------------------------------------

const dialog = (): FakeElement | undefined => byClass(dom.body, 'dd-modal')[0];
const dialogTitle = (): string => byClass(dom.body, 'dd-title')[0]?.textContent ?? '';
const dialogSub = (): string | null => byClass(dom.body, 'dd-sub')[0]?.textContent ?? null;
function dialogButton(label: string): FakeElement {
  const hit = byClass(dom.body, 'dd-ft')[0]
    ?.children.filter((c): c is FakeElement => c instanceof FakeElement)
    .find((b) => b.textContent === label);
  assert.ok(hit !== undefined, `the dialog must carry ${label}`);
  return hit;
}

/** Open the row menu on a row and choose `Delete` — the pointer path. */
function deleteFromMenu(row: FakeElement): void {
  rightClick(row);
  menuEntry('Delete').click();
}

/** The Delete KEY, pressed wherever the keyboard is standing. */
function pressDelete(target: FakeElement = root): ReturnType<typeof dispatch> {
  return dispatch(target, 'keydown', { key: 'Delete' });
}

beforeEach(async () => {
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
});

// ---------------------------------------------------------------------------
// Choosing many rows
// ---------------------------------------------------------------------------

test('ctrl+click ADDS a row and does not open or toggle it; a plain click replaces everything', async () => {
  await liveSession();
  fileRow('README.md').click();
  assert.deepEqual(chosen(), ['ffile:README.md']);

  const web = dirRow('web');
  const openBefore = web.getAttribute('aria-expanded');
  dispatch(web, 'click', { ctrlKey: true });
  assert.deepEqual(sorted(chosen()), ['fdir:web', 'ffile:README.md']);
  assert.equal(
    dirRow('web').getAttribute('aria-expanded'),
    openBefore,
    'ctrl+click chooses; it does not open or close the folder under the pointer',
  );

  // The same row again takes it back OUT, and the rest is untouched.
  dispatch(dirRow('web'), 'click', { ctrlKey: true });
  assert.deepEqual(chosen(), ['ffile:README.md']);

  // A plain click is how a multi-selection is thrown away.
  dispatch(dirRow('server'), 'click', { ctrlKey: true });
  assert.equal(chosen().length, 2);
  fileRow('LICENSE').click();
  assert.deepEqual(chosen(), ['ffile:LICENSE']);
});

/** Sorted copy, for the assertions that do not care about tree order. */
function sorted(xs: readonly string[]): string[] {
  return [...xs].sort();
}

test('shift+click takes the whole run between the anchor and the row, and opens nothing', async () => {
  await liveSession();
  // The anchor is set with ctrl+click, so the tree is not collapsed under the
  // gesture and `visible` is the same list at both ends of the range.
  dispatch(dirRow('web'), 'click', { ctrlKey: true });
  const keys = rowKeys();
  const from = keys.indexOf('fdir:web');
  const to = keys.indexOf('fdir:server');
  assert.ok(from !== -1 && to !== -1 && to > from, `non-vacuity: ${keys.join(', ')}`);
  const expanded = dirRow('web').getAttribute('aria-expanded');

  dispatch(dirRow('server'), 'click', { shiftKey: true });
  assert.deepEqual(chosen(), keys.slice(from, to + 1), 'the whole run, in tree order');
  assert.equal(
    dirRow('web').getAttribute('aria-expanded'),
    expanded,
    'a range must not toggle the folder at either end',
  );

  // A second shift+click re-measures from the SAME anchor rather than growing.
  dispatch(fileRow('README.md'), 'click', { shiftKey: true });
  const readme = keys.indexOf('ffile:README.md');
  assert.deepEqual(chosen(), keys.slice(from, readme + 1));
});

test('every chosen row says so twice: the class and aria-current, on files as well as folders', async () => {
  await liveSession();
  fileRow('README.md').click();
  dispatch(dirRow('server'), 'click', { ctrlKey: true });
  dispatch(fileRow('web/src/App.tsx'), 'click', { ctrlKey: true });
  assert.equal(chosen().length, 3);
  const current = byClass(root, 'files-row')
    .filter((n) => n.getAttribute('aria-current') === 'true')
    .map((n) => (n.getAttribute('data-k') ?? '').replace(`:${PROJ}/`, ':'));
  assert.deepEqual(current, chosen(), 'the colour and the attribute are one fact');
  // And a row that is NOT chosen carries no attribute at all — an absent
  // attribute is the honest "not chosen", never `aria-current="false"`.
  assert.equal(fileRow('LICENSE').getAttribute('aria-current'), null);
});

test('ctrl+a takes every VISIBLE row, shift+↑↓ extends, ctrl+space toggles the focused row', async () => {
  await liveSession();
  const keys = rowKeys();
  dispatch(root, 'keydown', { key: 'a', ctrlKey: true });
  assert.deepEqual(chosen(), keys, 'every row on screen, and nothing hidden inside a closed folder');

  dispatch(root, 'keydown', { key: 'Escape' });
  assert.deepEqual(chosen(), []);

  // The arrows move the keyboard; shift extends from the anchor as it goes.
  // The anchor is chosen with ctrl+click: a plain click on the first row is a
  // folder toggle, and the list the range is measured over would change.
  const firstKey = keys[0]?.replace(':', `:${PROJ}/`) ?? '';
  dispatch(byKey(root, firstKey) as FakeElement, 'click', { ctrlKey: true });
  // The repaint REPLACED that row, so the keyboard goes on the fresh one — a
  // detached element holds no focus anything can act on.
  const first = byKey(root, firstKey) as FakeElement;
  first.focus();
  dispatch(first, 'keydown', { key: 'ArrowDown', shiftKey: true });
  assert.deepEqual(chosen(), keys.slice(0, 2));
  const second = dom.doc.activeElement as FakeElement;
  assert.equal(
    (second.getAttribute('data-k') ?? '').replace(`:${PROJ}/`, ':'),
    keys[1],
    'the keyboard follows the range',
  );
  dispatch(second, 'keydown', { key: 'ArrowDown', shiftKey: true });
  assert.deepEqual(chosen(), keys.slice(0, 3));
  // Back up, and the range SHRINKS — it is measured from the anchor, not grown.
  dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: 'ArrowUp', shiftKey: true });
  assert.deepEqual(chosen(), keys.slice(0, 2));

  // A plain arrow moves the keyboard and leaves the selection alone.
  const before = chosen();
  dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: 'ArrowDown' });
  assert.deepEqual(chosen(), before);

  // ctrl+space adds the row the keyboard is on, wherever the selection was.
  dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: ' ', ctrlKey: true });
  assert.equal(chosen().length, before.length + 1);
  // The repaint replaced that row and handed the keyboard to the fresh one, so
  // the second press is read off `activeElement` again.
  dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: ' ', ctrlKey: true });
  assert.equal(chosen().length, before.length, 'and takes it back out');
});

// ---------------------------------------------------------------------------
// The menu entry
// ---------------------------------------------------------------------------

test('Delete is on a folder row and on a file row, last, behind ONE hairline', async () => {
  await liveSession();
  rightClick(dirRow('web'));
  assert.equal(menuLabels()[menuLabels().length - 1], 'Delete');
  let seps = byClass(menuBox() as FakeElement, 'cm-sep');
  assert.equal(seps.length, 1, 'one hairline, and only above Delete');
  assert.equal(seps[0]?.getAttribute('role'), 'separator');
  // It is NOT an entry: the roving focus walks buttons only, so the arrows can
  // never stop on a line with nothing to activate.
  assert.equal(menuItems().length, menuLabels().length);
  const box = menuBox() as FakeElement;
  const kids = box.children.filter((c): c is FakeElement => c instanceof FakeElement);
  assert.equal(kids[kids.length - 2]?.className, 'cm-sep', 'the hairline sits directly above it');
  assert.equal(menuEntry('Delete').className, 'cm-item is-danger', 'danger is a class, not a fill');

  rightClick(fileRow('README.md'));
  // B13's `Rename` sits right above the hairline, so `Delete` stays last.
  assert.deepEqual(menuLabels(), ['Open', 'Open beside', 'Copy', 'Rename', 'Delete']);
  seps = byClass(menuBox() as FakeElement, 'cm-sep');
  assert.equal(seps.length, 1);
});

test('an ANCHOR row is offered NO Delete and no hairline, and neither is the panel background', async () => {
  await liveSession();
  // `/work/api/shared` is a registered project: the app knows the server will
  // refuse it, so the entry is absent rather than present and greyed.
  rightClick(dirRow('shared'));
  assert.equal(menuLabels().includes('Delete'), false, menuLabels().join(', '));
  assert.equal(byClass(menuBox() as FakeElement, 'cm-sep').length, 0, 'no entry, no hairline');

  // The ROOT menu is the folder the panel is standing in — an anchor too.
  dispatch(body(), 'contextmenu', { clientX: 10, clientY: 10 });
  assert.deepEqual(menuLabels(), ['Copy files here…', 'New file', 'New folder', 'Refresh']);
});

test('the menu NAMES the count when it is about more than the row it opened on', async () => {
  await liveSession();
  fileRow('README.md').click();
  dispatch(fileRow('LICENSE'), 'click', { ctrlKey: true });
  dispatch(dirRow('server'), 'click', { ctrlKey: true });
  rightClick(fileRow('README.md'));
  assert.equal(menuBox()?.getAttribute('aria-label'), 'actions for 3 selected items');
  // A row OUTSIDE the selection is about itself, and says its own name.
  rightClick(fileRow('web/DESIGN.md'));
  assert.equal(menuBox()?.getAttribute('aria-label'), 'actions for DESIGN.md');
  assert.deepEqual(chosen(), ['ffile:web/DESIGN.md'], 'and it became the selection');
});

// ---------------------------------------------------------------------------
// The confirmation
// ---------------------------------------------------------------------------

test('the question counts what will really go, Cancel deletes nothing, and the keyboard comes back', async () => {
  await liveSession();
  fileRow('README.md').click();
  const row = fileRow('README.md');
  row.focus();
  deleteFromMenu(row);
  assert.equal(DD.isDeleteDialogOpen(), true);
  assert.equal(dialogTitle(), 'Delete README.md? This cannot be undone.');
  assert.equal(dialogSub(), null, 'one file needs no second line');
  assert.equal(dialog()?.getAttribute('aria-modal'), 'true');
  assert.equal(dialog()?.getAttribute('aria-labelledby'), 'dd-title');
  // CANCEL holds the keyboard: a card that opened under a half-pressed Enter
  // may not delete anything.
  assert.equal((dom.doc.activeElement as FakeElement).textContent, 'Cancel');

  dialogButton('Cancel').click();
  assert.equal(DD.isDeleteDialogOpen(), false);
  assert.deepEqual(fx.deleteCalls, [], 'Cancel sends nothing at all');
  assert.deepEqual(chosen(), ['ffile:README.md'], 'and changes no selection');
  assert.equal(dom.doc.activeElement, fileRow('README.md'), 'the keyboard goes back to the row');
});

test('a MANY-row question counts the rows, names their folder when they share one, and warns about folders', async () => {
  await liveSession();
  fileRow('web/src/App.tsx').click();
  dispatch(fileRow('web/src/Pane.tsx'), 'click', { ctrlKey: true });
  dispatch(fileRow('web/src/store.ts'), 'click', { ctrlKey: true });
  deleteFromMenu(fileRow('web/src/App.tsx'));
  assert.equal(dialogTitle(), 'Delete 3 items from src? This cannot be undone.');
  assert.equal(dialogSub(), null, 'files only: there is nothing to warn about');
  dialogButton('Cancel').click();

  // Across two parents, with a folder among them: no single folder to name.
  fileRow('README.md').click();
  dispatch(dirRow('web/src'), 'click', { ctrlKey: true });
  deleteFromMenu(fileRow('README.md'));
  assert.equal(dialogTitle(), 'Delete 2 items? This cannot be undone.');
  assert.equal(dialogSub(), 'Folders are deleted with everything inside them.');
  dialogButton('Cancel').click();
});

test('the irreversible answer wears the danger idiom, and the keyboard starts on Cancel', async () => {
  await liveSession();
  fileRow('README.md').click();
  deleteFromMenu(fileRow('README.md'));
  // Red INK and a red OUTLINE, never the accent button the rest of the app
  // confirms with: the one control on this card that cannot be taken back may
  // not be dressed as the ordinary "yes" (`.btn-danger`, B10a's third button).
  assert.equal(dialogButton('Delete').className, 'btn-danger');
  assert.equal(dialogButton('Cancel').className, 'btn-quiet');
  assert.equal(
    dom.doc.activeElement,
    dialogButton('Cancel'),
    'a card that opened under a half-pressed Enter deletes nothing',
  );
  dialogButton('Cancel').click();
  assert.deepEqual(fx.deleteCalls, []);
});

test('Escape and the backdrop are Cancel, exactly', async () => {
  await liveSession();
  fileRow('README.md').click();
  deleteFromMenu(fileRow('README.md'));
  DD.deleteDialogEscape();
  assert.equal(DD.isDeleteDialogOpen(), false);
  assert.deepEqual(fx.deleteCalls, []);

  deleteFromMenu(fileRow('README.md'));
  const scrim = byClass(dom.body, 'dd-scrim')[0] as FakeElement;
  dispatch(scrim, 'mousedown');
  assert.equal(DD.isDeleteDialogOpen(), false);
  assert.deepEqual(fx.deleteCalls, []);
});

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

test('Delete sends exactly the chosen paths, once, in tree order — and says how many went', async () => {
  await liveSession();
  // Three rows under TWO parents: a selection is a tree, not one listing.
  fileRow('web/src/App.tsx').click();
  dispatch(fileRow('web/src/Pane.tsx'), 'click', { ctrlKey: true });
  dispatch(fileRow('README.md'), 'click', { ctrlKey: true });

  deleteFromMenu(fileRow('README.md'));
  dialogButton('Delete').click();
  await settle();

  assert.deepEqual(fx.deleteCalls, [
    [`${PROJ}/web/src/App.tsx`, `${PROJ}/web/src/Pane.tsx`, `${PROJ}/README.md`],
  ], 'ONE request, in the order the tree draws the rows');
  assert.equal(flashText(), 'Deleted 3 items.');
  assert.deepEqual(chosen(), [], 'what went is no longer chosen');
  assert.equal(fileRow('README.md'), null, 'and the rows are gone from the tree');
  assert.equal(fileRow('web/src/App.tsx'), null);
});

test('the rows dim while it runs, a SECOND Delete is refused, and nothing leaves the tree early', async () => {
  await liveSession();
  fileRow('README.md').click();
  fx.holdDelete();
  deleteFromMenu(fileRow('README.md'));
  dialogButton('Delete').click();
  await settle();

  assert.equal(fileRow('README.md').classList.contains('is-busy'), true, 'the row says it is working');
  assert.deepEqual(chosen(), ['ffile:README.md'], 'nothing is removed optimistically');

  pressDelete();
  assert.equal(flashText(), 'A delete is still running.');
  assert.equal(fx.deleteCalls.length, 1, 'one batch at a time');

  fx.releaseDelete();
  await settle();
  assert.equal(flashText(), 'Deleted README.md.');
});

test('the confirmation answered twice is still ONE request — the card is gone, its callback is not', async () => {
  await liveSession();
  fileRow('README.md').click();
  fx.holdDelete();
  deleteFromMenu(fileRow('README.md'));
  const answer = dialogButton('Delete');
  answer.click();
  await settle();
  assert.equal(fx.deleteCalls.length, 1);
  assert.equal(DD.isDeleteDialogOpen(), false, 'non-vacuity: the first press closed the card');

  // The button is off the screen now, and it still carries the callback that
  // sends the batch (a double click, a key repeat, a re-entrant caller). A
  // SECOND batch against the same items may never go out: the answer is
  // index-keyed to ONE list of items, and two in flight cannot be matched.
  answer.click();
  await settle();
  assert.equal(fx.deleteCalls.length, 1, 'one confirmation, one request');

  fx.releaseDelete();
  await settle();
  assert.equal(flashText(), 'Deleted README.md.');
  clearFlash();
});

test('every affected parent is re-read ONCE, and a folder nobody has open is not asked for at all', async () => {
  await liveSession();
  // Two rows under `web/src`, plus the folder `web/src` itself — then that
  // folder is CLOSED from its own menu, which keeps the selection (the row is
  // in it) and hides the two files without dropping them.
  dispatch(fileRow('web/src/App.tsx'), 'click', { ctrlKey: true });
  dispatch(fileRow('web/src/Pane.tsx'), 'click', { ctrlKey: true });
  dispatch(dirRow('web/src'), 'click', { ctrlKey: true });
  rightClick(dirRow('web/src'));
  menuEntry('Close').click();
  await settle();
  assert.equal(fileRow('web/src/App.tsx'), null, 'the two rows are off screen');
  assert.deepEqual(chosen(), ['fdir:web/src'], 'and the chosen row that is left is the folder');

  fx.entryCalls.length = 0;
  deleteFromMenu(dirRow('web/src'));
  // A COLLAPSED row is still part of the act: closing a folder hides rows, it
  // is not a way to change what the user already chose.
  assert.equal(dialogTitle(), 'Delete 3 items? This cannot be undone.');
  dialogButton('Delete').click();
  await settle();

  assert.deepEqual(fx.deleteCalls, [
    [`${PROJ}/web/src`, `${PROJ}/web/src/App.tsx`, `${PROJ}/web/src/Pane.tsx`],
  ]);
  // `web` is open and holds the folder that went: read once. `web/src` is
  // closed, so its own listing is not asked for at all.
  assert.deepEqual(fx.entryCalls, [`${PROJ}/web`]);
});

test('a partial answer: the count says so, the failures stay chosen, and the rows that went are gone', async () => {
  await liveSession();
  fileRow('web/src/App.tsx').click();
  dispatch(fileRow('web/src/Pane.tsx'), 'click', { ctrlKey: true });
  dispatch(fileRow('web/src/store.ts'), 'click', { ctrlKey: true });
  fx.deleteAnswer = (_path, i): DeleteResult =>
    i === 1 ? { ok: false, status: 403, error: 'You do not have permission to delete this.' } : { ok: true };

  deleteFromMenu(fileRow('web/src/App.tsx'));
  dialogButton('Delete').click();
  await settle();

  assert.equal(flashText(), 'Deleted 2 of 3 items.');
  assert.deepEqual(chosen(), ['ffile:web/src/Pane.tsx'], 'what failed is what is still chosen');
  assert.equal(fileRow('web/src/App.tsx'), null);
  assert.ok(fileRow('web/src/Pane.tsx') !== null, 'and it is still in the tree');
});

test('ONE item that failed says the SERVER s own sentence; a shapeless one says the app s', async () => {
  await liveSession();
  fileRow('README.md').click();
  fx.deleteAnswer = (): DeleteResult => ({ ok: false, status: 409, error: 'That item is in use right now.' });
  deleteFromMenu(fileRow('README.md'));
  dialogButton('Delete').click();
  await settle();
  assert.equal(flashText(), 'That item is in use right now.', 'it says WHY, in the server s words');

  // A message that is not one of the server's constant sentences (§1d) is not
  // rendered at all: the app says what it knows in its own voice.
  clearFlash();
  fx.deleteAnswer = (): DeleteResult => ({ ok: false, status: 500, error: 'HTTP 500' });
  deleteFromMenu(fileRow('README.md'));
  dialogButton('Delete').click();
  await settle();
  assert.equal(flashText(), 'Nothing was deleted.');
  assert.deepEqual(chosen(), ['ffile:README.md'], 'and the row is still chosen, and still there');
  assert.ok(fileRow('README.md') !== null);
});

test('a REJECTED request deletes nothing, says so, and leaves the selection exactly as it was', async () => {
  await liveSession();
  fileRow('README.md').click();
  dispatch(fileRow('LICENSE'), 'click', { ctrlKey: true });
  fx.deleteFails = new FakeApiError(413, 'Too many items. Delete up to 100 at a time.');
  deleteFromMenu(fileRow('README.md'));
  dialogButton('Delete').click();
  await settle();

  assert.equal(flashText(), 'Nothing was deleted.');
  assert.deepEqual(sorted(chosen()), ['ffile:LICENSE', 'ffile:README.md']);
  assert.ok(fileRow('README.md') !== null, 'nothing left the tree');
  assert.ok(fileRow('LICENSE') !== null);
});

test('the keyboard never falls to <body>: it lands on the nearest surviving row', async () => {
  await liveSession();
  // A full-keyboard delete: choose the row, press Delete, confirm. The row the
  // keyboard is standing on is about to leave the tree, and a focus dropped on
  // <body> would leave the user with no keyboard at all until they click.
  const keys = rowKeys();
  fileRow('web/src/App.tsx').click();
  // The click repainted the tree, so the keyboard goes on the FRESH row: a
  // detached element is a focus nothing can act on.
  fileRow('web/src/App.tsx').focus();
  pressDelete(fileRow('web/src/App.tsx'));
  dialogButton('Delete').click();
  await settle();

  const now = dom.doc.activeElement as FakeElement;
  assert.notEqual(now, dom.body, 'the keyboard must not fall to <body>');
  const key = (now.getAttribute('data-k') ?? '').replace(`:${PROJ}/`, ':');
  assert.equal(now.classList.contains('files-row'), true, `focus landed on ${now.tagName}.${now.className}`);
  // The row BELOW the one that went, in tree order.
  const after = keys[keys.indexOf('ffile:web/src/App.tsx') + 1];
  assert.equal(key, after, `expected the next row (${after}), got ${key}`);
  assert.equal(now.isConnected, true, 'and it is a row that is really on screen');
});

test('with nothing left to stand on, the keyboard goes to the Files tab, never to <body>', async () => {
  // A folder whose whole listing goes: the panel root's own row set shrinks to
  // the rows around it, and when there is no row at all the tab that is always
  // there takes the keyboard.
  fx.tree.set(PROJ, [{ name: 'only.txt', dir: false }]);
  await liveSession();
  assert.deepEqual(rowKeys(), ['ffile:only.txt'], 'non-vacuity: one row, and it is the one deleted');
  fileRow('only.txt').click();
  fileRow('only.txt').focus();
  pressDelete(fileRow('only.txt'));
  dialogButton('Delete').click();
  await settle();

  const now = dom.doc.activeElement as FakeElement;
  assert.notEqual(now, dom.body);
  assert.equal(now.getAttribute('data-k'), 'ftab:files');
});

test('a deleted FOLDER takes its cache with it: not open, not listed, never re-asked', async () => {
  await liveSession();
  // `web` and `web/src` are both open and both listed.
  assert.ok(fileRow('web/src/App.tsx') !== null, 'non-vacuity: the subtree is expanded');
  dirRow('web').click(); // chooses it (and closes it — the toggle is the click's second effect)
  dirRow('web').click(); // open again, still chosen
  assert.deepEqual(chosen(), ['fdir:web']);
  deleteFromMenu(dirRow('web'));
  dialogButton('Delete').click();
  await settle();
  assert.equal(dirRow('web'), null, 'the folder is gone from the tree');

  // The root is re-read from its own menu: nothing under the gone folder may
  // be asked for, and a folder created again under that name must not be
  // drawn pre-expanded over a dead listing.
  fx.entryCalls.length = 0;
  dispatch(body(), 'contextmenu', { clientX: 10, clientY: 10 });
  menuEntry('Refresh').click();
  await settle();
  const asked = fx.entryCalls.filter((p) => p !== undefined) as string[];
  assert.deepEqual(
    asked.filter((p) => p === `${PROJ}/web` || p.startsWith(`${PROJ}/web/`)),
    [],
    `a path that is gone was asked for again: ${asked.join(', ')}`,
  );
  assert.ok(asked.includes(PROJ), 'non-vacuity: the refresh really ran');

  // And the same name, created again, opens closed and empty.
  fx.tree.set(`${PROJ}/web`, []);
  (fx.tree.get(PROJ) as { name: string; dir: boolean }[]).push({ name: 'web', dir: true });
  dispatch(body(), 'contextmenu', { clientX: 10, clientY: 10 });
  menuEntry('Refresh').click();
  await settle();
  assert.equal(dirRow('web')?.getAttribute('aria-expanded'), 'false', 'a new folder is not pre-expanded');
});

test('a folder whose delete FAILED keeps its cache: still open, still listed, still chosen', async () => {
  await liveSession();
  assert.ok(fileRow('web/src/App.tsx') !== null, 'non-vacuity: the subtree is expanded');
  dirRow('web').click(); // chooses it (and closes it — the click's second effect)
  dirRow('web').click(); // open again, still chosen
  assert.deepEqual(chosen(), ['fdir:web']);

  fx.deleteAnswer = (): DeleteResult => ({
    ok: false,
    status: 403,
    error: 'You do not have permission to delete this.',
  });
  deleteFromMenu(dirRow('web'));
  dialogButton('Delete').click();
  await settle();

  // The prune is for what is GONE. A folder that is still on disk must keep
  // its open state and its listing, or a refusal would silently collapse the
  // subtree the user was working in and re-ask for every listing under it.
  assert.equal(flashText(), 'You do not have permission to delete this.');
  assert.deepEqual(chosen(), ['fdir:web'], 'what failed stays chosen');
  assert.ok(dirRow('web') !== null, 'and it is still in the tree');
  assert.equal(dirRow('web').getAttribute('aria-expanded'), 'true', 'still open');
  assert.ok(fileRow('web/src/App.tsx') !== null, 'and its listing is still under it');
  clearFlash();
});

// ---------------------------------------------------------------------------
// The Delete key
// ---------------------------------------------------------------------------

test('the Delete key acts on the SELECTION, and on the focused row when nothing is chosen', async () => {
  await liveSession();
  fileRow('README.md').click();
  dispatch(fileRow('LICENSE'), 'click', { ctrlKey: true });
  const e = pressDelete(fileRow('README.md'));
  assert.equal(e.defaultPrevented, true, 'inside the panel the key is the panel s');
  assert.equal(dialogTitle(), 'Delete 2 items from api? This cannot be undone.');
  dialogButton('Cancel').click();

  // Nothing chosen: the row the keyboard is standing on.
  dispatch(root, 'keydown', { key: 'Escape' });
  assert.deepEqual(chosen(), []);
  fileRow('LICENSE').focus();
  pressDelete(fileRow('LICENSE'));
  assert.equal(dialogTitle(), 'Delete LICENSE? This cannot be undone.');
  dialogButton('Delete').click();
  await settle();
  assert.deepEqual(fx.deleteCalls, [[`${PROJ}/LICENSE`]]);
});

test('the Delete key on an ANCHOR asks nothing at all — a key that does not apply says nothing', async () => {
  await liveSession();
  dirRow('shared').click();
  assert.deepEqual(chosen(), ['fdir:shared'], 'non-vacuity: the anchor row IS chosen');
  pressDelete(dirRow('shared'));
  assert.equal(DD.isDeleteDialogOpen(), false, 'no question');
  assert.equal(flashText(), '', 'and no sentence about a key that does not apply');
  assert.deepEqual(fx.deleteCalls, []);
});

test('the HOME folder drawn as a ROW is an anchor too — no Delete entry, and the key says nothing', async () => {
  // The one way home itself becomes a row: a project registered ABOVE it. The
  // row is then neither the panel's own root nor a registered project, and it
  // is still the folder the server refuses by name (`FS_DELETE_ANCHOR`, D3) —
  // so the menu may not offer an act the app knows will be refused.
  fx.tree.set('/home', [{ name: 'you', dir: true }]);
  st.setProjects([
    { id: 'p0', name: 'home', path: '/home', createdAt: new Date().toISOString() } as Project,
  ]);
  st.setSessions([mkSession('s0', { projectId: 'p0', cwd: '/home' })]);
  const v = st.state.views.find((x) =>
    x.slots.some((sl) => (sl as { kind: string; id?: string }).id === 's0'),
  );
  if (v !== undefined) st.state.activeViewId = v.id;
  st.state.leftPanel = 'files';
  panel.render();
  await until(() => byKey(root, 'fdir:/home/you') !== null);

  const homeRow = byKey(root, 'fdir:/home/you') as FakeElement;
  assert.ok(homeRow !== null && homeRow !== undefined, 'non-vacuity: home is drawn as a row');
  rightClick(homeRow);
  assert.equal(menuLabels().includes('Delete'), false, `no Delete: ${menuLabels().join(', ')}`);
  assert.equal(byClass(menuBox() as FakeElement, 'cm-sep').length, 0, 'and no hairline for it');
  dispatch(dom.body, 'keydown', { key: 'Escape' });

  homeRow.click();
  pressDelete(byKey(root, 'fdir:/home/you') as FakeElement);
  assert.equal(DD.isDeleteDialogOpen(), false, 'no question');
  assert.equal(flashText(), '', 'and no sentence about a key that does not apply');
  assert.deepEqual(fx.deleteCalls, []);
});

test('an anchor inside a MANY-row selection is dropped silently, and the question counts the rest', async () => {
  await liveSession();
  dirRow('shared').click();
  dispatch(fileRow('README.md'), 'click', { ctrlKey: true });
  pressDelete(fileRow('README.md'));
  assert.equal(dialogTitle(), 'Delete README.md? This cannot be undone.');
  dialogButton('Delete').click();
  await settle();
  assert.deepEqual(fx.deleteCalls, [[`${PROJ}/README.md`]], 'the anchor never reaches the request');
});

test('a copy that is still writing refuses the delete, in the drop layer s own sentence', async () => {
  await liveSession();
  fileRow('README.md').click();
  // A real run that has not finished, with its card HIDDEN — which is the
  // state the sentence exists for: no scrim on screen, bytes still moving.
  const rows = [{ name: 'a.txt', state: 'copied', dir: false }];
  let finish: (r: unknown) => void = () => {};
  DROP.openDropDialog({
    dest: 'api',
    items: [{ name: 'a.txt', dir: false, bytes: 1 }],
    listing: [],
    returnFocus: null,
    run: {
      plan: () => rows,
      failed: () => 0,
      start: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  DROP.dropDialogEscape();
  assert.equal(DROP.isDropRunning(), true, 'non-vacuity: the copy is still running');
  assert.equal(byClass(dom.body, 'modal-scrim').length, 0, 'and its card is off the screen');

  pressDelete(fileRow('README.md'));
  assert.equal(flashText(), 'A copy is still running.');
  assert.equal(DD.isDeleteDialogOpen(), false);
  assert.deepEqual(fx.deleteCalls, []);

  // Let it finish: `running` is module state, and a copy left in flight would
  // refuse every delete in every test after this one.
  finish(rows);
  await settle();
  assert.equal(DROP.isDropRunning(), false);
  clearFlash();
});

test('the Delete key is left alone inside a name row, and while a dialog is up', async () => {
  await liveSession();
  fileRow('README.md').click();
  // A half-typed name: Delete there is an edit, not a filesystem act.
  rightClick(dirRow('web'));
  menuEntry('New file').click();
  await settle();
  const input = byClass(root, 'files-newname')[0] as FakeElement;
  assert.ok(input !== undefined, 'non-vacuity: the name row is up');
  const typed = dispatch(input, 'keydown', { key: 'Delete' });
  assert.equal(typed.defaultPrevented, false);
  assert.equal(DD.isDeleteDialogOpen(), false);
  dispatch(input, 'keydown', { key: 'Escape' });

  // And with the confirmation itself up, a second Delete stacks nothing.
  fileRow('README.md').click();
  pressDelete(fileRow('README.md'));
  assert.equal(DD.isDeleteDialogOpen(), true);
  const again = pressDelete(fileRow('README.md'));
  assert.equal(again.defaultPrevented, false, 'the panel steps aside while a dialog owns the window');
  assert.equal(byClass(dom.body, 'dd-modal').length, 1, 'one question, never two');
  dialogButton('Cancel').click();
});

test('Alt is never the panel s: alt+Delete and ctrl+alt+arrows pass straight through', async () => {
  await liveSession();
  fileRow('README.md').click();
  const rowEl = fileRow('README.md');
  rowEl.focus();

  // The app owns the PLAIN Delete (with or without shift). Alt+Delete is not
  // this panel's chord, so it is neither swallowed nor answered.
  const alt = dispatch(rowEl, 'keydown', { key: 'Delete', altKey: true });
  assert.equal(alt.defaultPrevented, false);
  assert.equal(DD.isDeleteDialogOpen(), false);
  assert.deepEqual(fx.deleteCalls, []);

  // Ctrl+Alt+↑/↓ belongs to the WINDOW (PROJECT-SCOPE: the app's Ctrl+Alt
  // family moves between panes). With the keyboard on one of this panel's own
  // rows the tree must leave it alone — bubbling out and not moving its own
  // focus — or the chord dies everywhere the Files panel has the keyboard.
  const at = dom.doc.activeElement;
  const chord = dispatch(rowEl, 'keydown', { key: 'ArrowDown', ctrlKey: true, altKey: true });
  assert.equal(chord.defaultPrevented, false, 'the window handler must still see it');
  assert.equal(chord.cancelBubble, false, 'and it must still bubble out of the panel');
  assert.equal(dom.doc.activeElement, at, 'the keyboard did not move inside the tree');

  const plain = dispatch(rowEl, 'keydown', { key: 'ArrowDown', altKey: true });
  assert.equal(plain.defaultPrevented, false);
  assert.equal(dom.doc.activeElement, at);
});

// ---------------------------------------------------------------------------
// The caps
// ---------------------------------------------------------------------------

test('over a hundred rows: the app refuses before the request, for Delete and for Copy alike', async () => {
  // A folder the server answers with 101 files: `ctrl+a` then covers more rows
  // than one batch may carry, and the client says so instead of watching the
  // whole batch bounce off the boundary.
  const many = Array.from({ length: 101 }, (_, i) => ({ name: `f${i}.txt`, dir: false }));
  fx.tree.set(PROJ, many);
  await liveSession();
  assert.ok(rowKeys().length > 100, `non-vacuity: ${rowKeys().length} rows`);

  dispatch(root, 'keydown', { key: 'a', ctrlKey: true });
  pressDelete();
  assert.equal(flashText(), 'Too many items. Delete up to 100 at a time.');
  assert.equal(DD.isDeleteDialogOpen(), false);
  assert.deepEqual(fx.deleteCalls, []);

  clearFlash();
  // `Copy` is live only in the native window, so the host channel is there —
  // and the refusal still comes BEFORE the first mapping.
  const win = dom.win as unknown as { chrome?: { webview: unknown } };
  win.chrome = {
    webview: { postMessage: () => {}, addEventListener: () => {}, removeEventListener: () => {} },
  };
  try {
    const first = byKey(root, `ffile:${PROJ}/f0.txt`) as FakeElement;
    rightClick(first);
    menuEntry('Copy').click();
    await settle();
    assert.equal(flashText(), 'Too many items. Copy up to 100 at a time.');
    assert.deepEqual(fx.winPathCalls, [], 'and not one path was mapped');
  } finally {
    delete win.chrome;
  }
});

test('exactly a hundred rows is the batch the app still takes — for Delete and for Copy alike', async () => {
  // The cap is a LIMIT, not a forbidden number: `MAX_DELETE_ITEMS` items go
  // through in ONE request, and the refusal begins one row later (the test
  // above). An off-by-one here is a hundred rows a user may never delete, with
  // a sentence blaming them for it — and the server would have taken them.
  const many = Array.from({ length: 100 }, (_, i) => ({ name: `f${i}.txt`, dir: false }));
  fx.tree.set(PROJ, many);
  await liveSession();
  assert.equal(rowKeys().length, 100, 'non-vacuity: the tree draws exactly the cap');

  const win = dom.win as unknown as { chrome?: { webview: unknown } };
  const listeners: ((e: { data?: unknown }) => void)[] = [];
  win.chrome = {
    webview: {
      postMessage: () => {},
      addEventListener: (_t: string, fn: (e: { data?: unknown }) => void) => listeners.push(fn),
      removeEventListener: () => {},
    },
  };
  try {
    dispatch(root, 'keydown', { key: 'a', ctrlKey: true });
    rightClick(byKey(root, `ffile:${PROJ}/f0.txt`) as FakeElement);
    menuEntry('Copy').click();
    await settle();
    // `settle()` drains a fixed number of microtask turns; a hundred mappings
    // in sequence need more than one pass, so the wait is on the CONDITION
    // with a bound, never on a duration.
    await until(() => fx.winPathCalls.length === 100);
    assert.equal(fx.winPathCalls.length, 100, 'every chosen row is mapped, none refused');
    for (const fn of [...listeners]) fn({ data: 'copy-files ok 100' });
    await settle();
    assert.equal(flashText(), 'Copied 100 items to the clipboard.');
    clearFlash();
  } finally {
    delete win.chrome;
  }

  dispatch(root, 'keydown', { key: 'a', ctrlKey: true });
  pressDelete();
  assert.equal(dialogTitle(), 'Delete 100 items from api? This cannot be undone.');
  dialogButton('Delete').click();
  await until(() => fx.deleteCalls.length > 0);
  assert.equal(fx.deleteCalls.length, 1, 'one request for the whole hundred');
  assert.equal((fx.deleteCalls[0] as string[]).length, 100);
  assert.equal(flashText(), 'Deleted 100 items.');
  clearFlash();
});

// ---------------------------------------------------------------------------
// Copy, on a selection (part D4)
// ---------------------------------------------------------------------------

test('Copy on three chosen rows maps three paths, hands the host ONE list, and counts them', async () => {
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
    fileRow('README.md').click();
    dispatch(fileRow('LICENSE'), 'click', { ctrlKey: true });
    dispatch(dirRow('server'), 'click', { ctrlKey: true });
    rightClick(fileRow('README.md'));
    menuEntry('Copy').click();
    await settle();

    assert.deepEqual(fx.winPathCalls, [
      `${PROJ}/server`,
      `${PROJ}/README.md`,
      `${PROJ}/LICENSE`,
    ], 'one mapping per chosen row, in tree order');
    assert.equal(posted.length, 1, 'and ONE message to the host: one clipboard, one list');
    assert.equal(posted[0]?.split('\n').length, 4, 'the kind line plus three paths');
    for (const fn of [...listeners]) fn({ data: 'copy-files ok 3' });
    await settle();
    assert.equal(flashText(), 'Copied 3 items to the clipboard.', 'a count, never a path');
  } finally {
    delete win.chrome;
    clearFlash();
  }
});

test('Copy where one path has no Windows form says how many really went', async () => {
  await liveSession();
  const win = dom.win as unknown as { chrome?: { webview: unknown } };
  const listeners: ((e: { data?: unknown }) => void)[] = [];
  win.chrome = {
    webview: {
      postMessage: () => {},
      addEventListener: (_t: string, fn: (e: { data?: unknown }) => void) => listeners.push(fn),
      removeEventListener: () => {},
    },
  };
  try {
    fileRow('README.md').click();
    dispatch(fileRow('LICENSE'), 'click', { ctrlKey: true });
    // The 422 a path with no Windows form really gets.
    fx.winPathFails = new FakeApiError(422, 'That folder has no Windows path.');
    rightClick(fileRow('README.md'));
    menuEntry('Copy').click();
    await settle();
    assert.equal(flashText(), 'The app could not copy that to the clipboard.', 'nothing mapped at all');

    clearFlash();
    fx.winPathFails = null;
    let calls = 0;
    const real = fx.gateway.winPath.bind(fx.gateway);
    fx.gateway.winPath = (path: string) => {
      calls += 1;
      return calls === 1 ? Promise.reject(new FakeApiError(422, 'no')) : real(path);
    };
    rightClick(fileRow('README.md'));
    menuEntry('Copy').click();
    await settle();
    for (const fn of [...listeners]) fn({ data: 'copy-files ok 1' });
    await settle();
    assert.equal(flashText(), 'Copied 1 of 2 items to the clipboard.');
    fx.gateway.winPath = real;
  } finally {
    delete win.chrome;
    clearFlash();
  }
});

// ---------------------------------------------------------------------------
// The shell's wiring (read as source: main.ts's import graph reaches xterm)
// ---------------------------------------------------------------------------

test('the Escape ladder ranks the confirmation after the folder picker and before the drop dialog', () => {
  assert.ok(MAIN.length > 10_000, 'non-vacuity: main.ts');
  const pick = MAIN.indexOf('} else if (isFolderPickerOpen())');
  const del = MAIN.indexOf('} else if (isDeleteDialogOpen())');
  const drop = MAIN.indexOf('} else if (isDropDialogOpen())');
  assert.ok(pick > 0 && del > 0 && drop > 0, 'all three arms must exist');
  assert.ok(pick < del && del < drop, 'the confirmation can open while a hidden copy still runs');
  // And the panel is really given a delete to call: the gateway is injected,
  // so `ui/files.ts` never imports `../api.ts` (B2 §9).
  assert.match(MAIN, /\n\s*delete: api\.fsDelete,\n/);
});

test('the panel still imports no HTTP of its own — the delete goes through the injected gateway', () => {
  const src = readFileSync(join(here, '..', '..', 'web', 'src', 'ui', 'files.ts'), 'utf8');
  assert.ok(src.length > 10_000, 'non-vacuity: ui/files.ts');
  assert.equal(/from '\.\.\/api\.ts'/.test(src), false, 'the panel may not know about HTTP');
  assert.match(src, /fs\.delete\(pathsOf\(items\)\)/, 'one request, the model s list of paths');
});
