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
 * The path back out of a file id (part B4): what `fileTabId` put in. The
 * unsaved-changes question is handed `state.edits` KEYS and has to name the
 * files, so this is the one place the prefix comes off again — and the name
 * itself is still `fileName`'s job, because a path never reaches a label.
 */
export function filePathOf(id: string): string {
  return id.startsWith('f:') ? id.slice(2) : id;
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

/**
 * The Save button's label while its write is out (part B4). It is the BUTTON
 * that says so, not a spinner and not a line in the bar: the control that was
 * pressed is the control that reports.
 */
export const SAVING_TEXT = 'Saving…';

/**
 * The status a rejected request carries, or null when it carries none (a
 * network failure, a gateway that is not there). The SENTENCE comes from
 * `messageOf` (ui/fs-model.ts); this is the other half of the same answer —
 * what the pane has to OFFER depends on which refusal it was.
 */
export function statusOf(err: unknown): number | null {
  if (err !== null && typeof err === 'object') {
    const e = err as { status?: unknown };
    if (typeof e.status === 'number') return e.status;
  }
  return null;
}

/**
 * Does this refusal put the user in front of a CHOICE (user decision D4)?
 *
 * 409 — the file changed on disk since it was read — and 404 — it is no longer
 * there — are the two the pane can answer in two honest ways: `Overwrite` (my
 * text wins, and for 404 recreates the file) or `Load from disk` (my changes
 * go). Every other refusal is a fact with nothing to choose between: 403, 413,
 * 415 and 500 are stated and the text stays unsaved.
 */
export function offersChoice(status: number | null): boolean {
  return status === 409 || status === 404;
}

/**
 * How the pane's one sentence is inked. A REFUSAL is danger ink — the app did
 * not do what was asked; a file that is simply GONE (404) is quiet ink, like
 * an empty folder in the Files panel: nothing went wrong, there is nothing
 * there. (The 404 that answers a SAVE is a different surface — the conflict
 * bar above — and carries its own two buttons.)
 */
export function sentenceTone(status: number | null): 'quiet' | 'bad' {
  return status === 404 ? 'quiet' : 'bad';
}

/**
 * Where the caret lands in text that changed under it (D3, and `Load from
 * disk`): the same offset, or the end of the new text when it is shorter.
 * Never a jump to 0 — a file that grew a line at the bottom must not send the
 * user back to the top.
 */
export function clampCaret(pos: number, length: number): number {
  if (!Number.isFinite(pos) || pos < 0) return 0;
  return Math.min(Math.trunc(pos), Math.max(0, length));
}

/**
 * The question asked before unsaved text is dropped (user decision D1,
 * 2026-09-22). NAMES, never paths (PROJECT-SCOPE, 2026-07-25), and a COUNT
 * once there are several — four file names in one sentence is a list, not a
 * question.
 *
 * An empty list has no question: the caller closes without asking.
 */
export function discardQuestion(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `Discard unsaved changes to ${names[0] as string}?`;
  return `Discard unsaved changes to ${names.length} files?`;
}
