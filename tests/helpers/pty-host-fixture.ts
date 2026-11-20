/**
 * Shared fixture for the pty-host tests of Nocturne D9 P2
 * (`.claude/plans/nocturne/PLAN-D9.md` § Phases):
 * `tests/server/pty-host-*.test.ts`. A real pty-host child
 * (`server/pty-host-main.ts`) on a temp data dir (0700), a raw wire
 * connection for the tests that must send what the client never would, and
 * the bookkeeping that ends every process a test started.
 *
 * Every pty-host started here is detached (its own process group, as the
 * backend starts it) and registered by PID; `teardownHosts()` SIGKILLs every
 * one still alive, and the process GROUP of every PTY a test tracked (a
 * SIGHUP-ignoring child outlives its host's SIGKILL). Never by name.
 *
 * `startFakeHost`: a scripted stand-in on a real socket, for the client's
 * own rules (tests/server/pty-host-client.test.ts).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  FrameReader,
  PTY_HOST_PROTOCOL,
  encodeControl,
  parseHostMessage,
  ptyHostPaths,
  readPtyHostFile,
  type ClientMessage,
  type Frame,
  type HostMessage,
  type PtyHostFile,
} from '../../server/pty-host-wire.ts';
import { makeTempDir, projectRoot, removeTempDir, waitUntil } from './helpers.ts';

/** The real entry, as the backend starts it. */
export const HOST_ENTRY = join(projectRoot, 'server', 'pty-host-main.ts');

/** This process's environment with the unset entries dropped — what a spawn carries. */
export const ENV: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
);

/**
 * Lifetimes for a host that must not leave on its own during a test: the
 * fixture ends it. A test about the idle exit or the orphan grace passes its
 * own short values.
 */
export const STAY_ENV = { AI_SM_PTY_HOST_IDLE_MS: '120000', AI_SM_PTY_HOST_ORPHAN_MS: '120000' };

const tempDirs: string[] = [];
const hostPids = new Set<number>();
const ptyGroups = new Set<number>();

/** A fresh data dir, 0700, real path (the socket path is measured on it). */
export async function makeHostDir(prefix = 'pty-host-'): Promise<string> {
  const dir = realpathSync(await makeTempDir(prefix));
  await chmod(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}

export interface HostProc {
  child: ChildProcess;
  pid: number;
  dataDir: string;
  /** Resolves with the exit code once the process is gone. */
  exited: Promise<number | null>;
  stderr: () => string;
}

/** Start a pty-host child; it is ended by `teardownHosts()` whatever happens. */
export function spawnHost(
  dataDir: string,
  env: Record<string, string> = STAY_ENV,
  entry: string = HOST_ENTRY,
): HostProc {
  const child = spawn(process.execPath, [entry, dataDir], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    cwd: dataDir,
    env: { ...process.env, ...env },
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error('the pty-host child has no pid');
  hostPids.add(pid);
  let err = '';
  child.stderr?.on('data', (c: Buffer) => {
    err += c.toString('utf8');
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      hostPids.delete(pid);
      resolve(code);
    });
  });
  return { child, pid, dataDir, exited, stderr: () => err };
}

/** The host's state file once it names this process (it is listening then). */
export function hostReady(h: HostProc): Promise<PtyHostFile> {
  return waitUntil(() => {
    const file = readPtyHostFile(h.dataDir);
    return file?.pid === h.pid ? file : undefined;
  }, `pty-host ${h.pid} to write its state file (stderr: ${h.stderr()})`);
}

/** A started and listening pty-host on a fresh data dir. */
export async function startHost(env: Record<string, string> = STAY_ENV): Promise<HostProc & { file: PtyHostFile }> {
  const h = spawnHost(await makeHostDir(), env);
  return { ...h, file: await hostReady(h) };
}

/** A pty-host this test started some other way (`startPtyHost`): SIGKILLed at teardown. */
export function trackHost(pid: number): void {
  hostPids.add(pid);
}

/** Kill this PTY's process group at teardown if a test did not prove it gone. */
export function trackPty(pid: number): void {
  ptyGroups.add(pid);
}

export function hostLog(dataDir: string): string {
  try {
    return readFileSync(ptyHostPaths(dataDir).log, 'utf8');
  } catch {
    return '';
  }
}

