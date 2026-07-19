/**
 * App state, split by ownership:
 *
 * - SERVER state (sessions, projects) mirrors GET /api/... + WS events.
 *   Sessions are server-side objects; panes are only views onto them.
 * - CLIENT state (tabs, layouts, pane->session assignments, focused pane)
 *   is local UI arrangement, persisted to localStorage and rehydrated with
 *   pruning of session ids the server no longer knows.
 *
 * Change notification is a flat pub/sub of coarse ChangeKinds; views decide
 * what to re-render.
 */
import type { PreviousSession, Project, SessionInfo } from '../../shared/protocol.ts';

export type Layout = 1 | 2 | 3 | 4;
export type Dir = 'left' | 'right' | 'up' | 'down';
export type DrawerView = 'sessions' | 'projects' | null;
export type ChangeKind = 'sessions' | 'projects' | 'ui' | 'drawer' | 'conn';

export const MAX_PANES = 4;
const STORAGE_KEY = 'ai-sm:ui:v1';

export interface TabState {
  id: string;
  layout: Layout;
  /** Pane slot -> session id. Always MAX_PANES long; slots >= layout are hidden but kept. */
  panes: (string | null)[];
  /** Focused pane index within this tab (< layout). */
  focused: number;
  /** Divider fractions (first column / first row share of the grid), SPLIT_MIN..SPLIT_MAX. */
  split: { col: number; row: number };
}

interface AppState {
  sessions: Map<string, SessionInfo>;
  projects: Project[];
  /** Previous-run relaunch offers (GET /api/previous, crash/shutdown only). */
  previous: PreviousSession[];
  tabs: TabState[];
  activeTabId: string;
  drawer: DrawerView;
}

export const state: AppState = {
  sessions: new Map(),
  projects: [],
  previous: [],
  tabs: [],
  activeTabId: '',
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
// Persistence (client-local UI state only)
// --------------------------------------------------------------------------

/** Divider bounds: no pane may shrink below 15% of the grid. */
export const SPLIT_MIN = 0.15;
export const SPLIT_MAX = 0.85;

function clampSplit(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v))
    : 0.5;
}

function newTab(): TabState {
  return {
    id: crypto.randomUUID(),
    layout: 1,
    panes: [null, null, null, null],
    focused: 0,
    split: { col: 0.5, row: 0.5 },
  };
}

export function saveUi(): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ tabs: state.tabs, activeTabId: state.activeTabId }),
    );
  } catch {
    // Storage full/unavailable — UI still works, arrangement just won't survive reload.
  }
}

function validateTab(raw: unknown): TabState | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const layout: Layout =
    o.layout === 1 || o.layout === 2 || o.layout === 3 || o.layout === 4 ? o.layout : 1;
  const panes: (string | null)[] = [null, null, null, null];
  if (Array.isArray(o.panes)) {
    for (let i = 0; i < MAX_PANES; i++) {
      const p = o.panes[i];
      if (typeof p === 'string' && p !== '') panes[i] = p;
    }
  }
  // A session may appear at most once per tab.
  const seen = new Set<string>();
  for (let i = 0; i < MAX_PANES; i++) {
    const p = panes[i];
    if (p !== null) {
      if (seen.has(p)) panes[i] = null;
      else seen.add(p);
    }
  }
  const focusedRaw = typeof o.focused === 'number' ? Math.trunc(o.focused) : 0;
  const focused = Math.min(Math.max(0, focusedRaw), layout - 1);
  const id = typeof o.id === 'string' && o.id !== '' ? o.id : crypto.randomUUID();
  const splitRaw = (o.split ?? null) as Record<string, unknown> | null;
  const split = {
    col: clampSplit(splitRaw?.col),
    row: clampSplit(splitRaw?.row),
  };
  return { id, layout, panes, focused, split };
}

/** Rehydrate tabs/layouts/assignments; prune session ids the server no longer has. */
export function loadUi(): void {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    parsed = null;
  }
  const tabs: TabState[] = [];
  let activeTabId: unknown = null;
  if (parsed !== null && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o.tabs)) {
      for (const t of o.tabs) {
        const v = validateTab(t);
        if (v !== null && tabs.length < 16) tabs.push(v);
      }
    }
    activeTabId = o.activeTabId;
  }
  if (tabs.length === 0) tabs.push(newTab());
  state.tabs = tabs;
  state.activeTabId =
    typeof activeTabId === 'string' && tabs.some((t) => t.id === activeTabId)
      ? activeTabId
      : (tabs[0] as TabState).id;
  pruneAssignments();
}

/** Null out pane assignments whose session no longer exists server-side. */
export function pruneAssignments(skipTabId?: string): void {
  let changed = false;
  for (const t of state.tabs) {
    if (t.id === skipTabId) continue;
    for (let i = 0; i < MAX_PANES; i++) {
      const id = t.panes[i];
      if (id !== null && id !== undefined && !state.sessions.has(id)) {
        t.panes[i] = null;
        changed = true;
      }
    }
  }
  if (changed) saveUi();
}

// --------------------------------------------------------------------------
// Server state
// --------------------------------------------------------------------------

export function initServer(projects: Project[], sessions: SessionInfo[]): void {
  state.projects = projects;
  state.sessions = new Map(sessions.map((s) => [s.id, s]));
}

