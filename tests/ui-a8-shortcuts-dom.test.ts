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
  // A9b (2026-09-16) added the third: the files-on-the-clipboard gesture row,
  // whose caption states the terminal limit (only plain ctrl+v carries files).
  // A9c added the fourth: the row-menu gesture, whose caption says the menu now
  // CREATES things — a menu nobody opens is a feature nobody has. B10a added
  // the fifth: the Delete key, whose caption is the one sentence the overlay
  // OWES the reader — there is no undo and no recycle bin behind it. B4 added
  // the sixth: ctrl+s, the third chord outside the ctrl+alt reservation, whose
  // caption is why it is safe — it acts only where the keyboard already is, so
  // a terminal still receives that key.
  assert.equal(
    withCaption.length,
    6,
    'the paste, copy, files-paste, row-menu, delete and save rows',
  );
  for (const item of withCaption) {
    const row = byClass(item, 'sc-row')[0];
    assert.ok(row !== undefined, 'a caption without its row is the bug the wrapper prevents');
    const keys = textsOf(item, 'sc-keys').join(' ');
    const cap = textsOf(item, 'sc-cap')[0] ?? '';
    assert.match(cap, /^[A-Z].*\.$/, `a caption is a plain sentence: ${cap}`);
    if (keys.includes('ctrl+shift+v')) assert.match(cap, /ctrl\+v/);
    if (keys.includes('ctrl+shift+c')) assert.match(cap, /ctrl\+c/);
    // The save row's caption has ONE job: say that a terminal keeps the key.
    if (keys === 'ctrl+s') assert.match(cap, /terminal/);
  }
  // Every caption in the whole overlay belongs to an item: none floats loose.
  assert.equal(byClass(modal, 'sc-cap').length, withCaption.length);
  overlay.close();
});

test('the three A9b gestures are on the overlay, each once, each naming its twin', () => {
  // MEASURED (gate, 2026-09-16): deleting the note-less row (`click a folder
  // row`) left the ENTIRE suite green — the caption count below only ever held
  // the other one. PROJECT-SCOPE's rule is that no control exists only under a
  // pointer, so each row is pinned together WITH the twin it promises.
  // The right-click row joined them in brief 2, together with the delegated
  // `contextmenu` listener and the `isContextMenuChord` caller that make it
  // true — and with the keyboard twin the overlay promises for it.
  openFromOpener();
  const want: readonly (readonly [string, string, string])[] = [
    ['click a folder row', 'select it and open or close it', 'enter on the focused row'],
    ['right-click a row in the Files panel', 'its actions', 'the menu key or shift+f10'],
    [
      'paste with files on the clipboard',
      'copy them into the selected folder',
      'Copy files here… under the panel header, or ctrl+alt+c on a folder row',
    ],
  ];
  const gestures = textsOf(modal, 'sc-gesture');
  const items = byClass(modal, 'sc-item');
  for (const [g, what, ui] of want) {
    assert.equal(gestures.filter((t) => t === g).length, 1, `exactly one row for: ${g}`);
    const item = items.find((i) => textsOf(i, 'sc-gesture').includes(g));
    assert.ok(item !== undefined, `no item for: ${g}`);
    assert.equal(textsOf(item, 'sc-what')[0], what, g);
    assert.equal(textsOf(item, 'sc-ui')[0], ui, `a gesture with no twin the user can reach: ${g}`);
    assert.equal(
      descendants(item).filter((n) => n.tagName === 'KBD').length,
      0,
      `a mouse sentence must never render as a key chip: ${g}`,
    );
  }
  // TWO of the three carry a caption since A9c: the files-paste row states the
  // terminal limit (inside a terminal only PLAIN ctrl+v can carry files,
  // because ui/terminal.ts serves the other two paste keys from the text
  // clipboard, which cannot see a file list), and the row-menu row says what
  // the menu grew — the two entries that create a file or a folder, on a
  // folder row and on the panel's background alike.
  const capped = want.filter(([g]) => {
    const item = items.find((i) => textsOf(i, 'sc-gesture').includes(g));
    return item !== undefined && byClass(item, 'sc-cap').length > 0;
  });
  assert.deepEqual(
    capped.map(([g]) => g),
    ['right-click a row in the Files panel', 'paste with files on the clipboard'],
  );
  // A9c's own row, named and pinned: the panel's BACKGROUND answers the same
  // menu, with the same keyboard twin — a control that exists only under a
  // pointer is forbidden here.
  const bg = items.find((i) =>
    textsOf(i, 'sc-gesture').includes("right-click the Files panel's background"),
  );
  assert.ok(bg !== undefined, 'the background gesture must be on the overlay');
  assert.equal(textsOf(bg, 'sc-what')[0], 'its actions');
  assert.equal(textsOf(bg, 'sc-ui')[0], 'the menu key or shift+f10 with the focus in the panel');
  const pasteItem = items.find((i) =>
    textsOf(i, 'sc-gesture').includes('paste with files on the clipboard'),
  ) as FakeElement;
  assert.match(textsOf(pasteItem, 'sc-cap')[0] ?? '', /plain ctrl\+v/);
  overlay.close();
});

