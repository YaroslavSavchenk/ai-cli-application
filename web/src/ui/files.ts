/**
 * Files panel (Nocturne part A5) — the left panel: what changed in the active
 * project since its last commit, and the commits before that.
 *
 * PLACE IN THE SHELL. It is a flex sibling of the pane grid, exactly like the
 * two drawers, because that is what makes opening it a REAL layout change:
 * the grid narrows, every TerminalView's ResizeObserver fires, and the
 * existing debounced fit -> ws `resize` chain tells the PTY its new cols/rows.
 * Nothing here talks to a terminal; the seam does the work.
 *
 * WHAT IS REAL AND WHAT IS NOT. The header is the only live datum in this
 * panel: the FOCUSED session's project name, that session's own title when it
 * has no project, and `Home` — the panel's default root until part B2 (user
 * decision 2026-09-15) — when no session is focused or alive.
 * Everything else comes from `ui/files-mock.ts` until parts B2
 * (`git diff --numstat`) and B3 (`git log`). No fake interaction is wired for
 * it beyond what parts A5, A6 and A10 can honestly do: folders open and close,
 * a file row opens that file as a PANE of its root folder's tab (A10, mock
 * text), a commit row opens the full commit view (A6, mock diff).
 *
 * WHICH TAB A FILE LANDS IN (A10). The panel's `subject()` answers it, through
 * the pure `rootForSubject()`: `Home` -> the Home tab, a focused session with a
 * project -> that project's folder tab, anything else -> `Home` (the A10 gap
 * part B2 closes with the real file-browser root). Every row is also a pointer
 * drag source, and its keyboard twin is ctrl+alt+enter — a control that exists
 * only under a pointer is forbidden here.
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
  afterPanelHidden,
  afterRowActivate,
  COPY_LABEL,
  copyIntoText,
  copyStripLabel,
  selectedName,
  type Selection,
} from './files-select-model.ts';
import { fileName, rootForSubject } from './slots-model.ts';
import { caretLeftIcon, folderIcon } from './icons.ts';
import type { SessionInfo } from '../../../shared/protocol.ts';
import type { CommitEntry, TreeNode } from './files-model.ts';
import {
  badgeFor,
  buildTree,
  commitsHeaderText,
  diffSummary,
  summaryText,
  treeRows,
} from './files-model.ts';
import { blockDomId, filesChangedText } from './commit-model.ts';
import {
  MOCK_BRANCH,
  MOCK_COMMITS,
  MOCK_FILES,
  MOCK_OPEN_FOLDERS,
  mockCommitByHash,
} from './files-mock.ts';

type Tab = 'files' | 'commits';

/** Arrow-key step for the width, in px — the keyboard twin of the edge drag. */
const NUDGE_PX = 16;

/**
 * Why the Commits tab is unavailable at `Home` (user decision 2026-09-15): the
 * panel's default root is the home folder, and a home folder is not a
 * repository, so there is no commit history to look at. A fragment, because it
 * is a tooltip on a control, not a sentence about the app.
 */
const NO_REPO_TITLE = 'No repository at Home';

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
const DIR_TITLE = 'Open or close it. Copy files into it with ctrl+alt+c.';

export interface FilesPanel {
  render(): void;
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
  focusedFolderName(): string | null;
  selectedFolder(): string | null;
} | null = null;

/** What the panel is about: a NAME, whether it is `Home`, and the project behind it. */
interface Subject {
  name: string;
  home: boolean;
  projectId: string | null;
}

/** The panel's own root — its non-folder area, as a name. Null with no panel. */
export function filesPanelDestination(): string | null {
  return live === null ? null : live.subject().name;
}

/**
 * Where a paste — and the `Copy files here…` button — would copy to: the
 * folder row the keyboard last stood on inside the panel (the button that asks
 * this took the focus off it), else the panel's own root, else the active
 * tab's root (the panel can be closed while a drop still has to go somewhere).
 */
