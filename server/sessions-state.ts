/**
 * The record SessionManager keeps per session (`Session`), how one starts
 * (`newSession`, shared by create and the D9 adopt), and the small rules on it
 * that do not need the manager: C1's `syncPending` and D9's `metaMarks`.
 *
 * Split from server/sessions.ts by topic (Nocturne D9 P3, when adopt and the
 * metadata blob took it past 1 000 lines; the moved code is unchanged).
 * Siblings: server/sessions.ts (SessionManager), server/sessions-output.ts
 * (scan, replay tail, early exit), server/sessions-meta.ts (the metadata
 * blob), server/sessions-env.ts (the PTY's environment).
 */
import type { WebSocket } from 'ws';
import type { SessionInfo } from '../shared/protocol.ts';
import { createWindowLimiter, type Logger } from './config.ts';
import { newOutputScan, type OutputScanState } from './sessions-output.ts';
import { RingBuffer, SCROLLBACK_MAX_BYTES, type PtyExitRecord } from './pty-table.ts';

export interface Session {
  info: SessionInfo;
  /** True from the spawn until the PTY's exit is reported or destroy() kills it. */
  ptyLive: boolean;
  /** Claude-kind (isClaudeCommand): the early-exit verdict applies at exit. */
  claude: boolean;
  /** The MIRROR of the host's ring (D9 P1): what attach() replays and the early exit reads. */
  buffer: RingBuffer;
  clients: Set<WebSocket>;
  /** The output scan's state (bell and window title), carried across data chunks. */
  scan: OutputScanState;
  /**
   * C2 DEV-check fix: Date.now() when the program's window title last turned
   * Claude Code's idle mark (`✳ …`); undefined while it is anything else, or
   * never set. Only this stamp is kept — never the title text (untrusted
   * program output: not stored, logged or sent).
   */
  titleIdleSince: number | undefined;
  /**
   * I/O accounting for the log ONLY — byte COUNTS, never bytes. A PTY can
   * produce thousands of chunks a second and its content may hold anything the
   * user typed or the agent printed, so traffic is summarized at most once per
   * OUTPUT_LOG_INTERVAL_MS per session and flushed at exit. Input is counted
   * the same way and for the same reason: xterm.js sends one frame per
   * KEYSTROKE, so a line per frame is a line per key.
   */
  outBytes: number;
  outChunks: number;
  trimmedBytes: number;
  inBytes: number;
  inFrames: number;
  lastOutLogMs: number;
  /**
   * D6: set by destroy() — the user (or shutdown) ended it, so a non-zero exit
   * right after the spawn is the signal's doing, not a refusal by the CLI.
   */
  destroyed: boolean;
  /**
   * D9 P3: an exit (or a lost host) reported while the spawn's answer was
   * still being read — applied right after the session is registered, so
   * its history entry is created before it is stamped (§ Risks (b)).
   */
  earlyEnd: { record: PtyExitRecord; reason: 'exit' | 'crash' } | undefined;
  /**
   * Q9: the budget for this session's "client closed, too slow" lines, made at
   * the first such close. A slow tab reconnects and overflows again, so
   * without it one session could write a line every reconnect.
   */
  slowCloseLines: (() => boolean) | undefined;
}

/** Slow-client close lines one session may write per minute (Q9); the rest are counted. */
const SLOW_CLOSE_LOG_MAX_PER_MINUTE = 3;

/** The per-session budget for `slowCloseLines` — one fixed-window limiter per session. */
export function slowCloseLimiter(log: Logger, id: string): () => boolean {
  return createWindowLimiter({
    log,
    max: SLOW_CLOSE_LOG_MAX_PER_MINUTE,
    exceeded: (max) => `${id} slow-client closes past ${max} per minute are counted, not written`,
    summary: (n) => `${id} ${n} slow-client close line(s) suppressed in the last window`,
  });
}

/**
 * Nocturne C1 (.claude/plans/nocturne/PLAN-C1.md § The signal): keep
 * `pendingSince` in step with `attention || turnEnded`. Stamped when that
 * goes false -> true, KEPT while either stays set (a second BEL, or a turn
 * ending on a session a BEL already made pending, does not move it — the
 * mascots are ordered oldest-first), deleted when both are false. Returns
 * whether the field changed.
 */
export function syncPending(info: SessionInfo): boolean {
  const pending = info.attention || info.turnEnded === true;
  if (pending && info.pendingSince === undefined) {
    info.pendingSince = new Date().toISOString();
    return true;
  }
  if (!pending && info.pendingSince !== undefined) {
    delete info.pendingSince;
    return true;
  }
  return false;
}

/** A session's bookkeeping around its info, as create() and adopt() start it. */
export function newSession(info: SessionInfo, claude: boolean): Session {
  const session: Session = {
    info,
    ptyLive: true,
    claude,
    buffer: new RingBuffer(SCROLLBACK_MAX_BYTES, (dropped) => {
      session.trimmedBytes += dropped;
    }),
    clients: new Set(),
    scan: newOutputScan(),
    titleIdleSince: undefined,
    outBytes: 0,
    outChunks: 0,
    trimmedBytes: 0,
    inBytes: 0,
    inFrames: 0,
    lastOutLogMs: Date.now(),
    destroyed: false,
    earlyEnd: undefined,
    slowCloseLines: undefined,
  };
  return session;
}

/** The fields of the metadata blob that change after the spawn, as one comparable value (D9 P3). */
export function metaMarks(session: Session): string {
  const { attention, pendingSince, turnEnded } = session.info;
  return `${attention}|${pendingSince ?? ''}|${turnEnded === true}|${session.titleIdleSince ?? ''}`;
}
