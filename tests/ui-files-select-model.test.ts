/**
 * `web/src/ui/files-select-model.ts` — the pure rules behind B10a's MULTI
 * selection (user decision 2026-09-20,
 * `memory/decisions/b10a-multi-select-and-delete.md`) and the A9b rules it
 * kept: what each gesture does to the selection, where files land, what the
 * destination is called, what the copy strip says about it, and whether a
 * `paste` event belongs to the app.
 *
 * WHY here and not in a DOM test: this is the half of the feature that decides
 * WHERE FILES GO and WHICH ROWS AN ACT IS ABOUT. `takesPaste` in particular is
 * the one predicate standing between a clipboard and a folder the user did not
 * point at, and between a terminal and a paste it was supposed to keep —
 * pinning it without a browser means the panel, the drop layer and the dialog
 * can all be rewired without changing the answer.
 *
 * NOT claimed here (needs a browser,
 * `.claude/skills/verify-terminal/SKILL.md`): that a row is drawn selected,
 * that ctrl+click reaches this module, that Escape is stopped, or that one
 * byte is copied or deleted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COPY_LABEL,
  EMPTY,
  afterEscape,
  afterMenuOpen,
  afterPanelHidden,
  afterRange,
  afterRowActivate,
  afterSelectAll,
  afterToggle,
  copyIntoText,
  copyStripLabel,
  destinationPath,
  isSelected,
  keyIsDir,
  keyPath,
  prunedTo,
  selectedName,
  size,
  takesPaste,
  without,
  type PasteContext,
  type Selection,
} from '../web/src/ui/files-select-model.ts';

/** Every string this module can build, for the sweeps at the bottom. */
const PRODUCED: string[] = [];
const say = (s: string): string => {
  PRODUCED.push(s);
  return s;
};

const d = (path: string): string => `fdir:${path}`;
const f = (path: string): string => `ffile:${path}`;
/** The selection as a sorted array, so a set comparison reads as one line. */
const keys = (sel: Selection): string[] => [...sel.keys].sort();

const ROOT = '/home/you/projects/app';
/** One plausible screen, in tree order (an ancestor before its children). */
const VISIBLE = [
  d(`${ROOT}/web`),
  d(`${ROOT}/web/src`),
  f(`${ROOT}/web/src/main.ts`),
  f(`${ROOT}/web/index.html`),
  d(`${ROOT}/server`),
  f(`${ROOT}/README.md`),
];

// ---------------------------------------------------------------------------
// The value itself
// ---------------------------------------------------------------------------

test('EMPTY is empty and anchorless, and stays that way after every transition', () => {
  assert.equal(size(EMPTY), 0);
  assert.equal(EMPTY.anchor, null);
  const sel = afterToggle(afterRowActivate(EMPTY, d('/a')), f('/b'));
  assert.equal(size(EMPTY), 0, 'a transition may not mutate the value it was handed');
  assert.equal(size(sel), 2);
});

test('keyPath / keyIsDir read the tree’s own identity, and refuse anything else', () => {
  assert.equal(keyPath(d('/home/you/web')), '/home/you/web');
  assert.equal(keyPath(f('/home/you/web/main.ts')), '/home/you/web/main.ts');
  assert.equal(keyIsDir(d('/home/you/web')), true);
  assert.equal(keyIsDir(f('/home/you/web/main.ts')), false);
  // A STATE row (`Loading…`, a refusal, a name row) is not a tree row: no path.
  for (const k of ['floading', 'fcopy', 'fnew', '', '/home/you/web', 'fdirX:/a']) {
    assert.equal(keyPath(k), '', k);
    assert.equal(keyIsDir(k), false, k);
  }
});

test('isSelected / size read the set, and nothing near it', () => {
  const sel = afterToggle(afterRowActivate(EMPTY, d('/a')), f('/b'));
  assert.equal(isSelected(sel, d('/a')), true);
  assert.equal(isSelected(sel, f('/b')), true);
  assert.equal(isSelected(sel, f('/a')), false, 'a file key is not its folder key');
  assert.equal(isSelected(sel, d('/a/b')), false);
  assert.equal(size(sel), 2);
});

