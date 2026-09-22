/**
 * Rename model (Nocturne part B13, `.claude/plans/nocturne/PLAN-B13.md` § 2
 * Client, user decisions D1–D4 of 2026-09-22) — the pure rules behind
 * "one row gets a new name, in the same folder": which part of the old name
 * the input pre-selects, what the new path is, how every path and selection
 * key the panel holds follows the rename, who may be renamed at all, and what
 * the app says when it goes wrong.
 *
 * No DOM, no state, no browser: every value a rule needs is handed in, so
 * `node --test` drives all of it and `ui/files.ts` only wires it.
 *
 * Rules this file enforces, not just follows:
 * - SAME FOLDER ONLY. `renamedPath` swaps the LAST segment and nothing else;
 *   the request carries a name, not a destination, so a move cannot be
 *   expressed here either.
 * - A SEPARATOR BOUNDARY on every "at or under" question. `remapPath` follows
 *   a path only when it IS the old one or sits under `old + '/'`: a sibling
 *   that merely shares a prefix (`/a/bc` next to a renamed `/a/b`) is a
 *   different row and keeps its path — the trap `isUnder` in
 *   `ui/fs-model.ts` exists for.
 * - A SELECTION IS KEYS (`ui/files-select-model.ts`). `remapKeys` rewrites
 *   through `keyPath`/`keyIsDir`/`rowKey`, the one place the `fdir:`/`ffile:`
 *   prefixes are written, so a key never comes back spelled a third way.
 * - IMMUTABLE VALUES. `remapKeys` returns a NEW selection with a NEW `Set`.
 * - PLAIN WORDS, NO PATH, NO KEY NAME in any sentence (PROJECT-SCOPE,
 *   2026-07-25).
 */
import { isSentence, isUnder, joinPath, parentPath } from './fs-model.ts';
import { keyIsDir, keyPath, rowKey, type Selection } from './files-select-model.ts';

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * What a failed rename says when the server's answer is not one of its own
 * sentences (an HTTP status, a dropped connection, a stack trace). Same shape
 * as create's `The app could not create it.`.
 */
export const RENAME_FAILED_TEXT = 'The app could not rename that.';

/**
 * D4: the second line under the name row while a FOLDER with a live session
 * inside it is being renamed. The rename is allowed; this says what it costs —
 * the shell keeps the moved directory, and the app's label for it goes stale.
 */
export const RENAME_SESSION_NOTE =
  'A session is working inside this folder. It keeps running; its folder shows the old name.';

/**
 * Refused BEFORE the request: the new name (or, for a folder, a file under
 * it) already has UNSAVED text in an open tab — a tab on a file that was
 * deleted outside the app. Renaming onto it would drop that text silently,
 * which B4 never allows.
 */
export const RENAME_UNSAVED_TAKEN = 'A tab with unsaved changes is already open under that name.';

/**
 * Does any unsaved text live at `target` or under it? `editPaths` are the
 * paths of the dirty FILE tabs (`state.edits` keys with their prefix off).
 */
export function hasUnsavedAt(editPaths: readonly string[], target: string): boolean {
  return editPaths.some((p) => p === target || p.startsWith(`${target}/`));
}

/**
 * The sentence a failed rename renders: the server's own (`isSentence` — D1's
 * `Something with that name already exists here.` among them), or the app's.
 */
export function renameMessage(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const e = err as { message?: unknown };
    if (typeof e.message === 'string' && isSentence(e.message)) return e.message;
  }
  return RENAME_FAILED_TEXT;
}

// ---------------------------------------------------------------------------
// Who may be renamed
// ---------------------------------------------------------------------------

/**
 * D2 + the single-row default: a row that is not `renamable` (home, the panel
 * root, a project root, a folder containing one) never; a multi-selection
 * never — the entry is absent and F2 does nothing. Exactly one renamable row.
 */
export function canRename(row: { renamable: boolean; count: number }): boolean {
  return row.renamable && row.count === 1;
}

