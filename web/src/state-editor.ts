/**
 * Files as TABS of an editor pane (A10/A10b): opening, moving, closing and
 * evicting file and diff tabs, and the unsaved text kept per file
 * (`state.edits`: set, save, retarget after a rename).
 *
 * Split from `state.ts` (O8, 2026-09-23).
 * Siblings: `state-core.ts` (types, the store, pub/sub), `state-persist.ts`
 * (view constructors, localStorage save/load), `state-views.ts` (slot geometry,
 * view membership, server state, tabs), `state-editor.ts` (files as tabs of an
 * editor pane, unsaved text), `state-chrome.ts` (focus, drawers and the Files
 * panel, the commit view, connection readouts). `state.ts` re-exports them all.
 */
import { log } from './log.ts';
import { filePathOf, fileTabId, tabIdOf, tabKind } from './ui/editor-model.ts';
import { remapPath } from './ui/rename-model.ts';
import {
  type Zone,
  MAX_PANES,
  MAX_TABS,
  type EditorTab,
  type EditorSlot,
  type PaneSlot,
  type ViewRoot,
  type ViewState,
  slotKey,
  state,
  notify,
} from './state-core.ts';
import { newView, saveUi, isHome, ensureHomeView } from './state-persist.ts';
import {
  indexOfSlot,
  insertSlots,
  removeAtSlot,
  dropZonesFor,
  dissolveView,
  activeView,
} from './state-views.ts';

// --------------------------------------------------------------------------
// Files as TABS of an editor pane (A10, reshaped by A10b 2026-09-15)
// --------------------------------------------------------------------------
//
// A file opens FULL in the pane area, as a TAB of the editor pane of the tab
// that belongs to its ROOT FOLDER — `Home`, or the project. Files do not each
// become their own pane (user decision 1, A10b): one editor pane per group,
// with an inner file-tab strip. Everything here is structural: it moves panes
// and tabs around, it never reads or writes a file, and it never decides
// anything about a session.
//
// Every function in this section notifies `'ui'` and nothing else: an editor
// pane is a PANE, and `'screen'` means something OTHER than the panes fills
// the pane area (`ui/panes.ts` ignores that kind on purpose).

/** What an open-a-file request answered. */
export type OpenFileResult =
  /** The file is on screen, focused, in an active tab. */
  | 'ok'
  /**
   * No room. From every opener: the target tab already shows `MAX_PANES`
   * panes. From `moveTab` ONLY: the target PANE already holds `MAX_TABS`
   * files — two "no room"s with two sentences, told apart by which function
   * answered (`ui/dnd.ts`, `flashMoveTabResult`).
   */
  | 'full'
  /** The centre of a TERMINAL pane: it splits at an edge, it never replaces. */
  | 'session-centre'
  /** No such view, or no such pane in it. */
  | 'no-view'
  /** That pane cannot split this way (the short pane of a 3-split, or a full tab). */
  | 'no-zone';

/**
 * The tab for a root: the one that already has it, or a new one. Home is
 * `state.views[0]` by construction; a project tab is appended. Notifies only
 * when it had to create something.
 */
export function viewForRoot(root: ViewRoot): ViewState {
  if (root.kind === 'home') {
    if (ensureHomeView()) {
      saveUi();
      notify('ui');
    }
    return state.views[0] as ViewState;
  }
  const found = state.views.find((v) => v.root?.kind === 'project' && v.root.id === root.id);
  if (found !== undefined) return found;
  const v = newView({ kind: 'project', id: root.id }, []);
  state.views.push(v);
  log.debug(`folder tab opened: view=${v.id} project=${root.id}`);
  saveUi();
  notify('ui');
  return v;
}

/**
 * A fresh editor pane holding `tabs`, with the first one active.
 *
 * The id is a module counter, `e:1`, `e:2`, … — NEVER reused within a page,
 * because `ui/panes.ts` keys its live panes by `slotKey` and a recycled id
 * would hand a new pane the old one's DOM (and its detached tab bodies).
 * Callers pass at least one tab: an empty strip is not a state this model has.
 */
