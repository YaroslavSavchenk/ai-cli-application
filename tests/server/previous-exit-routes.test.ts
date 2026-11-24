/**
 * The previous run's end through a real backend — PLAN-QUALITY Q17 P1
 * (`.claude/plans/quality/PLAN-Q17.md` § P1 — backend, § Test gate): the exit
 * record a SIGTERM with a window open writes, and the next boot's
 * GET /api/previous-exit, POST /api/previous-exit/resume (the history resume
 * path, idempotent, the 409 for a live session) and
 * POST /api/previous-exit/dismiss; a SIGKILL that leaves a `crash`; the
 * presence-grace stop that tells nothing.
 *
 * How: one temp data dir and five backend runs in a row (`startTestServer`
 * with `dataDir`, in-process PTYs: the claim is what a run leaves for the
 * next, and a SIGKILLed backend's in-process PTYs die with it). Real bash
 * sessions; a presence socket stands for the open window. The tests are one
 * chain — each run is set up by the test before it, so they stay in this
 * file, in this order.
 *
 * Why it matters: this is what the user sees after WSL went down — a notice
 * and one button that brings the sessions back. A second press must not
 * spawn them twice; a clean close of the window must not raise a notice.
 *
 * NOT claimed: the VM-reboot and OOM branches (the journal cannot be faked
 * in a real backend — `previous-exit-store.test.ts` drives them through the
 * seam); a restart handoff (`restart-survive.test.ts`); the browser's notice
 * and pane remap (Q17 P3).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PreviousExitNotice,
  PreviousExitResumeResponse,
  SessionInfo,
} from '../../shared/protocol.ts';
import {
  api,
  createSession,
  makeTempDir,
  presenceUrl,
  rawRequest,
  removeTempDir,
  startTestServer,
  waitForLog,
  WsClient,
  type TestServer,
} from '../helpers/helpers.ts';
import type { ExitRecord } from '../../server/previous-exit-model.ts';

const world = {
  root: '',
  dataDir: '',
  server: undefined as TestServer | undefined,
  /** Run 1's live session: its id is its history id (bash is no conversation). */
  live: '',
  killed: '',
  resumed: '',
};

after(async () => {
  await world.server?.stop();
  if (world.root !== '') await removeTempDir(world.root);
});

async function boot(env: Record<string, string> = {}): Promise<TestServer> {
  if (world.root === '') {
    world.root = await makeTempDir('ai-sm-prev-exit-');
    world.dataDir = join(world.root, 'data');
  }
  world.server = await startTestServer({ dataDir: world.dataDir, ptyHost: 'inproc', env });
  return world.server;
}

function running(): TestServer {
  if (world.server === undefined) throw new Error('no backend is running');
  return world.server;
}

async function stop(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  const server = running();
  server.child.kill(signal);
  await server.exit;
  world.server = undefined;
}

function recordOnDisk(): ExitRecord {
  return JSON.parse(readFileSync(join(world.dataDir, 'last-exit.json'), 'utf8')) as ExitRecord;
}

const bash = (server: TestServer, script: string): Promise<SessionInfo> =>
  createSession(server, { command: 'bash', args: ['-c', script], cwd: '/tmp', cols: 80, rows: 24 });

