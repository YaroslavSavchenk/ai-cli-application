/**
 * `web/src/ui/drop-model.ts` — the pure rules behind A9's Explorer drop
 * (user decisions 2026-09-15, `.claude/plans/nocturne/PLAN-A9.md`): how a drag counts itself,
 * what the dropped things are called together, which of them already exist at
 * the destination, how a "keep both" copy is named, and what the dialog says
 * while and after it pretends to copy.
 *
 * WHY here and not in a DOM test: this is the half of drag & drop that has
 * nothing to do with the browser, and it is the half that decides whether a
 * file is replaced, renamed or left alone — the decisions part B10 will
 * execute for real against a disk. Pinning them without a DOM means the drag
 * plumbing (brief 2) and the dialog (brief 1) can change without changing the
 * answer.
 *
 * NOT claimed here (needs a browser,
 * `.claude/skills/verify-terminal/SKILL.md`): that anything is drawn, that a
 * drop target resolves, or that a single byte is copied — nothing is, until
 * part B10.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conflictTitle,
  conflictsOf,
  copyingHeader,
  destLine,
  dragCountText,
  dropRefusal,
  failNote,
  hasFiles,
  itemsText,
  keepBothName,
  partialNote,
  planResults,
  planTargets,
  progressText,
  resultText,
  tooMany,
  uploadMode,
  DROP_HINT,
  MAX_DROP_BYTES,
  MAX_DROP_FILES,
  MAX_ITEMS,
  MAX_ITEM_BYTES,
  TOO_MANY_BYTES_SENTENCE,
  TOO_MANY_FILES_SENTENCE,
  type Choice,
  type DropItem,
  type ItemResult,
} from '../../web/src/ui/drop-model.ts';

const file = (name: string, bytes = 1024): DropItem => ({ name, dir: false, bytes });
const folder = (name: string): DropItem => ({ name, dir: true, bytes: null });

/** Every string this module can build, for the sweeps at the bottom. */
const PRODUCED: string[] = [];
const say = (s: string): string => {
  PRODUCED.push(s);
  return s;
};

// ---------------------------------------------------------------------------
// The drag itself
// ---------------------------------------------------------------------------

test('hasFiles: only a drag carrying files is ours', () => {
  assert.equal(hasFiles(['Files']), true);
  assert.equal(hasFiles(['text/plain', 'Files']), true);
  // Text dragged out of another program: not a file drop. (Over a terminal it
  // is cancelled outright, user decision 5 — that is brief 2's job, not this
  // function's; here it is simply not a files drag.)
  assert.equal(hasFiles(['text/plain', 'text/uri-list']), false);
  assert.equal(hasFiles([]), false);
  // Exact, not a substring: the DataTransfer type list is a fixed vocabulary.
  assert.equal(hasFiles(['files']), false);
  assert.equal(hasFiles(['Files/x']), false);
});

test('tooMany: the top-level cap is a limit, not a warning zone', () => {
  assert.equal(MAX_ITEMS, 200);
  assert.equal(tooMany(0), false);
  assert.equal(tooMany(1), false);
  assert.equal(tooMany(MAX_ITEMS), false);
  assert.equal(tooMany(MAX_ITEMS + 1), true);
  assert.equal(tooMany(5000), true);
});

test('MAX_ITEM_BYTES is the 50 MiB B10 enforces server-side', () => {
  assert.equal(MAX_ITEM_BYTES, 50 * 1024 * 1024);
  assert.equal(MAX_ITEM_BYTES, 52428800);
});

test('dragCountText: what a drag may honestly say before the drop', () => {
  assert.equal(say(dragCountText(1)), '1 item');
  assert.equal(say(dragCountText(2)), '2 items');
  assert.equal(say(dragCountText(3)), '3 items');
  assert.equal(say(dragCountText(200)), '200 items');
  // Never rendered (a drag carries at least one thing), but pluralised anyway.
  assert.equal(say(dragCountText(0)), '0 items');
});

test('destLine and DROP_HINT: the ghost names the destination, or asks for one', () => {
  assert.equal(say(destLine(3, 'src')), 'Copy 3 items into src');
  assert.equal(say(destLine(1, 'src')), 'Copy 1 item into src');
  assert.equal(say(destLine(1, 'Home')), 'Copy 1 item into Home');
  assert.equal(say(destLine(2, 'Session Manager')), 'Copy 2 items into Session Manager');
  assert.equal(say(DROP_HINT), 'Drop on a folder or a pane.');
});

test('itemsText: what the items ARE, once the drop can say', () => {
  assert.equal(say(itemsText([file('a.md')])), '1 file');
  assert.equal(say(itemsText([file('a.md'), file('b.md')])), '2 files');
  assert.equal(say(itemsText([folder('web')])), '1 folder');
  assert.equal(say(itemsText([folder('web'), folder('server')])), '2 folders');
  assert.equal(say(itemsText([file('a.md'), file('b.md'), folder('web')])), '2 files and 1 folder');
  assert.equal(say(itemsText([file('a.md'), folder('web'), folder('server')])), '1 file and 2 folders');
  assert.equal(say(itemsText([file('a.md'), folder('web')])), '1 file and 1 folder');
  // Unreachable through the UI (an empty drop opens no dialog); total anyway.
  assert.equal(say(itemsText([])), '0 items');
});

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

test('conflictsOf: exact, case-sensitive, and only the destination’s own names', () => {
  const items = [file('README.md'), file('NOTES.md'), folder('web')];
  assert.deepEqual(conflictsOf(items, ['README.md', 'web', 'server']), ['README.md', 'web']);
  assert.deepEqual(conflictsOf(items, []), []);
  assert.deepEqual(conflictsOf([], ['README.md']), []);
  // Case-sensitive: this file system has two files there, not one.
  assert.deepEqual(conflictsOf([file('README.md')], ['readme.md']), []);
  assert.deepEqual(conflictsOf([file('readme.md')], ['README.md']), []);
  // Substrings are not conflicts either way round.
  assert.deepEqual(conflictsOf([file('READ')], ['README.md']), []);
  assert.deepEqual(conflictsOf([file('README.md.bak')], ['README.md']), []);
});

