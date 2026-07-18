/**
 * Directory browsing for the "Add project" picker: directory NAMES only —
 * no files, no file contents. Absolute paths only; defaults to $HOME.
 */
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import type { FsListResponse } from '../shared/protocol.ts';

export class FsBrowseError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** List subdirectory names of `requestedPath` (or $HOME when omitted). */
export function listDirs(requestedPath: string | undefined): FsListResponse {
  const target = requestedPath === undefined || requestedPath === '' ? homedir() : requestedPath;
  if (!isAbsolute(target)) {
    throw new FsBrowseError(400, 'path must be absolute');
  }
  const path = normalize(target);
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new FsBrowseError(404, 'not a directory');
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new FsBrowseError(403, 'permission denied');
    }
    throw new FsBrowseError(500, 'failed to list directory');
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirs.push(entry.name);
    } else if (entry.isSymbolicLink()) {
      // Include symlinks that resolve to directories (common in home dirs).
      try {
        if (statSync(join(path, entry.name)).isDirectory()) dirs.push(entry.name);
      } catch {
        // Broken symlink — skip.
      }
    }
  }
  dirs.sort((a, b) => a.localeCompare(b));
  return { path, dirs };
}
