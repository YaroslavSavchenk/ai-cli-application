/**
 * `web/src/ui/files.ts` — how a create's name row ends WITHOUT a create
 * (Nocturne part A9c, `.claude/plans/nocturne/PLAN-B2.md` §6b): Escape, blur and
 * `main.ts`'s Escape ladder; a create answered after the user walked away;
 * and everything else that cancels it (a tab switch, a root change, the panel
 * leaving the screen, a menu, its folder closing or leaving the tree). Driven
 * through the REAL panel and row menu on the DOM double against the fake
 * `FsGateway` (shared setup: `tests/helpers/ui-files-create-fixture.ts`).
 * Split from `tests/ui/ui-files-create.test.ts`.
 *
 * How: `main.ts`'s Escape ladder is mirrored by a window listener below, and
 * every key that reaches the window is recorded — the name row spends a key
 * itself only if nothing at all arrives up there.
 *
 * Why: a blur that COMMITS writes to the filesystem because somebody clicked
 * away; an Escape that does not stop propagating spends one keystroke on three
 * rungs of the ladder (the name row, the selection, the panel); a create left
 * standing across a tab switch, a root change or a hidden panel is a post
 * aimed at a folder nobody is looking at any more.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`): that
 * the row is legible, that it really changes no layout (the CSS block is read
 * as source below), that a real `<input>` takes a keystroke, screen-reader
 * output, and anything the server does with the request.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { byClass, byKey, dispatch, textsOf, type FakeElement } from '../helpers/fake-dom.ts';
import { FakeApiError, PROJ, PROJ2, settle, type CreateCall } from '../helpers/fs-fixture.ts';
import {
  fx,
  dom,
  st,
  F,
  CM,
  termInput,
  panel,
  root,
  focusSession,
  dirRow,
  newRow,
  errRow,
  nameField,
  menuEl,
  background,
  rightClick,
  choose,
  type,
  pressEnter,
  pressEscape,
  liveSession,
  resetWorld,
} from '../helpers/ui-files-create-fixture.ts';

/**
 * `main.ts`'s Escape ladder, mirrored (the same mirror the menu tests use):
 * A9c may not touch that ladder, so this is how "the name row's Escape never
 * reaches it" is checked without importing main.ts.
 */
let ladderSaw = 0;
dom.win.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  ladderSaw += 1;
});

/**
 * EVERY key that reaches the window, not just Escape. The `?` overlay, the
 * shortcuts chord and the ctrl+alt family all live on window listeners, so
 * "the name row spends the key itself" is only true if nothing at all arrives
 * up there — an Enter that bubbled would be read by whatever is listening the
 * day after this test was written.
 */
const winKeys: string[] = [];
dom.win.addEventListener('keydown', (e) => {
  winKeys.push(e.key);
});

beforeEach(async () => {
  await resetWorld(() => {
    ladderSaw = 0;
    winKeys.length = 0;
  });
});

afterEach(() => {
  CM.closeRowMenu();
});

// ---------------------------------------------------------------------------
// Escape, blur, and the ladder (§6b)
// ---------------------------------------------------------------------------

