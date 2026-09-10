/**
 * The shortcuts overlay's key table (`ROWS` in `web/src/ui/shortcuts.ts`) vs.
 * the code that actually reads keys. The overlay is the app's only promise
 * about which keystrokes it takes; 2026-09-08 added the first row that takes a
 * key OUTSIDE the `ctrl+alt` reservation (the paste chords), so "what the
 * overlay claims" and "what `isPasteChord` accepts" must be one set, not two.
 *
 * Two halves, and the second is the load-bearing one:
 *   1. read the table (a source scan — `ROWS` is module-private, and the
 *      overlay needs a DOM to render);
 *   2. ENUMERATE the chord space and ask the real `isPasteChord` which
 *      keystrokes it takes, then assert that set equals what the table lists.
 *      No hardcoded expectation on either side: an extra accepted chord fails
 *      just as loudly as a missing table row.
 *
 * The scan's own vacuity is guarded (the table must parse, and known rows must
 * be found) so a regex that quietly matches nothing cannot make this pass.
 *
 * 2026-09-08 also added the link row — `ctrl+click a link`. It is a GESTURE
 * row (a mouse sentence, like the two drag rows), not a keyboard chord, so it
 * is deliberately outside the paste set the enumeration above compares: it is
 * cross-checked against `isLinkActivation` on its own, and the "only paste
 * lives outside ctrl+alt" invariant exempts gesture rows explicitly rather than
 * by accident.
 *
 * 2026-09-10 added the COPY row — `ctrl+shift+c` / `ctrl+insert`, "copy the
 * selection" (xterm draws on a canvas, so the browser's own copy takes
 * nothing). It is the second sanctioned row outside the `ctrl+alt`
 * reservation, and it gets the same treatment as paste: exactly one row,
 * exactly two chords, and an enumeration proving the set `isCopyChord` accepts
 * IS that row. The two sets must also be disjoint — `ctrl+insert` is copy,
 * `shift+insert` is paste, and `ctrl+shift+insert` is neither.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCopyChord, isLinkActivation, isPasteChord } from '../web/src/ui/keys.ts';
import type { KeyChord } from '../web/src/ui/keys.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHORTCUTS = join(REPO_ROOT, 'web', 'src', 'ui', 'shortcuts.ts');

interface TableRow {
  keys: string[];
  /** `gesture: true` in the literal — a mouse sentence, not a keyboard chord. */
  gesture: boolean;
  what: string;
}

/** Parse the `ROWS` literal out of shortcuts.ts. */
function readRows(): TableRow[] {
  const src = readFileSync(SHORTCUTS, 'utf8');
  const start = src.indexOf('const ROWS');
  assert.notEqual(start, -1, 'shortcuts.ts must still declare a ROWS table');
  const end = src.indexOf('\n];', start);
  assert.notEqual(end, -1, 'the ROWS table must still end with a `];` line');
  const block = src.slice(start, end);
  const out: TableRow[] = [];
  const rowRe = /\{\s*keys:\s*\[([^\]]*)\]([^}]*?)what:\s*(['"])((?:\\.|(?!\3).)*)\3/g;
  for (const m = { v: rowRe.exec(block) }; m.v !== null; m.v = rowRe.exec(block)) {
    const keys = [...(m.v[1] ?? '').matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)].map((k) => k[2] as string);
    out.push({ keys, gesture: (m.v[2] ?? '').includes('gesture: true'), what: m.v[4] as string });
  }
  return out;
}

/** Chord string -> the structural event the app's key code reads. */
function parseChord(text: string): KeyChord {
  const parts = text.split('+');
  const key = parts[parts.length - 1] as string;
  return {
    type: 'keydown',
    key: key === 'insert' ? 'Insert' : key,
    ctrlKey: parts.includes('ctrl'),
    shiftKey: parts.includes('shift'),
    altKey: parts.includes('alt'),
    metaKey: parts.includes('meta'),
  };
}

