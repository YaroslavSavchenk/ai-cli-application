/**
 * The PASTED-TOKEN credential path (POST /api/github/token, 2026-07-25).
 *
 * A security design gate ran BEFORE this feature was written; its constraints
 * are the specification, and most of this file exists to pin them:
 *
 *   INGRESS   the route lives under /api (so it inherits the X-Auth-Token +
 *             Host/Origin gate), is POST-only, reads the token from the BODY
 *             and nowhere else, requires application/json, and caps the body at
 *             4 KiB.
 *   NO LEAK   a malformed body must NEVER put a fragment of the credential into
 *             server.log — see the "canary" test, which is the reason the route
 *             parses its own body instead of falling through to the generic
 *             handler (Node embeds ~10 characters of the input in a JSON.parse
 *             SyntaxError, and that handler logs `String(err)`).
 *   COPY      failures are derived from GitHub's STATUS, never from its body.
 *   SHAPE     validation is trim + non-empty + <= 1024 chars + no whitespace or
 *             control characters. NO prefix allowlist — every real token shape
 *             (ghp_, github_pat_, gho_, ghu_, ghs_, legacy 40-hex) is accepted.
 *   STORAGE   remember=true writes github.json (0600, source:'pat');
 *             remember=false writes NOTHING and a restart is disconnected.
 *
 * OFFLINE by construction: the connected paths run against a local node:http
 * stub standing in for api.github.com through the loopback-only
 * AI_SM_GITHUB_API_BASE seam. The pasted tokens below are fakes — but every
 * assertion treats them as real credentials.
 *
 * This file keeps every test that drives the ONE shared server child, because
 * its last test sweeps that child's whole server.log for a fragment of the
 * credential — a sweep over the requests of the tests before it. Split out by
 * topic (PLAN-RESTRUCTURE O6), each with its own server children or none:
 * `github-token-lifecycle.test.ts` (GitHub unreachable, a later 401,
 * remember=false across a restart) and `github-token-in-process.test.ts` (the
 * device-flow replacement and the pure helpers). The stub is
 * `tests/helpers/github-token-fixture.ts`.
 *
 * NOT claimed here: a real GitHub — the stub stands in for it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MAX_PASTED_TOKEN_LEN,
} from '../../server/github.ts';
import type { GithubStatus } from '../../shared/protocol.ts';
import {
  api,
  rawRequest,
  readServerLog,
  startTestServer,
  type TestServer,
} from '../helpers/helpers.ts';
import {
  PASTED,
  StubApi,
  acceptingHandler,
  postToken,
} from '../helpers/github-token-fixture.ts';

/** Fake token used only by the malformed-body log test — must never be logged. */
const CANARY = 'ghp_ZQXCANARY0123456789abcdefghijKLMNOPqr';

// ---------------------------------------------------------------------------
// 1. The happy path, on a server with NO OAuth client id — the exact situation
//    this credential path exists for.
// ---------------------------------------------------------------------------

let stub: StubApi;
let server: TestServer;

before(async () => {
  stub = new StubApi();
  await stub.start();
  stub.handler = acceptingHandler();
  server = await startTestServer({
    // NO client id: the device flow is unavailable, the paste path is not.
    env: { AI_SM_GITHUB_CLIENT_ID: '', AI_SM_GITHUB_API_BASE: stub.origin },
  });
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (stub !== undefined) await stub.stop();
});

