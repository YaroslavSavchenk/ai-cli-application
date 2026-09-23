/**
 * The kill ladder's pid seatbelt (server/sessions.ts `signalableChildPid`).
 *
 * `#signalGroup` and `#groupGone` turn a pid into `process.kill(-pid, …)`;
 * the mutation gate of 2026-09-20 could not reach the guard through a real
 * session (pty.pid is always a real child pid), so the predicate is a
 * named export and pinned here: -0 would be the backend's own group, -(-1)
 * is pid 1, and a NaN or a fraction is not a pid at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signalableChildPid } from '../../server/sessions.ts';

test('signalableChildPid: only a plain positive child pid may become a group signal', () => {
  const table: Array<[number, boolean]> = [
    [0, false],
    [1, false],
    [-1, false],
    [-4242, false],
    [Number.NaN, false],
    [1.5, false],
    [Number.POSITIVE_INFINITY, false],
    [2, true],
    [4242, true],
    [4194304, true],
  ];
  for (const [pid, expected] of table) {
    assert.equal(signalableChildPid(pid), expected, `pid ${pid}`);
  }
});
