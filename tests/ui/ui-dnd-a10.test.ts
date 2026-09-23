/**
 * `web/src/ui/dnd.ts` — the pointer drag layer, driven through the REAL module
 * on the DOM double in `tests/helpers/fake-dom.ts`, against the REAL
 * `web/src/state.ts` (shared shell: `tests/helpers/ui-dnd-a10-fixture.ts`).
 *
 * WHY THIS FILE EXISTS. Until A10 nothing drove `dnd.ts` at all: the drag paths
 * were covered by source scans and by hand. A10 put a THIRD source into it (a
 * Files-panel row) and a rejection that is a user decision rather than a
 * capacity limit (the centre of a terminal pane), so the parts that can be
 * checked without a browser are checked here:
 *
 *   1. hit-testing -> target: which pane, which zone, which tab chip;
 *   2. the refusals — a terminal pane's centre, a full tab — as the ghost's
 *      state AND as what state.ts was (not) asked to do;
 *   3. Escape cancels, a finished drag swallows its click, and the ghost's
 *      transform follows the cursor;
 *   4. `Home` is never a tab-drag source and no strip position before it is
 *      ever a drop target (user decision 4, 2026-09-15);
 *   5. no `draggable` attribute exists anywhere in `web/src` — the window's
 *      HTML5 drop channel belongs to real files from Explorer (A9/B10).
 *
 * A10b's FOURTH source, a file-tab CHIP of an editor pane's strip, is in
 * `tests/ui/ui-dnd-a10-filetab.test.ts`.
 *
 * The PURE geometry (`zoneForPoint`, the 0.25 edge band) is pinned in
 * `tests/ui/ui-slots-model.test.ts` and deliberately not repeated here; this file
 * asks whether the drag layer feeds it the right rectangle and does the right
 * thing with its answer.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * real layout, how the ghost's transform paints, CSS, that a split actually
 * reflows a PTY.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { byClass, dispatch, type FakeElement } from '../helpers/fake-dom.ts';
import { readSource, projectRoot, filesUnder } from '../helpers/helpers.ts';
import {
  advanceClickClock,
  dom,
  st,
  DND,
  type PaneSlot,
  type ViewLike,
  strip,
  grid,
  sourceRow,
  sourceChip,
  flashText,
  paint,
  centreOf,
  leftEdgeOf,
  chipOf,
  dragTo,
  emptyBox,
  EMPTY_POINT,
  ghost,
  view,
  FILE_SPEC,
  ed,
  shapeOf,
  resetShell,
} from '../helpers/ui-dnd-a10-fixture.ts';

// ---------------------------------------------------------------------------
// The two armed sources' specs — per file: the tests below reassign them,
// which an imported binding cannot be. The elements themselves are the
// fixture's (`tests/helpers/ui-dnd-a10-fixture.ts`).
// ---------------------------------------------------------------------------

let spec: Record<string, unknown> | null = null;
DND.armDrag(sourceRow, null, () => spec);
let chipSpec: Record<string, unknown> | null = null;
DND.armDrag(sourceChip, '.pane-x', () => chipSpec);

beforeEach(() => {
  resetShell();
  spec = null;
  chipSpec = null;
});

// ===========================================================================
// A file row onto a pane
// ===========================================================================

test('non-vacuity: the harness really hit-tests — a pane centre resolves to that pane', () => {
  st.state.views = [view({ id: 'v1', root: { kind: 'home' }, slots: [ed('a.ts')] })];
  st.state.activeViewId = 'v1';
  paint();
  assert.equal(dom.doc.elementFromPoint(centreOf(0).x, centreOf(0).y)?.className, 'pane');
  assert.equal(byClass(grid, 'pane').length, 1, 'one pane was drawn');
  assert.equal(dom.doc.elementFromPoint(10, 20)?.className, 'tab', 'and the strip hit-tests too');
  assert.equal(dom.doc.elementFromPoint(5000, 5000), null, 'a point over nothing hits nothing');
});

test('a file dropped on a pane EDGE splits that pane and opens the file there', () => {
  st.state.views = [view({ id: 'v1', root: { kind: 'home' }, slots: [{ kind: 'session', id: 's1' }] })];
  st.state.activeViewId = 'v1';
  paint();
  spec = FILE_SPEC;

  const lit = dragTo(leftEdgeOf(0));
  assert.notEqual(lit, null, 'the edge lights the drop overlay');
  assert.equal(lit?.dataset.zone, 'left', 'the outer quarter is a SPLIT, not a replace');
  assert.equal(byClass(lit as FakeElement, 'pane-drop-lb')[0]?.textContent, 'Open beside');

  assert.deepEqual(shapeOf(st.activeView()), ['*web/src/Pane.tsx', 'session s1'],
    'a NEW editor pane beside the terminal, holding the one file');
});

test('a file dropped on the CENTRE of an EDITOR pane ADDS a tab — it replaces nothing (A10b)', () => {
  // Orchestrator default 4, A10b: a pane full of the user's other files is not
  // something a drop may quietly throw away. The label still reads `Open here`
  // — that is where it opens — and the pane count does not move.
  st.state.views = [
    view({ id: 'v1', root: { kind: 'home' }, slots: [ed('old.ts')] }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  spec = FILE_SPEC;

  const lit = dragTo(centreOf(0));
  assert.equal(lit?.dataset.zone, 'replace');
  assert.equal(byClass(lit as FakeElement, 'pane-drop-lb')[0]?.textContent, 'Open here');
  assert.equal((st.activeView() as ViewLike).slots.length, 1, 'still ONE pane');
  assert.deepEqual(shapeOf(st.activeView()), ['old.ts *web/src/Pane.tsx'],
    'the dropped file joined the strip, and is the one showing');
});

test('a file dropped on the centre of a FULL strip evicts the last chip and takes its place', () => {
  // The B4 amendment (2026-09-22): four files per pane. The drop is NOT
  // refused — only a MOVE is — and the chip in position 4 leaves. Unsaved
  // text in it is asked about first; that question is pinned on the guard
  // itself (tests/ui/ui-unsaved.test.ts), which this drop goes through.
  st.state.views = [
    view({ id: 'v1', root: { kind: 'home' }, slots: [ed('a.ts', 'b.ts', 'c.ts', 'd.ts')] }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  spec = FILE_SPEC;

  const lit = dragTo(centreOf(0));
  assert.equal(lit?.dataset.zone, 'replace', 'the centre still promises the drop');
  assert.equal(flashText(), '', 'and it landed, so nothing was refused');
  assert.deepEqual(
    shapeOf(st.activeView()),
    ['a.ts b.ts c.ts *web/src/Pane.tsx'],
    'four chips: d.ts made room for the dropped file',
  );
});

test('the CENTRE of a TERMINAL pane is refused: invalid ghost, no overlay, nothing replaced', () => {
  // User decision 7, 2026-09-15. A running session is not something a file may
  // quietly take the place of.
  st.state.views = [
    view({ id: 'v1', root: { kind: 'home' }, slots: [{ kind: 'session', id: 's1' }] }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  spec = FILE_SPEC;

  dispatch(sourceRow, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 3 });
  const c = centreOf(0);
  dispatch(dom.body, 'pointermove', { clientX: c.x, clientY: c.y, pointerId: 3 });
  assert.equal(
    byClass(grid, 'pane-drop').some((n) => !n.hidden),
    false,
    'no box: a box would promise the pane is about to change',
  );
  assert.equal(ghost()?.classList.contains('is-invalid'), true, 'the ghost says no');

  dispatch(dom.body, 'pointerup', { clientX: c.x, clientY: c.y, pointerId: 3 });
  assert.deepEqual(
    (st.activeView() as ViewLike).slots,
    [{ kind: 'session', id: 's1' }],
    'the terminal is still there',
  );
});

test('the refusal SAYS why, and the sentence names the way out', () => {
  // The flash lives in the statusline module; what is pinned here is that the
  // drop layer holds exactly one sentence for this case and that it points at
  // the edges.
  const src = readSource('web', 'src', 'ui', 'dnd.ts');
  const m = /const REJECT_SESSION_CENTRE =\s*\n?\s*'([^']*)'/.exec(src);
  assert.notEqual(m, null, 'the sentence must still be a named constant');
  const text = m?.[1] ?? '';
  assert.match(text, /terminal pane/, text);
  assert.match(text, /edge/, `it must name the way out: ${text}`);
  assert.match(text, /^[A-Z].*\.$/, `plain sentences, no code: ${text}`);
});

test('a full tab refuses an edge split with the capacity flash, and opens nothing', () => {
  st.state.views = [
    view({
      id: 'v1',
      root: { kind: 'home' },
      slots: [
        { kind: 'session', id: 's1' },
        { kind: 'session', id: 's2' },
        ed('a.ts'),
        ed('b.ts'),
      ],
    }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  spec = FILE_SPEC;

  const before = shapeOf(st.activeView());
  dispatch(sourceRow, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 5 });
  const p = leftEdgeOf(0);
  dispatch(dom.body, 'pointermove', { clientX: p.x, clientY: p.y, pointerId: 5 });
  assert.equal(ghost()?.classList.contains('is-invalid'), true, 'a full tab cannot take a 5th pane');
  dispatch(dom.body, 'pointerup', { clientX: p.x, clientY: p.y, pointerId: 5 });
  assert.deepEqual(shapeOf(st.activeView()), before);
});

test('a full tab still takes a centre drop — a TAB costs no pane', () => {
  st.state.views = [
    view({
      id: 'v1',
      root: { kind: 'home' },
      slots: [
        ed('a.ts'),
        { kind: 'session', id: 's1' },
        { kind: 'session', id: 's2' },
        ed('b.ts'),
      ],
    }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  spec = FILE_SPEC;

  dragTo(centreOf(0));
  assert.deepEqual(shapeOf(st.activeView())[0], 'a.ts *web/src/Pane.tsx');
  assert.equal((st.activeView() as ViewLike).slots.length, 4, 'still four panes');
});

// ===========================================================================
// A file row onto a tab chip
// ===========================================================================

test('a file dropped on a FOLDER tab chip appends it there, and goes to that tab', () => {
  st.state.views = [
    view({ id: 'home', root: { kind: 'home' }, slots: [] }),
    view({ id: 'v1', root: null, slots: [{ kind: 'session', id: 's1' }] }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  spec = FILE_SPEC;

  const target = chipOf('home');
  dispatch(sourceRow, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 6 });
  dispatch(dom.body, 'pointermove', { clientX: target.x, clientY: target.y, pointerId: 6 });
  assert.equal(
    (strip.children[0] as FakeElement).classList.contains('is-drop'),
    true,
    'the chip lights up as the target',
  );
  dispatch(dom.body, 'pointerup', { clientX: target.x, clientY: target.y, pointerId: 6 });

  assert.deepEqual(shapeOf(st.state.views[0] ?? null), ['*web/src/Pane.tsx']);
  assert.equal(st.state.activeViewId, 'home', 'the file is on screen, so the app goes there');
});

test('a FULL folder tab chip refuses the file', () => {
  // Four TERMINALS: with any editor pane in the tab a file becomes a tab
  // there and costs no pane (A10b), so this is the only shape that is full.
  st.state.views = [
    view({
      id: 'home',
      root: { kind: 'home' },
      slots: [
        { kind: 'session', id: 's1' },
        { kind: 'session', id: 's2' },
        { kind: 'session', id: 's3' },
        { kind: 'session', id: 's4' },
      ],
    }),
  ];
  st.state.activeViewId = 'home';
  paint();
  spec = FILE_SPEC;

  const target = chipOf('home');
  dispatch(sourceRow, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 7 });
  dispatch(dom.body, 'pointermove', { clientX: target.x, clientY: target.y, pointerId: 7 });
  assert.equal(ghost()?.classList.contains('is-invalid'), true);
  assert.equal((strip.children[0] as FakeElement).classList.contains('is-drop'), false);
  dispatch(dom.body, 'pointerup', { clientX: target.x, clientY: target.y, pointerId: 7 });
  assert.equal(st.state.views[0]?.slots.length, 4, 'no fifth pane');
});

test('a plain SESSION tab chip is not a file target — it has no folder to belong to', () => {
  st.state.views = [
    view({ id: 'home', root: { kind: 'home' }, slots: [] }),
    view({ id: 'v1', root: null, slots: [{ kind: 'session', id: 's1' }] }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  spec = FILE_SPEC;

  const target = chipOf('v1');
  dispatch(sourceRow, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 8 });
  dispatch(dom.body, 'pointermove', { clientX: target.x, clientY: target.y, pointerId: 8 });
  assert.equal((strip.children[1] as FakeElement).classList.contains('is-drop'), false);
  dispatch(dom.body, 'pointerup', { clientX: target.x, clientY: target.y, pointerId: 8 });
  assert.deepEqual(st.state.views[1]?.slots, [{ kind: 'session', id: 's1' }]);
});

// ===========================================================================
// Escape, and the click a finished drag swallows
// ===========================================================================

test('a full folder tab that holds an EDITOR pane still takes the file, as a tab (A10b)', () => {
  st.state.views = [
    view({
      id: 'home',
      root: { kind: 'home' },
      slots: [ed('a.ts'), { kind: 'session', id: 's1' }, { kind: 'session', id: 's2' }, { kind: 'session', id: 's3' }],
    }),
  ];
  st.state.activeViewId = 'home';
  paint();
  spec = FILE_SPEC;

  const target = chipOf('home');
  dispatch(sourceRow, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 7 });
  dispatch(dom.body, 'pointermove', { clientX: target.x, clientY: target.y, pointerId: 7 });
  assert.equal(ghost()?.classList.contains('is-invalid'), false, 'the drag promises what the drop does');
  assert.equal((strip.children[0] as FakeElement).classList.contains('is-drop'), true);
  dispatch(dom.body, 'pointerup', { clientX: target.x, clientY: target.y, pointerId: 7 });
  assert.equal(st.activeView()?.slots.length, 4, 'no fifth pane');
  assert.equal(st.slotTabIds(st.activeView()!.slots[0]).length, 2, 'the file is a second tab of the editor pane');
});

test('that editor pane has room until FOUR — then the file EVICTS the last chip (B4 amendment)', () => {
  // The A10b rule was "a tab holding an editor pane always has room". Since
  // the user's limit of four (2026-09-22) the strip is capped, and the drop
  // still lands: the fifth file takes position 4 and the chip that was there
  // leaves. The drag may not promise less than the drop does, so the chip
  // still lights up.
  st.state.views = [
    view({
      id: 'home',
      root: { kind: 'home' },
      slots: [ed('a.ts', 'b.ts', 'c.ts', 'd.ts'), { kind: 'session', id: 's1' }],
    }),
  ];
  st.state.activeViewId = 'home';
  paint();
  spec = FILE_SPEC;

  const target = chipOf('home');
  dispatch(sourceRow, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 70 });
  dispatch(dom.body, 'pointermove', { clientX: target.x, clientY: target.y, pointerId: 70 });
  assert.equal(ghost()?.classList.contains('is-invalid'), false, 'the drag promises what the drop does');
  assert.equal((strip.children[0] as FakeElement).classList.contains('is-drop'), true);
  dispatch(dom.body, 'pointerup', { clientX: target.x, clientY: target.y, pointerId: 70 });
  assert.equal(flashText(), '', 'it landed, so nothing was refused');
  assert.deepEqual(
    shapeOf(st.activeView()),
    ['a.ts b.ts c.ts *web/src/Pane.tsx', 'session s1'],
    'four chips, the dropped file at position 4 and on screen',
  );
});

test('Escape cancels the drag: no pane changes, no ghost, no visuals left behind', () => {
  st.state.views = [
    view({ id: 'v1', root: { kind: 'home' }, slots: [ed('old.ts')] }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  spec = FILE_SPEC;

  const lit = dragTo(centreOf(0), { cancel: true });
  assert.notEqual(lit, null, 'non-vacuity: the target really was lit before Escape');
  assert.deepEqual(shapeOf(st.activeView()), ['*old.ts']);
  assert.equal(ghost(), null, 'the ghost goes with the cancel');
  assert.equal(
    byClass(grid, 'pane-drop').some((n) => !n.hidden),
    false,
    'and the overlay with it',
  );
});

test('a finished drag swallows the click that follows it', () => {
  st.state.views = [
    view({ id: 'v1', root: { kind: 'home' }, slots: [ed('old.ts')] }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  spec = FILE_SPEC;
  dragTo(centreOf(0));

  // The row a drag started on is a BUTTON: without the swallow, the browser's
  // click after pointerup would open the file a second time, in the wrong place.
  let clicks = 0;
  const probe = dom.doc.createElement('button');
  probe.addEventListener('click', () => {
    clicks += 1;
  });
  dom.body.append(probe);
  probe.click();
  assert.equal(clicks, 0, 'the post-drag click is swallowed');

  // It is a short window, not a mode: once it is over, clicks work again.
  //
  // STEPS THE CLOCK `dnd.ts` READS (the fixture owns it through
  // `setClickSwallowClock`). Waiting the window out in real time raced: a timer
  // runs on the MONOTONIC clock and `Date.now()` could still say the window was
  // open (observed once in a full `npm run test:ui`, 2026-09-16). One tick
  // short of the window the click is still eaten; at its end it goes through.
  advanceClickClock(DND.CLICK_SWALLOW_MS - 1);
  probe.click();
  assert.equal(clicks, 0, 'still inside the window one millisecond before its end');
  advanceClickClock(1);
  probe.click();
  assert.equal(clicks, 1);
  probe.remove();
});

test('the ghost sits below-right of the cursor with a static tilt, from the one shared transform', () => {
  st.state.views = [view({ id: 'v1', root: { kind: 'home' }, slots: [ed('old.ts')] })];
  st.state.activeViewId = 'v1';
  paint();
  spec = FILE_SPEC;
  // The look itself, pinned: ui/filedrop.ts draws its Explorer ghost from the
  // same function, so this string is what both channels show.
  assert.equal(DND.ghostTransform(60, 40), 'translate(74px, 50px) rotate(-2deg)');

  dispatch(sourceRow, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 16 });
  dispatch(dom.body, 'pointermove', { clientX: 60, clientY: 40, pointerId: 16 });
  assert.equal(ghost()?.style.transform, DND.ghostTransform(60, 40), 'placed at the first move');
  dispatch(dom.body, 'pointermove', { clientX: 300, clientY: 90, pointerId: 16 });
  assert.equal(ghost()?.style.transform, DND.ghostTransform(300, 90), 'and follows the cursor');
  dispatch(dom.body, 'keydown', { key: 'Escape' });
  assert.equal(ghost(), null);
});

// ===========================================================================
// Home: never a source, never a position to drop before (decision 4)
// ===========================================================================

test('the Home chip is never a tab-drag SOURCE, however the spec was built', () => {
  st.state.views = [
    view({ id: 'home', root: { kind: 'home' }, slots: [{ kind: 'session', id: 's1' }] }),
    view({ id: 'v1', root: null, slots: [{ kind: 'session', id: 's2' }] }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  spec = { kind: 'tab', viewId: 'home', label: 'Home' };

  const target = chipOf('v1');
  dispatch(sourceRow, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 11 });
  dispatch(dom.body, 'pointermove', { clientX: target.x, clientY: target.y, pointerId: 11 });
  assert.equal((strip.children[1] as FakeElement).classList.contains('is-drop'), false);
  dispatch(dom.body, 'pointerup', { clientX: target.x, clientY: target.y, pointerId: 11 });

  assert.equal(st.state.views.length, 2, 'Home was not dissolved into the other tab');
  assert.equal(st.state.views[0]?.id, 'home', 'and it is still the first tab');
});

test('no drop position before Home exists: dragging onto its LEFT edge targets nothing', () => {
  st.state.views = [
    view({ id: 'home', root: { kind: 'home' }, slots: [{ kind: 'session', id: 's1' }] }),
    view({ id: 'v1', root: null, slots: [{ kind: 'session', id: 's2' }] }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  spec = { kind: 'tab', viewId: 'v1', label: 'two' };

  // x = 5 is inside the Home chip's outer quarter: a reorder to index 0.
  dispatch(sourceRow, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 12 });
  dispatch(dom.body, 'pointermove', { clientX: 5, clientY: 20, pointerId: 12 });
  assert.equal(
    byClass(strip, 'is-insert-before').length,
    0,
    'no caret before Home — that position does not exist',
  );
  dispatch(dom.body, 'pointerup', { clientX: 5, clientY: 20, pointerId: 12 });
  assert.equal(st.state.views[0]?.id, 'home', 'the fixed first tab is still first');
  assert.equal(st.state.views[1]?.id, 'v1');
});

// ===========================================================================
// A pane drag: kind-blind swap, session-only extract / move
// ===========================================================================

test('an EDITOR pane swaps with a terminal pane like any other pane', () => {
  st.state.views = [
    view({
      id: 'v1',
      root: { kind: 'home' },
      slots: [ed('a.ts'), { kind: 'session', id: 's1' }],
    }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  spec = { kind: 'pane', viewId: 'v1', slot: 0, slotKey: st.slotKey(st.state.views[0]?.slots[0] as PaneSlot), label: 'a.ts' };

  dragTo(centreOf(1));
  assert.deepEqual(shapeOf(st.activeView()), ['session s1', '*a.ts']);
});

test('an EDITOR pane cannot be extracted to its own tab, and cannot be moved into another', () => {
  // Decision 5, 2026-09-15: moving an open file to another tab was not asked
  // for. The two targets simply never light up for it.
  st.state.views = [
    view({ id: 'home', root: { kind: 'home' }, slots: [] }),
    view({
      id: 'v1',
      root: null,
      slots: [ed('a.ts'), { kind: 'session', id: 's1' }],
    }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  spec = {
    kind: 'pane',
    viewId: 'v1',
    slot: 0,
    slotKey: st.slotKey(st.state.views[1]?.slots[0] as PaneSlot),
    label: 'a.ts',
  };

  // Onto the strip: an extract.
  dispatch(sourceRow, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 13 });
  dispatch(dom.body, 'pointermove', { clientX: 900, clientY: 20, pointerId: 13 });
  assert.equal(strip.classList.contains('is-drop'), false, 'the strip is not a target for a file');
  dispatch(dom.body, 'pointerup', { clientX: 900, clientY: 20, pointerId: 13 });
  assert.equal(st.state.views.length, 2, 'no new tab');

  // Onto the Home chip: a move-to-view.
  const target = chipOf('home');
  dispatch(sourceRow, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 14 });
  dispatch(dom.body, 'pointermove', { clientX: target.x, clientY: target.y, pointerId: 14 });
  assert.equal((strip.children[0] as FakeElement).classList.contains('is-drop'), false);
  dispatch(dom.body, 'pointerup', { clientX: target.x, clientY: target.y, pointerId: 14 });
  assert.deepEqual(st.state.views[0]?.slots, [], 'Home did not take the file');
});

test('a SESSION pane still extracts to its own tab — and never before Home', () => {
  st.state.views = [
    view({ id: 'home', root: { kind: 'home' }, slots: [] }),
    view({
      id: 'v1',
      root: null,
      slots: [{ kind: 'session', id: 's1' }, { kind: 'session', id: 's2' }],
    }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  spec = { kind: 'pane', viewId: 'v1', slot: 0, slotKey: 's:s1', label: 's1' };

  // Far right of the strip, past every chip: append.
  dispatch(sourceRow, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 15 });
  dispatch(dom.body, 'pointermove', { clientX: 900, clientY: 20, pointerId: 15 });
  assert.equal(strip.classList.contains('is-drop'), true, 'a session CAN leave its tab');
  dispatch(dom.body, 'pointerup', { clientX: 900, clientY: 20, pointerId: 15 });
  assert.equal(st.state.views.length, 3);
  assert.equal(st.state.views[0]?.id, 'home', 'Home is untouched at the front');
});

// ===========================================================================
// The EMPTY pane area of an empty tab is a drop target (normally Home)
// ===========================================================================

test('a file dropped on the EMPTY pane area of Home opens there, and the BOX lights up', () => {
  // Home stands empty at first paint, so this is the first drop a user can
  // make. Before A10's fix it resolved to nothing: no pane, no flash, no file.
  st.state.views = [
    view({ id: 'home', root: { kind: 'home' }, slots: [] }),
    view({ id: 'v1', root: null, slots: [{ kind: 'session', id: 's1' }] }),
  ];
  st.state.activeViewId = 'home';
  paint();
  spec = FILE_SPEC;
  assert.equal(emptyBox() !== null, true, 'non-vacuity: the empty state really is drawn');
  assert.equal(byClass(grid, 'pane').length, 0, 'and there is no pane to hit instead');

  dispatch(sourceRow, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 21 });
  dispatch(dom.body, 'pointermove', { ...EMPTY_POINT, pointerId: 21 });
  assert.equal(
    emptyBox()?.classList.contains('is-drop'),
    true,
    'the empty state is the target, so it is what lights up',
  );
  assert.equal(ghost()?.classList.contains('is-invalid'), false, 'and the drop is a valid one');
  dispatch(dom.body, 'pointerup', { ...EMPTY_POINT, pointerId: 21 });

  assert.deepEqual(shapeOf(st.state.views[0] ?? null), ['*web/src/Pane.tsx']);
  assert.equal(st.state.activeViewId, 'home');
});

test('a TAB dropped on the EMPTY pane area of Home merges its panes into Home', () => {
  st.state.views = [
    view({ id: 'home', root: { kind: 'home' }, slots: [] }),
    view({
      id: 'v1',
      root: null,
      slots: [{ kind: 'session', id: 's1' }, { kind: 'session', id: 's2' }],
    }),
  ];
  st.state.activeViewId = 'home';
  paint();
  spec = { kind: 'tab', viewId: 'v1', label: 'two' };

  dispatch(sourceRow, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 22 });
  dispatch(dom.body, 'pointermove', { ...EMPTY_POINT, pointerId: 22 });
  assert.equal(emptyBox()?.classList.contains('is-drop'), true, 'merge = fill: the box lights up');
  dispatch(dom.body, 'pointerup', { ...EMPTY_POINT, pointerId: 22 });

  assert.deepEqual(st.state.views[0]?.slots, [
    { kind: 'session', id: 's1' },
    { kind: 'session', id: 's2' },
  ]);
  assert.equal(st.state.views.length, 1, 'the source tab was absorbed');
});

// ===========================================================================
// The HTML5 channel stays free (A9/B10)
// ===========================================================================

test('no `draggable` attribute exists anywhere in web/src — in-app drags are pointer drags', () => {
  // The window's own dragover/drop belongs to REAL files dragged in from
  // Explorer (parts A9/B10). An in-app source that opted into HTML5 DnD would
  // fire those handlers with nothing useful in the DataTransfer.
  const root = join(projectRoot, 'web', 'src');
  const files = filesUnder(root, /\.(ts|html|css)$/);
  assert.ok(files.length >= 20, `non-vacuity: scanned ${files.length} files`);
  // The ATTRIBUTE, not the English word: the two files that explain why there
  // is no HTML5 drag channel say `draggable` in prose, and must keep saying it.
  const ATTR = /draggable\s*=|['"]draggable['"]/;
  const offenders = files.filter((f) => ATTR.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => f.slice(root.length + 1)), []);
});
