/**
 * The state the chrome around the panes reads: pane focus and in-view
 * movement, the split dividers, the attention aggregates, the drawers and the
 * Files panel, the commit view that covers the pane area, and the
 * connection readouts (statusline + topbar dot).
 *
 * Split from `state.ts` (O8, 2026-09-23).
 * Siblings: `state-core.ts` (types, the store, pub/sub), `state-persist.ts`
 * (view constructors, localStorage save/load), `state-views.ts` (slot geometry,
 * view membership, server state, tabs), `state-editor.ts` (files as tabs of an
 * editor pane, unsaved text), `state-chrome.ts` (focus, drawers and the Files
 * panel, the commit view, connection readouts). `state.ts` re-exports them all.
 */
import type { RuntimeStatusResponse } from '../../shared/protocol.ts';
import { log } from './log.ts';
import { collapseKey } from './ui/commit-model.ts';
import { sessionReadout } from './ui/session-state.ts';
import {
  type Dir,
  type DrawerView,
  type LeftPanel,
  type PaneSlot,
  type ViewState,
  sessionIds,
  clampFilesWidth,
  state,
  notify,
} from './state-core.ts';
import { clampSplit, saveUi } from './state-persist.ts';
import { activeView, viewLayout } from './state-views.ts';

// --------------------------------------------------------------------------
// Focus + in-view movement
// --------------------------------------------------------------------------

export function focusPane(i: number): void {
  const v = activeView();
  if (v === null) return;
  if (i >= 0 && i < viewLayout(v) && v.focused !== i) {
    v.focused = i;
    saveUi();
    notify('ui');
  }
}

/**
 * Spatial neighbors per (count, l3):
 *   2: [0|1]     3L: [0|1/2] (0 tall)     3R: [0/1|2] (2 tall)     4: [0|1 / 2|3]
 */
function neighbors(v: ViewState): Partial<Record<Dir, number>>[] {
  const n = v.slots.length;
  if (n === 2) return [{ right: 1 }, { left: 0 }];
  if (n === 3) {
    return v.l3 === 'L'
      ? [{ right: 1 }, { left: 0, down: 2 }, { left: 0, up: 1 }]
      : [{ down: 1, right: 2 }, { up: 0, right: 2 }, { left: 0 }];
  }
  if (n === 4) {
    return [
      { right: 1, down: 2 },
      { left: 0, down: 3 },
      { right: 3, up: 0 },
      { left: 2, up: 1 },
    ];
  }
  return [{}];
}

export function moveFocus(dir: Dir): void {
  const v = activeView();
  if (v === null) return;
  const target = neighbors(v)[v.focused]?.[dir];
  if (target !== undefined) focusPane(target);
}

/**
 * Ctrl+Alt+Shift+Arrow: move the FOCUSED PANE to the neighbor pane WITHIN its
 * view (swap when occupied — panes always are). Kind-blind: a file and a
 * terminal trade places like two terminals. Focus follows the moved pane.
 */
export function movePane(dir: Dir): void {
  const v = activeView();
  if (v === null || v.slots[v.focused] === undefined) return;
  const target = neighbors(v)[v.focused]?.[dir];
  if (target !== undefined) swapPanes(v.id, v.focused, target);
}

/** Swap two pane slots (chord move + header drag onto a pane). Kind-blind. */
export function swapPanes(viewId: string, from: number, to: number): void {
  const v = state.views.find((v) => v.id === viewId);
  if (v === undefined || from === to) return;
  const n = v.slots.length;
  if (from < 0 || to < 0 || from >= n || to >= n) return;
  const a = v.slots[from] as PaneSlot;
  v.slots[from] = v.slots[to] as PaneSlot;
  v.slots[to] = a;
  if (v.id === state.activeViewId) v.focused = to;
  saveUi();
  notify('ui');
}

/**
 * Adjust a divider fraction of the active view. During a pointer drag the
 * caller applies grid styles directly and passes commit=false (no persist,
 * no notify); commit=true persists and notifies (drag end / keyboard nudge).
 * Returns the clamped value.
 */
export function setSplit(axis: 'col' | 'row', f: number, commit: boolean): number {
  const v = activeView();
  const clamped = clampSplit(f);
  if (v === null) return clamped;
  v.split[axis] = clamped;
  if (commit) {
    saveUi();
    notify('ui');
  }
  return clamped;
}

// --------------------------------------------------------------------------
// Aggregates + drawer
// --------------------------------------------------------------------------

/** Is a SESSION in this tab waiting for an answer? Files never ask for one. */
export function viewAttention(v: ViewState): boolean {
  return sessionIds(v).some((id) => state.sessions.get(id)?.attention === true);
}

/**
 * Tab status accent, from the sessions in it (Nocturne B11 — the same readout
 * as the pane dot, `ui/session-state.ts`): amber pulsing attention > amber
 * still waiting > green pulsing working > green still running (no turn
 * readout) > grey exited, and `'none'` for a tab holding no session at all
 * (Home, or a folder tab showing only files) — a status dot there would report
 * on nothing. The values are the dot's class suffix (`dot is-${status}`).
 */
