/**
 * Data directory resolution and file logging.
 *
 * Data dir: ~/.ai-session-manager/ (created 0700), overridable via the
 * AI_SM_DATA_DIR env var (must be an absolute path). Holds runtime.json,
 * projects.json, prefs.json, github.json, history.json,
 * session-settings/ (0700, wiped at boot), statusline-cache.json (0600, wiped
 * at boot) and server.log.
 *
 * The process runs detached — nothing may depend on stdout. All logging
 * appends to server.log in the data dir: one line per event, shaped
 * `<ISO> [level] [component] message`, at debug/info/warn/error. The minimum
 * level comes from AI_SM_LOG_LEVEL and DEFAULTS TO debug — the user's rule is
 * that everything is logged, because server.log is the only diagnostic channel
 * a detached process has. Past MAX_LOG_BYTES the file rotates through two
 * generations (server.log.1, server.log.2).
 *
 * NOTHING SECRET GOES IN THE LOG: not the auth token, not the GitHub token, not
 * request bodies, not Authorization headers, not query-string values, not PTY
 * input/output. 0600 is not the protection (it does not hold against the
 * Windows user — memory/knowledge/wsl-0600-not-a-boundary.md); not writing the
 * secret is.
 */
import {
  mkdirSync,
  appendFileSync,
  chmodSync,
  writeFileSync,
  renameSync,
  statSync,
  truncateSync,
} from 'node:fs';
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
  /**
   * Persistent session history across runs (feeds GET /api/history and the
   * resume route). Written atomically 0600 on every session create/end.
   */
  historyFile: string;
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
    historyFile: join(dataDir, 'history.json'),
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

/** Severity, ascending. 'debug' is the default minimum (see resolveLogLevel). */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * One log line per call. The signature is deliberately `(level, message)` —
 * every call site in server/ predates the debug level and must keep compiling.
 * Component tagging is done by `scoped()`, which only prefixes the message.
 */
export type Logger = (level: LogLevel, message: string) => void;

/** Ascending severity; the index in this array IS the comparison order. */
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Minimum level when AI_SM_LOG_LEVEL is unset or unusable: log EVERYTHING. */
export const DEFAULT_LOG_LEVEL: LogLevel = 'debug';

export interface ResolvedLogLevel {
  level: LogLevel;
  /** The raw env value, or undefined when unset/empty. */
  raw: string | undefined;
  /** False when `raw` was set but not one of LOG_LEVELS (caller warns). */
  valid: boolean;
}

/**
 * Effective minimum log level from AI_SM_LOG_LEVEL (debug|info|warn|error),
 * defaulting to 'debug' — the user's standing request is that everything is
 * logged unless they say otherwise. An unrecognized value never silences the
 * log: it falls back to the default and is reported by the caller (index.ts
 * writes the boot banner line).
 */
export function resolveLogLevel(value = process.env['AI_SM_LOG_LEVEL']): ResolvedLogLevel {
  const raw = value === undefined || value === '' ? undefined : value;
  if (raw === undefined) return { level: DEFAULT_LOG_LEVEL, raw: undefined, valid: true };
  const normalized = raw.trim().toLowerCase();
  if ((LOG_LEVELS as readonly string[]).includes(normalized)) {
    return { level: normalized as LogLevel, raw, valid: true };
  }
  return { level: DEFAULT_LOG_LEVEL, raw, valid: false };
}

/**
 * Cap on server.log before rotation. Two generations are kept (server.log.1,
 * server.log.2), so total log usage on disk is bounded by 3x this.
 */
export const MAX_LOG_BYTES = 10 * 1024 * 1024;

/** Longest rendered error (message + flattened stack) that reaches one line. */
export const MAX_ERROR_TEXT = 2000;

/**
 * Control characters and newlines that would forge extra log lines: C0 + DEL,
 * the C1 block U+0080-U+009F (U+0085 NEL is a line break and U+009B is a
 * single-byte CSI to a terminal), and the Unicode line/paragraph separators
 * U+2028/U+2029.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * One-line rendering of an arbitrary thrown value, WITH its stack.
 *
 * The stack is flattened (newlines -> ' | ') because the log contract is one
 * line per event: a multi-line entry breaks grep, breaks line counting, and —
 * for anything derived from client input — would let a newline fabricate a
 * fake timestamped line.
 *
 * CAUTION: an Error's MESSAGE can embed request data (Node's JSON.parse quotes
 * ~10 characters of the input). Do not use this on any path that has a request
 * body or a credential in scope — use errorClass()/errorStackOnly() there. See
 * the redaction notes in server/api.ts and server/github.ts.
 */
