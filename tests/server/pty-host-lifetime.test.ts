/**
 * The pty-host process's lifetime — Nocturne D9 P2
 * (`.claude/plans/nocturne/PLAN-D9.md` § Defaults): the orphan grace (after
 * a lost connection AND after a clean detach) ends the whole process group of
 * every PTY, a SIGHUP- and SIGTERM-ignoring child included; the idle exit at
 * zero entries; SIGTERM, `shutdown-all` and the probe's `shutdown-if-empty`;
 * the socket as the single-instance lock and a stale socket's recovery; and a
 * pty-host whose code directory is deleted while it runs.
 *
 * How: real pty-host children (`tests/helpers/pty-host-fixture.ts`) with
 * short lifetime seams, the fake CLIs of `tests/helpers/sessions-kill-fixture.ts`
 * (they write their leader and child pids), the backend's client.
 *
 * Why it matters: the pty-host outlives the backend on purpose, so it is
 * the one process that could keep a CLI — and the API key in its environment
 * — running after the user closed everything (decision 26: 10 minutes, then
 * end). An idle host that never leaves pins old code; a second host on one
 * data dir splits the sessions between two holders.
 *
 * Also (security re-review): the instance lock is named by a per-data-dir
 * secret (`pty-host.lockname`) — created once, one winner among concurrent
 * first starts, refused unless a 0600 regular file of ours — and a start that
 * loses the lock to a holder with no state file fails within ~2 s.
 *
 * Also (D9 P2 test gate): SIGHUP is ignored, SIGINT and an uncaught exception
 * shut down like SIGTERM; a forgotten running entry leaving at its exit starts
 * the idle exit; a non-socket at the socket path and a relative data dir
 * refuse the start; the state file is removed only while it names this host;
 * `startPtyHost` returns a live holder's file, never a dead one's, fails fast
 * on an early exit, starts the host detached and does not keep its starter
 * alive.
 *
 * NOT claimed: the backend starting it lazily and adopting at boot (P3); the
 * installer keeping its `appDir` (P5). The deleted-code-dir test deletes a
 * COPY of `server/` and `shared/` only: `node_modules` is a symlink to the
 * checkout's (its link is deleted, not the modules) and node is this test's
 * own binary. It still proves the claim for node-pty 1.1.0, which loads all
 * its modules and the native `pty.node` at import, and on Linux forks
 * natively (no spawn-helper file is opened at spawn time); a node-pty that
 * opened a file per spawn would need the installer's retention (P5) instead.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { chmod, cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectPtyHost, probePtyHost, startPtyHost } from '../../server/pty-host-client.ts';
import type { PtyHostLostReason } from '../../server/pty-host-api.ts';
import { PTY_HOST_EXIT, lockSecret, ptyHostPaths, readPtyHostFile } from '../../server/pty-host-wire.ts';
import { SKIP_IF_ROOT, makeTempDir, projectRoot, removeTempDir, sleep, waitUntil } from '../helpers/helpers.ts';
import {
  ENV,
  HOST_ENTRY,
  RawConn,
  STAY_ENV,
  hostLog,
  hostReady,
  makeHostDir,
  spawnHost,
  startHost,
  teardownHosts,
  trackHost,
  trackPty,
} from '../helpers/pty-host-fixture.ts';
import {
  alive,
  pidFile,
  pidsFrom,
  setupKillFixture,
  teardownKillFixture,
  trapBoth,
  waitAllGone,
  workDir,
} from '../helpers/sessions-kill-fixture.ts';

/** The orphan grace the tests run with (the floor is 1000). */
const ORPHAN_MS = 1500;
/** The idle time the tests run with. */
const IDLE_MS = 800;
/** Longer than IDLE_MS by a margin: the host must NOT have left by then. */
const PAST_IDLE_MS = IDLE_MS + 700;
/** Longer than ORPHAN_MS by a margin: a cancelled grace must NOT have fired by then. */
const PAST_ORPHAN_MS = ORPHAN_MS + 700;
/** The lock holder's grace after our child exited 3 (`OTHER_INSTANCE_WAIT_MS`). */
const OTHER_INSTANCE_WAIT_MS = 2000;
/**
 * A start that fails "at once" ends well inside this: a node boot (~0.5 s, more
 * on the CI runner) plus the 2 s holder grace at most — never the 10 s start
 * timeout.
 */
