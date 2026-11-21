/**
 * The pty-host's socket server: one data dir's PTYs (server/pty-table.ts),
 * served to ONE owner (the backend) and to short-lived probes over
 * `<dataDir>/pty-host.sock` (server/pty-host-wire.ts), with the process's
 * lifetime rules — idle exit, orphan grace, shutdown.
 *
 * Nocturne D9 P2 (.claude/plans/nocturne/PLAN-D9.md § Defaults). One of four
 * flat pieces: started by server/pty-host-main.ts, the wire in
 * server/pty-host-wire.ts, the backend's side server/pty-host-client.ts.
 *
 * Minimal on purpose: it composes nothing (every spawn carries its finished
 * file/argv/cwd/env), interprets no byte, and imports pty-table.ts — never
 * sessions-output.ts or sessions.ts, whose import chains pull in the rest of
 * the backend. Every import is static: the process must keep working after
 * the version dir it was started from is pruned.
 *
 * NEVER LOGGED: a byte of output or input, an env entry (the env carries the
 * API keys), argv, the token. pty-host.log holds lifecycle and counts only.
 *
 * Rules:
 *   - Connection: the first frame is `hello` within HELLO_TIMEOUT_MS, the
 *     token compared in constant time (server/auth.ts `tokenMatches`), the
 *     protocol an exact match; anything else is `refuse` and the socket is
 *     destroyed (no second hello is read). At most MAX_PENDING_CONNECTIONS
 *     wait for their hello at once.
 *   - Owner: exclusive, and its RIGHTS are the seat (`conn === #owner`),
 *     never the role a connection once had. A second owner is refused unless
 *     it asks `takeover`; then the old one is demoted at once, gets
 *     `bye taken-over` and is destroyed. A `detach` gives the seat up at once.
 *   - One pty-host per data dir: an abstract-socket instance lock, named by
 *     the data dir's secret `pty-host.lockname`, held for
 *     the process's life (`holdInstanceLock`); only its holder unlinks a
 *     stale `pty-host.sock`, binds and writes `pty-host.json`.
 *   - Backpressure: the owner socket's backlog over PAUSE_BACKLOG_BYTES pauses
 *     every PTY until it drains. Never paused without an owner: the ring keeps
 *     the tail and the next owner reads it from `snapshot`.
 *   - No owner (connection lost, or a clean `detach`): after the orphan grace
 *     (decision 26: 10 min) every PTY is killed and the process exits. A lost
 *     connection writes the crash line; a detach does not.
 *   - Zero entries for the idle time: the process exits, so the next spawn
 *     starts the current code.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { tokenMatches } from './auth.ts';
import { envMs, errorClass, scoped, type Logger } from './config.ts';
import { PtyTable, type PtyEntrySummary } from './pty-table.ts';
import {
  PTY_HOST_PROTOCOL,
  FrameReader,
  MAX_FRAME_PAYLOAD,
  WireError,
  buildOrUnknown,
  encodeControl,
  encodeOutput,
  encodeSnapshot,
  lockSecret,
  parseClientMessage,
  type ByeReason,
  type ClientMessage,
  type Frame,
  type HostMessage,
  type RefuseReason,
} from './pty-host-wire.ts';

/** A connection that has not said a valid `hello` by then is closed. */
const HELLO_TIMEOUT_MS = 2000;

/** Owner socket backlog that pauses every PTY (D9 § Defaults). */
const PAUSE_BACKLOG_BYTES = 8 * 1024 * 1024;

/** Defaults and floor of the two lifetime seams. */
const DEFAULT_IDLE_MS = 60_000;
const DEFAULT_ORPHAN_MS = 600_000;
/**
 * The orphan grace never drops below this: a backend restart re-attaches
 * within it, and a mistyped `AI_SM_PTY_HOST_ORPHAN_MS=0` must not kill every
 * session the instant the owner blinks.
 */
const ORPHAN_FLOOR_MS = 1000;

/**
 * Connections still owing their hello, at most. A local peer that opens
 * sockets and says nothing holds each for HELLO_TIMEOUT_MS; past this many,
 * a new one is closed at once (the owner and probes say hello within ms).
 */
const MAX_PENDING_CONNECTIONS = 16;

interface PtyHostTimers {
  idleMs: number;
  orphanMs: number;
}

