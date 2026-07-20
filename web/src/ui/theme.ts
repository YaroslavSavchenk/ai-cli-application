/**
 * Terminal theme popover (handoff §9): anchored under the topbar Theme
 * button, two INDEPENDENT 5-column swatch grids — 10 terminal grounds × 10
 * text ramps — plus the scanline toggle (default OFF).
 *
 * Implementation contract: selections write the existing --term-bg / --xt-*
 * custom properties inline on :root, so themeFromTokens() in ui/terminal.ts
 * remains the single ITheme source. refreshAllTerminalThemes() then updates
 * every LIVE terminal in place, and pane cards follow the ground via
 * var(--term-bg). Ramp mapping: out -> xterm foreground/white, cmd ->
 * brightWhite + cursor (bold/bright), dim -> brightBlack (faint). Status
 * colors (green/amber/red ANSI + dots) are semantic and NEVER themed.
 *
 * Persisted under its own localStorage key — deliberately separate from the
 * UI-arrangement schema (no version bump there).
 */
import { el, button } from './util.ts';
import { refreshAllTerminalThemes } from './terminal.ts';

const STORAGE_KEY = 'ai-sm:theme:v1';

interface Ground {
  name: string;
  hex: string;
}

interface Ramp {
  name: string;
  cmd: string;
  out: string;
  dim: string;
}

/** Handoff "Terminal backgrounds" — exact values. */
const GROUNDS: Ground[] = [
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
const RAMPS: Ramp[] = [
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

/** The "Aa" text-ramp swatches always render over the charcoal ground. */
const SWATCH_GROUND = '#0e1116';

interface ThemeState {
  bg: number;
  fg: number;
  scan: boolean;
}

function loadState(): ThemeState {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    parsed = null;
  }
  const o = (parsed ?? {}) as Record<string, unknown>;
  const idx = (v: unknown, max: number): number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < max ? v : 0;
  return {
    bg: idx(o.bg, GROUNDS.length),
    fg: idx(o.fg, RAMPS.length),
    scan: o.scan === true,
  };
}

function saveState(s: ThemeState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable — the theme just won't survive reload.
  }
}

/** Write the selection onto :root and refresh every live terminal. */
function apply(s: ThemeState): void {
  const g = GROUNDS[s.bg] ?? (GROUNDS[0] as Ground);
  const r = RAMPS[s.fg] ?? (RAMPS[0] as Ramp);
  const root = document.documentElement;
  root.style.setProperty('--term-bg', g.hex); // pane cards + xterm bg follow
  root.style.setProperty('--xt-fg', r.out);
  root.style.setProperty('--xt-white', r.out);
  root.style.setProperty('--xt-bright-white', r.cmd);
  root.style.setProperty('--xt-cursor', r.cmd);
  root.style.setProperty('--xt-bright-black', r.dim);
  root.classList.toggle('scanlines-on', s.scan);
  refreshAllTerminalThemes();
}

export interface ThemePopover {
  toggle(): void;
  close(): void;
  isOpen(): boolean;
}

/**
 * Build the popover (hidden) and apply the persisted theme immediately —
 * main.ts calls this BEFORE initPanes so terminals are born themed.
 */
export function initTheme(host: HTMLElement, anchor: HTMLElement): ThemePopover {
  const state = loadState();
  apply(state);

  const pop = el('div', 'theme-pop');
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'terminal theme');

  const bgButtons: HTMLButtonElement[] = [];
  const fgButtons: HTMLButtonElement[] = [];

  function markSelected(): void {
    bgButtons.forEach((b, i) => {
      b.classList.toggle('is-sel', i === state.bg);
      b.setAttribute('aria-pressed', i === state.bg ? 'true' : 'false');
    });
    fgButtons.forEach((b, i) => {
      b.classList.toggle('is-sel', i === state.fg);
      b.setAttribute('aria-pressed', i === state.fg ? 'true' : 'false');
    });
  }

  function pick(kind: 'bg' | 'fg', i: number): void {
    if (kind === 'bg') state.bg = i;
    else state.fg = i;
    saveState(state);
    apply(state);
    markSelected();
  }

  pop.append(el('div', 'theme-lb', 'TERMINAL BACKGROUND'));
  const bgGrid = el('div', 'theme-grid');
  GROUNDS.forEach((g, i) => {
    const b = button('theme-sw', '', () => pick('bg', i));
    b.style.background = g.hex; // swatch IS the data — the one sanctioned inline color
    b.title = g.name;
    b.setAttribute('aria-label', `terminal background: ${g.name}`);
    bgButtons.push(b);
    bgGrid.append(b);
  });
  pop.append(bgGrid);

  pop.append(el('div', 'theme-lb', 'TEXT COLOR'));
  const fgGrid = el('div', 'theme-grid');
  RAMPS.forEach((r, i) => {
    const b = button('theme-sw theme-sw-fg', 'Aa', () => pick('fg', i));
    b.style.background = SWATCH_GROUND;
    b.style.color = r.out; // "Aa" in the ramp's out shade, per handoff
    b.title = r.name;
    b.setAttribute('aria-label', `text color: ${r.name}`);
    fgButtons.push(b);
    fgGrid.append(b);
  });
  pop.append(fgGrid);

  const scanRow = el('label', 'theme-scan');
  const scanCb = el('input') as HTMLInputElement;
  scanCb.type = 'checkbox';
  scanCb.checked = state.scan;
  scanRow.append(scanCb, el('span', '', 'scanlines'));
  scanCb.addEventListener('change', () => {
    state.scan = scanCb.checked;
    saveState(state);
    apply(state);
  });
  pop.append(scanRow);

  pop.append(el('div', 'theme-note', 'background and text are independent · status colors stay'));

  markSelected();
  host.append(pop);

  function onDocDown(e: PointerEvent): void {
    if (!(e.target instanceof Node)) return;
    if (pop.contains(e.target) || anchor.contains(e.target)) return;
    close();
  }

  function open(): void {
    if (!pop.hidden) return;
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
    pop.style.right = `${Math.round(window.innerWidth - r.right)}px`;
    pop.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDocDown, true);
    (bgButtons[state.bg] ?? bgButtons[0])?.focus();
  }

  function close(): void {
    if (pop.hidden) return;
    pop.hidden = true;
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDocDown, true);
    anchor.focus();
  }

  return {
    toggle: () => (pop.hidden ? open() : close()),
    close,
    isOpen: () => !pop.hidden,
  };
}
