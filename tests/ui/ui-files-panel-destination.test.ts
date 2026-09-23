/**
 * `web/src/ui/files.ts` — the twin of the Explorer drag and the destination
 * NAMES (part A9, A9b, B2): the `Copy files here…` button and its title, a
 * focused folder row moving the destination, ctrl+alt+c on a folder row, the
 * destination of a session pane and a file pane, the listing a drop reads,
 * name/path parity, and the class and copy-rule parity of every row state.
 * Split out of `ui-files-panel.test.ts`.
 *
 * Seam: the REAL `web/src/ui/files.ts` on the shared DOM double, against the
 * REAL `web/src/state.ts`, `ui/util.ts`, `ui/icons.ts`, `ui/files-model.ts`,
 * `ui/fs-model.ts`, `ui/commit-model.ts` and `ui/commit-store.ts`, with the
 * backend a fake `FsGateway` (`tests/helpers/fs-fixture.ts` over
 * `tests/helpers/commits-fixture.ts`) — no HTTP, no module stubbing, no clock.
 * Booted once per file by `tests/helpers/ui-files-panel-fixture.ts` and reset
 * before every test (`resetPanel`).
 *
 * Why it matters: a destination NAME that disagrees with the folder behind it
 * copies the user's files somewhere else than the dialog said.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, colour, the amber pulse actually animating, that a drag really
 * reflows a PTY, hit-testing, screen-reader output.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  byClass,
  byKey,
  dispatch,
  type FakeElement,
} from '../helpers/fake-dom.ts';
import {
  FakeApiError,
  HOME,
  PROJ,
  SCRATCH,
  settle,
  mkProject as project,
} from '../helpers/fs-fixture.ts';
import { FILES_PANEL_SOURCES, readSource, readSources } from '../helpers/helpers.ts';
import {
  body,
  destName,
  dirRow,
  dom,
  dropped,
  type DropReq,
  ed,
  entryCalls,
  F,
  failWith,
  fileRow,
  homeWorld,
  liveSession,
  mkSession,
  panel,
  resetPanel,
  root,
  st,
  type ViewLike,
} from '../helpers/ui-files-panel-fixture.ts';
import { readAppCss } from '../helpers/tokens-helpers.ts';

beforeEach(resetPanel);

// ---------------------------------------------------------------------------
// The twin of the Explorer drag, and the destination NAMES (part A9)
// ---------------------------------------------------------------------------

test('the panel carries a real `Copy files here…` button whose title names the destination', async () => {
  await liveSession();
  const btn = byKey(root, 'fcopy') as FakeElement;
  assert.ok(btn !== null, 'the drag has a visible twin — a gesture-only affordance is forbidden');
  assert.equal(btn.tagName, 'BUTTON');
  assert.equal(btn.textContent, 'Copy files here…');
  assert.equal(btn.title, 'Copy files into api', 'the live destination, by NAME');
  // It is not inside the tree body: it must stay put while the tree scrolls and
  // while the Commits tab hides the summary row.
  assert.equal(byClass(root, 'files-copy')[0]?.contains(btn), true);
  assert.equal(body.contains(btn), false);
});

test('focusing a folder row moves the destination to that folder, and the title with it', async () => {
  await liveSession();
  const btn = byKey(root, 'fcopy') as FakeElement;
  const dir = dirRow('web/src');
  assert.ok(dir !== null, 'non-vacuity: the mock tree really has that folder row');

  dir.focus();
  assert.equal(destName(F.pasteDestination()), 'src', 'its own name, never its path');
  assert.equal(btn.title, 'Copy files into src');

  // Focus back out of the panel entirely: the panel s own root answers again.
  const outside = dom.doc.createElement('button');
  dom.body.append(outside);
  outside.focus();
  assert.equal(destName(F.pasteDestination()), 'api');
  assert.equal(btn.title, 'Copy files into api');
  outside.remove();
});

test('the copy button keeps the folder the keyboard came from — it has no other twin', async () => {
  // Clicking or tabbing to `Copy files here…` takes the focus off the folder
  // row, and the folder-row destination has NO button of its own: a
  // destination read from `document.activeElement` at click time would copy
  // into the panel root the title stopped promising a moment ago.
  await liveSession();
  const btn = byKey(root, 'fcopy') as FakeElement;
  const dir = dirRow('web/src');
  dir.focus();
  assert.equal(destName(F.pasteDestination()), 'src', 'non-vacuity: the row really took it');

  btn.focus();
  assert.equal(destName(F.pasteDestination()), 'src', 'the destination survives the gesture that uses it');
  assert.equal(btn.title, 'Copy files into src', 'and the title keeps its word');

  // Anywhere else INSIDE the panel keeps it too: the tabs, the header.
  const tab = byKey(root, 'ftab:files') as FakeElement;
  tab.focus();
  assert.equal(destName(F.pasteDestination()), 'src');

  // Only leaving the panel clears it.
  const outside = dom.doc.createElement('button');
  dom.body.append(outside);
  outside.focus();
  assert.equal(destName(F.pasteDestination()), 'api', 'the panel s own root again');
  outside.remove();
});

/**
 * Drop the panel's remembered folder row, the way the app does: focus leaving
 * the panel altogether. The memory is module state in `ui/files.ts` and
 * survives a `render()`, so a test that focused a row hands it back.
 */
