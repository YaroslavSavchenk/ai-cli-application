/**
 * Restart service keeps the sessions — Nocturne D9 P4
 * (`.claude/plans/nocturne/PLAN-D9.md` § Phases P4, § What the user gets):
 * one REAL restart (POST /api/restart: a real vite build into a copy of
 * web/dist, a real standby child, the same-port handoff) of a backend whose
 * PTYs live in the pty-host it started. The new backend adopts every session
 * — same id, same process, output continuous through the handoff, a bell
 * nobody looked at still raised and one already looked at not brought back,
 * an exited session with its code and scrollback — and history stamps
 * nothing. A clean stop of the new backend still ends them (decision 25).
 * PLAN-QUALITY Q17: the restart's exit record says `restart`, so the new
 * backend raises no "the app stopped" notice.
 *
 * How: a real backend child (`startTestServer`, `ptyHost: 'socket'`) on a
 * 0700 temp data dir, real bash PTYs that print their `$$`, and the new
 * backend found through runtime.json as the launcher finds it. One scenario,
 * set up once in `before`; each test asserts one claim. The update path is
 * the same restart (the UI posts it after the install) — the installed-mode
 * one is `restart-installed.test.ts`. Every pty-host, backend and PTY group is
 * ended in `after`.
 *
 * Why it matters: this is the user's ask — "after an update everything is
 * just open". A restart that drops a byte, re-raises an acknowledged bell or
 * stamps a running session `shutdown` breaks that promise silently.
 *
 * NOT claimed: a pty-host the new code cannot adopt — `restart-incompatible.test.ts`;
 * the browser's reconnect and repaint, Windows — `.claude/skills/verify-terminal/SKILL.md`.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryEntry, RestartResponse, RuntimeInfo, SessionInfo } from '../../shared/protocol.ts';
import {
  api,
  createSession,
  makeTempDir,
  readServerLog,
  removeTempDir,
  startTestServer,
  waitUntil,
  wsUrl,
  WsClient,
  type TestServer,
} from '../helpers/helpers.ts';
import { makeHostDir, teardownHosts, trackPty } from '../helpers/pty-host-fixture.ts';
import { hostPidOf, pidAlive, readHistory, shellPid, tickNumbers } from '../helpers/pty-host-backend-fixture.ts';
import { readRuntime, webDistCopy } from '../helpers/restart-fixture.ts';

const world = {
  first: undefined as TestServer | undefined,
  child: undefined as RuntimeInfo | undefined,
  flags: '',
  removeWeb: (): void => {},
  restart: { status: 0, body: undefined as unknown },
  ticker: '',
  bell: '',
  acked: '',
  quitter: '',
  tickerPid: 0,
  bellPid: 0,
  hostPid: 0,
  attachedClose: undefined as { code: number; reason: string } | undefined,
};

before(async () => {
  const web = webDistCopy();
  world.removeWeb = web.remove;
  world.flags = await makeTempDir('d9-survive-flags-');
  const dataDir = await makeHostDir('d9-survive-');
  const first = await startTestServer({ dataDir, ptyHost: 'socket', env: { AI_SM_WEB_DIST_DIR: web.served } });
  world.first = first;
  const bash = (script: string, title: string): Promise<SessionInfo> =>
    createSession(first, { cwd: '/tmp', command: 'bash', args: ['-c', `echo "pid $$"; ${script}`], title, cols: 80, rows: 24 });
  const ticker = await bash('i=0; while :; do echo "tick $i"; i=$((i+1)); sleep 0.05; done', 'ticker');
  const bell = await bash(`while [ ! -e ${world.flags}/ring ]; do sleep 0.05; done; printf 'rang\\a\\n'; sleep 300`, 'bell');
  const acked = await bash("printf 'early\\a\\n'; sleep 300", 'acked');
  const quitter = await bash("echo 'bye now'; exit 3", 'quitter');
  Object.assign(world, { ticker: ticker.id, bell: bell.id, acked: acked.id, quitter: quitter.id });
  for (const s of [ticker, bell, acked]) {
    const ws = await WsClient.connect(wsUrl(first, s.id));
    const pid = shellPid(await ws.waitForOutput('pid '));
    trackPty(pid);
    if (s.id === ticker.id) world.tickerPid = pid;
    if (s.id === bell.id) world.bellPid = pid;
    await ws.close();
  }
  world.hostPid = hostPidOf(dataDir);
  // One bell is looked at before the restart, the other rings unseen.
  await waitUntil(async () => (await listedBy(first, acked.id))?.attention === true || undefined, 'the early bell');
  assert.equal((await api(first, 'POST', `/api/sessions/${acked.id}/seen`)).status, 200);
  writeFileSync(join(world.flags, 'ring'), '');
  await waitUntil(async () => (await listedBy(first, bell.id))?.attention === true || undefined, 'the unseen bell');
  await waitUntil(async () => (await listedBy(first, quitter.id))?.status === 'exited' || undefined, 'the quitter to exit');
  // A window attached to the ticker while the restart runs: it is told 1012.
  const attached = await WsClient.connect(wsUrl(first, ticker.id));
  await attached.waitForOutput('tick 20');

  const res = await api(first, 'POST', '/api/restart');
  world.restart = { status: res.status, body: res.body };
  if (res.status !== 202) return;
  world.child = await waitUntil(() => {
    const rt = readRuntime(first.runtimeFile);
    return rt !== undefined && rt.pid !== first.child.pid ? rt : undefined;
  }, 'the new backend to take over', 60_000);
  await waitUntil(() => (attached.closed ? true : undefined), 'the attached window to be closed');
  world.attachedClose = attached.closeInfo;
  await first.exit;
});

after(async () => {
  const pid = world.child?.pid;
  if (pid !== undefined && pidAlive(pid)) {
    process.kill(pid, 'SIGTERM');
    await waitUntil(() => (pidAlive(pid) ? undefined : true), 'the new backend to stop').catch(() => process.kill(pid, 'SIGKILL'));
  }
  await world.first?.stop();
  await teardownHosts();
  world.removeWeb();
  if (world.flags !== '') await removeTempDir(world.flags);
});

/** The new backend, shaped for the request helpers (its own port and token). */
function second(): TestServer {
  const first = world.first;
  const child = world.child;
  if (first === undefined || child === undefined) throw new Error(`the restart did not hand off: ${JSON.stringify(world.restart)}`);
  return { ...first, runtime: child, port: child.port, token: child.token, baseUrl: `http://127.0.0.1:${child.port}` };
}

