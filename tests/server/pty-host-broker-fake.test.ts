/**
 * The backend's pty-host broker against a SCRIPTED pty-host — server/pty-host-broker.ts,
 * Nocturne D9 P3 (`.claude/plans/nocturne/PLAN-D9.md` § Defaults, decision 27):
 * the two broker rules a real pty-host cannot be made to hit on cue —
 *   - an incompatible pty-host is ended by the pid in its state file ONLY when
 *     /proc/<pid>/cmdline proves that pid is this data dir's pty-host-main; a
 *     stale file's pid may belong to anything by now, and is left alone;
 *   - a spawn that meets a host leaving idle (`bye idle` raced the spawn) is
 *     retried once on a new host instead of failing the launch.
 *
 * How: the real broker in this process over `startFakeHost`
 * (tests/helpers/pty-host-fixture.ts) — a real socket and 0600 state file
 * whose answers the test writes. The pid the state file names is a decoy
 * child this file spawns (`node -e` with the argv under test, so its
 * /proc cmdline is exactly that) and ends in `finally`; never this process.
 * The retry's new host is a real pty-host the broker starts, tracked and
 * ended in `after`.
 *
 * Why it matters: a SIGTERM by an unchecked pid could end any process of this
 * user; a launch that fails because the idle host left in that instant is a
 * "could not start the session" the user did nothing to cause.
 *
 * NOT claimed: a real incompatible pty-host being ended with its sessions
 * (`pty-host-boot.test.ts`), the host's own idle rule (`pty-host-lifetime.test.ts`).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { PtyHostBroker } from '../../server/pty-host-broker.ts';
import { SessionHistory } from '../../server/history.ts';
import { SessionManager } from '../../server/sessions.ts';
import type { Logger } from '../../server/config.ts';
import { encodeControl, PTY_HOST_PROTOCOL, ptyHostPaths, type Frame } from '../../server/pty-host-wire.ts';
import { waitUntil } from '../helpers/helpers.ts';
import { fakeWelcome, startFakeHost, teardownHosts, trackHost } from '../helpers/pty-host-fixture.ts';
import { hostPidOf, pidAlive } from '../helpers/pty-host-backend-fixture.ts';

after(async () => {
  await teardownHosts();
});

function lineLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { lines, log: (level, msg) => void lines.push(`${level} ${msg}`) };
}

/** A process that idles with exactly this argv after `node -e <script>`; ended by the caller. */
function decoy(args: string[]): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', ...args], { stdio: 'ignore' });
}

/** Point the fake host's state file at `pid` (the file stays valid: 0600, the shape the reader accepts). */
function stateNames(dataDir: string, pid: number): void {
  const state = { pid, startedAt: new Date(0).toISOString(), proto: PTY_HOST_PROTOCOL, build: 'fake', appDir: '/', token: 'fake-token' };
  writeFileSync(ptyHostPaths(dataDir).stateFile, JSON.stringify(state), { mode: 0o600 });
}

function refuseEveryHello(sock: Socket, f: Frame): void {
  if (f.kind === 'control' && (f.message as { t?: unknown }).t === 'hello') {
    sock.write(encodeControl({ t: 'refuse', reason: 'proto', proto: PTY_HOST_PROTOCOL + 1 }));
  }
}

/**
 * How long a decoy is watched for a SIGTERM that must NOT come: the broker
 * has already returned from its boot connect by then (it signals before it
 * returns), so this only covers a signal's delivery — generous for that.
 */
const NO_SIGNAL_MS = 300;

