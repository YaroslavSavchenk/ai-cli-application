/**
 * `web/src/state.ts` — client-local view arrangement + persistence, and the
 * conn-state setters feeding the R2 statusline/topbar dot.
 *
 * Since A10 (user decision 2026-09-15) a view holds 0..4 SLOTS and `Home` is a
 * real view that is always `state.views[0]`; since A10b a slot is a terminal
 * or an EDITOR PANE holding a strip of file/diff TABS, and the two mix freely.
 * The half of this file that used to say "sessions" says "slots" now, and the
 * rules A10/A10b introduced (roots, editor panes, the strip, what survives a
 * reload) are at the bottom.
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
import type { HistoryEntry, SessionInfo } from '../../shared/protocol.ts';

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
const st = await import('../../web/src/state.ts');
// Types come from a static (erased) import; `st` itself is the runtime module,
// loaded after the localStorage shim above.
type ViewState = import('../../web/src/state.ts').ViewState;
type PaneSlot = import('../../web/src/state.ts').PaneSlot;
type EditorSlot = import('../../web/src/state.ts').EditorSlot;
type EditorTab = import('../../web/src/state.ts').EditorTab;
type ViewRoot = import('../../web/src/state.ts').ViewRoot;

/**
 * `loadUi` as every test before part B6 meant it: `Reopen tabs on start` ON,
 * which is the factory setting — the run stamp is then never consulted, so a
 * boot that does not know its run (null) reads a bag the same way a browser
 * reload does. The D3 gate has its own tests at the bottom of this file.
 */
const REOPEN: import('../../web/src/state.ts').LoadUiOpts = { reopen: true, run: null };

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

const E = await import('../../web/src/ui/editor-model.ts');

/** The folder every diff tab below is read from (part B3). */
const REPO = '/home/you/projects/app';

/**
 * The three files the persistence tests open. ABSOLUTE, because that is the
 * shape every path in the app has had since part B2 — and since part B4 the
 * storage reader refuses anything else (a relative path names no file).
 */
const A = '/home/you/web/src/Pane.tsx';
const B = '/home/you/web/src/App.tsx';
const C = '/home/you/README.md';
/** A commit hash as every answer carries it: the full 40 hex, lower case. */
const HASH40 = 'a'.repeat(40);

const sess = (id: string): PaneSlot => ({ kind: 'session', id });
const ftab = (path: string): EditorTab => ({ kind: 'file', path });
const dtab = (hash: string, path: string): EditorTab => ({ kind: 'diff', hash, path, root: REPO });
/** The folder a diff tab is read from (B3) — one repository for the whole file. */
/** An editor pane holding these files as tabs (A10b: files are TABS, not panes). */
const ed = (...paths: string[]): EditorSlot => st.newEditorSlot(paths.map(ftab));
/** An editor pane holding these tabs verbatim (for diffs, or a chosen active). */
const edTabs = (...tabs: EditorTab[]): EditorSlot => st.newEditorSlot(tabs);
const keys = (v: ViewState): string[] => v.slots.map((s: PaneSlot) => st.slotKey(s));
/**
 * A view's PANES, readable: a session's key, or the tab ids of an editor pane.
 * Editor slot keys are a page-lifetime counter (`e:<n>`), so a test that named
 * them would break every time another test opened a pane first — the shape a
 * reader cares about is "which panes, holding which tabs".
 */
const shape = (v: ViewState): (string | string[])[] =>
  v.slots.map((s: PaneSlot) => (s.kind === 'session' ? st.slotKey(s) : st.slotTabIds(s)));
/** The strip of one editor pane, by slot index. */
const strip = (v: ViewState, slot: number): string[] => st.slotTabIds(v.slots[slot] as PaneSlot);
/** Which tab that pane is showing. */
const activeId = (v: ViewState, slot: number): string | null => {
  const t = st.activeTabOf(v.slots[slot] as PaneSlot);
  return t === null ? null : E.tabIdOf(t);
};

before(() => {
  resetState();
});

beforeEach(() => {
  resetState();
});

// ---------------------------------------------------------------------------
// B6 D3 — `setRunStamp` before the boot has read the bag. THIS TEST IS FIRST
// ON PURPOSE: the guard it pins is a module-level flag `loadUi` sets once and
// nothing can unset, so it can only be observed before any other test loads.
// ---------------------------------------------------------------------------

test('D3: setRunStamp before loadUi adopts the run but writes nothing over the stored bag', () => {
  st.initServer([], []);
  bagWithTabs(RUN_A);
  const raw = memoryStorage.getItem(STORAGE_KEY);
  st.setRunStamp(RUN_B);
  assert.equal(st.state.serverStartedAt, RUN_B, 'the run is adopted');
  assert.equal(
    memoryStorage.getItem(STORAGE_KEY),
    raw,
    'and the bag is untouched — a save here would write views: [] over the user’s arrangement',
  );
});

// ---------------------------------------------------------------------------
// The empty state (R2: launcher tab is no longer ever-present; A10: Home is)
// ---------------------------------------------------------------------------

test('loadUi: nothing stored and no server sessions -> Home alone, empty, active', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  assert.equal(st.state.views.length, 1, 'Home is the whole strip');
  assert.deepEqual(home().slots, [], 'and it holds no panes — zero slots is the empty state');
  assert.equal(st.state.activeViewId, home().id);
});

test('closeView down to the last session tab leaves Home — and Home refuses to close', () => {
  st.initServer([], [mkSession('s1')]);
  st.loadUi(REOPEN); // no stored arrangement -> reconcileViews auto-tabs the orphan session s1
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

  st.loadUi(REOPEN);

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

  assert.doesNotThrow(() => st.loadUi(REOPEN));

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

  st.loadUi(REOPEN);

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

  st.loadUi(REOPEN);

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

  assert.doesNotThrow(() => st.loadUi(REOPEN));
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

  st.loadUi(REOPEN);

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

  assert.doesNotThrow(() => st.loadUi(REOPEN));
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
  assert.equal(st.viewStatus(mkView([ed('web/src/main.ts')], { kind: 'project', id: 'p1' })), 'none');
  assert.equal(st.viewStatus(mkView([edTabs(dtab('474d891', 'server/ws.ts'))])), 'none');
  // One terminal beside the files and the dot is back.
  const s = mkSession('s1');
  st.state.sessions.set(s.id, s);
  assert.equal(st.viewStatus(mkView([ed('a.ts'), sess('s1')])), 'run');
});

test("viewStatus (B11): the tab dot follows the session readout — attn > wait > work > run > exit", () => {
  st.state.sessions.clear();
  const working = mkSession('s1');
  working.turn = 'working';
  const waiting = mkSession('s2');
  waiting.turn = 'waiting';
  const plain = mkSession('s3'); // no turn readout: a shell, or no transcript
  const exited = mkSession('s4');
  exited.status = 'exited';
  exited.turn = 'waiting'; // stale: exited beats it
  const attn = mkSession('s5');
  attn.attention = true;
  attn.turn = 'working';
  for (const s of [working, waiting, plain, exited, attn]) st.state.sessions.set(s.id, s);
  assert.equal(st.viewStatus(mkView([sess('s1'), sess('s2'), sess('s5')])), 'attn', 'a BEL wins');
  assert.equal(st.viewStatus(mkView([sess('s1'), sess('s2'), sess('s3')])), 'wait', 'an ended turn beats work');
  assert.equal(st.viewStatus(mkView([sess('s3'), sess('s1')])), 'work', 'known work pulses over plain running');
  assert.equal(st.viewStatus(mkView([sess('s4'), sess('s3')])), 'run', 'no turn readout stays still green');
  assert.equal(st.viewStatus(mkView([sess('s4')])), 'exit', 'a stale turn on an exited session is ignored');
  // The tab's `Needs you` PILL stays BEL-only.
  assert.equal(st.viewAttention(mkView([sess('s2')])), false, 'waiting is not attention');
  st.state.sessions.clear();
});

test('attentionCount counts BELs only — an ended turn (B11 waiting) is not counted (user, 2026-09-22)', () => {
  st.state.sessions.clear();
  const both = mkSession('s1');
  both.attention = true;
  both.turn = 'waiting';
  const waiting = mkSession('s2');
  waiting.turn = 'waiting';
  const working = mkSession('s3');
  working.turn = 'working';
  for (const s of [both, waiting, working]) st.state.sessions.set(s.id, s);
  assert.equal(st.attentionCount(), 1);
  st.state.sessions.clear();
  assert.equal(st.attentionCount(), 0);
});

test('viewAttention reads SESSIONS only — a file never asks for anything', () => {
  const attn = mkSession('s1');
  attn.attention = true;
  st.state.sessions.set(attn.id, attn);
  assert.equal(st.viewAttention(mkView([ed('a.ts')])), false);
  assert.equal(st.viewAttention(mkView([ed('a.ts'), sess('s1')])), true);
  assert.deepEqual(st.sessionIds(mkView([ed('a.ts'), sess('s1'), ed('b.ts')])), ['s1']);
});

// ===========================================================================
// A10 (user decision 2026-09-15): slots, roots, Home, files as panes
// ===========================================================================

test('slotTabIds / editorFileId: a TAB id is BYTE-IDENTICAL to fileTabId/diffTabId', () => {
  // This is the `state.edits` contract: the key a tab is drawn under and the
  // key its unsaved text lives under are ONE string, or two panes on one file
  // would hold two different texts.
  for (const path of ['web/src/main.ts', 'LICENSE', 'a b/c:d.ts', '']) {
    assert.deepEqual(st.slotTabIds(ed(path)), [E.fileTabId(path)]);
    assert.equal(st.editorFileId(path), E.fileTabId(path), 'one spelling for every caller');
  }
  assert.deepEqual(st.slotTabIds(edTabs(dtab('474d891', 'server/ws.ts'))), [
    E.diffTabId('474d891', 'server/ws.ts'),
  ]);
  assert.deepEqual(st.slotTabIds(ed('a.ts', 'b.ts')), ['f:a.ts', 'f:b.ts'], 'in strip order');
  assert.deepEqual(st.slotTabIds(sess('s1')), [], 'a terminal holds no tabs');
});

test('slotKey: a pane KEY is its own identity — a session id, or the pane\'s generated e:<n>', () => {
  // TAB ID != SLOT KEY (A10b). `ui/panes.ts` keys its live panes by this: a key
  // derived from the active tab would make every tab add/close/switch look like
  // a different pane — teardown, caret lost, focus stolen.
  assert.equal(st.slotKey(sess('s1')), 's:s1');
  const a = ed('a.ts');
  const b = ed('a.ts');
  assert.match(st.slotKey(a), /^e:\d+$/);
  assert.notEqual(st.slotKey(a), st.slotKey(b), 'two panes on the SAME file are two panes');
  assert.notEqual(st.slotKey(a), 'f:a.ts', 'a pane key is never a tab id');
  assert.equal(st.activeTabOf(sess('s1')), null, 'a terminal shows no tab');
  assert.deepEqual(st.activeTabOf(ed('a.ts', 'b.ts')), ftab('a.ts'), 'a fresh pane shows its first');
});

