/**
 * The GitHub Actions workflows (`.github/workflows/{verify,ci,release}.yml`)
 * as TEXT.
 *
 * Why text and not a YAML parse: what has to hold here is not the shape of the
 * document, it is the release doctrine — every action pinned to a commit SHA,
 * no `${{ }}` inside a `run:` block, `permissions: {}` by default, one
 * definition of the Node version per file, a publish that only ever happens on
 * a `v*` tag. Those are properties of the source, and a YAML round-trip would
 * throw away exactly the comments and the `${{ ... }}` spellings that carry
 * them. Same idiom as tests/release-script.test.ts and
 * tests/installer-script.test.ts: read the file the runner reads, assert on it.
 *
 * Nothing here runs a workflow. What only a real CI run can prove is listed at
 * the bottom of this file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './helpers.ts';

const WORKFLOWS = join(projectRoot, '.github', 'workflows');

const read = (name: string): string => readFileSync(join(WORKFLOWS, name), 'utf8');

const verifyYml = read('verify.yml');
const ciYml = read('ci.yml');
const releaseYml = read('release.yml');

const ALL: ReadonlyArray<readonly [string, string]> = [
  ['verify.yml', verifyYml],
  ['ci.yml', ciYml],
  ['release.yml', releaseYml],
];

/**
 * Every `run:` body in a workflow, as text.
 *
 * Both spellings are collected: an inline `run: npm ci` and a block
 * `run: |` followed by lines indented deeper than the `run:` key itself. That
 * indentation rule is what YAML uses to end the block, so it is enough here
 * without a parser.
 */
function runBlocks(source: string): string[] {
  const lines = source.split('\n');
  const blocks: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const indent = m[1]!.length + (lines[i]!.includes('- run:') ? 2 : 0);
    const rest = m[2]!.trim();
    if (rest !== '' && rest !== '|' && rest !== '|-' && rest !== '>' && rest !== '>-') {
      blocks.push(rest);
      continue;
    }
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() === '') {
        body.push('');
        continue;
      }
      const lead = line.length - line.trimStart().length;
      if (lead <= indent) break;
      body.push(line);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

test('runBlocks finds both spellings and stops at the next key', () => {
  const sample = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - name: one',
    '        run: npm ci',
    '      - name: two',
    '        run: |',
    '          line one',
    '          line two',
    '      - name: three',
    '        uses: some/action@sha',
  ].join('\n');
  assert.deepEqual(runBlocks(sample), ['npm ci', '          line one\n          line two']);
});

test('every workflow has at least one run block (the extractor is not vacuous)', () => {
  for (const [name, source] of ALL) {
    if (name === 'ci.yml') continue; // ci.yml only calls the reusable workflow
    assert.ok(runBlocks(source).length > 0, `${name} has no run: block`);
  }
});

/**
 * The text of one top-level job, from `  <name>:` to the next job at the same
 * indentation.
 */
function jobBlock(source: string, job: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l === `  ${job}:`);
  assert.ok(start >= 0, `no job named ${job}`);
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^  \S/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

// --- the doctrine ----------------------------------------------------------

test('every `uses:` is pinned to a 40-character commit SHA', () => {
  const seen: string[] = [];
  for (const [name, source] of ALL) {
    for (const line of source.split('\n')) {
      const m = /^\s*uses:\s*(\S+)\s*(?:#.*)?$/.exec(line);
      if (!m) continue;
      const ref = m[1]!;
      seen.push(`${name}: ${ref}`);
      if (ref.startsWith('./')) continue; // a local reusable workflow, not a marketplace action
      assert.match(
        ref,
        /^[^@\s]+@[0-9a-f]{40}$/,
        `${name}: "${ref}" is not pinned to a commit SHA`,
      );
    }
  }
  // Guards the guard: if `uses:` ever moves to another spelling this test must
  // not silently pass over an empty list.
  assert.ok(seen.length >= 8, `expected several pinned actions, found ${seen.length}`);
});

test('no `${{ ... }}` expression is interpolated inside a run: block', () => {
  for (const [name, source] of ALL) {
    for (const block of runBlocks(source)) {
      assert.ok(
        !block.includes('${{'),
        `${name}: a run: block interpolates an expression — pass it through env: instead:\n${block}`,
      );
    }
  }
});

test('every workflow defaults to no permissions', () => {
  for (const [name, source] of ALL) {
    assert.match(source, /^permissions: \{\}$/m, `${name} has no top-level permissions: {}`);
  }
});

test('only the publish job asks for write access', () => {
  const writers = releaseYml.split('\n').filter((l) => /contents:\s*write/.test(l));
  assert.equal(writers.length, 1, 'exactly one job may ask for contents: write');
});

/**
 * The text of every step in a workflow: the `- ` line that opens it plus every
 * line indented deeper than that dash. Same indentation rule as runBlocks().
 */
function steps(source: string): string[] {
  const lines = source.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)- \S/.exec(lines[i]!);
    if (!m) continue;
    const indent = m[1]!.length;
    const body = [lines[i]!];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() === '') {
        body.push('');
        continue;
      }
      const lead = line.length - line.trimStart().length;
      if (lead <= indent) break;
      body.push(line);
    }
    out.push(body.join('\n'));
  }
  return out;
}

