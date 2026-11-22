/**
 * The PTY table's own kill edges — Nocturne D9 P1
 * (`.claude/plans/nocturne/PLAN-D9.md` § Phases): `server/pty-table.ts`
 * `kill`, `shutdownAll` and the group probe, driven through
 * `server/pty-host-api.ts`'s in-process `PtyHost` with no SessionManager in
 * front of it.
 *
 * How: the host over real PTYs running the fake CLIs of
 * `tests/helpers/sessions-kill-fixture.ts` (shell scripts that ignore exactly
 * the signals the real gemini wrapper ignores), with the fixture's spy on
 * process.kill so a test can say "no signal was sent" and inject the errno a
 * probe cannot be handed on purpose.
 *
 * Why it matters: SessionManager guards these paths itself (`destroy` kills
 * only a live session; `destroyAll` destroys every session before it calls
 * `shutdownAll`), so the table's own guards are unreachable through it — and
 * from P2 the table runs in a pty-host process whose callers are a socket.
 * A kill that reaches an exited PTY's group signals a pid number that may
 * belong to a stranger; a `shutdownAll` that skips a running PTY leaves it,
 * API key and all, alive after the host is gone. The mutation probe of D9 P1
 * found every test below missing.
 *
 * NOT claimed: the DELETE ladder's rungs and their timing through
 * SessionManager — `sessions-kill.test.ts`, `sessions-kill-ladder.test.ts`; a
 * pty-host process and its wire (P2).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createInProcessPtyHost, type PtyHost } from '../../server/pty-host-api.ts';
import type { PtyExitRecord } from '../../server/pty-table.ts';
import type { LogLevel } from '../../server/config-log.ts';
import { ptyEnv } from '../../server/sessions-env.ts';
import { waitUntil, sleep } from '../helpers/helpers.ts';
import {
  KILL_TERM_MS,
  KILL_KILL_MS,
  workDir,
  trapBoth,
  hupDeafAlone,
  setupKillFixture,
  teardownKillFixture,
  pidFile,
  pidsFrom,
  waitAllGone,
  errno,
  spyProcessKill,
  type KillSpy,
} from '../helpers/sessions-kill-fixture.ts';

/**
 * The margin a "nothing was sent" wait gives a wrong signal to show up in the
 * spy (tests/README.md § Time: a wait that proves something did NOT happen),
 * past a rung's due time — the same size as sessions-kill-ladder.test.ts uses.
 */
const NO_SIGNAL_MARGIN_MS = 500;

before(async () => {
  await setupKillFixture();
});

after(async () => {
  await teardownKillFixture();
});

interface Table {
  host: PtyHost;
  lines: string[];
  exits: Map<string, PtyExitRecord>;
  spy: KillSpy;
}

/** An in-process host with a capturing logger, its exits recorded, and process.kill spied. */
function table(): Table {
  const lines: string[] = [];
  const host = createInProcessPtyHost((level: LogLevel, message: string) => {
    lines.push(`${level} ${message}`);
  });
  const exits = new Map<string, PtyExitRecord>();
  host.listen({ output: () => {}, exit: (id, record) => exits.set(id, record) });
  return { host, lines, exits, spy: spyProcessKill() };
}

let nextId = 0;
/** Spawn a fake CLI that writes its pids to a fresh pid file; resolves once all of them run. */
async function spawnCli(t: Table, command: string, expect: number): Promise<{ id: string; pids: number[] }> {
  nextId += 1;
  const id = `pty-table-kill-${process.pid}-${nextId}`;
  const file = pidFile();
  await t.host.spawn({ id, file: command, argv: [file], cwd: workDir, env: ptyEnv(), cols: 80, rows: 24 });
  return { id, pids: await pidsFrom(file, expect) };
}

/** The spied calls that reached this group or its leader, from `mark` on. */
function touching(t: Table, leader: number, mark: number): [number, string | number | undefined][] {
  return t.spy.kills.slice(mark).filter(([pid]) => pid === leader || pid === -leader);
}

test('a PTY that exited on its own is not signalled by a later kill or shutdownAll', async () => {
  const t = table();
  try {
    nextId += 1;
    const id = `pty-table-kill-${process.pid}-${nextId}`;
    const { pid } = await t.host.spawn({
      id,
      file: 'bash',
      argv: ['-c', 'exit 0'],
      cwd: workDir,
      env: ptyEnv(),
      cols: 80,
      rows: 24,
    });
    await waitUntil(() => t.exits.get(id), 'bash to exit on its own', 4_000, 20);
    const mark = t.spy.kills.length;
    t.host.kill(id, 'now');
    t.host.kill(id, 'ladder');
    t.host.shutdownAll();
    assert.deepEqual(
      touching(t, pid, mark),
      [],
      `no SIGHUP to the old pid, no SIGKILL to its group; kills: ${JSON.stringify(t.spy.kills.slice(mark))}`,
    );
    t.host.forget(id);
  } finally {
    t.spy.restore();
  }
});