test('slotKey is STABLE across a tab being added, switched and closed', () => {
  // The mutant this kills: `slotKey` derived from the active tab. Every string
  // below is compared BYTE-IDENTICAL to the one taken before the strip moved.
  st.initServer([], []);
  st.loadUi(REOPEN);
  assert.equal(st.openFile({ kind: 'home' }, 'a.ts', 'a.ts'), 'ok');
  const v = home();
  const key = st.slotKey(v.slots[0] as PaneSlot);

  assert.equal(st.openFile({ kind: 'home' }, 'b.ts', 'b.ts'), 'ok');
  assert.equal(st.slotKey(v.slots[0] as PaneSlot), key, 'adding a tab did not make a new pane');
  assert.equal(st.setActiveTab(v.id, 0, 0), true);
  assert.equal(st.slotKey(v.slots[0] as PaneSlot), key, 'nor did switching to another tab');
  assert.equal(st.closeTab(v.id, 0, 1), true);
  assert.equal(st.slotKey(v.slots[0] as PaneSlot), key, 'nor did closing one');
  assert.deepEqual(strip(v, 0), ['f:a.ts'], 'precondition: the strip really did change');
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
  assert.deepEqual(shape(home()), [['f:a/one.ts']], 'and that is where a file row lands');
  assert.deepEqual(keys(st.state.views[1] as ViewState), ['s:s1'], 'never in the session tab beside it');
});

test('isFolderView: Home and a project tab are folder tabs; a session tab is not', () => {
  assert.equal(st.isFolderView(mkView([], { kind: 'home' })), true);
  assert.equal(st.isFolderView(mkView([], { kind: 'project', id: 'p1' })), true);
  assert.equal(st.isFolderView(mkView([sess('s1')])), false);
});

test('viewForRoot: finds the folder tab it already made, and makes one only once', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
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

test('openFile: the FIRST file makes one editor pane; the SECOND is a TAB in it', () => {
  // User decision 1 (A10b): files must NOT each become their own pane. The
  // pane count is the whole point — this is the bug the user corrected A10 on.
  st.initServer([], []);
  st.loadUi(REOPEN);
  assert.equal(st.openFile({ kind: 'home' }, 'web/src/main.ts', 'main.ts'), 'ok');
  assert.equal(home().slots.length, 1, 'one pane');
  assert.deepEqual(strip(home(), 0), ['f:web/src/main.ts']);
  assert.equal(home().focused, 0);
  assert.equal(st.state.activeViewId, home().id);

  assert.equal(st.openFile({ kind: 'home' }, 'web/src/ui/panes.ts', 'panes.ts'), 'ok');
  assert.equal(home().slots.length, 1, 'STILL one pane — the second file is a tab');
  assert.deepEqual(strip(home(), 0), ['f:web/src/main.ts', 'f:web/src/ui/panes.ts']);
  assert.equal(activeId(home(), 0), 'f:web/src/ui/panes.ts', 'the new tab is the one on screen');
  assert.equal(home().focused, 0);
});

test('openFile: the same path RAISES the tab it is already on — never a second copy', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  for (const p of ['a.ts', 'b.ts', 'c.ts']) assert.equal(st.openFile({ kind: 'home' }, p, p), 'ok');
  const before = strip(home(), 0);
  assert.equal(activeId(home(), 0), 'f:c.ts');

  assert.equal(st.openFile({ kind: 'home' }, 'a.ts', 'a.ts'), 'ok');
  assert.deepEqual(strip(home(), 0), before, 'the strip is exactly as long as it was');
  assert.equal(activeId(home(), 0), 'f:a.ts', 'and `active` moved to it');
});

test('openFile: a file open in a NON-FOCUSED pane is raised THERE, pane focus and all', () => {
  // The raise-vs-add branch, on the arrangement that tells them apart: the tab
  // is in another pane of the same tab, and the focused pane is a different one.
  st.initServer([], []);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts', 'b.ts'), ed('c.ts')]);
  v.focused = 1;
  (v.slots[0] as EditorSlot).active = 0;

  assert.equal(st.openFile({ kind: 'project', id: 'p1' }, 'b.ts', 'b.ts'), 'ok');
  assert.equal(v.slots.length, 2, 'no pane was made');
  assert.deepEqual(shape(v), [['f:a.ts', 'f:b.ts'], ['f:c.ts']], 'and no tab was added');
  assert.equal(v.focused, 0, 'the pane holding it takes the focus');
  assert.equal(activeId(v, 0), 'f:b.ts', 'and it is the tab on screen there');
});

test('openFile: a focused TERMINAL sends the tab to the view’s FIRST editor pane', () => {
  // Never a split off the terminal: the terminal is the hero, and the user
  // asked for the file, not for a smaller shell.
  st.initServer([], [mkSession('s1')]);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts'), sess('s1'), ed('b.ts')]);
  v.focused = 1;

  assert.equal(st.openFile({ kind: 'project', id: 'p1' }, 'new.ts', 'new.ts'), 'ok');
  assert.equal(v.slots.length, 3, 'the pane count did not move');
  assert.deepEqual(shape(v), [['f:a.ts', 'f:new.ts'], 's:s1', ['f:b.ts']], 'the FIRST editor pane');
  assert.equal(v.focused, 0, 'and the keyboard follows the file');
  assert.equal(activeId(v, 0), 'f:new.ts');
});

test('openFile: a NEW file lands in the FOCUSED editor pane, never in the first one', () => {
  // `targetEditorIndex`: the FOCUSED editor pane wins, and only a focused
  // TERMINAL falls back to the first one. Without the focused branch every new
  // file would pile into pane 0 while the user was working in pane 1 — a bug
  // the raise-it-where-it-is tests cannot see, because the file is NEW.
  st.initServer([], []);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts'), ed('b.ts')]);
  v.focused = 1;

  assert.equal(st.openFile({ kind: 'project', id: 'p1' }, 'new.ts', 'new.ts'), 'ok');
  assert.equal(v.slots.length, 2, 'no pane was made');
  assert.deepEqual(shape(v), [['f:a.ts'], ['f:b.ts', 'f:new.ts']], 'the FOCUSED pane took it');
  assert.equal(v.focused, 1, 'and the keyboard stayed where the user was');
  assert.equal(activeId(v, 1), 'f:new.ts');

  // The same view, the other pane focused: the tab follows the focus.
  v.focused = 0;
  assert.equal(st.openFile({ kind: 'project', id: 'p1' }, 'other.ts', 'other.ts'), 'ok');
  assert.deepEqual(shape(v), [['f:a.ts', 'f:other.ts'], ['f:b.ts', 'f:new.ts']]);
});

test('openFile: with NO editor pane and four panes up, it is refused and nothing changes', () => {
  st.initServer([], [mkSession('s1'), mkSession('s2'), mkSession('s3'), mkSession('s4')]);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [sess('s1'), sess('s2'), sess('s3'), sess('s4')]);
  const before = shape(v);
  assert.equal(v.slots.length, st.MAX_PANES, 'precondition: the tab is full of terminals');

  assert.equal(st.openFile({ kind: 'project', id: 'p1' }, 'a.ts', 'a.ts'), 'full');
  assert.deepEqual(shape(v), before, 'a rejection changes nothing');

  // One editor pane among them and there is room again — in its strip.
  st.state.views = st.state.views.filter((x) => x.id !== v.id);
  const w = addView({ kind: 'project', id: 'p2' }, [sess('s1'), ed('a.ts'), sess('s2'), sess('s3')]);
  w.focused = 3;
  assert.equal(st.openFile({ kind: 'project', id: 'p2' }, 'b.ts', 'b.ts'), 'ok');
  assert.equal(w.slots.length, st.MAX_PANES, 'still four panes');
  assert.deepEqual(strip(w, 1), ['f:a.ts', 'f:b.ts']);
});

test('openFile: a project root opens its own folder tab and activates it', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  assert.equal(st.openFile({ kind: 'project', id: 'p1' }, 'server/ws.ts', 'ws.ts'), 'ok');
  const v = st.state.views[1] as ViewState;
  assert.deepEqual(v.root, { kind: 'project', id: 'p1' });
  assert.deepEqual(shape(v), [['f:server/ws.ts']]);
  assert.equal(st.state.activeViewId, v.id);
  assert.deepEqual(home().slots, [], 'and Home is not where it went');
});

test('openDiff: a read-only diff is a TAB of the same pane, and the same one raises', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  assert.equal(st.openFile({ kind: 'home' }, 'server/ws.ts', 'ws.ts'), 'ok');
  assert.equal(st.openDiff({ kind: 'home' }, '474d891', 'server/ws.ts', REPO), 'ok');
  assert.equal(home().slots.length, 1, 'one pane, two tabs');
  assert.deepEqual(strip(home(), 0), ['f:server/ws.ts', 'd:474d891:server/ws.ts']);
  assert.equal(activeId(home(), 0), 'd:474d891:server/ws.ts');

  assert.equal(st.openDiff({ kind: 'home' }, '474d891', 'server/ws.ts', REPO), 'ok');
  assert.deepEqual(strip(home(), 0), ['f:server/ws.ts', 'd:474d891:server/ws.ts'], 'raised');
  // The same file in another commit is a different tab.
  assert.equal(st.openDiff({ kind: 'home' }, '55c9be7', 'server/ws.ts', REPO), 'ok');
  assert.equal(strip(home(), 0).length, 3);
});

test('openDiff then openFile of the SAME path: two tabs, because they are two ids', () => {
  // The raise is keyed on the TAB ID, not on the path: the read-only changes
  // in a commit and the editable file are two different things to look at, and
  // `f:` / `d:` are two different `state.edits` keys.
  st.initServer([], []);
  st.loadUi(REOPEN);
  assert.equal(st.openDiff({ kind: 'home' }, '474d891', 'server/ws.ts', REPO), 'ok');
  assert.equal(st.openFile({ kind: 'home' }, 'server/ws.ts', 'ws.ts'), 'ok');
  assert.equal(home().slots.length, 1, 'still ONE pane');
  assert.deepEqual(strip(home(), 0), ['d:474d891:server/ws.ts', 'f:server/ws.ts'], 'two tabs');
  assert.equal(activeId(home(), 0), 'f:server/ws.ts', 'the file the user just asked for is up');
  // And neither of the two raises the other.
  assert.equal(st.openDiff({ kind: 'home' }, '474d891', 'server/ws.ts', REPO), 'ok');
  assert.deepEqual(strip(home(), 0), ['d:474d891:server/ws.ts', 'f:server/ws.ts']);
  assert.equal(activeId(home(), 0), 'd:474d891:server/ws.ts');
});

// ---------------------------------------------------------------------------
// openTabAt — the drop zones (A10b renamed it from openFileAt on purpose)
// ---------------------------------------------------------------------------

test('openTabAt: every (count, zone) the pane can offer — and nothing it cannot', () => {
  // The matrix `dropZonesFor` describes IS what openTabAt accepts: the drag
  // layer reads the first and calls the second, so a disagreement between them
  // is a file that lands somewhere the drop indicator never pointed at.
  for (let count = 1; count <= st.MAX_PANES; count++) {
    for (let slot = 0; slot < count; slot++) {
      for (const l3 of ['L', 'R'] as const) {
        for (const zone of ['left', 'right', 'top', 'bottom', 'fill'] as const) {
          resetState();
          const v = addView(null, Array.from({ length: count }, (_, i) => ed(`f${i}.ts`)));
          v.l3 = l3;
          const offered = st.dropZonesFor(v, slot, 1);
          const result = st.openTabAt(v.id, slot, zone, ftab('new.ts'));
          const label = `count=${count} slot=${slot} l3=${l3} zone=${zone}`;
          if (offered.includes(zone)) {
            assert.equal(result, 'ok', label);
            assert.equal(v.slots.length, count + 1, label);
            assert.deepEqual(strip(v, v.focused), ['f:new.ts'], `focus: ${label}`);
          } else {
            assert.equal(result, count === st.MAX_PANES ? 'full' : 'no-zone', label);
            assert.equal(v.slots.length, count, `unchanged: ${label}`);
          }
        }
      }
    }
  }
});

