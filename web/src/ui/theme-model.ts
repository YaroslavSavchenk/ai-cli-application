/**
 * Pure data + logic behind the terminal colours the user picks on Settings →
 * Terminal colours (ui/theme.ts applies them, ui/term-colours.ts draws the
 * page). Two things live here: the palette TABLES the six presets are built
 * from, and the clamp that turns an arbitrary stored value into a pair this
 * app can paint with.
 *
 * THE PERSISTED SHAPE IS A HEX PAIR (Nocturne B9, 2026-09-22): a ground and
 * the bright text step, both `#rrggbb` lower-case. The preset is not stored —
 * `matchPreset` in ui/term-colours-model.ts recovers it — so renaming a preset
 * can never silently change somebody's colours. The Legacy shape
 * (`{ bg, fg, scan }`, indexes into the two tables below) is still READ, one
 * member at a time, so a prefs.json written before that date keeps its
 * meaning; it is never written again, and `scan` — the Legacy scanline flag
 * nothing has rendered since A8 — is simply dropped.
 *
 * Entry 0 of each table is the DEFAULT and carries the Nocturne palette since
 * 2026-09-10; the remaining entries are the Legacy UI's handoff tables.
 * Deliberately DOM-free — no xterm, no document — so it stays importable under
 * `node --test`; theme.ts remains the sole owner of applying a pair to :root
 * and to the live terminals.
 */
import type { UiTheme } from '../../../shared/protocol.ts';

export interface Ground {
  name: string;
  hex: string;
}

export interface Ramp {
  name: string;
  cmd: string;
  out: string;
  dim: string;
}

/**
 * Terminal backgrounds. Entry 0 is the DEFAULT (clampTheme falls back to it)
 * and since 2026-09-10 it is the Nocturne ground `--color-term`
 * (oklch(0.16 0.015 275) = #0b0d14), replacing the Legacy UI's charcoal in
 * place so persisted indexes stay valid. The rest are the Legacy handoff's
 * "Terminal backgrounds" — exact values; the popover that rendered them was
 * deleted in A8, and since B9 the Settings page's presets index this table.
 */
export const GROUNDS: Ground[] = [
  { name: 'nocturne', hex: '#0b0d14' },
  { name: 'void', hex: '#07090c' },
  { name: 'deep blue', hex: '#0a1220' },
  { name: 'navy', hex: '#0d1526' },
  { name: 'ocean', hex: '#081a1f' },
  { name: 'forest', hex: '#0a1510' },
  { name: 'moss', hex: '#10160e' },
  { name: 'plum', hex: '#150f1c' },
  { name: 'graphite', hex: '#141414' },
  { name: 'espresso', hex: '#161010' },
];

/**
 * Terminal text ramps (cmd / out / dim). Entry 0 is the DEFAULT and since
 * 2026-09-10 it is the Nocturne neutral ramp (--color-text / neutral-300 /
 * neutral-600), matching the --xt-* tokens; the rest are the Legacy
 * handoff's ramps — exact values. A preset's `out` and `dim` are the two
 * quieter steps its terminal really draws with.
 */
export const RAMPS: Ramp[] = [
  { name: 'nocturne', cmd: '#e9e9ed', out: '#cfd3e5', dim: '#75798c' },
  { name: 'phosphor', cmd: '#d8ffd8', out: '#7ee787', dim: '#3f7a4a' },
  { name: 'amber', cmd: '#ffe9c4', out: '#e8b24a', dim: '#8a6a2f' },
  { name: 'ice', cmd: '#e8f4ff', out: '#8fc7f2', dim: '#4a6f8a' },
  { name: 'paper', cmd: '#ffffff', out: '#e2e6ea', dim: '#8a9099' },
  { name: 'cyan', cmd: '#dafcff', out: '#66d9e8', dim: '#3a7a83' },
  { name: 'violet', cmd: '#efe6ff', out: '#b39df2', dim: '#6a5a8f' },
  { name: 'ember', cmd: '#ffe3d6', out: '#f0956a', dim: '#8f5a44' },
  { name: 'steel', cmd: '#e6e9ec', out: '#9aa7b4', dim: '#5a6570' },
  { name: 'mint', cmd: '#e2fff4', out: '#7fe0bb', dim: '#468a72' },
];

