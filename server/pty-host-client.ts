/**
 * The backend's side of the pty-host: a `PtyHost` (server/pty-host-api.ts)
 * over the socket, the probe connection, and the helpers that find, start and
 * connect to one data dir's pty-host process (server/pty-host-main.ts).
 *
 * Nocturne D9 P2 (.claude/plans/nocturne/PLAN-D9.md § Defaults, § Risks).
 * Wired in P3 through server/pty-host-broker.ts: the backend connects as owner
 * at boot, starts a pty-host lazily on the first spawn when none answers, and
 * reacts to `onLost`. One of four flat pieces: the process is server/pty-host-main.ts +
 * server/pty-host-server.ts, the shared wire server/pty-host-wire.ts.
 *
 * Nothing is read or connected before `connectRefusal` passed: the data dir
 * (ours, 0700, a real dir), the socket (a socket of ours) and `pty-host.json`
 * (a regular file of ours, 0600 — it holds the token).
 *
 * The ordering promise (§ Risks, P1 review): an `exit` for a session must
 * never reach the owner before the continuation of its `await spawn()` has
 * run, or `markEnded` would run before `recordCreate`. The host writes
 * `spawned` before node-pty can report anything, and this client, after
 * resolving a spawn, holds every later frame until a macrotask later
 * (`setImmediate` runs after every microtask, so the awaiting function's
 * synchronous continuation is done).
 *
 * Events that arrive before `listen()` (with the welcome, or any time before
 * the owner registers) are kept and delivered in order by `listen()`.
 *
 * A spawn still unanswered at a shutdown or a restart's detach is the
 * manager's to end (server/sessions.ts `destroyAll`/`detachAll`): its `kill`
 * follows the `spawn` on the wire, so the host has the PTY when the kill
 * arrives, and no PTY is handed to the next backend without a history entry.
 */
import { spawn as spawnChild } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PtyHost, PtyHostLostReason } from './pty-host-api.ts';
import {
  assertMetaSize,
  type PtyEntrySummary,
  type PtyEvents,
  type PtySnapshot,
  type PtySpawned,
  type PtySpawnRequest,
} from './pty-table.ts';
import {
  PTY_HOST_EXIT,
  PTY_HOST_PROTOCOL,
  FrameReader,
  WireError,
  connectRefusal,
  dataDirRefusal,
  encodeControl,
  encodeInput,
  isSessionUuid,
  parseHostMessage,
  ptyHostPaths,
  readPtyHostFile,
  type ByeReason,
  type ClientMessage,
  type Frame,
  type HostMessage,
  type PtyHostFile,
  type PtyHostRole,
  type RefuseReason,
  type Welcome,
} from './pty-host-wire.ts';

/** How long a connect + hello may take before the attempt is given up (D9: 2 s). */
const CONNECT_TIMEOUT_MS = 2000;
/** How long a started pty-host may take to write its state file. */
const START_TIMEOUT_MS = 10_000;
const START_POLL_MS = 25;
/**
 * After our child exited 3 (another pty-host holds the lock): how long that
 * one may take to publish its state file. It holds the lock before it binds
 * and writes the file a few ms later, so 2 s is generous; a holder that never
 * publishes (a hung start, a lock squatted somehow) fails the start fast
 * instead of stalling the caller for the whole START_TIMEOUT_MS.
 */
const OTHER_INSTANCE_WAIT_MS = 2000;

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

/** The host said no: a wrong token or protocol, or the owner seat is taken. */
export class PtyHostRefusal extends Error {
  readonly reason: RefuseReason;
  /** The protocol the host speaks: logged by the broker's incompatible paths (boot, the standby's probe). */
  readonly hostProto: number;

  constructor(reason: RefuseReason, hostProto: number) {
    super(`the pty-host refused the connection (${reason})`);
    this.reason = reason;
    this.hostProto = hostProto;
  }
}

/**
 * Which PtyHost the backend uses. `AI_SM_PTY_HOST=inproc` is a TEST seam
 * (the PTYs stay in the backend, as before D9) and is refused in the
 * installed app, where it would silently take session survival away.
 */
export function resolvePtyHostMode(
  installed: boolean,
  env: NodeJS.ProcessEnv = process.env,
): 'socket' | 'inproc' {
  const raw = env['AI_SM_PTY_HOST'];
  if (raw === undefined || raw === '') return 'socket';
  if (raw !== 'inproc') throw new Error(`AI_SM_PTY_HOST must be 'inproc' or unset, got ${JSON.stringify(raw.slice(0, 32))}`);
  if (installed) throw new Error('AI_SM_PTY_HOST=inproc is a test seam and is refused in the installed app');
  return 'inproc';
}

