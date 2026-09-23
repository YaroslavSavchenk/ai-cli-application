/**
 * `web/src/ui/commit-model.ts` — the arithmetic and the copy of the commits
 * list and the commit view (Nocturne A6, live since B3), with no DOM: the
 * five-block bar, the author's initial, the two ways one timestamp is said,
 * the plural sentences, the collapse key, the block id and the ONE address
 * this screen may leave for.
 *
 * WHY separately from the DOM test. These are the answers the view RENDERS; a
 * wrong bar, a date read in the wrong zone or an owner that slips past the
 * pattern check is invisible to a wiring test that only asks "is there a row".
 * The same split A5 made between `ui-files-model.test.ts` and
 * `ui-files-panel.test.ts`.
 *
 * WHAT PART B4 DELETED from this file: the last two pins on `ui/files-mock.ts`
 * (a path the map had text for, and saving back into it). The module is gone:
 * a file pane reads and writes the real file through an injected gateway now,
 * and `tests/ui/ui-file-pane.test.ts` drives that against `tests/helpers/editor-fixture.ts`.
 *
 * WHAT PART B3 DELETED from this file: every pin on `MOCK_COMMITS` and on
 * `syntheticDiff()` / `pathSeed()`. The rows come from `git show` now
 * (`GitCommitDiffResponse`), so "a commit's numbers are counted from the diff
 * its view draws" became "the header states the server's numbers and every
 * fetched block draws exactly its `lines`" — pinned against the renderer in
 * `tests/ui/ui-a6-screens.test.ts`, where the drawing happens.
 *
 * NOT claimed: colours, layout, that the backend's numbers are right.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOW } from '../helpers/commits-fixture.ts';

const M = (await import(new URL('../../web/src/ui/commit-model.ts', import.meta.url).href)) as {
  BAR_BLOCKS: number;
  BINARY_TEXT: string;
  TOO_LARGE_TEXT: string;
  DETACHED_TEXT: string;
  NO_COMMITS_TEXT: string;
  SHOW_MORE_TEXT: string;
  barBlocks(add: number, del: number): string[];
  authorInitial(author: string): string;
  filesChangedText(n: number): string;
  moreFilesText(n: number): string;
  committedByText(name: string): string;
  branchLabel(branch: string | null): string;
  shortHashOf(hash: string): string;
  absoluteDate(iso: string): string;
  fullDateTime(iso: string): string;
  relativeTime(iso: string, now: number): string;
  githubCommitUrl(owner: string, repo: string, hash: string): string | null;
  collapseKey(hash: string, path: string): string;
  blockDomId(hash: string, path: string): string;
  fileName(path: string): string;
};

/** A hash of the shape every response carries: 40 hex, lower case. */
const HASH = 'a'.repeat(40);

// ---------------------------------------------------------------------------
// Totals, bar, initial, copy
// ---------------------------------------------------------------------------

test('the bar is five blocks, green first, and it always has five', () => {
  assert.equal(M.BAR_BLOCKS, 5);
  assert.deepEqual(M.barBlocks(38, 2), ['add', 'add', 'add', 'add', 'add']);
  assert.deepEqual(M.barBlocks(0, 40), ['del', 'del', 'del', 'del', 'del']);
  assert.deepEqual(M.barBlocks(50, 50), ['add', 'add', 'add', 'del', 'del'], 'round(2.5) is 3');
  assert.deepEqual(M.barBlocks(10, 30), ['add', 'del', 'del', 'del', 'del']);
  for (const [a, d] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [999, 1],
  ] as const) {
    assert.equal(M.barBlocks(a, d).length, 5, `${a}/${d}`);
  }
  assert.deepEqual(M.barBlocks(0, 0), ['del', 'del', 'del', 'del', 'del'], 'no division by zero');
});

test('the avatar letter is one upper-case character, and nothing at all when there is no name', () => {
  assert.equal(M.authorInitial('Sava'), 'S');
  assert.equal(M.authorInitial('  ada lovelace'), 'A');
  assert.equal(M.authorInitial(''), '', 'an empty circle beats a box with a space in it');
  assert.equal(M.authorInitial('   '), '');
});

test('the file count pluralises (copy rule)', () => {
  assert.equal(M.filesChangedText(1), '1 file changed');
  assert.equal(M.filesChangedText(2), '2 files changed');
  assert.equal(M.filesChangedText(0), '0 files changed');
});

