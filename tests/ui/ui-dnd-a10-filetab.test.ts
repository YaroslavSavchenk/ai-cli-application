/**
 * `web/src/ui/dnd.ts` — A10b's FOURTH drag source, a file-tab CHIP of an
 * editor pane's strip, driven through the REAL module on the DOM double
 * against the REAL `web/src/state.ts` (shared shell:
 * `tests/helpers/ui-dnd-a10-fixture.ts`). Split from
 * `tests/ui/ui-dnd-a10.test.ts`.
 *
 * What: an edge splits it off, another editor pane's centre takes it over, a
 * terminal's centre refuses it, a full pane refuses a move (a move never
 * evicts, B4 amendment), a stale spec resolves to nothing, and the three
 * gestures that were NOT built (its own pane, a strip, the bottom tab strip)
 * light nothing at all. Each gesture is LOOKED at while still in flight,
 * because half of what this source promises is what the screen says before
 * the button comes up.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * real layout, the ghost's transform, CSS, that a split actually reflows a PTY.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { byClass, dispatch, type FakeElement } from '../helpers/fake-dom.ts';
import {
  dom,
  st,
  DND,
  type ViewLike,
  grid,
  sourceRow,
  sourceChip,
  flashText,
  paint,
  centreOf,
  leftEdgeOf,
  chipOf,
  ghost,
  view,
  ed,
  shapeOf,
  chipIn,
  topEdgeOf,
  tabSpec,
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
// A FILE TAB (one chip of an editor pane's strip) — Nocturne A10b
// ===========================================================================

/**
 * One whole chip gesture: press on the chip, move to the point, LOOK, release.
 * The look happens while the drag is still in flight, because half of what
 * this source promises is what the screen says before the button comes up.
 */
function chipDragTo(
  p: { x: number; y: number },
  pointerId: number,
): { lit: FakeElement | null; zone: string | undefined; label: string; invalid: boolean; marks: number } {
  dispatch(sourceChip, 'pointerdown', { clientX: 0, clientY: 0, pointerId });
  dispatch(dom.body, 'pointermove', { clientX: p.x, clientY: p.y, pointerId });
  const lit = byClass(grid, 'pane-drop').find((n) => !n.hidden) ?? null;
  const out = {
    lit,
    zone: lit?.dataset.zone,
    label: lit === null ? '' : byClass(lit, 'pane-drop-lb')[0]?.textContent ?? '',
    invalid: ghost()?.classList.contains('is-invalid') === true,
    marks:
      byClass(dom.body, 'is-drop').length +
      byClass(dom.body, 'is-insert-before').length +
      byClass(dom.body, 'is-drop-target').length,
  };
  dispatch(dom.body, 'pointerup', { clientX: p.x, clientY: p.y, pointerId });
  return out;
}