/**
 * D2's second half: does `folder` hold a registered project — one of
 * `projectPaths` equal to it or under `folder + '/'`? Such a folder is an
 * anchor for RENAME (not for delete, which B10a's rule decides): renaming it
 * would move the project away from the path it is registered at. Trailing
 * slashes on either side are ignored; a prefix sibling (`/a/bc` for `/a/b`)
 * is not inside. The caller combines it with its own `isAnchor`.
 */
export function containsProject(folder: string, projectPaths: readonly string[]): boolean {
  return projectPaths.some((p) => isUnder(p, folder));
}

// ---------------------------------------------------------------------------
// The input
// ---------------------------------------------------------------------------

/** A `setSelectionRange` pair: `[start, end)` in UTF-16 code units. */
export interface TextRange {
  start: number;
  end: number;
}

/**
 * What the pre-filled input selects on first focus.
 *
 * A FOLDER: the whole name — a folder has no extension to protect. A FILE: the
 * part before the LAST dot, so typing replaces the stem and keeps `.ts`. The
 * stem must hold at least one character that is not a dot, otherwise there is
 * no stem, only a dot-file's own name, and the whole name is selected:
 * `.env` and `..x` whole, `.env.local` → `.env`, `README` whole, `foo.` →
 * `foo` (the empty extension is kept like any other).
 */
export function stemRange(name: string, isDir: boolean): TextRange {
  const whole = { start: 0, end: name.length };
  if (isDir) return whole;
  const dot = name.lastIndexOf('.');
  if (dot === -1) return whole;
  const stem = name.slice(0, dot);
  return /[^.]/.test(stem) ? { start: 0, end: dot } : whole;
}

/**
 * Is `name` the name `path` already has? Then a commit sends no request and the
 * row just closes. Exact comparison on purpose: a CASE-only change (`readme` →
 * `README`) is a real rename, also on case-insensitive drvfs.
 */
export function isSameName(path: string, name: string): boolean {
  return lastSegment(path) === name;
}

/** The last segment of an absolute path, trailing slashes ignored. */
function lastSegment(path: string): string {
  const parts = path.split('/').filter((s) => s !== '');
  return parts[parts.length - 1] ?? '';
}

// ---------------------------------------------------------------------------
// Paths and keys
// ---------------------------------------------------------------------------

/**
 * The path `old` has after it is renamed to `name`: same parent, new last
 * segment. `name` has already passed `nameProblem`, so it is one segment.
 * `/a/b` + `c` → `/a/c`; `/b` + `c` → `/c`.
 */
export function renamedPath(old: string, name: string): string {
  return joinPath(parentPath(old), name);
}

/**
 * Where `p` is after `from` became `to`: `to` when `p` IS `from`, `to` plus
 * the rest when `p` is under `from + '/'`, and `p` itself otherwise — a prefix
 * sibling included (`/a/bc` does not follow `/a/b`).
 */
export function remapPath(p: string, from: string, to: string): string {
  if (p === from) return to;
  if (p.startsWith(`${from}/`)) return to + p.slice(from.length);
  return p;
}

/**
 * The selection after `from` became `to`: every tree key whose path is at or
 * under `from` points at the new path, with its own kind kept (a folder key
 * stays `fdir:`, a file key `ffile:`), and the anchor follows the same way.
 * A key that is not a tree row has no path and is kept as it is.
 */
export function remapKeys(sel: Selection, from: string, to: string): Selection {
  const keys = new Set<string>();
  for (const key of sel.keys) keys.add(remapKey(key, from, to));
  const anchor = sel.anchor === null ? null : remapKey(sel.anchor, from, to);
  return { keys, anchor };
}

function remapKey(key: string, from: string, to: string): string {
  const path = keyPath(key);
  if (path === '') return key;
  return rowKey(remapPath(path, from, to), keyIsDir(key));
}

/**
 * D4: is any live session working at or under `folder`? `isUnder` keeps the
 * separator boundary (a session in `/a/bc` is not inside `/a/b`) and ignores
 * trailing slashes, which a session's cwd may carry.
 */
export function hasSessionInside(cwds: readonly string[], folder: string): boolean {
  return cwds.some((cwd) => isUnder(cwd, folder));
}
