/**
 * Shared setup for `tests/ui/ui-dnd-a10*.test.ts` (Nocturne parts A10, A10b):
 * the DOM double installed at import, the REAL `web/src/state.ts`,
 * `web/src/ui/dnd.ts` and `web/src/ui/statusline.ts` imported after it, and a
 * shell just real enough to hit-test — a tab strip, a grid, four pane boxes,
 * the two drag-source stand-ins (a Files-panel row, an editor pane's chip) and
 * the real statusline for refusal sentences — plus the gesture and picture
 * helpers. Not a test.
 *
 * Each test file arms the two sources itself (`DND.armDrag`) over its own
 * `spec` / `chipSpec`, which its tests reassign, and calls `resetShell()` in
 * its `beforeEach`.
 */
import type { SessionInfo } from '../../shared/protocol.ts';
import { byClass, dispatch, installDom, setRect, type FakeElement } from './fake-dom.ts';

export const dom = installDom();

export const st = (await import(new URL('../../web/src/state.ts', import.meta.url).href)) as StateModule;
export const DND = (await import(new URL('../../web/src/ui/dnd.ts', import.meta.url).href)) as DndModule;
export const SL = (await import(new URL('../../web/src/ui/statusline.ts', import.meta.url).href)) as StatuslineModule;

/**
 * The clock `dnd.ts` measures its post-drag click swallow on, owned by the
 * tests (`setClickSwallowClock`): a test steps it with `advanceClickClock`
 * instead of sleeping through the 80 ms window in real time, and
 * `resetShell` steps it past any window a previous test left open.
 */
let clickClock = 0;
DND.setClickSwallowClock(() => clickClock);

/** Move the swallow's clock forward by `ms`. */
export function advanceClickClock(ms: number): void {
  clickClock += ms;
}

export type EditorTab = { kind: 'file'; path: string } | { kind: 'diff'; hash: string; path: string };
/** The A10b slot model: a session, or an EDITOR pane holding a strip of tabs. */
export type PaneSlot =
  | { kind: 'session'; id: string }
  | { kind: 'editor'; id: string; tabs: EditorTab[]; active: number };
export type ViewRoot = { kind: 'home' } | { kind: 'project'; id: string };
export interface ViewLike {
  id: string;
  root: ViewRoot | null;
  slots: PaneSlot[];
  focused: number;
  l3: 'L' | 'R';
  split: { col: number; row: number };
}

