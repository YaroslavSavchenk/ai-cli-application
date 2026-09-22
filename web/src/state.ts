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
 * holds 0..4 SLOTS in a split, and a slot is a terminal or an EDITOR pane —
 * one pane holding a strip of file/diff tabs (A10b) — and they mix freely
 * inside one tab. A fresh session is a single-pane
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
import { diffTabId, fileTabId, tabIdOf } from './ui/editor-model.ts';
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
/**
 * How many file tabs ONE editor pane holds — files and diffs together (part
 * B4 amendment, user's ask 2026-09-22: "ik kan oneindig veel tabs open
 * hebben, limiteer dat met 4"). It is the LIVE cap and the STORED one at
 * once: opening a fifth file evicts the tab in the last position
 * (`evictForAdd`), and the writer and the hostile-bag reader both stop here
 * (`persistView`, `validateTabs`), so a hand-edited blob cannot conjure a
 * strip nobody could have arranged.
 *
 * The number is the pane count's (`MAX_PANES`) on purpose: four chips is what
 * a 26px strip shows without scrolling in the narrowest pane a 2x2 has.
 */
export const MAX_TABS = 4;
const STORAGE_KEY = 'ai-sm:ui:v2';
const STORAGE_KEY_V1 = 'ai-sm:ui:v1';

/**
 * One entry of an editor pane's file-tab strip (A10b, user decision
 * 2026-09-15): an editable file, or the read-only changes to a file in one
 * commit. Its ID (`tabIdOf`, ui/editor-model.ts) is the key its unsaved text
 * lives under in `state.edits`.
 */
export type EditorTab =
  | { kind: 'file'; path: string }
  | {
      kind: 'diff';
      /** The commit's own 40-hex hash: the IDENTITY (the chip shows 7 of it). */
      hash: string;
      /** Repository-relative, as `git show` names it. */
      path: string;
      /**
       * The folder this diff is READ from (part B3) — the same root the Files
       * panel asks git with (`state.openCommitAt.root`), carried on the tab
       * because the tab outlives the commit view it was opened from and a pane
       * may never guess where a repository is. NOT the repository root: see
       * `openDiff`, whose parameter is named `requestRoot` for this reason.
       */
      root: string;
    };

/**
 * A pane holding files: ONE pane per group, with an inner strip of file tabs
 * (user decision 1, A10b). It REPLACES A10's `file` and `diff` slot kinds —
 * two representations of "a file on screen" is the alias trap, so there is
 * exactly one.
 *
 * INVARIANTS, held by every mutator below: `tabs` is never empty while the
 * slot lives (the last tab closing closes the PANE, via `closeSlot`), and
 * `0 <= active < tabs.length` (clamped by the private `clampActive`, never
 * asserted — a clamp cannot leave the user staring at a blank pane).
 *
 * `id` is the slot's OWN identity, generated once by `newEditorSlot` and never
 * derived from what it shows. TAB ID ≠ SLOT KEY: a key derived from the active
 * tab would make every tab add / close / switch look like a DIFFERENT pane to
 * `ui/panes.ts` (teardown, caret lost, focus stolen).
 */
export interface EditorSlot {
  kind: 'editor';
  /** `e:<n>`, unique for the life of the page; `slotKey()` returns it verbatim. */
  id: string;
  /** Never empty: the last tab to leave takes the pane with it. */
  tabs: EditorTab[];
  /** Index into `tabs`, always in range. */
  active: number;
}

/**
 * What one pane shows (A10, reshaped by A10b 2026-09-15). The two kinds mix
 * freely inside one tab: an editor pane may sit beside a terminal.
 */
export type PaneSlot = { kind: 'session'; id: string } | EditorSlot;

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
 * The identity of a PANE — what `ui/panes.ts` keeps or tears down, and what
 * every mutator here holds on to across a 2x2 remap instead of an index.
 *
 * TAB ID ≠ SLOT KEY (A10b). An editor pane answers its own generated `e:<n>`,
 * which does not change when its tabs do; the key a file's unsaved text lives
 * under is `tabIdOf(tab)` (`slotTabIds` lists them), and those two strings are
 * deliberately from different alphabets.
 */
export function slotKey(s: PaneSlot): string {
  return s.kind === 'session' ? `s:${s.id}` : s.id;
}