export function viewStatus(v: ViewState): 'attn' | 'wait' | 'work' | 'run' | 'exit' | 'none' {
  const ids = sessionIds(v);
  if (ids.length === 0) return 'none';
  const found = new Set<string>();
  for (const id of ids) {
    const s = state.sessions.get(id);
    // A slot whose session is not in the list reports nothing (as before B11).
    if (s !== undefined) found.add(sessionReadout(s));
  }
  if (found.has('attn')) return 'attn';
  if (found.has('waiting')) return 'wait';
  if (found.has('working')) return 'work';
  if (found.has('running')) return 'run';
  return 'exit';
}

/**
 * Sessions with a BEL pending — what the statusline's `N waiting for you` and
 * the top bar's Sessions badge show. BEL-only on purpose: a session whose
 * Claude merely ended its turn (B11 'Waiting for you') shows that on its own
 * pane and is not counted (user, 2026-09-22, on the B11 check).
 */
export function attentionCount(): number {
  let n = 0;
  for (const s of state.sessions.values()) if (s.attention) n++;
  return n;
}


/**
 * Toggle a drawer. Opening 'projects' HIDES the Files panel for as long as it
 * is open (`filesPanelVisible()`), and closing it brings Files back — the wish
 * itself is never written here, so peeking at Projects can never cost the user
 * their default panel. One `'drawer'` notify is enough for both: main.ts
 * subscribes ONE kind-agnostic listener that runs `updateChrome()` and
 * `filesPanel.render()` on every change, so a second `'panel'` notify would
 * only rebuild the same chrome twice.
 */
export function toggleDrawer(view: Exclude<DrawerView, null>): void {
  state.drawer = state.drawer === view ? null : view;
  notify('drawer');
}

/** Open (never close) a drawer — the empty state's "Resume a session". */
export function openDrawer(view: Exclude<DrawerView, null>): void {
  if (state.drawer !== view) {
    state.drawer = view;
    notify('drawer');
  }
}

/**
 * Toggle the Files panel. Opening it CLOSES the projects drawer: both live on
 * the left, and two left panels at once leaves the terminal — the hero — a
 * strip. Only ONE left panel is ever on screen (user decision 2026-09-15,
 * deviates from v3, which let the two sit side by side).
 *
 * That is why "opening" is not just `leftPanel !== panel`: while Projects is
 * covering a wanted Files panel, the button the user presses must SHOW Files
 * (close Projects, keep the wish) rather than flip a wish they cannot see off.
 * Closing Files leaves every drawer alone.
 */
export function toggleLeftPanel(panel: Exclude<LeftPanel, null>): void {
  const opening = state.leftPanel !== panel || state.drawer === 'projects';
  state.leftPanel = opening ? panel : null;
  if (opening && state.drawer === 'projects') {
    state.drawer = null;
    notify('drawer');
  }
  saveUi();
  notify('panel');
}

/**
 * Set the Files panel width (clamped). `commit` false is the live drag: the
 * caller has already styled the element and a notify per pointermove would
 * rebuild chrome 60 times a second for a number nothing else reads.
 */
export function setFilesWidth(px: number, commit = true): number {
  const w = clampFilesWidth(px);
  state.filesWidth = w;
  // A live drag neither notifies nor writes: the same reason, sixty times a
  // second. The commit at the end of the gesture is what reaches storage.
  if (commit) {
    saveUi();
    notify('panel');
  }
  return w;
}

/**
 * Is the Files panel on screen: the user wants it AND the Projects drawer is
 * not borrowing the left side. A session is not part of the question — the
 * panel opens with nothing running and its header says `Home` (user decision
 * 2026-09-15, deviates from v3's `leftPanel === 'files' && alive.length > 0`).
 *
 * The drawer hides it without touching the wish, so closing Projects brings
 * the panel back by itself.
 */
export function filesPanelVisible(): boolean {
  return state.leftPanel === 'files' && state.drawer !== 'projects';
}

export function closeDrawer(): void {
  if (state.drawer !== null) {
    state.drawer = null;
    notify('drawer');
  }
}

// --------------------------------------------------------------------------
// The pane area's other occupant (Nocturne A6): the commit view
// --------------------------------------------------------------------------
//
// It is not persisted and it owns no session. It decides WHAT FILLS THE MIDDLE
// ROW — something OTHER than the panes — which is why every change here
// notifies `'screen'` and why the chrome, never the panes themselves, reads
// it. Since A10 the editor column is NOT in this group: a file is a pane, so
// opening one notifies `'ui'` like any other pane change.

/**
 * Open the full commit view over the pane area, for the commit `hash` in the
 * repository the Files panel is standing in (`at`, see `openCommitAt`).
 */
