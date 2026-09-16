/**
 * Shortcuts overlay — a keyboard reference, opened by `?` (outside inputs),
 * Ctrl+Alt+/ or the statusline's `Keyboard shortcuts` button (the topbar `?`
 * went with the Nocturne chrome, A2). Every chord listed here has a visible
 * UI control (and every drag has a keyboard/button path); plain keys are
 * never intercepted (they belong to the TUI).
 *
 * THREE rows carry a `note` (A9b added the third) — every other entry is a
 * shortcut for a control the user can see, while these three answer a question
 * the user actually asked:
 *
 *   - paste (2026-09-08): its non-keyboard twin is the browser's own paste,
 *     which reaches the terminal unchanged — the chords exist because a Windows
 *     app window does not always offer that menu, and a login code has to get
 *     in somehow. Its note answers "why not ctrl+v?".
 *   - copy (2026-09-10): xterm serves the browser's own copy event, but the
 *     only key that fires one is ctrl+c, which xterm turns into the interrupt.
 *     Its note says the two things a terminal user has to be able to trust:
 *     plain ctrl+c is still the interrupt, and with nothing selected these
 *     keys do nothing.
 *   - pasting FILES (2026-09-16, A9b): the first two are chord rows with no app
 *     control; this one is a GESTURE row whose note states a limit instead —
 *     inside a terminal only plain ctrl+v ever carries files, because the two
 *     paste chords above are served from the text clipboard, which can never
 *     see a file list.
 *
 * The link row is a MOUSE gesture, not a chord: a plain click on a link a
 * program printed does nothing, and ctrl (or cmd) is the second gesture that
 * opens it — so the table has to say so, or the feature is invisible.
 *
 * GESTURE ROWS NAME THEIR TWIN (A10). Every drag in this app has a keyboard
 * equivalent, and the drags are the affordances a user cannot discover by
 * looking — so a gesture row's right-hand column is that twin: the chord, or
 * the visible control that does the same thing. A gesture row with nothing
 * there would be a control that exists only under a pointer, which this
 * project forbids.
 */
import { el, button, trapTab } from './util.ts';

interface Row {
  keys: string[];
  /** Mouse-gesture sentence, not a chord: rendered as plain wrapping text, not a nowrap <kbd> chip. */
  gesture?: boolean;
  what: string;
  ui: string;
  /** One line under the row, for the three entries whose existence or limit needs a reason (paste, copy, pasting files). */
  note?: string;
}