/** A chord -> its table spelling (`ctrl+shift+v`), so both sides compare as one vocabulary. */
function spell(e: KeyChord): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey) mods.push('meta');
  return [...mods, e.key.toLowerCase()].join('+');
}

const ROWS = readRows();
const pasteRows = ROWS.filter((r) => r.what.includes('paste'));
const copyRows = ROWS.filter((r) => r.what.includes('copy'));

/**
 * Every chord in the plausible space (all 16 ctrl/shift/alt/meta combinations
 * over the keys a paste or copy could reasonably be bound to, plus a few the
 * app must leave to the PTY) that `accepts` takes, in table spelling.
 */
function acceptedChords(accepts: (e: KeyChord) => boolean): string[] {
  const keys = ['v', 'V', 'Insert', 'insert', 'c', 'C', 'x', 'p', 'y', 'Delete', 'Enter', ' '];
  const accepted = new Set<string>();
  for (const key of keys) {
    for (let bits = 0; bits < 16; bits += 1) {
      const e: KeyChord = {
        type: 'keydown',
        key,
        ctrlKey: (bits & 1) !== 0,
        shiftKey: (bits & 2) !== 0,
        altKey: (bits & 4) !== 0,
        metaKey: (bits & 8) !== 0,
      };
      if (accepts(e)) accepted.add(spell(e));
    }
  }
  return [...accepted].sort();
}

// ---------------------------------------------------------------------------

test('the shortcuts table parses (non-vacuity: rows, keys, and known entries are all found)', () => {
  assert.ok(ROWS.length >= 10, `expected the whole table, parsed ${ROWS.length} rows`);
  for (const r of ROWS) assert.ok(r.keys.length >= 1, `a row with no keys: ${r.what}`);
  // Rows that have to be there whatever else changes.
  assert.ok(
    ROWS.some((r) => r.keys.includes('esc')),
    'the esc row must be in the table',
  );
  assert.ok(
    ROWS.some((r) => r.keys.includes('ctrl+alt+t')),
    'the launch-dialog row must be in the table',
  );
});

test('the overlay lists the paste chords on exactly ONE row, and it lists exactly two', () => {
  assert.equal(pasteRows.length, 1, `expected one paste row, found ${pasteRows.length}`);
  const row = pasteRows[0] as TableRow;
  assert.deepEqual(row.keys, ['ctrl+shift+v', 'shift+insert']);
  assert.equal(row.what, 'paste the clipboard into the terminal');
});

test('every chord the overlay lists as a paste chord really IS one (isPasteChord accepts it)', () => {
  const row = pasteRows[0] as TableRow;
  for (const text of row.keys) {
    assert.equal(isPasteChord(parseChord(text)), true, `the overlay promises ${text}`);
  }
});

test('the app takes NO paste chord the overlay does not list — the accepted set is the table', () => {
  // Enumerate the whole plausible space: every modifier combination over the
  // keys a paste could reasonably be bound to, plus a few the app must leave to
  // the PTY. Whatever isPasteChord accepts here IS its full vocabulary.
  const keys = ['v', 'V', 'Insert', 'insert', 'c', 'C', 'x', 'p', 'y', 'Delete', 'Enter', ' '];
  const accepted = new Set<string>();
  for (const key of keys) {
    for (let bits = 0; bits < 16; bits += 1) {
      const e: KeyChord = {
        type: 'keydown',
        key,
        ctrlKey: (bits & 1) !== 0,
        shiftKey: (bits & 2) !== 0,
        altKey: (bits & 4) !== 0,
        metaKey: (bits & 8) !== 0,
      };
      if (isPasteChord(e)) accepted.add(spell(e));
    }
  }
  const listed = new Set((pasteRows[0] as TableRow).keys);
  assert.deepEqual([...accepted].sort(), [...listed].sort());
});

