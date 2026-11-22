/**
 * The split dividers of the pane grid (2..4 panes), split from `panes.ts`
 * (Quality part Q13, `.claude/plans/PLAN-QUALITY.md`), code moved as it
 * stood: the ratio on the grid (`applySplit`), the dividers of the current
 * shape, and one divider's drag, double-click and keyboard handling.
 *
 * The grid templates read --split-col/--split-row; every ratio change goes
 * through applySplit and nothing else — the panes resize, each TerminalView's
 * ResizeObserver fires, and the existing debounced fit -> ws resize chain
 * propagates cols/rows to the PTY.
 *
 * `panes.ts` owns the grid element and hands it in; this module owns the
 * dividers it drew. Siblings: `panes.ts`, `panes-status.ts`, `panes-park.ts`.
 */
import * as st from '../state.ts';
import { el } from './util.ts';

/** The split dividers of the current shape; rebuilt only when the shape changes. */
let dividers: HTMLElement[] = [];

export function applySplit(grid: HTMLElement, v: st.ViewState): void {
  grid.style.setProperty('--split-col', String(v.split.col));
  grid.style.setProperty('--split-row', String(v.split.row));
}

/** applySplit for the current active view (divider handlers). */
function applySplitNow(grid: HTMLElement): void {
  const v = st.activeView();
  if (v !== null) applySplit(grid, v);
}

export function buildDividers(grid: HTMLElement, v: st.ViewState): void {
  const n = v.slots.length;
  dividers = [];
  if (n >= 2) dividers.push(makeDivider(grid, 'col', v, null));
  // 3 panes: the row divider only spans the stacked column (L = right, R = left).
  if (n >= 3) dividers.push(makeDivider(grid, 'row', v, n === 3 ? v.l3 : null));
  // After the cards: relayout places card i at grid child i.
  grid.append(...dividers);
}

/**
 * A divider is a grab strip as wide as the gutter, carrying a 1px line that
 * is ALWAYS drawn (neutral-900 at rest) and takes the accent while hovered,
 * focused or dragging — a control that appears only under the pointer is
 * forbidden here (app.css, "split dividers"). Pointer-drag adjusts the
 * fraction (min pane 15%), double-click or Enter resets to equal, arrow
 * keys nudge 2% — keyboard-reachable like every control.
 */
function makeDivider(
  grid: HTMLElement,
  axis: 'col' | 'row',
  v: st.ViewState,
  partialSide: st.L3 | null,
): HTMLElement {
  const partial =
    partialSide === null ? '' : partialSide === 'L' ? ' is-partial-r' : ' is-partial-l';
  const d = el('div', `divider divider-${axis}${partial}`);
  d.tabIndex = 0;
  d.setAttribute('role', 'separator');
  d.setAttribute('aria-orientation', axis === 'col' ? 'vertical' : 'horizontal');
  d.setAttribute('aria-label', axis === 'col' ? 'column split' : 'row split');
  d.setAttribute('aria-valuemin', String(Math.round(st.SPLIT_MIN * 100)));
  d.setAttribute('aria-valuemax', String(Math.round(st.SPLIT_MAX * 100)));
  d.title = 'Drag to resize. Arrow keys nudge it, double-click or enter resets it.';
  const setNow = (f: number): void => {
    d.setAttribute('aria-valuenow', String(Math.round(f * 100)));
  };
  setNow(v.split[axis]);

  d.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    d.setPointerCapture(e.pointerId);
    d.classList.add('is-dragging');
  });
  d.addEventListener('pointermove', (e) => {
    if (!d.hasPointerCapture(e.pointerId)) return;
    const r = grid.getBoundingClientRect();
    // The grid carries 10px padding and a 10px gap (handoff); the split
    // fraction covers only the usable track space between them.
    const cs = getComputedStyle(grid);
    const pad = parseFloat(cs.paddingLeft) || 0;
    const gap = parseFloat(axis === 'col' ? cs.columnGap : cs.rowGap) || 0;
    const size = axis === 'col' ? r.width : r.height;
    const pos = axis === 'col' ? e.clientX - r.left : e.clientY - r.top;
    const usable = size - 2 * pad - gap;
    const f = usable > 0 ? (pos - pad - gap / 2) / usable : 0.5;
    // Live: style only, no persist/notify — the ResizeObservers do the rest.
    setNow(st.setSplit(axis, f, false));
    applySplitNow(grid);
  });
  const endDrag = (e: PointerEvent): void => {
    if (!d.hasPointerCapture(e.pointerId)) return;
    d.releasePointerCapture(e.pointerId);
    d.classList.remove('is-dragging');
    const cur = st.activeView()?.split[axis] ?? 0.5;
    st.setSplit(axis, cur, true); // Persist + notify.
  };
  d.addEventListener('pointerup', endDrag);
  d.addEventListener('pointercancel', endDrag);
  d.addEventListener('dblclick', () => {
    setNow(st.setSplit(axis, 0.5, true));
    applySplitNow(grid);
  });
  d.addEventListener('keydown', (e) => {
    const cur = st.activeView()?.split[axis] ?? 0.5;
    let f: number | null = null;
    if (axis === 'col' && e.key === 'ArrowLeft') f = cur - 0.02;
    else if (axis === 'col' && e.key === 'ArrowRight') f = cur + 0.02;
    else if (axis === 'row' && e.key === 'ArrowUp') f = cur - 0.02;
    else if (axis === 'row' && e.key === 'ArrowDown') f = cur + 0.02;
    else if (e.key === 'Enter') f = 0.5;
    if (f !== null) {
      e.preventDefault();
      setNow(st.setSplit(axis, f, true));
      applySplitNow(grid);
    }
  });
  return d;
}

/**
 * Take the current dividers out of the grid — a shape change, or a tab switch
 * that emptied the grid already (then the removes are no-ops).
 */
export function removeDividers(): void {
  for (const d of dividers) d.remove();
  dividers = [];
}
