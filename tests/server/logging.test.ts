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
 *      through two generations at 0600 (and its exact byte boundary), and
 *      error rendering WITH stacks;
 *   2. the boot banner — node/pid/data dir/log level/env/server commit/web build;
 *   3. the HTTP access log — and what it deliberately omits (query VALUES);
 *   4. the WebSocket log — attach/detach/resize/input, byte counts only.
 *
 * How: the logger in-process on a temp file; the banner, access log and ws log
 * on a real server child (`startTestServer`), read back from its server.log.
 *
 * The standing rule every one of these guards: NO SECRETS IN THE LOG. Terminal
 * input, request bodies, query values and credentials never appear, whatever
 * else does.
 *
 * NOT claimed here: POST /api/client-log — `tests/server/logging-client-log.test.ts`;
 * the end-to-end leak canaries, refusal budgets and the other review-gate
 * gaps — `tests/server/logging-hardening.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
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
} from '../../server/config.ts';
import {
  api,
  createSession,
  removeTempDir,
  startTestServer,
  waitForLog,
  projectRoot,
  wsExpectRejected,
  wsUrl,
  WsClient,
  makeTempDirSync,
} from '../helpers/helpers.ts';
import { tempDir, postClientLog } from '../helpers/logging-fixture.ts';

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
  const root = makeTempDirSync('ai-sm-log-refuse-');
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
    await removeTempDir(root);
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

test('the high-frequency polls are demoted to debug: /api/client-log and /api/update/status', async () => {
  const server = await startTestServer();
  try {
    const shipped = await api(server, 'POST', '/api/client-log', { entries: [] });
    assert.equal(shipped.status, 204);
    const status = await api(server, 'GET', '/api/update/status');
    assert.equal(status.status, 200, 'the status route answers 200 in this harness');

    const log = await waitForLog(server, '[http] GET /api/update/status');
    assert.match(
      log,
      /\[debug\] \[http\] POST \/api\/client-log -> 204/,
      'the log-shipping POST is written at debug',
    );
    assert.match(
      log,
      /\[debug\] \[http\] GET \/api\/update\/status -> 200/,
      'the 1 Hz update-progress poll is written at debug too',
    );
    assert.ok(
      !/\[info\] \[http\] GET \/api\/update\/status/.test(log),
      'never at info — it would bury the rest of the file for the whole install',
    );
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
