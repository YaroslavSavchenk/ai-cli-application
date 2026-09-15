/**
 * `web/src/ui/dnd.ts` — the pointer drag layer, driven through the REAL module
 * on the DOM double in `tests/fake-dom.ts`, against the REAL `web/src/state.ts`.
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
 *   3. Escape cancels, and a finished drag swallows its click;
 *   4. `Home` is never a tab-drag source and no strip position before it is
 *      ever a drop target (user decision 4, 2026-09-15);
 *   5. no `draggable` attribute exists anywhere in `web/src` — the window's
 *      HTML5 drop channel belongs to real files from Explorer (A9/B10).
 *
 * The PURE geometry (`zoneForPoint`, the 0.25 edge band) is pinned in
 * `tests/ui-slots-model.test.ts` and deliberately not repeated here; this file
 * asks whether the drag layer feeds it the right rectangle and does the right
 * thing with its answer.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * real layout, the ghost's transform, CSS, that a split actually reflows a PTY.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionInfo } from '../shared/protocol.ts';
import { byClass, dispatch, installDom, setRect, type FakeElement } from './fake-dom.ts';

const dom = installDom();

const here = dirname(fileURLToPath(import.meta.url));
const st = (await import(new URL('../web/src/state.ts', import.meta.url).href)) as StateModule;
const DND = (await import(new URL('../web/src/ui/dnd.ts', import.meta.url).href)) as DndModule;

type PaneSlot =
  | { kind: 'session'; id: string }
  | { kind: 'file'; path: string }
  | { kind: 'diff'; hash: string; path: string };
type ViewRoot = { kind: 'home' } | { kind: 'project'; id: string };
interface ViewLike {
  id: string;
  root: ViewRoot | null;
  slots: PaneSlot[];
  focused: number;
  l3: 'L' | 'R';
  split: { col: number; row: number };
}

interface StateModule {
  state: {
    sessions: Map<string, SessionInfo>;
    projects: unknown[];
    views: ViewLike[];
    activeViewId: string;
    history: unknown[];
  };
  MAX_PANES: number;
  activeView(): ViewLike | null;
  subscribe(fn: (kind: string) => void): void;
}
interface DndModule {
  armDrag(
    source: unknown,
    ignore: string | null,
    makeSpec: () => Record<string, unknown> | null,
  ): void;
}

// ---------------------------------------------------------------------------
// A shell just real enough to hit-test: a tab strip, a grid, four pane boxes.
// ---------------------------------------------------------------------------

const PANE_W = 400;
const PANE_H = 300;
/** Pane N occupies x in [N*400, N*400+400), y in [100, 400). */
const GRID_TOP = 100;

const strip = dom.doc.createElement('div');
strip.className = 'tabstrip';
setRect(strip, { left: 0, top: 0, width: 1600, height: 40 });
const grid = dom.doc.createElement('div');
grid.className = 'grid';
setRect(grid, { left: 0, top: GRID_TOP, width: 1600, height: PANE_H });
dom.body.append(strip, grid);

/** The element a drag is armed on — a stand-in for a Files-panel row. */
const sourceRow = dom.doc.createElement('button');
dom.body.append(sourceRow);

let spec: Record<string, unknown> | null = null;
DND.armDrag(sourceRow, null, () => spec);

/** Rebuild the strip's chips from `state.views`, in order. */
function renderStrip(): void {
  strip.replaceChildren();
  st.state.views.forEach((v, i) => {
    const chip = dom.doc.createElement('div');
    chip.className = 'tab';
    chip.dataset.viewId = v.id;
    chip.setAttribute('data-view-id', v.id);
    setRect(chip, { left: i * 120, top: 0, width: 120, height: 40 });
    strip.append(chip);
  });
}

