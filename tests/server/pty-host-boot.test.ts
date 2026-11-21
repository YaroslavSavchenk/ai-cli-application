/**
 * The backend's boot against the data dir's pty-host — Nocturne D9 P3
 * (`.claude/plans/nocturne/PLAN-D9.md` § Decided 26, § Defaults): what the
 * next boot finds when the orphan grace already ended the sessions, a session
 * deleted just before a crash, a data dir the pty-host cannot live in (the
 * in-process fallback), the `AI_SM_PTY_HOST=inproc` seam, an invalid
 * `AI_SM_PTY_HOST`, and `ptyHost` in
 * GET /api/runtime.
 *
 * How: real backend children (`startTestServer`, `ptyHost: 'socket'`, or a
 * plain spawn for the refused start), the real pty-host they start, real bash
 * PTYs; short orphan grace through the `AI_SM_PTY_HOST_ORPHAN_MS` seam, which
 * the started pty-host inherits from the backend. Every host and PTY group is
 * ended in `after`.
 *
 * Why it matters: the boot decides which history entries are a crash and which
 * sessions come back; a wrong answer resurrects a deleted session or leaves a
 * dead one live forever. The fallback is the one place a misconfigured data
 * dir must not take sessions away altogether.
 *
 * NOT claimed: adoption of live sessions (`pty-host-crash.test.ts`), a lost
 * pty-host under a running backend (`pty-host-lost.test.ts`).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryEntry, RuntimeStatusResponse, SessionInfo } from '../../shared/protocol.ts';
import {
  api,
  createSession,
  makeTempDir,
  projectRoot,
  readServerLog,
  removeTempDir,
  startTestServer,
  waitUntil,
  wsUrl,
  WsClient,
  type TestServer,
} from '../helpers/helpers.ts';
import { makeHostDir, teardownHosts, trackHost, trackPty } from '../helpers/pty-host-fixture.ts';
import { hostPidOf, pidAlive, readHistory, shellPid } from '../helpers/pty-host-backend-fixture.ts';

const servers: TestServer[] = [];
const roots: string[] = [];
after(async () => {
  for (const s of servers) await s.stop();
  await teardownHosts();
  for (const r of roots) await removeTempDir(r);
});

async function boot(dataDir: string, env: Record<string, string> = {}): Promise<TestServer> {
  const s = await startTestServer({ dataDir, ptyHost: 'socket', env });
  servers.push(s);
  return s;
}

async function crash(s: TestServer): Promise<void> {
  s.child.kill('SIGKILL');
  await s.exit;
}

async function bashSession(s: TestServer, script: string): Promise<{ id: string; pid: number }> {
  const info = await createSession(s, { cwd: '/tmp', command: 'bash', args: ['-c', `echo "pid $$"; ${script}`], cols: 80, rows: 24 });
  const ws = await WsClient.connect(wsUrl(s, info.id));
  const pid = shellPid(await ws.waitForOutput('pid '));
  await ws.close();
  trackPty(pid);
  return { id: info.id, pid };
}

test('GET /api/runtime says ptyHost null until the first session starts one, then its build and protocol', async () => {
  const s = await boot(await makeHostDir('d9-boot-rt-'));
  assert.equal(((await api(s, 'GET', '/api/runtime')).body as RuntimeStatusResponse).ptyHost, null);
  await bashSession(s, 'sleep 300');
  trackHost(hostPidOf(s.dataDir));
  const { ptyHost } = (await api(s, 'GET', '/api/runtime')).body as RuntimeStatusResponse;
  assert.equal(ptyHost?.proto, 1);
  assert.match(ptyHost?.build ?? '', /^[\w.+-]{1,64}$/, 'the build the backend passed as AI_SM_PTY_HOST_BUILD');
  assert.notEqual(ptyHost?.build, 'unknown', 'the backend passed its build to the pty-host it started');
});

test('after the orphan grace ended the sessions, the next boot finds nothing and stamps them crash', async () => {
  const dataDir = await makeHostDir('d9-boot-orphan-');
  const first = await boot(dataDir, { AI_SM_PTY_HOST_ORPHAN_MS: '1000' });
  const { id, pid } = await bashSession(first, 'while :; do sleep 0.2; done');
  const hostPid = hostPidOf(dataDir);
  trackHost(hostPid);
  await crash(first);
  await waitUntil(() => (pidAlive(hostPid) ? undefined : true), 'the pty-host to end after its orphan grace');
  await waitUntil(() => (pidAlive(pid) ? undefined : true), 'the session to be ended with it');
  const second = await boot(dataDir);
  assert.deepEqual((await api(second, 'GET', '/api/sessions')).body, [], 'nothing to adopt');
  const entry = readHistory(dataDir).find((e: HistoryEntry) => e.sessionId === id);
  assert.equal(entry?.ended?.reason, 'crash');
});

test('a session deleted just before a crash is not brought back by the next boot', async () => {
  const dataDir = await makeHostDir('d9-boot-deleted-');
  const first = await boot(dataDir);
  // HUP and TERM ignored: the DELETE's kill ladder is still running when the
  // backend dies, so the pty-host still lists this PTY at the next boot.
  const { id, pid } = await bashSession(first, `trap '' HUP TERM; while :; do sleep 0.2; done`);
  trackHost(hostPidOf(dataDir));
  assert.equal((await api(first, 'DELETE', `/api/sessions/${id}`)).status, 200);
  await crash(first);
  const second = await boot(dataDir);
  const listed = (await api(second, 'GET', '/api/sessions')).body as SessionInfo[];
  assert.deepEqual(listed.map((s) => s.id), [], 'the deleted session stays deleted');
  assert.match(await readServerLog(second), new RegExp(`${id} not adopted \\(deleted\\); ending it`));
  await waitUntil(() => (pidAlive(pid) ? undefined : true), 'its process to be ended');
});

test('a data dir whose socket path is too long: one log line, and sessions run inside the backend', async () => {
  const root = await makeTempDir('d9-boot-long-');
  roots.push(root);
  const dataDir = join(root, 'd'.repeat(100));
  const s = await boot(dataDir);
  const { pid } = await bashSession(s, 'sleep 300');
  assert.equal(pidAlive(pid), true, 'the session runs');
  const log = await readServerLog(s);
  const lines = log.split('\n').filter((l) => l.includes('pty-host unavailable'));
  assert.equal(lines.length, 1, `exactly one fallback line: ${lines.join(' | ')}`);
  assert.match(lines[0] ?? '', /sessions run inside the backend this run and end with it: The pty-host socket path is \d+ bytes, over the 107-byte limit/);
  await bashSession(s, 'sleep 300');
  assert.equal((await readServerLog(s)).split('pty-host unavailable').length - 1, 1, 'a second session adds no line');
  assert.equal(existsSync(join(dataDir, 'pty-host.json')), false, 'no pty-host was started');
  assert.equal(((await api(s, 'GET', '/api/runtime')).body as RuntimeStatusResponse).ptyHost, null);
});

test('AI_SM_PTY_HOST=inproc: sessions run inside the backend, no pty-host is started', async () => {
  const s = await startTestServer({ dataDir: await makeHostDir('d9-boot-inproc-'), ptyHost: 'inproc' });
  servers.push(s);
  const { pid } = await bashSession(s, 'sleep 300');
  assert.equal(pidAlive(pid), true, 'the session runs');
  assert.equal(existsSync(join(s.dataDir, 'pty-host.json')), false, 'no pty-host was started for it');
  assert.equal(((await api(s, 'GET', '/api/runtime')).body as RuntimeStatusResponse).ptyHost, null);
  assert.doesNotMatch(await readServerLog(s), /pty-host unavailable/, 'the seam is not a fallback: no warning');
});

test('an invalid AI_SM_PTY_HOST refuses the start, with the reason in server.log', async () => {
  const root = await makeTempDir('d9-boot-refuse-');
  roots.push(root);
  const dataDir = join(root, 'data');
  const child = spawn(process.execPath, [join(projectRoot, 'server', 'index.ts')], {
    cwd: projectRoot,
    env: { ...process.env, AI_SM_DATA_DIR: dataDir, AI_SM_PTY_HOST: 'sometimes' },
    stdio: 'ignore',
  });
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  assert.notEqual(code, 0, 'the backend did not start');
  assert.match(readFileSync(join(dataDir, 'server.log'), 'utf8'), /refusing to start: AI_SM_PTY_HOST must be 'inproc' or unset, got "sometimes"/);
  assert.equal(existsSync(join(dataDir, 'runtime.json')), false, 'nothing was listening');
});

/** Stop a pty-host process (SIGSTOP) for `ms`, so it answers nothing meanwhile; resumed by the returned promise. */
function freeze(pid: number, ms: number): Promise<void> {
  process.kill(pid, 'SIGSTOP');
  return new Promise((resolve) =>
    setTimeout(() => {
      process.kill(pid, 'SIGCONT');
      resolve();
    }, ms),
  );
}

