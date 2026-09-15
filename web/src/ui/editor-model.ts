/**
 * File-tab model (Nocturne part A6, pruned by A10, re-tabbed by A10b) — the
 * arithmetic behind a file shown in an editor pane, with no DOM and no runtime
 * state import, so `node --test` can drive it.
 *
 * A file or a diff open in a strip is identified by an ID, and the ID says
 * which:
 *   `f:<path>`            a file, editable, saveable
 *   `d:<hash>:<path>`     the changes to that file in that commit, read-only
 * That id is the key its unsaved text lives under in `state.edits` — so the
 * same file open in two panes shares one text.
 *
 * It is NOT the pane's identity: an editor pane's `slotKey()` is its own
 * generated `e:<n>` (state.ts), because a key derived from the active tab
 * would make every tab add / close / switch look like a different pane.
 * TAB ID ≠ SLOT KEY.
 *
 * Every function here is pure, so the rules — what an id means, how many lines
 * the gutter draws, what the Save button says — are testable without a browser.
 */
import type { EditorTab } from '../state.ts';

export type TabKind = 'file' | 'diff';

/** What an id means. Unknown prefixes read as a file — the editable default. */
export function tabKind(id: string): TabKind {
  return id.startsWith('d:') ? 'diff' : 'file';
}

/** The id a file pane is opened under. */
export function fileTabId(path: string): string {
  return `f:${path}`;
}

/** The id a commit's per-file diff pane is opened under. */
export function diffTabId(hash: string, path: string): string {
  return `d:${hash}:${path}`;
}

/**
 * The id of a tab — `fileTabId` / `diffTabId` by another name, so that every
 * caller holding an `EditorTab` has ONE spelling of the `state.edits` key and
 * none of them re-derives it from the parts.
 */
export function tabIdOf(t: EditorTab): string {
  return t.kind === 'file' ? fileTabId(t.path) : diffTabId(t.hash, t.path);
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