function clearRowMemory(): void {
  const outside = dom.doc.createElement('button');
  dom.body.append(outside);
  outside.focus();
  outside.remove();
}

test('ctrl+alt+c on a focused FOLDER row copies into THAT folder', async () => {
  // The strip button sits BEFORE the tree and every row here is a <button>, so
  // no amount of tabbing aims that one button at a nested folder: forward Tab
  // from a row never reaches it, and Shift+Tab walks back through other folder
  // rows, each of which re-notes itself as the destination. The row-level twin
  // is the only keyboard way to copy into `src` at all.
  await liveSession();
  const dir = dirRow('web/src');
  assert.ok(dir !== null, 'non-vacuity: the mock tree really has that folder row');
  assert.equal(dir.title, 'Open or close it. Copy files into it with ctrl+alt+c. Right-click for its actions.', 'the row names its own chord');

  dir.focus();
  const e = dispatch(dir, 'keydown', { key: 'c', ctrlKey: true, altKey: true });
  assert.equal(e.defaultPrevented, true);
  assert.equal(e.cancelBubble, true, 'a key this row spent never reaches the window chord handler');
  // The dialog opens one listing later: since B2 the conflict question is
  // asked against the REAL folder, at drop time.
  await settle();
  assert.equal(dropped.length, 1, 'the picker seam ran and handed its files on');
  const req = dropped[0] as DropReq;
  assert.deepEqual(req.dest, { path: `${PROJ}/web/src`, name: 'src' }, 'the name shown, the path posted');
  assert.deepEqual(req.items, [{ name: 'shot.png', dir: false, bytes: 7 }]);
  assert.deepEqual(
    req.listing,
    ['App.tsx', 'Pane.tsx', 'TabStrip.tsx', 'store.ts'],
    'the folder s own top-level names ask the conflict question',
  );
  clearRowMemory();
});

test('the folder-row chord keeps its AltGr guard, and a FILE row has nothing to do with it', async () => {
  await liveSession();
  // AltGr reports as ctrl+alt on European layouts: typing a character may
  // never open a file chooser.
  const dir = dirRow('web/src');
  dir.focus();
  const altGr = dispatch(dir, 'keydown', { key: 'c', ctrlKey: true, altKey: true, altGraph: true });
  assert.equal(altGr.defaultPrevented, false);
  assert.deepEqual(dropped, []);

  // A FILE row copies nothing: a file is not a destination, and its own chord
  // (ctrl+alt+enter) is a different act.
  const file = fileRow('web/src/Pane.tsx');
  file.focus();
  const onFile = dispatch(file, 'keydown', { key: 'c', ctrlKey: true, altKey: true });
  assert.equal(onFile.defaultPrevented, false);
  assert.deepEqual(dropped, []);
  clearRowMemory();
});

