/**
 * Pure data + logic behind the terminal theme popover (ui/theme.ts):
 * the handoff palette tables and the validation/comparison helpers for the
 * persisted selection. Deliberately DOM-free — no xterm, no document — so it
 * stays importable under `node --test`; theme.ts remains the sole owner of
 * applying a theme to :root and the live terminals.
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

/** Handoff "Terminal backgrounds" — exact values. */
export const GROUNDS: Ground[] = [
  { name: 'charcoal', hex: '#0e1116' },
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

/** Handoff "Terminal text ramps" — exact values (cmd / out / dim). */
export const RAMPS: Ramp[] = [
  { name: 'default', cmd: '#e6edf3', out: '#b7c2cd', dim: '#66788a' },
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
