/**
 * The row context menu (Nocturne part A9b, brief 2) — everything that closes
 * it, and its geometry (`menuPosition()` is what the DOM applies), on the
 * REAL `web/src/ui/context-menu.ts` and `web/src/ui/files.ts` over the DOM
 * double (shared setup: `tests/helpers/ui-context-menu-fixture.ts`). Split
 * from `tests/ui/ui-context-menu.test.ts`.
 *
 * Why: a menu that is not removed on close, or whose window/document
 * listeners outlive it, leaves a stale Escape handler swallowing the key for
 * a menu nobody can see, and grows one leak per right-click; an Escape that
 * does not stop propagating closes the whole Files panel behind the menu
 * (`main.ts`'s ladder, mirrored below), and one that stops it always makes
 * the panel unclosable. The fake DOM measures nothing, so the module must
 * position itself by `menuPosition()`, never by reading the document.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`): that
 * the card is legible, that it changes no layout, that a real `<button>`
 * activates on Enter/Space (the fake DOM activates nothing — the module's own
 * handler is the single path and is asserted instead), that a right-click
 * inside a terminal really reaches xterm, and screen-reader output.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { byClass, dispatch, type FakeElement } from '../helpers/fake-dom.ts';
import { PROJ } from '../helpers/fs-fixture.ts';
import { APP_CSS, stripComments } from '../helpers/tokens-helpers.ts';
import {
  dom,
  menuSize,
  st,
  CM,
  M,
  panel,
  root,
  pane,
  liveSession,
  row,
  menuEl,
  items,
  selectedRows,
  rightClick,
  resetWorld,
} from '../helpers/ui-context-menu-fixture.ts';

/**
 * `main.ts`'s Escape ladder, mirrored (the same mirror
 * `tests/ui/ui-files-select.test.ts` uses, and pinned against the real source
 * there): brief 2 may not touch that ladder, so this is how "the menu's own
 * Escape never reaches it" is checked without importing main.ts.
 */
let ladderSaw = 0;
dom.win.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  ladderSaw += 1;
});

beforeEach(() => {
  resetWorld(() => {
    ladderSaw = 0;
  });
});

afterEach(() => {
  CM.closeRowMenu();
});

// ---------------------------------------------------------------------------
// Everything that closes it
// ---------------------------------------------------------------------------

test('Escape closes it, returns the keyboard to the row, and never reaches main.ts s ladder', async () => {
  await liveSession();
  row('web').focus();
  dispatch(row('web'), 'keydown', { key: 'ContextMenu' });
  ladderSaw = 0;
  const e = dispatch(items()[0] as FakeElement, 'keydown', { key: 'Escape' });
  assert.equal(e.defaultPrevented, true);
  assert.equal(e.cancelBubble, true, 'the key is spent on the menu');
  assert.equal(ladderSaw, 0, 'the panel behind the menu must not close under the user');
  assert.equal(menuEl(), undefined);
  assert.equal(dom.doc.activeElement, row('web'));
  assert.equal(st.state.leftPanel, 'files', 'the panel is still there');
});

test('a press outside closes it; a press inside does not', async () => {
  await liveSession();
  rightClick(row('web'));
  dispatch(items()[0] as FakeElement, 'pointerdown', {});
  assert.ok(menuEl() !== undefined, 'a press on the menu is not a press outside it');
  const e = dispatch(pane, 'pointerdown', {});
  assert.equal(menuEl(), undefined);
  assert.equal(e.defaultPrevented, false, 'and the press still does whatever it does');
});

test('the keyboard moving anywhere else closes it', async () => {
  await liveSession();
  rightClick(row('web'));
  const outside = dom.doc.createElement('button');
  dom.body.append(outside);
  outside.focus();
  assert.equal(menuEl(), undefined);
  outside.remove();
});

test('a scroll, a window resize and the window losing focus each close it', async () => {
  await liveSession();
  for (const type of ['scroll', 'resize', 'blur']) {
    rightClick(row('web'));
    assert.ok(menuEl() !== undefined, `non-vacuity: open before ${type}`);
    dispatch(byClass(root, 'files-body')[0] as FakeElement, type, {});
    assert.equal(menuEl(), undefined, `${type} left the menu standing`);
  }
});