test('with nothing running the destination is `Home`, exactly as the header reads', () => {
  panel.render();
  assert.equal(byClass(root, 'files-proj')[0]?.textContent, 'Home');
  assert.equal(destName(F.filesPanelDestination()), 'Home');
  assert.equal(destName(F.pasteDestination()), 'Home');
  assert.equal((byKey(root, 'fcopy') as FakeElement).title, 'Copy files into Home');
});

test('a SESSION pane s destination: its session s project, else its tab s folder, else nothing', async () => {
  await liveSession();
  // The panes on screen are the ACTIVE view's, so that is the view a pane
  // element is asked about; the session's own tab is not the Home tab.
  const v = st.state.views.find((x) => x.slots.length > 0) as ViewLike;
  assert.ok(v !== undefined, 'non-vacuity: the session really got a view');
  st.state.activeViewId = v.id;
  const pane = dom.doc.createElement('section');
  pane.dataset.slot = '0';

  // The ORDER a session pane answers in is the header's own (`subject()`): the
  // session's project first, whatever the tab is rooted at. The two used to
  // disagree — the header read `api` while the ghost over this very pane said
  // `Home` — and one screen may only carry one name.
  v.root = { kind: 'home' };
  assert.equal(destName(F.filesPanelDestination()), 'api', 'non-vacuity: the header names the project');
  assert.equal(destName(F.destinationOfPane(pane).dest), 'api');

  v.root = { kind: 'project', id: 'p1' };
  assert.equal(destName(F.destinationOfActiveView()), 'api');
  assert.equal(destName(F.destinationOfPane(pane).dest), 'api');

  // A plain session tab: the session s own project answers for its pane.
  v.root = null;
  assert.equal(destName(F.destinationOfActiveView()), null);
  assert.equal(destName(F.destinationOfPane(pane).dest), 'api');

  // A session with no project falls back to the folder its TAB is rooted at —
  // the drop lands where the tab already says it is.
  st.setSessions([mkSession('s1')]);
  v.root = { kind: 'home' };
  assert.equal(destName(F.destinationOfPane(pane).dest), 'Home');

  st.setProjects([project('p1', 'api')]);
  v.root = { kind: 'project', id: 'p1' };
  assert.equal(destName(F.destinationOfPane(pane).dest), 'api', 'the rooted tab names it');

  // Neither a project nor a rooted tab: since part B2 the session's own
  // WORKING DIRECTORY names it (orchestrator default, §4b) — HISTORY already
  // groups such a session under that folder's last segment, so this is the
  // name the app already uses, not one it invented. A9's refusal is kept for
  // the genuinely nameless case below.
  v.root = null;
  assert.deepEqual(F.destinationOfPane(pane), { dest: { path: SCRATCH, name: 'scratch' } });

  st.setSessions([mkSession('s1', { cwd: '' })]);
  assert.deepEqual(F.destinationOfPane(pane), { dest: null, why: 'session' });
});

test('a FILE pane in a rootless tab borrows the tab s own first session, as the header does', async () => {
  // The panel header already answers this case (`subject()`); a pane that
  // answered null instead would flash a sentence about a session that is not
  // in that pane at all.
  await liveSession();
  const v = st.state.views.find((x) => x.slots.length > 0) as ViewLike;
  st.state.activeViewId = v.id;
  v.root = null;
  v.slots.push(ed('web/src/App.tsx'));
  const filePane = dom.doc.createElement('section');
  filePane.dataset.slot = String(v.slots.length - 1);
  assert.equal(destName(F.destinationOfPane(filePane).dest), 'api', 'the tab s own session names it');

  // Nothing in the tab to borrow a folder from: the refusal is about the TAB.
  st.setSessions([mkSession('s1')]);
  assert.deepEqual(F.destinationOfPane(filePane), { dest: null, why: 'tab' });
});

