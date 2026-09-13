/**
 * `web/src/ui/commit-model.ts` — the arithmetic and the copy of the commit
 * view (Nocturne A6), with no DOM: totals, the five-block bar, the author's
 * initial, the plural sentence, the collapse key, and the synthetic diff.
 *
 * WHY separately from the DOM test. These are the answers the view RENDERS; a
 * wrong bar or an off-by-one line number is invisible to a wiring test that
 * only asks "is there a row per line". The same split A5 made between
 * `ui-files-model.test.ts` and `ui-files-panel.test.ts`.
 *
 * It also pins the ONE consistency rule of the mock: a commit's `add`/`del`
 * are the sums of its files. The Commits list prints the former and the opened
 * view prints the latter, so a mock that disagreed with itself would have the
 * same commit claim two different sizes in two places.
 *
 * NOT claimed: colours, layout, that a diff is a real diff (it is synthetic by
 * construction and says so — part B3 replaces it with `git show`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const M = (await import(new URL('../web/src/ui/commit-model.ts', import.meta.url).href)) as {
  BAR_BLOCKS: number;
  commitTotals(files: readonly { add: number; del: number }[]): { add: number; del: number };
  barBlocks(add: number, del: number): string[];
  authorInitial(author: string): string;
  filesChangedText(n: number): string;
  collapseKey(hash: string, path: string): string;
  blockDomId(hash: string, path: string): string;
  fileName(path: string): string;
  syntheticDiff(text: string, seed?: number): { n: number; sign: string; text: string; kind: string }[];
  pathSeed(path: string): number;
};

const MOCK = (await import(new URL('../web/src/ui/files-mock.ts', import.meta.url).href)) as {
  MOCK_FILES: { path: string; add?: number; del?: number }[];
  MOCK_COMMITS: {
    hash: string;
    add: number;
    del: number;
    files: { path: string; add: number; del: number }[];
  }[];
  NO_EXAMPLE_CONTENT: string;
  mockCommitByHash(hash: string | null): { hash: string } | null;
  mockFileContent(path: string): string | null;
  saveMockFile(path: string, text: string): void;
};

// ---------------------------------------------------------------------------
// Totals, bar, initial, copy
// ---------------------------------------------------------------------------

test('commitTotals sums what the commit touched', () => {
  assert.deepEqual(
    M.commitTotals([
      { add: 30, del: 0 },
      { add: 8, del: 2 },
    ]),
    { add: 38, del: 2 },
  );
  assert.deepEqual(M.commitTotals([]), { add: 0, del: 0 }, 'an empty commit is not a NaN');
});

test('every mock commit states the same size in the list as in the opened view', () => {
  assert.ok(MOCK.MOCK_COMMITS.length >= 5, 'non-vacuity: the mock really has commits');
  for (const c of MOCK.MOCK_COMMITS) {
    assert.ok(c.files.length > 0, `${c.hash} changed no files`);
    assert.deepEqual(M.commitTotals(c.files), { add: c.add, del: c.del }, c.hash);
  }
});

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
// The synthetic diff
// ---------------------------------------------------------------------------

test('syntheticDiff: every source line is present, numbered from 1 without a gap', () => {
  const rows = M.syntheticDiff('a\nb\nc\nd\ne\nf\ng\nh\n');
  assert.ok(rows.length >= 9, `non-vacuity: ${rows.length} rows`);
  assert.deepEqual(
    rows.map((r) => r.n),
    rows.map((_, i) => i + 1),
    'line numbers count RENDERED rows, as a unified diff does',
  );
  for (const src of 'abcdefgh') {
    assert.ok(
      rows.some((r) => r.text === src),
      `the source line ${src} is in the diff`,
    );
  }
});

test('syntheticDiff: the sign column and the kind always agree', () => {
  const rows = M.syntheticDiff(MOCK.mockFileContent('web/src/Pane.tsx') ?? '');
  assert.ok(rows.length > 15, 'non-vacuity');
  const signOf: Record<string, string> = { add: '+', del: '-', ctx: ' ' };
  for (const r of rows) {
    assert.equal(r.sign, signOf[r.kind], `${r.kind} rows are signed ${signOf[r.kind]}`);
  }
  assert.ok(
    rows.some((r) => r.kind === 'add'),
    'there is at least one added row',
  );
  assert.ok(
    rows.some((r) => r.kind === 'ctx'),
    'and context around it',
  );
});

test('syntheticDiff: a removed line is drawn as the OLD text followed by the new one', () => {
  // Line index 3 is the first `del` (i % 7 === 3), and the reference's own
  // mock rewrite is `const` -> `let`, so the pair is visible as such.
  const rows = M.syntheticDiff('0\n1\n2\nconst x = 1;\n4\n');
  const del = rows.findIndex((r) => r.kind === 'del');
  assert.notEqual(del, -1, 'non-vacuity: the fourth line really is a removal');
  assert.equal(rows[del]?.text, 'let x = 1;');
  assert.equal(rows[del + 1]?.text, 'const x = 1;', 'the new text stands right under the old');
  assert.equal(rows[del + 1]?.kind, 'ctx');
});

test('syntheticDiff: an empty text is one empty row, never a crash', () => {
  const rows = M.syntheticDiff('');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.text, '');
});

// ---------------------------------------------------------------------------
// The mock the view stands on
// ---------------------------------------------------------------------------

test('a commit is found by its hash, and an unknown hash is null rather than a guess', () => {
  const first = MOCK.MOCK_COMMITS[0] as { hash: string };
  assert.equal(MOCK.mockCommitByHash(first.hash)?.hash, first.hash);
  assert.equal(MOCK.mockCommitByHash('deadbee'), null);
  assert.equal(MOCK.mockCommitByHash(null), null);
});

test('a file the mock does not know is NULL — a sentence dressed as a file is worse', () => {
  // A sentence returned as CONTENT renders as a numbered `+` diff row and as a
  // one-line editable file: both claim the file says that. Null lets the two
  // readers draw it as the note it is.
  assert.equal(MOCK.mockFileContent('server/nothing-here.ts'), null);
  assert.equal(MOCK.NO_EXAMPLE_CONTENT, 'There is no example content for this file yet.');
  assert.ok(
    (MOCK.mockFileContent('web/src/Pane.tsx') ?? '').length > 100,
    'non-vacuity: known files have text',
  );
});

test('every path a commit names has example text — no commit opens onto empty blocks', () => {
  assert.ok(MOCK.MOCK_COMMITS.length >= 5, 'non-vacuity: the mock really has commits');
  for (const c of MOCK.MOCK_COMMITS) {
    for (const f of c.files) {
      assert.notEqual(MOCK.mockFileContent(f.path), null, `${c.hash}: ${f.path} has no text`);
    }
  }
});

test('a commit\'s numbers are COUNTED from the diff its view draws, never typed in', () => {
  // The mock used to state `+346 -0` over a body full of red rows. Every number
  // now comes from the same rows the block renders, so header, list row and
  // diff agree by construction.
  for (const c of MOCK.MOCK_COMMITS) {
    for (const f of c.files) {
      // The SAME seed the view renders with: a file's cadence is a function of
      // its path, so the header, the list row and the drawn diff agree.
      const rows = M.syntheticDiff(MOCK.mockFileContent(f.path) ?? '', M.pathSeed(f.path));
      assert.equal(f.add, rows.filter((r) => r.kind === 'add').length, `${c.hash}: +${f.path}`);
      assert.equal(f.del, rows.filter((r) => r.kind === 'del').length, `${c.hash}: -${f.path}`);
    }
    assert.deepEqual(M.commitTotals(c.files), { add: c.add, del: c.del }, c.hash);
    // And a commit whose diff HAS removals may not say it removed nothing.
    const del = c.files.some((f) => f.del > 0);
    assert.equal(del, c.del > 0, `${c.hash}: the header and the rows disagree about removals`);
  }
  assert.ok(
    MOCK.MOCK_COMMITS.some((c) => c.del > 0),
    'non-vacuity: at least one commit really removes lines',
  );
});

test('saving writes back into the mock map — and nothing else can (part B4 writes to disk)', () => {
  const before = MOCK.mockFileContent('web/src/App.tsx') ?? '';
  MOCK.saveMockFile('web/src/App.tsx', 'edited\n');
  assert.equal(MOCK.mockFileContent('web/src/App.tsx'), 'edited\n');
  MOCK.saveMockFile('web/src/App.tsx', before);
  assert.equal(MOCK.mockFileContent('web/src/App.tsx'), before);
});

// ---------------------------------------------------------------------------
// Gate additions (test-engineer, A6): the properties the renderer leans on —
// the diff is TOTAL and DETERMINISTIC, the bar is greens-first and monotone,
// and the avatar letter survives a name that is not ASCII.
// ---------------------------------------------------------------------------

test('syntheticDiff is deterministic: the same text renders the same rows every time', () => {
  const text = MOCK.mockFileContent('server/ws.ts') ?? '';
  assert.ok(text.length > 100, 'non-vacuity');
  assert.deepEqual(M.syntheticDiff(text), M.syntheticDiff(text));
  // And it holds no state between calls: a second text in between changes
  // nothing about the first one's rows.
  const a = M.syntheticDiff('x\ny\nz');
  M.syntheticDiff(MOCK.mockFileContent('web/src/App.tsx') ?? '');
  assert.deepEqual(M.syntheticDiff('x\ny\nz'), a);
});

test('syntheticDiff is TOTAL: every source line is there once, in order, as ctx or add', () => {
  // The rows a reader treats as "the file": everything except the removed
  // lines, which are the old text the new line replaces.
  const src = Array.from({ length: 23 }, (_, i) => `line ${i}`);
  const rows = M.syntheticDiff(src.join('\n'));
  assert.deepEqual(
    rows.filter((r) => r.kind !== 'del').map((r) => r.text),
    src,
    'no source line is dropped, duplicated or reordered',
  );
  assert.ok(
    rows.some((r) => r.kind === 'del'),
    'non-vacuity: this text really does produce removals',
  );
  // A removal always stands directly BEFORE the line it was replaced by.
  for (const [i, r] of rows.entries()) {
    if (r.kind !== 'del') continue;
    assert.equal(rows[i + 1]?.kind, 'ctx', `row ${r.n}: a removal is followed by its replacement`);
    assert.equal(rows[i + 1]?.sign, ' ');
  }
  assert.deepEqual(rows.map((r) => r.n), rows.map((_, i) => i + 1), 'and the numbering has no gap');
});

test('syntheticDiff: sign and kind agree for ANY text, not just the mock files', () => {
  const signOf: Record<string, string> = { add: '+', del: '-', ctx: ' ' };
  for (const text of ['', 'a', 'a\nb', Array.from({ length: 40 }, (_, i) => `${i}`).join('\n')]) {
    for (const r of M.syntheticDiff(text)) {
      assert.equal(r.sign, signOf[r.kind], `${JSON.stringify(text)}: ${r.kind}`);
      assert.ok(['add', 'del', 'ctx'].includes(r.kind), `a row is one of the three kinds: ${r.kind}`);
    }
  }
});

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

// ---------------------------------------------------------------------------
// The per-path seed (scope review R1): one derivation for every number on the
// screen, and a cadence that varies per file so the five-block bar says
// something. Part B3 deletes the seed with the rest of the synthetic diff.
// ---------------------------------------------------------------------------

test('pathSeed is a pure function of the path: stable, and different paths differ', () => {
  assert.equal(M.pathSeed('web/src/Pane.tsx'), M.pathSeed('web/src/Pane.tsx'), 'stable');
  assert.notEqual(M.pathSeed('web/src/Pane.tsx'), M.pathSeed('web/src/App.tsx'));
  assert.notEqual(M.pathSeed('a/b.ts'), M.pathSeed('a-b.ts'), 'and it is not the sanitised path');
  for (const p of ['', 'a', 'web/src/Ünïcode.ts', 'x'.repeat(400)]) {
    const s = M.pathSeed(p);
    assert.ok(Number.isInteger(s) && s >= 0, `${JSON.stringify(p)} -> ${s}`);
  }
});

test('the DEFAULT seed keeps the original cadence — no seed, no change', () => {
  // Added every 5th line from index 1, removed every 7th from index 3: the
  // shape every pre-R1 expectation in this file was written against.
  const src = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const rows = M.syntheticDiff(src);
  assert.deepEqual(M.syntheticDiff(src, 0), rows, 'seed 0 IS the default');
  const kindOfSource = new Map<string, string>();
  for (const r of rows) if (r.kind !== 'del') kindOfSource.set(r.text, r.kind);
  for (let i = 0; i < 40; i += 1) {
    const expected = i % 5 === 1 ? 'add' : 'ctx';
    assert.equal(kindOfSource.get(`line ${i}`), expected, `line ${i}`);
  }
  const dels = rows.filter((r) => r.kind === 'del').length;
  assert.equal(dels, 5, 'index 3, 10, 17, 24, 31 and 38 minus the one index 5 claims first');
});

test('a seed moves the RATIO: the same text gives two different add/del splits', () => {
  const text = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
  const ratio = (seed: number): string => {
    const rows = M.syntheticDiff(text, seed);
    return `${rows.filter((r) => r.kind === 'add').length}/${rows.filter((r) => r.kind === 'del').length}`;
  };
  assert.notEqual(ratio(0), ratio(1), 'two seeds, two cadences');
  const seen = new Set(Array.from({ length: 50 }, (_, s) => ratio(s)));
  assert.ok(seen.size >= 3, `a seed sweep produces several ratios, got ${[...seen].join(' ')}`);
});

test('every invariant of the diff holds for ANY seed, not only the default', () => {
  const signOf: Record<string, string> = { add: '+', del: '-', ctx: ' ' };
  const texts = ['', 'a', 'a\nb', Array.from({ length: 37 }, (_, i) => `line ${i}`).join('\n')];
  const seeds = [0, 1, 2, 3, 7, 41, 1234, M.pathSeed('web/src/Pane.tsx'), M.pathSeed('README.md')];
  for (const text of texts) {
    const src = text.split('\n');
    for (const seed of seeds) {
      const rows = M.syntheticDiff(text, seed);
      const where = `${JSON.stringify(text.slice(0, 12))} seed ${seed}`;
      // Deterministic.
      assert.deepEqual(M.syntheticDiff(text, seed), rows, `${where}: deterministic`);
      // TOTAL: every source line once, in order, as ctx or add.
      assert.deepEqual(
        rows.filter((r) => r.kind !== 'del').map((r) => r.text),
        src,
        `${where}: no source line dropped, duplicated or reordered`,
      );
      // Numbering has no gap; sign and kind agree; a removal is followed by
      // the line that replaced it.
      assert.deepEqual(rows.map((r) => r.n), rows.map((_, i) => i + 1), `${where}: numbering`);
      for (const [i, r] of rows.entries()) {
        assert.equal(r.sign, signOf[r.kind], `${where}: ${r.kind} is signed ${signOf[r.kind]}`);
        if (r.kind !== 'del') continue;
        assert.equal(rows[i + 1]?.kind, 'ctx', `${where}: row ${r.n} has its replacement under it`);
      }
    }
  }
  assert.ok(
    M.syntheticDiff(texts[3] as string, 5).some((r) => r.kind === 'del'),
    'non-vacuity: a seeded walk really does produce removals',
  );
});

test('the five-block bar really varies down the commits list — at least three splits', () => {
  // The whole point of R1: with one cadence every commit drew 3 green / 2 red
  // and the bar was decoration. A split is the joined block list, so this
  // counts DISTINCT bars, not distinct numbers.
  const splits = new Set(MOCK.MOCK_COMMITS.map((c) => M.barBlocks(c.add, c.del).join(',')));
  assert.ok(
    splits.size >= 3,
    `five commits must draw at least three different bars, got ${[...splits].join(' | ')}`,
  );
});

test('MOCK_FILES numbers come from the SAME derivation — one source for every number', () => {
  // The Files tab's "+A -D since last commit" and the commits list are on the
  // same screen; a row counted by hand is a row that contradicts the other
  // panel. Rows that carry NO numbers stay numberless: "listed but unchanged"
  // is a different fact from "+0 -0".
  const numbered = MOCK.MOCK_FILES.filter((f) => f.add !== undefined || f.del !== undefined);
  assert.ok(numbered.length >= 4, `non-vacuity: ${numbered.length} rows carry numbers`);
  for (const f of numbered) {
    const rows = M.syntheticDiff(MOCK.mockFileContent(f.path) ?? '', M.pathSeed(f.path));
    assert.equal(f.add, rows.filter((r) => r.kind === 'add').length, `+${f.path}`);
    assert.equal(f.del, rows.filter((r) => r.kind === 'del').length, `-${f.path}`);
  }
  for (const f of MOCK.MOCK_FILES) {
    if (f.add !== undefined || f.del !== undefined) continue;
    assert.equal(f.add, undefined, `${f.path} is listed but unchanged`);
    assert.equal(f.del, undefined, `${f.path} is listed but unchanged`);
  }
  // And no uncommitted row may dwarf the largest commit in the list — the
  // incoherence R1 named.
  const biggest = Math.max(...MOCK.MOCK_COMMITS.map((c) => c.add + c.del));
  for (const f of numbered) {
    assert.ok(
      (f.add ?? 0) + (f.del ?? 0) <= biggest,
      `${f.path} (${f.add}/${f.del}) is bigger than the biggest commit (${biggest})`,
    );
  }
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
