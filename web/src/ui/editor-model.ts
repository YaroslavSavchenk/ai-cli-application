/**
 * Editor model (Nocturne part A6) — the tab strip's arithmetic, with no DOM
 * and no state import, so `node --test` can drive it.
 *
 * The editor holds two kinds of tab and the ID says which:
 *   `f:<path>`            a file, editable, saveable
 *   `d:<hash>:<path>`     the changes to that file in that commit, read-only
 * An id is therefore also the dedupe key: opening the same file twice focuses
 * the tab that is already there instead of stacking a second copy of it.
 *
 * Every function here is pure and returns a NEW tab list, so the caller
 * (state.ts) stays a one-line assignment and the rules — dedupe, which tab
 * becomes active, which tab is dirty — are testable without a browser.
 */

/** One open editor tab. */
export interface EditorTab {
  /** `f:<path>` or `d:<hash>:<path>` — unique, and it carries the kind. */
  id: string;
  /** What the tab prints: a file NAME, never a path. */
  label: string;
  /** Repo-relative path the tab is about. */
  path: string;
  /** Diff tabs only: the commit whose changes are shown. */
  hash?: string;
}

/** The whole strip: the tabs in order, plus which one is up. */
export interface EditorState {
  tabs: EditorTab[];
  active: string | null;
}

export type TabKind = 'file' | 'diff';

/** What an id means. Unknown prefixes read as a file — the editable default. */
export function tabKind(id: string): TabKind {
  return id.startsWith('d:') ? 'diff' : 'file';
}

/** The id a file tab is opened under. */
export function fileTabId(path: string): string {
  return `f:${path}`;
}

/** The id a commit's per-file diff tab is opened under. */
export function diffTabId(hash: string, path: string): string {
  return `d:${hash}:${path}`;
}

/**
 * Open a tab, or focus the one already open under that id. The opened tab is
 * always the active one: opening a file the user cannot see would be a click
 * that did nothing.
 */
export function openTab(s: EditorState, tab: EditorTab): EditorState {
  const known = s.tabs.some((t) => t.id === tab.id);
  return { tabs: known ? s.tabs : [...s.tabs, tab], active: tab.id };
}

/**
 * Close a tab. The next active tab is the FIRST one left (the reference's own
 * rule) — a deterministic, always-existing target; closing a tab that was not
 * active leaves the active one alone. Closing the last tab leaves `null`,
 * which is what hides the whole editor column.
 */
export function closeTab(s: EditorState, id: string): EditorState {
  const tabs = s.tabs.filter((t) => t.id !== id);
  if (tabs.length === s.tabs.length) return s;
  const active = s.active === id ? (tabs[0]?.id ?? null) : s.active;
  return { tabs, active };
}

/** Raise an existing tab. An unknown id is ignored rather than blanking the body. */
export function setActive(s: EditorState, id: string): EditorState {
  if (!s.tabs.some((t) => t.id === id)) return s;
  return { tabs: s.tabs, active: id };
}

/** The active tab, or null when the editor is empty. */
export function activeTab(s: EditorState): EditorTab | null {
  return s.tabs.find((t) => t.id === s.active) ?? null;
}

/**
 * The line-number column beside the text. Derived from the text on every
 * keystroke, so it can never disagree with what is on screen.
 */
export function gutterText(text: string): string {
  const lines = text.split('\n').length;
  const out: string[] = [];
  for (let i = 1; i <= lines; i += 1) out.push(String(i));
  return out.join('\n');
}

/** `Save` while there are unsaved changes, `Saved` when there is nothing to write. */
export function saveLabel(dirty: boolean): string {
  return dirty ? 'Save' : 'Saved';
}
