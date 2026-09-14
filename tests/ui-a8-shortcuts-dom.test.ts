/**
 * `web/src/ui/shortcuts.ts` — the shortcuts overlay driven through the REAL
 * module on the DOM double in `tests/fake-dom.ts`.
 *
 * WHY THIS FILE EXISTS. Nocturne A8 rebuilt this overlay as the `sc-` block:
 * every element was renamed and the caption moved inside a new `sc-item`
 * wrapper. Everything that guarded it was a source scan
 * (`tests/ui-shortcuts-openers.test.ts`, `tests/ui-a8-dialogs.test.ts`) — a
 * regex over the file, which cannot tell whether the overlay still OPENS,
 * still CLOSES, and still hands the keyboard back. These are the behaviours a
 * rename can break with every regex still green:
 *
 *   1. `toggle()` opens and closes the one instance, and `isOpen()` agrees.
 *   2. The scrim still wears `modal-scrim` beside `sc-scrim`. That class is
 *      the contract `ui/keys.ts` reads (`OPEN_FOCUS_OWNER_SELECTOR` /
 *      `FOCUS_OWNER_SELECTOR`): an overlay that dropped it would look right
 *      and silently hand the keyboard back to the terminal while it is up.
 *   3. Focus: opening moves it to the close button, closing puts it back where
 *      it came from, and Tab cannot leave the dialog (`trapTab`).
 *   4. The two ways out that are not a key: the × button, and a click on the
 *      scrim itself — while a click INSIDE the card keeps it open.
 *   5. The rendered table: one `sc-item` per row, each caption inside the same
 *      item as the row it explains (A8's reason for the wrapper), gestures as
 *      sentences and chords as `<kbd>` chips.
 *
 * No stubs: `ui/shortcuts.ts` imports only `ui/util.ts`. Layout, hit-testing
 * and screen-reader output stay manual
 * (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byClass, descendants, dispatch, installDom, textsOf, type FakeElement } from './fake-dom.ts';

const dom = installDom();

interface ShortcutsModule {
  initShortcuts(
    modalHost: unknown,
    refocus: () => void,
  ): { toggle(): void; close(): void; isOpen(): boolean };
}

// Computed specifier: the server tsconfig must not walk the browser graph.
const SC = (await import(new URL('../web/src/ui/shortcuts.ts', import.meta.url).href)) as ShortcutsModule;

const modalHost = dom.doc.createElement('div');
dom.body.append(modalHost);

/** The element the overlay is opened FROM, like the statusline button. */
const opener = dom.doc.createElement('button');
dom.body.append(opener);

/**
 * The terminal-refocus fallback main.ts injects (`requestTerminalFocus`), as a
 * recorder: the module must never import `ui/panes.ts` for it, so the real
 * module still runs here without a single stub.
 */
let refocusCalls = 0;
const terminal = dom.doc.createElement('div');
dom.body.append(terminal);
const overlay = SC.initShortcuts(modalHost, () => {
  refocusCalls += 1;
  terminal.focus();
});
const scrim = modalHost.children[0] as FakeElement;
const modal = scrim.children[0] as FakeElement;

const one = (root: FakeElement, cls: string): FakeElement => {
  const hit = byClass(root, cls)[0];
  assert.ok(hit !== undefined, `no .${cls}`);
  return hit;
};

/** Open from the opener button, the way every real opener does. */
function openFromOpener(): void {
  if (overlay.isOpen()) overlay.close();
  opener.focus();
  overlay.toggle();
}

// ===========================================================================

test('non-vacuity: the real module built one overlay, closed, with its table', () => {
  assert.equal(modalHost.children.length, 1, 'exactly one scrim in the modal host');
  assert.equal(scrim.hidden, true, 'the overlay starts closed');
  assert.equal(overlay.isOpen(), false);
  assert.equal(modal.getAttribute('role'), 'dialog');
  assert.equal(modal.getAttribute('aria-modal'), 'true');
  assert.ok(byClass(modal, 'sc-item').length >= 10, 'the table must really be rendered');
});

test('the scrim wears modal-scrim beside sc-scrim — the class ui/keys.ts finds an open dialog by', () => {
  // OPEN_FOCUS_OWNER_SELECTOR is '.modal-scrim:not([hidden]), …': the class is
  // what makes the overlay a keyboard owner, and `hidden` is what makes it
  // count only while it is up.
  assert.equal(scrim.className, 'modal-scrim sc-scrim');
  assert.equal(scrim.classList.contains('modal-scrim'), true);
  openFromOpener();
  assert.equal(scrim.hidden, false, 'an open overlay is not hidden, so the selector sees it');
  overlay.close();
  assert.equal(scrim.hidden, true, 'a closed overlay is hidden, so the selector does not');
});

test('toggle opens and closes the SAME instance; open twice appends nothing', () => {
  openFromOpener();
  assert.equal(overlay.isOpen(), true);
  assert.equal(modalHost.children.length, 1);
  overlay.toggle();
  assert.equal(overlay.isOpen(), false);
  assert.equal(modalHost.children.length, 1);
});

