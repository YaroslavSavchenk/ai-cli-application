/**
 * Pointer-based drag & drop for tabs and pane headers. HTML5 DnD is
 * deliberately avoided: pointer events give a controlled ghost, live
 * hit-testing via elementFromPoint, Escape-cancel, and testability with
 * plain mouse input.
 *
 * TAB drag (source: a whole view):
 *   - onto another tab            -> merge into that view (append);
 *   - onto strip space / tab edge -> reorder;
 *   - onto a pane of the ACTIVE view -> drag-to-split at the shown drop zone.
 *   A target that would exceed 4 panes rejects with a flash.
 * PANE-HEADER drag (source: one session of the active view):
 *   - onto another pane  -> swap slots (pointer twin of ctrl+alt+shift+arrows);
 *   - onto the tab strip -> extract to its own tab;
 *   - onto another tab   -> move the session into that view.
 *
 * The ghost is pointer-events:none so hit-testing sees through it. Every
 * drop action also has a keyboard/button path (see the shortcuts overlay).
 */
import * as st from '../state.ts';
import { el } from './util.ts';
import { flash } from './statusline.ts';

const THRESHOLD_PX = 5;
/** Outer fraction of a tab that means "reorder next to it" instead of "merge into it". */
const TAB_EDGE_FRACTION = 0.25;

export type DragSpec =
  | { kind: 'tab'; viewId: string; label: string }
  | { kind: 'pane'; viewId: string; slot: number; sessionId: string; label: string };

type Target =
  | { t: 'tab-merge'; viewId: string; ok: boolean }
  | { t: 'reorder'; index: number }
  | { t: 'zone'; slot: number; zone: st.Zone }
  | { t: 'swap'; slot: number }
  | { t: 'extract'; index: number }
  | { t: 'move-to-view'; viewId: string; ok: boolean }
  | { t: 'reject-full' }
  | null;

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
 * `ignore` keep their own pointer behavior (close/kill buttons).
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

function stripInsertIndex(strip: Element, x: number): number {
  const tabs = Array.from(strip.querySelectorAll<HTMLElement>('.tab[data-view-id]'));
  for (let i = 0; i < tabs.length; i++) {
    const r = (tabs[i] as HTMLElement).getBoundingClientRect();
    if (x < r.left + r.width / 2) return i;
  }
  return tabs.length;
}

function resolve(x: number, y: number): Target {
  if (drag === null) return null;
  const spec = drag.spec;
  const hit = document.elementFromPoint(x, y);
  if (!(hit instanceof Element)) return null;
  const tabEl = hit.closest<HTMLElement>('.tab[data-view-id]');
  const strip = hit.closest('.tabstrip');
  const paneEl = hit.closest<HTMLElement>('.pane[data-slot]');

  if (spec.kind === 'tab') {
    const source = viewById(spec.viewId);
    if (source === undefined) return null;
    const srcCount = source.sessions.length;
    if (tabEl !== null) {
      const r = tabEl.getBoundingClientRect();
      const targetId = tabEl.dataset.viewId as string;
      const edge = r.width * TAB_EDGE_FRACTION;
      const idx = st.state.views.findIndex((v) => v.id === targetId);
      if (targetId === spec.viewId) return { t: 'reorder', index: idx };
      if (x < r.left + edge) return { t: 'reorder', index: idx };
      if (x > r.right - edge) return { t: 'reorder', index: idx + 1 };
      const target = viewById(targetId);
      if (target === undefined) return null;
      return {
        t: 'tab-merge',
        viewId: targetId,
        ok: target.sessions.length + srcCount <= st.MAX_PANES,
      };
    }
    if (strip !== null) return { t: 'reorder', index: stripInsertIndex(strip, x) };
    if (paneEl !== null) {
      const active = st.activeView();
      if (active === null || active.id === spec.viewId) return null; // own panes
      if (active.sessions.length + srcCount > st.MAX_PANES) return { t: 'reject-full' };
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

  // Pane-header drag.
  if (strip !== null && tabEl === null) {
    const source = viewById(spec.viewId);
    if (source === undefined || source.sessions.length <= 1) return null; // already its own tab
    return { t: 'extract', index: stripInsertIndex(strip, x) };
  }
  if (tabEl !== null) {
    const targetId = tabEl.dataset.viewId as string;
    if (targetId === spec.viewId) return null;
    const target = viewById(targetId);
    if (target === undefined) return null;
    return { t: 'move-to-view', viewId: targetId, ok: target.sessions.length + 1 <= st.MAX_PANES };
  }
  if (paneEl !== null) {
    const slot = Number(paneEl.dataset.slot);
    if (slot !== spec.slot) return { t: 'swap', slot };
  }
  return null;
}

// --------------------------------------------------------------------------
// Target visuals
// --------------------------------------------------------------------------

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
    case 'move-to-view': {
      const tabEl = document.querySelector(`.tab[data-view-id="${CSS.escape(target.viewId)}"]`);
      if (target.ok) tabEl?.classList.add('is-drop');
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
      const paneEl = document.querySelector(`.grid .pane[data-slot="${target.slot}"]`);
      const host = paneEl?.querySelector<HTMLElement>('.pane-drop');
      if (host !== undefined && host !== null) {
        host.dataset.zone = target.zone;
        const lb = host.querySelector('.pane-drop-lb');
        // 'fill' only arises for multi-session merges now (dropZonesFor).
        if (lb !== null) lb.textContent = target.zone === 'fill' ? 'merge here' : 'split here';
        host.hidden = false;
      }
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
  flash('view is full — 4 panes max');
  const grid = document.querySelector('.grid');
  if (grid !== null) {
    grid.classList.remove('is-reject');
    // Restart the pulse even when a previous one is mid-flight.
    void (grid as HTMLElement).offsetWidth;
    grid.classList.add('is-reject');
    window.setTimeout(() => grid.classList.remove('is-reject'), 300);
  }
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
    case 'extract':
      if (spec.kind === 'pane') st.extractSession(spec.sessionId, target.index);
      break;
    case 'move-to-view':
      if (spec.kind !== 'pane') return;
      if (!target.ok || st.moveSessionToView(spec.sessionId, target.viewId) === 'full') {
        rejectFull();
      }
      break;
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
