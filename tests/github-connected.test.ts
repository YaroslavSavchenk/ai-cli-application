/**
 * The CONNECTED GitHub HTTP surface, exercised OFFLINE.
 *
 * tests/github.test.ts covers (a) the not-configured HTTP paths and (b) the
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
 * SECURITY of the knob itself is part of what is asserted here: the override is
 * restricted to loopback origins (the token is a Bearer credential — it must
 * never become sendable to a remote host), a non-loopback / credential-bearing /
 * path-bearing value makes the server REFUSE TO START, and the override does NOT
 * loosen either the device-flow urls or the clone host-lock on github.com.
 *
 * NOT covered here, deliberately and honestly: a SUCCESSFUL
 * POST /api/github/clone. cloneAuthenticated() hard-locks the clone url to host
 * exactly github.com, so no local git repo can stand in for it without either
 * loosening that lock (forbidden) or hitting the network (not offline). Only its
 * pre-spawn refusal paths are exercised here; the argv/env token-safety of the
 * spawn itself is covered by the spawn-seam tests in tests/github.test.ts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  api,
  projectRoot,
  rawRequest,
  readServerLog,
  startTestServer,
  type TestServer,
} from './helpers.ts';

/** Fake token: never a real credential, but treated as one by every assertion. */
const SECRET = 'gho_STUB_ONLY_NEVER_A_REAL_TOKEN';
const CLIENT_ID = 'Iv1.stubclientid';

// ---------------------------------------------------------------------------
// Local stub for the GitHub REST API (node:http, no new deps)
// ---------------------------------------------------------------------------

interface StubRequest {
  method: string;
  /** Full request target incl. query, e.g. /user/repos?per_page=100&sort=pushed&page=1 */
  path: string;
  authorization: string | undefined;
  accept: string | undefined;
  userAgent: string | undefined;
  apiVersion: string | undefined;
  contentType: string | undefined;
  body: string;
}

interface StubReply {
  status: number;
  /** Objects/arrays are JSON-encoded; a string is sent verbatim (malformed-body cases). */
  body: unknown;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

class StubApi {
  readonly requests: StubRequest[] = [];
  handler: (req: StubRequest) => StubReply = () => ({
    status: 500,
    body: { message: 'stub handler not set' },
  });

  #server: Server = createServer((req, res) => {
    this.#onRequest(req, res);
  });
  #origin = '';

  get origin(): string {
    return this.#origin;
  }

  #onRequest(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const record: StubRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        authorization: header(req, 'authorization'),
        accept: header(req, 'accept'),
        userAgent: header(req, 'user-agent'),
        apiVersion: header(req, 'x-github-api-version'),
        contentType: header(req, 'content-type'),
        body: Buffer.concat(chunks).toString('utf8'),
      };
      this.requests.push(record);
      const reply = this.handler(record);
      const payload = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(payload);
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.#server.listen(0, '127.0.0.1', () => {
        const addr = this.#server.address() as AddressInfo;
        this.#origin = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.#server.close(() => resolve());
    });
  }

  reset(): void {
    this.requests.length = 0;
  }
}

/** One raw GitHub repo payload; only the mapped subset may reach the browser. */
function rawRepo(n: number): Record<string, unknown> {
  return {
    id: n,
    node_id: `R_${n}`,
    full_name: `octocat/repo-${n}`,
    name: `repo-${n}`,
    owner: { login: 'octocat', id: 1, avatar_url: 'https://example.invalid/a.png' },
    private: n % 2 === 0,
    description: `repo number ${n}`,
    language: 'TypeScript',
    pushed_at: '2026-07-20T10:00:00Z',
    clone_url: `https://github.com/octocat/repo-${n}.git`,
    // Fields that MUST be dropped by mapRepo:
    ssh_url: `git@github.com:octocat/repo-${n}.git`,
    default_branch: 'main',
    permissions: { admin: true },
  };
}

/**
 * Create a data dir holding a pre-seeded github.json (StoredToken shape, 0600) so
 * a freshly booted server loads it and starts CONNECTED.
 */
async function seedConnectedDataDir(prefix: string): Promise<{ root: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { mode: 0o700 });
  await writeFile(
    join(dataDir, 'github.json'),
    JSON.stringify(
      { accessToken: SECRET, login: 'octocat', scope: 'repo', connectedAt: '2026-07-24T00:00:00Z' },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  return { root, dataDir };
}

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
  assert.deepEqual(res.body, { configured: true, state: 'connected', login: 'octocat' });
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
  const work = await mkdtemp(join(tmpdir(), 'ai-sm-ghc-clonelock-'));
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
    await rm(work, { recursive: true, force: true });
  }
});

