/**
 * The backend's pty-host broker — server/pty-host-broker.ts, Nocturne D9 P3
 * (`.claude/plans/nocturne/PLAN-D9.md` § Defaults, § Risks (a)): a shutdown
 * while a spawn is in flight or while the pty-host is still starting, a
 * pty-host that left idle, the in-process fallback when the data dir is
 * refused, a takeover, two first sessions sharing one start, a running
 * pty-host found by a broker that has nothing to adopt its sessions with, a
 * shutdown the backend asked for (not a loss), a first start that fails, and
 * a session that had exited before it was adopted when the pty-host dies.
 * Since D9 P4, what a restart asks of it: a standby's read-only `probe`, the
 * `detach` that hands the PTYs to the next backend (also while a pty-host is
 * still starting: that start never takes the seat), the count of running
 * sessions held in-process (which no restart can keep; a deleted one is not
 * counted), a detached broker asked to spawn directly (it starts no
 * pty-host), and an ending teardown followed at once by the next owner,
 * which adopts nothing.
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
import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
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

// ---------------------------------------------------------------------------
// D9 P4: what a restart asks of the broker
// ---------------------------------------------------------------------------

test("a standby's probe: none without a pty-host, compatible with one, incompatible when it refuses this code — and never takes the seat", async () => {
  const dataDir = await makeHostDir('d9-broker-probe-');
  const owner = rig(dataDir);
  assert.equal(await rig(dataDir).broker.probe(), 'none', 'no pty-host yet');
  const { id } = await owner.sessions.create(LAUNCH);
  trackHost(hostPidOf(dataDir));
  const standby = rig(dataDir);
  assert.equal(await standby.broker.probe(), 'compatible');
  assert.ok(
    standby.lines.some((l) => /probe: pty-host pid \d+ \(build test-build\) holds 1 session\(s\), 1 running; this code can adopt them/.test(l)),
    standby.lines.join(' | '),
  );
  assert.equal(owner.sessions.get(id)?.status, 'running', 'the owner keeps its session');
  assert.ok(!owner.lines.some((l) => l.includes('taken over')), 'a probe is not a takeover');
  // A pty-host that refuses this code's hello (here: a token it does not know).
  const stateFile = join(dataDir, 'pty-host.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8')) as Record<string, unknown>;
  await writeFile(stateFile, JSON.stringify({ ...state, token: 'f'.repeat(64) }), { mode: 0o600 });
  const refused = rig(dataDir);
  assert.equal(await refused.broker.probe(), 'incompatible');
  assert.ok(refused.lines.some((l) => l.includes('probe: the pty-host refused this code (token;')), refused.lines.join(' | '));
  assert.equal(await new PtyHostBroker({ mode: 'inproc', dataDir, build: 'b', log: () => {} }).probe(), 'none', 'in-process mode probes nothing');
  owner.sessions.destroyAll();
  await owner.broker.flushed(2000);
});

test('detach hands the PTYs to the next owner and spawns nothing after it', async () => {
  const dataDir = await makeHostDir('d9-broker-detach-');
  const a = rig(dataDir);
  const { id } = await a.sessions.create(LAUNCH);
  trackHost(hostPidOf(dataDir));
  a.sessions.detachAll();
  await assert.rejects(a.sessions.create(LAUNCH), /shutting down/);
  // The goodbye reaches the pty-host as one: the seat is empty before the
  // next backend asks for it, never taken from a backend still sitting in it.
  await waitUntil(() => (hostLog(dataDir).includes('owner detached;') ? true : undefined), 'the pty-host to see the detach');
  const b = rig(dataDir);
  const held = await b.broker.connectExisting();
  assert.deepEqual(held.map((e) => [e.id, e.exit]), [[id, null]], 'the next backend finds the session still running');
  assert.ok(!a.lines.some((l) => l.includes('pty-host lost')), 'a detach is not a loss');
  assert.doesNotMatch(hostLog(dataDir), /owner taken over|owner connection lost without detach/, 'a clean goodbye, not a takeover or a crash');
  await b.sessions.adopt(held);
  b.broker.release();
  b.sessions.destroyAll();
  await b.broker.flushed(2000);
});

test('running in-process sessions are counted (no restart can keep them), and a detach ends them', async () => {
  const dataDir = await makeTempDir('d9-broker-inproc-count-');
  roots.push(dataDir);
  await chmod(dataDir, 0o755); // refused: the sessions run in-process
  const { broker, sessions, lines } = rig(dataDir);
  assert.equal(broker.inProcessRunning(), 0);
  const { id } = await sessions.create(LAUNCH);
  const done = await sessions.create({ ...LAUNCH, args: ['-c', 'exit 0'] });
  await waitUntil(() => (sessions.get(done.id)?.status === 'exited' ? true : undefined), 'the short one to exit');
  assert.equal(broker.inProcessRunning(), 1, 'only the running one counts');
  const pid = Number(new RegExp(`${id} created: pid (\\d+)`).exec(lines.join('\n'))?.[1]);
  assert.ok(pid > 1, 'the created line names the pid');
  trackPty(pid);
  broker.detach();
  await waitUntil(() => (pidAlive(pid) ? undefined : true), 'the in-process PTY to be ended');
});

test('an in-process session deleted while its kill is still under way is not counted as running', async () => {
  const dataDir = await makeTempDir('d9-broker-inproc-deleted-');
  roots.push(dataDir);
  await chmod(dataDir, 0o755); // refused: the sessions run in-process
  const { broker, sessions, lines } = rig(dataDir);
  const { id } = await sessions.create(LAUNCH);
  const pid = Number(new RegExp(`${id} created: pid (\\d+)`).exec(lines.join('\n'))?.[1]);
  assert.ok(pid > 1, 'the created line names the pid');
  trackPty(pid);
  assert.equal(broker.inProcessRunning(), 1);
  // DELETE: the kill ladder starts and the route is forgotten at once; its
  // exit can only arrive in a later turn, so this reads the forgotten route.
  sessions.destroy(id);
  assert.equal(broker.inProcessRunning(), 0, 'a deleted session is not one a restart would end');
  sessions.destroyAll();
  await waitUntil(() => (pidAlive(pid) ? undefined : true), 'the deleted PTY to be ended');
});

test('a broker that has detached starts no pty-host for a spawn asked of it directly', async () => {
  const dataDir = await makeHostDir('d9-broker-detached-spawn-');
  const broker = new PtyHostBroker({ mode: 'socket', dataDir, build: 'test-build', log: () => {} });
  broker.detach();
  await assert.rejects(
    broker.spawn({ id: '00000000-0000-4000-8000-000000000001', file: 'bash', argv: [], cwd: '/tmp', env: {}, cols: 80, rows: 24 }),
    /shutting down/,
  );
  const started = existsSync(join(dataDir, 'pty-host.json'));
  if (started) trackHost(hostPidOf(dataDir)); // Ended in `after` should this ever regress.
  assert.equal(started, false, 'no pty-host was started for a backend that is leaving');
});

test('a detach while a pty-host is still starting never says hello as its owner; the next backend keeps the seat (S1)', async () => {
  const dataDir = await makeHostDir('d9-broker-detach-starting-');
  const a = rig(dataDir);
  // No pty-host yet: this create starts one, which takes far longer than the
  // restart's synchronous detach right after it.
  const created = a.sessions.create(LAUNCH);
  a.sessions.detachAll();
  await assert.rejects(created, /shutting down/);
  const hostPid = await waitUntil(() => {
    try {
      return hostPidOf(dataDir);
    } catch {
      return undefined;
    }
  }, 'the pty-host that was starting');
  trackHost(hostPid);
  assert.doesNotMatch(hostLog(dataDir), /owner attached/, 'the leaving backend never connected as owner');
  const b = rig(dataDir);
  await b.broker.connectExisting();
  b.broker.release();
  await waitUntil(() => (hostLog(dataDir).includes('owner attached') ? true : undefined), 'the next backend to be owner');
  assert.equal(hostLog(dataDir).match(/owner attached/g)?.length, 1, 'one owner: the next backend');
  assert.ok(!b.lines.some((l) => l.includes('taken over')), b.lines.join(' | '));
  assert.ok(!a.lines.some((l) => l.includes('owner of pty-host')), a.lines.join(' | '));
  assert.ok(
    !a.lines.some((l) => l.includes('starting a pty-host failed') || l.includes('pty-host unavailable')),
    `a leaving backend neither retries the start nor falls back in-process: ${a.lines.join(' | ')}`,
  );
  b.broker.shutdownAll();
  await b.broker.flushed(2000);
});

test('an end teardown with the next owner connecting at once: nothing it lists is adopted (F7)', async () => {
  // A restart that ends its sessions (`endSessions`) and a same-code child
  // that reaches the pty-host before it has left: whatever the child lists,
  // every PTY was marked deleted and killed before the `shutdown-all`.
  const dataDir = await makeHostDir('d9-broker-end-then-own-');
  const a = rig(dataDir);
  await a.sessions.create(LAUNCH);
  await a.sessions.create(LAUNCH);
  const hostPid = hostPidOf(dataDir);
  trackHost(hostPid);
  a.sessions.destroyAll();
  const b = rig(dataDir);
  const held = await b.broker.connectExisting();
  await b.sessions.adopt(held);
  b.broker.release();
  assert.deepEqual(b.sessions.list(), [], `nothing adopted (it listed ${held.length})`);
  await waitUntil(() => (pidAlive(hostPid) ? undefined : true), 'the pty-host to leave');
});
