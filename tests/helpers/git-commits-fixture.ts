/**
 * The shared fixture of the `tests/server/git-commits*.test.ts` files — the
 * B3 routes GET /api/git/commits, /api/git/commit and /api/git/commit-diff
 * (spec `.claude/plans/nocturne/PLAN-B3.md` § "Phase 1 — backend").
 *
 * `makeCommitsFixture()` builds, under one temp root, the fixture HOME every
 * route test drives: the `repo` with one commit per shape the routes answer
 * for (a binary file, a rename, a hostile subject and author, two people, a
 * file past the diff cap, a merge, a commit past the file cap, a patch past
 * the runner's stdout cap), the 15-commit `paging` repository, and the other
 * states (a plain folder, an empty and a detached repository, a remote with a
 * TOKEN in its url, a remote that is not github.com). Each test file boots its
 * OWN server child on it (`startCommitsServer`), and the caps file its own
 * child with a fake `git` first on the PATH (`startFakeGitServer`).
 *
 * Moved here out of `tests/server/git-commits.test.ts` when it was split by
 * topic (PLAN-RESTRUCTURE O6); the setup itself is unchanged.
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_COMMIT_FILES, MAX_DIFF_LINES } from '../../server/git-log.ts';
import { api, startTestServer, type TestServer, makeTempDir, git } from './helpers.ts';

/** The record-framing bytes a hostile commit tries to forge a row with. */
export const FORGED_HASH = '0'.repeat(40);
export const HOSTILE_SUBJECT = `pre\u0001${FORGED_HASH}\u0002forged\u0002tail`;
export const HOSTILE_AUTHOR = `Au\u0001${FORGED_HASH}\u0002thor`;

/** A credential in a remote url. It must reach no body, no log line, nothing. */
export const REMOTE_TOKEN = 'ghp_TOKENCANARY_qz0123456789';

/** A file name that must never reach server.log. */
export const PATH_CANARY = 'GITPATHCANARY_qz.txt';

/** git with a chosen author/committer NAME (the hostile-ident fixtures). */
export function gitAs(cwd: string, name: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', `user.name=${name}`, '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
}

export const revOf = (cwd: string, rev: string): string =>
  execFileSync('git', ['rev-parse', rev], { cwd, encoding: 'utf8' }).trim();

/** The temp root, the fixture home inside it, and the two repositories most tests read. */
export interface CommitsFixture {
  root: string;
  home: string;
  repo: string;
  paging: string;
  /** Hashes of the `repo` fixture, newest first. */
  H: Record<string, string>;
}

/** The temp root and the (empty) fixture home — all the fake-git caps need. */
export async function makeCommitsHome(): Promise<{ root: string; home: string }> {
  const root = await realpath(await makeTempDir('ai-sm-gitlog-'));
  const home = join(root, 'home');
  await mkdir(home);
  return { root, home };
}

