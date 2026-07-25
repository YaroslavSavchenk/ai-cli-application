/**
 * REGRESSION (security): the two /api/projects routes NORMALIZE an
 * un-normalized destination instead of refusing it, and every consumer of that
 * path — `existedBefore`, assertVacant, mkdir, the git cwd/argv, the failure
 * cleanup's recursive rmSync, and the value stored in projects.json — sees the
 * SAME resolved directory.
 *
 * The primitive being pinned (server/scaffold.ts, pre-fix): `<victim>/acme/..`
 * STATS as missing while the kernel resolves it to the pre-existing `<victim>`.
 * `createLocalDir` therefore set `existedBefore=false`, mkdir materialised
 * `<victim>/acme`, `git init` ran in `<victim>`, and when git exited non-zero
 * the cleanup ran `rmSync('<victim>/acme/..', {recursive:true, force:true})` —
 * emptying `<victim>`. `/api/github/clone` had the same shape and was fixed by
 * REFUSING (400); these two routes are fixed by RESOLVING, because their
 * destinations are user-typed and already stored in projects.json.
 *
 * SHADOWING IS THE HAZARD IN THIS FILE. A `<victim>/acme/..` whose `<victim>`
 * is non-empty is refused by the FIRST guard (assertVacant → 409) and every
 * consumer behind it becomes unobservable — "resolved once, used everywhere"
 * then looks identical to "resolved once, then one consumer handed the raw
 * string". So the destructive scenario is asserted on its own, and the
 * remaining consumers are driven through an EMPTY `<landing>` directory, where
 * the raw and resolved strings really do differ for the kernel (`<landing>/acme`
 * does not exist, so the raw string is ENOENT) while resolve() — purely lexical
 * — lands on `<landing>` itself.
 *
 * Every un-normalized path here is built by STRING CONCATENATION: path.join()
 * would normalize the `..` away and make the test vacuous.
 *
 * git is a PATH-resolved TEST DOUBLE (the server child process only), so `git
 * init` / `git clone` failure is deterministic and offline, and the cwd/argv
 * git actually received is observable.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '../shared/protocol.ts';
import { api, startTestServer, type TestServer } from './helpers.ts';

/**
 * A `git` double resolved through PATH. Records one line per init/clone —
 * `<sub>\t<cwd>\t<last argv>` — into $AI_SM_TEST_SHIM_OUT/log, and exits 3 when
 * the `fail` marker file exists. A failing CLONE first creates its destination,
 * which is what real git does before it fails (and what makes the failure
 * cleanup observable). Any other git invocation exits 0 silently.
 */
const GIT_DOUBLE = `#!/bin/sh
out="$AI_SM_TEST_SHIM_OUT"
sub=""
for a in "$@"; do
  case "$a" in
    init|clone) sub="$a"; break ;;
  esac
done
[ -n "$sub" ] || exit 0
last=""
for a in "$@"; do last="$a"; done
printf '%s\\t%s\\t%s\\n' "$sub" "$(pwd)" "$last" >> "$out/log"
if [ "$sub" = "clone" ]; then
  if [ -f "$out/fail" ]; then
    mkdir -p "$last"
    printf 'partial\\n' > "$last/partial.txt"
    exit 3
  fi
  if [ -e "$last" ] && [ -n "$(ls -A "$last" 2>/dev/null)" ]; then exit 128; fi
  mkdir -p "$last/.git"
  printf '[remote "origin"]\\n' > "$last/.git/config"
  exit 0
fi
if [ -f "$out/fail" ]; then exit 3; fi
mkdir -p .git
exit 0
`;

let server: TestServer;
let root: string;
let shimOut: string;
let work: string;

/** One `<sub>\t<cwd>\t<last argv>` record per git invocation since the last reset. */
async function gitLog(): Promise<{ sub: string; cwd: string; last: string }[]> {
  let raw: string;
  try {
    raw = await readFile(join(shimOut, 'log'), 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const [sub, cwd, last] = l.split('\t');
      return { sub: sub as string, cwd: cwd as string, last: last as string };
    });
}

async function resetGitLog(): Promise<void> {
  await rm(join(shimOut, 'log'), { force: true });
}

/** Make git exit 3 for the duration of `fn`. */
async function withFailingGit<T>(fn: () => Promise<T>): Promise<T> {
  await writeFile(join(shimOut, 'fail'), '1');
  try {
    return await fn();
  } finally {
    await rm(join(shimOut, 'fail'), { force: true });
  }
}

/** A pre-existing directory full of the user's work — nothing here may be lost. */
async function victimDir(name: string): Promise<string> {
  const v = join(work, name);
  await mkdir(join(v, 'sub'), { recursive: true });
  await writeFile(join(v, 'precious.txt'), 'do not delete\n');
  await writeFile(join(v, 'sub', 'more.txt'), 'also precious\n');
  return v;
}

/** An EXISTING, EMPTY directory — passes assertVacant, so no guard shadows. */
async function landingDir(name: string): Promise<string> {
  const l = join(work, name);
  await mkdir(l, { recursive: true });
  return l;
}

