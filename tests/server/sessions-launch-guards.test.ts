/**
 * The two launch routes' D9 P3 refusals — server/api-sessions.ts, Nocturne D9
 * P3 (`.claude/plans/nocturne/PLAN-D9.md` § Risks (c); the title cap from the
 * P3 security review F2):
 *   - a second launch of a conversation (POST /api/sessions with the client's
 *     own `--resume <uuid>`) or of a history entry (POST
 *     /api/history/:id/resume) while the first one's spawn is still in flight
 *     is a 409 with the route's own sentence — never a 500, never a second
 *     process on one transcript;
 *   - a title over TITLE_MAX_CHARS is a 400 and spawns nothing.
 *
 * How: `sessionRoutes` on a plain in-process HTTP server, over a real
 * SessionManager and SessionHistory whose PTY host is the recording fake
 * (tests/helpers/fake-pty-host.ts) — its `hold` keeps the first spawn
 * unanswered, so the in-flight window is open for as long as the test needs.
 * A real backend over a real pty-host leaves that window open for
 * microseconds only (`pty-host-lost.test.ts` races it with two requests).
 *
 * Why it matters: the 409 is what the browser shows as "already running";
 * a 500 reads as a broken app, and without the guard both launches spawn.
 *
 * NOT claimed: the route's earlier 409 on a live history entry
 * (`sessions-resume-live.test.ts`), the browser's handling of either answer.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TITLE_MAX_CHARS } from '../../shared/protocol.ts';
import { CONVERSATION_RUNNING, sessionRoutes } from '../../server/api-sessions.ts';
import type { ApiContext } from '../../server/api-http.ts';
import { removeTempDir, waitUntil } from '../helpers/helpers.ts';
import { fakeHostManager, fakePtyHost, type FakePtyHost } from '../helpers/fake-pty-host.ts';
import { infoOf } from '../helpers/history-fixture.ts';

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await removeTempDir(d);
});

const CONVERSATION = '3c9d1f2e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

interface Rig {
  host: FakePtyHost;
  history: Awaited<ReturnType<typeof fakeHostManager>>['history'];
  post: (path: string, body: unknown) => Promise<{ status: number; body: unknown }>;
  close: () => Promise<void>;
}

async function rig(hold: boolean): Promise<Rig> {
  const host = fakePtyHost({ hold });
  const { sessions, history } = await fakeHostManager(host, dirs);
  const ctx = { projects: { get: () => undefined }, sessions, history, log: () => {} } as unknown as ApiContext;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void sessionRoutes(ctx, req.method ?? 'GET', url.pathname, url, req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    host,
    history,
    post: async (path, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
    // A held spawn is answered first, so a failed assertion never leaves its
    // request open and the close waiting on it.
    close: () => {
      for (const req of host.spawned) host.answer(req.id);
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

test('a second POST /api/sessions resuming a conversation whose spawn is in flight is 409, and spawns nothing', async () => {
  const r = await rig(true);
  try {
    const launch = { command: 'claude', args: ['--resume', CONVERSATION], cwd: '/tmp', cols: 80, rows: 24 };
    const first = r.post('/api/sessions', launch);
    await waitUntil(() => (r.host.spawned.length === 1 ? true : undefined), 'the first spawn to be asked for');
    const second = await r.post('/api/sessions', launch);
    assert.deepEqual(second, { status: 409, body: { error: CONVERSATION_RUNNING } });
    assert.equal(r.host.spawned.length, 1, 'the refused launch spawned nothing');
    r.host.answer(r.host.spawned[0]?.id as string);
    assert.equal((await first).status, 201, 'the first launch goes through');
  } finally {
    await r.close();
  }
});

test('a second resume of a history entry whose spawn is in flight is 409 "that session is still running"', async () => {
  const r = await rig(true);
  try {
    r.history.recordCreate(infoOf({ id: 'earlier-session', command: 'bash', cwd: '/tmp' }), { id: 'entry-1', conversation: false, baseArgs: [] });
    r.history.markEnded('earlier-session', 'exit', 0);
    const first = r.post('/api/history/entry-1/resume', { cols: 80, rows: 24 });
    await waitUntil(() => (r.host.spawned.length === 1 ? true : undefined), 'the first spawn to be asked for');
    const second = await r.post('/api/history/entry-1/resume', { cols: 80, rows: 24 });
    assert.deepEqual(second, { status: 409, body: { error: 'that session is still running' } });
    assert.equal(r.host.spawned.length, 1, 'the refused resume spawned nothing');
    r.host.answer(r.host.spawned[0]?.id as string);
    assert.equal((await first).status, 201);
  } finally {
    await r.close();
  }
});

test(`a title over ${TITLE_MAX_CHARS} characters is 400 and spawns nothing; one at the cap is taken`, async () => {
  const r = await rig(false);
  try {
    const launch = { command: 'bash', args: [], cwd: '/tmp', cols: 80, rows: 24 };
    const over = await r.post('/api/sessions', { ...launch, title: 'x'.repeat(TITLE_MAX_CHARS + 1) });
    assert.deepEqual(over, { status: 400, body: { error: `title must be at most ${TITLE_MAX_CHARS} characters` } });
    assert.equal(r.host.spawned.length, 0, 'nothing was spawned for the refused launch');
    const at = await r.post('/api/sessions', { ...launch, title: 'x'.repeat(TITLE_MAX_CHARS) });
    assert.equal(at.status, 201);
    assert.equal((at.body as { title?: string }).title, 'x'.repeat(TITLE_MAX_CHARS));
  } finally {
    await r.close();
  }
});
