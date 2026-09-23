/**
 * GET /api/git/changes — the Files panel's `Changes` tab (B2).
 *
 * Three parts:
 *   1. the PARSERS (parseNumstatZ / parsePorcelainZ) against strings MEASURED
 *      by running git 2.43.0 in a temp repo — the `-z` rename forms, a binary
 *      file, a name with a space, a `"` and a non-ASCII character;
 *   2. the ROUTE against a real server child whose home boundary is the fixture
 *      tree (AI_SM_HOME_OVERRIDE), driving real repositories;
 *   3. the caps and the log hygiene.
 *
 * The stdout cap and the 5 s timeout are driven with a FAKE `git` first on the
 * PATH of a second server child: one script that answers the two probes
 * normally and then, by the name of the directory it is called in, either
 * floods stdout (`yes`) or sleeps past the timeout.
 *
 * NOT claimed here: what a repository's own config must not make this backend
 * do, and the registered-project anchor — `tests/server/git-changes-repo-safety.test.ts`
 * (split out by topic, PLAN-RESTRUCTURE O6; the shared setup is
 * `tests/helpers/git-changes-fixture.ts`).
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, rm, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitChangesResponse } from '../../shared/protocol.ts';
import { GIT_READ_FAILED, MAX_CHANGED_FILES, parseNumstatZ, parsePorcelainZ } from '../../server/git.ts';
import {
  FS_LIST_GONE,
  FS_NO_READ_PERMISSION,
  FS_OUTSIDE_HOME,
  FS_PATH_BAD,
  FS_READ_FAILED,
} from '../../server/fsbrowse.ts';
import {
  api,
  rawRequest,
  readServerLog,
  startTestServer,
  waitForLog,
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

let server: TestServer;
let fakeServer: TestServer;
let root: string;
let home: string;
let repo: string;

/** An untracked file name that must never reach server.log. */
const GIT_CANARY = 'GITNAMECANARY_qz.txt';

/** What the fake git writes to STDERR: it must reach neither a body nor a log line. */
const STDERR_CANARY = 'STDERRCANARY_qz';

/** A segment of the `?root=` the CLIENT sends: it must reach no log line either. */
const ROOT_CANARY = 'ROOTCANARY_qz';

