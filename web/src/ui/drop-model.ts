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
 * NOTHING HERE COPIES ANYTHING, and since part B10 phase 2 something else
 * does: `ui/drop-upload.ts` executes exactly the plan this module builds, and
 * `MAX_ITEM_BYTES` is the server's own `MAX_UPLOAD_BYTES`. The outcomes
 * planned here are what the copy really attempts, item for item.
 *
 * Part B10 (user decisions D2-D4, 2026-09-20) added the rules the REAL copy
 * needs, and nothing more: one plan (`planTargets`) that the dialog's rows and
 * the uploader both read, the write mode each item earns (`uploadMode`), the
 * whole-drop limits a recursive walk is measured against (`dropRefusal`), and
 * the two notes a failure writes (`failNote`, `partialNote`). Still no DOM, no
 * network, no state: what B10 changed is that something now acts on the plan.
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
import { MAX_UPLOAD_BYTES, type FsUploadMode } from '../../../shared/protocol.ts';

/**
 * The biggest single file the upload route accepts. ONE number, not two: since
 * part B10 phase 2 this IS `MAX_UPLOAD_BYTES` from the shared protocol, the
 * constant `PUT /api/fs/upload` refuses on `content-length` with. A file over
 * it is planned as `failed` (`larger than the copy limit`) and never sent, so
 * the client spends no bytes learning what the server would have answered.
 */
export const MAX_ITEM_BYTES = MAX_UPLOAD_BYTES;

/**
 * How many TOP-LEVEL items one drop may carry. More than this is refused
 * whole, with one sentence, before any dialog opens (`tooMany`).
 */
export const MAX_ITEMS = 200;

/**
 * How many FILES one drop may carry in total, every folder walked to the
 * bottom (user decision D3, 2026-09-20). Unlike `MAX_ITEM_BYTES`, which fails
 * the one row it applies to, going over this refuses the whole drop before a
 * single byte is read: a runaway tree is a mistake, not a copy.
 */
export const MAX_DROP_FILES = 2000;

/**
 * How many BYTES one drop may carry in total, the same walk summed (D3). Also
 * a whole-drop refusal. The sentence below says `1 GB` where this constant is
 * a gibibyte: the number the user reads is the one their file manager shows,
 * and rounding it down would refuse drops the app accepts.
 */
export const MAX_DROP_BYTES = 1024 * 1024 * 1024;

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
 * Per-file write mode the upload route takes: `replace` is a deliberate
 * overwrite of something already there, `new` a name that must still be free.
 * It is the protocol's own `FsUploadMode` since part B10 phase 2 — the wire
 * decides what a write mode is, and this module only chooses between them.
 * Re-exported under the A9 name so every reader that learned it here keeps
 * working, and so a plan can be read without knowing where the wire lives.
 */
export type UploadMode = FsUploadMode;

/**
 * One top-level item, resolved against the destination's listing and the one
 * answer the dialog gave. The rows the list draws and the writes the copy
 * performs read the SAME plan (user decision D2, 2026-09-20), so a row can
 * never say one thing while the copy does another.
 */
export interface PlannedItem {
  /** The thing that was dropped, unchanged. */
  item: DropItem;
  /** It clashed with a name in the destination's listing. */
  conflict: boolean;
  /**
   * `failed` before anything is attempted is only ever a single FILE over
   * `MAX_ITEM_BYTES` (D3): that one row fails and the rest of the drop goes
   * on. Everything else fails later, with a note from `failNote`.
   */
  plan: 'upload' | 'skipped' | 'failed';
  /** The name it lands under: its own, or the "keep both" name. */
  target: string;
  /** `saved as report (2).md`, `larger than the copy limit`, or nothing. */
  note?: string;
}

/**
 * What the copy WILL do, item by item, for one drop and one conflict choice.
 * Read top to bottom, that is the order of the questions:
 *
 *   1. It conflicts and the choice was `skip`   → `skipped`, nothing tried.
 *   2. It is a FILE over `MAX_ITEM_BYTES`       → `failed`, note the limit.
 *      (A folder carries `bytes: null` and can never fail here.)
 *   3. It conflicts and the choice was `keep-both`
 *                                               → `upload` under a free name,
 *                                                 note `saved as …`.
 *   4. Anything else (no conflict, or `replace`, folders included)
 *                                               → `upload` under its own name.
 *
 * A conflict is decided against `listing` ALONE, so it always agrees with what
 * `conflictsOf` told the dialog. The names this plan hands out are still fed
 * back into the pool `keepBothName` avoids, so two items of one drop can never
 * be planned onto the same new name. A skipped or failed item takes no name:
 * its `target` stays what was dropped, and nothing reads it.
 *
 * What a folder's plan MEANS (D2, 2026-09-20): `replace` merges into the folder
 * already there, file by file, `keep-both` lands the whole tree under `target`,
 * and `skip` leaves the whole tree alone.
 */