async function projectPaths(): Promise<string[]> {
  const res = await api(server, 'GET', '/api/projects');
  return (res.body as Project[]).map((p) => p.path);
}

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-normalize-')));
  const shimDir = join(root, 'bin');
  await mkdir(shimDir);
  await writeFile(join(shimDir, 'git'), GIT_DOUBLE, { mode: 0o755 });
  shimOut = join(root, 'shim-out');
  await mkdir(shimOut);
  work = join(root, 'work');
  await mkdir(work);
  server = await startTestServer({
    env: {
      AI_SM_TEST_SHIM_OUT: shimOut,
      // The double must WIN over the real git — for this server process only.
      PATH: `${shimDir}:${process.env['PATH'] ?? ''}`,
    },
  });
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// POST /api/projects (create:true)
// ---------------------------------------------------------------------------

test('create: an un-normalized path can never delete the pre-existing directory it resolves to', async () => {
  // The auditor's exact scenario: POST /api/projects {create:true, gitInit:true}
  // with `<victim>/acme/..` and a git that exits non-zero. Pre-fix this answered
  // 500 "git exited with status 3" with <victim> emptied.
  await resetGitLog();
  const victim = await victimDir('create-victim');
  const raw = `${victim}/acme/..`; // concatenated: join() would normalize it away
  const before = await projectPaths();

  const res = await withFailingGit(() =>
    api(server, 'POST', '/api/projects', { name: 'x', path: raw, create: true, gitInit: true }),
  );

  assert.equal(res.status, 409, `expected the no-clobber 409, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(
    (res.body as { error?: string }).error,
    'directory already exists and is not empty',
    'the existing error vocabulary, not a new one',
  );
  assert.equal(await readFile(join(victim, 'precious.txt'), 'utf8'), 'do not delete\n');
  assert.equal(await readFile(join(victim, 'sub', 'more.txt'), 'utf8'), 'also precious\n');
  assert.equal(existsSync(join(victim, 'acme')), false, 'nothing was materialised for the raw string');
  assert.deepEqual(await gitLog(), [], 'git never ran');
  assert.deepEqual(await projectPaths(), before, 'nothing was registered — not the raw path, not the resolved one');
});

test('create: the success path runs git in the RESOLVED directory and registers the RESOLVED path', async () => {
  // `<landing>` exists and is EMPTY, so assertVacant passes and execution
  // reaches every remaining consumer.
  await resetGitLog();
  const landing = await landingDir('create-ok');
  const raw = `${landing}/acme/..`;

  const res = await api(server, 'POST', '/api/projects', {
    name: 'Resolved',
    path: raw,
    create: true,
    gitInit: true,
  });

  assert.equal(res.status, 201, `expected 201, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal((res.body as Project).path, landing, 'projects.json stores the resolved path, never the raw one');
  assert.deepEqual(
    (await gitLog()).map((g) => [g.sub, g.cwd]),
    [['init', landing]],
    'git init ran exactly once, with the RESOLVED cwd',
  );
  assert.equal(existsSync(join(landing, '.git')), true, 'the repo landed in the resolved directory');
  assert.equal(existsSync(join(landing, 'acme')), false, 'no directory was materialised for the raw string');
  assert.ok((await projectPaths()).includes(landing), 'registered under the resolved path');
  assert.equal((await projectPaths()).includes(raw), false, 'and never under the un-normalized one');
});

test('create: a failed git init removes the directory WE created — and only via the resolved path', async () => {
  // `<landing>/acme/../fresh` resolves to `<landing>/fresh`, which does NOT
  // exist: existedBefore is false, so the cleanup branch really runs. Cleaning
  // up through the raw string would hit ENOENT on the missing `acme` component,
  // which rmSync({force:true}) swallows — leaving the directory behind.
  await resetGitLog();
  const landing = await landingDir('create-cleanup');
  const raw = `${landing}/acme/../fresh`;
  const before = await projectPaths();

  const res = await withFailingGit(() =>
    api(server, 'POST', '/api/projects', { name: 'y', path: raw, create: true, gitInit: true }),
  );

  assert.equal(res.status, 500, `expected the git-failure 500, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal((res.body as { error?: string }).error, 'git exited with status 3');
  assert.deepEqual(
    (await gitLog()).map((g) => [g.sub, g.cwd]),
    [['init', join(landing, 'fresh')]],
    'git init ran in the resolved directory',
  );
  assert.equal(existsSync(join(landing, 'fresh')), false, 'the directory we created is cleaned up');
  assert.equal(existsSync(join(landing, 'acme')), false, 'and the raw string never materialised anything');
  assert.equal(existsSync(landing), true, 'the pre-existing parent survives');
  assert.deepEqual(await projectPaths(), before, 'a failed create registers no project');
});

test('create: a failed git init NEVER removes a directory that already existed', async () => {
  // `existedBefore` read from the raw string is ENOENT (the `acme` component is
  // missing) → false → the recursive rmSync would then delete the pre-existing
  // `<landing>` it resolves to. Read from the resolved path it is true, and the
  // cleanup is correctly skipped.
  await resetGitLog();
  const landing = await landingDir('create-preexisting');
  const raw = `${landing}/acme/..`;
  const before = await projectPaths();

  const res = await withFailingGit(() =>
    api(server, 'POST', '/api/projects', { name: 'z', path: raw, create: true, gitInit: true }),
  );

  assert.equal(res.status, 500, `expected the git-failure 500, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(existsSync(landing), true, 'the pre-existing directory survives the failure cleanup');
  assert.deepEqual(
    (await gitLog()).map((g) => [g.sub, g.cwd]),
    [['init', landing]],
    'git init ran in the resolved directory',
  );
  assert.equal(existsSync(join(landing, 'acme')), false, 'nothing was materialised for the raw string');
  assert.deepEqual(await projectPaths(), before, 'a failed create registers no project');
});

// ---------------------------------------------------------------------------
// POST /api/projects/clone
// ---------------------------------------------------------------------------

test('clone: an un-normalized dest can never delete the pre-existing directory it resolves to', async () => {
  await resetGitLog();
  const victim = await victimDir('clone-victim');
  const raw = `${victim}/acme/..`;
  const before = await projectPaths();

  const res = await withFailingGit(() =>
    api(server, 'POST', '/api/projects/clone', { url: 'https://example.invalid/acme/api.git', dest: raw }),
  );

  assert.equal(res.status, 409, `expected the no-clobber 409, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(
    (res.body as { error?: string }).error,
    'directory already exists and is not empty',
    'the existing error vocabulary, not a new one',
  );
  assert.equal(await readFile(join(victim, 'precious.txt'), 'utf8'), 'do not delete\n');
  assert.equal(await readFile(join(victim, 'sub', 'more.txt'), 'utf8'), 'also precious\n');
  assert.equal(existsSync(join(victim, 'acme')), false, 'nothing was materialised for the raw string');
  assert.deepEqual(await gitLog(), [], 'git never ran');
  assert.deepEqual(await projectPaths(), before, 'nothing was registered');
});

test('clone: git receives the RESOLVED dest and the RESOLVED path is what gets registered', async () => {
  await resetGitLog();
  const landing = await landingDir('clone-ok');
  const raw = `${landing}/acme/..`;

  const res = await api(server, 'POST', '/api/projects/clone', {
    url: 'https://example.invalid/acme/api.git',
    dest: raw,
  });

  assert.equal(res.status, 201, `expected 201, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal((res.body as Project).path, landing, 'projects.json stores the resolved dest');
  assert.deepEqual(
    (await gitLog()).map((g) => [g.sub, g.last]),
    [['clone', landing]],
    'the last git argument is the RESOLVED dest, never the `..` string',
  );
  assert.equal(existsSync(join(landing, '.git')), true, 'the clone landed in the resolved directory');
  assert.equal(existsSync(join(landing, 'acme')), false, 'no directory was materialised for the raw string');
  assert.equal((await projectPaths()).includes(raw), false, 'never registered under the un-normalized dest');
});

test('clone: a failed clone cleans up via the resolved dest and never touches a pre-existing one', async () => {
  await resetGitLog();
  const landing = await landingDir('clone-cleanup');
  const before = await projectPaths();

  // (A) a dest WE created (`<landing>/acme/../fresh` → `<landing>/fresh`) is removed.
  const created = await withFailingGit(() =>
    api(server, 'POST', '/api/projects/clone', {
      url: 'https://example.invalid/acme/api.git',
      dest: `${landing}/acme/../fresh`,
    }),
  );
  assert.equal(created.status, 500, `expected 500, got ${created.status} ${JSON.stringify(created.body)}`);
  assert.deepEqual(
    (await gitLog()).map((g) => [g.sub, g.last]),
    [['clone', join(landing, 'fresh')]],
    'git cloned into the resolved dest',
  );
  assert.equal(existsSync(join(landing, 'fresh')), false, 'the partial dest we created is cleaned up');
  assert.equal(existsSync(join(landing, 'acme')), false, 'the raw string materialised nothing');

  // (B) the pre-existing `<landing>` itself is NEVER removed.
  await resetGitLog();
  const preexisting = await withFailingGit(() =>
    api(server, 'POST', '/api/projects/clone', {
      url: 'https://example.invalid/acme/api.git',
      dest: `${landing}/acme/..`,
    }),
  );
  assert.equal(preexisting.status, 500, `expected 500, got ${preexisting.status} ${JSON.stringify(preexisting.body)}`);
  assert.equal(existsSync(landing), true, 'the pre-existing directory survives the failure cleanup');
  assert.deepEqual(
    (await gitLog()).map((g) => [g.sub, g.last]),
    [['clone', landing]],
    'git cloned into the resolved dest',
  );
  assert.deepEqual(await projectPaths(), before, 'no failed clone registers a project');
});
