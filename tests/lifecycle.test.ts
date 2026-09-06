/**
 * Lifecycle-bound backend: presence channel, grace timers, persistent session
 * history (decided 2026-07-19; history replaced the journal 2026-09-06).
 *
 * Contract under test:
 *  - startup grace (AI_SM_STARTUP_GRACE_MS): no client ever -> clean exit 0,
 *    runtime.json removed;
 *  - a presence WS or a session WS cancels the shutdown timer; the last
 *    disconnect arms the regular grace (AI_SM_GRACE_MS); reconnect within
 *    the grace cancels it;
 *  - clean shutdown stamps live history entries 'shutdown'; a SIGKILL leaves
 *    ended:null entries that the next boot stamps 'crash' in history.json;
 *  - GET /api/history lists EVERY ended entry — 'user-kill', 'exit',
 *    'shutdown' and 'crash' alike — across runs, DELETE forgets one/all,
 *    auth like all /api;
 *  - /ws/presence is auth-gated pre-upgrade exactly like the session WS.
 *
 * Determinism: every state transition is observed via the controller's
 * server.log lines (timer armed / cancelled / expired) or process exit —
 * never a bare sleep. The only wall-clock waits are the *survival* asserts
 * ("the server must still be alive after the uncancelled timer would have
 * fired"), which are bounded from a recorded upper bound of the arm time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { HistoryEntry } from '../shared/protocol.ts';
import {
  api,
  createSession,
  getSession,
  presenceUrl,
  rawRequest,
  readServerLog,
  startTestServer,
  waitForLog,
  waitUntil,
  wsExpectRejected,
  wsUrl,
  WsClient,
  type ExitInfo,
  type TestServer,
} from './helpers.ts';

/** Await the server's exit within `timeoutMs` (fails the test otherwise). */
async function expectExit(server: TestServer, timeoutMs: number): Promise<ExitInfo> {
  const result = await Promise.race([
    server.exit,
    delay(timeoutMs).then(() => undefined),
  ]);
  assert.ok(result !== undefined, `server did not exit within ${timeoutMs}ms`);
  return result;
}

/** Returns a live "has the server process exited?" probe. */
function exitFlag(server: TestServer): () => boolean {
  let exited = false;
  void server.exit.then(() => {
    exited = true;
  });
  return () => exited;
}

/** Sleep until wall-clock `deadline` (no-op if already past). */
async function waitUntilClock(deadline: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining > 0) await delay(remaining);
}

/** Assert the server is alive: process not exited AND /health answers 200. */
async function assertAlive(server: TestServer, exited: () => boolean, when: string): Promise<void> {
  assert.equal(exited(), false, `server process must still be alive ${when}`);
  const res = await fetch(`${server.baseUrl}/health`);
  assert.equal(res.status, 200, `/health must answer 200 ${when}`);
}

async function readHistoryFile(dataDir: string): Promise<HistoryEntry[]> {
  return JSON.parse(await readFile(join(dataDir, 'history.json'), 'utf8')) as HistoryEntry[];
}

test('startup grace: a backend no client ever connects to exits 0 and removes runtime.json', async () => {
  const server = await startTestServer({
    env: { AI_SM_STARTUP_GRACE_MS: '2000', AI_SM_GRACE_MS: '600000' },
  });
  try {
    assert.ok(existsSync(server.runtimeFile), 'runtime.json must exist while running');

    const exit = await expectExit(server, 15_000);
    assert.equal(exit.code, 0, `startup-grace shutdown must exit 0 (got ${exit.code}/${exit.signal})`);
    assert.equal(exit.signal, null);
    assert.ok(!existsSync(server.runtimeFile), 'runtime.json must be removed on idle shutdown');

    const log = await readServerLog(server);
    assert.ok(
      log.includes('startup grace timer armed (2000ms)'),
      'log must show the startup grace timer being armed with the env override',
    );
    assert.ok(
      log.includes('startup grace expired with no clients'),
      'log must attribute the shutdown to the startup grace',
    );
    assert.match(
      log,
      /received idle grace expiry, shutting down: sessions=\d+ presence=\d+ attached=\d+/,
      'idle expiry must reuse the clean shutdown path, and the ONE line carries the counts',
    );
  } finally {
    await server.stop();
  }
});

