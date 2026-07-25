/**
 * AI_SM_GITHUB_API_BASE — the validator itself, at UNIT level.
 *
 * tests/github-connected.test.ts proves the knob end-to-end by booting real
 * servers (10 process spawns for the refusal matrix alone). That is the right
 * integration proof, but it leaves the validator's own branches thinly covered
 * and it is far too expensive to enumerate the adversarial forms that matter.
 * This file imports config.ts directly instead, so every branch of
 * assertLoopbackApiBase / resolveGithubApiBase is asserted in microseconds.
 *
 * WHY THIS MATTERS (it is a security boundary, not a convenience knob): this
 * value decides where the stored OAuth access token is sent as a Bearer header.
 * An accepted non-loopback value would be straight token exfiltration. So the
 * accept-list is asserted exhaustively, including the obfuscated IPv4 forms the
 * WHATWG URL parser normalizes (0x7f.0.0.1, 2130706433, 127.1) — those are NOT
 * bypasses (they really are 127.0.0.1) and this file pins that they normalize
 * rather than sneak through as opaque hostnames.
 *
 * Also covered here and nowhere else:
 *   - GithubConnection's constructor RE-validation (the "defense in depth"
 *     claim in server/github.ts: an in-process caller must not be able to aim
 *     the token at a non-loopback host even though index.ts already checked);
 *   - the claim that the override re-points ONLY the REST base — the device-flow
 *     urls (github.com) stay hardcoded.
 *
 * NO REAL CREDENTIAL: the fake token below is a literal, and no assertion ever
 * prints it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_GITHUB_API_BASE,
  assertLoopbackApiBase,
  resolveGithubApiBase,
} from '../server/config.ts';
import { GithubConnection, GithubError, type FetchLike } from '../server/github.ts';
import { waitUntil } from './helpers.ts';

/** Fake token: never a real credential, but treated as one by every assertion. */
const SECRET = 'gho_STUB_ONLY_NEVER_A_REAL_TOKEN';
const noop = (): void => {};

/** Run `fn` with AI_SM_GITHUB_API_BASE set to `value` (undefined = unset). */
function withEnv<T>(value: string | undefined, fn: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'AI_SM_GITHUB_API_BASE');
  const prev = process.env['AI_SM_GITHUB_API_BASE'];
  if (value === undefined) delete process.env['AI_SM_GITHUB_API_BASE'];
  else process.env['AI_SM_GITHUB_API_BASE'] = value;
  try {
    return fn();
  } finally {
    if (had) process.env['AI_SM_GITHUB_API_BASE'] = prev as string;
    else delete process.env['AI_SM_GITHUB_API_BASE'];
  }
}

// ---------------------------------------------------------------------------
// assertLoopbackApiBase — accepted forms
// ---------------------------------------------------------------------------

