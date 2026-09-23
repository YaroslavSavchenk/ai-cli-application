/**
 * The Settings panel's Background service page: the version and uptime
 * readouts, `Check for updates` with the answer it earns (Nocturne B6, D4),
 * and `Restart service` / `Update`, which only open the restart question the
 * update module asks in its own words.
 *
 * Split from `ui/settings.ts` (O8, 2026-09-23), code moved as it stood.
 * Siblings: `settings.ts` (the modal, its nav and the other four pages),
 * `settings-apikeys.ts`, `settings-service.ts`.
 */
import type { UpdateStatus } from '../../../shared/protocol.ts';
import { UPDATE_NEW_VERSION_AVAILABLE } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import { log } from '../log.ts';
import * as st from '../state.ts';
import { el, button } from './util.ts';
import { applyRuntime, openRestartConfirm, runtimeFacts } from './update.ts';
import { releaseSentence } from './update-model.ts';
// theme-model.ts only: the clamp that reads a prefs bag's `theme`. ui/theme.ts
// itself arrives as a dep (see SettingsDeps.theme).

/**
 * The Background service page's own words (D4). The check asks the backend,
 * which asks the release page; the four outcomes are these, and the version in
 * the second one is the only string here that came from outside the app — it
 * passes `releaseSentence`'s shape gate before it is ever printed.
 */
const CHECK_LABEL = 'Check for updates';
const CHECK_BUSY = 'Checking…';
const CHECK_NEWEST = 'You have the newest version.';
const CHECK_INSTALLED = 'A new version is installed. Restart the service to use it.';
const CHECK_FAILED = 'Could not check for updates.';

/** What `initSettings()` reaches on the service page. */
export interface ServicePart {
  renderBackend(): void;
  sayAnswer(text: string | null, canUpdate?: boolean): void;
}

/**
 * Build the page through the panel's own `newPage`, at the spot in the nav's
 * order where `initSettings()` used to build it inline.
 */
export function createServicePage(
  newPage: (id: 'service', title: string, lead: string) => HTMLElement,
): ServicePart {
  // ======================================================================
  // Background service — the program that runs the sessions, and the one
  // button that replaces it with the version currently on disk (2026-09-06,
  // user's request). Two readouts and an action: no dashboard, no graphs. An
  // INSTALLED app gets a second, quieter verb between them (2026-09-08): where
  // to go and get a newer version. Text link, not a second button — the weight
  // ordering says which one is the act with consequences.
  // ======================================================================
  const servicePage = newPage(
    'service',
    'Background service',
    'Your sessions run in a service that keeps going while this window is open. Restarting it picks up a new version of the app. Every running session closes, but stays in history.',
  );
  const card = el('div', 'sg-svc');
  const facts = el('div', 'sg-svcfacts');
  const factVer = el('span', 'sg-svcver');
  const factUp = el('span', 'sg-svcup');
  facts.append(factVer, factUp);
  // Only an installed app can be updated by downloading one; a developer clone
  // updates with the tools it was cloned with, and asking a release page about
  // it would be a question that does not apply to it.
  const checkBtn = button('sg-link', CHECK_LABEL, () => {
    void runCheck();
  });
  checkBtn.title = 'asks now whether a newer version exists';
  checkBtn.hidden = true;
  const restartBtn = button('sg-outbtn', 'Restart service', () => openRestartConfirm('settings'));
  restartBtn.setAttribute('aria-haspopup', 'dialog');
  card.append(facts, checkBtn, restartBtn);
  servicePage.append(card);

  // The answer to the check, under the facts it is about: one sentence, and —
  // when a release is waiting online — the same act the toast offers.
  const answer = el('div', 'sg-svcanswer');
  answer.hidden = true;
  answer.setAttribute('role', 'status');
  const answerText = el('span', 'sg-svcmsg', '');
  // The `Update` flow is the toast's and the pill's: this button only opens the
  // question, which the update module then asks in its own words.
  const updateBtn = button('sg-outbtn', 'Update', () => openRestartConfirm('settings-update'));
  updateBtn.setAttribute('aria-haspopup', 'dialog');
  updateBtn.hidden = true;
  answer.append(answerText, updateBtn);
  servicePage.append(answer);

  /**
   * The two readouts, refreshed on open and on every conn change (the runtime
   * poll writes both). `Running for` is a coarse duration on purpose: this line
   * is read once, not watched — the statusline already ticks a live clock.
   */
  function renderBackend(): void {
    const f = runtimeFacts();
    factVer.textContent = `Version ${f.version}`;
    factUp.textContent = `Running for ${f.runningFor}`;
    checkBtn.hidden = !st.state.installed;
  }

  /** Put an answer on the page, or take the line away again (null). */
  function sayAnswer(text: string | null, canUpdate = false): void {
    // Reveal BEFORE the text: a `role="status"` node filled while it is
    // hidden is a change no screen reader announces.
    answer.hidden = text === null;
    answerText.textContent = text ?? '';
    updateBtn.hidden = !canUpdate;
  }

  /** Which of the four sentences an answered check earns (D4). */
  function checkAnswer(status: UpdateStatus): { text: string; canUpdate: boolean } {
    if (!status.available) return { text: CHECK_NEWEST, canUpdate: false };
    // ONLINE: the release exists but is not on this machine, so the act is to
    // fetch it, and the sentence names the version the backend read — through
    // the model's own shape gate, the one place a remote tag is made printable.
    if (status.reason === UPDATE_NEW_VERSION_AVAILABLE) {
      return { text: releaseSentence(status.release), canUpdate: true };
    }
    // Anything else an installed backend can report means the newer version is
    // already here and only the running process is old.
    return { text: CHECK_INSTALLED, canUpdate: false };
  }

  /** True while a check is out — the button is the only way in, and it waits. */
  let checking = false;

  /**
   * Ask the backend to check NOW (Nocturne B6, D4). The button states that it
   * is working and stops taking clicks; the answer lands on the page, and then
   * the app re-reads the runtime the ONE way it always does, so the pill and
   * the toast learn the same news through the same path.
   */
  async function runCheck(): Promise<void> {
    if (checking) return;
    checking = true;
    checkBtn.disabled = true;
    checkBtn.textContent = CHECK_BUSY;
    sayAnswer(null);
    let answered = false;
    try {
      const status = await api.checkForUpdates();
      const a = checkAnswer(status);
      sayAnswer(a.text, a.canUpdate);
      answered = true;
      log.info(`update check: ${status.reason ?? 'up to date'}`);
    } catch {
      sayAnswer(CHECK_FAILED);
      log.warn('the update check did not answer');
    } finally {
      checking = false;
      checkBtn.disabled = false;
      checkBtn.textContent = CHECK_LABEL;
    }
    if (!answered) return;
    // The pill, the toast and this page all read one state; nothing here
    // writes it, and a failed re-read simply leaves the last known runtime.
    try {
      st.setRuntime(await api.getRuntime());
      applyRuntime();
      renderBackend();
    } catch {
      // Nothing to say: the 30 s poll asks again.
    }
  }

  return { renderBackend, sayAnswer };
}
