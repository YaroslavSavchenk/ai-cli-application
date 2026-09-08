/**
 * `server/buildinfo.ts` — the build identity in the boot banner and in
 * GET /api/runtime ("which code is this backend actually running?").
 *
 * Motivating incident (2026-09-06): a freshly built UI talked to a backend
 * started before the history feature existed; nothing in server.log said so.
 * These fixtures pin every shape `.git/HEAD` really takes — detached (a raw
 * hash), a symbolic `ref:` resolved against a loose ref file, the same ref
 * found only in `packed-refs` — plus every failure mode, because ALL of them
 * must degrade to null and NONE of them may throw at boot or read a file
 * outside `.git`.
 *
 * Everything runs on temp fixtures: no real repository is touched, no `git`
 * binary is spawned (by design — this runs in a detached process that cannot
 * depend on a binary or on a repo lock).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readServerCommit,
  readWebBuild,
  readBuildId,
  mtimeOf,
  createUpdateChecker,
  dependenciesInStep,
  MAX_SCAN_ENTRIES,
  UPDATE_DEPENDENCIES_CHANGED,
  UPDATE_FRONTEND_BUILD_MISSING,
  UPDATE_FRONTEND_REBUILT,
  UPDATE_FRONTEND_SOURCE_CHANGED,
  UPDATE_SERVER_FILES_EDITED,
} from '../server/buildinfo.ts';
import { projectRoot } from './helpers.ts';

const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHORT = 'a1b2c3d';

function fixture(): string {
  return mkdtempSync(join(tmpdir(), 'ai-sm-buildinfo-'));
}

/** Write `.git/<relative path>` under `root`, creating parent dirs. */
function gitFile(root: string, rel: string, contents: string): void {
  const path = join(root, '.git', rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
}

async function withFixture(fn: (root: string) => void | Promise<void>): Promise<void> {
  const root = fixture();
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// readServerCommit
// ---------------------------------------------------------------------------

test('readServerCommit: a DETACHED HEAD holds the hash itself', async () => {
  await withFixture((root) => {
    gitFile(root, 'HEAD', `${HASH}\n`);
    assert.equal(readServerCommit(root), SHORT);
  });
});

test('readServerCommit: a symbolic HEAD resolves against the LOOSE ref file', async () => {
  await withFixture((root) => {
    gitFile(root, 'HEAD', 'ref: refs/heads/main\n');
    gitFile(root, join('refs', 'heads', 'main'), `${HASH}\n`);
    assert.equal(readServerCommit(root), SHORT);

    // A ref nested deeper than one level (the common `feature/x` shape).
    gitFile(root, 'HEAD', 'ref: refs/heads/feature/log-everything\n');
    gitFile(root, join('refs', 'heads', 'feature', 'log-everything'), `${HASH}\n`);
    assert.equal(readServerCommit(root), SHORT);
  });
});

test('readServerCommit: a ref with no loose file is resolved from packed-refs', async () => {
  await withFixture((root) => {
    gitFile(root, 'HEAD', 'ref: refs/heads/main\n');
    gitFile(
      root,
      'packed-refs',
      '# pack-refs with: peeled fully-peeled sorted \n' +
        `0000000000000000000000000000000000000000 refs/heads/other\n` +
        `${HASH} refs/heads/main\n` +
        `^1111111111111111111111111111111111111111\n`,
    );
    assert.equal(readServerCommit(root), SHORT, 'the packed entry for THIS ref is the answer');

    // The wrong ref must not be picked up just because the file exists.
    gitFile(root, 'HEAD', 'ref: refs/heads/absent\n');
    assert.equal(readServerCommit(root), null);
  });
});

test('readServerCommit: no .git, an empty HEAD, or an unparsable HEAD -> null, never a throw', async () => {
  await withFixture((root) => {
    assert.equal(readServerCommit(root), null, 'no .git at all');

    gitFile(root, 'HEAD', '');
    assert.equal(readServerCommit(root), null, 'an empty HEAD');

    gitFile(root, 'HEAD', 'this is not a git head\n');
    assert.equal(readServerCommit(root), null, 'garbage in HEAD');

    gitFile(root, 'HEAD', 'ref: refs/heads/main\n');
    assert.equal(readServerCommit(root), null, 'a ref that resolves nowhere');

    // A loose ref file holding something that is not a 40-hex hash.
    gitFile(root, join('refs', 'heads', 'main'), 'not-a-hash\n');
    assert.equal(readServerCommit(root), null, 'a loose ref that is not a hash');

    // A HEAD that is a DIRECTORY: readFileSync throws EISDIR, caught inside.
    const dirRoot = fixture();
    try {
      mkdirSync(join(dirRoot, '.git', 'HEAD'), { recursive: true });
      assert.doesNotThrow(() => readServerCommit(dirRoot));
      assert.equal(readServerCommit(dirRoot), null);
    } finally {
      void rm(dirRoot, { recursive: true, force: true });
    }
  });
});

test('readServerCommit: a traversing ref is refused — nothing outside .git is ever read', async () => {
  await withFixture((root) => {
    // The escape target really exists and really holds a valid hash: if the
    // ref path were joined naively, the function would happily return it.
    writeFileSync(join(root, 'outside-ref'), `${HASH}\n`);
    mkdirSync(join(root, '.git'), { recursive: true });

    for (const ref of [
      '../../x',
      '../outside-ref',
      '../../outside-ref',
      'refs/../../outside-ref',
      'refs/heads/../../../outside-ref',
      '/etc/passwd',
      'refs/heads/main/../../../../outside-ref',
    ]) {
      gitFile(root, 'HEAD', `ref: ${ref}\n`);
      assert.equal(
        readServerCommit(root),
        null,
        `ref ${JSON.stringify(ref)} must resolve to null, never to a file outside .git`,
      );
    }

    // A symlinked ref inside .git pointing out of it still yields a hash — the
    // guard is on the REF STRING, and this documents that boundary honestly.
    // (It requires write access to .git, i.e. the repo is already yours.)
    gitFile(root, 'HEAD', 'ref: refs/heads/main\n');
    mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
    symlinkSync(join(root, 'outside-ref'), join(root, '.git', 'refs', 'heads', 'main'));
    assert.equal(readServerCommit(root), SHORT, 'a symlink inside .git is followed by design');
  });
});

// ---------------------------------------------------------------------------
// readWebBuild / mtimeOf
// ---------------------------------------------------------------------------

test('readWebBuild: a built web/dist names the hashed entry bundle, index.html mtime and build id', async () => {
  await withFixture((root) => {
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html>');
    writeFileSync(join(dist, 'assets', 'index-Br1e6z0Q.js'), '//');
    writeFileSync(join(dist, 'assets', 'style-Xy.css'), '/**/');
    writeFileSync(join(dist, 'build-id.json'), '{"id":"20260908-1200-abc1234"}\n');

    const build = readWebBuild(dist);
    assert.equal(build.asset, 'assets/index-Br1e6z0Q.js');
    assert.match(build.indexMtime as string, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(build.buildId, '20260908-1200-abc1234', 'the id the vite plugin emitted');
  });
});

test('readBuildId: only OUR shape is an id — anything else reads as no id, never a throw', async () => {
  await withFixture((root) => {
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });
    assert.equal(readBuildId(dist), null, 'absent file');

    for (const [contents, why] of [
      ['not json at all', 'unparsable'],
      ['[]', 'not an object'],
      ['{"id":42}', 'not a string'],
      ['{"id":""}', 'empty'],
      ['{"id":"a b"}', 'a space is not in the charset'],
      ['{"id":"x\\nfake"}', 'a newline could forge a second log line'],
      [`{"id":"${'x'.repeat(65)}"}`, 'over 64 characters'],
    ] as [string, string][]) {
      writeFileSync(join(dist, 'build-id.json'), contents);
      assert.equal(readBuildId(dist), null, why);
    }

    writeFileSync(join(dist, 'build-id.json'), '{"id":"20260908-1200-nogit"}');
    assert.equal(readBuildId(dist), '20260908-1200-nogit');
  });
});

test('readWebBuild: a MISSING web/dist is null on both fields — never a throw at boot', async () => {
  await withFixture((root) => {
    const absent = readWebBuild(join(root, 'dist'));
    assert.deepEqual(absent, { asset: null, indexMtime: null, buildId: null });

    // Half-built: index.html present, assets/ not.
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html>');
    const half = readWebBuild(dist);
    assert.equal(half.asset, null, 'no assets dir -> no bundle name');
    assert.match(half.indexMtime as string, /^\d{4}-/);

    // assets/ present but with no index-*.js (a partially cleaned dir).
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'assets', 'vendor-Ab12.js'), '//');
    assert.equal(readWebBuild(dist).asset, null, 'only index-*.js counts as the entry');
  });
});

