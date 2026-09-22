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
  /**
   * The third column: where the SAME thing lives in the UI, or the keyboard
   * twin of a mouse gesture. Parsed since B10a, because a gesture row whose
   * twin column is empty is a control that exists only under a pointer.
   */
  ui: string;
  /** The one-line caption under the row, for the rows that carry one. */
  note: string | null;
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
  const rowRe =
    /\{\s*keys:\s*\[([^\]]*)\]([^}]*?)what:\s*(['"])((?:\\.|(?!\3).)*)\3([^}]*)/g;
  for (const m = { v: rowRe.exec(block) }; m.v !== null; m.v = rowRe.exec(block)) {
    const keys = [...(m.v[1] ?? '').matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)].map((k) => k[2] as string);
    const tail = m.v[5] ?? '';
    const read = (field: string): string | null => {
      const hit = new RegExp(`${field}:\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1`).exec(tail);
      return hit === null ? null : (hit[2] as string);
    };
    out.push({
      keys,
      gesture: (m.v[2] ?? '').includes('gesture: true'),
      what: m.v[4] as string,
      ui: read('ui') ?? '',
      note: read('note'),
    });
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
// KEYBOARD rows only: since A9 a GESTURE row says `copy them into that folder`
// (dragging files in from Explorer), which is an act, not a chord — the two
// rows these lists are about are the ones that take a keystroke off the TUI.
const pasteRows = ROWS.filter((r) => !r.gesture && r.what.includes('paste'));
const copyRows = ROWS.filter((r) => !r.gesture && r.what.includes('copy'));
/**
 * The THIRD sanctioned row outside the ctrl+alt reservation (part B4,
 * 2026-09-22): ctrl+s saves the file the keyboard is in. It differs from paste
 * and copy in the way that makes it safe, and that difference is asserted
 * below rather than assumed: it is handled by the FIELD (`ui/file-pane.ts`),
 * not by the window, and it is deliberately NOT in the terminal's allow-list —
 * a focused terminal keeps its own ctrl+s (XOFF).
 */
const saveRows = ROWS.filter((r) => !r.gesture && r.keys.includes('ctrl+s'));

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
  // The `ui` and `note` columns really parse (B10a added both to this reader):
  // a silent '' would make every claim about a keyboard twin vacuous.
  assert.ok(ROWS.every((r) => r.ui !== ''), `a row with no UI twin: ${ROWS.find((r) => r.ui === '')?.what}`);
  assert.ok(ROWS.some((r) => r.note !== null), 'no caption parsed at all');
  assert.ok(ROWS.some((r) => r.note === null), 'every row parsed as captioned — the field is not being read');
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
  const sanctioned = [...saveRows, ...pasteRows, ...copyRows];
  assert.equal(sanctioned.length, 3, 'the exemption must name exactly the save, paste and copy rows');
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
    [
      'save the file you are typing in',
      'paste the clipboard into the terminal',
      'copy the selection',
    ],
  );
});

test('the overlay lists the two Files-panel selection gestures and the Delete key (B10a)', () => {
  // A selection you can only build with a pointer would break this project's
  // "no control exists only under a pointer" rule, so the row that lists the
  // two mouse gestures MUST name their keyboard twins in the `ui` column.
  const sel = ROWS.filter((r) => r.keys.includes('ctrl+click a row'));
  assert.equal(sel.length, 1, `expected one selection row, found ${sel.length}`);
  const row = sel[0] as TableRow;
  assert.deepEqual(row.keys, ['ctrl+click a row', 'shift+click a row']);
  assert.equal(row.gesture, true, 'a mouse sentence must render as a gesture, not a <kbd> chip');
  assert.equal(row.what, 'add one row to the selection, or select the range');
  assert.equal(row.ui, 'ctrl+space on the focused row, or shift+↑↓');

  // The Delete key, with the one sentence the overlay OWES the reader: there
  // is no undo and no recycle bin behind this key.
  const del = ROWS.filter((r) => r.keys.includes('delete'));
  assert.equal(del.length, 1, `expected one delete row, found ${del.length}`);
  const d = del[0] as TableRow;
  assert.equal(d.gesture, false, 'a key is a chip, not a sentence');
  assert.equal(d.what, 'delete the selected rows for good');
  assert.equal(d.ui, 'Delete in the row menu', 'the same act has a visible control');
  assert.equal(
    d.note,
    'There is no undo and nothing goes to a recycle bin; the app asks once first.',
  );
  // It takes no modifier, so it is outside the ctrl+alt reservation only in
  // the way a single non-printing key is — like esc.
  assert.equal(d.keys.length, 1);
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
  const sanctioned = [...saveRows, ...pasteRows, ...copyRows];
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
  assert.ok(
    src.includes('the paste and copy chords above are the only other keys the app takes anywhere'),
    'the footer must still name the two chords the app takes EVERYWHERE',
  );
});

