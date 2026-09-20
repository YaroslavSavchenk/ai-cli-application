/**
 * The walk (Nocturne part B10 phase 2, `.claude/plans/nocturne/PLAN-B10.md` §3) — what a drop
 * REALLY carries, read out of the handles `ui/filedrop.ts` captured while the
 * `drop` event was still on the stack.
 *
 * A9 could only ever say `web` and `2 files`: `webkitGetAsEntry()` is the one
 * API that tells a folder from a file, and a folder's contents are a recursive
 * read that no drop handler can do synchronously. B10 needs the contents —
 * every file that will be PUT, the totals the drop-level limits are measured
 * against (D3), the empty folders that produce no upload at all — so this
 * module does that read, once, before the conflict question is asked.
 *
 * WHAT IT IS CAREFUL ABOUT, and why each one is not a detail:
 *
 * - `readEntries()` answers about 100 entries per call and then `[]`. A
 *   directory read once is a directory read wrong: a 300-file folder would
 *   copy its first hundred and say it copied all of it. Every reader is
 *   therefore looped until it answers nothing.
 * - Depth is capped at `MAX_DEPTH`, and the file count stops the walk the
 *   moment it passes `MAX_DROP_FILES`. A symlink loop (`a -> ..`) is a real
 *   thing to drag, and a walk without either cap spins the page forever.
 * - A file whose `size` the browser will not say counts as 0 bytes (D3). The
 *   server enforces the per-file cap on `content-length` regardless, so the
 *   only thing a hidden size can cost is the accuracy of a total the user is
 *   not shown.
 * - A directory that cannot be read at all is COUNTED, never guessed at:
 *   `unreadable` is what lets the drag layer say "the app could not read what
 *   was dropped" instead of opening a dialog over an empty plan.
 *
 * NO DOM, NO NETWORK. The handles are passed in (`DroppedTop`), the types are
 * structural, and nothing here touches `window` — so `node --test` drives the
 * whole walk against a plain fake tree.
 */
import { MAX_DROP_FILES, type DropItem } from './drop-model.ts';

/**
 * One entry of the tree, as much of `FileSystemEntry` as a walk needs. Typed
 * structurally rather than imported from the DOM library: it keeps this module
 * loadable under `node --test` and the fake tree in the tests honest about
 * what the browser really offers.
 */
export interface DropEntry {
  readonly name: string;
  readonly isDirectory?: boolean;
  readonly isFile?: boolean;
  /** `FileSystemFileEntry.file()` — callback style, as the API really is. */
  file?(ok: (f: File) => void, fail?: (e: unknown) => void): void;
  /** `FileSystemDirectoryEntry.createReader()`. */
  createReader?(): DropDirReader;
}

/** `FileSystemDirectoryReader`: about 100 entries per call, `[]` when done. */
export interface DropDirReader {
  readEntries(ok: (entries: DropEntry[]) => void, fail?: (e: unknown) => void): void;
}

/**
 * One TOP-LEVEL thing of a drop, captured SYNCHRONOUSLY in the `drop` handler
 * (`webkitGetAsEntry()` and `getAsFile()` are both null by the next turn of
 * the event loop). A paste and the file chooser have no entries at all, so
 * they hand over `entry: null` and a plain file.
 */
export interface DroppedTop {
  /** The name the browser reported: `README.md`, `web`. Never a path. */
  name: string;
  /** The walkable handle, or null when there is none (a paste, a pick). */
  entry: DropEntry | null;
  /** The file itself, when this top-level thing is one. */
  file: File | null;
}

/** One file to upload: which top-level item it belongs to, and where inside it. */
export interface WalkedFile {
  /** Index into `items` / the dropped order. */
  top: number;
  /** Path INSIDE the top-level item, `/`-joined. `''` = the item itself. */
  rel: string;
  file: File;
}

/**
 * One folder that holds no files anywhere and would therefore never be
 * created by an upload (D2's "the whole tree lands"): an empty folder is
 * still a thing the user dragged.
 *
 * DEVIATION from PLAN-B10 §3, which types this `string[]`: it carries `top`
 * for the same reason `WalkedFile` does — the runner has to know which
 * top-level item's `target` (a `keep both` name is not the dropped name) the
 * path hangs under, and a lookup by first segment would break on two dropped
 * items with the same name and could not express an empty TOP-LEVEL folder
 * (`rel: ''`).
 */
export interface WalkedFolder {
  top: number;
  /** Path INSIDE the top-level item. `''` = the dropped folder itself. */
  rel: string;
}

