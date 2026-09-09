/**
 * `scripts/release.sh` — the local release command (`npm run release -- vX.Y.Z`).
 *
 * Why it exists: pushing a `v*` tag publishes a GitHub Release. The workflow
 * verifies the tagged commit itself, but a tag pushed on a commit CI never
 * proved green just produces a dead tag and a red run. This script refuses to
 * create such a tag, so what has to be pinned is the REFUSALS — each one, in
 * order, with a reason the user can act on — and the fact that the two mutating
 * commands (`git tag`, `git push origin <tag>`) run only after every check
 * passed, and never under `--dry-run`.
 *
 * How: the script calls `git` and `gh` by plain name, so both are replaced with
 * tiny shell doubles on PATH (same idiom as the git double in
 * tests/github-clone-success.test.ts). Every double appends its own argv to
 * `calls.log` and answers from canned files the test writes, which makes
 * "nothing was tagged or pushed" an assertion over the call log rather than an
 * absence of side effects. `node` stays real — the script parses gh's JSON with
 * it — so the fake directory is PREPENDED to the inherited PATH.
 *
 * Nothing here touches the real repository: the script runs with `cwd` set to a
 * temp directory and never reaches a real `git`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { projectRoot } from './helpers.ts';

const SCRIPT = join(projectRoot, 'scripts', 'release.sh');

const SHA = '1111111111111111111111111111111111111111';
const OTHER_SHA = '2222222222222222222222222222222222222222';
const RUN_URL = 'https://github.com/you/ai-cli-application/actions/runs/42';

/**
 * A `git` double. Answers every read the script performs from a canned file and
 * exits 0 for the two mutating commands (which are only ever observed through
 * the call log).
 */
const GIT_DOUBLE = `#!/bin/sh
d="$FAKE_DIR"
{ printf 'git'; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'; } >> "$d/calls.log"

# A read that FAILS is a different answer from a read that printed nothing --
# the knobs below make that distinguishable (real git writes to stderr and exits
# non-zero; it prints nothing usable on stdout).
fail_if() {
  c="$(cat "$d/$1")"
  if [ "$c" != "0" ]; then printf 'fatal: %s\\n' "$2" >&2; exit "$c"; fi
}

sub="$1"
shift
case "$sub" in
  status)
    fail_if status-code 'not a git repository'
    cat "$d/status.out"
    ;;
  rev-parse)
    case "$1" in
      --git-dir)
        if [ -f "$d/no-repo" ]; then exit 128; fi
        printf '.git\\n'
        ;;
      --abbrev-ref) cat "$d/branch" ;;
      HEAD) cat "$d/head" ;;
      origin/main) cat "$d/origin-main" ;;
      *) exit 1 ;;
    esac
    ;;
  fetch)
    exit "$(cat "$d/fetch-code")"
    ;;
  tag)
    # \`tag --list <tag>\` is the read; \`tag -a <tag> -m <tag>\` is the write.
    if [ "$1" = "--list" ]; then
      fail_if tag-list-code 'cannot read refs'
      cat "$d/tag-list"
    fi
    ;;
  ls-remote)
    fail_if ls-remote-code 'could not read from remote repository'
    cat "$d/ls-remote"
    ;;
  push)
    ;;
  *)
    ;;
esac
exit 0
`;

/** A `gh` double. Read-only by construction: it can only print. */
const GH_DOUBLE = `#!/bin/sh
d="$FAKE_DIR"
{ printf 'gh'; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'; } >> "$d/calls.log"

sub="$1"
shift
case "$sub" in
  auth)
    exit "$(cat "$d/auth-code")"
    ;;
  run)
    cat "$d/runs.json"
    ;;
  repo)
    printf 'you/ai-cli-application\\n'
    ;;
  *)
    ;;
esac
exit 0
`;

interface Canned {
  /** \`git status --porcelain\` output; non-empty = dirty tree. */
  status?: string;
  /** \`git status --porcelain\` exit code; non-zero = the read itself failed. */
  statusCode?: string;
  branch?: string;
  head?: string;
  originMain?: string;
  /** \`git fetch origin\` exit code. */
  fetchCode?: string;
  /** \`git tag --list <tag>\` output; non-empty = the tag exists locally. */
  tagList?: string;
  /** \`git tag --list <tag>\` exit code; non-zero = the read itself failed. */
  tagListCode?: string;
  /** \`git ls-remote --tags origin <ref>\` output; non-empty = it exists there. */
  lsRemote?: string;
  /** \`git ls-remote\` exit code; non-zero = origin could not be asked. */
  lsRemoteCode?: string;
  /** \`gh auth status\` exit code. */
  authCode?: string;
  /** Raw stdout of \`gh run list ... --json ...\`. */
  runs?: unknown;
  /**
   * Raw bytes for \`gh run list\` INSTEAD of \`runs\` — the only way to hand the
   * script something that is not JSON at all.
   */
  rawRuns?: string;
  /** Omit the \`gh\` double entirely, so \`command -v gh\` finds nothing. */
  noGh?: boolean;
  /** Make \`git rev-parse --git-dir\` fail: the cwd is not a git repository. */
  noRepo?: boolean;
}

