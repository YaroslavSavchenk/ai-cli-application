/**
 * Pure (DOM-free, xterm-free) helpers for the New Project dialog + folder
 * picker, so plain `node:test` can import them (same split as launch-args.ts).
 * Nothing here touches the document, fetch, or window.
 *
 * All paths handled here are ABSOLUTE (the backend fs endpoints only ever
 * emit/accept absolute paths); `~` is never used — the real home is resolved
 * at runtime from GET /api/fs/list and passed in as `home`.
 */

/** Join a single segment onto an absolute directory (no normalization beyond a trailing-slash trim). */
export function joinPath(dir: string, seg: string): string {
  if (dir === '/') return `/${seg}`;
  return `${dir.replace(/\/+$/, '')}/${seg}`;
}

/** Parent of an absolute path (`/` is its own parent). */
export function parentDir(path: string): string {
  if (path === '/' || path === '') return '/';
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i <= 0 ? '/' : trimmed.slice(0, i);
}

/**
 * Repo basename from a clone url: the last path/scp segment, minus a trailing
 * `.git` and trailing slashes. Handles http(s)/git/ssh urls and scp-like
 * `user@host:owner/repo.git`. Falls back to `repo` when nothing usable remains.
 */
export function repoBasename(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed === '') return 'repo';
  const seg = trimmed.split(/[/:]/).pop() ?? '';
  const base = seg.replace(/\.git$/i, '');
  return base === '' ? 'repo' : base;
}

/**
 * Suggested absolute path for a NEW blank project: `<home>/projects/<name>`.
 * Empty when home is unknown or the name is blank (the caller shows a
 * placeholder + blocks Create until both exist).
 */
export function suggestProjectPath(home: string | null, name: string): string {
  const n = name.trim();
  if (home === null || home === '' || n === '') return '';
  return joinPath(joinPath(home, 'projects'), n);
}

/**
 * Suggested absolute clone destination: `<home>/projects/<repoBasename(url)>`.
 * Empty when home is unknown or the url is blank.
 */
export function suggestDestPath(home: string | null, url: string): string {
  if (home === null || home === '' || url.trim() === '') return '';
  return joinPath(joinPath(home, 'projects'), repoBasename(url));
}

export interface Crumb {
  label: string;
  path: string;
}

/**
 * Breadcrumb segments for an absolute path, root first: `/home/sava/x` →
 * `[/, home, sava, x]` with each crumb carrying its cumulative absolute path.
 */
export function breadcrumbs(path: string): Crumb[] {
  if (path === '/' || path === '') return [{ label: '/', path: '/' }];
  const parts = path.split('/').filter((p) => p !== '');
  const out: Crumb[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const p of parts) {
    acc += `/${p}`;
    out.push({ label: p, path: acc });
  }
  return out;
}