test('assertLoopbackApiBase: the plain loopback forms are accepted and normalized to a bare origin', () => {
  assert.equal(assertLoopbackApiBase('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(assertLoopbackApiBase('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787', 'a lone / is not a path');
  assert.equal(assertLoopbackApiBase('http://localhost:9'), 'http://localhost:9');
  assert.equal(assertLoopbackApiBase('https://localhost'), 'https://localhost', 'https with no port');
  assert.equal(assertLoopbackApiBase('http://127.0.0.1'), 'http://127.0.0.1');
});

test('assertLoopbackApiBase: IPv6 loopback [::1] is accepted (the docstring promises it; nothing else asserts it)', () => {
  assert.equal(assertLoopbackApiBase('http://[::1]:8787'), 'http://[::1]:8787');
  assert.equal(assertLoopbackApiBase('http://[::1]'), 'http://[::1]');
  assert.equal(
    assertLoopbackApiBase('http://[0:0:0:0:0:0:0:1]:8787'),
    'http://[::1]:8787',
    'the long IPv6 form normalizes to the compressed one and is still recognized',
  );
});

test('assertLoopbackApiBase: the host is case-folded and default ports are dropped', () => {
  assert.equal(assertLoopbackApiBase('http://LOCALHOST:9/'), 'http://localhost:9');
  assert.equal(assertLoopbackApiBase('HTTP://LocalHost:9'), 'http://localhost:9');
  assert.equal(assertLoopbackApiBase('https://127.0.0.1:443'), 'https://127.0.0.1', 'default https port dropped');
  assert.equal(assertLoopbackApiBase('http://127.0.0.1:80'), 'http://127.0.0.1', 'default http port dropped');
});

test('assertLoopbackApiBase: obfuscated IPv4 loopback forms NORMALIZE to 127.0.0.1 — not a bypass, but pinned', () => {
  // These are accepted because the WHATWG parser resolves them to the real
  // loopback address, so the token still cannot leave the machine. Pinned so a
  // future "tighten the allowlist" change is a deliberate, visible decision.
  assert.equal(assertLoopbackApiBase('http://0x7f.0.0.1:1'), 'http://127.0.0.1:1', 'hex octet');
  assert.equal(assertLoopbackApiBase('http://2130706433:1'), 'http://127.0.0.1:1', 'integer form');
  assert.equal(assertLoopbackApiBase('http://127.1:1'), 'http://127.0.0.1:1', 'short form');
  assert.equal(assertLoopbackApiBase('http://127.0.0.1.:1'), 'http://127.0.0.1:1', 'trailing root dot');
});

// ---------------------------------------------------------------------------
// assertLoopbackApiBase — refusals (each is a token-exfiltration guard)
// ---------------------------------------------------------------------------

test('assertLoopbackApiBase: any non-loopback host is refused — no routable target may ever receive the token', () => {
  const hosts = [
    'https://api.github.com',
    'https://api.evil.example.com',
    'https://api.github.com.evil.com',
    'http://127.0.0.2:8787',
    'http://127.1.1.1:8787',
    'http://0.0.0.0:8787',
    'http://10.0.0.1:8787',
    'http://[::]:8787',
    'http://[::2]:8787',
    'http://[::ffff:127.0.0.1]:8787', // IPv4-mapped IPv6 is NOT on the allowlist
    'http://localhost.evil.com:8787',
    'http://evil.com\\@127.0.0.1', // backslash is a path separator: host = evil.com
  ];
  for (const h of hosts) {
    assert.throws(
      () => assertLoopbackApiBase(h),
      /AI_SM_GITHUB_API_BASE must point at a loopback host/,
      `${h} must be refused`,
    );
  }
});

test('assertLoopbackApiBase: non-http(s) schemes are refused', () => {
  for (const v of [
    'ftp://127.0.0.1:8787',
    'file:///etc/passwd',
    'ws://127.0.0.1:8787',
    'javascript:alert(1)',
    'data:text/plain,x',
  ]) {
    assert.throws(() => assertLoopbackApiBase(v), /must use http:\/\/ or https:\/\//, `${v} must be refused`);
  }
});

test('assertLoopbackApiBase: a non-absolute value is refused as un-parseable', () => {
  for (const v of ['127.0.0.1:8787', 'not a url', '//127.0.0.1:1', '/user', '']) {
    assert.throws(() => assertLoopbackApiBase(v), /must be an absolute URL/, `${JSON.stringify(v)} must be refused`);
  }
});

test('assertLoopbackApiBase: path, query AND fragment are each refused (the base is an origin, not a prefix)', () => {
  // The fragment branch is reachable and, until now, asserted nowhere.
  for (const v of [
    'http://127.0.0.1:8787/prefix',
    'http://127.0.0.1:8787/api/v3',
    'http://127.0.0.1:8787/?x=1',
    'http://127.0.0.1:8787?x=1',
    'http://127.0.0.1:8787#frag',
    'http://127.0.0.1:8787/#frag',
  ]) {
    assert.throws(
      () => assertLoopbackApiBase(v),
      /must be a bare origin with no path, query or fragment/,
      `${v} must be refused`,
    );
  }
});

test('assertLoopbackApiBase: embedded credentials are refused AND never echoed in the error', () => {
  for (const v of [
    'http://user:s3cr3tpw@127.0.0.1:8787',
    'http://user@127.0.0.1:8787',
    'http://:s3cr3tpw@127.0.0.1:8787',
    'http://127.0.0.1@evil.example.com', // reads as username=127.0.0.1, host=evil
  ]) {
    assert.throws(
      () => assertLoopbackApiBase(v),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, 'AI_SM_GITHUB_API_BASE must not embed credentials');
        assert.ok(!err.message.includes('s3cr3tpw'), 'the credential is never echoed');
        assert.ok(!err.message.includes('127.0.0.1'), 'the whole value is never echoed on this branch');
        return true;
      },
      `${v} must be refused`,
    );
  }
});

test('assertLoopbackApiBase: the refusal message names the variable and shows the safe example', () => {
  assert.throws(() => assertLoopbackApiBase('https://api.evil.example.com'), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /^AI_SM_GITHUB_API_BASE /);
    assert.match(err.message, /expected e\.g\. http:\/\/127\.0\.0\.1:8787/);
    assert.match(err.message, /got: https:\/\/api\.evil\.example\.com/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// resolveGithubApiBase — the env read on top of the validator
// ---------------------------------------------------------------------------

test('resolveGithubApiBase: unset / empty / whitespace-only all mean "no override"', () => {
  assert.equal(withEnv(undefined, resolveGithubApiBase), DEFAULT_GITHUB_API_BASE);
  assert.equal(withEnv('', resolveGithubApiBase), DEFAULT_GITHUB_API_BASE);
  assert.equal(withEnv('   ', resolveGithubApiBase), DEFAULT_GITHUB_API_BASE, 'whitespace is not an override');
  assert.equal(withEnv('\t\n ', resolveGithubApiBase), DEFAULT_GITHUB_API_BASE);
  assert.equal(DEFAULT_GITHUB_API_BASE, 'https://api.github.com', 'the default is the real GitHub API');
});

test('resolveGithubApiBase: a padded loopback value is trimmed, validated and normalized', () => {
  assert.equal(withEnv('  http://127.0.0.1:5555  ', resolveGithubApiBase), 'http://127.0.0.1:5555');
  assert.equal(withEnv('http://localhost:5555/', resolveGithubApiBase), 'http://localhost:5555');
});

test('resolveGithubApiBase: a bad value THROWS (index.ts turns that into a refusal to start)', () => {
  assert.throws(() => withEnv('https://api.evil.example.com', resolveGithubApiBase), /must point at a loopback host/);
  assert.throws(() => withEnv('http://127.0.0.1:1/x', resolveGithubApiBase), /must be a bare origin/);
  assert.throws(() => withEnv('nonsense', resolveGithubApiBase), /must be an absolute URL/);
});

// ---------------------------------------------------------------------------
// GithubConnection constructor — the "defense in depth" re-validation
// ---------------------------------------------------------------------------

test('GithubConnection: an in-process caller CANNOT aim the token off loopback (constructor re-validates)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-ghbase-ctor-'));
  try {
    const file = join(root, 'github.json');
    for (const bad of [
      'https://api.evil.example.com',
      'http://127.0.0.2:8787',
      'http://127.0.0.1:8787/prefix',
      'http://user:pw@127.0.0.1:8787',
      'ftp://127.0.0.1:8787',
    ]) {
      assert.throws(
        () => new GithubConnection({ file, log: noop, clientId: 'Iv1.x', apiBase: bad }),
        /AI_SM_GITHUB_API_BASE/,
        `constructing with apiBase ${bad} must throw`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GithubConnection: absent / empty / whitespace / the literal default apiBase all construct cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-ghbase-ok-'));
  try {
    const file = join(root, 'github.json');
    for (const ok of [undefined, '', '   ', DEFAULT_GITHUB_API_BASE, 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
      const conn = new GithubConnection({ file, log: noop, clientId: 'Iv1.x', apiBase: ok });
      assert.deepEqual(
        conn.status(),
        { deviceFlowAvailable: true, state: 'disconnected' },
        `apiBase ${JSON.stringify(ok)} must construct and start disconnected`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The override re-points ONLY the REST base
// ---------------------------------------------------------------------------

test('the API-base override does NOT move the device flow: code+token stay on github.com, only /user and /user/repos follow it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-ghbase-flow-'));
  try {
    const file = join(root, 'github.json');
    const base = 'http://127.0.0.1:9'; // never contacted — every call goes through the seam
    const calls: string[] = [];
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const stub: FetchLike = (url) => {
      calls.push(url);
      if (url === 'https://github.com/login/device/code') {
        return Promise.resolve(
          json({
            device_code: 'DEV-CODE',
            user_code: 'WDJB-MJHT',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 0.02, // 20ms — a deterministic, condition-waited cadence
          }),
        );
      }
      if (url === 'https://github.com/login/oauth/access_token') {
        return Promise.resolve(json({ access_token: SECRET, token_type: 'bearer', scope: 'repo' }));
      }
      if (url === `${base}/user`) return Promise.resolve(json({ login: 'octocat' }));
      if (url.startsWith(`${base}/user/repos`)) {
        return Promise.resolve(
          json([
            {
              full_name: 'octocat/hello',
              name: 'hello',
              owner: { login: 'octocat' },
              clone_url: 'https://github.com/octocat/hello.git',
            },
          ]),
        );
      }
      return Promise.resolve(json({ error: 'unexpected url' }, 404));
    };

    const conn = new GithubConnection({ file, log: noop, clientId: 'Iv1.x', apiBase: base, fetchImpl: stub });
    const started = await conn.startDeviceFlow();
    assert.ok(started.ok, 'the device flow starts');
    await waitUntil(
      () => (conn.status().state === 'connected' ? true : undefined),
      'the device flow to reach connected',
      5_000,
      10,
    );
    const repos = await conn.listRepos();
    assert.deepEqual(repos.map((r) => r.name), ['hello']);

    // The device-flow endpoints are HARDCODED on github.com — the override
    // must never be able to steer the OAuth exchange to a different host.
    assert.ok(
      calls.includes('https://github.com/login/device/code'),
      'the device-code request went to github.com, not the override',
    );
    assert.ok(
      calls.includes('https://github.com/login/oauth/access_token'),
      'the token poll went to github.com, not the override',
    );
    assert.equal(
      calls.filter((u) => u.startsWith(base)).length,
      2,
      'exactly the two REST calls (/user, /user/repos) follow the override',
    );
    assert.ok(calls.includes(`${base}/user`), '/user follows the override');
    assert.ok(
      calls.some((u) => u === `${base}/user/repos?per_page=100&sort=pushed&page=1`),
      '/user/repos follows the override, query intact',
    );
    for (const u of calls) {
      assert.ok(!u.includes(SECRET), `the token is NEVER in a request url (${u})`);
    }
    assert.ok(
      !JSON.stringify(conn.status()).includes(SECRET),
      'status never carries the token',
    );

    await conn.disconnect(); // stop the poll timer / drop github.json
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Token-bearing requests never follow a redirect (redirect: 'error')
// ---------------------------------------------------------------------------

interface Recorder {
  origin: string;
  paths: string[];
  stop: () => Promise<void>;
}

/** A loopback node:http server that records every request path and replies per-path. */
function startRecorder(
  reply: (path: string) => { status: number; location?: string; body: string },
): Promise<Recorder> {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? '';
    paths.push(path);
    const r = reply(path);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (r.location !== undefined) headers['location'] = r.location;
    res.writeHead(r.status, headers);
    res.end(r.body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${addr.port}`,
        paths,
        stop: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** A github.json (0600) that boots a GithubConnection straight into `connected`. */
async function seedTokenFile(dir: string): Promise<string> {
  const file = join(dir, 'github.json');
  await writeFile(
    file,
    JSON.stringify({ accessToken: SECRET, login: 'octocat', scope: 'repo', connectedAt: '2026-07-24T00:00:00Z' }) +
      '\n',
    { mode: 0o600 },
  );
  return file;
}

test('a REDIRECTING api base is REFUSED, never followed — a token-bearing request makes no second hop', async () => {
  // Uses the REAL global fetch (no fetchImpl seam) against real loopback
  // servers: the point is what the HTTP client does with a 3xx, which a stubbed
  // fetch cannot prove. Without redirect:'error' the request would be followed
  // up to 20 times, making the backend issue attacker-chosen outbound requests
  // whose bodies are then parsed as a repo list; Authorization stripping across
  // origins is undici's behaviour, not a guarantee this repo owns.
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-ghbase-redirect-'));
  const target = await startRecorder(() => ({
    status: 200,
    body: JSON.stringify([
      { full_name: 'evil/pwned', name: 'pwned', owner: { login: 'evil' }, clone_url: 'https://github.com/evil/pwned.git' },
    ]),
  }));
  try {
    const file = await seedTokenFile(root);
    for (const status of [301, 302, 303, 307, 308]) {
      const redirector = await startRecorder((path) =>
        path.startsWith('/user/repos')
          ? { status, location: `${target.origin}/user/repos`, body: '' }
          : { status: 200, body: JSON.stringify({ login: 'octocat' }) },
      );
      try {
        const conn = new GithubConnection({
          file,
          log: noop,
          clientId: 'Iv1.x',
          apiBase: redirector.origin,
        });
        assert.equal(conn.status().state, 'connected', 'the seed boots connected');
        await assert.rejects(
          conn.listRepos(),
          (err: unknown) => {
            assert.ok(err instanceof GithubError, `${status} must surface as a GithubError`);
            assert.equal(err.status, 502, `${status} must surface as 502, never a followed hop`);
            return true;
          },
          `HTTP ${status} from the api base must be refused`,
        );
        assert.deepEqual(target.paths, [], `HTTP ${status}: the redirect target was NEVER contacted`);
        assert.equal(
          redirector.paths.length,
          1,
          `HTTP ${status}: exactly the one refused request, no retry loop`,
        );
      } finally {
        await redirector.stop();
      }
    }
  } finally {
    await target.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('a SAME-ORIGIN redirect is refused too — the hop undici would still send the token on', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-ghbase-redirect-same-'));
  const srv = await startRecorder((path) =>
    path.startsWith('/user/repos')
      ? { status: 307, location: '/elsewhere', body: '' }
      : { status: 200, body: JSON.stringify([]) },
  );
  try {
    const file = await seedTokenFile(root);
    const conn = new GithubConnection({ file, log: noop, clientId: 'Iv1.x', apiBase: srv.origin });
    await assert.rejects(conn.listRepos(), (err: unknown) => {
      assert.ok(err instanceof GithubError);
      assert.equal(err.status, 502);
      return true;
    });
    assert.deepEqual(srv.paths, ['/user/repos?per_page=100&sort=pushed&page=1'], '/elsewhere is never fetched');
  } finally {
    await srv.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('createRepo — the token-bearing POST refuses a redirect too (the GET path is not the only one)', async () => {
  // The two tests above only exercise listRepos (a GET). createRepo is the other
  // token-bearing call and the more dangerous one to replay: a 302/303 makes
  // undici re-issue it as a GET at the new target, a 307 forwards the JSON body
  // verbatim. Both are refused because every request goes through the one #http
  // chokepoint — this pins that the POST really goes through it.
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-ghbase-redirect-post-'));
  const target = await startRecorder(() => ({
    status: 201,
    body: JSON.stringify({
      full_name: 'evil/pwned',
      name: 'pwned',
      owner: { login: 'evil' },
      clone_url: 'https://github.com/evil/pwned.git',
    }),
  }));
  try {
    const file = await seedTokenFile(root);
    for (const status of [302, 303, 307]) {
      const redirector = await startRecorder(() => ({
        status,
        location: `${target.origin}/user/repos`,
        body: '',
      }));
      try {
        const conn = new GithubConnection({
          file,
          log: noop,
          clientId: 'Iv1.x',
          apiBase: redirector.origin,
        });
        await assert.rejects(
          conn.createRepo({ name: 'newrepo', private: true }),
          (err: unknown) => {
            assert.ok(err instanceof GithubError, `${status} must surface as a GithubError`);
            assert.equal(err.status, 502, `${status} must surface as 502, never a followed hop`);
            assert.equal(err.message, 'failed to reach github');
            return true;
          },
          `HTTP ${status} on the create POST must be refused`,
        );
        assert.deepEqual(target.paths, [], `HTTP ${status}: the redirect target was NEVER contacted`);
        assert.deepEqual(redirector.paths, ['/user/repos'], `HTTP ${status}: exactly one refused request`);
      } finally {
        await redirector.stop();
      }
    }
  } finally {
    await target.stop();
    await rm(root, { recursive: true, force: true });
  }
});