export function openCommitView(
  hash: string,
  at: { root: string; repoRoot: string | null },
): void {
  if (state.openCommit === hash) return;
  state.openCommit = hash;
  state.openCommitAt = at;
  // A newly opened commit starts fully expanded: the collapse set is per
  // `<hash>:<path>`, so stale keys from an earlier commit can never hide a
  // block in this one, and dropping them keeps the set from growing forever.
  // (Part B3 folds everything past the first ten the moment the commit
  // answers — see `seedCommitCollapsed`; until then there is nothing to fold.)
  state.commitCollapsed = new Set();
  notify('screen');
}

/** Close it: the panes come back. Safe to call when nothing is open. */
export function closeCommitView(): void {
  if (state.openCommit === null) return;
  state.openCommit = null;
  state.openCommitAt = null;
  state.commitCollapsed = new Set();
  notify('screen');
}

/**
 * Fold these blocks, once, on the render that first draws a commit's file list
 * (part B3: everything past the first ten, so a 200-file commit does not fire
 * 200 requests and does not open 200 blocks nobody asked for).
 *
 * IT DOES NOT NOTIFY, on purpose: it is called from inside the very render
 * that is about to draw the folds, and a notification there would be a render
 * loop. Every LATER change to the set goes through `toggleCommitFile`, which
 * does notify.
 */
export function seedCommitCollapsed(keys: readonly string[]): void {
  state.commitCollapsed = new Set(keys);
}

/**
 * The repository behind the open commit, learned late (part B3). The Changes
 * answer for the SAME root is what carries it; a commit opened before that
 * answer landed is fully readable, and this is what turns its `Open file`
 * from "waiting" into a control — so it notifies, exactly once, when it
 * really fills that gap.
 */
export function noteCommitRepoRoot(root: string, repoRoot: string): void {
  const at = state.openCommitAt;
  if (at === null || at.root !== root || at.repoRoot !== null) return;
  state.openCommitAt = { root: at.root, repoRoot };
  notify('screen');
}

/** Is this file's diff block folded away inside the open commit? */
export function commitFileCollapsed(hash: string, path: string): boolean {
  return state.commitCollapsed.has(collapseKey(hash, path));
}

/** Fold / unfold one file's diff block (the panel row and the block agree). */
export function toggleCommitFile(hash: string, path: string): void {
  const key = collapseKey(hash, path);
  if (state.commitCollapsed.has(key)) state.commitCollapsed.delete(key);
  else state.commitCollapsed.add(key);
  notify('screen');
}

// --------------------------------------------------------------------------
// Connection readouts (statusline + topbar dot)
// --------------------------------------------------------------------------

/** Presence pong round-trip; null on presence-socket loss. */
export function setWsLatency(ms: number | null): void {
  if (state.wsLatencyMs !== ms) {
    state.wsLatencyMs = ms;
    notify('conn');
  }
}

/**
 * Whole `GET /api/runtime` answer: boot time, the commit the process runs, the
 * bundle version and installed flag (2026-09-08), and the live update check.
 * One setter so the readouts (statusline uptime, settings version, the
 * releases link, update notice) can never disagree about which poll they came
 * from.
 */
export function setRuntime(r: RuntimeStatusResponse): void {
  // The RELEASE version counts as a change too (phase E): a second release can
  // be published under the same reason, and the toast that names a version must
  // not keep naming the older one.
  const updateChanged =
    state.update?.available !== r.update?.available ||
    state.update?.reason !== r.update?.reason ||
    state.update?.release?.version !== r.update?.release?.version;
  const changed =
    state.serverStartedAt !== r.startedAt ||
    state.serverCommit !== r.serverCommit ||
    state.version !== r.version ||
    state.installed !== r.installed ||
    updateChanged;
  state.serverStartedAt = r.startedAt;
  state.serverCommit = r.serverCommit;
  state.version = r.version ?? null;
  state.installed = r.installed === true;
  state.update = r.update ?? null;
  if (changed) notify('conn');
}

/**
 * Arm/disarm the restart gap. Every guard reads `state.restarting` directly;
 * this setter exists so the transition is one notified event (the topbar dot
 * and statusline stop shouting "offline" during a handover we asked for).
 */
export function setRestarting(v: boolean): void {
  if (state.restarting !== v) {
    state.restarting = v;
    // The client-log transport gets the same treatment as the polls: a flush
    // landing on the CHILD would be answered 401 and turn logging off for the
    // rest of this page's life.
    if (v) log.hold();
    else log.resume();
    notify('conn');
  }
}

/**
 * Poll-driven backend health: repeated poll failures flip it false, the
 * first success (or presence pong) flips it back. 401/403 escalates to the
 * full-page reload panel instead (main.ts).
 */
export function setBackendReachable(ok: boolean): void {
  if (state.backendReachable !== ok) {
    state.backendReachable = ok;
    notify('conn');
  }
}
