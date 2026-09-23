/**
 * Shared by the `web/src/state.ts` tests (`tests/ui/ui-state*.test.ts`): the
 * in-memory `localStorage` shim (same contract as Web Storage:
 * getItem/setItem/removeItem), the module itself imported AFTER it, the
 * storage keys mirrored from state.ts's source, `resetState()` for the module
 * singleton, and the slot/tab builders and readers every file uses.
 *
 * `crypto.randomUUID()` is a real Node global; no shim needed there.
 * Module-level on purpose: the shim must be installed before the import, once
 * per test file (`node --test` gives every file its own process). Not a test.
 */
import assert from 'node:assert/strict';
import type { SessionInfo } from '../../shared/protocol.ts';
import { MemoryStorage } from './fake-dom.ts';

export const memoryStorage = new MemoryStorage();
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = memoryStorage;

// Storage keys are private to state.ts (not exported); mirrored here from
// its source so this test writes/reads the exact same on-disk contract a
// real browser reload would.
export const STORAGE_KEY = 'ai-sm:ui:v2';
export const STORAGE_KEY_V1 = 'ai-sm:ui:v1';

// Imported AFTER the localStorage shim is installed (state.ts only touches
// it inside function bodies, never at module top level, so ordering here is
// belt-and-suspenders rather than load-bearing).
export const st = await import('../../web/src/state.ts');
// Types come from a static (erased) import; `st` itself is the runtime module,
// loaded after the localStorage shim above.
export type ViewState = import('../../web/src/state.ts').ViewState;
export type PaneSlot = import('../../web/src/state.ts').PaneSlot;
export type EditorSlot = import('../../web/src/state.ts').EditorSlot;
export type EditorTab = import('../../web/src/state.ts').EditorTab;
export type ViewRoot = import('../../web/src/state.ts').ViewRoot;

/**
 * `loadUi` as every test before part B6 meant it: `Reopen tabs on start` ON,
 * which is the factory setting — the run stamp is then never consulted, so a
 * boot that does not know its run (null) reads a bag the same way a browser
 * reload does. The D3 gate has its own tests in `tests/ui/ui-state-reopen.test.ts`.
 */
export const REOPEN: import('../../web/src/state.ts').LoadUiOpts = { reopen: true, run: null };

export function mkSession(id: string): SessionInfo {
  return {
    id,
    title: id,
    command: 'bash',
    args: [],
    cwd: '/tmp',
    status: 'running',
    cols: 80,
    rows: 24,
    createdAt: new Date().toISOString(),
    attention: false,
  };
}

/** Full reset of the module singleton between tests (no fresh-import isolation in ESM). */
export function resetState(): void {
  memoryStorage.clear();
  st.state.sessions = new Map();
  st.state.projects = [];
  st.state.history = [];
  st.state.views = [];
  st.state.activeViewId = '';
  st.state.drawer = null;
  st.state.leftPanel = 'files';
  st.state.filesWidth = st.FILES_W_DEFAULT;
  st.state.edits = new Map();
  st.state.wsLatencyMs = null;
  st.state.serverStartedAt = null;
  st.state.backendReachable = true;
}

/** The fixed first tab, as the app sees it after any load. */
export function home(): ViewState {
  const v = st.state.views[0] as ViewState;
  assert.equal(v?.root?.kind, 'home', 'precondition: Home is views[0]');
  return v;
}

/** Put a view in the strip by hand (state.ts exposes no constructor). */
export function addView(root: ViewRoot | null, slots: PaneSlot[], id: string = crypto.randomUUID()): ViewState {
  const v: ViewState = { id, root, slots, focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } };
  st.state.views.push(v);
  return v;
}

export const E = await import('../../web/src/ui/editor-model.ts');

/** The folder every diff tab below is read from (part B3). */
export const REPO = '/home/you/projects/app';

/**
 * The three files the persistence tests open. ABSOLUTE, because that is the
 * shape every path in the app has had since part B2 — and since part B4 the
 * storage reader refuses anything else (a relative path names no file).
 */
export const A = '/home/you/web/src/Pane.tsx';
export const B = '/home/you/web/src/App.tsx';
export const C = '/home/you/README.md';
/** A commit hash as every answer carries it: the full 40 hex, lower case. */
export const HASH40 = 'a'.repeat(40);

export const sess = (id: string): PaneSlot => ({ kind: 'session', id });
export const ftab = (path: string): EditorTab => ({ kind: 'file', path });
export const dtab = (hash: string, path: string): EditorTab => ({ kind: 'diff', hash, path, root: REPO });
/** The folder a diff tab is read from (B3) — one repository for the whole file. */
/** An editor pane holding these files as tabs (A10b: files are TABS, not panes). */
export const ed = (...paths: string[]): EditorSlot => st.newEditorSlot(paths.map(ftab));
/** An editor pane holding these tabs verbatim (for diffs, or a chosen active). */
export const edTabs = (...tabs: EditorTab[]): EditorSlot => st.newEditorSlot(tabs);
export const keys = (v: ViewState): string[] => v.slots.map((s: PaneSlot) => st.slotKey(s));
/**
 * A view's PANES, readable: a session's key, or the tab ids of an editor pane.
 * Editor slot keys are a page-lifetime counter (`e:<n>`), so a test that named
 * them would break every time another test opened a pane first — the shape a
 * reader cares about is "which panes, holding which tabs".
 */
export const shape = (v: ViewState): (string | string[])[] =>
  v.slots.map((s: PaneSlot) => (s.kind === 'session' ? st.slotKey(s) : st.slotTabIds(s)));
/** The strip of one editor pane, by slot index. */
export const strip = (v: ViewState, slot: number): string[] => st.slotTabIds(v.slots[slot] as PaneSlot);
/** Which tab that pane is showing. */
export const activeId = (v: ViewState, slot: number): string | null => {
  const t = st.activeTabOf(v.slots[slot] as PaneSlot);
  return t === null ? null : E.tabIdOf(t);
};

export function collectKinds(): { kinds: string[] } {
  const kinds: string[] = [];
  st.subscribe((k) => {
    kinds.push(k);
  });
  // state.ts exposes no unsubscribe (subscribe-once-forever is the real app's
  // usage pattern) — each test's listener keeps firing into its own closed-
  // over array for the rest of the run, which is harmless here.
  return { kinds };
}
