/**
 * Files-panel selection model (Nocturne part B10a, user decision 2026-09-20,
 * `memory/decisions/b10a-multi-select-and-delete.md`) — the pure rules behind
 * "MANY rows are chosen, and files land where the ANCHOR points": what a
 * click, a ctrl+click, a shift+range, a ctrl+a, a context menu, an Escape, a
 * hidden panel, a root change and a finished delete do to the selection, what
 * the destination of a paste is, what a destination is called, what the copy
 * strip says about it, and whether a `paste` event belongs to the app at all.
 *
 * It replaces A9b's "exactly one FOLDER is selected" (2026-09-16): a selection
 * is now a SET of tree rows — files and folders, which may sit under different
 * parents — plus the ANCHOR, the row the next shift-range measures from and
 * the row that answers "where do files land".
 *
 * No DOM, no state, no browser: every value a rule needs is handed in, so
 * `node --test` drives all of it and the panel can be rewired without
 * re-deciding any of these questions. The selection itself lives as
 * module-instance state in `ui/files.ts` — it is not server state, it is not
 * persisted, and `state.ts` does not change by one line for it.
 *
 * Rules this file enforces, not just follows:
 * - A SELECTION IS KEYS, A LABEL IS A NAME. The set holds the tree's own row
 *   keys (`fdir:<path>` / `ffile:<path>`), because that is what identifies a
 *   row across rebuilds and what tells a folder apart from a file of the same
 *   path shape; every string this module builds carries only a NAME
 *   (PROJECT-SCOPE, 2026-07-25: a path never reaches a label).
 * - IMMUTABLE VALUES. Every transition returns a NEW `Selection` with a NEW
 *   `Set`; nothing here mutates the value it was handed, so the panel can hold
 *   an old selection beside a new one (a repaint, an undo of a gesture) and
 *   compare them with `!==`.
 * - ONE ANCHOR, ONE DESTINATION. A multi-selection could point anywhere, so it
 *   points at exactly one place: `destinationPath` reads the ANCHOR and
 *   nothing else — the folder itself when the anchor is a folder, its parent
 *   when the anchor is a file.
 * - HONESTY: a destination that cannot be NAMED is not named. `copyStripLabel`
 *   takes the destination PATH and reduces it to a name itself; a root path
 *   has no last segment, so it falls back to the unnamed wording rather than
 *   printing a `/` or an empty gap where a folder should be.
 * - ONE WORDING for the strip, its title and the drag ghost — `copyIntoText`
 *   lives here (moved from `ui/filedrop.ts`, which re-exports it) so the
 *   button and the ghost can never promise different things about the same
 *   destination.
 */
import { isUnder, parentPath } from './fs-model.ts';

// ---------------------------------------------------------------------------
// Row keys — the tree's own identity
// ---------------------------------------------------------------------------

/** The `data-k` prefix `ui/files.ts` gives a FOLDER row. */
const DIR_PREFIX = 'fdir:';
/** The `data-k` prefix `ui/files.ts` gives a FILE row. */
const FILE_PREFIX = 'ffile:';

/** Is this one of the tree's own row keys (and not `Loading…`, a refusal, a
 *  name row, or any other STATE row the panel also paints)? */
function isTreeKey(key: string): boolean {
  return key.startsWith(DIR_PREFIX) || key.startsWith(FILE_PREFIX);
}

/**
 * The PATH inside a row key, or `''` for anything that is not a tree row.
 *
 * The empty string is the refusal, not a guess: a state row has no path, and
 * answering one of the panel's real folders for it is how a delete or a paste
 * would land somewhere nobody pointed at.
 */
export function keyPath(key: string): string {
  if (key.startsWith(DIR_PREFIX)) return key.slice(DIR_PREFIX.length);
  if (key.startsWith(FILE_PREFIX)) return key.slice(FILE_PREFIX.length);
  return '';
}

/** Is this key a FOLDER row? (A file row, and every non-tree key, is not.) */
export function keyIsDir(key: string): boolean {
  return key.startsWith(DIR_PREFIX);
}

/**
 * The row KEY of a path — the inverse of `keyPath`/`keyIsDir`, and the ONE
 * place the two prefixes are written.
 *
 * `ui/files.ts` paints it as `data-k`, reads the selection by it and sends the
 * delete by it, so a key built in three spellings is a selection that paints
 * one row and deletes another.
 */
export function rowKey(path: string, dir: boolean): string {
  return `${dir ? DIR_PREFIX : FILE_PREFIX}${path}`;
}

// ---------------------------------------------------------------------------
// The value
// ---------------------------------------------------------------------------

/**
 * What is selected: the row KEYS, plus the ANCHOR.
 *
 * The anchor is a member of `keys` in every selection this module builds
 * except the empty one — `without` and `prunedTo` clear it rather than leave
 * it pointing at a row that is gone. It is what a shift-range measures from
 * and what `destinationPath` reads, so a selection with rows but no anchor
 * (never produced here) simply has no destination.
 */
