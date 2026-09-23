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
 * outside `.git`. Also here: readWebBuild / readBuildId / mtimeOf, and two
 * read-only checks on the repo's own built web/dist.
 *
 * Everything else runs on temp fixtures (`tests/helpers/buildinfo-fixture.ts`):
 * no real repository is touched, no `git` binary is spawned (by design — this
 * runs in a detached process that cannot depend on a binary or on a repo lock).
 *
 * NOT claimed here: the update checker ("is the code on disk newer than this
 * process?") — `tests/server/buildinfo-update-check.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readServerCommit, readWebBuild, readBuildId, mtimeOf } from '../../server/buildinfo.ts';
import { projectRoot } from '../helpers/helpers.ts';
import { HASH, SHORT, fixture, gitFile, withFixture } from '../helpers/buildinfo-fixture.ts';

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

test("the repo's own web/dist ships the mascot page beside the app page", (t) => {
  // Two rollup inputs (vite.config.ts): `index` and `mascot`. The risk this
  // pins is not that the page renders — it is that a SECOND entry changes what
  // "a frontend build" looks like to the server: readWebBuild picks the entry
  // bundle by `assets/index-*.js`, and the restart preflight refuses a build
  // whose entry it cannot find. A mascot chunk that ever sorted into that slot
  // would make every restart serve the wrong bundle.
  const dist = join(projectRoot, 'web', 'dist');
  const info = readWebBuild(dist);
  if (info.buildId === null || info.asset === null) {
    t.skip(`no built frontend in ${dist} — run \`npm run build\``);
    return;
  }
  for (const name of ['index.html', 'mascot.html', 'build-id.json']) {
    assert.ok(existsSync(join(dist, name)), `web/dist/${name} is missing from the build`);
  }
  assert.match(info.asset, /^assets\/index-.*\.js$/, 'the app entry is still the index bundle');

  const mascot = readFileSync(join(dist, 'mascot.html'), 'utf8');
  const script = /<script[^>]+src="\/?(assets\/[^"]+\.js)"/.exec(mascot);
  assert.notEqual(script, null, 'mascot.html loads no bundle at all');
  assert.match(script![1]!, /^assets\/mascot-.*\.js$/, 'the mascot page must load its OWN chunk');
  assert.ok(
    !mascot.includes('/src/mascot/main.ts'),
    'mascot.html still points at the source entry: it was copied, not built',
  );

  const index = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.ok(
    !index.includes('mascot'),
    'the app page must not pull in the mascot page (separate entries, separate bundles)',
  );
});
