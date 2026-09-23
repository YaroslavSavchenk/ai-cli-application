/**
 * The poll summary (Quality P4, `.claude/plans/PLAN-QUALITY.md` § The decision
 * that started it, item 5): a successful poll of `GET /api/sessions`,
 * `/api/runtime`, `/api/prefs`, `/api/update/status` or `POST /api/client-log`
 * is counted, and `server/poll-log.ts` writes ONE `debug` summary line a
 * minute; a failed or slow poll, and every other request, keeps its own
 * access line.
 *
 * How: the rule (`isQuietPoll`) and the counter (`PollTally`) in-process with
 * a fake logger, an injected clock and a timer seam fired by hand — a real
 * minute is not waited; then the production request handler mounted
 * in-process (`withInProcessApi`, helpers/logging-fixture.ts) on a real HTTP
 * server, because that harness has no update runner, so its
 * `GET /api/update/status` answers a real 503 — the one failing poll that
 * needs no fault injection.
 *
 * Why it matters: the default level is `debug`, so this counter — not a
 * level — is what keeps the idle log at a few lines a minute; and a failure
 * swallowed into a count would hide the one line a reader is looking for.
 *
 * NOT claimed here: the shutdown flush through a real SIGTERM
 * (`tests/server/logging.test.ts`); the browser not shipping its own line
 * (`tests/ui/ui-api-log.test.ts`); the idle volume with a real page (measured
 * by hand, recorded in the P4 landing).
 */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { LogLevel } from '../../server/config.ts';
import {
  isQuietPoll,
  PollTally,
  POLL_SUMMARY_MS,
  SLOW_POLL_MS,
} from '../../server/poll-log.ts';
import { rawRequest, waitUntil } from '../helpers/helpers.ts';
import { withInProcessApi } from '../helpers/logging-fixture.ts';

/** A PollTally on a fake log, a clock the test moves and a timer it fires. */
function makeTally(): {
  tally: PollTally;
  lines: [LogLevel, string][];
  advance: (ms: number) => void;
  tick: () => void;
  timer: { ms: number; cancelled: boolean };
} {
  const lines: [LogLevel, string][] = [];
  let clock = 1_000_000;
  let fire: () => void = () => undefined;
  const timer = { ms: 0, cancelled: false };
  const tally = new PollTally({
    log: (level, message) => lines.push([level, message]),
    now: () => clock,
    every: (fn, ms) => {
      fire = fn;
      timer.ms = ms;
      return () => {
        timer.cancelled = true;
      };
    },
  });
  return {
    tally,
    lines,
    advance: (ms) => {
      clock += ms;
    },
    tick: () => fire(),
    timer,
  };
}

test('isQuietPoll: only a prompt 2xx of the five polled routes is counted', () => {
  const rows: [string, string, number, number, boolean][] = [
    ['GET', '/api/sessions', 200, 3, true],
    ['GET', '/api/runtime', 200, 3, true],
    ['GET', '/api/prefs', 200, 3, true],
    ['GET', '/api/update/status', 200, 3, true],
    ['POST', '/api/client-log', 204, 3, true],
    // A failure is the diagnostic: never counted.
    ['GET', '/api/sessions', 500, 3, false],
    ['GET', '/api/update/status', 503, 3, false],
    ['POST', '/api/client-log', 400, 3, false],
    ['GET', '/api/sessions', 401, 3, false],
    ['GET', '/api/sessions', 304, 3, false],
    // An aborted response (status 0) is not a success.
    ['GET', '/api/sessions', 0, 3, false],
    // A slow success is a diagnostic too.
    ['GET', '/api/sessions', 200, SLOW_POLL_MS, false],
    ['GET', '/api/sessions', 200, SLOW_POLL_MS - 1, true],
    // Same path, another method: a launch, a prefs save — never a poll.
    ['POST', '/api/sessions', 201, 3, false],
    ['PUT', '/api/prefs', 200, 3, false],
    ['GET', '/api/client-log', 200, 3, false],
    // Other routes, including the other 5 s polls (they keep their debug line).
    ['GET', '/api/history', 200, 3, false],
    ['GET', '/api/git/changes', 200, 3, false],
    ['GET', '/api/sessions/abc', 200, 3, false],
  ];
  for (const [method, route, status, ms, want] of rows) {
    assert.equal(isQuietPoll(method, route, status, ms), want, `${method} ${route} ${status} in ${ms}ms`);
  }
});

test('the summary line: debug, window length, route + status + count in first-seen order', () => {
  const t = makeTally();
  assert.equal(t.timer.ms, POLL_SUMMARY_MS, 'the timer runs once a minute');
  for (let i = 0; i < 20; i += 1) t.tally.count('GET', '/api/sessions', 200);
  t.tally.count('GET', '/api/runtime', 200);
  t.tally.count('GET', '/api/runtime', 200);
  t.tally.count('POST', '/api/client-log', 204);
  assert.deepEqual(t.lines, [], 'nothing is written per poll');
  t.advance(POLL_SUMMARY_MS);
  t.tick();
  assert.deepEqual(t.lines, [
    [
      'debug',
      'polls last 60s: GET /api/sessions 200 ×20, GET /api/runtime 200 ×2, POST /api/client-log 204 ×1',
    ],
  ]);
});

