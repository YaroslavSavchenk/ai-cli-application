/**
 * The views (= tabs): slot geometry for the fixed split shapes, the "every
 * session lives in exactly one view" invariant, the server-state mirror
 * (sessions, history, projects) and the tab operations (activate, move,
 * merge, extract).
 *
 * Split from `state.ts` (O8, 2026-09-23).
 * Siblings: `state-core.ts` (types, the store, pub/sub), `state-persist.ts`
 * (view constructors, localStorage save/load), `state-views.ts` (slot geometry,
 * view membership, server state, tabs), `state-editor.ts` (files as tabs of an
 * editor pane, unsaved text), `state-chrome.ts` (focus, drawers and the Files
 * panel, the commit view, connection readouts). `state.ts` re-exports them all.
 */
import type { HistoryEntry, Project, SessionInfo } from '../../shared/protocol.ts';
import { log } from './log.ts';
import {
  type Layout,
  type Zone,
  MAX_PANES,
  type PaneSlot,
  type ViewState,
  slotKey,
  state,
  notify,
} from './state-core.ts';
import {
  newSessionView,
  saveUi,
  normalizeActive,
  isHome,
  ensureHomeView,
  firstMovableIndex,
} from './state-persist.ts';
import { pruneOrphanEdits } from './state-editor.ts';

// --------------------------------------------------------------------------
// View geometry: slot insertion / removal for the fixed split shapes
// --------------------------------------------------------------------------

/** Index of a slot inside a view, by KEY — never by `indexOf` on a raw string. */
function indexOfSlot(v: ViewState, key: string): number {
  return v.slots.findIndex((s) => slotKey(s) === key);
}

/**
 * Insert panes into a view at (slot, zone). Kind-blind: an editor pane splits
 * a terminal's pane exactly the way a terminal splits it. A single insert splits
 * the dropped-on pane; multi-item (merging a split tab) and 'fill' append in
 * order. The caller has already checked capacity and detached the items from
 * other views. Focus lands on the first inserted pane.
 */
function insertSlots(v: ViewState, slot: number, zone: Zone, items: PaneSlot[]): void {
  const first = items[0];
  if (first === undefined) return;
  const s = v.slots;
  const n = s.length;
  if (n === 0 || items.length > 1 || zone === 'fill' || n + items.length > MAX_PANES) {
    // n === 0 is a ROOTED view standing empty (A10): there is no pane to split,
    // so the first one simply lands.
    v.slots = [...s, ...items].slice(0, MAX_PANES);
  } else if (n === 1) {
    v.slots = zone === 'left' ? [first, s[0] as PaneSlot] : [s[0] as PaneSlot, first];
  } else if (n === 2) {
    const [a, b] = s as [PaneSlot, PaneSlot];
    if (slot === 0) {
      // Split the left pane vertically: tall pane moves to the right column.
      v.l3 = 'R';
      v.slots = zone === 'top' ? [first, a, b] : [a, first, b];
    } else {
      v.l3 = 'L';
      v.slots = zone === 'top' ? [a, first, b] : [a, b, first];
    }
  } else {
    // n === 3: only the tall pane can split (into the 2x2).
    const [a, b, c] = s as [PaneSlot, PaneSlot, PaneSlot];
    v.slots =
      v.l3 === 'L'
        ? zone === 'top'
          ? [first, b, a, c]
          : [a, b, first, c]
        : zone === 'top'
          ? [a, first, b, c]
          : [a, c, b, first];
  }
  v.focused = Math.max(0, indexOfSlot(v, slotKey(first)));
}

/** Remove the pane at `slot`, remapping the 2x2 into the right 3-variant. */
function removeAtSlot(v: ViewState, slot: number): void {
  const s = v.slots;
  const focusKey = s[v.focused] !== undefined ? slotKey(s[v.focused] as PaneSlot) : null;
  if (s.length === 4) {
    const [a, b, c, d] = s as [PaneSlot, PaneSlot, PaneSlot, PaneSlot];
    // Removing from the left column leaves the right column stacked (L);
    // removing from the right column leaves the left column stacked (R).
    if (slot === 0) {
      v.slots = [c, b, d];
      v.l3 = 'L';
    } else if (slot === 2) {
      v.slots = [a, b, d];
      v.l3 = 'L';
    } else if (slot === 1) {
      v.slots = [a, c, d];
      v.l3 = 'R';
    } else {
      v.slots = [a, c, b];
      v.l3 = 'R';
    }
  } else {
    v.slots = s.filter((_, i) => i !== slot);
  }
  const keep = focusKey !== null ? indexOfSlot(v, focusKey) : -1;
  v.focused = keep >= 0 ? keep : Math.min(Math.max(0, slot), Math.max(0, v.slots.length - 1));
}

