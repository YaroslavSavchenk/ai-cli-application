/**
 * The `restarting` flag's REAL job: during a restart this page asked for, every
 * "the backend vanished" reflex has to stand down. This file pins the two that
 * live in `web/src/ws.ts` — the per-session socket's reconnect loop and the
 * presence channel's — plus the state setter they read.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Without the guard the sequence is:
 * the old process kills its sessions and exits -> every session socket closes
 * -> each one probes `GET /api/sessions` -> the replacement backend answers
 * 401 (tokens rotate per run) -> `#die()` marks the pane permanently dead AND
 * `onAuthError` takes the whole page over with a panic panel — all while the
 * restart dialog is showing an honest "Reconnecting…". The guard is what makes
 * the difference between a two-second handover and a broken window.
 *
 * Same shimmed-globals harness as `tests/ui-ws-presence.test.ts`: `ws.ts`
 * resolves `WebSocket`/`location`/`window` from the global scope at CALL time,
 * so fakes substitute for all three. Timers are recorders, never real ones —
 * these reconnect loops have no teardown hook by design.
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
  onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    created.push(this);
  }

  send(): void {
    // The guards under test never send.
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  simulateClose(code = 1012, reason = 'service restart', wasClean = false): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean });
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

/** Every fetch the modules attempt — the guard's whole point is that there are none. */
const fetches: string[] = [];

class MemoryStorage {
  #map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.#map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.#map.set(k, v);
  }
  removeItem(k: string): void {
    this.#map.delete(k);
  }
}

(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
(globalThis as unknown as { location: unknown }).location = {
  protocol: 'http:',
  host: 'localhost:41234',
};
(globalThis as unknown as { window: unknown }).window = {
  __AUTH__: 'test-token',
  setInterval: fakeTimer,
  setTimeout: fakeTimer,
  addEventListener: () => undefined,
};
(globalThis as unknown as { localStorage: unknown }).localStorage = new MemoryStorage();
(globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
  fetches.push(url);
  return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) };
};

// Silence the client logger's console mirror: real behaviour, pure noise here.
for (const level of ['debug', 'info', 'warn', 'error'] as const) {
  console[level] = (): void => undefined;
}

const ws = await import('../web/src/ws.ts');
const st = await import('../web/src/state.ts');

/** ws.ts's own RESTART_HOLD_MS, mirrored (it is module-private by design). */
const RESTART_HOLD_MS = 1000;

function reset(): void {
  created.length = 0;
  scheduled.length = 0;
  fetches.length = 0;
  st.state.restarting = false;
}

const noopHandlers = {
  onReplay: (): void => undefined,
  onData: (): void => undefined,
  onInfo: (): void => undefined,
  onExit: (): void => undefined,
  onAttention: (): void => undefined,
  onConn: (): void => undefined,
};

test('setRestarting flips the flag and notifies once per real transition', () => {
  reset();
  const kinds: string[] = [];
  st.subscribe((k) => kinds.push(k));
  st.setRestarting(true);
  st.setRestarting(true);
  assert.equal(st.state.restarting, true);
  st.setRestarting(false);
  assert.deepEqual(
    kinds.filter((k) => k === 'conn'),
    ['conn', 'conn'],
    'no notification for a no-op write',
  );
  reset();
});

test('a session socket dropped DURING a restart makes no liveness call and never dies', async () => {
  reset();
  const conn: string[] = [];
  const sock = new ws.SessionSocket('sess-1', { ...noopHandlers, onConn: (s) => conn.push(s) });
  const socket = created[0] as FakeWebSocket;
  st.setRestarting(true);

  socket.simulateClose();
  // #lost is async only because of the liveness call it is NOT making here;
  // one microtask turn is enough for the guarded path.
  await Promise.resolve();

  assert.deepEqual(fetches, [], 'no /api/sessions probe — a 401 would kill the pane and the page');
  assert.equal(conn.at(-1), 'reconnecting', 'the pane says reconnecting, never dead');
  assert.ok(!conn.includes('dead'));
  const held = scheduled.at(-1);
  assert.equal(held?.ms, RESTART_HOLD_MS, 'it parks and re-checks instead of retrying');
  assert.equal(created.length, 1, 'and it does NOT open a new socket during the gap');

  // The hold re-enters the same guarded path for as long as the flag is set.
  held?.fn();
  await Promise.resolve();
  assert.deepEqual(fetches, []);
  assert.equal(scheduled.at(-1)?.ms, RESTART_HOLD_MS);

  // Once the restart is over (it failed, say), the normal loop resumes and the
  // liveness probe happens again — the guard pauses, it does not switch off.
  st.setRestarting(false);
  scheduled.at(-1)?.fn();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(fetches, ['/api/sessions']);
  sock.close();
  reset();
});

test('a session socket dropped OUTSIDE a restart keeps its normal behaviour', async () => {
  reset();
  const conn: string[] = [];
  const sock = new ws.SessionSocket('sess-2', { ...noopHandlers, onConn: (s) => conn.push(s) });
  const socket = created[0] as FakeWebSocket;
  socket.simulateClose();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.deepEqual(fetches, ['/api/sessions'], 'the unguarded path still probes');
  // The shimmed fetch answers 401 -> the socket dies, exactly as before.
  assert.equal(conn.at(-1), 'dead');
  sock.close();
  reset();
});

test('the presence channel holds instead of reconnecting while a restart is in flight', () => {
  reset();
  ws.startPresence();
  const socket = created[0] as FakeWebSocket;
  st.setRestarting(true);
  socket.simulateClose();

  assert.equal(created.length, 1, 'no reconnect attempt during the gap');
  const held = scheduled.at(-1);
  assert.equal(held?.ms, RESTART_HOLD_MS);

  // Still restarting: it re-arms rather than opening.
  held?.fn();
  assert.equal(created.length, 1);
  assert.equal(scheduled.at(-1)?.ms, RESTART_HOLD_MS);

  // Restart over: the very next hold opens a fresh presence socket.
  st.setRestarting(false);
  scheduled.at(-1)?.fn();
  assert.equal(created.length, 2);
  assert.ok((created[1] as FakeWebSocket).url.includes('/ws/presence'));
  reset();
});
