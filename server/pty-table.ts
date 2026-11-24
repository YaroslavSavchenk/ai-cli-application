/**
 * The PTY table: every terminal this process owns, at the level of bytes and
 * signals only — spawn, input, resize, the raw output ring with ABSOLUTE byte
 * offsets, the rescue of a session's final output, the kill ladder, the exit
 * record and an opaque per-session metadata blob.
 *
 * Nocturne D9 P1 (.claude/plans/nocturne/PLAN-D9.md § Phases): moved out of
 * server/sessions.ts (the kill ladder, `signalableChildPid`, the spawn) and
 * server/sessions-output.ts (the ring buffer and `rescueFinalOutput`) so that
 * a separate pty-host process (P2) can own this table while the backend
 * restarts. This module interprets NOTHING: no bell, no title, no history, no
 * argv or environment composition, no settings files — the caller hands over
 * a finished `file`, `argv`, `cwd` and `env` (server/sessions.ts composes
 * them). It is the only module that imports `node-pty`.
 *
 * D9 P2 added what the pty-host process (server/pty-host-server.ts) needs:
 * `setPaused` (backpressure — and the rescue now flushes a paused stream's
 * own buffer before it drains the fd), `size` (the idle rule), the spawn's
 * initial `meta`, and `assertMetaSize` (the one home of the 16 KiB cap).
 *
 * D9 P3: the process-group probe and signal are free functions
 * (`processGroupGone`, `signalProcessGroup`) so the backend's pty-host broker
 * kills a lost pty-host's groups with the same code; `RingBuffer.restore`
 * seeds the mirror of an adopted session.
 *
 * PLAN-QUALITY Q12 (the output path's speed): a chunk is UTF-8 encoded once,
 * here — the ring keeps that buffer and the `output` event carries it on to
 * the wire or the backend's mirror; the ring trims by a head index instead of
 * `shift()`, hands its chunks newest-first to the replay cut, and
 * `endOffset(id)` answers the exit line without building every summary.
 *
 * PLAN-QUALITY Q16: every child's `oom_score_adj` is raised to 500 right
 * after its spawn (`raiseOomScore`) — in the pty-host and in the in-process
 * fallback alike, since both spawn here.
 *
 * Reached through server/pty-host-api.ts (the `PtyHost` interface and its
 * in-process implementation); server/sessions-state.ts and
 * server/sessions-output.ts import `RingBuffer` straight from here.
 */
