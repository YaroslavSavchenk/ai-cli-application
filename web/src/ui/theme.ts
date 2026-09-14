/**
 * Terminal colours — the machinery, with no UI of its own.
 *
 * UNWIRED: nothing imports this module yet. The Legacy theme popover that
 * used to own it (a topbar button, two swatch grids, a scanline toggle) was
 * unwired in Nocturne A2 and DELETED in A8, together with its `.theme-*`
 * rules. What is left is exactly the part part B9 needs: load the stored
 * choice, apply it, reconcile it with the server copy, persist a new one.
 * B9 wires `initTheme()` into main.ts's boot (before `initPanes`, so
 * terminals are born themed) and hands the Terminal colours Settings page
 * the `apply()` it returns.
 *
 * Implementation contract: a selection writes the existing --term-bg / --xt-*
 * custom properties inline on :root, so themeFromTokens() in ui/terminal.ts
 * remains the single ITheme source. refreshAllTerminalThemes() then updates
 * every LIVE terminal in place, and pane cards follow the ground via
 * var(--term-bg). Ramp mapping: out -> xterm foreground/white, cmd ->
 * brightWhite + cursor (bold/bright), dim -> brightBlack (faint). Status
 * colours (green/amber/red ANSI + dots) are semantic and NEVER themed.
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
 *
 * `UiTheme.scan` (the Legacy scanline flag) is still read and written so a
 * stored bag survives a round trip untouched, but nothing renders it: A8
 * dropped the `scanlines-on` class, which no stylesheet ever defined. Whether
 * the protocol field stays is part B9's call, not A8's.
 */
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
  refreshAllTerminalThemes();
}

/** What a caller (part B9's Terminal colours page) gets to do. */
export interface ThemeControl {
  /** Apply a new selection, persist it locally and on the server. */
  apply(next: ThemeState): void;
  /** The selection in force right now (a copy — the state stays private). */
  current(): ThemeState;
}

/**
 * Apply the persisted theme and return the one control the Settings page
 * drives. Call it BEFORE the first terminal exists, so terminals are born
 * themed.
 *
 * `serverPrefs` is the prefs bag main.ts already fetched (as part of its
 * boot hydrate, GET /api/prefs — undefined if that fetch failed, which is
 * non-fatal here too: the local cache just stands uncorrected). It is
 * consumed once, here at init, to correct the local cache; it is NOT retained.
 * Later theme writes preserve other bag keys (e.g. the settings panel's
 * `statusLine`) via api.updatePrefs's merge-on-write (GET current bag →
 * shallow-merge only `theme` → PUT), not by holding this bag.
 */
export function initTheme(serverPrefs?: UiPrefs): ThemeControl {
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

  return {
    apply(next: ThemeState): void {
      const clamped = clampTheme(next as unknown as Record<string, unknown>);
      if (themeEquals(clamped, state)) return;
      state.bg = clamped.bg;
      state.fg = clamped.fg;
      state.scan = clamped.scan;
      persist();
      apply(state);
    },
    current(): ThemeState {
      return { bg: state.bg, fg: state.fg, scan: state.scan };
    },
  };
}
