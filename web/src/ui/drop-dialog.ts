/**
 * The drop dialog (Nocturne part A9, prefix `fd-`) — what the app says AFTER
 * files and folders are dropped on it from Windows Explorer, or picked with
 * the Files panel's own button.
 *
 * ONE dialog per drop (user decision 2, 2026-09-15), three states in one card,
 * never two cards and never a checkbox:
 *
 *   1. CONFLICTS — only when something with the same name is already in the
 *      destination. The title names what clashes, a line under it says how far
 *      the choice reaches when it is more than one, and the three Explorer
 *      verbs answer it: Replace, Keep both, Skip. The choice covers the whole
 *      drop, which is why the sentence states the count instead of offering an
 *      "apply to all" box to tick.
 *   2. COPYING — the same card, now a list: one row per dropped item, each
 *      resolving in turn, with the progress line under it. No spinner: this
 *      list IS the progress, the way the restart confirmation's step line is.
 *   3. RESULT — the same list, still readable, under one sentence that says
 *      what happened, and Close.
 *
 * THE CARD CAN BE PUT AWAY WHILE IT COPIES (user decision, 2026-09-20), the
 * way the restart confirmation can be put away during its preflight: Escape,
 * the `×` and the backdrop HIDE it — scrim gone, keyboard back where it came
 * from — and the copy runs on untouched. A 2000-file drop may take minutes,
 * and an aria-modal scrim over a running session for minutes is a session
 * nobody can type into. Nothing is cancelled (that decision is unchanged and
 * cannot be honest: files already on disk cannot be un-copied), nothing
 * re-opens, and the outcome still reaches the user — as ONE statusline flash
 * carrying the exact sentence the result state would have shown.
 *
 * IT REALLY COPIES, since part B10 phase 2. The card no longer pretends and no
 * longer says it is pretending: the stagger, the promise line and the marker
 * that held their place are gone, and the rows settle when a real `PUT` for
 * that item answers. A row is therefore as slow as the file it stands for,
 * which is why the settled row is scrolled into view inside the list — in a
 * bounded box, so nothing outside the scrim moves and no pane is resized.
 *
 * WHAT THIS MODULE OWNS AND WHAT IT DOES NOT. It owns the card; it owns no
 * drag, no target, no listing, and — the point of `run` — no write.
 * `openDropDialog()` is handed a destination NAME (never a path —
 * PROJECT-SCOPE, 2026-07-25), the top-level items, the destination's own
 * top-level names and a RUNNER closed over the real destination
 * (`ui/drop-upload.ts`, built in `main.ts`), so no path can reach this module
 * even by accident. The rules that turn any of it into words live DOM-free
 * next door in `drop-model.ts`. The drag layer (`ui/filedrop.ts`) is the only
 * caller.
 *
 * The dialog idiom is the folder picker's: created on open, removed on close,
 * one at a time, `.modal-scrim` kept on the scrim because `ui/keys.ts` finds an
 * open dialog by that class, `trapTab` inside, focus handed back to whatever
 * opened it. Escape is dispatched centrally from `main.ts` (`dropDialogEscape`)
 * like every sibling dialog's.
 */
import { el, button, trapTab } from './util.ts';
import { flash } from './statusline.ts';
import { formatError, log } from '../log.ts';
import {
  conflictTitle,
  conflictsOf,
  copyingHeader,
  failNote,
  progressText,
  resultText,
  type Choice,
  type DropItem,
  type ItemResult,
  type Outcome,
} from './drop-model.ts';
import type { DropRun } from './drop-upload.ts';

/** One drop, resolved: where it lands, what it carries, what is already there. */
export interface DropRequest {
  /** The destination's NAME — `Home`, a project's name, a folder's name. */
  dest: string;
  /** The top-level items of the drop, in the order the browser reported them. */
  items: DropItem[];
  /** The destination's own top-level names, for the conflict test. */
  listing: readonly string[];
  /** Focused again on close: the row, pane or button the drop came from. */
  returnFocus: HTMLElement | null;
  /**
   * The copy itself (B10), already closed over the real destination. The
   * dialog asks it for the rows of an answer and then lets it run; what it
   * writes, in which order, and what a failure is called are all its.
   */
  run: DropRun;
}

