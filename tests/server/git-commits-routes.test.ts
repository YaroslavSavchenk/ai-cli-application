/**
 * GET /api/git/commits, /api/git/commit, /api/git/commit-diff — the answers:
 * the list's pages, its pin and its states, one commit's message, people,
 * parents, files and github remote, and one file's numbered diff rows, with
 * the caps that shape them (B3, spec `.claude/plans/nocturne/PLAN-B3.md`
 * § "Phase 1 — backend").
 *
 * How: a real server child whose home boundary is the fixture tree
 * (AI_SM_HOME_OVERRIDE), driving real repositories — a merge, a rename, a
 * binary file, a hostile subject, a patch past the runner's 2 MiB stdout cap.
 *
 * NOT claimed here: the parsers alone (`git-commits.test.ts`), the gates on
 * client strings and the logging (`git-commits-gates.test.ts`), a hostile
 * repository config (`git-commits-hostile-repo.test.ts`), the fake-git caps
 * (`git-commits-caps.test.ts`), or what the panel draws from these answers.
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
import type {
  GitCommitDiffResponse,
  GitCommitResponse,
  GitCommitsResponse,
} from '../../shared/protocol.ts';
import {
  ISO_RE,
  MAX_COMMIT_FILES,
  MAX_DIFF_LINE_CHARS,
  MAX_DIFF_LINES,
} from '../../server/git-log.ts';
import {
  api,
  readServerLog,
  waitForLog,
  type TestServer,
  removeTempDir,
  git,
} from '../helpers/helpers.ts';
import {
  FORGED_HASH,
  PATH_CANARY,
  REMOTE_TOKEN,
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
