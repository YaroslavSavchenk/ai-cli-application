/**
 * The row context menu (Nocturne part A9b, brief 2) — the REAL
 * `web/src/ui/context-menu.ts` and the REAL `web/src/ui/files.ts` that opens
 * it, driven on the DOM double in `tests/helpers/fake-dom.ts` (shared setup:
 * `tests/helpers/ui-context-menu-fixture.ts`). This file: where the menu
 * opens and where it must not (rows, the A9c root menu, the rest of the
 * screen), what a right-click does to the selection, and the keyboard twin
 * (the ContextMenu key and shift+F10).
 *
 * WHY THIS FILE EXISTS. The menu's decisions are pinned DOM-free next door
 * (`tests/ui/ui-context-menu-model.test.ts`: which entries, what they are called,
 * where the box goes, where the arrows go). What lives here is everything that
 * can only be wrong in a browser, and every one of those ways is silent:
 * a `contextmenu` listener that acts one node too wide takes the SYSTEM
 * menu away from a terminal — xterm's own `contextmenu` handler puts the
 * selection in its helper textarea so the system Copy/Paste act on it, and
 * an app that called `preventDefault()` there would break copying out of a
 * session with no error anywhere; a menu anchored to a row the panel then
 * rebuilds points at the wrong folder while still naming the right one.
 *
 * Elsewhere: roving focus and what the entries do in
 * `tests/ui/ui-context-menu-entries.test.ts`; everything that closes it and
 * its geometry in `tests/ui/ui-context-menu-close.test.ts`; the source and
 * CSS pins in `tests/ui/ui-context-menu-source.test.ts`.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`): that
 * the card is legible, that it changes no layout, that a real `<button>`
 * activates on Enter/Space (the fake DOM activates nothing — the module's own
 * handler is the single path and is asserted instead), that a right-click
 * inside a terminal really reaches xterm, and screen-reader output.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { byClass, byKey, dispatch, setRect, type FakeElement } from '../helpers/fake-dom.ts';
import { PROJ, settle } from '../helpers/fs-fixture.ts';
import {
  dom,
  menuSize,
  F,
  CM,
  M,
  destName,
  picked,
  offered,
  root,
  pane,
  term,
  strip,
  status,
  liveSession,
  row,
  fileRow,
  menuEl,
  items,
  labels,
  selectedRows,
  rightClick,
  resetWorld,
  activate,
  FILES_SRC,
} from '../helpers/ui-context-menu-fixture.ts';

beforeEach(() => {
  resetWorld();
});

afterEach(() => {
  CM.closeRowMenu();
});

// ---------------------------------------------------------------------------
// Where it opens, and where it must not
// ---------------------------------------------------------------------------

test('a right-click on a FOLDER row opens the menu with that folder s entries', async () => {
  await liveSession();
  assert.ok(row('web') !== null, 'non-vacuity: the mock tree has a `web` folder row');
  const e = rightClick(row('web'));
  assert.equal(e.defaultPrevented, true, 'the system menu must not open over ours');
  const box = menuEl() as FakeElement;
  assert.ok(box !== undefined, 'a menu');
  assert.equal(CM.isRowMenuOpen(), true);
  assert.equal(box.getAttribute('role'), 'menu');
  assert.equal(box.getAttribute('aria-label'), 'actions for web', 'a NAME, never a path');
  assert.deepEqual(
    labels(),
    M.itemsFor({ dir: true, name: 'web', open: true, deletable: true, renamable: true, count: 1 }).map(
      (i) => i.label,
    ),
    'the entries are the model s, in its order',
  );
  for (const it of items()) assert.equal(it.getAttribute('role'), 'menuitem');
});

test('a right-click on the folder MARK inside the row opens it too (an SVG is not an HTMLElement)', async () => {
  // MEASURED in a real browser (headless Edge, 2026-09-16, part A9b brief 2):
  // the delegated listener narrowed its target with `instanceof HTMLElement`,
  // and an `SVGElement` is not one — so a right-click landing on the folder
  // mark, a third of the row's height, opened NOTHING and was not even
  // prevented. Since the gate of 2026-09-16 the double tells the same truth —
  // `tests/helpers/fake-dom.ts` marks everything `createElementNS` makes and answers
  // `false` for `instanceof HTMLElement` — so the behaviour below fails on its
  // own, and the source guard is pinned beside it.
  await liveSession();
  const mark = byClass(row('web'), 'files-folder')[0] as FakeElement;
  assert.ok(mark !== undefined, 'non-vacuity: the row really carries a folder mark');
  const e = dispatch(mark, 'contextmenu', { clientX: 20, clientY: 120 });
  assert.equal(e.defaultPrevented, true);
  assert.equal(menuEl()?.getAttribute('aria-label'), 'actions for web');
  assert.match(
    FILES_SRC,
    /e\.target instanceof Element \? e\.target : null/,
    'the guard must admit every Element, not only HTML ones',
  );
});

test('a right-click on a FILE row opens the file entries', async () => {
  await liveSession();
  rightClick(fileRow('README.md'));
  assert.equal(menuEl()?.getAttribute('aria-label'), 'actions for README.md');
  assert.deepEqual(
    labels(),
    M.itemsFor({ dir: false, name: 'README.md', open: false, deletable: true, renamable: true, count: 1 }).map(
      (i) => i.label,
    ),
  );
});

test('every row says it opens a menu: aria-haspopup on folder AND file rows', async () => {
  // The house rule, 7 for 7 before this one (main.ts, projects.ts, github.ts,
  // settings.ts twice, statusline.ts, update.ts): a control that opens a popup
  // advertises it. A row opens `role="menu"`, so the value is `menu`.
  await liveSession();
  const rows = byClass(root, 'files-row');
  assert.ok(rows.length >= 4, `non-vacuity: ${rows.length} rows`);
  assert.ok(rows.some((r) => r.classList.contains('is-dir')), 'non-vacuity: folder rows');
  assert.ok(rows.some((r) => r.classList.contains('is-file')), 'non-vacuity: file rows');
  for (const r of rows) {
    assert.equal(
      r.getAttribute('aria-haspopup'),
      'menu',
      `${r.getAttribute('data-k')} opens a menu without saying so`,
    );
  }
});

// ---------------------------------------------------------------------------
// The ROOT menu (part A9c, §6a): the panel's own background
// ---------------------------------------------------------------------------

test('a right-click on the TREE BODY opens the root menu, named after the folder the header prints', async () => {
  await liveSession();
  for (const [what, el] of [
    ['the tree body', byClass(root, 'files-body')[0] as FakeElement],
  ] as [string, FakeElement][]) {
    assert.ok(el !== undefined, `non-vacuity: ${what} is on screen`);
    const e = dispatch(el, 'contextmenu', { clientX: 12, clientY: 40 });
    assert.equal(e.defaultPrevented, true, `the system menu must not open over ours on ${what}`);
    assert.equal(
      menuEl()?.getAttribute('aria-label'),
      'actions for api',
      `${what}: the NAME the header prints, never a path`,
    );
    assert.deepEqual(
      labels(),
      M.itemsForRoot('api').map((i) => i.label),
      `${what}: the entries are the model s, in its order`,
    );
    CM.closeRowMenu();
  }
});

test('the rest of the panel keeps the SYSTEM menu: header, tabs, copy strip, grip', async () => {
  // `.files-view` is the whole panel, and only the list that draws the rows IS
  // the folder. The header carries the project's NAME, the tabs and the copy
  // strip are ordinary controls, the grip is a separator — a right-click there
  // is the system's business (select the name, inspect the control), and A9c
  // taking it would be a menu about a folder offered on top of something else.
  await liveSession();
  for (const [what, el] of [
    ['the panel root', root],
    ['the header', byClass(root, 'files-hd')[0] as FakeElement],
    ['the project name', byClass(root, 'files-proj')[0] as FakeElement],
    ['the Files tab button', byKey(root, 'ftab:files') as FakeElement],
    ['the Commits tab button', byKey(root, 'ftab:commits') as FakeElement],
    ['the copy strip', byClass(root, 'files-copy')[0] as FakeElement],
    ['the copy button', byKey(root, 'fcopy') as FakeElement],
    ['the width grip', byClass(root, 'files-grip')[0] as FakeElement],
  ] as [string, FakeElement][]) {
    assert.ok(el !== undefined && el !== null, `non-vacuity: ${what} is on screen`);
    const e = dispatch(el, 'contextmenu', { clientX: 10, clientY: 10 });
    assert.equal(e.defaultPrevented, false, `the app took the right-click on ${what}`);
    assert.equal(menuEl(), undefined, `a menu opened on ${what}`);
  }
  // Non-vacuity: the tree body right beside them really does answer.
  const e = dispatch(byClass(root, 'files-body')[0] as FakeElement, 'contextmenu', {
    clientX: 12,
    clientY: 40,
  });
  assert.equal(e.defaultPrevented, true);
  assert.equal(menuEl()?.getAttribute('aria-label'), 'actions for api');
});

test('the root menu is NOT the row menu: no Open, no Close, no Copy, no Paste', async () => {
  await liveSession();
  dispatch(byClass(root, 'files-body')[0] as FakeElement, 'contextmenu', { clientX: 12, clientY: 40 });
  assert.deepEqual(labels(), ['Copy files here…', 'New file', 'New folder', 'Refresh']);
  assert.equal(items().filter((b) => b.getAttribute('aria-disabled') === 'true').length, 0);
});

test('a right-click on a row is still the ROW s menu — the background rule never swallows one', async () => {
  await liveSession();
  rightClick(row('web'));
  assert.equal(menuEl()?.getAttribute('aria-label'), 'actions for web');
  CM.closeRowMenu();
  // A STATE row is neither: it has no key to act on, so the event is left alone
  // and the system menu opens, exactly as it did before A9c.
  const state = byClass(root, 'is-state')[0];
  if (state !== undefined) {
    const e = dispatch(state, 'contextmenu', { clientX: 12, clientY: 40 });
    assert.equal(e.defaultPrevented, false, 'a sentence is not a place to create things in');
    assert.equal(menuEl(), undefined);
  }
});

test('the chord opens the root menu when the focus is INSIDE the panel and not on a row', async () => {
  await liveSession();
  for (const init of [{ key: 'ContextMenu' }, { key: 'F10', shiftKey: true }]) {
    const btn = byKey(root, 'fcopy') as FakeElement;
    btn.focus();
    const e = dispatch(btn, 'keydown', init);
    assert.equal(e.defaultPrevented, true, `${init.key} must be owned by the panel`);
    assert.equal(e.cancelBubble, true, 'and spent there, so no window handler sees it');
    assert.equal(menuEl()?.getAttribute('aria-label'), 'actions for api');
    // Escape hands the keyboard back to the control it was opened from.
    dispatch(items()[0] as FakeElement, 'keydown', { key: 'Escape' });
    assert.equal(dom.doc.activeElement, byKey(root, 'fcopy'));
  }
});

test('the chord OUTSIDE the panel is never the panel s — a terminal keeps its own menu key', async () => {
  // The hard constraint (PROJECT-SCOPE): the app takes the ContextMenu key and
  // shift+f10 ONLY while the keyboard is inside the Files panel. Everywhere
  // else they belong to whatever has the focus — a terminal above all, where
  // the menu key is the TUI's, and where losing it would be a key the PTY
  // never sees. The listener lives on the panel's own root for exactly this
  // reason; a window listener would take all four surfaces below.
  await liveSession();
  for (const [what, el] of [
    ['a pane', pane],
    ['a terminal', term],
    ['the tab strip', strip],
    ['the statusline', status],
    ['the page body', dom.body],
  ] as [string, FakeElement][]) {
    for (const init of [{ key: 'ContextMenu' }, { key: 'F10', shiftKey: true }]) {
      assert.ok(el !== undefined, `non-vacuity: ${what} is on screen`);
      const e = dispatch(el, 'keydown', init);
      assert.equal(e.defaultPrevented, false, `${what}: the panel took ${init.key}`);
      assert.equal(e.cancelBubble, false, `${what}: the panel spent ${init.key}`);
      assert.equal(menuEl(), undefined, `${what}: the panel opened its menu over somebody else s surface`);
    }
  }
  // Non-vacuity: the same two keys INSIDE the panel really do open it.
  (byKey(root, 'fcopy') as FakeElement).focus();
  dispatch(byKey(root, 'fcopy') as FakeElement, 'keydown', { key: 'ContextMenu' });
  assert.equal(menuEl()?.getAttribute('aria-label'), 'actions for api');
  CM.closeRowMenu();
});

test('the root menu is the Files tab s: on Changes the right-click is left to the system', async () => {
  await liveSession();
  const changesTab = byKey(root, 'ftab:changes') as FakeElement;
  assert.equal(changesTab.disabled, false, 'non-vacuity: the fixture root is a repository');
  changesTab.click();
  await settle();
  const e = dispatch(byClass(root, 'files-body')[0] as FakeElement, 'contextmenu', {
    clientX: 12,
    clientY: 40,
  });
  assert.equal(e.defaultPrevented, false, 'that tab lists a repository, not this folder');
  assert.equal(menuEl(), undefined);
  (byKey(root, 'ftab:files') as FakeElement).click();
  await settle();
});

test('Copy files here… on the root menu aims at the ROOT, not at the chosen folder', async () => {
  await liveSession();
  row('web/src').click();
  await settle();
  assert.equal(destName(F.selectedFolder()), 'src', 'non-vacuity: a folder is chosen');
  dispatch(byClass(root, 'files-body')[0] as FakeElement, 'contextmenu', { clientX: 12, clientY: 40 });
  activate('Copy files here…');
  assert.equal(picked.length, 1, 'the native chooser, once');
  (picked[0] as (f: { name: string }[]) => void)([{ name: 'a.txt' }]);
  await settle();
  assert.deepEqual(
    offered[0]?.dest,
    { path: PROJ, name: 'api' },
    'the panel s own root: the NAME the header prints, the PATH part B10 posts to',
  );
});

test('a right-click OUTSIDE the panel is not even prevented — the system menu opens as it does today', async () => {
  // Part A9c took the panel's own background for the ROOT menu (§6a), and
  // nothing else: every surface below is somebody else's, and a terminal's in
  // particular is xterm's own arrangement (its `contextmenu` handler puts the
  // selection in the helper textarea so the system Copy and Paste act on it).
  await liveSession();
  const elsewhere: [string, FakeElement][] = [
    ['a pane', pane],
    ['a terminal', term],
    ['the tab strip', strip],
    ['the statusline', status],
  ];
  for (const [what, el] of elsewhere) {
    assert.ok(el !== undefined, `non-vacuity: ${what} is on screen`);
    const e = dispatch(el, 'contextmenu', { clientX: 10, clientY: 10 });
    assert.equal(e.defaultPrevented, false, `the app took the right-click on ${what}`);
    assert.equal(menuEl(), undefined, `a menu opened on ${what}`);
  }
});

// ---------------------------------------------------------------------------
// What a right-click does to the selection
// ---------------------------------------------------------------------------

test('a right-click on a folder row SELECTS it and does NOT toggle it', async () => {
  await liveSession();
  assert.equal(row('web').getAttribute('aria-expanded'), 'true', 'non-vacuity: `web` starts open');
  rightClick(row('web'));
  assert.deepEqual(selectedRows(), ['fdir:web'], 'Explorer s behaviour: the row is chosen');
  assert.equal(destName(F.selectedFolder()), 'web');
  assert.equal(
    row('web').getAttribute('aria-expanded'),
    'true',
    'the toggle belongs to the primary click; the menu names it instead',
  );
});

test('a right-click on a FILE row CHOOSES it (B10a) — a file is something you can now act on', async () => {
  // A9b left a file row unselected because the selection was only a paste
  // destination. Since B10a it is also what a Delete and a Copy are about, so
  // the menu is opened on the row it is about — Explorer's rule, in
  // `afterMenuOpen`.
  await liveSession();
  row('server').click();
  assert.deepEqual(selectedRows(), ['fdir:server'], 'non-vacuity: something is chosen');
  CM.closeRowMenu();
  rightClick(fileRow('README.md'));
  assert.deepEqual(selectedRows(), ['ffile:README.md']);
});

test('the selection a right-click makes is PAINTED — the repaint really happens', async () => {
  // The gesture changes the selection and NOTHING else, so only `sig()`
  // reading the selection makes the row repaint (pinned as source in
  // tests/ui/ui-files-select.test.ts; this is the behaviour behind it).
  await liveSession();
  rightClick(row('web/src'));
  assert.deepEqual(selectedRows(), ['fdir:web/src']);
  assert.equal(row('web/src').getAttribute('aria-current'), 'true');
});

test('the menu is anchored to the row the repaint LEFT behind, so Escape can hand the keyboard back', async () => {
  await liveSession();
  rightClick(row('web'));
  const fresh = row('web');
  assert.equal(fresh.isConnected, true, 'non-vacuity: the row survived the repaint');
  dispatch(items()[0] as FakeElement, 'keydown', { key: 'Escape' });
  assert.equal(dom.doc.activeElement, fresh, 'the keyboard goes back to the row that is on screen');
});

// ---------------------------------------------------------------------------
// The keyboard twin
// ---------------------------------------------------------------------------

test('the ContextMenu key and shift+F10 on a focused row open the menu — and nothing else does', async () => {
  await liveSession();
  for (const init of [{ key: 'ContextMenu' }, { key: 'F10', shiftKey: true }]) {
    const r = row('web');
    r.focus();
    const e = dispatch(r, 'keydown', init);
    assert.equal(e.defaultPrevented, true, `${init.key} must be owned by the row`);
    assert.equal(e.cancelBubble, true, 'and spent there, so no window handler sees it');
    assert.ok(menuEl() !== undefined, `${init.key} opened nothing`);
    assert.equal(menuEl()?.getAttribute('aria-label'), 'actions for web');
    CM.closeRowMenu();
  }
});

test('plain F10, the ctrl variants and AltGr leave the row alone', async () => {
  await liveSession();
  const noes: Record<string, unknown>[] = [
    { key: 'F10' },
    { key: 'F10', shiftKey: true, ctrlKey: true },
    { key: 'F10', shiftKey: true, altKey: true },
    { key: 'F10', shiftKey: true, ctrlKey: true, altKey: true, altGraph: true },
    { key: 'ContextMenu', ctrlKey: true },
    { key: 'ContextMenu', altKey: true, ctrlKey: true, altGraph: true },
  ];
  for (const init of noes) {
    const r = row('web');
    r.focus();
    const e = dispatch(r, 'keydown', init);
    assert.equal(e.defaultPrevented, false, `the row took ${JSON.stringify(init)}`);
    assert.equal(menuEl(), undefined, `a menu opened on ${JSON.stringify(init)}`);
  }
});

test('the keyboard opens it at the row s leading edge and bottom', async () => {
  await liveSession();
  const r = row('server');
  setRect(r, { left: 12, top: 300, width: 260, height: 26 });
  r.focus();
  dispatch(r, 'keydown', { key: 'ContextMenu' });
  const want = M.menuPosition({ x: 12, y: 326 }, menuSize, { w: 1600, h: 900 });
  assert.equal(menuEl()?.style.left, `${want.x}px`);
  assert.equal(menuEl()?.style.top, `${want.y}px`);
});

test('the browser s OWN contextmenu after the chord is swallowed by the menu itself', async () => {
  // Windows sends WM_CONTEXTMENU off the APPS key even when the keydown was
  // prevented, and by then the keyboard is on the first entry — so the event's
  // target is INSIDE the card, which lives on `document.body`, where
  // `ui/files.ts`'s delegated listener on the PANEL ROOT can never see it:
  // `closest('.files-row')` would be null, the listener would return without
  // preventing anything, and the SYSTEM menu would open on top of ours. The
  // menu's own listener is therefore where the guard lives.
  await liveSession();
  const r = row('web');
  r.focus();
  dispatch(r, 'keydown', { key: 'ContextMenu' });
  const first = items()[0] as FakeElement;
  assert.ok(first !== undefined, 'non-vacuity: a menu with entries is up');
  assert.equal(dom.doc.activeElement, first, 'non-vacuity: the keyboard is inside the menu');
  const e = dispatch(first, 'contextmenu', { clientX: 40, clientY: 140 });
  assert.equal(e.defaultPrevented, true, 'the system menu would have opened over ours');
  assert.equal(byClass(dom.body, 'cm-menu').length, 1, 'and nothing was reopened');
  assert.equal(menuEl()?.getAttribute('aria-label'), 'actions for web', 'the same menu');

  // A contextmenu on a ROW while the menu is open still replaces it.
  const e2 = rightClick(row('server'));
  assert.equal(e2.defaultPrevented, true);
  assert.equal(byClass(dom.body, 'cm-menu').length, 1);
  assert.equal(menuEl()?.getAttribute('aria-label'), 'actions for server');
});

test('a FILE row answers the chord too', async () => {
  await liveSession();
  const r = fileRow('web/src/Pane.tsx');
  r.focus();
  dispatch(r, 'keydown', { key: 'ContextMenu' });
  assert.equal(menuEl()?.getAttribute('aria-label'), 'actions for Pane.tsx');
});
