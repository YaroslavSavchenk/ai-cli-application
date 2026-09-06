/**
 * `web/src/log-core.ts` — the client logger's ENGINE: buffering, truncation,
 * batching, and the retry policy that decides what happens when the log
 * endpoint itself misbehaves.
 *
 * This module carries the rules that make "everything gets logged" (user's
 * request, 2026-09-06) safe to switch on:
 *   - the transport's OWN failures are never turned into log entries, and a
 *     failure streak costs exactly ONE console line — otherwise a dead
 *     endpoint feeds itself forever;
 *   - a failed flush keeps only the NEWEST 200 entries, so a backend that is
 *     down for an hour cannot grow the tab's memory;
 *   - `error` does not wait for the 2 s window (a crashing page may not get
 *     another 2 s), while every other level batches;
 *   - a batch never exceeds the route's limits (50 entries / 64 KiB body,
 *     2048-char messages), because the alternative is the server silently
 *     truncating lines we thought we had.
 *
 * Everything the browser supplies is injected (`LoggerDeps`), so the whole
 * policy runs under plain `node --test`: no DOM, no fetch, no real timers —
 * the harness below IS the clock, and every assertion is deterministic.
 * The browser glue that builds the real deps is `web/src/log.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ClientLogger,
  MAX_BATCH_BYTES,
  MAX_BATCH_ENTRIES,
  MAX_BUFFER_ENTRIES,
  MAX_MESSAGE_CHARS,
  RETRY_MAX_MS,
  batchBody,
  byteLength,
  formatError,
  oneLine,
  takeBatch,
  truncate,
  type ClientLogEntry,
  type LogLevel,
  type SendResult,
} from '../web/src/log-core.ts';

// ---------------------------------------------------------------------------
// Harness — a controllable stand-in for the browser
// ---------------------------------------------------------------------------

interface Timer {
  fn: () => void;
  ms: number;
  cancelled: boolean;
}

interface Harness {
  logger: ClientLogger;
  /** Batches handed to send(), oldest first. */
  sent: ClientLogEntry[][];
  /** Batches handed to the unload transport. */
  beacons: ClientLogEntry[][];
  /** Every console mirror: [level, text]. */
  mirrored: [LogLevel, string][];
  /** Transport notices — the ONLY channel a transport failure may use. */
  notices: string[];
  /** Every delay ever scheduled, in order. */
  delays: number[];
  /** Answer the next send()s with this. */
  reply(r: SendResult): void;
  /** Run every armed timer once (the clock ticking), then let promises settle. */
  tick(): Promise<void>;
  /** Let pending promise chains settle without firing a timer. */
  settle(): Promise<void>;
  /** Timers armed and not cancelled — "is anything still ticking?". */
  pending(): number;
}

function harness(): Harness {
  const sent: ClientLogEntry[][] = [];
  const beacons: ClientLogEntry[][] = [];
  const mirrored: [LogLevel, string][] = [];
  const notices: string[] = [];
  const delays: number[] = [];
  const timers: Timer[] = [];
  let result: SendResult = { ok: true, status: 204 };

  const logger = new ClientLogger({
    nowIso: () => '2026-09-06T12:00:00.000Z',
    send: async (entries) => {
      sent.push([...entries]);
      return result;
    },
    beacon: (entries) => void beacons.push([...entries]),
    schedule: (fn, ms) => {
      const t: Timer = { fn, ms, cancelled: false };
      timers.push(t);
      delays.push(ms);
      return () => {
        t.cancelled = true;
      };
    },
    mirror: (level, message) => void mirrored.push([level, message]),
    notice: (message) => void notices.push(message),
  });

  const settle = async (): Promise<void> => {
    // A flush is a promise chain (send -> decide -> maybe flush again); a few
    // macrotask hops let it finish before assertions look at the results.
    for (let i = 0; i < 8; i++) await delay(0);
  };

  return {
    logger,
    sent,
    beacons,
    mirrored,
    notices,
    delays,
    reply(r) {
      result = r;
    },
    pending() {
      return timers.filter((t) => !t.cancelled).length;
    },
    async tick() {
      const due = timers.splice(0, timers.length).filter((t) => !t.cancelled);
      for (const t of due) t.fn();
      await settle();
    },
    settle,
  };
}