test('connected POST /api/github/clone: dest rules refuse before git is ever spawned (400 relative / 400 missing parent / 409 non-empty)', async () => {
  const work = await mkdtemp(join(tmpdir(), 'ai-sm-ghc-clonedest-'));
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
    await rm(work, { recursive: true, force: true });
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
      configured: true,
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

// ---------------------------------------------------------------------------
// The knob itself: dormant without a client_id; refuses non-loopback values
// ---------------------------------------------------------------------------

test('AI_SM_GITHUB_API_BASE cannot wake a DORMANT feature: no client_id -> not configured, zero calls to the API', async () => {
  const ownStub = new StubApi();
  await ownStub.start();
  ownStub.handler = () => ({ status: 200, body: [rawRepo(1)] });
  // Even with a seeded github.json AND the override set, an empty client_id
  // keeps every endpoint on the not-configured path.
  const seeded = await seedConnectedDataDir('ai-sm-ghc-dormant-');
  const srv = await startTestServer({
    dataDir: seeded.dataDir,
    env: { AI_SM_GITHUB_CLIENT_ID: '', AI_SM_GITHUB_API_BASE: ownStub.origin },
  });
  try {
    assert.deepEqual((await api(srv, 'GET', '/api/github/status')).body, {
      configured: false,
      state: 'disconnected',
    });
    assert.equal((await api(srv, 'GET', '/api/github/repos')).status, 409);
    assert.deepEqual((await api(srv, 'POST', '/api/github/device')).body, { configured: false });
    assert.equal(
      (await api(srv, 'POST', '/api/github/repos', { name: 'x', private: false })).status,
      409,
    );
    assert.equal(ownStub.requests.length, 0, 'a dormant feature makes ZERO outbound calls');
  } finally {
    await srv.stop();
    await ownStub.stop();
    await rm(seeded.root, { recursive: true, force: true });
  }
});

test('AI_SM_GITHUB_API_BASE unset/empty: unchanged default behaviour (api.github.com, no github.json -> disconnected)', async () => {
  const srv = await startTestServer({
    env: { AI_SM_GITHUB_CLIENT_ID: CLIENT_ID, AI_SM_GITHUB_API_BASE: '' },
  });
  try {
    assert.equal((await fetch(`${srv.baseUrl}/health`)).status, 200);
    assert.deepEqual((await api(srv, 'GET', '/api/github/status')).body, {
      configured: true,
      state: 'disconnected',
    });
    assert.equal(
      (await api(srv, 'GET', '/api/github/repos')).status,
      409,
      'not connected -> 409 before any network call',
    );
    const log = await readServerLog(srv);
    assert.ok(
      !log.includes('AI_SM_GITHUB_API_BASE'),
      'an empty override is not treated as an override',
    );
  } finally {
    await srv.stop();
  }
});

/** Boot server/index.ts directly and capture stderr — it must refuse to start. */
async function expectRefusedStart(
  apiBase: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string; dataDir: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-ghc-refuse-'));
  const dataDir = join(root, 'data');
  const child = spawn(process.execPath, [join(projectRoot, 'server', 'index.ts')], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AI_SM_DATA_DIR: dataDir,
      AI_SM_GITHUB_CLIENT_ID: CLIENT_ID,
      AI_SM_GITHUB_API_BASE: apiBase,
      AI_SM_STARTUP_GRACE_MS: '600000',
      AI_SM_GRACE_MS: '600000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (c: Buffer) => {
    stderr += c.toString('utf8');
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    },
  );
  clearTimeout(timer);
  return { ...exit, stderr, dataDir, root };
}

test('AI_SM_GITHUB_API_BASE pointed off loopback: the server REFUSES to start (exit 1, no runtime.json)', async () => {
  const cases: [string, RegExp][] = [
    ['https://api.evil.example.com', /must point at a loopback host/],
    ['http://127.0.0.2:8787', /must point at a loopback host/],
    ['http://0.0.0.0:8787', /must point at a loopback host/],
    ['https://api.github.com.evil.com', /must point at a loopback host/],
    ['ftp://127.0.0.1:8787', /must use http:\/\/ or https:\/\//],
    ['file:///etc/passwd', /must use http:\/\/ or https:\/\//],
    ['http://127.0.0.1:8787/prefix', /must be a bare origin with no path, query or fragment/],
    ['http://127.0.0.1:8787/?x=1', /must be a bare origin with no path, query or fragment/],
    ['127.0.0.1:8787', /must be an absolute URL/],
    ['not a url', /must be an absolute URL/],
  ];
  for (const [value, expected] of cases) {
    const res = await expectRefusedStart(value);
    try {
      assert.equal(res.code, 1, `${value}: must exit 1 (signal ${res.signal})`);
      assert.match(res.stderr, /AI_SM_GITHUB_API_BASE/);
      assert.match(res.stderr, expected, `${value}: expected refusal reason`);
      await assert.rejects(
        readFile(join(res.dataDir, 'runtime.json'), 'utf8'),
        `${value}: runtime.json must never appear`,
      );
    } finally {
      await rm(res.root, { recursive: true, force: true });
    }
  }
});

test('a refused start writes the REASON to server.log (production stderr is /dev/null)', async () => {
  // launcher/start-backend.sh runs the backend as
  // `setsid --fork nohup node server/index.ts </dev/null >/dev/null 2>&1`, so
  // stderr is discarded: without this line a misconfigured value surfaces only
  // as the launcher's health-check timeout. The three guarantees the refusal
  // already had are asserted right here alongside it: exit 1, no runtime.json.
  const res = await expectRefusedStart('https://api.evil.example.com');
  try {
    assert.equal(res.code, 1, `must exit 1 (signal ${res.signal})`);
    await assert.rejects(readFile(join(res.dataDir, 'runtime.json'), 'utf8'), 'no runtime.json');
    const log = await readFile(join(res.dataDir, 'server.log'), 'utf8');
    assert.match(log, /refusing to start: AI_SM_GITHUB_API_BASE must point at a loopback host/);
  } finally {
    await rm(res.root, { recursive: true, force: true });
  }

  // The credential branch stays exempt: the reason reaches the log, the secret does not.
  const cred = await expectRefusedStart('http://user:s3cr3tpw@127.0.0.1:8787');
  try {
    assert.equal(cred.code, 1, `must exit 1 (signal ${cred.signal})`);
    const log = await readFile(join(cred.dataDir, 'server.log'), 'utf8');
    assert.match(log, /refusing to start: AI_SM_GITHUB_API_BASE must not embed credentials/);
    assert.ok(!log.includes('s3cr3tpw'), 'the embedded password is never written to server.log');
  } finally {
    await rm(cred.root, { recursive: true, force: true });
  }
});

test('AI_SM_GITHUB_API_BASE with embedded credentials: refused, and the credential is NOT echoed to stderr', async () => {
  const res = await expectRefusedStart('http://user:s3cr3tpw@127.0.0.1:8787');
  try {
    assert.equal(res.code, 1, `must exit 1 (signal ${res.signal})`);
    assert.match(res.stderr, /AI_SM_GITHUB_API_BASE must not embed credentials/);
    assert.ok(!res.stderr.includes('s3cr3tpw'), 'the embedded password is never echoed');
    await assert.rejects(readFile(join(res.dataDir, 'runtime.json'), 'utf8'));
  } finally {
    await rm(res.root, { recursive: true, force: true });
  }
});

test('AI_SM_GITHUB_API_BASE loopback forms are accepted and logged as an override', async () => {
  const ownStub = new StubApi();
  await ownStub.start();
  ownStub.handler = () => ({ status: 200, body: [rawRepo(7)] });
  const port = new URL(ownStub.origin).port;
  const seeded = await seedConnectedDataDir('ai-sm-ghc-loopback-');
  // `localhost` form: accepted, normalized, and actually used for the call.
  const srv = await startTestServer({
    dataDir: seeded.dataDir,
    env: {
      AI_SM_GITHUB_CLIENT_ID: CLIENT_ID,
      AI_SM_GITHUB_API_BASE: `http://localhost:${port}/`,
    },
  });
  try {
    const res = await api(srv, 'GET', '/api/github/repos');
    assert.equal(res.status, 200);
    assert.deepEqual(
      (res.body as { repos: { name: string }[] }).repos.map((r) => r.name),
      ['repo-7'],
    );
    assert.equal(ownStub.requests.length, 1, 'the localhost override really routed the call');
    const log = await readServerLog(srv);
    assert.match(
      log,
      new RegExp(`github REST api base overridden via AI_SM_GITHUB_API_BASE: http://localhost:${port}`),
      'a non-default API base is logged (audit trail)',
    );
    assert.ok(!log.includes(SECRET), 'the log never contains the token');
  } finally {
    await srv.stop();
    await ownStub.stop();
    await rm(seeded.root, { recursive: true, force: true });
  }
});