before(async () => {
  ({ root, home } = await makeChangesHome());
  repo = join(home, 'repo');
  await mkdir(repo);
  // The PREFIX TRAP: `<home>evil` is a string prefix of home and a real folder.
  await mkdir(`${home}evil`);
  // A real folder OUTSIDE home with a canary name: asking for it is a 403 that
  // carries a client-sent path, the shape the log must not keep.
  await mkdir(join(`${home}evil`, ROOT_CANARY));

  // --- the committed state ---
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'keep.txt'), 'a\nb\nc\n');
  await writeFile(join(repo, 'mod.txt'), 'x\ny\n');
  await writeFile(join(repo, 'del.txt'), 'gone\n');
  await writeFile(join(repo, 'old name".txt'), 'old\n');
  await writeFile(join(repo, 'café.txt'), 'unicode\n');
  await writeFile(join(repo, 'with space.txt'), 'spaced\n');
  await writeFile(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  await mkdir(join(repo, 'pkg'));
  await writeFile(join(repo, 'pkg', 'inner.txt'), 'p\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');

  // --- the working state the tab is about ---
  await writeFile(join(repo, 'mod.txt'), 'x\ny\nz\nw\n'); // +2 -0
  await rm(join(repo, 'del.txt'));
  git(repo, 'mv', 'old name".txt', 'new name".txt');
  await writeFile(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 4, 5]));
  await writeFile(join(repo, 'café.txt'), 'unicode\nmore\n'); // +1
  await writeFile(join(repo, 'with space.txt'), 'spaced\nmore\n'); // +1
  await writeFile(join(repo, GIT_CANARY), 'untracked\n');
  await writeFile(join(repo, 'staged.txt'), 'one\ntwo\n');
  git(repo, 'add', 'staged.txt');

  // A repository with MORE changes than the cap, so `truncated` is a real number.
  const bigRepo = join(home, 'big-repo');
  await mkdir(bigRepo);
  git(bigRepo, 'init', '-q', '-b', 'main');
  await writeFile(join(bigRepo, 'seed.txt'), 'a\n');
  git(bigRepo, 'add', '-A');
  git(bigRepo, 'commit', '-qm', 'init');
  for (let i = 0; i < MAX_CHANGED_FILES + 7; i += 1) {
    await writeFile(join(bigRepo, `f${String(i).padStart(5, '0')}.txt`), 'x\n');
  }

  // A folder that is not a repository, and an empty repository.
  await mkdir(join(home, 'plain'));
  await writeFile(join(home, 'plain', 'note.txt'), 'x\n');
  const fresh = join(home, 'fresh-repo');
  await mkdir(fresh);
  git(fresh, 'init', '-q', '-b', 'main');
  await writeFile(join(fresh, 'staged.txt'), 'a\n');
  await writeFile(join(fresh, 'loose.txt'), 'b\n');
  // Staged, then removed from the worktree again: porcelain says `AD`, which is
  // the ONE shape in an empty repository whose status letters do not already
  // mean `new`. Without it the "no HEAD means everything is new" rule is
  // indistinguishable from "read the letters".
  await writeFile(join(fresh, 'addthengone.txt'), 'c\n');
  git(fresh, 'add', 'staged.txt', 'addthengone.txt');
  await rm(join(fresh, 'addthengone.txt'));

  server = await startChangesServer({ root, home });

  // --- the fake-git server (cap + timeout) ---
  const binDir = join(root, 'fakebin');
  await mkdir(binDir);
  await writeFile(
    join(binDir, 'git'),
    [
      '#!/bin/sh',
      '# A fake git for two tests only: it answers the probes and then behaves',
      '# badly in a way named by the directory it is called in.',
      'if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then echo "$PWD"; exit 0; fi',
      'if [ "$1" = "rev-parse" ]; then exit 0; fi',
      'if [ "$1" = "branch" ]; then echo main; exit 0; fi',
      'if [ "$1" = "diff" ]; then',
      '  case "$PWD" in',
      '    *-slow) sleep 30; exit 0;;',
      '    *-flood) exec yes "0\t0\tpadding-to-make-the-lines-worth-something";;',
      `    *-fail) echo "fatal: ${STDERR_CANARY} while reading /a/secret/path" >&2; exit 128;;`,
      '  esac',
      'fi',
      'exit 0',
    ].join('\n'),
    { mode: 0o755 },
  );
  await chmod(join(binDir, 'git'), 0o755);
  await mkdir(join(home, 'fake-slow'));
  await mkdir(join(home, 'fake-flood'));
  await mkdir(join(home, 'fake-fail'));
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
  if (root !== undefined) await removeTempDir(root);
});

// ---------------------------------------------------------------------------
// 1. The parsers, against MEASURED output (git 2.43.0)
// ---------------------------------------------------------------------------

test('parseNumstatZ: the ordinary, binary and RENAME forms of `git diff --numstat -z HEAD`', () => {
  // Measured verbatim (NULs shown as \0):
  //   -\t-\tbin.dat\0 0\t1\tdel.txt\0 2\t0\tmod.txt\0 0\t0\t\0old name".txt\0new name".txt\0
  const measured =
    '-\t-\tbin.dat\0' +
    '0\t1\tdel.txt\0' +
    '2\t0\tmod.txt\0' +
    '1\t0\tcafé.txt\0' +
    '1\t0\twith space.txt\0' +
    '0\t0\t\0old name".txt\0new name".txt\0';
  const map = parseNumstatZ(measured);
  assert.deepEqual(map.get('bin.dat'), { add: null, del: null }, 'a binary file prints `-` for both');
  assert.deepEqual(map.get('del.txt'), { add: 0, del: 1 });
  assert.deepEqual(map.get('mod.txt'), { add: 2, del: 0 });
  assert.deepEqual(map.get('café.txt'), { add: 1, del: 0 }, 'a non-ASCII name survives -z verbatim');
  assert.deepEqual(map.get('with space.txt'), { add: 1, del: 0 }, 'so does a space');
  assert.deepEqual(
    map.get('new name".txt'),
    { add: 0, del: 0 },
    'a rename is keyed by the NEW path — the row the panel shows',
  );
  assert.equal(map.has('old name".txt'), false, 'and the old one is not a row');
  assert.equal(map.size, 6);
  assert.equal(parseNumstatZ('').size, 0, 'no changes is not a parse error');
});

