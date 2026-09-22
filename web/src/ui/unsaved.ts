/**
 * THE QUESTION BEFORE TYPED TEXT IS DROPPED (Nocturne part B4, user decision
 * D1, 2026-09-22) — and the four doors it stands in.
 *
 * WHAT IT IS FOR. Until B4 a file pane held text that had never been on disk,
 * so closing it lost nothing real and the amber dot was the whole warning.
 * B4 makes that text a file, and the rule is now the plain one: unsaved text
 * is never dropped without a question. Every door that would orphan it asks:
 *
 *   - the `×` on a file tab's chip           (`closeTabGuarded`)
 *   - the `×` of a whole editor pane          (`closeSlotGuarded`)
 *   - ctrl+alt+w on the focused editor pane   (`closeActiveTabGuarded`)
 *   - the `×` of a whole tab in the strip     (`closeViewGuarded`)
 *
 * and the browser asks the same question for a reload or a window close
 * (`unloadGuard`, wired in `main.ts`). ENDING A SESSION IS NOT A DOOR: it
 * takes no editor tab with it (the A10b rule), so it has nothing to ask about.
 *
 * ONE KNOWN DOOR HAS NO QUESTION: the backend's grace timer, which ends the
 * app a while after the last window closed. There is no window left to ask in.
 *
 * IT ASKS ONLY WHEN SOMETHING WOULD REALLY BE LOST. `state.dirtyLostBy` is the
 * arithmetic (state.ts, pure and tested): a file open in TWO panes is not lost
 * by closing one of them, so that close asks nothing at all. A question with a
 * false premise trains the user to answer it blindly.
 *
 * THE CARD IS THE DELETE DIALOG'S, exactly (ui/delete-dialog.ts, B10a): the
 * app's smallest card — a question, two answers, no header, no `×`, no icon —
 * with the irreversible answer written as danger INK and an OUTLINE, never a
 * fill. The one difference is which button holds the keyboard: here the safe
 * answer is `Keep editing`, so IT is focused, and Escape and the backdrop mean
 * the same. The CSS is one shared block (`.dd-…, .ud-…` in app.css): one card,
 * two users, no second set of values.
 */
import * as st from '../state.ts';
import { el, button, trapTab } from './util.ts';
import { discardQuestion, filePathOf } from './editor-model.ts';
import { fileName } from './slots-model.ts';

let scrim: HTMLElement | null = null;
let restore: HTMLElement | null = null;
/** Answers the card that is up; null while none is. */
let answer: ((discard: boolean) => void) | null = null;

/**
 * Is the browser question still the app's to ask? A reload the APP performs is
 * not a door the user is walking out of: by the time `location.reload()` runs
 * in the restart/update handoff the old backend has already torn down, so a
 * `beforeunload` sheet there offers a "stay" that leaves the page on a backend
 * that is gone. Every app-initiated reload disarms this first.
 */
let armed = true;

/**
 * Give up the browser question for good — called immediately before an
 * app-initiated `location.reload()` (`ui/update.ts`'s restart handoff, and
 * `main.ts`'s auth-loss recovery). One way: the page is leaving.
 */
export function disarmUnloadGuard(): void {
  armed = false;
}

/** Is the discard question up? `main.ts`'s Escape ladder asks. */
export function isDiscardDialogOpen(): boolean {
  return scrim !== null;
}

/**
 * Escape, dispatched from `main.ts`'s one keydown ladder (ranked with the
 * other file dialogs). It means `Keep editing` — the only safe answer to a
 * question about text that is not on disk yet.
 */
export function discardDialogEscape(): void {
  close(false);
}

/** Take the card away and answer whoever asked. */
function close(discard: boolean): void {
  if (scrim === null) return;
  scrim.remove();
  scrim = null;
  const back = restore;
  restore = null;
  const reply = answer;
  answer = null;
  if (back !== null && back.isConnected) back.focus();
  reply?.(discard);
}

/**
 * Ask whether the unsaved text of these files may go. `ids` are `state.edits`
 * keys (`f:<path>`); the card shows NAMES or a count, never a path.
 *
 * An empty list is answered `true` without a card: there is nothing to lose.
 * A second call while a card is up is answered `false` — one question at a
 * time, and the answer to a question nobody can see is "do nothing".
 */
export function confirmDiscard(
  ids: readonly string[],
  returnFocus?: HTMLElement | null,
): Promise<boolean> {
  if (ids.length === 0) return Promise.resolve(true);
  if (scrim !== null) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    answer = resolve;
    restore = returnFocus ?? null;
    open(ids.map((id) => fileName(filePathOf(id))));
  });
}

