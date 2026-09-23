/**
 * `numberOrNull` in `server/git.ts` — how one count of `git diff --numstat` /
 * `git log --numstat` is read, for the Changes tab (`parseNumstatZ`) and the
 * commits list (`server/git-log.ts`). Part Q1, `.claude/plans/PLAN-QUALITY.md`.
 *
 * How: the pure functions called in-process — the rule is a parse, and the
 * numbers git really prints are pinned against a real repository in
 * `tests/server/git-changes.test.ts`.
 *
 * Why it matters: there were two copies. The commits list's was strict
 * (`/^\d{1,12}$/`, a safe integer); the Changes tab's used `parseInt`, which
 * reads `12abc` as 12 and ` 3` as 3 — a count git never wrote, shown as if it
 * had. Q1 kept the strict one for both. No caller relied on the lax parse:
 * both hand it a field cut between two tabs of git's own numstat output,
 * which is a run of digits or `-` and nothing else (the real-repository tests
 * above stay green on the strict parse).
 *
 * NOT claimed: what a future git prints; the real-repository tests say what
 * git 2.43.0 prints today.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numberOrNull, parseNumstatZ } from '../../server/git.ts';

test('a numstat count is a plain run of digits; `-` (binary) is null, never 0', () => {
  assert.equal(numberOrNull('0'), 0);
  assert.equal(numberOrNull('12'), 12);
  assert.equal(numberOrNull('999999999999'), 999_999_999_999, 'twelve digits is the ceiling');
  assert.equal(numberOrNull('-'), null);
});

test('anything git would not print is null, never a number read out of the front of it', () => {
  for (const raw of ['12abc', ' 3', '3 ', '+3', '-3', '1e3', '0x10', '1.5', '', '1234567890123']) {
    assert.equal(numberOrNull(raw), null, JSON.stringify(raw));
  }
});

test('the Changes tab parse leaves a count it cannot believe empty rather than guessing', () => {
  const map = parseNumstatZ('12abc\t3\tweird.txt\u00002\t0\tok.txt\u0000');
  assert.deepEqual(map.get('weird.txt'), { add: null, del: 3 }, 'the lax parse read 12 here');
  assert.deepEqual(map.get('ok.txt'), { add: 2, del: 0 });
});