export interface Selection {
  readonly keys: ReadonlySet<string>;
  readonly anchor: string | null;
}

/** Nothing selected. Shared and frozen: every transition builds a new value. */
export const EMPTY: Selection = Object.freeze({
  keys: new Set<string>(),
  anchor: null,
});

export function isSelected(sel: Selection, key: string): boolean {
  return sel.keys.has(key);
}

export function size(sel: Selection): number {
  return sel.keys.size;
}

/** One row, and it becomes the anchor. */
function only(key: string): Selection {
  return { keys: new Set([key]), anchor: key };
}

// ---------------------------------------------------------------------------
// The gestures
// ---------------------------------------------------------------------------

/**
 * A row was ACTIVATED (a primary click, or Enter/Space on it — the row is a
 * `<button>`, so the gesture has its keyboard twin for free).
 *
 * THIS ROW ALONE, whatever was selected before, and it becomes the anchor:
 * a plain click is how a user throws a multi-selection away. For a folder the
 * CALLER also toggles it open or closed; those are two independent effects of
 * one gesture, which is why a re-activation keeps the row selected instead of
 * deselecting it — the toggle is what flips, the selection is not.
 *
 * Unlike A9b a FILE row selects too (B10a): a file is something the user can
 * now delete, and the anchor's parent is then where files land.
 */
export function afterRowActivate(sel: Selection, key: string): Selection {
  void sel;
  // A STATE row (`Loading…`, a refusal) and the name row are not rows anybody
  // can act on, so activating one selects NOTHING rather than putting a key
  // with no path into the set.
  if (!isTreeKey(key)) return EMPTY;
  return only(key);
}

/**
 * ctrl+click, or ctrl+space on a focused row: the row goes IN or OUT, and the
 * rest of the selection is untouched.
 *
 * THE ANCHOR MOVES EITHER WAY — to the row the user just touched, including
 * the row they just removed. Explorer does the same, and it is what makes a
 * following shift-range measure from the place the hand actually is.
 */
export function afterToggle(sel: Selection, key: string): Selection {
  const keys = new Set(sel.keys);
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  return { keys, anchor: key };
}

/**
 * shift+click, or shift+arrow: the whole run from the ANCHOR to `key` in
 * `visible` (the panel's tree order, top to bottom), REPLACING the selection.
 *
 * The anchor STAYS WHERE IT WAS, so shift-clicking a second time re-measures
 * from the same row instead of growing the range one end at a time.
 *
 * Two degenerate cases answer with a plain activation of `key` rather than
 * with a guess: no anchor at all, and an anchor or a `key` that is not on
 * screen (a collapsed parent, a row a refresh removed). A range needs two
 * visible ends.
 */
export function afterRange(sel: Selection, key: string, visible: readonly string[]): Selection {
  const anchor = sel.anchor;
  if (anchor === null) return only(key);
  const from = visible.indexOf(anchor);
  const to = visible.indexOf(key);
  if (from === -1 || to === -1) return only(key);
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return { keys: new Set(visible.slice(lo, hi + 1)), anchor };
}

/**
 * ctrl+a inside the panel: every VISIBLE row — never a row hidden inside a
 * collapsed folder, which is the only reading of "all" the user can see.
 *
 * The anchor is kept when it is still visible (the destination does not move
 * under a select-all), and falls back to the first row otherwise.
 */
export function afterSelectAll(sel: Selection, visible: readonly string[]): Selection {
  const keys = new Set(visible);
  const anchor = sel.anchor !== null && keys.has(sel.anchor) ? sel.anchor : (visible[0] ?? null);
  return { keys, anchor };
}

/**
 * A context menu was opened on a row (a right-click, the menu key, or
 * Shift+F10).
 *
 * A row ALREADY IN the selection changes nothing — right-clicking one of five
 * chosen files is how the user asks for an act on all five, so the menu must
 * not shrink the selection to the row under the pointer (Explorer's rule, and
 * the rule `ui/delete-model.ts` then reads in `itemsFor`).
 *
 * Any other row becomes the selection, and the anchor: the menu is about the
 * row it opened on, and the entry that names a destination must name that one.
 */
export function afterMenuOpen(sel: Selection, key: string): Selection {
  if (isSelected(sel, key)) return sel;
  return only(key);
}

/**
 * Escape was pressed INSIDE the panel. The selection is the first thing that
 * key spends itself on (`ui/files.ts` owns it there and stops the key only
 * while something was selected, so a second Escape still closes the panel
 * through `main.ts`'s ladder).
 */
export function afterEscape(sel: Selection): Selection {
  void sel;
  return EMPTY;
}

/**
 * The panel left the screen (the Files toggle, or the Projects drawer hiding
 * it).
 *
 * HONESTY, not tidiness: with the selection alive a paste from a focused
 * TERMINAL lands in the anchor's folder, and a destination nobody can see must
 * never silently accept files. No panel, no selection — and no delete target
 * either.
 */