export function pasteDestination(): string | null {
  if (live !== null) {
    // A9b, first rung: the SELECTED folder. It is the only one of the two that
    // says out loud where files will land (the copy strip names it), so it
    // wins over the focus memory always — including a paste arriving from a
    // focused terminal, which has no focus memory of its own.
    const chosen = live.selectedFolder();
    if (chosen !== null) return chosen;
    const folder = live.focusedFolderName();
    if (folder !== null) return folder;
    return live.subject().name;
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
export function selectedFolder(): string | null {
  return live === null ? null : live.selectedFolder();
}

/** The ACTIVE tab's root, as a name: `Home`, a project's name, else null. */
export function destinationOfActiveView(): string | null {
  return rootName(st.activeView());
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
 * A session with neither a project nor a rooted tab has no folder this app is
 * allowed to name (user decision 4, 2026-09-15: the app may not print a path),
 * so it answers nothing plus the REASON, and the drop layer turns that into
 * the sentence it flashes.
 */
export function destinationOfPane(paneEl: HTMLElement): PaneDest {
  const v = st.activeView();
  if (v === null) return { dest: null, why: 'tab' };
  const root = rootName(v);
  const slot = v.slots[Number(paneEl.dataset.slot)];
  if (slot === undefined) return root === null ? { dest: null, why: 'tab' } : { dest: root };
  if (slot.kind === 'session') {
    const own = projectOf(slot.id);
    if (own !== null) return { dest: own };
    if (root !== null) return { dest: root };
    return { dest: null, why: 'session' };
  }
  if (root !== null) return { dest: root };
  // A file or a diff in a plain session tab: no folder to follow, so the
  // tab's OWN first session answers for it, exactly as `subject()` does for
  // the header above it. Nothing there to borrow from is a TAB without a
  // folder, not a session without a project.
  const first = st.sessionIds(v)[0];
  const name = first === undefined ? null : projectOf(first);
  return name === null ? { dest: null, why: 'tab' } : { dest: name };
}

/**
 * A session's project as a NAME, or null when it has none left to name. An
 * EXITED session answers nothing here, exactly as `subject()` skips it for
 * the header: the pane and the header must never name two folders.
 */
function projectOf(id: string): string | null {
  const info = st.state.sessions.get(id);
  if (info !== undefined && info.status === 'exited') return null;
  const name = info === undefined ? null : st.projectName(info.projectId);
  return name === null || name === '' ? null : name;
}

/** A view's root as a NAME. A project deleted under an open tab has none left. */
function rootName(v: st.ViewState | null): string | null {
  if (v === null || v.root === null) return null;
  if (v.root.kind === 'home') return 'Home';
  const name = st.projectName(v.root.id);
  return name === null || name === '' ? null : name;
}

/**
 * The TOP-LEVEL names already in a destination — the only input the conflict
 * question takes.
 *
 * MOCK, like the tree it reads: `buildTree(MOCK_FILES)` is what the panel
 * draws, so dropping `README.md` on the root or `Pane.tsx` on `src` really does
 * show the conflict dialog, and nothing claims to know a folder the panel has
 * never listed. A destination that is not a folder IN that tree — `Home`, a
 * project's name — is the tree's ROOT. Part B2 replaces this with the real
 * listing of the real folder, and the signature does not change.
 */
export function listingFor(dest: string): readonly string[] {
  const roots = buildTree(MOCK_FILES);
  const found = findDir(roots, dest);
  return (found ?? roots).map((n) => n.name);
}

/** Depth-first search for a folder by NAME; its children, or null. */
function findDir(nodes: readonly TreeNode[], name: string): TreeNode[] | null {
  for (const n of nodes) {
    if (!n.dir) continue;
    if (n.name === name) return n.children;
    const deeper = findDir(n.children, name);
    if (deeper !== null) return deeper;
  }
  return null;
}

/**
 * `onLeaveScreen` hands the keyboard back to the focused terminal after the
 * panel closed a surface the user was standing in (the commit view's
 * `All commits`). It is INJECTED rather than imported for the same reason
 * ui/panes.ts takes its launch opener that way — and here it also keeps this
 * module free of `ui/panes.ts`, whose import graph reaches @xterm/xterm, so
 * the panel stays drivable under `node --test`.
 */
export function initFilesPanel(host: HTMLElement, onLeaveScreen: () => void): FilesPanel {
  // Local to the panel instance: which tab is up and which folders are open.
  // Neither is server state and neither survives a reload — the tree itself is
  // still mocked, so persisting a set of folder names would persist fiction.
  let tab: Tab = 'files';
  const openFolders = new Set<string>(MOCK_OPEN_FOLDERS);

  // ---- selection -----------------------------------------------------------
  //
  // The ONE folder the user chose (part A9b, user decision 1, 2026-09-16), as
  // a PATH because that is what identifies a row across a rebuild. Every
  // decision about it lives in `ui/files-select-model.ts`; this region only
  // holds it, paints it and spends the Escape key on it.
  //
  // It sits here, beside `openFolders`, for the same reason that set does: it
  // is not server state, it is not persisted (the tree is still a mock, so a
  // remembered path would be remembered fiction), and no module outside this
  // panel renders it. `state.ts` and the localStorage schema do not change by
  // one line for it.
  //
  // WHY IT SURVIVES EVERYTHING. It is part of `sig()` and `rebuild()` paints
  // `is-sel` from the path, so a folder toggle, a subject change, a tab switch
  // and every other repaint leave it exactly where it was — including a
  // selected folder whose ANCESTOR was collapsed, which draws no row but keeps
  // naming itself in the copy strip.
  let selected: Selection = null;

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
    if (e.key !== 'Escape' || selected === null) return;
    e.preventDefault();
    e.stopPropagation();
    selected = afterEscape(selected);
    lastSig = '';
    render();
  });

  /**
   * The selection as a NAME, for the three readers outside this region: the
   * copy strip's title, `pasteDestination()` and `selectedFolder()`.
   *
   * A panel that is not on screen answers NOTHING even before the render pass
   * that clears the selection has run — `afterPanelHidden` is the state, this
   * is the guarantee, and the guarantee is what a paste arriving from a
   * focused terminal actually asks.
   */
  function currentSelectedName(): string | null {
    if (!st.filesPanelVisible()) return null;
    return selectedName(selected);
  }

  // ---- header: the two tabs, then the name of what we are looking at -------
  const hd = el('header', 'files-hd');
  const tabsRow = el('div', 'files-tabs');
  tabsRow.setAttribute('role', 'group');
  tabsRow.setAttribute('aria-label', 'files or commits');
  const tabBtns = new Map<Tab, HTMLButtonElement>();
  for (const t of [
    { k: 'files' as const, label: 'Files' },
    { k: 'commits' as const, label: 'Commits' },
  ]) {
    const b = button('files-tab', t.label, () => setTab(t.k));
    b.setAttribute('data-k', `ftab:${t.k}`);
    tabBtns.set(t.k, b);
    tabsRow.append(b);
  }
  const projName = el('span', 'files-proj');
  hd.append(tabsRow, el('span', 'drawer-gap'), projName);

  // ---- files tab: summary hairline + the tree ------------------------------
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
    copyBtn.textContent = copyStripLabel(selected);
    const dest = pasteDestination();
    copyBtn.title = dest === null ? '' : copyIntoText(dest);
  }
  document.addEventListener('focusin', (e) => {
    noteFocus(e.target);
    syncCopyStrip();
  });
  // The destination questions the drop layer asks are answered against THIS
  // panel (there is one), through the same `subject()` the header prints — set
  // before the first title, so the button never starts out naming the fallback.
  live = { subject, focusedFolderName, selectedFolder: currentSelectedName };
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
   *      own name stands in — and its ROOT is Home (A10 gap, closed by B2).
   *   3. nothing focused / nothing alive -> the first live session, then `Home`.
   */
  function subject(): { name: string; home: boolean; projectId: string | null } {
    const v = st.activeView();
    const slot = v === null ? undefined : v.slots[v.focused];
    if (v !== null && slot !== undefined && slot.kind !== 'session' && v.root !== null) {
      if (v.root.kind === 'home') return { name: 'Home', home: true, projectId: null };
      const name = st.projectName(v.root.id);
      // A project deleted under an open folder tab has no name left to print;
      // fall through to the session rules rather than invent one.
      if (name !== null && name !== '') return { name, home: false, projectId: v.root.id };
    }
    if (v !== null && slot !== undefined && slot.kind !== 'session' && v.root === null) {
      // A file or diff pane in a plain session tab: no folder to follow, so
      // the tab's OWN first session answers for it. The global fallback below
      // would name a session from an unrelated tab, and send the next file to
      // that project's folder.
      const own = st.sessionIds(v)[0];
      const info = own === undefined ? undefined : st.state.sessions.get(own);
      if (info !== undefined) return ofSession(info);
      return { name: 'Home', home: true, projectId: null };
    }
    const id = slot !== undefined && slot.kind === 'session' ? slot.id : undefined;
    const info = id === undefined ? undefined : st.state.sessions.get(id);
    if (info !== undefined && info.status !== 'exited') return ofSession(info);
    // The focused pane's session is gone (absent from state, or kept there
    // with `status === 'exited'` — state.ts markExited flips it in place and
    // reconcileViews keeps the dead pane on purpose), so this is a normal
    // state, not an impossible one. A headerless tree says nothing about
    // nothing — fall back to the first session still alive.
    for (const s of st.state.sessions.values()) {
      if (s.status !== 'exited') return ofSession(s);
    }
    // Nothing is running: the panel's default root, the user's home directory,
    // said as a NAME (the header rule forbids `~` and `/home/...`) until part
    // B2 makes the panel live.
    return { name: 'Home', home: true, projectId: null };
  }

  /**
   * A session as a subject. `projectId` is only carried when the project is
   * really there: a name the panel cannot print is not a folder a file can be
   * opened into either, and the honest fallback for both is `Home`.
   */
  function ofSession(info: SessionInfo): { name: string; home: boolean; projectId: string | null } {
    const name = st.projectName(info.projectId);
    if (name !== null && name !== '') return { name, home: false, projectId: info.projectId ?? null };
    return { name: info.title, home: false, projectId: null };
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

  /**
   * Is there a repository behind this panel? Only "not Home" — a session
   * WITHOUT a project still counts, and keeps showing the mock commits exactly
   * as it does today; real repo detection belongs to part B3 and is not
   * invented here.
   */
  function repoKnown(): boolean {
    return !subject().home;
  }

  function setTab(next: Tab): void {
    if (tab === next) return;
    // Defence in depth for the disabled Commits tab: the button carries
    // `disabled`, so a browser fires no click on it, but the tab must be
    // unreachable by construction and not by the DOM's good manners.
    if (next === 'commits' && !repoKnown()) return;
    tab = next;
    lastSig = '';
    render();
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
      Array.from(openFolders).sort().join(','),
      // A9b: the chosen folder is drawn (`is-sel`) and spoken (the copy
      // strip), so a change to it has to repaint the panel like any other.
      selected ?? '',
      st.state.openCommit ?? '',
      collapsed,
      openFiles,
    ].join('|');
  }

  function render(): void {
    if (!st.filesPanelVisible()) {
      lastSig = 'hidden';
      // The panel left the screen (the Files toggle, or the Projects drawer
      // borrowing the left column): the chosen folder goes with it. A9b lets a
      // selection take a paste away from a focused TERMINAL, and a destination
      // nobody can see must never do that.
      selected = afterPanelHidden(selected);
      return;
    }
    // The repository went away under the panel (the last session exited, the
    // header fell back to `Home`): the Commits tab is about to be disabled, so
    // the panel cannot keep standing on it. setTab does the flip and the
    // repaint; the signature below then matches and this pass stops here.
    if (tab === 'commits' && !repoKnown()) {
      setTab('files');
      return;
    }
    const s = sig();
    if (s === lastSig) return;
    lastSig = s;
    rebuild();
  }

  function rebuild(): void {
    const focusKey =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.getAttribute('data-k')
        : null;

    const repo = repoKnown();
    for (const [k, b] of tabBtns) {
      const on = k === tab;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      // Commits at `Home` is not a poorer view, it is no view: the control is
      // really disabled (not just dimmed) and says why on hover and to a
      // screen reader.
      const off = k === 'commits' && !repo;
      // Disabling the focused element drops the keyboard on <body> (the
      // browser blurs it, and a disabled button cannot be refocused below), so
      // the Files tab takes the focus first: always enabled, always visible.
      if (off && document.activeElement === b) tabBtns.get('files')?.focus();
      b.disabled = off;
      if (off) {
        b.setAttribute('aria-disabled', 'true');
        b.title = NO_REPO_TITLE;
      } else {
        b.removeAttribute('aria-disabled');
        b.title = '';
      }
    }
    projName.textContent = headerName();
    syncCopyStrip();

    if (tab === 'files') {
      const totals = diffSummary(MOCK_FILES);
      sumAdd.textContent = `+${totals.add}`;
      sumDel.textContent = `-${totals.del}`;
      sumText.textContent = summaryText(totals.files);
      summary.hidden = false;
    } else {
      summary.hidden = true;
    }
    // ONE render site for the placeholder line, so B2/B3 remove it by deleting
    // `placeholderNote` and this one argument.
    body.replaceChildren(placeholderNote(), ...(tab === 'files' ? fileRows() : commitRows()));
    // The selected state has its own header block above the body (the back
    // control, the message and the meta line); it is the same commit the full
    // view shows, so the two can never disagree.
    selHd.replaceChildren(...selectedHeader());
    selHd.hidden = selHd.children.length === 0;

    if (focusKey !== null) {
      root.querySelector<HTMLElement>(`[data-k="${CSS.escape(focusKey)}"]`)?.focus();
    }
  }

  /**
   * PLACEHOLDER MARKER — DELETE WITH THE MOCK. Everything below the header is
   * `ui/files-mock.ts`, and it carries the user's real project name, so without
   * this line the panel reads as a report about their repository. Part B2 (the
   * file list) and B3 (the commits) each remove their own sentence, and when
   * both are gone this function and its single call site go with them.
   */
  function placeholderNote(): HTMLElement {
    return el(
      'p',
      'files-note',
      tab === 'files'
        ? 'Example data until the panel reads your files.'
        : 'Example data until the panel reads your commits.',
    );
  }

  /** The tree: folder rows toggle, file rows open that file as a pane (A10). */
  function fileRows(): HTMLElement[] {
    const rows: HTMLElement[] = [];
    for (const r of treeRows(buildTree(MOCK_FILES), openFolders)) {
      let row: HTMLElement;
      if (r.dir) {
        const b = button('files-row is-dir', '', () => {
          // ONE gesture, TWO effects, in this order (A9b user decision 1): the
          // row becomes the chosen folder, and THEN it opens or closes exactly
          // as it always did. A re-click keeps it chosen — the toggle is what
          // flips, the selection is not.
          selected = afterRowActivate(selected, r.path);
          if (openFolders.has(r.path)) openFolders.delete(r.path);
          else openFolders.add(r.path);
          lastSig = '';
          render();
        });
        b.setAttribute('data-k', `fdir:${r.path}`);
        b.setAttribute('aria-expanded', r.open ? 'true' : 'false');
        // The chosen folder, painted from the PATH and not from a live element
        // — which is what makes it survive this very rebuild. A file row is
        // never selected, so the class is set on folder rows only.
        const isSel = selected === r.path;
        b.classList.toggle('is-sel', isSel);
        // The class is colour; `aria-current` is the same fact for a screen
        // reader. REMOVED, never `'false'`: an absent attribute is the honest
        // "not the current destination".
        if (isSel) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
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
          openCopyFilesPicker(r.name);
        });
        row = b;
      } else {
        // A10: a file row opens that file as a PANE of its root folder's tab.
        // The text it shows is still `ui/files-mock.ts` until part B4 — the
        // file pane says so in its own quiet line.
        const b = button('files-row is-file', '', () => {
          st.openFile(currentRoot(), r.path, r.name);
        });
        b.setAttribute('data-k', `ffile:${r.path}`);
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
        const b = badgeFor(r.name);
        const badge = el('span', 'files-badge', b.label);
        badge.dataset.kind = b.kind;
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
      rows.push(row);
    }
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
 * gesture that uses it: clicking (or tabbing to) `Copy files here…` takes the
 * focus off the folder row, and a destination that collapsed to the panel root
 * at that moment would copy somewhere else than the button's title promised.
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
 * The name of the folder row this element sits in, when it does. A folder row
 * is a button carrying `data-k="fdir:<path>"`, and only the last segment of
 * that path is ever a destination NAME.
 */
function folderNameOf(t: HTMLElement): string | null {
  const row = t.closest<HTMLElement>('.files-row.is-dir');
  if (row === null) return null;
  const key = row.getAttribute('data-k') ?? '';
  if (!key.startsWith('fdir:')) return null;
  const path = key.slice('fdir:'.length);
  return path === '' ? null : fileName(path);
}

function focusedFolderName(): string | null {
  // A row the tree rebuilt under the memory is no row at all: it is detached,
  // nothing on screen carries that promise any more, and the panel's own root
  // answers again. Removing an element never fires a focus event, so this is
  // the only moment the staleness can be noticed.
  if (lastRow !== null && lastRow.closest('.files-view') === null) lastRow = null;
  return lastRow === null ? null : folderNameOf(lastRow);
}
