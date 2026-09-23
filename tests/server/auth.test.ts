/**
 * Auth surface: token auth on /api, Host/Origin checks, WS upgrade
 * rejection before any data, serve-time token injection, path traversal.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  api,
  projectRoot,
  rawRequest,
  startTestServer,
  wsExpectRejected,
  wsUrl,
  type TestServer,
} from '../helpers/helpers.ts';

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  if (server !== undefined) await server.stop();
});

test('GET /health needs no token and returns exactly {"ok":true}', async () => {
  const res = await fetch(`${server.baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"ok":true}');
});

test('/api requires X-Auth-Token: missing and wrong tokens get 401, correct gets 200', async () => {
  const missing = await rawRequest(server.port, { path: '/api/projects' });
  assert.equal(missing.status, 401, 'no token must be 401');

  const wrong = await rawRequest(server.port, {
    path: '/api/projects',
    headers: { 'x-auth-token': '0'.repeat(64) },
  });
  assert.equal(wrong.status, 401, 'wrong token must be 401');

  const truncated = await rawRequest(server.port, {
    path: '/api/projects',
    headers: { 'x-auth-token': server.token.slice(0, 32) },
  });
  assert.equal(truncated.status, 401, 'truncated token must be 401');

  const ok = await api(server, 'GET', '/api/projects');
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.body), 'GET /api/projects must return an array');
});

test('forbidden Host header gets 403 even with a valid token', async () => {
  const evil = await rawRequest(server.port, {
    path: '/api/projects',
    headers: { host: `evil.example.com:${server.port}`, 'x-auth-token': server.token },
  });
  assert.equal(evil.status, 403, 'DNS-rebinding Host must be 403');

  const noPort = await rawRequest(server.port, {
    path: '/api/projects',
    headers: { host: '127.0.0.1', 'x-auth-token': server.token },
  });
  assert.equal(noPort.status, 403, 'Host without the port must be 403');

  const evilHealth = await rawRequest(server.port, {
    path: '/health',
    headers: { host: `evil.example.com:${server.port}` },
  });
  assert.equal(evilHealth.status, 403, 'Host check must cover /health too');
});

test('Origin header, when present, must be the loopback origin', async () => {
  const evil = await rawRequest(server.port, {
    path: '/api/projects',
    headers: { origin: 'http://evil.example.com', 'x-auth-token': server.token },
  });
  assert.equal(evil.status, 403, 'cross-origin request must be 403');

  const https = await rawRequest(server.port, {
    path: '/api/projects',
    headers: { origin: `https://127.0.0.1:${server.port}`, 'x-auth-token': server.token },
  });
  assert.equal(https.status, 403, 'non-http scheme origin must be 403');

  const local = await rawRequest(server.port, {
    path: '/api/projects',
    headers: { origin: `http://localhost:${server.port}`, 'x-auth-token': server.token },
  });
  assert.equal(local.status, 200);

  const loop = await rawRequest(server.port, {
    path: '/api/projects',
    headers: { origin: `http://127.0.0.1:${server.port}`, 'x-auth-token': server.token },
  });
  assert.equal(loop.status, 200);
});

test('WS upgrade is rejected before any data: bad/missing token, unknown session, evil origin', async () => {
  const anyId = '00000000-0000-4000-8000-000000000000';

  const badToken = await wsExpectRejected(wsUrl(server, anyId, 'wrong-token'));
  assert.match(badToken, /401/, `bad token must be rejected with 401, got: ${badToken}`);

  const noToken = await wsExpectRejected(
    `ws://127.0.0.1:${server.port}/ws/sessions/${anyId}`,
  );
  assert.match(noToken, /401/, `missing token must be rejected with 401, got: ${noToken}`);

  const unknown = await wsExpectRejected(wsUrl(server, anyId));
  assert.match(unknown, /404/, `unknown session with valid token must be 404, got: ${unknown}`);

  const evilOrigin = await wsExpectRejected(wsUrl(server, anyId), {
    origin: 'http://evil.example.com',
  });
  assert.match(evilOrigin, /403/, `evil Origin must be rejected with 403, got: ${evilOrigin}`);

  const badPath = await wsExpectRejected(
    `ws://127.0.0.1:${server.port}/ws/other?token=${server.token}`,
  );
  assert.match(badPath, /404/, `non-session ws path must be 404, got: ${badPath}`);
});

test('static / serves the token-injected page (no-store) and traversal is blocked', async () => {
  // web/dist is build output; produce it if this is a fresh checkout.
  if (!existsSync(join(projectRoot, 'web', 'dist', 'index.html'))) {
    const build = spawnSync('npm', ['run', 'build'], {
      cwd: projectRoot,
      stdio: 'ignore',
      timeout: 120_000,
    });
    assert.equal(build.status, 0, 'npm run build failed while preparing web/dist');
  }

  const page = await rawRequest(server.port, { path: '/' });
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(server.token), 'served page must contain the injected token');
  assert.ok(!page.body.includes('__AUTH_TOKEN__'), 'placeholder must be fully replaced');
  assert.equal(page.headers['cache-control'], 'no-store', 'injected page must be no-store');

  for (const path of [
    '/assets/../../server/index.ts',
    '/assets/%2e%2e/%2e%2e/server/index.ts',
    '/..%2fserver%2findex.ts',
    '/%2e%2e/%2e%2e/server/auth.ts',
  ]) {
    const res = await rawRequest(server.port, { path });
    assert.ok(
      res.status === 403 || res.status === 404,
      `traversal ${path} must be blocked with 403/404, got ${res.status}`,
    );
    assert.ok(
      !res.body.includes('generateToken') && !res.body.includes('createRequestHandler'),
      `traversal ${path} must not leak server source`,
    );
  }
});

test('static: the mascot page is served with the token injected, exactly like index.html', async () => {
  // A SECOND page (web/mascot.html, a second vite entry) reaches the browser
  // through the same unhashed-entry branch as `/`. Since Nocturne C1 it polls
  // /api/sessions and /api/prefs, so it carries the token by the SAME
  // serve-time replacement as index.html, under the SAME headers: reachable
  // at all (a build that forgot the second rollup input would 404 here), the
  // placeholder fully replaced, no-store, and frame-protected.
  const page = await rawRequest(server.port, { path: '/mascot.html' });
  assert.equal(page.status, 200, 'web/dist/mascot.html must be served');
  assert.match(String(page.headers['content-type'] ?? ''), /^text\/html/);
  assert.ok(page.body.includes(`window.__AUTH__ = '${server.token}'`), 'the mascot page must carry the injected token');
  assert.ok(!page.body.includes('__AUTH_TOKEN__'), 'placeholder must be fully replaced');
  assert.equal(page.headers['cache-control'], 'no-store', 'the token-carrying mascot page must be no-store');
  assert.equal(page.headers['x-frame-options'], 'DENY', 'the token-carrying mascot page must refuse framing');
  assert.equal(page.headers['content-security-policy'], "frame-ancestors 'none'");
  // Byte-for-byte the index.html treatment: the same headers on both pages.
  const index = await rawRequest(server.port, { path: '/' });
  for (const h of ['cache-control', 'x-frame-options', 'content-security-policy', 'content-type']) {
    assert.equal(page.headers[h], index.headers[h], `${h} must match index.html's`);
  }
});

test('static: the token-carrying mascot page sits behind the SAME Host and Origin checks as /api', async () => {
  // Nocturne C1: /mascot.html now holds the token, so a DNS-rebinding page
  // (foreign Host) or a cross-origin fetch must get a 403 and never the body —
  // the checks at the top of the handler are what keep it off the wire.
  const refused: Record<string, string>[] = [
    { host: `evil.example.com:${server.port}` },
    { host: '127.0.0.1' },
    { origin: 'http://evil.example.com' },
    { origin: `https://127.0.0.1:${server.port}` },
  ];
  for (const headers of refused) {
    const res = await rawRequest(server.port, { path: '/mascot.html', headers });
    assert.equal(res.status, 403, `${JSON.stringify(headers)} must be 403 on /mascot.html`);
    assert.ok(!res.body.includes(server.token), `${JSON.stringify(headers)} must not receive the token`);
  }
  const ok = await rawRequest(server.port, {
    path: '/mascot.html',
    headers: { origin: `http://127.0.0.1:${server.port}` },
  });
  assert.equal(ok.status, 200, 'the loopback origin itself is let in');
});

test('static: both unhashed entry documents are no-store (a cached one points at a deleted asset)', async () => {
  // index.html and mascot.html are the only two documents served under a name
  // that does not change between builds, and each names a HASHED bundle. If a
  // browser (or WebView2) heuristically caches one, the next restart deletes
  // the asset it names and the page renders blank with no error anywhere.
  for (const path of ['/', '/mascot.html']) {
    const res = await rawRequest(server.port, { path });
    assert.equal(res.status, 200, `${path} must be served`);
    assert.equal(res.headers['cache-control'], 'no-store', `${path} must be no-store`);
  }
});
