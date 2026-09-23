/**
 * Test-engineer additions for the Nocturne A7 "Terminal colours" page, next to
 * `tests/ui/ui-term-colours-model.test.ts` (the model's happy shapes) and
 * `tests/ui/ui-settings-panel.test.ts` (the page inside the Settings modal). What
 * is proven HERE is what those two leave open:
 *
 *   1. The model's edge branches: three- and seven-digit hexes, a missing `#`,
 *      inner whitespace, `mixHex` over an INVALID input (its `??` fallback
 *      chain), `matchPreset` keyed on the BRIGHT step only, and a preset state
 *      whose leftover custom fields must never leak into the preview.
 *   2. The page's FREEZE promise: after a valid custom pair, a half-typed hex
 *      leaves the preview and both fields exactly where they were — it does not
 *      fall back to Nocturne, and it does not blank the preview.
 *   3. The roving tabindex really MOVES with the arrows (the dev test asserts
 *      aria-checked, not the tab stop), Home/End land, and a key the grid does
 *      not own changes nothing and is not swallowed.
 *   4. The page reaches its injected CONTROL and nothing else AT RUNTIME, not
 *      only in source: since part B9 every change goes to `ctl.apply`, while
 *      `document.documentElement.style` is a recording double here and must
 *      stay untouched, `fetch` throws if anything tries to call an API, and the
 *      page arms no timer of its own (ui/theme.ts owns :root, the prefs write
 *      and its debounce).
 *
 * The page is driven through the REAL `ui/term-colours.ts` on the DOM double in
 * `tests/helpers/fake-dom.ts`; the only stub is that control, because the module
 * imports only `ui/util.ts` and the pure model. Looks stay manual
 * (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byClass, dispatch, installDom, type FakeElement } from '../helpers/fake-dom.ts';

const dom = installDom();

// Anything that reaches out of the page is a failure, not a warning: a call
// lands as a thrown error inside the handler that made it.
(globalThis as unknown as Record<string, unknown>).fetch = (): never => {
  throw new Error('A7 must not call an API from the Terminal colours page');
};

/** `document.documentElement.style`, recording: ui/theme.ts owns `:root`, not the page. */
const rootWrites: string[] = [];
const htmlEl = dom.doc.createElement('html');
Object.defineProperty(htmlEl, 'style', {
  value: {
    setProperty: (name: string, value: string): void => {
      rootWrites.push(`${name}=${value}`);
    },
    getPropertyValue: (): string => '',
    removeProperty: (name: string): void => {
      rootWrites.push(`remove ${name}`);
    },
  },
  writable: false,
});
(dom.doc as unknown as Record<string, unknown>).documentElement = htmlEl;

interface Preset {
  id: string;
  name: string;
  bg: number;
  fg: number;
}
interface TcColours {
  ground: string;
  cmd: string;
  out: string;
  dim: string;
}
interface TcState {
  id: string;
  ground: string;
  text: string;
}
type TcAction =
  | { k: 'preset'; id: string }
  | { k: 'ground'; hex: string }
  | { k: 'text'; hex: string }
  | { k: 'reset' };
interface ModelModule {
  PRESETS: readonly Preset[];
  CUSTOM: string;
  DEFAULT_PRESET: string;
  presetOf(id: string): Preset | undefined;
  presetColours(id: string): TcColours;
  coloursOf(s: TcState): TcColours;
  matchPreset(ground: string, text: string): string | null;
  initialState(): TcState;
  isHex6(s: string): boolean;
  normHex(s: string): string | null;
  mixHex(a: string, b: string, t: number): string;
  reduce(s: TcState, a: TcAction): TcState;
}
interface ThemeModule {
  GROUNDS: { name: string; hex: string }[];
  RAMPS: { name: string; cmd: string; out: string; dim: string }[];
}
interface TermPair {
  ground: string;
  text: string;
}
interface PageModule {
  buildTermColours(
    titleId: string,
    ctl: { apply(next: TermPair): void; current(): TermPair },
  ): { root: FakeElement; sync(): void };
}

