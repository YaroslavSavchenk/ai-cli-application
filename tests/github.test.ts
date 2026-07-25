/**
 * GitHub OAuth device-flow connection (Phase 2b).
 *
 * Two layers:
 *   1. HTTP boundary against the REAL server with NO client_id configured
 *      (AI_SM_GITHUB_CLIENT_ID=''): the not-configured path end-to-end, plus
 *      auth (401 w/o token), method (405), and Host/Origin parity (403) for all
 *      four /api/github/* endpoints. Deterministic + offline — the
 *      not-configured guard short-circuits before any network call.
 *   2. GithubConnection unit tests via the fetch SEAM (no network): the pure
 *      repo mapping + query filter, and the full device-flow state machine
 *      (connecting -> connected), proving the access token is persisted 0600 to
 *      github.json and NEVER surfaces in status()/listRepos(), plus disconnect
 *      (drops github.json) and the 401 -> disconnected invalidation.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  GithubConnection,
  GithubError,
  mapRepo,
  filterRepos,
  type FetchLike,
  type SpawnLike,
} from '../server/github.ts';
import type { Logger } from '../server/config.ts';
import type { GithubRepo } from '../shared/protocol.ts';
import { api, rawRequest, startTestServer, waitUntil, type TestServer } from './helpers.ts';

const noop: Logger = () => {};
const SECRET = 'gho_SUPER_SECRET_TOKEN_do_not_leak';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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

test('not configured: GET /api/github/status -> { configured:false, state:"disconnected" }', async () => {
  const res = await api(server, 'GET', '/api/github/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { configured: false, state: 'disconnected' });
});

test('not configured: POST /api/github/device -> 409 { configured:false } (never crashes, no network)', async () => {
  const res = await api(server, 'POST', '/api/github/device');
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { configured: false });
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

test('all four /api/github/* endpoints require the auth token (401 without it)', async () => {
  const cases: { method: string; path: string }[] = [
    { method: 'GET', path: '/api/github/status' },
    { method: 'POST', path: '/api/github/device' },
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

const RAW_REPO = {
  id: 42,
  full_name: 'octocat/hello',
  name: 'hello',
  owner: { login: 'octocat', id: 1, extra: 'ignored' },
  private: true,
  description: 'a greeting',
  language: 'TypeScript',
  pushed_at: '2026-07-20T10:00:00Z',
  clone_url: 'https://github.com/octocat/hello.git',
  // fields that MUST be dropped:
  ssh_url: 'git@github.com:octocat/hello.git',
  default_branch: 'main',
  permissions: { admin: true },
};

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

// ---------------------------------------------------------------------------
// 2b. Full device flow via the fetch seam (no network)
// ---------------------------------------------------------------------------

test('device flow: connecting -> connected; token persisted 0600, NEVER in status; then disconnect drops github.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-'));
  const file = join(root, 'github.json');
  try {
    let tokenPolls = 0;
    const calls: string[] = [];
    const stub: FetchLike = (url) => {
      calls.push(url);
      if (url === 'https://github.com/login/device/code') {
        return Promise.resolve(
          jsonResponse({
            device_code: 'DEV-CODE-SECRET',
            user_code: 'WDJB-MJHT',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 0.02, // 20ms poll cadence for a fast, deterministic test
          }),
        );
      }
      if (url === 'https://github.com/login/oauth/access_token') {
        tokenPolls += 1;
        if (tokenPolls === 1) {
          return Promise.resolve(jsonResponse({ error: 'authorization_pending' }));
        }
        return Promise.resolve(jsonResponse({ access_token: SECRET, token_type: 'bearer', scope: 'repo' }));
      }
      if (url === 'https://api.github.com/user') {
        return Promise.resolve(jsonResponse({ login: 'octocat', id: 1 }));
      }
      if (url.startsWith('https://api.github.com/user/repos')) {
        return Promise.resolve(jsonResponse([RAW_REPO]));
      }
      return Promise.resolve(jsonResponse({ error: 'unexpected' }, 404));
    };

    const conn = new GithubConnection({ file, log: noop, clientId: 'Iv1.testclientid', fetchImpl: stub });

    // Start: returns the user_code, state connecting, no token anywhere.
    const started = await conn.startDeviceFlow();
    assert.ok(started.ok, 'device flow starts when configured');
    if (started.ok) {
      assert.equal(started.userCode, 'WDJB-MJHT');
      assert.equal(started.verificationUri, 'https://github.com/login/device');
      assert.ok(typeof started.expiresAt === 'string' && started.expiresAt.length > 0);
    }
    const connecting = conn.status();
    assert.equal(connecting.state, 'connecting');
    assert.equal(connecting.userCode, 'WDJB-MJHT');
    assert.ok(!JSON.stringify(connecting).includes(SECRET), 'no token while connecting');

    // The background poll authorizes and connects.
    await waitUntil(() => (conn.status().state === 'connected' ? true : undefined), 'github connected', 5000, 10);
    assert.ok(tokenPolls >= 2, 'authorization_pending must have been polled through');

    const connected = conn.status();
    assert.deepEqual(connected, { configured: true, state: 'connected', login: 'octocat' });
    assert.ok(!JSON.stringify(connected).includes(SECRET), 'status() must NEVER contain the access token');

    // github.json: mode 0600, holds the token, but the token never left via status().
    const st = await stat(file);
    assert.equal(st.mode & 0o777, 0o600, 'github.json must be mode 0600');
    const stored = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    assert.equal(stored['accessToken'], SECRET, 'token IS persisted server-side');
    assert.equal(stored['login'], 'octocat');
    assert.equal(stored['scope'], 'repo');

    // listRepos maps + filters; the token is used as a Bearer but never returned.
    const repos = await conn.listRepos();
    assert.equal(repos.length, 1);
    assert.equal(repos[0]!.fullName, 'octocat/hello');
    assert.ok(!JSON.stringify(repos).includes(SECRET), 'repo list must never contain the token');
    assert.equal((await conn.listRepos('nope')).length, 0, 'query filter applies server-side');

    // Disconnect drops github.json and returns to disconnected.
    await conn.disconnect();
    assert.deepEqual(conn.status(), { configured: true, state: 'disconnected' });
    await assert.rejects(stat(file), 'github.json must be deleted on disconnect');
    await assert.rejects(conn.listRepos(), (e) => e instanceof GithubError && e.status === 409);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('load-on-construction: a github.json with a token boots connected; a 401 on repos invalidates it (-> disconnected, file deleted)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh401-'));
  const file = join(root, 'github.json');
  try {
    await writeFile(
      file,
      JSON.stringify({ accessToken: SECRET, login: 'octocat', scope: 'repo', connectedAt: '2026-07-24T00:00:00Z' }),
      { mode: 0o600 },
    );
    const stub: FetchLike = (url) => {
      if (url.startsWith('https://api.github.com/user/repos')) {
        return Promise.resolve(jsonResponse({ message: 'Bad credentials' }, 401));
      }
      return Promise.resolve(jsonResponse({ error: 'unexpected' }, 404));
    };
    const conn = new GithubConnection({ file, log: noop, clientId: 'Iv1.testclientid', fetchImpl: stub });
    assert.equal(conn.status().state, 'connected', 'stored token -> connected on boot');

    await assert.rejects(conn.listRepos(), (e) => e instanceof GithubError && e.status === 409, '401 surfaces as 409 not-connected');
    assert.deepEqual(conn.status(), { configured: true, state: 'disconnected' }, '401 invalidated the token');
    await assert.rejects(stat(file), 'github.json removed after 401 invalidation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('not-configured GithubConnection (no clientId): startDeviceFlow -> not-configured; listRepos -> 409; status configured:false', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-unconf-'));
  try {
    const conn = new GithubConnection({ file: join(root, 'github.json'), log: noop, clientId: '' });
    assert.deepEqual(conn.status(), { configured: false, state: 'disconnected' });
    const started = await conn.startDeviceFlow();
    assert.deepEqual(started, { ok: false, reason: 'not-configured' });
    await assert.rejects(conn.listRepos(), (e) => e instanceof GithubError && e.status === 409);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2c. Poll edges, boundedness, storage & no-leak safety (added: test-engineer)
//     Every case drives the state machine through the fetch SEAM — no network.
//     Positive transitions wait on conditions (waitUntil); the two NON-event
//     proofs (no re-poll happened) use a bounded delay with a large safety
//     margin — the only sound way to assert "X did not occur".
// ---------------------------------------------------------------------------

test('status() while connecting exposes userCode/verificationUri/expiresAt but NO login, NO token, NO device_code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-connecting-'));
  const file = join(root, 'github.json');
  try {
    const stub: FetchLike = (url) => {
      if (url === 'https://github.com/login/device/code') {
        return Promise.resolve(
          jsonResponse({
            device_code: 'DEV-CODE-SECRET',
            user_code: 'ABCD-1234',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 0.02,
          }),
        );
      }
      // Hold the flow in 'connecting' forever so the status shape is stable.
      return Promise.resolve(jsonResponse({ error: 'authorization_pending' }));
    };
    const conn = new GithubConnection({ file, log: noop, clientId: 'Iv1.testclientid', fetchImpl: stub });
    const started = await conn.startDeviceFlow();
    assert.ok(started.ok, 'flow starts when configured');

    const s = conn.status();
    assert.equal(s.configured, true);
    assert.equal(s.state, 'connecting');
    assert.equal(s.userCode, 'ABCD-1234');
    assert.equal(s.verificationUri, 'https://github.com/login/device');
    assert.equal(typeof s.expiresAt, 'string');
    assert.ok(!('login' in s), 'no login key while connecting');
    const serialized = JSON.stringify(s);
    assert.ok(!serialized.includes('DEV-CODE-SECRET'), 'the device_code must NEVER surface in status');
    assert.ok(!serialized.includes(SECRET), 'no access token while connecting');
    await assert.rejects(stat(file), 'no github.json is written while merely connecting');

    await conn.disconnect(); // clear the pending poll timer before teardown
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('poll edge: slow_down grows the interval (no re-poll within the original cadence) and keeps connecting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-slow-'));
  const file = join(root, 'github.json');
  try {
    let tokenPolls = 0;
    const stub: FetchLike = (url) => {
      if (url === 'https://github.com/login/device/code') {
        return Promise.resolve(
          jsonResponse({
            device_code: 'DC',
            user_code: 'SLOW-0001',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 0.02, // 20ms original cadence
          }),
        );
      }
      if (url === 'https://github.com/login/oauth/access_token') {
        tokenPolls += 1;
        return Promise.resolve(jsonResponse({ error: 'slow_down' }));
      }
      return Promise.resolve(jsonResponse({ error: 'unexpected' }, 404));
    };
    const conn = new GithubConnection({ file, log: noop, clientId: 'Iv1.x', fetchImpl: stub });
    await conn.startDeviceFlow();

    // Wait for the FIRST token poll (the slow_down) to land.
    await waitUntil(() => (tokenPolls >= 1 ? true : undefined), 'first token poll', 5000, 5);
    const afterFirst = tokenPolls;
    assert.equal(afterFirst, 1);

    // Original cadence was 20ms; slow_down adds +5000ms. Well past 10x the
    // original interval there is NO second poll (proves the interval grew), and
    // the flow is still connecting (slow_down is not a failure).
    await delay(300);
    assert.equal(tokenPolls, afterFirst, 'slow_down pushed the next poll out past the original 20ms cadence');
    assert.equal(conn.status().state, 'connecting', 'slow_down keeps polling, does not disconnect');

    await conn.disconnect();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const errCode of ['expired_token', 'access_denied'] as const) {
  test(`poll edge: ${errCode} -> disconnected, token never stored, polling stops`, async () => {
    const root = await mkdtemp(join(tmpdir(), `ai-sm-gh-${errCode}-`));
    const file = join(root, 'github.json');
    try {
      let tokenPolls = 0;
      const stub: FetchLike = (url) => {
        if (url === 'https://github.com/login/device/code') {
          return Promise.resolve(
            jsonResponse({
              device_code: 'DC',
              user_code: 'X-CODE',
              verification_uri: 'https://github.com/login/device',
              expires_in: 900,
              interval: 0.02,
            }),
          );
        }
        if (url === 'https://github.com/login/oauth/access_token') {
          tokenPolls += 1;
          return Promise.resolve(jsonResponse({ error: errCode }));
        }
        return Promise.resolve(jsonResponse({ error: 'unexpected' }, 404));
      };
      const conn = new GithubConnection({ file, log: noop, clientId: 'Iv1.x', fetchImpl: stub });
      await conn.startDeviceFlow();

      await waitUntil(
        () => (conn.status().state === 'disconnected' ? true : undefined),
        `${errCode} disconnect`,
        5000,
        5,
      );
      assert.deepEqual(conn.status(), { configured: true, state: 'disconnected' });
      await assert.rejects(stat(file), 'no github.json after a terminal poll error');

      // Polling truly stopped — no further token polls after the terminal error.
      const settled = tokenPolls;
      await delay(150);
      assert.equal(tokenPolls, settled, 'polling stopped after the terminal error');

      await assert.rejects(conn.listRepos(), (e) => e instanceof GithubError && e.status === 409);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('bounded: the device-code expiry stops polling and returns to disconnected (never connects, no token)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-expiry-'));
  const file = join(root, 'github.json');
  try {
    let tokenPolls = 0;
    const stub: FetchLike = (url) => {
      if (url === 'https://github.com/login/device/code') {
        return Promise.resolve(
          jsonResponse({
            device_code: 'DC',
            user_code: 'X-CODE',
            verification_uri: 'https://github.com/login/device',
            expires_in: 0.05, // 50ms lifetime — expires almost immediately
            interval: 0.02,
          }),
        );
      }
      if (url === 'https://github.com/login/oauth/access_token') {
        tokenPolls += 1;
        return Promise.resolve(jsonResponse({ error: 'authorization_pending' }));
      }
      return Promise.resolve(jsonResponse({ error: 'unexpected' }, 404));
    };
    const conn = new GithubConnection({ file, log: noop, clientId: 'Iv1.x', fetchImpl: stub });
    await conn.startDeviceFlow();

    await waitUntil(
      () => (conn.status().state === 'disconnected' ? true : undefined),
      'expiry disconnect',
      5000,
      5,
    );
    await assert.rejects(stat(file), 'expiry must never write a token');

    const settled = tokenPolls;
    await delay(200);
    assert.equal(tokenPolls, settled, 'polling stopped at expiry — it does not poll forever');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bounded: polling is hard-capped at MAX_POLLS (exactly 300 token polls) then disconnects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-maxpolls-'));
  const file = join(root, 'github.json');
  try {
    let tokenPolls = 0;
    const stub: FetchLike = (url) => {
      if (url === 'https://github.com/login/device/code') {
        return Promise.resolve(
          jsonResponse({
            device_code: 'DC',
            user_code: 'X-CODE',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900, // long enough that ONLY MAX_POLLS ends the flow
            interval: 0.002, // 2ms — drives the cap fast; still bounded
          }),
        );
      }
      if (url === 'https://github.com/login/oauth/access_token') {
        tokenPolls += 1;
        return Promise.resolve(jsonResponse({ error: 'authorization_pending' }));
      }
      return Promise.resolve(jsonResponse({ error: 'unexpected' }, 404));
    };
    const conn = new GithubConnection({ file, log: noop, clientId: 'Iv1.x', fetchImpl: stub });
    await conn.startDeviceFlow();

    await waitUntil(
      () => (conn.status().state === 'disconnected' ? true : undefined),
      'MAX_POLLS disconnect',
      15000,
      10,
    );
    // pollCount reaches 301, then disconnects WITHOUT a fetch, so EXACTLY 300
    // token requests are made — never a 301st, never unbounded.
    assert.equal(tokenPolls, 300, 'exactly MAX_POLLS token polls, then a hard stop');
    await assert.rejects(stat(file), 'the poll cap must never write a token');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('not configured (empty clientId): status/device/repos/disconnect make ZERO network calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-noconf-nofetch-'));
  try {
    let fetchCalls = 0;
    const stub: FetchLike = () => {
      fetchCalls += 1;
      return Promise.resolve(jsonResponse({ error: 'should-never-be-called' }, 500));
    };
    const conn = new GithubConnection({
      file: join(root, 'github.json'),
      log: noop,
      clientId: '',
      fetchImpl: stub,
    });
    assert.deepEqual(conn.status(), { configured: false, state: 'disconnected' });
    assert.deepEqual(await conn.startDeviceFlow(), { ok: false, reason: 'not-configured' });
    await assert.rejects(conn.listRepos(), (e) => e instanceof GithubError && e.status === 409);
    await conn.disconnect();
    assert.equal(fetchCalls, 0, 'the not-configured guard short-circuits before any fetch');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('storage: malformed / missing-token / absent github.json on construction -> disconnected, no crash, no fetch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-storage-'));
  try {
    let fetchCalls = 0;
    const stub: FetchLike = () => {
      fetchCalls += 1;
      return Promise.resolve(jsonResponse({}, 500));
    };

    // (1) invalid JSON on disk
    const badFile = join(root, 'bad.json');
    await writeFile(badFile, '{ this is not json', { mode: 0o600 });
    const c1 = new GithubConnection({ file: badFile, log: noop, clientId: 'Iv1.x', fetchImpl: stub });
    assert.deepEqual(c1.status(), { configured: true, state: 'disconnected' }, 'malformed json -> disconnected');

    // (2) valid JSON object but no accessToken field
    const noTokFile = join(root, 'notoken.json');
    await writeFile(noTokFile, JSON.stringify({ login: 'octocat', scope: 'repo' }), { mode: 0o600 });
    const c2 = new GithubConnection({ file: noTokFile, log: noop, clientId: 'Iv1.x', fetchImpl: stub });
    assert.deepEqual(c2.status(), { configured: true, state: 'disconnected' }, 'missing accessToken -> disconnected');

    // (3) absent file entirely
    const c3 = new GithubConnection({ file: join(root, 'absent.json'), log: noop, clientId: 'Iv1.x', fetchImpl: stub });
    assert.deepEqual(c3.status(), { configured: true, state: 'disconnected' }, 'absent file -> disconnected');

    assert.equal(fetchCalls, 0, 'construction + status never touch the network');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('listRepos: sends the stored token as a Bearer, drops unmappable entries, stops after a short page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-repos-'));
  const file = join(root, 'github.json');
  try {
    await writeFile(
      file,
      JSON.stringify({ accessToken: SECRET, login: 'octocat', scope: 'repo', connectedAt: '2026-07-24T00:00:00Z' }),
      { mode: 0o600 },
    );
    let repoFetches = 0;
    let authHeader: string | undefined;
    const stub: FetchLike = (url, init) => {
      if (url.startsWith('https://api.github.com/user/repos')) {
        repoFetches += 1;
        const h = (init?.headers ?? {}) as Record<string, string>;
        authHeader = h['Authorization'];
        // One valid repo + one unmappable (no clone_url): the bad one is dropped;
        // length 2 < REPOS_PER_PAGE(100) signals the last page -> no 2nd fetch.
        return Promise.resolve(
          jsonResponse([RAW_REPO, { full_name: 'o/x', name: 'x', owner: { login: 'o' } }]),
        );
      }
      return Promise.resolve(jsonResponse({ error: 'unexpected' }, 404));
    };
    const conn = new GithubConnection({ file, log: noop, clientId: 'Iv1.x', fetchImpl: stub });
    assert.equal(conn.status().state, 'connected', 'stored token -> connected on boot');

    const repos = await conn.listRepos();
    assert.equal(repos.length, 1, 'unmappable entries are dropped');
    assert.equal(repos[0]!.fullName, 'octocat/hello');
    assert.equal(repoFetches, 1, 'a short page (<100) stops pagination after one request');
    assert.equal(authHeader, `Bearer ${SECRET}`, 'the stored token is sent as a Bearer (server-side only)');
    assert.ok(!JSON.stringify(repos).includes(SECRET), 'the mapped repo list never contains the token');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Phase 2c: createRepo (fetch seam) + cloneAuthenticated (spawn seam)
// ---------------------------------------------------------------------------

/** A connected connection loaded straight from a github.json holding SECRET. */
async function connectedConn(
  root: string,
  opts: { fetchImpl?: FetchLike; spawnImpl?: SpawnLike } = {},
): Promise<GithubConnection> {
  const file = join(root, 'github.json');
  await writeFile(
    file,
    JSON.stringify({ accessToken: SECRET, login: 'octocat', scope: 'repo', connectedAt: '2026-07-24T00:00:00Z' }),
    { mode: 0o600 },
  );
  return new GithubConnection({ file, log: noop, clientId: 'Iv1.x', ...opts });
}

