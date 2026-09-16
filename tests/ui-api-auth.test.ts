/**
 * `web/src/api.ts` — which failed responses count as "this page lost its
 * auth" (the page-takeover path `onAuthError` → reload), and which are an
 * ordinary refusal the caller renders inline.
 *
 * The server answers 403 for two different things: the Origin/Host gate
 * (`'forbidden host'` / `'forbidden origin'`, server/api.ts) — the page is not
 * allowed at all — and a filesystem permission error (`'permission denied'`,
 * server/fsbrowse.ts + server/scaffold.ts), which the folder picker shows
 * inline. The token check is the 401 (`'unauthorized'`). Before this split,
 * browsing into an unreadable folder (`/root`) reloaded the page.
 *
 * The module is a singleton with a module-level ClientLogger (log.ts), so the
 * fake browser is installed BEFORE the imports below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

interface FakeResponse {
  status: number;
  /** undefined → the body is not JSON (json() rejects). */
  body?: unknown;
}

let next: FakeResponse = { status: 200, body: {} };
/** Every request the module made: the B2 route list is asserted against it. */
const calls: { url: string; init: Record<string, unknown> }[] = [];

const fakeWindow = {
  __AUTH__: 'TOKEN-FROM-THE-PAGE',
  addEventListener: () => undefined,
};
const fakeDocument = {
  visibilityState: 'visible',
  addEventListener: () => undefined,
};
(globalThis as Record<string, unknown>)['window'] = fakeWindow;
(globalThis as Record<string, unknown>)['document'] = fakeDocument;
(globalThis as Record<string, unknown>)['fetch'] = async (
  url: string,
  init: Record<string, unknown> = {},
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
  if (url === '/api/client-log') return { ok: true, status: 204, json: async () => ({}) };
  calls.push({ url, init });
  const { status, body } = next;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
      return body;
    },
  };
};
// The client log mirrors to the console; keep the test output readable.
for (const level of ['debug', 'info', 'warn', 'error'] as const) {
  console[level] = (): void => undefined;
}

const api = await import('../web/src/api.ts');

let takeovers = 0;
api.onAuthError(() => {
  takeovers++;
});

/** Run one fsList against `res`; report whether the takeover fired and what was thrown. */
async function callWith(res: FakeResponse): Promise<{ takeover: boolean; err: unknown }> {
  next = res;
  const before = takeovers;
  let err: unknown = null;
  try {
    await api.fsList('/root');
  } catch (e) {
    err = e;
  }
  return { takeover: takeovers > before, err };
}

test('isAuthFailure: a 401 is an auth failure whatever its body says', () => {
  for (const text of ['unauthorized', 'permission denied', 'anything', null]) {
    assert.equal(api.isAuthFailure(401, text), true, `401 ${JSON.stringify(text)}`);
  }
});

test('isAuthFailure: a 403 from the Origin/Host gate is an auth failure', () => {
  assert.equal(api.isAuthFailure(403, 'forbidden host'), true);
  assert.equal(api.isAuthFailure(403, 'forbidden origin'), true);
});

test('isAuthFailure: a filesystem 403 (`permission denied`) is NOT — the caller renders it', () => {
  assert.equal(api.isAuthFailure(403, 'permission denied'), false);
  // Any other server-written 403 text (e.g. a GitHub refusal) is an ordinary refusal too.
  assert.equal(
    api.isAuthFailure(
      403,
      'this token cannot create repositories on this account — creating one needs a token with broader access',
    ),
    false,
  );
});

test('isAuthFailure: a 403 with no readable error text counts as the gate (the static-file 403 never answers /api/)', () => {
  assert.equal(api.isAuthFailure(403, null), true);
});

test('isAuthFailure: other statuses never are', () => {
  for (const status of [200, 201, 400, 404, 409, 422, 500, 502]) {
    assert.equal(api.isAuthFailure(status, null), false, `${status} no body`);
    assert.equal(api.isAuthFailure(status, 'forbidden origin'), false, `${status} gate text`);
  }
});

