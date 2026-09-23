/**
 * `web/src/state.ts` — editor tabs (A10b, B4): `openTabAt` and its drop
 * zones, four tabs per pane (the part B4 amendment from the user's Windows
 * check, 2026-09-22), and moving a tab to another pane or out into a split of
 * its own. Split out of `ui-state.test.ts`.
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
  HASH40,
  REOPEN,
  REPO,
  activeId,
  addView,
  ed,
  ftab,
  home,
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
