/**
 * `scripts/build-bundle.sh` — the builder of the self-contained Linux bundle
 * (`ai-session-manager-linux-x64.tar.gz`: a pinned Node runtime, the backend,
 * production node_modules, the built frontend, the start script).
 *
 * A full build downloads ~50 MB, compiles node-pty and boots a real server, so
 * it is run by hand and by CI — not here. What this file pins is everything the
 * script must REFUSE before it spends any of that, because each of those
 * refusals is the difference between a clear message and a broken artifact
 * shipped to users:
 *
 *   - a `--version` outside the charset the backend gates `bundle.json` on
 *     would build a bundle that silently never enters installed mode;
 *   - a missing/loose `--node` would build an unpinned runtime;
 *   - a missing `web/dist` would produce a bundle with no UI (the check runs
 *     BEFORE the download, so this costs nothing);
 *   - a Node tarball whose SHA-256 does not match nodejs.org's SHASUMS256.txt
 *     must be deleted and nothing extracted — this is the one supply-chain
 *     control in the whole pipeline, and its failure mode is invisible.
 *
 * How, without a network: the script downloads with `curl`, so
 * `AI_SM_NODE_DIST_BASE` (its documented test seam / mirror knob) points at a
 * `file://` directory holding a fake "tarball" and a SHASUMS256.txt this test
 * writes — right hash in one case, wrong in the other. Everything runs against
 * a COPY of the script in a throwaway repo skeleton, so the real repo's
 * `build/` and `dist-release/` are never touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBundleInfo } from '../server/bundle.ts';
import { projectRoot } from './helpers.ts';

const SCRIPT = join(projectRoot, 'scripts', 'build-bundle.sh');
const BASH = '/bin/bash';
/** The Node version the fake mirror pretends to serve. */
const NODE_VERSION = '24.20.0';
const TARBALL = `node-v${NODE_VERSION}-linux-x64.tar.xz`;

// --- a throwaway repo the script can be copied into -------------------------

interface FakeRepo {
  /** The repo root: `<tmp>/repo`. */
  dir: string;
  /** `<tmp>/mirror` — what AI_SM_NODE_DIST_BASE points at when used. */
  mirror: string;
  /** `<tmp>/out` — the --out directory. */
  out: string;
}

/**
 * The minimum tree `build-bundle.sh` inspects before it downloads anything:
 * package.json + lockfile, the server entry and statusline, the start script,
 * and (unless `noWebDist`) a built frontend.
 */
async function makeRepo(opts: { noWebDist?: boolean } = {}): Promise<FakeRepo> {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-bundle-'));
  const dir = join(root, 'repo');
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await copyFile(SCRIPT, join(dir, 'scripts', 'build-bundle.sh'));
  await writeFile(join(dir, 'package.json'), '{"name":"fake"}\n');
  await writeFile(join(dir, 'package-lock.json'), '{}\n');
  await mkdir(join(dir, 'server'), { recursive: true });
  await writeFile(join(dir, 'server', 'index.ts'), '');
  await writeFile(join(dir, 'server', 'statusline.mjs'), '');
  await mkdir(join(dir, 'launcher'), { recursive: true });
  await writeFile(join(dir, 'launcher', 'start-backend.sh'), '');
  if (opts.noWebDist !== true) {
    await mkdir(join(dir, 'web', 'dist'), { recursive: true });
    await writeFile(join(dir, 'web', 'dist', 'index.html'), '<!doctype html>');
    await writeFile(join(dir, 'web', 'dist', 'build-id.json'), '{"id":"x"}');
  }
  return { dir, mirror: join(root, 'mirror'), out: join(root, 'out') };
}

/**
 * A `file://` stand-in for nodejs.org/dist: `<mirror>/v<version>/` holding the
 * tarball and a SHASUMS256.txt in sha256sum format. `goodSum` decides whether
 * the listed hash is the file's real one.
 */
