/**
 * The boot notice after the previous run stopped — WSL out of memory, WSL
 * shut down, the app stopped or crashed with a window open — and the resume
 * that puts its sessions back (Quality Q17 P3,
 * `.claude/plans/quality/PLAN-Q17.md` § P3 items 2 and 3). The rules and
 * every sentence are `./previous-exit-model.ts`; where a session goes is
 * `./resume-layout-model.ts` through `state.adoptResumed`.
 *
 * AT BOOT, once: read and CLEAR the recover flag (the `Restart` press of the
 * window this one replaces, `./relaunch.ts` — cleared whatever comes next, so
 * a flag can never resume anything twice), then `GET /api/previous-exit`.
 *   - 204: nothing to tell, nothing shown.
 *   - 200 + a fresh flag: `POST …/resume` at once (decision 2, no second
 *     question), then "3 sessions resumed".
 *   - 200 otherwise (a start from the shortcut): the notice offers
 *     `Resume N sessions` and `Dismiss`.
 * The resume is idempotent on the server: an answer with two empty lists
 * means another window (or an earlier press) already did it — the card goes
 * away and the session list is fetched, never "0 sessions resumed".
 *
 * HOW IT LOOKS: the update toast's `ut-` card in the same corner stack, with
 * the attention rule — it is news that waits for an answer, not an alarm; the
 * one line about sessions that could not be resumed is danger ink. The card
 * never takes the keyboard: the terminals come first, and every button on it
 * is reachable with Tab.
 *
 * LOGGED as shapes only: the cause and the counts, never the process name,
 * a session title or a failed row's `error`. A request that failed logs its
 * own failure (`formatError`), as every caller of `../api.ts` does.
 */
import * as api from '../api.ts';
import * as st from '../state.ts';
import { formatError, log } from '../log.ts';
import { el, button } from './util.ts';
import {
  DISMISS_LABEL,
  RECOVER_KEY,
  RESUME_FAILED,
  bootAction,
  causeSentence,
  failedLine,
  parseNotice,
  parseResumeAnswer,
  recoverFlagFresh,
  resumeLabel,
  resumedTitle,
  stoppedTitle,
} from './previous-exit-model.ts';
import type { PreviousExitNotice, PreviousExitResumeResponse } from '../../../shared/protocol.ts';
import type { LayoutSnapshot } from './resume-layout-model.ts';

/** The resume button's word while the server spawns the sessions. */
const RESUMING_LABEL = 'Resuming…';

/** Read the recover flag and clear it, in one go. */
function takeRecoverFlag(): string | null {
  try {
    const raw = localStorage.getItem(RECOVER_KEY);
    if (raw !== null) localStorage.removeItem(RECOVER_KEY);
    return raw;
  } catch {
    return null;
  }
}

/**
 * Build the card into the toast stack and ask the backend once. `snapshot` is
 * the stored arrangement as it was before `loadUi` pruned it; `refocus` hands
 * the keyboard back to the focused pane when the card goes away under it.
 * Answers the promise of that one round (tests await it; the app does not).
 */
export function initPreviousExit(
  stack: HTMLElement,
  snapshot: LayoutSnapshot,
  refocus: () => void,
): Promise<void> {
  const fresh = recoverFlagFresh(takeRecoverFlag(), Date.now());

  const card = el('div', 'ut-toast');
  card.hidden = true;
  card.setAttribute('role', 'status');
  card.setAttribute('aria-live', 'polite');
  const title = el('span', 'ut-title');
  const x = button('ut-x', '×', () => close());
  x.setAttribute('aria-label', 'close');
  const hd = el('div', 'ut-hd');
  hd.append(title, x);
  const body = el('div', 'ut-body');
  const fail = el('div', 'ut-body px-fail');
  const actions = el('div', 'ut-actions');
  const dismissBtn = button('btn-quiet', DISMISS_LABEL, () => dismiss());
  const resumeBtn = button('btn-accent', '', () => {
    if (notice === null) return;
    log.info('previous exit: resume chosen');
    void resume('button');
  });
  actions.append(dismissBtn, resumeBtn);
  card.append(hd, body, fail, actions);
  stack.append(card);

  let notice: PreviousExitNotice | null = null;

  function offer(error: string): void {
    if (notice === null) return;
    title.textContent = stoppedTitle(notice.sessions);
    body.textContent = causeSentence(notice);
    fail.textContent = error;
    fail.hidden = error === '';
    resumeBtn.textContent = resumeLabel(notice.sessions);
    resumeBtn.disabled = false;
    resumeBtn.hidden = notice.sessions === 0;
    dismissBtn.disabled = false;
    actions.hidden = false;
    // The offer is answered with a button: × would be a third answer whose
    // meaning nobody could guess.
    x.hidden = true;
    card.hidden = false;
  }

  function close(): void {
    if (card.hidden) return;
    card.hidden = true;
    refocus();
  }

  function dismiss(): void {
    log.info('previous exit: dismissed');
    close();
    api.dismissPreviousExit().catch((err: unknown) => {
      // Gone from this page either way; the next start asks again.
      log.warn(`previous exit: the dismissal was not saved: ${formatError(err)}`);
    });
  }

  async function resume(how: 'auto' | 'button'): Promise<void> {
    if (notice === null) return;
    resumeBtn.disabled = true;
    dismissBtn.disabled = true;
    resumeBtn.textContent = RESUMING_LABEL;
    let answer: PreviousExitResumeResponse | null;
    try {
      answer = parseResumeAnswer(await api.resumePreviousExit());
    } catch (err) {
      log.warn(`previous exit: resume (${how}) failed: ${formatError(err)}`);
      answer = null;
    }
    if (answer === null) {
      offer(RESUME_FAILED);
      return;
    }
    const { resumed, failed } = answer;
    log.info(`previous exit: resume (${how}) resumed=${resumed.length} failed=${failed.length}`);
    if (resumed.length === 0 && failed.length === 0) {
      // Already done elsewhere: say nothing, show what is running now.
      card.hidden = true;
      api
        .getSessions()
        .then((list) => st.setSessions(list))
        .catch(() => {
          // The 3 s poll brings them anyway.
        });
      return;
    }
    st.adoptResumed(snapshot, resumed);
    title.textContent = resumed.length > 0 ? resumedTitle(resumed.length) : stoppedTitle(notice.sessions);
    body.textContent = causeSentence(notice);
    fail.textContent = failedLine(failed.length);
    fail.hidden = failed.length === 0;
    actions.hidden = true;
    x.hidden = false;
    card.hidden = false;
  }

  return api
    .getPreviousExit()
    .then(async (raw) => {
      notice = parseNotice(raw);
      if (notice === null) return;
      const action = bootAction(notice, fresh);
      log.info(`previous exit: cause=${notice.cause} sessions=${notice.sessions} ${action}`);
      if (action === 'resume') await resume('auto');
      else offer('');
    })
    .catch((err: unknown) => {
      log.warn(`previous exit: the notice could not be read: ${formatError(err)}`);
    });
}