/** Every repository and folder the route tests drive (no server). */
export async function makeCommitsFixture(): Promise<CommitsFixture> {
  const { root, home } = await makeCommitsHome();
  const repo = join(home, 'repo');
  const H: Record<string, string> = {};
  await mkdir(repo);
  // The PREFIX TRAP: `<home>evil` is a string prefix of home and a real folder.
  await mkdir(`${home}evil`);

  // --- `repo`: one commit per shape the routes have to answer for -----------
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'a.txt'), 'l1\nl2\nl3\nl4\nl5\n');
  await writeFile(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'root commit');
  H['root'] = revOf(repo, 'HEAD');

  await writeFile(join(repo, 'a.txt'), 'l1\nX2\nl3\nl4\nl5\nl6'); // +2 -1, no trailing newline
  await writeFile(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 4, 5]));
  await writeFile(join(repo, PATH_CANARY), 'x\n');
  await writeFile(join(repo, 'long.txt'), `${'Z'.repeat(3000)}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'second subject', '-m', 'body line one\n\nbody line two');
  H['second'] = revOf(repo, 'HEAD');

  await writeFile(join(repo, 'renamed-to.txt'), 'l1\nl2\nl3\nl4\nl5\nl6\n');
  await rm(join(repo, 'a.txt'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'rename a.txt');
  H['rename'] = revOf(repo, 'HEAD');

  // A subject AND an author name carrying the framing bytes a `split('\x01')`
  // parser would forge a record from.
  await writeFile(join(repo, 'hostile.txt'), 'h\n');
  gitAs(repo, HOSTILE_AUTHOR, 'add', '-A');
  gitAs(repo, HOSTILE_AUTHOR, 'commit', '-qm', HOSTILE_SUBJECT);
  H['hostile'] = revOf(repo, 'HEAD');

  // A commit whose COMMITTER name differs from its author's.
  await writeFile(join(repo, 'two-people.txt'), 'p\n');
  git(repo, 'add', '-A');
  execFileSync(
    'git',
    [
      '-c', 'user.name=Committer Name',
      '-c', 'user.email=c@example.com',
      '-c', 'commit.gpgsign=false',
      'commit', '-q', '--author=Author Name <a@example.com>', '-m', 'two people',
    ],
    { cwd: repo, encoding: 'utf8' },
  );
  H['twoPeople'] = revOf(repo, 'HEAD');

  // A file with more changed lines than the diff cap.
  await writeFile(join(repo, 'huge.txt'), `${Array.from({ length: MAX_DIFF_LINES + 500 }, (_, i) => `line ${i}`).join('\n')}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'a huge file');
  H['huge'] = revOf(repo, 'HEAD');

  // A MERGE, so the first-parent rule has something to be right about.
  git(repo, 'checkout', '-q', '-b', 'side', H['second'] as string);
  await writeFile(join(repo, 'side.txt'), 's\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'side commit');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', 'side', '-m', 'merge side');
  H['merge'] = revOf(repo, 'HEAD');

  // A commit with MORE files than the per-commit cap.
  await mkdir(join(repo, 'many'));
  for (let i = 0; i < MAX_COMMIT_FILES + 7; i += 1) {
    await writeFile(join(repo, 'many', `f${String(i).padStart(5, '0')}.txt`), 'x\n');
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'many files');
  H['many'] = revOf(repo, 'HEAD');

  // A file whose PATCH is past the runner's 2 MiB stdout cap while its numstat
  // is two small numbers — the exact case the numstat pre-check exists for.
  await writeFile(
    join(repo, 'flood.txt'),
    `${Array.from({ length: 40_000 }, (_, i) => `line ${i} ${'p'.repeat(50)}`).join('\n')}\n`,
  );
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'a flooding file');
  H['flood'] = revOf(repo, 'HEAD');

  // --- `paging`: 15 plain commits, newest first is c15 ----------------------
  const paging = join(home, 'paging');
  await mkdir(paging);
  git(paging, 'init', '-q', '-b', 'main');
  for (let i = 1; i <= 15; i += 1) {
    await writeFile(join(paging, 'p.txt'), `${i}\n`);
    git(paging, 'add', '-A');
    git(paging, 'commit', '-qm', `c${String(i).padStart(2, '0')}`);
  }

  // --- the other states -----------------------------------------------------
  await mkdir(join(home, 'plain'));
  await writeFile(join(home, 'plain', 'note.txt'), 'x\n');

  const fresh = join(home, 'fresh-repo');
  await mkdir(fresh);
  git(fresh, 'init', '-q', '-b', 'main');

  const detached = join(home, 'detached-repo');
  await mkdir(detached);
  git(detached, 'init', '-q', '-b', 'main');
  await writeFile(join(detached, 'd.txt'), 'd\n');
  git(detached, 'add', '-A');
  git(detached, 'commit', '-qm', 'only');
  git(detached, 'checkout', '-q', '--detach', revOf(detached, 'HEAD'));

  // A repository whose origin carries a TOKEN, exactly as a `git clone` with a
  // credential in the url leaves it in .git/config.
  const remoteRepo = join(home, 'remote-repo');
  await mkdir(remoteRepo);
  git(remoteRepo, 'init', '-q', '-b', 'main');
  await writeFile(join(remoteRepo, 'r.txt'), 'r\n');
  git(remoteRepo, 'add', '-A');
  git(remoteRepo, 'commit', '-qm', 'one');
  git(remoteRepo, 'remote', 'add', 'origin', `https://${REMOTE_TOKEN}@github.com/an-owner/a-repo.git`);

  // A repository whose origin is NOT github.com: `github` must be null.
  const otherRemote = join(home, 'other-remote');
  await mkdir(otherRemote);
  git(otherRemote, 'init', '-q', '-b', 'main');
  await writeFile(join(otherRemote, 'o.txt'), 'o\n');
  git(otherRemote, 'add', '-A');
  git(otherRemote, 'commit', '-qm', 'one');
  git(otherRemote, 'remote', 'add', 'origin', 'https://gitlab.com/an-owner/a-repo.git');

  return { root, home, repo, paging, H };
}

