/**
 * POST /api/github/clone — the SUCCESSFUL path, end to end, OFFLINE.
 *
 * tests/github-connected.test.ts states that a successful authenticated clone
 * cannot be covered offline, because cloneAuthenticated() hard-locks the clone
 * url to host exactly github.com. That premise is right; the conclusion is not.
 * The lock constrains the URL, not the BINARY: server/github.ts spawns bare
 * `git` (shell:false) with `env: { ...process.env, ... }`, so PATH lookup for
 * that spawn is resolved from the server process's own environment. Pointing
 * that PATH at a `git` TEST DOUBLE covers the whole route with:
 *
 *   - NO loosening of the github.com host-lock (the url stays the real one and
 *     is still validated + rebuilt by the product code),
 *   - NO network, NO real remote, NO fake local remote,
 *   - NO product-code change and NO in-process seam (the server is a child
 *     process, exactly as the other integration tests boot it).
 *
 * What only this file proves:
 *   - the REAL GIT_ASKPASS round-trip — the throwaway script is not merely
 *     written and read, it is EXECUTED by the `git` process and returns the
 *     token. Every existing test only reads the script's bytes;
 *   - the exact argv `git` actually receives, from a real spawn;
 *   - the post-clone half of the route in server/api.ts (repoNameFromUrl →
 *     basename(dest) → explicit `name`, then projects.create + 201), which is
 *     unreachable while every clone fails;
 *   - that a failing `git` process leaves NO project registered and NO partial
 *     directory behind.
 *
 * TOKEN DISCIPLINE: the stub token is never written to any file. The double
 * compares the askpass output to $AI_SM_GH_TOKEN inside the shell and records
 * only the word MATCH/MISMATCH, so the credential never lands on disk or in
 * output — while still proving the plumbing works.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, readServerLog, startTestServer, type TestServer } from './helpers.ts';
import type { GithubRepo, Project } from '../shared/protocol.ts';
// The frontend's own (DOM-free) destination + already-cloned logic, imported so
// ONE test can prove the two layers agree instead of asserting them separately.
import { clonedProject, ownerDest } from '../web/src/ui/github-model.ts';

/** Fake token: never a real credential, but treated as one by every assertion. */
const SECRET = 'gho_STUB_ONLY_NEVER_A_REAL_TOKEN';
const CLIENT_ID = 'Iv1.stubclientid';

/**
 * A `git` test double resolved via PATH. It simulates ONLY `clone`; any other
 * git invocation exits 0 silently so it can never destabilise the server.
 *
 * Control/observation channel is the directory in $AI_SM_TEST_SHIM_OUT:
 *   in : `fail`  — when present, the clone exits 3 after creating the leaf dir
 *                  (what real git does before failing)
 *        `squat` — with `fail`, the doomed clone ALSO drops a sibling directory
 *                  with a file in it next to `dest`, i.e. inside the very
 *                  `<owner>` directory the server just created. That models a
 *                  second clone (or anything else) landing in the shared owner
 *                  directory while this one is still running, and it is the only
 *                  way to observe that the failure cleanup removes that owner
 *                  directory NON-recursively.
 *   out: `argv`  — one received argument per line
 *        `askpass` — MATCH / MISMATCH: whether EXECUTING $GIT_ASKPASS returned
 *                    exactly $AI_SM_GH_TOKEN. The token itself is never written.
 *        `env`    — the non-secret env facts worth asserting
 *        `parent` — PARENT-EXISTS / NO-PARENT: whether the destination's parent
 *                   directory already existed AT THE MOMENT git ran. Real git
 *                   creates leading directories itself (verified: git 2.43), so
 *                   without this the server's own owner-directory creation would
 *                   be invisible to a test.
 */
