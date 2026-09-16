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
 * NOTHING IS COPIED. Part A9 is the visual half; the real write, its path
 * checks and its limits are part B10. That is a promise the card must make
 * itself rather than leave to a release note, so the two COPYING states carry
 * a line from `honestyLine()` saying nothing is written. The question carries
 * none since part B2: its conflicts are the destination folder's real
 * contents, read at drop time. ONE function, ONE call site, marked, so B10
 * deletes the mock by deleting what the marker names.
 *
 * WHAT THIS MODULE OWNS AND WHAT IT DOES NOT. It owns the card and the mock
 * stagger; it owns no drag, no target and no listing. `openDropDialog()` is
 * handed a destination NAME (never a path — PROJECT-SCOPE, 2026-07-25), the
 * top-level items, and the destination's own top-level names, and the rules
 * that turn those into words live DOM-free next door in `drop-model.ts`. The
 * drag layer (`ui/filedrop.ts`, part A9 brief 2) is the only caller.
 *
 * The dialog idiom is the folder picker's: created on open, removed on close,
 * one at a time, `.modal-scrim` kept on the scrim because `ui/keys.ts` finds an
 * open dialog by that class, `trapTab` inside, focus handed back to whatever
 * opened it. Escape is dispatched centrally from `main.ts` (`dropDialogEscape`)
 * like every sibling dialog's.
 */
import { el, button, trapTab } from './util.ts';
import { log } from '../log.ts';
import {
  conflictTitle,
  conflictsOf,
  copyingHeader,
  planResults,
  progressText,
  resultText,
  type Choice,
  type DropItem,
  type ItemResult,
  type Outcome,
} from './drop-model.ts';

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
}

/** The word a resolved row shows on its right. */
const STATE_WORD: Record<Outcome, string> = {
  copied: 'Copied',
  skipped: 'Skipped',
  failed: 'Failed',
};

/**
 * How far apart the mock resolves its rows. Short enough that a three-item
 * drop is over before it can be read as a wait, long enough that the list is
 * visibly a sequence and not a single repaint.
 */
const STEP_MS = 60;

/** What the copy and its result are pretending: nothing is written at all. */
const HONEST_COPYING =
  'Nothing is copied yet. This is what the copy will look like until the app can write files.';

/**
 * The sentence that keeps the mock honest — in the two states that still are
 * one. Since part B2 the CONFLICTS are real: `ui/filedrop.ts` reads the
 * destination folder's own top-level names at drop time, so the question is
 * about files that are really there and had nothing left to apologise for.
 * What is still pretending is the copy, and only the copy. ONE function with
 * exactly one call site so part B10 can delete the promise and the pretence
 * together.
 */
function honestyLine(phase: Phase): string {
  return phase === 'conflicts' ? '' : HONEST_COPYING;
}

/** How far one answer reaches, when it reaches further than one item. */
function scopeLine(conflicts: number): string | null {
  return conflicts > 1 ? `The choice applies to all ${conflicts}.` : null;
}

/** Which of the three states the card is in. Escape means a different thing in each. */
type Phase = 'conflicts' | 'copying' | 'result';

/** A copy in flight is not cancelled by a key: the dismissal that does nothing. */
function ignore(): void {
  /* deliberately nothing — see `dropDialogEscape` */
}

let scrim: HTMLElement | null = null;
let restore: HTMLElement | null = null;
let phase: Phase = 'conflicts';
/** The pending stagger tick, so closing the card never leaves one armed. */
let tick: number | null = null;
/** What Escape and the `×` do right now, installed by the open dialog. */
let dismiss: (() => void) | null = null;

export function isDropDialogOpen(): boolean {
  return scrim !== null;
}

/**
 * Escape, dispatched from `main.ts`'s one keydown ladder, where this dialog is
 * ranked after the folder picker and before the Add-a-project dialog. The arm
 * there is three lines and carries no comment of its own on purpose: the whole
 * decision is here, and that ladder is length-guarded
 * (`tests/ui-files-panel.test.ts`, the Escape-branch non-vacuity bound).
 *
 * It is the `×`, exactly: Skip while the question is up, Close once the copy
 * is over, and NOTHING while the copy runs — a copy in flight is not cancelled
 * by a key. Part B10, which will really be writing files by then, decides
 * whether a copy can be cancelled at all and what a half-copied folder means;
 * until it does, the honest answer to Escape here is to do nothing rather than
 * to claim a stop that never happened.
 */
export function dropDialogEscape(): void {
  dismiss?.();
}

/** Take the card down and hand the keyboard back to whatever opened it. */
function closeDialog(): void {
  if (scrim === null) return;
  if (tick !== null) window.clearTimeout(tick);
  tick = null;
  dismiss = null;
  scrim.remove();
  scrim = null;
  const back = restore;
  restore = null;
  if (back !== null && back.isConnected) back.focus();
}