test('the counter restarts every window: the next line counts only its own minute', () => {
  const t = makeTally();
  t.tally.count('GET', '/api/sessions', 200);
  t.tally.count('GET', '/api/sessions', 200);
  t.advance(POLL_SUMMARY_MS);
  t.tick();
  t.tally.count('GET', '/api/prefs', 200);
  t.advance(POLL_SUMMARY_MS);
  t.tick();
  assert.deepEqual(
    t.lines.map(([, m]) => m),
    ['polls last 60s: GET /api/sessions 200 ×2', 'polls last 60s: GET /api/prefs 200 ×1'],
  );
});

test('a window without a poll writes nothing — and still restarts the window', () => {
  const t = makeTally();
  t.advance(POLL_SUMMARY_MS);
  t.tick();
  t.advance(POLL_SUMMARY_MS);
  t.tick();
  assert.equal(t.lines.length, 0, 'an idle minute costs no line');
  t.tally.count('GET', '/api/sessions', 200);
  t.advance(POLL_SUMMARY_MS);
  t.tick();
  assert.deepEqual(t.lines.map(([, m]) => m), ['polls last 60s: GET /api/sessions 200 ×1']);
});

test('stop() writes the partial window with its real length, cancels the timer, and is idempotent', () => {
  const t = makeTally();
  t.tally.count('GET', '/api/sessions', 200);
  t.advance(23_400);
  t.tally.stop();
  assert.deepEqual(t.lines, [['debug', 'polls last 23s: GET /api/sessions 200 ×1']]);
  assert.equal(t.timer.cancelled, true, 'the timer is stopped on shutdown');
  t.tally.stop();
  assert.equal(t.lines.length, 1, 'a second stop writes nothing more');
});

test('the default timer is unref\'d: a PollTally never holds the process open', () => {
  // A spy on setInterval, because "does not hold the process" has no other
  // observable in-process: the handle it returns is asked for its ref state.
  const realSetInterval = globalThis.setInterval;
  const handles: NodeJS.Timeout[] = [];
  const spy = mock.method(globalThis, 'setInterval', (fn: () => void, ms: number) => {
    const handle = realSetInterval(fn, ms);
    handles.push(handle);
    return handle;
  });
  try {
    const lines: string[] = [];
    const tally = new PollTally({ log: (_level, message) => lines.push(message) });
    assert.equal(handles.length, 1, 'one interval per counter');
    assert.equal(spy.mock.calls[0]?.arguments[1], POLL_SUMMARY_MS);
    assert.equal(handles[0]?.hasRef(), false, 'the interval is unref\'d');
    tally.count('GET', '/api/sessions', 200);
    tally.stop();
    assert.match(lines[0] ?? '', /^polls last 0s: GET \/api\/sessions 200 ×1$/);
  } finally {
    spy.mock.restore();
    for (const handle of handles) clearInterval(handle);
  }
});

test('through the real handler: a 200 poll is counted, a 503 poll and a non-poll are written at once', async () => {
  let tick: () => void = () => undefined;
  await withInProcessApi(
    async (ctx) => {
      const get = (path: string) =>
        rawRequest(ctx.port, { path, headers: { 'x-auth-token': ctx.token } });
      assert.equal((await get('/api/sessions')).status, 200);
      assert.equal((await get('/api/prefs')).status, 200);
      // This harness has no update runner: the poll answers a real 503.
      assert.equal((await get('/api/update/status')).status, 503);
      assert.equal((await get('/api/history')).status, 200);

      const log = await waitUntil(() => {
        const text = ctx.readLog();
        return text.includes('[http] GET /api/history -> 200') ? text : undefined;
      }, 'the non-poll access line');
      assert.match(
        log,
        /\[error\] \[http\] GET \/api\/update\/status -> 503 in \d+\.\dms \(\d+ B\) reason="/,
        'a failed poll keeps its immediate line at the old level, with its reason',
      );
      assert.match(log, /\[info\] \[http\] GET \/api\/history -> 200/, 'a non-poll 200 is unchanged');
      assert.ok(!log.includes('[http] GET /api/sessions ->'), 'no per-request line for a 200 poll');
      assert.ok(!log.includes('[http] GET /api/prefs ->'), 'no per-request line for a 200 poll');
      assert.ok(!log.includes('polls last'), 'no summary before the window ends');

      tick();
      assert.match(
        ctx.readLog(),
        /\[debug\] \[http\] polls last \d+s: GET \/api\/sessions 200 ×1, GET \/api\/prefs 200 ×1\n/,
        'the window closes into one line; the failed poll is not in it',
      );
    },
    (log, now) =>
      new PollTally({
        log,
        now,
        every: (fn) => {
          tick = fn;
          return () => undefined;
        },
      }),
  );
});
