/**
 * `web/src/state.ts` — client-local view arrangement + persistence, and the
 * conn-state setters feeding the R2 statusline/topbar dot.
 *
 * Since A10 (user decision 2026-09-15) a view holds 0..4 SLOTS — a terminal, a
 * file or a read-only diff, mixed freely — and `Home` is a real view that is
 * always `state.views[0]`. The half of this file that used to say "sessions"
 * says "slots" now, and the rules that only A10 introduced (roots, file panes,
 * what survives a reload) are at the bottom.
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
// Types come from a static (erased) import; `st` itself is the runtime module,
// loaded after the localStorage shim above.
type ViewState = import('../web/src/state.ts').ViewState;
type PaneSlot = import('../web/src/state.ts').PaneSlot;
type ViewRoot = import('../web/src/state.ts').ViewRoot;

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
  st.state.leftPanel = 'files';
  st.state.filesWidth = st.FILES_W_DEFAULT;
  st.state.edits = new Map();
  st.state.wsLatencyMs = null;
  st.state.serverStartedAt = null;
  st.state.backendReachable = true;
}

/** The fixed first tab, as the app sees it after any load. */
function home(): ViewState {
  const v = st.state.views[0] as ViewState;
  assert.equal(v?.root?.kind, 'home', 'precondition: Home is views[0]');
  return v;
}

/** Put a view in the strip by hand (state.ts exposes no constructor). */
function addView(root: ViewRoot | null, slots: PaneSlot[], id: string = crypto.randomUUID()): ViewState {
  const v: ViewState = { id, root, slots, focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } };
  st.state.views.push(v);
  return v;
}

const sess = (id: string): PaneSlot => ({ kind: 'session', id });
const file = (path: string): PaneSlot => ({ kind: 'file', path });
const keys = (v: ViewState): string[] => v.slots.map((s: PaneSlot) => st.slotKey(s));

before(() => {
  resetState();
});

beforeEach(() => {
  resetState();
});

// ---------------------------------------------------------------------------
// The empty state (R2: launcher tab is no longer ever-present; A10: Home is)
// ---------------------------------------------------------------------------

test('loadUi: nothing stored and no server sessions -> Home alone, empty, active', () => {
  st.initServer([], []);
  st.loadUi();
  assert.equal(st.state.views.length, 1, 'Home is the whole strip');
  assert.deepEqual(home().slots, [], 'and it holds no panes — zero slots is the empty state');
  assert.equal(st.state.activeViewId, home().id);
});

test('closeView down to the last session tab leaves Home — and Home refuses to close', () => {
  st.initServer([], [mkSession('s1')]);
  st.loadUi(); // no stored arrangement -> reconcileViews auto-tabs the orphan session s1
  assert.equal(st.state.views.length, 2, 'Home + the lone server session’s own tab');
  const sessionTab = st.state.views[1] as ViewState;
  assert.deepEqual(keys(sessionTab), ['s:s1']);

  st.closeView(sessionTab.id);
  assert.deepEqual(
    st.state.views.map((v) => v.root?.kind ?? null),
    ['home'],
    'closing the last session tab must NOT resurrect a launcher tab',
  );

  const homeId = home().id;
  st.closeView(homeId);
  assert.equal(st.state.views.length, 1, 'Home is never closable (user decision 4, 2026-09-15)');
  assert.equal(home().id, homeId);
  assert.equal(st.state.activeViewId, homeId, 'and the active id still points at a real view');
});

// ---------------------------------------------------------------------------
// normalizeActive fallback + reconcileViews pruning, driven through loadUi
// ---------------------------------------------------------------------------

test('loadUi: prunes views for sessions the server no longer has, keeps valid ones, and falls back activeViewId to the first view when the stored active id is gone', () => {
  st.initServer([], [mkSession('s1')]); // server only knows about s1
  memoryStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      views: [
        { id: 'v-keep', root: null, slots: [sess('s1')], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
        { id: 'v-gone', root: null, slots: [sess('ghost')], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
      ],
      active: 'does-not-exist',
    }),
  );

  st.loadUi();

  assert.deepEqual(
    st.state.views.slice(1).map((v) => v.id),
    ['v-keep'],
    'the ROOTLESS view referencing an unknown session must be pruned to empty and dissolved',
  );
  assert.equal(
    st.state.activeViewId,
    'v-keep',
    'normalizeActive falls back to the first surviving STORED view (Home is prepended after)',
  );
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
    st.state.views.slice(1).map((v) => v.id),
    ['v-sess'],
    'the launcher view must be dropped (the launch dialog replaced it), the session view kept',
  );
  assert.equal(
    st.state.activeViewId,
    'v-sess',
    'active must fall back to a surviving view when it pointed at a dropped launcher view',
  );
});

test('loadUi: a pre-A10 v2 blob keeps its arrangement — `sessions` is read as session slots', () => {
  // The storage key did NOT change with A10: the reader has always ignored
  // what it does not know, so a split the user arranged before the upgrade
  // must still be a split after it.
  st.initServer([], [mkSession('s1'), mkSession('s2')]);
  memoryStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      views: [{ id: 'v-old', sessions: ['s1', 's2'], focused: 1, l3: 'R', split: { col: 0.3, row: 0.7 } }],
      active: 'v-old',
    }),
  );

  st.loadUi();

  const v = st.state.views[1] as ViewState;
  assert.equal(v.id, 'v-old');
  assert.deepEqual(keys(v), ['s:s1', 's:s2'], 'both sessions kept, in order, as session slots');
  assert.equal(v.root, null, 'a blob written before roots existed is a plain session tab');
  assert.equal(v.focused, 1);
  assert.deepEqual(v.split, { col: 0.3, row: 0.7 });
  assert.equal(st.state.activeViewId, 'v-old');
});

