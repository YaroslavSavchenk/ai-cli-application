/**
 * `server/bundle.ts` — INSTALLED MODE: the backend running from an unpacked
 * bundle (`<app>/<version>/`, with `<app>/current` naming the live one) instead
 * of a developer clone.
 *
 * Three things are pinned here, all on temp fixtures — no real install, no real
 * server, and never the repo's own tree:
 *
 *   1. `readBundleInfo` treats `bundle.json` as UNTRUSTED disk content. Its
 *      strings reach server.log and GET /api/runtime → the UI, so every field
 *      is charset-gated and a single bad one yields null rather than a partial
 *      object. Nothing here may ever throw: it runs at boot in a detached
 *      process where an exception is an app that never starts.
 *   2. `createInstalledUpdateChecker` has ONE signal — `current` points
 *      somewhere else — and NEVER nags: a dangling, absent, unreadable or
 *      plain-directory `current` all read as "no update", because a half
 *      finished install must not light the pill.
 *   3. `resolveInstalledTarget` proves the bundle a restart is about to spawn
 *      BEFORE anything is torn down, and CONTAINS it: what `current` resolves
 *      to is executed, so it must be a direct child of `<app>`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUNDLE_FILE,
  CURRENT_LINK,
  createInstalledUpdateChecker,
  readBundleInfo,
  resolveInstalledTarget,
  UPDATE_NEW_VERSION_INSTALLED,
  type BundleInfo,
} from '../server/bundle.ts';
import { createUpdateChecker } from '../server/buildinfo.ts';
import { REFUSED_STANDBY, RestartRefusal } from '../server/restart.ts';
import { projectRoot } from './helpers.ts';

const GOOD: BundleInfo = {
  version: 'v0.2.0',
  commit: '8c308cc',
  nodeVersion: 'v24.8.0',
  builtAt: '2026-09-08T12:34:56.000Z',
  platform: 'linux-x64',
  glibcMin: '2.35',
};

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ai-sm-bundle-'));
}

async function withRoot(fn: (root: string) => void | Promise<void>): Promise<void> {
  const root = tempRoot();
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Write `<dir>/bundle.json` verbatim — a string, so malformed input is testable. */
function writeMarker(dir: string, raw: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, BUNDLE_FILE), raw);
}

interface VersionOpts {
  /** Skip `server/index.ts`. */
  noEntry?: boolean;
  /** Skip `node/bin/node`. */
  noNode?: boolean;
  /** Create `node/bin/node` without the execute bit. */
  nodeNotExecutable?: boolean;
  /** Skip `web/dist/assets/index-*.js`. */
  noWebAsset?: boolean;
  /** Skip `web/dist/index.html`. */
  noWebIndex?: boolean;
  /** Skip `bundle.json`. */
  noMarker?: boolean;
  /** Override the marker contents (raw). */
  marker?: string;
}

/**
 * A version directory shaped exactly like an unpacked bundle — the four things
 * `resolveInstalledTarget` checks, each of which can be omitted.
 */
function makeVersion(root: string, name: string, opts: VersionOpts = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (opts.noMarker !== true) {
    writeMarker(dir, opts.marker ?? JSON.stringify({ ...GOOD, version: name }));
  }
  if (opts.noEntry !== true) {
    mkdirSync(join(dir, 'server'), { recursive: true });
    writeFileSync(join(dir, 'server', 'index.ts'), '// bundle entry\n');
  }
  if (opts.noNode !== true) {
    mkdirSync(join(dir, 'node', 'bin'), { recursive: true });
    const bin = join(dir, 'node', 'bin', 'node');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, opts.nodeNotExecutable === true ? 0o644 : 0o755);
  }
  const dist = join(dir, 'web', 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  if (opts.noWebIndex !== true) writeFileSync(join(dist, 'index.html'), '<!doctype html>');
  if (opts.noWebAsset !== true) writeFileSync(join(dist, 'assets', 'index-AbCdEf12.js'), 'console.log(1)');
  writeFileSync(join(dist, 'build-id.json'), JSON.stringify({ id: '20260908-1234-abcdef1' }));
  return dir;
}

