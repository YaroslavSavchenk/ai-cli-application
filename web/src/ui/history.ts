/**
 * Session-history refresh — the ONE place that fetches GET /api/history and
 * pushes it into state. DOM-free and panes-free on purpose: the sessions
 * drawer, the pane grid and boot all need to trigger a refetch, and a shared
 * fetcher here is what keeps those modules from importing each other in a
 * cycle.
 *
 * WHEN IT REFETCHES. History is server state that changes at moments the UI
 * can observe locally: a session ends (ws `exit`, or a polled `info` snapshot
 * that came back `exited`), a session is killed/deleted, or the user opens the
 * sessions drawer to look at the list. Rather than sprinkling calls at those
 * call sites, this module subscribes ONCE and watches the id:status signature
 * of `state.sessions` — every one of those events changes it — plus the drawer
 * channel. Refetches are debounced (300 ms) so a burst (exit → poll → removal)
 * costs one request.
 *
 * DEGRADATION. A backend that predates the history routes answers 404. That is
 * not an error the user caused or can act on, so it lands as an empty list and
 * a console line — never a flash. Any other failure is left as-is (the last
 * good list stays on screen) and logged.
 */
import type { HistoryEntry } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import * as st from '../state.ts';
import { baseName } from './util.ts';

const DEBOUNCE_MS = 300;

let timer: number | null = null;
let inFlight = false;
let again = false;
let lastSessionSig = '';

/** id:status of every known session — changes on create, exit, and removal. */
function sessionSig(): string {
  return Array.from(st.state.sessions.values())
    .map((s) => `${s.id}:${s.status}`)
    .sort()
    .join('|');
}

async function fetchNow(): Promise<void> {
  if (inFlight) {
    again = true;
    return;
  }
  inFlight = true;
  try {
    st.setHistory(await api.getHistory());
  } catch (err) {
    if (err instanceof api.ApiError && err.status === 404) {
      // Backend without the history routes: an empty list, quietly.
      st.setHistory([]);
      console.info('session history unavailable on this backend');
    } else {
      console.warn('session history refresh failed', err);
    }
  } finally {
    inFlight = false;
    if (again) {
      again = false;
      scheduleHistoryRefresh();
    }
  }
}

/** Debounced refetch; safe to call as often as anything changes. */
export function scheduleHistoryRefresh(): void {
  if (timer !== null) clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    void fetchNow();
  }, DEBOUNCE_MS);
}

/**
 * Boot wiring: one immediate load (fire-and-forget — never a boot blocker) and
 * the permanent subscription that keeps the list current afterwards.
 */
export function initHistory(): void {
  lastSessionSig = sessionSig();
  st.subscribe((kind) => {
    if (kind === 'sessions') {
      const sig = sessionSig();
      if (sig === lastSessionSig) return; // history writes notify 'sessions' too
      lastSessionSig = sig;
      scheduleHistoryRefresh();
    } else if (kind === 'drawer' && st.state.drawer === 'sessions') {
      scheduleHistoryRefresh();
    }
  });
  void fetchNow();
}

// ---------------------------------------------------------------------------
// Grouping (pure — no DOM, so node:test can import it)
// ---------------------------------------------------------------------------

/** One project folder in the drawer's HISTORY section. */
export interface HistoryGroup {
  /** Stable key for the collapse state: `p:<projectId>` or `c:<cwd>`. */
  key: string;
  /** The folder's name — a project name when the app knows one, else the
   *  directory's last segment. Never a full path. */
  label: string;
  /** Newest first. */
  entries: HistoryEntry[];
}

/**
 * Entries → folders (user's request 2026-09-06: "in a folder per project, not
 * loose"). A folder is the PROJECT when the app still knows that project id,
 * and otherwise the working directory itself — a folder the app cannot name is
 * still a folder, so a deleted project's history stays reachable instead of
 * vanishing into an ungrouped pile.
 *
 * Groups are ordered by their newest entry, entries inside them newest first,
 * so the folder you just used is on top no matter how the server ordered the
 * list.
 */
export function groupHistory(
  entries: HistoryEntry[],
  projectName: (id: string | undefined) => string | null,
): HistoryGroup[] {
  const groups = new Map<string, HistoryGroup>();
  for (const e of entries) {
    const pname = projectName(e.projectId);
    const key = pname !== null && e.projectId !== undefined ? `p:${e.projectId}` : `c:${e.cwd}`;
    const label = pname ?? baseName(e.cwd);
    const g = groups.get(key);
    if (g === undefined) groups.set(key, { key, label, entries: [e] });
    else g.entries.push(e);
  }
  const stamp = (e: HistoryEntry): number => {
    const t = new Date(e.lastUsedAt).getTime();
    return Number.isNaN(t) ? 0 : t;
  };
  const out = Array.from(groups.values());
  for (const g of out) g.entries.sort((a, b) => stamp(b) - stamp(a));
  out.sort((a, b) => stamp(b.entries[0] as HistoryEntry) - stamp(a.entries[0] as HistoryEntry));
  return out;
}
