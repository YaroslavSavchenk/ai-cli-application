/**
 * Quality Q17 P3 — where a session resumed after WSL went down goes in the
 * tabs (`web/src/ui/resume-layout-model.ts` `placeResumed`;
 * `.claude/plans/quality/PLAN-Q17.md` § P3 item 3, § Test gate P3 "the
 * remap"), and the store half that applies it (`state.adoptResumed`,
 * `state.readLayoutSnapshot`) on the real state module.
 *
 * The model is called with plain views; the store half runs the real
 * `web/src/state.ts` against the in-memory localStorage of
 * `helpers/ui-state-fixture.ts`, through the same `loadUi` a boot runs — so
 * the snapshot is read from the very bag that `loadUi` then prunes.
 *
 * Why it matters: the layout names panes by SESSION id. Remapped by history
 * id (or not at all) every resumed session lands in a tab of its own and the
 * user's arrangement is lost on exactly the day they needed it.
 *
 * NOT claimed: the panes attaching and replaying (`ui/panes.ts`, a real
 * browser — `.claude/skills/verify-terminal/SKILL.md`); the server's resume.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { placeResumed, type LayoutSnapshot } from '../../web/src/ui/resume-layout-model.ts';
import {
  REOPEN,
  STORAGE_KEY,
  memoryStorage,
  mkSession,
  resetState,
  st,
  type PaneSlot,
  type ViewState,
} from '../helpers/ui-state-fixture.ts';

const OPTS = { maxPanes: 4, maxViews: 16, projectExists: (id: string) => id === 'p1' };

function view(id: string, slots: PaneSlot[], over: Partial<ViewState> = {}): ViewState {
  return { id, root: null, slots, focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 }, ...over };
}
const s = (id: string): PaneSlot => ({ kind: 'session', id });
const ids = (v: ViewState | undefined): string[] =>
  (v?.slots ?? []).map((x) => (x.kind === 'session' ? x.id : `editor:${x.id}`));
const HOME = (slots: PaneSlot[] = [], id = 'home'): ViewState => view(id, slots, { root: { kind: 'home' } });

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

test('a session goes back to its old slot index in the view that survived', () => {
  const snapshot: LayoutSnapshot = { views: [HOME(), view('t1', [s('a'), s('old'), s('b')])], active: null };
  // loadUi pruned `old`; `a` and `b` are still running.
  const live = [HOME(), view('t1', [s('a'), s('b')])];
  const got = placeResumed(live, snapshot, [{ previous: 'old', next: 'new' }], OPTS);
  assert.deepEqual(ids(got.views[1]), ['a', 'new', 'b']);
  assert.deepEqual(ids(live[1]), ['a', 'b'], 'the input views are not changed');
});

test('the remap is by previous SESSION id, never by anything else in the slot', () => {
  const snapshot: LayoutSnapshot = { views: [HOME(), view('t1', [s('sess-old')])], active: null };
  const got = placeResumed([HOME()], snapshot, [{ previous: 'hist-1', next: 'new' }], OPTS);
  assert.equal(got.views.length, 1, 'a history id names no pane: nothing is placed');
});

test('a tab that dissolved comes back with its id, its place, its splits and its editor panes', () => {
  const editor: PaneSlot = { kind: 'editor', id: 'e:9', tabs: [{ kind: 'file', path: '/home/you/a.ts' }], active: 0 };
  const stored = view('t2', [s('x'), editor, s('y')], { focused: 2, l3: 'R', split: { col: 0.3, row: 0.7 } });
  const snapshot: LayoutSnapshot = { views: [HOME(), view('t1', [s('a')]), stored], active: 't2' };
  const live = [HOME(), view('t1', [s('a')])];
  const got = placeResumed(
    live,
    snapshot,
    [
      { previous: 'x', next: 'X' },
      { previous: 'y', next: 'Y' },
    ],
    OPTS,
  );
  const back = got.views[2];
  assert.equal(back?.id, 't2');
  assert.deepEqual(ids(back), ['X', 'editor:e:9', 'Y']);
  assert.equal(back?.focused, 2, 'the focus sits where it sat');
  assert.equal(back?.l3, 'R');
  assert.deepEqual(back?.split, { col: 0.3, row: 0.7 });
  assert.equal(got.active, 't2', 'the tab the user was on comes back active');
});

test('only resumed sessions come back; a failed one leaves no pane', () => {
  const snapshot: LayoutSnapshot = { views: [HOME(), view('t1', [s('ok'), s('failed')], { focused: 1 })], active: null };
  const got = placeResumed([HOME()], snapshot, [{ previous: 'ok', next: 'NEW' }], OPTS);
  assert.deepEqual(ids(got.views[1]), ['NEW']);
  assert.equal(got.views[1]?.focused, 0, 'the focused pane was the failed one: focus on the first');
});

test('Home is found by kind — its id may be new after a dropped bag', () => {
  const snapshot: LayoutSnapshot = { views: [HOME([s('old')], 'home-before')], active: 'home-before' };
  const got = placeResumed([HOME([], 'home-now')], snapshot, [{ previous: 'old', next: 'new' }], OPTS);
  assert.equal(got.views.length, 1);
  assert.deepEqual(ids(got.views[0]), ['new']);
  assert.equal(got.active, 'home-now');
});

test('a re-made tab is never put before Home, and a gone project is a plain tab', () => {
  const snapshot: LayoutSnapshot = {
    views: [view('p-tab', [s('a')], { root: { kind: 'project', id: 'gone' } }), HOME()],
    active: null,
  };
  const got = placeResumed([HOME()], snapshot, [{ previous: 'a', next: 'A' }], OPTS);
  assert.equal(got.views[0]?.root?.kind, 'home');
  assert.equal(got.views[1]?.id, 'p-tab');
  assert.equal(got.views[1]?.root, null, 'the project is gone: no root that names nothing');
  const kept = placeResumed(
    [HOME()],
    { views: [HOME(), view('p1-tab', [s('a')], { root: { kind: 'project', id: 'p1' } })], active: null },
    [{ previous: 'a', next: 'A' }],
    OPTS,
  );
  assert.deepEqual(kept.views[1]?.root, { kind: 'project', id: 'p1' }, 'a project that exists keeps its tab');
});

test('a full view takes no more panes; the session is left for a tab of its own', () => {
  const snapshot: LayoutSnapshot = { views: [HOME(), view('t1', [s('a'), s('b'), s('c'), s('old')])], active: null };
  // Meanwhile a fourth pane took the freed place.
  const live = [HOME(), view('t1', [s('a'), s('b'), s('c'), s('d')])];
  const got = placeResumed(live, snapshot, [{ previous: 'old', next: 'new' }], OPTS);
  assert.deepEqual(ids(got.views[1]), ['a', 'b', 'c', 'd']);
  assert.equal(got.views.some((v) => ids(v).includes('new')), false);
});

test('a resumed id the poll already gave a tab of its own is moved, and that tab goes', () => {
  const snapshot: LayoutSnapshot = { views: [HOME(), view('t1', [s('a'), s('old')])], active: null };
  const live = [HOME(), view('t1', [s('a')]), view('auto', [s('new')])];
  const got = placeResumed(live, snapshot, [{ previous: 'old', next: 'new' }], OPTS);
  assert.deepEqual(got.views.map((v) => v.id), ['home', 't1']);
  assert.deepEqual(ids(got.views[1]), ['a', 'new']);
});

test('a live tab of the same project under another id takes the sessions; no second project tab', () => {
  const stored = view('p-old', [s('a'), s('b')], { root: { kind: 'project', id: 'p1' } });
  const snapshot: LayoutSnapshot = { views: [HOME(), stored], active: 'p-old' };
  // The bag was dropped; the user opened a file from p1 before pressing Resume.
  const editor: PaneSlot = { kind: 'editor', id: 'e:1', tabs: [{ kind: 'file', path: '/home/you/p1/a.ts' }], active: 0 };
  const live = [HOME(), view('p-new', [editor], { root: { kind: 'project', id: 'p1' } })];
  const got = placeResumed(
    live,
    snapshot,
    [
      { previous: 'a', next: 'A' },
      { previous: 'b', next: 'B' },
    ],
    OPTS,
  );
  assert.deepEqual(got.views.map((v) => v.id), ['home', 'p-new'], 'merged, not recreated');
  assert.deepEqual(ids(got.views[1]), ['A', 'B', 'editor:e:1']);
  assert.equal(got.active, 'p-new');
});

test('a re-made tab never builds an editor pane whose id is already on screen', () => {
  const editor: PaneSlot = { kind: 'editor', id: 'e:7', tabs: [{ kind: 'file', path: '/home/you/a.ts' }], active: 0 };
  const snapshot: LayoutSnapshot = { views: [HOME(), view('gone', [s('x'), editor])], active: null };
  const live = [HOME(), view('other', [editor])];
  const got = placeResumed(live, snapshot, [{ previous: 'x', next: 'X' }], OPTS);
  assert.deepEqual(ids(got.views.find((v) => v.id === 'gone')), ['X']);
  const count = got.views.flatMap((v) => v.slots).filter((x) => x.id === 'e:7').length;
  assert.equal(count, 1, 'one pane per editor id');
});

// ---------------------------------------------------------------------------
// The store half, on the real state module
// ---------------------------------------------------------------------------

beforeEach(() => resetState());

/** A bag as a previous page wrote it: Home, a 2-pane tab and a 1-pane tab. */
function storeBag(run: string): void {
  memoryStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      views: [
        { id: 'h', root: { kind: 'home' }, slots: [] },
        { id: 'pair', root: null, slots: [s('old-a'), s('old-b')], focused: 1 },
        { id: 'solo', root: null, slots: [s('old-c')] },
      ],
      active: 'pair',
      run,
    }),
  );
}

