/**
 * `web/src/ui/filedrop.ts` — files and folders dragged in from Windows
 * Explorer (Nocturne part A9), driven through the REAL module on the DOM
 * double in `tests/helpers/fake-dom.ts`; the hit-testable shell is
 * `tests/helpers/ui-filedrop-fixture.ts`.
 *
 * WHY THIS FILE EXISTS. Everything this layer does is invisible until it is
 * wrong, and every way it can be wrong is silent: a `dragover` that forgets
 * `preventDefault()` fires no `drop` at all and navigates the whole app away
 * to the dropped file; a `dropEffect` left at `'none'` shows the OS no-drop
 * cursor over a perfectly good folder; a highlight that changes layout resizes
 * every PTY mid-drag; a drop that reaches the pane of a session without a
 * project would have to invent a folder name. So the parts that can be checked
 * without a browser are checked here:
 *
 *   1. target resolution in PLAN-A9 §2's order — folder row, panel, pane,
 *      empty state, nothing — and what each one lights up;
 *   2. the two refusals that are decisions, not capacity: a session without a
 *      project (user decision 4) and a non-`Files` drag over a terminal
 *      (user decision 5, the unbracketed-paste protection);
 *   3. that the dialog is opened ONCE, with top-level names, folder-ness,
 *      sizes and the destination's listing;
 *   4. the three endings (drop, leaving the window, the watchdog) and
 *      that each one leaves nothing behind;
 *   5. the channel separation — no VISUALS while an in-app pointer drag is in
 *      flight (the cancellation stays).
 *
 * Elsewhere: the walk and the drop-level limits (B10) in
 * `tests/ui/ui-filedrop-walk.test.ts`; the paste and picker twins and the
 * A9b paste rule in `tests/ui/ui-filedrop-paste.test.ts`; the boot guard and
 * the shell/CSS wiring read from source in `tests/ui/ui-filedrop-wiring.test.ts`.
 *
 * The DIALOG is injected (`openDialog`), so nothing here imports
 * `ui/drop-dialog.ts`; the pure rules it shares (`hasFiles`, `destLine`,
 * `tooMany`) are pinned in `tests/ui/ui-drop-model.test.ts`.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`): real
 * hit-testing, that an outline really changes no layout, the OS drag cursor,
 * that Chromium fires these events in this order, and that a real Explorer
 * drag carries what `makeDataTransfer` says it does.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { byClass, dispatch, makeDataTransfer, type FakeFile } from '../helpers/fake-dom.ts';
import {
  dom,
  FD,
  DND,
  type Dest,
  type DropRequest,
  dest,
  settle,
  panel,
  rowWeb,
  rowSrc,
  rowGdir,
  rowGfile,
  filesAside,
  pane0,
  pane1,
  termHost,
  termTextarea,
  empty,
  scrim,
  field,
  LISTINGS,
  type FileLikeIn,
  OVER_ROW,
  OVER_GDIR,
  OVER_GFILE,
  OVER_PANEL,
  OVER_PANE,
  OVER_TERM,
  OVER_EMPTY,
  OVER_NOTHING,
  dragOver,
  drop,
  ghost,
  litClasses,
  paneBox,
  flushTimers,
  FILES_DT,
  TEXT_DT,
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
// Targets and their visuals
// ===========================================================================

test('over a folder row: that row lights up, dropEffect is copy, and the drop is allowed', () => {
  const dt = FILES_DT();
  const { prevented } = dragOver(OVER_ROW, dt);
  assert.equal(prevented, true, 'without preventDefault no drop event ever fires');
  assert.equal(dt.dropEffect, 'copy');
  assert.equal(rowSrc.classList.contains('is-drop'), true);
  assert.equal(rowWeb.classList.contains('is-drop'), false, 'only the row under the pointer');
  // The row's OWN name, never its path (`fdir:web/src`).
  assert.equal(ghost()?.textContent, 'Copy 2 items into src');
  assert.equal(ghost()?.classList.contains('is-invalid'), false);
  assert.equal(dom.body.classList.contains('is-filedrag'), true);
});

test('over the panel but not on a row: the panel takes it, named by its own root', () => {
  const dt = FILES_DT();
  dragOver(OVER_PANEL, dt);
  assert.equal(dt.dropEffect, 'copy');
  assert.equal(panel.classList.contains('is-drop'), true);
  assert.equal(ghost()?.textContent, 'Copy 2 items into nocturne');
});

test('over blank chrome: nothing lights up, dropEffect is none, and the drag is still prevented', () => {
  const dt = FILES_DT();
  const { prevented } = dragOver(OVER_NOTHING, dt);
  // Prevented even here: a drop the browser handles itself navigates the page.
  assert.equal(prevented, true);
  assert.equal(dt.dropEffect, 'none');
  assert.deepEqual(litClasses(), []);
  assert.equal(paneBox(pane0).hidden, true);
  assert.equal(ghost()?.textContent, 'Drop on a folder or a pane.');
  assert.equal(ghost()?.classList.contains('is-invalid'), true);
});

test('over a pane: the pane-drop overlay shows, with no zone and the copy label', () => {
  const dt = FILES_DT();
  dragOver(OVER_PANE, dt);
  const box = paneBox(pane0);
  assert.equal(box.hidden, false);
  assert.equal(box.dataset.zone, undefined, 'an external drop never splits a pane');
  assert.equal(byClass(box, 'pane-drop-lb')[0]?.textContent, 'Copy into Home');
  assert.equal(dt.dropEffect, 'copy');
});

test('over a pane whose session has no project: invalid, and the drop says why', async () => {
  paneDest = null;
  const dt = FILES_DT();
  dragOver(OVER_PANE, dt);
  assert.equal(dt.dropEffect, 'none');
  assert.equal(paneBox(pane0).hidden, true);
  assert.equal(ghost()?.classList.contains('is-invalid'), true);

  drop(OVER_PANE, FILES_DT());
  await settle(); // part B2: the listing is read before the dialog opens
  assert.deepEqual(opened, [], 'nothing may be copied into a folder we cannot name');
  assert.deepEqual(flashes, ['This session has no project folder yet.']);
});

test('over a FILE pane in a tab with no folder at all: the refusal says tab, not session', async () => {
  // `destinationOfPane` answers WHY it has no name (part A9 F6): a file or a
  // diff pane in a plain session tab has no session of its own to talk about,
  // so the sentence may not blame one.
  paneDest = null;
  paneWhy = 'tab';
  const dt = FILES_DT();
  dragOver(OVER_PANE, dt);
  assert.equal(dt.dropEffect, 'none');
  assert.equal(paneBox(pane0).hidden, true);

  drop(OVER_PANE, FILES_DT());
  await settle(); // part B2: the listing is read before the dialog opens
  assert.deepEqual(opened, []);
  assert.deepEqual(flashes, ['This tab has no project folder yet.']);
});

test('a FILES drag over the terminal inside a pane resolves to that pane, and its drop lands', async () => {
  // The one miss that would navigate the app away: xterm's helper textarea is
  // the deepest element under the pointer, and an un-cancelled file drop on it
  // opens the file as the page.
  const dt = FILES_DT();
  const { prevented } = dragOver(OVER_TERM, dt, termHost);
  assert.equal(prevented, true);
  assert.equal(dt.dropEffect, 'copy');
  const box = paneBox(pane1);
  assert.equal(box.hidden, false, 'the pane under the terminal is the target');
  assert.equal(byClass(box, 'pane-drop-lb')[0]?.textContent, 'Copy into Home');
  assert.equal(paneBox(pane0).hidden, true);

  const dropped = drop(OVER_TERM, FILES_DT(), termHost);
  assert.equal(dropped.prevented, true);
  await settle(); // part B2: the listing is read before the dialog opens
  assert.equal(opened.length, 1, 'the dialog opens instead of the file');
  assert.equal((opened[0] as DropRequest).dest.name, 'Home');
  assert.equal(paneBox(pane1).hidden, true, 'and the overlay goes with the drop');
});

test('over the empty pane area: the active tab s root takes it', () => {
  const dt = FILES_DT();
  dragOver(OVER_EMPTY, dt);
  assert.equal(empty.classList.contains('is-drop'), true);
  assert.equal(ghost()?.textContent, 'Copy 2 items into Home');
});

test('a modal is up: every target is invalid', async () => {
  scrim.hidden = false;
  const dt = FILES_DT();
  dragOver(OVER_ROW, dt);
  assert.equal(dt.dropEffect, 'none');
  assert.deepEqual(litClasses(), []);

  drop(OVER_ROW, FILES_DT());
  await settle(); // part B2: the listing is read before the dialog opens
  assert.deepEqual(opened, []);
});

test('the Files panel hidden behind the Projects drawer is no target at all', async () => {
  // Only ONE left panel is up at a time (user decision 2026-09-15): opening the
  // Projects drawer hides the Files aside without touching the wish, so the
  // panel keeps its rows, and `filesPanelDestination()` still answers a name.
  // Nothing but the hit test can refuse this drop, and it must.
  dragOver(OVER_ROW, FILES_DT());
  assert.equal(rowSrc.classList.contains('is-drop'), true, 'non-vacuity: on screen that row IS a target');
  dispatch(rowSrc, 'dragleave', { clientX: 0, clientY: 0, relatedTarget: null });

  filesAside.hidden = true;
  const dt = FILES_DT();
  const { prevented } = dragOver(OVER_ROW, dt);
  // Still prevented: a file drop the browser keeps navigates the app away,
  // whether or not anything here could take it.
  assert.equal(prevented, true);
  assert.equal(dt.dropEffect, 'none');
  assert.deepEqual(litClasses(), [], 'a row nobody can see may not light up');
  assert.equal(ghost()?.textContent, 'Drop on a folder or a pane.');

  drop(OVER_ROW, FILES_DT());
  await settle(); // part B2: the listing is read before the dialog opens
  assert.deepEqual(opened, [], 'a panel that is off screen resolves no destination');
  assert.deepEqual(flashes, [], 'and there is nothing to say about a drop on nothing');
});

test('moving between targets clears the previous one', () => {
  dragOver(OVER_ROW, FILES_DT());
  dragOver(OVER_PANE, FILES_DT());
  assert.equal(rowSrc.classList.contains('is-drop'), false);
  assert.equal(paneBox(pane0).hidden, false);
  dragOver(OVER_ROW, FILES_DT());
  assert.equal(paneBox(pane0).hidden, true);
  assert.equal(rowSrc.classList.contains('is-drop'), true);
});

// ===========================================================================
// Non-`Files` drags (user decision 5)
// ===========================================================================

test('a text drag over a terminal is cancelled, with no visuals at all', async () => {
  const dt = TEXT_DT();
  // The browser arrives with an effect of its own; `preventDefault()` alone
  // leaves it there and the OS keeps showing the copy cursor over a drop this
  // app refuses outright.
  dt.dropEffect = 'copy';
  const { prevented } = dragOver(OVER_TERM, dt, termHost);
  // Preventing the default is what takes the drop AWAY from xterm's helper
  // textarea, which would otherwise type it straight into the PTY.
  assert.equal(prevented, true);
  assert.equal(dt.dropEffect, 'none', 'the cursor has to say no, like every other invalid target');
  assert.equal(ghost(), undefined, 'no ghost: this is a refusal, not a drop target');
  assert.equal(dom.body.classList.contains('is-filedrag'), false);
  assert.deepEqual(litClasses(), []);

  const dropped = drop(OVER_TERM, TEXT_DT(), termHost);
  assert.equal(dropped.prevented, true);
  await settle(); // part B2: the listing is read before the dialog opens
  assert.deepEqual(opened, []);
});

test('a text drag anywhere else is left completely alone', () => {
  const { prevented } = dragOver(OVER_PANEL, TEXT_DT());
  assert.equal(prevented, false, 'dragging text into a field is the browser s business');
  assert.equal(ghost(), undefined);
  assert.deepEqual(litClasses(), []);
});

// ===========================================================================
// The drop itself
// ===========================================================================

test('a drop hands the dialog the destination, the top-level items and the listing', async () => {
  const dt = makeDataTransfer({
    items: [
      { name: 'report.md', size: 120 },
      { name: 'assets', dir: true },
      { name: 'notes.txt', size: 4096 },
    ],
  });
  dragOver(OVER_ROW, makeDataTransfer({ items: [{ name: 'x' }], blind: true }));
  const { prevented } = drop(OVER_ROW, dt);

  assert.equal(prevented, true);
  await settle(); // part B2: the listing is read before the dialog opens
  assert.equal(opened.length, 1, 'exactly one dialog per drop');
  const req = opened[0] as DropRequest;
  assert.equal(req.dest.name, 'src');
  assert.deepEqual(req.items, [
    { name: 'report.md', dir: false, bytes: 120 },
    // A folder's size is a recursive walk (B10), so it carries none.
    { name: 'assets', dir: true, bytes: null },
    { name: 'notes.txt', dir: false, bytes: 4096 },
  ]);
  assert.deepEqual(req.listing, ['App.tsx', 'Pane.tsx']);
  // The visuals are gone the moment the drop is taken.
  assert.deepEqual(litClasses(), []);
  assert.equal(ghost(), undefined);
  assert.equal(dom.body.classList.contains('is-filedrag'), false);
});

test('a drop hands over the folder row that had the keyboard, so it can get it back', async () => {
  // The dialog focuses whatever it is handed when it closes
  // (`tests/ui/ui-a9-drop-dialog.test.ts`): a drop that hands over nothing drops
  // the keyboard on <body> behind an aria-modal scrim.
  rowSrc.focus();
  drop(OVER_ROW, FILES_DT());
  await settle(); // part B2: the listing is read before the dialog opens
  assert.equal(opened.length, 1);
  assert.equal((opened[0] as DropRequest).returnFocus, rowSrc);
});

test('the dialog gets the element the drop came FROM, not the one focused a round trip later', async () => {
  // Part B2 made `offer()` async: the conflict listing is a real request now.
  // The element that gets the keyboard back is captured BEFORE that await —
  // focus moves for reasons of its own while a request travels (a pane
  // closing, a toast, the user tabbing), and a dialog that handed the keyboard
  // to whatever held it a round trip later would hand it to a stranger.
  deferListing = true;
  rowSrc.focus();
  drop(OVER_ROW, FILES_DT());
  await settle();
  assert.deepEqual(opened, [], 'non-vacuity: the dialog really is waiting for the listing');

  field.focus();
  assert.equal(dom.doc.activeElement, field, 'non-vacuity: the keyboard really moved meanwhile');
  (releaseListing as () => void)();
  await settle();
  assert.equal(opened.length, 1);
  assert.equal((opened[0] as DropRequest).returnFocus, rowSrc, 'the row the drop came from');
  assert.deepEqual(
    (opened[0] as DropRequest).listing,
    ['App.tsx', 'Pane.tsx'],
    'and the listing it waited for, not the empty one it started with',
  );
  dom.doc.activeElement = dom.body;
});

test('a Changes-tab row is no folder to copy into: the panel s own root takes that drop', async () => {
  // Those rows carry a REPO-RELATIVE path (`gdir:web/src`), which is not a
  // place anything can be posted to. They may not become a silent dead zone in
  // the middle of the panel either, so the panel's own root answers for them —
  // exactly as the blank space beside them does.
  const dt = FILES_DT();
  dragOver(OVER_GDIR, dt);
  assert.equal(dt.dropEffect, 'copy', 'the drop is allowed, it just lands elsewhere');
  assert.equal(rowGdir.classList.contains('is-drop'), false, 'the row is not the target');
  assert.equal(panel.classList.contains('is-drop'), true);
  assert.equal(ghost()?.textContent, 'Copy 2 items into nocturne', 'never `src`');
  drop(OVER_GDIR, dt);
  await settle();
  assert.equal(opened.length, 1);
  assert.deepEqual((opened[0] as DropRequest).dest, panelDest);

  // A changed FILE row is not a target of its own either, for the same reason.
  opened = [];
  const dt2 = FILES_DT();
  dragOver(OVER_GFILE, dt2);
  assert.equal(rowGfile.classList.contains('is-drop'), false);
  assert.equal(ghost()?.textContent, 'Copy 2 items into nocturne');
  drop(OVER_GFILE, dt2);
  await settle();
  assert.deepEqual((opened[0] as DropRequest).dest, panelDest);
});

test('a drop over nothing opens nothing and says nothing', async () => {
  drop(OVER_NOTHING, FILES_DT());
  await settle(); // part B2: the listing is read before the dialog opens
  assert.deepEqual(opened, []);
  assert.deepEqual(flashes, []);
});

test('more than 200 items is refused with one sentence, before any dialog', async () => {
  const many = Array.from({ length: 201 }, (_, i) => ({ name: `f${i}.txt`, size: 1 }));
  drop(OVER_ROW, makeDataTransfer({ items: many }));
  assert.deepEqual(flashes, ['Too many items. Drop up to 200 at a time.']);
  await settle(); // part B2: the listing is read before the dialog opens
  assert.deepEqual(opened, []);
});

test('exactly 200 items still lands', async () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ name: `f${i}.txt`, size: 1 }));
  drop(OVER_ROW, makeDataTransfer({ items: many }));
  assert.deepEqual(flashes, []);
  await settle(); // part B2: the listing is read before the dialog opens
  assert.equal(opened.length, 1);
  assert.equal((opened[0] as DropRequest).items.length, 200);
});

// ===========================================================================
// Endings
// ===========================================================================

test('leaving the window clears the visuals; a crossing inside it does not', () => {
  dragOver(OVER_ROW, FILES_DT());
  // relatedTarget names an element: the pointer moved between two nodes.
  dispatch(rowSrc, 'dragleave', { ...OVER_ROW, relatedTarget: panel });
  assert.equal(rowSrc.classList.contains('is-drop'), true, 'still inside the window');

  dispatch(rowSrc, 'dragleave', { clientX: 0, clientY: 0, relatedTarget: null });
  assert.deepEqual(litClasses(), []);
  assert.equal(ghost(), undefined);
});

test('a drag that leaves the viewport clears the overlay, the ghost and the watchdog', () => {
  dragOver(OVER_PANE, FILES_DT());
  assert.equal(paneBox(pane0).hidden, false, 'non-vacuity: something is lit to clear');
  assert.equal(dom.win.timers.length, 1, 'non-vacuity: the watchdog is armed');

  // No relatedTarget, but the pointer is still inside the window: Chromium
  // fires this crossing into a child, and it ends nothing.
  dispatch(pane0, 'dragleave', { clientX: 700, clientY: 200, relatedTarget: null });
  assert.equal(paneBox(pane0).hidden, false, 'a leave inside the viewport is not an ending');
  assert.notEqual(ghost(), undefined);

  // The real one: out through the right edge of the window.
  dispatch(pane0, 'dragleave', { clientX: dom.win.innerWidth, clientY: 200, relatedTarget: null });
  assert.equal(paneBox(pane0).hidden, true);
  assert.deepEqual(litClasses(), []);
  assert.equal(ghost(), undefined);
  assert.equal(dom.body.classList.contains('is-filedrag'), false);
  assert.deepEqual(dom.win.timers, [], 'the watchdog goes with the drag it was watching');
});

test('the watchdog clears a drag the page stopped hearing about', () => {
  dragOver(OVER_ROW, FILES_DT());
  assert.equal(rowSrc.classList.contains('is-drop'), true);
  // 700 ms, not 300: the HTML DnD model re-fires `dragover` only every ~350 ms
  // while the pointer stands still, so a shorter watchdog blinks the visuals
  // off on every pause.
  assert.equal(dom.win.timers.at(-1)?.ms, 700, 'stamped by dragover, not by a clock');
  flushTimers();
  assert.deepEqual(litClasses(), []);
  assert.equal(ghost(), undefined);
  assert.equal(dom.body.classList.contains('is-filedrag'), false);
});

// ===========================================================================
// The two channels never meet
// ===========================================================================

test('an in-app pointer drag owns the visuals; the cancellation stays the window s', async () => {
  const source = dom.doc.createElement('button');
  dom.body.append(source);
  DND.armDrag(source, null, () => ({ kind: 'file', path: 'web/src/App.tsx', label: 'App.tsx' }));
  dispatch(source, 'pointerdown', { clientX: 10, clientY: 10, pointerId: 77 });

  const dt = FILES_DT();
  const { prevented } = dragOver(OVER_ROW, dt);
  // The VISUALS are the in-app drag's alone; the cancellation is not. An armed
  // pointer drag is only cleared by a matching pointerup, so a button released
  // outside the window leaves `isDragging()` true for good — and a file
  // dropped after that would navigate the whole app away.
  assert.equal(prevented, true, 'a Files drag is prevented whatever else is in flight');
  assert.equal(dt.dropEffect, 'none', 'and it is refused, not taken');
  assert.equal(ghost(), undefined);
  assert.deepEqual(litClasses(), []);

  const dropped = drop(OVER_ROW, FILES_DT());
  assert.equal(dropped.prevented, true, 'the drop the browser would navigate to is taken away from it');
  await settle(); // part B2: the listing is read before the dialog opens
  assert.deepEqual(opened, []);

  dispatch(dom.body, 'pointerup', { clientX: 10, clientY: 10, pointerId: 77 });
  source.remove();
});
