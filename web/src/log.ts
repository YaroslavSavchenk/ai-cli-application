/**
 * Client logging — the browser half of "everything gets logged" (user's
 * request, 2026-09-06). Every module calls `log.debug/info/warn/error(...)`;
 * the lines are mirrored to the devtools console AND batched to the backend
 * (POST /api/client-log), which appends them to
 * `~/.ai-session-manager/server.log`. The backend runs detached with no
 * stdout, so that file is the only place a user (or a future session) can
 * read what the browser did.
 *
 * WHAT MAY NEVER APPEAR IN A LOG LINE — enforced at the call sites, since
 * this module cannot inspect what it is handed:
 *   - the auth token or ANY request header,
 *   - request or response BODIES (the server's own error text is fine — it is
 *     already the message the user is shown),
 *   - terminal input/output bytes (only their SIZE, never their content),
 *   - raw custom-command text the user typed (shape only: yes/no + token
 *     count).
 *
 * This module deliberately does NOT go through `api.ts`: routing log delivery
 * through the instrumented request helper would log the log request, whose
 * own failures would log again. It carries its own bare fetch and reads the
 * token from `window.__AUTH__` directly.
 *
 * The batching/backoff policy — and every constant behind it — lives in
 * `./log-core.ts`, which is DOM-free so `tests/ui-log.test.ts` can drive it.
 */
import {
  ClientLogger,
  batchBody,
  formatError,
  oneLine,
  truncate,
  type ClientLogEntry,
  type SendResult,
} from './log-core.ts';

const ENDPOINT = '/api/client-log';

/**
 * The token travels in the same header every other authed call uses. It is
 * NEVER put in a URL, a log line, or a body.
 */
function authHeader(): Record<string, string> | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  if (typeof fetch !== 'function') return null;
  const token: unknown = (window as { __AUTH__?: unknown }).__AUTH__;
  if (typeof token !== 'string' || token === '') return null;
  return { 'content-type': 'application/json', 'x-auth-token': token };
}

/**
 * POST one batch. `sendBeacon` cannot carry the X-Auth-Token header (and the
 * token must not travel in a URL), so the unload path uses `keepalive: true`
 * instead — a keepalive fetch survives the page, carries headers, and honors
 * the same 64 KiB body ceiling the route enforces.
 */
async function post(entries: readonly ClientLogEntry[], keepalive: boolean): Promise<SendResult> {
  const headers = authHeader();
  // No browser (node tests) or no token: report a permanent status so the
  // logger switches itself off after one attempt instead of retrying forever.
  if (headers === null) return { ok: false, status: 404 };
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: batchBody(entries),
      keepalive,
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 }; // network-level failure — retryable
  }
}

const logger = new ClientLogger({
  nowIso: () => new Date().toISOString(),
  send: (entries) => post(entries, false),
  beacon: (entries) => {
    void post(entries, true);
  },
  schedule: (fn, ms) => {
    const handle: unknown = setTimeout(fn, ms);
    // Node (tests, and any non-browser import of a module that logs) returns a
    // Timeout object: unref it so a pending flush can never hold a process
    // open. Browsers return a number and skip this.
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      (handle as { unref(): void }).unref();
    }
    return () => clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  mirror: (level, message) => {
    // Same level in devtools as in server.log, so a developer with the console
    // open sees exactly the stream the file will hold.
    if (level === 'error') console.error(message);
    else if (level === 'warn') console.warn(message);
    else if (level === 'info') console.info(message);
    else console.debug(message);
  },
  notice: (message) => console.warn(message),
});

/** The app-wide logger. Every method is single-line, never throws. */
export const log = {
  debug: (message: string): void => logger.debug(message),
  info: (message: string): void => logger.info(message),
  warn: (message: string): void => logger.warn(message),
  error: (message: string): void => logger.error(message),
};

/**
 * Anything thrown or rejected → ONE budget-fitting line (stack frames joined
 * with " | "). Re-exported here so a call site needs a single import to log an
 * error properly; the implementation lives in log-core.ts.
 */
export { formatError };

/**
 * Install the global capture: uncaught errors, unhandled rejections, and the
 * two page-death signals. Called once, first thing in main.ts — before boot,
 * so a crash during boot is still delivered.
 */
export function initLogging(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener('error', (e: ErrorEvent) => {
    // Resource-load failures arrive as a plain Event with no `error`/`message`.
    const detail =
      e.error !== undefined && e.error !== null
        ? formatError(e.error)
        : oneLine(typeof e.message === 'string' ? e.message : 'unknown error');
    const where =
      typeof e.filename === 'string' && e.filename !== ''
        ? ` at ${e.filename}:${e.lineno}:${e.colno}`
        : '';
    log.error(`uncaught: ${detail}${where}`);
  });

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    log.error(`unhandled rejection: ${formatError(e.reason)}`);
  });

  // Both signals, because neither alone is reliable: `pagehide` covers
  // navigation/close, `visibilitychange` covers the backgrounded-then-killed
  // case (mobile, and the WebView2 host being minimized out of existence).
  window.addEventListener('pagehide', () => logger.flushOnHide());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') logger.flushOnHide();
  });
}