test('request(): a filesystem 403 throws the server message as an ApiError and does NOT take the page over', async () => {
  const { takeover, err } = await callWith({ status: 403, body: { error: 'permission denied' } });
  assert.equal(takeover, false);
  assert.ok(err instanceof api.ApiError, `ApiError thrown: ${String(err)}`);
  assert.equal(err.status, 403);
  assert.equal(err.message, 'permission denied');
});

test('request(): the gate 403s and a 401 take the page over, and still throw', async () => {
  for (const res of [
    { status: 403, body: { error: 'forbidden host' } },
    { status: 403, body: { error: 'forbidden origin' } },
    { status: 403 }, // no JSON body
    { status: 401, body: { error: 'unauthorized' } },
    { status: 401 },
  ] satisfies FakeResponse[]) {
    const { takeover, err } = await callWith(res);
    assert.equal(takeover, true, `takeover for ${JSON.stringify(res)}`);
    assert.ok(err instanceof api.ApiError, `ApiError for ${JSON.stringify(res)}`);
    assert.equal(err.status, res.status);
  }
});

test('request(): 404/500 and a success never take the page over', async () => {
  for (const res of [
    { status: 404, body: { error: 'not a directory' } },
    { status: 500 },
    { status: 200, body: { path: '/', parent: null, dirs: [] } },
  ] satisfies FakeResponse[]) {
    const { takeover } = await callWith(res);
    assert.equal(takeover, false, `no takeover for ${JSON.stringify(res)}`);
  }
});

// ---------------------------------------------------------------------------
// B2 (2026-09-16): the three Files-panel routes. They are under /api/, so the
// token gate is structural — what is asserted here is that the client really
// sends the token on each of them, that a query VALUE never reaches the URL
// unencoded, and that their filesystem 403 is an ordinary refusal the panel
// renders (the server's own sentence) rather than a page takeover.
// ---------------------------------------------------------------------------

test('fsEntries / fsCreate / gitChanges each carry the token, and each shape their URL', async () => {
  calls.length = 0;
  next = { status: 200, body: { path: '/home/you', entries: [], truncated: 0 } };
  await api.fsEntries();
  await api.fsEntries('/home/you/my notes');
  next = { status: 201, body: { path: '/home/you/my notes/x.txt' } };
  await api.fsCreate('/home/you/my notes', 'x.txt', 'file');
  next = { status: 200, body: { isRepo: false, repoRoot: null, branch: null, files: [], truncated: 0 } };
  await api.gitChanges('/home/you/my notes');

  assert.deepEqual(
    calls.map((c) => c.url),
    [
      '/api/fs/entries',
      '/api/fs/entries?path=%2Fhome%2Fyou%2Fmy%20notes',
      '/api/fs/create',
      '/api/git/changes?root=%2Fhome%2Fyou%2Fmy%20notes',
    ],
  );
  for (const call of calls) {
    const headers = call.init['headers'] as Record<string, string>;
    assert.equal(headers['x-auth-token'], 'TOKEN-FROM-THE-PAGE', `${call.url} carries the token`);
  }
  const create = calls[2] as { init: Record<string, unknown> };
  assert.equal(create.init['method'], 'POST');
  assert.equal(
    create.init['body'],
    JSON.stringify({ dir: '/home/you/my notes', name: 'x.txt', kind: 'file' }),
  );
});

test("the panel's 403s are ordinary refusals: the server's sentence is thrown, the page is not taken over", async () => {
  for (const sentence of [
    'This folder is outside your home folder.',
    'You do not have permission to read this folder.',
    "The app's own folder is not a place to create files.",
  ]) {
    next = { status: 403, body: { error: sentence } };
    const before = takeovers;
    let err: unknown = null;
    try {
      await api.fsEntries('/home/you');
    } catch (e) {
      err = e;
    }
    assert.equal(takeovers, before, `${sentence}: no takeover`);
    assert.ok(err instanceof api.ApiError, `${sentence}: ApiError`);
    assert.equal(err.message, sentence, 'and the sentence reaches the panel verbatim');
  }
});
