/**
 * App state, split by ownership:
 *
 * - SERVER state (sessions, projects) mirrors GET /api/... + WS events.
 *   Sessions are server-side objects; the UI only views them.
 * - CLIENT state (views) is the local arrangement, persisted to localStorage
 *   (schema v2) and rehydrated with pruning against the server's sessions.
 *
 * Interaction model (decided 2026-07-19): EVERY SESSION LIVES IN EXACTLY ONE
 * VIEW, and every view is a tab. A view holds 1..4 sessions in a split; a
 * fresh session is a single-pane view. Views dissolve when their last
 * session leaves (zero views = the empty state); sessions unknown to any
 * view get a tab created for them. New sessions come from the launch dialog
 * (R3) — there is no launcher view kind anymore.
 *
 * Change notification is a flat pub/sub of coarse ChangeKinds; views decide
 * what to re-render.
 */
import type {
  HistoryEntry,
  Project,
  RuntimeStatusResponse,
  SessionInfo,
  UpdateStatus,
} from '../../shared/protocol.ts';
import { log } from './log.ts';

export type Layout = 1 | 2 | 3 | 4;
export type Dir = 'left' | 'right' | 'up' | 'down';
/** Drop-zone position inside a pane; 'fill' = whole pane (multi-session merge). */
export type Zone = 'left' | 'right' | 'top' | 'bottom' | 'fill';
/** Which column holds the tall pane in a 3-split. */
export type L3 = 'L' | 'R';
export type DrawerView = 'sessions' | 'projects' | null;
export type ChangeKind = 'sessions' | 'projects' | 'ui' | 'drawer' | 'conn';

export const MAX_PANES = 4;
const MAX_VIEWS = 16;
const STORAGE_KEY = 'ai-sm:ui:v2';
const STORAGE_KEY_V1 = 'ai-sm:ui:v1';

/**
 * A view = a tab. `sessions` is the slot order; the visual placement of a
 * slot index is fixed per count (and l3 for count 3):
 *   1: [full]                    2: [left, right]
 *   3 L: [tall-left, top-right, bottom-right]
 *   3 R: [top-left, bottom-left, tall-right]
 *   4: [top-left, top-right, bottom-left, bottom-right]
 */
export interface ViewState {
  id: string;
  /** Session ids by slot — always 1..4 entries (empty views dissolve). */
  sessions: string[];
  /** Focused slot index (< sessions.length). */
  focused: number;
  /** Tall-pane side for count 3; kept (harmless) at other counts. */
  l3: L3;
  /** Divider fractions (first column / first row share), SPLIT_MIN..SPLIT_MAX. */
  split: { col: number; row: number };
}

interface AppState {
  sessions: Map<string, SessionInfo>;
  projects: Project[];
  /** Session history (GET /api/history) — ended sessions, resumable per entry. */
  history: HistoryEntry[];
  views: ViewState[];
  activeViewId: string;
  drawer: DrawerView;
  /** Presence ping round-trip in ms; null until measured / while disconnected. */
  wsLatencyMs: number | null;
  /** Backend boot time (GET /api/runtime startedAt); null until fetched. */
  serverStartedAt: string | null;
  /** Short git hash the running backend was built from; null when unknown. */
  serverCommit: string | null;
  /**
   * Installed mode (2026-09-08): the bundle version the backend runs from
   * (e.g. `v0.2.0`), null on a developer clone — where `serverCommit` is the
   * identity instead. The settings panel prefers this and falls back.
   */
  version: string | null;
  /**
   * True when the backend runs from an installed bundle rather than a git
   * checkout. It decides what an update MEANS, so the panel offers the
   * releases page instead of assuming the user can pull sources.
   */
  installed: boolean;
  /** Live "newer code is on disk" answer from GET /api/runtime; null until fetched. */
  update: UpdateStatus | null;
  /**
   * A backend restart requested from this page is in flight. It is the app's
   * "expect the server to vanish" flag: while it is true the session poll,
   * the runtime poll, both WebSocket reconnect loops and the fatal-on-401
   * takeover all stand down, because every one of them would otherwise read
   * the restart gap as a catastrophe and tear the page down mid-handover.
   */
  restarting: boolean;
  /** Poll/pong-derived backend reachability (topbar dot + statusline pty item). */
  backendReachable: boolean;
}

