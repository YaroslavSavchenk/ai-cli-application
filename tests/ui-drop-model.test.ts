/**
 * `web/src/ui/drop-model.ts` — the pure rules behind A9's Explorer drop
 * (user decisions 2026-09-15, `.claude/PLAN-A9.md`): how a drag counts itself,
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
  hasFiles,
  itemsText,
  keepBothName,
  planResults,
  progressText,
  resultText,
  tooMany,
  DROP_HINT,
  MAX_ITEMS,
  MAX_ITEM_BYTES,
  type DropItem,
  type ItemResult,
} from '../web/src/ui/drop-model.ts';

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
// The mock's own demo path (what the dialog will actually show until B10)
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