test('SIGTERM with a window open writes the exit record before the sessions end: ids only, 0600', async () => {
  const server = await boot();
  const presence = await WsClient.connect(presenceUrl(server));
  world.live = (await bash(server, 'sleep 300')).id;
  // Closed by the user: never "running at the stop", however recent (an
  // exit/crash in the last 3 s would count — previous-exit-race.test.ts).
  world.killed = (await bash(server, 'sleep 300')).id;
  assert.equal((await api(server, 'DELETE', `/api/sessions/${world.killed}`)).status, 200);
  await stop('SIGTERM');
  await presence.close();
  const record = recordOnDisk();
  assert.equal(record.why, 'signal');
  assert.equal(record.signal, 'SIGTERM');
  assert.equal(record.presence, 1, 'the open window');
  assert.deepEqual(record.sessions, [world.live], 'the live session only, by history id; the one the user closed is not running');
  assert.equal(record.bootId, readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
  assert.ok(Date.parse(record.startedAt) <= Date.parse(record.at));
  assert.equal(statSync(join(world.dataDir, 'last-exit.json')).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(record).sort(), ['at', 'bootId', 'presence', 'sessions', 'signal', 'startedAt', 'why']);
});

test('the next boot (same VM) answers GET /api/previous-exit with `stopped` and one session, and logs the verdict', async () => {
  const server = await boot();
  const res = await api(server, 'GET', '/api/previous-exit');
  assert.equal(res.status, 200);
  const notice = res.body as PreviousExitNotice;
  assert.deepEqual(notice, { at: recordOnDisk().at, cause: 'stopped', detail: null, sessions: 1 });
  await waitForLog(server, `[previous-exit] previous run: stopped at ${notice.at}; 1 session(s) to resume`);
});

test('the routes are authed, method-checked and body-capped like every /api route; a refusal resumes nothing', async () => {
  const server = running();
  const anon = await rawRequest(server.port, { method: 'GET', path: '/api/previous-exit' });
  assert.equal(anon.status, 401);
  const wrongGet = await api(server, 'GET', '/api/previous-exit/resume');
  assert.deepEqual([wrongGet.status, wrongGet.body], [405, { error: 'method not allowed' }]);
  const wrongPost = await api(server, 'POST', '/api/previous-exit');
  assert.equal(wrongPost.status, 405);
  const big = await api(server, 'POST', '/api/previous-exit/resume', { pad: 'x'.repeat(2048) });
  assert.deepEqual([big.status, big.body], [413, { error: 'request body is too large' }]);
  assert.equal(big.headers.get('connection'), 'close', 'a refused body is not drained: the connection is closed');
  assert.equal((await api(server, 'GET', '/api/previous-exit')).status, 200, 'still there');
  assert.deepEqual((await api(server, 'GET', '/api/sessions')).body, [], 'nothing spawned');
});

test('POST resume brings the session back once, naming the old session id; a second call resumes nothing', async () => {
  const server = running();
  const res = await api(server, 'POST', '/api/previous-exit/resume', {});
  assert.equal(res.status, 200);
  const answer = res.body as PreviousExitResumeResponse;
  assert.deepEqual(answer.failed, []);
  assert.equal(answer.resumed.length, 1);
  const [one] = answer.resumed;
  assert.equal(one?.historyId, world.live);
  assert.equal(one?.previousSessionId, world.live, 'the id a saved layout still names');
  assert.notEqual(one?.session.id, world.live, 'a new session');
  assert.equal(one?.session.status, 'running');
  world.resumed = one?.session.id ?? '';
  const again = await api(server, 'POST', '/api/previous-exit/resume');
  assert.deepEqual([again.status, again.body], [200, { resumed: [], failed: [] }]);
  assert.equal(((await api(server, 'GET', '/api/sessions')).body as SessionInfo[]).length, 1, 'spawned once');
  const gone = await api(server, 'GET', '/api/previous-exit');
  assert.deepEqual([gone.status, gone.body], [204, ''], 'nothing left to tell');
  assert.equal(recordOnDisk().seen, true, 'the record is marked seen, not deleted');
  await waitForLog(server, '[previous-exit] notice consumed by resume (stopped, 1 session(s))');
  await waitForLog(server, 'previous-exit resume: 1 resumed, 0 failed');
});

test('a SIGKILLed backend leaves a `crash`: the session it ran is offered at the next boot', async () => {
  await stop('SIGKILL');
  const server = await boot();
  const res = await api(server, 'GET', '/api/previous-exit');
  assert.equal(res.status, 200);
  const notice = res.body as PreviousExitNotice;
  assert.deepEqual({ ...notice, at: '' }, { at: '', cause: 'crash', detail: null, sessions: 1 });
});

test('a session already running again fails with the history route\'s 409 sentence, and nothing is spawned twice', async () => {
  const server = running();
  const first = await api(server, 'POST', `/api/history/${world.live}/resume`, { cols: 80, rows: 24 });
  assert.equal(first.status, 201);
  const res = await api(server, 'POST', '/api/previous-exit/resume');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { resumed: [], failed: [{ historyId: world.live, error: 'that session is still running' }] });
  assert.equal(((await api(server, 'GET', '/api/sessions')).body as SessionInfo[]).length, 1);
});

test('POST dismiss answers 204, the notice is gone and the record is marked seen', async () => {
  const presence = await WsClient.connect(presenceUrl(running()));
  await stop('SIGTERM');
  await presence.close();
  const server = await boot({ AI_SM_GRACE_MS: '200' });
  assert.equal((await api(server, 'GET', '/api/previous-exit')).status, 200);
  const res = await api(server, 'POST', '/api/previous-exit/dismiss');
  assert.deepEqual([res.status, res.body], [204, '']);
  // Test gate 2026-11-24: dismiss and resume look alike on the wire once
  // nothing is left; the log line tells a dismiss that took the ids apart.
  await waitForLog(server, '[previous-exit] notice consumed by dismiss (stopped, 1 session(s))');
  assert.equal((await api(server, 'GET', '/api/previous-exit')).status, 204);
  assert.equal(recordOnDisk().seen, true);
  const again = await api(server, 'POST', '/api/previous-exit/dismiss');
  assert.equal(again.status, 204, 'dismiss is idempotent');
});

test('closing the last window (presence grace) writes `presence-grace` and the next boot tells nothing', async () => {
  const server = running();
  const presence = await WsClient.connect(presenceUrl(server));
  await presence.close();
  await server.exit;
  world.server = undefined;
  const record = recordOnDisk();
  assert.deepEqual([record.why, record.presence, record.signal], ['presence-grace', 0, undefined]);
  assert.deepEqual(record.sessions, [], 'nothing ran in that run (the SIGTERM before it ended the last session)');
  const next = await boot();
  assert.equal((await api(next, 'GET', '/api/previous-exit')).status, 204);
});