/** The lifetime seams: `AI_SM_PTY_HOST_IDLE_MS`, `AI_SM_PTY_HOST_ORPHAN_MS` (floored); bad values said in the log. */
export function resolveHostTimers(log: Logger, env: NodeJS.ProcessEnv = process.env): PtyHostTimers {
  return {
    idleMs: envMs('AI_SM_PTY_HOST_IDLE_MS', DEFAULT_IDLE_MS, log, { env }),
    orphanMs: envMs('AI_SM_PTY_HOST_ORPHAN_MS', DEFAULT_ORPHAN_MS, log, { env, floor: ORPHAN_FLOOR_MS }),
  };
}

export function resolveHostBuild(env: NodeJS.ProcessEnv = process.env): string {
  return buildOrUnknown(env['AI_SM_PTY_HOST_BUILD']);
}

interface PtyHostServerOptions {
  dataDir: string;
  socketPath: string;
  token: string;
  build: string;
  startedAt: string;
  timers: PtyHostTimers;
  log: Logger;
  /** Called once when the process should end (after every PTY was killed). */
  exit: (reason: string) => void;
}

interface Conn {
  readonly sock: Socket;
  readonly reader: FrameReader;
  /**
   * `gone`: refused, replaced by a takeover, or detached — its frames are
   * ignored and the socket is being destroyed. Owner RIGHTS are never read
   * from this field: only `conn === #owner` grants them.
   */
  role: 'pending' | 'owner' | 'probe' | 'gone';
  helloTimer: NodeJS.Timeout | undefined;
}

/** A goodbye frame gets this long to leave before its socket is destroyed anyway. */
const GOODBYE_MS = 1000;

/** Write one last frame, then destroy the socket (at once if the write cannot finish). */
function closeWith(sock: Socket, frame: Buffer): void {
  if (sock.destroyed) return;
  const timer = setTimeout(() => sock.destroy(), GOODBYE_MS);
  timer.unref();
  sock.write(frame, () => {
    clearTimeout(timer);
    sock.destroy();
  });
}

/**
 * The single-instance lock: an ABSTRACT Unix socket (Linux; no file, so
 * nothing stale is ever left behind — the kernel releases the name when the
 * process dies) named after this data dir's secret
 * (server/pty-host-wire.ts `lockSecret`, kept in the 0700 data dir). Held for
 * the whole life of the process, so the holder alone may unlink and bind
 * `pty-host.sock` and write `pty-host.json`: two pty-hosts started at once on
 * one data dir cannot both find the socket stale and both bind (D9 P2 security
 * review). undefined = another pty-host (running or starting) holds it.
 *
 * The name is a secret, not a digest of the path: abstract names are shared
 * by the whole network namespace (every WSL2 distro), so a path digest would
 * collide between two distros with the same home and could be squatted by
 * anyone (D9 P2 security re-review).
 */
function holdInstanceLock(dataDir: string): Promise<Server | undefined> {
  const name = `\0ai-sm-pty-host/${lockSecret(dataDir)}`;
  const lock = createServer((sock) => sock.destroy());
  return new Promise((resolve, reject) => {
    lock.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') resolve(undefined);
      else reject(err);
    });
    lock.once('listening', () => resolve(lock));
    lock.listen(name);
  });
}

/**
 * Bind `pty-host.sock`. Called only while holding the instance lock, so a
 * socket file already there is a dead pty-host's and is removed first —
 * unless it is not a socket at all (refused: not ours to delete). Created
 * 0600 (umask 0177 around the synchronous bind, restored at once: the PTY
 * children inherit this process's umask).
 */
function bindSocket(server: Server, path: string): Promise<void> {
  try {
    if (!lstatSync(path).isSocket()) {
      return Promise.reject(new Error(`${path} exists and is not a socket`));
    }
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      // Belt and braces: the umask made it 0600; make sure nothing else did.
      chmodSync(path, 0o600);
      resolve();
    });
    const old = process.umask(0o177);
    try {
      server.listen(path);
    } finally {
      process.umask(old);
    }
  });
}

export class PtyHostServer {
  readonly #opts: PtyHostServerOptions;
  readonly #log: Logger;
  readonly #table: PtyTable;
  readonly #server: Server;
  #owner: Conn | undefined;
  #pending = 0;
  #pendingWarned = false;
  #lock: Server | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #orphanTimer: NodeJS.Timeout | undefined;
  #paused = false;
  #pauses = 0;
  #pausedAt = 0;
  #ending = false;
  /** The inode of the socket this process bound: only that one is unlinked at exit. */
  #socketIno: number | undefined;

