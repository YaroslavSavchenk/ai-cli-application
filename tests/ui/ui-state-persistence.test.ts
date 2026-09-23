/**
 * `web/src/state.ts` — persistence: what a reload keeps (views, editor tabs,
 * splits, the left panel of Nocturne A5 in the same v2 bag) and what it must
 * not (a relative path, a malformed tab). Split out of `ui-state.test.ts`.
 *
 * Seam: the real module, imported once per file by
 * `tests/helpers/ui-state-fixture.ts` after an in-memory `localStorage` shim
 * (`state.ts` is DOM-free except for the Web Storage global, which plain
 * `node --test` does not provide), so `loadUi`/`saveUi` exercise the real
 * persistence code paths; the module singleton is reset before every test.
 *
 * Why it matters: the bag is read back on every reload; a field the reader
 * trusts blindly reopens a file nobody asked for, or none at all.
 *
 * NOT claimed: how the panes render the arrangement in a browser
 * (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  A,
  B,
  C,
  E,
  HASH40,
  REOPEN,
  REPO,
  STORAGE_KEY,
  addView,
  dtab,
  ed,
  edTabs,
  ftab,
  home,
  memoryStorage,
  mkSession,
  resetState,
  sess,
  shape,
  st,
  type EditorSlot,
  type PaneSlot,
  type ViewState,
} from '../helpers/ui-state-fixture.ts';

before(() => {
  resetState();
});

beforeEach(() => {
  resetState();
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