let editorSeq = 0;
export function newEditorSlot(tabs: EditorTab[]): EditorSlot {
  editorSeq += 1;
  return { kind: 'editor', id: `e:${editorSeq}`, tabs: [...tabs], active: 0 };
}

/** Hold `active` inside `tabs` after any change to the strip. */
function clampActive(s: EditorSlot): void {
  s.active = Math.min(Math.max(0, s.active), Math.max(0, s.tabs.length - 1));
}

/** The tab an editor pane is showing; null for a terminal pane. */
export function activeTabOf(s: PaneSlot): EditorTab | null {
  if (s.kind !== 'editor') return null;
  return s.tabs[Math.min(Math.max(0, s.active), s.tabs.length - 1)] ?? null;
}

/** Every tab id an editor pane holds, in strip order; a terminal holds none. */
export function slotTabIds(s: PaneSlot): string[] {
  return s.kind === 'editor' ? s.tabs.map((t) => tabIdOf(t)) : [];
}

/** Where a tab id is open in this view — by SLOT INDEX and position in the strip. */
function findTab(v: ViewState, tabId: string): { slot: number; tabIndex: number } | null {
  for (let i = 0; i < v.slots.length; i++) {
    const s = v.slots[i] as PaneSlot;
    if (s.kind !== 'editor') continue;
    const t = s.tabs.findIndex((x) => tabIdOf(x) === tabId);
    if (t !== -1) return { slot: i, tabIndex: t };
  }
  return null;
}

/**
 * Which editor pane of a view a new tab belongs in: the FOCUSED one when it is
 * an editor, else the FIRST one, else -1 (the caller makes a pane). A focused
 * terminal therefore sends the tab to the view's first editor pane rather than
 * splitting the terminal away (user decision 1, A10b).
 */
function targetEditorIndex(v: ViewState): number {
  const focused = v.slots[v.focused];
  if (focused !== undefined && focused.kind === 'editor') return v.focused;
  return v.slots.findIndex((s) => s.kind === 'editor');
}

/** Is this tab id already in that strip? A raise, then — it costs no room. */
function stripHolds(s: EditorSlot, tabId: string): boolean {
  return s.tabs.some((t) => tabIdOf(t) === tabId);
}

/**
 * What ADDING `tabId` to pane `slotIndex` of view `viewId` would throw out —
 * the plan, not the act (B4 amendment, 2026-09-22). PURE and synchronous:
 * `ui/unsaved.ts` reads it BEFORE the open, so a tab carrying unsaved text no
 * other tab shows can still be rescued by `Keep editing`.
 *
 * `null` means "nothing leaves": the strip has room, the tab is already there
 * (a raise), or that pane is not an editor pane at all. Otherwise the tab in
 * the LAST position goes — `tabIndex` is always `MAX_TABS - 1`, named rather
 * than assumed so the caller never counts it out itself — and `lostIds` are
 * the `state.edits` keys that would have no tab left anywhere
 * (`dirtyLostBy`), which is exactly the list the question is asked about.
 */
export interface Eviction {
  /** Strip position that leaves: the last one. */
  tabIndex: number;
  /** Unsaved text no other tab would show afterwards; empty is the common case. */
  lostIds: string[];
}

export function evictionFor(viewId: string, slotIndex: number, tabId: string): Eviction | null {
  const v = state.views.find((x) => x.id === viewId);
  const s = v?.slots[slotIndex];
  if (v === undefined || s === undefined || s.kind !== 'editor') return null;
  if (s.tabs.length < MAX_TABS || stripHolds(s, tabId)) return null;
  const tabIndex = MAX_TABS - 1;
  return { tabIndex, lostIds: dirtyLostBy(viewId, slotIndex, tabIndex) };
}

