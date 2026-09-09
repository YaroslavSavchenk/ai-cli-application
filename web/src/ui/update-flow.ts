/**
 * The in-app UPDATE handshake, DOM-free (phase E, 2026-09-09): POST once, then
 * watch `GET /api/update/status` until the new version is on disk. Written as
 * the twin of `./restart-flow.ts` — same shape, same injected side effects
 * (fetch, clock, sleep), so `tests/ui-update-model.test.ts` drives every
 * outcome with no browser, no timers and no backend. `./update.ts` owns the
 * pixels and glues this half to the restart half.
 *
 * WHY IT IS ITS OWN HALF, AND WHY IT ENDS IN A RESTART. The user asked for one
 * button (`memory/decisions/in-app-update.md`). Pressing it runs, without a
 * second question: download → verify → install → restart → the same page on
 * the same port. This module owns everything up to and including "the new
 * version is on disk"; the moment that is true, `runRestart()` takes over and
 * the flow becomes the proven same-port handoff.
 *
 * THE CONTRACT (server half, same phase — shared/protocol.ts):
 *   POST /api/update            (authed, no body)
 *     202 { version }   started
 *     409 { error }     one is ALREADY running — not an error here: the user
 *                       pressed twice, or another window started it. The right
 *                       answer is to watch the one that runs, not to refuse.
 *     422 { error }     nothing to install / not an installed app / the release
 *                       is gone. NOTHING happened.
 *     503 { error }     no updater wired (a test harness). NOTHING happened.
 *   GET /api/update/status      (authed) -> UpdateInstallStatus
 *     state: idle | downloading | verifying | installing | installed | failed
 *     percent: 0..100 while downloading · error: one CONSTANT sentence
 *
 * NOTHING IN THIS HALF IS DESTRUCTIVE. The download, the checksum and the
 * Windows installer all run while the app keeps serving: every session is alive
 * and reachable behind the dialog, which is why every phase here may be hidden
 * and why every failure is a REFUSAL — "nothing was updated" — never the
 * restart half's "the backend did not come back".
 *
 * WHAT NEVER APPEARS HERE: an address, a file name, a byte count. The release's
 * `setupUrl`/`sumsUrl` are the backend's business; this half reads a state, a
 * percent and one of the wire's constant sentences.
 */
import {
  UPDATE_ERROR_FINISH,
  type UpdateInstallState,
  type UpdateInstallStatus,
} from '../../../shared/protocol.ts';
import { canHideRestartDialog, type RestartPhase } from './restart-flow.ts';

/** The status poll, once a second — the rate the plan fixed for the readout. */
export const STATUS_POLL_MS = 1000;
/**
 * Ceiling on the whole install. A 200 MiB download on a slow line plus a silent
 * Windows Setup is minutes, not seconds, so this is deliberately generous: it
 * exists to end a watch nobody is ever going to be told about, not to police
 * the backend (which runs its own idle and total timeouts).
 */
export const UPDATE_TIMEOUT_MS = 1_200_000;
/**
 * Consecutive unreadable status answers tolerated before the watch gives up.
 * The backend stays up through this whole half, so a miss is a blip; ten in a
 * row is a backend that stopped answering.
 */
export const STATUS_MISS_MAX = 10;
/**
 * `idle` answers tolerated BEFORE any busy state has been seen. The 202 is
 * written when the runner is accepted, which can be a beat before it flips its
 * own state — that beat must not read as "it finished".
 */
export const IDLE_GRACE = 5;

/** The three phases of the install half, in order. */
export type UpdatePhase = 'downloading' | 'verifying' | 'installing';

/** Every phase the ONE flow can be in: install half, then restart half. */
export type FlowPhase = UpdatePhase | RestartPhase;

/** The exact words of each phase. The restart half's two live in `update.ts`. */
export const PHASE_DOWNLOADING = 'Downloading…';
export const PHASE_VERIFYING = 'Verifying…';
export const PHASE_INSTALLING = 'Installing…';

/**
 * Refusal sentences this half can produce ITSELF (the backend's own sentences
 * are the `UPDATE_ERROR_*` constants and are shown verbatim when it sends one).
 * Each says the same load-bearing thing: nothing was replaced, the app the user
 * is looking at is the one that was running a second ago.
 */
export const MSG_UPDATE_UNREACHABLE = 'The update could not be started. Nothing has changed.';
export const MSG_UPDATE_REFUSED = 'The update did not start, so nothing changed.';
/** The end nobody can describe: the watch lost the install. The wire's word for it. */
export const MSG_UPDATE_LOST = UPDATE_ERROR_FINISH;

export function isUpdatePhase(phase: FlowPhase): phase is UpdatePhase {
  return phase === 'downloading' || phase === 'verifying' || phase === 'installing';
}

/**
 * May the dialog be put away right now without stopping anything?
 *
 * The whole install half: yes. Nothing has been torn down — the download and
 * the Windows Setup run beside a fully working app — so locking the window
 * behind a scrim for minutes would be a cost with no purpose. The restart half
 * keeps its own rule (`canHideRestartDialog`): hidable while the preflight
 * runs, locked once the handover has begun.
 */
export function canHideFlow(phase: FlowPhase): boolean {
  return isUpdatePhase(phase) ? true : canHideRestartDialog(phase);
}

/** The phase text for the dialog. */
export function phaseText(phase: UpdatePhase): string {
  if (phase === 'downloading') return PHASE_DOWNLOADING;
  return phase === 'verifying' ? PHASE_VERIFYING : PHASE_INSTALLING;
}

