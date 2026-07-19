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
 * fresh session is a single-pane view. A 'launcher' view holds none — it is
 * the new-session tab (and the empty state). Views dissolve when their last
 * session leaves; sessions unknown to any view get a tab created for them.
 *
 * Change notification is a flat pub/sub of coarse ChangeKinds; views decide
 * what to re-render.
 */
import type { PreviousSession, Project, SessionInfo } from '../../shared/protocol.ts';

export type Layout = 1 | 2 | 3 | 4;
export type Dir = 'left' | 'right' | 'up' | 'down';
/** Drop-zone position inside a pane; 'fill' = whole pane (launcher / multi-session merge). */
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
  kind: 'sessions' | 'launcher';
  /** Session ids by slot. Empty iff kind === 'launcher'. */
  sessions: string[];
  /** Focused slot index (< max(1, sessions.length)). */
  focused: number;
  /** Tall-pane side for count 3; kept (harmless) at other counts. */
  l3: L3;
  /** Divider fractions (first column / first row share), SPLIT_MIN..SPLIT_MAX. */
  split: { col: number; row: number };
}

interface AppState {
  sessions: Map<string, SessionInfo>;
  projects: Project[];
  /** Previous-run relaunch offers (GET /api/previous, crash/shutdown only). */
  previous: PreviousSession[];
  views: ViewState[];
  activeViewId: string;
  drawer: DrawerView;
}

