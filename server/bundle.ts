/**
 * INSTALLED MODE — the backend running from a self-contained bundle instead of
 * a developer clone.
 *
 * Decided 2026-09-08 (`memory/decisions/installer-and-self-contained-bundle.md`):
 * the app becomes installable. CI ships `ai-session-manager-linux-x64.tar.gz`
 * whose single top-level directory is the version, and the installer unpacks it
 * into `<app>/<version>/` and points `<app>/current` at it:
 *
 *   <app>/current -> v0.2.0
 *   <app>/v0.2.0/bundle.json          <- the marker THIS module reads
 *   <app>/v0.2.0/node/bin/node        <- pinned official Node 24 runtime
 *   <app>/v0.2.0/node_modules/…       <- production deps, node-pty prebuilt
 *   <app>/v0.2.0/server/**  shared/**  web/dist/**  package.json
 *
 * There is no git checkout, no package-lock.json, no vite and no source tree in
 * such an install, so three things the developer path does have to change, and
 * they all hang off `readBundleInfo(repoRoot) !== null`:
 *
 *   1. the boot banner names the BUNDLE VERSION instead of a git commit;
 *   2. "is there an update?" is one signal — `current` points somewhere else —
 *      instead of the six mtime/commit heuristics of buildinfo.ts, none of
 *      which can ever fire in a packaged tree (no .git, no lockfile stamp, no
 *      sources newer than the build);
 *   3. the restart preflight VERIFIES the target bundle instead of running
 *      vite, and hands the port to the `current` bundle's own node binary.
 *
 * The developer clone keeps every one of those behaviours unchanged: with no
 * `bundle.json` at the root, nothing in this file is ever called.
 *
 * UNTRUSTED DISK CONTENT. `bundle.json` sits in a user-writable directory and
 * its strings reach `server.log` and `GET /api/runtime` → the UI, so every
 * field is charset-gated exactly like `build-id.json` is in buildinfo.ts. A
 * file that is absent, oversized, not JSON, not an object, or that fails ANY
 * field check yields `null` — never a partial object, never a throw.
 */
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readWebBuild, type UpdateCheckResult } from './buildinfo.ts';
import { oneLine } from './config.ts';
import { REFUSED_STANDBY, RestartRefusal } from './restart.ts';

/** The version marker at the root of an unpacked bundle. Its presence IS "installed mode". */
export const BUNDLE_FILE = 'bundle.json';

/** The symlink the installer flips to make a newly unpacked version the current one. */
export const CURRENT_LINK = 'current';

/**
 * What `scripts/build-bundle.sh` writes into `<version>/bundle.json`.
 * Shared contract with the bundle builder — fields are added, never renamed.
 */
export interface BundleInfo {
  /** The release tag the bundle was built from, e.g. `v0.2.0`. */
  version: string;
  /** Short git sha of the commit it was built from, or null when unknown. */
  commit: string | null;
  /** The pinned Node runtime shipped inside the bundle, e.g. `v24.8.0`. */
  nodeVersion: string;
  /** ISO-8601 build timestamp. */
  builtAt: string;
  /** Only target that exists today; anything else is not our bundle. */
  platform: 'linux-x64';
  /** Oldest glibc the native deps were built against, e.g. `2.35`. */
  glibcMin?: string;
}

/** A bundle.json bigger than this is not one of ours; do not even parse it. */
const MAX_BUNDLE_BYTES = 4_096;

