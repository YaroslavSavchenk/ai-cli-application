/**
 * Terminal input decisions — pure, DOM-free, xterm-free, so plain `node:test`
 * can import them (same pattern as `launch-args.ts`). The questions the app
 * asks about raw browser input, each answered here and nowhere else:
 *
 *   1. `shouldRefocusTerminal` — the window just came back to the foreground:
 *      may we put the keyboard back in the terminal? (2026-09-08: a Claude
 *      Code `/login` sends the user to the Windows browser and back, and the
 *      page returned with the keyboard nowhere — the OAuth code field took no
 *      input at all.)
 *   2. `focusOwnerOpen` — is a surface that OWNS the keyboard up right now?
 *      The companion of (1): `shouldRefocusTerminal` reads where focus SITS,
 *      this one reads what is on SCREEN, and a refocus needs both to agree.
 *   3. `isOpenableLink` — an OSC 8 hyperlink was activated in the terminal: is
 *      this address one we are willing to hand to `window.open`?
 *   4. `isLinkActivation` — was that click the deliberate second gesture a
 *      link activation requires (Ctrl/Cmd), or a plain click?
 *   5. `isPasteChord` — is this keystroke the app's explicit paste chord?
 *   6. `isCopyChord` — is this keystroke the app's explicit copy chord?
 *      (the only key that fires the browser's own copy is Ctrl+C, which
 *      xterm turns into ^C for the program — 2026-09-10 user report.)
 *
 * Callers pass a STRUCTURAL view of the event/element (`FocusTarget`,
 * `KeyChord`, `MouseChord`, `DocumentLike`), which a real `HTMLElement` /
 * `KeyboardEvent` / `MouseEvent` / `Document` satisfies as-is — that is what
 * keeps this file importable without a document.
 */

/** The part of an element these decisions read. A real HTMLElement satisfies it. */
export interface FocusTarget {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
  closest(selectors: string): unknown;
}

/** The part of a keyboard event these decisions read. A real KeyboardEvent satisfies it. */
export interface KeyChord {
  readonly type?: string;
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  getModifierState?(key: string): boolean;
}

