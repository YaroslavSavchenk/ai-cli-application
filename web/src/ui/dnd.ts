/**
 * Pointer-based drag & drop for tabs, pane headers and Files-panel rows.
 * HTML5 DnD is deliberately avoided: pointer events give a controlled ghost,
 * live hit-testing via elementFromPoint, Escape-cancel, and testability with
 * plain mouse input. The second reason (A10): parts A9/B10 need the window's
 * own HTML5 `dragover`/`drop` for REAL files dragged in from Explorer, so no
 * in-app drag may ride that channel and no `draggable` attribute exists
 * anywhere in `web/src` (pinned by tests/ui/ui-dnd-a10.test.ts).
 *
 * TAB drag (source: a whole view):
 *   - onto another tab            -> merge into that view (append);
 *   - onto strip space / tab edge -> reorder;
 *   - onto a pane of the ACTIVE view -> drag-to-split at the shown drop zone;
 *   - onto the EMPTY STATE of an empty active tab -> merge into it (fill).
 *   A target that would exceed 4 panes rejects with a flash. `Home` is never
 *   a source and no strip position before it is ever a target (decision 4,
 *   2026-09-15: the fixed first tab).
 * PANE-HEADER drag (source: one pane of the active view, any kind):
 *   - onto another pane  -> swap slots (pointer twin of ctrl+alt+shift+arrows);
 *   - onto the tab strip -> extract to its own tab   (sessions only);
 *   - onto another tab   -> move the session there   (sessions only).
 *   A file or diff pane swaps like any other pane; moving an open file to
 *   another tab was not asked for (decision 5, 2026-09-15), so those two
 *   targets simply do not light up for it.
 * FILE-ROW drag (source: a row of the Files panel):
 *   - onto a pane edge   -> split that pane and open the file there;
 *   - onto a pane centre -> open it as a TAB of that editor pane (A10b: it
 *     never replaces what is already in the strip — though a strip already
 *     holding four files loses its LAST chip to make room, B4 amendment; a
 *     TERMINAL pane refuses, user decision 7);
 *   - onto a tab chip    -> open it as a pane of that folder tab;
 *   - onto the EMPTY STATE of an empty active tab -> the same, for that tab.
 * FILE-TAB drag (source: one chip of an editor pane's strip, A10b):
 *   - onto a pane EDGE           -> that tab leaves for a NEW editor pane
 *     there (the only gesture that makes a split, user decision 2); a pane
 *     whose LAST tab leaves frees its own pane, so the split can cost nothing;
 *   - onto the centre of ANOTHER editor pane -> the tab MOVES into that strip
 *     (the whole pane lights up, because the whole pane takes it) — unless
 *     that strip already holds four files, which REFUSES: a move never
 *     evicts anything (B4 amendment, 2026-09-22);
 *   - onto the centre of a TERMINAL pane -> refused, with the same sentence a
 *     file row gets there;
 *   - onto its OWN pane's centre, the tab strip, another chip or the empty
 *     state -> nothing at all: reordering a strip and dropping a tab on the
 *     strip were not built (orchestrator default 4, A10b), and a target that
 *     lights up for an act that does not exist is worse than no target.
 *   The spec carries the pane's `slotKey` AND the tab's own id, so a strip
 *   rebuilt under the drag resolves to nothing instead of to whatever moved
 *   into that position.
 *
 * The ghost is pointer-events:none so hit-testing sees through it. Every
 * drop action also has a keyboard/button path (see the shortcuts overlay).
 */
import * as st from '../state.ts';
import { el } from './util.ts';
import { flash } from './statusline.ts';
import { zoneForPoint, type DropWhere } from './slots-model.ts';
import { openFileGuarded, openTabAtGuarded } from './unsaved.ts';
import { tabIdOf } from './editor-model.ts';

const THRESHOLD_PX = 5;
/** Outer fraction of a tab that means "reorder next to it" instead of "merge into it". */
const TAB_EDGE_FRACTION = 0.25;

/**
 * What a drag is CARRYING. A pane spec names its slot twice on purpose: the
 * INDEX is where the pointer picked it up, the `slotKey` is what was there —
 * so a drop can tell "the pane I grabbed" from "whatever occupies that index
 * now" without trusting the index alone.
 */