export interface StateModule {
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
export interface StatuslineModule {
  initStatusline(container: unknown, deps: { openShortcuts(): void }): { render(): void };
}
export interface DndModule {
  armDrag(
    source: unknown,
    ignore: string | null,
    makeSpec: () => Record<string, unknown> | null,
  ): void;
  CLICK_SWALLOW_MS: number;
  setClickSwallowClock(now: () => number): void;
  ghostTransform(x: number, y: number): string;
}

// ---------------------------------------------------------------------------
// A shell just real enough to hit-test: a tab strip, a grid, four pane boxes.
// ---------------------------------------------------------------------------

export const PANE_W = 400;
export const PANE_H = 300;
/** One chip of an editor pane's strip, as ui/editor-pane.ts draws it (26px). */
export const CHIP_W = 120;
export const CHIP_H = 26;
/** Pane N occupies x in [N*400, N*400+400), y in [100, 400). */
export const GRID_TOP = 100;

export const strip = dom.doc.createElement('div');
strip.className = 'tabstrip';
setRect(strip, { left: 0, top: 0, width: 1600, height: 40 });
export const grid = dom.doc.createElement('div');
grid.className = 'grid';
setRect(grid, { left: 0, top: GRID_TOP, width: 1600, height: PANE_H });
dom.body.append(strip, grid);

/** The element a drag is armed on — a stand-in for a Files-panel row. */
export const sourceRow = dom.doc.createElement('button');
dom.body.append(sourceRow);

/**
 * A stand-in for ONE chip of an editor pane's strip — the fourth drag source
 * (ui/editor-pane.ts arms the real one the same way). It lives outside the
 * grid on purpose: what it is over decides the target, what it IS decides only
 * which element recedes while the drag is in flight.
 */
export const sourceChip = dom.doc.createElement('div');
sourceChip.className = 'pane-tab';
dom.body.append(sourceChip);

/**
 * The REAL statusline, mounted on a host of its own: a refusal is a SENTENCE
 * the user reads, and the only way to read it back is where it is drawn.
 * (`tests/helpers/fake-dom.ts` records `setTimeout` instead of firing it, so a flash
 * stays up until `clearFlash()` runs the timer by hand.)
 */
export const statusHost = dom.doc.createElement('div');
dom.body.append(statusHost);
SL.initStatusline(statusHost, { openShortcuts: () => {} });

export function flashText(): string {
  return byClass(statusHost, 'status-flash')[0]?.textContent ?? '';
}

/** Run every recorded timer, which is what takes the flash back down. */
export function clearFlash(): void {
  const due = [...dom.win.timers];
  dom.win.timers.length = 0;
  for (const t of due) t.fn();
}

/** Rebuild the strip's chips from `state.views`, in order. */
export function renderStrip(): void {
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
export function renderGrid(): void {
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

export function paint(): void {
  renderStrip();
  renderGrid();
}

/** Centre of pane `i`. */
export function centreOf(i: number): { x: number; y: number } {
  return { x: i * PANE_W + PANE_W / 2, y: GRID_TOP + PANE_H / 2 };
}
/** A point inside pane `i`'s LEFT edge band (outer quarter). */
export function leftEdgeOf(i: number): { x: number; y: number } {
  return { x: i * PANE_W + 10, y: GRID_TOP + PANE_H / 2 };
}
/** The centre of the chip of view `id`. */
export function chipOf(id: string): { x: number; y: number } {
  const i = st.state.views.findIndex((v) => v.id === id);
  return { x: i * 120 + 60, y: 20 };
}

/**
 * One whole gesture: press on the armed source, move (past the 5px threshold)
 * to the point, release. Returns the drop overlay that was lit, if any.
 */
export function dragTo(p: { x: number; y: number }, opts: { cancel?: boolean } = {}): FakeElement | null {
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
export function emptyBox(): FakeElement | null {
  return byClass(grid, 'empty-state')[0] ?? null;
}

/** A point in the middle of the empty pane area, as a pointer event carries it. */
export const EMPTY_POINT = { clientX: 800, clientY: GRID_TOP + PANE_H / 2 };

/** The ghost element while a drag is in flight. */
export function ghost(): FakeElement | null {
  return byClass(dom.body, 'drag-ghost')[0] ?? null;
}

export function mkSession(id: string): SessionInfo {
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

export function view(over: Partial<ViewLike>): ViewLike {
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

export const FILE_SPEC = { kind: 'file', path: 'web/src/Pane.tsx', label: 'Pane.tsx' };

/** An editor pane holding these files, in strip order, the first one active. */
export function ed(...paths: string[]): PaneSlot {
  return st.newEditorSlot(paths.map((path) => ({ kind: 'file', path })));
}

/** One tab, as the picture below spells it. */
export function tabName(t: EditorTab): string {
  return t.kind === 'file' ? t.path : `${t.hash}:${t.path}`;
}

/**
 * A view's panes as one readable picture: a session id, or an editor pane's
 * tabs in strip order with the ACTIVE one starred. The pane's own `e:<n>` is
 * generated and deliberately not part of it — every assertion here is about
 * which pane holds which tab, never about the counter.
 */
export function shapeOf(v: ViewLike | null): string[] {
  if (v === null) return [];
  return v.slots.map((s) =>
    s.kind === 'session'
      ? `session ${s.id}`
      : s.tabs.map((t, i) => (i === s.active ? `*${tabName(t)}` : tabName(t))).join(' '),
  );
}

/** The centre of chip `j` in the strip of pane `i`. */
export function chipIn(i: number, j: number): { x: number; y: number } {
  return { x: i * PANE_W + j * CHIP_W + CHIP_W / 2, y: GRID_TOP + CHIP_H / 2 };
}

/** A point inside pane `i`'s TOP edge band, below its strip. */
export function topEdgeOf(i: number): { x: number; y: number } {
  return { x: i * PANE_W + PANE_W / 2, y: GRID_TOP + PANE_H * 0.1 };
}

/** The spec one chip of pane `slot`'s strip carries (ui/editor-pane.ts fileTabSpec). */
export function tabSpec(viewId: string, slot: number, tab: number): Record<string, unknown> {
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

/** The world every test starts from — each file's `beforeEach` calls it. */
export function resetShell(): void {
  st.state.sessions = new Map([['s1', mkSession('s1')], ['s2', mkSession('s2')]]);
  st.state.projects = [];
  st.state.history = [];
  st.state.views = [];
  st.state.activeViewId = '';
  clearFlash();
  for (const n of byClass(dom.body, 'drag-ghost')) n.remove();
  // No test inherits the click swallow of the drag that ended the last one.
  advanceClickClock(DND.CLICK_SWALLOW_MS);
}