test('parsePorcelainZ: the status letters, the RENAME pair and the untracked forms', () => {
  // Measured verbatim:
  //   AM added.txt\0 M bin.dat\0 D del.txt\0 M mod.txt\0
  //   R  new name".txt\0old name".txt\0?? fresh.txt\0?? sub/\0
  const measured =
    'AM added.txt\0' +
    ' M bin.dat\0' +
    ' D del.txt\0' +
    ' M mod.txt\0' +
    'R  new name".txt\0old name".txt\0' +
    '?? fresh.txt\0' +
    '?? sub/\0' +
    'A  staged.txt\0';
  assert.deepEqual(parsePorcelainZ(measured), [
    { path: 'added.txt', status: 'new' },
    { path: 'bin.dat', status: 'modified' },
    { path: 'del.txt', status: 'deleted' },
    { path: 'mod.txt', status: 'modified' },
    // The rename's SECOND field (the old path) is consumed, never emitted.
    { path: 'new name".txt', status: 'renamed' },
    { path: 'fresh.txt', status: 'new' },
    // `--untracked-files=normal` collapses a whole new folder into ONE entry
    // with a trailing slash. Kept verbatim: dropping it would call a folder a file.
    { path: 'sub/', status: 'new' },
    { path: 'staged.txt', status: 'new' },
  ]);
  assert.deepEqual(parsePorcelainZ(''), [], 'a clean tree is not a parse error');
  assert.deepEqual(parsePorcelainZ('UU conflict.txt\0'), [
    { path: 'conflict.txt', status: 'modified' },
  ]);
});

// ---------------------------------------------------------------------------
// 2. The route, against real repositories
// ---------------------------------------------------------------------------

test('a repository answers its branch, its root and one row per change', async () => {
  const res = await changes(server, repo);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as GitChangesResponse;
  assert.equal(body.isRepo, true);
  assert.equal(body.repoRoot, repo);
  assert.equal(body.branch, 'main');
  assert.equal(body.truncated, 0);

  assert.deepEqual(fileOf(body, 'mod.txt'), { path: 'mod.txt', add: 2, del: 0, status: 'modified' });
  assert.deepEqual(fileOf(body, 'del.txt'), { path: 'del.txt', add: 0, del: 1, status: 'deleted' });
  assert.deepEqual(fileOf(body, 'bin.dat'), {
    path: 'bin.dat',
    add: null,
    del: null,
    status: 'modified',
  });
  assert.deepEqual(fileOf(body, 'new name".txt'), {
    path: 'new name".txt',
    add: 0,
    del: 0,
    status: 'renamed',
  });
  assert.equal(fileOf(body, 'old name".txt'), undefined, 'the old name is not a row of its own');
  assert.deepEqual(fileOf(body, GIT_CANARY), {
    path: GIT_CANARY,
    add: null,
    del: null,
    status: 'new',
  });
  assert.deepEqual(fileOf(body, 'staged.txt'), {
    path: 'staged.txt',
    add: 2,
    del: 0,
    status: 'new',
  }, 'a STAGED add is new and keeps its real numbers');
  assert.deepEqual(fileOf(body, 'café.txt'), {
    path: 'café.txt',
    add: 1,
    del: 0,
    status: 'modified',
  }, 'a non-ASCII name survives the round trip');
  assert.deepEqual(fileOf(body, 'with space.txt'), {
    path: 'with space.txt',
    add: 1,
    del: 0,
    status: 'modified',
  });
  assert.equal(fileOf(body, 'keep.txt'), undefined, 'an unchanged file is not a row');
  // Every path is REPO-RELATIVE, `/` separated — never an absolute path.
  for (const f of body.files) {
    assert.ok(!f.path.startsWith('/'), `repo-relative: ${JSON.stringify(f.path)}`);
  }
});

