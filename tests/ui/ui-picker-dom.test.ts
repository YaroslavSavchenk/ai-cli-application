/**
 * `web/src/ui/picker.ts` — the folder picker (Nocturne A7 follow-up c) driven
 * through the REAL module on the DOM double in `tests/helpers/fake-dom.ts`, opened the
 * way the app opens it: from the Add-a-project dialog's folder row.
 *
 * WHY THIS FILE EXISTS. The restyle rewrote every element of this dialog, and
 * the only tests it had were of the endpoints behind it
 * (`tests/server/scaffold.test.ts`, `tests/ui/ui-api-auth.test.ts`) and of the pure path
 * helpers (`tests/ui/ui-newproject.test.ts`). Nothing clicked the picker. These
 * are the behaviours a restyle can break without a regex noticing:
 *
 *   1. It opens OVER the Add-a-project dialog: a second `.modal-scrim` appended
 *      LAST to the same modal host, with the dialog underneath still open (that
 *      append order IS the z-order, and main.ts ranks Esc on it).
 *   2. The listing comes from `fsList` and every directory name lands as ONE
 *      text node next to a decorative mark — never parsed markup.
 *   3. Navigation: a folder row lists that folder, the path row's segments list
 *      their own, "up one level" goes to the parent and is disabled at the root.
 *   4. `+ folder` posts the name, clears the field and navigates into the answer.
 *   5. "Choose this folder" hands the CURRENT directory to the opener, closes
 *      only the picker, and returns focus to the row it was opened from.
 *   6. A failed listing surfaces the backend's own reason inline and keeps the
 *      listing that was there.
 *
 * `../api.ts` and `../state.ts` are stubbed for the three modules that import
 * them (picker.ts, newproject.ts and its GitHub panel); the REAL `ui/util.ts`,
 * `ui/icons.ts`, `ui/newproject-model.ts` and `ui/picker.ts` take part. Layout,
 * hit-testing and screen-reader output stay manual
 * (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { FsListResponse, Project } from '../../shared/protocol.ts';
import { byClass, dispatch, installDom, textsOf, type FakeElement, FakeText } from '../helpers/fake-dom.ts';

const dom = installDom();

// ===========================================================================
// Harness + module stubs
// ===========================================================================

interface Harness {
  projects: Project[];
  /** Absolute dir → its subdirectories. Anything else is a 404. */
  tree: Record<string, string[]>;
  fsListCalls: (string | undefined)[];
  mkdirCalls: { path: string; name: string }[];
  /** Armed by a test to make the NEXT fsList fail with this message. */
  failNext: string | null;
  /** Armed by a test to make the NEXT fsMkdir fail with this message. */
  failNextMkdir: string | null;
}

const H: Harness = {
  projects: [],
  tree: {
    '/': ['home', 'etc'],
    '/home/tester': ['projects', 'sandbox'],
    '/home/tester/projects': ['api', '<b>web</b>'],
    '/home/tester/projects/api': [],
    '/home/tester/projects/fresh': [],
  },
  fsListCalls: [],
  mkdirCalls: [],
  failNext: null,
  failNextMkdir: null,
};
(globalThis as unknown as Record<string, unknown>).__pkHarness = H;