/** A six-digit hex colour, case-insensitive. Shorthand and alpha forms are not accepted: the two Settings fields round-trip through a native colour input, which always writes six digits. */
export function isHex6(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(s);
}

/** `#RRGGBB` → `#rrggbb`, or null when it is not a six-digit hex colour. */
export function normHex(s: string): string | null {
  const t = s.trim();
  return isHex6(t) ? t.toLowerCase() : null;
}

/**
 * The terminal colours in force: the ground and the BRIGHT text step. The two
 * quieter steps are derived (ui/term-colours-model.ts `coloursOf`) — a preset
 * takes them from its own ramp, a custom pair pulls them out of the text
 * colour — so nothing else has to be stored or asked for.
 */
export interface ThemeState {
  ground: string;
  text: string;
}

/** The default: the stylesheet's own terminal ground and bright step. */
export const NOCTURNE: ThemeState = {
  ground: (GROUNDS[0] as Ground).hex,
  text: (RAMPS[0] as Ramp).cmd,
};

/** A valid index into a table of `max` entries. */
function idx(v: unknown, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < max ? v : null;
}

/**
 * Clamp an arbitrary (localStorage- or server-sourced) value into a pair this
 * app can paint with. Each member is read INDEPENDENTLY, v2 first and the
 * Legacy index second, so half a stored value is still worth something:
 *
 *   { ground, text }   a hex pair    → normalised to lower case
 *   { bg, fg }         Legacy        → GROUNDS[bg].hex / RAMPS[fg].cmd
 *   anything else                    → the Nocturne member
 */
export function clampTheme(raw: unknown): ThemeState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...NOCTURNE };
  const o = raw as Record<string, unknown>;
  const ground = typeof o.ground === 'string' ? normHex(o.ground) : null;
  const text = typeof o.text === 'string' ? normHex(o.text) : null;
  const bg = idx(o.bg, GROUNDS.length);
  const fg = idx(o.fg, RAMPS.length);
  return {
    ground: ground ?? (bg === null ? NOCTURNE.ground : (GROUNDS[bg] as Ground).hex),
    text: text ?? (fg === null ? NOCTURNE.text : (RAMPS[fg] as Ramp).cmd),
  };
}

export function themeEquals(a: ThemeState, b: ThemeState): boolean {
  return a.ground === b.ground && a.text === b.text;
}

/**
 * The default pair, which theme.ts paints by REMOVING its overrides rather
 * than writing them — so Nocturne is exactly what tokens.css says, down to
 * `--xt-bright-white: #f3f5fe`, a step no ramp carries.
 */
export function isNocturne(s: ThemeState): boolean {
  return themeEquals(s, NOCTURNE);
}

/**
 * True when a prefs bag's `theme` member carries something this module can
 * READ — either shape, at least one member. A bag without it, or with an
 * unreadable one, is no opinion at all: the caller keeps the local choice
 * rather than resetting a user's terminals because of a garbage value.
 */
export function isUiTheme(t: unknown): t is UiTheme {
  if (t === null || typeof t !== 'object' || Array.isArray(t)) return false;
  const o = t as Record<string, unknown>;
  const hex = (v: unknown): boolean => typeof v === 'string' && normHex(v) !== null;
  return hex(o.ground) || hex(o.text) || idx(o.bg, GROUNDS.length) !== null || idx(o.fg, RAMPS.length) !== null;
}

/** The pair a prefs bag asks for, or null when it asks for nothing readable. */
export function themeFromBag(raw: unknown): ThemeState | null {
  return isUiTheme(raw) ? clampTheme(raw) : null;
}
