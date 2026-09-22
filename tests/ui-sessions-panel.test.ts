/**
 * `web/src/ui/sessions.ts` — the Sessions panel, driven through the REAL module
 * after the Nocturne A5 restyle.
 *
 * WHY A HARNESS AND NOT A COPY TEST. A5 rewrote every row of this panel: the
 * model tag folded into the meta line, `split` became `Side by side`, the bare
 * `×` arms into a worded `End` / `Forget`, `resume`/`start again` became
 * `Continue`/`Start again`, and `placeOf()` (the tab/pane place) was deleted
 * from the meta line. A restyle that big can quietly take a BEHAVIOUR with it
 * — a button that no longer calls the split action, an armed confirm that
 * kills on the first click — and every source-scanning copy test stays green
 * while it does. So the rows are built by the real module and the buttons are
 * really clicked; only the four impure imports are stubbed
 * (`../api.ts`, `../log.ts`, `./panes.ts`, `./statusline.ts`), for sessions.ts
 * AND for `./history.ts`, which it renders through. `../state.ts`, `./util.ts`
 * (incl. the shared `ArmedSet`) and `./launch-args.ts` are the real modules.
 *
 * NOT claimed (browser, `.claude/skills/verify-terminal/SKILL.md`): layout,
 * colour, the 300px width, that a row is legible, real focus policy.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { HistoryEntry, Project, SessionInfo } from '../shared/protocol.ts';
import { byClass, byKey, dispatch, installDom, textsOf, type FakeElement } from './fake-dom.ts';

const dom = installDom();

// ---------------------------------------------------------------------------
// Stubs for the four impure imports (the same seam ui-launch-dialog.test.ts uses)
// ---------------------------------------------------------------------------

interface Harness {
  killed: string[];
  focusRequests: number;
  flashes: string[];
  resumed: string[];
  forgotten: string[];
  forgotAll: number;
  historyRefreshes: number;
  nextResume: SessionInfo | null;
}
const H: Harness = {
  killed: [],
  focusRequests: 0,
  flashes: [],
  resumed: [],
  forgotten: [],
  forgotAll: 0,
  historyRefreshes: 0,
  nextResume: null,
};
(globalThis as unknown as { __sessHarness: Harness }).__sessHarness = H;

const STUB_SRC: Record<string, string> = {
  api: `
    const H = globalThis.__sessHarness;
    export class ApiError extends Error { constructor(status, msg) { super(msg ?? 'x'); this.status = status; } }
    export async function getHistory() { return []; }
    export async function resumeHistory(id) { H.resumed.push(id); return H.nextResume; }
    export async function forgetHistory(id) { H.forgotten.push(id); }
    export async function forgetAllHistory() { H.forgotAll++; }`,
  log: `
    export const log = { debug() {}, info() {}, warn() {}, error() {} };
    export function formatError(e) { return String(e); }`,
  panes: `
    const H = globalThis.__sessHarness;
    export async function killSession(id) { H.killed.push(id); }
    export function requestTerminalFocus() { H.focusRequests++; }
    export function focusedPaneDims() { return { cols: 120, rows: 40 }; }`,
  statusline: `
    const H = globalThis.__sessHarness;
    export function flash(msg) { H.flashes.push(msg); }`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? '';
    if (parent.endsWith('/web/src/ui/sessions.ts') || parent.endsWith('/web/src/ui/history.ts')) {
      const m = /^(?:\.\.\/(api|log)|\.\/(panes|statusline))\.ts$/.exec(specifier);
      const name = m?.[1] ?? m?.[2];
      if (name !== undefined) return { url: `sess-stub:${name}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('sess-stub:')) {
      return { format: 'module', source: STUB_SRC[url.slice('sess-stub:'.length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

interface StateModule {
  state: {
    sessions: Map<string, SessionInfo>;
    projects: Project[];
    views: { id: string; root: { kind: string } | null; slots: { kind: string; id?: string }[]; focused: number }[];
    activeViewId: string;
    drawer: string | null;
    history: HistoryEntry[];
  };
  setSessions(list: SessionInfo[]): void;
  setProjects(list: Project[]): void;
  setHistory(list: HistoryEntry[]): void;
  viewOfSession(id: string): { id: string; slots: { kind: string; id?: string }[] } | undefined;
  sessionIds(v: { slots: { kind: string; id?: string }[] }): string[];
}
interface SessionsModule {
  initSessionsDrawer(host: unknown): { render(): void };
}

const st = (await import(new URL('../web/src/state.ts', import.meta.url).href)) as StateModule;
const S = (await import(new URL('../web/src/ui/sessions.ts', import.meta.url).href)) as SessionsModule;

const host = dom.doc.createElement('aside');
dom.body.append(host);
const drawer = S.initSessionsDrawer(host);
const root = host.children[0] as FakeElement;

function mkSession(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    title: id,
    command: 'claude',
    args: [],
    cwd: '/home/tester/api',
    status: 'running',
    cols: 80,
    rows: 24,
    createdAt: new Date().toISOString(),
    attention: false,
    ...over,
  } as SessionInfo;
}

function mkEntry(id: string, over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    title: id,
    command: 'claude',
    args: [],
    cwd: '/home/tester/api',
    projectId: 'p1',
    createdAt: new Date(Date.now() - 7200_000).toISOString(),
    lastUsedAt: new Date(Date.now() - 3600_000).toISOString(),
    ...over,
  } as HistoryEntry;
}

/** Force a rebuild: the drawer caches on a signature. */
function draw(): void {
  st.state.drawer = 'sessions';
  drawer.render();
}