// ---------------------------------------------------------------------------
// The transition table
// ---------------------------------------------------------------------------

test('afterRowActivate: THIS ROW ALONE, and it becomes the anchor', () => {
  const one = afterRowActivate(EMPTY, d(`${ROOT}/web`));
  assert.deepEqual(keys(one), [d(`${ROOT}/web`)]);
  assert.equal(one.anchor, d(`${ROOT}/web`));

  // Whatever was selected before is thrown away — a plain click is the escape
  // hatch out of a multi-selection.
  const many = afterSelectAll(EMPTY, VISIBLE);
  const after = afterRowActivate(many, f(`${ROOT}/README.md`));
  assert.deepEqual(keys(after), [f(`${ROOT}/README.md`)]);
  assert.equal(after.anchor, f(`${ROOT}/README.md`));
});

test('afterRowActivate: a RE-activation keeps the row selected — the toggle flips, the selection does not', () => {
  const once = afterRowActivate(EMPTY, d(`${ROOT}/web`));
  const twice = afterRowActivate(once, d(`${ROOT}/web`));
  assert.deepEqual(keys(twice), [d(`${ROOT}/web`)]);
  assert.equal(twice.anchor, d(`${ROOT}/web`));
});

test('afterRowActivate: a FILE row selects too (B10a widened A9b’s folders-only rule)', () => {
  const sel = afterRowActivate(EMPTY, f(`${ROOT}/README.md`));
  assert.deepEqual(keys(sel), [f(`${ROOT}/README.md`)]);
  assert.equal(sel.anchor, f(`${ROOT}/README.md`));
});

test('afterToggle: a row goes IN, the rest is untouched, and the anchor moves to it', () => {
  const a = afterRowActivate(EMPTY, d(`${ROOT}/web`));
  const b = afterToggle(a, f(`${ROOT}/README.md`));
  assert.deepEqual(keys(b), [d(`${ROOT}/web`), f(`${ROOT}/README.md`)].sort());
  assert.equal(b.anchor, f(`${ROOT}/README.md`));
  const c = afterToggle(b, d(`${ROOT}/server`));
  assert.equal(size(c), 3);
  assert.equal(c.anchor, d(`${ROOT}/server`));
});

test('afterToggle: a row goes OUT, and the anchor moves to it even so', () => {
  const b = afterToggle(afterRowActivate(EMPTY, d(`${ROOT}/web`)), f(`${ROOT}/README.md`));
  const out = afterToggle(b, d(`${ROOT}/web`));
  assert.deepEqual(keys(out), [f(`${ROOT}/README.md`)]);
  assert.equal(out.anchor, d(`${ROOT}/web`), 'the anchor is where the hand is, in or out');
  // …so the next range measures from the row that just left.
  assert.equal(destinationPath(out), `${ROOT}/web`);
});

test('afterToggle: in, out, in again ends where it started', () => {
  const base = afterRowActivate(EMPTY, d(`${ROOT}/web`));
  const once = afterToggle(base, f(`${ROOT}/README.md`));
  const back = afterToggle(once, f(`${ROOT}/README.md`));
  const again = afterToggle(back, f(`${ROOT}/README.md`));
  assert.deepEqual(keys(back), [d(`${ROOT}/web`)]);
  assert.deepEqual(keys(again), keys(once));
});

test('afterRange: the anchor..key run over `visible`, REPLACING the selection', () => {
  const anchored = afterRowActivate(EMPTY, d(`${ROOT}/web/src`));
  const ranged = afterRange(anchored, d(`${ROOT}/server`), VISIBLE);
  // VISIBLE[1..4]: a folder, its child file, a sibling file one level up, a
  // folder again — a range spans depths, because the screen does.
  assert.deepEqual([...ranged.keys], VISIBLE.slice(1, 5));
  assert.equal(size(ranged), 4);
  assert.equal(ranged.anchor, d(`${ROOT}/web/src`), 'the anchor STAYS where it was');
});