/** Rebuild the grid's panes from the ACTIVE view, one 400x300 box each. */
function renderGrid(): void {
  grid.replaceChildren();
  const v = st.activeView();
  if (v === null) return;
  if (v.slots.length === 0) {
    // What ui/panes.ts renderEmpty() draws: ONE `.empty-state` box filling the
    // grid, and no `.pane` at all — so a drop there has nothing else to hit.
    const box = dom.doc.createElement('div');
    box.className = 'empty-state';
    setRect(box, { left: 0, top: GRID_TOP, width: 1600, height: PANE_H });
    grid.append(box);
    return;
  }
  v.slots.forEach((_, i) => {
    const pane = dom.doc.createElement('section');
    pane.className = 'pane';
    pane.dataset.slot = String(i);
    pane.setAttribute('data-slot', String(i));
    setRect(pane, { left: i * PANE_W, top: GRID_TOP, width: PANE_W, height: PANE_H });
    const drop = dom.doc.createElement('div');
    drop.className = 'pane-drop';
    drop.hidden = true;
    const box = dom.doc.createElement('div');
    box.className = 'pane-drop-box';
    const lb = dom.doc.createElement('span');
    lb.className = 'pane-drop-lb';
    box.append(lb);
    drop.append(box);
    pane.append(drop);
    grid.append(pane);
  });
}

function paint(): void {
  renderStrip();
  renderGrid();
}

/** Centre of pane `i`. */
function centreOf(i: number): { x: number; y: number } {
  return { x: i * PANE_W + PANE_W / 2, y: GRID_TOP + PANE_H / 2 };
}
/** A point inside pane `i`'s LEFT edge band (outer quarter). */
function leftEdgeOf(i: number): { x: number; y: number } {
  return { x: i * PANE_W + 10, y: GRID_TOP + PANE_H / 2 };
}
/** The centre of the chip of view `id`. */
function chipOf(id: string): { x: number; y: number } {
  const i = st.state.views.findIndex((v) => v.id === id);
  return { x: i * 120 + 60, y: 20 };
}

/**
 * One whole gesture: press on the armed source, move (past the 5px threshold)
 * to the point, release. Returns the drop overlay that was lit, if any.
 */
function dragTo(p: { x: number; y: number }, opts: { cancel?: boolean } = {}): FakeElement | null {
  dispatch(sourceRow, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 9 });
  dispatch(dom.body, 'pointermove', { clientX: p.x, clientY: p.y, pointerId: 9 });
  const lit = byClass(grid, 'pane-drop').find((n) => !n.hidden) ?? null;
  if (opts.cancel === true) {
    dispatch(dom.body, 'keydown', { key: 'Escape' });
    return lit;
  }
  dispatch(dom.body, 'pointerup', { clientX: p.x, clientY: p.y, pointerId: 9 });
  return lit;
}

/** The empty state of an empty tab, as ui/panes.ts draws it. */
function emptyBox(): FakeElement | null {
  return byClass(grid, 'empty-state')[0] ?? null;
}

/** A point in the middle of the empty pane area, as a pointer event carries it. */
const EMPTY_POINT = { clientX: 800, clientY: GRID_TOP + PANE_H / 2 };

/** The ghost element while a drag is in flight. */
function ghost(): FakeElement | null {
  return byClass(dom.body, 'drag-ghost')[0] ?? null;
}

function mkSession(id: string): SessionInfo {
  return {
    id,
    title: id,
    command: 'claude',
    args: [],
    cwd: '/tmp',
    status: 'running',
    cols: 80,
    rows: 24,
    createdAt: new Date().toISOString(),
    attention: false,
  } as SessionInfo;
}

function view(over: Partial<ViewLike>): ViewLike {
  return {
    id: 'v',
    root: null,
    slots: [],
    focused: 0,
    l3: 'L',
    split: { col: 0.5, row: 0.5 },
    ...over,
  };
}

const FILE_SPEC = { kind: 'file', path: 'web/src/Pane.tsx', label: 'Pane.tsx' };

beforeEach(() => {
  st.state.sessions = new Map([['s1', mkSession('s1')], ['s2', mkSession('s2')]]);
  st.state.projects = [];
  st.state.history = [];
  st.state.views = [];
  st.state.activeViewId = '';
  spec = null;
  for (const n of byClass(dom.body, 'drag-ghost')) n.remove();
});

// ===========================================================================
// A file row onto a pane
// ===========================================================================

