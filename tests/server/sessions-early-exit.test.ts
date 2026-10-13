/**
 * A Claude launch that dies right after it started (Nocturne D6,
 * `.claude/plans/nocturne/PLAN-D6.md` § Test gate, "Early exit"): a
 * claude-kind session — a fresh launch, a direct `--resume`, or POST
 * /api/history/:id/resume — that exits NON-ZERO within EARLY_EXIT_MS (3 s)
 * gets `SessionInfo.earlyExit = { line }` and `early` on its exit frame, the
 * line being the first non-empty line it printed, escape-stripped, ≤ 200
 * characters; one WARN line names the probed version and that line.
 *
 * How: ONE real server child whose PATH resolves `claude` to a double that
 * answers `--version` (tests/helpers/history-fixture.ts) and then behaves by
 * a flag in its argv — fail at once, fail after 1 s, fail after 4 s, exit 0.
 * The flags are client args, so a history resume carries them too. Plus the
 * two pure pieces (`firstOutputLine`, `RingBuffer.head`) called directly.
 *
 * Why it matters: without the flag the pane says only "Finished, code 1" and
 * the user cannot tell an unknown-flag refusal (a Claude Code too new or too
 * old for this app) from anything else.
 *
 * NOT claimed: the pane banner and the notice coming back (the web half,
 * tests/ui/); a real Claude Code refusing a real flag.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExitMessage, RuntimeStatusResponse, SessionInfo } from '../../shared/protocol.ts';
import { EARLY_EXIT_LINE_MAX, EARLY_EXIT_MS } from '../../shared/protocol.ts';
import { earlyExitLine, firstOutputLine, RingBuffer } from '../../server/sessions-output.ts';
import {
  api,
  createSession,
  getSession,
  readServerLog,
  startTestServer,
  waitForLog,
  waitUntil,
  wsUrl,
  WsClient,
  type TestServer,
  makeTempDir,
  removeTempDir,
} from '../helpers/helpers.ts';
import { CLAUDE_DOUBLE_VERSION } from '../helpers/history-fixture.ts';

/** The refusal a too-old Claude Code prints, coloured as a real CLI would. */
const REFUSAL = 'error: unknown option "--session-id"';

const DOUBLE = `${CLAUDE_DOUBLE_VERSION}for a in "$@"; do
  case "$a" in
    --d6-fail-now) printf '\\033[?25l\\r\\n  \\033[31m${REFUSAL}\\033[0m\\r\\nsecond line\\r\\n'; exit 2 ;;
    --d6-fail-soon) sleep 1; printf '${REFUSAL}\\r\\n'; exit 1 ;;
    --d6-fail-late) printf 'late\\r\\n'; sleep 4; exit 2 ;;
    --d6-silent) exit 3 ;;
    --d6-exit-ok) printf 'bye\\r\\n'; exit 0 ;;
    --d6-hup-fails) trap 'exit 1' HUP; printf 'ready\\r\\n'; sleep 300 & wait; exit 0 ;;
  esac
done
printf 'claude double ready\\n'
sleep 300
`;

let root: string;
let workDir: string;
let server: TestServer;

before(async () => {
  root = await realpath(await makeTempDir('ai-sm-early-exit-'));
  const binDir = join(root, 'bin');
  workDir = join(root, 'work');
  await mkdir(binDir);
  await mkdir(workDir);
  await writeFile(join(binDir, 'claude'), DOUBLE, { mode: 0o755 });
  server = await startTestServer({
    env: {
      PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
      CLAUDE_CONFIG_DIR: join(root, 'claude-config'),
      AI_SM_TEST_CLAUDE_VERSION: '2.1.300 (Claude Code)',
    },
  });
  // The WARN line names the probed version: wait for the probe first.
  await waitUntil(async () => {
    const body = (await api(server, 'GET', '/api/runtime')).body as RuntimeStatusResponse;
    return body.claude.version === '2.1.300' ? true : undefined;
  }, 'the version probe to answer');
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (root !== undefined) await removeTempDir(root);
});

function launch(args: string[], command = 'claude'): Promise<SessionInfo> {
  return createSession(server, { command, args, cwd: workDir, cols: 80, rows: 24 });
}

/** The session once it has exited (GET /api/sessions). */
async function exited(id: string, timeoutMs = 10_000): Promise<SessionInfo> {
  return waitUntil(
    async () => {
      const s = await getSession(server, id);
      return s?.status === 'exited' ? s : undefined;
    },
    `session ${id} to exit`,
    timeoutMs,
  );
}