test('presence cancels the startup grace; last disconnect arms the REGULAR grace and expiry shuts down cleanly', async () => {
  const server = await startTestServer({
    env: { AI_SM_STARTUP_GRACE_MS: '2000', AI_SM_GRACE_MS: '700' },
  });
  const exited = exitFlag(server);
  try {
    // The startup timer was armed at listen, i.e. before startTestServer
    // returned — so it would fire no later than tReady + 2000.
    const tReady = Date.now();
    const presence = await WsClient.connect(presenceUrl(server));
    await waitForLog(server, 'shutdown timer cancelled (presence=1, attached=0)');

    // Survival assert: outlive the uncancelled startup deadline by a margin.
    await waitUntilClock(tReady + 2_600);
    await assertAlive(server, exited, 'past the startup grace while presence is connected');

    await presence.close();
    // (700ms) proves the REGULAR grace is armed now, not the startup grace.
    await waitForLog(server, 'grace timer armed (700ms)');

    const exit = await expectExit(server, 10_000);
    assert.equal(exit.code, 0, `idle-grace shutdown must exit 0 (got ${exit.code}/${exit.signal})`);
    assert.ok(!existsSync(server.runtimeFile), 'runtime.json must be removed on idle shutdown');

    const log = await readServerLog(server);
    assert.ok(log.includes('grace expired with no clients'), 'log must record the grace expiry');
  } finally {
    await server.stop();
  }
});

test('reconnect within the grace cancels shutdown; a second presence holds the server when the first closes', async () => {
  const server = await startTestServer({
    env: { AI_SM_STARTUP_GRACE_MS: '600000', AI_SM_GRACE_MS: '1200' },
  });
  const exited = exitFlag(server);
  try {
    const p1 = await WsClient.connect(presenceUrl(server));
    await waitForLog(server, 'shutdown timer cancelled (presence=1, attached=0)');
    const p2 = await WsClient.connect(presenceUrl(server));

    // Closing ONE of two presence sockets must not arm the timer. Proven
    // below: the armed-line count stays at exactly one (from p2's close).
    await p1.close();
    await p2.close();
    await waitForLog(server, 'grace timer armed (1200ms)');
    const tArmedSeen = Date.now(); // Upper bound of the arm time.

    const p3 = await WsClient.connect(presenceUrl(server));
    await waitForLog(server, 'shutdown timer cancelled', { count: 2 });

    // Survival assert: outlive the uncancelled grace deadline by a margin.
    await waitUntilClock(tArmedSeen + 1_800);
    await assertAlive(server, exited, 'after reconnecting within the grace');

    const log = await readServerLog(server);
    assert.equal(
      log.split('grace timer armed (1200ms)').length - 1,
      1,
      'the regular grace must have been armed exactly once (not when p1 of 2 closed)',
    );

    await p3.close();
  } finally {
    await server.stop();
  }
});

test('a session WS alone (zero presence) holds the server; its close leads to shutdown that records the running session as shutdown', async () => {
  const workDir = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-work-')));
  const server = await startTestServer({
    env: { AI_SM_STARTUP_GRACE_MS: '2500', AI_SM_GRACE_MS: '600000' },
  });
  const exited = exitFlag(server);
  try {
    const tReady = Date.now();
    const info = await createSession(server, {
      command: 'bash',
      args: ['-c', 'sleep 300'],
      cwd: workDir,
      cols: 80,
      rows: 24,
    });
    const client = await WsClient.connect(wsUrl(server, info.id));
    await client.waitForMessage('replay');
    await waitForLog(server, 'shutdown timer cancelled (presence=0, attached=1)');

    // Survival assert: the session WS alone must carry the server past the
    // startup grace deadline (armed at listen, before tReady).
    await waitUntilClock(tReady + 3_100);
    await assertAlive(server, exited, 'past the startup grace with only a session WS attached');

    await client.close();
    // No presence ever connected, so the re-armed timer is the startup grace
    // again (second occurrence of the armed line).
    await waitForLog(server, 'startup grace timer armed (2500ms)', { count: 2 });

    const exit = await expectExit(server, 15_000);
    assert.equal(exit.code, 0, `idle shutdown must exit 0 (got ${exit.code}/${exit.signal})`);
    assert.ok(!existsSync(server.runtimeFile), 'runtime.json must be removed');

    // The still-running session must be stamped 'shutdown' in the history.
    const entries = await readHistoryFile(server.dataDir);
    const entry = entries.find((e) => e.sessionId === info.id);
    assert.ok(entry !== undefined, 'the session must have a history entry');
    assert.equal(entry.ended?.reason, 'shutdown', 'a session killed by idle shutdown is recorded shutdown');
    assert.equal(new Date(entry.ended.at).toISOString(), entry.ended.at, 'ended.at must be ISO-8601');
  } finally {
    await server.stop();
    await rm(workDir, { recursive: true, force: true });
  }
});