test('afterRange: REPLACES — rows chosen before the range are not kept', () => {
  const withExtra = afterToggle(afterRowActivate(EMPTY, f(`${ROOT}/README.md`)), d(`${ROOT}/web`));
  const ranged = afterRange(withExtra, d(`${ROOT}/web/src`), VISIBLE);
  assert.deepEqual(keys(ranged), [d(`${ROOT}/web`), d(`${ROOT}/web/src`)].sort());
  assert.equal(isSelected(ranged, f(`${ROOT}/README.md`)), false);
});

test('afterRange: BACKWARDS is the same run — the order of the two ends means nothing', () => {
  const down = afterRange(afterRowActivate(EMPTY, d(`${ROOT}/web`)), d(`${ROOT}/server`), VISIBLE);
  const up = afterRange(afterRowActivate(EMPTY, d(`${ROOT}/server`)), d(`${ROOT}/web`), VISIBLE);
  assert.deepEqual(keys(down), keys(up));
  assert.equal(size(down), 5);
  assert.equal(down.anchor, d(`${ROOT}/web`));
  assert.equal(up.anchor, d(`${ROOT}/server`), 'each keeps its OWN anchor');
});

test('afterRange: a range of one row is that row', () => {
  const anchored = afterRowActivate(EMPTY, d(`${ROOT}/web`));
  const same = afterRange(anchored, d(`${ROOT}/web`), VISIBLE);
  assert.deepEqual(keys(same), [d(`${ROOT}/web`)]);
  assert.equal(same.anchor, d(`${ROOT}/web`));
});

test('afterRange: a second shift-click RE-MEASURES from the same anchor, it does not grow', () => {
  const anchored = afterRowActivate(EMPTY, d(`${ROOT}/web/src`));
  const wide = afterRange(anchored, f(`${ROOT}/README.md`), VISIBLE);
  assert.equal(size(wide), 5);
  const narrow = afterRange(wide, f(`${ROOT}/web/src/main.ts`), VISIBLE);
  assert.deepEqual(keys(narrow), [d(`${ROOT}/web/src`), f(`${ROOT}/web/src/main.ts`)].sort());
  assert.equal(narrow.anchor, d(`${ROOT}/web/src`));
});

test('afterRange: NO anchor is a plain activation of the clicked row', () => {
  const sel = afterRange(EMPTY, d(`${ROOT}/server`), VISIBLE);
  assert.deepEqual(keys(sel), [d(`${ROOT}/server`)]);
  assert.equal(sel.anchor, d(`${ROOT}/server`));
});

test('afterRange: an end that is not VISIBLE is a plain activation, never a guess', () => {
  // The anchor sits in a folder that was collapsed since.
  const hiddenAnchor: Selection = { keys: new Set([d('/elsewhere')]), anchor: d('/elsewhere') };
  const a = afterRange(hiddenAnchor, d(`${ROOT}/server`), VISIBLE);
  assert.deepEqual(keys(a), [d(`${ROOT}/server`)]);
  assert.equal(a.anchor, d(`${ROOT}/server`));
  // The clicked row is not on this screen.
  const b = afterRange(afterRowActivate(EMPTY, d(`${ROOT}/web`)), d('/elsewhere'), VISIBLE);
  assert.deepEqual(keys(b), [d('/elsewhere')]);
  assert.equal(b.anchor, d('/elsewhere'));
  // …and an empty screen has no range at all.
  const c = afterRange(afterRowActivate(EMPTY, d(`${ROOT}/web`)), d(`${ROOT}/server`), []);
  assert.deepEqual(keys(c), [d(`${ROOT}/server`)]);
});

test('afterSelectAll: every VISIBLE row, and the anchor is KEPT when it is still one', () => {
  const anchored = afterRowActivate(EMPTY, d(`${ROOT}/server`));
  const all = afterSelectAll(anchored, VISIBLE);
  assert.deepEqual(keys(all), [...VISIBLE].sort());
  assert.equal(all.anchor, d(`${ROOT}/server`), 'the destination does not move under a ctrl+a');
});

