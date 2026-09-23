/**
 * The CONNECTED GitHub HTTP surface — the AI_SM_GITHUB_API_BASE knob itself.
 *
 * The override points the server at a local node:http stub standing in for
 * the GitHub REST API. SECURITY of the knob is what is asserted here: it is
 * dormant without a client_id and cannot wake the feature, a STORED credential
 * works with no client_id (2026-07-25), unset/empty keeps the default, and the
 * override is restricted to loopback origins (the token is a Bearer credential
 * — it must never become sendable to a remote host): a non-loopback /
 * credential-bearing value makes the server REFUSE TO START (exit 1, no
 * runtime.json, the reason in server.log, the credential not echoed).
 *
 * How: real server children per test, each with its own data dir (some
 * pre-seeded with a github.json), and `server/index.ts` booted directly to
 * capture the stderr of a refused start.
 *
 * NOT claimed here: the connected routes themselves —
 * tests/server/github-connected.test.ts.
 *
 * Split out of tests/server/github-connected.test.ts by topic
 * (PLAN-RESTRUCTURE O6); the stub and the seeded data dir are
 * tests/helpers/github-connected-fixture.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  api,
  projectRoot,
  readServerLog,
  startTestServer,
  makeTempDir,
} from '../helpers/helpers.ts';
import {
  SECRET,
  CLIENT_ID,
  StubApi,
  rawRepo,
  seedConnectedDataDir,
} from '../helpers/github-connected-fixture.ts';

// ---------------------------------------------------------------------------
// The knob itself: dormant without a client_id; refuses non-loopback values
// ---------------------------------------------------------------------------

test('no client_id + no credential: nothing is connected and ZERO calls reach the API (AI_SM_GITHUB_API_BASE cannot wake it)', async () => {
  const ownStub = new StubApi();
  await ownStub.start();
  ownStub.handler = () => ({ status: 200, body: [rawRepo(1)] });
  const srv = await startTestServer({
    env: { AI_SM_GITHUB_CLIENT_ID: '', AI_SM_GITHUB_API_BASE: ownStub.origin },
  });
  try {
    assert.deepEqual((await api(srv, 'GET', '/api/github/status')).body, {
      deviceFlowAvailable: false,
      state: 'disconnected',
    });
    assert.equal((await api(srv, 'GET', '/api/github/repos')).status, 409);
    assert.deepEqual((await api(srv, 'POST', '/api/github/device')).body, {
      deviceFlowAvailable: false,
    });
    assert.equal(
      (await api(srv, 'POST', '/api/github/repos', { name: 'x', private: false })).status,
      409,
    );
    assert.equal(
      ownStub.requests.length,
      0,
      'with no credential at all, no endpoint makes an outbound call',
    );
  } finally {
    await srv.stop();
    await ownStub.stop();
  }
});

test('a STORED credential works with NO client_id — availability is decoupled from the OAuth App (2026-07-25)', async () => {
  // This inverts the old "dormant without a client_id" expectation on purpose.
  // The pasted-token path exists precisely for a server with no OAuth App, and
  // the gate is the CREDENTIAL: `deviceFlowAvailable:false` must never disable
  // the connected surface, or the feature would be unusable in exactly the
  // situation it was built for.
  const ownStub = new StubApi();
  await ownStub.start();
  ownStub.handler = () => ({ status: 200, body: [rawRepo(1)] });
  const seeded = await seedConnectedDataDir('ai-sm-ghc-nocid-');
  const srv = await startTestServer({
    dataDir: seeded.dataDir,
    env: { AI_SM_GITHUB_CLIENT_ID: '', AI_SM_GITHUB_API_BASE: ownStub.origin },
  });
  try {
    assert.deepEqual((await api(srv, 'GET', '/api/github/status')).body, {
      deviceFlowAvailable: false,
      state: 'connected',
      login: 'octocat',
      source: 'device',
      persisted: true,
    });
    const repos = await api(srv, 'GET', '/api/github/repos');
    assert.equal(repos.status, 200, 'a stored credential lists repos without a client id');
    assert.equal((repos.body as { repos: unknown[] }).repos.length, 1);
    assert.equal(ownStub.requests[0]?.authorization, `Bearer ${SECRET}`);

    // The DEVICE FLOW is the only thing an absent client id disables.
    assert.deepEqual((await api(srv, 'POST', '/api/github/device')).body, {
      deviceFlowAvailable: false,
    });
    assert.ok(!JSON.stringify(repos.body).includes(SECRET));
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
      deviceFlowAvailable: true,
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
  const root = await makeTempDir('ai-sm-ghc-refuse-');
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
