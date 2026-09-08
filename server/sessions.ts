/**
 * SessionManager: sessions are first-class server-side objects.
 *
 * A session = a real PTY (node-pty) + metadata + a bounded scrollback ring
 * buffer. It exists independently of any browser connection; clients attach
 * and detach freely and the whole buffer is replayed on attach. On PTY exit
 * the session stays listed (status 'exited', buffer intact) until DELETEd.
 *
 * command + args are spawned as an argv array — client-supplied values never
 * enter a shell string. This is what keeps multi-CLI support generic.
 *
 * Every create/exit/kill is mirrored into the crash-safe SessionHistory so any
 * ended session can be RESUMED on this or a later run (history.ts).
 *
 * TWO agent-specific behaviours live here, both deliberately narrow and both
 * for claude-kind sessions only (basename(command) === 'claude'):
 *   - a per-session settings file injected as `--settings <file>` so Claude
 *     Code draws OUR status line (session-settings.ts);
 *   - an injected `--session-id <uuid>` pinning the launch to a conversation
 *     the history can later `--resume` (conversation.ts).
 * Everything else about the spawn stays generic, NEITHER injected flag ever
 * enters SessionInfo.args, a session that already carries its own `--settings`
 * is left alone, and one that already carries a resume/session flag is never
 * given a second one.
 */
import { randomUUID } from 'node:crypto';
import { fstatSync, readSync } from 'node:fs';
import { basename } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import type { SessionInfo, ServerMessage } from '../shared/protocol.ts';
import type { SessionHistory } from './history.ts';
import { planConversation } from './conversation.ts';
import { hasSettingsArg, parsePermissionMode, type SessionSettingsStore } from './session-settings.ts';
import { describeError, scoped, type Logger } from './config.ts';

/** Scrollback cap: 1 MiB of bytes (not lines). Oldest chunks are dropped. */
export const SCROLLBACK_MAX_BYTES = 1024 * 1024;

/** Minimum gap between per-session output summary lines (debug). */
export const OUTPUT_LOG_INTERVAL_MS = 1000;

/**
 * Byte-capped ring buffer of output chunks; drops oldest chunks when over cap.
 *
 * `onTrim` (optional) reports how many bytes were dropped, so the manager can
 * say in server.log that a session's scrollback is no longer complete — a
 * replay that silently starts mid-stream is otherwise indistinguishable from a
 * bug. It NEVER receives the bytes themselves.
 */
export class RingBuffer {
  #chunks: Buffer[] = [];
  #bytes = 0;
  readonly #maxBytes: number;
  readonly #onTrim: ((droppedBytes: number) => void) | undefined;

  constructor(maxBytes: number = SCROLLBACK_MAX_BYTES, onTrim?: (droppedBytes: number) => void) {
    this.#maxBytes = maxBytes;
    this.#onTrim = onTrim;
  }

