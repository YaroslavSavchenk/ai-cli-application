/**
 * Permanent-delete model (Nocturne part B10a, user decision 2026-09-20,
 * `memory/decisions/b10a-multi-select-and-delete.md`) — the pure rules behind
 * the app's first destructive act: WHICH rows a Delete means, WHAT the one
 * confirmation says, WHICH keys survive a partial failure, and WHICH folders
 * have to be re-read afterwards.
 *
 * PERMANENT: no trash, no undo. The single confirmation this module words is
 * the only stop between a keystroke and gone bytes, so it is written here,
 * once, and tested byte for byte — a dialog that under-states what it is about
 * to delete is the failure mode this file exists to prevent.
 *
 * No DOM, no fetch, no state: `ui/files.ts` hands in the rows it has and sends
 * the request; this decides what the act means and what it is called.
 *
 * Rules this file enforces, not just follows:
 * - EXPLORER'S RULE for what an act covers (`itemsFor`): a gesture on a row
 *   that is already selected is about the WHOLE selection; a gesture on any
 *   other row is about that row alone and nothing else.
 * - ANCHORS ARE DROPPED HERE AND NOWHERE ELSE. The panel root and a project
 *   root cannot be deleted (the server refuses them too, `server/fsdelete.ts`
 *   `FS_ANCHOR_REFUSED`), and dropping them at the door is what keeps them out
 *   of the count in the question as well as out of the request.
 * - NAMES, NEVER PATHS. Not one sentence this module builds carries a path
 *   (PROJECT-SCOPE, 2026-07-25) — the question names the row, or the parent,
 *   or nothing.
 * - TREE ORDER, ALWAYS. Items keep the order of `visible`, so an ancestor
 *   comes before its children: the request, the question's count, the
 *   index-keyed results and the re-read list all speak about the same list in
 *   the same order.
 */
import { MAX_DELETE_ITEMS, type FsDeleteResult } from '../../../shared/protocol.ts';

/** Re-exported so a reader of this module can see what a result IS without
 *  leaving it; the PROTOCOL stays the single definition. */
export type { FsDeleteResult };

/**
 * A row a delete can be about — everything the question, the request and the
 * refresh need, and nothing else.
 *
 * `parentName` and `parentPath` are the row's FOLDER: the name is what the
 * question says when every item shares one parent, the path is what has to be
 * re-listed after the delete. Both come from the panel, which knows the tree;
 * this module never takes a path apart.
 */
export interface DeleteItem {
  path: string;
  name: string;
  dir: boolean;
  parentName: string;
  parentPath: string;
}

/** The row key `ui/files.ts` paints for an item (`fdir:`/`ffile:` + path). */
function keyOf(item: DeleteItem): string {
  return `${item.dir ? 'fdir' : 'ffile'}:${item.path}`;
}

/**
 * WHICH ROWS AN ACT MEANS — Explorer's rule, in one function, for the menu
 * entry, the Delete key and anything else that acts on rows.
 *
 * - `clicked` is IN the selection: the WHOLE selection. Right-clicking one of
 *   five chosen files is how a user asks for all five.
 * - `clicked` is NOT in the selection: that row ALONE. The selection is not
 *   what the user pointed at, so it is not what the act is about.
 * - `clicked` is null (a keyboard Delete, a menu opened on the panel itself):
 *   the whole selection, or nothing at all when nothing is selected.
 *
 * ANCHORS ARE DROPPED HERE: `undeletable(path)` is asked once per item, and a
 * selection that is nothing but anchors comes back EMPTY — the caller then has
 * nothing to confirm and nothing to send.
 *
 * `visible` is the panel's rows in tree order, and it is also the source of
 * every `DeleteItem`: a key with no row in `visible` yields no item, so the
 * caller must hand in an entry for every key it means (a selected row inside a
 * folder that was collapsed is not something this module can invent).
 */
export function itemsFor(args: {
  clicked: string | null;
  selection: readonly string[];
  visible: readonly { key: string; item: DeleteItem }[];
  undeletable: (path: string) => boolean;
}): DeleteItem[] {
  const { clicked, selection, visible, undeletable } = args;
  const chosen = new Set(selection);
  const acting = clicked !== null && !chosen.has(clicked) ? new Set([clicked]) : chosen;
  const out: DeleteItem[] = [];
  for (const row of visible) {
    if (!acting.has(row.key)) continue;
    if (undeletable(row.item.path)) continue;
    out.push(row.item);
  }
  return out;
}

/** The exact paths of the request, in the items' order (tree order). */
export function pathsOf(items: readonly DeleteItem[]): string[] {
  return items.map((i) => i.path);
}

/**
 * THE ONE CONFIRMATION, four shapes — and every one of them says what cannot
 * be taken back, because there is no second chance anywhere after it:
 *
 * - one file:    `Delete README.md? This cannot be undone.`
 * - one folder:  `Delete web and everything inside it? This cannot be undone.`
 * - N from one folder: `Delete 3 items from src? This cannot be undone.`
 * - N from several:    `Delete 3 items? This cannot be undone.`
 *
 * A single shared parent that has no NAME (the filesystem root) uses the last
 * shape rather than leaving a hole where a folder should be — the same honesty
 * rule `copyStripLabel` follows. An EMPTY list takes the plural shape too
 * (`Delete 0 items? …`): no caller may ask it — `itemsFor` answering nothing
 * means there is nothing to confirm — and it is a sentence, not a crash.
 */
