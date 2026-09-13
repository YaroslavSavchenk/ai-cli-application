/**
 * `web/src/ui/newproject.ts` — the Add-a-project dialog (Nocturne A7, half b)
 * driven through the REAL module on the DOM double in `tests/fake-dom.ts`.
 *
 * WHY THIS FILE EXISTS. A7 restyled this dialog, and every test it had was a
 * SOURCE scan (`tests/ui-addproject-a7.test.ts` for the style contract,
 * `tests/ui-newproject-add.test.ts` for the create-vs-add wiring) or a pure
 * model test (`tests/ui-newproject*.test.ts`, `tests/ui-github-model.test.ts`).
 * Nothing clicked the dialog. These are the behaviours a restyle can break
 * without a single regex noticing:
 *
 *   1. The new tab row is a GROUP of aria-pressed buttons, not a tablist — so
 *      every tab stays reachable with Tab alone (no roving tabindex here), and
 *      the pressed state moves with the panel that is shown.
 *   2. The git-init checklist row is a button carrying aria-pressed and its own
 *      ✓ box, and it really toggles (it is the `gitInit` flag the create request
 *      sends).
 *   3. The busy state disables the tabs, Cancel, the × and the primary, refuses
 *      to close, and lets go of all of it again when the clone answers.
 *   4. Inline errors are TEXT: an error string that looks like markup lands as
 *      one text node, never as parsed nodes — plus a source pin that neither
 *      module mentions innerHTML at all.
 *
 * The four non-pure imports are stubbed (`../api.ts`, `../state.ts` for the
 * dialog, its GitHub panel and the folder picker); the REAL `ui/util.ts`,
 * `ui/github.ts`, `ui/github-model.ts`, `ui/newproject-model.ts`,
 * `ui/launch-args.ts` and `ui/picker.ts` take part. Layout, hit-testing and
 * screen-reader output stay manual (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import type { FsListResponse, Project } from '../shared/protocol.ts';
import { byClass, dispatch, installDom, textsOf, type FakeElement, FakeText } from './fake-dom.ts';
import { projectRoot } from './helpers.ts';

const dom = installDom();

// ===========================================================================
// Harness + module stubs
// ===========================================================================

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  projects: Project[];
  setProjectsCalls: Project[][];
  drawers: string[];
  fsList: FsListResponse;
  fsListCalls: string[];
  /** The next clone answers through this, so the busy state can be inspected. */
  clone: Deferred<Project> | null;
  cloneCalls: { url: string; dest: string }[];
  localCalls: unknown[];
  addCalls: unknown[];
  localAnswer: Deferred<Project> | null;
}

const H: Harness = {
  projects: [],
  setProjectsCalls: [],
  drawers: [],
  fsList: { path: '/home/tester', dirs: ['projects'], empty: false },
  fsListCalls: [],
  clone: null,
  cloneCalls: [],
  localCalls: [],
  addCalls: [],
  localAnswer: null,
};
(globalThis as unknown as Record<string, unknown>).__apHarness = H;

