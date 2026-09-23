/**
 * `web/src/ui/files.ts` — the Files panel (Nocturne A5, live since B2): the
 * grip, dragged with real pointer events and driven by the arrow keys, Home
 * and Enter; the width commits on release and stays inside its bounds. The
 * other topics are `ui-files-panel-<topic>.test.ts`: render, file-rows,
 * commits, changes, commit-open, shell, destination, copy.
 *
 * Seam: the REAL `web/src/ui/files.ts` on the shared DOM double, against the
 * REAL `web/src/state.ts`, `ui/util.ts`, `ui/icons.ts`, `ui/files-model.ts`,
 * `ui/fs-model.ts`, `ui/commit-model.ts` and `ui/commit-store.ts`, with the
 * backend a fake `FsGateway` (`tests/helpers/fs-fixture.ts` over
 * `tests/helpers/commits-fixture.ts`) — no HTTP, no module stubbing, no clock.
 * Booted once per file by `tests/helpers/ui-files-panel-fixture.ts` and reset
 * before every test (`resetPanel`).
 *
 * WHY, next to `tests/ui/ui-files-model.test.ts`. That file pins the model's
 * arithmetic; this one pins the PLUMBING between it and the panel, which is
 * where a silent regression fits: a grip that resizes without pointer capture
 * (the pointer leaves the 6px strip and the drag dies mid-gesture), a drag
 * that never commits (the width is lost on the next chrome rebuild), a width
 * that skips the clamp (a 3px panel or a panel wider than the window). Every
 * one of those keeps `ui-files-model.test.ts` green.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, colour, the amber pulse actually animating, that a drag really
 * reflows a PTY, hit-testing, screen-reader output.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../helpers/fake-dom.ts';
import {
  grip,
  host,
  kinds,
  resetPanel,
  st,
} from '../helpers/ui-files-panel-fixture.ts';

beforeEach(resetPanel);

// ---------------------------------------------------------------------------
// The grip: drag, keyboard, commit
// ---------------------------------------------------------------------------

test('the grip is a real separator control: role, bounds, current value, keyboard-reachable', () => {
  assert.equal(grip.getAttribute('role'), 'separator');
  assert.equal(grip.getAttribute('aria-orientation'), 'vertical');
  assert.equal(grip.getAttribute('aria-valuemin'), '200');
  assert.equal(grip.getAttribute('aria-valuemax'), '520');
  assert.equal(grip.getAttribute('aria-valuenow'), '300');
  assert.equal(grip.tabIndex, 0, 'a control that only exists under a pointer is forbidden here');
  assert.equal(host.style.width, '300px', 'the panel is as wide as the state says at construction');
});

test('dragging the grip resizes live, and only the RELEASE commits the width', () => {
  dispatch(grip, 'pointerdown', { clientX: 100, pointerId: 7 });
  assert.ok(grip.hasPointerCapture(7), 'capture, so the pointer may leave the 6px strip');
  dispatch(grip, 'pointermove', { clientX: 150, pointerId: 7 });
  assert.equal(st.state.filesWidth, 350);
  assert.equal(host.style.width, '350px');
  assert.equal(grip.getAttribute('aria-valuenow'), '350');
  assert.deepEqual(kinds, [], 'a notify per pointermove would rebuild the chrome at 60Hz');

  dispatch(grip, 'pointerup', { clientX: 150, pointerId: 7 });
  assert.deepEqual(kinds, ['panel'], 'the release commits exactly once');
  assert.equal(grip.hasPointerCapture(7), false, 'and gives the pointer back');
  assert.equal(st.state.filesWidth, 350, 'the committed width is the dragged one');
});

test('a drag past either bound stops at the bound, it does not run away', () => {
  dispatch(grip, 'pointerdown', { clientX: 100, pointerId: 1 });
  dispatch(grip, 'pointermove', { clientX: 4000, pointerId: 1 });
  assert.equal(st.state.filesWidth, st.FILES_W_MAX);
  assert.equal(host.style.width, '520px');
  dispatch(grip, 'pointermove', { clientX: -4000, pointerId: 1 });
  assert.equal(st.state.filesWidth, st.FILES_W_MIN);
  assert.equal(host.style.width, '200px');
  dispatch(grip, 'pointerup', { clientX: -4000, pointerId: 1 });
});

test('a pointermove without a captured drag changes nothing (the grip is not a hover slider)', () => {
  dispatch(grip, 'pointermove', { clientX: 900, pointerId: 3 });
  assert.equal(st.state.filesWidth, 300);
  assert.equal(host.style.width, '300px');
  assert.deepEqual(kinds, []);

  // A non-primary button never starts one either.
  dispatch(grip, 'pointerdown', { clientX: 100, pointerId: 3, button: 2 });
  assert.equal(grip.hasPointerCapture(3), false);
  dispatch(grip, 'pointermove', { clientX: 900, pointerId: 3 });
  assert.equal(st.state.filesWidth, 300);
});

test('after the release the drag is over: a stray move is ignored', () => {
  dispatch(grip, 'pointerdown', { clientX: 100, pointerId: 2 });
  dispatch(grip, 'pointermove', { clientX: 120, pointerId: 2 });
  dispatch(grip, 'pointerup', { clientX: 120, pointerId: 2 });
  kinds.length = 0;
  dispatch(grip, 'pointermove', { clientX: 500, pointerId: 2 });
  assert.equal(st.state.filesWidth, 320, 'the width the user let go of');
  assert.deepEqual(kinds, []);
});

test('a cancelled pointer (the OS took it) ends the drag like a release', () => {
  dispatch(grip, 'pointerdown', { clientX: 100, pointerId: 5 });
  dispatch(grip, 'pointermove', { clientX: 140, pointerId: 5 });
  kinds.length = 0;
  dispatch(grip, 'pointercancel', { clientX: 140, pointerId: 5 });
  assert.equal(grip.hasPointerCapture(5), false);
  assert.deepEqual(kinds, ['panel']);
  assert.equal(st.state.filesWidth, 340);
});

test('the keyboard is the twin of the drag: arrows nudge 16px, Home resets, both commit', () => {
  dispatch(grip, 'keydown', { key: 'ArrowRight' });
  assert.equal(st.state.filesWidth, 316);
  assert.equal(host.style.width, '316px');
  dispatch(grip, 'keydown', { key: 'ArrowLeft' });
  dispatch(grip, 'keydown', { key: 'ArrowLeft' });
  assert.equal(st.state.filesWidth, 284);
  assert.deepEqual(kinds, ['panel', 'panel', 'panel'], 'every nudge is a committed width');

  const e = dispatch(grip, 'keydown', { key: 'Home' });
  assert.equal(st.state.filesWidth, st.FILES_W_DEFAULT);
  assert.equal(e.defaultPrevented, true, 'Home must not scroll the shell');

  const other = dispatch(grip, 'keydown', { key: 'PageUp' });
  assert.equal(other.defaultPrevented, false, 'keys the grip does not own are left alone');
});

test('Enter resets the width too, and the title promises exactly what the grip does', () => {
  // The pane dividers (ui/panes.ts) promise 'double-click or enter resets it.'
  // and implement Enter; this separator must not diverge from its own twin.
  st.state.filesWidth = 500;
  const e = dispatch(grip, 'keydown', { key: 'Enter' });
  assert.equal(st.state.filesWidth, st.FILES_W_DEFAULT);
  assert.equal(e.defaultPrevented, true);
  assert.match(grip.title, /home, enter or double-click/, `the title still hides a gesture: ${grip.title}`);
});

test('the keyboard cannot nudge past the bounds either', () => {
  st.state.filesWidth = st.FILES_W_MIN;
  for (let i = 0; i < 3; i += 1) dispatch(grip, 'keydown', { key: 'ArrowLeft' });
  assert.equal(st.state.filesWidth, st.FILES_W_MIN);
  st.state.filesWidth = st.FILES_W_MAX;
  for (let i = 0; i < 3; i += 1) dispatch(grip, 'keydown', { key: 'ArrowRight' });
  assert.equal(st.state.filesWidth, st.FILES_W_MAX);
});

test('double-clicking the grip resets the width', () => {
  st.state.filesWidth = 480;
  dispatch(grip, 'dblclick');
  assert.equal(st.state.filesWidth, st.FILES_W_DEFAULT);
  assert.equal(host.style.width, '300px');
  assert.deepEqual(kinds, ['panel']);
});
