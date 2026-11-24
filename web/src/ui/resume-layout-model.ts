/**
 * Where a resumed session goes in the tabs — the pure rule behind "the
 * resumed sessions take the old ones' places" (Quality Q17 P3,
 * `.claude/plans/quality/PLAN-Q17.md` § P3 item 3).
 *
 * THE LINK. The stored arrangement (`ai-sm:ui:v2`, `state-persist.ts`) names
 * a terminal pane by its SESSION id. A session that died with WSL is gone from
 * the backend, so `loadUi` prunes its slot at boot — and with `Reopen tabs on
 * start` off it drops the whole bag, because the backend run changed. The
 * boot therefore keeps a SNAPSHOT of the stored views, read before `loadUi`
 * (`readLayoutSnapshot`), and the resume answer links each new session to the
 * old id: `previousSessionId → session.id`. Never the history id: after any
 * earlier resume the history entry's id and the id in the layout differ.
 *
 * THE RULE, per stored view holding a resumed session, in stored order:
 *
 *   1. The live view that IS that view — the Home tab by kind (its id may be
 *      new), any other by id. Each new session is put back at its old slot
 *      index (or the end, when the view shrank), as long as the pane cap
 *      allows; one that does not fit is left to the caller's reconcile, which
 *      gives it a tab of its own.
 *   1b. A live tab of the same PROJECT under another id (the bag was dropped
 *      and the user opened that project's files before Resume): the same as 1.
 *   2. No such view (it dissolved when its sessions were pruned, or the bag
 *      was dropped): the stored view comes back — its id, its splits, its
 *      editor panes, and only the sessions that resumed — at its old place in
 *      the strip, never before Home. A project root comes back only while the
 *      project exists; else it is a plain session tab.
 *
 * A resumed id already in some view (the 3 s poll can land between the
 * server spawning the sessions and the resume answer, and reconcile then gave
 * each a tab of its own) is taken out of it first; a plain tab left empty by
 * that goes.
 *
 * A session that failed to resume has no new id, so nothing names it here: it
 * stays what any session of a dead backend is — gone from the tabs, kept in
 * History.
 */
import type { PaneSlot, ViewState } from '../state.ts';

/** One old pane, one new session. */
interface ResumedPair {
  /** The id the stored layout names. */
  previous: string;
  /** The session that took its place. */
  next: string;
}

/** What `readLayoutSnapshot` saw in storage before `loadUi` pruned it. */
export interface LayoutSnapshot {
  views: ViewState[];
  /** The stored active tab's id, or null. */
  active: string | null;
}

interface PlaceOpts {
  maxPanes: number;
  maxViews: number;
  projectExists(id: string): boolean;
}

interface Placement {
  views: ViewState[];
  /**
   * The stored active tab, when it got a session back — the tab the user was
   * looking at when the app stopped. null leaves the active tab alone.
   */
  active: string | null;
}

function isHome(v: ViewState): boolean {
  return v.root?.kind === 'home';
}

function clampFocus(v: ViewState): void {
  v.focused = Math.min(Math.max(0, v.focused), Math.max(0, v.slots.length - 1));
}

/**
 * The live tab of the stored view's project, when it has one under another id
 * (the user opened a file from that project before pressing Resume): the
 * sessions join it rather than a second tab for the same project.
 */
function projectTab(views: readonly ViewState[], sv: ViewState): ViewState | undefined {
  const root = sv.root;
  if (root?.kind !== 'project') return undefined;
  return views.find((v) => v.root?.kind === 'project' && v.root.id === root.id);
}

/** Put every resumed session back where its old pane stood. Pure: returns new views. */
export function placeResumed(
  views: readonly ViewState[],
  snapshot: LayoutSnapshot,
  pairs: readonly ResumedPair[],
  opts: PlaceOpts,
): Placement {
  const next = new Map(pairs.map((p) => [p.previous, p.next]));
  const placing = new Set(pairs.map((p) => p.next));
  const isPlacing = (s: PaneSlot): boolean => s.kind === 'session' && placing.has(s.id);

  // A copy of every view, with any resumed id taken out (the poll race).
  const out: ViewState[] = [];
  for (const v of views) {
    const kept = v.slots.filter((s) => !isPlacing(s));
    if (kept.length === v.slots.length) {
      out.push({ ...v, slots: [...v.slots], split: { ...v.split } });
      continue;
    }
    if (kept.length === 0 && v.root === null) continue;
    const copy = { ...v, slots: kept, split: { ...v.split } };
    clampFocus(copy);
    out.push(copy);
  }

  let active: string | null = null;
  snapshot.views.forEach((sv, storedIndex) => {
    const hits: number[] = [];
    sv.slots.forEach((s, i) => {
      if (s.kind === 'session' && next.has(s.id)) hits.push(i);
    });
    if (hits.length === 0) return;

    const live = isHome(sv) ? out.find(isHome) : (out.find((v) => v.id === sv.id) ?? projectTab(out, sv));
    if (live !== undefined) {
      for (const i of hits) {
        if (live.slots.length >= opts.maxPanes) break;
        const at = Math.min(i, live.slots.length);
        const old = sv.slots[i] as { kind: 'session'; id: string };
        live.slots.splice(at, 0, { kind: 'session', id: next.get(old.id) as string });
        if (i === sv.focused) live.focused = at;
      }
      clampFocus(live);
      if (snapshot.active === sv.id) active = live.id;
      return;
    }

    if (out.length >= opts.maxViews) return;
    const liveSlotIds = new Set(out.flatMap((v) => v.slots.map((x) => x.id)));
    const slots: PaneSlot[] = [];
    let focused = 0;
    sv.slots.forEach((s, i) => {
      if (s.kind === 'session' && !next.has(s.id)) return;
      // An editor pane whose id is already on screen is not built twice.
      if (s.kind === 'editor' && liveSlotIds.has(s.id)) return;
      if (slots.length >= opts.maxPanes) return;
      if (i === sv.focused) focused = slots.length;
      slots.push(s.kind === 'session' ? { kind: 'session', id: next.get(s.id) as string } : s);
    });
    const root = sv.root?.kind === 'project' && opts.projectExists(sv.root.id) ? sv.root : null;
    const made: ViewState = {
      id: sv.id,
      root,
      slots,
      focused,
      l3: sv.l3,
      split: { ...sv.split },
    };
    const first = out.length > 0 && isHome(out[0] as ViewState) ? 1 : 0;
    out.splice(Math.max(first, Math.min(storedIndex, out.length)), 0, made);
    if (snapshot.active === sv.id) active = made.id;
  });

  return { views: out, active };
}
