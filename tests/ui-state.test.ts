/**
 * `web/src/state.ts` — client-local view arrangement + persistence, and the
 * conn-state setters feeding the R2 statusline/topbar dot.
 *
 * `state.ts` itself is DOM-free except for the Web Storage global, which
 * plain `node --test` does not provide (only behind
 * `--experimental-webstorage --localstorage-file=...`, which the repo's
 * `npm test` does not pass). We shim a minimal in-memory `localStorage`
 * before touching the module — same contract (getItem/setItem/removeItem),
 * so `loadUi`/`saveUi` exercise the real persistence code paths.
 *
 * `crypto.randomUUID()` is a real Node global; no shim needed there.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryEntry, SessionInfo } from '../shared/protocol.ts';

class MemoryStorage {
  #map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.#map.has(k) ? (this.#map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.#map.set(k, v);
  }
  removeItem(k: string): void {
    this.#map.delete(k);
  }
  clear(): void {
    this.#map.clear();
  }
}

const memoryStorage = new MemoryStorage();
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = memoryStorage;

// Storage keys are private to state.ts (not exported); mirrored here from
// its source so this test writes/reads the exact same on-disk contract a
// real browser reload would.
const STORAGE_KEY = 'ai-sm:ui:v2';
const STORAGE_KEY_V1 = 'ai-sm:ui:v1';

// Imported AFTER the localStorage shim is installed (state.ts only touches
// it inside function bodies, never at module top level, so ordering here is
// belt-and-suspenders rather than load-bearing).
const st = await import('../web/src/state.ts');

function mkSession(id: string): SessionInfo {
  return {
    id,
    title: id,
    command: 'bash',
    args: [],
    cwd: '/tmp',
    status: 'running',
    cols: 80,
    rows: 24,
    createdAt: new Date().toISOString(),
    attention: false,
  };
}

/** Full reset of the module singleton between tests (no fresh-import isolation in ESM). */
function resetState(): void {
  memoryStorage.clear();
  st.state.sessions = new Map();
  st.state.projects = [];
  st.state.history = [];
  st.state.views = [];
  st.state.activeViewId = '';
  st.state.drawer = null;
  st.state.wsLatencyMs = null;
  st.state.serverStartedAt = null;
  st.state.backendReachable = true;
}

before(() => {
  resetState();
});

beforeEach(() => {
  resetState();
});

// ---------------------------------------------------------------------------
// Zero-views validity (R2: launcher tab is no longer ever-present)
// ---------------------------------------------------------------------------

test('loadUi: no stored arrangement and no server sessions -> zero views is valid, nothing conjured', () => {
  st.initServer([], []);
  st.loadUi();
  assert.equal(st.state.views.length, 0, 'zero views must be legal — no phantom launcher tab');
  assert.equal(st.state.activeViewId, '');
});

test('closeView down to the last view leaves zero views — no launcher-tab resurrection', () => {
  st.initServer([], [mkSession('s1')]);
  st.loadUi(); // no stored arrangement -> reconcileViews auto-tabs the orphan session s1
  assert.equal(st.state.views.length, 1, 'the lone server session must have gotten its own tab');
  const onlyViewId = (st.state.views[0] as { id: string }).id;
  assert.equal(st.state.activeViewId, onlyViewId);

  st.closeView(onlyViewId);

  assert.equal(st.state.views.length, 0, 'closing the last view must NOT resurrect a launcher tab');
  assert.equal(st.state.activeViewId, '', 'active id must fall back to empty, not a stale/new id');
});

// ---------------------------------------------------------------------------
// normalizeActive fallback + reconcileViews pruning, driven through loadUi
// ---------------------------------------------------------------------------

test('loadUi: prunes views for sessions the server no longer has, keeps valid ones, and falls back activeViewId to the first surviving view when the stored active id is gone', () => {
  st.initServer([], [mkSession('s1')]); // server only knows about s1
  memoryStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      views: [
        { id: 'v-keep', sessions: ['s1'], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
        { id: 'v-gone', sessions: ['ghost'], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
      ],
      active: 'does-not-exist',
    }),
  );

  st.loadUi();

  assert.deepEqual(
    st.state.views.map((v) => v.id),
    ['v-keep'],
    'the view referencing an unknown session must be pruned to empty and dissolved',
  );
  assert.equal(st.state.activeViewId, 'v-keep', 'normalizeActive must fall back to the first surviving view');
});