/** The session ids a view holds, in slot order (editor slots are skipped). */
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
   * The commit whose full view covers the pane area (Nocturne A6), by its
   * 40-hex hash since part B3; null = the panes are on screen. NOT persisted:
   * it is a place the user is standing, not a preference, and a reload that
   * reopened a commit view over a running session would hide the terminal for
   * no reason.
   */
  openCommit: string | null;
  /**
   * WHERE that commit is read from (part B3), captured when it was opened so
   * the screen cannot change repository under itself while the panel's focus
   * moves on:
   *
   *   - `root` is the folder the request is made from — the same root the
   *     Changes tab sends, so one boundary check covers both;
   *   - `repoRoot` is the repository the commit's paths are relative to
   *     (`GitChangesResponse.repoRoot`), and it is what makes `Open file` hand
   *     `openFile` the absolute path every other row in the panel hands it.
   *     It is NULL until that answer is in: the history and the repository are
   *     two requests, and the history can win the race (a root change nulls
   *     the Changes answer while the list is still on screen). A commit opens
   *     either way — only `Open file` waits, and says so
   *     (`noteCommitRepoRoot` fills it the moment the answer lands).
   *
   * Null exactly when `openCommit` is.
   */
  openCommitAt: { root: string; repoRoot: string | null } | null;
  /**
   * Which file blocks inside the open commit are COLLAPSED (`<hash>:<path>`).
   * Collapsed rather than expanded, so a commit opens with its whole diff
   * visible — the reference's own default. Not persisted, like the view.
   */
  commitCollapsed: Set<string>;
  /**
   * Unsaved file text per TAB ID — `f:<path>` (`tabIdOf`), so the key is the
   * FILE and never the pane it happens to sit in. A tab with an entry here is
   * DIRTY (the amber dot on its chip); Save removes it once the write has
   * LANDED, and two strips showing the same file share the one entry.
   *
   * NOT PERSISTED (part B4, user decision D2): the open tabs survive a reload,
   * the text in them does not. It was never on disk, and a bag of localStorage
   * is not where a user's work is kept — which is why every door that would
   * drop an entry asks first (`dirtyLostBy`, `ui/unsaved.ts`) and a reload
   * goes through the browser's own question.
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
  openCommitAt: null,
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
 * What one view looks like in storage: its root, its SLOTS — terminals and
 * editor panes alike — and where the focus sat.
 *
 * EDITOR SLOTS PERSIST (user decision D2, 2026-09-22). Until part B4 their
 * tabs' text was never read from disk, so a reload that resurrected them would
 * have resurrected placeholder content; now a file tab is a path the app can
 * read again and a diff tab a commit that cannot change, so both come back.
 * The unsaved TEXT does not (`state.edits` is not persisted): it was never on
 * disk, and a bag of localStorage is not where a user's work is kept.
 *
 * `focused` is no longer remapped away from an editor pane: a tab whose
 * focused pane held files comes back with the focus on those files.
 */
function persistView(v: ViewState): Record<string, unknown> {
  return {
    id: v.id,
    root: v.root,
    slots: v.slots.map((s) =>
      s.kind === 'session'
        ? { kind: 'session', id: s.id }
        : {
            // The slot's own `e:<n>` is NOT written: it is the identity of a
            // pane on THIS page (ui/panes.ts keys its live panes by it), and a
            // reload builds new panes. `newEditorSlot` hands out a fresh one.
            kind: 'editor',
            tabs: s.tabs.slice(0, MAX_TABS).map((t) =>
              t.kind === 'file'
                ? { kind: 'file', path: t.path }
                : { kind: 'diff', root: t.root, hash: t.hash, path: t.path },
            ),
            active: s.active,
          },
    ),
    focused: Math.min(Math.max(0, v.focused), Math.max(0, v.slots.length - 1)),
    l3: v.l3,
    split: v.split,
  };
}

/**
 * The run stamp read out of the stored bag at `loadUi` (Nocturne B6, D3). A
 * boot whose `GET /api/runtime` has not answered — or failed — knows no run of
 * its own; writing `run: null` over a good stamp would turn the next boot's
 * "same run" into "another run" and drop the tabs. So a save with nothing to
 * say keeps what was there.
 */
let lastKnownRun: string | null = null;

/** True once `loadUi` has run: before that a save would write an empty bag. */
let uiLoaded = false;

/**
 * Adopt the run a restart/update handed over to (Nocturne B6, D3) and stamp the
 * bag with it, so the `location.reload()` that follows reads the bag as its OWN
 * run and keeps the tabs with `Reopen tabs on start` off. A no-op before
 * `loadUi`: a save then would write `views: []` over the user's arrangement.
 */
