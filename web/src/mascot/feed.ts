/**
 * Claude peek mascot — the feed (Nocturne C1, `.claude/plans/nocturne/PLAN-C1.md`
 * § The page). What turns the app's sessions into the one number the model
 * (./model.ts) draws, and what the page tells the Windows host.
 *
 * DOM-free and clock-free like the model: the fetches, the timers and `now`
 * are constructor options, so `node --test` drives every rule without a
 * browser, a backend or a real second going by.
 *
 * The rules, in the spec's words:
 * - Pending = a RUNNING session with `attention || turnEnded`, ordered by
 *   `pendingSince` (oldest = slot 0). Count = min(3, n).
 * - `prefs.mascot.enabled === false` → count 0 (absent = on), read each poll.
 * - A RISE in count is applied only after it held for 1.5 s — a BEL in the
 *   pane the user is looking at is acked within that window, and a turn that
 *   ends and at once starts again never flashes a mascot. A FALL applies at
 *   once. (A turn that ended stays pending until the session works again or
 *   ends — looking does not clear it; user, 2026-09-22.)
 * - The host gets `{"type":"mascot-count","count":N,"rects":[…]}` on every
 *   change, and `{"type":"mascot-open","session":"<id>"}` after a click's
 *   reaction — both as a STRING (the host reads string messages only).
 */
import type { SessionInfo } from '../../../shared/protocol.ts';
import { clampMascot } from '../ui/prefs-model.ts';
import { MAX_COUNT } from './model.ts';

/** How often the page asks the backend (the spec's 2 s). */
export const POLL_MS = 2000;

/** How long a rise must hold before a mascot appears. */
export const RISE_HOLD_MS = 1500;

/**
 * Consecutive failed polls before the page stops claiming anything is
 * pending. One miss is a blip (the main page's poll uses the same two); a
 * gone backend has no sessions to wait on.
 */
export const FAILS_TO_ZERO = 2;

/**
 * The pending sessions, oldest first: running, and either rang the bell or
 * ended its turn and has not started working again. A session without `pendingSince` (a
 * backend that predates it) sorts after every dated one; ties break on the id
 * so the order is stable between polls. Anything that is not a list of
 * objects is no sessions at all — this answer crossed a network.
 */
