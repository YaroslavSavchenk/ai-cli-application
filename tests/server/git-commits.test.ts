/**
 * GET /api/git/commits, /api/git/commit, /api/git/commit-diff — the Files
 * panel's `Commits` tab and commit view (B3, spec
 * `.claude/plans/nocturne/PLAN-B3.md` § "Phase 1 — backend").
 *
 * Three halves, the same shape as tests/server/git-changes.test.ts:
 *   1. the PURE parsers (parseLogRecords / parseUnifiedDiff / parseGithubRemote)
 *      against strings MEASURED by running git 2.43.0 — including a commit
 *      whose SUBJECT carries the record-framing bytes;
 *   2. the ROUTES against a real server child whose home boundary is the
 *      fixture tree (AI_SM_HOME_OVERRIDE), driving real repositories;
 *   3. the caps and the two things a repository must not be able to make this
 *      backend do: run a program its config names, or put its remote's TOKEN
 *      anywhere.
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  GitCommitDiffResponse,
  GitCommitResponse,
  GitCommitsResponse,
} from '../../shared/protocol.ts';
import {
  DEFAULT_LIMIT,
  GIT_COMMIT_BAD,
  GIT_COMMIT_GONE,
  ISO_RE,
  MAX_COMMIT_FILES,
  MAX_DIFF_LINE_CHARS,
  MAX_DIFF_LINES,
  MAX_LIMIT,
  MAX_SKIP,
  MIN_LIMIT,
  parseLogRecords,
  parseUnifiedDiff,
} from '../../server/git-log.ts';
import { parseGithubRemote } from '../../server/github.ts';
import { FS_PATH_BAD } from '../../server/fsbrowse.ts';
import { api, rawRequest, readServerLog, startTestServer, waitForLog, type TestServer } from '../helpers/helpers.ts';

let server: TestServer;
let fakeServer: TestServer;
let root: string;
let home: string;
let repo: string;
let paging: string;

/** Hashes of the `repo` fixture, newest first, filled in by `before`. */
const H: Record<string, string> = {};

/** The record-framing bytes a hostile commit tries to forge a row with. */
const FORGED_HASH = '0'.repeat(40);
const HOSTILE_SUBJECT = `pre\u0001${FORGED_HASH}\u0002forged\u0002tail`;
const HOSTILE_AUTHOR = `Au\u0001${FORGED_HASH}\u0002thor`;

/** A credential in a remote url. It must reach no body, no log line, nothing. */
const REMOTE_TOKEN = 'ghp_TOKENCANARY_qz0123456789';

/** A file name that must never reach server.log. */
const PATH_CANARY = 'GITPATHCANARY_qz.txt';

/** git, argv only, with an identity of its own so a developer's config cannot break it. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
}

/** git with a chosen author/committer NAME (the hostile-ident fixtures). */
function gitAs(cwd: string, name: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', `user.name=${name}`, '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
}

const revOf = (cwd: string, rev: string): string =>
  execFileSync('git', ['rev-parse', rev], { cwd, encoding: 'utf8' }).trim();

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-gitlog-')));
  home = join(root, 'home');
  repo = join(home, 'repo');
  await mkdir(home);
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
  paging = join(home, 'paging');
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

  server = await startTestServer({
    dataDir: join(root, 'data'),
    env: { AI_SM_HOME_OVERRIDE: home },
  });

  // --- the fake-git server (stdout cap + timeout, for the NEW subcommands) ---
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
  fakeServer = await startTestServer({
    dataDir: join(root, 'data-fake'),
    env: {
      AI_SM_HOME_OVERRIDE: home,
      PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
    },
  });
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (fakeServer !== undefined) await fakeServer.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

const q = (params: Record<string, string | undefined>): string =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
    .join('&');

const commits = (
  srv: TestServer,
  params: Record<string, string | undefined>,
): Promise<{ status: number; body: unknown }> => api(srv, 'GET', `/api/git/commits?${q(params)}`);

const commit = (
  srv: TestServer,
  params: Record<string, string | undefined>,
): Promise<{ status: number; body: unknown }> => api(srv, 'GET', `/api/git/commit?${q(params)}`);

const commitDiff = (
  srv: TestServer,
  params: Record<string, string | undefined>,
): Promise<{ status: number; body: unknown }> =>
  api(srv, 'GET', `/api/git/commit-diff?${q(params)}`);

// ---------------------------------------------------------------------------
// 1. The parsers, against MEASURED output (git 2.43.0)
// ---------------------------------------------------------------------------

test('parseLogRecords: the header, the numstat forms and a commit with NO diff', () => {
  // Measured verbatim from
  //   git log -z --numstat --format='%x01%H%x00%h%x00%aI%x00%an%x00%s'
  // (NULs shown as \0). Note the `\n` between the header and the first numstat
  // record, and its ABSENCE for a commit whose diff is empty.
  const measured =
    '\u0001' + 'a'.repeat(40) + '\0aaaaaaa\0' + '2026-09-21T21:28:59+02:00' + '\0T\0second: subject line\0' +
    '\n1\t0\ta.txt\0' + '-\t-\tbin.dat\0' +
    '\u0001' + 'b'.repeat(40) + '\0bbbbbbb\0' + '2026-09-21T21:28:58+02:00' + '\0T\0an empty commit\0' +
    '\u0001' + 'c'.repeat(40) + '\0ccccccc\0' + '2026-09-21T21:28:57+02:00' + '\0T\0the rename form\0' +
    '\n0\t0\t\0old name".txt\0new name".txt\0';
  const records = parseLogRecords(measured, 5);
  assert.equal(records.length, 3);
  assert.deepEqual(records[0]?.fields, [
    'a'.repeat(40),
    'aaaaaaa',
    '2026-09-21T21:28:59+02:00',
    'T',
    'second: subject line',
  ]);
  assert.deepEqual(records[0]?.numstat, [
    { add: 1, del: 0, path: 'a.txt' },
    // git prints `-` for a binary file: both numbers null, never 0.
    { add: null, del: null, path: 'bin.dat' },
  ]);
  assert.deepEqual(records[1]?.numstat, [], 'a commit with no diff has no `\\n` and no records');
  // Tolerance, not observed today: a git that put a SECOND newline between the
  // header and the numstat would leave `\n1\t0\ta.txt` as the first field,
  // whose add (`'\n1'`) is not a decimal — so a plain TEXT file would be
  // answered `binary: true`. Silent, and indistinguishable from a real binary.
  const extraNewlines = measured.replace('\0\n1\t0\ta.txt', '\0\n\n\n1\t0\ta.txt');
  assert.deepEqual(
    parseLogRecords(extraNewlines, 5)[0]?.numstat,
    [
      { add: 1, del: 0, path: 'a.txt' },
      { add: null, del: null, path: 'bin.dat' },
    ],
    'extra newlines between the header and the numstat are absorbed, not parsed as a record',
  );
  assert.equal(records[1]?.fields[4], 'an empty commit', 'and the NEXT record is still intact');
  assert.deepEqual(
    records[2]?.numstat,
    [{ add: 0, del: 0, path: 'new name".txt' }],
    'the rename triple is consumed whole and keyed by the NEW path',
  );
  assert.deepEqual(parseLogRecords('', 5), [], 'no commits is not a parse error');
});

test('parseLogRecords: a SUBJECT carrying the framing bytes cannot forge a record', () => {
  // The forgery a `split('\x01')` parser falls for: the subject contains a
  // `\x01`, 40 hex and the field separators, i.e. a whole fake record. The
  // parser is POSITIONAL — after the `\x01` it reads exactly N NUL-terminated
  // fields — so those bytes are just text inside field 5.
  const measured =
    '\u0001' + 'd'.repeat(40) + '\0ddddddd\0' + '2026-09-21T21:29:40+02:00' + `\0T\0${HOSTILE_SUBJECT}\0` +
    '\n1\t0\thostile.txt\0';
  const records = parseLogRecords(measured, 5);
  assert.equal(records.length, 1, 'ONE record, not two');
  assert.equal(records[0]?.fields[0], 'd'.repeat(40));
  assert.equal(records[0]?.fields[4], HOSTILE_SUBJECT, 'the bytes stay inside the subject field');
  assert.deepEqual(records[0]?.numstat, [{ add: 1, del: 0, path: 'hostile.txt' }]);
});

