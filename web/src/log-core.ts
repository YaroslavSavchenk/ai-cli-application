/**
 * Client-log ENGINE — buffering, truncation, batching, retry policy. DOM-free,
 * fetch-free, timer-free on purpose: everything the browser supplies arrives
 * through `LoggerDeps`, so `node --test` can drive the whole policy
 * deterministically (tests/ui-log.test.ts). The browser glue is `./log.ts`.
 *
 * WHY THIS EXISTS. The backend runs detached — its stdout is gone and
 * `~/.ai-session-manager/server.log` is the user's only diagnostic channel. A
 * failing API call, a thrown handler or a dropped socket in the BROWSER used
 * to be invisible unless devtools happened to be open. Every client-side
 * event now travels to that same file (POST /api/client-log).
 *
 * TWO RULES THIS MODULE EXISTS TO ENFORCE.
 *   1. It must never throw. A logger that breaks the app it instruments is
 *      worse than no logger: every public method swallows its own failures.
 *   2. It must never loop. The transport's OWN failures are NOT logged (they
 *      would produce entries whose delivery fails, producing entries...) —
 *      they surface once per failure streak through `deps.notice`, i.e. one
 *      console line, and the entries wait behind a capped backoff.
 *
 * NEVER LOG: the auth token, request/response bodies, terminal input or
 * output bytes, or raw user-typed command text. That rule lives at the CALL
 * SITES; this module cannot see what it is handed.
 */

import type { ClientLogEntry, ClientLogLevel } from '../../shared/protocol.ts';

/** The wire vocabulary IS the protocol's — one source of truth for both ends. */
export type LogLevel = ClientLogLevel;
export type { ClientLogEntry };

/** Server truncates at the same number; we pre-truncate so the line stays ours. */
export const MAX_MESSAGE_CHARS = 2048;
/** Server accepts at most this many entries per request. */
export const MAX_BATCH_ENTRIES = 50;
/** Server body cap is 64 KiB; stay under it with room for the envelope. */
export const MAX_BATCH_BYTES = 60 * 1024;
/** A failed flush keeps at most this many NEWEST entries; older ones are dropped. */
export const MAX_BUFFER_ENTRIES = 200;
/** Idle batching window. `error` bypasses it. */
export const FLUSH_MS = 2000;
/** Retry backoff after a transport failure: 2s, 4s, 8s, 16s, 30s, 30s… */
export const RETRY_MIN_MS = 2000;
export const RETRY_MAX_MS = 30000;

/**
 * HTTP statuses that mean "this endpoint will never accept a log line from
 * this page": a backend that predates the route (404), one that routes it
 * differently (405/501), or a rotated token (401/403 — the page is already
 * being taken over by api.ts). Retrying any of them is a guaranteed loop, so
 * the transport switches off for good and logging degrades to the console.
 */
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 405, 501]);

