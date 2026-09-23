/**
 * The Files panel's own keyboard (parts A9b, A9c, B10a, B13): the ONE
 * bubble-phase keydown listener on the panel root — the root menu's chord,
 * Escape on the selection, Delete, F2, ctrl+a, ctrl+space / ctrl+enter and
 * the arrow keys — plus the mouse half of the selection rules and the reads
 * that tell which tree row holds the keyboard.
 *
 * Split from `ui/files.ts` (O8, 2026-09-23), code moved as it stood.
 * Siblings: `files.ts` (the panel's shell, header, width grip and the menu
 * gesture), `files-ctx.ts` (the shared context), `files-destinations.ts`,
 * `files-tree.ts`, `files-git.ts`, `files-keys.ts`, `files-menu.ts`,
 * `files-naming.ts`, `files-render.ts`.
 */
import * as st from '../state.ts';
import {
  afterEscape,
  afterRange,
  afterRowActivate,
  afterSelectAll,
  afterToggle,
  destinationPath,
  keyPath,
  size as selectionSize,
} from './files-select-model.ts';
import { isContextMenuChord, isEditableTarget, OPEN_MODAL_SELECTOR } from './keys.ts';
import { destinationOf, type Destination } from './fs-model.ts';
import type { FilesCtx, KeysPart } from './files-ctx.ts';

