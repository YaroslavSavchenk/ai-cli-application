/**
 * The delete confirmation (Nocturne part B10a, user decision 2026-09-20,
 * `memory/decisions/b10a-multi-select-and-delete.md`, prefix `dd-`) — the ONE
 * stop between a keystroke and gone bytes.
 *
 * PERMANENT: no trash, no undo, no recycle bin. That is the whole reason this
 * card exists, and the reason it is the smallest dialog in the app: a question,
 * at most one line under it, and two answers. There is nothing to configure,
 * nothing to tick and nothing to read twice.
 *
 * DESIGN BRIEF (the direction, in one sentence): the drop dialog's card with
 * everything that is not the question taken away, and the danger written as
 * INK and an OUTLINE — `Delete` wears `.btn-danger`, a danger-coloured border
 * and label over the card's own ground, never a red fill (`--color-ink-on-
 * danger` stays reserved for the dead-pane banner). A filled red button is the
 * shape this app uses nowhere, and it would also be the one control on screen
 * that pulls the eye toward the irreversible answer.
 *
 * WHAT IT OWNS AND WHAT IT DOES NOT. It owns the card and nothing else: no
 * paths, no items, no request, no refresh. `openDeleteDialog()` is handed two
 * STRINGS — the question and the optional second line, both built by
 * `ui/delete-model.ts` out of NAMES (PROJECT-SCOPE, 2026-07-25: a path never
 * reaches a label) — and a callback. So this module cannot name a path even by
 * accident, and the sentence a user confirms is the sentence that was tested.
 *
 * THE KEYBOARD STARTS ON CANCEL, which is this card's one deliberate deviation
 * from every other dialog in the app (they focus the safe accent answer — and
 * here the safe answer IS Cancel). A card that opened under a half-pressed
 * Enter may not delete anything.
 *
 * NO `×`. Two buttons already answer the question; a third control that means
 * the same as one of them is a third answer to a yes/no question. Escape and
 * the backdrop are Cancel, exactly like the `Cancel` button.
 *
 * The dialog idiom is the drop dialog's: created on open, removed on close, one
 * at a time, `.modal-scrim` kept on the scrim because `ui/keys.ts` finds an
 * open dialog by that class, `trapTab` inside, focus handed back to whatever
 * opened it, Escape dispatched centrally from `main.ts`'s ladder
 * (`deleteDialogEscape`).
 */
import { el, button, trapTab, ModalSlot } from './util.ts';

/** One confirmation: what it asks, what it adds, and what a Yes means. */
export interface DeleteRequest {
  /** The question — `deleteQuestion()`, names only, never a path. */
  question: string;
  /** The one line under it, when it adds something — `deleteSubLine()`, else null. */
  sub: string | null;
  /** Focused again on close: the row or the menu's row the act came from. */
  returnFocus: HTMLElement | null;
  /** The user said Delete. Called once, after the card is already gone. */
  onConfirm(): void;
}

/** The card on screen and the row the keyboard goes back to (ui/util.ts). */
const slot = new ModalSlot();

export function isDeleteDialogOpen(): boolean {
  return slot.isOpen();
}

/**
 * Escape, dispatched from `main.ts`'s one keydown ladder, where this card is
 * ranked after the folder picker and before the drop dialog. It is CANCEL,
 * exactly — there is no third meaning to give it here.
 */
export function deleteDialogEscape(): void {
  slot.close();
}

export function openDeleteDialog(req: DeleteRequest): void {
  if (slot.isOpen()) return; // one question at a time

  // `modal-scrim` stays on the scrim: ui/keys.ts recognises an open dialog by
  // it, and the panel's own Delete key refuses to arm while one is up.
  const scrim = el('div', 'modal-scrim dd-scrim');
  slot.hold(scrim, req.returnFocus);
  const modal = el('div', 'dd-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'dd-title');

  const title = el('div', 'dd-title', req.question);
  title.id = 'dd-title';
  const body = el('div', 'dd-body');
  body.append(title);
  if (req.sub !== null) body.append(el('div', 'dd-sub', req.sub));

  // The app's button pair, read left to right the way every other dialog is:
  // the way out on the left, the answer on the right — and here the answer is
  // the one that cannot be taken back, so it is the only `.btn-danger` in the
  // app.
  const cancelBtn = button('btn-quiet', 'Cancel', () => slot.close());
  const deleteBtn = button('btn-danger', 'Delete', () => {
    // Closed FIRST, then acted on: closing hands the keyboard back to the row
    // the act came from, and what follows rebuilds those rows.
    slot.close();
    req.onConfirm();
  });
  const ft = el('footer', 'dd-ft');
  ft.append(cancelBtn, el('span', 'dd-gap'), deleteBtn);

  modal.append(body, ft);
  scrim.append(modal);
  scrim.addEventListener('mousedown', (e) => {
    // The backdrop is Cancel, like Escape and like the button.
    if (e.target === scrim) slot.close();
  });
  trapTab(modal);
  (document.querySelector('.modal-host') ?? document.body).append(scrim);

  // CANCEL HOLDS THE KEYBOARD. A card that appeared under the user's hands
  // with Enter half-pressed must not delete anything — the safe answer takes
  // the key, and Delete is one Tab away.
  cancelBtn.focus();
}
