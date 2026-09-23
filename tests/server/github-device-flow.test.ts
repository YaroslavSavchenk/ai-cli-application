/**
 * GitHub OAuth device-flow connection (Phase 2b) — `GithubConnection` unit
 * tests via the fetch SEAM (no network): the full device-flow state machine
 * (connecting -> connected), proving the access token is persisted 0600 to
 * github.json and NEVER surfaces in status()/listRepos(), plus disconnect
 * (drops github.json) and the 401 -> disconnected invalidation; then the poll
 * edges, the bounds (expiry, MAX_POLLS), storage and no-leak safety.
 *
 * Time: positive transitions wait on conditions (waitUntil); the two NON-event
 * proofs (no re-poll happened) use a bounded delay with a large safety margin
 * — the only sound way to assert "X did not occur".
 *
 * NOT claimed here: the HTTP routes (`github.test.ts`), a real GitHub device
 * flow in a browser (the user's check).
 *
 * Split out of `tests/server/github.test.ts` by topic (PLAN-RESTRUCTURE O6);
 * the shared doubles are `tests/helpers/github-fixture.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  GithubConnection,
  GithubError,
  type FetchLike,
} from '../../server/github.ts';
import {
  waitUntil,
  makeTempDir,
  removeTempDir,
} from '../helpers/helpers.ts';
import {
  noop,
  SECRET,
  jsonResponse,
  RAW_REPO,
} from '../helpers/github-fixture.ts';

// ---------------------------------------------------------------------------
// 2b. Full device flow via the fetch seam (no network)
// ---------------------------------------------------------------------------

test('device flow: connecting -> connected; token persisted 0600, NEVER in status; then disconnect drops github.json', async () => {
  const root = await makeTempDir('ai-sm-gh-');
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
    assert.deepEqual(connected, {
      deviceFlowAvailable: true,
      state: 'connected',
      login: 'octocat',
      source: 'device',
      persisted: true,
    });
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
    assert.deepEqual(conn.status(), { deviceFlowAvailable: true, state: 'disconnected' });
    await assert.rejects(stat(file), 'github.json must be deleted on disconnect');
    await assert.rejects(conn.listRepos(), (e) => e instanceof GithubError && e.status === 409);
  } finally {
    await removeTempDir(root);
  }
});

test('load-on-construction: a github.json with a token boots connected; a 401 on repos invalidates it (-> disconnected, file deleted)', async () => {
  const root = await makeTempDir('ai-sm-gh401-');
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
    assert.deepEqual(conn.status(), { deviceFlowAvailable: true, state: 'disconnected' }, '401 invalidated the token');
    await assert.rejects(stat(file), 'github.json removed after 401 invalidation');
  } finally {
    await removeTempDir(root);
  }
});

test('no clientId: startDeviceFlow -> not-configured; listRepos -> 409 (not connected); status deviceFlowAvailable:false', async () => {
  const root = await makeTempDir('ai-sm-gh-unconf-');
  try {
    const conn = new GithubConnection({ file: join(root, 'github.json'), log: noop, clientId: '' });
    assert.deepEqual(conn.status(), { deviceFlowAvailable: false, state: 'disconnected' });
    const started = await conn.startDeviceFlow();
    assert.deepEqual(started, { ok: false, reason: 'not-configured' });
    await assert.rejects(conn.listRepos(), (e) => e instanceof GithubError && e.status === 409);
  } finally {
    await removeTempDir(root);
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
  const root = await makeTempDir('ai-sm-gh-connecting-');
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
    assert.equal(s.deviceFlowAvailable, true);
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
    await removeTempDir(root);
  }
});

test('poll edge: slow_down grows the interval (no re-poll within the original cadence) and keeps connecting', async () => {
  const root = await makeTempDir('ai-sm-gh-slow-');
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
    await removeTempDir(root);
  }
});

for (const errCode of ['expired_token', 'access_denied'] as const) {
  test(`poll edge: ${errCode} -> disconnected, token never stored, polling stops`, async () => {
    const root = await makeTempDir(`ai-sm-gh-${errCode}-`);
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
      assert.deepEqual(conn.status(), { deviceFlowAvailable: true, state: 'disconnected' });
      await assert.rejects(stat(file), 'no github.json after a terminal poll error');

      // Polling truly stopped — no further token polls after the terminal error.
      const settled = tokenPolls;
      await delay(150);
      assert.equal(tokenPolls, settled, 'polling stopped after the terminal error');

      await assert.rejects(conn.listRepos(), (e) => e instanceof GithubError && e.status === 409);
    } finally {
      await removeTempDir(root);
    }
  });
}

test('bounded: the device-code expiry stops polling and returns to disconnected (never connects, no token)', async () => {
  const root = await makeTempDir('ai-sm-gh-expiry-');
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
    await removeTempDir(root);
  }
});

test('bounded: polling is hard-capped at MAX_POLLS (exactly 300 token polls) then disconnects', async () => {
  const root = await makeTempDir('ai-sm-gh-maxpolls-');
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
    await removeTempDir(root);
  }
});

test('not configured (empty clientId): status/device/repos/disconnect make ZERO network calls', async () => {
  const root = await makeTempDir('ai-sm-gh-noconf-nofetch-');
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
    assert.deepEqual(conn.status(), { deviceFlowAvailable: false, state: 'disconnected' });
    assert.deepEqual(await conn.startDeviceFlow(), { ok: false, reason: 'not-configured' });
    await assert.rejects(conn.listRepos(), (e) => e instanceof GithubError && e.status === 409);
    await conn.disconnect();
    assert.equal(fetchCalls, 0, 'the not-configured guard short-circuits before any fetch');
  } finally {
    await removeTempDir(root);
  }
});

test('storage: malformed / missing-token / absent github.json on construction -> disconnected, no crash, no fetch', async () => {
  const root = await makeTempDir('ai-sm-gh-storage-');
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
    assert.deepEqual(c1.status(), { deviceFlowAvailable: true, state: 'disconnected' }, 'malformed json -> disconnected');

    // (2) valid JSON object but no accessToken field
    const noTokFile = join(root, 'notoken.json');
    await writeFile(noTokFile, JSON.stringify({ login: 'octocat', scope: 'repo' }), { mode: 0o600 });
    const c2 = new GithubConnection({ file: noTokFile, log: noop, clientId: 'Iv1.x', fetchImpl: stub });
    assert.deepEqual(c2.status(), { deviceFlowAvailable: true, state: 'disconnected' }, 'missing accessToken -> disconnected');

    // (3) absent file entirely
    const c3 = new GithubConnection({ file: join(root, 'absent.json'), log: noop, clientId: 'Iv1.x', fetchImpl: stub });
    assert.deepEqual(c3.status(), { deviceFlowAvailable: true, state: 'disconnected' }, 'absent file -> disconnected');

    assert.equal(fetchCalls, 0, 'construction + status never touch the network');
  } finally {
    await removeTempDir(root);
  }
});

test('listRepos: sends the stored token as a Bearer, drops unmappable entries, stops after a short page', async () => {
  const root = await makeTempDir('ai-sm-gh-repos-');
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
    await removeTempDir(root);
  }
});