test('the paste and copy rows are the ONLY rows outside the ctrl+alt reservation that bind a printable key', () => {
  // The overlay's own standing claim (its note, and the file header): app
  // chords live on ctrl+alt. Gestures and single non-printing keys are exempt;
  // anything else taking `ctrl+`/`shift+` must be THE paste row or THE copy
  // row — exempted by identity (the single rows pinned above), not by a
  // substring of their description.
  const sanctioned = [...pasteRows, ...copyRows];
  assert.equal(sanctioned.length, 2, 'the exemption must name exactly the paste row and the copy row');
  const outside = ROWS.filter((r) =>
    r.keys.some(
      (k) =>
        !r.gesture &&
        (k.startsWith('ctrl+') || k.startsWith('shift+')) &&
        !k.startsWith('ctrl+alt+'),
    ),
  );
  const offenders = outside.filter((r) => !sanctioned.includes(r));
  assert.deepEqual(
    offenders.map((r) => `${r.keys.join(' / ')} — ${r.what}`),
    [],
  );
  // And both sanctioned rows really ARE outside it (non-vacuity of the exemption).
  assert.deepEqual(
    outside.map((r) => r.what),
    ['paste the clipboard into the terminal', 'copy the selection'],
  );
});

test('the gesture flag really parses (non-vacuity: some rows carry it, some do not)', () => {
  // Without this, a regex that never sees `gesture: true` would silently make
  // the exemption below vacuous and let a real chord row through.
  assert.ok(ROWS.some((r) => r.gesture), 'no gesture row parsed at all');
  assert.ok(ROWS.some((r) => !r.gesture), 'every row parsed as a gesture — the flag is not being read');
  assert.equal(
    ROWS.find((r) => r.keys.includes('ctrl+shift+v'))?.gesture,
    false,
    'the paste row is a keyboard chord, not a gesture',
  );
});

test('the overlay lists the terminal-link gesture on exactly ONE row, and it is a gesture row', () => {
  const linkRows = ROWS.filter((r) => r.keys.some((k) => k.includes('click a link')));
  assert.equal(linkRows.length, 1, `expected one link row, found ${linkRows.length}`);
  const row = linkRows[0] as TableRow;
  assert.deepEqual(row.keys, ['ctrl+click a link']);
  assert.equal(row.what, 'open it in your browser');
  assert.equal(row.gesture, true, 'a mouse sentence must render as a gesture, not a <kbd> chip');
  // Explicitly OUT of the paste set the enumeration test owns.
  assert.equal(row.what.includes('paste'), false);
  assert.equal(pasteRows.includes(row), false);
});

test('the link row promises exactly what isLinkActivation does: ctrl (or meta) opens, a plain click does not', () => {
  const linkRow = ROWS.find((r) => r.keys.some((k) => k.includes('click a link'))) as TableRow;
  const mods = (text: string) => ({
    ctrlKey: text.split('+').includes('ctrl'),
    altKey: text.split('+').includes('alt'),
    metaKey: text.split('+').includes('meta'),
  });
  for (const text of linkRow.keys) {
    assert.equal(isLinkActivation(mods(text)), true, `the overlay promises ${text}`);
  }
  // The row's own claim is that the MODIFIER is what opens it — so the same
  // gesture without it must open nothing, or the row is a lie.
  assert.equal(isLinkActivation({ ctrlKey: false, altKey: false, metaKey: false }), false);
});

