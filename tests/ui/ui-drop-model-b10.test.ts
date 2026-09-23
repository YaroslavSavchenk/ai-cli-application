/**
 * `web/src/ui/drop-model.ts` — Part B10 (user decisions D2-D4, 2026-09-20,
 * `.claude/plans/nocturne/PLAN-B10.md`): the rules the REAL copy reads —
 * `planTargets` (what each dropped item is uploaded as), `uploadMode` (only
 * `replace` overwrites), the drop-level caps (`dropRefusal`: 2000 files,
 * 1 GiB), the failure copy (`failNote`, `partialNote`), that A9's
 * `planResults` rebuilt over `planTargets` is byte-identical to A9, and the
 * copy rules over B10's own sentences. Split from
 * `tests/ui/ui-drop-model.test.ts`.
 *
 * How: the pure module imported directly — no DOM.
 *
 * Why: these decide whether a file on disk is replaced, renamed or left alone;
 * an overwrite that is not the user's `replace`, or two items of one drop
 * sharing a target, loses a file with no error.
 *
 * NOT claimed here: that a single byte is copied (the upload route,
 * `tests/server/`), and anything drawn (`.claude/skills/verify-terminal/SKILL.md`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dropRefusal,
  failNote,
  partialNote,
  planResults,
  planTargets,
  uploadMode,
  MAX_DROP_BYTES,
  MAX_DROP_FILES,
  MAX_ITEM_BYTES,
  TOO_MANY_BYTES_SENTENCE,
  TOO_MANY_FILES_SENTENCE,
  type Choice,
  type DropItem,
  type ItemResult,
} from '../../web/src/ui/drop-model.ts';
import { file, folder } from '../helpers/ui-drop-model-fixture.ts';

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
