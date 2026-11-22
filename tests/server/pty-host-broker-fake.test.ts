/**
 * The backend's pty-host broker against a SCRIPTED pty-host — server/pty-host-broker.ts,
 * Nocturne D9 P3 (`.claude/plans/nocturne/PLAN-D9.md` § Defaults, decision 27):
 * the broker rules a real pty-host cannot be made to hit on cue —
 *   - an incompatible pty-host is ended by the pid in its state file ONLY when
 *     /proc/<pid>/cmdline proves that pid is this data dir's pty-host-main; a
 *     stale file's pid may belong to anything by now, and is left alone;
 *   - a spawn that meets a host leaving idle (`bye idle` raced the spawn) is
 *     retried once on a new host instead of failing the launch — and only
 *     once: a retry that meets one too fails the launch;
 *   - a boot connect to a host that is alive but silent is tried three
 *     times, paused between, before its sessions are given up;
 *   - a spawn the host refuses while it stays up fails at once;
 *   - a host lost with a session whose process group is already gone
 *     sends no group signal (its pid may be another process's by now).
 * And three of D9 P4 (a restart): a detach that lands while a late start's
 * hello is still out (security review S1) — the leaving backend adopts and
 * kills nothing and gives the seat straight back; a standby's probe that
 * meets no usable answer reads `none`; and a probe never keeps its
 * connection.
 *
 * How: the real broker in this process over `startFakeHost`
 * (tests/helpers/pty-host-fixture.ts) — a real socket and 0600 state file
 * whose answers the test writes. The pid the state file names is a decoy
 * child this file spawns (`node -e` with the argv under test, so its
 * /proc cmdline is exactly that) and ends in `finally`; never this process.
 * The retry's new host is a real pty-host the broker starts, tracked and
 * ended in `after`. The late start uses the broker's `serverDir` seam: its
 * pty-host-main.ts exits "another instance holds this data dir", so the
 * start goes on to the fake's state file, as it would to a running host.
 *
 * Why it matters: a SIGTERM by an unchecked pid could end any process of this
 * user; a launch that fails because the idle host left in that instant is a
 * "could not start the session" the user did nothing to cause; a leaving
 * backend that owned, adopted or ended the pty-host's PTYs after its detach
 * would take the sessions from the backend that has just adopted them.
 *
 * NOT claimed: a real incompatible pty-host being ended with its sessions
 * (`pty-host-boot.test.ts`), the host's own idle rule (`pty-host-lifetime.test.ts`).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { PtyHostBroker } from '../../server/pty-host-broker.ts';
import { SessionHistory } from '../../server/history.ts';
import { SessionManager } from '../../server/sessions.ts';
import type { Logger } from '../../server/config.ts';
import { randomUUID } from 'node:crypto';
import { encodeControl, PTY_HOST_EXIT, PTY_HOST_PROTOCOL, ptyHostPaths, type Frame } from '../../server/pty-host-wire.ts';
import { makeTempDir, removeTempDir, sleep, waitUntil } from '../helpers/helpers.ts';
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
    { what: 'a process that names this data dir but is no pty-host', child: decoy(['/home/you/app/server/index.ts', fake.dataDir]) },
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

// ---------------------------------------------------------------------------
// D9 P4: a restart's detach and a standby's probe
// ---------------------------------------------------------------------------

/** The `t` of a control frame, or undefined for any other frame. */
function verb(f: Frame): { t?: unknown; req?: unknown } | undefined {
  return f.kind === 'control' ? (f.message as { t?: unknown; req?: unknown }) : undefined;
}

