/**
 * The Files panel's shared context — split from `ui/files.ts` (O8,
 * 2026-09-23). Types plus one helper, no state of its own.
 *
 * `initFilesPanel()` was one closure; its regions now live in sibling pieces
 * (`files-tree.ts`, `files-git.ts`, `files-keys.ts`, `files-menu.ts`,
 * `files-naming.ts`, `files-render.ts`; the module-level destination answers
 * in `files-destinations.ts`). Every piece is a factory called ONCE per panel
 * with the same `ctx` object. Each piece of panel state is still ONE `let`,
 * declared in the piece that owns its region; what another piece reads or
 * writes goes through that owner's accessor on `ctx` — never a second copy.
 * The `*Part` interfaces below say which piece owns what; each owner builds
 * its part as that type. A member belongs on a part only while another piece
 * reads it, and it is writable only while another piece writes it.
 *
 * Why accessors and not one plain state object (Q4, 2026-09-23): a plain
 * object would let every piece write every field, and each owner would
 * reach its own state as `state.x` instead of its `let` — the name-row keys
 * included. The `readonly` members here are the one-owner rule, checked by
 * the compiler.
 */
import type * as st from '../state.ts';
import type { Selection } from './files-select-model.ts';
import type { MenuAction } from './context-menu-model.ts';
import type { TextRange } from './rename-model.ts';
import type { GitChangesResponse, GitCommitSummary } from '../../../shared/protocol.ts';
import type { Destination, FolderState, FsRow } from './fs-model.ts';
import type { Subject } from './files-destinations.ts';
import type { FsGateway } from './files.ts';

export type Tab = 'files' | 'changes' | 'commits';

/** Owned by `files.ts`. */
export interface CorePart {
  readonly wish: Tab;
  tab: Tab;
  readonly openFolders: Set<string>;
  selected: Selection;
  deleting: Set<string> | null;
  focusAfterDelete: { gone: ReadonlySet<string>; candidates: string[] } | null;
  readonly root: HTMLElement;
  readonly tabBtns: Map<Tab, HTMLButtonElement>;
  readonly projName: HTMLElement;
  readonly summary: HTMLElement;
  readonly sumAdd: HTMLElement;
  readonly sumDel: HTMLElement;
  readonly sumText: HTMLElement;
  readonly body: HTMLElement;
  readonly selHd: HTMLElement;
  readonly copyBtn: HTMLButtonElement;
  openRowMenuFor(key: string, at: { x: number; y: number }): void;
  syncCopyStrip(): void;
  subject(): Subject;
  currentRoot(): st.ViewRoot;
  pathIsOpen(path: string): boolean;
  openBeside(path: string, name: string): void;
  headerName(): string;
  readonly fs: FsGateway;
  readonly onLeaveScreen: () => void;
  readonly now: () => number;
}

/** Owned by `files-tree.ts`. */
export interface TreePart {
  readonly listings: Map<string, FolderState>;
  readonly inFlight: Map<string, number>;
  readonly generation: number;
  readonly dataVersion: number;
  bump(): void;
  fetchFolder(path: string): void;
  toggleFolder(path: string): void;
  stateRow(text: string, indent: number, danger: boolean): HTMLElement;
  readonly homePath: string | null;
  homeAsked: boolean;
  readonly currentPath: string | null;
  wasVisible: boolean;
  rootPath(): string | null;
  rootDestination(): Destination | null;
  syncRoot(): boolean;
  fileRows(): HTMLElement[];
}

/** Owned by `files-git.ts`. */
export interface GitPart {
  changes: GitChangesResponse | null;
  changesError: string | null;
  changesRoot: string | null;
  readonly changesOpen: Set<string>;
  fetchChanges(root: string): void;
  syncPoll(): void;
  readonly commits: GitCommitSummary[] | null;
  readonly commitsHead: string | null;
  readonly commitsError: string | null;
  readonly pageFlight: number | null;
  fetchCommits(root: string, skip: number): void;
  dropCommits(): void;
  repoKnown(): boolean;
  tabAvailable(t: Tab): boolean;
  visibleTab(): Tab;
  changeRows(): HTMLElement[];
  selectedHeader(): HTMLElement[];
  commitRows(): HTMLElement[];
}

/** Owned by `files-keys.ts`. */
export interface KeysPart {
  onRowClick(e: MouseEvent, key: string, activate: () => void): void;
  visibleKeys(): string[];
  activeRowEl(): HTMLElement | null;
  currentSelectedDest(): Destination | null;
}

/** Owned by `files-menu.ts`. */
export interface MenuPart {
  runMenuAction(action: MenuAction, key: string, path: string, name: string): void;
  actCount(clicked: string): number;
  isAnchor(path: string): boolean;
  isRenamable(path: string): boolean;
  runDelete(clicked: string | null, back: HTMLElement | null): void;
  openRootMenuAt(at: { x: number; y: number }): boolean;
  pointOf(t: Element | null): { x: number; y: number };
  armRowMenuChord(b: HTMLElement, key: string): void;
}

/** Owned by `files-naming.ts`. */
export interface NamingPart {
  readonly creating: { dir: string; kind: 'file' | 'folder'; error: string | null } | null;
  createText: string;
  readonly createBusy: boolean;
  nameInput: HTMLInputElement | null;
  liveNameInput(): HTMLInputElement | null;
  focusName: boolean;
  focusCreated: { key: string; dir: string } | null;
  rebuilding: boolean;
  startCreate(dir: string, kind: 'file' | 'folder'): void;
  dropNaming(why: 'menu' | 'tab' | 'root' | 'hidden'): void;
  refreshRoot(): void;
  refreshIfListed(path: string): void;
  insertNameRow(rows: HTMLElement[], model: readonly FsRow[], rootP: string): void;
  readonly renaming: { path: string; dir: boolean; error: string | null } | null;
  renameText: string;
  readonly renameBusy: boolean;
  renameRange: TextRange | null;
  renameStemDone: boolean;
  startRename(key: string): void;
  clearRename(): void;
  renameNote(path: string, dir: boolean): string | null;
  renameRowEls(r: FsRow): HTMLElement[];
}

/** Owned by `files-render.ts`. */
export interface RenderPart {
  lastSig: string;
  render(): void;
}

/** Everything one piece may reach in another, on the one object they share. */
export type FilesCtx = CorePart & TreePart & GitPart & KeysPart & MenuPart & NamingPart & RenderPart;

/**
 * Put one piece's members on `ctx`. Descriptors, not values: a state member is
 * a getter (and setter) over its owner's `let`, and copying its VALUE would
 * freeze a second copy of that state.
 */
export function share(ctx: object, part: object): void {
  Object.defineProperties(ctx, Object.getOwnPropertyDescriptors(part));
}
