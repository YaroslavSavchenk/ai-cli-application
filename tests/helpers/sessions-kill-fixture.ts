/**
 * Shared fixture for the process-group kill tests
 * (`tests/server/sessions-kill.test.ts`, `tests/server/sessions-kill-ladder.test.ts`):
 * the fake CLIs (shell scripts that ignore exactly the signals the real
 * gemini wrapper ignores), the out-of-process ladder backend, the temp root
 * they are written into, pid bookkeeping with a SIGKILL backstop, and the
 * in-process SessionManager harness with a spy on process.kill.
 *
 * Module state (`root`, `binDir`, `workDir`, `pidDir`, `leftovers`) is per test
 * FILE: `node --test` runs each file in its own process. A file calls
 * `setupKillFixture()` in its `before` and `teardownKillFixture()` in its
 * `after`; a file that needs a server boots its own around them.
 */
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionHistory } from '../../server/history.ts';
import { SessionManager } from '../../server/sessions.ts';
import type { LogLevel } from '../../server/config.ts';
import { waitUntil, makeTempDir, removeTempDir } from './helpers.ts';

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
export const KILL_TERM_MS = 2000;
export const KILL_KILL_MS = 3000;

/** Group leaders this file started; emptied as each test proves them dead. */
export const leftovers = new Set<number>();

export let root: string;
export let binDir: string;
export let workDir: string;
export let pidDir: string;
let nextPidFile = 0;

export const trapBoth = (): string => join(binDir, 'trap-hup-term');
export const trapHup = (): string => join(binDir, 'trap-hup');
export const plain = (): string => join(binDir, 'plain-cli');
export const hupLeader = (): string => join(binDir, 'hup-leader-trap-child');
export const hupLeaderShort = (): string => join(binDir, 'hup-leader-short-child');
export const hupLeaderTerm = (): string => join(binDir, 'hup-leader-term-child');
/** The out-of-process backend of T10, written into the temp root. */
export const ladderBackend = (): string => join(root, 'ladder-exit-backend.ts');

/** Write the fake CLIs and the ladder backend into a fresh temp root. Call in `before`. */
export async function setupKillFixture(): Promise<void> {
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
}

/** SIGKILL whatever a test left alive, then remove the temp root. Call in `after`. */
export async function teardownKillFixture(): Promise<void> {
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
}

export function pidFile(): string {
  nextPidFile += 1;
  return join(pidDir, `pids-${nextPidFile}`);
}

/** The `expect` pids the fake CLI wrote, once every one of them is really up. */
export async function pidsFrom(file: string, expect = 2): Promise<number[]> {
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
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}

export async function waitAllGone(pids: number[], what: string, timeoutMs: number): Promise<void> {
  await waitUntil(
    () => (pids.every((p) => !alive(p)) ? true : undefined),
    `${what} (pids ${pids.join(', ')})`,
    timeoutMs,
    25,
  );
  for (const p of pids) leftovers.delete(p);
}


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
export type KillFault = (pid: number, signal: string | number | undefined) => Error | 'drop' | undefined;

/** An errno the way process.kill raises it. */
export function errno(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

export interface Harness {
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
export async function harness(): Promise<Harness> {
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
