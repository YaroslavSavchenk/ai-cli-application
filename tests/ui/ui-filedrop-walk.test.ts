/**
 * `web/src/ui/filedrop.ts` — the walk of a dropped FOLDER and the drop-level
 * limits (Nocturne part B10, user decision D3): 2000 files, 1 GB, a drop
 * nothing could be read out of, a walk that throws, a second drop while a
 * copy is still writing. Split from `tests/ui/ui-filedrop.test.ts`.
 *
 * How: the REAL module on the DOM double (`tests/helpers/fake-dom.ts`), the
 * shell from `tests/helpers/ui-filedrop-fixture.ts`, the dialog and the
 * listing injected; a fake `DataTransfer` whose folder entries the walk can
 * really read. A listing-call counter proves a refused drop costs no request.
 *
 * Why: a refusal that comes after the walk or after the listing costs the user
 * a long wait for a "no"; two copies at once race the panel refresh.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`): real
 * hit-testing, that an outline really changes no layout, the OS drag cursor,
 * that Chromium fires these events in this order, and that a real Explorer
 * drag carries what `makeDataTransfer` says it does.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, makeDataTransfer, type FakeFile } from '../helpers/fake-dom.ts';
import {
  dom,
  FD,
  type Dest,
  type DropRequest,
  type WalkShape,
  dest,
  settle,
  filesAside,
  termTextarea,
  scrim,
  LISTINGS,
  type FileLikeIn,
  OVER_ROW,
  drop,
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
// The walk and the drop-level limits (part B10, user decision D3)
// ===========================================================================

/** A folder whose tree the walk can really read. */
const tree = (name: string, children: unknown[]): Record<string, unknown> => ({
  name,
  dir: true,
  children,
});

test('a dropped FOLDER is walked, and what it holds reaches the dialog', async () => {
  const dt = makeDataTransfer({
    items: [
      tree('web', [
        { name: 'index.html', size: 10 },
        { name: 'src', dir: true, children: [{ name: 'main.ts', size: 20 }] },
        { name: 'empty', dir: true, children: [] },
      ]),
      { name: 'notes.txt', size: 5 },
    ] as never,
  });
  drop(OVER_ROW, dt);
  await settle();
  assert.equal(opened.length, 1);
  const req = opened[0] as DropRequest & { walk: WalkShape };
  // The ITEMS are still the top-level things, in the A9 shape.
  assert.deepEqual(req.items, [
    { name: 'web', dir: true, bytes: null },
    { name: 'notes.txt', dir: false, bytes: 5 },
  ]);
  // The WALK is what B10 added: every file, the empty folder, the totals.
  assert.deepEqual(
    req.walk.files.map((f) => `${f.top}:${f.rel}`),
    ['0:index.html', '0:src/main.ts', '1:'],
  );
  assert.deepEqual(req.walk.folders, [{ top: 0, rel: 'empty' }]);
  assert.equal(req.walk.bytes, 35);
  assert.equal(req.walk.unreadable, 0);
});

test('more than 2000 files is refused whole, in one sentence, before any listing is asked for', async () => {
  const many = Array.from({ length: 2001 }, (_, i) => ({ name: `f${i}.bin`, size: 1 }));
  drop(OVER_ROW, makeDataTransfer({ items: [tree('huge', many)] as never }));
  await settle();
  assert.deepEqual(flashes, ['Too many files. Drop up to 2000 files at a time.']);
  assert.deepEqual(opened, [], 'nothing partial, and no dialog to answer');
  assert.equal(listingCalls, 0, 'a refused drop costs no request');
});

test('exactly 2000 files still lands', async () => {
  const many = Array.from({ length: 2000 }, (_, i) => ({ name: `f${i}.bin`, size: 1 }));
  drop(OVER_ROW, makeDataTransfer({ items: [tree('big', many)] as never }));
  await settle();
  assert.deepEqual(flashes, []);
  assert.equal(opened.length, 1);
  assert.equal((opened[0] as DropRequest & { walk: WalkShape }).walk.files.length, 2000);
});

test('more than 1 GB is refused whole, in its own sentence, before any listing', async () => {
  const big = Array.from({ length: 3 }, (_, i) => ({ name: `v${i}.mov`, size: 400 * 1024 * 1024 }));
  drop(OVER_ROW, makeDataTransfer({ items: [tree('video', big)] as never }));
  await settle();
  assert.deepEqual(flashes, ['Too much at once. Drop up to 1 GB at a time.']);
  assert.deepEqual(opened, []);
  assert.equal(listingCalls, 0);
});

test('a drop nothing could be read out of says so, and opens no dialog', async () => {
  drop(OVER_ROW, makeDataTransfer({ items: [{ name: 'locked', dir: true, unreadable: true }] as never }));
  await settle();
  assert.deepEqual(flashes, ['The app could not read what was dropped.']);
  assert.deepEqual(opened, []);
  assert.equal(listingCalls, 0, 'there is nothing to ask a listing about');
});

