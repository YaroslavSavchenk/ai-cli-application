/**
 * File-pane model (Nocturne part A6, pruned by A10) — the arithmetic behind a
 * file shown in a pane, with no DOM and no state import, so `node --test` can
 * drive it.
 *
 * A pane showing a file or a diff is identified by an ID, and the ID says
 * which:
 *   `f:<path>`            a file, editable, saveable
 *   `d:<hash>:<path>`     the changes to that file in that commit, read-only
 * That id is `slotKey()` for those two pane kinds (state.ts) and the key their
 * unsaved text lives under in `state.edits` — so the same file open in two
 * panes shares one text (user decision 2026-09-15: a file is a PANE now, not a
 * tab in an editor column, and panes mix freely with terminals).
 *
 * Every function here is pure, so the rules — what an id means, how many lines
 * the gutter draws, what the Save button says — are testable without a browser.
 */

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