export function afterPanelHidden(sel: Selection): Selection {
  void sel;
  return EMPTY;
}

/**
 * The panel's ROOT changed (a project switch, a step up or down the tree).
 *
 * Everything not under `root` leaves — path prefix with a `/` boundary, or the
 * root itself (`isUnder` in `ui/fs-model.ts`, so `/home/userevil` is not under
 * `/home/user` here either). A key that is not a tree row has no path and so
 * is never under anything: it leaves too. The anchor leaves with its row, and
 * then there is no destination until the user points at one again.
 */
export function prunedTo(sel: Selection, root: string): Selection {
  const keys = new Set<string>();
  for (const key of sel.keys) {
    if (isTreeKey(key) && isUnder(keyPath(key), root)) keys.add(key);
  }
  const anchor = sel.anchor !== null && keys.has(sel.anchor) ? sel.anchor : null;
  return { keys, anchor };
}

/**
 * What is left after these keys are DONE with (deleted, and — later — moved or
 * renamed): they leave the selection, and the anchor leaves with them when it
 * was among them.
 *
 * The keys that are NOT done stay selected on purpose: after a partial delete
 * the failures are what is still there, and leaving them selected is how the
 * panel can say which ones without naming a path
 * (`failedKeys` in `ui/delete-model.ts`).
 */
export function without(sel: Selection, done: readonly string[]): Selection {
  const gone = new Set(done);
  const keys = new Set<string>();
  for (const key of sel.keys) if (!gone.has(key)) keys.add(key);
  const anchor = sel.anchor !== null && !gone.has(sel.anchor) ? sel.anchor : null;
  return { keys, anchor };
}

// ---------------------------------------------------------------------------
// Where files land
// ---------------------------------------------------------------------------

/**
 * WHERE FILES LAND with a selection: the ANCHOR's own path when the anchor is
 * a folder, the anchor's PARENT when it is a file. Null with no anchor, and
 * null for an anchor that is not a tree row (it has no path to fall back on).
 *
 * One row of a many-row selection decides, and it is the one the user touched
 * last: a set of rows spread over several folders has no other honest answer,
 * and "the folder the file you just clicked is in" is the answer a file
 * manager gives.
 */
export function destinationPath(sel: Selection): string | null {
  const anchor = sel.anchor;
  if (anchor === null) return null;
  const path = keyPath(anchor);
  if (path === '') return null;
  return keyIsDir(anchor) ? path : parentPath(path);
}

// ---------------------------------------------------------------------------
// Naming a destination
// ---------------------------------------------------------------------------

/**
 * What a destination PATH is CALLED: its last segment, or nothing when the
 * path names nothing that can be spoken about — the empty string, and a root
 * path (`/`), which has no last segment at all.
 *
 * Trailing slashes are stripped first, so `/home/you/src/` and `/home/you/src`
 * are one folder with one name. Nothing else is interpreted: the tree hands
 * out the paths, this only reads them. A bare NAME (no separator at all)
 * answers itself, which is what lets `copyStripLabel` take either.
 */
export function selectedName(path: string | null): string | null {
  if (path === null) return null;
  let p = path;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  const cut = p.lastIndexOf('/');
  const name = cut === -1 ? p : p.slice(cut + 1);
  return name === '' ? null : name;
}

/**
 * What the copy strip's button says with NO destination — the A9 wording,
 * unchanged, because with no selection the destination is still the A9
 * fallback chain (the folder row that last held the keyboard, else the panel
 * root, else the active tab's root).
 */
export const COPY_LABEL = 'Copy files here…';

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
 * The copy strip's VISIBLE label: `Copy files here…` with no destination,
 * `Copy files into src…` with one.
 *
 * It takes the destination PATH (`destinationPath(sel)`) and reduces it to a
 * NAME here, so the one place a path could leak into a label is this single
 * function rather than every caller. A destination that cannot be named — the
 * empty string, a root path — falls back to the constant: an unnamed
 * destination is better than a label with a hole in it. (A bare name answers
 * itself, so passing one is harmless.)
 */
export function copyStripLabel(destPath: string | null): string {
  const name = selectedName(destPath);
  if (name === null) return COPY_LABEL;
  return `${copyIntoText(name)}…`;
}

// ---------------------------------------------------------------------------
// The paste rule
// ---------------------------------------------------------------------------

/** Everything the paste rule reads, at the moment the `paste` event fires. */
export interface PasteContext {
  /** The clipboard carries FILES (`clipboardData.files.length > 0`). */
  files: boolean;
  /** Something is selected in the Files panel (so there is a destination). */
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
 * - FILES plus a SELECTED row is ours from anywhere, a focused terminal and a
 *   focused field included (user decision 2): files carry no text, so nothing
 *   was going to be typed anyway, and the selection is what makes the
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
