/**
 * `web/src/ui/files-select-model.ts` — the pure rules behind A9b's folder
 * selection (user decisions 2026-09-16, `.claude/PLAN-A9B.md` §1, §2 and the
 * orchestrator defaults): what each gesture does to the selection, what the
 * selected folder is called, what the copy strip says about it, and whether a
 * `paste` event belongs to the app.
 *
 * WHY here and not in a DOM test: this is the half of the feature that decides
 * WHERE FILES GO. `takesPaste` in particular is the one predicate standing
 * between a clipboard and a folder the user did not point at, and between a
 * terminal and a paste it was supposed to keep — pinning it without a browser
 * means the panel, the drop layer and the dialog can all be rewired without
 * changing the answer.
 *
 * NOT claimed here (needs a browser,
 * `.claude/skills/verify-terminal/SKILL.md`): that a row is drawn selected,
 * that Escape reaches this module, that a paste is stopped from propagating,
 * or that a single byte is copied — nothing is, until part B10.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COPY_LABEL,
  afterEscape,
  afterMenuOpen,
  afterPanelHidden,
  afterRowActivate,
  copyIntoText,
  copyStripLabel,
  selectedName,
  takesPaste,
  type PasteContext,
  type Selection,
} from '../web/src/ui/files-select-model.ts';

/** Every string this module can build, for the sweeps at the bottom. */
const PRODUCED: string[] = [];
const say = (s: string): string => {
  PRODUCED.push(s);
  return s;
};

// ---------------------------------------------------------------------------
// The gestures
// ---------------------------------------------------------------------------

test('afterRowActivate: a folder row activation selects that path', () => {
  assert.equal(afterRowActivate(null, '/home/sava/projects/web'), '/home/sava/projects/web');
});

test('afterRowActivate: activating another row replaces the selection (single selection only)', () => {
  assert.equal(afterRowActivate('/home/sava/web', '/home/sava/server'), '/home/sava/server');
});

test('afterRowActivate: a RE-activation keeps the row selected — the toggle flips, the selection does not', () => {
  // User decision 1: one click selects the folder AND toggles it open/closed.
  // The toggle is the caller's second effect; clicking the same row twice must
  // not leave the copy strip with no destination to name.
  const sel = afterRowActivate(null, '/home/sava/web');
  assert.equal(afterRowActivate(sel, '/home/sava/web'), '/home/sava/web');
  assert.equal(afterRowActivate(afterRowActivate(sel, '/home/sava/web'), '/home/sava/web'), '/home/sava/web');
});

test('afterRowActivate: the activated path is the answer, whatever was selected before', () => {
  // A total function: the previous selection is READ BY NOTHING, so no state can
  // creep into the one gesture that decides where files land (mutation gate,
  // 2026-09-16 — a guard that answered `sel` for some paths survived otherwise).
  for (const sel of [null, '/home/sava/web', '/', ''] as Selection[]) {
    for (const path of ['/home/sava/server', '/home/sava/web', '/', '']) {
      assert.equal(afterRowActivate(sel, path), path, `${String(sel)} -> ${path}`);
    }
  }
});

test('afterMenuOpen: a context menu on a FOLDER row selects it (Explorer’s behaviour)', () => {
  assert.equal(afterMenuOpen(null, { dir: true, path: '/home/sava/web' }), '/home/sava/web');
  assert.equal(
    afterMenuOpen('/home/sava/server', { dir: true, path: '/home/sava/web' }),
    '/home/sava/web',
  );
});

test('afterMenuOpen: a context menu on a FILE row leaves the selection exactly as it was', () => {
  assert.equal(afterMenuOpen(null, { dir: false, path: '/home/sava/web/main.ts' }), null);
  assert.equal(
    afterMenuOpen('/home/sava/server', { dir: false, path: '/home/sava/web/main.ts' }),
    '/home/sava/server',
  );
});

test('afterEscape clears, from any state', () => {
  assert.equal(afterEscape('/home/sava/web'), null);
  assert.equal(afterEscape(null), null);
});

