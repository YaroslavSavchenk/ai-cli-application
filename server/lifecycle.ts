/**
 * Lifecycle controller — the backend's lifetime is bound to UI presence
 * (decided 2026-07-19, reversing indefinite survival; see
 * memory/decisions/lifecycle-bound-backend.md).
 *
 * Two counters, maintained by the WS layer:
 *   presenceCount — open /ws/presence sockets (one per window)
 *   attachedCount — open /ws/sessions/:id sockets
 *
 * A shutdown grace timer runs ONLY while BOTH are zero. Any connect cancels
 * it; the next return to zero re-arms it from scratch. On expiry the
 * onIdleShutdown callback performs the clean shutdown (history 'shutdown',
 * kill PTYs, remove runtime.json, exit 0).
 *
 * Until the FIRST presence connection ever, the window is the startup grace
 * (a launcher that failed to open a browser must not leave a zombie); after
 * that, the regular grace applies.
 */
import type { Logger } from './config.ts';

/** Grace after the last client disconnects. Env override: AI_SM_GRACE_MS. */
export const DEFAULT_GRACE_MS = 30_000;
/** Grace from listen until the first presence ever. Env override: AI_SM_STARTUP_GRACE_MS. */
export const DEFAULT_STARTUP_GRACE_MS = 120_000;

/** Read an integer-milliseconds env override; invalid values fall back loudly. */
function envMs(name: string, fallback: number, log: Logger): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    log('warn', `${name} must be a non-negative integer (ms), got ${JSON.stringify(raw)}; using ${fallback}`);
    return fallback;
  }
  return value;
}

export interface LifecycleOptions {
  onIdleShutdown: () => void;
  log: Logger;
  /** Test seams; production reads the env / defaults. */
  graceMs?: number;
  startupGraceMs?: number;
}

export class LifecycleController {
  readonly #graceMs: number;
  readonly #startupGraceMs: number;
  readonly #onIdleShutdown: () => void;
  readonly #log: Logger;
  #presenceCount = 0;
  #attachedCount = 0;
  #everHadPresence = false;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(opts: LifecycleOptions) {
    this.#onIdleShutdown = opts.onIdleShutdown;
    this.#log = opts.log;
    this.#graceMs = opts.graceMs ?? envMs('AI_SM_GRACE_MS', DEFAULT_GRACE_MS, opts.log);
    this.#startupGraceMs =
      opts.startupGraceMs ?? envMs('AI_SM_STARTUP_GRACE_MS', DEFAULT_STARTUP_GRACE_MS, opts.log);
  }

  get presenceCount(): number {
    return this.#presenceCount;
  }

  get attachedCount(): number {
    return this.#attachedCount;
  }

  /** Call once the server is listening: opens the startup grace window. */
  start(): void {
    this.#evaluate();
  }

  presenceConnected(): void {
    this.#everHadPresence = true;
    this.#presenceCount += 1;
    this.#evaluate();
  }

  presenceDisconnected(): void {
    this.#presenceCount = Math.max(0, this.#presenceCount - 1);
    this.#evaluate();
  }

  sessionAttached(): void {
    this.#attachedCount += 1;
    this.#evaluate();
  }

  sessionDetached(): void {
    this.#attachedCount = Math.max(0, this.#attachedCount - 1);
    this.#evaluate();
  }

  /** Permanently cancel timers (a shutdown is already in progress). */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #evaluate(): void {
    if (this.#stopped) return;
    if (this.#presenceCount === 0 && this.#attachedCount === 0) {
      if (this.#timer !== null) return; // Already armed; do not restart the window.
      const delayMs = this.#everHadPresence ? this.#graceMs : this.#startupGraceMs;
      const kind = this.#everHadPresence ? 'grace' : 'startup grace';
      this.#log('info', `no clients connected; ${kind} timer armed (${delayMs}ms)`);
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#log('info', `${kind} expired with no clients; shutting down`);
        this.#onIdleShutdown();
      }, delayMs);
    } else if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
      this.#log(
        'info',
        `shutdown timer cancelled (presence=${this.#presenceCount}, attached=${this.#attachedCount})`,
      );
    }
  }
}