test('conflictsOf: TOP-LEVEL names only, and in the order they were dropped', () => {
  // A listing is the destination folder’s own children. Hand it paths and
  // nothing matches: a dropped `App.tsx` is not the `web/src/App.tsx` of some
  // subtree, and claiming it were would overwrite the wrong file in B10.
  const nested = ['web/src/App.tsx', 'web/src/store.ts', 'server/ws.ts'];
  assert.deepEqual(conflictsOf([file('App.tsx'), file('ws.ts'), folder('web')], nested), []);
  // Order follows the drop, not the listing.
  const items = [folder('web'), file('README.md')];
  assert.deepEqual(conflictsOf(items, ['README.md', 'web']), ['web', 'README.md']);
});

test('conflictTitle: one names the file, many name the count', () => {
  assert.equal(say(conflictTitle(['README.md'], 'src')), 'README.md already exists in src');
  assert.equal(say(conflictTitle(['web'], 'Home')), 'web already exists in Home');
  assert.equal(
    say(conflictTitle(['README.md', 'web', 'server'], 'src')),
    '3 items already exist in src',
  );
  assert.equal(say(conflictTitle(['a', 'b'], 'src')), '2 items already exist in src');
  // No conflicts is not a state the dialog has; the sentence stays true and
  // never writes a zero.
  assert.equal(say(conflictTitle([], 'src')), 'Nothing already exists in src');
});

// ---------------------------------------------------------------------------
// keepBothName
// ---------------------------------------------------------------------------

test('keepBothName: Explorer’s own numbering, extension kept', () => {
  assert.equal(say(keepBothName('report.md', ['report.md'])), 'report (2).md');
  assert.equal(say(keepBothName('report.md', ['report.md', 'report (2).md'])), 'report (3).md');
  assert.equal(
    say(keepBothName('report.md', ['report.md', 'report (2).md', 'report (3).md'])),
    'report (4).md',
  );
  // A chain with a hole in it takes the first FREE number, not the next one.
  assert.equal(
    say(keepBothName('report.md', ['report.md', 'report (2).md', 'report (4).md'])),
    'report (3).md',
  );
});

test('keepBothName: folders and dot-less names grow the same suffix', () => {
  assert.equal(say(keepBothName('web', ['web'])), 'web (2)');
  assert.equal(say(keepBothName('web', ['web', 'web (2)'])), 'web (3)');
  assert.equal(say(keepBothName('LICENSE', ['LICENSE'])), 'LICENSE (2)');
  // A leading dot is part of the NAME, never an extension.
  assert.equal(say(keepBothName('.gitignore', ['.gitignore'])), '.gitignore (2)');
});

test('keepBothName: the last dot is the extension', () => {
  assert.equal(say(keepBothName('archive.tar.gz', ['archive.tar.gz'])), 'archive.tar (2).gz');
  assert.equal(
    say(keepBothName('archive.tar.gz', ['archive.tar.gz', 'archive.tar (2).gz'])),
    'archive.tar (3).gz',
  );
  assert.equal(say(keepBothName('a.b.c.d', ['a.b.c.d'])), 'a.b.c (2).d');
});

test('keepBothName: a name already carrying (n) increments past it', () => {
  assert.equal(say(keepBothName('report (2).md', ['report (2).md'])), 'report (3).md');
  assert.equal(
    say(keepBothName('report (2).md', ['report (2).md', 'report (3).md'])),
    'report (4).md',
  );
  assert.equal(say(keepBothName('web (7)', ['web (7)'])), 'web (8)');
  // Never nested: no `report (2) (2).md` anywhere in the chain.
  const chain = ['report.md'];
  for (let i = 0; i < 4; i += 1) chain.push(keepBothName(chain[chain.length - 1] as string, chain));
  assert.deepEqual(chain, [
    'report.md',
    'report (2).md',
    'report (3).md',
    'report (4).md',
    'report (5).md',
  ]);
  for (const n of chain) assert.equal(/\(\d+\)[^)]*\(\d+\)/.test(n), false, `nested suffix in ${n}`);
});

test('keepBothName: a free name is left alone', () => {
  assert.equal(say(keepBothName('report.md', [])), 'report.md');
  assert.equal(say(keepBothName('report.md', ['other.md'])), 'report.md');
  assert.equal(say(keepBothName('report (2).md', ['report.md'])), 'report (2).md');
});

// ---------------------------------------------------------------------------
// planResults
// ---------------------------------------------------------------------------

test('planResults: no conflict at all, everything is copied', () => {
  const items = [file('a.md'), folder('web')];
  const out = planResults(items, ['README.md'], 'replace');
  assert.deepEqual(out, [
    { name: 'a.md', state: 'copied', dir: false },
    { name: 'web', state: 'copied', dir: true },
  ]);
});

test('planResults: replace copies the conflicting items, folders included', () => {
  const items = [file('README.md'), folder('web'), file('new.md')];
  const out = planResults(items, ['README.md', 'web'], 'replace');
  assert.deepEqual(
    out.map((r) => [r.name, r.state, r.note]),
    [
      ['README.md', 'copied', undefined],
      // A DIRECTORY conflict under `replace` is copied like any other: the
      // dialog made one decision for the whole drop.
      ['web', 'copied', undefined],
      ['new.md', 'copied', undefined],
    ],
  );
});