test('a root INSIDE the repository answers the repository, not the subtree', async () => {
  const res = await changes(server, join(repo, 'pkg'));
  assert.equal(res.status, 200);
  const body = res.body as GitChangesResponse;
  assert.equal(body.repoRoot, repo, 'the repo root may be an ANCESTOR of the panel root');
  assert.ok(fileOf(body, 'mod.txt') !== undefined, 'and its changes are the repository’s');
});

test('a folder that is NOT a repository is a STATE, not an error', async () => {
  const res = await changes(server, join(home, 'plain'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    isRepo: false,
    repoRoot: null,
    branch: null,
    files: [],
    truncated: 0,
  });
});

test('an EMPTY repository (no commit yet) answers every file as new', async () => {
  const res = await changes(server, join(home, 'fresh-repo'));
  assert.equal(res.status, 200);
  const body = res.body as GitChangesResponse;
  assert.equal(body.isRepo, true);
  assert.deepEqual(
    body.files,
    [
      // Porcelain lists the INDEX entries first, then the untracked ones.
      { path: 'addthengone.txt', add: null, del: null, status: 'new' },
      { path: 'staged.txt', add: null, del: null, status: 'new' },
      { path: 'loose.txt', add: null, del: null, status: 'new' },
    ],
    'no HEAD means no numstat pass: nothing has ever been committed',
  );
  // The `AD` row is what pins the rule rather than the letters: statusOf() reads
  // that pair as `deleted`, and a repository with no commit has nothing to have
  // deleted anything FROM — so `new` is the only honest word for it.
  assert.equal(
    body.files.find((f) => f.path === 'addthengone.txt')?.status,
    'new',
    'with no HEAD every path is new, whatever the index letters say',
  );
  // MEASURED, and it contradicts the plan's type comment: `git branch
  // --show-current` prints `main` in a repository with no commits, so the
  // honest answer is the branch name, not null. (null stays the DETACHED case.)
  assert.equal(body.branch, 'main');
});

test('a DETACHED head answers branch null — the one case the field was typed for', async () => {
  // `git branch --show-current` prints NOTHING on a detached HEAD (measured,
  // git 2.43.0), and the empty string is not a branch name: the panel would
  // draw an empty chip for it. null is the documented value, and nothing else
  // in this file ever reaches that branch — an empty repository prints `main`.
  const detached = join(home, 'detached-repo');
  await mkdir(detached);
  git(detached, 'init', '-q', '-b', 'main');
  await writeFile(join(detached, 'a.txt'), 'a\n');
  git(detached, 'add', '-A');
  git(detached, 'commit', '-qm', 'one');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: detached, encoding: 'utf8' }).trim();
  git(detached, 'checkout', '-q', '--detach', head);
  await writeFile(join(detached, 'a.txt'), 'a\nb\n');

  const res = await changes(server, detached);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as GitChangesResponse;
  assert.equal(body.isRepo, true, 'a detached head is still a repository');
  assert.equal(body.branch, null, 'no branch name, and NOT an empty string');
  assert.deepEqual(
    body.files,
    [{ path: 'a.txt', add: 1, del: 0, status: 'modified' }],
    'and the changes are answered exactly as on a branch',
  );
});

test('the boundary and the shapes: outside home, missing, a file, a relative root, no root at all', async () => {
  const cases: [string | undefined, number, string][] = [
    [undefined, 400, 'no ?root= at all'],
    ['relative/path', 400, 'a relative root'],
    ['', 400, 'an empty root'],
    ['/etc', 403, 'a root outside home'],
    [`${home}evil`, 403, 'the prefix trap (the sibling does not even exist)'],
    [join(home, 'no-such'), 404, 'a root that is not there'],
    // Order is load-bearing: the realpath happens BEFORE the containment test,
    // so a path outside home that does not EXIST is a 404, not a 403. It tells
    // an unauthorized caller nothing it could not already ask about home.
    ['/etc/no-such-thing-here', 404, 'a missing path outside home'],
    [join(home, 'plain', 'note.txt'), 404, 'a root that is a FILE'],
  ];
  for (const [value, status, why] of cases) {
    const res = await changes(server, value);
    assert.equal(res.status, status, `${why} -> ${res.status} ${JSON.stringify(res.body)}`);
  }
  assert.deepEqual((await changes(server, '/etc')).body, {
    error: 'This folder is outside your home folder.',
  });
});

