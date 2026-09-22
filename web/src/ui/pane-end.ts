/**
 * The End session button in a SESSION pane's header (Nocturne B8, user's
 * decision 2026-09-22): top right, after the state pill and `Own tab`, on every
 * session pane — a tab holding that one pane included. Editor panes have their
 * own `×` and never get this.
 *
 * It ends the session through the one kill path the tab `×`, the Sessions
 * drawer and the exited banner already share (`killSession`, injected by
 * ui/panes.ts), and it asks the same question they ask: `Confirm before ending
 * a session` (B6), read at CLICK time — on, the first click arms (`Sure?`) and
 * the second ends; off, one click ends.
 *
 * Its own module so the behaviour can be driven under `node --test`: panes.ts
 * reaches @xterm/xterm and cannot be imported there.
 *
 * The header around it is a pointer-drag source (ui/dnd.ts `armDrag`, armed
 * with the `'button'` ignore): a press on this button — or on the glyph inside
 * it — never starts a pane drag.
 */
import { button, armButton } from './util.ts';
import { xIcon } from './icons.ts';
import { getBehaviour } from './prefs-model.ts';

/** The button's spoken name and its tooltip — one wording. */
export const END_SESSION = 'End session';

export function endSessionButton(end: () => void): HTMLButtonElement {
  const btn = button('pane-end', '');
  btn.append(xIcon());
  btn.setAttribute('aria-label', END_SESSION);
  btn.title = END_SESSION;
  armButton(btn, 'Sure?', end, { ask: () => getBehaviour().confirmEnd });
  return btn;
}
