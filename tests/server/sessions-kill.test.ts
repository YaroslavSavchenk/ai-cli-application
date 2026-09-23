/**
 * Ending a session must really end it — the whole process GROUP (2026-09-20).
 *
 * Measured in the verify-terminal pass: `DELETE /api/sessions/:id` answered
 * `{"ok":true}` while Gemini CLI 0.60 kept running. Its `node .../bin/gemini`
 * wrapper relaunches itself as a `node --max-old-space-size=7996 ...` CHILD and
 * ignores SIGHUP *and* SIGTERM, so node-pty's default `pty.kill()` (SIGHUP) left
 * both alive — 3/3 gemini sessions orphaned, surviving the backend's own exit.
 * What makes that a security matter and not just untidiness: an orphan keeps
 * GEMINI_API_KEY in its environment, so "Remove key" in Settings does not take
 * the key away from the session the user believes they ended.
 *
 * The fix signals the PTY's process group (node-pty's child calls setsid(), so
 * `pty.pid` leads it): DELETE = SIGHUP, +2 s SIGTERM, +3 s SIGKILL; shutdown =
 * SIGHUP and SIGKILL at once. These tests prove all three rungs against fake
 * CLIs that ignore exactly the signals the real one ignores, and prove the
 * ordinary case is byte-identical to before. The fake CLIs, pid bookkeeping and
 * the process.kill spy live in `tests/helpers/sessions-kill-fixture.ts`.
 *
 * T1-T3 go through the real HTTP server (the defect's own path, DELETE). T4-T7
 * drive SessionManager in-process, because the shutdown path is not reachable
 * over HTTP and because the pid-reuse guard has to be observed as "no signal
 * was sent", which only a spy on process.kill can state directly.
 *
 * NOT claimed here: T8-T16 — injected ESRCH/EPERM, each rung's own "is the
 * group still there?" check, the register destroyAll() clears and the unref'd
 * rung timers — `tests/server/sessions-kill-ladder.test.ts`. A real gemini CLI
 * on Windows: `.claude/skills/verify-terminal/SKILL.md`.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, createSession, readServerLog, startTestServer, waitUntil, type TestServer, sleep } from '../helpers/helpers.ts';
import {
  KILL_TERM_MS,
  KILL_KILL_MS,
  workDir,
  trapBoth,
  trapHup,
  plain,
  hupLeader,
  setupKillFixture,
  teardownKillFixture,
  pidFile,
  pidsFrom,
  alive,
  waitAllGone,
  harness,
} from '../helpers/sessions-kill-fixture.ts';

let server: TestServer;

before(async () => {
  await setupKillFixture();
  server = await startTestServer();
});

after(async () => {
  if (server !== undefined) await server.stop();
  await teardownKillFixture();
});

// ---------------------------------------------------------------------------
// T1-T3: DELETE /api/sessions/:id, through the real server
// ---------------------------------------------------------------------------

test('T1 DELETE ends a CLI that ignores SIGHUP and SIGTERM, and its child, via SIGKILL on the group', async () => {
  const file = pidFile();
  const info = await createSession(server, {
    command: trapBoth(),
    args: [file],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  const pids = await pidsFrom(file);
  assert.equal(pids.length, 2, 'the fake CLI must report leader and child');

  const del = await api(server, 'DELETE', `/api/sessions/${info.id}`);
  assert.equal(del.status, 200);
  assert.deepEqual(del.body, { ok: true });

  // 2 s to SIGTERM + 3 s to SIGKILL + slack; the pre-fix code left both alive
  // forever, so this is the assertion that pins the defect.
  await waitAllGone(pids, 'the trapping CLI and its child to be gone', 12_000);

  const log = await readServerLog(server);
  assert.ok(
    log.includes(
      `${info.id} still running 2000ms after SIGHUP; sending SIGTERM to its process group`,
    ),
    `SIGTERM rung must be logged; log:\n${log}`,
  );
  assert.ok(
    log.includes(
      `${info.id} still running 3000ms after SIGTERM; sending SIGKILL to its process group`,
    ),
    `SIGKILL rung must be logged; log:\n${log}`,
  );
});

test('T2 a CLI that ignores only SIGHUP dies at the SIGTERM rung — no SIGKILL', async () => {
  const file = pidFile();
  const info = await createSession(server, {
    command: trapHup(),
    args: [file],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  const pids = await pidsFrom(file);
  const deletedAt = Date.now();
  assert.equal((await api(server, 'DELETE', `/api/sessions/${info.id}`)).status, 200);

  await waitAllGone(pids, 'the SIGHUP-trapping CLI to die on SIGTERM', 9_000);

  // Wait past the moment the SIGKILL rung WOULD have fired (2000+3000 ms),
  // otherwise "no SIGKILL line" would only mean "not yet".
  await sleep(Math.max(0, deletedAt + 6_000 - Date.now()));
  const log = await readServerLog(server);
  assert.ok(
    log.includes(
      `${info.id} still running 2000ms after SIGHUP; sending SIGTERM to its process group`,
    ),
    `SIGTERM rung must be logged; log:\n${log}`,
  );
  assert.equal(
    log.includes(`${info.id} still running 3000ms after SIGTERM`),
    false,
    'a process that honours SIGTERM must never be SIGKILLed',
  );
});

test('T3 an ordinary CLI still dies on the plain SIGHUP: no escalation line at all', async () => {
  const file = pidFile();
  const info = await createSession(server, {
    command: plain(),
    args: [file],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  const pids = await pidsFrom(file, 1);
  const deletedAt = Date.now();
  assert.equal((await api(server, 'DELETE', `/api/sessions/${info.id}`)).status, 200);

  await waitAllGone(pids, 'the ordinary CLI to die on SIGHUP', 4_000);
  assert.ok(
    Date.now() - deletedAt < KILL_TERM_MS,
    'SIGHUP alone must still end an ordinary CLI, well before the first rung',
  );

  await sleep(Math.max(0, deletedAt + 6_000 - Date.now()));
  const log = await readServerLog(server);
  assert.equal(
    log.includes(`${info.id} still running`),
    false,
    'the unchanged path must log exactly what it logged before the fix',
  );
  assert.equal(log.includes(`${info.id} process group`), false, 'no group signal, no warning');
  assert.ok(
    log.includes(`session ${info.id} deleted`),
    'the pre-existing delete line is unchanged',
  );
});

// ---------------------------------------------------------------------------
// T4-T5: in-process, with a spy on process.kill
// ---------------------------------------------------------------------------

test('T4 shutdown kills the group immediately: SIGHUP then SIGKILL, no waiting', async () => {
  const { manager, lines, kills, cleanup } = await harness();
  try {
    const file = pidFile();
    const info = manager.create({
      cwd: workDir,
      command: trapBoth(),
      args: [file],
      cols: 80,
      rows: 24,
    });
    const pids = await pidsFrom(file);
    const [leader] = pids;

    const at = Date.now();
    manager.destroyAll();
    // No grace at shutdown: 1 s is already an order of magnitude more than the
    // kernel needs, and far below the 2 s first rung of the DELETE ladder.
    await waitAllGone(pids, 'leader and child to be gone right after destroyAll', 1_000);
    assert.ok(Date.now() - at < KILL_TERM_MS, 'shutdown must not wait for any rung');

    assert.ok(
      kills.some(([pid, sig]) => pid === -(leader as number) && sig === 'SIGKILL'),
      `SIGKILL must go to the GROUP (-${String(leader)}); kills: ${JSON.stringify(kills)}`,
    );
    assert.ok(
      lines.some((l) =>
        l.includes(
          `${info.id} killed for shutdown with SIGHUP; sending SIGKILL to its process group immediately`,
        ),
      ),
      `shutdown kill line missing; log:\n${lines.join('\n')}`,
    );
    assert.equal(
      lines.some((l) => l.includes('still running')),
      false,
      'the timed ladder belongs to DELETE, not to shutdown',
    );
  } finally {
    await cleanup();
  }
});

test('T5 pid-reuse guard: a session that exits before the first rung is never signalled again', async () => {
  const { manager, lines, kills, cleanup } = await harness();
  try {
    const file = pidFile();
    const info = manager.create({
      cwd: workDir,
      command: plain(),
      args: [file],
      cols: 80,
      rows: 24,
    });
    const pids = await pidsFrom(file, 1);

    manager.destroy(info.id, 'user');
    await waitAllGone(pids, 'the ordinary CLI to die on SIGHUP', 4_000);
    // Past BOTH rungs: the timers have run and found the group already gone.
    await sleep(KILL_TERM_MS + KILL_KILL_MS + 1000);

    assert.equal(
      // Signal 0 is the liveness PROBE, not a signal: only real signals count.
      kills.filter(([pid, sig]) => pid < 0 && sig !== 0).length,
      0,
      `no group signal may be sent once the group is gone; kills: ${JSON.stringify(kills)}`,
    );
    assert.equal(
      lines.some((l) => l.includes('still running')),
      false,
      'no escalation line for a session that exited in time',
    );
    assert.equal(
      lines.some((l) => l.startsWith('warn ') && l.includes(info.id)),
      false,
      `no warning either; log:\n${lines.join('\n')}`,
    );
    assert.ok(
      lines.some((l) => l.includes(`session ${info.id} exited with code`)),
      'the ordinary exit line is unchanged',
    );
  } finally {
    await cleanup();
  }
});

test('T6 the ladder follows the GROUP: a leader that honours SIGHUP does not save its trapping child', async () => {
  const { manager, lines, kills, cleanup } = await harness();
  try {
    const file = pidFile();
    const info = manager.create({
      cwd: workDir,
      command: hupLeader(),
      args: [file],
      cols: 80,
      rows: 24,
    });
    const pids = await pidsFrom(file, 2);

    manager.destroy(info.id, 'user');
    // The LEADER goes on the plain SIGHUP, so node-pty reports the session as
    // exited within milliseconds. A ladder cancelled by that report would leave
    // the child — with the stored API key in its environment — running forever.
    await waitUntil(
      () => (pids.filter((p) => !alive(p)).length === 1 ? true : undefined),
      'the leader to die on SIGHUP while its child survives',
      4_000,
      25,
    );
    // node-pty reports that exit a few ms later, on its own event loop turn —
    // still well before the first rung is due, which is the whole premise.
    await waitUntil(
      () =>
        lines.some((l) => l.includes(`session ${info.id} exited with code`)) ? true : undefined,
      'node-pty to report the leader exit before the first rung is due',
      KILL_TERM_MS - 500,
      25,
    );

    await waitAllGone(pids, 'the trapping child to be gone too', 9_000);

    const leader = pids[0] as number;
    assert.ok(
      lines.some((l) =>
        l.includes(
          `${info.id} still running ${KILL_TERM_MS}ms after SIGHUP; sending SIGTERM to its process group`,
        ),
      ),
      `SIGTERM rung must fire for a group that outlived its leader; log:\n${lines.join('\n')}`,
    );
    assert.ok(
      lines.some((l) =>
        l.includes(
          `${info.id} still running ${KILL_KILL_MS}ms after SIGTERM; sending SIGKILL to its process group`,
        ),
      ),
      `SIGKILL rung must fire; log:\n${lines.join('\n')}`,
    );
    assert.ok(
      kills.some(([pid, sig]) => pid === -leader && sig === 'SIGKILL'),
      `SIGKILL must address the group (-${String(leader)}); kills: ${JSON.stringify(kills)}`,
    );
  } finally {
    await cleanup();
  }
});

test('T7 a DELETE still escalating when the server shuts down is finished off, not dropped', async () => {
  const { manager, lines, kills, cleanup } = await harness();
  try {
    const file = pidFile();
    const info = manager.create({
      cwd: workDir,
      command: trapBoth(),
      args: [file],
      cols: 80,
      rows: 24,
    });
    const pids = await pidsFrom(file, 2);
    const leader = pids[0] as number;

    // The user ends the session and, well inside the 2 s first rung, restarts
    // the service (or the launcher stops the backend). destroyAll() no longer
    // knows this session — the ladder does.
    manager.destroy(info.id, 'user');
    await sleep(100);
    manager.destroyAll();

    await waitAllGone(pids, 'leader and child to be gone right after destroyAll', 1_000);
    assert.ok(
      kills.some(([pid, sig]) => pid === -leader && sig === 'SIGKILL'),
      `the in-flight ladder must be finished with SIGKILL on the group; kills: ${JSON.stringify(kills)}`,
    );
    assert.ok(
      lines.some((l) =>
        l.includes(
          `${info.id} killed for shutdown with SIGHUP; sending SIGKILL to its process group immediately`,
        ),
      ),
      `shutdown kill line missing for the escalating session; log:\n${lines.join('\n')}`,
    );
  } finally {
    await cleanup();
  }
});