// ---------------------------------------------------------------------------
// The ctrl+alt reservation, three ways (Nocturne A10)
// ---------------------------------------------------------------------------
//
// A ctrl+alt chord only works if THREE files agree, and two of them are easy to
// forget:
//
//   1. someone handles it — `web/src/main.ts`'s window handler, or the module
//      that owns it (`web/src/ui/files.ts` owns ctrl+alt+enter, because it acts
//      on the Files row that has the focus);
//   2. `web/src/ui/terminal.ts` lets it THROUGH — xterm's custom key handler
//      swallows every ctrl+alt chord it does not allow-list, so a focused
//      terminal would eat the chord and print its bytes instead. TWO chords are
//      exempt, both of them Files-ROW chords: ctrl+alt+enter (open the file
//      beside the focused pane) and ctrl+alt+c (copy files into the focused
//      FOLDER row, A9). A row cannot hold the focus while a terminal does, so
//      allow-listing either would take a key away from the PTY for nothing;
//   3. this overlay LISTS it — the app's only promise about which keystrokes
//      it takes. A row-level chord may be listed in the `ui` (twin) column of
//      the gesture it doubles — that is where ctrl+alt+c lives, beside the
//      Explorer drop it replaces — so the scan reads that column too.
//
// A10 added two chords (ctrl+alt+w, ctrl+alt+enter) and the first of them is
// handled in main.ts while the second is not, so the scan reads both files;
// A9 added ctrl+alt+c on a folder row, so files.ts now owns TWO of them.
// A9b brief 2 added a THIRD row-level keydown handler — the context-menu chord
// (the ContextMenu key, or shift+F10) — which is deliberately NOT on ctrl+alt:
// it is the keyboard twin of a right-click, every desktop app answers those two
// keys, and `ui/keys.ts` isContextMenuChord rejects ctrl, alt, meta and AltGr.
// It therefore adds nothing to the vocabulary this file reconciles, and needs
// no seat in the terminal allow-list.

const MAIN_TS = join(REPO_ROOT, 'web', 'src', 'main.ts');
const FILES_TS = join(REPO_ROOT, 'web', 'src', 'ui', 'files.ts');
const TERMINAL_TS = join(REPO_ROOT, 'web', 'src', 'ui', 'terminal.ts');

/**
 * The chord vocabulary of a block of code, as table spellings. `Arrow*` is one
 * entry (`←↑↓→`), `1`..`9` is one (`1…9`), and the PageUp/PageDown pair is one
 * (`pgup/pgdn`) — exactly the way the overlay writes them.
 */
function chordsIn(src: string): string[] {
  const out = new Set<string>();
  if (/k\.startsWith\('Arrow'\)|k === 'ArrowLeft'/.test(src)) out.add('←↑↓→');
  if (/k >= '1' && k <= '9'/.test(src)) out.add('1…9');
  if (/k === 'PageUp'/.test(src)) out.add('pgup/pgdn');
  for (const m of src.matchAll(/k === '([^']+)'|e\.key !== '([^']+)'/g)) {
    const k = (m[1] ?? m[2]) as string;
    if (k.startsWith('Arrow') || k === 'PageUp' || k === 'PageDown') continue;
    if (k.length === 1 && k >= '1' && k <= '9') continue;
    out.add(k.toLowerCase());
  }
  return [...out].sort();
}