export type DragSpec =
  | { kind: 'tab'; viewId: string; label: string }
  | { kind: 'pane'; viewId: string; slot: number; slotKey: string; label: string }
  | { kind: 'file'; path: string; label: string }
  /**
   * One chip of an editor pane's strip (A10b). It names the pane twice (index
   * + `slotKey`) for the reason above, and the TAB twice for the same reason:
   * `tab` is the strip position it was picked up at, `tabId` is what was
   * there. Both are re-resolved at every hit-test (`filetabSource`), so a
   * strip rebuilt mid-drag stops the gesture instead of moving a stranger.
   */
  | {
      kind: 'filetab';
      viewId: string;
      slot: number;
      slotKey: string;
      tab: number;
      tabId: string;
      label: string;
    };

type Target =
  /** `empty`: the target tab stands empty, so its empty state took the drop, not its chip. */
  | { t: 'tab-merge'; viewId: string; ok: boolean; empty?: boolean }
  | { t: 'reorder'; index: number }
  | { t: 'zone'; slot: number; zone: st.Zone }
  | { t: 'swap'; slot: number }
  | { t: 'extract'; index: number }
  | { t: 'move-to-view'; viewId: string; ok: boolean }
  /** A file onto a pane: `where` is the geometry, `ok` is whether state will take it. */
  | { t: 'open-file'; viewId: string; slot: number; where: DropWhere; ok: boolean }
  /** A file onto a tab chip, or onto the empty state of an empty tab: append to that folder tab. */
  | { t: 'open-file-tab'; viewId: string; ok: boolean; empty?: boolean }
  /**
   * A file TAB onto a pane's EDGE: it leaves for a new editor pane there.
   * `zone` is null when the pane offers no split at all (the short pane of a
   * 3-split, a full tab) — then `ok` is false, nothing is drawn, and the drop
   * flashes the same refusal the keyboard twin does.
   */
  | { t: 'open-tab-split'; viewId: string; slot: number; zone: st.Zone | null; ok: boolean }
  /** A file TAB onto the centre of ANOTHER editor pane: it moves into that strip. */
  | { t: 'move-tab'; viewId: string; slot: number }
  /** A file TAB onto the centre of a TERMINAL pane (user decision 7, same as a row). */
  | { t: 'reject-session' }
  /** A file TAB onto an editor pane whose strip already holds `MAX_TABS` files (B4 amendment). */
  | { t: 'reject-tabs-full' }
  | { t: 'reject-full' }
  | null;

/**
 * What the drop overlay SAYS, per geometry. Four sentences for six zones
 * because left and right are one act ("beside") — the dashed box already
 * shows which side, and a label that repeats the picture is noise.
 * `fill` cannot arise for a single pane, and is the same act as `replace`.
 */
const OPEN_LABEL: Record<DropWhere, string> = {
  replace: 'Open here',
  fill: 'Open here',
  left: 'Open beside',
  right: 'Open beside',
  top: 'Open above',
  bottom: 'Open below',
};

/** What the whole-pane box says when a file tab is about to move into that strip. */
const MOVE_TAB_LABEL = 'Move it here';

/**
 * The centre of a TERMINAL pane is not a target (user decision 7,
 * 2026-09-15): a terminal shows a running program, not files, and the edges
 * are right there. ONE sentence for both doors — a file ROW dropped there and
 * a file TAB dragged there are the same mistake, so they get the same answer
 * (A10b: it no longer says "replaced", because since A10b a centre drop on an
 * editor pane ADDS a tab and replaces nothing).
 */
const REJECT_SESSION_CENTRE =
  'A terminal pane cannot hold files. Drop on an edge to split.';

/** The pane cannot split the way it was asked to — the short pane of a 3-split. */
const REJECT_NO_ROOM = 'There is no room beside this pane.';

/**
 * A pane's strip is FULL and the gesture is a MOVE (B4 amendment, 2026-09-22:
 * four files per pane). An OPEN evicts the last chip to make room; a move
 * never does — the tab it would throw out is one the user put there, and the
 * gesture that asked for it says nothing about which. Exported because the
 * ctrl+alt+m twin in main.ts says the SAME sentence: one refusal, one
 * spelling. The four is written out, not interpolated: this is copy.
 */
export const REJECT_PANE_TABS_FULL = 'This pane already holds 4 files.';

interface Drag {
  spec: DragSpec;
  startX: number;
  startY: number;
  started: boolean;
  pointerId: number;
  sourceEl: HTMLElement;
  ghost: HTMLElement | null;
  target: Target;
  targetKey: string;
}

let drag: Drag | null = null;

/**
 * Is a POINTER drag in flight? The window's HTML5 `dragover`/`drop` belongs to
 * real files from Explorer (ui/filedrop.ts, part A9), and the two channels must
 * never both act on one gesture: a browser that synthesises an HTML5 drag from
 * a pointer drag we are already handling would light two sets of visuals and
 * drop twice. `armDrag` counts from POINTERDOWN, not from the 5px threshold —
 * the answer has to be "hands off" for the whole gesture, including the few
 * pixels before it becomes a drag.
 */
