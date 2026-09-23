/**
 * The PASTED-TOKEN credential path (POST /api/github/token, 2026-07-25) — the
 * cases that need a server child of their OWN: GitHub unreachable (502,
 * nothing stored), a 401 on a LATER call told apart from "never connected"
 * (V-4), and remember=false — nothing written to github.json, a RESTART is
 * disconnected, and it replaces (and removes) a persisted credential.
 *
 * How: real server children started per test with their own data dir, each
 * against its own local stub for api.github.com (the loopback-only
 * AI_SM_GITHUB_API_BASE seam) — OFFLINE by construction. The pasted token is a
 * fake that every assertion treats as a real credential.
 *
 * Why: remember=false is the toggle that genuinely removes the on-disk copy;
 * a restart is the only proof that nothing was kept.
 *
 * NOT claimed here: the ingress rules, the log-leak refusals and the failure
 * mapping on the shared child — `github-token.test.ts`.
 *
 * Split out of `tests/server/github-token.test.ts` by topic (PLAN-RESTRUCTURE
 * O6); the stub is `tests/helpers/github-token-fixture.ts`. The whole-surface
 * server.log sweep stays there, with the shared server child it sweeps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { GithubStatus } from '../../shared/protocol.ts';
import {
  api,
  readServerLog,
  startTestServer,
  makeTempDir,
  removeTempDir,
} from '../helpers/helpers.ts';
import {
  PASTED,
  StubApi,
  acceptingHandler,
  postToken,
} from '../helpers/github-token-fixture.ts';

// ---------------------------------------------------------------------------
// 4. Failure mapping (continued) — the cases with a server child of their own
// ---------------------------------------------------------------------------

test("GitHub unreachable -> 502 \"couldn't reach GitHub\" (nothing stored, nothing connected)", async () => {
  // A loopback origin with nothing listening: ECONNREFUSED, the offline shape of
  // "the network is the problem, not your token".
  const dead = new StubApi();
  await dead.start();
  const deadOrigin = dead.origin;
  await dead.stop();
  const srv = await startTestServer({
    env: { AI_SM_GITHUB_CLIENT_ID: '', AI_SM_GITHUB_API_BASE: deadOrigin },
  });
  try {
    const res = await postToken(srv, { token: PASTED, remember: true });
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error: "couldn't reach GitHub" });
    await assert.rejects(stat(join(srv.dataDir, 'github.json')));
    const log = await readServerLog(srv);
    assert.ok(log.includes('github token rejected'), 'the refusal is logged as a CONSTANT string');
    assert.ok(!log.includes(PASTED), 'and never with the token');
  } finally {
    await srv.stop();
  }
});

test('a 401 on a LATER call is distinguishable from "never connected" (V-4), and drops the credential either way', async () => {
  // Without this the UI can only show an unexplained flip to disconnected. The
  // 409 the app already answered for "not connected" is kept for that case; a
  // credential that STOPPED WORKING gets its own sentence.
  const ownStub = new StubApi();
  await ownStub.start();
  ownStub.handler = acceptingHandler();
  const srv = await startTestServer({
    env: { AI_SM_GITHUB_CLIENT_ID: '', AI_SM_GITHUB_API_BASE: ownStub.origin },
  });
  try {
    const never = await api(srv, 'GET', '/api/github/repos');
    assert.equal(never.status, 409);
    assert.deepEqual(never.body, { error: 'github not connected' });

    assert.equal((await postToken(srv, { token: PASTED, remember: true })).status, 200);

    // The token is revoked upstream between calls.
    ownStub.handler = () => ({ status: 401, body: { message: 'Bad credentials' } });
    const stopped = await api(srv, 'GET', '/api/github/repos');
    assert.equal(stopped.status, 409);
    assert.deepEqual(stopped.body, {
      error: 'GitHub rejected the stored credential — connect again',
    });
    assert.notDeepEqual(stopped.body, never.body, 'the two 409s are tellable apart');

    await assert.rejects(
      stat(join(srv.dataDir, 'github.json')),
      'a dead credential is removed from disk, whatever its source',
    );
    assert.deepEqual((await api(srv, 'GET', '/api/github/status')).body, {
      deviceFlowAvailable: false,
      state: 'disconnected',
    });
    const log = await readServerLog(srv);
    assert.ok(log.includes('github token invalid, disconnected'));
    assert.ok(!log.includes(PASTED));
  } finally {
    await srv.stop();
    await ownStub.stop();
  }
});

// ---------------------------------------------------------------------------
// 5. remember=false — the toggle that genuinely removes the on-disk copy
// ---------------------------------------------------------------------------

test('remember=false: nothing is written to github.json, the credential works, and a RESTART is disconnected', async () => {
  const ownStub = new StubApi();
  await ownStub.start();
  ownStub.handler = acceptingHandler();
  const root = await makeTempDir('ai-sm-ghtok-mem-');
  const dataDir = join(root, 'data');
  // ONE outer try/finally around BOTH server lifetimes. Previously the stub and
  // the temp dir were cleaned up only in the SECOND block's finally, so a failed
  // assertion in the first block left the stub HTTP server listening — which
  // keeps the event loop alive, so `node --test` never exited — and left a temp
  // dir holding a github.json with the (stub) credential in it. Measured while
  // mutation-testing this file: a failing run hung until it was killed.
  try {
  const srv = await startTestServer({
    dataDir,
    env: { AI_SM_GITHUB_CLIENT_ID: '', AI_SM_GITHUB_API_BASE: ownStub.origin },
  });
  try {
    const res = await postToken(srv, { token: PASTED, remember: false });
    assert.equal(res.status, 200);
    assert.equal((res.body as GithubStatus).persisted, false, 'the status says so honestly');
    assert.equal((res.body as GithubStatus).source, 'pat');
    await assert.rejects(
      stat(join(dataDir, 'github.json')),
      'remember=false writes NOTHING to disk',
    );

    // It is a fully working credential while the process lives.
    ownStub.reset();
    const repos = await api(srv, 'GET', '/api/github/repos');
    assert.equal(repos.status, 200);
    assert.equal(ownStub.requests[0]?.authorization, `Bearer ${PASTED}`);

    // Nothing on disk carries it, anywhere in the data dir.
    for (const name of ['prefs.json', 'projects.json', 'runtime.json', 'history.json']) {
      const contents = await readFile(join(dataDir, name), 'utf8').catch(() => '');
      assert.ok(!contents.includes(PASTED), `${name} must never carry the token`);
    }
    const prefs = await api(srv, 'GET', '/api/prefs');
    assert.ok(
      !JSON.stringify(prefs.body).includes(PASTED),
      'GET /api/prefs returns the whole bag to the page — the token is NEVER in it',
    );
  } finally {
    await srv.stop();
  }

  // Restart on the SAME data dir: disconnected, because nothing was stored.
  const restarted = await startTestServer({
    dataDir,
    env: { AI_SM_GITHUB_CLIENT_ID: '', AI_SM_GITHUB_API_BASE: ownStub.origin },
  });
  try {
    assert.deepEqual((await api(restarted, 'GET', '/api/github/status')).body, {
      deviceFlowAvailable: false,
      state: 'disconnected',
    });
  } finally {
    await restarted.stop();
  }
  } finally {
    await ownStub.stop();
    await removeTempDir(root);
  }
});

test('remember=false REPLACES a persisted credential and removes the older on-disk copy', async () => {
  const ownStub = new StubApi();
  await ownStub.start();
  ownStub.handler = acceptingHandler();
  const root = await makeTempDir('ai-sm-ghtok-replace-');
  const dataDir = join(root, 'data');
  const srv = await startTestServer({
    dataDir,
    env: { AI_SM_GITHUB_CLIENT_ID: '', AI_SM_GITHUB_API_BASE: ownStub.origin },
  });
  try {
    assert.equal((await postToken(srv, { token: PASTED, remember: true })).status, 200);
    assert.ok(await stat(join(dataDir, 'github.json')));

    const second = 'ghp_SECONDdeadbeefdeadbeefdeadbeefdeadbe';
    const res = await postToken(srv, { token: second, remember: false });
    assert.equal(res.status, 200);
    assert.equal((res.body as GithubStatus).persisted, false);
    await assert.rejects(
      stat(join(dataDir, 'github.json')),
      'the superseded on-disk credential is gone — a restart must not resurrect it',
    );

    ownStub.reset();
    await api(srv, 'GET', '/api/github/repos');
    assert.equal(
      ownStub.requests[0]?.authorization,
      `Bearer ${second}`,
      'exactly ONE credential is live: the newest one',
    );
  } finally {
    await srv.stop();
    await ownStub.stop();
    await removeTempDir(root);
  }
});