test('a collapse key is per commit AND per path, so two commits never share a fold', () => {
  assert.equal(M.collapseKey('474d891', 'server/ws.ts'), '474d891:server/ws.ts');
  assert.notEqual(
    M.collapseKey('474d891', 'server/ws.ts'),
    M.collapseKey('9b2e1f0', 'server/ws.ts'),
  );
});

test('fileName is the last segment — the only part of a path a tab label shows', () => {
  assert.equal(M.fileName('web/src/Pane.tsx'), 'Pane.tsx');
  assert.equal(M.fileName('README.md'), 'README.md');
  assert.equal(M.fileName(''), '');
});

// ---------------------------------------------------------------------------
// Gate additions (test-engineer, A6): the properties the renderer leans on —
// the bar is greens-first and monotone, the avatar letter survives a name that
// is not ASCII, and a block id survives any path a repository can hold.
// ---------------------------------------------------------------------------

test('the bar is greens-FIRST, five long, and never loses a block when more was added', () => {
  let lastGreens = -1;
  for (let add = 0; add <= 40; add += 1) {
    const blocks = M.barBlocks(add, 40 - add);
    assert.equal(blocks.length, 5, `${add}/${40 - add}`);
    const greens = blocks.filter((b) => b === 'add').length;
    // Greens first: no red may stand before a green.
    assert.deepEqual(
      blocks,
      Array.from({ length: 5 }, (_, i) => (i < greens ? 'add' : 'del')),
      `${add}/${40 - add} is not greens-first`,
    );
    assert.equal(greens, Math.round((5 * add) / 40), `${add}/${40 - add}`);
    assert.ok(greens >= lastGreens, 'more added lines can never mean fewer green blocks');
    lastGreens = greens;
  }
  assert.equal(lastGreens, 5, 'non-vacuity: the sweep really reached an all-green commit');
});

test('the avatar letter handles a name that is not ASCII', () => {
  assert.equal(M.authorInitial('Élodie'), 'É');
  assert.equal(M.authorInitial('ada'), 'A', 'lower case is raised');
  assert.equal(M.authorInitial('中村'), '中', 'a script with no case is left as it is');
  assert.equal(M.authorInitial('\t Ada Lovelace \n'), 'A', 'surrounding whitespace is not a letter');
});

test('the avatar letter is a CHARACTER, so an astral first letter is not cut in half', () => {
  // `charAt(0)` on a name starting outside the BMP hands back a lone surrogate
  // — an unpaired code unit the font draws as a box.
  const emoji = '\u{1F600} Ada';
  const initial = M.authorInitial(emoji);
  assert.equal(initial, '\u{1F600}');
  assert.equal(Array.from(initial).length, 1, 'one character');
  assert.equal(initial.length, 2, 'non-vacuity: that character really is a surrogate pair');
  assert.equal(M.authorInitial('中村'), '中');
  assert.equal(M.authorInitial(''), '');
  assert.equal(M.authorInitial('  '), '');
});

test('a diff block id is derived from its collapse key, and survives a path', () => {
  // The Files panel row that folds a block lives in another region, so it names
  // the block by id (`aria-controls`). The id has to be a valid one.
  const id = M.blockDomId('474d891', 'web/src/Pane.tsx');
  assert.match(id, /^[A-Za-z][A-Za-z0-9_-]*$/, 'no slash, no dot, no colon');
  assert.notEqual(id, M.blockDomId('55c9be7', 'web/src/Pane.tsx'), 'per commit');
  assert.notEqual(id, M.blockDomId('474d891', 'web/src/App.tsx'), 'and per path');
  assert.equal(id, M.blockDomId('474d891', 'web/src/Pane.tsx'), 'and it is stable');
});

test('a block id survives a path a repository really can hold (gate addition)', () => {
  // Git tracks paths with spaces, brackets, accents and hashes; an id with a
  // SPACE in it silently breaks the `aria-controls` link that points at it (the
  // attribute is a space-separated ID LIST), and one with a `#` or a quote
  // breaks the selector that finds it. Every character outside the id alphabet
  // has to go, not merely the ones this project's own paths contain.
  for (const path of [
    'web/src/My Component.tsx',
    'docs/read me (draft).md',
    'server/#odd?name.ts',
    'web/src/Ünïcode.ts',
    'a\tb.ts',
  ]) {
    const id = M.blockDomId('474d891', path);
    assert.match(id, /^[A-Za-z][A-Za-z0-9_-]*$/, `${JSON.stringify(path)} -> ${JSON.stringify(id)}`);
    assert.equal(/\s/.test(id), false, 'aria-controls is a space-separated ID LIST');
  }
  assert.notEqual(
    M.blockDomId('474d891', 'a b.ts'),
    M.blockDomId('474d891', 'a c.ts'),
    'and two different paths still give two different ids',
  );
});

