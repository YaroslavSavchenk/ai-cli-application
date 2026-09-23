/**
 * Shared boot for the commit view tests (`tests/ui/ui-a6-screens*.test.ts`,
 * Nocturne A6, re-pointed by A10, LIVE since B3): the fake DOM, the REAL
 * `web/src/state.ts`, `ui/commit-view.ts`, `ui/commit-store.ts` and
 * `ui/commit-model.ts`, the fake commit gateway over the fixture history,
 * ONE commit view mounted on a host, and the per-test `resetScreen()`.
 *
 * Module-level on purpose: `installDom()` and the imports of the browser
 * modules must run in this order before any test, once per test file
 * (`node --test` gives every file its own process). Not a test.
 */
import {
  installDom,
  textsOf,
  type FakeElement,
} from './fake-dom.ts';
import { PROJ, makeFixture, settle } from './fs-fixture.ts';
import {
  REPO_ROOT,
  HEAD,
  NOW,
  detailOf,
} from './commits-fixture.ts';

export const dom = installDom();

export type EditorTab =
  | { kind: 'file'; path: string }
  | { kind: 'diff'; hash: string; path: string; root: string };
/**
 * A10b: a pane is a terminal or an EDITOR holding a strip of file/diff tabs.
 * The commit view's two openers go through `openFileGuarded` / `openDiffGuarded`
 * (ui/unsaved.ts, the B4 question in front of `st.openFile` / `st.openDiff`), so
 * what they produce is an editor SLOT whose strip holds the tab — never a
 * `file` slot, which no longer exists.
 */
export interface Slot {
  kind: 'session' | 'editor';
  id?: string;
  tabs?: EditorTab[];
  active?: number;
}

/** The tabs of every editor pane of a view, in pane then strip order. */
export function tabsOf(v: View): EditorTab[] {
  return v.slots.flatMap((s) => s.tabs ?? []);
}
export interface View {
  id: string;
  root: { kind: 'home' } | { kind: 'project'; id: string } | null;
  slots: Slot[];
  focused: number;
}
export interface StateModule {
  state: {
    openCommit: string | null;
    openCommitAt: { root: string; repoRoot: string | null } | null;
    commitCollapsed: Set<string>;
    edits: Map<string, string>;
    views: View[];
    activeViewId: string;
  };
  subscribe(fn: (kind: string) => void): void;
  openCommitView(hash: string, at: { root: string; repoRoot: string | null }): void;
  /** Part B3: the repository behind the open commit, learned late. */
  noteCommitRepoRoot(root: string, repoRoot: string): void;
  closeCommitView(): void;
  toggleCommitFile(hash: string, path: string): void;
  commitFileCollapsed(hash: string, path: string): boolean;
  activeView(): View | null;
  openFile(root: { kind: 'home' }, path: string, label: string): string;
  openDiff(root: { kind: 'home' }, hash: string, path: string, repoRoot: string): string;
  closeSlot(viewId: string, index: number): boolean;
  closeTab(viewId: string, slot: number, tabIndex: number): boolean;
  editorFileId(path: string): string;
  editorDirty(id: string | null): boolean;
  setEdit(id: string, text: string): void;
  saveEdit(id: string): string | null;
}

export const st = (await import(new URL('../../web/src/state.ts', import.meta.url).href)) as StateModule;
export const CV = (await import(new URL('../../web/src/ui/commit-view.ts', import.meta.url).href)) as {
  initCommitView(
    host: unknown,
    onLeaveScreen: () => void,
    onOpenPane: () => void,
    now?: () => number,
  ): { render(): void };
  /** The one diff renderer, shared with a diff PANE (ui/file-pane.ts). */
  diffBox(asked: unknown): FakeElement;
  OPEN_BLOCKS: number;
};
export const STORE = (await import(new URL('../../web/src/ui/commit-store.ts', import.meta.url).href)) as {
  setCommitGateway(gw: unknown): void;
  /** Every change the store makes; a reader's render signature carries it. */
  commitVersion(): number;
};
export const MODEL = (await import(new URL('../../web/src/ui/commit-model.ts', import.meta.url).href)) as {
  blockDomId(hash: string, path: string): string;
};

/**
 * THE BACKEND IS A FAKE (part B3). The commit view takes its two questions
 * through the gateway `ui/commit-store.ts` owns, injected here exactly as
 * main.ts injects the real one — so the whole screen, every state it passes
 * through and every request it does NOT make are driven with no HTTP and no
 * module stubbing.
 */
export const fx = makeFixture();
STORE.setCommitGateway(fx.gateway);

/**
 * The commit every test below opens, and the two roots it is read from — two
 * DIFFERENT folders on purpose: the panel asks git from the folder it is
 * standing in (`root`, here a subfolder), while a commit names its files
 * relative to the REPOSITORY (`repoRoot`). One value for both would make the
 * two-field design untestable: every assertion would pass whichever field the
 * code happened to read.
 */
export const C0 = detailOf(HEAD) as NonNullable<ReturnType<typeof detailOf>>;
export const ROOT = `${PROJ}/web`;
export const AT = { root: ROOT, repoRoot: REPO_ROOT };
export const F0 = C0.files[0] as { path: string; add: number | null; del: number | null };
export const F1 = C0.files[1] as { path: string; add: number | null; del: number | null };

export const commitHost = dom.doc.createElement('section');
dom.body.append(commitHost);

/** The view leaves in two directions; main.ts points both at the pane area. */
export let handBacks = 0;
export let paneHandovers = 0;
export const view = CV.initCommitView(
  commitHost,
  () => {
    handBacks += 1;
  },
  () => {
    paneHandovers += 1;
  },
  () => NOW,
);

/** The shell's own dispatch: the screen re-renders on every change. */
st.subscribe(() => {
  view.render();
});

export const commitRoot = commitHost.children[0] as FakeElement;

/** Open a commit the way the Files panel does, and let its answer land. */
export async function open(hash: string): Promise<void> {
  st.openCommitView(hash, AT);
  await settle();
}

/** The paths of the blocks currently drawn, in order. */
export function blockPaths(): string[] {
  return textsOf(commitRoot, 'diff-path');
}

/** The per-test reset: every commit-view file calls it from its own `beforeEach`. */
export async function resetScreen(): Promise<void> {
  st.state.openCommit = null;
  st.state.openCommitAt = null;
  st.state.commitCollapsed = new Set();
  st.state.edits = new Map();
  st.state.views = [];
  st.state.activeViewId = '';
  handBacks = 0;
  paneHandovers = 0;
  dom.doc.activeElement = dom.body;
  fx.reset();
  view.render();
  await settle();
}
