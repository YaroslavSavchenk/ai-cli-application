/**
 * One xterm.js instance per visible pane.
 *
 * - WebGL renderer with try/catch fallback to the DOM renderer; a lost WebGL
 *   context disposes the addon (xterm falls back automatically).
 * - Bounded scrollback (5000 lines).
 * - Theme is built from the --xt-* tokens in tokens.css: the terminal
 *   palette and the app palette are one system.
 * - Resize: ResizeObserver -> 75ms debounce -> fit -> send cols/rows over
 *   the socket ONLY when they actually changed. Missing this renders TUIs
 *   as garbage (see PROJECT-SCOPE).
 * - Attach flow: on every replay frame the terminal is reset() first, then
 *   the replay is written, then live data streams (server guarantees order).
 * - Links: OSC 8 hyperlinks (Claude Code's `/login` prints one) open in the
 *   system browser on click — no confirm() dialog, http/https only. See
 *   ./keys.ts for the scheme filter.
 * - Paste: the browser's own Ctrl+V path into the xterm textarea is untouched;
 *   Ctrl+Shift+V and Shift+Insert read the clipboard explicitly. Plain Ctrl+C
 *   and Ctrl+V still reach the PTY (PROJECT-SCOPE keyboard rule).
 * - Font: the terminal must not draw before its mono face exists — a view
 *   built on the fallback keeps the wrong glyphs AND the wrong cell width
 *   (so the cols/rows it reports to the PTY are wrong) until a reload.
 *   `loadTerminalFont()` is awaited once at boot and `watchTerminalFont()`
 *   repairs any view that drew without it. Decisions in ./font-ready.ts.
 * - Copy: xterm serves the browser's own copy event, but the only key that
 *   fires one is Ctrl+C, which xterm turns into ^C. Ctrl+Shift+C and
 *   Ctrl+Insert write the terminal's own selection to the clipboard — but ONLY
 *   when there is a selection; with none they are left alone so the app never
 *   swallows a key for nothing (xterm sends no bytes for either chord), and
 *   plain Ctrl+C is always ^C.
 */
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import type { SessionInfo } from '../../../shared/protocol.ts';
import { SessionSocket, type ConnState, type SocketHandlers } from '../ws.ts';
import { log } from '../log.ts';
import { isCopyChord, isLinkActivation, isOpenableLink, isPasteChord } from './keys.ts';
import {
  ensureFontsLoaded,
  FONT_WAIT_MS,
  terminalFontSpecs,
  watchFontArrival,
  type FontFaceSetLike,
  type FontWaitResult,
} from './font-ready.ts';

const SCROLLBACK_LINES = 5000;
const RESIZE_DEBOUNCE_MS = 75;
const DIM_MIN = 1;
const DIM_MAX = 1000;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** xterm theme fed from tokens.css — never a second palette. */
function themeFromTokens(): ITheme {
  return {
    background: cssVar('--xt-bg'),
    foreground: cssVar('--xt-fg'),
    cursor: cssVar('--xt-cursor'),
    cursorAccent: cssVar('--xt-cursor-accent'),
    selectionBackground: cssVar('--xt-selection'),
    black: cssVar('--xt-black'),
    red: cssVar('--xt-red'),
    green: cssVar('--xt-green'),
    yellow: cssVar('--xt-yellow'),
    blue: cssVar('--xt-blue'),
    magenta: cssVar('--xt-magenta'),
    cyan: cssVar('--xt-cyan'),
    white: cssVar('--xt-white'),
    brightBlack: cssVar('--xt-bright-black'),
    brightRed: cssVar('--xt-bright-red'),
    brightGreen: cssVar('--xt-bright-green'),
    brightYellow: cssVar('--xt-bright-yellow'),
    brightBlue: cssVar('--xt-bright-blue'),
    brightMagenta: cssVar('--xt-bright-magenta'),
    brightCyan: cssVar('--xt-bright-cyan'),
    brightWhite: cssVar('--xt-bright-white'),
  };
}

function clampDim(v: number | undefined, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(DIM_MAX, Math.max(DIM_MIN, Math.trunc(v)));
}

/** Every mounted TerminalView — a theme change refreshes them in place. */
const liveViews = new Set<TerminalView>();

/**
 * Re-read the --xt-* tokens and apply to ALL live terminals. Called by
 * ui/theme.ts after it writes ground/ramp overrides onto :root (part B9's
 * Terminal colours page is what drives that) — the tokens
 * file stays the single ITheme source; nothing else may hand xterm a theme.
 */
export function refreshAllTerminalThemes(): void {
  const theme = themeFromTokens();
  for (const view of liveViews) view.term.options.theme = theme;
}