test('openTabAt: the CENTRE of an editor pane ADDS a tab (and raises); a terminal refuses', () => {
  // Orchestrator default 4 (A10b): a pane full of the user's other files is
  // not something a drop may throw away, so the centre never replaces.
  st.initServer([], [mkSession('s1')]);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts'), sess('s1')]);

  assert.equal(st.openTabAt(v.id, 1, 'replace', ftab('new.ts')), 'session-centre');
  assert.deepEqual(shape(v), [['f:a.ts'], 's:s1'], 'the terminal is still there');

  assert.equal(st.openTabAt(v.id, 0, 'replace', ftab('new.ts')), 'ok');
  assert.deepEqual(shape(v), [['f:a.ts', 'f:new.ts'], 's:s1'], 'a.ts was NOT thrown away');
  assert.equal(v.slots.length, 2, 'and it cost no pane');
  assert.equal(v.focused, 0);
  assert.equal(activeId(v, 0), 'f:new.ts');

  // The same file again on the same centre: raised, not doubled.
  assert.equal(st.openTabAt(v.id, 0, 'replace', ftab('a.ts')), 'ok');
  assert.deepEqual(strip(v, 0), ['f:a.ts', 'f:new.ts']);
  assert.equal(activeId(v, 0), 'f:a.ts');

  // The centre works on a FULL tab too, for the same reason.
  const full = addView(null, [ed('a.ts'), ed('b.ts'), ed('c.ts'), ed('d.ts')]);
  assert.equal(st.openTabAt(full.id, 3, 'replace', ftab('new.ts')), 'ok');
  assert.deepEqual(shape(full), [['f:a.ts'], ['f:b.ts'], ['f:c.ts'], ['f:d.ts', 'f:new.ts']]);
});

test('openTabAt: an unknown view or an unknown pane is `no-view`, never a guess', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  const v = addView(null, [ed('a.ts')]);
  assert.equal(st.openTabAt('nope', 0, 'replace', ftab('new.ts')), 'no-view');
  assert.equal(st.openTabAt(v.id, 3, 'left', ftab('new.ts')), 'no-view');
  assert.equal(st.openTabAt(v.id, -1, 'replace', ftab('new.ts')), 'no-view');
  assert.deepEqual(shape(v), [['f:a.ts']]);
});

// ---------------------------------------------------------------------------
// FOUR TABS PER PANE (part B4 amendment, the user's Windows check 2026-09-22:
// "ik kan oneindig veel tabs open hebben, limiteer dat met 4")
//
// One cap (`MAX_TABS`), three rules: an OPEN into a full strip evicts the tab
// in the last position and takes its place; a RAISE evicts nothing; a MOVE is
// refused rather than evicting. `evictionFor` is the pure plan `ui/unsaved.ts`
// reads before it asks about unsaved text (pinned in tests/ui/ui-unsaved.test.ts).
// ---------------------------------------------------------------------------

test('MAX_TABS is four — the number the user asked for, and the persistence cap', () => {
  assert.equal(st.MAX_TABS, 4);
});

test('openFile: a FIFTH file evicts the LAST chip and takes its place, active', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  for (const p of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) {
    assert.equal(st.openFile({ kind: 'home' }, p, p), 'ok');
  }
  assert.deepEqual(strip(home(), 0), ['f:a.ts', 'f:b.ts', 'f:c.ts', 'f:d.ts'], 'precondition: full');

  assert.equal(st.openFile({ kind: 'home' }, 'e.ts', 'e.ts'), 'ok', 'the open still succeeds');
  assert.deepEqual(
    strip(home(), 0),
    ['f:a.ts', 'f:b.ts', 'f:c.ts', 'f:e.ts'],
    'position 4 made room; the three the user opened first stay where they were',
  );
  assert.equal(home().slots.length, 1, 'and it cost no pane');
  assert.equal((home().slots[0] as EditorSlot).active, 3, 'the new tab is AT position 4');
  assert.equal(activeId(home(), 0), 'f:e.ts', 'and it is the one on screen');
});

test('openFile: a file already in a FULL strip is RAISED — it evicts nothing', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  for (const p of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) st.openFile({ kind: 'home' }, p, p);

  assert.equal(st.openFile({ kind: 'home' }, 'a.ts', 'a.ts'), 'ok');
  assert.deepEqual(strip(home(), 0), ['f:a.ts', 'f:b.ts', 'f:c.ts', 'f:d.ts'], 'all four survive');
  assert.equal(activeId(home(), 0), 'f:a.ts', 'raised, not re-added');
});

test('openFile: a diff counts in the same four — files and diffs share the strip', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  for (const p of ['a.ts', 'b.ts', 'c.ts']) st.openFile({ kind: 'home' }, p, p);
  assert.equal(st.openDiff({ kind: 'home' }, HASH40, 'a.ts', REPO), 'ok');
  assert.equal(strip(home(), 0).length, 4, 'three files and one diff IS full');

  assert.equal(st.openFile({ kind: 'home' }, 'e.ts', 'e.ts'), 'ok');
  assert.deepEqual(
    strip(home(), 0),
    ['f:a.ts', 'f:b.ts', 'f:c.ts', 'f:e.ts'],
    'and the diff is what the fifth file evicted',
  );
});

test('openFile: a NEW pane never evicts — the cap is per strip, not per tab', () => {
  st.initServer([], [mkSession('s1')]);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [sess('s1'), ed('a.ts', 'b.ts', 'c.ts', 'd.ts')]);
  st.state.activeViewId = v.id;
  v.focused = 1;

  // The focused editor pane is full, so THIS open evicts...
  assert.equal(st.openFile({ kind: 'project', id: 'p1' }, 'e.ts', 'e.ts'), 'ok');
  assert.deepEqual(shape(v), ['s:s1', ['f:a.ts', 'f:b.ts', 'f:c.ts', 'f:e.ts']]);

  // ...while a tab with NO editor pane makes one, holding a single tab.
  const bare = addView({ kind: 'project', id: 'p2' }, [sess('s1')]);
  bare.slots = [];
  assert.equal(st.openFile({ kind: 'project', id: 'p2' }, 'z.ts', 'z.ts'), 'ok');
  assert.deepEqual(shape(bare), [['f:z.ts']], 'one tab in a pane of its own');
});

test('openTabAt: the CENTRE of a FULL strip evicts its last chip too (the drop)', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts', 'b.ts', 'c.ts', 'd.ts')]);

  assert.equal(st.openTabAt(v.id, 0, 'replace', ftab('new.ts')), 'ok');
  assert.deepEqual(shape(v), [['f:a.ts', 'f:b.ts', 'f:c.ts', 'f:new.ts']]);
  assert.equal(activeId(v, 0), 'f:new.ts');

  // An EDGE makes a new pane and evicts nothing, however full the strip is.
  assert.equal(st.openTabAt(v.id, 0, 'left', ftab('edge.ts')), 'ok');
  assert.deepEqual(shape(v), [['f:edge.ts'], ['f:a.ts', 'f:b.ts', 'f:c.ts', 'f:new.ts']]);
});

test('the evicted chip loses its unsaved text — and only when no other tab shows it', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts', 'b.ts', 'c.ts', 'd.ts')]);
  st.setEdit('f:d.ts', 'typed\n');

  assert.equal(st.openTabAt(v.id, 0, 'replace', ftab('new.ts')), 'ok');
  assert.equal(st.state.edits.has('f:d.ts'), false, 'the orphaned text is pruned by the eviction');

  // The same eviction with the file ALSO open in a second pane keeps the text.
  const w = addView({ kind: 'project', id: 'p2' }, [ed('a.ts', 'b.ts', 'c.ts', 'x.ts'), ed('x.ts')]);
  st.setEdit('f:x.ts', 'typed\n');
  assert.equal(st.openTabAt(w.id, 0, 'replace', ftab('new.ts')), 'ok');
  assert.equal(st.state.edits.get('f:x.ts'), 'typed\n', 'the other pane still shows it');
});

test('evictionFor: the PLAN, pure — what would leave, and what that would lose', () => {
  st.initServer([], [mkSession('s1')]);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts', 'b.ts', 'c.ts', 'd.ts'), sess('s1')]);

  assert.deepEqual(
    st.evictionFor(v.id, 0, 'f:e.ts'),
    { tabIndex: 3, lostIds: [] },
    'position 4 leaves, and a clean tab loses nothing',
  );
  st.setEdit('f:d.ts', 'typed\n');
  assert.deepEqual(
    st.evictionFor(v.id, 0, 'f:e.ts'),
    { tabIndex: 3, lostIds: ['f:d.ts'] },
    'a DIRTY position 4 is what the question is asked about',
  );
  st.setEdit('f:c.ts', 'typed\n');
  assert.deepEqual(
    st.evictionFor(v.id, 0, 'f:e.ts')?.lostIds,
    ['f:d.ts'],
    'the chips that STAY are not lost, however dirty',
  );
  // PURE: reading the plan changes neither the strip nor the text.
  assert.deepEqual(strip(v, 0), ['f:a.ts', 'f:b.ts', 'f:c.ts', 'f:d.ts']);
  assert.equal(st.state.edits.get('f:d.ts'), 'typed\n');

  assert.equal(st.evictionFor(v.id, 0, 'f:b.ts'), null, 'a RAISE evicts nothing');
  assert.equal(st.evictionFor(v.id, 1, 'f:e.ts'), null, 'a terminal pane holds no strip');
  assert.equal(st.evictionFor(v.id, 9, 'f:e.ts'), null, 'nor does pane 9 exist');
  assert.equal(st.evictionFor('nope', 0, 'f:e.ts'), null, 'nor that view');

  const room = addView({ kind: 'project', id: 'p2' }, [ed('a.ts', 'b.ts', 'c.ts')]);
  assert.equal(st.evictionFor(room.id, 0, 'f:e.ts'), null, 'and a strip with room evicts nothing');
});

test('evictionFor: a dirty position 4 that ANOTHER tab shows is not lost', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts', 'b.ts', 'c.ts', 'd.ts'), ed('d.ts')]);
  st.setEdit('f:d.ts', 'typed\n');
  assert.deepEqual(
    st.evictionFor(v.id, 0, 'f:e.ts'),
    { tabIndex: 3, lostIds: [] },
    'the second pane keeps that text alive, so the open asks nothing',
  );
});