test('afterSelectAll: an anchor that is NOT visible falls back to the first row', () => {
  const offscreen: Selection = { keys: new Set([d('/elsewhere')]), anchor: d('/elsewhere') };
  const all = afterSelectAll(offscreen, VISIBLE);
  assert.deepEqual(keys(all), [...VISIBLE].sort());
  assert.equal(all.anchor, VISIBLE[0]);
  // No anchor at all does the same.
  assert.equal(afterSelectAll(EMPTY, VISIBLE).anchor, VISIBLE[0]);
});

test('afterSelectAll: an empty screen selects nothing and anchors nowhere', () => {
  const all = afterSelectAll(afterRowActivate(EMPTY, d(`${ROOT}/web`)), []);
  assert.equal(size(all), 0);
  assert.equal(all.anchor, null);
});

test('afterMenuOpen: a row ALREADY IN the selection changes NOTHING (Explorer’s rule)', () => {
  const many = afterToggle(afterRowActivate(EMPTY, d(`${ROOT}/web`)), f(`${ROOT}/README.md`));
  const after = afterMenuOpen(many, d(`${ROOT}/web`));
  assert.deepEqual(keys(after), keys(many));
  assert.equal(after.anchor, many.anchor, 'not even the anchor moves');
  // Right-clicking the anchor itself is the same non-event.
  const onAnchor = afterMenuOpen(many, f(`${ROOT}/README.md`));
  assert.deepEqual(keys(onAnchor), keys(many));
  assert.equal(onAnchor.anchor, many.anchor);
});

test('afterMenuOpen: any OTHER row becomes the selection, and the anchor', () => {
  const many = afterToggle(afterRowActivate(EMPTY, d(`${ROOT}/web`)), f(`${ROOT}/README.md`));
  const after = afterMenuOpen(many, d(`${ROOT}/server`));
  assert.deepEqual(keys(after), [d(`${ROOT}/server`)]);
  assert.equal(after.anchor, d(`${ROOT}/server`));
  // A FILE row does it too (A9b left the selection alone here; B10a does not).
  const onFile = afterMenuOpen(many, f(`${ROOT}/web/index.html`));
  assert.deepEqual(keys(onFile), [f(`${ROOT}/web/index.html`)]);
  assert.equal(onFile.anchor, f(`${ROOT}/web/index.html`));
});

test('afterEscape clears, from any state', () => {
  assert.equal(size(afterEscape(afterSelectAll(EMPTY, VISIBLE))), 0);
  assert.equal(afterEscape(afterSelectAll(EMPTY, VISIBLE)).anchor, null);
  assert.equal(size(afterEscape(EMPTY)), 0);
});

test('afterPanelHidden clears — a destination nobody can see must not take a paste from a terminal', () => {
  const hidden = afterPanelHidden(afterSelectAll(EMPTY, VISIBLE));
  assert.equal(size(hidden), 0);
  assert.equal(hidden.anchor, null);
  assert.equal(destinationPath(hidden), null);
  assert.equal(size(afterPanelHidden(EMPTY)), 0);
});

test('prunedTo: a root change keeps only what is under the new root', () => {
  const sel = afterSelectAll(EMPTY, [...VISIBLE, d('/home/you/other'), f('/home/you/other/x.ts')]);
  const kept = prunedTo(sel, `${ROOT}/web`);
  assert.deepEqual(
    keys(kept),
    [d(`${ROOT}/web`), d(`${ROOT}/web/src`), f(`${ROOT}/web/src/main.ts`), f(`${ROOT}/web/index.html`)].sort(),
  );
  assert.equal(isSelected(kept, d('/home/you/other')), false);
});

test('prunedTo: the boundary is a `/`, not a prefix — `/home/userevil` is not under `/home/user`', () => {
  const sel = afterSelectAll(EMPTY, [d('/home/user'), d('/home/userevil'), f('/home/user/a.ts')]);
  const kept = prunedTo(sel, '/home/user');
  assert.deepEqual(keys(kept), [d('/home/user'), f('/home/user/a.ts')].sort());
});