const START_FAILS_FAST_MS = 5000;

before(async () => {
  await setupKillFixture();
});

after(async () => {
  await teardownHosts();
  await teardownKillFixture();
});

/** Spawn the HUP- and TERM-ignoring fake CLI (leader + child in one group) through a raw owner. */
async function spawnTrapper(conn: RawConn): Promise<number[]> {
  const file = pidFile();
  conn.send({ t: 'spawn', id: randomUUID(), file: trapBoth(), argv: [file], cwd: workDir, env: ENV, cols: 80, rows: 24 });
  const { pid } = await conn.message('spawned');
  trackPty(pid);
  return pidsFrom(file);
}

test('a lost owner: after the orphan grace the whole group dies, a SIGHUP-ignoring child too', async () => {
  const h = await startHost({ ...STAY_ENV, AI_SM_PTY_HOST_ORPHAN_MS: String(ORPHAN_MS) });
  const owner = new RawConn(h.dataDir);
  owner.hello(h.file.token);
  await owner.message('welcome');
  const pids = await spawnTrapper(owner);
  const dropped = performance.now();
  owner.close();
  assert.equal(await h.exited, 0, 'the host exits cleanly after the grace');
  const ms = performance.now() - dropped;
  assert.ok(ms >= ORPHAN_MS - 200, `not before the grace (${Math.round(ms)}ms)`);
  await waitAllGone(pids, 'the leader and its HUP+TERM-ignoring child', 10_000);
  assert.match(hostLog(h.dataDir), /owner connection lost without detach/);
  assert.match(hostLog(h.dataDir), /shutting down \(no owner for 1500ms\): killing 1 running pty\(s\)/);
  assert.equal(existsSync(ptyHostPaths(h.dataDir).socket), false, 'the socket is removed');
  assert.equal(existsSync(ptyHostPaths(h.dataDir).stateFile), false, 'the state file is removed');
});

test('a clean detach starts the same orphan grace, without the crash line', async () => {
  const h = await startHost({ ...STAY_ENV, AI_SM_PTY_HOST_ORPHAN_MS: String(ORPHAN_MS) });
  const owner = await connectPtyHost({ dataDir: h.dataDir, takeover: false });
  const id = randomUUID();
  const { pid } = await owner.spawn({ id, file: 'sleep', argv: ['300'], cwd: '/', env: ENV, cols: 80, rows: 24 });
  trackPty(pid);
  owner.detach();
  assert.equal(await h.exited, 0);
  await waitUntil(() => (alive(pid) ? undefined : true), 'the sleep to be gone');
  assert.match(hostLog(h.dataDir), /owner detached; orphan grace 1500ms with 1 pty\(s\)/);
  assert.doesNotMatch(hostLog(h.dataDir), /without detach/);
});

test('an owner coming back within the grace cancels it', async () => {
  const h = await startHost({ ...STAY_ENV, AI_SM_PTY_HOST_ORPHAN_MS: String(ORPHAN_MS) });
  const first = await connectPtyHost({ dataDir: h.dataDir, takeover: false });
  const id = randomUUID();
  const { pid } = await first.spawn({ id, file: 'sleep', argv: ['300'], cwd: '/', env: ENV, cols: 80, rows: 24 });
  trackPty(pid);
  first.detach();
  const second = await connectPtyHost({ dataDir: h.dataDir, takeover: false });
  await sleep(PAST_ORPHAN_MS); // proving the grace did NOT fire
  assert.ok(alive(h.pid), 'the host is still running');
  assert.equal((await second.list())[0]?.pid, pid, 'and so is the session');
  second.shutdownAll();
  assert.equal(await h.exited, 0);
});