test('parseLogRecords: a stream that desyncs or is cut off is DROPPED, never guessed at', () => {
  assert.deepEqual(parseLogRecords('garbage with no marker', 5), [], 'no leading \\x01: nothing');
  const cut = '\u0001' + 'e'.repeat(40) + '\0eeeeeee\0 2026-01-01T00:00:00+00:00\0T';
  assert.deepEqual(parseLogRecords(cut, 5), [], 'a record cut mid-field (the stdout cap) is dropped');
  const oneWhole =
    '\u0001' + 'f'.repeat(40) + '\0fffffff\0' + '2026-01-01T00:00:00+00:00' + '\0T\0ok\0' +
    '\u0001' + 'g'.repeat(40) + '\0ggg';
  assert.equal(parseLogRecords(oneWhole, 5).length, 1, 'the whole one is kept, the torn one is not');

  // And it does not RESYNC: a parser that skipped forward to the next `\x01`
  // instead of stopping would read whatever a desynchronised stream contains
  // from the first byte that LOOKS like a record start — which is precisely
  // the byte a commit subject is allowed to hold. Dropped, never guessed at.
  const junkThenRecord =
    'leading junk that is not a record' +
    '\u0001' + 'a'.repeat(40) + '\0aaaaaaa\0' + '2026-01-01T00:00:00+00:00' + '\0T\0resynced\0';
  assert.deepEqual(parseLogRecords(junkThenRecord, 5), [], 'a stream that starts wrong ends there');
});

test('ISO_RE: both zone spellings git prints are dates, and nothing looser is', () => {
  // git 2.43 prints `+00:00` for a UTC commit, a newer git prints `Z` (the CI
  // runner's — the first B3 push went red on it, every date answered '').
  for (const ok of ['2026-09-21T21:45:00Z', '2026-09-21T21:45:00+00:00', '2026-09-21T23:45:00+02:00', '2026-09-21T16:15:00-05:30']) {
    assert.match(ok, ISO_RE);
    assert.ok(Number.isFinite(Date.parse(ok)), `${ok} is a date the page can read`);
  }
  for (const bad of ['', '%aI', '2026-09-21', '2026-09-21T21:45:00', '2026-09-21T21:45:00z', '2026-09-21T21:45:00+0000', '2026-09-21 21:45:00 +0200', '2026-09-21T21:45:00Z\n', 'x2026-09-21T21:45:00Z']) {
    assert.doesNotMatch(bad, ISO_RE);
  }
});

test('parseUnifiedDiff: a diff LINE that looks like a hunk header is a ROW, not a header', () => {
  // A file can contain the text `@@ -1,1 +1,1 @@`; in the patch it arrives as
  // `+@@ -1,1 +1,1 @@`, i.e. with the marker in front. Only a line that STARTS
  // with `@@` is a hunk header — a parser that merely looked for `@@` anywhere
  // would try the header regex, fail it, and DROP the row: a line of the file,
  // silently missing from the diff, and every number after it off by one.
  const patch = [
    '@@ -1,2 +1,3 @@',
    ' keep',
    '+@@ -1,1 +1,1 @@',
    '+tail@@end',
    '',
  ].join('\n');
  assert.deepEqual(parseUnifiedDiff(patch).lines, [
    { kind: 'hunk', oldNo: null, newNo: null, text: '@@ -1,2 +1,3 @@' },
    { kind: 'ctx', oldNo: 1, newNo: 1, text: 'keep' },
    { kind: 'add', oldNo: null, newNo: 2, text: '@@ -1,1 +1,1 @@' },
    { kind: 'add', oldNo: null, newNo: 3, text: 'tail@@end' },
  ]);
});

test('the page bounds and the caps are the NUMBERS the spec fixes', () => {
  // Every other cap test is written against these constants (the fixtures are
  // built from them: `MAX_COMMIT_FILES + 7` files, a line of
  // `MAX_DIFF_LINE_CHARS + 500` characters), so each one of them stays green
  // when a cap CHANGES VALUE. This is the one place the values themselves are
  // the assertion — plan `.claude/plans/nocturne/PLAN-B3.md` § "Phase 1".
  assert.deepEqual(
    {
      MIN_LIMIT,
      DEFAULT_LIMIT,
      MAX_LIMIT,
      MAX_SKIP,
      MAX_COMMIT_FILES,
      MAX_DIFF_LINES,
      MAX_DIFF_LINE_CHARS,
    },
    {
      MIN_LIMIT: 1,
      DEFAULT_LIMIT: 10,
      MAX_LIMIT: 50,
      MAX_SKIP: 1_000_000,
      MAX_COMMIT_FILES: 2000,
      MAX_DIFF_LINES: 2000,
      MAX_DIFF_LINE_CHARS: 2000,
    },
  );
});

test('parseUnifiedDiff: hunk headers, the four row kinds and the no-newline marker', () => {
  // Measured verbatim from `git log -1 --format= --patch --unified=3`.
  const measured = [
    'diff --git a/f.txt b/f.txt',
    'index b8cb000..d6bfb62 100644',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -1,5 +1,6 @@',
    ' l1',
    '-l2',
    '+X2',
    ' l3',
    ' l4',
    ' l5',
    '+l6',
    '\\ No newline at end of file',
    '',
  ].join('\n');
  const { lines, tooLarge } = parseUnifiedDiff(measured);
  assert.equal(tooLarge, false);
  assert.deepEqual(lines, [
    { kind: 'hunk', oldNo: null, newNo: null, text: '@@ -1,5 +1,6 @@' },
    { kind: 'ctx', oldNo: 1, newNo: 1, text: 'l1' },
    { kind: 'del', oldNo: 2, newNo: null, text: 'l2' },
    { kind: 'add', oldNo: null, newNo: 2, text: 'X2' },
    { kind: 'ctx', oldNo: 3, newNo: 3, text: 'l3' },
    { kind: 'ctx', oldNo: 4, newNo: 4, text: 'l4' },
    { kind: 'ctx', oldNo: 5, newNo: 5, text: 'l5' },
    { kind: 'add', oldNo: null, newNo: 6, text: 'l6' },
    // Not a line OF the file: a row ABOUT it, so both numbers are null.
    { kind: 'ctx', oldNo: null, newNo: null, text: '\\ No newline at end of file' },
  ]);
  // The preamble is never read, so `diff.noprefix` (which drops `a/` and `b/`)
  // cannot change the answer.
  const noPrefix = measured.replace('a/f.txt b/f.txt', 'f.txt f.txt').replace('--- a/', '--- ').replace('+++ b/', '+++ ');
  assert.deepEqual(parseUnifiedDiff(noPrefix).lines, lines);
});

test('parseUnifiedDiff: a second hunk restarts the numbering; the cap answers tooLarge with NO rows', () => {
  const two = ['@@ -1,1 +1,1 @@', '-a', '+b', '@@ -50,2 +60,2 @@', ' x', '+y', ''].join('\n');
  const rows = parseUnifiedDiff(two).lines;
  assert.deepEqual(rows[4], { kind: 'ctx', oldNo: 50, newNo: 60, text: 'x' });
  assert.deepEqual(rows[5], { kind: 'add', oldNo: null, newNo: 61, text: 'y' });

  const many = ['@@ -1,9999 +1,9999 @@', ...Array.from({ length: 50 }, (_, i) => ` l${i}`), ''].join('\n');
  const capped = parseUnifiedDiff(many, 10);
  assert.equal(capped.tooLarge, true);
  assert.deepEqual(capped.lines, [], 'tooLarge carries no rows at all — the panel draws a sentence');
});

test('parseUnifiedDiff: control characters are stripped and a long line is cut', () => {
  const nasty = ['@@ -1,2 +1,2 @@', `+a\u0007b\u009Bc\u2028d`, `+${'Z'.repeat(MAX_DIFF_LINE_CHARS + 500)}`, ''].join('\n');
  const rows = parseUnifiedDiff(nasty).lines;
  assert.equal(rows[1]?.text, 'abcd', 'C0, C1 and U+2028 are gone');
  assert.equal(rows[2]?.text.length, MAX_DIFF_LINE_CHARS);
});

