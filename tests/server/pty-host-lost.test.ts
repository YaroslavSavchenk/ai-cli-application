/**
 * A running backend over a real pty-host — Nocturne D9 P3
 * (`.claude/plans/nocturne/PLAN-D9.md` § Phases P3, § Risks): the pty-host
 * dies under it (its sessions' process groups are SIGKILLed, history says
 * `crash`, the next session starts a new pty-host, a session that had
 * already exited is not ended a second time), and the two races a spawn
 * across a socket opened — two resumes of one entry at once, and a PTY that
 * exits before its spawn answer is read.
 *
 * How: one real backend child (`startTestServer`, `ptyHost: 'socket'`) on a
 * 0700 temp data dir, the real pty-host it starts, real bash PTYs. The
 * pty-host is SIGKILLed by the pid in its own `pty-host.json`; every host and
 * PTY group is ended in `after`.
 *
 * Why it matters: a dead pty-host leaves its PTYs' children running with the
 * session's API key in their env and nobody to end them; a doubled resume puts
 * two Claudes on one transcript; an early exit left a history entry live.
 *
 * NOT claimed: the in-flight window itself, which a real socket rarely
 * leaves open long enough to hit (the deterministic version of both races is
 * `sessions-adopt.test.ts`); Windows.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryEntry, RuntimeStatusResponse, SessionInfo } from '../../shared/protocol.ts';
import { api, createSession, readServerLog, startTestServer, waitUntil, wsUrl, WsClient, type TestServer } from '../helpers/helpers.ts';
import { makeHostDir, teardownHosts, trackHost, trackPty } from '../helpers/pty-host-fixture.ts';
import { hostPidOf, pidAlive, readHistory, shellPid } from '../helpers/pty-host-backend-fixture.ts';

const world = { server: undefined as TestServer | undefined, dataDir: '' };

before(async () => {
  world.dataDir = await makeHostDir('d9-lost-');
  world.server = await startTestServer({ dataDir: world.dataDir, ptyHost: 'socket' });
});

after(async () => {
  await world.server?.stop();
  await teardownHosts();
});

function server(): TestServer {
  if (world.server === undefined) throw new Error('the backend did not start');
  return world.server;
}

/** Start a bash session that prints its pid first; returns its id and pid. */
async function bashSession(script: string): Promise<{ id: string; pid: number }> {
  const info = await createSession(server(), { cwd: '/tmp', command: 'bash', args: ['-c', `echo "pid $$"; ${script}`], cols: 80, rows: 24 });
  const ws = await WsClient.connect(wsUrl(server(), info.id));
  const pid = shellPid(await ws.waitForOutput('pid '));
  await ws.close();
  trackPty(pid);
  return { id: info.id, pid };
}

async function sessionInfo(id: string): Promise<SessionInfo | undefined> {
  return ((await api(server(), 'GET', '/api/sessions')).body as SessionInfo[]).find((s) => s.id === id);
}

test('a pty-host that dies takes its sessions down hard: group SIGKILLed, exit 137, history crash', async () => {
  // SIGHUP and SIGTERM ignored: the hang-up a dead pty-host's closed master
  // sends cannot end this one, nor can anything gentler than the backend's
  // group SIGKILL.
  const { id, pid } = await bashSession(`trap '' HUP TERM; while :; do sleep 0.2; done`);
  const hostPid = hostPidOf(world.dataDir);
  trackHost(hostPid);
  process.kill(hostPid, 'SIGKILL');
  await waitUntil(async () => ((await sessionInfo(id))?.status === 'exited' ? true : undefined), 'the session to end');
  assert.equal((await sessionInfo(id))?.exitCode, 137);
  await waitUntil(() => (pidAlive(pid) ? undefined : true), "the session's process to be gone");
  const entry = readHistory(world.dataDir).find((e: HistoryEntry) => e.sessionId === id);
  assert.equal(entry?.ended?.reason, 'crash');
  assert.match(await readServerLog(server()), /\[pty-host\] pty-host lost \(closed\): 1 session\(s\) ended, 1 process group\(s\) killed/);
  const runtime = (await api(server(), 'GET', '/api/runtime')).body as RuntimeStatusResponse;
  assert.equal(runtime.ptyHost, null, 'no pty-host is connected now');
});

test('the next session after a lost pty-host starts a new one and runs', async () => {
  const before = hostPidOf(world.dataDir);
  const { pid } = await bashSession('sleep 300');
  assert.equal(pidAlive(pid), true);
  assert.notEqual(hostPidOf(world.dataDir), before, 'a new pty-host was started');
  const runtime = (await api(server(), 'GET', '/api/runtime')).body as RuntimeStatusResponse;
  assert.equal(runtime.ptyHost?.proto, 1);
});

test('two resumes of one history entry at once: one starts it, the other is 409', async () => {
  const { id } = await bashSession('sleep 300');
  assert.equal((await api(server(), 'DELETE', `/api/sessions/${id}`)).status, 200);
  const entryId = readHistory(world.dataDir).find((e: HistoryEntry) => e.sessionId === id)?.id;
  assert.ok(entryId !== undefined);
  const both = await Promise.all([
    api(server(), 'POST', `/api/history/${entryId}/resume`, { cols: 80, rows: 24 }),
    api(server(), 'POST', `/api/history/${entryId}/resume`, { cols: 80, rows: 24 }),
  ]);
  assert.deepEqual(both.map((r) => r.status).sort(), [201, 409], JSON.stringify(both.map((r) => r.body)));
  const refused = both.find((r) => r.status === 409);
  assert.deepEqual(refused?.body, { error: 'that session is still running' });
  const running = ((await api(server(), 'GET', '/api/sessions')).body as SessionInfo[]).filter(
    (s) => s.args.join(' ').includes('sleep 300') && s.status === 'running' && s.id !== id,
  );
  assert.equal(running.length, 2, 'the session of the earlier test and exactly one resumed copy');
});

test('a session that exits at once still gets its history entry, stamped exit', async () => {
  const info = await createSession(server(), { cwd: '/tmp', command: 'true', args: [], cols: 80, rows: 24 });
  const entry = await waitUntil(() => {
    const e = readHistory(world.dataDir).find((h: HistoryEntry) => h.sessionId === info.id);
    return e?.ended === null ? undefined : e;
  }, 'the entry to be stamped');
  assert.deepEqual([entry?.ended?.reason, entry?.exitCode], ['exit', 0]);
});

test('a session that had already exited is not ended again when its pty-host dies: no probe, no 137', async () => {
  const done = await createSession(server(), { cwd: '/tmp', command: 'true', args: [], cols: 80, rows: 24 });
  await waitUntil(async () => ((await sessionInfo(done.id))?.status === 'exited' ? true : undefined), 'the quick session to exit');
  const { id } = await bashSession('sleep 300');
  // Every session still running on this pty-host (earlier tests' included).
  const running = ((await api(server(), 'GET', '/api/sessions')).body as SessionInfo[]).filter((s) => s.status === 'running').length;
  const hostPid = hostPidOf(world.dataDir);
  trackHost(hostPid);
  process.kill(hostPid, 'SIGKILL');
  await waitUntil(async () => ((await sessionInfo(id))?.status === 'exited' ? true : undefined), 'the running session to end');
  const lost = (await readServerLog(server())).split('\n').filter((l) => l.includes('pty-host lost (closed)'));
  assert.match(lost.at(-1) ?? '', new RegExp(`: ${running} session\\(s\\) ended`), `only the ${running} running one(s) count`);
  assert.equal((await sessionInfo(done.id))?.exitCode, 0, 'the exited one keeps its own code');
});
