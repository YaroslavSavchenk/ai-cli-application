/**
 * `web/src/ui/history.ts` — the REFRESH ENGINE behind the drawer's HISTORY
 * section (the grouping half lives in `ui-history-model.test.ts`).
 *
 * This module is the one place that fetches GET /api/history, and it decides
 * WHEN on its own: it subscribes once to the state store and refetches when the
 * `id:status` signature of `state.sessions` changes (create, exit, removal) or
 * when the sessions drawer opens, debounced by 300 ms. Two properties make it
 * worth pinning:
 *   - the loop guard: its own `setHistory` notifies 'sessions' too, so a
 *     signature-blind subscription would refetch forever;
 *   - the 404 degradation: a backend without the history routes must land as an
 *     empty list and a console line, never a visible error.
 *
 * It touches only two browser globals (`window.setTimeout` and `fetch`, the
 * latter through api.ts), so it runs under plain `node --test` with the small
 * shims below — no browser, no DOM. `initHistory()` installs a permanent
 * subscription, so the tests below share one live module and run in order; each
 * waits for quiescence before asserting.
 *
 * Timing: every positive assertion waits on the fetch actually happening (with
 * a deadline). The two negative assertions ("nothing must be fetched") wait a
 * bounded 450 ms — past the module's fixed 300 ms debounce — which is the only
 * way to observe an absence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { HistoryEntry, SessionInfo } from '../shared/protocol.ts';

// ---------------------------------------------------------------------------
// Browser shims — installed BEFORE the modules under test are imported
// ---------------------------------------------------------------------------

class MemoryStorage {
  #map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.#map.has(k) ? (this.#map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.#map.set(k, v);
  }
  removeItem(k: string): void {
    this.#map.delete(k);
  }
}
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();

// `window.setTimeout` must hand back something `clearTimeout` can cancel, so
// the debounce coalescing is REAL here and not merely assumed: Node's Timeout
// object is returned as-is (the module types it as a number).
(globalThis as unknown as { window: unknown }).window = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  __AUTH__: 'test-token',
};

interface StubResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

/** Every request the module made, newest last. */
const calls: string[] = [];
let response: StubResponse = { ok: true, status: 200, body: [] };

(globalThis as unknown as { fetch: unknown }).fetch = async (
  path: string,
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
  calls.push(path);
  const r = response;
  return { ok: r.ok, status: r.status, json: async () => r.body };
};

const info: string[] = [];
const warn: string[] = [];
console.info = (...args: unknown[]): void => void info.push(args.map(String).join(' '));
console.warn = (...args: unknown[]): void => void warn.push(args.map(String).join(' '));

const st = await import('../web/src/state.ts');
const hist = await import('../web/src/ui/history.ts');

// ---------------------------------------------------------------------------

function mkEntry(id: string): HistoryEntry {
  return {
    id,
    conversation: true,
    sessionId: `s-${id}`,
    cwd: '/tmp/work',
    command: 'claude',
    args: ['--model', 'opus'],
    title: id,
    createdAt: '2026-09-06T10:00:00.000Z',
    lastUsedAt: '2026-09-06T10:00:00.000Z',
    ended: { at: '2026-09-06T11:00:00.000Z', reason: 'exit' },
  };
}

function mkSession(id: string, status: SessionInfo['status'] = 'running'): SessionInfo {
  return {
    id,
    title: id,
    command: 'claude',
    args: [],
    cwd: '/tmp/work',
    status,
    cols: 80,
    rows: 24,
    createdAt: '2026-09-06T10:00:00.000Z',
    attention: false,
  };
}

/** Wait until `calls.length` reaches `n`, or fail with a deadline. */
async function waitForCalls(n: number, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (calls.length < n) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}: ${calls.length}/${n} requests made`);
    }
    await delay(10);
  }
}

/** Wait until the module has published `n` entries into the store. */
async function waitForHistory(n: number, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (st.state.history.length !== n) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}: history has ${st.state.history.length}`);
    }
    await delay(10);
  }
}

