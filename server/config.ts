/**
 * Data directory resolution, and the shared homes for file writes and request
 * predicates.
 *
 * Data dir: ~/.ai-session-manager/ (created 0700), overridable via the
 * AI_SM_DATA_DIR env var (must be an absolute path). Holds runtime.json,
 * last-port.json, projects.json, prefs.json, github.json, history.json,
 * session-settings/ (0700, wiped at boot), statusline-snapshots/ (0700, wiped
 * at boot), statusline-cache.json (0600, wiped at boot) and server.log.
 *
 * File logging (the logger, levels, error rendering, the log budgets) lives in
 * the split server/config-log.ts (PLAN-QUALITY Q13); its importers take it
 * from there.
 *
 * Also the one home of `runCapture` (Nocturne D6): run a helper program and
 * read its short stdout — argv only, never a shell, bounded, killed on timeout.
 * It and the bounded runner under it (`runChild`, `killQuietly`) live in the
 * split server/config-spawn.ts (PLAN-QUALITY Q11) and are re-exported here.
 */
import {
  mkdirSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  openSync,
  readSync,
  writeFileSync,
  realpathSync,
  renameSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { oneLine, type Logger } from './config-log.ts';

export interface DataPaths {
  dataDir: string;
  runtimeFile: string;
  projectsFile: string;
  /** Opaque UI preferences bag (theme today; future settings later). */
  prefsFile: string;
  /**
   * GitHub credential store (mode 0600) — from the OAuth device flow OR a
   * pasted token the user asked to remember. Holds the server-side access
   * token, which is NEVER returned by the browser-facing API. Not encrypted,
   * and not claimed to be: see the storage-ceiling note in server/github.ts.
   */
  githubFile: string;
  /**
   * Persistent session history across runs (feeds GET /api/history and the
   * resume route). Written atomically 0600 on every session create/end.
   */
  historyFile: string;
  /**
   * Stored API keys, one optional value per keyed tool (mode 0600, atomic —
   * server/keys.ts). Same storage ceiling as githubFile: not encrypted, and
   * never claimed to be. A value here reaches exactly one place besides this
   * file: the environment of a session spawned for that tool.
   */
  keysFile: string;
  /**
   * Per-session Claude Code settings files (`--settings <file>`, one per
   * claude session, holding only our statusLine key). Created 0700 and WIPED
   * at boot by SessionSettingsStore — no session survives a restart, so any
   * file found here at startup is garbage.
   */
  sessionSettingsDir: string;
  /**
   * Per-session status-line SNAPSHOTS written by server/statusline.mjs (mode
   * 0600, one `<appSessionId>.json` per claude session) and read back by
   * server/telemetry.ts, which is what puts Claude Code's own numbers
   * (model, cost, context, usage, lines, branch) into the app's pane status
   * bar. Created 0700 and WIPED at boot beside session-settings/, for the
   * same reason: no session survives a restart, so a leftover snapshot
   * describes nothing that still exists.
   *
   * The script does NOT derive this path — the server hands it the absolute
   * file as the script's fourth argument (composed in
   * SessionSettingsStore.command from a SAFE_ID-checked session id), so there
   * is no second definition to keep in sync here.
   */
  statuslineSnapshotDir: string;
  /**
   * Git-branch cache written by server/statusline.mjs (mode 0600), keyed by
   * Claude Code session id. Deleted at boot by server/index-stores.ts: no session
   * survives a restart, so a leftover is at best useless and at worst a
   * poisoned string from a previous run.
   *
   * MUST AGREE WITH server/statusline.mjs: that script imports nothing from
   * server/ (it runs inside the foreign `claude` process) and therefore derives
   * this same path itself, as `<dirname of prefs.json>/statusline-cache.json`.
   * Change one and you must change the other.
   */
  statuslineCacheFile: string;
  /**
   * IN-APP UPDATE (2026-09-09, phase E). Where a downloaded Setup.exe and its
   * `SHA256SUMS.txt` are written (mode 0700, `<version>` subdirectory per
   * release). WIPED AT BOOT by server/index-stores.ts: a half-downloaded `.part`, or
   * an exe from a release that was never run, must never be reused — the only
   * runnable file is one this process verified in THIS run.
   */
  updatesDir: string;
  /**
   * ETag cache of the last `releases/latest` answer (mode 0600, atomic,
   * <= 8 KiB, every field charset-gated on read like bundle.json). It exists
   * so a restart costs no GitHub rate-limit quota and the "new version"
   * notice is back on screen immediately instead of 20 s later.
   */
  updateCheckFile: string;
  /**
   * The port this backend last bound (mode 0600, atomic — server/last-port.ts).
   * Tried first on the next start so the frontend's localStorage, which is
   * scoped to the origin INCLUDING the port, keeps the saved tab layout
   * (decision D5, 2026-09-22). Auto-pick is the fallback, not the rule.
   */
  lastPortFile: string;
  /**
   * Claude Code's OWN transcript root, `<CLAUDE_CONFIG_DIR|~/.claude>/projects`
   * — NOT ours, NOT under the data dir, and never created or written by this
   * process. It is where Claude Code keeps `<slug>/<session-id>.jsonl` and,
   * beside it, `<slug>/<session-id>/subagents/` (Nocturne B7). The env var is
   * honoured through claudeConfigDir(), the same one server/history.ts uses to
   * find a transcript — two answers to "where does Claude Code keep this?"
   * would make the agents table silently empty for anyone who set it.
   *
   * It is here because it is a BOUNDARY, not a convenience: the transcript
   * path server/agents.ts reads comes out of a snapshot file that any process
   * running as this user can write (memory/knowledge/wsl-0600-not-a-boundary.md),
   * so a path is only ever opened after its real directory has been proven to
   * sit inside the realpath of THIS directory. Tests point the watcher at a
   * temp root through its constructor; there is deliberately no env var.
   */
  claudeProjectsDir: string;
  logFile: string;
  /**
   * The data dir's mode before `resolveDataPaths` tightened it to 0700
   * (`tightenDataDir`), for the boot log; undefined when nothing changed.
   */
  dataDirModeWas?: number;
}

/**
 * Where the data dir IS, without creating it or anything in it. Split out of
 * resolveDataPaths so a second reader can ask the question without a side
 * effect: server/fsbrowse.ts refuses to create files inside this directory
 * (POST /api/fs/create) and must derive it from the same one definition —
 * two copies of "AI_SM_DATA_DIR or ~/.ai-session-manager" would drift.
 */
export function dataDirPath(): string {
  const override = process.env['AI_SM_DATA_DIR'];
  if (override !== undefined && override !== '') {
    if (!isAbsolute(override)) {
      throw new Error(`AI_SM_DATA_DIR must be an absolute path, got: ${override}`);
    }
    return override;
  }
  return join(homedir(), '.ai-session-manager');
}

/**
 * Claude Code's own configuration directory: `CLAUDE_CONFIG_DIR` when the user
 * set it, `~/.claude` otherwise.
 *
 * ONE definition for the whole server (server/history.ts imports it too): a
 * second copy that forgot the env var would make a feature vanish silently for
 * the users who set it — which is exactly what `claudeProjectsDir` below would
 * have done. Deliberately NOT validated here: it is the user's own environment,
 * not input from a client, and every consumer treats what it finds there as
 * untrusted anyway.
 */
export function claudeConfigDir(): string {
  const override = process.env['CLAUDE_CONFIG_DIR'];
  return override !== undefined && override !== '' ? override : join(homedir(), '.claude');
}

/**
 * Bring an EXISTING data dir to 0700 when group or other bits are set, and
 * return its old mode (undefined when nothing changed). Only a real directory
 * (opened O_NOFOLLOW — a link is left alone) owned by this uid is touched; anyone else's
 * is left as it is, and the pty-host then refuses it (D9 P2:
 * server/pty-host-wire.ts `dataDirRefusal`).
 *
 * WHY (D9 P2 review): `mkdirSync({ mode: 0o700 })` does nothing to a
 * directory that already exists, and installs before D9 created the data dir
 * 0755 (`umask 022; mkdir -p <data>/app` in installer/helpers/install-bundle.ps1)
 * — without this the pty-host would refuse every such install forever. Never
 * throws: a failed chmod leaves the refusal to the pty-host.
 */
export function tightenDataDir(dir: string): number | undefined {
  let fd: number;
  try {
    // Judged and changed through ONE fd opened without following a link: an
    // lstat then chmod(path) would follow a symlink swapped in between.
    fd = openSync(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch {
    return undefined; // missing, a link (ELOOP), not a directory
  }
  try {
    const st = fstatSync(fd);
    if (!st.isDirectory() || st.uid !== process.getuid?.()) return undefined;
    const mode = st.mode & 0o777;
    if ((mode & 0o077) === 0) return undefined;
    fchmodSync(fd, 0o700);
    return mode;
  } catch {
    return undefined;
  } finally {
    closeQuietly(fd);
  }
}

/** close() that cannot throw — a second close or a broken fd leaves nothing to do; `undefined` is no fd. */
export function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // Nothing to do about a failed close.
  }
}

/** Resolve (and create, mode 0700 — or tighten to 0700) the data dir. Throws on a relative AI_SM_DATA_DIR. */
export function resolveDataPaths(): DataPaths {
  const dataDir = dataDirPath();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dataDirModeWas = tightenDataDir(dataDir);
  return {
    ...(dataDirModeWas !== undefined ? { dataDirModeWas } : {}),
    dataDir,
    runtimeFile: join(dataDir, 'runtime.json'),
    projectsFile: join(dataDir, 'projects.json'),
    prefsFile: join(dataDir, 'prefs.json'),
    githubFile: join(dataDir, 'github.json'),
    historyFile: join(dataDir, 'history.json'),
    keysFile: join(dataDir, 'keys.json'),
    sessionSettingsDir: join(dataDir, 'session-settings'),
    statuslineSnapshotDir: join(dataDir, 'statusline-snapshots'),
    statuslineCacheFile: join(dataDir, 'statusline-cache.json'),
    updatesDir: join(dataDir, 'updates'),
    updateCheckFile: join(dataDir, 'update-check.json'),
    lastPortFile: join(dataDir, 'last-port.json'),
    // Claude Code's own directory, off the data dir on purpose: it is read
    // (never written) and it follows CLAUDE_CONFIG_DIR / the user's home, not
    // AI_SM_DATA_DIR.
    claudeProjectsDir: join(claudeConfigDir(), 'projects'),
    logFile: join(dataDir, 'server.log'),
  };
}

/**
 * The built frontend directory this process SERVES — `<repo>/web/dist` unless
 * AI_SM_WEB_DIST_DIR overrides it (an absolute, ALREADY-NORMALIZED directory
 * path; validated like AI_SM_DATA_DIR, only stricter — a relative,
 * trailing-slash, dot-segment or root value makes the server refuse to start).
 *
 * WHY the seam exists: a restart REBUILDS and SWAPS this directory
 * (`<dir>-next` and `<dir>-prev` sit beside it), so a test that drives a real
 * restart would otherwise rewrite the repo's own `web/dist` — lighting the
 * update pill of whatever backend the developer has running and leaving a
 * window in which `web/dist` does not exist. Tests point it at a copy.
 * A standby child inherits it through the environment like every other
 * AI_SM_* value.
 */
export function resolveWebDistDir(repoRoot: string): string {
  const override = process.env['AI_SM_WEB_DIST_DIR'];
  if (override !== undefined && override !== '') {
    if (!isAbsolute(override)) {
      throw new Error(`AI_SM_WEB_DIST_DIR must be an absolute path, got: ${oneLine(override)}`);
    }
    // NORMALIZED, and a real named directory. Two reasons, both measured:
    //   - a restart RENAMES this path (`<dir>` -> `<dir>-prev`) and later
    //     DELETES the backup, so `/` or a value ending in a separator must
    //     never reach that code — `basename('/')` is '' and `<dir>-prev` of a
    //     trailing-slash value is a sibling nobody meant;
    //   - server/api.ts guards static assets with
    //     `resolved.startsWith(webDistDir + sep)`, which an unnormalized value
    //     ('/x/', '/x//y', '/x/../y') fails for EVERY asset -> a 403 UI.
    // `resolve()` collapses all three, so requiring the value to be its own
    // resolution is the whole check.
    if (resolve(override) !== override || basename(override) === '') {
      throw new Error(
        'AI_SM_WEB_DIST_DIR must be a normalized absolute directory path ' +
          `(no trailing separator, no '.' or '..' segment, not the root), got: ${oneLine(override)}`,
      );
    }
    return override;
  }
  return join(repoRoot, 'web', 'dist');
}

/**
 * The HOME the Files-panel routes are confined to (server/fsbrowse.ts), and the
 * default root the panel lists — `realpathSync(homedir())` unless
 * AI_SM_HOME_OVERRIDE overrides it.
 *
 * AI_SM_HOME_OVERRIDE IS A FIRST-CLASS TEST SEAM, exactly like
 * AI_SM_WEB_DIST_DIR above and validated in the same shape: absolute, ALREADY
 * NORMALIZED, never the root, and a directory that exists. It exists because
 * the boundary is the security property of those routes, and a test that
 * cannot move `home` can only test it against the developer's own — where a
 * fixture tree, a symlink farm and a 1200-entry folder do not belong. It
 * WIDENS NOTHING by itself: whatever it names, the routes are confined to that
 * one directory (plus the registered project roots, which are a user decision,
 * not this seam).
 *
 * Called at BOOT from server/index.ts purely so a bad value refuses the start
 * with a reason in server.log, and lazily by server/fsbrowse.ts for the value
 * itself: a detached backend's stderr is /dev/null, and a module that threw at
 * IMPORT died before the logger existed and left an EMPTY log (measured
 * 2026-09-16).
 */
export function resolveHomeBoundary(): string {
  const override = process.env['AI_SM_HOME_OVERRIDE'];
  if (override === undefined || override === '') return realpathSync(homedir());
  if (!isAbsolute(override)) {
    throw new Error(`AI_SM_HOME_OVERRIDE must be an absolute path, got: ${oneLine(override)}`);
  }
  // Same two reasons as AI_SM_WEB_DIST_DIR: the value is compared against
  // realpaths with `startsWith(value + sep)`, which an unnormalized value
  // ('/x/', '/x//y', '/x/../y') fails for every path under it, and `/` as a
  // boundary would mean no boundary at all.
  if (resolve(override) !== override || basename(override) === '') {
    throw new Error(
      'AI_SM_HOME_OVERRIDE must be a normalized absolute directory path ' +
        `(no trailing separator, no '.' or '..' segment, not the root), got: ${oneLine(override)}`,
    );
  }
  let real: string;
  try {
    real = realpathSync(override);
    if (!statSync(real).isDirectory()) throw new Error('not a directory');
  } catch {
    // The errno is deliberately not echoed: it quotes the path, and this line
    // goes to server.log.
    throw new Error(
      `AI_SM_HOME_OVERRIDE must name an existing directory, got: ${oneLine(override)}`,
    );
  }
  return real;
}

/**
 * GitHub REST API base. The DEVICE-FLOW endpoints (github.com/login/...) and the
 * clone host-lock (host must be exactly github.com) are deliberately NOT part of
 * this and stay hardcoded in github.ts.
 */
export const DEFAULT_GITHUB_API_BASE = 'https://api.github.com';

/**
 * Release-check API base (phase E). Same host as the REST base by default and a
 * SEPARATE variable on purpose: `AI_SM_UPDATE_API_BASE` re-points the anonymous
 * `releases/latest` GET and, with it, the asset host allow-list — it must never
 * be able to move the credential-bearing GitHub client, and vice versa.
 */
export const DEFAULT_UPDATE_API_BASE = 'https://api.github.com';

/** Where release ASSETS are downloaded from when the seam is unset. */
export const DEFAULT_UPDATE_ASSET_BASE = 'https://github.com';

/** Every GitHub request (REST client, release check, asset download) MUST carry a User-Agent. */
export const USER_AGENT = 'ai-cli-session-manager';

/**
 * Resolve the release-check API base: api.github.com unless
 * AI_SM_UPDATE_API_BASE overrides it with a loopback origin (offline tests).
 * Throws on anything else, and the caller then refuses to start — exactly like
 * AI_SM_GITHUB_API_BASE, and for the stronger of the two reasons: with the seam
 * set, the same origin also becomes the only host an update EXECUTABLE may be
 * downloaded from.
 */
export function resolveUpdateApiBase(): string {
  const override = (process.env['AI_SM_UPDATE_API_BASE'] ?? '').trim();
  if (override === '') return DEFAULT_UPDATE_API_BASE;
  return assertLoopbackApiBase(override, 'AI_SM_UPDATE_API_BASE');
}

/**
 * Hostnames accepted for an AI_SM_GITHUB_API_BASE override. Exact allowlist —
 * NOT a 127.0.0.0/8 range check — so 127.0.0.2, 0.0.0.0, or any routable host is
 * refused. `localhost` is included for ergonomics; pointing it elsewhere needs
 * root-level /etc/hosts control, which is already outside this trust boundary.
 */
const LOOPBACK_API_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Validate a loopback-only API base override and return its normalized origin.
 *
 * TWO CALLERS, one rule (generalised 2026-09-09 for phase E): the GitHub REST
 * base (`AI_SM_GITHUB_API_BASE`, where the stored credential is sent) and the
 * release-check base (`AI_SM_UPDATE_API_BASE`, where "is there a new version?"
 * is asked and, with the seam set, where the Setup.exe is downloaded from).
 * `varName` only names the variable in the refusal text — the rule itself is
 * identical, and deliberately so: both are test-only seams whose accepted
 * values must never include a routable host.
 *
 * SECURITY: this knob decides where the stored GitHub credential (device-flow
 * token OR pasted token) is sent as a Bearer header. It is therefore restricted
 * to LOOPBACK origins only, so a careless or hostile value can never exfiltrate
 * the token OFF THE MACHINE. Anything else is refused LOUDLY (throws -> the
 * server refuses to start, exactly like a relative AI_SM_DATA_DIR).
 *
 * The residual risk is NOT limited to "another process running as this same
 * user": on Linux ANY local user may bind a loopback port. Since the backend
 * inherits the login shell's environment (launcher/start-backend.sh runs it via
 * `wsl.exe -- bash -lc`), an override left in a shell profile means whichever
 * local account bound that port first receives a credential — a principal that
 * could not read github.json, since 0600 does hold against another LINUX user
 * (it does not hold against the Windows user of the same machine; see
 * memory/knowledge/wsl-0600-not-a-boundary.md). Loopback bounds the blast radius
 * to this machine; it does not bound it to this user. Hence: a test seam, unset
 * in normal use.
 *
 * Also refused: non-http(s) schemes, embedded credentials, and any path/query/
 * fragment (the base is an origin, never a prefix that could be re-pointed).
 */
