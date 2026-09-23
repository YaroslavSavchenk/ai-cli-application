/**
 * The process-group kill ladder's edges (2026-09-20) — T8-T16, added after the
 * mutation probe of 2026-09-20 found them unguarded. `server/sessions.ts`:
 * DELETE = SIGHUP, +2 s SIGTERM, +3 s SIGKILL on the PTY's process group;
 * shutdown = SIGHUP and SIGKILL at once. Why the ladder exists (a gemini
 * wrapper that ignores SIGHUP and SIGTERM, orphaned with GEMINI_API_KEY in its
 * environment): `tests/server/sessions-kill.test.ts`.
 *
 * Pinned here: the two answers a probe or a signal cannot be handed on purpose
 * — ESRCH and EPERM, injected into a spy on process.kill — every rung's own
 * "is the group still there?" check, the register destroyAll() sweeps and must
 * clear, and the unref'd timers, which take a real second process to observe
 * because they are a property of the process, not of a call.
 *
 * How: SessionManager in-process with the process.kill spy, and (T10) an
 * out-of-process ladder backend — both from
 * `tests/helpers/sessions-kill-fixture.ts`, with fake CLIs that ignore exactly
 * the signals the real one ignores. No HTTP server: nothing here is on the
 * DELETE route itself.
 *
 * NOT claimed here: the DELETE route and the T1-T7 rungs —
 * `tests/server/sessions-kill.test.ts`. T14 waits on the 2000 ms rung and is
 * CI-timing-sensitive (moved unchanged).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { waitUntil, sleep } from '../helpers/helpers.ts';
import {
  KILL_TERM_MS,
  KILL_KILL_MS,
  leftovers,
  root,
  workDir,
  trapBoth,
  plain,
  hupLeaderShort,
  hupLeaderTerm,
  ladderBackend,
  setupKillFixture,
  teardownKillFixture,
  pidFile,
  pidsFrom,
  waitAllGone,
  errno,
  harness,
} from '../helpers/sessions-kill-fixture.ts';

before(async () => {
  await setupKillFixture();
});

after(async () => {
  await teardownKillFixture();
});

// ---------------------------------------------------------------------------
// T8-T14: the answers the ladder cannot be handed on purpose (errno injection),
// the register it keeps, and the two timers it must never hold the process with
// ---------------------------------------------------------------------------

test('T8 a group signal that races the group away (ESRCH) is silent; any other errno is logged', async () => {
  const { manager, lines, kills, setFault, cleanup } = await harness();
  const groups: number[] = [];
  const pids: number[] = [];
  try {
    // ESRCH: the group left between the probe and the signal — the ordinary
    // race with onExit, which a warning line would turn into noise on every
    // tidy shutdown.
    const fileA = pidFile();
    const a = manager.create({
      cwd: workDir,
      command: trapBoth(),
      args: [fileA],
      cols: 80,
      rows: 24,
    });
    const pidsA = await pidsFrom(fileA);
    const leaderA = pidsA[0] as number;
    groups.push(leaderA);
    pids.push(...pidsA);
    setFault((pid, sig) =>
      pid === -leaderA && sig === 'SIGKILL' ? errno('ESRCH', 'kill ESRCH') : undefined,
    );
    manager.destroy(a.id, 'shutdown');
    assert.ok(
      kills.some(([pid, sig]) => pid === -leaderA && sig === 'SIGKILL'),
      `the shutdown SIGKILL must reach the spy; kills: ${JSON.stringify(kills)}`,
    );
    assert.equal(
      lines.some((l) => l.startsWith('warn ') && l.includes(a.id)),
      false,
      `ESRCH is the ordinary race, not a failure; log:\n${lines.join('\n')}`,
    );

    // EPERM (or any errno the ladder cannot explain away): the process may be
    // outliving us with an API key in its environment, so it must be in the log.
    const fileB = pidFile();
    const b = manager.create({
      cwd: workDir,
      command: trapBoth(),
      args: [fileB],
      cols: 80,
      rows: 24,
    });
    const pidsB = await pidsFrom(fileB);
    const leaderB = pidsB[0] as number;
    groups.push(leaderB);
    pids.push(...pidsB);
    setFault((pid, sig) =>
      pid === -leaderB && sig === 'SIGKILL' ? errno('EPERM', 'kill EPERM') : undefined,
    );
    manager.destroy(b.id, 'shutdown');
    assert.ok(
      lines.some(
        (l) =>
          l.startsWith('warn ') &&
          l.includes(`session ${b.id} SIGKILL to process group ${leaderB} failed`),
      ),
      `an unexplained errno must be logged; log:\n${lines.join('\n')}`,
    );
  } finally {
    // Neither SIGKILL reached the kernel, so both fake CLIs are still running.
    setFault(undefined);
    await cleanup();
    for (const leader of groups) {
      try {
        process.kill(-leader, 'SIGKILL');
      } catch {
        /* nothing left of it */
      }
    }
    if (pids.length > 0) await waitAllGone(pids, 'both trapping CLIs to be gone', 4_000);
  }
});