test('afterPanelHidden clears — a destination nobody can see must not take a paste from a terminal', () => {
  assert.equal(afterPanelHidden('/home/sava/web'), null);
  assert.equal(afterPanelHidden(null), null);
});

// ---------------------------------------------------------------------------
// selectedName — a PATH is selected, a NAME is printed
// ---------------------------------------------------------------------------

test('selectedName: the last segment of a nested path, and nothing else of it', () => {
  assert.equal(selectedName('/home/sava/projects/ai-cli-application/web/src'), 'src');
  assert.equal(selectedName('/home/sava/web'), 'web');
  assert.equal(selectedName('/home'), 'home');
  assert.equal(selectedName('src'), 'src');
  assert.equal(selectedName('web/src'), 'src');
  assert.equal(selectedName('/home/sava/Session Manager'), 'Session Manager');
});

test('selectedName: a trailing slash is not a segment', () => {
  assert.equal(selectedName('/home/sava/web/'), 'web');
  assert.equal(selectedName('/home/sava/web///'), 'web');
});

test('selectedName: a root path, an empty string and no selection have no name', () => {
  assert.equal(selectedName('/'), null);
  assert.equal(selectedName('//'), null);
  assert.equal(selectedName(''), null);
  assert.equal(selectedName(null), null);
});

// ---------------------------------------------------------------------------
// The copy strip's wording
// ---------------------------------------------------------------------------

test('COPY_LABEL is the A9 wording, unchanged, for "no folder chosen"', () => {
  assert.equal(say(COPY_LABEL), 'Copy files here…');
});

test('copyIntoText: byte-identical to what filedrop.ts produced before the move', () => {
  assert.equal(say(copyIntoText('src')), 'Copy files into src');
  assert.equal(say(copyIntoText('Home')), 'Copy files into Home');
  assert.equal(say(copyIntoText('Session Manager')), 'Copy files into Session Manager');
});

test('copyStripLabel: nothing selected says the constant', () => {
  assert.equal(say(copyStripLabel(null)), COPY_LABEL);
});

test('copyStripLabel: a selection is NAMED — the destination stops being invisible', () => {
  assert.equal(say(copyStripLabel('/home/sava/projects/web/src')), 'Copy files into src…');
  assert.equal(say(copyStripLabel('/home/sava/web')), 'Copy files into web…');
  assert.equal(say(copyStripLabel('Session Manager')), 'Copy files into Session Manager…');
});

test('copyStripLabel: the label and the title are ONE wording, the label merely trails off', () => {
  // `ui/files.ts` keeps the full sentence as the button's `title`; the visible
  // label is that sentence plus the ellipsis every "opens a chooser" control
  // in this app carries.
  assert.equal(copyStripLabel('/home/sava/web'), `${copyIntoText('web')}…`);
});

test('copyStripLabel: a selection that cannot be NAMED falls back to the constant (honesty rule)', () => {
  assert.equal(copyStripLabel('/'), COPY_LABEL);
  assert.equal(copyStripLabel(''), COPY_LABEL);
});

// ---------------------------------------------------------------------------
// takesPaste — the whole matrix, plus the four sentences of PLAN-A9B §2
// ---------------------------------------------------------------------------

const ctx = (o: Partial<PasteContext> = {}): PasteContext => ({
  files: false,
  selected: false,
  inTerminal: false,
  inEditable: false,
  modalOpen: false,
  ...o,
});

