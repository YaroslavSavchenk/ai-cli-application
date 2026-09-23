/**
 * `web/src/ui/drop-dialog.ts` — the drop dialog (Nocturne A9, `fd-`) driven
 * through the REAL module on the DOM double in `tests/helpers/fake-dom.ts`, plus the
 * source-level guards its stylesheet block needs.
 *
 * WHY THIS FILE EXISTS. The rules behind the words are pinned DOM-free next
 * door (`tests/ui/ui-drop-model.test.ts`) and the drag that opens this card is
 * brief 2's (`tests/ui/ui-filedrop.test.ts`). What sits between them is the card
 * itself, and every one of its promises is a DOM fact a regex cannot see:
 *
 *   1. it opens on the question ONLY when something clashes, and otherwise is
 *      already copying;
 *   2. each of the three answers leads to the outcomes `planResults` plans for
 *      it, row by row, and then to one result sentence;
 *   3. Escape and the `×` are Skip while it asks, Close when it is over, and
 *      NOTHING while it copies — a copy in flight is not cancelled by a key;
 *   4. every state carries an honesty line, each saying what THAT state is
 *      pretending — example conflicts while it asks, nothing written while it
 *      copies — because none of it is real until part B10;
 *   5. the keyboard: the safe answer holds it, the busy card still holds it
 *      (no focus behind an aria-modal scrim), and the opener gets it back;
 *   6. `.modal-scrim` stays on the scrim — `ui/keys.ts` finds an open dialog
 *      by that class, and a dialog that dropped it would keep its looks and
 *      silently break the focus handover.
 *
 * The block guards every Nocturne section carries (class parity for `fd-`,
 * tokens only, no colour literal) and the source pins (the mock is gone, the
 * card drives the runner it was handed, the Escape ladder in `main.ts`) are in
 * `tests/ui/ui-a9-drop-dialog-source.test.ts`; this file also checks that
 * nothing the card renders carries a path, a byte count or a decorative dash.
 *
 * `../log.ts` is stubbed (it would open a real client-log channel); the REAL
 * `ui/util.ts` and `ui/drop-model.ts` take part. Layout, hit-testing and
 * screen-reader output stay manual (`.claude/skills/verify-terminal/SKILL.md`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { byClass, installDom, dispatch, type FakeElement } from '../helpers/fake-dom.ts';
import {
  MAX_ITEM_BYTES,
  planResults,
  type Choice,
  type DropItem,
  type ItemResult,
} from '../../web/src/ui/drop-model.ts';

const dom = installDom();

// ===========================================================================
// Harness
// ===========================================================================

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((context.parentURL ?? '').endsWith('/web/src/ui/drop-dialog.ts') && specifier === '../log.ts') {
      return { url: 'fd-stub:log', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'fd-stub:log') {
      return {
        format: 'module',
        source: `const noop = () => {};
          export const log = { debug: noop, info: noop, warn: noop, error: noop, hold: noop, resume: noop };
          export function formatError(e) { return String(e); }`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

interface Hooks {
  settled(index: number, result: ItemResult): void;
  progress(done: number, total: number): void;
}
interface Run {
  plan(choice: Choice): ItemResult[];
  start(choice: Choice, on: Hooks): Promise<ItemResult[]>;
  /** Failed WRITES of the run that just ended (part B10 fix round). */
  failed(): number;
}
interface DialogModule {
  openDropDialog(req: {
    dest: string;
    items: DropItem[];
    listing: readonly string[];
    returnFocus: unknown;
    run: Run;
  }): void;
  isDropDialogOpen(): boolean;
  isDropRunning(): boolean;
  dropDialogEscape(): void;
}