/**
 * The same plan for `openFile`/`openDiff`, which choose their own pane: the
 * FOCUSED editor pane of the root's tab, else its first one (the rule
 * `targetEditorIndex` holds). PURE — unlike `viewForRoot` it never creates
 * the tab, because a tab that does not exist yet has no strip to overflow.
 *
 * `null` for every case that adds nothing to an existing strip: no such tab
 * yet, no editor pane in it (the open makes a NEW pane, which never evicts),
 * or the tab is already open SOMEWHERE in that view — `openEditorTab` raises
 * it there and touches no strip at all.
 */
export function evictionForOpen(root: ViewRoot, tab: EditorTab): Eviction | null {
  const v =
    root.kind === 'home'
      ? (state.views.find((x) => x.root?.kind === 'home') ?? null)
      : (state.views.find((x) => x.root?.kind === 'project' && x.root.id === root.id) ?? null);
  if (v === null) return null;
  const id = tabIdOf(tab);
  if (findTab(v, id) !== null) return null; // a raise, wherever it lives
  const target = targetEditorIndex(v);
  if (target === -1) return null; // a new pane has room for one tab by construction
  return evictionFor(v.id, target, id);
}

/**
 * Make room in a FULL strip for `tab`: the tab in the LAST position leaves
 * (B4 amendment — the user asked for a limit of four, and the limit had to
 * choose a victim; the orchestrator's choice is position 4, so the tabs the
 * user opened first stay where they are).
 *
 * A strip with room, or one that already holds this tab, is untouched — a
 * raise is not an add. The prune runs HERE, after the splice and before the
 * new tab arrives, because this is the one moment the evicted file has no tab
 * anywhere; the new tab is a different id and cannot be the one pruned.
 *
 * `ui/unsaved.ts` has already asked about `evictionFor(...).lostIds` by the
 * time this runs — the question may not live in the model, and the model may
 * not be the thing that decides to ask.
 */
function evictForAdd(s: EditorSlot, tab: EditorTab): void {
  if (s.tabs.length < MAX_TABS || stripHolds(s, tabIdOf(tab))) return;
  // To the END, not one tab: the strip is never longer than `MAX_TABS` (every
  // mutator goes through here and the reader caps too), and if a future one
  // ever leaked a longer strip in, the cap must still hold afterwards.
  s.tabs.splice(MAX_TABS - 1, s.tabs.length - MAX_TABS + 1);
  clampActive(s);
  pruneOrphanEdits();
}

/** Put `tab` in an editor pane's strip — raising it when it is already there. */
function addOrRaise(s: EditorSlot, tab: EditorTab): void {
  const id = tabIdOf(tab);
  const at = s.tabs.findIndex((t) => tabIdOf(t) === id);
  if (at === -1) {
    s.tabs.push(tab);
    s.active = s.tabs.length - 1;
  } else {
    s.active = at;
  }
}

/**
 * Open a file as a TAB of its root tab's editor pane, and go there. `label` is
 * the name the caller drew in its row — it says what the user clicked in the
 * log; the tab's own title is derived from the path (`tabTitle`), so no path
 * can reach a label by this route.
 *
 * A file already open ANYWHERE IN THAT VIEW is RAISED rather than opened twice
 * (pane focused, tab activated): the second click on a row must not spend the
 * tab's last pane — or another strip slot — on a copy. An explicit split
 * (`openTabAt`) may still put the same file in two panes; they share one entry
 * in `state.edits`.
 */
export function openFile(root: ViewRoot, path: string, label: string): OpenFileResult {
  return openEditorTab(viewForRoot(root), { kind: 'file', path }, `name=${label}`);
}

/**
 * Open the READ-ONLY changes to one file in one commit, as a tab of its root
 * tab's editor pane (user decision 8, 2026-09-15: the A6 `Changes in <hash>`
 * screen survives as a tab kind). The twin of `openFile`: a diff has no
 * unsaved text and no Save, and `tabIdOf` keeps the two id spaces apart.
 *
 * `requestRoot` IS THE FOLDER THE REQUEST IS MADE FROM — the same root the
 * Files panel asks git with (`openCommitAt.root`), which is what the backend's
 * boundary check accepts. It is deliberately NOT the repository root: that can
 * be an ancestor of every registered anchor (a project registered at `web/`
 * inside a repository), and a tab carrying it would answer the boundary
 * sentence for every diff it ever asks for.
 */
