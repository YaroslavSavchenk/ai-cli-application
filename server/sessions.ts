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
 * Every create/exit/kill is mirrored into the crash-safe SessionJournal so an
 * unclean end can be offered for relaunch on the next run (journal.ts).
 *
 * ONE agent-specific behaviour lives here, deliberately narrow: a claude-kind
 * session (basename(command) === 'claude') gets a per-session settings file
 * injected as `--settings <file>` so Claude Code draws OUR status line
 * (session-settings.ts). Everything else about the spawn stays generic, the
 * injected flag never enters SessionInfo.args, and a session that already
 * carries its own `--settings` is left completely alone.
 */
import { randomUUID } from 'node:crypto';
import { fstatSync, readSync } from 'node:fs';
import { basename } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import type { SessionInfo, ServerMessage } from '../shared/protocol.ts';
import type { SessionJournal } from './journal.ts';
import { hasSettingsArg, parsePermissionMode, type SessionSettingsStore } from './session-settings.ts';
import type { Logger } from './config.ts';

/** Scrollback cap: 1 MiB of bytes (not lines). Oldest chunks are dropped. */
export const SCROLLBACK_MAX_BYTES = 1024 * 1024;

/** Byte-capped ring buffer of output chunks; drops oldest chunks when over cap. */
export class RingBuffer {
  #chunks: Buffer[] = [];
  #bytes = 0;
  readonly #maxBytes: number;

  constructor(maxBytes: number = SCROLLBACK_MAX_BYTES) {
    this.#maxBytes = maxBytes;
  }

  append(data: string): void {
    let chunk = Buffer.from(data, 'utf8');
    if (chunk.byteLength > this.#maxBytes) {
      // A single chunk larger than the whole cap: keep only its tail.
      chunk = chunk.subarray(chunk.byteLength - this.#maxBytes);
      this.#chunks = [];
      this.#bytes = 0;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.byteLength;
    while (this.#bytes > this.#maxBytes && this.#chunks.length > 1) {
      const dropped = this.#chunks.shift();
      if (dropped !== undefined) this.#bytes -= dropped.byteLength;
    }
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
}

export interface CreateSessionOptions {
  projectId?: string;
  cwd: string;
  command: string;
  args: string[];
  title?: string;
  cols: number;
  rows: number;
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
      // pinned 'running' with a non-null pty and no journal stamp. It would also
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

export class SessionManager {
  #sessions = new Map<string, Session>();
  readonly #log: Logger;
  readonly #journal: SessionJournal;
  /** Absent -> no status-line injection at all (tests that don't need it). */
  readonly #settings: SessionSettingsStore | undefined;

  constructor(log: Logger, journal: SessionJournal, settings?: SessionSettingsStore) {
    this.#log = log;
    this.#journal = journal;
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

  /** Spawn the PTY and register the session. Throws if the spawn fails. */
  create(opts: CreateSessionOptions): SessionInfo {
    const id = randomUUID();
    // Status line: claude-kind sessions only, and never over a client's own
    // --settings. `spawnArgs` is what the PTY gets; `opts.args` is what the
    // session (and therefore the journal, and therefore a relaunch offer)
    // remembers — a relaunch must get a FRESH settings file, not a path this
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

    let proc: pty.IPty;
    try {
      proc = pty.spawn(opts.command, spawnArgs, {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: {
          ...(process.env as Record<string, string>),
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        },
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

    const session: Session = { info, pty: proc, buffer: new RingBuffer(), clients: new Set(), inOsc: false };
    this.#sessions.set(id, session);
    this.#journal.recordCreate(info);

    const handleOutput = (data: string): void => {
      session.buffer.append(data);
      this.#broadcast(session, { type: 'data', data });
      if (scanForBell(data, session)) {
        session.info.attention = true;
        this.#broadcast(session, { type: 'attention' });
      }
    };

    proc.onData(handleOutput);
    // The child's last bytes can outlive node-pty's read stream; rescue them
    // into the SAME path, before onExit stamps the session 'exited'.
    rescueFinalOutput(proc, handleOutput, this.#log);

    proc.onExit(({ exitCode }) => {
      session.info.status = 'exited';
      session.info.exitCode = exitCode;
      session.pty = null;
      if (statusline) this.#settings?.remove(id);
      // No-op if already stamped 'user-kill'/'shutdown' (first stamp wins).
      this.#journal.markEnded(id, 'exit', exitCode);
      this.#broadcast(session, { type: 'exit', exitCode });
      this.#log('info', `session ${id} exited with code ${exitCode}`);
    });

    this.#log(
      'info',
      `session ${id} spawned: ${opts.command} ${JSON.stringify(spawnArgs)} in ${opts.cwd} (${opts.cols}x${opts.rows})`,
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
    session.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.#sessions.get(id);
    if (session === undefined) return;
    session.info.cols = cols;
    session.info.rows = rows;
    if (session.pty !== null) session.pty.resize(cols, rows);
  }

  markSeen(id: string): boolean {
    const session = this.#sessions.get(id);
    if (session === undefined) return false;
    session.info.attention = false;
    return true;
  }

  /** Kill the PTY (if running), close all attached clients, remove the session. */
  destroy(id: string): boolean {
    const session = this.#sessions.get(id);
    if (session === undefined) return false;
    this.#sessions.delete(id);
    // No-op when the session never had one, or when onExit already removed it.
    if (session.info.statusline === true) this.#settings?.remove(id);
    if (session.pty !== null) {
      // Stamp BEFORE kill so the async onExit's 'exit' stamp is the no-op.
      // At server shutdown endAllLive() ran first, so THIS is the no-op.
      this.#journal.markEnded(id, 'user-kill');
      try {
        session.pty.kill();
      } catch (err) {
        this.#log('warn', `session ${id} kill failed: ${String(err)}`);
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
    for (const id of [...this.#sessions.keys()]) this.destroy(id);
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