const GIT_DOUBLE = `#!/bin/sh
out="$AI_SM_TEST_SHIM_OUT"

is_clone=0
for a in "$@"; do
  if [ "$a" = "clone" ]; then is_clone=1; fi
done
if [ "$is_clone" != 1 ]; then exit 0; fi

: > "$out/argv"
for a in "$@"; do printf '%s\\n' "$a" >> "$out/argv"; done

# The last two arguments are the url and the destination.
prev1=""; prev2=""
for a in "$@"; do prev2="$prev1"; prev1="$a"; done
url="$prev2"; dest="$prev1"

# EXECUTE the askpass helper the way git does, and record only the verdict.
if [ -n "$GIT_ASKPASS" ] && [ -x "$GIT_ASKPASS" ]; then
  got=$("$GIT_ASKPASS" "Password for '$url': ")
  if [ "$got" = "$AI_SM_GH_TOKEN" ]; then
    printf 'MATCH' > "$out/askpass"
  else
    printf 'MISMATCH' > "$out/askpass"
  fi
else
  printf 'NO-ASKPASS' > "$out/askpass"
fi
printf 'GIT_TERMINAL_PROMPT=%s\\nGIT_ASKPASS=%s\\n' "$GIT_TERMINAL_PROMPT" "$GIT_ASKPASS" > "$out/env"

# Did the dest's parent already exist when we were invoked? (See the header.)
if [ -d "$(dirname "$dest")" ]; then
  printf 'PARENT-EXISTS' > "$out/parent"
else
  printf 'NO-PARENT' > "$out/parent"
fi

if [ -f "$out/fail" ]; then
  mkdir -p "$dest"
  if [ -f "$out/squat" ]; then
    mkdir -p "$(dirname "$dest")/squatter"
    printf 'another clone\\n' > "$(dirname "$dest")/squatter/keep.txt"
  fi
  exit 3
fi

# What a real clone leaves behind: a worktree and a token-free .git/config.
mkdir -p "$dest/.git"
printf '[remote "origin"]\\n\\turl = %s\\n' "$url" > "$dest/.git/config"
printf 'hello\\n' > "$dest/README.md"
exit 0
`;

let server: TestServer;
let root: string;
let shimOut: string;
let work: string;

/** Read a recording file written by the git double ('' when absent). */
async function recorded(name: string): Promise<string> {
  try {
    return await readFile(join(shimOut, name), 'utf8');
  } catch {
    return '';
  }
}

async function recordedArgv(): Promise<string[]> {
  const raw = await recorded('argv');
  return raw === '' ? [] : raw.replace(/\n$/, '').split('\n');
}

/** Forget the previous invocation so each assertion is about its own request. */
async function resetRecordings(): Promise<void> {
  await rm(join(shimOut, 'argv'), { force: true });
  await rm(join(shimOut, 'askpass'), { force: true });
  await rm(join(shimOut, 'env'), { force: true });
  await rm(join(shimOut, 'parent'), { force: true });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-sm-ghclone-'));
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { mode: 0o700 });
  // Pre-seed github.json so the server boots already CONNECTED (StoredToken shape).
  await writeFile(
    join(dataDir, 'github.json'),
    JSON.stringify({
      accessToken: SECRET,
      login: 'octocat',
      scope: 'repo',
      connectedAt: '2026-07-24T00:00:00Z',
    }) + '\n',
    { mode: 0o600 },
  );

  const shimDir = join(root, 'bin');
  await mkdir(shimDir);
  await writeFile(join(shimDir, 'git'), GIT_DOUBLE, { mode: 0o755 });
  shimOut = join(root, 'shim-out');
  await mkdir(shimOut);
  work = join(root, 'work');
  await mkdir(work);

  server = await startTestServer({
    dataDir,
    env: {
      AI_SM_GITHUB_CLIENT_ID: CLIENT_ID,
      AI_SM_TEST_SHIM_OUT: shimOut,
      // The double must WIN over the real git for this server process only.
      PATH: `${shimDir}:${process.env['PATH'] ?? ''}`,
    },
  });
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

