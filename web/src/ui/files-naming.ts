/**
 * The Files panel's NAME ROW: creating a file or a folder (part A9c, §6b)
 * and renaming one (part B13) — one inline row, never a dialog, with the same
 * cancels, the same validation and the same promise about where the keyboard
 * lands.
 *
 * Split from `ui/files.ts` (O8, 2026-09-23), code moved as it stood.
 * Siblings: `files.ts` (the panel's shell, header, width grip and the menu
 * gesture), `files-ctx.ts` (the shared context), `files-destinations.ts`,
 * `files-tree.ts`, `files-git.ts`, `files-keys.ts`, `files-menu.ts`,
 * `files-naming.ts`, `files-render.ts`.
 */
import * as st from '../state.ts';
import { el } from './util.ts';
import { openFileGuarded } from './unsaved.ts';
import { afterRowActivate, keyIsDir, keyPath, rowKey } from './files-select-model.ts';
import { DELETE_RUNNING } from './delete-model.ts';
import { isDropRunning } from './drop-dialog.ts';
import { COPY_RUNNING } from './filedrop.ts';
import {
  hasSessionInside,
  hasUnsavedAt,
  isSameName,
  remapKeys,
  remapPath,
  renamedPath,
  renameMessage,
  RENAME_SESSION_NOTE,
  RENAME_UNSAVED_TAKEN,
  type TextRange,
} from './rename-model.ts';
import { flash } from './statusline.ts';
import { fileName } from './slots-model.ts';
import { folderIcon } from './icons.ts';
import { fileIcon } from './icons-files.ts';
import { PLAIN_FILE, fileIconFor, rowIndent } from './files-model.ts';
import {
  createRowIndex,
  isSentence,
  isUnder,
  nameProblem,
  parentPath,
  nameProblemText,
  type FsRow,
} from './fs-model.ts';
import type { FilesCtx, NamingPart } from './files-ctx.ts';

/**
 * What the name row says when a create failed and the failure carried no
 * sentence of its own (part A9c, §6b). Every refusal the server writes is
 * rendered VERBATIM instead — a name that is already taken, a folder that is
 * no longer there, a permission — and this is the one case where there is no
 * server sentence to render: a dropped connection, or a body the app cannot
 * read. It says what the app knows ("it did not happen") and nothing it does
 * not, and it never names the path or the name that was typed.
 */
const CREATE_FAILED_TEXT = 'The app could not create it.';