test('the route needs the token, and a wrong method is 405', async () => {
  const noToken = await rawRequest(server.port, { path: '/api/git/changes' });
  assert.equal(noToken.status, 401, 'no token must be 401');
  const wrongToken = await rawRequest(server.port, {
    path: '/api/git/changes',
    headers: { 'x-auth-token': '0'.repeat(64) },
  });
  assert.equal(wrongToken.status, 401, 'a wrong token must be 401');
  assert.equal((await api(server, 'POST', '/api/git/changes')).status, 405);

  const evilHost = await rawRequest(server.port, {
    path: '/api/git/changes',
    headers: { host: `evil.example.com:${server.port}`, 'x-auth-token': server.token },
  });
  assert.equal(evilHost.status, 403, 'a forbidden Host is 403 even with a valid token');
  const evilOrigin = await rawRequest(server.port, {
    path: '/api/git/changes',
    headers: { origin: 'http://evil.example.com', 'x-auth-token': server.token },
  });
  assert.equal(evilOrigin.status, 403, 'a cross-origin request is 403');
});

const countGitLines = (log: string): number => (log.match(/\[git\] git: /g) ?? []).length;

test('server.log records every SUBCOMMAND and its exit status in ONE line — never a path out of git, never stderr', async () => {
  const before_ = countGitLines(await readServerLog(server));
  await changes(server, repo);
  await waitForLog(server, '[git] GET /api/git/changes');
  const log = await readServerLog(server);

  // ONE line per request, not one per subcommand: this route is polled every
  // 5 s while the Changes tab is up, and five debug lines per poll is how
  // server.log stops being readable.
  assert.ok(
    log.includes('[git] git: rev-parse 0, rev-parse 0, branch 0, diff 0, status 0'),
    `every subcommand and its exit status, joined: ${log
      .split('\n')
      .filter((l) => l.includes('[git] git:'))
      .join(' | ')}`,
  );
  assert.equal(
    /\[git\] git [a-z-]+ exited /.test(log),
    false,
    'and NOT one line per subcommand any more',
  );
  assert.equal(
    countGitLines(log) - before_,
    1,
    'exactly ONE such line for the ONE request this test made',
  );
  assert.match(log, /\[git\] GET \/api\/git\/changes -> 200, repo=true, \d+ files/);
  assert.ok(log.includes('[http] GET /api/git/changes ?… -> 200'), 'and the access line');
  assert.ok(!log.includes(GIT_CANARY), 'NO path out of git’s output reaches the log');
  assert.ok(!log.includes('new name'), 'not even a renamed one');
  assert.ok(!log.includes('root='), 'no query string value at all');
});

test('the 5 s poll is DEMOTED to debug in the access log; a refusal stays info', async () => {
  // The /api/update/status precedent: a route the UI polls cannot be written
  // at info, or the steady state buries every other line in the file. Only the
  // 200 is demoted — a refusal is exactly the diagnostic worth keeping loud.
  await changes(server, repo);
  await changes(server, `${home}evil`); // 403
  await waitForLog(server, '[http] GET /api/git/changes ?… -> 403');
  const log = await readServerLog(server);

  assert.match(log, /\[debug\] \[http\] GET \/api\/git\/changes \?… -> 200/, 'the 200 is debug');
  assert.equal(
    /\[info\] \[http\] GET \/api\/git\/changes \?… -> 200/.test(log),
    false,
    'and never info',
  );
  assert.match(log, /\[info\] \[http\] GET \/api\/git\/changes \?… -> 403/, 'a refusal stays info');
});

// ---------------------------------------------------------------------------
// 3. The caps, through a fake `git` first on the PATH
// ---------------------------------------------------------------------------