export function openDiff(
  root: ViewRoot,
  hash: string,
  path: string,
  requestRoot: string,
): OpenFileResult {
  return openEditorTab(
    viewForRoot(root),
    { kind: 'diff', hash, path, root: requestRoot },
    `commit=${hash}`,
  );
}

/** The shared body of `openFile`/`openDiff` — raise, else add, else new pane. */
function openEditorTab(v: ViewState, tab: EditorTab, what: string): OpenFileResult {
  const open = findTab(v, tabIdOf(tab));
  if (open !== null) {
    v.focused = open.slot;
    (v.slots[open.slot] as EditorSlot).active = open.tabIndex;
  } else {
    const target = targetEditorIndex(v);
    if (target !== -1) {
      // A FULL strip loses its last chip to make room (B4 amendment). The
      // question about unsaved text was asked before this call, by
      // `ui/unsaved.ts`'s guarded opener — `evictionFor` is the plan it read.
      evictForAdd(v.slots[target] as EditorSlot, tab);
      addOrRaise(v.slots[target] as EditorSlot, tab);
      v.focused = target;
    } else {
      if (v.slots.length >= MAX_PANES) return 'full';
      insertSlots(v, 0, 'fill', [newEditorSlot([tab])]);
    }
    log.debug(`editor tab opened: view=${v.id} panes=${v.slots.length} ${what}`);
  }
  state.activeViewId = v.id;
  saveUi();
  notify('ui');
  return 'ok';
}

/**
 * Put a tab at a PANE: `'replace'` is the pane's CENTRE — on an editor pane it
 * ADDS the tab to that strip and raises it (never replaces: a pane full of the
 * user's other files is not a thing a drop may throw away, orchestrator
 * default 4, A10b) — and a zone splits that pane into a NEW editor pane at its
 * edges. The centre of a TERMINAL pane is refused: `'session-centre'` is what
 * the caller flashes "drop on an edge to split" for (user decision 7).
 *
 * Replaces A10's `openFileAt`; the rename is on purpose, so `tsc` finds every
 * caller that still thinks a drop can replace a pane.
 */
export function openTabAt(
  viewId: string,
  slot: number,
  where: Zone | 'replace',
  tab: EditorTab,
): OpenFileResult {
  const v = state.views.find((x) => x.id === viewId);
  if (v === undefined) return 'no-view';
  const target = v.slots[slot];
  if (target === undefined) return 'no-view';
  if (where === 'replace') {
    if (target.kind === 'session') return 'session-centre';
    // Adding costs no PANE. It can cost the strip's last CHIP though, once the
    // strip is full (B4 amendment) — `evictForAdd` prunes what that orphans,
    // after `ui/unsaved.ts` asked about it.
    evictForAdd(target, tab);
    addOrRaise(target, tab);
    v.focused = slot;
  } else {
    if (v.slots.length + 1 > MAX_PANES) return 'full';
    if (!dropZonesFor(v, slot, 1).includes(where)) return 'no-zone';
    insertSlots(v, slot, where, [newEditorSlot([tab])]);
  }
  state.activeViewId = v.id;
  log.debug(`editor tab placed: view=${v.id} slot=${slot} at=${where} panes=${v.slots.length}`);
  saveUi();
  notify('ui');
  return 'ok';
}

/**
 * Move one tab from an editor pane to ANOTHER editor pane of the same view
 * (the drag onto a pane's centre, and the ctrl+alt+m twin).
 *
 * The target already holding that id RAISES it there instead of showing the
 * same file twice in one strip; either way the tab leaves the source, and a
 * source left with no tabs frees its pane. The target's `slotKey` is captured
 * BEFORE `removeAtSlot`, because the 2x2 remap moves slot INDICES around — the
 * pane the user dropped on is found again by key, never by the index they
 * started from.
 *
 * A FULL target is REFUSED with `'full'` and nothing moves (B4 amendment,
 * 2026-09-22) — a MOVE never evicts. `'full'` from this function means "that
 * strip already holds `MAX_TABS` files" and nothing else, which is why its two
 * callers (`ui/dnd.ts`'s drop, main.ts's ctrl+alt+m) say it with the strip's
 * own sentence instead of the pane-count one. A raise is not an add, so a
 * target that already shows the tab takes it however full it is.
 */
