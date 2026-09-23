/**
 * Which pane card each slot of a re-laid-out tab takes — the pure rule behind
 * `ui/panes.ts`'s relayout (Quality part P2, `.claude/plans/PLAN-QUALITY.md`).
 *
 * Why it exists: a split, a close, an "Own tab" or an extract used to rebuild
 * the whole tab — every terminal in it was disposed and attached again, and
 * the server replayed each one's full scrollback (P0 measured 3.8 MB and a
 * 240 ms stall for a 2→3 split, `memory/log/2026-09/project/2026-09-23-quality-p0-measurements.md`).
 * A pane whose content is still in the tab now keeps its card, and with it its
 * xterm instance and its socket: it is moved in the grid, refit by its own
 * ResizeObserver, and resized once if its size changed. Only a pane that is
 * NEW to the tab attaches.
 *
 * The rule, per slot of the new layout, in this order:
 *
 *   1. the card that already shows this content (same `slotKey`) — wherever it
 *      stood. That is the whole gain: a kept terminal is never re-attached.
 *   2. else the card that stood at this very index, when nothing claimed it in
 *      step 1 — its content is converted in place (`reconcileSlot`), the
 *      pre-P2 behaviour for a file dropped on a terminal.
 *   3. else a new card.
 *
 * A card no slot takes is torn down by the caller. No DOM and no state here:
 * `tests/ui/ui-pane-reuse-model.test.ts` drives it directly.
 */

/**
 * For each key of `next`, the index in `prev` of the card it takes, or null
 * for a new card. `prev` holds the keys the cards show now (`''` for a card
 * that shows nothing, which only step 2 can take); `next` holds the keys the
 * view wants, which are unique within a view (state.ts guarantees it).
 */
export function planCards(prev: readonly string[], next: readonly string[]): (number | null)[] {
  const claimed = new Set<number>();
  const plan: (number | null)[] = next.map((key) => {
    if (key === '') return null;
    const from = prev.findIndex((k, i) => k === key && !claimed.has(i));
    if (from < 0) return null;
    claimed.add(from);
    return from;
  });
  return plan.map((from, i) => {
    if (from !== null) return from;
    // Step 2: the card at this index, unless its content lives on elsewhere
    // (then step 1 already claimed it) — converting it would re-attach a
    // terminal that only moved.
    if (i < prev.length && !claimed.has(i)) {
      claimed.add(i);
      return i;
    }
    return null;
  });
}