test('evictionForOpen: the same plan for the opener that picks its own pane', () => {
  st.initServer([], [mkSession('s1')]);
  st.loadUi(REOPEN);
  assert.equal(
    st.evictionForOpen({ kind: 'project', id: 'p1' }, ftab('e.ts')),
    null,
    'a tab that does not exist yet has no strip to overflow',
  );
  const v = addView({ kind: 'project', id: 'p1' }, [sess('s1'), ed('a.ts', 'b.ts', 'c.ts', 'd.ts')]);
  st.state.activeViewId = v.id;

  // A focused TERMINAL still sends the tab to the view's first editor pane.
  v.focused = 0;
  st.setEdit('f:d.ts', 'typed\n');
  assert.deepEqual(st.evictionForOpen({ kind: 'project', id: 'p1' }, ftab('e.ts')), {
    tabIndex: 3,
    lostIds: ['f:d.ts'],
  });
  assert.equal(
    st.evictionForOpen({ kind: 'project', id: 'p1' }, ftab('b.ts')),
    null,
    'a file already open in that view is RAISED, so nothing leaves',
  );
  // PURE: it may not create the tab it was asked about, the way viewForRoot does.
  assert.equal(st.state.views.some((x: ViewState) => x.root?.kind === 'project' && x.root.id === 'p9'), false);
  assert.equal(st.evictionForOpen({ kind: 'project', id: 'p9' }, ftab('e.ts')), null);
  assert.equal(st.state.views.some((x: ViewState) => x.root?.kind === 'project' && x.root.id === 'p9'), false);
});

// ---------------------------------------------------------------------------
// Moving a tab: to another pane, and out into a split of its own
// ---------------------------------------------------------------------------

test('moveTab: the tab lands in the target strip and leaves the source', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts', 'b.ts'), ed('c.ts')]);
  st.state.activeViewId = v.id;

  assert.equal(st.moveTab(v.id, 0, 1, 1), 'ok');
  assert.deepEqual(shape(v), [['f:a.ts'], ['f:c.ts', 'f:b.ts']]);
  assert.equal(activeId(v, 1), 'f:b.ts', 'the tab the user dragged is the one showing');
  assert.equal(v.focused, 1, 'and the keyboard is in the pane they dropped on');
  assert.equal(activeId(v, 0), 'f:a.ts', 'the source clamped onto a tab it still has');
});

test('moveTab: a target already holding that file RAISES it — it never shows it twice', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts', 'b.ts'), ed('b.ts', 'c.ts')]);
  (v.slots[1] as EditorSlot).active = 1;

  assert.equal(st.moveTab(v.id, 0, 1, 1), 'ok');
  assert.deepEqual(shape(v), [['f:a.ts'], ['f:b.ts', 'f:c.ts']], 'no duplicate in the target');
  assert.equal(activeId(v, 1), 'f:b.ts', 'the copy that was already there is raised');
});

test('moveTab: a raise in the target still empties the source of that tab, and clamps it', () => {
  // The raise branch is the one that can quietly do nothing: the target
  // already has the file, so a mover that stopped there would leave a second
  // copy behind in the SOURCE strip — and the source's `active`, which was on
  // the tab that left, has to come back onto a tab that exists.
  st.initServer([], []);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts', 'b.ts'), ed('b.ts', 'c.ts')]);
  const from = v.slots[0] as EditorSlot;
  from.active = 1; // the tab being dragged is the one on screen in the source

  assert.equal(st.moveTab(v.id, 0, 1, 1), 'ok');
  assert.deepEqual(shape(v), [['f:a.ts'], ['f:b.ts', 'f:c.ts']], 'gone from the source, not doubled');
  assert.equal(from.active, 0, 'the source clamped onto the tab it still has');
  assert.equal(activeId(v, 0), 'f:a.ts');
  assert.equal(activeId(v, 1), 'f:b.ts', 'and the target raised the copy it already had');
  assert.equal(v.focused, 1, 'the keyboard is in the pane the tab went to');
});

test('moveTab: a source emptied of tabs loses its PANE, and the target is found by key', () => {
  // The 2x2 remap moves slot indices under the mover — holding the target by
  // index instead of by key lands the tab in a stranger's pane.
  st.initServer([], []);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts'), ed('b.ts'), ed('c.ts'), ed('d.ts')]);
  st.state.activeViewId = v.id;
  const targetKey = st.slotKey(v.slots[3] as PaneSlot);

  assert.equal(st.moveTab(v.id, 0, 0, 3), 'ok');
  assert.equal(v.slots.length, 3, 'the emptied pane is gone');
  assert.deepEqual(shape(v), [['f:c.ts'], ['f:b.ts'], ['f:d.ts', 'f:a.ts']], 'the 2x2 remap');
  assert.equal(st.slotKey(v.slots[v.focused] as PaneSlot), targetKey, 'focus on the TARGET pane');
  assert.equal(activeId(v, v.focused), 'f:a.ts');
});

test('moveTab: a dirty file’s text survives the move — the prune runs once, at the END', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts'), ed('b.ts')]);
  const a = st.editorFileId('a.ts');
  st.setEdit(a, 'typed in a');

  assert.equal(st.moveTab(v.id, 0, 0, 1), 'ok');
  assert.deepEqual(shape(v), [['f:b.ts', 'f:a.ts']], 'one pane left, holding both');
  assert.equal(st.editText(a), 'typed in a', 'the tab moved, it did not close');
});

test('moveTab: a FULL target is REFUSED — a move never evicts (B4 amendment)', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts', 'b.ts'), ed('c.ts', 'd.ts', 'e.ts', 'f.ts')]);
  st.state.activeViewId = v.id;

  assert.equal(st.moveTab(v.id, 0, 1, 1), 'full', 'the sentence is the strip\'s, not the pane count\'s');
  assert.deepEqual(
    shape(v),
    [['f:a.ts', 'f:b.ts'], ['f:c.ts', 'f:d.ts', 'f:e.ts', 'f:f.ts']],
    'nothing moved, nothing was thrown out',
  );

  // A target that already SHOWS that tab is a raise, and a raise costs no room.
  const w = addView({ kind: 'project', id: 'p2' }, [ed('a.ts', 'b.ts'), ed('b.ts', 'd.ts', 'e.ts', 'f.ts')]);
  assert.equal(st.moveTab(w.id, 0, 1, 1), 'ok');
  assert.deepEqual(shape(w), [['f:a.ts'], ['f:b.ts', 'f:d.ts', 'f:e.ts', 'f:f.ts']]);
  assert.equal(activeId(w, 1), 'f:b.ts', 'raised where it already was');
});

test('moveTab: a bad slot, the same slot, or a terminal is refused and changes nothing', () => {
  st.initServer([], [mkSession('s1')]);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts'), sess('s1')]);
  const before = shape(v);
  assert.equal(st.moveTab('nope', 0, 0, 1), 'no-view');
  assert.equal(st.moveTab(v.id, 0, 0, 0), 'no-view', 'a tab does not move to its own pane');
  assert.equal(st.moveTab(v.id, 0, 0, 1), 'no-view', 'a terminal holds no tabs');
  assert.equal(st.moveTab(v.id, 1, 0, 0), 'no-view', 'and it has none to give');
  assert.equal(st.moveTab(v.id, 0, 9, 1), 'no-view', 'nor does tab 9 exist');
  assert.deepEqual(shape(v), before);
});

test('moveTabToSplit: a source that KEEPS tabs needs a free pane — a full tab is `full`', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [
    ed('a.ts', 'x.ts'),
    ed('b.ts'),
    ed('c.ts'),
    ed('d.ts'),
  ]);
  st.state.activeViewId = v.id;
  const before = shape(v);
  assert.equal(st.moveTabToSplit(v.id, 0, 0, 2, 'top'), 'full');
  assert.deepEqual(shape(v), before, 'a rejection changes nothing');
});

test('moveTabToSplit: a ONE-TAB source on a full tab is fine — its own pane pays for the split', () => {
  // The capacity rule the mutant gets wrong: the pane count does not change,
  // because the source pane leaves as the new one arrives.
  st.initServer([], []);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts'), ed('b.ts'), ed('c.ts'), ed('d.ts')]);
  st.state.activeViewId = v.id;

  assert.equal(st.moveTabToSplit(v.id, 0, 0, 2, 'top'), 'ok');
  assert.equal(v.slots.length, st.MAX_PANES, 'four panes before, four panes after');
  // Removing slot 0 of the 2x2 leaves [c, b, d] (l3 L, c tall); splitting c at
  // the top puts the new pane first.
  assert.deepEqual(shape(v), [['f:a.ts'], ['f:b.ts'], ['f:c.ts'], ['f:d.ts']]);
  assert.equal(v.focused, 0, 'focus is on the NEW pane, after the remap');
  assert.deepEqual(strip(v, v.focused), ['f:a.ts']);
});

test('moveTabToSplit: `no-zone` is measured on the view the drop will leave behind', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  // Three panes, tall pane on the left (l3 L): only slot 0 can still split.
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts', 'x.ts'), ed('b.ts'), ed('c.ts')]);
  st.state.activeViewId = v.id;
  const before = shape(v);
  assert.equal(st.moveTabToSplit(v.id, 0, 0, 1, 'top'), 'no-zone', 'the short pane offers nothing');
  assert.deepEqual(shape(v), before);
  assert.equal(st.moveTabToSplit(v.id, 0, 0, 0, 'top'), 'ok', 'its own pane’s edge is a split');
  // n=3, l3 L: the tall pane splitting at the top makes the new pane slot 0,
  // and the source (now x.ts alone) keeps the tall column's other half.
  assert.deepEqual(shape(v), [['f:a.ts'], ['f:b.ts'], ['f:x.ts'], ['f:c.ts']]);

  // A pane's ONLY tab dragged to that same pane's edge has nowhere to go.
  const w = addView({ kind: 'project', id: 'p2' }, [ed('z.ts')]);
  assert.equal(st.moveTabToSplit(w.id, 0, 0, 0, 'left'), 'no-zone');
  assert.deepEqual(shape(w), [['f:z.ts']]);
});

test('moveTabToSplit: an unknown view, pane or tab is refused', () => {
  st.initServer([], [mkSession('s1')]);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts', 'b.ts'), sess('s1')]);
  const before = shape(v);
  assert.equal(st.moveTabToSplit('nope', 0, 0, 1, 'top'), 'no-view');
  assert.equal(st.moveTabToSplit(v.id, 1, 0, 0, 'top'), 'no-view', 'a terminal has no tabs');
  assert.equal(st.moveTabToSplit(v.id, 0, 5, 1, 'top'), 'no-view');
  assert.equal(st.moveTabToSplit(v.id, 0, 0, 7, 'top'), 'no-view');
  assert.deepEqual(shape(v), before);
});

// ---------------------------------------------------------------------------
// Closing, raising and cycling tabs
// ---------------------------------------------------------------------------

test('closeTab: `active` clamps to the tab that is left, and the pane stays', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts', 'b.ts', 'c.ts')]);
  const s = v.slots[0] as EditorSlot;
  s.active = 2; // the LAST tab is the one on screen

  assert.equal(st.closeTab(v.id, 0, 2), true);
  assert.equal(v.slots.length, 1, 'the pane is still there');
  assert.deepEqual(strip(v, 0), ['f:a.ts', 'f:b.ts']);
  assert.equal(s.active, 1, 'active stepped back onto the new last tab');
  assert.equal(activeId(v, 0), 'f:b.ts');

  // Closing a tab BEFORE the active one clamps the same way (min(active, len-1)).
  s.active = 1;
  assert.equal(st.closeTab(v.id, 0, 0), true);
  assert.deepEqual(strip(v, 0), ['f:b.ts']);
  assert.equal(s.active, 0);
});

