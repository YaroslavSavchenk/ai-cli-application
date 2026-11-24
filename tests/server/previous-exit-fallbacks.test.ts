/**
 * The previous run's end off the main road — PLAN-QUALITY Q17 P1
 * (`.claude/plans/quality/PLAN-Q17.md` § P1): what the backend does when the
 * notice names a session that History no longer has, when the backend itself
 * died of an uncaught exception, and when a process was built without the
 * previous-exit store at all.
 *
 * How: a real backend child (`startTestServer`, one temp data dir, in-process
 * PTYs, runs in a row — each test's run is set up by the one before it, so
 * they stay in this order); the uncaught exception is a real one, thrown by a
 * module preloaded through NODE_OPTIONS on SIGUSR2 (no seam in the server).
 * The unwired process is the in-process request handler of
 * `helpers/logging-fixture.ts`, which builds no `previousExit`.
 *
 * Why it matters: the test gate of 2026-11-24 found these three paths
 * untested — a mutant that dropped the `history entry not found` row, one
 * that dropped the uncaught path's exit record, and one that answered 200
 * instead of 503 without a store all passed the suite. A dropped row is a
 * session the user is never told about; a missing record after a crash is a
 * notice that cannot say what ran.
 *
 * NOT claimed: the main road — `previous-exit-routes.test.ts`; the verdict's
 * rules — `previous-exit-model.test.ts`.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PreviousExitNotice, SessionInfo } from '../../shared/protocol.ts';
import type { ExitRecord } from '../../server/previous-exit-model.ts';
import {
  api,
  createSession,
  makeTempDir,
  presenceUrl,
  rawRequest,
  removeTempDir,
  settleWithin,
  startTestServer,
  WsClient,
  type TestServer,
} from '../helpers/helpers.ts';
import { withInProcessApi } from '../helpers/logging-fixture.ts';

const world = { root: '', dataDir: '', server: undefined as TestServer | undefined };

after(async () => {
  await world.server?.stop();
  if (world.root !== '') await removeTempDir(world.root);
});

async function boot(env: Record<string, string> = {}): Promise<TestServer> {
  if (world.root === '') {
    world.root = await makeTempDir('ai-sm-prev-exit-fallbacks-');
    world.dataDir = join(world.root, 'data');
  }
  world.server = await startTestServer({ dataDir: world.dataDir, ptyHost: 'inproc', env });
  return world.server;
}

function recordOnDisk(): ExitRecord {
  return JSON.parse(readFileSync(join(world.dataDir, 'last-exit.json'), 'utf8')) as ExitRecord;
}

const bash = (server: TestServer): Promise<SessionInfo> =>
  createSession(server, { command: 'bash', args: ['-c', 'sleep 300'], cwd: '/tmp', cols: 80, rows: 24 });

/** How long a SIGTERMed or crashing backend may take to leave (a loaded runner). */
const EXIT_WAIT_MS = 10_000;

async function stopWith(signal: 'SIGTERM' | 'SIGUSR2', code: number): Promise<void> {
  const server = world.server;
  assert.ok(server, 'a backend is running');
  server.child.kill(signal);
  const exit = await settleWithin(server.exit, EXIT_WAIT_MS);
  assert.ok(exit !== undefined, `the backend did not exit within ${EXIT_WAIT_MS} ms`);
  assert.equal(exit.code, code, `exit code (signal ${String(exit.signal)})`);
  world.server = undefined;
}

test('a notice whose session History has forgotten since: resume answers it as a failed row, nothing spawned', async () => {
  const first = await boot();
  const presence = await WsClient.connect(presenceUrl(first));
  const live = (await bash(first)).id;
  await stopWith('SIGTERM', 0);
  await presence.close();

  const server = await boot();
  assert.equal((await api(server, 'GET', '/api/previous-exit')).status, 200, 'the notice is there');
  assert.equal((await api(server, 'DELETE', `/api/history/${live}`)).status, 200, 'the user forgets the entry');
  const res = await api(server, 'POST', '/api/previous-exit/resume');
  assert.deepEqual(
    [res.status, res.body],
    [200, { resumed: [], failed: [{ historyId: live, error: 'history entry not found' }] }],
    'the forgotten session is named, not silently dropped',
  );
  assert.deepEqual((await api(server, 'GET', '/api/sessions')).body, [], 'nothing spawned');
});

test('an uncaught exception writes an `other` record with the live sessions; the next boot tells a crash and supersedes it', async () => {
  // The previous test's backend is still up: stop it cleanly first.
  await stopWith('SIGTERM', 0);
  const preload = `data:text/javascript,${encodeURIComponent(
    "process.on('SIGUSR2', () => { throw new Error('q17 uncaught'); });",
  )}`;
  const server = await boot({ NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --import=${preload}`.trim() });
  const presence = await WsClient.connect(presenceUrl(server));
  const live = (await bash(server)).id;
  await stopWith('SIGUSR2', 1);
  await presence.close();

  const record = recordOnDisk();
  assert.deepEqual([record.why, record.signal, record.presence], ['other', undefined, 1]);
  assert.deepEqual(record.sessions, [live], 'the session that was running, by history id');

  const next = await boot();
  const res = await api(next, 'GET', '/api/previous-exit');
  assert.equal(res.status, 200);
  assert.deepEqual(
    { ...(res.body as PreviousExitNotice), at: '' },
    { at: '', cause: 'crash', detail: null, sessions: 1 },
    'its history entry was stamped crash at this boot: the unexpected stop is told',
  );
  assert.equal(recordOnDisk().seen, true, 'the `other` record is superseded for good');
});

test('a process built without the previous-exit store answers 503 on all three routes, never a fake 204', async () => {
  await withInProcessApi(async (ctx) => {
    for (const [method, path] of [
      ['GET', '/api/previous-exit'],
      ['POST', '/api/previous-exit/resume'],
      ['POST', '/api/previous-exit/dismiss'],
    ] as const) {
      const res = await rawRequest(ctx.port, { method, path, headers: { 'x-auth-token': ctx.token } });
      assert.deepEqual(
        [res.status, JSON.parse(res.body) as unknown],
        [503, { error: 'the previous run is not known to this server' }],
        `${method} ${path}`,
      );
    }
  });
});