test('with zero entries the host exits after the idle time and cleans up after itself', async () => {
  const h = spawnHost(await makeHostDir(), { ...STAY_ENV, AI_SM_PTY_HOST_IDLE_MS: String(IDLE_MS) });
  await hostReady(h);
  assert.equal(await h.exited, 0);
  assert.match(hostLog(h.dataDir), /shutting down \(no pty for 800ms\)/);
  assert.equal(existsSync(ptyHostPaths(h.dataDir).socket), false);
  assert.equal(existsSync(ptyHostPaths(h.dataDir).stateFile), false);
});

test('an exited entry the owner still holds keeps the host; forgetting it starts the idle exit', async () => {
  const h = await startHost({ ...STAY_ENV, AI_SM_PTY_HOST_IDLE_MS: String(IDLE_MS) });
  const owner = await connectPtyHost({ dataDir: h.dataDir, takeover: false });
  const lost: PtyHostLostReason[] = [];
  owner.onLost((r) => lost.push(r));
  const exits = new Set<string>();
  owner.listen({ output: () => {}, exit: (id) => exits.add(id) });
  const id = randomUUID();
  const { pid } = await owner.spawn({ id, file: 'true', argv: [], cwd: '/', env: ENV, cols: 80, rows: 24 });
  trackPty(pid);
  await waitUntil(() => (exits.has(id) ? true : undefined), 'the exit');
  await sleep(PAST_IDLE_MS); // proving the idle exit did NOT fire while the entry is held
  assert.ok(alive(h.pid), 'an exited session (scrollback kept) still counts');
  owner.forget(id);
  assert.equal(await h.exited, 0);
  await waitUntil(() => (lost.length > 0 ? true : undefined), 'onLost');
  assert.deepEqual(lost, ['idle'], 'the owner is told why');
});

test('SIGTERM kills every pty group now and exits', async () => {
  const h = await startHost();
  const owner = new RawConn(h.dataDir);
  owner.hello(h.file.token);
  await owner.message('welcome');
  const pids = await spawnTrapper(owner);
  process.kill(h.pid, 'SIGTERM');
  assert.equal(await h.exited, 0);
  await waitAllGone(pids, 'the group after SIGTERM', 10_000);
  assert.deepEqual(await owner.message('bye'), { t: 'bye', reason: 'shutdown' });
  assert.match(hostLog(h.dataDir), /shutting down \(SIGTERM\): killing 1 running pty\(s\)/);
});

test('`shutdown-all` from the owner kills every group and the host leaves', async () => {
  const h = await startHost();
  const owner = await connectPtyHost({ dataDir: h.dataDir, takeover: false });
  const lost: PtyHostLostReason[] = [];
  owner.onLost((r) => lost.push(r));
  const file = pidFile();
  const { pid } = await owner.spawn({ id: randomUUID(), file: trapBoth(), argv: [file], cwd: workDir, env: ENV, cols: 80, rows: 24 });
  trackPty(pid);
  const pids = await pidsFrom(file);
  owner.shutdownAll();
  assert.equal(await h.exited, 0);
  await waitAllGone(pids, 'the group after shutdown-all', 10_000);
  await waitUntil(() => (lost.length > 0 ? true : undefined), 'onLost');
  assert.deepEqual(lost, ['shutdown']);
});