test('steps() cuts a step at the next dash at the same indentation', () => {
  const sample = [
    '    steps:',
    '      - name: one',
    '        uses: a/b@sha',
    '        with:',
    '          k: v',
    '      - name: two',
    '        run: echo hi',
  ].join('\n');
  assert.deepEqual(steps(sample), [
    '      - name: one\n        uses: a/b@sha\n        with:\n          k: v',
    '      - name: two\n        run: echo hi',
  ]);
});

/*
 * Mutation-audit finding (2026-09-09, test-engineer): deleting a
 * `persist-credentials: false` from any checkout left the suite green. It is
 * doctrine, not decoration -- without it actions/checkout leaves the job's
 * GITHUB_TOKEN in .git/config, where `npm ci` dependency lifecycle scripts and
 * the bundle/host build scripts run right after it can read and use it.
 */
test('every actions/checkout step disables credential persistence', () => {
  let checkouts = 0;
  for (const [name, source] of ALL) {
    const expected = (source.match(/uses: actions\/checkout@/g) ?? []).length;
    const found = steps(source).filter((s) => s.includes('uses: actions/checkout@'));
    assert.equal(
      found.length,
      expected,
      `${name}: steps() found ${found.length} checkout steps for ${expected} checkout uses`,
    );
    for (const step of found) {
      checkouts++;
      assert.match(
        step,
        /^\s*persist-credentials: false$/m,
        `${name}: this checkout keeps the job token in .git/config:\n${step}`,
      );
    }
  }
  // Guards the guard: an extractor that finds nothing must not pass.
  assert.ok(checkouts >= 4, `expected several checkout steps, found ${checkouts}`);
});

// --- the version, defined once per file ------------------------------------

/** The `NODE_VERSION: '<v>'` definition — there must be exactly one per file. */
function nodeVersionOf(source: string, name: string): string {
  const defs = [...source.matchAll(/^\s*NODE_VERSION:\s*'([^']+)'\s*$/gm)];
  assert.equal(defs.length, 1, `${name} must define NODE_VERSION exactly once, found ${defs.length}`);
  return defs[0]![1]!;
}

test('NODE_VERSION is defined once per file and the two files agree', () => {
  const inVerify = nodeVersionOf(verifyYml, 'verify.yml');
  const inRelease = nodeVersionOf(releaseYml, 'release.yml');
  assert.match(inVerify, /^24\.\d+\.\d+$/, 'the bundled runtime is an exact Node 24 patch version');
  assert.equal(
    inVerify,
    inRelease,
    'verify.yml and release.yml must bundle and test the same Node runtime',
  );
});

test('the Node version reaches setup-node and build-bundle.sh from that one definition', () => {
  for (const [name, source] of [
    ['verify.yml', verifyYml],
    ['release.yml', releaseYml],
  ] as const) {
    // No setup-node step may hardcode a version.
    const hardcoded = [...source.matchAll(/^\s*node-version:\s*(.+)$/gm)].map((m) => m[1]!.trim());
    assert.ok(hardcoded.length > 0, `${name} has no setup-node version at all`);
    for (const value of hardcoded) {
      assert.equal(
        value,
        '${{ env.NODE_VERSION }}',
        `${name}: node-version must come from the workflow env, got ${value}`,
      );
    }
    // ...and the bundle is built with the very same runtime.
    assert.ok(
      source.includes('--node "$NODE_VERSION"'),
      `${name}: build-bundle.sh must be given --node "$NODE_VERSION"`,
    );
  }
});

test('verify.yml caches the Node runtime download, keyed by that version', () => {
  assert.match(
    verifyYml,
    /uses: actions\/cache@[0-9a-f]{40}[^\n]*\n\s*with:\n\s*path: build\/node-cache\n\s*key: node-dist-linux-x64-\$\{\{ env\.NODE_VERSION \}\}/,
    'the cache step must key build/node-cache on NODE_VERSION',
  );
});