test('a detach while a late hello is out: the leaving backend adopts and kills nothing and gives the seat straight back (S1)', async () => {
  // A session another backend left with the pty-host: the one the NEXT
  // backend is adopting while this one leaves. Its pid can never exist
  // (above Linux's PID_MAX_LIMIT), so no path here can signal a real group.
  const kept = { id: randomUUID(), pid: 4_194_400, cols: 80, rows: 24, endOffset: 0, exit: null, meta: null };
  let helloFrom: Socket | undefined;
  const fake = await startFakeHost((sock, f) => {
    const m = verb(f);
    if (m?.t === 'hello') helloFrom = sock; // The welcome waits for the test.
    if (m?.t === 'list') sock.write(encodeControl({ t: 'list-part', req: m.req as number, entries: [kept], done: true }));
  });
  const serverDir = await makeTempDir('d9-broker-late-entry-');
  await writeFile(join(serverDir, 'pty-host-main.ts'), `process.exit(${PTY_HOST_EXIT.otherInstance});\n`);
  const { log, lines } = lineLog();
  const broker = new PtyHostBroker({ mode: 'socket', dataDir: fake.dataDir, build: 'test-build', log, serverDir });
  const sessions = new SessionManager(log, new SessionHistory(join(fake.dataDir, 'history.json'), log), undefined, undefined, undefined, undefined, broker);
  try {
    const created = sessions.create({ cwd: '/tmp', command: 'bash', args: ['-c', 'sleep 300'], cols: 80, rows: 24 });
    const sock = await waitUntil(() => helloFrom, 'the late start to say hello as owner');
    sessions.detachAll(); // The restart's teardown, while the hello is unanswered.
    sock.write(fakeWelcome());
    await assert.rejects(created, /shutting down/);
    await waitUntil(() => (fake.received.includes('detach') ? true : undefined), 'the seat to be given back');
    assert.deepEqual(
      fake.received,
      ['hello', 'list', 'detach'],
      'no spawn, kill, forget, snapshot or set-meta: the PTY belongs to the next backend',
    );
    assert.ok(!lines.some((l) => l.includes('owner of pty-host')), `never the owner: ${lines.join(' | ')}`);
    assert.ok(!lines.some((l) => l.includes('already held')), `nothing adopted or ended: ${lines.join(' | ')}`);
  } finally {
    await fake.stop();
    await removeTempDir(serverDir);
  }
});

test("a standby's probe that meets no usable answer reads none: closed at the hello, closed at list-count", async () => {
  for (const closeOn of ['hello', 'list-count']) {
    const fake = await startFakeHost((sock, f) => {
      const m = verb(f);
      if (m?.t === closeOn) {
        sock.destroy();
        return;
      }
      if (m?.t === 'hello') sock.write(fakeWelcome());
    });
    try {
      const { log, lines } = lineLog();
      const broker = new PtyHostBroker({ mode: 'socket', dataDir: fake.dataDir, build: 'test-build', log });
      assert.equal(await broker.probe(), 'none', `closed at ${closeOn}`);
      assert.ok(!lines.some((l) => l.includes('refused this code')), `closed at ${closeOn}: not a refusal: ${lines.join(' | ')}`);
    } finally {
      await fake.stop();
    }
  }
});

test("a standby's probe closes its connection once it has its answer", async () => {
  let closed = false;
  const fake = await startFakeHost((sock, f) => {
    const m = verb(f);
    if (m?.t === 'hello') {
      sock.once('close', () => {
        closed = true;
      });
      sock.write(fakeWelcome());
    }
    if (m?.t === 'list-count') sock.write(encodeControl({ t: 'count', req: m.req as number, total: 1, running: 1 }));
  });
  try {
    const broker = new PtyHostBroker({ mode: 'socket', dataDir: fake.dataDir, build: 'test-build', log: () => {} });
    assert.equal(await broker.probe(), 'compatible');
    await waitUntil(() => (closed ? true : undefined), 'the probe connection to close');
    assert.deepEqual(fake.received, ['hello', 'list-count'], 'a probe asks one thing and writes nothing');
  } finally {
    await fake.stop();
  }
});

/**
 * How long a probe may take, at most, before its verdict is due: the probe's
 * own 5 s budget (server/pty-host-broker.ts PROBE_TIMEOUT_MS) plus a margin.
 */
const PROBE_DUE_MS = 6_500;

