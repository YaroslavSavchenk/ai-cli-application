/**
 * App state, split by ownership:
 *
 * - SERVER state (sessions, projects) mirrors GET /api/... + WS events.
 *   Sessions are server-side objects; the UI only views them.
 * - CLIENT state (views) is the local arrangement, persisted to localStorage
 *   (schema v2) and rehydrated with pruning against the server's sessions.
 *
 * Interaction model (decided 2026-07-19, widened by user decision 2026-09-15):
 * EVERY SESSION LIVES IN EXACTLY ONE VIEW, and every view is a tab. A view
 * holds 0..4 SLOTS in a split, and a slot is a terminal, a file or a read-only
 * diff — they mix freely inside one tab. A fresh session is a single-pane
 * rootless view. A ROOTED view (Home, or one folder/project) may stand EMPTY;
 * a rootless view dissolves when its last slot leaves, and a project-rooted one
 * is removed when a close empties it. `Home` is a real view, always the first
 * tab, and is never closed, dissolved or moved. Sessions unknown to any view
 * get a tab created for them. New sessions come from the launch dialog (R3) —
 * there is no launcher view kind anymore.
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
import { diffTabId, fileTabId } from './ui/editor-model.ts';
import { collapseKey } from './ui/commit-model.ts';

export type Layout = 1 | 2 | 3 | 4;
export type Dir = 'left' | 'right' | 'up' | 'down';
/** Drop-zone position inside a pane; 'fill' = whole pane (multi-session merge). */
export type Zone = 'left' | 'right' | 'top' | 'bottom' | 'fill';
/** Which column holds the tall pane in a 3-split. */
export type L3 = 'L' | 'R';
export type DrawerView = 'sessions' | 'projects' | null;
/**
 * The LEFT panel (Nocturne A5). It is not a drawer: it has its own toggle and
 * its own width. `null` means the user closed it; `'files'` means the user
 * wants it, and it is on screen unless the Projects drawer is borrowing the
 * left side (`filesPanelVisible()` is the whole rule).
 *
 * A session is NOT a condition: the panel opens with nothing running, and its
 * header then reads `Home` (user decision 2026-09-15, deviates from v3, whose
 * rule was `leftPanel === 'files' && alive.length > 0`).
 */
export type LeftPanel = 'files' | null;
/**
 * `'screen'` (Nocturne A6) is its own kind rather than another `'panel'`: it
 * means "something else than the panes occupies the pane area" (the commit
 * view covers it), and `ui/panes.ts` must be able
 * to IGNORE it — a pane rebuild against a hidden grid is exactly the
 * measure-while-invisible trap that downgrades xterm's WebGL renderer. The
 * chrome that owns the layout listens; the panes do not.
 */
export type ChangeKind =
  | 'sessions'
  | 'projects'
  | 'ui'
  | 'drawer'
  | 'panel'
  | 'screen'
  | 'conn';

export const MAX_PANES = 4;
const MAX_VIEWS = 16;
const STORAGE_KEY = 'ai-sm:ui:v2';
const STORAGE_KEY_V1 = 'ai-sm:ui:v1';

/**
 * What one pane shows (A10, user decision 2026-09-15). The three kinds mix
 * freely inside one tab: a file may sit beside a terminal.
 */
export type PaneSlot =
  | { kind: 'session'; id: string }
  | { kind: 'file'; path: string }
  | { kind: 'diff'; hash: string; path: string };

/**
 * What a tab is ABOUT. `{kind:'home'}` is the fixed first tab; a project root
 * is one folder tab named after the project (never after its path). `null` is
 * a plain session tab — the one a new session still gets for itself.
 */
export type ViewRoot = { kind: 'home' } | { kind: 'project'; id: string };

/**
 * A view = a tab. `slots` is the slot order; the visual placement of a
 * slot index is fixed per count (and l3 for count 3):
 *   1: [full]                    2: [left, right]
 *   3 L: [tall-left, top-right, bottom-right]
 *   3 R: [top-left, bottom-left, tall-right]
 *   4: [top-left, top-right, bottom-left, bottom-right]
 */
