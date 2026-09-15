/**
 * Drop model (Nocturne part A9, user decisions 2026-09-15) — the pure rules
 * behind dropping files and folders from Windows Explorer into the app: how
 * many things are being dragged, what they are called together, which of them
 * already exist at the destination, what a "keep both" copy is named, and what
 * the dialog says while and after it pretends to copy.
 *
 * No DOM, no state, no browser: every value a rule needs is handed in
 * (`.claude/PLAN-A9.md` §5), so `node --test` drives all of it and the drag
 * layer (part A9 brief 2) can be tested without a browser.
 *
 * NOTHING HERE COPIES ANYTHING. The whole part is the visual half; the real
 * write lives in part B10, which is also where `MAX_ITEM_BYTES` becomes a
 * server-side check instead of a sentence. The outcomes this module plans are
 * what the copy WILL look like, which is why the dialog carries its honesty
 * line beside them.
 *
 * Copy rules this file enforces, not just follows:
 * - A PATH NEVER REACHES A LABEL (PROJECT-SCOPE, 2026-07-25). Every
 *   destination is a NAME (`Home`, a project's name, a folder's name) and
 *   every item is a top-level name, so no string this module builds can carry
 *   a `/` unless its caller put one in.
 * - COUNTS PLURALISE (`1 file` / `2 files`), and a count that is zero is not
 *   written at all: the result sentence says `Nothing copied into src.`
 *   instead of `0 copied`, and appends `1 skipped.` only when something was.
 * - Plain sentences, no decorative separators.
 */

/**
 * The biggest single file the mock pretends it can copy, and the number part
 * B10 enforces server-side. A file over it is planned as `failed` with the
 * note below, so the limit is visible before it is real.
 */
export const MAX_ITEM_BYTES = 50 * 1024 * 1024;

/**
 * How many TOP-LEVEL items one drop may carry. More than this is refused
 * whole, with one sentence, before any dialog opens (`tooMany`).
 */
export const MAX_ITEMS = 200;

/** One top-level thing being dropped, as `drop` can describe it. */
export interface DropItem {
  /** Its own name, never a path: `README.md`, `web`. */
  name: string;
  /** A folder (`webkitGetAsEntry().isDirectory`). */
  dir: boolean;
  /**
   * Size in bytes for a file (`getAsFile()?.size`), `null` for a folder and
   * for a file whose size the browser would not say. A folder never fails on
   * size: its total is a recursive walk, which is B10's job.
   */
  bytes: number | null;
}

/** What the one conflict dialog decides for EVERY conflict in that drop. */
export type Choice = 'replace' | 'keep-both' | 'skip';

/** What became of one item. */
export type Outcome = 'copied' | 'skipped' | 'failed';

/** One row of the copying/result list. */
export interface ItemResult {
  /**
   * The name that was DROPPED, always — a "keep both" row keeps saying what
   * the user dragged and puts the name it landed under in `note`, so the list
   * can still be read against Explorer's own window.
   */
  name: string;
  state: Outcome;
  /** `larger than the copy limit`, `saved as report (2).md`. */
  note?: string;
  /**
   * Folder or file. Additive to PLAN-A9 §5's shape (which `resultText` could
   * not otherwise honour: `Copied 2 files and 1 folder into src.` needs to
   * know which is which). `planResults` always sets it; a hand-built result
   * that omits it falls back to counting `items`.
   */
  dir?: boolean;
}

/** The note a file over the size limit carries. */
const TOO_BIG_NOTE = 'larger than the copy limit';

/** What the ghost says when the pointer is over nothing that can take a drop. */
export const DROP_HINT = 'Drop on a folder or a pane.';

// ---------------------------------------------------------------------------
// The drag itself
// ---------------------------------------------------------------------------

/**
 * Is this an EXTERNAL drag carrying files? During `dragover` Chromium exposes
 * nothing but `dataTransfer.types`, so this one string is the whole test
 * (measured, PLAN-A9 §"Facts checked").
 */
export function hasFiles(types: readonly string[]): boolean {
  return types.includes('Files');
}

