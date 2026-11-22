/**
 * The session WebSocket under hostile or broken clients — PLAN-QUALITY Q9
 * (`.claude/plans/PLAN-QUALITY.md` § Q9, the 2026-11-22 audit).
 *
 * Three edges of `/ws/sessions/:id` (server/ws.ts, server/sessions.ts):
 *   - a text frame that parses to something other than a plain object
 *     (`null`, `5`, `"x"`, `[]`) is ignored, as an unknown type is — before
 *     Q9, `null` threw a TypeError inside the message handler, which became an
 *     uncaughtException and ended the backend with every session in it;
 *   - a frame over MAX_SESSION_FRAME_BYTES is cut off during receive (1009)
 *     instead of being buffered whole, and the backend stays up;
 *   - a client that stops reading is closed once its send buffer passes
 *     MAX_CLIENT_BUFFERED_BYTES (1013), so a stalled browser cannot grow the
 *     backend's memory without bound — while a healthy client on the same
 *     session keeps streaming and the session itself lives on.
 *
 * How: a real server child (`startTestServer`) and real bash PTYs, because
 * the claims are about the process staying alive and about real socket
 * buffers. The stalled client is a `ws` client whose socket is paused, so the
 * kernel's TCP buffers fill and the server's `bufferedAmount` grows exactly
 * as it does behind a frozen browser tab.
 *
 * NOT claimed: how the browser reacts to the 1013 close (it reconnects at its
 * longest backoff and gets the replay — `tests/ui/ui-ws-slow-close.test.ts`);
 * the per-session budget on the close's log line
 * (`tests/server/sessions-slow-client.test.ts`).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import {
  createSession,
  getSession,
  makeTempDir,
  readServerLog,
  removeTempDir,
  startTestServer,
  waitForLog,
  waitUntil,
  wsUrl,
  WsClient,
  type TestServer,
} from '../helpers/helpers.ts';

let server: TestServer;
let workDir: string;

before(async () => {
  server = await startTestServer();
  workDir = await realpath(await makeTempDir('ai-sm-ws-robust-'));
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (workDir !== undefined) await removeTempDir(workDir);
});

async function bash(): Promise<string> {
  const info = await createSession(server, { command: 'bash', args: [], cwd: workDir, cols: 80, rows: 24 });
  return info.id;
}

/**
 * The text of a client's last frames. `WsClient.output()` joins every frame,
 * which per 25 ms poll is tens of MB here; the end marker is in the last few.
 */
function tail(client: WsClient): string {
  return client.messages
    .slice(-20)
    .map((m) => (m.type === 'data' || m.type === 'replay' ? m.data : ''))
    .join('');
}

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${server.baseUrl}/health`)).status === 200;
  } catch {
    return false;
  }
}

test('a frame that parses to null, a number, a string or an array is ignored and the backend stays up', async () => {
  const id = await bash();
  const client = await WsClient.connect(wsUrl(server, id));
  await client.waitForMessage('replay');
  for (const frame of ['null', '5', '"x"', '[]', 'true']) {
    client.ws.send(frame);
  }
  // Frames are handled in order: the echo of this input proves every frame
  // above was processed without taking the process down.
  client.send({ type: 'input', data: 'echo "q9-$((6*7))-alive"\r' });
  await client.waitForOutput('q9-42-alive');
  assert.equal(await healthy(), true, 'the backend must answer /health after the non-object frames');
  assert.equal(client.closed, false, 'a non-object frame must not close the socket');
  assert.equal((await getSession(server, id))?.status, 'running', 'the session must survive');
  const log = await readServerLog(server);
  assert.equal(log.includes('uncaught'), false, 'no uncaught exception may be logged');
  await client.close();
});

test('a frame over the session cap closes that socket with 1009 and the backend stays up', async () => {
  const id = await bash();
  const other = await WsClient.connect(wsUrl(server, id));
  await other.waitForMessage('replay');
  const big = await WsClient.connect(wsUrl(server, id));
  await big.waitForMessage('replay');
  // 17 MiB of input: over the 16 MiB cap, so it must be refused while received.
  big.send({ type: 'input', data: 'x'.repeat(17 * 1024 * 1024) });
  await waitUntil(() => (big.closed ? true : undefined), 'the over-cap socket to close', 20_000);
  assert.equal(big.closeInfo?.code, 1009, 'an over-cap frame must close with 1009 (message too big)');
  assert.equal(await healthy(), true, 'the backend must stay up');
  assert.equal(other.closed, false, 'the other client of the session must stay attached');
  other.send({ type: 'input', data: 'echo "q9-$((7*7))-other"\r' });
  await other.waitForOutput('q9-49-other');
  await other.close();
});

test('a client that stops reading is closed past the buffer cap; a healthy client and the session live on', async () => {
  const id = await bash();
  const live = await WsClient.connect(wsUrl(server, id));
  await live.waitForMessage('replay');
  const stalled = await WsClient.connect(wsUrl(server, id));
  await stalled.waitForMessage('replay');
  stalled.ws.pause(); // Stop reading: the kernel buffers fill, then the server's.

  // 48 MB of output: past the 16 MiB cap plus whatever the kernel's TCP
  // buffers swallow on loopback (a few MiB each way).
  live.send({ type: 'input', data: 'head -c 48000000 /dev/zero | tr "\\0" x; echo; echo "q9-$((8*8))-done"\r' });
  await waitForLog(server, `${id} client closed, `, { timeoutMs: 60_000 });
  await waitUntil(() => (tail(live).includes('q9-64-done') ? true : undefined), 'the live client to see the end marker', 60_000);
  assert.equal(live.closed, false, 'the client that kept reading must stay attached');
  assert.equal((await getSession(server, id))?.status, 'running', 'the session must survive');

  // Once it reads again it drains what was queued and then sees the close.
  stalled.ws.resume();
  await waitUntil(() => (stalled.closed ? true : undefined), 'the stalled socket to close', 60_000);
  assert.equal(stalled.closeInfo?.code, 1013, 'a stalled client is told to try again later (1013)');

  // The log line carries counts, never PTY bytes.
  const log = await readServerLog(server);
  assert.equal(/x{64}/.test(log), false, 'no PTY output may reach server.log');

  // A reattach gets the replay — what the browser does after the close.
  const again = await WsClient.connect(wsUrl(server, id));
  const replay = await again.waitForMessage('replay');
  assert.ok(replay.data.includes('q9-64-done'), 'a reattach replays the scrollback');
  await again.close();
  await live.close();
});
