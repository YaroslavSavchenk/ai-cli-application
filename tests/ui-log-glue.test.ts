/**
 * `web/src/log.ts` — the BROWSER GLUE around the DOM-free engine
 * (`log-core.ts`, covered by tests/ui-log.test.ts). Everything here is the part
 * the engine cannot express, and every item is a rule this feature depends on:
 *
 *   - the batch goes to POST /api/client-log with the X-Auth-Token HEADER —
 *     never a token in the URL, which would land in the access log;
 *   - the page-death path uses `keepalive: true` (sendBeacon cannot carry the
 *     header), so a closing tab still delivers what it buffered;
 *   - the ordinary path uses `keepalive: false`;
 *   - with no browser (this very process, or any node import of a module that
 *     logs) the transport reports a PERMANENT status, so the logger switches
 *     itself off after one attempt instead of retrying against nothing.
 *
 * The module is a singleton with a module-level ClientLogger, so the tests run
 * in a fixed order: everything that needs a live transport first, the
 * switch-off case last.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

interface FetchCall {
  url: string;
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    keepalive?: boolean;
  };
}

const calls: FetchCall[] = [];
const listeners = new Map<string, (() => void)[]>();

function addListener(map: Map<string, (() => void)[]>, type: string, fn: () => void): void {
  const list = map.get(type) ?? [];
  list.push(fn);
  map.set(type, list);
}

// A minimal browser: only what log.ts actually reaches for.
const fakeWindow = {
  __AUTH__: 'TOKEN-FROM-THE-PAGE',
  addEventListener: (type: string, fn: () => void) => addListener(listeners, type, fn),
};
const fakeDocument = {
  visibilityState: 'visible',
  addEventListener: (type: string, fn: () => void) => addListener(listeners, type, fn),
};
(globalThis as Record<string, unknown>)['window'] = fakeWindow;
(globalThis as Record<string, unknown>)['document'] = fakeDocument;
(globalThis as Record<string, unknown>)['fetch'] = async (
  url: string,
  init: FetchCall['init'],
): Promise<{ ok: boolean; status: number }> => {
  calls.push({ url, init });
  return { ok: true, status: 204 };
};

// The console mirror is real behaviour (devtools must keep working), so it is
// captured rather than silenced: it keeps the test output readable AND lets the
// level parity be asserted.
const mirrored: [string, string][] = [];
for (const level of ['debug', 'info', 'warn', 'error'] as const) {
  const real = console[level].bind(console);
  console[level] = (...args: unknown[]): void => {
    mirrored.push([level, String(args[0])]);
    void real;
  };
}

const mod = await import('../web/src/log.ts');

/** Let the logger's promise chain settle (send -> decide -> maybe again). */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await delay(0);
}

const bodyEntries = (call: FetchCall): { level: string; at: string; message: string }[] =>
  (JSON.parse(call.init.body as string) as { entries: { level: string; at: string; message: string }[] })
    .entries;

test('an error is POSTed to /api/client-log with the token in a HEADER, keepalive off', async () => {
  calls.length = 0;
  mod.log.error('GLUE-ERROR-LINE');
  await settle();

  assert.equal(calls.length, 1, 'an error does not wait for the batching window');
  const call = calls[0] as FetchCall;
  assert.equal(call.url, '/api/client-log');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.keepalive, false, 'the ordinary path is a normal fetch');
  assert.equal(call.init.headers?.['x-auth-token'], 'TOKEN-FROM-THE-PAGE');
  assert.equal(call.init.headers?.['content-type'], 'application/json');
  assert.ok(!call.url.includes('TOKEN-FROM-THE-PAGE'), 'the token NEVER travels in the URL');

  const entries = bodyEntries(call);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.level, 'error');
  assert.equal(entries[0]?.message, 'GLUE-ERROR-LINE');
  assert.match(entries[0]?.at as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  // Same level in devtools as on the wire, so a developer with the console
  // open sees exactly the stream server.log will hold.
  assert.deepEqual(mirrored.at(-1), ['error', 'GLUE-ERROR-LINE']);
  mod.log.warn('GLUE-WARN');
  mod.log.info('GLUE-INFO');
  mod.log.debug('GLUE-DEBUG');
  assert.deepEqual(mirrored.slice(-3), [
    ['warn', 'GLUE-WARN'],
    ['info', 'GLUE-INFO'],
    ['debug', 'GLUE-DEBUG'],
  ]);
});

