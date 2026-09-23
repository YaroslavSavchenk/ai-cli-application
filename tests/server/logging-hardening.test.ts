/**
 * Logging hardening (2026-09-06, the gaps the review gate closed) — server.log
 * must stay secret-free and must not be rotated away by an attacker:
 *
 *   - LEAK CANARIES end to end: pty output, terminal input, a query value and a
 *     request body reach server.log nowhere;
 *   - an unauthenticated request flood cannot rotate the log away (capped path,
 *     budgeted refusals), and the ws upgrade reject shares that budget policy
 *     (createRefusalLimiter);
 *   - errorFrames cannot be smuggled a fake stack frame by a request body;
 *   - a rotation that cannot rename keeps the log alive;
 *   - history prune writes one summary line per list.
 *
 * How: real server children (`startTestServer`) read back through server.log,
 * and the logger, limiter, upgrade handler and history in-process where only
 * an injected clock or a fake socket reaches the branch.
 *
 * NOT claimed here: the logger basics, banner, access and ws logs —
 * `tests/server/logging.test.ts`; POST /api/client-log —
 * `tests/server/logging-client-log.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { mkdirSync, readFileSync, realpathSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createLogger,
  errorFrames,
  errorStackOnly,
  scoped,
  MAX_LOG_BYTES,
  MAX_LOGGED_ROUTE_CHARS,
  REFUSAL_LOG_MAX_PER_MINUTE,
  createRefusalLimiter,
} from '../../server/config.ts';
import { SessionHistory } from '../../server/history.ts';
import { SessionManager } from '../../server/sessions.ts';
import { LifecycleController } from '../../server/lifecycle.ts';
import { createUpgradeHandler } from '../../server/ws.ts';
import {
  api,
  createSession,
  rawRequest,
  readServerLog,
  removeTempDir,
  startTestServer,
  waitForLog,
  wsUrl,
  WsClient,
  makeTempDirSync,
} from '../helpers/helpers.ts';
import { tempDir, postClientLog } from '../helpers/logging-fixture.ts';

// ---------------------------------------------------------------------------
// 7. Leak canaries, end to end
// ---------------------------------------------------------------------------

test('LEAK CANARIES: pty output, terminal input, a query value and a request body reach server.log NOWHERE', async () => {
  const server = await startTestServer();
  try {
    // PTY OUTPUT canary. Deliberately NOT in the argv: the spawned command line
    // IS logged on purpose (server/sessions.ts, "what did the app actually
    // run?"), so a canary passed as an argument would be a false positive. It
    // lives in a file the session cats, i.e. purely in OUTPUT.
    const canaryFile = join(server.dataDir, 'pty-canary.txt');
    writeFileSync(canaryFile, 'PTY_CANARY_xyz\n');
    const info = await createSession(server, {
      command: 'bash',
      args: ['-c', `cat ${canaryFile}; read -r line; echo done`],
      cols: 80,
      rows: 24,
      cwd: '/tmp',
    });
    const client = await WsClient.connect(wsUrl(server, info.id));
    await client.waitForOutput('PTY_CANARY_xyz');

    // TERMINAL INPUT canary — logged as a byte count, never as content.
    client.send({ type: 'input', data: 'INPUT_CANARY_abc\n' });
    await waitForLog(server, `input ${Buffer.byteLength('INPUT_CANARY_abc\n')} bytes`);

    // QUERY-STRING canary.
    const q = await api(server, 'GET', '/api/fs/list?path=%2Ftmp&probe=QUERY_CANARY_def');
    assert.equal(q.status, 200);

    // REQUEST-BODY canary on the path that really is dangerous: PUT /api/prefs
    // reads the body with the THROWING reader, and Node's JSON.parse
    // SyntaxError quotes the FIRST 10 CHARACTERS of the input — measured, not
    // assumed: JSON.parse('BODY_CANARY_ghi{') fails with
    //   Unexpected token 'B', "BODY_CANAR"... is not valid JSON
    // So the canary is exactly 10 characters long: a longer one would be cut
    // by the quoting and the test would sail past a real leak.
    const bad = await rawRequest(server.port, {
      method: 'PUT',
      path: '/api/prefs',
      headers: { 'x-auth-token': server.token, 'content-type': 'application/json' },
      body: 'PREFSCANRY{"theme":',
    });
    assert.equal(bad.status, 400, 'a malformed body is refused');
    // ...and on the client-log route itself.
    assert.equal((await postClientLog(server, 'CLOGCANARY{[')).status, 400);

    await client.close();
    await waitForLog(server, `[ws] detached session ${info.id}`);
    const log = await readServerLog(server);

    // The log is real and current — otherwise every assertion below is vacuous.
    assert.ok(log.includes('[http] GET /api/fs/list ?'), 'the query request was logged');
    assert.ok(
      log.includes('request PUT /api/prefs failed (SyntaxError)'),
      'the parse failure was logged (class + frames only)',
    );
    assert.ok(log.length > 1000, `server.log has real content (${log.length} bytes)`);

    for (const canary of [
      'PTY_CANARY_xyz',
      'INPUT_CANARY_abc',
      'QUERY_CANARY_def',
      'PREFSCANRY',
      'CLOGCANARY',
      server.token,
    ]) {
      assert.ok(
        !log.includes(canary),
        `${canary === server.token ? 'the auth token' : canary} must NEVER appear in server.log`,
      );
    }
    // Rotated generations too, if any were produced.
    for (const gen of ['server.log.1', 'server.log.2']) {
      let rotated = '';
      try {
        rotated = readFileSync(join(server.dataDir, gen), 'utf8');
      } catch {
        continue;
      }
      for (const canary of [
        'PTY_CANARY_xyz',
        'INPUT_CANARY_abc',
        'QUERY_CANARY_def',
        server.token,
      ]) {
        assert.ok(!rotated.includes(canary), `${gen} must not hold a canary either`);
      }
    }

    await api(server, 'DELETE', `/api/sessions/${info.id}`);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// 8. Gaps closed by the review gate (2026-09-06)
// ---------------------------------------------------------------------------

test('an UNAUTHENTICATED request flood cannot rotate server.log away: capped path + budgeted refusals', async () => {
  const server = await startTestServer();
  try {
    const before = (await readServerLog(server)).length;
    // The attack from the audit: any page can do this with an <img> or a
    // no-cors fetch (neither sends an Origin, so the Origin check passes and
    // the request reaches the 404 path with no token at all).
    const longPath = `/${'a'.repeat(15000)}`;
    const FLOOD = 300;
    for (let i = 0; i < FLOOD; i += 1) {
      assert.equal((await rawRequest(server.port, { path: longPath })).status, 404);
    }
    // Same page, same window, an unauthenticated 200: /health answers OK to any
    // no-cors request, so metering only 4xx would leave the hole wide open.
    for (let i = 0; i < FLOOD; i += 1) {
      assert.equal((await rawRequest(server.port, { path: '/health' })).status, 200);
    }

    // An authed request AFTER the flood proves the log is still being written.
    await api(server, 'GET', '/api/history');
    const log = await waitForLog(server, '[http] GET /api/history -> 200');
    const grew = log.length - before;

    assert.ok(
      grew < 100_000,
      `the flood added ${grew} bytes; unfixed it would add ~${FLOOD * 15_000}`,
    );
    const floodLines = log.split('\n').filter((l) => l.includes('aaaaaaaaaa'));
    assert.ok(floodLines.length > 0, 'the first refusals ARE logged — this is not silence');
    assert.ok(
      floodLines.length <= REFUSAL_LOG_MAX_PER_MINUTE,
      `at most ${REFUSAL_LOG_MAX_PER_MINUTE} refusal lines per minute, got ${floodLines.length}`,
    );
    for (const line of floodLines) {
      assert.ok(line.length <= 400, `a refusal line stays short: ${line.length} chars`);
    }
    // The pathname is truncated, so no single line can be made large.
    assert.ok(
      floodLines.every((l) => !l.includes('a'.repeat(MAX_LOGGED_ROUTE_CHARS + 1))),
      `the logged pathname is capped at ${MAX_LOGGED_ROUTE_CHARS} characters`,
    );
    // And the file SAYS what it is not showing.
    assert.ok(
      log.includes('suppressed refused request log lines'),
      'the suppression is announced, so a flood is still diagnosable',
    );

    // ONE budget covers both floods, because both are unauthenticated.
    const healthLines = log.split('\n').filter((l) => l.includes('[http] GET /health'));
    assert.ok(
      floodLines.length + healthLines.length <= REFUSAL_LOG_MAX_PER_MINUTE,
      `unauthenticated 200s are metered too: ${floodLines.length} + ${healthLines.length}`,
    );

    // ...and an AUTHENTICATED request is never metered, budget or no budget.
    // Metering keys on TRUST, not on status: this 404 lands even now.
    assert.equal((await api(server, 'GET', '/api/nope')).status, 404);
    const authed4xx = await waitForLog(server, '[http] GET /api/nope -> 404');
    assert.ok(
      authed4xx.includes('[http] GET /api/nope -> 404'),
      'an authenticated 4xx is a real diagnostic and is always written',
    );

    // Same for an authenticated request that THROWS in the handler (a body that
    // fails to parse) — the line a real server-side fault produces.
    assert.equal(
      (
        await rawRequest(server.port, {
          method: 'PUT',
          path: '/api/prefs',
          headers: { 'x-auth-token': server.token, 'content-type': 'application/json' },
          body: 'NOTJSONXYZ{',
        })
      ).status,
      400,
    );
    const thrown = await waitForLog(server, 'request PUT /api/prefs failed (SyntaxError)');
    assert.ok(!thrown.includes('NOTJSONXYZ'), 'and still not one byte of the body');
  } finally {
    await server.stop();
  }
});

test('createRefusalLimiter: N lines per window, then a counted suppression — and it recovers', () => {
  const lines: [string, string][] = [];
  let clock = 1_000_000;
  const allow = createRefusalLimiter(
    (level, message) => lines.push([level, message]),
    () => clock,
  );

  let written = 0;
  for (let i = 0; i < REFUSAL_LOG_MAX_PER_MINUTE + 5; i += 1) if (allow()) written += 1;
  assert.equal(written, REFUSAL_LOG_MAX_PER_MINUTE, 'exactly the budget is allowed through');
  assert.equal(lines.length, 1, 'the transition is announced ONCE, not per suppressed line');
  assert.deepEqual(lines[0]?.[0], 'warn');
  assert.match(lines[0]?.[1] ?? '', /^suppressed refused request log lines: past 60 per minute/);

  // The next window: the previous one's total is stated, and the budget is back.
  // Both call sites (the HTTP access log and the ws upgrade reject) share ONE
  // INSTANCE of this in production, so this is where the mechanism is pinned.
  clock += 61_000;
  assert.equal(allow(), true, 'a fresh window logs again');
  assert.equal(lines.length, 2);
  assert.equal(lines[1]?.[1], 'suppressed 5 refused request log line(s) in the last window');
});

test('errorFrames: a request body carrying "\\n    at " cannot smuggle itself into the frames', () => {
  // V8 quotes ~10 characters of the input in a JSON.parse SyntaxError and does
  // NOT escape a newline inside them, so the message spans two lines and its
  // second line looks exactly like a stack frame. Measured on this runtime.
  let err: unknown;
  try {
    JSON.parse('\n    at ghp_CANARY0123456789 is not json');
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error, 'the parse must actually fail');
  assert.ok(
    (err as Error).stack?.split('\n')[1]?.startsWith('    at ghp_'),
    'the fixture is real: the message DOES occupy a second, frame-shaped line',
  );

  const frames = errorFrames(err);
  assert.ok(!frames.includes('ghp_CANARY'), `the body fragment never reaches the frames: ${frames}`);
  assert.ok(frames.startsWith('at JSON.parse'), `real frames still survive: ${frames}`);
  assert.ok(!errorStackOnly(err).includes('ghp_CANARY'), 'and not through errorStackOnly either');

  // A stack that does NOT start with `${name}: ${message}` cannot be split by
  // length, so it yields NOTHING rather than falling back to the line filter
  // this attack defeats. Class name only.
  const hand = new Error('unrelated message');
  hand.stack = 'custom\n    at ghp_X_SHOULD_NOT_APPEAR';
  assert.equal(errorFrames(hand), '', 'an unsplittable stack yields no frames at all');
  assert.equal(errorStackOnly(hand), 'Error', 'errorStackOnly degrades to the class name');
});

test('the ws upgrade reject shares the SAME budget policy: N lines, a summary, then a fresh window', () => {
  const dir = tempDir();
  try {
    const logFile = join(dir, 'server.log');
    const log = createLogger(logFile, 'debug');
    const port = 45_678;
    let clock = 2_000_000;
    const history = new SessionHistory(join(dir, 'history.json'), log);
    const upgrade = createUpgradeHandler({
      token: 'b'.repeat(64),
      getPort: () => port,
      sessions: new SessionManager(log, history),
      lifecycle: new LifecycleController({ onIdleShutdown: () => undefined, log }),
      log,
      allowRefusalLine: createRefusalLimiter(scoped(log, 'ws'), () => clock),
    });

    // The reject paths never reach the ws handshake, so the socket only has to
    // answer write()/destroy() — exactly what rejectUpgrade() calls.
    const reject = (): void => {
      const req = {
        url: '/nope',
        headers: { host: `127.0.0.1:${port}` },
      } as unknown as IncomingMessage;
      const socket = { write: () => true, destroy: () => undefined } as unknown as Duplex;
      upgrade(req, socket, Buffer.alloc(0));
    };

    const count = (needle: string): number =>
      readFileSync(logFile, 'utf8')
        .split('\n')
        .filter((l) => l.includes(needle)).length;

    for (let i = 0; i < REFUSAL_LOG_MAX_PER_MINUTE + 1; i += 1) reject();
    assert.equal(
      count('[ws] upgrade rejected 404 on /nope'),
      REFUSAL_LOG_MAX_PER_MINUTE,
      'exactly the budget reaches the file; every socket is still rejected',
    );
    assert.equal(count('suppressed refused request log lines'), 1, 'announced once');

    clock += 61_000;
    reject();
    assert.equal(
      count('suppressed 1 refused request log line(s) in the last window'),
      1,
      'the rolled-over window states its total',
    );
    assert.equal(
      count('[ws] upgrade rejected 404 on /nope'),
      REFUSAL_LOG_MAX_PER_MINUTE + 1,
      'and the budget is back',
    );
  } finally {
    void rm(dir, { recursive: true, force: true });
  }
});

test('a rotation that CANNOT rename still keeps the log alive', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'server.log');
    // Both generations are non-empty DIRECTORIES: `.1 -> .2` fails ENOTEMPTY,
    // so `.1` stays a directory and `server.log -> server.log.1` fails too.
    for (const gen of [`${file}.1`, `${file}.2`]) {
      mkdirSync(gen);
      writeFileSync(join(gen, 'occupied'), 'x');
    }
    writeFileSync(file, '');
    truncateSync(file, MAX_LOG_BYTES);

    const log = createLogger(file, 'debug');
    assert.doesNotThrow(() => log('info', 'AFTER-FAILED-ROTATION'));
    const first = readFileSync(file, 'utf8');
    assert.ok(first.includes('AFTER-FAILED-ROTATION'), 'the line still landed');
    assert.ok(statSync(file).size < 1000, 'the live file was truncated instead of rotated');

    // ...and the logger is not wedged: every later line lands too. Before the
    // fix the throw left `bytes` over the cap, so every call re-entered
    // rotate(), threw again, and the log was silent for good.
    log('info', 'STILL-ALIVE-1');
    log('warn', 'STILL-ALIVE-2');
    const text = readFileSync(file, 'utf8');
    assert.ok(text.includes('STILL-ALIVE-1') && text.includes('STILL-ALIVE-2'));
  } finally {
    void rm(dir, { recursive: true, force: true });
  }
});

test('history prune writes ONE summary line per list, not one per surviving entry', async () => {
  // The history MUST be seeded with real candidates. With an empty history.json
  // (a fresh data dir) `checked` is 0, no entry ever reaches a keep/prune
  // decision, and the "no per-entry keep line" assertion below is true no
  // matter what the code does — the test would pass with the 200-lines-per-
  // refresh regression fully restored. Verified by mutation: re-adding
  //   if (verdict === 'keep') this.#hlog('debug', `prune check ... keep ...`)
  // to server/history.ts leaves an unseeded version of this test green.
  const root = makeTempDirSync('ai-sm-log-prune-');
  const dataDir = join(root, 'data');
  const claudeConfigDir = join(root, 'claude-config');
  const workDir = join(root, 'work');
  const encodeCwd = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');
  try {
    mkdirSync(dataDir, { mode: 0o700, recursive: true });
    mkdirSync(workDir, { recursive: true });
    // Claude's home must exist, or pruneUnsaid stops before any candidate.
    mkdirSync(join(claudeConfigDir, 'projects'), { recursive: true });
    const realWork = realpathSync(workDir);
    const projectDir = join(claudeConfigDir, 'projects', encodeCwd(realWork));
    mkdirSync(projectDir, { recursive: true });

    const KEPT_SAID = '11111111-1111-4111-8111-111111111111'; // transcript exists
    const KEPT_UNKNOWN = '22222222-2222-4222-8222-222222222222'; // no project dir
    const PRUNED = '33333333-3333-4333-8333-333333333333'; // transcript missing
    writeFileSync(join(projectDir, `${KEPT_SAID}.jsonl`), '{}\n');

    const entry = (id: string, cwd: string): Record<string, unknown> => ({
      id,
      conversation: true,
      sessionId: `session-${id}`,
      cwd,
      command: 'claude',
      args: ['--model', 'opus'],
      title: `entry ${id}`,
      createdAt: '2026-09-01T10:00:00.000Z',
      lastUsedAt: '2026-09-05T10:00:00.000Z',
      ended: { at: '2026-09-05T11:00:00.000Z', reason: 'exit' },
    });
    writeFileSync(
      join(dataDir, 'history.json'),
      JSON.stringify(
        [
          entry(KEPT_SAID, realWork),
          entry(KEPT_UNKNOWN, '/tmp'),
          entry(PRUNED, realWork),
          // Not a candidate at all (cheap disqualifier): not a claude session.
          // NOT `ended: null` — history.load() crash-stamps a still-live entry
          // at boot, which would turn it into a fourth candidate.
          {
            ...entry('44444444-4444-4444-8444-444444444444', realWork),
            conversation: false,
            command: 'bash',
          },
        ],
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );

    const server = await startTestServer({ dataDir, env: { CLAUDE_CONFIG_DIR: claudeConfigDir } });
    try {
      const listed = (await api(server, 'GET', '/api/history')).body as { id: string }[];
      const ids = listed.map((e) => e.id);
      assert.ok(ids.includes(KEPT_SAID) && ids.includes(KEPT_UNKNOWN), 'both keeps survived');
      assert.ok(!ids.includes(PRUNED), 'the transcript-less conversation was pruned');

      const log = await waitForLog(server, 'prune checked');
      // THREE candidates really reached a decision, TWO of them 'keep' — so the
      // absence assertion below has something to be absent about.
      assert.ok(
        log.includes('[history] prune checked 3 candidate(s), pruned 1'),
        `the summary states the real counts: ${log.slice(-600)}`,
      );
      assert.equal(
        log.split('\n').filter((l) => l.includes('prune checked')).length,
        1,
        'one summary line for the one list call',
      );
      assert.equal(
        log.split('\n').filter((l) => /prune check .*: keep/.test(l)).length,
        0,
        'a KEPT entry gets no line of its own — that was 200 lines per drawer refresh',
      );
      // A DISAPPEARING entry still gets its own explanation: silence here would
      // be a drawer entry vanishing with nothing in the log to say why.
      const pruneLines = log.split('\n').filter((l) => /prune check .*: prune/.test(l));
      assert.equal(pruneLines.length, 1, `exactly one prune line: ${JSON.stringify(pruneLines)}`);
      assert.ok((pruneLines[0] as string).includes(PRUNED), 'and it names the entry that went');
      assert.ok(log.includes('history pruned: 1 claude conversation(s) with no transcript'));
    } finally {
      await server.stop();
    }
  } finally {
    await removeTempDir(root);
  }
});
