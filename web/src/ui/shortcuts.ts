/**
 * Shortcuts overlay — a keyboard reference, opened by `?` (outside inputs),
 * Ctrl+Alt+/ or the topbar `?` button. Every chord listed here has a visible
 * UI control (and every drag has a keyboard/button path); plain keys are
 * never intercepted (they belong to the TUI).
 *
 * The one row without an app control is the paste chord (2026-09-08): its
 * non-keyboard twin is the browser's own paste, which reaches the terminal
 * unchanged — the chords exist because a Windows app window does not always
 * offer that menu, and a login code has to get in somehow. It is also the one
 * row that carries a `note`: every other chord is a shortcut for a control the
 * user can see, while this one answers "why not ctrl+v?" — a question the user
 * actually asked (2026-09-08), and a table that only lists it does not answer.
 *
 * The link row is a MOUSE gesture, not a chord: a plain click on a link a
 * program printed does nothing, and ctrl (or cmd) is the second gesture that
 * opens it — so the table has to say so, or the feature is invisible.
 */
import { el, button, trapTab } from './util.ts';

interface Row {
  keys: string[];
  /** Mouse-gesture sentence, not a chord: rendered as plain wrapping text, not a nowrap <kbd> chip. */
  gesture?: boolean;
  what: string;
  ui: string;
  /** One line under the row, for the ONE chord whose existence needs a reason. */
  note?: string;
}

const ROWS: Row[] = [
  { keys: ['ctrl+alt+←↑↓→'], what: 'move pane focus in the active tab', ui: 'click a pane' },
  { keys: ['ctrl+alt+shift+←↑↓→'], what: 'move session between panes of its view (swap)', ui: 'drag a pane header onto a pane' },
  { keys: ['ctrl+alt+1…9'], what: 'switch tab', ui: 'tab strip' },
  { keys: ['ctrl+alt+shift+pgup/pgdn'], what: 'move the active tab left / right (reorder)', ui: 'drag a tab along the strip' },
  { keys: ['ctrl+alt+t'], what: 'launch a new session (dialog)', ui: 'New session, or + in the tab strip' },
  { keys: ['drag a tab onto a pane or tab'], gesture: true, what: 'merge its sessions into that view (split)', ui: 'split in the sessions panel' },
  { keys: ['drag a pane header to the tab strip'], gesture: true, what: 'extract the session to its own tab', ui: 'Own tab in the pane header' },
  { keys: ['←→ / ↑↓ on a divider'], what: 'nudge the split, enter resets it', ui: 'drag the divider, double-click resets it' },
  { keys: ['click a session row'], what: 'go to its tab', ui: 'rows in the sessions panel' },
  {
    keys: ['ctrl+shift+v', 'shift+insert'],
    what: 'paste the clipboard into the terminal',
    ui: "the browser's own paste",
    note: 'plain ctrl+v goes to the program running in the terminal, so pasting needs its own keys',
  },
  { keys: ['ctrl+click a link'], gesture: true, what: 'open it in your browser', ui: 'links printed in the terminal' },
  { keys: ['?', 'ctrl+alt+/'], what: 'this overlay', ui: 'Keyboard shortcuts in the statusline' },
  { keys: ['esc'], what: 'close a panel or dialog, or cancel a drag', ui: '× buttons' },
];

export interface ShortcutsOverlay {
  toggle(): void;
  close(): void;
  isOpen(): boolean;
}

export function initShortcuts(modalHost: HTMLElement): ShortcutsOverlay {
  const scrim = el('div', 'modal-scrim');
  scrim.hidden = true;
  const modal = el('div', 'modal modal-shortcuts');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'keyboard shortcuts');

  const hd = el('header', 'modal-hd');
  const x = button('drawer-x', '×', close);
  x.setAttribute('aria-label', 'close shortcuts');
  hd.append(el('span', 'drawer-label', 'Shortcuts'), el('span', 'drawer-gap'), x);

  const table = el('div', 'sc-table');
  for (const r of ROWS) {
    const row = el('div', 'sc-row');
    const keys = el('span', 'sc-keys');
    r.keys.forEach((k, i) => {
      if (i > 0) keys.append(el('span', 'sc-or', 'or'));
      keys.append(r.gesture === true ? el('span', 'sc-gesture', k) : el('kbd', '', k));
    });
    row.append(keys, el('span', 'sc-what', r.what), el('span', 'sc-ui', r.ui));
    table.append(row);
    if (r.note !== undefined) table.append(el('div', 'sc-cap', r.note));
  }
  const note = el('p', 'sc-note');
  note.textContent =
    'everything else goes to the terminal — plain ctrl+c/v, arrows and esc are never intercepted. app chords live only on ctrl+alt (altgr is left alone), and the two paste chords above are the only other keys the app takes.';

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
    restoreTo?.focus();
    restoreTo = null;
  }

  return {
    toggle: () => (scrim.hidden ? open() : close()),
    close,
    isOpen: () => !scrim.hidden,
  };
}
