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
 * ordinary case is byte-identical to before.
 *
 * T1-T3 go through the real HTTP server (the defect's own path, DELETE). T4/T5
 * drive SessionManager in-process, because the shutdown path is not reachable
 * over HTTP and because the pid-reuse guard has to be observed as "no signal
 * was sent", which only a spy on process.kill can state directly.
 *
 * T8-T16 pin the rest of the seam (added after the mutation probe of
 * 2026-09-20, which found them unguarded): the two answers a probe or a signal
 * cannot be handed on purpose — ESRCH and EPERM, injected into the same spy —
 * every rung's own "is the group still there?" check, the register destroyAll()
 * sweeps and must clear, and the unref'd timers, which take a real second
 * process to observe because they are a property of the process, not of a call.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionHistory } from '../../server/history.ts';
import { SessionManager } from '../../server/sessions.ts';
import type { LogLevel } from '../../server/config.ts';
import {
  api,
  createSession,
  readServerLog,
  startTestServer,
  waitUntil,
  type TestServer,
  sleep,
  makeTempDir,
  removeTempDir,
} from '../helpers/helpers.ts';

/**
 * Ignores SIGHUP AND SIGTERM and owns a child in the same process group —
 * the gemini shape. `trap ''` is inherited by the child, so neither of them
 * can be ended by anything below SIGKILL. Writes "<leader pid> <child pid>".
 */
const TRAP_HUP_TERM = `#!/bin/sh
trap '' HUP TERM
sleep 300 &
child=$!
printf '%s %s\\n' "$$" "$child" > "$1"
printf 'READY\\n'
wait
`;

/** Ignores SIGHUP only: the SIGTERM rung must be enough for this one. */
const TRAP_HUP = `#!/bin/sh
trap '' HUP
sleep 300 &
child=$!
printf '%s %s\\n' "$$" "$child" > "$1"
printf 'READY\\n'
wait
`;

/**
 * The leader honours SIGHUP; its worker child, in the SAME process group,
 * ignores HUP and TERM. `pty.kill()` alone ends the leader and node-pty reports
 * the exit, which is exactly when a ladder keyed on "the session exited" would
 * stop — leaving the child (and the API key in its environment) running.
 */
const HUP_LEADER_TRAP_CHILD = `#!/bin/sh
sh -c 'trap "" HUP TERM; printf "%s\\n" "$$" >> "$1"; sleep 300' sh "$1" &
printf '%s\\n' "$$" >> "$1"
printf 'READY\\n'
wait
`;

/**
 * A leader that honours SIGHUP and a worker child that ignores it but is gone
 * shortly after the leader — so the process GROUP is alive when node-pty
 * reports the exit (the ladder is kept) and empty long before the first rung
 * is due (the rung must find nothing and leave the freed pid number alone).
 * The child times itself on its parent's death, not on the clock, so both
 * halves of that window hold however slow the machine is.
 */
const HUP_LEADER_SHORT_CHILD = `#!/bin/sh
sh -c 'trap "" HUP; printf "%s\\n" "$$" >> "$1"; p=$PPID; while kill -0 $p 2>/dev/null; do sleep 0.05; done; sleep 0.6' sh "$1" &
printf '%s\\n' "$$" >> "$1"
printf 'READY\\n'
wait
`;

/**
 * A leader that honours SIGHUP with a worker child that ignores SIGHUP but not
 * SIGTERM: the group outlives the exit (the ladder is kept), survives to the
 * SIGTERM rung, and is empty by the time the SIGKILL rung comes due.
 */
const HUP_LEADER_TERM_CHILD = `#!/bin/sh
sh -c 'trap "" HUP; printf "%s\\n" "$$" >> "$1"; sleep 300' sh "$1" &
printf '%s\\n' "$$" >> "$1"
printf 'READY\\n'
wait
`;

