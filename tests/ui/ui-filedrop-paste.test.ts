/**
 * `web/src/ui/filedrop.ts` — the two twins of a drop (Nocturne part A9):
 * pasting files, and the Files-panel header button through its injected
 * picker seam; plus the A9b paste rule (PLAN-A9b §2) driven through the real
 * window listener: files × chosen folder × terminal × editable × modal.
 * Split from `tests/ui/ui-filedrop.test.ts`.
 *
 * How: the REAL module on the DOM double (`tests/helpers/fake-dom.ts`), the
 * shell from `tests/helpers/ui-filedrop-fixture.ts`; xterm's own `paste`
 * handler is a counted listener on its helper textarea.
 *
 * Why: a paste the app takes inside a terminal without stopping it lets xterm
 * type the clipboard's `text/plain` into the PTY unbracketed; a text paste
 * the app takes is lost to the terminal.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`): that
 * Chromium fires `paste` on xterm's textarea for a real ctrl+v, the OS file
 * picker, and what a real clipboard carries.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, makeDataTransfer, type FakeDataTransfer } from '../helpers/fake-dom.ts';
import {
  dom,
  FD,
  type DropRequest,
  dest,
  settle,
  termHost,
  termTextarea,
  scrim,
  field,
  world,
  resetWorld,
} from '../helpers/ui-filedrop-fixture.ts';

beforeEach(resetWorld);

// ===========================================================================
// The twins
// ===========================================================================

test('pasting files opens the dialog on the paste destination', async () => {
  dispatch(dom.body, 'paste', {
    clipboardData: makeDataTransfer({ files: [{ name: 'shot.png', size: 900 }] }),
  });
  await settle(); // part B2: the listing is read before the dialog opens
  assert.equal(world.opened.length, 1);
  const req = world.opened[0] as DropRequest;
  assert.equal(req.dest.name, 'src');
  assert.deepEqual(req.items, [{ name: 'shot.png', dir: false, bytes: 900 }]);
  assert.deepEqual(req.listing, ['App.tsx', 'Pane.tsx']);
});

test('pasting inside a terminal or a text field belongs to them, not to the app', async () => {
  const cd = (): FakeDataTransfer => makeDataTransfer({ files: [{ name: 'shot.png', size: 9 }] });
  dispatch(termHost, 'paste', { clipboardData: cd() });
  dispatch(field, 'paste', { clipboardData: cd() });
  await settle(); // part B2: the listing is read before the dialog opens
  assert.deepEqual(world.opened, []);
});

test('a paste with no files on the clipboard is not ours', async () => {
  dispatch(dom.body, 'paste', { clipboardData: makeDataTransfer({ types: ['text/plain'] }) });
  await settle(); // part B2: the listing is read before the dialog opens
  assert.deepEqual(world.opened, []);
});

test('a paste carrying an EMPTY file list opens nothing and stays the page s own', async () => {
  // `clipboardData.files` exists and is empty — a copy that put no file on the
  // clipboard. Opening nothing is half of it; the other half is not calling
  // preventDefault(), or the app would silently swallow every paste that is
  // not its own.
  const e = dispatch(dom.body, 'paste', { clipboardData: makeDataTransfer({ files: [] }) });
  await settle(); // part B2: the listing is read before the dialog opens
  assert.deepEqual(world.opened, []);
  assert.deepEqual(world.flashes, []);
  assert.equal(e.defaultPrevented, false);
});

// ---------------------------------------------------------------------------
// The A9b paste rule, through the DOM (PLAN-A9b §2)
// ---------------------------------------------------------------------------

/**
 * The whole decision space: files on the clipboard × a folder chosen in the
 * Files panel × the event landing in a terminal × in an editable × a modal up.
 * The expectation is written out as the RULE, not as a table of 32 answers, so
 * an implementation that happens to agree with a hand-copied table cannot pass
 * — and the four sentences of the rule are each named in the message.
 *
 * Driven through the real window listener on real elements, so the target
 * tests (`isTerminalTarget`, `isEditableTarget`) are exercised too: a focused
 * terminal pastes on xterm's helper TEXTAREA, which is both at once.
 */
test('the paste matrix: files x selection x terminal x editable x modal, all 32 of them', async () => {
  let taken = 0;
  for (let bits = 0; bits < 32; bits += 1) {
    const files = (bits & 1) !== 0;
    const selected = (bits & 2) !== 0;
    const inTerminal = (bits & 4) !== 0;
    const inEditable = (bits & 8) !== 0;
    const modal = (bits & 16) !== 0;

    world.opened = [];
    world.xtermPastes = 0;
    world.selectedDest = selected ? dest('src') : null;
    scrim.hidden = !modal;
    // A terminal AND an editable is xterm's helper textarea — the real shape
    // of a plain ctrl+v in a focused terminal.
    const target = inTerminal
      ? inTerminal && inEditable
        ? termTextarea
        : termHost
      : inEditable
        ? field
        : dom.body;
    const cd = files
      ? makeDataTransfer({ files: [{ name: 'shot.png', size: 9 }] })
      : makeDataTransfer({ types: ['text/plain'] });

    const e = dispatch(target, 'paste', { clipboardData: cd });
    const expected = files && !modal && ((!inTerminal && !inEditable) || selected);
    const where = `files=${files} selected=${selected} terminal=${inTerminal} editable=${inEditable} modal=${modal}`;
    await settle(); // part B2: the listing is read before the dialog opens
    assert.equal(world.opened.length, expected ? 1 : 0, `dialog: ${where}`);
    assert.equal(e.defaultPrevented, expected, `preventDefault: ${where}`);
    // An event the app did NOT take must still be the page's own, whole: it
    // may not be stopped either, or a field would silently lose its paste.
    assert.equal(e.cancelBubble, expected, `stopPropagation: ${where}`);
    if (expected) taken += 1;
  }
  scrim.hidden = true;
  // 5 of 32: files and no modal narrows it to 8, and of those the app takes
  // the four with a chosen folder plus the one landing in neither a terminal
  // nor an editable (the A9 rule).
  assert.equal(taken, 5, 'non-vacuity: the rule takes 5 of the 32 combinations');
});