// The field gates. Same reasoning as BUILD_ID_SHAPE in buildinfo.ts: these
// strings are printed into server.log and handed to the UI, so a plain charset
// is cheaper than trusting a file anything on the machine could have written.
// A version is `v0.2.0` or `0.0.0-dev+699cd2c`: a digit, or `v` then a digit.
// ONE contract with scripts/build-bundle.sh, which uses the same shape — there
// the leading anchor is also what keeps `.`, `..` and a leading `-` out of a
// directory name and an argv slot.
export const VERSION_SHAPE = /^v?[0-9][A-Za-z0-9._+-]{0,63}$/;
const COMMIT_SHAPE = /^[0-9a-f]{7,40}$/;
const NODE_VERSION_SHAPE = /^v?\d{1,3}(\.\d{1,3}){2}$/;
// `Date.parse` is NOT a shape check: V8 accepts free text inside parentheses
// (`Date.parse('Sep 8 2026 (a\nb)')` parses), and this string is printed into
// the boot banner — a newline there forges a second server.log line. So the
// charset comes first and Date.parse only confirms it is a real instant.
const BUILT_AT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const GLIBC_SHAPE = /^\d{1,2}\.\d{1,3}$/;
const BUNDLE_PLATFORM = 'linux-x64';

/** How `readBundleInfo` reports the one failure that is NOT "absent". */
export interface ReadBundleOptions {
  /**
   * Called with a ready-made log line when `bundle.json` exists but could not
   * be READ (anything other than ENOENT). Not called for a missing marker, and
   * not called for a marker that is present but invalid — that one is a
   * deliberate "this is not our bundle" and already means developer mode.
   */
  warn?: (line: string) => void;
}

/**
 * The bundle marker at `appRoot`, or null when this is not an installed tree.
 *
 * BEST EFFORT, never throws — the same contract as `readServerCommit` and
 * `readBuildId`: it runs at boot in a detached process where an exception is
 * an app that never starts and a log the user cannot see. ALL-OR-NOTHING: one
 * bad field means null, because a half-trusted marker is worse than none.
 * A read error that is not ENOENT still yields null, but goes to `opts.warn`:
 * silently downgrading an install to a developer clone is invisible for the
 * whole run.
 */