export function assertLoopbackApiBase(value: string, varName = 'AI_SM_GITHUB_API_BASE'): string {
  const fail = (why: string): never => {
    throw new Error(`${varName} ${why} (expected e.g. http://127.0.0.1:8787), got: ${value}`);
  };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail('must be an absolute URL');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    // Never echo the value here — it carries the embedded credential.
    throw new Error(`${varName} must not embed credentials`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail('must use http:// or https://');
  }
  if (!LOOPBACK_API_HOSTS.has(parsed.hostname)) {
    return fail('must point at a loopback host (127.0.0.1, [::1] or localhost)');
  }
  if ((parsed.pathname !== '' && parsed.pathname !== '/') || parsed.search !== '' || parsed.hash !== '') {
    return fail('must be a bare origin with no path, query or fragment');
  }
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Resolve the GitHub REST API base: api.github.com unless AI_SM_GITHUB_API_BASE
 * overrides it with a loopback origin (offline tests). Throws on anything else.
 */
export function resolveGithubApiBase(): string {
  const override = (process.env['AI_SM_GITHUB_API_BASE'] ?? '').trim();
  if (override === '') return DEFAULT_GITHUB_API_BASE;
  return assertLoopbackApiBase(override);
}

/** setTimeout's own ceiling: a larger delay silently becomes 1 ms. */
const TIMER_MAX_MS = 2_147_483_647;

/**
 * An integer-milliseconds env seam (`AI_SM_GRACE_MS`, the update timings, the
 * pty-host lifetimes): the ONE parser, so every seam falls back the same way —
 * LOUDLY. Unset or empty ⇒ `fallback`, silently. Not a non-negative integer ⇒
 * a warn line and `fallback`. Below `floor` ⇒ raised to it, said out loud (a
 * seam whose 0 would mean a request flood or every session killed at once
 * carries a floor). Above the Node timer maximum ⇒ capped, said out loud (a
 * larger setTimeout delay fires after 1 ms — the opposite of what was asked).
 */
export function envMs(
  name: string,
  fallback: number,
  log: Logger,
  opts: { floor?: number; env?: NodeJS.ProcessEnv } = {},
): number {
  const raw = (opts.env ?? process.env)[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    log('warn', `${name} must be a non-negative integer (ms), got ${JSON.stringify(oneLine(raw))}; using ${fallback}`);
    return fallback;
  }
  const floor = opts.floor ?? 0;
  if (value < floor) {
    log('warn', `${name}=${value} is below the ${floor}ms floor; using ${floor}`);
    return floor;
  }
  if (value > TIMER_MAX_MS) {
    log('warn', `${name}=${value} is above the ${TIMER_MAX_MS}ms timer maximum; using ${TIMER_MAX_MS}`);
    return TIMER_MAX_MS;
  }
  return value;
}

/**
 * Atomically write a file with mode 0600: write to a unique temp file in the
 * same directory, then rename over the destination.
 */
export function atomicWriteFile(filePath: string, contents: string): void {
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmpPath, contents, { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

/**
 * What `readSmallRegularFile` found: the text, nothing at the path (ENOENT), or
 * something there that is not readable as one of the app's own small files.
 * `reason` is a fixed phrase, never file content, for the caller's WARN line
 * (Q8): 'a symlink', 'not a regular file', 'larger than <n> bytes', or the
 * errno code of a failed open or read.
 */
type SmallFileRead =
  | { kind: 'text'; text: string }
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: string };

/** One read step: a store with a large cap (history) does not allocate the cap up front. */
const SMALL_FILE_CHUNK_BYTES = 64 * 1024;

/**
 * Read a small file the app wrote itself into the data dir, where another
 * process can create the path. Never throws.
 *
 * THE OPEN IS JUDGED, NEVER THE PATH TWICE (the house rule for any synchronous
 * read of such a path — memory/knowledge/fifo-open-blocks-main-thread.md):
 * `O_NOFOLLOW | O_NONBLOCK`, then `fstat` on that fd must say a REGULAR file no
 * larger than `maxBytes` BEFORE the first read. These reads run on the main
 * thread, so a FIFO planted at the path would block until a writer appeared,
 * and a symlink to /dev/zero would read without end — a cap after the read is
 * too late for both. A symlink (ELOOP) is 'unreadable': the app writes these
 * files itself, so a link is not ours. The read stops one byte past the cap,
 * so a file that grew after the fstat is refused too, never truncated.
 */
export function readSmallRegularFile(file: string, maxBytes: number): SmallFileRead {
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'open failed';
    if (code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unreadable', reason: code === 'ELOOP' ? 'a symlink' : code };
  }
  const tooLarge: SmallFileRead = { kind: 'unreadable', reason: `larger than ${maxBytes} bytes` };
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { kind: 'unreadable', reason: 'not a regular file' };
    if (stat.size > maxBytes) return tooLarge;
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(SMALL_FILE_CHUNK_BYTES, maxBytes + 1 - total));
      const read = readSync(fd, buffer, 0, buffer.length, total);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) return tooLarge;
      chunks.push(buffer.subarray(0, read));
    }
    return { kind: 'text', text: Buffer.concat(chunks, total).toString('utf8') };
  } catch (err) {
    return { kind: 'unreadable', reason: (err as NodeJS.ErrnoException).code ?? 'read failed' };
  } finally {
    closeQuietly(fd);
  }
}

