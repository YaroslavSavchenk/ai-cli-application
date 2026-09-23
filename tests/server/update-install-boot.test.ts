/**
 * Phase E, part 2 — the update routes and the boot seams on a REAL backend
 * (a developer clone: no bundle marker): POST /api/update and GET
 * /api/update/status (422, the token gate, the method gates), the update
 * timing seams floored and capped, and `<dataDir>/updates` wiped at boot.
 *
 * How: a real server child per test (`startTestServer`), each with its own
 * env; the boot log is read from its server.log.
 *
 * Why: a timing seam that reaches 0 is a tight loop at api.github.com, and a
 * file left in `updates/` by a previous run is something runnable.
 *
 * NOT claimed here: an installed backend — `update-install-e2e.test.ts`.
 *
 * Split out of `tests/server/update-install.test.ts` by topic
 * (PLAN-RESTRUCTURE O6); the asset server and the controller harness are
 * `tests/helpers/update-install-fixture.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  UPDATE_NOT_INSTALLED,
} from '../../server/update-install.ts';
import {
  api,
  startTestServer,
  waitUntil,
  makeTempDir,
  removeTempDir,
} from '../helpers/helpers.ts';
import {
  VERSION,
  SETUP_NAME,
} from '../helpers/update-install-fixture.ts';

// ---------------------------------------------------------------------------
// The routes, against a REAL backend (a developer clone: no bundle marker)
// ---------------------------------------------------------------------------

test('POST /api/update on a developer clone: 422, authed, no body read, and the status route works', async () => {
  const server = await startTestServer();
  try {
    const status = await api(server, 'GET', '/api/update/status');
    assert.equal(status.status, 200);
    assert.deepEqual(status.body, { state: 'idle', version: null, percent: 0, error: null });

    const post = await api(server, 'POST', '/api/update');
    assert.equal(post.status, 422, JSON.stringify(post.body));
    assert.deepEqual(post.body, { error: UPDATE_NOT_INSTALLED });

    // Method gates.
    assert.equal((await api(server, 'GET', '/api/update')).status, 405);
    assert.equal((await api(server, 'POST', '/api/update/status')).status, 405);

    // Unauthenticated: both routes are behind the same token gate as the rest.
    for (const path of ['/api/update', '/api/update/status']) {
      const res = await fetch(`${server.baseUrl}${path}`, { method: 'POST' });
      assert.equal(res.status, 401, `${path} must require the token`);
    }
  } finally {
    await server.stop();
  }
});

test('boot: the update timing seams are floored at 1000 ms — never a tight loop at api.github.com', async () => {
  const server = await startTestServer({
    env: { AI_SM_UPDATE_FIRST_MS: '0', AI_SM_UPDATE_INTERVAL_MS: '5' },
  });
  try {
    const log = await waitUntil(
      async () => {
        const text = await readFile(join(server.dataDir, 'server.log'), 'utf8').catch(() => '');
        return text.includes('AI_SM_UPDATE_INTERVAL_MS') ? text : undefined;
      },
      'the boot warnings for the floored seams',
      10_000,
      50,
    );
    assert.ok(
      log.includes('[boot] AI_SM_UPDATE_FIRST_MS=0 is below the 1000ms floor; using 1000'),
      log,
    );
    assert.ok(
      log.includes('[boot] AI_SM_UPDATE_INTERVAL_MS=5 is below the 1000ms floor; using 1000'),
      log,
    );
  } finally {
    await server.stop();
  }
});

test('boot: the update timing seams are capped at the Node timer maximum — never an accidental 1 ms loop', async () => {
  // setTimeout treats anything above 2^31-1 ms as 1 ms, so an over-large value
  // would produce the exact flood the floor exists to prevent.
  const server = await startTestServer({
    env: {
      AI_SM_UPDATE_FIRST_MS: '999999999999',
      AI_SM_UPDATE_INTERVAL_MS: '2147483648',
    },
  });
  try {
    const log = await waitUntil(
      async () => {
        const text = await readFile(join(server.dataDir, 'server.log'), 'utf8').catch(() => '');
        return text.includes('AI_SM_UPDATE_INTERVAL_MS') ? text : undefined;
      },
      'the boot warnings for the capped seams',
      10_000,
      50,
    );
    assert.ok(
      log.includes(
        '[boot] AI_SM_UPDATE_FIRST_MS=999999999999 is above the 2147483647ms timer maximum; using 2147483647',
      ),
      log,
    );
    assert.ok(
      log.includes(
        '[boot] AI_SM_UPDATE_INTERVAL_MS=2147483648 is above the 2147483647ms timer maximum; using 2147483647',
      ),
      log,
    );
  } finally {
    await server.stop();
  }
});

test('boot: <dataDir>/updates is wiped, so nothing downloaded in a previous run can be executed', async () => {
  const root = await makeTempDir('ai-sm-update-boot-');
  const dataDir = join(root, 'data');
  try {
    // A leftover from a killed run: a verified-looking exe and a half download.
    mkdirSync(join(dataDir, 'updates', VERSION), { recursive: true });
    writeFileSync(join(dataDir, 'updates', VERSION, SETUP_NAME), 'stale');
    writeFileSync(join(dataDir, 'updates', VERSION, `${SETUP_NAME}.part`), 'half');
    const server = await startTestServer({ dataDir });
    try {
      assert.ok(!existsSync(join(dataDir, 'updates')), 'the updates directory is gone after boot');
      // And the rest of the data dir is untouched.
      assert.ok(existsSync(join(dataDir, 'runtime.json')));
    } finally {
      await server.stop();
    }
    await delay(50);
  } finally {
    await removeTempDir(root);
  }
});
