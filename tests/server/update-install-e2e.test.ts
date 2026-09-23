/**
 * Phase E, part 2 — an INSTALLED backend (an unpacked-bundle layout with a
 * `current` symlink): the presence grace against an install in flight (E2),
 * and end to end — it finds a newer release over HTTP, reports it through GET
 * /api/runtime, and one authed POST really downloads and verifies the Setup;
 * a restart is refused mid-download, a downgrade is re-judged, and a
 * 0.0.0-dev bundle makes zero outbound requests.
 *
 * How: a real server child started from the fixture bundle, a real loopback
 * release API and asset server (the seam collapses the allow-list to it). The
 * fixture ships no `launcher/run-update.ps1`, so the pipeline stops exactly at
 * the Windows launch — nothing is ever spawned, and that refusal is asserted.
 *
 * NOT claimed here: the Setup really running on Windows (the user's Windows
 * check), the controller's refusals one by one — `update-install.test.ts`.
 *
 * Split out of `tests/server/update-install.test.ts` by topic
 * (PLAN-RESTRUCTURE O6); the asset server and the controller harness are
 * `tests/helpers/update-install-fixture.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  UPDATE_ERROR_FINISH,
  UPDATE_ERROR_START,
  type UpdateInstallStatus,
} from '../../shared/protocol.ts';
import {
  UPDATE_IN_PROGRESS,
  UPDATE_NOTHING_TO_INSTALL,
} from '../../server/update-install.ts';
import { SUMS_ASSET_NAME, UPDATE_OWNER, UPDATE_REPO } from '../../server/update-release.ts';
import {
  api,
  presenceUrl,
  projectRoot,
  startTestServer,
  waitUntil,
  WsClient,
  makeTempDir,
  removeTempDir,
} from '../helpers/helpers.ts';
import {
  VERSION,
  SETUP_NAME,
  SETUP_BYTES,
  type AssetStub,
  startAssets,
  downloadPath,
  releaseFor,
  sumsBody,
  makeController,
  serveHappy,
  settled,
} from '../helpers/update-install-fixture.ts';

// ---------------------------------------------------------------------------
// END TO END: a real installed backend, a real release API, a real download
// ---------------------------------------------------------------------------
//
// The acceptance criterion of phase E, minus Windows: an INSTALLED backend
// finds a newer release over HTTP, reports it through GET /api/runtime, and one
// authed POST really downloads and verifies the Setup. The fixture ships no
// `launcher/run-update.ps1`, so the pipeline stops exactly at the Windows
// launch — nothing is ever spawned, and that refusal is asserted rather than
// avoided.

/** A minimal unpacked-bundle layout: <app>/<version> + a `current` symlink. */
function installedApp(root: string, version: string): { appRoot: string; entry: string } {
  const dir = join(root, version);
  mkdirSync(dir, { recursive: true });
  cpSync(join(projectRoot, 'server'), join(dir, 'server'), { recursive: true });
  cpSync(join(projectRoot, 'shared'), join(dir, 'shared'), { recursive: true });
  cpSync(join(projectRoot, 'package.json'), join(dir, 'package.json'));
  symlinkSync(join(projectRoot, 'node_modules'), join(dir, 'node_modules'));
  const dist = join(dir, 'web', 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><script src="/assets/index-Fixture0.js"></script>');
  writeFileSync(join(dist, 'assets', 'index-Fixture0.js'), 'console.log(1)\n');
  writeFileSync(join(dist, 'build-id.json'), JSON.stringify({ id: '20260909-0000-fixture' }));
  mkdirSync(join(dir, 'node', 'bin'), { recursive: true });
  symlinkSync(process.execPath, join(dir, 'node', 'bin', 'node'));
  writeFileSync(
    join(dir, 'bundle.json'),
    JSON.stringify({
      version,
      commit: '8c308cc',
      nodeVersion: 'v24.8.0',
      builtAt: '2026-09-09T10:00:00.000Z',
      platform: 'linux-x64',
      glibcMin: '2.35',
    }),
  );
  symlinkSync(dir, join(root, 'current'));
  return { appRoot: root, entry: join(root, 'current', 'server', 'index.ts') };
}

// ---------------------------------------------------------------------------
// The presence grace vs. an install in flight (E2)
// ---------------------------------------------------------------------------

test('LIFECYCLE: an install in flight defers the idle shutdown; the process still exits once it has settled', async () => {
  const stub = await startAssets();
  const root = realpathSync(await makeTempDir('ai-sm-update-idle-'));
  const app = installedApp(join(root, 'app'), 'v0.2.0');
  /** Set by the stalled asset handler; called to let the download finish. */
  let releaseDownload: (() => void) | undefined;
  try {
    serveLatestRelease(stub);
    // The sums file is honest; the exe HANGS until this test lets go, so the
    // pipeline is provably still running when the grace expires.
    stub.routes.set(downloadPath(SUMS_ASSET_NAME), (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(sumsBody());
    });
    stub.routes.set(downloadPath(SETUP_NAME), (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(SETUP_BYTES.byteLength),
      });
      releaseDownload = (): void => {
        res.end(SETUP_BYTES);
      };
    });

    const server = await startTestServer({
      entry: app.entry,
      cwd: join(app.appRoot, 'current'),
      env: {
        AI_SM_UPDATE_API_BASE: stub.origin,
        AI_SM_UPDATE_FIRST_MS: '1000',
        AI_SM_UPDATE_INTERVAL_MS: '3600000',
        // Both graces are short: the deferral logic is time-scale free, and
        // two real six-second waits used to be the slowest thing in the suite.
        // A presence socket (below) covers the setup, so the 1.5 s windows only
        // ever start once the download is provably in flight.
        AI_SM_STARTUP_GRACE_MS: '1500',
        AI_SM_GRACE_MS: '1500',
      },
    });
    const logFile = join(server.dataDir, 'server.log');
    const readLog = async (): Promise<string> => readFile(logFile, 'utf8').catch(() => '');
    // One open window while the release is found and the update is started:
    // without it the 1.5 s STARTUP grace could expire before the POST, which
    // would test the wrong thing. Closing it below arms the regular grace.
    const presence = await WsClient.connect(presenceUrl(server));
    try {
      await waitUntil(
        async () => {
          const res = await api(server, 'GET', '/api/runtime');
          const body = res.body as { update: Record<string, unknown> };
          return body.update['available'] === true ? true : undefined;
        },
        'GET /api/runtime to carry the release',
        15_000,
        100,
      );
      assert.equal((await api(server, 'POST', '/api/update')).status, 202);
      await waitUntil(
        async () => {
          const body = (await api(server, 'GET', '/api/update/status')).body as UpdateInstallStatus;
          return body.state === 'downloading' ? true : undefined;
        },
        'the download to be in flight',
        10_000,
        50,
      );

      // The last window closes: from here the 1.5 s grace runs.
      await presence.close();

      // The grace expires WHILE the download hangs: one line, and no exit.
      const log = await waitUntil(
        async () => {
          const text = await readLog();
          return text.includes('[lifecycle] idle grace expired while an update is installing')
            ? text
            : undefined;
        },
        'the deferral line in server.log',
        20_000,
        100,
      );
      assert.ok(
        log.includes('[lifecycle] idle grace expired while an update is installing — deferring'),
        'the deferral names the reason exactly once, in the lifecycle component',
      );
      assert.equal(server.child.exitCode, null, 'the backend is still running');
      assert.equal((await fetch(`${server.baseUrl}/health`)).status, 200, 'and still serving');

      // Let it finish: the fixture ships no launcher/run-update.ps1, so the
      // install settles as a failure — settled is settled either way.
      releaseDownload?.();
      const status = await waitUntil(
        async () => {
          const body = (await api(server, 'GET', '/api/update/status')).body as UpdateInstallStatus;
          return body.state === 'failed' || body.state === 'installed' ? body : undefined;
        },
        'the install to settle',
        20_000,
        50,
      );
      assert.equal(status.state, 'failed');
      assert.equal(status.error, UPDATE_ERROR_START);

      // Nothing holds the backend any more: the next expiry really ends it.
      const exit = await Promise.race([
        server.exit,
        delay(20_000).then(() => undefined),
      ]);
      assert.deepEqual(exit, { code: 0, signal: null }, 'the deferred shutdown happens after all');
      assert.ok(!existsSync(server.runtimeFile), 'and it is the clean shutdown, runtime.json removed');
    } finally {
      releaseDownload?.();
      if (!presence.closed) await presence.close().catch(() => undefined);
      await server.stop();
    }
  } finally {
    await removeTempDir(root);
    await stub.close();
  }
});