test('planResults: skip leaves the conflicting items alone and copies the rest', () => {
  const items = [file('README.md'), folder('web'), file('new.md')];
  const out = planResults(items, ['README.md', 'web'], 'skip');
  assert.deepEqual(
    out.map((r) => [r.name, r.state]),
    [
      ['README.md', 'skipped'],
      ['web', 'skipped'],
      ['new.md', 'copied'],
    ],
  );
});

test('planResults: keep-both copies under a new name and says which', () => {
  const items = [file('report.md'), folder('web'), file('fresh.md')];
  const out = planResults(items, ['report.md', 'web'], 'keep-both');
  // The row keeps saying what was DROPPED; the note says where it landed.
  assert.deepEqual(out, [
    { name: 'report.md', state: 'copied', note: 'saved as report (2).md', dir: false },
    { name: 'web', state: 'copied', note: 'saved as web (2)', dir: true },
    { name: 'fresh.md', state: 'copied', dir: false },
  ]);
});

test('planResults: keep-both walks past the names already at the destination', () => {
  const out = planResults([file('report.md')], ['report.md', 'report (2).md'], 'keep-both');
  assert.equal(out[0]?.note, 'saved as report (3).md');
});

test('planResults: two items of one drop never get the same new name', () => {
  // The plan feeds its own allocations back in, so the second conflict cannot
  // be handed the name the first one just took.
  const items = [file('report.md'), file('report.md')];
  const out = planResults(items, ['report.md'], 'keep-both');
  assert.deepEqual(
    out.map((r) => r.note),
    ['saved as report (2).md', 'saved as report (3).md'],
  );
});

test('planResults: a file over the limit fails, with the limit as its note', () => {
  const items = [file('big.zip', MAX_ITEM_BYTES + 1), file('edge.zip', MAX_ITEM_BYTES)];
  const out = planResults(items, [], 'replace');
  assert.deepEqual(out, [
    { name: 'big.zip', state: 'failed', note: 'larger than the copy limit', dir: false },
    // Exactly at the limit is not over it.
    { name: 'edge.zip', state: 'copied', dir: false },
  ]);
});

test('planResults: a folder has no size and never fails on one', () => {
  const out = planResults([folder('web')], [], 'replace');
  assert.deepEqual(out, [{ name: 'web', state: 'copied', dir: true }]);
  // Even a folder the browser somehow sized is a recursive walk, which is
  // B10's job: it is not planned as failed here.
  const sized: DropItem = { name: 'huge', dir: true, bytes: MAX_ITEM_BYTES * 10 };
  assert.deepEqual(planResults([sized], [], 'replace'), [
    { name: 'huge', state: 'copied', dir: true },
  ]);
  // A file whose size the browser would not state is not failed either.
  assert.deepEqual(planResults([{ name: 'a.md', dir: false, bytes: null }], [], 'replace'), [
    { name: 'a.md', state: 'copied', dir: false },
  ]);
});

test('planResults: an over-size file that is also skipped is skipped, not failed', () => {
  // Nothing was attempted, so nothing can have failed.
  const out = planResults([file('big.zip', MAX_ITEM_BYTES + 1)], ['big.zip'], 'skip');
  assert.deepEqual(out, [{ name: 'big.zip', state: 'skipped', dir: false }]);
  // Under keep-both the copy IS attempted, and then the size decides.
  const kept = planResults([file('big.zip', MAX_ITEM_BYTES + 1)], ['big.zip'], 'keep-both');
  assert.deepEqual(kept, [
    { name: 'big.zip', state: 'failed', note: 'larger than the copy limit', dir: false },
  ]);
});

test('planResults: every outcome can occur in one drop', () => {
  const items = [
    file('README.md'),
    file('big.zip', MAX_ITEM_BYTES + 1),
    folder('web'),
    file('fresh.md'),
  ];
  const out = planResults(items, ['README.md'], 'skip');
  assert.deepEqual(
    out.map((r) => r.state),
    ['skipped', 'failed', 'copied', 'copied'],
  );
  assert.deepEqual(out.map((r) => r.name), items.map((i) => i.name));
});

test('planResults: an empty drop plans nothing', () => {
  assert.deepEqual(planResults([], ['README.md'], 'replace'), []);
});

// ---------------------------------------------------------------------------
// Copying and result copy
// ---------------------------------------------------------------------------

test('copyingHeader and progressText: the header names the destination once', () => {
  assert.equal(say(copyingHeader(3, 'src')), 'Copying 3 items into src');
  assert.equal(say(copyingHeader(1, 'src')), 'Copying 1 item into src');
  assert.equal(say(copyingHeader(2, 'Home')), 'Copying 2 items into Home');
  // The line under the list is the count alone: the destination is already on
  // screen, directly above it.
  assert.equal(say(progressText(2, 3, 'src')), '2 of 3');
  assert.equal(say(progressText(0, 1, 'src')), '0 of 1');
  assert.equal(say(progressText(3, 3, 'Home')), '3 of 3');
});

const results = (...rs: ItemResult[]): ItemResult[] => rs;

test('resultText: what was copied, in files and folders', () => {
  assert.equal(
    say(resultText(planResults([file('a.md'), file('b.md')], [], 'replace'), 'src')),
    'Copied 2 files into src.',
  );
  assert.equal(
    say(resultText(planResults([file('a.md')], [], 'replace'), 'src')),
    'Copied 1 file into src.',
  );
  assert.equal(
    say(resultText(planResults([folder('web')], [], 'replace'), 'Home')),
    'Copied 1 folder into Home.',
  );
  assert.equal(
    say(
      resultText(
        planResults([file('a.md'), file('b.md'), folder('web')], [], 'replace'),
        'src',
      ),
      ),
    'Copied 2 files and 1 folder into src.',
  );
});