test('a destination s listing is the REAL folder s own top-level names, read now', async () => {
  // The conflict question is asked against this and nothing else, so it may
  // never carry paths or a recursive walk — and since part B2 it is a fresh
  // request against `dest.path`, never the panel s cache: a stale listing is
  // the one lie that decides whether a file is overwritten.
  await homeWorld();
  entryCalls.length = 0;
  const src = { path: `${HOME}/web/src`, name: 'src' };
  assert.deepEqual(await F.listingFor(src), ['App.tsx', 'Pane.tsx', 'TabStrip.tsx', 'store.ts']);
  assert.deepEqual(entryCalls, [`${HOME}/web/src`], 'one request, for the destination itself');

  const top = await F.listingFor({ path: HOME, name: 'Home' });
  assert.deepEqual(top, ['web', 'server', 'launcher', 'shared', 'README.md', 'LICENSE']);
  assert.ok(top.every((n) => !n.includes('/')), 'names, never paths');
});

test('a listing that FAILS opens the dialog with no conflicts — the drop is not lost', async () => {
  await homeWorld();
  failWith.set(`${HOME}/web`, new FakeApiError(403, 'This folder is outside your home folder.'));
  assert.deepEqual(
    await F.listingFor({ path: `${HOME}/web`, name: 'web' }),
    [],
    'not knowing is read as "no known conflicts", which is the non-destructive answer',
  );
});

test('every destination is the A9/A9b NAME with the real folder behind it (parity)', async () => {
  // The B2 contract in one test: not one VISIBLE string changed — the ghost,
  // the dialog, the strip button and its title all read `.name`, which is what
  // A9 and A9b already showed — and every one of them now carries the PATH
  // part B10's upload posts to.
  await liveSession();
  const v = st.state.views.find((x) => x.slots.length > 0) as ViewLike;
  st.state.activeViewId = v.id;
  v.root = { kind: 'project', id: 'p1' };
  const pane = dom.doc.createElement('section');
  pane.dataset.slot = '0';

  assert.deepEqual(F.filesPanelDestination(), { path: PROJ, name: 'api' });
  assert.deepEqual(F.destinationOfActiveView(), { path: PROJ, name: 'api' });
  assert.deepEqual(F.destinationOfPane(pane), { dest: { path: PROJ, name: 'api' } });
  assert.deepEqual(F.pasteDestination(), { path: PROJ, name: 'api' });

  dirRow('web/src').click(); // select it
  await settle();
  assert.deepEqual(F.selectedFolder(), { path: `${PROJ}/web/src`, name: 'src' });
  assert.deepEqual(F.pasteDestination(), { path: `${PROJ}/web/src`, name: 'src' });
  assert.equal((byKey(root, 'fcopy') as FakeElement).textContent, 'Copy files into src…');
  assert.equal((byKey(root, 'fcopy') as FakeElement).title, 'Copy files into src');
  dispatch(root, 'keydown', { key: 'Escape' });

  // At Home the root's name is the header's own word, never the folder's last
  // segment — one screen, one name.
  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  await homeWorld();
  assert.deepEqual(F.filesPanelDestination(), { path: HOME, name: 'Home' });
  assert.equal((byKey(root, 'fcopy') as FakeElement).title, 'Copy files into Home');
});

