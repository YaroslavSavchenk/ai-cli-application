/**
 * `web/src/ui/theme-model.ts` — the pure data + validation/comparison helpers
 * behind the terminal colours, DOM-free on purpose so they are importable
 * under `node --test` (no xterm, no document; see that module's header).
 *
 * The persisted shape is a HEX PAIR since Nocturne B9 (plan
 * `.claude/plans/nocturne/PLAN-B9.md`, D1): `{ ground, text }`, both
 * `#rrggbb` lower-case, with the Legacy `{ bg, fg, scan }` index shape still
 * READ so an older prefs.json keeps its meaning. Covers: the hex helpers,
 * clampTheme on both shapes and on garbage (per member, independently),
 * NOCTURNE / isNocturne, themeEquals, and the isUiTheme / themeFromBag guard
 * that decides whether a prefs bag has an opinion at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUNDS,
  NOCTURNE,
  RAMPS,
  clampTheme,
  isHex6,
  isNocturne,
  isUiTheme,
  normHex,
  themeEquals,
  themeFromBag,
} from '../../web/src/ui/theme-model.ts';

const NOC_GROUND = (GROUNDS[0] as { hex: string }).hex;
const NOC_TEXT = (RAMPS[0] as { cmd: string }).cmd;

// ---------------------------------------------------------------------------
// the hex rule (owned here since B9; term-colours-model.ts re-exports it)
// ---------------------------------------------------------------------------

test('isHex6 / normHex: only a complete six-digit colour counts, and it normalises to lower case', () => {
  for (const good of ['#0b0d14', '#FFFFFF', '#AbCdEf']) assert.equal(isHex6(good), true, good);
  for (const bad of ['', '#fff', '#0b0d1', '#0b0d144', '0b0d14', '#0b0d1g', 'red']) {
    assert.equal(isHex6(bad), false, JSON.stringify(bad));
  }
  assert.equal(normHex('#0B0D14'), '#0b0d14');
  assert.equal(normHex('  #0b0d14  '), '#0b0d14', 'surrounding space is trimmed');
  assert.equal(normHex('#0b0d1'), null);
});

// ---------------------------------------------------------------------------
// NOCTURNE
// ---------------------------------------------------------------------------

test('NOCTURNE is entry 0 of the two tables — the pair theme.ts paints by REMOVING its overrides', () => {
  assert.deepEqual(NOCTURNE, { ground: NOC_GROUND, text: NOC_TEXT });
  assert.equal(isNocturne({ ground: NOC_GROUND, text: NOC_TEXT }), true);
  assert.equal(isNocturne({ ground: NOC_GROUND, text: '#ffe9c4' }), false, 'a different text step is not the default');
  assert.equal(isNocturne({ ground: '#161010', text: NOC_TEXT }), false, 'a different ground is not the default');
});

// ---------------------------------------------------------------------------
// clampTheme — the v2 pair
// ---------------------------------------------------------------------------

test('clampTheme: a well-formed pair passes through, normalised to lower case', () => {
  assert.deepEqual(clampTheme({ ground: '#161010', text: '#ffe9c4' }), {
    ground: '#161010',
    text: '#ffe9c4',
  });
  assert.deepEqual(clampTheme({ ground: '#161010', text: '#FFE9C4' }), {
    ground: '#161010',
    text: '#ffe9c4',
  });
  assert.deepEqual(clampTheme({ ground: ' #161010 ', text: '#ffe9c4' }), {
    ground: '#161010',
    text: '#ffe9c4',
  });
});

test('clampTheme: a pair off the preset tables is kept verbatim (a custom colour is a colour)', () => {
  assert.deepEqual(clampTheme({ ground: '#ffffff', text: '#123456' }), {
    ground: '#ffffff',
    text: '#123456',
  });
});

test('clampTheme: each member falls back INDEPENDENTLY — half a value is still worth something', () => {
  assert.deepEqual(clampTheme({ ground: '#161010', text: 'nope' }), {
    ground: '#161010',
    text: NOC_TEXT,
  });
  assert.deepEqual(clampTheme({ ground: 42, text: '#ffe9c4' }), {
    ground: NOC_GROUND,
    text: '#ffe9c4',
  });
});

test('clampTheme: garbage of every kind degrades to Nocturne, and never throws', () => {
  for (const bad of [null, undefined, 0, 'x', true, [], [1, 2], {}, { ground: null, text: {} }]) {
    assert.deepEqual(clampTheme(bad), { ground: NOC_GROUND, text: NOC_TEXT }, JSON.stringify(bad) ?? 'undefined');
  }
});

test('clampTheme: a three-digit or eight-digit hex is NOT a colour here (the fields round-trip through a six-digit swatch)', () => {
  assert.equal(clampTheme({ ground: '#fff', text: '#ffe9c4' }).ground, NOC_GROUND);
  assert.equal(clampTheme({ ground: '#161010', text: '#ffe9c4ff' }).text, NOC_TEXT);
});

// ---------------------------------------------------------------------------
// clampTheme — the Legacy index shape (read, never written again)
// ---------------------------------------------------------------------------

test('clampTheme: a Legacy index pair maps to the hexes those indexes always meant', () => {
  assert.deepEqual(clampTheme({ bg: 9, fg: 2, scan: true }), {
    ground: (GROUNDS[9] as { hex: string }).hex,
    text: (RAMPS[2] as { cmd: string }).cmd,
  });
  assert.deepEqual(clampTheme({ bg: 0, fg: 0, scan: false }), { ground: NOC_GROUND, text: NOC_TEXT });
});

test('clampTheme: `scan` leaves the shape — a Legacy bag never produces a third member', () => {
  assert.deepEqual(Object.keys(clampTheme({ bg: 1, fg: 1, scan: true })).sort(), ['ground', 'text']);
});

test('clampTheme: an out-of-range, fractional or non-numeric Legacy index falls back to the Nocturne member', () => {
  for (const bad of [-1, GROUNDS.length, GROUNDS.length + 5, 2.5, '3', null, NaN, Infinity, true]) {
    assert.equal(clampTheme({ bg: bad, fg: 0 }).ground, NOC_GROUND, `bg=${JSON.stringify(bad)}`);
  }
  for (const bad of [-1, RAMPS.length, 4.9, '3', null, NaN, Infinity]) {
    assert.equal(clampTheme({ bg: 0, fg: bad }).text, NOC_TEXT, `fg=${JSON.stringify(bad)}`);
  }
});

test('clampTheme: the v2 pair WINS over a Legacy index in the same object (the migration is one-way)', () => {
  assert.deepEqual(clampTheme({ ground: '#161010', text: '#ffe9c4', bg: 1, fg: 1 }), {
    ground: '#161010',
    text: '#ffe9c4',
  });
});

// ---------------------------------------------------------------------------
// themeEquals
// ---------------------------------------------------------------------------

test('themeEquals: identical pairs are equal, a difference in either member is not', () => {
  const a = { ground: '#161010', text: '#ffe9c4' };
  assert.equal(themeEquals(a, a), true, 'identity');
  assert.equal(themeEquals(a, { ground: '#161010', text: '#ffe9c4' }), true, 'structurally equal');
  assert.equal(themeEquals(a, { ground: '#0b0d14', text: '#ffe9c4' }), false, 'ground differs');
  assert.equal(themeEquals(a, { ground: '#161010', text: '#e9e9ed' }), false, 'text differs');
});

// ---------------------------------------------------------------------------
// isUiTheme / themeFromBag — does a prefs bag have an opinion at all?
// ---------------------------------------------------------------------------

test('isUiTheme: either shape, one readable member is enough', () => {
  assert.equal(isUiTheme({ ground: '#161010', text: '#ffe9c4' }), true, 'the v2 pair');
  assert.equal(isUiTheme({ ground: '#161010' }), true, 'ground alone');
  assert.equal(isUiTheme({ text: '#ffe9c4' }), true, 'text alone');
  assert.equal(isUiTheme({ bg: 9, fg: 2, scan: true }), true, 'the Legacy shape');
  assert.equal(isUiTheme({ fg: 2 }), true, 'a Legacy member alone');
  assert.equal(isUiTheme({ ground: '#161010', futureSetting: 'x' }), true, 'unknown keys alongside (opaque bag)');
});

test('isUiTheme: nothing readable is no opinion — null, primitives, arrays, an empty or garbage object', () => {
  for (const bad of [null, undefined, 0, 1, 'x', true, [], [0, 0, false], {}, { ground: 'red' }, { bg: '0' }, { scan: true }]) {
    assert.equal(isUiTheme(bad), false, JSON.stringify(bad) ?? 'undefined');
  }
});

test('themeFromBag: a readable member clamps to a pair; anything else is null, so the caller keeps its local choice', () => {
  assert.deepEqual(themeFromBag({ ground: '#161010', text: '#ffe9c4' }), {
    ground: '#161010',
    text: '#ffe9c4',
  });
  assert.deepEqual(themeFromBag({ bg: 9, fg: 2, scan: true }), {
    ground: (GROUNDS[9] as { hex: string }).hex,
    text: (RAMPS[2] as { cmd: string }).cmd,
  });
  assert.deepEqual(
    themeFromBag({ ground: '#161010' }),
    { ground: '#161010', text: NOC_TEXT },
    'half a pair is still an opinion; the other member is Nocturne',
  );
  assert.equal(themeFromBag(undefined), null, 'a bag without a theme');
  assert.equal(themeFromBag({}), null, 'an empty theme object');
  assert.equal(themeFromBag({ ground: 'red' }), null, 'an unreadable one');
});