/** Past the module's 300 ms debounce — the only way to observe "no request". */
const PAST_DEBOUNCE_MS = 450;

test('initHistory: loads the list once at boot, straight into the store', async () => {
  response = { ok: true, status: 200, body: [mkEntry('a'), mkEntry('b')] };
  hist.initHistory();
  await waitForCalls(1, 'the boot load');
  assert.deepEqual(calls, ['/api/history']);
  await waitForHistory(2, 'the boot load to publish');
  assert.deepEqual(st.state.history.map((e) => e.id), ['a', 'b']);
});

test('a burst of session changes costs ONE request (300 ms debounce), and the module never refetches its own write', async () => {
  const before = calls.length;
  response = { ok: true, status: 200, body: [mkEntry('a')] };

  // Create, exit, remove — three separate 'sessions' notifications whose
  // id:status signature really did change.
  st.upsertSession(mkSession('s1'));
  st.upsertSession(mkSession('s2'));
  st.upsertSession(mkSession('s1', 'exited'));
  st.removeSessionEverywhere('s2');

  await waitForCalls(before + 1, 'the debounced refetch');
  await waitForHistory(1, 'the refetch to publish');

  // The refetch's own setHistory notifies 'sessions' as well: if the guard were
  // gone this would loop forever. Wait past the debounce and count.
  await delay(PAST_DEBOUNCE_MS);
  assert.equal(
    calls.length,
    before + 1,
    `a burst of 4 session changes must cost exactly one request, got ${calls.length - before}`,
  );
});

test('a sessions notification that changes no id:status (a plain setHistory) triggers nothing', async () => {
  const before = calls.length;
  st.setHistory([mkEntry('a'), mkEntry('zzz')]);
  await delay(PAST_DEBOUNCE_MS);
  assert.equal(calls.length, before, 'writing history must not schedule a history fetch');
  assert.deepEqual(st.state.history.map((e) => e.id), ['a', 'zzz'], 'and the write stands');
});

test('opening the SESSIONS drawer refetches; closing it, or opening another drawer, does not', async () => {
  const before = calls.length;
  response = { ok: true, status: 200, body: [mkEntry('a'), mkEntry('b'), mkEntry('c')] };

  st.openDrawer('sessions');
  await waitForCalls(before + 1, 'the drawer-open refetch');
  await waitForHistory(3, 'the drawer refetch to publish');

  st.closeDrawer();
  st.openDrawer('projects');
  await delay(PAST_DEBOUNCE_MS);
  assert.equal(
    calls.length,
    before + 1,
    'only the sessions drawer looks at the history list',
  );
  st.closeDrawer();
});

test('a 404 (backend without the history routes) lands as an empty list and a console line, never an error', async () => {
  const before = calls.length;
  assert.ok(st.state.history.length > 0, 'precondition: there is a list to lose');
  response = { ok: false, status: 404, body: { error: 'not found' } };

  st.openDrawer('sessions');
  await waitForCalls(before + 1, 'the refetch that 404s');
  await waitForHistory(0, 'the empty list to be published');
  assert.deepEqual(st.state.history, []);
  assert.ok(
    info.some((l) => l.includes('session history unavailable on this backend')),
    `the degradation must be logged, got ${JSON.stringify(info)}`,
  );
  st.closeDrawer();
});

test('any other failure keeps the last good list on screen and logs a warning', async () => {
  response = { ok: true, status: 200, body: [mkEntry('keep-me')] };
  st.openDrawer('sessions');
  await waitForHistory(1, 'the good list');
  st.closeDrawer();

  const before = calls.length;
  const warnBefore = warn.length;
  response = { ok: false, status: 500, body: { error: 'boom' } };
  st.openDrawer('sessions');
  await waitForCalls(before + 1, 'the refetch that fails');
  await delay(PAST_DEBOUNCE_MS);

  assert.deepEqual(
    st.state.history.map((e) => e.id),
    ['keep-me'],
    'a failed refresh must never blank the drawer',
  );
  assert.ok(warn.length > warnBefore, `the failure must be logged, got ${JSON.stringify(warn)}`);
  st.closeDrawer();
});
