/**
 * Slot model (Nocturne part A10, re-tabbed by A10b, user decision 2026-09-15)
 * — the pure rules behind panes that may be a terminal or an editor holding
 * file/diff tabs: which tab a file belongs to, what a tab, a pane and a file
 * chip are CALLED, and which drop zone a pointer is over.
 *
 * No DOM and no state: every value a rule needs is handed in, so `node --test`
 * drives all of it and the drag layer can be tested without a browser. (The
 * type imports are erased at runtime; the two value imports are
 * `ui/commit-model.ts`, which is pure arithmetic and copy for the same
 * reason, and `ui/files-model.ts`'s file-type classifier, pure as well.)
 *
 * Copy rules this file enforces, not just follows:
 * - A PATH NEVER REACHES A LABEL. A tab about a project prints the project's
 *   NAME (PROJECT-SCOPE, 2026-07-25), Home prints `Home`, and a file chip
 *   prints the last segment of its path.
 */
import { shortHashOf } from './commit-model.ts';
import { fileIconFor, type FileIcon } from './files-model.ts';
import type { EditorTab, PaneSlot, ViewRoot, Zone } from '../state.ts';

/**
 * How much of a pane, on each side, means "split here" instead of "show this
 * file here". Same fraction the tab strip already uses for its own edges
 * (`TAB_EDGE_FRACTION`, ui/dnd.ts), so one number describes every edge band in
 * the app: outer quarter = edge, middle half = centre.
 */
export const EDGE_FRACTION = 0.25;

/** The part of a drop that is not a split: the pane's content is replaced. */
export type DropWhere = Zone | 'replace';

/** What the Files panel is showing, reduced to the two facts a root needs. */
export interface Subject {
  /** The panel's header reads `Home`: there is no project behind it. */
  home: boolean;
  /** The focused session's project, when it has one. */
  projectId?: string | null;
}

/**
 * Which tab a file opened from the Files panel belongs to. Three cases, and
 * the third is the A10 gap part B2 closes with the real file-browser root:
 *
 *   Home                              -> the Home tab
 *   a session WITH a project          -> that project's folder tab
 *   a session WITHOUT a project       -> the Home tab
 */
export function rootForSubject(s: Subject): ViewRoot {
  if (s.home) return { kind: 'home' };
  const id = s.projectId ?? null;
  return id === null || id === '' ? { kind: 'home' } : { kind: 'project', id };
}

/**
 * What a TAB is called: the root's name, or — for a plain session tab — its
 * panes' own names joined by a comma and a space (the v3 copy rule for a
 * multi-pane tab; plain language, no decorative separator).
 *
 * `projectName` is handed in (state.ts owns the project list) and may answer
 * null for a project that was deleted under an open tab; the panes' names then
 * stand in, because a tab must say something and that something can never be a
 * path.
 */
export function viewLabel(
  root: ViewRoot | null,
  projectName: (id: string) => string | null,
  slotTitles: string[],
): string {
  const joined = slotTitles.join(', ');
  if (root === null) return joined === '' ? '…' : joined;
  if (root.kind === 'home') return 'Home';
  const name = projectName(root.id);
  if (name !== null && name !== '') return name;
  return joined === '' ? '…' : joined;
}

/**
 * What one FILE TAB is called (its chip in the pane's strip, A10b). A file
 * prints the last segment of its path and nothing else; a diff says which
 * commit it shows (the A6 wording) — by its SHORT hash since part B3, while
 * the tab's identity stays the full one: a chip is no place to read 40
 * characters, and two commits that share a path are told apart by the id
 * behind it, not by eye.
 */
export function tabTitle(tab: EditorTab): string {
  return tab.kind === 'file' ? fileName(tab.path) : `Changes in ${shortHashOf(tab.hash)}`;
}

/** A diff tab's icon: it shows what git says changed, so it wears git's mark. */
export const DIFF_TAB_ICON: FileIcon = Object.freeze({ icon: 'git', kind: 'git' });

/**
 * The icon an editor tab wears (part B12) — on its own chip and, for the
 * pane that comes first in a tab, on the tab strip: a file its type's icon
 * (by NAME, the classifier's input), a diff git's mark.
 */
export function tabIcon(tab: EditorTab): FileIcon {
  return tab.kind === 'file' ? fileIconFor(fileName(tab.path)) : DIFF_TAB_ICON;
}

/**
 * What a PANE is called: the header, and the name the tab chip borrows for a
 * single-pane tab. An editor pane is called after the tab it is SHOWING, so
 * the chrome follows the strip; a session prints its own title, with the same
 * `…` stand-in the tab strip has always used for a session the browser has not
 * heard about yet — and for an editor pane with nothing in it, a state the
 * model does not produce (`tabs` is never empty while the slot lives).
 */
export function slotTitle(slot: PaneSlot, sessionTitle?: string | null): string {
  if (slot.kind === 'session') {
    return sessionTitle !== undefined && sessionTitle !== null && sessionTitle !== ''
      ? sessionTitle
      : '…';
  }
  const active = slot.tabs[Math.min(Math.max(0, slot.active), slot.tabs.length - 1)];
  return active === undefined ? '…' : tabTitle(active);
}

/** The last segment of a path — the only part of it any label may show. */
export function fileName(path: string): string {
  const segments = path.split('/').filter((s) => s !== '');
  return segments[segments.length - 1] ?? path;
}

/** Just enough of a DOMRect to do the arithmetic (and what one already is). */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a pointer at (x, y) over `rect` wants the file to land, given the
 * split zones that pane can still offer (`dropZonesFor`).
 *
 * The bands are ui/dnd.ts's, with the centre the file drag needs carved out of
 * them: the outer `EDGE_FRACTION` on the axis the pane can split along is that
 * split, the middle is `'replace'` — which since A10b ADDS the file as a TAB
 * of the editor pane under the pointer (orchestrator default 4: a drop never
 * throws away the other files in that strip), and on a terminal pane is
 * refused by `openTabAt`. This function answers the geometry, never the kind;
 * the name `'replace'` is kept because it is the drop layer's word for "the
 * middle", not a promise about what happens there.
 *
 * With NO zones left (a full tab, or the short pane of a 3-split) only the
 * centre still answers: replacing a pane costs no pane. The edges return null
 * so the caller can flash its rejection instead of quietly replacing something.
 */
export function zoneForPoint(rect: Rect, zones: Zone[], x: number, y: number): DropWhere | null {
  if (zones.includes('fill')) return 'fill';
  // A pane that has not been laid out yet has no bands to speak of; the centre
  // is the answer that cannot land a pane somewhere the user did not point at.
  if (!(rect.width > 0) || !(rect.height > 0)) return 'replace';
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  if (zones.includes('left') || zones.includes('right')) {
    if (fx < EDGE_FRACTION) return 'left';
    if (fx > 1 - EDGE_FRACTION) return 'right';
    return 'replace';
  }
  if (zones.includes('top') || zones.includes('bottom')) {
    if (fy < EDGE_FRACTION) return 'top';
    if (fy > 1 - EDGE_FRACTION) return 'bottom';
    return 'replace';
  }
  const onAnEdge =
    fx < EDGE_FRACTION || fx > 1 - EDGE_FRACTION || fy < EDGE_FRACTION || fy > 1 - EDGE_FRACTION;
  return onAnEdge ? null : 'replace';
}