export const state: AppState = {
  sessions: new Map(),
  projects: [],
  history: [],
  views: [],
  activeViewId: '',
  drawer: null,
  wsLatencyMs: null,
  serverStartedAt: null,
  serverCommit: null,
  version: null,
  installed: false,
  update: null,
  restarting: false,
  backendReachable: true,
};

// --------------------------------------------------------------------------
// Pub/sub
// --------------------------------------------------------------------------

type Listener = (kind: ChangeKind) => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): void {
  listeners.add(fn);
}

export function notify(kind: ChangeKind): void {
  for (const fn of listeners) fn(kind);
}

// --------------------------------------------------------------------------
// View constructors + persistence (client-local UI state only)
// --------------------------------------------------------------------------

/** Divider bounds: no pane may shrink below 15% of the grid. */
export const SPLIT_MIN = 0.15;
export const SPLIT_MAX = 0.85;

function clampSplit(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v))
    : 0.5;
}

function newSessionView(sessionId: string): ViewState {
  return {
    id: crypto.randomUUID(),
    sessions: [sessionId],
    focused: 0,
    l3: 'L',
    split: { col: 0.5, row: 0.5 },
  };
}

export function saveUi(): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ views: state.views, active: state.activeViewId }),
    );
  } catch {
    // Storage full/unavailable — UI still works, arrangement just won't survive reload.
  }
}

/**
 * Validate one stored v2 view. `seen` enforces the global invariant that a
 * session id appears in at most one view (first occurrence wins). Views
 * without sessions are dropped — this is also the migration for pre-R3 v2
 * blobs, whose launcher views (kind: 'launcher', zero sessions) simply
 * vanish; the schema key stays v2.
 */
function validateView(raw: unknown, seen: Set<string>): ViewState | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const sessions: string[] = [];
  if (Array.isArray(o.sessions)) {
    for (const s of o.sessions) {
      if (typeof s === 'string' && s !== '' && !seen.has(s) && sessions.length < MAX_PANES) {
        seen.add(s);
        sessions.push(s);
      }
    }
  }
  if (sessions.length === 0) return null; // empty (incl. old launcher views): drop
  const focusedRaw = typeof o.focused === 'number' ? Math.trunc(o.focused) : 0;
  const focused = Math.min(Math.max(0, focusedRaw), sessions.length - 1);
  const id = typeof o.id === 'string' && o.id !== '' ? o.id : crypto.randomUUID();
  const splitRaw = (o.split ?? null) as Record<string, unknown> | null;
  return {
    id,
    sessions,
    focused,
    l3: o.l3 === 'R' ? 'R' : 'L',
    split: { col: clampSplit(splitRaw?.col), row: clampSplit(splitRaw?.row) },
  };
}

/**
 * v1 -> v2 migration: each v1 tab (fixed layout, 4 pane slots) becomes a
 * view whose sessions are the tab's visible occupied slots in order; empty
 * v1 tabs are dropped (there is no launcher view kind anymore). Ids are
 * kept so `active` maps across.
 */
function migrateV1(parsed: unknown, seen: Set<string>): { views: ViewState[]; active: unknown } {
  const views: ViewState[] = [];
  let active: unknown = null;
  if (parsed !== null && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    active = o.activeTabId;
    if (Array.isArray(o.tabs)) {
      for (const t of o.tabs) {
        if (views.length >= MAX_VIEWS) break;
        if (t === null || typeof t !== 'object') continue;
        const tab = t as Record<string, unknown>;
        const layout =
          tab.layout === 2 || tab.layout === 3 || tab.layout === 4 ? (tab.layout as number) : 1;
        const sessions: string[] = [];
        let focusedSession: string | null = null;
        if (Array.isArray(tab.panes)) {
          for (let i = 0; i < layout; i++) {
            const p = tab.panes[i];
            if (typeof p === 'string' && p !== '' && !seen.has(p)) {
              seen.add(p);
              sessions.push(p);
              if (tab.focused === i) focusedSession = p;
            }
          }
        }
        if (sessions.length === 0) continue;
        const splitRaw = (tab.split ?? null) as Record<string, unknown> | null;
        views.push({
          id: typeof tab.id === 'string' && tab.id !== '' ? tab.id : crypto.randomUUID(),
          sessions,
          focused: Math.max(0, focusedSession !== null ? sessions.indexOf(focusedSession) : 0),
          l3: 'L',
          split: { col: clampSplit(splitRaw?.col), row: clampSplit(splitRaw?.row) },
        });
      }
    }
  }
  return { views, active };
}