test('parseGithubRemote: the three spellings, userinfo DISCARDED, everything else null', () => {
  const ok = { owner: 'an-owner', repo: 'a-repo' };
  assert.deepEqual(parseGithubRemote('https://github.com/an-owner/a-repo'), ok);
  assert.deepEqual(parseGithubRemote('https://github.com/an-owner/a-repo.git'), ok);
  assert.deepEqual(parseGithubRemote('git@github.com:an-owner/a-repo.git'), ok);
  assert.deepEqual(parseGithubRemote('git@github.com:an-owner/a-repo'), ok);
  assert.deepEqual(parseGithubRemote('ssh://git@github.com/an-owner/a-repo.git'), ok);
  assert.deepEqual(parseGithubRemote('  https://github.com/an-owner/a-repo  '), ok);
  // DNS is case-insensitive, so these are the SAME remote. `ssh:` is a
  // non-special scheme, so the URL parser does NOT lower-case its host for us
  // (measured: `ssh://git@GITHUB.COM/o/r`.hostname === 'GITHUB.COM'), and the
  // scp form is not a URL at all — both compares are explicit.
  assert.deepEqual(parseGithubRemote('git@GitHub.com:an-owner/a-repo.git'), ok);
  assert.deepEqual(parseGithubRemote('GITHUB.COM:an-owner/a-repo'), ok);
  assert.deepEqual(parseGithubRemote('ssh://git@GitHub.Com/an-owner/a-repo'), ok);
  assert.deepEqual(parseGithubRemote('SSH://git@GITHUB.COM/an-owner/a-repo.git'), ok);
  assert.deepEqual(parseGithubRemote('HTTPS://GitHub.com/an-owner/a-repo'), ok);
  // `.git` comes off case-insensitively: it is a SUFFIX git writes, not a name.
  assert.deepEqual(parseGithubRemote('https://github.com/an-owner/a-repo.GIT'), ok);
  // Trimmed in the scp spelling too. `new URL()` strips surrounding spaces by
  // itself, so the https case above cannot prove the trim is there at all.
  assert.deepEqual(parseGithubRemote('  git@github.com:an-owner/a-repo.git  '), ok);
  // ...and the folding is ASCII-ONLY. No character in `github.com` has a
  // Unicode look-alike that `toLowerCase()` would fold INTO it, so these are
  // null under either rule — the ASCII-only compare is belt-and-braces for the
  // day someone widens the host list to a name that does (a `k`, an `s`).
  assert.equal(parseGithubRemote('git@githuK.com:an-owner/a-repo'), null, 'a Kelvin sign is not a b');
  assert.equal(parseGithubRemote('git@gıthub.com:an-owner/a-repo'), null, 'a dotless i is not an i');
  assert.equal(parseGithubRemote('git@gİthub.com:an-owner/a-repo'), null, 'nor a dotted capital I');
  // A CREDENTIAL in the url is discarded, not refused (user decision 2026-09-21):
  // `https://<token>@github.com/o/r` is an ordinary thing to find in a config.
  assert.deepEqual(parseGithubRemote(`https://${REMOTE_TOKEN}@github.com/an-owner/a-repo.git`), ok);
  assert.deepEqual(parseGithubRemote(`https://user:${REMOTE_TOKEN}@github.com/an-owner/a-repo`), ok);
  assert.deepEqual(parseGithubRemote(`ssh://git:${REMOTE_TOKEN}@github.com/an-owner/a-repo`), ok);

  for (const bad of [
    'https://github.com.evil.com/o/r',   // a suffix of the host is not the host
    'https://github.com@evil.com/o/r',   // the host is evil.com; `github.com` is userinfo
    // ...and github.com is not a SUFFIX of the host either. A host compared
    // with `endsWith` would take every one of these — and the page then builds
    // `https://github.com/<owner>/<repo>/commit/<hash>` for a repository that
    // has nothing to do with github.com.
    'https://notgithub.com/o/r',
    'git@evilgithub.com:o/r',
    'ssh://git@my-github.com/o/r',
    'https://xgithub.com/o/r',
    // A DOT SEGMENT in the scp spelling, which — unlike the URL spelling — is
    // not normalised away by `new URL()` before the check ever runs. `..` and
    // `.` both match the owner/repo pattern, so the explicit refusal is the
    // only thing standing between them and a link out of github.com's
    // `/<owner>/<repo>/` namespace.
    'git@github.com:../r',
    'git@github.com:./r',
    'git@github.com:o/..',
    'git@github.com:o/.',
    // Past the 2048-character ceiling, and otherwise perfectly parseable.
    `https://github.com/an-owner/a-repo?${'x'.repeat(2100)}`,
    'https://github.com:8443/o/r',       // a port is not github.com's web site
    'ssh://git@github.com:22/o/r',
    'http://github.com/o/r',             // https or ssh, nothing else
    'git://github.com/o/r',
    'https://gitlab.com/o/r',            // D2: github.com only
    'https://github.com/o/r/extra',
    'https://github.com/o',
    'https://github.com/../r',
    'https://github.com/%2e%2e/r',
    'https://github.com/o w/r',
    'https://github.com/o/r;x',
    'git@github.com:o/r/deep',
    'a@b@github.com:o/r',
    `https://github.com/${'x'.repeat(101)}/r`,
    '/home/you/projects/local-thing',
    '',
  ]) {
    assert.equal(parseGithubRemote(bad), null, `must be null: ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// 2. GET /api/git/commits
// ---------------------------------------------------------------------------

test('the list answers one page, the branch, the head and the TOTAL', async () => {
  const res = await commits(server, { root: paging, limit: '10', skip: '0' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as GitCommitsResponse;
  assert.equal(body.isRepo, true);
  assert.equal(body.branch, 'main');
  assert.equal(body.total, 15, 'rev-list --count, not the page size');
  assert.equal(body.head, revOf(paging, 'HEAD'));
  assert.equal(body.commits.length, 10);
  assert.equal(body.more, true, 'five older commits exist past this page');
  assert.deepEqual(body.commits.map((c) => c.subject), [
    'c15', 'c14', 'c13', 'c12', 'c11', 'c10', 'c09', 'c08', 'c07', 'c06',
  ], 'newest first');
  const first = body.commits[0];
  assert.match(first?.hash ?? '', /^[0-9a-f]{40}$/);
  assert.equal(first?.shortHash, (first?.hash ?? '').slice(0, first?.shortHash.length ?? 0));
  assert.equal(first?.author, 'T');
  assert.match(first?.authoredAt ?? '', ISO_RE);
  assert.deepEqual({ add: first?.add, del: first?.del, files: first?.files }, { add: 1, del: 1, files: 1 });
});

test('paging: skip walks the history, `more` goes false on the last page, limit defaults to 10', async () => {
  const page2 = (await commits(server, { root: paging, limit: '10', skip: '10' })).body as GitCommitsResponse;
  assert.deepEqual(page2.commits.map((c) => c.subject), ['c05', 'c04', 'c03', 'c02', 'c01']);
  assert.equal(page2.more, false, 'nothing older than the root commit');
  assert.equal(page2.total, 15, 'the total is the history, not the page');

  const defaulted = (await commits(server, { root: paging })).body as GitCommitsResponse;
  assert.equal(defaulted.commits.length, 10, 'no ?limit= means 10');
  assert.equal(defaulted.more, true);

  const one = (await commits(server, { root: paging, limit: '1', skip: '14' })).body as GitCommitsResponse;
  assert.deepEqual(one.commits.map((c) => c.subject), ['c01']);
  assert.equal(one.more, false);

  const past = (await commits(server, { root: paging, limit: '10', skip: '100' })).body as GitCommitsResponse;
  assert.deepEqual(past.commits, [], 'skipping past the end is empty, not an error');
  assert.equal(past.more, false);
});

test('a pinned `from` keeps page two stable while a NEW commit lands mid-browse', async () => {
  const pinRepo = join(home, 'pin-repo');
  await mkdir(pinRepo);
  git(pinRepo, 'init', '-q', '-b', 'main');
  for (let i = 1; i <= 6; i += 1) {
    await writeFile(join(pinRepo, 'p.txt'), `${i}\n`);
    git(pinRepo, 'add', '-A');
    git(pinRepo, 'commit', '-qm', `p${i}`);
  }
  const pin = revOf(pinRepo, 'HEAD');

  const page1 = (await commits(server, { root: pinRepo, limit: '3', skip: '0', from: pin }))
    .body as GitCommitsResponse;
  assert.deepEqual(page1.commits.map((c) => c.subject), ['p6', 'p5', 'p4']);
  assert.equal(page1.head, pin, 'the pinned commit IS the head of this view');
  assert.equal(page1.total, 6);

  // A commit lands while the user reads page one.
  await writeFile(join(pinRepo, 'p.txt'), 'seven\n');
  git(pinRepo, 'add', '-A');
  git(pinRepo, 'commit', '-qm', 'p7');

  const pinned = (await commits(server, { root: pinRepo, limit: '3', skip: '3', from: pin }))
    .body as GitCommitsResponse;
  assert.deepEqual(
    pinned.commits.map((c) => c.subject),
    ['p3', 'p2', 'p1'],
    'no row shifts and none repeats: the page is cut from the PINNED history',
  );
  assert.equal(pinned.more, false);

  // Without the pin the same request would have slid by one — that is the bug
  // the pin exists for, and this is the non-vacuity for it.
  const unpinned = (await commits(server, { root: pinRepo, limit: '3', skip: '3' }))
    .body as GitCommitsResponse;
  assert.deepEqual(unpinned.commits.map((c) => c.subject), ['p4', 'p3', 'p2']);
});

test('an EMPTY repository is a drawable state, and so is a folder that is not a repository', async () => {
  const fresh = await commits(server, { root: join(home, 'fresh-repo') });
  assert.equal(fresh.status, 200);
  assert.deepEqual(fresh.body, {
    isRepo: true,
    // MEASURED (and the same as the Changes tab): `git branch --show-current`
    // prints `main` in a repository with no commits at all.
    branch: 'main',
    head: null,
    total: 0,
    commits: [],
    more: false,
  });

  const plain = await commits(server, { root: join(home, 'plain') });
  assert.equal(plain.status, 200);
  assert.deepEqual(plain.body, {
    isRepo: false,
    branch: null,
    head: null,
    total: 0,
    commits: [],
    more: false,
  });
});

test('a DETACHED head lists its history with branch null', async () => {
  const res = await commits(server, { root: join(home, 'detached-repo') });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as GitCommitsResponse;
  assert.equal(body.isRepo, true);
  assert.equal(body.branch, null, 'no branch name, and NOT an empty string');
  assert.equal(body.total, 1);
  assert.equal(body.commits[0]?.subject, 'only');
});

test('a root INSIDE the repository answers the repository’s history', async () => {
  const res = await commits(server, { root: join(repo, 'many'), limit: '1' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as GitCommitsResponse;
  assert.equal(body.head, revOf(repo, 'HEAD'), 'the repo root may be an ANCESTOR of the panel root');
});

test('a MERGE is counted against its FIRST parent, and a root commit against the empty tree', async () => {
  const res = await commits(server, { root: repo, limit: '50' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as GitCommitsResponse;
  const byHash = new Map(body.commits.map((c) => [c.hash, c]));

  const merge = byHash.get(H['merge'] as string);
  assert.deepEqual(
    { add: merge?.add, del: merge?.del, files: merge?.files },
    { add: 1, del: 0, files: 1 },
    'the first-parent diff of this merge is side.txt alone; the DEFAULT would be 0 files',
  );

  const rootCommit = byHash.get(H['root'] as string);
  assert.deepEqual(
    { add: rootCommit?.add, del: rootCommit?.del, files: rootCommit?.files },
    // a.txt is 5 added lines; bin.dat is BINARY: 0 lines, but 1 file.
    { add: 5, del: 0, files: 2 },
    'a root commit is its whole tree, and a binary file adds 0 lines and 1 file',
  );

  const rename = byHash.get(H['rename'] as string);
  assert.deepEqual(
    { add: rename?.add, del: rename?.del, files: rename?.files },
    // --no-renames: a delete (6 lines gone) plus an add (6 lines), two rows.
    { add: 6, del: 6, files: 2 },
    'a rename is a delete PLUS an add — two paths, never one row with a `->`',
  );
});

test('a hostile SUBJECT and AUTHOR forge no row, and their control bytes are stripped out', async () => {
  const res = await commits(server, { root: repo, limit: '50' });
  const body = res.body as GitCommitsResponse;
  assert.equal(
    body.commits.length,
    body.total,
    'exactly the real commits — no forged row slipped in',
  );
  assert.equal(
    body.commits.some((c) => c.hash === FORGED_HASH),
    false,
    `the subject's fake ${FORGED_HASH.slice(0, 8)}… hash is not a commit`,
  );
  const hostile = body.commits.find((c) => c.hash === H['hostile']);
  assert.equal(hostile?.subject, `pre${FORGED_HASH}forgedtail`, '\\x01 and \\x02 are stripped');
  assert.equal(hostile?.author, `Au${FORGED_HASH}thor`);
  for (const c of body.commits) {
    assert.equal(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(c.subject), false, 'no control byte out');
    assert.equal(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(c.author), false);
    assert.match(c.hash, /^[0-9a-f]{40}$/);
  }
});

// ---------------------------------------------------------------------------
// 3. GET /api/git/commit
// ---------------------------------------------------------------------------

test('one commit answers its message, its body, its people, its parents and its files', async () => {
  const res = await commit(server, { root: repo, hash: H['second'] as string });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as GitCommitResponse;
  assert.equal(body.commit.hash, H['second']);
  assert.equal(body.commit.subject, 'second subject');
  assert.equal(body.body, 'body line one\n\nbody line two', 'the BODY keeps its newlines');
  assert.equal(body.committer, null, 'the same person authored and committed it');
  assert.match(body.committedAt, ISO_RE);
  assert.equal(body.parents, 1);
  assert.equal(body.branch, 'main');
  assert.equal(body.github, null, 'this fixture has no remote at all');
  assert.equal(body.truncated, 0);
  const paths = body.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['a.txt', PATH_CANARY, 'bin.dat', 'long.txt'].sort());
  assert.deepEqual(
    body.files.find((f) => f.path === 'bin.dat'),
    { path: 'bin.dat', add: null, del: null },
    'a BINARY file is null/null, never 0/0',
  );
  assert.deepEqual(body.files.find((f) => f.path === 'a.txt'), { path: 'a.txt', add: 2, del: 1 });

  // No E-MAIL ADDRESS anywhere in the answer (plan ⟲, and the A6 view).
  assert.equal(JSON.stringify(body).includes('@example.com'), false);
});

