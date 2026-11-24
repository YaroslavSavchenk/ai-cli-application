/**
 * The REAL journal runner of server/previous-exit.ts — PLAN-QUALITY Q17 P1
 * (`.claude/plans/quality/PLAN-Q17.md` § P1 2): after a VM reboot the boot
 * asks `journalctl` for the previous boot's OOM kills, argv only (no shell),
 * 5 s at most, 64 KiB of output at most, newest line first (`-r`).
 *
 * How: `PreviousExit` in-process WITHOUT its `journal` seam, so the default
 * runner (`runCapture('journalctl', …)`) really spawns. `journalctl` is a
 * bash double on a temp PATH: it records its argv one per line and prints a
 * prepared answer, or `exec sleep`s past the timeout. Only the kernel facts
 * stay a seam (a boot id that differs from the record's = a reboot). The
 * real `journalctl` never runs.
 *
 * Why it matters: `previous-exit-store.test.ts` replaces the runner, so a
 * timeout of 50 s (a boot that hangs on a slow journal), an uncapped read, or
 * an argv the spec does not name all passed the suite (test gate
 * 2026-11-24, mutants on JOURNAL_TIMEOUT_MS / JOURNAL_MAX_BYTES / the args).
 *
 * NOT claimed: what a real systemd journal prints (the line format is
 * pinned in `previous-exit-model.test.ts` from the incident's own line); the
 * `adm`/`systemd-journal` group refusal (an exit 1, the same path as the
 * double's missing binary here).
 */
import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../../server/config-log.ts';
import { PreviousExit } from '../../server/previous-exit.ts';
import type { ExitRecord } from '../../server/previous-exit-model.ts';
import { makeTempDirSync, removeTempDir, waitUntil } from '../helpers/helpers.ts';

const root = makeTempDirSync('ai-sm-prev-exit-journal-');
after(() => removeTempDir(root));

const ORIGINAL_PATH = process.env['PATH'];
afterEach(() => {
  process.env['PATH'] = ORIGINAL_PATH;
});

const BOOT_A = '11111111-2222-4333-8444-555555555555';
const BOOT_B = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';
/** The spec's argv plus `-r` — what the double must receive, each as ONE argument. */
const OOM_ARGV = ['-b', '-1', '-k', '-r', '-o', 'short-iso', '--no-pager', '-g', 'Out of memory: Killed process'];
/** Inside the record's window (at 11:53:47Z), the incident's own shape. */
const OOM_LINE =
  '2026-11-24T12:53:41+01:00 host kernel: Out of memory: Killed process 46783 (python) ' +
  'total-vm:3720416kB, anon-rss:2796156kB, file-rss:0kB';
/** A kernel line the parser skips: filler that only takes room. */
const FILLER_LINE = '2026-11-24T12:00:00+01:00 host kernel: audit: type=1400 apparmor="ALLOWED" operation="open"\n';
/** The runner's 5 s, and how long past it the verdict may still be late (a loaded runner). */
const JOURNAL_TIMEOUT_MS = 5_000;
const VERDICT_CEILING_MS = 10_000;

const RECORD: ExitRecord = {
  at: '2026-11-24T11:53:47.000Z',
  startedAt: '2026-11-24T08:00:00.000Z',
  why: 'signal',
  signal: 'SIGTERM',
  presence: 1,
  sessions: ['11111111-2222-3333-4444-555555555555'],
  bootId: BOOT_A,
};

let dirs = 0;
interface Run {
  dir: string;
  lines: string[];
  /** The boot after a reboot, the real runner, the record planted. */
  judge(): PreviousExit;
}

/**
 * A fresh directory with a `journalctl` double whose body is `script`, put
 * first and alone on PATH (plus /bin and /usr/bin for bash and sleep).
 */
