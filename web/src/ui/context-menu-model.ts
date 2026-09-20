/**
 * Context-menu model (Nocturne part A9b user decision 3, widened by part A9c,
 * `.claude/plans/nocturne/PLAN-A9b.md` §3 and §5, `.claude/plans/nocturne/PLAN-B2.md` §6a) — what a
 * right-click on a Files-panel row offers, what the background of that panel
 * offers, what each menu is called for a screen reader, where it opens so it
 * is always whole on screen, and where the arrow keys go next.
 *
 * No DOM, no state, no browser. The geometry in particular HAS to be pure:
 * `tests/fake-dom.ts` measures nothing (`getBoundingClientRect` answers only
 * the rect a test set), so a menu that positioned itself by reading the
 * document could not be tested at all. The DOM half (`ui/context-menu.ts`)
 * measures once after appending and applies the point this function returns.
 *
 * Copy rules this file enforces, not just follows:
 * - LABELS ARE PLAIN WORDS (PROJECT-SCOPE, 2026-07-25): `Open`, `Close`,
 *   `Copy`, `Paste`, `Open beside`, `New file`, `New folder`, `Refresh`,
 *   `Delete`. No commands, no flags, no key names, no icons, no counts — a
 *   list this short reads as a list, and nothing on it is a plural of
 *   something else. `Delete` carries no count either: the QUESTION counts
 *   (`ui/delete-model.ts`), the entry only names the act.
 * - ONE SEPARATOR, AND ONLY BEFORE `Delete` (B10a). The A9b rule was "no
 *   separators" and this is the one amendment to it, with its reason: every
 *   other entry can be taken back by doing something else, and this one
 *   cannot — the hairline is what says so before the pointer arrives. It is
 *   drawn by `ui/context-menu.ts` as a `div.cm-sep` appended to the box, not
 *   as an entry, so the arrow keys never stop on it.
 * - HONESTY ABOUT WHAT IS NOT BUILT: `Paste` is visible and DISABLED, with one
 *   plain sentence saying why — a page cannot read files off the clipboard
 *   outside a `paste` event, which is a keystroke, and that route really does
 *   work (§2), so the sentence points at it. `Copy` became real in part B10,
 *   in the NATIVE window only: `canCopy` answers whether this window has a
 *   host to ask, and a window without one keeps the entry visible and disabled
 *   with a sentence about the window, not about the app.
 * - A PATH NEVER REACHES A LABEL: `menuLabel` takes the row's NAME, and the
 *   caller is the one that reduced a path to it (`selectedName`).
 */
import { COPY_LABEL } from './files-select-model.ts';

/** What one entry does when it is chosen. */
export type MenuAction =
  | 'toggle'
  | 'open'
  | 'open-beside'
  | 'copy'
  | 'paste'
  | 'copy-files'
  | 'new-file'
  | 'new-folder'
  | 'refresh'
  | 'delete';

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
  /**
   * This entry cannot be taken back (B10a: `Delete`, and nothing else so far).
   * The DOM half writes it as danger INK on the label — never a red ground,
   * which would make the list read as a warning instead of as a list.
   */
  danger?: true;
  /**
   * A hairline is drawn ABOVE this entry. The one amendment to A9b's "no
   * separators" rule, and it exists for exactly the entries `danger` marks:
   * the gap is the last thing between a pointer moving down the list and a
   * permanent delete.
   */
  separated?: true;
}

/** The row the menu was opened on, reduced to what the entries depend on. */
export interface RowSubject {
  /** A folder row. A file row offers a different, shorter list. */
  dir: boolean;
  /** The row's own NAME, never its path. */
  name: string;
  /** Is this folder open right now? Decides `Open` vs `Close`. */
  open: boolean;
  /**
   * Can this window put files on the clipboard at all (part B10)? It is the
   * native host's channel or nothing (`ui/host-bridge.ts` `hasHostBridge()`),
   * and the caller answers it at menu-open time. False keeps `Copy` visible
   * and disabled, with the sentence below.
   */
  canCopy: boolean;
  /**
   * May this row be deleted at all (B10a)? False for the panel's own root and
   * for every registered project folder — the anchors, which the SERVER
   * refuses too (`server/fsdelete.ts`). It is a best-effort answer painted
   * from what the app knows: the server is the authority, and a row that is
   * offered `Delete` can still come back with a refusal sentence.
   */
  deletable: boolean;
  /**
   * How many rows the act would really be about — the whole selection when
   * this row is in it, otherwise 1 (Explorer's rule, `itemsFor` in
   * `ui/delete-model.ts`). It is spent on the menu's accessible NAME and on
   * nothing else: no entry label carries a count.
   */
  count: number;
}

/**
 * Why `Copy` does nothing HERE. Part B10 made it real in the native window;
 * an Edge `--app` window has no channel to a process that owns a clipboard,
 * and there is no second-best to offer — a "Copy" that produced a path as
 * TEXT would be a different promise, and pasting text into Explorer's file
 * list does nothing at all.
 *
 * It says `This window`, not `The app`: the very same app in the native
 * window can, and the sentence has to stay true in both.
 */
