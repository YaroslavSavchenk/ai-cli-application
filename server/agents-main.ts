/**
 * The session's OWN transcript, read for its turn verdict (Nocturne B11,
 * .claude/plans/nocturne/PLAN-B11.md; C2 added the launches it keeps open):
 * `readMain` derives `<parent>/<uuid>.jsonl` from the tracked subagents
 * directory, re-checks the realpath boundary on every poll, opens it
 * O_RDONLY|O_NOFOLLOW|O_NONBLOCK, reads its tail on first sight and then
 * incrementally, and folds its lines (server/agents-fold.ts foldTurnLine).
 * Also the read limits and the line splitter the agent transcripts in
 * server/agents.ts share with it (MAX_READ_PER_POLL, splitLines).
 *
 * THE PATH IS UNTRUSTED — the boundary rules are server/agents.ts's header;
 * this file applies them to the one file it opens.
 *
 * Split from server/agents.ts (PLAN-QUALITY Q13, 2026-11-22): the former
 * private methods #readMain, #resetMain and #refuseMain, unchanged but for
 * `this.#x` becoming `ctx.x`, with the state and helpers only they and the
 * agent reads use. Siblings: server/agents.ts (AgentsWatcher: the poll, the
 * agent reads, the rows), server/agents-path.ts (subagentsDirFor,
 * pendingSlug), server/agents-fold.ts, server/agents-verdict.ts,
 * server/agents-workflows.ts.
 */
import { constants as fsConstants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { closeQuietly } from './config.ts';
import { describeError, oneLine, type Logger } from './config-log.ts';
import { isUuid } from './conversation.ts';
import { isUnder } from './fsbrowse.ts';
import { foldTurnLine, newTurnFold, type TurnFold } from './agents-fold.ts';
import { pendingSlug } from './agents-path.ts';

/**
 * Most bytes read from ONE transcript in ONE poll. A 15-minute agent's file is
 * 0.7-1.4 MB measured, so this catches up in a single tick in practice; the
 * cap is what stops a planted 10 GB file from being read into this process.
 * A backlog larger than this is simply read over the next few polls.
 */
export const MAX_READ_PER_POLL = 4 * 1024 * 1024;

/**
 * Longest single line we will parse. Real lines reach ~120 KB (a large tool
 * result); past a megabyte it is not a transcript line, so it is skipped
 * unparsed rather than handed to JSON.parse.
 */
const MAX_LINE = 1024 * 1024;

/**
 * How much of the session's own transcript is read on FIRST sight (B11). A
 * long session's transcript is tens of MB; the verdict lives in its last few
 * lines, so only the tail is read, from `max(0, size - TURN_TAIL_BYTES)`, and
 * the first (partial) line of it is dropped. Afterwards it is read
 * incrementally like every agent transcript.
 */
const TURN_TAIL_BYTES = 1024 * 1024;

/** Read state of the session's own transcript (B11). */
export interface TurnState {
  /** Bytes already consumed; -1 = never read (the next read is a TAIL read). */
  offset: number;
  carry: Buffer;
  resyncing: boolean;
  /** What its lines said: the main verdict, a question, the open launches (C2). */
  fold: TurnFold;
  /**
   * When `fold.turn` last moved to 'working' (this watcher's clock, the time
   * the line was read); undefined until it does. Reset with the fold. The
   * verdict ages an idle title from it (server/agents-verdict.ts).
   */
  workingSince: number | undefined;
}

/** A turn state that has read nothing: the next read starts at the tail. */
export function newTurnState(): TurnState {
  return { offset: -1, carry: Buffer.alloc(0), resyncing: false, fold: newTurnFold(), workingSince: undefined };
}

/** What readMain reaches of the AgentsWatcher; built once by the watcher. */
export interface MainReadContext {
  /** The watcher's `[agents] …` logger. */
  readonly log: Logger;
  /** The watcher's clock. */
  readonly now: () => number;
}

/** The part of a tracked session readMain reads and changes. */
interface MainSession {
  /** The tracked subagents directory, `<parent>/<uuid>/subagents`. */
  dir: string;
  /** The session's own transcript (B11). */
  main: TurnState;
  /** True once a refused main transcript was logged (once per session, B11). */
  mainRefusalLogged: boolean;
}

/**
 * Bring the session's own transcript's turn verdict up to date (B11).
 *
 * THE PATH: `<parent>/<uuid>.jsonl`, derived from the tracked directory
 * `<parent>/<uuid>/subagents` that subagentsDirFor() built — never read from
 * the snapshot again. A tracked directory not of that shape gives no turn.
 *
 * THE BOUNDARY, RE-CHECKED EVERY TICK on the file actually opened (B7
 * amendment 2): the parent is realpath'd and must sit inside the real
 * projects root, and the file's own realpath must be exactly
 * `<real parent>/<uuid>.jsonl` — a symlink at the final component (even one
 * pointing inside the root) is refused, not followed. The open itself is
 * O_RDONLY|O_NOFOLLOW|O_NONBLOCK and fstat must say regular file, so a
 * symlink swapped in after the check is refused and a FIFO never blocks.
 *
 * States: a file that does not exist (lstat ENOENT — Claude Code creates it
 * at the first prompt) is 'waiting'; a refused or unreadable one has no
 * verdict; a readable one keeps the verdict of its last counting line, and
 * (C2) the question flag and the launches its lines left open. Any reset
 * forgets all of it: a shrunk or replaced file is folded again from its tail.
 *
 * `realRoot` is Claude Code's projects root as the watcher realpath'd it for
 * THIS sweep (Q12: once per sweep, not once per session); null = there is none.
 */
export function readMain(
  ctx: MainReadContext,
  id: string,
  session: MainSession,
  budget: { left: number },
  realRoot: string | null,
): void {
  const uuidDir = dirname(session.dir);
  const uuid = basename(uuidDir);
  if (basename(session.dir) !== 'subagents' || !isUuid(uuid)) {
    resetMain(session);
    return;
  }
  const name = `${uuid}.jsonl`;

  if (realRoot === null) {
    resetMain(session);
    return; // No projects root: nothing may be read.
  }
  let realParent: string;
  try {
    realParent = realpathSync(dirname(uuidDir));
  } catch {
    resetMain(session);
    // B11 F1: the slug folder does not exist YET (one missing component
    // directly under the real root) — Claude Code has written nothing, so
    // the session sits at its first prompt. Anything else missing: no turn.
    if (pendingSlug(dirname(uuidDir), realRoot)) session.main.fold.turn = 'waiting';
    return;
  }
  if (!isUnder(realParent, realRoot)) {
    refuseMain(ctx, id, session, dirname(uuidDir));
    return;
  }
  const file = join(realParent, name);

  let realFile: string;
  try {
    realFile = realpathSync(file);
  } catch {
    // Missing (the session sits at its first prompt) or a dangling symlink.
    // Only a TRULY missing name is 'waiting'; lstat does not follow.
    let missing = false;
    try {
      lstatSync(file);
    } catch (err) {
      missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    }
    resetMain(session);
    if (missing) session.main.fold.turn = 'waiting';
    return;
  }
  if (realFile !== file) {
    refuseMain(ctx, id, session, file);
    return;
  }
  if (session.mainRefusalLogged) {
    session.mainRefusalLogged = false;
    ctx.log('debug', `${id}: ${oneLine(file)} now inside the projects root, reading it again`);
  }

  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    resetMain(session);
    return; // Vanished since realpath, swapped for a symlink, or unreadable.
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      resetMain(session);
      return;
    }
    const size = stat.size;
    if (session.main.offset >= 0 && size < session.main.offset) {
      // Shrank or replaced: the verdict describes a file that is gone, so
      // start over from its tail.
      ctx.log('debug', `${id}: transcript shrank, re-reading its tail`);
      session.main = newTurnState();
    }
    const state = session.main;
    if (state.offset < 0) {
      // FIRST SIGHT: only the tail. Starting one byte before the tail and
      // resyncing drops the partial first line — and keeps a whole one that
      // happens to begin exactly at the tail boundary.
      if (size > TURN_TAIL_BYTES) {
        state.offset = size - TURN_TAIL_BYTES - 1;
        state.resyncing = true;
      } else {
        state.offset = 0;
      }
    }
    if (size === state.offset) return;
    const want = Math.min(size - state.offset, MAX_READ_PER_POLL, budget.left);
    if (want <= 0) return;
    const buffer = Buffer.allocUnsafe(want);
    const read = readSync(fd, buffer, 0, want, state.offset);
    if (read <= 0) return;
    budget.left -= read;
    state.offset += read;
    // C2: the fold dates a launch line without a believable stamp by this,
    // and a turn that starts on one of these lines is stamped with it —
    // line by line, so a turn that ended and restarted in one read counts.
    const seenMs = ctx.now();
    splitLines(state, buffer.subarray(0, read), (line) => {
      const was = state.fold.turn;
      foldTurnLine(state.fold, line.toString('utf8'), seenMs);
      if (state.fold.turn === 'working' && was !== 'working') state.workingSince = seenMs;
    });
  } catch (err) {
    ctx.log('debug', `${id}: transcript read failed: ${describeError(err)}`);
  } finally {
    closeQuietly(fd);
  }
}