export interface ViewState {
  id: string;
  /** What the tab is about; null = a plain session tab. */
  root: ViewRoot | null;
  /** Panes by slot — 0..4. A ROOTED view may stand empty; a rootless one dissolves. */
  slots: PaneSlot[];
  /** Focused slot index (< slots.length; 0 on an empty view). */
  focused: number;
  /** Tall-pane side for count 3; kept (harmless) at other counts. */
  l3: L3;
  /** Divider fractions (first column / first row share), SPLIT_MIN..SPLIT_MAX. */
  split: { col: number; row: number };
}

/**
 * The identity of a slot — and, for a file, the key its unsaved text lives
 * under in `state.edits`. File and diff keys are EXACTLY `fileTabId(path)` and
 * `diffTabId(hash, path)`, so the same file open in two panes shares one entry
 * (user decision 2026-09-15: free mixing, one text per file).
 */
export function slotKey(s: PaneSlot): string {
  if (s.kind === 'session') return `s:${s.id}`;
  if (s.kind === 'file') return fileTabId(s.path);
  return diffTabId(s.hash, s.path);
}

/** The session ids a view holds, in slot order (file/diff slots are skipped). */
export function sessionIds(v: ViewState): string[] {
  const out: string[] = [];
  for (const s of v.slots) if (s.kind === 'session') out.push(s.id);
  return out;
}

/** Is this tab about a folder (Home or a project) rather than a bare session? */
export function isFolderView(v: ViewState): boolean {
  return v.root !== null;
}

interface AppState {
  sessions: Map<string, SessionInfo>;
  projects: Project[];
  /** Session history (GET /api/history) — ended sessions, resumable per entry. */
  history: HistoryEntry[];
  views: ViewState[];
  activeViewId: string;
  drawer: DrawerView;
  /**
   * Which left panel the user wants (Nocturne A5). Defaults to 'files', so the
   * panel is up from the first paint — with or without a session.
   * `filesPanelVisible()` is the whole rule; opening the Projects drawer hides
   * the panel without touching this wish, so closing the drawer brings it back.
   */
  leftPanel: LeftPanel;
  /** Files panel width in px, FILES_W_MIN..FILES_W_MAX (drag its right edge). */
  filesWidth: number;
  /**
   * The commit whose full view covers the pane area (Nocturne A6), by short
   * hash; null = the panes are on screen. NOT persisted: it is a place the
   * user is standing, not a preference, and a reload that reopened a commit
   * view over a running session would hide the terminal for no reason.
   */
  openCommit: string | null;
  /**
   * Which file blocks inside the open commit are COLLAPSED (`<hash>:<path>`).
   * Collapsed rather than expanded, so a commit opens with its whole diff
   * visible — the reference's own default. Not persisted, like the view.
   */
  commitCollapsed: Set<string>;
  /**
   * Unsaved file text per SLOT KEY — `f:<path>` for a file pane (A10 replaced
   * the editor column by panes, so the key is the file, not a tab). A pane with
   * an entry here is DIRTY (the amber dot); Save removes it, and two panes
   * showing the same file share the one entry. Not persisted: until part B4
   * nothing was ever read from disk, and persisting text that was never a file
   * would persist fiction. B4 turns Save into a disk write.
   */
  edits: Map<string, string>;
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
  /**
   * Live "a newer version exists" answer from GET /api/runtime; null until
   * fetched. Two kinds since phase E: a newer version already on disk
   * (`a new version is installed`) and a newer release online
   * (`a new version is available`, carrying `release`). The notice reads the
   * reason to pick its verb; the release's addresses are never rendered.
   */
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

/** Files panel width bounds (README-v3: "resizable 200-520 px"). */
export const FILES_W_MIN = 200;
export const FILES_W_MAX = 520;
export const FILES_W_DEFAULT = 300;

/** Width a drag or a keyboard nudge is allowed to land on. */
export function clampFilesWidth(px: number): number {
  if (!Number.isFinite(px)) return FILES_W_DEFAULT;
  return Math.max(FILES_W_MIN, Math.min(FILES_W_MAX, Math.round(px)));
}

export const state: AppState = {
  sessions: new Map(),
  projects: [],
  history: [],
  views: [],
  activeViewId: '',
  drawer: null,
  leftPanel: 'files',
  filesWidth: FILES_W_DEFAULT,
  openCommit: null,
  commitCollapsed: new Set(),
  edits: new Map(),
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

function newView(root: ViewRoot | null, slots: PaneSlot[]): ViewState {
  return {
    id: crypto.randomUUID(),
    root,
    slots,
    focused: 0,
    l3: 'L',
    split: { col: 0.5, row: 0.5 },
  };
}

function newSessionView(sessionId: string): ViewState {
  return newView(null, [{ kind: 'session', id: sessionId }]);
}

/**
 * What one view looks like in storage: its root and ONLY its session slots.
 * File and diff slots are dropped on purpose (user decision 10, 2026-09-15) —
 * until part B4 their text was never read from disk, so a reload that
 * resurrected them would resurrect placeholder content.
 *
 * `focused` is remapped onto the slots that survive, so a tab whose focused
 * pane was a file does not come back focused on someone else's terminal.
 */
function persistView(v: ViewState): Record<string, unknown> {
  const kept: PaneSlot[] = [];
  let focused = 0;
  for (let i = 0; i < v.slots.length; i++) {
    const s = v.slots[i] as PaneSlot;
    if (s.kind !== 'session') continue;
    if (i <= v.focused) focused = kept.length;
    kept.push(s);
  }
  return {
    id: v.id,
    root: v.root,
    slots: kept,
    focused: Math.min(focused, Math.max(0, kept.length - 1)),
    l3: v.l3,
    split: v.split,
  };
}

export function saveUi(): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        views: state.views.map(persistView),
        active: state.activeViewId,
        // The left panel rides in the SAME bag as the pane splits: same chrome,
        // same gesture, so a dragged width survives a reload the way a split
        // fraction does. No version bump — the v2 reader ignores keys it does
        // not know, and a blob written before A5 simply lands on the defaults.
        leftPanel: state.leftPanel,
        filesWidth: state.filesWidth,
      }),
    );
  } catch {
    // Storage full/unavailable — UI still works, arrangement just won't survive reload.
  }
}