test('Escape cancels the name row and NOTHING else — three presses, three effects', async () => {
  await liveSession();
  dirRow('web').click(); // a click selects the row (A9b)
  await settle();
  assert.deepEqual(F.selectedFolder(), { path: `${PROJ}/web`, name: 'web' }, 'non-vacuity');
  choose(dirRow('web'), 'New file');
  type('half');
  ladderSaw = 0;

  // 1. the name row.
  const first = pressEscape(nameField());
  assert.equal(first.defaultPrevented, true);
  assert.equal(first.cancelBubble, true, 'the key is spent on the name row');
  assert.equal(ladderSaw, 0, 'and main.ts s ladder never sees it');
  assert.equal(newRow(), undefined, 'the row is gone');
  assert.deepEqual(
    F.selectedFolder(),
    { path: `${PROJ}/web`, name: 'web' },
    'the chosen folder is untouched by the first press',
  );
  assert.equal(st.state.leftPanel, 'files', 'and the panel is still there');
  assert.deepEqual(fx.createCalls, [], 'a cancel posts nothing');
  // The keyboard is back INSIDE the panel, which is what makes the next rung
  // reachable at all: the panel's own Escape listener lives on its root.
  assert.equal(dom.doc.activeElement, dirRow('web'), 'back on the row the menu came from');

  // 2. the selection.
  const second = pressEscape(dirRow('web'));
  assert.equal(second.cancelBubble, true);
  assert.deepEqual(F.selectedFolder(), null);
  assert.equal(st.state.leftPanel, 'files');

  // 3. the panel — main.ts's rung, so the key must REACH the window.
  ladderSaw = 0;
  const third = pressEscape(dirRow('web'));
  assert.equal(third.cancelBubble, false, 'with nothing of its own left, the key goes through');
  assert.equal(ladderSaw, 1, 'and the ladder closes the panel');
});

test('a name row for the ROOT hands the keyboard back to a control inside the panel', async () => {
  await liveSession();
  choose(background(), 'New file');
  pressEscape(nameField());
  assert.equal(newRow(), undefined);
  const back = dom.doc.activeElement as FakeElement;
  assert.equal(
    back.closest('.files-view') !== null,
    true,
    'a keyboard on <body> would skip a rung of the ladder',
  );
  assert.equal(back.getAttribute('data-k'), 'fcopy');
});

test('Enter is spent ON the name row: no window handler ever sees it', async () => {
  await liveSession();
  choose(dirRow('web'), 'New file');
  type('notes.md');
  winKeys.length = 0;
  const e = pressEnter();
  assert.equal(e.defaultPrevented, true, 'a bare Enter in a field submits, and there is no form here');
  assert.equal(e.cancelBubble, true, 'the key is the name row s, and it is spent there');
  assert.deepEqual(
    winKeys,
    [],
    'the window is where the ? overlay and the ctrl+alt family listen: a key that arrives there is a second effect on one press',
  );
  assert.equal(fx.createCalls.length, 1, 'non-vacuity: that Enter really did post');
  await settle();
  // And the Enter that is REFUSED by the client rules is spent just as hard:
  // the request is what differs, never who owns the key.
  choose(dirRow('web'), 'New file');
  type('a/b');
  winKeys.length = 0;
  const bad = pressEnter();
  assert.equal(bad.defaultPrevented, true);
  assert.equal(bad.cancelBubble, true);
  assert.deepEqual(winKeys, []);
  assert.equal(fx.createCalls.length, 1, 'non-vacuity: the slash cost no request');
});

test('the panel s own chord steps aside for the name row — one menu, never two', async () => {
  await liveSession();
  for (const init of [{ key: 'ContextMenu' }, { key: 'F10', shiftKey: true }]) {
    choose(dirRow('web'), 'New file');
    type('half');
    assert.equal(dom.doc.activeElement, nameField(), 'non-vacuity: the keyboard is in the input');
    // The input lives INSIDE a `.files-row`, which is exactly what the panel's
    // own chord arm steps aside for: the row owns the gesture, and the name row
    // has no menu of its own. A root menu opening here would also CANCEL the
    // create, which is the silent half of the bug.
    const e = dispatch(nameField(), 'keydown', init);
    assert.equal(byClass(dom.body, 'cm-menu').length, 0, `${init.key} opened a menu over the name row`);
    assert.equal(e.defaultPrevented, false, `${init.key} was taken by the panel`);
    assert.ok(newRow() !== undefined, 'and the half-typed name is still there');
    assert.equal(nameField().value, 'half');
    pressEscape(nameField());
  }
  assert.deepEqual(fx.createCalls, []);
  // A focused ROW still answers the chord with exactly ONE menu: its own.
  dirRow('web').focus();
  dispatch(dirRow('web'), 'keydown', { key: 'ContextMenu' });
  assert.equal(byClass(dom.body, 'cm-menu').length, 1);
  assert.equal(menuEl()?.getAttribute('aria-label'), 'actions for web');
  CM.closeRowMenu();
});