const ROWS: Row[] = [
  { keys: ['ctrl+alt+←↑↓→'], what: 'move pane focus in the active tab', ui: 'click a pane' },
  { keys: ['ctrl+alt+shift+←↑↓→'], what: 'move the focused pane (swap)', ui: 'drag a pane header onto a pane' },
  { keys: ['ctrl+alt+1…9'], what: 'switch tab', ui: 'tab strip' },
  { keys: ['ctrl+alt+shift+pgup/pgdn'], what: 'move the active tab left / right (reorder)', ui: 'drag a tab along the strip' },
  { keys: ['ctrl+alt+pgup/pgdn'], what: 'switch file tab in the focused editor pane', ui: 'click a tab in the pane header' },
  { keys: ['ctrl+alt+enter'], what: 'open the focused row in the Files panel beside the focused pane', ui: 'drag a file row onto a pane edge' },
  { keys: ['ctrl+alt+m'], what: 'move the active file tab to the next pane, or into a new split', ui: 'drag a file tab onto a pane or a pane edge' },
  { keys: ['ctrl+alt+w'], what: 'close the active file tab (the last one closes its pane)', ui: '× on the tab' },
  { keys: ['ctrl+alt+t'], what: 'launch a new session (dialog)', ui: 'New session, or + in the tab strip' },
  { keys: ['drag a tab onto a pane or tab'], gesture: true, what: 'merge its panes into that view (split)', ui: 'split in the sessions panel' },
  { keys: ['drag a tab along the strip'], gesture: true, what: 'reorder the tabs', ui: 'ctrl+alt+shift+pgup/pgdn' },
  { keys: ['drag a pane header onto another pane'], gesture: true, what: 'swap the two panes', ui: 'ctrl+alt+shift+←↑↓→' },
  { keys: ['drag a pane header to the tab strip'], gesture: true, what: 'extract the session to its own tab', ui: 'Own tab in the pane header' },
  { keys: ['drag a file row onto a pane edge'], gesture: true, what: 'open that file in a split beside that pane', ui: 'ctrl+alt+enter' },
  { keys: ['drag a file row onto a tab'], gesture: true, what: 'open that file in that tab', ui: 'switch to that tab (ctrl+alt+1…9) with a pane focused, then click the row' },
  { keys: ['drag a file row onto an editor pane'], gesture: true, what: 'open it there as a tab', ui: 'click the row' },
  { keys: ['drag a file tab onto a pane edge'], gesture: true, what: 'open it in a split beside that pane', ui: 'ctrl+alt+m' },
  { keys: ['drag a file tab onto another editor pane'], gesture: true, what: 'move it there', ui: 'ctrl+alt+m' },
  {
    keys: ['drag files from Explorer onto a folder or a pane'],
    gesture: true,
    what: 'copy them into that folder',
    // `Copy files here…` is spelled out rather than interpolated from
    // `COPY_LABEL` (ui/files-select-model.ts): this table is read as SOURCE by
    // tests/ui-shortcuts-table.test.ts, whose scans match `ui: '…'` and would
    // both go vacuous on a template literal — and a `${…}` hole in this column
    // could hide a chord the overlay claims. One wording, two spellings, and
    // the strip's own label still has exactly one definition.
    ui: 'Copy files here… under the panel header, ctrl+alt+c on a folder row, or paste with files on the clipboard',
  },
  {
    keys: ['click a folder row'],
    gesture: true,
    what: 'select it and open or close it',
    ui: 'enter on the focused row',
  },
  // A9b brief 2 restores the right-click row here, once a contextmenu listener and the menu-key chord exist.
  {
    keys: ['paste with files on the clipboard'],
    gesture: true,
    what: 'copy them into the selected folder',
    ui: 'Copy files here… under the panel header, or ctrl+alt+c on a folder row',
    note: "Inside a terminal that is plain ctrl+v; the other paste keys stay the terminal's.",
  },
  { keys: ['←→ / ↑↓ on a divider'], what: 'nudge the split, enter resets it', ui: 'drag the divider, double-click resets it' },
  { keys: ['click a session row'], what: 'go to its tab', ui: 'rows in the sessions panel' },
  {
    keys: ['ctrl+shift+v', 'shift+insert'],
    what: 'paste the clipboard into the terminal',
    ui: "the browser's own paste",
    note: 'Plain ctrl+v goes to the program running in the terminal (unless the clipboard carries files), so pasting text needs its own keys.',
  },
  {
    keys: ['ctrl+shift+c', 'ctrl+insert'],
    what: 'copy the selection',
    ui: 'select with the mouse, then press the keys',
    note: 'Plain ctrl+c stays the interrupt; with nothing selected these keys do nothing.',
  },
  { keys: ['ctrl+click a link'], gesture: true, what: 'open it in your browser', ui: 'links printed in the terminal' },
  { keys: ['?', 'ctrl+alt+/'], what: 'this overlay', ui: 'Keyboard shortcuts in the statusline' },
  { keys: ['esc'], what: 'close a panel or dialog, or cancel a tab or pane drag', ui: '× buttons' },
];

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
    "Everything else goes to the terminal: arrows and esc are never intercepted, and plain ctrl+c/v go straight to it — unless the clipboard carries files and a folder is selected, which is the one paste the app keeps for itself. App chords live only on ctrl+alt (altgr is left alone), and the paste and copy chords above are the only other keys the app takes.";

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