test('a rebuild of the panel closes it — the row it points at is about to be replaced', async () => {
  await liveSession();
  rightClick(row('web'));
  assert.ok(menuEl() !== undefined, 'non-vacuity');
  // A file opening somewhere is a rebuild of every row (it is part of `sig()`)
  // and touches neither the root nor the selection — which is exactly the pair
  // this test is about.
  st.openFile({ kind: 'project', id: 'p1' }, `${PROJ}/README.md`, 'README.md');
  panel.render();
  assert.equal(menuEl(), undefined);
  assert.deepEqual(selectedRows(), ['fdir:web'], 'the SELECTION survives the rebuild; the menu never does');
});

test('opening a second menu leaves exactly one on screen', async () => {
  await liveSession();
  rightClick(row('web'));
  rightClick(row('server'));
  assert.equal(byClass(dom.body, 'cm-menu').length, 1);
  assert.equal(menuEl()?.getAttribute('aria-label'), 'actions for server');
});

test('a second right-click on the SAME row replaces the menu — the primitive does that, not rebuild()', async () => {
  // The test above right-clicks a DIFFERENT row, which changes the selection,
  // repaints the tree and closes the menu through `rebuild()` -> `closeRowMenu()`
  // BEFORE the second one opens. MEASURED (gate, 2026-09-16): deleting the
  // `closeRowMenu()` at the top of `openRowMenu()` left the whole suite green,
  // because that rebuild was quietly doing the primitive's job. A second
  // right-click on the row that is ALREADY chosen changes nothing and rebuilds
  // nothing, so only the primitive can answer.
  await liveSession();
  rightClick(row('web'));
  const winOne = dom.win.handlers.length;
  const docOne = dom.doc.handlers.length;
  assert.equal(byClass(dom.body, 'cm-menu').length, 1, 'non-vacuity: one menu is up');
  assert.deepEqual(selectedRows(), ['fdir:web'], 'non-vacuity: the row is already the chosen one');
  rightClick(row('web'), 300, 400);
  assert.equal(byClass(dom.body, 'cm-menu').length, 1, 'a stale card was left on screen');
  assert.equal(dom.win.handlers.length, winOne, 'the first menu s window listeners outlived it');
  assert.equal(dom.doc.handlers.length, docOne, 'the first menu s document listeners outlived it');
  assert.equal(menuEl()?.style.left, '300px', 'and the one on screen is the new one');
  assert.equal(dom.doc.activeElement, items()[0], 'which holds the keyboard');
});

test('every listener goes with the menu: no leak, no stale Escape', async () => {
  await liveSession();
  const win = () => dom.win.handlers.length;
  const doc = () => dom.doc.handlers.length;
  const baseWin = win();
  const baseDoc = doc();
  rightClick(row('web'));
  assert.ok(win() > baseWin && doc() > baseDoc, 'non-vacuity: the menu really registers listeners');
  CM.closeRowMenu();
  assert.equal(win(), baseWin, 'a window listener outlived the menu');
  assert.equal(doc(), baseDoc, 'a document listener outlived the menu');

  // And a closed menu takes no keys: Escape reaches the window again. Pressed
  // OUTSIDE the panel, because the panel's own Escape (the selection this very
  // right-click made) would legitimately stop it first — the key under test
  // here is the menu's stale capture listener, nothing else.
  ladderSaw = 0;
  dispatch(pane, 'keydown', { key: 'Escape' });
  assert.equal(ladderSaw, 1, 'a stale capture listener would have swallowed it');

  // Ten gestures later the counts are still the baseline.
  for (let i = 0; i < 10; i += 1) {
    rightClick(row('web'));
    CM.closeRowMenu();
  }
  assert.equal(win(), baseWin);
  assert.equal(doc(), baseDoc);
  assert.equal(byClass(dom.body, 'cm-menu').length, 0, 'and no card was left behind');
});