export function createNaming(ctx: FilesCtx): NamingPart {
  // ---- creating a file or a folder ------------------------------------------
  //
  // `New file` / `New folder`, from the row menu or the root menu (part A9c,
  // `.claude/plans/nocturne/PLAN-B2.md` §6b). One inline row in the tree, never a dialog.
  //
  // WHY A ROW AND NOT A MODAL. The answer to "what is this called?" belongs
  // exactly where the thing will be: at the child indent of the folder that
  // will hold it, between the rows it will sit among. A modal would take the
  // tree away to ask about it, and — the harder rule — a dialog is a layout
  // change this panel must never make: the scrim and the card are `position:
  // fixed`, but a panel that reflowed by a pixel would fire every pane's
  // ResizeObserver and resize every PTY in the grid (the A9 rule). The name
  // row is exactly `--files-row-h` tall and changes no width at all.
  //
  // VALIDATION IS INLINE TOO. The five client rules are `fs-model.ts`'s
  // `nameProblem` — the server's own `isSafeSegment`, mirrored — so an empty
  // name or a slash costs no request; everything else is the SERVER's
  // sentence, rendered verbatim under the input (§1d), with the typed text and
  // the keyboard left exactly where they were. No alert, no toast, no modal:
  // the question and its answer stay in one place.
  //
  // ONE AT A TIME, and it is cancelled by everything that takes the tree away
  // from under it: Escape, the input losing the keyboard, a tab switch, a root
  // change, the panel leaving the screen, and any menu opening.

  /** The name row on screen, or nothing. `error` is the sentence under it. */
  let creating: { dir: string; kind: 'file' | 'folder'; error: string | null } | null = null;
  /**
   * What is typed, kept OUTSIDE the input: a repaint replaces the element (a
   * listing lands, a 409 draws the sentence), and a text that lived only in
   * the DOM would be lost by the very render that has to show what went wrong.
   * `rebuild()` reads the live value into this before it replaces anything.
   */
  let createText = '';
  /** The request is out: the input is read-only and the row wears `.is-busy`. */
  let createBusy = false;
  /**
   * Bumped by every start and every cancel. An answer whose token no longer
   * matches belongs to a create the user has already walked away from, so it
   * neither selects, nor opens, nor paints a refusal at anybody.
   */
  let createToken = 0;
  /** The `data-k` the keyboard came from, so a cancel can hand it back. */
  let createReturn: string | null = null;
  /** The live input, while one is on screen. */
  let nameInput: HTMLInputElement | null = null;
  /**
   * The same value, read through a call. `paint()` clears `nameInput` before
   * it rebuilds and `insertNameRow()` sets it again from inside that rebuild,
   * which the compiler cannot see — so it narrows the variable to `never` at
   * the end of the pass. This is the read that says "ask again now".
   */
  function liveNameInput(): HTMLInputElement | null {
    return nameInput;
  }
  /** The name row takes the keyboard on the repaint that created it. */
  let focusName = false;
  /**
   * The row a landed create puts the keyboard on, and the folder whose listing
   * has to arrive before that row exists. Cleared when the row is focused —
   * or when that folder answered without it, which is the honest end of a
   * promise the tree cannot keep (a cap, a filter, a file created and removed).
   */
  let focusCreated: { key: string; dir: string } | null = null;
  /** True while `rebuild()` is replacing rows (a removal must not read as a blur). */
  let rebuilding = false;

  /**
   * Begin naming something in `dir`.
   *
   * THE FOLDER IS OPENED FIRST (§6b): a name row inside a closed folder would
   * be a promise about a place the user cannot see. It is fetched when it has
   * never answered, exactly as a click on its caret would — the row lands at
   * the top of whatever that folder turns out to hold. The ROOT has no row and
   * no caret, so it is neither opened nor fetched.
   */
  function startCreate(dir: string, kind: 'file' | 'folder'): void {
    const rootP = ctx.currentPath;
    if (rootP === null) return;
    // ONE name row at a time, create or rename (B13): a rename left open would
    // be a second input fighting this one for the keyboard.
    clearRename();
    clearCreate();
    if (dir !== rootP && !ctx.openFolders.has(dir)) {
      ctx.openFolders.add(dir);
      ctx.fetchFolder(dir);
    }
    creating = { dir, kind, error: null };
    createReturn = activeKey();
    focusName = true;
    ctx.lastSig = '';
    ctx.render();
  }

  /** The `data-k` of the focused control, while the focus is inside the panel. */
  function activeKey(): string | null {
    const a = document.activeElement;
    if (!(a instanceof HTMLElement) || a.closest('.files-view') === null) return null;
    return a.getAttribute('data-k');
  }

  /** Forget the create. STATE ONLY — the caller decides about painting. */
  function clearCreate(): void {
    creating = null;
    createText = '';
    createBusy = false;
    createToken += 1;
    nameInput = null;
    focusName = false;
  }

  /**
   * The four cancels that are somebody else's gesture (§6b): a menu opening, a
   * tab switch, a root change, the panel leaving the screen. Only the menu
   * repaints from here — `setTab` renders right after its own call, and the
   * other two are already INSIDE a render pass, which a second render would
   * re-enter. Since B13 they cancel EITHER name row, a create or a rename: the
   * rename row is the same row asking a different question.
   */
  function dropNaming(why: 'menu' | 'tab' | 'root' | 'hidden'): void {
    if (creating === null && renaming === null) return;
    clearCreate();
    clearRename();
    ctx.lastSig = '';
    if (why === 'menu') ctx.render();
  }

  /**
   * Escape and the input losing the keyboard: forget it, repaint, and hand the
   * keyboard back where it came from.
   *
   * BLUR CANCELS, it does not commit (§6b). A half-typed name that created a
   * file because the user clicked somewhere else would be the one gesture in
   * this panel that writes to the filesystem without being asked twice.
   *
   * `giveKeyboardBack` is the whole difference between the two callers. ESCAPE
   * passes true: the keyboard goes back to the row the menu was opened from —
   * or, when that row is gone (or the menu was opened on the background with a
   * pointer), to the copy strip's button, which is always on screen. It must
   * land INSIDE the panel, because the Escape ladder's next rung is this
   * panel's own listener and a keyboard dropped on `<body>` would skip
   * straight to closing the panel. BLUR passes false: the browser is already
   * moving the keyboard somewhere the user chose, and pulling it back into the
   * tree from inside that transfer is how a keystroke meant for a PTY ends up
   * on a Files row.
   */
  function cancelCreate(giveKeyboardBack: boolean): void {
    if (creating === null) return;
    const back = createReturn;
    clearCreate();
    ctx.lastSig = '';
    ctx.render();
    // ONLY ESCAPE MOVES THE KEYBOARD. A blur is the browser ALREADY moving it
    // somewhere the user chose — a terminal, another window, the tab strip —
    // and focusing a Files row from inside that transfer is how a keystroke
    // meant for a PTY lands on a tree row instead.
    if (!giveKeyboardBack) return;
    const el =
      back === null ? null : ctx.root.querySelector<HTMLElement>(`[data-k="${CSS.escape(back)}"]`);
    (el ?? ctx.copyBtn).focus();
  }

  /**
   * Enter: validate, then post exactly once.
   *
   * THE CLIENT RULES COST NO REQUEST. `nameProblem` is the server's own
   * `isSafeSegment`, mirrored in `fs-model.ts`, so an empty name, a slash, an
   * all-dots name, a control character and a name over 255 are answered here —
   * the server would refuse all five, and asking it would only make the answer
   * slower.
   *
   * EVERYTHING ELSE IS THE SERVER'S ANSWER, verbatim when it is one of its own
   * sentences (§1d — a name that is taken, a folder that moved, a permission),
   * and the app's own one-liner when there is no sentence to render. The text
   * and the keyboard stay put, because the next thing the user does is edit
   * the name they just typed.
   */
  function commitCreate(): void {
    if (creating === null || createBusy) return;
    const { dir, kind } = creating;
    const name = nameInput === null ? createText : nameInput.value;
    createText = name;
    const bad = nameProblem(name);
    if (bad !== null) {
      creating = { dir, kind, error: nameProblemText(bad) };
      ctx.lastSig = '';
      ctx.render();
      return;
    }
    createBusy = true;
    creating = { dir, kind, error: null };
    ctx.lastSig = '';
    ctx.render();
    const token = createToken;
    const gen = ctx.generation;
    ctx.fs.create(dir, name, kind)
      .then((res) => {
        // THE ROOT decides whether this answer concerns the panel at all: a
        // folder in a tree nobody is looking at is not re-read.
        if (gen !== ctx.generation) return;
        // THE TOKEN decides whether it is still the user's QUESTION. It is
        // not — they cancelled, or started another one — so none of the four
        // effects below fire. The folder is still re-read: the thing EXISTS
        // now, and a tree that kept pretending it did not would hand the next
        // attempt a refusal about a name nothing on screen explains.
        if (token !== createToken) {
          ctx.fetchFolder(dir);
          ctx.bump();
          return;
        }
        clearCreate();
        const path = res.path;
        const leaf = fileName(path);
        // A FOLDER is the thing you just made a place for: it becomes the
        // chosen folder (so the copy strip already names it) and it is opened,
        // which is what makes its one empty state honest. A FILE is a thing
        // you made to write in, so it opens in a pane, exactly as clicking its
        // row would.
        if (kind === 'folder') {
          ctx.selected = afterRowActivate(ctx.selected, rowKey(path, true));
          ctx.openFolders.add(path);
          ctx.fetchFolder(path);
        } else {
          openFileGuarded(ctx.currentRoot(), path, leaf);
        }
        // The keyboard follows the thing that was made — but its row does not
        // exist until the folder answers again, so this is a promise the next
        // rebuilds keep.
        focusCreated = { key: rowKey(path, kind === 'folder'), dir };
        ctx.fetchFolder(dir);
        ctx.bump();
      })
      .catch((err: unknown) => {
        if (token !== createToken || gen !== ctx.generation) return;
        createBusy = false;
        creating = { dir, kind, error: createMessage(err) };
        ctx.lastSig = '';
        ctx.render();
        // The repaint replaced the input; the fresh one takes the keyboard
        // back with the text still in it.
        nameInput?.focus();
      });
  }

  /** The sentence a failed create renders: the server's own, or the app's. */
  function createMessage(err: unknown): string {
    if (err !== null && typeof err === 'object') {
      const e = err as { message?: unknown };
      if (typeof e.message === 'string' && isSentence(e.message)) return e.message;
    }
    return CREATE_FAILED_TEXT;
  }

  /**
   * `Refresh` on the ROOT (§6a): read the root again and DROP every listing
   * cached under it, so nothing on screen can be older than this gesture.
   *
   * The folders that are OPEN are then asked for again in the same breath —
   * dropping their cache without re-asking would leave the visible tree
   * showing `Loading…` for folders nobody is going to expand a second time.
   * Closed folders keep no cache at all and are read when they are next
   * opened, which is the panel's normal rule.
   */
  function refreshRoot(): void {
    const rootP = ctx.currentPath;
    if (rootP === null) return;
    for (const p of [...ctx.listings.keys()]) if (p !== rootP && isUnder(p, rootP)) ctx.listings.delete(p);
    ctx.fetchFolder(rootP);
    for (const p of ctx.openFolders) if (p !== rootP && isUnder(p, rootP)) ctx.fetchFolder(p);
    ctx.bump();
  }

  /**
   * A copy landed in `path` (B10): read that folder again, but ONLY if the
   * panel is already showing it — the root itself, or a folder the user
   * opened. A drop into a folder nobody expanded changes nothing on screen,
   * and asking for it would be a request for a listing that is then thrown
   * away.
   *
   * Called ONCE, when the whole drop is over, which is also what keeps the
   * in-flight `.part` files the upload route writes off the screen.
   */
  function refreshIfListed(path: string): void {
    if (path !== ctx.currentPath && !ctx.openFolders.has(path)) return;
    ctx.fetchFolder(path);
  }

  /**
   * The name row itself, spliced into the rows a render has already built
   * (§6b). `createRowIndex` decides where: right after the folder's own row,
   * or at the very top for the root — and -1 when that folder is not on screen
   * at all (a listing that changed under the menu, a folder that closed), in
   * which case the create is dropped rather than drawn somewhere arbitrary.
   * The row itself is `nameRowEl`, the one a rename draws too.
   */
  function insertNameRow(rows: HTMLElement[], model: readonly FsRow[], rootP: string): void {
    const c = creating;
    if (c === null) return;
    // THE FOLDER MUST STILL BE OPEN. `startCreate` opened it, and the primary
    // click on its row can close it again — a name row at the child indent
    // under a shut folder would name a place the tree is no longer showing. The
    // root is the exception: it has no row and no caret, so it is never shut.
    if (c.dir !== rootP && !ctx.openFolders.has(c.dir)) {
      clearCreate();
      return;
    }
    const at = createRowIndex(model, c.dir, rootP);
    if (at === -1) {
      clearCreate();
      return;
    }
    const depth = at === 0 ? 0 : (model[at - 1]?.depth ?? 0) + 1;
    let icon: Element;
    if (c.kind === 'folder') {
      icon = folderIcon();
      icon.classList.add('files-folder');
    } else {
      // The plain file glyph: a file with no name yet has no type to claim.
      icon = fileIcon(PLAIN_FILE);
    }
    const out = nameRowEl({
      indent: rowIndent(depth),
      caret: '',
      icon,
      // The field IS the label: there is no visible caption to point at, so the
      // accessible name says what is being named and what kind of thing it is.
      label: c.kind === 'folder' ? 'new folder name' : 'new file name',
      value: createText,
      busy: createBusy,
      error: c.error,
      note: null,
      onEnter: commitCreate,
      onEscape: () => cancelCreate(true),
      onBlur: () => cancelCreate(false),
    });
    rows.splice(at, 0, ...out);
  }

  /**
   * The NAME ROW's elements — one input row, then the refusal under it and (a
   * rename only) the quiet note — shared by `New file` / `New folder` (A9c) and
   * `Rename` (B13), so the two questions are one row with one set of rules.
   *
   * It is a `<div>`, like every other row that is not a button, carrying the
   * caret's own spacer so the input starts where a name starts, the mark of the
   * KIND so what is being named is visible before a single letter is typed, and
   * the input itself. The refusal is a second row directly beneath it, at least
   * the same height (it wraps, growing down only), in the ink this app refuses
   * in everywhere. Nothing here changes a
   * width: a row that widened the panel would resize every PTY in the grid.
   *
   * It also sets `nameInput` — the one live input, whichever question it asks.
   */
  function nameRowEl(o: {
    indent: number;
    caret: string;
    icon: Element;
    label: string;
    value: string;
    busy: boolean;
    error: string | null;
    note: string | null;
    onEnter: () => void;
    onEscape: () => void;
    onBlur: () => void;
  }): HTMLElement[] {
    const row = el('div', 'files-row is-new');
    row.style.paddingLeft = `${o.indent}px`;
    // In flight: the same opacity pulse a busy row already wears, and NO
    // height change — a row that grew mid-request would move the tree under
    // the pointer.
    row.classList.toggle('is-busy', o.busy);
    const caret = el('span', 'files-caret', o.caret);
    caret.setAttribute('aria-hidden', 'true');
    row.append(caret, o.icon);
    const input = el('input', 'files-newname');
    input.type = 'text';
    input.setAttribute('aria-label', o.label);
    // A file name is not prose: no squiggles, no capital first letter on a
    // phone keyboard, and no history dropdown over the tree.
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    input.autocomplete = 'off';
    input.value = o.value;
    input.readOnly = o.busy;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        o.onEnter();
        return;
      }
      if (e.key !== 'Escape') return;
      // STOPPED, always: the panel's own Escape would otherwise clear the
      // selection in the same keystroke, and the ladder (§6b) is one effect
      // per press — the name row first, the selection next, the panel last.
      // The keyboard goes back INSIDE the panel, because that is the rung the
      // next press has to reach.
      e.preventDefault();
      e.stopPropagation();
      o.onEscape();
    });
    input.addEventListener('blur', () => {
      // A rebuild replaces this element; in a real browser that can fire a
      // blur for a node nobody left. Both guards answer the same question —
      // "is this still the input the user is standing in?"
      if (rebuilding || !input.isConnected) return;
      // The keyboard is already on its way somewhere the user picked.
      o.onBlur();
    });
    row.append(input);
    nameInput = input;
    const out: HTMLElement[] = [row];
    if (o.error !== null) {
      const err = el('div', 'files-row is-newerr');
      err.style.paddingLeft = `${o.indent}px`;
      err.append(el('span', 'files-name', o.error));
      out.push(err);
    }
    if (o.note !== null) {
      // D4 (B13): not a refusal — the rename is allowed — so it is the tree's
      // quiet ink, not the danger ink, and it WRAPS: a note cut off by an
      // ellipsis at 200px would say half of what it costs.
      const note = el('div', 'files-row is-newnote');
      note.style.paddingLeft = `${o.indent}px`;
      note.append(el('span', 'files-name', o.note));
      out.push(note);
    }
    return out;
  }

  // ---- renaming a file or a folder (part B13) ---------------------------------
  //
  // F2 on the focused row, or `Rename` in its menu
  // (`.claude/plans/nocturne/PLAN-B13.md` § 2). The SAME name row a create
  // draws (`nameRowEl`), put IN PLACE of the row being renamed: same indent,
  // same mark, same `--files-row-h`, no width change — so nothing in the tree
  // moves and no PTY is resized. Same folder only: the request carries a name,
  // never a destination.
  //
  // THE SAME CANCELS AS A CREATE: Escape (the keyboard goes back to the row),
  // blur (it stays where the user put it), a menu opening, a tab switch, a root
  // change, the panel leaving the screen — `dropNaming` — and one name row at a
  // time, create or rename.
  //
  // NOTHING CHANGES OPTIMISTICALLY. The row is renamed when the parent's new
  // listing says so; what the panel remaps at once is only what is KEYED by
  // the old path (open folders, cached listings, the selection, editor tabs),
  // so the renamed folder comes back open, with its rows, and a dirty tab keeps
  // its text (D3).

  /** The rename on screen, or nothing. `error` is the sentence under it. */
  let renaming: { path: string; dir: boolean; error: string | null } | null = null;
  /** What is typed, kept outside the input across repaints (as `createText`). */
  let renameText = '';
  /** The request is out: the input is read-only and the row pulses. */
  let renameBusy = false;
  /** Bumped by every start and every cancel (as `createToken`). */
  let renameToken = 0;
  /**
   * The input's selection across a repaint, and whether the first focus has
   * already selected the stem: the stem is selected ONCE, and a repaint (a
   * listing landing, a refusal drawn) may never re-select over what the user
   * has since placed the caret on.
   */
  let renameRange: TextRange | null = null;
  let renameStemDone = false;
  /** The row being renamed, by key: where Escape hands the keyboard back. */
  let renameReturn: string | null = null;

  /**
   * Begin renaming the row with this key. Guarded like a delete: a copy that
   * is still writing and a delete in flight own the same rows.
   */
  function startRename(key: string): void {
    if (ctx.tab !== 'files') return;
    const path = keyPath(key);
    if (path === '' || !ctx.isRenamable(path)) return;
    if (isDropRunning()) {
      flash(COPY_RUNNING);
      return;
    }
    if (ctx.deleting !== null) {
      flash(DELETE_RUNNING);
      return;
    }
    clearCreate();
    clearRename();
    renaming = { path, dir: keyIsDir(key), error: null };
    renameText = fileName(path);
    // Escape hands the keyboard back to THIS row, drawn again under its name.
    renameReturn = key;
    focusName = true;
    ctx.lastSig = '';
    ctx.render();
  }

  /** Forget the rename. STATE ONLY — the caller decides about painting. */
  function clearRename(): void {
    if (renaming !== null) nameInput = null;
    renaming = null;
    renameText = '';
    renameBusy = false;
    renameToken += 1;
    renameRange = null;
    renameStemDone = false;
  }

  /** Escape (`true`: keyboard back to the row) and blur (`false`: leave it). */
  function cancelRename(giveKeyboardBack: boolean): void {
    if (renaming === null) return;
    const back = renameReturn;
    clearRename();
    focusName = false;
    ctx.lastSig = '';
    ctx.render();
    if (!giveKeyboardBack) return;
    const el =
      back === null ? null : ctx.root.querySelector<HTMLElement>(`[data-k="${CSS.escape(back)}"]`);
    (el ?? ctx.copyBtn).focus();
  }

  /**
   * Enter: the client rules, then the unchanged name (no request — the row
   * just closes), then exactly one request.
   */
  function commitRename(): void {
    if (renaming === null || renameBusy) return;
    const { path, dir } = renaming;
    const name = nameInput === null ? renameText : nameInput.value;
    renameText = name;
    const bad = nameProblem(name);
    if (bad !== null) {
      failRename(nameProblemText(bad));
      return;
    }
    if (isSameName(path, name)) {
      cancelRename(true);
      return;
    }
    // A copy or a delete that started while the row was open owns the same
    // folders: say so where the user is looking, and keep the text.
    if (isDropRunning()) {
      failRename(COPY_RUNNING);
      return;
    }
    if (ctx.deleting !== null) {
      failRename(DELETE_RUNNING);
      return;
    }
    // B4 across a rename: unsaved text already open at the new path (or under
    // it) would be overwritten by the text that follows the rename. Refused
    // here, before anything moves on disk.
    const editPaths = [...st.state.edits.keys()]
      .filter((k) => k.startsWith('f:'))
      .map((k) => k.slice(2));
    if (hasUnsavedAt(editPaths, renamedPath(path, name))) {
      failRename(RENAME_UNSAVED_TAKEN);
      return;
    }
    renameBusy = true;
    renaming = { path, dir, error: null };
    ctx.lastSig = '';
    ctx.render();
    const token = renameToken;
    const gen = ctx.generation;
    ctx.fs.rename(path, name)
      .then(() => {
        const to = renamedPath(path, name);
        // EDITOR TABS FOLLOW, whatever happened to this panel meanwhile (D3):
        // the file really moved, and a tab left on the old path would be a 404
        // holding the user's unsaved text.
        st.retargetFiles(path, to);
        // The ROOT moved under the answer: nothing in this tree is about it.
        if (gen !== ctx.generation) return;
        // Everything KEYED by the old path follows it — also after a cancel,
        // because the thing has been renamed either way.
        for (const p of [...ctx.openFolders]) {
          const q = remapPath(p, path, to);
          if (q !== p) {
            ctx.openFolders.delete(p);
            ctx.openFolders.add(q);
          }
        }
        for (const [p, v] of [...ctx.listings]) {
          const q = remapPath(p, path, to);
          if (q !== p) {
            ctx.listings.delete(p);
            ctx.listings.set(q, v);
          }
        }
        ctx.selected = remapKeys(ctx.selected, path, to);
        const parent = parentPath(path);
        if (token !== renameToken) {
          // A rename opened meanwhile on a row INSIDE the folder that just
          // moved must send the path that exists now, not the old one.
          const open = renaming as { path: string; dir: boolean; error: string | null } | null;
          if (open !== null) {
            renaming = { ...open, path: remapPath(open.path, path, to) };
            const back = renameReturn;
            if (back !== null) renameReturn = rowKey(remapPath(keyPath(back), path, to), keyIsDir(back));
          }
          ctx.fetchFolder(parent);
          ctx.bump();
          return;
        }
        clearRename();
        const key = rowKey(to, dir);
        ctx.selected = afterRowActivate(ctx.selected, key);
        // The keyboard follows the renamed row once its folder answers with
        // it — the create's promise, aimed at the new key.
        focusCreated = { key, dir: parent };
        ctx.fetchFolder(parent);
        ctx.bump();
      })
      .catch((err: unknown) => {
        if (token !== renameToken || gen !== ctx.generation) return;
        renameBusy = false;
        failRename(renameMessage(err));
      });
  }

  /** A refusal under the input: the text stays, the keyboard goes back into it. */
  function failRename(sentence: string): void {
    if (renaming === null) return;
    renaming = { path: renaming.path, dir: renaming.dir, error: sentence };
    ctx.lastSig = '';
    ctx.render();
    liveNameInput()?.focus();
  }

  /**
   * D4: a FOLDER with a live session working at or under it gets the note. The
   * rename is allowed; the note says what it costs.
   */
  function renameNote(path: string, dir: boolean): string | null {
    if (!dir) return null;
    const cwds: string[] = [];
    for (const info of st.state.sessions.values()) {
      if (info.status !== 'exited' && info.cwd !== '') cwds.push(info.cwd);
    }
    return hasSessionInside(cwds, path) ? RENAME_SESSION_NOTE : null;
  }

  /**
   * The rename row, in place of the row it renames: the row's own indent, its
   * own caret and its own mark, so the only thing that changes on screen is
   * the name turning into a field.
   */
  function renameRowEls(r: FsRow): HTMLElement[] {
    const c = renaming as { path: string; dir: boolean; error: string | null };
    let icon: Element;
    if (c.dir) {
      icon = folderIcon();
      icon.classList.add('files-folder');
      if (r.open) icon.classList.add('is-open');
    } else {
      icon = fileIcon(fileIconFor(r.name));
    }
    return nameRowEl({
      indent: r.indent,
      caret: r.caret,
      icon,
      label: c.dir ? 'new name for folder' : 'new name for file',
      value: renameText,
      busy: renameBusy,
      error: c.error,
      note: renameNote(c.path, c.dir),
      onEnter: commitRename,
      onEscape: () => cancelRename(true),
      onBlur: () => cancelRename(false),
    });
  }

  return {
    get creating() { return creating; },
    get createText() { return createText; },
    set createText(v) { createText = v; },
    get createBusy() { return createBusy; },
    get nameInput() { return nameInput; },
    set nameInput(v) { nameInput = v; },
    liveNameInput,
    get focusName() { return focusName; },
    set focusName(v) { focusName = v; },
    get focusCreated() { return focusCreated; },
    set focusCreated(v) { focusCreated = v; },
    get rebuilding() { return rebuilding; },
    set rebuilding(v) { rebuilding = v; },
    startCreate,
    dropNaming,
    refreshRoot,
    refreshIfListed,
    insertNameRow,
    get renaming() { return renaming; },
    get renameText() { return renameText; },
    set renameText(v) { renameText = v; },
    get renameBusy() { return renameBusy; },
    get renameRange() { return renameRange; },
    set renameRange(v) { renameRange = v; },
    get renameStemDone() { return renameStemDone; },
    set renameStemDone(v) { renameStemDone = v; },
    startRename,
    clearRename,
    renameNote,
    renameRowEls,
  };
}
