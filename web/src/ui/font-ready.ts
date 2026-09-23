/**
 * When the terminal's mono face is usable — the decision logic only.
 *
 * Why this exists (Nocturne A4b, 2026-09-10 report from the Windows dev
 * window): the JetBrains Mono woff2 files are self-hosted with
 * `font-display: swap`, and nothing used to wait for them. A TerminalView
 * constructed before the face arrived measured the FALLBACK (Cascadia Mono on
 * Windows), so that pane kept the wrong glyphs AND the wrong cell width —
 * which means the cols/rows it reported to the PTY were wrong too — until the
 * page was reloaded. Two answers, both in here: load the face before the first
 * terminal is built, and recover if it lands afterwards anyway.
 *
 * The module is deliberately DOM-free and dependency-free: every input is a
 * parameter and the font set is the injected `FontFaceSetLike`, so
 * `node --test` drives it against a fake FontFaceSet with no browser
 * (`tests/ui/ui-font-ready.test.ts`). The browser glue — reading the tokens,
 * clearing glyph atlases, refitting — lives in `ui/terminal.ts`.
 *
 * "Font loaded" is not "font renders" (memory: google-fonts-subset-trap): all
 * this module claims is that the browser reports the face as loaded for the
 * specs it was given. Proving the glyphs actually changed is a browser check.
 */

/** The part of `document.fonts` (FontFaceSet) this module uses. */
export interface FontFaceSetLike {
  check(font: string): boolean;
  load(font: string): Promise<unknown>;
  addEventListener(type: 'loadingdone', listener: () => void): void;
}

/**
 * Weights the TERMINAL can draw with, and therefore the only ones worth
 * waiting for: 400 is normal text, 700 is xterm's `fontWeightBold` default
 * ('bold'). The 500 face in fonts.css belongs to the chrome, which reflows by
 * itself when a face swaps in — a terminal does not.
 */
export const TERMINAL_FONT_WEIGHTS: readonly number[] = [400, 700];

/**
 * Ceiling on the wait before the first terminal is built. The woff2 files are
 * served by our own backend over loopback (~92 KB each, measured ~10 ms cold
 * in the A4b probe), so this is ~100x the real budget and only ever pays out
 * when something is actually broken — a missing asset, a wedged request. A
 * terminal drawn 1.5 s late is annoying; a terminal that silently keeps the
 * wrong cell width is a garbled TUI, so the trade is worth it once. When the
 * face is already loaded there is no wait at all (see `ensureFontsLoaded`).
 */
export const FONT_WAIT_MS = 1500;

/**
 * How `ensureFontsLoaded` ended — for one honest log line, nothing else.
 * 'failed' is a load the browser rejected (missing or wedged woff2);
 * 'unparseable' is a spec the browser refused to parse (a malformed
 * --font-mono / --fs-term). Different diagnoses, so different words.
 */
export type FontWaitResult =
  | 'unsupported'
  | 'none'
  | 'already'
  | 'loaded'
  | 'timeout'
  | 'failed'
  | 'unparseable';

/**
 * Quote a family name for a CSS font shorthand — unless it is a single CSS
 * identifier, which covers the generic keywords (`monospace`) that must NOT
 * be quoted or they turn into a family nobody has.
 */
export function quoteFamily(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) return name;
  return `"${name.replace(/["\\]/g, '\\$&')}"`;
}

/**
 * The first family of a font stack — the one a terminal actually draws with
 * when it is available. Returns null for an empty/garbage stack, which the
 * callers treat as "nothing to wait for".
 */