/** Point `<root>/current` at `<root>/<name>` (replacing any existing link). */
function pointCurrent(root: string, name: string): void {
  const link = join(root, CURRENT_LINK);
  try {
    unlinkSync(link);
  } catch {
    // Not there yet.
  }
  symlinkSync(join(root, name), link);
}

// ---------------------------------------------------------------------------
// readBundleInfo
// ---------------------------------------------------------------------------

test('readBundleInfo: a valid marker is read field by field, glibcMin included', async () => {
  await withRoot((root) => {
    writeMarker(root, JSON.stringify(GOOD));
    assert.deepEqual(readBundleInfo(root), GOOD);
  });
});

test('readBundleInfo: glibcMin is optional and a null commit is legal', async () => {
  await withRoot((root) => {
    writeMarker(root, JSON.stringify({ ...GOOD, commit: null, glibcMin: undefined }));
    const info = readBundleInfo(root);
    assert.deepEqual(info, {
      version: 'v0.2.0',
      commit: null,
      nodeVersion: 'v24.8.0',
      builtAt: '2026-09-08T12:34:56.000Z',
      platform: 'linux-x64',
    });
    assert.ok(info !== null && !('glibcMin' in info), 'an absent glibcMin stays absent, never undefined');
  });
});

test('readBundleInfo: unknown fields are ignored, not copied — the marker grows without breaking', async () => {
  await withRoot((root) => {
    writeMarker(root, JSON.stringify({ ...GOOD, future: 'whatever', size: 123 }));
    assert.deepEqual(readBundleInfo(root), GOOD, 'exactly the known fields, nothing else');
  });
});

test('readBundleInfo: no bundle.json is the DEVELOPER CLONE — null, and the repo itself is one', async () => {
  await withRoot((root) => {
    assert.equal(readBundleInfo(root), null);
    assert.equal(readBundleInfo(join(root, 'does-not-exist')), null);
  });
  assert.equal(
    readBundleInfo(projectRoot),
    null,
    'the checkout this suite runs in must never read as an installed bundle',
  );
});

test('readBundleInfo: a directory named bundle.json, and unreadable contents, are null not a throw', async () => {
  await withRoot((root) => {
    mkdirSync(join(root, BUNDLE_FILE), { recursive: true }); // EISDIR on read.
    assert.equal(readBundleInfo(root), null);
  });
});

test('readBundleInfo: a marker that EXISTS but cannot be read is reported, not swallowed', async () => {
  // "Absent" and "unreadable" are the same answer (null = developer clone) but
  // not the same event: an install whose marker read fails — fd exhaustion
  // (EMFILE), a permission change, EISDIR — runs as a CLONE for its whole life,
  // with no version banner, the mtime update heuristics back on and a restart
  // that tries to run vite in a tree that has none. Silent is the bug.
  await withRoot((root) => {
    mkdirSync(join(root, BUNDLE_FILE), { recursive: true }); // EISDIR on read.
    const lines: string[] = [];
    assert.equal(readBundleInfo(root, { warn: (line) => lines.push(line) }), null);
    assert.equal(lines.length, 1, `exactly one line, got ${JSON.stringify(lines)}`);
    assert.match(lines[0] ?? '', /EISDIR/);
    assert.match(lines[0] ?? '', /developer clone/);
  });

  // ENOENT — the normal clone — says nothing at all.
  await withRoot((root) => {
    const lines: string[] = [];
    assert.equal(readBundleInfo(root, { warn: (line) => lines.push(line) }), null);
    assert.deepEqual(lines, [], 'a missing marker is not a warning');
  });

  // Neither is a marker that is PRESENT but invalid: that is a deliberate "not
  // our bundle", and it already means developer mode.
  await withRoot((root) => {
    writeMarker(root, '{"version":"nope!"}');
    const lines: string[] = [];
    assert.equal(readBundleInfo(root, { warn: (line) => lines.push(line) }), null);
    assert.deepEqual(lines, [], 'an invalid marker stays silent');
  });

  // And the callback is optional — every existing caller passes nothing.
  await withRoot((root) => {
    mkdirSync(join(root, BUNDLE_FILE), { recursive: true });
    assert.equal(readBundleInfo(root), null);
    assert.equal(readBundleInfo(root, {}), null);
  });
});