test('`Committed by` appears only when the committer differs; a root commit has 0 parents, a merge 2', async () => {
  const two = (await commit(server, { root: repo, hash: H['twoPeople'] as string }))
    .body as GitCommitResponse;
  assert.equal(two.commit.author, 'Author Name');
  assert.equal(two.committer, 'Committer Name');

  const rootC = (await commit(server, { root: repo, hash: H['root'] as string })).body as GitCommitResponse;
  assert.equal(rootC.parents, 0, 'the root commit has no parent');
  assert.equal(rootC.body, '', 'no body is the empty string, not null');

  const merge = (await commit(server, { root: repo, hash: H['merge'] as string })).body as GitCommitResponse;
  assert.equal(merge.parents, 2);
  assert.deepEqual(merge.files, [{ path: 'side.txt', add: 1, del: 0 }], 'the FIRST-parent diff');
});

test('the BODY keeps its newlines and NOTHING else: its control bytes are stripped too', async () => {
  // The body is the one string in the answer that keeps `\n`, and it is the
  // longest attacker-controlled text in the response. Everything else in the
  // C0/C1 ranges still goes: a `\r` or a U+2028 in a commit message rewrites
  // the line structure of the JSON for anything downstream that reads it as
  // text, exactly as it would in a subject.
  const bodyRepo = join(home, 'body-repo');
  await mkdir(bodyRepo);
  git(bodyRepo, 'init', '-q', '-b', 'main');
  await writeFile(join(bodyRepo, 'a.txt'), 'a\n');
  git(bodyRepo, 'add', '-A');
  git(bodyRepo, 'commit', '-qm', 'subject', '-m', 'alpha\u0007beta\u2028gamma\u000Bdelta\n\nomega\u009B[31m');
  const body = (await commit(server, { root: bodyRepo, hash: revOf(bodyRepo, 'HEAD') }))
    .body as GitCommitResponse;
  assert.equal(body.body, 'alphabetagammadelta\n\nomega[31m');
  assert.equal(
    /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]/.test(body.body),
    false,
    'no control byte but `\\n` leaves this route',
  );
  assert.ok(body.body.includes('\n\n'), 'and the paragraph break survives — it is a paragraph');
});

