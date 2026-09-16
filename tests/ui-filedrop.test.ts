/**
 * `web/src/ui/filedrop.ts` — files and folders dragged in from Windows
 * Explorer (Nocturne part A9), driven through the REAL module on the DOM
 * double in `tests/fake-dom.ts`.
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
 *   5. the two twins: pasting files, and the Files-panel header button through
 *      its injected picker seam;
 *   6. the channel separation — no VISUALS while an in-app pointer drag is in
 *      flight (the cancellation stays), and `web/src` still has no
 *      `draggable` attribute and no `dragstart` listener.
 *
 * The DIALOG is injected (`openDialog`), so nothing here imports
 * `ui/drop-dialog.ts`; the pure rules it shares (`hasFiles`, `destLine`,
 * `tooMany`) are pinned in `tests/ui-drop-model.test.ts`.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`): real
 * hit-testing, that an outline really changes no layout, the OS drag cursor,
 * that Chromium fires these events in this order, and that a real Explorer
 * drag carries what `makeDataTransfer` says it does.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  byClass,
  dispatch,
  installDom,
  makeDataTransfer,
  setRect,
  type FakeDataTransfer,
  type FakeElement,
  type FakeEvent,
  type FakeFile,
} from './fake-dom.ts';
import { APP_CSS, stripComments } from './tokens-helpers.ts';

const dom = installDom();

const here = dirname(fileURLToPath(import.meta.url));
const FD = (await import(new URL('../web/src/ui/filedrop.ts', import.meta.url).href)) as FileDropModule;
const DND = (await import(new URL('../web/src/ui/dnd.ts', import.meta.url).href)) as DndModule;

interface DropItem {
  name: string;
  dir: boolean;
  bytes: number | null;
}
interface DropRequest {
  dest: string;
  items: DropItem[];
  listing: readonly string[];
  returnFocus: unknown;
}
interface FileDropModule {
  initFileDrop(deps: Record<string, unknown>): void;
  installDropGuard(): () => void;
  openCopyFilesPicker(into?: string): void;
  copyIntoText(dest: string): string;
}
interface DndModule {
  armDrag(source: unknown, ignore: string | null, makeSpec: () => unknown): void;
}

// ---------------------------------------------------------------------------
// A shell just real enough to hit-test: the Files panel with two folder rows,
// a grid with two panes (one holding a terminal), an empty state, a scrim.
// ---------------------------------------------------------------------------

function div(cls: string, rect?: { left: number; top: number; width: number; height: number }): FakeElement {
  const n = dom.doc.createElement('div');
  n.className = cls;
  if (rect !== undefined) setRect(n, rect);
  return n;
}

const panel = div('files-view', { left: 0, top: 0, width: 300, height: 800 });
const rowWeb = div('files-row is-dir', { left: 0, top: 100, width: 300, height: 26 });
rowWeb.setAttribute('data-k', 'fdir:web');
const rowSrc = div('files-row is-dir', { left: 0, top: 130, width: 300, height: 26 });
rowSrc.setAttribute('data-k', 'fdir:web/src');
panel.append(rowWeb, rowSrc);
/**
 * The shell's own host for the panel. `main.ts` hides THIS aside when the
 * Projects drawer takes the left column (`filesAside.hidden = !filesShown`),
 * which is the only way the panel ever leaves the screen — so a test of "the
 * panel is away" hides the host, exactly as the app does.
 */
const filesAside = div('drawer files-panel');
filesAside.append(panel);