export function pendingSessions(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const hits: { id: string; since: string }[] = [];
  for (const raw of list as unknown[]) {
    if (raw === null || typeof raw !== 'object') continue;
    const s = raw as Partial<SessionInfo>;
    if (typeof s.id !== 'string' || s.status !== 'running') continue;
    if (s.attention !== true && s.turnEnded !== true) continue;
    hits.push({ id: s.id, since: typeof s.pendingSince === 'string' ? s.pendingSince : '' });
  }
  hits.sort((a, b) => {
    if (a.since !== b.since) {
      if (a.since === '') return 1;
      if (b.since === '') return -1;
      return a.since < b.since ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return hits.map((h) => h.id);
}

/** A mascot's box in CSS px of the page: `[x, y, width, height]`. */
export type BoxRect = [number, number, number, number];

/** The count report, as the string the host receives. */
export function countMessage(count: number, rects: readonly BoxRect[]): string {
  return JSON.stringify({ type: 'mascot-count', count, rects: rects.map((r) => [...r]) });
}

/** The open request, as the string the host receives. */
export function openMessage(sessionId: string): string {
  return JSON.stringify({ type: 'mascot-open', session: sessionId });
}

/**
 * Says each count + rects ONCE: the page re-measures on every render and
 * every settled animation, and the host re-shapes its window on every
 * message, so an unchanged report is not sent again. No channel (a plain
 * browser, `?demo`) → nothing is ever posted.
 */
export class HostReporter {
  private last: string | null = null;
  private readonly post: ((message: string) => void) | null;

  constructor(post: ((message: string) => void) | null) {
    this.post = post;
  }

  report(count: number, rects: readonly BoxRect[]): void {
    if (this.post === null) return;
    const message = countMessage(count, rects);
    if (message === this.last) return;
    this.last = message;
    this.post(message);
  }

  open(sessionId: string): void {
    this.post?.(openMessage(sessionId));
  }
}

/** An opaque timer handle — whatever the injected `setTimeout` returns. */
export type TimerHandle = unknown;

export interface MascotFeedOptions {
  /** `GET /api/sessions`, parsed. Rejects on any failure. */
  getSessions: () => Promise<unknown>;
  /** `GET /api/prefs`, parsed. Rejects on any failure. */
  getPrefs: () => Promise<unknown>;
  /** Called with the count to draw (0..3) whenever it changes. */
  onCount: (count: number) => void;
  /** Called when the backend refused the page's token (401/403). */
  onAuthLost?: () => void;
  setTimeout?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
  now?: () => number;
}

/** What a rejected fetch may carry so the feed can tell a refusal from a blip. */
export interface HttpFailure {
  status?: number;
}

/**
 * The live half of the page: polls, derives the count, holds a rise, and
 * remembers which session sits in which slot.
 */
export class MascotFeed {
  /** The count on screen (after the hold). */
  private shown = 0;
  /** The pending ids of the newest answer, oldest first. */
  private ids: string[] = [];
  /** Absent = on; the last value a prefs read returned (a failed read keeps it). */
  private enabled = true;
  /** A rise waiting to prove it held: when it was first seen, and its lowest value since. */
  private rise: { since: number; min: number } | null = null;
  private riseTimer: TimerHandle | null = null;
  private pollTimer: TimerHandle | null = null;
  private failures = 0;
  /** Answers are applied in the order they were ASKED; a late one is dropped. */
  private asked = 0;
  private applied = 0;
  private stopped = false;

  private readonly setT: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearT: (handle: TimerHandle) => void;
  private readonly now: () => number;
  private readonly opts: MascotFeedOptions;

  constructor(opts: MascotFeedOptions) {
    this.opts = opts;
    this.setT = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = opts.clearTimeout ?? ((h) => clearTimeout(h as never));
    this.now = opts.now ?? (() => Date.now());
  }

  /** Poll now and every `POLL_MS` after. */
  start(): void {
    const tick = (): void => {
      if (this.stopped) return;
      void this.poll();
      this.pollTimer = this.setT(tick, POLL_MS);
    };
    tick();
  }

  stop(): void {
    this.stopped = true;
    this.clearT(this.pollTimer);
    this.clearT(this.riseTimer);
    this.pollTimer = null;
    this.riseTimer = null;
  }

  /** The count on screen. */
  getCount(): number {
    return this.shown;
  }

  /** The session drawn in slot `i`, oldest pending first; null past the count. */
  sessionAt(slot: number): string | null {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.shown) return null;
    return this.ids[slot] ?? null;
  }

  /** One round: both reads, then the count. Resolves when it is applied. */
  async poll(): Promise<void> {
    const ticket = ++this.asked;
    const [sessions, prefs] = await Promise.allSettled([this.opts.getSessions(), this.opts.getPrefs()]);
    if (this.stopped || ticket < this.applied) return;
    this.applied = ticket;
    if (prefs.status === 'fulfilled') {
      const bag = prefs.value;
      const member =
        bag !== null && typeof bag === 'object' ? (bag as Record<string, unknown>).mascot : undefined;
      this.enabled = clampMascot(member);
    }
    if (sessions.status === 'rejected') {
      const status = (sessions.reason as HttpFailure | null)?.status;
      if (status === 401 || status === 403) this.opts.onAuthLost?.();
      this.failures++;
      if (this.failures >= FAILS_TO_ZERO) this.observe([]);
      return;
    }
    this.failures = 0;
    this.observe(pendingSessions(sessions.value));
  }

  /** Apply one answer's pending list under the switch and the hold. */
  private observe(ids: string[]): void {
    this.ids = ids;
    const target = this.enabled ? Math.min(MAX_COUNT, ids.length) : 0;
    if (target <= this.shown) {
      // A fall — or no change — is true at once, and any rise in wait is void.
      this.cancelRise();
      this.show(target);
      return;
    }
    const now = this.now();
    if (this.rise === null) {
      this.rise = { since: now, min: target };
      // Ask again when the hold is up instead of waiting a whole poll period:
      // the rise is shown ~1.5 s after it was first seen, not ~2 s.
      this.riseTimer = this.setT(() => {
        this.riseTimer = null;
        void this.poll();
      }, RISE_HOLD_MS);
      return;
    }
    this.rise.min = Math.min(this.rise.min, target);
    if (now - this.rise.since < RISE_HOLD_MS) return;
    // What held for the whole window is shown; anything above it starts its
    // own hold now (a second session that ended half a second ago has not
    // proved itself yet).
    const held = this.rise.min;
    this.cancelRise();
    this.show(held);
    if (target > held) this.observe(ids);
  }

  private cancelRise(): void {
    this.rise = null;
    if (this.riseTimer !== null) {
      this.clearT(this.riseTimer);
      this.riseTimer = null;
    }
  }

  private show(count: number): void {
    if (count === this.shown) return;
    this.shown = count;
    this.opts.onCount(count);
  }
}