/** Full refresh from GET /api/sessions. The active tab's panes are left to their sockets. */
export function setSessions(list: SessionInfo[]): void {
  state.sessions = new Map(list.map((s) => [s.id, s]));
  pruneAssignments(state.activeTabId);
  notify('sessions');
}

export function upsertSession(s: SessionInfo): void {
  state.sessions.set(s.id, s);
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

/** After DELETE: remove the session and clear every pane referencing it. */
export function removeSessionEverywhere(id: string): void {
  state.sessions.delete(id);
  for (const t of state.tabs) {
    for (let i = 0; i < MAX_PANES; i++) {
      if (t.panes[i] === id) t.panes[i] = null;
    }
  }
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
// UI state
// --------------------------------------------------------------------------

export function activeTab(): TabState {
  const t = state.tabs.find((t) => t.id === state.activeTabId);
  return t ?? (state.tabs[0] as TabState);
}

export function addTab(): void {
  const t = newTab();
  state.tabs.push(t);
  state.activeTabId = t.id;
  saveUi();
  notify('ui');
}

export function closeTab(id: string): void {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  state.tabs.splice(idx, 1);
  if (state.tabs.length === 0) state.tabs.push(newTab());
  if (!state.tabs.some((t) => t.id === state.activeTabId)) {
    state.activeTabId = (state.tabs[Math.max(0, idx - 1)] as TabState).id;
  }
  saveUi();
  notify('ui');
}

export function setActiveTab(id: string): void {
  if (state.activeTabId !== id && state.tabs.some((t) => t.id === id)) {
    state.activeTabId = id;
    saveUi();
    notify('ui');
  }
}

export function setActiveTabIndex(i: number): void {
  const t = state.tabs[i];
  if (t !== undefined) setActiveTab(t.id);
}

export function setLayout(layout: Layout): void {
  const t = activeTab();
  if (t.layout !== layout) {
    t.layout = layout;
    if (t.focused >= layout) t.focused = 0;
    saveUi();
    notify('ui');
  }
}

/** Assign a session to a pane slot. Within a tab a session lives in one slot (move semantics). */
export function assignPane(tabId: string, pane: number, sessionId: string | null): void {
  const t = state.tabs.find((t) => t.id === tabId);
  if (t === undefined || pane < 0 || pane >= MAX_PANES) return;
  if (sessionId !== null) {
    for (let i = 0; i < MAX_PANES; i++) {
      if (i !== pane && t.panes[i] === sessionId) t.panes[i] = null;
    }
  }
  t.panes[pane] = sessionId;
  saveUi();
  notify('ui');
}

export function focusPane(i: number): void {
  const t = activeTab();
  if (i >= 0 && i < t.layout && t.focused !== i) {
    t.focused = i;
    saveUi();
    notify('ui');
  }
}

/**
 * Spatial focus movement, hardcoded per layout:
 *   1: [0]        2: [0|1]        3: [0|1/2]  (0 tall left)      4: [0|1 / 2|3]
 */
const NEIGHBORS: Record<Layout, Partial<Record<Dir, number>>[]> = {
  1: [{}],
  2: [{ right: 1 }, { left: 0 }],
  3: [{ right: 1 }, { left: 0, down: 2 }, { left: 0, up: 1 }],
  4: [
    { right: 1, down: 2 },
    { left: 0, down: 3 },
    { right: 3, up: 0 },
    { left: 2, up: 1 },
  ],
};

export function moveFocus(dir: Dir): void {
  const t = activeTab();
  const target = NEIGHBORS[t.layout][t.focused]?.[dir];
  if (target !== undefined) focusPane(target);
}

/**
 * Ctrl+Alt+Shift+Arrow: move the focused pane's session to the neighbor pane
 * in that direction (swap when occupied). Focus follows the moved session.
 */
export function moveSession(dir: Dir): void {
  const t = activeTab();
  if ((t.panes[t.focused] ?? null) === null) return; // Nothing to move.
  const target = NEIGHBORS[t.layout][t.focused]?.[dir];
  if (target !== undefined) swapPanes(t.id, t.focused, target);
}

/** Swap two visible pane slots' sessions (chord move + header-grip drag). */
export function swapPanes(tabId: string, from: number, to: number): void {
  const t = state.tabs.find((t) => t.id === tabId);
  if (t === undefined || from === to) return;
  if (from < 0 || to < 0 || from >= t.layout || to >= t.layout) return;
  const a = t.panes[from] ?? null;
  const b = t.panes[to] ?? null;
  if (a === null && b === null) return;
  t.panes[from] = b;
  t.panes[to] = a;
  if (t.id === state.activeTabId) t.focused = to;
  saveUi();
  notify('ui');
}

/**
 * Adjust a divider fraction of the active tab. During a pointer drag the
 * caller applies grid styles directly and passes commit=false (no persist,
 * no notify); commit=true persists and notifies (drag end / keyboard nudge).
 * Returns the clamped value.
 */
export function setSplit(axis: 'col' | 'row', f: number, commit: boolean): number {
  const t = activeTab();
  const v = clampSplit(f);
  t.split[axis] = v;
  if (commit) {
    saveUi();
    notify('ui');
  }
  return v;
}

export function tabAttention(t: TabState): boolean {
  return t.panes.some((id) => id !== null && state.sessions.get(id)?.attention === true);
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