/** The part of a mouse event these decisions read. A real MouseEvent satisfies it. */
export interface MouseChord {
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/** The part of a document these decisions read. A real Document satisfies it. */
export interface DocumentLike {
  querySelector(selectors: string): unknown;
}

/** The xterm mount. Focus already inside it is a terminal that may be re-focused. */
export const TERMINAL_SELECTOR = '.term-host';

/**
 * Surfaces that OWN the keyboard while they are up: any dialog (the launch,
 * new-project, restart, shortcuts and folder-picker modals, the settings panel
 * and the theme popover all carry `role="dialog"`), the two drawers, and the
 * boot/reconnect overlay. Focus inside one of these is deliberate — the
 * terminal does not get to take it back.
 */
export const FOCUS_OWNER_SELECTOR = '[role="dialog"], .drawer, .modal-scrim, .boot-overlay';

/**
 * The same surfaces, asked of the SCREEN instead of the focused element: which
 * of them is up right now. A dialog lives inside a `.modal-scrim` that is
 * `hidden` while closed, the drawers are `aside.drawer` elements the chrome
 * hides the same way, and the boot/reconnect overlay only exists while it is
 * up — so "open" is `:not([hidden])` for the first two and mere existence for
 * the third.
 */
export const OPEN_FOCUS_OWNER_SELECTOR =
  '.modal-scrim:not([hidden]), .drawer:not([hidden]), .boot-overlay';

/**
 * Is a surface that owns the keyboard OPEN?
 *
 * ONE rule for the whole app (2026-09-08 fix): the earlier pre-check in
 * main.ts asked only about scrims and the boot overlay, so an open sessions or
 * projects drawer — whose own topbar toggle button holds the focus, an element
 * that is inside no drawer at all — let the terminal take the keyboard back on
 * the next window activation. A refocus now needs BOTH this to be false and
 * `shouldRefocusTerminal` to say yes.
 */
export function focusOwnerOpen(doc: DocumentLike | null): boolean {
  if (doc === null) return false;
  return doc.querySelector(OPEN_FOCUS_OWNER_SELECTOR) !== null;
}

/** Is this element one that swallows typing (a field, or a contenteditable)? */
export function isEditableTarget(t: FocusTarget | null): boolean {
  if (t === null) return false;
  const tag = t.tagName ?? '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return t.isContentEditable === true;
}

/**
 * May the app move the keyboard back into the focused pane's terminal?
 *
 * `active` is `document.activeElement` (null when the document has nothing
 * focused — then YES, the terminal is where the keyboard belongs in this app).
 * Order matters: the xterm helper textarea is itself an editable element, so
 * "already in a terminal" is answered before "is an input".
 */
export function shouldRefocusTerminal(active: FocusTarget | null): boolean {
  if (active === null) return true;
  if (active.closest(TERMINAL_SELECTOR) !== null) return true;
  if (isEditableTarget(active)) return false;
  return active.closest(FOCUS_OWNER_SELECTOR) === null;
}

/**
 * Addresses the app will open in the system browser on an OSC 8 link click.
 * `http:`/`https:` only — everything else (`file:`, `javascript:`, `data:`,
 * a bare word that is not a URL at all) is ignored rather than guessed at.
 * xterm's own default would have asked a `confirm()` first; the host routes
 * off-origin `window.open` to the real browser, so the confirm was only ever
 * a second click between the user and their login page.
 */
export function isOpenableLink(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * Does this click ACTIVATE a terminal hyperlink?
 *
 * A terminal's plain click is a selection gesture, and the text under it is
 * whatever a program printed — a CLI can print any address it likes. So
 * opening asks for a second, deliberate gesture: Ctrl (or Cmd on a Mac
 * keyboard), exactly as Windows Terminal and VS Code do. A plain click does
 * nothing at all; there is no confirm dialog either (the modifier IS the
 * confirmation, decided 2026-09-08).
 *
 * Alt is rejected: Alt+click is a window-manager gesture on Linux and the
 * AltGr-on-European-layouts ctrl+alt pair must never read as a plain Ctrl.
 */
export function isLinkActivation(e: MouseChord): boolean {
  if (e.altKey) return false;
  return e.ctrlKey || e.metaKey;
}

/**
 * The app's paste chords: Ctrl+Shift+V and Shift+Insert — the two a terminal
 * user expects, and neither of them is what a TUI reads (plain Ctrl+V is NOT
 * a paste in a Linux terminal and keeps going straight to the PTY, per
 * PROJECT-SCOPE's keyboard rule).
 *
 * AltGr reports as ctrl+alt on European layouts; the Alt/Meta rejection below
 * already excludes it, and `getModifierState` is honoured when present for the
 * same reason the app chords honour it.
 */
export function isPasteChord(e: KeyChord): boolean {
  if (e.type !== undefined && e.type !== 'keydown') return false;
  if (e.altKey || e.metaKey) return false;
  if (e.getModifierState?.('AltGraph') === true) return false;
  if (e.ctrlKey && e.shiftKey && (e.key === 'v' || e.key === 'V')) return true;
  return !e.ctrlKey && e.shiftKey && e.key === 'Insert';
}

/**
 * The app's copy chords: Ctrl+Shift+C and Ctrl+Insert — the terminal pair that
 * mirrors the paste chords above. Plain Ctrl+C is NOT one of them and never
 * will be: it is ^C, the interrupt, and it belongs to the program in the
 * terminal (PROJECT-SCOPE's keyboard rule).
 *
 * Ctrl+Insert is copy, Shift+Insert is paste — the two are told apart by the
 * OTHER modifier, so a chord carrying BOTH ctrl and shift on Insert is neither
 * (it is left alone, exactly as `isPasteChord` already decides — and xterm
 * sends no bytes for it, so it produces nothing).
 *
 * Taking the keystroke is a SECOND decision the caller owns: with nothing
 * selected there is nothing to copy, and the chord is left alone so the app
 * never swallows a key for nothing (xterm itself sends no bytes for either
 * chord). This predicate answers only "is this the chord", never "swallow it".
 */
export function isCopyChord(e: KeyChord): boolean {
  if (e.type !== undefined && e.type !== 'keydown') return false;
  if (e.altKey || e.metaKey) return false;
  if (e.getModifierState?.('AltGraph') === true) return false;
  if (e.ctrlKey && e.shiftKey && (e.key === 'c' || e.key === 'C')) return true;
  return e.ctrlKey && !e.shiftKey && e.key === 'Insert';
}
