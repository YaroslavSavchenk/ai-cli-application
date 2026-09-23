/**
 * `web/src/api.ts` — what the REST client is allowed to put in a log line.
 *
 * The client half of "everything gets logged" ships its lines to
 * `POST /api/client-log`, which appends them to `~/.ai-session-manager/server.log`.
 * The SERVER's own access log deliberately prints `?…` instead of a query
 * string (server/api.ts); this test pins the same rule on the browser side,
 * because two of our queries carry things that must never be written down:
 *
 *   - `/api/fs/list?path=<absolute path>` — every folder-picker navigation;
 *   - `/api/github/repos?q=<typed text>` — the user's repo search.
 *
 * The module is a singleton with a module-level ClientLogger (log.ts), so the
 * fake browser is installed BEFORE the imports below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

interface FetchCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string; keepalive?: boolean };
}

const calls: FetchCall[] = [];
const listeners = new Map<string, (() => void)[]>();

function addListener(type: string, fn: () => void): void {
  const list = listeners.get(type) ?? [];
  list.push(fn);
  listeners.set(type, list);
}

const fakeWindow = {
  __AUTH__: 'TOKEN-FROM-THE-PAGE',
  addEventListener: (type: string, fn: () => void) => addListener(type, fn),
};
const fakeDocument = {
  visibilityState: 'visible',
  addEventListener: (type: string, fn: () => void) => addListener(type, fn),
};
(globalThis as Record<string, unknown>)['window'] = fakeWindow;
(globalThis as Record<string, unknown>)['document'] = fakeDocument;
(globalThis as Record<string, unknown>)['fetch'] = async (
  url: string,
  init: FetchCall['init'],
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
  calls.push({ url, init });
  // A url carrying REFUSE answers 409, so the quiet-on-success rule below can
  // be read from both sides in one fake.
  if (url.includes('REFUSE')) {
    return { ok: false, status: 409, json: async () => ({ error: 'That name is already taken.' }) };
  }
  // The log-shipping route answers 204; everything else answers an empty 200
  // so request() takes its ordinary success path.
  return { ok: true, status: url === '/api/client-log' ? 204 : 200, json: async () => ({}) };
};

// The console mirror is real behaviour; capture it so it can be asserted on
// too (a leak that only reaches devtools is still a leak).
const mirrored: string[] = [];
for (const level of ['debug', 'info', 'warn', 'error'] as const) {
  const real = console[level].bind(console);
  console[level] = (...args: unknown[]): void => {
    mirrored.push(String(args[0]));
    void real;
  };
}

const api = await import('../../web/src/api.ts');
const logMod = await import('../../web/src/log.ts');
logMod.initLogging();

/** Let the logger's promise chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await delay(0);
}

/** Force delivery of everything buffered (the pagehide path) and read it back. */
async function shippedMessages(): Promise<string[]> {
  for (const fn of listeners.get('pagehide') ?? []) fn();
  await settle();
  const messages: string[] = [];
  for (const call of calls) {
    if (call.url !== '/api/client-log') continue;
    const body = JSON.parse(call.init.body ?? '{"entries":[]}') as {
      entries: { message: string }[];
    };
    for (const entry of body.entries) messages.push(entry.message);
  }
  return messages;
}