test('a block id disambiguates paths that SANITISE to the same string (scope review R6)', () => {
  // `a/b.ts` and `a-b.ts` both squash to `a-b-ts`; two blocks with one id make
  // `aria-controls` point at whichever the DOM finds first.
  const slash = M.blockDomId('474d891', 'a/b.ts');
  const dash = M.blockDomId('474d891', 'a-b.ts');
  assert.notEqual(slash, dash, 'two paths, two ids');
  for (const id of [slash, dash]) {
    assert.match(id, /^[A-Za-z][A-Za-z0-9_-]*$/, id);
    assert.equal(/\s/.test(id), false, 'aria-controls is a space-separated ID LIST');
  }
  // Same for a pair that differs only outside the id alphabet, and for a pair
  // that differs only in the hash.
  assert.notEqual(M.blockDomId('474d891', 'a b.ts'), M.blockDomId('474d891', 'a#b.ts'));
  assert.notEqual(M.blockDomId('474d891', 'a/b.ts'), M.blockDomId('55c9be7', 'a/b.ts'));
  assert.equal(slash, M.blockDomId('474d891', 'a/b.ts'), 'and it is still stable');
});

// ---------------------------------------------------------------------------
// Part B3: the copy the two live surfaces print
// ---------------------------------------------------------------------------