test('mtimeOf: an ISO timestamp for a real path, null for an absent one', async () => {
  await withFixture((root) => {
    const file = join(root, 'thing');
    writeFileSync(file, 'x');
    assert.match(mtimeOf(file) as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(mtimeOf(join(root, 'nope')), null);
  });
});

// ---------------------------------------------------------------------------
// createUpdateChecker — "is the code on disk newer than this process?"
// ---------------------------------------------------------------------------
//
// This is the signal behind the UI's "New version available" notice, so both
// directions matter: a real change must be seen (otherwise the user keeps
// running a stale backend, which is the incident that started all of this), and
// nothing else may EVER flip it (otherwise the notice becomes noise and gets
// ignored). Every case runs on a temp fixture with an injected clock — no repo,
// no real mtimes, no sleeping.

const OTHER_HASH = 'b2c3d4e5f60718293a4b5c6d7e8f90123456789a';
const OTHER_SHORT = 'b2c3d4e';

/** A miniature checkout: .git/HEAD, server/, shared/, web/dist/. */
function repoFixture(root: string): void {
  gitFile(root, 'HEAD', `${HASH}\n`);
  mkdirSync(join(root, 'server'), { recursive: true });
  writeFileSync(join(root, 'server', 'index.ts'), 'boot\n');
  writeFileSync(join(root, 'server', 'statusline.mjs'), 'line\n');
  writeFileSync(join(root, 'server', 'README.txt'), 'not code\n');
  mkdirSync(join(root, 'shared'), { recursive: true });
  writeFileSync(join(root, 'shared', 'protocol.ts'), 'types\n');
  // An installed dependency tree: npm's own stamp, at least as new as the lock.
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'package-lock.json'), '{}\n');
  writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}\n');
  // Frontend SOURCES (the `git pull` half of the check) …
  mkdirSync(join(root, 'web', 'src', 'ui'), { recursive: true });
  writeFileSync(join(root, 'web', 'src', 'main.ts'), 'ui\n');
  writeFileSync(join(root, 'web', 'src', 'ui', 'drawer.ts'), 'ui\n');
  writeFileSync(join(root, 'web', 'index.html'), '<!doctype html>\n');
  mkdirSync(join(root, 'web', 'public'), { recursive: true });
  writeFileSync(join(root, 'web', 'public', 'favicon.ico'), 'icon\n');
  writeFileSync(join(root, 'vite.config.ts'), 'config\n');
  // … and the build made from them.
  mkdirSync(join(root, 'web', 'dist', 'assets'), { recursive: true });
  writeFileSync(join(root, 'web', 'dist', 'index.html'), '<!doctype html>\n');
  writeFileSync(join(root, 'web', 'dist', 'assets', 'index-AAAAAAAA.js'), 'bundle\n');
  writeFileSync(join(root, 'web', 'dist', 'build-id.json'), '{"id":"20260908-1200-aaaaaaa"}\n');
}