/**
 * Rehydrate views from v2 storage; when only a v1 blob exists, migrate it
 * (then drop the v1 key). Prunes against the server's sessions and ensures
 * every server session has a view.
 */
export function loadUi(): void {
  const seen = new Set<string>();
  let views: ViewState[] = [];
  let active: unknown = null;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    parsed = null;
  }
  if (parsed !== null && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o.views)) {
      for (const v of o.views) {
        const vv = validateView(v, seen);
        if (vv !== null && views.length < MAX_VIEWS) views.push(vv);
      }
    }
    active = o.active;
  } else {
    // No v2 state: try migrating v1 (malformed v1 degrades to a clean start).
    let v1: unknown = null;
    try {
      v1 = JSON.parse(localStorage.getItem(STORAGE_KEY_V1) ?? 'null');
    } catch {
      v1 = null;
    }
    if (v1 !== null) {
      const m = migrateV1(v1, seen);
      views = m.views;
      active = m.active;
    }
  }
  try {
    localStorage.removeItem(STORAGE_KEY_V1);
  } catch {
    // Ignore.
  }

  state.views = views;
  state.activeViewId =
    typeof active === 'string' && views.some((v) => v.id === active)
      ? active
      : (views[0]?.id ?? '');
  reconcileViews();
  // Zero views is a legal state (the handoff's empty state): the launch
  // dialog opens on demand instead of a launcher tab being ever-present.
  normalizeActive();
  saveUi();
}

/** Keep activeViewId pointing at a real view ('' when none exist). */
function normalizeActive(): void {
  if (state.views.length === 0) {
    state.activeViewId = '';
  } else if (!state.views.some((v) => v.id === state.activeViewId)) {
    state.activeViewId = (state.views[0] as ViewState).id;
  }
}

// --------------------------------------------------------------------------
// View geometry: slot insertion / removal for the fixed split shapes
// --------------------------------------------------------------------------

/**
 * Insert sessions into a view at (slot, zone). Single-id inserts split the
 * dropped-on pane; multi-id (merging a split tab) and 'fill' append in
 * order. The caller has already checked capacity and detached the ids from
 * other views. Focus lands on the first inserted session.
 */
function insertSessions(v: ViewState, slot: number, zone: Zone, ids: string[]): void {
  const first = ids[0];
  if (first === undefined) return;
  const s = v.sessions;
  const n = s.length;
  if (ids.length > 1 || zone === 'fill' || n + ids.length > MAX_PANES) {
    v.sessions = [...s, ...ids].slice(0, MAX_PANES);
  } else if (n === 1) {
    v.sessions = zone === 'left' ? [first, s[0] as string] : [s[0] as string, first];
  } else if (n === 2) {
    const [a, b] = s as [string, string];
    if (slot === 0) {
      // Split the left pane vertically: tall pane moves to the right column.
      v.l3 = 'R';
      v.sessions = zone === 'top' ? [first, a, b] : [a, first, b];
    } else {
      v.l3 = 'L';
      v.sessions = zone === 'top' ? [a, first, b] : [a, b, first];
    }
  } else {
    // n === 3: only the tall pane can split (into the 2x2).
    const [a, b, c] = s as [string, string, string];
    v.sessions =
      v.l3 === 'L'
        ? zone === 'top'
          ? [first, b, a, c]
          : [a, b, first, c]
        : zone === 'top'
          ? [a, first, b, c]
          : [a, c, b, first];
  }
  v.focused = Math.max(0, v.sessions.indexOf(first));
}

/** Remove the session at `slot`, remapping the 2x2 into the right 3-variant. */
function removeAtSlot(v: ViewState, slot: number): void {
  const s = v.sessions;
  const focusId = s[v.focused] ?? null;
  if (s.length === 4) {
    const [a, b, c, d] = s as [string, string, string, string];
    // Removing from the left column leaves the right column stacked (L);
    // removing from the right column leaves the left column stacked (R).
    if (slot === 0) {
      v.sessions = [c, b, d];
      v.l3 = 'L';
    } else if (slot === 2) {
      v.sessions = [a, b, d];
      v.l3 = 'L';
    } else if (slot === 1) {
      v.sessions = [a, c, d];
      v.l3 = 'R';
    } else {
      v.sessions = [a, c, b];
      v.l3 = 'R';
    }
  } else {
    v.sessions = s.filter((_, i) => i !== slot);
  }
  const keep = focusId !== null ? v.sessions.indexOf(focusId) : -1;
  v.focused = keep >= 0 ? keep : Math.min(Math.max(0, slot), Math.max(0, v.sessions.length - 1));
}