  append(data: string): void {
    let chunk = Buffer.from(data, 'utf8');
    let trimmed = 0;
    if (chunk.byteLength > this.#maxBytes) {
      // A single chunk larger than the whole cap: keep only its tail.
      trimmed += this.#bytes + (chunk.byteLength - this.#maxBytes);
      chunk = chunk.subarray(chunk.byteLength - this.#maxBytes);
      this.#chunks = [];
      this.#bytes = 0;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.byteLength;
    while (this.#bytes > this.#maxBytes && this.#chunks.length > 1) {
      const dropped = this.#chunks.shift();
      if (dropped !== undefined) {
        this.#bytes -= dropped.byteLength;
        trimmed += dropped.byteLength;
      }
    }
    if (trimmed > 0 && this.#onTrim !== undefined) this.#onTrim(trimmed);
  }

  get byteLength(): number {
    return this.#bytes;
  }

  toString(): string {
    return Buffer.concat(this.#chunks).toString('utf8');
  }
}

interface Session {
  info: SessionInfo;
  pty: pty.IPty | null;
  buffer: RingBuffer;
  clients: Set<WebSocket>;
  /** OSC-string parser state for bell detection, carried across data chunks. */
  inOsc: boolean;
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
}

export interface CreateSessionOptions {
  projectId?: string;
  cwd: string;
  command: string;
  args: string[];
  title?: string;
  cols: number;
  rows: number;
  /**
   * RESUME ONLY: the history entry this launch continues. The history upsert
   * targets THIS key instead of the one the composed args imply, so a resume
   * updates the entry it came from instead of forking a new one.
   */
  historyId?: string;
}

/**
 * True when the chunk contains a REAL bell — not the 0x07 that terminates an
 * OSC string. Shells repaint window titles ("\x1b]0;user@host: dir\x07") on
 * every prompt, so counting those BELs raises spurious attention on
 * background sessions after any repaint (e.g. a resize). OSC state carries
 * across chunk boundaries via the session's `inOsc` flag; OSC ends at BEL or
 * ST (ESC backslash).
 */
function scanForBell(data: string, session: { inOsc: boolean }): boolean {
  let bell = false;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (session.inOsc) {
      if (c === 0x07) session.inOsc = false;
      else if (c === 0x1b && data.charCodeAt(i + 1) === 0x5c) {
        session.inOsc = false;
        i++;
      }
    } else if (c === 0x1b && data.charCodeAt(i + 1) === 0x5d) {
      session.inOsc = true;
      i++;
    } else if (c === 0x07) {
      bell = true;
    }
  }
  return bell;
}

/**
 * The pieces of node-pty's UnixTerminal we need but that `IPty` does not
 * declare: the pty master fd and the tty.ReadStream node-pty reads it with.
 * Both are absent on Windows (ConPTY has no fd) — every use is guarded.
 */
interface PtyMasterInternals {
  readonly fd?: unknown;
  readonly _socket?: { destroy?: unknown; readonly destroyed?: unknown } | undefined;
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
 * `tests/sessions-tail.test.ts:290`; the caveat stays because the flush point
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
        if (socket.destroyed !== true) drainPtyMaster(fd, identity, emit, log);
      }
    } catch (err) {
      // Swallowed on purpose, and this is the guard that makes that true. emit()
      // runs the manager's whole output path (ring buffer, broadcast, ws.send).
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

/**
 * The four variables that belong to a RESTART HANDOFF and to nothing else
 * (server/restart.ts): they describe how THIS backend was started. A session
 * inheriting them would hand a shell — and anything the user runs in it,
 * including another copy of this app — a port hint, a foreign pid, a served
 * frontend directory and a "you are a standby" flag that mean nothing there
 * and would be obeyed by a backend launched from inside the terminal.
 */
const HANDOFF_ENV = [
  'AI_SM_STANDBY',
  'AI_SM_PORT_HINT',
  'AI_SM_RESTARTED_FROM',
  'AI_SM_WEB_DIST_DIR',
] as const;

/** This process's environment as a PTY gets it: ours, minus the handoff flags. */
function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
  for (const name of HANDOFF_ENV) delete env[name];
  return env;
}

export class SessionManager {
  #sessions = new Map<string, Session>();
  readonly #log: Logger;
  readonly #history: SessionHistory;
  /** Absent -> no status-line injection at all (tests that don't need it). */
  readonly #settings: SessionSettingsStore | undefined;

  readonly #slog: Logger;

  constructor(log: Logger, history: SessionHistory, settings?: SessionSettingsStore) {
    this.#log = log;
    this.#slog = scoped(log, 'session');
    this.#history = history;
    this.#settings = settings;
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()].map((s) => ({ ...s.info }));
  }

  get(id: string): SessionInfo | undefined {
    const s = this.#sessions.get(id);
    return s === undefined ? undefined : { ...s.info };
  }

  has(id: string): boolean {
    return this.#sessions.has(id);
  }

  /**
   * Bytes attach() would replay right now (0 for an unknown session). Read by
   * the WS layer so the log can state how much scrollback a client received —
   * the count only, never the content.
   */
  scrollbackBytes(id: string): number {
    return this.#sessions.get(id)?.buffer.byteLength ?? 0;
  }

  /** Spawn the PTY and register the session. Throws if the spawn fails. */
  create(opts: CreateSessionOptions): SessionInfo {
    const id = randomUUID();
    // Status line: claude-kind sessions only, and never over a client's own
    // --settings. `spawnArgs` is what the PTY gets; `opts.args` is what the
    // session (and therefore the history entry, and therefore a resume)
    // remembers — a resume must get a FRESH settings file, not a path this
    // boot's wipe already removed.
    let spawnArgs = [...opts.args];
    let statusline = false;
    if (
      this.#settings !== undefined &&
      basename(opts.command) === 'claude' &&
      !hasSettingsArg(opts.args)
    ) {
      const file = this.#settings.write(id, parsePermissionMode(opts.args));
      if (file !== undefined) {
        spawnArgs = [...spawnArgs, '--settings', file];
        statusline = true;
      }
    }
    // Conversation pinning: same discipline as --settings. Whatever the plan
    // adds on top of the client's own argv (today: `--session-id <id>`, and
    // only when the client asked for no resume/session flag itself) goes into
    // the PTY argv, never into info.args.
    const plan = planConversation(opts.command, opts.args, id);
    if (plan.injected.length > 0) spawnArgs = [...spawnArgs, ...plan.injected];

    let proc: pty.IPty;
    try {
      proc = pty.spawn(opts.command, spawnArgs, {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: ptyEnv(),
      });
    } catch (err) {
      // A failed spawn must not leave its settings file behind.
      if (statusline) this.#settings?.remove(id);
      throw err;
    }

    const info: SessionInfo = {
      id,
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
      title: opts.title !== undefined && opts.title !== '' ? opts.title : opts.command,
      command: opts.command,
      args: [...opts.args],
      cwd: opts.cwd,
      status: 'running',
      cols: opts.cols,
      rows: opts.rows,
      createdAt: new Date().toISOString(),
      attention: false,
      ...(statusline ? { statusline: true } : {}),
    };

    const session: Session = {
      info,
      pty: proc,
      buffer: new RingBuffer(SCROLLBACK_MAX_BYTES, (dropped) => {
        session.trimmedBytes += dropped;
      }),
      clients: new Set(),
      inOsc: false,
      outBytes: 0,
      outChunks: 0,
      trimmedBytes: 0,
      inBytes: 0,
      inFrames: 0,
      lastOutLogMs: Date.now(),
    };
    this.#sessions.set(id, session);
    this.#history.recordCreate(info, {
      id: opts.historyId ?? plan.id,
      conversation: plan.conversation,
      baseArgs: plan.baseArgs,
    });