test('happy path: a pasted token validates, connects, persists (0600, source:pat) and never comes back in any response', async () => {
  stub.reset();
  stub.handler = acceptingHandler({ 'x-oauth-scopes': 'repo, read:org' });

  const before = await api(server, 'GET', '/api/github/status');
  assert.deepEqual(
    before.body,
    { deviceFlowAvailable: false, state: 'disconnected' },
    'no client id -> the device flow is unavailable, and nothing is connected yet',
  );

  const res = await postToken(server, { token: PASTED, remember: true });
  assert.equal(res.status, 200);
  const status = res.body as GithubStatus;
  assert.deepEqual(status, {
    deviceFlowAvailable: false,
    state: 'connected',
    login: 'octocat',
    source: 'pat',
    persisted: true,
    scopes: ['repo', 'read:org'],
  });
  assert.ok(!JSON.stringify(res.body).includes(PASTED), 'the response NEVER echoes the token');

  // Both probes ran, with the token as a Bearer header and never in a url.
  assert.deepEqual(
    stub.requests.map((r) => `${r.method} ${r.path}`),
    ['GET /user', 'GET /user/repos?per_page=1'],
    'identity first, then the capability the app actually needs',
  );
  for (const out of stub.requests) {
    assert.equal(out.authorization, `Bearer ${PASTED}`);
    assert.ok(!out.path.includes(PASTED), 'the token is NEVER in the request url');
  }

  // GET /api/github/status agrees, and is still token-free.
  const after = await api(server, 'GET', '/api/github/status');
  assert.deepEqual(after.body, status);
  assert.ok(!JSON.stringify(after.body).includes(PASTED));

  // github.json: 0600, holds the token, records the source.
  const file = join(server.dataDir, 'github.json');
  const st = await stat(file);
  assert.equal(st.mode & 0o777, 0o600, 'github.json must be mode 0600');
  const stored = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.equal(stored['accessToken'], PASTED, 'the token IS stored server-side');
  assert.equal(stored['source'], 'pat');
  assert.equal(stored['login'], 'octocat');
  assert.deepEqual(stored['scopes'], ['repo', 'read:org']);
});

test('the pasted credential is used by the rest of the surface — repos list with NO client id configured', async () => {
  stub.reset();
  stub.handler = acceptingHandler();
  const res = await api(server, 'GET', '/api/github/repos');
  assert.equal(res.status, 200, 'a pasted token is a first-class credential');
  assert.equal((res.body as { repos: unknown[] }).repos.length, 1);
  assert.equal(stub.requests[0]?.authorization, `Bearer ${PASTED}`);
  assert.ok(!JSON.stringify(res.body).includes(PASTED));
});

test('disconnect behaves identically for a pasted token: github.json deleted, state disconnected', async () => {
  const res = await api(server, 'POST', '/api/github/disconnect');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual((await api(server, 'GET', '/api/github/status')).body, {
    deviceFlowAvailable: false,
    state: 'disconnected',
  });
  await assert.rejects(
    stat(join(server.dataDir, 'github.json')),
    'the stored credential is removed from disk',
  );
});

test('whitespace around a paste is trimmed (clipboards add it) — the trimmed value is what GitHub sees', async () => {
  stub.reset();
  stub.handler = acceptingHandler();
  const res = await postToken(server, { token: `\n  ${PASTED}\t \n`, remember: false });
  assert.equal(res.status, 200);
  assert.equal(stub.requests[0]?.authorization, `Bearer ${PASTED}`, 'trimmed before use');
  await api(server, 'POST', '/api/github/disconnect');
});

test('fine-grained token: GitHub sends no x-oauth-scopes, so `scopes` is ABSENT — never an empty list', async () => {
  stub.reset();
  stub.handler = acceptingHandler(); // no scopes header at all
  const res = await postToken(server, { token: PASTED, remember: false });
  assert.equal(res.status, 200);
  const status = res.body as GithubStatus;
  assert.ok(!('scopes' in status), 'absence is reported as absence, not as "no permissions"');
  assert.equal(status.source, 'pat');
  await api(server, 'POST', '/api/github/disconnect');
});

test('a classic token with NO scopes is different: an empty x-oauth-scopes header means scopes: []', async () => {
  stub.reset();
  stub.handler = acceptingHandler({ 'x-oauth-scopes': '' });
  const res = await postToken(server, { token: PASTED, remember: false });
  assert.equal(res.status, 200);
  assert.deepEqual((res.body as GithubStatus).scopes, [], 'present-but-empty is a real answer');
  await api(server, 'POST', '/api/github/disconnect');
});