beforeEach(() => {
  dom.storage.clear();
  H.killed.length = 0;
  H.flashes.length = 0;
  H.resumed.length = 0;
  H.forgotten.length = 0;
  H.forgotAll = 0;
  H.focusRequests = 0;
  H.nextResume = null;
  dom.win.timers.length = 0;
  st.state.views = [];
  st.state.activeViewId = '';
  st.state.history = [];
  st.setProjects([{ id: 'p1', name: 'api', path: '/home/tester/api', createdAt: '2026-01-01T00:00:00Z' } as Project]);
  st.setSessions([]);
});

// ---------------------------------------------------------------------------
// The live list
// ---------------------------------------------------------------------------

test('the section labels are the v3 words', () => {
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  st.state.history = [mkEntry('h1')];
  draw();
  assert.deepEqual(textsOf(root, 'drawer-sect'), ['Running now', 'EarlierClear']);
});

test('a running row: name + state for the screen reader, project and tool underneath', () => {
  st.setSessions([mkSession('s1', { projectId: 'p1', title: 'api work', args: ['--model', 'opus'] })]);
  draw();
  const open = byKey(root, 'show:s1') as FakeElement;
  assert.equal(open.getAttribute('aria-label'), 'api work, Working');
  assert.equal(open.title, 'Working');
  assert.equal(textsOf(root, 'sess-name')[0], 'api work');
  assert.equal(
    textsOf(root, 'sess-meta')[0],
    'api, Claude Code Opus',
    'the product name and the model, never the raw command or a place that truncates',
  );
});

test('a waiting row says the one thing that needs the user, and marks it', () => {
  st.setSessions([mkSession('s1', { projectId: 'p1', attention: true })]);
  draw();
  assert.equal(textsOf(root, 'sess-meta')[0], 'Needs your answer');
  assert.ok((byClass(root, 'sess-meta')[0] as FakeElement).classList.contains('is-attn'));
  assert.equal((byKey(root, 'show:s1') as FakeElement).getAttribute('aria-label'), 's1, Needs your answer');
});

test('an exited row names its project and how it finished', () => {
  st.setSessions([mkSession('s1', { projectId: 'p1', status: 'exited', exitCode: 3 })]);
  draw();
  assert.equal(textsOf(root, 'sess-meta')[0], 'api, Finished (3)');
});

test('a project-less session still says what runs in it, by product name', () => {
  st.setSessions([mkSession('s1', { command: '/bin/bash', args: ['-l'] })]);
  draw();
  assert.equal(textsOf(root, 'sess-meta')[0], 'Bash', 'never the command, never a path');
});

test('clicking the row takes you to that session and puts the keyboard in the terminal', () => {
  st.setSessions([mkSession('s1', { projectId: 'p1' }), mkSession('s2', { projectId: 'p1' })]);
  draw();
  (byKey(root, 'show:s2') as FakeElement).click();
  const v = st.viewOfSession('s2');
  assert.notEqual(v, undefined);
  assert.equal(st.state.activeViewId, v?.id, 'the tab holding it becomes the active one');
  assert.equal(H.focusRequests, 1);
});

test('"Side by side" really merges the session into the active tab', () => {
  st.setSessions([mkSession('s1', { projectId: 'p1' }), mkSession('s2', { projectId: 'p1' })]);
  draw();
  // A10: `Home` is views[0] and it is empty, so the tab under test is the one
  // that HOLDS s1 — never "the first tab".
  const first = st.viewOfSession('s1');
  assert.ok(first !== undefined, 'non-vacuity: s1 got a tab of its own');
  st.state.activeViewId = first.id;
  const btn = byKey(root, 'split:s2') as FakeElement;
  assert.equal(btn.textContent, 'Side by side');
  assert.equal(btn.getAttribute('aria-label'), 'show s2 next to the current session');

  btn.click();
  assert.deepEqual(st.sessionIds(first), ['s1', 's2'], 'one tab, two panes');
  assert.equal(st.state.views.length, 2, 'Home plus the merged tab: s2 left its own');
  assert.equal(H.focusRequests, 1);
});