async function makeMirror(repo: FakeRepo, opts: { goodSum: boolean }): Promise<void> {
  const dir = join(repo.mirror, `v${NODE_VERSION}`);
  await mkdir(dir, { recursive: true });
  const body = 'not really a node tarball\n';
  await writeFile(join(dir, TARBALL), body);
  const real = createHash('sha256').update(body).digest('hex');
  const listed = opts.goodSum ? real : `${'0'.repeat(63)}1`;
  // Two entries, like the real file: --ignore-missing must skip the one that is
  // not here and still check the one that is.
  await writeFile(
    join(dir, 'SHASUMS256.txt'),
    `${'a'.repeat(64)}  node-v${NODE_VERSION}-darwin-arm64.tar.gz\n${listed}  ${TARBALL}\n`,
  );
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout + stderr — refusals go to stderr, progress to stdout. */
  out: string;
}

function runBuild(
  repo: FakeRepo,
  args: string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(BASH, [join(repo.dir, 'scripts', 'build-bundle.sh'), ...args], {
      // A temp cwd: the script must find its own repo from its own location.
      cwd: repo.dir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ code, stdout, stderr, out: `${stdout}${stderr}` }),
    );
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Nothing was downloaded and nothing was staged. */
async function assertNothingBuilt(repo: FakeRepo): Promise<void> {
  assert.equal(await exists(join(repo.dir, 'build')), false, 'build/ was created');
  assert.equal(await exists(repo.out), false, 'the output dir was created');
}

// --- 1. the version -----------------------------------------------------------

test('build-bundle: refuses a version outside the charset the backend accepts', async () => {
  const repo = await makeRepo();
  try {
    const bad = [
      'v1.2.3 rc1', // space
      'v1.2.3;rm -rf /', // shell metacharacters
      'release/v1.2.3', // path separator: it names a DIRECTORY inside the tarball
      '../evil',
      // A version is a DIRECTORY NAME under build/bundle (`rm -rf "$STAGE"`)
      // and a tar member argument, so these four are the dangerous ones:
      '..', // rm -rf build/bundle/.. would wipe build/, node cache included
      '.', // and pack build/bundle itself
      '-h', // reaches tar as an option, not a member
      '--remove-files', // ditto, and this one deletes what it packs
      'v1.2.3\n', // trailing newline
      'x'.repeat(65), // longer than 64
      '', // empty
    ];
    for (const version of bad) {
      const r = await runBuild(repo, ['--version', version, '--node', NODE_VERSION]);
      assert.notEqual(r.code, 0, `${JSON.stringify(version)} should be refused`);
      assert.match(
        r.stderr,
        /(is not a usable bundle version|Missing --version)/,
        JSON.stringify(version),
      );
      await assertNothingBuilt(repo);
    }

    // …and accepts the two shapes the release actually uses (they get past the
    // version gate and fail later, on the mirror that is not there).
    for (const version of ['v0.2.0', '0.0.0-dev+abc1234']) {
      const r = await runBuild(repo, ['--version', version, '--node', NODE_VERSION], {
        AI_SM_NODE_DIST_BASE: `file://${repo.mirror}`,
      });
      assert.notEqual(r.code, 0);
      assert.doesNotMatch(r.stderr, /is not a usable bundle version/, version);
      assert.match(r.stderr, /Download failed/, version);
    }
  } finally {
    await rm(join(repo.dir, '..'), { recursive: true, force: true });
  }
});

test('build-bundle: the download base is allow-listed — a foreign mirror is refused before any network access', async () => {
  // AI_SM_NODE_DIST_BASE retargets the tarball AND SHASUMS256.txt together, so
  // a remote override does not weaken the checksum gate, it replaces it with
  // "the mirror agrees with itself" — while the release claims verification
  // against nodejs.org. Same treatment as the loopback-only
  // AI_SM_GITHUB_API_BASE: file:// or nodejs.org, nothing else.
  const repo = await makeRepo();
  try {
    for (const base of [
      'https://evil.example/dist', // cannot resolve: the refusal must come FIRST
      'https://nodejs.org.evil.example/dist',
      'https://nodejs.org/dist/../elsewhere',
      'http://nodejs.org/dist', // plaintext
      'https://nodejs.org', // not the dist path
      'ftp://nodejs.org/dist',
      '/srv/mirror', // a bare path is not a base curl would fetch from
    ]) {
      const r = await runBuild(repo, ['--version', 'v0.2.0', '--node', NODE_VERSION], {
        AI_SM_NODE_DIST_BASE: base,
      });
      assert.notEqual(r.code, 0, base);
      assert.match(r.stderr, /AI_SM_NODE_DIST_BASE=.* is refused/, base);
      // The refusal, not a network error: nothing was fetched, nothing cached.
      assert.doesNotMatch(r.stderr, /Download failed/, base);
      assert.equal(await exists(join(repo.dir, 'build')), false, `build/ was created for ${base}`);
    }

    // The two allowed bases get PAST the gate (both then fail later — the
    // file:// mirror is not there, nodejs.org is not reachable from the test).
    for (const base of [`file://${repo.mirror}`, `file://${repo.mirror}/`]) {
      const r = await runBuild(repo, ['--version', 'v0.2.0', '--node', NODE_VERSION], {
        AI_SM_NODE_DIST_BASE: base,
      });
      assert.doesNotMatch(r.stderr, /is refused/, base);
      assert.match(r.stderr, /Download failed/, base);
    }
  } finally {
    await rm(join(repo.dir, '..'), { recursive: true, force: true });
  }
});

