/**
 * What the Files panel's row menu and root menu DO (parts A9b, A9c, B10,
 * B10a): each entry's action, `Copy` to the clipboard, the delete (guards,
 * one confirmed request, what the tree does with the answer), and the row's
 * own ContextMenu/shift+F10 chord. WHICH gestures open the menu stays in
 * `files.ts`, the one module allowed a `contextmenu` listener.
 *
 * Split from `ui/files.ts` (O8, 2026-09-23), code moved as it stood.
 * Siblings: `files.ts` (the panel's shell, header, width grip and the menu
 * gesture), `files-ctx.ts` (the shared context), `files-destinations.ts`,
 * `files-tree.ts`, `files-git.ts`, `files-keys.ts`, `files-menu.ts`,
 * `files-naming.ts`, `files-render.ts`.
 */
import * as st from '../state.ts';
import { openFileGuarded } from './unsaved.ts';
import { openCopyFilesPicker } from './filedrop.ts';
import { keyIsDir, keyPath, rowKey, without } from './files-select-model.ts';
import {
  copiedFlash,
  DELETE_RUNNING,
  deleteQuestion,
  deleteSubLine,
  deletedFlash,
  failedKeys,
  itemsFor as actItemsFor,
  parentsOf,
  pathsOf,
  TOO_MANY_TO_COPY,
  TOO_MANY_TO_DELETE,
  type DeleteItem,
} from './delete-model.ts';
import { openDeleteDialog } from './delete-dialog.ts';
import { isDropRunning } from './drop-dialog.ts';
import { COPY_RUNNING } from './filedrop.ts';
import { itemsForRoot, rootMenuLabel, type MenuAction } from './context-menu-model.ts';
import { openRowMenu } from './context-menu.ts';
import { containsProject } from './rename-model.ts';
import { copyPathsToClipboard } from './host-bridge.ts';
import { flash } from './statusline.ts';
import { isContextMenuChord } from './keys.ts';
import { fileName } from './slots-model.ts';
import { MAX_DELETE_ITEMS } from '../../../shared/protocol.ts';
import type { FsDeleteResult } from '../../../shared/protocol.ts';
import { isSentence, isUnder, parentPath, type Destination } from './fs-model.ts';
import type { FilesCtx, MenuPart } from './files-ctx.ts';

/**
 * What `Copy` says when nothing reached the clipboard (B10). ONE sentence for
 * every cause: a refusal from the boundary, a path with no Windows form, a
 * host that did not answer, a clipboard another program is holding. Naming
 * which one would name a path or a rule the user cannot see, and the next
 * move — try again, or copy it from a terminal — is the same for all of them.
 */
const COPY_TO_CLIPBOARD_FAILED = 'The app could not copy that to the clipboard.';