const grid = div('grid', { left: 300, top: 0, width: 1000, height: 400 });
/** One pane, with the drop overlay `ui/panes.ts` builds into every card. */
function makePane(slot: number, left: number): FakeElement {
  const pane = div('pane', { left, top: 0, width: 500, height: 400 });
  pane.setAttribute('data-slot', String(slot));
  pane.dataset.slot = String(slot);
  const drop = div('pane-drop');
  drop.hidden = true;
  const box = div('pane-drop-box');
  const lb = div('pane-drop-lb');
  box.append(lb);
  drop.append(box);
  pane.append(drop);
  return pane;
}
const pane0 = makePane(0, 300);
const pane1 = makePane(1, 800);
const termHost = div('term-host', { left: 810, top: 40, width: 480, height: 340 });
/**
 * xterm's own helper textarea, which is where a plain ctrl+v inside a focused
 * terminal really fires its `paste` — so it is BOTH a terminal target and an
 * editable one, and it carries xterm's own `paste` handler. `xtermPastes`
 * counts that handler: the app taking a paste here without stopping the event
 * would let xterm type any `text/plain` beside the files into the PTY
 * unbracketed (PLAN-A9B §2).
 */
const termTextarea = dom.doc.createElement('textarea');
setRect(termTextarea, { left: 810, top: 40, width: 480, height: 340 });
let xtermPastes = 0;
termTextarea.addEventListener('paste', () => {
  xtermPastes += 1;
});
termHost.append(termTextarea);
pane1.append(termHost);
grid.append(pane0, pane1);

const empty = div('empty-state', { left: 300, top: 420, width: 1000, height: 300 });
const scrim = div('modal-scrim');
scrim.hidden = true;
const field = dom.doc.createElement('textarea');
setRect(field, { left: 0, top: 900, width: 100, height: 20 });

dom.body.append(filesAside, grid, empty, scrim, field);

// ---------------------------------------------------------------------------
// The injected deps
// ---------------------------------------------------------------------------

const LISTINGS: Record<string, string[]> = {
  src: ['App.tsx', 'Pane.tsx'],
  Home: ['web', 'server', 'README.md'],
};

let opened: DropRequest[] = [];
let flashes: string[] = [];
let paneDest: string | null = 'Home';
/** Which refusal `destinationOfPane` reports when it names no folder (A9 F6). */
let paneWhy: 'session' | 'tab' = 'session';
let panelDest: string | null = 'nocturne';
let viewDest: string | null = 'Home';
let pasteDest: string | null = 'src';
/** A9b: the folder the user CHOSE in the panel, as a name, or nothing chosen. */
let selectedDest: string | null = null;
let picked: FakeFile[] = [];

const DEPS = {
  openDialog: (req: DropRequest) => opened.push(req),
  listingFor: (dest: string) => LISTINGS[dest] ?? [],
  destinationOfPane: () => (paneDest === null ? { dest: null, why: paneWhy } : { dest: paneDest }),
  destinationOfActiveView: () => viewDest,
  filesPanelDestination: () => panelDest,
  pasteDestination: () => pasteDest,
  selectedFolder: () => selectedDest,
  openPicker: (take: (files: readonly FileLikeIn[]) => void) => take(picked),
  flash: (m: string) => flashes.push(m),
};

FD.initFileDrop(DEPS);