test('readBundleInfo: non-JSON and non-object JSON are null', async () => {
  for (const raw of ['', 'not json at all', '{', '[]', '"v0.2.0"', '42', 'null', '[{"version":"v1"}]']) {
    await withRoot((root) => {
      writeMarker(root, raw);
      assert.equal(readBundleInfo(root), null, `must reject ${JSON.stringify(raw)}`);
    });
  }
});

test('readBundleInfo: ONE bad field yields null — never a partial object', async () => {
  const bad: Record<string, unknown>[] = [
    { version: undefined },
    { version: 42 },
    { version: '' },
    // The charset gate itself: this string would otherwise be printed into
    // server.log and rendered by the UI.
    { version: 'v1;rm -rf' },
    { version: 'v1 with spaces' },
    { version: 'v1\nsecond line' },
    { version: 'v'.repeat(65) },
    // ONE contract with scripts/build-bundle.sh, where the same shape keeps a
    // version out of `rm -rf` and out of an argv option slot. A marker holding
    // one of these describes a bundle that could never have been built.
    { version: '..' },
    { version: '.' },
    { version: '-h' },
    { version: '--remove-files' },
    { version: '-0.2.0' },
    { commit: 'ABCDEF1' }, // uppercase is not a git short hash
    { commit: '123abc' }, // 6 < 7
    { commit: '0'.repeat(41) },
    { commit: 42 },
    { commit: 'zzzzzzz' },
    { nodeVersion: 'v24' },
    { nodeVersion: '24.8.0.1' },
    { nodeVersion: 'node v24.8.0' },
    { nodeVersion: null },
    { builtAt: 'yesterday' },
    { builtAt: 42 },
    { builtAt: '' },
    { platform: 'linux-arm64' },
    { platform: 'win32' },
    { platform: undefined },
    { glibcMin: '2.35.1' },
    { glibcMin: 'x' },
    { glibcMin: 2.35 },
  ];
  for (const patch of bad) {
    await withRoot((root) => {
      writeMarker(root, JSON.stringify({ ...GOOD, ...patch }));
      assert.equal(readBundleInfo(root), null, `must reject ${JSON.stringify(patch)}`);
    });
  }
});

test('readBundleInfo: builtAt is charset-gated, not merely Date.parse-able', async () => {
  // `Date.parse` accepts free text — including NEWLINES — inside parentheses,
  // and builtAt is printed into the boot banner: a marker like this one would
  // forge a second server.log line. The shape gate runs BEFORE Date.parse.
  const forged = 'Sep 8 2026 (line one\nline two)';
  assert.ok(!Number.isNaN(Date.parse(forged)), 'the premise: V8 parses this');
  const rejected = [
    forged,
    'Sep 8 2026',
    '2026-09-08',
    '2026-09-08T19:08:37+02:00',
    '2026-09-08T19:08:37.1234Z',
    '2026-09-08T19:08:37Z ',
    '2026-13-08T19:08:37Z', // shape ok, not a real instant
  ];
  for (const builtAt of rejected) {
    await withRoot((root) => {
      writeMarker(root, JSON.stringify({ ...GOOD, builtAt }));
      assert.equal(readBundleInfo(root), null, `must reject ${JSON.stringify(builtAt)}`);
    });
  }
  // The two shapes the builder actually writes (`date -u +%Y-%m-%dT%H:%M:%SZ`)
  // and the millisecond form both stay accepted.
  for (const builtAt of ['2026-09-08T19:08:37Z', '2026-09-08T12:34:56.000Z']) {
    await withRoot((root) => {
      writeMarker(root, JSON.stringify({ ...GOOD, builtAt }));
      assert.equal(readBundleInfo(root)?.builtAt, builtAt);
    });
  }
});

test('readBundleInfo: a marker larger than 4 KiB is refused without parsing', async () => {
  await withRoot((root) => {
    const padded = JSON.stringify({ ...GOOD, pad: 'x'.repeat(4_096) });
    assert.ok(padded.length > 4_096);
    writeMarker(root, padded);
    assert.equal(readBundleInfo(root), null);
    // And the boundary the other way: a marker just under the ceiling is fine.
    const snug = JSON.stringify({ ...GOOD, pad: 'x'.repeat(3_000) });
    assert.ok(snug.length < 4_096);
    writeMarker(root, snug);
    assert.deepEqual(readBundleInfo(root), GOOD);
  });
});