const M = (await import(
  new URL('../../web/src/ui/term-colours-model.ts', import.meta.url).href
)) as ModelModule;
const T = (await import(new URL('../../web/src/ui/theme-model.ts', import.meta.url).href)) as ThemeModule;
const P = (await import(new URL('../../web/src/ui/term-colours.ts', import.meta.url).href)) as PageModule;

// ===========================================================================
// The model's edges
// ===========================================================================

test('isHex6: the three-digit, seven-digit, no-hash and inner-space forms are all refused', () => {
  // A native colour input always writes six digits, so the short CSS form is
  // NOT a colour this page accepts — it would round-trip into something else.
  for (const bad of [
    '#ABC',
    '#abc',
    '#abcdefg',
    '#ABCDEFG',
    'abcdef',
    '#abcde',
    '#ab cdef',
    '#abcdef#',
    '##abcdef',
    '#abcdef\n',
    '\t#abcdef',
    '#0x0d14',
    '#abcdef00',
  ]) {
    assert.equal(M.isHex6(bad), false, JSON.stringify(bad));
  }
  // Uppercase, lowercase and mixed all pass — case is a spelling, not a value.
  for (const good of ['#ABCDEF', '#abcdef', '#AbCdEf', '#000000', '#999999']) {
    assert.equal(M.isHex6(good), true, good);
  }
});

test('normHex: whitespace around a colour is trimmed, inside it is not', () => {
  assert.equal(M.normHex('\t#ABCDEF\n '), '#abcdef', 'tabs and newlines are surrounding space too');
  assert.equal(M.normHex('#AB CDEF'), null);
  assert.equal(M.normHex('#ABC'), null, 'the three-digit form is not upgraded');
  assert.equal(M.normHex(''), null);
  assert.equal(M.normHex('   '), null);
});

test('mixHex over an invalid input falls back to the valid side, or to black', () => {
  // The `??` chain in mixHex is unreachable from the page (the reducer refuses a
  // bad hex first) but it decides what a future caller sees, so it is pinned.
  assert.equal(M.mixHex('#abc', '#ffffff', 0.5), '#ffffff', 'a bad first side yields the second');
  assert.equal(M.mixHex('#abcdef', 'nope', 0.5), '#abcdef', 'a bad second side yields the first');
  assert.equal(M.mixHex('nope', 'nope', 0.5), '#000000', 'two bad sides yield black, never NaN');
  assert.equal(M.mixHex('#ABCDEF', '#ABCDEF', 0.5), '#abcdef', 'and the result is always normalised');
});

test('mixHex with a factor that is not a number still yields a COLOUR, never `#NaNNaNNaN`', () => {
  // `Math.min(1, Math.max(0, NaN))` is NaN — the clamp alone does not catch it,
  // so the factor is checked for finiteness and falls back to 0 (the `a` side).
  // Unreachable from the page (the only caller passes the constant DIM_MIX), but
  // an exported helper may never hand a caller something that is not a colour.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const out = M.mixHex('#000000', '#ffffff', bad);
    assert.match(out, /^#[0-9a-f]{6}$/, String(bad));
  }
  assert.equal(M.mixHex('#000000', '#ffffff', Number.NaN), '#000000', 'NaN reads as t = 0');
  assert.equal(M.mixHex('#000000', '#ffffff', 0.5), '#808080', 'a real factor is unaffected');
});