test('a probe\'s shutdown-if-empty leaves a host with a session alone and ends an empty one', async () => {
  const h = await startHost();
  const owner = await connectPtyHost({ dataDir: h.dataDir, takeover: false });
  const id = randomUUID();
  const { pid } = await owner.spawn({ id, file: 'sleep', argv: ['300'], cwd: '/', env: ENV, cols: 80, rows: 24 });
  trackPty(pid);
  const probe = await probePtyHost({ dataDir: h.dataDir });
  assert.deepEqual(await probe.listCount(), { total: 1, running: 1 });
  assert.equal(await probe.shutdownIfEmpty(), false);
  assert.ok(alive(pid), 'the session runs on');
  probe.close();
  owner.kill(id, 'now');
  owner.forget(id);
  const second = await probePtyHost({ dataDir: h.dataDir });
  await waitUntil(async () => ((await second.listCount()).total === 0 ? true : undefined), 'the entry to go');
  assert.equal(await second.shutdownIfEmpty(), true);
  assert.equal(await h.exited, 0);
});

test('one pty-host per data dir: a second one exits 3, a stale socket is taken over', async () => {
  const a = await startHost();
  const b = spawnHost(a.dataDir);
  assert.equal(await b.exited, PTY_HOST_EXIT.otherInstance);
  assert.equal(readPtyHostFile(a.dataDir)?.pid, a.pid, 'the state file still names the first');
  const probe = await probePtyHost({ dataDir: a.dataDir });
  assert.deepEqual(await probe.listCount(), { total: 0, running: 0 }, 'the first still answers');
  probe.close();

  // A host that died hard leaves its socket file behind.
  process.kill(a.pid, 'SIGKILL');
  await a.exited;
  assert.ok(existsSync(ptyHostPaths(a.dataDir).socket), 'the stale socket is there');
  const c = spawnHost(a.dataDir);
  assert.equal((await hostReady(c)).pid, c.pid);
  const again = await probePtyHost({ dataDir: a.dataDir });
  assert.equal(again.welcome.pid, c.pid, 'the new host answers on the old path');
  again.close();
});

test('two pty-hosts started at once on one data dir, stale socket or not: exactly one stays, and its token works', async () => {
  for (const stale of [false, true, false, true, false]) {
    const dataDir = await makeHostDir();
    if (stale) {
      // A dead host's leftover socket file: what both starters would find stale.
      const dead = spawnHost(dataDir);
      await hostReady(dead);
      process.kill(dead.pid, 'SIGKILL');
      await dead.exited;
      assert.ok(existsSync(ptyHostPaths(dataDir).socket), 'the stale socket is there');
    }
    const pair = [spawnHost(dataDir), spawnHost(dataDir)];
    const codes: (number | null | undefined)[] = [undefined, undefined];
    pair.forEach((h, i) => void h.exited.then((code) => (codes[i] = code)));
    const loserIndex = await waitUntil(() => {
      const i = codes.findIndex((c) => c !== undefined);
      return i === -1 ? undefined : i;
    }, 'one of the two to leave', 10_000);
    assert.equal(codes[loserIndex], PTY_HOST_EXIT.otherInstance, `round stale=${stale}: the second one leaves with 3`);
    const winner = pair[1 - loserIndex];
    assert.ok(winner !== undefined);
    const file = await hostReady(winner);
    const probe = await probePtyHost({ dataDir });
    assert.equal(probe.welcome.pid, winner.pid, 'the socket answers with the host the state file names');
    assert.deepEqual(await probe.listCount(), { total: 0, running: 0 }, `its token (${file.token.slice(0, 4)}…) is accepted`);
    probe.close();
    process.kill(winner.pid, 'SIGKILL');
    await winner.exited;
  }
});

test('each data dir names its lock after its own secret: two dirs (two distros, one home path) never share one', async () => {
  const a = await makeHostDir();
  const b = await makeHostDir();
  const sa = lockSecret(a);
  const sb = lockSecret(b);
  assert.match(sa, /^[0-9a-f]{32}$/);
  assert.notEqual(sa, sb, 'two data dirs, two secrets');
  assert.equal(lockSecret(a), sa, 'created once, then reused');
  assert.equal(statSync(ptyHostPaths(a).lockName).mode & 0o777, 0o600);
  assert.deepEqual(
    readdirSync(a).filter((n) => n.endsWith('.tmp')),
    [],
    'no temp file is left behind',
  );
});