test('LIFECYCLE: a HELD flight (a Setup that outran its timeout) never defers the idle shutdown', async () => {
  // E6 keeps the single flight while a timed-out Setup is still out there, so a
  // second press cannot start a SECOND installer. That hold must not also hold
  // the process: the child is detached and may never exit, and `inProgress`
  // would then defer the idle shutdown for ever (one log line every grace).
  const stub = await startAssets();
  const fx = await makeController(stub, {
    // A launcher that never returns — exactly the hung Setup this guards.
    launchExit: () => new Promise<number>(() => undefined),
    setupTimeoutMs: 50,
  });
  try {
    serveHappy(stub);
    await fx.controller.request();
    const status = await settled(fx.controller);
    assert.equal(status.state, 'failed');
    assert.equal(status.error, UPDATE_ERROR_FINISH, 'the wait was given up on');

    assert.equal(fx.controller.inProgress, true, 'the flight is HELD: a second press is still refused');
    assert.deepEqual(await fx.controller.request(), {
      status: 409,
      body: { error: UPDATE_IN_PROGRESS },
    });
    // The one thing that changed: nothing keeps the backend alive for it.
    assert.equal(fx.controller.holdsProcess, false, 'a held flight never defers the idle shutdown');
    assert.equal(fx.controller.holdingSince, 0);
  } finally {
    await fx.cleanup();
    await stub.close();
  }
});