async function listedBy(server: TestServer, id: string): Promise<SessionInfo | undefined> {
  return ((await api(server, 'GET', '/api/sessions')).body as SessionInfo[]).find((s) => s.id === id);
}

test('Restart service answers 202 on the same port, and an attached window is told 1012 service restart', () => {
  assert.equal(world.restart.status, 202, JSON.stringify(world.restart.body));
  assert.equal((world.restart.body as RestartResponse).samePort, true);
  assert.deepEqual(world.attachedClose, { code: 1012, reason: 'service restart' });
});

test('the new backend lists the same session ids, the running ones still running', async () => {
  const sessions = (await api(second(), 'GET', '/api/sessions')).body as SessionInfo[];
  assert.deepEqual(
    sessions.map((s) => s.id).sort(),
    [world.ticker, world.bell, world.acked, world.quitter].sort(),
    'nothing was relaunched or dropped: the same sessions, under their own ids',
  );
  for (const id of [world.ticker, world.bell, world.acked]) {
    assert.equal(sessions.find((s) => s.id === id)?.status, 'running', id);
  }
  assert.equal(sessions.find((s) => s.id === world.ticker)?.title, 'ticker', 'the row is rebuilt from its blob');
});

test('a running session is the same process, held by the same pty-host', async () => {
  const log = await readServerLog(second());
  assert.match(log, new RegExp(`session ${world.ticker} adopted: pid ${world.tickerPid}\\b`));
  assert.equal(pidAlive(world.tickerPid), true, 'the process never stopped');
  assert.equal(hostPidOf(second().dataDir), world.hostPid, 'no second pty-host was started');
});

test('the output runs on through the handoff without a gap or a repeat', async () => {
  const ws = await WsClient.connect(wsUrl(second(), world.ticker));
  try {
    await ws.waitForMessage('replay');
    const last = tickNumbers(ws.output()).at(-1) ?? 0;
    await ws.waitForOutput(`tick ${last + 5}\r\n`);
    const ticks = tickNumbers(ws.output());
    assert.ok((ticks[0] ?? 99) <= 3, `the replay starts at the session's first ticks (${ticks[0]})`);
    for (let i = 1; i < ticks.length; i += 1) {
      assert.equal(ticks[i], (ticks[i - 1] as number) + 1, `tick ${ticks[i - 1]} is followed by the next one, not ${ticks[i]}`);
    }
  } finally {
    await ws.close();
  }
});