test('closeTab: the LAST tab takes the pane with it, down the closeSlot ladder', () => {
  st.initServer([], [mkSession('s1')]);
  st.loadUi(REOPEN);

  // Home keeps standing, empty (user decision 4).
  assert.equal(st.openFile({ kind: 'home' }, 'a.ts', 'a.ts'), 'ok');
  assert.equal(st.closeTab(home().id, 0, 0), true);
  assert.deepEqual(home().slots, []);
  assert.equal(st.state.views[0]?.root?.kind, 'home');

  // A project tab with nothing else in it goes with its last tab (decision 3/6).
  const p = addView({ kind: 'project', id: 'p1' }, [ed('b.ts')]);
  assert.equal(st.closeTab(p.id, 0, 0), true);
  assert.equal(st.state.views.some((x) => x.id === p.id), false, 'the emptied project tab is gone');

  // …unless a terminal is still in it.
  const q = addView({ kind: 'project', id: 'p2' }, [ed('d.ts'), sess('s1')]);
  assert.equal(st.closeTab(q.id, 0, 0), true);
  assert.deepEqual(shape(q), ['s:s1']);
  assert.equal(st.state.views.some((x) => x.id === q.id), true);

  // A ROOTLESS tab dissolves, like it always has.
  const r = addView(null, [ed('e.ts')]);
  assert.equal(st.closeTab(r.id, 0, 0), true);
  assert.equal(st.state.views.some((x) => x.id === r.id), false);
});

test('closeTab / closeActiveTab: a terminal, a bad index and an unknown view are refused', () => {
  st.initServer([], [mkSession('s1')]);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [sess('s1'), ed('a.ts', 'b.ts')]);
  assert.equal(st.closeTab(v.id, 0, 0), false, 'a terminal pane has no tabs to close');
  assert.equal(st.closeTab(v.id, 1, 5), false);
  assert.equal(st.closeTab(v.id, 1, -1), false);
  assert.equal(st.closeTab('nope', 0, 0), false);
  assert.equal(st.closeActiveTab(v.id, 0), false, 'and ctrl+alt+w does nothing on a terminal');
  assert.deepEqual(shape(v), ['s:s1', ['f:a.ts', 'f:b.ts']]);

  (v.slots[1] as EditorSlot).active = 0;
  assert.equal(st.closeActiveTab(v.id, 1), true);
  assert.deepEqual(shape(v), ['s:s1', ['f:b.ts']], 'it closes the tab that is on screen');
});

test('setActiveTab: raises a tab by index, and is silent when it is already up', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts', 'b.ts')]);
  assert.equal(st.setActiveTab(v.id, 0, 1), true);
  assert.equal(activeId(v, 0), 'f:b.ts');
  assert.equal(st.setActiveTab(v.id, 0, 1), false, 'the same tab again is not a change');
  assert.equal(st.setActiveTab(v.id, 0, 4), false);
  assert.equal(st.setActiveTab(v.id, 0, -1), false);
  assert.equal(st.setActiveTab('nope', 0, 0), false);
  assert.equal(activeId(v, 0), 'f:b.ts');
});

test('cycleTab: ctrl+alt+PageUp/PageDown wraps both ways, and stands down on a terminal', () => {
  st.initServer([], [mkSession('s1')]);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts', 'b.ts', 'c.ts'), sess('s1')]);
  st.state.activeViewId = v.id;
  v.focused = 0;

  assert.equal(st.cycleTab(1), true);
  assert.equal(activeId(v, 0), 'f:b.ts');
  assert.equal(st.cycleTab(1), true);
  assert.equal(activeId(v, 0), 'f:c.ts');
  assert.equal(st.cycleTab(1), true);
  assert.equal(activeId(v, 0), 'f:a.ts', 'forward off the end wraps to the first');
  assert.equal(st.cycleTab(-1), true);
  assert.equal(activeId(v, 0), 'f:c.ts', 'and back off the front wraps to the last');

  v.focused = 1;
  assert.equal(st.cycleTab(1), false, 'the chord belongs to the strip, not to the grid');
  assert.equal(activeId(v, 0), 'f:c.ts');

  // A single-tab pane has nothing to cycle to.
  const w = addView({ kind: 'project', id: 'p2' }, [ed('z.ts')]);
  st.state.activeViewId = w.id;
  assert.equal(st.cycleTab(1), false);
});

test('cycleTab: a pane with ONE tab is a no-op — the chord answers false and nothing moves', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('only.ts')]);
  st.state.activeViewId = v.id;
  v.focused = 0;
  // `collectKinds` is declared further down; a function declaration is hoisted.
  const { kinds } = collectKinds();

  assert.equal(st.cycleTab(1), false);
  assert.equal(st.cycleTab(-1), false);
  assert.equal(activeId(v, 0), 'f:only.ts', 'the one tab is still the one on screen');
  assert.equal((v.slots[0] as EditorSlot).active, 0);
  assert.deepEqual(kinds, [], 'and nothing was redrawn for a chord that did nothing');
});

test('closeSlot: an emptied PROJECT tab goes, Home stays, and focus lands on a pane that exists', () => {
  st.initServer([], [mkSession('s1')]);
  st.loadUi(REOPEN);

  // Home: its last file leaves, Home stays (user decision 4).
  assert.equal(st.openFile({ kind: 'home' }, 'a.ts', 'a.ts'), 'ok');
  assert.equal(st.closeSlot(home().id, 0), true);
  assert.deepEqual(home().slots, []);
  assert.equal(st.state.views[0]?.root?.kind, 'home', 'Home is still the first tab');

  // A project tab with only editor panes: the last one closes the tab (decision 6).
  const p = addView({ kind: 'project', id: 'p1' }, [ed('b.ts'), ed('c.ts', 'd.ts')]);
  p.focused = 1;
  assert.equal(st.closeSlot(p.id, 1), true, 'a pane closes WITH ALL ITS TABS');
  assert.deepEqual(shape(p), [['f:b.ts']]);
  assert.equal(p.focused, 0, 'focus clamps onto the pane that is left');
  assert.equal(st.closeSlot(p.id, 0), true);
  assert.equal(st.state.views.some((v) => v.id === p.id), false, 'the emptied project tab is gone');

  // …unless it still holds a terminal.
  const q = addView({ kind: 'project', id: 'p2' }, [ed('d.ts'), sess('s1')]);
  assert.equal(st.closeSlot(q.id, 0), true);
  assert.deepEqual(keys(q), ['s:s1']);
  assert.equal(st.state.views.some((v) => v.id === q.id), true, 'a terminal keeps the tab open');
});

test('closeSlot: a SESSION pane is refused — ending a session is a different act', () => {
  // There is no close-the-PANE control on a terminal pane (the header's End
  // session button, B8, ends the session instead), and the model says so too
  // rather than trusting every caller to remember.
  st.initServer([], [mkSession('s1')]);
  st.loadUi(REOPEN);
  const v = addView(null, [sess('s1'), ed('a.ts')]);
  assert.equal(st.closeSlot(v.id, 0), false);
  assert.deepEqual(shape(v), ['s:s1', ['f:a.ts']]);
  assert.equal(st.closeSlot(v.id, 9), false, 'and an index that is not a pane is a no-op');
  assert.equal(st.closeSlot('nope', 0), false);
});

test('closeSlot: a ROOTLESS tab emptied of files dissolves, like it always has', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  const v = addView(null, [ed('a.ts')]);
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
  st.loadUi(REOPEN);
  assert.equal(st.openFile({ kind: 'home' }, 'a.ts', 'a.ts'), 'ok');
  const id = st.editorFileId('a.ts');
  st.setEdit(id, 'typed');
  assert.equal(st.editorDirty(id), true, 'precondition: the file is dirty');

  assert.equal(st.closeSlot(home().id, 0), true);
  assert.equal(st.editorDirty(id), false, 'no dot anywhere, so no text anywhere');
  assert.equal(st.state.edits.size, 0, 'and the map does not grow forever');
});

test('the same file in TWO panes keeps its text until BOTH are gone', () => {
  // Free mixing (decision 3): one text per FILE, shared by every TAB showing
  // it — so the first close is not the last word.
  st.initServer([], []);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts'), ed('a.ts')]);
  const id = st.editorFileId('a.ts');
  st.setEdit(id, 'typed');

  assert.equal(st.closeSlot(v.id, 1), true);
  assert.equal(st.editorDirty(id), true, 'one pane still shows it');
  assert.equal(st.editText(id), 'typed', 'and it still holds exactly what was typed');

  assert.equal(st.closeSlot(v.id, 0), true);
  assert.equal(st.editorDirty(id), false);
  assert.equal(st.state.edits.size, 0);
});

test('openTabAt on the CENTRE of a dirty pane keeps BOTH texts — it replaces nothing', () => {
  // A10b turned the centre into an ADD (orchestrator default 4). The A10 test
  // this replaces asserted the opposite, and the difference is the user's
  // unsaved typing: nothing here orphans a file, so nothing is pruned.
  st.initServer([], []);
  st.loadUi(REOPEN);
  assert.equal(st.openFile({ kind: 'home' }, 'a.ts', 'a.ts'), 'ok');
  const v = home();
  const a = st.editorFileId('a.ts');
  const b = st.editorFileId('b.ts');
  st.setEdit(a, 'typed in a');
  st.setEdit(b, 'typed in b');

  assert.equal(st.openTabAt(v.id, 0, 'replace', ftab('b.ts')), 'ok');
  assert.deepEqual(shape(v), [['f:a.ts', 'f:b.ts']]);
  assert.equal(st.editText(a), 'typed in a', 'the file that was there is still open');
  assert.equal(st.editText(b), 'typed in b', 'and so is the one that joined it');

  // Closing the tab is what drops the text — the LAST tab showing that file.
  assert.equal(st.closeTab(v.id, 0, 0), true);
  assert.equal(st.editorDirty(a), false, 'no tab anywhere, so no text anywhere');
  assert.equal(st.editText(b), 'typed in b');
});

test('pruneOrphanEdits walks TABS: text dies with the last tab, not with the pane', () => {
  // The A10 version of this rule walked SLOTS. A pane with two files in it
  // would have pruned neither or both.
  st.initServer([], []);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts', 'b.ts'), ed('b.ts')]);
  const a = st.editorFileId('a.ts');
  const b = st.editorFileId('b.ts');
  st.setEdit(a, 'typed in a');
  st.setEdit(b, 'typed in b');

  assert.equal(st.closeTab(v.id, 0, 0), true, 'a.ts leaves the first strip');
  assert.equal(st.editorDirty(a), false, 'it was on no other tab');
  assert.equal(st.editText(b), 'typed in b', 'b.ts is still open twice');

  assert.equal(st.closeSlot(v.id, 1), true, 'the second pane goes, tabs and all');
  assert.equal(st.editText(b), 'typed in b', 'the first strip still shows it');
  assert.equal(st.closeSlot(v.id, 0), true);
  assert.equal(st.editorDirty(b), false);
  assert.equal(st.state.edits.size, 0, 'and the map does not grow forever');
});

test('closing a TAB drops the unsaved text of every file it held', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts', 'b.ts')]);
  const a = st.editorFileId('a.ts');
  const b = st.editorFileId('b.ts');
  st.setEdit(a, 'typed a');
  st.setEdit(b, 'typed b');

  // …but a file that is ALSO open in another tab is not the closing tab's to drop.
  assert.equal(st.openFile({ kind: 'home' }, 'b.ts', 'b.ts'), 'ok');
  st.closeView(v.id);
  assert.equal(st.state.views.some((x) => x.id === v.id), false, 'the tab is gone');
  assert.equal(st.editorDirty(a), false, 'its only tab went with the tab strip');
  assert.equal(st.editText(b), 'typed b', 'the other tab still shows b.ts');
});