/** A process with this pid exists (EPERM: it does, it is not ours to signal). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface StartPtyHostOptions {
  dataDir: string;
  /** The backend's build id (bundle version or commit), reported back in `welcome`. */
  build: string;
  /** Where `pty-host-main.ts` lives; default this module's own directory. */
  serverDir?: string;
  timeoutMs?: number;
}

/**
 * Start a pty-host for the data dir, detached (its own session, no stdio, not
 * waited for), and resolve with its state file once it is listening.
 * When another pty-host holds the data dir (it may be starting at the same
 * moment — the instance lock decides), resolves with that one's file.
 * Rejects with a sentence when the data dir is refused (checked here first, so
 * the reason reaches the caller's log) or the child dies before it is ready.
 */
export async function startPtyHost(opts: StartPtyHostOptions): Promise<PtyHostFile> {
  const refusal = dataDirRefusal(opts.dataDir);
  if (refusal !== undefined) throw new Error(refusal);
  const entry = join(opts.serverDir ?? SERVER_DIR, 'pty-host-main.ts');
  const child = spawnChild(process.execPath, [entry, opts.dataDir], {
    detached: true,
    stdio: 'ignore',
    cwd: opts.dataDir,
    env: { ...process.env, AI_SM_PTY_HOST_BUILD: opts.build },
  });
  let exitCode: number | null | undefined;
  let spawnError: Error | undefined;
  child.once('exit', (code) => {
    exitCode = code;
  });
  child.once('error', (err) => {
    spawnError = err;
  });
  child.unref();
  const deadline = performance.now() + (opts.timeoutMs ?? START_TIMEOUT_MS);
  let otherSince: number | undefined;
  for (;;) {
    const file = readPtyHostFile(opts.dataDir);
    if (file !== undefined && file.pid === child.pid) return file;
    if (spawnError !== undefined) throw new Error(`the pty-host could not be started: ${spawnError.message}`);
    if (exitCode === PTY_HOST_EXIT.otherInstance) {
      // Another pty-host holds the data dir; it may still be starting, so
      // its state file is waited for — briefly (OTHER_INSTANCE_WAIT_MS).
      if (file !== undefined && pidAlive(file.pid)) return file;
      otherSince ??= performance.now();
      if (performance.now() - otherSince > OTHER_INSTANCE_WAIT_MS) {
        throw new Error('another pty-host holds this data dir but published no state file');
      }
    } else if (exitCode !== undefined) {
      throw new Error(`the pty-host exited with code ${exitCode} before it was ready`);
    }
    if (performance.now() > deadline) throw new Error('the pty-host did not become ready in time');
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
  }
}

/** A connection that has said hello and got its welcome. */
interface Opened {
  sock: Socket;
  reader: FrameReader;
  welcome: Welcome;
  /** Frames that arrived in the same chunk as the welcome. */
  rest: Frame[];
}

function openConnection(
  dataDir: string,
  role: PtyHostRole,
  takeover: boolean,
  timeoutMs: number,
): Promise<Opened> {
  // Before a byte of the state file (it holds the token) is read or the
  // socket is touched: the dir, the socket and the file must be ours.
  const refusal = connectRefusal(dataDir);
  if (refusal !== undefined) return Promise.reject(new Error(refusal));
  const file = readPtyHostFile(dataDir);
  if (file === undefined) return Promise.reject(new Error('The pty-host state file is not readable.'));
  return new Promise((resolve, reject) => {
    const sock = connect(ptyHostPaths(dataDir).socket);
    const reader = new FrameReader();
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error('the pty-host did not answer in time')), timeoutMs);
    sock.once('connect', () => {
      const hello: ClientMessage = { t: 'hello', proto: PTY_HOST_PROTOCOL, token: file.token, role, takeover };
      sock.write(encodeControl(hello));
    });
    sock.on('error', (err) => fail(err));
    sock.on('close', () => fail(new Error('the pty-host closed the connection during the handshake')));
    const onData = (chunk: Buffer): void => {
      let frames: Frame[];
      try {
        frames = reader.push(chunk);
      } catch (err) {
        fail(err instanceof Error ? err : new WireError(String(err)));
        return;
      }
      const first = frames[0];
      if (first === undefined) return;
      const msg = first.kind === 'control' ? parseHostMessage(first.message) : undefined;
      if (msg?.t === 'refuse') {
        fail(new PtyHostRefusal(msg.reason, msg.proto));
        return;
      }
      if (msg?.t !== 'welcome') {
        fail(new Error('the pty-host answered the hello with something else'));
        return;
      }
      settled = true;
      clearTimeout(timer);
      sock.off('data', onData);
      sock.removeAllListeners('close');
      sock.removeAllListeners('error');
      const { t: _t, ...welcome } = msg;
      resolve({ sock, reader, welcome, rest: frames.slice(1) });
    };
    sock.on('data', onData);
  });
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

