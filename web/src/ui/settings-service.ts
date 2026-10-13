/**
 * The Settings panel's Background service page: the version, uptime and
 * Claude Code readouts (D6), `Check for updates` with the answer it earns
 * (Nocturne B6, D4; the check is `./update-check.ts`, shared since D6),
 * and `Restart service` / `Update`, which only open the restart question the
 * update module asks in its own words.
 *
 * Split from `ui/settings.ts` (O8, 2026-09-23), code moved as it stood.
 * Siblings: `settings.ts` (the modal, its nav and the other four pages),
 * `settings-apikeys.ts`, `settings-service.ts`.
 */
import * as st from '../state.ts';
import { el, button } from './util.ts';
import { openRestartConfirm, runtimeFacts } from './update.ts';
import { CHECK_LABEL } from './update-model.ts';
import { runUpdateCheck, watchCheckButton, type CheckHooks } from './update-check.ts';
// theme-model.ts only: the clamp that reads a prefs bag's `theme`. ui/theme.ts
// itself arrives as a dep (see SettingsDeps.theme).

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
  // D6: which Claude Code the sessions launch, against the range this app was
  // tested with. Absent, not blank, while there is nothing honest to say.
  const factClaude = el('span', 'sg-svcclaude');
  factClaude.hidden = true;
  facts.append(factVer, factUp, factClaude);
  // Only an installed app can be updated by downloading one; a developer clone
  // updates with the tools it was cloned with, and asking a release page about
  // it would be a question that does not apply to it.
  const checkBtn = button('sg-link', CHECK_LABEL, () => {
    void runUpdateCheck(checkHooks);
  });
  checkBtn.title = 'asks now whether a newer version exists';
  checkBtn.hidden = true;
  watchCheckButton(checkBtn);
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
    factClaude.textContent = f.claude ?? '';
    factClaude.hidden = f.claude === null;
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

  /**
   * This page's half of the shared check (Nocturne B6, D4; the check itself is
   * `./update-check.ts`, which also paints the button busy): the answer lands
   * under the facts, and the facts repaint once the re-read runtime is applied.
   */
  const checkHooks: CheckHooks = {
    begin: (): void => sayAnswer(null),
    answer: (text: string, canUpdate: boolean): void => sayAnswer(text, canUpdate),
    applied: (): void => renderBackend(),
  };

  return { renderBackend, sayAnswer };
}
