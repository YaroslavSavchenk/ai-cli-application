/**
 * Files-panel selection model (Nocturne part A9b, user decisions 2026-09-16,
 * `.claude/PLAN-A9B.md` §1, §2 and "Orchestrator defaults") — the pure rules
 * behind "one folder is chosen, and files land in THAT folder": what a click,
 * a context menu, an Escape and a hidden panel do to the selection, what the
 * selected folder is called, what the copy strip says about it, and whether a
 * `paste` event belongs to the app at all.
 *
 * No DOM, no state, no browser: every value a rule needs is handed in, so
 * `node --test` drives all of it and the panel can be rewired without
 * re-deciding any of these questions. The selection itself lives as
 * module-instance state in `ui/files.ts` — it is not server state, it is not
 * persisted, and `state.ts` does not change by one line for it.
 *
 * NOTHING HERE COPIES ANYTHING (part B10 owns the real write, and the host
 * clipboard with it). `takesPaste` decides only whether the app takes the
 * EVENT away from the browser; what happens next is the A9 dialog, which still
 * says out loud that it is pretending.
 *
 * Rules this file enforces, not just follows:
 * - A SELECTION IS A PATH, A LABEL IS A NAME. `Selection` carries a folder
 *   PATH because that is what identifies a row across rebuilds; every string
 *   this module builds carries only its LAST SEGMENT (PROJECT-SCOPE,
 *   2026-07-25: a path never reaches a label).
 * - HONESTY: a selection that cannot be NAMED is not named. A root path has no
 *   last segment, so `copyStripLabel` falls back to the unnamed wording rather
 *   than printing a `/` or an empty gap where a folder should be.
 * - ONE WORDING for the strip, its title and the drag ghost — `copyIntoText`
 *   lives here (moved from `ui/filedrop.ts`, which re-exports it) so the
 *   button and the ghost can never promise different things about the same
 *   destination.
 */

/**
 * The selected folder's PATH, or nothing selected. Single selection only
 * (user decision 1, 2026-09-16): choosing a row replaces whatever was chosen
 * before, and there is no multi-select gesture anywhere in the panel.
 */
export type Selection = string | null;

/**
 * What the copy strip's button says with NOTHING selected — the A9 wording,
 * unchanged, because with no selection the destination is still the A9
 * fallback chain (the folder row that last held the keyboard, else the panel
 * root, else the active tab's root).
 */
export const COPY_LABEL = 'Copy files here…';

/**
 * A folder row was ACTIVATED (a primary click, or Enter/Space on it — the row
 * is a `<button>`, so the gesture has its keyboard twin for free).
 *
 * The activation selects the path and the CALLER toggles the folder open or
 * closed; those are two independent effects of one gesture (user decision 1).
 * Which is why a re-activation keeps the row selected instead of deselecting
 * it: the toggle is what flips, the selection is not — a folder the user keeps
 * clicking is emphatically the folder they mean.
 *
 * A FILE row never selects, so `ui/files.ts` calls this for folder rows only;
 * the signature takes the path alone because there is nothing else to decide.
 */
export function afterRowActivate(sel: Selection, path: string): Selection {
  void sel;
  return path;
}

/**
 * A context menu was opened on a row (a right-click, the menu key, or
 * Shift+F10).
 *
 * A folder row selects — Explorer's behaviour, and the reason the menu's
 * `Copy files here…` entry can name a folder out loud. It does NOT toggle the
 * folder: the toggle belongs to the primary click, and the menu offers
 * `Open`/`Close` as a named entry instead (`.claude/PLAN-A9B.md` §4).
 *
 * A FILE row changes nothing. Right-clicking a file is not a way to lose the
 * folder you chose for your files.
 */
export function afterMenuOpen(sel: Selection, row: { dir: boolean; path: string }): Selection {
  return row.dir ? row.path : sel;
}

/**
 * Escape was pressed INSIDE the panel. The selection is the first thing that
 * key spends itself on (`ui/files.ts` owns it there and stops the key only
 * while something was selected, so a second Escape still closes the panel
 * through `main.ts`'s ladder — the ladder is untouched by A9b).
 */