/** Connect as the OWNER; `takeover` replaces a previous owner. */
export async function connectPtyHost(opts: {
  dataDir: string;
  takeover: boolean;
  timeoutMs?: number;
}): Promise<SocketPtyHost> {
  const opened = await openConnection(opts.dataDir, 'owner', opts.takeover, opts.timeoutMs ?? CONNECT_TIMEOUT_MS);
  return new SocketPtyHost(opened);
}

/** Connect as a PROBE (P4's standby preflight, the launcher's stop). */
export async function probePtyHost(opts: { dataDir: string; timeoutMs?: number }): Promise<PtyHostProbe> {
  const opened = await openConnection(opts.dataDir, 'probe', false, opts.timeoutMs ?? CONNECT_TIMEOUT_MS);
  return new PtyHostProbe(opened);
}

/** The owner connection, as the `PtyHost` the SessionManager talks to. */
export class SocketPtyHost implements PtyHost {
  readonly welcome: Welcome;
  readonly #sock: Socket;
  readonly #reader: FrameReader;
  #events: PtyEvents | undefined;
  readonly #lostListeners: ((reason: PtyHostLostReason) => void)[] = [];
  readonly #spawns = new Map<string, Waiter<PtySpawned>>();
  readonly #snapshots = new Map<number, Waiter<PtySnapshot | undefined>>();
  readonly #lists = new Map<number, Waiter<PtyEntrySummary[]> & { entries: PtyEntrySummary[] }>();
  #nextReq = 1;
  /** Frames held back after a `spawned` until its continuation ran. */
  #held: Frame[] | undefined;
  /**
   * Output and exit events that arrived before `listen()` — in the very read
   * that carried the `welcome`, or any time before the owner registered. The
   * host makes a connection its owner BEFORE it writes the welcome, so a busy
   * PTY's first bytes after a re-attach land exactly here (D9 P2 test gate).
   * Delivered in order by `listen()`; replies (spawned, snapshot, list, bye)
   * never wait here, so a spawn awaited before `listen()` still settles.
   */
  #early: (() => void)[] | undefined = [];
  #bye: ByeReason | undefined;
  #detached = false;
  #closed = false;