/** Drop-zone kinds available on a slot of a view for a drag of `count` panes. */
export function dropZonesFor(v: ViewState, slot: number, count: number): Zone[] {
  const n = v.slots.length;
  // A ROOTED view may stand empty (A10) — there is no pane to anchor a zone to,
  // and its empty state takes the drop instead.
  if (n === 0) return [];
  if (n + count > MAX_PANES) return [];
  if (count > 1) return ['fill'];
  if (n === 1) return ['left', 'right'];
  if (n === 2) return ['top', 'bottom'];
  // n === 3: only the tall pane has room left in the 2x2.
  return slot === (v.l3 === 'L' ? 0 : 2) ? ['top', 'bottom'] : [];
}

// --------------------------------------------------------------------------
// View membership: the "every session has exactly one view" invariant
// --------------------------------------------------------------------------

export function viewOfSession(sessionId: string): ViewState | undefined {
  const key = slotKey({ kind: 'session', id: sessionId });
  return state.views.find((v) => indexOfSlot(v, key) !== -1);
}

/**
 * Remove a view. `Home` is refused: it is the fixed first tab and stands empty
 * rather than disappearing (user decision 2026-09-15, decision 4). Keeps
 * active valid.
 */
function dissolveView(id: string): void {
  const idx = state.views.findIndex((v) => v.id === id);
  if (idx === -1) return;
  if (isHome(state.views[idx] as ViewState)) return;
  state.views.splice(idx, 1);
  if (state.views.length === 0) {
    state.activeViewId = '';
  } else if (!state.views.some((v) => v.id === state.activeViewId)) {
    state.activeViewId = (state.views[Math.min(idx, state.views.length - 1)] as ViewState).id;
  }
}

/**
 * Pull a session out of whatever view holds it. A ROOTLESS view emptied this
 * way dissolves (today's rule); a rooted one stays — the folder tab is about
 * the folder, not about what happens to be open in it.
 */
function detachFromViews(sessionId: string): void {
  const v = viewOfSession(sessionId);
  if (v === undefined) return;
  removeAtSlot(v, indexOfSlot(v, slotKey({ kind: 'session', id: sessionId })));
  if (v.slots.length === 0 && v.root === null) dissolveView(v.id);
}

/**
 * Reconcile views with server sessions: prune SESSION slots the server no
 * longer has (skipping `skipViewId` — the active view's slots are left to
 * their sockets, which surface a structural "gone" note instead of silently
 * vanishing), and give any unassigned session its own tab (not activated).
 * Returns whether anything structural changed.
 *
 * Editor slots are never touched here: a path is not a session id, and a
 * terminal exiting is no reason for the files beside it to vanish. A ROOTED
 * view emptied this way is not dissolved either.
 */
export function reconcileViews(skipViewId?: string): boolean {
  let changed = ensureHomeView();
  for (const v of [...state.views]) {
    if (v.id === skipViewId) continue;
    for (let i = v.slots.length - 1; i >= 0; i--) {
      const s = v.slots[i] as PaneSlot;
      if (s.kind === 'session' && !state.sessions.has(s.id)) {
        removeAtSlot(v, i);
        changed = true;
      }
    }
    if (v.slots.length === 0 && v.root === null) {
      dissolveView(v.id);
      changed = true;
    }
  }
  for (const id of state.sessions.keys()) {
    if (viewOfSession(id) === undefined) {
      state.views.push(newSessionView(id));
      changed = true;
    }
  }
  if (changed) {
    normalizeActive();
    saveUi();
  }
  return changed;
}

// --------------------------------------------------------------------------
// Server state
// --------------------------------------------------------------------------

export function initServer(projects: Project[], sessions: SessionInfo[]): void {
  state.projects = projects;
  state.sessions = new Map(sessions.map((s) => [s.id, s]));
}

/** Full refresh from GET /api/sessions. */
export function setSessions(list: SessionInfo[]): void {
  state.sessions = new Map(list.map((s) => [s.id, s]));
  const changed = reconcileViews(state.activeViewId);
  notify('sessions');
  if (changed) notify('ui');
}

/** Upsert a session; if it has no view yet, it gets its own tab (not activated). */
export function upsertSession(s: SessionInfo): void {
  state.sessions.set(s.id, s);
  if (viewOfSession(s.id) === undefined) {
    state.views.push(newSessionView(s.id));
    saveUi();
    notify('ui');
  }
  notify('sessions');
}

export function setAttention(id: string, value: boolean): void {
  const s = state.sessions.get(id);
  if (s !== undefined && s.attention !== value) {
    s.attention = value;
    notify('sessions');
  }
}