/** `42%` — the readout beside `Downloading…`, and only there. */
export function percentText(percent: number): string {
  return `${clampPercent(percent)}%`;
}

/** 0..100 integer, whatever the wire said. Never NaN, never 1e9, never -1. */
export function clampPercent(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** The busy state's phase, or null when the state is not a busy one. */
export function phaseOf(state: UpdateInstallState): UpdatePhase | null {
  return state === 'downloading' || state === 'verifying' || state === 'installing' ? state : null;
}

/** The status body, or null when it is not the shape the contract promises. */
export function parseInstallStatus(body: unknown): UpdateInstallStatus | null {
  if (body === null || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  const states: UpdateInstallState[] = [
    'idle',
    'downloading',
    'verifying',
    'installing',
    'installed',
    'failed',
  ];
  if (typeof o.state !== 'string' || !states.includes(o.state as UpdateInstallState)) return null;
  if (o.version !== null && typeof o.version !== 'string') return null;
  if (o.error !== null && typeof o.error !== 'string') return null;
  return {
    state: o.state as UpdateInstallState,
    version: (o.version as string | null) ?? null,
    percent: clampPercent(o.percent),
    error: (o.error as string | null) ?? null,
  };
}

/** True while the backend is working on an install — the states worth watching. */
export function isBusyStatus(status: UpdateInstallStatus | null): boolean {
  return status !== null && phaseOf(status.state) !== null;
}

export type UpdateOutcome =
  /** The new version is on disk. The caller continues into the restart, unasked. */
  | { kind: 'installed'; version: string | null }
  /**
   * It did not happen, and nothing was replaced: the app that is running is the
   * one that was running before. Every failure of this half is this — the
   * message is the backend's constant sentence when it sent one.
   */
  | { kind: 'refused'; message: string };

/** One HTTP answer, reduced to what this flow decides on. Never a header, never a token. */
export interface UpdateHttpResult {
  status: number;
  /** Parsed JSON body, or null when there was none. */
  body: unknown;
}

export interface UpdateDeps {
  /** POST /api/update with the app token — resolves even on a network failure (status 0). */
  postUpdate(): Promise<UpdateHttpResult>;
  /** GET /api/update/status with the app token; resolves for every outcome. */
  status(): Promise<UpdateHttpResult>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Progress for the dialog: the phase, and the percent that belongs to it. */
  onPhase(phase: UpdatePhase, percent: number): void;
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
 * Watch an install that is ALREADY running to its end. Two callers: `runUpdate`
 * right after its POST, and the page-boot adoption — a reload in the middle of
 * a download must land back on the progress it left, not on a fresh question
 * (the backend kept working the whole time; only the page went away).
 */
export async function followUpdate(deps: UpdateDeps): Promise<UpdateOutcome> {
  const started = deps.now();
  let misses = 0;
  let idles = 0;
  let sawBusy = false;
  for (;;) {
    const res = await deps.status().catch(() => ({ status: 0, body: null }));
    const status = res.status === 200 ? parseInstallStatus(res.body) : null;
    if (status === null) {
      misses += 1;
      if (misses >= STATUS_MISS_MAX) return { kind: 'refused', message: MSG_UPDATE_LOST };
    } else {
      misses = 0;
      const phase = phaseOf(status.state);
      if (phase !== null) {
        sawBusy = true;
        deps.onPhase(phase, status.percent);
      } else if (status.state === 'installed') {
        return { kind: 'installed', version: status.version };
      } else if (status.state === 'failed') {
        return { kind: 'refused', message: status.error ?? MSG_UPDATE_LOST };
      } else {
        // `idle`: either the runner has not flipped its state yet (the beat
        // after the 202), or it went away without ever saying how it ended.
        idles += 1;
        if (sawBusy || idles >= IDLE_GRACE) {
          return { kind: 'refused', message: MSG_UPDATE_LOST };
        }
      }
    }
    if (deps.now() - started >= UPDATE_TIMEOUT_MS) {
      return { kind: 'refused', message: MSG_UPDATE_LOST };
    }
    await deps.sleep(STATUS_POLL_MS);
  }
}

/**
 * The whole install half. Never throws: every path resolves to an outcome
 * carrying the words to show.
 *
 * The 409 is deliberately NOT a refusal: it means an install is already
 * running (a double press, a second window), and the honest answer to "update"
 * when an update is running is to show it, not to say no.
 */
export async function runUpdate(deps: UpdateDeps): Promise<UpdateOutcome> {
  deps.onPhase('downloading', 0);
  let res: UpdateHttpResult;
  try {
    res = await deps.postUpdate();
  } catch {
    return { kind: 'refused', message: MSG_UPDATE_UNREACHABLE };
  }
  if (res.status !== 202 && res.status !== 409) {
    // 422 (nothing to install / not installed / release gone) carries a plain
    // sentence written for this dialog, so it is shown verbatim. 503's body is
    // NOT: it is the technical "updates are not available in this process",
    // meant for a log, so that one gets our own sentence — as does a network
    // failure (status 0) and any other broken answer.
    if (res.status === 422) {
      return { kind: 'refused', message: errorText(res.body, MSG_UPDATE_REFUSED) };
    }
    return {
      kind: 'refused',
      message: res.status === 0 ? MSG_UPDATE_UNREACHABLE : MSG_UPDATE_REFUSED,
    };
  }
  return followUpdate(deps);
}
