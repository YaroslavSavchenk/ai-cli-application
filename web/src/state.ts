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
 *
 * Split by O8 (2026-09-23): the store lives in `state-core.ts`, `state-persist.ts`,
 * `state-views.ts`, `state-editor.ts` and `state-chrome.ts`. This module is
 * their one public face — every name below is re-exported, so the importers
 * (`import * as st from './state.ts'`) did not change.
 */
export {
  type Layout,
  type Dir,
  type Zone,
  type L3,
  type DrawerView,
  type LeftPanel,
  type ChangeKind,
  MAX_PANES,
  MAX_TABS,
  type EditorTab,
  type EditorSlot,
  type PaneSlot,
  type ViewRoot,
  type ViewState,
  slotKey,
  sessionIds,
  FILES_W_MIN,
  FILES_W_MAX,
  FILES_W_DEFAULT,
  clampFilesWidth,
  state,
  subscribe,
  notify,
} from './state-core.ts';
export {
  SPLIT_MIN,
  SPLIT_MAX,
  setRunStamp,
  saveUi,
  type LoadUiOpts,
  loadUi,
  ensureHomeView,
  firstMovableIndex,
} from './state-persist.ts';
export {
  dropZonesFor,
  viewOfSession,
  reconcileViews,
  initServer,
  setSessions,
  upsertSession,
  setAttention,
  markSeenLocally,
  markExited,
  setSessionDims,
  removeSessionEverywhere,
  setHistory,
  removeHistory,
  clearHistory,
  setProjects,
  projectName,
  activeView,
  viewLayout,
  closeView,
  setActiveView,
  setActiveViewIndex,
  focusSession,
  moveActiveViewBy,
  reorderView,
  type MergeResult,
  mergeViews,
  moveSessionToView,
  extractSession,
  replaceSessionInView,
} from './state-views.ts';
export {
  type OpenFileResult,
  viewForRoot,
  newEditorSlot,
  activeTabOf,
  slotTabIds,
  type Eviction,
  evictionFor,
  evictionForOpen,
  openFile,
  openDiff,
  openTabAt,
  moveTab,
  moveTabToSplit,
  closeTab,
  setActiveTab,
  cycleTab,
  closeSlot,
  activeTabIndex,
  dirtyLostBy,
  setEdit,
  editorDirty,
  editText,
  saveEdit,
  retargetFiles,
  editorFileId,
} from './state-editor.ts';
export {
  focusPane,
  moveFocus,
  movePane,
  swapPanes,
  setSplit,
  viewAttention,
  viewStatus,
  attentionCount,
  toggleDrawer,
  openDrawer,
  toggleLeftPanel,
  setFilesWidth,
  filesPanelVisible,
  closeDrawer,
  openCommitView,
  closeCommitView,
  seedCommitCollapsed,
  noteCommitRepoRoot,
  commitFileCollapsed,
  toggleCommitFile,
  setWsLatency,
  setRuntime,
  setRestarting,
  setBackendReachable,
} from './state-chrome.ts';