test('resultText: a zero is never written', () => {
  const clean = planResults([file('a.md'), file('b.md')], [], 'replace');
  const out = say(resultText(clean, 'src'));
  assert.equal(out, 'Copied 2 files into src.');
  assert.equal(out.includes('0 skipped'), false);
  assert.equal(out.includes('0 failed'), false);
});

test('resultText: skipped and failed are appended as their own sentences', () => {
  assert.equal(
    say(
      resultText(
        results(
          { name: 'a.md', state: 'copied', dir: false },
          { name: 'b.md', state: 'copied', dir: false },
          { name: 'web', state: 'copied', dir: true },
          { name: 'README.md', state: 'skipped', dir: false },
        ),
        'src',
      ),
    ),
    'Copied 2 files and 1 folder into src. 1 skipped.',
  );
  assert.equal(
    say(
      resultText(
        results(
          { name: 'a.md', state: 'copied', dir: false },
          { name: 'b.md', state: 'copied', dir: false },
          { name: 'big.zip', state: 'failed', note: 'larger than the copy limit', dir: false },
        ),
        'src',
      ),
    ),
    'Copied 2 files into src. 1 failed.',
  );
  assert.equal(
    say(
      resultText(
        results(
          { name: 'a.md', state: 'copied', dir: false },
          { name: 'b.md', state: 'skipped', dir: false },
          { name: 'c.md', state: 'skipped', dir: false },
          { name: 'big.zip', state: 'failed', dir: false },
        ),
        'src',
      ),
    ),
    'Copied 1 file into src. 2 skipped. 1 failed.',
  );
});

test('resultText: nothing copied says so, and still counts what happened', () => {
  assert.equal(
    say(
      resultText(
        planResults([file('a.md'), file('b.md'), folder('web')], ['a.md', 'b.md', 'web'], 'skip'),
        'src',
      ),
    ),
    'Nothing copied into src. 3 skipped.',
  );
  assert.equal(
    say(
      resultText(
        results({ name: 'big.zip', state: 'failed', note: 'larger than the copy limit', dir: false }),
        'Home',
      ),
    ),
    'Nothing copied into Home. 1 failed.',
  );
  // An empty plan has nothing to report but still speaks a sentence.
  assert.equal(say(resultText([], 'src')), 'Nothing copied into src.');
});

test('resultText: results that do not say file-or-folder are counted as items', () => {
  // The `dir` field is additive; a hand-built row without it falls back to the
  // drag’s own vocabulary rather than guessing.
  assert.equal(
    say(resultText(results({ name: 'a.md', state: 'copied' }, { name: 'b', state: 'copied' }), 'src')),
    'Copied 2 items into src.',
  );
  assert.equal(
    say(resultText(results({ name: 'a.md', state: 'copied' }), 'src')),
    'Copied 1 item into src.',
  );
});

// ---------------------------------------------------------------------------
// The demo path: what the dialog shows for a drop onto a real listing
// ---------------------------------------------------------------------------

test('a real listing makes README.md and web the conflicts at the root', () => {
  // Since part B2 the listing is the REAL `GET /api/fs/entries` answer for the
  // destination, read at drop time — a plain array of top-level names, which
  // is all `conflictsOf` ever cared about. `ui-files-panel.test.ts` pins where
  // it comes from; this pins what is done with it.
  const listing = ['README.md', 'web', 'server', 'package.json'];
  const items = [file('README.md'), folder('web'), file('brand-new.md')];
  assert.deepEqual(conflictsOf(items, listing), ['README.md', 'web']);
  assert.equal(conflictTitle(conflictsOf(items, listing), 'Home'), '2 items already exist in Home');
  assert.equal(
    resultText(planResults(items, listing, 'keep-both'), 'Home'),
    'Copied 2 files and 1 folder into Home.',
  );
  assert.equal(planResults(items, listing, 'keep-both')[0]?.note, 'saved as README (2).md');
});

// ---------------------------------------------------------------------------
// Sweeps over everything the module says
// ---------------------------------------------------------------------------

test('non-vacuity: the sweeps below read every sentence this module builds', () => {
  assert.ok(PRODUCED.length >= 55, `only ${PRODUCED.length} strings collected`);
  assert.ok(PRODUCED.includes('Copy 3 items into src'));
  assert.ok(PRODUCED.includes('README.md already exists in src'));
  assert.ok(PRODUCED.includes('Copied 2 files and 1 folder into src. 1 skipped.'));
});

test('no decorative separator reaches any produced string (README-v3 copy rules)', () => {
  const notes = [
    ...planResults(
      [file('report.md'), file('big.zip', MAX_ITEM_BYTES + 1), folder('web')],
      ['report.md', 'web'],
      'keep-both',
    ).map((r) => r.note ?? ''),
  ];
  const offenders = [...PRODUCED, ...notes].filter(
    (s) => s.includes(' — ') || s.includes(' · ') || s.includes(' | ') || s.includes('⎿'),
  );
  assert.deepEqual(offenders, [], 'produced copy carries no decorative separators');
});

test('no produced string carries a path separator when the inputs are plain names', () => {
  const dests = ['Home', 'src', 'Session Manager'];
  const items = [file('README.md'), folder('web'), file('big.zip', MAX_ITEM_BYTES + 1)];
  const listing = ['README.md', 'web'];
  const strings: string[] = [...PRODUCED, DROP_HINT];
  for (const dest of dests) {
    strings.push(destLine(items.length, dest), copyingHeader(items.length, dest));
    strings.push(progressText(1, items.length, dest), itemsText(items));
    strings.push(conflictTitle(conflictsOf(items, listing), dest));
    for (const choice of ['replace', 'keep-both', 'skip'] as const) {
      const plan = planResults(items, listing, choice);
      strings.push(resultText(plan, dest));
      for (const r of plan) strings.push(r.name, r.note ?? '');
    }
  }
  const offenders = strings.filter((s) => s.includes('/'));
  assert.deepEqual(offenders, [], 'a path never reaches a label (PROJECT-SCOPE, 2026-07-25)');
  assert.ok(strings.length > 80, `non-vacuity: only ${strings.length} strings swept`);
});