test('"Side by side" on a full tab says so instead of silently doing nothing', () => {
  const ids = ['s1', 's2', 's3', 's4', 's5'];
  st.setSessions(ids.map((id) => mkSession(id, { projectId: 'p1' })));
  const first = st.viewOfSession('s1');
  assert.ok(first !== undefined, 'non-vacuity: s1 got a tab of its own');
  for (const id of ['s2', 's3', 's4']) {
    const v = st.viewOfSession(id);
    if (v !== undefined) {
      first.slots.push({ kind: 'session', id });
      st.state.views.splice(
        st.state.views.findIndex((x) => x.id === v.id),
        1,
      );
    }
  }
  st.state.activeViewId = first.id;
  draw();
  (byKey(root, 'split:s5') as FakeElement).click();
  assert.deepEqual(H.flashes, ['This tab is full. It can show 4 panes.']);
  assert.equal(first.slots.length, 4);
});

test('ending a session takes TWO clicks, and the first one only arms it', () => {
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  draw();
  const x = byKey(root, 'kill:s1') as FakeElement;
  assert.equal(x.textContent, '×');
  assert.equal(x.getAttribute('aria-label'), 'end session s1');

  x.click();
  assert.deepEqual(H.killed, [], 'the first click kills nothing');
  const armedBtn = byKey(root, 'kill:s1') as FakeElement;
  assert.equal(armedBtn.textContent, 'End', 'it arms into a WORD, never a bare glyph');
  assert.equal(armedBtn.dataset.armed, '1');
  assert.equal(armedBtn.getAttribute('aria-label'), 'end s1 now');
  assert.equal(armedBtn.title, 'Click again to end it');

  armedBtn.click();
  assert.deepEqual(H.killed, ['s1'], 'the second click ends it');
});

// ---------------------------------------------------------------------------
// Earlier (history)
// ---------------------------------------------------------------------------

test('an earlier entry with a pinned conversation offers Continue; one without, Start again', () => {
  st.state.history = [
    mkEntry('h1', { title: 'pinned', conversation: true }),
    mkEntry('h2', { title: 'unpinned', conversation: false }),
  ];
  draw();
  const a = byKey(root, 'hist-resume:h1') as FakeElement;
  const b = byKey(root, 'hist-resume:h2') as FakeElement;
  assert.equal(a.textContent, 'Continue');
  assert.equal(a.getAttribute('aria-label'), 'Continue pinned');
  assert.equal(b.textContent, 'Start again');
  assert.equal(b.getAttribute('aria-label'), 'Start again unpinned');
});

test('Continue posts the entry id and nothing else decides the argv', async () => {
  st.state.history = [mkEntry('h1', { conversation: true })];
  draw();
  H.nextResume = mkSession('new-1', { projectId: 'p1' });
  (byKey(root, 'hist-resume:h1') as FakeElement).click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(H.resumed, ['h1']);
  assert.ok(st.state.sessions.has('new-1'), 'the session it got back is adopted');
});

test('forgetting an entry is armed too, and the armed word is Forget', async () => {
  st.state.history = [mkEntry('h1')];
  draw();
  const x = byKey(root, 'hist-forget:h1') as FakeElement;
  assert.equal(x.textContent, '×');
  x.click();
  assert.deepEqual(H.forgotten, []);
  const armedBtn = byKey(root, 'hist-forget:h1') as FakeElement;
  assert.equal(armedBtn.textContent, 'Forget');
  assert.equal(armedBtn.getAttribute('aria-label'), 'forget h1 now');
  armedBtn.click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(H.forgotten, ['h1']);
});

test('Clear (all) is armed as well, and says what it will do', async () => {
  st.state.history = [mkEntry('h1'), mkEntry('h2')];
  draw();
  const all = byKey(root, 'hist-clear-all') as FakeElement;
  assert.equal(all.textContent, 'Clear');
  assert.equal(all.getAttribute('aria-label'), 'clear the earlier sessions');
  all.click();
  assert.equal(H.forgotAll, 0);
  const armedBtn = byKey(root, 'hist-clear-all') as FakeElement;
  assert.equal(armedBtn.textContent, 'Clear them all?');
  armedBtn.click();
  await new Promise((r) => setImmediate(r));
  assert.equal(H.forgotAll, 1);
});

