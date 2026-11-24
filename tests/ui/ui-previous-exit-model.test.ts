/**
 * Quality Q17 P3 — the pure rules of "when WSL went down" in the browser
 * (`web/src/ui/previous-exit-model.ts`; `.claude/plans/quality/PLAN-Q17.md`
 * § P3, § Test gate P3): the recover flag's age, the boot's resume-or-offer
 * choice, the offline panel's timing, every sentence by cause (byte-exact,
 * the spec's copy), the size rule, and the two `/api/previous-exit` answers
 * read strictly.
 *
 * Pure: the model is imported and called with fixed clocks. Local times are
 * built with the LOCAL `Date` constructor, so `HH:mm` is right in any time
 * zone the runner has (the CI runner is UTC).
 *
 * NOT claimed: that the DOM shows these strings (`ui-previous-exit.test.ts`,
 * `ui-offline-panel.test.ts`); that the server's verdict is right
 * (`tests/server/previous-exit-model.test.ts`); a real browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PreviousExitNotice } from '../../shared/protocol.ts';
import {
  OFFLINE_PANEL_MS,
  RECOVER_MAX_AGE_MS,
  bootAction,
  causeSentence,
  clockTime,
  failedLine,
  offlinePanelDue,
  parseNotice,
  parseResumeAnswer,
  recoverFlagFresh,
  resumeLabel,
  resumedTitle,
  rssText,
  stoppedTitle,
} from '../../web/src/ui/previous-exit-model.ts';

/** 12:53 on the runner's own clock, as ISO. */
const AT = new Date(2026, 10, 24, 12, 53, 30).toISOString();
const NOW = 1_800_000_000_000;

function notice(over: Partial<PreviousExitNotice> = {}): PreviousExitNotice {
  return { at: AT, cause: 'wsl-stopped', detail: null, sessions: 3, ...over };
}

// ---------------------------------------------------------------------------
// The recover flag
// ---------------------------------------------------------------------------

test('a flag pressed under ten minutes ago is fresh; at ten minutes it is not', () => {
  assert.equal(recoverFlagFresh(String(NOW), NOW), true, 'pressed this very moment');
  assert.equal(recoverFlagFresh(String(NOW - RECOVER_MAX_AGE_MS + 1), NOW), true, 'one ms inside');
  assert.equal(recoverFlagFresh(String(NOW - RECOVER_MAX_AGE_MS), NOW), false, 'exactly ten minutes');
  assert.equal(recoverFlagFresh(String(NOW - 60 * 60 * 1000), NOW), false, 'an hour old');
});

test('anything but a whole past epoch-ms number is not a flag', () => {
  for (const raw of [null, '', 'yes', '1.5e12', '-5', ' 1800000000000', '1800000000000x', '12345678901234567890']) {
    assert.equal(recoverFlagFresh(raw, NOW), false, `raw=${String(raw)}`);
  }
  assert.equal(recoverFlagFresh(String(NOW + 1000), NOW), false, 'a press in the future did not happen');
});

test('the boot resumes at once only with a fresh flag and something to resume', () => {
  assert.equal(bootAction(notice(), true), 'resume');
  assert.equal(bootAction(notice(), false), 'offer', 'a start from the shortcut asks');
  assert.equal(bootAction(notice({ sessions: 0 }), true), 'offer', 'nothing to resume still says what happened');
});

// ---------------------------------------------------------------------------
// The offline panel's timing
// ---------------------------------------------------------------------------

test('the panel is due ten seconds after the first failure, not before', () => {
  assert.equal(offlinePanelDue(NOW, NOW + OFFLINE_PANEL_MS - 1, false), false);
  assert.equal(offlinePanelDue(NOW, NOW + OFFLINE_PANEL_MS, false), true);
  assert.equal(offlinePanelDue(null, NOW + 60_000, false), false, 'no streak, no panel');
});

test('the app’s own restart or another owner of the screen keeps the panel away', () => {
  assert.equal(offlinePanelDue(NOW, NOW + 60_000, true), false);
});

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

test('the time is the local HH:mm, zero-padded; a bad time is empty', () => {
  assert.equal(clockTime(AT), '12:53');
  assert.equal(clockTime(new Date(2026, 0, 2, 7, 5).toISOString()), '07:05');
  assert.equal(clockTime('not a time'), '');
});

test('the size is MiB shown the Explorer way: one decimal under ten, whole above', () => {
  assert.equal(rssText(2731), '2.7 GB', 'the 2026-11-24 python');
  assert.equal(rssText(812), '812 MB');
  assert.equal(rssText(14746), '14 GB');
  assert.equal(rssText(1023.9), '1 GB', 'rounds up into the next unit, never 1024 MB');
});