/**
 * The boot's connect windows (server/pty-host-broker.ts): 3 attempts of 2 s
 * with 0.5 s between them. FREEZE_ONE_MS outlasts the first attempt and ends
 * inside the second; FREEZE_ALL_MS outlasts all three (and the boot).
 */
const FREEZE_ONE_MS = 3200;
const FREEZE_ALL_MS = 9000;

test('a pty-host that misses the first boot connect is still re-attached: its sessions are adopted', async () => {
  const dataDir = await makeHostDir('d9-boot-retry-');
  const first = await boot(dataDir);
  const { id, pid } = await bashSession(first, 'sleep 300');
  const hostPid = hostPidOf(dataDir);
  trackHost(hostPid);
  await crash(first);
  const thawed = freeze(hostPid, FREEZE_ONE_MS);
  const second = await boot(dataDir);
  await thawed;
  const listed = (await api(second, 'GET', '/api/sessions')).body as SessionInfo[];
  assert.deepEqual(listed.map((s) => [s.id, s.status]), [[id, 'running']], 'adopted, not stamped crash');
  assert.match(await readServerLog(second), /did not answer .*; trying again/);
  assert.equal(pidAlive(pid), true);
  assert.equal(readHistory(dataDir).find((e: HistoryEntry) => e.sessionId === id)?.ended, null);
});

