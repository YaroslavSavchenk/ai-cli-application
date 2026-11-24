/**
 * The one `Restart` that starts everything again — WSL, the backend and a new
 * window — after the backend went away (Quality Q17 P3,
 * `.claude/plans/quality/PLAN-Q17.md` § P3 item 1). Two buttons press it: the
 * offline panel (`./offline-panel.ts`) and the restart dialog's "did not come
 * back" state (`./update.ts`).
 *
 * WHAT A PRESS DOES, in order:
 *   1. writes the recover flag (`aism.recover` = epoch ms) — the NEW window's
 *      boot reads it and resumes the sessions without asking
 *      (`./previous-exit.ts`);
 *   2. arms the restart gap (`setRestarting(true)`): this window is about to
 *      be replaced, and its polls, reconnect loops and 401 recovery must not
 *      race the new window — a reload here would boot a SECOND page that
 *      reads the same flag;
 *   3. posts `relaunch` to the host (`./host-bridge.ts`).
 * Success is this window closing; nothing answers it. `relaunch-failed`, or
 * no answer within `RELAUNCH_WAIT_MS`, undoes 1 and 2 and calls `onFailed`.
 *
 * Outside the WebView2 host there is no one to ask: `canRelaunch()` is false
 * and neither button is drawn.
 */
import * as st from '../state.ts';
import { log } from '../log.ts';
import { hasHostBridge, onRelaunchFailed, requestRelaunch } from './host-bridge.ts';
import { RECOVER_KEY, RELAUNCH_WAIT_MS } from './previous-exit-model.ts';

let inFlight = false;
/** Who hears the failure: every button pressed while this one press waits. */
let failed: (() => void)[] = [];

/** Is there a host that can start everything again? */
export function canRelaunch(): boolean {
  return hasHostBridge();
}

/** A press is waiting for the window to be replaced. */
export function isRelaunching(): boolean {
  return inFlight;
}

/**
 * Press `Restart`. A second press while one waits posts nothing (the host is
 * single-flight too) but hears the same outcome.
 */
export function startRelaunch(onFailed: () => void): void {
  failed.push(onFailed);
  if (inFlight) return;
  inFlight = true;
  try {
    localStorage.setItem(RECOVER_KEY, String(Date.now()));
  } catch {
    // No storage: the new window offers `Resume N sessions` instead of resuming.
  }
  st.setRestarting(true);
  log.info('relaunch requested');
  let off = (): void => {};
  const timer = window.setTimeout(() => fail('no answer from the window host'), RELAUNCH_WAIT_MS);

  function fail(why: string): void {
    if (!inFlight) return;
    inFlight = false;
    off();
    window.clearTimeout(timer);
    try {
      // A flag left behind would resume the sessions on some later start the
      // user did not ask that of.
      localStorage.removeItem(RECOVER_KEY);
    } catch {
      // Nothing to undo.
    }
    st.setRestarting(false);
    log.warn(`relaunch failed: ${why}`);
    const tell = failed;
    failed = [];
    for (const fn of tell) fn();
  }

  off = onRelaunchFailed(() => fail('the window host could not start it'));
  if (!requestRelaunch()) fail('the message could not be posted');
}