test('opening moves the keyboard into the dialog; closing hands it back to the opener', () => {
  openFromOpener();
  const x = one(modal, 'sc-x');
  assert.equal(dom.doc.activeElement, x, 'the close button takes focus on open');
  overlay.toggle();
  assert.equal(dom.doc.activeElement, opener, 'focus goes back where it came from');
});

test('close() on an already-closed overlay is a no-op and steals no focus', () => {
  openFromOpener();
  overlay.close();
  const elsewhere = dom.doc.createElement('button');
  dom.body.append(elsewhere);
  elsewhere.focus();
  overlay.close();
  assert.equal(dom.doc.activeElement, elsewhere, 'a second close must not move the keyboard');
});

test('the × button closes it, and hands the keyboard back like every other exit', () => {
  openFromOpener();
  one(modal, 'sc-x').click();
  assert.equal(overlay.isOpen(), false);
  assert.equal(scrim.hidden, true);
  assert.equal(dom.doc.activeElement, opener);
});

test('a click on the scrim closes it; a click inside the card does not', () => {
  openFromOpener();
  dispatch(one(modal, 'sc-title'), 'mousedown');
  assert.equal(overlay.isOpen(), true, 'a press inside the card is not a dismissal');
  dispatch(scrim, 'mousedown');
  assert.equal(overlay.isOpen(), false, 'a press on the backdrop closes it');
});

test('Tab cannot leave the open dialog (trapTab)', () => {
  openFromOpener();
  const x = one(modal, 'sc-x');
  x.focus();
  const e = dispatch(x, 'keydown', { key: 'Tab' });
  assert.equal(e.defaultPrevented, true, 'the trap must swallow the Tab at the end of the ring');
  assert.equal(dom.doc.activeElement, x, 'focus stays inside the dialog');
  const back = dispatch(x, 'keydown', { key: 'Tab', shiftKey: true });
  assert.equal(back.defaultPrevented, true);
  assert.equal(dom.doc.activeElement, x);
  overlay.close();
});

test('every caption sits INSIDE the item of the row it explains — the reason A8 added sc-item', () => {
  openFromOpener();
  const items = byClass(modal, 'sc-item');
  assert.ok(items.length >= 10, `non-vacuity: ${items.length} items`);
  const withCaption = items.filter((i) => byClass(i, 'sc-cap').length > 0);
  assert.equal(withCaption.length, 2, 'exactly the paste and the copy row carry a caption');
  for (const item of withCaption) {
    const row = byClass(item, 'sc-row')[0];
    assert.ok(row !== undefined, 'a caption without its row is the bug the wrapper prevents');
    const keys = textsOf(item, 'sc-keys').join(' ');
    const cap = textsOf(item, 'sc-cap')[0] ?? '';
    assert.match(cap, /^[A-Z].*\.$/, `a caption is a plain sentence: ${cap}`);
    if (keys.includes('ctrl+shift+v')) assert.match(cap, /ctrl\+v/);
    if (keys.includes('ctrl+shift+c')) assert.match(cap, /ctrl\+c/);
  }
  // Every caption in the whole overlay belongs to an item: none floats loose.
  assert.equal(byClass(modal, 'sc-cap').length, withCaption.length);
  overlay.close();
});

test('a chord renders as a <kbd> chip, a mouse gesture as plain text', () => {
  openFromOpener();
  const kbds = descendants(modal).filter((n) => n.tagName === 'KBD');
  const chips = kbds.map((n) => n.textContent);
  for (const chord of ['ctrl+shift+v', 'shift+insert', 'ctrl+shift+c', 'ctrl+insert', 'esc']) {
    assert.ok(chips.includes(chord), `${chord} must be a key chip`);
  }
  const gestures = textsOf(modal, 'sc-gesture');
  assert.ok(gestures.includes('ctrl+click a link'), 'the link gesture is a sentence, not a chip');
  for (const g of gestures) assert.equal(chips.includes(g), false, `${g} must never render as a chip`);
  overlay.close();
});

test('closing with NOTHING focused hands the keyboard to the terminal, not to <body>', () => {
  // Opened by the `?` key or ctrl+alt+/ with focus on the body: `restoreTo` is
  // the body, and focusing it back is a no-op that leaves typed keys reaching
  // no PTY. The fallback is the same one launch.ts and the Files panel use.
  if (overlay.isOpen()) overlay.close();
  (dom.doc.activeElement as FakeElement).blur();
  assert.equal(dom.doc.activeElement, dom.body, 'non-vacuity: nothing is focused before opening');
  const before = refocusCalls;
  overlay.toggle();
  const x = one(modal, 'sc-x');
  assert.equal(dom.doc.activeElement, x, 'non-vacuity: the overlay really took the keyboard');
  overlay.close();
  assert.equal(refocusCalls - before, 1, 'the terminal-refocus fallback ran exactly once');
  assert.notEqual(dom.doc.activeElement, x, 'the keyboard must not stay on the close button');
  assert.equal(dom.doc.activeElement, terminal, 'the fallback put the keyboard on the terminal');
});

test('opened FROM a control, closing still restores that control and calls no fallback', () => {
  openFromOpener();
  const before = refocusCalls;
  overlay.close();
  assert.equal(dom.doc.activeElement, opener, 'focus goes back where it came from');
  assert.equal(refocusCalls - before, 0, 'a real restore target never reaches the fallback');
});