test('a git that floods stdout is killed and the request fails — it does not grow the backend', async () => {
  const res = await changes(fakeServer, join(home, 'fake-flood'));
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'The app could not read this repository.' });
  await waitForLog(fakeServer, '[git] git: rev-parse 0, rev-parse 0, branch 0, diff killed');
  // The chunks already queued behind the SIGKILL keep arriving for a moment;
  // wait past them before counting, or a regression could pass by being read
  // too early.
  await sleep(500);
  const log = await readServerLog(fakeServer);
  assert.match(log, /\[git\] git diff produced more than 2097152 bytes; killed/);
  // ONE capped request = ONE warn line and ONE `killed`. The cap handler used
  // to fire again on every buffered chunk that arrived after the kill (`capped`
  // was set but never read), so a single flood wrote N identical warn lines and
  // a trace line reading `diff killed, diff killed, …`.
  const warns = log.match(/git diff produced more than 2097152 bytes; killed/g) ?? [];
  assert.equal(warns.length, 1, `exactly one warn line per capped request, got ${warns.length}`);
  const killedTraces = (log.match(/\[git\] git: [^\n]*/g) ?? []).filter((l) => l.includes('killed'));
  assert.equal(killedTraces.length, 1, `exactly one capped request line, got ${killedTraces.length}`);
  assert.equal(
    (killedTraces[0].match(/killed/g) ?? []).length,
    1,
    `and exactly one \`killed\` inside it: ${killedTraces[0]}`,
  );
});

test('a git that hangs is SIGKILLed at the timeout and the request fails — it never hangs', async () => {
  // MONOTONIC, not Date.now(): this host is WSL2, whose wall clock is resynced
  // against the Windows host and was MEASURED jumping 1.9 s BACKWARD inside a
  // 10 s window (2026-09-16). A `Date.now()` difference therefore says 2.5 s for
  // a 5 s wait every few runs, and the assertion below is exactly the shape that
  // catches — a flaky test is worse than no test, so the clock is the one that
  // only moves forward.
  const started = process.hrtime.bigint();
  const res = await changes(fakeServer, join(home, 'fake-slow'));
  const took = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'The app could not read this repository.' });
  assert.ok(took >= 5_000, `the timeout is what ended it (${took.toFixed(0)}ms)`);
  assert.ok(took < 20_000, `and it ended there, not at the sleep's 30 s (${took.toFixed(0)}ms)`);
  const log = await readServerLog(fakeServer);
  assert.match(log, /\[git\] git diff timed out after 5000ms; killed/);
});

test('a renamed file keeps working after the rename is committed (no stale state in the module)', async () => {
  // Nothing caches per repository, so this is a cheap guard against one being
  // added later without a test.
  await rename(join(repo, 'mod.txt'), join(repo, 'mod2.txt'));
  const res = await changes(server, repo);
  assert.equal(res.status, 200);
  const body = res.body as GitChangesResponse;
  assert.equal(fileOf(body, 'mod.txt')?.status, 'deleted');
  assert.equal(fileOf(body, 'mod2.txt')?.status, 'new');
  await rename(join(repo, 'mod2.txt'), join(repo, 'mod.txt'));
});

test("a git subcommand that FAILS answers the constant sentence — its stderr reaches neither the body nor the log", async () => {
  // The untested half of the module until now: capturedOrFail's throw. git's
  // own error text quotes paths ("fatal: … while reading /a/secret/path"), so
  // the module runs with stderr on 'ignore' — it is never captured, which is
  // what makes it unable to reach a response body or a log line. A build that
  // piped stderr "for diagnostics" would put a filesystem path in both.
  const res = await changes(fakeServer, join(home, 'fake-fail'));
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'The app could not read this repository.' });
  assert.ok(!JSON.stringify(res.body).includes(STDERR_CANARY), "git's words never become the app's");

  await waitForLog(fakeServer, '[git] git: rev-parse 0, rev-parse 0, branch 0, diff 128');
  const log = await readServerLog(fakeServer);
  assert.ok(
    log.includes('[git] git: rev-parse 0, rev-parse 0, branch 0, diff 128'),
    'every subcommand and its status ARE logged, in the one line',
  );
  assert.ok(!log.includes(STDERR_CANARY), 'and not one byte of what git said');
  assert.ok(!log.includes('/a/secret/path'), 'nor the path git named');
});

