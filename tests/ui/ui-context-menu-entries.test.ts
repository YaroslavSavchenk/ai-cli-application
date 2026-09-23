/**
 * The row context menu (Nocturne parts A9b brief 2, B10a) — roving focus
 * inside the card and what each entry does, on the REAL
 * `web/src/ui/context-menu.ts` and `web/src/ui/files.ts` over the DOM double
 * (shared setup: `tests/helpers/ui-context-menu-fixture.ts`). Split from
 * `tests/ui/ui-context-menu.test.ts`.
 *
 * Why: a disabled entry rendered with the `disabled` attribute cannot be
 * reached by the arrows at all — and the one-line explanation under its
 * label is the entire reason it is on the menu (user decision 3); an Enter
 * or an arrow the menu does not spend is read again by the panel behind it.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`): that
 * the card is legible, that it changes no layout, that a real `<button>`
 * activates on Enter/Space (the fake DOM activates nothing — the module's own
 * handler is the single path and is asserted instead), that a right-click
 * inside a terminal really reaches xterm, and screen-reader output.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { byClass, dispatch, textsOf, type FakeElement } from '../helpers/fake-dom.ts';
import { PROJ, settle } from '../helpers/fs-fixture.ts';
import {
  dom,
  st,
  F,
  CM,
  M,
  destName,
  type ViewLike,
  picked,
  offered,
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
} from '../helpers/ui-context-menu-fixture.ts';

beforeEach(() => {
  resetWorld();
});

afterEach(() => {
  CM.closeRowMenu();
});

// ---------------------------------------------------------------------------
// Roving focus
// ---------------------------------------------------------------------------

test('the first entry holds the keyboard on open, and it is the only tab stop', async () => {
  await liveSession();
  rightClick(row('web'));
  const list = items();
  assert.ok(list.length >= 3, `non-vacuity: ${list.length} entries`);
  assert.equal(dom.doc.activeElement, list[0]);
  assert.deepEqual(
    list.map((b) => b.tabIndex),
    [0, ...list.slice(1).map(() => -1)],
    'one tab stop: the arrows move inside the menu, Tab leaves it',
  );
});

test('the arrows wrap in both directions, Home and End jump, disabled entries included', async () => {
  await liveSession();
  rightClick(row('web'));
  const list = items();
  const n = list.length;
  const at = (): number => list.findIndex((b) => b === dom.doc.activeElement);
  const key = (k: string): void => {
    dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: k });
  };
  assert.equal(at(), 0);
  key('ArrowDown');
  assert.equal(at(), 1, 'and the second entry is a DISABLED one — the arrows reach it');
  assert.equal(list[1]?.getAttribute('aria-disabled'), 'true');
  key('ArrowUp');
  assert.equal(at(), 0);
  key('ArrowUp');
  assert.equal(at(), n - 1, 'up off the first wraps to the last');
  key('ArrowDown');
  assert.equal(at(), 0, 'down off the last wraps to the first');
  key('End');
  assert.equal(at(), n - 1);
  key('Home');
  assert.equal(at(), 0);
  // The roving tabindex follows the keyboard, or Tab would re-enter at the top.
  key('End');
  assert.deepEqual(
    list.map((b) => b.tabIndex),
    [...list.slice(0, n - 1).map(() => -1), 0],
  );
});

test('the hairline above Delete is NOT an arrow stop — the keyboard steps over it, both ways', async () => {
  await liveSession();
  rightClick(row('web'));
  const list = items();
  const n = list.length;
  const at = (): number => list.findIndex((b) => b === dom.doc.activeElement);
  const key = (k: string): void => {
    dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: k });
  };
  // Non-vacuity: this menu really ends in the one `separated` entry (B10a), so
  // the step this test is about — the entry above it, and back — exists.
  assert.equal(labels()[n - 1], 'Delete');
  assert.equal(byClass(menuEl() as FakeElement, 'cm-sep').length, 1, 'one hairline, above Delete');

  key('End');
  assert.equal(at(), n - 1, 'End lands on Delete itself');
  key('ArrowUp');
  assert.equal(at(), n - 2, 'and one step up is the ENTRY above it, never the hairline');
  key('ArrowDown');
  assert.equal(at(), n - 1, 'and one step back down is Delete again');
  // The roving tab stop is on that entry too: a separator that had become one
  // would be the app's only tab stop with nothing to activate.
  assert.deepEqual(
    list.map((b) => b.tabIndex),
    [...list.slice(0, n - 1).map(() => -1), 0],
  );
});

test('an arrow inside the menu is spent there — nothing behind it reads it', async () => {
  await liveSession();
  rightClick(row('web'));
  const e = dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: 'ArrowDown' });
  assert.equal(e.defaultPrevented, true);
  assert.equal(e.cancelBubble, true);
});

// ---------------------------------------------------------------------------
// What the entries do
// ---------------------------------------------------------------------------

test('Close on an open folder closes it — the same toggle the primary click performs', async () => {
  await liveSession();
  rightClick(row('web'));
  assert.deepEqual(labels()[0], 'Close', 'non-vacuity: the folder is open, so the entry says Close');
  activate('Close');
  assert.equal(menuEl(), undefined, 'a choice closes the menu');
  assert.equal(row('web').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(selectedRows(), ['fdir:web'], 'and the folder stays the chosen one');

  rightClick(row('web'));
  assert.deepEqual(labels()[0], 'Open', 'a closed folder offers the other half of the same toggle');
  activate('Open');
  assert.equal(row('web').getAttribute('aria-expanded'), 'true');
});

test('Open on a file row opens it as a tab of its root folder s tab', async () => {
  await liveSession();
  rightClick(fileRow('web/src/store.ts'));
  activate('Open');
  const v = st.activeView() as ViewLike;
  assert.deepEqual(
    v.slots.map((s) => st.slotTabIds(s)),
    [[`f:${PROJ}/web/src/store.ts`]],
    'one editor pane, holding that file at its ABSOLUTE path (part B2)',
  );
});

test('Open beside splits the focused pane — the menu s half of ctrl+alt+enter', async () => {
  await liveSession();
  fileRow('web/src/store.ts').click();
  assert.equal((st.activeView() as ViewLike).slots.length, 1, 'non-vacuity: one pane to split');
  rightClick(fileRow('web/src/Pane.tsx'));
  activate('Open beside');
  assert.equal((st.activeView() as ViewLike).slots.length, 2, 'the file took a split beside it');
});

test('Copy files here… opens the chooser for THAT folder, not for the panel s root', async () => {
  await liveSession();
  assert.equal(destName(F.pasteDestination()), 'api', 'non-vacuity: the panel s own root is `api`');
  rightClick(row('web/src'));
  activate('Copy files here…');
  assert.equal(picked.length, 1, 'the native chooser, once');
  (picked[0] as (f: { name: string }[]) => void)([{ name: 'a.txt' }]);
  // One listing later: since part B2 the conflict question is asked against
  // the REAL folder before the dialog opens.
  await settle();
  assert.equal(offered.length, 1);
  assert.deepEqual(
    offered[0]?.dest,
    { path: `${PROJ}/web/src`, name: 'src' },
    'the row s own folder: the NAME it shows, the PATH part B10 posts to',
  );
});

test('a DISABLED entry is aria-disabled, carries its sentence, and does nothing at all', async () => {
  await liveSession();
  rightClick(row('web'));
  const list = items();
  const off = list.filter((b) => b.getAttribute('aria-disabled') === 'true');
  assert.equal(off.length, 2, 'Copy and Paste, until part B10');
  for (const b of off) {
    assert.equal(b.disabled, false, 'never the `disabled` attribute: the arrows must reach it');
    assert.equal(b.hasAttribute('disabled'), false);
    assert.equal(byClass(b, 'cm-sub').length, 1, 'the sentence is the reason it is on the menu');
  }
  const notes = textsOf(dom.body, 'cm-sub');
  assert.deepEqual(notes, [M.COPY_NOTE, M.PASTE_NOTE], 'verbatim from the model');

  // Activating one does NOTHING and the menu STAYS OPEN — the note is the
  // answer, and taking the menu away would hide it.
  const before = st.state.views.length;
  activate('Copy');
  assert.ok(menuEl() !== undefined, 'the menu stays up');
  assert.equal(picked.length, 0);
  assert.equal(offered.length, 0);
  assert.equal(st.state.views.length, before);
  assert.equal(row('web').getAttribute('aria-expanded'), 'true', 'and nothing toggled');
});

test('Enter and Space are spent on the menu: prevented, and never read behind it', async () => {
  // A `<button>`'s own activation IS the default action of these keys (Enter on
  // keydown, Space on keyup), so without `preventDefault()` a real browser
  // activates the entry a SECOND time — one keystroke, two actions — and
  // without `stopPropagation()` a window handler behind the menu reads a key
  // the menu already spent. The fake DOM activates nothing by itself, which is
  // why both are asserted on the event and not on the effect. MEASURED (gate,
  // 2026-09-16): dropping both lines left the whole suite green.
  await liveSession();
  rightClick(row('web'));
  const e = dispatch(items()[0] as FakeElement, 'keydown', { key: 'Enter' });
  assert.equal(e.defaultPrevented, true, 'a browser would activate the entry twice');
  assert.equal(e.cancelBubble, true);

  // The same for Space, and on a DISABLED entry — which does nothing at all,
  // but must not hand the key on to anything behind it either.
  rightClick(row('web'));
  dispatch(dom.doc.activeElement as FakeElement, 'keydown', { key: 'ArrowDown' });
  const off = dom.doc.activeElement as FakeElement;
  assert.equal(off.getAttribute('aria-disabled'), 'true', 'non-vacuity: a disabled entry');
  const d = dispatch(off, 'keydown', { key: ' ' });
  assert.equal(d.defaultPrevented, true, 'Space would scroll the page behind the menu');
  assert.equal(d.cancelBubble, true);
  assert.ok(menuEl() !== undefined, 'and the menu is still up');
});

test('every word the menu renders is plain: no path, no key name, no product name', async () => {
  await liveSession();
  rightClick(row('web/src'));
  const said = [...labels(), ...textsOf(dom.body, 'cm-sub'), menuEl()?.getAttribute('aria-label') ?? ''];
  assert.ok(said.length >= 5, `non-vacuity: ${said.length} strings`);
  for (const s of said) {
    assert.equal(/[/\\]/.test(s), false, `a path reached the menu: ${s}`);
    assert.equal(/ctrl\+|shift\+|\balt\b|F10/i.test(s), false, `a key name reached the menu: ${s}`);
    assert.equal(/claude|explorer|windows|xterm/i.test(s), false, `a product name: ${s}`);
  }
});