/** Load-time bookkeeping shared by every stored view of one blob. */
interface LoadCtx {
  /** Session ids already claimed: a session appears in at most one view. */
  seen: Set<string>;
  /** A Home view was already decoded — there is exactly one. */
  home: boolean;
}

/** Decode a stored root. Anything else (absent, garbage) is a plain session tab. */
function validateRoot(raw: unknown, ctx: LoadCtx): ViewRoot | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === 'home') {
    if (ctx.home) return null; // a second Home is not a Home
    ctx.home = true;
    return { kind: 'home' };
  }
  if (o.kind === 'project' && typeof o.id === 'string' && o.id !== '') {
    return { kind: 'project', id: o.id };
  }
  return null;
}

/**
 * Validate one stored v2 view: its root, and its SESSION slots. A view without
 * slots is dropped unless it is Home — which is the fixed first tab and is
 * allowed to stand empty.
 * // B4: file slots persist; drop this exception.
 *
 * This is also the migration for two older shapes under the same v2 key (the
 * reader has always ignored what it does not know): pre-R3 launcher views
 * (kind: 'launcher', zero sessions) simply vanish, and a pre-A10 blob's
 * `sessions: string[]` is read as session slots, so an arrangement made before
 * A10 survives the upgrade.
 */
function validateView(raw: unknown, ctx: LoadCtx): ViewState | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const root = validateRoot(o.root, ctx);
  const slots: PaneSlot[] = [];
  const addSession = (id: unknown): void => {
    if (typeof id !== 'string' || id === '' || ctx.seen.has(id)) return;
    if (slots.length >= MAX_PANES) return;
    ctx.seen.add(id);
    slots.push({ kind: 'session', id });
  };
  if (Array.isArray(o.slots)) {
    for (const s of o.slots) {
      // Only session slots are ever written (see persistView); anything else in
      // the bag is a hand-edit or a future build's blob, and conjuring a file
      // pane out of it would conjure its contents too.
      if (s !== null && typeof s === 'object' && (s as Record<string, unknown>).kind === 'session') {
        addSession((s as Record<string, unknown>).id);
      }
    }
  } else if (Array.isArray(o.sessions)) {
    for (const s of o.sessions) addSession(s);
  }
  if (slots.length === 0 && root?.kind !== 'home') return null;
  const focusedRaw = typeof o.focused === 'number' ? Math.trunc(o.focused) : 0;
  const focused = Math.min(Math.max(0, focusedRaw), Math.max(0, slots.length - 1));
  const id = typeof o.id === 'string' && o.id !== '' ? o.id : crypto.randomUUID();
  const splitRaw = (o.split ?? null) as Record<string, unknown> | null;
  return {
    id,
    root,
    slots,
    focused,
    l3: o.l3 === 'R' ? 'R' : 'L',
    split: { col: clampSplit(splitRaw?.col), row: clampSplit(splitRaw?.row) },
  };
}

