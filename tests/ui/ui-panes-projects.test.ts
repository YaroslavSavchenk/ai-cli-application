/**
 * `web/src/ui/panes.ts` — a project rename reaches every session pane's
 * header (Quality Q12 review, `.claude/plans/PLAN-QUALITY.md`). The header
 * names the session's project (`panes-status.ts` `updateHeader`). It used to
 * pick up a rename on the next 3 s session poll; since Q12 a poll that brings
 * the same list notifies nothing, so the panes must hear `projects` itself.
 *
 * How: the REAL panes.ts on the DOM double, driven by the REAL state module
 * (`web/src/state.ts` `setProjects`), with the recorders of
 * `tests/helpers/ui-panes-fixture.ts` — the stubbed `updateHeader` records
 * which session's header was repainted.
 *
 * Why it matters: nothing fails — a renamed project keeps its old name on
 * every open pane until something else about the session changes.
 *
 * NOT claimed: the header's text itself (`updateHeader` is stubbed here; its
 * project-name read is a one-line `st.projectName` call), nor the settings
 * notice and the update confirmation, which are pinned in
 * `tests/ui/ui-settings-panel-status-bar.test.ts` and
 * `tests/ui/ui-a8-restart-dom.test.ts`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { st, resetState } from '../helpers/ui-state-fixture.ts';
import { H, tab } from '../helpers/ui-panes-fixture.ts';

beforeEach(() => {
  resetState();
  H.reset();
});

test('a project rename repaints the header of every session pane on screen', () => {
  tab(['s1', 's2']);
  H.headers.length = 0;
  st.setProjects([{ id: 'p1', name: 'renamed', path: '/home/you/projects/api', createdAt: '2026-09-22T10:00:00.000Z' }]);
  assert.deepEqual([...H.headers].sort(), ['s1', 's2'], 'each session pane repainted its header once');
});
