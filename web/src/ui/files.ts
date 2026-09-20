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
 * WHAT IS REAL AND WHAT IS NOT (part B2). The `Files` tab is a real browser of
 * a real folder and the `Changes` tab is the real `git` answer for the
 * repository behind it; both arrive through an INJECTED `FsGateway`, never
 * through an import of `../api.ts`, so this module stays drivable under
 * `node --test` with a plain fake object. Only `Commits` is still
 * `ui/files-mock.ts` (part B3) and it is the one surface left carrying the
 * quiet "Example data until …" line. File CONTENT is part B4: a file row
 * opens a pane, and that pane says it cannot read the file yet.
 *
 * HOW THE TREE LOADS (PLAN-B2 §3). Lazy per folder on expand,
 * cache-then-revalidate (a folder that already answered never flashes
 * `Loading…` again), one request per path at a time, and a GENERATION counter
 * so a slow listing of the folder we just left can never paint over the one we
 * are in. No poll and no watcher: a listing is re-read when the user expands,
 * creates or refreshes. The `Changes` tab is the exception and polls every
 * `CHANGES_POLL_MS` — but only while it is the visible tab AND the panel is on
 * screen, because that tab exists to watch a session change files.
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
 */
import * as st from '../state.ts';
import { el, button } from './util.ts';
import { armDrag, flashOpenResult } from './dnd.ts';
import { openCopyFilesPicker, type PaneDest } from './filedrop.ts';
import {
  afterEscape,
  afterMenuOpen,
  afterPanelHidden,
  afterRange,
  afterRowActivate,
  afterSelectAll,
  afterToggle,
  COPY_LABEL,
  copyIntoText,
  copyStripLabel,
  destinationPath,
  EMPTY,
  keyIsDir,
  keyPath,
  prunedTo,
  rowKey,
  size as selectionSize,
  without,
  type Selection,
} from './files-select-model.ts';
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
import {
  itemsFor,
  itemsForRoot,
  menuLabel,
  rootMenuLabel,
  type MenuAction,
} from './context-menu-model.ts';
import { closeRowMenu, openRowMenu } from './context-menu.ts';
import { copyPathsToClipboard, hasHostBridge } from './host-bridge.ts';
import { flash } from './statusline.ts';
import { isContextMenuChord, isEditableTarget, OPEN_MODAL_SELECTOR } from './keys.ts';
import { fileName, rootForSubject } from './slots-model.ts';
import { caretLeftIcon, folderIcon } from './icons.ts';
import { MAX_DELETE_ITEMS } from '../../../shared/protocol.ts';
import type {
  FsCreateResponse,
  FsDeleteResponse,
  FsDeleteResult,
  FsEntriesResponse,
  FsWinPathResponse,
  GitChangesResponse,
  SessionInfo,
} from '../../../shared/protocol.ts';
import type { CommitEntry } from './files-model.ts';
import {
  badgeFor,
  buildTree,
  commitsHeaderText,
  diffSummary,
  rowIndent,
  summaryText,
  treeRows,
} from './files-model.ts';
import {
  LOADING_TEXT,
  NO_CHANGES_TEXT,
  changesToFiles,
  createRowIndex,
  destinationOf,
  fsRows,
  isUnder,
  joinPath,
  nameProblem,
  parentPath,
  nameProblemText,
  truncatedText,
  type Destination,
  type FolderState,
  type FsRow,
} from './fs-model.ts';
import { blockDomId, filesChangedText } from './commit-model.ts';
import { MOCK_BRANCH, MOCK_COMMITS, mockCommitByHash } from './files-mock.ts';

type Tab = 'files' | 'changes' | 'commits';

/** Arrow-key step for the width, in px — the keyboard twin of the edge drag. */
const NUDGE_PX = 16;

/**
 * How often the `Changes` tab re-asks git, while it is the VISIBLE tab and the
 * panel is on screen (PLAN-B2 §7). The one poll part B2 adds: that tab exists
 * to watch a session change files, so a listing one gesture old — which is
 * right for the tree — would be the wrong promise here. Every other second is
 * slower than a human reads a diff and cheap beside the caps the backend puts
 * on the git call itself.
 */
const CHANGES_POLL_MS = 5000;

/**
 * Why `Changes` and `Commits` are unavailable here: the folder the panel is
 * standing in is not inside a git repository (or has not answered yet). Since
 * B2 this is a REAL probe (`GitChangesResponse.isRepo`), not A11's "the header
 * reads Home" stopgap, so a home folder that IS a repository offers both tabs
 * and a project registered outside one offers neither. A fragment, because it
 * is a tooltip on a control, not a sentence about the app.
 */
function noRepoTitle(name: string): string {
  return `No repository at ${name}`;
}

/**
 * What a folder row says when the answer never arrived at all (a dead backend,
 * a dropped connection). Every other failure renders the SERVER's own sentence
 * verbatim (PLAN-B2 §1d) — the picker's rule: honest states only, the
 * backend's own reason inline — and this is the one case where there is no
 * server sentence to render, so the panel says what it knows in its own voice.
 */
const UNREACHABLE_TEXT = 'The app could not reach the service.';

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

/**
 * A CHANGED file row's title (the `Changes` tab). It names one thing because
 * the row does one thing: its path belongs to the repository, not to the
 * folder the panel lists, so it is no drag source, answers no chord and opens
 * no menu.
 */
const CHANGED_ROW_TITLE = 'Open in a pane.';

/**
 * What `Copy` says when nothing reached the clipboard (B10). ONE sentence for
 * every cause: a refusal from the boundary, a path with no Windows form, a
 * host that did not answer, a clipboard another program is holding. Naming
 * which one would name a path or a rule the user cannot see, and the next
 * move — try again, or copy it from a terminal — is the same for all of them.
 */
const COPY_TO_CLIPBOARD_FAILED = 'The app could not copy that to the clipboard.';

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
}

/**
 * WHERE THE DESTINATION NAMES COME FROM (part A9). Four questions — what is
 * this panel about, what is that folder row called, what is a pane's folder,
 * what would a paste use — are answered HERE, by the one `subject()` the
 * header already prints, and handed to `ui/filedrop.ts` as injected deps. Two
 * modules answering them separately is how a ghost ends up promising `Home`
 * over a pane that belongs to a project.
 *
 * The panel is a singleton in the shell; this is the same idiom `ui/picker.ts`
 * uses for the one open folder picker.
 */
let live: {
  subject(): Subject;
  rootDestination(): Destination | null;
  selectedFolder(): Destination | null;
  homePath(): string | null;
  entries(path: string): Promise<FsEntriesResponse>;
  refreshIfListed(path: string): void;
} | null = null;

/**
 * What the panel is about: a NAME, whether it is `Home`, the project behind
 * it, and — since B2 — the real PATH that name stands for. One walk answers
 * all four (`subject()` below), which is what makes the header, the tree, the
 * drop destinations and the tab a file opens into agree by construction.
 */
interface Subject {
  name: string;
  home: boolean;
  projectId: string | null;
  /** Absolute path, or null while the home folder has not been learned yet. */
  path: string | null;
}

// ---- destinations ---------------------------------------------------------
//
// Four questions — what is this panel about, what is that folder row called,
// what is a pane's folder, what would a paste use — answered HERE, by the one
// `subject()` the header already prints, and handed to `ui/filedrop.ts` as
// injected deps. Since B2 each answer is a `Destination`: the NAME the UI is
// allowed to show and the real PATH the upload posts to (part B10). Not one
// visible string changes — every renderer reads `.name`.

/** The panel's own root — its non-folder area. Null with no panel on screen. */
export function filesPanelDestination(): Destination | null {
  return live === null ? null : live.rootDestination();
}

