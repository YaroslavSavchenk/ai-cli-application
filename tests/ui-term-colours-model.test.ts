/**
 * `web/src/ui/term-colours-model.ts` — the pure model behind the Settings page
 * "Terminal colours" (Nocturne A7; the page goes live in part B9). DOM-free, so
 * it is imported and driven directly here.
 *
 * What is worth pinning, in the order a regression would bite:
 *   1. The PRESETS really resolve through theme-model.ts's own tables, and
 *      Nocturne is entry 0 of both — that is the promise "this page previews
 *      the exact hexes B9 will paint a terminal with".
 *   2. Hex validation is strict: a half-typed colour never becomes a colour.
 *   3. The reducer never invents state — an invalid hex changes nothing, a
 *      custom pair that equals a preset re-selects that preset, and Reset goes
 *      back to Nocturne from anywhere.
 *   4. The derived dim step of a custom pair sits BETWEEN the text and the
 *      ground (a "dim" line brighter than the text, or equal to it, would be a
 *      preview that lies).
 *
 * The page's looks, and that any of this reaches a terminal, are not claimed
 * here: the first is manual, the second is part B9.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const M = (await import(new URL('../web/src/ui/term-colours-model.ts', import.meta.url).href)) as ModelModule;
const T = (await import(new URL('../web/src/ui/theme-model.ts', import.meta.url).href)) as ThemeModule;

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

/** 0-255 per channel of a `#rrggbb`. */
function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** Rec. 601 luma — enough to order three inks by brightness. */
function luma(hex: string): number {
  const [r, g, b] = rgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

test('the presets resolve through theme-model.ts, and Nocturne is first and default', () => {
  assert.ok(M.PRESETS.length >= 5, `non-vacuity: ${M.PRESETS.length} presets`);
  assert.equal(M.PRESETS[0]?.id, 'nocturne', 'Nocturne is the FIRST card');
  assert.equal(M.DEFAULT_PRESET, 'nocturne');
  assert.equal(M.PRESETS[0]?.bg, 0);
  assert.equal(M.PRESETS[0]?.fg, 0);
  // Entry 0 of both tables IS Nocturne (theme-model.ts, since 2026-09-10).
  assert.equal(T.GROUNDS[0]?.name, 'nocturne');
  assert.equal(T.RAMPS[0]?.name, 'nocturne');
  // Every preset points at a real row of both tables, and no id repeats.
  const ids = new Set<string>();
  for (const p of M.PRESETS) {
    assert.ok(T.GROUNDS[p.bg] !== undefined, `${p.id}: ground index ${p.bg} does not exist`);
    assert.ok(T.RAMPS[p.fg] !== undefined, `${p.id}: ramp index ${p.fg} does not exist`);
    assert.equal(ids.has(p.id), false, `duplicate preset id ${p.id}`);
    ids.add(p.id);
    assert.ok(p.name.length > 2, `${p.id} needs a name a user can read`);
  }
  assert.equal(ids.has(M.CUSTOM), false, 'no preset may be called `custom` — that id means "neither"');
});

test('a preset paints exactly its two table rows', () => {
  for (const p of M.PRESETS) {
    const c = M.presetColours(p.id);
    assert.equal(c.ground, T.GROUNDS[p.bg]?.hex);
    assert.equal(c.cmd, T.RAMPS[p.fg]?.cmd);
    assert.equal(c.out, T.RAMPS[p.fg]?.out);
    assert.equal(c.dim, T.RAMPS[p.fg]?.dim);
  }
});

test('the opening state is Nocturne, with its own two values in the custom fields', () => {
  const s = M.initialState();
  assert.deepEqual(s, {
    id: 'nocturne',
    ground: T.GROUNDS[0]?.hex,
    text: T.RAMPS[0]?.cmd,
  });
});

test('isHex6 / normHex: only a complete six-digit colour counts', () => {
  for (const good of ['#0b0d14', '#FFFFFF', '#abcdef', '#012345']) {
    assert.equal(M.isHex6(good), true, good);
  }
  for (const bad of ['', '#', '#fff', '#0b0d1', '#0b0d144', '0b0d14', '#0b0d1g', 'rgb(0,0,0)', '#0b0d14 ']) {
    assert.equal(M.isHex6(bad), false, JSON.stringify(bad));
  }
  assert.equal(M.normHex('#0B0D14'), '#0b0d14', 'a hex is normalised to lower case');
  assert.equal(M.normHex('  #0b0d14  '), '#0b0d14', 'surrounding space is trimmed');
  assert.equal(M.normHex('#0b0d1'), null);
});

test('mixHex: the endpoints, the middle, and a clamped factor', () => {
  assert.equal(M.mixHex('#000000', '#ffffff', 0), '#000000');
  assert.equal(M.mixHex('#000000', '#ffffff', 1), '#ffffff');
  assert.equal(M.mixHex('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(M.mixHex('#000000', '#ffffff', -3), '#000000', 'a factor below 0 clamps');
  assert.equal(M.mixHex('#000000', '#ffffff', 9), '#ffffff', 'a factor above 1 clamps');
  assert.equal(M.mixHex('#102030', '#102030', 0.4), '#102030');
  // A channel keeps its own lane (a byte-swapped implementation fails here).
  assert.equal(M.mixHex('#ff0000', '#0000ff', 0.5), '#800080');
});

test('a custom pair derives a dim step that really sits between the text and the ground', () => {
  const pairs: [string, string][] = [
    ['#000000', '#ffffff'],
    ['#101820', '#d8e0ff'],
    ['#f5f5f5', '#202020'], // a light ground with dark text: the order still holds
  ];
  for (const [ground, text] of pairs) {
    const c = M.coloursOf({ id: M.CUSTOM, ground, text });
    assert.equal(c.ground, ground);
    assert.equal(c.cmd, text, 'the bright step IS the chosen text colour');
    assert.equal(c.out, text, 'ground + text only: output shares the text colour');
    const between =
      (luma(text) > luma(ground) && luma(c.dim) < luma(text) && luma(c.dim) > luma(ground)) ||
      (luma(text) < luma(ground) && luma(c.dim) > luma(text) && luma(c.dim) < luma(ground));
    assert.ok(between, `dim ${c.dim} must sit between text ${text} and ground ${ground}`);
  }
});

test('matchPreset: a pair that IS a preset is recognised, case and space included', () => {
  const p = M.PRESETS[1] as Preset;
  const ground = T.GROUNDS[p.bg]?.hex as string;
  const text = T.RAMPS[p.fg]?.cmd as string;
  assert.equal(M.matchPreset(ground, text), p.id);
  assert.equal(M.matchPreset(ground.toUpperCase(), ` ${text} `), p.id);
  assert.equal(M.matchPreset(ground, '#123456'), null);
  assert.equal(M.matchPreset('#123456', text), null);
  assert.equal(M.matchPreset('#12345', text), null, 'an invalid hex matches nothing');
});

test('reduce: picking a preset replaces both values; an unknown id changes nothing', () => {
  const start = M.initialState();
  const p = M.PRESETS[2] as Preset;
  const next = M.reduce(start, { k: 'preset', id: p.id });
  assert.equal(next.id, p.id);
  assert.equal(next.ground, T.GROUNDS[p.bg]?.hex);
  assert.equal(next.text, T.RAMPS[p.fg]?.cmd);
  assert.deepEqual(M.reduce(start, { k: 'preset', id: 'nope' }), start);
  assert.deepEqual(M.reduce(start, { k: 'preset', id: M.CUSTOM }), start, 'CUSTOM is not a preset to pick');
});

test('reduce: a valid custom colour moves to CUSTOM and keeps the other half', () => {
  const start = M.initialState();
  const g = M.reduce(start, { k: 'ground', hex: '#123456' });
  assert.equal(g.id, M.CUSTOM);
  assert.equal(g.ground, '#123456');
  assert.equal(g.text, start.text, 'the text colour is untouched');
  const t = M.reduce(g, { k: 'text', hex: '#ABCDEF' });
  assert.equal(t.id, M.CUSTOM);
  assert.equal(t.ground, '#123456');
  assert.equal(t.text, '#abcdef', 'stored lower case');
});

test('reduce: an invalid hex changes NOTHING (the preview never shows what was not chosen)', () => {
  const s: TcState = { id: M.CUSTOM, ground: '#123456', text: '#abcdef' };
  for (const bad of ['', '#', '#12345', '#12345g', 'blue', 'rgb(1,2,3)']) {
    assert.deepEqual(M.reduce(s, { k: 'ground', hex: bad }), s, `ground ${JSON.stringify(bad)}`);
    assert.deepEqual(M.reduce(s, { k: 'text', hex: bad }), s, `text ${JSON.stringify(bad)}`);
  }
});

test('reduce: typing a preset’s own two values re-selects that card', () => {
  const p = M.PRESETS[3] as Preset;
  const ground = T.GROUNDS[p.bg]?.hex as string;
  const text = T.RAMPS[p.fg]?.cmd as string;
  let s = M.reduce(M.initialState(), { k: 'ground', hex: ground });
  assert.equal(s.id, M.CUSTOM, 'halfway there it is still custom');
  s = M.reduce(s, { k: 'text', hex: text });
  assert.equal(s.id, p.id, 'the pair IS that preset again');
});

test('reduce: Reset goes back to Nocturne from any state', () => {
  const custom: TcState = { id: M.CUSTOM, ground: '#010203', text: '#fefefe' };
  assert.deepEqual(M.reduce(custom, { k: 'reset' }), M.initialState());
  assert.deepEqual(
    M.reduce(M.reduce(M.initialState(), { k: 'preset', id: M.PRESETS[4]?.id as string }), { k: 'reset' }),
    M.initialState(),
  );
});