/**
 * The RUNNER the card is handed since part B10 (`ui/drop-upload.ts` in the
 * app), driven BY HAND here: `step()` settles the next row, `finish()` settles
 * what is left. That is the whole point of the injection — a row now settles
 * when a real upload answers, so a test that could still walk a timer would be
 * testing a mock that no longer exists.
 *
 * Its plan is the REAL `planResults`, so a row says what the model planned;
 * `twist` rewrites one row's outcome, which is how a failure the plan would
 * never produce (a server refusal) is put on screen.
 */
interface Driver {
  run: Run;
  /** The answer `start` was called with, and how often it was called. */
  choice: Choice | null;
  starts: number;
  step(): boolean;
  finish(): void;
  /** The RUN itself blows up (a network that went away mid-copy). */
  fail(err: unknown): void;
  pending(): number;
}

function makeDriver(
  items: DropItem[],
  listing: readonly string[],
  twist?: (r: ItemResult, i: number) => ItemResult,
): Driver {
  let hooks: Hooks | null = null;
  let results: ItemResult[] = [];
  let at = 0;
  let done: ((r: ItemResult[]) => void) | null = null;
  let blowUp: ((e: unknown) => void) | null = null;
  const d: Driver = {
    choice: null,
    starts: 0,
    run: {
      plan: (choice) => planResults(items, listing, choice),
      failed: () => results.filter((r) => r.state === 'failed').length,
      start: (choice, on) => {
        d.choice = choice;
        d.starts += 1;
        hooks = on;
        results = planResults(items, listing, choice).map((r, i) => (twist === undefined ? r : twist(r, i)));
        at = 0;
        return new Promise<ItemResult[]>((resolve, reject) => {
          done = resolve;
          blowUp = reject;
        });
      },
    },
    pending: () => results.length - at,
    step() {
      if (hooks === null || at >= results.length) return false;
      hooks.settled(at, results[at] as ItemResult);
      at += 1;
      hooks.progress(at, results.length);
      if (at === results.length) done?.(results);
      return true;
    },
    finish() {
      while (d.step());
    },
    fail(err: unknown) {
      at = results.length; // nothing more will be reported
      blowUp?.(err);
    },
  };
  return d;
}

const FD = (await import(new URL('../../web/src/ui/drop-dialog.ts', import.meta.url).href)) as DialogModule;

/** The shell's dialog host: the module appends its scrim to this, like every dialog. */
const modalHost = dom.doc.createElement('div');
modalHost.className = 'modal-host';
dom.body.append(modalHost);

/** The element a drop came from, which must get the keyboard back. */
const opener = dom.doc.createElement('button');
dom.body.append(opener);

/**
 * The statusline: since the fix round a card that was HIDDEN mid-copy says how
 * the copy ended there, and nowhere else. The real module, in a host of its
 * own — the `tests/ui/ui-dnd-a10.test.ts` idiom.
 */
const statusHost = dom.doc.createElement('div');
dom.body.append(statusHost);
const SL = (await import(new URL('../../web/src/ui/statusline.ts', import.meta.url).href)) as {
  initStatusline(container: unknown, deps: { openShortcuts(): void }): { render(): void };
};
SL.initStatusline(statusHost, { openShortcuts: () => {} });
dom.win.intervals.length = 0; // its 15 s uptime ticker is not this file's business
const flashes: string[] = [];
function flashText(): string {
  const said = byClass(statusHost, 'status-flash')[0]?.textContent ?? '';
  if (said !== '' && flashes[flashes.length - 1] !== said) flashes.push(said);
  return said;
}

const file = (name: string, bytes = 1024): DropItem => ({ name, dir: false, bytes });
const folder = (name: string): DropItem => ({ name, dir: true, bytes: null });

/** The open dialog's scrim and card, or a failed assertion. */
function card(): { scrim: FakeElement; modal: FakeElement } {
  const scrim = modalHost.children[modalHost.children.length - 1] as FakeElement;
  assert.ok(scrim !== undefined && scrim.classList.contains('fd-scrim'), 'no open drop dialog');
  return { scrim, modal: scrim.children[0] as FakeElement };
}