test('a successful clone returns 201, registers the project, and derives the name from the clone url', async () => {
  await resetRecordings();
  const dest = join(work, 'hello-dest');
  const res = await api(server, 'POST', '/api/github/clone', {
    cloneUrl: 'https://github.com/octocat/hello.git',
    dest,
  });
  assert.equal(res.status, 201, `expected 201, got ${res.status} ${JSON.stringify(res.body)}`);
  const project = res.body as Project;
  assert.equal(project.name, 'hello', 'the name is derived from the clone url, .git stripped');
  assert.equal(project.path, dest);
  assert.equal(typeof project.id, 'string');
  assert.ok(project.id.length > 0);
  assert.ok(!JSON.stringify(res.body).includes(SECRET), 'the response NEVER carries the token');

  // The clone is registered and readable back through the projects API.
  const list = (await api(server, 'GET', '/api/projects')).body as Project[];
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, project.id);
  assert.equal(list[0]?.path, dest);

  // The worktree the "clone" produced is kept (the leak guard did not fire).
  assert.ok(existsSync(join(dest, 'README.md')), 'the cloned worktree is kept');
  const cfg = await readFile(join(dest, '.git', 'config'), 'utf8');
  assert.ok(!cfg.includes(SECRET), '.git/config never contains the token');
});

test('the argv git really received: url rebuilt to x-access-token@github.com, credential helper cleared, NO token', async () => {
  const argv = await recordedArgv();
  assert.deepEqual(
    argv,
    [
      '-c',
      'credential.helper=',
      'clone',
      '--',
      'https://x-access-token@github.com/octocat/hello.git',
      join(work, 'hello-dest'),
    ],
    'exact argv, rebuilt from validated url parts only',
  );
  for (const a of argv) {
    assert.ok(!a.includes(SECRET), `the token is NEVER on argv (${a})`);
  }
  assert.ok(!argv.join(' ').includes('gho_'), 'no credential-shaped string on argv at all');
});

test('the GIT_ASKPASS round-trip actually EXECUTES: git gets the token from the helper, not from argv or the url', async () => {
  assert.equal(
    await recorded('askpass'),
    'MATCH',
    'running $GIT_ASKPASS as a real process returned exactly the stored token',
  );
  assert.match(
    await recorded('env'),
    /^GIT_TERMINAL_PROMPT=0$/m,
    'interactive credential prompting is disabled (a stuck clone would hang the server)',
  );
});

test('the throwaway askpass script existed during the clone and is deleted afterwards', async () => {
  // Assert on the EXACT path this clone used (read back from the double), never
  // by scanning the shared tmpdir — a global scan would race other test files.
  const line = /^GIT_ASKPASS=(.+)$/m.exec(await recorded('env'));
  assert.ok(line !== null, 'the double recorded the GIT_ASKPASS path git was handed');
  const askPath = line[1] as string;
  assert.match(askPath, /^\/.*ai-sm-gh-ask-[^/]+\/askpass\.sh$/, 'a throwaway script under the OS tmpdir');
  assert.ok(askPath.startsWith(tmpdir()), 'the askpass script lives under the OS tmpdir');
  assert.equal(
    await recorded('askpass'),
    'MATCH',
    'it was executable and correct at the moment git ran it',
  );
  assert.equal(existsSync(askPath), false, 'the token-printing script is removed after the clone');
});

test('an explicit name overrides the url-derived one (and is trimmed)', async () => {
  await resetRecordings();
  const dest = join(work, 'named-dest');
  const res = await api(server, 'POST', '/api/github/clone', {
    cloneUrl: 'https://github.com/octocat/hello.git',
    dest,
    name: '  My Fork  ',
  });
  assert.equal(res.status, 201);
  assert.equal((res.body as Project).name, 'My Fork');
  assert.equal((res.body as Project).path, dest);
});

