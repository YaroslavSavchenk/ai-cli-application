/**
 * Pointer-based drag & drop for tabs, pane headers and Files-panel rows.
 * HTML5 DnD is deliberately avoided: pointer events give a controlled ghost,
 * live hit-testing via elementFromPoint, Escape-cancel, and testability with
 * plain mouse input. The second reason (A10): parts A9/B10 need the window's
 * own HTML5 `dragover`/`drop` for REAL files dragged in from Explorer, so no
 * in-app drag may ride that channel and no `draggable` attribute exists
 * anywhere in `web/src` (pinned by tests/ui-dnd-a10.test.ts).
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
 *   - onto a pane centre -> replace it (a TERMINAL pane refuses: decision 7);
 *   - onto a tab chip    -> open it as a pane of that folder tab;
 *   - onto the EMPTY STATE of an empty active tab -> the same, for that tab.
 *
 * The ghost is pointer-events:none so hit-testing sees through it. Every
 * drop action also has a keyboard/button path (see the shortcuts overlay).
 */
import * as st from '../state.ts';
import { el } from './util.ts';
import { flash } from './statusline.ts';
import { zoneForPoint, type DropWhere } from './slots-model.ts';

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
  | { kind: 'file'; path: string; label: string };

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

/**
 * The centre of a TERMINAL pane is not a target (user decision 7,
 * 2026-09-15): a running session is not something a file may quietly take the
 * place of, and the edges are right there.
 */
const REJECT_SESSION_CENTRE =
  'A terminal pane cannot be replaced by a file. Drop on an edge to split.';

/** The pane cannot split the way it was asked to — the short pane of a 3-split. */
const REJECT_NO_ROOM = 'There is no room beside this pane.';

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
      e.target instanceof HTMLElement &&
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
 * The session a PANE drag is about, or null when it picked up a file or a
 * diff. `slotKey` is the identity check: an index whose occupant changed under
 * the drag is not the pane the user grabbed.
 */
function paneSessionId(spec: DragSpec): string | null {
  if (spec.kind !== 'pane') return null;
  const slot = viewById(spec.viewId)?.slots[spec.slot];
  if (slot === undefined || slot.kind !== 'session') return null;
  return st.slotKey(slot) === spec.slotKey ? slot.id : null;
}

/** Is this file already a pane of that view? Then opening it costs no pane. */
function fileIsIn(v: st.ViewState, path: string): boolean {
  const key = st.slotKey({ kind: 'file', path });
  return v.slots.some((s) => st.slotKey(s) === key);
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
        ok: fileIsIn(v, spec.path) || v.slots.length < st.MAX_PANES,
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
  host.dataset.zone = zone;
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
      flashOpenResult(st.openFileAt(target.viewId, target.slot, target.where, spec.path));
      break;
    }
    case 'open-file-tab': {
      if (spec.kind !== 'file') return;
      const v = viewById(target.viewId);
      if (v === undefined || v.root === null) return;
      flashOpenResult(st.openFile(v.root, spec.path, spec.label));
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