const one = (cls: string): FakeElement => {
  const hit = byClass(card().modal, cls)[0];
  assert.ok(hit !== undefined, `no .${cls}`);
  return hit;
};
const texts = (cls: string): string[] => byClass(card().modal, cls).map((n) => n.textContent);

/** The footer button with this label, whatever its state. */
const btn = (label: string): FakeElement => {
  const hit = byClass(one('fd-ft'), 'btn-quiet')
    .concat(byClass(one('fd-ft'), 'btn-accent'))
    .find((b) => b.textContent === label);
  assert.ok(hit !== undefined, `no footer button labelled ${label}`);
  return hit;
};

/** The runner of the card that is open. */
let driver: Driver = makeDriver([], []);

/**
 * Let the module's own promise chain land: `start()` is awaited, so the result
 * phase arrives one microtask turn after the last row settles.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/** Settle every row that is left, and let the card reach its result state. */
async function finish(): Promise<void> {
  driver.finish();
  await settle();
}

/** Open one drop, with the opener as the element focus must return to. */
function open(
  dest: string,
  items: DropItem[],
  listing: readonly string[],
  twist?: (r: ItemResult, i: number) => ItemResult,
): void {
  opener.focus();
  driver = makeDriver(items, listing, twist);
  FD.openDropDialog({ dest, items, listing, returnFocus: opener, run: driver.run });
}

/** Whatever the last test left: answer it, let it finish, close it. */
async function reset(): Promise<void> {
  // Escape is an ANSWER on the question (Skip), so a card left mid-question
  // needs the whole walk: Skip, let the copy finish, Close. A card that was
  // HIDDEN mid-copy leaves no dialog and a run that is still going, which is
  // the other thing that must be drained before the next test.
  for (let i = 0; i < 4 && (FD.isDropDialogOpen() || FD.isDropRunning()); i += 1) {
    await finish();
    if (FD.isDropDialogOpen()) FD.dropDialogEscape();
  }
  dom.win.timers.length = 0;
  flashes.length = 0;
  assert.equal(FD.isDropDialogOpen(), false, 'reset must leave no dialog open');
  assert.equal(FD.isDropRunning(), false, 'reset must leave no copy running');
}

/** Everything the card says right now, as one string. */
const rendered = (): string => card().modal.textContent;

// ===========================================================================
// 1. The question
// ===========================================================================

test('non-vacuity: the module is loaded and nothing is open yet', () => {
  assert.equal(FD.isDropDialogOpen(), false);
  assert.equal(modalHost.children.length, 0, 'a dialog is created on open, never at import');
});

test('one conflict: the name, no scope line, and the three Explorer verbs', async () => {
  await reset();
  open('src', [file('README.md'), file('notes.txt')], ['README.md']);
  assert.equal(FD.isDropDialogOpen(), true);
  assert.deepEqual(texts('fd-title'), ['README.md already exists in src']);
  assert.equal(one('fd-sub').hidden, true, 'one conflict needs no sentence about scope');
  assert.equal(btn('Replace').hidden, false);
  assert.equal(btn('Keep both').hidden, false);
  assert.equal(btn('Skip').hidden, false);
  assert.equal(btn('Close').hidden, true, 'nothing is over yet');
  assert.equal(one('fd-list').hidden, true, 'no list before an answer');
  assert.equal(one('fd-progress').hidden, true);
  assert.equal(dom.doc.activeElement, btn('Keep both'), 'the answer that can lose no file holds the keyboard');
});

test('more than one conflict: the count, and the sentence that says how far the answer reaches', async () => {
  await reset();
  open('src', [file('a.md'), file('b.md'), file('c.md')], ['a.md', 'b.md', 'c.md']);
  assert.deepEqual(texts('fd-title'), ['3 items already exist in src']);
  assert.equal(one('fd-sub').hidden, false);
  assert.deepEqual(texts('fd-sub'), ['The choice applies to all 3.']);
  // There is no line about pretending anywhere in the card any more (B10):
  // the conflicts were already real since B2, and the copy is real now.
  assert.deepEqual(byClass(card().modal, 'fd-honest'), []);
});