test('a second kill of a PTY that is already being killed signals nothing new; shutdownAll then ends its group', async () => {
  const t = table();
  let pids: number[] = [];
  try {
    const cli = await spawnCli(t, trapBoth(), 2);
    pids = cli.pids;
    const leader = pids[0] as number;
    t.host.kill(cli.id, 'ladder');
    assert.ok(
      touching(t, leader, 0).some(([pid, sig]) => pid === leader && sig === 'SIGHUP'),
      `the first kill sends SIGHUP to the leader; kills: ${JSON.stringify(t.spy.kills)}`,
    );
    const mark = t.spy.kills.length;
    t.host.kill(cli.id, 'ladder');
    t.host.kill(cli.id, 'now');
    assert.deepEqual(
      touching(t, leader, mark),
      [],
      `a kill in flight is not started twice; kills: ${JSON.stringify(t.spy.kills.slice(mark))}`,
    );
    // The CLI ignores SIGHUP and SIGTERM: only the ladder's last rung or the
    // shutdown sweep ends it, and the sweep does not wait for a rung.
    const at = Date.now();
    t.host.shutdownAll();
    await waitAllGone(pids, 'leader and child to be gone right after shutdownAll', 1_000);
    assert.ok(Date.now() - at < KILL_TERM_MS, 'the sweep waits for no rung');
    assert.ok(
      touching(t, leader, mark).some(([pid, sig]) => pid === -leader && sig === 'SIGKILL'),
      `the sweep SIGKILLs the group; kills: ${JSON.stringify(t.spy.kills.slice(mark))}`,
    );
    await waitUntil(() => t.exits.get(cli.id), 'the PTY to report its exit', 4_000, 20);
    t.host.forget(cli.id);
  } finally {
    t.spy.restore();
  }
});

test('shutdownAll kills a PTY nobody killed yet: SIGHUP, then SIGKILL to its group at once', async () => {
  const t = table();
  try {
    const { id, pids } = await spawnCli(t, trapBoth(), 2);
    const leader = pids[0] as number;
    const at = Date.now();
    t.host.shutdownAll();
    await waitAllGone(pids, 'leader and child to be gone right after shutdownAll', 1_000);
    assert.ok(Date.now() - at < KILL_TERM_MS, 'shutdown waits for no rung');
    const sent = touching(t, leader, 0);
    assert.ok(
      sent.some(([pid, sig]) => pid === leader && sig === 'SIGHUP'),
      `SIGHUP first, as every kill; kills: ${JSON.stringify(sent)}`,
    );
    assert.ok(
      sent.some(([pid, sig]) => pid === -leader && sig === 'SIGKILL'),
      `then SIGKILL to the GROUP; kills: ${JSON.stringify(sent)}`,
    );
    assert.ok(
      t.lines.some((l) => l.includes(`${id} killed for shutdown with SIGHUP; sending SIGKILL to its process group immediately`)),
      `the shutdown kill line; log:\n${t.lines.join('\n')}`,
    );
    const record = await waitUntil(() => t.exits.get(id), 'the PTY to report its exit', 4_000, 20);
    assert.equal(record.signal, 9, 'the exit record names the signal that ended it (SIGKILL)');
    t.host.forget(id);
  } finally {
    t.spy.restore();
  }
});