/** `n` distinct entries so a test can tell WHICH ones survived a failure. */
function fill(logger: ClientLogger, n: number, from = 0): void {
  for (let i = from; i < from + n; i++) logger.info(`line ${i}`);
}

const flat = (batches: ClientLogEntry[][]): string[] =>
  batches.flat().map((e) => e.message);

// ---------------------------------------------------------------------------
// Line shaping: one line, 2048 chars, stacks joined with " | "
// ---------------------------------------------------------------------------

test('a message is truncated to 2048 characters, and the cut is marked INSIDE the budget', () => {
  const long = 'x'.repeat(5000);
  const cut = truncate(long);
  assert.equal(cut.length, MAX_MESSAGE_CHARS, 'the server truncates at 2048; so do we');
  assert.ok(cut.endsWith('…'), `a truncated line must say so, got ${cut.slice(-10)}`);
  assert.equal(truncate('short'), 'short', 'a short message is untouched');
  assert.equal(truncate('y'.repeat(2048)).length, 2048, 'exactly at the limit: no cut');
});

test('oneLine: newlines become " | ", control characters and runs of spaces collapse', () => {
  assert.equal(oneLine('a\nb\r\nc\rd'), 'a | b | c | d');
  assert.equal(oneLine('tab\there'), 'tab here');
  assert.equal(oneLine('  padded  \n  more  '), 'padded | more');
  assert.ok(!oneLine('x\ny').includes('\n'), 'nothing may survive as a second line');

  // C1 controls and the Unicode separators, in parity with the server's
  // CONTROL_CHARS: U+0085 NEL is a line break, U+009B a single-byte CSI (an
  // escape sequence with no ESC in front), U+2028/U+2029 end a line for
  // anything that splits on them. All four are stripped BEFORE the wire, so a
  // browser line is not one the server had to repair.
  const forged = 'A\u0085NEL\u009b31mCSI\u2028LS\u2029PS\u0080C1';
  assert.equal(oneLine(forged), 'A NEL 31mCSI LS PS C1');
  assert.ok(
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(oneLine(forged)),
    'not one control character survives into the entry',
  );
});

test('formatError renders a real Error as ONE line with its stack, inside the budget', () => {
  let err: Error;
  try {
    throw new TypeError('boom');
  } catch (e) {
    err = e as Error;
  }
  const line = formatError(err);
  assert.ok(!line.includes('\n'), `a stack must not bring newlines: ${JSON.stringify(line)}`);
  assert.ok(line.includes('TypeError: boom'), `the message must survive: ${line}`);
  assert.ok(line.includes(' | '), 'stack frames are joined with " | "');
  assert.ok(line.length <= MAX_MESSAGE_CHARS);

  // A stack of 5000 frames still fits the budget.
  const huge = new Error('big');
  huge.stack = `Error: big\n${'    at frame (file.ts:1:1)\n'.repeat(500)}`;
  assert.equal(formatError(huge).length, MAX_MESSAGE_CHARS);

  // Non-Error rejections are common (a string, a plain object, undefined).
  assert.equal(formatError('plain string'), 'plain string');
  assert.equal(formatError({ code: 42 }), '{"code":42}');
  assert.equal(formatError(undefined), 'undefined');
});

test('every level is mirrored to the console at ITS OWN level, with the shaped text', async () => {
  const h = harness();
  h.logger.debug('d one');
  h.logger.info('i one');
  h.logger.warn('w one');
  h.logger.error('e\nmultiline');
  await h.settle();

  assert.deepEqual(
    h.mirrored,
    [
      ['debug', 'd one'],
      ['info', 'i one'],
      ['warn', 'w one'],
      ['error', 'e | multiline'],
    ],
    'devtools must see exactly the stream server.log gets',
  );
});

// ---------------------------------------------------------------------------
// Batching and the route's caps
// ---------------------------------------------------------------------------

test('ordinary levels wait for the flush window; nothing is sent before the clock ticks', async () => {
  const h = harness();
  fill(h.logger, 3);
  await h.settle();
  assert.deepEqual(h.sent, [], 'a batching logger must not fire per line');
  assert.equal(h.logger.buffered, 3);

  await h.tick();
  assert.equal(h.sent.length, 1, 'one window = one request');
  assert.deepEqual(flat(h.sent), ['line 0', 'line 1', 'line 2']);
  assert.equal(h.logger.buffered, 0);
});