import { fstatSync, readSync, writeFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import * as pty from 'node-pty';
import { describeError, scoped, type Logger } from './config-log.ts';

/** Scrollback cap: 1 MiB of bytes (not lines). Oldest chunks are dropped. */
export const SCROLLBACK_MAX_BYTES = 1024 * 1024;

/**
 * How many slices `RingBuffer.restore` cuts a snapshot into (16 KiB each for
 * the 1 MiB cap): an append past the cap then drops one slice of the restored
 * scrollback, the way it drops one live chunk — never all of it.
 */
const RESTORE_SLICES = 64;

/**
 * The fewest trimmed chunks `RingBuffer` lets pile up before it cuts them off
 * its array (#compact) — below that the copy costs more than the dead slots.
 */
const COMPACT_MIN_DEAD = 1024;

/**
 * What a trimmed slot points at until #compact cuts it off: the dropped chunk
 * itself would stay alive there — up to COMPACT_MIN_DEAD chunks, ~4 MiB of
 * node-pty's ~4 KB chunks per ring (Q12 review).
 */
const EMPTY = Buffer.alloc(0);

/**
 * The per-session metadata blob's cap (D9 § Defaults: ≤ 16 KiB, UTF-8 bytes).
 * The table never reads the blob; the backend keeps what it must find again
 * after a restart there (P3), so the cap bounds what a hostile or buggy owner
 * can park in a process that outlives it.
 */
const META_MAX_BYTES = 16 * 1024;

/**
 * Refuse a metadata blob over META_MAX_BYTES with a RangeError. One home for
 * the cap: the table checks it, and so does the pty-host client before it
 * sends `set-meta` (a verb with no reply, so the host could not refuse it in
 * a way the caller sees).
 */
export function assertMetaSize(meta: string): void {
  const bytes = Buffer.byteLength(meta, 'utf8');
  if (bytes > META_MAX_BYTES) {
    throw new RangeError(`pty metadata is ${bytes} bytes, over the ${META_MAX_BYTES}-byte cap`);
  }
}

/**
 * Byte-capped ring buffer of output chunks; drops oldest chunks when over cap.
 *
 * `onTrim` (optional) reports how many bytes were dropped, so the manager can
 * say in server.log that a session's scrollback is no longer complete — a
 * replay that silently starts mid-stream is otherwise indistinguishable from a
 * bug. It NEVER receives the bytes themselves.
 *
 * `endOffset` (D9 P1) is ABSOLUTE: every byte ever appended, trimmed ones
 * included. Two copies of one stream (the pty-host's ring, the backend's
 * mirror) compare positions by it — a wrap changes what the ring holds, never
 * where the stream stands.
 */
export class RingBuffer {
  /**
   * Live chunks are `#chunks[#head]` … the last one. Trimming advances `#head`
   * instead of `shift()`ing (which moved every remaining chunk: 70 µs per
   * append once a ring of 16-byte chunks reached the cap, PLAN-QUALITY Q12);
   * a trimmed slot is blanked (EMPTY) and the dead prefix is cut off once it
   * is the larger half (#compact).
   */
  #chunks: Buffer[] = [];
  #head = 0;
  #bytes = 0;
  #end = 0;
  readonly #maxBytes: number;
  readonly #onTrim: ((droppedBytes: number) => void) | undefined;

  constructor(maxBytes: number = SCROLLBACK_MAX_BYTES, onTrim?: (droppedBytes: number) => void) {
    this.#maxBytes = maxBytes;
    this.#onTrim = onTrim;
  }

  /**
   * Append one chunk of UTF-8 bytes. The ring keeps `chunk` itself, not a
   * copy (Q12: the output path encodes once), so the caller hands it over and
   * nobody writes to it afterwards — it may be shared with a frame or the
   * backend's mirror, which never write to it either.
   */
  append(chunk: Buffer): void {
    this.#end += chunk.byteLength;
    let trimmed = 0;
    if (chunk.byteLength > this.#maxBytes) {
      // A single chunk larger than the whole cap: keep only its tail.
      trimmed += this.#bytes + (chunk.byteLength - this.#maxBytes);
      chunk = chunk.subarray(chunk.byteLength - this.#maxBytes);
      this.#chunks = [];
      this.#head = 0;
      this.#bytes = 0;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.byteLength;
    while (this.#bytes > this.#maxBytes && this.#chunks.length - this.#head > 1) {
      const dropped = this.#chunks[this.#head] as Buffer;
      this.#chunks[this.#head] = EMPTY;
      this.#head += 1;
      this.#bytes -= dropped.byteLength;
      trimmed += dropped.byteLength;
    }
    if (trimmed > 0) {
      this.#compact();
      if (this.#onTrim !== undefined) this.#onTrim(trimmed);
    }
  }

  /**
   * Drop the dead prefix once it is at least COMPACT_MIN_DEAD chunks AND at
   * least as long as the live part: each copy then moves no more chunks than
   * were dropped since the last one, so trimming stays O(1) amortized.
   */
  #compact(): void {
    if (this.#head < COMPACT_MIN_DEAD || this.#head < this.#chunks.length - this.#head) return;
    this.#chunks = this.#chunks.slice(this.#head);
    this.#head = 0;
  }

  /**
   * Seed an EMPTY ring with another copy's bytes and absolute end (D9 P3: the
   * backend's mirror of a session it adopts, from the pty-host's `snapshot`),
   * so later chunks continue the same offsets. Kept within the cap.
   *
   * The snapshot is stored as slices of 1/RESTORE_SLICES of the cap, never as
   * one chunk: the ring trims WHOLE chunks, so one 1 MiB chunk would be
   * dropped entire by the first append that crosses the cap — the adopted
   * session's scrollback gone at its first output (D9 P3 gate finding).
   */
  restore(ring: Buffer, endOffset: number): void {
    if (this.#end !== 0 || this.#chunks.length > 0) throw new Error('restore needs an empty ring');
    const kept = ring.byteLength > this.#maxBytes ? ring.subarray(ring.byteLength - this.#maxBytes) : ring;
    const slice = Math.max(1, Math.floor(this.#maxBytes / RESTORE_SLICES));
    for (let at = 0; at < kept.byteLength; at += slice) this.#chunks.push(Buffer.from(kept.subarray(at, at + slice)));
    this.#bytes = kept.byteLength;
    this.#end = endOffset;
  }

  get byteLength(): number {
    return this.#bytes;
  }

  /** The absolute stream offset one past the newest byte (see the class comment). */
  get endOffset(): number {
    return this.#end;
  }

  /** The ring's bytes, oldest first, as one new buffer (a snapshot for the next owner). */
  toBuffer(): Buffer {
    const out = Buffer.allocUnsafe(this.#bytes);
    let at = 0;
    for (let i = this.#head; i < this.#chunks.length; i++) {
      const chunk = this.#chunks[i] as Buffer;
      chunk.copy(out, at);
      at += chunk.byteLength;
    }
    return out;
  }

  /**
   * The ring's chunks, NEWEST first, as the views the ring holds (never to be
   * written to) — so a reader that wants only the end (server/sessions-output.ts
   * `replayTail`) stops early instead of copying the whole ring (Q12).
   */
  *chunksNewestFirst(): Generator<Buffer, void, undefined> {
    for (let i = this.#chunks.length - 1; i >= this.#head; i--) yield this.#chunks[i] as Buffer;
  }

  /**
   * At most the first `maxBytes` the ring still holds, oldest first, copying
   * only the chunks that reach into them (Nocturne D6: an early exit reads
   * what the program said first, never the whole 1 MiB).
   */
  head(maxBytes: number): Buffer {
    const parts: Buffer[] = [];
    let taken = 0;
    for (let i = this.#head; i < this.#chunks.length && taken < maxBytes; i++) {
      const part = (this.#chunks[i] as Buffer).subarray(0, maxBytes - taken);
      parts.push(part);
      taken += part.byteLength;
    }
    return Buffer.concat(parts);
  }
}

/**
 * Kill escalation, step two (DELETE only). A TUI that honours SIGHUP is gone
 * within milliseconds, so 2 s is already generous for one that flushes state
 * to disk before it leaves.
 */
const KILL_TERM_AFTER_MS = 2000;
/**
 * Kill escalation, step three (DELETE only): 3 s more for a TUI that does
 * honour SIGTERM but is slow about it, before the signal it cannot refuse.
 */
const KILL_KILL_AFTER_MS = 3000;

/**
 * PLAN-QUALITY Q16: what a PTY child's `oom_score_adj` is raised to, right
 * after its spawn. 2026-11-24 WSL ran out of memory and went down with the
 * backend and the pty-host; from now on the kernel's OOM killer takes a
 * session first — what it kills there the history can resume — before
 * the backend or the pty-host, which keep their inherited value (0 under
 * WSL; it is inherited at fork, so it is written to the child, never to
 * this process).
 */
const PTY_OOM_SCORE_ADJ = 500;

/**
 * Raise a freshly spawned child's `oom_score_adj`. RAISING needs no privilege
 * (only lowering does); a failure — not Linux, a hardened /proc, the child
 * already gone — is one `warn` line and the session runs on. The child's own
 * children inherit the value, except one it forked in the instant between
 * its exec and this write.
 */
function raiseOomScore(id: string, pid: number, log: Logger): void {
  try {
    writeFileSync(`/proc/${pid}/oom_score_adj`, String(PTY_OOM_SCORE_ADJ));
  } catch (err) {
    log('warn', `${id}: oom_score_adj not raised (${(err as NodeJS.ErrnoException).code ?? 'write failed'})`);
  }
}

/**
 * The one pid shape the kill ladder may turn into a process-group signal. A
 * seatbelt: `pty.pid` is always a real child pid, but `process.kill(-0, …)`
 * would signal the backend's own group and `process.kill(-(-1), …)` is a
 * signal to pid 1, so anything that is not a plain positive child pid is
 * refused before it can become a negative one.
 */
export function signalableChildPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1;
}

/** A finished launch: the table composes nothing (server/sessions.ts does). */
export interface PtySpawnRequest {
  /** The owner's session id; the table keys everything by it. */
  id: string;
  file: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  /**
   * The opaque metadata blob the entry starts with (D9 P2: the pty-host's
   * `spawn` carries it, so a backend that dies right after the spawn still
   * leaves what P3 rebuilds the session from). Capped like `setMeta`.
   */
  meta?: string;
}

/** What a successful spawn reports back. */
export interface PtySpawned {
  pid: number;
}

/** How a PTY ended: node-pty's code and signal (null when none), and when (epoch ms). */
export interface PtyExitRecord {
  code: number;
  signal: number | null;
  at: number;
}

/** The ring as it stands: its bytes, oldest first, and the absolute offset one past the last. */
export interface PtySnapshot {
  ring: Buffer;
  endOffset: number;
}

/** One entry as `list()` reports it. */
export interface PtyEntrySummary {
  id: string;
  pid: number;
  cols: number;
  rows: number;
  endOffset: number;
  exit: PtyExitRecord | null;
  meta: string | null;
}

/**
 * What the table tells its owner. `offset` is the absolute stream offset of
 * the chunk's FIRST byte (UTF-8), so `offset + byteLength(data)` is the ring's
 * `endOffset` right after it. Both are delivered synchronously from node-pty's
 * own callbacks, so the rescued final output always precedes the exit.
 *
 * `bytes` is `data` as UTF-8, encoded once (PLAN-QUALITY Q12): the same
 * buffer the ring keeps, so a receiver may keep it too (the backend's mirror,
 * a frame) but never writes to it.
 */
export interface PtyEvents {
  output(id: string, data: string, offset: number, bytes: Buffer): void;
  exit(id: string, record: PtyExitRecord): void;
}

interface PtyEntry {
  readonly pid: number;
  /** null once killed (the ladder addresses the pid) or exited. */
  pty: pty.IPty | null;
  /**
   * The node-pty handle for its whole life, killed or not: a killed PTY still
   * reads until its exit, so backpressure (`setPaused`) must reach it too.
   */
  readonly proc: pty.IPty;
  readonly ring: RingBuffer;
  cols: number;
  rows: number;
  exit: PtyExitRecord | null;
  meta: string | null;
  /** The owner let go while the PTY still ran: drop the entry right after its exit. */
  forgotten: boolean;
}

export class PtyTable {
  readonly #entries = new Map<string, PtyEntry>();
  readonly #events: PtyEvents;
  readonly #log: Logger;
  readonly #slog: Logger;
  /**
   * Kill ladders still in flight, by session id, with the pending rung (SIGTERM
   * or SIGKILL). The entry may already be forgotten, so this map is the ONLY
   * handle shutdownAll() has on a process the ladder has not reached yet.
   * Without it, a DELETE followed within 5 s by Restart service / Update /
   * launcher stop would leave exactly the process the ladder exists to end,
   * with its API key, outliving us.
   *
   * A rung is cancelled when the PTY's whole process GROUP is gone — never
   * merely when its leader exited: a worker child that ignored the signal
   * keeps running in that group, and ending it is the entire point of the
   * ladder. A live group also pins its leader's pid NUMBER (Linux frees a
   * number only when nothing references it under any type, PGID included), so
   * while the group answers `kill(-pid, 0)` the negative pid is still THIS
   * session's group and can never be a stranger's.
   */
  readonly #escalating = new Map<string, { pid: number; timer: NodeJS.Timeout | undefined }>();
  /**
   * Every PTY's read stream is paused (D9 P2: the pty-host's owner socket is
   * backed up). A PTY spawned meanwhile starts paused too.
   */
  #paused = false;

  constructor(log: Logger, events: PtyEvents) {
    this.#log = log;
    this.#slog = scoped(log, 'session');
    this.#events = events;
  }

  /** Start a PTY under the owner's id. Throws if node-pty cannot spawn it, or the id is taken. */
  spawn(req: PtySpawnRequest): PtySpawned {
    if (this.#entries.has(req.id)) throw new Error(`pty ${req.id} already exists`);
    if (req.meta !== undefined) assertMetaSize(req.meta);
    const proc = pty.spawn(req.file, req.argv, {
      name: 'xterm-256color',
      cols: req.cols,
      rows: req.rows,
      cwd: req.cwd,
      env: req.env,
    });
    const { id } = req;
    raiseOomScore(id, proc.pid, this.#slog);
    // The ladder outlives `entry.pty` (kill() nulls it), so the pid the group
    // is addressed by is captured once, here.
    const entry: PtyEntry = {
      pid: proc.pid,
      pty: proc,
      proc,
      ring: new RingBuffer(SCROLLBACK_MAX_BYTES),
      cols: req.cols,
      rows: req.rows,
      exit: null,
      meta: req.meta ?? null,
      forgotten: false,
    };
    this.#entries.set(id, entry);
    if (this.#paused) proc.pause();

    const onOutput = (data: string): void => {
      const offset = entry.ring.endOffset;
      const bytes = Buffer.from(data, 'utf8');
      entry.ring.append(bytes);
      this.#events.output(id, data, offset, bytes);
    };
    proc.onData(onOutput);
    // The child's last bytes can outlive node-pty's read stream; rescue them
    // into the SAME path, before onExit records the exit.
    rescueFinalOutput(proc, onOutput, this.#log);

    proc.onExit(({ exitCode, signal }) => {
      // The LEADER is gone; the ladder is only called off when the whole group
      // is. A CLI whose top-level process honours SIGHUP but whose worker child
      // ignores it would otherwise leave that child running forever — with the
      // stored API key in its environment.
      const ladder = this.#escalating.get(id);
      if (ladder?.timer !== undefined && processGroupGone(entry.pid, this.#log)) {
        clearTimeout(ladder.timer);
        this.#escalating.delete(id);
      }
      entry.pty = null;
      entry.exit = { code: exitCode, signal: signal ?? null, at: Date.now() };
      this.#events.exit(id, entry.exit);
      if (entry.forgotten) this.#entries.delete(id);
    });
    return { pid: proc.pid };
  }

  write(id: string, data: string): void {
    this.#entries.get(id)?.pty?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    entry.cols = cols;
    entry.rows = rows;
    entry.pty?.resize(cols, rows);
  }

  /**
   * End a PTY. SIGHUP first either way (`pty.kill()`), then `ladder` (DELETE):
   * SIGTERM and SIGKILL to the process group on a timer (#escalate); or `now`
   * (shutdown): SIGKILL to the group at once — no grace at shutdown, a process
   * that ignores SIGHUP must not outlive the backend carrying an API key in
   * its environment. A PTY already killed or exited is left alone.
   */
  kill(id: string, mode: 'ladder' | 'now'): void {
    const entry = this.#entries.get(id);
    if (entry === undefined || entry.pty === null) return;
    try {
      entry.pty.kill();
    } catch (err) {
      this.#log('warn', `session ${id} kill failed: ${describeError(err)}`);
    }
    entry.pty = null;
    if (mode === 'now') {
      // `-pid` is unambiguous here: the group was alive a line ago, and a live
      // group pins its leader's pid number.
      this.#slog(
        'info',
        `${id} killed for shutdown with SIGHUP; sending SIGKILL to its process group immediately`,
      );
      signalProcessGroup(id, entry.pid, 'SIGKILL', this.#log);
    } else {
      this.#escalate(id, entry.pid);
    }
  }

  /** The ring and its absolute end, or undefined for an unknown id. */
  snapshot(id: string): PtySnapshot | undefined {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    return { ring: entry.ring.toBuffer(), endOffset: entry.ring.endOffset };
  }

  /** An entry's absolute output end, or undefined for an unknown id (no summary built, Q12). */
  endOffset(id: string): number | undefined {
    return this.#entries.get(id)?.ring.endOffset;
  }

  /**
   * Replace an entry's opaque metadata blob. Throws a RangeError over
   * META_MAX_BYTES (nothing stored); an unknown id is a no-op.
   */
  setMeta(id: string, meta: string): void {
    assertMetaSize(meta);
    const entry = this.#entries.get(id);
    if (entry !== undefined) entry.meta = meta;
  }

  /** How many entries the table holds, running and exited (the pty-host's idle rule). */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * Pause (or resume) reading every PTY that has not exited yet — D9 P2's
   * backpressure: the pty-host's owner socket is backed up past its limit.
   * A paused PTY's child blocks once the kernel's pty buffer is full, so
   * nothing is dropped; what the stream had already read stays in its own
   * buffer, which the final-output rescue flushes if the PTY ends paused.
   */
  setPaused(paused: boolean): void {
    if (this.#paused === paused) return;
    this.#paused = paused;
    for (const entry of this.#entries.values()) {
      if (entry.exit !== null) continue;
      if (paused) entry.proc.pause();
      else entry.proc.resume();
    }
  }

  /** Every entry, running and exited, as a summary (no ring bytes). */
  list(): PtyEntrySummary[] {
    return [...this.#entries].map(([id, e]) => ({
      id,
      pid: e.pid,
      cols: e.cols,
      rows: e.rows,
      endOffset: e.ring.endOffset,
      exit: e.exit === null ? null : { ...e.exit },
      meta: e.meta,
    }));
  }

  /**
   * The owner is done with an entry: dropped now when its PTY has exited,
   * otherwise right after the exit is reported (a killed PTY still reports it).
   */
  forget(id: string): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    if (entry.exit !== null) this.#entries.delete(id);
    else entry.forgotten = true;
  }

  /**
   * Shutdown: every PTY still running is killed `now`, then every ladder in
   * flight is finished off — the caller exits right after this returns and the
   * ladder's timers are unref'd, so anything still alive here would survive
   * the backend. Same treatment as a live PTY at shutdown: SIGKILL to the
   * group, now.
   */
  shutdownAll(): void {
    for (const [id, entry] of this.#entries) {
      if (entry.pty !== null) this.kill(id, 'now');
    }
    for (const [id, { pid }] of this.#escalating) {
      if (processGroupGone(pid, this.#log)) continue;
      this.#slog(
        'info',
        `${id} killed for shutdown with SIGHUP; sending SIGKILL to its process group immediately`,
      );
      signalProcessGroup(id, pid, 'SIGKILL', this.#log);
    }
    this.#escalating.clear();
  }

  /**
   * DELETE's signal ladder after the SIGHUP `pty.kill()` already sent: SIGTERM
   * to the process group after KILL_TERM_AFTER_MS, SIGKILL after a further
   * KILL_KILL_AFTER_MS, each step skipped once the whole GROUP is gone.
   *
   * Measured 2026-09-20: Gemini CLI 0.60 (a `node` wrapper that relaunches
   * itself as a `node --max-old-space-size=…` CHILD) ignores both SIGHUP and
   * SIGTERM, so a deleted gemini session and its child kept running — and kept
   * GEMINI_API_KEY in their environment after the user had removed that key.
   * Only SIGKILL ended them.
   *
   * Both timers are unref'd: an escalation in flight never keeps the process
   * alive, and shutdown takes the immediate path anyway.
   */
  #escalate(id: string, pid: number): void {
    const ladder: { pid: number; timer: NodeJS.Timeout | undefined } = { pid, timer: undefined };
    this.#escalating.set(id, ladder);
    const term = setTimeout(() => {
      ladder.timer = undefined;
      if (processGroupGone(pid, this.#log)) {
        this.#escalating.delete(id);
        return;
      }
      this.#slog(
        'info',
        `${id} still running ${KILL_TERM_AFTER_MS}ms after SIGHUP; sending SIGTERM to its process group`,
      );
      signalProcessGroup(id, pid, 'SIGTERM', this.#log);
      const kill = setTimeout(() => {
        ladder.timer = undefined;
        this.#escalating.delete(id);
        if (processGroupGone(pid, this.#log)) return;
        this.#slog(
          'info',
          `${id} still running ${KILL_KILL_AFTER_MS}ms after SIGTERM; sending SIGKILL to its process group`,
        );
        signalProcessGroup(id, pid, 'SIGKILL', this.#log);
      }, KILL_KILL_AFTER_MS);
      kill.unref();
      ladder.timer = kill;
    }, KILL_TERM_AFTER_MS);
    term.unref();
    ladder.timer = term;
  }

}

/** The group probe warns about an unexpected errno at most once per process. */
let groupProbeWarned = false;

/**
 * True when the PTY's process group holds NO process any more — the only
 * safe "stop signalling" answer, and a stronger one than "its leader exited":
 * a worker child that ignored the signal still lives in that group.
 *
 * It doubles as the pid-reuse guard. Linux frees a pid NUMBER only once
 * nothing references it under any type — PGID and SID included — so a group
 * that still answers pins its leader's number even after the leader itself
 * was reaped. A successful `kill(-pid, 0)` therefore proves `-pid` is still
 * THIS session's group and never a stranger that inherited the number.
 *
 * Anything other than ESRCH (EPERM, or an errno we did not foresee) is read
 * as "alive": the ladder may then signal in vain, which is harmless, while
 * the opposite mistake leaks a process.
 *
 * One home (D9 P3): the table's kill ladder and the backend's pty-host
 * broker (server/pty-host-broker.ts, a lost pty-host's groups) both use it.
 */
export function processGroupGone(pid: number, log: Logger): boolean {
  if (!signalableChildPid(pid)) return true;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return true;
    if (code !== 'EPERM' && !groupProbeWarned) {
      groupProbeWarned = true;
      log('warn', `process group probe failed, assuming alive: ${describeError(err)}`);
    }
    return false;
  }
}

/**
 * Signal the PTY's whole PROCESS GROUP. node-pty's forkpty child calls
 * setsid(), so `pty.pid` IS the group leader and the negative pid reaches
 * every descendant the CLI spawned — which is the only way to end a wrapper
 * whose real work runs in a child.
 *
 * ESRCH means the group is already gone: the ordinary race with onExit, not
 * an error. The pid guard is a seatbelt only — `process.kill(-1, …)` would
 * signal every process this user owns, so a pid that is not a plain child
 * pid is never signalled.
 */
export function signalProcessGroup(id: string, pid: number, signal: 'SIGTERM' | 'SIGKILL', log: Logger): void {
  if (!signalableChildPid(pid)) {
    log('warn', `session ${id} not signalling process group: implausible pid ${pid}`);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
    log('warn', `session ${id} ${signal} to process group ${pid} failed: ${describeError(err)}`);
  }
}

/**
 * The pieces of node-pty's UnixTerminal we need but that `IPty` does not
 * declare: the pty master fd and the tty.ReadStream node-pty reads it with.
 * Both are absent on Windows (ConPTY has no fd) — every use is guarded.
 */
interface PtyMasterInternals {
  readonly fd?: unknown;
  readonly _socket?:
    | {
        destroy?: unknown;
        readonly destroyed?: unknown;
        readonly read?: unknown;
        readonly readableLength?: unknown;
      }
    | undefined;
}

/** Bound on the buffered-data flush below; one read() normally empties it. */
const BUFFERED_FLUSH_MAX_READS = 64;

/**
 * Hand on what the read STREAM already holds in its own buffer (D9 P2). A
 * stream paused for backpressure keeps the chunks libuv read before the pause;
 * destroying it drops them, and the fd drain below would then deliver the
 * kernel's later bytes after a hole. `read()` emits each chunk as 'data', the
 * same path every other byte takes, so order is kept: buffer first, fd second.
 * In flowing mode the buffer is empty and this does nothing.
 */
function flushBufferedStream(socket: NonNullable<PtyMasterInternals['_socket']>): void {
  const read = socket.read;
  if (typeof read !== 'function') return;
  for (let i = 0; i < BUFFERED_FLUSH_MAX_READS; i++) {
    const pending = socket.readableLength;
    if (typeof pending !== 'number' || pending <= 0) return;
    if (read.call(socket) === null) return;
  }
}

/** One read(2) buffer's worth; the kernel's per-tty backlog is far below this. */
const TAIL_DRAIN_CHUNK_BYTES = 64 * 1024;
/** Safety bound on the drain loop so a pathological fd can never spin. */
const TAIL_DRAIN_MAX_READS = 64;
/** Warn once per process, not once per session, if the rescue can't attach. */
let rescueUnavailableLogged = false;

/** What a pty master fd must still look like for the drain to touch it. */
interface PtyMasterIdentity {
  readonly rdev: number;
  readonly ino: number;
}

/**
 * Identity of an fd that is a character device, or undefined for anything else
 * (regular file, closed fd, socket). rdev+ino is what distinguishes the pty
 * master's device node from an unrelated file the number may have been recycled
 * to. Note the limit: every pty master in this process clones /dev/ptmx and so
 * shares one rdev+ino, so this separates "a pty master" from "not a pty master"
 * — it cannot separate two pty masters.
 */
function ptyMasterIdentity(fd: number): PtyMasterIdentity | undefined {
  try {
    const st = fstatSync(fd);
    if (!st.isCharacterDevice()) return undefined;
    return { rdev: st.rdev, ino: st.ino };
  } catch {
    return undefined;
  }
}

/**
 * Synchronously pull whatever the kernel still holds on the pty master fd.
 *
 * The fd is non-blocking — but that guarantee does NOT come from libuv, which
 * for a pty master takes the `uv__tty_is_slave(fd)`-false branch of
 * `uv_tty_init`, sets UV_HANDLE_BLOCKING_WRITES and skips `uv__nonblock(fd, 1)`
 * (measured: a fresh /dev/ptmx handed to `new tty.ReadStream(fd)` stays at
 * flags 02100002, no O_NONBLOCK). What sets O_NONBLOCK is node-pty's own native
 * code: `pty_nonblock(master)` in `node_modules/node-pty/src/unix/pty.cc`
 * (Linux forkpty path ~:445, macOS posix_spawn path ~:375, impl :583-586).
 *
 * That is load-bearing — it is the whole safety case for a synchronous readSync
 * on the event loop. Without it, a read against a pty whose slave is still held
 * by a surviving grandchild blocks in the kernel with no timeout and freezes the
 * single process that serves every session, the HTTP API and every WebSocket.
 * A node-pty version bump is therefore a re-check of this invariant.
 *
 * With it, this never blocks: it ends on the kernel's own signal — EIO once the
 * pty is gone, EAGAIN/0 once it is empty — not on a clock. Errors are swallowed
 * by design; a failed rescue must never take a session down.
 */
function drainPtyMaster(
  fd: number,
  identity: PtyMasterIdentity,
  emit: (data: string) => void,
  log: Logger,
): void {
  // The fd number only means anything while it still refers to THIS pty master.
  // That is inherited from node-pty's teardown order; enforce it here instead.
  // If the fd were already closed and its number recycled, an unrelated file
  // (server.log, another session's master, runtime.json and its bearer token)
  // would be read into the scrollback and broadcast to every attached client.
  const now = ptyMasterIdentity(fd);
  if (now === undefined || now.rdev !== identity.rdev || now.ino !== identity.ino) return;

  const buf = Buffer.allocUnsafe(TAIL_DRAIN_CHUNK_BYTES);
  const decoder = new StringDecoder('utf8');
  let hitCap = true;
  for (let i = 0; i < TAIL_DRAIN_MAX_READS; i++) {
    let n: number;
    try {
      n = readSync(fd, buf, 0, buf.byteLength, null);
    } catch {
      hitCap = false;
      break; // EIO (pty gone), EAGAIN (empty), EBADF — nothing left to rescue.
    }
    if (n <= 0) {
      hitCap = false;
      break;
    }
    const text = decoder.write(buf.subarray(0, n));
    if (text !== '') emit(text);
  }
  const rest = decoder.end();
  if (rest !== '') emit(rest);
  if (hitCap) {
    // Ran out of read budget with the fd still producing: the remainder is
    // truncated. Silent truncation on the very path this rescue exists for.
    log(
      'warn',
      `pty final-output rescue stopped at its ${TAIL_DRAIN_MAX_READS}-read bound ` +
        `(${TAIL_DRAIN_MAX_READS * TAIL_DRAIN_CHUNK_BYTES} bytes); ` +
        'output past that point is missing from the scrollback',
    );
  }
}

/**
 * Rescue a session's FINAL output — the crown-jewel promise that reattaching
 * shows you what you left.
 *
 * node-pty reads the pty master through a tty.ReadStream. When the child exits
 * the master goes POLLHUP, and libuv (`uv__stream_io`, src/unix/stream.c)
 * short-circuits straight to a synthetic EOF whenever its previous read was a
 * short one — without reading again. Everything the kernel still holds is
 * dropped on the floor: it never reaches `onData`, so it never reaches the
 * scrollback ring, so `attach()` replays a buffer missing its newest bytes.
 * Whenever the reader is behind — CPU contention, a busy broadcast, a big
 * burst — that is exactly the tail of the session. Measured here: a bash
 * session writing 32 KiB and then `echo TAIL_MARK` loses the last ~4 KiB,
 * marker included, 6 runs out of 6.
 *
 * Those bytes are not gone at that point. A plain read(2) on the master still
 * returns them and only then reports EIO. So we hook the single moment before
 * the fd is closed — `net.Socket#destroy`, which is the only route to that
 * close and is taken both by the stream's autoDestroy after the fake EOF and
 * by node-pty's own post-exit destroy timer — and drain the fd there.
 *
 * Ordering is preserved for free: destroy runs before the socket's 'close',
 * and node-pty emits 'exit' from that 'close', so every rescued `data` frame
 * is broadcast before the `exit` frame, and the ring buffer is complete before
 * `onExit` stamps the session 'exited'.
 *
 * Known seam: node's stream flushes its own UTF-8 decoder at the synthetic EOF,
 * so a multi-byte character split across that boundary can show up as a
 * replacement character. Rare in practice and bounded to a single character —
 * measured here as zero U+FFFD across 2000 three-byte glyphs (48 probe runs,
 * 20 mutation-verified test runs), while a different shape (all-multibyte tail,
 * 15 ms/frame stall) did produce exactly 2. Pinned by
 * `tests/server/sessions-tail.test.ts:290`; the caveat stays because the flush point
 * is node's, not ours, and may differ on other Node versions. One garbled glyph
 * instead of a lost kilobyte.
 */
function rescueFinalOutput(proc: pty.IPty, emit: (data: string) => void, log: Logger): void {
  const internals = proc as unknown as PtyMasterInternals;
  const fd = internals.fd;
  const socket = internals._socket;
  // Captured now, while the fd is provably this session's master, and re-checked
  // in drainPtyMaster before any read.
  const identity = typeof fd === 'number' && fd >= 0 ? ptyMasterIdentity(fd) : undefined;
  if (
    typeof fd !== 'number' ||
    fd < 0 ||
    identity === undefined ||
    socket === undefined ||
    typeof socket.destroy !== 'function'
  ) {
    // Windows/ConPTY has no master fd; a reshaped node-pty would land here
    // too. Say so once — silently dropping the rescue would look like the
    // original bug coming back with no trace of why.
    if (!rescueUnavailableLogged) {
      rescueUnavailableLogged = true;
      log(
        'warn',
        'pty final-output rescue unavailable (no master fd / read socket / not a character ' +
          'device on this node-pty): ' +
          'output produced immediately before a session exits may be missing from scrollback replay',
      );
    }
    return;
  }

  const realDestroy = socket.destroy as (this: unknown, ...args: unknown[]) => unknown;
  let done = false;
  (socket as { destroy: unknown }).destroy = function (this: unknown, ...args: unknown[]): unknown {
    try {
      if (!done) {
        done = true; // The fd is closed by realDestroy below — never read after.
        if (socket.destroyed !== true) {
          flushBufferedStream(socket);
          drainPtyMaster(fd, identity, emit, log);
        }
      }
    } catch (err) {
      // Swallowed on purpose, and this is the guard that makes that true. emit()
      // runs the owner's whole output path (ring buffer, broadcast, ws.send).
      // A throw escaping here would skip realDestroy: the master fd would never
      // close, node-pty would never emit 'exit', and the session would stay
      // pinned 'running' with a non-null pty and no history stamp. It would also
      // surface inside node-pty's teardown as an uncaughtException, which tears
      // down the whole process — every session, not one.
      try {
        log('warn', `pty final-output rescue failed: ${String(err)}`);
      } catch {
        // Not even logging may stand between this handler and realDestroy.
      }
    }
    return realDestroy.apply(this, args);
  };
}