test(`more than ${MAX_COMMIT_FILES} files in one commit are capped and the rest are COUNTED`, async () => {
  const body = (await commit(server, { root: repo, hash: H['many'] as string })).body as GitCommitResponse;
  assert.equal(body.files.length, MAX_COMMIT_FILES, 'the cap is the window');
  assert.equal(body.truncated, 7, 'and the leftovers are counted, not silently dropped');
  assert.equal(body.commit.files, MAX_COMMIT_FILES + 7, 'the summary still states the real number');
  for (const f of body.files) {
    assert.ok(!f.path.startsWith('/'), `repo-relative: ${JSON.stringify(f.path)}`);
  }
});

test('the github remote: a TOKEN in the url becomes owner/repo and NOTHING else', async () => {
  const res = await commit(server, {
    root: join(home, 'remote-repo'),
    hash: revOf(join(home, 'remote-repo'), 'HEAD'),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as GitCommitResponse;
  assert.deepEqual(body.github, { owner: 'an-owner', repo: 'a-repo' });
  assert.equal(
    JSON.stringify(body).includes(REMOTE_TOKEN),
    false,
    'the credential is not one byte of the response',
  );

  await waitForLog(server, '[git] GET /api/git/commit -> 200');
  const log = await readServerLog(server);
  assert.equal(log.includes(REMOTE_TOKEN), false, 'nor of server.log');
  assert.equal(log.includes('github.com'), false, 'the remote url never reaches a log line at all');

  // A remote that is not github.com is simply no button (decision D2).
  const other = join(home, 'other-remote');
  const otherBody = (await commit(server, { root: other, hash: revOf(other, 'HEAD') }))
    .body as GitCommitResponse;
  assert.equal(otherBody.github, null);
});

// ---------------------------------------------------------------------------
// 4. GET /api/git/commit-diff
// ---------------------------------------------------------------------------

test('one file of one commit answers numbered rows, with the no-newline marker', async () => {
  const res = await commitDiff(server, { root: repo, hash: H['second'] as string, path: 'a.txt' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as GitCommitDiffResponse;
  assert.equal(body.binary, false);
  assert.equal(body.tooLarge, false);
  assert.deepEqual(body.lines, [
    { kind: 'hunk', oldNo: null, newNo: null, text: '@@ -1,5 +1,6 @@' },
    { kind: 'ctx', oldNo: 1, newNo: 1, text: 'l1' },
    { kind: 'del', oldNo: 2, newNo: null, text: 'l2' },
    { kind: 'add', oldNo: null, newNo: 2, text: 'X2' },
    { kind: 'ctx', oldNo: 3, newNo: 3, text: 'l3' },
    { kind: 'ctx', oldNo: 4, newNo: 4, text: 'l4' },
    { kind: 'ctx', oldNo: 5, newNo: 5, text: 'l5' },
    { kind: 'add', oldNo: null, newNo: 6, text: 'l6' },
    { kind: 'ctx', oldNo: null, newNo: null, text: '\\ No newline at end of file' },
  ]);
});

test('binary, too large, a long line, and a path this commit never touched', async () => {
  const bin = (await commitDiff(server, { root: repo, hash: H['second'] as string, path: 'bin.dat' }))
    .body as GitCommitDiffResponse;
  assert.deepEqual(bin, { binary: true, tooLarge: false, lines: [] }, 'a binary file draws no lines');

  const huge = (await commitDiff(server, { root: repo, hash: H['huge'] as string, path: 'huge.txt' }))
    .body as GitCommitDiffResponse;
  assert.deepEqual(
    huge,
    { binary: false, tooLarge: true, lines: [] },
    `${MAX_DIFF_LINES + 500} added lines is past the cap`,
  );

  const long = (await commitDiff(server, { root: repo, hash: H['second'] as string, path: 'long.txt' }))
    .body as GitCommitDiffResponse;
  const added = long.lines.find((l) => l.kind === 'add');
  assert.equal(added?.text.length, MAX_DIFF_LINE_CHARS, 'a 3000-character line is cut at the cap');

  const untouched = (await commitDiff(server, {
    root: repo,
    hash: H['root'] as string,
    path: 'side.txt',
  })).body as GitCommitDiffResponse;
  assert.deepEqual(
    untouched,
    { binary: false, tooLarge: false, lines: [] },
    'a path this commit did not change is no rows, not an error',
  );
});

test('a path only an ANCESTOR touched answers NOTHING — git would have answered the ancestor', async () => {
  // HISTORY SIMPLIFICATION, and it is the reason `--no-walk` is on the two
  // pathspec calls. `git log -1 <hash> -- <path>` does not mean "what did
  // <hash> do to <path>": when <hash> did not touch it, git WALKS BACK to the
  // nearest ancestor that did and prints THAT commit's numstat and patch —
  // under the hash the client asked about. The commit view would have drawn a
  // stranger's diff inside a commit, with the right file name on it.
  //
  // The case above (`H['root']` + `side.txt`) cannot catch that: a root commit
  // has no ancestor to walk to. This one does — `H['huge']` touched `huge.txt`
  // alone, and `bin.dat` was last changed by `H['second']`, two commits back.
  const res = await commitDiff(server, { root: repo, hash: H['huge'] as string, path: 'bin.dat' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { binary: false, tooLarge: false, lines: [] });

  // NON-VACUITY: the same argv WITHOUT --no-walk, run here, does answer.
  const walked = execFileSync(
    'git',
    [
      'log', '-1',
      '--no-show-signature', '--no-notes', '--no-color', '--no-ext-diff', '--no-textconv',
      '--no-renames', '--diff-merges=first-parent', '--encoding=UTF-8', '-O/dev/null',
      '--numstat', '-z', '--format=', H['huge'] as string, '--', 'bin.dat',
    ],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.match(walked, /bin\.dat/, 'the fixture is real: without --no-walk git answers an ancestor’s diff');
  const notWalked = execFileSync(
    'git',
    [
      'log', '-1', '--no-walk',
      '--no-show-signature', '--no-notes', '--no-color', '--no-ext-diff', '--no-textconv',
      '--no-renames', '--diff-merges=first-parent', '--encoding=UTF-8', '-O/dev/null',
      '--numstat', '-z', '--format=', H['huge'] as string, '--', 'bin.dat',
    ],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.equal(notWalked, '', 'and with it, nothing');
});

test("a date git answers in a shape the server does not trust becomes '', and a huge body is capped at 8 KiB", async () => {
  // Both are protocol promises with no other test. The date: `authoredAt` /
  // `committedAt` are typed `string`, so a value that fails the strict ISO
  // check has to be SOMETHING — '' is the one value that cannot be mistaken
  // for a real timestamp (the page must not `new Date()` it blindly).
  const odd = join(home, 'odd-date-repo');
  await mkdir(odd);
  git(odd, 'init', '-q', '-b', 'main');
  await writeFile(join(odd, 'a.txt'), 'a\n');
  git(odd, 'add', '-A');
  git(odd, 'commit', '-qm', 'seed');
  // A commit object whose author TIMESTAMP is not a number. `git commit` will
  // not make one, but a repository can contain one — and git then cannot
  // format it at all: MEASURED, `%aI` prints the literal text `%aI`. Feeding
  // that to `new Date()` in the page is the failure this branch prevents.
  const oddBuf = [
    `tree ${execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: odd, encoding: 'utf8' }).trim()}`,
    `parent ${revOf(odd, 'HEAD')}`,
    'author T <t@example.com> notanumber +0000',
    'committer T <t@example.com> notanumber +0000',
    '',
    'an unformattable date',
    '',
  ].join('\n');
  const oddHash = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--literally', '--stdin'], {
    cwd: odd,
    input: oddBuf,
    encoding: 'utf8',
  }).trim();
  git(odd, 'update-ref', 'refs/heads/main', oddHash);
  // Non-vacuity: this really is a date git cannot print.
  assert.equal(
    execFileSync('git', ['log', '-1', '--format=%aI', oddHash], { cwd: odd, encoding: 'utf8' }).trim(),
    '%aI',
    'the fixture is real: git gives up on this timestamp',
  );

  const oddBody = (await commits(server, { root: odd })).body as GitCommitsResponse;
  assert.equal(oddBody.commits[0]?.subject, 'an unformattable date');
  assert.equal(oddBody.commits[0]?.authoredAt, '', "not the literal '%aI', and not a lie either");
  const oddOne = (await commit(server, { root: odd, hash: oddHash })).body as GitCommitResponse;
  assert.equal(oddOne.commit.authoredAt, '');
  assert.equal(oddOne.committedAt, '');

  // The 8 KiB body cap, in UTF-8 BYTES, never cutting a surrogate pair.
  const big = join(home, 'big-body-repo');
  await mkdir(big);
  git(big, 'init', '-q', '-b', 'main');
  await writeFile(join(big, 'a.txt'), 'a\n');
  git(big, 'add', '-A');
  // 3-byte characters, so a CHARACTER cap and a BYTE cap disagree loudly.
  git(big, 'commit', '-qm', 'big body', '-m', '✓'.repeat(9000));
  const bigBody = (await commit(server, { root: big, hash: revOf(big, 'HEAD') }))
    .body as GitCommitResponse;
  assert.ok(Buffer.byteLength(bigBody.body, 'utf8') <= 8 * 1024, 'the cap is BYTES');
  assert.ok(Buffer.byteLength(bigBody.body, 'utf8') > 8 * 1024 - 4, 'and it is filled, not cut early');
  assert.equal(/[\uD800-\uDFFF]/.test(bigBody.body), false, 'no lone surrogate survives the cut');
});

test('a patch past the runner’s 2 MiB stdout cap is an honest `tooLarge`, never a 500', async () => {
  // WHY THE NUMSTAT CALL COMES FIRST (plan § "the 2 MiB cap"): `flood.txt` is
  // 40 000 lines of ~57 characters, so its PATCH is well over the runner's
  // 2 MiB stdout cap — which kills the child and answers the constant 500. Its
  // numstat is two small numbers, and those two numbers are enough to answer
  // `tooLarge` instead: a sentence the panel can draw, for a request that
  // otherwise reads as "this repository is broken".
  const patch = execFileSync(
    'git',
    [
      'log', '-1', '--no-walk',
      '--no-show-signature', '--no-notes', '--no-color', '--no-ext-diff', '--no-textconv',
      '--no-renames', '--diff-merges=first-parent', '--encoding=UTF-8', '-O/dev/null',
      '--patch', '--unified=3', '--format=', H['flood'] as string, '--', 'flood.txt',
    ],
    { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  assert.ok(
    Buffer.byteLength(patch, 'utf8') > 2 * 1024 * 1024,
    `the fixture is real: the patch is ${Buffer.byteLength(patch, 'utf8')} bytes`,
  );

  const res = await commitDiff(server, { root: repo, hash: H['flood'] as string, path: 'flood.txt' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { binary: false, tooLarge: true, lines: [] });

  const log = await readServerLog(server);
  assert.equal(
    log.includes('git log produced more than 2097152 bytes; killed'),
    false,
    'and the patch call was never made, so nothing was killed for it',
  );
});

test('the 8 KiB body cap never cuts a surrogate pair in half, at ANY alignment', async () => {
  // The cap is a BYTE budget and an astral character is 4 UTF-8 bytes, so
  // where the budget ends decides whether the last character survives whole.
  // The alignment that matters: a body of 8189 ASCII bytes followed by an
  // emoji. A lone high surrogate encodes as 3 bytes (U+FFFD's length), so
  // 8189 + 3 = 8192 fits the budget EXACTLY — and a cut there leaves half a
  // character in a response typed `string`.
  //
  // The '✓' body above cannot see this: U+2713 is a BMP character, one UTF-16
  // code unit, so no cut can ever land inside it.
  const pair = join(home, 'surrogate-body-repo');
  await mkdir(pair);
  git(pair, 'init', '-q', '-b', 'main');
  await writeFile(join(pair, 'a.txt'), 'a\n');
  git(pair, 'add', '-A');
  git(pair, 'commit', '-qm', 'surrogate body', '-m', `${'a'.repeat(8189)}${'\u{1F600}'.repeat(8)}`);
  const body = (await commit(server, { root: pair, hash: revOf(pair, 'HEAD') }))
    .body as GitCommitResponse;

  assert.ok(Buffer.byteLength(body.body, 'utf8') <= 8 * 1024, 'the cap is BYTES');
  assert.equal(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(body.body),
    false,
    'no LONE HIGH surrogate: half an emoji is not a character',
  );
  assert.equal(
    /(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body.body),
    false,
    'and no lone LOW surrogate either',
  );
  assert.equal(body.body, JSON.parse(JSON.stringify(body.body)), 'the body survives a JSON round-trip');
});

test('an empty ?from= / ?limit= / ?skip= means ABSENT, not a bad value', async () => {
  const res = await api(
    server,
    'GET',
    `/api/git/commits?root=${encodeURIComponent(paging)}&from=&limit=&skip=`,
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as GitCommitsResponse;
  assert.equal(body.commits.length, 10, 'the default page size');
  assert.equal(body.head, revOf(paging, 'HEAD'), 'and HEAD, not a pinned commit');
});

test('a root commit and a merge both diff through the same route', async () => {
  const rootDiff = (await commitDiff(server, { root: repo, hash: H['root'] as string, path: 'a.txt' }))
    .body as GitCommitDiffResponse;
  assert.equal(rootDiff.lines.filter((l) => l.kind === 'add').length, 5, 'the root commit vs the empty tree');
  assert.equal(rootDiff.lines[0]?.text, '@@ -0,0 +1,5 @@');

  const mergeDiff = (await commitDiff(server, { root: repo, hash: H['merge'] as string, path: 'side.txt' }))
    .body as GitCommitDiffResponse;
  assert.deepEqual(
    mergeDiff.lines,
    [
      { kind: 'hunk', oldNo: null, newNo: null, text: '@@ -0,0 +1 @@' },
      { kind: 'add', oldNo: null, newNo: 1, text: 's' },
    ],
    'a merge diffs against its FIRST parent here too',
  );
});

// ---------------------------------------------------------------------------
// 5. The gates: every client string before it reaches argv
// ---------------------------------------------------------------------------

test('the HASH gate: short, upper-case, a leading dash, a TREE and a BLOB', async () => {
  const good = H['second'] as string;
  const tree = execFileSync('git', ['rev-parse', `${good}^{tree}`], { cwd: repo, encoding: 'utf8' }).trim();
  const blob = execFileSync('git', ['rev-parse', `${good}:bin.dat`], { cwd: repo, encoding: 'utf8' }).trim();

  const bad400: [string | undefined, string][] = [
    [undefined, 'no ?hash= at all'],
    ['', 'an empty hash'],
    [good.slice(0, 7), 'the SHORT hash — the route takes the identity, not the label'],
    [good.toUpperCase(), 'upper case'],
    [`-${good.slice(1)}`, 'a leading dash (an OPTION, if it ever reached argv)'],
    ['HEAD', 'a revision NAME'],
    [`${good}^`, 'revision syntax'],
    [`${good} --output=/tmp/x`, 'an argument smuggled in'],
    [`${good}\n${good}`, 'a newline'],
    ['g'.repeat(40), 'non-hex'],
    [`${good}0`, '41 characters'],
  ];
  for (const [hash, why] of bad400) {
    const res = await commit(server, { root: repo, hash });
    assert.equal(res.status, 400, `${why} -> ${res.status} ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { error: GIT_COMMIT_BAD });
    const list = await commits(server, { root: repo, from: hash === '' ? undefined : hash });
    if (hash !== undefined && hash !== '') {
      assert.equal(list.status, 400, `?from= is the same gate: ${why}`);
    }
  }

  // Syntactically a hash, but not a COMMIT in this repository.
  for (const [hash, why] of [
    ['1'.repeat(40), 'a hash of nothing at all'],
    [tree, "a TREE's hash"],
    [blob, "a BLOB's hash"],
  ] as [string, string][]) {
    const res = await commit(server, { root: repo, hash });
    assert.equal(res.status, 404, `${why} -> ${res.status}`);
    assert.deepEqual(res.body, { error: GIT_COMMIT_GONE });
    assert.equal((await commits(server, { root: repo, from: hash })).status, 404, why);
    assert.equal(
      (await commitDiff(server, { root: repo, hash, path: 'a.txt' })).status,
      404,
      why,
    );
  }

  // A folder with no repository in it has no commits either.
  assert.equal((await commit(server, { root: join(home, 'plain'), hash: good })).status, 404);
  assert.equal(
    (await commitDiff(server, { root: join(home, 'plain'), hash: good, path: 'a.txt' })).status,
    404,
  );
});

test('the limit / skip gate: strict decimal integers in range, or 400', async () => {
  for (const [params, why] of [
    [{ limit: '0' }, 'below the minimum'],
    [{ limit: '51' }, 'above the maximum'],
    [{ limit: '-1' }, 'negative'],
    [{ limit: '1.5' }, 'not an integer'],
    [{ limit: '10abc' }, 'parseInt would have taken this'],
    [{ limit: '0x10' }, 'hex'],
    [{ limit: ' 10' }, 'leading space'],
    [{ limit: '1e2' }, 'exponent'],
    [{ skip: '-1' }, 'a negative skip'],
    [{ skip: '1000001' }, 'past the skip ceiling'],
    [{ skip: '99999999999' }, 'absurd'],
  ] as [Record<string, string>, string][]) {
    const res = await commits(server, { root: paging, ...params });
    assert.equal(res.status, 400, `${why} -> ${res.status} ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { error: GIT_COMMIT_BAD });
  }
  assert.equal((await commits(server, { root: paging, limit: '50', skip: '1000000' })).status, 200,
    'the edges of the range are ALLOWED');
});

test('the PATH gate: `..`, absolute, and pathspec magic that is only a file name', async () => {
  const hash = H['second'] as string;
  for (const [path, why] of [
    [undefined, 'no ?path= at all'],
    ['', 'empty'],
    ['../outside.txt', 'a parent segment'],
    ['a/../../etc/passwd', 'a parent segment in the middle'],
    ['/etc/passwd', 'absolute'],
    ['C:\\Windows\\win.ini', 'a Windows absolute path'],
    ['\\\\server\\share\\x', 'a UNC path'],
    ['a//b.txt', 'an empty segment'],
    ['./a.txt', 'a dot segment'],
    ['a/./b.txt', 'a dot segment in the middle'],
    ['a\u0000b', 'a NUL'],
    [`${'x/'.repeat(2100)}y`, 'past 4096 bytes'],
  ] as [string | undefined, string][]) {
    const res = await commitDiff(server, { root: repo, hash, path });
    assert.equal(res.status, 400, `${why} -> ${res.status} ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { error: FS_PATH_BAD });
  }

  // These ARE allowed through the gate — and GIT_LITERAL_PATHSPECS=1 is what
  // makes them file NAMES rather than patterns. `:(glob)*` would otherwise
  // match the whole tree, and `*.txt` every text file in the commit.
  for (const path of [':(glob)*', '*.txt', ':(top)a.txt', '^a.txt', 'a.txt ']) {
    const res = await commitDiff(server, { root: repo, hash, path });
    assert.equal(res.status, 200, `${path} -> ${res.status} ${JSON.stringify(res.body)}`);
    assert.deepEqual(
      res.body,
      { binary: false, tooLarge: false, lines: [] },
      `${JSON.stringify(path)} matched a file it should not have`,
    );
  }

  // Non-vacuity for the pair above: a file REALLY NAMED with a star is found by
  // its literal name, so the route is not simply refusing everything odd.
  const starRepo = join(home, 'star-repo');
  await mkdir(starRepo);
  git(starRepo, 'init', '-q', '-b', 'main');
  await writeFile(join(starRepo, 'star*.txt'), 'one\n');
  git(starRepo, 'add', '-A');
  git(starRepo, 'commit', '-qm', 'star');
  const starHash = revOf(starRepo, 'HEAD');
  const literal = (await commitDiff(server, { root: starRepo, hash: starHash, path: 'star*.txt' }))
    .body as GitCommitDiffResponse;
  assert.equal(literal.lines.length, 2, 'the literal name finds the file (one hunk row, one add)');
  const glob = (await commitDiff(server, { root: starRepo, hash: starHash, path: '*.txt' }))
    .body as GitCommitDiffResponse;
  assert.deepEqual(glob.lines, [], '`*.txt` is a NAME, and no file is called that');
});

test('the boundary, the token and the method are the same on all three routes', async () => {
  const hash = H['second'] as string;
  const cases: [string, number, string][] = [
    ['relative/path', 400, 'a relative root'],
    ['/etc', 403, 'a root outside home'],
    [`${home}evil`, 403, 'the prefix trap'],
    [join(home, 'no-such'), 404, 'a root that is not there'],
    [join(home, 'plain', 'note.txt'), 404, 'a root that is a FILE'],
  ];
  for (const [root_, status, why] of cases) {
    assert.equal((await commits(server, { root: root_ })).status, status, `commits: ${why}`);
    assert.equal((await commit(server, { root: root_, hash })).status, status, `commit: ${why}`);
    assert.equal(
      (await commitDiff(server, { root: root_, hash, path: 'a.txt' })).status,
      status,
      `commit-diff: ${why}`,
    );
  }

  for (const route of ['/api/git/commits', '/api/git/commit', '/api/git/commit-diff']) {
    assert.equal((await api(server, 'GET', route)).status, 400, `${route}: no ?root= is 400`);
    assert.deepEqual((await api(server, 'GET', route)).body, { error: FS_PATH_BAD });
    assert.equal((await api(server, 'POST', route)).status, 405, `${route}: POST is 405`);
    assert.equal((await api(server, 'DELETE', route)).status, 405, `${route}: DELETE is 405`);
    assert.equal(
      (await rawRequest(server.port, { path: route })).status,
      401,
      `${route}: no token is 401`,
    );
    assert.equal(
      (await rawRequest(server.port, { path: route, headers: { 'x-auth-token': '0'.repeat(64) } })).status,
      401,
      `${route}: a wrong token is 401`,
    );
    assert.equal(
      (await rawRequest(server.port, {
        path: route,
        headers: { host: `evil.example.com:${server.port}`, 'x-auth-token': server.token },
      })).status,
      403,
      `${route}: a forbidden Host is 403 even with a valid token`,
    );
    assert.equal(
      (await rawRequest(server.port, {
        path: route,
        headers: { origin: 'http://evil.example.com', 'x-auth-token': server.token },
      })).status,
      403,
      `${route}: a cross-origin request is 403`,
    );
  }
});

// ---------------------------------------------------------------------------
// 6. Logging: counts, never names
// ---------------------------------------------------------------------------

const countGitTraces = (log: string): number => (log.match(/\[git\] git: /g) ?? []).length;

test('ONE line per request, counts only — no hash, no path, no subject, no author', async () => {
  const before_ = countGitTraces(await readServerLog(server));
  await commits(server, { root: repo, limit: '2' });
  await commit(server, { root: repo, hash: H['second'] as string });
  await commitDiff(server, { root: repo, hash: H['second'] as string, path: 'a.txt' });
  await commitDiff(server, { root: repo, hash: H['second'] as string, path: 'bin.dat' });
  await commitDiff(server, { root: repo, hash: H['huge'] as string, path: 'huge.txt' });
  await waitForLog(server, '[git] GET /api/git/commit-diff -> 200, too large');
  const log = await readServerLog(server);

  assert.match(log, /\[git\] GET \/api\/git\/commits -> 200, repo=true, 2 commits, more/);
  assert.match(log, /\[git\] GET \/api\/git\/commit -> 200, 4 files/);
  assert.match(log, /\[git\] GET \/api\/git\/commit-diff -> 200, 9 lines/);
  assert.match(log, /\[git\] GET \/api\/git\/commit-diff -> 200, binary/);
  assert.match(log, /\[git\] GET \/api\/git\/commit-diff -> 200, too large/);

  // ONE trace line per request, whatever the subcommand count: these routes are
  // polled, and five debug lines per poll is how server.log stops being readable.
  assert.equal(countGitTraces(log) - before_, 5, 'five requests, five trace lines');
  assert.match(log, /\[git\] git: rev-parse 0, branch 0, rev-parse 0, rev-list 0, log 0/, 'the commits trace');
  assert.match(log, /\[git\] git: rev-parse 0, rev-parse 0, branch 0, log 0, config \d/, 'the commit trace');

  assert.equal(log.includes(PATH_CANARY), false, 'no path out of git’s output reaches the log');
  assert.equal(log.includes(H['second'] as string), false, 'no hash — not even the one the client sent');
  assert.equal(log.includes('second subject'), false, 'no subject');
  assert.equal(log.includes(FORGED_HASH), false, 'nothing a subject could have carried');
  assert.equal(log.includes('root='), false, 'no query string value at all');
  assert.equal(/\[git\] GET \/api\/git\/commit[^\n]*a\.txt/.test(log), false, 'no path on the route line');
});

test('the polled routes are DEMOTED to debug in the access log; a refusal stays info', async () => {
  await commits(server, { root: repo, limit: '1' });
  await commits(server, { root: `${home}evil` }); // 403
  await waitForLog(server, '[http] GET /api/git/commits ?… -> 403');
  const log = await readServerLog(server);
  for (const route of ['/api/git/commits', '/api/git/commit', '/api/git/commit-diff']) {
    const esc = route.replace(/\//g, '\\/');
    assert.match(log, new RegExp(`\\[debug\\] \\[http\\] GET ${esc} \\?… -> 200`), `${route}: 200 is debug`);
    assert.equal(
      new RegExp(`\\[info\\] \\[http\\] GET ${esc} \\?… -> 200`).test(log),
      false,
      `${route}: and never info`,
    );
  }
  assert.match(log, /\[info\] \[http\] GET \/api\/git\/commits \?… -> 403/, 'a refusal stays info');
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
  const src = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../../server/git.ts', import.meta.url), 'utf8'),
  );
  assert.match(src, /GIT_LITERAL_PATHSPECS: '1'/, 'a pathspec is a file name, never a pattern');
  assert.match(src, /GIT_NO_LAZY_FETCH: '1'/, 'a promisor remote is never contacted mid-read');
  assert.match(src, /LC_ALL: 'C'/);
  assert.match(src, /env: \{ \.\.\.process\.env, \.\.\.GIT_ENV \}/, 'and every spawn gets it');
  assert.equal([...src.matchAll(/spawn\(/g)].length, 1, 'still exactly one spawn site in the runner');

  const logSrc = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../../server/git-log.ts', import.meta.url), 'utf8'),
  );
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

// ---------------------------------------------------------------------------
// 8. The caps, through a fake `git` first on the PATH
// ---------------------------------------------------------------------------

test('a `git log` that floods stdout is killed and the request fails — it does not grow the backend', async () => {
  const res = await commits(fakeServer, { root: join(home, 'fake-flood') });
  assert.equal(res.status, 500, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: 'The app could not read this repository.' });
  await waitForLog(fakeServer, '[git] git log produced more than 2097152 bytes; killed');
  await new Promise((r) => setTimeout(r, 500)); // past the chunks queued behind the SIGKILL
  const log = await readServerLog(fakeServer);
  const warns = log.match(/git log produced more than 2097152 bytes; killed/g) ?? [];
  assert.equal(warns.length, 1, `exactly one warn line per capped request, got ${warns.length}`);
  const killed = (log.match(/\[git\] git: [^\n]*/g) ?? []).filter((l) => l.includes('killed'));
  assert.equal(killed.length, 1, `exactly one capped request line, got ${killed.length}`);
});

test('a `git log` that hangs is SIGKILLed at the timeout — the request never hangs', async () => {
  // MONOTONIC, not Date.now(): this host is WSL2, whose wall clock is resynced
  // against the Windows host and was MEASURED jumping 1.9 s BACKWARD inside a
  // 10 s window (2026-09-16).
  const started = process.hrtime.bigint();
  const res = await commits(fakeServer, { root: join(home, 'fake-slow') });
  const took = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'The app could not read this repository.' });
  assert.ok(took >= 5_000, `the timeout is what ended it (${took.toFixed(0)}ms)`);
  assert.ok(took < 20_000, `and it ended there, not at the sleep's 30 s (${took.toFixed(0)}ms)`);
  assert.match(await readServerLog(fakeServer), /\[git\] git log timed out after 5000ms; killed/);
});

test('a `rev-list --count` that times out costs the TOTAL, not the page', async () => {
  // `rev-list --count` walks the WHOLE history, so it is the one call here
  // that a merely enormous repository can push past the 5 s SIGKILL. Its
  // rejection used to take the request with it: a page of rows the app had
  // already paid for, thrown away for a number in a header.
  //
  // And the degraded value is NOT 0 — `main, 0 commits` printed over a full
  // list is a lie the user can see. It is a FLOOR: what this page proves
  // exists, wrong only by being too small, and exact on the last page.
  const res = await commits(fakeServer, { root: join(home, 'fake-revslow'), limit: '10' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as GitCommitsResponse;
  assert.equal(body.isRepo, true);
  assert.equal(body.commits.length, 1, 'the rows survive');
  assert.equal(body.commits[0]?.subject, 'only commit');
  assert.equal(body.more, false);
  assert.equal(body.total, 1, 'skip + rows + (more ? 1 : 0), not 0');

  const log = await readServerLog(fakeServer);
  assert.match(log, /\[git\] git rev-list timed out after 5000ms; killed/);
  assert.match(log, /git rev-list did not answer; commit total is a floor/);
  assert.match(log, /\[git\] GET \/api\/git\/commits -> 200, repo=true, 1 commits/);

  // A page that is NOT the last one floors to one past what it holds.
  const paged = (await commits(fakeServer, { root: join(home, 'fake-revslow'), limit: '1', skip: '5' }))
    .body as GitCommitsResponse;
  assert.equal(paged.total, 6, 'skip 5 + the one row it holds, and `more` is false here');
});

test('the degraded TOTAL counts the page AFTER this one too, whenever `more` is true', async () => {
  // The floor is `skip + rows + (more ? 1 : 0)`, and the last term is the only
  // part the *-revslow fixture cannot reach: its git answers ONE record, so
  // `more` is never true there. This git answers TWO whatever `--max-count`
  // asks for, and its `rev-list` exits non-zero (the other way the count can
  // fail — no 5 s timeout to pay for), so a page with `more` true is floored
  // here. Without the term the header reads `10 commits` under a list that
  // visibly has an eleventh page.
  const first = (await commits(fakeServer, { root: join(home, 'fake-total'), limit: '1' }))
    .body as GitCommitsResponse;
  assert.equal(first.commits.length, 1, 'the page is the size that was asked for');
  assert.equal(first.more, true, 'and the extra record is what says there is more');
  assert.equal(first.total, 2, 'skip 0 + 1 row + 1 for the page that follows');

  const deeper = (await commits(fakeServer, { root: join(home, 'fake-total'), limit: '1', skip: '3' }))
    .body as GitCommitsResponse;
  assert.equal(deeper.total, 5, 'skip 3 + 1 row + 1');
  assert.match(await readServerLog(fakeServer), /git rev-list did not answer; commit total is a floor/);
});
