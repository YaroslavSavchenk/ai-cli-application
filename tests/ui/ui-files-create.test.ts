/**
 * `web/src/ui/files.ts` — creating a file or a folder from the Files panel
 * (Nocturne part A9c, `.claude/plans/nocturne/PLAN-B2.md` §6a and §6b), driven through the
 * REAL panel, the REAL row menu and the REAL `ui/fs-model.ts` on the DOM
 * double in `tests/helpers/fake-dom.ts`, against the fake `FsGateway` of
 * `tests/helpers/fs-fixture.ts` (shared setup:
 * `tests/helpers/ui-files-create-fixture.ts`). This file: the entries, the
 * name row, what Enter posts, inline validation, in flight, success, Refresh,
 * and the classes, tokens and copy.
 *
 * WHY THIS FILE EXISTS, next to `ui-context-menu.test.ts` (which menu opens
 * where) and `ui-files-panel.test.ts` (how the tree loads). What A9c adds is a
 * piece of state that lives for a few seconds between a menu and a POST, and
 * every way it can be wrong is silent:
 *
 *   1. a name row drawn at the wrong indent, or inside a folder nobody opened,
 *      promises a place the file will not be created in;
 *   2. a client rule that is not mirrored sends the server a name it is
 *      certain to refuse — and one that is mirrored WRONG refuses a name the
 *      server would have taken;
 *   3. an Enter that posts twice creates one thing and refuses the second with
 *      a conflict the user never typed.
 *
 * Everything that ends a name row WITHOUT a create (Escape, blur, the ladder,
 * a late answer, a tab switch, a root change) is in
 * `tests/ui/ui-files-create-cancel.test.ts`.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`): that
 * the row is legible, that it really changes no layout (the CSS block is read
 * as source below), that a real `<input>` takes a keystroke, screen-reader
 * output, and anything the server does with the request.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { byClass, byKey, textsOf, type FakeElement } from '../helpers/fake-dom.ts';
import {
  APP_CSS,
  declaredTokens,
  mySections,
  stripComments,
  usedTokens,
} from '../helpers/tokens-helpers.ts';
import { FakeApiError, PROJ, settle } from '../helpers/fs-fixture.ts';
import {
  fx,
  dom,
  FILES_SRC,
  st,
  F,
  CM,
  type ViewLike,
  root,
  dirRow,
  fileRow,
  rows,
  newRow,
  errRow,
  nameField,
  labels,
  background,
  rightClick,
  choose,
  type,
  pressEnter,
  liveSession,
  resetWorld,
} from '../helpers/ui-files-create-fixture.ts';

beforeEach(async () => {
  await resetWorld();
});

afterEach(() => {
  CM.closeRowMenu();
});

// ---------------------------------------------------------------------------
// The entries (§6a)
// ---------------------------------------------------------------------------

test('a FOLDER row offers New file and New folder; a FILE row offers neither', async () => {
  await liveSession();
  rightClick(dirRow('web'));
  // `Delete` is the last entry since B10a and `Rename` sits right above it
  // since B13, so the three A9c entries are the ones before those two.
  assert.deepEqual(labels().slice(-5, -2), ['New file', 'New folder', 'Refresh']);
  CM.closeRowMenu();
  rightClick(fileRow('README.md'));
  for (const label of ['New file', 'New folder', 'Refresh']) {
    assert.equal(
      labels().includes(label),
      false,
      `a file row must not offer ${label}: ${labels().join(', ')}`,
    );
  }
});

test('the panel s BACKGROUND offers them too — the root is a folder like any other', async () => {
  await liveSession();
  rightClick(background());
  assert.deepEqual(labels(), ['Copy files here…', 'New file', 'New folder', 'Refresh']);
});

// ---------------------------------------------------------------------------
// The name row (§6b)
// ---------------------------------------------------------------------------

test('New folder puts one name row INSIDE the folder, at the child indent, with the keyboard', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  const row = newRow() as FakeElement;
  assert.ok(row !== undefined, 'a name row');
  assert.equal(byClass(root, 'is-new').length, 1, 'exactly one');
  // Right AFTER the folder's own row: the thing being named is visibly inside
  // the folder that will hold it.
  const all = rows();
  assert.equal(all.indexOf(row), all.indexOf(dirRow('web')) + 1);
  // rowIndent(depth) = 8 + depth * 14, and `web` is a child of the root, so its
  // own children sit at depth 1.
  assert.equal(row.style.paddingLeft, '22px');
  assert.equal(dirRow('web').style.paddingLeft, '8px', 'non-vacuity: the parent is one step out');
  // The field is the label, and it has the keyboard on the repaint that made it.
  const input = nameField();
  assert.equal(input.tagName, 'INPUT');
  assert.equal(input.getAttribute('aria-label'), 'new folder name');
  assert.equal(input.spellcheck, false);
  assert.equal(input.getAttribute('autocapitalize'), 'off');
  assert.equal(input.readOnly, false);
  assert.equal(dom.doc.activeElement, input, 'it takes the keyboard on the repaint that made it');
  // The KIND is visible before a letter is typed: a folder wears the mark.
  assert.equal(byClass(row, 'files-folder').length, 1);
  assert.equal(byClass(row, 'files-icon').length, 0);
});

test('New file wears the plain file glyph and says so to a screen reader', async () => {
  await liveSession();
  choose(dirRow('web'), 'New file');
  const row = newRow() as FakeElement;
  assert.equal(nameField().getAttribute('aria-label'), 'new file name');
  assert.equal(byClass(row, 'files-icon').length, 1, 'a file mark, with no type to claim yet');
  assert.equal(byClass(row, 'files-folder').length, 0);
  const icon = byClass(row, 'files-icon')[0];
  assert.equal(icon?.getAttribute('data-icon'), 'file', 'the plain file glyph (B12)');
  assert.equal(icon?.getAttribute('data-kind'), 'plain');
  assert.equal(icon?.getAttribute('aria-hidden'), 'true');
});

test('a CLOSED folder is opened — and fetched — before the row is drawn in it', async () => {
  await liveSession();
  assert.equal(dirRow('shared').getAttribute('aria-expanded'), 'false', 'non-vacuity: closed');
  assert.equal(fx.entryCalls.includes(`${PROJ}/shared`), false, 'and never listed yet');
  choose(dirRow('shared'), 'New file');
  assert.equal(
    dirRow('shared').getAttribute('aria-expanded'),
    'true',
    'a name row in a closed folder is a promise about a place nobody can see',
  );
  assert.deepEqual(fx.entryCalls, [`${PROJ}/shared`]);
  await settle();
  const all = rows();
  assert.equal(all.indexOf(newRow() as FakeElement), all.indexOf(dirRow('shared')) + 1);
  assert.equal((newRow() as FakeElement).style.paddingLeft, '22px');
  assert.ok(byKey(root, `fdir:${PROJ}/shared/empty`) !== null, 'the listing landed around it');
});

test('the ROOT s name row sits at the top of the tree, at depth 0, and opens nothing', async () => {
  await liveSession();
  const before = fx.entryCalls.length;
  choose(background(), 'New folder');
  const row = newRow() as FakeElement;
  assert.equal(rows().indexOf(row), 0, 'the root has no row: its children start the tree');
  assert.equal(row.style.paddingLeft, '8px');
  assert.equal(fx.entryCalls.length, before, 'the root is already listed — nothing is fetched');
});

test('ONE at a time: a second choice moves the row, it never draws two', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  type('half-typed');
  choose(dirRow('server'), 'New file');
  assert.equal(byClass(root, 'is-new').length, 1);
  const all = rows();
  assert.equal(all.indexOf(newRow() as FakeElement), all.indexOf(dirRow('server')) + 1);
  assert.equal(nameField().value, '', 'the new row starts empty: it is a different question');
  assert.equal(nameField().getAttribute('aria-label'), 'new file name');
});

// ---------------------------------------------------------------------------
// Enter: what is posted
// ---------------------------------------------------------------------------

test('Enter posts {dir, name, kind} exactly ONCE', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  type('docs');
  pressEnter();
  assert.deepEqual(fx.createCalls, [{ dir: `${PROJ}/web`, name: 'docs', kind: 'folder' }]);
  await settle();
  assert.equal(fx.createCalls.length, 1, 'one gesture, one create');
});

test('a create for the ROOT posts the root s own path', async () => {
  await liveSession();
  choose(background(), 'New file');
  type('TODO.md');
  pressEnter();
  assert.deepEqual(fx.createCalls, [{ dir: PROJ, name: 'TODO.md', kind: 'file' }]);
  await settle();
});

test('Enter while the request is out posts nothing more', async () => {
  await liveSession();
  fx.holdCreate();
  choose(dirRow('web'), 'New folder');
  type('docs');
  pressEnter();
  await settle();
  pressEnter();
  pressEnter();
  assert.equal(fx.createCalls.length, 1, 'a second Enter must not post a second create');
  fx.releaseCreate();
  await settle();
});

// ---------------------------------------------------------------------------
// Validation, inline (§6b)
// ---------------------------------------------------------------------------

test('each client rule shows its sentence under the row, and costs NO request', async () => {
  await liveSession();
  const cases: [string, string][] = [
    ['', 'Type a name first.'],
    ['a/b', 'A name cannot contain a slash.'],
    ['a\\b', 'A name cannot contain a slash.'],
    ['..', 'That name is not allowed.'],
    ['x', 'That name is not allowed.'],
    ['x'.repeat(256), 'That name is too long.'],
  ];
  for (const [typed, sentence] of cases) {
    choose(dirRow('web'), 'New file');
    type(typed);
    pressEnter();
    const err = errRow() as FakeElement;
    assert.ok(err !== undefined, `no sentence for ${JSON.stringify(typed)}`);
    assert.equal(textsOf(err, 'files-name')[0], sentence);
    // Directly beneath the name row, at the same indent: nothing else moved.
    const all = rows();
    assert.equal(all.indexOf(err), all.indexOf(newRow() as FakeElement) + 1);
    assert.equal(err.style.paddingLeft, (newRow() as FakeElement).style.paddingLeft);
    assert.equal(nameField().value, typed, 'the text stays: the next thing you do is fix it');
    assert.equal(dom.doc.activeElement, nameField(), 'and so does the keyboard');
    assert.deepEqual(fx.createCalls, [], `${JSON.stringify(typed)} reached the server`);
  }
  // Non-vacuity: a name the rules allow really does post.
  type('ok.md');
  pressEnter();
  assert.equal(fx.createCalls.length, 1);
  await settle();
});

test('a name the server refuses shows the SERVER s sentence, and keeps the text', async () => {
  await liveSession();
  fx.failCreate(); // 409 That name is already taken.
  choose(dirRow('web'), 'New folder');
  type('src');
  pressEnter();
  await settle();
  assert.equal(fx.createCalls.length, 1, 'the client rules had nothing to say about it');
  assert.equal(textsOf(errRow() as FakeElement, 'files-name')[0], 'That name is already taken.');
  assert.equal(nameField().value, 'src', 'the typed name survives the repaint that drew the refusal');
  assert.equal(nameField().readOnly, false, 'and the field is editable again');
  assert.equal(dom.doc.activeElement, nameField());
  assert.equal((newRow() as FakeElement).classList.contains('is-busy'), false);
  // Fixing the name and pressing Enter again is the whole recovery.
  fx.createFails = null;
  type('src2');
  pressEnter();
  await settle();
  assert.deepEqual(fx.createCalls.slice(-1), [{ dir: `${PROJ}/web`, name: 'src2', kind: 'folder' }]);
  assert.equal(newRow(), undefined, 'and the row is gone');
});

test('a failure with no sentence of its own falls back to the app s own line', async () => {
  await liveSession();
  // `HTTP 500` is what api.ts invents when a body carries no error at all, and
  // the panel's `isSentence` refuses it on purpose: it is not a sentence this
  // app ever wrote.
  fx.failCreate(new FakeApiError(500, 'HTTP 500'));
  choose(dirRow('web'), 'New file');
  type('a.md');
  pressEnter();
  await settle();
  assert.equal(textsOf(errRow() as FakeElement, 'files-name')[0], 'The app could not create it.');
  // And a failure whose message is not a sentence either.
  fx.failCreate(new FakeApiError(0, 'fetch failed'));
  type('b.md');
  pressEnter();
  await settle();
  assert.equal(textsOf(errRow() as FakeElement, 'files-name')[0], 'The app could not create it.');
});

test('the refusal is never a dialog: nothing is added outside the panel', async () => {
  await liveSession();
  const outside = dom.body.children.length;
  fx.failCreate();
  choose(dirRow('web'), 'New folder');
  type('src');
  pressEnter();
  await settle();
  assert.equal(dom.body.children.length, outside, 'a modal would have appended a scrim');
  assert.equal(byClass(dom.body, 'modal-scrim').length, 0);
});

// ---------------------------------------------------------------------------
// In flight (§6b)
// ---------------------------------------------------------------------------

test('while the request is out the field is read-only and the row pulses — and nothing moves', async () => {
  await liveSession();
  fx.holdCreate();
  choose(dirRow('web'), 'New folder');
  type('docs');
  const before = (newRow() as FakeElement).style.paddingLeft;
  pressEnter();
  await settle();
  const row = newRow() as FakeElement;
  assert.equal(nameField().readOnly, true, 'a name that is being created is not one you edit');
  assert.equal(row.classList.contains('is-busy'), true);
  assert.equal(row.classList.contains('is-new'), true, 'still the same row');
  assert.equal(row.style.paddingLeft, before, 'no indent and no height change mid-request');
  assert.equal(nameField().value, 'docs');
  fx.releaseCreate();
  await settle();
  assert.equal(newRow(), undefined);
});

// ---------------------------------------------------------------------------
// Success (§6b)
// ---------------------------------------------------------------------------

test('a created FOLDER is selected, expanded, focused — and its folder refetched once', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  type('docs');
  pressEnter();
  await settle();
  assert.equal(newRow(), undefined, 'the name row is done');
  const made = byKey(root, `fdir:${PROJ}/web/docs`) as FakeElement;
  assert.ok(made !== null, 'the new folder has a row');
  assert.equal(made.getAttribute('aria-expanded'), 'true', 'expanded: its empty state is honest');
  assert.deepEqual(F.selectedFolder(), { path: `${PROJ}/web/docs`, name: 'docs' });
  assert.equal(made.classList.contains('is-sel'), true);
  assert.equal(dom.doc.activeElement, made, 'the keyboard lands on the row that was made');
  assert.equal(
    fx.entryCalls.filter((p) => p === `${PROJ}/web`).length,
    1,
    'the folder it went into is re-read exactly once',
  );
});

test('a created FILE is opened as a pane, and the keyboard lands on its row', async () => {
  await liveSession();
  choose(dirRow('web'), 'New file');
  type('notes.md');
  pressEnter();
  await settle();
  const v = st.activeView() as ViewLike;
  assert.deepEqual(
    v.slots.map((s) => st.slotTabIds(s)),
    [[`f:${PROJ}/web/notes.md`]],
    'one editor pane, holding the new file at its absolute path',
  );
  const made = byKey(root, `ffile:${PROJ}/web/notes.md`) as FakeElement;
  assert.ok(made !== null, 'the new file has a row');
  assert.equal(dom.doc.activeElement, made);
  // The right-click that opened the menu chose the FOLDER (A9b), and creating
  // a file in it changes nothing about that: the destination is still the
  // place the file was made in.
  assert.deepEqual(F.selectedFolder(), { path: `${PROJ}/web`, name: 'web' });
});

test('a create in the ROOT lands in the root s own listing', async () => {
  await liveSession();
  choose(background(), 'New folder');
  type('notes');
  pressEnter();
  await settle();
  const made = byKey(root, `fdir:${PROJ}/notes`) as FakeElement;
  assert.ok(made !== null);
  assert.equal(fx.entryCalls.filter((p) => p === PROJ).length, 1, 'the root, re-read once');
});

// ---------------------------------------------------------------------------
// Refresh (§6a)
// ---------------------------------------------------------------------------

test('Refresh on a folder re-asks THAT folder, and nothing else', async () => {
  await liveSession();
  choose(dirRow('web'), 'Refresh');
  assert.deepEqual(fx.entryCalls, [`${PROJ}/web`]);
  await settle();
  // The rows stayed on screen while the new answer travelled (the panel's
  // cache-then-revalidate rule): no `Loading…` flash for a folder that already
  // answered.
  assert.ok(byKey(root, `fdir:${PROJ}/web/src`) !== null);
});

test('Refresh on the ROOT re-asks the root and the open folders, and drops the cache under it', async () => {
  await liveSession();
  // A folder that was opened and closed again: its listing is still cached, and
  // that cache is what this gesture has to drop.
  dirRow('shared').click();
  await settle();
  dirRow('shared').click();
  await settle();
  assert.equal(dirRow('shared').getAttribute('aria-expanded'), 'false');
  fx.entryCalls.length = 0;

  choose(background(), 'Refresh');
  assert.deepEqual(
    [...fx.entryCalls].sort(),
    [PROJ, `${PROJ}/server`, `${PROJ}/web`, `${PROJ}/web/src`].sort(),
    'the root and every open folder under it — a dropped cache nobody re-asks is a tree stuck on Loading…',
  );
  assert.equal(
    fx.entryCalls.includes(`${PROJ}/shared`),
    false,
    'a closed folder is read when it is next opened',
  );
  await settle();

  // And the closed folder really lost its cache: opening it shows `Loading…`
  // before the answer, which a cached folder never does.
  dirRow('shared').click();
  assert.ok(
    textsOf(root, 'files-name').includes('Loading…'),
    'the cached listing under the root must be gone',
  );
  await settle();
  assert.ok(byKey(root, `fdir:${PROJ}/shared/empty`) !== null);
});

// ---------------------------------------------------------------------------
// The classes, the tokens and the copy
// ---------------------------------------------------------------------------

test('every class the name row wears is styled, and the block is tokens only', () => {
  const [files] = mySections(['Files panel']);
  const css = stripComments((files as { body: string }).body);
  for (const rule of [
    /\.files-row\.is-new\s*\{/,
    /\.files-newname\s*\{/,
    /\.files-row\.is-newerr \.files-name\s*\{/,
  ]) {
    assert.match(css, rule, `the Files-panel section must carry ${rule.source}`);
  }
  // The input must not wear the base field's ground, border or padding: those
  // are what would make this row taller than every other one — and a row that
  // changed the panel's size would resize every PTY in the grid.
  const block = /\.files-newname\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(block, /background:\s*transparent/);
  assert.match(block, /border:\s*none/);
  assert.match(block, /padding:\s*0/);
  assert.match(block, /min-width:\s*0/);
  assert.match(block, /flex:\s*1/);
  // The FACE is the tree's, not the base `input` rule's mono: a name being
  // typed and the same name one repaint later must be one thing on one line.
  assert.match(block, /font-family:\s*inherit/);
  assert.match(block, /font-size:\s*12\.5px/);
  assert.match(
    stripComments(APP_CSS),
    /^input,\nselect,\n[\s\S]*?font-family: var\(--font-mono\);/m,
    'non-vacuity: the base input rule really does impose the mono face',
  );
  assert.equal(
    /(?:^|[\n;])\s*width:/.test(block),
    false,
    'a fixed width would change the panel s own — `min-width: 0` is the only width rule here',
  );
  // Tokens only: no colour literal in the three rules, and every token declared.
  const mine = [
    /\.files-row\.is-new\s*\{[^}]*\}/,
    /\.files-newname\s*\{[^}]*\}/,
    /\.files-row\.is-newerr \.files-name\s*\{[^}]*\}/,
  ]
    .map((re) => re.exec(css)?.[0] ?? '')
    .join('\n');
  assert.equal(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/.test(mine), false, `a colour literal: ${mine}`);
  const declared = declaredTokens();
  for (const t of usedTokens(mine)) assert.ok(declared.has(t), `undeclared token ${t}`);
  assert.ok(usedTokens(mine).length >= 2, `non-vacuity: ${usedTokens(mine).length} tokens read`);
  // Non-vacuity of the scanner itself.
  assert.match(APP_CSS, /\.files-row\s*\{/);
});

test('the classes the module sets and the classes the stylesheet knows are the same three', () => {
  for (const cls of ['files-row is-new', 'files-newname', 'files-row is-newerr']) {
    assert.ok(FILES_SRC.includes(`'${cls}'`), `ui/files.ts must build .${cls}`);
  }
});

test('nothing the name row says carries a path, a key name or a command', async () => {
  await liveSession();
  choose(dirRow('web'), 'New folder');
  fx.failCreate();
  type('src');
  pressEnter();
  await settle();
  const said = [
    nameField().getAttribute('aria-label') ?? '',
    textsOf(errRow() as FakeElement, 'files-name')[0] ?? '',
  ];
  // Every client sentence too — they are constants, and this is the sweep that
  // keeps them one vocabulary with the rest of the panel.
  const sentences = [
    'Type a name first.',
    'A name cannot contain a slash.',
    'That name is not allowed.',
    'That name is too long.',
    'The app could not create it.',
  ];
  for (const s of [...said, ...sentences]) {
    assert.ok(s.length > 0, 'non-vacuity: an empty string proves nothing');
    assert.equal(/[/\\]/.test(s), false, `a path reached the panel: ${s}`);
    assert.equal(/ctrl\+|shift\+|\balt\b|F10/i.test(s), false, `a key name: ${s}`);
    assert.equal(
      /claude|explorer|windows|xterm|POST|HTTP/i.test(s),
      false,
      `a command or a product: ${s}`,
    );
  }
  for (const s of sentences) {
    assert.match(s, /^[A-Z].*\.$/, `a refusal is one plain sentence: ${s}`);
  }
  assert.ok(FILES_SRC.includes("'The app could not create it.'"), 'the app s own line lives here');
});
