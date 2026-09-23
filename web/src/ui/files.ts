/**
 * Files panel (Nocturne part A5, live since part B2) — the left panel: the
 * real file tree of the folder the app is standing in, what that folder's
 * repository has changed since its last commit, and the commits before that.
 *
 * PLACE IN THE SHELL. It is a flex sibling of the pane grid, exactly like the
 * two drawers, because that is what makes opening it a REAL layout change:
 * the grid narrows, every TerminalView's ResizeObserver fires, and the
 * existing debounced fit -> ws `resize` chain tells the PTY its new cols/rows.
 * Nothing here talks to a terminal; the seam does the work.
 *
 * WHAT IS REAL (parts B2 and B3). All three tabs: a real browser of a real
 * folder, the real `git` answer for the repository behind it, and — since B3 —
 * the real history of its HEAD, ten commits a page. Every answer arrives
 * through an INJECTED `FsGateway`, never through an import of `../api.ts`, so
 * this module stays drivable under `node --test` with a plain fake object, and
 * no honesty line is owed anywhere in the panel. File CONTENT is part B4
 * (live): a file row opens an editor pane on the file itself.
 *
 * HOW THE TREE LOADS (PLAN-B2 §3). Lazy per folder on expand,
 * cache-then-revalidate (a folder that already answered never flashes
 * `Loading…` again), one request per path at a time, and a GENERATION counter
 * so a slow listing of the folder we just left can never paint over the one we
 * are in. No poll and no watcher: a listing is re-read when the user expands,
 * creates or refreshes. The `Changes` and `Commits` tabs are the exception and
 * poll every `CHANGES_POLL_MS` — but only while one of them is the visible tab
 * AND the panel is on screen, because those tabs exist to watch a session
 * change files and commit them.
 *
 * WHICH FOLDER IS THE ROOT (§4a). `subject()` answers both the NAME the header
 * prints and the PATH the tree lists, in one walk, so the two can never name
 * different folders: a focused file/diff pane -> its tab's folder, a focused
 * session -> its project's path or its own working directory, nothing ->
 * `Home` (the path the first listing told us). Every row is also a pointer
 * drag source, and its keyboard twin is ctrl+alt+enter; the row menu's twin is
 * the ContextMenu key or shift+f10 — a control that exists only under a
 * pointer is forbidden here.
 *
 * VISIBILITY. `state.leftPanel === 'files'` is the user's wish;
 * `st.filesPanelVisible()` adds "the Projects drawer is not borrowing the left
 * side" and is the only thing main.ts consults. A session is NOT a condition:
 * the panel opens with nothing running and the header then reads `Home` (user
 * decision 2026-09-15, deviates from v3, which also required a live session).
 *
 * WIDTH. 200..520px, dragged on the right edge with pointer capture, nudged
 * with the arrow keys — the same contract the pane split dividers already use,
 * because a control that only exists under a pointer is forbidden here.
 *
 * SPLIT (O8, 2026-09-23). This module keeps the panel's shell — the gateway
 * type, `initFilesPanel()` with its tabs, selection, header, copy strip, width
 * grip, `subject()` and the gesture that opens the row menu — and re-exports
 * the destination answers. The regions of the old closure moved, as they
 * stood, into `files-destinations.ts`, `files-tree.ts`, `files-git.ts`,
 * `files-keys.ts`, `files-menu.ts`, `files-naming.ts` and `files-render.ts`;
 * they share one context object (`files-ctx.ts`).
 */