export function moveTab(
  viewId: string,
  fromSlot: number,
  tabIndex: number,
  toSlot: number,
): OpenFileResult {
  const v = state.views.find((x) => x.id === viewId);
  if (v === undefined || fromSlot === toSlot) return 'no-view';
  const from = v.slots[fromSlot];
  const to = v.slots[toSlot];
  if (from === undefined || from.kind !== 'editor') return 'no-view';
  if (to === undefined || to.kind !== 'editor') return 'no-view';
  const tab = from.tabs[tabIndex];
  if (tab === undefined) return 'no-view';
  if (to.tabs.length >= MAX_TABS && !stripHolds(to, tabIdOf(tab))) return 'full';

  const toKey = slotKey(to);
  addOrRaise(to, tab);
  from.tabs.splice(tabIndex, 1);
  if (from.tabs.length === 0) {
    removeAtSlot(v, fromSlot);
  } else {
    clampActive(from);
  }
  v.focused = Math.max(0, indexOfSlot(v, toKey));
  // ONCE, at the END: midway through the move the tab is on no pane at all,
  // and a prune there would eat the text the user is still looking at.
  pruneOrphanEdits();
  log.debug(`editor tab moved: view=${v.id} panes=${v.slots.length}`);
  saveUi();
  notify('ui');
  return 'ok';
}

/**
 * Move one tab out into a NEW editor pane beside `atSlot` (the drag onto a
 * pane's edge, and the ctrl+alt+m fallback).
 *
 * Capacity: a pane whose LAST tab leaves frees its own pane, so the split
 * costs nothing and a full tab still takes it — `'full'` only when the source
 * keeps other tabs. Both that and `'no-zone'` are measured on a PROBE of the
 * view as the drop will leave it, before a single real slot moves; the real
 * mutation then holds slot KEYS across the 2x2 remap. Focus lands on the new
 * pane (`insertSlots`).
 */
export function moveTabToSplit(
  viewId: string,
  fromSlot: number,
  tabIndex: number,
  atSlot: number,
  zone: Zone,
): OpenFileResult {
  const v = state.views.find((x) => x.id === viewId);
  if (v === undefined) return 'no-view';
  const from = v.slots[fromSlot];
  const at = v.slots[atSlot];
  if (from === undefined || from.kind !== 'editor') return 'no-view';
  if (at === undefined) return 'no-view';
  const tab = from.tabs[tabIndex];
  if (tab === undefined) return 'no-view';
  const keepsOthers = from.tabs.length > 1;
  // A pane's ONLY tab dragged to that same pane's edge would land beside a
  // pane that is about to disappear: nothing to do, and nothing to draw.
  if (!keepsOthers && fromSlot === atSlot) return 'no-zone';

  const atKey = slotKey(at);
  const probe: ViewState = { ...v, slots: [...v.slots] };
  if (!keepsOthers) removeAtSlot(probe, fromSlot);
  const probeAt = indexOfSlot(probe, atKey);
  if (probeAt === -1) return 'no-view';
  if (probe.slots.length + 1 > MAX_PANES) return 'full';
  if (!dropZonesFor(probe, probeAt, 1).includes(zone)) return 'no-zone';

  from.tabs.splice(tabIndex, 1);
  if (from.tabs.length === 0) removeAtSlot(v, fromSlot);
  else clampActive(from);
  insertSlots(v, Math.max(0, indexOfSlot(v, atKey)), zone, [newEditorSlot([tab])]);
  pruneOrphanEdits();
  log.debug(`editor tab split: view=${v.id} at=${zone} panes=${v.slots.length}`);
  saveUi();
  notify('ui');
  return 'ok';
}