test('createRepo: POSTs /user/repos with Bearer header + JSON body; maps to GithubRepo; token never in the result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-create-'));
  try {
    let calledMethod: string | undefined;
    let authHeader: string | undefined;
    let sentBody: unknown;
    const stub: FetchLike = (url, init) => {
      if (url === 'https://api.github.com/user/repos' && (init?.method ?? 'GET') === 'POST') {
        calledMethod = init?.method;
        const h = (init?.headers ?? {}) as Record<string, string>;
        authHeader = h['Authorization'];
        sentBody = JSON.parse(String(init?.body));
        return Promise.resolve(
          jsonResponse(
            {
              id: 999,
              node_id: 'R_x',
              full_name: 'octocat/newrepo',
              name: 'newrepo',
              owner: { login: 'octocat', id: 1 },
              private: true,
              description: 'made in app',
              clone_url: 'https://github.com/octocat/newrepo.git',
              ssh_url: 'git@github.com:octocat/newrepo.git',
            },
            201,
          ),
        );
      }
      return Promise.resolve(jsonResponse({ error: 'unexpected' }, 404));
    };
    const conn = await connectedConn(root, { fetchImpl: stub });
    const repo = await conn.createRepo({ name: 'newrepo', private: true, description: 'made in app' });
    assert.deepEqual(repo, {
      fullName: 'octocat/newrepo',
      name: 'newrepo',
      owner: 'octocat',
      private: true,
      description: 'made in app',
      cloneUrl: 'https://github.com/octocat/newrepo.git',
    });
    assert.equal(calledMethod, 'POST');
    assert.equal(authHeader, `Bearer ${SECRET}`, 'token is a Bearer header, server-side only');
    assert.deepEqual(sentBody, { name: 'newrepo', private: true, description: 'made in app' });
    assert.ok(!JSON.stringify(repo).includes(SECRET), 'the created repo shape never contains the token');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createRepo: 422 from GitHub -> clean GithubError(422), no raw body / no token surfaced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-create422-'));
  try {
    const stub: FetchLike = (url, init) => {
      if (url === 'https://api.github.com/user/repos' && (init?.method ?? 'GET') === 'POST') {
        return Promise.resolve(
          jsonResponse({ message: 'Repository creation failed.', errors: [{ message: 'name already exists' }] }, 422),
        );
      }
      return Promise.resolve(jsonResponse({ error: 'unexpected' }, 404));
    };
    const conn = await connectedConn(root, { fetchImpl: stub });
    await assert.rejects(
      conn.createRepo({ name: 'taken', private: false }),
      (e) => e instanceof GithubError && e.status === 422 && !e.message.includes('already exists'),
      '422 surfaces a clean message, never the raw GitHub body',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createRepo: requires connected state (409 when disconnected)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-create409-'));
  try {
    const conn = new GithubConnection({ file: join(root, 'github.json'), log: noop, clientId: 'Iv1.x' });
    await assert.rejects(
      conn.createRepo({ name: 'x', private: false }),
      (e) => e instanceof GithubError && e.status === 409,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cloneAuthenticated: cloneUrl is validated FIRST — non-github host / non-https / -leading / creds / port -> 400', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-cloneval-'));
  const work = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-gh-clonework-')));
  try {
    // Not connected: cloneUrl is rejected BEFORE the connection/token is touched,
    // proving the token can never be aimed at a non-github host.
    const conn = new GithubConnection({ file: join(root, 'github.json'), log: noop, clientId: 'Iv1.x' });
    const dest = join(work, 'dest');
    const bad = [
      'https://evil.example.com/o/r.git',
      'https://github.com.evil.com/o/r.git',
      'http://github.com/o/r.git',
      'ssh://git@github.com/o/r.git',
      'git@github.com:o/r.git',
      'file:///etc/passwd',
      '-oProxyCommand=evil',
      'ext::sh -c whoami',
      'https://user:pass@github.com/o/r.git',
      'https://github.com:8443/o/r.git',
      'not a url',
    ];
    for (const url of bad) {
      await assert.rejects(
        conn.cloneAuthenticated(url, dest),
        (e) => e instanceof GithubError && e.status === 400,
        `cloneUrl ${JSON.stringify(url)} must be rejected 400`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test('cloneAuthenticated: a valid github url passes validation, then requires a connection (409 when disconnected)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-clone409-'));
  const work = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-gh-clone409w-')));
  try {
    const conn = new GithubConnection({ file: join(root, 'github.json'), log: noop, clientId: 'Iv1.x' });
    await assert.rejects(
      conn.cloneAuthenticated('https://github.com/octocat/hello.git', join(work, 'd2')),
      (e) => e instanceof GithubError && e.status === 409,
      'valid url + not connected -> 409 (validation passed)',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test('cloneAuthenticated: the token goes ONLY via GIT_ASKPASS env — NEVER into argv or the clone url', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-cloneargv-'));
  const work = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-gh-cloneargvw-')));
  try {
    let capturedCmd: string | undefined;
    let capturedArgs: string[] | undefined;
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let capturedStdio: unknown;
    let capturedShell: unknown;
    const spawnStub: SpawnLike = (cmd, args, opts) => {
      capturedCmd = cmd;
      capturedArgs = args;
      capturedEnv = opts.env;
      capturedStdio = opts.stdio;
      capturedShell = opts.shell;
      const child = new EventEmitter();
      // Simulate a successful clone; no real .git/config is written (the leak
      // check reads it best-effort and ignores an absent file).
      setTimeout(() => child.emit('close', 0), 0);
      return child as unknown as ChildProcess;
    };
    const neverFetch: FetchLike = () => Promise.reject(new Error('no network in this test'));
    const conn = await connectedConn(root, { fetchImpl: neverFetch, spawnImpl: spawnStub });

    const dest = join(work, 'cloned');
    await conn.cloneAuthenticated('https://github.com/octocat/hello.git', dest);

    assert.equal(capturedCmd, 'git');
    const argv = capturedArgs ?? [];
    assert.ok(argv.includes('clone'), 'git clone');
    assert.ok(argv.includes('--'), '-- guard present');
    assert.ok(
      argv.includes('https://x-access-token@github.com/octocat/hello.git'),
      'url carries only the non-secret x-access-token username',
    );
    assert.ok(argv.includes(dest), 'dest is an argv element');
    // credential.helper cleared so no helper caches the token to disk.
    const credIdx = argv.indexOf('credential.helper=');
    assert.ok(credIdx > 0 && argv[credIdx - 1] === '-c', 'credential.helper is cleared via -c');

    // The crux: the token is NOWHERE in argv, and NOWHERE in the url.
    assert.ok(!JSON.stringify(argv).includes(SECRET), 'the token is NEVER in argv');
    const urlArg = argv.find((a) => a.startsWith('https://'));
    assert.ok(urlArg !== undefined && !urlArg.includes(SECRET), 'the token is NEVER in the clone url');

    // The token is supplied ONLY through the env, for GIT_ASKPASS to read.
    assert.equal(capturedEnv?.['AI_SM_GH_TOKEN'], SECRET, 'token supplied via AI_SM_GH_TOKEN env only');
    assert.ok(
      typeof capturedEnv?.['GIT_ASKPASS'] === 'string' && (capturedEnv['GIT_ASKPASS'] as string).length > 0,
      'GIT_ASKPASS script path wired into the env',
    );
    assert.equal(capturedEnv?.['GIT_TERMINAL_PROMPT'], '0', 'git prompts are disabled (fail fast, no hang)');
    assert.equal(capturedStdio, 'ignore', 'git output is never buffered/logged (could echo a credential)');
    assert.equal(capturedShell, false, 'no shell — argv only');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test('cloneAuthenticated: reuses the no-clobber rule — a non-empty dest -> 409 (never runs git)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-clobber-'));
  const work = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-gh-clobberw-')));
  try {
    let spawned = false;
    const spawnStub: SpawnLike = () => {
      spawned = true;
      const child = new EventEmitter();
      setTimeout(() => child.emit('close', 0), 0);
      return child as unknown as ChildProcess;
    };
    const conn = await connectedConn(root, {
      fetchImpl: () => Promise.reject(new Error('no network')),
      spawnImpl: spawnStub,
    });
    const dest = join(work, 'nonempty');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dest);
    await writeFile(join(dest, 'keep.txt'), 'precious\n');
    await assert.rejects(
      conn.cloneAuthenticated('https://github.com/octocat/hello.git', dest),
      (e) => e instanceof GithubError && e.status === 409,
      'non-empty dest -> 409',
    );
    assert.equal(spawned, false, 'git is never spawned when the dest is non-empty');
    assert.equal(await readFile(join(dest, 'keep.txt'), 'utf8'), 'precious\n', 'existing file untouched');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test('cloneAuthenticated: an UN-NORMALIZED dest is resolved before any filesystem decision — a `..` component can never make the failure cleanup delete a pre-existing tree', async () => {
  // REGRESSION (security). `dest = <victim>/<owner>/..` reads as a path whose
  // parent does not exist, but RESOLVES to the pre-existing <victim>. Before the
  // fix that split the two: statSync failed -> `existedBefore = false`, step 3b
  // created <victim>/<owner>, git got `<victim>/<owner>/..` (= a non-empty
  // <victim>) and failed, and the cleanup ran `rmSync(dest, {recursive:true})`
  // — which the kernel resolves through the `..`, emptying <victim>.
  // cloneAuthenticated now normalizes FIRST, so every decision (stat, mkdir,
  // git argv, cleanup) is about the same directory: the resolved one.
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-dotdot-'));
  const work = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-gh-dotdotw-')));
  try {
    const victim = join(work, 'important');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(victim, 'sub'), { recursive: true });
    await writeFile(join(victim, 'precious.txt'), 'do not delete\n');
    await writeFile(join(victim, 'sub', 'more.txt'), 'also precious\n');

    let spawned = false;
    const conn = await connectedConn(root, {
      fetchImpl: () => Promise.reject(new Error('no network')),
      // Real git refuses a non-empty destination and exits non-zero — the exact
      // failure that used to trigger the destructive cleanup.
      spawnImpl: () => fakeChild(128, () => { spawned = true; }),
    });

    // Concatenated, not path.join()'d: join() would normalize the `..` away, and
    // the un-normalized string is exactly what a JSON body can carry.
    await assert.rejects(
      conn.cloneAuthenticated('https://github.com/acme/api.git', `${victim}/acme/..`),
      (e) => e instanceof GithubError,
      'an un-normalized dest is refused, not cloned into',
    );

    assert.equal(
      await readFile(join(victim, 'precious.txt'), 'utf8'),
      'do not delete\n',
      'the pre-existing directory this request never created is untouched',
    );
    assert.equal(await readFile(join(victim, 'sub', 'more.txt'), 'utf8'), 'also precious\n');
    assert.equal(existsSync(join(victim, 'acme')), false, 'no owner directory was materialised');
    assert.equal(spawned, false, 'the resolved dest is non-empty, so git is never spawned');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The normalization above is ONE resolve() feeding SIX filesystem decisions
// (existedBefore, assertVacant, the step-3b owner-dir allowance, the git argv,
// the failure cleanup, the .git/config leak guard). The test above only reaches
// the FIRST of them that refuses — assertVacant 409s and shadows everything
// downstream — so it cannot tell "resolved once, used everywhere" apart from
// "resolved once, then one consumer handed the raw string".
//
// These three drive an un-normalized dest that PASSES the vacancy check
// (`<landing>/acme/..`, where `<landing>` exists and is empty), so execution
// reaches each remaining consumer. The raw string and the resolved one differ
// for real here: the kernel walks `<landing>/acme` first and fails ENOENT
// because it does not exist, while path.resolve is purely lexical and lands on
// `<landing>`.
// ---------------------------------------------------------------------------

/** `<work>/landing` (existing + empty) and the un-normalized dest resolving to it. */
function landingPair(work: string): { landing: string; raw: string } {
  const landing = join(work, 'landing');
  mkdirSync(landing, { recursive: true });
  // Concatenated, not join()'d — join() would normalize the `..` away.
  return { landing, raw: `${landing}/acme/..` };
}

test('cloneAuthenticated: git and the owner-dir allowance both act on the RESOLVED dest — no directory is materialised for the raw string', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-res1-'));
  const work = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-gh-res1w-')));
  try {
    const { landing, raw } = landingPair(work);
    let gitDest: string | undefined;
    let ownerDirAtSpawn = true;
    const conn = await connectedConn(root, {
      fetchImpl: () => Promise.reject(new Error('no network')),
      spawnImpl: (_cmd, args) =>
        fakeChild(0, () => {
          gitDest = args[args.length - 1];
          // Step 3b runs BEFORE the spawn, so a raw-string parent would have
          // created `<landing>/acme` by now — and a failing clone would then
          // remove it again, which is why this is sampled here and not after.
          ownerDirAtSpawn = existsSync(join(landing, 'acme'));
        }),
    });

    await conn.cloneAuthenticated('https://github.com/acme/api.git', raw);

    assert.equal(gitDest, landing, 'git is handed the resolved dest, never the `..` string');
    assert.equal(ownerDirAtSpawn, false, 'the raw string names a missing `acme` parent — it must not be created');
    assert.equal(existsSync(join(landing, 'acme')), false, 'and nothing is left behind afterwards either');
    assert.ok(existsSync(landing), 'the destination itself is untouched');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test('cloneAuthenticated: `existedBefore` is decided on the RESOLVED dest — a failed clone never removes a directory that already existed', async () => {
  // The consumer that decides whether the cleanup may delete anything at all.
  // Reading it from the raw string makes statSync fail (ENOENT on the missing
  // `acme` component) -> existedBefore=false -> the recursive rmSync then runs
  // on the RESOLVED, pre-existing directory.
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-res2-'));
  const work = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-gh-res2w-')));
  try {
    const { landing, raw } = landingPair(work);
    const conn = await connectedConn(root, {
      fetchImpl: () => Promise.reject(new Error('no network')),
      spawnImpl: () => fakeChild(128),
    });

    await assert.rejects(
      conn.cloneAuthenticated('https://github.com/acme/api.git', raw),
      (e) => e instanceof GithubError && e.status === 502,
      'the clone still fails 502',
    );
    assert.ok(existsSync(landing), 'the pre-existing destination survives the failure cleanup');
    assert.equal(existsSync(join(landing, 'acme')), false, 'and no owner directory was created for the raw string');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test('cloneAuthenticated: the credential-leak guard reads the RESOLVED .git/config — it cannot be silenced by an un-normalized dest', async () => {
  // End-to-end pin on the security-relevant consumer, and honest about its
  // strength: swapping `destAbs` for the raw string HERE is not observable,
  // because the read goes through `path.join`, which normalizes the `..` away
  // by itself. So this is defence in depth over that accident — it fails if the
  // leak guard is removed, reordered before the clone, or pointed at a path
  // that path.join does not normalize for it.
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-res3-'));
  const work = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-gh-res3w-')));
  try {
    const { landing, raw } = landingPair(work);
    const conn = await connectedConn(root, {
      fetchImpl: () => Promise.reject(new Error('no network')),
      spawnImpl: () =>
        fakeChild(0, () => {
          mkdirSync(join(landing, '.git'), { recursive: true });
          writeFileSync(
            join(landing, '.git', 'config'),
            `[remote "origin"]\n  url = https://x-access-token:${SECRET}@github.com/o/r.git\n`,
          );
        }),
    });

    await assert.rejects(
      conn.cloneAuthenticated('https://github.com/acme/api.git', raw),
      (e) => e instanceof GithubError && e.status === 500 && !e.message.includes(SECRET),
      'the leak is still detected, and the message never echoes the token',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3b. Phase 2c gap-closure (test-engineer): extends the dev's 2c tests with
//     the token-safety corners they did not assert — the askpass script's own
//     content/cleanup, the .git/config leak guard (both directions), the git-
//     failure cleanup, the never-spawn refusal guards, the two url rejections
//     the dev list omitted (control char, over-length), and createRepo's
//     description-omission / 401-invalidation / clean-502 branches. Every case
//     drives the fetch/spawn SEAMS — NO real network, NO real clone.
// ---------------------------------------------------------------------------

/** A fake ChildProcess that runs `onSpawn` then emits `close(code)` next tick. */
function fakeChild(code: number, onSpawn?: () => void): ChildProcess {
  if (onSpawn !== undefined) onSpawn();
  const child = new EventEmitter();
  setTimeout(() => child.emit('close', code), 0);
  return child as unknown as ChildProcess;
}

test('cloneAuthenticated: #buildAuthenticatedGithubUrl also rejects a control char and an over-length url (400, before any spawn)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-urlextra-'));
  const work = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-gh-urlextraw-')));
  try {
    let spawned = false;
    const conn = new GithubConnection({
      file: join(root, 'github.json'),
      log: noop,
      clientId: 'Iv1.x',
      spawnImpl: () => fakeChild(0, () => { spawned = true; }),
    });
    const dest = join(work, 'dest');
    const controlChar = 'https://github.com/o/r.git'; // 0x01 fails the char scan
    const overLong = 'https://github.com/' + 'a'.repeat(2100) + '.git'; // > MAX_CLONE_URL_LEN(2048)
    for (const url of [controlChar, overLong]) {
      await assert.rejects(
        conn.cloneAuthenticated(url, dest),
        (e) => e instanceof GithubError && e.status === 400,
        `url ${JSON.stringify(url.slice(0, 40))} must be rejected 400`,
      );
    }
    assert.equal(spawned, false, 'a url rejected by validation never reaches git');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test('cloneAuthenticated: the throwaway askpass script prints the token from env, NEVER embeds it, is mode 0700, and is deleted afterward', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-askpass-'));
  const work = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-gh-askpassw-')));
  try {
    let askPath: string | undefined;
    let askBody: string | undefined;
    let askMode: number | undefined;
    const spawnStub: SpawnLike = (_cmd, _args, opts) => {
      askPath = opts.env?.['GIT_ASKPASS'] as string | undefined;
      if (askPath !== undefined) {
        askBody = readFileSync(askPath, 'utf8'); // the script exists at spawn time
        askMode = statSync(askPath).mode & 0o777;
      }
      return fakeChild(0);
    };
    const conn = await connectedConn(root, {
      fetchImpl: () => Promise.reject(new Error('no network in this test')),
      spawnImpl: spawnStub,
    });
    const dest = join(work, 'cloned');
    await conn.cloneAuthenticated('https://github.com/octocat/hello.git', dest);

    // The script reads the token from the env var — it does NOT contain the token.
    assert.equal(askBody, '#!/bin/sh\nprintf \'%s\' "$AI_SM_GH_TOKEN"\n', 'askpass reads AI_SM_GH_TOKEN from env');
    assert.ok(askBody !== undefined && !askBody.includes(SECRET), 'the askpass script NEVER embeds the token');
    assert.equal(askMode, 0o700, 'the askpass script is mode 0700 (owner-only)');
    assert.ok(askPath !== undefined && !existsSync(askPath), 'the throwaway askpass script is deleted after the clone');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test('cloneAuthenticated: a .git/config that leaked the token aborts 500 (clean message) and removes the freshly-created dest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-leak-'));
  const work = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-gh-leakw-')));
  try {
    const dest = join(work, 'cloned');
    const spawnStub: SpawnLike = () =>
      fakeChild(0, () => {
        // Simulate a clone whose config accidentally embedded the token on disk.
        mkdirSync(join(dest, '.git'), { recursive: true });
        writeFileSync(
          join(dest, '.git', 'config'),
          `[remote "origin"]\n  url = https://x-access-token:${SECRET}@github.com/o/r.git\n`,
        );
      });
    const conn = await connectedConn(root, {
      fetchImpl: () => Promise.reject(new Error('no network')),
      spawnImpl: spawnStub,
    });
    await assert.rejects(
      conn.cloneAuthenticated('https://github.com/octocat/hello.git', dest),
      (e) => e instanceof GithubError && e.status === 500 && !e.message.includes(SECRET),
      'a token in .git/config aborts 500 with a message that never echoes the token',
    );
    assert.ok(!existsSync(dest), 'the poisoned clone is removed — no token is left on disk');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test('cloneAuthenticated: a clean .git/config (no token) is accepted and the clone is kept (leak guard does not false-positive)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-clean-'));
  const work = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-gh-cleanw-')));
  try {
    const dest = join(work, 'cloned');
    const spawnStub: SpawnLike = () =>
      fakeChild(0, () => {
        mkdirSync(join(dest, '.git'), { recursive: true });
        writeFileSync(
          join(dest, '.git', 'config'),
          `[remote "origin"]\n  url = https://x-access-token@github.com/o/r.git\n`,
        );
      });
    const conn = await connectedConn(root, {
      fetchImpl: () => Promise.reject(new Error('no network')),
      spawnImpl: spawnStub,
    });
    await conn.cloneAuthenticated('https://github.com/octocat/hello.git', dest);
    assert.ok(existsSync(join(dest, '.git', 'config')), 'a clean clone is kept');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test('cloneAuthenticated: a non-zero git exit -> 502 and the partial dest WE created is removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-fail-'));
  const work = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-gh-failw-')));
  try {
    const dest = join(work, 'cloned');
    const spawnStub: SpawnLike = () =>
      fakeChild(1, () => {
        mkdirSync(dest, { recursive: true }); // git makes the leaf dir before failing
      });
    const conn = await connectedConn(root, {
      fetchImpl: () => Promise.reject(new Error('no network')),
      spawnImpl: spawnStub,
    });
    await assert.rejects(
      conn.cloneAuthenticated('https://github.com/octocat/hello.git', dest),
      (e) => e instanceof GithubError && e.status === 502,
      'git exit != 0 -> 502',
    );
    assert.ok(!existsSync(dest), 'a dest WE created is removed on clone failure (no partial left behind)');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test('cloneAuthenticated: never spawns git when it will refuse — not-connected (409) and a missing parent (400)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-nospawn-'));
  const work = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-gh-nospawnw-')));
  try {
    let spawned = false;
    const spy: SpawnLike = () => fakeChild(0, () => { spawned = true; });

    // (1) valid url, but NOT connected -> 409 before any spawn (constructed while
    //     github.json is still absent).
    const disc = new GithubConnection({ file: join(root, 'github.json'), log: noop, clientId: 'Iv1.x', spawnImpl: spy });
    await assert.rejects(
      disc.cloneAuthenticated('https://github.com/octocat/hello.git', join(work, 'd1')),
      (e) => e instanceof GithubError && e.status === 409,
      'valid url + not connected -> 409',
    );

    // (2) connected, but the dest PARENT does not exist -> 400 before any spawn.
    const conn = await connectedConn(root, { fetchImpl: () => Promise.reject(new Error('no network')), spawnImpl: spy });
    await assert.rejects(
      conn.cloneAuthenticated('https://github.com/octocat/hello.git', join(work, 'missing-parent', 'child')),
      (e) => e instanceof GithubError && e.status === 400,
      'connected + missing parent -> 400',
    );

    assert.equal(spawned, false, 'git is never spawned on a refused clone');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test('createRepo: omits `description` from the request body when not provided (body is exactly { name, private })', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-nodesc-'));
  try {
    let sentBody: unknown;
    const stub: FetchLike = (url, init) => {
      if (url === 'https://api.github.com/user/repos' && (init?.method ?? 'GET') === 'POST') {
        sentBody = JSON.parse(String(init?.body));
        return Promise.resolve(
          jsonResponse(
            { full_name: 'octocat/np', name: 'np', owner: { login: 'octocat' }, private: false, clone_url: 'https://github.com/octocat/np.git' },
            201,
          ),
        );
      }
      return Promise.resolve(jsonResponse({ error: 'unexpected' }, 404));
    };
    const conn = await connectedConn(root, { fetchImpl: stub });
    await conn.createRepo({ name: 'np', private: false });
    assert.deepEqual(sentBody, { name: 'np', private: false }, 'no description sent when omitted');
    assert.ok(
      sentBody !== null && typeof sentBody === 'object' && !('description' in (sentBody as object)),
      'the description key is absent, not sent as undefined/null',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createRepo: a 401 from GitHub invalidates the token (-> disconnected, github.json deleted) and throws 409', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-gh-create401-'));
  const file = join(root, 'github.json');
  try {
    const stub: FetchLike = (url, init) =>
      url === 'https://api.github.com/user/repos' && (init?.method ?? 'GET') === 'POST'
        ? Promise.resolve(jsonResponse({ message: 'Bad credentials' }, 401))
        : Promise.resolve(jsonResponse({ error: 'unexpected' }, 404));
    const conn = await connectedConn(root, { fetchImpl: stub });
    assert.equal(conn.status().state, 'connected', 'stored token -> connected on boot');
    await assert.rejects(
      conn.createRepo({ name: 'x', private: false }),
      (e) => e instanceof GithubError && e.status === 409,
      '401 on create surfaces as 409 not-connected',
    );
    assert.deepEqual(conn.status(), { configured: true, state: 'disconnected' }, '401 invalidated the token');
    await assert.rejects(stat(file), 'github.json is removed after the 401 invalidation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createRepo: an unmappable 201 payload -> 502; a 5xx -> clean 502 (never the raw github body)', async () => {
  const rootA = await mkdtemp(join(tmpdir(), 'ai-sm-gh-c502a-'));
  const rootB = await mkdtemp(join(tmpdir(), 'ai-sm-gh-c502b-'));
  try {
    // (1) 201 but the payload cannot be mapped (no full_name / owner / clone_url).
    const unmappable = await connectedConn(rootA, {
      fetchImpl: (url, init) =>
        url === 'https://api.github.com/user/repos' && (init?.method ?? 'GET') === 'POST'
          ? Promise.resolve(jsonResponse({ id: 1, name: 'x' }, 201))
          : Promise.resolve(jsonResponse({ error: 'unexpected' }, 404)),
    });
    await assert.rejects(
      unmappable.createRepo({ name: 'x', private: false }),
      (e) => e instanceof GithubError && e.status === 502,
      'an unmappable 201 payload -> 502',
    );

    // (2) a 5xx from GitHub -> a clean 502 that never echoes the raw body.
    const errored = await connectedConn(rootB, {
      fetchImpl: (url, init) =>
        url === 'https://api.github.com/user/repos' && (init?.method ?? 'GET') === 'POST'
          ? Promise.resolve(jsonResponse({ message: 'boom-internal' }, 500))
          : Promise.resolve(jsonResponse({ error: 'unexpected' }, 404)),
    });
    await assert.rejects(
      errored.createRepo({ name: 'x', private: false }),
      (e) => e instanceof GithubError && e.status === 502 && !e.message.includes('boom-internal'),
      'a 5xx -> clean 502, never the raw github body',
    );
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});