/** The exit frame an attach gets. */
async function exitFrame(id: string): Promise<ExitMessage> {
  const client = await WsClient.connect(wsUrl(server, id));
  try {
    return await client.waitForMessage('exit');
  } finally {
    await client.close();
  }
}

test('the window is 3 s and the line is capped at 200 characters', () => {
  assert.equal(EARLY_EXIT_MS, 3000);
  assert.equal(EARLY_EXIT_LINE_MAX, 200);
});

test('firstOutputLine: escapes go whole, controls go, the first non-empty line wins, capped', () => {
  const rows: [string, string][] = [
    ['', ''],
    ['\r\n\r\n   \n', ''],
    ['\u001b[?1049h\u001b[2J\u001b[H\u001b[31merror:\u001b[0m bad flag\r\nnext', 'error: bad flag'],
    ['\u001b]0;✳ title\u0007hello', 'hello'],
    ['\u001b]8;;https://x\u001b\\link\u001b]8;;\u001b\\ text', 'link text'],
    ['\u001b(Bplain\u0008\u0000 tail', 'plain tail'],
    ['a\rb', 'a'],
    ['\u001b[unterminated', 'nterminated'],
  ];
  for (const [input, want] of rows) {
    assert.equal(firstOutputLine(input, 200), want, JSON.stringify(input));
  }
  assert.equal(firstOutputLine('x'.repeat(500), 200), 'x'.repeat(200));
});

test('firstOutputLine drops every bidi control, so the line reads as it was printed', () => {
  const bidi = ['؜', '‎', '‏', '‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩'];
  for (const c of bidi) {
    assert.equal(firstOutputLine(`error: ${c}abc${c} done`, 200), 'error: abc done', `U+${c.codePointAt(0)?.toString(16)}`);
  }
  assert.equal(firstOutputLine('‮⁦\r\nreal', 200), 'real', 'a line of only bidi controls is empty');
});

test('earlyExitLine: non-zero inside the window answers the first line and the run time; anything else none', () => {
  const ring = new RingBuffer(1024);
  ring.append('\u001b[31merror: bad\u001b[0m\r\nmore');
  const t0 = '2026-10-13T10:00:00.000Z';
  const at = (ms: number): number => Date.parse(t0) + ms;
  assert.deepEqual(earlyExitLine(t0, at(10), 2, ring), { line: 'error: bad', ranMs: 10 });
  assert.deepEqual(earlyExitLine(t0, at(2999), 1, ring), { line: 'error: bad', ranMs: 2999 });
  assert.equal(earlyExitLine(t0, at(3000), 2, ring), undefined, 'the window is strict');
  assert.equal(earlyExitLine(t0, at(10), 0, ring), undefined, 'exit 0 is not a refusal');
  assert.equal(earlyExitLine('not a date', at(10), 2, ring), undefined, 'an unreadable createdAt flags nothing');
  assert.deepEqual(earlyExitLine(t0, at(5), 2, new RingBuffer(16)), { line: '', ranMs: 5 });
});

test('RingBuffer.head reads only the first bytes the ring holds, across chunks', () => {
  const ring = new RingBuffer(1024);
  ring.append('abc');
  ring.append('defgh');
  ring.append('ij');
  assert.equal(ring.head(5).toString('utf8'), 'abcde');
  assert.equal(ring.head(3).toString('utf8'), 'abc');
  assert.equal(ring.head(100).toString('utf8'), 'abcdefghij');
  assert.equal(new RingBuffer(16).head(8).byteLength, 0);
});

test('a claude that prints a refusal and exits 2 at once is flagged with that line, on the session and the attach frame', async () => {
  const info = await launch(['--d6-fail-now']);
  const done = await exited(info.id);
  assert.equal(done.exitCode, 2);
  assert.deepEqual(done.earlyExit, { line: REFUSAL }, 'the first non-empty line, escape-stripped');
  const frame = await exitFrame(info.id);
  assert.deepEqual(frame, { type: 'exit', exitCode: 2, early: { line: REFUSAL } });
  const log = await waitForLog(server, `${info.id} Claude Code stopped right after it started`);
  const line = log.split('\n').find((l) => l.includes(`${info.id} Claude Code stopped`)) ?? '';
  assert.match(line, /\[warn\] \[session\] /);
  assert.ok(line.includes('(code 2, after '), line);
  assert.ok(line.includes(`Claude Code 2.1.300): ${JSON.stringify(REFUSAL)}`), line);
  assert.ok(!line.includes('\u001b'), 'no escape byte reaches server.log');
});