test('an expiring token: the expiration header becomes ISO-8601 expiresAt (V-4)', async () => {
  stub.reset();
  stub.handler = acceptingHandler({
    'github-authentication-token-expiration': '2026-12-31 00:00:00 UTC',
  });
  const res = await postToken(server, { token: PASTED, remember: true });
  assert.equal(res.status, 200);
  assert.equal((res.body as GithubStatus).expiresAt, '2026-12-31T00:00:00.000Z');
  const stored = JSON.parse(
    await readFile(join(server.dataDir, 'github.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(stored['expiresAt'], '2026-12-31T00:00:00.000Z', 'the expiry survives a restart');
  await api(server, 'POST', '/api/github/disconnect');
});

// ---------------------------------------------------------------------------
// 2. Ingress rules (I-1 / I-4) and body validation (III-5)
// ---------------------------------------------------------------------------

test('POST-only: GET /api/github/token is 405 — a credential must never ride in a request line', async () => {
  assert.equal((await api(server, 'GET', '/api/github/token')).status, 405);
  assert.equal((await api(server, 'PUT', '/api/github/token')).status, 405);
  assert.equal((await api(server, 'DELETE', '/api/github/token')).status, 405);
});

test('the route inherits the /api gate: 401 without the app token, 403 on a foreign Host/Origin, and GitHub is never called', async () => {
  stub.reset();
  stub.handler = acceptingHandler();
  const body = JSON.stringify({ token: PASTED, remember: false });

  const noToken = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/github/token',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(noToken.status, 401);

  const wrongToken = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/github/token',
    headers: { 'content-type': 'application/json', 'x-auth-token': '0'.repeat(64) },
    body,
  });
  assert.equal(wrongToken.status, 401);

  const evilHost = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/github/token',
    headers: {
      'content-type': 'application/json',
      'x-auth-token': server.token,
      host: `evil.example.com:${server.port}`,
    },
    body,
  });
  assert.equal(evilHost.status, 403);

  const evilOrigin = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/github/token',
    headers: {
      'content-type': 'application/json',
      'x-auth-token': server.token,
      origin: 'http://evil.example.com',
    },
    body,
  });
  assert.equal(evilOrigin.status, 403);

  assert.equal(stub.requests.length, 0, 'a rejected request never reaches GitHub');
  assert.deepEqual(
    (await api(server, 'GET', '/api/github/status')).body,
    { deviceFlowAvailable: false, state: 'disconnected' },
    'and nothing is connected',
  );
});

test('content-type must be application/json (415), and a form/text post never reaches the parser', async () => {
  stub.reset();
  const cases = ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'];
  for (const ct of cases) {
    const res = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/github/token',
      headers: { 'content-type': ct, 'x-auth-token': server.token },
      body: JSON.stringify({ token: PASTED, remember: false }),
    });
    assert.equal(res.status, 415, `${ct} must be 415`);
  }
  // Absent content-type is refused too.
  const none = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/github/token',
    headers: { 'x-auth-token': server.token },
    body: JSON.stringify({ token: PASTED, remember: false }),
  });
  assert.equal(none.status, 415);
  // A charset parameter is fine.
  stub.handler = acceptingHandler();
  const ok = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/github/token',
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-auth-token': server.token },
    body: JSON.stringify({ token: PASTED, remember: false }),
  });
  assert.equal(ok.status, 200, 'application/json; charset=utf-8 is still application/json');
  assert.ok(!ok.body.includes(PASTED), 'the 200 body never echoes the token');
  await api(server, 'POST', '/api/github/disconnect');
  assert.equal(stub.requests.length, 2, 'only the accepted request talked to GitHub');
});

test('a body over the dedicated 4 KiB cap is refused (413) without being parsed or forwarded', async () => {
  stub.reset();
  const huge = JSON.stringify({ token: PASTED, remember: true, pad: 'x'.repeat(8000) });
  const res = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/github/token',
    headers: { 'content-type': 'application/json', 'x-auth-token': server.token },
    body: huge,
  });
  assert.equal(res.status, 413);
  assert.ok(!res.body.includes(PASTED), 'the refusal quotes nothing from the body');
  assert.equal(stub.requests.length, 0, 'an over-sized body never reaches GitHub');
});

