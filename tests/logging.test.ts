/**
 * Comprehensive logging (2026-09-06, user's explicit request: "everything gets
 * logged").
 *
 * server.log is the ONLY diagnostic channel a detached backend has — the
 * motivating incident was a stale backend answering 404 for /api/history with
 * nothing in the log to say so. These tests pin the parts that make the next
 * problem diagnosable from the file alone:
 *
 *   1. the logger itself — levels, the AI_SM_LOG_LEVEL default, rotation
 *      through two generations at 0600, and error rendering WITH stacks;
 *   2. the boot banner — node/pid/data dir/log level/env/server commit/web build;
 *   3. the HTTP access log — and what it deliberately omits (query VALUES);
 *   4. the WebSocket log — attach/detach/resize/input, byte counts only;
 *   5. POST /api/client-log — auth, caps, truncation, control-character
 *      stripping, the rate limit, 204.
 *
 * The standing rule every one of these guards: NO SECRETS IN THE LOG. Terminal
 * input, request bodies, query values and credentials never appear, whatever
 * else does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLogger,
  describeError,
  errorClass,
  errorFrames,
  errorStackOnly,
  oneLine,
  resolveLogLevel,
  scoped,
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  MAX_LOG_BYTES,
  MAX_LOGGED_ROUTE_CHARS,
  REFUSAL_LOG_MAX_PER_MINUTE,
  createRefusalLimiter,
} from '../server/config.ts';
import { ProjectStore } from '../server/projects.ts';
import { PrefsStore } from '../server/prefs.ts';
import { SessionHistory } from '../server/history.ts';
import { SessionManager } from '../server/sessions.ts';
import { GithubConnection } from '../server/github.ts';
import { LifecycleController } from '../server/lifecycle.ts';
import { createUpgradeHandler } from '../server/ws.ts';
import {
  createRequestHandler,
  CLIENT_LOG_MAX_BYTES,
  CLIENT_LOG_MAX_ENTRIES,
  CLIENT_LOG_MAX_MESSAGE,
  CLIENT_LOG_MAX_PER_MINUTE,
} from '../server/api.ts';
import {
  api,
  createSession,
  destroyAllAndSettle,
  rawRequest,
  readServerLog,
  removeTempDir,
  startTestServer,
  waitForLog,
  waitUntil,
  projectRoot,
  wsExpectRejected,
  wsUrl,
  WsClient,
  type TestServer,
} from './helpers.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ai-sm-log-'));
}

// ---------------------------------------------------------------------------
// 1. The logger
// ---------------------------------------------------------------------------

test('levels: debug is the default minimum, and AI_SM_LOG_LEVEL raises it', () => {
  assert.deepEqual(LOG_LEVELS, ['debug', 'info', 'warn', 'error']);
  assert.equal(DEFAULT_LOG_LEVEL, 'debug');

  // Unset / empty -> everything is logged. That is the user's rule.
  assert.deepEqual(resolveLogLevel(undefined), { level: 'debug', raw: undefined, valid: true });
  assert.deepEqual(resolveLogLevel(''), { level: 'debug', raw: undefined, valid: true });

  for (const level of LOG_LEVELS) {
    assert.deepEqual(resolveLogLevel(level), { level, raw: level, valid: true });
    assert.deepEqual(resolveLogLevel(` ${level.toUpperCase()} `), {
      level,
      raw: ` ${level.toUpperCase()} `,
      valid: true,
    });
  }
  // An unrecognized value NEVER silences the log — it falls back to debug and
  // is reported as invalid so the boot banner can say so.
  const bogus = resolveLogLevel('verbose');
  assert.deepEqual(bogus, { level: 'debug', raw: 'verbose', valid: false });
});

test('a logger drops everything below its minimum level and keeps the line shape', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'server.log');
    const log = createLogger(file, 'warn');
    log('debug', 'DEBUG-LINE');
    log('info', 'INFO-LINE');
    log('warn', 'WARN-LINE');
    log('error', 'ERROR-LINE');
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes('DEBUG-LINE'), 'debug is below warn');
    assert.ok(!text.includes('INFO-LINE'), 'info is below warn');
    assert.ok(text.includes('WARN-LINE') && text.includes('ERROR-LINE'));
    // `<ISO> [level] message`, one line per event.
    const lines = text.trimEnd().split('\n');
    assert.equal(lines.length, 2);
    assert.match(
      lines[0] as string,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[warn\] WARN-LINE$/,
    );
    // 0600 on the file the logger creates.
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    void rm(dir, { recursive: true, force: true });
  }
});

test('scoped() tags a component without changing the call signature', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'server.log');
    const log = createLogger(file, 'debug');
    scoped(log, 'http')('info', 'GET /api/history -> 200');
    assert.match(readFileSync(file, 'utf8'), /\[info\] \[http\] GET \/api\/history -> 200\n$/);
  } finally {
    void rm(dir, { recursive: true, force: true });
  }
});

test('rotation: server.log.1 shifts to server.log.2, both forced to 0600', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'server.log');
    assert.equal(MAX_LOG_BYTES, 10 * 1024 * 1024, 'the cap is 10 MiB (<= 30 MiB on disk in total)');

    // A previous generation, deliberately world-readable, to prove the rotate
    // re-applies 0600 rather than inheriting whatever mode was there.
    writeFileSync(`${file}.1`, 'GENERATION-ONE\n');
    chmodSync(`${file}.1`, 0o644);
    // A live file already at the cap: the very next line must rotate.
    writeFileSync(file, 'LIVE-CONTENT\n');
    truncateSync(file, MAX_LOG_BYTES);
    chmodSync(file, 0o644);

    createLogger(file, 'debug')('info', 'AFTER-ROTATION');

    assert.equal(readFileSync(`${file}.2`, 'utf8'), 'GENERATION-ONE\n', '.1 became .2');
    assert.ok(readFileSync(`${file}.1`, 'utf8').startsWith('LIVE-CONTENT\n'), 'the live file became .1');
    const live = readFileSync(file, 'utf8');
    assert.ok(live.includes('AFTER-ROTATION'));
    assert.ok(live.length < 1000, 'the live file starts fresh after a rotation');
    assert.equal(statSync(`${file}.1`).mode & 0o777, 0o600, 'rotated files are 0600');
    assert.equal(statSync(`${file}.2`).mode & 0o777, 0o600, 'rotated files are 0600');
    assert.equal(statSync(file).mode & 0o777, 0o600);

    // A second rotation shifts again: the old .2 is the one that falls off.
    truncateSync(file, MAX_LOG_BYTES);
    createLogger(file, 'debug')('info', 'AFTER-SECOND-ROTATION');
    assert.ok(readFileSync(`${file}.2`, 'utf8').startsWith('LIVE-CONTENT\n'));
    assert.ok(readFileSync(file, 'utf8').includes('AFTER-SECOND-ROTATION'));
  } finally {
    void rm(dir, { recursive: true, force: true });
  }
});

test('a logger never throws, whatever the destination does', () => {
  const dir = tempDir();
  try {
    // A directory where the log file should be: every write fails.
    const file = join(dir, 'server.log');
    mkdirSync(file);
    const log = createLogger(file, 'debug');
    assert.doesNotThrow(() => log('error', 'this cannot be written anywhere'));
  } finally {
    void rm(dir, { recursive: true, force: true });
  }
});

test('describeError renders the STACK on one line; errorStackOnly drops the message', () => {
  const err = new TypeError('boom: ghp_NOTREALLYASECRET');
  const described = describeError(err);
  assert.ok(described.startsWith('TypeError: boom:'), described);
  assert.ok(described.includes(' | at '), 'the stack frames are kept, flattened');
  assert.ok(!described.includes('\n'), 'a rendered error is ALWAYS one log line');

  // The redacted rendering used where the message may quote request data.
  const redacted = errorStackOnly(err);
  assert.equal(errorClass(err), 'TypeError');
  assert.ok(redacted.startsWith('TypeError | at '), redacted);
  assert.ok(!redacted.includes('boom'), 'the message never survives errorStackOnly');
  assert.ok(!redacted.includes('ghp_'), 'and neither does anything the message quoted');
  assert.ok(errorFrames(err).startsWith('at '));

  // Non-Error throws still say something useful.
  assert.equal(describeError('plain string'), 'plain string');
  assert.equal(describeError(42), '42');
  assert.equal(errorClass(42), 'number');
  assert.equal(errorFrames(42), '');

  // A forged newline in a thrown message cannot fabricate a second log line.
  const forged = describeError(new Error('line one\n2026-01-01T00:00:00.000Z [error] FORGED'));
  assert.ok(!forged.includes('\n'));
  assert.ok(forged.includes('line one | 2026-01-01T00:00:00.000Z [error] FORGED'));

  assert.equal(oneLine('a\nb\tc\u0000d\r\ne'), 'a b c d e');
});

// ---------------------------------------------------------------------------
// 2. Boot banner
// ---------------------------------------------------------------------------

test('the boot banner names the code, the build and the environment', async () => {
  const server = await startTestServer();
  try {
    const log = await waitForLog(server, '[boot] web build');
    assert.match(log, /\[info\] \[boot\] ai-cli-application backend starting \(node v\d+\./);
    assert.ok(log.includes(`pid ${server.runtime.pid})`), 'the pid is in the banner');
    assert.ok(log.includes(`[boot] data dir ${server.dataDir}`));
    assert.match(log, /\[boot\] log level debug \(AI_SM_LOG_LEVEL unset, default\), rotation at 10485760 bytes, 2 kept generations/);
    // Every AI_SM_* override in effect, by name and value.
    assert.ok(log.includes(`[boot] env AI_SM_DATA_DIR=${JSON.stringify(server.dataDir)}`));
    assert.ok(log.includes('[boot] env AI_SM_GRACE_MS="600000"'));
    // Code identity: a short hash + the file's mtime — but only when a .git is
    // actually there. A checkout WITHOUT .git (a tarball, a vendored copy) is a
    // real deployment shape, and the banner says `commit unknown` for it.
    const hasGit = existsSync(join(projectRoot, '.git'));
    assert.match(
      log,
      hasGit
        ? /\[boot\] server code [0-9a-f]{7} \(server\/index\.ts mtime \d{4}-/
        : /\[boot\] server code commit unknown \(server\/index\.ts mtime \d{4}-/,
    );
    // Frontend identity, or an explicit statement that there is none.
    assert.ok(
      /\[boot\] web build assets\/index-.*\.js \(build id [A-Za-z0-9._+-]+, web\/dist\/index\.html mtime \d{4}-/.test(
        log,
      ) ||
        log.includes('[boot] web build: web/dist missing'),
      'the banner states the frontend build or says web/dist is missing',
    );

    // The same identity is served to the UI.
    const res = await api(server, 'GET', '/api/runtime');
    const body = res.body as { serverCommit: string | null; webBuild: string | null };
    const commit = /\[boot\] server code ([0-9a-f]{7}) /.exec(log)?.[1];
    assert.equal(body.serverCommit, commit ?? null, 'GET /api/runtime reports the same commit');
    assert.equal(body.serverCommit === null, !hasGit, 'no .git -> no commit, and vice versa');
    if (body.webBuild !== null) assert.ok(log.includes(`[boot] web build ${body.webBuild} `));

    // The auth token is never in the banner (or anywhere else).
    assert.ok(!log.includes(server.token), 'the app token never reaches server.log');
  } finally {
    await server.stop();
  }
});

test('AI_SM_LOG_LEVEL is honoured end to end: info+debug are dropped, warn+ still arrive', async () => {
  const server = await startTestServer({ env: { AI_SM_LOG_LEVEL: 'warn' } });
  try {
    await api(server, 'GET', '/api/history');
    // A line the SERVER writes at warn on demand, so this test can prove the
    // file is being written at all. Without it every assertion below would
    // also pass against a log that is simply empty — which is exactly the way
    // a level test goes vacuous.
    assert.equal(
      (
        await postClientLog(server, {
          entries: [
            { level: 'warn', at: '', message: 'LEVEL-PROBE-WARN' },
            { level: 'info', at: '', message: 'LEVEL-PROBE-INFO' },
            { level: 'debug', at: '', message: 'LEVEL-PROBE-DEBUG' },
          ],
        })
      ).status,
      204,
    );
    const log = await waitForLog(server, 'LEVEL-PROBE-WARN');

    assert.ok(log.includes('[warn] [client] LEVEL-PROBE-WARN'), 'warn survives the filter');
    assert.ok(!log.includes('LEVEL-PROBE-INFO'), 'info is below the minimum');
    assert.ok(!log.includes('LEVEL-PROBE-DEBUG'), 'debug is below the minimum');
    assert.ok(!log.includes('[boot] data dir'), 'the banner is info: dropped at level warn');
    assert.ok(!log.includes('[http] GET /api/history'), 'access-log lines are info');
    assert.ok(!log.includes('[info]'), 'not one info line reached the file');
    assert.ok(!log.includes('[debug]'), 'and not one debug line');
  } finally {
    await server.stop();
  }
});

test('an UNRECOGNIZED AI_SM_LOG_LEVEL never silences the log: default + a banner note', async () => {
  const server = await startTestServer({ env: { AI_SM_LOG_LEVEL: 'verbose' } });
  try {
    const log = await waitForLog(server, '[boot] log level');
    assert.ok(
      log.includes(
        '[boot] log level debug (AI_SM_LOG_LEVEL = "verbose" — unrecognized, using the default)',
      ),
      `the banner must name the bad value and say what it did instead: ${log.slice(0, 600)}`,
    );
    // The fallback is the DEFAULT, i.e. everything — not silence.
    assert.ok(log.includes('[boot] data dir'), 'info still logged');
    await waitForLog(server, '[debug]');
  } finally {
    await server.stop();
  }
});

test('boot banner: env values are redacted by NAME and by URL SHAPE; empty vars are skipped', async () => {
  const server = await startTestServer({
    env: {
      AI_SM_FAKE_URL: 'https://u:PWCANARY7@example.test/',
      AI_SM_FAKE_TOKEN: 'TOKENCANARY7',
      AI_SM_FAKE_API_KEY: 'KEYCANARY7',
      AI_SM_FAKE_PASSWORD: 'PASSCANARY7',
      AI_SM_FAKE_AUTH_HEADER: 'AUTHCANARY7',
      AI_SM_FAKE_CRED_FILE: 'CREDCANARY7',
      AI_SM_FAKE_SECRET: 'SECRETCANARY7',
      AI_SM_FAKE_PLAIN: 'PLAINVALUE7',
      AI_SM_FAKE_EMPTY: '',
    },
  });
  try {
    const log = await waitForLog(server, '[boot] server code');

    // By SHAPE: a URL carrying userinfo.
    assert.ok(
      log.includes('[boot] env AI_SM_FAKE_URL=<redacted: embeds credentials>'),
      'a URL with userinfo is redacted, and the variable is still NAMED',
    );
    assert.ok(!log.includes('PWCANARY7'), 'the embedded password never reaches server.log');

    // By NAME: TOKEN|SECRET|PASSWORD|PASSWD|KEY|CRED|AUTH.
    for (const [name, canary] of [
      ['AI_SM_FAKE_TOKEN', 'TOKENCANARY7'],
      ['AI_SM_FAKE_API_KEY', 'KEYCANARY7'],
      ['AI_SM_FAKE_PASSWORD', 'PASSCANARY7'],
      ['AI_SM_FAKE_AUTH_HEADER', 'AUTHCANARY7'],
      ['AI_SM_FAKE_CRED_FILE', 'CREDCANARY7'],
      ['AI_SM_FAKE_SECRET', 'SECRETCANARY7'],
    ] as const) {
      assert.ok(log.includes(`[boot] env ${name}=<redacted by name>`), `${name} redacted by name`);
      assert.ok(!log.includes(canary), `${name}'s value never reaches server.log`);
    }

    // An ordinary value IS logged — otherwise the redaction above would prove
    // nothing (a banner that logs no env at all passes every check above).
    assert.ok(log.includes('[boot] env AI_SM_FAKE_PLAIN="PLAINVALUE7"'), 'plain values are shown');

    // '' is not an override for any consumer, so it is not reported as one.
    assert.ok(!log.includes('AI_SM_FAKE_EMPTY'), 'an empty variable is skipped entirely');
  } finally {
    await server.stop();
  }
});

test('boot banner: AI_SM_GITHUB_API_BASE with userinfo is redacted even as the server refuses to start', async () => {
  // The brief's exact case. This value ALSO makes the server refuse to start
  // (assertLoopbackApiBase), and the banner runs before that refusal — so the
  // redaction has to hold on the one path where the value is known-hostile.
  const root = mkdtempSync(join(tmpdir(), 'ai-sm-log-refuse-'));
  const dataDir = join(root, 'data');
  try {
    const child = spawn(process.execPath, [join(projectRoot, 'server', 'index.ts')], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AI_SM_DATA_DIR: dataDir,
        AI_SM_GITHUB_API_BASE: 'http://u:PWCANARY9@127.0.0.1:1/',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const code = await new Promise<number | null>((resolve) =>
      child.once('exit', (c) => resolve(c)),
    );
    assert.equal(code, 1, `the server must refuse to start (stderr: ${stderr.slice(0, 300)})`);

    const log = readFileSync(join(dataDir, 'server.log'), 'utf8');
    assert.ok(
      log.includes('[boot] env AI_SM_GITHUB_API_BASE=<redacted: embeds credentials>'),
      `the banner names the variable without its value: ${log.slice(0, 600)}`,
    );
    assert.ok(
      log.includes('refusing to start: AI_SM_GITHUB_API_BASE must not embed credentials'),
      'and the refusal reason reaches the file (production stderr is /dev/null)',
    );
    assert.ok(!log.includes('PWCANARY9'), 'the password appears NOWHERE in server.log');
    assert.ok(!stderr.includes('PWCANARY9'), 'nor on stderr');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. HTTP access log
// ---------------------------------------------------------------------------

test('every request logs one line — and NEVER the query string values', async () => {
  const server = await startTestServer();
  try {
    await api(server, 'GET', '/api/history');
    const bad = await api(server, 'POST', '/api/sessions', { command: 'bash' });
    assert.equal(bad.status, 400);
    // A query value that would be a disaster to log.
    await api(server, 'GET', '/api/fs/list?path=%2Ftmp&probe=ghp_QUERYVALUE0123456789');

    const log = await waitForLog(server, '[http] GET /api/fs/list');
    assert.match(log, /\[info\] \[http\] GET \/api\/history -> 200 in \d+\.\dms \(\d+ B\)/);
    assert.match(
      log,
      /\[http\] POST \/api\/sessions -> 400 in \d+\.\dms \(\d+ B\) reason="args must be an array of strings"/,
      'a refusal logs the constant reason that was already computed',
    );
    assert.ok(log.includes('[http] GET /api/fs/list ?… -> 200'), 'a query is noted, never quoted');
    assert.ok(!log.includes('probe='), 'no query string reaches the log at all');
    assert.ok(!log.includes('ghp_QUERY'), 'and certainly not its value');
    assert.ok(!log.includes(server.token), 'the token is never logged');

    // /health is unauthenticated but still accounted for.
    await fetch(`${server.baseUrl}/health`);
    const after = await waitForLog(server, '[http] GET /health');
    assert.match(after, /\[http\] GET \/health -> 200 in \d+\.\dms \(11 B\)/);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// 4. WebSocket log
// ---------------------------------------------------------------------------

test('the ws log records upgrades, attach/detach, resize and input SIZE — never input content', async () => {
  const server = await startTestServer();
  try {
    const info = await createSession(server, { command: 'bash', args: ['-i'], cols: 80, rows: 24, cwd: '/tmp' });
    const client = await WsClient.connect(wsUrl(server, info.id));
    await client.waitForMessage('replay');

    const SECRET_INPUT = 'hunter2-not-in-the-log';
    client.send({ type: 'input', data: `${SECRET_INPUT}\n` });
    client.send({ type: 'resize', cols: 100, rows: 30 });
    await waitForLog(server, `[ws] session ${info.id}: resize 100x30`);
    await client.close();
    const log = await waitForLog(server, `[ws] detached session ${info.id}`);

    assert.match(log, new RegExp(`\\[ws\\] attached session ${info.id}, replayed \\d+ scrollback bytes \\(attached=1\\)`));
    assert.ok(
      !/\[ws\] session [^\n]*: input /.test(log),
      'input is NOT logged per frame — xterm.js sends one frame per keystroke',
    );
    assert.ok(!log.includes(SECRET_INPUT), 'terminal input content NEVER reaches the log');
    assert.ok(log.includes('[ws] detached session'), 'the detach is logged with the close code');
    assert.match(log, /\[ws\] detached session .* code=\d+ \(attached=0\)/);

    // A rejected upgrade says WHY, with the pathname only (the url carries the token).
    const why = await wsExpectRejected(wsUrl(server, info.id, 'wrong-token'));
    assert.match(why, /401/);
    const after = await waitForLog(server, '[ws] upgrade rejected');
    assert.ok(after.includes('[ws] upgrade rejected 401 on /ws/sessions/'), after.slice(-300));
    assert.ok(!after.includes('token=wrong'), 'a ws query string is never logged');

    await api(server, 'DELETE', `/api/sessions/${info.id}`);
    const killed = await waitForLog(server, 'kill requested by user');
    assert.ok(killed.includes(`[session] ${info.id} kill requested by user`));

    // Input is SUMMARIZED on the same interval as output, and unconditionally
    // at session exit: byte count + frame count, never a byte of content.
    const final = await waitForLog(server, `[session] ${info.id} input `);
    assert.match(
      final,
      new RegExp(
        `\\[session\\] ${info.id} input ${Buffer.byteLength(`${SECRET_INPUT}\n`)} bytes in \\d+ frame\\(s\\) over \\d+ms`,
      ),
      'one summary line carries the BYTE COUNT and the frame count',
    );
    assert.ok(!final.includes(SECRET_INPUT), 'still no input content anywhere in the file');
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// 5. POST /api/client-log
// ---------------------------------------------------------------------------

async function postClientLog(
  server: TestServer,
  body: unknown,
  opts: { token?: string; origin?: string } = {},
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token !== '') headers['x-auth-token'] = opts.token ?? server.token;
  if (opts.origin !== undefined) headers['origin'] = opts.origin;
  const res = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/client-log',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: res.body };
}

test('POST /api/client-log: authed, 204, and each entry becomes ONE [client] line', async () => {
  const server = await startTestServer();
  try {
    // Auth and origin parity with every other state-changing route.
    assert.equal((await postClientLog(server, { entries: [] }, { token: '' })).status, 401);
    assert.equal((await postClientLog(server, { entries: [] }, { token: 'wrong' })).status, 401);
    assert.equal(
      (await postClientLog(server, { entries: [] }, { origin: 'http://evil.example' })).status,
      403,
    );
    // Wrong method / wrong shape.
    const put = await rawRequest(server.port, {
      method: 'PUT',
      path: '/api/client-log',
      headers: { 'x-auth-token': server.token, 'content-type': 'application/json' },
      body: '{"entries":[]}',
    });
    assert.equal(put.status, 405);
    assert.equal((await postClientLog(server, { entries: 'nope' })).status, 400);
    assert.equal((await postClientLog(server, '{not json')).status, 400);

    const at = '2026-09-06T10:11:12.000Z';
    const res = await postClientLog(server, {
      entries: [
        { level: 'debug', at, message: 'CL-DEBUG' },
        { level: 'info', at, message: 'CL-INFO' },
        { level: 'warn', at, message: 'CL-WARN' },
        { level: 'error', at, message: 'CL-ERROR' },
        { level: 'trace', at, message: 'CL-UNKNOWN-LEVEL' },
        { level: 'info', at: 'not-a-date', message: 'CL-BAD-AT' },
        { message: 'CL-NO-FIELDS' },
      ],
    });
    assert.equal(res.status, 204, 'a batch is answered 204');
    assert.equal(res.body, '', 'with an empty body');

    const log = await waitForLog(server, 'CL-ERROR');
    assert.ok(log.includes(`[debug] [client] CL-DEBUG (client at ${at})`));
    assert.ok(log.includes(`[info] [client] CL-INFO (client at ${at})`));
    assert.ok(log.includes(`[warn] [client] CL-WARN (client at ${at})`));
    assert.ok(log.includes(`[error] [client] CL-ERROR (client at ${at})`));
    assert.ok(
      log.includes(`[info] [client] CL-UNKNOWN-LEVEL (client at ${at})`),
      'an unknown level becomes info',
    );
    // An invalid `at` falls back to SERVER time — never the raw string.
    assert.ok(!log.includes('not-a-date'));
    assert.match(log, /\[client\] CL-BAD-AT \(client at \d{4}-\d{2}-\d{2}T/);
    assert.match(log, /\[client\] CL-NO-FIELDS \(client at \d{4}-/);
  } finally {
    await server.stop();
  }
});

test('POST /api/client-log: size cap 413, entry cap, message truncation, control-character stripping', async () => {
  const server = await startTestServer();
  try {
    // 1. Body cap — refused before it is parsed, let alone logged.
    const huge = await postClientLog(server, {
      entries: [{ level: 'info', at: new Date().toISOString(), message: 'x'.repeat(CLIENT_LOG_MAX_BYTES) }],
    });
    assert.equal(huge.status, 413);
    assert.deepEqual(JSON.parse(huge.body), { error: 'request body is too large' });

    // 2. Entry cap — the first CLIENT_LOG_MAX_ENTRIES are kept, the rest dropped.
    const many = Array.from({ length: CLIENT_LOG_MAX_ENTRIES + 10 }, (_, i) => ({
      level: 'info' as const,
      at: new Date().toISOString(),
      message: `CAP-ENTRY-${i}`,
    }));
    assert.equal((await postClientLog(server, { entries: many })).status, 204);
    const capped = await waitForLog(server, `CAP-ENTRY-${CLIENT_LOG_MAX_ENTRIES - 1}`);
    assert.ok(capped.includes('CAP-ENTRY-0'));
    assert.ok(
      !capped.includes(`CAP-ENTRY-${CLIENT_LOG_MAX_ENTRIES}`),
      `entry ${CLIENT_LOG_MAX_ENTRIES} (0-based) is past the cap and must be dropped`,
    );
    assert.ok(capped.includes(`batch of ${CLIENT_LOG_MAX_ENTRIES + 10} entries truncated to ${CLIENT_LOG_MAX_ENTRIES}`));

    // 3. Message truncation — truncate, never reject.
    const long = `TRUNC-${'A'.repeat(4000)}`;
    assert.equal((await postClientLog(server, { entries: [{ level: 'info', at: '', message: long }] })).status, 204);
    const truncated = await waitForLog(server, 'TRUNC-A');
    const line = truncated.split('\n').find((l) => l.includes('TRUNC-A')) as string;
    const payload = line.slice(line.indexOf('TRUNC-'), line.lastIndexOf(' (client at '));
    assert.equal(payload.length, CLIENT_LOG_MAX_MESSAGE, 'the message is cut at the cap');

    // 4. Control characters — a newline must not forge a second log line.
    // A run of control characters: newline (would forge a line), NUL and tab.
    const forged = 'FORGE-START\n2026-01-01T00:00:00.000Z [error] FORGED-LINE\u0000\ttail';
    assert.equal((await postClientLog(server, { entries: [{ level: 'info', at: '', message: forged }] })).status, 204);
    const stripped = await waitForLog(server, 'FORGE-START');
    const forgedLine = stripped.split('\n').find((l) => l.includes('FORGE-START')) as string;
    assert.ok(
      forgedLine.includes('FORGE-START 2026-01-01T00:00:00.000Z [error] FORGED-LINE tail'),
      `the whole message stays on ONE line: ${JSON.stringify(forgedLine)}`,
    );
    assert.equal(
      stripped.split('\n').filter((l) => l.includes('FORGED-LINE')).length,
      1,
      'exactly one line mentions the forged text',
    );
  } finally {
    await server.stop();
  }
});

test('POST /api/client-log: past the per-minute budget entries are dropped with ONE warn', async () => {
  const server = await startTestServer();
  try {
    const batches = Math.ceil((CLIENT_LOG_MAX_PER_MINUTE + CLIENT_LOG_MAX_ENTRIES) / CLIENT_LOG_MAX_ENTRIES);
    let sent = 0;
    for (let b = 0; b < batches; b += 1) {
      const entries = Array.from({ length: CLIENT_LOG_MAX_ENTRIES }, () => ({
        level: 'info' as const,
        at: new Date().toISOString(),
        message: `FLOOD-${sent++}`,
      }));
      assert.equal((await postClientLog(server, { entries })).status, 204, 'flooding is never an error');
    }
    assert.ok(sent > CLIENT_LOG_MAX_PER_MINUTE, `sent ${sent} entries, over the budget`);

    const log = await waitUntil(
      async () => {
        const text = await readServerLog(server);
        return text.includes('rate limit reached') ? text : undefined;
      },
      'the client-log rate-limit warn line',
    );
    const written = log.split('\n').filter((l) => l.includes('[client] FLOOD-')).length;
    assert.equal(written, CLIENT_LOG_MAX_PER_MINUTE, 'exactly the budget is written, the rest dropped');
    assert.equal(
      log.split('\n').filter((l) => l.includes('rate limit reached')).length,
      1,
      'one warn per window, not one per dropped entry',
    );
    assert.match(log, /\[warn\] \[client\] rate limit reached \(200 entries\/minute\)/);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// 6. Gaps closed by the test gate (2026-09-06)
// ---------------------------------------------------------------------------

test('rotation boundary: a line that exactly fills the cap does not rotate; the next byte does', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'server.log');
    // The line the logger writes is `<24-char ISO> [info] <msg>\n`.
    const message = 'BOUNDARY';
    const lineBytes = new Date().toISOString().length + ' [info] '.length + message.length + 1;

    // Exactly at the cap: size + line === MAX_LOG_BYTES, and the check is `>`.
    writeFileSync(file, '');
    truncateSync(file, MAX_LOG_BYTES - lineBytes);
    createLogger(file, 'debug')('info', message);
    assert.equal(statSync(file).size, MAX_LOG_BYTES, 'the file lands exactly on the cap');
    assert.ok(readFileSync(file, 'utf8').endsWith(`[info] ${message}\n`), 'the line went in');
    assert.throws(() => statSync(`${file}.1`), 'a line that exactly fills the cap must NOT rotate');

    // One byte more than the cap allows: rotation.
    writeFileSync(file, '');
    truncateSync(file, MAX_LOG_BYTES - lineBytes + 1);
    createLogger(file, 'debug')('info', message);
    assert.equal(statSync(`${file}.1`).size, MAX_LOG_BYTES - lineBytes + 1, 'the old file rotated');
    assert.equal(statSync(file).size, lineBytes, 'the live file holds just the new line');
  } finally {
    void rm(dir, { recursive: true, force: true });
  }
});

test('POST /api/client-log: a forbidden Host is 403, in parity with every other authed route', async () => {
  const server = await startTestServer();
  try {
    const body = JSON.stringify({ entries: [{ level: 'info', at: '', message: 'HOST-CANARY' }] });
    for (const host of [`evil.example.com:${server.port}`, '127.0.0.1', 'localhost']) {
      const res = await rawRequest(server.port, {
        method: 'POST',
        path: '/api/client-log',
        headers: { host, 'x-auth-token': server.token, 'content-type': 'application/json' },
        body,
      });
      assert.equal(res.status, 403, `Host ${JSON.stringify(host)} must be refused`);
    }
    // The same request with the right Host is accepted — so the 403s above are
    // the Host check biting, not a broken request shape.
    const ok = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/client-log',
      headers: {
        host: `127.0.0.1:${server.port}`,
        'x-auth-token': server.token,
        'content-type': 'application/json',
      },
      body,
    });
    assert.equal(ok.status, 204);

    const log = await waitForLog(server, 'HOST-CANARY');
    assert.equal(
      log.split('\n').filter((l) => l.includes('HOST-CANARY')).length,
      1,
      'only the accepted request wrote a line — a refused Host logs nothing of the body',
    );
  } finally {
    await server.stop();
  }
});

test('POST /api/client-log: an oversized body is 413 and NOTHING from it is written', async () => {
  const server = await startTestServer();
  try {
    // The canary sits at the FRONT of the body, inside the first chunk the
    // server reads, so anything that logged what it read would show it.
    const oversized =
      '{"entries":[{"level":"info","at":"","message":"OVERSIZE_CANARY_a1b2c3' +
      'x'.repeat(CLIENT_LOG_MAX_BYTES + 1024) +
      '"}]}';
    assert.ok(Buffer.byteLength(oversized) > CLIENT_LOG_MAX_BYTES);
    const res = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/client-log',
      headers: { 'x-auth-token': server.token, 'content-type': 'application/json' },
      body: oversized,
    });
    assert.equal(res.status, 413);
    assert.deepEqual(JSON.parse(res.body), { error: 'request body is too large' });

    // The access-log line for the refused request proves the log is current.
    const log = await waitForLog(server, '[http] POST /api/client-log -> 413');
    assert.ok(!log.includes('OVERSIZE_CANARY_a1b2c3'), 'no fragment of the body is ever logged');
    assert.ok(!log.includes('xxxxxxxxxx'), 'not even filler bytes from the body');
  } finally {
    await server.stop();
  }
});

test('POST /api/client-log: CR, ESC, NUL and DEL cannot forge a second log line', async () => {
  const server = await startTestServer();
  try {
    // Every control character the gate names, in one message: a CRLF pair
    // (would forge a line), a bare CR, ESC (would inject a terminal escape into
    // whatever cats the file), NUL and DEL.
    const forged =
      'CRLF-CANARY\r\n2026-01-01T00:00:00.000Z [info] [boot] FORGED-BOOT-LINE' +
      '\rCARRIAGE\u001b[2J\u001b]0;title\u0007ESCAPED \u0000NUL\u007fDEL' +
      // C1 and the Unicode separators: U+0085 NEL is a line break to a pager,
      // U+009B is a single-byte CSI (an escape sequence with no ESC in front),
      // and U+2028/U+2029 end a line for anything that splits on them.
      '\u0085NEL\u009b31mCSI\u2028LS\u2029PS';
    assert.equal(
      (await postClientLog(server, { entries: [{ level: 'info', at: '', message: forged }] }))
        .status,
      204,
    );
    const log = await waitForLog(server, 'CRLF-CANARY');
    const lines = log.split('\n').filter((l) => l.includes('CANARY') || l.includes('FORGED'));
    assert.equal(lines.length, 1, `the whole message stays on ONE line: ${JSON.stringify(lines)}`);

    const line = lines[0] as string;
    // Shaped by the server: its own timestamp, its own level, its own tag.
    assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[info\] \[client\] /);
    assert.equal(
      log.split('\n').filter((l) => l.startsWith('2026-01-01T00:00:00.000Z')).length,
      0,
      'the payload never becomes a line that reads as the server own [boot] output',
    );
    assert.ok(line.includes('CRLF-CANARY '), 'CRLF became a space');
    assert.ok(line.includes(' CARRIAGE'), 'a bare CR became a space');
    assert.ok(line.includes('ESCAPED '), 'the tail survived as text');
    assert.ok(line.includes('NUL'), 'NUL became a space');
    assert.ok(line.includes('DEL'), 'DEL became a space');
    assert.ok(line.includes(' NEL'), 'U+0085 NEL became a space');
    assert.ok(line.includes(' 31mCSI'), 'U+009B (single-byte CSI) became a space');
    assert.ok(line.includes(' LS') && line.includes(' PS'), 'U+2028/U+2029 became spaces');
    assert.ok(
      !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(line),
      'not one control character survives — the file stays safe to cat',
    );
  } finally {
    await server.stop();
  }
});

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
  const root = mkdtempSync(join(tmpdir(), 'ai-sm-log-prune-'));
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
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9. The client-log rate-limit WINDOW (the gap the last gate reported open)
// ---------------------------------------------------------------------------

/**
 * The per-minute client-log budget lives INSIDE createRequestHandler
 * (server/api.ts) and reads the clock through a bare `Date.now()`, so the
 * window reset cannot be reached from a spawned server without waiting a real
 * minute. It CAN be reached by mounting the very same handler in this process
 * and moving the clock: the handler is exported, and `Date.now` is the only
 * time source the budget consults.
 *
 * This is a real HTTP server with the real request handler — not a hand-rolled
 * req/res double — so the auth gate, the body reader, the entry caps and the
 * budget are all the production code paths.
 */
