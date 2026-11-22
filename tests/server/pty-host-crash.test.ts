/**
 * Crash survival through the pty-host — Nocturne D9 P3
 * (`.claude/plans/nocturne/PLAN-D9.md` § Phases P3): a backend SIGKILLed
 * mid-output, a new backend booted on the same data dir, and the sessions the
 * pty-host kept are adopted — same id, same process, continuous output, a
 * bell printed while no backend ran still raises attention, a session that
 * exited meanwhile is exited with its code, the status line's shared branch
 * cache and an adopted session's own status-line files are kept (others
 * wiped) — and a clean stop still ends them.
 *
 * How: two real backend children (`startTestServer`, `ptyHost: 'socket'`) on
 * one 0700 temp data dir, the real pty-host the first one starts, and real
 * bash PTYs whose `$$` they print. One scenario, set up once in `before`;
 * each test asserts one claim about the second backend. Every pty-host and PTY
 * group is ended in `after` (tests/helpers/pty-host-fixture.ts).
 *
 * Why it matters: without adoption a backend crash ends every terminal; with
 * a wrong one, a session comes back with holes in its scrollback, a bell the
 * user never sees, or a history entry stamped `crash` for a session that runs.
 *
 * NOT claimed: restart and update (P4: `restart-survive.test.ts`), the
 * browser's reconnect, Windows.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryEntry, RuntimeStatusResponse, SessionInfo } from '../../shared/protocol.ts';
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
import { hostLog, makeHostDir, teardownHosts, trackPty } from '../helpers/pty-host-fixture.ts';
import { hostPidOf, pidAlive, readHistory, shellPid, tickNumbers } from '../helpers/pty-host-backend-fixture.ts';

/** The two per-session status-line directories of a data dir (server/config.ts). */
const STATUSLINE_DIRS = ['session-settings', 'statusline-snapshots'];
/** A session id no pty-host holds: its leftover files must go at boot. */
const NOT_HELD = '9e8d7c6b-5a49-4837-a261-504f3e2d1c0b';

const world = {
  dataDir: '',
  flags: '',
  second: undefined as TestServer | undefined,
  ticker: '',
  bell: '',
  quitter: '',
  tickerPid: 0,
  hostPid: 0,
  firstBuild: '',
};

before(async () => {
  world.dataDir = await makeHostDir('d9-crash-');
  world.flags = await makeTempDir('d9-flags-');
  const first = await startTestServer({ dataDir: world.dataDir, ptyHost: 'socket' });
  try {
    const ticker = await createSession(first, {
      cwd: '/tmp',
      command: 'bash',
      args: ['-c', 'echo "pid $$"; i=0; while :; do echo "tick $i"; i=$((i+1)); sleep 0.2; done'],
      cols: 80,
      rows: 24,
    });
    const bell = await createSession(first, {
      cwd: '/tmp',
      command: 'bash',
      args: ['-c', `echo "pid $$"; while [ ! -e ${world.flags}/ring ]; do sleep 0.05; done; printf 'rang\\a\\n'; touch ${world.flags}/rang; sleep 300`],
      cols: 80,
      rows: 24,
    });
    const quitter = await createSession(first, {
      cwd: '/tmp',
      command: 'bash',
      args: ['-c', `echo "pid $$"; while [ ! -e ${world.flags}/quit ]; do sleep 0.05; done; exit 7`],
      cols: 80,
      rows: 24,
    });
    world.ticker = ticker.id;
    world.bell = bell.id;
    world.quitter = quitter.id;
    const pids: number[] = [];
    for (const id of [ticker.id, bell.id, quitter.id]) {
      const ws = await WsClient.connect(wsUrl(first, id));
      const pid = shellPid(await ws.waitForOutput('pid '));
      trackPty(pid);
      pids.push(pid);
      if (id === ticker.id) await ws.waitForOutput('tick 3');
      await ws.close();
    }
    world.tickerPid = pids[0] as number;
    const runtime = (await api(first, 'GET', '/api/runtime')).body as RuntimeStatusResponse;
    world.firstBuild = runtime.ptyHost?.build ?? '';
    world.hostPid = hostPidOf(world.dataDir);
  } finally {
    // The crash: no shutdown, no history stamp, no goodbye to the pty-host.
    first.child.kill('SIGKILL');
    await first.exit;
  }
  // While no backend runs: a bell, and a session that exits with 7.
  writeFileSync(join(world.flags, 'ring'), '');
  writeFileSync(join(world.flags, 'quit'), '');
  await waitUntil(() => (existsSync(join(world.flags, 'rang')) ? true : undefined), 'the bell to be printed');
  await waitUntil(
    () => (hostLog(world.dataDir).includes(`${world.quitter} exited (code 7`) ? true : undefined),
    'the pty-host to record the exit of the session that quit',
  );
  // The status line's branch cache (one file for every session): a boot that
  // adopts sessions keeps it (§ Defaults, P3).
  writeFileSync(join(world.dataDir, 'statusline-cache.json'), '{}\n');
  // The per-session status-line files (settings and last snapshot): an
  // adopted session keeps its own, one no pty-host holds loses its.
  for (const dir of STATUSLINE_DIRS) {
    writeFileSync(join(world.dataDir, dir, `${world.ticker}.json`), '{}\n');
    writeFileSync(join(world.dataDir, dir, `${NOT_HELD}.json`), '{}\n');
  }
  world.second = await startTestServer({ dataDir: world.dataDir, ptyHost: 'socket' });
});

