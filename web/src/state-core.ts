/**
 * The core of the UI state store: every type the store is made of, the
 * limits, the ONE `state` object and the pub/sub (`subscribe` / `notify`).
 * It imports no other piece, so every piece can import it without a cycle.
 *
 * Split from `state.ts` (O8, 2026-09-23).
 * Siblings: `state-core.ts` (types, the store, pub/sub), `state-persist.ts`
 * (view constructors, localStorage save/load), `state-views.ts` (slot geometry,
 * view membership, server state, tabs), `state-editor.ts` (files as tabs of an
 * editor pane, unsaved text), `state-chrome.ts` (focus, drawers and the Files
 * panel, the commit view, connection readouts). `state.ts` re-exports them all.
 */
import type { HistoryEntry, Project, SessionInfo, UpdateStatus } from '../../shared/protocol.ts';


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

// Shared with the sibling pieces (O8 split glue); not part of the public face.
export { MAX_VIEWS, STORAGE_KEY, STORAGE_KEY_V1 };