test('the snapshot is read before loadUi prunes, and the resume puts each session back', () => {
  storeBag('run-before');
  const snap = st.readLayoutSnapshot();
  // The new backend run knows none of the old sessions, and `Reopen tabs on
  // start` is off: loadUi drops the whole bag.
  st.loadUi({ reopen: false, run: 'run-now' });
  assert.equal(st.state.views.length, 1, 'precondition: only Home after the boot');

  st.adoptResumed(snap, [
    { previousSessionId: 'old-a', session: mkSession('new-a') },
    { previousSessionId: 'old-b', session: mkSession('new-b') },
    { previousSessionId: 'old-c', session: mkSession('new-c') },
  ]);
  assert.deepEqual(
    st.state.views.map((v) => [v.id, ids(v)]),
    [
      [st.state.views[0]?.id, []],
      ['pair', ['new-a', 'new-b']],
      ['solo', ['new-c']],
    ],
  );
  assert.equal(st.state.activeViewId, 'pair');
  assert.equal(st.state.views[1]?.focused, 1);
  assert.equal(st.state.sessions.size, 3, 'the sessions are in the store');
  const saved = JSON.parse(memoryStorage.getItem(STORAGE_KEY) ?? 'null') as { views: { id: string }[] };
  assert.deepEqual(saved.views.map((v) => v.id).slice(1), ['pair', 'solo'], 'the arrangement is saved');
});

test('a session the stored layout never had gets a tab of its own', () => {
  storeBag('r');
  const snap = st.readLayoutSnapshot();
  st.loadUi(REOPEN);
  st.adoptResumed(snap, [{ previousSessionId: 'never-seen', session: mkSession('new-x') }]);
  assert.equal(st.viewOfSession('new-x')?.slots.length, 1);
});

test('a hostile bag gives an empty snapshot, never a throw', () => {
  memoryStorage.setItem(STORAGE_KEY, '{not json');
  assert.deepEqual(st.readLayoutSnapshot(), { views: [], active: null });
  memoryStorage.setItem(STORAGE_KEY, JSON.stringify({ views: 'x', active: 5 }));
  assert.deepEqual(st.readLayoutSnapshot(), { views: [], active: null });
});