test('one unreadable folder beside a readable one is not a refusal: the rest still copies', async () => {
  drop(
    OVER_ROW,
    makeDataTransfer({
      items: [
        { name: 'locked', dir: true, unreadable: true },
        tree('web', [{ name: 'a.ts', size: 3 }]),
      ] as never,
    }),
  );
  await settle();
  assert.deepEqual(flashes, []);
  assert.equal(opened.length, 1);
  const req = opened[0] as DropRequest & { walk: WalkShape };
  assert.equal(req.walk.unreadable, 1);
  assert.equal(req.walk.files.length, 1);
});

test('a walk that THROWS is said out loud, and opens no dialog over an empty plan', async () => {
  // A handle the browser hands over and then refuses to answer about: reading
  // `isDirectory` throws, so `walkDrop` REJECTS instead of answering. The drop
  // exists and the app cannot see into it — which is the same sentence an
  // unreadable folder earns, and never a dialog listing nothing.
  const dt = makeDataTransfer({ items: [{ name: 'boom', size: 1 }] });
  (dt.items[0] as unknown as { webkitGetAsEntry: () => unknown }).webkitGetAsEntry = () => ({
    name: 'boom',
    get isDirectory(): boolean {
      throw new Error('the handle went away with the event');
    },
  });
  drop(OVER_ROW, dt);
  await settle();
  assert.deepEqual(flashes, ['The app could not read what was dropped.']);
  assert.deepEqual(opened, [], 'nothing is offered for a drop the app never read');
  assert.equal(listingCalls, 0, 'and nothing is asked of the server about it');
});

test('a second drop while a copy is still writing is refused, before any walk or listing', async () => {
  copyRunning = true;
  drop(OVER_ROW, makeDataTransfer({ items: [tree('web', [{ name: 'a.ts', size: 1 }])] as never }));
  await settle();
  assert.deepEqual(flashes, ['A copy is still running.']);
  assert.deepEqual(opened, [], 'one copy at a time');
  assert.equal(listingCalls, 0, 'and it costs no request');

  // The paste and the picker are the same door, so they are refused there too.
  flashes.length = 0;
  selectedDest = dest('src');
  dispatch(dom.body, 'paste', {
    clipboardData: makeDataTransfer({ files: [{ name: 'b.txt', size: 9 }] }),
  });
  await settle();
  picked = [{ name: 'c.txt', size: 1 }];
  FD.openCopyFilesPicker();
  await settle();
  assert.deepEqual(flashes, ['A copy is still running.', 'A copy is still running.']);
  assert.deepEqual(opened, []);

  // When it is over, the next drop is taken as usual.
  copyRunning = false;
  flashes.length = 0;
  drop(OVER_ROW, makeDataTransfer({ items: [{ name: 'a.ts', size: 1 }] }));
  await settle();
  assert.deepEqual(flashes, []);
  assert.equal(opened.length, 1, 'the door opens again');
});

test('the refusal is answered before the WALK — and after the one check that costs nothing', async () => {
  copyRunning = true;
  // A drag of 201 items is refused by its NUMBER in the drop handler itself
  // (A9: 10 000 items must be refused without reading one of them), so that
  // sentence wins — both are a refusal, and neither reads a directory.
  const many = Array.from({ length: 201 }, (_, i) => ({ name: `f${i}.txt`, size: 1 }));
  drop(OVER_ROW, makeDataTransfer({ items: many }));
  await settle();
  assert.deepEqual(flashes, ['Too many items. Drop up to 200 at a time.']);
  assert.deepEqual(opened, []);

  // Anything that DOES reach the door hears about the copy first: before the
  // walk, before the limits, before a listing.
  flashes.length = 0;
  const huge = Array.from({ length: 2500 }, (_, i) => ({ name: `f${i}.bin`, size: 1024 * 1024 }));
  drop(OVER_ROW, makeDataTransfer({ items: [tree('huge', huge)] as never }));
  await settle();
  assert.deepEqual(flashes, ['A copy is still running.'], 'not the 2000-file sentence: nothing was walked');
  assert.equal(listingCalls, 0);
  assert.deepEqual(opened, []);
});

test('the picker and the paste reach the same door: both arrive walked', async () => {
  picked = [{ name: 'a.txt', size: 7 }];
  FD.openCopyFilesPicker();
  await settle();
  assert.equal(opened.length, 1, 'the button twin');
  const fromButton = opened[0] as DropRequest & { walk: WalkShape };
  assert.deepEqual(fromButton.walk.files.map((f) => f.rel), ['']);
  assert.equal(fromButton.walk.bytes, 7);

  opened = [];
  selectedDest = dest('src');
  dispatch(dom.body, 'paste', {
    clipboardData: makeDataTransfer({ files: [{ name: 'b.txt', size: 9 }] }),
  });
  await settle();
  assert.equal(opened.length, 1, 'the keyboard twin');
  const fromPaste = opened[0] as DropRequest & { walk: WalkShape };
  assert.equal(fromPaste.walk.bytes, 9);
  assert.equal(fromPaste.walk.folders.length, 0, 'a clipboard carries no folder');
});