// ---------------------------------------------------------------------------
// createInstalledUpdateChecker
// ---------------------------------------------------------------------------

const STARTED = '2026-09-08T12:00:00.000Z';

function checker(appDir: string, over: { now?: () => number; startedAt?: () => string } = {}): () => {
  available: boolean;
  reason: string | null;
} {
  return createInstalledUpdateChecker({
    appDir,
    startedAt: over.startedAt ?? ((): string => STARTED),
    ...(over.now !== undefined ? { now: over.now } : {}),
  });
}

const NO_UPDATE = { available: false, reason: null };

test('installed update: `current` pointing at THIS version is no update', async () => {
  await withRoot((root) => {
    const v1 = makeVersion(root, 'v1');
    pointCurrent(root, 'v1');
    assert.deepEqual(checker(v1)(), NO_UPDATE);
  });
});

test('installed update: `current` moved to another version reads `a new version is installed`', async () => {
  await withRoot((root) => {
    const v1 = makeVersion(root, 'v1');
    makeVersion(root, 'v2');
    pointCurrent(root, 'v2');
    assert.deepEqual(checker(v1)(), { available: true, reason: UPDATE_NEW_VERSION_INSTALLED });
    assert.equal(UPDATE_NEW_VERSION_INSTALLED, 'a new version is installed', 'the exact string is wire contract');
  });
});

test('installed update: dangling, absent, a plain directory and an unreadable app dir all mean NO signal', async () => {
  // A half-finished install must never nag: every one of these is a state the
  // installer passes through, and none of them may throw at request time.
  await withRoot((root) => {
    const v1 = makeVersion(root, 'v1');
    assert.deepEqual(checker(v1)(), NO_UPDATE, 'no `current` at all');

    symlinkSync(join(root, 'v9-not-unpacked-yet'), join(root, CURRENT_LINK));
    assert.deepEqual(checker(v1)(), NO_UPDATE, 'a dangling `current`');

    unlinkSync(join(root, CURRENT_LINK));
    mkdirSync(join(root, CURRENT_LINK));
    assert.deepEqual(checker(v1)(), NO_UPDATE, 'a plain directory named `current` is not our symlink');
  });

  await withRoot((root) => {
    const v1 = makeVersion(root, 'v1');
    makeVersion(root, 'v2');
    pointCurrent(root, 'v2');
    chmodSync(root, 0o000); // realpath -> EACCES
    try {
      assert.deepEqual(checker(v1)(), NO_UPDATE, 'an unreadable app dir is no signal, not a throw');
    } finally {
      chmodSync(root, 0o755);
    }
  });
});

test('installed update: a HALF-FINISHED unpack at `current` is no update', async () => {
  // The pill promises a restart that works. `current` pointing at a directory
  // without a bundle marker is exactly what resolveInstalledTarget refuses, so
  // offering it would light the pill permanently and 422 on every press.
  await withRoot((root) => {
    const v1 = makeVersion(root, 'v1');
    makeVersion(root, 'v2', { noMarker: true }); // unpacked, marker not there yet
    pointCurrent(root, 'v2');
    assert.deepEqual(checker(v1)(), NO_UPDATE, 'a sibling with no bundle.json');
  });
  await withRoot((root) => {
    const v1 = makeVersion(root, 'v1');
    makeVersion(root, 'v2', { marker: '{"version":"v2"' }); // truncated write
    pointCurrent(root, 'v2');
    assert.deepEqual(checker(v1)(), NO_UPDATE, 'a sibling with an invalid bundle.json');
  });
});

test('installed update: a `current` that leaves <app> is no update', async () => {
  await withRoot((root) => {
    const away = tempRoot();
    try {
      const v1 = makeVersion(root, 'v1');
      makeVersion(away, 'v2'); // a COMPLETE bundle, just not inside <app>
      symlinkSync(join(away, 'v2'), join(root, CURRENT_LINK));
      assert.deepEqual(checker(v1)(), NO_UPDATE, 'another tree entirely');

      // And one level too deep inside <app>: still not a version directory.
      unlinkSync(join(root, CURRENT_LINK));
      makeVersion(join(root, 'nested'), 'v3');
      symlinkSync(join(root, 'nested', 'v3'), join(root, CURRENT_LINK));
      assert.deepEqual(checker(v1)(), NO_UPDATE, 'a nested directory');
    } finally {
      rmSync(away, { recursive: true, force: true });
    }
  });
});