/**
 * A minimal backend in its OWN process: one session, one DELETE, then nothing
 * — the event loop drains and the process exits, unless something still holds
 * it. That "unless" is the whole point: both ladder timers are unref'd, so a
 * backend whose work is done may not be held open for up to 5 s by an
 * escalation nobody is waiting for. Only a real process can state that.
 *
 * argv: cwd, command, pid file, hold ms, history file. It prints `PIDS a b`,
 * then `DESTROYED` the moment the DELETE returns; the parent times the gap
 * between that line and the process's exit. `hold` is a ref'd timer of its own
 * — with 0 the process is ready to leave while the SIGTERM rung is pending,
 * with 2500 while the SIGKILL rung is (2000 < 2500 < 2000+3000).
 */
const LADDER_EXIT_BACKEND = `
import { readFile } from 'node:fs/promises';
import { SessionHistory } from '${new URL('../../server/history.ts', import.meta.url).href}';
import { SessionManager } from '${new URL('../../server/sessions.ts', import.meta.url).href}';

const [cwd, command, file, holdRaw, histPath] = process.argv.slice(2);
const noop = () => {};
const manager = new SessionManager(noop, new SessionHistory(histPath, noop));
const info = manager.create({ cwd, command, args: [file], cols: 80, rows: 24 });

let pids = [];
const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  try {
    const parsed = (await readFile(file, 'utf8'))
      .trim()
      .split('\\n')
      .flatMap((line) => line.trim().split(' '))
      .map(Number);
    if (parsed.length === 2 && parsed.every((n) => Number.isInteger(n) && n > 1)) {
      pids = parsed;
      break;
    }
  } catch {
    /* not written yet */
  }
  await new Promise((r) => setTimeout(r, 25));
}
if (pids.length !== 2) {
  process.stdout.write('NOPIDS\\n');
  process.exit(3);
}
process.stdout.write('PIDS ' + pids.join(' ') + '\\n');
manager.destroy(info.id, 'user');
process.stdout.write('DESTROYED\\n');
const hold = Number(holdRaw);
if (hold > 0) setTimeout(() => {}, hold);
`;

/** An ordinary CLI: SIGHUP ends it, so no escalation may ever be reached. */
const PLAIN = `#!/bin/sh
printf '%s\\n' "$$" > "$1"
printf 'READY\\n'
exec sleep 300
`;

/** Mirrors server/sessions.ts KILL_TERM_AFTER_MS / KILL_KILL_AFTER_MS. */
const KILL_TERM_MS = 2000;
const KILL_KILL_MS = 3000;

/** Group leaders this file started; emptied as each test proves them dead. */
const leftovers = new Set<number>();

let root: string;
let binDir: string;
let workDir: string;
let pidDir: string;
let server: TestServer;
let nextPidFile = 0;

const trapBoth = (): string => join(binDir, 'trap-hup-term');
const trapHup = (): string => join(binDir, 'trap-hup');
const plain = (): string => join(binDir, 'plain-cli');
const hupLeader = (): string => join(binDir, 'hup-leader-trap-child');
const hupLeaderShort = (): string => join(binDir, 'hup-leader-short-child');
const hupLeaderTerm = (): string => join(binDir, 'hup-leader-term-child');
/** The out-of-process backend of T10, written into the temp root. */
const ladderBackend = (): string => join(root, 'ladder-exit-backend.ts');

before(async () => {
  root = await realpath(await makeTempDir('ai-sm-kill-'));
  binDir = join(root, 'bin');
  workDir = join(root, 'work');
  pidDir = join(root, 'pids');
  await mkdir(binDir);
  await mkdir(workDir);
  await mkdir(pidDir);
  await writeFile(trapBoth(), TRAP_HUP_TERM, { mode: 0o755 });
  await writeFile(trapHup(), TRAP_HUP, { mode: 0o755 });
  await writeFile(plain(), PLAIN, { mode: 0o755 });
  await writeFile(hupLeader(), HUP_LEADER_TRAP_CHILD, { mode: 0o755 });
  await writeFile(hupLeaderShort(), HUP_LEADER_SHORT_CHILD, { mode: 0o755 });
  await writeFile(hupLeaderTerm(), HUP_LEADER_TERM_CHILD, { mode: 0o755 });
  await writeFile(ladderBackend(), LADDER_EXIT_BACKEND);
  server = await startTestServer();
});