/**
 * v1 -> v2 migration: each v1 tab (fixed layout, 4 pane slots) becomes a
 * rootless view whose slots are the tab's visible occupied sessions in order;
 * empty v1 tabs are dropped (there is no launcher view kind anymore). Ids are
 * kept so `active` maps across. A v1 blob predates roots entirely, so every
 * migrated view is a plain session tab and `Home` is added afterwards by
 * `ensureHomeView()`.
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
          root: null,
          slots: sessions.map((id) => ({ kind: 'session', id })),
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
  const ctx: LoadCtx = { seen: new Set<string>(), home: false };
  let views: ViewState[] = [];
  let active: unknown = null;

  // Defaults first, so a missing key, a garbage value and a pre-A5 blob all
  // land in the same place: the panel open at FILES_W_DEFAULT.
  state.leftPanel = 'files';
  state.filesWidth = FILES_W_DEFAULT;

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
        const vv = validateView(v, ctx);
        if (vv !== null && views.length < MAX_VIEWS) views.push(vv);
      }
    }
    active = o.active;
    // Only a literal null means "the user closed it"; anything else (absent,
    // a stale string, a number) is the default wish.
    if (o.leftPanel === null) state.leftPanel = null;
    if (typeof o.filesWidth === 'number') state.filesWidth = clampFilesWidth(o.filesWidth);
  } else {
    // No v2 state: try migrating v1 (malformed v1 degrades to a clean start).
    let v1: unknown = null;
    try {
      v1 = JSON.parse(localStorage.getItem(STORAGE_KEY_V1) ?? 'null');
    } catch {
      v1 = null;
    }
    if (v1 !== null) {
      const m = migrateV1(v1, ctx.seen);
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
  // Zero SLOTS is the legal empty state (the handoff's): the launch dialog
  // opens on demand instead of a launcher tab being ever-present. Zero VIEWS
  // is not a state anymore — Home is always there, possibly empty.
  ensureHomeView();
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

/** Is this the fixed Home tab — the one that is never closed, dissolved or moved? */
function isHome(v: ViewState): boolean {
  return v.root?.kind === 'home';
}

/**
 * `Home` exists and is `state.views[0]` (user decision 2026-09-15, decision 4:
 * always present, always first, never draggable, never closable, never
 * dissolved — it may stand empty). Called at the top of `reconcileViews()` and
 * again in `loadUi()`; idempotent, and it never notifies — the callers own
 * their one save + notify.
 *
 * Returns whether it had to change anything.
 */
export function ensureHomeView(): boolean {
  const idx = state.views.findIndex(isHome);
  if (idx === 0) return false;
  if (idx > 0) {
    const [home] = state.views.splice(idx, 1);
    state.views.unshift(home as ViewState);
    return true;
  }
  state.views.unshift(newView({ kind: 'home' }, []));
  return true;
}

/**
 * The lowest strip position anything may be inserted at: nothing is ever
 * placed before `Home`.
 */
function firstMovableIndex(): number {
  return state.views.length > 0 && isHome(state.views[0] as ViewState) ? 1 : 0;
}

// --------------------------------------------------------------------------
// View geometry: slot insertion / removal for the fixed split shapes
// --------------------------------------------------------------------------

/** Index of a slot inside a view, by KEY — never by `indexOf` on a raw string. */
function indexOfSlot(v: ViewState, key: string): number {
  return v.slots.findIndex((s) => slotKey(s) === key);
}