// --- 2. the Node pin ----------------------------------------------------------

test('build-bundle: --node is required and must be an exact 24.x.y', async () => {
  const repo = await makeRepo();
  try {
    const missing = await runBuild(repo, ['--version', 'v0.2.0']);
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /Missing --node/);
    await assertNothingBuilt(repo);

    for (const bad of ['24.20', 'v24.20.0', '24', 'latest', '22.11.0', '24.20.0.1']) {
      const r = await runBuild(repo, ['--version', 'v0.2.0', '--node', bad]);
      assert.notEqual(r.code, 0, bad);
      assert.match(r.stderr, /is not an exact Node 24 version/, bad);
      await assertNothingBuilt(repo);
    }
  } finally {
    await rm(join(repo.dir, '..'), { recursive: true, force: true });
  }
});

// --- 3. the frontend build ----------------------------------------------------

test('build-bundle: a missing web/dist is refused before anything is downloaded', async () => {
  const repo = await makeRepo({ noWebDist: true });
  try {
    const r = await runBuild(repo, ['--version', 'v0.2.0', '--node', NODE_VERSION], {
      AI_SM_NODE_DIST_BASE: `file://${repo.mirror}`,
    });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /The frontend build is missing/);
    // The actionable half of the message — without it the user is told a path
    // and left to guess which command produces it.
    assert.match(r.stderr, /run npm run build first/);
    await assertNothingBuilt(repo);
  } finally {
    await rm(join(repo.dir, '..'), { recursive: true, force: true });
  }
});

// --- 4. the checksum gate -----------------------------------------------------

test('build-bundle: a Node tarball that fails SHA-256 is deleted and nothing is extracted', async () => {
  const repo = await makeRepo();
  await makeMirror(repo, { goodSum: false });
  try {
    const r = await runBuild(repo, ['--version', 'v0.2.0', '--node', NODE_VERSION], {
      AI_SM_NODE_DIST_BASE: `file://${repo.mirror}`,
    });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Checksum mismatch/);
    assert.match(r.stderr, /deleted/);

    // The bad download must not survive in the cache: the next run would find
    // it "cached" and, if the check ever regressed, use it.
    assert.equal(
      await exists(join(repo.dir, 'build', 'node-cache', `v${NODE_VERSION}`, TARBALL)),
      false,
      'the mismatching tarball is still cached',
    );
    // And nothing was staged or packed from it.
    assert.equal(await exists(join(repo.dir, 'build', 'bundle')), false);
    assert.equal(await exists(repo.out), false);
  } finally {
    await rm(join(repo.dir, '..'), { recursive: true, force: true });
  }
});

test('build-bundle: a MATCHING checksum passes the gate (and only then extracts)', async () => {
  // The control for the test above: a checksum failure has to mean the hash was
  // wrong, not that the check refuses everything. With a correct sum the script
  // gets past verification and dies at the extraction of what is, after all,
  // not a real tarball.
  const repo = await makeRepo();
  await makeMirror(repo, { goodSum: true });
  try {
    const r = await runBuild(repo, ['--version', 'v0.2.0', '--node', NODE_VERSION], {
      AI_SM_NODE_DIST_BASE: `file://${repo.mirror}`,
    });
    assert.notEqual(r.code, 0);
    assert.doesNotMatch(r.stderr, /Checksum mismatch/);
    assert.match(r.stdout, /SHA-256 verified/);
    assert.match(r.stderr, /Could not extract/);
    // A verified download stays cached — that is the point of the cache.
    assert.equal(
      await exists(join(repo.dir, 'build', 'node-cache', `v${NODE_VERSION}`, TARBALL)),
      true,
    );
  } finally {
    await rm(join(repo.dir, '..'), { recursive: true, force: true });
  }
});

