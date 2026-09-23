/**
 * `web/src/state.ts` — Nocturne B6 D3: `Reopen tabs on start` and the run
 * stamp. The bag carries the run that wrote it; Off applies to a NEW app start
 * only, while a reload inside the same run keeps the arrangement. Split out of
 * `ui-state.test.ts`.
 *
 * ORDER MATTERS: the first test must stay first in this file — the guard it
 * pins is a module-level flag `loadUi` sets once and nothing can unset, so it
 * can only be observed before any other test loads.
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
  STORAGE_KEY,
  STORAGE_KEY_V1,
  home,
  keys,
  memoryStorage,
  mkSession,
  resetState,
  st,
  strip,
  type ViewState,
} from '../helpers/ui-state-fixture.ts';

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