test('blur CANCELS, it never commits', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  type('docs');
  nameField().blur();
  assert.equal(newRow(), undefined, 'the row is gone');
  assert.deepEqual(fx.createCalls, [], 'clicking away must never write to the filesystem');
});

test('a blur LEAVES the keyboard where the user put it; only Escape brings it back', async () => {
  // The two cancels differ in exactly one thing. A blur is the browser ALREADY
  // moving the keyboard somewhere the user chose — a terminal, another window
  // — and a panel that focused a tree row from inside that transfer would send
  // the next keystrokes to a Files row instead of to a PTY.
  await liveSession();
  choose(dirRow('web'), 'New folder');
  type('docs');
  termInput.focus(); // the click that lands in the terminal
  dispatch(nameField(), 'blur'); // the browser's own notification, after the move
  assert.equal(newRow(), undefined, 'the question is gone');
  assert.deepEqual(fx.createCalls, []);
  assert.equal(dom.doc.activeElement, termInput, 'the panel yanked the keyboard out of a terminal');
  assert.equal(
    (dom.doc.activeElement as FakeElement).closest('.files-view'),
    null,
    'nothing in the panel may hold the keyboard after a blur',
  );

  // ESCAPE is the other caller, and it is a ladder rung: the keyboard has to
  // come back INSIDE the panel, or the next press skips to closing it.
  choose(dirRow('web'), 'New folder');
  type('docs');
  pressEscape(nameField());
  assert.equal(newRow(), undefined);
  assert.ok(
    (dom.doc.activeElement as FakeElement).closest('.files-view') !== null,
    'Escape hands the keyboard back to the panel',
  );
});

test('the row a create made takes the keyboard only while the keyboard is still ours', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  type('docs');
  // The listing that will carry the new row is held, which is the real gap:
  // the create is answered, the tree is not, and a user can click into a
  // terminal in between.
  fx.holdIf((c) => c.kind === 'entries' && c.path === `${PROJ}/web`);
  pressEnter();
  await settle();
  assert.equal(fx.createCalls.length, 1, 'non-vacuity: the create landed');
  termInput.focus();
  fx.release();
  await settle();
  const made = byKey(root, `fdir:${PROJ}/web/docs`) as FakeElement;
  assert.ok(made !== null, 'non-vacuity: the row really did arrive');
  assert.equal(
    dom.doc.activeElement,
    termInput,
    'a row that arrives after the user went to a terminal must not take the keyboard',
  );
  // And the promise is spent, not saved up: the next repaint may not grab it.
  panel.render();
  assert.equal(dom.doc.activeElement, termInput);
});

// ---------------------------------------------------------------------------
// The late answer (§6b): a create the user walked away from
// ---------------------------------------------------------------------------

/**
 * One create whose answer this test holds and then REFUSES. The fixture can
 * hold a success (`holdCreate`) but rejects at call time, and a refusal that
 * lands after a cancel is exactly the case `createToken` exists for — so the
 * gateway's own `create` is swapped for the length of one test and put back.
 */
function deferCreate(): { reject(err: unknown): void; restore(): void } {
  const real = fx.gateway.create.bind(fx.gateway);
  let rej: ((e: unknown) => void) | null = null;
  fx.gateway.create = (dir: string, name: string, kind: 'file' | 'folder') => {
    fx.createCalls.push({ dir, name, kind } satisfies CreateCall);
    return new Promise<{ path: string }>((_res, r) => {
      rej = r;
    });
  };
  return {
    reject(err: unknown): void {
      rej?.(err);
    },
    restore(): void {
      fx.gateway.create = real;
    },
  };
}