import * as st from '../state.ts';
import { el, button } from './util.ts';
import { flashOpenResult } from './dnd.ts';
import { openFileGuarded, openTabAtGuarded } from './unsaved.ts';
import { openCopyFilesPicker } from './filedrop.ts';
import {
  afterMenuOpen,
  COPY_LABEL,
  copyIntoText,
  copyStripLabel,
  destinationPath,
  EMPTY,
  type Selection,
} from './files-select-model.ts';
import { itemsFor, menuLabel } from './context-menu-model.ts';
import { openRowMenu } from './context-menu.ts';
import { hasHostBridge } from './host-bridge.ts';
import { fileName, rootForSubject } from './slots-model.ts';
import type {
  FsCreateResponse,
  FsDeleteResponse,
  FsEntriesResponse,
  FsRenameResponse,
  FsWinPathResponse,
  GitChangesResponse,
  GitCommitsResponse,
  SessionInfo,
} from '../../../shared/protocol.ts';
import { share, type CorePart, type FilesCtx, type Tab } from './files-ctx.ts';
import { noteFocus, pasteDestination, projectDest, setLive, type Subject } from './files-destinations.ts';
import { createTree } from './files-tree.ts';
import { createGit } from './files-git.ts';
import { createKeys } from './files-keys.ts';
import { createMenu } from './files-menu.ts';
import { createNaming } from './files-naming.ts';
import { createRender } from './files-render.ts';

/** Arrow-key step for the width, in px — the keyboard twin of the edge drag. */
const NUDGE_PX = 16;

export interface FilesPanel {
  render(): void;
}

/**
 * The backend, INJECTED (PLAN-B2 §9). This module deliberately does not import
 * `../api.ts`: the same discipline that keeps `ui/panes.ts` out of it (its
 * import graph reaches @xterm/xterm) keeps the panel drivable under
 * `node --test` against a plain fake object, and it is `main.ts` — the one
 * module that is allowed to know about HTTP — that hands the real one over.
 */
export interface FsGateway {
  /** One folder's listing. The path is OMITTED exactly once: to learn where home is. */
  entries(path?: string): Promise<FsEntriesResponse>;
  /** One empty file or one folder (part A9c). */
  create(dir: string, name: string, kind: 'file' | 'folder'): Promise<FsCreateResponse>;
  /** What the repository at (or above) this folder has changed since its last commit. */
  changes(root: string): Promise<GitChangesResponse>;
  /**
   * One page of that repository's history, newest first (part B3). `skip` and
   * `limit` page it; `from` PINS every page after the first to the head the
   * first one answered, so a commit landing mid-browse can never shift a row
   * down into the next page or repeat one that is already on screen.
   */
  commits(root: string, limit: number, skip: number, from?: string): Promise<GitCommitsResponse>;
  /**
   * The Windows form of one path, for the row menu's `Copy` (B10). It is a
   * gateway call like the other three for the same reason they are: this
   * module never imports `../api.ts`, so the panel stays drivable under
   * `node --test` — and the MAPPING is the server's anyway, behind the same
   * boundary every other filesystem route sits behind.
   */
  winPath(path: string): Promise<FsWinPathResponse>;
  /**
   * Delete these paths for good (B10a). ONE request per confirmed action — the
   * user is asked once, so the whole selection travels in one call — and the
   * answer is index-keyed to the list that was sent: `results[i]` is about
   * `paths[i]`, each with its own `ok`.
   *
   * PERMANENT: nothing here goes to a trash. The confirmation in
   * `ui/delete-dialog.ts` is the only stop before this call, and a REJECTION
   * means the request itself was refused and nothing was touched.
   */
  delete(paths: string[]): Promise<FsDeleteResponse>;
  /**
   * Give ONE row a new name in the same folder (B13). The answer carries no
   * path: the panel builds the new one itself (`renamedPath`), because its tree
   * is keyed by the path as shown and the server works on the resolved parent.
   * A taken name is REFUSED with the server's own sentence, never replaced.
   */
  rename(path: string, name: string): Promise<FsRenameResponse>;
}

// The destination answers the drop layer asks (part A9) live in
// `files-destinations.ts` since O8; importers keep reaching them here.
export {
  destinationOfActiveView,
  destinationOfPane,
  filesPanelDestination,
  listingFor,
  pasteDestination,
  refreshAfterDrop,
  selectedFolder,
} from './files-destinations.ts';

/**
 * `onLeaveScreen` hands the keyboard back to the focused terminal after the
 * panel closed a surface the user was standing in (the commit view's
 * `All commits`). It is INJECTED rather than imported for the same reason
 * ui/panes.ts takes its launch opener that way — and here it also keeps this
 * module free of `ui/panes.ts`, whose import graph reaches @xterm/xterm, so
 * the panel stays drivable under `node --test`.
 *
 * `now` is the clock the Commits tab says `3 hours ago` against (part B3),
 * injected for the same reason: a relative time is computed at every repaint,
 * and a test must be able to say what "now" is.
 */
