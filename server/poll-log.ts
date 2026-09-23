/**
 * The poll summary: successful polls are COUNTED, not written one line each
 * (Quality P4, `.claude/plans/PLAN-QUALITY.md` § The decision that started it,
 * item 5; the user's amendment to `memory/decisions/log-everything.md`,
 * 2026-09-23).
 *
 * P0 measured the idle log with the page and four sessions open at 64 lines a
 * minute, 94 % of them the poll — a 10 MiB generation in ~30 h. The default
 * log level is `debug` (AI_SM_LOG_LEVEL), so demoting the lines to debug would
 * not have shrunk the default file; the rule instead: a successful, prompt
 * poll adds one to a counter, and ONE `debug` line per minute states the
 * counts per route and status —
 *
 *     polls last 60s: GET /api/sessions 200 ×20, GET /api/runtime 200 ×2
 *
 * — and none at all in a minute without polls. Routes and statuses only,
 * never a query. A FAILED poll (any status outside 2xx, an aborted response)
 * or a SLOW one (SLOW_POLL_MS or more) is not counted: server/api.ts writes
 * its access line at once, exactly as loud as before.
 *
 * `PollTally` owns the counter and its timer; server/index.ts owns the one
 * instance, and both shutdown() and the restart teardown stop it, which
 * writes the partial window's summary first so the last minute is not lost.
 */
import type { Logger } from './config.ts';

/** How often the summary line is written (and the counter restarts). */
export const POLL_SUMMARY_MS = 60_000;

/**
 * A poll that took this long is a diagnostic in itself (loopback answers in a
 * few ms), so it gets its own access line rather than a count.
 */
export const SLOW_POLL_MS = 1_000;

/**
 * The polled routes, as `METHOD pathname`: the page's session list (3 s) and
 * update notice (30 s), the mascot page's sessions + prefs (2 s), the update
 * progress readout (1 Hz during an install), and the browser's own log
 * shipping, which fires with every client batch.
 */
const POLL_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/sessions',
  'GET /api/runtime',
  'GET /api/prefs',
  'GET /api/update/status',
  'POST /api/client-log',
]);

/**
 * Is this finished request a successful, prompt poll — counted, not written?
 * `route` is the pathname (the query is never part of it); `status` 0 means
 * the response never finished.
 */
export function isQuietPoll(method: string, route: string, status: number, ms: number): boolean {
  return (
    POLL_ROUTES.has(`${method} ${route}`) && status >= 200 && status < 300 && ms < SLOW_POLL_MS
  );
}

export interface PollTallyOptions {
  /** The `[http]`-scoped logger the access log writes through. */
  log: Logger;
  /** Clock SEAM: tests pass one so the window length in the line is exact. */
  now?: () => number;
  /**
   * Timer SEAM: starts the repeating flush and returns its cancel. Tests pass
   * one they fire by hand instead of waiting a minute; the default is an
   * unref'd setInterval, so the summary never keeps the process alive.
   */
  every?: (fn: () => void, ms: number) => () => void;
}

function unrefInterval(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
}

export class PollTally {
  readonly #log: Logger;
  readonly #now: () => number;
  /** `METHOD route status` → count, in first-seen order within the window. */
  readonly #counts = new Map<string, number>();
  #windowStart: number;
  #cancel: (() => void) | null;

  constructor(opts: PollTallyOptions) {
    this.#log = opts.log;
    this.#now = opts.now ?? Date.now;
    this.#windowStart = this.#now();
    this.#cancel = (opts.every ?? unrefInterval)(() => this.flush(), POLL_SUMMARY_MS);
  }

  /** Count one successful poll (the caller checked isQuietPoll). */
  count(method: string, route: string, status: number): void {
    const key = `${method} ${route} ${status}`;
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);
  }

  /**
   * Write the window's summary line — nothing when nothing was counted — and
   * start a new window.
   */
  flush(): void {
    const now = this.#now();
    const seconds = Math.round((now - this.#windowStart) / 1000);
    this.#windowStart = now;
    if (this.#counts.size === 0) return;
    const parts = [...this.#counts].map(([key, n]) => `${key} ×${n}`);
    this.#counts.clear();
    this.#log('debug', `polls last ${seconds}s: ${parts.join(', ')}`);
  }

  /** Shutdown: write the partial window, then stop the timer. Idempotent. */
  stop(): void {
    this.flush();
    this.#cancel?.();
    this.#cancel = null;
  }
}
