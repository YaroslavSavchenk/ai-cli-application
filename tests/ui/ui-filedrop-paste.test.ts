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
import {
  dispatch,
  makeDataTransfer,
  type FakeDataTransfer,
  type FakeFile,
} from '../helpers/fake-dom.ts';
import {
  dom,
  FD,
  type Dest,
  type DropRequest,
  dest,
  settle,
  filesAside,
  termHost,
  termTextarea,
  scrim,
  field,
  LISTINGS,
  type FileLikeIn,
} from '../helpers/ui-filedrop-fixture.ts';

// ---------------------------------------------------------------------------
// The injected deps — per file: the tests below reassign these `let`s, which
// an imported binding cannot be, so the state and its DEPS live here while
// the shell they act on is `tests/helpers/ui-filedrop-fixture.ts`.
// ---------------------------------------------------------------------------

let opened: DropRequest[] = [];
let flashes: string[] = [];
let paneDest: Dest | null = dest('Home');
/** Which refusal `destinationOfPane` reports when it names no folder (A9 F6). */
let paneWhy: 'session' | 'tab' = 'session';
let panelDest: Dest | null = dest('nocturne');
let viewDest: Dest | null = dest('Home');
let pasteDest: Dest | null = dest('src');
/** A9b: the folder the user CHOSE in the panel, or nothing chosen. */
let selectedDest: Dest | null = null;
let picked: FakeFile[] = [];

/**
 * Part B2: the listing is a real request, so a test can hold it and let the
 * world move while it travels — which is the only way to see WHEN `offer()`
 * reads the focus. Off by default: every other test answers at once.
 */
let deferListing = false;
let releaseListing: (() => void) | null = null;
/**
 * How many listing REQUESTS were made (part B10). The drop-level refusals must
 * answer without one: a drop that is refused whole may not cost a round trip,
 * and a counter is the only way to see a request that was never made.
 */
let listingCalls = 0;
/**
 * Part B10 fix round: the drop dialog answers whether a copy is still writing
 * (`isDropRunning`), and a second drop while it is must be refused before it
 * is walked — two runs would race the panel refresh that follows a drop.
 */
let copyRunning = false;

/**
 * xterm's own `paste` handler on its helper textarea (the fixture's
 * `termTextarea`). `xtermPastes` counts it: the app taking a paste here
 * without stopping the event would let xterm type any `text/plain` beside
 * the files into the PTY unbracketed (PLAN-A9b §2).
 */
let xtermPastes = 0;
termTextarea.addEventListener('paste', () => {
  xtermPastes += 1;
});

const DEPS = {
  openDialog: (req: DropRequest) => opened.push(req),
  // Part B2: a PROMISE, and keyed by the destination's name here only because
  // this file's fakes are named that way — the module passes the whole
  // destination through and reads nothing but what the dep answers.
  listingFor: (d: Dest) => {
    listingCalls += 1;
    const answer = LISTINGS[d.name] ?? [];
    if (!deferListing) return Promise.resolve(answer);
    return new Promise<readonly string[]>((resolve) => {
      releaseListing = () => resolve(answer);
    });
  },
  destinationOfPane: () => (paneDest === null ? { dest: null, why: paneWhy } : { dest: paneDest }),
  destinationOfActiveView: () => viewDest,
  filesPanelDestination: () => panelDest,
  pasteDestination: () => pasteDest,
  selectedFolder: () => selectedDest,
  copyRunning: () => copyRunning,
  openPicker: (take: (files: readonly FileLikeIn[]) => void) => take(picked),
  flash: (m: string) => flashes.push(m),
};

FD.initFileDrop(DEPS);

beforeEach(() => {
  opened = [];
  flashes = [];
  paneDest = dest('Home');
  paneWhy = 'session';
  panelDest = dest('nocturne');
  viewDest = dest('Home');
  pasteDest = dest('src');
  selectedDest = null;
  xtermPastes = 0;
  picked = [];
  deferListing = false;
  releaseListing = null;
  listingCalls = 0;
  copyRunning = false;
  scrim.hidden = true;
  filesAside.hidden = false;
  dom.win.timers.length = 0;
  // Every test starts with no drag on screen (the previous one may have ended
  // on a drop, which clears, or on nothing).
  dispatch(dom.body, 'dragleave', { clientX: 0, clientY: 0, relatedTarget: null });
  dom.doc.activeElement = dom.body;
});

// ===========================================================================
// The twins
// ===========================================================================

test('pasting files opens the dialog on the paste destination', async () => {
  dispatch(dom.body, 'paste', {
    clipboardData: makeDataTransfer({ files: [{ name: 'shot.png', size: 900 }] }),
  });
  await settle(); // part B2: the listing is read before the dialog opens
  assert.equal(opened.length, 1);
  const req = opened[0] as DropRequest;
  assert.equal(req.dest.name, 'src');
  assert.deepEqual(req.items, [{ name: 'shot.png', dir: false, bytes: 900 }]);
  assert.deepEqual(req.listing, ['App.tsx', 'Pane.tsx']);
});

