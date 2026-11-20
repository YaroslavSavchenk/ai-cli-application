/**
 * The final-output rescue's guards — Nocturne D9 P1
 * (`.claude/plans/nocturne/PLAN-D9.md` § Phases): `server/pty-table.ts`
 * `rescueFinalOutput` / `drainPtyMaster`, which read whatever the kernel still
 * holds on a PTY's master fd at the moment node-pty destroys its read socket.
 *
 * How: the in-process `PtyHost` over a real PTY (`bash -c …`), with
 * `node:fs`'s `fstatSync` and `readSync` replaced through `mock.method` +
 * `syncBuiltinESMExports()` (the table imports them by name) for exactly the
 * window between the spawn and the exit. Mocked because the machine cannot be
 * made to produce these on purpose (tests/README.md § Mocks): an fd number
 * recycled to another file before the drain, and a master that keeps
 * producing past the drain's 64-read bound. The identity is captured during
 * the spawn, before the mocks go in, so it is the real one.
 *
 * Why it matters: the drain's whole safety case is that it only ever reads THIS
 * PTY's master. An fd number recycled to server.log or runtime.json (its bearer
 * token) would be read into the scrollback and broadcast to every attached
 * client. The bound keeps a pathological fd from spinning the one event loop
 * every session shares — and a truncated rescue must say so in the log.
 *
 * NOT claimed: that the rescue saves a lost tail under a stalled reader —
 * `tests/server/sessions-tail.test.ts` (real PTY, no mocks); Windows/ConPTY,
 * which has no master fd.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createInProcessPtyHost, type PtyHost } from '../../server/pty-host-api.ts';
import type { PtyExitRecord } from '../../server/pty-table.ts';
import type { LogLevel } from '../../server/config.ts';
import { ptyEnv } from '../../server/sessions-env.ts';
import { waitUntil } from '../helpers/helpers.ts';

/** server/pty-table.ts TAIL_DRAIN_MAX_READS: the drain's read bound. */
const DRAIN_MAX_READS = 64;
/** server/pty-table.ts TAIL_DRAIN_CHUNK_BYTES: one read's buffer. */
const DRAIN_CHUNK_BYTES = 64 * 1024;

interface Run {
  /** Output events of this PTY, in order. */
  chunks: string[];
  record: PtyExitRecord;
  lines: string[];
  /** Every fd the drain fstat'ed, and every readSync it made, while the mocks were in. */
  fstats: number[];
  reads: { fd: number; length: number }[];
}

type FstatFake = (fd: number, real: fs.Stats) => fs.Stats;
type ReadFake = (fd: number, buf: Buffer, offset: number, length: number) => number | 'real';

let nextId = 0;

/**
 * Spawn `bash -c 'read -r _; <script>'`, install the fakes once the spawn has
 * captured the master's identity, end the PTY with a newline, and restore the
 * real `node:fs` once its exit is reported. `throwOn`: the owner's output
 * listener throws on a chunk holding that text.
 */
async function runWithFakes(
  script: string,
  fstatFake: FstatFake | undefined,
  readFake: ReadFake | undefined,
  throwOn?: string,
): Promise<Run> {
  const lines: string[] = [];
  const host: PtyHost = createInProcessPtyHost((level: LogLevel, message: string) => {
    lines.push(`${level} ${message}`);
  });
  nextId += 1;
  const id = `pty-table-rescue-${process.pid}-${nextId}`;
  const chunks: string[] = [];
  let record: PtyExitRecord | undefined;
  host.listen({
    output: (who, data) => {
      if (who !== id) return;
      chunks.push(data);
      // The owner's output path failing on a rescued chunk (a ws.send that throws).
      if (throwOn !== undefined && data.includes(throwOn)) throw new Error('owner output path failed');
    },
    exit: (who, r) => {
      if (who === id) record = r;
    },
  });
  await host.spawn({ id, file: 'bash', argv: ['-c', `read -r _; ${script}`], cwd: process.cwd(), env: ptyEnv(), cols: 80, rows: 24 });
  const fstats: number[] = [];
  const reads: Run['reads'] = [];
  const realFstat = fs.fstatSync.bind(fs) as (fd: number) => fs.Stats;
  const realRead = fs.readSync.bind(fs) as (fd: number, buf: Buffer, offset: number, length: number, pos: null) => number;
  mock.method(fs, 'fstatSync', (fd: number) => {
    fstats.push(fd);
    const real = realFstat(fd);
    return fstatFake === undefined ? real : fstatFake(fd, real);
  });
  mock.method(fs, 'readSync', (fd: number, buf: Buffer, offset: number, length: number, pos: null) => {
    reads.push({ fd, length });
    const fake = readFake?.(fd, buf, offset, length);
    return fake === undefined || fake === 'real' ? realRead(fd, buf, offset, length, pos) : fake;
  });
  syncBuiltinESMExports();
  try {
    host.write(id, '\n');
    const exited = await waitUntil(() => record, `pty ${id} to exit`, 15_000, 20);
    return { chunks, record: exited, lines, fstats, reads };
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    host.kill(id, 'now');
    host.forget(id);
  }
}

/** A Stats that answers like `real` except for the fields given. */
function statsLike(real: fs.Stats, over: { char?: boolean; rdev?: number; ino?: number }): fs.Stats {
  return Object.assign(Object.create(Object.getPrototypeOf(real) as object) as fs.Stats, real, {
    rdev: over.rdev ?? real.rdev,
    ino: over.ino ?? real.ino,
    isCharacterDevice: () => over.char ?? real.isCharacterDevice(),
  });
}

