/**
 * The Files panel's TREE: the listing cache, the lazy per-folder fetch with
 * its generation counter, the root the tree stands in (home learned from the
 * first listing, `setRoot`/`syncRoot`), and `fileRows()` — the Files tab's
 * rows (PLAN-B2 §3, §4a).
 *
 * Split from `ui/files.ts` (O8, 2026-09-23), code moved as it stood.
 * Siblings: `files.ts` (the panel's shell, header, width grip and the menu
 * gesture), `files-ctx.ts` (the shared context), `files-destinations.ts`,
 * `files-tree.ts`, `files-git.ts`, `files-keys.ts`, `files-menu.ts`,
 * `files-naming.ts`, `files-render.ts`.
 */
import { el, button } from './util.ts';
import { armDrag } from './dnd.ts';
import { openFileGuarded } from './unsaved.ts';
import { openCopyFilesPicker } from './filedrop.ts';
import { prunedTo, rowKey } from './files-select-model.ts';
import { folderIcon } from './icons.ts';
import { fileIcon } from './icons-files.ts';
import { fileIconFor, rowIndent } from './files-model.ts';
import {
  LOADING_TEXT,
  fsRows,
  isUnder,
  messageOf,
  type Destination,
  type FolderState,
} from './fs-model.ts';
import type { FilesCtx, TreePart } from './files-ctx.ts';

/**
 * What a file row promises, on hover and to a screen reader. It names the
 * keyboard twin of the drag, because the drag is the only affordance that is
 * otherwise invisible (PROJECT-SCOPE: no control may exist only under a
 * pointer).
 */
const ROW_TITLE = 'Open in a pane. Drag it onto a pane edge to split, or press ctrl+alt+enter.';

/**
 * A folder row's own title. The copy strip sits BEFORE the tree and every row
 * here is a `<button>`, so no amount of tabbing aims that button at a nested
 * folder: the row carries the chord that does (ctrl+alt+c copies into THIS
 * folder), and says so where the user already is.
 */
const DIR_TITLE = 'Open or close it. Copy files into it with ctrl+alt+c. Right-click for its actions.';

