/**
 * The Claude Code compatibility notice — the DOM half (Nocturne D6,
 * `.claude/plans/nocturne/PLAN-D6.md` § What the user gets). The rules and
 * every sentence are `./claude-notice-model.ts`.
 *
 * WHERE AND HOW IT LOOKS. The update toast's slot and card (`./update.ts`
 * builds the `ut-stack` and hands it here): appended AFTER the update toast,
 * so when both show the update comes first and this notice sits under it. The
 * same `ut-` card, the same one attention mark — the 2px left rule — whose hue
 * says the kind of news: danger for a Claude Code older than the app needs
 * (its launches will fail), attention for one newer than tested (they may
 * work). The card itself is never tinted.
 *
 * WHAT IT OFFERS. ONE action, `Check for updates` — the same check the
 * Settings page runs (`./update-check.ts`, decision 18: no link out) — plus
 * the toast's dismissal pair, × and a quiet `Hide`. Hiding writes the shown
 * version to `UiPrefs.claudeNoticeHidden`, so it holds across a restart and
 * ends when a different version is seen (decision 19). It never blocks a
 * launch: it is a card in a corner, not a gate.
 *
 * `./panes.ts` calls `noteEarlyExit` when a launch dies early; the dependency
 * runs one way, panes -> claude-notice.
 */
import type { UiPrefs } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import { formatError, log } from '../log.ts';
import * as st from '../state.ts';
import { el, button } from './util.ts';
import { NOTICE_HIDE, claudeNotice, clearsHiddenOnEarlyExit, earlyExitIsNew } from './claude-notice-model.ts';
import { CHECK_LABEL } from './update-model.ts';
import { runUpdateCheck, watchCheckButton } from './update-check.ts';

interface NoticeCtl {
  earlyExit(): void;
}

let ctl: NoticeCtl | null = null;

/** When this page loaded: an exit of a session created before it is a replay. */
const PAGE_LOADED_AT = performance.timeOrigin;
/** Sessions whose early exit was already counted, so a re-attach never counts it twice. */
const counted = new Set<string>();

/**
 * A Claude launch died right after it started (`ExitMessage.early`): bring
 * the notice back if the user had hidden it, unless the server says the
 * version is fine. Only a death this page saw happen is new evidence: every
 * attach (a reload, a reconnect) replays the exit of a session that died
 * before, and that is not (decision 19). A no-op before `initClaudeNotice`.
 */
export function noteEarlyExit(sessionId: string, createdAt: string): void {
  if (counted.has(sessionId) || !earlyExitIsNew(Date.parse(createdAt), PAGE_LOADED_AT)) return;
  counted.add(sessionId);
  ctl?.earlyExit();
}

/**
 * Build the notice into the toast stack. `prefs` is the boot bag (its hidden
 * version seeds the dismissal); `refocus` puts the keyboard back on the
 * focused pane once the card it was on goes away.
 */
export function initClaudeNotice(stack: HTMLElement, prefs: UiPrefs | undefined, refocus: () => void): void {
  /** The version the user hid. Owned here; the server keeps the durable copy. */
  let hidden: string | undefined = typeof prefs?.claudeNoticeHidden === 'string' ? prefs.claudeNoticeHidden : undefined;
  /** The version a `shown` log line was written for, so a poll never repeats it. */
  let announced: string | null = null;

  const card = el('div', 'ut-toast');
  card.hidden = true;
  card.setAttribute('role', 'status');
  card.setAttribute('aria-live', 'polite');
  const title = el('span', 'ut-title');
  const x = button('ut-x', '×', () => hide());
  x.setAttribute('aria-label', 'hide');
  const hd = el('div', 'ut-hd');
  hd.append(title, x);
  const body = el('div', 'ut-body');
  // The check's answer, under the sentence it answers; absent until asked.
  const answer = el('div', 'ut-body');
  answer.hidden = true;
  const actions = el('div', 'ut-actions');
  const checkBtn = button('btn-accent', CHECK_LABEL, () => {
    log.info('claude notice: check for updates chosen');
    void runUpdateCheck({
      begin() {
        answer.hidden = true;
        answer.textContent = '';
      },
      answer(text) {
        answer.hidden = false;
        answer.textContent = text;
      },
      // No `applied`: the update toast above repaints itself through
      // applyRuntime() when the check found a newer app.
    });
  });
  watchCheckButton(checkBtn);
  actions.append(button('btn-quiet', NOTICE_HIDE, () => hide()), checkBtn);
  card.append(hd, body, answer, actions);
  stack.append(card);

  function render(): void {
    const n = claudeNotice(st.state.claude, hidden);
    if (n === null) {
      card.hidden = true;
      announced = null;
      return;
    }
    if (announced !== n.version) {
      // A different version is a different notice: the last answer was about
      // the one before it.
      announced = n.version;
      answer.hidden = true;
      answer.textContent = '';
      log.info(`claude notice shown: ${n.kind} ${n.version}`);
    }
    card.className = n.kind === 'older' ? 'ut-toast is-danger' : 'ut-toast';
    // As on the Settings page: only an installed app can be updated by
    // downloading one; a dev clone's check answers 503.
    checkBtn.hidden = !st.state.installed;
    title.textContent = n.title;
    body.textContent = n.body;
    card.hidden = false;
  }

  function hide(): void {
    const n = claudeNotice(st.state.claude, hidden);
    if (n === null) return;
    hidden = n.version;
    log.info(`claude notice hidden: ${n.version}`);
    render();
    refocus();
    api.updatePrefs({ claudeNoticeHidden: n.version }).catch((err: unknown) => {
      // Hidden for this page either way; the next start shows it again.
      log.warn(`claude notice: the hide was not saved: ${formatError(err)}`);
    });
  }

  function earlyExit(): void {
    if (!clearsHiddenOnEarlyExit(st.state.claude, hidden)) return;
    log.info(`claude notice: a launch died early, showing it again (was hidden for ${hidden ?? ''})`);
    hidden = undefined;
    render();
    api.updatePrefs({}, ['claudeNoticeHidden']).catch((err: unknown) => {
      log.warn(`claude notice: the unhide was not saved: ${formatError(err)}`);
    });
  }

  ctl = { earlyExit };
  // setRuntime() notifies `conn` when `claude` changes (state-chrome.ts).
  st.subscribe((kind) => {
    if (kind === 'conn') render();
  });
  render();
}
