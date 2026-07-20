/**
 * `web/src/ws.ts` — `startPresence()`'s pong -> latency callback wiring
 * (R2 statusline `ws <n> ms`), and close -> null.
 *
 * ws.ts resolves `WebSocket`/`location`/`window` from the global scope at
 * CALL time (never imports them), so we can substitute fakes for all three
 * before invoking it — no real socket, no real timers, fully synchronous and
 * deterministic. `window.setInterval`/`setTimeout` are faked to no-op
 * recorders rather than delegating to the real timer functions: startPresence
 * has no teardown hook (by design — it's a boot-once, run-forever channel),
 * so if we let it schedule REAL timers here they'd outlive the test and could
 * hang `node --test`'s process exit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  readonly sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    created.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /** Test helper: fire the open handshake ws.ts itself would trigger async. */
  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

const created: FakeWebSocket[] = [];
interface ScheduledCall {
  fn: () => void;
  ms: number;
}
const scheduled: ScheduledCall[] = [];
let fakeTimerId = 0;
function fakeTimer(fn: () => void, ms: number): number {
  scheduled.push({ fn, ms });
  return ++fakeTimerId;
}

(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
(globalThis as unknown as { location: unknown }).location = {
  protocol: 'http:',
  host: 'localhost:5173',
};
(globalThis as unknown as { window: unknown }).window = {
  __AUTH__: 'test-token', // api.ts's authToken() reads window.__AUTH__
  setInterval: fakeTimer,
  setTimeout: fakeTimer,
};

const { startPresence } = await import('../web/src/ws.ts');

test('startPresence: opens with the auth token in the URL and sends one ping frame with a numeric t on open', () => {
  startPresence(() => undefined);
  assert.equal(created.length, 1);
  const sock = created[0] as FakeWebSocket;
  assert.match(sock.url, /^ws:\/\/localhost:5173\/ws\/presence\?token=test-token$/);

  sock.simulateOpen();
  assert.equal(sock.sent.length, 1, 'opening must send exactly one ping frame immediately');
  const ping = JSON.parse(sock.sent[0] as string) as { type: string; t: unknown };
  assert.equal(ping.type, 'ping');
  assert.equal(typeof ping.t, 'number');
});

test('startPresence: a pong with a matching numeric t invokes onLatency with a rounded, non-negative ms', () => {
  created.length = 0;
  const latencies: (number | null)[] = [];
  startPresence((ms) => latencies.push(ms));
  const sock = created[0] as FakeWebSocket;
  sock.simulateOpen();
  const ping = JSON.parse(sock.sent[0] as string) as { t: number };

  sock.onmessage?.({ data: JSON.stringify({ type: 'pong', t: ping.t }) });

  assert.equal(latencies.length, 1);
  const ms = latencies[0];
  assert.equal(typeof ms, 'number');
  assert.ok((ms as number) >= 0, 'latency must never be negative');
  assert.ok(Number.isInteger(ms), 'latency must be rounded');
});

test('startPresence: malformed pong frames (non-numeric/missing t, wrong type) are silently ignored', () => {
  created.length = 0;
  const latencies: (number | null)[] = [];
  startPresence((ms) => latencies.push(ms));
  const sock = created[0] as FakeWebSocket;
  sock.simulateOpen();

  sock.onmessage?.({ data: JSON.stringify({ type: 'pong', t: 'not-a-number' }) });
  sock.onmessage?.({ data: JSON.stringify({ type: 'pong' }) });
  sock.onmessage?.({ data: JSON.stringify({ type: 'ping', t: 1 }) }); // wrong type entirely
  sock.onmessage?.({ data: 'not even json' });
  sock.onmessage?.({ data: JSON.stringify({ type: 'pong', t: Number.POSITIVE_INFINITY }) });

  assert.deepEqual(latencies, [], 'none of these frames must trigger onLatency');
});

test('startPresence: socket close reports onLatency(null) and schedules a reconnect timer', () => {
  created.length = 0;
  scheduled.length = 0;
  const latencies: (number | null)[] = [];
  startPresence((ms) => latencies.push(ms));
  const sock = created[0] as FakeWebSocket;
  sock.simulateOpen();

  sock.onclose?.();

  assert.deepEqual(latencies, [null], 'close must report latency loss as null, not silence');
  assert.ok(
    scheduled.some((s) => s.ms > 0),
    'a reconnect attempt must be scheduled via window.setTimeout after close',
  );
});