test('merging a tab into another keeps the unsaved text of the file in transit', () => {
  // `mergeViews` empties the source and dissolves it BEFORE the slots land in
  // the target: for that instant the file is on no pane at all. A prune run
  // from `dissolveView` would eat text the user is still looking at — which is
  // why the prune lives in closeSlot/closeView/the tab movers and nowhere else.
  st.initServer([], []);
  st.loadUi(REOPEN);
  const src = addView({ kind: 'project', id: 'p1' }, [ed('a.ts')]);
  const dst = addView({ kind: 'project', id: 'p2' }, [ed('b.ts')]);
  const a = st.editorFileId('a.ts');
  const b = st.editorFileId('b.ts');
  st.setEdit(a, 'typed in a');
  st.setEdit(b, 'typed in b');

  assert.equal(st.mergeViews(dst.id, src.id, 0, 'right'), 'ok');
  assert.equal(st.state.views.some((x) => x.id === src.id), false, 'the source tab dissolved');
  assert.deepEqual(shape(dst), [['f:b.ts'], ['f:a.ts']], 'both panes are the target’s now');
  assert.equal(st.editorDirty(a), true, 'the file moved, it did not close');
  assert.equal(st.editText(a), 'typed in a', 'and it still holds exactly what was typed');
  assert.equal(st.editText(b), 'typed in b', 'the file it merged into is untouched');
});

test('movePane: a file and a terminal trade places, and focus follows the moved pane', () => {
  st.initServer([], [mkSession('s1')]);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts', 'b.ts'), sess('s1')]);
  st.state.activeViewId = v.id;
  v.focused = 0;
  const editorKey = st.slotKey(v.slots[0] as PaneSlot);

  st.movePane('right');
  assert.deepEqual(shape(v), ['s:s1', ['f:a.ts', 'f:b.ts']], 'kind-blind, tabs and all');
  assert.equal(v.focused, 1, 'focus follows the pane that moved, not the slot it left');
  assert.equal(st.slotKey(v.slots[1] as PaneSlot), editorKey, 'and it is the SAME pane');

  st.movePane('left');
  assert.deepEqual(shape(v), [['f:a.ts', 'f:b.ts'], 's:s1']);
  assert.equal(v.focused, 0);

  // No neighbour in that direction: nothing moves.
  st.movePane('up');
  assert.deepEqual(shape(v), [['f:a.ts', 'f:b.ts'], 's:s1']);

  // swapPanes is the same door, called by index.
  st.swapPanes(v.id, 0, 1);
  assert.deepEqual(shape(v), ['s:s1', ['f:a.ts', 'f:b.ts']]);
  assert.equal(st.slotKey(v.slots[1] as PaneSlot), editorKey);
});

test('reconcileViews: the server forgot a session — its pane goes, the files beside it stay', () => {
  st.initServer([], [mkSession('s1')]);
  st.loadUi(REOPEN);
  const v = addView({ kind: 'project', id: 'p1' }, [ed('a.ts'), sess('gone'), ed('b.ts')]);
  const rootless = addView(null, [sess('gone2')]);

  st.reconcileViews();

  assert.deepEqual(shape(v), [['f:a.ts'], ['f:b.ts']], 'a path is not a session id');
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
  st.loadUi(REOPEN);
  const a = addView(null, [ed('a.ts')], 'v-a');
  const b = addView(null, [ed('b.ts')], 'v-b');
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
  st.loadUi(REOPEN);
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
  st.loadUi(REOPEN);
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
  st.loadUi(REOPEN);
  const p = addView({ kind: 'project', id: 'p1' }, [ed('a.ts')]);
  const src = st.viewOfSession('s1') as ViewState;

  assert.equal(st.moveSessionToView('s1', p.id), 'ok');
  assert.deepEqual(shape(p), [['f:a.ts'], 's:s1'], 'free mixing: files beside a terminal');
  assert.equal(st.state.views.some((v) => v.id === src.id), false, 'the emptied session tab dissolved');
});

// ---------------------------------------------------------------------------
// Persistence: what a reload keeps, and what it must not
// ---------------------------------------------------------------------------

test('save/load: every slot survives a reload — terminals, editor panes, their tabs and the focus', () => {
  // PART B4, user decision D2 (2026-09-22): open file and diff tabs join the
  // localStorage bag beside the session slots. Until B4 an editor slot was
  // dropped on purpose — its text had never been on disk, so restoring it
  // would have restored placeholder content. Now the tab is a path the app can
  // read again, so it comes back; the unsaved TEXT still does not.
  st.initServer([], [mkSession('s1'), mkSession('s2')]);
  st.loadUi(REOPEN);
  const v = st.viewOfSession('s1') as ViewState;
  v.slots = [sess('s1'), ed(A, B), sess('s2')];
  v.focused = 1; // an EDITOR pane is focused
  v.l3 = 'R';
  v.split = { col: 0.3, row: 0.7 };
  st.state.views = st.state.views.filter((x) => x.id === home().id || x.id === v.id);
  st.setActiveView(v.id);
  st.setEdit(E.fileTabId(A), 'typed, never saved\n');
  st.saveUi();

  // What a reload really does: forget the module state, read the bag back.
  st.state.views = [];
  st.state.activeViewId = '';
  st.state.edits = new Map();
  st.loadUi(REOPEN);

  assert.equal(st.state.views[0]?.root?.kind, 'home', 'Home is recreated at index 0');
  const back = st.state.views.find((x) => x.id === v.id) as ViewState;
  assert.deepEqual(
    shape(back),
    ['s:s1', [E.fileTabId(A), E.fileTabId(B)], 's:s2'],
    'the editor pane came back, in its place, with both of its tabs',
  );
  assert.deepEqual(back.split, { col: 0.3, row: 0.7 }, 'the dragged divider is still where it was');
  assert.equal(back.l3, 'R');
  assert.equal(back.focused, 1, 'and the focus is still on the editor pane (no remapping since B4)');
  assert.equal(st.state.activeViewId, v.id);
  assert.equal(st.state.edits.size, 0, 'the unsaved text did NOT come back: it was never on disk');

  // The pane's identity is NOT the stored one: `e:<n>` belongs to a page, and
  // ui/panes.ts keys its live panes by it.
  const slot = back.slots[1] as EditorSlot;
  assert.match(st.slotKey(slot), /^e:\d+$/);
  assert.equal(slot.active, 0, 'the strip opens on the tab that was active');
});

test('save/load: a diff tab comes back too, with the folder it is read from', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  home().slots = [edTabs(dtab(HASH40, 'server/ws.ts'), ftab(A))];
  (home().slots[0] as EditorSlot).active = 1;
  st.saveUi();

  st.state.views = [];
  st.loadUi(REOPEN);
  const slot = home().slots[0] as EditorSlot;
  assert.deepEqual(slot.tabs, [
    { kind: 'diff', hash: HASH40, path: 'server/ws.ts', root: REPO },
    { kind: 'file', path: A },
  ]);
  assert.equal(slot.active, 1, 'and it opens on the tab that was up');
});

test('save/load: a tab that holds ONLY files comes back now, and Home always does', () => {
  st.initServer([], [mkSession('s1')]);
  st.loadUi(REOPEN);
  // s1 arrived in its own auto-tab; this test wants it in the folder tab, and
  // a session lives in exactly ONE view.
  st.state.views = [home()];
  const withTerm = addView({ kind: 'project', id: 'p1' }, [ed(A), sess('s1')], 'v-term');
  addView({ kind: 'project', id: 'p2' }, [ed(B)], 'v-files');
  home().slots = [ed(C)];
  const homeId = home().id;
  st.saveUi();

  st.state.views = [];
  st.state.activeViewId = '';
  st.loadUi(REOPEN);

  const back = st.state.views.find((x) => x.id === withTerm.id) as ViewState;
  assert.deepEqual(back?.root, { kind: 'project', id: 'p1' }, 'the folder tab kept its root');
  assert.deepEqual(shape(back), [[E.fileTabId(A)], 's:s1'], 'its files AND its terminal');
  const files = st.state.views.find((x) => x.id === 'v-files') as ViewState;
  assert.deepEqual(
    shape(files),
    [[E.fileTabId(B)]],
    'a tab of files only is a tab with slots — it survives (D2)',
  );
  assert.equal(home().id, homeId, 'Home keeps its identity across the reload');
  assert.deepEqual(shape(home()), [[E.fileTabId(C)]], 'and its own file came back with it');
});

test('save/load: a view with NO slots at all is still dropped unless it is Home', () => {
  // The rule D2 did not change: zero slots is nothing to come back as.
  st.initServer([], []);
  memoryStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      views: [
        { id: 'h', root: { kind: 'home' }, slots: [], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
        { id: 'empty', root: { kind: 'project', id: 'p1' }, slots: [], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
      ],
      active: 'empty',
    }),
  );
  st.loadUi(REOPEN);
  assert.deepEqual(st.state.views.map((v) => v.id), ['h']);
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
  st.loadUi(REOPEN);
  assert.deepEqual(st.state.views.map((v) => v.id), ['h1'], 'the second one was rootless and empty -> dropped');
  assert.equal(home().id, 'h1');
});

test('save/load: a hostile bag is GATED, tab by tab — and what is left is dropped with its slot', () => {
  // STORAGE IS NOT THE MODEL. Every value below is one a hand-edit, a
  // corrupted blob or another build could put there, and each is refused for
  // its own reason rather than repaired: a tab nobody can open is worse than a
  // tab that is not there.
  st.initServer([], [mkSession('s1')]);
  memoryStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      views: [
        {
          id: 'v1',
          root: { kind: 'project', id: 'p1' },
          slots: [
            {
              kind: 'editor',
              id: 'e:99', // the stored pane id is ignored: a reload builds new panes
              tabs: [
                { kind: 'file', path: 'relative.ts' }, // not absolute
                { kind: 'file', path: '' }, // not a path
                { kind: 'file', path: '/ok/kept.ts' }, // the one good file
                { kind: 'file', path: '/nul\u0000name.ts' }, // a NUL byte
                { kind: 'file' }, // no path at all
                { kind: 'file', path: '/ok/kept.ts' }, // the same file twice
                { kind: 'diff', hash: 'abc1234', path: 'a.ts', root: '/repo' }, // 7 hex
                { kind: 'diff', hash: HASH40.toUpperCase(), path: 'a.ts', root: '/repo' }, // upper case
                { kind: 'diff', hash: HASH40, path: 'a.ts' }, // no root to read from
                { kind: 'diff', hash: HASH40, path: '', root: '/repo' },
                { kind: 'diff', hash: HASH40, path: 'a.ts', root: '/repo' }, // the one good diff
                { kind: 'terminal', path: '/ok/x.ts' }, // an unknown kind
                null,
                'a string',
              ],
              active: 99, // past the end
            },
            // A slot whose every tab failed a gate: no pane is conjured for it.
            { kind: 'editor', tabs: [{ kind: 'file', path: 'nope.ts' }], active: 0 },
            { kind: 'editor', tabs: [], active: 0 },
            { kind: 'file', path: '/legacy.ts' }, // the A10-era slot kind
            sess('s1'),
          ],
          focused: 0,
          l3: 'L',
          split: { col: 0.5, row: 0.5 },
        },
      ],
      active: 'v1',
    }),
  );
  st.loadUi(REOPEN);
  const v = st.state.views.find((x) => x.id === 'v1') as ViewState;
  assert.deepEqual(
    shape(v),
    [[E.fileTabId('/ok/kept.ts'), E.diffTabId(HASH40, 'a.ts')], 's:s1'],
    'one editor pane with the two tabs that passed, and the terminal',
  );
  assert.equal((v.slots[0] as EditorSlot).active, 1, 'an active index past the end is clamped');
  assert.match(st.slotKey(v.slots[0] as PaneSlot), /^e:\d+$/, 'and it is a FRESH pane id');
});