export function describeError(err: unknown): string {
  const text =
    err instanceof Error
      ? (err.stack ?? `${err.name}: ${err.message}`)
      : typeof err === 'string'
        ? err
        : String(err);
  const flat = text.replace(/\s*\n\s*/g, ' | ').replace(CONTROL_CHARS, ' ').trim();
  return flat.length > MAX_ERROR_TEXT ? `${flat.slice(0, MAX_ERROR_TEXT)}…` : flat;
}

/** The error's CLASS name only — a runtime constant, never derived from input. */
export function errorClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

/**
 * REDACTED error rendering for the paths where the message itself may quote a
 * secret (a JSON.parse SyntaxError quotes the body; GitHub errors can quote a
 * token): the class name plus the stack FRAMES, with the message line dropped.
 */
export function errorStackOnly(err: unknown): string {
  const cls = errorClass(err);
  const frames = errorFrames(err);
  const text = frames === '' ? cls : `${cls} | ${frames}`;
  return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}…` : text;
}

/**
 * The stack FRAMES alone (`at f (file:line)` lines, one-lined), with the
 * message line dropped — for call sites that already print the class name and
 * must not print the message. Empty string when there is no usable stack.
 */
export function errorFrames(err: unknown): string {
  if (!(err instanceof Error) || err.stack === undefined) return '';
  // The message is removed BY LENGTH, not by line: V8 does not escape newlines
  // inside the ~10-character input fragment a JSON.parse SyntaxError quotes, so
  // a body of `\n    at ghp_SECRET` would otherwise put a forged frame line
  // past the message and survive the /^\s+at\s/ filter below.
  //
  // A stack that does NOT begin with that header is one we cannot split safely
  // (a hand-assigned `stack`, a rename after formatting), so it yields NOTHING
  // rather than falling back to the line filter the attack defeats.
  const header = `${err.name}: ${err.message}`;
  if (!err.stack.startsWith(header)) return '';
  const frames = err.stack
    .slice(header.length)
    .split('\n')
    .filter((line) => /^\s+at\s/.test(line))
    .map((line) => line.trim())
    .join(' | ')
    .replace(CONTROL_CHARS, ' ');
  return frames.length > MAX_ERROR_TEXT ? `${frames.slice(0, MAX_ERROR_TEXT)}…` : frames;
}

/** Strip control characters/newlines so a value can never forge a log line. */
export function oneLine(value: string): string {
  return value.replace(CONTROL_CHARS, ' ');
}

/** A logger that prefixes every message with `[component] `. */
export function scoped(log: Logger, component: string): Logger {
  return (level, message) => log(level, `[${component}] ${message}`);
}

/**
 * Longest request pathname that reaches a log line. A path is attacker-chosen
 * and unbounded (Node accepts a request target of many kilobytes), so an
 * uncapped one turns every access-log line into a disk-filling primitive.
 */
export const MAX_LOGGED_ROUTE_CHARS = 256;

/** Refused / unauthenticated log lines allowed per fixed minute. */
export const REFUSAL_LOG_MAX_PER_MINUTE = 60;
/** Length of every budget window in this file (client-log budget included). */
export const LOG_WINDOW_MS = 60_000;

export interface WindowLimiterOptions {
  log: Logger;
  /** Events allowed through per window. */
  max: number;
  /** Fixed (not sliding) window length. */
  windowMs?: number;
  /**
   * Written ONCE per window, the moment the budget is first exceeded. Says
   * what is being dropped, so silence is never mistaken for quiet.
   */
  exceeded: (max: number) => string;
  /**
   * Written when the NEXT event rolls over a window that had suppressions, so
   * the file states the total it did not show. Omit for no summary.
   */
  summary?: (suppressed: number) => string;
  /** Clock SEAM: tests inject one instead of monkeypatching the global. */
  now?: () => number;
}

/**
 * A fixed-window budget shared by everything in this app that must keep a
 * runaway producer from filling server.log. Returns `allow()`: true while this
 * window's budget lasts, false afterwards — at most two bookkeeping lines per
 * window, whatever the flood's size.
 */
export function createWindowLimiter(opts: WindowLimiterOptions): () => boolean {
  const { log, max, exceeded, summary } = opts;
  const windowMs = opts.windowMs ?? LOG_WINDOW_MS;
  const now = opts.now ?? Date.now;
  let windowStart = 0;
  let written = 0;
  let suppressed = 0;
  return () => {
    if (now() - windowStart >= windowMs) {
      if (suppressed > 0 && summary !== undefined) log('warn', summary(suppressed));
      windowStart = now();
      written = 0;
      suppressed = 0;
    }
    if (written < max) {
      written += 1;
      return true;
    }
    suppressed += 1;
    if (suppressed === 1) log('warn', exceeded(max));
    return false;
  };
}

/**
 * The budget for log lines produced by requests that were NOT authenticated —
 * every one of which any web page on the machine can trigger (an `<img>` or a
 * `no-cors` fetch to 127.0.0.1:<port> carries no Origin, so it reaches the
 * static, /health, 404 and 401/403 paths alike). ONE instance is shared by the
 * HTTP access log and the WebSocket upgrade reject, so the documented ceiling
 * is the real one. Authenticated traffic is never metered by this.
 */
export function createRefusalLimiter(log: Logger, now?: () => number): () => boolean {
  return createWindowLimiter({
    log,
    max: REFUSAL_LOG_MAX_PER_MINUTE,
    ...(now !== undefined ? { now } : {}),
    exceeded: (max) =>
      `suppressed refused request log lines: past ${max} per minute ` +
      'they are counted, not written',
    summary: (n) => `suppressed ${n} refused request log line(s) in the last window`,
  });
}

/**
 * Appends timestamped lines to server.log:
 *
 *     2026-09-06T10:11:12.345Z [info] [http] GET /api/history -> 200 in 3ms
 *     <ISO 8601>              [level] [component] message
 *
 * The `[component]` part comes from scoped() and is simply part of the message;
 * older call sites log without one.
 *
 * Never throws (a detached process has nowhere to report). Lines below
 * `minLevel` are dropped before any I/O. When the file would exceed
 * MAX_LOG_BYTES it is rotated: server.log.1 -> server.log.2, server.log ->
 * server.log.1, each forced to mode 0600.
 */
export function createLogger(logFile: string, minLevel: LogLevel = DEFAULT_LOG_LEVEL): Logger {
  let bytes: number;
  try {
    bytes = statSync(logFile).size;
  } catch {
    bytes = 0;
  }
  const threshold = LOG_LEVELS.indexOf(minLevel);
  return (level, message) => {
    try {
      if (LOG_LEVELS.indexOf(level) < threshold) return;
      const line = `${new Date().toISOString()} [${level}] ${message}\n`;
      if (bytes + Buffer.byteLength(line) > MAX_LOG_BYTES) {
        // rotate() never throws, and the counter restarts WHATEVER it managed
        // to do. A throwing rotate used to silence the log permanently: the
        // outer catch swallowed it, `bytes` stayed over the cap, and every
        // later line re-entered rotate(), threw again and was dropped.
        rotate(logFile);
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
 * Shift the generations: .1 -> .2 (replacing it), then the live file -> .1.
 * Modes are forced to 0600 afterwards — rename preserves whatever the original
 * had, and a rotated file holds exactly the same content as the live one.
 *
 * NEVER THROWS. If the generations cannot be shifted (something is in the way
 * of `.1`, the directory is read-only, ...) the live file is TRUNCATED in place
 * instead: losing a rotation is survivable, losing the log is not.
 *
 * Note (memory/knowledge/wsl-0600-not-a-boundary.md): 0600 does NOT keep the
 * Windows user out of these files. The real rule is that no secret is written
 * to them in the first place.
 */
function rotate(logFile: string): void {
  try {
    renameSync(`${logFile}.1`, `${logFile}.2`);
    chmodSync(`${logFile}.2`, 0o600);
  } catch {
    // No previous generation — nothing to shift.
  }
  try {
    renameSync(logFile, `${logFile}.1`);
  } catch {
    // The live file could not be moved aside. Truncate it so the cap still
    // holds and the next append lands, rather than letting every future line
    // re-enter this function.
    try {
      truncateSync(logFile, 0);
    } catch {
      // Nothing left to try; the append below still gets its chance.
    }
    return;
  }
  try {
    chmodSync(`${logFile}.1`, 0o600);
  } catch {
    // Best effort; the append below recreates the live file 0600 regardless.
  }
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