/**
 * Close ONE tab of an editor pane. Its LAST tab takes the pane with it, down
 * the existing `closeSlot` ladder (an emptied project tab closes, Home stays,
 * a rootless tab dissolves) — user decision 3, A10b.
 *
 * `active` clamps to `min(active, len - 1)`: closing the tab the user is
 * looking at leaves them on the one that slid into its place, and closing the
 * LAST tab of the strip steps back one.
 */
export function closeTab(viewId: string, slot: number, tabIndex: number): boolean {
  const v = state.views.find((x) => x.id === viewId);
  if (v === undefined) return false;
  const s = v.slots[slot];
  if (s === undefined || s.kind !== 'editor') return false;
  if (tabIndex < 0 || tabIndex >= s.tabs.length) return false;
  if (s.tabs.length === 1) return closeSlot(viewId, slot);
  s.tabs.splice(tabIndex, 1);
  s.active = Math.min(s.active, s.tabs.length - 1);
  pruneOrphanEdits();
  log.debug(`editor tab closed: view=${v.id} tabs=${s.tabs.length}`);
  saveUi();
  notify('ui');
  return true;
}

/** Raise a tab by index (a click on its chip). Silent when it is already up. */
export function setActiveTab(viewId: string, slot: number, tabIndex: number): boolean {
  const v = state.views.find((x) => x.id === viewId);
  const s = v?.slots[slot];
  if (v === undefined || s === undefined || s.kind !== 'editor') return false;
  if (tabIndex < 0 || tabIndex >= s.tabs.length || s.active === tabIndex) return false;
  s.active = tabIndex;
  saveUi();
  notify('ui');
  return true;
}

/**
 * ctrl+alt+PageUp / PageDown: previous / next tab of the FOCUSED editor pane
 * of the active view, wrapping at both ends. A focused terminal pane answers
 * false and nothing moves — the chord belongs to the strip, not to the grid.
 */
export function cycleTab(dir: -1 | 1): boolean {
  const v = activeView();
  const s = v?.slots[v.focused];
  if (v === null || s === undefined || s.kind !== 'editor') return false;
  const n = s.tabs.length;
  if (n < 2) return false;
  return setActiveTab(v.id, v.focused, (s.active + dir + n) % n);
}

/**
 * Forget the unsaved text of every file no TAB shows any more (PROJECT-SCOPE:
 * it is dropped when the LAST pane showing that file closes — the same file in
 * two strips keeps sharing until both are gone). Called at the END of every
 * path that removes slots or tabs, never midway through a move, where a tab is
 * out of one pane on its way into another.
 */
function pruneOrphanEdits(): void {
  const live = new Set<string>();
  for (const v of state.views) {
    for (const s of v.slots) {
      if (s.kind !== 'editor') continue;
      // Only a FILE tab has unsaved text; a diff is read-only and never owns
      // an entry, so a `d:` key in the map is stale by definition.
      for (const t of s.tabs) if (t.kind === 'file') live.add(tabIdOf(t));
    }
  }
  for (const key of [...state.edits.keys()]) if (!live.has(key)) state.edits.delete(key);
}

/**
 * Close ONE pane — an editor pane, WITH ALL ITS TABS. A session pane is
 * refused here: ending a session is a different act with its own confirmation
 * (the A3 rule), and `removeSessionEverywhere` is the door for it.
 *
 * A PROJECT-rooted tab left with no panes at all is removed with its last
 * editor pane (user decision 6, 2026-09-15) — unless a terminal is still in
 * it, which is simply "it still has a pane". `Home` stays, empty. Focus lands
 * on a pane that exists.
 */
export function closeSlot(viewId: string, index: number): boolean {
  const v = state.views.find((x) => x.id === viewId);
  if (v === undefined) return false;
  const slot = v.slots[index];
  if (slot === undefined || slot.kind === 'session') return false;
  removeAtSlot(v, index);
  if (v.slots.length === 0 && !isHome(v)) dissolveView(v.id);
  pruneOrphanEdits();
  log.debug(`editor pane closed: view=${v.id} panes=${v.slots.length}`);
  saveUi();
  notify('ui');
  return true;
}