const STUB_SRC: Record<string, string> = {
  api: `
    const H = globalThis.__pkHarness;
    export class ApiError extends Error {
      constructor(status, message) { super(message); this.status = status; }
    }
    export async function fsList(path) {
      H.fsListCalls.push(path);
      if (H.failNext !== null) { const m = H.failNext; H.failNext = null; throw new ApiError(403, m); }
      const p = path ?? '/home/tester';
      const dirs = H.tree[p];
      if (dirs === undefined) throw new ApiError(404, 'not a directory: ' + p);
      return { path: p, dirs, empty: dirs.length === 0 };
    }
    export async function fsMkdir(path, name) {
      H.mkdirCalls.push({ path, name });
      if (H.failNextMkdir !== null) {
        const m = H.failNextMkdir; H.failNextMkdir = null; throw new ApiError(403, m);
      }
      const made = (path === '/' ? '' : path) + '/' + name;
      H.tree[made] = H.tree[made] ?? [];
      return { path: made };
    }
    export async function createLocalProject() { throw new Error('not used'); }
    export async function createProject() { throw new Error('not used'); }
    export async function cloneProject() { throw new Error('not used'); }
    export async function githubStatus() { return { deviceFlowAvailable: false, state: 'disconnected' }; }
    export async function githubDevice() { throw new Error('not used'); }
    export async function githubDisconnect() { throw new Error('not used'); }
    export async function githubRepos() { return { repos: [] }; }
    export async function githubToken() { throw new Error('not used'); }
    export async function githubClone() { throw new Error('not used'); }
    export async function githubCreateRepo() { throw new Error('not used'); }`,
  state: `
    const H = globalThis.__pkHarness;
    export const state = {
      get projects() { return H.projects; },
      sessions: new Map(),
    };
    export function setProjects(ps) { H.projects = ps; }
    export function openDrawer() {}
    export function addProject() {}
    export function removeProject() {}
    export function subscribe() {}
    export function appendLog() {}
    export function toggleDrawer() {}`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? '';
    const mine =
      parent.endsWith('/web/src/ui/picker.ts') ||
      parent.endsWith('/web/src/ui/newproject.ts') ||
      parent.endsWith('/web/src/ui/github.ts');
    if (mine) {
      const m = /^\.\.\/(api|state)\.ts$/.exec(specifier);
      if (m !== null) return { url: `pk-stub:${m[1] as string}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('pk-stub:')) {
      return { format: 'module', source: STUB_SRC[url.slice('pk-stub:'.length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

interface NewProjectModule {
  initNewProjectDialog(host: unknown): void;
  openNewProjectDialog(mode?: 'blank' | 'clone' | 'github'): void;
  closeNewProjectDialog(): void;
  isNewProjectDialogOpen(): boolean;
}
interface PickerModule {
  isFolderPickerOpen(): boolean;
  closeFolderPicker(): void;
  openFolderPicker(opts: {
    modalHost: unknown;
    title: string;
    initial?: string;
    home?: string | null;
    projectsDir?: string | null;
    restoreTo?: unknown;
    onSelect(path: string): void;
  }): void;
}

// Computed specifiers: the server tsconfig must not walk the browser graph.
const NP = (await import(new URL('../../web/src/ui/newproject.ts', import.meta.url).href)) as NewProjectModule;
const PK = (await import(new URL('../../web/src/ui/picker.ts', import.meta.url).href)) as PickerModule;

const modalHost = dom.doc.createElement('div');
dom.body.append(modalHost);
NP.initNewProjectDialog(modalHost);

const apScrim = modalHost.children[0] as FakeElement;
const apModal = apScrim.children[0] as FakeElement;

/** Three microtask turns: the ensureHome / fsList / probe promises settle. */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const one = (root: FakeElement, cls: string): FakeElement => {
  const hit = byClass(root, cls)[0];
  assert.ok(hit !== undefined, `no .${cls}`);
  return hit;
};

/** The picker's scrim is whatever the picker appended to the host, i.e. the last. */
const pkScrim = (): FakeElement => {
  const last = modalHost.children[modalHost.children.length - 1] as FakeElement;
  assert.ok(last !== apScrim, 'the picker is not open');
  return last;
};
const pkModal = (): FakeElement => pkScrim().children[0] as FakeElement;
const rowNames = (): string[] => textsOf(pkModal(), 'pk-rowname');
const pathRow = (): FakeElement => one(apModal, 'ap-pathrow');

/** Open the dialog on New folder and press its folder row. */
async function openPicker(): Promise<void> {
  if (PK.isFolderPickerOpen()) PK.closeFolderPicker();
  NP.closeNewProjectDialog();
  NP.openNewProjectDialog('blank');
  await settle();
  H.fsListCalls.length = 0;
  pathRow().click();
  await settle();
}

// ===========================================================================
// 1. It opens over the dialog
// ===========================================================================

test('the picker opens OVER the Add-a-project dialog: a second scrim, appended last', async () => {
  await openPicker();
  assert.equal(PK.isFolderPickerOpen(), true);
  assert.equal(NP.isNewProjectDialogOpen(), true, 'the dialog underneath stays open');
  assert.equal(modalHost.children.length, 2, 'one host, two scrims');
  assert.equal(modalHost.children[0], apScrim, 'the dialog was there first');
  assert.equal(apScrim.hidden, false);
  // Same modal z: the append order is what puts the picker on top.
  assert.ok(pkScrim().classList.contains('modal-scrim'), 'ui/keys.ts finds an open dialog by this');
  assert.equal(pkScrim().className, 'modal-scrim pk-scrim');
  assert.equal(pkModal().className, 'pk-modal');
  assert.equal(pkModal().getAttribute('role'), 'dialog');
  assert.equal(pkModal().getAttribute('aria-modal'), 'true');
  assert.equal(pkModal().getAttribute('aria-labelledby'), 'pk-title');
  const title = one(pkModal(), 'pk-title');
  assert.equal(title.id, 'pk-title');
  assert.equal(title.textContent, 'Select project folder', "the opener's own words");
  assert.equal(one(pkModal(), 'pk-x').getAttribute('aria-label'), 'Close');
  // It opens where the opener said: <home>/projects, from the one fs/list.
  assert.deepEqual(H.fsListCalls, ['/home/tester/projects']);
  assert.equal(dom.doc.activeElement, byClass(one(pkModal(), 'pk-ft'), 'btn-accent')[0]);
});

test('a second open is refused while one picker is up', async () => {
  await openPicker();
  const before = modalHost.children.length;
  PK.openFolderPicker({ modalHost, title: 'Select destination folder', onSelect: () => {} });
  assert.equal(modalHost.children.length, before, 'one picker at a time');
  assert.equal(one(pkModal(), 'pk-title').textContent, 'Select project folder');
});

// ===========================================================================
// 2 + 3. The listing and navigation
// ===========================================================================

test('the listing is one row per folder: a decorative mark plus the name as ONE text node', async () => {
  await openPicker();
  assert.deepEqual(rowNames(), ['api', '<b>web</b>']);
  const rows = byClass(pkModal(), 'pk-row');
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.tagName, 'BUTTON', 'a folder row is a control, not a div with a handler');
    const mark = r.children[0] as FakeElement;
    assert.equal(mark.tagName, 'SVG', 'the folder glyph from ui/icons.ts');
    assert.equal(mark.getAttribute('aria-hidden'), 'true', 'the mark is decoration; the name is the label');
  }
  // A directory name that looks like markup is TEXT, tags and all.
  const evil = byClass(pkModal(), 'pk-rowname')[1] as FakeElement;
  assert.equal(evil.children.length, 1);
  assert.ok(evil.children[0] instanceof FakeText);
  assert.equal(evil.textContent, '<b>web</b>');
});

test('an empty folder says so, honestly and once', async () => {
  await openPicker();
  byClass(pkModal(), 'pk-row')[0]?.click(); // into /home/tester/projects/api
  await settle();
  assert.deepEqual(rowNames(), []);
  assert.equal(one(pkModal(), 'pk-empty').textContent, 'No folders here.');
});

test('the path row walks: a segment lists its own folder, up goes to the parent, root disables up', async () => {
  await openPicker();
  // /home/tester/projects → the crumbs the model builds, last one in full ink.
  assert.deepEqual(textsOf(pkModal(), 'pk-crumb'), ['/', 'home', 'tester', 'projects']);
  const crumbs = byClass(pkModal(), 'pk-crumb');
  assert.equal(crumbs[3]?.classList.contains('is-here'), true, 'where you are');
  assert.equal(crumbs[0]?.classList.contains('is-here'), false);
  assert.deepEqual(textsOf(pkModal(), 'pk-sep'), ['/', '/', '/'], 'one separator between segments');
  assert.equal(one(pkModal(), 'pk-up').disabled, false);

  H.fsListCalls.length = 0;
  crumbs[2]?.click(); // tester
  await settle();
  assert.deepEqual(H.fsListCalls, ['/home/tester']);
  assert.deepEqual(rowNames(), ['projects', 'sandbox']);

  H.fsListCalls.length = 0;
  one(pkModal(), 'pk-up').click();
  await settle();
  assert.deepEqual(H.fsListCalls, ['/home']);
  // /home is not in the tree: the failure is inline and the listing stays.
  assert.equal(one(pkModal(), 'pk-err').hidden, false);
  assert.deepEqual(rowNames(), ['projects', 'sandbox']);

  H.fsListCalls.length = 0;
  byClass(pkModal(), 'pk-crumb')[0]?.click(); // /
  await settle();
  assert.deepEqual(H.fsListCalls, ['/']);
  assert.equal(one(pkModal(), 'pk-up').disabled, true, 'nowhere up from the root');
  assert.equal(one(pkModal(), 'pk-err').hidden, true, 'a good listing clears the message');
  // From the root a child is /<name>, never //<name>.
  H.fsListCalls.length = 0;
  byClass(pkModal(), 'pk-row')[0]?.click();
  await settle();
  assert.deepEqual(H.fsListCalls, ['/home']);
});

test('the quick zones mark where you are, without borrowing the accent', async () => {
  await openPicker();
  const zones = byClass(pkModal(), 'pk-zone');
  assert.deepEqual(
    zones.map((z) => z.textContent),
    ['Home', '~/projects', 'Root'],
  );
  assert.deepEqual(
    zones.map((z) => z.getAttribute('aria-pressed')),
    ['false', 'true', 'false'],
    'the picker opened in ~/projects',
  );
  assert.equal(zones[1]?.classList.contains('is-on'), true);
  zones[0]?.click();
  await settle();
  assert.deepEqual(
    byClass(pkModal(), 'pk-zone').map((z) => z.getAttribute('aria-pressed')),
    ['true', 'false', 'false'],
  );
  assert.deepEqual(rowNames(), ['projects', 'sandbox']);
});

// ===========================================================================
// 4. + folder
// ===========================================================================

test('+ folder posts the name into the current folder, clears the field and navigates into it', async () => {
  await openPicker();
  const input = one(pkModal(), 'pk-mkname');
  const mk = one(pkModal(), 'pk-mk');
  assert.equal(mk.textContent, '+ folder');
  assert.equal(input.getAttribute('aria-label'), 'Name for a new folder');

  // An empty name is no request at all; the field gets the focus back.
  mk.click();
  await settle();
  assert.deepEqual(H.mkdirCalls, []);
  assert.equal(dom.doc.activeElement, input);

  input.value = '  fresh  ';
  H.fsListCalls.length = 0;
  dispatch(input, 'keydown', { key: 'Enter' }); // Enter in the field is the same action
  await settle();
  assert.deepEqual(H.mkdirCalls, [{ path: '/home/tester/projects', name: 'fresh' }]);
  assert.equal(input.value, '', 'the field is empty again');
  assert.deepEqual(H.fsListCalls, ['/home/tester/projects/fresh'], 'and we are standing in it');
  assert.deepEqual(textsOf(pkModal(), 'pk-crumb'), ['/', 'home', 'tester', 'projects', 'fresh']);
  assert.equal(mk.disabled, false, 'the button is handed back');
});

// ===========================================================================
// 5. Choose this folder
// ===========================================================================

test('Choose this folder hands the CURRENT directory back, closes only the picker, restores focus', async () => {
  await openPicker();
  const suggested = one(pathRow(), 'ap-path');
  assert.equal(suggested.textContent, '/home/tester/projects/…', 'the dialog only suggested until now');
  assert.ok(suggested.classList.contains('is-suggested'));

  byClass(pkModal(), 'pk-row')[0]?.click(); // into /home/tester/projects/api
  await settle();
  const choose = byClass(one(pkModal(), 'pk-ft'), 'btn-accent')[0] as FakeElement;
  assert.equal(choose.textContent, 'Choose this folder');
  choose.click();
  await settle();

  assert.equal(PK.isFolderPickerOpen(), false);
  assert.equal(modalHost.children.length, 1, 'the picker is removed, the dialog stays');
  assert.equal(NP.isNewProjectDialogOpen(), true);
  assert.equal(one(pathRow(), 'ap-path').textContent, '/home/tester/projects/api');
  assert.equal(
    one(pathRow(), 'ap-path').classList.contains('is-suggested'),
    false,
    'a browsed path is no longer a suggestion',
  );
  assert.equal(dom.doc.activeElement, pathRow(), 'focus goes back to the row that opened it');
});

test('the commitment is dead until the first listing resolves: no empty path ever reaches the opener', async () => {
  if (PK.isFolderPickerOpen()) PK.closeFolderPicker();
  NP.closeNewProjectDialog();
  const picked: string[] = [];
  // Opened WITHOUT settling: the fs/list promise is still in flight, so the
  // picker knows no current directory yet.
  PK.openFolderPicker({
    modalHost,
    title: 'Select project folder',
    initial: '/home/tester/projects',
    onSelect: (p) => picked.push(p),
  });
  const choose = byClass(one(pkModal(), 'pk-ft'), 'btn-accent')[0] as FakeElement;
  assert.equal(choose.disabled, true, 'nothing to choose before the first listing');
  choose.click(); // the double dispatches to disabled controls; a browser would not
  assert.deepEqual(picked, [], 'no empty path reaches the opener');
  assert.equal(PK.isFolderPickerOpen(), true, 'and it did not close on that press');

  await settle();
  assert.equal(choose.disabled, false, 'the first listing arms it');
  assert.equal(dom.doc.activeElement, choose, 'and the keyboard lands on it');
  choose.click();
  assert.deepEqual(picked, ['/home/tester/projects']);
  assert.equal(PK.isFolderPickerOpen(), false);
});

test('Cancel, the ×, the scrim and closeFolderPicker() all leave the dialog underneath alone', async () => {
  for (const shut of [
    (): void => byClass(one(pkModal(), 'pk-ft'), 'btn-quiet')[0]?.click(),
    (): void => one(pkModal(), 'pk-x').click(),
    (): void => void dispatch(pkScrim(), 'mousedown'),
    (): void => PK.closeFolderPicker(), // what main.ts calls on Esc
  ]) {
    await openPicker();
    const before = one(pathRow(), 'ap-path').textContent;
    shut();
    await settle();
    assert.equal(PK.isFolderPickerOpen(), false);
    assert.equal(modalHost.children.length, 1);
    assert.equal(NP.isNewProjectDialogOpen(), true);
    assert.equal(one(pathRow(), 'ap-path').textContent, before, 'nothing was chosen');
    assert.equal(dom.doc.activeElement, pathRow());
  }
});

// ===========================================================================
// 6. Failures
// ===========================================================================

test("a refused listing states the backend's own reason as text and keeps the listing", async () => {
  await openPicker();
  const err = one(pkModal(), 'pk-err');
  assert.equal(err.getAttribute('role'), 'alert');
  assert.equal(err.hidden, true);

  H.failNext = 'permission denied: <img src=x onerror="alert(1)">';
  one(pkModal(), 'pk-up').click();
  await settle();
  assert.equal(err.hidden, false);
  assert.equal(err.children.length, 1, 'a server string is one text node, not a parsed tree');
  assert.ok(err.children[0] instanceof FakeText);
  assert.equal(err.textContent, 'permission denied: <img src=x onerror="alert(1)">');
  assert.deepEqual(rowNames(), ['api', '<b>web</b>'], 'the listing that was there is still there');
  assert.deepEqual(textsOf(pkModal(), 'pk-crumb'), ['/', 'home', 'tester', 'projects']);
});

test('a refused + folder states the reason as TEXT, keeps the typed name, and navigates nowhere', async () => {
  // The mkdir path's own failure branch: the listing test above covers fsList
  // only, and the two branches surface through the same `pk-err` row.
  await openPicker();
  const input = one(pkModal(), 'pk-mkname');
  const mk = one(pkModal(), 'pk-mk');
  const err = one(pkModal(), 'pk-err');
  input.value = 'note<b>s</b>';
  H.mkdirCalls.length = 0;
  H.fsListCalls.length = 0;
  H.failNextMkdir = 'permission denied: <img src=x onerror="alert(1)">';
  mk.click();
  await settle();
  assert.deepEqual(H.mkdirCalls, [{ path: '/home/tester/projects', name: 'note<b>s</b>' }]);
  assert.equal(err.hidden, false);
  assert.equal(err.children.length, 1, 'a server string is one text node, not a parsed tree');
  assert.ok(err.children[0] instanceof FakeText);
  assert.equal(err.textContent, 'permission denied: <img src=x onerror="alert(1)">');
  assert.equal(input.value, 'note<b>s</b>', 'the name the user typed is NOT thrown away on a failure');
  assert.equal(mk.disabled, false, 'the button is handed back even on the failing path');
  assert.deepEqual(H.fsListCalls, [], 'a folder that was not created is not walked into');
  assert.deepEqual(rowNames(), ['api', '<b>web</b>'], 'the listing that was there is still there');
  assert.deepEqual(textsOf(pkModal(), 'pk-crumb'), ['/', 'home', 'tester', 'projects']);

  // And a retry from the same field works: the message goes, the folder is made.
  H.mkdirCalls.length = 0;
  input.value = 'fresh';
  mk.click();
  await settle();
  assert.deepEqual(H.mkdirCalls, [{ path: '/home/tester/projects', name: 'fresh' }]);
  assert.equal(err.hidden, true, 'a successful action clears the message');
  assert.equal(input.value, '');
});

test('the Root quick zone stands at /, disables up, and + folder there posts "/" itself — never "//"', async () => {
  await openPicker();
  H.fsListCalls.length = 0;
  byClass(pkModal(), 'pk-zone')[2]?.click(); // Root
  await settle();
  assert.deepEqual(H.fsListCalls, ['/']);
  assert.deepEqual(textsOf(pkModal(), 'pk-crumb'), ['/']);
  assert.deepEqual(textsOf(pkModal(), 'pk-sep'), [], 'one segment needs no separator');
  assert.equal(one(pkModal(), 'pk-up').disabled, true, 'nowhere up from the root');
  assert.deepEqual(
    byClass(pkModal(), 'pk-zone').map((z) => z.getAttribute('aria-pressed')),
    ['false', 'false', 'true'],
  );

  const input = one(pkModal(), 'pk-mkname');
  input.value = 'thing';
  H.mkdirCalls.length = 0;
  H.fsListCalls.length = 0;
  one(pkModal(), 'pk-mk').click();
  await settle();
  // The picker hands the root over as exactly "/" and lets the backend join —
  // it never composes a path itself here, so "//thing" cannot be spelled.
  assert.deepEqual(H.mkdirCalls, [{ path: '/', name: 'thing' }]);
  assert.deepEqual(H.fsListCalls, ['/thing'], "and it walks into the answer's own path");
  assert.deepEqual(textsOf(pkModal(), 'pk-crumb'), ['/', 'thing']);
  assert.equal(one(pkModal(), 'pk-up').disabled, false, 'one level down, up is live again');
});

test("the Home quick zone resolves through fsList: an unknown home asks the backend for its OWN $HOME", async () => {
  // `/home/...` is nowhere in picker.ts (pinned in tests/ui/ui-picker-a7.test.ts):
  // Home is either the path the opener resolved from GET /api/fs/list, or — when
  // that probe failed — the absence of a path, which IS the backend's default.
  if (PK.isFolderPickerOpen()) PK.closeFolderPicker();
  NP.closeNewProjectDialog();
  const opener = dom.doc.createElement('button');
  dom.body.append(opener);
  const picked: string[] = [];
  H.fsListCalls.length = 0;
  PK.openFolderPicker({
    modalHost,
    title: 'Select destination folder',
    initial: '/home/tester/projects',
    projectsDir: null, // the probe found no <home>/projects
    restoreTo: opener,
    onSelect: (p) => picked.push(p),
  });
  await settle();
  assert.deepEqual(
    byClass(pkModal(), 'pk-zone').map((z) => z.textContent),
    ['Home', 'Root'],
    'no ~/projects zone when the opener has none to offer',
  );
  assert.deepEqual(H.fsListCalls, ['/home/tester/projects']);

  H.fsListCalls.length = 0;
  byClass(pkModal(), 'pk-zone')[0]?.click();
  await settle();
  assert.deepEqual(H.fsListCalls, [undefined], 'Home with no known path = one fs/list with NO path');
  assert.deepEqual(rowNames(), ['projects', 'sandbox']);
  assert.deepEqual(
    byClass(pkModal(), 'pk-zone').map((z) => z.getAttribute('aria-pressed')),
    ['false', 'false'],
    'an unresolved Home is never MARKED as where you are (it was never a path)',
  );
  // What comes back is the directory the BACKEND named, not the undefined we asked with.
  byClass(one(pkModal(), 'pk-ft'), 'btn-accent')[0]?.click();
  await settle();
  assert.deepEqual(picked, ['/home/tester']);
  assert.equal(PK.isFolderPickerOpen(), false);
  assert.equal(dom.doc.activeElement, opener);
  opener.remove();
});

test('the restore target belongs to the FIRST opener, and an opener that vanished is no crash', async () => {
  await openPicker(); // opened from the Add-a-project folder row
  const other = dom.doc.createElement('button');
  dom.body.append(other);
  PK.openFolderPicker({ modalHost, title: 'Select destination folder', restoreTo: other, onSelect: () => {} });
  await settle();
  assert.equal(one(pkModal(), 'pk-title').textContent, 'Select project folder', 'still the first picker');
  PK.closeFolderPicker();
  assert.equal(dom.doc.activeElement, pathRow(), 'the refused open did not steal the restore target');

  // An opener removed from the page while the picker was up: closing may not
  // throw, and it may not focus an element that is no longer in the document.
  const gone = dom.doc.createElement('button');
  dom.body.append(gone);
  PK.openFolderPicker({ modalHost, title: 'Select project folder', restoreTo: gone, onSelect: () => {} });
  await settle();
  gone.remove();
  PK.closeFolderPicker();
  assert.equal(PK.isFolderPickerOpen(), false);
  assert.equal(modalHost.children.length, 1, 'the picker is gone from the host');
  assert.notEqual(dom.doc.activeElement, gone, 'a detached opener is never focused');
  other.remove();
});

test('the clone tab opens the same picker with its own words', async () => {
  if (PK.isFolderPickerOpen()) PK.closeFolderPicker();
  NP.closeNewProjectDialog();
  NP.openNewProjectDialog('clone');
  await settle();
  const destRow = byClass(apModal, 'ap-pathrow')[1] as FakeElement;
  destRow.click();
  await settle();
  assert.equal(one(pkModal(), 'pk-title').textContent, 'Select destination folder');
  PK.closeFolderPicker();
  assert.equal(dom.doc.activeElement, destRow);
});

// A FsListResponse is what the stub answers with; this keeps the import honest.
const shape: FsListResponse = { path: '/home/tester', dirs: ['projects'], empty: false };
test('non-vacuity: the stub speaks the real protocol shape', () => {
  assert.deepEqual(Object.keys(shape).sort(), ['dirs', 'empty', 'path']);
});