test('body validation: bad shapes are 400 and never reach GitHub; the messages quote NO part of the token', async () => {
  stub.reset();
  const long = 'g'.repeat(MAX_PASTED_TOKEN_LEN + 1);
  const cases: [string, unknown, number][] = [
    ['missing token', { remember: true }, 400],
    ['non-string token', { token: 42, remember: true }, 400],
    ['blank token', { token: '   ', remember: true }, 400],
    ['token over 1024 chars', { token: long, remember: true }, 400],
    ['missing remember', { token: PASTED }, 400],
    ['non-boolean remember', { token: PASTED, remember: 'yes' }, 400],
    ['array body', [PASTED], 400],
    ['string body', PASTED, 400],
    ['null body', null, 400],
    ['token with a space', { token: 'ghp_ab cd', remember: true }, 400],
    ['token with a tab', { token: 'ghp_ab\tcd', remember: true }, 400],
    ['token with a newline', { token: 'ghp_ab\ncd', remember: true }, 400],
    ['token with a control char', { token: 'ghp_ab\u0001cd', remember: true }, 400],
    ['token with a NUL', { token: 'ghp_ab\u0000cd', remember: true }, 400],
    ['token with a non-breaking space', { token: 'ghp_ab\u00a0cd', remember: true }, 400],
  ];
  for (const [what, body, expected] of cases) {
    const res = await postToken(server, body);
    assert.equal(res.status, expected, `${what} must be ${expected}`);
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes(long.slice(0, 16)), `${what}: no fragment of the value`);
    assert.ok(!text.includes('ghp_ab'), `${what}: no fragment of the value`);
  }
  assert.equal(stub.requests.length, 0, 'nothing invalid ever reaches GitHub');
  assert.deepEqual((await api(server, 'GET', '/api/github/status')).body, {
    deviceFlowAvailable: false,
    state: 'disconnected',
  });
});

test('NO prefix allowlist: every real GitHub token shape is accepted (ghp_/github_pat_/gho_/ghu_/ghs_/legacy 40-hex)', async () => {
  const shapes = [
    'ghp_0123456789abcdefghijklmnopqrstuvwxyz',
    'github_pat_11ABCDEFG0abcdefghijkl_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef',
    'gho_0123456789abcdefghijklmnopqrstuvwxyz',
    'ghu_0123456789abcdefghijklmnopqrstuvwxyz',
    'ghs_0123456789abcdefghijklmnopqrstuvwxyz',
    '0123456789abcdef0123456789abcdef01234567', // legacy 40-hex
    'a-shape-github-has-not-invented-yet',
  ];
  for (const shape of shapes) {
    stub.reset();
    stub.handler = acceptingHandler();
    const res = await postToken(server, { token: shape, remember: false });
    assert.equal(res.status, 200, `${shape.slice(0, 12)}… must be accepted on GitHub's word`);
    assert.equal(stub.requests[0]?.authorization, `Bearer ${shape}`);
    await api(server, 'POST', '/api/github/disconnect');
  }
});

// ---------------------------------------------------------------------------
// 3. THE NON-NEGOTIABLE ONE: a malformed body must not leak into server.log.
// ---------------------------------------------------------------------------

/**
 * Fail if ANY recognizable fragment of `secret` appears in `log`: every prefix
 * down to 4 characters (Node embeds the first ~10 characters of the input in a
 * JSON.parse SyntaxError) and every 8-character window anywhere inside it.
 */
function assertNoFragment(log: string, secret: string, what: string): void {
  for (let n = secret.length; n >= 4; n -= 1) {
    const frag = secret.slice(0, n);
    assert.ok(
      !log.includes(frag),
      `${what}: server.log contains the ${n}-char prefix ${JSON.stringify(frag)}`,
    );
  }
  for (let i = 0; i + 8 <= secret.length; i += 1) {
    const win = secret.slice(i, i + 8);
    assert.ok(!log.includes(win), `${what}: server.log contains ${JSON.stringify(win)}`);
  }
}

