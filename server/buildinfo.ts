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

// ---------------------------------------------------------------------------
// "Is the code on disk newer than this running process?" (2026-09-06)
// ---------------------------------------------------------------------------
//
// Same incident, other half: the boot banner makes a stale backend visible in
// the LOG, this makes it visible in the UI, so the user can act on it with the
// restart button instead of closing the window and waiting out the grace timer.
//
// The check is deliberately cheap and best-effort — a handful of stats plus one
// `.git/HEAD` read, cached for a few seconds — and it NEVER throws: an
// unreadable file, a missing web/dist or a missing .git each mean "no signal",
// never a false alarm and never a failed request.

/** GET /api/runtime's `update` field. Mirrors UpdateStatus in shared/protocol.ts. */
export interface UpdateCheckResult {
  available: boolean;
  /** Short human sentence for the tooltip/log, or null when nothing changed. */
  reason: string | null;
}

export interface UpdateCheckOptions {
  /** Repo root — holds `.git`. Injectable so tests can point at a fixture. */
  repoRoot: string;
  /** Directory of the running server code (`server/`). */
  serverDir: string;
  /** Directory of the shared types (`shared/`). */
  sharedDir: string;
  /** The built frontend being served (`web/dist`). */
  webDistDir: string;
  /** Commit this process booted with (may be null: unknown at boot). */
  bootCommit: string | null;
  /** Entry bundle this process booted with (may be null: web/dist absent). */
  bootAsset: string | null;
  /** ISO startedAt of this process; '' before listen (then: no signal). */
  startedAt: () => string;
  /** Clock + cache seams. */
  now?: () => number;
  cacheMs?: number;
}

/** Result cache window: the UI polls every 30 s, so this only absorbs bursts. */
export const UPDATE_CHECK_CACHE_MS = 5_000;

const NO_UPDATE: UpdateCheckResult = { available: false, reason: null };

/** Newest mtime (ms) among `dir`'s entries matching `pattern`; 0 when none. */
function maxMtimeMs(dir: string, pattern: RegExp): number {
  let newest = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0; // Directory gone — no signal, never a throw.
  }
  for (const name of names) {
    if (!pattern.test(name)) continue;
    try {
      const ms = statSync(join(dir, name)).mtimeMs;
      if (ms > newest) newest = ms;
    } catch {
      // Vanished between readdir and stat — skip it.
    }
  }
  return newest;
}

/** mtime in ms of one path, or 0 when it cannot be stat'ed. */
function mtimeMsOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Build the `update` probe used by GET /api/runtime.
 *
 * available = true when ANY of:
 *   - the checked-out commit differs from the one this process booted with;
 *   - web/dist/index.html is newer than startedAt, or the entry bundle name
 *     changed (a rebuild);
 *   - any server/*.ts, server/*.mjs or shared/*.ts is newer than startedAt
 *     (an edit that this process is not running).
 *
 * A commit that cannot be read NOW is treated as "no signal" rather than as a
 * change: an unreadable .git must not nag the user forever.
 */
export function createUpdateChecker(opts: UpdateCheckOptions): () => UpdateCheckResult {
  const now = opts.now ?? ((): number => Date.now());
  const cacheMs = opts.cacheMs ?? UPDATE_CHECK_CACHE_MS;
  let cachedAt = -Infinity;
  let cached: UpdateCheckResult = NO_UPDATE;

  const compute = (): UpdateCheckResult => {
    const startedMs = Date.parse(opts.startedAt());
    if (Number.isNaN(startedMs)) return NO_UPDATE; // Not listening yet.

    const commit = readServerCommit(opts.repoRoot);
    if (commit !== null && opts.bootCommit !== null && commit !== opts.bootCommit) {
      return { available: true, reason: `server code changed (${opts.bootCommit} → ${commit})` };
    }

    const indexMs = mtimeMsOf(join(opts.webDistDir, 'index.html'));
    const asset = readWebBuild(opts.webDistDir).asset;
    if (indexMs > startedMs || (asset !== null && asset !== opts.bootAsset)) {
      return { available: true, reason: 'frontend rebuilt' };
    }

    const serverMs = Math.max(
      maxMtimeMs(opts.serverDir, /\.(ts|mjs)$/),
      maxMtimeMs(opts.sharedDir, /\.ts$/),
    );
    if (serverMs > startedMs) return { available: true, reason: 'server files edited' };

    return NO_UPDATE;
  };

  return () => {
    const at = now();
    if (at - cachedAt < cacheMs) return cached;
    cached = compute();
    cachedAt = at;
    return cached;
  };
}