test('history: every end reason is listed and persists across runs; SIGKILL stamps crash at boot; DELETE forgets; auth 401', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-lifecycle-'));
  const dataDir = join(root, 'data');
  const workDir = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-work-')));
  let running: TestServer | undefined;
  try {
    // --- Run A: one user-killed, one naturally exited, one left running ----
    const a = await startTestServer({ dataDir });
    running = a;

    const sKill = await createSession(a, {
      command: 'bash', args: ['-c', 'sleep 300'], cwd: workDir, cols: 80, rows: 24,
      title: 'killed by hand',
    });
    const del = await api(a, 'DELETE', `/api/sessions/${sKill.id}`);
    assert.equal(del.status, 200);

    const sExit = await createSession(a, {
      command: 'bash', args: ['-c', 'exit 5'], cwd: workDir, cols: 80, rows: 24,
    });
    await waitUntil(
      async () => {
        const s = await getSession(a, sExit.id);
        return s?.status === 'exited' ? true : undefined;
      },
      'the exit-5 session to be listed as exited',
      10_000,
    );

    const sLive = await createSession(a, {
      command: 'bash', args: ['-c', 'sleep 300'], cwd: workDir, cols: 80, rows: 24,
      title: 'crash me',
    });

    // history.json mirrors all three, correctly stamped. A non-claude session
    // is keyed by its own session id (no conversation to pin).
    const historyA = await readHistoryFile(dataDir);
    assert.equal(historyA.length, 3, 'history must contain one entry per created session');
    assert.equal(historyA.find((e) => e.id === sKill.id)?.ended?.reason, 'user-kill');
    const exitEntry = historyA.find((e) => e.id === sExit.id);
    assert.equal(exitEntry?.ended?.reason, 'exit');
    assert.equal(exitEntry?.exitCode, 5, 'a natural exit must record its exit code');
    assert.equal(historyA.find((e) => e.id === sLive.id)?.ended, null, 'live session stays ended:null');
    assert.equal(historyA.find((e) => e.id === sLive.id)?.sessionId, sLive.id);
    assert.equal(historyA.find((e) => e.id === sKill.id)?.conversation, false, 'bash is not a conversation');

    // The live one is NOT offered while it runs; the two ended ones are —
    // including the user-killed one, which the old /api/previous never showed.
    const listA = await api(a, 'GET', '/api/history');
    assert.equal(listA.status, 200);
    const offeredA = listA.body as HistoryEntry[];
    assert.deepEqual(
      new Set(offeredA.map((e) => e.ended?.reason)),
      new Set(['user-kill', 'exit']),
      `both ended reasons must be listed, got ${JSON.stringify(offeredA.map((e) => e.ended?.reason))}`,
    );
    assert.ok(offeredA.every((e) => e.id !== sLive.id), 'a live entry is never listed');

    // Hard crash: no chance to stamp anything.
    a.child.kill('SIGKILL');
    await a.exit;
    running = undefined;

    // --- Run B: boot stamps the still-open entry 'crash' --------------------
    const b = await startTestServer({ dataDir });
    running = b;
    const logB = await readServerLog(b);
    assert.ok(
      logB.includes("history loaded: 3 entries (1 stamped 'crash')"),
      `boot must log the load, got: ${logB.split('\n').filter((l) => l.includes('history')).join(' | ')}`,
    );
    assert.ok(existsSync(join(dataDir, 'history.json')), 'history.json must survive the run boundary');

    // Auth: /api/history is token-gated like every /api route.
    const noToken = await rawRequest(b.port, { path: '/api/history' });
    assert.equal(noToken.status, 401, 'GET /api/history without token must be 401');

    const listB = await api(b, 'GET', '/api/history');
    assert.equal(listB.status, 200);
    const offeredB = listB.body as HistoryEntry[];
    assert.equal(offeredB.length, 3, `all three entries must survive, got ${JSON.stringify(offeredB)}`);
    const crashed = offeredB.find((e) => e.id === sLive.id) as HistoryEntry;
    assert.ok(crashed !== undefined, 'the crashed session must still be there');
    assert.equal(crashed.ended?.reason, 'crash', 'an ended:null entry must be stamped crash at boot');
    assert.equal(new Date(crashed.ended.at).toISOString(), crashed.ended.at, 'ended.at must be ISO-8601');
    assert.equal(crashed.command, 'bash');
    assert.deepEqual(crashed.args, ['-c', 'sleep 300'], 'args must survive for resume');
    assert.equal(crashed.cwd, workDir, 'cwd must survive for resume');
    assert.equal(crashed.title, 'crash me', 'title must survive for resume');
    assert.equal(crashed.createdAt, sLive.createdAt);
    assert.equal(crashed.lastUsedAt, sLive.createdAt, 'lastUsedAt starts at the first launch');

    // Newest lastUsedAt first.
    const stamps = offeredB.map((e) => e.lastUsedAt);
    assert.deepEqual(stamps, [...stamps].sort().reverse(), `list must be newest-first, got ${stamps}`);

    // Method discipline on the collection route.
    const post = await api(b, 'POST', '/api/history');
    assert.equal(post.status, 405);

    // --- Run B -> C: clean shutdown records the running session 'shutdown' --
    const s2 = await createSession(b, {
      command: 'bash', args: ['-c', 'sleep 300'], cwd: workDir, cols: 80, rows: 24,
      title: 'survivor',
    });
    b.child.kill('SIGTERM');
    const exitB = await expectExit(b, 10_000);
    assert.equal(exitB.code, 0);
    running = undefined;

    const c = await startTestServer({ dataDir });
    running = c;
    const listC = await api(c, 'GET', '/api/history');
    const offeredC = listC.body as HistoryEntry[];
    assert.equal(offeredC.length, 4, 'the shutdown session joins the three older ones');
    assert.deepEqual(
      new Set(offeredC.map((e) => e.ended?.reason)),
      new Set(['user-kill', 'exit', 'crash', 'shutdown']),
      'all four end reasons must be listed',
    );
    const survivor = offeredC.find((e) => e.id === s2.id);
    assert.equal(survivor?.ended?.reason, 'shutdown');
    assert.equal(survivor?.title, 'survivor');
    assert.equal(offeredC[0]?.id, s2.id, 'the newest entry sorts first');

    // Forget one: unknown id 404, real id ok exactly once, disk updated.
    const unknown = await api(c, 'DELETE', '/api/history/no-such-id');
    assert.equal(unknown.status, 404);
    const forgotten = await api(c, 'DELETE', `/api/history/${sKill.id}`);
    assert.equal(forgotten.status, 200);
    assert.deepEqual(forgotten.body, { ok: true });
    const again = await api(c, 'DELETE', `/api/history/${sKill.id}`);
    assert.equal(again.status, 404, 'forgetting twice must 404 the second time');
    const afterForget = (await api(c, 'GET', '/api/history')).body as HistoryEntry[];
    assert.ok(afterForget.every((e) => e.id !== sKill.id), 'a forgotten entry is not listed');
    const diskAfterForget = await readHistoryFile(dataDir);
    assert.ok(
      diskAfterForget.every((e) => e.id !== sKill.id),
      'the deletion must persist to history.json',
    );

    // Forget all: ok, empties the list, idempotent.
    const forgetAll = await api(c, 'DELETE', '/api/history');
    assert.equal(forgetAll.status, 200);
    assert.deepEqual(forgetAll.body, { ok: true });
    assert.deepEqual((await api(c, 'GET', '/api/history')).body, []);
    const forgetAllAgain = await api(c, 'DELETE', '/api/history');
    assert.equal(forgetAllAgain.status, 200, 'forget-all must be idempotent');

    await c.stop();
    running = undefined;
  } finally {
    if (running !== undefined) await running.stop();
    await rm(root, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});

test('invalid grace env values warn and fall back to defaults; a corrupt history.json is ignored harmlessly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-lifecycle-'));
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  // A previous run's history that a hard cut left truncated/corrupt.
  await writeFile(join(dataDir, 'history.json'), '{ definitely not an array', { mode: 0o600 });

  const server = await startTestServer({
    dataDir,
    env: { AI_SM_STARTUP_GRACE_MS: 'nope', AI_SM_GRACE_MS: '-5' },
  });
  try {
    // Both invalid knobs must warn and fall back (120000 / 30000 defaults).
    const log = await waitForLog(server, 'startup grace timer armed (120000ms)');
    assert.ok(
      log.includes('AI_SM_STARTUP_GRACE_MS must be a non-negative integer (ms), got "nope"; using 120000'),
      'invalid AI_SM_STARTUP_GRACE_MS must be warned about with the fallback value',
    );
    assert.ok(
      log.includes('AI_SM_GRACE_MS must be a non-negative integer (ms), got "-5"; using 30000'),
      'invalid AI_SM_GRACE_MS must be warned about with the fallback value',
    );

    // The boot load must not die on the corrupt file: warn, start empty.
    assert.ok(log.includes('unreadable history file'), 'corrupt history must be logged, not thrown');
    assert.deepEqual((await api(server, 'GET', '/api/history')).body, []);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('presence WS auth: bad/missing token 401 and evil origin 403 pre-upgrade; valid token connects; frames are ignored', async () => {
  const server = await startTestServer();
  try {
    const badToken = await wsExpectRejected(presenceUrl(server, 'wrong-token'));
    assert.match(badToken, /401/, `bad presence token must be 401, got: ${badToken}`);

    const noToken = await wsExpectRejected(presenceUrl(server, ''));
    assert.match(noToken, /401/, `missing presence token must be 401, got: ${noToken}`);

    const evilOrigin = await wsExpectRejected(presenceUrl(server), {
      origin: 'http://evil.example.com',
    });
    assert.match(evilOrigin, /403/, `evil Origin on presence must be 403, got: ${evilOrigin}`);

    // A fresh data dir has nothing to offer.
    assert.deepEqual((await api(server, 'GET', '/api/history')).body, []);

    // Valid token connects; inbound frames (even malformed) are ignored.
    const presence = await WsClient.connect(presenceUrl(server));
    presence.ws.send('not json at all');
    presence.ws.send(JSON.stringify({ type: 'input', data: 'ignored' }));
    // Round-trip through the HTTP server proves the process is still healthy.
    const res = await fetch(`${server.baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.equal(presence.closed, false, 'presence socket must survive garbage frames');
    assert.equal(presence.messages.length, 0, 'non-ping frames must never be answered');
    await presence.close();
  } finally {
    await server.stop();
  }
});

test('presence ping/pong: well-formed ping echoes pong with the same t; bad pings silent; oversized frame closes 1009; lifecycle untouched', async () => {
  const server = await startTestServer();
  try {
    const presence = await WsClient.connect(presenceUrl(server));
    await waitForLog(server, 'shutdown timer cancelled (presence=1, attached=0)');

    // Bad pings first — WS frames are processed in order, so the pong for
    // the valid ping arriving proves none of these produced a reply.
    presence.ws.send(JSON.stringify({ type: 'ping' })); // t missing
    presence.ws.send(JSON.stringify({ type: 'ping', t: 'soon' })); // t not a number
    presence.ws.send(JSON.stringify({ type: 'ping', t: null }));
    presence.ws.send(JSON.stringify({ type: 'pong', t: 7 })); // wrong direction
    presence.ws.send(Buffer.from(JSON.stringify({ type: 'ping', t: 7 }))); // binary frame

    const t = 1752903000123.5; // Non-integer on purpose: echoed verbatim, not rounded.
    presence.ws.send(JSON.stringify({ type: 'ping', t }));
    const frames = presence.messages as unknown as { type: string; t?: unknown }[];
    const pong = await waitUntil(
      () => frames.find((m) => m.type === 'pong'),
      'a pong frame from the presence channel',
    );
    assert.equal(pong.t, t, 'pong must echo the ping t verbatim');
    assert.equal(presence.messages.length, 1, 'only the well-formed ping may be answered');

    // Ping traffic must not touch the lifecycle counters: still exactly one
    // cancel (from the connect) and no re-arm while the socket lives.
    const log = await readServerLog(server);
    assert.equal(
      log.split('shutdown timer cancelled').length - 1,
      1,
      'ping/pong must not change presence accounting',
    );

    // Oversized frame (> 1024 bytes): connection closed 1009, server healthy.
    const big = await WsClient.connect(presenceUrl(server));
    big.ws.send(JSON.stringify({ type: 'ping', t: 1, pad: 'x'.repeat(2048) }));
    await waitUntil(() => (big.closed ? true : undefined), 'oversized frame to close the socket');
    assert.equal(big.closeInfo?.code, 1009, 'oversized presence frames must close with 1009');
    assert.equal((await fetch(`${server.baseUrl}/health`)).status, 200);

    await presence.close();
  } finally {
    await server.stop();
  }
});

test('presence ping: a numeric but non-finite t (JSON 1e400 -> Infinity) is silent, same as a non-numeric t', async () => {
  const server = await startTestServer();
  try {
    const presence = await WsClient.connect(presenceUrl(server));

    // 1e400 is valid JSON syntax; JSON.parse coerces the overflowing literal
    // to the double Infinity. typeof is 'number', so only Number.isFinite
    // (not a bare typeof/isNaN check) catches this. JSON.stringify(Infinity)
    // itself would silently become "null", so the raw string is hand-built.
    presence.ws.send('{"type":"ping","t":1e400}');
    presence.ws.send('{"type":"ping","t":-1e400}'); // -Infinity, same guard

    const t = 42;
    presence.ws.send(JSON.stringify({ type: 'ping', t }));
    const frames = presence.messages as unknown as { type: string; t?: unknown }[];
    const pong = await waitUntil(
      () => frames.find((m) => m.type === 'pong'),
      'a pong frame for the trailing well-formed ping',
    );
    assert.equal(pong.t, t, 'pong must echo the well-formed ping, proving the Infinity pings were skipped');
    assert.equal(
      presence.messages.length,
      1,
      'non-finite t (Infinity/-Infinity) must never be echoed back as a pong',
    );

    await presence.close();
  } finally {
    await server.stop();
  }
});

test('presence ping/pong is per-connection: only the pinging client gets the pong, other presence sockets get nothing', async () => {
  const server = await startTestServer();
  try {
    const a = await WsClient.connect(presenceUrl(server));
    const b = await WsClient.connect(presenceUrl(server));

    const t = 99;
    a.ws.send(JSON.stringify({ type: 'ping', t }));

    const aFrames = a.messages as unknown as { type: string; t?: unknown }[];
    const pong = await waitUntil(
      () => aFrames.find((m) => m.type === 'pong'),
      'a pong frame on the pinging connection',
    );
    assert.equal(pong.t, t);

    // Round-trip through HTTP to let any (incorrect) broadcast to `b` land.
    assert.equal((await fetch(`${server.baseUrl}/health`)).status, 200);
    assert.equal(b.messages.length, 0, 'a pong must never be broadcast to other presence sockets');

    await a.close();
    await b.close();
  } finally {
    await server.stop();
  }
});