test('MALFORMED BODY CARRYING A SECRET: 400 invalid JSON body, and server.log holds NO fragment of it', async () => {
  // Measured, not hypothetical: JSON.parse('ghp_S3CRET_TOKEN_VALUE_1234567890')
  // throws `SyntaxError: Unexpected token 'g', "ghp_S3CRET"... is not valid
  // JSON`, and the generic handler logs `request … failed: ${String(err)}`. If
  // this route ever stops parsing its own body, that line appends ten
  // characters of a real credential to server.log — which is 0600, readable
  // from Windows regardless (memory/knowledge/wsl-0600-not-a-boundary.md), and
  // survives into server.log.1.
  //
  // Its OWN server + data dir, so the log contains nothing but this exchange
  // and a 4-character fragment cannot come from anywhere else.
  const ownStub = new StubApi();
  await ownStub.start();
  ownStub.handler = acceptingHandler();
  const srv = await startTestServer({
    env: { AI_SM_GITHUB_CLIENT_ID: '', AI_SM_GITHUB_API_BASE: ownStub.origin },
  });
  try {
    // (a) the raw credential as the whole body — the shape that leaks.
    const bare = await rawRequest(srv.port, {
      method: 'POST',
      path: '/api/github/token',
      headers: { 'content-type': 'application/json', 'x-auth-token': srv.token },
      body: CANARY,
    });
    assert.equal(bare.status, 400);

    // (b) a truncated object body — the realistic "paste went wrong" shape.
    const truncated = await rawRequest(srv.port, {
      method: 'POST',
      path: '/api/github/token',
      headers: { 'content-type': 'application/json', 'x-auth-token': srv.token },
      body: `{"token":"${CANARY}", "remember"`,
    });
    assert.equal(truncated.status, 400);

    // (c) a trailing-comma object — a different SyntaxError position.
    const trailing = await rawRequest(srv.port, {
      method: 'POST',
      path: '/api/github/token',
      headers: { 'content-type': 'application/json', 'x-auth-token': srv.token },
      body: `{"token":"${CANARY}",}`,
    });
    assert.equal(trailing.status, 400);

    // (d) a NUL-poisoned body.
    const nul = await rawRequest(srv.port, {
      method: 'POST',
      path: '/api/github/token',
      headers: { 'content-type': 'application/json', 'x-auth-token': srv.token },
      body: `\u0000${CANARY}`,
    });
    assert.equal(nul.status, 400);

    // Give the (async, best-effort) logger a moment, then read everything.
    await delay(100);
    const log = await readServerLog(srv);
    const rotated = await readFile(join(srv.dataDir, 'server.log.1'), 'utf8').catch(() => '');
    const all = log + rotated;

    // THE assertion. It is deliberately made BEFORE the response-shape check
    // below: swap this route back to the generic body reader and THIS is what
    // fails first, with the leaked fragment quoted in the failure message —
    // rather than the test merely noticing a different error string.
    assertNoFragment(all, CANARY, 'malformed body');
    // The generic handler is what would have logged it — prove we never reached it.
    assert.ok(
      !all.includes('/api/github/token failed'),
      'the route must never fall through to the generic `request ... failed: String(err)` logger',
    );
    assert.ok(!all.includes('is not valid JSON'), 'no JSON.parse error text reaches the log');
    assert.ok(!all.includes('SyntaxError'), 'no parser error object reaches the log');

    // Only now the exact refusal shape (the leak assertion above must fire first).
    assert.deepEqual(JSON.parse(bare.body), { error: 'invalid JSON body' });

    // The route still works afterwards (the refusals are not fatal).
    const ok = await postToken(srv, { token: PASTED, remember: false });
    assert.equal(ok.status, 200);
    const after = await readServerLog(srv);
    assert.ok(after.includes('github token accepted'), 'the accept line is a CONSTANT string');
    assert.ok(!after.includes(PASTED), 'and it never carries the token');
  } finally {
    await srv.stop();
    await ownStub.stop();
  }
});