test('eight first starts at once agree on one lock secret', async () => {
  const dataDir = await makeHostDir();
  const go = join(dataDir, 'go');
  const wire = join(projectRoot, 'server', 'pty-host-wire.ts');
  // Each child loads the module, says READY, then spins on the `go` file, so
  // all eight create the secret in the same instant — not one per node boot.
  const script = [
    `import { existsSync } from 'node:fs';`,
    `import { lockSecret } from ${JSON.stringify(wire)};`,
    `process.stdout.write('READY ');`,
    `const tick = new Int32Array(new SharedArrayBuffer(4));`,
    `while (!existsSync(process.argv[2])) Atomics.wait(tick, 0, 0, 1);`,
    `process.stdout.write(lockSecret(process.argv[1]));`,
  ].join('\n');
  const children = Array.from({ length: 8 }, () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, dataDir, go], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const state = { out: '', err: '' };
    child.stdout.on('data', (c: Buffer) => (state.out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (state.err += c.toString()));
    const done = new Promise<string>((resolve, reject) => {
      child.once('exit', (code) => (code === 0 ? resolve(state.out.replace('READY ', '')) : reject(new Error(state.err))));
    });
    return { child, state, done };
  });
  try {
    await waitUntil(() => (children.every((c) => c.state.out.startsWith('READY')) ? true : undefined), 'all eight ready');
    await writeFile(go, '');
    const outs = await Promise.all(children.map((c) => c.done));
    assert.equal(new Set(outs).size, 1, `one secret for all: ${outs.join(', ')}`);
    assert.equal(outs[0], lockSecret(dataDir));
  } finally {
    for (const c of children) if (c.child.exitCode === null) c.child.kill('SIGKILL');
  }
});

test('a lock name file that is not plainly ours is refused, and so is the start', { skip: SKIP_IF_ROOT }, async () => {
  const cases: [string, (path: string) => Promise<void>, RegExp][] = [
    ['mode 644', async (p) => writeFile(p, `${'a'.repeat(32)}\n`, { mode: 0o644 }).then(() => chmod(p, 0o644)), /lock name file has mode 644, not 600/],
    ['a link', async (p) => symlink('/etc/hostname', p), /lock name file is not a regular file/],
    ['a directory', async (p) => mkdir(p), /lock name file is not a regular file/],
    ['malformed', async (p) => writeFile(p, 'not-hex\n', { mode: 0o600 }), /lock name file is malformed/],
  ];
  for (const [name, plant, reason] of cases) {
    const dataDir = await makeHostDir();
    await plant(ptyHostPaths(dataDir).lockName);
    assert.throws(() => lockSecret(dataDir), reason, name);
    const h = spawnHost(dataDir);
    assert.equal(await h.exited, PTY_HOST_EXIT.refused, `${name}: the host refuses to start`);
    assert.equal(existsSync(ptyHostPaths(dataDir).socket), false, `${name}: no socket`);
    assert.match(hostLog(dataDir), reason, `${name}: the reason is in pty-host.log`);
  }
});

test('startPtyHost gives up within ~2 s when the lock holder publishes no state file', async () => {
  const h = await startHost();
  await rm(ptyHostPaths(h.dataDir).stateFile); // the holder lives on, its state file is gone
  const started = performance.now();
  await assert.rejects(
    startPtyHost({ dataDir: h.dataDir, build: 'test' }),
    /another pty-host holds this data dir but published no state file/,
  );
  const ms = performance.now() - started;
  assert.ok(ms >= OTHER_INSTANCE_WAIT_MS - 200, `it gave the holder its grace first (${Math.round(ms)}ms)`);
  assert.ok(ms < START_FAILS_FAST_MS, `failed fast (${Math.round(ms)}ms), not after the 10 s start timeout`);
});