test('every cause has the spec’s sentence, byte-exact', () => {
  const cases: [PreviousExitNotice, string][] = [
    [
      notice({ cause: 'oom', detail: { process: 'python', rssMb: 2731 } }),
      'WSL ran out of memory at 12:53 — python (2.7 GB) was stopped, and WSL shut down.',
    ],
    [notice({ cause: 'oom' }), 'WSL ran out of memory at 12:53 and shut down.'],
    [notice({ cause: 'wsl-stopped' }), 'WSL shut down at 12:53.'],
    [notice({ cause: 'stopped' }), 'The app was stopped at 12:53.'],
    [notice({ cause: 'crash' }), 'The app stopped unexpectedly at 12:53.'],
  ];
  for (const [n, want] of cases) assert.equal(causeSentence(n), want, `${n.cause} detail=${n.detail !== null}`);
});

test('a time that does not parse leaves the clause out rather than print an empty one', () => {
  assert.equal(causeSentence(notice({ at: 'garbage' })), 'WSL shut down.');
});

test('titles and labels are pluralised', () => {
  assert.equal(stoppedTitle(1), '1 session stopped');
  assert.equal(stoppedTitle(3), '3 sessions stopped');
  assert.equal(stoppedTitle(0), 'The app stopped');
  assert.equal(resumeLabel(1), 'Resume 1 session');
  assert.equal(resumeLabel(3), 'Resume 3 sessions');
  assert.equal(resumedTitle(1), '1 session resumed');
  assert.equal(resumedTitle(3), '3 sessions resumed');
  assert.equal(failedLine(0), '', 'nothing failed, no line');
  assert.equal(failedLine(1), '1 could not be resumed');
  assert.equal(failedLine(2), '2 could not be resumed');
});

// ---------------------------------------------------------------------------
// The answers, read strictly
// ---------------------------------------------------------------------------

test('a contract notice reads back whole', () => {
  const body = { at: AT, cause: 'oom', detail: { process: 'python3.12', rssMb: 2731 }, sessions: 2 };
  assert.deepEqual(parseNotice(body), body);
});

test('a 204 (null) or a body off the contract is no notice', () => {
  const bad: unknown[] = [
    null,
    [],
    'oom',
    { at: AT, cause: 'reboot', detail: null, sessions: 1 },
    { at: 'yesterday', cause: 'oom', detail: null, sessions: 1 },
    { at: AT, cause: 'oom', detail: null, sessions: -1 },
    { at: AT, cause: 'oom', detail: null, sessions: 1.5 },
    { at: AT, cause: 'oom', detail: null },
  ];
  for (const b of bad) assert.equal(parseNotice(b), null, JSON.stringify(b));
});

test('a hostile process name loses the detail, not the notice', () => {
  for (const process of ['<img src=x>', 'a b', '', 'x'.repeat(33), 'py\nthon']) {
    const n = parseNotice({ at: AT, cause: 'oom', detail: { process, rssMb: 10 }, sessions: 1 });
    assert.equal(n?.detail, null, `process=${JSON.stringify(process)}`);
    assert.equal(n?.cause, 'oom');
  }
  const neg = parseNotice({ at: AT, cause: 'oom', detail: { process: 'python', rssMb: -1 }, sessions: 1 });
  assert.equal(neg?.detail, null, 'a negative size is not a size');
});

test('a resume answer keeps its good rows and drops the malformed ones', () => {
  const session = { id: 'new-1', title: 'claude', status: 'running', createdAt: AT };
  const got = parseResumeAnswer({
    resumed: [
      { historyId: 'h1', previousSessionId: 'old-1', session },
      { historyId: 'h2', previousSessionId: 'old-2', session: { id: '' } },
      { historyId: 'h3', session },
      'junk',
    ],
    failed: [{ historyId: 'h4', error: 'This conversation is already open.' }, { historyId: 5 }, { historyId: 'h6' }],
  });
  assert.deepEqual(got?.resumed.map((r) => r.historyId), ['h1']);
  assert.equal(got?.resumed[0]?.previousSessionId, 'old-1');
  assert.deepEqual(got?.failed, [
    { historyId: 'h4', error: 'This conversation is already open.' },
    { historyId: 'h6', error: '' },
  ]);
});

test('a resume answer without both lists is not an answer', () => {
  for (const b of [null, {}, { resumed: [] }, { failed: [] }, { resumed: {}, failed: [] }]) {
    assert.equal(parseResumeAnswer(b), null, JSON.stringify(b));
  }
  assert.deepEqual(parseResumeAnswer({ resumed: [], failed: [] }), { resumed: [], failed: [] }, 'the idempotent answer');
});
