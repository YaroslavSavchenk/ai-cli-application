/**
 * Nocturne D6 — Settings → Background service states which Claude Code the
 * sessions launch (`web/src/ui/settings-service.ts`, `.sg-svcclaude`;
 * `.claude/plans/nocturne/PLAN-D6.md` § What the user gets, first bullet).
 *
 * The page prints `runtimeFacts().claude` as it stands, and has NO line at all
 * while that is null (before the probe answers, or when it timed out). The
 * sentence itself, for every state, is the model's and is pinned in
 * `tests/ui/ui-claude-notice-model.test.ts`; that the real `runtimeFacts()`
 * hands it over is pinned in `tests/ui/ui-claude-notice.test.ts`. The panel is
 * the shared fixture's (`tests/helpers/ui-settings-panel-fixture.ts`).
 *
 * NOT claimed: the span's real placement and styling on the Settings page (no
 * CSS in the fake DOM); a real backend's probe answer reaching the page
 * (tests/server/claude-version-route.test.ts pins the body). The user's DEV
 * check sees the fact in the real window.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byClass, type FakeElement } from '../helpers/fake-dom.ts';
import { H, panelOf, reopen, tab } from '../helpers/ui-settings-panel-fixture.ts';

const fact = (): FakeElement => byClass(panelOf('service'), 'sg-svcclaude')[0] as FakeElement;
const repaint = (): void => {
  for (const fn of H.subscribers) fn('conn');
};

test('the fact sits with the other two, after them', async () => {
  await reopen();
  tab('Background service').click();
  const facts = byClass(panelOf('service'), 'sg-svcfacts')[0] as FakeElement;
  assert.deepEqual(
    facts.children.map((c) => (c as FakeElement).className),
    ['sg-svcver', 'sg-svcup', 'sg-svcclaude'],
  );
});

test('no fact to state: the line is absent, not blank', () => {
  H.facts = { ...H.facts, claude: null };
  repaint();
  assert.equal(fact().hidden, true);
  assert.equal(fact().textContent, '');
});

test('every fact the model can hand over is printed as it stands', () => {
  for (const line of [
    'Claude Code 2.1.287 (tested up to 2.1.287)',
    'Claude Code 2.1.300 (tested up to 2.1.287)',
    'Claude Code not found',
    'Claude Code: claude: bad interpreter',
  ]) {
    H.facts = { ...H.facts, claude: line };
    repaint();
    assert.equal(fact().hidden, false, line);
    assert.equal(fact().textContent, line);
  }
  // And back to nothing (a backend of an older release answering the poll).
  H.facts = { ...H.facts, claude: null };
  repaint();
  assert.equal(fact().hidden, true);
});