test('a file tab dropped on a pane EDGE leaves for a NEW editor pane there', () => {
  // User decision 2, A10b: this is the ONE gesture that makes a split.
  st.state.views = [
    view({ id: 'v1', root: { kind: 'home' }, slots: [ed('a.ts', 'b.ts')] }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  chipSpec = tabSpec('v1', 0, 1);

  const r = chipDragTo(leftEdgeOf(0), 41);
  assert.equal(r.zone, 'left', 'the outer quarter is a SPLIT');
  assert.equal(r.label, 'Open beside');
  assert.equal(r.invalid, false);
  assert.deepEqual(shapeOf(st.activeView()), ['*b.ts', '*a.ts'],
    'the tab left for a pane of its own, and the strip it came from kept the rest');
  assert.equal((st.activeView() as ViewLike).focused, 0, 'focus follows the tab to the new pane');
});

test('the LAST tab of a pane leaving costs no pane: the source pane goes with it', () => {
  st.state.views = [
    view({
      id: 'v1',
      root: { kind: 'home' },
      slots: [ed('only.ts'), { kind: 'session', id: 's1' }],
    }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  chipSpec = tabSpec('v1', 0, 0);

  // Pane 1's own bands: a 2-pane tab splits top/bottom — but the source pane
  // is about to disappear, so the drop is measured on the 1-pane view it
  // leaves behind, whose bands are left/right. The picture and the model must
  // agree, or a lit box would end in a refusal.
  const r = chipDragTo(leftEdgeOf(1), 42);
  assert.equal(r.zone, 'left', 'the zones are the ones the DROP will have, not the ones it had');
  assert.deepEqual(shapeOf(st.activeView()), ['*only.ts', 'session s1']);
  assert.equal((st.activeView() as ViewLike).slots.length, 2, 'still two panes: one left, one arrived');
  assert.equal(flashText(), '', 'a drop that lit a box never explains itself afterwards');
});

test('a file tab dropped on the centre of ANOTHER editor pane MOVES there, and the WHOLE pane lights up', () => {
  st.state.views = [
    view({ id: 'v1', root: { kind: 'home' }, slots: [ed('a.ts', 'b.ts'), ed('c.ts')] }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  chipSpec = tabSpec('v1', 0, 0);

  const r = chipDragTo(centreOf(1), 43);
  assert.notEqual(r.lit, null, 'the target pane lights up');
  assert.equal(r.zone, undefined, 'NO data-zone: the box covers the whole card, like A9\'s file drop');
  assert.equal(r.label, 'Move it here');
  assert.deepEqual(shapeOf(st.activeView()), ['*b.ts', 'c.ts *a.ts'],
    'the tab joined the other strip, and is the one showing there');
  assert.equal((st.activeView() as ViewLike).slots.length, 2, 'a move makes no pane');
});

test('the centre of a TERMINAL pane refuses a file tab, with the sentence a file ROW gets', () => {
  st.state.views = [
    view({
      id: 'v1',
      root: { kind: 'home' },
      slots: [ed('a.ts', 'b.ts'), { kind: 'session', id: 's1' }],
    }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  chipSpec = tabSpec('v1', 0, 0);

  const r = chipDragTo(centreOf(1), 44);
  assert.equal(r.lit, null, 'no box: a box would promise the terminal is about to change');
  assert.equal(r.invalid, true, 'the ghost says no');
  assert.equal(r.marks, 0);
  assert.equal(flashText(), 'A terminal pane cannot hold files. Drop on an edge to split.');
  assert.deepEqual(shapeOf(st.activeView()), ['*a.ts b.ts', 'session s1'], 'nothing moved');
});

test('a file tab dropped on a FULL editor pane is REFUSED: a move never evicts (B4 amendment)', () => {
  // The user asked for four files per pane (2026-09-22). An OPEN evicts the
  // last chip to make room; a MOVE says so and changes nothing — the chip it
  // would throw out is one the user put there, and this gesture names none.
  st.state.views = [
    view({
      id: 'v1',
      root: { kind: 'home' },
      slots: [ed('a.ts', 'b.ts'), ed('c.ts', 'd.ts', 'e.ts', 'f.ts')],
    }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  chipSpec = tabSpec('v1', 0, 0);

  const r = chipDragTo(centreOf(1), 46);
  assert.equal(r.lit, null, 'no box: nothing is about to change in that pane');
  assert.equal(r.invalid, true, 'the ghost says no while the pointer is over it');
  assert.equal(r.marks, 0);
  assert.equal(flashText(), 'This pane already holds 4 files.');
  assert.deepEqual(
    shapeOf(st.activeView()),
    ['*a.ts b.ts', '*c.ts d.ts e.ts f.ts'],
    'nothing moved, and nothing was thrown out',
  );
});

test('a file tab the FULL pane already shows is still taken: a raise costs no room', () => {
  st.state.views = [
    view({
      id: 'v1',
      root: { kind: 'home' },
      slots: [ed('a.ts', 'b.ts'), ed('b.ts', 'd.ts', 'e.ts', 'f.ts')],
    }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  chipSpec = tabSpec('v1', 0, 1);

  const r = chipDragTo(centreOf(1), 47);
  assert.notEqual(r.lit, null, 'the pane lights up: it really takes it');
  assert.equal(flashText(), '');
  assert.deepEqual(
    shapeOf(st.activeView()),
    ['*a.ts', '*b.ts d.ts e.ts f.ts'],
    'the tab left the source and was raised where it already was',
  );
});

test('its OWN pane, a strip, a chip and the bottom tab strip are not targets — and light nothing', () => {
  // Three gestures that were deliberately not built (orchestrator default 4,
  // A10b): reordering a strip, dropping a tab on a strip, and giving a tab its
  // own tab. A target that lit up for them would promise an act that does not
  // exist.
  st.state.views = [
    view({ id: 'home', root: { kind: 'home' }, slots: [] }),
    view({ id: 'v1', root: { kind: 'home' }, slots: [ed('a.ts', 'b.ts'), ed('c.ts')] }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  const before = shapeOf(st.activeView());

  let pid = 50;
  for (const [what, point] of [
    ['its own pane\'s centre', centreOf(0)],
    ['its own strip', chipIn(0, 0)],
    ['another chip in its own strip', chipIn(0, 1)],
    ['the other pane\'s strip', chipIn(1, 0)],
    ['the bottom tab strip', { x: 900, y: 20 }],
    ['another tab\'s chip', chipOf('home')],
  ] as [string, { x: number; y: number }][]) {
    chipSpec = tabSpec('v1', 0, 0);
    pid += 1;
    const r = chipDragTo(point, pid);
    assert.equal(r.lit, null, `${what} must light no box`);
    assert.equal(r.invalid, false, `${what} must not even turn the ghost invalid`);
    assert.equal(r.marks, 0, `${what} must mark nothing`);
    assert.deepEqual(shapeOf(st.activeView()), before, `${what} must change nothing`);
    assert.equal(flashText(), '', `${what} says nothing: nothing was refused`);
  }
});

test('a FULL tab refuses an edge split for a tab whose pane stays, and says the capacity sentence', () => {
  st.state.views = [
    view({
      id: 'v1',
      root: { kind: 'home' },
      slots: [ed('a.ts', 'b.ts'), { kind: 'session', id: 's1' }, { kind: 'session', id: 's2' }, ed('d.ts')],
    }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  chipSpec = tabSpec('v1', 0, 0);

  const r = chipDragTo(topEdgeOf(1), 60);
  assert.equal(r.lit, null, 'a fifth pane cannot be promised');
  assert.equal(r.invalid, true);
  assert.equal(flashText(), 'This tab is full. It can show 4 panes.');
  assert.deepEqual(shapeOf(st.activeView())[0], '*a.ts b.ts', 'the strip is untouched');
});

test('a stale chip spec resolves to nothing: no visuals, no move', () => {
  // The strip was rebuilt under the drag (the tab was closed, or the pane
  // was). Both indices in the spec still point at something — which is exactly
  // why the spec is resolved by KEY and by TAB ID instead.
  st.state.views = [
    view({ id: 'v1', root: { kind: 'home' }, slots: [ed('a.ts', 'b.ts'), ed('c.ts')] }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  const stale = tabSpec('v1', 0, 0);
  stale.tabId = 'f:gone.ts';
  chipSpec = stale;
  const r = chipDragTo(centreOf(1), 61);
  assert.equal(r.lit, null);
  assert.equal(r.invalid, false);
  assert.equal(r.marks, 0, 'not a chip, not a strip, not a pane outline: NOTHING lights up');
  assert.deepEqual(shapeOf(st.activeView()), ['*a.ts b.ts', '*c.ts']);

  // Same gesture, same pane, but the PANE's key is the stranger.
  const stale2 = tabSpec('v1', 0, 0);
  stale2.slotKey = 'e:999';
  chipSpec = stale2;
  const r2 = chipDragTo(centreOf(1), 62);
  assert.equal(r2.lit, null);
  assert.equal(r2.invalid, false, 'a gesture about nothing is not a refusal either');
  assert.equal(r2.marks, 0);
  assert.deepEqual(shapeOf(st.activeView()), ['*a.ts b.ts', '*c.ts']);
});

test('a dragged chip recedes — and its PANE does not: the pane is not going anywhere', () => {
  st.state.views = [
    view({ id: 'v1', root: { kind: 'home' }, slots: [ed('a.ts', 'b.ts'), ed('c.ts')] }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  chipSpec = tabSpec('v1', 0, 0);

  dispatch(sourceChip, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 63 });
  assert.equal(sourceChip.classList.contains('is-dragging'), false, 'not yet: 0px is not a drag');
  const c = centreOf(1);
  dispatch(dom.body, 'pointermove', { clientX: c.x, clientY: c.y, pointerId: 63 });
  assert.equal(sourceChip.classList.contains('is-dragging'), true, 'the chip recedes');
  assert.equal(byClass(grid, 'pane').some((n) => n.classList.contains('is-dragging')), false,
    'no pane recedes: only a file is moving');
  assert.equal(byClass(dom.body, 'drag-ghost')[0]?.textContent, 'a.ts', 'the ghost carries the NAME');
  dispatch(dom.body, 'pointerup', { clientX: c.x, clientY: c.y, pointerId: 63 });
  assert.equal(sourceChip.classList.contains('is-dragging'), false);
});