    const handleOutput = (data: string): void => {
      session.buffer.append(data);
      session.outBytes += Buffer.byteLength(data);
      session.outChunks += 1;
      this.#flushOutputLog(id, session, false);
      this.#broadcast(session, { type: 'data', data });
      if (scanForBell(data, session)) {
        session.info.attention = true;
        this.#slog('debug', `${id} attention raised (BEL in output)`);
        this.#broadcast(session, { type: 'attention' });
      }
    };

    proc.onData(handleOutput);
    // The child's last bytes can outlive node-pty's read stream; rescue them
    // into the SAME path, before onExit stamps the session 'exited'.
    rescueFinalOutput(proc, handleOutput, this.#log);

    proc.onExit(({ exitCode, signal }) => {
      session.info.status = 'exited';
      session.info.exitCode = exitCode;
      session.pty = null;
      if (statusline) this.#settings?.remove(id);
      // No-op if already stamped 'user-kill'/'shutdown' (first stamp wins).
      this.#history.markEnded(id, 'exit', exitCode);
      this.#broadcast(session, { type: 'exit', exitCode });
      // Wording kept verbatim (tests and habits key off it); the signal and the
      // final output tally are appended.
      this.#log(
        'info',
        `session ${id} exited with code ${exitCode}` +
          `${signal === undefined || signal === 0 ? '' : ` (signal ${signal})`}`,
      );
      this.#flushOutputLog(id, session, true);
      this.#slog(
        'info',
        `${id} totals: scrollback ${session.buffer.byteLength} bytes, ` +
          `${session.clients.size} client(s) attached at exit`,
      );
    });

    // The FULL spawned argv, injections included (`--settings <file>`,
    // `--session-id <uuid>`, `--resume <id>`) — this is the line that answers
    // "what did the app actually run?".
    this.#log(
      'info',
      `session ${id} spawned: ${opts.command} ${JSON.stringify(spawnArgs)} in ${opts.cwd} (${opts.cols}x${opts.rows})`,
    );
    this.#slog(
      'debug',
      `${id} created: pid ${proc.pid}, title ${JSON.stringify(info.title)}, ` +
        `project ${info.projectId ?? 'none'}, statusline ${statusline}, ` +
        `history key ${opts.historyId ?? plan.id} (conversation ${plan.conversation})`,
    );
    return { ...info };
  }

  /**
   * Attach a client: replay the whole scrollback buffer FIRST, then an info
   * snapshot (and an exit notice if already exited), then live traffic.
   * ws frames are delivered in send order per socket, and the client is only
   * added to the broadcast set after replay is queued, so replay always
   * precedes any live data on this socket.
   */
  attach(id: string, ws: WebSocket): boolean {
    const session = this.#sessions.get(id);
    if (session === undefined) return false;
    this.#slog(
      'debug',
      `${id} attach: replaying ${session.buffer.byteLength} bytes, status ${session.info.status}, ` +
        `${session.clients.size + 1} client(s) after this one`,
    );
    this.#send(ws, { type: 'replay', data: session.buffer.toString() });
    this.#send(ws, { type: 'info', session: { ...session.info } });
    if (session.info.status === 'exited') {
      this.#send(ws, { type: 'exit', exitCode: session.info.exitCode ?? 0 });
    }
    session.clients.add(ws);
    ws.on('close', () => session.clients.delete(ws));
    return true;
  }

  write(id: string, data: string): void {
    const session = this.#sessions.get(id);
    if (session === undefined || session.pty === null) return;
    // Counted, never logged per frame: one ws `input` frame is one keystroke.
    session.inBytes += Buffer.byteLength(data);
    session.inFrames += 1;
    session.pty.write(data);
    this.#flushOutputLog(id, session, false);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      this.#slog('debug', `${id} resize ignored: no such session`);
      return;
    }
    session.info.cols = cols;
    session.info.rows = rows;
    if (session.pty !== null) session.pty.resize(cols, rows);
    else this.#slog('debug', `${id} resize ${cols}x${rows} recorded but the pty has exited`);
  }

  markSeen(id: string): boolean {
    const session = this.#sessions.get(id);
    if (session === undefined) return false;
    session.info.attention = false;
    return true;
  }

  /**
   * Kill the PTY (if running), close all attached clients, remove the session.
   *
   * `by` says WHO asked — 'user' for DELETE /api/sessions/:id, 'shutdown' for
   * destroyAll() at server exit. It only shapes the log line; the history stamp
   * stays 'user-kill' (endAllLive() has already stamped 'shutdown' by then, and
   * the first stamp wins).
   */
  destroy(id: string, by: 'user' | 'shutdown' = 'user'): boolean {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      this.#slog('debug', `${id} delete ignored: no such session`);
      return false;
    }
    this.#slog(
      'info',
      `${id} kill requested by ${by} (status ${session.info.status}, ` +
        `${session.clients.size} client(s) attached)`,
    );
    this.#sessions.delete(id);
    // No-op when the session never had one, or when onExit already removed it.
    if (session.info.statusline === true) this.#settings?.remove(id);
    if (session.pty !== null) {
      // Stamp BEFORE kill so the async onExit's 'exit' stamp is the no-op.
      // At server shutdown endAllLive() ran first, so THIS is the no-op.
      this.#history.markEnded(id, 'user-kill');
      try {
        session.pty.kill();
      } catch (err) {
        this.#log('warn', `session ${id} kill failed: ${describeError(err)}`);
      }
      session.pty = null;
    }
    for (const ws of session.clients) {
      try {
        ws.close(1000, 'session deleted');
      } catch {
        // Socket already gone.
      }
    }
    session.clients.clear();
    this.#log('info', `session ${id} deleted`);
    return true;
  }

  /** Kill every PTY (server shutdown). Sessions die with the server by design. */
  destroyAll(): void {
    const ids = [...this.#sessions.keys()];
    this.#slog('info', `destroying all ${ids.length} session(s) for shutdown`);
    for (const id of ids) this.destroy(id, 'shutdown');
  }

  /**
   * Summarize a session's traffic at most once per OUTPUT_LOG_INTERVAL_MS (and
   * unconditionally at exit, `force`): one output line and one input line.
   * COUNTS ONLY — both directions can hold anything the user typed or the agent
   * printed, so no byte of either is ever written to server.log.
   */
  #flushOutputLog(id: string, session: Session, force: boolean): void {
    const now = Date.now();
    if (!force && now - session.lastOutLogMs < OUTPUT_LOG_INTERVAL_MS) return;
    if (session.outBytes === 0 && session.trimmedBytes === 0 && session.inBytes === 0) {
      session.lastOutLogMs = now;
      return;
    }
    const elapsed = now - session.lastOutLogMs;
    if (session.outBytes > 0 || session.trimmedBytes > 0) {
      this.#slog(
        'debug',
        `${id} output ${session.outBytes} bytes in ${session.outChunks} chunk(s) over ${elapsed}ms` +
          `${session.trimmedBytes > 0 ? `, scrollback trimmed ${session.trimmedBytes} bytes` : ''}`,
      );
    }
    if (session.inBytes > 0) {
      this.#slog(
        'debug',
        `${id} input ${session.inBytes} bytes in ${session.inFrames} frame(s) over ${elapsed}ms`,
      );
    }
    session.outBytes = 0;
    session.outChunks = 0;
    session.trimmedBytes = 0;
    session.inBytes = 0;
    session.inFrames = 0;
    session.lastOutLogMs = now;
  }

  #broadcast(session: Session, message: ServerMessage): void {
    for (const ws of session.clients) this.#send(ws, message);
  }

  #send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

}