test('LIFECYCLE: holdsProcess is true for exactly the working states, false once it settles', async () => {
  const stub = await startAssets();
  const fx = await makeController(stub);
  try {
    serveHappy(stub);
    assert.equal(fx.controller.holdsProcess, false, 'idle holds nothing');
    assert.equal(fx.controller.holdingSince, 0);
    await fx.controller.request();
    assert.equal(fx.controller.holdsProcess, true, 'downloading holds the process');
    assert.ok(fx.controller.holdingSince > 0, 'and the deferral deadline has an anchor');
    const status = await settled(fx.controller);
    assert.equal(status.state, 'installed');
    assert.equal(fx.controller.holdsProcess, false, 'installed holds nothing');
    assert.equal(fx.controller.holdingSince, 0);
  } finally {
    await fx.cleanup();
    await stub.close();
  }
});

/**
 * The release API, on the same loopback origin as the assets (which is exactly
 * what the seam collapses the allow-list to).
 */
function serveLatestRelease(stub: AssetStub): void {
  stub.routes.set(`/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`, (_req, res) => {
    const url = (name: string): string =>
      `${stub.origin}/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/${VERSION}/${name}`;
    res.writeHead(200, { 'content-type': 'application/json', etag: '"e2e-1"' });
    res.end(
      JSON.stringify({
        tag_name: VERSION,
        draft: false,
        prerelease: false,
        assets: [
          {
            name: SETUP_NAME,
            state: 'uploaded',
            size: SETUP_BYTES.byteLength,
            browser_download_url: url(SETUP_NAME),
          },
          {
            name: SUMS_ASSET_NAME,
            state: 'uploaded',
            size: sumsBody().length,
            browser_download_url: url(SUMS_ASSET_NAME),
          },
        ],
      }),
    );
  });
}

test('END TO END: POST /api/restart is refused with 409 while an install is downloading', async () => {
  // A restart tears this process down and the replacement wipes
  // <dataDir>/updates at boot — so a handoff started mid-download would delete
  // the half-written .part with nothing left to report it.
  const stub = await startAssets();
  const root = realpathSync(await makeTempDir('ai-sm-update-restart-'));
  const app = installedApp(join(root, 'app'), 'v0.2.0');
  let releaseDownload: (() => void) | undefined;
  try {
    serveLatestRelease(stub);
    stub.routes.set(downloadPath(SUMS_ASSET_NAME), (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(sumsBody());
    });
    // The exe HANGS: the install is provably still in flight at the POST below.
    stub.routes.set(downloadPath(SETUP_NAME), (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(SETUP_BYTES.byteLength),
      });
      releaseDownload = (): void => {
        res.end(SETUP_BYTES);
      };
    });

    const server = await startTestServer({
      entry: app.entry,
      cwd: join(app.appRoot, 'current'),
      env: {
        AI_SM_UPDATE_API_BASE: stub.origin,
        AI_SM_UPDATE_FIRST_MS: '1000',
        AI_SM_UPDATE_INTERVAL_MS: '3600000',
      },
    });
    try {
      await waitUntil(
        async () => {
          const body = (await api(server, 'GET', '/api/runtime')).body as {
            update: Record<string, unknown>;
          };
          return body.update['available'] === true ? true : undefined;
        },
        'GET /api/runtime to carry the release',
        15_000,
        100,
      );
      assert.equal((await api(server, 'POST', '/api/update')).status, 202);
      const part = join(server.dataDir, 'updates', VERSION, `${SETUP_NAME}.part`);
      await waitUntil(
        async () => {
          const body = (await api(server, 'GET', '/api/update/status')).body as UpdateInstallStatus;
          return body.state === 'downloading' && existsSync(part) ? true : undefined;
        },
        'the download to be in flight with a .part on disk',
        10_000,
        50,
      );

      const pid = server.child.pid;
      const restart = await api(server, 'POST', '/api/restart');
      assert.equal(restart.status, 409, JSON.stringify(restart.body));
      assert.deepEqual(restart.body, { error: 'An update is being installed.' });

      // Nothing was torn down and nothing was thrown away.
      assert.equal(server.child.pid, pid, 'the same process is still serving');
      assert.equal(server.child.exitCode, null);
      assert.equal((await fetch(`${server.baseUrl}/health`)).status, 200);
      assert.ok(existsSync(part), 'the half-written download survived the refusal');
      const status = (await api(server, 'GET', '/api/update/status')).body as UpdateInstallStatus;
      assert.equal(status.state, 'downloading', 'and the install is still running');
    } finally {
      releaseDownload?.();
      await server.stop();
    }
  } finally {
    await removeTempDir(root);
    await stub.close();
  }
});