test('takesPaste: every one of the 32 contexts answers the frozen formula', () => {
  let taken = 0;
  for (let bits = 0; bits < 32; bits += 1) {
    const c = ctx({
      files: (bits & 1) !== 0,
      selected: (bits & 2) !== 0,
      inTerminal: (bits & 4) !== 0,
      inEditable: (bits & 8) !== 0,
      modalOpen: (bits & 16) !== 0,
    });
    // PLAN-A9B §2, verbatim:
    // takesPaste = files && !modalOpen && ( (!inTerminal && !inEditable) || selected )
    const expected =
      c.files && !c.modalOpen && ((!c.inTerminal && !c.inEditable) || c.selected);
    assert.equal(takesPaste(c), expected, JSON.stringify(c));
    if (expected) taken += 1;
  }
  // Non-vacuity: the matrix is not all-false (and not all-true either).
  // files=true and modalOpen=false leaves 8 contexts; 5 of them are ours (the
  // four with a selection, plus the one outside a terminal and a field).
  assert.equal(taken, 5);
});

test('takesPaste §2.1: a TEXT-ONLY clipboard is never ours — a terminal loses no paste to this rule', () => {
  assert.equal(takesPaste(ctx({ inTerminal: true })), false);
  assert.equal(takesPaste(ctx({ inTerminal: true, selected: true })), false);
  assert.equal(takesPaste(ctx({ inEditable: true, selected: true })), false);
  assert.equal(takesPaste(ctx({ selected: true })), false);
  assert.equal(takesPaste(ctx()), false);
});

test('takesPaste §2.2: FILES plus a SELECTED folder is taken from anywhere, a terminal included', () => {
  assert.equal(takesPaste(ctx({ files: true, selected: true, inTerminal: true })), true);
  assert.equal(takesPaste(ctx({ files: true, selected: true, inEditable: true })), true);
  assert.equal(takesPaste(ctx({ files: true, selected: true })), true);
});

test('takesPaste §2.3: FILES with NO selection is the A9 rule exactly', () => {
  // Outside a terminal and outside a field: the fallback chain answers.
  assert.equal(takesPaste(ctx({ files: true })), true);
  // Inside one: the app does nothing at all rather than pick a folder nobody
  // pointed at.
  assert.equal(takesPaste(ctx({ files: true, inTerminal: true })), false);
  assert.equal(takesPaste(ctx({ files: true, inEditable: true })), false);
});

test('takesPaste §2.4: a modal up means NOTHING in the window takes a paste', () => {
  assert.equal(takesPaste(ctx({ files: true, modalOpen: true })), false);
  assert.equal(takesPaste(ctx({ files: true, selected: true, modalOpen: true })), false);
  assert.equal(
    takesPaste(ctx({ files: true, selected: true, inTerminal: true, modalOpen: true })),
    false,
  );
});

test('takesPaste: the SELECTION is what extends the reach — the same context flips on it alone', () => {
  const inTerm = ctx({ files: true, inTerminal: true });
  assert.equal(takesPaste(inTerm), false);
  assert.equal(takesPaste({ ...inTerm, selected: true }), true);
});

// ---------------------------------------------------------------------------
// Copy rules over everything this module can build
// ---------------------------------------------------------------------------

test('no produced string carries a path separator, however deep the selected path is', () => {
  const paths: Selection[] = [
    null,
    '/',
    '',
    '/home/sava/projects/ai-cli-application/web/src/ui',
    '/home/sava/Session Manager/',
  ];
  const strings = [...PRODUCED];
  for (const p of paths) {
    strings.push(copyStripLabel(p));
    const name = selectedName(p);
    if (name !== null) strings.push(name, copyIntoText(name));
  }
  const offenders = strings.filter((s) => s.includes('/'));
  assert.deepEqual(offenders, [], 'a path never reaches a label (PROJECT-SCOPE, 2026-07-25)');
  assert.ok(strings.length >= 14, `non-vacuity: only ${strings.length} strings swept`);
});

test('no decorative separator reaches any produced string (README-v3 copy rules)', () => {
  const offenders = PRODUCED.filter(
    (s) => s.includes(' — ') || s.includes(' · ') || s.includes(' | ') || s.includes('⎿'),
  );
  assert.deepEqual(offenders, [], 'produced copy carries no decorative separators');
  assert.ok(PRODUCED.length >= 8, `only ${PRODUCED.length} strings collected`);
});