/** Drop-zone kinds available on a slot of a view for a drag of `count` sessions. */
export function dropZonesFor(v: ViewState, slot: number, count: number): Zone[] {
  const n = v.sessions.length;
  // Views always hold ≥1 session (validateView/reconcileViews dissolve
  // empties) — defensive guard only: no sessions, nothing to anchor zones to.
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
  return state.views.find((v) => v.sessions.includes(sessionId));
}

/** Remove a view; views may reach zero (the empty state). Keeps active valid. */
function dissolveView(id: string): void {
  const idx = state.views.findIndex((v) => v.id === id);
  if (idx === -1) return;
  state.views.splice(idx, 1);
  if (state.views.length === 0) {
    state.activeViewId = '';
  } else if (!state.views.some((v) => v.id === state.activeViewId)) {
    state.activeViewId = (state.views[Math.min(idx, state.views.length - 1)] as ViewState).id;
  }
}

/** Pull a session out of whatever view holds it; dissolve the view if emptied. */
function detachFromViews(sessionId: string): void {
  const v = viewOfSession(sessionId);
  if (v === undefined) return;
  removeAtSlot(v, v.sessions.indexOf(sessionId));
  if (v.sessions.length === 0) dissolveView(v.id);
}

/**
 * Reconcile views with server sessions: prune ids the server no longer has
 * (skipping `skipViewId` — the active view's slots are left to their sockets,
 * which surface a structural "gone" note instead of silently vanishing), and
 * give any unassigned session its own tab (not activated). Returns whether
 * anything structural changed.
 */
