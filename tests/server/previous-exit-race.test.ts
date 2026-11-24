/**
 * The exit record when the pty-host goes first — PLAN-QUALITY Q17 P1 fix
 * round (`.claude/plans/quality/PLAN-Q17.md` § P1 1): on a WSL poweroff every
 * process gets SIGTERM at once, and the pty-host (with its PTYs) can end
 * before the backend's own handler runs — the 2026-11-24 log has the pty-host
 * 9 ms ahead. The sessions it held were still the ones running at the stop,
 * so the record must list them (server/history.ts `runningAt`).
 *
 * How: a real backend over a real pty-host (`ptyHost: 'socket'`), a presence
 * socket for the open window, a bash session; the test SIGTERMs the pty-host
 * by the pid in the data dir's `pty-host.json`, waits for the history stamp,
 * SIGTERMs the backend, then boots the next run on the same data dir.
 *
 * Why it matters: without this the notice after the incident would say "0
 * sessions" and resume nothing — the user's decision 2 broken in the one
 * case it was made for.
 *
 * NOT claimed: a real VM poweroff; the order the kernel really delivers.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PreviousExitResumeResponse } from '../../shared/protocol.ts';
import { api, createSession, presenceUrl, startTestServer, waitUntil, WsClient, type TestServer } from '../helpers/helpers.ts';
import { makeHostDir, teardownHosts, trackHost } from '../helpers/pty-host-fixture.ts';
import { hostPidOf, pidAlive, readHistory } from '../helpers/pty-host-backend-fixture.ts';

const servers: TestServer[] = [];
after(async () => {
  for (const s of servers) await s.stop();
  await teardownHosts();
});

test('a pty-host that ends just before the backend\'s SIGTERM: the record still lists its sessions, and resume brings them back', async () => {
  const dataDir = await makeHostDir('q17-race-');
  const first = await startTestServer({ dataDir, ptyHost: 'socket' });
  servers.push(first);
  const presence = await WsClient.connect(presenceUrl(first));
  const info = await createSession(first, { command: 'bash', args: ['-c', 'sleep 300'], cwd: '/tmp', cols: 80, rows: 24 });
  const hostPid = hostPidOf(dataDir);
  trackHost(hostPid);

  process.kill(hostPid, 'SIGTERM');
  const ended = await waitUntil(
    () => readHistory(dataDir).find((e) => e.id === info.id && e.ended !== null)?.ended ?? undefined,
    'the session to be stamped ended after its pty-host went',
  );
  assert.ok(ended.reason === 'exit' || ended.reason === 'crash', `ended as ${ended.reason}`);
  await waitUntil(() => (pidAlive(hostPid) ? undefined : true), 'the pty-host to exit');

  first.child.kill('SIGTERM');
  await first.exit;
  await presence.close();
  const record = JSON.parse(readFileSync(join(dataDir, 'last-exit.json'), 'utf8')) as { why: string; presence: number; sessions: string[] };
  assert.deepEqual([record.why, record.presence, record.sessions], ['signal', 1, [info.id]]);

  const next = await startTestServer({ dataDir, ptyHost: 'socket' });
  servers.push(next);
  assert.equal(((await api(next, 'GET', '/api/previous-exit')).body as { sessions: number }).sessions, 1);
  const res = await api(next, 'POST', '/api/previous-exit/resume');
  const answer = res.body as PreviousExitResumeResponse;
  assert.deepEqual(answer.failed, []);
  assert.deepEqual(answer.resumed.map((r) => [r.historyId, r.previousSessionId, r.session.status]), [[info.id, info.id, 'running']]);
});