/**
 * The user LOOKED at this session (the `seen` ack, sent by ui/panes.ts): the
 * local copy drops what the server drops on the same ack — `attention` — so
 * the next render does not wait for a poll to agree. `turnEnded` (Nocturne
 * C1) survives a look (user, 2026-09-22), and so does `pendingSince` while it
 * is set: the session is still pending for the peek mascot.
 */
export function markSeenLocally(id: string): void {
  const s = state.sessions.get(id);
  if (s === undefined || !s.attention) return;
  s.attention = false;
  if (s.turnEnded !== true) delete s.pendingSince;
  notify('sessions');
}

export function markExited(id: string, exitCode: number): void {
  const s = state.sessions.get(id);
  if (s !== undefined) {
    s.status = 'exited';
    s.exitCode = exitCode;
    notify('sessions');
  }
}

/** Local echo of a resize we sent; the poll will confirm from the server. */
export function setSessionDims(id: string, cols: number, rows: number): void {
  const s = state.sessions.get(id);
  if (s !== undefined && (s.cols !== cols || s.rows !== rows)) {
    s.cols = cols;
    s.rows = rows;
    notify('sessions');
  }
}

/** After DELETE: remove the session; its view slot closes (view dissolves when emptied). */
export function removeSessionEverywhere(id: string): void {
  state.sessions.delete(id);
  detachFromViews(id);
  saveUi();
  notify('sessions');
  notify('ui');
}

/** Replace the session history (boot load and every refetch). */
export function setHistory(list: HistoryEntry[]): void {
  state.history = list;
  notify('sessions');
}

/** Drop one entry (after forget). */
export function removeHistory(id: string): void {
  const next = state.history.filter((h) => h.id !== id);
  if (next.length !== state.history.length) {
    state.history = next;
    notify('sessions');
  }
}

/** Drop every entry (forget all). */
export function clearHistory(): void {
  if (state.history.length > 0) {
    state.history = [];
    notify('sessions');
  }
}

export function setProjects(list: Project[]): void {
  state.projects = list;
  notify('projects');
}

export function projectName(projectId: string | undefined): string | null {
  if (projectId === undefined) return null;
  const p = state.projects.find((p) => p.id === projectId);
  return p !== undefined ? p.name : null;
}

// --------------------------------------------------------------------------
// UI state: tabs (views)
// --------------------------------------------------------------------------

/** The active view — null when no views exist (the empty state). */
export function activeView(): ViewState | null {
  const v = state.views.find((v) => v.id === state.activeViewId);
  return v ?? state.views[0] ?? null;
}

/**
 * Visible pane count of a view (1..4). A view with ZERO slots has no layout to
 * speak of — the caller draws its empty state instead and never asks.
 */
export function viewLayout(v: ViewState): Layout {
  return Math.min(MAX_PANES, Math.max(1, v.slots.length)) as Layout;
}

/**
 * Structural tab close (no killing — callers kill sessions first if asked to).
 * `Home` is never closed (user decision 2026-09-15, decision 4).
 */
export function closeView(id: string): void {
  const v = state.views.find((x) => x.id === id);
  if (v === undefined || isHome(v)) return;
  log.debug(`tab closed: view=${id}`);
  dissolveView(id);
  pruneOrphanEdits();
  saveUi();
  notify('ui');
}

export function setActiveView(id: string): void {
  if (state.activeViewId !== id && state.views.some((v) => v.id === id)) {
    log.debug(`tab active: view=${id}`);
    state.activeViewId = id;
    saveUi();
    notify('ui');
  }
}

export function setActiveViewIndex(i: number): void {
  const v = state.views[i];
  if (v !== undefined) setActiveView(v.id);
}

/** Activate the tab holding this session and focus its pane (drawer attach). */
export function focusSession(sessionId: string): void {
  const v = viewOfSession(sessionId);
  if (v === undefined) return;
  v.focused = Math.max(0, indexOfSlot(v, slotKey({ kind: 'session', id: sessionId })));
  state.activeViewId = v.id;
  saveUi();
  notify('ui');
}

/**
 * Keyboard twin of the reorder drag (ctrl+alt+shift+pgup/pgdn): move the
 * active tab one strip position left/right. No-op at the strip ends, and on
 * `Home` — which never moves and never lets another tab past it.
 */
export function moveActiveViewBy(delta: -1 | 1): void {
  const from = state.views.findIndex((v) => v.id === state.activeViewId);
  if (from === -1) return;
  reorderView(state.activeViewId, delta === -1 ? from - 1 : from + 2);
}