export function afterEscape(sel: Selection): Selection {
  void sel;
  return null;
}

/**
 * The panel left the screen (the Files toggle, or the Projects drawer hiding
 * it).
 *
 * HONESTY, not tidiness: with the selection alive a paste from a focused
 * TERMINAL lands in that folder (§2), and a destination nobody can see must
 * never silently accept files. No panel, no selected destination.
 */
export function afterPanelHidden(sel: Selection): Selection {
  void sel;
  return null;
}

/**
 * What the selected folder is CALLED: the last segment of its path, or nothing
 * when the path names no folder that can be spoken about — the empty string,
 * and a root path (`/`), which has no last segment at all.
 *
 * Trailing slashes are stripped first, so `/home/you/src/` and
 * `/home/you/src` are one folder with one name. Nothing else is interpreted:
 * the tree hands out the paths, this only reads them.
 */
export function selectedName(sel: Selection): string | null {
  if (sel === null) return null;
  let path = sel;
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const cut = path.lastIndexOf('/');
  const name = cut === -1 ? path : path.slice(cut + 1);
  return name === '' ? null : name;
}

/**
 * `Copy files into src` — the wording of the copy strip's title, of the menu
 * entry's title, and of the drag ghost when the browser will not say how many
 * items are being dragged. ONE definition (moved here from `ui/filedrop.ts`,
 * which re-exports it for its existing readers).
 */
export function copyIntoText(dest: string): string {
  return `Copy files into ${dest}`;
}

/**
 * The copy strip's VISIBLE label: `Copy files here…` with nothing selected,
 * `Copy files into src…` with a selection.
 *
 * Until A9b the strip showed the constant only, so the destination was
 * invisible — the thing user decision 1 is about ("it must always be obvious
 * where it lands"). A selection whose path cannot be named falls back to the
 * constant: an unnamed destination is better than a label with a hole in it.
 */
export function copyStripLabel(sel: Selection): string {
  const name = selectedName(sel);
  if (name === null) return COPY_LABEL;
  return `${copyIntoText(name)}…`;
}

/** Everything the paste rule reads, at the moment the `paste` event fires. */
export interface PasteContext {
  /** The clipboard carries FILES (`clipboardData.files.length > 0`). */
  files: boolean;
  /** A folder is selected in the Files panel. */
  selected: boolean;
  /** The event landed inside an xterm mount (`isTerminalTarget`). */
  inTerminal: boolean;
  /** The event landed in a field or a contenteditable (`isEditableTarget`). */
  inEditable: boolean;
  /** A modal dialog is up (`OPEN_MODAL_SELECTOR`). */
  modalOpen: boolean;
}

/**
 * Does this `paste` event belong to the app? (`.claude/PLAN-A9B.md` §2.)
 *
 * The app never listens for a CHORD here — it listens for the EVENT, and takes
 * whichever keystroke the browser turned into one. Read as four sentences:
 *
 * - A TEXT-ONLY clipboard is never ours. `files` is false, so a terminal's
 *   paste and a field's paste stay entirely their own, whatever else is on the
 *   clipboard — the PTY loses nothing to this rule, ever.
 * - FILES plus a SELECTED folder is ours from anywhere, a focused terminal and
 *   a focused field included (user decision 2): files carry no text, so
 *   nothing was going to be typed anyway, and the selection is what makes the
 *   destination obvious.
 * - FILES with NO selection is the A9 rule exactly: outside terminals and
 *   editables the fallback chain answers; inside one, the app does nothing at
 *   all rather than send files to a folder nobody pointed at.
 * - A MODAL up means nothing in the window takes a paste (its A9 meaning).
 *
 * The caller owes one thing this predicate cannot: when it takes a paste
 * inside a terminal it must `stopPropagation()` as well as `preventDefault()`,
 * or xterm's own textarea paste handler still runs and an Explorer clipboard
 * carrying `text/plain` beside its files types that text into the PTY
 * unbracketed.
 */
export function takesPaste(ctx: PasteContext): boolean {
  if (!ctx.files) return false;
  if (ctx.modalOpen) return false;
  return (!ctx.inTerminal && !ctx.inEditable) || ctx.selected;
}
