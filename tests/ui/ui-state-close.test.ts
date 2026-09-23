/**
 * `web/src/state.ts` — closing, raising and cycling tabs, and the rule that
 * unsaved text is dropped only with the LAST pane showing that file. Split out
 * of `ui-state.test.ts`.
 *
 * Why it matters: a close that drops another pane's unsaved text loses the
 * user's work without a question.
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
  REOPEN,
  activeId,
  addView,
  collectKinds,
  ed,
  ftab,
  home,
  keys,
  mkSession,
  resetState,
  sess,
  shape,
  st,
  strip,
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
