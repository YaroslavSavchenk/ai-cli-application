/**
 * The CONNECTED GitHub HTTP surface, exercised OFFLINE.
 *
 * tests/server/github.test.ts (and the files split out of it, github-device-flow /
 * github-clone / github-clone-gaps) covers (a) the not-configured HTTP paths and (b) the
 * GithubConnection object seams (fetchImpl / spawnImpl) in-process. Neither can
 * reach the *connected* HTTP routes, because startTestServer() spawns
 * server/index.ts as a CHILD PROCESS — an in-process object seam does not exist
 * there. Env is the only injection channel, so this file uses:
 *
 *   AI_SM_GITHUB_API_BASE  -> a local node:http stub standing in for the GitHub
 *                             REST API (loopback ONLY; see below),
 *   a pre-seeded github.json (StoredToken shape, mode 0600) in the data dir so
 *                             the server boots already "connected",
 *   AI_SM_GITHUB_CLIENT_ID -> set, since the feature is dormant without it.
 *
 * SECURITY of the knob is part of what is asserted: here, that the override
 * does NOT loosen either the device-flow urls or the clone host-lock on
 * github.com; in tests/server/github-connected-knob.test.ts (split out by
 * topic, PLAN-RESTRUCTURE O6), that it is restricted to loopback origins (the
 * token is a Bearer credential — it must never become sendable to a remote
 * host) and that a non-loopback / credential-bearing / path-bearing value makes
 * the server REFUSE TO START. The stub and the seeded data dir are
 * tests/helpers/github-connected-fixture.ts.
 *
 * NOT covered here, deliberately and honestly: a SUCCESSFUL
 * POST /api/github/clone. cloneAuthenticated() hard-locks the clone url to host
 * exactly github.com, so no local git repo can stand in for it without either
 * loosening that lock (forbidden) or hitting the network (not offline). Only its
 * pre-spawn refusal paths are exercised here; the argv/env token-safety of the
 * spawn itself is covered by the spawn-seam tests in tests/server/github-clone.test.ts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  api,
  rawRequest,
  readServerLog,
  startTestServer,
  type TestServer,
  makeTempDir,
  removeTempDir,
} from '../helpers/helpers.ts';
import {
  SECRET,
  CLIENT_ID,
  StubApi,
  rawRepo,
  seedConnectedDataDir,
} from '../helpers/github-connected-fixture.ts';

// ---------------------------------------------------------------------------
// Shared connected server (non-destructive cases)
// ---------------------------------------------------------------------------

let stub: StubApi;
let server: TestServer;
let root: string;

before(async () => {
  stub = new StubApi();
  await stub.start();
  const seeded = await seedConnectedDataDir('ai-sm-ghc-');
  root = seeded.root;
  server = await startTestServer({
    dataDir: seeded.dataDir,
    env: { AI_SM_GITHUB_CLIENT_ID: CLIENT_ID, AI_SM_GITHUB_API_BASE: stub.origin },
  });
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (stub !== undefined) await stub.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

test('the pre-seeded github.json boots the server CONNECTED; status never carries the token', async () => {
  const res = await api(server, 'GET', '/api/github/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    deviceFlowAvailable: true,
    state: 'connected',
    login: 'octocat',
    // No `source` in the seed file -> reads as the device flow, which is what
    // every record written before the pasted-token path came from.
    source: 'device',
    persisted: true,
  });
  assert.ok(!JSON.stringify(res.body).includes(SECRET), 'status must NEVER contain the access token');
  // The seed file keeps its 0600 mode and stays server-side.
  const st = await stat(join(server.dataDir, 'github.json'));
  assert.equal(st.mode & 0o777, 0o600, 'github.json must be mode 0600');
});

test('connected GET /api/github/repos: 200, mapped repos only, token sent to the API as a Bearer and NEVER returned', async () => {
  stub.reset();
  stub.handler = () => ({ status: 200, body: [rawRepo(1), rawRepo(2)] });

  const res = await api(server, 'GET', '/api/github/repos');
  assert.equal(res.status, 200);
  const body = res.body as { repos: Record<string, unknown>[] };
  assert.equal(body.repos.length, 2);
  assert.deepEqual(body.repos[0], {
    fullName: 'octocat/repo-1',
    name: 'repo-1',
    owner: 'octocat',
    private: false,
    description: 'repo number 1',
    language: 'TypeScript',
    pushedAt: '2026-07-20T10:00:00Z',
    cloneUrl: 'https://github.com/octocat/repo-1.git',
  });
  assert.equal(Object.keys(body.repos[0] as object).length, 8, 'exactly the 8 mapped keys');
  assert.ok(
    !JSON.stringify(res.body).includes('ssh_url'),
    'raw github fields are never forwarded to the browser',
  );
  assert.ok(!JSON.stringify(res.body).includes(SECRET), 'the response must NEVER contain the token');

  // The outbound request the server made against the (stubbed) GitHub API.
  assert.equal(stub.requests.length, 1);
  const out = stub.requests[0]!;
  assert.equal(out.method, 'GET');
  assert.equal(out.path, '/user/repos?per_page=100&sort=pushed&page=1');
  assert.equal(out.authorization, `Bearer ${SECRET}`, 'the token travels as an Authorization header');
  assert.equal(out.accept, 'application/vnd.github+json');
  assert.equal(out.userAgent, 'ai-cli-session-manager');
  assert.equal(out.apiVersion, '2022-11-28');
  assert.ok(!out.path.includes(SECRET), 'the token is NEVER in the request url');
});

test('connected GET /api/github/repos: pagination stops early on a short page', async () => {
  stub.reset();
  stub.handler = (req) => {
    // NB: endsWith, not includes — "per_page=100" also contains "page=1".
    if (req.path.endsWith('&page=1')) {
      return { status: 200, body: Array.from({ length: 100 }, (_, i) => rawRepo(i + 1)) };
    }
    return { status: 200, body: [rawRepo(101), rawRepo(102), rawRepo(103)] };
  };
  const res = await api(server, 'GET', '/api/github/repos');
  assert.equal(res.status, 200);
  assert.equal((res.body as { repos: unknown[] }).repos.length, 103);
  assert.equal(stub.requests.length, 2, 'a page shorter than 100 ends pagination');
  assert.deepEqual(
    stub.requests.map((r) => r.path),
    [
      '/user/repos?per_page=100&sort=pushed&page=1',
      '/user/repos?per_page=100&sort=pushed&page=2',
    ],
  );
});

test('connected GET /api/github/repos: pagination is hard-capped at 5 pages / 500 repos', async () => {
  stub.reset();
  let n = 0;
  stub.handler = () => ({
    // Always a FULL page — only MAX_REPO_PAGES may stop this.
    status: 200,
    body: Array.from({ length: 100 }, () => rawRepo((n += 1))),
  });
  const res = await api(server, 'GET', '/api/github/repos');
  assert.equal(res.status, 200);
  assert.equal((res.body as { repos: unknown[] }).repos.length, 500, 'cap = 5 pages x 100');
  assert.equal(stub.requests.length, 5, 'exactly MAX_REPO_PAGES requests, never unbounded');
  assert.deepEqual(
    stub.requests.map((r) => r.path.replace(/^.*page=/, 'page=')),
    ['page=1', 'page=2', 'page=3', 'page=4', 'page=5'],
  );
});

test('connected GET /api/github/repos?q=: the filter is applied server-side (unmappable entries dropped)', async () => {
  stub.reset();
  stub.handler = () => ({
    status: 200,
    body: [
      rawRepo(1),
      { full_name: 'acme/rocket', name: 'rocket', owner: { login: 'acme' }, clone_url: 'https://github.com/acme/rocket.git' },
      { full_name: 'broken/x', name: 'x', owner: { login: 'broken' } }, // no clone_url -> dropped
    ],
  });
  const all = await api(server, 'GET', '/api/github/repos');
  assert.equal((all.body as { repos: unknown[] }).repos.length, 2, 'the unmappable entry is dropped');

  const filtered = await api(server, 'GET', '/api/github/repos?q=ROCK');
  assert.equal(filtered.status, 200);
  assert.deepEqual(
    (filtered.body as { repos: { name: string }[] }).repos.map((r) => r.name),
    ['rocket'],
    'case-insensitive query filter',
  );
  const none = await api(server, 'GET', '/api/github/repos?q=zzzz');
  assert.deepEqual((none.body as { repos: unknown[] }).repos, []);
});

test('connected GET /api/github/repos: a non-200 from the API -> 502 with a clean message (no raw body)', async () => {
  stub.reset();
  stub.handler = () => ({ status: 500, body: { message: 'boom-internal-github-detail' } });
  const res = await api(server, 'GET', '/api/github/repos');
  assert.equal(res.status, 502);
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes('boom-internal-github-detail'), 'the raw github body is never surfaced');
  assert.ok(!text.includes(SECRET), 'the error path never leaks the token');

  // 403 (rate limit / abuse) maps the same way — 502, never a 200 with junk.
  stub.reset();
  stub.handler = () => ({ status: 403, body: { message: 'API rate limit exceeded' } });
  assert.equal((await api(server, 'GET', '/api/github/repos')).status, 502);
});

test('connected GET /api/github/repos: an unparseable 200 body -> 502 (never a broken 200)', async () => {
  stub.reset();
  stub.handler = () => ({ status: 200, body: 'this is not json' });
  const res = await api(server, 'GET', '/api/github/repos');
  assert.equal(res.status, 502);
});

test('connected /api/github/*: auth + Host/Origin parity, and a rejected request NEVER reaches the GitHub API', async () => {
  stub.reset();
  stub.handler = () => ({ status: 200, body: [rawRepo(1)] });

  const cases: { method: string; path: string }[] = [
    { method: 'GET', path: '/api/github/repos' },
    { method: 'POST', path: '/api/github/repos' },
    { method: 'POST', path: '/api/github/clone' },
    { method: 'GET', path: '/api/github/status' },
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

    const evilHost = await rawRequest(server.port, {
      method: c.method,
      path: c.path,
      headers: { host: `evil.example.com:${server.port}`, 'x-auth-token': server.token },
    });
    assert.equal(evilHost.status, 403, `${c.method} ${c.path} forbidden Host must be 403`);

    const evilOrigin = await rawRequest(server.port, {
      method: c.method,
      path: c.path,
      headers: { origin: 'http://evil.example.com', 'x-auth-token': server.token },
    });
    assert.equal(evilOrigin.status, 403, `${c.method} ${c.path} cross-origin must be 403`);
  }
  assert.equal(
    stub.requests.length,
    0,
    'an unauthenticated / cross-origin request must NEVER trigger a token-bearing call to GitHub',
  );
});

test('connected POST /api/github/repos: creates the repo, maps the payload, token stays in the Authorization header', async () => {
  stub.reset();
  stub.handler = (req) => {
    if (req.method === 'POST' && req.path === '/user/repos') {
      return {
        status: 201,
        body: {
          id: 999,
          full_name: 'octocat/fresh',
          name: 'fresh',
          owner: { login: 'octocat', id: 1 },
          private: true,
          description: 'made in app',
          clone_url: 'https://github.com/octocat/fresh.git',
          ssh_url: 'git@github.com:octocat/fresh.git',
        },
      };
    }
    return { status: 404, body: { message: 'unexpected' } };
  };

  const res = await api(server, 'POST', '/api/github/repos', {
    name: '  fresh  ',
    private: true,
    description: 'made in app',
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, {
    fullName: 'octocat/fresh',
    name: 'fresh',
    owner: 'octocat',
    private: true,
    description: 'made in app',
    cloneUrl: 'https://github.com/octocat/fresh.git',
  });
  assert.ok(!JSON.stringify(res.body).includes(SECRET), 'the created repo never carries the token');

  assert.equal(stub.requests.length, 1);
  const out = stub.requests[0]!;
  assert.equal(out.method, 'POST');
  assert.equal(out.path, '/user/repos');
  assert.equal(out.authorization, `Bearer ${SECRET}`);
  assert.equal(out.contentType, 'application/json');
  assert.deepEqual(JSON.parse(out.body), {
    name: 'fresh', // trimmed by the API layer
    private: true,
    description: 'made in app',
  });
  assert.ok(!out.path.includes(SECRET), 'the token is NEVER in the request url');
});

test('connected POST /api/github/repos: a 422 from GitHub -> 422 with a clean message (no raw body)', async () => {
  stub.reset();
  stub.handler = () => ({
    status: 422,
    body: {
      message: 'Repository creation failed.',
      errors: [{ resource: 'Repository', field: 'name', message: 'name already exists on this account' }],
    },
  });
  const res = await api(server, 'POST', '/api/github/repos', { name: 'taken', private: false });
  assert.equal(res.status, 422);
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes('already exists on this account'), 'the raw github body is never surfaced');
  assert.ok(!text.includes(SECRET));
});

test('connected POST /api/github/repos: a 403 from GitHub -> 403 saying this token cannot create repos (not the opaque 502)', async () => {
  // The most predictable failure of the credential the panel recommends: a
  // fine-grained token limited to selected repositories can list and clone, but
  // cannot create a new repository. It used to fall into `502 github request
  // failed`, which the dialog renders verbatim.
  stub.reset();
  stub.handler = () => ({
    status: 403,
    body: { message: 'Resource not accessible by personal access token' },
  });
  const res = await api(server, 'POST', '/api/github/repos', { name: 'fresh', private: false });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, {
    error:
      'this token cannot create repositories on this account — creating one needs a token with broader access',
  });
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes('Resource not accessible'), 'the raw github body is never surfaced');
  assert.ok(!text.includes(SECRET));
  assert.ok(!/--[A-Za-z]|\brepo\b:|scope/.test(text), 'no flag or scope name in the message');
});

test('connected POST /api/github/repos: body validation rejects BEFORE any call to GitHub', async () => {
  stub.reset();
  stub.handler = () => ({ status: 201, body: { message: 'must not be reached' } });
  const bad: [string, Record<string, unknown>][] = [
    ['blank name', { name: '   ', private: false }],
    ['missing name', { private: false }],
    ['over-long name (>200)', { name: 'a'.repeat(201), private: false }],
    ['non-boolean private', { name: 'ok', private: 'yes' }],
    ['non-string description', { name: 'ok', private: false, description: 42 }],
  ];
  for (const [what, body] of bad) {
    const res = await api(server, 'POST', '/api/github/repos', body);
    assert.equal(res.status, 400, `${what} must be 400`);
  }
  assert.equal(stub.requests.length, 0, 'invalid input never reaches the GitHub API');
});

test('connected POST /api/github/clone: the github.com host-lock still holds — AI_SM_GITHUB_API_BASE does NOT loosen it', async () => {
  stub.reset();
  stub.handler = () => ({ status: 200, body: { message: 'must not be reached' } });
  const work = await makeTempDir('ai-sm-ghc-clonelock-');
  try {
    const bad = [
      stub.origin + '/o/r.git', // the overridden API base itself is NOT a clone target
      'https://127.0.0.1/o/r.git',
      'https://evil.example.com/o/r.git',
      'https://github.com.evil.com/o/r.git',
      'http://github.com/o/r.git',
      'ssh://git@github.com/o/r.git',
      'git@github.com:o/r.git',
      'file:///etc/passwd',
      'https://user:pass@github.com/o/r.git',
      'https://github.com:8443/o/r.git',
      '-oProxyCommand=evil',
      'not a url',
    ];
    for (const cloneUrl of bad) {
      const res = await api(server, 'POST', '/api/github/clone', {
        cloneUrl,
        dest: join(work, 'dest'),
      });
      assert.equal(res.status, 400, `clone url ${JSON.stringify(cloneUrl)} must be rejected 400`);
    }
    assert.equal(stub.requests.length, 0, 'a refused clone never talks to the API');
    assert.deepEqual(
      (await api(server, 'GET', '/api/projects')).body,
      [],
      'a refused clone never registers a project',
    );
  } finally {
    await removeTempDir(work);
  }
});

test('connected POST /api/github/clone: dest rules refuse before git is ever spawned (400 relative / 400 missing parent / 409 non-empty)', async () => {
  const work = await makeTempDir('ai-sm-ghc-clonedest-');
  try {
    const url = 'https://github.com/octocat/hello.git';
    assert.equal(
      (await api(server, 'POST', '/api/github/clone', { cloneUrl: url, dest: 'rel/dir' })).status,
      400,
      'relative dest',
    );
    assert.equal(
      (await api(server, 'POST', '/api/github/clone', { cloneUrl: url, dest: join(work, 'a', 'b') }))
        .status,
      400,
      'missing parent dir',
    );
    assert.equal(
      (await api(server, 'POST', '/api/github/clone', { cloneUrl: url, dest: join(work), name: 7 }))
        .status,
      400,
      'non-string name',
    );

    const nonEmpty = join(work, 'nonempty');
    await mkdir(nonEmpty);
    await writeFile(join(nonEmpty, 'keep.txt'), 'precious\n');
    assert.equal(
      (await api(server, 'POST', '/api/github/clone', { cloneUrl: url, dest: nonEmpty })).status,
      409,
      'non-empty dest -> 409',
    );
    assert.equal(await readFile(join(nonEmpty, 'keep.txt'), 'utf8'), 'precious\n', 'untouched');

    assert.deepEqual(
      (await api(server, 'GET', '/api/projects')).body,
      [],
      'a refused clone never registers a project',
    );
  } finally {
    await removeTempDir(work);
  }
});

test('after the whole connected surface: server.log NEVER contains the access token', async () => {
  const log = await readServerLog(server);
  assert.ok(log.length > 0, 'the server logged something (so this assertion is meaningful)');
  assert.ok(!log.includes(SECRET), 'the OAuth token must never reach server.log');
  assert.ok(!log.includes('Bearer'), 'no Authorization header is ever logged');
});

// ---------------------------------------------------------------------------
// Destructive: a 401 from the API invalidates the stored token (own server)
// ---------------------------------------------------------------------------

test('connected GET /api/github/repos: a 401 from the API invalidates the token -> 409, github.json deleted, status disconnected', async () => {
  const ownStub = new StubApi();
  await ownStub.start();
  ownStub.handler = () => ({ status: 401, body: { message: 'Bad credentials' } });
  const seeded = await seedConnectedDataDir('ai-sm-ghc-401-');
  const srv = await startTestServer({
    dataDir: seeded.dataDir,
    env: { AI_SM_GITHUB_CLIENT_ID: CLIENT_ID, AI_SM_GITHUB_API_BASE: ownStub.origin },
  });
  try {
    assert.equal(
      (await api(srv, 'GET', '/api/github/status')).status,
      200,
      'boots connected from the seed',
    );
    const res = await api(srv, 'GET', '/api/github/repos');
    assert.equal(res.status, 409, 'a 401 upstream surfaces as 409 not-connected');
    assert.ok(!JSON.stringify(res.body).includes(SECRET));

    assert.deepEqual((await api(srv, 'GET', '/api/github/status')).body, {
      deviceFlowAvailable: true,
      state: 'disconnected',
    });
    await assert.rejects(
      stat(join(seeded.dataDir, 'github.json')),
      'the invalidated token file is removed from disk',
    );
    const log = await readServerLog(srv);
    assert.ok(log.includes('github token invalid, disconnected'), 'the invalidation is logged');
    assert.ok(!log.includes(SECRET), 'the log never contains the token');
  } finally {
    await srv.stop();
    await ownStub.stop();
    await rm(seeded.root, { recursive: true, force: true });
  }
});
