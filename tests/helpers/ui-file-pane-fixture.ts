/**
 * Shared setup for `tests/ui/ui-file-pane*.test.ts` (Nocturne parts A10, B3,
 * B4): the DOM double, the REAL `web/src/state.ts`, `ui/file-pane.ts`,
 * `ui/commit-store.ts` and `ui/editor-store.ts` with the two backends plain
 * fakes (`tests/helpers/fs-fixture.ts` for git, `tests/helpers/editor-fixture.ts`
 * for files), the two files on the fake disk, and `mount()` / the body
 * helpers. Not a test. Each test file calls `resetPanes()` in its
 * `beforeEach`.
 */
import assert from 'node:assert/strict';
import { byClass, descendants, installDom, type FakeElement } from './fake-dom.ts';
import { makeFixture, settle } from './fs-fixture.ts';
import { makeEditor } from './editor-fixture.ts';

export const dom = installDom();

export interface StateModule {
  state: { edits: Map<string, string> };
  editorFileId(path: string): string;
  editorDirty(id: string | null): boolean;
  editText(id: string): string | undefined;
  setEdit(id: string, text: string): void;
  subscribe(fn: (kind: string) => void): void;
}
export interface Body {
  root: FakeElement;
  focus(): void;
  update(): void;
  dispose(): void;
}
export interface FilePaneModule {
  filePaneBody(path: string, onDirtyFlip: () => void): Body;
  diffPaneBody(root: string, hash: string, path: string): Body;
}

export const st = (await import(new URL('../../web/src/state.ts', import.meta.url).href)) as StateModule;
export const FP = (await import(new URL('../../web/src/ui/file-pane.ts', import.meta.url).href)) as unknown as FilePaneModule;
export const STORE = (await import(new URL('../../web/src/ui/commit-store.ts', import.meta.url).href)) as {
  setCommitGateway(gw: unknown): void;
};
export const ES = (await import(new URL('../../web/src/ui/editor-store.ts', import.meta.url).href)) as {
  setEditorGateway(gw: unknown): void;
  followerCount(): number;
  followTick(): void;
  FOLLOW_MS: number;
};

/** Part B3: a diff pane reads git through the gateway the commit store owns. */
export const fx = makeFixture();
STORE.setCommitGateway(fx.gateway);
/** Part B4: a file pane reads and writes through the gateway this store owns. */
export const ed = makeEditor();
ES.setEditorGateway(ed.gateway);

/** The shape every path in the app has since part B2: absolute. */
export const PATH = '/home/you/web/src/Pane.tsx';
export const OTHER = '/home/you/web/src/App.tsx';
export const ORIGINAL = 'export function Pane() {\n  return null;\n}\n';
/** One file of one commit, as the commit view hands it to a diff tab. */
export const DIFF_PATH = 'shared/protocol.ts';

export let flips = 0;
export let live: Body[] = [];

/** Build a body, put it on screen, and let its read land. */
export async function mount(path: string): Promise<FakeElement> {
  const body = FP.filePaneBody(path, () => {
    flips += 1;
  });
  live.push(body);
  // APPEND, never replace: two bodies on screen at once is a real state (two
  // panes of one file), and detaching one would silently take it out of the
  // disk follow — the very rule several cases below are about.
  dom.body.append(body.root);
  await settle();
  return body.root;
}

/** The one field a file pane offers, or null when it offers none. */
export function field(root: FakeElement): FakeElement | null {
  return descendants(root).find((n) => n.tagName === 'TEXTAREA') ?? null;
}

export function saveBtn(root: FakeElement): FakeElement {
  return byClass(root, 'pane-save')[0] as FakeElement;
}

/** The two answers a conflict offers, by label. */
export function act(root: FakeElement, label: string): FakeElement {
  const hit = byClass(root, 'pane-fact').find((b) => b.textContent === label);
  assert.ok(hit !== undefined, `no ${label} button in the bar`);
  return hit;
}

/**
 * The world every test starts from — each file's `beforeEach` calls it.
 * Whatever the last case held in flight is let go first, so one failure
 * cannot leave every later body waiting for an answer that never comes.
 */
export function resetPanes(): void {
  ed.releaseReads();
  ed.releaseWrites();
  for (const b of live) b.dispose();
  live = [];
  dom.body.replaceChildren();
  st.state.edits = new Map();
  ed.reads.length = 0;
  ed.writes.length = 0;
  ed.setFile(PATH, ORIGINAL);
  ed.setFile(OTHER, 'const a = 1;\n');
  flips = 0;
  dom.doc.activeElement = dom.body;
  dom.doc.visibilityState = 'visible';
}
