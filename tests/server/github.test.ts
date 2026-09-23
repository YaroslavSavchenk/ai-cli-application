/**
 * GitHub OAuth device-flow connection (Phase 2b) — the HTTP boundary and the
 * pure repo mapping.
 *
 * Two layers:
 *   1. HTTP boundary against the REAL server with NO client_id configured
 *      (AI_SM_GITHUB_CLIENT_ID=''): the not-configured path end-to-end, plus
 *      auth (401 w/o token), method (405), and Host/Origin parity (403) for all
 *      four /api/github/* endpoints and the Phase 2c ones. Deterministic +
 *      offline — the not-configured guard short-circuits before any network
 *      call.
 *   2. The pure repo mapping + query filter (mapRepo / filterRepos), called
 *      in-process.
 *
 * NOT claimed here (split out by topic, PLAN-RESTRUCTURE O6): the device-flow
 * state machine through the fetch SEAM — `github-device-flow.test.ts`;
 * createRepo and cloneAuthenticated through the fetch/spawn seams —
 * `github-clone.test.ts` and `github-clone-gaps.test.ts`. The shared doubles
 * are `tests/helpers/github-fixture.ts`. A real GitHub is never contacted.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mapRepo,
  filterRepos,
} from '../../server/github.ts';
import type { GithubRepo } from '../../shared/protocol.ts';
import {
  api,
  rawRequest,
  startTestServer,
  type TestServer,
} from '../helpers/helpers.ts';
import {
  RAW_REPO,
} from '../helpers/github-fixture.ts';

// ---------------------------------------------------------------------------
// 1. HTTP boundary — NOT configured (no client_id)
// ---------------------------------------------------------------------------

let server: TestServer;

before(async () => {
  server = await startTestServer({ env: { AI_SM_GITHUB_CLIENT_ID: '' } });
});

after(async () => {
  if (server !== undefined) await server.stop();
});

test('no client_id: GET /api/github/status -> { deviceFlowAvailable:false, state:"disconnected" }', async () => {
  const res = await api(server, 'GET', '/api/github/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { deviceFlowAvailable: false, state: 'disconnected' });
});

test('no client_id: POST /api/github/device -> 409 { deviceFlowAvailable:false } (never crashes, no network)', async () => {
  const res = await api(server, 'POST', '/api/github/device');
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { deviceFlowAvailable: false });
});

test('not configured: GET /api/github/repos -> 409 (not connected)', async () => {
  const res = await api(server, 'GET', '/api/github/repos');
  assert.equal(res.status, 409);
});

test('not configured: POST /api/github/disconnect -> 200 { ok:true } (idempotent no-op)', async () => {
  const res = await api(server, 'POST', '/api/github/disconnect');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('every /api/github/* endpoint requires the auth token (401 without it)', async () => {
  const cases: { method: string; path: string }[] = [
    { method: 'GET', path: '/api/github/status' },
    { method: 'POST', path: '/api/github/device' },
    { method: 'POST', path: '/api/github/token' },
    { method: 'POST', path: '/api/github/disconnect' },
    { method: 'GET', path: '/api/github/repos' },
  ];
  for (const c of cases) {
    const noToken = await rawRequest(server.port, { method: c.method, path: c.path });
    assert.equal(noToken.status, 401, `${c.method} ${c.path} without a token must be 401`);
    const wrongToken = await rawRequest(server.port, {
      method: c.method,
      path: c.path,
      headers: { 'x-auth-token': '0'.repeat(64) },
    });
    assert.equal(wrongToken.status, 401, `${c.method} ${c.path} with a wrong token must be 401`);
  }
});

test('/api/github/* keeps the same Host/Origin parity as every other /api route (403)', async () => {
  const evilHost = await rawRequest(server.port, {
    path: '/api/github/status',
    headers: { host: `evil.example.com:${server.port}`, 'x-auth-token': server.token },
  });
  assert.equal(evilHost.status, 403, 'forbidden Host must be 403 even with a valid token');

  const evilOrigin = await rawRequest(server.port, {
    path: '/api/github/status',
    headers: { origin: 'http://evil.example.com', 'x-auth-token': server.token },
  });
  assert.equal(evilOrigin.status, 403, 'cross-origin request must be 403');
});

test('wrong method on each /api/github/* endpoint -> 405', async () => {
  assert.equal((await api(server, 'POST', '/api/github/status')).status, 405);
  assert.equal((await api(server, 'GET', '/api/github/device')).status, 405);
  assert.equal((await api(server, 'GET', '/api/github/disconnect')).status, 405);
  // /api/github/repos now accepts POST (create-repo), so DELETE is the 405 case.
  assert.equal((await api(server, 'DELETE', '/api/github/repos')).status, 405);
  // /api/github/clone accepts POST only.
  assert.equal((await api(server, 'GET', '/api/github/clone')).status, 405);
});

test('Phase 2c endpoints: 401 w/o token, 405 wrong method, 409 not-connected (server unconfigured)', async () => {
  // 401 without the auth token.
  for (const path of ['/api/github/clone', '/api/github/repos']) {
    const noTok = await rawRequest(server.port, { method: 'POST', path });
    assert.equal(noTok.status, 401, `POST ${path} without a token must be 401`);
    const wrongTok = await rawRequest(server.port, {
      method: 'POST',
      path,
      headers: { 'x-auth-token': '0'.repeat(64) },
    });
    assert.equal(wrongTok.status, 401, `POST ${path} with a wrong token must be 401`);
  }
  // Host/Origin parity (403) even with a valid token.
  const evilHost = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/github/clone',
    headers: { host: `evil.example.com:${server.port}`, 'x-auth-token': server.token },
  });
  assert.equal(evilHost.status, 403, 'forbidden Host must be 403');

  // 409 not-connected (the test server has AI_SM_GITHUB_CLIENT_ID='').
  const clone = await api(server, 'POST', '/api/github/clone', {
    cloneUrl: 'https://github.com/octocat/hello.git',
    dest: join(tmpdir(), 'ai-sm-clone-unreachable-xyz'),
  });
  assert.equal(clone.status, 409, 'clone when not connected -> 409');
  const create = await api(server, 'POST', '/api/github/repos', { name: 'new-repo', private: false });
  assert.equal(create.status, 409, 'create-repo when not connected -> 409');
});

test('POST /api/github/clone: malformed body -> 400 (bad cloneUrl / non-absolute dest / bad name type)', async () => {
  const abs = join(tmpdir(), 'ai-sm-clone-400');
  assert.equal((await api(server, 'POST', '/api/github/clone', { dest: abs })).status, 400, 'missing cloneUrl');
  assert.equal(
    (await api(server, 'POST', '/api/github/clone', { cloneUrl: 'https://github.com/o/r.git', dest: 'rel/dir' })).status,
    400,
    'relative dest',
  );
  assert.equal(
    (await api(server, 'POST', '/api/github/repos', { name: '', private: false })).status,
    400,
    'blank repo name',
  );
  assert.equal(
    (await api(server, 'POST', '/api/github/repos', { name: 'ok', private: 'yes' })).status,
    400,
    'private must be boolean',
  );
});

// ---------------------------------------------------------------------------
// 2a. Pure repo mapping + query filter (no network, no state)
// ---------------------------------------------------------------------------

test('mapRepo keeps only the listed fields and drops everything else (no payload leak)', () => {
  const repo = mapRepo(RAW_REPO);
  assert.deepEqual(repo, {
    fullName: 'octocat/hello',
    name: 'hello',
    owner: 'octocat',
    private: true,
    description: 'a greeting',
    language: 'TypeScript',
    pushedAt: '2026-07-20T10:00:00Z',
    cloneUrl: 'https://github.com/octocat/hello.git',
  });
  assert.equal(Object.keys(repo as object).length, 8, 'exactly the 8 mapped keys, nothing else');
});

test('mapRepo: optional fields omitted when absent/empty; private defaults false', () => {
  const repo = mapRepo({
    full_name: 'me/bare',
    name: 'bare',
    owner: { login: 'me' },
    clone_url: 'https://github.com/me/bare.git',
    description: '',
    // private absent, language/pushed_at absent
  });
  assert.deepEqual(repo, {
    fullName: 'me/bare',
    name: 'bare',
    owner: 'me',
    private: false,
    cloneUrl: 'https://github.com/me/bare.git',
  });
});

test('mapRepo returns undefined when a required field is missing', () => {
  assert.equal(mapRepo(null), undefined);
  assert.equal(mapRepo('not-an-object'), undefined);
  assert.equal(mapRepo({ name: 'x', owner: { login: 'o' }, clone_url: 'u' }), undefined, 'no full_name');
  assert.equal(mapRepo({ full_name: 'o/x', name: 'x', clone_url: 'u' }), undefined, 'no owner.login');
  assert.equal(mapRepo({ full_name: 'o/x', name: 'x', owner: { login: 'o' } }), undefined, 'no clone_url');
});

test('filterRepos: case-insensitive substring over name/owner/fullName/description', () => {
  const repos: GithubRepo[] = [
    { fullName: 'octocat/hello', name: 'hello', owner: 'octocat', private: false, cloneUrl: 'u1', description: 'a greeting' },
    { fullName: 'acme/rocket', name: 'rocket', owner: 'acme', private: false, cloneUrl: 'u2' },
    { fullName: 'acme/widget', name: 'widget', owner: 'acme', private: false, cloneUrl: 'u3', description: 'HELLO world' },
  ];
  assert.deepEqual(filterRepos(repos, 'hello').map((r) => r.name), ['hello', 'widget'], 'name + description hits');
  assert.deepEqual(filterRepos(repos, 'ACME').map((r) => r.name), ['rocket', 'widget'], 'owner hit, case-insensitive');
  assert.deepEqual(filterRepos(repos, 'octocat/he').map((r) => r.name), ['hello'], 'fullName hit');
  assert.equal(filterRepos(repos, undefined).length, 3, 'undefined query -> unchanged');
  assert.equal(filterRepos(repos, '   ').length, 3, 'blank query -> unchanged');
  assert.equal(filterRepos(repos, 'zzz').length, 0, 'no match -> empty');
});