test('a pty-host whose code directory is deleted while it runs still spawns', async () => {
  // A scratch install: a copy of server/ and shared/, the real node_modules by link.
  const app = join(await makeTempDir('pty-host-app-'), 'app');
  await mkdir(app);
  await cp(join(projectRoot, 'server'), join(app, 'server'), { recursive: true });
  await cp(join(projectRoot, 'shared'), join(app, 'shared'), { recursive: true });
  await cp(join(projectRoot, 'package.json'), join(app, 'package.json'));
  await symlink(join(projectRoot, 'node_modules'), join(app, 'node_modules'));
  const dataDir = await makeHostDir();
  const file = await startPtyHost({ dataDir, build: 'pruned-test', serverDir: join(app, 'server') });
  trackHost(file.pid);
  try {
    assert.equal(file.appDir, app);
    assert.equal(file.build, 'pruned-test');
    await rm(app, { recursive: true, force: true });
    assert.equal(existsSync(app), false, 'the code is gone');

    const owner = await connectPtyHost({ dataDir, takeover: false });
    let text = '';
    owner.listen({ output: (_id, data) => (text += data), exit: () => {} });
    const id = randomUUID();
    const { pid } = await owner.spawn({ id, file: 'bash', argv: ['-c', 'echo STILL-$((40+2)); sleep 300'], cwd: '/', env: ENV, cols: 80, rows: 24 });
    trackPty(pid);
    await waitUntil(() => (text.includes('STILL-42') ? true : undefined), 'output from the new pty');
    owner.shutdownAll();
  } finally {
    await removeTempDir(join(app, '..'));
  }
});

test('a SIGHUP is a stray: the host and its sessions run on', async () => {
  const h = await startHost();
  const owner = await connectPtyHost({ dataDir: h.dataDir, takeover: false });
  const { pid } = await owner.spawn({ id: randomUUID(), file: 'sleep', argv: ['300'], cwd: '/', env: ENV, cols: 80, rows: 24 });
  trackPty(pid);
  process.kill(h.pid, 'SIGHUP');
  await waitUntil(() => (/SIGHUP ignored/.test(hostLog(h.dataDir)) ? true : undefined), 'the host to note the SIGHUP');
  assert.ok(alive(h.pid), 'the host runs on');
  assert.ok(alive(pid), 'and so does its session');
  assert.equal((await owner.list())[0]?.exit, null, 'still served, still running');
  owner.shutdownAll();
  assert.equal(await h.exited, 0);
});

test('an uncaught exception in the host kills every pty group, then the host exits', async () => {
  // The real entry behind a wrapper that throws on SIGUSR2, outside any handler.
  const dir = await makeTempDir('pty-host-throw-');
  const wrapper = join(dir, 'throwing-host.ts');
  await writeFile(
    wrapper,
    `process.on('SIGUSR2', () => setImmediate(() => { throw new Error('boom from the test'); }));\n` +
      `await import(${JSON.stringify(HOST_ENTRY)});\n`,
  );
  try {
    const h = spawnHost(await makeHostDir(), STAY_ENV, wrapper);
    await hostReady(h);
    const owner = new RawConn(h.dataDir);
    owner.hello((await hostReady(h)).token);
    await owner.message('welcome');
    const pids = await spawnTrapper(owner);
    process.kill(h.pid, 'SIGUSR2');
    assert.equal(await h.exited, 0, 'a clean exit after the shutdown');
    await waitAllGone(pids, 'the group after the uncaught exception', 10_000);
    assert.match(hostLog(h.dataDir), /uncaught exception, shutting down: .*boom from the test/);
    assert.match(hostLog(h.dataDir), /shutting down \(uncaught exception\): killing 1 running pty\(s\)/);
  } finally {
    await removeTempDir(dir);
  }
});