test('loadUi: a LEGACY v2 bag keeps every tab, adds Home in front, and restores the stored active tab', () => {
  // The shape the app wrote before A10: views with `sessions: string[]`, no
  // `root`, and an `active` that names one of them. Three facts at once,
  // because they are three different ways for a reload to lose the user:
  // the slots, Home at 0, and the tab they were actually looking at.
  st.initServer([], [mkSession('s1'), mkSession('s2')]);
  memoryStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      views: [
        { id: 'v-a', sessions: ['s1'], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
        { id: 'v-b', sessions: ['s2'], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
      ],
      active: 'v-b',
    }),
  );

  st.loadUi();

  assert.deepEqual(
    st.state.views.map((v: ViewState) => v.id),
    [home().id, 'v-a', 'v-b'],
    'Home first, then the stored tabs in their stored order',
  );
  assert.deepEqual(home().slots, [], 'the Home that was added stands empty');
  assert.deepEqual(keys(st.state.views[1] as ViewState), ['s:s1']);
  assert.deepEqual(keys(st.state.views[2] as ViewState), ['s:s2']);
  assert.equal(st.state.activeViewId, 'v-b', 'the tab the user left is the tab they come back to');
  assert.notEqual(st.state.activeViewId, home().id, 'a reload does not drop them on Home');
});

test('loadUi: a pre-R3 v2 blob holding ONLY launcher views degrades to Home, empty', () => {
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
  assert.equal(st.state.views.length, 1);
  assert.deepEqual(home().slots, []);
  assert.equal(st.state.activeViewId, home().id);
});

// ---------------------------------------------------------------------------
// v1 -> v2 migration still passes with the current code paths
// ---------------------------------------------------------------------------

test('loadUi: migrates a v1 blob to v2 SESSION SLOTS, drops the v1 key, and keeps a valid activeTabId mapping', () => {
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

  // tabC (empty) is dropped: there is no launcher view kind anymore. Home is
  // prepended — a v1 blob predates roots entirely.
  assert.deepEqual(st.state.views.map((v) => v.id).slice(1), ['tabA', 'tabB']);
  assert.equal(home().root?.kind, 'home');
  const [, tabA, tabB] = st.state.views;
  assert.deepEqual(keys(tabA as ViewState), ['s:s1', 's:s2']);
  assert.deepEqual((tabA as ViewState).slots, [sess('s1'), sess('s2')], 'sessions, not strings');
  assert.equal((tabA as ViewState).root, null, 'every migrated v1 tab is a plain session tab');
  assert.equal(tabA?.focused, 1, 'v1 focused pane index must map to the migrated slot index');
  assert.deepEqual(keys(tabB as ViewState), ['s:s3']);

  assert.equal(st.state.activeViewId, 'tabB', 'activeTabId must carry over when it maps to a migrated view');
  assert.equal(memoryStorage.getItem(STORAGE_KEY_V1), null, 'the v1 key must be dropped after migration');
  assert.notEqual(memoryStorage.getItem(STORAGE_KEY), null, 'the migrated arrangement must be persisted as v2');
});

test('loadUi: a malformed v1 blob degrades to a clean (Home-only) start instead of throwing', () => {
  st.initServer([], []);
  memoryStorage.setItem(STORAGE_KEY_V1, '{not json');

  assert.doesNotThrow(() => st.loadUi());
  assert.equal(st.state.views.length, 1);
  assert.deepEqual(home().slots, []);
});

// ---------------------------------------------------------------------------
// viewStatus (R3: no launcher kind left; A10: a tab may hold no session at all)
// ---------------------------------------------------------------------------

function mkView(slots: PaneSlot[], root: ViewRoot | null = null): ViewState {
  return { id: crypto.randomUUID(), root, slots, focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } };
}

test("viewStatus: attention beats a running session -> 'attn'", () => {
  const running = mkSession('s1');
  const attn = mkSession('s2');
  attn.attention = true;
  st.state.sessions.set(running.id, running);
  st.state.sessions.set(attn.id, attn);
  assert.equal(st.viewStatus(mkView([sess(running.id), sess(attn.id)])), 'attn');
});

test("viewStatus: no attention, at least one running -> 'run'", () => {
  const running = mkSession('s1');
  const exited = mkSession('s2');
  exited.status = 'exited';
  st.state.sessions.set(running.id, running);
  st.state.sessions.set(exited.id, exited);
  assert.equal(st.viewStatus(mkView([sess(exited.id), sess(running.id)])), 'run');
});

test("viewStatus: no attention, none running -> 'exit' (never 'new' — no launcher-view kind left to produce it)", () => {
  const exited = mkSession('s1');
  exited.status = 'exited';
  st.state.sessions.set(exited.id, exited);
  const status = st.viewStatus(mkView([sess(exited.id)]));
  assert.equal(status, 'exit');
  assert.notEqual(status, 'new', "'new' must be structurally unreachable post-R3");
});

test("viewStatus: a tab with no session in it is 'none' — a dot there would report on nothing", () => {
  // A10: Home stands empty, and a folder tab may show only files.
  assert.equal(st.viewStatus(mkView([], { kind: 'home' })), 'none');
  assert.equal(st.viewStatus(mkView([file('web/src/main.ts')], { kind: 'project', id: 'p1' })), 'none');
  assert.equal(st.viewStatus(mkView([{ kind: 'diff', hash: '474d891', path: 'server/ws.ts' }])), 'none');
  // One terminal beside the files and the dot is back.
  const s = mkSession('s1');
  st.state.sessions.set(s.id, s);
  assert.equal(st.viewStatus(mkView([file('a.ts'), sess('s1')])), 'run');
});

test('viewAttention reads SESSIONS only — a file never asks for anything', () => {
  const attn = mkSession('s1');
  attn.attention = true;
  st.state.sessions.set(attn.id, attn);
  assert.equal(st.viewAttention(mkView([file('a.ts')])), false);
  assert.equal(st.viewAttention(mkView([file('a.ts'), sess('s1')])), true);
  assert.deepEqual(st.sessionIds(mkView([file('a.ts'), sess('s1'), file('b.ts')])), ['s1']);
});