test('T9 a group probe answered EPERM counts as ALIVE: the ladder runs on, no warning', async () => {
  const { manager, lines, kills, setFault, cleanup } = await harness();
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
    const leader = pids[0] as number;
    // Every probe of THIS group is answered EPERM ("a group we may not signal"),
    // which must read as alive: the opposite reading leaks a process. The
    // group really dies on SIGHUP, so the rungs' own signals are recorded
    // without being sent — by then the pid number is free for anyone.
    setFault((pid, sig) =>
      pid !== -leader ? undefined : sig === 0 ? errno('EPERM', 'kill EPERM') : 'drop',
    );
    manager.destroy(info.id, 'user');
    await waitAllGone(pids, 'the ordinary CLI to die on SIGHUP', 4_000);

    await waitUntil(
      () => (kills.some(([pid, sig]) => pid === -leader && sig === 'SIGKILL') ? true : undefined),
      'the ladder to reach the SIGKILL rung although every probe says EPERM',
      KILL_TERM_MS + KILL_KILL_MS + 3_000,
      25,
    );
    assert.ok(
      kills.some(([pid, sig]) => pid === -leader && sig === 'SIGTERM'),
      `the SIGTERM rung must have run first; kills: ${JSON.stringify(kills)}`,
    );
    assert.equal(
      lines.some((l) => l.startsWith('warn ')),
      false,
      `EPERM is a foreseen answer, not a surprise; log:\n${lines.join('\n')}`,
    );
  } finally {
    await cleanup();
  }
});

/**
 * Run the out-of-process backend once and time how long it stays alive after
 * its DELETE returns. `holdMs` is a ref'd timer of its own, so the ladder is
 * the only thing that could hold it past that.
 */
async function ladderBackendExit(
  holdMs: number,
): Promise<{ pids: number[]; afterDestroyMs: number; code: number | null }> {
  const file = pidFile();
  const child = spawn(
    process.execPath,
    [ladderBackend(), workDir, hupLeaderTerm(), file, String(holdMs), join(root, 'child-history.json')],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  let err = '';
  let destroyedAt = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
    if (destroyedAt === 0 && out.includes('DESTROYED\n')) destroyedAt = Date.now();
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    err += chunk;
  });
  const guard = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (c) => resolve(c));
  });
  clearTimeout(guard);
  const match = /PIDS (\d+) (\d+)/.exec(out);
  assert.ok(match !== null, `the backend must report its pids; stdout:\n${out}\nstderr:\n${err}`);
  const pids = [Number(match[1]), Number(match[2])];
  for (const pid of pids) leftovers.add(pid);
  assert.notEqual(destroyedAt, 0, `the backend must report its DELETE; stdout:\n${out}`);
  return { pids, afterDestroyMs: Date.now() - destroyedAt, code };
}