// ---------------------------------------------------------------------------
// Part B10 (user decisions D2-D4, 2026-09-20): the rules the REAL copy reads
// ---------------------------------------------------------------------------

const nullFile = (name: string, dir = false): DropItem => ({ name, dir, bytes: null });
const CHOICES: Choice[] = ['replace', 'keep-both', 'skip'];

test('planTargets: no conflict — every choice uploads under the dropped name', () => {
  for (const choice of CHOICES) {
    assert.deepEqual(
      planTargets([file('a.md'), folder('web')], ['other.md'], choice),
      [
        { item: file('a.md'), conflict: false, plan: 'upload', target: 'a.md' },
        { item: folder('web'), conflict: false, plan: 'upload', target: 'web' },
      ],
      `choice ${choice}`,
    );
  }
});

test('planTargets: replace keeps the name and marks the clash, files and folders alike', () => {
  // D2: a FOLDER under `replace` merges — one row, its own name, and the
  // uploader decides per file what that means.
  assert.deepEqual(planTargets([file('README.md'), folder('web'), file('new.md')], ['README.md', 'web'], 'replace'), [
    { item: file('README.md'), conflict: true, plan: 'upload', target: 'README.md' },
    { item: folder('web'), conflict: true, plan: 'upload', target: 'web' },
    { item: file('new.md'), conflict: false, plan: 'upload', target: 'new.md' },
  ]);
});

test('planTargets: skip stops at the clash and takes no name', () => {
  // D2: a skipped FOLDER is skipped whole; nothing inside it is walked.
  assert.deepEqual(planTargets([file('README.md'), folder('web'), file('new.md')], ['README.md', 'web'], 'skip'), [
    { item: file('README.md'), conflict: true, plan: 'skipped', target: 'README.md' },
    { item: folder('web'), conflict: true, plan: 'skipped', target: 'web' },
    { item: file('new.md'), conflict: false, plan: 'upload', target: 'new.md' },
  ]);
});

test('planTargets: keep-both puts the new name in target AND in the note', () => {
  // D2: the whole FOLDER lands under `web (2)`; the row still says `web`.
  assert.deepEqual(planTargets([file('report.md'), folder('web'), file('fresh.md')], ['report.md', 'web'], 'keep-both'), [
    {
      item: file('report.md'),
      conflict: true,
      plan: 'upload',
      target: 'report (2).md',
      note: 'saved as report (2).md',
    },
    { item: folder('web'), conflict: true, plan: 'upload', target: 'web (2)', note: 'saved as web (2)' },
    { item: file('fresh.md'), conflict: false, plan: 'upload', target: 'fresh.md' },
  ]);
});

test('planTargets: two same-named items in ONE drop never share a target', () => {
  const out = planTargets([file('report.md'), file('report.md')], ['report.md'], 'keep-both');
  assert.deepEqual(out.map((p) => p.target), ['report (2).md', 'report (3).md']);
  assert.deepEqual(out.map((p) => p.note), ['saved as report (2).md', 'saved as report (3).md']);
  // A folder and a file of the same name collide the same way.
  const mixed = planTargets([folder('web'), file('web')], ['web'], 'keep-both');
  assert.deepEqual(mixed.map((p) => p.target), ['web (2)', 'web (3)']);
  // And the plan walks past the names the destination already holds.
  assert.equal(planTargets([file('report.md')], ['report.md', 'report (2).md'], 'keep-both')[0]?.target, 'report (3).md');
});

test('planTargets: ONE file over the per-file cap fails, the drop goes on (D3)', () => {
  const out = planTargets(
    [file('big.zip', MAX_ITEM_BYTES + 1), file('edge.zip', MAX_ITEM_BYTES), folder('web')],
    [],
    'replace',
  );
  assert.deepEqual(out, [
    {
      item: file('big.zip', MAX_ITEM_BYTES + 1),
      conflict: false,
      plan: 'failed',
      target: 'big.zip',
      note: 'larger than the copy limit',
    },
    // Exactly at the limit is not over it.
    { item: file('edge.zip', MAX_ITEM_BYTES), conflict: false, plan: 'upload', target: 'edge.zip' },
    { item: folder('web'), conflict: false, plan: 'upload', target: 'web' },
  ]);
});

test('planTargets: a folder has no size of its own and never fails on one', () => {
  // A folder's total is the recursive walk, which `dropRefusal` judges.
  const sized: DropItem = { name: 'huge', dir: true, bytes: MAX_ITEM_BYTES * 10 };
  assert.deepEqual(planTargets([sized], [], 'replace'), [
    { item: sized, conflict: false, plan: 'upload', target: 'huge' },
  ]);
  // A file the browser would not size is not failed either.
  assert.deepEqual(planTargets([nullFile('a.md')], [], 'replace'), [
    { item: nullFile('a.md'), conflict: false, plan: 'upload', target: 'a.md' },
  ]);
});

test('planTargets: skip beats size — nothing was attempted, so nothing failed', () => {
  const big = file('big.zip', MAX_ITEM_BYTES + 1);
  assert.deepEqual(planTargets([big], ['big.zip'], 'skip'), [
    { item: big, conflict: true, plan: 'skipped', target: 'big.zip' },
  ]);
  // Under keep-both the copy IS attempted, and then the size decides.
  assert.deepEqual(planTargets([big], ['big.zip'], 'keep-both'), [
    { item: big, conflict: true, plan: 'failed', target: 'big.zip', note: 'larger than the copy limit' },
  ]);
});