// ---------------------------------------------------------------------------
// Pre-R3 v2 blobs (launcher views) load without error — same schema key
// ---------------------------------------------------------------------------

test('loadUi: a pre-R3 v2 blob with a launcher view loads without error, drops the launcher view, and keeps the active mapping sane', () => {
  st.initServer([], [mkSession('s1')]);
  memoryStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      views: [
        { id: 'v-launcher', kind: 'launcher', sessions: [], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
        { id: 'v-sess', kind: 'sessions', sessions: ['s1'], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
      ],
      active: 'v-launcher', // the launcher tab was active before the upgrade
    }),
  );

  assert.doesNotThrow(() => st.loadUi());

  assert.deepEqual(
    st.state.views.map((v) => v.id),
    ['v-sess'],
    'the launcher view must be dropped (the launch dialog replaced it), the session view kept',
  );
  assert.equal(
    st.state.activeViewId,
    'v-sess',
    'active must fall back to a surviving view when it pointed at a dropped launcher view',
  );
});

test('loadUi: a pre-R3 v2 blob holding ONLY launcher views degrades to the legal zero-view empty state', () => {
  st.initServer([], []);
  memoryStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      views: [
        { id: 'v-launcher', kind: 'launcher', sessions: [], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
      ],
      active: 'v-launcher',
    }),
  );

  assert.doesNotThrow(() => st.loadUi());
  assert.equal(st.state.views.length, 0);
  assert.equal(st.state.activeViewId, '');
});

// ---------------------------------------------------------------------------
// v1 -> v2 migration still passes with the current code paths
// ---------------------------------------------------------------------------

test('loadUi: migrates a v1 blob to v2 views, drops the v1 key, and keeps a valid activeTabId mapping', () => {
  st.initServer([], [mkSession('s1'), mkSession('s2'), mkSession('s3')]);
  memoryStorage.setItem(
    STORAGE_KEY_V1,
    JSON.stringify({
      activeTabId: 'tabB',
      tabs: [
        { id: 'tabA', layout: 2, panes: ['s1', 's2'], focused: 1 },
        { id: 'tabB', layout: 1, panes: ['s3'], focused: 0 },
        { id: 'tabC', layout: 3, panes: [], focused: 0 }, // empty v1 tab
      ],
    }),
  );
  assert.equal(memoryStorage.getItem(STORAGE_KEY), null, 'precondition: no v2 blob present');

  st.loadUi();

  // tabC (empty) is dropped: there is no launcher view kind anymore.
  assert.deepEqual(st.state.views.map((v) => v.id), ['tabA', 'tabB']);
  const [tabA, tabB] = st.state.views;
  assert.deepEqual(tabA?.sessions, ['s1', 's2']);
  assert.equal(tabA?.focused, 1, 'v1 focused pane index must map to the migrated slot index');
  assert.deepEqual(tabB?.sessions, ['s3']);

  assert.equal(st.state.activeViewId, 'tabB', 'activeTabId must carry over when it maps to a migrated view');
  assert.equal(memoryStorage.getItem(STORAGE_KEY_V1), null, 'the v1 key must be dropped after migration');
  assert.notEqual(memoryStorage.getItem(STORAGE_KEY), null, 'the migrated arrangement must be persisted as v2');
});

test('loadUi: a malformed v1 blob degrades to a clean (empty) start instead of throwing', () => {
  st.initServer([], []);
  memoryStorage.setItem(STORAGE_KEY_V1, '{not json');

  assert.doesNotThrow(() => st.loadUi());
  assert.equal(st.state.views.length, 0);
  assert.equal(st.state.activeViewId, '');
});