/** Everything in the fixture is OLDER than this run: the honest starting point. */
const STARTED_MS = Date.UTC(2026, 8, 6, 12, 0, 0);
const STARTED_AT = new Date(STARTED_MS).toISOString();

function checker(
  root: string,
  over: {
    bootAsset?: string | null;
    startedAt?: () => string;
    now?: () => number;
    maxScanEntries?: number;
  } = {},
): () => { available: boolean; reason: string | null } {
  return createUpdateChecker({
    repoRoot: root,
    serverDir: join(root, 'server'),
    sharedDir: join(root, 'shared'),
    webDistDir: join(root, 'web', 'dist'),
    bootCommit: SHORT,
    // A GETTER: a standby child re-reads which bundle it serves at `go`, so the
    // checker must ask rather than remember (server/index.ts adoptWebBuild).
    bootAsset: () => (over.bootAsset === undefined ? 'assets/index-AAAAAAAA.js' : over.bootAsset),
    startedAt: over.startedAt ?? ((): string => STARTED_AT),
    ...(over.now !== undefined ? { now: over.now } : {}),
    ...(over.maxScanEntries !== undefined ? { maxScanEntries: over.maxScanEntries } : {}),
  });
}

/** Push a path's mtime past startedAt — an edit landing after this run began. */
function touchAfterStart(path: string, offsetMs = 60_000): void {
  const when = new Date(STARTED_MS + offsetMs);
  utimesSync(path, when, when);
}

