/**
 * GitHub Phase 2c — `createRepo` through the fetch seam and
 * `cloneAuthenticated` through the spawn seam: the request shape, the
 * cloneUrl validation that comes FIRST, the token going ONLY via GIT_ASKPASS
 * env (never argv, never the clone url), the no-clobber rule, and an
 * UN-NORMALIZED dest resolved once before every filesystem decision
 * (existedBefore, assertVacant, the owner-dir allowance, the git argv, the
 * failure cleanup, the .git/config leak guard).
 *
 * How: `GithubConnection` in-process on a temp dir, fetch and spawn replaced
 * by recording doubles — NO real network, NO real clone.
 *
 * NOT claimed here: a real authenticated clone (`github-clone-success.test.ts`
 * covers the success path), the gap-closure corners —
 * `github-clone-gaps.test.ts`.
 *
 * Split out of `tests/server/github.test.ts` by topic (PLAN-RESTRUCTURE O6);
 * the shared doubles are `tests/helpers/github-fixture.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
// 3. Phase 2c: createRepo (fetch seam) + cloneAuthenticated (spawn seam)
// ---------------------------------------------------------------------------

test('createRepo: POSTs /user/repos with Bearer header + JSON body; maps to GithubRepo; token never in the result', async () => {
  const root = await makeTempDir('ai-sm-gh-create-');
  try {
    let calledMethod: string | undefined;
    let authHeader: string | undefined;
    let sentBody: unknown;
    const stub: FetchLike = (url, init) => {
      if (url === 'https://api.github.com/user/repos' && (init?.method ?? 'GET') === 'POST') {
        calledMethod = init?.method;
        const h = (init?.headers ?? {}) as Record<string, string>;
        authHeader = h['Authorization'];
        sentBody = JSON.parse(String(init?.body));
        return Promise.resolve(
          jsonResponse(
            {
              id: 999,
              node_id: 'R_x',
              full_name: 'octocat/newrepo',
              name: 'newrepo',
              owner: { login: 'octocat', id: 1 },
              private: true,
              description: 'made in app',
              clone_url: 'https://github.com/octocat/newrepo.git',
              ssh_url: 'git@github.com:octocat/newrepo.git',
            },
            201,
          ),
        );
      }
      return Promise.resolve(jsonResponse({ error: 'unexpected' }, 404));
    };
    const conn = await connectedConn(root, { fetchImpl: stub });
    const repo = await conn.createRepo({ name: 'newrepo', private: true, description: 'made in app' });
    assert.deepEqual(repo, {
      fullName: 'octocat/newrepo',
      name: 'newrepo',
      owner: 'octocat',
      private: true,
      description: 'made in app',
      cloneUrl: 'https://github.com/octocat/newrepo.git',
    });
    assert.equal(calledMethod, 'POST');
    assert.equal(authHeader, `Bearer ${SECRET}`, 'token is a Bearer header, server-side only');
    assert.deepEqual(sentBody, { name: 'newrepo', private: true, description: 'made in app' });
    assert.ok(!JSON.stringify(repo).includes(SECRET), 'the created repo shape never contains the token');
  } finally {
    await removeTempDir(root);
  }
});

test('createRepo: 422 from GitHub -> clean GithubError(422), no raw body / no token surfaced', async () => {
  const root = await makeTempDir('ai-sm-gh-create422-');
  try {
    const stub: FetchLike = (url, init) => {
      if (url === 'https://api.github.com/user/repos' && (init?.method ?? 'GET') === 'POST') {
        return Promise.resolve(
          jsonResponse({ message: 'Repository creation failed.', errors: [{ message: 'name already exists' }] }, 422),
        );
      }
      return Promise.resolve(jsonResponse({ error: 'unexpected' }, 404));
    };
    const conn = await connectedConn(root, { fetchImpl: stub });
    await assert.rejects(
      conn.createRepo({ name: 'taken', private: false }),
      (e) => e instanceof GithubError && e.status === 422 && !e.message.includes('already exists'),
      '422 surfaces a clean message, never the raw GitHub body',
    );
  } finally {
    await removeTempDir(root);
  }
});

test('createRepo: requires connected state (409 when disconnected)', async () => {
  const root = await makeTempDir('ai-sm-gh-create409-');
  try {
    const conn = new GithubConnection({ file: join(root, 'github.json'), log: noop, clientId: 'Iv1.x' });
    await assert.rejects(
      conn.createRepo({ name: 'x', private: false }),
      (e) => e instanceof GithubError && e.status === 409,
    );
  } finally {
    await removeTempDir(root);
  }
});

test('cloneAuthenticated: cloneUrl is validated FIRST — non-github host / non-https / -leading / creds / port -> 400', async () => {
  const root = await makeTempDir('ai-sm-gh-cloneval-');
  const work = await realpath(await makeTempDir('ai-sm-gh-clonework-'));
  try {
    // Not connected: cloneUrl is rejected BEFORE the connection/token is touched,
    // proving the token can never be aimed at a non-github host.
    const conn = new GithubConnection({ file: join(root, 'github.json'), log: noop, clientId: 'Iv1.x' });
    const dest = join(work, 'dest');
    const bad = [
      'https://evil.example.com/o/r.git',
      'https://github.com.evil.com/o/r.git',
      'http://github.com/o/r.git',
      'ssh://git@github.com/o/r.git',
      'git@github.com:o/r.git',
      'file:///etc/passwd',
      '-oProxyCommand=evil',
      'ext::sh -c whoami',
      'https://user:pass@github.com/o/r.git',
      'https://github.com:8443/o/r.git',
      'not a url',
    ];
    for (const url of bad) {
      await assert.rejects(
        conn.cloneAuthenticated(url, dest),
        (e) => e instanceof GithubError && e.status === 400,
        `cloneUrl ${JSON.stringify(url)} must be rejected 400`,
      );
    }
  } finally {
    await removeTempDir(root);
    await removeTempDir(work);
  }
});

test('cloneAuthenticated: a valid github url passes validation, then requires a connection (409 when disconnected)', async () => {
  const root = await makeTempDir('ai-sm-gh-clone409-');
  const work = await realpath(await makeTempDir('ai-sm-gh-clone409w-'));
  try {
    const conn = new GithubConnection({ file: join(root, 'github.json'), log: noop, clientId: 'Iv1.x' });
    await assert.rejects(
      conn.cloneAuthenticated('https://github.com/octocat/hello.git', join(work, 'd2')),
      (e) => e instanceof GithubError && e.status === 409,
      'valid url + not connected -> 409 (validation passed)',
    );
  } finally {
    await removeTempDir(root);
    await removeTempDir(work);
  }
});

test('cloneAuthenticated: the token goes ONLY via GIT_ASKPASS env — NEVER into argv or the clone url', async () => {
  const root = await makeTempDir('ai-sm-gh-cloneargv-');
  const work = await realpath(await makeTempDir('ai-sm-gh-cloneargvw-'));
  try {
    let capturedCmd: string | undefined;
    let capturedArgs: string[] | undefined;
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let capturedStdio: unknown;
    let capturedShell: unknown;
    const spawnStub: SpawnLike = (cmd, args, opts) => {
      capturedCmd = cmd;
      capturedArgs = args;
      capturedEnv = opts.env;
      capturedStdio = opts.stdio;
      capturedShell = opts.shell;
      const child = new EventEmitter();
      // Simulate a successful clone; no real .git/config is written (the leak
      // check reads it best-effort and ignores an absent file).
      setTimeout(() => child.emit('close', 0), 0);
      return child as unknown as ChildProcess;
    };
    const neverFetch: FetchLike = () => Promise.reject(new Error('no network in this test'));
    const conn = await connectedConn(root, { fetchImpl: neverFetch, spawnImpl: spawnStub });

    const dest = join(work, 'cloned');
    await conn.cloneAuthenticated('https://github.com/octocat/hello.git', dest);

    assert.equal(capturedCmd, 'git');
    const argv = capturedArgs ?? [];
    assert.ok(argv.includes('clone'), 'git clone');
    assert.ok(argv.includes('--'), '-- guard present');
    assert.ok(
      argv.includes('https://x-access-token@github.com/octocat/hello.git'),
      'url carries only the non-secret x-access-token username',
    );
    assert.ok(argv.includes(dest), 'dest is an argv element');
    // credential.helper cleared so no helper caches the token to disk.
    const credIdx = argv.indexOf('credential.helper=');
    assert.ok(credIdx > 0 && argv[credIdx - 1] === '-c', 'credential.helper is cleared via -c');

    // The crux: the token is NOWHERE in argv, and NOWHERE in the url.
    assert.ok(!JSON.stringify(argv).includes(SECRET), 'the token is NEVER in argv');
    const urlArg = argv.find((a) => a.startsWith('https://'));
    assert.ok(urlArg !== undefined && !urlArg.includes(SECRET), 'the token is NEVER in the clone url');

    // The token is supplied ONLY through the env, for GIT_ASKPASS to read.
    assert.equal(capturedEnv?.['AI_SM_GH_TOKEN'], SECRET, 'token supplied via AI_SM_GH_TOKEN env only');
    assert.ok(
      typeof capturedEnv?.['GIT_ASKPASS'] === 'string' && (capturedEnv['GIT_ASKPASS'] as string).length > 0,
      'GIT_ASKPASS script path wired into the env',
    );
    assert.equal(capturedEnv?.['GIT_TERMINAL_PROMPT'], '0', 'git prompts are disabled (fail fast, no hang)');
    assert.equal(capturedStdio, 'ignore', 'git output is never buffered/logged (could echo a credential)');
    assert.equal(capturedShell, false, 'no shell — argv only');
  } finally {
    await removeTempDir(root);
    await removeTempDir(work);
  }
});

test('cloneAuthenticated: reuses the no-clobber rule — a non-empty dest -> 409 (never runs git)', async () => {
  const root = await makeTempDir('ai-sm-gh-clobber-');
  const work = await realpath(await makeTempDir('ai-sm-gh-clobberw-'));
  try {
    let spawned = false;
    const spawnStub: SpawnLike = () => {
      spawned = true;
      const child = new EventEmitter();
      setTimeout(() => child.emit('close', 0), 0);
      return child as unknown as ChildProcess;
    };
    const conn = await connectedConn(root, {
      fetchImpl: () => Promise.reject(new Error('no network')),
      spawnImpl: spawnStub,
    });
    const dest = join(work, 'nonempty');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dest);
    await writeFile(join(dest, 'keep.txt'), 'precious\n');
    await assert.rejects(
      conn.cloneAuthenticated('https://github.com/octocat/hello.git', dest),
      (e) => e instanceof GithubError && e.status === 409,
      'non-empty dest -> 409',
    );
    assert.equal(spawned, false, 'git is never spawned when the dest is non-empty');
    assert.equal(await readFile(join(dest, 'keep.txt'), 'utf8'), 'precious\n', 'existing file untouched');
  } finally {
    await removeTempDir(root);
    await removeTempDir(work);
  }
});

test('cloneAuthenticated: an UN-NORMALIZED dest is resolved before any filesystem decision — a `..` component can never make the failure cleanup delete a pre-existing tree', async () => {
  // REGRESSION (security). `dest = <victim>/<owner>/..` reads as a path whose
  // parent does not exist, but RESOLVES to the pre-existing <victim>. Before the
  // fix that split the two: statSync failed -> `existedBefore = false`, step 3b
  // created <victim>/<owner>, git got `<victim>/<owner>/..` (= a non-empty
  // <victim>) and failed, and the cleanup ran `rmSync(dest, {recursive:true})`
  // — which the kernel resolves through the `..`, emptying <victim>.
  // cloneAuthenticated now normalizes FIRST, so every decision (stat, mkdir,
  // git argv, cleanup) is about the same directory: the resolved one.
  const root = await makeTempDir('ai-sm-gh-dotdot-');
  const work = await realpath(await makeTempDir('ai-sm-gh-dotdotw-'));
  try {
    const victim = join(work, 'important');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(victim, 'sub'), { recursive: true });
    await writeFile(join(victim, 'precious.txt'), 'do not delete\n');
    await writeFile(join(victim, 'sub', 'more.txt'), 'also precious\n');

    let spawned = false;
    const conn = await connectedConn(root, {
      fetchImpl: () => Promise.reject(new Error('no network')),
      // Real git refuses a non-empty destination and exits non-zero — the exact
      // failure that used to trigger the destructive cleanup.
      spawnImpl: () => fakeChild(128, () => { spawned = true; }),
    });

    // Concatenated, not path.join()'d: join() would normalize the `..` away, and
    // the un-normalized string is exactly what a JSON body can carry.
    await assert.rejects(
      conn.cloneAuthenticated('https://github.com/acme/api.git', `${victim}/acme/..`),
      (e) => e instanceof GithubError,
      'an un-normalized dest is refused, not cloned into',
    );

    assert.equal(
      await readFile(join(victim, 'precious.txt'), 'utf8'),
      'do not delete\n',
      'the pre-existing directory this request never created is untouched',
    );
    assert.equal(await readFile(join(victim, 'sub', 'more.txt'), 'utf8'), 'also precious\n');
    assert.equal(existsSync(join(victim, 'acme')), false, 'no owner directory was materialised');
    assert.equal(spawned, false, 'the resolved dest is non-empty, so git is never spawned');
  } finally {
    await removeTempDir(root);
    await removeTempDir(work);
  }
});

// ---------------------------------------------------------------------------
// The normalization above is ONE resolve() feeding SIX filesystem decisions
// (existedBefore, assertVacant, the step-3b owner-dir allowance, the git argv,
// the failure cleanup, the .git/config leak guard). The test above only reaches
// the FIRST of them that refuses — assertVacant 409s and shadows everything
// downstream — so it cannot tell "resolved once, used everywhere" apart from
// "resolved once, then one consumer handed the raw string".
//
// These three drive an un-normalized dest that PASSES the vacancy check
// (`<landing>/acme/..`, where `<landing>` exists and is empty), so execution
// reaches each remaining consumer. The raw string and the resolved one differ
// for real here: the kernel walks `<landing>/acme` first and fails ENOENT
// because it does not exist, while path.resolve is purely lexical and lands on
// `<landing>`.
// ---------------------------------------------------------------------------

/** `<work>/landing` (existing + empty) and the un-normalized dest resolving to it. */
function landingPair(work: string): { landing: string; raw: string } {
  const landing = join(work, 'landing');
  mkdirSync(landing, { recursive: true });
  // Concatenated, not join()'d — join() would normalize the `..` away.
  return { landing, raw: `${landing}/acme/..` };
}

