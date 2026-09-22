/**
 * Terminal colours — the machinery, with no UI of its own.
 *
 * WHAT IT DOES. It owns the six `:root` custom properties that decide what a
 * terminal is painted with, the localStorage cache of the choice, and the
 * server copy in the prefs bag. The Settings page (ui/term-colours.ts) drives
 * it through the `ThemeControl` returned below and knows nothing else about
 * terminals; main.ts calls `initTheme()` in `buildShell` BEFORE `initPanes`,
 * so every terminal is born in the right colours instead of repainting.
 *
 * WHAT A PAIR PAINTS. The persisted state is a ground + bright-text pair
 * (theme-model.ts); `coloursOf` in term-colours-model.ts — the same function
 * the page's preview uses — derives the four colours from it, and they land on
 * :root as --term-bg (ground), --xt-fg / --xt-white (out), --xt-bright-white /
 * --xt-cursor (cmd) and --xt-bright-black (dim). `themeFromTokens()` in
 * ui/terminal.ts stays the single ITheme source: it re-reads those tokens, and
 * `refreshAllTerminalThemes()` hands the result to every LIVE terminal in
 * place. The pane card follows the ground through var(--term-bg) in CSS.
 * NOCTURNE IS THE ABSENCE OF AN OVERRIDE: the default pair REMOVES all six
 * properties instead of writing them, so the default is exactly what
 * tokens.css says (--xt-bright-white is #f3f5fe there, a step no ramp
 * carries) and the tokens file stays the one source of it. The ANSI hues, the
 * selection colour and the three status colours are semantic and NEVER themed.
 *
 * WHERE THE CHOICE LIVES. localStorage (`ai-sm:theme:v1`) is the local copy,
 * written immediately so the next paint of this window is instant and a reload
 * never flashes the default. It is not the durable one: a fallback port (the
 * sticky port from B6 was busy that run) or a cleared browser profile loses the
 * bucket. The durable copy is the `theme` key of prefs.json (an opaque UiPrefs
 * bag — see shared/protocol.ts), fetched once at boot by main.ts and handed in
 * here. Boot order: apply the cache, then let the server value win if it
 * differs — both before any terminal exists, so it is a correct first paint,
 * not a repaint.
 *
 * WHY THE SERVER WRITE IS DEBOUNCED AND SERIALISED. `api.updatePrefs` is a
 * read-modify-write (GET the bag → replace only `theme` → PUT), so dragging
 * the native colour swatch would otherwise fire dozens of interleaving
 * round trips and the last PUT would not necessarily carry the last colour.
 * A change starts a ~300ms trailing timer; at most one request is ever in
 * flight, and a change during a flight queues exactly one follow-up carrying
 * the latest pair. `flush()` sends a pending write now — the Settings dialog
 * closes on it, so a choice is durable by the time the panel is gone. Two
 * windows changing the theme concurrently is last-write-wins on the server;
 * the panel's re-read on open is what makes the other window notice — through
 * `adopt()`, which paints and caches that answer without writing it back and
 * ignores it entirely while a write of ours is still scheduled or in flight.
 * Every write passes DEAD_PREFS_KEYS, like the settings panel's: the two
 * retired keys must not be resurrected by whichever writer goes last.
 */
import { refreshAllTerminalThemes } from './terminal.ts';
import type { UiPrefs, UiTheme } from '../../../shared/protocol.ts';
import { updatePrefs } from '../api.ts';
import { log } from '../log.ts';
import { clampTheme, isNocturne, themeEquals, themeFromBag, type ThemeState } from './theme-model.ts';
import { coloursOf, stateOf } from './term-colours-model.ts';
import { DEAD_PREFS_KEYS } from './statusline-model.ts';

const STORAGE_KEY = 'ai-sm:theme:v1';

/** How long a change waits before it costs a server round trip. */
const WRITE_DELAY_MS = 300;

function loadState(): ThemeState {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    parsed = null;
  }
  // The same clamp as the server value: the cache accepts both the pair and the
  // Legacy index shape, so an old bucket keeps its meaning without a key bump.
  return clampTheme(parsed);
}

function saveState(s: ThemeState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable — the theme just won't survive reload.
  }
}

/**
 * Write the pair onto :root and refresh every live terminal. The default pair
 * REMOVES the overrides rather than writing them, so Nocturne is the
 * stylesheet's own tokens and never a copy of them.
 */
function apply(s: ThemeState): void {
  const root = document.documentElement;
  if (isNocturne(s)) {
    root.style.removeProperty('--term-bg');
    root.style.removeProperty('--xt-fg');
    root.style.removeProperty('--xt-white');
    root.style.removeProperty('--xt-bright-white');
    root.style.removeProperty('--xt-cursor');
    root.style.removeProperty('--xt-bright-black');
  } else {
    const c = coloursOf(stateOf(s));
    root.style.setProperty('--term-bg', c.ground); // pane card + xterm bg follow
    root.style.setProperty('--xt-fg', c.out);
    root.style.setProperty('--xt-white', c.out);
    root.style.setProperty('--xt-bright-white', c.cmd);
    root.style.setProperty('--xt-cursor', c.cmd);
    root.style.setProperty('--xt-bright-black', c.dim);
  }
  refreshAllTerminalThemes();
}