/**
 * Insert panes into a view at (slot, zone). Kind-blind: a file splits a
 * terminal's pane exactly the way a terminal splits it. A single insert splits
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
 * File and diff slots are never touched here: a path is not a session id, and
 * a terminal exiting is no reason for the file beside it to vanish. A ROOTED
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

// --------------------------------------------------------------------------
// Files as panes (A10, user decision 2026-09-15)
// --------------------------------------------------------------------------
//
// A file opens FULL in the pane area, as a pane of the tab that belongs to its
// ROOT FOLDER — `Home`, or the project. Everything here is structural: it
// moves panes around, it never reads or writes a file, and it never decides
// anything about a session.

/** What an open-a-file request answered. */
export type OpenFileResult =
  /** The file is on screen, focused, in an active tab. */
  | 'ok'
  /** The target tab already shows 4 panes. */
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
 * Open a file as a pane of its root's tab, and go there. `label` is the name
 * the caller drew in its row — it says what the user clicked in the log; the
 * pane's own title is derived from the path (`slotTitle`), so no path can
 * reach a label by this route.
 *
 * A file already open in that tab is RAISED rather than opened twice: the
 * second click on a row must not spend the tab's last pane on a copy. (An
 * explicit split — `openFileAt` — may still put the same file in two panes;
 * they share one entry in `state.edits`.)
 */
export function openFile(root: ViewRoot, path: string, label: string): OpenFileResult {
  const v = viewForRoot(root);
  const key = fileTabId(path);
  const open = indexOfSlot(v, key);
  if (open === -1) {
    if (v.slots.length >= MAX_PANES) return 'full';
    insertSlots(v, 0, 'fill', [{ kind: 'file', path }]);
    log.debug(`file pane opened: view=${v.id} panes=${v.slots.length} name=${label}`);
  } else {
    v.focused = open;
  }
  state.activeViewId = v.id;
  saveUi();
  notify('ui');
  return 'ok';
}

/**
 * Open the READ-ONLY changes to one file in one commit, as a pane of its
 * root's tab (user decision 8, 2026-09-15: the A6 `Changes in <hash>` screen
 * survives as the third pane kind). The twin of `openFile`, and deliberately a
 * separate door: a diff has no unsaved text, no Save and no `f:` key, so the
 * two never share a code path that could give one the other's rights.
 *
 * Added in part A10 phase 1A, next to the phase 0 model: the commit view's
 * `Changes` button had nowhere else to go.
 */
export function openDiff(root: ViewRoot, hash: string, path: string): OpenFileResult {
  const v = viewForRoot(root);
  const open = indexOfSlot(v, diffTabId(hash, path));
  if (open === -1) {
    if (v.slots.length >= MAX_PANES) return 'full';
    insertSlots(v, 0, 'fill', [{ kind: 'diff', hash, path }]);
    log.debug(`diff pane opened: view=${v.id} panes=${v.slots.length} commit=${hash}`);
  } else {
    v.focused = open;
  }
  state.activeViewId = v.id;
  saveUi();
  notify('ui');
  return 'ok';
}

/**
 * Open a file at a PANE: `'replace'` puts it in that pane's place (the centre
 * of a file pane), a zone splits that pane (its edges). The centre of a
 * TERMINAL pane is refused — `'session-centre'` is what the caller flashes
 * "drop on an edge to split" for (user decision 7, 2026-09-15).
 */
export function openFileAt(
  viewId: string,
  slot: number,
  where: Zone | 'replace',
  path: string,
): OpenFileResult {
  const v = state.views.find((x) => x.id === viewId);
  if (v === undefined) return 'no-view';
  const target = v.slots[slot];
  if (target === undefined) return 'no-view';
  if (where === 'replace') {
    if (target.kind === 'session') return 'session-centre';
    v.slots[slot] = { kind: 'file', path };
    v.focused = slot;
    // The replaced pane may have been the last one showing its file.
    pruneOrphanEdits();
  } else {
    if (v.slots.length + 1 > MAX_PANES) return 'full';
    if (!dropZonesFor(v, slot, 1).includes(where)) return 'no-zone';
    insertSlots(v, slot, where, [{ kind: 'file', path }]);
  }
  state.activeViewId = v.id;
  log.debug(`file pane placed: view=${v.id} slot=${slot} at=${where} panes=${v.slots.length}`);
  saveUi();
  notify('ui');
  return 'ok';
}

/**
 * Forget the unsaved text of every file no pane shows any more (PROJECT-SCOPE:
 * it is dropped when the LAST pane showing that file closes — the same file in
 * two panes keeps sharing until both are gone). Called at the END of every
 * path that removes slots, never midway through a move, where slots are out of
 * one view on their way into another.
 */