test('the closing sentence stopped claiming plain ctrl+v is never intercepted (A9b)', () => {
  // The A8 wording — "plain ctrl+c/v, arrows and esc are never intercepted" —
  // became a LIE the moment a file paste with a folder selected became the
  // app's (PLAN-A9b §2, user decision 2). MEASURED (gate, 2026-09-16):
  // restoring that sentence verbatim left the entire suite green, so the one
  // sentence the overlay ends on had no test at all.
  openFromOpener();
  const note = byClass(modal, 'sc-note')[0];
  assert.ok(note !== undefined, 'non-vacuity: the overlay still ends on a sentence');
  const text = note.textContent;
  assert.ok(text.length > 100, `non-vacuity: ${text.length} chars`);
  assert.equal(
    /plain ctrl\+c\/v, arrows and esc are never intercepted/.test(text),
    false,
    'the A8 wording is false since A9b',
  );
  assert.match(text, /files/, 'the exception must name what is on the clipboard');
  assert.match(text, /selected/, 'and that it needs a chosen folder');
  assert.match(text, /ctrl\+alt/, 'while the ctrl+alt reservation still stands');
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

// ---------------------------------------------------------------------------
// What A10 added to the table, as rendered (Nocturne A10)
// ---------------------------------------------------------------------------

test('the two A10 chords are rendered chips, each in its own item, with a control beside it', () => {
  openFromOpener();
  const items = byClass(modal, 'sc-item');
  for (const chord of ['ctrl+alt+enter', 'ctrl+alt+w']) {
    const hits = items.filter((i) => textsOf(i, 'sc-keys').join(' ').includes(chord));
    assert.equal(hits.length, 1, `expected one item for ${chord}, found ${hits.length}`);
    const item = hits[0] as FakeElement;
    const kbds = descendants(item).filter((n) => n.tagName === 'KBD');
    assert.deepEqual(kbds.map((n) => n.textContent), [chord], `${chord} renders as one chip`);
    assert.notEqual(textsOf(item, 'sc-what')[0], '', `${chord} must say what it does`);
    assert.notEqual(textsOf(item, 'sc-ui')[0], '', `${chord} must name a control`);
  }
  overlay.close();
});

test('every rendered GESTURE row carries a twin in its right-hand column', () => {
  // PROJECT-SCOPE: no control may exist only under a pointer. A drag row with
  // an empty twin column would be exactly that, and would render as one.
  openFromOpener();
  const items = byClass(modal, 'sc-item');
  const gestureItems = items.filter((i) => byClass(i, 'sc-gesture').length > 0);
  assert.ok(gestureItems.length >= 5, `non-vacuity: ${gestureItems.length} gesture rows rendered`);
  for (const item of gestureItems) {
    const what = textsOf(item, 'sc-gesture').join(' / ');
    assert.notEqual(textsOf(item, 'sc-ui')[0] ?? '', '', `a gesture with no twin: ${what}`);
  }
  // And the three A10 drags name a CHORD, spelled the way the table spells one.
  const twin = (gesture: string): string => {
    const item = gestureItems.find((i) => textsOf(i, 'sc-gesture').includes(gesture));
    assert.ok(item !== undefined, `the ${gesture} row must be rendered`);
    return textsOf(item as FakeElement, 'sc-ui')[0] ?? '';
  };
  assert.equal(twin('drag a file row onto a pane edge'), 'ctrl+alt+enter');
  assert.equal(twin('drag a pane header onto another pane'), 'ctrl+alt+shift+←↑↓→');
  assert.equal(twin('drag a tab along the strip'), 'ctrl+alt+shift+pgup/pgdn');
  overlay.close();
});

// ---------------------------------------------------------------------------
// What A10b added to the table, as rendered (Nocturne A10b)
// ---------------------------------------------------------------------------

test('the file-tab chords render as chips, each in its own item, each with a control', () => {
  openFromOpener();
  const items = byClass(modal, 'sc-item');
  for (const chord of ['ctrl+alt+pgup/pgdn', 'ctrl+alt+m']) {
    const hits = items.filter((i) =>
      descendants(i).some((n) => n.tagName === 'KBD' && n.textContent === chord),
    );
    assert.equal(hits.length, 1, `expected one item for ${chord}, found ${hits.length}`);
    const item = hits[0] as FakeElement;
    assert.notEqual(textsOf(item, 'sc-what')[0], '', `${chord} must say what it does`);
    assert.notEqual(textsOf(item, 'sc-ui')[0], '', `${chord} must name a control`);
  }
  // The unshifted pair and the shifted pair are two chips, not one: they are
  // different chords on the same keys.
  const chips = descendants(modal)
    .filter((n) => n.tagName === 'KBD')
    .map((n) => n.textContent);
  assert.equal(chips.filter((c) => c === 'ctrl+alt+pgup/pgdn').length, 1);
  assert.equal(chips.filter((c) => c === 'ctrl+alt+shift+pgup/pgdn').length, 1);
  overlay.close();
});

test('the two file-tab drags render as sentences, and both name ctrl+alt+m', () => {
  openFromOpener();
  const items = byClass(modal, 'sc-item');
  const twin = (gesture: string): string => {
    const item = items.find((i) => textsOf(i, 'sc-gesture').includes(gesture));
    assert.ok(item !== undefined, `the ${gesture} row must be rendered`);
    return textsOf(item as FakeElement, 'sc-ui')[0] ?? '';
  };
  assert.equal(twin('drag a file tab onto a pane edge'), 'ctrl+alt+m');
  assert.equal(twin('drag a file tab onto another editor pane'), 'ctrl+alt+m');
  assert.equal(twin('drag a file row onto an editor pane'), 'click the row');
  overlay.close();
});

test('a gesture twin that names a chord is NOT rendered as a key chip (it is the other column)', () => {
  // The `sc-ui` column is prose, not a control: rendering it as a <kbd> would
  // make the table read as if the gesture itself were a key.
  openFromOpener();
  const chips = descendants(modal).filter((n) => n.tagName === 'KBD').map((n) => n.textContent);
  const uis = textsOf(modal, 'sc-ui');
  assert.ok(uis.includes('ctrl+alt+enter'), 'non-vacuity: a chord really is a twin somewhere');
  assert.equal(
    chips.filter((c) => c === 'ctrl+alt+enter').length,
    1,
    'exactly one chip for it: its own row',
  );
  overlay.close();
});