/** `document.fonts`, or null where the browser has no font-loading API. */
function fontSet(): FontFaceSetLike | null {
  const fonts = (document as Document & { fonts?: FontFaceSetLike }).fonts;
  if (
    fonts === undefined ||
    typeof fonts.check !== 'function' ||
    typeof fonts.load !== 'function' ||
    typeof fonts.addEventListener !== 'function'
  ) {
    return null;
  }
  return fonts;
}

/** The faces a terminal draws with, read from the same tokens it is built from. */
function specsFromTokens(): string[] {
  return terminalFontSpecs(cssVar('--font-mono'), parseFloat(cssVar('--fs-term')));
}

/**
 * Wait for the terminal's mono face, bounded by FONT_WAIT_MS. main.ts awaits
 * this BEFORE it builds the shell, which is the one seam every TerminalView
 * construction sits behind (the first panes, a reattach after a tab switch, a
 * New session — all of them are built by the shell this gates).
 */
export async function loadTerminalFont(): Promise<FontWaitResult> {
  const result = await ensureFontsLoaded(fontSet(), specsFromTokens(), FONT_WAIT_MS);
  if (result !== 'already') log.debug(`terminal font: ${result}`);
  return result;
}

/**
 * Second half of the same fix: if the face arrives AFTER views exist — the
 * wait timed out, or the spec could not be parsed at boot — re-measure and
 * redraw those views once. The watch latches on the first ready reading and
 * never looks again, so a face evicted and re-fetched later is NOT repaired
 * (deliberate: that latch is what keeps a normal boot from costing a redraw
 * and a PTY resize for nothing). Fires at most once and never when no view
 * drew without the font.
 */
export function watchTerminalFont(): void {
  watchFontArrival({
    fonts: fontSet(),
    specs: specsFromTokens(),
    views: () => liveViews.size,
    refresh: () => {
      log.debug(`terminal font arrived late — redrawing ${liveViews.size} terminals`);
      for (const view of liveViews) view.reloadFont();
    },
  });
}

/** One debug line per page for a clipboard the browser will not let us read. */
let clipboardRefusalLogged = false;
/** The same, for a clipboard the browser will not let us write. */
let clipboardWriteRefusalLogged = false;

/**
 * Open a terminal hyperlink in the system browser. The address comes from PTY
 * OUTPUT, so it is never logged (the logging rule: counts, never content).
 */
function openTerminalLink(uri: string): void {
  if (!isOpenableLink(uri)) {
    log.debug('terminal link ignored: not a web address');
    return;
  }
  log.debug('terminal link opened');
  window.open(uri, '_blank', 'noopener,noreferrer');
}

export interface TerminalEvents {
  onInfo(session: SessionInfo): void;
  onExit(exitCode: number): void;
  onAttention(): void;
  onConn(state: ConnState): void;
  /** Fired when a fit changed the local terminal dimensions. */
  onDims(cols: number, rows: number): void;
}

export class TerminalView {
  readonly term: Terminal;
  readonly #fit = new FitAddon();
  #webgl: WebglAddon | null = null;
  #socket: SessionSocket | null = null;
  #events: TerminalEvents | null = null;
  /** Log identity only — the socket owns the real attachment. */
  #sessionId: string | null = null;
  /** True while a replay frame is being written into the terminal. */
  #replaying = false;
  readonly #container: HTMLElement;
  readonly #observer: ResizeObserver;
  #debounce: number | null = null;