test(
  "a standby's probe whose list-count is never answered reads none within its timeout",
  async () => {
    const fake = await startFakeHost((sock, f) => {
      if (verb(f)?.t === 'hello') sock.write(fakeWelcome()); // list-count: silence.
    });
    try {
      const broker = new PtyHostBroker({ mode: 'socket', dataDir: fake.dataDir, build: 'test-build', log: () => {} });
      const verdict = await Promise.race([broker.probe(), sleep(PROBE_DUE_MS).then(() => 'no verdict')]);
      assert.equal(verdict, 'none');
    } finally {
      await fake.stop(); // Ends a hung probe too: its socket closes, list-count rejects.
    }
  },
);

// ---------------------------------------------------------------------------
// D9 P3 gate: the boot connect's patience, the idle retry's limit, a refused spawn
// ---------------------------------------------------------------------------

/** server/pty-host-broker.ts: BOOT_CONNECT_ATTEMPTS tries of CONNECT_TIMEOUT_MS, BOOT_CONNECT_PAUSE_MS apart. */
const BOOT_ATTEMPTS = 3;
const CONNECT_TIMEOUT_MS = 2000;
const BOOT_PAUSE_MS = 500;
/** server/pty-host-broker.ts LOST_REASON_WAIT_MS: how long a failed spawn may wait for a host's `bye`. */
const LOST_REASON_WAIT_MS = 1000;

test('a pty-host that is alive but never answers is tried three times at boot, half a second apart, then left to the first session', async () => {
  // The fake never answers a hello; its state file names this (live) process.
  const fake = await startFakeHost(() => {});
  const { log, lines } = lineLog();
  const broker = new PtyHostBroker({ mode: 'socket', dataDir: fake.dataDir, build: 'test-build', log });
  try {
    const asked = performance.now();
    assert.deepEqual(await broker.connectExisting(), []);
    const took = performance.now() - asked;
    broker.release();
    assert.equal(fake.received.filter((t) => t === 'hello').length, BOOT_ATTEMPTS, 'a busy host gets every try before its sessions are given up');
    assert.equal(lines.filter((l) => l.includes('did not answer') && l.includes('trying again')).length, BOOT_ATTEMPTS - 1, lines.join(' | '));
    assert.ok(lines.some((l) => l.includes('no pty-host answered')), lines.join(' | '));
    // A lower bound only: every try and every pause is a timer that cannot end early.
    const floor = BOOT_ATTEMPTS * CONNECT_TIMEOUT_MS + (BOOT_ATTEMPTS - 1) * BOOT_PAUSE_MS;
    assert.ok(took >= floor - 50, `a pause between the tries: ${Math.round(took)} ms for ${floor} ms of timers`);
  } finally {
    await fake.stop();
  }
});

test('a spawn retried because an idle pty-host left is retried once: a retry that meets one too fails the launch', async () => {
  // Every host this broker reaches is the fake, and it leaves idle at every spawn.
  // Its state file stays, so the retry's start (a pty-host-main.ts that finds
  // "another instance") goes on to it again, as it would to a running host.
  const fake = await startFakeHost((sock, f) => {
    const m = verb(f);
    if (m?.t === 'hello') sock.write(fakeWelcome());
    if (m?.t === 'list') sock.write(encodeControl({ t: 'list-part', req: m.req as number, entries: [], done: true }));
    if (m?.t === 'spawn') sock.end(encodeControl({ t: 'bye', reason: 'idle' }));
  });
  const serverDir = await makeTempDir('d9-broker-idle-twice-');
  await writeFile(join(serverDir, 'pty-host-main.ts'), `process.exit(${PTY_HOST_EXIT.otherInstance});\n`);
  const { log, lines } = lineLog();
  const broker = new PtyHostBroker({ mode: 'socket', dataDir: fake.dataDir, build: 'test-build', log, serverDir });
  try {
    assert.deepEqual(await broker.connectExisting(), []);
    broker.release();
    let settled: string | undefined;
    broker.spawn({ id: randomUUID(), file: 'bash', argv: [], cwd: '/tmp', env: {}, cols: 80, rows: 24 }).then(
      () => void (settled = 'spawned'),
      () => void (settled = 'rejected'),
    );
    const spawns = (): number => fake.received.filter((t) => t === 'spawn').length;
    const outcome = await waitUntil(() => (spawns() > 2 ? 'a third spawn' : settled), 'the spawn to settle');
    assert.equal(outcome, 'rejected', `the launch fails instead of looping: ${lines.join(' | ')}`);
    assert.equal(spawns(), 2, 'the first try and ONE retry');
    assert.equal(lines.filter((l) => l.includes('leaving idle; retrying')).length, 1, lines.join(' | '));
  } finally {
    await fake.stop();
    await removeTempDir(serverDir);
  }
});

