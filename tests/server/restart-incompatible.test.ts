/**
 * Restarts the sessions cannot survive — Nocturne D9 P4, decision 27
 * (`.claude/plans/nocturne/PLAN-D9.md` § Decided, § Defaults): when the new
 * version's backend cannot adopt the running pty-host (it speaks another
 * `PTY_HOST_PROTOCOL`), its standby says `incompatible` and POST /api/restart
 * answers 409 `sessions-would-end` with NOTHING changed; the same POST with
 * `{ endSessions: true }` ("Restart anyway") proceeds and the sessions end as
 * before D9 — history `shutdown`, resumable. And the same code restarting over
 * a COMPATIBLE pty-host its standby cannot reach (`none` while a session
 * runs): the same 409, and after "Restart anyway" the old backend's
 * `shutdown-all` reaches the pty-host and the new backend adopts nothing.
 *
 * How: a REAL installed-mode restart (`tests/helpers/restart-installed-fixture.ts`):
 * v1 and v2 bundles, v2's copy of server/pty-host-wire.ts speaking protocol 2,
 * a v1 backend child whose pty-host (protocol 1) holds a real bash PTY; then
 * `current` flips to v2, as the installer leaves it. Installed mode, because
 * that is where the new code really differs — a developer restart runs the
 * same checkout. The `none` case is a developer restart (a real vite build
 * into a copy of web/dist) with the pty-host's state file moved aside, so the
 * standby's probe finds no pty-host to ask. Every backend, pty-host and PTY
 * group is ended at the end.
 *
 * Why it matters: without the 409 the user is promised their sessions keep
 * running and then loses every one of them — the new backend could only end
 * the old pty-host (history `crash`), with no warning beforehand.
 *
 * NOT claimed: the copy of the second confirmation — `tests/ui/ui-a8-restart-dom.test.ts`;
 * sessions inside the backend (no pty-host) — `restart-real.test.ts` and
 * `restart-sessions-fate.test.ts`; Windows.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryEntry, SessionInfo } from '../../shared/protocol.ts';
import { api, createSession, readServerLog, startTestServer, waitUntil, wsUrl, WsClient } from '../helpers/helpers.ts';
import { hostLog, makeHostDir, teardownHosts, trackHost, trackPty } from '../helpers/pty-host-fixture.ts';
import { hostPidOf, pidAlive, readHistory, shellPid } from '../helpers/pty-host-backend-fixture.ts';
import { installedApp } from '../helpers/restart-installed-fixture.ts';
import { readRuntime, webDistCopy } from '../helpers/restart-fixture.ts';

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
  await teardownHosts();
});

test('a new version that cannot adopt the pty-host: 409 sessions-would-end and nothing changed; endSessions restarts and ends them as shutdown', async () => {
  const app = installedApp([{ name: 'v1' }, { name: 'v2', ptyProtocol: 2 }]);
  cleanups.push(() => app.remove());
  const server = await startTestServer({ entry: app.entry, cwd: join(app.root, 'current') });
  cleanups.push(() => server.stop());
  const info = await createSession(server, {
    cwd: '/tmp',
    command: 'bash',
    args: ['-c', 'echo "pid $$"; sleep 300'],
    title: 'held-by-v1',
    cols: 80,
    rows: 24,
  });
  const ws = await WsClient.connect(wsUrl(server, info.id));
  const pid = shellPid(await ws.waitForOutput('pid '));
  await ws.close();
  trackPty(pid);
  const hostPid = hostPidOf(server.dataDir);
  trackHost(hostPid);
  app.point('v2');

  // 1. Asked plainly: refused, before anything is torn down.
  const refused = await api(server, 'POST', '/api/restart');
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.deepEqual(refused.body, {
    error: 'The running sessions cannot be kept through this restart.',
    code: 'sessions-would-end',
  });
  const log = await readServerLog(server);
  assert.match(
    log,
    /\[pty-host\] probe: the pty-host refused this code \(proto; it speaks protocol 1, this code 2\): its sessions cannot be kept/,
    'the v2 standby probed the v1 pty-host and said why',
  );
  assert.match(log, /\[restart\] preflight: standby backend ready \(pid \d+\), booted and holding; port hint \d+; pty-host incompatible/);
  assert.equal((await api(server, 'GET', '/health')).status, 200, 'the old backend still serves');
  assert.equal(readRuntime(server.runtimeFile)?.pid, server.child.pid, 'runtime.json still names it');
  const still = ((await api(server, 'GET', '/api/sessions')).body as SessionInfo[]).find((s) => s.id === info.id);
  assert.equal(still?.status, 'running', 'the session is untouched');
  assert.equal(pidAlive(pid), true, 'its process too');
  assert.equal(readHistory(server.dataDir).find((e: HistoryEntry) => e.sessionId === info.id)?.ended, null, 'history untouched');

  // 2. "Restart anyway": the handoff goes ahead and the session ends as a shutdown.
  const res = await api(server, 'POST', '/api/restart', { endSessions: true });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  const child = await waitUntil(() => {
    const rt = readRuntime(server.runtimeFile);
    return rt !== undefined && rt.pid !== server.child.pid ? rt : undefined;
  }, 'the v2 backend to take over', 60_000);
  cleanups.push(async () => {
    if (pidAlive(child.pid)) process.kill(child.pid, 'SIGTERM');
    await waitUntil(() => (pidAlive(child.pid) ? undefined : true), 'the v2 backend to stop');
  });
  assert.equal(child.appDir, app.dir('v2'));
  await waitUntil(() => (pidAlive(pid) ? undefined : true), 'the session to be ended');
  await waitUntil(() => (pidAlive(hostPid) ? undefined : true), 'the v1 pty-host to be gone');
  const entry = readHistory(server.dataDir).find((e: HistoryEntry) => e.sessionId === info.id);
  assert.equal(entry?.ended?.reason, 'shutdown', 'resumable from History, exactly as before D9');
  const listed = await fetch(`http://127.0.0.1:${child.port}/api/sessions`, { headers: { 'x-auth-token': child.token } });
  assert.deepEqual((await listed.json()) as SessionInfo[], [], 'the new backend adopted nothing');
  assert.match(await readServerLog(server), /\[restart\] the sessions end with this backend \(history: 'shutdown'\)/);
});

test('a compatible pty-host the standby cannot reach: 409, then "Restart anyway" ends the sessions there and the new backend adopts nothing', async () => {
  const web = webDistCopy();
  cleanups.push(() => web.remove());
  const dataDir = await makeHostDir('d9-restart-none-');
  const server = await startTestServer({ dataDir, ptyHost: 'socket', env: { AI_SM_WEB_DIST_DIR: web.served } });
  cleanups.push(() => server.stop());
  const info = await createSession(server, { cwd: '/tmp', command: 'bash', args: ['-c', 'echo "pid $$"; sleep 300'], cols: 80, rows: 24 });
  const ws = await WsClient.connect(wsUrl(server, info.id));
  const pid = shellPid(await ws.waitForOutput('pid '));
  await ws.close();
  trackPty(pid);
  const hostPid = hostPidOf(dataDir);
  trackHost(hostPid);
  // The standby finds no state file: it cannot ask the pty-host anything.
  renameSync(join(dataDir, 'pty-host.json'), join(dataDir, 'pty-host.json.away'));

  const refused = await api(server, 'POST', '/api/restart');
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal((refused.body as { code?: string }).code, 'sessions-would-end');
  assert.match(await readServerLog(server), /preflight: standby backend ready \(pid \d+\), booted and holding; port hint \d+; pty-host none/);
  assert.equal(pidAlive(pid), true, 'nothing ended on the refusal');

  const res = await api(server, 'POST', '/api/restart', { endSessions: true });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  const child = await waitUntil(() => {
    const rt = readRuntime(server.runtimeFile);
    return rt !== undefined && rt.pid !== server.child.pid ? rt : undefined;
  }, 'the new backend to take over', 60_000);
  cleanups.push(async () => {
    if (pidAlive(child.pid)) process.kill(child.pid, 'SIGTERM');
    await waitUntil(() => (pidAlive(child.pid) ? undefined : true), 'the new backend to stop');
  });
  await waitUntil(() => (pidAlive(pid) ? undefined : true), 'the session to be ended');
  await waitUntil(() => (pidAlive(hostPid) ? undefined : true), 'the pty-host to leave');
  assert.match(hostLog(dataDir), /shutting down \(the owner asked\)/, "the old backend's shutdown-all reached the pty-host");
  const listed = await fetch(`http://127.0.0.1:${child.port}/api/sessions`, { headers: { 'x-auth-token': child.token } });
  assert.deepEqual((await listed.json()) as SessionInfo[], [], 'the new backend adopted nothing');
  const entry = readHistory(dataDir).find((e: HistoryEntry) => e.sessionId === info.id);
  assert.equal(entry?.ended?.reason, 'shutdown', 'resumable from History');
});