test('installed update: a COMPLETE sibling bundle IS the update — the control', async () => {
  await withRoot((root) => {
    const v1 = makeVersion(root, 'v1');
    makeVersion(root, 'v2');
    pointCurrent(root, 'v2');
    assert.deepEqual(checker(v1)(), { available: true, reason: UPDATE_NEW_VERSION_INSTALLED });
  });
});

test('installed update: nothing is reported before this process listens', async () => {
  await withRoot((root) => {
    const v1 = makeVersion(root, 'v1');
    makeVersion(root, 'v2');
    pointCurrent(root, 'v2');
    assert.deepEqual(checker(v1, { startedAt: () => '' })(), NO_UPDATE);
  });
});

test('installed update: the answer is cached for 5 s, on an injected clock', async () => {
  await withRoot((root) => {
    const v1 = makeVersion(root, 'v1');
    makeVersion(root, 'v2');
    pointCurrent(root, 'v1');
    let clock = 1_000_000;
    const check = checker(v1, { now: () => clock });
    assert.deepEqual(check(), NO_UPDATE);

    pointCurrent(root, 'v2'); // The installer flips the link.
    assert.deepEqual(check(), NO_UPDATE, 'still the cached answer');
    clock += 4_999;
    assert.deepEqual(check(), NO_UPDATE, 'still inside the window');
    clock += 1;
    assert.deepEqual(check(), { available: true, reason: UPDATE_NEW_VERSION_INSTALLED });

    pointCurrent(root, 'v1'); // And back — the cache works both ways.
    assert.deepEqual(check(), { available: true, reason: UPDATE_NEW_VERSION_INSTALLED });
    clock += 5_000;
    assert.deepEqual(check(), NO_UPDATE);
  });
});

test('a tree WITHOUT a bundle never yields `a new version is installed` — the dev checker cannot produce it', async () => {
  await withRoot((root) => {
    // A developer clone that even has a `current` symlink beside it still runs
    // the six mtime/commit checks, and none of them can say this.
    mkdirSync(join(root, 'clone', 'web', 'dist'), { recursive: true });
    mkdirSync(join(root, 'clone', 'node_modules'), { recursive: true });
    symlinkSync(join(root, 'elsewhere'), join(root, CURRENT_LINK));
    const repoRoot = join(root, 'clone');
    const check = createUpdateChecker({
      repoRoot,
      serverDir: join(repoRoot, 'server'),
      sharedDir: join(repoRoot, 'shared'),
      webDistDir: join(repoRoot, 'web', 'dist'),
      bootCommit: null,
      bootAsset: () => null,
      startedAt: () => STARTED,
    });
    const result = check();
    assert.notEqual(result.reason, UPDATE_NEW_VERSION_INSTALLED);
    assert.equal(readBundleInfo(repoRoot), null, 'and it is not installed mode either');
  });
});

// ---------------------------------------------------------------------------
// resolveInstalledTarget
// ---------------------------------------------------------------------------

/** Assert the call refuses with the EXISTING 422 copy — no new UI sentence. */
function assertRefused(appDir: string, what: string): RestartRefusal {
  let caught: unknown;
  try {
    resolveInstalledTarget(appDir);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof RestartRefusal, `${what}: must throw a RestartRefusal, got ${String(caught)}`);
  assert.equal(caught.refusal, REFUSED_STANDBY, `${what}: reuses the standby refusal copy`);
  return caught;
}

test('resolveInstalledTarget: the happy path names the target bundle, its own node and its entry', async () => {
  await withRoot((root) => {
    const v1 = makeVersion(root, 'v1');
    const v2 = makeVersion(root, 'v2');
    pointCurrent(root, 'v2');
    assert.deepEqual(resolveInstalledTarget(v1), {
      version: 'v2',
      dir: v2,
      execPath: join(v2, 'node', 'bin', 'node'),
      entry: join(v2, 'server', 'index.ts'),
      cwd: v2,
    });
  });
});

