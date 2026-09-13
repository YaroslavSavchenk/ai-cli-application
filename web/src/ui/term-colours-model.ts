/**
 * Pure model behind the Settings page "Terminal colours" (Nocturne A7; the
 * page goes LIVE in part B9).
 *
 * DOM-free on purpose — no document, no xterm — so `node --test` imports it
 * directly, in the same spirit as statusline-model.ts / theme-model.ts. The
 * page itself (ui/term-colours.ts) owns every element and every inline colour;
 * this file owns the preset table, hex validation, the derived preview ramp and
 * the state reducer.
 *
 * DECIDED SHAPE (user, 2026-09-13, plan open decision 10): presets plus a
 * custom ground and text; ground and text ONLY, never the full ANSI palette;
 * the terminal only — app chrome, the accent and the three status colours
 * (running / attention / danger) are never themed; a Settings page, no top-bar
 * switch.
 *
 * WHY THE PRESETS ARE INDEX PAIRS INTO theme-model.ts. Those two tables
 * (GROUNDS, RAMPS) are the ones part B9 hands to `themeFromTokens()` through
 * ui/theme.ts, and entry 0 of each IS Nocturne. Composing the presets from
 * them means this page previews the exact hexes a terminal will be painted
 * with, and B9 can persist a preset as the pair it already stores.
 */
import { GROUNDS, RAMPS } from './theme-model.ts';

/** A named ground + ramp pair, as a card on the Schemes row. */
export interface Preset {
  readonly id: string;
  readonly name: string;
  /** Index into GROUNDS (theme-model.ts). */
  readonly bg: number;
  /** Index into RAMPS (theme-model.ts). */
  readonly fg: number;
}

/**
 * Nocturne FIRST and default; the rest are pairs from the same two tables,
 * each one a scheme a terminal user would recognise. Six is deliberate: the
 * row is a shelf of choices, not a palette browser.
 */
export const PRESETS: readonly Preset[] = [
  { id: 'nocturne', name: 'Nocturne', bg: 0, fg: 0 },
  { id: 'phosphor', name: 'Phosphor on void', bg: 1, fg: 1 },
  { id: 'amber', name: 'Amber on espresso', bg: 9, fg: 2 },
  { id: 'ice', name: 'Ice on deep blue', bg: 2, fg: 3 },
  { id: 'paper', name: 'Paper on graphite', bg: 8, fg: 4 },
  { id: 'violet', name: 'Violet on plum', bg: 7, fg: 6 },
];

/** The id the state carries while the two custom fields disagree with every preset. */
export const CUSTOM = 'custom';

/** The default preset id — "Reset to Nocturne" goes back to exactly this. */
export const DEFAULT_PRESET = 'nocturne';

/**
 * What the page draws: the ground plus the three text steps a terminal really
 * uses (a bright line, ordinary output, and something quiet).
 */
export interface TcColours {
  ground: string;
  cmd: string;
  out: string;
  dim: string;
}

/**
 * The page's whole state. `text` is the BRIGHT step — the one the custom Text
 * field edits; a preset's other two steps come from its ramp, and a custom
 * pair derives them (see `coloursOf`).
 */
export interface TcState {
  /** A preset id, or CUSTOM when the pair matches none. */
  id: string;
  ground: string;
  text: string;
}

export type TcAction =
  | { k: 'preset'; id: string }
  | { k: 'ground'; hex: string }
  | { k: 'text'; hex: string }
  | { k: 'reset' };