test('END TO END: an installed backend finds v0.3.0, reports it, and POST /api/update really downloads and verifies it', async () => {
  const stub = await startAssets();
  const root = realpathSync(await makeTempDir('ai-sm-update-e2e-'));
  const app = installedApp(join(root, 'app'), 'v0.2.0');
  try {
    serveLatestRelease(stub);
    serveHappy(stub);

    const server = await startTestServer({
      entry: app.entry,
      cwd: join(app.appRoot, 'current'),
      env: {
        AI_SM_UPDATE_API_BASE: stub.origin,
        // The production schedule is 20 s after listen; the seam only moves the
        // clock, never the behaviour.
        AI_SM_UPDATE_FIRST_MS: '1000',
        AI_SM_UPDATE_INTERVAL_MS: '3600000',
      },
    });
    try {
      const runtime = await waitUntil(
        async () => {
          const res = await api(server, 'GET', '/api/runtime');
          const body = res.body as { installed: boolean; update: Record<string, unknown> };
          return body.update['available'] === true ? body : undefined;
        },
        'GET /api/runtime to carry the release',
        15_000,
        100,
      );
      assert.equal(runtime.installed, true);
      assert.deepEqual(runtime.update, {
        available: true,
        reason: 'a new version is available',
        release: {
          version: VERSION,
          setupName: SETUP_NAME,
          setupUrl: `${stub.origin}${downloadPath(SETUP_NAME)}`,
          sumsUrl: `${stub.origin}${downloadPath(SUMS_ASSET_NAME)}`,
          size: SETUP_BYTES.byteLength,
        },
      });

      // One authed press.
      const post = await api(server, 'POST', '/api/update');
      assert.deepEqual(post.body, { version: VERSION });
      assert.equal(post.status, 202);

      const status = await waitUntil(
        async () => {
          const res = await api(server, 'GET', '/api/update/status');
          const body = res.body as UpdateInstallStatus;
          return body.state === 'failed' || body.state === 'installed' ? body : undefined;
        },
        'the install to settle',
        20_000,
        50,
      );
      // The fixture has no launcher/run-update.ps1 — so the download and the
      // verification are real, and the Windows step is the one that refuses.
      assert.deepEqual(status, {
        state: 'failed',
        version: VERSION,
        percent: 100,
        error: UPDATE_ERROR_START,
      });
      const exe = join(server.dataDir, 'updates', VERSION, SETUP_NAME);
      assert.deepEqual(await readFile(exe), SETUP_BYTES, 'the verified Setup is on disk, byte for byte');
      assert.ok(!existsSync(`${exe}.part`));
      // The ETag cache is there for the next boot, 0600.
      assert.equal((await stat(join(server.dataDir, 'update-check.json'))).mode & 0o777, 0o600);
    } finally {
      await server.stop();
    }
  } finally {
    await removeTempDir(root);
    await stub.close();
  }
});