test('a custom dim step sits between text and ground in EVERY channel, not just in luma', () => {
  const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (const [ground, text] of [
    ['#0b0d14', '#e9e9ed'],
    ['#ff0000', '#00ff00'],
    ['#ffffff', '#000000'],
  ] as [string, string][]) {
    const c = M.coloursOf({ id: M.CUSTOM, ground, text });
    const [gr, gg, gb] = rgb(ground) as [number, number, number];
    const [tr, tg, tb] = rgb(text) as [number, number, number];
    const [dr, dg, db] = rgb(c.dim) as [number, number, number];
    for (const [lo, hi, got] of [
      [Math.min(gr, tr), Math.max(gr, tr), dr],
      [Math.min(gg, tg), Math.max(gg, tg), dg],
      [Math.min(gb, tb), Math.max(gb, tb), db],
    ] as [number, number, number][]) {
      assert.ok(got >= lo && got <= hi, `channel ${got} outside [${lo}, ${hi}] for ${ground}/${text}`);
    }
    assert.notEqual(c.dim, text, 'a dim step equal to the text would be a preview that lies');
  }
});

test('a preset state ignores whatever sits in its custom fields (no leak into the preview)', () => {
  // The state carries a ground+text pair even while a preset is selected; the
  // preset's own table rows must win, or a stale pair would paint the preview.
  const c = M.coloursOf({ id: 'nocturne', ground: '#ff0000', text: '#00ff00' });
  assert.deepEqual(c, {
    ground: T.GROUNDS[0]?.hex,
    cmd: T.RAMPS[0]?.cmd,
    out: T.RAMPS[0]?.out,
    dim: T.RAMPS[0]?.dim,
  });
  assert.equal(M.presetOf(M.CUSTOM), undefined, 'CUSTOM is not a preset');
  assert.equal(M.presetOf(''), undefined);
  assert.equal(M.presetOf('nocturne')?.bg, 0);
});

test('matchPreset is keyed on the BRIGHT step: the ramp’s out and dim are not keys', () => {
  const p = M.PRESETS[0] as Preset;
  const ground = T.GROUNDS[p.bg]?.hex as string;
  const ramp = T.RAMPS[p.fg] as { cmd: string; out: string; dim: string };
  assert.equal(M.matchPreset(ground, ramp.cmd), p.id);
  assert.equal(M.matchPreset(ground, ramp.out), null, 'the ordinary-output step is not the key');
  assert.equal(M.matchPreset(ground, ramp.dim), null, 'nor the quiet one');
  assert.equal(M.matchPreset('', ''), null);
});

test('reduce: an invalid hex freezes a PRESET state too, and a preset’s own value re-selects it', () => {
  const nocturne = M.initialState();
  for (const bad of ['#ABC', '#abcdefg', 'e9e9ed', '  ', '#e9e9e']) {
    assert.deepEqual(M.reduce(nocturne, { k: 'ground', hex: bad }), nocturne, `ground ${bad}`);
    assert.deepEqual(M.reduce(nocturne, { k: 'text', hex: bad }), nocturne, `text ${bad}`);
  }
  // Typing the selected preset's own value in either field keeps that preset —
  // it never drops to CUSTOM just because a field was touched.
  const sameG = M.reduce(nocturne, { k: 'ground', hex: (T.GROUNDS[0]?.hex as string).toUpperCase() });
  assert.equal(sameG.id, 'nocturne');
  const sameT = M.reduce(nocturne, { k: 'text', hex: ` ${T.RAMPS[0]?.cmd as string} ` });
  assert.equal(sameT.id, 'nocturne');
  // Reset from the untouched default is a no-op, not a different object shape.
  assert.deepEqual(M.reduce(nocturne, { k: 'reset' }), nocturne);
});

// ===========================================================================
// The page on the DOM double
// ===========================================================================

/**
 * The injected control, stubbed: it records what the page hands it and answers
 * `current()` from the same pair, which is exactly the contract ui/theme.ts
 * fulfils (it clamps, paints and persists — none of which is this page's job).
 */
const applied: string[] = [];
let held: TermPair = { ground: T.GROUNDS[0]!.hex, text: T.RAMPS[0]!.cmd };
const ctl = {
  apply(next: TermPair): void {
    applied.push(`${next.ground}/${next.text}`);
    held = { ...next };
  },
  current(): TermPair {
    return { ...held };
  },
};