// --- 5. the argument surface --------------------------------------------------

test('build-bundle: --help prints the usage and builds nothing', async () => {
  const repo = await makeRepo();
  try {
    for (const flag of ['-h', '--help']) {
      const r = await runBuild(repo, [flag]);
      assert.equal(r.code, 0, r.out);
      assert.match(r.stdout, /usage: scripts\/build-bundle\.sh --version/);
      await assertNothingBuilt(repo);
    }
  } finally {
    await rm(join(repo.dir, '..'), { recursive: true, force: true });
  }
});

test('build-bundle: the bundle.json it writes is one the BACKEND accepts', async () => {
  // Two independent gates gate the same file: this script's, in bash, and
  // `readBundleInfo`'s, in TypeScript. Nothing links them — and drift is
  // SILENT, with the worst possible symptom: a bundle that unpacks, boots and
  // then quietly runs as a DEVELOPER CLONE (no version in the banner, the six
  // mtime heuristics back on, a restart that tries to run vite in a tree that
  // has none).
  //
  // So this runs the script's OWN two blocks — the glibc probe and the
  // bundle.json heredoc — lifted out of the file verbatim, with the variables a
  // real build would have, and hands the result to the reader that decides
  // installed mode. Lifting them by anchor means a script edit that moves them
  // fails here loudly instead of quietly un-testing this.
  const script = await readFile(SCRIPT, 'utf8');
  const cut = (from: string, to: string): string => {
    const a = script.indexOf(from);
    const b = script.indexOf(to);
    assert.ok(a >= 0 && b > a, `scripts/build-bundle.sh no longer contains ${JSON.stringify(from)} … ${JSON.stringify(to)} — this test lifts those blocks and must be updated with them`);
    return script.slice(a, b);
  };
  const glibcBlock = cut('GLIBC_LINE="$(ldd --version', '# --- 3.');
  const markerBlock = cut('COMMIT="$(git -C "$REPO"', '# --- 9.');

  const stage = await mkdtemp(join(tmpdir(), 'ai-sm-marker-'));
  try {
    const harness = [
      'set -euo pipefail',
      'die() { echo "$*" >&2; exit 1; }',
      `REPO=${JSON.stringify(projectRoot)}`,
      `STAGE=${JSON.stringify(stage)}`,
      'VERSION="v0.2.0"',
      `NODE_VERSION="${NODE_VERSION}"`,
      glibcBlock,
      markerBlock,
    ].join('\n');
    const r = await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(BASH, ['-c', harness], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr, out: `${stdout}${stderr}` }));
    });
    assert.equal(r.code, 0, r.out);

    const info = readBundleInfo(stage);
    assert.ok(
      info !== null,
      `the backend must accept the marker this script writes, got: ${await readFile(join(stage, 'bundle.json'), 'utf8')}`,
    );
    assert.equal(info.version, 'v0.2.0');
    assert.equal(info.nodeVersion, `v${NODE_VERSION}`, 'the pin is written with the leading v the reader expects');
    assert.equal(info.platform, 'linux-x64');
    assert.equal(typeof info.glibcMin, 'string', 'the build machine glibc passed BOTH charset gates');
    // commit is the real repo HEAD here, or null where git cannot answer.
    assert.ok(info.commit === null || /^[0-9a-f]{7,40}$/.test(info.commit));
    assert.ok(!Number.isNaN(Date.parse(info.builtAt)), `builtAt must parse: ${info.builtAt}`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test('build-bundle: an unknown argument is refused, never treated as a value', async () => {
  const repo = await makeRepo();
  try {
    const r = await runBuild(repo, ['--version', 'v0.2.0', '--node', NODE_VERSION, '--force']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Unknown argument "--force"/);
    await assertNothingBuilt(repo);

    // …while the documented flags ARE accepted: `--skip-smoke` and `--out` must
    // get past the argument loop (they then die on the mirror that is not
    // there). A typo in either case arm would otherwise read as "unknown".
    for (const extra of [['--skip-smoke'], ['--out', join(repo.out, 'x')]]) {
      const ok = await runBuild(repo, ['--version', 'v0.2.0', '--node', NODE_VERSION, ...extra], {
        AI_SM_NODE_DIST_BASE: `file://${repo.mirror}`,
      });
      assert.doesNotMatch(ok.stderr, /Unknown argument/, extra.join(' '));
      assert.match(ok.stderr, /Download failed/, extra.join(' '));
    }
  } finally {
    await rm(join(repo.dir, '..'), { recursive: true, force: true });
  }
});

test('build-bundle: the tar call is argv-safe — a version that LOOKS like a flag is packed as a member, never parsed as one', async () => {
  // DEFENCE IN DEPTH, tested independently of the gate in front of it. The
  // `--version` charset above already refuses `--remove-files` (and `..`, `.`,
  // `-h`), so this string can never reach `tar` through the CLI today. The `--`
  // in the tar call is the SECOND gate, and a second gate that is never
  // exercised is a comment: dropping it changes nothing any other test in this
  // file can see, while the day the first gate loosens the difference is
  // `tar --remove-files` DELETING the staging tree instead of packing it.
  //
  // So the tar block is lifted out of the script verbatim (same technique, and
  // the same anchor discipline, as the bundle.json test above) and run against
  // a staging root whose one version directory is literally named
  // `--remove-files`.
  const script = await readFile(SCRIPT, 'utf8');
  const from = 'ARCHIVE="$OUT_DIR/ai-session-manager-linux-x64.tar.gz"';
  const to = '(cd "$OUT_DIR" && sha256sum';
  const a = script.indexOf(from);
  const b = script.indexOf(to);
  assert.ok(
    a >= 0 && b > a,
    `scripts/build-bundle.sh no longer contains ${JSON.stringify(from)} … ${JSON.stringify(to)} — this test lifts the tar block and must be updated with it`,
  );
  const tarBlock = script.slice(a, b);

  const root = await mkdtemp(join(tmpdir(), 'ai-sm-tar-'));
  const stageRoot = join(root, 'stage');
  const outDir = join(root, 'out');
  const version = '--remove-files';
  const staged = join(stageRoot, version, 'server', 'index.ts');
  try {
    await mkdir(join(stageRoot, version, 'server'), { recursive: true });
    await writeFile(staged, '// the file a stray --remove-files would delete\n');
    await mkdir(outDir, { recursive: true });

    const harness = [
      'set -euo pipefail',
      'die() { echo "$*" >&2; exit 1; }',
      `OUT_DIR=${JSON.stringify(outDir)}`,
      `STAGE_ROOT=${JSON.stringify(stageRoot)}`,
      `VERSION=${JSON.stringify(version)}`,
      tarBlock,
    ].join('\n');
    const r = await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(BASH, ['-c', harness], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr, out: `${stdout}${stderr}` }));
    });
    assert.equal(r.code, 0, `the tar call refused a flag-shaped member name: ${r.out}`);

    // What it packed: one top-level directory named for the "version", with the
    // staged file inside it — i.e. the string was an OPERAND.
    const archive = join(outDir, 'ai-session-manager-linux-x64.tar.gz');
    assert.equal(await exists(archive), true, 'no archive was written');
    const listed = await new Promise<RunResult>((resolve, reject) => {
      const child = spawn('tar', ['-tzf', archive], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr, out: `${stdout}${stderr}` }));
    });
    assert.equal(listed.code, 0, listed.out);
    const members = listed.stdout.split('\n').filter((l) => l !== '');
    assert.deepEqual(
      members.sort(),
      ['--remove-files/', '--remove-files/server/', '--remove-files/server/index.ts'],
      `the archive does not hold exactly the staged tree: ${listed.stdout}`,
    );

    // And the staging tree is still there: `--remove-files` was never honoured.
    assert.equal(await exists(staged), true, 'the staged file was REMOVED — tar parsed the version as an option');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