test('prunedTo: the ANCHOR leaves with its row, and the destination goes with it', () => {
  const sel = afterRange(afterRowActivate(EMPTY, d('/home/you/other')), f(`${ROOT}/README.md`), [
    d('/home/you/other'),
    ...VISIBLE,
  ]);
  assert.equal(sel.anchor, d('/home/you/other'));
  const kept = prunedTo(sel, ROOT);
  assert.equal(kept.anchor, null, 'the anchor left the tree');
  assert.equal(destinationPath(kept), null);
  assert.ok(size(kept) > 0, 'non-vacuity: the rows under the new root are still there');
});

test('prunedTo: an anchor that SURVIVES keeps pointing where it did', () => {
  const sel = afterSelectAll(afterRowActivate(EMPTY, d(`${ROOT}/web/src`)), [
    ...VISIBLE,
    d('/home/you/other'),
  ]);
  const kept = prunedTo(sel, `${ROOT}/web`);
  assert.equal(kept.anchor, d(`${ROOT}/web/src`));
  assert.equal(destinationPath(kept), `${ROOT}/web/src`);
});

test('prunedTo: a non-tree key is under nothing and always leaves', () => {
  const sel: Selection = { keys: new Set([d(`${ROOT}/web`), 'floading', '']), anchor: d(`${ROOT}/web`) };
  assert.deepEqual(keys(prunedTo(sel, ROOT)), [d(`${ROOT}/web`)]);
});

test('without: the done keys leave, the rest stay selected', () => {
  const sel = afterSelectAll(EMPTY, VISIBLE);
  const left = without(sel, [d(`${ROOT}/web`), f(`${ROOT}/README.md`)]);
  assert.deepEqual(
    keys(left),
    [d(`${ROOT}/web/src`), f(`${ROOT}/web/src/main.ts`), f(`${ROOT}/web/index.html`), d(`${ROOT}/server`)].sort(),
  );
});

test('without: the anchor is cleared when it was among the done, and kept when it was not', () => {
  const sel = afterSelectAll(afterRowActivate(EMPTY, d(`${ROOT}/server`)), VISIBLE);
  assert.equal(without(sel, [d(`${ROOT}/server`)]).anchor, null);
  assert.equal(without(sel, [f(`${ROOT}/README.md`)]).anchor, d(`${ROOT}/server`));
  assert.equal(without(sel, []).anchor, d(`${ROOT}/server`));
  assert.equal(size(without(sel, [])), VISIBLE.length, 'nothing done, nothing lost');
});

test('without: a key that was never selected changes nothing but the anchor rule', () => {
  const sel = afterRowActivate(EMPTY, d(`${ROOT}/web`));
  assert.deepEqual(keys(without(sel, [f('/nowhere/x.ts')])), [d(`${ROOT}/web`)]);
});

// ---------------------------------------------------------------------------
// Where files land
// ---------------------------------------------------------------------------

test('destinationPath: a FOLDER anchor is its own path', () => {
  assert.equal(destinationPath(afterRowActivate(EMPTY, d(`${ROOT}/web/src`))), `${ROOT}/web/src`);
});

test('destinationPath: a FILE anchor is its PARENT — the folder that file is in', () => {
  assert.equal(
    destinationPath(afterRowActivate(EMPTY, f(`${ROOT}/web/src/main.ts`))),
    `${ROOT}/web/src`,
  );
  assert.equal(destinationPath(afterRowActivate(EMPTY, f('/README.md'))), '/');
});

test('destinationPath: with a many-row selection the ANCHOR alone decides', () => {
  const many = afterRange(afterRowActivate(EMPTY, d(`${ROOT}/web/src`)), f(`${ROOT}/README.md`), VISIBLE);
  assert.equal(size(many), 5, 'non-vacuity: several rows, several parents');
  assert.equal(destinationPath(many), `${ROOT}/web/src`);
  // …and it follows the anchor when a ctrl+click moves it.
  assert.equal(destinationPath(afterToggle(many, f(`${ROOT}/web/index.html`))), `${ROOT}/web`);
});