test('the card is a dialog, on the scrim ui/keys.ts finds an open one by', () => {
  const { scrim, modal } = card();
  assert.equal(scrim.className, 'modal-scrim fd-scrim');
  assert.equal(modal.className, 'fd-modal');
  assert.equal(modal.getAttribute('role'), 'dialog');
  assert.equal(modal.getAttribute('aria-modal'), 'true');
  assert.equal(modal.getAttribute('aria-labelledby'), 'fd-title');
  assert.equal(one('fd-title').id, 'fd-title');
});

// ===========================================================================
// 2. The three answers
// ===========================================================================

test('Keep both: the conflict is copied under a new name, the rest untouched', async () => {
  await reset();
  open('src', [file('README.md'), file('notes.txt')], ['README.md']);
  btn('Keep both').click();

  // Copying: the header names the destination, every row is still pending.
  assert.deepEqual(texts('fd-title'), ['Copying 2 items into src']);
  assert.equal(one('fd-list').hidden, false);
  assert.deepEqual(texts('fd-name'), ['README.md', 'notes.txt']);
  assert.deepEqual(texts('fd-state'), ['', ''], 'a row says nothing before its turn');
  assert.equal(byClass(card().modal, 'is-pending').length, 2);
  assert.deepEqual(texts('fd-step'), ['0 of 2']);
  assert.deepEqual(byClass(card().modal, 'fd-honest'), [], 'nothing pretends any more');
  assert.equal(driver.starts, 1, 'the ANSWER started the real copy, exactly once');
  assert.equal(driver.choice, 'keep-both', 'and it is the answer the button carries');
  assert.equal(btn('Keep both').hidden, true, 'the question is answered');
  assert.equal(one('fd-ft').hidden, false, 'the footer stays: the copy can be put away');
  assert.equal(btn('Hide').hidden, false, 'and Hide is the only thing on it');
  assert.equal(btn('Close').hidden, true);
  assert.equal(one('fd-x').hidden, false);
  assert.equal(one('fd-x').getAttribute('aria-label'), 'hide');
  assert.equal(dom.doc.activeElement, one('fd-step'), 'the busy card keeps the keyboard inside itself');

  // One row at a time, and the rhythm is the RUNNER'S — no timer is armed at
  // all: the card cannot make a row settle, only report one that did.
  assert.deepEqual(dom.win.timers, [], 'no stagger, no timer, no mock');
  driver.step();
  assert.deepEqual(texts('fd-state'), ['Copied', '']);
  assert.deepEqual(texts('fd-step'), ['1 of 2']);
  assert.equal(byClass(card().modal, 'is-pending').length, 1);
  // The settled row asks to be scrolled into view, by the least it can be.
  const first = byClass(card().modal, 'fd-row')[0] as FakeElement;
  assert.deepEqual(first.scrolledInto, [{ block: 'nearest' }]);
  await finish();

  // Result: one sentence, the list still readable, Close focused.
  assert.deepEqual(texts('fd-title'), ['Copied 2 files into src.']);
  assert.deepEqual(texts('fd-state'), ['Copied', 'Copied']);
  assert.deepEqual(texts('fd-note'), ['saved as README (2).md'], 'the name it landed under stays with its row');
  assert.deepEqual(texts('fd-step'), ['2 of 2']);
  assert.equal(one('fd-progress').hidden, true, 'the count is only news while it counts');
  assert.equal(one('fd-ft').hidden, false);
  assert.equal(btn('Close').hidden, false);
  assert.equal(dom.doc.activeElement, btn('Close'), 'the one remaining action holds the keyboard');
});