/**
 * The active tab index of one editor pane, or null when that slot is not an
 * editor pane (which is how ctrl+alt+w on a terminal answers "nothing to do").
 * Exported for `ui/unsaved.ts`, whose guarded closer has to know WHICH tab the
 * chord would close before it can ask about it.
 */
export function activeTabIndex(viewId: string, slot: number): number | null {
  const v = state.views.find((x) => x.id === viewId);
  const s = v?.slots[slot];
  if (s === undefined || s.kind !== 'editor') return null;
  return Math.min(Math.max(0, s.active), Math.max(0, s.tabs.length - 1));
}

/**
 * WHOSE UNSAVED TEXT WOULD THIS CLOSE THROW AWAY (part B4, user decision D1)?
 *
 * The answer is the whole premise of the question the user is asked, so it is
 * arithmetic here rather than a guess at the door: the dirty FILE ids among the
 * tabs the operation removes that NO OTHER SURVIVING TAB shows — anywhere in
 * the app, because `state.edits` is keyed by the file and two panes on one file
 * share one text (`pruneOrphanEdits`). Closing one of them loses nothing.
 *
 * Three forms, one per door:
 *   dirtyLostBy(view, slot, tab)  one file tab (a chip's `×`, ctrl+alt+w)
 *   dirtyLostBy(view, slot)       a whole editor pane (the pane's `×`)
 *   dirtyLostBy(view)             a whole tab (the strip's `×`)
 *
 * Pure: it reads state and changes nothing. A diff tab can never appear in the
 * answer — it is read-only and owns no entry by construction.
 */
export function dirtyLostBy(viewId: string, slot?: number, tab?: number): string[] {
  const lost: string[] = [];
  const kept = new Set<string>();
  for (const v of state.views) {
    for (let i = 0; i < v.slots.length; i++) {
      const s = v.slots[i] as PaneSlot;
      if (s.kind !== 'editor') continue;
      for (let t = 0; t < s.tabs.length; t++) {
        const entry = s.tabs[t] as EditorTab;
        if (entry.kind !== 'file') continue;
        const id = tabIdOf(entry);
        const goes =
          v.id === viewId &&
          (slot === undefined || (i === slot && (tab === undefined || t === tab)));
        if (!goes) {
          kept.add(id);
        } else if (editorDirty(id) && !lost.includes(id)) {
          lost.push(id);
        }
      }
    }
  }
  return lost.filter((id) => !kept.has(id));
}

// --------------------------------------------------------------------------
// Unsaved file text (A6, rekeyed by A10): one entry per FILE, not per tab
// --------------------------------------------------------------------------

/**
 * Record what the user typed, under the tab id `f:<path>`. NO notify: the
 * textarea already shows the text, and a rebuild per keystroke would take the
 * caret with it — the file pane updates its own gutter and Save button in
 * place and asks for a chrome rebuild only when the DIRTY flag flips.
 */
export function setEdit(id: string, text: string): void {
  state.edits.set(id, text);
}

/** Is this file holding unsaved text? */
export function editorDirty(id: string | null): boolean {
  return id !== null && state.edits.has(id);
}

/** The unsaved text of a file, or undefined when it has none. */
export function editText(id: string): string | undefined {
  return state.edits.get(id);
}

/**
 * Save: forget the unsaved text and hand it back. It is called by the file
 * pane when the WRITE HAS LANDED (part B4) and by `Load from disk`, which
 * drops the same entry because the user chose the bytes on disk over their
 * own. A refused write changes nothing here: the text stays unsaved until it
 * is really on disk. Saving a clean file returns null and changes nothing.
 *
 * WHAT STANDS BETWEEN AN ENTRY AND NOTHING (user decision D1, 2026-09-22):
 * every door that would orphan one asks first — `ui/unsaved.ts` guards the
 * chip `×`, the pane `×`, ctrl+alt+w and a whole tab's `×`, and `beforeunload`
 * guards a reload and a window close. ONE door has no question and is a known
 * limit: the backend's grace timer ending the app after the last window
 * closed, where there is no window left to ask in.
 */