/**
 * Where a paste — and the copy strip's button — would copy to: the SELECTED
 * folder (A9b), else the folder row the keyboard last stood on inside the
 * panel (the button that asks this took the focus off it), else the panel's
 * own root, else the active tab's root (the panel can be closed while a drop
 * still has to go somewhere).
 */
export function pasteDestination(): Destination | null {
  if (live !== null) {
    // A9b, first rung: the SELECTED folder. It is the only one of the two that
    // says out loud where files will land (the copy strip names it), so it
    // wins over the focus memory always — including a paste arriving from a
    // focused terminal, which has no focus memory of its own.
    const chosen = live.selectedFolder();
    if (chosen !== null) return chosen;
    const folder = focusedFolderDest();
    if (folder !== null) return folder;
    const root = live.rootDestination();
    if (root !== null) return root;
  }
  return destinationOfActiveView();
}

/**
 * The SELECTED folder, as a NAME (never a path), or null when nothing is
 * selected, when the selected path has no last segment to speak about, or
 * when there is no panel on screen to have a selection at all.
 *
 * `ui/filedrop.ts` reads it for one question only: may a `paste` be taken
 * away from a focused terminal or a focused field (`takesPaste`)? Which is
 * exactly why a HIDDEN panel answers null — a destination nobody can see must
 * never silently accept files.
 */
export function selectedFolder(): Destination | null {
  return live === null ? null : live.selectedFolder();
}

/** The ACTIVE tab's root: `Home`, a project, else null. */
export function destinationOfActiveView(): Destination | null {
  return rootDest(st.activeView());
}

/**
 * A pane's destination, in the SAME order the panel header (`subject()`)
 * answers in — one screen, one name. A SESSION pane is about its session, so
 * its project comes first and the tab's folder is only the fallback; anything
 * else in the pane area (a file, a diff, an empty slot) is about its TAB, so
 * the tab's folder comes first and the tab's own first session is the
 * fallback. Answering the tab's folder first for a session pane made the
 * header read `api` while the ghost over that very pane said `Home`.
 *
 * A session with neither a project, nor a rooted tab, nor even a working
 * directory has no folder this app can name at all, so it answers nothing plus
 * the REASON and the drop layer turns that into the sentence it flashes. Its
 * WORKING DIRECTORY is the new last rung (B2, §4b): HISTORY already groups
 * such a session under that folder's last segment, so the app is not inventing
 * a name here, it is finally able to say the one it already uses.
 */
export function destinationOfPane(paneEl: HTMLElement): PaneDest {
  const v = st.activeView();
  if (v === null) return { dest: null, why: 'tab' };
  const root = rootDest(v);
  const slot = v.slots[Number(paneEl.dataset.slot)];
  if (slot === undefined) return root === null ? { dest: null, why: 'tab' } : { dest: root };
  if (slot.kind === 'session') {
    const own = projectOf(slot.id);
    if (own !== null) return { dest: own };
    if (root !== null) return { dest: root };
    const cwd = cwdOf(slot.id);
    if (cwd !== null) return { dest: cwd };
    return { dest: null, why: 'session' };
  }
  if (root !== null) return { dest: root };
  // A file or a diff in a plain session tab: no folder to follow, so the
  // tab's OWN first session answers for it, exactly as `subject()` does for
  // the header above it. Nothing there to borrow from is a TAB without a
  // folder, not a session without a project.
  const first = st.sessionIds(v)[0];
  const dest = first === undefined ? null : projectOf(first);
  return dest === null ? { dest: null, why: 'tab' } : { dest };
}

/**
 * A session's project as a destination, or null when it has none left to name.
 * An EXITED session answers nothing here, exactly as `subject()` skips it for
 * the header: the pane and the header must never name two folders.
 */
function projectOf(id: string): Destination | null {
  const info = st.state.sessions.get(id);
  if (info === undefined || info.status === 'exited') return null;
  return projectDest(info.projectId);
}

/**
 * A session's own working directory, named by its LAST SEGMENT. Only ever
 * reached for a live session with no project and no rooted tab; an exited one
 * answers nothing, for the same reason its project does not.
 */
function cwdOf(id: string): Destination | null {
  const info = st.state.sessions.get(id);
  if (info === undefined || info.status === 'exited') return null;
  const cwd = info.cwd;
  if (cwd === '') return null;
  const name = fileName(cwd);
  return name === '' ? null : { path: cwd, name };
}

/** A registered project as a destination. A project deleted under a tab has none. */
function projectDest(id: string | undefined): Destination | null {
  if (id === undefined) return null;
  const p = st.state.projects.find((x) => x.id === id);
  if (p === undefined || p.name === '' || p.path === '') return null;
  return { path: p.path, name: p.name };
}

/** A view's root as a destination. `Home` needs the home path to be known. */
function rootDest(v: st.ViewState | null): Destination | null {
  if (v === null || v.root === null) return null;
  if (v.root.kind === 'home') {
    const home = live === null ? null : live.homePath();
    return home === null ? null : { path: home, name: 'Home' };
  }
  return projectDest(v.root.id);
}

/**
 * The TOP-LEVEL names already in a destination — the only input the conflict
 * question takes — read from the REAL folder at drop time (§4b).
 *
 * It deliberately does NOT read the panel's cache: the destination is usually
 * a folder nobody expanded, and a conflict answer from a stale listing is the
 * one place a stale listing IS a lie, because it decides whether a file is
 * overwritten. A listing that FAILS answers an empty list rather than throwing:
 * a drop must not be lost because a folder could not be read, and "no known
 * conflicts" is the non-destructive reading of not knowing.
 */
