/**
 * Pure (DOM-free, xterm-free) helpers for the New Project dialog + folder
 * picker, so plain `node:test` can import them (same split as launch-args.ts).
 * Nothing here touches the document, fetch, or window.
 *
 * All paths handled here are ABSOLUTE (the backend fs endpoints only ever
 * emit/accept absolute paths); `~` is never used — the real home is resolved
 * at runtime from GET /api/fs/list and passed in as `home`.
 */

import type { FsListResponse } from '../../../shared/protocol.ts';

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
 * THE `<home>/projects/<name>` CONVENTION — the one place that segment lives.
 * Every default project/clone destination goes through here (new blank project,
 * url clone, and github-model's defaultDest for a picked repo), so the path a
 * clone lands in and the path already-cloned detection compares against can
 * never drift apart. Both inputs are used verbatim (no trimming, no validation
 * — the callers own that).
 */
export function projectsPath(home: string, name: string): string {
  return joinPath(joinPath(home, 'projects'), name);
}

/**
 * Suggested absolute path for a NEW blank project: `<home>/projects/<name>`.
 * Empty when home is unknown or the name is blank (the caller shows a
 * placeholder + blocks Create until both exist).
 */
export function suggestProjectPath(home: string | null, name: string): string {
  const n = name.trim();
  if (home === null || home === '' || n === '') return '';
  return projectsPath(home, n);
}

/**
 * Suggested absolute clone destination: `<home>/projects/<repoBasename(url)>`.
 * Empty when home is unknown or the url is blank.
 */
export function suggestDestPath(home: string | null, url: string): string {
  if (home === null || home === '' || url.trim() === '') return '';
  return projectsPath(home, repoBasename(url));
}

export interface Crumb {
  label: string;
  path: string;
}

/**
 * Breadcrumb segments for an absolute path, root first: `/home/you/x` →
 * `[/, home, you, x]` with each crumb carrying its cumulative absolute path.
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

/**
 * What a probe of a browsed folder could establish. `GET /api/fs/list` answers
 * 200 for a directory it could read — with `empty` saying whether it holds any
 * entry at all (files, hidden files and broken symlinks count) — 404 for a path
 * that is missing or is not a directory, and 403 when it exists but may not be
 * read. So: `empty`, `nonEmpty`, `missing`, and `unknown` for everything else
 * (403, a network error, or a 200 from an older backend that sends no `empty`).
 */
export type FolderProbe = 'missing' | 'empty' | 'nonEmpty' | 'unknown';

/** What the New-folder tab will DO with the path the user picked. */
export type BlankIntent = 'create' | 'add';

/**
 * Map an `/api/fs/list` outcome onto a probe verdict: the parsed body on
 * success (`status` 200), or `null` plus the HTTP status for a failure —
 * `status` is `null` when the call never produced one (offline, a network
 * error), which is `unknown`, and unknown never changes what the dialog does.
 * A 200 whose body carries no boolean `empty` (an older backend) is `unknown`
 * too: without it an empty folder cannot be told from a full one.
 */
export function probeFromList(result: FsListResponse | null, status: number | null): FolderProbe {
  if (status === 404) return 'missing';
  if (status !== 200 || result === null) return 'unknown';
  if (typeof result.empty !== 'boolean') return 'unknown';
  return result.empty ? 'empty' : 'nonEmpty';
}

/**
 * The New-folder decision: a folder that already holds something is ADDED as
 * it is (`POST /api/projects` without `create`); everything else — missing,
 * empty, or unknown — is CREATED (`create: true`, plus the git-init toggle),
 * which the backend accepts for an absent or empty directory. `unknown` stays
 * on the create path — the old behaviour, whose failure is a plain inline
 * backend error.
 */
export function blankIntent(probe: FolderProbe): BlankIntent {
  return probe === 'nonEmpty' ? 'add' : 'create';
}

/** Last segment of an absolute path (`/` and `''` have none). */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '') return '';
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/**
 * The name an ADDED folder gets: whatever the user typed, or — when they typed
 * nothing — the folder's own basename, which is the name they already gave it
 * in the filesystem. Never a path: only the last segment (PROJECT-SCOPE, the
 * UI shows a project's NAME everywhere).
 */
export function addedProjectName(typedName: string, path: string): string {
  const typed = typedName.trim();
  return typed !== '' ? typed : baseName(path);
}