test('an `error` flushes IMMEDIATELY — a crashing page may never see the next window', async () => {
  const h = harness();
  h.logger.info('before');
  h.logger.error('the crash');
  await h.settle();

  assert.equal(h.sent.length, 1, 'the error did not wait for a tick');
  assert.deepEqual(flat(h.sent), ['before', 'the crash'], 'and it took the buffered line with it');
});

test('a burst is cut into batches of at most 50 entries, and a success drains the rest', async () => {
  const h = harness();
  fill(h.logger, 120);
  await h.settle();

  // A full batch does not wait for the window (a burst is exactly when the
  // window is too slow), and each delivered batch pulls the next one behind
  // it — so a 120-line burst costs three requests and leaves nothing behind.
  assert.deepEqual(
    h.sent.map((b) => b.length),
    [MAX_BATCH_ENTRIES, MAX_BATCH_ENTRIES, 20],
    'batches are capped at 50 and drained in order',
  );
  assert.deepEqual(flat(h.sent), Array.from({ length: 120 }, (_, i) => `line ${i}`));
  assert.equal(h.logger.buffered, 0);
});

test('a batch never exceeds 60 KiB serialized, even when every message is at the 2048 cap', async () => {
  const h = harness();
  const big = 'z'.repeat(MAX_MESSAGE_CHARS);
  for (let i = 0; i < 60; i++) h.logger.info(big);
  await h.settle();
  await h.tick();

  assert.ok(h.sent.length >= 3, `the byte cap must bite before the 50-entry cap, got ${h.sent.length} batches`);
  for (const batch of h.sent) {
    assert.ok(
      byteLength(batchBody(batch)) <= MAX_BATCH_BYTES,
      `a body of ${byteLength(batchBody(batch))} bytes would risk the route's 64 KiB limit`,
    );
    assert.ok(batch.length <= MAX_BATCH_ENTRIES);
  }
});

test('takeBatch always takes at least one entry, so an oversized head cannot wedge the queue', () => {
  const one: ClientLogEntry = {
    level: 'info',
    at: '2026-09-06T12:00:00.000Z',
    message: 'q'.repeat(MAX_MESSAGE_CHARS),
  };
  const buf = [one, { ...one }, { ...one }];
  const batch = takeBatch(buf);
  assert.ok(batch.length >= 1);
  assert.equal(buf.length + batch.length, 3, 'taken entries leave the buffer, exactly once');
});

test('the body is the ClientLogRequest shape and nothing else', async () => {
  const h = harness();
  h.logger.warn('shape check');
  await h.tick();

  const body: unknown = JSON.parse(batchBody(h.sent[0] as ClientLogEntry[]));
  assert.deepEqual(body, {
    entries: [{ level: 'warn', at: '2026-09-06T12:00:00.000Z', message: 'shape check' }],
  });
});

// ---------------------------------------------------------------------------
// Failure: never a loop, never unbounded memory
// ---------------------------------------------------------------------------

test('a failed flush is NOT re-logged: one console notice per streak, zero new entries', async () => {
  const h = harness();
  h.reply({ ok: false, status: 500 });
  h.logger.info('one');
  await h.tick(); // first attempt fails
  await h.tick(); // retry fails
  await h.tick(); // and again

  assert.ok(h.sent.length >= 3, 'it kept trying');
  assert.equal(h.notices.length, 1, `a failure streak costs ONE line, got ${JSON.stringify(h.notices)}`);
  assert.deepEqual(
    h.mirrored.map(([, m]) => m),
    ['one'],
    'the transport failure must never become a log entry (that is the loop)',
  );
  for (const batch of h.sent) {
    assert.deepEqual(batch.map((e) => e.message), ['one'], 'only the real line is ever sent');
  }
});