  constructor(opened: Opened) {
    this.welcome = opened.welcome;
    this.#sock = opened.sock;
    this.#reader = opened.reader;
    this.#sock.on('data', (chunk: Buffer) => {
      let frames: Frame[];
      let bad = false;
      try {
        frames = this.#reader.push(chunk);
      } catch (err) {
        // What came before the bad frame is delivered, then the close.
        frames = err instanceof WireError ? err.frames : [];
        bad = true;
      }
      for (const f of frames) this.#dispatch(f);
      if (bad) this.#sock.destroy();
    });
    this.#sock.on('error', () => {
      // 'close' follows.
    });
    this.#sock.on('close', () => this.#onClose());
    for (const f of opened.rest) this.#dispatch(f);
  }

  listen(events: PtyEvents): void {
    this.#events = events;
    const early = this.#early ?? [];
    this.#early = undefined;
    for (const deliver of early) deliver();
  }

  /** Hand an event to the owner now, or keep it for `listen()`. */
  #emit(deliver: (events: PtyEvents) => void): void {
    if (this.#early !== undefined) {
      this.#early.push(() => {
        if (this.#events !== undefined) deliver(this.#events);
      });
      return;
    }
    if (this.#events !== undefined) deliver(this.#events);
  }

  onLost(listener: (reason: PtyHostLostReason) => void): void {
    this.#lostListeners.push(listener);
  }

  /** The connection is gone (lost, detached or shut down): every request now rejects. */
  get closed(): boolean {
    return this.#closed;
  }

  spawn(req: PtySpawnRequest): Promise<PtySpawned> {
    if (!isSessionUuid(req.id)) return Promise.reject(new RangeError('a pty-host session id must be a lowercase uuid'));
    if (this.#closed) return Promise.reject(new Error('the pty-host connection is closed'));
    if (this.#spawns.has(req.id)) return Promise.reject(new Error(`pty ${req.id} is already being spawned`));
    let frame: Buffer;
    try {
      if (req.meta !== undefined) assertMetaSize(req.meta);
      frame = encodeControl({ t: 'spawn', ...req });
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return new Promise((resolve, reject) => {
      this.#spawns.set(req.id, { resolve, reject });
      this.#sock.write(frame);
    });
  }

  write(id: string, data: string): void {
    if (this.#closed || !isSessionUuid(id)) return;
    for (const f of encodeInput(id, data)) this.#sock.write(f);
  }

  resize(id: string, cols: number, rows: number): void {
    this.#control({ t: 'resize', id, cols, rows });
  }

  kill(id: string, mode: 'ladder' | 'now'): void {
    this.#control({ t: 'kill', id, mode });
  }

  snapshot(id: string): Promise<PtySnapshot | undefined> {
    // The wire cannot carry another id shape: `#control` would drop the
    // request and the promise would never settle.
    if (!isSessionUuid(id)) return Promise.reject(new RangeError('a pty-host session id must be a lowercase uuid'));
    if (this.#closed) return Promise.reject(new Error('the pty-host connection is closed'));
    const req = this.#req();
    return new Promise((resolve, reject) => {
      this.#snapshots.set(req, { resolve, reject });
      this.#control({ t: 'snapshot', req, id });
    });
  }

  /** Checked HERE: `set-meta` has no reply, so an over-cap blob must throw at the caller. */
  setMeta(id: string, meta: string): void {
    assertMetaSize(meta);
    this.#control({ t: 'set-meta', id, meta });
  }

  list(): Promise<PtyEntrySummary[]> {
    if (this.#closed) return Promise.reject(new Error('the pty-host connection is closed'));
    const req = this.#req();
    return new Promise((resolve, reject) => {
      this.#lists.set(req, { resolve, reject, entries: [] });
      this.#control({ t: 'list', req });
    });
  }

  forget(id: string): void {
    this.#control({ t: 'forget', id });
  }

  /**
   * The host kills every PTY now and exits (today's backend-shutdown
   * semantics). Our side is ended after the frame (D9 P3): nothing follows a
   * shutdown, and `flushed()` can then tell a caller about to `process.exit`
   * that the frame has left this process.
   */
  shutdownAll(): void {
    this.#control({ t: 'shutdown-all' });
    if (!this.#closed) this.#sock.end();
  }

  /**
   * Resolves once everything written so far has left this process: the
   * socket's writable side finished (after `shutdownAll`'s end) or the socket
   * is gone. The backend awaits it, bounded, before `process.exit` (P2 note:
   * a frame still queued in user space dies with the process).
   */
  flushed(): Promise<void> {
    if (this.#closed || this.#sock.writableFinished || this.#sock.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      this.#sock.once('finish', () => resolve());
      this.#sock.once('close', () => resolve());
    });
  }

  /** Clean goodbye: the PTYs keep running for the next owner (orphan grace); no `onLost`. */
  detach(): void {
    if (this.#closed) return;
    this.#detached = true;
    this.#control({ t: 'detach' });
    this.#sock.end();
  }

  #req(): number {
    const req = this.#nextReq;
    this.#nextReq = req >= 0xffffffff ? 1 : req + 1;
    return req;
  }

  /** Commands whose id the wire cannot carry are dropped, as the table drops unknown ids. */
  #control(msg: ClientMessage): void {
    if (this.#closed) return;
    if ('id' in msg && !isSessionUuid(msg.id)) return;
    this.#sock.write(encodeControl(msg));
  }

  #dispatch(frame: Frame): void {
    if (this.#held !== undefined) {
      this.#held.push(frame);
      return;
    }
    this.#handle(frame);
  }

  #handle(frame: Frame): void {
    if (frame.kind === 'output') {
      const { id, text, offset, bytes } = frame;
      this.#emit((e) => e.output(id, text, offset, bytes));
      return;
    }
    if (frame.kind === 'snapshot') {
      const waiter = this.#snapshots.get(frame.req);
      this.#snapshots.delete(frame.req);
      waiter?.resolve(frame.snapshot);
      return;
    }
    const msg = frame.kind === 'control' ? parseHostMessage(frame.message) : undefined;
    if (msg === undefined) {
      this.#sock.destroy();
      return;
    }
    this.#onMessage(msg);
  }

  #onMessage(msg: HostMessage): void {
    switch (msg.t) {
      case 'spawned':
      case 'spawn-error': {
        const waiter = this.#spawns.get(msg.id);
        this.#spawns.delete(msg.id);
        if (msg.t === 'spawn-error') {
          waiter?.reject(new Error(`the pty could not be spawned (${msg.cls})`));
          return;
        }
        waiter?.resolve({ pid: msg.pid });
        this.#holdUntilContinuation();
        return;
      }
      case 'exit': {
        const { t: _t, id, ...record } = msg;
        this.#emit((e) => e.exit(id, record));
        return;
      }
      case 'list-part': {
        const waiter = this.#lists.get(msg.req);
        if (waiter === undefined) return;
        waiter.entries.push(...msg.entries);
        if (msg.done) {
          this.#lists.delete(msg.req);
          waiter.resolve(waiter.entries);
        }
        return;
      }
      case 'bye':
        this.#bye = msg.reason;
        return;
      default:
        // welcome/refuse/count/emptied are not for an owner past its handshake.
        this.#sock.destroy();
    }
  }

  #holdUntilContinuation(): void {
    if (this.#held !== undefined) return;
    this.#held = [];
    setImmediate(() => this.#release());
  }

  /**
   * Handle the held frames in order. By index, not `shift()` (O(n²) on a
   * burst), and a re-hold is joined with `concat`, never `unshift(...held)`,
   * whose spread overflows the stack on a large batch (PLAN-QUALITY Q12).
   */
  #release(): void {
    const held = this.#held ?? [];
    this.#held = undefined;
    for (let i = 0; i < held.length; i++) {
      const again = this.#holding();
      if (again !== undefined) {
        // A `spawned` among the held frames started a new hold: what is left
        // of this batch still goes before anything received after it.
        this.#held = held.slice(i).concat(again);
        return;
      }
      this.#handle(held[i] as Frame);
    }
  }

  /** Read through a method: a `#handle` call can start a new hold. */
  #holding(): Frame[] | undefined {
    return this.#held;
  }

  #onClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    const err = new Error('the pty-host connection closed');
    for (const w of this.#spawns.values()) w.reject(err);
    for (const w of this.#snapshots.values()) w.reject(err);
    for (const w of this.#lists.values()) w.reject(err);
    this.#spawns.clear();
    this.#snapshots.clear();
    this.#lists.clear();
    if (this.#detached) return;
    const reason: PtyHostLostReason = this.#bye ?? 'closed';
    // After the held frames: an exit already received is delivered first.
    setImmediate(() => {
      for (const listener of this.#lostListeners) listener(reason);
    });
  }
}

/** A probe connection: may only count and ask an empty host to leave. */
class PtyHostProbe {
  readonly welcome: Welcome;
  readonly #sock: Socket;
  readonly #waiters = new Map<number, Waiter<HostMessage>>();
  #nextReq = 1;

  constructor(opened: Opened) {
    this.welcome = opened.welcome;
    this.#sock = opened.sock;
    const reader = opened.reader;
    const onFrames = (frames: Frame[]): void => {
      for (const f of frames) {
        const msg = f.kind === 'control' ? parseHostMessage(f.message) : undefined;
        if (msg === undefined || !('req' in msg)) continue;
        const waiter = this.#waiters.get(msg.req);
        this.#waiters.delete(msg.req);
        waiter?.resolve(msg);
      }
    };
    this.#sock.on('data', (chunk: Buffer) => {
      try {
        onFrames(reader.push(chunk));
      } catch (err) {
        if (err instanceof WireError) onFrames(err.frames);
        this.#sock.destroy();
      }
    });
    this.#sock.on('error', () => {
      // 'close' follows.
    });
    this.#sock.on('close', () => {
      const err = new Error('the pty-host connection closed');
      for (const w of this.#waiters.values()) w.reject(err);
      this.#waiters.clear();
    });
    onFrames(opened.rest);
  }

  /** How many entries the host holds, and how many of them still run. */
  async listCount(): Promise<{ total: number; running: number }> {
    const msg = await this.#ask((req) => ({ t: 'list-count', req }));
    if (msg.t !== 'count') throw new Error('the pty-host answered list-count with something else');
    return { total: msg.total, running: msg.running };
  }

  /** True when the host held nothing and is now exiting. */
  async shutdownIfEmpty(): Promise<boolean> {
    const msg = await this.#ask((req) => ({ t: 'shutdown-if-empty', req }));
    if (msg.t !== 'emptied') throw new Error('the pty-host answered shutdown-if-empty with something else');
    return msg.done;
  }

  close(): void {
    this.#sock.destroy();
  }

  #ask(make: (req: number) => ClientMessage): Promise<HostMessage> {
    const req = this.#nextReq++;
    return new Promise((resolve, reject) => {
      if (this.#sock.destroyed) {
        reject(new Error('the pty-host connection is closed'));
        return;
      }
      this.#waiters.set(req, { resolve, reject });
      this.#sock.write(encodeControl(make(req)));
    });
  }
}
