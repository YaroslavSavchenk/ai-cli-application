/**
 * The PURE parsers behind GET /api/git/commits, /api/git/commit and
 * /api/git/commit-diff — the Files panel's `Commits` tab and commit view (B3,
 * spec `.claude/plans/nocturne/PLAN-B3.md` § "Phase 1 — backend"):
 * parseLogRecords / parseUnifiedDiff / parseGithubRemote, the ISO date check
 * and the page bounds and caps, against strings MEASURED by running git 2.43.0
 * — including a commit whose SUBJECT carries the record-framing bytes.
 *
 * How: in-process calls, no server, no repository.
 *
 * NOT claimed here: the routes. They are driven against a real server child
 * and real repositories in the other `tests/server/git-commits-*.test.ts`
 * files: `-routes` (the three routes' answers), `-gates` (every client string
 * before argv, the boundary, the logging), `-hostile-repo` (what a
 * repository's own config must not make this backend do) and `-caps` (the
 * stdout cap and the timeouts, through a fake `git`).
 *
 * This file was one of eight topics; PLAN-RESTRUCTURE O6 split the others
 * out. Their fixture home and request helpers are
 * `tests/helpers/git-commits-fixture.ts`.
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LIMIT,
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
import { HOSTILE_SUBJECT, REMOTE_TOKEN } from '../helpers/git-commits-fixture.ts';

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