test('the retry backs off 2s → 4s → 8s → 16s → 30s and stays capped', async () => {
  const h = harness();
  h.reply({ ok: false, status: 503 });
  h.logger.info('x');
  for (let i = 0; i < 7; i++) await h.tick();

  const retries = h.delays.slice(1); // [0] is the initial 2s flush window
  assert.deepEqual(retries.slice(0, 5), [2000, 4000, 8000, 16000, 30000]);
  assert.ok(
    retries.slice(5).every((ms) => ms === RETRY_MAX_MS),
    `the backoff must stay capped at ${RETRY_MAX_MS}, got ${JSON.stringify(retries)}`,
  );
});

test('a failed flush keeps only the NEWEST 200 entries; a success then delivers exactly those', async () => {
  const h = harness();
  h.reply({ ok: false, status: 0 }); // network down
  fill(h.logger, 300);
  await h.tick();
  await h.settle();

  assert.equal(h.logger.buffered, MAX_BUFFER_ENTRIES, 'memory is bounded while the backend is gone');
  assert.ok(h.logger.dropped > 0, 'and the overflow is accounted for');

  h.reply({ ok: true, status: 204 });
  h.sent.length = 0;
  await h.tick();

  const delivered = flat(h.sent);
  assert.equal(delivered.length, MAX_BUFFER_ENTRIES);
  assert.equal(delivered[0], 'line 100', 'the OLDEST lines are the ones dropped');
  assert.equal(delivered[delivered.length - 1], 'line 299', 'the newest line always survives');
  assert.equal(h.logger.buffered, 0);
});

test('a 404 (a backend without the route) switches logging off for good — one notice, no retry', async () => {
  const h = harness();
  h.reply({ ok: false, status: 404 });
  h.logger.info('to the void');
  await h.tick();

  assert.equal(h.sent.length, 1, 'exactly one attempt');
  assert.equal(h.logger.off, true);
  assert.equal(h.logger.buffered, 0, 'nothing is held for a route that does not exist');
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0] as string, /404/);

  const attempts = h.sent.length;
  const scheduled = h.delays.length;
  h.logger.error('later, still nothing');
  await h.tick();
  await h.tick();
  assert.equal(h.sent.length, attempts, 'a disabled transport never fires again');
  assert.equal(h.delays.length, scheduled, 'and never arms another timer');
  assert.deepEqual(
    h.mirrored.map(([, m]) => m),
    ['to the void', 'later, still nothing'],
    'but the console keeps every line',
  );
});

test('a 401/403 (rotated token) is treated the same — the page is already being taken over', async () => {
  for (const status of [401, 403]) {
    const h = harness();
    h.reply({ ok: false, status });
    h.logger.info('after a restart');
    await h.tick();
    assert.equal(h.logger.off, true, `status ${status} must not be retried forever`);
  }
});

test('a 413 drops that batch instead of wedging every later line behind it', async () => {
  const h = harness();
  h.reply({ ok: false, status: 413 });
  h.logger.info('poison');
  await h.tick();

  assert.equal(h.logger.buffered, 0, 'the rejected batch is gone, not requeued');
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0] as string, /413/);

  h.reply({ ok: true, status: 204 });
  h.logger.info('the next line still gets through');
  await h.tick();
  assert.deepEqual(flat(h.sent.slice(1)), ['the next line still gets through']);
});

test('a recovered streak notices again on the NEXT failure (the streak, not the process, is the unit)', async () => {
  const h = harness();
  h.reply({ ok: false, status: 500 });
  h.logger.info('a');
  await h.tick();
  assert.equal(h.notices.length, 1);

  h.reply({ ok: true, status: 204 });
  await h.tick();
  assert.equal(h.logger.buffered, 0, 'the held line went out on recovery');

  h.reply({ ok: false, status: 500 });
  h.logger.info('b');
  await h.tick();
  assert.equal(h.notices.length, 2, 'a NEW outage is worth one new line');
});

// ---------------------------------------------------------------------------
// Page death + robustness
// ---------------------------------------------------------------------------

test('flushOnHide hands the buffer to the fire-and-forget transport', async () => {
  const h = harness();
  fill(h.logger, 3);
  h.logger.flushOnHide();

  assert.deepEqual(flat(h.beacons), ['line 0', 'line 1', 'line 2']);
  assert.equal(h.logger.buffered, 0);
  await h.tick();
  assert.deepEqual(h.sent, [], 'the ordinary transport must not re-send what the beacon took');
});

