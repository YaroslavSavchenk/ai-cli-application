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
 *      HTML5 drop channel belongs to real files from Explorer (A9/B10);
 *   6. A10b's FOURTH source, a file-tab CHIP of an editor pane's strip: an edge
 *      splits it off, another editor pane's centre takes it over, a terminal's
 *      centre refuses it, and the three gestures that were NOT built (its own
 *      pane, a strip, the bottom tab strip) light nothing at all.
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
const SL = (await import(new URL('../web/src/ui/statusline.ts', import.meta.url).href)) as StatuslineModule;

type EditorTab = { kind: 'file'; path: string } | { kind: 'diff'; hash: string; path: string };
/** The A10b slot model: a session, or an EDITOR pane holding a strip of tabs. */
type PaneSlot =
  | { kind: 'session'; id: string }
  | { kind: 'editor'; id: string; tabs: EditorTab[]; active: number };
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
  slotTabIds(slot: PaneSlot): string[];
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
  newEditorSlot(tabs: EditorTab[]): PaneSlot;
  slotKey(s: PaneSlot): string;
}
interface StatuslineModule {
  initStatusline(container: unknown, deps: { openShortcuts(): void }): { render(): void };
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
/** One chip of an editor pane's strip, as ui/editor-pane.ts draws it (26px). */
const CHIP_W = 120;
const CHIP_H = 26;
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

/**
 * A stand-in for ONE chip of an editor pane's strip — the fourth drag source
 * (ui/editor-pane.ts arms the real one the same way). It lives outside the
 * grid on purpose: what it is over decides the target, what it IS decides only
 * which element recedes while the drag is in flight.
 */
const sourceChip = dom.doc.createElement('div');
sourceChip.className = 'pane-tab';
dom.body.append(sourceChip);
let chipSpec: Record<string, unknown> | null = null;
DND.armDrag(sourceChip, '.pane-x', () => chipSpec);

/**
 * The REAL statusline, mounted on a host of its own: a refusal is a SENTENCE
 * the user reads, and the only way to read it back is where it is drawn.
 * (`tests/fake-dom.ts` records `setTimeout` instead of firing it, so a flash
 * stays up until `clearFlash()` runs the timer by hand.)
 */
const statusHost = dom.doc.createElement('div');
dom.body.append(statusHost);
SL.initStatusline(statusHost, { openShortcuts: () => {} });

function flashText(): string {
  return byClass(statusHost, 'status-flash')[0]?.textContent ?? '';
}

/** Run every recorded timer, which is what takes the flash back down. */
function clearFlash(): void {
  const due = [...dom.win.timers];
  dom.win.timers.length = 0;
  for (const t of due) t.fn();
}

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
  v.slots.forEach((slot, i) => {
    const pane = dom.doc.createElement('section');
    pane.className = 'pane';
    pane.dataset.slot = String(i);
    pane.setAttribute('data-slot', String(i));
    setRect(pane, { left: i * PANE_W, top: GRID_TOP, width: PANE_W, height: PANE_H });
    // What ui/editor-pane.ts puts in the header of an editor pane: the chip
    // strip, across the top 26px of the card. It is hit-tested here because
    // dropping a tab on a strip is one of the gestures that must light nothing.
    if (slot.kind === 'editor') {
      const tabsEl = dom.doc.createElement('div');
      tabsEl.className = 'pane-tabs';
      setRect(tabsEl, { left: i * PANE_W, top: GRID_TOP, width: PANE_W, height: CHIP_H });
      slot.tabs.forEach((_t, j) => {
        const chip = dom.doc.createElement('div');
        chip.className = 'pane-tab';
        setRect(chip, { left: i * PANE_W + j * CHIP_W, top: GRID_TOP, width: CHIP_W, height: CHIP_H });
        tabsEl.append(chip);
      });
      pane.append(tabsEl);
    }
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

/** An editor pane holding these files, in strip order, the first one active. */
function ed(...paths: string[]): PaneSlot {
  return st.newEditorSlot(paths.map((path) => ({ kind: 'file', path })));
}

/** One tab, as the picture below spells it. */
function tabName(t: EditorTab): string {
  return t.kind === 'file' ? t.path : `${t.hash}:${t.path}`;
}

/**
 * A view's panes as one readable picture: a session id, or an editor pane's
 * tabs in strip order with the ACTIVE one starred. The pane's own `e:<n>` is
 * generated and deliberately not part of it — every assertion here is about
 * which pane holds which tab, never about the counter.
 */
function shapeOf(v: ViewLike | null): string[] {
  if (v === null) return [];
  return v.slots.map((s) =>
    s.kind === 'session'
      ? `session ${s.id}`
      : s.tabs.map((t, i) => (i === s.active ? `*${tabName(t)}` : tabName(t))).join(' '),
  );
}

/** The centre of chip `j` in the strip of pane `i`. */
function chipIn(i: number, j: number): { x: number; y: number } {
  return { x: i * PANE_W + j * CHIP_W + CHIP_W / 2, y: GRID_TOP + CHIP_H / 2 };
}

/** A point inside pane `i`'s TOP edge band, below its strip. */
function topEdgeOf(i: number): { x: number; y: number } {
  return { x: i * PANE_W + PANE_W / 2, y: GRID_TOP + PANE_H * 0.1 };
}

/** The spec one chip of pane `slot`'s strip carries (ui/editor-pane.ts fileTabSpec). */
function tabSpec(viewId: string, slot: number, tab: number): Record<string, unknown> {
  const v = st.state.views.find((x) => x.id === viewId) as ViewLike;
  const pane = v.slots[slot] as PaneSlot & { kind: 'editor' };
  const t = pane.tabs[tab] as EditorTab;
  return {
    kind: 'filetab',
    viewId,
    slot,
    slotKey: st.slotKey(pane),
    tab,
    tabId: t.kind === 'file' ? `f:${t.path}` : `d:${t.hash}:${t.path}`,
    label: t.kind === 'file' ? (t.path.split('/').pop() as string) : `Changes in ${t.hash}`,
  };
}

beforeEach(() => {
  st.state.sessions = new Map([['s1', mkSession('s1')], ['s2', mkSession('s2')]]);
  st.state.projects = [];
  st.state.history = [];
  st.state.views = [];
  st.state.activeViewId = '';
  spec = null;
  chipSpec = null;
  clearFlash();
  for (const n of byClass(dom.body, 'drag-ghost')) n.remove();
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

test('a finished drag swallows the click that follows it', async () => {
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
  // WAITS ON THE CLOCK `dnd.ts` READS. The swallow is `Date.now() + 80`, and a
  // timer is scheduled on the MONOTONIC clock — the two can disagree by a few
  // milliseconds on this host, which made a single `setTimeout(90)` return
  // while `Date.now()` still said the window was open (observed once in a full
  // `npm run test:ui`, 2026-09-16). Turning the wait into a poll of the same
  // clock the code under test uses removes the race instead of widening it.
  const open = Date.now() + 100;
  while (Date.now() < open) await new Promise((r) => setTimeout(r, 10));
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

test('an EDITOR pane cannot be extracted to its own tab, and cannot be moved into another', async () => {
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

  assert.deepEqual(shapeOf(st.state.views[0] ?? null), ['*web/src/Pane.tsx']);
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