test('a url with no derivable repo name falls back to the destination basename', async () => {
  await resetRecordings();
  const dest = join(work, 'fallback-name');
  const res = await api(server, 'POST', '/api/github/clone', {
    // Last segment is ".git" -> strips to '' -> repoNameFromUrl undefined.
    cloneUrl: 'https://github.com/octocat/.git',
    dest,
  });
  assert.equal(res.status, 201, `expected 201, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal((res.body as Project).name, 'fallback-name', 'basename(dest) is the fallback');
});

test('a blank explicit name is ignored in favour of the url-derived name (not stored blank)', async () => {
  await resetRecordings();
  const dest = join(work, 'blank-name');
  const res = await api(server, 'POST', '/api/github/clone', {
    cloneUrl: 'https://github.com/octocat/widget.git',
    dest,
    name: '   ',
  });
  assert.equal(res.status, 201);
  assert.equal((res.body as Project).name, 'widget');
});

test('a FAILING git exits the route at 502: no project registered, no partial directory, no token in the error', async () => {
  await resetRecordings();
  await writeFile(join(shimOut, 'fail'), '1');
  try {
    const before = ((await api(server, 'GET', '/api/projects')).body as Project[]).length;
    const dest = join(work, 'doomed-dest');
    const res = await api(server, 'POST', '/api/github/clone', {
      cloneUrl: 'https://github.com/octocat/doomed.git',
      dest,
    });
    assert.equal(res.status, 502, 'a non-zero git exit surfaces as 502');
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes(SECRET), 'the failure message never carries the token');
    assert.ok(!text.includes('exit 3'), 'raw git process detail is not surfaced');
    assert.equal(existsSync(dest), false, 'a dest WE created is removed on failure');

    const after = ((await api(server, 'GET', '/api/projects')).body as Project[]).length;
    assert.equal(after, before, 'a failed clone registers NO project');
    // It failed at git, not before it: the double really ran.
    assert.ok((await recordedArgv()).includes('clone'), 'git was actually spawned');
  } finally {
    await rm(join(shimOut, 'fail'), { force: true });
  }
});

// ---------------------------------------------------------------------------
// OWNER-QUALIFIED DESTINATIONS (settled 2026-07-25). App clones from the GitHub
// repo list land at <projects>/<owner>/<repo>, so `acme/api` and `myorg/api` can
// both exist locally. What is asserted here, on a REAL spawn of the git double:
//   - the missing <owner> directory is created (exactly one level),
//   - two same-basename repos from different owners both clone, and register
//     under distinguishable names,
//   - 409 now means the FINAL <owner>/<repo> directory exists,
//   - the allowance is NARROW (wrong owner segment / two missing levels: 400,
//     nothing created),
//   - a failed clone removes an <owner> directory WE created, never one that
//     was already there.
// ---------------------------------------------------------------------------

test('owner-qualified dest: the missing <owner> directory is created (one level) and git gets the exact path', async () => {
  await resetRecordings();
  const projectsRoot = join(work, 'projects-owner');
  await mkdir(projectsRoot);
  const dest = join(projectsRoot, 'acme', 'api');
  assert.equal(existsSync(join(projectsRoot, 'acme')), false, 'the owner directory does not exist yet');

  const res = await api(server, 'POST', '/api/github/clone', {
    cloneUrl: 'https://github.com/acme/api.git',
    dest,
    name: 'api',
  });
  assert.equal(res.status, 201, `expected 201, got ${res.status} ${JSON.stringify(res.body)}`);
  const project = res.body as Project;
  assert.equal(project.path, dest, 'the project records the owner-qualified path');
  assert.equal(project.name, 'api', 'the bare repo basename, because no project held it yet');
  assert.ok(existsSync(join(projectsRoot, 'acme')), 'the <owner> directory was created for us');
  assert.equal(
    await recorded('parent'),
    'PARENT-EXISTS',
    'the SERVER created <owner> before spawning git (real git would create leading dirs itself, ' +
      'so only this proves the creation is ours — and it is what makes the cleanup on failure ours too)',
  );
  assert.ok(existsSync(join(dest, 'README.md')), 'the clone landed inside <owner>/<repo>');
  assert.deepEqual(
    await recordedArgv(),
    [
      '-c',
      'credential.helper=',
      'clone',
      '--',
      'https://x-access-token@github.com/acme/api.git',
      dest,
    ],
    'git was handed the owner-qualified dest verbatim',
  );
});

test('two same-basename repos from DIFFERENT owners both clone: no 409, separate folders, distinguishable names', async () => {
  await resetRecordings();
  const projectsRoot = join(work, 'projects-owner'); // acme/api already cloned above
  const dest = join(projectsRoot, 'myorg', 'api');

  const res = await api(server, 'POST', '/api/github/clone', {
    cloneUrl: 'https://github.com/myorg/api.git',
    dest,
    name: 'api', // what the repo list sends: the bare basename
  });
  assert.equal(res.status, 201, `expected 201 (was a 409 before this change), got ${res.status}`);
  const project = res.body as Project;
  assert.equal(project.path, dest, 'a different directory from acme/api — nothing to collide with');
  assert.equal(
    project.name,
    'myorg/api',
    'the bare name `api` was taken, so this clone is registered owner-qualified',
  );

  const list = (await api(server, 'GET', '/api/projects')).body as Project[];
  const acme = list.find((p) => p.path === join(projectsRoot, 'acme', 'api'));
  const myorg = list.find((p) => p.path === dest);
  assert.ok(acme !== undefined && myorg !== undefined, 'both clones are registered');
  assert.notEqual(acme.id, myorg.id);
  assert.notEqual(acme.name, myorg.name, 'a UI that shows names only can tell them apart');
  assert.ok(existsSync(join(dest, 'README.md')), 'the second worktree exists on its own');
});

test('owner-qualified dest: an owner segment differing only in CASE from the url is accepted', async () => {
  await resetRecordings();
  const projectsRoot = join(work, 'projects-case');
  await mkdir(projectsRoot);
  const dest = join(projectsRoot, 'octocat', 'casing');
  const res = await api(server, 'POST', '/api/github/clone', {
    cloneUrl: 'https://github.com/OctoCat/casing.git',
    dest,
  });
  assert.equal(res.status, 201, `expected 201, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.ok(existsSync(join(projectsRoot, 'octocat')), 'the owner directory was created as the dest spelled it');
});

test('409 now means the FINAL <owner>/<repo> directory exists — never that another owner shares the basename', async () => {
  await resetRecordings();
  const projectsRoot = join(work, 'projects-409');
  const dest = join(projectsRoot, 'other', 'api');
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, 'keep.txt'), 'precious\n');

  const before = ((await api(server, 'GET', '/api/projects')).body as Project[]).length;
  const res = await api(server, 'POST', '/api/github/clone', {
    cloneUrl: 'https://github.com/other/api.git',
    dest,
  });
  assert.equal(res.status, 409, 'a non-empty <owner>/<repo> is still never clobbered');
  assert.equal(await readFile(join(dest, 'keep.txt'), 'utf8'), 'precious\n', 'untouched');
  assert.equal(
    ((await api(server, 'GET', '/api/projects')).body as Project[]).length,
    before,
    'a refused clone registers no project',
  );
  assert.deepEqual(await recordedArgv(), [], 'git was never spawned');
});