function withJournal(script: string): Run {
  dirs += 1;
  const dir = join(root, `t${dirs}`);
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'journalctl'), `#!/bin/bash\n${script}\n`);
  chmodSync(join(bin, 'journalctl'), 0o755);
  process.env['PATH'] = `${bin}:/usr/bin:/bin`;
  const file = join(dir, 'last-exit.json');
  writeFileSync(file, JSON.stringify(RECORD), { mode: 0o600 });
  const lines: string[] = [];
  const log: Logger = (level, message) => void lines.push(`${level} ${message}`);
  return {
    dir,
    lines,
    judge: () => {
      const p = new PreviousExit({ file, log, bootFacts: () => ({ bootId: BOOT_B, btimeMs: undefined }) });
      p.judge([], 'x');
      return p;
    },
  };
}

test('the real runner spawns journalctl with exactly the spec argv plus -r, each word one argument, no shell', async () => {
  const run = withJournal(`printf '%s\\n' "$@" > "${'$'}{0%/bin/journalctl}/argv"\nprintf '%s\\n' '${OOM_LINE}'`);
  const notice = await run.judge().notice();
  assert.deepEqual(notice, {
    at: RECORD.at,
    cause: 'oom',
    detail: { process: 'python', rssMb: 2731 },
    sessions: 1,
  });
  const argv = readFileSync(join(run.dir, 'argv'), 'utf8').split('\n').slice(0, -1);
  assert.deepEqual(argv, OOM_ARGV, 'the -g pattern arrives whole: argv, never a shell line');
});

test('the output is capped at 64 KiB: a line past the cap is never read, one before it is', async () => {
  const filler = (kib: number): string => FILLER_LINE.repeat(Math.ceil((kib * 1024) / FILLER_LINE.length));
  const early = withJournal(`cat "${'$'}{0%/bin/journalctl}/out"`);
  writeFileSync(join(early.dir, 'out'), `${filler(60)}${OOM_LINE}\n`);
  assert.equal((await early.judge().notice())?.cause, 'oom', 'a line inside the first 64 KiB counts');

  const late = withJournal(`cat "${'$'}{0%/bin/journalctl}/out"`);
  writeFileSync(join(late.dir, 'out'), `${filler(70)}${OOM_LINE}\n`);
  assert.equal(
    (await late.judge().notice())?.cause,
    'wsl-stopped',
    'past 64 KiB the journal is cut: -r puts the lines near the exit first, so the cut drops the oldest',
  );
});

test('a journal that hangs is given up after 5 s and killed: the verdict is wsl-stopped, the child is gone', async () => {
  const run = withJournal(`echo $$ > "${'$'}{0%/bin/journalctl}/pid"\nexec sleep 30`);
  // Monotonic: WSL steps its wall clock on a host re-sync (seen here, 2026-11-24).
  const started = performance.now();
  const verdict = run.judge().notice();
  const late = Symbol('late');
  // The one wait that proves something did NOT happen in time; cleared at
  // once so it never holds this file's process open.
  let ceiling: NodeJS.Timeout | undefined;
  const first = await Promise.race([
    verdict,
    new Promise<typeof late>((resolve) => {
      ceiling = setTimeout(() => resolve(late), VERDICT_CEILING_MS);
    }),
  ]);
  clearTimeout(ceiling);
  assert.notEqual(first, late, `no verdict within ${VERDICT_CEILING_MS} ms: the 5 s timeout did not fire`);
  assert.equal((first as Awaited<typeof verdict>)?.cause, 'wsl-stopped');
  assert.ok(performance.now() - started >= JOURNAL_TIMEOUT_MS - 500, 'not given up before its 5 s');
  const pid = Number(readFileSync(join(run.dir, 'pid'), 'utf8'));
  await waitUntil(() => {
    try {
      process.kill(pid, 0);
      return undefined;
    } catch {
      return true;
    }
  }, 'the hung journalctl to be killed');
  assert.ok(
    run.lines.includes("debug [previous-exit] the previous boot's kernel log could not be read (no OOM line known)"),
    `one debug line, got ${JSON.stringify(run.lines)}`,
  );
});

test('no journalctl at all (no systemd) is wsl-stopped, never a throw', async () => {
  const run = withJournal('exit 0');
  process.env['PATH'] = join(run.dir, 'empty');
  assert.equal((await run.judge().notice())?.cause, 'wsl-stopped');
});