test('pagehide and a hidden visibilitychange both flush with keepalive: true', async () => {
  mod.initLogging();
  assert.ok((listeners.get('pagehide') ?? []).length > 0, 'initLogging registers pagehide');
  assert.ok(
    (listeners.get('visibilitychange') ?? []).length > 0,
    'and visibilitychange (the backgrounded-then-killed case)',
  );

  // Drain whatever the previous test left buffered, so this batch is only ours.
  for (const fn of listeners.get('pagehide') ?? []) fn();
  await settle();
  calls.length = 0;
  mod.log.info('GLUE-HIDE-1');
  mod.log.info('GLUE-HIDE-2');
  assert.equal(calls.length, 0, 'ordinary lines wait for the window');

  for (const fn of listeners.get('pagehide') ?? []) fn();
  await settle();

  assert.equal(calls.length, 1, 'the buffered lines left in ONE batch');
  const call = calls[0] as FetchCall;
  assert.equal(call.init.keepalive, true, 'a closing page needs a keepalive fetch');
  assert.equal(call.init.headers?.['x-auth-token'], 'TOKEN-FROM-THE-PAGE');
  assert.deepEqual(bodyEntries(call).map((e) => e.message), ['GLUE-HIDE-1', 'GLUE-HIDE-2']);

  // visibilitychange only flushes when the page really went hidden.
  calls.length = 0;
  mod.log.info('GLUE-HIDE-3');
  for (const fn of listeners.get('visibilitychange') ?? []) fn();
  await settle();
  assert.equal(calls.length, 0, 'a still-visible page keeps batching');

  fakeDocument.visibilityState = 'hidden';
  for (const fn of listeners.get('visibilitychange') ?? []) fn();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as FetchCall).init.keepalive, true);
  fakeDocument.visibilityState = 'visible';
});

test('a message is one line and 2048 chars before it ever reaches the wire', async () => {
  calls.length = 0;
  mod.log.error(`GLUE-LONG-${'B'.repeat(5000)}\nsecond line`);
  await settle();

  const message = bodyEntries(calls[0] as FetchCall)[0]?.message as string;
  assert.equal(message.length, 2048, 'the server truncates at the same number; we get there first');
  assert.ok(!message.includes('\n'), 'never a newline on the wire');
  assert.ok(message.startsWith('GLUE-LONG-BBB'));
});

// This one goes LAST: it takes the module's singleton logger permanently off.
test('no page (a node import) reports a permanent status: one attempt, then console only', async () => {
  const token = fakeWindow.__AUTH__;
  fakeWindow.__AUTH__ = ''; // no token -> authHeader() returns null
  calls.length = 0;
  const warnedFrom = mirrored.length;
  const warned = (): [string, string][] =>
    mirrored.slice(warnedFrom).filter(([level]) => level === 'warn');
  try {
    mod.log.error('into the void');
    await settle();
    assert.equal(calls.length, 0, 'nothing is sent without a token');
    assert.equal(warned().length, 1, 'exactly one console notice');
    assert.match(warned()[0]?.[1] as string, /client logging off/);

    // Permanently off: a later line is console-only and fires no request.
    mod.log.error('still nothing');
    await settle();
    assert.equal(calls.length, 0);
    assert.equal(warned().length, 1, 'and the notice is not repeated');
  } finally {
    fakeWindow.__AUTH__ = token;
  }
});