export function setRunStamp(startedAt: string): void {
  state.serverStartedAt = startedAt;
  if (!uiLoaded) return;
  saveUi();
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
        // WHICH BACKEND RUN wrote this arrangement (Nocturne B6, user decision
        // D3): the run's start time, and while this boot does not know it yet
        // the stamp the bag already carried — never a null over a known run.
        // `loadUi` compares it with the run that is booting to
        // tell a reload (same run, the tabs stay) from a new app start (another
        // run, the `Reopen tabs on start` switch decides). No version bump: a
        // bag written before B6 simply has no stamp, which reads as "another
        // run" — the honest answer for a blob from a process that is gone.
        run: state.serverStartedAt ?? lastKnownRun,
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
 * Validate one stored v2 view: its root and its SLOTS — sessions AND editor
 * panes (part B4, user decision D2). A view without slots is dropped unless it
 * is Home, which is the fixed first tab and is allowed to stand empty; a view
 * holding only editor panes is a view with slots and SURVIVES.
 *
 * STORAGE IS HOSTILE, so every value is gated rather than trusted: a file
 * tab's path must be a non-empty ABSOLUTE path with no NUL byte (the shape
 * every path in this app has since part B2 — a relative one would be read
 * against nothing), a diff tab needs the full 40-hex hash and the folder it is
 * read from, an unknown tab kind is dropped, a strip is capped at `MAX_TABS`,
 * and a slot left with no valid tab at all is dropped with them (an editor
 * pane with an empty strip is not a state this model has).
 *
 * This is also the migration for two older shapes under the same v2 key (the
 * reader has always ignored what it does not know): pre-R3 launcher views
 * (kind: 'launcher', zero sessions) simply vanish, and a pre-A10 blob's
 * `sessions: string[]` is read as session slots, so an arrangement made before
 * A10 survives the upgrade. A pre-B4 blob simply carries no editor slot.
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
      if (s === null || typeof s !== 'object') continue;
      const slot = s as Record<string, unknown>;
      if (slot.kind === 'session') {
        addSession(slot.id);
        continue;
      }
      if (slot.kind !== 'editor' || slots.length >= MAX_PANES) continue;
      const tabs = validateTabs(slot.tabs);
      // No tab survived the gates: there is no pane to build. The strip is
      // never empty while the slot lives, so an empty one cannot be loaded.
      if (tabs.length === 0) continue;
      const made = newEditorSlot(tabs);
      const activeRaw = typeof slot.active === 'number' ? Math.trunc(slot.active) : 0;
      made.active = Math.min(Math.max(0, activeRaw), tabs.length - 1);
      slots.push(made);
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

/** How long a stored path may be. Past this it is not a path any OS has. */
const MAX_STORED_PATH = 4096;

/**
 * A stored path: a non-empty string, no NUL byte, and no longer than a real
 * path can be. The cap is the reader's: a blob is hand-editable, and a
 * megabyte-long "path" would be carried into every chip label and every
 * request this tab makes.
 */
function storedPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  if (raw.length > MAX_STORED_PATH) return null;
  return raw.includes('\0') ? null : raw;
}

/**
 * The tabs of one stored editor slot, in order, gated one by one. Anything the
 * reader cannot make sense of is DROPPED rather than repaired: a tab about a
 * path that is not a path names no file, and a chip nobody can open is worse
 * than a chip that is not there.
 */
function validateTabs(raw: unknown): EditorTab[] {
  if (!Array.isArray(raw)) return [];
  const out: EditorTab[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    if (out.length >= MAX_TABS) break;
    if (t === null || typeof t !== 'object') continue;
    const tab = t as Record<string, unknown>;
    if (tab.kind === 'file') {
      const path = storedPath(tab.path);
      // ABSOLUTE only: every path the app opens a file by is absolute (part
      // B2), and a relative one would be read against a folder nobody named.
      if (path === null || !path.startsWith('/')) continue;
      const id = fileTabId(path);
      if (seen.has(id)) continue; // one strip never shows one file twice
      seen.add(id);
      out.push({ kind: 'file', path });
      continue;
    }
    if (tab.kind === 'diff') {
      const hash = typeof tab.hash === 'string' ? tab.hash : '';
      // The full 40 hex, as every hash in this app is (PLAN-B3): an
      // abbreviation is not an identity.
      if (!/^[0-9a-f]{40}$/.test(hash)) continue;
      // A diff path is REPOSITORY-relative (git's own spelling), so it is not
      // asked to be absolute; the root it is read from is.
      const path = storedPath(tab.path);
      const diffRoot = storedPath(tab.root);
      // The ROOT is absolute, like every other folder the app reads git in: a
      // relative one would be resolved against a folder nobody named.
      if (path === null || diffRoot === null || !diffRoot.startsWith('/')) continue;
      const id = diffTabId(hash, path);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ kind: 'diff', hash, path, root: diffRoot });
      continue;
    }
    // An unknown kind is a future build's blob or a hand-edit: dropped.
  }
  return out;
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