/** More top-level items than one drop may carry. */
export function tooMany(n: number): boolean {
  return n > MAX_ITEMS;
}

/**
 * `1 item` / `3 items` — what a drag can honestly say about itself before the
 * drop, when the browser will not yet say whether any of them is a folder.
 */
export function dragCountText(n: number): string {
  return `${n} ${n === 1 ? 'item' : 'items'}`;
}

/** `Copy 1 item into src` / `Copy 3 items into src` — the ghost's line. */
export function destLine(n: number, dest: string): string {
  return `Copy ${dragCountText(n)} into ${dest}`;
}

/**
 * `1 file`, `2 files`, `1 folder`, `2 files and 1 folder` — what the items
 * ARE, which is only knowable after the drop.
 *
 * An empty list answers `0 items`; the UI never asks (a drop with nothing in
 * it opens no dialog), but a total function beats a thrown one here.
 */
export function itemsText(items: readonly DropItem[]): string {
  let files = 0;
  let folders = 0;
  for (const it of items) {
    if (it.dir) folders += 1;
    else files += 1;
  }
  return countPhrase(files, folders);
}

/** `2 files`, `1 folder`, `2 files and 1 folder`, and `0 items` for neither. */
function countPhrase(files: number, folders: number): string {
  const filePart = `${files} ${files === 1 ? 'file' : 'files'}`;
  const folderPart = `${folders} ${folders === 1 ? 'folder' : 'folders'}`;
  if (files > 0 && folders > 0) return `${filePart} and ${folderPart}`;
  if (files > 0) return filePart;
  if (folders > 0) return folderPart;
  return '0 items';
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/**
 * Which dropped names already exist at the destination.
 *
 * `listing` is the destination folder's own TOP-LEVEL names — not paths, not a
 * recursive walk — and the match is EXACT and case-sensitive: this app runs on
 * a Linux file system, where `README.md` and `readme.md` are two files, and
 * claiming a conflict that is not one would overwrite the wrong thing in B10.
 * Order follows the dropped items, so the dialog names them in the order the
 * list shows them.
 */
export function conflictsOf(items: readonly DropItem[], listing: readonly string[]): string[] {
  const here = new Set(listing);
  return items.filter((it) => here.has(it.name)).map((it) => it.name);
}

/**
 * `README.md already exists in src` (one) / `3 items already exist in src`
 * (more) — one sentence per drop, naming the COUNT instead of offering an
 * "apply to all" checkbox (user decision 2, 2026-09-15: the choice always
 * covers the whole drop).
 *
 * No conflicts is not a state the dialog has; the wording stays true anyway.
 */
export function conflictTitle(conflicts: readonly string[], dest: string): string {
  if (conflicts.length === 0) return `Nothing already exists in ${dest}`;
  if (conflicts.length === 1) return `${conflicts[0] as string} already exists in ${dest}`;
  return `${conflicts.length} items already exist in ${dest}`;
}

/**
 * The name a "keep both" copy gets, the way Explorer names it:
 * `report.md` → `report (2).md` → `report (3).md` … until one is free.
 *
 * Details that are the point:
 * - The extension is everything from the LAST dot, so `archive.tar.gz` becomes
 *   `archive.tar (2).gz` and a dot-less name (`web`, `LICENSE`) just grows a
 *   suffix: `web (2)`. A leading dot is part of the name, never an extension:
 *   `.gitignore` → `.gitignore (2)`, never ` (2).gitignore`.
 * - A name that already carries ` (n)` INCREMENTS past it instead of nesting:
 *   `report (2).md` → `report (3).md`, never `report (2) (2).md`.
 * - A name nothing has taken is returned unchanged. The caller only asks about
 *   a conflict, but that keeps this total, and it is what lets `planResults`
 *   feed its own allocations back in without inventing suffixes.
 */
export function keepBothName(name: string, taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has(name)) return name;

  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';

  const already = /^(.*) \((\d+)\)$/.exec(stem);
  const base = already === null ? stem : (already[1] as string);
  let n = already === null ? 2 : Number(already[2]) + 1;

  let candidate = `${base} (${n})${ext}`;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${base} (${n})${ext}`;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// The mock copy
// ---------------------------------------------------------------------------

/**
 * What the copy WOULD do, item by item, for one drop and one conflict choice.
 * Read top to bottom, that is the order of the questions:
 *
 *   1. It conflicts and the choice was `skip`   → `skipped`, nothing tried.
 *   2. It is a FILE over `MAX_ITEM_BYTES`       → `failed`, note the limit.
 *      (A folder carries `bytes: null` and can never fail here.)
 *   3. It conflicts and the choice was `keep-both`
 *                                               → `copied`, note `saved as …`.
 *   4. Anything else (no conflict, or `replace`, folders included)
 *                                               → `copied`.
 *
 * A conflict is decided against `listing` ALONE, so it always agrees with what
 * `conflictsOf` told the dialog. The names this plan hands out are still fed
 * back into the pool `keepBothName` avoids, so two items of one drop can never
 * be planned onto the same new name. A skipped or failed item takes no name.
 */
export function planResults(
  items: readonly DropItem[],
  listing: readonly string[],
  choice: Choice,
): ItemResult[] {
  const here = new Set(listing);
  const taken = new Set(listing);
  const out: ItemResult[] = [];

  for (const it of items) {
    const conflicts = here.has(it.name);
    if (conflicts && choice === 'skip') {
      out.push({ name: it.name, state: 'skipped', dir: it.dir });
      continue;
    }
    if (!it.dir && it.bytes !== null && it.bytes > MAX_ITEM_BYTES) {
      out.push({ name: it.name, state: 'failed', note: TOO_BIG_NOTE, dir: it.dir });
      continue;
    }
    if (conflicts && choice === 'keep-both') {
      const saved = keepBothName(it.name, [...taken]);
      taken.add(saved);
      out.push({ name: it.name, state: 'copied', note: `saved as ${saved}`, dir: it.dir });
      continue;
    }
    taken.add(it.name);
    out.push({ name: it.name, state: 'copied', dir: it.dir });
  }
  return out;
}

/**
 * The progress line under the list: `2 of 3`.
 *
 * `dest` is part of the frozen signature and deliberately NOT printed — the
 * header right above it (`copyingHeader`) already names the destination, and
 * saying it twice in one card is the kind of noise the v3 copy rules cut.
 */
export function progressText(done: number, total: number, dest: string): string {
  void dest;
  return `${done} of ${total}`;
}

/** The copying state's header: `Copying 3 items into src`. */
export function copyingHeader(n: number, dest: string): string {
  return `Copying ${dragCountText(n)} into ${dest}`;
}

/**
 * The result sentence(s):
 *
 *   `Copied 2 files into src.`
 *   `Copied 2 files and 1 folder into src. 1 skipped.`
 *   `Copied 1 file into src. 1 failed.`
 *   `Nothing copied into src. 3 skipped.`
 *
 * A zero is never written: no skips means no skip sentence. What was copied is
 * counted as files and folders when the results say which they are (everything
 * `planResults` builds), and as plain `items` when they do not.
 */
export function resultText(results: readonly ItemResult[], dest: string): string {
  const copied = results.filter((r) => r.state === 'copied');
  const skipped = results.filter((r) => r.state === 'skipped').length;
  const failed = results.filter((r) => r.state === 'failed').length;

  let head: string;
  if (copied.length === 0) {
    head = `Nothing copied into ${dest}.`;
  } else if (copied.every((r) => r.dir !== undefined)) {
    const folders = copied.filter((r) => r.dir === true).length;
    head = `Copied ${countPhrase(copied.length - folders, folders)} into ${dest}.`;
  } else {
    head = `Copied ${dragCountText(copied.length)} into ${dest}.`;
  }

  let out = head;
  if (skipped > 0) out += ` ${skipped} skipped.`;
  if (failed > 0) out += ` ${failed} failed.`;
  return out;
}