/** Forget the main transcript's read state and verdict. */
function resetMain(session: MainSession): void {
  session.main = newTurnState();
}

/** A main transcript outside the root: no verdict, logged once per session. */
function refuseMain(ctx: MainReadContext, id: string, session: MainSession, path: string): void {
  resetMain(session);
  if (session.mainRefusalLogged) return;
  session.mainRefusalLogged = true;
  ctx.log('debug', `${id}: ${oneLine(path)} resolves outside the projects root, refused`);
}

/**
 * Split a chunk on newlines, carrying the trailing partial line in `state` and
 * handing every complete line of at most MAX_LINE bytes to `onLine`. A line
 * past MAX_LINE is dropped unparsed; an unterminated one past it drops the
 * carry and resyncs at the next newline, so a single huge (or endless) line
 * cannot grow the carry without bound. `resyncing` set by the caller discards
 * everything up to the next newline (the tail read's partial first line).
 */
export function splitLines(
  state: { carry: Buffer; resyncing: boolean },
  chunk: Buffer,
  onLine: (line: Buffer) => void,
): void {
  const buf = state.carry.length === 0 ? chunk : Buffer.concat([state.carry, chunk]);
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue;
    const line = buf.subarray(start, i);
    start = i + 1;
    if (state.resyncing) {
      // The tail of a line we already gave up on: this newline ends it.
      state.resyncing = false;
      continue;
    }
    if (line.length > MAX_LINE) continue; // Too big to be a transcript line.
    onLine(line);
  }
  const rest = buf.subarray(start);
  if (state.resyncing || rest.length > MAX_LINE) {
    // Still inside a line we are discarding, or an unterminated line past the
    // cap: keep nothing and resync at the next newline.
    state.carry = Buffer.alloc(0);
    state.resyncing = true;
    return;
  }
  // Copied, not aliased: subarray keeps the whole chunk alive otherwise.
  state.carry = Buffer.from(rest);
}