const built = P.buildTermColours('sg-tab-colours', ctl);
const page = built.root;
dom.body.append(page);

const cards = (): FakeElement[] => byClass(page, 'sg-tccard');
const prev = (): FakeElement => byClass(page, 'sg-tcprev')[0] as FakeElement;
const grid = (): FakeElement => byClass(page, 'sg-tcgrid')[0] as FakeElement;
const hexes = (): [FakeElement, FakeElement] => {
  const xs = byClass(page, 'sg-tchex');
  return [xs[0] as FakeElement, xs[1] as FakeElement];
};
const swatches = (): [FakeElement, FakeElement] => {
  const xs = byClass(page, 'sg-tcswatch');
  return [xs[0] as FakeElement, xs[1] as FakeElement];
};
const inks = (): string[] => byClass(prev(), 'sg-tcline').map((l) => l.style.color as string);
function reset(): void {
  const b = byClass(page, 'sg-textbtn').find((x) => x.textContent === 'Reset to Nocturne');
  assert.ok(b !== undefined, 'the page carries Reset to Nocturne');
  b.click();
}
/** Type into a hex field the way a user does: set the value, fire `input`. */
function typeHex(f: FakeElement, v: string): void {
  f.value = v;
  dispatch(f, 'input');
}

test('the page is a tabpanel labelled by the nav button, with an aria-hidden picture', () => {
  assert.equal(page.getAttribute('role'), 'tabpanel');
  assert.equal(page.getAttribute('aria-labelledby'), 'sg-tab-colours');
  assert.equal(prev().getAttribute('aria-hidden'), 'true', 'three sample sentences say nothing about colour');
  assert.equal(grid().getAttribute('role'), 'radiogroup');
  assert.equal(
    grid().getAttribute('aria-labelledby'),
    byClass(page, 'sg-lb')[0]?.id,
    'the radiogroup is labelled by the Schemes label it sits under',
  );
  assert.equal(cards().length, M.PRESETS.length);
  for (const c of cards()) assert.equal(c.getAttribute('role'), 'radio');
});

test('each scheme card wears its OWN two colours, so the shelf previews itself', () => {
  reset();
  for (const [i, p] of M.PRESETS.entries()) {
    const sw = byClass(cards()[i] as FakeElement, 'sg-tcsw')[0] as FakeElement;
    assert.equal(sw.style['background-color'], T.GROUNDS[p.bg]?.hex, `${p.id} swatch ground`);
    assert.equal(sw.style.color, T.RAMPS[p.fg]?.cmd, `${p.id} swatch ink`);
    assert.equal(sw.getAttribute('aria-hidden'), 'true');
  }
});

test('the arrows MOVE the tab stop and the focus with the choice; Home and End land', () => {
  reset();
  assert.deepEqual(
    cards().map((c) => c.tabIndex),
    cards().map((_, i) => (i === 0 ? 0 : -1)),
  );
  dispatch(grid(), 'keydown', { key: 'ArrowRight' });
  assert.equal(cards()[1]?.getAttribute('aria-checked'), 'true');
  assert.deepEqual(
    cards().map((c) => c.tabIndex),
    cards().map((_, i) => (i === 1 ? 0 : -1)),
    'the roving tab stop follows the selection',
  );
  assert.equal(dom.doc.activeElement, cards()[1], 'and so does the focus');
  dispatch(grid(), 'keydown', { key: 'ArrowUp' });
  assert.equal(cards()[0]?.getAttribute('aria-checked'), 'true', 'ArrowUp is the same axis as ArrowLeft');
  dispatch(grid(), 'keydown', { key: 'ArrowLeft' });
  assert.equal(cards().at(-1)?.getAttribute('aria-checked'), 'true', 'and it wraps backwards');
  dispatch(grid(), 'keydown', { key: 'Home' });
  assert.equal(cards()[0]?.getAttribute('aria-checked'), 'true');
  dispatch(grid(), 'keydown', { key: 'End' });
  assert.equal(cards().at(-1)?.getAttribute('aria-checked'), 'true');
  assert.equal(dom.doc.activeElement, cards().at(-1));
  dispatch(grid(), 'keydown', { key: 'ArrowDown' });
  assert.equal(cards()[0]?.getAttribute('aria-checked'), 'true', 'ArrowDown wraps forwards');
});