export function createMenu(ctx: FilesCtx): MenuPart {
  /**
   * What each entry does — every one of them something the panel already does
   * by another gesture, so the menu can never become a second implementation
   * of anything. `Paste` stays inert and carries the model's `PASTE_NOTE`: a
   * page sees files only inside a real `paste` event, which is a keystroke,
   * and that route works today. `Copy` is live in the native window and
   * disabled with `COPY_NOTE` anywhere else.
   */
  function runMenuAction(action: MenuAction, key: string, path: string, name: string): void {
    if (action === 'toggle') ctx.toggleFolder(path);
    else if (action === 'open') openFileGuarded(ctx.currentRoot(), path, name, { returnFocus: ctx.activeRowEl() });
    else if (action === 'open-beside') ctx.openBeside(path, name);
    // The two acts that are about the SELECTION when the row they were chosen
    // on is part of it (B10a) — the menu hands the row's key over and
    // `itemsFor` answers which rows the act really covers.
    else if (action === 'copy') copyToClipboard(key, name);
    else if (action === 'delete') runDelete(key, ctx.activeRowEl());
    else if (action === 'copy-files') openCopyFilesPicker({ path, name });
    // A9c: the three a FOLDER answers. `itemsFor` puts none of them on a file
    // row, so `path` is always a folder by the time they arrive here.
    else if (action === 'new-file') ctx.startCreate(path, 'file');
    else if (action === 'new-folder') ctx.startCreate(path, 'folder');
    else if (action === 'refresh') ctx.fetchFolder(path);
    // B13: the row menu's `Rename` and F2 on the focused row are one act.
    else if (action === 'rename') ctx.startRename(key);
    // 'paste' is a disabled entry: the menu never chooses it.
  }

  /**
   * `Copy` on a row (B10): the BACKEND maps the path to its Windows form (only
   * something inside the boundary can ever reach the clipboard), the native
   * host puts it on the clipboard as a FILE, and the statusline says which
   * way it went — by NAME, never by path, in either sentence.
   *
   * A folder and a file take the identical route: `SetFileDropList` copies a
   * folder tree the way Explorer does. Every failure — outside the boundary,
   * unmappable, no host, a clipboard held by another program, a reply that
   * never came — is the same sentence, because the user's next move is the
   * same in all of them.
   */
  function copyToClipboard(key: string, name: string): void {
    const items = actItems(key);
    if (items.length === 0) return;
    // The client's own cap, said BEFORE any request: a selection that is too
    // large is told so instead of watching a hundred round trips go out.
    if (items.length > MAX_DELETE_ITEMS) {
      flash(TOO_MANY_TO_COPY);
      return;
    }
    void (async () => {
      // ONE mapping per path, in order (orchestrator's call, 2026-09-20: no
      // batch route for ≤ 100 loopback calls). A path with no Windows form
      // leaves a gap, and the gap is what the `2 of 3` sentence counts.
      const mapped: string[] = [];
      for (const item of items) {
        try {
          const res = await ctx.fs.winPath(item.path);
          mapped.push(res.windowsPath);
        } catch {
          // Counted by its absence; the sentence never says which one.
        }
      }
      let ok = false;
      if (mapped.length > 0) {
        try {
          ok = await copyPathsToClipboard(mapped);
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        flash(COPY_TO_CLIPBOARD_FAILED);
        return;
      }
      flash(copiedFlash(mapped.length, items.length, name));
    })();
  }

    // ---- delete (part B10a) ----------------------------------------------------
  //
  // The app's first destructive act, and the only one with no way back: no
  // trash, no undo (user decision 2026-09-20). Everything about WHICH rows an
  // act covers, what the question says and which rows survive a partial
  // failure is `ui/delete-model.ts`; what lives here is the guards, the
  // request and what the tree does with the answer.
  //
  // WHAT THE ACT COVERS, exactly: `itemsFor` is handed an entry for EVERY
  // chosen row — the visible rows in tree order first, then any chosen row
  // whose parent has since been COLLAPSED (orchestrator's choice of the two
  // offered: hand in entries for all selected keys rather than prune the
  // selection on collapse). Closing a folder hides rows; it is not a way to
  // change what the user already chose, and the question counts what will
  // really be deleted.

  /** Which rows an act on this row covers (Explorer's rule), anchors dropped. */
  function actItems(clicked: string | null): DeleteItem[] {
    return actItemsFor({
      clicked,
      selection: [...ctx.selected.keys],
      visible: actEntries(),
      // A `Copy` may cover an anchor (copying your project folder is fine); a
      // delete may not, and `runDelete` passes the real question.
      undeletable: () => false,
    });
  }

  /** The same count, for the menu's accessible name. */
  function actCount(clicked: string): number {
    return actItems(clicked).length;
  }

  /**
   * Every row an act could be about, as `{ key, item }` in the order the
   * request will carry: the visible tree rows first (top to bottom, so an
   * ancestor precedes its children), then the chosen rows that are not on
   * screen right now.
   */
  function actEntries(): { key: string; item: DeleteItem }[] {
    const out: { key: string; item: DeleteItem }[] = [];
    const seen = new Set<string>();
    for (const key of ctx.visibleKeys()) {
      seen.add(key);
      out.push({ key, item: itemOf(key) });
    }
    for (const key of ctx.selected.keys) {
      if (seen.has(key) || keyPath(key) === '') continue;
      out.push({ key, item: itemOf(key) });
    }
    return out;
  }

  /**
   * One row as an act's item. Everything it needs is IN the key — the path,
   * whether it is a folder — plus the two names the question and the refresh
   * read, which are derived from the path and never from the tree cache: a row
   * inside a collapsed folder has no cache entry and is still deletable.
   */
  function itemOf(key: string): DeleteItem {
    const path = keyPath(key);
    const parent = parentPath(path);
    return {
      path,
      name: fileName(path),
      dir: keyIsDir(key),
      parentName: fileName(parent),
      parentPath: parent,
    };
  }

  /**
   * Is this path an ANCHOR — something the app refuses to delete, and the
   * server refuses too (`server/fsdelete.ts`, `FS_DELETE_ANCHOR`)? The folder
   * the panel is standing in, the home folder, and every registered project.
   *
   * BEST EFFORT, and it says so: the server is the authority, and a row that
   * is offered `Delete` can still come back with a refusal sentence. What this
   * buys is that the menu does not offer an act the app knows will fail, and
   * that a select-all followed by Delete cannot ask about the tree's own root.
   */
  function isAnchor(path: string): boolean {
    if (path === '') return true;
    if (ctx.currentPath !== null && path === ctx.currentPath) return true;
    if (ctx.homePath !== null && path === ctx.homePath) return true;
    return st.state.projects.some((p) => p.path === path);
  }

  /**
   * May this row be RENAMED (B13, user decision D2)? Not an anchor, and not a
   * folder that HOLDS a registered project — renaming it would move that
   * project away from the path it is registered at. ONE predicate for both
   * doors: the row menu's `renamable` and F2 ask exactly this, so the entry and
   * the key can never disagree. Best effort like `isAnchor`: the server refuses
   * the same rows on its own.
   */
  function isRenamable(path: string): boolean {
    return !isAnchor(path) && !containsProject(path, st.state.projects.map((p) => p.path));
  }

  /**
   * The act itself: which rows, then ONE question, then one request.
   *
   * The guards, in order — a copy that is still writing owns the same folders
   * and the same refresh; a delete already in flight owns the rows (a second
   * answer could not be matched against the right list of items); and nothing
   * deletable is NOTHING AT ALL, not a sentence: a Delete on the panel's own
   * root is a key that does not apply, and the app does not narrate those.
   */
  function runDelete(clicked: string | null, back: HTMLElement | null): void {
    if (ctx.tab !== 'files') return;
    if (isDropRunning()) {
      flash(COPY_RUNNING);
      return;
    }
    if (ctx.deleting !== null) {
      flash(DELETE_RUNNING);
      return;
    }
    const items = actItemsFor({
      clicked,
      selection: [...ctx.selected.keys],
      visible: actEntries(),
      undeletable: isAnchor,
    });
    if (items.length === 0) return;
    if (items.length > MAX_DELETE_ITEMS) {
      flash(TOO_MANY_TO_DELETE);
      return;
    }
    openDeleteDialog({
      question: deleteQuestion(items),
      sub: deleteSubLine(items),
      returnFocus: back,
      onConfirm: () => sendDelete(items),
    });
  }

  /**
   * The request. ONE batch for the whole question (B10a): one confirmation,
   * one POST, one line in the log — and one list of items the index-keyed
   * answer is read against.
   *
   * Nothing is removed from the tree optimistically. The rows dim, and what
   * replaces them is what the folder really answers afterwards.
   */
  function sendDelete(items: readonly DeleteItem[]): void {
    if (ctx.deleting !== null) return;
    ctx.deleting = new Set(items.map((i) => rowKey(i.path, i.dir)));
    ctx.lastSig = '';
    ctx.render();
    ctx.fs.delete(pathsOf(items))
      .then((res) => {
        finishDelete(items, res.results);
      })
      .catch(() => {
        // The REQUEST was refused (the cap, the body limit, the token gate) or
        // never arrived: nothing was deleted, and an empty result list is how
        // `failedKeys` reads exactly that.
        finishDelete(items, []);
      });
  }

  /**
   * The answer. Five effects, in this order: the cache under a folder that is
   * GONE is dropped, every affected parent is re-read ONCE (the B10 rule — and
   * `refreshIfListed` skips a folder nobody opened), the rows that really went
   * leave the selection, the statusline says what happened, and the panel
   * repaints — with a promise about where the keyboard lands when the row it
   * was standing on is one of the rows that went.
   *
   * THE FAILURES STAY SELECTED. After a partial delete they are what is still
   * there, and leaving them chosen is how the panel says which ones without
   * naming a path.
   */
  function finishDelete(items: readonly DeleteItem[], results: readonly FsDeleteResult[]): void {
    ctx.deleting = null;
    // The rows as they are RIGHT NOW: nothing is removed optimistically, so
    // this is still the tree the user was looking at when they confirmed, and
    // it is what "the row after the one that went" is measured in.
    const before = ctx.visibleKeys();
    const failed = new Set(failedKeys(items, results));
    const gone = items.filter((i) => !failed.has(rowKey(i.path, i.dir)));
    const done = gone.map((i) => rowKey(i.path, i.dir));
    // A FOLDER that is gone takes its whole subtree's cache with it: the open
    // set and the listings are keyed by absolute path, and a folder created
    // again under the same name would otherwise be drawn pre-expanded over a
    // dead listing — and every root `Refresh` would re-ask for a path that is
    // not there (the same prune `setRoot` does for a root change).
    for (const item of gone) {
      if (!item.dir) continue;
      for (const p of [...ctx.openFolders]) if (isUnder(p, item.path)) ctx.openFolders.delete(p);
      for (const p of [...ctx.listings.keys()]) if (isUnder(p, item.path)) ctx.listings.delete(p);
    }
    for (const parent of parentsOf(items)) ctx.refreshIfListed(parent);
    ctx.selected = without(ctx.selected, done);
    // WHERE THE KEYBOARD GOES when the row it is standing on is about to
    // disappear — the `focusCreated` promise, inverted. It is a promise rather
    // than a `focus()` because the row is still on screen at this moment: it
    // goes when the parent's new listing lands, one or more repaints later.
    ctx.focusAfterDelete = done.length === 0 ? null : { gone: new Set(done), candidates: survivors(before, new Set(done), items) };
    flash(deleteSaid(items, results, done.length));
    ctx.bump();
  }

  /**
   * Where the keyboard should land once these rows are gone, in preference
   * order: the nearest row BELOW the last one that went, then the nearest row
   * ABOVE it, then the parent folders of the rows that went (a row of their
   * own, unless the parent is the panel root, which has none).
   *
   * Only keys are collected; whether each still exists is asked at the moment
   * the promise is kept, because a folder's whole subtree leaves the tree with
   * it and a listing may have changed in between.
   */
  function survivors(
    before: readonly string[],
    gone: ReadonlySet<string>,
    items: readonly DeleteItem[],
  ): string[] {
    let last = -1;
    before.forEach((key, i) => {
      if (gone.has(key)) last = i;
    });
    const out: string[] = [];
    for (let i = last + 1; i < before.length; i += 1) {
      const key = before[i];
      if (key !== undefined && !gone.has(key)) out.push(key);
    }
    for (let i = last - 1; i >= 0; i -= 1) {
      const key = before[i];
      if (key !== undefined && !gone.has(key)) out.push(key);
    }
    for (const item of items) out.push(rowKey(item.parentPath, true));
    return out;
  }

  /**
   * What the statusline says. The model's count sentence — except for the one
   * case where the SERVER has something better to say: a single item that
   * failed, whose own sentence says WHY (it is no longer there, it is in use,
   * there is no permission). Rendered only if it reads like one of the
   * server's own constant sentences, the same gate every other refusal in this
   * panel passes through (§1d); anything else is the app's own wording.
   */
  function deleteSaid(
    items: readonly DeleteItem[],
    results: readonly FsDeleteResult[],
    ok: number,
  ): string {
    const first = items[0];
    const said = deletedFlash(ok, items.length, items.length === 1 ? (first?.name ?? null) : null);
    if (ok > 0 || items.length !== 1) return said;
    const r = results[0];
    if (r !== undefined && !r.ok && isSentence(r.error)) return r.error;
    return said;
  }

  /**
   * The ROOT menu (A9c, §6a): the same card, opened on the panel's background
   * by a right-click or by the chord, over the folder the header names.
   *
   * IT IS THE FILES TAB'S. `Changes` and `Commits` list something else
   * entirely (a repository's diff, its commits), and the name row this menu
   * can start is drawn by `fileRows()`, which those tabs never call — a create
   * begun there would be state with nothing on screen. A root nobody has
   * learned yet has no path to create in either. In both cases the event is
   * left alone, so the SYSTEM menu opens instead of nothing at all.
   *
   * Answers whether it opened, because the caller is what decides to take the
   * gesture away from the browser.
   */
  function openRootMenuAt(at: { x: number; y: number }): boolean {
    if (ctx.tab !== 'files') return false;
    const dest = ctx.rootDestination();
    if (dest === null) return false;
    ctx.dropNaming('menu');
    const back =
      document.activeElement instanceof HTMLElement &&
      document.activeElement.closest('.files-view') !== null
        ? document.activeElement
        : null;
    openRowMenu({
      items: itemsForRoot(dest.name),
      at,
      label: rootMenuLabel(dest.name),
      returnFocus: back,
      onChoose: (action) => runRootAction(action, dest),
    });
    return true;
  }

  /**
   * What the root menu's entries do. Every one of them is the same call a row
   * makes, aimed at the root instead — the menu is never a second
   * implementation of anything (the A9b rule).
   */
  function runRootAction(action: MenuAction, dest: Destination): void {
    if (action === 'copy-files') openCopyFilesPicker(dest);
    else if (action === 'new-file') ctx.startCreate(dest.path, 'file');
    else if (action === 'new-folder') ctx.startCreate(dest.path, 'folder');
    else if (action === 'refresh') ctx.refreshRoot();
  }

  /** Where a keyboard-opened menu hangs from: the focused thing's leading edge and bottom. */
  function pointOf(t: Element | null): { x: number; y: number } {
    const r = (t ?? ctx.root).getBoundingClientRect();
    return { x: r.left, y: r.bottom };
  }

  /**
   * The keyboard twin, owned ON THE ROW — the same ownership rule the
   * ctrl+alt+enter and ctrl+alt+c row chords already follow: the gesture acts
   * on the row that has the keyboard, which is this module's business and
   * nothing the window handler can see, and it stops propagating so no other
   * handler reads a key this row already spent. That is also what keeps a
   * focused TERMINAL's own menu key untouched: nothing outside this panel ever
   * looks at it.
   *
   * The menu opens at the row's LEADING EDGE and BOTTOM, so it hangs off the
   * row the way a pointer menu hangs off the pointer.
   */
  function armRowMenuChord(b: HTMLElement, key: string): void {
    b.addEventListener('keydown', (e) => {
      if (!isContextMenuChord(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const r = b.getBoundingClientRect();
      ctx.openRowMenuFor(key, { x: r.left, y: r.bottom });
    });
  }

  return {
    runMenuAction,
    actCount,
    isAnchor,
    isRenamable,
    runDelete,
    openRootMenuAt,
    pointOf,
    armRowMenuChord,
  };
}