// --- the job graph ---------------------------------------------------------

test('the publish job waits for all four build jobs', () => {
  assert.match(releaseYml, /^\s*needs: \[verify, host, bundle, installer\]$/m);
});

test('the installer job waits for the two binaries it packages', () => {
  assert.match(releaseYml, /^\s*needs: \[host, bundle\]$/m);
});

test('both bundle jobs run on ubuntu-22.04 — the glibc floor of the bundle', () => {
  for (const [name, source] of [
    ['verify.yml', verifyYml],
    ['release.yml', releaseYml],
  ] as const) {
    assert.match(
      jobBlock(source, 'bundle'),
      /^\s*runs-on: ubuntu-22\.04$/m,
      `${name}: the bundle job must build on 22.04`,
    );
  }
});

test('the smoke test is on in both bundle builds (no --skip-smoke on the command)', () => {
  for (const [name, source] of [
    ['verify.yml', verifyYml],
    ['release.yml', releaseYml],
  ] as const) {
    const builds = runBlocks(source).filter((b) => b.includes('scripts/build-bundle.sh'));
    assert.equal(builds.length, 1, `${name} must build the bundle exactly once`);
    assert.ok(
      !builds[0]!.includes('--skip-smoke'),
      `${name}: the bundle must be booted before it ships`,
    );
  }
});

// --- the installer job -----------------------------------------------------