  constructor(container: HTMLElement) {
    this.#container = container;
    const fsTerm = parseFloat(cssVar('--fs-term')); // 12.5px per the handoff
    this.term = new Terminal({
      scrollback: SCROLLBACK_LINES,
      fontFamily: cssVar('--font-mono') || 'monospace',
      fontSize: Number.isFinite(fsTerm) ? fsTerm : 13,
      cursorBlink: false,
      theme: themeFromTokens(),
      // xterm's default OSC 8 activation asks a confirm() first and then opens
      // the address. In the app window that confirm is one more click between
      // a user and the login page they just asked for (2026-09-08 report), so
      // the confirm is gone and the SECOND GESTURE is the modifier instead:
      // ctrl+click (cmd+click on a Mac keyboard) opens, a plain click does
      // nothing at all — the Windows Terminal / VS Code convention, and the
      // reason a program printing a link cannot turn a stray click into a
      // navigation. Then http/https only, and never a scheme we did not vet;
      // `allowNonHttpProtocols` stays off (its default), so that filter is the
      // third lock, not the only one. Both decisions are pure and unit-tested
      // in ui/keys.ts.
      linkHandler: {
        activate: (event: MouseEvent, uri: string) => {
          if (!isLinkActivation(event)) return;
          openTerminalLink(uri);
        },
      },
    });
    liveViews.add(this);
    // App shortcuts live exclusively on Ctrl+Alt; keep xterm from also
    // feeding those chords to the PTY. EVERYTHING else (plain Ctrl+C/V,
    // arrows, Esc, ...) goes to the terminal untouched. AltGr on Windows
    // reports ctrl+alt — getModifierState distinguishes it, so European
    // layouts can still type AltGr characters into the TUI.
    this.term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      // Paste chords FIRST: the browser's own Ctrl+Shift+V ("paste as plain
      // text") would otherwise fire a second paste into the xterm textarea and
      // land everything twice, so this preventDefault is load-bearing.
      if (isPasteChord(e)) {
        e.preventDefault();
        void this.#pasteFromClipboard();
        return false;
      }
      // Copy chords: a selection is what makes them ours. With nothing
      // selected the keystroke is NOT taken — it is left alone (not swallowed)
      // exactly as before this existed, and produces nothing (xterm sends no
      // bytes for either chord), which is the whole reason the selection is
      // tested here and not inside the copy itself.
      if (isCopyChord(e)) {
        if (!this.term.hasSelection()) return true;
        e.preventDefault();
        void this.#copySelection();
        return false;
      }
      if (
        e.type === 'keydown' &&
        e.ctrlKey &&
        e.altKey &&
        !e.metaKey &&
        !e.getModifierState('AltGraph')
      ) {
        const k = e.key;
        if (
          k.startsWith('Arrow') ||
          k === 't' ||
          k === 'T' ||
          // A10: ctrl+alt+w belongs to the app (it closes the focused file
          // pane; on a terminal pane it does nothing and is swallowed — user
          // decision 9). ctrl+alt+enter is NOT here: it lives on a focused
          // Files ROW, which cannot have focus while a terminal does, so
          // taking it would swallow a key for nothing.
          k === 'w' ||
          k === 'W' ||
          k === '/' ||
          (e.shiftKey && (k === 'PageUp' || k === 'PageDown')) ||
          (k.length === 1 && k >= '1' && k <= '9')
        ) {
          return false;
        }
      }
      return true;
    });
    this.term.open(container);
    this.term.loadAddon(this.#fit);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose(); // xterm falls back to the DOM renderer.
        if (this.#webgl === webgl) this.#webgl = null;
      });
      this.term.loadAddon(webgl);
      this.#webgl = webgl;
    } catch {
      // WebGL unavailable — DOM renderer fallback.
    }
    this.#fitNow(false);
    this.#observer = new ResizeObserver(() => this.#scheduleFit());
    this.#observer.observe(container);
  }

  /** Measured pane dimensions for POST /api/sessions. Fallback 80x24, clamped 1..1000. */
  proposeDims(): { cols: number; rows: number } {
    let proposed: { cols: number; rows: number } | undefined;
    try {
      proposed = this.#fit.proposeDimensions();
    } catch {
      proposed = undefined;
    }
    return { cols: clampDim(proposed?.cols, 80), rows: clampDim(proposed?.rows, 24) };
  }

  get connected(): boolean {
    return this.#socket !== null;
  }

  connect(sessionId: string, events: TerminalEvents): void {
    if (this.#socket !== null) return;
    this.#sessionId = sessionId;
    this.#events = events;
    this.term.onData((data: string) => {
      // While a replay is being processed, xterm re-answers any terminal
      // queries embedded in the buffer (vim/claude emit DA/DSR/OSC 10-11);
      // the live session already answered those the first time, so replay
      // responses must never reach the PTY as input — they'd land at the
      // shell prompt as garbage on every reattach. Keystrokes during the
      // few-ms replay window are dropped with them, deliberately.
      if (!this.#replaying) this.#socket?.sendInput(data);
    });
    const handlers: SocketHandlers = {
      onReplay: (data) => {
        // Full-buffer replay on every (re)attach: reset first, then write.
        this.term.reset();
        if (data !== '') {
          this.#replaying = true;
          this.term.write(data, () => {
            this.#replaying = false;
          });
        }
      },
      onData: (data) => {
        this.term.write(data);
      },
      onInfo: (session) => {
        events.onInfo(session);
        // Another client may have resized the PTY while we were away —
        // reconcile it with this view's actual dimensions.
        if (
          session.status === 'running' &&
          (session.cols !== this.term.cols || session.rows !== this.term.rows)
        ) {
          log.debug(
            `resize ${sessionId} → ${this.term.cols}x${this.term.rows} (reconcile: pty had ${session.cols}x${session.rows})`,
          );
          this.#socket?.sendResize(this.term.cols, this.term.rows);
          events.onDims(this.term.cols, this.term.rows);
        }
      },
      onExit: (exitCode) => events.onExit(exitCode),
      onAttention: () => events.onAttention(),
      onConn: (state) => events.onConn(state),
    };
    log.debug(`attach ${sessionId} at ${this.term.cols}x${this.term.rows}`);
    this.#socket = new SessionSocket(sessionId, handlers);
  }

  #scheduleFit(): void {
    if (this.#debounce !== null) clearTimeout(this.#debounce);
    this.#debounce = window.setTimeout(() => {
      this.#debounce = null;
      this.#fitNow(true);
    }, RESIZE_DEBOUNCE_MS);
  }

  #fitNow(report: boolean): void {
    // A hidden/collapsed container would fit to nonsense; skip.
    if (this.#container.clientWidth < 20 || this.#container.clientHeight < 20) return;
    const beforeCols = this.term.cols;
    const beforeRows = this.term.rows;
    try {
      this.#fit.fit();
    } catch {
      return;
    }
    if (report && (this.term.cols !== beforeCols || this.term.rows !== beforeRows)) {
      // Only on a REAL change (the guard above), so a drag costs one line at
      // the end of its debounce — not one per frame.
      log.debug(
        `resize ${this.#sessionId ?? '-'} → ${this.term.cols}x${this.term.rows} (was ${beforeCols}x${beforeRows})`,
      );
      this.#socket?.sendResize(this.term.cols, this.term.rows);
      this.#events?.onDims(this.term.cols, this.term.rows);
    }
  }

  focus(): void {
    this.term.focus();
  }

  /**
   * The mono face landed after this view was built: re-measure the cell,
   * throw away the glyph atlas drawn with the fallback, and refit — through
   * the SAME #fitNow(true) every resize uses, so a changed cols/rows reaches
   * the PTY over the socket exactly once.
   *
   * The fontFamily write is what forces the re-measure: xterm's options
   * service drops a write of an EQUAL value (no event, no
   * CharSizeService.measure()), and without a re-measure the cell keeps the
   * fallback's width and every later fit reports a lie. So the same stack is
   * re-spelled with one trailing space — identical to the CSS parser,
   * different to `!==`. `clearTextureAtlas()` is a no-op under the DOM
   * renderer (xterm calls its renderer's method optionally), so the WebGL
   * fallback needs no guard here.
   */
  reloadFont(): void {
    const family = this.term.options.fontFamily ?? '';
    this.term.options.fontFamily = family.endsWith(' ') ? family.trimEnd() : `${family} `;
    this.term.clearTextureAtlas();
    this.#fitNow(true);
  }

  /**
   * Explicit paste (Ctrl+Shift+V · Shift+Insert): read the clipboard and hand
   * the text to xterm, which applies bracketed-paste exactly as it does for a
   * browser paste event. A refusal (no permission, no clipboard API, an empty
   * read) does nothing at all — a modal about clipboard permissions in a
   * terminal window would be worse than the missing paste. One debug line per
   * page, because the refusal is the same every time.
   */
  async #pasteFromClipboard(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text !== '') this.term.paste(text);
    } catch {
      if (!clipboardRefusalLogged) {
        clipboardRefusalLogged = true;
        log.debug('clipboard read refused — the paste chord did nothing');
      }
    }
  }

  /**
   * Explicit copy (Ctrl+Shift+C · Ctrl+Insert): hand the terminal's OWN
   * selection to the clipboard. The caller has already established that there
   * is one; the selection is deliberately NOT cleared, so the text stays
   * visible and a second copy is free.
   *
   * The selected text came from PTY output, so it is never logged (the logging
   * rule: counts, never content) — and a refusal does nothing visible at all,
   * for the same reason the paste path stays silent. One debug line per page.
   */
  async #copySelection(): Promise<void> {
    const text = this.term.getSelection();
    if (text === '') return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      if (!clipboardWriteRefusalLogged) {
        clipboardWriteRefusalLogged = true;
        log.debug('clipboard write refused — the copy chord did nothing');
      }
    }
  }

  sendSeen(): void {
    this.#socket?.sendSeen();
  }

  dispose(): void {
    liveViews.delete(this);
    this.#observer.disconnect();
    if (this.#debounce !== null) clearTimeout(this.#debounce);
    this.#socket?.close();
    this.#socket = null;
    this.#webgl = null;
    this.term.dispose(); // Disposes loaded addons (fit, webgl) too.
  }
}