test('END TO END: a DOWNGRADE re-judges the cached release — /api/runtime offers it after a 304', async () => {
  // The production bug of 2026-09-09: <dataDir>/update-check.json held the
  // VERDICT ("not newer than me"), while the ETag only validates the PAYLOAD.
  // After v0.3.1 -> v0.3.0 every six-hourly check answered 304, the verdict was
  // never recomputed, and the Update button never came back. Here the cache is
  // the one a NEWER run left behind and the OLDER backend must reach the offer
  // through a 304 alone — the API sends it no release at all.
  const stub = await startAssets();
  const root = realpathSync(await makeTempDir('ai-sm-update-downgrade-'));
  const app = installedApp(join(root, 'app'), 'v0.2.0');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  /** The status the release route really served, in order. */
  const served: number[] = [];
  try {
    writeFileSync(
      join(dataDir, 'update-check.json'),
      JSON.stringify({
        etag: '"e2e-1"',
        checkedAt: '2026-09-09T10:00:00.000Z',
        latest: releaseFor(stub),
      }),
      { mode: 0o600 },
    );
    // A 200 here would hand the answer over for free, so it is an ERROR: the
    // only way this test can pass is the adopted cache, re-judged at use time.
    stub.routes.set(`/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`, (req, res) => {
      if (req.headers['if-none-match'] === '"e2e-1"') {
        served.push(304);
        res.writeHead(304, { etag: '"e2e-1"' }).end();
        return;
      }
      served.push(200);
      res.writeHead(500).end('the cached ETag was not sent');
    });

    const server = await startTestServer({
      entry: app.entry,
      cwd: join(app.appRoot, 'current'),
      dataDir,
      env: {
        AI_SM_UPDATE_API_BASE: stub.origin,
        AI_SM_UPDATE_FIRST_MS: '1000',
        AI_SM_UPDATE_INTERVAL_MS: '3600000',
      },
    });
    try {
      await waitUntil(
        async () => (served.length > 0 ? true : undefined),
        'the scheduled release check to reach the stub',
        15_000,
        50,
      );
      assert.deepEqual(served, [304], 'conditional: the fix costs no rate-limit quota');

      // Asked AFTER the 304, so nothing here can come from a fresh payload.
      const body = (await api(server, 'GET', '/api/runtime')).body as {
        update: Record<string, unknown>;
      };
      assert.deepEqual(body.update, {
        available: true,
        reason: 'a new version is available',
        release: releaseFor(stub),
      });

      // And the descriptor is still on disk for the next boot, ETag intact.
      const cache = JSON.parse(readFileSync(join(dataDir, 'update-check.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      assert.deepEqual(cache['latest'], releaseFor(stub), 'a 304 keeps the descriptor');
      assert.equal(cache['etag'], '"e2e-1"');
      assert.equal(cache['release'], undefined, 'and never writes the old verdict key');
    } finally {
      await server.stop();
    }
  } finally {
    await removeTempDir(root);
    await stub.close();
  }
});

test('END TO END: a 0.0.0-dev bundle makes ZERO outbound requests — the promise this project makes about itself', async () => {
  // The acceptance criterion of phase E's check half: an off-tag build (what
  // scripts/build-bundle.sh stamps without a tag) is older than every release,
  // so asking would only nag a developer with an update it must never install.
  const stub = await startAssets();
  const root = realpathSync(await makeTempDir('ai-sm-update-dev-'));
  const app = installedApp(join(root, 'app'), '0.0.0-dev+abc1234');
  try {
    // The release API and both assets are served — nothing must ask for them.
    serveLatestRelease(stub);
    serveHappy(stub);

    const server = await startTestServer({
      entry: app.entry,
      cwd: join(app.appRoot, 'current'),
      env: {
        AI_SM_UPDATE_API_BASE: stub.origin,
        AI_SM_UPDATE_FIRST_MS: '1000',
        AI_SM_UPDATE_INTERVAL_MS: '1000',
      },
    });
    try {
      // The boot line says so, in the log, before anything could have run.
      const log = await waitUntil(
        async () => {
          const text = await readFile(join(server.dataDir, 'server.log'), 'utf8').catch(() => '');
          return text.includes('online release check disabled') ? text : undefined;
        },
        'the disabled-check line in server.log',
        10_000,
        50,
      );
      assert.ok(
        log.includes(
          '[boot] online release check disabled for build 0.0.0-dev+abc1234 (not a released version)',
        ),
        log,
      );

      // Long past the first check AND several intervals: still not one request.
      await delay(2_500);
      assert.deepEqual(stub.hits, [], 'a 0.0.0 build never talks to the release API');

      const runtime = (await api(server, 'GET', '/api/runtime')).body as {
        installed: boolean;
        version: string;
        update: Record<string, unknown>;
      };
      assert.equal(runtime.installed, true, 'it IS the installed app — just not a released one');
      assert.equal(runtime.version, '0.0.0-dev+abc1234');
      assert.deepEqual(runtime.update, { available: false, reason: null });

      // And the button has nothing to install, so it can download nothing.
      const post = await api(server, 'POST', '/api/update');
      assert.equal(post.status, 422);
      assert.deepEqual(post.body, { error: UPDATE_NOTHING_TO_INSTALL });
      assert.deepEqual(stub.hits, [], 'not even a pressed button reaches the network');
    } finally {
      await server.stop();
    }
  } finally {
    await removeTempDir(root);
    await stub.close();
  }
});