// ---------------------------------------------------------------------------
// viewStatus (R3: kind field removed from ViewState — 'new'/launcher status
// is no longer a reachable return value; only 'attn' | 'run' | 'exit' exist)
// ---------------------------------------------------------------------------

function mkView(sessions: string[]): { id: string; sessions: string[]; focused: number; l3: 'L' | 'R'; split: { col: number; row: number } } {
  return { id: crypto.randomUUID(), sessions, focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } };
}

test("viewStatus: attention beats a running session -> 'attn'", () => {
  const running = mkSession('s1');
  const attn = mkSession('s2');
  attn.attention = true;
  st.state.sessions.set(running.id, running);
  st.state.sessions.set(attn.id, attn);
  assert.equal(st.viewStatus(mkView([running.id, attn.id])), 'attn');
});

test("viewStatus: no attention, at least one running -> 'run'", () => {
  const running = mkSession('s1');
  const exited = mkSession('s2');
  exited.status = 'exited';
  st.state.sessions.set(running.id, running);
  st.state.sessions.set(exited.id, exited);
  assert.equal(st.viewStatus(mkView([exited.id, running.id])), 'run');
});

test("viewStatus: no attention, none running -> 'exit' (never 'new' — no launcher-view kind left to produce it)", () => {
  const exited = mkSession('s1');
  exited.status = 'exited';
  st.state.sessions.set(exited.id, exited);
  const status = st.viewStatus(mkView([exited.id]));
  assert.equal(status, 'exit');
  assert.notEqual(status, 'new', "'new' must be structurally unreachable post-R3");
});

// ---------------------------------------------------------------------------
// Conn-state setters (R2 statusline/topbar dot) notify 'conn'
// ---------------------------------------------------------------------------

function collectKinds(): { kinds: string[] } {
  const kinds: string[] = [];
  st.subscribe((k) => {
    kinds.push(k);
  });
  // state.ts exposes no unsubscribe (subscribe-once-forever is the real app's
  // usage pattern) — each test's listener keeps firing into its own closed-
  // over array for the rest of the run, which is harmless here.
  return { kinds };
}

test('setWsLatency: notifies conn on change, is a no-op on the same value, notifies again on null', () => {
  const { kinds } = collectKinds();
  st.setWsLatency(42);
  assert.equal(st.state.wsLatencyMs, 42);
  assert.deepEqual(kinds, ['conn']);

  st.setWsLatency(42); // unchanged
  assert.deepEqual(kinds, ['conn'], 'setting the same latency again must not renotify');

  st.setWsLatency(null); // presence socket lost
  assert.equal(st.state.wsLatencyMs, null);
  assert.deepEqual(kinds, ['conn', 'conn']);
});

test('setRuntime: notifies conn on change, is a no-op when the answer repeats', () => {
  // The ONE runtime setter (a dedicated setServerStartedAt existed and was
  // dead: main.ts has always fed the whole /api/runtime answer through here).
  const { kinds } = collectKinds();
  const iso = new Date().toISOString();
  const answer = {
    startedAt: iso,
    serverCommit: 'a1b2c3d',
    webBuild: 'assets/index-Br1e6z0Q.js',
    update: { available: false, reason: null },
  };
  st.setRuntime(answer);
  assert.equal(st.state.serverStartedAt, iso);
  assert.equal(st.state.serverCommit, 'a1b2c3d');
  assert.deepEqual(kinds, ['conn']);

  st.setRuntime(answer);
  assert.deepEqual(kinds, ['conn'], 'the same runtime answer again must not renotify');

  st.setRuntime({ ...answer, update: { available: true, reason: 'frontend rebuilt' } });
  assert.deepEqual(st.state.update, { available: true, reason: 'frontend rebuilt' });
  assert.deepEqual(kinds, ['conn', 'conn'], 'a new update verdict is a change');
});

test('setBackendReachable: notifies conn on toggle, is a no-op when unchanged', () => {
  const { kinds } = collectKinds();
  assert.equal(st.state.backendReachable, true, 'precondition: defaults reachable');

  st.setBackendReachable(true); // unchanged
  assert.deepEqual(kinds, []);

  st.setBackendReachable(false);
  assert.equal(st.state.backendReachable, false);
  assert.deepEqual(kinds, ['conn']);

  st.setBackendReachable(false); // unchanged
  assert.deepEqual(kinds, ['conn']);

  st.setBackendReachable(true);
  assert.deepEqual(kinds, ['conn', 'conn']);
});