after(async () => {
  await world.second?.stop();
  await teardownHosts();
  if (world.flags !== '') await removeTempDir(world.flags);
});

function second(): TestServer {
  if (world.second === undefined) throw new Error('the second backend did not start');
  return world.second;
}

async function listed(): Promise<SessionInfo[]> {
  return (await api(second(), 'GET', '/api/sessions')).body as SessionInfo[];
}

test('the new backend lists the same session ids, the running ones still running', async () => {
  const sessions = await listed();
  assert.deepEqual(
    sessions.map((s) => s.id).sort(),
    [world.ticker, world.bell, world.quitter].sort(),
    'every session the pty-host kept is adopted, under its own id',
  );
  assert.equal(sessions.find((s) => s.id === world.ticker)?.status, 'running');
});

test('an adopted session is the same process: the pid it printed is the pid the backend adopted', async () => {
  const log = await readServerLog(second());
  assert.match(log, new RegExp(`session ${world.ticker} adopted: pid ${world.tickerPid}\\b`));
  assert.equal(pidAlive(world.tickerPid), true, 'and that process still runs');
  const runtime = (await api(second(), 'GET', '/api/runtime')).body as RuntimeStatusResponse;
  assert.deepEqual(runtime.ptyHost, { build: world.firstBuild, proto: 1 }, 'GET /api/runtime names the same pty-host');
  assert.equal(hostPidOf(world.dataDir), world.hostPid, 'no second pty-host was started');
});

test('the replay after the crash runs on without a gap or a repeat, into the live ticks', async () => {
  const ws = await WsClient.connect(wsUrl(second(), world.ticker));
  try {
    await ws.waitForMessage('replay');
    const first = tickNumbers(ws.output());
    const last = first.at(-1) ?? 0;
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

test('a bell printed while no backend ran raises attention on the adopted session', async () => {
  const bell = (await listed()).find((s) => s.id === world.bell);
  assert.equal(bell?.status, 'running');
  assert.equal(bell?.attention, true, 'the gap re-scan found the BEL');
  assert.equal(typeof bell?.pendingSince, 'string', 'and the session is pending');
  assert.equal((await listed()).find((s) => s.id === world.ticker)?.attention, false, 'the ticker printed none');
});

test('a session that exited while no backend ran is exited with its code, and history says exit', async () => {
  const quitter = (await listed()).find((s) => s.id === world.quitter);
  assert.equal(quitter?.status, 'exited');
  assert.equal(quitter?.exitCode, 7);
  const entry = readHistory(world.dataDir).find((e: HistoryEntry) => e.sessionId === world.quitter);
  assert.deepEqual([entry?.ended?.reason, entry?.exitCode], ['exit', 7]);
});

test('the running sessions stay live in history: the boot stamped no crash for them', () => {
  for (const id of [world.ticker, world.bell]) {
    const entry = readHistory(world.dataDir).find((e: HistoryEntry) => e.sessionId === id);
    assert.ok(entry !== undefined, `history has ${id}`);
    assert.equal(entry.ended, null, `${id} is still live in history`);
  }
});

test("a boot that adopted sessions keeps the status line's branch cache, which every session shares", () => {
  assert.equal(existsSync(join(world.dataDir, 'statusline-cache.json')), true);
});

test("a boot that adopted sessions keeps an adopted session's own status-line files and wipes the rest", () => {
  for (const dir of STATUSLINE_DIRS) {
    assert.equal(existsSync(join(world.dataDir, dir, `${world.ticker}.json`)), true, `${dir}: the adopted session's file stays`);
    assert.equal(existsSync(join(world.dataDir, dir, `${NOT_HELD}.json`)), false, `${dir}: a file no held session owns goes`);
  }
});

test('a clean stop of the new backend still ends the adopted sessions and the pty-host (decision 25)', async () => {
  await second().stop();
  await waitUntil(() => (pidAlive(world.tickerPid) ? undefined : true), 'the adopted session to be ended');
  await waitUntil(() => (pidAlive(world.hostPid) ? undefined : true), 'the pty-host to exit');
  const entry = readHistory(world.dataDir).find((e: HistoryEntry) => e.sessionId === world.ticker);
  assert.equal(entry?.ended?.reason, 'shutdown');
});