test('a spawn the pty-host refuses while it stays up fails at once: no wait for a loss that is not coming', async () => {
  const fake = await startFakeHost((sock, f) => {
    const m = verb(f);
    if (m?.t === 'hello') sock.write(fakeWelcome());
    if (m?.t === 'list') sock.write(encodeControl({ t: 'list-part', req: m.req as number, entries: [], done: true }));
    if (m?.t === 'spawn') {
      const { id } = (f.kind === 'control' ? f.message : {}) as { id?: string };
      sock.write(encodeControl({ t: 'spawn-error', id: id as string, cls: 'ENOENT' }));
    }
  });
  const broker = new PtyHostBroker({ mode: 'socket', dataDir: fake.dataDir, build: 'test-build', log: () => {} });
  try {
    assert.deepEqual(await broker.connectExisting(), []);
    broker.release();
    const asked = performance.now();
    await assert.rejects(
      broker.spawn({ id: randomUUID(), file: 'no-such-program', argv: [], cwd: '/tmp', env: {}, cols: 80, rows: 24 }),
      /could not be spawned \(ENOENT\)/,
    );
    const took = performance.now() - asked;
    assert.ok(took < LOST_REASON_WAIT_MS / 2, `the error is the answer, not a reason to wait for a bye: ${Math.round(took)} ms`);
    assert.equal(broker.status()?.build, 'fake', 'the host is still the one this backend owns');
  } finally {
    await fake.stop();
  }
});

test('a pty-host lost with a session whose process group is already gone signals no group: nothing is killed by a pid that may be reused', async () => {
  // The spawned pid can never exist (above Linux's PID_MAX_LIMIT): the group
  // probe finds nothing, as for a group that ended with its host.
  const gone = 4_194_401;
  const fake = await startFakeHost((sock, f) => {
    const m = verb(f);
    if (m?.t === 'hello') sock.write(fakeWelcome());
    if (m?.t === 'list') sock.write(encodeControl({ t: 'list-part', req: m.req as number, entries: [], done: true }));
    if (m?.t === 'spawn') {
      const { id } = (f.kind === 'control' ? f.message : {}) as { id?: string };
      sock.write(encodeControl({ t: 'spawned', id: id as string, pid: gone }));
    }
  });
  const { log, lines } = lineLog();
  const broker = new PtyHostBroker({ mode: 'socket', dataDir: fake.dataDir, build: 'test-build', log });
  const sessions = new SessionManager(log, new SessionHistory(join(fake.dataDir, 'history.json'), log), undefined, undefined, undefined, undefined, broker);
  try {
    assert.deepEqual(await broker.connectExisting(), []);
    broker.release();
    const { id } = await sessions.create({ cwd: '/tmp', command: 'bash', args: [], cols: 80, rows: 24 });
    await fake.stop(); // The host is gone without a bye: a crash.
    await waitUntil(() => (lines.some((l) => l.includes('pty-host lost (closed)')) ? true : undefined), 'the broker to see it go');
    assert.ok(lines.some((l) => l.includes('pty-host lost (closed): 1 session(s) ended, 0 process group(s) killed')), lines.join(' | '));
    assert.equal(sessions.get(id)?.exitCode, 137, 'still ended as a crash');
  } finally {
    await fake.stop();
  }
});