test('non-vacuity: the harness really hit-tests — a pane centre resolves to that pane', () => {
  st.state.views = [view({ id: 'v1', root: { kind: 'home' }, slots: [{ kind: 'file', path: 'a.ts' }] })];
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

  assert.deepEqual((st.activeView() as ViewLike).slots, [
    { kind: 'file', path: 'web/src/Pane.tsx' },
    { kind: 'session', id: 's1' },
  ]);
});

test('a file dropped on the CENTRE of a FILE pane replaces it', () => {
  st.state.views = [
    view({ id: 'v1', root: { kind: 'home' }, slots: [{ kind: 'file', path: 'old.ts' }] }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  spec = FILE_SPEC;

  const lit = dragTo(centreOf(0));
  assert.equal(lit?.dataset.zone, 'replace');
  assert.equal(byClass(lit as FakeElement, 'pane-drop-lb')[0]?.textContent, 'Open here');
  assert.deepEqual((st.activeView() as ViewLike).slots, [
    { kind: 'file', path: 'web/src/Pane.tsx' },
  ]);
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
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'dnd.ts'), 'utf8');
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
        { kind: 'file', path: 'a.ts' },
        { kind: 'file', path: 'b.ts' },
      ],
    }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  spec = FILE_SPEC;

  const before = [...(st.activeView() as ViewLike).slots];
  dispatch(sourceRow, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 5 });
  const p = leftEdgeOf(0);
  dispatch(dom.body, 'pointermove', { clientX: p.x, clientY: p.y, pointerId: 5 });
  assert.equal(ghost()?.classList.contains('is-invalid'), true, 'a full tab cannot take a 5th pane');
  dispatch(dom.body, 'pointerup', { clientX: p.x, clientY: p.y, pointerId: 5 });
  assert.deepEqual((st.activeView() as ViewLike).slots, before);
});