  constructor(opts: PtyHostServerOptions) {
    this.#opts = opts;
    this.#log = opts.log;
    this.#table = new PtyTable(opts.log, {
      output: (id, data, offset) => this.#onOutput(id, data, offset),
      exit: (id, record) => {
        const end = this.#table.list().find((e) => e.id === id)?.endOffset ?? 0;
        scoped(this.#log, 'pty')(
          'info',
          `${id} exited (code ${record.code}, signal ${record.signal ?? 'none'}, ${end} output bytes)`,
        );
        this.#sendOwner({ t: 'exit', id, ...record });
        // The table drops a forgotten entry right AFTER this callback.
        setImmediate(() => this.#checkIdle());
      },
    });
    this.#server = createServer((sock) => this.#accept(sock));
  }

  /** Take the instance lock, bind and start serving; `taken` = another pty-host has this data dir. */
  async listen(): Promise<'bound' | 'taken'> {
    this.#lock = await holdInstanceLock(this.#opts.dataDir);
    if (this.#lock === undefined) return 'taken';
    await bindSocket(this.#server, this.#opts.socketPath);
    this.#socketIno = lstatSync(this.#opts.socketPath).ino;
    this.#checkIdle();
    return 'bound';
  }

  /** Kill every PTY now, say goodbye to the owner and end the process. */
  shutdown(why: string, bye: ByeReason = 'shutdown'): void {
    if (this.#ending) return;
    this.#ending = true;
    clearTimeout(this.#idleTimer);
    clearTimeout(this.#orphanTimer);
    this.#log('info', `shutting down (${why}): killing ${this.#runningCount()} running pty(s)`);
    this.#table.shutdownAll();
    this.#closeAll(bye);
  }

  /** Unlink the socket only while it is still the one this process bound. */
  removeSocket(): void {
    try {
      if (this.#socketIno !== undefined && lstatSync(this.#opts.socketPath).ino === this.#socketIno) {
        unlinkSync(this.#opts.socketPath);
      }
    } catch {
      // Already gone, or replaced by a newer pty-host: not ours to remove.
    }
  }

  #closeAll(bye: ByeReason): void {
    const owner = this.#owner;
    if (owner !== undefined) {
      this.#owner = undefined;
      owner.role = 'gone';
      closeWith(owner.sock, encodeControl({ t: 'bye', reason: bye }));
    }
    this.#server.close();
    setImmediate(() => this.#opts.exit(bye));
  }

  #runningCount(): number {
    return this.#table.list().filter((e) => e.exit === null).length;
  }

  #accept(sock: Socket): void {
    if (this.#pending >= MAX_PENDING_CONNECTIONS) {
      if (!this.#pendingWarned) {
        this.#pendingWarned = true;
        this.#log('warn', `over ${MAX_PENDING_CONNECTIONS} connections without a hello: closing new ones at once`);
      }
      sock.destroy();
      return;
    }
    this.#pending += 1;
    const conn: Conn = { sock, reader: new FrameReader(), role: 'pending', helloTimer: undefined };
    conn.helloTimer = setTimeout(() => {
      this.#log('warn', 'connection closed: no hello within 2000ms');
      sock.destroy();
    }, HELLO_TIMEOUT_MS);
    sock.on('data', (chunk: Buffer) => {
      let frames: Frame[];
      let bad: unknown;
      try {
        frames = conn.reader.push(chunk);
      } catch (err) {
        // The good frames before the bad one are handled, then the close.
        frames = err instanceof WireError ? err.frames : [];
        bad = err;
      }
      for (const frame of frames) {
        if (sock.destroyed || conn.role === 'gone') break;
        this.#onFrame(conn, frame);
      }
      if (bad !== undefined) {
        const what = bad instanceof WireError ? bad.message : errorClass(bad);
        this.#log('warn', `connection closed: ${what}`);
        sock.destroy();
      }
    });
    sock.on('error', () => {
      // 'close' follows and does the bookkeeping.
    });
    sock.on('close', () => this.#onClose(conn));
  }

  /** The pre-hello count drops once, when the hello is answered or the socket goes. */
  #helloDone(conn: Conn): void {
    if (conn.helloTimer === undefined) return;
    clearTimeout(conn.helloTimer);
    conn.helloTimer = undefined;
    this.#pending -= 1;
    if (this.#pending < MAX_PENDING_CONNECTIONS) this.#pendingWarned = false;
  }

  #onClose(conn: Conn): void {
    this.#helloDone(conn);
    if (this.#owner === conn) this.#releaseOwner(conn, false);
  }

  /**
   * The owner seat is empty from NOW: the connection keeps no rights while
   * its socket is still being torn down. `clean` = it said `detach` (no
   * crash line); either way the orphan grace starts.
   */
  #releaseOwner(conn: Conn, clean: boolean): void {
    this.#owner = undefined;
    conn.role = 'gone';
    this.#setPaused(false);
    if (this.#ending) return;
    const grace = this.#opts.timers.orphanMs;
    if (clean) {
      this.#log('info', `owner detached; orphan grace ${grace}ms with ${this.#table.size} pty(s)`);
    } else {
      this.#log(
        'warn',
        `owner connection lost without detach (backend crash?); orphan grace ${grace}ms with ${this.#table.size} pty(s)`,
      );
    }
    clearTimeout(this.#orphanTimer);
    this.#orphanTimer = setTimeout(() => this.shutdown(`no owner for ${grace}ms`, 'orphan'), grace);
  }

  /** Say why, then destroy: no second hello is ever read from a refused connection. */
  #refuse(conn: Conn, reason: RefuseReason): void {
    this.#log('warn', `connection refused: ${reason}`);
    conn.role = 'gone';
    closeWith(conn.sock, encodeControl({ t: 'refuse', reason, proto: PTY_HOST_PROTOCOL }));
  }

  #onFrame(conn: Conn, frame: Frame): void {
    if (conn.role === 'pending') {
      this.#onHello(conn, frame);
      return;
    }
    // Owner rights are the seat, not the role a connection once had.
    const owner = conn === this.#owner;
    if (frame.kind === 'input' && owner) {
      this.#table.write(frame.id, frame.text);
      return;
    }
    const msg = frame.kind === 'control' ? parseClientMessage(frame.message) : undefined;
    if (msg === undefined) {
      this.#log('warn', `${conn.role} connection closed: an unknown or malformed frame`);
      conn.sock.destroy();
      return;
    }
    if (owner) this.#onOwner(conn, msg);
    else if (conn.role === 'probe') this.#onProbe(conn, msg);
    else conn.sock.destroy();
  }

  #onHello(conn: Conn, frame: Frame): void {
    this.#helloDone(conn);
    const hello = frame.kind === 'control' ? parseClientMessage(frame.message) : undefined;
    if (hello?.t !== 'hello') {
      this.#refuse(conn, 'bad-hello');
      return;
    }
    if (!tokenMatches(this.#opts.token, hello.token)) {
      this.#refuse(conn, 'token');
      return;
    }
    if (hello.proto !== PTY_HOST_PROTOCOL) {
      this.#refuse(conn, 'proto');
      return;
    }
    if (hello.role === 'owner') {
      const previous = this.#owner;
      if (previous !== undefined && !hello.takeover) {
        this.#refuse(conn, 'owner-busy');
        return;
      }
      if (previous !== undefined) {
        // Demoted before its goodbye is even written: a half-open old owner
        // must not spawn, type, kill or shut down a single thing more.
        this.#log('info', 'owner taken over by a new connection');
        this.#owner = undefined;
        previous.role = 'gone';
        closeWith(previous.sock, encodeControl({ t: 'bye', reason: 'taken-over' }));
      }
      clearTimeout(this.#orphanTimer);
      this.#orphanTimer = undefined;
      this.#setPaused(false);
      this.#owner = conn;
      this.#log('info', `owner attached (${this.#table.size} pty(s) held)`);
    } else {
      this.#log('debug', 'probe attached');
    }
    conn.role = hello.role;
    this.#send(conn, {
      t: 'welcome',
      proto: PTY_HOST_PROTOCOL,
      build: this.#opts.build,
      pid: process.pid,
      startedAt: this.#opts.startedAt,
    });
  }

  #onProbe(conn: Conn, msg: ClientMessage): void {
    if (msg.t === 'list-count') {
      this.#send(conn, { t: 'count', req: msg.req, total: this.#table.size, running: this.#runningCount() });
      return;
    }
    if (msg.t === 'shutdown-if-empty') {
      const empty = this.#table.size === 0;
      this.#send(conn, { t: 'emptied', req: msg.req, done: empty });
      if (empty) this.shutdown('a probe asked, no pty held');
      return;
    }
    this.#log('warn', `probe connection closed: '${msg.t}' is not a probe verb`);
    conn.sock.destroy();
  }

  #onOwner(conn: Conn, msg: ClientMessage): void {
    switch (msg.t) {
      case 'spawn': {
        const { t: _t, ...req } = msg;
        try {
          const { pid } = this.#table.spawn(req);
          clearTimeout(this.#idleTimer);
          this.#idleTimer = undefined;
          scoped(this.#log, 'pty')(
            'info',
            `${req.id} spawned pid ${pid} (${req.cols}x${req.rows}, ${req.argv.length} arg(s), ${Object.keys(req.env).length} env var(s))`,
          );
          // Written before node-pty can report a byte: its events are async.
          this.#send(conn, { t: 'spawned', id: req.id, pid });
        } catch (err) {
          // The class only: a node-pty message can quote the command line.
          const cls = errorClass(err);
          scoped(this.#log, 'pty')('warn', `${req.id} spawn failed: ${cls}`);
          this.#send(conn, { t: 'spawn-error', id: req.id, cls });
        }
        return;
      }
      case 'snapshot':
        this.#write(conn, encodeSnapshot(msg.req, this.#table.snapshot(msg.id)));
        return;
      case 'resize':
        this.#table.resize(msg.id, msg.cols, msg.rows);
        return;
      case 'kill':
        this.#table.kill(msg.id, msg.mode);
        return;
      case 'set-meta':
        try {
          this.#table.setMeta(msg.id, msg.meta);
        } catch (err) {
          this.#log('warn', `${msg.id} set-meta refused: ${errorClass(err)}`);
        }
        return;
      case 'forget':
        this.#table.forget(msg.id);
        this.#checkIdle();
        return;
      case 'list':
        this.#sendList(conn, msg.req, this.#table.list());
        return;
      case 'shutdown-all':
        this.shutdown('the owner asked');
        return;
      case 'detach':
        this.#releaseOwner(conn, true);
        conn.sock.destroy();
        return;
      default:
        this.#log('warn', `owner connection closed: '${msg.t}' is not an owner verb`);
        conn.sock.destroy();
    }
  }

  /** `list` answered in parts that each fit a frame (a meta blob is up to 16 KiB). */
  #sendList(conn: Conn, req: number, entries: PtyEntrySummary[]): void {
    const budget = MAX_FRAME_PAYLOAD - 1024;
    let part: PtyEntrySummary[] = [];
    let bytes = 0;
    for (const entry of entries) {
      const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (part.length > 0 && bytes + size > budget) {
        this.#send(conn, { t: 'list-part', req, entries: part, done: false });
        part = [];
        bytes = 0;
      }
      part.push(entry);
      bytes += size;
    }
    this.#send(conn, { t: 'list-part', req, entries: part, done: true });
  }

  #onOutput(id: string, data: string, offset: number): void {
    const owner = this.#owner;
    if (owner === undefined) return; // The ring keeps it for the next owner's snapshot.
    for (const f of encodeOutput(id, offset, data)) this.#write(owner, f);
  }

  #sendOwner(msg: HostMessage): void {
    if (this.#owner !== undefined) this.#send(this.#owner, msg);
  }

  #send(conn: Conn, msg: HostMessage): void {
    this.#write(conn, encodeControl(msg));
  }

  #write(conn: Conn, buf: Buffer): void {
    if (conn.sock.destroyed || !conn.sock.writable) return;
    conn.sock.write(buf);
    if (conn === this.#owner && !this.#paused && conn.sock.writableLength > PAUSE_BACKLOG_BYTES) {
      this.#setPaused(true);
      conn.sock.once('drain', () => {
        if (this.#owner === conn) this.#setPaused(false);
      });
    }
  }

  #setPaused(paused: boolean): void {
    if (this.#paused === paused) return;
    this.#paused = paused;
    this.#table.setPaused(paused);
    if (paused) {
      this.#pauses += 1;
      this.#pausedAt = performance.now();
      this.#log('info', `owner backlog over ${PAUSE_BACKLOG_BYTES} bytes: paused every pty (pause #${this.#pauses})`);
    } else {
      const ms = Math.round(performance.now() - this.#pausedAt);
      this.#log('info', `resumed every pty after ${ms}ms (pause #${this.#pauses})`);
    }
  }

  /** Zero entries arms the idle exit; any entry disarms it. */
  #checkIdle(): void {
    if (this.#ending) return;
    if (this.#table.size > 0) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
      return;
    }
    if (this.#idleTimer !== undefined) return;
    const ms = this.#opts.timers.idleMs;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      if (this.#table.size === 0) this.shutdown(`no pty for ${ms}ms`, 'idle');
    }, ms);
  }
}