test('resolveInstalledTarget: restarting IN PLACE (current -> this very version) is legal', async () => {
  await withRoot((root) => {
    const v1 = makeVersion(root, 'v1');
    pointCurrent(root, 'v1');
    const target = resolveInstalledTarget(v1);
    assert.equal(target.dir, v1);
    assert.equal(target.version, 'v1');
  });
});

test('resolveInstalledTarget: CONTAINMENT — a `current` that leaves <app> is refused', async () => {
  // What `current` resolves to gets SPAWNED. A symlink is user-writable, so a
  // target outside the install directory is not an upgrade.
  await withRoot(async (root) => {
    const v1 = makeVersion(root, 'v1');
    await withRoot((elsewhere) => {
      const outside = makeVersion(elsewhere, 'v2'); // A perfectly valid bundle…
      symlinkSync(outside, join(root, CURRENT_LINK)); // …in another tree.
      const err = assertRefused(v1, 'a target in another tree');
      assert.match(err.message, /not a version directory inside/);
    });
  });

  await withRoot((root) => {
    const v1 = makeVersion(root, 'v1');
    symlinkSync(root, join(root, CURRENT_LINK)); // <app> itself, i.e. `..`
    assertRefused(v1, 'a target that is the app directory itself');
  });

  await withRoot((root) => {
    const v1 = makeVersion(root, 'v1');
    mkdirSync(join(root, 'v2', 'nested'), { recursive: true });
    makeVersion(join(root, 'v2'), 'nested');
    symlinkSync(join(root, 'v2', 'nested'), join(root, CURRENT_LINK)); // two levels down
    assertRefused(v1, 'a target that is not a DIRECT child');
  });
});

test('resolveInstalledTarget: `current` is followed to the END of a symlink chain', async () => {
  // The installer flips ONE symlink, but nothing stops `current` from pointing
  // at another link (a hand-made alias, a `latest` link, an install restored by
  // a tool that rewrites links). Resolution has to be realpath, not one
  // readlink hop: the DIRECT-CHILD containment check compares against the real
  // parent, and a half-resolved path would either be refused for the wrong
  // reason or — worse — accepted while naming a directory that is not the one
  // that gets spawned.
  await withRoot((root) => {
    const v1 = makeVersion(root, 'v1');
    const v2 = makeVersion(root, 'v2');
    symlinkSync(join(root, 'v2'), join(root, 'alias')); // link -> dir
    symlinkSync(join(root, 'alias'), join(root, CURRENT_LINK)); // link -> link -> dir
    const target = resolveInstalledTarget(v1);
    assert.equal(target.dir, v2, 'the REAL version dir, never the alias it was reached through');
    assert.equal(target.cwd, v2);
    assert.equal(target.execPath, join(v2, 'node', 'bin', 'node'));
    assert.equal(target.entry, join(v2, 'server', 'index.ts'));
    assert.equal(target.version, 'v2');
  });
});

test('resolveInstalledTarget: the version dir NAME is not the version — bundle.json is', async () => {
  // Nothing gates the directory name (the installer picks it; a user can rename
  // it). The version that reaches the log and GET /api/runtime must therefore
  // come from the charset-gated marker, never from the path.
  await withRoot((root) => {
    const v1 = makeVersion(root, 'v1');
    makeVersion(root, 'unpacked', { marker: JSON.stringify({ ...GOOD, version: 'v9.9.9-rc.1' }) });
    pointCurrent(root, 'unpacked');
    const target = resolveInstalledTarget(v1);
    assert.equal(target.version, 'v9.9.9-rc.1', "bundle.json's version, not basename(dir)");
    assert.equal(target.dir, join(root, 'unpacked'), 'and the directory is still the one on disk');
  });
});