/**
 * The question as NODES, so the one name in it draws in the order it is
 * stored. A file name comes out of a repository, and a right-to-left run in it
 * reorders the sentence around itself (`Discard unsaved changes to ‏…?`) — the
 * rule `.pane-tab-pick` and `.commit-fpath-t` already carry, in the one place
 * this card prints a name. The sentence itself stays `discardQuestion`'s, so
 * the count form and the tests read one spelling.
 */
function questionNodes(names: readonly string[]): (HTMLElement | string)[] {
  const question = discardQuestion(names);
  const name = names.length === 1 ? (names[0] as string) : '';
  const at = name === '' ? -1 : question.indexOf(name);
  if (at === -1) return [question];
  return [
    question.slice(0, at),
    el('span', 'ud-name', name),
    question.slice(at + name.length),
  ];
}

/** Build the card, out of the names the question is about. */
function open(names: readonly string[]): void {
  // `modal-scrim` stays on the scrim: ui/keys.ts recognises an open dialog by
  // it (OPEN_FOCUS_OWNER_SELECTOR / OPEN_MODAL_SELECTOR), so the keyboard and
  // the external-drop layer both know a question is up.
  scrim = el('div', 'modal-scrim ud-scrim');
  const modal = el('div', 'ud-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'ud-title');

  const title = el('div', 'ud-title');
  title.append(...questionNodes(names));
  title.id = 'ud-title';
  const body = el('div', 'ud-body');
  body.append(title);

  // Read left to right the way every dialog here is: the way out on the left,
  // the answer on the right — and the answer that loses work is the only
  // `.btn-danger` shape this app uses.
  const keep = button('btn-quiet', 'Keep editing', () => close(false));
  const discard = button('btn-danger', 'Discard', () => close(true));
  const ft = el('footer', 'ud-ft');
  ft.append(keep, el('span', 'ud-gap'), discard);

  modal.append(body, ft);
  scrim.append(modal);
  scrim.addEventListener('mousedown', (e) => {
    // The backdrop is `Keep editing`, like Escape and like the button.
    if (e.target === scrim) close(false);
  });
  trapTab(modal);
  (document.querySelector('.modal-host') ?? document.body).append(scrim);

  // THE SAFE ANSWER HOLDS THE KEYBOARD. A card that appeared under the user's
  // hands with Enter half-pressed must not throw away what they typed.
  keep.focus();
}

/**
 * Close ONE file tab, asking first when it would orphan unsaved text.
 * `state.closeTab` is called only after `Discard` — and, when nothing would be
 * lost, without any card at all.
 */
export function closeTabGuarded(
  viewId: string,
  slot: number,
  tab: number,
  returnFocus?: HTMLElement | null,
): void {
  guard(st.dirtyLostBy(viewId, slot, tab), returnFocus, () => {
    st.closeTab(viewId, slot, tab);
  });
}

/** ctrl+alt+w: the ACTIVE tab of that pane, through the same guard. */
export function closeActiveTabGuarded(viewId: string, slot: number): void {
  const tab = st.activeTabIndex(viewId, slot);
  if (tab === null) return; // not an editor pane: the chord does nothing (A10b)
  closeTabGuarded(viewId, slot, tab);
}

/** Close a whole editor pane — every tab in it — through the guard. */
export function closeSlotGuarded(
  viewId: string,
  slot: number,
  returnFocus?: HTMLElement | null,
): void {
  guard(st.dirtyLostBy(viewId, slot), returnFocus, () => {
    st.closeSlot(viewId, slot);
  });
}

/**
 * Close a whole tab through the guard. The ACT is handed in, because the tab
 * strip's `×` does more than close a view (it ends the sessions in it first,
 * ui/tabs.ts) and this module may not know about sessions.
 */
export function closeViewGuarded(
  viewId: string,
  act: () => void,
  returnFocus?: HTMLElement | null,
): void {
  guard(st.dirtyLostBy(viewId), returnFocus, act);
}

/** Ask when the list says something would be lost, then act. */
function guard(ids: string[], returnFocus: HTMLElement | null | undefined, act: () => void): void {
  if (ids.length === 0) {
    act();
    return;
  }
  void confirmDiscard(ids, returnFocus).then((discard) => {
    if (discard) act();
  });
}

/**
 * `beforeunload`: the browser's own question, for the two doors the app cannot
 * put a card in front of — a reload and a window close (D1). Armed ONLY while
 * something is unsaved; a page that always asks is a page whose question means
 * nothing.
 *
 * The wording is the browser's (a page may not choose it), and `returnValue`
 * is set beside `preventDefault()` because the older browsers ask on that
 * alone. Returns whether it armed, so a test can read the decision.
 */
export function unloadGuard(e: { preventDefault(): void; returnValue: unknown }): boolean {
  if (!armed) return false;
  if (st.state.edits.size === 0) return false;
  e.preventDefault();
  e.returnValue = '';
  return true;
}