export const COPY_NOTE = 'This window cannot put files on the clipboard.';

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
 * entries (`Copy`, real in the native window since B10; `Paste`, never from a
 * menu), the destination gesture that IS built (`Copy files here…`, the same
 * words as the copy strip's own button, because they do the same thing to the
 * same folder) and — since A9c — the three that make or re-read its contents
 * (`makeEntries`).
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
      copyEntry(row.canCopy),
      { action: 'paste', label: 'Paste', enabled: false, note: PASTE_NOTE },
      { action: 'copy-files', label: COPY_LABEL, enabled: true },
      ...makeEntries(),
      ...deleteEntry(row.deletable),
    ];
  }
  return [
    { action: 'open', label: 'Open', enabled: true },
    { action: 'open-beside', label: 'Open beside', enabled: true },
    copyEntry(row.canCopy),
    ...deleteEntry(row.deletable),
  ];
}

/**
 * `Delete`, or nothing at all (B10a). An ANCHOR — the panel's own root, a
 * registered project folder — is NOT offered a disabled entry with a sentence
 * under it: `Paste` and `Copy` are disabled because the act exists and cannot
 * run HERE, and the honest answer for an anchor is that this row has no delete
 * at all. A list that ends in a greyed `Delete` on the folder the panel is
 * standing in would read as "it might work next time".
 *
 * It is the LAST entry of both lists, behind a hairline, and its label is the
 * plain word: the count is the confirmation's business.
 */
function deleteEntry(deletable: boolean): MenuItem[] {
  if (!deletable) return [];
  return [{ action: 'delete', label: 'Delete', enabled: true, danger: true, separated: true }];
}

/**
 * `Copy`, in the one shape both lists use. A folder and a file are copied the
 * identical way (`SetFileDropList` takes a tree the way Explorer does), so
 * there is one entry and one answer to whether it works here.
 *
 * An ENABLED entry carries no note: the sentence exists to explain a refusal,
 * and an entry that does what it says needs no explanation.
 */
function copyEntry(canCopy: boolean): MenuItem {
  if (canCopy) return { action: 'copy', label: 'Copy', enabled: true };
  return { action: 'copy', label: 'Copy', enabled: false, note: COPY_NOTE };
}

/**
 * The three entries a FOLDER answers and a file cannot (part A9c, §6a): make
 * something in it, or read it again.
 *
 * NO ELLIPSIS on `New file` and `New folder`, and that is a statement rather
 * than a shortening: the app's `…` means "a dialog follows" (`Copy files
 * here…`, and the launch dialog's own buttons), and these two open NO dialog —
 * they put a name row in the tree, in the folder they were chosen on. An
 * ellipsis here would promise the one thing §6b refuses to build.
 *
 * `Refresh` is the honest name for what the panel already does on every
 * expand: ask that folder again. It carries no key name, because it has no
 * chord — the menu is the whole affordance.
 */
function makeEntries(): MenuItem[] {
  return [
    { action: 'new-file', label: 'New file', enabled: true },
    { action: 'new-folder', label: 'New folder', enabled: true },
    { action: 'refresh', label: 'Refresh', enabled: true },
  ];
}

/**
 * The entries for the panel's ROOT — the menu a right-click on the tree's
 * background opens (§6a), and the keyboard twin of it.
 *
 * It is the FOLDER list minus the two entries that need a row to act on: the
 * root has no row, so there is nothing to `Open`/`Close` (it is the whole
 * tree, always open), and `Copy` would have to put the root itself on the
 * clipboard. What is left is everything that is about the folder's CONTENTS,
 * which is exactly what the background of a file tree is about.
 *
 * `name` is the root's own name — the one the header prints — and it is
 * deliberately NOT spent on a label: `Copy files here…` is the copy strip's
 * own words for the same gesture, and repeating a name that is already on
 * screen twice over would be the menu talking about itself. It names the MENU
 * instead (`rootMenuLabel`), which is where a screen reader needs it, and the
 * parameter is kept so both halves of one menu are asked for the same way.
 */
export function itemsForRoot(name: string): MenuItem[] {
  void name;
  // No `Delete` either (B10a): the root IS an anchor — the folder the panel is
  // standing in, which the server refuses to delete — and the root menu has
  // never offered anything that acts on the folder itself.
  return [{ action: 'copy-files', label: COPY_LABEL, enabled: true }, ...makeEntries()];
}

/**
 * The menu's accessible name: `actions for src` — and, when the act covers
 * more than the row it was opened on, `actions for 3 selected items` (B10a).
 *
 * Lower case and plain, so a screen reader reads it as the continuation of the
 * row it was opened from rather than as a title nobody asked for. THE COUNT
 * LIVES HERE AND NOWHERE ELSE on the menu: with five rows chosen, naming one
 * of them would be the menu describing a fifth of what it is about — and the
 * app has no `role="tree"`/`aria-multiselectable` to say it structurally
 * (recorded limitation, `memory/decisions/b10a-multi-select-and-delete.md`),
 * so this sentence is how a screen reader hears the selection at all.
 */
export function menuLabel(row: RowSubject): string {
  if (row.count > 1) return `actions for ${row.count} selected items`;
  return `actions for ${row.name}`;
}

/**
 * The ROOT menu's accessible name: `actions for api` — the same sentence shape
 * a row's menu carries, over the name the header is already printing. A screen
 * reader hears the two menus as one vocabulary, and the root is named the way
 * the panel names it out loud, never by its path.
 */
export function rootMenuLabel(name: string): string {
  return `actions for ${name}`;
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