test('Replace: every item is copied and no row grows a note', async () => {
  await reset();
  open('src', [file('README.md'), folder('web')], ['README.md']);
  btn('Replace').click();
  assert.deepEqual(texts('fd-title'), ['Copying 2 items into src']);
  await finish();
  assert.deepEqual(texts('fd-state'), ['Copied', 'Copied']);
  assert.deepEqual(texts('fd-note'), []);
  assert.deepEqual(texts('fd-title'), ['Copied 1 file and 1 folder into src.']);
});

test('Skip: the conflict is left alone, the rest is copied, and the sentence counts both', async () => {
  await reset();
  open('src', [file('README.md'), file('notes.txt')], ['README.md']);
  btn('Skip').click();
  await finish();
  assert.deepEqual(texts('fd-state'), ['Skipped', 'Copied']);
  assert.equal(one('fd-state').getAttribute('data-state'), 'skipped', 'the outcome is a value, not a colour');
  assert.deepEqual(texts('fd-title'), ['Copied 1 file into src. 1 skipped.']);
});

test('a file over the copy limit fails with its reason under its name', async () => {
  await reset();
  open('Home', [file('huge.bin', MAX_ITEM_BYTES + 1), file('small.txt')], []);
  // No conflict, so no question: the card opens already copying.
  assert.deepEqual(texts('fd-title'), ['Copying 2 items into Home']);
  await finish();
  assert.deepEqual(texts('fd-state'), ['Failed', 'Copied']);
  assert.deepEqual(texts('fd-note'), ['larger than the copy limit']);
  assert.equal(byClass(card().modal, 'fd-state')[0]?.getAttribute('data-state'), 'failed');
  assert.deepEqual(texts('fd-title'), ['Copied 1 file into Home. 1 failed.']);
});

test('no conflict: the card never asks a question it has no reason to ask', async () => {
  await reset();
  open('Home', [file('notes.txt')], ['other.txt']);
  assert.equal(FD.isDropDialogOpen(), true);
  assert.deepEqual(texts('fd-title'), ['Copying 1 item into Home']);
  assert.equal(btn('Hide').hidden, false, 'a copy nobody was asked about can be put away too');
  assert.equal(driver.starts, 1, 'the copy started without a question being asked');
  await finish();
  assert.deepEqual(texts('fd-title'), ['Copied 1 file into Home.']);
});

// ===========================================================================
// 3. Dismissal: Escape, the ×, the backdrop
// ===========================================================================

test('Escape on the question is Skip: the copy still runs for everything that does not clash', async () => {
  await reset();
  open('src', [file('README.md'), file('notes.txt')], ['README.md']);
  FD.dropDialogEscape();
  assert.equal(FD.isDropDialogOpen(), true, 'Skip is an answer, not a way out of the whole drop');
  assert.deepEqual(texts('fd-title'), ['Copying 2 items into src']);
  await finish();
  assert.deepEqual(texts('fd-state'), ['Skipped', 'Copied']);
});

test('the × on the question is Skip, and it says so to a screen reader', async () => {
  await reset();
  open('src', [file('README.md')], ['README.md']);
  assert.equal(one('fd-x').getAttribute('aria-label'), 'skip');
  one('fd-x').click();
  await finish();
  assert.deepEqual(texts('fd-state'), ['Skipped']);
  assert.deepEqual(texts('fd-title'), ['Nothing copied into src. 1 skipped.']);
});

test('a press on the backdrop is the same decision as the ×; a press in the card is none', async () => {
  await reset();
  open('src', [file('README.md')], ['README.md']);
  dispatch(one('fd-title'), 'mousedown');
  assert.deepEqual(texts('fd-title'), ['README.md already exists in src'], 'the card is not a dismissal');
  dispatch(card().scrim, 'mousedown');
  assert.deepEqual(texts('fd-title'), ['Copying 1 item into src'], 'the backdrop is Skip, like the ×');
});