export function presetOf(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** The ground hex of a preset (GROUNDS is the owner of the value). */
function groundOf(p: Preset): string {
  return GROUNDS[p.bg]?.hex ?? (GROUNDS[0] as { hex: string }).hex;
}

function rampOf(p: Preset): { cmd: string; out: string; dim: string } {
  return RAMPS[p.fg] ?? (RAMPS[0] as { cmd: string; out: string; dim: string });
}

/** A `#rrggbb` string, case-insensitive. Three-digit and eight-digit forms are NOT accepted: the two fields round-trip through a native colour input, which always writes six. */
export function isHex6(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(s);
}

/** `#RRGGBB` → `#rrggbb`, or null when it is not a six-digit hex colour. */
export function normHex(s: string): string | null {
  const t = s.trim();
  return isHex6(t) ? t.toLowerCase() : null;
}

/**
 * `a` blended `t` of the way towards `b`, per channel, rounded. Used for ONE
 * thing: a custom pair has a single text colour, and a terminal still needs a
 * quiet step — so the dim line is the text colour pulled towards the ground.
 * An honest derivation beats asking for a third colour nobody thinks about.
 */
export function mixHex(a: string, b: string, t: number): string {
  const ca = normHex(a);
  const cb = normHex(b);
  if (ca === null || cb === null) return ca ?? cb ?? '#000000';
  // A non-numeric factor clamps to NaN, not to a bound — `Math.min(1,
  // Math.max(0, NaN))` is NaN and would render `#NaNNaNNaN`. Unreachable from
  // the page today (the only caller passes the constant DIM_MIX), pinned here
  // so an exported helper can never hand a caller a colour that is not one.
  const f = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  let out = '#';
  for (let i = 1; i < 7; i += 2) {
    const x = parseInt(ca.slice(i, i + 2), 16);
    const y = parseInt(cb.slice(i, i + 2), 16);
    out += Math.round(x + (y - x) * f)
      .toString(16)
      .padStart(2, '0');
  }
  return out;
}

/** How far a custom text colour is pulled towards the ground for the dim step. */
const DIM_MIX = 0.55;

/** The four colours the preview paints for a state. */
export function coloursOf(s: TcState): TcColours {
  const p = presetOf(s.id);
  if (p !== undefined) {
    const r = rampOf(p);
    return { ground: groundOf(p), cmd: r.cmd, out: r.out, dim: r.dim };
  }
  return {
    ground: s.ground,
    cmd: s.text,
    out: s.text,
    dim: mixHex(s.text, s.ground, DIM_MIX),
  };
}

/** The four colours a PRESET paints, by id (the Schemes cards' own swatches). */
export function presetColours(id: string): TcColours {
  return coloursOf(fromPreset(id));
}

/** The preset a ground+text pair IS, or null — so typing Nocturne's own two values re-selects its card. */
export function matchPreset(ground: string, text: string): string | null {
  const g = normHex(ground);
  const t = normHex(text);
  if (g === null || t === null) return null;
  const hit = PRESETS.find(
    (p) => normHex(groundOf(p)) === g && normHex(rampOf(p).cmd) === t,
  );
  return hit?.id ?? null;
}

/** The page's opening state: the default preset, with its own two values in the custom fields. */
export function initialState(): TcState {
  return fromPreset(DEFAULT_PRESET);
}

function fromPreset(id: string): TcState {
  const p = presetOf(id) ?? (PRESETS[0] as Preset);
  return { id: p.id, ground: groundOf(p), text: rampOf(p).cmd };
}

/**
 * The reducer. An invalid hex changes NOTHING — the field keeps the half-typed
 * text and flags itself; the preview never shows a colour that was not chosen.
 * A valid pair that equals a preset re-selects that preset's card instead of
 * silently sitting on CUSTOM.
 */
export function reduce(s: TcState, a: TcAction): TcState {
  switch (a.k) {
    case 'reset':
      return fromPreset(DEFAULT_PRESET);
    case 'preset':
      return presetOf(a.id) === undefined ? s : fromPreset(a.id);
    case 'ground': {
      const g = normHex(a.hex);
      if (g === null) return s;
      return { id: matchPreset(g, s.text) ?? CUSTOM, ground: g, text: s.text };
    }
    case 'text': {
      const t = normHex(a.hex);
      if (t === null) return s;
      return { id: matchPreset(s.ground, t) ?? CUSTOM, ground: s.ground, text: t };
    }
  }
}
