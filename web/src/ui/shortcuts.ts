/**
 * Shortcuts overlay — a keyboard reference, opened by `?` (outside inputs),
 * Ctrl+Alt+/ or the statusline's `Keyboard shortcuts` button (the topbar `?`
 * went with the Nocturne chrome, A2).
 *
 * The TABLE it draws is not here: since Nocturne B6 the rows are pure data in
 * `ui/shortcuts-rows.ts`, read by this overlay and by the Settings panel's
 * Keyboard page, which used to keep a hand-copied excerpt of its own. This
 * file owns the overlay's SHAPE — three columns, a caption under the rows that
 * carry one, and the standing footnote about everything the app does not take.
 */
import { ROWS } from './shortcuts-rows.ts';
import { el, button, trapTab } from './util.ts';

export interface ShortcutsOverlay {
  toggle(): void;
  close(): void;
  isOpen(): boolean;
}

export function initShortcuts(modalHost: HTMLElement, refocus: () => void): ShortcutsOverlay {
  // `modal-scrim` stays on the scrim: ui/keys.ts recognises an open dialog by
  // it (OPEN_FOCUS_OWNER_SELECTOR), and it carries the layer and the flat
  // Nocturne backdrop. `sc-scrim` adds this overlay's own top anchor.
  const scrim = el('div', 'modal-scrim sc-scrim');
  scrim.hidden = true;
  const modal = el('div', 'sc-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'keyboard shortcuts');

  const hd = el('header', 'sc-hd');
  const x = button('sc-x', '×', close);
  x.setAttribute('aria-label', 'close shortcuts');
  hd.append(el('span', 'sc-title', 'Keyboard shortcuts'), x);

  const table = el('div', 'sc-table');
  for (const r of ROWS) {
    // One ITEM per entry — the row and the caption that explains it are one
    // thing, so the hairline between entries never cuts between them.
    const item = el('div', 'sc-item');
    const row = el('div', 'sc-row');
    const keys = el('span', 'sc-keys');
    r.keys.forEach((k, i) => {
      if (i > 0) keys.append(el('span', 'sc-or', 'or'));
      keys.append(r.gesture === true ? el('span', 'sc-gesture', k) : el('kbd', '', k));
    });
    row.append(keys, el('span', 'sc-what', r.what), el('span', 'sc-ui', r.ui));
    item.append(row);
    if (r.note !== undefined) item.append(el('div', 'sc-cap', r.note));
    table.append(item);
  }
  const note = el('p', 'sc-note');
  note.textContent =
    "Everything else goes to the terminal: arrows and esc are never intercepted, and plain ctrl+c/v go straight to it — unless the clipboard carries files and a row is selected in the Files panel, which is the one paste the app keeps for itself. App chords live only on ctrl+alt (altgr is left alone), and the paste and copy chords above are the only other keys the app takes anywhere — plus two that act only where the keyboard already is: ctrl+s inside a file's text, and, inside the Files panel, the menu key or shift+f10, delete, ctrl+a and the arrows.";

  modal.append(hd, table, note);
  scrim.append(modal);
  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) close();
  });
  trapTab(modal);
  modalHost.append(scrim);

  let restoreTo: HTMLElement | null = null;

  function open(): void {
    if (!scrim.hidden) return;
    restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    scrim.hidden = false;
    x.focus();
  }

  function close(): void {
    if (scrim.hidden) return;
    scrim.hidden = true;
    // Return the keyboard where it came from — opening from a terminal
    // restores the terminal; otherwise fall back to the focused pane.
    // (`<body>` is where focus sits when nothing is focused: focusing it back
    // is a no-op and would leave the typed keys reaching no PTY.)
    if (restoreTo !== null && restoreTo !== document.body && restoreTo.isConnected) restoreTo.focus();
    else refocus();
    restoreTo = null;
  }

  return {
    toggle: () => (scrim.hidden ? open() : close()),
    close,
    isOpen: () => !scrim.hidden,
  };
}
