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
import { lstatSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
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
  /**
   * The `id` from `build-id.json` (emitted by the vite plugin in
   * vite.config.ts, the same value the bundle carries as `__BUILD_ID__`), or
   * null when the file is absent/unreadable/not the shape we write.
   *
   * Its presence is also the marker of a FINISHED build: server/restart.ts
   * refuses to swap a fresh web/dist in without it.
   */
  buildId: string | null;
}

/** The name of the id file the vite plugin emits into the build output. */
export const BUILD_ID_FILE = 'build-id.json';

/**
 * A build id as our own vite plugin writes it: `<yyyymmdd-hhmm>-<short hash>`.
 * Validated because the file sits on disk where anything could rewrite it, and
 * the value is printed into server.log and handed to the UI — a plain charset
 * is cheaper than trusting it. Anything else reads as "no id".
 */
const BUILD_ID_SHAPE = /^[A-Za-z0-9._+-]{1,64}$/;

/** The `id` from a `build-id.json`, or null for absent/unreadable/malformed. */
export function readBuildId(dir: string): string | null {
  const raw = readTextFile(join(dir, BUILD_ID_FILE));
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const id = (parsed as { id?: unknown }).id;
  if (typeof id !== 'string' || !BUILD_ID_SHAPE.test(id)) return null;
  return id;
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
  return { asset, indexMtime, buildId: readBuildId(webDistDir) };
}

/**
 * Is `node_modules` in step with `package-lock.json`?
 *
 * npm stamps `node_modules/.package-lock.json` at the end of every install, so
 * a lockfile NEWER than that stamp means the tree on disk is not what the
 * lockfile describes — the usual `git pull` case. Missing node_modules is the
 * same answer.
 *
 * This gates the restart (server/restart.ts REFUSES rather than installing:
 * node-pty is a native module and `npm install` runs lifecycle scripts, which
 * is the user's call to make, not a background process's) and it feeds the
 * update reason of the same name.
 *
 * Best effort, never throws: an unreadable path counts as "in step" and simply
 * yields no signal.
 */
export function dependenciesInStep(repoRoot: string): boolean {
  if (mtimeMsOf(join(repoRoot, 'node_modules')) === 0) return false; // No tree at all.
  const stampMs = mtimeMsOf(join(repoRoot, 'node_modules', '.package-lock.json'));
  // An installed tree WITHOUT the stamp (npm < 7, a hand-pruned tree, a
  // packaged node_modules) is no signal at all — comparing against 0 would put
  // the restart in a refusal the user cannot clear by installing anything.
  if (stampMs === 0) return true;
  return mtimeMsOf(join(repoRoot, 'package-lock.json')) <= stampMs;
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
  /**
   * Entry bundle this process is SERVING (may be null: web/dist absent).
   *
   * A getter, not a value: a standby child reads its web build at `go`, after
   * the parent's preflight swapped a freshly built `web/dist` into place, so a
   * value captured at module load would be the OLD bundle and would light the
   * update pill on a backend that had just been restarted.
   */
  bootAsset: () => string | null;
  /** ISO startedAt of this process; '' before listen (then: no signal). */
  startedAt: () => string;
  /** Clock + cache seams. */
  now?: () => number;
  cacheMs?: number;
  /**
   * Ceiling on ONE recursive frontend-source scan (default MAX_SCAN_ENTRIES).
   * Injectable so the bound itself can be tested: readdir order is not
   * deterministic, so a test cannot pin it by counting files alone.
   */
  maxScanEntries?: number;
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
 * Hard ceiling on one recursive scan. web/src holds well under 100 files, so
 * this only exists so a symlink farm or a stray node_modules under a scanned
 * directory can never turn a 5 s-cached status probe into a disk walk.
 */
export const MAX_SCAN_ENTRIES = 2_000;

/**
 * Newest mtime (ms) anywhere under `dir`, recursively; 0 when it does not
 * exist. Symlinks are stat'ed but never descended into (no loops, no escape
 * out of the tree), and the walk stops at MAX_SCAN_ENTRIES.
 */
function maxMtimeMsDeep(dir: string, budget = { left: MAX_SCAN_ENTRIES }): number {
  let newest = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0; // Absent — no signal, never a throw.
  }
  for (const entry of entries) {
    if (budget.left <= 0) break;
    budget.left -= 1;
    const path = join(dir, entry.name);
    // A symlink is measured by its OWN mtime (lstat), never followed: that is
    // what makes a loop impossible and keeps the walk inside the tree.
    if (entry.isSymbolicLink()) {
      let ms = 0;
      try {
        ms = lstatSync(path).mtimeMs;
      } catch {
        ms = 0; // Vanished between readdir and lstat.
      }
      if (ms > newest) newest = ms;
      continue;
    }
    if (entry.isDirectory()) {
      const ms = maxMtimeMsDeep(path, budget);
      if (ms > newest) newest = ms;
      continue;
    }
    const ms = mtimeMsOf(path);
    if (ms > newest) newest = ms;
  }
  return newest;
}