test('the OTHER refusal paths are just as quiet: 415, 413 and every 400 leave NO fragment in server.log', async () => {
  // The canary test above covers ONE refusal shape (a body that will not parse).
  // These are the other four ways a request carrying a credential is turned away
  // — content-type, size cap, and the two body-shape rules — and none of them was
  // log-asserted. Each has the token in scope at the moment it is refused, and a
  // future `sendError(res, 400, \`bad token: ${value}\`)` or a rethrow into the
  // generic `String(err)` logger would be invisible without this.
  const CANARY2 = 'ghp_QUIETPATHS_9876543210zyxwvutsrq';

  // 415: refused before the body is read at all.
  await rawRequest(server.port, {
    method: 'POST',
    path: '/api/github/token',
    headers: { 'content-type': 'text/plain', 'x-auth-token': server.token },
    body: JSON.stringify({ token: CANARY2, remember: false }),
  });
  // 413: refused mid-stream, over the dedicated 4 KiB cap.
  await rawRequest(server.port, {
    method: 'POST',
    path: '/api/github/token',
    headers: { 'content-type': 'application/json', 'x-auth-token': server.token },
    body: JSON.stringify({ token: CANARY2, remember: true, pad: 'x'.repeat(8000) }),
  });
  // 405: wrong method, with the credential in a body that must never be read.
  await rawRequest(server.port, {
    method: 'PUT',
    path: '/api/github/token',
    headers: { 'content-type': 'application/json', 'x-auth-token': server.token },
    body: JSON.stringify({ token: CANARY2, remember: false }),
  });
  // 400s: valid JSON, invalid shape — the token is in scope when each rule fails.
  for (const body of [
    { token: CANARY2 }, // remember missing
    { token: CANARY2, remember: 'yes' }, // remember not a boolean
    { token: `${CANARY2} trailing words`, remember: true }, // whitespace inside
    { token: `${CANARY2} tail`, remember: true }, // Unicode whitespace INSIDE
    // Deliberately NOT here: SURROUNDING whitespace (plain or NBSP). JS trim()
    // removes both, so that is an accepted paste, not a refusal path.
    { token: CANARY2.padEnd(MAX_PASTED_TOKEN_LEN + 1, 'x'), remember: true }, // over the cap
  ]) {
    const res = await postToken(server, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
    assert.ok(
      !JSON.stringify(res.body).includes(CANARY2.slice(0, 8)),
      'no refusal RESPONSE quotes the value either',
    );
  }

  await delay(100);
  const log = await readServerLog(server);
  const rotated = await readFile(join(server.dataDir, 'server.log.1'), 'utf8').catch(() => '');
  assertNoFragment(log + rotated, CANARY2, 'non-parse refusal paths');
});

test('the token never rides in a query string: a ?token= parameter is ignored and never logged', async () => {
  stub.reset();
  stub.handler = acceptingHandler();
  const res = await rawRequest(server.port, {
    method: 'POST',
    path: `/api/github/token?token=${CANARY}`,
    headers: { 'content-type': 'application/json', 'x-auth-token': server.token },
    body: JSON.stringify({ token: PASTED, remember: false }),
  });
  assert.equal(res.status, 200, 'the BODY decides; the query is not an ingress');
  assert.equal(
    stub.requests[0]?.authorization,
    `Bearer ${PASTED}`,
    'the query parameter is never used as the credential',
  );
  await delay(50);
  assertNoFragment(await readServerLog(server), CANARY, 'query parameter');
  await api(server, 'POST', '/api/github/disconnect');
});

test('the SHARED request-failure logger leaks NEITHER a body fragment NOR the query string, on any route', async () => {
  // Measured on a running server before this was hardened:
  //   [error] request POST /api/projects failed: SyntaxError: Unexpected token
  //   'g', "ghp_PROBEC"... is not valid JSON
  // The token route parses its own body (the canary test above), but every OTHER
  // POST still lands in `handle(...).catch(...)`, which interpolated
  // `String(err)` — the JSON.parse fragment — and `req.url`, query string
  // included. No secret rides these routes today, so this is hardening, not a
  // live leak; the point is that the shared handler can never become one.
  const BODY_PROBE = 'ghp_BODYPROBE0123456789abcdefghijklmnop';
  const QUERY_PROBE = 'ghp_QUERYPROBE9876543210zyxwvutsrqponm';

  for (const path of ['/api/projects', '/api/sessions', '/api/fs/mkdir', '/api/fs/create']) {
    const res = await rawRequest(server.port, {
      method: 'POST',
      path: `${path}?probe=${QUERY_PROBE}`,
      headers: { 'content-type': 'application/json', 'x-auth-token': server.token },
      body: BODY_PROBE,
    });
    assert.equal(res.status, 400, `${path} refuses the malformed body`);
    assert.ok(!res.body.includes(BODY_PROBE.slice(0, 8)), 'the RESPONSE quotes nothing either');
  }

  await delay(100);
  const log = await readServerLog(server);
  const rotated = await readFile(join(server.dataDir, 'server.log.1'), 'utf8').catch(() => '');
  const all = log + rotated;

  assertNoFragment(all, BODY_PROBE, 'shared handler / request body');
  assertNoFragment(all, QUERY_PROBE, 'shared handler / query string');
  assert.ok(!all.includes('probe='), 'no query string reaches the log at all');
  assert.ok(!all.includes('is not valid JSON'), 'no JSON.parse error text reaches the log');

  // The other half of the requirement: the line stays USEFUL for debugging —
  // method, pathname, and the error's class name, all constants.
  assert.ok(
    all.includes('request POST /api/projects failed (SyntaxError)'),
    'the failure is still logged, as a constant message plus the error class',
  );
});

// ---------------------------------------------------------------------------
// 4. Failure mapping — derived from GitHub's STATUS, never from its body
// ---------------------------------------------------------------------------

test('401 from GitHub -> 400 "GitHub rejected this token", nothing stored, body never surfaced', async () => {
  stub.reset();
  stub.handler = () => ({
    status: 401,
    body: { message: 'Bad credentials — internal-github-detail' },
  });
  const res = await postToken(server, { token: PASTED, remember: true });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, {
    error: 'GitHub rejected this token (expired, revoked, or mistyped)',
  });
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes('internal-github-detail'), 'the GitHub body is never surfaced');
  assert.ok(!text.includes(PASTED));
  await assert.rejects(
    stat(join(server.dataDir, 'github.json')),
    'a refused token is never written to disk',
  );
  assert.deepEqual((await api(server, 'GET', '/api/github/status')).body, {
    deviceFlowAvailable: false,
    state: 'disconnected',
  });
});