test('planTargets: an empty drop plans nothing, and the item is handed back untouched', () => {
  for (const choice of CHOICES) assert.deepEqual(planTargets([], ['a.md'], choice), []);
  const it = file('a.md');
  assert.equal(planTargets([it], [], 'replace')[0]?.item, it);
});

// ---------------------------------------------------------------------------
// uploadMode
// ---------------------------------------------------------------------------

test('uploadMode: `replace` is the only deliberate overwrite (D2)', () => {
  assert.equal(uploadMode('replace', true), 'replace');
  // No clash: there is nothing to overwrite, so the name must be free.
  assert.equal(uploadMode('replace', false), 'new');
  // A keep-both row writes its NEW name, which must be free as well.
  assert.equal(uploadMode('keep-both', true), 'new');
  assert.equal(uploadMode('keep-both', false), 'new');
  // A skipped row is never written; asked anyway, it never says `replace`.
  assert.equal(uploadMode('skip', true), 'new');
  assert.equal(uploadMode('skip', false), 'new');
});

test('uploadMode: every planned row of a drop agrees with its plan', () => {
  const items = [file('README.md'), folder('web'), file('fresh.md')];
  const listing = ['README.md', 'web'];
  assert.deepEqual(
    planTargets(items, listing, 'replace').map((p) => uploadMode('replace', p.conflict)),
    ['replace', 'replace', 'new'],
  );
  assert.deepEqual(
    planTargets(items, listing, 'keep-both').map((p) => uploadMode('keep-both', p.conflict)),
    ['new', 'new', 'new'],
  );
});

// ---------------------------------------------------------------------------
// dropRefusal
// ---------------------------------------------------------------------------

test('dropRefusal: the drop-level caps are 2000 files and 1 GiB (D3)', () => {
  assert.equal(MAX_DROP_FILES, 2000);
  assert.equal(MAX_DROP_BYTES, 1024 * 1024 * 1024);
  assert.equal(MAX_DROP_BYTES, 1073741824);
});

test('dropRefusal: a limit is a limit, not a warning zone', () => {
  assert.equal(dropRefusal(0, 0), null);
  assert.equal(dropRefusal(1, 1024), null);
  assert.equal(dropRefusal(MAX_DROP_FILES, MAX_DROP_BYTES), null);
  assert.equal(dropRefusal(MAX_DROP_FILES + 1, 0), 'Too many files. Drop up to 2000 files at a time.');
  assert.equal(dropRefusal(0, MAX_DROP_BYTES + 1), 'Too much at once. Drop up to 1 GB at a time.');
  assert.equal(dropRefusal(2001, 0), TOO_MANY_FILES_SENTENCE);
  assert.equal(dropRefusal(0, 1073741825), TOO_MANY_BYTES_SENTENCE);
  assert.equal(TOO_MANY_FILES_SENTENCE, 'Too many files. Drop up to 2000 files at a time.');
  assert.equal(TOO_MANY_BYTES_SENTENCE, 'Too much at once. Drop up to 1 GB at a time.');
});

test('dropRefusal: files are asked before bytes, and one reason is named', () => {
  assert.equal(dropRefusal(MAX_DROP_FILES + 1, MAX_DROP_BYTES + 1), TOO_MANY_FILES_SENTENCE);
  assert.equal(dropRefusal(5000, 10 * MAX_DROP_BYTES), TOO_MANY_FILES_SENTENCE);
  // Under the file cap, the bytes still refuse it.
  assert.equal(dropRefusal(2, MAX_DROP_BYTES + 1), TOO_MANY_BYTES_SENTENCE);
});

test('dropRefusal: one oversized FILE is not a whole-drop refusal (D3)', () => {
  // 50 MiB over the per-file cap, in a drop of one file: the walk's totals are
  // far under both caps, so the drop is accepted and only that row fails.
  assert.equal(dropRefusal(1, MAX_ITEM_BYTES + 1), null);
  assert.equal(planTargets([file('big.zip', MAX_ITEM_BYTES + 1)], [], 'replace')[0]?.plan, 'failed');
});

// ---------------------------------------------------------------------------
// failNote and partialNote
// ---------------------------------------------------------------------------

test('failNote: every status the upload route can answer has its own reason', () => {
  assert.equal(failNote(409), 'something with that name is already there');
  assert.equal(failNote(413), 'larger than the copy limit');
  assert.equal(failNote(403), 'not allowed in that folder');
  assert.equal(failNote(404), 'that folder is no longer there');
  assert.equal(failNote(507), 'no room left on the disk');
  assert.equal(failNote(400), 'that name is not allowed');
  assert.equal(failNote(422), 'that name is not allowed');
});

test('failNote: 413 is the A9 note, unchanged — one sentence for one limit', () => {
  const planned = planTargets([file('big.zip', MAX_ITEM_BYTES + 1)], [], 'replace')[0];
  assert.equal(failNote(413), planned?.note);
});

test('failNote: an unexplained failure is not given an invented cause', () => {
  assert.equal(failNote(500), 'could not be copied');
  assert.equal(failNote(502), 'could not be copied');
  assert.equal(failNote(0), 'could not be copied');
  assert.equal(failNote(200), 'could not be copied');
  assert.equal(failNote(401), 'could not be copied');
  assert.equal(failNote(-1), 'could not be copied');
});

test('partialNote: the noun follows the TOTAL (D4)', () => {
  assert.equal(partialNote(3, 12), '3 of 12 files failed');
  assert.equal(partialNote(1, 12), '1 of 12 files failed');
  assert.equal(partialNote(12, 12), '12 of 12 files failed');
  assert.equal(partialNote(1, 1), '1 of 1 file failed');
  assert.equal(partialNote(0, 1), '0 of 1 file failed');
  assert.equal(partialNote(2, 2), '2 of 2 files failed');
});