test('a query STRING VALUE never reaches a client log line — only `?…`, as the server prints it', async () => {
  await api.fsList('/home/someone/SECRETDIR');
  await api.githubRepos('SECRETQUERY');
  await settle();

  // The requests really were made with their queries intact — otherwise the
  // assertions below would pass against a client that simply does nothing.
  const urls = calls.filter((c) => c.url !== '/api/client-log').map((c) => c.url);
  assert.ok(
    urls.some((u) => u.startsWith('/api/fs/list?path=') && u.includes('SECRETDIR')),
    `the folder listing was requested with its path: ${JSON.stringify(urls)}`,
  );
  assert.ok(
    urls.some((u) => u.startsWith('/api/github/repos?q=') && u.includes('SECRETQUERY')),
    `the repo search was requested with its query: ${JSON.stringify(urls)}`,
  );

  const messages = await shippedMessages();
  assert.ok(messages.length >= 2, `both calls were logged: ${JSON.stringify(messages)}`);
  for (const canary of ['SECRETDIR', 'SECRETQUERY', 'path=', 'q=']) {
    assert.ok(
      !messages.some((m) => m.includes(canary)),
      `${canary} must never reach server.log: ${JSON.stringify(messages)}`,
    );
  }
  // The shape the server writes: route, a space, the ellipsis marker.
  assert.ok(
    messages.some((m) => m.startsWith('api GET /api/fs/list ?… → 200 ')),
    `the query is noted, never quoted: ${JSON.stringify(messages)}`,
  );
  assert.ok(
    messages.some((m) => m.startsWith('api GET /api/github/repos ?… → 200 ')),
    `the query is noted, never quoted: ${JSON.stringify(messages)}`,
  );
  // A path with NO query is unchanged.
  assert.ok(
    !mirrored.some((m) => m.includes('SECRETDIR') || m.includes('SECRETQUERY')),
    'and the devtools mirror does not hold it either',
  );
});

test('a request WITHOUT a query logs its path unchanged', async () => {
  calls.length = 0;
  await api.getProjects();
  await settle();
  const messages = await shippedMessages();
  assert.ok(
    messages.some((m) => m.startsWith('api GET /api/projects → 200 ')),
    `no query, no marker: ${JSON.stringify(messages)}`,
  );
});

// ---------------------------------------------------------------------------
// Quiet per file (part B10, user decision 2026-09-20)
// ---------------------------------------------------------------------------

test('a successful upload writes NO line: one drop is one summary, not 2000 receipts', async () => {
  calls.length = 0;
  const body = { size: 3 } as unknown as Blob;
  for (let i = 0; i < 50; i += 1) {
    await api.fsUpload('/home/you/src', `web/f${i}.bin`, 'new', body);
  }
  await settle();
  const messages = await shippedMessages();
  const receipts = messages.filter((m) => m.includes('/api/fs/upload'));
  assert.deepEqual(receipts, [], `a 201 upload is not a line: ${JSON.stringify(receipts.slice(0, 3))}`);
  // Non-vacuity: the 50 requests really were made, and every OTHER route still
  // writes its line.
  assert.equal(calls.filter((c) => c.url.startsWith('/api/fs/upload')).length, 50);
  await api.getProjects();
  await settle();
  assert.ok(
    (await shippedMessages()).some((m) => m.startsWith('api GET /api/projects → 200 ')),
    'only the upload is quiet',
  );
});

test('a REFUSED upload keeps its warn line — that is the one a reader is looking for', async () => {
  calls.length = 0;
  const body = { size: 3 } as unknown as Blob;
  await assert.rejects(() => api.fsUpload('/home/you/src', 'REFUSE.bin', 'new', body));
  await settle();
  const messages = await shippedMessages();
  const said = messages.filter((m) => m.includes('/api/fs/upload'));
  assert.equal(said.length, 1, `exactly one line, for the refusal: ${JSON.stringify(said)}`);
  assert.ok(
    said[0]?.startsWith('api PUT /api/fs/upload ?… → 409 '),
    `the status and the server s sentence, no query values: ${JSON.stringify(said)}`,
  );
  assert.equal(said[0]?.includes('REFUSE.bin'), false, 'and no name');
});

test('the upload body is RAW and announced as bytes, never as JSON', async () => {
  calls.length = 0;
  const body = { size: 3 } as unknown as Blob;
  await api.fsUpload('/home/you/src', 'a.bin', 'replace', body);
  const put = calls.find((c) => c.url.startsWith('/api/fs/upload'));
  assert.ok(put !== undefined);
  assert.equal(put.init.method, 'PUT');
  assert.equal(put.init.headers?.['content-type'], 'application/octet-stream');
  assert.equal(put.init.body, body as unknown as string, 'the File itself, not a string');
  assert.ok(put.url.includes('mode=replace'));
});
