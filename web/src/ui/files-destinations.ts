/**
 * Where the Files panel's destination names come from (part A9, B2, B10):
 * the module-level answers the drop layer asks — the panel's root, a paste's
 * destination, a pane's folder, a folder's listing — and the focus memory of
 * the folder row that last held the keyboard. The one live panel registers
 * itself through `setLive()`; `files.ts` re-exports every public answer.
 *
 * Split from `ui/files.ts` (O8, 2026-09-23), code moved as it stood.
 * Siblings: `files.ts` (the panel's shell, header, width grip and the menu
 * gesture), `files-ctx.ts` (the shared context), `files-destinations.ts`,
 * `files-tree.ts`, `files-git.ts`, `files-keys.ts`, `files-menu.ts`,
 * `files-naming.ts`, `files-render.ts`.
 */
import * as st from '../state.ts';
import { type PaneDest } from './filedrop.ts';
import { fileName } from './slots-model.ts';
import type { FsEntriesResponse } from '../../../shared/protocol.ts';
import { type Destination } from './fs-model.ts';

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
let live: LivePanel | null = null;

/** What the one live panel answers for the functions below. */
export interface LivePanel {
  subject(): Subject;
  rootDestination(): Destination | null;
  selectedFolder(): Destination | null;
  homePath(): string | null;
  entries(path: string): Promise<FsEntriesResponse>;
  refreshIfListed(path: string): void;
}

/** `initFilesPanel()` registers itself here — the one writer of `live`. */
export function setLive(panel: LivePanel): void {
  live = panel;
}

/**
 * What the panel is about: a NAME, whether it is `Home`, the project behind
 * it, and — since B2 — the real PATH that name stands for. One walk answers
 * all four (`subject()` below), which is what makes the header, the tree, the
 * drop destinations and the tab a file opens into agree by construction.
 */
export interface Subject {
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
 * Where a paste — and the copy strip's button — would copy to: the ANCHOR's
 * folder (A9b, widened by B10a — the selected folder itself, or a selected
 * file's parent), else the folder row the keyboard last stood on inside the
 * panel (the button that asks this took the focus off it), else the panel's
 * own root, else the active tab's root (the panel can be closed while a drop
 * still has to go somewhere).
 */
export function pasteDestination(): Destination | null {
  if (live !== null) {
    // A9b, widened by B10a, first rung: the ANCHOR's folder. It is the only
    // one of the two that
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
 * The ANCHOR's folder, as a NAME (never a path) — the selected folder itself,
 * or a selected file's parent since B10a — or null when nothing is selected,
 * when that path has no last segment to speak about, or when there is no panel
 * on screen to have a selection at all.
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
export function projectDest(id: string | undefined): Destination | null {
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
export function noteFocus(target: EventTarget | null): void {
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