interface InProcessApi {
  port: number;
  token: string;
  logFile: string;
  readLog: () => string;
  /** Move the INJECTED clock forward; the real one is never monkeypatched. */
  advance: (ms: number) => void;
}

async function withInProcessApi(fn: (ctx: InProcessApi) => Promise<void>): Promise<void> {
  const dir = tempDir();
  const logFile = join(dir, 'server.log');
  const log = createLogger(logFile, 'debug');
  const token = 'a'.repeat(64);
  // The clock SEAM the budgets read (ApiDeps.now / createWindowLimiter.now).
  // Injected, not monkeypatched: a global Date.now swap also moves the log's
  // own timestamps and anything else that happens to run in this process.
  let offsetMs = 0;
  const now = (): number => Date.now() + offsetMs;
  const history = new SessionHistory(join(dir, 'history.json'), log);
  const sessions = new SessionManager(log, history);
  // `boundPort` (not server.address()) because getPort is captured while the
  // server is still being constructed — a self-referential initializer.
  let boundPort = 0;
  const server: Server = createServer(
    createRequestHandler({
      token,
      getPort: () => boundPort,
      getStartedAt: () => new Date().toISOString(),
      projects: new ProjectStore(join(dir, 'projects.json'), log),
      prefs: new PrefsStore(join(dir, 'prefs.json'), log),
      sessions,
      history,
      github: new GithubConnection({
        file: join(dir, 'github.json'),
        log,
        clientId: undefined,
        apiBase: 'https://api.github.com',
      }),
      webDistDir: join(dir, 'dist'),
      log,
      allowRefusalLine: createRefusalLimiter(scoped(log, 'http'), now),
      now,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  boundPort = port;
  let bodyThrew = false;
  try {
    await fn({
      port,
      token,
      logFile,
      readLog: () => {
        try {
          return readFileSync(logFile, 'utf8');
        } catch {
          return '';
        }
      },
      advance: (ms) => {
        offsetMs += ms;
      },
    });
  } catch (err) {
    bodyThrew = true;
    throw err;
  } finally {
    // destroyAll() only kills the ptys; node-pty's `exit` lands ticks later and
    // its handler appends to server.log — a write that recreates the file in
    // the middle of the removal below and fails it with ENOTEMPTY.
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
}

test('client-log budget: the window RESETS — the next minute gets a fresh budget and a fresh warn', async () => {
  await withInProcessApi(async (ctx) => {
    const post = async (messages: string[]): Promise<number> => {
      const res = await rawRequest(ctx.port, {
        method: 'POST',
        path: '/api/client-log',
        headers: { 'x-auth-token': ctx.token, 'content-type': 'application/json' },
        body: JSON.stringify({
          entries: messages.map((message) => ({ level: 'info', at: '', message })),
        }),
      });
      return res.status;
    };
    const countLines = (needle: string): number =>
      ctx.readLog().split('\n').filter((l) => l.includes(needle)).length;

    // --- window 1: fill the budget and overrun it by 10 ---------------------
    let sent = 0;
    while (sent < CLIENT_LOG_MAX_PER_MINUTE + 10) {
      const batch = Math.min(CLIENT_LOG_MAX_ENTRIES, CLIENT_LOG_MAX_PER_MINUTE + 10 - sent);
      assert.equal(
        await post(Array.from({ length: batch }, (_, i) => `W1-${sent + i}`)),
        204,
        'flooding is never an error',
      );
      sent += batch;
    }
    assert.equal(countLines('[client] W1-'), CLIENT_LOG_MAX_PER_MINUTE, 'exactly the budget');
    assert.equal(countLines('rate limit reached'), 1, 'one warn for this window');
    assert.equal(countLines('[client] W1-209'), 0, 'the overrun really was dropped');

    // --- still the same window: nothing more gets through -------------------
    assert.equal(await post(['W1-LATE']), 204);
    assert.equal(countLines('[client] W1-LATE'), 0, 'the budget still holds');
    assert.equal(countLines('rate limit reached'), 1, 'and the warn is NOT repeated');

    // --- window 2: move the INJECTED clock past the window ------------------
    ctx.advance(61_000);
    assert.equal(await post(['W2-FIRST']), 204);
    assert.equal(countLines('[client] W2-FIRST'), 1, 'a fresh window logs again');
    assert.equal(
      countLines('client log entr(ies) in the last window'),
      1,
      'the rolled-over window states the total it did not show',
    );

    // --- window 2 can be exhausted on its own, with its own warn ------------
    let sent2 = 0;
    while (sent2 < CLIENT_LOG_MAX_PER_MINUTE + 5) {
      const batch = Math.min(CLIENT_LOG_MAX_ENTRIES, CLIENT_LOG_MAX_PER_MINUTE + 5 - sent2);
      assert.equal(await post(Array.from({ length: batch }, (_, i) => `W2-${sent2 + i}`)), 204);
      sent2 += batch;
    }
    // 1 (W2-FIRST) + the budget minus that one = the budget for this window.
    assert.equal(
      countLines('[client] W2-') ,
      CLIENT_LOG_MAX_PER_MINUTE,
      'the second window gets its OWN full budget, no more',
    );
    assert.equal(countLines('rate limit reached'), 2, 'one warn per window, and this is a new one');
  });
});