export function isDragging(): boolean {
  return drag !== null;
}

/** Swallow the click that follows a completed/cancelled drag. */
let suppressClicksUntil = 0;
document.addEventListener(
  'click',
  (e) => {
    if (Date.now() < suppressClicksUntil) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);

/**
 * Arm an element as a drag source. `makeSpec` runs at pointerdown (the strip
 * and panes are rebuilt often — ids are resolved fresh). Descendants matching
 * `ignore` keep their own pointer behavior (close/kill buttons). Pass `null`
 * when the source element IS the control (a Files-panel row is a button, and
 * `'button'` would match the row itself and arm nothing).
 */
export function armDrag(source: HTMLElement, ignore: string | null, makeSpec: () => DragSpec | null): void {
  source.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag !== null) return;
    if (
      ignore !== null &&
      // Element, not HTMLElement: a press on the GLYPH inside an icon button
      // (B8, a pane header's End session) targets an SVG node, which is no
      // HTMLElement — and narrowing it away would start the drag it ignores.
      e.target instanceof Element &&
      e.target.closest(ignore) !== null
    ) {
      return;
    }
    const spec = makeSpec();
    if (spec === null) return;
    drag = {
      spec,
      startX: e.clientX,
      startY: e.clientY,
      started: false,
      pointerId: e.pointerId,
      sourceEl: source,
      ghost: null,
      target: null,
      targetKey: '',
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  });
}

function onMove(e: PointerEvent): void {
  if (drag === null || e.pointerId !== drag.pointerId) return;
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < THRESHOLD_PX) return;
    begin(e);
  }
  positionGhost(e.clientX, e.clientY);
  setTarget(resolve(e.clientX, e.clientY), e.clientX);
}

function onUp(e: PointerEvent): void {
  if (drag === null || e.pointerId !== drag.pointerId) return;
  const d = drag;
  if (d.started) {
    suppressClicksUntil = Date.now() + 80;
    drop(d);
  }
  cleanup();
}

function onCancel(e: PointerEvent): void {
  if (drag === null || e.pointerId !== drag.pointerId) return;
  if (drag.started) suppressClicksUntil = Date.now() + 80;
  cleanup();
}

