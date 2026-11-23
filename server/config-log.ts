/**
 * File logging: the levels, the `Logger` every module writes through,
 * `createLogger` (server.log, rotated), the one-line error rendering, and the
 * fixed-window budgets that keep a flood out of the file.
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
 *
 * Split from server/config.ts (PLAN-QUALITY Q13, 2026-11-22), moved unchanged;
 * importers take it from here. Siblings: server/config.ts (data dir, file
 * writes, request predicates), server/config-spawn.ts (the bounded child
 * runner).
 */
import { chmodSync, closeSync, fstatSync, openSync, renameSync, statSync, truncateSync, writeSync } from 'node:fs';

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
 * log: it falls back to the default and is reported by the caller
 * (server/index-banner.ts writes the boot banner line).
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
const MAX_ERROR_TEXT = 2000;

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

interface WindowLimiterOptions {
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
 * How often (at most) a logger checks that its open file is still the one at
 * its path — a log removed or renamed from outside is then reopened (see
 * createLogger). A stat per second, not per line.
 */
const LOG_PATH_CHECK_MS = 1000;

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
 *
 * The file stays OPEN between lines (PLAN-QUALITY Q12: an open/write/close per
 * line cost ~7 µs): opened on the first line with O_APPEND, created 0600,
 * close-on-exec (Node's default, so no PTY child inherits it). It is closed
 * and reopened (a) after a rotation, (b) after a failed write — the next line
 * opens it again, and (c) when the path no longer names the open file: at
 * most once per LOG_PATH_CHECK_MS a line stats the path, and a log deleted
 * or renamed from outside is recreated there. Lines written between such an
 * outside removal and that check land in the removed file (at most
 * LOG_PATH_CHECK_MS of them). The byte count restarts from the reopened
 * file's size. During a restart the old and the new backend both hold
 * server.log open: after one rotates it, the other keeps writing into
 * server.log.1 for up to LOG_PATH_CHECK_MS and then reopens server.log — lines
 * out of order for at most a second, none lost.
 */
export function createLogger(logFile: string, minLevel: LogLevel = DEFAULT_LOG_LEVEL): Logger {
  let bytes: number;
  try {
    bytes = statSync(logFile).size;
  } catch {
    bytes = 0;
  }
  const threshold = LOG_LEVELS.indexOf(minLevel);
  let fd: number | undefined;
  let ino = 0;
  let checkedAt = 0;
  const close = (): void => {
    if (fd === undefined) return;
    try {
      closeSync(fd);
    } catch {
      // Already gone; the next line opens a fresh one.
    }
    fd = undefined;
  };
  const open = (): number => {
    const opened = openSync(logFile, 'a', 0o600);
    const st = fstatSync(opened);
    fd = opened;
    ino = st.ino;
    bytes = st.size;
    checkedAt = performance.now();
    return opened;
  };
  /** The open fd, reopened when the path names another file or none (c). */
  const current = (): number => {
    if (fd === undefined) return open();
    const now = performance.now();
    if (now - checkedAt < LOG_PATH_CHECK_MS) return fd;
    checkedAt = now;
    let same = false;
    try {
      same = statSync(logFile).ino === ino;
    } catch {
      // Removed from outside.
    }
    if (same) return fd;
    close();
    return open();
  };
  return (level, message) => {
    try {
      if (LOG_LEVELS.indexOf(level) < threshold) return;
      const line = Buffer.from(`${new Date().toISOString()} [${level}] ${message}\n`, 'utf8');
      let target = current();
      if (bytes + line.byteLength > MAX_LOG_BYTES) {
        // rotate() never throws, and the counter restarts WHATEVER it managed
        // to do. A throwing rotate used to silence the log permanently: the
        // outer catch swallowed it, `bytes` stayed over the cap, and every
        // later line re-entered rotate(), threw again and was dropped.
        close();
        rotate(logFile);
        target = open();
        bytes = 0;
      }
      let at = 0;
      while (at < line.byteLength) at += writeSync(target, line, at);
      bytes += line.byteLength;
    } catch {
      // Nothing sane to do — stdout must not be relied on. A failed write may
      // mean a bad fd: the next line reopens the file (b).
      close();
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