/** The `ctrl && alt` block of main.ts's window keydown handler. */
function mainChordBlock(): string {
  const src = readFileSync(MAIN_TS, 'utf8');
  const from = src.indexOf("if (e.ctrlKey && e.altKey && !e.metaKey");
  assert.notEqual(from, -1, 'non-vacuity: main.ts must still reserve ctrl+alt');
  const to = src.indexOf("if (e.key === '?'", from);
  assert.notEqual(to, -1, 'non-vacuity: the end of the block was not found');
  return src.slice(from, to);
}

/** xterm's ctrl+alt passthrough allow-list in ui/terminal.ts. */
function terminalAllowlist(): string {
  const src = readFileSync(TERMINAL_TS, 'utf8');
  const from = src.indexOf('e.ctrlKey &&\n        e.altKey &&');
  assert.notEqual(from, -1, 'non-vacuity: the ctrl+alt branch of the key handler was not found');
  const to = src.indexOf('return true;', from);
  assert.notEqual(to, -1);
  return src.slice(from, to);
}

/**
 * ui/files.ts owns ctrl+alt+enter on a file row, ctrl+alt+c on a folder row,
 * and (A9b) the context-menu chord on both.
 */
function filesChordBlock(): string {
  const src = readFileSync(FILES_TS, 'utf8');
  const blocks: string[] = [];
  // EVERY row-level handler, not just the first: the folder row's chord was
  // added above the file row's, and a scan that read one block would have
  // silently stopped seeing the other.
  for (let i = src.indexOf("b.addEventListener('keydown'"); i !== -1; i = src.indexOf("b.addEventListener('keydown'", i + 1)) {
    blocks.push(src.slice(i, i + 600));
  }
  assert.equal(blocks.length, 3, `non-vacuity: the Files rows own three chords, parsed ${blocks.length}`);
  return blocks.join('\n');
}

test('the app HANDLES exactly the ctrl+alt chords the overlay lists — no more, no fewer', () => {
  const handled = new Set([...chordsIn(mainChordBlock()), ...chordsIn(filesChordBlock())]);
  assert.ok(handled.size >= 6, `non-vacuity: parsed ${[...handled].join(' ')}`);
  // Everything the table promises on ctrl+alt, as the same vocabulary. The
  // twin column counts as a promise: a chord that acts on a focused ROW has no
  // chord row of its own (it is the keyboard half of a gesture), and
  // ctrl+alt+c is listed exactly there.
  const listed = new Set(
    [
      ...ROWS.filter((r) => !r.gesture).flatMap((r) => r.keys),
      ...[...readFileSync(SHORTCUTS, 'utf8').matchAll(/ui: '([^']*)'/g)].flatMap((m) =>
        [...(m[1] ?? '').matchAll(/\bctrl\+alt\+([a-z]+)\b/g)]
          .map((c) => c[0])
          // `ctrl+alt+shift+…` twins are named on their own chord rows; this
          // column only has to answer for chords that have no row of their own.
          .filter((c) => !c.endsWith('+shift')),
      ),
    ]
      .filter((k) => k.startsWith('ctrl+alt+'))
      .map((k) => k.replace(/^ctrl\+alt\+(shift\+)?/, '')),
  );
  assert.ok(listed.has('c'), 'non-vacuity: the twin column really was read');
  assert.deepEqual(
    [...handled].filter((k) => !listed.has(k)).sort(),
    [],
    'a chord the app takes but the overlay does not list is an undiscoverable key',
  );
  assert.deepEqual(
    [...listed].filter((k) => !handled.has(k)).sort(),
    [],
    'a chord the overlay promises but nothing handles is a lie',
  );
});

