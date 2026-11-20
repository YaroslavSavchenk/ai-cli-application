/**
 * The `?demo` control strip of the peek-mascot page (`web/src/mascot/main.ts`,
 * Nocturne C1) gained an "App active" toggle in Nocturne D8
 * (`.claude/plans/nocturne/PLAN-D8.md`): it drives the same presence path the
 * host's `app-active` message drives, so the step back can be tried by hand
 * in a normal browser.
 *
 * How: the REAL page entry with `?demo&count=2`, mounted on the DOM double by
 * `tests/helpers/mascot-page.ts`; the toggle is clicked as a user would. No
 * CSS runs on the double, so the steps happen at once (as under
 * `prefers-reduced-motion`).
 *
 * NOT claimed: how the strip looks, or the slide itself in a browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buttonByLabel, byClass } from '../helpers/fake-dom.ts';
import { mountMascotPage } from '../helpers/mascot-page.ts';

const { root, posted, listeners } = await mountMascotPage('?demo&count=2');
const mascots = (): number => byClass(root, 'pm-pos').length;

test('?demo never listens to or posts to a host', () => {
  assert.equal(listeners.size, 0);
  assert.deepEqual(posted, []);
});

test('the "App active" toggle is a button that sends the mascots back and brings them out again', () => {
  const toggle = buttonByLabel(root, 'App active');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false', 'starts as the page does: not active');
  assert.equal(mascots(), 2);
  toggle.click();
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(mascots(), 0, 'stepped back');
  buttonByLabel(root, '+ input').click();
  assert.equal(mascots(), 0, 'a count change while active shows nothing');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(mascots(), 3, 'out again, with the count reached meanwhile');
  assert.deepEqual(posted, [], 'still nothing to a host');
});