test('403 from GitHub -> 400 with the SSO-authorization hint (the one 403 a user can act on)', async () => {
  stub.reset();
  stub.handler = () => ({ status: 403, body: { message: 'Resource protected by organization SAML' } });
  const res = await postToken(server, { token: PASTED, remember: true });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, {
    error:
      'GitHub refused this token — if the organization uses SSO, authorize the token for that organization first',
  });
  assert.ok(!JSON.stringify(res.body).includes('SAML'), 'the raw body is never surfaced');
});

test('an unexpected upstream status -> 502 with a generic sentence', async () => {
  stub.reset();
  stub.handler = () => ({ status: 500, body: { message: 'boom-internal' } });
  const res = await postToken(server, { token: PASTED, remember: true });
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: 'GitHub returned an unexpected response' });
  assert.ok(!JSON.stringify(res.body).includes('boom-internal'));
});

// The two probes each end in an `if (!res.ok) -> 502` guard, and the
// 500-everywhere test above cannot tell them apart: whichever guard runs first
// produces the 502, so REMOVING EITHER ONE leaves the suite green (measured —
// both mutants survived). These two split the case so each guard is pinned on
// its own. The scenario is a partial GitHub outage, which is exactly when a
// half-verified credential would otherwise be accepted.

test('an unexpected status on /user alone is refused — even when the repo probe would succeed', async () => {
  stub.reset();
  stub.handler = (req) =>
    req.path === '/user'
      ? { status: 500, body: { message: 'user-endpoint-internal' } }
      : { status: 200, body: [] };
  const res = await postToken(server, { token: PASTED, remember: true });
  assert.equal(res.status, 502, 'identity must be verified, not skipped because the next call worked');
  assert.deepEqual(res.body, { error: 'GitHub returned an unexpected response' });
  assert.ok(!JSON.stringify(res.body).includes('user-endpoint-internal'), 'the body is never surfaced');
  assert.deepEqual(
    stub.requests.map((r) => r.path),
    ['/user'],
    'and the capability probe is never even attempted after an unusable identity answer',
  );
  await assert.rejects(stat(join(server.dataDir, 'github.json')), 'nothing is stored');
  assert.deepEqual((await api(server, 'GET', '/api/github/status')).body, {
    deviceFlowAvailable: false,
    state: 'disconnected',
  });
});

