/**
 * The backend's pty-host broker — server/pty-host-broker.ts, Nocturne D9 P3
 * (`.claude/plans/nocturne/PLAN-D9.md` § Defaults, § Risks (a)): a shutdown
 * while a spawn is in flight or while the pty-host is still starting, a
 * pty-host that left idle, the in-process fallback when the data dir is
 * refused, a takeover, two first sessions sharing one start, a running
 * pty-host found by a broker that has nothing to adopt its sessions with, a
 * shutdown the backend asked for (not a loss), a first start that fails, and
 * a session that had exited before it was adopted when the pty-host dies.
 *
 * How: the real broker and SessionManager in this process, over a real
 * pty-host child the broker starts (`startPtyHost`, detached) on a 0700 temp
 * data dir; its pid is tracked from `pty-host.json` and every host and PTY
 * group is ended in `after` (tests/helpers/pty-host-fixture.ts). The idle seam
 * is set in this process's env, which the started pty-host inherits.
 *
 * Why it matters: a PTY spawned in the instant a backend shuts down would
 * otherwise outlive it with nobody to end it; an idle exit must not cost the
 * next session its pty-host; a refused data dir must still run sessions.
 *
 * NOT claimed: the backend's boot order (`pty-host-boot.test.ts`), adoption
 * (`pty-host-crash.test.ts`).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PtyHostBroker } from '../../server/pty-host-broker.ts';
import { SessionHistory } from '../../server/history.ts';
import { SessionManager } from '../../server/sessions.ts';
import type { Logger } from '../../server/config.ts';
import { makeTempDir, nextImmediate, projectRoot, removeTempDir, waitUntil } from '../helpers/helpers.ts';
import { hostLog, makeHostDir, teardownHosts, trackHost, trackPty } from '../helpers/pty-host-fixture.ts';
import { hostPidOf, pidAlive } from '../helpers/pty-host-backend-fixture.ts';

const roots: string[] = [];
after(async () => {
  await teardownHosts();
  for (const r of roots) await removeTempDir(r);
});

const LAUNCH = { cwd: '/tmp', command: 'bash', args: ['-c', 'while :; do sleep 0.2; done'], cols: 80, rows: 24 };

function rig(dataDir: string): { broker: PtyHostBroker; sessions: SessionManager; lines: string[] } {
  const lines: string[] = [];
  const log: Logger = (level, msg) => void lines.push(`${level} ${msg}`);
  const broker = new PtyHostBroker({ mode: 'socket', dataDir, build: 'test-build', log });
  const sessions = new SessionManager(log, new SessionHistory(join(dataDir, 'history.json'), log), undefined, undefined, undefined, undefined, broker);
  broker.setAdopter((entries) => sessions.adopt(entries));
  return { broker, sessions, lines };
}

test('a shutdown while a spawn is in flight leaves no PTY alive', async () => {
  const dataDir = await makeHostDir('d9-broker-pending-');
  const { broker, sessions, lines } = rig(dataDir);
  await sessions.create(LAUNCH); // the pty-host is up
  trackHost(hostPidOf(dataDir));
  const spawnedBefore = hostLog(dataDir).split(' spawned pid ').length;
  const created = sessions.create(LAUNCH);
  // Only microtasks between here and destroyAll: this process reads no
  // socket meanwhile, so the pty-host has spawned (its log says so) and its
  // answer is still unread — the in-flight window, held open on purpose.
  const deadline = performance.now() + 10_000;
  while (hostLog(dataDir).split(' spawned pid ').length === spawnedBefore && performance.now() < deadline) {
    await Promise.resolve();
  }
  const spawns = [...hostLog(dataDir).matchAll(/ spawned pid (\d+)/g)];
  assert.ok(spawns.length >= spawnedBefore, 'the pty-host spawned it');
  const pid = Number(spawns.at(-1)?.[1]);
  trackPty(pid);
  sessions.destroyAll();
  await assert.rejects(created, /shutting down/);
  assert.ok(lines.some((l) => l.includes('spawned during shutdown; killed at once')), 'the answer arrived after destroyAll');
  assert.deepEqual(sessions.list(), [], 'the late session was never registered');
  await broker.flushed(2000);
  await waitUntil(() => (pidAlive(pid) ? undefined : true), 'the late PTY to be ended');
});

test('after an idle pty-host left, the next session starts a new one', async () => {
  const saved = process.env['AI_SM_PTY_HOST_IDLE_MS'];
  process.env['AI_SM_PTY_HOST_IDLE_MS'] = '500';
  try {
    const dataDir = await makeHostDir('d9-broker-idle-');
    const { broker, sessions, lines } = rig(dataDir);
    const first = await sessions.create(LAUNCH);
    const firstHost = hostPidOf(dataDir);
    trackHost(firstHost);
    sessions.destroy(first.id);
    await waitUntil(() => (pidAlive(firstHost) ? undefined : true), 'the pty-host to leave idle');
    await waitUntil(() => (lines.some((l) => l.includes('pty-host lost (idle): 0 session(s) ended')) ? true : undefined), 'the broker to see it go');
    assert.equal(broker.status(), null);
    await sessions.create(LAUNCH);
    const secondHost = hostPidOf(dataDir);
    trackHost(secondHost);
    assert.notEqual(secondHost, firstHost, 'a new pty-host');
    assert.equal(broker.status()?.build, 'test-build', 'started with this backend build');
    sessions.destroyAll();
    await broker.flushed(2000);
  } finally {
    if (saved === undefined) delete process.env['AI_SM_PTY_HOST_IDLE_MS'];
    else process.env['AI_SM_PTY_HOST_IDLE_MS'] = saved;
  }
});

test('a refused data dir runs sessions in-process, with one warning line for the run', async () => {
  const dataDir = await makeTempDir('d9-broker-refused-');
  roots.push(dataDir);
  await chmod(dataDir, 0o755);
  const { broker, sessions, lines } = rig(dataDir);
  assert.deepEqual(await broker.connectExisting(), []);
  await sessions.create(LAUNCH);
  await sessions.create(LAUNCH);
  const warned = lines.filter((l) => l.includes('pty-host unavailable'));
  assert.deepEqual(warned, [
    'warn [pty-host] pty-host unavailable, sessions run inside the backend this run and end with it: The data directory has mode 755, not 700.',
  ]);
  assert.equal(broker.status(), null);
  assert.equal(sessions.list().filter((s) => s.status === 'running').length, 2, 'both sessions run');
  sessions.destroyAll();
});

test('a pty-host taken over by another backend: the sessions are handed over, nothing is killed or stamped', async () => {
  const dataDir = await makeHostDir('d9-broker-takeover-');
  const a = rig(dataDir);
  const { id } = await a.sessions.create({ ...LAUNCH, args: ['-c', 'echo "pid $$"; while :; do sleep 0.2; done'] });
  const hostPid = hostPidOf(dataDir);
  trackHost(hostPid);
  const pid = await waitUntil(() => {
    const m = / spawned pid (\d+)/.exec(hostLog(dataDir));
    return m === null ? undefined : Number(m[1]);
  }, 'the spawn in the pty-host log');
  trackPty(pid);
  const b = rig(dataDir);
  const held = await b.broker.connectExisting();
  assert.deepEqual(held.map((e) => e.id), [id], 'the second backend sees the session');
  await waitUntil(() => (a.sessions.get(id) === undefined ? true : undefined), 'the first backend to let go');
  assert.ok(a.lines.some((l) => l.includes('taken over by another backend: 1 session(s) handed over, none ended')), a.lines.join(' | '));
  assert.equal(pidAlive(pid), true, 'the process runs on');
  await b.sessions.adopt(held);
  b.broker.release();
  assert.equal(b.sessions.get(id)?.status, 'running');
  b.sessions.destroyAll();
  await b.broker.flushed(2000);
});

test('a shutdown while the pty-host is still starting spawns nothing on it', async () => {
  const dataDir = await makeHostDir('d9-broker-starting-');
  const { broker, sessions } = rig(dataDir);
  // No pty-host yet: this create starts one, which takes far longer than the
  // synchronous destroyAll right after it.
  const created = sessions.create(LAUNCH);
  sessions.destroyAll();
  await assert.rejects(created, /shutting down/);
  const hostPid = await waitUntil(() => {
    try {
      return hostPidOf(dataDir);
    } catch {
      return undefined;
    }
  }, 'the pty-host that was starting');
  trackHost(hostPid);
  assert.doesNotMatch(hostLog(dataDir), / spawned pid /, 'the started pty-host was never asked to spawn');
  broker.shutdownAll();
  await broker.flushed(2000);
});

test('two first sessions at once share one pty-host start: both run, nothing is taken over', async () => {
  const dataDir = await makeHostDir('d9-broker-twostart-');
  const { broker, sessions, lines } = rig(dataDir);
  const both = await Promise.all([sessions.create(LAUNCH), sessions.create(LAUNCH)]);
  trackHost(hostPidOf(dataDir));
  for (const m of hostLog(dataDir).matchAll(/ spawned pid (\d+)/g)) trackPty(Number(m[1]));
  assert.deepEqual(
    both.map((s) => sessions.get(s.id)?.status),
    ['running', 'running'],
    `both listed and running: ${lines.join(' | ')}`,
  );
  assert.equal(lines.filter((l) => l.includes('owner of pty-host pid')).length, 1, `one start: ${lines.join(' | ')}`);
  assert.ok(!lines.some((l) => l.includes('taken over')), lines.join(' | '));
  sessions.destroyAll();
  await broker.flushed(2000);
});

test('a broker with no adopter that finds a running pty-host ends its sessions, never owns them unseen', async () => {
  const dataDir = await makeHostDir('d9-broker-noadopter-');
  const a = rig(dataDir);
  await a.sessions.create({ ...LAUNCH, args: ['-c', 'echo "pid $$"; while :; do sleep 0.2; done'] });
  trackHost(hostPidOf(dataDir));
  const pid = await waitUntil(() => {
    const m = / spawned pid (\d+)/.exec(hostLog(dataDir));
    return m === null ? undefined : Number(m[1]);
  }, 'the spawn in the pty-host log');
  trackPty(pid);
  const lines: string[] = [];
  const log: Logger = (level, msg) => void lines.push(`${level} ${msg}`);
  const broker = new PtyHostBroker({ mode: 'socket', dataDir, build: 'test-build', log });
  const sessions = new SessionManager(log, new SessionHistory(join(dataDir, 'history-b.json'), log), undefined, undefined, undefined, undefined, broker);
  // No setAdopter, no boot connect: the first spawn finds the running host.
  await sessions.create(LAUNCH);
  assert.ok(lines.some((l) => l.includes('already held 1 session(s) the boot did not adopt; ending them')), lines.join(' | '));
  await waitUntil(() => (pidAlive(pid) ? undefined : true), 'the unadopted PTY to be ended');
  sessions.destroyAll();
  await broker.flushed(2000);
});

/**
 * The cap given to `flushed()` where the test asserts it was NOT reached: the
 * frame leaves in milliseconds, so half of 10 s is a margin no runner misses.
 */