export function openDropDialog(req: DropRequest): void {
  if (scrim !== null) return; // one dialog per drop, one drop at a time
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
  // drop. The rows below are NOT a live region: they resolve 60 ms apart and
  // would read as a stutter of single words.
  title.setAttribute('aria-live', 'polite');
  const sub = el('div', 'fd-sub');
  sub.hidden = true;
  titles.append(title, sub);
  const closeX = button('fd-x', '×', () => dismiss?.());
  hd.append(titles, closeX);

  // ---- body: the list, the progress line, the promise ----------------------
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
  const honest = el('p', 'fd-honest');
  body.append(list, progress, honest);

  // ---- footer --------------------------------------------------------------
  // The app's button pair, read left to right the way every other dialog is:
  // the way out on the left where Cancel lives (and Skip IS this dialog's
  // Cancel — Escape and the `×` both mean it), then the two answers that
  // actually copy, with the accent outline on the one that can lose nothing.
  const skipBtn = button('btn-quiet', 'Skip', () => choose('skip'));
  const replaceBtn = button('btn-quiet', 'Replace', () => choose('replace'));
  const keepBtn = button('btn-accent', 'Keep both', () => choose('keep-both'));
  const closeBtn = button('btn-quiet', 'Close', () => closeDialog());
  const ft = el('footer', 'fd-ft');
  ft.append(skipBtn, el('span', 'fd-gap'), replaceBtn, keepBtn, closeBtn);

  modal.append(hd, body, ft);
  scrim.append(modal);
  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) dismiss?.();
  });
  trapTab(modal);
  // The dialog host of the shell; a page that has not built one yet (never, in
  // the app — the drag layer starts after it) still gets a working dialog.
  (document.querySelector('.modal-host') ?? document.body).append(scrim);

  /** The rows of the copy, by item index — built when a copy starts. */
  let rows: { row: HTMLElement; text: HTMLElement; state: HTMLElement; result: ItemResult }[] = [];

  function showPhase(next: Phase): void {
    phase = next;
    const asking = next === 'conflicts';
    sub.hidden = asking ? sub.textContent === '' : true;
    // The question shows no LIST: a list of what is being copied would be a
    // list of what has not been decided yet. The body still carries the one
    // line that keeps this state honest, so it is never a blank band.
    list.hidden = asking;
    progress.hidden = next !== 'copying';
    // PLACEHOLDER MARKER — DELETE WITH THE MOCK (B10)
    honest.textContent = honestyLine(next);
    // The question has no line of its own any more (its conflicts are real
    // since B2), and an empty paragraph would still take its margin.
    honest.hidden = honest.textContent === '';
    skipBtn.hidden = !asking;
    replaceBtn.hidden = !asking;
    keepBtn.hidden = !asking;
    ft.hidden = next === 'copying'; // nothing to decide while it runs
    closeBtn.hidden = next !== 'result';
    closeX.hidden = next === 'copying';
    // The glyph is one shape with two jobs; the label says which one it has.
    closeX.setAttribute('aria-label', asking ? 'skip' : 'close');
    // Escape, the `×` and a press on the backdrop are ONE decision, so they are
    // one function: Skip, Close, or (while it copies) nothing at all.
    dismiss = asking ? () => choose('skip') : next === 'result' ? closeDialog : ignore;
  }

  /** An answer to the question — or the only path there was, with no question. */
  function choose(choice: Choice): void {
    if (phase !== 'conflicts') return;
    log.info(`drop dialog: ${choice}`);
    const results = planResults(items, req.listing, choice);
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
      return { row, text, state, result: r };
    });
    list.replaceChildren(...rows.map((x) => x.row));
    title.textContent = copyingHeader(items.length, req.dest);
    step.textContent = progressText(0, rows.length, req.dest);
    showPhase('copying');
    step.focus();
    resolveNext(0);
  }

  /** The mock stagger: one row settles, then the next, 60 ms apart. */
  function resolveNext(i: number): void {
    tick = window.setTimeout(() => {
      tick = null;
      const row = rows[i];
      if (row === undefined) return;
      row.state.textContent = STATE_WORD[row.result.state];
      row.state.setAttribute('data-state', row.result.state);
      if (row.result.note !== undefined) row.text.append(el('div', 'fd-note', row.result.note));
      row.row.classList.remove('is-pending');
      const done = i + 1;
      step.textContent = progressText(done, rows.length, req.dest);
      if (done < rows.length) {
        resolveNext(done);
        return;
      }
      title.textContent = resultText(
        rows.map((x) => x.result),
        req.dest,
      );
      showPhase('result');
      closeBtn.focus();
    }, STEP_MS);
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
