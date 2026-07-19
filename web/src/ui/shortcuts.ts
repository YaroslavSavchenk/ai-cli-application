/**
 * Shortcuts overlay — a keyboard reference, opened by `?` (outside inputs),
 * Ctrl+Alt+/ or the topbar `?` button. Every chord listed here has a visible
 * UI control; plain keys are never intercepted (they belong to the TUI).
 */
import { el, button, trapTab } from './util.ts';

interface Row {
  keys: string[];
  what: string;
  ui: string;
}

const ROWS: Row[] = [
  { keys: ['ctrl+alt+←↑↓→'], what: 'move pane focus', ui: 'click a pane' },
  { keys: ['ctrl+alt+shift+←↑↓→'], what: 'move session to neighbor pane (swap)', ui: 'drag the ⠿ grip onto a pane' },
  { keys: ['ctrl+alt+1…9'], what: 'switch tab', ui: 'tab strip' },
  { keys: ['ctrl+alt+t'], what: 'new tab', ui: '+ in the tab strip' },
  { keys: ['ctrl+alt+enter'], what: 'new session in focused pane', ui: 'launch form in an empty pane' },
  { keys: ['←→ / ↑↓ on a divider'], what: 'nudge the split · enter resets', ui: 'drag the divider · double-click resets' },
  { keys: ['double-click a session row'], what: 'attach it to the focused pane', ui: 'attach in the sessions panel' },
  { keys: ['?', 'ctrl+alt+/'], what: 'this overlay', ui: '? in the top bar' },
  { keys: ['esc'], what: 'close panel / dialog', ui: '× buttons' },
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
  hd.append(el('span', 'drawer-label', 'shortcuts'), el('span', 'drawer-gap'), x);

  const table = el('div', 'sc-table');
  for (const r of ROWS) {
    const row = el('div', 'sc-row');
    const keys = el('span', 'sc-keys');
    r.keys.forEach((k, i) => {
      if (i > 0) keys.append(el('span', 'sc-or', 'or'));
      keys.append(el('kbd', '', k));
    });
    row.append(keys, el('span', 'sc-what', r.what), el('span', 'sc-ui', r.ui));
    table.append(row);
  }
  const note = el('p', 'sc-note');
  note.textContent =
    'everything else goes to the terminal — plain ctrl+c/v, arrows and esc are never intercepted. app chords live only on ctrl+alt (altgr is left alone).';

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
