/**
 * The GitHub repo list re-asks the server every time it becomes visible
 * (fix/github-repo-refresh, 2026-11-24): `refreshRepos` in
 * `web/src/ui/github-state.ts`, wired by `createGithubPanel().setActive` and a
 * window `focus` listener in `web/src/ui/github.ts`, deciding through
 * `repoRefreshMode` / `sameRepoList` in `web/src/ui/github-model.ts`.
 *
 * HOW. The REAL `ui/github.ts` (with its state, token and new-repo modules) on
 * the DOM double in `tests/helpers/fake-dom.ts`; `../api.ts` and `../state.ts`
 * are stubbed for those modules only. Every `githubRepos` call is recorded and
 * answers through its own promise, so a test decides WHEN each answer lands —
 * the only way to see the old rows while a reload is in flight, and to land a
 * stale reload after a newer search. The two model rules are called directly.
 *
 * WHY. The server keeps no cache, but the panel used to load the list once, on
 * reaching "connected": a repository created on github.com afterwards never
 * showed up until a page reload, however often the user closed and reopened
 * the list. A regression here is silent — the list just stays old.
 *
 * NOT claimed: what GitHub's `/user/repos` itself returns for a new repository
 * (that was checked live against github.com, see the fix's report), layout and
 * real focus — the browser's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { GithubRepo } from '../../shared/protocol.ts';
import { byClass, dispatch, FakeElement, installDom, textsOf } from '../helpers/fake-dom.ts';
import { drainMicrotasks } from '../helpers/helpers.ts';
import { repoRefreshMode, sameRepoList } from '../../web/src/ui/github-model.ts';

const dom = installDom();

// ===========================================================================
// Harness + module stubs
// ===========================================================================

interface RepoCall {
  q: string;
  /** `Promise.withResolvers()` from the stub (the tests' tsconfig lib predates its type). */
  answer: { resolve(v: { repos: GithubRepo[] }): void; reject(e: unknown): void };
}

const H = { repoCalls: [] as RepoCall[] };
(globalThis as unknown as Record<string, unknown>).__ghRefresh = H;