test('destinationPath: no anchor, and a non-tree anchor, have no destination', () => {
  assert.equal(destinationPath(EMPTY), null);
  assert.equal(destinationPath({ keys: new Set([d('/a')]), anchor: null }), null);
  assert.equal(destinationPath({ keys: new Set(['floading']), anchor: 'floading' }), null);
});

// ---------------------------------------------------------------------------
// selectedName — a PATH is chosen, a NAME is printed
// ---------------------------------------------------------------------------

test('selectedName: the last segment of a nested path, and nothing else of it', () => {
  assert.equal(selectedName('/home/you/projects/ai-cli-application/web/src'), 'src');
  assert.equal(selectedName('/home/you/web'), 'web');
  assert.equal(selectedName('/home'), 'home');
  assert.equal(selectedName('src'), 'src');
  assert.equal(selectedName('web/src'), 'src');
  assert.equal(selectedName('/home/you/Session Manager'), 'Session Manager');
});

test('selectedName: a trailing slash is not a segment', () => {
  assert.equal(selectedName('/home/you/web/'), 'web');
  assert.equal(selectedName('/home/you/web///'), 'web');
});

test('selectedName: a root path, an empty string and nothing have no name', () => {
  assert.equal(selectedName('/'), null);
  assert.equal(selectedName('//'), null);
  assert.equal(selectedName(''), null);
  assert.equal(selectedName(null), null);
});

// ---------------------------------------------------------------------------
// The copy strip's wording
// ---------------------------------------------------------------------------

test('COPY_LABEL is the A9 wording, unchanged, for "no destination"', () => {
  assert.equal(say(COPY_LABEL), 'Copy files here…');
});

test('copyIntoText: byte-identical to what filedrop.ts produced before the move', () => {
  assert.equal(say(copyIntoText('src')), 'Copy files into src');
  assert.equal(say(copyIntoText('Home')), 'Copy files into Home');
  assert.equal(say(copyIntoText('Session Manager')), 'Copy files into Session Manager');
});

test('copyStripLabel: nothing chosen says the constant', () => {
  assert.equal(say(copyStripLabel(null)), COPY_LABEL);
});

test('copyStripLabel: a destination is NAMED — it stops being invisible', () => {
  assert.equal(say(copyStripLabel('src')), 'Copy files into src…');
  assert.equal(say(copyStripLabel('web')), 'Copy files into web…');
  assert.equal(say(copyStripLabel('Session Manager')), 'Copy files into Session Manager…');
});

test('copyStripLabel: the label and the title are ONE wording, the label merely trails off', () => {
  assert.equal(copyStripLabel('web'), `${copyIntoText('web')}…`);
});

test('copyStripLabel: a destination that cannot be NAMED falls back to the constant (honesty rule)', () => {
  assert.equal(copyStripLabel('/'), COPY_LABEL);
  assert.equal(copyStripLabel(''), COPY_LABEL);
});

test('copyStripLabel end to end: a selection names its destination, never its path', () => {
  const sel = afterRowActivate(EMPTY, f(`${ROOT}/web/src/main.ts`));
  const label = say(copyStripLabel(selectedName(destinationPath(sel))));
  assert.equal(label, 'Copy files into src…');
  assert.equal(say(copyStripLabel(selectedName(destinationPath(EMPTY)))), COPY_LABEL);
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

test('takesPaste §2.2: FILES plus a SELECTED row is taken from anywhere, a terminal included', () => {
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

test('no produced string carries a path separator, however deep the chosen path is', () => {
  const dests: (string | null)[] = [
    null,
    '/',
    '',
    '/home/you/projects/ai-cli-application/web/src/ui',
    '/home/you/Session Manager/',
  ];
  const strings = [...PRODUCED];
  for (const p of dests) {
    strings.push(copyStripLabel(selectedName(p)));
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
