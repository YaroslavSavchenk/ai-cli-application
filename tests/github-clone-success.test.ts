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
import type { Project } from '../shared/protocol.ts';

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
 *   out: `argv`  — one received argument per line
 *        `askpass` — MATCH / MISMATCH: whether EXECUTING $GIT_ASKPASS returned
 *                    exactly $AI_SM_GH_TOKEN. The token itself is never written.
 *        `env`    — the non-secret env facts worth asserting
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

if [ -f "$out/fail" ]; then
  mkdir -p "$dest"
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

test('after every clone in this file: server.log carries neither the token nor an Authorization header', async () => {
  const log = await readServerLog(server);
  assert.ok(log.length > 0, 'the server logged something (so this assertion is meaningful)');
  assert.ok(!log.includes(SECRET), 'the OAuth token must never reach server.log');
  assert.ok(!log.includes('Bearer'), 'no Authorization header is ever logged');
  assert.ok(!log.includes('gho_'), 'no credential-shaped string in the log');
});
