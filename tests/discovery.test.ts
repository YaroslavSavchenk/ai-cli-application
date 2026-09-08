/**
 * Discovery file (runtime.json) lifecycle + data dir + loopback-only bind.
 *
 * Contract: data dir created 0700 (AI_SM_DATA_DIR override); runtime.json
 * written atomically with mode 0600 containing
 * {port, token, pid, startedAt, appDir};
 * removed on clean SIGTERM; server binds 127.0.0.1 only; /health returns
 * exactly {"ok":true}; logging goes to server.log, never stdout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { api, projectRoot, rawRequest, startTestServer, waitUntil } from './helpers.ts';

test('startup: runtime.json 0600 with correct shape, data dir 0700, health, server.log', async () => {
  const server = await startTestServer();
  try {
    const rtStat = await stat(server.runtimeFile);
    assert.equal(rtStat.mode & 0o777, 0o600, 'runtime.json must be mode 0600');

    const dirStat = await stat(server.dataDir);
    assert.ok(dirStat.isDirectory(), 'AI_SM_DATA_DIR must be created by the server');
    assert.equal(dirStat.mode & 0o777, 0o700, 'data dir must be mode 0700');

    const rt = server.runtime;
    assert.ok(Number.isInteger(rt.port) && rt.port > 0, `port must be a positive integer, got ${rt.port}`);
    assert.match(rt.token, /^[0-9a-f]{64,}$/, 'token must be hex with >= 32 bytes of entropy');
    assert.equal(rt.pid, server.child.pid, 'runtime.json pid must be the server process pid');
    assert.equal(new Date(rt.startedAt).toISOString(), rt.startedAt, 'startedAt must be ISO-8601');
    // The launcher parses this file, so its key SET is contract, not detail.
    // `appDir` was added 2026-09-08 for installed mode: the directory the
    // process actually runs from, REALPATH'ed — an installer must not prune the
    // version dir a live pid is in, and a symlinked path would not match the one
    // it is about to remove. On a developer clone it is the repo root.
    assert.deepEqual(
      Object.keys(rt as unknown as Record<string, unknown>).sort(),
      ['appDir', 'pid', 'port', 'startedAt', 'token'],
      'runtime.json holds exactly these five keys',
    );
    assert.equal(rt.appDir, realpathSync(projectRoot), 'appDir is the resolved directory of the running code');
    assert.equal(rt.appDir, realpathSync(rt.appDir as string), 'and it is already a real path');

    const res = await fetch(`${server.baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"ok":true}', '/health body must be exactly {"ok":true}');

    // Logging goes to server.log in the data dir.
    const logFile = join(server.dataDir, 'server.log');
    await waitUntil(
      async () => {
        try {
          const content = await readFile(logFile, 'utf8');
          return content.includes('listening') ? true : undefined;
        } catch {
          return undefined;
        }
      },
      'server.log to contain the "listening" line',
      5_000,
    );

    // Loopback-only bind: the port must NOT be reachable via any external interface.
    const externalIps = Object.values(networkInterfaces())
      .flatMap((infos) => infos ?? [])
      .filter((info) => info.family === 'IPv4' && !info.internal)
      .map((info) => info.address);
    for (const ip of externalIps) {
      await assert.rejects(
        fetch(`http://${ip}:${server.port}/health`, { signal: AbortSignal.timeout(2_000) }),
        `server must not be reachable on ${ip}:${server.port} — it must bind 127.0.0.1 only`,
      );
    }
    // IPv6 loopback must not be bound either (contract: 127.0.0.1 ONLY — this
    // is why the launcher must open 127.0.0.1, never a ::1-resolving localhost).
    await assert.rejects(
      fetch(`http://[::1]:${server.port}/health`, { signal: AbortSignal.timeout(2_000) }),
      'server must not listen on ::1',
    );
  } finally {
    await server.stop();
  }
});

test('GET /api/runtime: token-gated, body is exactly the startedAt from runtime.json — never port/token/pid', async () => {
  const server = await startTestServer();
  try {
    const noToken = await rawRequest(server.port, { path: '/api/runtime' });
    assert.equal(noToken.status, 401, 'GET /api/runtime without token must be 401');

    const res = await api(server, 'GET', '/api/runtime');
    assert.equal(res.status, 200);
    // Since 2026-09-06 the response also carries BUILD IDENTITY — the short git
    // hash of the running server code and the hashed frontend bundle being
    // served — so a stale backend is identifiable from the UI. Both are public
    // build metadata; the secret trio (port/token/pid) still never appears.
    const body = res.body as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(body).sort(),
      ['installed', 'serverCommit', 'startedAt', 'update', 'version', 'webBuild'],
      'exactly startedAt + the build identity + the live update check, and NO other keys',
    );
    // The order as the body is CONSTRUCTED (server/api.ts). Not semantic — a
    // JSON object is unordered — but pinned deliberately: it makes any edit to
    // this response show up as a change to this list, which is the one place the
    // wire shape is reviewed. Reordering the object literal is fine; say so here.
    assert.deepEqual(Object.keys(body), [
      'startedAt',
      'serverCommit',
      'version',
      'installed',
      'webBuild',
      'update',
    ]);
    // Added 2026-09-08 with installed mode: which BUNDLE this backend runs from
    // (null on a developer clone, where serverCommit is the identity instead),
    // and whether it is an install at all. Public build metadata, like the two
    // fields above it.
    assert.equal(body['installed'], false, 'this suite runs a developer clone');
    assert.equal(body['version'], null, 'and a clone has no bundle version');
    // Added 2026-09-06 with the restart button: a LIVE check (cached ~5 s), so
    // the UI can offer the restart instead of leaving the user on stale code.
    const update = body['update'] as Record<string, unknown>;
    assert.deepEqual(Object.keys(update).sort(), ['available', 'reason']);
    assert.equal(typeof update['available'], 'boolean');
    assert.ok(
      update['reason'] === null || typeof update['reason'] === 'string',
      `update.reason must be a short string or null, got ${JSON.stringify(update['reason'])}`,
    );
    assert.equal(body['startedAt'], server.runtime.startedAt, 'the exact runtime.json value');
    assert.ok(
      body['serverCommit'] === null || /^[0-9a-f]{7}$/.test(body['serverCommit'] as string),
      `serverCommit must be a short hash or null, got ${JSON.stringify(body['serverCommit'])}`,
    );
    assert.ok(
      body['webBuild'] === null || /^assets\/index-.*\.js$/.test(body['webBuild'] as string),
      `webBuild must be a hashed bundle name or null, got ${JSON.stringify(body['webBuild'])}`,
    );
    for (const forbidden of ['port', 'token', 'pid']) {
      assert.ok(!(forbidden in body), `${forbidden} must never reach the browser-facing API`);
    }

    const post = await api(server, 'POST', '/api/runtime');
    assert.equal(post.status, 405, 'non-GET on /api/runtime must be 405');
  } finally {
    await server.stop();
  }
});

test('SIGTERM: removes runtime.json and exits with code 0', async () => {
  const server = await startTestServer();
  try {
    assert.ok(existsSync(server.runtimeFile), 'runtime.json must exist while running');

    server.child.kill('SIGTERM');
    const exit = await Promise.race([server.exit, delay(10_000).then(() => undefined)]);
    assert.ok(exit !== undefined, 'server did not exit within 10s of SIGTERM');
    assert.equal(exit.code, 0, `clean shutdown must exit 0 (got code=${exit.code} signal=${exit.signal})`);
    assert.equal(exit.signal, null);

    assert.ok(!existsSync(server.runtimeFile), 'runtime.json must be removed on SIGTERM');

    const log = await readFile(join(server.dataDir, 'server.log'), 'utf8');
    assert.ok(log.includes('SIGTERM'), 'server.log must record the SIGTERM shutdown');
  } finally {
    await server.stop();
  }
});