test('hiding the panel takes the menu with it', async () => {
  // `render()`'s hidden branch returns BEFORE `rebuild()`, which is the only
  // other place that closes the menu — so without a close of its own the card
  // would float over a panel that is no longer on screen.
  await liveSession();
  const baseWin = dom.win.handlers.length;
  const baseDoc = dom.doc.handlers.length;
  rightClick(row('web'));
  assert.equal(byClass(dom.body, 'cm-menu').length, 1, 'non-vacuity: a menu is up');
  assert.ok(dom.win.handlers.length > baseWin, 'non-vacuity: it registered window listeners');
  // The Projects drawer borrowing the left column: `filesPanelVisible()` is the
  // one seam both ways of hiding the panel go through.
  st.state.drawer = 'projects';
  panel.render();
  assert.equal(st.filesPanelVisible(), false, 'non-vacuity: the panel really is off screen');
  assert.equal(byClass(dom.body, 'cm-menu').length, 0, 'the card outlived its panel');
  assert.equal(CM.isRowMenuOpen(), false);
  assert.equal(dom.win.handlers.length, baseWin, 'and its window listeners went with it');
  assert.equal(dom.doc.handlers.length, baseDoc, 'and its document listeners too');
  st.state.drawer = null;
  panel.render();
});

// ---------------------------------------------------------------------------
// Geometry: menuPosition is what the DOM applies
// ---------------------------------------------------------------------------

test('the point the DOM applies is menuPosition s, flipped and clamped at the far corner', async () => {
  await liveSession();
  dom.win.innerWidth = 1600;
  dom.win.innerHeight = 900;
  rightClick(row('web'), 1500, 850);
  const want = M.menuPosition({ x: 1500, y: 850 }, menuSize, { w: 1600, h: 900 });
  assert.deepEqual(want, { x: 1300, y: 754 }, 'non-vacuity: this point really flips both ways');
  assert.equal(menuEl()?.style.left, '1300px');
  assert.equal(menuEl()?.style.top, '754px');
});

test('a point with room takes it unchanged, and a tiny viewport clamps to the margin', async () => {
  await liveSession();
  rightClick(row('web'), 120, 200);
  assert.equal(menuEl()?.style.left, '120px');
  assert.equal(menuEl()?.style.top, '200px');
  CM.closeRowMenu();

  // A viewport smaller than the menu: it sits at the inset and is CLIPPED by
  // the window, which is visible, rather than placed at a negative coordinate.
  dom.win.innerWidth = 120;
  dom.win.innerHeight = 80;
  rightClick(row('web'), 100, 70);
  assert.equal(menuEl()?.style.left, `${M.MENU_MARGIN}px`);
  assert.equal(menuEl()?.style.top, `${M.MENU_MARGIN}px`);
});

test('the module reads the viewport from the window, not from a constant', async () => {
  await liveSession();
  dom.win.innerWidth = 700;
  dom.win.innerHeight = 500;
  rightClick(row('web'), 600, 450);
  const want = M.menuPosition({ x: 600, y: 450 }, menuSize, { w: 700, h: 500 });
  assert.equal(menuEl()?.style.left, `${want.x}px`);
  assert.equal(menuEl()?.style.top, `${want.y}px`);
  assert.notEqual(want.x, 600, 'non-vacuity: this narrower window really moves the menu');
});

test('the card is fixed to the viewport, so opening it moves no pixel of the layout', async () => {
  // A width change anywhere in the shell fires every pane's ResizeObserver and
  // resizes every PTY behind it (the A9 rule). The menu lives on the BODY.
  await liveSession();
  rightClick(row('web'));
  assert.equal((menuEl() as FakeElement).parentNode, dom.body, 'the body, never the panel');
  const rule = /\.cm-menu\s*\{([^}]*)\}/.exec(stripComments(APP_CSS))?.[1] ?? '';
  assert.match(rule, /position: fixed/);
  assert.match(rule, /z-index: var\(--z-menu\)/);
});
