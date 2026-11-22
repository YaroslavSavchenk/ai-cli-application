/**
 * The session socket under the Q9 server caps — PLAN-QUALITY Q9
 * (`.claude/plans/PLAN-QUALITY.md` § Q9, the security review's findings).
 *
 * Two client-side rules in `web/src/ws.ts`:
 *   - a close with SLOW_CLIENT_CLOSE_CODE (1013, the server's "client too
 *     slow") makes the next reconnect wait the longest backoff, and opening
 *     again does not reset it — a slow tab under heavy output no longer loops
 *     close -> replay -> close every half second. Any other close of a socket
 *     that had opened still retries after the shortest backoff, as before;
 *   - `sendInput` splits a paste into `input` frames of at most 1 Mi UTF-16
 *     units, never between a surrogate pair's halves, so no frame reaches the
 *     server's 16 MiB cap (where the paste was lost) and the frames joined
 *     are the paste.
 *
 * How: ws.ts runs for real with fakes for `WebSocket`, `location`, `window`
 * and `fetch` (the idiom of `tests/ui/ui-ws-exit-early.test.ts`); the
 * liveness check's GET /api/sessions answers that the session lives, and
 * `window.setTimeout` records the reconnect delays without running them.
 *
 * NOT claimed: the server side of either cap (`tests/server/ws-robustness.test.ts`,
 * `tests/server/sessions-slow-client.test.ts`); a real browser's paste
 * (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    created.push(this);
  }
  send(text: string): void {
    this.sent.push(text);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  drop(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason: '', wasClean: code !== 1006 });
  }
}
const created: FakeWebSocket[] = [];
/** Reconnect timers, in the order they were set; `run()` fires the last one. */
const timers: { ms: number; run: () => void }[] = [];

const SESSION = 'sess-q9';
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
(globalThis as unknown as { location: unknown }).location = { protocol: 'http:', host: 'localhost:41234' };
(globalThis as unknown as { window: unknown }).window = {
  __AUTH__: 'test-token',
  setInterval: () => 0,
  setTimeout: (run: () => void, ms: number) => timers.push({ ms, run }),
  addEventListener: () => undefined,
};
(globalThis as unknown as { fetch: unknown }).fetch = async () =>
  new Response(JSON.stringify([{ id: SESSION }]), { status: 200 });
for (const level of ['debug', 'info', 'warn', 'error'] as const) {
  console[level] = (): void => undefined;
}

const ws = await import('../../web/src/ws.ts');

function socket(): InstanceType<typeof ws.SessionSocket> {
  return new ws.SessionSocket(SESSION, {
    onReplay: () => undefined,
    onData: () => undefined,
    onInfo: () => undefined,
    onExit: () => undefined,
    onAttention: () => undefined,
    onConn: () => undefined,
  });
}

/** Close the newest fake with `code`, wait for the liveness check, return the delay it scheduled. */
async function dropAndDelay(code: number): Promise<number> {
  const before = timers.length;
  (created.at(-1) as FakeWebSocket).drop(code);
  for (let i = 0; i < 50 && timers.length === before; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(timers.length, before + 1, 'non-vacuity: a reconnect was scheduled');
  return (timers.at(-1) as { ms: number }).ms;
}

/** Fire the scheduled reconnect and open the socket it made. */
function reconnectAndOpen(): void {
  (timers.at(-1) as { run: () => void }).run();
  (created.at(-1) as FakeWebSocket).open();
}

test('after a 1013 close the reconnect waits the longest backoff, and an open does not reset it', async () => {
  const s = socket();
  (created.at(-1) as FakeWebSocket).open();
  assert.equal(await dropAndDelay(1013), 5000, 'first slow close: the longest backoff');
  reconnectAndOpen();
  assert.equal(await dropAndDelay(1013), 5000, 'second slow close after an open: still the longest');
  s.close();
});

test('any other close of a socket that opened still retries after the shortest backoff', async () => {
  const s = socket();
  (created.at(-1) as FakeWebSocket).open();
  assert.equal(await dropAndDelay(1006), 500, 'a dropped connection: the shortest backoff');
  reconnectAndOpen();
  assert.equal(await dropAndDelay(1013), 5000);
  reconnectAndOpen();
  assert.equal(await dropAndDelay(1006), 500, 'after a slow close, a socket that opened resets on a normal close');
  s.close();
});

test('a 3 Mi-unit paste goes out as frames under the cap whose data joins back to the paste', () => {
  const s = socket();
  const sock = created.at(-1) as FakeWebSocket;
  sock.open();
  const unit = 1024 * 1024;
  // An astral character (two UTF-16 units) straddles the first frame boundary.
  const paste = 'a'.repeat(unit - 1) + '\u{1F600}' + 'b\x1b"'.repeat(unit) + 'é'.repeat(unit - 1);
  s.sendInput(paste);
  const frames = sock.sent.map((t) => JSON.parse(t) as { type: string; data: string });
  assert.ok(frames.length >= 3, `non-vacuity: the paste was split (${frames.length} frames)`);
  assert.equal(frames.map((f) => f.data).join(''), paste, 'the frames joined are the paste');
  for (const [i, f] of frames.entries()) {
    assert.equal(f.type, 'input');
    assert.ok(f.data.length <= unit, `frame ${i}: at most 1 Mi units`);
    assert.ok(Buffer.byteLength(sock.sent[i] ?? '') < 16 * 1024 * 1024, `frame ${i}: under the server's cap`);
    assert.equal(/[\ud800-\udbff]$/.test(f.data), false, `frame ${i} does not end on a lone high surrogate`);
  }
  assert.equal(frames[0]?.data.length, unit - 1, 'the boundary moved back one unit to keep the pair whole');
  s.close();
});

test('a keystroke is still one frame, and an empty input still one empty frame', () => {
  const s = socket();
  const sock = created.at(-1) as FakeWebSocket;
  sock.open();
  s.sendInput('x');
  s.sendInput('');
  assert.deepEqual(sock.sent.map((t) => JSON.parse(t) as unknown), [
    { type: 'input', data: 'x' },
    { type: 'input', data: '' },
  ]);
  s.close();
});