test('Escape while it copies HIDES the card, and the copy runs on untouched', async () => {
  await reset();
  open('Home', [file('a.txt'), file('b.txt'), file('c.txt')], []);
  driver.step();
  const left = driver.pending();
  FD.dropDialogEscape();
  // The card is gone and the keyboard is back where the drop came from…
  assert.equal(FD.isDropDialogOpen(), false, 'the scrim is removed, not merely hidden');
  assert.equal(modalHost.children.length, 0);
  assert.equal(dom.doc.activeElement, opener);
  // …and NOTHING was cancelled: the run is still going, and still this one.
  assert.equal(FD.isDropRunning(), true);
  assert.equal(driver.pending(), left, 'a hidden card cancels nothing');
  assert.equal(driver.starts, 1, 'and restarts nothing');
  driver.step();
  assert.equal(driver.pending(), left - 1, 'the runner keeps settling rows with nobody watching');
  await finish();
  // The result is not swallowed: it arrives as ONE statusline sentence.
  assert.equal(flashText(), 'Copied 3 files into Home.');
  assert.equal(FD.isDropRunning(), false);
  assert.equal(FD.isDropDialogOpen(), false, 'and nothing re-opens');
});

test('the × and the backdrop hide it too — one decision, three ways to say it', async () => {
  for (const put of ['x', 'backdrop'] as const) {
    await reset();
    open('Home', [file('a.txt'), file('b.txt')], []);
    if (put === 'x') one('fd-x').click();
    else dispatch(card().scrim, 'mousedown');
    assert.equal(FD.isDropDialogOpen(), false, `${put} puts the card away`);
    assert.equal(FD.isDropRunning(), true, `${put} leaves the copy alone`);
    await finish();
    assert.equal(flashText(), 'Copied 2 files into Home.', `${put}: the result still arrives`);
  }
});

test('a HIDDEN run ends on the statusline ONLY: the card it left is not repainted and takes no keyboard', async () => {
  // Hiding does not bump the epoch, so the run still reports to callbacks that
  // are still live — and those callbacks must notice the card is gone. A
  // result painted into a removed card is a sentence nobody reads, and
  // `closeBtn.focus()` on a detached button takes the keyboard away from the
  // pane the user went back to.
  await reset();
  open('Home', [file('a.txt'), file('b.txt')], []);
  const { modal } = card();
  const whileCopying = modal.textContent;
  FD.dropDialogEscape();
  assert.equal(FD.isDropDialogOpen(), false, 'the card is away');
  assert.equal(dom.doc.activeElement, opener, 'and the keyboard went back with it');
  await finish();
  assert.equal(flashText(), 'Copied 2 files into Home.', 'the result arrives as one sentence, on the statusline');
  assert.equal(modal.textContent, whileCopying, 'the card that was put away is never painted again');
  assert.equal(dom.doc.activeElement, opener, 'and the keyboard stays where the user left it');
  assert.equal(FD.isDropDialogOpen(), false, 'nothing re-opens');
});

test('a copy still writing owns the app: a second drop opens no card, even with the first one HIDDEN', async () => {
  // The drag layer refuses a second drop while a copy runs, but it decides
  // that BEFORE its walk and its listing round trip — a copy can start inside
  // that window, and a hidden card leaves no scrim to catch the late arrival.
  // Two runs would interleave two lists of rows in one card and race the panel
  // refresh, so the running flag is the guard that has to hold on its own.
  await reset();
  open('Home', [file('a.txt'), file('b.txt')], []);
  const first = driver;
  FD.dropDialogEscape();
  assert.equal(FD.isDropDialogOpen(), false, 'the first card is away');
  assert.equal(FD.isDropRunning(), true, 'and its copy is still writing');
  const second = makeDriver([file('c.txt')], []);
  FD.openDropDialog({ dest: 'src', items: [file('c.txt')], listing: [], returnFocus: opener, run: second.run });
  assert.equal(FD.isDropDialogOpen(), false, 'no second card over a copy in flight');
  assert.equal(second.starts, 0, 'and not one write of a second drop');
  await finish();
  assert.equal(first.starts, 1, 'the first run was never restarted');
  assert.equal(flashText(), 'Copied 2 files into Home.', 'and it is the one that reports');
});