/** Everything the fixture writes gets a mtime BEFORE startedAt. */
function ageFixture(root: string): void {
  const when = new Date(STARTED_MS - 60_000);
  for (const rel of [
    ['server', 'index.ts'],
    ['server', 'statusline.mjs'],
    ['server', 'README.txt'],
    ['shared', 'protocol.ts'],
    ['package-lock.json'],
    ['node_modules', '.package-lock.json'],
    ['vite.config.ts'],
    ['web', 'index.html'],
    ['web', 'src', 'main.ts'],
    ['web', 'src', 'ui', 'drawer.ts'],
    ['web', 'public', 'favicon.ico'],
    ['web', 'dist', 'index.html'],
    ['web', 'dist', 'assets', 'index-AAAAAAAA.js'],
    // The build is the NEWEST thing in an up-to-date checkout: it was made
    // from the sources above, so nothing is newer than it.
    ['web', 'dist', 'build-id.json'],
  ]) {
    utimesSync(join(root, ...rel), when, when);
  }
  const built = new Date(STARTED_MS - 30_000);
  utimesSync(join(root, 'web', 'dist', 'build-id.json'), built, built);
}

test('update check: an unchanged checkout reports nothing — the notice must never cry wolf', async () => {
  await withFixture((root) => {
    repoFixture(root);
    ageFixture(root);
    assert.deepEqual(checker(root)(), { available: false, reason: null });
  });
});

test('update check: a new commit reports both hashes', async () => {
  await withFixture((root) => {
    repoFixture(root);
    ageFixture(root);
    gitFile(root, 'HEAD', `${OTHER_HASH}\n`);
    assert.deepEqual(checker(root)(), {
      available: true,
      reason: `server code changed (${SHORT} → ${OTHER_SHORT})`,
    });
  });
});

test('update check: an UNREADABLE .git is not a change — it is no signal at all', async () => {
  await withFixture((root) => {
    repoFixture(root);
    ageFixture(root);
    rmSync(join(root, '.git'), { recursive: true, force: true });
    assert.deepEqual(checker(root)(), { available: false, reason: null });
  });
});

test('update check: web/dist rebuilt after startedAt reads `frontend rebuilt`', async () => {
  await withFixture((root) => {
    repoFixture(root);
    ageFixture(root);
    touchAfterStart(join(root, 'web', 'dist', 'index.html'));
    assert.deepEqual(checker(root)(), { available: true, reason: UPDATE_FRONTEND_REBUILT });
  });
});

test('update check: a different entry bundle is a rebuild even with untouched mtimes', async () => {
  await withFixture((root) => {
    repoFixture(root);
    ageFixture(root);
    // Same clock, other content hash — exactly what `vite build` produces.
    assert.deepEqual(checker(root, { bootAsset: 'assets/index-OLDOLDOL.js' })(), {
      available: true,
      reason: UPDATE_FRONTEND_REBUILT,
    });
  });
});