test('resolveInstalledTarget: the APP dir is resolved too — a version dir reached through a link', async () => {
  // `<app>/current/server/index.ts` is what the launcher starts, and node
  // realpaths its own entry, so repoRoot is normally physical already. It is
  // not guaranteed to be: the containment check compares two paths, and taking
  // the given one at face value would compute `<app>` from a path that never
  // existed. Here the lexical parent (`<root>/nested`) is not the real one
  // (`<root>`), so only a resolved appDir finds `<root>/current` at all.
  await withRoot((root) => {
    const v1 = makeVersion(root, 'v1');
    const v2 = makeVersion(root, 'v2');
    mkdirSync(join(root, 'nested'));
    symlinkSync(v1, join(root, 'nested', 'running'));
    pointCurrent(root, 'v2');
    assert.equal(resolveInstalledTarget(join(root, 'nested', 'running')).dir, v2);

    // …and the same for the update checker: `current` pointing at the very
    // directory this process runs from is NO update, however that directory was
    // addressed. Comparing the unresolved path would nag forever.
    pointCurrent(root, 'v1');
    assert.deepEqual(checker(join(root, 'nested', 'running'))(), NO_UPDATE);
  });
});

test('installed update: a symlink CHAIN at `current` is resolved to the end, in place and away', async () => {
  await withRoot((root) => {
    const v1 = makeVersion(root, 'v1');
    makeVersion(root, 'v2');
    symlinkSync(join(root, 'v1'), join(root, 'alias'));
    symlinkSync(join(root, 'alias'), join(root, CURRENT_LINK));
    assert.deepEqual(checker(v1)(), NO_UPDATE, 'chain ending at THIS version is not an update');

    // Repoint only the middle link: the visible `current` never changes, so a
    // check that compared link targets instead of realpaths would see nothing.
    unlinkSync(join(root, 'alias'));
    symlinkSync(join(root, 'v2'), join(root, 'alias'));
    assert.deepEqual(checker(v1)(), { available: true, reason: UPDATE_NEW_VERSION_INSTALLED });
  });
});

test('resolveInstalledTarget: an absent or dangling `current` is refused', async () => {
  await withRoot((root) => {
    const v1 = makeVersion(root, 'v1');
    assertRefused(v1, 'no current at all');
    symlinkSync(join(root, 'v9'), join(root, CURRENT_LINK));
    assertRefused(v1, 'a dangling current');
  });
});

test('resolveInstalledTarget: an INCOMPLETE target bundle is refused, one missing piece at a time', async () => {
  const cases: { what: string; opts: VersionOpts; match: RegExp }[] = [
    { what: 'no bundle.json', opts: { noMarker: true }, match: /bundle\.json is missing or is not a valid/ },
    {
      what: 'a corrupt bundle.json',
      opts: { marker: '{"version":"v1;rm -rf","platform":"linux-x64"}' },
      match: /bundle\.json is missing or is not a valid/,
    },
    { what: 'no server/index.ts', opts: { noEntry: true }, match: /server\/index\.ts is missing/ },
    { what: 'no node binary', opts: { noNode: true }, match: /node\/bin\/node is missing or not executable/ },
    {
      what: 'a node binary without the execute bit',
      opts: { nodeNotExecutable: true },
      match: /node\/bin\/node is missing or not executable/,
    },
    { what: 'no entry bundle in web/dist', opts: { noWebAsset: true }, match: /is not a frontend build/ },
    { what: 'no index.html in web/dist', opts: { noWebIndex: true }, match: /is not a frontend build/ },
  ];
  for (const { what, opts, match } of cases) {
    await withRoot((root) => {
      const v1 = makeVersion(root, 'v1');
      makeVersion(root, 'v2', opts);
      pointCurrent(root, 'v2');
      const err = assertRefused(v1, what);
      assert.match(err.message, match, what);
    });
  }
});

test('resolveInstalledTarget: an unreadable app directory refuses instead of throwing something else', async () => {
  await withRoot((root) => {
    const v1 = makeVersion(root, 'v1');
    makeVersion(root, 'v2');
    pointCurrent(root, 'v2');
    chmodSync(root, 0o000);
    try {
      assertRefused(v1, 'an unreadable app dir');
    } finally {
      chmodSync(root, 0o755);
    }
  });
});

test('the fixtures leave nothing behind in the repo', () => {
  // Paranoia with teeth: every test above builds under os.tmpdir(), and a
  // regression that wrote into the checkout would be invisible otherwise.
  for (const name of [BUNDLE_FILE, CURRENT_LINK]) {
    assert.equal(readBundleInfo(join(projectRoot, name)), null);
  }
  rmSync(join(tmpdir(), 'ai-sm-bundle-does-not-exist'), { recursive: true, force: true });
});
