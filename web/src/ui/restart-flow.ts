/**
 * The restart HANDSHAKE, DOM-free: POST -> outcome, plus the `/health` wait
 * that decides when the replacement backend is ready. Every side effect the
 * browser would perform (fetch, clock, sleep) arrives through `RestartDeps`,
 * so `tests/ui-update-model.test.ts` drives all four outcomes and both
 * timeouts without a browser. `./update.ts` owns the pixels and the two
 * navigation acts (`location.reload()` / `location.href`) — the only things
 * that cannot be modelled here.
 *
 * THE CONTRACT (server half, same phase):
 *   POST /api/restart
 *     202 { port, startedAt, samePort }  the replacement is already healthy
 *     409 { error }                      another restart is in flight
 *     500 { error }                      it did not come back
 *   GET /health   unauthenticated, the ONE call that still works across the
 *                 gap (this page's token dies with the old process).
 *
 * WHY THE HEALTH POLL EXISTS AT ALL, given the 202 already means "healthy":
 * the 202 is written by the OLD process moments before it exits, and the
 * socket that carried it is the last thing alive in it. Reloading on the spot
 * races the listener handover. Polling `/health` on the same origin is the
 * only honest "you can come back now".
 */
import type { RestartResponse } from '../../../shared/protocol.ts';

/** How often the gap is probed. Small: the whole wait is usually one second. */
export const HEALTH_POLL_MS = 250;
/** Ceiling on the wait. Past this the restart is reported as failed. */
export const HEALTH_TIMEOUT_MS = 20000;
/**
 * How long a plain browser tab is given to actually LEAVE for the new address
 * before the UI concedes it cannot follow. A host window locked to its launch
 * origin simply stays put, and there is no way to ask it — so we try, wait,
 * and read the result.
 */
export const OTHER_PORT_WAIT_MS = 2000;

/** Every failure the user can be shown. Exported so the tests pin the words. */
export const MSG_BUSY = 'A restart is already running. Give it a moment.';
export const MSG_LOST =
  'The backend did not come back. Close this window and start the app again from the desktop shortcut.';
export const MSG_OTHER_PORT =
  'The backend came back at a different address. Close this window and start the app again from the desktop shortcut.';

/** `restarting` while the POST is out, `reconnecting` while `/health` is polled. */
export type RestartPhase = 'restarting' | 'reconnecting';

export type RestartOutcome =
  /** Same address, replacement answered `/health` after `afterMs`: reload this page. */
  | { kind: 'reload'; afterMs: number }
  /** Auto-picked a different port: try to navigate, then fall back to `relaunch`. */
  | { kind: 'otherPort'; port: number }
  /** Another restart was already running; nothing happened. */
  | { kind: 'busy'; message: string }
  /** 500, a timeout, or a network failure — the message is what the user reads. */
  | { kind: 'failed'; message: string };

/** One HTTP answer, reduced to what this flow decides on. Never a header, never a token. */
export interface RestartHttpResult {
  status: number;
  /** Parsed JSON body, or null when there was none. */
  body: unknown;
}

export interface RestartDeps {
  /** POST /api/restart with the app token — resolves even on a network failure (status 0). */
  postRestart(): Promise<RestartHttpResult>;
  /** GET /health WITHOUT the token; true only on a 2xx. Never rejects. */
  health(): Promise<boolean>;
  /** Monotonic-enough clock for the timeout budget. */
  now(): number;
  /** Resolve after `ms`. */
  sleep(ms: number): Promise<void>;
  /** Progress for the dialog's in-flight text. */
  onPhase(phase: RestartPhase): void;
}

/** Server-supplied error text, or the given fallback. Never a body dump. */
function errorText(body: unknown, fallback: string): string {
  if (body !== null && typeof body === 'object') {
    const e = (body as { error?: unknown }).error;
    if (typeof e === 'string' && e !== '') return e;
  }
  return fallback;
}

/**
 * A real TCP port. `port` is only ever used to BUILD A NAVIGATION URL
 * (`loopbackUrl`), so `Number.isFinite` is not enough: 0, -1, 1e9 and 8080.5
 * are all finite and would each produce an address this window is asked to go
 * to. Only 1-65535 integers pass; anything else makes the body unparseable and
 * the flow waits on THIS origin instead of navigating somewhere invented.
 */
function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** The 202 body, or null when it is not the shape the contract promises. */
export function parseRestartBody(body: unknown): RestartResponse | null {
  if (body === null || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  if (!isPort(o.port)) return null;
  if (typeof o.startedAt !== 'string') return null;
  if (typeof o.samePort !== 'boolean') return null;
  return { port: o.port, startedAt: o.startedAt, samePort: o.samePort };
}

/**
 * Wait for the replacement to answer `/health`. Returns the elapsed ms, or
 * null when the budget ran out. The FIRST probe happens immediately: on a warm
 * handover the child is usually already listening by the time the 202 lands.
 */
export async function waitForHealth(
  deps: Pick<RestartDeps, 'health' | 'now' | 'sleep'>,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<number | null> {
  const started = deps.now();
  for (;;) {
    if (await deps.health()) return Math.max(0, deps.now() - started);
    if (deps.now() - started >= timeoutMs) return null;
    await deps.sleep(HEALTH_POLL_MS);
  }
}

/**
 * The whole handshake. Never throws: every path the user can hit resolves to
 * an outcome carrying the words to show.
 */
export async function runRestart(deps: RestartDeps): Promise<RestartOutcome> {
  deps.onPhase('restarting');
  let res: RestartHttpResult;
  try {
    res = await deps.postRestart();
  } catch {
    return { kind: 'failed', message: MSG_LOST };
  }

  if (res.status === 409) return { kind: 'busy', message: errorText(res.body, MSG_BUSY) };
  if (res.status !== 202) return { kind: 'failed', message: errorText(res.body, MSG_LOST) };

  const parsed = parseRestartBody(res.body);
  // A 202 whose body is not the contract: the old process IS gone either way,
  // so the honest move is to wait for this origin and reload if it comes back.
  if (parsed !== null && !parsed.samePort) return { kind: 'otherPort', port: parsed.port };

  deps.onPhase('reconnecting');
  const took = await waitForHealth(deps);
  if (took === null) return { kind: 'failed', message: MSG_LOST };
  return { kind: 'reload', afterMs: took };
}

/** `http://127.0.0.1:<port>/` — the only address a fallback navigation may use. */
export function loopbackUrl(port: number): string {
  return `http://127.0.0.1:${port}/`;
}