test('save/load: a diff tab whose root is not absolute is dropped', () => {
  // The root is the folder the diff is READ IN. A relative one would be
  // resolved against whatever folder the backend happens to stand in — which
  // is the same reason a file tab's path has to be absolute.
  st.initServer([], []);
  memoryStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      views: [
        {
          id: 'h',
          root: { kind: 'home' },
          slots: [
            {
              kind: 'editor',
              tabs: [
                { kind: 'diff', hash: HASH40, path: 'a.ts', root: 'repo' },
                { kind: 'diff', hash: HASH40, path: 'b.ts', root: '../up/repo' },
                { kind: 'diff', hash: HASH40, path: 'c.ts', root: REPO }, // the one good one
              ],
              active: 0,
            },
          ],
          focused: 0,
          l3: 'L',
          split: { col: 0.5, row: 0.5 },
        },
      ],
      active: 'h',
    }),
  );
  st.loadUi(REOPEN);
  assert.deepEqual(
    st.slotTabIds(home().slots[0] as PaneSlot),
    [E.diffTabId(HASH40, 'c.ts')],
    'only the diff whose root is absolute survived',
  );
});

test('save/load: a hash that merely CONTAINS 40 hex is not a hash', () => {
  // ANCHORED, both ends (D2): the id of a commit is exactly 40 lower-case hex
  // and nothing around them. A gate that only looked for 40 hex SOMEWHERE
  // would let a hand-edited blob carry `<40 hex>\n rm -rf` — or a 41-hex
  // string that is no commit at all — straight into the `hash` of every diff
  // request this tab makes, and into the chip that names it.
  st.initServer([], []);
  memoryStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      views: [
        {
          id: 'h',
          root: { kind: 'home' },
          slots: [
            {
              kind: 'editor',
              tabs: [
                { kind: 'diff', hash: `${HASH40}0`, path: 'a.ts', root: REPO }, // 41 hex
                { kind: 'diff', hash: `${HASH40} x`, path: 'b.ts', root: REPO }, // trailing junk
                { kind: 'diff', hash: `x ${HASH40}`, path: 'c.ts', root: REPO }, // leading junk
                { kind: 'diff', hash: `${HASH40}\n`, path: 'd.ts', root: REPO }, // a newline after it
                { kind: 'diff', hash: HASH40, path: 'e.ts', root: REPO }, // the one good one
              ],
              active: 0,
            },
          ],
          focused: 0,
          l3: 'L',
          split: { col: 0.5, row: 0.5 },
        },
      ],
      active: 'h',
    }),
  );
  st.loadUi(REOPEN);
  assert.deepEqual(
    st.slotTabIds(home().slots[0] as PaneSlot),
    [E.diffTabId(HASH40, 'e.ts')],
    'only the tab whose hash IS the 40 hex survived',
  );
});

test('save/load: a path over 4096 chars is dropped', () => {
  // A blob is hand-editable, and a path no filesystem could hold is not a
  // path: it would be carried into every chip label and every request the tab
  // makes.
  st.initServer([], []);
  const long = `/${'a'.repeat(4096)}`; // 4097 chars
  const ok = `/${'b'.repeat(4094)}`; // 4095 — a path a filesystem really could hold
  memoryStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      views: [
        {
          id: 'h',
          root: { kind: 'home' },
          slots: [
            {
              kind: 'editor',
              tabs: [
                { kind: 'file', path: long },
                { kind: 'diff', hash: HASH40, path: 'a.ts', root: long },
                { kind: 'file', path: ok },
              ],
              active: 0,
            },
          ],
          focused: 0,
          l3: 'L',
          split: { col: 0.5, row: 0.5 },
        },
      ],
      active: 'h',
    }),
  );
  st.loadUi(REOPEN);
  assert.deepEqual(
    st.slotTabIds(home().slots[0] as PaneSlot),
    [E.fileTabId(ok)],
    'the over-long path and the over-long diff root are both gone',
  );
});

test('save/load: a strip in the bag is capped, and so is the number of panes', () => {
  st.initServer([], []);
  const many = Array.from({ length: 40 }, (_, i) => ({ kind: 'file', path: `/f/${i}.ts` }));
  const panes = Array.from({ length: 6 }, () => ({
    kind: 'editor',
    tabs: [{ kind: 'file', path: '/one.ts' }],
    active: 0,
  }));
  memoryStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      views: [
        { id: 'h', root: { kind: 'home' }, slots: [{ kind: 'editor', tabs: many, active: 39 }], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
        { id: 'v2', root: { kind: 'project', id: 'p1' }, slots: panes, focused: 5, l3: 'L', split: { col: 0.5, row: 0.5 } },
      ],
      active: 'h',
    }),
  );
  st.loadUi(REOPEN);
  const strip0 = st.slotTabIds(home().slots[0] as PaneSlot);
  assert.equal(
    strip0.length,
    st.MAX_TABS,
    'a strip of forty chips is not a strip anybody arranged — and four is the live cap too',
  );
  assert.deepEqual(strip0[0], E.fileTabId('/f/0.ts'), 'the first ones are kept, in order');
  assert.equal(
    (home().slots[0] as EditorSlot).active,
    st.MAX_TABS - 1,
    'and the active index lands inside',
  );
  const v2 = st.state.views.find((x) => x.id === 'v2') as ViewState;
  assert.equal(v2.slots.length, st.MAX_PANES, 'a tab holds at most four panes, whatever the bag says');
  assert.equal(v2.focused, st.MAX_PANES - 1, 'and the focus lands on one that exists');
});

test('save/load: the bag holds paths, and nothing a path is not — no text, ever', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  home().slots = [ed(A)];
  st.setEdit(E.fileTabId(A), 'secret typing that is not on disk\n');
  st.saveUi();
  const bag = memoryStorage.getItem(STORAGE_KEY) as string;
  assert.ok(bag.includes(A), 'the open tab is remembered (D2)');
  assert.equal(bag.includes('secret typing'), false, 'the unsaved text is NOT');
  assert.equal(bag.includes('e:'), false, "and not the pane's page-local id either");
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

test("every tab and pane mutator notifies 'ui' — an editor pane is a PANE", () => {
  // Not 'screen': that kind means "something OTHER than the panes fills the
  // pane area" (the commit view), and `ui/panes.ts` ignores it on purpose. A
  // file pane that announced itself with 'screen' would never be drawn.
  st.initServer([], []);
  st.loadUi(REOPEN);
  const { kinds } = collectKinds();
  const only = (fn: () => void): string[] => {
    kinds.length = 0;
    fn();
    return [...new Set(kinds)];
  };

  const h = () => home().id;
  assert.deepEqual(only(() => st.openFile({ kind: 'home' }, 'a.ts', 'a.ts')), ['ui']);
  assert.deepEqual(only(() => st.openFile({ kind: 'home' }, 'b.ts', 'b.ts')), ['ui'], 'a tab add');
  assert.deepEqual(only(() => st.openDiff({ kind: 'home' }, '474d891', 'a.ts', REPO)), ['ui']);
  assert.deepEqual(only(() => st.setActiveTab(h(), 0, 0)), ['ui']);
  assert.deepEqual(only(() => st.cycleTab(1)), ['ui']);
  assert.deepEqual(only(() => st.openTabAt(h(), 0, 'left', ftab('c.ts'))), ['ui']);
  assert.deepEqual(only(() => st.moveTab(h(), 1, 0, 0)), ['ui']);
  assert.deepEqual(only(() => st.moveTabToSplit(h(), 0, 0, 0, 'top')), ['ui']);
  assert.deepEqual(only(() => st.movePane('right')), ['ui']);
  assert.deepEqual(only(() => st.closeTab(h(), 0, 0)), ['ui']);
  assert.deepEqual(only(() => st.closeSlot(h(), 0)), ['ui']);
  assert.deepEqual(only(() => st.openFile({ kind: 'project', id: 'p1' }, 'c.ts', 'c.ts')), ['ui']);
  // A rejection is silent: nothing changed, so nothing re-renders.
  assert.deepEqual(only(() => st.openTabAt('nope', 0, 'left', ftab('d.ts'))), []);
  assert.deepEqual(only(() => st.moveTab('nope', 0, 0, 1)), []);
  assert.deepEqual(only(() => st.moveTabToSplit('nope', 0, 0, 1, 'left')), []);
  assert.deepEqual(only(() => st.closeTab('nope', 0, 0)), []);
  assert.deepEqual(only(() => st.closeSlot('nope', 0)), []);
  assert.deepEqual(only(() => st.cycleTab(1)), [], 'and so is a chord with no editor pane up');
});

test("saveEdit notifies 'ui' (the dot it clears lives on a pane header) and a clean file is silent", () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
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
  st.loadUi(REOPEN);
  assert.equal(st.state.leftPanel, 'files', 'the panel is wanted by default');
  assert.equal(st.state.filesWidth, st.FILES_W_DEFAULT);

  st.setFilesWidth(460);
  st.toggleLeftPanel('files'); // closes it

  // What a reload really does: forget the module state, read the bag back.
  st.state.filesWidth = st.FILES_W_DEFAULT;
  st.state.leftPanel = 'files';
  st.loadUi(REOPEN);

  assert.equal(st.state.filesWidth, 460, 'the dragged width is still the dragged width');
  assert.equal(st.state.leftPanel, null, 'and the panel the user closed stays closed');

  // Same key as the splits, no version bump.
  const bag = JSON.parse(memoryStorage.getItem(STORAGE_KEY) as string) as Record<string, unknown>;
  assert.deepEqual([bag.filesWidth, bag.leftPanel], [460, null]);
});

test('saveUi: a live drag (commit false) writes nothing; the commit at the end does', () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
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
    st.loadUi(REOPEN);
    assert.equal(st.state.filesWidth, st.FILES_W_DEFAULT, `filesWidth: ${JSON.stringify(bad)}`);
    assert.equal(st.state.leftPanel, 'files', 'an unknown panel name is not a panel');
  }

  // Out of range is not garbage — it is clamped, like a split fraction.
  memoryStorage.setItem(STORAGE_KEY, JSON.stringify({ views: [], active: null, filesWidth: 9000 }));
  st.loadUi(REOPEN);
  assert.equal(st.state.filesWidth, st.FILES_W_MAX);
  memoryStorage.setItem(STORAGE_KEY, JSON.stringify({ views: [], active: null, filesWidth: 12 }));
  st.loadUi(REOPEN);
  assert.equal(st.state.filesWidth, st.FILES_W_MIN);
});

test('loadUi: a pre-A5 v2 blob (neither key) opens the panel at the default width', () => {
  st.initServer([], []);
  memoryStorage.setItem(STORAGE_KEY, JSON.stringify({ views: [], active: null }));
  st.state.leftPanel = null;
  st.state.filesWidth = 512;
  st.loadUi(REOPEN);
  assert.equal(st.state.leftPanel, 'files');
  assert.equal(st.state.filesWidth, st.FILES_W_DEFAULT);
});