test('the logger never throws, whatever its own dependencies do', () => {
  const logger = new ClientLogger({
    nowIso: () => {
      throw new Error('clock exploded');
    },
    send: async () => {
      throw new Error('send exploded');
    },
    beacon: () => {
      throw new Error('beacon exploded');
    },
    schedule: () => {
      throw new Error('schedule exploded');
    },
    mirror: () => {
      throw new Error('mirror exploded');
    },
    notice: () => {
      throw new Error('notice exploded');
    },
  });

  // A logger that can break its caller is worse than no logger at all.
  assert.doesNotThrow(() => logger.debug('d'));
  assert.doesNotThrow(() => logger.info('i'));
  assert.doesNotThrow(() => logger.warn('w'));
  assert.doesNotThrow(() => logger.error('e'));
  assert.doesNotThrow(() => logger.flushOnHide());
});

test('a send that REJECTS is treated as a network failure, not as a crash', async () => {
  const h = harness();
  const rejecting = new ClientLogger({
    nowIso: () => '2026-09-06T12:00:00.000Z',
    send: () => Promise.reject(new Error('fetch blew up')),
    beacon: () => {},
    schedule: (fn, ms) => {
      h.delays.push(ms);
      return () => {};
    },
    mirror: () => {},
    notice: (m) => void h.notices.push(m),
  });
  rejecting.info('survives');
  await rejecting.flush();

  assert.equal(rejecting.buffered, 1, 'the line is kept for the retry');
  assert.equal(rejecting.off, false);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0] as string, /network/);
});

// ---------------------------------------------------------------------------
// Gaps closed by the test gate (2026-09-06)
// ---------------------------------------------------------------------------

test('flushOnHide is BOUNDED to 4 batches — a pagehide handler must not run long', async () => {
  const h = harness();
  // Messages at the character cap, so the 60 KiB body limit — not the 50-entry
  // limit — decides the batch size and four batches CANNOT drain the buffer.
  // With the entry cap alone (4 x 50 = 200 = the buffer cap) the bound would
  // never be observable.
  // The backend is down, so the buffer really fills instead of draining at the
  // 50-entry auto-flush.
  h.reply({ ok: false, status: 0 });
  const big = 'H'.repeat(MAX_MESSAGE_CHARS);
  for (let i = 0; i < MAX_BUFFER_ENTRIES; i++) h.logger.info(`${i}-${big}`);
  await h.settle();
  assert.equal(h.logger.buffered, MAX_BUFFER_ENTRIES, 'the buffer is full and nothing got through');
  h.sent.length = 0;

  h.logger.flushOnHide();

  assert.equal(h.beacons.length, 4, 'at most four beacons leave on pagehide');
  for (const batch of h.beacons) {
    assert.ok(batch.length > 0 && batch.length <= MAX_BATCH_ENTRIES);
    assert.ok(
      byteLength(batchBody(batch)) <= MAX_BATCH_BYTES,
      'every beacon body respects the route cap',
    );
  }
  assert.ok(
    h.logger.buffered > 0,
    'what did not fit in four batches is left behind rather than looping',
  );
  assert.equal(
    h.beacons.flat().length + h.logger.buffered,
    MAX_BUFFER_ENTRIES,
    'nothing is duplicated and nothing is invented',
  );
  // Oldest first, and in order.
  assert.equal((h.beacons[0] as ClientLogEntry[])[0]?.message.startsWith('0-H'), true);

  await h.tick();
  assert.deepEqual(h.sent, [], 'the ordinary transport does not re-send what the beacon took');
});

test('a 429 requeues the batch to the FRONT, so the retry keeps the original order', async () => {
  const h = harness();
  h.reply({ ok: false, status: 429 });
  fill(h.logger, MAX_BATCH_ENTRIES + 5); // one full batch + 5 stragglers
  await h.tick();

  assert.equal(h.sent.length, 1, 'one attempt, then the backoff');
  assert.equal(
    h.logger.buffered,
    MAX_BATCH_ENTRIES + 5,
    'a rate limit loses nothing — the batch goes back',
  );
  assert.equal(h.notices.length, 1, 'one console line for the streak');
  assert.match(h.notices[0] as string, /429/);

  h.reply({ ok: true, status: 204 });
  h.sent.length = 0;
  await h.tick();

  const delivered = flat(h.sent);
  assert.equal(delivered.length, MAX_BATCH_ENTRIES + 5);
  assert.deepEqual(
    delivered,
    Array.from({ length: MAX_BATCH_ENTRIES + 5 }, (_, i) => `line ${i}`),
    'the requeued batch is delivered BEFORE the lines that arrived after it',
  );
  assert.equal(h.logger.buffered, 0);
});