test('a full tab still takes a REPLACE on a file pane — replacing costs no pane', () => {
  st.state.views = [
    view({
      id: 'v1',
      root: { kind: 'home' },
      slots: [
        { kind: 'file', path: 'a.ts' },
        { kind: 'session', id: 's1' },
        { kind: 'session', id: 's2' },
        { kind: 'file', path: 'b.ts' },
      ],
    }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  spec = FILE_SPEC;

  dragTo(centreOf(0));
  assert.deepEqual((st.activeView() as ViewLike).slots[0], { kind: 'file', path: 'web/src/Pane.tsx' });
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

  assert.deepEqual(st.state.views[0]?.slots, [{ kind: 'file', path: 'web/src/Pane.tsx' }]);
  assert.equal(st.state.activeViewId, 'home', 'the file is on screen, so the app goes there');
});

test('a FULL folder tab chip refuses the file', () => {
  st.state.views = [
    view({
      id: 'home',
      root: { kind: 'home' },
      slots: [
        { kind: 'file', path: 'a.ts' },
        { kind: 'file', path: 'b.ts' },
        { kind: 'file', path: 'c.ts' },
        { kind: 'file', path: 'd.ts' },
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

test('Escape cancels the drag: no pane changes, no ghost, no visuals left behind', () => {
  st.state.views = [
    view({ id: 'v1', root: { kind: 'home' }, slots: [{ kind: 'file', path: 'old.ts' }] }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  spec = FILE_SPEC;

  const lit = dragTo(centreOf(0), { cancel: true });
  assert.notEqual(lit, null, 'non-vacuity: the target really was lit before Escape');
  assert.deepEqual((st.activeView() as ViewLike).slots, [{ kind: 'file', path: 'old.ts' }]);
  assert.equal(ghost(), null, 'the ghost goes with the cancel');
  assert.equal(
    byClass(grid, 'pane-drop').some((n) => !n.hidden),
    false,
    'and the overlay with it',
  );
});

test('a finished drag swallows the click that follows it', async () => {
  st.state.views = [
    view({ id: 'v1', root: { kind: 'home' }, slots: [{ kind: 'file', path: 'old.ts' }] }),
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

  // It is a short window, not a mode: 80ms later clicks work again.
  await new Promise((r) => setTimeout(r, 90));
  probe.click();
  assert.equal(clicks, 1);
  probe.remove();
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

test('no drop position before Home exists: dragging onto its LEFT edge targets nothing', async () => {
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
  await new Promise((r) => setTimeout(r, 90));
});

// ===========================================================================
// A pane drag: kind-blind swap, session-only extract / move
// ===========================================================================

test('a FILE pane swaps with a terminal pane like any other pane', () => {
  st.state.views = [
    view({
      id: 'v1',
      root: { kind: 'home' },
      slots: [{ kind: 'file', path: 'a.ts' }, { kind: 'session', id: 's1' }],
    }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  spec = { kind: 'pane', viewId: 'v1', slot: 0, slotKey: 'f:a.ts', label: 'a.ts' };

  dragTo(centreOf(1));
  assert.deepEqual((st.activeView() as ViewLike).slots, [
    { kind: 'session', id: 's1' },
    { kind: 'file', path: 'a.ts' },
  ]);
});

test('a FILE pane cannot be extracted to its own tab, and cannot be moved into another', async () => {
  // Decision 5, 2026-09-15: moving an open file to another tab was not asked
  // for. The two targets simply never light up for it.
  st.state.views = [
    view({ id: 'home', root: { kind: 'home' }, slots: [] }),
    view({
      id: 'v1',
      root: null,
      slots: [{ kind: 'file', path: 'a.ts' }, { kind: 'session', id: 's1' }],
    }),
  ];
  st.state.activeViewId = 'v1';
  paint();
  spec = { kind: 'pane', viewId: 'v1', slot: 0, slotKey: 'f:a.ts', label: 'a.ts' };

  // Onto the strip: an extract.
  dispatch(sourceRow, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 13 });
  dispatch(dom.body, 'pointermove', { clientX: 900, clientY: 20, pointerId: 13 });
  assert.equal(strip.classList.contains('is-drop'), false, 'the strip is not a target for a file');
  dispatch(dom.body, 'pointerup', { clientX: 900, clientY: 20, pointerId: 13 });
  assert.equal(st.state.views.length, 2, 'no new tab');

  await new Promise((r) => setTimeout(r, 90));

  // Onto the Home chip: a move-to-view.
  const target = chipOf('home');
  dispatch(sourceRow, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 14 });
  dispatch(dom.body, 'pointermove', { clientX: target.x, clientY: target.y, pointerId: 14 });
  assert.equal((strip.children[0] as FakeElement).classList.contains('is-drop'), false);
  dispatch(dom.body, 'pointerup', { clientX: target.x, clientY: target.y, pointerId: 14 });
  assert.deepEqual(st.state.views[0]?.slots, [], 'Home did not take the file');
  await new Promise((r) => setTimeout(r, 90));
});

test('a SESSION pane still extracts to its own tab — and never before Home', async () => {
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
  await new Promise((r) => setTimeout(r, 90));
});

// ===========================================================================
// The EMPTY pane area of an empty tab is a drop target (normally Home)
// ===========================================================================

test('a file dropped on the EMPTY pane area of Home opens there, and the BOX lights up', async () => {
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

  assert.deepEqual(st.state.views[0]?.slots, [{ kind: 'file', path: 'web/src/Pane.tsx' }]);
  assert.equal(st.state.activeViewId, 'home');
  await new Promise((r) => setTimeout(r, 90));
});

test('a TAB dropped on the EMPTY pane area of Home merges its panes into Home', async () => {
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
  await new Promise((r) => setTimeout(r, 90));
});

// ===========================================================================
// The HTML5 channel stays free (A9/B10)
// ===========================================================================

test('no `draggable` attribute exists anywhere in web/src — in-app drags are pointer drags', () => {
  // The window's own dragover/drop belongs to REAL files dragged in from
  // Explorer (parts A9/B10). An in-app source that opted into HTML5 DnD would
  // fire those handlers with nothing useful in the DataTransfer.
  const root = join(here, '..', 'web', 'src');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|html|css)$/.test(e.name)) files.push(full);
    }
  };
  walk(root);
  assert.ok(files.length >= 20, `non-vacuity: scanned ${files.length} files`);
  // The ATTRIBUTE, not the English word: the two files that explain why there
  // is no HTML5 drag channel say `draggable` in prose, and must keep saying it.
  const ATTR = /draggable\s*=|['"]draggable['"]/;
  const offenders = files.filter((f) => ATTR.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => f.slice(root.length + 1)), []);
});
