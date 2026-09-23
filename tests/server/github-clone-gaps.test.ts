/**
 * GitHub Phase 2c gap-closure (test-engineer): the token-safety corners the
 * first 2c tests did not assert — the askpass script's own content and
 * cleanup, the .git/config leak guard (both directions), the git-failure
 * cleanup, the never-spawn refusal guards, the two url rejections (control
 * char, over-length), and createRepo's description-omission,
 * 401-invalidation and clean-502 branches.
 *
 * How: `GithubConnection` in-process on a temp dir; every case drives the
 * fetch/spawn SEAMS — NO real network, NO real clone.
 *
 * NOT claimed here: the main createRepo / cloneAuthenticated contract —
 * `github-clone.test.ts`.
 *
 * Split out of `tests/server/github.test.ts` by topic (PLAN-RESTRUCTURE O6);
 * the shared doubles are `tests/helpers/github-fixture.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpath, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GithubConnection,
  GithubError,
  type FetchLike,
  type SpawnLike,
} from '../../server/github.ts';
import {
  makeTempDir,
  removeTempDir,
} from '../helpers/helpers.ts';
import {
  noop,
  SECRET,
  jsonResponse,
  connectedConn,
  fakeChild,
} from '../helpers/github-fixture.ts';

// ---------------------------------------------------------------------------
// 3b. Phase 2c gap-closure (test-engineer): extends the dev's 2c tests with
//     the token-safety corners they did not assert — the askpass script's own
//     content/cleanup, the .git/config leak guard (both directions), the git-
//     failure cleanup, the never-spawn refusal guards, the two url rejections
//     the dev list omitted (control char, over-length), and createRepo's
//     description-omission / 401-invalidation / clean-502 branches. Every case
//     drives the fetch/spawn SEAMS — NO real network, NO real clone.
// ---------------------------------------------------------------------------

test('cloneAuthenticated: #buildAuthenticatedGithubUrl also rejects a control char and an over-length url (400, before any spawn)', async () => {
  const root = await makeTempDir('ai-sm-gh-urlextra-');
  const work = await realpath(await makeTempDir('ai-sm-gh-urlextraw-'));
  try {
    let spawned = false;
    const conn = new GithubConnection({
      file: join(root, 'github.json'),
      log: noop,
      clientId: 'Iv1.x',
      spawnImpl: () => fakeChild(0, () => { spawned = true; }),
    });
    const dest = join(work, 'dest');
    const controlChar = 'https://github.com/o/r.git'; // 0x01 fails the char scan
    const overLong = 'https://github.com/' + 'a'.repeat(2100) + '.git'; // > MAX_CLONE_URL_LEN(2048)
    for (const url of [controlChar, overLong]) {
      await assert.rejects(
        conn.cloneAuthenticated(url, dest),
        (e) => e instanceof GithubError && e.status === 400,
        `url ${JSON.stringify(url.slice(0, 40))} must be rejected 400`,
      );
    }
    assert.equal(spawned, false, 'a url rejected by validation never reaches git');
  } finally {
    await removeTempDir(root);
    await removeTempDir(work);
  }
});

test('cloneAuthenticated: the throwaway askpass script prints the token from env, NEVER embeds it, is mode 0700, and is deleted afterward', async () => {
  const root = await makeTempDir('ai-sm-gh-askpass-');
  const work = await realpath(await makeTempDir('ai-sm-gh-askpassw-'));
  try {
    let askPath: string | undefined;
    let askBody: string | undefined;
    let askMode: number | undefined;
    const spawnStub: SpawnLike = (_cmd, _args, opts) => {
      askPath = opts.env?.['GIT_ASKPASS'] as string | undefined;
      if (askPath !== undefined) {
        askBody = readFileSync(askPath, 'utf8'); // the script exists at spawn time
        askMode = statSync(askPath).mode & 0o777;
      }
      return fakeChild(0);
    };
    const conn = await connectedConn(root, {
      fetchImpl: () => Promise.reject(new Error('no network in this test')),
      spawnImpl: spawnStub,
    });
    const dest = join(work, 'cloned');
    await conn.cloneAuthenticated('https://github.com/octocat/hello.git', dest);

    // The script reads the token from the env var — it does NOT contain the token.
    assert.equal(askBody, '#!/bin/sh\nprintf \'%s\' "$AI_SM_GH_TOKEN"\n', 'askpass reads AI_SM_GH_TOKEN from env');
    assert.ok(askBody !== undefined && !askBody.includes(SECRET), 'the askpass script NEVER embeds the token');
    assert.equal(askMode, 0o700, 'the askpass script is mode 0700 (owner-only)');
    assert.ok(askPath !== undefined && !existsSync(askPath), 'the throwaway askpass script is deleted after the clone');
  } finally {
    await removeTempDir(root);
    await removeTempDir(work);
  }
});

test('cloneAuthenticated: a .git/config that leaked the token aborts 500 (clean message) and removes the freshly-created dest', async () => {
  const root = await makeTempDir('ai-sm-gh-leak-');
  const work = await realpath(await makeTempDir('ai-sm-gh-leakw-'));
  try {
    const dest = join(work, 'cloned');
    const spawnStub: SpawnLike = () =>
      fakeChild(0, () => {
        // Simulate a clone whose config accidentally embedded the token on disk.
        mkdirSync(join(dest, '.git'), { recursive: true });
        writeFileSync(
          join(dest, '.git', 'config'),
          `[remote "origin"]\n  url = https://x-access-token:${SECRET}@github.com/o/r.git\n`,
        );
      });
    const conn = await connectedConn(root, {
      fetchImpl: () => Promise.reject(new Error('no network')),
      spawnImpl: spawnStub,
    });
    await assert.rejects(
      conn.cloneAuthenticated('https://github.com/octocat/hello.git', dest),
      (e) => e instanceof GithubError && e.status === 500 && !e.message.includes(SECRET),
      'a token in .git/config aborts 500 with a message that never echoes the token',
    );
    assert.ok(!existsSync(dest), 'the poisoned clone is removed — no token is left on disk');
  } finally {
    await removeTempDir(root);
    await removeTempDir(work);
  }
});

test('cloneAuthenticated: a clean .git/config (no token) is accepted and the clone is kept (leak guard does not false-positive)', async () => {
  const root = await makeTempDir('ai-sm-gh-clean-');
  const work = await realpath(await makeTempDir('ai-sm-gh-cleanw-'));
  try {
    const dest = join(work, 'cloned');
    const spawnStub: SpawnLike = () =>
      fakeChild(0, () => {
        mkdirSync(join(dest, '.git'), { recursive: true });
        writeFileSync(
          join(dest, '.git', 'config'),
          `[remote "origin"]\n  url = https://x-access-token@github.com/o/r.git\n`,
        );
      });
    const conn = await connectedConn(root, {
      fetchImpl: () => Promise.reject(new Error('no network')),
      spawnImpl: spawnStub,
    });
    await conn.cloneAuthenticated('https://github.com/octocat/hello.git', dest);
    assert.ok(existsSync(join(dest, '.git', 'config')), 'a clean clone is kept');
  } finally {
    await removeTempDir(root);
    await removeTempDir(work);
  }
});

test('cloneAuthenticated: a non-zero git exit -> 502 and the partial dest WE created is removed', async () => {
  const root = await makeTempDir('ai-sm-gh-fail-');
  const work = await realpath(await makeTempDir('ai-sm-gh-failw-'));
  try {
    const dest = join(work, 'cloned');
    const spawnStub: SpawnLike = () =>
      fakeChild(1, () => {
        mkdirSync(dest, { recursive: true }); // git makes the leaf dir before failing
      });
    const conn = await connectedConn(root, {
      fetchImpl: () => Promise.reject(new Error('no network')),
      spawnImpl: spawnStub,
    });
    await assert.rejects(
      conn.cloneAuthenticated('https://github.com/octocat/hello.git', dest),
      (e) => e instanceof GithubError && e.status === 502,
      'git exit != 0 -> 502',
    );
    assert.ok(!existsSync(dest), 'a dest WE created is removed on clone failure (no partial left behind)');
  } finally {
    await removeTempDir(root);
    await removeTempDir(work);
  }
});

test('cloneAuthenticated: never spawns git when it will refuse — not-connected (409) and a missing parent (400)', async () => {
  const root = await makeTempDir('ai-sm-gh-nospawn-');
  const work = await realpath(await makeTempDir('ai-sm-gh-nospawnw-'));
  try {
    let spawned = false;
    const spy: SpawnLike = () => fakeChild(0, () => { spawned = true; });

    // (1) valid url, but NOT connected -> 409 before any spawn (constructed while
    //     github.json is still absent).
    const disc = new GithubConnection({ file: join(root, 'github.json'), log: noop, clientId: 'Iv1.x', spawnImpl: spy });
    await assert.rejects(
      disc.cloneAuthenticated('https://github.com/octocat/hello.git', join(work, 'd1')),
      (e) => e instanceof GithubError && e.status === 409,
      'valid url + not connected -> 409',
    );

    // (2) connected, but the dest PARENT does not exist -> 400 before any spawn.
    const conn = await connectedConn(root, { fetchImpl: () => Promise.reject(new Error('no network')), spawnImpl: spy });
    await assert.rejects(
      conn.cloneAuthenticated('https://github.com/octocat/hello.git', join(work, 'missing-parent', 'child')),
      (e) => e instanceof GithubError && e.status === 400,
      'connected + missing parent -> 400',
    );

    assert.equal(spawned, false, 'git is never spawned on a refused clone');
  } finally {
    await removeTempDir(root);
    await removeTempDir(work);
  }
});

test('createRepo: omits `description` from the request body when not provided (body is exactly { name, private })', async () => {
  const root = await makeTempDir('ai-sm-gh-nodesc-');
  try {
    let sentBody: unknown;
    const stub: FetchLike = (url, init) => {
      if (url === 'https://api.github.com/user/repos' && (init?.method ?? 'GET') === 'POST') {
        sentBody = JSON.parse(String(init?.body));
        return Promise.resolve(
          jsonResponse(
            { full_name: 'octocat/np', name: 'np', owner: { login: 'octocat' }, private: false, clone_url: 'https://github.com/octocat/np.git' },
            201,
          ),
        );
      }
      return Promise.resolve(jsonResponse({ error: 'unexpected' }, 404));
    };
    const conn = await connectedConn(root, { fetchImpl: stub });
    await conn.createRepo({ name: 'np', private: false });
    assert.deepEqual(sentBody, { name: 'np', private: false }, 'no description sent when omitted');
    assert.ok(
      sentBody !== null && typeof sentBody === 'object' && !('description' in (sentBody as object)),
      'the description key is absent, not sent as undefined/null',
    );
  } finally {
    await removeTempDir(root);
  }
});

test('createRepo: a 401 from GitHub invalidates the token (-> disconnected, github.json deleted) and throws 409', async () => {
  const root = await makeTempDir('ai-sm-gh-create401-');
  const file = join(root, 'github.json');
  try {
    const stub: FetchLike = (url, init) =>
      url === 'https://api.github.com/user/repos' && (init?.method ?? 'GET') === 'POST'
        ? Promise.resolve(jsonResponse({ message: 'Bad credentials' }, 401))
        : Promise.resolve(jsonResponse({ error: 'unexpected' }, 404));
    const conn = await connectedConn(root, { fetchImpl: stub });
    assert.equal(conn.status().state, 'connected', 'stored token -> connected on boot');
    await assert.rejects(
      conn.createRepo({ name: 'x', private: false }),
      (e) => e instanceof GithubError && e.status === 409,
      '401 on create surfaces as 409 not-connected',
    );
    assert.deepEqual(conn.status(), { deviceFlowAvailable: true, state: 'disconnected' }, '401 invalidated the token');
    await assert.rejects(stat(file), 'github.json is removed after the 401 invalidation');
  } finally {
    await removeTempDir(root);
  }
});

test('createRepo: an unmappable 201 payload -> 502; a 5xx -> clean 502 (never the raw github body)', async () => {
  const rootA = await makeTempDir('ai-sm-gh-c502a-');
  const rootB = await makeTempDir('ai-sm-gh-c502b-');
  try {
    // (1) 201 but the payload cannot be mapped (no full_name / owner / clone_url).
    const unmappable = await connectedConn(rootA, {
      fetchImpl: (url, init) =>
        url === 'https://api.github.com/user/repos' && (init?.method ?? 'GET') === 'POST'
          ? Promise.resolve(jsonResponse({ id: 1, name: 'x' }, 201))
          : Promise.resolve(jsonResponse({ error: 'unexpected' }, 404)),
    });
    await assert.rejects(
      unmappable.createRepo({ name: 'x', private: false }),
      (e) => e instanceof GithubError && e.status === 502,
      'an unmappable 201 payload -> 502',
    );

    // (2) a 5xx from GitHub -> a clean 502 that never echoes the raw body.
    const errored = await connectedConn(rootB, {
      fetchImpl: (url, init) =>
        url === 'https://api.github.com/user/repos' && (init?.method ?? 'GET') === 'POST'
          ? Promise.resolve(jsonResponse({ message: 'boom-internal' }, 500))
          : Promise.resolve(jsonResponse({ error: 'unexpected' }, 404)),
    });
    await assert.rejects(
      errored.createRepo({ name: 'x', private: false }),
      (e) => e instanceof GithubError && e.status === 502 && !e.message.includes('boom-internal'),
      'a 5xx -> clean 502, never the raw github body',
    );
  } finally {
    await removeTempDir(rootA);
    await removeTempDir(rootB);
  }
});
