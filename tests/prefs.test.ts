/**
 * /api/prefs: an opaque UI-preferences bag (prefs.json in the data dir).
 * GET/PUT round-trip, replace-whole-object + merge-key survival at the HTTP
 * boundary (unknown keys survive because the CLIENT does the merge — this
 * suite proves the server stores whatever object it is given verbatim),
 * non-object rejection, the size cap, auth/Host/Origin parity with the
 * other authed routes, and corrupt-file tolerance on boot.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UiPrefs } from '../shared/protocol.ts';
import {
  api,
  rawRequest,
  readServerLog,
  startTestServer,
  type TestServer,
} from './helpers.ts';

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  if (server !== undefined) await server.stop();
});

test('GET /api/prefs starts empty; PUT replaces the whole object and persists to prefs.json (0600, atomic)', async () => {
  const empty = await api(server, 'GET', '/api/prefs');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, {});

  const theme: UiPrefs = { theme: { bg: 2, fg: 5, scan: true } };
  const put = await api(server, 'PUT', '/api/prefs', theme);
  assert.equal(put.status, 200, `PUT failed: ${JSON.stringify(put.body)}`);
  assert.deepEqual(put.body, { ok: true }, 'PUT /api/prefs must respond with the shared OkResponse shape');

  const got = await api(server, 'GET', '/api/prefs');
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, theme);

  const file = join(server.dataDir, 'prefs.json');
  const fileStat = await stat(file);
  assert.equal(fileStat.mode & 0o777, 0o600, 'prefs.json must be mode 0600');
  const onDisk = JSON.parse(await readFile(file, 'utf8')) as UiPrefs;
  assert.deepEqual(onDisk, theme, 'prefs.json must persist the PUT body verbatim');

  // Whole-object replace: unknown keys are preserved only if the CALLER
  // includes them (the server never merges) — proves "replace", not "patch".
  const merged: UiPrefs = { ...theme, futureSetting: 'kept-by-client-merge' };
  const put2 = await api(server, 'PUT', '/api/prefs', merged);
  assert.equal(put2.status, 200);
  const got2 = await api(server, 'GET', '/api/prefs');
  assert.deepEqual(got2.body, merged, 'unrelated keys in the PUT body must round-trip');

  const wipe = await api(server, 'PUT', '/api/prefs', { theme: theme.theme });
  assert.equal(wipe.status, 200);
  const got3 = await api(server, 'GET', '/api/prefs');
  assert.deepEqual(
    got3.body,
    { theme: theme.theme },
    'a PUT omitting futureSetting must drop it — replace-whole-object, not patch',
  );
});

test('PUT /api/prefs rejects non-object bodies and oversized bodies', async () => {
  for (const bad of [[], null, 'a string', 42, true]) {
    const res = await api(server, 'PUT', '/api/prefs', bad);
    assert.equal(res.status, 400, `expected 400 for body ${JSON.stringify(bad)}, got ${res.status}`);
  }

  // Well over the 64 KiB cap.
  const huge = { theme: { bg: 0, fg: 0, scan: false }, filler: 'x'.repeat(80 * 1024) };
  const res = await api(server, 'PUT', '/api/prefs', huge);
  assert.equal(res.status, 400, 'oversized prefs body must be 400');

  // The rejected PUTs must not have clobbered the stored value.
  const got = await api(server, 'GET', '/api/prefs');
  assert.notDeepEqual(got.body, huge);
});

test('/api/prefs requires auth and the same Host/Origin checks as every other /api route', async () => {
  const noToken = await rawRequest(server.port, { path: '/api/prefs' });
  assert.equal(noToken.status, 401, 'missing token must be 401');

  const wrongToken = await rawRequest(server.port, {
    path: '/api/prefs',
    headers: { 'x-auth-token': '0'.repeat(64) },
  });
  assert.equal(wrongToken.status, 401, 'wrong token must be 401');

  const evilHost = await rawRequest(server.port, {
    path: '/api/prefs',
    headers: { host: `evil.example.com:${server.port}`, 'x-auth-token': server.token },
  });
  assert.equal(evilHost.status, 403, 'forbidden Host must be 403 even with a valid token');

  const evilOrigin = await rawRequest(server.port, {
    path: '/api/prefs',
    headers: { origin: 'http://evil.example.com', 'x-auth-token': server.token },
  });
  assert.equal(evilOrigin.status, 403, 'cross-origin request must be 403');

  const putNoToken = await rawRequest(server.port, { method: 'PUT', path: '/api/prefs' });
  assert.equal(putNoToken.status, 401, 'PUT without a token must be 401 too');
});

test('DELETE /api/prefs is not a route: 405', async () => {
  const res = await api(server, 'DELETE', '/api/prefs');
  assert.equal(res.status, 405);
});

test('readJsonBody cap is parameterized per-route: a body over PREFS_MAX_BYTES (64 KiB) but under the generic MAX_BODY_BYTES (1 MiB) is rejected on /api/prefs but accepted on /api/sessions', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'ai-sm-prefs-cap-'));
  try {
    // 100 KiB: > PREFS_MAX_BYTES (64 KiB), well under MAX_BODY_BYTES (1 MiB).
    const filler = 'x'.repeat(100 * 1024);

    const prefsRes = await api(server, 'PUT', '/api/prefs', { filler });
    assert.equal(
      prefsRes.status,
      400,
      'a 100 KiB body must still exceed the prefs-specific 64 KiB cap',
    );

    const sessionRes = await api(server, 'POST', '/api/sessions', {
      command: 'bash',
      args: [],
      cwd: workDir,
      cols: 80,
      rows: 24,
      title: filler,
    });
    assert.equal(
      sessionRes.status,
      201,
      `a 100 KiB body must pass on a route using the generic 1 MiB cap, got ${sessionRes.status}: ${JSON.stringify(sessionRes.body)}`,
    );

    // Guards against a future cap mixup (e.g. accidentally sharing one
    // constant, or swapping which cap applies to which route).
    const got = await api(server, 'GET', '/api/prefs');
    assert.notDeepEqual(got.body, { filler }, 'the rejected prefs PUT must not have been stored');
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test('concurrent PUTs to /api/prefs never corrupt the file: the end state is exactly one of the two bodies, in memory and on disk', async () => {
  const a: UiPrefs = { marker: 'A', theme: { bg: 1, fg: 1, scan: false } };
  const b: UiPrefs = { marker: 'B', theme: { bg: 2, fg: 2, scan: true } };

  const [resA, resB] = await Promise.all([
    api(server, 'PUT', '/api/prefs', a),
    api(server, 'PUT', '/api/prefs', b),
  ]);
  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);

  const got = await api(server, 'GET', '/api/prefs');
  const gotJson = JSON.stringify(got.body);
  assert.ok(
    gotJson === JSON.stringify(a) || gotJson === JSON.stringify(b),
    `expected the final prefs to be exactly one whole PUT body (last-write-wins), got ${gotJson}`,
  );

  const file = join(server.dataDir, 'prefs.json');
  const onDisk = JSON.parse(await readFile(file, 'utf8')) as UiPrefs;
  assert.deepEqual(
    onDisk,
    got.body,
    'the on-disk file must match the in-memory GET exactly — no half-written interleave',
  );
});

test('a corrupt prefs.json is tolerated: GET returns {} and the parse failure is logged, never a crash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-prefs-corrupt-'));
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(join(dataDir, 'prefs.json'), '{ not: valid json', { mode: 0o600 });

  const corrupt = await startTestServer({ dataDir });
  try {
    const got = await api(corrupt, 'GET', '/api/prefs');
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, {}, 'a corrupt prefs.json must start empty, not crash the server');

    const log = await readServerLog(corrupt);
    assert.ok(
      log.includes('failed to parse') && log.includes('prefs.json'),
      'the corruption must be logged',
    );

    // The store must still be writable after recovering from corruption.
    const put = await api(corrupt, 'PUT', '/api/prefs', { theme: { bg: 1, fg: 1, scan: false } });
    assert.equal(put.status, 200);
    const got2 = await api(corrupt, 'GET', '/api/prefs');
    assert.deepEqual(got2.body, { theme: { bg: 1, fg: 1, scan: false } });
  } finally {
    await corrupt.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('a prefs.json holding a JSON array (wrong shape) is also tolerated: starts empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-prefs-array-'));
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(join(dataDir, 'prefs.json'), '[1,2,3]', { mode: 0o600 });

  const wrongShape = await startTestServer({ dataDir });
  try {
    const got = await api(wrongShape, 'GET', '/api/prefs');
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, {});
  } finally {
    await wrongShape.stop();
    await rm(root, { recursive: true, force: true });
  }
});