/** The real server child, its home boundary the fixture home. */
export function startCommitsServer(fx: { root: string; home: string }): Promise<TestServer> {
  const { root, home } = fx;
  return startTestServer({
    dataDir: join(root, 'data'),
    env: { AI_SM_HOME_OVERRIDE: home },
  });
}

/**
 * A second server child with a fake `git` first on its PATH — the stdout cap
 * and the timeout, for the subcommands B3 added. Its four `fake-*` folders are
 * made in the fixture home.
 */
export async function startFakeGitServer(fx: { root: string; home: string }): Promise<TestServer> {
  const { root, home } = fx;
  const binDir = join(root, 'fakebin');
  await mkdir(binDir);
  await writeFile(
    join(binDir, 'git'),
    [
      '#!/bin/sh',
      '# A fake git for two tests only: it answers the probes and then behaves',
      '# badly on `log`, in a way named by the directory it is called in.',
      'if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then echo "$PWD"; exit 0; fi',
      'if [ "$1" = "rev-parse" ]; then echo 1111111111111111111111111111111111111111; exit 0; fi',
      'if [ "$1" = "branch" ]; then echo main; exit 0; fi',
      'if [ "$1" = "rev-list" ]; then',
      '  case "$PWD" in',
      '    *-revslow) sleep 30; exit 0;;',
      // The count FAILS outright (no 5 s timeout to pay for): the other way
      // `counted` is null, and the one the floor arithmetic is read through.
      '    *-total) exit 1;;',
      '  esac',
      '  echo 3; exit 0',
      'fi',
      'if [ "$1" = "log" ]; then',
      '  case "$PWD" in',
      '    *-slow) sleep 30; exit 0;;',
      '    *-flood) exec yes "padding-to-make-the-lines-worth-something";;',
      // TWO well-formed records whatever --max-count says, so a page asked for
      // with limit=1 has `more` true and the floor has its +1 to add.
      '    *-total) printf "\\001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\000aaaaaaa\\0002026-01-01T00:00:00+00:00\\000T\\000newer\\000\\001bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\000bbbbbbb\\0002026-01-01T00:00:00+00:00\\000T\\000older\\000"; exit 0;;',
      // ONE well-formed list record, so the *-revslow case is "the rows are
      // there, only the count timed out" and not "everything failed".
      '    *-revslow) printf "\\001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\000aaaaaaa\\0002026-01-01T00:00:00+00:00\\000T\\000only commit\\000"; exit 0;;',
      '  esac',
      'fi',
      'exit 0',
    ].join('\n'),
    { mode: 0o755 },
  );
  await chmod(join(binDir, 'git'), 0o755);
  await mkdir(join(home, 'fake-slow'));
  await mkdir(join(home, 'fake-flood'));
  await mkdir(join(home, 'fake-revslow'));
  await mkdir(join(home, 'fake-total'));
  return startTestServer({
    dataDir: join(root, 'data-fake'),
    env: {
      AI_SM_HOME_OVERRIDE: home,
      PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
    },
  });
}

export const q = (params: Record<string, string | undefined>): string =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
    .join('&');

export const commits = (
  srv: TestServer,
  params: Record<string, string | undefined>,
): Promise<{ status: number; body: unknown }> => api(srv, 'GET', `/api/git/commits?${q(params)}`);

export const commit = (
  srv: TestServer,
  params: Record<string, string | undefined>,
): Promise<{ status: number; body: unknown }> => api(srv, 'GET', `/api/git/commit?${q(params)}`);

export const commitDiff = (
  srv: TestServer,
  params: Record<string, string | undefined>,
): Promise<{ status: number; body: unknown }> =>
  api(srv, 'GET', `/api/git/commit-diff?${q(params)}`);
