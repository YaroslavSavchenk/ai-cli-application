/**
 * The slow-client close's log line is budgeted per session — PLAN-QUALITY Q9
 * (`.claude/plans/PLAN-QUALITY.md` § Q9, the security review's loop finding).
 *
 * A live but slow tab under heavy output is closed 1013, reconnects, gets the
 * replay, overflows again and is closed again. Each close used to write an
 * info line, so one session could write a line every reconnect for as long
 * as the output lasted. Now a session writes at most
 * SLOW_CLOSE_LOG_MAX_PER_MINUTE (3) such lines a minute, then one line saying
 * the rest are counted — and a second session has its own budget.
 *
 * How: SessionManager over the recording fake host
 * (tests/helpers/fake-pty-host.ts) and fake sockets whose `bufferedAmount` is
 * already over the 16 MiB cap, so `attach()`'s replay frame trips the close.
 *
 * NOT claimed: the real socket buffers and the 1013 on the wire
 * (`ws-robustness.test.ts`); the browser's backoff after 1013
 * (`tests/ui/ui-ws-slow-close.test.ts`).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { removeTempDir } from '../helpers/helpers.ts';
import { fakeHostManager, fakePtyHost } from '../helpers/fake-pty-host.ts';

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await removeTempDir(d);
});

/** A socket that is open, already 20 MiB behind, and records its close code. */
function slowSocket(closes: number[]): WebSocket {
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 20 * 1024 * 1024,
    send: () => {},
    on: () => {},
    close: (code: number) => {
      closes.push(code);
      ws.readyState = 2;
    },
  };
  return ws as unknown as WebSocket;
}

test('a session writes at most 3 slow-client close lines a minute, then says the rest are counted', async () => {
  const lines: string[] = [];
  const { sessions } = await fakeHostManager(fakePtyHost(), dirs, (_level, msg) => lines.push(msg));
  const a = await sessions.create({ cwd: '/', command: 'bash', args: [], cols: 80, rows: 24 });
  const b = await sessions.create({ cwd: '/', command: 'bash', args: [], cols: 80, rows: 24 });
  const closes: number[] = [];
  for (let i = 0; i < 6; i += 1) sessions.attach(a.id, slowSocket(closes));
  sessions.attach(b.id, slowSocket(closes));

  assert.deepEqual(closes, [1013, 1013, 1013, 1013, 1013, 1013, 1013], 'every slow client is still closed');
  const closedA = lines.filter((l) => l.includes(`${a.id} client closed`));
  assert.equal(closedA.length, 3, 'session A: 3 lines, not one per reconnect');
  const counted = lines.filter((l) => l.includes(`${a.id} slow-client closes past 3 per minute`));
  assert.equal(counted.length, 1, 'session A: one line says the rest are counted');
  const closedB = lines.filter((l) => l.includes(`${b.id} client closed`));
  assert.equal(closedB.length, 1, 'session B has its own budget');
});