/** Retry-worthy: a network failure (0), a timeout, or a rate-limit/server hiccup. */
function isRetryable(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export interface SendResult {
  ok: boolean;
  /** HTTP status, or 0 for a network-level failure (no response at all). */
  status: number;
}

/** Everything the browser provides. Nothing here touches a global directly. */
export interface LoggerDeps {
  /** Timestamp for a new entry, ISO-8601. */
  nowIso(): string;
  /** POST one batch. MUST resolve (never reject) — glue catches its own errors. */
  send(entries: readonly ClientLogEntry[]): Promise<SendResult>;
  /** Fire-and-forget delivery during pagehide; no result is observable. */
  beacon(entries: readonly ClientLogEntry[]): void;
  /** Schedule `fn` after `ms`; returns its canceller. */
  schedule(fn: () => void, ms: number): () => void;
  /** Console mirror at the entry's own level, so devtools keep working. */
  mirror(level: LogLevel, message: string): void;
  /** Transport trouble. NOT a log entry — exactly one console line per streak. */
  notice(message: string): void;
}

/** Bytes a UTF-8 body would occupy (TextEncoder is standard in both runtimes). */
const encoder = new TextEncoder();

export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/**
 * Collapse to ONE line. The server strips newlines, but a log line that only
 * survives because the server repaired it is a line whose shape we do not
 * control: stack frames are joined with " | " HERE so a browser stack reads
 * as one intentional line rather than a squashed blob.
 *
 * The stripped class mirrors server/config.ts CONTROL_CHARS: C0 + DEL, the C1
 * block U+0080-U+009F (U+0085 NEL is a line break, U+009B a single-byte CSI),
 * and the Unicode separators U+2028/U+2029.
 */
export function oneLine(s: string): string {
  return s
    .replace(/\r\n?|\n/g, ' | ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** Cut to MAX_MESSAGE_CHARS, marking the cut inside the budget (never past it). */
export function truncate(s: string): string {
  return s.length <= MAX_MESSAGE_CHARS ? s : `${s.slice(0, MAX_MESSAGE_CHARS - 1)}…`;
}

/** One-line, budget-fitting rendering of anything thrown or rejected. */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    const stack = typeof err.stack === 'string' ? err.stack : '';
    // A browser stack usually starts with "Name: message"; only prepend when
    // it does not, so the line never says the same thing twice.
    const head = `${err.name}: ${err.message}`;
    return truncate(oneLine(stack.startsWith(err.name) ? stack : `${head} | ${stack}`.trim()));
  }
  if (typeof err === 'string') return truncate(oneLine(err));
  try {
    return truncate(oneLine(JSON.stringify(err) ?? String(err)));
  } catch {
    return truncate(oneLine(String(err)));
  }
}

/**
 * Splice the next batch off the FRONT of `buf`: at most MAX_BATCH_ENTRIES and
 * at most MAX_BATCH_BYTES serialized. At least one entry is always taken (a
 * single entry cannot exceed the body cap — its message is pre-truncated), so
 * an oversized head can never wedge the queue.
 */
export function takeBatch(buf: ClientLogEntry[]): ClientLogEntry[] {
  const batch: ClientLogEntry[] = [];
  let bytes = byteLength('{"entries":[]}');
  while (buf.length > 0 && batch.length < MAX_BATCH_ENTRIES) {
    const next = buf[0] as ClientLogEntry;
    const cost = byteLength(JSON.stringify(next)) + 1; // +1 for the comma
    if (batch.length > 0 && bytes + cost > MAX_BATCH_BYTES) break;
    bytes += cost;
    batch.push(next);
    buf.shift();
  }
  return batch;
}

/** JSON body for one batch — the exact ClientLogRequest shape. */
export function batchBody(entries: readonly ClientLogEntry[]): string {
  return JSON.stringify({ entries });
}

export class ClientLogger {
  readonly #deps: LoggerDeps;
  readonly #buf: ClientLogEntry[] = [];
  #cancelTimer: (() => void) | null = null;
  #inFlight = false;
  #again = false;
  #retryMs = RETRY_MIN_MS;
  #failing = false;
  #off = false;
  #dropped = 0;

  constructor(deps: LoggerDeps) {
    this.#deps = deps;
  }

  /** Entries waiting to be delivered (tests + the pagehide path read this). */
  get buffered(): number {
    return this.#buf.length;
  }

  /** True once the endpoint answered something permanent — console-only from then on. */
  get off(): boolean {
    return this.#off;
  }

  /** Entries thrown away by the 200-entry cap (visibility for tests/diagnostics). */
  get dropped(): number {
    return this.#dropped;
  }

  debug(message: string): void {
    this.log('debug', message);
  }
  info(message: string): void {
    this.log('info', message);
  }
  warn(message: string): void {
    this.log('warn', message);
  }
  error(message: string): void {
    this.log('error', message);
  }

  log(level: LogLevel, message: string): void {
    try {
      const text = truncate(oneLine(message));
      this.#deps.mirror(level, text);
      if (this.#off) return;
      this.#buf.push({ level, at: this.#deps.nowIso(), message: text });
      this.#trim();
      // `error` goes now — a crash is exactly the case where the next 2s may
      // never arrive. A batch-sized buffer goes now too, so a burst does not
      // wait on the idle window. Both defer to an active failure backoff:
      // hammering a dead endpoint is the loop this class must not have.
      if (!this.#failing && (level === 'error' || this.#buf.length >= MAX_BATCH_ENTRIES)) {
        void this.flush();
      } else {
        this.#arm(this.#failing ? this.#retryMs : FLUSH_MS);
      }
    } catch {
      // A logger may never break its caller.
    }
  }

  /** Send what is buffered (one batch per call; more batches follow on success). */
  async flush(): Promise<void> {
    if (this.#off || this.#buf.length === 0) return;
    if (this.#inFlight) {
      this.#again = true;
      return;
    }
    this.#inFlight = true;
    this.#disarm();
    const batch = takeBatch(this.#buf);
    let result: SendResult;
    try {
      result = await this.#deps.send(batch);
    } catch {
      result = { ok: false, status: 0 };
    }
    this.#inFlight = false;
    if (result.ok) {
      this.#failing = false;
      this.#retryMs = RETRY_MIN_MS;
      if (this.#buf.length > 0 || this.#again) {
        this.#again = false;
        void this.flush();
      }
      return;
    }
    this.#again = false;
    if (PERMANENT_STATUSES.has(result.status)) {
      // The endpoint is not there (or this page's token is dead). Stop for
      // good: keep mirroring to the console, deliver nothing, retry nothing.
      this.#off = true;
      this.#buf.length = 0;
      this.#deps.notice(
        `client logging off — /api/client-log answered ${result.status}; lines stay in this console`,
      );
      return;
    }
    // ONE console line per failure STREAK, whatever the streak's length: the
    // failure of the log transport is never itself logged, and a backend that
    // is merely down must not turn the console into the noise it replaced.
    const first = !this.#failing;
    if (isRetryable(result.status)) {
      // Put the batch back in FRONT (oldest first) and wait out the backoff.
      this.#buf.unshift(...batch);
      this.#trim();
      if (first) {
        this.#deps.notice(
          `client log flush failed (${result.status === 0 ? 'network' : result.status}); retrying`,
        );
      }
    } else if (first) {
      // A 4xx we cannot fix by repeating (413 and friends): the batch is
      // dropped rather than left to wedge every later line behind it.
      this.#deps.notice(
        `client log batch rejected (${result.status}); ${batch.length} lines dropped`,
      );
    }
    this.#failing = true;
    this.#arm(this.#retryMs);
    this.#retryMs = Math.min(this.#retryMs * 2, RETRY_MAX_MS);
  }

  /**
   * Page is going away: hand everything to the fire-and-forget transport. No
   * awaiting is possible here, so nothing is requeued and nothing is retried.
   */
  flushOnHide(): void {
    try {
      if (this.#off) return;
      this.#disarm();
      // Bounded: a pagehide handler must not run long, and the transport has
      // its own per-request size cap.
      for (let i = 0; i < 4 && this.#buf.length > 0; i++) {
        this.#deps.beacon(takeBatch(this.#buf));
      }
    } catch {
      // Unloading; nothing can be done about a failure here.
    }
  }

  #trim(): void {
    const over = this.#buf.length - MAX_BUFFER_ENTRIES;
    if (over > 0) {
      this.#buf.splice(0, over); // keep the NEWEST 200
      this.#dropped += over;
    }
  }

  #arm(ms: number): void {
    if (this.#cancelTimer !== null || this.#off) return;
    this.#cancelTimer = this.#deps.schedule(() => {
      this.#cancelTimer = null;
      void this.flush();
    }, ms);
  }

  #disarm(): void {
    if (this.#cancelTimer !== null) {
      this.#cancelTimer();
      this.#cancelTimer = null;
    }
  }
}
