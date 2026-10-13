/**
 * `Check for updates` — the ONE check, for every button that offers it
 * (Nocturne D6: moved out of `./settings-service.ts`, where it was the Settings
 * page's private `runCheck`, so the Claude Code notice can call the same one
 * instead of a copy). The words and the answers are `./update-model.ts`'s;
 * each caller paints its own answer line through `CheckHooks`.
 *
 * At most one check is out at a time, whoever asked: a second press anywhere
 * while one runs is a no-op, never a second question to the release page.
 * Every button that offers it is handed to `watchCheckButton`, so ALL of them
 * say `Checking…` and stop taking clicks while the one check runs.
 */
import * as api from '../api.ts';
import { log } from '../log.ts';
import * as st from '../state.ts';
import { applyRuntime } from './update.ts';
import { CHECK_BUSY, CHECK_FAILED, CHECK_LABEL, checkAnswer } from './update-model.ts';

/** How a caller shows the check it started. */
export interface CheckHooks {
  /** The check went out: the last answer is taken away. */
  begin(): void;
  /** The sentence the check earned (CHECK_FAILED when it did not answer); before the re-read. */
  answer(text: string, canUpdate: boolean): void;
  /** The runtime was re-read and applied after an answered check. */
  applied?(): void;
}

/** True while a check is out. One owner: this module. */
let checking = false;

/** Every button that offers the check (`watchCheckButton`). */
const buttons: HTMLButtonElement[] = [];

/** Paint `btn` from the shared busy state, now and whenever the check starts or ends. */
export function watchCheckButton(btn: HTMLButtonElement): void {
  buttons.push(btn);
  paintButtons();
}

function setChecking(busy: boolean): void {
  checking = busy;
  paintButtons();
}

function paintButtons(): void {
  for (const b of buttons) {
    b.disabled = checking;
    b.textContent = checking ? CHECK_BUSY : CHECK_LABEL;
  }
}

/**
 * Ask the backend to check NOW (Nocturne B6, D4). The answer lands through the
 * hooks, and then the app re-reads the runtime the ONE way it always does, so
 * the pill and the toast learn the same news through the same path.
 */
export async function runUpdateCheck(hooks: CheckHooks): Promise<void> {
  if (checking) return;
  setChecking(true);
  hooks.begin();
  let answered = false;
  try {
    const status = await api.checkForUpdates();
    const a = checkAnswer(status);
    hooks.answer(a.text, a.canUpdate);
    answered = true;
    log.info(`update check: ${status.reason ?? 'up to date'}`);
  } catch {
    hooks.answer(CHECK_FAILED, false);
    log.warn('the update check did not answer');
  } finally {
    setChecking(false);
  }
  if (!answered) return;
  // The pill, the toast and every page read one state; nothing here writes
  // it, and a failed re-read simply leaves the last known runtime.
  try {
    st.setRuntime(await api.getRuntime());
    applyRuntime();
    hooks.applied?.();
  } catch {
    // Nothing to say: the 30 s poll asks again.
  }
}