interface Fakes {
  dir: string;
  /** Every argv the doubles saw, in order, one per line. */
  calls(): Promise<string[]>;
}

/** Write the two doubles plus their canned answers into a fresh temp dir. */
async function makeFakes(canned: Canned = {}): Promise<Fakes> {
  const dir = await mkdtemp(join(tmpdir(), 'ai-sm-release-'));
  await writeFile(join(dir, 'git'), GIT_DOUBLE, { mode: 0o755 });
  if (canned.noGh !== true) {
    await writeFile(join(dir, 'gh'), GH_DOUBLE, { mode: 0o755 });
  }
  await writeFile(join(dir, 'calls.log'), '');
  if (canned.noRepo === true) await writeFile(join(dir, 'no-repo'), '');
  await writeFile(join(dir, 'status.out'), canned.status ?? '');
  await writeFile(join(dir, 'status-code'), `${canned.statusCode ?? '0'}\n`);
  await writeFile(join(dir, 'branch'), `${canned.branch ?? 'main'}\n`);
  await writeFile(join(dir, 'head'), `${canned.head ?? SHA}\n`);
  await writeFile(join(dir, 'origin-main'), `${canned.originMain ?? SHA}\n`);
  await writeFile(join(dir, 'fetch-code'), `${canned.fetchCode ?? '0'}\n`);
  await writeFile(join(dir, 'tag-list'), canned.tagList ?? '');
  await writeFile(join(dir, 'tag-list-code'), `${canned.tagListCode ?? '0'}\n`);
  await writeFile(join(dir, 'ls-remote'), canned.lsRemote ?? '');
  await writeFile(join(dir, 'ls-remote-code'), `${canned.lsRemoteCode ?? '0'}\n`);
  await writeFile(join(dir, 'auth-code'), `${canned.authCode ?? '0'}\n`);
  await writeFile(
    join(dir, 'runs.json'),
    canned.rawRuns ?? `${JSON.stringify(canned.runs ?? [])}\n`,
  );
  return {
    dir,
    async calls(): Promise<string[]> {
      const raw = await readFile(join(dir, 'calls.log'), 'utf8');
      return raw.split('\n').filter((l) => l.length > 0);
    },
  };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * An ABSOLUTE bash: one test runs with the fake dir as the WHOLE PATH (to prove
 * the missing-gh refusal), and `spawn` resolves a bare name through the CHILD's
 * PATH, which would then be a spawn error instead of a script run.
 */
const BASH = '/bin/bash';

/** Run the script with the doubles in front of the inherited PATH. */
function runRelease(
  fakes: Fakes,
  args: string[],
  opts: { onlyFakesOnPath?: boolean } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(BASH, [SCRIPT, ...args], {
      // A temp cwd, so a stray real `git` could not touch the repository.
      cwd: fakes.dir,
      env: {
        ...process.env,
        FAKE_DIR: fakes.dir,
        PATH:
          opts.onlyFakesOnPath === true
            ? fakes.dir
            : `${fakes.dir}${delimiter}${process.env['PATH'] ?? ''}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** One run against fresh fakes, cleaned up afterwards. */
async function release(
  canned: Canned,
  args: string[],
  opts: { onlyFakesOnPath?: boolean } = {},
): Promise<RunResult & { calls: string[] }> {
  const fakes = await makeFakes(canned);
  try {
    const result = await runRelease(fakes, args, opts);
    return { ...result, calls: await fakes.calls() };
  } finally {
    await rm(fakes.dir, { recursive: true, force: true });
  }
}

/** The canned CI answer for a run that passed on this commit. */
const GREEN = [
  {
    status: 'completed',
    conclusion: 'success',
    databaseId: 42,
    url: RUN_URL,
  },
];

/**
 * No mutating git command may appear in the call log. Every `git tag` EXCEPT
 * `git tag --list` writes a ref (a lightweight `git tag v1.2.3` just as much as
 * `git tag -a`), and every `git push` writes to origin — so the allow-list is
 * the read, not the specific write the script happens to use today.
 */
function assertNothingTagged(calls: string[]): void {
  const mutating = calls.filter(
    (c) => (c.startsWith('git tag ') && !c.startsWith('git tag --list')) ||
      c === 'git tag' ||
      /^git push\b/.test(c),
  );
  assert.deepEqual(mutating, [], `expected no tag/push, got: ${calls.join(' | ')}`);
}

/** Index of the first call equal to `needle`; -1 when it never ran. */
function at(calls: string[], needle: string): number {
  return calls.indexOf(needle);
}

/** `a` must have run, and before `b` (which must have run too). */
function assertRanBefore(calls: string[], a: string, b: string): void {
  const ia = at(calls, a);
  const ib = at(calls, b);
  const log = calls.join(' | ');
  assert.notEqual(ia, -1, `${a} never ran: ${log}`);
  assert.notEqual(ib, -1, `${b} never ran: ${log}`);
  assert.ok(ia < ib, `${a} must run before ${b}: ${log}`);
}

// --- 1. the argument --------------------------------------------------------

test('release: refuses with no tag argument', async () => {
  const r = await release({}, []);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Missing the version tag/);
  assert.match(r.stderr, /npm run release -- vX\.Y\.Z/);
  assertNothingTagged(r.calls);
});

test('release: refuses a tag that is not vX.Y.Z', async () => {
  for (const bad of ['1.2.3', 'v1.2', 'release-1', 'v1.2.3-rc1', 'V1.2.3']) {
    const r = await release({}, [bad]);
    assert.notEqual(r.code, 0, `${bad} should be rejected`);
    assert.match(r.stderr, /is not a version tag/);
    assertNothingTagged(r.calls);
  }
});

test('release: refuses two version arguments', async () => {
  const r = await release({}, ['v1.2.3', 'v1.2.4']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /exactly one version tag/);
  assertNothingTagged(r.calls);
});

// --- 2. the gh CLI ----------------------------------------------------------

test('release: refuses when gh is not logged in', async () => {
  const r = await release({ authCode: '1' }, ['v1.2.3']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /not logged in/);
  assertNothingTagged(r.calls);
});

// --- 3. the working tree ----------------------------------------------------

test('release: refuses a dirty working tree', async () => {
  const r = await release({ status: ' M server/index.ts\n' }, ['v1.2.3']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /uncommitted changes/);
  assertNothingTagged(r.calls);
});

test('release: refuses a branch other than main', async () => {
  const r = await release({ branch: 'feature/x' }, ['v1.2.3']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /tagged on main/);
  assert.match(r.stderr, /feature\/x/);
  assertNothingTagged(r.calls);
});

// --- 4. in sync with origin -------------------------------------------------

test('release: refuses when HEAD is not origin/main', async () => {
  const r = await release({ originMain: OTHER_SHA }, ['v1.2.3']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /not the same commit as origin\/main/);
  assert.match(r.stderr, new RegExp(SHA));
  assert.match(r.stderr, new RegExp(OTHER_SHA));
  assertNothingTagged(r.calls);
  // It fetched BEFORE reading either side -- otherwise "in sync" is a stale
  // answer about an origin/main this clone last heard of days ago.
  assertRanBefore(r.calls, 'git fetch origin', 'git rev-parse HEAD');
  assertRanBefore(r.calls, 'git fetch origin', 'git rev-parse origin/main');
});

// --- 5. the tag must be new -------------------------------------------------

test('release: refuses a tag that already exists locally', async () => {
  const r = await release({ tagList: 'v1.2.3\n' }, ['v1.2.3']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /already exists locally/);
  assertNothingTagged(r.calls);
});

test('release: refuses a tag that already exists on origin', async () => {
  const r = await release(
    { lsRemote: `${SHA}\trefs/tags/v1.2.3\n` },
    ['v1.2.3'],
  );
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /already exists on origin/);
  assertNothingTagged(r.calls);
});

// --- 6. CI must have passed on exactly this commit --------------------------

test('release: refuses when no CI run exists for the commit', async () => {
  const r = await release({ runs: [] }, ['v1.2.3']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /No CI run exists for commit/);
  assert.match(r.stderr, new RegExp(SHA));
  assertNothingTagged(r.calls);
  // The CI question was asked about THIS commit, by workflow name, and about
  // main only -- a pull_request run can carry the same head SHA as the push run.
  assert.ok(
    r.calls.some(
      (c) =>
        c.startsWith('gh run list --workflow CI --commit ') &&
        c.includes(SHA) &&
        c.includes('--branch main'),
    ),
    r.calls.join(' | '),
  );
});

test('release: refuses while CI is still running', async () => {
  const r = await release(
    {
      runs: [
        { status: 'in_progress', conclusion: null, databaseId: 42, url: RUN_URL },
      ],
    },
    ['v1.2.3'],
  );
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /still running/);
  assert.match(r.stderr, new RegExp(RUN_URL.replace(/\//g, '\\/')));
  assertNothingTagged(r.calls);
});

test('release: refuses a failed CI run and prints its URL', async () => {
  const r = await release(
    {
      runs: [
        { status: 'completed', conclusion: 'failure', databaseId: 42, url: RUN_URL },
      ],
    },
    ['v1.2.3'],
  );
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /CI did not pass/);
  assert.match(r.stderr, /failure/);
  assert.ok(r.stderr.includes(RUN_URL), r.stderr);
  assertNothingTagged(r.calls);
});

test('release: only the newest run for the commit counts', async () => {
  // gh lists newest first: a green re-run in front of an older failure passes.
  const r = await release(
    {
      runs: [
        { status: 'completed', conclusion: 'success', databaseId: 43, url: RUN_URL },
        { status: 'completed', conclusion: 'failure', databaseId: 42, url: RUN_URL },
      ],
    },
    ['v1.2.3', '--dry-run'],
  );
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /every check passed/);
});

// --- 7. the two success paths -----------------------------------------------

test('release: --dry-run passes every check but tags nothing', async () => {
  const r = await release({ runs: GREEN }, ['v1.2.3', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Dry run: every check passed for 1{40}/);
  assert.match(r.stdout, /Would run: git tag -a v1\.2\.3 -m v1\.2\.3/);
  assert.match(r.stdout, /Would run: git push origin refs\/tags\/v1\.2\.3/);
  assert.ok(
    r.stdout.includes(
      'https://github.com/you/ai-cli-application/actions/workflows/release.yml',
    ),
    r.stdout,
  );
  // The whole point of the flag: EVERY check ran, and not one mutation did.
  // Asserted as the exact set of git calls, so a mutation added later cannot
  // hide behind a substring the allow-list happens not to name.
  assert.deepEqual(
    r.calls.filter((c) => c.startsWith('git ')),
    [
      'git rev-parse --git-dir',
      'git status --porcelain',
      'git rev-parse --abbrev-ref HEAD',
      'git fetch origin',
      'git rev-parse HEAD',
      'git rev-parse origin/main',
      'git tag --list v1.2.3',
      'git ls-remote --tags origin refs/tags/v1.2.3',
    ],
    r.calls.join(' | '),
  );
  assertNothingTagged(r.calls);
  assertRanBefore(r.calls, 'git fetch origin', 'git rev-parse HEAD');
  // And the CI question was still asked -- "every check passed" is not a claim
  // the flag lets the script make without looking.
  assert.ok(
    r.calls.some(
      (c) =>
        c.startsWith('gh run list --workflow CI --commit ') &&
        c.includes('--branch main'),
    ),
    r.calls.join(' | '),
  );
});

test('release: the success path tags and pushes, in that order', async () => {
  const r = await release({ runs: GREEN }, ['v1.2.3']);
  assert.equal(r.code, 0, r.stderr);

  const tagAt = r.calls.indexOf('git tag -a v1.2.3 -m v1.2.3');
  // refs/tags/<tag>, not the bare name: a local BRANCH of the same name makes
  // git refuse the ambiguous refspec and push nothing.
  const pushAt = r.calls.indexOf('git push origin refs/tags/v1.2.3');
  assert.notEqual(tagAt, -1, r.calls.join(' | '));
  assert.notEqual(pushAt, -1, r.calls.join(' | '));
  assert.ok(tagAt < pushAt, `tag must precede push: ${r.calls.join(' | ')}`);

  // Exactly one of each -- no second tag, no branch push.
  assert.equal(r.calls.filter((c) => c.startsWith('git tag -a')).length, 1);
  assert.equal(r.calls.filter((c) => c.startsWith('git push')).length, 1);

  // The header promises "no `gh` command here changes anything on GitHub":
  // pinned as the exact gh calls, all three of them reads.
  assert.deepEqual(
    r.calls.filter((c) => c.startsWith('gh ')),
    [
      'gh auth status',
      `gh run list --workflow CI --commit ${SHA} --branch main --json status,conclusion,databaseId,url --limit 5`,
      'gh repo view --json nameWithOwner -q .nameWithOwner',
    ],
    r.calls.join(' | '),
  );

  assert.match(r.stdout, /Tagged 1{40} as v1\.2\.3 and pushed it\./);
  assert.ok(
    r.stdout.includes(
      'https://github.com/you/ai-cli-application/actions/workflows/release.yml',
    ),
    r.stdout,
  );
});

// --- 8. the branches the first pass left unexercised -------------------------

test('release: --help prints the usage and runs no command at all', async () => {
  for (const flag of ['-h', '--help']) {
    const r = await release({}, [flag]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /usage: npm run release -- vX\.Y\.Z \[--dry-run\]/);
    // Not merely "nothing tagged": help asks GitHub and git NOTHING.
    assert.deepEqual(r.calls, [], r.calls.join(' | '));
  }
});

test('release: refuses an unknown option instead of treating it as the tag', async () => {
  const r = await release({}, ['--force']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Unknown option "--force"/);
  assert.match(r.stderr, /npm run release -- vX\.Y\.Z/);
  assert.deepEqual(r.calls, [], r.calls.join(' | '));
});

test('release: --dry-run may come before the tag', async () => {
  const r = await release({ runs: GREEN }, ['--dry-run', 'v1.2.3']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Would run: git tag -a v1\.2\.3 -m v1\.2\.3/);
  assertNothingTagged(r.calls);
});

test('release: refuses when gh is not installed at all', async () => {
  // The fake dir IS the whole PATH and holds no `gh`, so `command -v gh` fails
  // for real -- the one refusal that cannot be canned into the double.
  const r = await release({ noGh: true }, ['v1.2.3'], { onlyFakesOnPath: true });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /GitHub CLI \(gh\) is not installed/);
  assert.deepEqual(r.calls, [], r.calls.join(' | '));
});

test('release: refuses when git fetch origin fails', async () => {
  const r = await release({ fetchCode: '128' }, ['v1.2.3']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Could not reach origin \(git fetch failed\)/);
  assertNothingTagged(r.calls);
  // It stopped AT the fetch: no comparison was made against a stale origin/main.
  assert.equal(at(r.calls, 'git rev-parse origin/main'), -1, r.calls.join(' | '));
});

// A read that FAILS must never be mistaken for a read that found nothing. The
// three checks below used to test `[ -n "$(git ...)" ]` directly, where a failed
// command substitution yields '' -- "the tree is clean" / "the tag is free" --
// and `set -e` does not see it either, so the script sailed on to tag and push.

test('release: refuses when the working-tree read itself fails', async () => {
  const r = await release({ statusCode: '128', runs: GREEN }, ['v1.2.3']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Could not check for uncommitted changes \(git status failed\)/);
  assert.doesNotMatch(r.stderr, /uncommitted changes\. Commit or stash/);
  assertNothingTagged(r.calls);
  // It stopped AT the read: no branch, no fetch, no CI question.
  assert.equal(at(r.calls, 'git fetch origin'), -1, r.calls.join(' | '));
  assert.deepEqual(r.calls.filter((c) => c.startsWith('gh run list')), []);
});

test('release: refuses when the local tag read fails', async () => {
  const r = await release({ tagListCode: '128', runs: GREEN }, ['v1.2.3']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Could not read the local tags \(git tag --list failed\)/);
  assertNothingTagged(r.calls);
  // It did not go on to ask origin, let alone GitHub.
  assert.equal(
    at(r.calls, 'git ls-remote --tags origin refs/tags/v1.2.3'),
    -1,
    r.calls.join(' | '),
  );
  assert.deepEqual(r.calls.filter((c) => c.startsWith('gh run list')), []);
});

test('release: refuses when origin cannot be asked whether the tag exists', async () => {
  const r = await release({ lsRemoteCode: '128', runs: GREEN }, ['v1.2.3']);
  assert.notEqual(r.code, 0);
  assert.match(
    r.stderr,
    /Could not ask origin whether the tag exists \(git ls-remote failed\)/,
  );
  assert.doesNotMatch(r.stderr, /already exists on origin/);
  assertNothingTagged(r.calls);
  assert.deepEqual(r.calls.filter((c) => c.startsWith('gh run list')), []);
});

test('release: refuses when the CI answer is not JSON', async () => {
  const r = await release(
    { rawRuns: 'gh: could not resolve to a Repository\n' },
    ['v1.2.3'],
  );
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Could not read the CI status from the GitHub CLI/);
  assertNothingTagged(r.calls);
});

test('release: refuses valid JSON that is not a list of runs', async () => {
  // `{}` and `null` parse fine but say nothing about any run. Reporting them as
  // "no CI run exists -- push the commit and wait for CI" sends the user after a
  // problem they do not have; the honest answer is that the reply was unreadable.
  for (const raw of ['{}', 'null', '"nope"']) {
    const r = await release({ rawRuns: `${raw}\n` }, ['v1.2.3']);
    assert.notEqual(r.code, 0, raw);
    assert.match(r.stderr, /Could not read the CI status from the GitHub CLI/, raw);
    assert.doesNotMatch(r.stderr, /No CI run exists for commit/, raw);
    assertNothingTagged(r.calls);
  }
});

test('release: a NEWER failed run beats an older success on the same commit', async () => {
  // The inverse of "only the newest run counts", and the case that actually
  // discriminates: with the green run merely PRESENT in the list, an
  // implementation that scans for any success -- or reads the last entry --
  // would tag a commit whose latest CI run is red. gh returns newest first.
  const r = await release(
    {
      runs: [
        {
          status: 'completed',
          conclusion: 'failure',
          databaseId: 44,
          url: 'https://github.com/you/ai-cli-application/actions/runs/44',
        },
        { status: 'completed', conclusion: 'success', databaseId: 43, url: RUN_URL },
      ],
    },
    ['v1.2.3', '--dry-run'],
  );
  assert.notEqual(r.code, 0, r.stdout);
  assert.match(r.stderr, /CI did not pass/);
  assert.match(r.stderr, /failure/);
  assert.ok(
    r.stderr.includes('https://github.com/you/ai-cli-application/actions/runs/44'),
    r.stderr,
  );
  assertNothingTagged(r.calls);
});

test('release: a newest run still QUEUED is not a pass, whatever follows it', async () => {
  const r = await release(
    {
      runs: [
        { status: 'queued', conclusion: null, databaseId: 45, url: RUN_URL },
        { status: 'completed', conclusion: 'success', databaseId: 43, url: RUN_URL },
      ],
    },
    ['v1.2.3'],
  );
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /still running/);
  assertNothingTagged(r.calls);
});

test('release: refuses when the cwd is not a git repository', async () => {
  const r = await release({ noRepo: true }, ['v1.2.3']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /not a git repository/);
  assertNothingTagged(r.calls);
  // It asked, and then stopped: no status, no branch, no fetch.
  assert.equal(at(r.calls, 'git status --porcelain'), -1, r.calls.join(' | '));
  assert.equal(at(r.calls, 'git fetch origin'), -1, r.calls.join(' | '));
});

// --- 9. the same gate one level up: the workflows -----------------------------
//
// `release.sh` refuses to TAG a commit CI never proved green. The other half of
// that guarantee is in the workflows: a tag that is pushed anyway (by hand, by
// the GitHub UI) must still not publish unless the whole verification suite --
// the test suite included -- passed on that very commit. Nothing else in this
// repo pins that wiring, and its failure mode is silent: a release that ships
// without the suite ever running looks exactly like a release that passed.

const workflow = (name: string): Promise<string> =>
  readFile(join(projectRoot, '.github', 'workflows', name), 'utf8');

test('workflows: verify.yml is the one suite, and it runs npm test', async () => {
  const verify = await workflow('verify.yml');
  assert.match(verify, /^on:\n  workflow_call:$/m, 'verify.yml must be callable');
  assert.match(verify, /^ {8}run: npm test$/m, 'the backend suite must run in it');
  assert.match(verify, /^ {8}run: npm run typecheck$/m);
  assert.match(verify, /^ {8}run: npm run build$/m);
});

test('workflows: CI and release both call verify.yml, and publishing needs it', async () => {
  const ci = await workflow('ci.yml');
  const release = await workflow('release.yml');
  const call = 'uses: ./.github/workflows/verify.yml';
  assert.ok(ci.includes(call), 'ci.yml must call the shared suite');
  assert.ok(release.includes(call), 'release.yml must call the shared suite');
  // The load-bearing line: without `verify` in `needs`, the publish job runs
  // beside a red suite instead of behind a green one. (The other three are the
  // build jobs; tests/release-workflow.test.ts owns the rest of the graph.)
  assert.match(
    release,
    /^ {4}needs: \[verify, host, bundle, installer\]$/m,
    'the publish job must wait for verify and for every build job',
  );
});