interface FileLikeIn {
  name: string;
  size?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A point over each surface of the shell. */
const OVER_ROW = { clientX: 150, clientY: 140 }; // the `web/src` row
const OVER_PANEL = { clientX: 150, clientY: 400 }; // panel, no row under it
const OVER_PANE = { clientX: 500, clientY: 200 };
const OVER_TERM = { clientX: 1000, clientY: 200 };
const OVER_EMPTY = { clientX: 700, clientY: 500 };
const OVER_NOTHING = { clientX: 1500, clientY: 870 };

function at(p: { clientX: number; clientY: number }): FakeElement {
  return dom.doc.elementFromPoint(p.clientX, p.clientY) ?? dom.body;
}

/** One `dragover`, dispatched on whatever is under the point. */
function dragOver(
  p: { clientX: number; clientY: number },
  dt: FakeDataTransfer,
  on?: FakeElement,
): { prevented: boolean } {
  const e = dispatch(on ?? at(p), 'dragover', { ...p, dataTransfer: dt });
  return { prevented: e.defaultPrevented };
}

function drop(
  p: { clientX: number; clientY: number },
  dt: FakeDataTransfer,
  on?: FakeElement,
): { prevented: boolean } {
  const e = dispatch(on ?? at(p), 'drop', { ...p, dataTransfer: dt });
  return { prevented: e.defaultPrevented };
}

function ghost(): FakeElement | undefined {
  return byClass(dom.body, 'drag-ghost')[0];
}

function litClasses(): string[] {
  return byClass(dom.body, 'is-drop').map((n) => n.className);
}

function paneBox(pane: FakeElement): FakeElement {
  return byClass(pane, 'pane-drop')[0] as FakeElement;
}

/** Fire every armed timer (the watchdog is the only one here). */
function flushTimers(): void {
  const armed = [...dom.win.timers];
  dom.win.timers.length = 0;
  for (const t of armed) t.fn();
}

const FILES_DT = (): FakeDataTransfer =>
  makeDataTransfer({ items: [{ name: 'a.ts', size: 10 }, { name: 'b.ts', size: 20 }] });
const TEXT_DT = (): FakeDataTransfer => makeDataTransfer({ types: ['text/plain'] });

beforeEach(() => {
  opened = [];
  flashes = [];
  paneDest = 'Home';
  paneWhy = 'session';
  panelDest = 'nocturne';
  viewDest = 'Home';
  pasteDest = 'src';
  selectedDest = null;
  xtermPastes = 0;
  picked = [];
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

test('over a pane whose session has no project: invalid, and the drop says why', () => {
  paneDest = null;
  const dt = FILES_DT();
  dragOver(OVER_PANE, dt);
  assert.equal(dt.dropEffect, 'none');
  assert.equal(paneBox(pane0).hidden, true);
  assert.equal(ghost()?.classList.contains('is-invalid'), true);

  drop(OVER_PANE, FILES_DT());
  assert.deepEqual(opened, [], 'nothing may be copied into a folder we cannot name');
  assert.deepEqual(flashes, ['This session has no project folder yet.']);
});

test('over a FILE pane in a tab with no folder at all: the refusal says tab, not session', () => {
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
  assert.deepEqual(opened, []);
  assert.deepEqual(flashes, ['This tab has no project folder yet.']);
});

test('a FILES drag over the terminal inside a pane resolves to that pane, and its drop lands', () => {
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
  assert.equal(opened.length, 1, 'the dialog opens instead of the file');
  assert.equal((opened[0] as DropRequest).dest, 'Home');
  assert.equal(paneBox(pane1).hidden, true, 'and the overlay goes with the drop');
});

test('over the empty pane area: the active tab s root takes it', () => {
  const dt = FILES_DT();
  dragOver(OVER_EMPTY, dt);
  assert.equal(empty.classList.contains('is-drop'), true);
  assert.equal(ghost()?.textContent, 'Copy 2 items into Home');
});

test('a modal is up: every target is invalid', () => {
  scrim.hidden = false;
  const dt = FILES_DT();
  dragOver(OVER_ROW, dt);
  assert.equal(dt.dropEffect, 'none');
  assert.deepEqual(litClasses(), []);

  drop(OVER_ROW, FILES_DT());
  assert.deepEqual(opened, []);
});

test('the Files panel hidden behind the Projects drawer is no target at all', () => {
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

test('a text drag over a terminal is cancelled, with no visuals at all', () => {
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

test('a drop hands the dialog the destination, the top-level items and the listing', () => {
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
  assert.equal(opened.length, 1, 'exactly one dialog per drop');
  const req = opened[0] as DropRequest;
  assert.equal(req.dest, 'src');
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

test('a drop hands over the folder row that had the keyboard, so it can get it back', () => {
  // The dialog focuses whatever it is handed when it closes
  // (`tests/ui-a9-drop-dialog.test.ts`): a drop that hands over nothing drops
  // the keyboard on <body> behind an aria-modal scrim.
  rowSrc.focus();
  drop(OVER_ROW, FILES_DT());
  assert.equal(opened.length, 1);
  assert.equal((opened[0] as DropRequest).returnFocus, rowSrc);
});

test('a drop over nothing opens nothing and says nothing', () => {
  drop(OVER_NOTHING, FILES_DT());
  assert.deepEqual(opened, []);
  assert.deepEqual(flashes, []);
});

test('more than 200 items is refused with one sentence, before any dialog', () => {
  const many = Array.from({ length: 201 }, (_, i) => ({ name: `f${i}.txt`, size: 1 }));
  drop(OVER_ROW, makeDataTransfer({ items: many }));
  assert.deepEqual(flashes, ['Too many items. Drop up to 200 at a time.']);
  assert.deepEqual(opened, []);
});

test('exactly 200 items still lands', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ name: `f${i}.txt`, size: 1 }));
  drop(OVER_ROW, makeDataTransfer({ items: many }));
  assert.deepEqual(flashes, []);
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

test('an in-app pointer drag owns the visuals; the cancellation stays the window s', () => {
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
  assert.deepEqual(opened, []);

  dispatch(dom.body, 'pointerup', { clientX: 10, clientY: 10, pointerId: 77 });
  source.remove();
});

// ===========================================================================
// The twins
// ===========================================================================

test('pasting files opens the dialog on the paste destination', () => {
  dispatch(dom.body, 'paste', {
    clipboardData: makeDataTransfer({ files: [{ name: 'shot.png', size: 900 }] }),
  });
  assert.equal(opened.length, 1);
  const req = opened[0] as DropRequest;
  assert.equal(req.dest, 'src');
  assert.deepEqual(req.items, [{ name: 'shot.png', dir: false, bytes: 900 }]);
  assert.deepEqual(req.listing, ['App.tsx', 'Pane.tsx']);
});

test('pasting inside a terminal or a text field belongs to them, not to the app', () => {
  const cd = (): FakeDataTransfer => makeDataTransfer({ files: [{ name: 'shot.png', size: 9 }] });
  dispatch(termHost, 'paste', { clipboardData: cd() });
  dispatch(field, 'paste', { clipboardData: cd() });
  assert.deepEqual(opened, []);
});

test('a paste with no files on the clipboard is not ours', () => {
  dispatch(dom.body, 'paste', { clipboardData: makeDataTransfer({ types: ['text/plain'] }) });
  assert.deepEqual(opened, []);
});

test('a paste carrying an EMPTY file list opens nothing and stays the page s own', () => {
  // `clipboardData.files` exists and is empty — a copy that put no file on the
  // clipboard. Opening nothing is half of it; the other half is not calling
  // preventDefault(), or the app would silently swallow every paste that is
  // not its own.
  const e = dispatch(dom.body, 'paste', { clipboardData: makeDataTransfer({ files: [] }) });
  assert.deepEqual(opened, []);
  assert.deepEqual(flashes, []);
  assert.equal(e.defaultPrevented, false);
});

// ---------------------------------------------------------------------------
// The A9b paste rule, through the DOM (PLAN-A9B §2)
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
test('the paste matrix: files x selection x terminal x editable x modal, all 32 of them', () => {
  let taken = 0;
  for (let bits = 0; bits < 32; bits += 1) {
    const files = (bits & 1) !== 0;
    const selected = (bits & 2) !== 0;
    const inTerminal = (bits & 4) !== 0;
    const inEditable = (bits & 8) !== 0;
    const modal = (bits & 16) !== 0;

    opened = [];
    xtermPastes = 0;
    selectedDest = selected ? 'src' : null;
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

test('a TEXT-only paste in a focused terminal is never ours, chosen folder or not', () => {
  // The sentence the PTY depends on: files carry no text, so the app can take
  // a file paste from a terminal for free — but a text paste is the terminal's
  // whatever else is true, or a login code would vanish into a dialog.
  for (const sel of [null, 'src']) {
    selectedDest = sel;
    const e = dispatch(termTextarea, 'paste', {
      clipboardData: makeDataTransfer({ types: ['text/plain'] }),
    });
    assert.deepEqual(opened, [], `selection ${String(sel)}`);
    assert.equal(e.defaultPrevented, false, 'the terminal keeps its own paste');
    assert.equal(e.cancelBubble, false, 'and xterm still hears it');
  }
  assert.equal(xtermPastes, 2, 'non-vacuity: xterm s own handler really did run both times');
});

test('a paste TAKEN inside a terminal is stopped, so xterm s textarea handler never runs', () => {
  // preventDefault() alone is not enough: xterm s own `paste` handler would
  // still fire and type any `text/plain` the Explorer clipboard carries beside
  // its files into the PTY, unbracketed — the accident A9 decision 5 exists to
  // prevent. Measured: deleting the stopPropagation() call leaves every other
  // assertion in this file green.
  selectedDest = 'src';
  const e = dispatch(termTextarea, 'paste', {
    clipboardData: makeDataTransfer({ files: [{ name: 'shot.png', size: 9 }] }),
  });
  assert.equal(opened.length, 1, 'non-vacuity: the app really took this one');
  assert.equal(e.defaultPrevented, true);
  assert.equal(e.cancelBubble, true);
  assert.equal(xtermPastes, 0, 'xterm must not see a paste the app took');
});

test('a taken paste copies into the CHOSEN folder, by name, and gives the keyboard back to it', () => {
  selectedDest = 'src';
  // The selection is what `pasteDestination()` answers first (ui/files.ts);
  // here it is injected, as every dep in this file is.
  pasteDest = 'src';
  termTextarea.focus();
  dispatch(termTextarea, 'paste', {
    clipboardData: makeDataTransfer({ files: [{ name: 'shot.png', size: 900 }] }),
  });
  assert.equal(opened.length, 1);
  const req = opened[0] as DropRequest;
  assert.equal(req.dest, 'src', 'a NAME, never a path');
  assert.deepEqual(req.items, [{ name: 'shot.png', dir: false, bytes: 900 }]);
  assert.deepEqual(req.listing, ['App.tsx', 'Pane.tsx']);
  // `document.activeElement` at paste time: the dialog hands the keyboard back
  // to it, so the terminal is typing again the moment the card closes. The
  // module must not move the focus itself — there would be nothing to undo.
  assert.equal(req.returnFocus, termTextarea);
  assert.equal(dom.doc.activeElement, termTextarea, 'the paste moved no focus');
  dom.doc.activeElement = dom.body;
});

test('a chosen folder does NOT hand a paste to the app while a modal is up', () => {
  selectedDest = 'src';
  scrim.hidden = false;
  const e = dispatch(termTextarea, 'paste', {
    clipboardData: makeDataTransfer({ files: [{ name: 'shot.png', size: 9 }] }),
  });
  scrim.hidden = true;
  assert.deepEqual(opened, [], 'a modal up means nothing in the window takes a paste');
  assert.equal(e.defaultPrevented, false);
});

test('the header button opens the picker and hands what was chosen to the dialog', () => {
  picked = [{ name: 'one.png', size: 10 }, { name: 'two.png', size: 20 }];
  FD.openCopyFilesPicker();
  assert.equal(opened.length, 1);
  const req = opened[0] as DropRequest;
  assert.equal(req.dest, 'src');
  assert.deepEqual(req.items, [
    { name: 'one.png', dir: false, bytes: 10 },
    { name: 'two.png', dir: false, bytes: 20 },
  ]);
});

test('a picker the user cancelled opens no dialog', () => {
  picked = [];
  FD.openCopyFilesPicker();
  assert.deepEqual(opened, []);
  assert.deepEqual(flashes, []);
});

test('the button title and the ghost name the destination the same way', () => {
  assert.equal(FD.copyIntoText('src'), 'Copy files into src');
});

// ===========================================================================
// The boot guard (before the shell exists at all)
// ===========================================================================

/**
 * The handlers a target is carrying, by type. The real layer is already wired
 * in this module, so the guard is read off the window and CALLED, never
 * dispatched at: what it does ON ITS OWN is the whole question, and a
 * dispatched event would run both handlers.
 */
function winHandlers(type: string): { fn: (e: FakeEvent) => void; capture: boolean }[] {
  return dom.win.handlers.filter((h) => h.type === type) as {
    fn: (e: FakeEvent) => void;
    capture: boolean;
  }[];
}

/** A drag event nobody dispatches — for calling one handler in isolation. */
function rawDrag(type: string, dt: FakeDataTransfer): FakeEvent {
  return {
    type,
    key: '',
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    button: 0,
    clientX: 0,
    clientY: 0,
    pointerId: 1,
    target: dom.body,
    relatedTarget: null,
    dataTransfer: dt,
    clipboardData: null,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefault(): void {
      this.defaultPrevented = true;
    },
    stopPropagation(): void {
      this.cancelBubble = true;
    },
    getModifierState: () => false,
  };
}

test('the boot guard refuses a file drop on its own, before any shell exists', () => {
  // The gap it covers is real and unbounded: boot() runs asynchronously, and a
  // hydrate failure leaves the boot panel up for ever with no other drop
  // listener anywhere behind it. A file dropped in that gap NAVIGATES the
  // browser to the file and the app is gone.
  const before = dom.win.handlers.length;
  const off = FD.installDropGuard();
  const added = dom.win.handlers.slice(before);
  assert.deepEqual(added.map((h) => h.type), ['dragover', 'drop'], 'both, or the drop still fires');
  assert.deepEqual(added.map((h) => h.capture), [true, true], 'the window decides first');

  for (const type of ['dragover', 'drop']) {
    const h = added.find((x) => x.type === type) as { fn: (e: FakeEvent) => void };
    const dt = makeDataTransfer({ items: [{ name: 'a.ts', size: 10 }] });
    dt.dropEffect = 'copy';
    const e = rawDrag(type, dt);
    h.fn(e);
    assert.equal(e.defaultPrevented, true, `${type}: the browser may not have this drop`);
    assert.equal(dt.dropEffect, 'none', `${type}: and the cursor says so`);
  }

  // A drag carrying no files is none of its business: dragging text into a
  // field is still the browser's own.
  const text = makeDataTransfer({ types: ['text/plain'] });
  const e = rawDrag('dragover', text);
  (added[0] as { fn: (e: FakeEvent) => void }).fn(e);
  assert.equal(e.defaultPrevented, false);

  off();
  assert.equal(dom.win.handlers.length, before, 'its uninstaller really removes both');
});

test('initFileDrop takes the guard down before registering: never two handlers on one drop', () => {
  const bare = winHandlers('dragover').length;
  FD.installDropGuard();
  assert.equal(winHandlers('dragover').length, bare + 1, 'non-vacuity: the guard is on');

  // Re-wiring with the same deps re-registers nothing (the module is a
  // singleton) — but it MUST still hand the guard's own listener back.
  FD.initFileDrop(DEPS);
  assert.equal(winHandlers('dragover').length, bare, 'exactly one preventDefault path stays');
  assert.deepEqual(winHandlers('drop').length, 1, 'the real layer, and only it');

  // And the real layer is untouched by the handover.
  const dt = FILES_DT();
  dragOver(OVER_ROW, dt);
  assert.equal(dt.dropEffect, 'copy');
  assert.equal(rowSrc.classList.contains('is-drop'), true);
});

test('main.ts installs the guard as the FIRST statement of boot, before any await', () => {
  const main = readFileSync(join(here, '..', 'web', 'src', 'main.ts'), 'utf8');
  const boot = main.indexOf('async function boot(');
  assert.ok(boot > 0, 'non-vacuity: boot() must still be the entry');
  const body = main.indexOf('{', boot) + 1;
  const guard = main.indexOf('installDropGuard();', body);
  assert.ok(guard > 0, 'the guard must be installed in the boot path');
  const firstAwait = /\bawait\s/.exec(main.slice(body))?.index ?? -1;
  assert.ok(firstAwait > 0, 'non-vacuity: boot() really does await something');
  assert.ok(guard - body < firstAwait, 'a guard installed after an await leaves the gap open');
  // FIRST statement: only comments and whitespace may stand in front of it.
  const head = main.slice(body, guard).replace(/\/\/[^\n]*/g, '');
  assert.equal(head.trim(), '', `something runs before the guard: ${head.trim()}`);
});

// ===========================================================================
// The HTML5 channel stays ours alone
// ===========================================================================

test('every drag-state class this module sets has a rule behind it', () => {
  // The module only ADDS these classes; with no rule behind them the drop
  // highlight, the invalid ghost and the mid-drag selection freeze are gone
  // and every DOM assertion above still passes (measured: deleting the two
  // rules keeps the suite green).
  const css = stripComments(APP_CSS);
  assert.ok(css.length > 50_000, `non-vacuity: app.css is ${css.length} chars`);
  assert.match(css, /\.files-row\.is-dir\.is-drop\b/);
  assert.match(css, /\.files-view\.is-drop\b/);
  assert.match(css, /body\.is-filedrag\b/);
  assert.match(css, /\.drag-ghost\.is-invalid\b/);
});

test('main.ts wires the window drop layer, after the panel that answers its deps', () => {
  // Every test above drives the module with injected deps, so the whole
  // feature could be unwired in the shell and stay green. main.ts's import
  // graph reaches @xterm/xterm (a browser bundle), so this is read as source,
  // the way the A5/A9 shell-wiring assertions already are.
  const main = readFileSync(join(here, '..', 'web', 'src', 'main.ts'), 'utf8');
  assert.ok(main.length > 10_000, 'non-vacuity: main.ts');
  assert.match(main, /import \{ initFileDrop, installDropGuard \} from '\.\/ui\/filedrop\.ts';/);
  const panel = main.indexOf('const filesPanel = initFilesPanel(');
  const wire = main.indexOf('initFileDrop({');
  assert.ok(panel > 0 && wire > 0, 'both calls must exist');
  assert.ok(wire > panel, 'three of its deps are that panel s own subject()');
  const call = main.slice(wire, main.indexOf('});', wire));
  for (const dep of [
    'openDialog: openDropDialog',
    'listingFor',
    'destinationOfPane',
    'destinationOfActiveView',
    'filesPanelDestination',
    'pasteDestination',
    // A9b: without it a paste inside a terminal can never be the app's, and
    // the whole "choose a folder, then paste from anywhere" decision is dead
    // in the shell with every unit test above still green.
    'selectedFolder',
  ]) {
    assert.ok(call.includes(dep), `the drop layer is wired without ${dep}`);
  }
  // …and the A9b dep must be the PANEL'S OWN function, not something that
  // merely spells its name. MEASURED (gate, 2026-09-16): rewriting the line as
  // `selectedFolder: () => null` satisfies the name scan above and leaves the
  // ENTIRE suite green while every paste inside a terminal is silently refused
  // — the whole of user decision 2, dead in the shell. The shorthand is what
  // ties it to the import, so both halves are asserted.
  assert.match(
    call,
    /\n\s*selectedFolder,\n/,
    'the dep must be the shorthand for the panel s exported selectedFolder, never a stub',
  );
  assert.match(
    main,
    /import \{[^}]*\bselectedFolder,[^}]*\} from '\.\/ui\/files\.ts';/s,
    'and it must be imported from the panel that owns the selection',
  );
});

test('web/src has no `draggable` attribute and adds no `dragstart` listener', () => {
  const root = join(here, '..', 'web', 'src');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|html|css)$/.test(e.name)) files.push(full);
    }
  };
  walk(root);
  assert.ok(files.length >= 20, `non-vacuity: scanned ${files.length} files`);
  // The mirror of the `draggable` pin in tests/ui-dnd-a10.test.ts: an in-app
  // source that opted into HTML5 DnD would fire the handlers in filedrop.ts
  // with no `Files` in its types and a target this module never resolved.
  const offenders = files.filter((f) => /['"]dragstart['"]/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => f.slice(root.length + 1)), []);
});
