/**
 * Data directory resolution and file logging.
 *
 * Data dir: ~/.ai-session-manager/ (created 0700), overridable via the
 * AI_SM_DATA_DIR env var (must be an absolute path). Holds runtime.json,
 * projects.json, prefs.json, github.json, journal.json, previous.json,
 * session-settings/ (0700, wiped at boot), statusline-cache.json (0600, wiped
 * at boot) and server.log.
 *
 * The process runs detached — nothing may depend on stdout. All logging
 * appends to server.log in the data dir.
 */
import { mkdirSync, appendFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';

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
  /** Crash-safe session journal for the CURRENT run. */
  journalFile: string;
  /** Rotated journal of the PREVIOUS run (feeds GET /api/previous). */
  previousFile: string;
  /**
   * Per-session Claude Code settings files (`--settings <file>`, one per
   * claude session, holding only our statusLine key). Created 0700 and WIPED
   * at boot by SessionSettingsStore — no session survives a restart, so any
   * file found here at startup is garbage.
   */
  sessionSettingsDir: string;
  /**
   * Git-branch cache written by server/statusline.mjs (mode 0600), keyed by
   * Claude Code session id. Deleted at boot by server/index.ts: no session
   * survives a restart, so a leftover is at best useless and at worst a
   * poisoned string from a previous run.
   *
   * MUST AGREE WITH server/statusline.mjs: that script imports nothing from
   * server/ (it runs inside the foreign `claude` process) and therefore derives
   * this same path itself, as `<dirname of prefs.json>/statusline-cache.json`.
   * Change one and you must change the other.
   */
  statuslineCacheFile: string;
  logFile: string;
}

/** Resolve (and create, mode 0700) the data dir. Throws on a relative AI_SM_DATA_DIR. */
export function resolveDataPaths(): DataPaths {
  const override = process.env['AI_SM_DATA_DIR'];
  let dataDir: string;
  if (override !== undefined && override !== '') {
    if (!isAbsolute(override)) {
      throw new Error(`AI_SM_DATA_DIR must be an absolute path, got: ${override}`);
    }
    dataDir = override;
  } else {
    dataDir = join(homedir(), '.ai-session-manager');
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return {
    dataDir,
    runtimeFile: join(dataDir, 'runtime.json'),
    projectsFile: join(dataDir, 'projects.json'),
    prefsFile: join(dataDir, 'prefs.json'),
    githubFile: join(dataDir, 'github.json'),
    journalFile: join(dataDir, 'journal.json'),
    previousFile: join(dataDir, 'previous.json'),
    sessionSettingsDir: join(dataDir, 'session-settings'),
    statuslineCacheFile: join(dataDir, 'statusline-cache.json'),
    logFile: join(dataDir, 'server.log'),
  };
}

/**
 * GitHub REST API base. The DEVICE-FLOW endpoints (github.com/login/...) and the
 * clone host-lock (host must be exactly github.com) are deliberately NOT part of
 * this and stay hardcoded in github.ts.
 */
export const DEFAULT_GITHUB_API_BASE = 'https://api.github.com';

/**
 * Hostnames accepted for an AI_SM_GITHUB_API_BASE override. Exact allowlist —
 * NOT a 127.0.0.0/8 range check — so 127.0.0.2, 0.0.0.0, or any routable host is
 * refused. `localhost` is included for ergonomics; pointing it elsewhere needs
 * root-level /etc/hosts control, which is already outside this trust boundary.
 */
const LOOPBACK_API_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Validate an AI_SM_GITHUB_API_BASE value and return its normalized origin.
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
export function assertLoopbackApiBase(value: string): string {
  const fail = (why: string): never => {
    throw new Error(`AI_SM_GITHUB_API_BASE ${why} (expected e.g. http://127.0.0.1:8787), got: ${value}`);
  };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail('must be an absolute URL');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    // Never echo the value here — it carries the embedded credential.
    throw new Error('AI_SM_GITHUB_API_BASE must not embed credentials');
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

export type Logger = (level: 'info' | 'warn' | 'error', message: string) => void;

/** Cap on server.log before rotation to server.log.1 (total on disk <= 2x this). */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Appends timestamped lines to server.log. Never throws (a detached process has
 * nowhere to report). When the file exceeds MAX_LOG_BYTES it is rotated to
 * server.log.1 (replacing any previous one), bounding total log disk usage.
 */
export function createLogger(logFile: string): Logger {
  let bytes: number;
  try {
    bytes = statSync(logFile).size;
  } catch {
    bytes = 0;
  }
  return (level, message) => {
    try {
      const line = `${new Date().toISOString()} [${level}] ${message}\n`;
      if (bytes + Buffer.byteLength(line) > MAX_LOG_BYTES) {
        renameSync(logFile, `${logFile}.1`);
        bytes = 0;
      }
      appendFileSync(logFile, line, { mode: 0o600 });
      bytes += Buffer.byteLength(line);
    } catch {
      // Nothing sane to do — stdout must not be relied on.
    }
  };
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