test('every retryable status requeues; every permanent one switches off', async () => {
  for (const status of [0, 408, 429, 500, 503]) {
    const h = harness();
    h.reply({ ok: false, status });
    h.logger.info('held');
    await h.tick();
    assert.equal(h.logger.off, false, `status ${status} is a transient failure`);
    assert.equal(h.logger.buffered, 1, `status ${status} must keep the line`);
  }
  for (const status of [401, 403, 404, 405, 501]) {
    const h = harness();
    h.reply({ ok: false, status });
    h.logger.info('gone');
    await h.tick();
    assert.equal(h.logger.off, true, `status ${status} must switch logging off for good`);
    assert.equal(h.logger.buffered, 0, `status ${status} must not hold the line`);
  }
});

test('after a permanent status no timer is left armed, and none is ever armed again', async () => {
  const h = harness();
  // A line arms the idle-window timer first — so there IS a timer to leave
  // behind if the disable path forgot to disarm it.
  h.logger.info('arms a timer');
  assert.equal(h.pending(), 1, 'the idle window is armed');

  h.reply({ ok: false, status: 404 });
  await h.tick(); // fires the window, the flush answers 404
  assert.equal(h.logger.off, true);
  assert.equal(h.pending(), 0, 'no timer survives the switch-off — nothing keeps ticking');

  for (const level of ['debug', 'info', 'warn', 'error'] as const) h.logger[level]('after');
  await h.tick();
  assert.equal(h.pending(), 0, 'and a disabled logger never arms another one');
  assert.equal(h.sent.length, 1, 'exactly the one attempt that got the 404');
});

// ---------------------------------------------------------------------------
// The restart gap: delivery is PARKED, never switched off
// ---------------------------------------------------------------------------

test('hold(): a flush timer firing during the restart gap sends NOTHING and leaves the transport on', async () => {
  // The scenario this exists for: `restart confirmed` is logged, which arms the
  // 2 s window; the old backend then dies and its CHILD takes the same port
  // with a FRESH token. That flush would be answered 401 — a PERMANENT status —
  // and this page's log transport would be off for the rest of its life over a
  // restart the user asked for.
  const h = harness();
  h.logger.info('restart confirmed: sessions=2');
  assert.equal(h.pending(), 1, 'the 2 s window is armed');

  h.logger.hold();
  assert.equal(h.logger.held, true);
  assert.equal(h.pending(), 0, 'holding disarms the pending flush');

  // Whatever fires (a timer that escaped, an explicit flush, an `error` line
  // that normally bypasses the window) must not reach the replacement backend.
  h.reply({ ok: false, status: 401 });
  await h.tick();
  h.logger.error('ws presence closed 1012');
  await h.settle();
  await h.logger.flush();
  await h.settle();

  assert.deepEqual(h.sent, [], 'nothing left the page during the gap');
  assert.equal(h.logger.off, false, 'and no 401 could switch logging off');
  assert.deepEqual(h.notices, []);
  assert.equal(h.logger.buffered, 2, 'both lines are still buffered, not dropped');
  assert.equal(h.pending(), 0, 'no timer ticks while held');
});

test('resume(): the gap ends, the buffered lines go out on the normal window', async () => {
  const h = harness();
  h.logger.hold();
  h.logger.info('line during the gap');
  assert.deepEqual(h.sent, []);

  h.logger.resume();
  assert.equal(h.logger.held, false);
  assert.equal(h.pending(), 1, 'resuming re-arms the idle window');
  await h.tick();
  assert.deepEqual(flat(h.sent), ['line during the gap']);

  // resume() on a logger that was never held changes nothing.
  h.logger.resume();
  assert.equal(h.pending(), 0);
});