// ===========================================================================
// A10 (user decision 2026-09-15): slots, roots, Home, files as panes
// ===========================================================================

test('slotKey: a file/diff key is BYTE-IDENTICAL to fileTabId/diffTabId', async () => {
  // This is the `state.edits` contract: the key a pane is drawn under and the
  // key its unsaved text lives under are ONE string, or two panes on one file
  // would hold two different texts.
  const E = await import('../web/src/ui/editor-model.ts');
  for (const path of ['web/src/main.ts', 'LICENSE', 'a b/c:d.ts', '']) {
    assert.equal(st.slotKey(file(path)), E.fileTabId(path));
  }
  for (const [hash, path] of [
    ['474d891', 'server/ws.ts'],
    ['55c9be7', 'a/b.ts'],
  ] as const) {
    assert.equal(st.slotKey({ kind: 'diff', hash, path }), E.diffTabId(hash, path));
  }
  assert.equal(st.slotKey(sess('s1')), 's:s1');
  assert.equal(st.editorFileId('a.ts'), st.slotKey(file('a.ts')), 'one spelling for every caller');
});

test('ensureHomeView: Home is created once, kept first, and never duplicated', () => {
  st.initServer([], []);
  assert.equal(st.ensureHomeView(), true, 'the first call creates it');
  const id = home().id;
  assert.equal(st.ensureHomeView(), false, 'the second changes nothing');
  assert.equal(home().id, id);

  // Something pushed in front of it (a hand-edited blob, a future bug): it
  // comes back to position 0 without losing its identity.
  const other = addView(null, [sess('s1')]);
  st.state.views = [other, st.state.views[0] as ViewState];
  assert.equal(st.ensureHomeView(), true);
  assert.equal(home().id, id);
  assert.equal(st.state.views.length, 2);
});

test('ensureHomeView: a strip that already has tabs gets Home IN FRONT of them', () => {
  // The push-instead-of-unshift mutant survives a strip that is EMPTY, where
  // both moves are the same move. Starting from a strip that already holds a
  // tab is what tells them apart — and it matters because `viewForRoot`
  // answers the home root with `state.views[0]`, so a Home appended at the end
  // would send every file row into somebody else's tab.
  st.initServer([], []);
  const plain = addView(null, [sess('s1')]);
  assert.equal(st.ensureHomeView(), true, 'there was no Home yet');
  assert.equal(st.state.views[0]?.root?.kind, 'home', 'Home is created AT position 0');
  assert.equal(st.state.views[1]?.id, plain.id, 'and the tab that was there keeps its place');

  const h = st.viewForRoot({ kind: 'home' });
  assert.equal(h.root?.kind, 'home', 'the home root resolves to the Home TAB, not to whatever is first');
  assert.equal(h.id, home().id);
  assert.equal(st.openFile({ kind: 'home' }, 'a/one.ts', 'one.ts'), 'ok');
  assert.deepEqual(keys(home()), ['f:a/one.ts'], 'and that is where a file row lands');
  assert.deepEqual(keys(st.state.views[1] as ViewState), ['s:s1'], 'never in the session tab beside it');
});

test('isFolderView: Home and a project tab are folder tabs; a session tab is not', () => {
  assert.equal(st.isFolderView(mkView([], { kind: 'home' })), true);
  assert.equal(st.isFolderView(mkView([], { kind: 'project', id: 'p1' })), true);
  assert.equal(st.isFolderView(mkView([sess('s1')])), false);
});

test('viewForRoot: finds the folder tab it already made, and makes one only once', () => {
  st.initServer([], []);
  st.loadUi();
  const h = st.viewForRoot({ kind: 'home' });
  assert.equal(h.id, home().id, 'the home root IS views[0]');

  const p = st.viewForRoot({ kind: 'project', id: 'p1' });
  assert.deepEqual(p.root, { kind: 'project', id: 'p1' });
  assert.deepEqual(p.slots, [], 'a folder tab may stand empty');
  assert.equal(st.viewForRoot({ kind: 'project', id: 'p1' }).id, p.id, 'one tab per root folder');
  assert.notEqual(st.viewForRoot({ kind: 'project', id: 'p2' }).id, p.id);
  assert.equal(st.state.views.length, 3, 'Home + p1 + p2');
  assert.equal(st.state.views[0]?.id, home().id, 'and a new folder tab never lands before Home');
});

test('openFile: lands in its root tab, focused, active — and a second click RAISES it', () => {
  st.initServer([], []);
  st.loadUi();
  assert.equal(st.openFile({ kind: 'home' }, 'web/src/main.ts', 'main.ts'), 'ok');
  assert.deepEqual(keys(home()), ['f:web/src/main.ts']);
  assert.equal(home().focused, 0);
  assert.equal(st.state.activeViewId, home().id);

  assert.equal(st.openFile({ kind: 'home' }, 'web/src/ui/panes.ts', 'panes.ts'), 'ok');
  assert.deepEqual(keys(home()), ['f:web/src/main.ts', 'f:web/src/ui/panes.ts']);
  assert.equal(home().focused, 1, 'focus lands on the file the user just opened');

  // The same row again: raised, not opened twice — the second click must not
  // spend one of the four panes on a copy.
  assert.equal(st.openFile({ kind: 'home' }, 'web/src/main.ts', 'main.ts'), 'ok');
  assert.deepEqual(keys(home()), ['f:web/src/main.ts', 'f:web/src/ui/panes.ts']);
  assert.equal(home().focused, 0);
});