export function reconcileViews(skipViewId?: string): boolean {
  let changed = false;
  for (const v of [...state.views]) {
    if (v.id === skipViewId) continue;
    for (let i = v.sessions.length - 1; i >= 0; i--) {
      const id = v.sessions[i] as string;
      if (!state.sessions.has(id)) {
        removeAtSlot(v, i);
        changed = true;
      }
    }
    if (v.sessions.length === 0) {
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

/** Visible pane count of a view (1..4). */
export function viewLayout(v: ViewState): Layout {
  return Math.min(MAX_PANES, Math.max(1, v.sessions.length)) as Layout;
}

/** Structural tab close (no killing — callers kill sessions first if asked to). */
export function closeView(id: string): void {
  if (!state.views.some((v) => v.id === id)) return;
  log.debug(`tab closed: view=${id}`);
  dissolveView(id);
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
  v.focused = v.sessions.indexOf(sessionId);
  state.activeViewId = v.id;
  saveUi();
  notify('ui');
}

/**
 * Keyboard twin of the reorder drag (ctrl+alt+shift+pgup/pgdn): move the
 * active tab one strip position left/right. No-op at the strip ends.
 */
export function moveActiveViewBy(delta: -1 | 1): void {
  const from = state.views.findIndex((v) => v.id === state.activeViewId);
  if (from === -1) return;
  reorderView(state.activeViewId, delta === -1 ? from - 1 : from + 2);
}

/** Move a view to a new strip position (tab drag onto strip space). */
export function reorderView(id: string, toIndex: number): void {
  const from = state.views.findIndex((v) => v.id === id);
  if (from === -1) return;
  let to = Math.min(Math.max(0, toIndex), state.views.length);
  if (to > from) to--;
  if (to === from) return;
  const [v] = state.views.splice(from, 1);
  state.views.splice(to, 0, v as ViewState);
  saveUi();
  notify('ui');
}

export type MergeResult = 'ok' | 'full' | 'no';

/**
 * Drag-to-split: dissolve view `sourceId` and insert its sessions into view
 * `targetId` at (slot, zone). 'full' when the result would exceed 4 panes.
 */
export function mergeViews(targetId: string, sourceId: string, slot: number, zone: Zone): MergeResult {
  const target = state.views.find((v) => v.id === targetId);
  const source = state.views.find((v) => v.id === sourceId);
  if (target === undefined || source === undefined || targetId === sourceId) return 'no';
  if (target.sessions.length + source.sessions.length > MAX_PANES) return 'full';
  const ids = [...source.sessions];
  source.sessions = [];
  dissolveView(source.id);
  insertSessions(target, slot, zone, ids);
  if (state.activeViewId === sourceId) state.activeViewId = target.id;
  log.debug(`split merge: view=${target.id} panes=${target.sessions.length} (absorbed view=${sourceId})`);
  saveUi();
  notify('ui');
  return 'ok';
}

/**
 * Move one session into another view (pane-header drop on a tab; the
 * drawer's keyboard "split into view" path uses the active view). Appends.
 */
export function moveSessionToView(sessionId: string, targetId: string): MergeResult {
  const target = state.views.find((v) => v.id === targetId);
  const source = viewOfSession(sessionId);
  if (target === undefined || !state.sessions.has(sessionId)) return 'no';
  if (source !== undefined && source.id === targetId) return 'no';
  if (target.sessions.length + 1 > MAX_PANES) return 'full';
  const sourceWasActive = source !== undefined && source.id === state.activeViewId;
  detachFromViews(sessionId);
  insertSessions(target, 0, 'fill', [sessionId]);
  // Moving the active view's only session dissolves it — follow the session.
  if (sourceWasActive && !state.views.some((v) => v.id === state.activeViewId)) {
    state.activeViewId = target.id;
  }
  log.debug(`split move: session=${sessionId} into view=${target.id} panes=${target.sessions.length}`);
  saveUi();
  notify('ui');
  return 'ok';
}

/**
 * Extract: a session leaves its (multi-session) view and becomes its own tab
 * again, inserted at `atIndex` (default: right after its old view). No-op for
 * a session already alone in its view.
 */
export function extractSession(sessionId: string, atIndex?: number): void {
  const v = viewOfSession(sessionId);
  if (v === undefined || v.sessions.length <= 1) return;
  removeAtSlot(v, v.sessions.indexOf(sessionId));
  const nv = newSessionView(sessionId);
  const idx = atIndex ?? state.views.findIndex((x) => x.id === v.id) + 1;
  state.views.splice(Math.min(Math.max(0, idx), state.views.length), 0, nv);
  log.debug(`split extract: session=${sessionId} left view=${v.id} into its own tab`);
  saveUi();
  notify('ui');
}

/** Exited-banner relaunch: swap the old session id for the new one in place. */
export function replaceSessionInView(viewId: string, slot: number, newId: string): void {
  const v = state.views.find((x) => x.id === viewId);
  if (v === undefined || slot < 0 || slot >= v.sessions.length) return;
  detachFromViews(newId); // uniqueness: upsertSession may have auto-tabbed it
  v.sessions[slot] = newId;
  saveUi();
  notify('ui');
}

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
  const n = v.sessions.length;
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
 * Ctrl+Alt+Shift+Arrow: move the focused session to the neighbor pane WITHIN
 * its view (swap when occupied — panes always are). Focus follows.
 */
export function moveSession(dir: Dir): void {
  const v = activeView();
  if (v === null || v.sessions[v.focused] === undefined) return;
  const target = neighbors(v)[v.focused]?.[dir];
  if (target !== undefined) swapPanes(v.id, v.focused, target);
}

/** Swap two pane slots' sessions (chord move + header drag onto a pane). */
export function swapPanes(viewId: string, from: number, to: number): void {
  const v = state.views.find((v) => v.id === viewId);
  if (v === undefined || from === to) return;
  const n = v.sessions.length;
  if (from < 0 || to < 0 || from >= n || to >= n) return;
  const a = v.sessions[from] as string;
  v.sessions[from] = v.sessions[to] as string;
  v.sessions[to] = a;
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

export function viewAttention(v: ViewState): boolean {
  return v.sessions.some((id) => state.sessions.get(id)?.attention === true);
}

/** Tab status accent: amber attention > green running > gray exited. */
export function viewStatus(v: ViewState): 'attn' | 'run' | 'exit' {
  if (viewAttention(v)) return 'attn';
  const infos = v.sessions.map((id) => state.sessions.get(id));
  if (infos.some((s) => s?.status === 'running')) return 'run';
  return 'exit';
}

export function attentionCount(): number {
  let n = 0;
  for (const s of state.sessions.values()) if (s.attention) n++;
  return n;
}

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

export function closeDrawer(): void {
  if (state.drawer !== null) {
    state.drawer = null;
    notify('drawer');
  }
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
  const updateChanged =
    state.update?.available !== r.update?.available || state.update?.reason !== r.update?.reason;
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