function onKey(e: KeyboardEvent): void {
  if (drag === null || e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  if (drag.started) suppressClicksUntil = Date.now() + 80;
  cleanup();
}

function begin(e: PointerEvent): void {
  if (drag === null) return;
  drag.started = true;
  const ghost = el('div', 'drag-ghost', drag.spec.label);
  document.body.append(ghost);
  drag.ghost = ghost;
  document.body.classList.add('is-dnd');
  // The source recedes: a tab chip, a Files row or a pane header. A file TAB
  // dims its CHIP only — the pane it was picked up from is not going anywhere,
  // and dimming it would say it was.
  drag.sourceEl.classList.add('is-dragging');
  if (drag.spec.kind === 'pane') {
    drag.sourceEl.closest('.pane')?.classList.add('is-dragging');
  }
  positionGhost(e.clientX, e.clientY);
}

function positionGhost(x: number, y: number): void {
  if (drag?.ghost != null) {
    // Slight static tilt: the ghost reads as "picked up" without any motion.
    drag.ghost.style.transform = `translate(${x + 14}px, ${y + 10}px) rotate(-2deg)`;
  }
}

// --------------------------------------------------------------------------
// Target resolution (pure hit-testing against the live DOM + state)
// --------------------------------------------------------------------------

function viewById(id: string): st.ViewState | undefined {
  return st.state.views.find((v) => v.id === id);
}

/**
 * The first strip position a tab may be dropped at. `Home` is always
 * `state.views[0]` and never moves, so no reorder and no extract may target
 * position 0 while it is there (user decision 4, 2026-09-15).
 */
function firstMovableIndex(): number {
  return st.state.views[0]?.root?.kind === 'home' ? 1 : 0;
}

/**
 * An insertion point in the strip — a tab REORDER or a pane EXTRACT — or null
 * when it would land before Home.
 */
function insertAt(index: number, t: 'reorder' | 'extract'): Target {
  const first = firstMovableIndex();
  if (index < first) return null;
  return t === 'reorder' ? { t: 'reorder', index } : { t: 'extract', index };
}

function stripInsertIndex(strip: Element, x: number): number {
  const tabs = Array.from(strip.querySelectorAll<HTMLElement>('.tab[data-view-id]'));
  for (let i = 0; i < tabs.length; i++) {
    const r = (tabs[i] as HTMLElement).getBoundingClientRect();
    if (x < r.left + r.width / 2) return i;
  }
  return tabs.length;
}

/**
 * The session a PANE drag is about, or null when it picked up an EDITOR pane
 * (A10b: the one kind that is not a session). `slotKey` is the identity check:
 * an index whose occupant changed under the drag is not the pane the user
 * grabbed.
 */
function paneSessionId(spec: DragSpec): string | null {
  if (spec.kind !== 'pane') return null;
  const slot = viewById(spec.viewId)?.slots[spec.slot];
  if (slot === undefined || slot.kind !== 'session') return null;
  return st.slotKey(slot) === spec.slotKey ? slot.id : null;
}

/**
 * Is this file already a TAB of that view? Then opening it costs no pane — it
 * is raised where it stands (A10b; before the strips it was a pane of its own,
 * and the question was about `slotKey`).
 */
function fileIsIn(v: st.ViewState, path: string): boolean {
  const id = tabIdOf({ kind: 'file', path });
  return v.slots.some((s) => st.slotTabIds(s).includes(id));
}

/** Where a file-tab drag started, as it stands NOW — or null if it moved away. */
interface FiletabSource {
  view: st.ViewState;
  /** The source pane's CURRENT index (panes are remapped by every 2x2 change). */
  slot: number;
  /** The tab's CURRENT position in that strip. */
  tabIndex: number;
  /** Does the source pane keep other tabs? Its last tab leaving frees the pane. */
  keepsOthers: boolean;
}

/**
 * Resolve a file-tab spec against the live model, by KEY and by TAB ID — never
 * by the two indices it also carries. A pane that was closed, a tab that was
 * closed, or a strip that was rebuilt under the drag all answer null, and a
 * null source is a drag with no target anywhere (no visuals, no drop).
 */
function filetabSource(spec: DragSpec): FiletabSource | null {
  if (spec.kind !== 'filetab') return null;
  const view = viewById(spec.viewId);
  if (view === undefined) return null;
  const slot = view.slots.findIndex((s) => st.slotKey(s) === spec.slotKey);
  const pane = view.slots[slot];
  if (pane === undefined || pane.kind !== 'editor') return null;
  const tabIndex = pane.tabs.findIndex((t) => tabIdOf(t) === spec.tabId);
  if (tabIndex === -1) return null;
  return { view, slot, tabIndex, keepsOthers: pane.tabs.length > 1 };
}

/**
 * The zones a file-tab drop may really land in on pane `slot` — measured on the
 * view AS THE DROP WILL LEAVE IT, not as it stands now. A pane whose LAST tab
 * leaves frees its own pane, so the split is one pane smaller than the picture
 * (`state.ts moveTabToSplit` decides on exactly that probe); a pane that keeps
 * other tabs stays, and the live view answers.
 *
 * Two cases answer "no zone at all" rather than guess:
 *   - the pane the tab is LEAVING, when it leaves nothing behind: it is about
 *     to disappear, so there is no pane there to land beside;
 *   - a 2x2 tab whose source pane is about to die: state.ts re-shapes a 2x2
 *     into a 3-split with its own remap (which pane becomes the tall one), and
 *     mirroring that rule here would be a second copy of the layout model
 *     inside the drag layer. `moveTabToSplit` would take it (its capacity rule
 *     allows a 5th pane when the source frees one), but the act is a pane
 *     MOVE wearing a file tab's clothes — the pane chords are the door for
 *     that — so neither the drag nor ctrl+alt+m offers it, and the tab is
 *     refused with the capacity sentence instead. Recorded, not hidden.
 * Everything else is exactly `dropZonesFor`, so the bands the pointer feels
 * and the zones the drop accepts can never drift apart.
 */
function splitZonesFor(v: st.ViewState, src: FiletabSource, slot: number): st.Zone[] {
  if (src.keepsOthers) return st.dropZonesFor(v, slot, 1);
  if (slot === src.slot) return [];
  if (v.slots.length === st.MAX_PANES) return [];
  const probe: st.ViewState = { ...v, slots: v.slots.filter((_, i) => i !== src.slot) };
  return st.dropZonesFor(probe, slot > src.slot ? slot - 1 : slot, 1);
}

function resolve(x: number, y: number): Target {
  if (drag === null) return null;
  const spec = drag.spec;
  const hit = document.elementFromPoint(x, y);
  if (!(hit instanceof Element)) return null;
  const tabEl = hit.closest<HTMLElement>('.tab[data-view-id]');
  const strip = hit.closest('.tabstrip');
  const paneEl = hit.closest<HTMLElement>('.pane[data-slot]');
  // An EMPTY tab (normally `Home`, the first thing the user sees) has no panes
  // to aim at: its empty state IS the pane area, and takes the drop instead
  // (state.ts dropZonesFor says so). Only the ACTIVE view is ever rendered
  // there, so the box speaks for that view and no other.
  const emptyEl = hit.closest('.empty-state') !== null ? st.activeView() : null;

  if (spec.kind === 'tab') {
    const source = viewById(spec.viewId);
    if (source === undefined) return null;
    // Home is never dragged anywhere. ui/tabs.ts arms no handle on it; this is
    // the second lock, so a stale spec cannot move the fixed first tab.
    if (source.root?.kind === 'home' || st.state.views[0]?.id === spec.viewId) return null;
    const srcCount = source.slots.length;
    if (tabEl !== null) {
      const r = tabEl.getBoundingClientRect();
      const targetId = tabEl.dataset.viewId as string;
      const edge = r.width * TAB_EDGE_FRACTION;
      const idx = st.state.views.findIndex((v) => v.id === targetId);
      if (targetId === spec.viewId) return insertAt(idx, 'reorder');
      if (x < r.left + edge) return insertAt(idx, 'reorder');
      if (x > r.right - edge) return insertAt(idx + 1, 'reorder');
      const target = viewById(targetId);
      if (target === undefined) return null;
      return {
        t: 'tab-merge',
        viewId: targetId,
        ok: target.slots.length + srcCount <= st.MAX_PANES,
      };
    }
    if (strip !== null) return insertAt(stripInsertIndex(strip, x), 'reorder');
    if (emptyEl !== null) {
      // Merge = fill, exactly as a drop on the tab's chip: an empty tab has
      // nothing to split against.
      if (emptyEl.id === spec.viewId) return null;
      return {
        t: 'tab-merge',
        viewId: emptyEl.id,
        ok: emptyEl.slots.length + srcCount <= st.MAX_PANES,
        empty: true,
      };
    }
    if (paneEl !== null) {
      const active = st.activeView();
      if (active === null || active.id === spec.viewId) return null; // own panes
      if (active.slots.length + srcCount > st.MAX_PANES) return { t: 'reject-full' };
      const slot = Number(paneEl.dataset.slot);
      const zones = st.dropZonesFor(active, slot, srcCount);
      if (zones.length === 0) return null; // dead area (e.g. short pane of a 3-split)
      const r = paneEl.getBoundingClientRect();
      let zone: st.Zone;
      if (zones[0] === 'fill') zone = 'fill';
      else if (zones[0] === 'left') zone = x < r.left + r.width / 2 ? 'left' : 'right';
      else zone = y < r.top + r.height / 2 ? 'top' : 'bottom';
      return { t: 'zone', slot, zone };
    }
    return null;
  }

  if (spec.kind === 'file') {
    // A tab chip: the file becomes a pane of that FOLDER tab. A plain session
    // tab has no folder to belong to, so it is not a target (a file reaches it
    // by being dropped on one of its panes).
    if (tabEl !== null) {
      const v = viewById(tabEl.dataset.viewId as string);
      if (v === undefined || v.root === null) return null;
      return {
        t: 'open-file-tab',
        viewId: v.id,
        // A10b: a tab holding an editor pane always takes the file — it
        // becomes a TAB there and costs no pane. Since the B4 amendment that
        // strip holds four files, and a fifth EVICTS the last chip rather
        // than being refused (only a MOVE refuses), so the answer is still
        // yes. The rule here must be the one the drop itself uses, or the
        // drag says no and the release says yes.
        ok:
          fileIsIn(v, spec.path) ||
          v.slots.some((s) => s.kind === 'editor') ||
          v.slots.length < st.MAX_PANES,
      };
    }
    if (emptyEl !== null) {
      // Appending to the empty tab is `openFile` on its root — the same door
      // the chip uses. A rootless view cannot stand empty (it dissolves), so
      // `ok: false` here is the refusal shape, not a live path.
      return { t: 'open-file-tab', viewId: emptyEl.id, ok: emptyEl.root !== null, empty: true };
    }
    if (paneEl !== null) {
      const active = st.activeView();
      if (active === null) return null;
      const slot = Number(paneEl.dataset.slot);
      const target = active.slots[slot];
      if (target === undefined) return null;
      const r = paneEl.getBoundingClientRect();
      const where = zoneForPoint(r, st.dropZonesFor(active, slot, 1), x, y);
      // No zone AND not the centre: the pane has nothing to offer here. A full
      // tab still says so out loud; a pane that simply cannot split is dead
      // area, exactly as it is for a tab drag.
      if (where === null) {
        return active.slots.length >= st.MAX_PANES ? { t: 'reject-full' } : null;
      }
      return {
        t: 'open-file',
        viewId: active.id,
        slot,
        where,
        ok: !(where === 'replace' && target.kind === 'session'),
      };
    }
    return null;
  }

  if (spec.kind === 'filetab') {
    const src = filetabSource(spec);
    // The pane was closed, the tab was closed, or the strip was rebuilt under
    // the drag: the gesture is about something that is no longer there.
    if (src === null) return null;
    // Gestures that were deliberately not built (orchestrator default 4,
    // A10b) and therefore never light up: a strip — its own (a reorder) or
    // another pane's — a tab chip, the bottom tab strip (giving the file a tab
    // of its own) and the empty state. Its own pane's centre joins them a few
    // lines down. A target that lights up for an act that does not exist is
    // worse than no target at all.
    if (hit.closest('.pane-tabs') !== null) return null;
    if (strip !== null || tabEl !== null || emptyEl !== null) return null;
    if (paneEl === null) return null;
    const active = st.activeView();
    // The grid draws the ACTIVE view only, so a chip carrying another view's id
    // has nothing here to aim at.
    if (active === null || active.id !== spec.viewId) return null;
    const slot = Number(paneEl.dataset.slot);
    const target = active.slots[slot];
    if (target === undefined) return null;
    const r = paneEl.getBoundingClientRect();
    const where = zoneForPoint(r, splitZonesFor(active, src, slot), x, y);
    if (where === 'replace' || where === 'fill') {
      // The CENTRE: the whole pane takes the tab, because the whole pane is
      // what it joins.
      if (target.kind === 'session') return { t: 'reject-session' };
      if (slot === src.slot) return null; // its own pane: it is already there
      // B4 amendment (2026-09-22): a strip holds four files. An OPEN evicts
      // the last chip to make room; a MOVE refuses — so the drag says so
      // here, and the drop says it in words. A target that already shows this
      // tab is a RAISE and costs no room, however full it is.
      if (target.tabs.length >= st.MAX_TABS && !st.slotTabIds(target).includes(spec.tabId)) {
        return { t: 'reject-tabs-full' };
      }
      return { t: 'move-tab', viewId: active.id, slot };
    }
    // An EDGE. `null` is an edge this drop cannot honour — a full tab, the
    // short pane of a 3-split, or the tab's own pane with nothing else in it —
    // and it refuses out loud, the way the chord does, instead of quietly
    // doing something else.
    return { t: 'open-tab-split', viewId: active.id, slot, zone: where, ok: where !== null };
  }

  // Pane-header drag.
  const sessionId = paneSessionId(spec);
  if (strip !== null && tabEl === null) {
    // Extract and move-to-view are SESSION acts: a file pane has no session to
    // give its own tab, and moving an open file between tabs was not asked for.
    if (sessionId === null) return null;
    const source = viewById(spec.viewId);
    if (source === undefined || source.slots.length <= 1) return null; // already its own tab
    return insertAt(stripInsertIndex(strip, x), 'extract');
  }
  if (tabEl !== null) {
    if (sessionId === null) return null;
    const targetId = tabEl.dataset.viewId as string;
    if (targetId === spec.viewId) return null;
    const target = viewById(targetId);
    if (target === undefined) return null;
    return { t: 'move-to-view', viewId: targetId, ok: target.slots.length + 1 <= st.MAX_PANES };
  }
  if (paneEl !== null) {
    // Swapping is kind-blind: a file and a terminal trade places.
    const slot = Number(paneEl.dataset.slot);
    if (slot !== spec.slot) return { t: 'swap', slot };
  }
  return null;
}

// --------------------------------------------------------------------------
// Target visuals
// --------------------------------------------------------------------------

/** Reveal a pane's drop overlay at `zone`, with the sentence that names the act. */
function showPaneDrop(slot: number, zone: string, label: string): void {
  const paneEl = document.querySelector(`.grid .pane[data-slot="${slot}"]`);
  const host = paneEl?.querySelector<HTMLElement>('.pane-drop');
  if (host === undefined || host === null) return;
  // An EMPTY zone means the WHOLE pane takes the drop (a file tab moving into
  // that strip) — the same shape A9's Explorer drop uses. The box is placed by
  // this attribute, so it has to be GONE, not empty.
  if (zone === '') delete host.dataset.zone;
  else host.dataset.zone = zone;
  const lb = host.querySelector('.pane-drop-lb');
  if (lb !== null) lb.textContent = label;
  host.hidden = false;
}

function setTarget(target: Target, x: number): void {
  if (drag === null) return;
  const key = JSON.stringify(target) + (target?.t === 'reorder' ? `@${Math.round(x / 4)}` : '');
  if (key === drag.targetKey) return;
  drag.targetKey = key;
  drag.target = target;
  clearVisuals();
  if (target === null) return;
  const ghost = drag.ghost;
  switch (target.t) {
    case 'tab-merge':
    case 'move-to-view':
    case 'open-file-tab': {
      // An empty tab was hit on its empty state, so THAT box lights up (the
      // chip is not where the pointer is); every other merge lights the chip.
      const onEmpty = target.t !== 'move-to-view' && target.empty === true;
      const box = onEmpty
        ? document.querySelector('.grid .empty-state')
        : document.querySelector(`.tab[data-view-id="${CSS.escape(target.viewId)}"]`);
      if (target.ok) box?.classList.add('is-drop');
      else ghost?.classList.add('is-invalid');
      break;
    }
    case 'reorder': {
      const strip = document.querySelector('.tabstrip');
      if (strip === null) break;
      const tabs = strip.querySelectorAll('.tab[data-view-id]');
      const at = tabs[target.index] ?? strip.querySelector('.tab-new');
      at?.classList.add('is-insert-before');
      break;
    }
    case 'zone': {
      // 'fill' only arises for multi-session merges now (dropZonesFor):
      // the whole pane area takes them, so the sentence is plural.
      showPaneDrop(
        target.slot,
        target.zone,
        target.zone === 'fill'
          ? 'Drop here to show them side by side'
          : 'Drop here to show side by side',
      );
      break;
    }
    case 'open-file': {
      // A refusal shows the ghost turning invalid and NO box: a box would
      // promise the pane is about to change.
      if (target.ok) showPaneDrop(target.slot, target.where, OPEN_LABEL[target.where]);
      else ghost?.classList.add('is-invalid');
      break;
    }
    case 'open-tab-split': {
      // A refusal shows the ghost turning invalid and NO box, exactly as a
      // file row's refusal does: a box would promise a split that is not
      // coming.
      if (target.ok && target.zone !== null) showPaneDrop(target.slot, target.zone, OPEN_LABEL[target.zone]);
      else ghost?.classList.add('is-invalid');
      break;
    }
    case 'move-tab':
      // No zone: the whole pane lights up, because the whole pane takes it.
      showPaneDrop(target.slot, '', MOVE_TAB_LABEL);
      break;
    case 'reject-session':
    case 'reject-tabs-full':
      ghost?.classList.add('is-invalid');
      break;
    case 'swap': {
      document
        .querySelector(`.grid .pane[data-slot="${target.slot}"]`)
        ?.classList.add('is-drop-target');
      break;
    }
    case 'extract': {
      const strip = document.querySelector('.tabstrip');
      strip?.classList.add('is-drop');
      const tabs = strip?.querySelectorAll('.tab[data-view-id]');
      const at = tabs?.[target.index] ?? strip?.querySelector('.tab-new');
      at?.classList.add('is-insert-before');
      break;
    }
    case 'reject-full':
      ghost?.classList.add('is-invalid');
      break;
  }
}

function clearVisuals(): void {
  for (const n of document.querySelectorAll('.is-drop, .is-insert-before, .is-drop-target')) {
    n.classList.remove('is-drop', 'is-insert-before', 'is-drop-target');
  }
  for (const n of document.querySelectorAll<HTMLElement>('.pane-drop')) n.hidden = true;
  drag?.ghost?.classList.remove('is-invalid');
}

// --------------------------------------------------------------------------
// Drop + cleanup
// --------------------------------------------------------------------------

function rejectFull(): void {
  flash('This tab is full. It can show 4 panes.');
  const grid = document.querySelector('.grid');
  if (grid !== null) {
    grid.classList.remove('is-reject');
    // Restart the pulse even when a previous one is mid-flight.
    void (grid as HTMLElement).offsetWidth;
    grid.classList.add('is-reject');
    window.setTimeout(() => grid.classList.remove('is-reject'), 300);
  }
}

/**
 * Say why a file did not land. ONE mapping, shared by the drag and by its
 * keyboard twin in ui/files.ts, so the two can never explain the same refusal
 * differently. `'ok'` and `'no-view'` are silent: one succeeded, the other is
 * a tab that went away under the gesture.
 */
export function flashOpenResult(r: st.OpenFileResult): void {
  if (r === 'full') rejectFull();
  else if (r === 'session-centre') flash(REJECT_SESSION_CENTRE);
  else if (r === 'no-zone') flash(REJECT_NO_ROOM);
}

/**
 * Say why a MOVE did not land. The one difference from `flashOpenResult` is
 * what `'full'` means here: `state.moveTab` answers it for a full STRIP, not
 * a full tab of panes (B4 amendment), so it gets the strip's sentence. Shared
 * by the drop and by ctrl+alt+m, for the usual reason.
 */
export function flashMoveTabResult(r: st.OpenFileResult): void {
  if (r === 'full') flash(REJECT_PANE_TABS_FULL);
  else flashOpenResult(r);
}

function drop(d: Drag): void {
  const target = d.target;
  const spec = d.spec;
  if (target === null) return;
  switch (target.t) {
    case 'tab-merge':
      if (spec.kind !== 'tab') return;
      if (!target.ok || st.mergeViews(target.viewId, spec.viewId, 0, 'fill') === 'full') {
        rejectFull();
      }
      break;
    case 'reorder':
      if (spec.kind === 'tab') st.reorderView(spec.viewId, target.index);
      break;
    case 'zone': {
      if (spec.kind !== 'tab') return;
      const active = st.activeView();
      if (active === null) return;
      if (st.mergeViews(active.id, spec.viewId, target.slot, target.zone) === 'full') rejectFull();
      break;
    }
    case 'swap':
      if (spec.kind === 'pane') st.swapPanes(spec.viewId, spec.slot, target.slot);
      break;
    case 'extract': {
      if (spec.kind !== 'pane') return;
      const id = paneSessionId(spec);
      if (id !== null) st.extractSession(id, target.index);
      break;
    }
    case 'move-to-view': {
      if (spec.kind !== 'pane') return;
      const id = paneSessionId(spec);
      if (id === null) return;
      if (!target.ok || st.moveSessionToView(id, target.viewId) === 'full') rejectFull();
      break;
    }
    case 'open-file': {
      if (spec.kind !== 'file') return;
      // `'replace'` is the pane's CENTRE, and on an editor pane that ADDS the
      // file to the strip (A10b) — the word is the drop layer's name for the
      // middle, not a promise to throw anything away.
      // Through the B4 guard: the CENTRE of a full strip evicts its last chip,
      // and a chip carrying unsaved text no other tab shows is asked about
      // first (`ui/unsaved.ts`). An edge cannot evict and never asks.
      openTabAtGuarded(
        target.viewId,
        target.slot,
        target.where,
        { kind: 'file', path: spec.path },
        { done: flashOpenResult },
      );
      break;
    }
    case 'open-tab-split': {
      if (spec.kind !== 'filetab') return;
      const src = filetabSource(spec);
      if (src === null) return;
      if (!target.ok || target.zone === null) {
        // Say the same thing the chord says. A tab that is full only has room
        // when the source pane dies with the tab, and then there IS a zone.
        flashOpenResult(src.view.slots.length >= st.MAX_PANES ? 'full' : 'no-zone');
        return;
      }
      flashOpenResult(
        st.moveTabToSplit(target.viewId, src.slot, src.tabIndex, target.slot, target.zone),
      );
      break;
    }
    case 'move-tab': {
      if (spec.kind !== 'filetab') return;
      const src = filetabSource(spec);
      if (src === null) return;
      flashMoveTabResult(st.moveTab(target.viewId, src.slot, src.tabIndex, target.slot));
      break;
    }
    case 'reject-session':
      // ONE mapping for both doors: the file row and the file tab get the same
      // sentence for the same mistake.
      flashOpenResult('session-centre');
      break;
    case 'reject-tabs-full':
      // The same sentence `state.moveTab`'s own refusal would give, said here
      // because the drag layer already knows the answer and never called it.
      flash(REJECT_PANE_TABS_FULL);
      break;
    case 'open-file-tab': {
      if (spec.kind !== 'file') return;
      const v = viewById(target.viewId);
      if (v === undefined || v.root === null) return;
      // Through the B4 guard, for the reason the pane centre is: this door
      // adds a tab to an existing strip too.
      openFileGuarded(v.root, spec.path, spec.label, { done: flashOpenResult });
      break;
    }
    case 'reject-full':
      rejectFull();
      break;
  }
}

function cleanup(): void {
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  window.removeEventListener('pointercancel', onCancel);
  window.removeEventListener('keydown', onKey, true);
  clearVisuals();
  drag?.ghost?.remove();
  document.body.classList.remove('is-dnd');
  drag?.sourceEl.classList.remove('is-dragging');
  if (drag?.spec.kind === 'pane') {
    for (const n of document.querySelectorAll('.pane.is-dragging')) n.classList.remove('is-dragging');
  }
  drag = null;
}
