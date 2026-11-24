/**
 * The previous run's end, as pure rules — server/previous-exit-model.ts,
 * PLAN-QUALITY Q17 P1 (`.claude/plans/quality/PLAN-Q17.md` § P1 — backend,
 * § Test gate): the exit record's parse, the verdict at boot (record vs
 * crash stamps), the VM-reboot question, the journal's OOM line and the
 * cause.
 *
 * How: the functions are imported and called with fixed inputs — no clock,
 * no /proc, no `journalctl`.
 *
 * Why it matters: a wrong branch either shows "WSL ran out of memory" after a
 * plain restart, or stays silent after the VM went down with three sessions;
 * a hostile process name must never reach the notice or the log unclean.
 *
 * NOT claimed: the file I/O, the real journal runner and the routes —
 * `previous-exit-store.test.ts` and `previous-exit-routes.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  causeOf,
  judgeExit,
  parseBootId,
  parseBtimeMs,
  parseExitRecord,
  parseOomKills,
  pickOomKill,
  sanitiseComm,
  verdictLine,
  vmRebooted,
  type ExitRecord,
} from '../../server/previous-exit-model.ts';

const BOOT_A = '11111111-2222-4333-8444-555555555555';
const BOOT_B = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';
const H1 = '11111111-2222-3333-4444-555555555555';
const H2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** A record the incident would have written: SIGTERM with one window open. */
function signalled(over: Partial<ExitRecord> = {}): ExitRecord {
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

/** The kernel's own line, from the 2026-11-24 journal (pid and host anonymised). */
const INCIDENT_LINE =
  '2026-11-24T12:53:41+01:00 host kernel: Out of memory: Killed process 46783 (python) ' +
  'total-vm:3720416kB, anon-rss:2796156kB, file-rss:804kB, shmem-rss:0kB, UID:1000 pgtables:6200kB oom_score_adj:0';

test('a record the backend wrote parses back to the same record', () => {
  const record = signalled();
  assert.deepEqual(parseExitRecord(JSON.stringify(record)), record);
  const seen = signalled({ seen: true });
  assert.deepEqual(parseExitRecord(JSON.stringify(seen)), seen);
});

test('a record without its optional fields parses, and duplicate ids are kept once', () => {
  const bare = { at: '2026-11-24T11:53:47.000Z', startedAt: '2026-11-24T08:00:00.000Z', why: 'presence-grace', presence: 0, sessions: [H1, H1] };
  assert.deepEqual(parseExitRecord(JSON.stringify(bare)), { ...bare, sessions: [H1] });
});

test('every malformed record is refused, never thrown', () => {
  const good = signalled() as unknown as Record<string, unknown>;
  const cases: Array<[string, string]> = [
    ['not JSON', '{ nope'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a bad time', JSON.stringify({ ...good, at: 'yesterday' })],
    ['no startedAt', JSON.stringify({ ...good, startedAt: undefined })],
    ['an unknown why', JSON.stringify({ ...good, why: 'oom' })],
    ['an unknown signal', JSON.stringify({ ...good, signal: 'SIGKILL' })],
    ['a fractional presence', JSON.stringify({ ...good, presence: 1.5 })],
    ['a negative presence', JSON.stringify({ ...good, presence: -1 })],
    ['sessions not an array', JSON.stringify({ ...good, sessions: H1 })],
    ['a session id with a slash', JSON.stringify({ ...good, sessions: ['../../etc'] })],
    ['a session id with a newline', JSON.stringify({ ...good, sessions: ['a\nb'] })],
    ['too many sessions', JSON.stringify({ ...good, sessions: Array.from({ length: 1001 }, (_, i) => `id${i}`) })],
    ['a bad boot id', JSON.stringify({ ...good, bootId: 'not-a-boot' })],
    ['a string seen', JSON.stringify({ ...good, seen: 'yes' })],
  ];
  for (const [what, text] of cases) assert.equal(parseExitRecord(text), undefined, what);
});

// Test gate 2026-11-24: each row is one bound of the parse (the id length,
// the anchors, the presence ceiling, the time's length) that the table above
// left open — a mutant widening any of them passed the suite.
test('a record past a bound is refused: id length, unanchored ids, presence, a long time', () => {
  const good = signalled() as unknown as Record<string, unknown>;
  const cases: Array<[string, string]> = [
    ['a 129-char session id', JSON.stringify({ ...good, sessions: ['a'.repeat(129)] })],
    ['a boot id with a prefix', JSON.stringify({ ...good, bootId: `x${BOOT_A}` })],
    ['a boot id with a suffix', JSON.stringify({ ...good, bootId: `${BOOT_A}x` })],
    ['a presence past 1 000 000', JSON.stringify({ ...good, presence: 1_000_001 })],
    // Date.parse reads this one (V8 skips a parenthesised comment), so only
    // the 64-char cap refuses it.
    ['a 116-char time', JSON.stringify({ ...good, at: `Tue Nov 24 2026 11:53:47 GMT+0000 (${'x'.repeat(80)})` })],
  ];
  for (const [what, text] of cases) assert.equal(parseExitRecord(text), undefined, what);
  assert.deepEqual(
    parseExitRecord(JSON.stringify({ ...good, sessions: ['a'.repeat(128)], presence: 1_000_000 }))?.sessions,
    ['a'.repeat(128)],
    'the bounds themselves still parse',
  );
});

test('a signal with a window open is the verdict; its sessions are the record\'s', () => {
  const record = signalled();
  assert.deepEqual(judgeExit(record, [], '2026-11-24T12:00:00.000Z'), { kind: 'record', record });
});

test('a presence-grace stop, a restart, other, a signal with no window and a seen record tell nothing', () => {
  for (const record of [
    signalled({ why: 'presence-grace', signal: undefined }),
    signalled({ why: 'restart', signal: undefined }),
    signalled({ why: 'other', signal: undefined }),
    signalled({ presence: 0 }),
    signalled({ seen: true }),
  ]) {
    assert.deepEqual(judgeExit(record, [], 'x'), { kind: 'none' }, JSON.stringify(record));
  }
});

test('no record and sessions stamped crash at this boot is a crash, with their ids and the given time', () => {
  const crashed = [{ id: H1, lastUsedAt: '2026-11-24T10:00:00.000Z' }];
  assert.deepEqual(judgeExit(undefined, crashed, '2026-11-24T10:30:00.000Z'), {
    kind: 'crash',
    at: '2026-11-24T10:30:00.000Z',
    sessions: [H1],
  });
  assert.deepEqual(judgeExit(undefined, [], 'x'), { kind: 'none' }, 'no record, no stamps: nothing');
});

test('a crash stamp on a session launched AFTER the record means a later run died hard: crash wins', () => {
  const crashed = [{ id: H2, lastUsedAt: '2026-11-24T13:00:00.000Z' }];
  assert.equal(judgeExit(signalled(), crashed, 'x').kind, 'crash');
  assert.equal(judgeExit(signalled({ why: 'restart' }), crashed, 'x').kind, 'crash', 'a restart record never hides a crash');
});

test('a crash stamp on a session launched BEFORE the signal record keeps the record verdict', () => {
  // The VM went down between the record and the history's 'shutdown' stamp.
  const crashed = [{ id: H1, lastUsedAt: '2026-11-24T09:00:00.000Z' }];
  assert.equal(judgeExit(signalled(), crashed, 'x').kind, 'record');
});

test('the boot ids decide a reboot when both are known; the clock is not asked', () => {
  const record = signalled();
  assert.equal(vmRebooted(record, { bootId: BOOT_B, btimeMs: 0 }), true, 'a new boot id');
  assert.equal(vmRebooted(record, { bootId: BOOT_A, btimeMs: Date.parse(record.at) + 60_000 }), false, 'the same boot id, a clock stepped forward');
});

test('without a boot id the btime decides: after the exit is a reboot, before it the same boot', () => {
  const record = signalled({ bootId: undefined });
  const at = Date.parse(record.at);
  assert.equal(vmRebooted(record, { bootId: BOOT_A, btimeMs: at + 1000 }), true);
  assert.equal(vmRebooted(record, { bootId: BOOT_A, btimeMs: at - 1000 }), false);
  assert.equal(vmRebooted(signalled(), { bootId: undefined, btimeMs: at + 1000 }), true, 'no current boot id: btime');
  assert.equal(vmRebooted(record, { bootId: undefined, btimeMs: undefined }), false, 'nothing known: the same boot');
});

test('the /proc readers take a boot id and a btime, and refuse anything else', () => {
  assert.equal(parseBootId(`${BOOT_A}\n`), BOOT_A);
  assert.equal(parseBootId('nonsense\n'), undefined);
  assert.equal(parseBtimeMs('cpu  1 2 3\nintr 9\nbtime 1795521676\nprocesses 5\n'), 1795521676000);
  assert.equal(parseBtimeMs('cpu  1 2 3\n'), undefined);
});

test('the incident\'s kernel line gives the process, its rss in MB and the time', () => {
  assert.deepEqual(parseOomKills(`${INCIDENT_LINE}\n`), [
    { atMs: Date.parse('2026-11-24T11:53:41Z'), process: 'python', rssMb: 2731 },
  ]);
});

test('older systemd offsets (+0100), UTC and fractional seconds parse to the same instant', () => {
  const rest = ' host kernel: Out of memory: Killed process 1 (node) total-vm:1kB, anon-rss:1024kB, file-rss:0kB';
  const at = Date.parse('2026-11-24T11:53:41Z');
  assert.equal(parseOomKills(`2026-11-24T12:53:41+0100${rest}`)[0]?.atMs, at, '+0100');
  assert.equal(parseOomKills(`2026-11-24T11:53:41Z${rest}`)[0]?.atMs, at, 'Z');
  assert.equal(parseOomKills(`2026-11-24T12:53:41,000+01:00${rest}`)[0]?.atMs, at, 'comma fraction');
});

test('lines that are not an OOM kill are skipped: a hint, a blank line, a truncated tail', () => {
  const text = [
    '-- No entries --',
    '',
    'Hint: You are currently not seeing messages from other users and the system.',
    '2026-11-24T12:53:41+01:00 host kernel: Out of memory: Killed process 46783 (python) total-vm:37',
  ].join('\n');
  assert.deepEqual(parseOomKills(text), []);
});

test('a hostile process name cannot forge the size, and is cleaned to [A-Za-z0-9._-]', () => {
  const line =
    '2026-11-24T12:53:41+01:00 host kernel: Out of memory: Killed process 7 (a) anon-rss:999999999kB (b\u001b[31m) ' +
    'total-vm:1kB, anon-rss:2048kB, file-rss:0kB';
  const [kill] = parseOomKills(line);
  assert.equal(kill?.rssMb, 2, 'the real anon-rss field, not the one inside the name');
  assert.match(kill?.process ?? '', /^[A-Za-z0-9._-]{1,32}$/);
  assert.equal(sanitiseComm('Web Content'), 'Web_Content');
  assert.equal(sanitiseComm('x'.repeat(40)), 'x'.repeat(32));
  assert.equal(sanitiseComm(''), 'unknown');
  assert.equal(sanitiseComm('python3.12'), 'python3.12');
});

test('an OOM line inside [startedAt, at + 60 s] belongs to the exit; outside it does not', () => {
  const record = signalled();
  const at = Date.parse(record.at);
  const kill = (atMs: number, rssMb = 100): { atMs: number; process: string; rssMb: number } => ({ atMs, process: 'p', rssMb });
  assert.deepEqual(pickOomKill([kill(at - 6000)], record.startedAt, record.at), { process: 'p', rssMb: 100 }, 'before the SIGTERM');
  assert.notEqual(pickOomKill([kill(at + 60_000)], record.startedAt, record.at), null, 'at + 60 s still counts');
  assert.equal(pickOomKill([kill(at + 60_001)], record.startedAt, record.at), null, 'past at + 60 s');
  assert.equal(pickOomKill([kill(Date.parse(record.startedAt) - 1000)], record.startedAt, record.at), null, 'before the run started');
  assert.equal(pickOomKill([], record.startedAt, record.at), null, 'no lines');
});

test('an anon-rss of 16 digits or more is no OOM line: the size is never a runaway number', () => {
  const rest = ' host kernel: Out of memory: Killed process 1 (node) total-vm:1kB, anon-rss:';
  assert.equal(parseOomKills(`2026-11-24T11:53:41Z${rest}${'9'.repeat(15)}kB`).length, 1, '15 digits still parse');
  assert.deepEqual(parseOomKills(`2026-11-24T11:53:41Z${rest}${'9'.repeat(16)}kB`), [], '16 digits do not');
});

test('the run\'s start is floored to the second the journal stamps', () => {
  assert.notEqual(
    pickOomKill([{ atMs: Date.parse('2026-11-24T08:00:00.000Z'), process: 'p', rssMb: 1 }], '2026-11-24T08:00:00.700Z', '2026-11-24T09:00:00.000Z'),
    null,
  );
});

test('several OOM lines in the window: the largest anon-rss is the one named', () => {
  const at = Date.parse(signalled().at);
  const kills = [
    { atMs: at - 3000, process: 'small', rssMb: 300 },
    { atMs: at - 2000, process: 'python', rssMb: 2731 },
    { atMs: at - 1000, process: 'mid', rssMb: 900 },
  ];
  assert.deepEqual(pickOomKill(kills, signalled().startedAt, signalled().at), { process: 'python', rssMb: 2731 });
});

test('the cause: same boot is stopped; a reboot with an OOM line is oom, without one wsl-stopped', () => {
  assert.equal(causeOf(false, null), 'stopped');
  assert.equal(causeOf(false, { process: 'p', rssMb: 1 }), 'stopped', 'an OOM line of an older boot does not count');
  assert.equal(causeOf(true, { process: 'p', rssMb: 1 }), 'oom');
  assert.equal(causeOf(true, null), 'wsl-stopped');
});

test('the verdict line names the cause, time, process and count, and nothing else', () => {
  assert.equal(
    verdictLine({ at: '2026-11-24T11:53:47.000Z', cause: 'oom', detail: { process: 'python', rssMb: 2731 }, sessions: 3 }),
    'previous run: oom at 2026-11-24T11:53:47.000Z, killed python (2731 MB); 3 session(s) to resume',
  );
  assert.equal(
    verdictLine({ at: '2026-11-24T11:53:47.000Z', cause: 'crash', detail: null, sessions: 1 }),
    'previous run: crash at 2026-11-24T11:53:47.000Z; 1 session(s) to resume',
  );
  assert.equal(verdictLine(null), 'previous run: nothing to tell');
});