test('a create ANSWERED after a cancel re-reads its folder and does nothing else', async () => {
  for (const kind of ['New file', 'New folder'] as const) {
    await liveSession();
    const leaf = kind === 'New file' ? 'notes.md' : 'docs';
    fx.holdCreate();
    choose(dirRow('web'), kind);
    type(leaf);
    pressEnter();
    await settle();
    assert.equal(fx.createCalls.length, 1, `${kind}: non-vacuity, the request is out`);
    const slots = JSON.stringify(st.activeView()?.slots ?? null);
    const chosen = JSON.stringify(F.selectedFolder());
    // The user walks away: Escape, while the server is still writing.
    pressEscape(nameField());
    assert.equal(newRow(), undefined, `${kind}: non-vacuity, the question is gone`);
    // The keyboard is read as a KEY, not as an element: the re-read below
    // rebuilds the rows, so the element that has it afterwards is a fresh one
    // carrying the same promise.
    const backKey = (dom.doc.activeElement as FakeElement).getAttribute('data-k');
    fx.entryCalls.length = 0;
    fx.releaseCreate();
    await settle();
    // THE THING EXISTS ON DISK. The user cancelled the QUESTION, not the
    // create that had already been posted — so the folder it went into is read
    // again, or the tree would keep hiding a file whose name the next attempt
    // is about to be refused for (§1d's 409, with nothing on screen to explain
    // it). Exactly once, and for that folder only.
    assert.deepEqual(fx.entryCalls, [`${PROJ}/web`], `${kind}: the folder must be re-read, once`);
    // NOT asserted: that no row for it appears. The fake writes the new entry
    // into the tree it already handed out, so a row can turn up on the next
    // repaint for reasons that are the fixture's, not the panel's — what the
    // panel owes here is the four effects below, and the re-read above.
    assert.equal(
      (dom.doc.activeElement as FakeElement).getAttribute('data-k'),
      backKey,
      `${kind}: the keyboard followed a create the user had already walked away from`,
    );
    assert.equal(
      JSON.stringify(st.activeView()?.slots ?? null),
      slots,
      `${kind}: a pane opened for a create that was cancelled`,
    );
    assert.equal(JSON.stringify(F.selectedFolder()), chosen, `${kind}: the selection moved`);
    assert.equal(errRow(), undefined, `${kind}: a sentence for a question nobody asked`);
    fx.reset();
  }
});

test('a REFUSAL that lands after a cancel is not painted at anybody', async () => {
  await liveSession();
  const held = deferCreate();
  try {
    choose(dirRow('web'), 'New folder');
    type('src');
    pressEnter();
    await settle();
    assert.equal(fx.createCalls.length, 1, 'non-vacuity: the request is out');
    pressEscape(nameField());
    assert.equal(newRow(), undefined, 'non-vacuity: the question is gone');
    const back = dom.doc.activeElement;
    held.reject(new FakeApiError(409, 'That name is already taken.'));
    await settle();
    assert.equal(errRow(), undefined, 'a refusal for a name nobody is typing any more');
    assert.equal(newRow(), undefined, 'and no name row came back to carry it');
    assert.equal(
      textsOf(root, 'files-name').includes('That name is already taken.'),
      false,
      'the sentence reached the tree',
    );
    assert.equal(dom.doc.activeElement, back, 'and the keyboard was not yanked back into a dead field');
  } finally {
    held.restore();
  }
});