/** The word a resolved row shows on its right. */
const STATE_WORD: Record<Outcome, string> = {
  copied: 'Copied',
  skipped: 'Skipped',
  failed: 'Failed',
};

/** How far one answer reaches, when it reaches further than one item. */
function scopeLine(conflicts: number): string | null {
  return conflicts > 1 ? `The choice applies to all ${conflicts}.` : null;
}

/** Which of the three states the card is in. Escape means a different thing in each. */
type Phase = 'conflicts' | 'copying' | 'result';

let scrim: HTMLElement | null = null;
let restore: HTMLElement | null = null;
let phase: Phase = 'conflicts';
/**
 * Which OPEN this is. A copy cannot be cancelled and the card cannot be closed
 * while it runs, but a run's callbacks outlive nothing by accident: every one
 * of them checks that the card it was started for is still the card on screen.
 */
let epoch = 0;
/**
 * A copy is in flight — card on screen or hidden. It is what stops a SECOND
 * drop from starting while the first one writes (`ui/filedrop.ts` refuses one
 * with a sentence): two runs would race the panel refresh and interleave two
 * lists of rows in one card.
 */
let running = false;
/** What Escape and the `×` do right now, installed by the open dialog. */
let dismiss: (() => void) | null = null;

export function isDropDialogOpen(): boolean {
  return scrim !== null;
}

/**
 * Is a copy still writing? True from the moment an answer starts one until its
 * last row is settled, whether or not the card is still on screen.
 */
export function isDropRunning(): boolean {
  return running;
}

/**
 * Escape, dispatched from `main.ts`'s one keydown ladder, where this dialog is
 * ranked after the folder picker and before the Add-a-project dialog. The arm
 * there is three lines and carries no comment of its own on purpose: the whole
 * decision is here, and that ladder is length-guarded
 * (`tests/ui-files-panel.test.ts`, the Escape-branch non-vacuity bound).
 *
 * It is the `×`, exactly: Skip while the question is up, HIDE while the copy
 * runs, and Close once it is over. Hiding is not cancelling — files that
 * already landed cannot be un-copied honestly, so a stop would either lie or
 * delete something the user can see (B10, 2026-09-20). What goes away is the
 * card; the copy runs on and says how it ended in one line on the statusline.
 */
export function dropDialogEscape(): void {
  dismiss?.();
}

/**
 * Take the card off the screen and hand the keyboard back to whatever opened
 * it. The DOM is removed rather than hidden (the idiom every dialog here
 * uses), which also takes `trapTab`'s listener with it.
 */
function takeDown(): void {
  if (scrim === null) return;
  dismiss = null;
  scrim.remove();
  scrim = null;
  const back = restore;
  restore = null;
  if (back !== null && back.isConnected) back.focus();
}

/** The card is over: nothing of this drop is coming back. */
function closeDialog(): void {
  if (scrim === null) return;
  epoch += 1;
  takeDown();
}

/**
 * Put the card away while the copy keeps running (user decision, 2026-09-20).
 * The epoch is deliberately NOT bumped: this run still owns its callbacks, and
 * its result still has a sentence to say when it lands.
 */
function hideCard(): void {
  if (scrim === null) return;
  log.info('drop dialog hidden; the copy keeps running');
  takeDown();
}