test('T10 a pending ladder never holds the process open: both rung timers are unref’d', async () => {
  // Ready to leave while the SIGTERM rung (2000 ms) is pending.
  const early = await ladderBackendExit(0);
  assert.equal(early.code, 0, 'the backend must exit on its own');
  assert.ok(
    early.afterDestroyMs < KILL_TERM_MS - 800,
    `a pending SIGTERM rung may not hold the process: it exited ${early.afterDestroyMs}ms after the DELETE`,
  );

  // Ready to leave while the SIGKILL rung is pending: the backend holds a
  // ref'd 2500 ms timer of its own, which outlives the SIGTERM rung and
  // nothing else.
  const late = await ladderBackendExit(2_500);
  assert.equal(late.code, 0, 'the backend must exit on its own');
  assert.ok(
    late.afterDestroyMs < KILL_TERM_MS + 1_500,
    `a pending SIGKILL rung may not hold the process: it exited ${late.afterDestroyMs}ms after the DELETE`,
  );

  // The ladder died with each backend, so the fake CLI's worker child is this
  // test's to end — the only place in this file where that is not the defect.
  const stragglers = [...early.pids, ...late.pids];
  for (const pid of stragglers) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  await waitAllGone(stragglers, 'what the exited backends left behind', 4_000);
});

test('T11 a ladder that is over leaves the register: shutdown after it signals nothing', async () => {
  const { manager, lines, kills, setFault, cleanup } = await harness();
  try {
    // One session whose ladder is called off at its exit, one that runs every
    // rung to the SIGKILL.
    const quickFile = pidFile();
    const quick = manager.create({
      cwd: workDir,
      command: plain(),
      args: [quickFile],
      cols: 80,
      rows: 24,
    });
    const quickPids = await pidsFrom(quickFile, 1);
    const trapFile = pidFile();
    const stubborn = manager.create({
      cwd: workDir,
      command: trapBoth(),
      args: [trapFile],
      cols: 80,
      rows: 24,
    });
    const trapPids = await pidsFrom(trapFile, 2);

    manager.destroy(quick.id, 'user');
    manager.destroy(stubborn.id, 'user');
    await waitAllGone(quickPids, 'the ordinary CLI to die on SIGHUP', 4_000);
    await waitAllGone(trapPids, 'the trapping CLI to die at the SIGKILL rung', 12_000);

    // Both ladders are over. Every group probe now answers "alive", so a
    // ladder still on the register HAS to signal — and the signal is recorded
    // instead of sent, because both pid numbers are free for anyone by now.
    const killMark = kills.length;
    const lineMark = lines.length;
    setFault((pid, sig) =>
      pid >= 0 ? undefined : sig === 0 ? errno('EPERM', 'kill EPERM') : 'drop',
    );
    manager.destroyAll();

    assert.deepEqual(
      kills.slice(killMark).filter(([pid, sig]) => pid < 0 && sig !== 0),
      [],
      `a ladder that is over may not be finished off again; kills: ${JSON.stringify(kills.slice(killMark))}`,
    );
    assert.equal(
      lines.slice(lineMark).some((l) => l.includes('killed for shutdown')),
      false,
      `nothing is left to finish off; log:\n${lines.slice(lineMark).join('\n')}`,
    );
  } finally {
    await cleanup();
  }
});

