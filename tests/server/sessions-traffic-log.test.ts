/**
 * A session's traffic summary line — `flushOutputLog` in
 * server/sessions-state.ts (`<id> output N bytes in M chunk(s) over Tms`, the
 * same for input). PLAN-QUALITY Q12: the duration is measured on a MONOTONIC
 * clock. The WSL2 wall clock is stepped back by its resyncs; measured on
 * `Date.now()` a summary once read `over -844ms` (and failed
 * `logging.test.ts`'s `over \d+ms`).
 *
 * How: the function called directly on a fresh session, with `Date.now`
 * mocked to a minute in the past — the wall clock stepping back between the
 * session's start and its summary.
 *
 * NOT claimed: the summary's place in server.log and its byte counts on a real
 * server (`logging.test.ts`, the ws input/output lines).
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { flushOutputLog, newSession } from '../../server/sessions-state.ts';
import { sessionInfo } from '../helpers/session-info.ts';

test('a wall clock stepped back never makes a traffic summary\'s duration negative', () => {
  const session = newSession(sessionInfo(), false);
  session.outBytes = 12;
  session.outChunks = 2;
  session.inBytes = 3;
  session.inFrames = 3;
  const lines: string[] = [];
  const stepped = Date.now() - 60_000;
  const now = mock.method(Date, 'now', () => stepped);
  try {
    flushOutputLog((_level, message) => lines.push(message), 'S1', session, true);
  } finally {
    now.mock.restore();
  }
  assert.equal(lines.length, 2, `one output and one input line: ${JSON.stringify(lines)}`);
  for (const line of lines) {
    const ms = /over (-?\d+)ms$/.exec(line)?.[1];
    assert.ok(ms !== undefined, `a duration in ${line}`);
    assert.ok(Number(ms) >= 0 && Number(ms) < 60_000, `a duration from a monotonic clock, not the stepped wall: ${line}`);
  }
});