/**
 * Move a view to a new strip position (tab drag onto strip space). `Home`
 * itself never moves, and no view is ever placed before it.
 */
export function reorderView(id: string, toIndex: number): void {
  const from = state.views.findIndex((v) => v.id === id);
  if (from === -1) return;
  if (isHome(state.views[from] as ViewState)) return;
  let to = Math.min(Math.max(firstMovableIndex(), toIndex), state.views.length);
  if (to > from) to--;
  if (to < firstMovableIndex()) to = firstMovableIndex();
  if (to === from) return;
  const [v] = state.views.splice(from, 1);
  state.views.splice(to, 0, v as ViewState);
  saveUi();
  notify('ui');
}

export type MergeResult = 'ok' | 'full' | 'no';

/**
 * Drag-to-split: dissolve view `sourceId` and insert its panes into view
 * `targetId` at (slot, zone). 'full' when the result would exceed 4 panes.
 * `Home` is never the SOURCE — it is never dissolved, and emptying it by drag
 * would leave the user's fixed first tab blank without them closing anything.
 */
export function mergeViews(targetId: string, sourceId: string, slot: number, zone: Zone): MergeResult {
  const target = state.views.find((v) => v.id === targetId);
  const source = state.views.find((v) => v.id === sourceId);
  if (target === undefined || source === undefined || targetId === sourceId) return 'no';
  if (isHome(source)) return 'no';
  if (target.slots.length + source.slots.length > MAX_PANES) return 'full';
  const items = [...source.slots];
  source.slots = [];
  dissolveView(source.id);
  insertSlots(target, slot, zone, items);
  if (state.activeViewId === sourceId) state.activeViewId = target.id;
  log.debug(`split merge: view=${target.id} panes=${target.slots.length} (absorbed view=${sourceId})`);
  saveUi();
  notify('ui');
  return 'ok';
}

/**
 * Move one session into another view (pane-header drop on a tab; the
 * drawer's keyboard "split into view" path uses the active view). Appends.
 * Its SOURCE may be Home — a session leaving Home is an ordinary move; it is
 * the Home VIEW that never goes anywhere.
 */
export function moveSessionToView(sessionId: string, targetId: string): MergeResult {
  const target = state.views.find((v) => v.id === targetId);
  const source = viewOfSession(sessionId);
  if (target === undefined || !state.sessions.has(sessionId)) return 'no';
  if (source !== undefined && source.id === targetId) return 'no';
  if (target.slots.length + 1 > MAX_PANES) return 'full';
  const sourceWasActive = source !== undefined && source.id === state.activeViewId;
  detachFromViews(sessionId);
  insertSlots(target, 0, 'fill', [{ kind: 'session', id: sessionId }]);
  // Moving the active view's only session dissolves it — follow the session.
  if (sourceWasActive && !state.views.some((v) => v.id === state.activeViewId)) {
    state.activeViewId = target.id;
  }
  log.debug(`split move: session=${sessionId} into view=${target.id} panes=${target.slots.length}`);
  saveUi();
  notify('ui');
  return 'ok';
}

/**
 * Extract: a session leaves its (multi-pane) view and becomes its own tab
 * again, inserted at `atIndex` (default: right after its old view, never
 * before `Home`). No-op for a session that is already the only pane of its
 * view — including in Home, which it may leave like any other view.
 */
export function extractSession(sessionId: string, atIndex?: number): void {
  const v = viewOfSession(sessionId);
  if (v === undefined || v.slots.length <= 1) return;
  removeAtSlot(v, indexOfSlot(v, slotKey({ kind: 'session', id: sessionId })));
  const nv = newSessionView(sessionId);
  const idx = atIndex ?? state.views.findIndex((x) => x.id === v.id) + 1;
  state.views.splice(Math.min(Math.max(firstMovableIndex(), idx), state.views.length), 0, nv);
  log.debug(`split extract: session=${sessionId} left view=${v.id} into its own tab`);
  saveUi();
  notify('ui');
}

/** Exited-banner relaunch: swap the old session id for the new one in place. */
export function replaceSessionInView(viewId: string, slot: number, newId: string): void {
  const v = state.views.find((x) => x.id === viewId);
  if (v === undefined || slot < 0 || slot >= v.slots.length) return;
  // Only a session pane relaunches: a file pane has no session to replace.
  if ((v.slots[slot] as PaneSlot).kind !== 'session') return;
  detachFromViews(newId); // uniqueness: upsertSession may have auto-tabbed it
  v.slots[slot] = { kind: 'session', id: newId };
  saveUi();
  notify('ui');
}

// Shared with the sibling pieces (O8 split glue); not part of the public face.
export { indexOfSlot, insertSlots, removeAtSlot, dissolveView };