const STUB_SRC: Record<string, string> = {
  api: `
    const H = globalThis.__ghRefresh;
    export class ApiError extends Error {
      constructor(status, message) { super(message); this.status = status; }
    }
    export async function fsList() { return { path: '/home/you', dirs: [], empty: false }; }
    export async function githubStatus() {
      return { deviceFlowAvailable: false, state: 'connected', login: 'you', source: 'pat' };
    }
    export async function githubDevice() { throw new Error('not used'); }
    export async function githubDisconnect() { throw new Error('not used'); }
    export function githubRepos(q) {
      const answer = Promise.withResolvers();
      H.repoCalls.push({ q: q ?? '', answer });
      return answer.promise;
    }
    export async function githubToken() { throw new Error('not used'); }
    export async function githubClone() { throw new Error('not used'); }
    export async function githubCreateRepo() { throw new Error('not used'); }`,
  state: `
    export const state = { projects: [], sessions: new Map() };
    export function setProjects() {}`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? '';
    const mine = /\/web\/src\/ui\/github(-state|-token|-newrepo)?\.ts$/.test(parent);
    if (mine) {
      const m = /^\.\.\/(api|state)\.ts$/.exec(specifier);
      if (m !== null) return { url: `gh-refresh-stub:${m[1] as string}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('gh-refresh-stub:')) {
      const name = url.slice('gh-refresh-stub:'.length);
      return { format: 'module', source: STUB_SRC[name], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

interface GithubModule {
  createGithubPanel(): { el: FakeElement; setActive(active: boolean): void };
}

// A computed specifier: the server tsconfig must not walk the browser graph.
const GH = (await import(new URL('../../web/src/ui/github.ts', import.meta.url).href)) as GithubModule;

const panel = GH.createGithubPanel();
dom.body.append(panel.el);

const settle = (): Promise<void> => drainMicrotasks(6);

function repo(name: string): GithubRepo {
  return {
    fullName: `you/${name}`,
    name,
    owner: 'you',
    private: true,
    pushedAt: '2026-11-24T10:00:00Z',
    cloneUrl: `https://github.com/you/${name}.git`,
  };
}

const shown = (): string[] => textsOf(panel.el, 'gh-repo-name');
const messages = (): string[] => textsOf(panel.el, 'gh-msg').filter((t) => t !== '');

/** The newest `githubRepos` call; fails when there is none. */
function lastCall(): RepoCall {
  const c = H.repoCalls.at(-1);
  assert.ok(c !== undefined, 'no githubRepos call was made');
  return c;
}

/** Close the list, then open it again — what the user does with the dialog tab. */
async function reopen(): Promise<void> {
  panel.setActive(false);
  panel.setActive(true);
  await settle();
}

function fireWindowFocus(): void {
  for (const h of dom.win.handlers) if (h.type === 'focus') h.fn({} as never);
}

const searchInput = (): FakeElement => {
  const hit = byClass(panel.el, 'gh-search')[0];
  assert.ok(hit !== undefined, 'no search box');
  return hit;
};

/** Type into the search box and let its debounce timer run. */
async function search(text: string): Promise<void> {
  const input = searchInput();
  input.value = text;
  dispatch(input, 'input');
  const debounce = dom.win.timers.at(-1);
  assert.ok(debounce !== undefined, 'the search armed no debounce timer');
  dom.win.timers.splice(dom.win.timers.indexOf(debounce), 1);
  debounce.fn();
  await settle();
}

// ===========================================================================
// The panel (tests share the module's state and run in order)
// ===========================================================================

test('the first open connects and loads the list once', async () => {
  panel.setActive(true);
  await settle();
  assert.equal(H.repoCalls.length, 1, 'reaching connected loads the list');
  lastCall().answer.resolve({ repos: [repo('alpha')] });
  await settle();
  assert.deepEqual(shown(), ['you/alpha']);
});

test('opening the list a second time asks the server again', async () => {
  const before = H.repoCalls.length;
  await reopen();
  assert.equal(H.repoCalls.length, before + 1, 'a reopen must re-ask GitHub — the server keeps no cache');
  assert.equal(lastCall().q, '', 'with the search box empty, the whole list is asked for');
});

test('the old rows stay visible, with no loading line, while the reload is in flight', () => {
  assert.deepEqual(shown(), ['you/alpha'], 'the list on screen must not flash away');
  assert.deepEqual(messages(), [], 'no "Loading your repositories" over a usable list');
});

test('the reload answer replaces the list: a repository created since shows up', async () => {
  lastCall().answer.resolve({ repos: [repo('fresh'), repo('alpha')] });
  await settle();
  assert.deepEqual(shown(), ['you/fresh', 'you/alpha']);
});

test('an answer identical to the list on screen does not rebuild the rows', async () => {
  const rowBefore = byClass(panel.el, 'gh-repo')[0];
  await reopen();
  lastCall().answer.resolve({ repos: [repo('fresh'), repo('alpha')] });
  await settle();
  assert.equal(byClass(panel.el, 'gh-repo')[0], rowBefore, 'a rebuild would drop focus from a row button');
});

test('a newer search beats a stale reload that answers after it', async () => {
  await reopen();
  const reload = lastCall();
  await search('alp');
  const searched = lastCall();
  assert.notEqual(searched, reload, 'the search made its own request');
  assert.equal(searched.q, 'alp');
  searched.answer.resolve({ repos: [repo('alpha')] });
  await settle();
  reload.answer.resolve({ repos: [repo('fresh'), repo('alpha'), repo('stale')] });
  await settle();
  assert.deepEqual(shown(), ['you/alpha'], 'the reload started before the search must be dropped');
});

test('a reopen while a search is in flight leaves the search to answer', async () => {
  await search('fre');
  const searched = lastCall();
  const before = H.repoCalls.length;
  await reopen();
  assert.equal(H.repoCalls.length, before, 'no second request while one is already in flight');
  searched.answer.resolve({ repos: [repo('fresh')] });
  await settle();
  assert.deepEqual(shown(), ['you/fresh']);
});

test('a reopen re-asks with the text still in the search box', async () => {
  const before = H.repoCalls.length;
  await reopen();
  assert.equal(H.repoCalls.length, before + 1, 'the reopen asked again');
  assert.equal(lastCall().q, 'fre', 'the rows on screen answer that search, so the reload must too');
  lastCall().answer.resolve({ repos: [repo('fresh')] });
  await settle();
});

test('a failed reload keeps the rows already shown', async () => {
  await reopen();
  lastCall().answer.reject(new Error('failed to reach github'));
  await settle();
  assert.deepEqual(shown(), ['you/fresh']);
  assert.deepEqual(messages(), [], 'a network blip does not replace a usable list with an error');
});

test('the window regaining focus re-asks while the list is open, and not while it is closed', async () => {
  const before = H.repoCalls.length;
  fireWindowFocus();
  await settle();
  assert.equal(H.repoCalls.length, before + 1, 'back from github.com with the list open: ask again');
  lastCall().answer.resolve({ repos: [repo('fresh')] });
  await settle();
  panel.setActive(false);
  fireWindowFocus();
  await settle();
  assert.equal(H.repoCalls.length, before + 1, 'a closed list asks nothing');
});

// ===========================================================================
// The two model rules
// ===========================================================================

test('repoRefreshMode: in flight skips, a shown list reloads in the background, else a full load', () => {
  const table = [
    ['loading', 'skip'],
    ['loaded', 'background'],
    ['idle', 'full'],
    ['error', 'full'],
  ] as const;
  for (const [state, mode] of table) assert.equal(repoRefreshMode(state), mode, `state ${state}`);
});

test('sameRepoList: equal only for the same repositories, facts and order', () => {
  const a = repo('a');
  const b = repo('b');
  assert.equal(sameRepoList([a, b], [repo('a'), repo('b')]), true, 'equal values');
  assert.equal(sameRepoList([a, b], [b, a]), false, 'order');
  assert.equal(sameRepoList([a], [a, b]), false, 'length');
  assert.equal(sameRepoList([], []), true, 'empty');
  const changed: [keyof GithubRepo, unknown][] = [
    ['fullName', 'you/x'],
    ['name', 'x'],
    ['owner', 'x'],
    ['private', false],
    ['description', 'now described'],
    ['language', 'Rust'],
    ['pushedAt', '2026-11-24T11:00:00Z'],
    ['cloneUrl', 'https://github.com/you/x.git'],
  ];
  for (const [key, value] of changed) {
    assert.equal(sameRepoList([a], [{ ...a, [key]: value }]), false, `a changed ${key}`);
  }
});

test('a row says "Python, Updated …" — the comma stays on the word it follows, never after a gap', async () => {
  await reopen();
  lastCall().answer.resolve({ repos: [{ ...repo('lang'), language: 'Python' }] });
  await settle();
  const meta = byClass(panel.el, 'gh-repo-meta')[0];
  assert.ok(meta !== undefined, 'the row has its facts line');
  const texts = meta.children
    .filter((c): c is FakeElement => c instanceof FakeElement && !c.classList.contains('gh-lang-dot'))
    .map((c) => c.textContent);
  assert.equal(texts.length, 1, 'language and push time are ONE text span: two put the flex gap before the comma');
  assert.match(texts[0] ?? '', /^Python, Updated /);
});
