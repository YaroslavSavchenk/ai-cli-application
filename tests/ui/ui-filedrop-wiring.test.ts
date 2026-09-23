/**
 * `web/src/ui/filedrop.ts` — the boot guard (`installDropGuard`, before the
 * shell exists at all) and the wiring that only exists outside the module:
 * the CSS rules behind its classes, `main.ts`'s drop layer and copy runner,
 * and that `web/src` has no HTML5 `dragstart` (Nocturne parts A9, B10).
 * Split from `tests/ui/ui-filedrop.test.ts`.
 *
 * How: the guard's window handlers are read off the DOM double and CALLED in
 * isolation (a dispatched event would run the real layer too); the wiring is
 * read as source (`readSource`, `APP_CSS`) because `main.ts`'s import graph
 * reaches @xterm/xterm, a browser bundle.
 *
 * Why: a file dropped while boot() is still awaiting navigates the browser to
 * the file; an unwired dep in `main.ts` leaves every injected-deps test green.
 *
 * NOT claimed: that a real browser runs the guard before its first drop, and
 * the rendered drop highlight (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  dispatch,
  makeDataTransfer,
  type FakeDataTransfer,
  type FakeEvent,
  type FakeFile,
} from '../helpers/fake-dom.ts';
import { APP_CSS, stripComments } from '../helpers/tokens-helpers.ts';
import { readSource, projectRoot, filesUnder } from '../helpers/helpers.ts';
import {
  dom,
  FD,
  type Dest,
  type DropRequest,
  dest,
  rowSrc,
  filesAside,
  termTextarea,
  scrim,
  LISTINGS,
  type FileLikeIn,
  OVER_ROW,
  dragOver,
  FILES_DT,
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
  const main = readSource('web', 'src', 'main.ts');
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
  const main = readSource('web', 'src', 'main.ts');
  assert.ok(main.length > 10_000, 'non-vacuity: main.ts');
  assert.match(
    main,
    /import \{ initFileDrop, installDropGuard, type DropRequest \} from '\.\/ui\/filedrop\.ts';/,
  );
  const panel = main.indexOf('const filesPanel = initFilesPanel(');
  const wire = main.indexOf('initFileDrop({');
  assert.ok(panel > 0 && wire > 0, 'both calls must exist');
  assert.ok(wire > panel, 'three of its deps are that panel s own subject()');
  const call = main.slice(wire, main.indexOf('});', wire));
  for (const dep of [
    'openDialog:',
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

test('main.ts is where the copy is built: the runner, the refresh and the one log line (B10)', () => {
  // Same reason as the test above: every unit test in this file injects
  // `openDialog`, so the whole real copy could be unbuilt in the shell and
  // nothing here would notice. This is the seam where the destination's PATH
  // stops — the dialog is handed the name and a runner closed over the rest.
  const main = readSource('web', 'src', 'main.ts');
  const open = main.indexOf('function openDrop(');
  assert.ok(open > 0, 'the drop is handed over by a function of its own');
  const body = main.slice(open, main.indexOf('\n  }\n', open));
  assert.ok(body.includes('createDropRun({'), 'the runner is built here');
  for (const line of ['dest: req.dest,', 'walk: req.walk,', 'listing: req.listing,']) {
    assert.ok(body.includes(line), `the runner is built without ${line}`);
  }
  assert.ok(body.includes('api.fsUpload(dir, rel, mode, body)'), 'put is the upload route');
  assert.ok(body.includes("api.fsCreate(dir, name, 'folder')"), 'an empty folder is the create route');
  assert.ok(body.includes('dest: req.dest.name,'), 'the dialog gets a NAME and never a path');
  // After the copy, once: the panel re-reads and ONE line is logged, counts only.
  assert.ok(body.includes('refreshAfterDrop(req.dest);'), 'the panel is refreshed after the drop');
  assert.ok(body.includes('api.logDrop('), 'one summary line per drop');
  assert.equal(
    body.split('refreshAfterDrop(').length - 1,
    1,
    'refreshed ONCE per drop, never per file',
  );
  assert.match(
    main,
    /import \{ createDropRun \} from '\.\/ui\/drop-upload\.ts';/,
    'the runner comes from the module that owns the writes',
  );
  assert.match(main, /import \{[^}]*\brefreshAfterDrop,[^}]*\} from '\.\/ui\/files\.ts';/s);
});

test('web/src has no `draggable` attribute and adds no `dragstart` listener', () => {
  const root = join(projectRoot, 'web', 'src');
  const files = filesUnder(root, /\.(ts|html|css)$/);
  assert.ok(files.length >= 20, `non-vacuity: scanned ${files.length} files`);
  // The mirror of the `draggable` pin in tests/ui/ui-dnd-a10.test.ts: an in-app
  // source that opted into HTML5 DnD would fire the handlers in filedrop.ts
  // with no `Files` in its types and a target this module never resolved.
  const offenders = files.filter((f) => /['"]dragstart['"]/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => f.slice(root.length + 1)), []);
});