/** SIGKILL every host and PTY group still alive, then remove the temp dirs. Call in `after`. */
export async function teardownHosts(): Promise<void> {
  // A host started through `startPtyHost` by a test that failed before its
  // `trackHost` (a start that timed out, a starter child that never printed
  // the pid) is still named by the state file in OUR temp data dir — a pid
  // only a test of this file can have started there.
  for (const dir of tempDirs) {
    const pid = readPtyHostFile(dir)?.pid;
    // A fake host's state file names THIS process (startFakeHost): never that.
    if (pid !== undefined && pid !== process.pid) hostPids.add(pid);
  }
  for (const pid of hostPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const pid of ptyGroups) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // Already gone, which is what the test asserted.
      }
    }
  }
  for (const dir of tempDirs.splice(0)) await removeTempDir(dir);
}

/**
 * A wire connection driven by hand: it sends exactly what a test says (an
 * oversize header, a probe asking an owner verb) and records every frame and
 * the close.
 */
export class RawConn {
  readonly sock: Socket;
  readonly frames: Frame[] = [];
  closed = false;
  readonly #reader = new FrameReader();

  /**
   * `halfOpen`: keep writing after the host has ended its side — the peer a
   * demoted owner could be (a well-behaved client closes on the host's FIN).
   */
  constructor(dataDir: string, halfOpen = false) {
    this.sock = connect({ path: ptyHostPaths(dataDir).socket, allowHalfOpen: halfOpen });
    this.sock.on('data', (chunk: Buffer) => {
      try {
        this.frames.push(...this.#reader.push(chunk));
      } catch {
        this.sock.destroy();
      }
    });
    this.sock.on('error', () => {
      // 'close' follows.
    });
    // 'end': the host closed its side — all a half-open peer ever sees.
    for (const event of ['end', 'close']) {
      this.sock.on(event, () => {
        this.closed = true;
      });
    }
  }

  send(msg: ClientMessage): void {
    this.sock.write(encodeControl(msg));
  }

  hello(token: string, role: 'owner' | 'probe' = 'owner', takeover = false, proto = PTY_HOST_PROTOCOL): void {
    this.send({ t: 'hello', proto, token, role, takeover });
  }

  /** The control messages received so far, parsed. */
  messages(): HostMessage[] {
    return this.frames.flatMap((f) => {
      const m = f.kind === 'control' ? parseHostMessage(f.message) : undefined;
      return m === undefined ? [] : [m];
    });
  }

  message<T extends HostMessage['t']>(t: T, what = t): Promise<Extract<HostMessage, { t: T }>> {
    return waitUntil(
      () => this.messages().find((m): m is Extract<HostMessage, { t: T }> => m.t === t),
      `a '${what}' message`,
    );
  }

  closedSoon(timeoutMs = 15_000): Promise<true> {
    return waitUntil(() => (this.closed ? true : undefined), 'the host to close the connection', timeoutMs);
  }

  close(): void {
    this.sock.destroy();
  }
}

/** What a stand-in host answers a hello with. */
export function fakeWelcome(): Buffer {
  return encodeControl({ t: 'welcome', proto: PTY_HOST_PROTOCOL, build: 'fake', pid: process.pid, startedAt: new Date(0).toISOString() });
}

export interface FakeHost {
  dataDir: string;
  /** The control messages received, in order, as `t` names (input frames as `input`). */
  received: string[];
  stop(): Promise<void>;
}

/**
 * A stand-in pty-host for the CLIENT's own rules (server/pty-host-client.ts):
 * a real socket and a real 0600 `pty-host.json` in a 0700 data dir, so the
 * client's checks pass, but every answer is what the test's `onFrame` writes —
 * including what a real host never sends (a frame in the same write as the
 * welcome, a reply the owner cannot use, a hello left unanswered). It checks
 * no token. Stop it in `finally`.
 */
export async function startFakeHost(onFrame: (sock: Socket, frame: Frame) => void): Promise<FakeHost> {
  const dataDir = await makeHostDir('pty-fake-');
  const received: string[] = [];
  const socks = new Set<Socket>();
  const server = createServer((sock) => {
    socks.add(sock);
    sock.on('close', () => socks.delete(sock));
    sock.on('error', () => {
      // 'close' follows.
    });
    const reader = new FrameReader();
    sock.on('data', (chunk: Buffer) => {
      for (const f of reader.push(chunk)) {
        received.push(f.kind === 'control' ? String((f.message as { t?: unknown }).t) : f.kind);
        onFrame(sock, f);
      }
    });
  });
  const paths = ptyHostPaths(dataDir);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.socket, () => resolve());
  });
  const state = { pid: process.pid, startedAt: new Date(0).toISOString(), proto: PTY_HOST_PROTOCOL, build: 'fake', appDir: '/', token: 'fake-token' };
  writeFileSync(paths.stateFile, JSON.stringify(state), { mode: 0o600 });
  return {
    dataDir,
    received,
    stop: async () => {
      for (const s of socks) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