test('a TEXT-only paste in a focused terminal is never ours, chosen folder or not', async () => {
  // The sentence the PTY depends on: files carry no text, so the app can take
  // a file paste from a terminal for free — but a text paste is the terminal's
  // whatever else is true, or a login code would vanish into a dialog.
  for (const sel of [null, dest('src')]) {
    world.selectedDest = sel;
    const e = dispatch(termTextarea, 'paste', {
      clipboardData: makeDataTransfer({ types: ['text/plain'] }),
    });
    await settle(); // part B2: the listing is read before the dialog opens
    assert.deepEqual(world.opened, [], `selection ${String(sel)}`);
    assert.equal(e.defaultPrevented, false, 'the terminal keeps its own paste');
    assert.equal(e.cancelBubble, false, 'and xterm still hears it');
  }
  assert.equal(world.xtermPastes, 2, 'non-vacuity: xterm s own handler really did run both times');
});

test('a paste TAKEN inside a terminal is stopped, so xterm s textarea handler never runs', async () => {
  // preventDefault() alone is not enough: xterm s own `paste` handler would
  // still fire and type any `text/plain` the Explorer clipboard carries beside
  // its files into the PTY, unbracketed — the accident A9 decision 5 exists to
  // prevent. Measured: deleting the stopPropagation() call leaves every other
  // assertion in this file green.
  world.selectedDest = dest('src');
  const e = dispatch(termTextarea, 'paste', {
    clipboardData: makeDataTransfer({ files: [{ name: 'shot.png', size: 9 }] }),
  });
  await settle(); // part B2: the listing is read before the dialog opens
  assert.equal(world.opened.length, 1, 'non-vacuity: the app really took this one');
  assert.equal(e.defaultPrevented, true);
  assert.equal(e.cancelBubble, true);
  assert.equal(world.xtermPastes, 0, 'xterm must not see a paste the app took');
});

test('a taken paste copies into the CHOSEN folder, by name, and gives the keyboard back to it', async () => {
  world.selectedDest = dest('src');
  // The selection is what `pasteDestination()` answers first (ui/files.ts);
  // here it is injected, as every dep in this file is.
  world.pasteDest = dest('src');
  termTextarea.focus();
  dispatch(termTextarea, 'paste', {
    clipboardData: makeDataTransfer({ files: [{ name: 'shot.png', size: 900 }] }),
  });
  await settle(); // part B2: the listing is read before the dialog opens
  assert.equal(world.opened.length, 1);
  const req = world.opened[0] as DropRequest;
  assert.equal(req.dest.name, 'src', 'a NAME, never a path');
  assert.deepEqual(req.items, [{ name: 'shot.png', dir: false, bytes: 900 }]);
  assert.deepEqual(req.listing, ['App.tsx', 'Pane.tsx']);
  // `document.activeElement` at paste time: the dialog hands the keyboard back
  // to it, so the terminal is typing again the moment the card closes. The
  // module must not move the focus itself — there would be nothing to undo.
  assert.equal(req.returnFocus, termTextarea);
  assert.equal(dom.doc.activeElement, termTextarea, 'the paste moved no focus');
  dom.doc.activeElement = dom.body;
});

test('a chosen folder does NOT hand a paste to the app while a modal is up', async () => {
  world.selectedDest = dest('src');
  scrim.hidden = false;
  const e = dispatch(termTextarea, 'paste', {
    clipboardData: makeDataTransfer({ files: [{ name: 'shot.png', size: 9 }] }),
  });
  scrim.hidden = true;
  await settle(); // part B2: the listing is read before the dialog opens
  assert.deepEqual(world.opened, [], 'a modal up means nothing in the window takes a paste');
  assert.equal(e.defaultPrevented, false);
});

test('the header button opens the picker and hands what was chosen to the dialog', async () => {
  world.picked = [{ name: 'one.png', size: 10 }, { name: 'two.png', size: 20 }];
  FD.openCopyFilesPicker();
  await settle(); // part B2: the listing is read before the dialog opens
  assert.equal(world.opened.length, 1);
  const req = world.opened[0] as DropRequest;
  assert.equal(req.dest.name, 'src');
  assert.deepEqual(req.items, [
    { name: 'one.png', dir: false, bytes: 10 },
    { name: 'two.png', dir: false, bytes: 20 },
  ]);
});

test('a picker the user cancelled opens no dialog', async () => {
  world.picked = [];
  FD.openCopyFilesPicker();
  await settle(); // part B2: the listing is read before the dialog opens
  assert.deepEqual(world.opened, []);
  assert.deepEqual(world.flashes, []);
});

test('the button title and the ghost name the destination the same way', () => {
  assert.equal(FD.copyIntoText('src'), 'Copy files into src');
});
