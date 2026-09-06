/**
 * Build identity for the boot banner — "which code is this backend actually
 * running, and which frontend is it serving?"
 *
 * Reason this exists (2026-09-06): the user launched a freshly built UI against
 * a backend process started before the history feature existed, saw an empty
 * HISTORY section, and server.log said nothing that could have told them. The
 * first lines of every run now name the server commit and the frontend bundle,
 * so a stale process is visible without guessing.
 *
 * Everything here is BEST EFFORT and read-only: a missing .git, a missing
 * web/dist, an unreadable file — each yields null, never a throw. None of it
 * gates startup.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Short git hash length, matching `git rev-parse --short`'s default here. */
const SHORT_HASH_LEN = 7;

const FULL_HASH = /^[0-9a-f]{40}$/;

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** ISO mtime of a path, or null when it does not exist / cannot be stat'ed. */
export function mtimeOf(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * The checked-out commit, short — read straight from .git, never by spawning
 * git (this runs at boot, in a detached process, and must not depend on a
 * binary being installed or on a repo lock).
 *
 * Follows `.git/HEAD`: a detached HEAD holds the hash itself, a normal one
 * holds `ref: refs/heads/<branch>` which is resolved against the loose ref file
 * and then against `.git/packed-refs`.
 */
export function readServerCommit(repoRoot: string): string | null {
  const head = readTextFile(join(repoRoot, '.git', 'HEAD'))?.trim();
  if (head === undefined || head === '') return null;
  if (FULL_HASH.test(head)) return head.slice(0, SHORT_HASH_LEN);
  const match = /^ref:\s*(\S+)$/.exec(head);
  if (match === null) return null;
  const ref = match[1] as string;
  // A ref path from our OWN .git dir; still refuse anything that could escape it.
  if (!/^refs\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..')) return null;
  const loose = readTextFile(join(repoRoot, '.git', ...ref.split('/')))?.trim();
  if (loose !== undefined && FULL_HASH.test(loose)) return loose.slice(0, SHORT_HASH_LEN);
  const packed = readTextFile(join(repoRoot, '.git', 'packed-refs'));
  if (packed === undefined) return null;
  for (const line of packed.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length === 2 && parts[1] === ref && FULL_HASH.test(parts[0] as string)) {
      return (parts[0] as string).slice(0, SHORT_HASH_LEN);
    }
  }
  return null;
}

export interface WebBuildInfo {
  /** The hashed entry bundle, e.g. `assets/index-Br1e6z0Q.js`; null if absent. */
  asset: string | null;
  /** ISO mtime of web/dist/index.html; null when web/dist is missing. */
  indexMtime: string | null;
}

/**
 * Identity of the frontend bundle being served. The hashed entry filename is
 * the only value that CHANGES when the frontend is rebuilt with different
 * contents, so it is what makes "the browser is running old code" visible.
 */
export function readWebBuild(webDistDir: string): WebBuildInfo {
  const indexMtime = mtimeOf(join(webDistDir, 'index.html'));
  let asset: string | null = null;
  try {
    const names = readdirSync(join(webDistDir, 'assets'));
    const entry = names.filter((n) => /^index-.*\.js$/.test(n)).sort()[0];
    if (entry !== undefined) asset = `assets/${entry}`;
  } catch {
    asset = null; // No assets dir — an unbuilt or partially built web/dist.
  }
  return { asset, indexMtime };
}