export async function listingFor(dest: Destination): Promise<readonly string[]> {
  if (live === null) return [];
  try {
    const res = await live.entries(dest.path);
    return res.entries.map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * A drop is over (B10): show what landed. It re-reads the destination only
 * when the panel already has a listing for it, so a copy into a folder nobody
 * opened costs nothing, and it is called ONCE — per file would paint a folder
 * filling up and would make every `.part` file in flight briefly visible.
 *
 * The `Changes` tab needs no help: its own 5 s poll picks the new files up.
 */
export function refreshAfterDrop(dest: Destination): void {
  live?.refreshIfListed(dest.path);
}

/**
 * `onLeaveScreen` hands the keyboard back to the focused terminal after the
 * panel closed a surface the user was standing in (the commit view's
 * `All commits`). It is INJECTED rather than imported for the same reason
 * ui/panes.ts takes its launch opener that way — and here it also keeps this
 * module free of `ui/panes.ts`, whose import graph reaches @xterm/xterm, so
 * the panel stays drivable under `node --test`.
 */
export function initFilesPanel(
  host: HTMLElement,
  onLeaveScreen: () => void,
  fs: FsGateway,
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

  /**
   * The sentence a failed request puts in the row.
   *
   * An `ApiError` carries the SERVER's own constant sentence (§1d) and a
   * `status`, which is how this tells it apart from a fetch that never reached
   * anything — duck-typed rather than `instanceof`, because importing
   * `../api.ts` here is exactly what the injected gateway exists to avoid.
   *
   * AND THE SHAPE IS CHECKED, not only the origin. `request()` invents
   * `HTTP <status>` when a body carries no `error` at all, and an older
   * backend answers its own vocabulary (`not found`, `permission denied` —
   * the picker's words, lowercase fragments meant for a different surface).
   * Either would land in a tree row as a sentence the app never wrote. So a
   * message is rendered only if it LOOKS like §1d: one line, an uppercase
   * start, a full stop, and no `HTTP` in it. Everything else is the app's own
   * "we did not get an answer", which is the truth in every one of those
   * cases.
   */
  function messageOf(err: unknown): string {
    if (err !== null && typeof err === 'object') {
      const e = err as { status?: unknown; message?: unknown };
      if (typeof e.status === 'number' && typeof e.message === 'string' && isSentence(e.message)) {
        return e.message;
      }
    }
    return UNREACHABLE_TEXT;
  }

  /** Does this read like one of the server's own constant sentences (§1d)? */
  function isSentence(text: string): boolean {
    if (text.length < 2 || text.length > 160) return false;
    if (/[\n\r\t]/.test(text)) return false;
    if (text.includes('HTTP')) return false;
    if (!text.endsWith('.')) return false;
    const first = text[0] as string;
    return first === first.toUpperCase() && first !== first.toLowerCase();
  }

  /** An answer changed something: repaint, whatever the signature said before. */
  function bump(): void {
    dataVersion += 1;
    lastSig = '';
    render();
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
    fs.entries(path)
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
    if (openFolders.has(path)) openFolders.delete(path);
    else {
      openFolders.add(path);
      fetchFolder(path);
    }
    lastSig = '';
    render();
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
    return subject().path;
  }

  /** The panel's own root as a destination — the name the header prints, its path. */
  function rootDestination(): Destination | null {
    const path = rootPath();
    if (path === null) return null;
    return { path, name: subject().name };
  }

  /** The one request that has no path: it teaches the app where home is. */
  function learnHome(): void {
    if (homeAsked) return;
    homeAsked = true;
    fs.entries()
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
    for (const p of [...openFolders]) if (!isUnder(p, next)) openFolders.delete(p);
    for (const p of [...listings.keys()]) if (!isUnder(p, next)) listings.delete(p);
    selected = prunedTo(selected, next);
    // A9c: a name row belongs to ONE folder in ONE tree. The root moved under
    // it, so there is nothing left for it to be inside of (§6b).
    dropCreate('root');
    changes = null;
    changesError = null;
    changesRoot = null;
    dataVersion += 1;
    fetchFolder(next);
    fetchChanges(next);
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

  // ---- changes -------------------------------------------------------------
  //
  // The `Changes` tab (§7): `git diff --numstat` plus the untracked set, for
  // the REPOSITORY the root sits in — which may be an ancestor of the root
  // (a project registered at `web/` inside a repository), so the tab's own
  // line names that repository rather than pretending the two are the same
  // folder.
  //
  // It is also the PROBE. `isRepo` decides whether `Changes` and `Commits`
  // exist at all, so one request goes out per root whatever tab is up; the 5 s
  // poll is armed only while this tab is the visible one.

  /** The last answer for the current root, or null while none has arrived. */
  let changes: GitChangesResponse | null = null;
  /** The sentence the last attempt failed with, or null. */
  let changesError: string | null = null;
  /** The root that answer belongs to (never rendered — a path is not a label). */
  let changesRoot: string | null = null;
  /** The generation whose changes request is in flight, or null. */
  let changesFlight: number | null = null;
  /** The Changes tree's OWN open set: repo-relative paths, not the Files tab's. */
  const changesOpen = new Set<string>();
  /** The poll, armed only while this tab is visible. */
  let pollId: number | null = null;

  function fetchChanges(root: string): void {
    // Dedupe WITHIN a generation — a poll tick over a slow git call is
    // skipped — but never across one: a root change must always get its own
    // answer, or the tab that asks "is this a repository" is never told.
    const gen = generation;
    if (changesFlight === gen) return;
    changesFlight = gen;
    fs.changes(root)
      .then((res) => {
        if (gen !== generation) return;
        changes = res;
        changesError = null;
        changesRoot = root;
      })
      .catch((err: unknown) => {
        if (gen !== generation) return;
        changes = null;
        changesError = messageOf(err);
        changesRoot = root;
      })
      .finally(() => {
        if (changesFlight === gen) changesFlight = null;
        if (gen !== generation) return;
        bump();
      });
  }

  /**
   * Arm or drop the poll. The timer exists only while the Changes tab is the
   * visible tab AND the panel is on screen, so a hidden panel and every other
   * tab cost nothing at all; a tick while a request is still in flight is
   * skipped by `fetchChanges` itself.
   */
  function syncPoll(): void {
    const want = st.filesPanelVisible() && tab === 'changes' && currentPath !== null;
    if (want && pollId === null) {
      pollId = window.setInterval(() => {
        if (currentPath !== null) fetchChanges(currentPath);
      }, CHANGES_POLL_MS);
      return;
    }
    if (!want && pollId !== null) {
      window.clearInterval(pollId);
      pollId = null;
    }
  }

  /**
   * Is there a repository behind this panel? The REAL probe since B2: the last
   * git answer for this root — `true`, `false`, or NULL while no answer for
   * this root has arrived. The third value is the whole point (see `tab` /
   * `wish` above): the two are not the same fact.
   */
  function isRepo(): boolean | null {
    return changes === null ? null : changes.isRepo;
  }

  /**
   * Is there a repository, as far as anyone can say right now? Unknown reads
   * as no HERE, because this answers whether a tab can be CHOSEN, and a tab
   * that leads to `Loading…` is not a choice yet. While it is unknown the two
   * tabs stay disabled with the same title they carry when the answer is "no"
   * — a third, transient tooltip for the second it takes to ask would be noise.
   */
  function repoKnown(): boolean {
    return isRepo() === true;
  }

  /** Is this tab reachable at all? `Files` always; the other two need a repository. */
  function tabAvailable(t: Tab): boolean {
    return t === 'files' || repoKnown();
  }

  /**
   * Which tab is ON SCREEN, given what the user wished for and what git has
   * said. The fallback to `Files` needs a DEFINITE `isRepo: false`: a root
   * change nulls the answer, and falling back on "not yet" would take the
   * Changes tab away from anyone moving between two repositories — the tab
   * they are watching, lost for the width of one git call.
   */
  function visibleTab(): Tab {
    if (wish === 'files') return 'files';
    return isRepo() === false ? 'files' : wish;
  }

  /**
   * The Changes tab's own header line: the REPOSITORY's name and the branch it
   * is on. The name, never the path — and it is said out loud precisely
   * because the repository can be an ancestor of the folder the Files tab
   * lists, which is the one place this panel would otherwise have two
   * different subjects on one screen. A detached head has no branch to name,
   * so the line is just the repository.
   */
  function changesHeaderText(): string {
    const root = changes === null ? null : changes.repoRoot;
    const repo = root === null ? '' : fileName(root);
    const branch = changes === null ? null : changes.branch;
    if (repo === '') return branch ?? '';
    return branch === null ? repo : `${repo}, ${branch}`;
  }

  /**
   * The Changes tab's body: the same `buildTree` + `treeRows` renderer the A5
   * tree has always used, over `changesToFiles()` — one tree vocabulary in
   * this panel, not two. Rows carry their own `gdir:`/`gfile:` keys — `g` for
   * git, and deliberately NOT `c…`, which the Commits tab already spends on
   * its per-file rows: `rebuild()` restores the keyboard by `data-k`, so two
   * tabs sharing a key would land the focus on the other tab's row. The drop
   * layer (which resolves a folder row by its `fdir:` path) can never mistake
   * a repo-relative path for a real one either.
   */
  function changeRows(): HTMLElement[] {
    if (changesError !== null) return [stateRow(changesError, rowIndent(0), true)];
    if (changes === null) return [stateRow(LOADING_TEXT, rowIndent(0), false)];
    if (!changes.isRepo) return [];
    const out: HTMLElement[] = [el('div', 'files-branch', changesHeaderText())];
    if (changes.files.length === 0) {
      out.push(stateRow(NO_CHANGES_TEXT, rowIndent(0), false));
      return out;
    }
    const repoRoot = changes.repoRoot;
    for (const r of treeRows(buildTree(changesToFiles(changes.files)), changesOpen)) {
      let row: HTMLElement;
      if (r.dir) {
        const b = button('files-row is-dir', '', () => {
          if (changesOpen.has(r.path)) changesOpen.delete(r.path);
          else changesOpen.add(r.path);
          lastSig = '';
          render();
        });
        b.setAttribute('data-k', `gdir:${r.path}`);
        b.setAttribute('aria-expanded', r.open ? 'true' : 'false');
        row = b;
      } else {
        // A changed file opens exactly like a file in the tree beside it: the
        // path is repo-relative, so it is made absolute against the repository
        // it belongs to and never against the panel's own root.
        const b = button('files-row is-file', '', () => {
          if (repoRoot === null) return;
          st.openFile(currentRoot(), joinPath(repoRoot, r.path), r.name);
        });
        b.setAttribute('data-k', `gfile:${r.path}`);
        // Its OWN title, naming only what it does. A changed file row is not a
        // drag source, has no ctrl+alt+enter and opens no menu (its path is
        // repo-relative — nothing in the drop layer or the row menu can act on
        // it), so promising the tree row's three affordances would be three
        // lies on one control.
        b.title = CHANGED_ROW_TITLE;
        row = b;
      }
      row.style.paddingLeft = `${r.indent}px`;
      row.classList.toggle('is-busy', r.busy);

      const caret = el('span', 'files-caret', r.caret);
      caret.setAttribute('aria-hidden', 'true');
      row.append(caret);

      if (r.dir) {
        const ic = folderIcon();
        ic.classList.add('files-folder');
        if (r.open) ic.classList.add('is-open');
        row.append(ic);
      } else {
        const badge = el('span', 'files-badge', badgeFor(r.name).label);
        badge.dataset.kind = badgeFor(r.name).kind;
        badge.setAttribute('aria-hidden', 'true');
        row.append(badge);
      }

      const name = el('span', 'files-name', r.name);
      if (!r.dir) name.classList.toggle('has-diff', r.hasDiff);
      row.append(name);

      if (r.hasDiff) {
        row.append(
          el('span', 'files-num is-add', `+${r.add}`),
          el('span', 'files-num is-del', `-${r.del}`),
        );
      }
      out.push(row);
    }
    if (changes.truncated > 0) {
      out.push(stateRow(truncatedText(changes.truncated), rowIndent(0), false));
    }
    return out;
  }


  const root = el('section', 'files-view');

  /**
   * Escape, spent on the selection BEFORE `main.ts`'s ladder can see it.
   *
   * Bubble phase on the panel root, exactly like the row chords above it
   * (ctrl+alt+enter, ctrl+alt+c): a surface-local state is the surface's own
   * business, and the ladder — whose Files arm closes the whole panel — stays
   * untouched. With nothing selected this does NOT stop the key, so the next
   * Escape closes the panel as it always did.
   */
  root.addEventListener('keydown', (e) => {
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
      if (!openRootMenuAt(pointOf(t))) return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Escape') {
      // Nothing chosen: the key is NOT spent here, so the ladder's Files arm
      // closes the panel exactly as it always did.
      if (selectionSize(selected) === 0) return;
      e.preventDefault();
      e.stopPropagation();
      selected = afterEscape(selected);
      lastSig = '';
      render();
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
    if (tab !== 'files') return false;
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
      runDelete(activeTreeKey(), activeRowEl());
      return true;
    }
    if ((e.key === 'a' || e.key === 'A') && e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      // Every VISIBLE row — the only reading of "all" the user can see.
      selected = afterSelectAll(selected, visibleKeys());
      lastSig = '';
      render();
      return true;
    }
    if ((e.key === ' ' || e.key === 'Enter') && e.ctrlKey && !e.altKey && !e.shiftKey) {
      const key = activeTreeKey();
      if (key === null) return false;
      e.preventDefault();
      e.stopPropagation();
      selected = afterToggle(selected, key);
      lastSig = '';
      render();
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
      selected = afterRange(selected, next, keys);
      lastSig = '';
      render();
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
      selected = afterRange(selected, key, visibleKeys());
      lastSig = '';
      render();
      return;
    }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      selected = afterToggle(selected, key);
      lastSig = '';
      render();
      return;
    }
    selected = afterRowActivate(selected, key);
    activate();
    // A file row's `activate` opens a pane and repaints through state.ts; a
    // folder's `toggleFolder` renders itself. Neither knows about the
    // selection, so the repaint that PAINTS it is forced here.
    lastSig = '';
    render();
  }

  /** The tree's rows that are really on screen, in tree order (top to bottom). */
  function visibleKeys(): string[] {
    const out: string[] = [];
    for (const node of root.querySelectorAll<HTMLElement>('.files-body .files-row')) {
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
    root.querySelector<HTMLElement>(`[data-k="${CSS.escape(key)}"]`)?.focus();
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
    const dest = destinationPath(selected);
    if (dest === null || dest === '') return null;
    const root = rootPath();
    if (root === null) return null;
    // `destinationOf` is the one place a name is derived from a path, so the
    // panel asks it rather than deriving a second one here.
    return destinationOf(dest, root, subject().name);
  }

  // ---- the row menu ---------------------------------------------------------
  //
  // A right-click on a row, and its keyboard twin (part A9b, user decision 3).
  // The menu itself is `ui/context-menu.ts`; what lives here is WHICH gestures
  // open it, on which rows, and what each entry then does.
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
      if (!openRootMenuAt({ x: e.clientX, y: e.clientY })) return;
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
    dropCreate('menu');
    const before = selected;
    // Explorer's rule, in the model: a row ALREADY IN the selection leaves it
    // alone (right-clicking one of five chosen rows asks about all five); any
    // other row becomes the selection, and the anchor.
    selected = afterMenuOpen(selected, key);
    if (selected !== before) {
      // The selection alone changed — no folder toggled — so nothing else
      // would invalidate the signature and the chosen row would stay unpainted
      // while the copy strip already named it.
      lastSig = '';
      render();
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
      deletable: !isAnchor(path),
      count: actCount(key),
    };
    openRowMenu({
      items: itemsFor(subject),
      at,
      label: menuLabel(subject),
      returnFocus: row,
      onChoose: (action) => runMenuAction(action, key, path, name),
    });
  }

  /**
   * What each entry does — every one of them something the panel already does
   * by another gesture, so the menu can never become a second implementation
   * of anything. `Paste` stays inert and carries the model's `PASTE_NOTE`: a
   * page sees files only inside a real `paste` event, which is a keystroke,
   * and that route works today. `Copy` is live in the native window and
   * disabled with `COPY_NOTE` anywhere else.
   */
  function runMenuAction(action: MenuAction, key: string, path: string, name: string): void {
    if (action === 'toggle') toggleFolder(path);
    else if (action === 'open') st.openFile(currentRoot(), path, name);
    else if (action === 'open-beside') openBeside(path, name);
    // The two acts that are about the SELECTION when the row they were chosen
    // on is part of it (B10a) — the menu hands the row's key over and
    // `itemsFor` answers which rows the act really covers.
    else if (action === 'copy') copyToClipboard(key, name);
    else if (action === 'delete') runDelete(key, activeRowEl());
    else if (action === 'copy-files') openCopyFilesPicker({ path, name });
    // A9c: the three a FOLDER answers. `itemsFor` puts none of them on a file
    // row, so `path` is always a folder by the time they arrive here.
    else if (action === 'new-file') startCreate(path, 'file');
    else if (action === 'new-folder') startCreate(path, 'folder');
    else if (action === 'refresh') fetchFolder(path);
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
          const res = await fs.winPath(item.path);
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
      selection: [...selected.keys],
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
    for (const key of visibleKeys()) {
      seen.add(key);
      out.push({ key, item: itemOf(key) });
    }
    for (const key of selected.keys) {
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
    if (currentPath !== null && path === currentPath) return true;
    if (homePath !== null && path === homePath) return true;
    return st.state.projects.some((p) => p.path === path);
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
    if (tab !== 'files') return;
    if (isDropRunning()) {
      flash(COPY_RUNNING);
      return;
    }
    if (deleting !== null) {
      flash(DELETE_RUNNING);
      return;
    }
    const items = actItemsFor({
      clicked,
      selection: [...selected.keys],
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
    if (deleting !== null) return;
    deleting = new Set(items.map((i) => rowKey(i.path, i.dir)));
    lastSig = '';
    render();
    fs.delete(pathsOf(items))
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
    deleting = null;
    // The rows as they are RIGHT NOW: nothing is removed optimistically, so
    // this is still the tree the user was looking at when they confirmed, and
    // it is what "the row after the one that went" is measured in.
    const before = visibleKeys();
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
      for (const p of [...openFolders]) if (isUnder(p, item.path)) openFolders.delete(p);
      for (const p of [...listings.keys()]) if (isUnder(p, item.path)) listings.delete(p);
    }
    for (const parent of parentsOf(items)) refreshIfListed(parent);
    selected = without(selected, done);
    // WHERE THE KEYBOARD GOES when the row it is standing on is about to
    // disappear — the `focusCreated` promise, inverted. It is a promise rather
    // than a `focus()` because the row is still on screen at this moment: it
    // goes when the parent's new listing lands, one or more repaints later.
    focusAfterDelete = done.length === 0 ? null : { gone: new Set(done), candidates: survivors(before, new Set(done), items) };
    flash(deleteSaid(items, results, done.length));
    bump();
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
    if (tab !== 'files') return false;
    const dest = rootDestination();
    if (dest === null) return false;
    dropCreate('menu');
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
    else if (action === 'new-file') startCreate(dest.path, 'file');
    else if (action === 'new-folder') startCreate(dest.path, 'folder');
    else if (action === 'refresh') refreshRoot();
  }

  /** Where a keyboard-opened menu hangs from: the focused thing's leading edge and bottom. */
  function pointOf(t: Element | null): { x: number; y: number } {
    const r = (t ?? root).getBoundingClientRect();
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
      openRowMenuFor(key, { x: r.left, y: r.bottom });
    });
  }

  // ---- creating a file or a folder ------------------------------------------
  //
  // `New file` / `New folder`, from the row menu or the root menu (part A9c,
  // `.claude/PLAN-B2.md` §6b). One inline row in the tree, never a dialog.
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
    const rootP = currentPath;
    if (rootP === null) return;
    clearCreate();
    if (dir !== rootP && !openFolders.has(dir)) {
      openFolders.add(dir);
      fetchFolder(dir);
    }
    creating = { dir, kind, error: null };
    createReturn = activeKey();
    focusName = true;
    lastSig = '';
    render();
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
   * re-enter.
   */
  function dropCreate(why: 'menu' | 'tab' | 'root' | 'hidden'): void {
    if (creating === null) return;
    clearCreate();
    lastSig = '';
    if (why === 'menu') render();
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
    lastSig = '';
    render();
    // ONLY ESCAPE MOVES THE KEYBOARD. A blur is the browser ALREADY moving it
    // somewhere the user chose — a terminal, another window, the tab strip —
    // and focusing a Files row from inside that transfer is how a keystroke
    // meant for a PTY lands on a tree row instead.
    if (!giveKeyboardBack) return;
    const el =
      back === null ? null : root.querySelector<HTMLElement>(`[data-k="${CSS.escape(back)}"]`);
    (el ?? copyBtn).focus();
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
      lastSig = '';
      render();
      return;
    }
    createBusy = true;
    creating = { dir, kind, error: null };
    lastSig = '';
    render();
    const token = createToken;
    const gen = generation;
    fs.create(dir, name, kind)
      .then((res) => {
        // THE ROOT decides whether this answer concerns the panel at all: a
        // folder in a tree nobody is looking at is not re-read.
        if (gen !== generation) return;
        // THE TOKEN decides whether it is still the user's QUESTION. It is
        // not — they cancelled, or started another one — so none of the four
        // effects below fire. The folder is still re-read: the thing EXISTS
        // now, and a tree that kept pretending it did not would hand the next
        // attempt a refusal about a name nothing on screen explains.
        if (token !== createToken) {
          fetchFolder(dir);
          bump();
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
          selected = afterRowActivate(selected, rowKey(path, true));
          openFolders.add(path);
          fetchFolder(path);
        } else {
          st.openFile(currentRoot(), path, leaf);
        }
        // The keyboard follows the thing that was made — but its row does not
        // exist until the folder answers again, so this is a promise the next
        // rebuilds keep.
        focusCreated = { key: rowKey(path, kind === 'folder'), dir };
        fetchFolder(dir);
        bump();
      })
      .catch((err: unknown) => {
        if (token !== createToken || gen !== generation) return;
        createBusy = false;
        creating = { dir, kind, error: createMessage(err) };
        lastSig = '';
        render();
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
    const rootP = currentPath;
    if (rootP === null) return;
    for (const p of [...listings.keys()]) if (p !== rootP && isUnder(p, rootP)) listings.delete(p);
    fetchFolder(rootP);
    for (const p of openFolders) if (p !== rootP && isUnder(p, rootP)) fetchFolder(p);
    bump();
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
    if (path !== currentPath && !openFolders.has(path)) return;
    fetchFolder(path);
  }

  /**
   * The name row itself, spliced into the rows a render has already built
   * (§6b). `createRowIndex` decides where: right after the folder's own row,
   * or at the very top for the root — and -1 when that folder is not on screen
   * at all (a listing that changed under the menu, a folder that closed), in
   * which case the create is dropped rather than drawn somewhere arbitrary.
   *
   * It is a `<div>`, like every other row that is not a button, carrying the
   * caret's own spacer so the input starts where a name starts, the folder
   * mark or the neutral badge so the KIND is visible before a single letter is
   * typed, and the input itself. The refusal is a second row directly beneath
   * it, the same height, in the ink this app refuses in everywhere.
   */
  function insertNameRow(rows: HTMLElement[], model: readonly FsRow[], rootP: string): void {
    const c = creating;
    if (c === null) return;
    // THE FOLDER MUST STILL BE OPEN. `startCreate` opened it, and the primary
    // click on its row can close it again — a name row at the child indent
    // under a shut folder would name a place the tree is no longer showing. The
    // root is the exception: it has no row and no caret, so it is never shut.
    if (c.dir !== rootP && !openFolders.has(c.dir)) {
      clearCreate();
      return;
    }
    const at = createRowIndex(model, c.dir, rootP);
    if (at === -1) {
      clearCreate();
      return;
    }
    const depth = at === 0 ? 0 : (model[at - 1]?.depth ?? 0) + 1;
    const row = el('div', 'files-row is-new');
    row.style.paddingLeft = `${rowIndent(depth)}px`;
    // In flight: the same opacity pulse a busy row already wears, and NO
    // height change — a row that grew mid-request would move the tree under
    // the pointer.
    row.classList.toggle('is-busy', createBusy);
    const caret = el('span', 'files-caret', '');
    caret.setAttribute('aria-hidden', 'true');
    row.append(caret);
    if (c.kind === 'folder') {
      const ic = folderIcon();
      ic.classList.add('files-folder');
      row.append(ic);
    } else {
      // The plain badge: a file with no name yet has no type to claim.
      const badge = el('span', 'files-badge', '');
      badge.setAttribute('aria-hidden', 'true');
      row.append(badge);
    }
    const input = el('input', 'files-newname');
    input.type = 'text';
    // The field IS the label: there is no visible caption to point at, so the
    // accessible name says what is being named and what kind of thing it is.
    input.setAttribute('aria-label', c.kind === 'folder' ? 'new folder name' : 'new file name');
    // A file name is not prose: no squiggles, no capital first letter on a
    // phone keyboard, and no history dropdown over the tree.
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    input.autocomplete = 'off';
    input.value = createText;
    input.readOnly = createBusy;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        commitCreate();
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
      cancelCreate(true);
    });
    input.addEventListener('blur', () => {
      // A rebuild replaces this element; in a real browser that can fire a
      // blur for a node nobody left. Both guards answer the same question —
      // "is this still the input the user is standing in?"
      if (rebuilding || !input.isConnected) return;
      // `false`: the keyboard is already on its way somewhere the user picked.
      cancelCreate(false);
    });
    row.append(input);
    nameInput = input;
    const out: HTMLElement[] = [row];
    if (c.error !== null) {
      const err = el('div', 'files-row is-newerr');
      err.style.paddingLeft = `${rowIndent(depth)}px`;
      err.append(el('span', 'files-name', c.error));
      out.push(err);
    }
    rows.splice(at, 0, ...out);
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
  live = {
    subject,
    rootDestination,
    selectedFolder: currentSelectedDest,
    homePath: () => homePath,
    entries: (path: string) => fs.entries(path),
    refreshIfListed,
  };
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
    return { name: 'Home', home: true, projectId: null, path: homePath };
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
      path: info.cwd === '' ? homePath : info.cwd,
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
      flashOpenResult(st.openFile(currentRoot(), path, name));
      return;
    }
    const where = st.dropZonesFor(v, v.focused, 1)[0];
    if (where === undefined) {
      flashOpenResult(v.slots.length >= st.MAX_PANES ? 'full' : 'no-zone');
      return;
    }
    flashOpenResult(st.openTabAt(v.id, v.focused, where, { kind: 'file', path }));
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
    if (!tabAvailable(next)) return;
    // The name row is drawn by the Files tab and by nothing else, so leaving
    // that tab is leaving it (§6b).
    dropCreate('tab');
    wish = next;
    tab = visibleTab();
    // Opening `Changes` re-asks straight away — the answer behind it may be
    // five seconds old, and this is the gesture that says "show me now".
    if (next === 'changes' && currentPath !== null) fetchChanges(currentPath);
    lastSig = '';
    render();
    syncPoll();
  }

  // ---- rendering -------------------------------------------------------------

  let lastSig = '';

  function sig(): string {
    if (!st.filesPanelVisible()) return 'hidden';
    // The panel also reacts to what is on the other screens: an open commit
    // turns the Commits tab into its selected state (with the same collapse set
    // the view uses), and the open files ground their rows.
    const collapsed = Array.from(st.state.commitCollapsed).sort().join(',');
    // Every file that is a TAB somewhere keeps its row grounded (A10b: the
    // question moved from the pane's key to the strip's contents, and a diff
    // tab paints no row, so only `f:` ids are part of this picture).
    const openFiles = st.state.views
      .flatMap((v) => v.slots.flatMap((slot) => st.slotTabIds(slot)))
      .filter((k) => k.startsWith('f:'))
      .sort()
      .join(',');
    return [
      tab,
      headerName(),
      // The tab's own availability is a rendered state, so it belongs in the
      // signature: without it the last session exiting would leave an enabled
      // Commits tab on a panel headed `Home`.
      repoKnown() ? 'repo' : 'home',
      // The data itself: every listing and every git answer bumps this, which
      // is the only way a repaint can know that a folder it is already showing
      // has just answered.
      String(dataVersion),
      currentPath ?? '',
      Array.from(openFolders).sort().join(','),
      Array.from(changesOpen).sort().join(','),
      // A9b, widened by B10a: every chosen row is drawn (`is-sel`,
      // `aria-current`) and the ANCHOR is spoken (the copy strip), so a change
      // to either has to repaint the panel like any other. Sorted, because a
      // set has no order and the signature must not depend on one.
      [...selected.keys].sort().join(','),
      selected.anchor ?? '',
      // The rows of a delete in flight wear `is-busy`, and the guard that
      // refuses a second one is this same value.
      deleting === null ? '' : [...deleting].sort().join(','),
      // A9c: the name row, its kind, its folder, its refusal and whether the
      // request is out. The TEXT is deliberately not here — it lives in the
      // input between repaints, and a signature that changed on every
      // keystroke would rebuild the tree under the cursor.
      creating === null ? '' : `${creating.kind}:${creating.dir}:${creating.error ?? ''}`,
      createBusy ? 'busy' : '',
      st.state.openCommit ?? '',
      collapsed,
      openFiles,
    ].join('|');
  }

  function render(): void {
    if (!st.filesPanelVisible()) {
      lastSig = 'hidden';
      wasVisible = false;
      // The panel left the screen (the Files toggle, or the Projects drawer
      // borrowing the left column): the chosen folder goes with it. A9b lets a
      // selection take a paste away from a focused TERMINAL, and a destination
      // nobody can see must never do that. The menu goes with it for the same
      // reason: this branch returns BEFORE `rebuild()`, which is where the only
      // other `closeRowMenu()` lives, so an open card would float over a panel
      // that is no longer on screen.
      closeRowMenu();
      // And the name row with it (A9c, §6b): a half-typed name over a panel
      // nobody can see would come back on the next toggle as a question the
      // user has long stopped asking.
      dropCreate('hidden');
      selected = afterPanelHidden(selected);
      // …and with it the promise about where a delete would put the keyboard:
      // it is about rows on a screen nobody is looking at any more.
      focusAfterDelete = null;
      // A panel nobody can see may not hold a timer: the poll is dropped here
      // and armed again by the render that brings the panel back.
      syncPoll();
      return;
    }
    // Back on screen: re-read the root (cache-then-revalidate, so the rows that
    // are already there stay put) and re-ask git. A home folder we never
    // learned is asked for again — that probe is the only one with no second
    // chance of its own. A root that MOVED in the same pass has just been
    // fetched by `setRoot`, so it is not asked for twice.
    const returning = !wasVisible;
    wasVisible = true;
    if (returning && homePath === null) homeAsked = false;
    const moved = syncRoot();
    if (returning && !moved && currentPath !== null) {
      fetchFolder(currentPath);
      fetchChanges(currentPath);
    }
    // Which tab is on screen is decided here, on every pass: `Files` while the
    // wished one has no repository behind it (a DEFINITE no — see
    // `visibleTab`), the wished one again the moment one answers. The wish
    // itself is never touched by this, so a root change cannot spend it.
    tab = visibleTab();
    syncPoll();
    const s = sig();
    if (s === lastSig) return;
    lastSig = s;
    rebuild();
  }

  function rebuild(): void {
    // The menu is anchored to a row that is about to be replaced, so it goes
    // first — every other state here survives the rebuild, this one may not.
    // (The SELECTION does survive it: it is painted from the path.)
    closeRowMenu();
    rebuilding = true;
    try {
      paint();
    } finally {
      rebuilding = false;
    }
  }

  /**
   * May this panel move the keyboard right now (A9c)?
   *
   * Yes when nothing holds it (`<body>`, or nothing at all), when it is
   * already inside this panel, or when it is inside the EDITOR pane a created
   * file just opened — the app moved it there itself, so following the new row
   * is still one gesture. No when anything else has it, a terminal above all:
   * a pane hosting a PTY (`.term-host`) is the one place a stolen focus costs
   * keystrokes.
   */
  function keyboardIsOurs(): boolean {
    const a = document.activeElement;
    if (a === null || a === document.body) return true;
    if (!(a instanceof HTMLElement)) return false;
    // A node that is no longer in the document is the name row's OWN input,
    // which this very repaint removed: nobody is typing into it, and a browser
    // that has already dropped the focus to `<body>` would answer above.
    if (!a.isConnected) return true;
    if (a.closest('.files-view') !== null) return true;
    return a.closest('.pane') !== null && a.closest('.term-host') === null;
  }

  /**
   * The rebuild itself. Split out so `rebuilding` is raised for every path out
   * of it — the name row's `blur` handler reads that flag, and a repaint that
   * threw halfway would otherwise leave it raised for good, which is a create
   * that can never be cancelled by clicking away from it again.
   */
  function paint(): void {
    // A9c: the typed name lives in the element that is about to be replaced.
    // It is read out BEFORE anything is removed, so a repaint (a listing
    // landing, a refusal being drawn) never costs the user their text.
    if (creating !== null && nameInput !== null && nameInput.isConnected) {
      createText = nameInput.value;
    }
    const hadName =
      document.activeElement instanceof HTMLElement &&
      document.activeElement.classList.contains('files-newname');
    nameInput = null;
    const focusKey =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.getAttribute('data-k')
        : null;

    const title = noRepoTitle(headerName());
    for (const [k, b] of tabBtns) {
      const on = k === tab;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      // A tab with no repository behind it is not a poorer view, it is no
      // view: the control is really disabled (not just dimmed) and says why on
      // hover and to a screen reader. The same title covers "there is no
      // repository here" and "we have not been told yet" on purpose — a third,
      // transient tooltip would be noise for the second it takes to ask.
      const off = !tabAvailable(k);
      // Disabling the focused element drops the keyboard on <body> (the
      // browser blurs it, and a disabled button cannot be refocused below), so
      // the Files tab takes the focus first: always enabled, always visible.
      if (off && document.activeElement === b) tabBtns.get('files')?.focus();
      b.disabled = off;
      if (off) {
        b.setAttribute('aria-disabled', 'true');
        b.title = title;
      } else {
        b.removeAttribute('aria-disabled');
        b.title = '';
      }
    }
    projName.textContent = headerName();
    syncCopyStrip();

    // The summary belongs to the repository, so it is drawn for the Changes
    // tab only — and not for a clean tree, where `+0 -0 … in 0 files` would
    // say the same thing as the sentence under it, twice.
    const files = changes !== null && changes.isRepo ? changes.files : [];
    if (tab === 'changes' && files.length > 0) {
      const totals = diffSummary(changesToFiles(files));
      sumAdd.textContent = `+${totals.add}`;
      sumDel.textContent = `-${totals.del}`;
      // Every changed file counts, not only the ones carrying numbers: an
      // untracked file has no diff to count and is still one of the files
      // this repository has changed.
      sumText.textContent = summaryText(files.length);
      summary.hidden = false;
    } else {
      summary.hidden = true;
    }
    // The placeholder line belongs to `Commits` alone now: it is the last
    // surface in this panel still drawing `ui/files-mock.ts`. Part B3 deletes
    // `placeholderNote` and this one argument together.
    body.replaceChildren(...(tab === 'commits' ? [placeholderNote(), ...commitRows()] : []), ...(tab === 'files' ? fileRows() : []), ...(tab === 'changes' ? changeRows() : []));
    // The selected state has its own header block above the body (the back
    // control, the message and the meta line); it is the same commit the full
    // view shows, so the two can never disagree.
    selHd.replaceChildren(...selectedHeader());
    selHd.hidden = selHd.children.length === 0;

    // WHERE THE KEYBOARD LANDS, in the order the gestures happened (A9c).
    //
    // 1. the row a create just made, as soon as its folder has answered with
    //    it. Until that answer lands there is no such row, so the promise is
    //    carried across repaints — and dropped the moment the refetch is over
    //    without it, so it can never steal the keyboard later.
    if (focusCreated !== null) {
      const made = root.querySelector<HTMLElement>(`[data-k="${CSS.escape(focusCreated.key)}"]`);
      const dir = focusCreated.dir;
      if (made !== null) {
        focusCreated = null;
        // ONLY IF THE KEYBOARD IS STILL OURS. The listing lands a moment after
        // the create, and in that moment the user may have clicked into a
        // terminal: moving the focus onto a tree row then would take the next
        // keystrokes away from a PTY.
        if (keyboardIsOurs()) {
          made.focus();
          return;
        }
      } else if (!inFlight.has(dir)) {
        focusCreated = null;
      }
    }
    // 2. the name row: on the repaint that created it, and on every repaint
    //    that replaced it while it had the keyboard (a refusal being drawn).
    const fresh = liveNameInput();
    if (fresh !== null && (focusName || hadName)) {
      focusName = false;
      fresh.focus();
      return;
    }
    // 3. whatever had it before this rebuild, by key.
    if (focusKey !== null) {
      const back = root.querySelector<HTMLElement>(`[data-k="${CSS.escape(focusKey)}"]`);
      if (back !== null) {
        // The keyboard is standing on a row that is still here, so a pending
        // delete promise is about some other row and is dropped: it may never
        // move the focus away from a row the user walked to themselves.
        if (focusAfterDelete !== null && !focusAfterDelete.gone.has(focusKey)) {
          focusAfterDelete = null;
        }
        back.focus();
        return;
      }
      // 4. the row the keyboard was on is GONE, and this delete promised where
      //    to go next (B10a): the nearest surviving row, else the Files tab —
      //    always a real control, never `<body>`, where no key reaches
      //    anything until the next window activation.
      const promise = focusAfterDelete;
      if (promise !== null && promise.gone.has(focusKey)) {
        focusAfterDelete = null;
        for (const key of promise.candidates) {
          const row = root.querySelector<HTMLElement>(`[data-k="${CSS.escape(key)}"]`);
          if (row !== null) {
            row.focus();
            return;
          }
        }
        // An empty tree has no row to stand on; the tab that is always there
        // takes the keyboard instead.
        tabBtns.get('files')?.focus();
      }
    }
  }

  /**
   * PLACEHOLDER MARKER — DELETE WITH THE MOCK. The Commits tab is the last
   * surface in this panel drawing `ui/files-mock.ts`, under the user's real
   * project name, so without this line it reads as a report about their
   * repository. Part B3 removes the sentence, this function and its single
   * call site together.
   */
  function placeholderNote(): HTMLElement {
    return el('p', 'files-note', 'Example data until the panel reads your commits.');
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
    const model = fsRows(rootP, openFolders, listings);
    for (const r of model) {
      let row: HTMLElement;
      if (r.kind === 'state') {
        rows.push(stateRow(r.name, r.indent, errs.has(r.name)));
        continue;
      }
      const key = rowKey(r.path, r.kind === 'dir');
      if (r.kind === 'dir') {
        const b = button('files-row is-dir', '');
        // ONE gesture, TWO effects, in this order (A9b user decision 1): the
        // row becomes the chosen row, and THEN it opens or closes exactly as
        // it always did. A re-click keeps it chosen — the toggle is what
        // flips, the selection is not. ctrl and shift do NEITHER of the two
        // (B10a): they only change the selection, because a ctrl+click that
        // also collapsed the folder would move every row under the pointer
        // in the middle of the gesture.
        b.addEventListener('click', (e) => onRowClick(e, key, () => toggleFolder(r.path)));
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
        armRowMenuChord(b, key);
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
          onRowClick(e, key, () => {
            st.openFile(currentRoot(), r.path, r.name);
          }),
        );
        b.setAttribute('data-k', key);
        b.setAttribute('aria-haspopup', 'menu');
        b.title = ROW_TITLE;
        // The row of a file that is on screen keeps a ground, so the tree says
        // where the panes are standing.
        b.classList.toggle('is-open', pathIsOpen(r.path));
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
          openBeside(r.path, r.name);
        });
        armRowMenuChord(b, key);
        row = b;
      }
      row.style.paddingLeft = `${r.indent}px`;
      // The chosen rows, painted from the KEYS and not from live elements —
      // which is what makes a selection survive this very rebuild. Folders and
      // files alike since B10a, and there may be many of them at once.
      const isSel = selected.keys.has(key);
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
      row.classList.toggle('is-busy', deleting !== null && deleting.has(key));

      const caret = el('span', 'files-caret', r.caret);
      caret.setAttribute('aria-hidden', 'true');
      row.append(caret);

      if (r.kind === 'dir') {
        const ic = folderIcon();
        ic.classList.add('files-folder');
        if (r.open) ic.classList.add('is-open');
        row.append(ic);
      } else {
        const b = badgeFor(r.name);
        const badge = el('span', 'files-badge', b.label);
        badge.dataset.kind = b.kind;
        badge.setAttribute('aria-hidden', 'true');
        row.append(badge);
      }

      // No `+N -N` here any more: a browser knows what is IN a folder, not
      // what a repository has changed. Those numbers moved to `Changes`.
      row.append(el('span', 'files-name', r.name));
      rows.push(row);
    }
    // One element per model row above, so the model's index IS this list's.
    insertNameRow(rows, model, rootP);
    return rows;
  }

  /**
   * The Commits tab's SELECTED state (A6): the header block above the body.
   * Empty — and hidden — unless a commit is open. `All commits` closes the
   * whole view, exactly like the view's own `Back to sessions`: one commit is
   * open or none is, and the panel and the view are two windows on that one
   * fact.
   *
   * A commit view that is ALREADY open when the repository goes away (the last
   * session exits) is left standing: it is a full screen with its own
   * `Back to sessions`, closing it under the user would take away the thing
   * they are reading. What the disabled tab removes is the way to open the
   * NEXT one — the panel flips to Files and the commit list is out of reach.
   */
  function selectedHeader(): HTMLElement[] {
    const c = openCommit();
    // Only the Commits tab turns into the selected state. Switching to Files
    // while a commit is open leaves the VIEW open and shows the tree — the
    // reference gates the panel on the tab, never the view (and the view's own
    // `Back to sessions` is always there).
    if (c === null || tab !== 'commits') return [];
    const back = button('files-back', '', () => {
      st.closeCommitView();
      onLeaveScreen();
    });
    back.setAttribute('data-k', 'commit:all');
    back.append(caretLeftIcon(), el('span', '', 'All commits'));

    const meta = el('div', 'commit-meta');
    meta.append(
      el('span', 'commit-hash', c.hash),
      el('span', '', c.author),
      el('span', '', c.when),
    );
    return [back, el('div', 'files-selmsg', c.message), meta];
  }

  /** The open commit, when the mock knows it. */
  function openCommit(): CommitEntry | null {
    return mockCommitByHash(st.state.openCommit);
  }

  /**
   * The Commits tab's body: the list, or — while a commit is open — that
   * commit's files, each row folding its own diff block in the view.
   */
  function commitRows(): HTMLElement[] {
    const open = openCommit();
    if (open !== null) {
      const rows: HTMLElement[] = [
        el('div', 'files-branch', filesChangedText(open.files.length)),
      ];
      for (const f of open.files) {
        const collapsed = st.commitFileCollapsed(open.hash, f.path);
        const row = button('commit-file', '', () => st.toggleCommitFile(open.hash, f.path));
        row.setAttribute('data-k', `cfile:${f.path}`);
        row.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        // The block it expands lives in the commit VIEW, a different region of
        // the screen — so the row names it by id instead of leaving
        // `aria-expanded` pointing at nothing.
        row.setAttribute('aria-controls', blockDomId(open.hash, f.path));
        row.classList.toggle('is-collapsed', collapsed);
        // The PATH is the row (a commit's files are not a tree), so it is mono
        // and it truncates at its FRONT — the file name is what identifies it.
        row.append(
          el('span', 'commit-fpath', f.path),
          el('span', 'files-num is-add', `+${f.add}`),
          el('span', 'files-num is-del', `-${f.del}`),
        );
        rows.push(row);
      }
      return rows;
    }
    const rows: HTMLElement[] = [
      el('div', 'files-branch', commitsHeaderText(MOCK_BRANCH, MOCK_COMMITS.length)),
    ];
    for (const c of MOCK_COMMITS) {
      const row = button('commit-row', '', () => st.openCommitView(c.hash));
      row.setAttribute('data-k', `commit:${c.hash}`);
      row.append(el('span', 'commit-msg', c.message));
      const meta = el('div', 'commit-meta');
      meta.append(
        el('span', 'commit-hash', c.hash),
        el('span', '', c.author),
        el('span', '', c.when),
        el('span', 'drawer-gap'),
        el('span', 'files-num is-add', `+${c.add}`),
        el('span', 'files-num is-del', `-${c.del}`),
      );
      row.append(meta);
      rows.push(row);
    }
    return rows;
  }

  return { render };
}