test('the installer job fails loudly when ISCC.exe is absent', () => {
  assert.ok(
    releaseYml.includes(
      "$iscc = 'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe'",
    ),
    'the ISCC path must be the documented one',
  );
  assert.match(
    releaseYml,
    /if \(-not \(Test-Path -LiteralPath \$iscc -PathType Leaf\)\) \{(?:.|\n)*?exit 1\n/,
    'a missing ISCC.exe must end the job with exit 1, not a silent skip',
  );
});

test('ISCC is invoked with exactly the three defines installer/README.md documents', () => {
  assert.ok(releaseYml.includes('"/DAppVersion=$version"'));
  assert.ok(releaseYml.includes("'/DBundleTar=payload\\ai-session-manager-linux-x64.tar.gz'"));
  assert.ok(releaseYml.includes("'/DHostDir=payload\\host'"));
  assert.ok(releaseYml.includes("'installer\\ai-session-manager.iss'"));
});

test('the payload layout matches what the .iss expects', () => {
  // The bundle artifact lands directly in installer/payload, the host files
  // flat in installer/payload/host.
  assert.match(releaseYml, /name: ai-session-manager-linux-x64\n\s*path: installer\/payload$/m);
  assert.match(releaseYml, /name: AiSessionManagerHost-win-x64\n\s*path: installer\/payload\/hostzip$/m);
  const iss = readFileSync(join(projectRoot, 'installer', 'ai-session-manager.iss'), 'utf8');
  assert.ok(iss.includes('#define BundleTar "payload\\ai-session-manager-linux-x64.tar.gz"'));
  assert.ok(iss.includes('#define HostDir "payload\\host"'));
});

// --- the published assets --------------------------------------------------

test('the release publishes exactly the four documented assets', () => {
  for (const asset of [
    '"$SETUP_NAME"',
    'ai-session-manager-linux-x64.tar.gz',
    'AiSessionManagerHost-win-x64.zip',
    'SHA256SUMS.txt',
  ]) {
    assert.ok(releaseYml.includes(asset), `the publish step never names ${asset}`);
  }
  assert.ok(releaseYml.includes('AI-Session-Manager-Setup-$version.exe'), 'the Setup filename');
});

test('one SHA256SUMS.txt is rehashed from the downloaded files and verified', () => {
  assert.match(
    releaseYml,
    /sha256sum "\$SETUP_NAME" \\\n\s*ai-session-manager-linux-x64\.tar\.gz \\\n\s*AiSessionManagerHost-win-x64\.zip > SHA256SUMS\.txt/,
  );
  // The four files inside the host zip keep their lines.
  for (const n of [
    'AiSessionManagerHost.exe',
    'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll',
    'WebView2Loader.dll',
  ]) {
    assert.ok(releaseYml.includes(n), `SHA256SUMS.txt must still list ${n}`);
  }
  assert.ok(releaseYml.includes('sha256sum -c --ignore-missing SHA256SUMS.txt'));
});

test('the release notes lead with the Setup, then the bundle, then the host zip', () => {
  const start = releaseYml.indexOf('cat > notes.md <<EOF');
  assert.ok(start > 0, 'the publish step writes notes.md from a heredoc');
  const end = releaseYml.indexOf('\n          EOF\n', start);
  assert.ok(end > start, 'the heredoc is terminated');
  const notes = releaseYml.slice(start, end);
  const setup = notes.indexOf('$SETUP_NAME\\` is the app');
  const tarball = notes.indexOf('ai-session-manager-linux-x64.tar.gz');
  const zip = notes.indexOf('AiSessionManagerHost-win-x64.zip');
  assert.ok(setup > 0, 'the notes must open with the Setup being the app');
  assert.ok(setup < tarball && tarball < zip, 'Setup, then bundle, then host zip');
  // The prerequisites a user has to satisfy before downloading.
  assert.ok(notes.includes('WSL2'));
  assert.ok(notes.includes('2.35'));
  assert.ok(notes.includes('administrator rights'));
  assert.ok(notes.includes('installs nothing third-party without asking'));
  // The unsigned paragraph covers BOTH exes and carries the Setup's hash.
  assert.ok(notes.includes('Neither executable is code-signed'));
  assert.ok(notes.includes('$SETUP_SHA  $SETUP_NAME'));
});

// --- publishing is gated on the ref, not on the trigger --------------------

test('workflow_dispatch builds everything and publishes nothing', () => {
  assert.match(releaseYml, /^on:\n\s*push:\n\s*tags: \['v\*'\]\n\s*workflow_dispatch:$/m);
  // Scoped to the publish job on purpose: this is the gate, and only what is
  // inside the one job that can write to the repo decides whether a dispatch
  // publishes. A step-level `if:` on a build job (a conditional upload, a
  // platform guard) is not this gate and must not read as it having moved.
  const releaseJob = jobBlock(releaseYml, 'release');
  const ifs = [...releaseJob.matchAll(/^\s*if: (.+)$/gm)].map((m) => m[1]!.trim());
  assert.deepEqual(ifs, ["startsWith(github.ref, 'refs/tags/v')"]);
  // ...and it is the job's own condition, on the only job with write access
  // (`only the publish job asks for write access` pins that there is one).
  assert.match(releaseJob, /^\s*if: startsWith\(github\.ref, 'refs\/tags\/v'\)$/m);
  assert.match(releaseJob, /^\s*contents: write$/m);
});

/*
 * Mutation-audit finding (2026-09-09): deleting `--verify-tag` from the publish
 * command left the suite green. Without it `gh release create` CREATES the tag
 * from the default branch when the tag does not exist -- publishing a release
 * for a commit the verify job never saw. The two re-run flags are the same kind
 * of load-bearing detail: without them a second attempt errors on "release
 * already exists", or attaches new binaries under a body quoting the old hashes.
 */
test('the publish verifies the tag exists and a re-run stays idempotent', () => {
  const releaseJob = jobBlock(releaseYml, 'release');
  assert.match(
    releaseJob,
    /gh release create "\$TAG" \\\n\s*--verify-tag \\\n/,
    'gh release create must pass --verify-tag: without it the tag is created from the default branch',
  );
  assert.match(
    releaseJob,
    /gh release upload "\$TAG"(?:[^\n]*\n)*?[^\n]*--clobber\n/,
    'a re-run must overwrite the attached assets (--clobber), not fail on them',
  );
  assert.match(
    releaseJob,
    /gh release edit "\$TAG" --notes-file notes\.md\n/,
    'a re-run must rewrite the body so the published SHA-256 matches the re-uploaded files',
  );
});

test('a dispatch that is not a tag builds a version nobody can mistake for a release', () => {
  assert.ok(releaseYml.includes('version="0.0.0-dev+${COMMIT_SHA:0:7}"'));
  // The publish step refuses artifacts that were not built as this tag.
  assert.ok(releaseYml.includes('if [ "$TAG" != "$RELEASE_VERSION" ]; then'));
});

// --- the shell scripts the workflows call ----------------------------------

test('ci.yml still calls the reusable workflow, unchanged', () => {
  assert.match(ciYml, /uses: \.\/\.github\/workflows\/verify\.yml/);
});

/*
 * What only a real CI run can prove, and this file cannot:
 *   - that ISCC.exe is still at that path on windows-latest;
 *   - that the .iss compiles and the Setup installs;
 *   - that ubuntu-22.04 still has the toolchain node-pty needs;
 *   - that the artifacts survive the upload/download round trip;
 *   - that `gh release create --verify-tag` accepts four assets.
 */