test('the sentences a block draws instead of rows say WHICH nothing it is', () => {
  // Two different facts: git stores this file as bytes, or its diff is past
  // the cap. An empty block would read as "this commit did not touch it".
  assert.equal(M.BINARY_TEXT, 'Binary file.');
  assert.equal(M.TOO_LARGE_TEXT, "This file's changes are too large to show.");
  assert.equal(M.NO_COMMITS_TEXT, 'No commits yet.');
  assert.equal(M.SHOW_MORE_TEXT, 'Show more');
  assert.equal(M.DETACHED_TEXT, 'Detached');
  for (const line of [M.BINARY_TEXT, M.TOO_LARGE_TEXT, M.NO_COMMITS_TEXT]) {
    assert.ok(line.endsWith('.'), `a sentence ends in a full stop: ${line}`);
    assert.equal(/\//.test(line), false, `a path in: ${line}`);
    assert.equal(/--|\bgit\b/.test(line), false, `a command or a flag in: ${line}`);
  }
});

test('the two capped counts pluralise, and they are about different things', () => {
  assert.equal(M.moreFilesText(1), '1 more file is not shown.');
  assert.equal(M.moreFilesText(3), '3 more files are not shown.');
  assert.equal(M.moreFilesText(2000), '2000 more files are not shown.');
});

test('`Committed by` names a person and nothing else', () => {
  assert.equal(M.committedByText('Fable'), 'Committed by Fable');
  assert.equal(M.committedByText('Ada Lovelace'), 'Committed by Ada Lovelace');
});

test('a branch with no name is the one word for that, everywhere', () => {
  assert.equal(M.branchLabel('main'), 'main');
  assert.equal(M.branchLabel('feature/commits'), 'feature/commits');
  assert.equal(M.branchLabel(null), 'Detached');
  assert.equal(M.branchLabel(''), 'Detached');
});

test('a tab chip shows SEVEN characters of a hash, and leaves a short one alone', () => {
  // The identity stays the full 40 (two commits can share a path); a chip is
  // no place to read forty characters.
  assert.equal(M.shortHashOf(HASH), 'aaaaaaa');
  assert.equal(M.shortHashOf(HASH).length, 7);
  assert.equal(M.shortHashOf('474d891'), '474d891', 'already short');
  assert.equal(M.shortHashOf(''), '');
});

// ---------------------------------------------------------------------------
// Part B3: one timestamp, said twice
// ---------------------------------------------------------------------------

test('the absolute date is read in the COMMIT`s own zone, not the browser`s', () => {
  // `%aI` carries the author's offset. A commit made at 00:30+02:00 is the 20th
  // where it happened; rendering it in another zone would move it to the 19th,
  // which is a different fact about the repository.
  assert.equal(M.absoluteDate('2026-09-20T14:32:05+02:00'), '20 Sep 2026');
  assert.equal(M.absoluteDate('2026-09-20T00:30:00+02:00'), '20 Sep 2026');
  assert.equal(M.absoluteDate('2026-01-02T23:00:00-08:00'), '2 Jan 2026', 'no leading zero on a day');
  assert.equal(M.absoluteDate('2026-12-31T12:00:00Z'), '31 Dec 2026');
  assert.equal(M.fullDateTime('2026-09-20T14:32:05+02:00'), '20 Sep 2026 at 14:32');
});

test('a timestamp the app cannot parse prints NOTHING, never machine text', () => {
  for (const bad of ['', 'yesterday', '20-09-2026', '2026-13-40T99:99:99Z']) {
    const date = M.absoluteDate(bad);
    assert.ok(date === '' || /^\d+ [A-Z][a-z]{2} \d{4}$/.test(date), `${bad} -> ${date}`);
  }
  assert.equal(M.absoluteDate('not a date'), '');
  assert.equal(M.fullDateTime('not a date'), '');
  assert.equal(M.relativeTime('not a date', NOW), '');
});

test('the relative half is said in plain words, pluralised, from the clock it is given', () => {
  const at = (ms: number): string => new Date(NOW - ms).toISOString();
  assert.equal(M.relativeTime(at(5_000), NOW), 'just now');
  assert.equal(M.relativeTime(at(60_000), NOW), '1 minute ago');
  assert.equal(M.relativeTime(at(5 * 60_000), NOW), '5 minutes ago');
  assert.equal(M.relativeTime(at(3600_000), NOW), '1 hour ago');
  assert.equal(M.relativeTime(at(3 * 3600_000), NOW), '3 hours ago');
  assert.equal(M.relativeTime(at(24 * 3600_000), NOW), '1 day ago');
  assert.equal(M.relativeTime(at(6 * 24 * 3600_000), NOW), '6 days ago');
  assert.equal(M.relativeTime(at(8 * 24 * 3600_000), NOW), '1 week ago');
  assert.equal(M.relativeTime(at(40 * 24 * 3600_000), NOW), '1 month ago');
  assert.equal(M.relativeTime(at(400 * 24 * 3600_000), NOW), '1 year ago');
  assert.equal(M.relativeTime(at(800 * 24 * 3600_000), NOW), '2 years ago');
  // A clock that runs ahead of the commit's: the app cannot know which of the
  // two is wrong, and "in 3 hours" is the one thing that is certainly false.
  assert.equal(M.relativeTime(at(-3 * 3600_000), NOW), 'just now');
  // It is computed against the clock it is HANDED, so a list open for an hour
  // says so on its next repaint.
  const iso = at(3600_000);
  assert.equal(M.relativeTime(iso, NOW + 3600_000), '2 hours ago');
});

// ---------------------------------------------------------------------------
// Part B3, decision D2: the ONE address this screen may leave for
// ---------------------------------------------------------------------------

test('the commit address is built from the three parts, and only from them', () => {
  assert.equal(
    M.githubCommitUrl('you', 'app', HASH),
    `https://github.com/you/app/commit/${HASH}`,
  );
  assert.equal(
    M.githubCommitUrl('Yaro-Sav_1', 'ai-cli.application', HASH),
    `https://github.com/Yaro-Sav_1/ai-cli.application/commit/${HASH}`,
  );
});

test('the page RE-CHECKS owner, repo and hash — and refuses rather than guessing', () => {
  // The two names came out of `remote.origin.url`, a string in the user's own
  // repository config, and the result is handed to the one call that can leave
  // this window. The server checked them; so does this.
  for (const owner of [
    '',
    '.',
    '..',
    'a/b',
    'a b',
    'a\\b',
    'a:b',
    '../../evil',
    'x'.repeat(101),
    'a?b',
    'a#b',
    'a%2f b',
    'user@host',
  ]) {
    assert.equal(M.githubCommitUrl(owner, 'app', HASH), null, `owner ${JSON.stringify(owner)}`);
    assert.equal(M.githubCommitUrl('you', owner, HASH), null, `repo ${JSON.stringify(owner)}`);
  }
  for (const hash of [
    '',
    '474d891',
    HASH.toUpperCase(),
    `${HASH}a`,
    HASH.slice(1),
    `${HASH.slice(1)}z`,
    '../../../etc',
  ]) {
    assert.equal(M.githubCommitUrl('you', 'app', hash), null, `hash ${JSON.stringify(hash)}`);
  }
  // Non-vacuity: the same call with all three right really does answer.
  assert.notEqual(M.githubCommitUrl('you', 'app', HASH), null);
  // And whatever it answers is an https address on github.com with nothing
  // else in it.
  const url = new URL(M.githubCommitUrl('you', 'app', HASH) as string);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.host, 'github.com');
  assert.equal(url.username, '');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
});