// The update reasons, as CONSTANTS: each one lands in server.log and the UI
// maps it to a sentence, so the exact strings are part of the contract.
/** node_modules is absent or older than package-lock.json (a pull, no install). */
export const UPDATE_DEPENDENCIES_CHANGED = 'dependencies changed';
/** web/dist has no index.html, no entry bundle, or no build-id.json. */
export const UPDATE_FRONTEND_BUILD_MISSING = 'frontend build missing';
/** web/dist was rebuilt after this process started. */
export const UPDATE_FRONTEND_REBUILT = 'frontend rebuilt';
/** A frontend source file is newer than the build being served. */
export const UPDATE_FRONTEND_SOURCE_CHANGED = 'frontend source changed';
/** A server/ or shared/ source file is newer than this run. */
export const UPDATE_SERVER_FILES_EDITED = 'server files edited';

/**
 * Build the `update` probe used by GET /api/runtime.
 *
 * available = true when ANY of these holds, in this ORDER of precedence (the
 * first match wins, because the first one is what the user has to act on):
 *   1. `dependencies changed` — node_modules is absent or behind
 *      package-lock.json; a restart REFUSES until `npm install` has run;
 *   2. `server code changed (<a> → <b>)` — a different checked-out commit;
 *   3. `frontend build missing` — web/dist has no index.html / no entry bundle
 *      / no build-id.json, so there is nothing complete to serve;
 *   4. `frontend rebuilt` — web/dist moved after this process started;
 *   5. `frontend source changed` — web/src, web/public, web/index.html,
 *      vite.config.ts or shared/*.ts is newer than the build being served
 *      (the `git pull` case: web/dist is gitignored and never moves);
 *   6. `server files edited` — a server/ or shared/ source newer than this run.
 *
 * A commit that cannot be read NOW is treated as "no signal" rather than as a
 * change: an unreadable .git must not nag the user forever.
 */
export function createUpdateChecker(opts: UpdateCheckOptions): () => UpdateCheckResult {
  const now = opts.now ?? ((): number => Date.now());
  const cacheMs = opts.cacheMs ?? UPDATE_CHECK_CACHE_MS;
  const scanLimit = opts.maxScanEntries ?? MAX_SCAN_ENTRIES;
  let cachedAt = -Infinity;
  let cached: UpdateCheckResult = NO_UPDATE;

  const compute = (): UpdateCheckResult => {
    const startedMs = Date.parse(opts.startedAt());
    if (Number.isNaN(startedMs)) return NO_UPDATE; // Not listening yet.

    if (!dependenciesInStep(opts.repoRoot)) {
      return { available: true, reason: UPDATE_DEPENDENCIES_CHANGED };
    }

    const commit = readServerCommit(opts.repoRoot);
    if (commit !== null && opts.bootCommit !== null && commit !== opts.bootCommit) {
      return { available: true, reason: `server code changed (${opts.bootCommit} → ${commit})` };
    }

    const build = readWebBuild(opts.webDistDir);
    if (build.indexMtime === null || build.asset === null || build.buildId === null) {
      return { available: true, reason: UPDATE_FRONTEND_BUILD_MISSING };
    }

    const indexMs = mtimeMsOf(join(opts.webDistDir, 'index.html'));
    if (indexMs > startedMs || build.asset !== opts.bootAsset()) {
      return { available: true, reason: UPDATE_FRONTEND_REBUILT };
    }

    // Sources vs the BUILD, not vs startedAt: `web/dist` is gitignored, so a
    // `git pull` moves web/src without ever touching the build, and the process
    // start time says nothing about either. build-id.json is the build's own
    // timestamp (the vite plugin writes it at the end of every build).
    const buildMs = mtimeMsOf(join(opts.webDistDir, BUILD_ID_FILE));
    const webDir = join(opts.repoRoot, 'web');
    const frontendMs = Math.max(
      maxMtimeMsDeep(join(webDir, 'src'), { left: scanLimit }),
      maxMtimeMsDeep(join(webDir, 'public'), { left: scanLimit }),
      mtimeMsOf(join(webDir, 'index.html')),
      mtimeMsOf(join(opts.repoRoot, 'vite.config.ts')),
      mtimeMsOf(join(webDir, 'vite.config.ts')), // the re-export shim
      // Shared types are compiled INTO the bundle, so an edit there is first of
      // all a stale frontend — it only reads as 'server files edited' when the
      // build is already newer than it.
      maxMtimeMs(opts.sharedDir, /\.ts$/),
    );
    if (frontendMs > buildMs) {
      return { available: true, reason: UPDATE_FRONTEND_SOURCE_CHANGED };
    }

    const serverMs = Math.max(
      maxMtimeMs(opts.serverDir, /\.(ts|mjs)$/),
      maxMtimeMs(opts.sharedDir, /\.ts$/),
    );
    if (serverMs > startedMs) return { available: true, reason: UPDATE_SERVER_FILES_EDITED };

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