/**
 * The folder row that LAST held the keyboard while the focus was still inside
 * the panel, or null. It is a memory and not a reading of
 * `document.activeElement` because the destination has to survive the very
 * gesture that uses it: clicking (or tabbing to) the copy strip's button takes
 * the focus off the folder row, and a destination that collapsed to the panel
 * root at that moment would copy somewhere else than the button promised.
 * Focus leaving the panel altogether does clear it — then the promise is the
 * panel's own root again.
 */
let lastRow: HTMLElement | null = null;

/**
 * Keep that memory. Anywhere INSIDE the panel (a folder row, the copy button,
 * the tabs, the header) keeps it; a folder row replaces it; anything outside
 * the panel drops it.
 */
function noteFocus(target: EventTarget | null): void {
  const t = target instanceof HTMLElement ? target : null;
  if (t === null || t.closest('.files-view') === null) {
    lastRow = null;
    return;
  }
  const row = t.closest<HTMLElement>('.files-row.is-dir');
  if (row !== null) lastRow = row;
}

/**
 * The folder row this element sits in, as a destination. A folder row of the
 * TREE is a button carrying `data-k="fdir:<absolute path>"` — the path is what
 * part B10 posts to, its last segment is the only part ever shown. A folder
 * row of the `Changes` tab carries a `gdir:` key over a REPO-RELATIVE path, so
 * it deliberately answers nothing: a relative path is not a place to copy
 * files into, and the panel's own root answers for it instead.
 */
function folderDestOf(t: HTMLElement): Destination | null {
  const row = t.closest<HTMLElement>('.files-row.is-dir');
  if (row === null) return null;
  const key = row.getAttribute('data-k') ?? '';
  if (!key.startsWith('fdir:')) return null;
  const path = key.slice('fdir:'.length);
  if (path === '') return null;
  const name = fileName(path);
  return name === '' ? null : { path, name };
}

function focusedFolderDest(): Destination | null {
  // A row the tree rebuilt under the memory is no row at all: it is detached,
  // nothing on screen carries that promise any more, and the panel's own root
  // answers again. Removing an element never fires a focus event, so this is
  // the only moment the staleness can be noticed.
  if (lastRow !== null && lastRow.closest('.files-view') === null) lastRow = null;
  return lastRow === null ? null : folderDestOf(lastRow);
}
