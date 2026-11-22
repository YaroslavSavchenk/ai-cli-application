/**
 * `web/src/ui/files-git.ts` `syncPoll` — the Files panel's 5 s git poll
 * (Changes / Commits) pauses while the DOCUMENT is hidden (Quality Q9, user
 * decision 2026-11-22): a minimised window must not keep the backend spawning
 * `git` every 5 s. On becoming visible it asks once right away and keeps the
 * rhythm; the `visibilitychange` listener lives exactly as long as the timer.
 *
 * Seam: the REAL `web/src/ui/files.ts` on the shared DOM double with the fake
 * `FsGateway`, booted by `tests/helpers/ui-files-panel-fixture.ts` — the same
 * harness as `tests/ui/ui-files-panel-changes.test.ts`, whose test pins the
 * poll's existence rules (panel up, watching tab). The interval is the
 * double's recorded one: a test fires it, no clock.
 *
 * NOT claimed: that a real browser fires `visibilitychange` on minimise (it
 * does, per the Page Visibility spec), or the 3 s session poll — left alone on
 * purpose, it is the health probe.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { byKey, type FakeElement } from '../helpers/fake-dom.ts';
import { settle } from '../helpers/fs-fixture.ts';
import {
  changeCalls,
  commitsCalls,
  dom,
  liveSession,
  panel,
  resetPanel,
  root,
  st,
} from '../helpers/ui-files-panel-fixture.ts';

beforeEach(resetPanel);
afterEach(() => {
  dom.doc.visibilityState = 'visible';
});

const tick = (): void => (dom.win.intervals[0] as { fn: () => void }).fn();
const visListeners = (): ((e: unknown) => void)[] =>
  dom.doc.handlers.filter((h) => h.type === 'visibilitychange').map((h) => h.fn as (e: unknown) => void);
/** The document changes visibility: the state flips, then the event fires. */
function becomes(state: 'visible' | 'hidden'): void {
  dom.doc.visibilityState = state;
  for (const fn of visListeners()) fn({ type: 'visibilitychange' });
}

test('Changes: a hidden document asks git nothing on a tick; visible again asks at once', async () => {
  await liveSession();
  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  assert.equal(dom.win.intervals.length, 1, 'non-vacuity: the poll is armed');
  const before = changeCalls.length;

  becomes('hidden');
  await settle();
  tick();
  tick();
  await settle();
  assert.equal(changeCalls.length, before, 'no git call while the window is hidden');

  becomes('visible');
  await settle();
  assert.equal(changeCalls.length, before + 1, 'one call the moment it is visible, no tick needed');
  tick();
  await settle();
  assert.equal(changeCalls.length, before + 2, 'and the 5 s rhythm resumes');
});

test('Commits: the same pause and the same immediate ask', async () => {
  await liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  assert.equal(dom.win.intervals.length, 1, 'non-vacuity: the poll is armed');
  const before = commitsCalls.length;

  becomes('hidden');
  tick();
  await settle();
  assert.equal(commitsCalls.length, before, 'no git log while hidden');

  becomes('visible');
  await settle();
  assert.equal(commitsCalls.length, before + 1, 'page one asked the moment it is visible');
  assert.equal(commitsCalls[commitsCalls.length - 1]?.skip, 0);
});

test('the visibility listener lives exactly as long as the poll', async () => {
  const base = visListeners().length;
  await liveSession();
  assert.equal(visListeners().length, base, 'the Files tab polls nothing and listens to nothing');

  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  assert.equal(visListeners().length, base + 1, 'armed with the timer');
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  assert.equal(visListeners().length, base + 1, 'one timer for both tabs, one listener');

  st.state.leftPanel = null;
  panel.render();
  assert.equal(dom.win.intervals.length, 0);
  assert.equal(visListeners().length, base, 'a dropped poll leaves no listener behind');

  // Nothing armed: becoming visible asks nothing.
  const before = changeCalls.length + commitsCalls.length;
  becomes('hidden');
  becomes('visible');
  await settle();
  assert.equal(changeCalls.length + commitsCalls.length, before, 'no poll, no ask');
});