test('a create answered after the ROOT moved lands in neither tree', async () => {
  await liveSession();
  fx.holdCreate();
  choose(dirRow('web'), 'New file');
  type('notes.md');
  pressEnter();
  await settle();
  assert.equal(fx.createCalls.length, 1, 'non-vacuity: the request is out');
  focusSession('s2');
  panel.render();
  await settle();
  // Read AFTER the switch: the other session is another view, so the pane this
  // watches is the one the late answer could still open a file in.
  const slots = JSON.stringify(st.activeView()?.slots ?? null);
  assert.deepEqual(
    F.filesPanelDestination(),
    { path: PROJ2, name: 'tools' },
    'non-vacuity: the root really moved',
  );
  fx.entryCalls.length = 0;
  fx.releaseCreate();
  await settle();
  assert.deepEqual(fx.entryCalls, [], 'the folder it was made in belongs to a tree nobody is looking at');
  assert.equal(byKey(root, `ffile:${PROJ}/web/notes.md`), null);
  assert.equal(byKey(root, `ffile:${PROJ2}/web/notes.md`), null, 'and it is not invented in the new one');
  assert.equal(
    JSON.stringify(st.activeView()?.slots ?? null),
    slots,
    'no pane opened for a file the panel stopped being about',
  );
  assert.equal(newRow(), undefined);
});

// ---------------------------------------------------------------------------
// Everything else that cancels it (§6b)
// ---------------------------------------------------------------------------

test('a TAB switch cancels it', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  type('docs');
  const changes = byKey(root, 'ftab:changes') as FakeElement;
  assert.equal(changes.disabled, false, 'non-vacuity: the fixture root is a repository');
  changes.click();
  await settle();
  assert.equal(newRow(), undefined);
  (byKey(root, 'ftab:files') as FakeElement).click();
  await settle();
  assert.equal(newRow(), undefined, 'and coming back does not bring the question back');
  assert.deepEqual(fx.createCalls, []);
});

test('a ROOT change cancels it', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  type('docs');
  focusSession('s2');
  panel.render();
  await settle();
  assert.equal(newRow(), undefined, 'the folder it was inside is not even in this tree');
  assert.deepEqual(fx.createCalls, []);
  assert.deepEqual(
    F.filesPanelDestination(),
    { path: PROJ2, name: 'tools' },
    'non-vacuity: the root really moved',
  );
});

test('the panel leaving the screen cancels it', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  type('docs');
  st.state.leftPanel = null;
  panel.render();
  st.state.leftPanel = 'files';
  panel.render();
  await settle();
  assert.equal(newRow(), undefined, 'a question nobody could see must not come back');
  assert.deepEqual(fx.createCalls, []);
});

test('any menu opening cancels it — on a row and on the background alike', async () => {
  await liveSession();
  for (const on of [(): FakeElement => dirRow('server'), background]) {
    choose(dirRow('web'), 'New folder');
    type('docs');
    rightClick(on());
    assert.ok(menuEl() !== undefined, 'the menu is up');
    assert.equal(newRow(), undefined, 'and the half-typed name is not under it');
    CM.closeRowMenu();
  }
  assert.deepEqual(fx.createCalls, []);
});

test('a name row whose folder CLOSES under it is dropped, not left hanging off a shut row', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  assert.ok(newRow() !== undefined, 'non-vacuity');
  // The primary click on the folder closes it, and §6b's own rule is that the
  // folder is open while its name row is up: a row at the child indent under a
  // shut folder would name a place the tree is no longer showing.
  dirRow('web').click();
  await settle();
  assert.equal(dirRow('web').getAttribute('aria-expanded'), 'false');
  assert.equal(newRow(), undefined);
  assert.deepEqual(fx.createCalls, []);
});

test('a name row whose folder LEAVES the tree is dropped too', async () => {
  await liveSession();
  choose(dirRow('web/src'), 'New file');
  assert.ok(newRow() !== undefined, 'non-vacuity');
  // Closing the ANCESTOR takes the row the name row was anchored to off screen
  // entirely: `createRowIndex` answers -1 and the create is dropped rather than
  // drawn somewhere arbitrary.
  dirRow('web').click();
  await settle();
  assert.equal(newRow(), undefined);
  assert.deepEqual(fx.createCalls, []);
});
