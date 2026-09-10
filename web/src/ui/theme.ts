/**
 * UNWIRED SINCE PART A2 (2026-09-10): main.ts no longer calls initTheme — Nocturne is the only theme; part A8 deletes this file.
 *
 * Terminal theme popover (Legacy UI, handoff §9; removed in Nocturne part
 * A8): anchored under the topbar Theme button, two INDEPENDENT 5-column
 * swatch grids — 10 terminal grounds × 10 text ramps — plus the scanline
 * toggle (default OFF). Entry 0 of both grids is the Nocturne default.
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
 *
 * Server persistence: localStorage is a same-run CACHE only — the backend
 * binds a new OS-assigned port every run, so the page origin changes on
 * every restart and a fresh origin means a fresh localStorage bucket. The
 * durable copy lives server-side in prefs.json (an opaque `UiPrefs` bag —
 * see shared/protocol.ts), fetched once at boot by main.ts and handed to
 * initTheme() below. Boot order: apply the local cache immediately (no
 * flash of default), then reconcile against the server value (server wins
 * if different) — both happen synchronously before any terminal exists, so
 * in practice there is no visible repaint, just a correct first paint. Every
 * theme change writes localStorage AND fire-and-forgets a merged PUT
 * /api/prefs (read-modify-write: only the `theme` member is replaced, so
 * unknown keys — future settings — survive). Two windows changing the theme
 * concurrently is last-write-wins on the server; acceptable, not solved here.
 */
import { el, button } from './util.ts';
import { refreshAllTerminalThemes } from './terminal.ts';
import type { UiPrefs, UiTheme } from '../../../shared/protocol.ts';
import { updatePrefs } from '../api.ts';
import { log } from '../log.ts';
import {
  GROUNDS,
  RAMPS,
  clampTheme,
  isUiTheme,
  themeEquals,
  type Ground,
  type Ramp,
  type ThemeState,
} from './theme-model.ts';

const STORAGE_KEY = 'ai-sm:theme:v1';

/** The "Aa" text-ramp swatches always render over the Nocturne ground. */
const SWATCH_GROUND = '#0b0d14';

function loadState(): ThemeState {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    parsed = null;
  }
  return clampTheme((parsed ?? {}) as Record<string, unknown>);
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
 *
 * `serverPrefs` is the prefs bag main.ts already fetched (as part of its
 * boot hydrate, GET /api/prefs — undefined if that fetch failed, which is
 * non-fatal here too: the local cache just stands uncorrected). It is
 * consumed once, here at init, to correct the local cache; it is NOT retained.
 * Later theme writes preserve other bag keys (e.g. the settings panel's
 * `statusLine`) via api.updatePrefs's merge-on-write (GET current bag →
 * shallow-merge only `theme` → PUT), not by holding this bag.
 */
export function initTheme(
  host: HTMLElement,
  anchor: HTMLElement,
  serverPrefs?: UiPrefs,
): ThemePopover {
  const state = loadState();
  apply(state); // Local cache first — no flash of default.

  // serverPrefs crossed a JSON boundary: treat a null/non-object value as
  // absent rather than trusting the static type (a null bag would throw on
  // the `.theme` read below).
  const bag: UiPrefs | undefined =
    typeof serverPrefs === 'object' && serverPrefs !== null ? serverPrefs : undefined;
  if (bag !== undefined && isUiTheme(bag.theme)) {
    const fromServer = clampTheme(bag.theme as unknown as Record<string, unknown>);
    if (!themeEquals(fromServer, state)) {
      // Server wins: correct the cache and repaint via the same apply() path
      // used for every live theme change. This runs before any terminal is
      // constructed (see the ordering note in main.ts), so there is no
      // visible flash — just a correct first paint.
      state.bg = fromServer.bg;
      state.fg = fromServer.fg;
      state.scan = fromServer.scan;
      saveState(state);
      apply(state);
    }
  }

  /**
   * Save locally AND fire-and-forget a merged PUT via api.updatePrefs
   * (GET current bag → shallow-merge only `theme` → PUT), so the settings
   * panel's `statusLine` key and any other bag key survive a theme write.
   */
  function persist(): void {
    saveState(state);
    const theme: UiTheme = { bg: state.bg, fg: state.fg, scan: state.scan };
    log.debug(`theme: bg=${theme.bg} fg=${theme.fg} scan=${theme.scan}`);
    void updatePrefs({ theme }).catch(() => {
      // Non-fatal: localStorage already holds the value; the server copy just
      // falls behind until the next successful write.
    });
  }

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
    persist();
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
    persist();
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