test('with a CUSTOM pair selected the arrows enter the row at its ends, so card 0 is reachable', () => {
  // A custom pair checks no card: there is no index to step from, so a forward
  // key must land on the FIRST card (stepping from a pretended 0 would select
  // card 1 and leave card 0 unreachable by ArrowRight) and a backward key on the
  // last.
  reset();
  const [groundHex] = hexes();
  typeHex(groundHex, '#123456');
  assert.deepEqual(
    cards().map((c) => c.getAttribute('aria-checked')),
    cards().map(() => 'false'),
    'a custom pair selects no card',
  );
  dispatch(grid(), 'keydown', { key: 'ArrowRight' });
  assert.equal(cards()[0]?.getAttribute('aria-checked'), 'true', 'ArrowRight enters at the first card');

  reset();
  typeHex(hexes()[0] as FakeElement, '#123456');
  dispatch(grid(), 'keydown', { key: 'ArrowLeft' });
  assert.equal(cards().at(-1)?.getAttribute('aria-checked'), 'true', 'ArrowLeft enters at the last card');
});

test('a key the scheme row does not own changes nothing and is not swallowed', () => {
  reset();
  for (const key of ['a', 'Tab', 'Enter', 'PageDown', 'Escape']) {
    const e = dispatch(grid(), 'keydown', { key });
    assert.equal(e.defaultPrevented, false, `${key} must stay the page's (or the dialog's) own`);
    assert.equal(cards()[0]?.getAttribute('aria-checked'), 'true', `${key} moved the selection`);
  }
});

test('a half-typed hex FREEZES the preview at the last valid pair — it does not fall back', () => {
  reset();
  const [groundHex, textHex] = hexes();
  // Land on a custom pair first: the freeze is only visible from a state that is
  // NOT the default (a fall-back to Nocturne would otherwise look like a pass).
  typeHex(groundHex, '#123456');
  typeHex(textHex, '#abcdef');
  assert.equal(prev().style['background-color'], '#123456');
  assert.deepEqual(inks(), ['#abcdef', '#abcdef', M.mixHex('#abcdef', '#123456', 0.55)]);
  const frozen = inks();

  for (const bad of ['#12345', '#abc', 'abcdef', '#12345g', '']) {
    typeHex(groundHex, bad);
    assert.ok(groundHex.classList.contains('is-bad'), `${bad} must be flagged`);
    assert.equal(groundHex.getAttribute('aria-invalid'), 'true');
    assert.equal(prev().style['background-color'], '#123456', `${bad} moved the ground`);
    assert.deepEqual(inks(), frozen, `${bad} moved the ink`);
    assert.equal(textHex.value, '#abcdef', 'the other field is untouched');
    assert.equal(groundHex.value, bad, 'and the half-typed text is kept, not rewritten');
  }
  // Finishing the colour clears the flag and moves the preview in one step.
  typeHex(groundHex, '#123457');
  assert.equal(groundHex.classList.contains('is-bad'), false);
  assert.equal(groundHex.getAttribute('aria-invalid'), 'false');
  assert.equal(prev().style['background-color'], '#123457');
});