test('cloneAuthenticated: git and the owner-dir allowance both act on the RESOLVED dest — no directory is materialised for the raw string', async () => {
  const root = await makeTempDir('ai-sm-gh-res1-');
  const work = await realpath(await makeTempDir('ai-sm-gh-res1w-'));
  try {
    const { landing, raw } = landingPair(work);
    let gitDest: string | undefined;
    let ownerDirAtSpawn = true;
    const conn = await connectedConn(root, {
      fetchImpl: () => Promise.reject(new Error('no network')),
      spawnImpl: (_cmd, args) =>
        fakeChild(0, () => {
          gitDest = args[args.length - 1];
          // Step 3b runs BEFORE the spawn, so a raw-string parent would have
          // created `<landing>/acme` by now — and a failing clone would then
          // remove it again, which is why this is sampled here and not after.
          ownerDirAtSpawn = existsSync(join(landing, 'acme'));
        }),
    });

    await conn.cloneAuthenticated('https://github.com/acme/api.git', raw);

    assert.equal(gitDest, landing, 'git is handed the resolved dest, never the `..` string');
    assert.equal(ownerDirAtSpawn, false, 'the raw string names a missing `acme` parent — it must not be created');
    assert.equal(existsSync(join(landing, 'acme')), false, 'and nothing is left behind afterwards either');
    assert.ok(existsSync(landing), 'the destination itself is untouched');
  } finally {
    await removeTempDir(root);
    await removeTempDir(work);
  }
});

