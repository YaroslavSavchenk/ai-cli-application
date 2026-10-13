/**
 * Nocturne D6 — the rules of the Claude Code compatibility notice, its
 * Settings fact and the pane's early-exit banner text
 * (`web/src/ui/claude-notice-model.ts`; `.claude/plans/nocturne/PLAN-D6.md`
 * § What the user gets, § Defaults, § Test gate "Notice model").
 *
 * Pure: the model is imported and called. The DOM halves are
 * `tests/ui/ui-claude-notice.test.ts` (the notice and the stack),
 * `tests/ui/ui-settings-claude-fact.test.ts` (the Settings span) and
 * `tests/ui/ui-pane-early-exit.test.ts` (the pane banner).
 *
 * NOT claimed: that anything shows these strings (the DOM halves above); that
 * `compat` is right for a version (the server's rule,
 * tests/server/claude-compat.test.ts); a real browser rendering them
 * (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClaudeCompat, ClaudeStatus } from '../../shared/protocol-runtime.ts';
import {
  EARLY_EXIT_LEAD,
  claudeFact,
  claudeNotice,
  clearsHiddenOnEarlyExit,
  earlyExitIsNew,
  exitNote,
} from '../../web/src/ui/claude-notice-model.ts';

const RANGE = { min: '2.1.263', testedUpTo: '2.1.287' };
const status = (compat: ClaudeCompat, version: string | null): ClaudeStatus => ({ version, compat, ...RANGE });

const OLDER = 'Claude Code 2.1.250 is older than this app needs (2.1.263). Update Claude Code.';
const NEWER = 'This app was tested up to Claude Code 2.1.287. You have 2.1.300. If launches fail, check for an app update.';

// ---------------------------------------------------------------------------
// claudeNotice: every compat × hidden case
// ---------------------------------------------------------------------------

test('older: the notice shows with the spec’s sentence byte-exact', () => {
  const n = claudeNotice(status('older', '2.1.250'), undefined);
  assert.deepEqual(n, { kind: 'older', version: '2.1.250', title: 'Claude Code is too old', body: OLDER });
});

test('newer: the notice shows with the spec’s sentence byte-exact', () => {
  const n = claudeNotice(status('newer', '2.1.300'), undefined);
  assert.deepEqual(n, {
    kind: 'newer',
    version: '2.1.300',
    title: 'Claude Code is newer than tested',
    body: NEWER,
  });
});

test('the sentences read min and testedUpTo from the runtime, not from a copy of the range', () => {
  const s: ClaudeStatus = { version: '3.0.0', compat: 'newer', min: '1.0.0', testedUpTo: '2.9.9' };
  assert.equal(
    claudeNotice(s, undefined)?.body,
    'This app was tested up to Claude Code 2.9.9. You have 3.0.0. If launches fail, check for an app update.',
  );
  const o: ClaudeStatus = { version: '0.9.0', compat: 'older', min: '1.0.0', testedUpTo: '2.9.9' };
  assert.equal(claudeNotice(o, undefined)?.body, 'Claude Code 0.9.0 is older than this app needs (1.0.0). Update Claude Code.');
});

test('the hidden version hides it; any other hidden value does not', () => {
  for (const compat of ['older', 'newer'] as const) {
    const v = compat === 'older' ? '2.1.250' : '2.1.300';
    assert.equal(claudeNotice(status(compat, v), v), null, `${compat}: hidden for exactly this version`);
    assert.notEqual(claudeNotice(status(compat, v), '2.1.1'), null, `${compat}: another hidden version shows it`);
    assert.notEqual(claudeNotice(status(compat, v), ''), null, `${compat}: an empty hidden value shows it`);
  }
});

test('a DIFFERENT version than the hidden one shows again (decision 19)', () => {
  // Hidden for 2.1.300; Claude Code moved on to 2.1.301 — a new fact.
  const n = claudeNotice(status('newer', '2.1.301'), '2.1.300');
  assert.equal(n?.version, '2.1.301');
  // And from newer to older (a downgrade) the same.
  assert.equal(claudeNotice(status('older', '2.1.250'), '2.1.300')?.kind, 'older');
});

test('ok, missing and unknown never show a notice, hidden or not', () => {
  for (const hidden of [undefined, '2.1.287', '2.1.300']) {
    assert.equal(claudeNotice(status('ok', '2.1.287'), hidden), null);
    assert.equal(claudeNotice(status('missing', null), hidden), null);
    assert.equal(claudeNotice(status('unknown', null), hidden), null);
    assert.equal(claudeNotice(status('unknown', 'error: no such thing'), hidden), null);
  }
});

test('no runtime yet, or a verdict without a version, shows nothing', () => {
  assert.equal(claudeNotice(null, undefined), null);
  // Not a state the server sends; the model does not invent a version for it.
  assert.equal(claudeNotice(status('newer', null), undefined), null);
});

// ---------------------------------------------------------------------------
// clearsHiddenOnEarlyExit
// ---------------------------------------------------------------------------

test('an early exit clears the hidden value unless the server says the version is ok', () => {
  for (const compat of ['older', 'newer', 'missing', 'unknown'] as const) {
    assert.equal(clearsHiddenOnEarlyExit(status(compat, '2.1.300'), '2.1.300'), true, compat);
  }
  assert.equal(clearsHiddenOnEarlyExit(status('ok', '2.1.287'), '2.1.287'), false, 'ok: nothing to say');
  // No runtime read yet: nothing says the version is fine.
  assert.equal(clearsHiddenOnEarlyExit(null, '2.1.300'), true);
});

test('nothing hidden: an early exit writes nothing', () => {
  for (const compat of ['older', 'newer', 'missing', 'unknown', 'ok'] as const) {
    assert.equal(clearsHiddenOnEarlyExit(status(compat, '2.1.300'), undefined), false, compat);
  }
});

test('early exit then the model: the cleared value brings the same version’s notice back', () => {
  const s = status('newer', '2.1.300');
  let hidden: string | undefined = '2.1.300';
  assert.equal(claudeNotice(s, hidden), null);
  if (clearsHiddenOnEarlyExit(s, hidden)) hidden = undefined;
  assert.equal(claudeNotice(s, hidden)?.body, NEWER);
});

test('earlyExitIsNew: only a session created after the page loaded is new evidence', () => {
  const loaded = 1_760_000_000_000;
  assert.equal(earlyExitIsNew(loaded + 1, loaded), true, 'a live death on this page');
  assert.equal(earlyExitIsNew(loaded - 60_000, loaded), false, 'a replay after a reload or reconnect');
  assert.equal(earlyExitIsNew(loaded, loaded), false, 'the boundary is not after');
  assert.equal(earlyExitIsNew(Date.parse('not a date'), loaded), false, 'no readable createdAt: not new');
});

// ---------------------------------------------------------------------------
// claudeFact: the Settings → Background service line, every state
// ---------------------------------------------------------------------------

test('the Settings fact for every state', () => {
  assert.equal(claudeFact(status('ok', '2.1.287')), 'Claude Code 2.1.287 (tested up to 2.1.287)');
  assert.equal(claudeFact(status('older', '2.1.250')), 'Claude Code 2.1.250 (tested up to 2.1.287)');
  assert.equal(claudeFact(status('newer', '2.1.300')), 'Claude Code 2.1.300 (tested up to 2.1.287)');
  assert.equal(claudeFact(status('missing', null)), 'Claude Code not found');
  // `missing` wins over any text the probe might have carried.
  assert.equal(claudeFact(status('missing', 'x')), 'Claude Code not found');
  assert.equal(claudeFact(status('unknown', 'claude: bad interpreter')), 'Claude Code: claude: bad interpreter');
  // Not answered yet, timed out, printed nothing: the wire cannot tell them
  // apart, so there is no fact rather than a `checking…` that may never end.
  assert.equal(claudeFact(status('unknown', null)), null);
  assert.equal(claudeFact(null), null, 'no runtime read yet');
});

// ---------------------------------------------------------------------------
// exitNote: the pane banner's text
// ---------------------------------------------------------------------------

test('without `early` the banner is the old one, unchanged', () => {
  assert.deepEqual(exitNote(0, undefined), { lead: 'Finished, code 0', line: null });
  assert.deepEqual(exitNote(2, null), { lead: 'Finished, code 2', line: null });
});

test('with `early` the banner says so, with Claude Code’s line beside it', () => {
  assert.equal(EARLY_EXIT_LEAD, 'Claude Code stopped right after it started');
  assert.deepEqual(exitNote(1, { line: "error: unknown option '--session-id'" }), {
    lead: 'Claude Code stopped right after it started:',
    line: "error: unknown option '--session-id'",
  });
  // A launch that printed nothing: the lead alone, no dangling colon.
  assert.deepEqual(exitNote(1, { line: '' }), { lead: 'Claude Code stopped right after it started', line: null });
});