test('openFile: a fifth pane is refused, and the tab is left exactly as it was', () => {
  st.initServer([], []);
  st.loadUi();
  for (const p of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) {
    assert.equal(st.openFile({ kind: 'home' }, p, p), 'ok');
  }
  assert.equal(home().slots.length, st.MAX_PANES);
  const before = keys(home());
  assert.equal(st.openFile({ kind: 'home' }, 'e.ts', 'e.ts'), 'full');
  assert.deepEqual(keys(home()), before, 'a rejection changes nothing');
});

test('openFile: a project root opens its own folder tab and activates it', () => {
  st.initServer([], []);
  st.loadUi();
  assert.equal(st.openFile({ kind: 'project', id: 'p1' }, 'server/ws.ts', 'ws.ts'), 'ok');
  const v = st.state.views[1] as ViewState;
  assert.deepEqual(v.root, { kind: 'project', id: 'p1' });
  assert.deepEqual(keys(v), ['f:server/ws.ts']);
  assert.equal(st.state.activeViewId, v.id);
  assert.deepEqual(home().slots, [], 'and Home is not where it went');
});

test('openFileAt: every (count, zone) the pane can offer — and nothing it cannot', () => {
  // The matrix `dropZonesFor` describes IS what openFileAt accepts: the drag
  // layer reads the first and calls the second, so a disagreement between them
  // is a file that lands somewhere the drop indicator never pointed at.
  for (let count = 1; count <= st.MAX_PANES; count++) {
    for (let slot = 0; slot < count; slot++) {
      for (const l3 of ['L', 'R'] as const) {
        for (const zone of ['left', 'right', 'top', 'bottom', 'fill'] as const) {
          resetState();
          const v = addView(null, Array.from({ length: count }, (_, i) => file(`f${i}.ts`)));
          v.l3 = l3;
          const offered = st.dropZonesFor(v, slot, 1);
          const result = st.openFileAt(v.id, slot, zone, 'new.ts');
          const label = `count=${count} slot=${slot} l3=${l3} zone=${zone}`;
          if (offered.includes(zone)) {
            assert.equal(result, 'ok', label);
            assert.equal(v.slots.length, count + 1, label);
            assert.equal(st.slotKey(v.slots[v.focused] as PaneSlot), 'f:new.ts', `focus: ${label}`);
          } else {
            assert.equal(result, count === st.MAX_PANES ? 'full' : 'no-zone', label);
            assert.equal(v.slots.length, count, `unchanged: ${label}`);
          }
        }
      }
    }
  }
});

test('openFileAt: the CENTRE of a file pane replaces it; the centre of a terminal is refused', () => {
  // User decision 7 (2026-09-15): edges split, the centre of a terminal pane
  // flashes "drop on an edge to split" instead of losing the terminal.
  st.initServer([], [mkSession('s1')]);
  st.loadUi();
  const v = addView({ kind: 'project', id: 'p1' }, [file('a.ts'), sess('s1')]);

  assert.equal(st.openFileAt(v.id, 1, 'replace', 'new.ts'), 'session-centre');
  assert.deepEqual(keys(v), ['f:a.ts', 's:s1'], 'the terminal is still there');

  assert.equal(st.openFileAt(v.id, 0, 'replace', 'new.ts'), 'ok');
  assert.deepEqual(keys(v), ['f:new.ts', 's:s1'], 'a file pane takes the new file in place');
  assert.equal(v.focused, 0);
  assert.equal(v.slots.length, 2, 'replacing costs no pane');

  // Replace works on a FULL tab too, for the same reason.
  const full = addView(null, [file('a.ts'), file('b.ts'), file('c.ts'), file('d.ts')]);
  assert.equal(st.openFileAt(full.id, 3, 'replace', 'new.ts'), 'ok');
  assert.deepEqual(keys(full), ['f:a.ts', 'f:b.ts', 'f:c.ts', 'f:new.ts']);
});

test('openFileAt: an unknown view or an unknown pane is `no-view`, never a guess', () => {
  st.initServer([], []);
  st.loadUi();
  const v = addView(null, [file('a.ts')]);
  assert.equal(st.openFileAt('nope', 0, 'replace', 'new.ts'), 'no-view');
  assert.equal(st.openFileAt(v.id, 3, 'left', 'new.ts'), 'no-view');
  assert.equal(st.openFileAt(v.id, -1, 'replace', 'new.ts'), 'no-view');
  assert.deepEqual(keys(v), ['f:a.ts']);
});

test('closeSlot: an emptied PROJECT tab goes, Home stays, and focus lands on a pane that exists', () => {
  st.initServer([], [mkSession('s1')]);
  st.loadUi();

  // Home: its last file leaves, Home stays (user decision 4).
  assert.equal(st.openFile({ kind: 'home' }, 'a.ts', 'a.ts'), 'ok');
  assert.equal(st.closeSlot(home().id, 0), true);
  assert.deepEqual(home().slots, []);
  assert.equal(st.state.views[0]?.root?.kind, 'home', 'Home is still the first tab');

  // A project tab with only files: the last one closes the tab (decision 6).
  const p = addView({ kind: 'project', id: 'p1' }, [file('b.ts'), file('c.ts')]);
  p.focused = 1;
  assert.equal(st.closeSlot(p.id, 1), true);
  assert.deepEqual(keys(p), ['f:b.ts']);
  assert.equal(p.focused, 0, 'focus clamps onto the pane that is left');
  assert.equal(st.closeSlot(p.id, 0), true);
  assert.equal(st.state.views.some((v) => v.id === p.id), false, 'the emptied project tab is gone');

  // …unless it still holds a terminal.
  const q = addView({ kind: 'project', id: 'p2' }, [file('d.ts'), sess('s1')]);
  assert.equal(st.closeSlot(q.id, 0), true);
  assert.deepEqual(keys(q), ['s:s1']);
  assert.equal(st.state.views.some((v) => v.id === q.id), true, 'a terminal keeps the tab open');
});