test('the drain reads the master fd at exit when it is still the pty master it was at spawn', async () => {
  const run = await runWithFakes('printf done', undefined, undefined);
  assert.equal(run.record.code, 0);
  assert.ok(run.fstats.length > 0, 'the drain checked the fd before reading');
  const master = run.fstats[0] as number;
  assert.ok(
    run.reads.some((r) => r.fd === master),
    `the drain read the master fd ${master}; reads: ${JSON.stringify(run.reads)}`,
  );
  assert.ok(
    run.reads.filter((r) => r.fd === master).every((r) => r.length === DRAIN_CHUNK_BYTES),
    'each read asks for a whole 64 KiB buffer',
  );
});

test('the drain never reads an fd that is no longer this pty master: not a device, another device, another node', async () => {
  const cases: [string, (real: fs.Stats) => fs.Stats][] = [
    ['a regular file now (same rdev and ino)', (real) => statsLike(real, { char: false })],
    ['a character device with another rdev', (real) => statsLike(real, { rdev: real.rdev + 1 })],
    ['a character device with another inode', (real) => statsLike(real, { ino: real.ino + 1 })],
  ];
  for (const [what, fake] of cases) {
    const run = await runWithFakes('printf done', (_fd, real) => fake(real), undefined);
    assert.ok(run.fstats.length > 0, `${what}: the drain checked the fd`);
    const master = run.fstats[0] as number;
    assert.deepEqual(
      run.reads.filter((r) => r.fd === master),
      [],
      `${what}: a recycled fd number is never read into the scrollback`,
    );
    assert.equal(run.record.code, 0, `${what}: the exit is still reported`);
  }
});

test('a master that keeps producing stops the drain at its read bound, and the truncation is logged', async () => {
  let master = -1;
  const run = await runWithFakes(
    'printf done',
    (fd, real) => {
      master = fd;
      return real;
    },
    (fd, buf, offset) => {
      if (fd !== master) return 'real';
      buf.write('x', offset, 'latin1');
      return 1;
    },
  );
  const drained = run.reads.filter((r) => r.fd === master);
  assert.equal(drained.length, DRAIN_MAX_READS, 'exactly the bound, never more');
  assert.ok(run.chunks.join('').endsWith('x'.repeat(DRAIN_MAX_READS)), 'what was read is delivered');
  assert.ok(
    run.lines.some((l) =>
      l.startsWith(`warn pty final-output rescue stopped at its ${DRAIN_MAX_READS}-read bound (${DRAIN_MAX_READS * DRAIN_CHUNK_BYTES} bytes)`),
    ),
    `the truncation is said; log:\n${run.lines.join('\n')}`,
  );
});

test('a drain that reads nothing ends at once, emits nothing and warns nothing', async () => {
  let master = -1;
  const run = await runWithFakes(
    'printf done',
    (fd, real) => {
      master = fd;
      return real;
    },
    (fd) => (fd === master ? 0 : 'real'),
  );
  assert.equal(run.reads.filter((r) => r.fd === master).length, 1, 'one read answering 0 bytes ends the drain');
  assert.equal(run.chunks.some((c) => c === ''), false, 'no empty output event');
  assert.equal(run.lines.some((l) => l.includes('read bound')), false, `no truncation warning; log:\n${run.lines.join('\n')}`);
});

test('a drain that ends inside a multi-byte character still delivers what it read, the cut glyph flushed', async () => {
  let master = -1;
  let served = 0;
  const glyph = Buffer.from('✳', 'utf8');
  const run = await runWithFakes(
    'printf done',
    (fd, real) => {
      master = fd;
      return real;
    },
    (fd, buf, offset) => {
      if (fd !== master) return 'real';
      served += 1;
      // 'Z', then the first two of the glyph's three bytes on their own (a read
      // that decodes to nothing yet), then empty: the kernel's last bytes end
      // mid-character.
      if (served === 1) return Buffer.from('Z').copy(buf, offset);
      if (served === 2) return glyph.subarray(0, 2).copy(buf, offset);
      return 0;
    },
  );
  assert.equal(run.chunks.some((c) => c === ''), false, 'a read that decodes to nothing yet emits no empty event');
  const text = run.chunks.join('');
  assert.ok(text.endsWith('Z�'), `the decoder's remainder is flushed, not dropped; tail ${JSON.stringify(text.slice(-8))}`);
});

test('an owner whose output path throws on a rescued chunk still gets the exit, and the failure is logged', async () => {
  let master = -1;
  let served = false;
  const run = await runWithFakes(
    'printf done',
    (fd, real) => {
      master = fd;
      return real;
    },
    (fd, buf, offset) => {
      if (fd !== master) return 'real';
      if (served) return 0;
      served = true;
      return Buffer.from('RESCUED').copy(buf, offset);
    },
    'RESCUED',
  );
  assert.ok(run.chunks.some((c) => c.includes('RESCUED')), 'the rescued chunk reached the owner');
  assert.equal(run.record.code, 0, 'the exit is reported although the rescue threw: the fd was closed');
  assert.ok(
    run.lines.some((l) => l.startsWith('warn pty final-output rescue failed: Error: owner output path failed')),
    `the swallowed failure is logged; log:\n${run.lines.join('\n')}`,
  );
});