test('the paste and copy rows are the ONLY keyboard rows outside the ctrl+alt reservation — gestures are exempt by flag, not by luck', () => {
  // Same invariant as above, stated over the parsed `gesture` flag: a MOUSE
  // sentence beginning with `ctrl+` is not a key the app takes off the TUI.
  const sanctioned = [...pasteRows, ...copyRows];
  const offenders = ROWS.filter(
    (r) =>
      !r.gesture &&
      !sanctioned.includes(r) &&
      r.keys.some((k) => (k.startsWith('ctrl+') || k.startsWith('shift+')) && !k.startsWith('ctrl+alt+')),
  );
  assert.deepEqual(
    offenders.map((r) => `${r.keys.join(' / ')} — ${r.what}`),
    [],
  );
  // The one gesture row that starts with `ctrl+` is exempt by its flag — and it
  // must actually exist, or this test's exemption is untested.
  assert.ok(
    ROWS.some((r) => r.gesture && r.keys.some((k) => k.startsWith('ctrl+'))),
    'expected the ctrl+click gesture row to exercise the gesture exemption',
  );
});

// ---------------------------------------------------------------------------
// The copy row (2026-09-10)
// ---------------------------------------------------------------------------

test('the overlay lists the copy chords on exactly ONE row, and it lists exactly two', () => {
  assert.equal(copyRows.length, 1, `expected one copy row, found ${copyRows.length}`);
  const row = copyRows[0] as TableRow;
  assert.deepEqual(row.keys, ['ctrl+shift+c', 'ctrl+insert']);
  assert.equal(row.what, 'copy the selection');
  assert.equal(row.gesture, false, 'the copy row is a keyboard chord, not a gesture');
  // Not the paste row wearing a second label.
  assert.equal(pasteRows.includes(row), false);
});

test('every chord the overlay lists as a copy chord really IS one (isCopyChord accepts it)', () => {
  const row = copyRows[0] as TableRow;
  for (const text of row.keys) {
    assert.equal(isCopyChord(parseChord(text)), true, `the overlay promises ${text}`);
  }
});

test('the app takes NO copy chord the overlay does not list — the accepted set is the table', () => {
  // Same enumeration as the paste one: whatever isCopyChord accepts over the
  // whole space IS its vocabulary, and it must equal the row, both ways.
  const accepted = acceptedChords(isCopyChord);
  assert.ok(accepted.length >= 2, `the enumeration found only ${accepted.length} copy chords — vacuous`);
  assert.deepEqual(accepted, [...(copyRows[0] as TableRow).keys].sort());
  // Plain ctrl+c is ^C, the interrupt — it is never in the accepted set.
  assert.equal(accepted.includes('ctrl+c'), false);
});

test('no keystroke is both a paste chord and a copy chord (ctrl+insert copies, shift+insert pastes, both mods = neither)', () => {
  const paste = acceptedChords(isPasteChord);
  const copy = acceptedChords(isCopyChord);
  assert.deepEqual(
    paste.filter((c) => copy.includes(c)),
    [],
  );
  // The Insert pair, stated outright: one modifier each, never both.
  assert.ok(copy.includes('ctrl+insert') && !paste.includes('ctrl+insert'));
  assert.ok(paste.includes('shift+insert') && !copy.includes('shift+insert'));
  assert.equal(paste.includes('ctrl+shift+insert'), false);
  assert.equal(copy.includes('ctrl+shift+insert'), false);
});

test('the copy row answers the two things a terminal user must trust, on the row itself', () => {
  const src = readFileSync(SHORTCUTS, 'utf8');
  const row = /\{[^{}]*'ctrl\+shift\+c'[\s\S]*?\n  \}/.exec(src);
  assert.notEqual(row, null, 'the copy row must still be in the table');
  const note = /note:\s*'([^']*)'/.exec(row?.[0] ?? '');
  assert.notEqual(note, null, 'the copy row must carry a note explaining itself');
  const text = note?.[1] ?? '';
  assert.ok(text.includes('ctrl+c') && text.includes('interrupt'), `plain ctrl+c must still read as the interrupt: ${text}`);
  assert.ok(text.includes('nothing selected'), `the note must say the keys fall through with no selection: ${text}`);
  // And the footer no longer claims paste is the only other thing the app takes.
  assert.ok(src.includes('the paste and copy chords above are the only other keys the app takes'));
});
