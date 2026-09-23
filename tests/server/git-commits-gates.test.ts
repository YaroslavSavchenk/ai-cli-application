/**
 * GET /api/git/commits, /api/git/commit, /api/git/commit-diff — the gates
 * every client string passes before it reaches git's argv (the hash, the
 * limit and skip, the path), the boundary, token and method shared by all
 * three routes, and the logging: one line per request, counts, never names
 * (B3, spec `.claude/plans/nocturne/PLAN-B3.md` § "Phase 1 — backend").
 *
 * How: a real server child whose home boundary is the fixture tree
 * (AI_SM_HOME_OVERRIDE), plus raw requests for the token, Host and Origin
 * refusals; the log assertions read that child's server.log.
 *
 * Why: a hash with a leading dash or a pathspec pattern that reached argv is
 * an OPTION or a glob, not a name; a hash or a path in server.log is the
 * user's history leaking into a file they share when reporting a bug.
 *
 * NOT claimed here: the answers of the routes (`git-commits-routes.test.ts`),
 * a hostile repository config (`git-commits-hostile-repo.test.ts`).
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
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitCommitDiffResponse } from '../../shared/protocol.ts';
import { GIT_COMMIT_BAD, GIT_COMMIT_GONE } from '../../server/git-log.ts';
import { FS_PATH_BAD } from '../../server/fsbrowse.ts';
import {
  api,
  rawRequest,
  readServerLog,
  waitForLog,
  type TestServer,
  removeTempDir,
  git,
} from '../helpers/helpers.ts';
import {
  FORGED_HASH,
  PATH_CANARY,
  commit,
  commitDiff,
  commits,
  makeCommitsFixture,
  revOf,
  startCommitsServer,
} from '../helpers/git-commits-fixture.ts';

let server: TestServer;
let root: string;
let home: string;
let repo: string;
let paging: string;
/** Hashes of the `repo` fixture, newest first, filled in by `before`. */
let H: Record<string, string> = {};

before(async () => {
  ({ root, home, repo, paging, H } = await makeCommitsFixture());
  server = await startCommitsServer({ root, home });
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (root !== undefined) await removeTempDir(root);
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
