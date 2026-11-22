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
 * such an install, so four things the developer path does have to change, and
 * they all hang off `readBundleInfo(repoRoot) !== null`:
 *
 *   1. the boot banner names the BUNDLE VERSION instead of a git commit;
 *   2. "is there an update?" is one signal — `current` points somewhere else —
 *      instead of the six mtime/commit heuristics of buildinfo.ts, none of
 *      which can ever fire in a packaged tree (no .git, no lockfile stamp, no
 *      sources newer than the build);
 *   3. the restart preflight VERIFIES the target bundle instead of running
 *      vite, and hands the port to the `current` bundle's own node binary;
 *   4. a claude session's status-line command names node and statusline.mjs
 *      through `<app>/current` instead of this version dir (Nocturne D9 P5,
 *      `statuslinePaths`): an adopted session outlives the dir it was spawned
 *      from.
 *
 * The developer clone keeps every one of those behaviours unchanged: with no
 * `bundle.json` at the root, `statuslinePaths` returns this process's own
 * paths at its first line and nothing else in this file is ever called.
 *
 * UNTRUSTED DISK CONTENT. `bundle.json` sits in a user-writable directory and
 * its strings reach `server.log` and `GET /api/runtime` → the UI, so every
 * field is charset-gated exactly like `build-id.json` is in buildinfo.ts. A
 * file that is absent, oversized, not JSON, not an object, or that fails ANY
 * field check yields `null` — never a partial object, never a throw.
 */
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { VERSION_SHAPE } from '../shared/protocol.ts';
import { UPDATE_CHECK_CACHE_MS, readWebBuild, type UpdateCheckResult } from './buildinfo.ts';
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
// directory name and an argv slot. The shape itself is VERSION_SHAPE in
// shared/protocol-runtime.ts: the browser gates the tag it prints with it too.
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
interface ReadBundleOptions {
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

interface InstalledUpdateOptions {
  /** The version dir this process runs from (`<app>/<version>`). */
  appDir: string;
  /** ISO startedAt of this process; '' before listen (then: no signal). */
  startedAt: () => string;
  /** Clock + cache seams. */
  now?: () => number;
  cacheMs?: number;
}

/** `<app>/current` as the installer left it, beside the version dir this process runs from — or why not. */
type InstallerCurrent =
  | {
      ok: true;
      /** The version dir this process runs from, realpath'ed. */
      here: string;
      /** `<app>/current` itself — the LINK path, not what it resolves to. */
      link: string;
      /** What the link resolves to, realpath'ed: a direct sibling of `here`. */
      to: string;
      /** The valid `bundle.json` of `to`. */
      info: BundleInfo;
    }
  | {
      ok: false;
      /** One `server.log`-safe sentence: what is wrong with `current`. */
      why: string;
    };

/**
 * `<app>/current`, but only when it is the installer's link: a SYMLINK whose
 * end is a direct sibling of `appDir` carrying a valid `bundle.json`. Anything
 * else is `{ ok: false, why }`; never throws.
 *
 * Resolved first, then dirname'd: `<app>` is the REAL parent of the version
 * dir this process runs from, never a path reached through a symlink (which
 * is what `current` itself is). A PLAIN DIRECTORY at `current` is not an
 * install we made: it would realpath to itself and read as "a different
 * version" forever — and the restart would spawn whatever it holds. A
 * dangling link fails the realpath. A HALF-FINISHED unpack (no valid marker),
 * and a `current` that left <app>, fail too. CONTAINMENT: what `current`
 * resolves to gets spawned by the restart, so it must be a DIRECT child of
 * `<app>` — `dirname` on two realpaths is the whole check (no '..' survives a
 * realpath; a target one level down is not a sibling).
 *
 * The ONE definition of "the installer's `current`" (Nocturne D9 P5), for
 * three users: the update probe (does it point somewhere else?), the restart
 * preflight `resolveInstalledTarget` (which also logs `why`), and the
 * status-line command of installed mode (`statuslinePaths`: paths that must
 * outlive this version dir).
 */
function installerCurrent(appDir: string): InstallerCurrent {
  let here: string;
  try {
    here = realpathSync(appDir);
  } catch (err) {
    return { ok: false, why: `the app directory ${oneLine(appDir)} could not be resolved (${oneLine(String(err))})` };
  }
  const appHome = dirname(here);
  const link = join(appHome, CURRENT_LINK);
  let to: string;
  try {
    if (!lstatSync(link).isSymbolicLink()) {
      return { ok: false, why: `${oneLine(link)} is not the installer's link (a plain file or directory)` };
    }
    to = realpathSync(link);
  } catch {
    return { ok: false, why: `${oneLine(link)} does not resolve to a directory (absent or dangling)` };
  }
  if (dirname(to) !== appHome || basename(to) === '') {
    return {
      ok: false,
      why: `${oneLine(link)} resolves to ${oneLine(to)}, which is not a version directory inside ${oneLine(appHome)}`,
    };
  }
  const info = readBundleInfo(to);
  if (info === null) {
    return { ok: false, why: `${oneLine(join(to, BUNDLE_FILE))} is missing or is not a valid bundle marker` };
  }
  return { ok: true, here, link, to, info };
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
    const current = installerCurrent(opts.appDir);
    if (!current.ok || current.to === current.here) return NO_UPDATE;
    return { available: true, reason: UPDATE_NEW_VERSION_INSTALLED };
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
  // The link, containment and marker rules are `installerCurrent`'s — the
  // same ones the update probe and the status line apply (a plain directory
  // at `current` is refused here too).
  const current = installerCurrent(appDir);
  if (!current.ok) return refuse(current.why);
  const { to: dir, info } = current;

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

// ---------------------------------------------------------------------------
// "Which node and script does a session's status line run?" — Nocturne D9 P5
// ---------------------------------------------------------------------------

/** The two programs a claude session's `statusLine.command` names. */
interface StatuslinePaths {
  /** The node binary the command runs the script with. */
  nodePath: string;
  /** `statusline.mjs`. */
  scriptPath: string;
}

/**
 * Where a claude session's status-line command finds node and statusline.mjs
 * (server/session-settings.ts composes the command from these two).
 *
 * Since Nocturne D9 a session outlives the backend that spawned it: Restart
 * service and an update hand it to the next backend through the pty-host, and
 * its Claude keeps running the command its `--settings` file named at spawn.
 * In INSTALLED mode the version dir that backend ran from is pruned by a later
 * Setup (retention: `current`, one previous version, and what a live backend
 * or pty-host runs from), and a command naming `<app>/<old version>/…` would
 * draw a blank bar for good. So installed mode names both through
 * `<app>/current` — the link path itself, which the installer only ever moves
 * to a complete bundle. The developer clone keeps this process's own node and
 * `<serverDir>/statusline.mjs`, unchanged. An installed tree whose `current`
 * is not the installer's link (`installerCurrent` not ok) falls back to the
 * version dir — a status line that works until a prune beats none — and says
 * so through `warn`.
 *
 * This creates a CROSS-VERSION CONTRACT on statusline.mjs (a session spawned
 * by version N runs the script of whatever version `current` names) — kept in
 * that file's header and pinned by tests/server/statusline-argv.test.ts.
 */
export function statuslinePaths(serverDir: string, installed: boolean, warn: (line: string) => void): StatuslinePaths {
  const own: StatuslinePaths = { nodePath: process.execPath, scriptPath: join(serverDir, 'statusline.mjs') };
  if (!installed) return own;
  const current = installerCurrent(join(serverDir, '..'));
  if (!current.ok) {
    warn(
      `${CURRENT_LINK} beside ${oneLine(join(serverDir, '..'))} is not the installer's link to a bundle ` +
        `(${current.why}); status lines name this version dir and go blank once a later install prunes it`,
    );
    return own;
  }
  return {
    nodePath: join(current.link, 'node', 'bin', 'node'),
    scriptPath: join(current.link, 'server', 'statusline.mjs'),
  };
}
