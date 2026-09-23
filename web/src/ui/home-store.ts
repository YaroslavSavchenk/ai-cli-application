/**
 * The user's real home folder, as the backend sees it — resolved from ONE
 * `GET /api/fs/list` (no path: the backend's `$HOME`), never a hardcoded
 * `/home/...`, and cached for the page's life. The New Project dialog (its
 * suggested paths and whether `<home>/projects` exists) and the GitHub panel
 * (clone destinations, already-cloned detection) both read it here.
 *
 * Part Q1 (`.claude/plans/PLAN-QUALITY.md`): before it, `ui/newproject.ts` and
 * `ui/github-state.ts` each kept their own copy of this cache and resolved it
 * separately. The one difference was an empty `path` — newproject cached it,
 * github-state retried; retrying is kept, because an empty path is not a home.
 *
 * THE LISTER IS PASSED IN (`ensureHome(api.fsList)` at the callers), so this
 * store does no I/O of its own and a test hands it a plain fake.
 */

/** Lists the backend's `$HOME` (no path) — `api.fsList` in the app. */
export type HomeLister = () => Promise<{ path: string; dirs: readonly string[] }>;

/** The home listing, once it has been read; null until then. */
let home: { path: string; dirs: readonly string[] } | null = null;

/** The resolved home folder, or null while it is not known (yet). */
export function homeDir(): string | null {
  return home?.path ?? null;
}

/**
 * Resolve the home folder once and cache it. Retried on every call until it
 * succeeds; null until then (the callers say "couldn't resolve your home
 * directory" or show a Browse hint rather than guessing a path). Never rejects.
 */
export async function ensureHome(list: HomeLister): Promise<string | null> {
  if (home !== null) return home.path;
  try {
    const res = await list(); // no path → backend's $HOME
    if (res.path !== '') home = { path: res.path, dirs: res.dirs };
  } catch {
    // Leave it unknown — the caller reports it; a later call retries.
  }
  return homeDir();
}

/** Whether the home folder held a folder of this name when it was read. */
export function homeHasFolder(name: string): boolean {
  return home !== null && home.dirs.includes(name);
}
