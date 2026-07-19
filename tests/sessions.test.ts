/**
 * Session lifecycle — the crown jewels.
 *
 * Real PTYs (bash), real WS protocol: create/list, replay-before-live
 * ordering, input echo, resize -> $COLUMNS, exit broadcast, session survival
 * across client disconnect with buffer replay, buffering while fully
 * detached, BEL -> attention -> seen, and the 1 MiB scrollback cap.
 *
 * Markers use `$(printf ...)` so the marker string never appears literally in
 * the terminal's echo of the typed command — only in the executed output.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  api,
  createSession,
  getSession,
  startTestServer,
  waitUntil,
  wsExpectRejected,
  wsUrl,
  WsClient,
  type TestServer,
} from './helpers.ts';

let server: TestServer;
let workDir: string;

before(async () => {
  server = await startTestServer();
  workDir = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-work-')));
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
});

test('create returns SessionInfo, session is listed, title defaults to command', async () => {
  const info = await createSession(server, {
    command: 'bash',
    args: [],
    cwd: workDir,
    cols: 91,
    rows: 33,
  });
  assert.ok(info.id.length > 0);
  assert.equal(info.status, 'running');
  assert.equal(info.command, 'bash');
  assert.deepEqual(info.args, []);
  assert.equal(info.cwd, workDir);
  assert.equal(info.cols, 91);
  assert.equal(info.rows, 33);
  assert.equal(info.title, 'bash', 'title must default to the command');
  assert.equal(info.attention, false);
  assert.equal(new Date(info.createdAt).toISOString(), info.createdAt);

  const listed = await getSession(server, info.id);
  assert.ok(listed !== undefined, 'created session must appear in GET /api/sessions');
  assert.equal(listed.status, 'running');

  const titled = await createSession(server, {
    command: 'bash',
    args: [],
    cwd: workDir,
    cols: 80,
    rows: 24,
    title: 'My Terminal',
  });
  assert.equal(titled.title, 'My Terminal');

  for (const id of [info.id, titled.id]) {
    const del = await api(server, 'DELETE', `/api/sessions/${id}`);
    assert.equal(del.status, 200);
    assert.deepEqual(del.body, { ok: true });
  }
});

test('attach: replay is the very first frame, exactly once; input echoes back as live data', async () => {
  const info = await createSession(server, {
    command: 'bash',
    args: [],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  const c = await WsClient.connect(wsUrl(server, info.id));
  await c.waitForMessage('replay');
  assert.equal(c.messages[0]?.type, 'replay', 'the FIRST ws frame on attach must be the replay');

  const infoMsg = await c.waitForMessage('info');
  assert.equal(infoMsg.session.id, info.id, 'attach info snapshot must describe this session');

  c.send({ type: 'input', data: 'echo RT_$(printf OK)\r' });
  await c.waitForOutput('RT_OK');

  const dataFrames = c.messages.filter((m) => m.type === 'data');
  assert.ok(dataFrames.length > 0, 'live output must arrive as data frames');
  assert.equal(
    c.messages.filter((m) => m.type === 'replay').length,
    1,
    'replay must be sent exactly once per attach',
  );

  // DELETE kills the PTY and closes attached clients.
  const del = await api(server, 'DELETE', `/api/sessions/${info.id}`);
  assert.equal(del.status, 200);
  await waitUntil(() => (c.closed ? true : undefined), 'ws to close after session DELETE', 5_000);
});

test('resize propagates to the PTY ($COLUMNS) and to GET /api/sessions', async () => {
  const info = await createSession(server, {
    command: 'bash',
    args: [],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  const c = await WsClient.connect(wsUrl(server, info.id));
  await c.waitForMessage('replay');

  c.send({ type: 'resize', cols: 120, rows: 40 });

  await waitUntil(
    async () => {
      const s = await getSession(server, info.id);
      return s !== undefined && s.cols === 120 && s.rows === 40 ? true : undefined;
    },
    'GET /api/sessions to report 120x40',
    5_000,
  );

  // Bash updates $COLUMNS on SIGWINCH; re-ask until the new width is visible.
  await waitUntil(
    () => {
      c.send({ type: 'input', data: 'echo SZ_$(printf CHK):$COLUMNS\r' });
      return c.output().includes('SZ_CHK:120') ? true : undefined;
    },
    '$COLUMNS to reflect the resize to 120',
    15_000,
    400,
  );

  await c.close();
  await api(server, 'DELETE', `/api/sessions/${info.id}`);
});

test('PTY exit: exit broadcast with code, session stays listed as exited until DELETE', async () => {
  const info = await createSession(server, {
    command: 'bash',
    args: ['-c', 'exit 7'],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  const c = await WsClient.connect(wsUrl(server, info.id));
  const exitMsg = await c.waitForMessage('exit');
  assert.equal(exitMsg.exitCode, 7, 'exit frame must carry the real exit code');

  const listed = await getSession(server, info.id);
  assert.ok(listed !== undefined, 'exited session must STAY listed until DELETE');
  assert.equal(listed.status, 'exited');
  assert.equal(listed.exitCode, 7);

  await c.close();

  // A fresh attach to an exited session still works (replay + exit notice).
  const c2 = await WsClient.connect(wsUrl(server, info.id));
  await c2.waitForMessage('replay');
  const exit2 = await c2.waitForMessage('exit');
  assert.equal(exit2.exitCode, 7);
  await c2.close();

  const del = await api(server, 'DELETE', `/api/sessions/${info.id}`);
  assert.equal(del.status, 200);
  assert.equal(await getSession(server, info.id), undefined, 'DELETE must remove the session');

  const delAgain = await api(server, 'DELETE', `/api/sessions/${info.id}`);
  assert.equal(delAgain.status, 404);

  const rejected = await wsExpectRejected(wsUrl(server, info.id));
  assert.match(rejected, /404/, 'ws attach to a deleted session must be rejected 404');
});

test('session survives client disconnect; reconnect replays the buffer incl. output produced while detached', async () => {
  const info = await createSession(server, {
    command: 'bash',
    args: [],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });

  const c1 = await WsClient.connect(wsUrl(server, info.id));
  await c1.waitForMessage('replay');
  c1.send({ type: 'input', data: 'echo M1_$(printf ALPHA)\r' });
  await c1.waitForOutput('M1_ALPHA');
  // Schedule output that will fire AFTER we disconnect.
  c1.send({ type: 'input', data: '( sleep 0.4; echo D_$(printf ETACHED) ) &\r' });
  await c1.close();

  // No clients attached — the session must still be running.
  const listed = await getSession(server, info.id);
  assert.ok(listed !== undefined && listed.status === 'running', 'session must survive disconnect');

  // Reconnect: the replay (FIRST frame) must contain the pre-disconnect output.
  const c2 = await WsClient.connect(wsUrl(server, info.id));
  const replay = await c2.waitForMessage('replay');
  assert.equal(c2.messages[0]?.type, 'replay');
  assert.ok(
    replay.data.includes('M1_ALPHA'),
    'replay after reconnect must contain output from before the disconnect',
  );
  await c2.close();

  // The background job's output lands in the ring buffer with no client
  // attached; keep re-attaching until a replay proves it was buffered.
  await waitUntil(
    async () => {
      const probe = await WsClient.connect(wsUrl(server, info.id));
      const r = await probe.waitForMessage('replay');
      await probe.close();
      return r.data.includes('D_ETACHED') ? true : undefined;
    },
    'detached-time output to show up in a replay',
    10_000,
    100,
  );

  await api(server, 'DELETE', `/api/sessions/${info.id}`);
});

test('two concurrent clients on one session both receive the same broadcast', async () => {
  const info = await createSession(server, {
    command: 'bash',
    args: [],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  const a = await WsClient.connect(wsUrl(server, info.id));
  const b = await WsClient.connect(wsUrl(server, info.id));
  await a.waitForMessage('replay');
  await b.waitForMessage('replay');

  a.send({ type: 'input', data: 'echo BOTH_$(printf CLIENTS)\r' });
  await a.waitForOutput('BOTH_CLIENTS');
  await b.waitForOutput('BOTH_CLIENTS');

  await a.close();
  await b.close();
  await api(server, 'DELETE', `/api/sessions/${info.id}`);
});

test('BEL sets attention (broadcast + REST flag); REST seen and WS seen both clear it', async () => {
  const info = await createSession(server, {
    command: 'bash',
    args: [],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  const c = await WsClient.connect(wsUrl(server, info.id));
  await c.waitForMessage('replay');

  c.send({ type: 'input', data: "printf '\\a'\r" });
  await c.waitForMessage('attention');
  let s = await getSession(server, info.id);
  assert.equal(s?.attention, true, 'BEL must set attention=true');

  const seen = await api(server, 'POST', `/api/sessions/${info.id}/seen`);
  assert.equal(seen.status, 200);
  assert.deepEqual(seen.body, { ok: true });
  s = await getSession(server, info.id);
  assert.equal(s?.attention, false, 'POST /seen must clear attention');

  // Second bell, cleared via the WS 'seen' frame this time.
  const from = c.messages.length;
  c.send({ type: 'input', data: "printf '\\a'\r" });
  await c.waitForMessage('attention', { fromIndex: from });
  s = await getSession(server, info.id);
  assert.equal(s?.attention, true);

  c.send({ type: 'seen' });
  await waitUntil(
    async () => {
      const cur = await getSession(server, info.id);
      return cur !== undefined && cur.attention === false ? true : undefined;
    },
    "ws 'seen' to clear attention",
    5_000,
  );

  await c.close();
  await api(server, 'DELETE', `/api/sessions/${info.id}`);
});

test('scrollback ring buffer: replay stays <= 1 MiB after > 2 MiB of output, keeps the tail', async () => {
  const MIB = 1024 * 1024;
  const info = await createSession(server, {
    command: 'bash',
    args: ['-c', "head -c 2097152 /dev/zero | tr '\\0' x; echo RING_END_MARK"],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });

  // Wait for the producer to finish (exit frame arrives live or on attach).
  const c1 = await WsClient.connect(wsUrl(server, info.id));
  await c1.waitForMessage('exit', { timeoutMs: 30_000 });
  await c1.close();

  const c2 = await WsClient.connect(wsUrl(server, info.id));
  const replay = await c2.waitForMessage('replay');
  const bytes = Buffer.byteLength(replay.data, 'utf8');
  assert.ok(bytes <= MIB, `replay must be capped at 1 MiB, got ${bytes} bytes`);
  assert.ok(
    bytes >= 900 * 1024,
    `ring must drop OLDEST chunks, not everything — expected a near-full buffer, got ${bytes} bytes`,
  );
  const markIdx = replay.data.indexOf('RING_END_MARK');
  assert.ok(markIdx !== -1, 'the newest output must survive the ring buffer');
  assert.ok(
    markIdx > replay.data.length - 200,
    'the marker must sit at the tail of the replay (newest data kept)',
  );
  await c2.close();

  await api(server, 'DELETE', `/api/sessions/${info.id}`);
});

test('POST /api/sessions input validation: bad bodies get 400 and create nothing', async () => {
  const listBefore = await api(server, 'GET', '/api/sessions');
  const countBefore = (listBefore.body as unknown[]).length;

  const badBodies: Record<string, unknown>[] = [
    { args: [], cwd: workDir, cols: 80, rows: 24 }, // missing command
    { command: '', args: [], cwd: workDir, cols: 80, rows: 24 }, // empty command
    { command: 'bash', cwd: workDir, cols: 80, rows: 24 }, // missing args
    { command: 'bash', args: 'nope', cwd: workDir, cols: 80, rows: 24 }, // args not an array
    { command: 'bash', args: [1, 2], cwd: workDir, cols: 80, rows: 24 }, // args not strings
    { command: 'bash', args: [], cwd: workDir, cols: 0, rows: 24 }, // cols < 1
    { command: 'bash', args: [], cwd: workDir, cols: 1.5, rows: 24 }, // non-integer
    { command: 'bash', args: [], cwd: workDir, cols: 80, rows: 5000 }, // rows > cap
    { command: 'bash', args: [], cwd: 'relative/dir', cols: 80, rows: 24 }, // relative cwd
    { command: 'bash', args: [], cwd: join(workDir, 'missing'), cols: 80, rows: 24 }, // nonexistent cwd
    { command: 'bash', args: [], cols: 80, rows: 24 }, // neither cwd nor projectId
    { command: 'bash', args: [], projectId: 'no-such-project', cols: 80, rows: 24 },
  ];
  for (const body of badBodies) {
    const res = await api(server, 'POST', '/api/sessions', body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${res.status}`);
  }

  const listAfter = await api(server, 'GET', '/api/sessions');
  assert.equal(
    (listAfter.body as unknown[]).length,
    countBefore,
    'rejected bodies must not create sessions',
  );
});

test('BEL terminating an OSC title sequence does not raise attention; a real bell after it still does', async () => {
  const info = await createSession(server, {
    command: 'bash',
    args: [],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  const c = await WsClient.connect(wsUrl(server, info.id));
  await c.waitForMessage('replay');

  // Window-title update (bash PS1 emits these on every prompt): the 0x07 here
  // terminates the OSC string and must NOT count as a bell. The marker after
  // it proves the chunk was fully processed before we assert.
  c.send({
    type: 'input',
    data: "printf '\\033]0;SOME-TITLE\\007'; printf 'OSC-DONE-%s\\n' \"$(printf MARK)\"\r",
  });
  await waitUntil(
    () =>
      c.messages.some((m) => m.type === 'data' && m.data.includes('OSC-DONE-MARK'))
        ? true
        : undefined,
    'OSC marker echoed back',
  );
  assert.equal(
    c.messages.some((m) => m.type === 'attention'),
    false,
    'OSC-terminating BEL must not broadcast attention',
  );
  const afterOsc = await getSession(server, info.id);
  assert.equal(afterOsc?.attention, false);

  // Parser state recovered: a plain bell still raises attention.
  c.send({ type: 'input', data: "printf '\\a'\r" });
  await c.waitForMessage('attention');
  const afterBell = await getSession(server, info.id);
  assert.equal(afterBell?.attention, true);

  await c.close();
  await api(server, 'DELETE', `/api/sessions/${info.id}`);
});