/** What a caller (the Terminal colours Settings page) gets to do. */
export interface ThemeControl {
  /** Apply a new pair, cache it locally at once and persist it server-side. */
  apply(next: ThemeState): void;
  /**
   * Take a pair that CAME from the server (the Settings panel's re-read on
   * open): paint it and cache it locally, but never write it back — and do
   * nothing at all while a write of ours is scheduled or in flight, because
   * that answer was read before the choice this window just made.
   */
  adopt(next: ThemeState): void;
  /** The pair in force right now (a copy — the state stays private). */
  current(): ThemeState;
  /** Send a pending server write NOW and settle when nothing is left in flight. */
  flush(): Promise<void>;
}

/**
 * Apply the persisted theme and return the one control the Settings page
 * drives. Call it BEFORE the first terminal exists, so terminals are born
 * themed.
 *
 * `serverPrefs` is the prefs bag main.ts already fetched (as part of its boot
 * hydrate, GET /api/prefs — undefined if that fetch failed, which is non-fatal
 * here too: the local cache just stands uncorrected). It is consumed once,
 * here at init, to correct the local cache; it is NOT retained. Later theme
 * writes preserve other bag keys (e.g. the settings panel's `statusLine`) via
 * api.updatePrefs's merge-on-write, not by holding this bag.
 */
export function initTheme(serverPrefs?: UiPrefs): ThemeControl {
  let state = loadState();
  apply(state); // Local cache first — no flash of default.

  // serverPrefs crossed a JSON boundary: treat a null/non-object value as
  // absent rather than trusting the static type (a null bag would throw on
  // the `.theme` read below).
  const bag: UiPrefs | undefined =
    typeof serverPrefs === 'object' && serverPrefs !== null ? serverPrefs : undefined;
  const fromServer = bag === undefined ? null : themeFromBag(bag.theme);
  if (fromServer !== null && !themeEquals(fromServer, state)) {
    // Server wins: correct the cache and repaint through the same apply() path
    // every live change uses. This runs before any terminal is constructed (see
    // the ordering note in main.ts), so there is no visible flash — just a
    // correct first paint.
    state = fromServer;
    saveState(state);
    apply(state);
  }

  // ---- the server write: trailing-debounced, and one in flight at a time ----
  // `pending` is the ONLY queue there is: a burst collapses into the latest
  // pair, which is the only one worth writing.
  let pending: ThemeState | null = null;
  let timer: number | null = null;
  let inFlight: Promise<void> | null = null;

  function send(): void {
    const s = pending;
    if (s === null) return;
    pending = null;
    const theme: UiTheme = { ground: s.ground, text: s.text };
    log.debug(`theme: ground=${theme.ground} text=${theme.text}`);
    const done = updatePrefs({ theme }, DEAD_PREFS_KEYS).catch(() => {
      // Non-fatal: localStorage already holds the value; the server copy just
      // falls behind until the next successful write.
    });
    inFlight = done.then(() => {
      inFlight = null;
      // A change that arrived mid-flight is the queued follow-up: send it now,
      // with whatever the latest pair turned out to be.
      if (pending !== null) send();
    });
  }

  function schedule(s: ThemeState): void {
    pending = { ...s };
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      // Busy: the in-flight write's own continuation picks `pending` up, so
      // starting a second request here is exactly what must not happen.
      if (inFlight === null) send();
    }, WRITE_DELAY_MS);
  }

  async function flush(): Promise<void> {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    if (inFlight === null) send();
    // The continuation of one write can start the queued follow-up, so drain
    // rather than await once.
    while (inFlight !== null) await inFlight;
  }

  // The module-level painter, under a name the control's own `apply` cannot be
  // mistaken for.
  const paint = apply;

  return {
    apply(next: ThemeState): void {
      const clamped = clampTheme(next);
      if (themeEquals(clamped, state)) return;
      state = clamped;
      saveState(state); // local copy at once; the server one can wait
      schedule(state);
      paint(state);
    },
    adopt(next: ThemeState): void {
      // A write of ours is newer than anything a re-read can carry: adopting a
      // stale answer mid-write would repaint every terminal in the OLD pair and
      // queue a PUT of it that lands after ours.
      if (timer !== null || inFlight !== null) return;
      const clamped = clampTheme(next);
      if (themeEquals(clamped, state)) return;
      state = clamped;
      saveState(state); // local copy only — this pair is already the server's
      paint(state);
    },
    current(): ThemeState {
      return { ground: state.ground, text: state.text };
    },
    flush,
  };
}