test('the <owner>-directory allowance is NARROW: a non-owner parent or two missing levels still 400, creating nothing', async () => {
  await resetRecordings();
  const projectsRoot = join(work, 'projects-narrow');
  await mkdir(projectsRoot);
  const url = 'https://github.com/acme/api.git';

  const wrongOwner = await api(server, 'POST', '/api/github/clone', {
    cloneUrl: url,
    dest: join(projectsRoot, 'notacme', 'api'),
  });
  assert.equal(wrongOwner.status, 400, 'the parent must be named after the url’s owner');
  assert.equal(existsSync(join(projectsRoot, 'notacme')), false, 'nothing was created');

  const twoLevels = await api(server, 'POST', '/api/github/clone', {
    cloneUrl: url,
    dest: join(projectsRoot, 'acme', 'deep', 'api'),
  });
  assert.equal(twoLevels.status, 400, 'only ONE missing level is ever created — never mkdir -p');
  assert.equal(existsSync(join(projectsRoot, 'acme')), false, 'no partial tree left behind');

  const missingRoot = await api(server, 'POST', '/api/github/clone', {
    cloneUrl: url,
    dest: join(work, 'no-such-root', 'acme', 'api'),
  });
  assert.equal(missingRoot.status, 400, 'the owner directory’s own parent must already exist');
  assert.equal(existsSync(join(work, 'no-such-root')), false);

  assert.deepEqual(await recordedArgv(), [], 'git was never spawned for any of them');
});