export function openDropDialog(req: DropRequest): void {
  // One dialog per drop, one drop at a time — and one RUN at a time: a copy
  // that is still writing owns the panel refresh and the rows, hidden or not.
  if (scrim !== null || running) return;
  const items = [...req.items];
  if (items.length === 0) return; // a drop with nothing in it has nothing to say

  restore = req.returnFocus;
  const conflicts = conflictsOf(items, req.listing);
  log.info(`drop dialog: ${items.length} items, ${conflicts.length} conflicts`);

  // `modal-scrim` stays on the scrim: ui/keys.ts recognises an open dialog by
  // it. `fd-scrim` adds only the top anchor, like every other dialog's.
  scrim = el('div', 'modal-scrim fd-scrim');
  const modal = el('div', 'fd-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'fd-title');

  // ---- header: the news, and the one control that dismisses it -------------
  const hd = el('header', 'fd-hd');
  const titles = el('div', 'fd-titles');
  const title = el('div', 'fd-title');
  title.id = 'fd-title';
  // The title IS the state: the question, then what is being copied, then what
  // happened. Announced politely on each change — three sentences for a whole
  // drop. The rows below are NOT a live region: they settle one per upload and
  // would read as a stutter of single words.
  title.setAttribute('aria-live', 'polite');
  const sub = el('div', 'fd-sub');
  sub.hidden = true;
  titles.append(title, sub);
  const closeX = button('fd-x', '×', () => dismiss?.());
  hd.append(titles, closeX);

  // ---- body: the list, and the count under it ------------------------------
  const body = el('div', 'fd-body');
  const list = el('ul', 'fd-list');
  list.hidden = true;
  const progress = el('div', 'fd-progress');
  progress.hidden = true;
  const step = el('span', 'fd-step');
  // Focusable by script only. While the copy runs every button is hidden, so
  // without this the modal holds nothing focusable and focus would fall to
  // <body> BEHIND an aria-modal scrim (the restart confirmation's lesson).
  step.tabIndex = -1;
  progress.append(step);
  body.append(list, progress);

  // ---- footer --------------------------------------------------------------
  // The app's button pair, read left to right the way every other dialog is:
  // the way out on the left where Cancel lives (and Skip IS this dialog's
  // Cancel — Escape and the `×` both mean it), then the two answers that
  // actually copy, with the accent outline on the one that can lose nothing.
  const skipBtn = button('btn-quiet', 'Skip', () => choose('skip'));
  const replaceBtn = button('btn-quiet', 'Replace', () => choose('replace'));
  const keepBtn = button('btn-accent', 'Keep both', () => choose('keep-both'));
  // `Hide` is the restart confirmation's word for the same thing, in the same
  // quiet button, on the same side of the same spacer: the card goes, the work
  // stays. One vocabulary for "put this away while it runs".
  const hideBtn = button('btn-quiet', 'Hide', () => hideCard());
  const closeBtn = button('btn-quiet', 'Close', () => closeDialog());
  const ft = el('footer', 'fd-ft');
  ft.append(skipBtn, el('span', 'fd-gap'), replaceBtn, keepBtn, hideBtn, closeBtn);

  modal.append(hd, body, ft);
  scrim.append(modal);
  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) dismiss?.();
  });
  trapTab(modal);
  // The dialog host of the shell; a page that has not built one yet (never, in
  // the app — the drag layer starts after it) still gets a working dialog.
  (document.querySelector('.modal-host') ?? document.body).append(scrim);

  /**
   * The rows of the copy, by item index — built when a copy starts. `done` is
   * what the runner has reported; a row that never got its turn is what a
   * failed RUN (not a failed file) has to answer for.
   */
  let rows: {
    row: HTMLElement;
    text: HTMLElement;
    state: HTMLElement;
    result: ItemResult;
    done: boolean;
  }[] = [];

  function showPhase(next: Phase): void {
    phase = next;
    const asking = next === 'conflicts';
    sub.hidden = asking ? sub.textContent === '' : true;
    // The question shows no LIST: a list of what is being copied would be a
    // list of what has not been decided yet.
    list.hidden = asking;
    progress.hidden = next !== 'copying';
    skipBtn.hidden = !asking;
    replaceBtn.hidden = !asking;
    keepBtn.hidden = !asking;
    // The copying state has exactly one control, and it is not a cancel: the
    // footer stays, carrying `Hide`.
    hideBtn.hidden = next !== 'copying';
    closeBtn.hidden = next !== 'result';
    closeX.hidden = false;
    // The glyph is one shape with three jobs; the label says which one it has.
    closeX.setAttribute('aria-label', asking ? 'skip' : next === 'copying' ? 'hide' : 'close');
    // Escape, the `×` and a press on the backdrop are ONE decision, so they are
    // one function: Skip, Hide, Close.
    dismiss = asking ? () => choose('skip') : next === 'copying' ? hideCard : closeDialog;
  }

  /** An answer to the question — or the only path there was, with no question. */
  function choose(choice: Choice): void {
    if (phase !== 'conflicts') return;
    log.info(`drop dialog: ${choice}`);
    // The plan the runner is about to EXECUTE, not a second reading of it: one
    // plan behind the rows and the writes is what keeps a row from saying one
    // thing while the copy does another (D2).
    const results = req.run.plan(choice);
    rows = results.map((r) => {
      const row = el('li', 'fd-row is-pending');
      const text = el('div', 'fd-rowtext');
      // A dropped name is untrusted display text; el() sets it as a text node.
      text.append(el('span', 'fd-name', r.name));
      // The note is an OUTCOME (the name it landed under, the limit it was
      // over), so it arrives with the outcome word and not before it: a row
      // that has not had its turn yet says its name and nothing else.
      const state = el('span', 'fd-state');
      row.append(text, state);
      return { row, text, state, result: r, done: false };
    });
    list.replaceChildren(...rows.map((x) => x.row));
    title.textContent = copyingHeader(items.length, req.dest);
    // The count starts at the ROWS and is overwritten by the runner's own
    // first `progress`, which counts files — a drop of one folder would
    // otherwise read `0 of 1` for as long as it takes.
    step.textContent = progressText(0, rows.length, req.dest);
    showPhase('copying');
    // The count keeps the keyboard, not `Hide`: a card that opened under the
    // user's hands with Enter half-pressed may not put itself away. `Hide` is
    // one Tab away, and Escape does it from anywhere.
    step.focus();

    // The card belongs to THIS run for as long as this run is the open card.
    const mine = epoch;
    running = true;
    void req.run
      .start(choice, {
        settled: (index, result) => {
          if (mine !== epoch) return;
          settle(index, result);
        },
        progress: (done, total) => {
          if (mine !== epoch || scrim === null) return;
          step.textContent = progressText(done, total, req.dest);
        },
      })
      .then((final) => finished(mine, final))
      .catch((err: unknown) => {
        // The RUN itself threw — not a file, the run. Whatever it managed is
        // on disk and stays there; every row that never had its turn says the
        // honest nothing, and the card reaches its result state instead of
        // standing in `Copying…` for the rest of the session.
        log.error(`drop dialog: the copy did not finish: ${formatError(err)}`);
        for (let i = 0; i < rows.length; i += 1) {
          const r = rows[i];
          if (r === undefined || r.done) continue;
          settle(i, { ...r.result, state: 'failed', note: failNote(0) });
        }
        finished(
          mine,
          rows.map((r) => r.result),
        );
      });
  }

  /**
   * The copy is over. The card, if it is still on screen, becomes its result
   * state; if it was HIDDEN while it ran, the same sentence arrives as one
   * statusline flash — the result may not be swallowed just because the user
   * put the card away.
   */
  function finished(mine: number, final: readonly ItemResult[]): void {
    if (mine !== epoch) return;
    running = false;
    const said = resultText(final, req.dest);
    if (scrim === null) {
      flash(said);
      return;
    }
    title.textContent = said;
    showPhase('result');
    closeBtn.focus();
  }

  /**
   * One row is over: its outcome word, its reason under its name, and the
   * dimming taken off. Then `scrollIntoView({ block: 'nearest' })` — the
   * minimum scroll that keeps the settling edge of the list visible inside its
   * own 168px box (`.fd-list` scrolls; the card does not resize), so a drop of
   * 200 items still reads top-down without the user chasing it. `nearest` does
   * nothing at all while everything fits, which is the common case.
   */
  function settle(index: number, result: ItemResult): void {
    const row = rows[index];
    if (row === undefined) return;
    row.result = result;
    row.done = true;
    // A hidden card still tracks its rows (they are what a failed run has to
    // answer for) but paints nothing: it is not on screen.
    if (scrim === null) return;
    row.state.textContent = STATE_WORD[result.state];
    row.state.setAttribute('data-state', result.state);
    if (result.note !== undefined) row.text.append(el('div', 'fd-note', result.note));
    row.row.classList.remove('is-pending');
    row.row.scrollIntoView?.({ block: 'nearest' });
  }

  // ---- open in the state this drop is actually in --------------------------
  phase = 'conflicts'; // whatever the last drop ended in
  if (conflicts.length === 0) {
    // Nothing clashes, so there is no question to ask and the card opens as
    // the copy itself. The choice handed in is arbitrary and says so: with no
    // conflict every one of the three plans the same results.
    choose('replace');
    return;
  }
  title.textContent = conflictTitle(conflicts, req.dest);
  const scope = scopeLine(conflicts.length);
  if (scope !== null) sub.textContent = scope;
  showPhase('conflicts');
  // The safe answer holds the keyboard: Keep both copies everything and
  // overwrites nothing, so Enter on an untouched dialog can lose no file.
  keepBtn.focus();
}