export function planTargets(
  items: readonly DropItem[],
  listing: readonly string[],
  choice: Choice,
): PlannedItem[] {
  const here = new Set(listing);
  const taken = new Set(listing);
  const out: PlannedItem[] = [];

  for (const it of items) {
    const conflict = here.has(it.name);
    if (conflict && choice === 'skip') {
      out.push({ item: it, conflict, plan: 'skipped', target: it.name });
      continue;
    }
    if (!it.dir && it.bytes !== null && it.bytes > MAX_ITEM_BYTES) {
      out.push({ item: it, conflict, plan: 'failed', target: it.name, note: TOO_BIG_NOTE });
      continue;
    }
    if (conflict && choice === 'keep-both') {
      const saved = keepBothName(it.name, [...taken]);
      taken.add(saved);
      out.push({ item: it, conflict, plan: 'upload', target: saved, note: `saved as ${saved}` });
      continue;
    }
    taken.add(it.name);
    out.push({ item: it, conflict, plan: 'upload', target: it.name });
  }
  return out;
}

/**
 * How one planned item is WRITTEN (D2): `replace` only when the user answered
 * `replace` and this item really clashes — every other write asks for a name
 * that is still free, so a copy can never overwrite something nobody chose to
 * overwrite. A `keep both` row is a `new` write under its new name.
 */
export function uploadMode(choice: Choice, conflict: boolean): FsUploadMode {
  return choice === 'replace' && conflict ? 'replace' : 'new';
}

/** What a plan's `plan` is called in the list the dialog renders. */
const PLAN_STATE: Record<PlannedItem['plan'], Outcome> = {
  upload: 'copied',
  skipped: 'skipped',
  failed: 'failed',
};

/**
 * The same plan, in the shape the A9 dialog list reads. One map over
 * `planTargets`, nothing decided here: the two must never disagree, which is
 * why there is only one place that decides.
 */
export function planResults(
  items: readonly DropItem[],
  listing: readonly string[],
  choice: Choice,
): ItemResult[] {
  return planTargets(items, listing, choice).map((p) => {
    const out: ItemResult = { name: p.item.name, state: PLAN_STATE[p.plan] };
    if (p.note !== undefined) out.note = p.note;
    out.dir = p.item.dir;
    return out;
  });
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

// ---------------------------------------------------------------------------
// The real copy (part B10)
// ---------------------------------------------------------------------------

/** Over `MAX_DROP_FILES`: the whole drop is refused, in one sentence. */
export const TOO_MANY_FILES_SENTENCE = 'Too many files. Drop up to 2000 files at a time.';

/** Over `MAX_DROP_BYTES`: the same, counted in bytes. */
export const TOO_MANY_BYTES_SENTENCE = 'Too much at once. Drop up to 1 GB at a time.';

/**
 * Whether a walked drop is refused whole, and what is said about it (D3).
 * `files` and `bytes` are the totals of the recursive walk, so a folder is
 * judged by what is inside it, not by the one name that was dragged.
 *
 * Files are asked first: a drop that is both too many and too big is the kind
 * where the count is the thing to fix, and a refusal names one reason.
 *
 * A single file over `MAX_ITEM_BYTES` is NOT a refusal — that row is planned
 * `failed` and the rest of the drop still copies.
 */
export function dropRefusal(files: number, bytes: number): string | null {
  if (files > MAX_DROP_FILES) return TOO_MANY_FILES_SENTENCE;
  if (bytes > MAX_DROP_BYTES) return TOO_MANY_BYTES_SENTENCE;
  return null;
}

/**
 * What a failed row says, from the status the server answered. Every sentence
 * is a plain reason, lower case, so it reads as the tail of a row rather than
 * a second heading — and none of them names a status, a folder or a rule the
 * user cannot see.
 *
 * A status with no reason of its own says `could not be copied`: an unknown
 * failure is still a failure, and inventing a cause for it would be a lie.
 */
export function failNote(status: number): string {
  switch (status) {
    case 409:
      return 'something with that name is already there';
    case 413:
      return TOO_BIG_NOTE;
    case 403:
      return 'not allowed in that folder';
    case 404:
      return 'that folder is no longer there';
    case 507:
      return 'no room left on the disk';
    case 400:
    case 422:
      return 'that name is not allowed';
    default:
      return 'could not be copied';
  }
}

/**
 * A folder whose files did not all make it (D4, 2026-09-20): `3 of 12 files
 * failed`. The folder stays ONE row — twelve rows for one dragged name would
 * bury what was dropped — and this note is the whole story of what went wrong
 * inside it.
 *
 * The noun follows the TOTAL, not the failures: `1 of 12 files failed`, and a
 * folder holding a single file says `1 of 1 file failed`.
 */
export function partialNote(failed: number, total: number): string {
  return `${failed} of ${total} ${total === 1 ? 'file' : 'files'} failed`;
}