// ---------------------------------------------------------------------------
// B6 D3 — `Reopen tabs on start` and the run stamp
//
// A session never survives a backend run (it dies with the process), so what
// this switch decides is what is left in the BAG: the editor tabs, the folder
// tabs, the empty views, their names, their order and which one was active.
// Off applies to a NEW app start only — a reload inside the same run (F5, the
// reload after `Restart service` or an update) keeps the arrangement, which is
// why the bag carries the run that wrote it.
// ---------------------------------------------------------------------------

const RUN_A = '2026-09-22T09:00:00.000Z';
const RUN_B = '2026-09-22T11:30:00.000Z';

/** A bag holding one folder tab with one file open, as saveUi would write it. */
function bagWithTabs(run: string | null): void {
  memoryStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      views: [
        {
          id: 'v-files',
          root: { kind: 'folder', path: '/home/you/demo-api' },
          slots: [{ kind: 'editor', tabs: [{ kind: 'file', path: '/home/you/demo-api/README.md' }], active: 0 }],
          focused: 0,
          l3: 'L',
          split: { col: 0.5, row: 0.5 },
        },
      ],
      active: 'v-files',
      leftPanel: null,
      filesWidth: 460,
      run,
    }),
  );
}

/** The tabs that came back, Home included. */
const viewIds = (): string[] => st.state.views.map((v: ViewState) => v.id);

test('saveUi: the bag carries the run that wrote it, and a run that is not a string reads as none', () => {
  st.initServer([], []);
  st.state.serverStartedAt = RUN_A;
  st.loadUi({ reopen: true, run: RUN_A });
  const bag = (): Record<string, unknown> =>
    JSON.parse(memoryStorage.getItem(STORAGE_KEY) as string) as Record<string, unknown>;
  assert.equal(bag().run, RUN_A, 'the stamp rides in the same v2 bag, no version bump');

  // Before GET /api/runtime has answered there is no run of this boot's own to
  // stamp with — so the save keeps the stamp the bag already carried. Writing
  // null there would turn the next boot's "same run" into "another run" and
  // cost the user their tabs for a read that merely had not landed yet.
  st.state.serverStartedAt = null;
  st.loadUi({ reopen: true, run: null });
  assert.equal(bag().run, RUN_A);
});

test('D3: reopen ON restores the tabs whatever the run was — today\'s behaviour, unchanged', () => {
  st.initServer([], []);
  bagWithTabs(RUN_A);
  st.loadUi({ reopen: true, run: RUN_B });
  assert.deepEqual(viewIds(), [home().id, 'v-files']);
  assert.deepEqual(strip(st.state.views[1] as ViewState, 0), ['f:/home/you/demo-api/README.md']);
  assert.equal(st.state.activeViewId, 'v-files', 'and the tab they left is the tab they come back to');
});

test('D3: reopen OFF keeps the tabs on a RELOAD — the same run wrote them', () => {
  st.initServer([], []);
  bagWithTabs(RUN_A);
  st.loadUi({ reopen: false, run: RUN_A });
  assert.deepEqual(viewIds(), [home().id, 'v-files']);
  assert.equal(st.state.activeViewId, 'v-files');
});

test('D3: reopen OFF drops the tabs on a NEW run — the window starts on Home', () => {
  st.initServer([], []);
  bagWithTabs(RUN_A);
  st.loadUi({ reopen: false, run: RUN_B });
  assert.deepEqual(viewIds(), [home().id], 'Home alone');
  assert.deepEqual(home().slots, [], 'and empty');
  assert.equal(st.state.activeViewId, home().id);
});

test('D3: the Files panel is a PANEL wish, not a tab — its width and closed state come back either way', () => {
  st.initServer([], []);
  bagWithTabs(RUN_A);
  st.loadUi({ reopen: false, run: RUN_B });
  assert.deepEqual(viewIds(), [home().id], 'the tabs went');
  assert.equal(st.state.leftPanel, null, 'the panel the user closed stays closed');
  assert.equal(st.state.filesWidth, 460, 'and the width they dragged is still theirs');
});

test('D3: a hostile or missing run reads as ANOTHER run, never as this one', () => {
  st.initServer([], []);
  for (const run of [undefined, null, 17, true, { at: RUN_A }, [RUN_A]]) {
    bagWithTabs(RUN_A);
    const raw = JSON.parse(memoryStorage.getItem(STORAGE_KEY) as string) as Record<string, unknown>;
    if (run === undefined) delete raw.run;
    else raw.run = run;
    memoryStorage.setItem(STORAGE_KEY, JSON.stringify(raw));
    st.loadUi({ reopen: false, run: RUN_A });
    assert.deepEqual(viewIds(), [home().id], `run ${JSON.stringify(run)} is not a run`);
  }
  // A pre-B6 bag (no stamp at all) read by a boot that does not know its run
  // either is the one case both sides agree on: nothing to tell apart.
  bagWithTabs(RUN_A);
  const raw = JSON.parse(memoryStorage.getItem(STORAGE_KEY) as string) as Record<string, unknown>;
  delete raw.run;
  memoryStorage.setItem(STORAGE_KEY, JSON.stringify(raw));
  st.loadUi({ reopen: false, run: null });
  assert.deepEqual(viewIds(), [home().id, 'v-files']);
});

test('D3: a session the server still has gets its tab back even with the stored tabs dropped', () => {
  // The gate drops an ARRANGEMENT, never a session: reconcileViews auto-tabs
  // everything the backend reports, so nothing running can be hidden by a
  // preference.
  st.initServer([], [mkSession('s1')]);
  bagWithTabs(RUN_A);
  st.loadUi({ reopen: false, run: RUN_B });
  assert.equal(st.state.views.length, 2, 'Home and the session that is running');
  assert.deepEqual(keys(st.state.views[1] as ViewState), ['s:s1']);
});

test('D3: a v1 blob follows the same rule — it carries no stamp, so it is another run\'s', () => {
  st.initServer([], [mkSession('s1')]);
  memoryStorage.setItem(
    STORAGE_KEY_V1,
    JSON.stringify({ tabs: [{ id: 't1', sessionId: 's1' }], activeTabId: 't1' }),
  );
  st.loadUi({ reopen: false, run: RUN_B });
  assert.equal(memoryStorage.getItem(STORAGE_KEY_V1), null, 'the v1 key is dropped either way');
  assert.deepEqual(viewIds()[0], home().id);
  assert.equal(st.state.views.length, 2, 'the session is auto-tabbed, not restored from the blob');
});

test('D3: the first save after a dropped bag re-stamps it with THIS run', () => {
  st.initServer([], []);
  bagWithTabs(RUN_A);
  st.state.serverStartedAt = RUN_B;
  st.loadUi({ reopen: false, run: RUN_B });
  const bag = JSON.parse(memoryStorage.getItem(STORAGE_KEY) as string) as Record<string, unknown>;
  assert.equal(bag.run, RUN_B);
  assert.deepEqual(
    (bag.views as { root: { kind: string }; slots: unknown[] }[]).map((v) => [v.root.kind, v.slots.length]),
    [['home', 0]],
    'and it holds nothing but the empty Home',
  );
  // Which makes the NEXT reload inside this run a keeper.
  st.loadUi({ reopen: false, run: RUN_B });
  assert.deepEqual(viewIds(), [home().id]);
});

test('D3: an UNKNOWN current run keeps the tabs, and the following save keeps the stamp', () => {
  st.initServer([], []);
  bagWithTabs(RUN_A);
  // GET /api/runtime has not answered, or failed. The window knows nothing
  // AGAINST this bag, and a failed read must never cost the user their tabs.
  st.loadUi({ reopen: false, run: null });
  assert.deepEqual(viewIds(), [home().id, 'v-files'], 'the arrangement stays');
  const bag = (): Record<string, unknown> =>
    JSON.parse(memoryStorage.getItem(STORAGE_KEY) as string) as Record<string, unknown>;
  assert.equal(bag().run, RUN_A, 'and loadUi’s own save kept the stamp it found');
  // The runtime answer lands after the boot, exactly as it does in main.ts.
  st.state.serverStartedAt = RUN_A;
  st.saveUi();
  assert.equal(bag().run, RUN_A);
  // Which leaves the next reload inside this run a keeper.
  st.loadUi({ reopen: false, run: RUN_A });
  assert.deepEqual(viewIds(), [home().id, 'v-files']);
});

test('D3: setRunStamp after loadUi re-stamps the bag, so the restart’s reload keeps the tabs', () => {
  st.initServer([], []);
  bagWithTabs(RUN_A);
  st.state.serverStartedAt = RUN_A;
  st.loadUi({ reopen: false, run: RUN_A });
  assert.deepEqual(viewIds(), [home().id, 'v-files']);
  // The restart's 202 named the run that took over. Without this the reload
  // below reads its own bag as another run's and opens on Home.
  st.setRunStamp(RUN_B);
  const bag = JSON.parse(memoryStorage.getItem(STORAGE_KEY) as string) as Record<string, unknown>;
  assert.equal(bag.run, RUN_B);
  assert.equal(st.state.serverStartedAt, RUN_B);
  assert.equal(
    (bag.views as { id: string }[]).some((v) => v.id === 'v-files'),
    true,
    'the tabs are still in it',
  );
  st.loadUi({ reopen: false, run: RUN_B });
  assert.deepEqual(viewIds(), [home().id, 'v-files'], 'the reload after the restart keeps them');
});

test('D3: a hostile stamp is never laundered back into the bag — what is written is a string or nothing', () => {
  // The read side of the gate is covered above; this is the WRITE side of the
  // same hostile bag. `loadUi` remembers the stamp it found so a save that has
  // no run of its own does not null it out — and what it remembers has to be a
  // run, not whatever a hand-edited (or corrupted) prefs blob carried. Without
  // the string check a number, a boolean or an object is copied straight back
  // into storage, where every later boot has to keep defending against it.
  st.initServer([], []);
  const bag = (): Record<string, unknown> =>
    JSON.parse(memoryStorage.getItem(STORAGE_KEY) as string) as Record<string, unknown>;
  for (const run of [17, true, { at: RUN_A }, [RUN_A], '']) {
    bagWithTabs(RUN_A);
    const raw = JSON.parse(memoryStorage.getItem(STORAGE_KEY) as string) as Record<string, unknown>;
    raw.run = run;
    memoryStorage.setItem(STORAGE_KEY, JSON.stringify(raw));
    // This boot does not know its own run (GET /api/runtime has not landed),
    // so `loadUi`'s own save falls back on the stamp the bag carried.
    st.state.serverStartedAt = null;
    st.loadUi({ reopen: false, run: null });
    const written = bag().run;
    assert.equal(
      written === null || typeof written === 'string',
      true,
      `a ${JSON.stringify(run)} stamp must not be written back as itself (got ${JSON.stringify(written)})`,
    );
    if (typeof run !== 'string') assert.equal(written, null, `${JSON.stringify(run)} is no run at all`);
  }
  // And the empty string is a string, so it rides back out untouched — it can
  // never equal a real startedAt, which makes it another run, as it should be.
  assert.equal(bag().run, '');
  st.state.serverStartedAt = RUN_B;
  st.loadUi({ reopen: false, run: RUN_B });
  assert.deepEqual(viewIds(), [home().id], 'an empty stamp is not this run');
  assert.equal(bag().run, RUN_B, 'and the first save replaces it with a real one');
});
