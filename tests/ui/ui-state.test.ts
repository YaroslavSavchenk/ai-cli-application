/**
 * `web/src/state.ts` — client-local view arrangement: the empty state, the
 * active-view fallback and pruning through `loadUi`, pre-R3 v2 blobs and the
 * v1 -> v2 migration, `viewStatus`, and the A10 rules (slots, roots, Home,
 * files as panes). Tabs are in `ui-state-tabs.test.ts`, closing and unsaved
 * text in `ui-state-close.test.ts`, persistence in
 * `ui-state-persistence.test.ts`, the notify kinds in
 * `ui-state-notify.test.ts`, the B6 D3 reopen switch in
 * `ui-state-reopen.test.ts`.
 *
 * Since A10 (user decision 2026-09-15) a view holds 0..4 SLOTS and `Home` is a
 * real view that is always `state.views[0]`; since A10b a slot is a terminal
 * or an EDITOR PANE holding a strip of file/diff TABS, and the two mix freely.
 *
 * Seam: the real module, imported once per file by
 * `tests/helpers/ui-state-fixture.ts` after an in-memory `localStorage` shim
 * (`state.ts` is DOM-free except for the Web Storage global, which plain
 * `node --test` does not provide), so `loadUi`/`saveUi` exercise the real
 * persistence code paths; the module singleton is reset before every test.
 *
 * NOT claimed: how the panes render the arrangement in a browser
 * (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  E,
  REOPEN,
  REPO,
  STORAGE_KEY,
  STORAGE_KEY_V1,
  activeId,
  addView,
  dtab,
  ed,
  edTabs,
  ftab,
  home,
  keys,
  memoryStorage,
  mkSession,
  resetState,
  sess,
  shape,
  st,
  strip,
  type EditorSlot,
  type PaneSlot,
  type ViewRoot,
  type ViewState,
} from '../helpers/ui-state-fixture.ts';

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