test('every chord the app handles is also let THROUGH by the terminal allow-list', () => {
  // The bug this catches is invisible in every other test: a focused terminal
  // eats the chord and the TUI receives its bytes.
  const allow = terminalAllowlist();
  const allowed = new Set(chordsIn(allow));
  const handled = new Set([...chordsIn(mainChordBlock()), ...chordsIn(filesChordBlock())]);
  assert.ok(allowed.size >= 6, `non-vacuity: parsed ${[...allowed].join(' ')}`);
  // The exemptions: both act on a focused Files ROW — ctrl+alt+enter on a file
  // row, ctrl+alt+c on a folder row (A9: copy files into THAT folder) — and a
  // row can never have the focus while a terminal has it, so the allow-list
  // taking either would swallow a key for nothing instead of leaving it to the
  // PTY.
  const EXEMPT = new Set(['enter', 'c']);
  assert.deepEqual(
    [...handled].filter((k) => !allowed.has(k) && !EXEMPT.has(k)).sort(),
    [],
    'a chord the terminal swallows never reaches the app',
  );
  // A10's two new chords, named outright — the whole reason this test exists.
  assert.ok(allowed.has('w'), 'ctrl+alt+w must pass the terminal');
  assert.equal(
    allowed.has('enter'),
    false,
    'ctrl+alt+enter is a Files-row chord: a focused terminal has nothing to do with it',
  );
  assert.equal(
    allowed.has('c'),
    false,
    'ctrl+alt+c is a Files folder-row chord: a focused terminal has nothing to do with it',
  );
  // And the allow-list takes nothing the app does not handle: every key it
  // lets through is a key the terminal no longer gets.
  assert.deepEqual(
    [...allowed].filter((k) => !handled.has(k)).sort(),
    [],
    'the terminal must not give up a key nothing acts on',
  );
});

test('the two A10 chords are on the table, each on one row, with a control beside it', () => {
  for (const chord of ['ctrl+alt+enter', 'ctrl+alt+w']) {
    const rows = ROWS.filter((r) => r.keys.includes(chord));
    assert.equal(rows.length, 1, `expected one row for ${chord}, found ${rows.length}`);
    assert.equal((rows[0] as TableRow).gesture, false, `${chord} is a chord, not a gesture`);
  }
});

