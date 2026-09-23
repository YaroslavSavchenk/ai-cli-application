/**
 * GET /api/git/changes — what a repository may NOT make this backend do, and
 * what this backend may not do to a repository (security review, 2026-09-16),
 * plus the registered-project anchor of the tab's boundary (B2).
 *
 * How: a real server child whose home boundary is the fixture tree
 * (AI_SM_HOME_OVERRIDE), against repositories whose .git/config is hostile —
 * a `core.fsmonitor` program, a promisor remote's transport — each first
 * proven real with a PLAIN git in the same repository. The fsmonitor override
 * is also pinned in `server/git.ts`'s source, because `false` and `true` look
 * the same from outside.
 *
 * Why: .git/config travels with a clone — opening the Changes tab must never
 * run its code, nor rewrite its `.git/index` behind the user's back.
 *
 * NOT claimed here: the parsers, the route's answers, the caps and the log
 * hygiene — `tests/server/git-changes.test.ts`.
 *
 * Split out of `tests/server/git-changes.test.ts` by topic (PLAN-RESTRUCTURE
 * O6); the shared setup is `tests/helpers/git-changes-fixture.ts`.
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitChangesResponse, Project } from '../../shared/protocol.ts';
import { GIT_READ_FAILED } from '../../server/git.ts';
import {
  api,
  type TestServer,
  sleep,
  removeTempDir,
  readSource,
  git,
} from '../helpers/helpers.ts';
import {
  changes,
  fileOf,
  makeChangesHome,
  startChangesServer,
} from '../helpers/git-changes-fixture.ts';

/**
 * A clock-separation wait, deliberate (tests/README.md § Time): git treats an
 * index entry whose mtime is not older than the index itself as "racily
 * clean" and re-hashes it, so the rewrite must land in an EARLIER second than
 * the status run. One second of timestamp granularity plus 100 ms of margin.
 */
const RACY_TIMESTAMP_WAIT_MS = 1100;

let server: TestServer;
let root: string;
let home: string;

before(async () => {
  ({ root, home } = await makeChangesHome());
  server = await startChangesServer({ root, home });
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (root !== undefined) await removeTempDir(root);
});

// ---------------------------------------------------------------------------
// 4. What a repository may NOT make this backend do, and what this backend may
//    not do to a repository (security review, 2026-09-16)
// ---------------------------------------------------------------------------

test('a repository-local core.fsmonitor is NOT executed by a changes call', async () => {
  // MEASURED (git 2.43.0): `core.fsmonitor` set to a path names a program that
  // `git status` and `git diff` RUN. Cloning a repository and opening the
  // Changes tab on it would therefore run whatever its .git/config points at —
  // and .git/config travels with nothing a clone refuses. The module kills it
  // with GIT_CONFIG_COUNT/KEY_0/VALUE_0 = core.fsmonitor=false in the spawn
  // env (the env form, so every subcommand added later is covered too).
  const hostile = join(home, 'hostile-repo');
  const marker = join(root, 'FSMONITOR_RAN');
  await mkdir(hostile);
  git(hostile, 'init', '-q', '-b', 'main');
  await writeFile(join(hostile, 'a.txt'), 'a\n');
  git(hostile, 'add', '-A');
  git(hostile, 'commit', '-qm', 'init');

  const hook = join(hostile, 'fsmonitor-hook.sh');
  await writeFile(hook, ['#!/bin/sh', `touch ${marker}`, 'exit 1', ''].join('\n'), { mode: 0o755 });
  await chmod(hook, 0o755);
  // Written into .git/config exactly as a hostile repository would carry it.
  git(hostile, 'config', 'core.fsmonitor', hook);
  await writeFile(join(hostile, 'a.txt'), 'a\nb\n'); // so status has work to do

  // Non-vacuity: prove the hook DOES run for a plain git in this repository,
  // or this test would pass just as well if the config were ignored.
  execFileSync('git', ['status', '--porcelain'], { cwd: hostile, encoding: 'utf8' });
  assert.equal(existsSync(marker), true, 'the fixture is real: a plain git runs the hook');
  await rm(marker);

  const res = await changes(server, hostile);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(fileOf(res.body, 'a.txt')?.status, 'modified', 'and it still answers the truth');
  assert.equal(existsSync(marker), false, 'the repository’s own program was NOT run');
});