test('a refusing pty-host whose state-file pid is not a pty-host-main of this data dir is left alone', async () => {
  const fake = await startFakeHost(refuseEveryHello);
  const decoys = [
    { what: 'an unrelated process', child: decoy([]) },
    { what: "another data dir's pty-host", child: decoy(['/home/you/app/server/pty-host-main.ts', '/home/you/other-data']) },
  ];
  try {
    for (const { what, child } of decoys) {
      const pid = child.pid as number;
      await waitUntil(() => (pidAlive(pid) ? true : undefined), `${what} to start`);
      stateNames(fake.dataDir, pid);
      const { log, lines } = lineLog();
      const broker = new PtyHostBroker({ mode: 'socket', dataDir: fake.dataDir, build: 'test-build', log });
      assert.deepEqual(await broker.connectExisting(), [], `${what}: nothing to adopt`);
      broker.release();
      const exited = new Promise<boolean>((resolve) => {
        child.once('exit', () => resolve(true));
        setTimeout(() => resolve(false), NO_SIGNAL_MS);
      });
      assert.equal(await exited, false, `${what}: never signalled`);
      assert.ok(
        lines.includes('warn [pty-host] a pty-host refused this backend (proto) and could not be identified; leaving it'),
        `${what}: ${lines.join(' | ')}`,
      );
    }
  } finally {
    for (const { child } of decoys) child.kill('SIGKILL');
    await fake.stop();
  }
});

test("a refusing pty-host whose state-file pid IS this data dir's pty-host-main is sent SIGTERM", async () => {
  const fake = await startFakeHost(refuseEveryHello);
  const child = decoy(['/home/you/app/server/pty-host-main.ts', fake.dataDir]);
  try {
    const pid = child.pid as number;
    await waitUntil(() => (pidAlive(pid) ? true : undefined), 'the decoy to start');
    stateNames(fake.dataDir, pid);
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
    const { log, lines } = lineLog();
    const broker = new PtyHostBroker({ mode: 'socket', dataDir: fake.dataDir, build: 'test-build', log });
    assert.deepEqual(await broker.connectExisting(), []);
    assert.equal(pidAlive(pid), false, 'the boot waited for it to be gone before going on');
    assert.equal(await exited, 'SIGTERM', 'the identified holder was ended');
    assert.ok(lines.some((l) => l.includes(`an incompatible pty-host (pid ${pid}, protocol ${PTY_HOST_PROTOCOL + 1}, refused: proto)`)), lines.join(' | '));
  } finally {
    child.kill('SIGKILL');
    await fake.stop();
  }
});

test('a spawn that meets a pty-host leaving idle is retried once on a new one, and the launch succeeds', async () => {
  // The fake welcomes, lists nothing, and answers the first spawn with
  // `bye idle` and a close — the race a real host's idle exit can lose.
  let stopFake: () => Promise<void> = async () => {};
  const fake = await startFakeHost((sock, f) => {
    if (f.kind !== 'control') return;
    const m = f.message as { t?: unknown; req?: unknown };
    if (m.t === 'hello') sock.write(fakeWelcome());
    if (m.t === 'list') sock.write(encodeControl({ t: 'list-part', req: m.req as number, entries: [], done: true }));
    if (m.t === 'spawn') {
      // Gone for good, as a host that exited: no socket, no state file.
      unlinkSync(ptyHostPaths(fake.dataDir).stateFile);
      sock.end(encodeControl({ t: 'bye', reason: 'idle' }));
      void stopFake();
    }
  });
  stopFake = () => fake.stop();
  const { log, lines } = lineLog();
  const broker = new PtyHostBroker({ mode: 'socket', dataDir: fake.dataDir, build: 'test-build', log });
  const sessions = new SessionManager(log, new SessionHistory(join(fake.dataDir, 'history.json'), log), undefined, undefined, undefined, undefined, broker);
  try {
    assert.deepEqual(await broker.connectExisting(), []);
    broker.release();
    const info = await sessions.create({ cwd: '/tmp', command: 'bash', args: ['-c', 'sleep 300'], cols: 80, rows: 24 });
    trackHost(hostPidOf(fake.dataDir));
    assert.equal(info.status, 'running', 'the launch went through');
    assert.ok(lines.some((l) => l.includes(`${info.id} spawn met a pty-host leaving idle; retrying on a new one`)), lines.join(' | '));
    assert.notEqual(hostPidOf(fake.dataDir), process.pid, 'on a real pty-host the broker started');
  } finally {
    sessions.destroyAll();
    await broker.flushed(2000);
    await fake.stop();
  }
});
