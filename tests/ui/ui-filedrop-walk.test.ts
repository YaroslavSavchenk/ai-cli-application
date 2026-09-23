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
import { dispatch, makeDataTransfer } from '../helpers/fake-dom.ts';
import {
  dom,
  FD,
  type DropRequest,
  type WalkShape,
  dest,
  settle,
  OVER_ROW,
  drop,
  world,
  resetWorld,
} from '../helpers/ui-filedrop-fixture.ts';

beforeEach(resetWorld);

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
  assert.equal(world.opened.length, 1);
  const req = world.opened[0] as DropRequest & { walk: WalkShape };
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
  assert.deepEqual(world.flashes, ['Too many files. Drop up to 2000 files at a time.']);
  assert.deepEqual(world.opened, [], 'nothing partial, and no dialog to answer');
  assert.equal(world.listingCalls, 0, 'a refused drop costs no request');
});

test('exactly 2000 files still lands', async () => {
  const many = Array.from({ length: 2000 }, (_, i) => ({ name: `f${i}.bin`, size: 1 }));
  drop(OVER_ROW, makeDataTransfer({ items: [tree('big', many)] as never }));
  await settle();
  assert.deepEqual(world.flashes, []);
  assert.equal(world.opened.length, 1);
  assert.equal((world.opened[0] as DropRequest & { walk: WalkShape }).walk.files.length, 2000);
});

test('more than 1 GB is refused whole, in its own sentence, before any listing', async () => {
  const big = Array.from({ length: 3 }, (_, i) => ({ name: `v${i}.mov`, size: 400 * 1024 * 1024 }));
  drop(OVER_ROW, makeDataTransfer({ items: [tree('video', big)] as never }));
  await settle();
  assert.deepEqual(world.flashes, ['Too much at once. Drop up to 1 GB at a time.']);
  assert.deepEqual(world.opened, []);
  assert.equal(world.listingCalls, 0);
});

test('a drop nothing could be read out of says so, and opens no dialog', async () => {
  drop(OVER_ROW, makeDataTransfer({ items: [{ name: 'locked', dir: true, unreadable: true }] as never }));
  await settle();
  assert.deepEqual(world.flashes, ['The app could not read what was dropped.']);
  assert.deepEqual(world.opened, []);
  assert.equal(world.listingCalls, 0, 'there is nothing to ask a listing about');
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
  assert.deepEqual(world.flashes, []);
  assert.equal(world.opened.length, 1);
  const req = world.opened[0] as DropRequest & { walk: WalkShape };
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
  assert.deepEqual(world.flashes, ['The app could not read what was dropped.']);
  assert.deepEqual(world.opened, [], 'nothing is offered for a drop the app never read');
  assert.equal(world.listingCalls, 0, 'and nothing is asked of the server about it');
});

test('a second drop while a copy is still writing is refused, before any walk or listing', async () => {
  world.copyRunning = true;
  drop(OVER_ROW, makeDataTransfer({ items: [tree('web', [{ name: 'a.ts', size: 1 }])] as never }));
  await settle();
  assert.deepEqual(world.flashes, ['A copy is still running.']);
  assert.deepEqual(world.opened, [], 'one copy at a time');
  assert.equal(world.listingCalls, 0, 'and it costs no request');

  // The paste and the picker are the same door, so they are refused there too.
  world.flashes.length = 0;
  world.selectedDest = dest('src');
  dispatch(dom.body, 'paste', {
    clipboardData: makeDataTransfer({ files: [{ name: 'b.txt', size: 9 }] }),
  });
  await settle();
  world.picked = [{ name: 'c.txt', size: 1 }];
  FD.openCopyFilesPicker();
  await settle();
  assert.deepEqual(world.flashes, ['A copy is still running.', 'A copy is still running.']);
  assert.deepEqual(world.opened, []);

  // When it is over, the next drop is taken as usual.
  world.copyRunning = false;
  world.flashes.length = 0;
  drop(OVER_ROW, makeDataTransfer({ items: [{ name: 'a.ts', size: 1 }] }));
  await settle();
  assert.deepEqual(world.flashes, []);
  assert.equal(world.opened.length, 1, 'the door opens again');
});

test('the refusal is answered before the WALK — and after the one check that costs nothing', async () => {
  world.copyRunning = true;
  // A drag of 201 items is refused by its NUMBER in the drop handler itself
  // (A9: 10 000 items must be refused without reading one of them), so that
  // sentence wins — both are a refusal, and neither reads a directory.
  const many = Array.from({ length: 201 }, (_, i) => ({ name: `f${i}.txt`, size: 1 }));
  drop(OVER_ROW, makeDataTransfer({ items: many }));
  await settle();
  assert.deepEqual(world.flashes, ['Too many items. Drop up to 200 at a time.']);
  assert.deepEqual(world.opened, []);

  // Anything that DOES reach the door hears about the copy first: before the
  // walk, before the limits, before a listing.
  world.flashes.length = 0;
  const huge = Array.from({ length: 2500 }, (_, i) => ({ name: `f${i}.bin`, size: 1024 * 1024 }));
  drop(OVER_ROW, makeDataTransfer({ items: [tree('huge', huge)] as never }));
  await settle();
  assert.deepEqual(world.flashes, ['A copy is still running.'], 'not the 2000-file sentence: nothing was walked');
  assert.equal(world.listingCalls, 0);
  assert.deepEqual(world.opened, []);
});

test('the picker and the paste reach the same door: both arrive walked', async () => {
  world.picked = [{ name: 'a.txt', size: 7 }];
  FD.openCopyFilesPicker();
  await settle();
  assert.equal(world.opened.length, 1, 'the button twin');
  const fromButton = world.opened[0] as DropRequest & { walk: WalkShape };
  assert.deepEqual(fromButton.walk.files.map((f) => f.rel), ['']);
  assert.equal(fromButton.walk.bytes, 7);

  world.opened = [];
  world.selectedDest = dest('src');
  dispatch(dom.body, 'paste', {
    clipboardData: makeDataTransfer({ files: [{ name: 'b.txt', size: 9 }] }),
  });
  await settle();
  assert.equal(world.opened.length, 1, 'the keyboard twin');
  const fromPaste = world.opened[0] as DropRequest & { walk: WalkShape };
  assert.equal(fromPaste.walk.bytes, 9);
  assert.equal(fromPaste.walk.folders.length, 0, 'a clipboard carries no folder');
});