test('update check: an edited server/*.ts or server/*.mjs reads `server files edited`', async () => {
  for (const rel of [
    ['server', 'index.ts'],
    ['server', 'statusline.mjs'],
  ]) {
    await withFixture((root) => {
      repoFixture(root);
      ageFixture(root);
      touchAfterStart(join(root, ...rel));
      assert.deepEqual(
        checker(root)(),
        { available: true, reason: UPDATE_SERVER_FILES_EDITED },
        `${rel.join('/')} must count as running-code change`,
      );
    });
  }
});

test('update check: a non-code file in server/ is NOT a new version', async () => {
  await withFixture((root) => {
    repoFixture(root);
    ageFixture(root);
    touchAfterStart(join(root, 'server', 'README.txt'));
    assert.deepEqual(checker(root)(), { available: false, reason: null });
  });
});

test('update check: before listen (startedAt is empty) nothing is ever reported', async () => {
  await withFixture((root) => {
    repoFixture(root);
    ageFixture(root);
    touchAfterStart(join(root, 'server', 'index.ts'));
    assert.deepEqual(checker(root, { startedAt: () => '' })(), { available: false, reason: null });
  });
});

test('update check: the result is cached ~5 s — a 30 s UI poll cannot turn this into a stat storm', async () => {
  await withFixture((root) => {
    repoFixture(root);
    ageFixture(root);
    let clock = 10_000;
    const check = checker(root, { now: () => clock });
    assert.deepEqual(check(), { available: false, reason: null });

    touchAfterStart(join(root, 'server', 'index.ts'));
    clock += 4_999;
    assert.deepEqual(check(), { available: false, reason: null }, 'still the cached answer');
    clock += 1;
    assert.deepEqual(
      check(),
      { available: true, reason: UPDATE_SERVER_FILES_EDITED },
      'the window is over',
    );
  });
});

// ---------------------------------------------------------------------------
// dependenciesInStep + the update reasons added 2026-09-08
// ---------------------------------------------------------------------------
//
// These exist because of the closed open decision "update after a git pull
// without npm run build": a pull moves web/src and package-lock.json and
// touches NEITHER web/dist (gitignored) nor the process's own start time, so
// the old checks were blind to exactly the case the user hits.

test('dependenciesInStep: node_modules absent, or older than package-lock.json, is out of step', async () => {
  await withFixture((root) => {
    repoFixture(root);
    ageFixture(root);
    assert.equal(dependenciesInStep(root), true, 'an installed tree with an older lockfile');

    touchAfterStart(join(root, 'package-lock.json'));
    assert.equal(dependenciesInStep(root), false, 'a pulled lockfile with no install after it');

    // Reinstalled: npm rewrites its own stamp last.
    touchAfterStart(join(root, 'node_modules', '.package-lock.json'), 120_000);
    assert.equal(dependenciesInStep(root), true);

    rmSync(join(root, 'node_modules'), { recursive: true, force: true });
    assert.equal(dependenciesInStep(root), false, 'no dependency tree at all');
  });
});

test('dependenciesInStep: a repo with no lockfile at all is never "out of step"', async () => {
  await withFixture((root) => {
    repoFixture(root);
    ageFixture(root);
    rmSync(join(root, 'package-lock.json'));
    assert.equal(dependenciesInStep(root), true);
  });
});

test('dependenciesInStep: an installed tree with NO npm stamp is no signal, not a permanent refusal', async () => {
  // node_modules/.package-lock.json is npm >= 7's own bookkeeping. A tree
  // installed by something else — an older npm, a hand-pruned or packaged
  // node_modules — has none, and comparing the lockfile against a stamp of 0
  // made every restart refuse with "install the dependencies", which installing
  // them could not fix: npm writes the stamp, and the user could not know that.
  await withFixture((root) => {
    repoFixture(root);
    ageFixture(root);
    rmSync(join(root, 'node_modules', '.package-lock.json'));
    assert.equal(dependenciesInStep(root), true, 'no stamp = no signal');

    // Even with a lockfile that is newer than everything: without a stamp there
    // is nothing to compare it to, and a guess is worse than silence.
    touchAfterStart(join(root, 'package-lock.json'));
    assert.equal(dependenciesInStep(root), true);

    // The tree itself missing is still the honest "out of step".
    rmSync(join(root, 'node_modules'), { recursive: true, force: true });
    assert.equal(dependenciesInStep(root), false);
  });
});

