/**
 * Update notice + backend restart — the DOM half. The rules live next door and
 * DOM-free: `./update-model.ts` (which surface is shown, and every sentence the
 * confirmation says) and `./restart-flow.ts` (the 202/409/500/timeout handshake
 * and the `/health` wait). This file paints three surfaces and owns the two
 * acts a model cannot perform — `location.reload()` and `location.href`.
 *
 * THE THREE SURFACES, and why they are where they are:
 *
 *   TOAST — bottom-right, above the tab strip. It arrives where nothing else
 *     lives, so it never covers a terminal's active area or the tab a user is
 *     reaching for; the terminal stays the hero. Amber left rule (the app's
 *     existing attention semantics — no new colour), the surface card and the
 *     popover shadow already used by the theme popover. It goes away for good
 *     on `Later`, for THIS reason.
 *
 *   PILL — the topbar, immediately after the connection dot. That cluster is
 *     already where APP-level state lives (connected/offline, GitHub); the tab
 *     strip's right end is drag territory (reorder drops, the ghost `+`) and a
 *     persistent target there would move as tabs are added and compete with a
 *     drop zone. One place, next to the other app-level readout.
 *
 *   CONFIRMATION — the shared dialog chrome (`modal-scrim` / `modal` /
 *     `launch-hd`), because it is a decision with consequences and the app has
 *     exactly one visual grammar for those. Its `Restart` is accent-blue, not
 *     red: red is reserved for the "no prompts" launch mode, and this action is
 *     recoverable — every closed session is in History.
 *
 * Copy rule (2026-07-25): no flags, commands or config names in any string
 * here — the server's `reason` is rendered through `reasonSentence()`, never
 * verbatim; its raw text goes to the client log line only.
 */
import * as api from '../api.ts';
import * as st from '../state.ts';
import { log } from '../log.ts';
import { el, button, trapTab } from './util.ts';
import { commandLabel } from './launch-args.ts';
import { requestTerminalFocus } from './panes.ts';
import {
  CONTINUE_NOTE,
  PILL_TIP_RESTARTING,
  UpdateNotice,
  confirmBody,
  fmtRunningFor,
  moreLabel,
  reasonNote,
  reasonSentence,
  summarizeRunning,
  versionFact,
  type ConfirmSummary,
} from './update-model.ts';
import {
  MSG_OTHER_PORT,
  OTHER_PORT_WAIT_MS,
  canHideRestartDialog,
  loopbackUrl,
  runRestart,
  type RestartPhase,
} from './restart-flow.ts';

/** The exact words of every state this surface can be in. */
const COPY = {
  toastTitle: 'New version available',
  toastBody: 'The app has been updated. Restart to use the new version.',
  toastGo: 'Restart now',
  toastLater: 'Later',
  // The pill's own word comes from the model (`pillLabel`): it changes while a
  // restart runs, and that decision is DOM-free next door.
  pillTip: 'A new version is ready — restart to use it',
  dialogTitle: 'Restart the backend?',
  dialogTitleBusy: 'Restarting the backend',
  dialogTitleOver: 'Restart the backend',
  // A refusal is not a failure and must not be titled like one: nothing was
  // touched, so the title states the fact and the body says why.
  dialogTitleRefused: 'Nothing was restarted',
  dialogSub: 'sessions end · History keeps them',
  cancel: 'Cancel',
  confirm: 'Restart',
  // The preflight runs while every session is still alive and usable, so the
  // dialog is not a cell: this puts it away without stopping anything.
  hide: 'Hide',
  close: 'Close',
  retry: 'Try again',
  // The truth about the first phase since the backend grew a preflight: while
  // the request is out it is checking and building, and has ended nothing yet.
  restarting: 'Preparing the new version…',
  reconnecting: 'Reconnecting…',
} as const;

interface UpdateCtl {
  pill: HTMLElement;
  openConfirm(source: 'settings' | 'pill' | 'toast'): void;
  closeConfirm(): void;
  isConfirmOpen(): boolean;
  applyRuntime(): void;
}

let ctl: UpdateCtl | null = null;

/** Open the confirmation from anywhere (settings panel, pill, toast). */
export function openRestartConfirm(source: 'settings' | 'pill' | 'toast' = 'settings'): void {
  ctl?.openConfirm(source);
}

/**
 * Esc handling in main.ts. During the preflight this HIDES the dialog and lets
 * the restart run on; once the handover has begun it is a no-op.
 */
export function closeRestartConfirm(): void {
  ctl?.closeConfirm();
}

export function isRestartConfirmOpen(): boolean {
  return ctl?.isConfirmOpen() ?? false;
}