test('T12 destroyAll clears the register: a second shutdown pass signals nothing', async () => {
  const { manager, lines, kills, setFault, cleanup } = await harness();
  try {
    const file = pidFile();
    const info = manager.create({
      cwd: workDir,
      command: hupLeaderTerm(),
      args: [file],
      cols: 80,
      rows: 24,
    });
    const pids = await pidsFrom(file, 2);

    // The leader goes on the SIGHUP and node-pty reports the exit, but its
    // worker child keeps the group alive, so the ladder stays on the register
    // and nothing but destroyAll() will take it off again.
    manager.destroy(info.id, 'user');
    // Wait for the exit REPORT, not for a clock: an exit that lands after the
    // sweep would take the entry off the register by itself and leave this
    // test with nothing to say about destroyAll()'s own bookkeeping.
    await waitUntil(
      () => (lines.some((l) => l.includes(`session ${info.id} exited with code`)) ? true : undefined),
      'node-pty to report the leader exit while its worker child holds the group',
      KILL_TERM_MS - 500,
      25,
    );
    manager.destroyAll();
    await waitAllGone(pids, 'the worker child to be gone right after destroyAll', 1_000);

    // A service stop calls this once, but a crash path or a second signal can
    // call it again — and the entries it already dealt with must be gone, or
    // the second pass signals pid NUMBERS that now belong to someone else.
    const killMark = kills.length;
    const lineMark = lines.length;
    setFault((pid, sig) =>
      pid >= 0 ? undefined : sig === 0 ? errno('EPERM', 'kill EPERM') : 'drop',
    );
    manager.destroyAll();

    assert.deepEqual(
      kills.slice(killMark).filter(([pid, sig]) => pid < 0 && sig !== 0),
      [],
      `the second pass has nothing to signal; kills: ${JSON.stringify(kills.slice(killMark))}`,
    );
    assert.equal(
      lines.slice(lineMark).some((l) => l.includes(info.id)),
      false,
      `the second pass has nothing to say about it; log:\n${lines.slice(lineMark).join('\n')}`,
    );
  } finally {
    await cleanup();
  }
});

test('T13 the ladder is called off AT the exit, not left to expire on a freed pid number', async () => {
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
    const leader = pids[0] as number;

    manager.destroy(info.id, 'user');
    await waitAllGone(pids, 'the ordinary CLI to die on SIGHUP', 4_000);
    await waitUntil(
      () => (lines.some((l) => l.includes(`session ${info.id} exited with code`)) ? true : undefined),
      'node-pty to report the exit',
      4_000,
      25,
    );
    const mark = kills.length;
    assert.ok(
      kills.slice(0, mark).some(([pid, sig]) => pid === -leader && sig === 0),
      `the exit must ask about the whole GROUP before calling the ladder off; kills: ${JSON.stringify(kills)}`,
    );

    // Past the first rung: a ladder left to expire would touch this group here,
    // and by then the pid number can belong to any process on the machine.
    await sleep(KILL_TERM_MS + 500);
    assert.deepEqual(
      kills.slice(mark).filter(([pid]) => pid === -leader),
      [],
      `nothing may touch the group of an exited session; kills: ${JSON.stringify(kills.slice(mark))}`,
    );
  } finally {
    await cleanup();
  }
});

