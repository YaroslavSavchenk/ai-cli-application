/**
 * The session metadata blob and the gap re-scan — server/sessions-meta.ts,
 * Nocturne D9 P3 (`.claude/plans/nocturne/PLAN-D9.md` § Defaults: the
 * backend parks what it must find again in the pty-host, ≤ 16 KiB, and
 * re-scans only `ring[scannedTo..endOffset]` after a restart).
 *
 * How: the pure functions, called directly.
 *
 * Why it matters: a blob a new backend cannot read loses the session; one
 * over the cap would make the spawn itself fail; a cut blob that drops or
 * doubles a permission arg shows an adopted session wrong; a false flag read
 * as set ends a live session (`deleted`) or shows it waiting; a re-scan from
 * the wrong place raises a bell twice, or reads a title's terminator as a
 * bell, and one that writes into the state it was given changes its caller's
 * copy.
 *
 * NOT claimed: when the manager writes the blob (`sessions-adopt.test.ts`),
 * the pty-host storing it (`pty-host-conformance.test.ts`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeSessionMeta,
  parseSessionMeta,
  rescanGap,
  unseenTail,
  type SessionMeta,
} from '../../server/sessions-meta.ts';
import { newOutputScan } from '../../server/sessions-output.ts';

const META: SessionMeta = {
  info: {
    projectId: 'p1',
    title: 'Web UI',
    command: 'claude',
    args: ['--model', 'opus'],
    cwd: '/home/you/projects/web-ui',
    createdAt: '2026-11-21T10:00:00.000Z',
    statusline: true,
  },
  scan: { ...newOutputScan(), inOsc: true, osc: 'title', titleLen: 2, titleIdle: true },
  scannedTo: 12345,
  attention: true,
  pendingSince: '2026-11-21T10:05:00.000Z',
  turnEnded: true,
  titleIdleSince: 1_700_000_000_000,
};

test('a blob reads back exactly as it was written', () => {
  assert.deepEqual(parseSessionMeta(encodeSessionMeta(META) ?? null), META);
});

test('a blob over 16 KiB cuts long args and the title, keeps every flag, and still reads back', () => {
  const big = {
    ...META,
    info: { ...META.info, args: ['--append-system-prompt', 'x'.repeat(20_000), '--model', 'opus'], title: 't'.repeat(40_000) },
  };
  const text = encodeSessionMeta(big);
  assert.ok(text !== undefined && Buffer.byteLength(text) <= 16 * 1024, 'within the cap');
  const back = parseSessionMeta(text ?? null);
  assert.deepEqual(back?.info.args, ['--append-system-prompt', 'x'.repeat(512), '--model', 'opus'], 'the long text cut, the flags kept');
  assert.equal(back?.info.title.length, 256, 'the title was cut');
  assert.equal(back?.info.command, 'claude', 'what a row needs stayed');
});

test('a blob that fits keeps every arg whole: an arg is cut only when the whole blob is over the cap', () => {
  const prompt = 'p'.repeat(2_000);
  const text = encodeSessionMeta({ ...META, info: { ...META.info, args: ['--append-system-prompt', prompt] } });
  assert.ok(text !== undefined && Buffer.byteLength(text) <= 16 * 1024, 'within the cap as it is');
  assert.deepEqual(parseSessionMeta(text ?? null)?.info.args, ['--append-system-prompt', prompt], 'the adopted row keeps the argv it was launched with');
});

test('a blob still over the cap after cutting keeps the permission args, so a bypass session stays one', () => {
  const many = Array.from({ length: 400 }, (_, i) => `--add-dir=/home/you/projects/${'p'.repeat(40)}${i}`);
  for (const perm of [['--dangerously-skip-permissions'], ['--permission-mode', 'bypassPermissions'], ['--permission-mode=bypassPermissions']]) {
    const text = encodeSessionMeta({ ...META, info: { ...META.info, args: [...many, ...perm, ...many] } });
    assert.ok(text !== undefined, `${perm.join(' ')}: a blob`);
    assert.deepEqual(parseSessionMeta(text ?? null)?.info.args, perm, `${perm.join(' ')}: only the permission args, all of them`);
  }
});

test('the permission args kept over the cap are the argv as launched: the value after --permission-mode once, never read as a flag', () => {
  const many = Array.from({ length: 400 }, (_, i) => `--add-dir=/home/you/projects/${'p'.repeat(40)}${i}`);
  // A malformed launch Claude refuses, but its row must still show the argv it had.
  const perm = ['--permission-mode', '--dangerously-skip-permissions'];
  const text = encodeSessionMeta({ ...META, info: { ...META.info, args: [...many, ...perm] } });
  assert.deepEqual(parseSessionMeta(text ?? null)?.info.args, perm, 'the value is taken with its flag and not kept a second time');
});

test('a blob that cannot fit even cut is no blob at all (the spawn must not fail over it)', () => {
  assert.equal(encodeSessionMeta({ ...META, info: { ...META.info, command: 'c'.repeat(20_000) } }), undefined);
});

test('an unreadable blob is refused whole: another version, a bad field, not JSON, none', () => {
  const good = JSON.parse(encodeSessionMeta(META) ?? '{}') as Record<string, unknown>;
  const info = good['info'] as Record<string, unknown>;
  const cases: [string, string | null][] = [
    ['none', null],
    ['not JSON', '{'],
    ['an array', '[]'],
    ['another version', JSON.stringify({ ...good, v: 2 })],
    ['a relative cwd', JSON.stringify({ ...good, info: { ...info, cwd: 'tmp' } })],
    ['an empty command', JSON.stringify({ ...good, info: { ...info, command: '' } })],
    ['args that are not strings', JSON.stringify({ ...good, info: { ...info, args: [1] } })],
    ['a bad createdAt', JSON.stringify({ ...good, info: { ...info, createdAt: 'later' } })],
    ['a negative scannedTo', JSON.stringify({ ...good, scannedTo: -1 })],
    ['an unknown scan state', JSON.stringify({ ...good, scan: { ...newOutputScan(), osc: 'maybe' } })],
    ['a long OSC number', JSON.stringify({ ...good, scan: { ...newOutputScan(), oscNum: '1234' } })],
    ['attention not a boolean', JSON.stringify({ ...good, attention: 'yes' })],
    ['a bad pendingSince', JSON.stringify({ ...good, pendingSince: 'soon' })],
    ['a title that is not a string', JSON.stringify({ ...good, info: { ...info, title: 7 } })],
    ['a projectId that is not a string', JSON.stringify({ ...good, info: { ...info, projectId: 7 } })],
    ['no scan state', JSON.stringify({ ...good, scan: undefined })],
    ['inOsc not a boolean', JSON.stringify({ ...good, scan: { ...newOutputScan(), inOsc: 'no' } })],
    ['a negative titleLen', JSON.stringify({ ...good, scan: { ...newOutputScan(), titleLen: -1 } })],
    ['a fractional scannedTo', JSON.stringify({ ...good, scannedTo: 1.5 })],
    ['a negative titleIdleSince', JSON.stringify({ ...good, titleIdleSince: -5 })],
  ];
  for (const [what, text] of cases) assert.equal(parseSessionMeta(text), undefined, what);
});

test('a flag the blob carries as false never reads back as set: a false deleted still adopts, a false ended turn is no ended turn', () => {
  const good = JSON.parse(encodeSessionMeta(META) ?? '{}') as Record<string, unknown>;
  const back = parseSessionMeta(JSON.stringify({ ...good, deleted: false, turnEnded: false }));
  assert.notEqual(back?.deleted, true, 'deleted: false would end a live session at the next boot');
  assert.notEqual(back?.turnEnded, true, 'turnEnded: false would show a working session as waiting');
});

test('the gap re-scan reads only what follows scannedTo, with the stored state', () => {
  // ring = bytes 100..119 of the stream; the scan stood at 110, inside an OSC
  // title whose BEL terminator is at 112 — a terminator, not a bell.
  const ring = Buffer.from('0123456789ti\x07 then \x07');
  const inTitle = { ...newOutputScan(), inOsc: true, osc: 'title' as const, titleLen: 2, titleIdle: false };
  const found = rescanGap(ring, 100 + ring.byteLength, 110, inTitle);
  assert.deepEqual([found.bell, found.titleIdle, found.overrun], [true, false, false], 'the later BEL rang; the title ended not idle');
  const quiet = rescanGap(ring, 100 + ring.byteLength, 100 + ring.byteLength - 1, newOutputScan());
  assert.equal(quiet.bell, true, 'the last byte alone is still read');
  const none = rescanGap(ring, 100 + ring.byteLength, 100 + ring.byteLength, newOutputScan());
  assert.equal(none.bell, false, 'nothing after scannedTo, nothing found');
});

test('a gap that begins exactly at the ring start keeps the stored state: no overrun, a title terminator stays one', () => {
  // ring = bytes 200..204; the scan stood at 200, inside an OSC title whose
  // BEL terminator is the ring's first byte.
  const ring = Buffer.from('\x07rest');
  const inTitle = { ...newOutputScan(), inOsc: true, osc: 'title' as const, titleLen: 3, titleIdle: false };
  const found = rescanGap(ring, 200 + ring.byteLength, 200, inTitle);
  assert.deepEqual([found.overrun, found.bell], [false, false], 'the whole gap is in the ring, read with the state it began in');
});

test('a gap longer than the ring scans the whole ring from a fresh state and says old bells are lost', () => {
  const ring = Buffer.from('ab\x07cd');
  const midOsc = { ...newOutputScan(), inOsc: true, osc: 'skip' as const };
  const found = rescanGap(ring, 1000, 10, midOsc);
  assert.deepEqual([found.overrun, found.bell], [true, true], 'a stale in-OSC state would have eaten this bell');
});

test('the gap re-scan leaves the stored scan state it was given as it was', () => {
  const stored = { ...newOutputScan(), inOsc: true, osc: 'title' as const, titleLen: 2, titleIdle: false };
  const before = { ...stored };
  const ring = Buffer.from('ti\x07 later');
  const found = rescanGap(ring, ring.byteLength, 0, stored);
  assert.equal(found.scan.inOsc, false, 'the title ended in the gap');
  assert.deepEqual(stored, before, 'the parsed blob is not changed under its reader');
});

test('the mirror takes only the unseen tail of an overlapping chunk, cut on bytes', () => {
  assert.equal(unseenTail(10, Buffer.from('abc'), 10).toString(), 'abc', 'a chunk right at the end is new');
  assert.equal(unseenTail(10, Buffer.from('abc'), 12).toString(), 'abc', 'past the end too (nothing to cut)');
  assert.equal(unseenTail(10, Buffer.from('abc'), 7).toString(), '', 'a chunk the mirror already holds');
  assert.equal(unseenTail(10, Buffer.from('abcd'), 7).toString(), 'd');
  assert.equal(unseenTail(10, Buffer.from('é!'), 8).toString(), '!', 'two UTF-8 bytes of é, then the new one');
});