test('earlier entries keep their per-project folders, collapsible, with a count', () => {
  st.setProjects([
    { id: 'p1', name: 'api', path: '/home/tester/api', createdAt: '2026-01-01T00:00:00Z' } as Project,
    { id: 'p2', name: 'web', path: '/home/tester/web', createdAt: '2026-01-01T00:00:00Z' } as Project,
  ]);
  st.state.history = [
    mkEntry('h1', { projectId: 'p1' }),
    mkEntry('h2', { projectId: 'p2', cwd: '/home/tester/web' }),
  ];
  draw();
  assert.deepEqual(textsOf(root, 'hist-folder').sort(), ['api', 'web']);
  const folder = byKey(root, 'hist-group:p:p1') as FakeElement;
  assert.equal(folder.getAttribute('aria-expanded'), 'true');
  assert.ok(byKey(root, 'hist-resume:h1') !== null);

  folder.click();
  assert.equal((byKey(root, 'hist-group:p:p1') as FakeElement).getAttribute('aria-expanded'), 'false');
  assert.equal(byKey(root, 'hist-resume:h1'), null, 'a closed folder hides its entries');
  assert.ok(byKey(root, 'hist-resume:h2') !== null, 'and only its own');
  (byKey(root, 'hist-group:p:p1') as FakeElement).click();
});

test('an earlier row starts with a moment in time, in sentence case', () => {
  st.state.history = [
    mkEntry('h1', {
      command: '/bin/bash',
      args: ['-l'],
      lastUsedAt: new Date(Date.now() - 30 * 3600_000).toISOString(),
    }),
  ];
  draw();
  assert.equal(
    textsOf(root, 'sess-meta')[0],
    'Yesterday, Bash',
    'the line opens with a word, so it opens with a capital',
  );
});

test('an earlier row an hour old reads its age, and a crash is marked', () => {
  st.state.history = [mkEntry('h1', { ended: { at: new Date().toISOString(), reason: 'crash' } })];
  draw();
  assert.equal(textsOf(root, 'sess-meta')[0], '1 h ago, crashed');
  assert.ok((byClass(root, 'sess-meta')[0] as FakeElement).classList.contains('is-danger'));
});

test('the empty state names the way out', () => {
  st.setSessions([]);
  draw();
  assert.deepEqual(textsOf(root, 'drawer-empty'), ['No sessions yet. Start one with New session.']);
});

test('a closed drawer renders nothing (and a reopen rebuilds)', () => {
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  st.state.drawer = null;
  drawer.render();
  assert.equal(byKey(root, 'show:s1'), null);
  draw();
  assert.ok(byKey(root, 'show:s1') !== null);
});

test('arming registers ONE disarm timer; nothing in this suite waits on a clock', () => {
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  draw();
  (byKey(root, 'kill:s1') as FakeElement).click();
  assert.equal(dom.win.timers.length, 1, 'the arm sets exactly one disarm timer');
  assert.equal(dom.win.timers[0]?.ms, 3100);
});

test('an armed row keeps the keyboard across the rebuild it causes', () => {
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  draw();
  const x = byKey(root, 'kill:s1') as FakeElement;
  x.focus();
  x.click();
  assert.equal(dom.doc.activeElement, byKey(root, 'kill:s1'), 'the armed button keeps the keyboard');
  dispatch(x, 'blur');
});

// ---------------------------------------------------------------------------
// B6 — `Confirm before ending a session` on the drawer's ×
// ---------------------------------------------------------------------------

const P = (await import(new URL('../web/src/ui/prefs-model.ts', import.meta.url).href)) as {
  setBehaviour(next: { confirmEnd?: boolean }): void;
};

test('B6: confirm OFF — the drawer\'s × ends the session on the first click', () => {
  P.setBehaviour({ confirmEnd: false });
  try {
    st.setSessions([mkSession('s1', { projectId: 'p1' })]);
    draw();
    const x = byKey(root, 'kill:s1') as FakeElement;
    assert.equal(x.textContent, '×', 'the row looks exactly as it did — nothing is armed');
    x.click();
    assert.deepEqual(H.killed, ['s1']);
  } finally {
    P.setBehaviour({});
  }
});

test('B6: the switch is read at CLICK time — a flip reaches the rows already on screen', () => {
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  draw();
  const x = byKey(root, 'kill:s1') as FakeElement;
  x.click();
  assert.deepEqual(H.killed, [], 'armed, as the factory setting asks');
  P.setBehaviour({ confirmEnd: false });
  try {
    st.setSessions([mkSession('s2', { projectId: 'p1' })]);
    draw();
    (byKey(root, 'kill:s2') as FakeElement).click();
    assert.deepEqual(H.killed, ['s2'], 'no reload, no reattach: the next click reads the new answer');
  } finally {
    P.setBehaviour({});
  }
});