export function saveEdit(id: string): string | null {
  const text = state.edits.get(id);
  if (text === undefined) return null;
  state.edits.delete(id);
  // 'ui', not 'screen' (A10): a file is a PANE now, so what the save changed is
  // the pane header's dot and the tab chip — both of them pane-area chrome.
  notify('ui');
  return text;
}

/**
 * A file or folder was RENAMED in the Files panel (part B13, user decision D3):
 * every `file` tab at or under `from` now points at the same place under `to`,
 * in every view and every editor pane, and the unsaved text of each moves with
 * it (`f:<old>` -> `f:<new>`) — B4's rule that unsaved text is never dropped
 * silently holds across a rename too.
 *
 * DIFF TABS ARE LEFT ALONE: a diff names a file inside a COMMIT, which a rename
 * on disk does not change. The rewrite itself is `remapPath` — the one
 * at-or-under rule with a separator boundary, so a sibling that only shares a
 * prefix (`/a/bc` next to a renamed `/a/b`) keeps its tab.
 *
 * DEDUPED PER STRIP: a strip that ends up holding one file twice keeps the
 * first, and `active` follows the tab it was on. Caret and scroll position are
 * lost — the pane body is rebuilt for the new id (recorded, D3). Answers
 * whether anything changed; nothing changed means no notify.
 */
export function retargetFiles(from: string, to: string): boolean {
  if (from === to) return false;
  // NEVER OVERWRITE UNSAVED TEXT (B4). A dirty file whose new path ALREADY has
  // unsaved text of its own (a tab still open on a file deleted outside the
  // app) does not move: its tab stays on the old path with its text, and the
  // other text stays where it is. The panel refuses such a rename before it is
  // sent (`hasUnsavedAt`); this is the defensive half.
  const blocked = new Set<string>();
  for (const key of state.edits.keys()) {
    if (tabKind(key) !== 'file') continue;
    const path = filePathOf(key);
    const next = remapPath(path, from, to);
    if (next !== path && state.edits.has(fileTabId(next))) blocked.add(path);
  }
  const follow = (path: string): string => (blocked.has(path) ? path : remapPath(path, from, to));
  let changed = false;
  for (const v of state.views) {
    for (const s of v.slots) {
      if (s.kind !== 'editor') continue;
      const before = s.tabs;
      if (!before.some((t) => t.kind === 'file' && follow(t.path) !== t.path)) continue;
      changed = true;
      const wasActive = Math.min(Math.max(0, s.active), before.length - 1);
      const tabs: EditorTab[] = [];
      let active = 0;
      before.forEach((t, i) => {
        const next: EditorTab =
          t.kind === 'file' ? { kind: 'file', path: follow(t.path) } : t;
        const id = tabIdOf(next);
        const at = tabs.findIndex((x) => tabIdOf(x) === id);
        if (at === -1) tabs.push(next);
        if (i === wasActive) active = at === -1 ? tabs.length - 1 : at;
      });
      s.tabs = tabs;
      s.active = active;
      clampActive(s);
    }
  }
  for (const [key, text] of [...state.edits]) {
    if (tabKind(key) !== 'file') continue;
    const path = filePathOf(key);
    const next = follow(path);
    if (next === path) continue;
    changed = true;
    state.edits.delete(key);
    state.edits.set(fileTabId(next), text);
  }
  if (!changed) return false;
  log.debug('editor tabs followed a rename');
  saveUi();
  notify('ui');
  return true;
}

/** The key a file at `path` is edited under — one spelling for every caller. */
export function editorFileId(path: string): string {
  return fileTabId(path);
}

// Shared with the sibling pieces (O8 split glue); not part of the public face.
export { pruneOrphanEdits };
