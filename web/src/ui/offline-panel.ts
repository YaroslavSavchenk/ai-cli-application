/**
 * The offline panel — what the window says when the backend has been
 * unreachable for `OFFLINE_PANEL_MS` (Quality Q17 P3,
 * `.claude/plans/quality/PLAN-Q17.md` § P3 item 1). Until Q17 the topbar's
 * `Offline` readout was the only sign, and after WSL ran out of memory
 * (2026-11-24) nothing said what had happened or what to do.
 *
 * WHAT COUNTS AS UNREACHABLE. The 3 s session poll (`main-shell.ts`) is the
 * probe: `fail()` on every failed poll, `ok()` on every answer — and a
 * presence pong that flips `backendReachable` back counts as an answer too.
 * The clock starts at the FIRST failure of a streak, so the panel lands ten
 * seconds after the backend stopped answering, not ten after the topbar dot
 * turned red.
 *
 * WHEN IT STAYS AWAY. During the app's own restart or update the backend is
 * supposed to vanish (`state.restarting`; a streak that began before it is
 * forgotten), while the 401 takeover owns the page, and while the restart
 * dialog is open — its "did not come back" state carries the same `Restart`.
 * The caller says the last two through `blocked`.
 *
 * HOW IT LOOKS (`/frontend-designer`): the restart dialog's own card (`rs-`)
 * on its scrim, because it is the same kind of moment, with the boot error's
 * ONE alarm mark — the 2px danger top edge (`.op-modal`). No new colour, no
 * glyph. It goes away by itself when the backend answers again.
 */
import * as st from '../state.ts';
import { log } from '../log.ts';
import { el, button, restoreFocus, trapTab } from './util.ts';
import {
  OFFLINE_PANEL_MS,
  PANEL_LINE,
  PANEL_TITLE,
  RELAUNCH_FAILED,
  RESTARTING_LABEL,
  RESTART_LABEL,
  SHORTCUT_ADVICE,
  offlinePanelDue,
} from './previous-exit-model.ts';
import { canRelaunch, isRelaunching, startRelaunch } from './relaunch.ts';

interface OfflinePanelDeps {
  /** The 401 takeover owns the page, or the restart dialog is open. */
  blocked(): boolean;
  now(): number;
}

interface OfflinePanel {
  /** A poll failed. */
  fail(): void;
  /** A poll answered. */
  ok(): void;
}

export function initOfflinePanel(host: HTMLElement, deps: OfflinePanelDeps): OfflinePanel {
  const scrim = el('div', 'modal-scrim rs-scrim');
  scrim.hidden = true;
  const modal = el('div', 'rs-modal op-modal');
  modal.setAttribute('role', 'alertdialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', PANEL_TITLE);
  const hd = el('header', 'rs-hd');
  const titles = el('div', 'rs-titles');
  titles.append(el('div', 'rs-title', PANEL_TITLE), el('div', 'rs-sub', PANEL_LINE));
  hd.append(titles);
  const body = el('div', 'rs-body');
  const progress = el('div', 'rs-progress');
  progress.setAttribute('aria-live', 'polite');
  const spinner = el('span', 'rs-spin');
  spinner.setAttribute('aria-hidden', 'true');
  const progressText = el('span', 'rs-step', RESTARTING_LABEL);
  // Focusable by script only: while it waits the card holds no button, and
  // the keyboard must stay inside the card rather than fall to <body>.
  progressText.tabIndex = -1;
  progress.append(spinner, progressText);
  const failure = el('div', 'rs-fail', RELAUNCH_FAILED);
  failure.setAttribute('role', 'alert');
  const advice = el('p', 'rs-lead', SHORTCUT_ADVICE);
  // Outside the host the advice is the whole answer and the card has no
  // button: the keyboard lands here, never back in a dead terminal.
  advice.tabIndex = -1;
  body.append(progress, failure, advice);
  const ft = el('footer', 'rs-ft');
  const restartBtn = button('btn-accent', RESTART_LABEL, () => {
    log.info('offline panel: restart chosen');
    paint('waiting');
    startRelaunch(() => paint('failed'));
  });
  ft.append(el('span', 'rs-gap'), restartBtn);
  modal.append(hd, body, ft);
  scrim.append(modal);
  trapTab(modal);
  host.append(scrim);

  let downSince: number | null = null;
  let timer: number | null = null;
  let restoreTo: HTMLElement | null = null;

  /** `idle` the question, `waiting` Restarting…, `failed` the error and the advice. */
  function paint(phase: 'idle' | 'waiting' | 'failed'): void {
    const hosted = canRelaunch();
    progress.hidden = phase !== 'waiting';
    failure.hidden = phase !== 'failed';
    // Outside the host the advice IS the answer; inside it, it is the way
    // out once the button did not work.
    advice.hidden = hosted && phase !== 'failed';
    ft.hidden = !hosted || phase === 'waiting';
    if (phase === 'waiting') progressText.focus();
    else if (hosted) restartBtn.focus();
    else advice.focus();
  }

  function blocked(): boolean {
    // Our own relaunch arms the restart gap too; that one is not a reason to
    // take the panel away — it is the panel's own `Restarting…`.
    return (st.state.restarting && !isRelaunching()) || deps.blocked();
  }

  function show(): void {
    if (!scrim.hidden) return;
    log.info(`offline panel shown: unreachable for ${OFFLINE_PANEL_MS / 1000} s`);
    restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    scrim.hidden = false;
    // The restart dialog may have pressed `Restart` already and been closed.
    if (isRelaunching()) {
      paint('waiting');
      startRelaunch(() => paint('failed'));
    } else {
      paint('idle');
    }
  }

  function hide(): void {
    if (scrim.hidden || isRelaunching()) return;
    log.info('offline panel hidden: the backend answers again');
    scrim.hidden = true;
    restoreFocus(restoreTo);
    restoreTo = null;
  }

  function check(): void {
    if (offlinePanelDue(downSince, deps.now(), blocked())) show();
  }

  function forget(): void {
    downSince = null;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }

  // The app's own restart: a streak that began before it is not this one.
  st.subscribe((kind) => {
    if (kind !== 'conn') return;
    if (st.state.restarting && !isRelaunching()) forget();
    else if (st.state.backendReachable && downSince !== null && !scrim.hidden) {
      forget();
      hide();
    }
  });

  return {
    fail(): void {
      const now = deps.now();
      if (downSince === null) downSince = now;
      check();
      if (scrim.hidden && timer === null) {
        timer = window.setTimeout(
          () => {
            timer = null;
            check();
          },
          Math.max(0, OFFLINE_PANEL_MS - (now - downSince)),
        );
      }
    },
    ok(): void {
      forget();
      hide();
    },
  };
}