test('the old backend parked its scan offset at the detach: the new one re-scans only the handoff gap', async () => {
  // The ticker printed through the whole preflight (a real vite build, a
  // standby boot) before the detach; only what came after it is re-scanned.
  // Without the detach's flush the blob would still say the spawn's offset 0
  // and the new backend would re-scan — and re-raise — everything.
  const log = await readServerLog(second());
  const m = new RegExp(`session ${world.ticker} adopted: pid \\d+, (\\d+) byte\\(s\\) re-scanned`).exec(log);
  assert.ok(m !== null, 'the adopt line names the re-scanned bytes');
  const rescanned = Number(m[1]);
  const ws = await WsClient.connect(wsUrl(second(), world.ticker));
  try {
    const replay = await ws.waitForMessage('replay');
    assert.ok(
      rescanned < Buffer.byteLength(replay.data) / 2,
      `${rescanned} byte(s) re-scanned of the ${Buffer.byteLength(replay.data)} the session printed`,
    );
  } finally {
    await ws.close();
  }
});

test('a bell nobody looked at is still raised; one already looked at does not come back', async () => {
  const bell = await listedBy(second(), world.bell);
  assert.equal(bell?.attention, true, 'the unseen bell');
  assert.equal(typeof bell?.pendingSince, 'string', 'and the session is still pending');
  const acked = await listedBy(second(), world.acked);
  assert.equal(acked?.attention, false, 'the bell the user already looked at stays acknowledged');
  assert.equal(acked?.pendingSince, undefined);
});

test('a session that had exited before the restart is kept, with its code and its scrollback', async () => {
  const quitter = await listedBy(second(), world.quitter);
  assert.deepEqual([quitter?.status, quitter?.exitCode], ['exited', 3]);
  const ws = await WsClient.connect(wsUrl(second(), world.quitter));
  try {
    await ws.waitForOutput('bye now');
    assert.equal((await ws.waitForMessage('exit')).exitCode, 3);
  } finally {
    await ws.close();
  }
});

test('history stamps nothing: the running sessions stay live, the exited one keeps its exit', () => {
  const entries = readHistory(second().dataDir);
  for (const id of [world.ticker, world.bell, world.acked]) {
    const entry = entries.find((e: HistoryEntry) => e.sessionId === id);
    assert.ok(entry !== undefined, `history has ${id}`);
    assert.equal(entry.ended, null, `${id} is still live in history, not 'shutdown'`);
  }
  const quitter = entries.find((e: HistoryEntry) => e.sessionId === world.quitter);
  assert.deepEqual([quitter?.ended?.reason, quitter?.exitCode], ['exit', 3]);
});

test('the log tells the handoff: kept with the pty-host, detached, adopted', async () => {
  const log = await readServerLog(second());
  assert.match(log, /\[restart\] preflight: standby backend ready \(pid \d+\), booted and holding; port hint \d+; pty-host compatible/);
  assert.match(log, /\[restart\] the sessions stay with the pty-host for the new backend/);
  assert.match(log, /\[session\] detached for a restart: 3 running and 1 exited session\(s\) left with the pty-host, 0 spawn\(s\) in flight ended/);
  assert.ok(
    log.indexOf('detached for a restart') < log.indexOf(`session ${world.ticker} adopted`),
    'the old backend let go before the new one took over',
  );
  const handoff = log.slice(log.indexOf('restart requested by the ui'), log.indexOf('handoff complete'));
  assert.ok(!handoff.includes("end-all reason 'shutdown'"), 'the restart stamped nothing in history');
});

test('a restart is no unexpected stop: its exit record says `restart` and the new backend has nothing to tell (Q17)', async () => {
  const record = JSON.parse(readFileSync(join(second().dataDir, 'last-exit.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(record['why'], 'restart');
  assert.equal(record['signal'], undefined);
  assert.equal((record['sessions'] as unknown[]).length, 3, 'the three running sessions, by history id');
  const res = await api(second(), 'GET', '/api/previous-exit');
  assert.equal(res.status, 204, JSON.stringify(res.body));
});

test('a clean stop of the new backend still ends the adopted sessions and the pty-host (decision 25)', async () => {
  const pid = second().runtime.pid;
  process.kill(pid, 'SIGTERM');
  await waitUntil(() => (pidAlive(pid) ? undefined : true), 'the new backend to stop');
  await waitUntil(() => (pidAlive(world.bellPid) ? undefined : true), 'the adopted session to be ended');
  await waitUntil(() => (pidAlive(world.hostPid) ? undefined : true), 'the pty-host to exit');
  assert.equal(existsSync(second().runtimeFile), false, 'runtime.json removed by the clean stop');
  const entry = readHistory(second().dataDir).find((e: HistoryEntry) => e.sessionId === world.ticker);
  assert.equal(entry?.ended?.reason, 'shutdown');
});
