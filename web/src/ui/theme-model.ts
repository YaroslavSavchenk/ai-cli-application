/**
 * UNWIRED SINCE PART A2 (2026-09-10): its only consumer, ui/theme.ts, is no longer called from main.ts; part A8 deletes both.
 *
 * Pure data + logic behind the terminal theme popover (ui/theme.ts):
 * the palette tables and the validation/comparison helpers for the
 * persisted selection. Entry 0 of each table is the DEFAULT and carries the
 * Nocturne palette since 2026-09-10; the remaining entries are the Legacy
 * UI's handoff tables, kept so persisted indexes keep their meaning until
 * the popover is removed (Nocturne part A8). Deliberately DOM-free — no
 * xterm, no document — so it stays importable under `node --test`; theme.ts
 * remains the sole owner of applying a theme to :root and the live
 * terminals.
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
 * "Terminal backgrounds" — exact values; the whole popover goes away in A8.
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
 * handoff's ramps — exact values.
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

export interface ThemeState {
  bg: number;
  fg: number;
  scan: boolean;
}

/** Clamp an arbitrary (localStorage- or server-sourced) object into a valid ThemeState. */
export function clampTheme(o: Record<string, unknown>): ThemeState {
  const idx = (v: unknown, max: number): number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < max ? v : 0;
  return {
    bg: idx(o.bg, GROUNDS.length),
    fg: idx(o.fg, RAMPS.length),
    scan: o.scan === true,
  };
}

export function themeEquals(a: ThemeState, b: ThemeState): boolean {
  return a.bg === b.bg && a.fg === b.fg && a.scan === b.scan;
}

/** True when `t` has the exact shape persisted by ui/theme.ts (see UiTheme). */
export function isUiTheme(t: unknown): t is UiTheme {
  if (t === null || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  return typeof o.bg === 'number' && typeof o.fg === 'number' && typeof o.scan === 'boolean';
}