export function readBundleInfo(appRoot: string, opts: ReadBundleOptions = {}): BundleInfo | null {
  let raw: Buffer;
  try {
    raw = readFileSync(join(appRoot, BUNDLE_FILE));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    // ENOENT is the normal developer-clone case and says nothing.
    // ANYTHING ELSE is an installed tree that reads as a clone for the whole
    // life of the process — no version banner, the mtime heuristics back on, a
    // restart that tries to run vite in a tree without it. Measured under fd
    // exhaustion (`ulimit -n 64`: EMFILE). Still null, but never silent.
    if (code !== 'ENOENT') {
      opts.warn?.(`${BUNDLE_FILE} unreadable (${code}): treating this tree as a developer clone`);
    }
    return null;
  }
  if (raw.length > MAX_BUNDLE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;

  if (typeof o['version'] !== 'string' || !VERSION_SHAPE.test(o['version'])) return null;
  const commitRaw = o['commit'];
  if (commitRaw !== null && (typeof commitRaw !== 'string' || !COMMIT_SHAPE.test(commitRaw))) {
    return null;
  }
  if (typeof o['nodeVersion'] !== 'string' || !NODE_VERSION_SHAPE.test(o['nodeVersion'])) return null;
  if (typeof o['builtAt'] !== 'string' || !BUILT_AT_SHAPE.test(o['builtAt'])) return null;
  if (Number.isNaN(Date.parse(o['builtAt']))) return null;
  if (o['platform'] !== BUNDLE_PLATFORM) return null;
  const glibcRaw = o['glibcMin'];
  if (glibcRaw !== undefined && (typeof glibcRaw !== 'string' || !GLIBC_SHAPE.test(glibcRaw))) {
    return null;
  }

  const info: BundleInfo = {
    version: o['version'],
    commit: commitRaw as string | null,
    nodeVersion: o['nodeVersion'],
    builtAt: o['builtAt'],
    platform: BUNDLE_PLATFORM,
  };
  if (typeof glibcRaw === 'string') info.glibcMin = glibcRaw;
  return info;
}

// ---------------------------------------------------------------------------
// "Is there a newer version installed?" — the installed-mode update check
// ---------------------------------------------------------------------------

/**
 * The installed-mode update reason (the six developer-clone reasons live in
 * buildinfo.ts and never appear in installed mode). Installed mode
 * only: it is the one signal a packaged tree can produce, and the UI maps the
 * exact string, so it is wire contract.
 */
export const UPDATE_NEW_VERSION_INSTALLED = 'a new version is installed';

const NO_UPDATE: UpdateCheckResult = { available: false, reason: null };

/** Same window as the dev checker: the UI polls every 30 s, this absorbs bursts. */
export const UPDATE_CHECK_CACHE_MS = 5_000;

export interface InstalledUpdateOptions {
  /** The version dir this process runs from (`<app>/<version>`). */
  appDir: string;
  /** ISO startedAt of this process; '' before listen (then: no signal). */
  startedAt: () => string;
  /** Clock + cache seams. */
  now?: () => number;
  cacheMs?: number;
}

/**
 * Build the `update` probe for an INSTALLED backend.
 *
 * ONE signal: `<app>/current` resolves to a directory other than the one this
 * process is running from — i.e. a newer Setup.exe has unpacked a version and
 * flipped the symlink, and the restart button will hand the port to it.
 *
 * It deliberately runs NONE of the developer checks. A packaged tree has no
 * `.git` (never "server code changed"), no `package-lock.json` stamp (never
 * "dependencies changed") and no sources at all (never "frontend source
 * changed") — running them would only ever produce noise, and `frontend
 * rebuilt` would fire on nothing but a clock difference.
 *
 * NEVER THROWS AND NEVER NAGS: a dangling, absent, unreadable or plain-directory
 * `current` all mean "no signal". An install that is half-finished must not
 * light the pill — so the target must ALSO be a direct sibling of this version
 * dir (containment, as in `resolveInstalledTarget`) and carry a valid
 * `bundle.json`. Anything the restart would refuse is not an update to offer.
 */
export function createInstalledUpdateChecker(opts: InstalledUpdateOptions): () => UpdateCheckResult {
  const now = opts.now ?? ((): number => Date.now());
  const cacheMs = opts.cacheMs ?? UPDATE_CHECK_CACHE_MS;
  let cachedAt = -Infinity;
  let cached: UpdateCheckResult = NO_UPDATE;

  const compute = (): UpdateCheckResult => {
    if (Number.isNaN(Date.parse(opts.startedAt()))) return NO_UPDATE; // Not listening yet.
    try {
      // Resolved first, then dirname'd: `<app>` is the REAL parent of the
      // version dir this process runs from, never a path reached through a
      // symlink (which is what `current` itself is).
      const here = realpathSync(opts.appDir);
      const link = join(dirname(here), CURRENT_LINK);
      // A PLAIN DIRECTORY at `current` is not an install we made: it would
      // realpath to itself and read as "a different version" forever.
      if (!lstatSync(link).isSymbolicLink()) return NO_UPDATE;
      const to = realpathSync(link); // Dangling -> throws -> NO_UPDATE.
      if (to === here) return NO_UPDATE;
      // A HALF-FINISHED unpack, and a `current` that left <app>, must not nag:
      // both would otherwise light the pill permanently while every Restart
      // press answers 422 (resolveInstalledTarget refuses exactly these two).
      // Same containment rule as there: a direct sibling of this version dir.
      if (dirname(to) !== dirname(here)) return NO_UPDATE;
      if (readBundleInfo(to) === null) return NO_UPDATE;
      return { available: true, reason: UPDATE_NEW_VERSION_INSTALLED };
    } catch {
      return NO_UPDATE;
    }
  };

  return () => {
    const at = now();
    if (at - cachedAt < cacheMs) return cached;
    cached = compute();
    cachedAt = at;
    return cached;
  };
}

// ---------------------------------------------------------------------------
// "Which bundle does the restart hand the port to?" — preflight step 2, installed
// ---------------------------------------------------------------------------

/** The bundle a restart is about to start: everything `spawn` needs, verified. */
export interface InstalledTarget {
  /** `bundle.json`'s version — logged, and reported by GET /api/runtime. */
  version: string;
  /** The version dir itself (`<app>/<version>`), already realpath'ed. */
  dir: string;
  /** `<dir>/node/bin/node` — the bundle's OWN runtime, never a PATH lookup. */
  execPath: string;
  /** `<dir>/server/index.ts`. */
  entry: string;
  /** The child's cwd: the version dir, so its node_modules resolve. */
  cwd: string;
}

/**
 * Resolve and VERIFY the bundle `<app>/current` points at — the installed-mode
 * replacement for the vite build in the restart preflight.
 *
 * The point is identical: prove the replacement before anything is torn down.
 * Here that means the target directory really is a complete bundle — marker,
 * entry module, its own node binary, and a frontend to serve — because the only
 * alternative would be discovering it after the sessions are already dead.
 *
 * CONTAINMENT. `current` is a symlink in a user-writable directory, and what it
 * resolves to is spawned as a program. It must therefore be a DIRECT CHILD of
 * `<app>`: not `<app>/..`, not `/tmp/anything`, not a nested path. Pointing the
 * app at an executable outside its own install directory is not an upgrade.
 *
 * Refusing reuses REFUSED_STANDBY ('The new backend did not start.') — the
 * existing 422 copy for "the replacement could not be proven"; this is the same
 * event and needs no new UI sentence. The DETAIL goes to server.log only.
 */
export function resolveInstalledTarget(appDir: string): InstalledTarget {
  const refuse = (detail: string): never => {
    throw new RestartRefusal(REFUSED_STANDBY, detail);
  };
  // The REAL version dir, and `<app>` as its real parent: `current` is a
  // symlink, so nothing here may depend on how this process was addressed.
  let appHome: string;
  try {
    appHome = dirname(realpathSync(appDir));
  } catch (err) {
    return refuse(`the app directory ${oneLine(appDir)} could not be resolved (${String(err)})`);
  }

  const link = join(appHome, CURRENT_LINK);
  let dir: string;
  try {
    dir = realpathSync(link);
  } catch {
    return refuse(`${oneLine(link)} does not resolve to a directory (absent or dangling)`);
  }

  // A direct child of <app> and nothing else. `dirname`/`basename` on two
  // realpaths is the whole check: no '..' survives a realpath, and a target one
  // level down cannot be a sibling, a parent or a path in another tree.
  if (dirname(dir) !== appHome || basename(dir) === '') {
    return refuse(
      `${oneLine(link)} resolves to ${oneLine(dir)}, which is not a version directory inside ${oneLine(appHome)}`,
    );
  }

  const info = readBundleInfo(dir);
  if (info === null) {
    return refuse(`${oneLine(join(dir, BUNDLE_FILE))} is missing or is not a valid bundle marker`);
  }

  const entry = join(dir, 'server', 'index.ts');
  if (!existsSync(entry)) return refuse(`${oneLine(entry)} is missing`);

  const execPath = join(dir, 'node', 'bin', 'node');
  try {
    accessSync(execPath, constants.X_OK);
  } catch {
    return refuse(`${oneLine(execPath)} is missing or not executable`);
  }

  const webDist = join(dir, 'web', 'dist');
  const build = readWebBuild(webDist);
  if (build.indexMtime === null || build.asset === null) {
    return refuse(
      `${oneLine(webDist)} is not a frontend build (index.html ${
        build.indexMtime === null ? 'missing' : 'ok'
      }, entry bundle ${build.asset ?? 'missing'})`,
    );
  }

  // Restarting IN PLACE is legal and normal: `current` may still point at this
  // very bundle, and a plain fresh process is a valid outcome.
  return { version: info.version, dir, execPath, entry, cwd: dir };
}