test('server/git.ts spawns git by ARGV only: shell false, stderr discarded, no credential prompt', () => {
  // NOT observable through the route, and the test says so rather than
  // pretending: every argument this module builds is a constant, so `shell:
  // true` behaves identically TODAY. The promise the module makes ("nothing is
  // ever interpolated into a shell string") is about the day a user value
  // enters an argument, and a behavioural test cannot hold a promise about a
  // line that does not exist yet. So the option itself is pinned.
  const src = readSource('server/git.ts');
  assert.match(src, /shell: false/, 'argv, never a shell');
  assert.equal(/shell:\s*true/.test(src), false, 'and no shell anywhere in the module');
  assert.match(src, /GIT_TERMINAL_PROMPT: '0'/, 'a remote can never park a child on a prompt');
  assert.match(src, /stdio: \['ignore', 'pipe', 'ignore'\]/, "stdin ignored, stderr discarded");
  // One spawn site, and it is handed an ARRAY — never a composed command line.
  assert.equal([...src.matchAll(/spawn\(/g)].length, 1, 'exactly one spawn site');
  assert.match(src, /spawn\('git', args as string\[\], \{/, 'the command is a literal, the args an array');
  assert.equal(/spawn\(`/.test(src), false, 'no template literal is ever a command');
});

test("a root the CLIENT sent reaches no log line — not even the access line's reason= field", async () => {
  // The twin of the same claim on GET /api/fs/entries. `?…` hides the query
  // VALUE from the access line, but that line's `reason=` prints server/api.ts's
  // `responseReason`, whose contract is CONSTANTS ONLY. A route that recorded
  // the requested root there would write a filesystem path into server.log
  // through a door the `?…` rule does not cover.
  await changes(server, join(home, ROOT_CANARY)); // 404, a canary inside home
  await changes(server, join(`${home}evil`, ROOT_CANARY)); // 403, a canary outside it
  await waitForLog(server, '[http] GET /api/git/changes ?… -> 403');
  const log = await readServerLog(server);

  assert.ok(!log.includes(ROOT_CANARY), 'no segment of a client root reaches the log');

  const allowed = [
    FS_PATH_BAD,
    FS_OUTSIDE_HOME,
    FS_NO_READ_PERMISSION,
    FS_LIST_GONE,
    FS_READ_FAILED,
    GIT_READ_FAILED,
    // server/api.ts's own gate constants — the route never runs for these.
    'unauthorized',
    'forbidden host',
    'forbidden origin',
    'method not allowed',
  ];
  const reasons = [...log.matchAll(/GET \/api\/git\/changes [^\n]*? reason=("(?:[^"\\]|\\.)*")/g)].map(
    (m) => JSON.parse(m[1] as string) as string,
  );
  assert.ok(reasons.length >= 2, `non-vacuity: only ${reasons.length} refusals logged`);
  for (const reason of reasons) {
    assert.ok(allowed.includes(reason), `a non-constant reason reached the log: ${JSON.stringify(reason)}`);
  }
});

test(`more than ${MAX_CHANGED_FILES} changed files are capped, and the leftovers are COUNTED`, async () => {
  // The other cap in this module, and the one with no safety net behind it: the
  // stdout cap and the timeout both end the request loudly, but a silently
  // dropped row would look exactly like a clean file. `truncated` is what makes
  // the difference visible, so the number has to be right.
  const res = await changes(server, join(home, 'big-repo'));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as GitChangesResponse;
  assert.equal(body.isRepo, true);
  assert.equal(body.files.length, MAX_CHANGED_FILES, 'the cap is the window');
  assert.equal(body.truncated, 7, 'and the rest are counted, not forgotten');
  assert.equal(body.files[0]?.path, 'f00000.txt', 'the window is the FIRST of git’s own order');
  assert.equal(body.files[MAX_CHANGED_FILES - 1]?.path, `f0${MAX_CHANGED_FILES - 1}.txt`);
});