export function deleteQuestion(items: readonly DeleteItem[]): string {
  const first = items[0];
  if (items.length === 1 && first !== undefined) {
    return first.dir
      ? `Delete ${first.name} and everything inside it? This cannot be undone.`
      : `Delete ${first.name}? This cannot be undone.`;
  }
  const parent = oneParentName(items);
  if (parent !== null) {
    return `Delete ${items.length} items from ${parent}? This cannot be undone.`;
  }
  return `Delete ${items.length} items? This cannot be undone.`;
}

/** The one parent's NAME when every item shares a parent and that parent can
 *  be named, else null (several parents, no items, or an unnameable parent). */
function oneParentName(items: readonly DeleteItem[]): string | null {
  const first = items[0];
  if (first === undefined) return null;
  for (const item of items) if (item.parentPath !== first.parentPath) return null;
  return first.parentName === '' ? null : first.parentName;
}

/**
 * The second line of the confirmation, and only when it adds something the
 * question does not already say: several items, at least one of them a folder.
 *
 * `Folders are deleted with everything inside them.`
 *
 * With ONE folder the question already says "and everything inside it", and
 * with files only there is nothing to warn about — a warning that repeats
 * itself is a warning people stop reading.
 */
export function deleteSubLine(items: readonly DeleteItem[]): string | null {
  if (items.length <= 1) return null;
  if (!items.some((i) => i.dir)) return null;
  return 'Folders are deleted with everything inside them.';
}

/** Nothing went. The panel substitutes the SERVER's own sentence for a
 *  single failed item (it says why); for a batch this is the whole answer. */
export const NOTHING_DELETED = 'Nothing was deleted.';

/**
 * What the statusline says afterwards — the count, never a path:
 *
 * - one item, ok, with a name: `Deleted README.md.`
 * - one item, ok, no name:     `Deleted 1 item.`
 * - N ok:                      `Deleted 3 items.`
 * - partial:                   `Deleted 2 of 3 items.`
 * - nothing:                   `Nothing was deleted.`
 *
 * `name` belongs to the ONE item of a one-item delete and is ignored
 * otherwise: a batch's flash names no row, because it would have to pick one.
 */
export function deletedFlash(ok: number, total: number, name: string | null): string {
  if (ok <= 0) return NOTHING_DELETED;
  if (ok < total) return `Deleted ${ok} of ${total} items.`;
  if (total === 1) return name === null ? 'Deleted 1 item.' : `Deleted ${name}.`;
  return `Deleted ${total} items.`;
}

/**
 * What the statusline says after a `Copy` on one row or on a whole selection
 * (B10a, part D4) — the NAME for one row, the COUNT for several:
 *
 * - one row:  `Copied README.md to the clipboard.`
 * - N rows:   `Copied 3 items to the clipboard.`
 * - partial:  `Copied 2 of 3 items to the clipboard.` (a path with no Windows
 *             form is a gap in the list the host was handed)
 *
 * A batch names no row, because it would have to pick one — the same rule
 * `deletedFlash` follows. NOTHING on the clipboard is not this function's
 * sentence at all: that is the panel's one B10 failure line, which covers
 * every cause with the same next move.
 *
 * It lives HERE, beside the delete sentences, because `Copy` and `Delete` are
 * the two acts that read a whole selection (`itemsFor`), and a sentence about
 * a count belongs where the count is decided — not in the DOM module.
 */
export function copiedFlash(ok: number, total: number, name: string): string {
  if (total === 1) return `Copied ${name} to the clipboard.`;
  if (ok < total) return `Copied ${ok} of ${total} items to the clipboard.`;
  return `Copied ${total} items to the clipboard.`;
}

/**
 * WHICH ROWS STAY SELECTED after the answer: the ones that FAILED, by key.
 *
 * `results[i]` belongs to `items[i]` — the request carried the paths in this
 * order and the server answers in it (`shared/protocol.ts`, "index-keyed to
 * the request"). A results list SHORTER than the items (a truncated or
 * malformed answer) counts the missing tail as FAILED: the honest reading is
 * "we do not know that it went", and leaving those rows selected says so.
 */
export function failedKeys(
  items: readonly DeleteItem[],
  results: readonly FsDeleteResult[],
): string[] {
  const out: string[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const r = results[i];
    const item = items[i];
    if (item === undefined) continue;
    if (r === undefined || !r.ok) out.push(keyOf(item));
  }
  return out;
}

/**
 * Every folder that has to be re-read once the delete is done — each one once,
 * in the items' order.
 *
 * The PARENTS, not the items: a deleted folder is gone, and what changed on
 * screen is the listing that used to hold it.
 */
export function parentsOf(items: readonly DeleteItem[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item.parentPath)) continue;
    seen.add(item.parentPath);
    out.push(item.parentPath);
  }
  return out;
}

/**
 * The client's own cap, worded for each act, interpolated from the protocol's
 * `MAX_DELETE_ITEMS` so the sentence and the number cannot drift apart — from
 * each other, or from the server's refusal for the same batch
 * (`server/fsdelete.ts`, `FS_DELETE_TOO_MANY`, which `TOO_MANY_TO_DELETE`
 * equals byte for byte and `tests/ui-delete-model.test.ts` pins).
 *
 * The client refuses BEFORE the request, so the user is told about a selection
 * that is too large instead of watching a whole batch bounce.
 */
export const TOO_MANY_TO_DELETE = `Too many items. Delete up to ${MAX_DELETE_ITEMS} at a time.`;
export const TOO_MANY_TO_COPY = `Too many items. Copy up to ${MAX_DELETE_ITEMS} at a time.`;

/** A second Delete while the first is still in flight: one batch at a time, so
 *  no answer can be matched against the wrong list of items. */
export const DELETE_RUNNING = 'A delete is still running.';