test('shutdownAll asks before it finishes off a ladder: a group the probe finds gone is not signalled', async () => {
  const t = table();
  let leader = 0;
  try {
    const cli = await spawnCli(t, trapBoth(), 2);
    leader = cli.pids[0] as number;
    // The CLI ignores SIGHUP, so the ladder is armed and its group is alive.
    // The probe of that group is told ESRCH ("gone") — the one answer that may
    // stop the sweep — and any signal to it is recorded, not sent.
    t.spy.setFault((pid, sig) =>
      pid !== -leader ? undefined : sig === 0 ? errno('ESRCH', 'kill ESRCH') : 'drop',
    );
    t.host.kill(cli.id, 'ladder');
    const mark = t.spy.kills.length;
    t.host.shutdownAll();
    const sent = touching(t, leader, mark);
    assert.ok(
      sent.some(([pid, sig]) => pid === -leader && sig === 0),
      `the sweep probes the ladder's group; kills: ${JSON.stringify(sent)}`,
    );
    assert.deepEqual(
      sent.filter(([, sig]) => sig !== 0),
      [],
      `a group found gone is never signalled — its number may be a stranger's; kills: ${JSON.stringify(sent)}`,
    );
  } finally {
    t.spy.restore();
    // The group really is alive (only the probe was lied to): end it here.
    if (leader > 1) {
      try {
        process.kill(-leader, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
});

test('an unforeseen probe errno counts as alive — the sweep SIGKILLs — and is warned about once per table', async () => {
  const t = table();
  try {
    const a = await spawnCli(t, trapBoth(), 2);
    const b = await spawnCli(t, trapBoth(), 2);
    const groups = [-(a.pids[0] as number), -(b.pids[0] as number)];
    // EINVAL is no answer the probe expects: neither ESRCH ("gone") nor EPERM.
    t.spy.setFault((pid, sig) => (groups.includes(pid) && sig === 0 ? errno('EINVAL', 'kill EINVAL') : undefined));
    t.host.kill(a.id, 'ladder');
    t.host.kill(b.id, 'ladder');
    t.host.shutdownAll();
    await waitAllGone([...a.pids, ...b.pids], 'both groups to be SIGKILLed although their probes failed', 1_000);
    const warnings = t.lines.filter((l) => l.includes('process group probe failed, assuming alive'));
    assert.equal(warnings.length, 1, `two failed probes, one warning; log:\n${t.lines.join('\n')}`);
    assert.match(warnings[0] ?? '', /^warn .*EINVAL/, 'the warning names the errno');
    for (const cli of [a, b]) {
      await waitUntil(() => t.exits.get(cli.id), 'the PTY to report its exit', 4_000, 20);
      t.host.forget(cli.id);
    }
  } finally {
    t.spy.restore();
  }
});

test('a ladder whose first rung found the group gone leaves the register: shutdownAll then touches nothing', async () => {
  const t = table();
  let leader = 0;
  try {
    const cli = await spawnCli(t, trapBoth(), 2);
    leader = cli.pids[0] as number;
    // As in the sweep test above: the group is alive, its probe says ESRCH,
    // and nothing sent to it reaches it.
    t.spy.setFault((pid, sig) =>
      pid !== -leader ? undefined : sig === 0 ? errno('ESRCH', 'kill ESRCH') : 'drop',
    );
    t.host.kill(cli.id, 'ladder');
    await waitUntil(
      () => (touching(t, leader, 0).some(([pid, sig]) => pid === -leader && sig === 0) ? true : undefined),
      'the SIGTERM rung to probe the group',
      KILL_TERM_MS + 2_000,
      25,
    );
    const mark = t.spy.kills.length;
    // The rung found the group gone; the ladder is over. A register entry left
    // behind would have the sweep probe — and on a live answer SIGKILL — a pid
    // number that is free for any process on the machine.
    t.host.shutdownAll();
    assert.deepEqual(
      touching(t, leader, mark),
      [],
      `a finished ladder is not swept; kills: ${JSON.stringify(t.spy.kills.slice(mark))}`,
    );
  } finally {
    t.spy.restore();
    if (leader > 1) {
      try {
        process.kill(-leader, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
});

test('a leader that dies at the SIGTERM rung calls the SIGKILL rung off: its group is never touched again', async () => {
  const t = table();
  try {
    // Deaf to SIGHUP, ends on SIGTERM, and alone in its group: the exit node-pty
    // reports after the SIGTERM rung is the moment the whole group is gone.
    const { id, pids } = await spawnCli(t, hupDeafAlone(), 1);
    const leader = pids[0] as number;
    t.host.kill(id, 'ladder');
    await waitUntil(() => t.exits.get(id), 'the leader to exit at the SIGTERM rung', KILL_TERM_MS + 3_000, 20);
    await waitAllGone(pids, 'the leader to be gone', 1_000);
    assert.ok(
      touching(t, leader, 0).some(([pid, sig]) => pid === -leader && sig === 'SIGTERM'),
      `it took the SIGTERM rung to end it; kills: ${JSON.stringify(t.spy.kills)}`,
    );
    const mark = t.spy.kills.length;
    // Past the SIGKILL rung's due time: a rung left armed would probe — and on
    // a live answer SIGKILL — a pid number that is free for anyone by then.
    await sleep(KILL_KILL_MS + NO_SIGNAL_MARGIN_MS);
    assert.deepEqual(
      touching(t, leader, mark),
      [],
      `nothing touches the group of a leader that is gone; kills: ${JSON.stringify(t.spy.kills.slice(mark))}`,
    );
    t.host.forget(id);
  } finally {
    t.spy.restore();
  }
});