// ---------------------------------------------------------------------------
// planResults has not moved a byte
// ---------------------------------------------------------------------------

/** The inputs the identity table below was taken over, in this order. */
const IDENTITY_CASES: Array<{ items: DropItem[]; listing: string[] }> = [
  { items: [], listing: [] },
  { items: [], listing: ['a.md'] },
  { items: [file('a.md')], listing: [] },
  { items: [file('a.md')], listing: ['a.md'] },
  { items: [folder('web')], listing: [] },
  { items: [folder('web')], listing: ['web'] },
  { items: [file('report.md'), file('report.md')], listing: ['report.md'] },
  { items: [file('report.md'), folder('report.md')], listing: ['report.md', 'report (2).md'] },
  { items: [file('archive.tar.gz')], listing: ['archive.tar.gz'] },
  { items: [file('.gitignore')], listing: ['.gitignore'] },
  { items: [file('big.zip', MAX_ITEM_BYTES + 1)], listing: [] },
  { items: [file('big.zip', MAX_ITEM_BYTES + 1)], listing: ['big.zip'] },
  { items: [file('edge.zip', MAX_ITEM_BYTES)], listing: ['edge.zip'] },
  { items: [nullFile('nosize.bin')], listing: ['nosize.bin'] },
  { items: [{ name: 'huge', dir: true, bytes: MAX_ITEM_BYTES * 10 }], listing: ['huge'] },
  {
    items: [file('README.md'), file('big.zip', MAX_ITEM_BYTES + 1), folder('web'), file('fresh.md')],
    listing: ['README.md', 'web'],
  },
  { items: [file('a.md'), file('b.md'), folder('web')], listing: ['a.md', 'b.md', 'web'] },
  { items: [file('web (7)'), folder('web (7)')], listing: ['web (7)'] },
  { items: [file('LICENSE'), file('LICENSE')], listing: ['LICENSE', 'LICENSE (2)'] },
];

/**
 * What A9's OWN `planResults` — the standalone function B10 replaced with a map
 * over `planTargets` — answered for every case above, one string per
 * (case, choice) in that order, `JSON.stringify`d so key ORDER is pinned too.
 *
 * Written out as literals on purpose: the old implementation is gone, so this
 * table is the only surviving witness of it. If a row here ever has to change,
 * the A9 contract changed and the dialog's rows moved with it.
 */
const A9_PLANS: string[] = [
  '[]',
  '[]',
  '[]',
  '[]',
  '[]',
  '[]',
  '[{"name":"a.md","state":"copied","dir":false}]',
  '[{"name":"a.md","state":"copied","dir":false}]',
  '[{"name":"a.md","state":"copied","dir":false}]',
  '[{"name":"a.md","state":"copied","dir":false}]',
  '[{"name":"a.md","state":"copied","note":"saved as a (2).md","dir":false}]',
  '[{"name":"a.md","state":"skipped","dir":false}]',
  '[{"name":"web","state":"copied","dir":true}]',
  '[{"name":"web","state":"copied","dir":true}]',
  '[{"name":"web","state":"copied","dir":true}]',
  '[{"name":"web","state":"copied","dir":true}]',
  '[{"name":"web","state":"copied","note":"saved as web (2)","dir":true}]',
  '[{"name":"web","state":"skipped","dir":true}]',
  '[{"name":"report.md","state":"copied","dir":false},{"name":"report.md","state":"copied","dir":false}]',
  '[{"name":"report.md","state":"copied","note":"saved as report (2).md","dir":false},{"name":"report.md","state":"copied","note":"saved as report (3).md","dir":false}]',
  '[{"name":"report.md","state":"skipped","dir":false},{"name":"report.md","state":"skipped","dir":false}]',
  '[{"name":"report.md","state":"copied","dir":false},{"name":"report.md","state":"copied","dir":true}]',
  '[{"name":"report.md","state":"copied","note":"saved as report (3).md","dir":false},{"name":"report.md","state":"copied","note":"saved as report (4).md","dir":true}]',
  '[{"name":"report.md","state":"skipped","dir":false},{"name":"report.md","state":"skipped","dir":true}]',
  '[{"name":"archive.tar.gz","state":"copied","dir":false}]',
  '[{"name":"archive.tar.gz","state":"copied","note":"saved as archive.tar (2).gz","dir":false}]',
  '[{"name":"archive.tar.gz","state":"skipped","dir":false}]',
  '[{"name":".gitignore","state":"copied","dir":false}]',
  '[{"name":".gitignore","state":"copied","note":"saved as .gitignore (2)","dir":false}]',
  '[{"name":".gitignore","state":"skipped","dir":false}]',
  '[{"name":"big.zip","state":"failed","note":"larger than the copy limit","dir":false}]',
  '[{"name":"big.zip","state":"failed","note":"larger than the copy limit","dir":false}]',
  '[{"name":"big.zip","state":"failed","note":"larger than the copy limit","dir":false}]',
  '[{"name":"big.zip","state":"failed","note":"larger than the copy limit","dir":false}]',
  '[{"name":"big.zip","state":"failed","note":"larger than the copy limit","dir":false}]',
  '[{"name":"big.zip","state":"skipped","dir":false}]',
  '[{"name":"edge.zip","state":"copied","dir":false}]',
  '[{"name":"edge.zip","state":"copied","note":"saved as edge (2).zip","dir":false}]',
  '[{"name":"edge.zip","state":"skipped","dir":false}]',
  '[{"name":"nosize.bin","state":"copied","dir":false}]',
  '[{"name":"nosize.bin","state":"copied","note":"saved as nosize (2).bin","dir":false}]',
  '[{"name":"nosize.bin","state":"skipped","dir":false}]',
  '[{"name":"huge","state":"copied","dir":true}]',
  '[{"name":"huge","state":"copied","note":"saved as huge (2)","dir":true}]',
  '[{"name":"huge","state":"skipped","dir":true}]',
  '[{"name":"README.md","state":"copied","dir":false},{"name":"big.zip","state":"failed","note":"larger than the copy limit","dir":false},{"name":"web","state":"copied","dir":true},{"name":"fresh.md","state":"copied","dir":false}]',
  '[{"name":"README.md","state":"copied","note":"saved as README (2).md","dir":false},{"name":"big.zip","state":"failed","note":"larger than the copy limit","dir":false},{"name":"web","state":"copied","note":"saved as web (2)","dir":true},{"name":"fresh.md","state":"copied","dir":false}]',
  '[{"name":"README.md","state":"skipped","dir":false},{"name":"big.zip","state":"failed","note":"larger than the copy limit","dir":false},{"name":"web","state":"skipped","dir":true},{"name":"fresh.md","state":"copied","dir":false}]',
  '[{"name":"a.md","state":"copied","dir":false},{"name":"b.md","state":"copied","dir":false},{"name":"web","state":"copied","dir":true}]',
  '[{"name":"a.md","state":"copied","note":"saved as a (2).md","dir":false},{"name":"b.md","state":"copied","note":"saved as b (2).md","dir":false},{"name":"web","state":"copied","note":"saved as web (2)","dir":true}]',
  '[{"name":"a.md","state":"skipped","dir":false},{"name":"b.md","state":"skipped","dir":false},{"name":"web","state":"skipped","dir":true}]',
  '[{"name":"web (7)","state":"copied","dir":false},{"name":"web (7)","state":"copied","dir":true}]',
  '[{"name":"web (7)","state":"copied","note":"saved as web (8)","dir":false},{"name":"web (7)","state":"copied","note":"saved as web (9)","dir":true}]',
  '[{"name":"web (7)","state":"skipped","dir":false},{"name":"web (7)","state":"skipped","dir":true}]',
  '[{"name":"LICENSE","state":"copied","dir":false},{"name":"LICENSE","state":"copied","dir":false}]',
  '[{"name":"LICENSE","state":"copied","note":"saved as LICENSE (3)","dir":false},{"name":"LICENSE","state":"copied","note":"saved as LICENSE (4)","dir":false}]',
  '[{"name":"LICENSE","state":"skipped","dir":false},{"name":"LICENSE","state":"skipped","dir":false}]',
];