test('Reset returns to Nocturne, clears a flagged field, and puts focus where the numbers are', () => {
  reset();
  const [groundHex, textHex] = hexes();
  typeHex(textHex, '#00ff00');
  typeHex(groundHex, '#12');
  assert.ok(groundHex.classList.contains('is-bad'));
  reset();
  assert.equal(groundHex.classList.contains('is-bad'), false, 'a reset that leaves a red field is a lie');
  assert.equal(groundHex.getAttribute('aria-invalid'), 'false');
  assert.equal(textHex.getAttribute('aria-invalid'), 'false');
  assert.equal(groundHex.value, T.GROUNDS[0]?.hex);
  assert.equal(textHex.value, T.RAMPS[0]?.cmd);
  assert.equal(prev().style['background-color'], T.GROUNDS[0]?.hex);
  assert.deepEqual(inks(), [T.RAMPS[0]?.cmd, T.RAMPS[0]?.out, T.RAMPS[0]?.dim]);
  assert.equal(cards()[0]?.getAttribute('aria-checked'), 'true');
  assert.equal(dom.doc.activeElement, groundHex, 'focus lands on the field the reset rewrote');
});

test('the two swatches and the two hex fields stay two views of one value', () => {
  reset();
  const [groundHex, textHex] = hexes();
  const [groundSw, textSw] = swatches();
  // A preset writes both views.
  (cards()[2] as FakeElement).click();
  const p = M.PRESETS[2] as Preset;
  assert.equal(groundSw.value, T.GROUNDS[p.bg]?.hex);
  assert.equal(textSw.value, T.RAMPS[p.fg]?.cmd);
  assert.equal(groundHex.value, T.GROUNDS[p.bg]?.hex);
  assert.equal(textHex.value, T.RAMPS[p.fg]?.cmd);
  // The native swatch writes uppercase in some browsers; the field normalises.
  groundSw.value = '#00FF00';
  dispatch(groundSw, 'input');
  assert.equal(groundHex.value, '#00ff00');
  assert.equal(prev().style['background-color'], '#00ff00');
  // And a typed hex writes the swatch back.
  typeHex(textHex, '#FF8800');
  assert.equal(textSw.value, '#ff8800');
  assert.deepEqual(
    cards().map((c) => c.getAttribute('aria-checked')),
    cards().map(() => 'false'),
    'a custom pair selects no card',
  );
  assert.equal(cards()[0]?.tabIndex, 0, 'and the row keeps a tab stop anyway');
  reset();
});

test('every change reached the injected control, and the last one is what the page shows', () => {
  assert.ok(applied.length > 0, 'the page drives the control');
  const nocturnePair = `${T.GROUNDS[0]!.hex}/${T.RAMPS[0]!.cmd}`;
  assert.equal(applied.at(-1), nocturnePair, 'the suite ends on Reset to Nocturne');
  assert.deepEqual(ctl.current(), { ground: T.GROUNDS[0]!.hex, text: T.RAMPS[0]!.cmd });
});

test('the page re-seeds itself from the control on sync() — another window\'s choice shows up', () => {
  held = { ground: T.GROUNDS[9]!.hex, text: T.RAMPS[2]!.cmd }; // Amber on espresso
  const before = applied.length;
  built.sync();
  assert.equal(prev().style['background-color'], T.GROUNDS[9]!.hex, 'the preview follows');
  assert.equal(
    cards().find((c) => c.getAttribute('aria-checked') === 'true')?.textContent?.includes('Amber'),
    true,
    'and so does the selected card',
  );
  assert.equal(applied.length, before, 'a sync is not a change: it must not write back');
  reset();
});

test('nothing on this page wrote :root, called an API, or armed a timer (ui/theme.ts owns all three)', () => {
  assert.deepEqual(rootWrites, [], 'the page must not touch document.documentElement.style');
  assert.deepEqual(dom.win.timers, [], 'the page arms no timer — the write debounce is theme.ts\'s');
  // The mock is gone with part B9: the page applies the colours it shows.
  assert.deepEqual(byClass(page, 'sg-note'), [], 'no honesty line is left on a live page');
});