export function primaryFamily(stack: string): string | null {
  const first = stack.split(',')[0]?.trim() ?? '';
  const unquoted = /^(['"])(.*)\1$/.exec(first);
  const name = (unquoted?.[2] ?? first).trim();
  return name === '' ? null : name;
}

/** One `document.fonts` spec: a CSS font shorthand of weight, size, family. */
export function fontSpec(family: string, weight: number, sizePx: number): string {
  return `${weight} ${sizePx}px ${quoteFamily(family)}`;
}

/**
 * The specs the terminal's own drawing needs. Empty when the stack names no
 * family or the size is not a usable number — "nothing to wait for" is a
 * valid answer and must never become a wait that cannot end.
 */
export function terminalFontSpecs(stack: string, sizePx: number): string[] {
  const family = primaryFamily(stack);
  if (family === null || !Number.isFinite(sizePx) || sizePx <= 0) return [];
  return TERMINAL_FONT_WEIGHTS.map((w) => fontSpec(family, w, sizePx));
}

/**
 * What the font set reports for EVERY spec.
 *
 * `'unparseable'` is its own answer on purpose. A spec the browser refuses to
 * parse can never become "loaded", so the WAIT must end at once — but it is
 * not the same event as "the face is here": folded into `'yes'` it would both
 * silence the log line and latch the late-arrival watcher, so a malformed
 * --font-mono would hand every terminal the fallback's cell width with
 * nothing in server.log and no repair left armed.
 */
export type FontReadiness = 'yes' | 'no' | 'unparseable';

export function allLoaded(fonts: FontFaceSetLike, specs: string[]): FontReadiness {
  for (const spec of specs) {
    try {
      if (!fonts.check(spec)) return 'no';
    } catch {
      return 'unparseable';
    }
  }
  return 'yes';
}

/**
 * Ask for the faces and wait, bounded.
 *
 * - Already loaded, or nothing to load -> returns without awaiting a timer, so
 *   a warm boot costs zero delay.
 * - `timeoutMs` elapses first -> 'timeout', and the terminal is built with
 *   whatever the browser has. The recovery path below is what repairs it.
 * - A load that rejects -> 'failed', same treatment.
 * - A spec the browser cannot parse -> 'unparseable', immediately: asking
 *   `load()` for it is pointless, but the caller must LOG it (a silent
 *   'already' is how a malformed --font-mono skipped the whole wait), and the
 *   watcher below stays armed on the same reading.
 */
export async function ensureFontsLoaded(
  fonts: FontFaceSetLike | null,
  specs: string[],
  timeoutMs: number,
): Promise<FontWaitResult> {
  if (fonts === null) return 'unsupported';
  if (specs.length === 0) return 'none';
  const readiness = allLoaded(fonts, specs);
  if (readiness === 'yes') return 'already';
  if (readiness === 'unparseable') return 'unparseable';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const loads = Promise.all(specs.map((s) => fonts.load(s)))
    .then((): FontWaitResult => 'loaded')
    .catch((): FontWaitResult => 'failed');
  try {
    return await Promise.race([loads, deadline]);
  } finally {
    // Always: a pending timer would hold the page (and a test process) awake
    // long after the answer was known.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Is a refresh of the already-built terminals owed?
 *
 * Only when the face was missing, is now here, AND terminals exist that were
 * built without it. Views created after the face landed measured it
 * themselves, so refreshing them would be a resize for nothing — and a resize
 * for nothing is a message to the PTY for nothing.
 */
export function refreshDecision(state: {
  wasReady: boolean;
  isReady: boolean;
  views: number;
}): boolean {
  return !state.wasReady && state.isReady && state.views > 0;
}

/**
 * Watch the font set for a LATE arrival and repair the views that drew
 * without it. Installed once, fires at most once: after the face is here
 * every later `loadingdone` is somebody else's font.
 */
export function watchFontArrival(opts: {
  fonts: FontFaceSetLike | null;
  specs: string[];
  /** How many terminals exist right now. */
  views: () => number;
  /** Re-measure + redraw them. */
  refresh: () => void;
}): void {
  const { fonts, specs } = opts;
  if (fonts === null || specs.length === 0) return;
  // Only a real 'yes' latches: 'unparseable' leaves the watch armed, so a
  // spec that becomes readable (or a face that lands anyway) is still repaired.
  let wasReady = allLoaded(fonts, specs) === 'yes';
  fonts.addEventListener('loadingdone', () => {
    if (wasReady) return;
    const isReady = allLoaded(fonts, specs) === 'yes';
    if (refreshDecision({ wasReady, isReady, views: opts.views() })) opts.refresh();
    wasReady = isReady;
  });
}
