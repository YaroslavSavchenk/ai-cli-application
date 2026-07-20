/**
 * `web/src/ui/theme-model.ts` — the pure data + validation/comparison
 * helpers extracted from `ui/theme.ts` specifically so they are DOM-free and
 * importable under `node --test` (no xterm, no document; see that module's
 * header comment). Covers: clampTheme's index clamping and garbage
 * tolerance, scan's strict-boolean coercion, isUiTheme's shape guard, and
 * themeEquals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROUNDS, RAMPS, clampTheme, isUiTheme, themeEquals } from '../web/src/ui/theme-model.ts';

// ---------------------------------------------------------------------------
// clampTheme
// ---------------------------------------------------------------------------

test('clampTheme: a well-formed object passes through unchanged', () => {
  assert.deepEqual(clampTheme({ bg: 3, fg: 7, scan: true }), { bg: 3, fg: 7, scan: true });
});

test('clampTheme: bg/fg at the valid boundaries (0 and length-1) are kept as-is', () => {
  assert.deepEqual(clampTheme({ bg: 0, fg: 0, scan: false }), { bg: 0, fg: 0, scan: false });
  assert.deepEqual(
    clampTheme({ bg: GROUNDS.length - 1, fg: RAMPS.length - 1, scan: false }),
    { bg: GROUNDS.length - 1, fg: RAMPS.length - 1, scan: false },
  );
});

test('clampTheme: bg out of range (negative or >= GROUNDS.length) clamps to 0', () => {
  assert.equal(clampTheme({ bg: -1, fg: 0, scan: false }).bg, 0);
  assert.equal(clampTheme({ bg: GROUNDS.length, fg: 0, scan: false }).bg, 0);
  assert.equal(clampTheme({ bg: GROUNDS.length + 5, fg: 0, scan: false }).bg, 0);
});

test('clampTheme: fg out of range (negative or >= RAMPS.length) clamps to 0', () => {
  assert.equal(clampTheme({ bg: 0, fg: -1, scan: false }).fg, 0);
  assert.equal(clampTheme({ bg: 0, fg: RAMPS.length, scan: false }).fg, 0);
  assert.equal(clampTheme({ bg: 0, fg: RAMPS.length + 5, scan: false }).fg, 0);
});

test('clampTheme: non-integer bg/fg (e.g. 2.5) clamp to 0', () => {
  assert.equal(clampTheme({ bg: 2.5, fg: 0, scan: false }).bg, 0);
  assert.equal(clampTheme({ bg: 0, fg: 4.9, scan: false }).fg, 0);
});

test('clampTheme: non-numeric/garbage bg/fg (string, bool, object, null, NaN, Infinity) clamp to 0', () => {
  const garbageValues: unknown[] = ['3', true, {}, null, NaN, Infinity, -Infinity, [1]];
  for (const g of garbageValues) {
    assert.equal(clampTheme({ bg: g, fg: 0, scan: false }).bg, 0, `bg=${JSON.stringify(g)} must clamp to 0`);
    assert.equal(clampTheme({ bg: 0, fg: g, scan: false }).fg, 0, `fg=${JSON.stringify(g)} must clamp to 0`);
  }
});

test('clampTheme: missing bg/fg/scan keys default to 0/0/false', () => {
  assert.deepEqual(clampTheme({}), { bg: 0, fg: 0, scan: false });
});

test('clampTheme: scan is strict-boolean coercion — only the literal `true` counts, everything else is false', () => {
  assert.equal(clampTheme({ bg: 0, fg: 0, scan: true }).scan, true);
  assert.equal(clampTheme({ bg: 0, fg: 0, scan: false }).scan, false);
  for (const truthyButNotBooleanTrue of ['true', 1, 'yes', {}, [], 'false']) {
    assert.equal(
      clampTheme({ bg: 0, fg: 0, scan: truthyButNotBooleanTrue }).scan,
      false,
      `scan=${JSON.stringify(truthyButNotBooleanTrue)} must coerce to false, only exact boolean true counts`,
    );
  }
  assert.equal(clampTheme({ bg: 0, fg: 0, scan: undefined }).scan, false);
  assert.equal(clampTheme({ bg: 0, fg: 0 }).scan, false);
});

test('clampTheme: a fully garbage object (wrong types everywhere) degrades to the safe default', () => {
  assert.deepEqual(
    clampTheme({ bg: 'nope', fg: null, scan: 'nope' } as unknown as Record<string, unknown>),
    { bg: 0, fg: 0, scan: false },
  );
});

// ---------------------------------------------------------------------------
// isUiTheme
// ---------------------------------------------------------------------------

test('isUiTheme: a well-formed theme object is recognized', () => {
  assert.equal(isUiTheme({ bg: 0, fg: 0, scan: false }), true);
  assert.equal(isUiTheme({ bg: 9, fg: 9, scan: true }), true);
});

test('isUiTheme: extra unknown keys alongside a valid shape are still accepted (opaque-bag tolerance)', () => {
  assert.equal(isUiTheme({ bg: 0, fg: 0, scan: false, futureSetting: 'x' }), true);
});

test('isUiTheme: null is rejected', () => {
  assert.equal(isUiTheme(null), false);
});

test('isUiTheme: non-object primitives are rejected', () => {
  for (const v of ['a string', 42, true, undefined]) {
    assert.equal(isUiTheme(v), false, `${JSON.stringify(v)} must be rejected`);
  }
});

test('isUiTheme: a plain array is rejected (no bg/fg/scan members)', () => {
  assert.equal(isUiTheme([0, 0, false]), false);
});

test('isUiTheme: an empty object is rejected', () => {
  assert.equal(isUiTheme({}), false);
});

test('isUiTheme: wrong-typed members are rejected one at a time', () => {
  assert.equal(isUiTheme({ bg: '0', fg: 0, scan: false }), false, 'string bg');
  assert.equal(isUiTheme({ bg: 0, fg: '0', scan: false }), false, 'string fg');
  assert.equal(isUiTheme({ bg: 0, fg: 0, scan: 'false' }), false, 'string scan');
  assert.equal(isUiTheme({ bg: null, fg: 0, scan: false }), false, 'null bg');
  assert.equal(isUiTheme({ bg: 0, fg: 0, scan: 1 }), false, 'numeric scan (not boolean)');
});

test('isUiTheme: partially-missing members are rejected', () => {
  assert.equal(isUiTheme({ bg: 0, fg: 0 }), false, 'missing scan');
  assert.equal(isUiTheme({ bg: 0, scan: false }), false, 'missing fg');
  assert.equal(isUiTheme({ fg: 0, scan: false }), false, 'missing bg');
});

// ---------------------------------------------------------------------------
// themeEquals
// ---------------------------------------------------------------------------

test('themeEquals: identical values (including the same object reference) are equal', () => {
  const a = { bg: 1, fg: 2, scan: true };
  assert.equal(themeEquals(a, a), true, 'identity');
  assert.equal(themeEquals(a, { bg: 1, fg: 2, scan: true }), true, 'structurally equal, different object');
});

test('themeEquals: a difference in any single field makes it unequal', () => {
  const base = { bg: 1, fg: 2, scan: true };
  assert.equal(themeEquals(base, { ...base, bg: 0 }), false, 'bg differs');
  assert.equal(themeEquals(base, { ...base, fg: 0 }), false, 'fg differs');
  assert.equal(themeEquals(base, { ...base, scan: false }), false, 'scan differs');
});

test('themeEquals: all-fields-differ is unequal', () => {
  assert.equal(themeEquals({ bg: 1, fg: 1, scan: true }, { bg: 2, fg: 2, scan: false }), false);
});
