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
 *     422 { error }                      PREFLIGHT REFUSED — nothing was
 *                                        touched: the old backend is still
 *                                        serving, this page's token is still
 *                                        valid, every session is alive
 *     500 { error }                      it did not come back
 *   GET /health   unauthenticated, the ONE call that still works across the
 *                 gap (this page's token dies with the old process).
 *
 * WHY 422 IS ITS OWN OUTCOME AND NOT A `failed`. `failed` means the old
 * process is gone and this page is finished; `refused` means the POST changed
 * NOTHING. The two need opposite reactions — the refused path has to un-arm
 * the restart gap so the polls and both reconnect loops pick the still-live
 * backend straight back up, and it must never print the "close this window and
 * relaunch" sentence at a user whose app is working fine.
 *
 * The POST itself now takes as long as a build does (typically under 3 s, up
 * to about two minutes in the worst case), because the backend runs its whole
 * preflight — dependency check, screen rebuild, boot-verification of the
 * replacement — INSIDE the request, before it touches a single session. That
 * is why the first phase says "preparing", not "restarting": while it is out,
 * nothing has happened yet.
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
/**
 * The budget for the OTHER health wait: a page whose token was rejected without
 * having asked for anything (a second window restarted the backend underneath
 * it). Shorter than HEALTH_TIMEOUT_MS on purpose — nobody is watching a
 * progress dialog here, and the replacement has already been up long enough to
 * answer this window's request with a 401.
 */
export const RECOVER_TIMEOUT_MS = 5000;

/** Every failure the user can be shown. Exported so the tests pin the words. */
export const MSG_BUSY = 'A restart is already running. Give it a moment.';
export const MSG_LOST =
  'The backend did not come back. Close this window and start the app again from the desktop shortcut.';
export const MSG_OTHER_PORT =
  'The backend came back at a different address. Close this window and start the app again from the desktop shortcut.';
/**
 * Fallback for a 422 whose body carries no sentence. The server normally sends
 * its own — it is the only side that knows WHICH check refused — so this is the
 * shape-failure net, and it says the one thing that is true of every refusal.
 */
export const MSG_REFUSED =
  'The restart did not start, so nothing changed. Your sessions are still running.';

/**
 * `restarting` while the POST is out — which is now the PREFLIGHT: the backend
 * is checking and building, and has not touched anything yet. `reconnecting`
 * once the 202 says the handover happened and `/health` is being polled.
 */
export type RestartPhase = 'restarting' | 'reconnecting';

/**
 * May the user put the dialog away right now — without stopping anything?
 *
 * Yes during `restarting`, and only there. That phase is the PREFLIGHT: the
 * request is out, the backend is checking and building (up to two minutes on a
 * cold build), and it has not touched a single session. Every session is alive
 * and reachable, so locking the whole window behind a modal for the duration is
 * a cost with no purpose. Hiding aborts NOTHING: the flow keeps running with
 * the restart gap armed, and the dialog comes back with the outcome.
 *
 * No during `reconnecting`: the 202 has landed, the old process is gone with
 * its sessions, and the page is committed to reloading or to saying it cannot.
 * There is nothing behind the dialog left to use.
 */
export function canHideRestartDialog(phase: RestartPhase): boolean {
  return phase === 'restarting';
}

export type RestartOutcome =
  /** Same address, replacement answered `/health` after `afterMs`: reload this page. */
  | { kind: 'reload'; afterMs: number }
  /** Auto-picked a different port: try to navigate, then fall back to `relaunch`. */
  | { kind: 'otherPort'; port: number }
  /** Another restart was already running; nothing happened. */
  | { kind: 'busy'; message: string }
  /**
   * Preflight refused (422). NOTHING happened: the old backend still serves
   * this page. The message is the server's own sentence about which check said
   * no, and the caller must un-arm the restart gap rather than tell the user to
   * relaunch.
   */
  | { kind: 'refused'; message: string }
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
  // 422 is the ONLY non-202 answer that leaves the old process alive and this
  // page's token valid. It is read before the catch-all below precisely so it
  // can never be reported as "the backend did not come back".
  if (res.status === 422) return { kind: 'refused', message: errorText(res.body, MSG_REFUSED) };
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

// ---------------------------------------------------------------------------
// Stale-page recovery — a restart this window did NOT ask for
// ---------------------------------------------------------------------------

/**
 * Everything the recovery does to the world, injected so
 * `tests/ui-restart-guards.test.ts` can drive it without a browser. `reload`
 * and `showPanel` are the two acts a model cannot perform.
 */
export interface RecoveryDeps {
  /** GET /health WITHOUT the token; true only on a 2xx. Never rejects. */
  health(): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /**
   * Arm/disarm the restart gap. Armed, the session poll, the runtime poll and
   * both WebSocket reconnect loops stand down — exactly the reflexes that would
   * otherwise storm a backend this page can no longer authenticate against.
   */
  setRestarting(v: boolean): void;
  /** Paint the brief "the backend restarted, hold on" takeover. */
  showProbe(): void;
  /** Same origin: index.html injects the replacement's token into the new page. */
  reload(): void;
  /** The backend really is gone — the panel with the reload button. */
  showPanel(): void;
  log(level: 'warn' | 'error', line: string): void;
}

/**
 * A REST 401/403 after boot used to mean exactly one thing — "this page is
 * finished" — and got the panic panel. Since the restart button exists, it far
 * more often means something harmless: ANOTHER window (or the update flow)
 * restarted the backend underneath this one, and the replacement is already
 * listening on the same port with a fresh token. A page in that state does not
 * need a warning, it needs a reload.
 *
 * So the handler asks instead of assuming: probe `/health` — unauthenticated,
 * the one call that survives a token rotation — for RECOVER_TIMEOUT_MS. An
 * answer means a live backend on this origin, and reloading picks up its token
 * the way every page load does. Silence means the backend is genuinely gone,
 * and the panel is the honest end.
 *
 * ONE SHOT, two ways: the returned trigger latches, and the very first thing it
 * does is arm the restart gap, which is what the caller's own guard reads. A
 * 401 storm (three panes plus two polls) therefore produces exactly one probe
 * and at most one reload.
 *
 * It can never fight the boot path: boot-time auth failures never reach this —
 * `api.onAuthError` is only wired once the shell is built, and a failed boot
 * keeps its own fatal overlay.
 */
export function createAuthLossRecovery(deps: RecoveryDeps): () => void {
  let started = false;
  return (): void => {
    if (started) return;
    started = true;
    deps.log(
      'warn',
      'auth token rejected after boot — checking whether the backend restarted underneath this window',
    );
    try {
      // Before the probe, not after: every reflex has to be asleep while the
      // gap is measured, and a painting failure must not cancel the recovery.
      deps.setRestarting(true);
      deps.showProbe();
    } catch {
      // The probe below is the part that matters.
    }
    void (async () => {
      const took = await waitForHealth(deps, RECOVER_TIMEOUT_MS);
      if (took !== null) {
        deps.log('warn', `backend answered after ${took}ms — reloading to reattach`);
        deps.reload();
        return;
      }
      deps.log('error', 'the backend did not answer — this page can no longer reach it');
      deps.setRestarting(false);
      deps.showPanel();
    })();
  };
}