test('a PROMISOR remote cannot make a changes call fetch — and so cannot run the transport it names', async () => {
  // Found by the B3 security review (2026-09-21) against the SHIPPED B2 route,
  // not against B3's new ones. A PARTIAL CLONE (`extensions.partialClone`,
  // `remote.origin.promisor=true`) is allowed to go and FETCH a missing object
  // in the middle of a read — and the transport it uses is a PROGRAM its own
  // .git/config names (`remote.origin.uploadpack`, `core.sshCommand`). Opening
  // the Changes tab on a cloned repository would run it; .git/config travels
  // with nothing a clone refuses. `GIT_NO_LAZY_FETCH=1` in GIT_ENV is the fix.
  //
  // MEASURED (git 2.43.0): `git diff --numstat -z HEAD` — this module's own
  // call — ran the script with nothing but a modified working-tree file.
  const donor = join(root, 'promisor-donor');
  await mkdir(donor);
  git(donor, 'init', '-q', '-b', 'main');
  await writeFile(join(donor, 'f.txt'), 'l1\nl2\nl3\n');
  git(donor, 'add', '-A');
  git(donor, 'commit', '-qm', 'one');

  const work = join(home, 'promisor-repo');
  execFileSync('git', ['clone', '-q', donor, work], { encoding: 'utf8' });
  const marker = join(root, 'UPLOADPACK_RAN');
  const hook = join(root, 'uploadpack.sh');
  await writeFile(hook, ['#!/bin/sh', `touch ${marker}`, 'exit 1', ''].join('\n'), { mode: 0o755 });
  await chmod(hook, 0o755);
  git(work, 'config', 'extensions.partialClone', 'origin');
  git(work, 'config', 'remote.origin.promisor', 'true');
  git(work, 'config', 'remote.origin.uploadpack', hook);
  const blob = execFileSync('git', ['rev-parse', 'HEAD:f.txt'], { cwd: work, encoding: 'utf8' }).trim();
  await rm(join(work, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  // The modified working-tree file is all `git diff --numstat HEAD` needs to
  // want the missing blob.
  await writeFile(join(work, 'f.txt'), 'l1\nl2\nl3\nl4\n');

  // Non-vacuity: a plain git, on this fixture, runs the script.
  try {
    execFileSync('git', ['diff', '--numstat', 'HEAD'], { cwd: work, stdio: 'ignore' });
  } catch {
    // Exit 128 — the fetch it tried failed. The marker is the point.
  }
  assert.equal(existsSync(marker), true, 'the fixture is real: a plain git fetches');
  await rm(marker);

  const res = await changes(server, work);
  assert.equal(res.status, 500, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: GIT_READ_FAILED });
  assert.equal(existsSync(marker), false, 'the repository’s own transport was NOT run');
});

test('the fsmonitor override is `false`, not `true` — pinned in the source, and why', () => {
  // The behavioural test above proves the repository's OWN program is not run.
  // It cannot tell `core.fsmonitor=false` from `core.fsmonitor=true`: `true`
  // also ignores the repository's hook — it selects git's BUILT-IN fsmonitor
  // instead, which starts a `git fsmonitor--daemon` background process against
  // the repository being read (MEASURED on this host: no daemon is started for
  // a single call, so nothing observable through the route changes, which is
  // exactly why a behavioural test cannot hold this line down). A read-only tab
  // that polls every 5 s must start no daemon in the user's repository, so the
  // value is pinned here, with the reason, rather than left to drift.
  const src = readSource('server/git.ts');
  assert.match(src, /GIT_CONFIG_COUNT: '1'/, 'exactly one -c equivalent');
  assert.match(src, /GIT_CONFIG_KEY_0: 'core\.fsmonitor'/, 'and it is core.fsmonitor');
  assert.match(src, /GIT_CONFIG_VALUE_0: 'false'/, 'set to false — never true, never a program');
  assert.match(src, /GIT_OPTIONAL_LOCKS: '0'/, 'and the index is never rewritten');
  assert.match(src, /GIT_NO_LAZY_FETCH: '1'/, 'and no read ever contacts a promisor remote');
  // The env is built ONCE and spread into the spawn: a second literal would be
  // a second posture nobody reviewed.
  assert.equal([...src.matchAll(/GIT_CONFIG_VALUE_0/g)].length, 1, 'one definition of the value');
  assert.match(src, /env: \{ \.\.\.process\.env, \.\.\.GIT_ENV \}/, 'and every spawn gets it');
});

test('a changes call never rewrites .git/index — GIT_OPTIONAL_LOCKS=0', async () => {
  // MEASURED: a plain `git status` refreshes the index's stat cache and
  // REWRITES .git/index (its mtime moves), taking index.lock to do it. A tab
  // that polls every 5 s must not fight the user's own git for that lock, and
  // has no business writing in their repository at all.
  const quiet = join(home, 'quiet-repo');
  await mkdir(quiet);
  git(quiet, 'init', '-q', '-b', 'main');
  await writeFile(join(quiet, 'a.txt'), 'a\nb\n');
  git(quiet, 'add', '-A');
  git(quiet, 'commit', '-qm', 'init');

  // Rewrite the file with IDENTICAL content: the stat data changes, the
  // content does not, which is exactly the state a plain `git status` answers
  // by refreshing the index.
  await writeFile(join(quiet, 'a.txt'), 'a\nb\n');
  await sleep(RACY_TIMESTAMP_WAIT_MS); // past git's racy-timestamp window
  const before_ = (await stat(join(quiet, '.git', 'index'))).mtimeMs;

  const res = await changes(server, quiet);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual((res.body as GitChangesResponse).files, [], 'the same answer, nothing changed');
  const after_ = (await stat(join(quiet, '.git', 'index'))).mtimeMs;
  assert.equal(after_, before_, 'the index was not rewritten');
  assert.equal(existsSync(join(quiet, '.git', 'index.lock')), false, 'and no lock is left behind');

  // Non-vacuity: the SAME state, through a plain git, does move it.
  await writeFile(join(quiet, 'a.txt'), 'a\nb\n');
  await sleep(RACY_TIMESTAMP_WAIT_MS);
  const beforePlain = (await stat(join(quiet, '.git', 'index'))).mtimeMs;
  execFileSync('git', ['status', '--porcelain'], { cwd: quiet, encoding: 'utf8' });
  assert.notEqual(
    (await stat(join(quiet, '.git', 'index'))).mtimeMs,
    beforePlain,
    'the fixture is real: a plain git DOES rewrite the index here',
  );
});

test('a repository in a registered project OUTSIDE home answers changes; unregistering it takes that back', async () => {
  // The Changes tab is bounded by the same anchor list as the listing routes
  // (user decision 2026-09-16): home OR any registered project path.
  const outside = join(root, 'outside-repo');
  await mkdir(outside);
  git(outside, 'init', '-q', '-b', 'main');
  await writeFile(join(outside, 'a.txt'), 'a\n');
  git(outside, 'add', '-A');
  git(outside, 'commit', '-qm', 'init');
  await writeFile(join(outside, 'a.txt'), 'a\nb\n');

  const before_ = await changes(server, outside);
  assert.equal(before_.status, 403, 'unregistered, it is outside every anchor');
  assert.deepEqual(before_.body, { error: 'This folder is outside your home folder.' });

  const created = await api(server, 'POST', '/api/projects', { name: 'Outside repo', path: outside });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const project = created.body as Project;
  try {
    const res = await changes(server, outside);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const body = res.body as GitChangesResponse;
    assert.equal(body.isRepo, true);
    assert.equal(body.repoRoot, outside);
    assert.equal(body.branch, 'main');
    assert.deepEqual(fileOf(body, 'a.txt'), { path: 'a.txt', add: 1, del: 0, status: 'modified' });

    // The prefix trap, per anchor.
    const trap = `${outside}evil`;
    await mkdir(trap);
    assert.equal((await changes(server, trap)).status, 403, `${trap} is not under ${outside}`);
  } finally {
    assert.equal((await api(server, 'DELETE', `/api/projects/${project.id}`)).status, 200);
  }

  assert.equal((await changes(server, outside)).status, 403, 'and the anchor leaves with the project');
});