export function createTree(ctx: FilesCtx): TreePart {
  // ---- the tree ------------------------------------------------------------
  //
  // One cache (`listings`), one open set, one generation counter, and the pure
  // `fsRows()` walk over the three of them (PLAN-B2 §3). Everything about WHAT
  // a tree looks like mid-flight lives in `ui/fs-model.ts`; what lives here is
  // WHEN a request goes out and what happens to its answer.
  //
  // CACHE-THEN-REVALIDATE. Expanding a folder always starts a request, but a
  // folder that already answered keeps its rows on screen while the new answer
  // travels — so re-expanding never flashes `Loading…`, and the listing is
  // never more than one gesture old.
  //
  // THE GENERATION IS THE SAFETY CATCH. Every request remembers the generation
  // it was made in; `setRoot()` bumps it. A slow listing of the folder the user
  // just left therefore lands in a dead branch instead of painting rows from
  // one folder into the tree of another.

  /** What each folder answered, keyed by ABSOLUTE path. */
  const listings = new Map<string, FolderState>();
  /** Path -> the generation of the request in flight for it (the dedupe). */
  const inFlight = new Map<string, number>();
  /** Bumped by every root change; an answer from an older one is dropped. */
  let generation = 0;
  /**
   * Bumped by every answer that changed something. It is part of `sig()`
   * because the tree is data the panel cannot otherwise see change: without it
   * a listing arriving for an already-open folder would repaint nothing.
   */
  let dataVersion = 0;

  /** An answer changed something: repaint, whatever the signature said before. */
  function bump(): void {
    dataVersion += 1;
    ctx.lastSig = '';
    ctx.render();
  }

  /**
   * Ask for ONE folder's contents. Never repaints synchronously: it is called
   * from inside a render pass (the root) as well as from a click (an expand),
   * and a render that re-enters itself is a loop waiting for a slow network.
   */
  function fetchFolder(path: string): void {
    const gen = generation;
    if (inFlight.get(path) === gen) return;
    inFlight.set(path, gen);
    const cached = listings.get(path);
    // A cached `ready` stays on screen while the new answer travels; a cached
    // ERROR does not — it is the one state that must not outlive the retry.
    if (cached === undefined || cached.k === 'error') listings.set(path, { k: 'loading' });
    dataVersion += 1;
    ctx.fs.entries(path)
      .then((res) => {
        if (gen !== generation) return;
        listings.set(path, { k: 'ready', entries: res.entries, truncated: res.truncated });
      })
      .catch((err: unknown) => {
        if (gen !== generation) return;
        listings.set(path, { k: 'error', message: messageOf(err) });
      })
      .finally(() => {
        if (inFlight.get(path) === gen) inFlight.delete(path);
        if (gen !== generation) return;
        bump();
      });
  }

  /**
   * Open or close one folder. ONE definition, shared by the primary click and
   * the menu's `Open`/`Close` entry, so the named entry can never drift from
   * the gesture it is the name of. Opening one always asks for it again.
   */
  function toggleFolder(path: string): void {
    if (ctx.openFolders.has(path)) ctx.openFolders.delete(path);
    else {
      ctx.openFolders.add(path);
      fetchFolder(path);
    }
    ctx.lastSig = '';
    ctx.render();
  }

  /**
   * The error sentences currently in the cache. A state row carries only its
   * text (`FsRow` has no tone — it is a pure model and a colour is not a fact
   * about a tree), so this is how the renderer tells the SERVER's sentence
   * from `Loading…` without re-deriving either: the message it would paint in
   * danger ink is, by definition, one that some folder is failing with.
   */
  function errorTexts(): Set<string> {
    const out = new Set<string>();
    for (const s of listings.values()) if (s.k === 'error') out.add(s.message);
    return out;
  }

  /**
   * A state row: `Loading…`, `Empty folder`, the server's own sentence, or the
   * quiet note about the rows a cap left out.
   *
   * A `<div>`, never a button: there is nothing to press, and a control that
   * does nothing is worse than a line of text. It is exactly `--files-row-h`
   * tall and sits at the indent of the folder it belongs to, so the rows that
   * replace it land in the same place and NOTHING moves — a row that changed
   * the panel's width would fire every pane's ResizeObserver and resize every
   * PTY in the grid. `.files-name` gives it the same ellipsis rule as a name,
   * so a long server sentence can never widen the panel either.
   */
  function stateRow(text: string, indent: number, danger: boolean): HTMLElement {
    const row = el('div', 'files-row is-state');
    row.classList.toggle('is-err', danger);
    row.style.paddingLeft = `${indent}px`;
    row.append(el('span', 'files-name', text));
    return row;
  }

  // ---- the root ------------------------------------------------------------
  //
  // The folder the tree lists (§4a). It is `subject().path` — the same walk
  // that answers the NAME the header prints — so the panel can never list one
  // folder while calling itself another.
  //
  // HOME IS LEARNED, NOT GUESSED. The app knows no absolute paths of its own:
  // the FIRST listing, the one asked for with no path at all, answers with the
  // home folder's real path and that is what `Home` means from then on. Until
  // it lands the tree honestly says `Loading…`.

  /** The home folder's absolute path, once the first listing has said so. */
  let homePath: string | null = null;
  /** The home probe has gone out (and, on failure, the sentence it came back with). */
  let homeAsked = false;
  let homeError: string | null = null;
  /** The root the tree is currently showing, or null before the first one. */
  let currentPath: string | null = null;
  /** Was the panel on screen at the last render (a return re-reads the root). */
  let wasVisible = false;

  /** Where the tree is rooted right now: `subject()`'s path (§4a). */
  function rootPath(): string | null {
    return ctx.subject().path;
  }

  /** The panel's own root as a destination — the name the header prints, its path. */
  function rootDestination(): Destination | null {
    const path = rootPath();
    if (path === null) return null;
    return { path, name: ctx.subject().name };
  }

  /** The one request that has no path: it teaches the app where home is. */
  function learnHome(): void {
    if (homeAsked) return;
    homeAsked = true;
    ctx.fs.entries()
      .then((res) => {
        homePath = res.path;
        homeError = null;
        listings.set(res.path, { k: 'ready', entries: res.entries, truncated: res.truncated });
      })
      .catch((err: unknown) => {
        homeError = messageOf(err);
      })
      .finally(() => {
        bump();
      });
  }

  /**
   * The root changed under the panel (§4a). `openFolders`, `listings` and the
   * selection are keyed by absolute path, so most of them simply stop
   * matching — but "stop matching" is not enough for the SELECTION, which
   * would keep naming a folder nobody can see while the copy strip promised
   * files to it. So this prunes all three explicitly, bumps the generation so
   * no answer for the old root can paint, and asks for the new one.
   */
  function setRoot(next: string): void {
    currentPath = next;
    generation += 1;
    for (const p of [...ctx.openFolders]) if (!isUnder(p, next)) ctx.openFolders.delete(p);
    for (const p of [...listings.keys()]) if (!isUnder(p, next)) listings.delete(p);
    ctx.selected = prunedTo(ctx.selected, next);
    // A9c: a name row belongs to ONE folder in ONE tree. The root moved under
    // it, so there is nothing left for it to be inside of (§6b).
    ctx.dropNaming('root');
    ctx.changes = null;
    ctx.changesError = null;
    ctx.changesRoot = null;
    // The history belongs to the repository we just left (B3). Its rows are
    // asked for again by the render that follows, if Commits is the tab up.
    ctx.dropCommits();
    dataVersion += 1;
    fetchFolder(next);
    ctx.fetchChanges(next);
  }

  /**
   * Keep the root and the panel's first listing in step with `subject()`.
   * Called at the top of every visible render: the root changes for reasons
   * this panel never hears about directly (a pane took the focus, a session
   * exited, a project was deleted).
   */
  function syncRoot(): boolean {
    const want = rootPath();
    if (want === null) {
      learnHome();
      return false;
    }
    if (want !== currentPath) {
      setRoot(want);
      return true;
    }
    if (!listings.has(want)) fetchFolder(want);
    return false;
  }


  /**
   * The tree (B2): the REAL folder, from the cache and the open set through
   * the pure `fsRows()` walk. Folder rows toggle (and ask for their contents),
   * file rows open that file as a pane (A10), and every state the network puts
   * the tree in is a row of its own at the right indent.
   *
   * The root's own states replace the whole body — `fsRows` emits exactly one
   * state row at depth 0 for them, so there is no second code path for "the
   * tree could not load" and no empty panel with nothing in it.
   */
  function fileRows(): HTMLElement[] {
    const rootP = currentPath;
    if (rootP === null) {
      // Home has not answered yet (or could not). There is no tree to draw and
      // no folder to name, so the body is the one honest row.
      return [stateRow(homeError ?? LOADING_TEXT, rowIndent(0), homeError !== null)];
    }
    const errs = errorTexts();
    const rows: HTMLElement[] = [];
    // The model is walked ONCE and kept: the name row is placed by index
    // (`createRowIndex`), and an element list built from a second walk could
    // be a different tree than the one that index was computed against.
    const model = fsRows(rootP, ctx.openFolders, listings);
    let renameShown = false;
    for (const r of model) {
      let row: HTMLElement;
      if (r.kind === 'state') {
        rows.push(stateRow(r.name, r.indent, errs.has(r.name)));
        continue;
      }
      const key = rowKey(r.path, r.kind === 'dir');
      // B13: the row being renamed is drawn as the name row, in its place.
      if (ctx.renaming !== null && key === rowKey(ctx.renaming.path, ctx.renaming.dir)) {
        renameShown = true;
        rows.push(...ctx.renameRowEls(r));
        continue;
      }
      if (r.kind === 'dir') {
        const b = button('files-row is-dir', '');
        // ONE gesture, TWO effects, in this order (A9b user decision 1): the
        // row becomes the chosen row, and THEN it opens or closes exactly as
        // it always did. A re-click keeps it chosen — the toggle is what
        // flips, the selection is not. ctrl and shift do NEITHER of the two
        // (B10a): they only change the selection, because a ctrl+click that
        // also collapsed the folder would move every row under the pointer
        // in the middle of the gesture.
        b.addEventListener('click', (e) => ctx.onRowClick(e, key, () => toggleFolder(r.path)));
        b.setAttribute('data-k', key);
        b.setAttribute('aria-expanded', r.open ? 'true' : 'false');
        // The row opens the A9b context menu (right-click, menu key, shift+F10),
        // and the house rule is that every control which opens a popup says so.
        b.setAttribute('aria-haspopup', 'menu');
        b.title = DIR_TITLE;
        // The ROW-LEVEL twin of dropping files on this folder, owned here for
        // the same reason ctrl+alt+enter is: it acts on the row that has the
        // focus, and the strip button above cannot be aimed at it with the
        // keyboard at all. Same idiom, same AltGr guard, same stopPropagation
        // so the window chord handler never sees a key this row spent.
        b.addEventListener('keydown', (e) => {
          if ((e.key !== 'c' && e.key !== 'C') || !e.ctrlKey || !e.altKey || e.metaKey) return;
          // AltGr reports as ctrl+alt on European layouts (frontend-terminal-quirks).
          if (e.getModifierState('AltGraph')) return;
          e.preventDefault();
          e.stopPropagation();
          openCopyFilesPicker({ path: r.path, name: r.name });
        });
        ctx.armRowMenuChord(b, key);
        row = b;
      } else {
        // A10: a file row opens that file as a PANE of its root folder's tab.
        // The path is absolute since B2; the pane cannot read the file until
        // part B4 and says so in its own quiet line.
        const b = button('files-row is-file', '');
        // Since B10a a file row is CHOSEN by a plain click as well as opened —
        // it is something the user can now delete and copy — and ctrl/shift
        // choose it without opening anything at all.
        b.addEventListener('click', (e) =>
          ctx.onRowClick(e, key, () => {
            openFileGuarded(ctx.currentRoot(), r.path, r.name, { returnFocus: b });
          }),
        );
        b.setAttribute('data-k', key);
        b.setAttribute('aria-haspopup', 'menu');
        b.title = ROW_TITLE;
        // The row of a file that is on screen keeps a ground, so the tree says
        // where the panes are standing.
        b.classList.toggle('is-open', ctx.pathIsOpen(r.path));
        // Pointer twin: drag the row onto a pane edge / centre / tab chip.
        // `null`, not `'button'`: the row IS the button, so an ignore selector
        // of `'button'` would match the row itself and arm nothing.
        armDrag(b, null, () => ({ kind: 'file', path: r.path, label: r.name }));
        // Keyboard twin, owned HERE rather than in main.ts: it acts on the row
        // that has the focus, which is this module's business and nothing the
        // window handler can see. It stops propagating so the window chord
        // handler never sees a key this row already spent.
        b.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' || !e.ctrlKey || !e.altKey || e.metaKey) return;
          // AltGr reports as ctrl+alt on European layouts (frontend-terminal-quirks).
          if (e.getModifierState('AltGraph')) return;
          e.preventDefault();
          e.stopPropagation();
          ctx.openBeside(r.path, r.name);
        });
        ctx.armRowMenuChord(b, key);
        row = b;
      }
      row.style.paddingLeft = `${r.indent}px`;
      // The chosen rows, painted from the KEYS and not from live elements —
      // which is what makes a selection survive this very rebuild. Folders and
      // files alike since B10a, and there may be many of them at once.
      const isSel = ctx.selected.keys.has(key);
      row.classList.toggle('is-sel', isSel);
      // The class is colour; `aria-current` is the same fact for a screen
      // reader. REMOVED, never `'false'`: an absent attribute is the honest
      // "not chosen". (The tree carries no `role="tree"` and no
      // `aria-multiselectable` — recorded limitation, B10a — so this attribute
      // and the menu's counted label are how a selection is spoken at all.)
      if (isSel) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
      // A row whose delete is in flight wears the same opacity pulse the busy
      // name row does: no height change, so nothing on screen moves.
      row.classList.toggle('is-busy', ctx.deleting !== null && ctx.deleting.has(key));

      const caret = el('span', 'files-caret', r.caret);
      caret.setAttribute('aria-hidden', 'true');
      row.append(caret);

      if (r.kind === 'dir') {
        const ic = folderIcon();
        ic.classList.add('files-folder');
        if (r.open) ic.classList.add('is-open');
        row.append(ic);
      } else {
        row.append(fileIcon(fileIconFor(r.name)));
      }

      // No `+N -N` here any more: a browser knows what is IN a folder, not
      // what a repository has changed. Those numbers moved to `Changes`.
      row.append(el('span', 'files-name', r.name));
      rows.push(row);
    }
    // A rename whose row is no longer in the tree (a re-listing without it, a
    // folder above it closed) is dropped, like a create whose folder left.
    // While a folder ABOVE it is being re-read the row may be missing for a
    // moment (that folder was just renamed and its new row has not been listed
    // yet): kept, and the input takes the keyboard back when it is drawn again.
    if (ctx.renaming !== null && !renameShown) {
      const r = ctx.renaming;
      const listing = [...inFlight.keys()].some((p) => p !== r.path && isUnder(r.path, p));
      if (listing) ctx.focusName = true;
      else ctx.clearRename();
    }
    // One element per model row above, so the model's index IS this list's.
    // (A rename row can add a line or two, but a create and a rename are never
    // on screen together.)
    ctx.insertNameRow(rows, model, rootP);
    return rows;
  }

  return {
    get listings() { return listings; },
    get inFlight() { return inFlight; },
    get generation() { return generation; },
    get dataVersion() { return dataVersion; },
    bump,
    fetchFolder,
    toggleFolder,
    stateRow,
    get homePath() { return homePath; },
    get homeAsked() { return homeAsked; },
    set homeAsked(v) { homeAsked = v; },
    get currentPath() { return currentPath; },
    get wasVisible() { return wasVisible; },
    set wasVisible(v) { wasVisible = v; },
    rootPath,
    rootDestination,
    syncRoot,
    fileRows,
  };
}