test('closeSlot: a SESSION pane is refused — ending a session is a different act', () => {
  // The A3 no-close rule. A `×` never appears on a terminal pane, and the model
  // says so too rather than trusting every caller to remember.
  st.initServer([], [mkSession('s1')]);
  st.loadUi();
  const v = addView(null, [sess('s1'), file('a.ts')]);
  assert.equal(st.closeSlot(v.id, 0), false);
  assert.deepEqual(keys(v), ['s:s1', 'f:a.ts']);
  assert.equal(st.closeSlot(v.id, 9), false, 'and an index that is not a pane is a no-op');
  assert.equal(st.closeSlot('nope', 0), false);
});

test('closeSlot: a ROOTLESS tab emptied of files dissolves, like it always has', () => {
  st.initServer([], []);
  st.loadUi();
  const v = addView(null, [file('a.ts')]);
  assert.equal(st.closeSlot(v.id, 0), true);
  assert.equal(st.state.views.some((x) => x.id === v.id), false);
});

// ---------------------------------------------------------------------------
// Unsaved text is dropped with the LAST pane showing that file
// ---------------------------------------------------------------------------
//
// PROJECT-SCOPE: "it is dropped when the last pane showing that file closes".
// Without this the text survived every close with no dot anywhere to show it,
// came back on the next open, and `state.edits` grew forever.

test('closing the ONLY pane of a dirty file drops its unsaved text', () => {
  st.initServer([], []);
  st.loadUi();
  assert.equal(st.openFile({ kind: 'home' }, 'a.ts', 'a.ts'), 'ok');
  const id = st.editorFileId('a.ts');
  st.setEdit(id, 'typed');
  assert.equal(st.editorDirty(id), true, 'precondition: the file is dirty');

  assert.equal(st.closeSlot(home().id, 0), true);
  assert.equal(st.editorDirty(id), false, 'no dot anywhere, so no text anywhere');
  assert.equal(st.state.edits.size, 0, 'and the map does not grow forever');
});

test('the same file in TWO panes keeps its text until BOTH are gone', () => {
  // Free mixing (decision 3): one text per FILE, shared by every pane showing
  // it — so the first close is not the last word.
  st.initServer([], []);
  st.loadUi();
  const v = addView({ kind: 'project', id: 'p1' }, [file('a.ts'), file('a.ts')]);
  const id = st.editorFileId('a.ts');
  st.setEdit(id, 'typed');

  assert.equal(st.closeSlot(v.id, 1), true);
  assert.equal(st.editorDirty(id), true, 'one pane still shows it');
  assert.equal(st.editText(id), 'typed', 'and it still holds exactly what was typed');

  assert.equal(st.closeSlot(v.id, 0), true);
  assert.equal(st.editorDirty(id), false);
  assert.equal(st.state.edits.size, 0);
});

test('openFileAt on the CENTRE of a dirty file pane drops the text it replaced', () => {
  st.initServer([], []);
  st.loadUi();
  assert.equal(st.openFile({ kind: 'home' }, 'a.ts', 'a.ts'), 'ok');
  const v = home();
  const gone = st.editorFileId('a.ts');
  const kept = st.editorFileId('b.ts');
  st.setEdit(gone, 'typed in a');
  st.setEdit(kept, 'typed in b');

  assert.equal(st.openFileAt(v.id, 0, 'replace', 'b.ts'), 'ok');
  assert.deepEqual(keys(v), ['f:b.ts']);
  assert.equal(st.editorDirty(gone), false, 'the replaced file is on no pane any more');
  assert.equal(st.editText(kept), 'typed in b', 'the file that took its place keeps its own text');
});

test('closing a TAB drops the unsaved text of every file it held', () => {
  st.initServer([], []);
  st.loadUi();
  const v = addView({ kind: 'project', id: 'p1' }, [file('a.ts'), file('b.ts')]);
  const a = st.editorFileId('a.ts');
  const b = st.editorFileId('b.ts');
  st.setEdit(a, 'typed a');
  st.setEdit(b, 'typed b');

  // …but a file that is ALSO open in another tab is not the closing tab's to drop.
  assert.equal(st.openFile({ kind: 'home' }, 'b.ts', 'b.ts'), 'ok');
  st.closeView(v.id);
  assert.equal(st.state.views.some((x) => x.id === v.id), false, 'the tab is gone');
  assert.equal(st.editorDirty(a), false, 'its only pane went with the tab');
  assert.equal(st.editText(b), 'typed b', 'the other tab still shows b.ts');
});

test('merging a tab into another keeps the unsaved text of the file in transit', () => {
  // `mergeViews` empties the source and dissolves it BEFORE the slots land in
  // the target: for that instant the file is on no pane at all. A prune run
  // from `dissolveView` would eat text the user is still looking at — which is
  // why the prune lives in closeSlot/closeView/openFileAt and nowhere else.
  st.initServer([], []);
  st.loadUi();
  const src = addView({ kind: 'project', id: 'p1' }, [file('a.ts')]);
  const dst = addView({ kind: 'project', id: 'p2' }, [file('b.ts')]);
  const a = st.editorFileId('a.ts');
  const b = st.editorFileId('b.ts');
  st.setEdit(a, 'typed in a');
  st.setEdit(b, 'typed in b');

  assert.equal(st.mergeViews(dst.id, src.id, 0, 'right'), 'ok');
  assert.equal(st.state.views.some((x) => x.id === src.id), false, 'the source tab dissolved');
  assert.deepEqual(keys(dst), ['f:b.ts', 'f:a.ts'], 'both files are panes of the target');
  assert.equal(st.editorDirty(a), true, 'the file moved, it did not close');
  assert.equal(st.editText(a), 'typed in a', 'and it still holds exactly what was typed');
  assert.equal(st.editText(b), 'typed in b', 'the file it merged into is untouched');
});