export function initFilesPanel(
  host: HTMLElement,
  onLeaveScreen: () => void,
  fs: FsGateway,
  now: () => number = () => Date.now(),
): FilesPanel {
  // Local to the panel instance: which tab is up, which folders are open, and
  // what each open folder answered. None of it is server state and none of it
  // survives a reload — a remembered set of absolute paths would be a promise
  // about a filesystem that moved on.
  //
  // TWO TABS, NOT ONE. `wish` is what the user CHOSE; `tab` is what is on
  // screen. They differ only while the wished tab has no repository behind it
  // — and the difference is what keeps a root change from throwing the user
  // out of `Changes`: between two repositories the answer is unknown for a
  // moment (`setRoot` drops the old one), and "unknown" is not "no".
  let wish: Tab = 'files';
  let tab: Tab = 'files';
  const openFolders = new Set<string>();

  // ---- selection -----------------------------------------------------------
  //
  // WHICH ROWS ARE CHOSEN (part A9b, user decision 1, 2026-09-16; MANY of them
  // since B10a, 2026-09-20), as row KEYS (`fdir:`/`ffile:` + path) because a
  // key is what identifies a row across a rebuild and what tells a folder
  // apart from a file. Every decision about it lives in
  // `ui/files-select-model.ts`; this region only holds it, paints it, spends
  // the Escape key on it and acts on it.
  //
  // It sits here, beside `openFolders`, for the same reason that set does: it
  // is not server state, it is not persisted, and no module outside this
  // panel renders it. `state.ts` and the localStorage schema do not change by
  // one line for it.
  //
  // WHY IT SURVIVES EVERYTHING. It is part of `sig()` and `rebuild()` paints
  // `is-sel` from the keys, so a folder toggle, a subject change, a tab switch
  // and every other repaint leave it exactly where it was — including a chosen
  // row whose ANCESTOR was collapsed, which draws no row but is still part of
  // what the next Delete or Copy is about (`actEntries`).
  let selected: Selection = EMPTY;
  /**
   * The rows of the delete that is in flight, by key — `is-busy` while it
   * runs, and the "one batch at a time" guard (a second answer could not be
   * matched against the right list of items). Null when nothing is running.
   */
  let deleting: Set<string> | null = null;
  /**
   * Where the keyboard goes after a confirmed delete, once the row it was
   * standing on really leaves the tree (`gone`), in preference order
   * (`candidates`). Null when nothing is pending.
   *
   * It is a PROMISE kept by `paint()`, exactly like `focusCreated`, because
   * the row does not disappear with the answer: it disappears with the
   * listing the answer triggers, one or more repaints later. Without it a
   * keyboard-only delete (Delete, then Enter on the confirmation) ends with
   * the focus on `<body>`, where no key in this app reaches anything.
   */
  let focusAfterDelete: { gone: ReadonlySet<string>; candidates: string[] } | null = null;

  const root = el('section', 'files-view');

  // ---- the pieces (O8) -------------------------------------------------------
  //
  // The rest of this closure lives in sibling factories, each called ONCE
  // here, in the order its region stood in this function: the tree and its
  // root (`files-tree.ts`), Changes and Commits (`files-git.ts`), the panel's
  // own keys — its bubble-phase keydown listener is registered by
  // `createKeys`, exactly where it was (`files-keys.ts`), the row menu's
  // entries and the delete (`files-menu.ts`), the name row of a create or a
  // rename (`files-naming.ts`) and the repaint (`files-render.ts`). They all
  // share this ONE `ctx`: every state member on it is an accessor over the
  // single `let` its owner declares (`files-ctx.ts`).
  const ctx = {} as FilesCtx;
  const core: CorePart = {
    // State: a getter (and, where another piece writes it, a setter) over this
    // closure's `let`.
    get wish() { return wish; },
    get tab() { return tab; },
    set tab(v) { tab = v; },
    get openFolders() { return openFolders; },
    get selected() { return selected; },
    set selected(v) { selected = v; },
    get deleting() { return deleting; },
    set deleting(v) { deleting = v; },
    get focusAfterDelete() { return focusAfterDelete; },
    set focusAfterDelete(v) { focusAfterDelete = v; },
    // The shell's elements: getters, because all but `root` are built further
    // down, after the pieces — a plain value here would read them before
    // their `const` exists.
    get root() { return root; },
    get tabBtns() { return tabBtns; },
    get projName() { return projName; },
    get summary() { return summary; },
    get sumAdd() { return sumAdd; },
    get sumDel() { return sumDel; },
    get sumText() { return sumText; },
    get body() { return body; },
    get selHd() { return selHd; },
    get copyBtn() { return copyBtn; },
    // Functions and the injected deps.
    openRowMenuFor,
    syncCopyStrip,
    subject,
    currentRoot,
    pathIsOpen,
    openBeside,
    headerName,
    fs,
    onLeaveScreen,
    now,
  };
  share(ctx, core);
  share(ctx, createTree(ctx));
  share(ctx, createGit(ctx));
  share(ctx, createKeys(ctx));
  share(ctx, createMenu(ctx));
  share(ctx, createNaming(ctx));
  share(ctx, createRender(ctx));

  // ---- the row menu ---------------------------------------------------------
  //
  // A right-click on a row, and its keyboard twin (part A9b, user decision 3).
  // The menu itself is `ui/context-menu.ts`; what lives here is WHICH gestures
  // open it and on which rows — what each entry then does is
  // `files-menu.ts` (O8).
  //
  // ONE DELEGATED LISTENER on the panel root, not one per row: the rows are
  // rebuilt wholesale on every repaint, and a per-row listener would be
  // re-registered a few dozen times a minute for nothing.
  //
  // IT ACTS INSIDE A ROW AND NOWHERE ELSE. The panel's own background, a pane,
  // a terminal, the tab strip, the statusline, the drawers, every dialog: the
  // event is not touched and the system menu opens exactly as it does today —
  // which inside a terminal is xterm's own arrangement (its `contextmenu`
  // handler puts the selection in its helper textarea so the system menu's
  // Copy and Paste act on the terminal), and A9b leaves every byte of it alone.
  root.addEventListener('contextmenu', (e) => {
    // `Element`, NOT `HTMLElement`: a row holds an SVG folder mark, and an
    // `SVGElement` is not an `HTMLElement`. MEASURED in a real browser
    // (headless Edge, 2026-09-16): with the narrower test the right-click that
    // landed on the folder icon — a third of the row's height — opened nothing
    // at all and was not even prevented, so the system menu appeared instead.
    const t = e.target instanceof Element ? e.target : null;
    const row = t === null ? null : t.closest<HTMLElement>('.files-row');
    // NOT A ROW: the panel's own background, which since A9c answers the ROOT
    // menu (§6a) — the folder the header names, the folder the tree lists. It
    // is taken only when there IS something to offer (the Files tab, a known
    // root); otherwise the event is left alone and the system menu opens,
    // exactly as it did before.
    if (row === null) {
      // THE TREE BODY, not the whole panel. `.files-view` also holds the
      // header (the project's name), the three tabs, the copy strip and the
      // width grip — real controls with text of their own, and a right-click
      // there is the system's business (select the name, inspect the button).
      // The list that draws the rows is the only surface that IS the folder.
      if (t === null || t.closest('.files-body') === null) return;
      if (!ctx.openRootMenuAt({ x: e.clientX, y: e.clientY })) return;
      e.preventDefault();
      return;
    }
    // The KEY decides, not the class. Three kinds of thing wear `.files-row`:
    // a tree row (`fdir:`/`ffile:`), a STATE row (`Loading…`, a refusal — no
    // key at all), and a `Changes` row (`gdir:`/`gfile:`, a repo-relative
    // path nothing here can act on). Only the first has actions, so only the
    // first may take the event: preventing before this check left the other
    // two with no app menu AND no system menu — a right-click that did
    // nothing at all.
    const key = row.getAttribute('data-k') ?? '';
    if (!key.startsWith('fdir:') && !key.startsWith('ffile:')) return;
    // Only now: the system menu must not open over ours.
    e.preventDefault();
    openRowMenuFor(key, { x: e.clientX, y: e.clientY });
  });

  /**
   * Open the menu for the row carrying this `data-k`, at this point.
   *
   * SELECTION FIRST, THEN THE MENU. A right-click on a folder row selects it
   * (Explorer's behaviour, and what lets `Copy files here…` name a folder out
   * loud) and does NOT toggle it — the toggle belongs to the primary click,
   * and the menu offers `Open`/`Close` as a named entry instead. A file row
   * selects nothing. The repaint that a new selection causes REPLACES the row
   * element, so the menu is anchored to the row found AFTER it, and
   * `returnFocus` is that same fresh element.
   */
  function openRowMenuFor(key: string, at: { x: number; y: number }): void {
    const dir = key.startsWith('fdir:');
    if (!dir && !key.startsWith('ffile:')) return;
    const path = key.slice(dir ? 'fdir:'.length : 'ffile:'.length);
    if (path === '') return;

    // A9c: any menu opening cancels a name row (§6b). It is done FIRST, so the
    // repaint below is the one that removes it and the menu is anchored to the
    // rows the user will actually see under it.
    ctx.dropNaming('menu');
    const before = selected;
    // Explorer's rule, in the model: a row ALREADY IN the selection leaves it
    // alone (right-clicking one of five chosen rows asks about all five); any
    // other row becomes the selection, and the anchor.
    selected = afterMenuOpen(selected, key);
    if (selected !== before) {
      // The selection alone changed — no folder toggled — so nothing else
      // would invalidate the signature and the chosen row would stay unpainted
      // while the copy strip already named it.
      ctx.lastSig = '';
      ctx.render();
    }
    const row = root.querySelector<HTMLElement>(`[data-k="${CSS.escape(key)}"]`);
    const name = fileName(path);
    // ONE subject for both halves of the menu (B10 adds `canCopy`, B10a
    // `deletable` and `count`): the entries and the name a screen reader hears
    // are answered about the same row, and the clipboard, anchor and count
    // questions are asked at OPEN time, which is the moment the entries are
    // drawn.
    const subject = {
      dir,
      name,
      open: openFolders.has(path),
      canCopy: hasHostBridge(),
      deletable: !ctx.isAnchor(path),
      // B13 D2 — the SAME predicate F2 asks (`isRenamable`), so the entry and
      // the key can never disagree about a row.
      renamable: ctx.isRenamable(path),
      count: ctx.actCount(key),
    };
    openRowMenu({
      items: itemsFor(subject),
      at,
      label: menuLabel(subject),
      returnFocus: row,
      onChoose: (action) => ctx.runMenuAction(action, key, path, name),
    });
  }

  // ---- header: the three tabs, then the name of what we are looking at -----
  const hd = el('header', 'files-hd');
  const tabsRow = el('div', 'files-tabs');
  tabsRow.setAttribute('role', 'group');
  tabsRow.setAttribute('aria-label', 'files, changes or commits');
  const tabBtns = new Map<Tab, HTMLButtonElement>();
  for (const t of [
    { k: 'files' as const, label: 'Files' },
    { k: 'changes' as const, label: 'Changes' },
    { k: 'commits' as const, label: 'Commits' },
  ]) {
    const b = button('files-tab', t.label, () => setTab(t.k));
    b.setAttribute('data-k', `ftab:${t.k}`);
    tabBtns.set(t.k, b);
    tabsRow.append(b);
  }
  const projName = el('span', 'files-proj');
  hd.append(tabsRow, el('span', 'drawer-gap'), projName);

  // ---- the changes tab's summary hairline, and the body --------------------
  // The summary belongs to `Changes` since B2: `+A -D since last commit in N
  // files` is a fact about a REPOSITORY, and the Files tab browses a folder,
  // which has no commits to be since.
  const summary = el('div', 'files-sum');
  const sumAdd = el('span', 'files-num is-add');
  const sumDel = el('span', 'files-num is-del');
  const sumText = el('span', 'files-sum-text');
  summary.append(sumAdd, sumDel, sumText);

  const body = el('div', 'files-body');

  // The Commits tab's SELECTED state (a commit is open): a back control, the
  // message and the commit's meta line, above the per-file rows in the body.
  const selHd = el('div', 'files-selhd');
  selHd.hidden = true;

  // ---- the twin of the Explorer drag (A9) ----------------------------------
  // Its own hairline-free strip directly under the header, NOT a third control
  // squeezed into that 44px row: at 200px the header already holds two tabs and
  // the panel's only live datum (the project name), and a 110px button there
  // would ellipsise that name away. On its own line it also lines up with the
  // rows it copies into, and it stays put when the Commits tab hides the
  // summary row below it.
  const copyRow = el('div', 'files-copy');
  const copyBtn = button('files-copy-btn', COPY_LABEL, () => openCopyFilesPicker());
  copyBtn.setAttribute('data-k', 'fcopy');
  copyRow.append(copyBtn);

  root.append(hd, copyRow, summary, selHd, body);

  /**
   * The button's promise, kept live. Two halves since A9b:
   *
   *   - its VISIBLE label answers the selection (`Copy files here…` with
   *     nothing selected, `Copy files into src…` with a folder chosen), which
   *     is what makes the destination obvious without hovering anything;
   *   - its `title` keeps naming the folder `pasteDestination()` would really
   *     use, which also changes when a folder row takes the focus, when the
   *     panel changes subject, and when the focus leaves the panel again.
   *
   * `focusin` is listened for on the DOCUMENT because focus moving OUT of the
   * panel is not an event the panel itself ever sees.
   */
  function syncCopyStrip(): void {
    // The ANCHOR's folder, named — never a count: the strip is about WHERE
    // files land, and how many rows are chosen says nothing about that.
    copyBtn.textContent = copyStripLabel(destinationPath(selected));
    const dest = pasteDestination();
    copyBtn.title = dest === null ? '' : copyIntoText(dest.name);
  }
  document.addEventListener('focusin', (e) => {
    noteFocus(e.target);
    syncCopyStrip();
  });
  // The destination questions the drop layer asks are answered against THIS
  // panel (there is one), through the same `subject()` the header prints — set
  // before the first title, so the button never starts out naming the fallback.
  setLive({
    subject,
    rootDestination: ctx.rootDestination,
    selectedFolder: ctx.currentSelectedDest,
    homePath: () => ctx.homePath,
    entries: (path: string) => fs.entries(path),
    refreshIfListed: ctx.refreshIfListed,
  });
  syncCopyStrip();

  // ---- the drag edge --------------------------------------------------------
  const grip = el('div', 'files-grip');
  grip.tabIndex = 0;
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'vertical');
  grip.setAttribute('aria-label', 'files panel width');
  grip.setAttribute('aria-valuemin', String(st.FILES_W_MIN));
  grip.setAttribute('aria-valuemax', String(st.FILES_W_MAX));
  grip.title = 'Drag to resize. Arrow keys nudge it, home, enter or double-click resets it.';
  root.append(grip);

  host.append(root);

  function applyWidth(px: number): void {
    host.style.width = `${px}px`;
    grip.setAttribute('aria-valuenow', String(px));
  }
  applyWidth(st.state.filesWidth);

  // Pointer drag: capture on the grip so the pointer may leave the 6px strip,
  // and a body class kills text selection for the duration (dragging over a
  // tree otherwise paints half of it blue).
  let dragFrom = 0;
  let dragWidth = 0;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('is-dragging');
    document.body.classList.add('is-resizing-col');
    dragFrom = e.clientX;
    dragWidth = st.state.filesWidth;
  });
  grip.addEventListener('pointermove', (e) => {
    if (!grip.hasPointerCapture(e.pointerId)) return;
    // Live: width + state only, no notify — the ResizeObservers in the panes
    // do the rest, and a notify per move would rebuild chrome at 60Hz.
    applyWidth(st.setFilesWidth(dragWidth + e.clientX - dragFrom, false));
  });
  const endDrag = (e: PointerEvent): void => {
    if (!grip.hasPointerCapture(e.pointerId)) return;
    grip.releasePointerCapture(e.pointerId);
    grip.classList.remove('is-dragging');
    document.body.classList.remove('is-resizing-col');
    applyWidth(st.setFilesWidth(st.state.filesWidth, true));
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);
  grip.addEventListener('keydown', (e) => {
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = st.state.filesWidth - NUDGE_PX;
    else if (e.key === 'ArrowRight') next = st.state.filesWidth + NUDGE_PX;
    // Home and Enter both reset, and the title names both — the same contract
    // the pane dividers already promise (ui/panes.ts).
    else if (e.key === 'Home' || e.key === 'Enter') next = st.FILES_W_DEFAULT;
    if (next === null) return;
    e.preventDefault();
    applyWidth(st.setFilesWidth(next, true));
  });
  grip.addEventListener('dblclick', () => {
    applyWidth(st.setFilesWidth(st.FILES_W_DEFAULT, true));
  });

  // ---- what the header says -------------------------------------------------

  /**
   * What the panel is about, as ONE lookup. Three readers hang off it: the
   * header (`headerName`), the Commits tab's availability (`repoKnown`) and —
   * since A10 — the ROOT a clicked file opens into (`rootForSubject`), so the
   * name in the header and the tab the file lands in can never disagree.
   *
   * Order:
   *   1. the focused pane is a FILE or a DIFF -> its TAB's folder. Without this
   *      the header would flip to an unrelated project the moment the user
   *      focuses the file they just opened (the tab's own session, if any, is
   *      not what that pane is about). A ROOTLESS tab (a file dropped on a
   *      terminal pane's edge) has no folder, so it is about its OWN first
   *      session — never about a session in some other tab — and `Home` when
   *      it holds none.
   *   2. the focused pane is a live session -> its project NAME (never a path);
   *      a session without a project has nothing else honest to show, so its
   *      own name stands in — and its folder is that session's own working
   *      directory (B2 closes the A10 gap: the tree lists the folder the
   *      session is running in, and the header says the session's name for it).
   *   3. NOTHING FOCUSED -> `Home`. Full stop (user decision 2026-09-16, §4a).
   *      Until B2 the last rung was "the first live session anywhere", which
   *      was harmless while the panel drew a mock: it only chose a NAME. Now
   *      it would choose a FOLDER, and a Home tab with a session running in
   *      another tab would list that session's project — a tree about
   *      something the user is not looking at. A session's project appears
   *      when one of its panes is focused, which is exactly when it is what
   *      the screen is about.
   *
   * Since B2 it also answers the PATH that name stands for (§4a), because the
   * header and the tree must be two views of one folder and not two lookups
   * that happen to agree. `Home`'s path is the one the first listing taught us,
   * so it is null for as long as that answer is in flight.
   */
  function subject(): Subject {
    const v = st.activeView();
    const slot = v === null ? undefined : v.slots[v.focused];
    if (v !== null && slot !== undefined && slot.kind !== 'session' && v.root !== null) {
      if (v.root.kind === 'home') return atHome();
      const p = projectDest(v.root.id);
      // A project deleted under an open folder tab has no name left to print;
      // fall through to the session rules rather than invent one.
      if (p !== null) return { name: p.name, home: false, projectId: v.root.id, path: p.path };
    }
    if (v !== null && slot !== undefined && slot.kind !== 'session' && v.root === null) {
      // A file or diff pane in a plain session tab: no folder to follow, so
      // the tab's OWN first session answers for it. The global fallback below
      // would name a session from an unrelated tab, and send the next file to
      // that project's folder.
      const own = st.sessionIds(v)[0];
      const info = own === undefined ? undefined : st.state.sessions.get(own);
      if (info !== undefined) return ofSession(info);
      return atHome();
    }
    const id = slot !== undefined && slot.kind === 'session' ? slot.id : undefined;
    const info = id === undefined ? undefined : st.state.sessions.get(id);
    if (info !== undefined && info.status !== 'exited') return ofSession(info);
    // Nothing focused — an empty tab, the fixed `Home` tab, or a focused pane
    // whose session has exited (state.ts markExited flips it in place and
    // reconcileViews keeps the dead pane on purpose). All three are the same
    // answer since B2: HOME. The panel lists a folder now, and borrowing a
    // session from another tab to pick one would put a tree on screen about
    // something nobody is looking at.
    return atHome();
  }

  /** The home folder as a subject: the one name whose path had to be learned. */
  function atHome(): Subject {
    return { name: 'Home', home: true, projectId: null, path: ctx.homePath };
  }

  /**
   * A session as a subject. `projectId` is only carried when the project is
   * really there: a name the panel cannot print is not a folder a file can be
   * opened into either. Its PATH is the project's, else the session's own
   * working directory — which is a real folder the app already knows and
   * already names this way in HISTORY.
   */
  function ofSession(info: SessionInfo): Subject {
    const p = projectDest(info.projectId);
    if (p !== null) {
      return { name: p.name, home: false, projectId: info.projectId ?? null, path: p.path };
    }
    return {
      name: info.title,
      home: false,
      projectId: null,
      path: info.cwd === '' ? ctx.homePath : info.cwd,
    };
  }

  /** The tab a file clicked in this panel belongs to (pure rule, slots-model). */
  function currentRoot(): st.ViewRoot {
    const s = subject();
    return rootForSubject({ home: s.home, projectId: s.projectId });
  }

  /**
   * Is this file on screen anywhere? ANY view, not just the active one: the
   * class is a statement about the FILE ("you are looking at this"), and a file
   * open in another folder tab is still open.
   *
   * A10b: it walks the TABS of every pane. A file is not a pane any more — it
   * is one chip in an editor pane's strip — and `slotKey` answers that pane's
   * own `e:<n>`, which no path can ever equal. (That is exactly what this line
   * asked before, and it had gone silently dead: `editorFileId` is the TAB id,
   * never a slot key.)
   */
  function pathIsOpen(path: string): boolean {
    const id = st.editorFileId(path);
    return st.state.views.some((v) => v.slots.some((slot) => st.slotTabIds(slot).includes(id)));
  }

  /**
   * ctrl+alt+enter — the keyboard twin of dragging a row onto a pane EDGE:
   * open the file in a split beside the focused pane. An empty tab has no pane
   * to split, so the file simply lands in it; a pane with no side free says so
   * through the one shared refusal mapping (ui/dnd.ts), so the chord and the
   * drag can never explain the same refusal differently.
   */
  function openBeside(path: string, name: string): void {
    const v = st.activeView();
    if (v === null || v.slots.length === 0) {
      // An empty tab: the file lands IN it, as its first pane. Guarded like
      // every other open, though a tab with no pane has no strip to overflow.
      openFileGuarded(currentRoot(), path, name, { done: flashOpenResult });
      return;
    }
    const where = st.dropZonesFor(v, v.focused, 1)[0];
    if (where === undefined) {
      flashOpenResult(v.slots.length >= st.MAX_PANES ? 'full' : 'no-zone');
      return;
    }
    // `dropZonesFor` only ever answers EDGES here, so this makes a new pane
    // and cannot evict — the guard is on it anyway, so no second rule about
    // which opener needs it can drift into this file.
    openTabAtGuarded(v.id, v.focused, where, { kind: 'file', path }, { done: flashOpenResult });
  }

  function headerName(): string {
    return subject().name;
  }

  function setTab(next: Tab): void {
    // The WISH is what a press changes — pressing `Files` while the panel was
    // bounced there is not a no-op: it says "I want Files", and the wished tab
    // stops coming back when its repository does.
    if (wish === next) return;
    // Defence in depth for the two disabled tabs: the buttons carry
    // `disabled`, so a browser fires no click on them, but a tab must be
    // unreachable by construction and not by the DOM's good manners.
    if (!ctx.tabAvailable(next)) return;
    // The name row is drawn by the Files tab and by nothing else, so leaving
    // that tab is leaving it (§6b).
    ctx.dropNaming('tab');
    wish = next;
    tab = ctx.visibleTab();
    // Opening a watching tab re-asks straight away — the answer behind it may
    // be five seconds old, and this is the gesture that says "show me now".
    if (next === 'changes' && ctx.currentPath !== null) ctx.fetchChanges(ctx.currentPath);
    if (next === 'commits' && ctx.currentPath !== null) ctx.fetchCommits(ctx.currentPath, 0);
    ctx.lastSig = '';
    ctx.render();
    ctx.syncPoll();
  }

  return { render: ctx.render };
}