const STUB_SRC: Record<string, string> = {
  api: `
    const H = globalThis.__apHarness;
    export class ApiError extends Error {
      constructor(status, message) { super(message); this.status = status; }
    }
    export async function fsList(path) { H.fsListCalls.push(path ?? ''); return H.fsList; }
    export async function fsMkdir() { throw new Error('not used'); }
    export async function cloneProject(body) {
      H.cloneCalls.push(body);
      if (H.clone === null) throw new Error('no clone answer armed');
      return H.clone.promise;
    }
    export async function createLocalProject(body) {
      H.localCalls.push(body);
      if (H.localAnswer === null) throw new Error('no create answer armed');
      return H.localAnswer.promise;
    }
    export async function createProject(body) {
      H.addCalls.push(body);
      if (H.localAnswer === null) throw new Error('no create answer armed');
      return H.localAnswer.promise;
    }
    export async function githubStatus() { return { deviceFlowAvailable: false, state: 'disconnected' }; }
    export async function githubDevice() { throw new Error('not used'); }
    export async function githubDisconnect() { throw new Error('not used'); }
    export async function githubRepos() { return { repos: [] }; }
    export async function githubToken() { throw new Error('not used'); }
    export async function githubClone() { throw new Error('not used'); }
    export async function githubCreateRepo() { throw new Error('not used'); }`,
  state: `
    const H = globalThis.__apHarness;
    export const state = {
      get projects() { return H.projects; },
      sessions: new Map(),
    };
    export function setProjects(ps) { H.setProjectsCalls.push(ps); H.projects = ps; }
    export function openDrawer(which) { H.drawers.push(which); }
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
      parent.endsWith('/web/src/ui/newproject.ts') ||
      parent.endsWith('/web/src/ui/github.ts') ||
      parent.endsWith('/web/src/ui/picker.ts');
    if (mine) {
      const m = /^\.\.\/(api|state)\.ts$/.exec(specifier);
      if (m !== null) return { url: `ap-stub:${m[1] as string}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('ap-stub:')) {
      return { format: 'module', source: STUB_SRC[url.slice('ap-stub:'.length)], shortCircuit: true };
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

// A computed specifier: the server tsconfig must not walk the browser graph.
const NP = (await import(
  new URL('../web/src/ui/newproject.ts', import.meta.url).href
)) as NewProjectModule;

const modalHost = dom.doc.createElement('div');
const gear = dom.doc.createElement('button');
dom.body.append(modalHost, gear);
NP.initNewProjectDialog(modalHost);

const scrim = modalHost.children[0] as FakeElement;
const modal = scrim.children[0] as FakeElement;

/** Two microtask turns: the `ensureHome()` / submit promises settle. */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const one = (root: FakeElement, cls: string): FakeElement => {
  const hit = byClass(root, cls)[0];
  assert.ok(hit !== undefined, `no .${cls} in the dialog`);
  return hit;
};
const tabOf = (label: string): FakeElement => {
  const hit = byClass(modal, 'ap-tab').find((b) => b.textContent === label);
  assert.ok(hit !== undefined, `no tab "${label}"`);
  return hit;
};

/**
 * The three panels, in mount order: New folder, Clone, the GitHub panel (whose
 * root carries `ap-panel` too). Every lookup is scoped to one of them, or to the
 * footer — the GitHub panel has its OWN `btn-accent` ("Connect with GitHub") and
 * its own mono `ap-field`, so a modal-wide query would grab the wrong element.
 */
const panels = (): FakeElement[] => byClass(modal, 'ap-panel');
const blankPanel = (): FakeElement => panels()[0] as FakeElement;
const clonePanel = (): FakeElement => panels()[1] as FakeElement;
const footer = (): FakeElement => one(modal, 'ap-ft');
const primary = (): FakeElement => one(footer(), 'btn-accent');
const cancel = (): FakeElement => one(footer(), 'btn-quiet');
const closeX = (): FakeElement => one(modal, 'ap-x');
const err = (): FakeElement => one(modal, 'ap-err');
const nameInput = (): FakeElement => byClass(blankPanel(), 'ap-field')[0]?.children[1] as FakeElement;
const urlInput = (): FakeElement => {
  const field = byClass(clonePanel(), 'ap-field')[0];
  assert.ok(field !== undefined, 'no Repository address field');
  assert.ok(field.classList.contains('is-mono'), 'the address is the one mono field on the tab');
  return field.children[1] as FakeElement;
};

async function reopen(mode: 'blank' | 'clone' | 'github' = 'blank'): Promise<void> {
  NP.closeNewProjectDialog();
  gear.focus();
  NP.openNewProjectDialog(mode);
  await settle();
}

// ===========================================================================
// The shell and the tab row
// ===========================================================================

test('the dialog is a modal on the shared scrim, closed at boot, with one title and a close', () => {
  assert.equal(scrim.hidden, true);
  assert.equal(scrim.className, 'modal-scrim ap-scrim', 'ui/keys.ts finds an open dialog by .modal-scrim');
  assert.equal(modal.className, 'ap-modal');
  assert.equal(modal.getAttribute('role'), 'dialog');
  assert.equal(modal.getAttribute('aria-modal'), 'true');
  assert.equal(modal.getAttribute('aria-labelledby'), 'ap-title');
  assert.equal(one(modal, 'ap-title').textContent, 'Add a project');
  assert.equal(one(modal, 'ap-title').id, 'ap-title');
  assert.equal(one(modal, 'ap-sub').textContent, 'A project is a folder your sessions work in.');
  assert.equal(closeX().getAttribute('aria-label'), 'Close');
  assert.equal(closeX().textContent, '×');
});

test('the three ways in are a GROUP of aria-pressed buttons, all reachable with Tab', async () => {
  await reopen();
  const row = one(modal, 'ap-tabs');
  assert.equal(row.getAttribute('role'), 'group', 'a tablist would take the inactive tabs out of Tab order');
  assert.equal(row.getAttribute('aria-label'), 'Where the project comes from');
  assert.deepEqual(textsOf(modal, 'ap-tab'), ['New folder', 'Clone a repository', 'From GitHub']);
  for (const b of byClass(modal, 'ap-tab')) {
    assert.equal(b.tagName, 'BUTTON');
    assert.equal(b.hasAttribute('tabindex'), false, `${b.textContent} must not carry a tabindex`);
    assert.equal(b.tabIndex, 0, `${b.textContent} must stay a tab stop`);
    assert.equal(b.disabled, false);
  }
  assert.deepEqual(
    byClass(modal, 'ap-tab').map((b) => b.getAttribute('aria-pressed')),
    ['true', 'false', 'false'],
    'the dialog opens on New folder',
  );
  assert.ok(tabOf('New folder').classList.contains('is-on'));
});

test('a tab click moves the pressed state, the visible panel and the primary verb', async () => {
  await reopen();
  const panels = byClass(modal, 'ap-panel');
  assert.equal(panels.length, 3, 'New folder, Clone, GitHub');
  assert.deepEqual(
    panels.map((p) => p.hidden),
    [false, true, true],
  );
  assert.equal(primary().textContent, 'Create project');
  assert.equal(primary().hidden, false);

  tabOf('Clone a repository').click();
  assert.deepEqual(
    byClass(modal, 'ap-tab').map((b) => b.getAttribute('aria-pressed')),
    ['false', 'true', 'false'],
  );
  assert.deepEqual(
    byClass(modal, 'ap-panel').map((p) => p.hidden),
    [true, false, true],
  );
  assert.equal(primary().textContent, 'Clone repository');
  assert.equal(dom.doc.activeElement, urlInput(), 'focus lands in the field the tab is about');

  tabOf('From GitHub').click();
  assert.deepEqual(
    byClass(modal, 'ap-tab').map((b) => b.getAttribute('aria-pressed')),
    ['false', 'false', 'true'],
  );
  assert.equal(primary().hidden, true, 'the GitHub tab is view-only: no footer action');
  assert.equal(byClass(modal, 'ap-panel')[2]?.hidden, false);

  tabOf('New folder').click();
  assert.equal(primary().hidden, false);
  assert.equal(primary().textContent, 'Create project');
  assert.equal(dom.doc.activeElement, nameInput());
});

test('the GitHub chip can switch tabs on an ALREADY open dialog', async () => {
  await reopen('blank');
  NP.openNewProjectDialog('github');
  assert.equal(NP.isNewProjectDialogOpen(), true);
  assert.equal(tabOf('From GitHub').getAttribute('aria-pressed'), 'true');
});

// ===========================================================================
// New folder: the checklist row and the suggested path
// ===========================================================================

test('the git-init row is a pressed-state button, on by default, and it toggles', async () => {
  await reopen();
  const check = one(blankPanel(), 'ap-check');
  assert.equal(check.tagName, 'BUTTON', 'a checklist row, not a native checkbox');
  assert.equal(check.getAttribute('aria-pressed'), 'true', 'Initialize git repo is on by default');
  const box = byClass(check, 'ap-box')[0] as FakeElement;
  assert.equal(box.getAttribute('aria-hidden'), 'true', 'the ✓ is decoration; aria-pressed carries the state');
  assert.equal(box.textContent, '✓');
  assert.equal(byClass(check, 'ap-check-lb')[0]?.textContent, 'Initialize git repo');
  assert.equal(byClass(check, 'ap-check-sub')[0]?.textContent, 'starts version history');

  check.click();
  assert.equal(check.getAttribute('aria-pressed'), 'false');
  assert.equal(box.textContent, '');
  check.click();
  assert.equal(check.getAttribute('aria-pressed'), 'true');
  assert.equal(box.textContent, '✓');
  assert.equal(check.hidden, false, 'the create path keeps the toggle');
});

test('the folder row is ONE button that shows the suggested path, and the name feeds it', async () => {
  await reopen();
  const pathRow = one(blankPanel(), 'ap-pathrow');
  assert.equal(pathRow.tagName, 'BUTTON', 'the folder is never typed: one control, one tab stop');
  assert.equal(pathRow.getAttribute('aria-label'), 'Folder, opens the folder picker');
  assert.equal(byClass(pathRow, 'ap-browse')[0]?.textContent, 'Browse');
  const pathText = byClass(pathRow, 'ap-path')[0] as FakeElement;
  assert.equal(pathText.textContent, '/home/tester/projects/…', 'the home came from fs/list, never hardcoded');
  assert.ok(pathText.classList.contains('is-suggested'));

  nameInput().value = 'my-thing';
  dispatch(nameInput(), 'input');
  assert.equal(pathText.textContent, '/home/tester/projects/my-thing');
  assert.ok(pathText.classList.contains('is-suggested'), 'a suggestion stays marked as one until Browse');
  assert.equal(one(blankPanel(), 'ap-note').textContent, 'The folder is created if it does not exist yet.');
  assert.equal(one(blankPanel(), 'ap-pathnote').hidden, true, 'no verdict until a folder is browsed to');
});

test('a missing name or a missing address is refused inline, without a request', async () => {
  await reopen();
  const before = H.localCalls.length;
  primary().click();
  await settle();
  assert.equal(err().hidden, false);
  assert.equal(err().textContent, 'A project name is required.');
  assert.equal(err().getAttribute('role'), 'alert');
  assert.equal(dom.doc.activeElement, nameInput(), 'focus goes to the field that is missing');
  assert.equal(H.localCalls.length, before, 'nothing is sent');

  tabOf('Clone a repository').click();
  assert.equal(err().hidden, true, 'switching tabs clears the message');
  const cloneBefore = H.cloneCalls.length;
  primary().click();
  await settle();
  assert.equal(err().textContent, 'A repository address is required.');
  assert.equal(H.cloneCalls.length, cloneBefore);
});

// ===========================================================================
// The busy state
// ===========================================================================

test('a clone in flight disables the tabs, Cancel, the × and the primary — and refuses to close', async () => {
  await reopen('clone');
  urlInput().value = 'https://github.com/owner/repo.git';
  dispatch(urlInput(), 'input');
  const destRow = one(clonePanel(), 'ap-pathrow');
  assert.equal(
    byClass(destRow, 'ap-path')[0]?.textContent,
    '/home/tester/projects/repo',
    'the destination is suggested from the address',
  );

  H.clone = deferred<Project>();
  primary().click();
  await settle();

  const busy = one(footer(), 'ap-busy');
  assert.equal(busy.hidden, false);
  assert.equal(byClass(busy, 'ap-spinner')[0]?.getAttribute('aria-hidden'), 'true');
  assert.equal(busy.textContent, 'Cloning the repository, this can take a while');
  assert.equal(primary().disabled, true);
  assert.equal(cancel().disabled, true);
  assert.equal(closeX().disabled, true);
  assert.equal(urlInput().disabled, true);
  assert.equal(destRow.disabled, true);
  for (const b of byClass(modal, 'ap-tab')) assert.equal(b.disabled, true, `${b.textContent} stays put`);
  assert.deepEqual(H.cloneCalls.at(-1), {
    url: 'https://github.com/owner/repo.git',
    dest: '/home/tester/projects/repo',
  });

  // Every way out is held while the clone runs: the API, the scrim, Esc's caller.
  NP.closeNewProjectDialog();
  assert.equal(NP.isNewProjectDialogOpen(), true, 'the dialog never closes mid-clone');
  dispatch(scrim, 'mousedown');
  assert.equal(NP.isNewProjectDialogOpen(), true);

  // A failure hands everything back and states the server's own reason.
  H.clone.reject(new Error('destination already exists'));
  await settle();
  assert.equal(one(footer(), 'ap-busy').hidden, true);
  assert.equal(err().hidden, false);
  assert.equal(err().textContent, 'destination already exists');
  assert.equal(primary().disabled, false);
  assert.equal(cancel().disabled, false);
  assert.equal(closeX().disabled, false);
  assert.equal(urlInput().disabled, false);
  for (const b of byClass(modal, 'ap-tab')) assert.equal(b.disabled, false);
  assert.equal(NP.isNewProjectDialogOpen(), true, 'a failed clone leaves the form up to retry');
});

test('a clone that succeeds adds the project and closes the dialog', async () => {
  await reopen('clone');
  urlInput().value = 'https://github.com/owner/repo.git';
  dispatch(urlInput(), 'input');
  H.projects = [];
  H.clone = deferred<Project>();
  primary().click();
  await settle();
  const p: Project = {
    id: 'p9',
    name: 'repo',
    path: '/home/tester/projects/repo',
    createdAt: new Date().toISOString(),
  };
  H.clone.resolve(p);
  await settle();
  assert.deepEqual(H.setProjectsCalls.at(-1), [p]);
  assert.equal(NP.isNewProjectDialogOpen(), false);
  assert.equal(dom.doc.activeElement, gear, 'focus goes back where the dialog was opened from');
});

test('the create path sends the git-init flag the row shows, and the optional selects when set', async () => {
  await reopen();
  nameInput().value = 'thing';
  dispatch(nameInput(), 'input');
  one(blankPanel(), 'ap-check').click(); // git init OFF
  H.localAnswer = deferred<Project>();
  primary().click();
  await settle();
  assert.deepEqual(H.localCalls.at(-1), {
    name: 'thing',
    path: '/home/tester/projects/thing',
    gitInit: false,
  });
  assert.equal(primary().disabled, true, 'the button is held while the create is in flight');
  H.localAnswer.resolve({
    id: 'p1',
    name: 'thing',
    path: '/home/tester/projects/thing',
    createdAt: new Date().toISOString(),
  });
  await settle();
  assert.equal(NP.isNewProjectDialogOpen(), false);

  // A fresh open resets the form, including the toggle.
  await reopen();
  assert.equal(one(blankPanel(), 'ap-check').getAttribute('aria-pressed'), 'true');
  assert.equal(nameInput().value, '');
  assert.equal(err().hidden, true);
});

// ===========================================================================
// Errors are text, never markup
// ===========================================================================

test('an error message that looks like markup lands as ONE text node', async () => {
  await reopen('clone');
  urlInput().value = 'https://example.com/x.git';
  dispatch(urlInput(), 'input');
  H.clone = deferred<Project>();
  primary().click();
  await settle();
  const evil = '<img src=x onerror="alert(1)"> & <b>bold</b>';
  H.clone.reject(new Error(evil));
  await settle();
  const node = err().children[0];
  assert.equal(err().children.length, 1, 'a server string is one text node, not a parsed tree');
  assert.ok(node instanceof FakeText, 'the message is a text node');
  assert.equal(err().textContent, evil, 'and it is rendered verbatim, tags and all');
});

test('neither module mentions innerHTML at all (untrusted paths, urls and errors are text)', () => {
  const ui = join(projectRoot, 'web', 'src', 'ui');
  for (const f of ['newproject.ts', 'github.ts', 'picker.ts', 'settings.ts', 'term-colours.ts']) {
    const src = readFileSync(join(ui, f), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment/.test(code), false, f);
    assert.ok(code.length > 500, `non-vacuity: ${f} scanned (${code.length} chars)`);
  }
});