test('pasting inside a terminal or a text field belongs to them, not to the app', async () => {
  const cd = (): FakeDataTransfer => makeDataTransfer({ files: [{ name: 'shot.png', size: 9 }] });
  dispatch(termHost, 'paste', { clipboardData: cd() });
  dispatch(field, 'paste', { clipboardData: cd() });
  await settle(); // part B2: the listing is read before the dialog opens
  assert.deepEqual(opened, []);
});

test('a paste with no files on the clipboard is not ours', async () => {
  dispatch(dom.body, 'paste', { clipboardData: makeDataTransfer({ types: ['text/plain'] }) });
  await settle(); // part B2: the listing is read before the dialog opens
  assert.deepEqual(opened, []);
});

test('a paste carrying an EMPTY file list opens nothing and stays the page s own', async () => {
  // `clipboardData.files` exists and is empty — a copy that put no file on the
  // clipboard. Opening nothing is half of it; the other half is not calling
  // preventDefault(), or the app would silently swallow every paste that is
  // not its own.
  const e = dispatch(dom.body, 'paste', { clipboardData: makeDataTransfer({ files: [] }) });
  await settle(); // part B2: the listing is read before the dialog opens
  assert.deepEqual(opened, []);
  assert.deepEqual(flashes, []);
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

    opened = [];
    xtermPastes = 0;
    selectedDest = selected ? dest('src') : null;
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
    assert.equal(opened.length, expected ? 1 : 0, `dialog: ${where}`);
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
    selectedDest = sel;
    const e = dispatch(termTextarea, 'paste', {
      clipboardData: makeDataTransfer({ types: ['text/plain'] }),
    });
    await settle(); // part B2: the listing is read before the dialog opens
    assert.deepEqual(opened, [], `selection ${String(sel)}`);
    assert.equal(e.defaultPrevented, false, 'the terminal keeps its own paste');
    assert.equal(e.cancelBubble, false, 'and xterm still hears it');
  }
  assert.equal(xtermPastes, 2, 'non-vacuity: xterm s own handler really did run both times');
});

test('a paste TAKEN inside a terminal is stopped, so xterm s textarea handler never runs', async () => {
  // preventDefault() alone is not enough: xterm s own `paste` handler would
  // still fire and type any `text/plain` the Explorer clipboard carries beside
  // its files into the PTY, unbracketed — the accident A9 decision 5 exists to
  // prevent. Measured: deleting the stopPropagation() call leaves every other
  // assertion in this file green.
  selectedDest = dest('src');
  const e = dispatch(termTextarea, 'paste', {
    clipboardData: makeDataTransfer({ files: [{ name: 'shot.png', size: 9 }] }),
  });
  await settle(); // part B2: the listing is read before the dialog opens
  assert.equal(opened.length, 1, 'non-vacuity: the app really took this one');
  assert.equal(e.defaultPrevented, true);
  assert.equal(e.cancelBubble, true);
  assert.equal(xtermPastes, 0, 'xterm must not see a paste the app took');
});

test('a taken paste copies into the CHOSEN folder, by name, and gives the keyboard back to it', async () => {
  selectedDest = dest('src');
  // The selection is what `pasteDestination()` answers first (ui/files.ts);
  // here it is injected, as every dep in this file is.
  pasteDest = dest('src');
  termTextarea.focus();
  dispatch(termTextarea, 'paste', {
    clipboardData: makeDataTransfer({ files: [{ name: 'shot.png', size: 900 }] }),
  });
  await settle(); // part B2: the listing is read before the dialog opens
  assert.equal(opened.length, 1);
  const req = opened[0] as DropRequest;
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
  selectedDest = dest('src');
  scrim.hidden = false;
  const e = dispatch(termTextarea, 'paste', {
    clipboardData: makeDataTransfer({ files: [{ name: 'shot.png', size: 9 }] }),
  });
  scrim.hidden = true;
  await settle(); // part B2: the listing is read before the dialog opens
  assert.deepEqual(opened, [], 'a modal up means nothing in the window takes a paste');
  assert.equal(e.defaultPrevented, false);
});

test('the header button opens the picker and hands what was chosen to the dialog', async () => {
  picked = [{ name: 'one.png', size: 10 }, { name: 'two.png', size: 20 }];
  FD.openCopyFilesPicker();
  await settle(); // part B2: the listing is read before the dialog opens
  assert.equal(opened.length, 1);
  const req = opened[0] as DropRequest;
  assert.equal(req.dest.name, 'src');
  assert.deepEqual(req.items, [
    { name: 'one.png', dir: false, bytes: 10 },
    { name: 'two.png', dir: false, bytes: 20 },
  ]);
});

test('a picker the user cancelled opens no dialog', async () => {
  picked = [];
  FD.openCopyFilesPicker();
  await settle(); // part B2: the listing is read before the dialog opens
  assert.deepEqual(opened, []);
  assert.deepEqual(flashes, []);
});

test('the button title and the ghost name the destination the same way', () => {
  assert.equal(FD.copyIntoText('src'), 'Copy files into src');
});