test('a FAILING clone removes the <owner> directory WE created, and never one that already existed', async () => {
  await resetRecordings();
  await writeFile(join(shimOut, 'fail'), '1');
  try {
    const projectsRoot = join(work, 'projects-fail');
    await mkdir(projectsRoot);

    const dest = join(projectsRoot, 'failowner', 'api');
    const res = await api(server, 'POST', '/api/github/clone', {
      cloneUrl: 'https://github.com/failowner/api.git',
      dest,
    });
    assert.equal(res.status, 502);
    assert.equal(existsSync(dest), false, 'the partial dest is removed');
    assert.equal(
      existsSync(join(projectsRoot, 'failowner')),
      false,
      'and so is the owner directory we created for it',
    );

    // A PRE-EXISTING owner directory (already holding another clone) is kept.
    const keepOwner = join(projectsRoot, 'keepowner');
    await mkdir(join(keepOwner, 'sibling'), { recursive: true });
    await writeFile(join(keepOwner, 'sibling', 'note.txt'), 'another clone\n');
    const res2 = await api(server, 'POST', '/api/github/clone', {
      cloneUrl: 'https://github.com/keepowner/api.git',
      dest: join(keepOwner, 'api'),
    });
    assert.equal(res2.status, 502);
    assert.ok(existsSync(keepOwner), 'a pre-existing owner directory is never removed');
    assert.equal(
      await readFile(join(keepOwner, 'sibling', 'note.txt'), 'utf8'),
      'another clone\n',
      'its contents are untouched',
    );
  } finally {
    await rm(join(shimOut, 'fail'), { force: true });
  }
});

test('a FAILING clone removes the <owner> directory we created NON-recursively: data that appeared inside it survives', async () => {
  // The cleanup path is `rmdirSync(createdOwnerDir)` — an EMPTY-ONLY removal —
  // and the existing failure test cannot tell that apart from a recursive
  // `rmSync`, because by then the only thing under the owner directory is the
  // partial dest the cleanup already removed. The `squat` shim flag creates the
  // one situation where the two differ: a SECOND clone lands in the shared
  // <owner> directory while this one is failing. Empty-only removal must then
  // find ENOTEMPTY, keep the directory, and leave the other clone's bytes alone;
  // a recursive removal would delete a stranger's data on our error path.
  await resetRecordings();
  await writeFile(join(shimOut, 'fail'), '1');
  await writeFile(join(shimOut, 'squat'), '1');
  try {
    const projectsRoot = join(work, 'projects-squat');
    await mkdir(projectsRoot);
    const owner = join(projectsRoot, 'raceowner');
    const dest = join(owner, 'api');
    assert.equal(existsSync(owner), false, 'the owner directory is ours to create');

    const res = await api(server, 'POST', '/api/github/clone', {
      cloneUrl: 'https://github.com/raceowner/api.git',
      dest,
    });
    assert.equal(res.status, 502);
    assert.equal(existsSync(dest), false, 'our own partial dest is still removed');
    assert.ok(
      existsSync(owner),
      'the owner directory is KEPT once it is no longer empty — cleanup is rmdir, not rm -r',
    );
    assert.equal(
      await readFile(join(owner, 'squatter', 'keep.txt'), 'utf8'),
      'another clone\n',
      'and the bytes that appeared inside it are untouched',
    );

    const list = (await api(server, 'GET', '/api/projects')).body as Project[];
    assert.equal(
      list.some((p) => p.path === dest),
      false,
      'a failed clone still registers no project',
    );
  } finally {
    await rm(join(shimOut, 'fail'), { force: true });
    await rm(join(shimOut, 'squat'), { force: true });
  }
});