test('an unexpected status on /user/repos alone is refused — a good identity does not excuse a broken capability probe', async () => {
  stub.reset();
  stub.handler = (req) =>
    req.path === '/user'
      ? { status: 200, body: { login: 'octocat' } }
      : { status: 500, body: { message: 'repos-endpoint-internal' } };
  const res = await postToken(server, { token: PASTED, remember: true });
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: 'GitHub returned an unexpected response' });
  assert.ok(!JSON.stringify(res.body).includes('repos-endpoint-internal'), 'the body is never surfaced');
  assert.deepEqual(stub.requests.map((r) => r.path), ['/user', '/user/repos?per_page=1']);
  await assert.rejects(stat(join(server.dataDir, 'github.json')), 'nothing is stored');
  assert.deepEqual((await api(server, 'GET', '/api/github/status')).body, {
    deviceFlowAvailable: false,
    state: 'disconnected',
  });
});

test('a token that authenticates but cannot list repositories is refused at connect time (the capability probe)', async () => {
  stub.reset();
  stub.handler = (req) =>
    req.path === '/user'
      ? { status: 200, body: { login: 'octocat' } }
      : { status: 403, body: { message: 'Resource not accessible by personal access token' } };
  const res = await postToken(server, { token: PASTED, remember: true });
  assert.equal(res.status, 400, 'the /user/repos probe decides too, not just /user');
  assert.deepEqual(
    stub.requests.map((r) => r.path),
    ['/user', '/user/repos?per_page=1'],
  );
  assert.deepEqual((await api(server, 'GET', '/api/github/status')).body, {
    deviceFlowAvailable: false,
    state: 'disconnected',
  });
});

test('a valid token that can see NO repositories still connects — that is a real fine-grained outcome', async () => {
  stub.reset();
  stub.handler = (req) =>
    req.path === '/user'
      ? { status: 200, body: { login: 'octocat' } }
      : { status: 200, body: [] };
  const res = await postToken(server, { token: PASTED, remember: false });
  assert.equal(res.status, 200, 'an empty repo list is not a broken token');
  assert.equal((res.body as GithubStatus).state, 'connected');
  await api(server, 'POST', '/api/github/disconnect');
});

// ---------------------------------------------------------------------------
// 7. The whole-surface log assertion (I-8)
// ---------------------------------------------------------------------------

test('after the whole pasted-token surface: server.log carries the CONSTANT lines and no credential', async () => {
  const log = await readServerLog(server);
  assert.ok(log.length > 0, 'the server logged something (so this assertion is meaningful)');
  // Full fragment scan (every prefix down to 4 chars + every 8-char window),
  // not just a 12-character prefix: a leak that starts mid-token would have
  // slipped through the narrower check.
  assertNoFragment(log, PASTED, 'whole-surface sweep');
  assert.ok(!log.includes('Bearer'), 'no Authorization header is ever logged');
  assert.ok(log.includes('github token accepted'), 'accepts are logged as a constant string');
  assert.ok(log.includes('github token rejected'), 'rejections are logged as a constant string');
});