test('update check: an installed tree with no npm stamp does not report `dependencies changed`', async () => {
  await withFixture((root) => {
    repoFixture(root);
    ageFixture(root);
    rmSync(join(root, 'node_modules', '.package-lock.json'));
    assert.deepEqual(checker(root)(), { available: false, reason: null });
  });
});

test('update check: the recursive scan stops at its entry budget — the ceiling is real, not decorative', () => {
  // MAX_SCAN_ENTRIES bounds ONE frontend-source walk so a symlink farm or a
  // stray node_modules under web/src can never turn a 5 s-cached status probe
  // into a disk walk. readdir order is not deterministic, so the tree below is
  // a CHAIN — every directory holds exactly one entry — which makes the number
  // of entries walked before the newest file exact rather than probable.
  assert.equal(MAX_SCAN_ENTRIES, 2_000, 'the shipped default');

  const root = mkdtempSync(join(tmpdir(), 'ai-sm-scan-'));
  try {
    repoFixture(root);
    ageFixture(root);
    // web/src holds NOTHING but the chain: l1/l2/l3/edited.ts, 4 entries.
    rmSync(join(root, 'web', 'src'), { recursive: true, force: true });
    const chain = join(root, 'web', 'src', 'l1', 'l2', 'l3');
    mkdirSync(chain, { recursive: true });
    const edited = join(chain, 'edited.ts');
    writeFileSync(edited, 'pulled\n');
    touchAfterStart(edited); // Newer than the build: the signal to be found.

    assert.deepEqual(
      checker(root, { maxScanEntries: 3 })(),
      { available: false, reason: null },
      'three entries of budget never reach the fourth: the walk stops, and a stopped walk is no signal',
    );
    assert.deepEqual(
      checker(root, { maxScanEntries: 4 })(),
      { available: true, reason: 'frontend source changed' },
      'one more entry of budget, and the very same tree reports the edit',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('update check: a pulled package-lock.json reads `dependencies changed` — before everything else', async () => {
  await withFixture((root) => {
    repoFixture(root);
    ageFixture(root);
    // Everything else is ALSO stale: precedence must still pick the one the
    // user has to act on first (npm install), not one of the others.
    touchAfterStart(join(root, 'package-lock.json'));
    touchAfterStart(join(root, 'web', 'src', 'main.ts'));
    touchAfterStart(join(root, 'server', 'index.ts'));
    gitFile(root, 'HEAD', `${OTHER_HASH}\n`);
    assert.deepEqual(checker(root)(), { available: true, reason: UPDATE_DEPENDENCIES_CHANGED });
  });
});

test('update check: web/dist without a build-id.json (or without an entry bundle) reads `frontend build missing`', async () => {
  for (const rel of [
    ['web', 'dist', 'build-id.json'],
    ['web', 'dist', 'assets', 'index-AAAAAAAA.js'],
    ['web', 'dist', 'index.html'],
  ]) {
    await withFixture((root) => {
      repoFixture(root);
      ageFixture(root);
      rmSync(join(root, ...rel));
      assert.deepEqual(
        checker(root)(),
        { available: true, reason: UPDATE_FRONTEND_BUILD_MISSING },
        `a web/dist missing ${rel.join('/')} is not something to serve`,
      );
    });
  }
});

test('update check: a whole web/dist that never existed reads `frontend build missing`, not `rebuilt`', async () => {
  await withFixture((root) => {
    repoFixture(root);
    ageFixture(root);
    rmSync(join(root, 'web', 'dist'), { recursive: true, force: true });
    assert.deepEqual(checker(root, { bootAsset: null })(), {
      available: true,
      reason: UPDATE_FRONTEND_BUILD_MISSING,
    });
  });
});

test('update check: a frontend source newer than the BUILD reads `frontend source changed`', async () => {
  // The git-pull case exactly: the sources moved, the build did not, and this
  // process's start time is irrelevant to both.
  for (const rel of [
    ['web', 'src', 'main.ts'],
    ['web', 'src', 'ui', 'drawer.ts'],
    ['web', 'index.html'],
    ['web', 'public', 'favicon.ico'],
    ['vite.config.ts'],
    ['shared', 'protocol.ts'],
  ]) {
    await withFixture((root) => {
      repoFixture(root);
      ageFixture(root);
      // Newer than build-id.json, still OLDER than startedAt: nothing but this
      // rule can see it.
      const when = new Date(STARTED_MS - 10_000);
      utimesSync(join(root, ...rel), when, when);
      assert.deepEqual(
        checker(root)(),
        { available: true, reason: UPDATE_FRONTEND_SOURCE_CHANGED },
        `${rel.join('/')} is compiled into the bundle`,
      );
    });
  }
});

test('update check: a shared/*.ts edit the build already includes reads `server files edited`', async () => {
  await withFixture((root) => {
    repoFixture(root);
    ageFixture(root);
    touchAfterStart(join(root, 'shared', 'protocol.ts'), 60_000);
    // The frontend was rebuilt AFTER that edit, so only the server is behind.
    touchAfterStart(join(root, 'web', 'dist', 'build-id.json'), 120_000);
    assert.deepEqual(checker(root)(), { available: true, reason: UPDATE_SERVER_FILES_EDITED });
  });
});

test('update check: a deep, WIDE web/src with a symlink cycle is walked without hanging or throwing', async () => {
  // The walk is on the path of an authenticated status probe the UI hits every
  // 30 s, so it is bounded by MAX_SCAN_ENTRIES (2000) and never follows a link.
  // What must hold whatever is on disk: it returns, it returns fast, and it
  // returns an ANSWER rather than an exception — an unreadable directory or a
  // symlink farm under web/src must not be able to fail GET /api/runtime.
  await withFixture((root) => {
    repoFixture(root);
    ageFixture(root);
    const aged = new Date(STARTED_MS - 60_000);
    const src = join(root, 'web', 'src');

    // ~2250 files over 45 nested levels: comfortably past the 2000 budget, and
    // deep enough that an unbounded walk would recurse the whole way down.
    let dir = src;
    for (let level = 0; level < 45; level++) {
      dir = join(dir, `level-${level}`);
      mkdirSync(dir, { recursive: true });
      for (let file = 0; file < 50; file++) {
        const path = join(dir, `mod-${file}.ts`);
        writeFileSync(path, 'x\n');
        utimesSync(path, aged, aged);
      }
    }

    // A two-hop CYCLE: web/src/loop-a -> the deepest dir, and a link back up to
    // web/src from inside it. Following either one walks forever.
    symlinkSync(dir, join(src, 'loop-a'));
    symlinkSync(src, join(dir, 'loop-b'));
    lutimesSync(join(src, 'loop-a'), aged, aged);
    lutimesSync(join(dir, 'loop-b'), aged, aged);

    const started = Date.now();
    const result = checker(root)();
    const took = Date.now() - started;

    assert.deepEqual(result, { available: false, reason: null }, 'nothing here is newer than the build');
    assert.ok(took < 5_000, `the walk must stay cheap; took ${took}ms`);
  });
});

test('update check: a symlink pointing OUT of web/src is measured, never followed', async () => {
  // The walk's stated guarantee is that it stays inside the tree it was given.
  // A link to somewhere busy (a home directory, another checkout) must not be
  // able to light the update pill — nor to turn a 30 s status poll into a walk
  // of whatever it points at.
  await withFixture((root) => {
    repoFixture(root);
    ageFixture(root);
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    const stranger = join(outside, 'busy.ts');
    writeFileSync(stranger, 'not ours\n');
    // Newer than build-id.json (STARTED_MS - 30_000), so it WOULD be a signal
    // if the walk ever counted it.
    const fresh = new Date(STARTED_MS - 10_000);
    utimesSync(stranger, fresh, fresh);

    const link = join(root, 'web', 'src', 'escape');
    symlinkSync(outside, link);
    const aged = new Date(STARTED_MS - 60_000);
    lutimesSync(link, aged, aged);

    assert.deepEqual(
      checker(root)(),
      { available: false, reason: null },
      'the link is one aged entry; what it points at is none of our business',
    );

    // Control: the very same file, at the very same mtime, INSIDE the tree does
    // flip it — so the assertion above is about the link, not about the file.
    writeFileSync(join(root, 'web', 'src', 'busy.ts'), 'ours\n');
    utimesSync(join(root, 'web', 'src', 'busy.ts'), fresh, fresh);
    // A fresh checker: each one starts with an empty result cache.
    assert.deepEqual(checker(root)(), { available: true, reason: UPDATE_FRONTEND_SOURCE_CHANGED });
  });
});

test('update check: a web/src subdirectory that cannot be read is no signal, never a failed probe', async () => {
  if (process.getuid?.() === 0) return; // root reads everything; nothing to prove.
  await withFixture((root) => {
    repoFixture(root);
    ageFixture(root);
    const locked = join(root, 'web', 'src', 'locked');
    mkdirSync(locked, { recursive: true });
    const inside = join(locked, 'secret.ts');
    writeFileSync(inside, 'x\n');
    // Newer than the build: if the walk could read it, this would read as a
    // frontend change. It cannot, so the honest answer is "no signal".
    const fresh = new Date(STARTED_MS - 10_000);
    utimesSync(inside, fresh, fresh);
    chmodSync(locked, 0o000);
    try {
      assert.deepEqual(checker(root)(), { available: false, reason: null });
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

test('update check: a file deep under web/src counts, and the walk never throws on a symlink loop', async () => {
  await withFixture((root) => {
    repoFixture(root);
    ageFixture(root);
    // A symlink pointing at its own parent: the walk must not follow it, and
    // it is measured by its own (aged) mtime, not by what it resolves to.
    symlinkSync(join(root, 'web', 'src'), join(root, 'web', 'src', 'loop'));
    const old = new Date(STARTED_MS - 60_000);
    lutimesSync(join(root, 'web', 'src', 'loop'), old, old);
    assert.deepEqual(checker(root)(), { available: false, reason: null });

    const when = new Date(STARTED_MS - 10_000);
    utimesSync(join(root, 'web', 'src', 'ui', 'drawer.ts'), when, when);
    assert.deepEqual(checker(root)(), { available: true, reason: UPDATE_FRONTEND_SOURCE_CHANGED });
  });
});

// ---------------------------------------------------------------------------
// The build identity the REPO actually shipped
// ---------------------------------------------------------------------------

test("the repo's own web/dist agrees with itself: build-id.json is the literal compiled into the bundle", (t) => {
  // The 2026-09-08 incident: a bundle built from inside `web/` missed the root
  // config's `define`, so it shipped the BARE identifier `__BUILD_ID__` and the
  // boot line threw a ReferenceError — while `build-id.json` beside it looked
  // perfectly healthy. The two are written by the same vite plugin from one
  // constant, so any disagreement means the bundle was not built by the root
  // config. Nothing here is mutated: this reads the working tree only.
  const dist = join(projectRoot, 'web', 'dist');
  const info = readWebBuild(dist);
  if (info.buildId === null || info.asset === null) {
    // A fresh checkout: web/dist is gitignored, so there may be nothing built.
    t.skip(`no built frontend in ${dist} — run \`npm run build\``);
    return;
  }
  const bundle = readFileSync(join(dist, info.asset), 'utf8');
  // As a STRING LITERAL, whichever quote the minifier picked (it emits
  // backticks here) — never as a bare identifier and never as a fragment.
  const literal = new RegExp(`['"\`]${info.buildId.replace(/[^a-zA-Z0-9-]/g, '.')}['"\`]`);
  assert.match(
    bundle,
    literal,
    `${info.asset} must carry the id ${JSON.stringify(info.buildId)} from build-id.json as a literal`,
  );
  assert.ok(
    !bundle.includes('__BUILD' + '_ID__'),
    `${info.asset} still holds the bare __BUILD_ID__ identifier: the define did not run ` +
      '(a build started from web/ instead of the repo root)',
  );
});