test('cloneAuthenticated: `existedBefore` is decided on the RESOLVED dest — a failed clone never removes a directory that already existed', async () => {
  // The consumer that decides whether the cleanup may delete anything at all.
  // Reading it from the raw string makes statSync fail (ENOENT on the missing
  // `acme` component) -> existedBefore=false -> the recursive rmSync then runs
  // on the RESOLVED, pre-existing directory.
  const root = await makeTempDir('ai-sm-gh-res2-');
  const work = await realpath(await makeTempDir('ai-sm-gh-res2w-'));
  try {
    const { landing, raw } = landingPair(work);
    const conn = await connectedConn(root, {
      fetchImpl: () => Promise.reject(new Error('no network')),
      spawnImpl: () => fakeChild(128),
    });

    await assert.rejects(
      conn.cloneAuthenticated('https://github.com/acme/api.git', raw),
      (e) => e instanceof GithubError && e.status === 502,
      'the clone still fails 502',
    );
    assert.ok(existsSync(landing), 'the pre-existing destination survives the failure cleanup');
    assert.equal(existsSync(join(landing, 'acme')), false, 'and no owner directory was created for the raw string');
  } finally {
    await removeTempDir(root);
    await removeTempDir(work);
  }
});

test('cloneAuthenticated: the credential-leak guard reads the RESOLVED .git/config — it cannot be silenced by an un-normalized dest', async () => {
  // End-to-end pin on the security-relevant consumer, and honest about its
  // strength: swapping `destAbs` for the raw string HERE is not observable,
  // because the read goes through `path.join`, which normalizes the `..` away
  // by itself. So this is defence in depth over that accident — it fails if the
  // leak guard is removed, reordered before the clone, or pointed at a path
  // that path.join does not normalize for it.
  const root = await makeTempDir('ai-sm-gh-res3-');
  const work = await realpath(await makeTempDir('ai-sm-gh-res3w-'));
  try {
    const { landing, raw } = landingPair(work);
    const conn = await connectedConn(root, {
      fetchImpl: () => Promise.reject(new Error('no network')),
      spawnImpl: () =>
        fakeChild(0, () => {
          mkdirSync(join(landing, '.git'), { recursive: true });
          writeFileSync(
            join(landing, '.git', 'config'),
            `[remote "origin"]\n  url = https://x-access-token:${SECRET}@github.com/o/r.git\n`,
          );
        }),
    });

    await assert.rejects(
      conn.cloneAuthenticated('https://github.com/acme/api.git', raw),
      (e) => e instanceof GithubError && e.status === 500 && !e.message.includes(SECRET),
      'the leak is still detected, and the message never echoes the token',
    );
  } finally {
    await removeTempDir(root);
    await removeTempDir(work);
  }
});