/** What the boot has to tell `loadUi` about this run (Nocturne B6, D3). */
export interface LoadUiOpts {
  /**
   * The `Reopen tabs on start` preference (ui/prefs-model.ts). False = the
   * stored tabs are for the PREVIOUS app start only: a new backend run opens
   * on Home instead of restoring them.
   */
  reopen: boolean;
  /**
   * This backend run's start time (`state.serverStartedAt`), or null when the
   * runtime answer has not landed yet. It is the identity a stored bag is
   * compared against — never a clock reading, because the question is "is this
   * the same backend process", not "how long ago".
   */
  run: string | null;
}

/**
 * Rehydrate views from v2 storage; when only a v1 blob exists, migrate it
 * (then drop the v1 key). Prunes against the server's sessions and ensures
 * every server session has a view.
 *
 * With `reopen: false` the views are read only when the bag belongs to the run
 * that is booting — the reload inside one run (F5, the reload after `Restart
 * service` or an update) keeps the arrangement, a NEW app start drops it and
 * opens on Home (user decision D3, .claude/plans/nocturne/PLAN-B6.md). The
 * Files panel's open state and width are panel wishes, not tabs: restored
 * either way.
 */
export function loadUi(opts: LoadUiOpts): void {
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
  // Which run wrote what is stored. Anything that is not a string — absent (a
  // pre-B6 bag, or a v1 blob), a number, a hand-edited object — reads as null,
  // which equals only a boot that does not know its own run either.
  const bag =
    parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  const bagRun = typeof bag?.run === 'string' ? bag.run : null;
  lastKnownRun = bagRun;
  // The D3 gate, BEFORE anything is validated: with the switch off, a bag from
  // another run is not this window's arrangement at all. Sessions never survive
  // a backend run anyway, so what is dropped here is the editor tabs, the
  // folder tabs, the empty views, their names, their order and which one was
  // active — nothing that is running.
  // A boot that does not know its own run (the runtime read has not landed,
  // or failed) knows nothing AGAINST this bag either: unknown keeps the tabs.
  const keepViews = opts.reopen || opts.run === null || bagRun === opts.run;
  if (bag !== null) {
    const o = bag;
    if (keepViews) {
      if (Array.isArray(o.views)) {
        for (const v of o.views) {
          const vv = validateView(v, ctx);
          if (vv !== null && views.length < MAX_VIEWS) views.push(vv);
        }
      }
      active = o.active;
    }
    // The left panel is a PANEL wish, not a tab: it is restored whether or not
    // the tabs are (user decision D3). Only a literal null means "the user
    // closed it"; anything else (absent, a stale string, a number) is the
    // default wish.
    if (o.leftPanel === null) state.leftPanel = null;
    if (typeof o.filesWidth === 'number') state.filesWidth = clampFilesWidth(o.filesWidth);
  } else {
    // No v2 state: try migrating v1 (malformed v1 degrades to a clean start).
    // A v1 blob carries no run stamp, so with the switch off it is another
    // run's arrangement by definition — the same gate applies to it.
    let v1: unknown = null;
    try {
      v1 = JSON.parse(localStorage.getItem(STORAGE_KEY_V1) ?? 'null');
    } catch {
      v1 = null;
    }
    if (v1 !== null && keepViews) {
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
  uiLoaded = true;
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

/** ctrl+alt+w on an editor pane: close the tab the user is looking at. */
export function closeActiveTab(viewId: string, slot: number): boolean {
  const v = state.views.find((x) => x.id === viewId);
  const s = v?.slots[slot];
  if (v === undefined || s === undefined || s.kind !== 'editor') return false;
  return closeTab(viewId, slot, s.active);
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
