/**
 * The PASTED-TOKEN credential path (POST /api/github/token, 2026-07-25) —
 * in-process: pasting while a device flow is CONNECTING replaces it and
 * cancels the in-flight poll, a stored record without a source reads as the
 * device flow, connectWithToken re-validates the shape for an internal
 * caller, and the pure helpers (validatePastedToken, parseScopesHeader,
 * parseTokenExpiry).
 *
 * How: `GithubConnection` on a temp dir with the fetch SEAM — no server, no
 * network. The pasted token is a fake that every assertion treats as a real
 * credential.
 *
 * NOT claimed here: the route and its log hygiene — `github-token.test.ts`.
 *
 * Split out of `tests/server/github-token.test.ts` by topic (PLAN-RESTRUCTURE
 * O6); the stub is `tests/helpers/github-token-fixture.ts`. The whole-surface
 * server.log sweep stays there, with the shared server child it sweeps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  GithubConnection,
  MAX_PASTED_TOKEN_LEN,
  parseScopesHeader,
  parseTokenExpiry,
  validatePastedToken,
  type FetchLike,
} from '../../server/github.ts';
import type { Logger } from '../../server/config.ts';
import {
  waitUntil,
  makeTempDir,
  removeTempDir,
} from '../helpers/helpers.ts';
import {
  PASTED,
} from '../helpers/github-token-fixture.ts';

const noop: Logger = () => {};

// ---------------------------------------------------------------------------
// 6. In-process: replacement of an in-flight device flow, and the pure helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('pasting while a device flow is CONNECTING replaces it and cancels the in-flight poll (exactly one credential)', async () => {
  const root = await makeTempDir('ai-sm-ghtok-poll-');
  const file = join(root, 'github.json');
  try {
    let tokenPolls = 0;
    const stubFetch: FetchLike = (url) => {
      if (url === 'https://github.com/login/device/code') {
        return Promise.resolve(
          jsonResponse({
            device_code: 'DEV-CODE-SECRET',
            user_code: 'WDJB-MJHT',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 0.02,
          }),
        );
      }
      if (url === 'https://github.com/login/oauth/access_token') {
        tokenPolls += 1;
        return Promise.resolve(jsonResponse({ error: 'authorization_pending' }));
      }
      if (url === 'https://api.github.com/user') {
        return Promise.resolve(jsonResponse({ login: 'octocat' }));
      }
      if (url.startsWith('https://api.github.com/user/repos')) {
        return Promise.resolve(jsonResponse([]));
      }
      return Promise.resolve(jsonResponse({ error: 'unexpected' }, 404));
    };
    const conn = new GithubConnection({
      file,
      log: noop,
      clientId: 'Iv1.testclientid',
      fetchImpl: stubFetch,
    });
    await conn.startDeviceFlow();
    assert.equal(conn.status().state, 'connecting');
    await waitUntil(() => (tokenPolls >= 1 ? true : undefined), 'first device poll', 5000, 5);

    const result = await conn.connectWithToken(PASTED, true);
    assert.ok(result.ok, 'the paste succeeds');
    const status = conn.status();
    assert.equal(status.state, 'connected');
    assert.equal(status.source, 'pat', 'the pasted token WON — no merge, no fallback chain');
    assert.ok(!('userCode' in status), 'the device flow is gone, not paused');

    // The in-flight poll self-cancels via the generation counter: no further
    // token polls, and no device-flow success can overwrite the pasted token.
    const settled = tokenPolls;
    await delay(200);
    assert.equal(tokenPolls, settled, 'the superseded device poll stopped');
    assert.equal(conn.status().source, 'pat');

    const stored = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    assert.equal(stored['accessToken'], PASTED);
    assert.equal(stored['source'], 'pat');
  } finally {
    await removeTempDir(root);
  }
});

test('a stored record WITHOUT a source reads as the device flow, and disconnect drops it the same way', async () => {
  const root = await makeTempDir('ai-sm-ghtok-legacy-');
  const file = join(root, 'github.json');
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      file,
      JSON.stringify({
        accessToken: PASTED,
        login: 'octocat',
        scope: 'repo',
        connectedAt: '2026-07-24T00:00:00Z',
      }),
      { mode: 0o600 },
    );
    const conn = new GithubConnection({ file, log: noop, clientId: 'Iv1.x' });
    assert.deepEqual(conn.status(), {
      deviceFlowAvailable: true,
      state: 'connected',
      login: 'octocat',
      source: 'device',
      persisted: true,
    });
    await conn.disconnect();
    assert.deepEqual(conn.status(), { deviceFlowAvailable: true, state: 'disconnected' });
    await assert.rejects(stat(file), 'disconnect deletes github.json for either source');
  } finally {
    await removeTempDir(root);
  }
});

test('connectWithToken re-validates the SHAPE in-process (no route can be bypassed by an internal caller)', async () => {
  const root = await makeTempDir('ai-sm-ghtok-shape-');
  try {
    let fetches = 0;
    const conn = new GithubConnection({
      file: join(root, 'github.json'),
      log: noop,
      clientId: '',
      fetchImpl: () => {
        fetches += 1;
        return Promise.resolve(jsonResponse({ login: 'octocat' }));
      },
    });
    for (const bad of ['', '   ', 'ghp_a b', 'ghp_ab\u0001', 'g'.repeat(MAX_PASTED_TOKEN_LEN + 1)]) {
      const res = await conn.connectWithToken(bad, true);
      assert.equal(res.ok, false, `${JSON.stringify(bad.slice(0, 12))} must be refused`);
      if (!res.ok) {
        assert.equal(res.status, 400);
        assert.ok(!res.message.includes('ghp_'), 'the message names the rule, never the value');
      }
    }
    assert.equal(fetches, 0, 'a structurally impossible token never reaches GitHub');
    assert.equal(conn.status().state, 'disconnected');
  } finally {
    await removeTempDir(root);
  }
});

test('validatePastedToken: trims, refuses empty/over-long/whitespace/control, and has NO prefix allowlist', () => {
  assert.deepEqual(validatePastedToken(`  ${PASTED}\n`), { ok: true, token: PASTED });
  assert.deepEqual(validatePastedToken('anything-github-accepts'), {
    ok: true,
    token: 'anything-github-accepts',
  });
  assert.equal(validatePastedToken('').ok, false);
  assert.equal(validatePastedToken('\t\n  ').ok, false);
  assert.equal(
    validatePastedToken('a'.repeat(MAX_PASTED_TOKEN_LEN)).ok,
    true,
    'exactly 1024 characters is fine',
  );
  assert.equal(validatePastedToken('a'.repeat(MAX_PASTED_TOKEN_LEN + 1)).ok, false);
  // Interior whitespace of every flavour a clipboard can smuggle in, plus the
  // control characters that would make a header value a splitting primitive.
  for (const bad of ['a b', 'a\tb', 'a\nb', 'a\u00a0b', 'a\u0001b', 'a\u0000b', 'a\u2003b', 'a\ufeffb']) {
    assert.equal(validatePastedToken(bad).ok, false, `${JSON.stringify(bad)} must be refused`);
  }
  const rejected = validatePastedToken('a b');
  assert.ok(!rejected.ok && !rejected.message.includes('a b'), 'the message never quotes the value');
});

test('parseScopesHeader / parseTokenExpiry: honest about what GitHub actually said', () => {
  assert.deepEqual(parseScopesHeader('repo, read:org'), ['repo', 'read:org']);
  assert.deepEqual(parseScopesHeader('repo'), ['repo']);
  assert.deepEqual(parseScopesHeader(''), [], 'a classic token with no scopes');
  assert.deepEqual(parseScopesHeader('  ,  , repo ,'), ['repo'], 'blanks dropped');
  assert.deepEqual(parseScopesHeader('x'.repeat(2000)), [], 'absurd header -> no claim');

  assert.equal(parseTokenExpiry('2026-12-31 00:00:00 UTC'), '2026-12-31T00:00:00.000Z');
  assert.equal(parseTokenExpiry('2026-12-31T00:00:00Z'), '2026-12-31T00:00:00.000Z');
  assert.equal(parseTokenExpiry(null), undefined, 'absent header -> no expiry claim');
  assert.equal(parseTokenExpiry(undefined), undefined);
  assert.equal(parseTokenExpiry(''), undefined);
  assert.equal(parseTokenExpiry('whenever'), undefined, 'unparseable -> no claim, never raw');
  assert.equal(parseTokenExpiry('x'.repeat(100)), undefined);
});
