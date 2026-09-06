/**
 * The WIRING between `state.setRestarting()` and the client-log transport.
 *
 * `tests/ui-log.test.ts` proves the ClientLogger's own `hold()`/`resume()`
 * behaviour on an injected instance, and `tests/ui-restart-guards.test.ts`
 * proves the flag's effect on the two WebSockets. Neither can see whether the
 * flag ever REACHES the app-wide logger — and it is a one-line wiring that,
 * removed, leaves the whole suite green (measured 2026-09-06: 680/680 with
 * `state.setRestarting()`'s `log.hold()`/`log.resume()` deleted).
 *
 * What it costs when the wire is missing: the restart tears the old backend
 * down, the CHILD takes the same port with a FRESH token, the next log flush
 * is answered 401 — a PERMANENT status — and this page ships no more log lines
 * for the rest of its life. Over a restart the user asked for.
 *
 * HOW IT IS OBSERVED. `web/src/log.ts` builds its singleton over the GLOBAL
 * `setTimeout`/`clearTimeout` and the global `fetch`, resolved at call time, so
 * recorders substitute for all three. Nothing here waits on a real clock: the
 * scheduled callbacks are fired by hand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLUSH_MS } from '../web/src/log-core.ts';

interface Scheduled {
  fn: () => void;
  ms: number;
  cleared: boolean;
}
const scheduled: Scheduled[] = [];
const fetches: { url: string; body: string }[] = [];

(globalThis as unknown as { setTimeout: unknown }).setTimeout = (fn: () => void, ms: number) => {
  const rec: Scheduled = { fn, ms, cleared: false };
  scheduled.push(rec);
  return rec;
};
(globalThis as unknown as { clearTimeout: unknown }).clearTimeout = (handle: unknown) => {
  if (handle !== null && typeof handle === 'object' && 'cleared' in handle) {
    (handle as Scheduled).cleared = true;
  }
};
// A live transport: log.ts refuses to send at all without window/document/token.
(globalThis as unknown as { document: unknown }).document = { visibilityState: 'visible' };
(globalThis as unknown as { window: unknown }).window = { __AUTH__: 'test-token' };
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (): string | null => null,
  setItem: (): void => undefined,
  removeItem: (): void => undefined,
};
(globalThis as unknown as { fetch: unknown }).fetch = (url: string, init: { body: string }) => {
  fetches.push({ url, body: init.body });
  return Promise.resolve({ ok: true, status: 204 });
};
for (const level of ['debug', 'info', 'warn', 'error'] as const) {
  console[level] = (): void => undefined;
}

const { log } = await import('../web/src/log.ts');
const st = await import('../web/src/state.ts');

/** Every timer armed and not yet cancelled or fired. */
function live(): Scheduled[] {
  return scheduled.filter((s) => !s.cleared);
}

/** Fire every live timer once, then let the flush's promises settle. */
async function fireAll(): Promise<void> {
  for (const s of live()) {
    s.cleared = true;
    s.fn();
  }
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * Leave the module-level singleton in a known state: not restarting, nothing
 * buffered, recorders empty. Without this a test that fails early would leak a
 * held logger and a pending batch into the next one.
 */
async function reset(): Promise<void> {
  st.setRestarting(false);
  await fireAll();
  scheduled.length = 0;
  fetches.length = 0;
}

test('setRestarting(true) parks the app-wide log transport, and false lets it go again', async () => {
  await reset();

  log.info('before the gap');
  assert.equal(live().length, 1, 'a line arms the idle window');
  assert.equal(live()[0]?.ms, FLUSH_MS);

  // The gap opens: the pending flush must be disarmed, not left to fire into
  // the replacement backend.
  st.setRestarting(true);
  assert.equal(live().length, 0, 'setRestarting(true) disarms the pending flush');

  log.info('during the gap');
  await fireAll();
  assert.equal(fetches.length, 0, 'nothing is shipped while the restart is in flight');
  assert.equal(live().length, 0, 'and no timer keeps re-arming during the gap');

  // The gap closes (the restart failed, or the reload has not happened yet):
  // delivery resumes on the normal window and the buffered lines go out.
  st.setRestarting(false);
  assert.equal(live().length, 1, 'setRestarting(false) re-arms the idle window');
  assert.equal(live()[0]?.ms, FLUSH_MS);
  await fireAll();
  assert.equal(fetches.length, 1, 'exactly one batch');
  assert.equal(fetches[0]?.url, '/api/client-log');
  const sent = fetches[0]?.body ?? '';
  assert.ok(sent.includes('before the gap'), 'the line from before the gap is not lost');
  assert.ok(sent.includes('during the gap'), 'nor the one written during it');
});

test('a no-op setRestarting write neither holds nor resumes', async () => {
  await reset();

  log.info('after the gap');
  assert.equal(live().length, 1);
  st.setRestarting(false); // already false: must not disturb the armed flush
  assert.equal(live().length, 1, 'the armed flush survives a write that changes nothing');
  await fireAll();
  assert.equal(fetches.length, 1, 'and it still ships');
});