test('the live exit frame carries `early` to a client attached before the exit', async () => {
  const info = await launch(['--d6-fail-soon']);
  const client = await WsClient.connect(wsUrl(server, info.id));
  try {
    const frame = await client.waitForMessage('exit');
    assert.deepEqual(frame, { type: 'exit', exitCode: 1, early: { line: REFUSAL } });
    const infos = client.messages.filter((m) => m.type === 'info');
    const last = infos[infos.length - 1];
    assert.ok(last !== undefined && last.type === 'info');
    assert.deepEqual(last.session.earlyExit, { line: REFUSAL }, 'the info frame before the exit carries it too');
  } finally {
    await client.close();
  }
});

test('an early exit that printed nothing is flagged with an empty line', async () => {
  const info = await launch(['--d6-silent']);
  const done = await exited(info.id);
  assert.deepEqual(done.earlyExit, { line: '' });
  assert.deepEqual(await exitFrame(info.id), { type: 'exit', exitCode: 3, early: { line: '' } });
});

test('exit 0 at once is not an early exit', async () => {
  const info = await launch(['--d6-exit-ok']);
  const done = await exited(info.id);
  assert.equal(done.exitCode, 0);
  assert.equal(done.earlyExit, undefined);
  assert.deepEqual(await exitFrame(info.id), { type: 'exit', exitCode: 0 });
});

test('a claude the user deletes within 3 s, exiting 1 on the SIGHUP, is not an early exit', async () => {
  const info = await launch(['--d6-hup-fails']);
  const client = await WsClient.connect(wsUrl(server, info.id));
  try {
    await client.waitForOutput('ready');
  } finally {
    await client.close();
  }
  assert.equal((await api(server, 'DELETE', `/api/sessions/${info.id}`)).status, 200);
  // The scenario really happened: a non-zero exit, inside the window.
  const log = await waitForLog(server, `session ${info.id} exited with code 1`);
  assert.ok(!log.includes(`${info.id} Claude Code stopped`), 'a kill is not a refusal: no WARN');
  const exitLine = log.split('\n').find((l) => l.includes(`session ${info.id} exited with code 1`)) ?? '';
  const ranMs = Date.parse(exitLine.slice(0, 24)) - Date.parse(info.createdAt);
  assert.ok(ranMs < EARLY_EXIT_MS, `the exit fell inside the window (${ranMs}ms), so only the kill rule spared it`);
});

test('a shell session exiting 2 at once is not an early exit', async () => {
  const info = await launch(['-c', `printf '${REFUSAL}\\n'; exit 2`], 'bash');
  const done = await exited(info.id);
  assert.equal(done.exitCode, 2);
  assert.equal(done.earlyExit, undefined);
  assert.deepEqual(await exitFrame(info.id), { type: 'exit', exitCode: 2 });
  // No wait needed: onExit writes its log lines synchronously, before the
  // status this test already saw as exited.
  assert.ok(!(await readServerLog(server)).includes(`${info.id} Claude Code stopped`));
});

test('a claude exiting 2 after 4 s is not an early exit', async () => {
  const info = await launch(['--d6-fail-late']);
  const done = await exited(info.id, 15_000);
  assert.equal(done.exitCode, 2);
  assert.equal(done.earlyExit, undefined, 'past EARLY_EXIT_MS the code alone says nothing new');
  assert.deepEqual(await exitFrame(info.id), { type: 'exit', exitCode: 2 });
});

test('a resume launch is flagged the same: a direct --resume and POST /api/history/:id/resume', async () => {
  const direct = await launch(['--resume', '0b0b0b0b-1111-2222-3333-444444444444', '--d6-fail-now']);
  assert.deepEqual((await exited(direct.id)).earlyExit, { line: REFUSAL }, 'direct --resume');

  // A conversation launched (and dying), then resumed from history: the base
  // args carry the flag, so the resume dies the same way.
  const first = await launch(['--d6-fail-now']);
  await exited(first.id);
  const resumed = await api(server, 'POST', `/api/history/${first.id}/resume`, { cols: 80, rows: 24 });
  assert.equal(resumed.status, 201, JSON.stringify(resumed.body));
  const next = resumed.body as SessionInfo;
  assert.ok(next.args.includes('--resume'), JSON.stringify(next.args));
  assert.deepEqual((await exited(next.id)).earlyExit, { line: REFUSAL }, 'history resume');
  assert.deepEqual(await exitFrame(next.id), { type: 'exit', exitCode: 2, early: { line: REFUSAL } });
});