test('T14 a group that empties before the first rung is checked, found gone, and left alone', async () => {
  const { manager, lines, kills, cleanup } = await harness();
  try {
    const file = pidFile();
    const info = manager.create({
      cwd: workDir,
      command: hupLeaderShort(),
      args: [file],
      cols: 80,
      rows: 24,
    });
    const pids = await pidsFrom(file, 2);
    const leader = pids[0] as number;

    // The leader honours SIGHUP; its worker child does not, so the group is
    // still alive when node-pty reports the exit and the ladder is kept. The
    // child then leaves on its own, well before the 2000 ms rung.
    manager.destroy(info.id, 'user');
    await waitUntil(
      () => (lines.some((l) => l.includes(`session ${info.id} exited with code`)) ? true : undefined),
      'node-pty to report the leader exit',
      KILL_TERM_MS - 500,
      25,
    );
    const mark = kills.length;
    await waitAllGone(pids, 'the whole group to leave on its own before the first rung', 2_000);

    // The rung must still RUN and ask (that is what keeps a group that outlived
    // its leader honest) — and, finding nothing, signal nothing.
    await waitUntil(
      () =>
        kills.slice(mark).some(([pid, sig]) => pid === -leader && sig === 0) ? true : undefined,
      'the SIGTERM rung to probe the group it was armed for',
      KILL_TERM_MS + 1_500,
      25,
    );
    await sleep(500);
    assert.deepEqual(
      kills.slice(mark).filter(([pid, sig]) => pid === -leader && sig !== 0),
      [],
      `an empty group may never be signalled — the pid number is free; kills: ${JSON.stringify(kills.slice(mark))}`,
    );
    assert.equal(
      lines.some((l) => l.includes(`${info.id} still running`)),
      false,
      `no rung line for a group that left in time; log:\n${lines.join('\n')}`,
    );
  } finally {
    await cleanup();
  }
});
test('T15 destroy(id, "shutdown") itself kills the group at once — it never takes the DELETE ladder', async () => {
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

    // destroyAll() is one caller of this (T4); the `by` argument is the
    // contract, and a shutdown that merely ARMED the ladder would leave the
    // process — API key and all — to outlive a backend that exits right after.
    const at = Date.now();
    assert.equal(manager.destroy(info.id, 'shutdown'), true);
    await waitAllGone(pids, 'leader and child to be gone right after the shutdown kill', 1_000);
    assert.ok(Date.now() - at < KILL_TERM_MS, 'the shutdown kill waits for no rung');
    assert.ok(
      kills.some(([pid, sig]) => pid === -leader && sig === 'SIGKILL'),
      `SIGKILL must go to the GROUP (-${String(leader)}); kills: ${JSON.stringify(kills)}`,
    );
    await sleep(KILL_TERM_MS + 500);
    assert.equal(
      lines.some((l) => l.includes('still running')),
      false,
      `the timed ladder belongs to DELETE, not to shutdown; log:\n${lines.join('\n')}`,
    );
  } finally {
    await cleanup();
  }
});

test('T16 a group that empties at the SIGTERM rung is checked again, and never SIGKILLed', async () => {
  const { manager, lines, kills, cleanup } = await harness();
  try {
    const file = pidFile();
    const info = manager.create({
      cwd: workDir,
      command: hupLeaderTerm(),
      args: [file],
      cols: 80,
      rows: 24,
    });
    const pids = await pidsFrom(file, 2);
    const leader = pids[0] as number;

    // Leader gone on SIGHUP, worker child deaf to it: the ladder is kept, and
    // the SIGTERM rung is what ends the group — so node-pty never reports an
    // exit again and only the last rung's own check can stop it.
    manager.destroy(info.id, 'user');
    await waitUntil(
      () => (lines.some((l) => l.includes(`session ${info.id} exited with code`)) ? true : undefined),
      'node-pty to report the leader exit before the first rung is due',
      KILL_TERM_MS - 500,
      25,
    );
    await waitAllGone(pids, 'the worker child to die at the SIGTERM rung', KILL_TERM_MS + 2_000);
    assert.ok(
      kills.some(([pid, sig]) => pid === -leader && sig === 'SIGTERM'),
      `the SIGTERM rung must have signalled the group; kills: ${JSON.stringify(kills)}`,
    );
    const mark = kills.length;

    // The SIGKILL rung now comes due on a pid number that is free again.
    await waitUntil(
      () =>
        kills.slice(mark).some(([pid, sig]) => pid === -leader && sig === 0) ? true : undefined,
      'the SIGKILL rung to probe the group before signalling it',
      KILL_KILL_MS + 1_500,
      25,
    );
    await sleep(500);
    assert.deepEqual(
      kills.slice(mark).filter(([pid, sig]) => pid === -leader && sig !== 0),
      [],
      `an empty group may never be SIGKILLed; kills: ${JSON.stringify(kills.slice(mark))}`,
    );
    assert.equal(
      lines.some((l) => l.includes(`${info.id} still running ${KILL_KILL_MS}ms after SIGTERM`)),
      false,
      `no SIGKILL rung line for a group that is already gone; log:\n${lines.join('\n')}`,
    );
  } finally {
    await cleanup();
  }
});