test('a copy that finishes while the card is STILL UP paints the result, and flashes nothing new', async () => {
  await reset();
  open('src', [file('a.txt')], []);
  const before = flashText();
  await finish();
  assert.deepEqual(texts('fd-title'), ['Copied 1 file into src.']);
  assert.equal(FD.isDropDialogOpen(), true, 'the card is the answer; the statusline is not');
  assert.equal(flashText(), before, 'the sentence is said once, in one place');
  assert.equal(dom.doc.activeElement, btn('Close'));
});

test('a run that THROWS still ends the card: the rows it never reached say so', async () => {
  await reset();
  open('src', [file('a.txt'), file('b.txt'), file('c.txt')], []);
  driver.step();
  driver.fail(new Error('the network went away'));
  await settle();
  assert.deepEqual(texts('fd-state'), ['Copied', 'Failed', 'Failed']);
  assert.deepEqual(texts('fd-note'), ['could not be copied', 'could not be copied']);
  assert.deepEqual(texts('fd-title'), ['Copied 1 file into src. 2 failed.']);
  assert.equal(FD.isDropRunning(), false, 'a run that threw is a run that is over');
  assert.equal(dom.doc.activeElement, btn('Close'));
});

test('the count follows the runner s progress, row by row, and the rows settle in its order', async () => {
  await reset();
  open('Home', [file('a.txt'), file('b.txt'), file('c.txt')], []);
  assert.deepEqual(texts('fd-step'), ['0 of 3'], 'nothing is done before anything answered');
  driver.step();
  assert.deepEqual(texts('fd-step'), ['1 of 3']);
  assert.deepEqual(texts('fd-state'), ['Copied', '', '']);
  driver.step();
  assert.deepEqual(texts('fd-step'), ['2 of 3']);
  assert.deepEqual(texts('fd-state'), ['Copied', 'Copied', '']);
  assert.equal(byClass(card().modal, 'is-pending').length, 1);
  // Every settled row asked to be scrolled into view, and only the settled ones.
  const rows = byClass(card().modal, 'fd-row');
  assert.deepEqual(
    rows.map((r) => r.scrolledInto.length),
    [1, 1, 0],
  );
  await finish();
  assert.deepEqual(texts('fd-step'), ['3 of 3']);
});

test('a row the SERVER refused: the word, the reason under the name, and the sentence that counts it', async () => {
  await reset();
  // The runner's answer, not the plan's: a refusal is only knowable from the
  // status a `PUT` came back with, which is exactly what the card cannot know.
  open('src', [file('a.txt'), folder('web'), file('c.txt')], [], (r, i) => {
    if (i === 1) return { ...r, state: 'failed', note: '3 of 12 files failed' };
    if (i === 2) return { ...r, state: 'failed', note: 'no room left on the disk' };
    return r;
  });
  await finish();
  assert.deepEqual(texts('fd-state'), ['Copied', 'Failed', 'Failed']);
  assert.deepEqual(texts('fd-note'), ['3 of 12 files failed', 'no room left on the disk']);
  assert.equal(byClass(card().modal, 'fd-state')[1]?.getAttribute('data-state'), 'failed');
  assert.deepEqual(texts('fd-title'), ['Copied 1 file into src. 2 failed.']);
  assert.equal(dom.doc.activeElement, btn('Close'));
});

test('Escape on the result closes, and the keyboard goes back to what the drop came from', () => {
  assert.equal(FD.isDropDialogOpen(), true, 'the previous test left the result up');
  FD.dropDialogEscape();
  assert.equal(FD.isDropDialogOpen(), false);
  assert.equal(modalHost.children.length, 0, 'created on open, removed on close');
  assert.equal(dom.doc.activeElement, opener, 'focus returns to the element the drop came from');
});