export const state: AppState = {
  sessions: new Map(),
  projects: [],
  previous: [],
  views: [],
  activeViewId: '',
  drawer: null,
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

function newLauncherView(): ViewState {
  return {
    id: crypto.randomUUID(),
    kind: 'launcher',
    sessions: [],
    focused: 0,
    l3: 'L',
    split: { col: 0.5, row: 0.5 },
  };
}

function newSessionView(sessionId: string): ViewState {
  return {
    id: crypto.randomUUID(),
    kind: 'sessions',
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
 * session id appears in at most one view (first occurrence wins).
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
  const kind: ViewState['kind'] = sessions.length > 0 ? 'sessions' : 'launcher';
  if (kind === 'launcher' && o.kind !== 'launcher') return null; // sessions view without sessions = malformed
  const focusedRaw = typeof o.focused === 'number' ? Math.trunc(o.focused) : 0;
  const focused = Math.min(Math.max(0, focusedRaw), Math.max(0, sessions.length - 1));
  const id = typeof o.id === 'string' && o.id !== '' ? o.id : crypto.randomUUID();
  const splitRaw = (o.split ?? null) as Record<string, unknown> | null;
  return {
    id,
    kind,
    sessions,
    focused,
    l3: o.l3 === 'R' ? 'R' : 'L',
    split: { col: clampSplit(splitRaw?.col), row: clampSplit(splitRaw?.row) },
  };
}

/**
 * v1 -> v2 migration: each v1 tab (fixed layout, 4 pane slots) becomes a
 * view whose sessions are the tab's visible occupied slots in order; empty
 * tabs become launcher views. Ids are kept so `active` maps across.
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
        const splitRaw = (tab.split ?? null) as Record<string, unknown> | null;
        views.push({
          id: typeof tab.id === 'string' && tab.id !== '' ? tab.id : crypto.randomUUID(),
          kind: sessions.length > 0 ? 'sessions' : 'launcher',
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
  // Only a truly empty strip gets the default launcher tab — a fresh client
  // on a session-bearing backend starts on the sessions, not on a blank form.
  if (state.views.length === 0) state.views.push(newLauncherView());
  if (!state.views.some((v) => v.id === state.activeViewId)) {
    state.activeViewId = (state.views[0] as ViewState).id;
  }
  saveUi();
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
  if (v.kind === 'launcher' || v.sessions.length === 0) {
    v.kind = 'sessions';
    v.sessions = [...ids];
    v.focused = 0;
    return;
  }
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
  const n = v.kind === 'launcher' ? 0 : v.sessions.length;
  if (n + count > MAX_PANES) return [];
  if (n === 0 || count > 1) return ['fill'];
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

/** Remove a view; keep at least one view and a valid active id. */
function dissolveView(id: string): void {
  const idx = state.views.findIndex((v) => v.id === id);
  if (idx === -1) return;
  state.views.splice(idx, 1);
  if (state.views.length === 0) state.views.push(newLauncherView());
  if (!state.views.some((v) => v.id === state.activeViewId)) {
    state.activeViewId = (state.views[Math.min(idx, state.views.length - 1)] as ViewState).id;
  }
}

/** Pull a session out of whatever view holds it; dissolve the view if emptied. */
function detachFromViews(sessionId: string): void {
  const v = viewOfSession(sessionId);
  if (v === undefined) return;
  removeAtSlot(v, v.sessions.indexOf(sessionId));
  if (v.kind === 'sessions' && v.sessions.length === 0) dissolveView(v.id);
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
    if (v.kind === 'sessions' && v.sessions.length === 0) {
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
  if (changed) saveUi();
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

/** Boot-time load of the previous-run relaunch offers. */
export function setPrevious(list: PreviousSession[]): void {
  state.previous = list;
  notify('sessions');
}

/** Drop one offer (after relaunch or dismiss). */
export function removePrevious(id: string): void {
  const next = state.previous.filter((p) => p.id !== id);
  if (next.length !== state.previous.length) {
    state.previous = next;
    notify('sessions');
  }
}

/** Drop all offers (dismiss-all). */
export function clearPrevious(): void {
  if (state.previous.length > 0) {
    state.previous = [];
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

export function activeView(): ViewState {
  const v = state.views.find((v) => v.id === state.activeViewId);
  return v ?? (state.views[0] as ViewState);
}

/** Visible pane count of a view (a launcher view renders one pane). */
export function viewLayout(v: ViewState): Layout {
  return Math.min(MAX_PANES, Math.max(1, v.sessions.length)) as Layout;
}

/** '+' / Ctrl+Alt+T: open a new-session (launcher) tab and activate it. */
export function addLauncherTab(): void {
  const v = newLauncherView();
  state.views.push(v);
  state.activeViewId = v.id;
  saveUi();
  notify('ui');
}

/** Structural tab close (no killing — callers kill sessions first if asked to). */
export function closeView(id: string): void {
  if (!state.views.some((v) => v.id === id)) return;
  dissolveView(id);
  saveUi();
  notify('ui');
}

export function setActiveView(id: string): void {
  if (state.activeViewId !== id && state.views.some((v) => v.id === id)) {
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
  if (source.kind === 'launcher') return 'no';
  const targetCount = target.kind === 'launcher' ? 0 : target.sessions.length;
  if (targetCount + source.sessions.length > MAX_PANES) return 'full';
  const ids = [...source.sessions];
  source.sessions = [];
  dissolveView(source.id);
  insertSessions(target, slot, zone, ids);
  if (state.activeViewId === sourceId) state.activeViewId = target.id;
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
  const targetCount = target.kind === 'launcher' ? 0 : target.sessions.length;
  if (targetCount + 1 > MAX_PANES) return 'full';
  const sourceWasActive = source !== undefined && source.id === state.activeViewId;
  detachFromViews(sessionId);
  insertSessions(target, 0, 'fill', [sessionId]);
  // Moving the active view's only session dissolves it — follow the session.
  if (sourceWasActive && !state.views.some((v) => v.id === state.activeViewId)) {
    state.activeViewId = target.id;
  }
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
  saveUi();
  notify('ui');
}

/**
 * A launcher view's form created a session: the view becomes that session's
 * single-pane view. If the view vanished mid-await, the session keeps the
 * tab upsertSession gave it.
 */
export function launcherBecameSession(viewId: string, sessionId: string): void {
  const v = state.views.find((x) => x.id === viewId);
  if (v === undefined || v.kind !== 'launcher') return;
  detachFromViews(sessionId); // upsertSession may have auto-tabbed it already
  v.kind = 'sessions';
  v.sessions = [sessionId];
  v.focused = 0;
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
  const target = neighbors(v)[v.focused]?.[dir];
  if (target !== undefined) focusPane(target);
}

/**
 * Ctrl+Alt+Shift+Arrow: move the focused session to the neighbor pane WITHIN
 * its view (swap when occupied — panes always are). Focus follows.
 */
export function moveSession(dir: Dir): void {
  const v = activeView();
  if (v.sessions[v.focused] === undefined) return;
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

/** Tab status accent: amber attention > green running > gray exited; 'new' = launcher. */
export function viewStatus(v: ViewState): 'attn' | 'run' | 'exit' | 'new' {
  if (v.kind === 'launcher') return 'new';
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

export function closeDrawer(): void {
  if (state.drawer !== null) {
    state.drawer = null;
    notify('drawer');
  }
}