after(async () => {
  if (server !== undefined) await server.stop();
  // Backstop only: every test asserts its own processes are gone. Anything
  // still alive here would be the defect itself, so leaving it would poison
  // the machine the suite runs on.
  for (const pid of leftovers) {
    // Group first (a trapping leader's child only dies that way), then the pid.
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        /* already gone, which is what every test asserted */
      }
    }
  }
  if (root !== undefined) await removeTempDir(root);
});

function pidFile(): string {
  nextPidFile += 1;
  return join(pidDir, `pids-${nextPidFile}`);
}

/** The `expect` pids the fake CLI wrote, once every one of them is really up. */
async function pidsFrom(file: string, expect = 2): Promise<number[]> {
  return waitUntil(
    async () => {
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch {
        return undefined;
      }
      const pids = raw.trim().split(/\s+/).map(Number);
      if (pids.length !== expect || pids.some((p) => !Number.isInteger(p) || p <= 1)) {
        return undefined;
      }
      for (const p of pids) {
        if (!alive(p)) return undefined;
      }
      for (const p of pids) leftovers.add(p);
      return pids;
    },
    `the fake CLI to report its pids in ${file}`,
    15_000,
    25,
  );
}

/** Signal 0: true while the pid exists (a zombie counts — it is not reaped). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}

async function waitAllGone(pids: number[], what: string, timeoutMs: number): Promise<void> {
  await waitUntil(
    () => (pids.every((p) => !alive(p)) ? true : undefined),
    `${what} (pids ${pids.join(', ')})`,
    timeoutMs,
    25,
  );
  for (const p of pids) leftovers.delete(p);
}

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

/**
 * What a spied process.kill call must do INSTEAD of reaching the kernel:
 * throw the returned Error (the errno the syscall would have raised), record
 * the call and do nothing ('drop'), or — `undefined`, the default for every
 * call — delegate to the real process.kill.
 *
 * Injection is how the two answers the ladder cannot be handed on purpose get
 * tested: ESRCH (the group left between the probe and the signal) and EPERM (a
 * group this user may not signal). 'drop' is the safe way to assert "this
 * signal was sent" for a pid number that is already free again — the test
 * learns what was sent without a stranger ever being signalled.
 */
type KillFault = (pid: number, signal: string | number | undefined) => Error | 'drop' | undefined;

/** An errno the way process.kill raises it. */
function errno(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

interface Harness {
  manager: SessionManager;
  lines: string[];
  /** Every process.kill this test made, as [pid, signal]. */
  kills: [number, string | number | undefined][];
  /** Install (or clear, with undefined) the fault injector; see KillFault. */
  setFault: (fault: KillFault | undefined) => void;
  cleanup: () => Promise<void>;
}

/**
 * SessionManager on a temp history file, a capturing logger, and process.kill
 * wrapped so a test can say "no signal was sent" instead of inferring it from
 * an absent log line. The wrapper DELEGATES (node-pty signals through the same
 * function), and is restored by cleanup().
 */
async function harness(): Promise<Harness> {
  const dir = await makeTempDir('ai-sm-killh-');
  const lines: string[] = [];
  const log = (level: LogLevel, message: string): void => {
    lines.push(`${level} ${message}`);
  };
  const history = new SessionHistory(join(dir, 'history.json'), log);
  const kills: [number, string | number | undefined][] = [];
  let fault: KillFault | undefined;
  const realKill = process.kill.bind(process) as typeof process.kill;
  process.kill = ((pid: number, signal?: string | number): true => {
    kills.push([pid, signal]);
    const instead = fault?.(pid, signal);
    if (instead === 'drop') return true;
    if (instead !== undefined) throw instead;
    return realKill(pid, signal);
  }) as typeof process.kill;
  return {
    manager: new SessionManager(log, history),
    lines,
    kills,
    setFault: (next) => {
      fault = next;
    },
    cleanup: async () => {
      process.kill = realKill;
      await removeTempDir(dir);
    },
  };
}

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