export function createKeys(ctx: FilesCtx): KeysPart {
  /**
   * Escape, spent on the selection BEFORE `main.ts`'s ladder can see it.
   *
   * Bubble phase on the panel root, exactly like the row chords above it
   * (ctrl+alt+enter, ctrl+alt+c): a surface-local state is the surface's own
   * business, and the ladder — whose Files arm closes the whole panel — stays
   * untouched. With nothing selected this does NOT stop the key, so the next
   * Escape closes the panel as it always did.
   */
  ctx.root.addEventListener('keydown', (e) => {
    // The ROOT menu's keyboard twin (A9c, §6a), on the SAME listener and with
    // the same ownership rule as the row chord: the focus is inside the panel
    // and NOT on a row, so nothing else in the app is looking at this key — a
    // focused terminal never reaches here at all. A row (or the name row's own
    // input, which lives inside one) keeps its own chord, which is why this
    // arm steps aside for anything wearing `.files-row`.
    //
    // IT IS WIDER THAN THE POINTER'S RULE ON PURPOSE. A right-click answers
    // only inside the tree body (the list is the folder; the header, the tabs
    // and the copy strip keep the system menu). Nothing inside that list is
    // focusable except the rows themselves, which own the chord — so a
    // keyboard rule that narrow would leave the gesture with no keyboard twin
    // at all, and this project forbids a control that exists only under a
    // pointer.
    if (isContextMenuChord(e)) {
      const t = e.target instanceof Element ? e.target : null;
      if (t !== null && t.closest('.files-row') !== null) return;
      if (!ctx.openRootMenuAt(ctx.pointOf(t))) return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Escape') {
      // Nothing chosen: the key is NOT spent here, so the ladder's Files arm
      // closes the panel exactly as it always did.
      if (selectionSize(ctx.selected) === 0) return;
      e.preventDefault();
      e.stopPropagation();
      ctx.selected = afterEscape(ctx.selected);
      ctx.lastSig = '';
      ctx.render();
      return;
    }
    // The name row's own input keeps every key of its own (a Delete inside a
    // half-typed name is an edit, not a filesystem act).
    if (isEditableTarget(e.target instanceof HTMLElement ? e.target : null)) return;
    if (onSelectionKey(e)) return;
  });

  // ---- the keyboard, inside the panel (part B10a) ---------------------------
  //
  // Arrow keys, ctrl+a, ctrl+space and Delete, on the SAME bubble-phase
  // listener above and with the same ownership rule as every row chord here:
  // the focus is inside this panel, so a focused terminal never sees any of
  // them and no window handler is looking. They stop propagating, so nothing
  // behind the panel reads a key the tree already spent.
  //
  // WHY THE TREE HAS ARROW KEYS AT ALL (orchestrator's call, 2026-09-20): it
  // had none, and a selection you can only build with a pointer would fail
  // this project's "no control exists only under a pointer" rule the moment
  // ctrl+click became the way to choose a second row.
  //
  // NO WRAP on the arrows, unlike the context menu's roving focus: a tree is a
  // place, and falling off its end back to the top is how a keyboard user
  // deletes a row they never looked at.

  /**
   * One of this panel's own keys, or not. Answers whether the key was spent.
   */
  function onSelectionKey(e: KeyboardEvent): boolean {
    if (ctx.tab !== 'files') return false;
    if (e.metaKey || e.getModifierState('AltGraph')) return false;
    if (e.key === 'Delete' && !e.ctrlKey && !e.altKey) {
      // A dialog up means the window is not the panel's: its own confirmation
      // is exactly such a dialog, so this is also what stops a second Delete
      // from stacking a second question on the first one.
      if (document.querySelector(OPEN_MODAL_SELECTOR) !== null) return false;
      e.preventDefault();
      e.stopPropagation();
      // Shift is ignored on purpose: this delete IS the permanent one, so
      // Explorer's "shift means skip the recycle bin" has nothing to add.
      ctx.runDelete(activeTreeKey(), activeRowEl());
      return true;
    }
    if (e.key === 'F2' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      // B13: rename the row the keyboard is standing on — the row alone, even
      // inside a larger selection. Owned HERE, on the panel's own listener, so
      // an F2 pressed in a focused terminal never comes near it and reaches the
      // PTY as it always did. A dialog up means the window is not the panel's.
      if (document.querySelector(OPEN_MODAL_SELECTOR) !== null) return false;
      const key = activeTreeKey();
      // Not on a tree row, or on a row that may not be renamed (D2): the key
      // does nothing and is left alone.
      if (key === null || !ctx.isRenamable(keyPath(key))) return false;
      e.preventDefault();
      e.stopPropagation();
      ctx.startRename(key);
      return true;
    }
    if ((e.key === 'a' || e.key === 'A') && e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      // Every VISIBLE row — the only reading of "all" the user can see.
      ctx.selected = afterSelectAll(ctx.selected, visibleKeys());
      ctx.lastSig = '';
      ctx.render();
      return true;
    }
    if ((e.key === ' ' || e.key === 'Enter') && e.ctrlKey && !e.altKey && !e.shiftKey) {
      const key = activeTreeKey();
      if (key === null) return false;
      e.preventDefault();
      e.stopPropagation();
      ctx.selected = afterToggle(ctx.selected, key);
      ctx.lastSig = '';
      ctx.render();
      return true;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return false;
    if (e.altKey) return false;
    const keys = visibleKeys();
    const from = keys.indexOf(activeTreeKey() ?? '');
    // The keyboard is not on a tree row (the tabs, the copy strip, the width
    // grip): those controls keep their own arrow keys, and the grip's are a
    // width nudge.
    if (from === -1) return false;
    const to = Math.min(Math.max(from + (e.key === 'ArrowDown' ? 1 : -1), 0), keys.length - 1);
    const next = keys[to];
    if (next === undefined) return false;
    e.preventDefault();
    e.stopPropagation();
    // THE FOCUS MOVES FIRST, and the repaint then restores it by `data-k`
    // (`paint()`): a selection painted before the focus moved would rebuild
    // the rows under the old one and hand the keyboard back to it.
    focusRow(next);
    if (e.shiftKey && !e.ctrlKey) {
      ctx.selected = afterRange(ctx.selected, next, keys);
      ctx.lastSig = '';
      ctx.render();
    }
    return true;
  }

  /**
   * The mouse half of the same rules (Explorer's): shift ranges, ctrl toggles,
   * and a plain click chooses this row alone AND does what the row does — open
   * a file, open or close a folder.
   *
   * A modified click does NOT activate. That is the whole reason this is one
   * function: ctrl+clicking five rows must not open five panes, and
   * shift+clicking a range must not collapse the folder at either end.
   */
  function onRowClick(e: MouseEvent, key: string, activate: () => void): void {
    if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      ctx.selected = afterRange(ctx.selected, key, visibleKeys());
      ctx.lastSig = '';
      ctx.render();
      return;
    }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      ctx.selected = afterToggle(ctx.selected, key);
      ctx.lastSig = '';
      ctx.render();
      return;
    }
    ctx.selected = afterRowActivate(ctx.selected, key);
    activate();
    // A file row's `activate` opens a pane and repaints through state.ts; a
    // folder's `toggleFolder` renders itself. Neither knows about the
    // selection, so the repaint that PAINTS it is forced here.
    ctx.lastSig = '';
    ctx.render();
  }

  /** The tree's rows that are really on screen, in tree order (top to bottom). */
  function visibleKeys(): string[] {
    const out: string[] = [];
    for (const node of ctx.root.querySelectorAll<HTMLElement>('.files-body .files-row')) {
      const key = node.getAttribute('data-k') ?? '';
      // Only the TREE's own rows: a `Changes` row (`gdir:`/`gfile:`) carries a
      // repo-relative path nothing here can act on, and a state row has no key.
      if (keyPath(key) !== '') out.push(key);
    }
    return out;
  }

  /** The tree row the keyboard is standing on, or null. */
  function activeTreeKey(): string | null {
    const el = activeRowEl();
    if (el === null) return null;
    const key = el.getAttribute('data-k') ?? '';
    return keyPath(key) === '' ? null : key;
  }

  /** That row as an element — where a menu hangs from and where focus returns. */
  function activeRowEl(): HTMLElement | null {
    const a = document.activeElement;
    if (!(a instanceof HTMLElement) || a.closest('.files-view') === null) return null;
    return a.closest<HTMLElement>('.files-row');
  }

  /** Move the keyboard to one row, by key. */
  function focusRow(key: string): void {
    ctx.root.querySelector<HTMLElement>(`[data-k="${CSS.escape(key)}"]`)?.focus();
  }

  /**
   * The selection as a NAME, for the three readers outside this region: the
   * copy strip's title, `pasteDestination()` and `selectedFolder()`.
   *
   * A panel that is not on screen answers NOTHING even before the render pass
   * that clears the selection has run — `afterPanelHidden` is the state, this
   * is the guarantee, and the guarantee is what a paste arriving from a
   * focused terminal actually asks.
   */
  function currentSelectedDest(): Destination | null {
    if (!st.filesPanelVisible()) return null;
    // ONE row of the selection decides, and it is the ANCHOR — the row the
    // user touched last (`destinationPath`: the folder itself, or a file's
    // parent). A set of rows spread over several folders has no other honest
    // answer, and B10a is the part that made a FILE row selectable at all.
    const dest = destinationPath(ctx.selected);
    if (dest === null || dest === '') return null;
    const root = ctx.rootPath();
    if (root === null) return null;
    // `destinationOf` is the one place a name is derived from a path, so the
    // panel asks it rather than deriving a second one here.
    return destinationOf(dest, root, ctx.subject().name);
  }

  return {
    onRowClick,
    visibleKeys,
    activeRowEl,
    currentSelectedDest,
  };
}
