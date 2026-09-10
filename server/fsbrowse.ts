/**
 * Directory browsing for the "Add project" picker: directory NAMES only —
 * no files, no file contents — plus one boolean, `empty`, saying whether the
 * directory holds any entry at all. Absolute paths only; defaults to $HOME.
 *
 * Plus the WRITE side (POST /api/fs/mkdir): create a single new subdirectory
 * inside an existing directory, named a single validated path segment.
 */
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import type { FsListResponse, FsMkdirResponse } from '../shared/protocol.ts';
import { isExistingDirectory } from './projects.ts';

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
  // Every entry type counts (files, hidden files, broken symlinks) — the same
  // test the create path's assertVacant applies, so `empty` means "create
  // would accept this folder".
  return { path, dirs, empty: entries.length === 0 };
}

/**
 * True when `name` is a single safe path segment: 1..255 chars, no `/` or `\`,
 * no NUL or control chars, and not an all-dots name (`.`, `..`, `...`). This is
 * the ONLY vocabulary the mkdir endpoint accepts — it can never escape `parent`.
 */
export function isSafeSegment(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  for (let i = 0; i < name.length; i += 1) {
    if (name.charCodeAt(i) < 0x20) return false; // NUL + control chars
  }
  if (/^\.+$/.test(name)) return false; // '.', '..', '...' — no dots-only names
  return true;
}

/**
 * Create the single subdirectory `name` inside the existing directory `parent`,
 * returning its absolute path. `parent` must be an existing directory and
 * `name` a valid single segment; the target must not already exist. Throws
 * FsBrowseError (mapped to an HTTP status by the API layer) on any violation.
 */
export function mkdirIn(parent: string, name: string): FsMkdirResponse {
  if (!isExistingDirectory(parent)) {
    throw new FsBrowseError(400, 'parent must be an absolute path to an existing directory');
  }
  if (!isSafeSegment(name)) {
    throw new FsBrowseError(400, 'name must be a single safe path segment');
  }
  const target = join(parent, name);
  try {
    mkdirSync(target); // Not recursive: fails EEXIST if the target already exists.
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new FsBrowseError(409, 'a file or directory with that name already exists');
    if (code === 'EACCES' || code === 'EPERM') throw new FsBrowseError(403, 'permission denied');
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new FsBrowseError(404, 'parent not found');
    throw new FsBrowseError(500, 'failed to create directory');
  }
  return { path: target };
}