test('a running entry the owner forgot leaves at its exit, and that starts the idle exit', async () => {
  const h = await startHost({ ...STAY_ENV, AI_SM_PTY_HOST_IDLE_MS: String(IDLE_MS) });
  const owner = await connectPtyHost({ dataDir: h.dataDir, takeover: false });
  const id = randomUUID();
  const { pid } = await owner.spawn({ id, file: 'bash', argv: ['-c', 'read line'], cwd: '/', env: ENV, cols: 80, rows: 24 });
  trackPty(pid);
  owner.forget(id); // still running: the table keeps it until it exits
  await sleep(PAST_IDLE_MS); // proving the idle exit did NOT fire while it runs
  assert.ok(alive(h.pid), 'a running entry keeps the host, forgotten or not');
  owner.write(id, 'go\r');
  assert.equal(await h.exited, 0, 'the exit dropped the last entry: idle exit');
  assert.match(hostLog(h.dataDir), /shutting down \(no pty for 800ms\)/);
});

test('a file at the socket path that is not a socket refuses the start and is left alone', async () => {
  const dataDir = await makeHostDir();
  const sock = ptyHostPaths(dataDir).socket;
  await writeFile(sock, 'not a socket', { mode: 0o600 });
  const h = spawnHost(dataDir);
  assert.equal(await h.exited, PTY_HOST_EXIT.refused);
  assert.match(hostLog(dataDir), /cannot bind .*pty-host\.sock: .*exists and is not a socket/);
  assert.equal(readFileSync(sock, 'utf8'), 'not a socket', 'not deleted');
  assert.equal(existsSync(ptyHostPaths(dataDir).stateFile), false, 'no state file');
});

test('startPtyHost on a data dir whose host already runs resolves with that host', async () => {
  const a = await startHost();
  const file = await startPtyHost({ dataDir: a.dataDir, build: 'test' });
  assert.equal(file.pid, a.pid, 'the running host, not the second start (which left with 3)');
  assert.equal(file.token, a.file.token);
});

test('startPtyHost starts the host detached: its own session, the data dir as cwd, no stdio', async () => {
  const dataDir = await makeHostDir();
  const file = await startPtyHost({ dataDir, build: 'test' });
  trackHost(file.pid);
  // /proc/<pid>/stat: "pid (comm) state ppid pgrp session ..." — comm has no spaces here (node).
  const fields = readFileSync(`/proc/${file.pid}/stat`, 'utf8').split(') ')[1]?.split(' ') ?? [];
  assert.equal(Number(fields[3]), file.pid, 'the leader of its own session (setsid)');
  assert.equal(readlinkSync(`/proc/${file.pid}/cwd`), dataDir, 'cwd: the data dir, not the code dir');
  assert.equal(readlinkSync(`/proc/${file.pid}/fd/0`), '/dev/null', 'stdin ignored');
  assert.equal(readlinkSync(`/proc/${file.pid}/fd/2`), '/dev/null', 'stderr ignored');
});

test('SIGINT shuts the host down like SIGTERM', async () => {
  const h = await startHost();
  process.kill(h.pid, 'SIGINT');
  assert.equal(await h.exited, 0);
  assert.match(hostLog(h.dataDir), /shutting down \(SIGINT\)/);
});

test('a data dir that is not an absolute path refuses the start, a valid relative one included', async () => {
  const base = await makeHostDir();
  await mkdir(join(base, 'rel'), { mode: 0o700 });
  for (const argv of [['rel'], []]) {
    const child = spawn(process.execPath, [HOST_ENTRY, ...argv], { cwd: base, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...STAY_ENV } });
    if (child.pid !== undefined) trackHost(child.pid);
    let err = '';
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    assert.equal(code, PTY_HOST_EXIT.refused, `argv ${JSON.stringify(argv)}`);
    assert.match(err, /usage: pty-host-main\.ts <absolute data dir>/);
  }
  assert.deepEqual(readdirSync(join(base, 'rel')), [], 'nothing was bound or written');
});