test('a pty-host found running only at the first spawn after boot is adopted, never owned unseen', async () => {
  const dataDir = await makeHostDir('d9-boot-late-');
  const first = await boot(dataDir);
  const { id, pid } = await bashSession(first, 'sleep 300');
  const hostPid = hostPidOf(dataDir);
  trackHost(hostPid);
  await crash(first);
  const thawed = freeze(hostPid, FREEZE_ALL_MS);
  const second = await boot(dataDir);
  assert.equal(readHistory(dataDir).find((e: HistoryEntry) => e.sessionId === id)?.ended?.reason, 'crash', 'the boot gave up on it');
  await thawed;
  await bashSession(second, 'sleep 300');
  assert.equal(hostPidOf(dataDir), hostPid, 'the new session went to the pty-host that was running');
  const old = ((await api(second, 'GET', '/api/sessions')).body as SessionInfo[]).find((s) => s.id === id);
  assert.equal(old?.status, 'running', 'its old session is adopted and listed');
  assert.equal(pidAlive(pid), true);
  assert.equal(readHistory(dataDir).find((e: HistoryEntry) => e.sessionId === id)?.ended, null, 'and live in history again');
  assert.match(await readServerLog(second), /already held 1 session\(s\) the boot did not adopt; adopting them/);
});

test('an incompatible pty-host is ended with its sessions, and a new one serves the next session', async () => {
  const dataDir = await makeHostDir('d9-boot-incompat-');
  const first = await boot(dataDir);
  const { id, pid } = await bashSession(first, 'sleep 300');
  const hostPid = hostPidOf(dataDir);
  trackHost(hostPid);
  await crash(first);
  // A state file whose token the running host does not accept: it refuses
  // every hello from this backend, as a host of another protocol would.
  const stateFile = join(dataDir, 'pty-host.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
  writeFileSync(stateFile, JSON.stringify({ ...state, token: 'f'.repeat(64) }));
  chmodSync(stateFile, 0o600);
  const second = await boot(dataDir);
  assert.match(await readServerLog(second), new RegExp(`an incompatible pty-host \\(pid ${hostPid}, protocol 1, refused: token\\)`));
  await waitUntil(() => (pidAlive(hostPid) ? undefined : true), 'the incompatible pty-host to end');
  await waitUntil(() => (pidAlive(pid) ? undefined : true), 'its session to end with it');
  assert.equal(readHistory(dataDir).find((e: HistoryEntry) => e.sessionId === id)?.ended?.reason, 'crash');
  await bashSession(second, 'sleep 300');
  assert.notEqual(hostPidOf(dataDir), hostPid, 'a new pty-host');
});