// ---------------------------------------------------------------------------
// Session-history setters (GET /api/history -> drawer) notify 'sessions'
// ---------------------------------------------------------------------------

function mkHistory(id: string): HistoryEntry {
  return {
    id,
    conversation: true,
    sessionId: `s-${id}`,
    cwd: '/tmp/work',
    command: 'claude',
    args: ['--model', 'opus'],
    title: id,
    createdAt: '2026-09-06T10:00:00.000Z',
    lastUsedAt: '2026-09-06T10:00:00.000Z',
    ended: { at: '2026-09-06T11:00:00.000Z', reason: 'exit' },
  };
}

test('setHistory: replaces the list and notifies sessions every time (a refetch always publishes)', () => {
  const { kinds } = collectKinds();
  st.setHistory([mkHistory('a'), mkHistory('b')]);
  assert.deepEqual(st.state.history.map((h) => h.id), ['a', 'b']);
  assert.deepEqual(kinds, ['sessions']);

  // Even an identical-looking refetch republishes: the drawer re-renders from
  // whatever the server just said, and history.ts debounces the fetches.
  st.setHistory([mkHistory('a'), mkHistory('b')]);
  assert.deepEqual(kinds, ['sessions', 'sessions']);
});

test('removeHistory: drops the matching entry and notifies; an unknown id changes nothing and stays silent', () => {
  st.setHistory([mkHistory('a'), mkHistory('b')]);
  const { kinds } = collectKinds();

  st.removeHistory('no-such-entry');
  assert.deepEqual(st.state.history.map((h) => h.id), ['a', 'b']);
  assert.deepEqual(kinds, [], 'a miss must not renotify');

  st.removeHistory('a');
  assert.deepEqual(st.state.history.map((h) => h.id), ['b']);
  assert.deepEqual(kinds, ['sessions']);

  // The entry KEY is what is matched, never the session id it last ran under.
  st.removeHistory('s-b');
  assert.deepEqual(st.state.history.map((h) => h.id), ['b'], 'sessionId is not the key');
  assert.deepEqual(kinds, ['sessions']);
});

test('clearHistory: empties the list once and is silent when there is nothing to clear', () => {
  st.setHistory([mkHistory('a')]);
  const { kinds } = collectKinds();

  st.clearHistory();
  assert.deepEqual(st.state.history, []);
  assert.deepEqual(kinds, ['sessions']);

  st.clearHistory();
  assert.deepEqual(kinds, ['sessions'], 'clearing an empty list must not renotify');
});

test('projectName resolves to the NAME — never the path, never the id', () => {
  // The copy rule (PROJECT-SCOPE, 2026-07-25) says the raw path appears only in
  // the manage-projects view. Every other surface asks this function, including
  // the restart confirmation's list of sessions about to be closed, so a path
  // leaking out of here would leak into that dialog.
  st.setProjects([
    {
      id: 'p1',
      name: 'Session Manager',
      path: '/home/sava/projects/ai-cli-application',
      createdAt: '2026-09-06T12:00:00.000Z',
    },
    {
      id: 'p2',
      name: 'notes',
      path: '/home/sava/projects/acme/notes',
      createdAt: '2026-09-06T12:00:00.000Z',
    },
  ]);

  assert.equal(st.projectName('p1'), 'Session Manager');
  assert.equal(st.projectName('p2'), 'notes');
  for (const id of ['p1', 'p2']) {
    const label = st.projectName(id) as string;
    assert.ok(!label.includes('/'), `no path separator in "${label}"`);
    assert.notEqual(label, id, 'and it is not the raw id either');
  }
  assert.equal(st.projectName('gone'), null, 'an unknown id is null, never a fabricated label');
  assert.equal(st.projectName(undefined), null, 'a session with no project is null');
  st.setProjects([]);
});