const FLUSH_CAP_MS = 10_000;

test('a shutdown the backend asked for is flushed at once and is not a loss: no group probe, no crash, no lost line', async () => {
  const dataDir = await makeHostDir('d9-broker-ownshutdown-');
  const { broker, sessions, lines } = rig(dataDir);
  await sessions.create(LAUNCH);
  const hostPid = hostPidOf(dataDir);
  trackHost(hostPid);
  sessions.destroyAll();
  const asked = performance.now();
  await broker.flushed(FLUSH_CAP_MS);
  assert.ok(performance.now() - asked < FLUSH_CAP_MS / 2, 'flushed() answered when the frame left, not at its cap');
  await waitUntil(() => (pidAlive(hostPid) ? undefined : true), 'the pty-host to exit after shutdown-all');
  // The connection's close is read in the same turn as the exit at the
  // earliest; one more pass of the event loop lets a wrong `lost` show.
  await nextImmediate();
  assert.ok(!lines.some((l) => l.includes('pty-host lost')), lines.join(' | '));
});

test('a pty-host whose first start fails is started once more, and the session runs on it, not in-process', async () => {
  const dataDir = await makeHostDir('d9-broker-secondstart-');
  // A pty-host-main.ts that exits 1 on its first start and is the real one
  // after that (the broker's `serverDir` seam names where the entry is).
  const serverDir = await makeTempDir('d9-broker-flaky-entry-');
  roots.push(serverDir);
  const real = join(projectRoot, 'server', 'pty-host-main.ts');
  await writeFile(
    join(serverDir, 'pty-host-main.ts'),
    `import { existsSync, writeFileSync } from 'node:fs';\n` +
      `const marker = ${JSON.stringify(join(serverDir, 'failed-once'))};\n` +
      `if (!existsSync(marker)) { writeFileSync(marker, ''); process.exit(1); }\n` +
      `await import(${JSON.stringify(real)});\n`,
  );
  const lines: string[] = [];
  const log: Logger = (level, msg) => void lines.push(`${level} ${msg}`);
  const broker = new PtyHostBroker({ mode: 'socket', dataDir, build: 'test-build', log, serverDir });
  const sessions = new SessionManager(log, new SessionHistory(join(dataDir, 'history.json'), log), undefined, undefined, undefined, undefined, broker);
  await sessions.create(LAUNCH);
  trackHost(hostPidOf(dataDir));
  assert.ok(lines.some((l) => l.includes('starting a pty-host failed (attempt 1)')), lines.join(' | '));
  assert.ok(!lines.some((l) => l.includes('pty-host unavailable')), `no fallback: ${lines.join(' | ')}`);
  assert.equal(broker.status()?.build, 'test-build', 'the session is held by the pty-host of the second start');
  sessions.destroyAll();
  await broker.flushed(2000);
});

test('a session that had exited before this broker adopted it is not ended again when the pty-host dies', async () => {
  const dataDir = await makeHostDir('d9-broker-adoptedexit-');
  const a = rig(dataDir);
  const { id } = await a.sessions.create({ ...LAUNCH, args: ['-c', 'exit 3'] });
  await waitUntil(() => (a.sessions.get(id)?.status === 'exited' ? true : undefined), 'the session to exit');
  const hostPid = hostPidOf(dataDir);
  trackHost(hostPid);
  const b = rig(dataDir);
  const held = await b.broker.connectExisting();
  assert.deepEqual(held.map((e) => [e.id, e.exit?.code]), [[id, 3]], 'the exited session is still held, with its exit');
  await b.sessions.adopt(held);
  b.broker.release();
  process.kill(hostPid, 'SIGKILL');
  await waitUntil(() => (b.lines.some((l) => l.includes('pty-host lost (closed)')) ? true : undefined), 'the broker to see it go');
  assert.ok(b.lines.some((l) => l.includes('pty-host lost (closed): 0 session(s) ended, 0 process group(s) killed')), b.lines.join(' | '));
  assert.equal(b.sessions.get(id)?.exitCode, 3, 'it keeps its own exit code');
});