test('movePane: a file and a terminal trade places, and focus follows the moved pane', () => {
  st.initServer([], [mkSession('s1')]);
  st.loadUi();
  const v = addView({ kind: 'project', id: 'p1' }, [file('a.ts'), sess('s1')]);
  st.state.activeViewId = v.id;
  v.focused = 0;

  st.movePane('right');
  assert.deepEqual(keys(v), ['s:s1', 'f:a.ts'], 'kind-blind: the file swapped with the terminal');
  assert.equal(v.focused, 1, 'focus follows the pane that moved, not the slot it left');

  st.movePane('left');
  assert.deepEqual(keys(v), ['f:a.ts', 's:s1']);
  assert.equal(v.focused, 0);

  // No neighbour in that direction: nothing moves.
  st.movePane('up');
  assert.deepEqual(keys(v), ['f:a.ts', 's:s1']);
});

test('reconcileViews: the server forgot a session — its pane goes, the files beside it stay', () => {
  st.initServer([], [mkSession('s1')]);
  st.loadUi();
  const v = addView({ kind: 'project', id: 'p1' }, [file('a.ts'), sess('gone'), file('b.ts')]);
  const rootless = addView(null, [sess('gone2')]);

  st.reconcileViews();

  assert.deepEqual(keys(v), ['f:a.ts', 'f:b.ts'], 'a path is not a session id');
  assert.equal(st.state.views.some((x) => x.id === v.id), true);
  assert.equal(st.state.views.some((x) => x.id === rootless.id), false, 'a rootless tab still dissolves');

  // And a rooted tab emptied this way is NOT dissolved: the folder is still the
  // folder, whatever happened to the terminal in it.
  const empty = addView({ kind: 'project', id: 'p2' }, [sess('gone3')]);
  st.reconcileViews();
  assert.deepEqual(empty.slots, []);
  assert.equal(st.state.views.some((x) => x.id === empty.id), true);
});

test('reconcileViews: an unassigned server session still gets its own tab, after Home', () => {
  st.initServer([], [mkSession('s1')]);
  st.state.views = [];
  st.reconcileViews();
  assert.equal(st.state.views[0]?.root?.kind, 'home', 'ensureHomeView runs first');
  assert.deepEqual(keys(st.state.views[1] as ViewState), ['s:s1']);
});

test('reorderView / moveActiveViewBy never displace Home', () => {
  st.initServer([], []);
  st.loadUi();
  const a = addView(null, [file('a.ts')], 'v-a');
  const b = addView(null, [file('b.ts')], 'v-b');
  const ids = () => st.state.views.map((v) => (v.root?.kind === 'home' ? 'HOME' : v.id));

  st.reorderView(a.id, 0);
  assert.deepEqual(ids(), ['HOME', 'v-a', 'v-b'], 'position 0 belongs to Home');

  st.reorderView(home().id, 2);
  assert.deepEqual(ids(), ['HOME', 'v-a', 'v-b'], 'Home itself never moves');

  st.reorderView(b.id, 1);
  assert.deepEqual(ids(), ['HOME', 'v-b', 'v-a']);

  st.setActiveView('v-b');
  st.moveActiveViewBy(-1);
  assert.deepEqual(ids(), ['HOME', 'v-b', 'v-a'], 'the chord stops at Home, it does not step over it');
  st.moveActiveViewBy(1);
  assert.deepEqual(ids(), ['HOME', 'v-a', 'v-b']);

  st.setActiveView(home().id);
  st.moveActiveViewBy(1);
  assert.deepEqual(ids(), ['HOME', 'v-a', 'v-b'], 'and the chord on Home does nothing at all');
});

test('extractSession: the new tab lands after its old one, never before Home', () => {
  st.initServer([], [mkSession('s1'), mkSession('s2')]);
  st.loadUi();
  st.state.views = [st.state.views[0] as ViewState];
  const h = home();
  h.slots = [sess('s1'), sess('s2')];

  st.extractSession('s2', 0); // asked for position 0 — Home's
  assert.equal(st.state.views[0]?.id, h.id, 'Home is still first');
  assert.deepEqual(keys(st.state.views[1] as ViewState), ['s:s2']);
  assert.deepEqual(keys(h), ['s:s1'], 'a session may leave Home like any other view');
});

test('mergeViews: Home is never the source — it is never dissolved', () => {
  st.initServer([], [mkSession('s1'), mkSession('s2')]);
  st.loadUi();
  // One view per session: take the two auto-tabs apart by hand and hold both
  // sessions where this test wants them.
  const h = home();
  st.state.views = [h];
  h.slots = [sess('s1')];
  const other = addView(null, [sess('s2')]);

  assert.equal(st.mergeViews(other.id, h.id, 0, 'fill'), 'no');
  assert.deepEqual(keys(h), ['s:s1']);
  assert.deepEqual(keys(other), ['s:s2']);

  // The other direction is an ordinary merge.
  assert.equal(st.mergeViews(h.id, other.id, 0, 'fill'), 'ok');
  assert.deepEqual(keys(h), ['s:s1', 's:s2']);
  assert.equal(st.state.views.length, 1);
});

test('moveSessionToView: a terminal joins a folder tab, and the folder tab keeps its files', () => {
  st.initServer([], [mkSession('s1')]);
  st.loadUi();
  const p = addView({ kind: 'project', id: 'p1' }, [file('a.ts')]);
  const src = st.viewOfSession('s1') as ViewState;

  assert.equal(st.moveSessionToView('s1', p.id), 'ok');
  assert.deepEqual(keys(p), ['f:a.ts', 's:s1'], 'free mixing: a file beside a terminal');
  assert.equal(st.state.views.some((v) => v.id === src.id), false, 'the emptied session tab dissolved');
});

// ---------------------------------------------------------------------------
// Persistence: what a reload keeps, and what it must not
// ---------------------------------------------------------------------------