test('Close hands the keyboard back to the folder row the files were dropped on', async () => {
  // The drag layer hands over the element that had the focus when the drop
  // landed (`tests/ui/ui-filedrop.test.ts`), which for a drop on the Files panel
  // is the folder row itself — not the button this file otherwise opens from.
  await reset();
  const row = dom.doc.createElement('button');
  row.className = 'files-row is-dir';
  row.setAttribute('data-k', 'fdir:web/src');
  dom.body.append(row);
  row.focus();
  driver = makeDriver([file('a.txt')], []);
  FD.openDropDialog({
    dest: 'src',
    items: [file('a.txt')],
    listing: [],
    returnFocus: row,
    run: driver.run,
  });
  assert.notEqual(dom.doc.activeElement, row, 'non-vacuity: the card took the keyboard first');
  await finish();
  btn('Close').click();
  assert.equal(FD.isDropDialogOpen(), false);
  assert.equal(dom.doc.activeElement, row);
  row.remove();
});

test('Close is the same as Escape on the result', async () => {
  await reset();
  open('Home', [file('a.txt')], []);
  await finish();
  btn('Close').click();
  assert.equal(FD.isDropDialogOpen(), false);
  assert.equal(dom.doc.activeElement, opener);
});

// ===========================================================================
// 4. isDropDialogOpen, and the two drops that open nothing
// ===========================================================================

test('isDropDialogOpen: false, true from the first paint, false again after close', async () => {
  await reset();
  assert.equal(FD.isDropDialogOpen(), false);
  open('Home', [file('a.txt')], []);
  assert.equal(FD.isDropDialogOpen(), true, 'true while it copies');
  await finish();
  assert.equal(FD.isDropDialogOpen(), true, 'true while the result stands');
  btn('Close').click();
  assert.equal(FD.isDropDialogOpen(), false);
});

test('one dialog per drop: a second drop while one is up is ignored', async () => {
  await reset();
  open('src', [file('README.md')], ['README.md']);
  FD.openDropDialog({
    dest: 'web',
    items: [file('other.txt')],
    listing: [],
    returnFocus: null,
    run: makeDriver([file('other.txt')], []).run,
  });
  assert.equal(modalHost.children.length, 1, 'one card, not two');
  assert.deepEqual(texts('fd-title'), ['README.md already exists in src'], 'the first drop still owns the card');
});

test('a drop carrying nothing opens no dialog', async () => {
  await reset();
  open('Home', [], []);
  assert.equal(FD.isDropDialogOpen(), false);
  assert.equal(modalHost.children.length, 0);
});

// ===========================================================================
// 5. The copy rules, read off what the card really rendered
// ===========================================================================

test('nothing the card renders carries a path, a byte count or a decorative dash', async () => {
  await reset();
  const said: string[] = [];
  open('src', [file('README.md'), file('huge.bin', MAX_ITEM_BYTES + 1), folder('web')], ['README.md']);
  said.push(rendered());
  btn('Keep both').click();
  said.push(rendered());
  await finish();
  said.push(rendered());
  btn('Close').click();

  assert.ok(said.length === 3 && said.every((s) => s.length > 40), 'non-vacuity: three states were really read');
  for (const s of said) {
    assert.equal(/[/\\]/.test(s.replace(/README\.md|huge\.bin/g, '')), false, `a path reached the card: ${s}`);
    assert.equal(s.includes(' — '), false, `a decorative dash reached the card: ${s}`);
    assert.equal(s.includes(' · '), false, `a decorative separator reached the card: ${s}`);
    assert.equal(s.includes(String(MAX_ITEM_BYTES)), false, `a byte count reached the card: ${s}`);
    assert.equal(/\d+ (?:bytes|KB|MB|MiB)/.test(s), false, `a size reached the card: ${s}`);
  }
});
