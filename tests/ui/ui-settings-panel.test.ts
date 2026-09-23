/**
 * `web/src/ui/settings.ts` — the Settings panel (Nocturne A7): the shell (five
 * pages behind a left nav, the scrim, Done), the Keyboard page (B6) and the
 * Background service page. The other pages have their own files:
 * `ui-settings-panel-status-bar.test.ts`, `ui-settings-panel-keys.test.ts`
 * (Preferences + B5 keys), `ui-settings-panel-colours.test.ts` (B9).
 *
 * Seam: the REAL module against the DOM double in `tests/helpers/fake-dom.ts`,
 * booted once per file by `tests/helpers/ui-settings-panel-fixture.ts` (the real
 * `ui/util.ts`, `ui/launch-args.ts`, `ui/statusline-model.ts`,
 * `ui/term-colours.ts` and `ui/term-colours-model.ts` take part; only the
 * non-pure imports are stubbed — see the fixture). Tests in one file share the
 * one panel and run in order.
 *
 * WHY, next to `tests/ui/ui-settings-a7.test.ts`. That file pins the STYLE
 * contract from the source; this one pins the plumbing the restyle could have
 * broken silently: the nav really swaps pages, the arrow keys walk it, Done and
 * the scrim close and hand focus back, and the two backend verbs still reach
 * their existing flows.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, colour rendering, that a native colour swatch opens a picker,
 * hit-testing, screen-reader output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROWS } from '../../web/src/ui/shortcuts-rows.ts';
import { byClass, dispatch, textsOf, type FakeElement } from '../helpers/fake-dom.ts';
import {
  H,
  dom,
  anchor,
  modal,
  panel,
  panelOf,
  reopen,
  scrim,
  settle,
  tab,
} from '../helpers/ui-settings-panel-fixture.ts';

// ===========================================================================
// The shell: five pages behind a left nav
// ===========================================================================

test('the panel is a top-anchored modal dialog on the shared scrim, closed at boot', () => {
  assert.equal(scrim.hidden, true, 'nothing is shown until the gear is used');
  assert.equal(scrim.className, 'modal-scrim sg-scrim');
  assert.equal(modal.className, 'sg-modal');
  assert.equal(modal.getAttribute('role'), 'dialog');
  assert.equal(modal.getAttribute('aria-modal'), 'true');
  assert.equal(modal.getAttribute('aria-label'), 'Settings');
  assert.equal(byClass(modal, 'sg-navtitle')[0]?.textContent, 'Settings');
});

test('the nav names the five pages in the plan’s order, as a vertical tablist', () => {
  const tabs = byClass(modal, 'sg-tabs')[0] as FakeElement;
  assert.equal(tabs.getAttribute('role'), 'tablist');
  assert.equal(tabs.getAttribute('aria-orientation'), 'vertical');
  assert.deepEqual(textsOf(modal, 'sg-tab'), [
    'Status bar',
    'Preferences',
    'Keyboard',
    'Terminal colours',
    'Background service',
  ]);
  for (const id of ['status', 'prefs', 'keys', 'colours', 'service']) {
    const p = panelOf(id);
    assert.equal(p.getAttribute('role'), 'tabpanel');
    assert.equal(p.getAttribute('aria-labelledby'), `sg-tab-${id}`);
    assert.equal(tab(byClass(modal, 'sg-tab').find((b) => b.getAttribute('aria-controls') === p.id)?.textContent ?? '').getAttribute('aria-controls'), p.id);
  }
});

test('opening shows Status bar, and exactly one page is visible at a time', async () => {
  panel.open();
  await settle();
  assert.equal(panel.isOpen(), true);
  assert.equal(scrim.hidden, false);
  assert.equal(anchor.getAttribute('aria-expanded'), 'true');
  assert.equal(H.getCalls > 0, true, 'the stored config is re-read on open');
  assert.equal(tab('Status bar').getAttribute('aria-selected'), 'true');
  assert.equal(panelOf('status').hidden, false);
  const shown = ['status', 'prefs', 'keys', 'colours', 'service'].filter((id) => !panelOf(id).hidden);
  assert.deepEqual(shown, ['status']);
  // One tab stop in the nav: the chosen page (roving tabindex).
  assert.deepEqual(
    byClass(modal, 'sg-tab').map((b) => b.tabIndex),
    [0, -1, -1, -1, -1],
  );
  assert.equal(dom.doc.activeElement, tab('Status bar'), 'focus lands in the nav, not on a toggle');
});

test('a nav click swaps the page, and the arrow keys walk the nav', () => {
  tab('Terminal colours').click();
  assert.equal(panelOf('colours').hidden, false);
  assert.equal(panelOf('status').hidden, true);
  assert.equal(tab('Terminal colours').getAttribute('aria-selected'), 'true');
  assert.equal(tab('Status bar').getAttribute('aria-selected'), 'false');
  assert.ok(byClass(modal, 'sg-tab')[3]?.classList.contains('is-sel'));

  dispatch(byClass(modal, 'sg-tabs')[0] as FakeElement, 'keydown', { key: 'ArrowDown' });
  assert.equal(panelOf('service').hidden, false, 'ArrowDown moves to the next page');
  assert.equal(dom.doc.activeElement, tab('Background service'), 'the arrow takes focus with it');
  dispatch(byClass(modal, 'sg-tabs')[0] as FakeElement, 'keydown', { key: 'ArrowDown' });
  assert.equal(panelOf('status').hidden, false, 'and wraps around');
  dispatch(byClass(modal, 'sg-tabs')[0] as FakeElement, 'keydown', { key: 'End' });
  assert.equal(panelOf('service').hidden, false, 'End jumps to the last page');
  dispatch(byClass(modal, 'sg-tabs')[0] as FakeElement, 'keydown', { key: 'Home' });
  assert.equal(panelOf('status').hidden, false, 'Home jumps back to the first');
});

test('the footer holds one accent-outline Done that closes and hands focus back', async () => {
  await reopen();
  const ft = byClass(modal, 'sg-ft')[0] as FakeElement;
  const done = ft.children[0] as FakeElement;
  assert.equal(done.textContent, 'Done');
  assert.equal(done.className, 'btn-accent');
  done.click();
  assert.equal(panel.isOpen(), false);
  assert.equal(scrim.hidden, true);
  assert.equal(anchor.getAttribute('aria-expanded'), 'false');
  assert.equal(dom.doc.activeElement, anchor);
});

test('a click on the scrim closes; a click inside the card does not', async () => {
  panel.open();
  await settle();
  dispatch(modal, 'mousedown');
  assert.equal(panel.isOpen(), true, 'the card swallows its own clicks');
  dispatch(scrim, 'mousedown');
  assert.equal(panel.isOpen(), false);
});

// ===========================================================================
// Keyboard
// ===========================================================================

test('the Keyboard page draws the WHOLE table, from the same rows as the overlay (B6)', async () => {
  await reopen();
  tab('Keyboard').click();
  const page = panelOf('keys');
  assert.equal(
    byClass(page, 'sg-lead')[0]?.textContent,
    'Almost everything you type goes straight to the terminal. The app only listens for these.',
  );
  // One source, two layouts: the page's rows ARE ui/shortcuts-rows.ts.
  assert.equal(byClass(page, 'sg-keyrow').length, ROWS.length);
  assert.deepEqual(
    textsOf(page, 'sg-rowlb'),
    ROWS.map((r) => r.what),
  );
  assert.deepEqual(
    textsOf(page, 'sg-keyui'),
    ROWS.map((r) => r.ui),
    'every row still names where the same thing lives in the UI',
  );
  // A chord is a key chip; a mouse gesture is a sentence and never one.
  assert.deepEqual(
    textsOf(page, 'sg-kbd'),
    ROWS.filter((r) => r.gesture !== true).flatMap((r) => r.keys),
  );
  assert.deepEqual(
    textsOf(page, 'sg-gesture'),
    ROWS.filter((r) => r.gesture === true).flatMap((r) => r.keys),
  );
  // The notes come with the rows they explain.
  assert.deepEqual(
    textsOf(page, 'sg-cap'),
    ROWS.filter((r) => r.note !== undefined).map((r) => r.note),
  );
  // …and the link to a second table is gone with the excerpt it belonged to.
  assert.deepEqual(textsOf(page, 'sg-link'), []);
});

// ===========================================================================
// Background service
// ===========================================================================

test('the Background service page states the two facts and keeps both existing verbs', async () => {
  H.installed = false;
  await reopen();
  tab('Background service').click();
  const page = panelOf('service');
  assert.equal(
    byClass(page, 'sg-lead')[0]?.textContent,
    'Your sessions run in a service that keeps going while this window is open. Restarting it picks up a new version of the app. Every running session closes, but stays in history.',
  );
  assert.equal(byClass(page, 'sg-svcver')[0]?.textContent, 'Version 0.2.0');
  assert.equal(byClass(page, 'sg-svcup')[0]?.textContent, 'Running for 2h 15m');
  const check = byClass(page, 'sg-link')[0] as FakeElement;
  assert.equal(check.textContent, 'Check for updates');
  assert.equal(check.hidden, true, 'a developer clone is not updated from a release page');

  // The runtime poll writes both facts; a conn change refreshes the readouts.
  H.installed = true;
  H.facts = { runningFor: 'just started', version: '0.4.0' };
  for (const fn of H.subscribers) fn('conn');
  assert.equal(byClass(page, 'sg-svcver')[0]?.textContent, 'Version 0.4.0');
  assert.equal(byClass(page, 'sg-svcup')[0]?.textContent, 'Running for just started');
  assert.equal(check.hidden, false, 'an installed app can go and get one');

  // What the check does is pinned in tests/ui/ui-settings-b6.test.ts; here it only
  // has to still be the page's quiet verb, and to ask the backend when used.
  const asked = H.checkCalls;
  check.click();
  await settle();
  assert.equal(H.checkCalls, asked + 1);

  const restart = byClass(page, 'sg-outbtn')[0] as FakeElement;
  assert.equal(restart.textContent, 'Restart service');
  assert.equal(restart.getAttribute('aria-haspopup'), 'dialog');
  restart.click();
  assert.deepEqual(H.restarts, ['settings'], 'the existing confirmation flow, named by its source');
});

test('a closed panel ignores the poll (no work, no notice churn)', () => {
  panel.close();
  H.facts = { runningFor: '9 h', version: '9.9.9' };
  for (const fn of H.subscribers) fn('conn');
  assert.equal(
    byClass(panelOf('service'), 'sg-svcver')[0]?.textContent,
    'Version 0.4.0',
    'the readouts are refreshed on open, not while hidden',
  );
});

test('toggle() opens and closes the same panel', async () => {
  assert.equal(panel.isOpen(), false);
  panel.toggle();
  await settle();
  assert.equal(panel.isOpen(), true);
  panel.toggle();
  assert.equal(panel.isOpen(), false);
});
