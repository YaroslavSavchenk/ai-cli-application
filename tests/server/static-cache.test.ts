/**
 * Cache headers on static files (Quality P3b, `.claude/plans/PLAN-QUALITY.md`,
 * 2026-09-23): the content-hashed Vite output under `/assets/` is
 * `public, max-age=31536000, immutable`; the two token-carrying entry
 * documents stay `no-store`; any other static file and every 404 carries no
 * cache header; the frame-protection headers are on every one of them,
 * unchanged.
 *
 * How: a real server child (`startTestServer`) serving a FIXTURE dist through
 * the `AI_SM_WEB_DIST_DIR` seam — the file names are known, and the test does
 * not depend on the repo's `web/dist` having been built.
 *
 * Why it matters: P0 measured ~1.2 MB re-downloaded on every load. The other
 * direction is worse and silent: a cacheable `index.html` would keep naming
 * hashed bundles a restart or update has deleted — a blank page with no error
 * — and a cached 404 under `/assets/` would hide an asset a build adds later.
 *
 * NOT claimed here: what a real browser does with the headers (the warm-load
 * measurement is manual, recorded in the P3 landing); the injection and
 * Host/Origin gates on the entry documents (`tests/server/auth.test.ts`).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeTempDir,
  rawRequest,
  removeTempDir,
  startTestServer,
  type TestServer,
} from '../helpers/helpers.ts';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const FRAME = { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" };

let server: TestServer;
let dir: string;

before(async () => {
  dir = await makeTempDir('static-cache-');
  const dist = join(dir, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  const page = "<html><script>window.__AUTH__ = '__AUTH_TOKEN__'</script></html>";
  writeFileSync(join(dist, 'index.html'), page);
  writeFileSync(join(dist, 'mascot.html'), page);
  writeFileSync(join(dist, 'build-id.json'), '{"id":"fixture"}');
  writeFileSync(join(dist, 'assets', 'index-AbC123xy.js'), 'console.log(1);');
  writeFileSync(join(dist, 'assets', 'index-AbC123xy.css'), 'body{}');
  writeFileSync(join(dist, 'assets', 'inter-latin-var-Dx4kXJAl.woff2'), 'wOF2');
  server = await startTestServer({ env: { AI_SM_WEB_DIST_DIR: dist } });
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (dir !== undefined) await removeTempDir(dir);
});

function assertFrameProtected(headers: Record<string, unknown>, what: string): void {
  for (const [name, value] of Object.entries(FRAME)) {
    assert.equal(headers[name], value, `${what}: ${name} unchanged`);
  }
}

test('a hashed file under /assets/ is immutable for a year, and still frame-protected', async () => {
  for (const path of [
    '/assets/index-AbC123xy.js',
    '/assets/index-AbC123xy.css',
    '/assets/inter-latin-var-Dx4kXJAl.woff2',
  ]) {
    const res = await rawRequest(server.port, { path });
    assert.equal(res.status, 200, `${path} is served`);
    assert.equal(res.headers['cache-control'], IMMUTABLE, `${path} is cacheable`);
    assertFrameProtected(res.headers, path);
  }
});

test('the entry documents stay no-store: /, /index.html and /mascot.html', async () => {
  for (const path of ['/', '/index.html', '/mascot.html']) {
    const res = await rawRequest(server.port, { path });
    assert.equal(res.status, 200, `${path} is served`);
    assert.equal(res.headers['cache-control'], 'no-store', `${path} must never be cached`);
    assert.ok(res.body.includes(server.token), `${path} still carries the injected token`);
    assertFrameProtected(res.headers, path);
  }
});

test('a static file outside /assets/ keeps no cache header', async () => {
  const res = await rawRequest(server.port, { path: '/build-id.json' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], undefined, 'not content-hashed, so not cacheable');
  assertFrameProtected(res.headers, '/build-id.json');
});

test('a path that only LOOKS like /assets/ is judged by where it resolves', async () => {
  // `%2F` survives URL parsing and is decoded afterwards: this resolves to
  // dist/build-id.json, outside assets/.
  const res = await rawRequest(server.port, { path: '/assets/..%2Fbuild-id.json' });
  assert.equal(res.status, 200, 'it is served (it is inside dist)');
  assert.equal(res.headers['cache-control'], undefined, 'but not as an immutable asset');
});

test('a 404 under /assets/ is not cached', async () => {
  const res = await rawRequest(server.port, { path: '/assets/index-Missing0.js' });
  assert.equal(res.status, 404);
  assert.equal(res.headers['cache-control'], undefined, 'a miss must not outlive the next build');
  const dirHit = await rawRequest(server.port, { path: '/assets/' });
  assert.equal(dirHit.status, 404, 'the folder itself is not a file');
  assert.equal(dirHit.headers['cache-control'], undefined);
});