test('an UN-NORMALIZED dest is refused 400 at the route — no git, nothing created, nothing deleted', async () => {
  // REGRESSION (security). `<projects>/<owner>/..` resolves to <projects>, which
  // already exists and is full of the user's work; the pre-fix route accepted it
  // raw, and the clone's failure cleanup then removed everything inside
  // <projects>. The route now requires an ALREADY-NORMALIZED absolute dest, so
  // nothing downstream ever sees the two-faced path.
  await resetRecordings();
  const projectsRoot = join(work, 'projects-dotdot');
  await mkdir(join(projectsRoot, 'my-real-project'), { recursive: true });
  await writeFile(join(projectsRoot, 'notes.md'), '# months of work\n');
  const before = ((await api(server, 'GET', '/api/projects')).body as Project[]).length;

  // Built by string concatenation on purpose: path.join() would normalize these
  // away, and it is precisely the UN-normalized form that a JSON body can carry.
  for (const dest of [
    `${projectsRoot}/acme/..`, // resolves to an existing, non-empty directory
    `${projectsRoot}/acme/../api`, // resolves elsewhere than it reads
    `${projectsRoot}/acme/api/`, // trailing slash: same two-faced class
    `${projectsRoot}/./acme`, // `.` component
  ]) {
    const res = await api(server, 'POST', '/api/github/clone', {
      cloneUrl: 'https://github.com/acme/api.git',
      dest,
    });
    assert.equal(res.status, 400, `${dest} must be refused`);
    assert.equal(
      (res.body as { error?: string }).error,
      'dest must be an absolute path',
      'the existing 400 vocabulary, not a new one',
    );
  }

  assert.deepEqual(await recordedArgv(), [], 'git was never spawned for any of them');
  assert.equal(existsSync(join(projectsRoot, 'acme')), false, 'no owner directory was created');
  assert.equal(
    await readFile(join(projectsRoot, 'notes.md'), 'utf8'),
    '# months of work\n',
    'the pre-existing project folder is untouched',
  );
  assert.ok(existsSync(join(projectsRoot, 'my-real-project')), 'and so is everything inside it');
  assert.equal(
    ((await api(server, 'GET', '/api/projects')).body as Project[]).length,
    before,
    'a refused clone registers no project',
  );
});

test('project NAME edge cases the owner-qualification rule has to answer deterministically', async () => {
  // Two branches of server/api.ts that the happy paths never reach:
  //   (a) the qualified name `<owner>/<repo>` is ITSELF already taken — the
  //       documented answer is "use it anyway, never invent a suffix";
  //   (b) the clone url is NOT a two-segment github.com path, so there is no
  //       owner to qualify WITH — the preferred name must survive unchanged
  //       even though it collides.
  await resetRecordings();
  const projectsRoot = join(work, 'projects-names');
  await mkdir(projectsRoot);

  const first = await api(server, 'POST', '/api/github/clone', {
    cloneUrl: 'https://github.com/nameowner/dup.git',
    dest: join(projectsRoot, 'nameowner', 'dup'),
    name: 'dup',
  });
  assert.equal(first.status, 201);
  assert.equal((first.body as Project).name, 'dup', 'free basename → bare name');

  const second = await api(server, 'POST', '/api/github/clone', {
    cloneUrl: 'https://github.com/otherowner/dup.git',
    dest: join(projectsRoot, 'otherowner', 'dup'),
    name: 'dup',
  });
  assert.equal(second.status, 201);
  assert.equal((second.body as Project).name, 'otherowner/dup', 'basename taken → owner-qualified');

  // (a) The SAME repo cloned a second time to a different folder: `dup` is
  //     taken, so the qualified name is used again — even though it, too, is
  //     taken. Deterministic and documented; NOT a silent counter suffix.
  const third = await api(server, 'POST', '/api/github/clone', {
    cloneUrl: 'https://github.com/otherowner/dup.git',
    dest: join(projectsRoot, 'otherowner-copy', 'dup'),
    name: 'dup',
  });
  assert.equal(third.status, 400, 'the owner-dir allowance needs the parent named after the owner');

  const thirdOk = await api(server, 'POST', '/api/github/clone', {
    cloneUrl: 'https://github.com/otherowner/dup.git',
    dest: join(projectsRoot, 'otherowner', 'dup-again'),
    name: 'dup',
  });
  assert.equal(thirdOk.status, 201);
  assert.equal(
    (thirdOk.body as Project).name,
    'otherowner/dup',
    'no suffix invented — the qualified name repeats verbatim',
  );

  // (b) Three path segments → parseGithubRepoPath returns undefined → nothing to
  //     qualify with, so the colliding preferred name is kept as-is.
  const noOwner = await api(server, 'POST', '/api/github/clone', {
    cloneUrl: 'https://github.com/deep/nested/dup.git',
    dest: join(projectsRoot, 'nested-dest'),
    name: 'dup',
  });
  assert.equal(noOwner.status, 201, `expected 201, got ${noOwner.status} ${JSON.stringify(noOwner.body)}`);
  assert.equal(
    (noOwner.body as Project).name,
    'dup',
    'no owner is derivable, so the name is left alone rather than half-qualified',
  );
});