test('EVERY gesture row names its twin: a chord, or a control the user can see', () => {
  // PROJECT-SCOPE: no control may exist only under a pointer. A drag row whose
  // right-hand column said nothing would be exactly that.
  const src = readFileSync(SHORTCUTS, 'utf8');
  const start = src.indexOf('const ROWS');
  const block = src.slice(start, src.indexOf('\n];', start));
  const uis = [...block.matchAll(/\{\s*keys:\s*\[([^\]]*)\][^}]*?gesture:\s*true[^}]*?ui:\s*(['"])((?:\\.|(?!\2).)*)\2/g)];
  assert.ok(uis.length >= 5, `non-vacuity: parsed ${uis.length} gesture rows`);
  assert.equal(uis.length, ROWS.filter((r) => r.gesture).length, 'every gesture row was parsed');
  for (const m of uis) {
    const ui = (m[3] ?? '').trim();
    assert.notEqual(ui, '', `a gesture with no twin: ${m[1] ?? ''}`);
  }
  // The three A10 drags each name a KEYBOARD twin, not just "somewhere else".
  const twinOf = (k: string): string =>
    (ROWS.find((r) => r.gesture && r.keys.includes(k)) as TableRow | undefined) === undefined
      ? ''
      : (block.match(new RegExp(`keys: \\['${k.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}'\\][^}]*?ui: '([^']*)'`))?.[1] ?? '');
  assert.equal(twinOf('drag a file row onto a pane edge'), 'ctrl+alt+enter');
  assert.equal(twinOf('drag a pane header onto another pane'), 'ctrl+alt+shift+←↑↓→');
  assert.equal(twinOf('drag a tab along the strip'), 'ctrl+alt+shift+pgup/pgdn');
});

// ---------------------------------------------------------------------------
// The file-tab chords (Nocturne A10b)
// ---------------------------------------------------------------------------

test('the three A10b chords are on the table, each on exactly one row, each with a control', () => {
  for (const chord of ['ctrl+alt+pgup/pgdn', 'ctrl+alt+m', 'ctrl+alt+w']) {
    const rows = ROWS.filter((r) => r.keys.includes(chord));
    assert.equal(rows.length, 1, `expected one row for ${chord}, found ${rows.length}`);
    assert.equal((rows[0] as TableRow).gesture, false, `${chord} is a chord, not a gesture`);
  }
  // The unshifted pair and the shifted pair are two different chords on the
  // same keys, and the table must say which is which.
  const cycle = ROWS.find((r) => r.keys.includes('ctrl+alt+pgup/pgdn')) as TableRow;
  const reorder = ROWS.find((r) => r.keys.includes('ctrl+alt+shift+pgup/pgdn')) as TableRow;
  assert.match(cycle.what, /file tab/, cycle.what);
  assert.match(reorder.what, /tab left \/ right/, reorder.what);
  // ctrl+alt+w closes a TAB since A10b, and its last tab takes the pane.
  const close = ROWS.find((r) => r.keys.includes('ctrl+alt+w')) as TableRow;
  assert.match(close.what, /active file tab/, close.what);
  assert.match(close.what, /closes its pane/, close.what);
});

test('main.ts tests the SHIFTED pgup/pgdn branch before the unshifted one', () => {
  // They are the same two keys. If the unshifted branch came first it would
  // swallow the reorder chord, and the tab-strip drag would lose its twin —
  // with every other test in this file still green.
  const block = mainChordBlock();
  const shifted = block.indexOf("(k === 'PageUp' || k === 'PageDown') && e.shiftKey");
  const plain = block.indexOf("} else if (k === 'PageUp' || k === 'PageDown') {");
  assert.notEqual(shifted, -1, 'non-vacuity: the reorder branch was not found');
  assert.notEqual(plain, -1, 'non-vacuity: the tab-cycle branch was not found');
  assert.ok(shifted < plain, 'the shifted branch must be tested first');
  // …and it must still be REACHABLE: a qualifier bolted onto that condition
  // would drop every shift+pgup/pgdn into the tab-cycle branch below it, with
  // the order above still green.
  assert.match(
    block,
    /\} else if \(\(k === 'PageUp' \|\| k === 'PageDown'\) && e\.shiftKey\) \{/,
    'the reorder branch takes the two keys and the shift, and nothing else',
  );
  // And both act: one moves the TAB, the other the file tab inside a pane.
  assert.match(block, /moveActiveViewBy/);
  assert.match(block, /cycleTab/);
  // ctrl+alt+m moves the active tab, and falls back to a split.
  assert.match(block, /moveTabToSplit/);
  // ctrl+alt+w closes the TAB, not the pane (A10b).
  assert.match(block, /closeActiveTabGuarded\(/);
  assert.equal(/st\.closeSlot\(/.test(block), false, 'the chord closes a tab now, not a whole pane');
});

test('the terminal allow-list passes pgup/pgdn UNQUALIFIED, and m with it', () => {
  // The A10 allow-list took pgup/pgdn only WITH shift. The unshifted pair is
  // an app chord now, so the qualifier has to be gone — otherwise a focused
  // terminal eats the tab switch and prints its bytes instead.
  const allow = terminalAllowlist();
  assert.match(allow, /k === 'PageUp' \|\|\n\s*k === 'PageDown'/);
  assert.equal(
    /e\.shiftKey && \(k === 'PageUp'/.test(allow),
    false,
    'a shift qualifier would leave the unshifted chord to the PTY',
  );
  assert.match(allow, /k === 'm' \|\|\n\s*k === 'M'/);
});

test('the two file-tab drags each name ctrl+alt+m, and the file-row drop names the click', () => {
  const src = readFileSync(SHORTCUTS, 'utf8');
  const block = src.slice(src.indexOf('const ROWS'), src.indexOf('\n];', src.indexOf('const ROWS')));
  const twinOf = (k: string): string =>
    block.match(new RegExp(`keys: \\['${k}'\\][^}]*?ui: '([^']*)'`))?.[1] ?? '';
  assert.equal(twinOf('drag a file tab onto a pane edge'), 'ctrl+alt+m');
  assert.equal(twinOf('drag a file tab onto another editor pane'), 'ctrl+alt+m');
  assert.equal(twinOf('drag a file row onto an editor pane'), 'click the row');
  // The gesture that A10b replaced must be gone: a centre drop ADDS a tab now.
  assert.equal(src.includes('replace that file with the dropped one'), false);
  for (const g of [
    'drag a file tab onto a pane edge',
    'drag a file tab onto another editor pane',
    'drag a file row onto an editor pane',
  ]) {
    assert.equal(
      (ROWS.find((r) => r.keys.includes(g)) as TableRow).gesture,
      true,
      `${g} is a mouse sentence, not a chip`,
    );
  }
});

test('the swap row is about a PANE now, not about a session (A10 made it kind-blind)', () => {
  const row = ROWS.find((r) => r.keys.includes('ctrl+alt+shift+←↑↓→')) as TableRow;
  assert.equal(row.what, 'move the focused pane (swap)');
  assert.equal(
    readFileSync(SHORTCUTS, 'utf8').includes('move session between panes'),
    false,
    'a file pane swaps with a terminal, so the old wording is no longer true',
  );
});

// ---------------------------------------------------------------------------
// The save chord (part B4, 2026-09-22)
// ---------------------------------------------------------------------------

test('ctrl+s is listed on exactly ONE row, with the control it doubles and the reason it is safe', () => {
  assert.equal(saveRows.length, 1, `expected one save row, found ${saveRows.length}`);
  const row = saveRows[0] as TableRow;
  assert.deepEqual(row.keys, ['ctrl+s']);
  assert.equal(row.gesture, false, 'a key is a chip, not a sentence');
  assert.equal(row.what, 'save the file you are typing in');
  assert.equal(row.ui, 'Save under the text', 'the same act has a visible control');
  // The note is load-bearing: it is the reason a chord outside ctrl+alt does
  // not break the project's keyboard rule.
  assert.equal(
    row.note,
    'These keys act only while the keyboard is in a file, so a terminal still receives them.',
  );
  assert.ok((row.note ?? '').includes('terminal'));
  // Not the paste or copy row wearing a second label.
  assert.equal(pasteRows.includes(row), false);
  assert.equal(copyRows.includes(row), false);
});

test('ctrl+s is handled by the FIELD, not by the window — and the terminal never gives it up', () => {
  // THE WHOLE REASON THE ROW IS ALLOWED. A window-level ctrl+s would take the
  // key from every pane, including a terminal, where ctrl+s is XOFF and
  // belongs to the program (PROJECT-SCOPE's keyboard rule). So:
  //   1. no window handler claims it,
  //   2. the textarea of a file body does,
  //   3. the terminal allow-list does NOT mention it — a key in that list that
  //      nothing acts on is a key stolen from the PTY.
  const main = readFileSync(MAIN_TS, 'utf8');
  assert.equal(/'s'\s*\|\||k === 's'/.test(mainChordBlock()), false, 'not an app chord');
  assert.equal(/key === 's'/.test(main), false, "main.ts must not claim the field's key");

  const filePane = readFileSync(join(REPO_ROOT, 'web', 'src', 'ui', 'file-pane.ts'), 'utf8');
  assert.match(filePane, /ta\.addEventListener\('keydown'/, 'the FIELD listens');
  assert.match(filePane, /e\.key !== 's' && e\.key !== 'S'/, 'and it is this chord it acts on');
  assert.match(filePane, /e\.preventDefault\(\)/, "the browser's own save dialog must not open");

  const allow = terminalAllowlist();
  assert.equal(/'s'/.test(allow), false, 'a focused terminal keeps ctrl+s: it is XOFF');
});
