/**
 * Manual restart — upgrade.closeAll (server/ws.ts), the teardown's WebSocket
 * half. The restart teardown closes every live socket with 1012 "service
 * restart" and LOGS the count; server/index.ts then destroys only the
 * connections that were NOT WebSockets, so the close frames can flush.
 *
 * Why: both halves lean on closeAll returning the number of sockets it
 * actually closed — an overstated count is a lie in the log, and a socket left
 * open is a client that keeps its old token against a new process.
 *
 * How: the real upgrade handler in this process on a real HTTP server, with
 * real `ws` clients.
 *
 * NOT claimed here: the whole restart — `tests/server/restart-real.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { createUpgradeHandler } from '../../server/ws.ts';
import { LifecycleController } from '../../server/lifecycle.ts';
import { createLogger, createRefusalLimiter, scoped } from '../../server/config.ts';
import { SessionHistory } from '../../server/history.ts';
import { SessionManager } from '../../server/sessions.ts';
import {
  destroyAllAndSettle,
  removeTempDir,
  waitForLogLines,
  waitUntil,
  WsClient,
} from '../helpers/helpers.ts';
import { tempDir } from '../helpers/restart-fixture.ts';

// ---------------------------------------------------------------------------
// 4. upgrade.closeAll — the teardown's WebSocket half
// ---------------------------------------------------------------------------
//
// The restart teardown closes every live socket with 1012 "service restart" and
// LOGS the count; server/index.ts then destroys only the connections that were
// NOT WebSockets, so the close frames can flush. Both halves lean on closeAll
// returning the number of sockets it actually closed: an overstated count is a
// lie in the log, and a socket left open is a client that keeps its old token
// against a new process.

test('upgrade.closeAll: closes every OPEN socket with 1012 and counts each one exactly once', async () => {
  const dir = tempDir();
  const log = createLogger(join(dir, 'server.log'), 'debug');
  const token = 'd'.repeat(64);
  const history = new SessionHistory(join(dir, 'history.json'), log);
  const sessions = new SessionManager(log, history);
  const lifecycle = new LifecycleController({
    onIdleShutdown: () => undefined,
    log,
    graceMs: 600_000,
    startupGraceMs: 600_000,
  });
  let boundPort = 0;
  const upgrade = createUpgradeHandler({
    token,
    getPort: () => boundPort,
    sessions,
    lifecycle,
    log,
    allowRefusalLine: createRefusalLimiter(scoped(log, 'http')),
  });
  const server: Server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  server.on('upgrade', upgrade);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  boundPort = (server.address() as { port: number }).port;

  const logFile = join(dir, 'server.log');
  let bodyThrew = false;
  try {
    assert.equal(upgrade.closeAll(1012, 'service restart'), 0, 'nothing connected, nothing closed');

    // One session channel and two presence windows: closeAll spans BOTH servers.
    const session = sessions.create({
      cwd: '/tmp',
      command: 'bash',
      args: ['-lc', 'sleep 30'],
      title: 'closeall',
      cols: 80,
      rows: 24,
    });
    const base = `ws://127.0.0.1:${boundPort}`;
    const attached = await WsClient.connect(`${base}/ws/sessions/${session.id}?token=${token}`);
    const w1 = await WsClient.connect(`${base}/ws/presence?token=${token}`);
    const w2 = await WsClient.connect(`${base}/ws/presence?token=${token}`);

    assert.equal(upgrade.closeAll(1012, 'service restart'), 3, 'the session socket AND both windows');
    // Immediately after: the same sockets are CLOSING, not OPEN. Counting them
    // again would double the number the teardown line prints.
    assert.equal(upgrade.closeAll(1012, 'service restart'), 0, 'only OPEN sockets are counted');

    for (const client of [attached, w1, w2]) {
      await waitUntil(() => (client.closed ? true : undefined), 'the client to see the close', 10_000);
      assert.equal(client.closeInfo?.code, 1012, 'the "come back in a moment" code, not an error');
      assert.equal(client.closeInfo?.reason, 'service restart');
    }
    assert.ok(
      (await import('node:fs')).readFileSync(logFile, 'utf8').includes(
        'closed 3 websocket(s) with code 1012: service restart',
      ),
      'and the count reaches the log exactly once',
    );
    // The SERVER half of those three closes writes to server.log as well, and
    // can land after the client saw the frame. Wait for it here, so nothing is
    // still appending into `dir` when the finally removes it.
    await waitForLogLines(
      logFile,
      {
        [`detached session ${session.id} code=1012`]: 1,
        'presence disconnected code=1012': 2,
      },
      'the server side of all three closes to be logged',
    );
  } catch (err) {
    bodyThrew = true;
    throw err;
  } finally {
    // The grace timer the last presence close armed is a REAL 10-minute timer:
    // without this the file's event loop never drains and `node --test` hangs.
    lifecycle.stop();
    // NOT a bare destroyAll(): node-pty's `exit` fires ticks later and its
    // handler appends to server.log, which recreated the file mid-rm() and
    // failed this test with ENOTEMPTY on a loaded CI runner (run 34248854109).
    // A settle TIMEOUT must never replace the body's error: without this, a
    // failed assertion is reported as a teardown timeout and the real failure
    // is invisible.
    // Stashed, not thrown here: a throw inside `finally` would skip the two
    // cleanups below, leaking the listener (so `node --test` never drains) and
    // the temp dir. It is rethrown after them.
    let settleErr: { err: unknown } | undefined;
    try {
      await destroyAllAndSettle(sessions, logFile);
    } catch (err) {
      if (bodyThrew) console.error(err);
      else settleErr = { err };
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(dir);
    if (settleErr) throw settleErr.err;
  }
});