/**
 * Re-read `state.update` and repaint the notice. Called after every
 * `/api/runtime` answer (boot + the 30 s poll).
 */
export function applyRuntime(): void {
  ctl?.applyRuntime();
}

export function initUpdate(modalHost: HTMLElement): { pill: HTMLElement } {
  const notice = new UpdateNotice();

  // ---- topbar pill ---------------------------------------------------------
  const pill = button('tb-update', notice.pillLabel, () => {
    // While a restart runs the pill is the ONLY thing on screen saying so, and
    // the dialog it belongs to may be hidden: then a click brings that dialog
    // back instead of asking the question a second time.
    if (notice.pillAction === 'reveal') {
      log.info('update pill clicked: showing the running restart');
      reveal();
      return;
    }
    log.info('update pill clicked');
    openConfirm('pill');
  });
  pill.hidden = true;
  pill.title = COPY.pillTip;
  pill.setAttribute('aria-label', COPY.pillTip);
  pill.setAttribute('aria-haspopup', 'dialog');

  // ---- toast ---------------------------------------------------------------
  const toast = el('div', 'toast');
  toast.hidden = true;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  const toastX = button('toast-x', '×', () => dismissToast());
  toastX.setAttribute('aria-label', 'dismiss');
  const toastHd = el('div', 'toast-hd');
  toastHd.append(el('span', 'toast-title', COPY.toastTitle), el('span', 'launch-gap'), toastX);
  const toastReason = el('div', 'toast-reason');
  const toastActions = el('div', 'toast-actions');
  toastActions.append(
    button('btn', COPY.toastLater, () => dismissToast()),
    button('btn is-acc', COPY.toastGo, () => {
      log.info('update toast: restart chosen');
      openConfirm('toast');
    }),
  );
  toast.append(toastHd, el('div', 'toast-body', COPY.toastBody), toastReason, toastActions);
  modalHost.append(toast);

  // ---- confirmation dialog -------------------------------------------------
  // Plain `modal-scrim`, NOT the launch dialog's blurred variant: this dialog
  // can open on top of the settings panel, and two blurred scrims stacked read
  // as a smeared mistake rather than as depth.
  const scrim = el('div', 'modal-scrim restart-scrim');
  scrim.hidden = true;
  const modal = el('div', 'modal restart-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'restart the backend');

  const hd = el('header', 'launch-hd');
  const tile = el('div', 'launch-tile');
  tile.setAttribute('aria-hidden', 'true');
  tile.append(el('span', 'logo-glyph', '>_'));
  const titles = el('div', 'launch-titles');
  const titleEl = el('div', 'launch-title', COPY.dialogTitle);
  const subEl = el('div', 'launch-sub', COPY.dialogSub);
  titles.append(titleEl, subEl);
  const hdX = button('launch-x', '×', () => closeConfirm());
  hdX.setAttribute('aria-label', 'cancel');
  hd.append(tile, titles, el('span', 'launch-gap'), hdX);

  const body = el('div', 'restart-body');
  const bodyText = el('p', 'restart-lead');
  const list = el('ul', 'restart-list');
  const moreEl = el('div', 'restart-more');
  const contNote = el('div', 'restart-note');
  contNote.setAttribute('role', 'note');
  // Same note idiom, different job: this one warns about the refusal the
  // pending reason is going to produce (dependencies), so it is rendered above
  // the buttons the user is about to press.
  const depsNote = el('div', 'restart-note');
  depsNote.setAttribute('role', 'note');
  const progress = el('div', 'restart-progress');
  progress.hidden = true;
  const spinner = el('span', 'restart-spin');
  spinner.setAttribute('aria-hidden', 'true');
  const progressText = el('span', 'restart-progress-lb');
  // Focusable by script only. The busy phase hides cancel/confirm/×, so without
  // this the modal holds nothing focusable: focus would fall back to <body>
  // BEHIND an aria-modal scrim, where Tab walks the page the dialog is blocking
  // and a screen reader reads nothing at all.
  progressText.tabIndex = -1;
  progress.append(spinner, progressText);
  const failure = el('div', 'restart-fail');
  failure.hidden = true;
  failure.setAttribute('role', 'alert');
  body.append(bodyText, list, moreEl, contNote, depsNote, progress, failure);

  const ft = el('footer', 'modal-ft restart-ft');
  const cancelBtn = button('btn', COPY.cancel, () => closeConfirm());
  const confirmBtn = button('btn is-acc', COPY.confirm, () => {
    void startRestart();
  });
  const closeBtn = button('btn', COPY.close, () => closeConfirm());
  closeBtn.hidden = true;
  // Only while the PREFLIGHT is out: it dismisses the dialog, never the flow.
  const hideBtn = button('btn', COPY.hide, () => closeConfirm());
  hideBtn.hidden = true;
  // Only on the REFUSED phase: after a refusal the backend is still there, so
  // trying again once the cause is fixed is a real action — unlike after a
  // failure, where there is nothing left on this origin to ask.
  const retryBtn = button('btn is-acc', COPY.retry, () => {
    void startRestart();
  });
  retryBtn.hidden = true;
  ft.append(cancelBtn, el('span', 'drawer-gap'), hideBtn, closeBtn, retryBtn, confirmBtn);

  modal.append(hd, body, ft);
  scrim.append(modal);
  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) closeConfirm();
  });
  trapTab(modal);
  modalHost.append(scrim);

  // ---- state ---------------------------------------------------------------
  /**
   * `confirm` = the question; `busy` = in flight; `refused` = the preflight said
   * no and NOTHING happened (recoverable, retryable); `over` = a terminal
   * message (the old process is gone).
   */
  type Phase = 'confirm' | 'busy' | 'refused' | 'over';
  let phase: Phase = 'confirm';
  let restoreTo: HTMLElement | null = null;
  let summary: ConfirmSummary = { count: 0, rows: [], more: 0, continued: false };
  /** The pending reason's footnote, or null — recomputed on every render. */
  let depsWarn: string | null = null;
  /** Which half of the flow is out, while one is. Decides whether Hide is offered. */
  let flowPhase: RestartPhase | null = null;
  /**
   * The user put the dialog away during the preflight. The flow kept running,
   * so the outcome has to bring the dialog back — that is what this remembers.
   */
  let hiddenMidFlow = false;

  // ---- notice surfaces -----------------------------------------------------

  function renderNotice(): void {
    pill.hidden = !notice.pillVisible;
    toast.hidden = !notice.toastVisible;
    // The user reads a sentence; the raw reason (hashes, file words) stays in
    // the log. Both surfaces say the same thing — one mapping, one truth.
    const sentence = reasonSentence(notice.reason);
    const detail = sentence === null ? '' : ` — ${sentence}`;
    pill.textContent = notice.pillLabel;
    const tip = notice.pillAction === 'reveal' ? PILL_TIP_RESTARTING : `${COPY.pillTip}${detail}`;
    pill.title = tip;
    pill.setAttribute('aria-label', tip);
    toastReason.textContent = sentence ?? '';
    toastReason.hidden = sentence === null;
  }

  /** Toast arrival is announced once per reason, never once per poll. */
  let announced: string | null = null;

  function applyRuntimeInner(): void {
    const before = notice.state;
    notice.apply(st.state.update);
    if (notice.state === 'toast' && before !== 'toast') {
      const reason = notice.reason ?? '';
      if (announced !== reason) {
        announced = reason;
        log.info(`update notice shown${reason === '' ? '' : `: ${reason}`}`);
      }
    }
    if (notice.state === 'hidden') announced = null;
    renderNotice();
  }

  function dismissToast(): void {
    const reason = notice.reason ?? '';
    notice.dismissToast();
    log.info(`update notice dismissed${reason === '' ? '' : `: ${reason}`}`);
    renderNotice();
    pill.focus();
  }

  // ---- confirmation --------------------------------------------------------

  /**
   * A session's display name. A session launched without a title carries the
   * raw command as its title (server/sessions.ts), and a command name is not
   * UI copy — the drawer's `commandLabel` is reused for exactly that case.
   */
  function nameOf(s: { title: string; command: string }): string {
    return s.title === s.command ? commandLabel(s.command) : s.title;
  }

  function renderConfirm(): void {
    summary = summarizeRunning(
      st.state.sessions.values(),
      nameOf,
      (s) => st.projectName(s.projectId),
    );
    bodyText.textContent = confirmBody(summary.count);
    list.replaceChildren(
      ...summary.rows.map((r) => {
        const li = el('li', 'restart-row');
        li.append(el('span', 'restart-row-name', r.name));
        if (r.project !== null) {
          li.append(el('span', 'restart-row-sep', '·'), el('span', 'restart-row-proj', r.project));
        }
        return li;
      }),
    );
    list.hidden = summary.rows.length === 0;
    moreEl.textContent = moreLabel(summary.more);
    moreEl.hidden = summary.more === 0;
    contNote.textContent = CONTINUE_NOTE;
    contNote.hidden = !summary.continued;
    // The pending reason may be one the preflight is going to refuse; say so
    // while Restart is still unpressed.
    const note = reasonNote(notice.reason);
    depsWarn = note;
    depsNote.textContent = note ?? '';
    setPhase('confirm');
  }

  function setPhase(next: Phase): void {
    phase = next;
    const confirming = next === 'confirm';
    // `over` and `refused` share the message slot; only their colour, their
    // title and their buttons differ — the difference between "this page is
    // finished" and "nothing happened, fix it and press again".
    const ended = next === 'over' || next === 'refused';
    bodyText.hidden = !confirming;
    list.hidden = !confirming || summary.rows.length === 0;
    moreEl.hidden = !confirming || summary.more === 0;
    contNote.hidden = !confirming || !summary.continued;
    depsNote.hidden = !confirming || depsWarn === null;
    progress.hidden = next !== 'busy';
    failure.hidden = !ended;
    failure.className = next === 'refused' ? 'restart-fail is-refused' : 'restart-fail';
    // The preflight is interruptible-looking but not interruptible: the dialog
    // can go away, the flow cannot. `reconnecting` stays locked — by then the
    // old process is gone and there is nothing behind the dialog to go back to.
    const hidable = next === 'busy' && flowPhase !== null && canHideRestartDialog(flowPhase);
    cancelBtn.hidden = !confirming;
    confirmBtn.hidden = !confirming;
    closeBtn.hidden = !ended;
    retryBtn.hidden = next !== 'refused';
    hideBtn.hidden = !hidable;
    hdX.hidden = next === 'busy' && !hidable;
    hdX.setAttribute('aria-label', hidable ? 'hide' : 'cancel');
    titleEl.textContent =
      next === 'confirm'
        ? COPY.dialogTitle
        : next === 'busy'
          ? COPY.dialogTitleBusy
          : next === 'refused'
            ? COPY.dialogTitleRefused
            : COPY.dialogTitleOver;
    subEl.hidden = !confirming;
    // Keep focus inside the dialog across the phase change that removes every
    // button (the failure phase does the same with closeBtn).
    if (next === 'busy') progressText.focus();
  }

  function openConfirm(source: 'settings' | 'pill' | 'toast'): void {
    if (!scrim.hidden) return;
    // A flow is still running behind a hidden dialog: show it again instead of
    // renderConfirm()'s reset, which would ask the question a second time while
    // the answer to the first one is still on its way.
    if (phase === 'busy') {
      reveal();
      return;
    }
    restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    failure.textContent = '';
    renderConfirm();
    scrim.hidden = false;
    log.info(`restart confirm opened from ${source}: sessions=${summary.count}`);
    confirmBtn.focus();
  }

  function closeConfirm(): void {
    if (scrim.hidden) return;
    if (phase === 'busy') {
      // During the PREFLIGHT this is a Hide, not a Cancel: the POST stays out,
      // the restart gap stays armed, and the outcome re-opens the dialog. Once
      // the handover has begun there is nothing left to go back to.
      if (flowPhase === null || !canHideRestartDialog(flowPhase)) return;
      hiddenMidFlow = true;
      log.info('restart dialog hidden while the backend prepares; the restart keeps running');
      scrim.hidden = true;
      restoreFocus();
      return; // restoreTo is kept: the dialog is coming back.
    }
    if (phase === 'confirm') log.info('restart confirm cancelled');
    scrim.hidden = true;
    restoreFocus();
    restoreTo = null;
  }

  /**
   * Put the keyboard back where it came from — and NOT on an element that is
   * gone from the screen. `Hide` during the preflight is exactly that case: the
   * dialog was opened from the toast or the settings panel, and by then those
   * are hidden, so `focus()` would land on <body> and no key would reach the
   * PTY. Same fallback as the launch dialog: the focused pane's terminal.
   */
  function restoreFocus(): void {
    const back = restoreTo;
    if (
      back !== null &&
      back.isConnected &&
      !back.hidden &&
      back.closest('[hidden]') === null &&
      back.offsetParent !== null
    ) {
      back.focus();
      return;
    }
    requestTerminalFocus();
  }

  /** Put a hidden-mid-flow dialog back on screen. A no-op when it never left. */
  function reveal(): void {
    if (!scrim.hidden) return;
    hiddenMidFlow = false;
    scrim.hidden = false;
  }

  function showProgress(p: RestartPhase): void {
    flowPhase = p;
    progressText.textContent = p === 'restarting' ? COPY.restarting : COPY.reconnecting;
    // `reconnecting` is the moment the old process actually left: a dialog the
    // user hid during the preflight comes back, because from here the page is
    // committed and the sessions behind it are already gone.
    if (hiddenMidFlow && !canHideRestartDialog(p)) reveal();
    setPhase('busy');
  }

  /**
   * A terminal message, and the end of the restart gap. The flag is dropped
   * here on purpose: with the handover over (one way or another) the app must
   * be allowed to tell the truth again — the poll flips the topbar dot to
   * offline when the backend really is gone, instead of the window sitting
   * frozen behind a dialog that says nothing more.
   */
  function showFailure(message: string): void {
    st.setRestarting(false);
    reveal(); // The outcome always gets a screen, hidden preflight or not.
    flowPhase = null;
    failure.textContent = message;
    setPhase('over');
    closeBtn.focus();
  }

  /**
   * The preflight refused (422). The OLD backend never moved: it is still
   * serving this page, its token is still ours, and every session is still
   * running. Dropping the flag here is what puts the app back to work — the
   * session poll, the runtime poll and both reconnect loops resume within a
   * beat — and the message is the server's own sentence about which check said
   * no, because only the server knows.
   */
  function showRefused(message: string): void {
    st.setRestarting(false);
    reveal(); // Nothing happened, and the user has to be told so.
    flowPhase = null;
    failure.textContent = message;
    setPhase('refused');
    closeBtn.focus();
  }

  async function startRestart(): Promise<void> {
    log.info(`restart confirmed: sessions=${summary.count}`);
    failure.textContent = ''; // A retry must not show the previous refusal.
    // BEFORE the POST: the old process starts killing sessions the moment it
    // reads the request, so every "the backend vanished" reflex has to be
    // asleep already.
    notice.startRestart();
    st.setRestarting(true);
    renderNotice();
    showProgress('restarting');

    const outcome = await runRestart({
      postRestart: () => api.restartBackend(),
      health: () => api.backendHealth(),
      now: () => Date.now(),
      sleep: (ms) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)),
      onPhase: showProgress,
    });

    if (outcome.kind === 'reload') {
      log.info(`restart: backend answered after ${outcome.afterMs}ms — reloading`);
      notice.finishRestart();
      location.reload();
      return;
    }
    if (outcome.kind === 'busy') {
      // The backend is alive and busy with someone else's restart: put the
      // page back exactly as it was.
      log.warn('restart refused: one is already in progress');
      notice.restartAborted();
      renderNotice();
      showFailure(outcome.message);
      return;
    }
    if (outcome.kind === 'refused') {
      // NOT a failure: the backend checked, said no, and touched nothing.
      log.warn(`restart refused by the backend: ${outcome.message}`);
      notice.restartAborted();
      renderNotice();
      showRefused(outcome.message);
      return;
    }
    if (outcome.kind === 'otherPort') {
      // The old process is gone either way, so `restarting` stays armed until
      // the navigation attempt has had its two seconds: a 401 in that window
      // would replace an honest progress state with a panic panel.
      log.warn(`restart landed on a different address: port=${outcome.port}`);
      showProgress('reconnecting');
      const target = loopbackUrl(outcome.port);
      const origin = location.origin;
      try {
        location.href = target;
      } catch {
        // A host window locked to its launch origin refuses; the wait below
        // turns that refusal into the honest message.
      }
      window.setTimeout(() => {
        if (location.origin === origin) {
          log.warn('restart: this window cannot follow the new address');
          showFailure(MSG_OTHER_PORT);
        }
      }, OTHER_PORT_WAIT_MS);
      return;
    }
    log.error(`restart failed: ${outcome.message}`);
    showFailure(outcome.message);
  }

  ctl = {
    pill,
    openConfirm,
    closeConfirm,
    isConfirmOpen: () => !scrim.hidden,
    applyRuntime: applyRuntimeInner,
  };

  // Keep the confirmation's session list honest while it is open: the 3 s poll
  // keeps running right up to the moment the user commits.
  st.subscribe((kind) => {
    if (kind === 'sessions' && !scrim.hidden && phase === 'confirm') renderConfirm();
  });

  applyRuntimeInner();
  return { pill };
}

/**
 * The settings panel's two readouts, in one place so the panel does not have to
 * know how a missing value is written. `running for 3 h 41 min` · `version a1b2c3d`.
 *
 * The version fact answers "which app is running", and that has two honest
 * forms: an INSTALLED backend knows its bundle version (`v0.2.0`) and says so;
 * a developer clone has no version at all and identifies itself by the commit
 * it was started from. The commit is the fallback, never a second line — one
 * fact, one slot — and the empty glyph when neither is known.
 */
export function runtimeFacts(now: number = Date.now()): { runningFor: string; version: string } {
  return {
    runningFor: fmtRunningFor(st.state.serverStartedAt, now),
    version: versionFact(st.state.version, st.state.serverCommit),
  };
}