test('END TO END: the dest the UI computes, the name the server assigns, and clonedProject all agree', async () => {
  // The one test that crosses the layer boundary: it drives the REAL route with
  // exactly what web/src/ui/github.ts sends (ownerDest + the bare repo name),
  // then feeds the REAL /api/projects answer back into the frontend's
  // already-cloned detection. A drift in either layer breaks it.
  await resetRecordings();
  const home = join(work, 'home-e2e');
  await mkdir(join(home, 'projects'), { recursive: true });
  const mk = (owner: string): GithubRepo => ({
    fullName: `${owner}/tool`,
    name: 'tool',
    owner,
    private: false,
    cloneUrl: `https://github.com/${owner}/tool.git`,
  });
  const acmeRepo = mk('acme');
  const myorgRepo = mk('myorg');

  const before = (await api(server, 'GET', '/api/projects')).body as Project[];
  assert.equal(clonedProject(acmeRepo, home, before), null, 'both rows start as `clone`');
  assert.equal(clonedProject(myorgRepo, home, before), null);

  for (const r of [acmeRepo, myorgRepo]) {
    await resetRecordings();
    const res = await api(server, 'POST', '/api/github/clone', {
      cloneUrl: r.cloneUrl,
      dest: ownerDest(home, r.owner, r.name), // exactly what the panel sends
      name: r.name,
    });
    assert.equal(res.status, 201, `${r.fullName}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal((res.body as Project).path, ownerDest(home, r.owner, r.name));
  }

  const after = (await api(server, 'GET', '/api/projects')).body as Project[];
  const acme = clonedProject(acmeRepo, home, after);
  const myorg = clonedProject(myorgRepo, home, after);
  assert.ok(acme !== null && myorg !== null, 'both rows now resolve to a local project');
  assert.equal(acme.path, join(home, 'projects', 'acme', 'tool'));
  assert.equal(myorg.path, join(home, 'projects', 'myorg', 'tool'));
  assert.notEqual(acme.id, myorg.id, 'and to DIFFERENT projects — the whole point');
  assert.equal(acme.name, 'tool', 'first clone keeps the bare basename');
  assert.equal(myorg.name, 'myorg/tool', 'second clone is owner-qualified because `tool` was taken');
});

test('after every clone in this file: server.log carries neither the token nor an Authorization header', async () => {
  const log = await readServerLog(server);
  assert.ok(log.length > 0, 'the server logged something (so this assertion is meaningful)');
  assert.ok(!log.includes(SECRET), 'the OAuth token must never reach server.log');
  assert.ok(!log.includes('Bearer'), 'no Authorization header is ever logged');
  assert.ok(!log.includes('gho_'), 'no credential-shaped string in the log');
});