test('at exit the host removes pty-host.json only while it still names this host', async () => {
  const h = await startHost();
  const other = { ...h.file, pid: h.pid + 1, token: 'f'.repeat(64) };
  await writeFile(ptyHostPaths(h.dataDir).stateFile, JSON.stringify(other), { mode: 0o600 });
  process.kill(h.pid, 'SIGTERM');
  assert.equal(await h.exited, 0);
  assert.deepEqual(readPtyHostFile(h.dataDir), other, 'another host\'s state file is left alone');
});

test('a probe\'s shutdown-if-empty counts an exited session the owner still holds', async () => {
  const h = await startHost();
  const owner = await connectPtyHost({ dataDir: h.dataDir, takeover: false });
  const exits = new Set<string>();
  owner.listen({ output: () => {}, exit: (id) => exits.add(id) });
  const id = randomUUID();
  const { pid } = await owner.spawn({ id, file: 'true', argv: [], cwd: '/', env: ENV, cols: 80, rows: 24 });
  trackPty(pid);
  await waitUntil(() => (exits.has(id) ? true : undefined), 'the exit');
  const probe = await probePtyHost({ dataDir: h.dataDir });
  assert.deepEqual(await probe.listCount(), { total: 1, running: 0 });
  assert.equal(await probe.shutdownIfEmpty(), false, 'its scrollback is still held');
  probe.close();
  assert.ok(alive(h.pid));
  owner.shutdownAll();
  assert.equal(await h.exited, 0);
});

test('startPtyHost never hands back a dead host\'s state file: it waits for its own child\'s', async () => {
  const dead = await startHost();
  process.kill(dead.pid, 'SIGKILL'); // its pty-host.json stays behind
  await dead.exited;
  assert.equal(readPtyHostFile(dead.dataDir)?.pid, dead.pid, 'the stale state file is there');
  const file = await startPtyHost({ dataDir: dead.dataDir, build: 'test' });
  trackHost(file.pid);
  assert.notEqual(file.pid, dead.pid, 'the new host, not the dead one');
  assert.ok(alive(file.pid));
  const probe = await probePtyHost({ dataDir: dead.dataDir });
  assert.equal(probe.welcome.pid, file.pid, 'and its token is the one that works');
  probe.close();
});

test('startPtyHost reports a child that exits before it is ready at once, with its exit code', async () => {
  const dataDir = await makeHostDir();
  await writeFile(ptyHostPaths(dataDir).lockName, 'not-hex\n', { mode: 0o600 }); // the child refuses with 2
  const started = performance.now();
  await assert.rejects(startPtyHost({ dataDir, build: 'test' }), /the pty-host exited with code 2 before it was ready/);
  const ms = performance.now() - started;
  assert.ok(ms < START_FAILS_FAST_MS, `failed fast (${Math.round(ms)}ms), not after the 10 s start timeout`);
});

test('a backend that started a pty-host is not kept alive by it (the child is unref\'d)', async () => {
  const dataDir = await makeHostDir();
  const client = join(projectRoot, 'server', 'pty-host-client.ts');
  const script = [
    `import { startPtyHost } from ${JSON.stringify(client)};`,
    `const file = await startPtyHost({ dataDir: process.argv[1], build: 'test' });`,
    `process.stdout.write(String(file.pid));`,
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c: Buffer) => (out += c.toString()));
  try {
    const code = await waitUntil(() => child.exitCode ?? undefined, 'the starter to exit on its own', START_FAILS_FAST_MS);
    assert.equal(code, 0);
    const pid = Number(out);
    trackHost(pid);
    assert.ok(alive(pid), 'the pty-host outlives its starter');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    if (/^\d+$/.test(out)) trackHost(Number(out)); // even when an assertion above failed
  }
});