function pruneOrphanEdits(): void {
  const live = new Set<string>();
  for (const v of state.views) {
    for (const s of v.slots) if (s.kind === 'file') live.add(slotKey(s));
  }
  for (const key of [...state.edits.keys()]) if (!live.has(key)) state.edits.delete(key);
}

/**
 * Close ONE pane — a file or a diff. A session pane is refused here: ending a
 * session is a different act with its own confirmation (the A3 rule), and
 * `removeSessionEverywhere` is the door for it.
 *
 * A PROJECT-rooted tab left with no panes at all is removed with its last file
 * (user decision 6, 2026-09-15) — unless a terminal is still in it, which is
 * simply "it still has a pane". `Home` stays, empty. Focus lands on a pane
 * that exists.
 */
export function closeSlot(viewId: string, index: number): boolean {
  const v = state.views.find((x) => x.id === viewId);
  if (v === undefined) return false;
  const slot = v.slots[index];
  if (slot === undefined || slot.kind === 'session') return false;
  removeAtSlot(v, index);
  if (v.slots.length === 0 && !isHome(v)) dissolveView(v.id);
  pruneOrphanEdits();
  log.debug(`file pane closed: view=${v.id} panes=${v.slots.length}`);
  saveUi();
  notify('ui');
  return true;
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
 * Tab status accent: amber attention > green running > gray exited, and
 * `'none'` for a tab holding no session at all (Home, or a folder tab showing
 * only files) — a status dot there would report on nothing.
 */
export function viewStatus(v: ViewState): 'attn' | 'run' | 'exit' | 'none' {
  const ids = sessionIds(v);
  if (ids.length === 0) return 'none';
  if (viewAttention(v)) return 'attn';
  const infos = ids.map((id) => state.sessions.get(id));
  if (infos.some((s) => s?.status === 'running')) return 'run';
  return 'exit';
}

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

/** Sessions that have not exited — the v3 `alive` list. */
export function aliveSessionCount(): number {
  let n = 0;
  for (const s of state.sessions.values()) if (s.status !== 'exited') n += 1;
  return n;
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

// --------------------------------------------------------------------------
// The pane area's other occupant (Nocturne A6): the commit view
// --------------------------------------------------------------------------
//
// It is not persisted and it owns no session. It decides WHAT FILLS THE MIDDLE
// ROW — something OTHER than the panes — which is why every change here
// notifies `'screen'` and why the chrome, never the panes themselves, reads
// it. Since A10 the editor column is NOT in this group: a file is a pane, so
// opening one notifies `'ui'` like any other pane change.

/** Open the full commit view over the pane area. */
export function openCommitView(hash: string): void {
  if (state.openCommit === hash) return;
  state.openCommit = hash;
  // A newly opened commit starts fully expanded: the collapse set is per
  // `<hash>:<path>`, so stale keys from an earlier commit can never hide a
  // block in this one, and dropping them keeps the set from growing forever.
  state.commitCollapsed = new Set();
  notify('screen');
}

/** Close it: the panes come back. Safe to call when nothing is open. */
export function closeCommitView(): void {
  if (state.openCommit === null) return;
  state.openCommit = null;
  state.commitCollapsed = new Set();
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
// Unsaved file text (A6, rekeyed by A10): one entry per FILE, not per pane
// --------------------------------------------------------------------------

/**
 * Record what the user typed, under the slot key `f:<path>`. NO notify: the
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
 * Save: forget the unsaved text and hand it back, so the CALLER writes it
 * where it belongs. Until part B4 that is the mock map in `ui/files-mock.ts`;
 * B4 makes the same call site a backend write. Saving a clean file returns
 * null and changes nothing.
 *
 * KNOWN GAP, part B4: there is no "you have unsaved changes" confirmation,
 * because until B4 nothing was ever read from disk and nothing can be written
 * to it — a modal about losing placeholder text would be theatre. The amber
 * dot on the pane header is the whole warning; B4 adds the confirm together
 * with the real file write, and has to cover all four doors the text falls out
 * of: closing the last pane showing the file (`pruneOrphanEdits`), reloading
 * the page, closing the window, and the backend's grace timer ending the app
 * after the last window closed.
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

/** The key a file at `path` is edited under — one spelling for every caller. */
export function editorFileId(path: string): string {
  return fileTabId(path);
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