test('save/load: session slots and splits survive a reload; file slots do not; Home comes back first', () => {
  st.initServer([], [mkSession('s1'), mkSession('s2')]);
  st.loadUi();
  const v = st.viewOfSession('s1') as ViewState;
  v.slots = [sess('s1'), file('a.ts'), sess('s2')];
  v.focused = 1; // a FILE pane is focused
  v.l3 = 'R';
  v.split = { col: 0.3, row: 0.7 };
  st.state.views = st.state.views.filter((x) => x.id === home().id || x.id === v.id);
  st.setActiveView(v.id);
  st.saveUi();

  // What a reload really does: forget the module state, read the bag back.
  st.state.views = [];
  st.state.activeViewId = '';
  st.loadUi();

  assert.equal(st.state.views[0]?.root?.kind, 'home', 'Home is recreated at index 0');
  const back = st.state.views.find((x) => x.id === v.id) as ViewState;
  assert.deepEqual(keys(back), ['s:s1', 's:s2'], 'the file pane is not persisted (user decision 10)');
  assert.deepEqual(back.split, { col: 0.3, row: 0.7 }, 'the dragged divider is still where it was');
  assert.equal(back.l3, 'R');
  assert.equal(back.focused, 0, 'focus is remapped onto a pane that survived');
  assert.equal(st.state.activeViewId, v.id);

  // And the bag itself holds no path at all.
  const bag = memoryStorage.getItem(STORAGE_KEY) as string;
  assert.ok(!bag.includes('a.ts'), 'no file path reaches storage before part B4');
});

test('save/load: a folder tab with a terminal comes back; a file-only one does not; Home always does', () => {
  st.initServer([], [mkSession('s1')]);
  st.loadUi();
  // s1 arrived in its own auto-tab; this test wants it in the folder tab, and
  // a session lives in exactly ONE view.
  st.state.views = [home()];
  const withTerm = addView({ kind: 'project', id: 'p1' }, [file('a.ts'), sess('s1')], 'v-term');
  addView({ kind: 'project', id: 'p2' }, [file('b.ts')], 'v-files');
  home().slots = [file('c.ts')];
  const homeId = home().id;
  st.saveUi();

  st.state.views = [];
  st.state.activeViewId = '';
  st.loadUi();

  const back = st.state.views.find((x) => x.id === withTerm.id) as ViewState;
  assert.deepEqual(back?.root, { kind: 'project', id: 'p1' }, 'the folder tab kept its root');
  assert.deepEqual(keys(back), ['s:s1'], 'and the terminal that kept it alive');
  assert.equal(
    st.state.views.some((x) => x.id === 'v-files'),
    false,
    'a tab that held only files has nothing to come back as before B4',
  );
  assert.equal(home().id, homeId, 'Home keeps its identity across the reload');
  assert.deepEqual(home().slots, [], 'empty, because its file was not persisted either');
});

test('save/load: a second Home in the bag is not a second Home', () => {
  // Defence against a hand-edited blob: Home is the tab that is always first,
  // and two of them would make "first" meaningless.
  st.initServer([], []);
  memoryStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      views: [
        { id: 'h1', root: { kind: 'home' }, slots: [], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
        { id: 'h2', root: { kind: 'home' }, slots: [], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
      ],
      active: 'h2',
    }),
  );
  st.loadUi();
  assert.deepEqual(st.state.views.map((v) => v.id), ['h1'], 'the second one was rootless and empty -> dropped');
  assert.equal(home().id, 'h1');
});

test('save/load: a stored FILE slot is ignored — a reload never conjures a file pane', () => {
  st.initServer([], [mkSession('s1')]);
  memoryStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      views: [
        {
          id: 'v1',
          root: { kind: 'project', id: 'p1' },
          slots: [{ kind: 'file', path: 'a.ts' }, sess('s1')],
          focused: 0,
          l3: 'L',
          split: { col: 0.5, row: 0.5 },
        },
      ],
      active: 'v1',
    }),
  );
  st.loadUi();
  const v = st.state.views.find((x) => x.id === 'v1') as ViewState;
  assert.deepEqual(keys(v), ['s:s1'], 'nothing was ever read from disk, so nothing is restored');
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

test("openFile / openFileAt / closeSlot / movePane all notify 'ui' — a file is a PANE now", () => {
  // Not 'screen': that kind means "something OTHER than the panes fills the
  // pane area" (the commit view), and `ui/panes.ts` ignores it on purpose. A
  // file pane that announced itself with 'screen' would never be drawn.
  st.initServer([], []);
  st.loadUi();
  const { kinds } = collectKinds();
  const only = (fn: () => void): string[] => {
    kinds.length = 0;
    fn();
    return [...new Set(kinds)];
  };

  assert.deepEqual(only(() => st.openFile({ kind: 'home' }, 'a.ts', 'a.ts')), ['ui']);
  assert.deepEqual(only(() => st.openFileAt(home().id, 0, 'left', 'b.ts')), ['ui']);
  assert.deepEqual(only(() => st.movePane('right')), ['ui']);
  assert.deepEqual(only(() => st.closeSlot(home().id, 0)), ['ui']);
  assert.deepEqual(only(() => st.openFile({ kind: 'project', id: 'p1' }, 'c.ts', 'c.ts')), ['ui']);
  // A rejection is silent: nothing changed, so nothing re-renders.
  assert.deepEqual(only(() => st.openFileAt('nope', 0, 'left', 'd.ts')), []);
  assert.deepEqual(only(() => st.closeSlot('nope', 0)), []);
});

