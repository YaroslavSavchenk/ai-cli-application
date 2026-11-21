/**
 * Restart service over a real pty-host — Nocturne D9 P3
 * (`.claude/plans/nocturne/PLAN-D9.md` § Phases P3: "Restart/update still END
 * sessions in P3 (P4 changes that) — but the restart teardown also ends
 * pty-host sessions, not just in-process ones").
 *
 * How: one REAL restart (POST /api/restart, a real vite build into a copy of
 * web/dist, a real standby child) of a backend in socket mode, with a bash PTY
 * held by the pty-host it started. The same restart in-process is
 * `restart-real.test.ts`. Every pty-host and PTY group is ended in `after`.
 *
 * Why it matters: the teardown used to end the PTYs it owned itself; with a
 * pty-host they would otherwise live on (orphaned for 10 minutes, or picked
 * up by the new backend while history already says `shutdown`).
 *
 * NOT claimed: sessions SURVIVING a restart — that is P4, which inverts this
 * file's verdict.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryEntry, SessionInfo } from '../../shared/protocol.ts';
import { api, createSession, startTestServer, waitUntil, wsUrl, WsClient, type TestServer } from '../helpers/helpers.ts';
import { makeHostDir, teardownHosts, trackHost, trackPty } from '../helpers/pty-host-fixture.ts';
import { hostPidOf, pidAlive, readHistory, shellPid, stopDataDirPtyHost } from '../helpers/pty-host-backend-fixture.ts';
import { readRuntime, webDistCopy } from '../helpers/restart-fixture.ts';

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
  await teardownHosts();
});

test('a restart in P3 ends the pty-host sessions and the pty-host; the new backend adopts nothing', async () => {
  const web = webDistCopy();
  cleanups.push(() => web.remove());
  const dataDir = await makeHostDir('d9-restart-');
  const server: TestServer = await startTestServer({ dataDir, ptyHost: 'socket', env: { AI_SM_WEB_DIST_DIR: web.served } });
  cleanups.push(() => server.stop());
  const info = await createSession(server, { cwd: '/tmp', command: 'bash', args: ['-c', 'echo "pid $$"; sleep 300'], cols: 80, rows: 24 });
  const ws = await WsClient.connect(wsUrl(server, info.id));
  const pid = shellPid(await ws.waitForOutput('pid '));
  await ws.close();
  trackPty(pid);
  const hostPid = hostPidOf(dataDir);
  trackHost(hostPid);

  const res = await api(server, 'POST', '/api/restart');
  assert.equal(res.status, 202, JSON.stringify(res.body));
  const child = await waitUntil(() => {
    const rt = readRuntime(server.runtimeFile);
    return rt !== undefined && rt.pid !== server.child.pid ? rt : undefined;
  }, 'the new backend to take over', 120_000);
  cleanups.push(async () => {
    if (pidAlive(child.pid)) process.kill(child.pid, 'SIGTERM');
    await waitUntil(() => (pidAlive(child.pid) ? undefined : true), 'the new backend to stop');
    await stopDataDirPtyHost(dataDir);
  });

  await waitUntil(() => (pidAlive(pid) ? undefined : true), 'the session to be ended by the teardown');
  await waitUntil(() => (pidAlive(hostPid) ? undefined : true), 'the pty-host to exit');
  const listed = await fetch(`http://127.0.0.1:${child.port}/api/sessions`, { headers: { 'x-auth-token': child.token } });
  assert.deepEqual((await listed.json()) as SessionInfo[], [], 'the new backend adopted nothing');
  const entry = readHistory(dataDir).find((e: HistoryEntry) => e.sessionId === info.id);
  assert.equal(entry?.ended?.reason, 'shutdown', 'history says shutdown, as before D9');
});
