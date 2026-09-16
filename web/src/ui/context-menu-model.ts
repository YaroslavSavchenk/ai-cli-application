/**
 * Row context-menu model (Nocturne part A9b, user decision 3, 2026-09-16,
 * `.claude/PLAN-A9B.md` §3 and §5) — what a right-click on a Files-panel row
 * offers, what the menu is called for a screen reader, where it opens so it is
 * always whole on screen, and where the arrow keys go next.
 *
 * No DOM, no state, no browser. The geometry in particular HAS to be pure:
 * `tests/fake-dom.ts` measures nothing (`getBoundingClientRect` answers only
 * the rect a test set), so a menu that positioned itself by reading the
 * document could not be tested at all. The DOM half (brief 2) measures once
 * after appending and applies the point this function returns.
 *
 * Copy rules this file enforces, not just follows:
 * - LABELS ARE PLAIN WORDS (PROJECT-SCOPE, 2026-07-25): `Open`, `Close`,
 *   `Copy`, `Paste`, `Open beside`. No commands, no flags, no key names, no
 *   icons, no counts, no separator — four entries and three entries are short
 *   enough to read as a list.
 * - HONESTY ABOUT WHAT IS NOT BUILT: `Copy` and `Paste` are visible and
 *   DISABLED until part B10, each carrying one plain sentence saying why. A
 *   page cannot put files on the operating system's clipboard, and cannot read
 *   files off it outside a `paste` event; the Windows host does both in B10.
 *   The sentences name no product, no path and no key — the one about pasting
 *   points at the keyboard because that route really does work today (§2).
 * - A PATH NEVER REACHES A LABEL: `menuLabel` takes the row's NAME, and the
 *   caller is the one that reduced a path to it (`selectedName`).
 */
import { COPY_LABEL } from './files-select-model.ts';

/** What one entry does when it is chosen. */
export type MenuAction = 'toggle' | 'open' | 'open-beside' | 'copy' | 'paste' | 'copy-files';

/** One entry of the menu. */
export interface MenuItem {
  action: MenuAction;
  label: string;
  /**
   * A disabled entry is rendered `aria-disabled="true"` — never with the
   * `disabled` attribute — because the arrows must still reach it: the
   * one-line `note` under its label is the entire reason it exists (user
   * decision 3). Activating one does nothing.
   */
  enabled: boolean;
  /** The one-line explanation a disabled entry carries. Enabled ones carry none. */
  note?: string;
}

/** The row the menu was opened on, reduced to what the entries depend on. */
export interface RowSubject {
  /** A folder row. A file row offers a different, shorter list. */
  dir: boolean;
  /** The row's own NAME, never its path. */
  name: string;
  /** Is this folder open right now? Decides `Open` vs `Close`. */
  open: boolean;
}

/** Why `Copy` cannot work yet. One sentence, no key names, no product names. */
export const COPY_NOTE = 'The app cannot put files on the clipboard yet.';

/**
 * Why `Paste` cannot work FROM THE MENU, and where it does work. A page only
 * ever sees files inside a real `paste` event, which is a keystroke, not a
 * menu choice — so this sentence is a signpost, not an apology.
 */
export const PASTE_NOTE = 'The menu cannot read the clipboard. Paste with the keyboard instead.';

/**
 * How far the menu stays clear of every viewport edge, in CSS pixels. Small on
 * purpose: this is the "never flush against the glass" inset, not a margin
 * anybody is meant to notice.
 */
export const MENU_MARGIN = 8;

/**
 * The entries for one row, in reading order.
 *
 * A FOLDER offers what the row itself does (`Open`/`Close` — the same toggle
 * the primary click performs, named instead of guessed at), the two clipboard
 * entries that are not built yet, and the destination gesture that IS built:
 * `Copy files here…`, the same words as the copy strip's own button, because
 * they do the same thing to the same folder.
 *
 * A FILE offers the two ways the app can already show it — in the focused
 * editor pane, or beside it — plus `Copy`. It offers no `Paste`: files do not
 * take files, and a menu that answered questions about a row's PARENT would be
 * a second destination rule nobody asked for.
 */
export function itemsFor(row: RowSubject): MenuItem[] {
  if (row.dir) {
    return [
      { action: 'toggle', label: row.open ? 'Close' : 'Open', enabled: true },
      { action: 'copy', label: 'Copy', enabled: false, note: COPY_NOTE },
      { action: 'paste', label: 'Paste', enabled: false, note: PASTE_NOTE },
      { action: 'copy-files', label: COPY_LABEL, enabled: true },
    ];
  }
  return [
    { action: 'open', label: 'Open', enabled: true },
    { action: 'open-beside', label: 'Open beside', enabled: true },
    { action: 'copy', label: 'Copy', enabled: false, note: COPY_NOTE },
  ];
}

/**
 * The menu's accessible name: `actions for src`. Lower case and plain, so a
 * screen reader reads it as the continuation of the row it was opened from
 * rather than as a title nobody asked for.
 */
export function menuLabel(row: RowSubject): string {
  return `actions for ${row.name}`;
}

/**
 * Where the menu's top-left corner goes, given the point it was asked for
 * (`at` — the pointer for a right-click, the focused row's leading edge and
 * bottom for the keyboard), its measured `size`, and the viewport.
 *
 * FLIP BEFORE CLAMP, and that order is the whole design: a menu opened near
 * the right edge opens LEFTWARD from the point (the way every desktop menu
 * does), and one near the bottom opens UPWARD, so the pointer keeps standing
 * on the row it belongs to. Clamping first would instead slide the menu
 * sideways along the edge and leave it covering half the tree.
 *
 * THE FLIP THRESHOLD COUNTS THE MARGIN (`at.x + size.w > vp.w - MENU_MARGIN`,
 * and the `y` twin): a menu that would cross the inset rather than the glass
 * itself already has to move, and flipping is how it moves. Measuring against
 * the bare edge would leave an 8 px band in which the clamp slides the menu
 * back over the row the pointer is standing on (scope review, part A9b).
 *
 * The clamp is the last word, and its lower bound is applied last, so a menu
 * that is simply bigger than the viewport sits at `MENU_MARGIN` and is never
 * placed at a negative coordinate — it is clipped by the window, which is
 * visible, instead of being scrolled off it, which is not.
 */
export function menuPosition(
  at: { x: number; y: number },
  size: { w: number; h: number },
  vp: { w: number; h: number },
): { x: number; y: number } {
  const x = at.x + size.w > vp.w - MENU_MARGIN ? at.x - size.w : at.x;
  const y = at.y + size.h > vp.h - MENU_MARGIN ? at.y - size.h : at.y;
  return {
    x: clamp(x, vp.w - size.w - MENU_MARGIN),
    y: clamp(y, vp.h - size.h - MENU_MARGIN),
  };
}

/** Into `[MENU_MARGIN, max]`, with the margin winning when `max` is below it. */
function clamp(v: number, max: number): number {
  return Math.max(MENU_MARGIN, Math.min(v, max));
}

/**
 * Which entry the arrows move to: `from + step`, wrapping in BOTH directions
 * (down off the last returns to the first, up off the first returns to the
 * last). `Home` and `End` do not come through here — they are 0 and
 * `count - 1`, and a wrap has nothing to say about them.
 *
 * Disabled entries are not skipped (user decision 3): they are reachable, and
 * reading their sentence is the point. An empty menu answers 0, which no
 * caller can build — `itemsFor` never returns an empty list — but a total
 * function beats a thrown one for a roving-focus index.
 */
export function nextItem(count: number, from: number, step: number): number {
  if (count === 0) return 0;
  return (((from + step) % count) + count) % count;
}
