/**
 * shared/claude-compat.ts — the Claude Code range this app was tested with
 * and the pure rules that place a version against it (Nocturne D6,
 * `.claude/plans/nocturne/PLAN-D6.md` § Test gate, first bullet).
 *
 * How: the functions imported and called; no server, no I/O.
 *
 * Why it matters: the server's `compat` answer is the only thing the browser
 * reads, so a parse that takes `2.1.10` for older than `2.1.9`, or a garbage
 * line for a version, would put a wrong notice in front of the user — or
 * hide a right one.
 *
 * NOT claimed: what the real `claude --version` prints (the probe tests use
 * a double; tests/server/claude-version.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_SUPPORTED,
  CLAUDE_VERSION_SHAPE,
  claudeCompat,
  compareClaudeVersion,
  parseClaudeVersion,
} from '../../shared/claude-compat.ts';

test('the supported range is 2.1.263 up to the tested 2.1.287', () => {
  assert.deepEqual({ ...CLAUDE_SUPPORTED }, { min: '2.1.263', testedUpTo: '2.1.287' });
});

test('parseClaudeVersion reads the first X.Y.Z token and nothing else', () => {
  const rows: [string, string | null][] = [
    ['2.1.287 (Claude Code)', '2.1.287'],
    ['2.1.287 (Claude Code)\n', '2.1.287'],
    ['Claude Code v2.1.300\n', '2.1.300'],
    ['\n\n  10.20.30 extra 1.2.3', '10.20.30'],
    ['', null],
    ['   \n', null],
    ['error: unknown option --version', null],
    ['2.1', null],
    ['1.2.3.4', null],
    ['2.1.287.', null],
    ['version 2..1.3', null],
    ['1234567890.1.1', null],
  ];
  for (const [stdout, want] of rows) {
    assert.equal(parseClaudeVersion(stdout), want, `parse ${JSON.stringify(stdout)}`);
  }
});

test('compareClaudeVersion is numeric per part: 2.1.9 < 2.1.10, and it is a sort comparator', () => {
  assert.ok(compareClaudeVersion('2.1.9', '2.1.10') < 0, '2.1.9 < 2.1.10');
  assert.ok(compareClaudeVersion('2.1.10', '2.1.9') > 0, '2.1.10 > 2.1.9');
  assert.equal(compareClaudeVersion('2.1.287', '2.1.287'), 0);
  assert.ok(compareClaudeVersion('2.2.0', '2.1.999') > 0, 'minor beats patch');
  assert.ok(compareClaudeVersion('10.0.0', '9.99.99') > 0, 'major beats minor, numerically');
  assert.deepEqual(['2.1.10', '2.1.9', '2.0.300'].sort(compareClaudeVersion), ['2.0.300', '2.1.9', '2.1.10']);
});

test('claudeCompat: every state, at and around both edges of the range', () => {
  const rows: [string | null, boolean, string][] = [
    ['2.1.287', false, 'missing'],
    [null, false, 'missing'],
    [null, true, 'unknown'],
    ['garbage', true, 'unknown'],
    ['2.1.287 (Claude Code)', true, 'unknown'],
    ['2.1.262', true, 'older'],
    ['1.99.999', true, 'older'],
    ['2.1.263', true, 'ok'],
    ['2.1.270', true, 'ok'],
    ['2.1.287', true, 'ok'],
    ['2.1.288', true, 'newer'],
    ['2.2.0', true, 'newer'],
    ['3.0.0', true, 'newer'],
  ];
  for (const [version, found, want] of rows) {
    assert.equal(claudeCompat(version, found), want, `${JSON.stringify(version)} found=${found}`);
  }
});

test('CLAUDE_VERSION_SHAPE is exactly X.Y.Z of digits, at most 29 characters', () => {
  for (const ok of ['2.1.287', '0.0.0', '123456789.123456789.123456789']) {
    assert.ok(CLAUDE_VERSION_SHAPE.test(ok), ok);
  }
  for (const bad of ['v2.1.287', '2.1.287 ', '2.1', '2.1.287-beta', '1234567890.1.1', '', '2.1.287\n']) {
    assert.ok(!CLAUDE_VERSION_SHAPE.test(bad), JSON.stringify(bad));
  }
});