test("saveEdit notifies 'ui' (the dot it clears lives on a pane header) and a clean file is silent", () => {
  st.initServer([], []);
  st.loadUi();
  const { kinds } = collectKinds();
  const id = st.editorFileId('a.ts');

  st.setEdit(id, 'typed');
  assert.deepEqual(kinds, [], 'a keystroke never notifies — it would take the caret with it');
  assert.equal(st.editorDirty(id), true);
  assert.equal(st.editText(id), 'typed');

  assert.equal(st.saveEdit(id), 'typed', 'the caller writes it where it belongs');
  assert.deepEqual(kinds, ['ui']);
  assert.equal(st.editorDirty(id), false);
  assert.equal(st.saveEdit(id), null);
  assert.deepEqual(kinds, ['ui'], 'saving a clean file changes nothing');
});

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
    // Installed-mode fields (2026-09-08): a developer clone answers null/false.
    version: null,
    installed: false,
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

test('setRuntime: an INSTALLED backend carries its version and flag beside the commit', () => {
  // Installer phase C (2026-09-08). The panel's `version` fact and the
  // `Check for updates` link both read these two; a poll that dropped them
  // would silently turn an installed app back into a developer clone on screen.
  const { kinds } = collectKinds();
  const iso = new Date().toISOString();
  const installed = {
    startedAt: iso,
    // A packaged tree has no git checkout to read a hash from.
    serverCommit: null,
    version: 'v0.2.0',
    installed: true,
    webBuild: 'assets/index-Br1e6z0Q.js',
    update: { available: false, reason: null },
  };
  st.setRuntime(installed);
  assert.equal(st.state.version, 'v0.2.0');
  assert.equal(st.state.installed, true);
  assert.equal(st.state.serverCommit, null);
  assert.deepEqual(kinds, ['conn']);

  st.setRuntime(installed);
  assert.deepEqual(kinds, ['conn'], 'the same installed answer again must not renotify');

  // A newer bundle taking the port is a change even when nothing else moved.
  st.setRuntime({ ...installed, version: 'v0.3.0' });
  assert.equal(st.state.version, 'v0.3.0');
  assert.deepEqual(kinds, ['conn', 'conn'], 'a new bundle version is a change');

  // …and so is the mode itself flipping, which is what a handover to a
  // developer clone on the same port would look like.
  st.setRuntime({ ...installed, version: null, installed: false, serverCommit: 'a1b2c3d' });
  assert.equal(st.state.installed, false);
  assert.equal(st.state.version, null, 'a clone must not keep the previous run’s version');
  assert.equal(st.state.serverCommit, 'a1b2c3d');
  assert.deepEqual(kinds, ['conn', 'conn', 'conn']);
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
      path: '/home/you/projects/ai-cli-application',
      createdAt: '2026-09-06T12:00:00.000Z',
    },
    {
      id: 'p2',
      name: 'notes',
      path: '/home/you/projects/acme/notes',
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

// ---------------------------------------------------------------------------
// The left panel (Nocturne A5) rides in the same v2 bag as the pane splits
// ---------------------------------------------------------------------------

test('saveUi/loadUi: a dragged Files width and a closed panel survive a reload', () => {
  st.initServer([], []);
  st.loadUi();
  assert.equal(st.state.leftPanel, 'files', 'the panel is wanted by default');
  assert.equal(st.state.filesWidth, st.FILES_W_DEFAULT);

  st.setFilesWidth(460);
  st.toggleLeftPanel('files'); // closes it

  // What a reload really does: forget the module state, read the bag back.
  st.state.filesWidth = st.FILES_W_DEFAULT;
  st.state.leftPanel = 'files';
  st.loadUi();

  assert.equal(st.state.filesWidth, 460, 'the dragged width is still the dragged width');
  assert.equal(st.state.leftPanel, null, 'and the panel the user closed stays closed');

  // Same key as the splits, no version bump.
  const bag = JSON.parse(memoryStorage.getItem(STORAGE_KEY) as string) as Record<string, unknown>;
  assert.deepEqual([bag.filesWidth, bag.leftPanel], [460, null]);
});

test('saveUi: a live drag (commit false) writes nothing; the commit at the end does', () => {
  st.initServer([], []);
  st.loadUi();
  st.setFilesWidth(420, false);
  let bag = JSON.parse(memoryStorage.getItem(STORAGE_KEY) as string) as Record<string, unknown>;
  assert.equal(bag.filesWidth, st.FILES_W_DEFAULT, 'sixty writes a second is what this avoids');
  st.setFilesWidth(420, true);
  bag = JSON.parse(memoryStorage.getItem(STORAGE_KEY) as string) as Record<string, unknown>;
  assert.equal(bag.filesWidth, 420);
});

test('loadUi: a garbage width falls back to the default, and a garbage wish to open', () => {
  st.initServer([], []);
  for (const bad of ['wide', null, {}, [], true, Number.NaN]) {
    memoryStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ views: [], active: null, filesWidth: bad, leftPanel: 'sideways' }),
    );
    st.loadUi();
    assert.equal(st.state.filesWidth, st.FILES_W_DEFAULT, `filesWidth: ${JSON.stringify(bad)}`);
    assert.equal(st.state.leftPanel, 'files', 'an unknown panel name is not a panel');
  }

  // Out of range is not garbage — it is clamped, like a split fraction.
  memoryStorage.setItem(STORAGE_KEY, JSON.stringify({ views: [], active: null, filesWidth: 9000 }));
  st.loadUi();
  assert.equal(st.state.filesWidth, st.FILES_W_MAX);
  memoryStorage.setItem(STORAGE_KEY, JSON.stringify({ views: [], active: null, filesWidth: 12 }));
  st.loadUi();
  assert.equal(st.state.filesWidth, st.FILES_W_MIN);
});

test('loadUi: a pre-A5 v2 blob (neither key) opens the panel at the default width', () => {
  st.initServer([], []);
  memoryStorage.setItem(STORAGE_KEY, JSON.stringify({ views: [], active: null }));
  st.state.leftPanel = null;
  st.state.filesWidth = 512;
  st.loadUi();
  assert.equal(st.state.leftPanel, 'files');
  assert.equal(st.state.filesWidth, st.FILES_W_DEFAULT);
});