/**
 * Move a file `readSmallRegularFile` refused out of the store's way, called
 * by a store right BEFORE its first write (or unlink) of that path (Q8 fix
 * round): the atomic write would otherwise rename over it and destroy what
 * was there — a history past the cap is the user's own data. Not at load: a
 * standby boot loads every store while the parent still owns the data dir
 * and must change nothing there; a waiting standby never writes, so "before
 * the first write" holds that rule for free. `rename(2)` moves the directory
 * entry itself, so a symlink is moved as a link and a FIFO as a FIFO; no
 * target is ever touched. Never throws; one warn line either way.
 */
export function setAsideRefused(file: string, log: Logger): void {
  // UTC, with ':' and '.' replaced so the name is portable (drvfs refuses ':').
  const aside = `${file}.refused-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    renameSync(file, aside);
    log('warn', `${file} (refused at load) kept as ${aside} before the first write`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'rename failed';
    log('warn', `${file} (refused at load) could not be set aside (${code}) before the first write`);
  }
}

/** `application/json`, with or without parameters (charset), case-insensitive. */
export function isJsonContentType(value: string | string[] | undefined): boolean {
  if (typeof value !== 'string') return false;
  return value.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/** The largest terminal side a client may ask for (columns or rows). */
export const MAX_TERM_DIM = 1000;

/** A terminal dimension a client may ask for: POST /api/sessions and the WS `resize` frame. */
export function isValidDim(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_TERM_DIM;
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** True when `p` is an existing directory (symlinks followed, like statSync elsewhere). */
export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export { killQuietly, runCapture, runChild } from './config-spawn.ts';