test('every row state has a rule, and every rule has a setter (class parity)', () => {
  // A class with no rule paints nothing and no DOM test can see it; a rule
  // with no setter is dead CSS the next reader trusts. Part B2 adds `is-state`
  // and `is-err` to this vocabulary.
  const src = readSources(...FILES_PANEL_SOURCES);
  const app = readAppCss();
  // Two other modules put a class on a row of this panel: the drop layer
  // lights the folder under the pointer (`is-drop`), and the in-app drag
  // recedes the row it picked up (`is-dragging`).
  const drop = readSource('web', 'src', 'ui', 'filedrop.ts');
  const dnd = readSource('web', 'src', 'ui', 'dnd.ts');
  const all = `${src}\n${drop}\n${dnd}`;

  /** The `is-*` states a `.files-row` can wear, by the rules that style them. */
  const ruled = new Set<string>();
  for (const m of app.matchAll(/\.files-row((?:\.is-[a-z-]+)+)/g)) {
    for (const c of (m[1] as string).split('.')) if (c.startsWith('is-')) ruled.add(c);
  }
  assert.ok(ruled.size >= 5, `non-vacuity: ${[...ruled].join(', ')}`);
  assert.ok(ruled.has('is-state') && ruled.has('is-err'), 'the two states part B2 adds');

  // Every rule has a setter somewhere in the three modules that dress a row.
  for (const c of ruled) {
    assert.ok(
      new RegExp(`classList\\.(?:add|toggle)\\(\\s*'${c}'`).test(all) ||
        new RegExp(`'files-row[^']*\\b${c}\\b`).test(all),
      `.files-row.${c} is styled but nothing ever sets it`,
    );
  }

  // And the other direction, for the vocabulary this panel owns: a row class
  // the module sets with no rule behind it. `is-file` is deliberately not in
  // this list — it is a MARKER (a file row is styled by `.files-row` plus its
  // badge and name), and it has carried no rule of its own since A6.
  for (const c of ['is-dir', 'is-sel', 'is-busy', 'is-open', 'is-state', 'is-err']) {
    assert.ok(
      new RegExp(`classList\\.(?:add|toggle)\\(\\s*'${c}'`).test(src) ||
        new RegExp(`'files-row[^']*\\b${c}\\b`).test(src),
      `non-vacuity: ui/files.ts never sets ${c}`,
    );
    assert.ok(ruled.has(c), `.files-row.${c} is set but never styled`);
  }

  // Tokens only: the new rules may not carry a colour literal.
  const block = app.slice(app.indexOf('.files-row.is-state'), app.indexOf('.files-row.is-busy'));
  assert.ok(block.length > 100, 'non-vacuity: the block was found');
  assert.equal(/#[0-9a-f]{3,8}\b|rgb\(|oklch\(/i.test(block), false, `a colour literal: ${block}`);
});

test('every sentence the panel can print follows the copy rules', () => {
  // A scan over the strings part B2 added, in the module that prints them:
  // no path, no flag, no command, no key name, and a full stop on a sentence.
  const src = readSources(...FILES_PANEL_SOURCES);
  const fsModel = readSource('web', 'src', 'ui', 'fs-model.ts');
  const commitModel = readSource('web', 'src', 'ui', 'commit-model.ts');
  const sentences = [
    'The app could not reach the service.',
    'Loading…',
    'Empty folder',
    'No changes since the last commit.',
    '1 more item is not shown here.',
    '200 more items are not shown here.',
    // Part B3, printed by the same body from `ui/commit-model.ts`.
    'No commits yet.',
    'Show more',
    'Detached',
    '1 more file is not shown.',
    '3 more files are not shown.',
  ];
  // The two unreachable-sentence owners moved to `ui/fs-model.ts` in part B3,
  // so the panel, the commits list, the commit view and a diff pane all print
  // ONE of them (`messageOf`) instead of four copies.
  assert.ok(fsModel.includes('The app could not reach the service.'), 'non-vacuity');
  assert.ok(src.includes('messageOf(err)'), 'non-vacuity: the panel renders through it');
  assert.ok(fsModel.includes('No changes since the last commit.'), 'non-vacuity');
  assert.ok(commitModel.includes('No commits yet.'), 'non-vacuity');
  for (const line of sentences) {
    assert.equal(/\//.test(line), false, `a path in: ${line}`);
    assert.equal(/--|\bgit\b|\bnpm\b/.test(line), false, `a command or a flag in: ${line}`);
    assert.equal(/ctrl|alt|shift|Escape/i.test(line), false, `a key name in: ${line}`);
    // A SENTENCE ends in a full stop; a LABEL on a control does not, and the
    // two allowed labels are named here so a third cannot slip in quietly.
    if (line.includes(' ') && /^[A-Z0-9]/.test(line)) {
      const label = line === 'Empty folder' || line === 'Show more';
      assert.ok(line.endsWith('.') || label, `no full stop: ${line}`);
    }
  }
  // The title on a disabled tab is a FRAGMENT on a control, so it carries no
  // full stop — and it names the subject, never a path.
  assert.match(src, /return `No repository at \$\{name\}`;/);
});
