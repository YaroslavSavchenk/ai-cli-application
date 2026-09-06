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
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readServerCommit, readWebBuild, mtimeOf } from '../server/buildinfo.ts';

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

test('readWebBuild: a built web/dist names the hashed entry bundle and index.html mtime', async () => {
  await withFixture((root) => {
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html>');
    writeFileSync(join(dist, 'assets', 'index-Br1e6z0Q.js'), '//');
    writeFileSync(join(dist, 'assets', 'style-Xy.css'), '/**/');

    const build = readWebBuild(dist);
    assert.equal(build.asset, 'assets/index-Br1e6z0Q.js');
    assert.match(build.indexMtime as string, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('readWebBuild: a MISSING web/dist is null on both fields — never a throw at boot', async () => {
  await withFixture((root) => {
    const absent = readWebBuild(join(root, 'dist'));
    assert.deepEqual(absent, { asset: null, indexMtime: null });

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