/** Everything one drop turned out to be. */
export interface WalkResult {
  /** One per TOP-LEVEL thing, the A9 shape the dialog's rows are built from. */
  items: DropItem[];
  /** Every file, in top-level order and then tree order. */
  files: WalkedFile[];
  /** The folders that hold nothing at all, and so have to be created. */
  folders: WalkedFolder[];
  /** The sum of every file's size; a size the browser hides counts as 0. */
  bytes: number;
  /** The biggest single file, for nothing but the per-file limit's sake. */
  biggest: number;
  /** Directories that could not be read. Counted, never guessed at. */
  unreadable: number;
}

/**
 * How deep a dropped tree may be walked. A dragged symlink loop is the reason
 * there is a number here at all; 64 is far past any source tree and far short
 * of a stack anybody has to worry about.
 */
export const MAX_DEPTH = 64;

/** A file's size, with a browser that will not say counting as nothing (D3). */
function sizeOf(f: File): number {
  const n = (f as { size?: unknown }).size;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** `entry.file(...)` as a promise. A file that cannot be opened answers null. */
function fileOf(entry: DropEntry): Promise<File | null> {
  return new Promise((resolve) => {
    const get = entry.file;
    if (typeof get !== 'function') {
      resolve(null);
      return;
    }
    try {
      get.call(
        entry,
        (f) => resolve(f),
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
}

/** One `readEntries()` call. A reader that fails answers null, not `[]`. */
function readBatch(reader: DropDirReader): Promise<DropEntry[] | null> {
  return new Promise((resolve) => {
    try {
      reader.readEntries(
        (entries) => resolve(entries),
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * What a drop is: the top-level items the dialog lists, every file under them,
 * the folders that hold none, and the totals `dropRefusal` judges.
 *
 * The order is the dropped order, and inside a folder it is the order the
 * directory reader answered in — which is the order the rows settle in later,
 * so the list the user watches and the writes the app makes are one sequence.
 */
export async function walkDrop(tops: readonly DroppedTop[]): Promise<WalkResult> {
  const items: DropItem[] = [];
  const files: WalkedFile[] = [];
  const folders: WalkedFolder[] = [];
  let bytes = 0;
  let biggest = 0;
  let unreadable = 0;
  /** Past `MAX_DROP_FILES` nothing more is read: the drop is refused anyway. */
  let stopped = false;

  /** Records one file, and decides whether the walk goes on. */
  function take(top: number, rel: string, f: File): void {
    files.push({ top, rel, file: f });
    const n = sizeOf(f);
    bytes += n;
    if (n > biggest) biggest = n;
    if (files.length > MAX_DROP_FILES) stopped = true;
  }

  /**
   * One directory, to the bottom. Answers whether it held anything at all:
   * a folder that held NOTHING is the one case an upload would never create,
   * so it is recorded as a folder of its own.
   */
  async function walkDir(entry: DropEntry, top: number, prefix: string, depth: number): Promise<boolean> {
    if (depth > MAX_DEPTH) {
      unreadable += 1;
      return true; // not empty as far as anyone knows — do not invent a folder
    }
    const make = entry.createReader;
    if (typeof make !== 'function') {
      unreadable += 1;
      return true;
    }
    let reader: DropDirReader;
    try {
      reader = make.call(entry);
    } catch {
      unreadable += 1;
      return true;
    }
    let any = false;
    for (;;) {
      if (stopped) return true;
      const batch = await readBatch(reader);
      if (batch === null) {
        unreadable += 1;
        return true;
      }
      if (batch.length === 0) break;
      for (const child of batch) {
        if (stopped) return true;
        any = true;
        const rel = prefix === '' ? child.name : `${prefix}/${child.name}`;
        if (child.isDirectory === true) {
          const held = await walkDir(child, top, rel, depth + 1);
          if (!held) folders.push({ top, rel });
          continue;
        }
        const f = await fileOf(child);
        if (f === null) {
          unreadable += 1;
          continue;
        }
        take(top, rel, f);
      }
    }
    return any;
  }

  for (let top = 0; top < tops.length; top += 1) {
    const t = tops[top] as DroppedTop;
    const entry = t.entry;
    const dir = entry !== null && entry.isDirectory === true;
    if (dir) {
      items.push({ name: t.name, dir: true, bytes: null });
      if (stopped) continue;
      const held = await walkDir(entry as DropEntry, top, '', 1);
      if (!held) folders.push({ top, rel: '' });
      continue;
    }
    // A top-level FILE. `getAsFile()` is what a paste and the chooser hand
    // over, and what a dropped file carries too; the entry is the fallback for
    // a browser that answered one and not the other.
    const f = t.file ?? (entry === null ? null : await fileOf(entry));
    items.push({ name: t.name, dir: false, bytes: f === null ? null : sizeOf(f) });
    if (f === null || stopped) continue;
    take(top, '', f);
  }

  return { items, files, folders, bytes, biggest, unreadable };
}