test('planResults: rebuilt over planTargets, byte-identical to A9 over the table', () => {
  assert.equal(A9_PLANS.length, IDENTITY_CASES.length * CHOICES.length);
  assert.equal(A9_PLANS.length, 57);
  let i = 0;
  for (const c of IDENTITY_CASES) {
    for (const choice of CHOICES) {
      const got = JSON.stringify(planResults(c.items, c.listing, choice));
      assert.equal(got, A9_PLANS[i], `case ${i} (${choice}) moved`);
      i += 1;
    }
  }
  assert.equal(i, 57);
});

test('planResults: a row without a note has NO note key, as A9 built it', () => {
  // `{ note: undefined }` is not the same object, and `deepStrictEqual` knows.
  const [plain] = planResults([file('a.md')], [], 'replace');
  assert.deepEqual(Object.keys(plain as ItemResult), ['name', 'state', 'dir']);
  const [noted] = planResults([file('a.md')], ['a.md'], 'keep-both');
  assert.deepEqual(Object.keys(noted as ItemResult), ['name', 'state', 'note', 'dir']);
});

test('planResults and planTargets never disagree about one drop', () => {
  const items = [
    file('README.md'),
    file('big.zip', MAX_ITEM_BYTES + 1),
    folder('web'),
    file('fresh.md'),
    file('README.md'),
  ];
  const listing = ['README.md', 'web'];
  const asState = { upload: 'copied', skipped: 'skipped', failed: 'failed' } as const;
  for (const choice of CHOICES) {
    const plan = planTargets(items, listing, choice);
    const rows = planResults(items, listing, choice);
    assert.equal(rows.length, plan.length);
    for (const [n, p] of plan.entries()) {
      assert.equal(rows[n]?.name, p.item.name);
      assert.equal(rows[n]?.state, asState[p.plan]);
      assert.equal(rows[n]?.note, p.note);
      assert.equal(rows[n]?.dir, p.item.dir);
    }
  }
});

// ---------------------------------------------------------------------------
// The copy rules, over B10's own sentences
// ---------------------------------------------------------------------------

test('B10 copy: no path, no separator, no zero-count in any new sentence', () => {
  const strings: string[] = [
    TOO_MANY_FILES_SENTENCE,
    TOO_MANY_BYTES_SENTENCE,
    partialNote(3, 12),
    partialNote(1, 1),
  ];
  for (const status of [400, 403, 404, 409, 413, 422, 500, 507]) strings.push(failNote(status));
  for (const choice of CHOICES) {
    for (const p of planTargets(
      [file('README.md'), folder('web'), file('big.zip', MAX_ITEM_BYTES + 1)],
      ['README.md', 'web'],
      choice,
    )) {
      strings.push(p.target, p.note ?? '');
    }
  }
  const offenders = strings.filter(
    (s) => s.includes('/') || s.includes('\\') || s.includes(' — ') || s.includes(' · ') || s.includes(' | '),
  );
  assert.deepEqual(offenders, [], 'a path never reaches a label (PROJECT-SCOPE, 2026-07-25)');
  assert.ok(strings.length > 20, `non-vacuity: only ${strings.length} strings swept`);
});
