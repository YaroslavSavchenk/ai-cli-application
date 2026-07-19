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
 */
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import type { SessionInfo } from '../../../shared/protocol.ts';
import { SessionSocket, type ConnState, type SocketHandlers } from '../ws.ts';

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
  /** True while a replay frame is being written into the terminal. */
  #replaying = false;
  readonly #container: HTMLElement;
  readonly #observer: ResizeObserver;
  #debounce: number | null = null;

  constructor(container: HTMLElement) {
    this.#container = container;
    const fsTerm = parseInt(cssVar('--fs-term'), 10);
    this.term = new Terminal({
      scrollback: SCROLLBACK_LINES,
      fontFamily: cssVar('--font-mono') || 'monospace',
      fontSize: Number.isFinite(fsTerm) ? fsTerm : 13,
      cursorBlink: false,
      theme: themeFromTokens(),
    });
    // App shortcuts live exclusively on Ctrl+Alt; keep xterm from also
    // feeding those chords to the PTY. EVERYTHING else (plain Ctrl+C/V,
    // arrows, Esc, ...) goes to the terminal untouched. AltGr on Windows
    // reports ctrl+alt — getModifierState distinguishes it, so European
    // layouts can still type AltGr characters into the TUI.
    this.term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
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
          k === 'Enter' ||
          k === 't' ||
          k === 'T' ||
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
      onData: (data) => this.term.write(data),
      onInfo: (session) => {
        events.onInfo(session);
        // Another client may have resized the PTY while we were away —
        // reconcile it with this view's actual dimensions.
        if (
          session.status === 'running' &&
          (session.cols !== this.term.cols || session.rows !== this.term.rows)
        ) {
          this.#socket?.sendResize(this.term.cols, this.term.rows);
          events.onDims(this.term.cols, this.term.rows);
        }
      },
      onExit: (exitCode) => events.onExit(exitCode),
      onAttention: () => events.onAttention(),
      onConn: (state) => events.onConn(state),
    };
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
      this.#socket?.sendResize(this.term.cols, this.term.rows);
      this.#events?.onDims(this.term.cols, this.term.rows);
    }
  }

  focus(): void {
    this.term.focus();
  }

  sendSeen(): void {
    this.#socket?.sendSeen();
  }

  dispose(): void {
    this.#observer.disconnect();
    if (this.#debounce !== null) clearTimeout(this.#debounce);
    this.#socket?.close();
    this.#socket = null;
    this.#webgl = null;
    this.term.dispose(); // Disposes loaded addons (fit, webgl) too.
  }
}
