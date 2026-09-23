/**
 * GET /api/git/commits, /api/git/commit, /api/git/commit-diff — what a
 * REPOSITORY must not be able to make this backend do: run a program its
 * config names (textconv, an external diff, a signature program, a promisor
 * remote's transport), colour or re-encode the output this backend parses, or
 * turn every commit into a 500 with a missing order file; and the source pins
 * of the shared runner that promise it (B3, spec
 * `.claude/plans/nocturne/PLAN-B3.md` § "Phase 1 — backend").
 *
 * How: a real server child whose home boundary is the fixture tree
 * (AI_SM_HOME_OVERRIDE), against repositories whose .git/config is hostile.
 * Every case first proves the fixture is real — a PLAIN git in the same
 * repository does run the script / paint the patch / fail — then that the
 * routes do not. The last test reads `server/git.ts` and `server/git-log.ts`
 * as text, because a flag that pins today's default is invisible to behaviour.
 *
 * Why: .git/config travels with a clone. Opening a cloned repository's
 * Commits tab must never run its code.
 *
 * NOT claimed here: the answers for a friendly repository
 * (`git-commits-routes.test.ts`), the client-string gates
 * (`git-commits-gates.test.ts`).
 *
 * Split out of `tests/server/git-commits.test.ts` by topic (PLAN-RESTRUCTURE
 * O6); the fixture home and the request helpers are
 * `tests/helpers/git-commits-fixture.ts`.
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  GitCommitDiffResponse,
  GitCommitResponse,
  GitCommitsResponse,
} from '../../shared/protocol.ts';
import { GIT_COMMIT_GONE } from '../../server/git-log.ts';
import {
  readServerLog,
  waitForLog,
  type TestServer,
  removeTempDir,
  git,
  readSource,
} from '../helpers/helpers.ts';
import {
  commit,
  commitDiff,
  commits,
  gitAs,
  makeCommitsFixture,
  revOf,
  startCommitsServer,
} from '../helpers/git-commits-fixture.ts';

let server: TestServer;
let root: string;
let home: string;

before(async () => {
  ({ root, home } = await makeCommitsFixture());
  server = await startCommitsServer({ root, home });
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (root !== undefined) await removeTempDir(root);
});

// ---------------------------------------------------------------------------
// 7. What a repository may NOT make this backend do
// ---------------------------------------------------------------------------

test('textconv, ext-diff and a signature program are NOT executed by any of the three routes', async () => {
  // MEASURED (git 2.43.0, 2026-09-21), each with a marker file:
  //   * `log.showSignature=true` + `gpg.program=<script>` RUNS the script for a
  //     plain `git log -1 --format='%H %s'` on a commit with a gpgsig header;
  //   * `.gitattributes` `*.log diff=drv` + `diff.drv.textconv=<script>` RUNS
  //     it for `git show <rev> -- t.log`;
  //   * `diff.external` / `diff.drv.command` run for `git diff` and for
  //     `--ext-diff`.
  // Cloning a repository and opening its Commits tab would therefore run
  // whatever its .git/config points at, and .git/config travels with a clone.
  const hostile = join(home, 'hostile-repo');
  await mkdir(hostile);
  const markers = join(root, 'markers');
  await mkdir(markers);
  const script = async (name: string): Promise<string> => {
    const p = join(hostile, `${name}.sh`);
    await writeFile(p, ['#!/bin/sh', `touch ${join(markers, name.toUpperCase())}`, 'echo CONVERTED', 'exit 0', ''].join('\n'), { mode: 0o755 });
    await chmod(p, 0o755);
    return p;
  };
  git(hostile, 'init', '-q', '-b', 'main');
  await writeFile(join(hostile, 'a.log'), 'l1\nl2\n');
  git(hostile, 'add', '-A');
  git(hostile, 'commit', '-qm', 'one');
  await writeFile(join(hostile, 'a.log'), 'l1\nl2\nl3\n');
  await writeFile(join(hostile, '.gitattributes'), '*.log diff=drv\n');
  git(hostile, 'add', '-A');
  git(hostile, 'commit', '-qm', 'two');
  git(hostile, 'config', 'diff.drv.textconv', await script('textconv'));
  git(hostile, 'config', 'diff.external', await script('extdiff'));
  git(hostile, 'config', 'log.showSignature', 'true');
  git(hostile, 'config', 'gpg.program', await script('gpg'));
  const hostileHead = revOf(hostile, 'HEAD');

  // Non-vacuity: the SAME repository DOES run two of them for a plain git.
  execFileSync('git', ['show', '--format=', hostileHead, '--', 'a.log'], { cwd: hostile });
  assert.equal(existsSync(join(markers, 'TEXTCONV')), true, 'the fixture is real: textconv runs');
  execFileSync('git', ['diff', 'HEAD~1', 'HEAD'], { cwd: hostile });
  assert.equal(existsSync(join(markers, 'EXTDIFF')), true, 'the fixture is real: diff.external runs');
  await rm(join(markers, 'TEXTCONV'));
  await rm(join(markers, 'EXTDIFF'));

  // A SIGNED commit, or the gpg half of this test proves nothing: with an
  // unsigned history git never calls `gpg.program`, so the marker stays absent
  // whether `--no-show-signature` is passed or not. `git commit -S` needs a
  // real key, so the commit object is written by hand with a `gpgsig` header —
  // git reads the header, not the key, to decide whether to VERIFY.
  const signedBuf = [
    `tree ${execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: hostile, encoding: 'utf8' }).trim()}`,
    `parent ${hostileHead}`,
    'author T <t@example.com> 1700000000 +0000',
    'committer T <t@example.com> 1700000000 +0000',
    'gpgsig -----BEGIN PGP SIGNATURE-----',
    ' ',
    ' fake',
    ' -----END PGP SIGNATURE-----',
    '',
    'a signed commit',
    '',
  ].join('\n');
  const signedHash = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    cwd: hostile,
    input: signedBuf,
    encoding: 'utf8',
  }).trim();
  git(hostile, 'update-ref', 'refs/heads/main', signedHash);

  // NON-VACUITY for the gpg claim: a plain `git log -1 --format=%H` on that
  // commit, in this repository, DOES run the program.
  execFileSync('git', ['log', '-1', '--format=%H', signedHash], { cwd: hostile, encoding: 'utf8' });
  assert.equal(existsSync(join(markers, 'GPG')), true, 'the fixture is real: gpg.program runs');
  await rm(join(markers, 'GPG'));

  const list = await commits(server, { root: hostile });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal((list.body as GitCommitsResponse).commits.length, 3, 'and it still answers the truth');
  assert.equal((list.body as GitCommitsResponse).commits[0]?.subject, 'a signed commit');
  const one = await commit(server, { root: hostile, hash: hostileHead });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  const signedOne = await commit(server, { root: hostile, hash: signedHash });
  assert.equal(signedOne.status, 200, JSON.stringify(signedOne.body));
  const diff = await commitDiff(server, { root: hostile, hash: hostileHead, path: 'a.log' });
  assert.equal(diff.status, 200, JSON.stringify(diff.body));
  const rows = (diff.body as GitCommitDiffResponse).lines;
  assert.deepEqual(
    rows.map((r) => r.text),
    ['@@ -1,2 +1,3 @@', 'l1', 'l2', 'l3'],
    'the REAL file content, not the converter’s `CONVERTED`',
  );
  assert.equal(
    (await commitDiff(server, { root: hostile, hash: signedHash, path: 'a.log' })).status,
    200,
  );

  assert.equal(existsSync(join(markers, 'TEXTCONV')), false, 'the repository’s textconv was NOT run');
  assert.equal(existsSync(join(markers, 'EXTDIFF')), false, 'nor its external diff');
  assert.equal(existsSync(join(markers, 'GPG')), false, 'nor its signature program');
});

test('a repository that forces COLOUR on cannot colour the rows this backend parses', async () => {
  // MEASURED (git 2.43.0): `color.ui=always` colours a patch even with no tty —
  // the hunk header comes back as `ESC[36m@@ -1 +1,2 @@ESC[m` and every row
  // carries its own escapes. parseUnifiedDiff decides a hunk header by
  // `startsWith('@@')`, so a coloured header is not a header: the whole file
  // would answer NO ROWS AT ALL — indistinguishable, in the panel, from a
  // commit that did not touch the file. `--no-color` is what pins it.
  const coloured = join(home, 'colour-repo');
  await mkdir(coloured);
  git(coloured, 'init', '-q', '-b', 'main');
  await writeFile(join(coloured, 'a.txt'), 'l1\n');
  git(coloured, 'add', '-A');
  git(coloured, 'commit', '-qm', 'first');
  await writeFile(join(coloured, 'a.txt'), 'l1\nl2\n');
  git(coloured, 'add', '-A');
  git(coloured, 'commit', '-qm', 'second');
  git(coloured, 'config', 'color.ui', 'always');
  git(coloured, 'config', 'color.diff', 'always');
  git(coloured, 'config', 'color.status', 'always');
  const head = revOf(coloured, 'HEAD');

  // NON-VACUITY: a plain git in this repository DOES paint the patch.
  const painted = execFileSync('git', ['log', '-1', '--patch', '--format=', head, '--', 'a.txt'], {
    cwd: coloured,
    encoding: 'utf8',
  });
  assert.ok(painted.includes('\u001B['), 'the fixture is real: git writes escapes here');

  const diff = await commitDiff(server, { root: coloured, hash: head, path: 'a.txt' });
  assert.equal(diff.status, 200, JSON.stringify(diff.body));
  assert.deepEqual((diff.body as GitCommitDiffResponse).lines, [
    { kind: 'hunk', oldNo: null, newNo: null, text: '@@ -1 +1,2 @@' },
    { kind: 'ctx', oldNo: 1, newNo: 1, text: 'l1' },
    { kind: 'add', oldNo: null, newNo: 2, text: 'l2' },
  ]);

  // And nothing that survived an escape sequence (the ESC itself is a control
  // byte `strip` removes — the `[36m` it leaves behind would not be).
  const list = (await commits(server, { root: coloured })).body as GitCommitsResponse;
  assert.deepEqual(list.commits.map((c) => c.subject), ['second', 'first']);
  assert.equal(JSON.stringify(list).includes('[3'), false, 'no half-eaten escape in a subject');
  assert.equal(JSON.stringify(diff.body).includes('[3'), false, 'nor in a diff row');
});

test('a repository that re-encodes its log output cannot put invalid UTF-8 in a response', async () => {
  // MEASURED (git 2.43.0): with `i18n.logOutputEncoding=ISO-8859-1`, `%s` comes
  // back as LATIN-1 BYTES — `café` as `caf\xE9` — which is not valid UTF-8, so
  // the decoded response carries U+FFFD where the user's character was.
  // `--encoding=UTF-8` on every log call is what pins it.
  const latin1 = join(home, 'latin1-repo');
  await mkdir(latin1);
  git(latin1, 'init', '-q', '-b', 'main');
  await writeFile(join(latin1, 'a.txt'), 'a\n');
  gitAs(latin1, 'Café Ávila', 'add', '-A');
  gitAs(latin1, 'Café Ávila', 'commit', '-qm', 'café subject', '-m', 'naïve body');
  git(latin1, 'config', 'i18n.logOutputEncoding', 'ISO-8859-1');
  const head = revOf(latin1, 'HEAD');

  // NON-VACUITY: a plain git here answers bytes that are not UTF-8.
  const raw = execFileSync('git', ['log', '-1', '--format=%s', head], { cwd: latin1 });
  assert.equal(raw.includes(Buffer.from([0xe9])), true, 'the fixture is real: latin-1 on the wire');

  const list = (await commits(server, { root: latin1 })).body as GitCommitsResponse;
  assert.equal(list.commits[0]?.subject, 'café subject');
  assert.equal(list.commits[0]?.author, 'Café Ávila');
  const one = (await commit(server, { root: latin1, hash: head })).body as GitCommitResponse;
  assert.equal(one.commit.subject, 'café subject');
  assert.equal(one.body, 'naïve body');
  assert.equal(
    JSON.stringify(one).includes('\uFFFD'),
    false,
    'not one replacement character: the response is the text the user wrote',
  );
});

test('a PROMISOR remote cannot make a read call fetch — and so cannot run the transport it names', async () => {
  // The third way a repository can run a program, and the one the `--no-*`
  // flags do not touch. A PARTIAL CLONE (`extensions.partialClone=origin`,
  // `remote.origin.promisor=true`) is allowed to go and FETCH a missing object
  // mid-read, and the transport it uses is a PROGRAM its own .git/config names
  // (`remote.origin.uploadpack`, or `core.sshCommand` for an ssh url). Clone a
  // repository, open its Commits tab, run its code.
  //
  // MEASURED (git 2.43.0) with this module's exact env and flags: the list
  // call, the HASH GATE on an absent hash, and B2's shipped
  // `git diff --numstat -z HEAD` all ran the script. `GIT_NO_LAZY_FETCH=1` is
  // the fix; the residual is in server/git.ts's GIT_ENV comment.
  const donor = join(root, 'promisor-donor');
  await mkdir(donor);
  git(donor, 'init', '-q', '-b', 'main');
  await writeFile(join(donor, 'f.txt'), 'l1\nl2\nl3\n');
  git(donor, 'add', '-A');
  git(donor, 'commit', '-qm', 'one');
  await writeFile(join(donor, 'f.txt'), 'l1\nl2\nl3\nl4\n');
  git(donor, 'add', '-A');
  git(donor, 'commit', '-qm', 'two');

  const work = join(home, 'promisor-repo');
  execFileSync('git', ['clone', '-q', donor, work], { encoding: 'utf8' });
  const markers = join(root, 'promisor-markers');
  await mkdir(markers);
  const script = async (name: string): Promise<string> => {
    const p = join(root, `${name}.sh`);
    await writeFile(p, ['#!/bin/sh', `touch ${join(markers, name.toUpperCase())}`, 'exit 1', ''].join('\n'), { mode: 0o755 });
    await chmod(p, 0o755);
    return p;
  };
  git(work, 'config', 'extensions.partialClone', 'origin');
  git(work, 'config', 'remote.origin.promisor', 'true');
  git(work, 'config', 'remote.origin.uploadpack', await script('uploadpack'));
  const workHead = revOf(work, 'HEAD');
  // ONE blob of HEAD, deleted out of the object store: exactly the state a
  // partial clone is in for every blob it has not fetched yet.
  const blob = execFileSync('git', ['rev-parse', 'HEAD:f.txt'], { cwd: work, encoding: 'utf8' }).trim();
  await rm(join(work, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));

  // NON-VACUITY: a plain git, on this fixture, runs the script.
  try {
    execFileSync('git', ['log', '-1', '--numstat', '--format=%H', 'HEAD'], { cwd: work, stdio: 'ignore' });
  } catch {
    // Exit 128 — the fetch it tried failed. The marker is the point.
  }
  assert.equal(existsSync(join(markers, 'UPLOADPACK')), true, 'the fixture is real: a plain git fetches');
  await rm(join(markers, 'UPLOADPACK'));

  // 1. The LIST route.
  const list = await commits(server, { root: work });
  assert.equal(list.status, 500, JSON.stringify(list.body));
  assert.deepEqual(list.body, { error: 'The app could not read this repository.' });
  assert.equal(existsSync(join(markers, 'UPLOADPACK')), false, 'the list call fetched nothing');

  // 2. The HASH GATE, on a hash this repository does not have — the earliest
  //    point a client string reaches git, and it fetched too.
  const absent = await commit(server, { root: work, hash: '1'.repeat(40) });
  assert.equal(absent.status, 404, JSON.stringify(absent.body));
  assert.deepEqual(absent.body, { error: GIT_COMMIT_GONE });
  assert.equal(existsSync(join(markers, 'UPLOADPACK')), false, 'nor did the hash gate');
  // Non-vacuity for this one specifically.
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${'1'.repeat(40)}^{commit}`], {
      cwd: work,
      stdio: 'ignore',
    });
  } catch {
    // exit 1 is the normal answer here.
  }
  assert.equal(existsSync(join(markers, 'UPLOADPACK')), true, 'the fixture is real for rev-parse too');
  await rm(join(markers, 'UPLOADPACK'));

  // 3. The ssh spelling: no uploadpack, an ssh url and core.sshCommand.
  git(work, 'config', '--unset', 'remote.origin.uploadpack');
  git(work, 'config', 'remote.origin.url', 'ssh://x/repo.git');
  git(work, 'config', 'core.sshCommand', await script('sshcommand'));
  try {
    execFileSync('git', ['log', '-1', '--numstat', '--format=%H', 'HEAD'], { cwd: work, stdio: 'ignore' });
  } catch {
    // Same: the marker is the point.
  }
  assert.equal(existsSync(join(markers, 'SSHCOMMAND')), true, 'the fixture is real: core.sshCommand runs');
  await rm(join(markers, 'SSHCOMMAND'));

  assert.equal((await commits(server, { root: work })).status, 500);
  assert.equal((await commit(server, { root: work, hash: workHead })).status, 500);
  assert.equal(
    (await commitDiff(server, { root: work, hash: workHead, path: 'f.txt' })).status,
    500,
  );
  assert.equal(existsSync(join(markers, 'SSHCOMMAND')), false, 'no route ran the ssh transport');

  // And the remote url — which is where a token would live — is in no log line.
  await waitForLog(server, '[git] GET /api/git/commit-diff -> 500');
  const log = await readServerLog(server);
  assert.equal(log.includes('ssh://x/repo.git'), false, 'the remote url reaches no log line');
});

test('a repo-local diff.orderFile naming a missing file does not turn every commit into a 500', async () => {
  // MEASURED (git 2.43.0): `diff.orderFile=/nonexistent/order/file` makes
  // `git log --numstat` exit 128 — which these routes answer as the constant
  // 500, for a repository that is otherwise perfectly readable. `-O/dev/null`
  // is an EMPTY order file on the argv and it wins: exit 0, and the numstat
  // order is byte-identical to the order with no orderFile at all.
  const ordered = join(home, 'orderfile-repo');
  await mkdir(ordered);
  git(ordered, 'init', '-q', '-b', 'main');
  await writeFile(join(ordered, 'a.txt'), 'a\n');
  await writeFile(join(ordered, 'm.txt'), 'm\n');
  await writeFile(join(ordered, 'z.txt'), 'z\n');
  git(ordered, 'add', '-A');
  git(ordered, 'commit', '-qm', 'three files');
  git(ordered, 'config', 'diff.orderFile', '/nonexistent/order/file');
  const orderedHead = revOf(ordered, 'HEAD');

  // NON-VACUITY: a plain git in this repository cannot read it either.
  assert.throws(
    () => execFileSync('git', ['log', '-1', '--numstat', '--format='], { cwd: ordered, stdio: 'ignore' }),
    'the fixture is real: a plain git exits non-zero here',
  );

  const list = await commits(server, { root: ordered });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal((list.body as GitCommitsResponse).commits[0]?.files, 3);
  const one = (await commit(server, { root: ordered, hash: orderedHead })).body as GitCommitResponse;
  assert.deepEqual(
    one.files.map((f) => f.path),
    ['a.txt', 'm.txt', 'z.txt'],
    'and the order is git’s own default, not a repository’s choosing',
  );
  const diff = await commitDiff(server, { root: ordered, hash: orderedHead, path: 'z.txt' });
  assert.equal(diff.status, 200, JSON.stringify(diff.body));

  // A WORKING order file is overridden back to the default too — one shape of
  // output, whatever the repository wants.
  await writeFile(join(ordered, 'order'), 'z.txt\n');
  git(ordered, 'config', 'diff.orderFile', join(ordered, 'order'));
  const reordered = (await commit(server, { root: ordered, hash: orderedHead })).body as GitCommitResponse;
  assert.deepEqual(reordered.files.map((f) => f.path), ['a.txt', 'm.txt', 'z.txt']);
});

test('the shared runner and the new env entries are pinned in server/git.ts', async () => {
  // The behavioural tests above cannot tell `--no-ext-diff` (which pins today's
  // DEFAULT for log/show) from nothing at all, and cannot see which env the
  // spawn is handed. Both are the promise, so both are pinned here.
  const src = readSource('server', 'git.ts');
  assert.match(src, /GIT_LITERAL_PATHSPECS: '1'/, 'a pathspec is a file name, never a pattern');
  assert.match(src, /GIT_NO_LAZY_FETCH: '1'/, 'a promisor remote is never contacted mid-read');
  assert.match(src, /LC_ALL: 'C'/);
  assert.match(src, /env: \{ \.\.\.process\.env, \.\.\.GIT_ENV \}/, 'and every spawn gets it');
  assert.equal([...src.matchAll(/spawn\(/g)].length, 1, 'still exactly one spawn site in the runner');

  const logSrc = readSource('server', 'git-log.ts');
  assert.equal(/spawn\(/.test(logSrc), false, 'the commit module spawns nothing of its own');
  assert.equal(/shell:\s*true/.test(logSrc), false, 'and composes no command line');
  for (const flag of [
    '--no-show-signature',
    '--no-notes',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--diff-merges=first-parent',
    '--encoding=UTF-8',
    '-O/dev/null',
  ]) {
    assert.ok(logSrc.includes(`'${flag}'`), `${flag} is passed on every log call`);
  }
  // `--no-walk` is on every `-1` call and on NO other: the list call is meant
  // to walk, and a `--no-walk` there would answer one commit for every page.
  assert.match(logSrc, /const NO_WALK = '--no-walk';/);
  assert.equal(
    [...logSrc.matchAll(/'log',\s*'-1',\s*NO_WALK/g)].length,
    3,
    'all three `-1` calls carry it',
  );
  assert.equal(
    [...logSrc.matchAll(/'log',\s*'-1'(?!,\s*NO_WALK)/g)].length,
    0,
    'and no `-1` call is missing it',
  );
});
