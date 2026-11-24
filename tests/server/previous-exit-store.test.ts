/**
 * The exit record's file and the boot's verdict — server/previous-exit.ts
 * (`PreviousExit`), PLAN-QUALITY Q17 P1 (`.claude/plans/quality/PLAN-Q17.md`
 * § P1 — backend, § Test gate): the record written 0600 and read back, the
 * journal asked only after a reboot and with the spec's argv, an unreadable
 * journal, a refused or malformed file set aside, the notice consumed once,
 * a superseded record marked seen, adopted sessions dropped from a crash.
 *
 * How: the class in-process over a temp file, its two seams replaced — the
 * kernel facts (`bootFacts`) and the journal runner (`journal`) — so no test
 * reads /proc's boot id for a verdict or runs the real `journalctl`.
 *
 * Why it matters: a journal that runs on every boot costs up to 5 s; a
 * record read through a planted FIFO would hang the boot; a notice that
 * survives its dismissal would ask the user again on every start.
 *
 * NOT claimed: the shutdown paths that call `writeRecord` and the routes —
 * `previous-exit-routes.test.ts` (a real backend); the pure rules —
 * `previous-exit-model.test.ts`.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../../server/config-log.ts';
import { PreviousExit, type BootFacts, type JournalRunner } from '../../server/previous-exit.ts';
import type { ExitRecord } from '../../server/previous-exit-model.ts';
import { makeTempDirSync, removeTempDir } from '../helpers/helpers.ts';

const root = makeTempDirSync('ai-sm-previous-exit-');
after(() => removeTempDir(root));

const BOOT_A = '11111111-2222-4333-8444-555555555555';
const BOOT_B = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';
const H1 = '11111111-2222-3333-4444-555555555555';
const H2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OOM_ARGV = ['-b', '-1', '-k', '-r', '-o', 'short-iso', '--no-pager', '-g', 'Out of memory: Killed process'];

let dirs = 0;
interface Harness {
  file: string;
  dir: string;
  lines: string[];
  journalCalls: string[][];
  make(opts?: { boot?: BootFacts; journal?: JournalRunner }): PreviousExit;
}

/** A fresh directory for one test, a logger that keeps its lines, and a journal that records its calls. */
function harness(): Harness {
  dirs += 1;
  const dir = join(root, `t${dirs}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'last-exit.json');
  const lines: string[] = [];
  const journalCalls: string[][] = [];
  const log: Logger = (level, message) => void lines.push(`${level} ${message}`);
  return {
    file,
    dir,
    lines,
    journalCalls,
    make: (opts = {}) =>
      new PreviousExit({
        file,
        log,
        bootFacts: () => opts.boot ?? { bootId: BOOT_A, btimeMs: undefined },
        journal: (args) => {
          journalCalls.push(args);
          return (opts.journal ?? (async () => null))(args);
        },
      }),
  };
}

function record(over: Partial<ExitRecord> = {}): ExitRecord {
  return {
    at: '2026-11-24T11:53:47.000Z',
    startedAt: '2026-11-24T08:00:00.000Z',
    why: 'signal',
    signal: 'SIGTERM',
    presence: 1,
    sessions: [H1, H2],
    bootId: BOOT_A,
    ...over,
  };
}

function plant(h: Harness, r: ExitRecord): void {
  writeFileSync(h.file, JSON.stringify(r), { mode: 0o600 });
}

function onDisk(h: Harness): ExitRecord {
  return JSON.parse(readFileSync(h.file, 'utf8')) as ExitRecord;
}

test('writeRecord writes the facts, the boot id and the time, 0600, and says so in one line', () => {
  const h = harness();
  h.make().writeRecord({ why: 'signal', signal: 'SIGTERM', presence: 1, startedAt: '2026-11-24T08:00:00.000Z', sessions: [H1] });
  const written = onDisk(h);
  assert.deepEqual(
    { ...written, at: undefined },
    { at: undefined, startedAt: '2026-11-24T08:00:00.000Z', why: 'signal', signal: 'SIGTERM', presence: 1, sessions: [H1], bootId: BOOT_A },
  );
  assert.ok(Number.isFinite(Date.parse(written.at)), 'at is a time');
  assert.equal(statSync(h.file).mode & 0o777, 0o600);
  assert.deepEqual(h.lines, ['info [previous-exit] exit record written: signal SIGTERM, presence=1, 1 live session(s)']);
});

test('writeRecord never throws: an unwritable place is one error line', () => {
  const h = harness();
  const p = new PreviousExit({ file: join(h.dir, 'missing-dir', 'last-exit.json'), log: (l, m) => void h.lines.push(`${l} ${m}`) });
  assert.doesNotThrow(() => p.writeRecord({ why: 'other', presence: 0, startedAt: '2026-11-24T08:00:00.000Z', sessions: [] }));
  assert.equal(h.lines.length, 1);
  assert.match(h.lines[0] as string, /^error \[previous-exit\] failed to write /);
});

test('a signal with a window open on the same boot is `stopped`, and the journal is never asked', async () => {
  const h = harness();
  plant(h, record());
  const p = h.make({ boot: { bootId: BOOT_A, btimeMs: undefined } });
  p.judge([], 'x');
  assert.deepEqual(await p.notice(), { at: '2026-11-24T11:53:47.000Z', cause: 'stopped', detail: null, sessions: 2 });
  assert.deepEqual(h.journalCalls, [], 'no journalctl on the same boot');
  assert.ok(h.lines.includes('info [previous-exit] previous run: stopped at 2026-11-24T11:53:47.000Z; 2 session(s) to resume'));
});

test('after a reboot the journal is asked with exactly the spec argv plus -r (newest first), and its OOM line names the process', async () => {
  const h = harness();
  plant(h, record());
  const line =
    '2026-11-24T12:53:41+01:00 host kernel: Out of memory: Killed process 46783 (python) total-vm:3720416kB, anon-rss:2796156kB, file-rss:0kB\n';
  const p = h.make({ boot: { bootId: BOOT_B, btimeMs: undefined }, journal: async () => line });
  p.judge([], 'x');
  assert.deepEqual(await p.notice(), {
    at: '2026-11-24T11:53:47.000Z',
    cause: 'oom',
    detail: { process: 'python', rssMb: 2731 },
    sessions: 2,
  });
  assert.deepEqual(h.journalCalls, [OOM_ARGV]);
});

test('an unreadable journal after a reboot is `wsl-stopped`, as is one with no line in the window', async () => {
  for (const journal of [async () => null, async () => { throw new Error('boom'); }, async () => '-- No entries --\n']) {
    const h = harness();
    plant(h, record());
    const p = h.make({ boot: { bootId: BOOT_B, btimeMs: undefined }, journal });
    p.judge([], 'x');
    assert.equal((await p.notice())?.cause, 'wsl-stopped');
  }
});

test('a record without a boot id falls back to btime', async () => {
  const h = harness();
  plant(h, record({ bootId: undefined }));
  const p = h.make({ boot: { bootId: BOOT_A, btimeMs: Date.parse('2026-11-24T12:00:00.000Z') } });
  p.judge([], 'x');
  assert.equal((await p.notice())?.cause, 'wsl-stopped');
});

test('no record and crash stamps at boot is `crash` at the given time; the journal is not asked', async () => {
  const h = harness();
  const p = h.make();
  p.judge([{ id: H1, lastUsedAt: '2026-11-24T10:00:00.000Z' }], '2026-11-24T10:30:00.000Z');
  assert.deepEqual(await p.notice(), { at: '2026-11-24T10:30:00.000Z', cause: 'crash', detail: null, sessions: 1 });
  assert.deepEqual(h.journalCalls, []);
});

test('a clean stop tells nothing: presence grace, restart, no record at all', async () => {
  for (const r of [record({ why: 'presence-grace', signal: undefined, presence: 0 }), record({ why: 'restart', signal: undefined }), undefined]) {
    const h = harness();
    if (r !== undefined) plant(h, r);
    const p = h.make();
    p.judge([], 'x');
    assert.equal(await p.notice(), null, JSON.stringify(r));
  }
});

test('take() hands the ids out once: a second and a concurrent call get nothing, the record is marked seen', async () => {
  const h = harness();
  plant(h, record());
  const p = h.make();
  p.judge([], 'x');
  const [first, concurrent] = await Promise.all([p.take(), p.take()]);
  assert.deepEqual(first, [H1, H2]);
  assert.deepEqual(concurrent, [], 'the concurrent call resumes nothing new');
  assert.deepEqual(await p.take(), []);
  assert.equal(await p.notice(), null, 'GET is 204 from now on');
  assert.equal(onDisk(h).seen, true, 'marked seen, not deleted');
  assert.deepEqual(onDisk(h).sessions, [H1, H2], 'the record itself is kept');
});

test('dismiss marks the record seen, and the next boot tells nothing', async () => {
  const h = harness();
  plant(h, record());
  const p = h.make();
  p.judge([], 'x');
  await p.dismiss();
  assert.equal(await p.notice(), null);
  const next = h.make();
  next.judge([], 'x');
  assert.equal(await next.notice(), null, 'a seen record is never told again');
});

test('an unconsumed notice is told again on the next boot (until resumed, dismissed or a newer stop)', async () => {
  const h = harness();
  plant(h, record());
  h.make().judge([], 'x');
  const next = h.make();
  next.judge([], 'x');
  assert.equal((await next.notice())?.cause, 'stopped');
});

test('a crash verdict supersedes an older unseen record: it is marked seen and never comes back', async () => {
  const h = harness();
  plant(h, record());
  const p = h.make();
  p.judge([{ id: 'later', lastUsedAt: '2026-11-24T13:00:00.000Z' }], '2026-11-24T14:00:00.000Z');
  assert.deepEqual(await p.notice(), { at: '2026-11-24T14:00:00.000Z', cause: 'crash', detail: null, sessions: 1 });
  assert.equal(onDisk(h).seen, true);
});

test('crash-stamped sessions a pty-host turned out to hold are dropped; none left is no notice', async () => {
  const h = harness();
  const p = h.make();
  p.judge([{ id: H1, lastUsedAt: '2026-11-24T10:00:00.000Z' }, { id: H2, lastUsedAt: '2026-11-24T10:00:00.000Z' }], 'x');
  p.reopened([H1]);
  assert.equal((await p.notice())?.sessions, 1);
  assert.deepEqual(await h.make().take(), [], 'another instance knows nothing (no judge)');
  p.reopened([H2]);
  assert.equal(await p.notice(), null);
});

test('reopened ids never touch a record verdict', async () => {
  const h = harness();
  plant(h, record());
  const p = h.make();
  p.judge([], 'x');
  p.reopened([H1]);
  assert.equal((await p.notice())?.sessions, 2);
});

test('a malformed record is set aside with one warn line and tells nothing', async () => {
  const h = harness();
  writeFileSync(h.file, '{"at": "secret-looking text"', { mode: 0o600 });
  const p = h.make();
  p.judge([], 'x');
  assert.equal(await p.notice(), null);
  assert.equal(existsSync(h.file), false, 'moved out of the way');
  assert.equal(readdirSync(h.dir).filter((n) => n.startsWith('last-exit.json.refused-')).length, 1);
  assert.ok(h.lines.some((l) => l === `warn [previous-exit] exit record ${h.file} is not a record`));
  assert.ok(!h.lines.some((l) => l.includes('secret-looking')), 'the content never reaches the log');
});

test('a FIFO planted at the path returns at once, is refused and set aside', async () => {
  // In-process on purpose: readSmallRegularFile opens O_NONBLOCK, so a FIFO
  // cannot block here; a regression would hang this file and the exit guard
  // would end it red (tests/server/data-dir-readers.test.ts proves the open).
  const h = harness();
  execFileSync('mkfifo', [h.file]);
  const p = h.make();
  p.judge([], 'x');
  assert.equal(await p.notice(), null);
  assert.equal(existsSync(h.file), false);
  assert.ok(h.lines.some((l) => l === `warn [previous-exit] exit record ${h.file} refused: not a regular file`));
});

test('a record over 256 KiB is refused unread and set aside, even when it is a valid record', async () => {
  // Test gate 2026-11-24: the byte cap had no test — a mutant raising it to
  // 256 MiB passed. Whitespace keeps the JSON a valid, signalled record, so
  // only the size can refuse it.
  const h = harness();
  writeFileSync(h.file, JSON.stringify(record()) + ' '.repeat(256 * 1024), { mode: 0o600 });
  const p = h.make();
  p.judge([], 'x');
  assert.equal(await p.notice(), null, 'nothing told from an oversized file');
  assert.equal(existsSync(h.file), false, 'moved out of the way');
  assert.ok(
    h.lines.some((l) => l.startsWith(`warn [previous-exit] exit record ${h.file} refused: `)),
    `one refusal line, got ${JSON.stringify(h.lines)}`,
  );
});
