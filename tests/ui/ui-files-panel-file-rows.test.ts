/**
 * `web/src/ui/files.ts` — a file row as a source (Nocturne A10, A10b): click,
 * pointer drag and the ctrl+alt+enter chord, `is-open` following the tabs,
 * the header following the VIEW root while a file pane is focused, type
 * icons, the caret as decoration, and the Files/Commits tab switch. Split out of `ui-files-panel.test.ts`.
 *
 * Seam: the REAL `web/src/ui/files.ts` on the shared DOM double, against the
 * REAL `web/src/state.ts`, `ui/util.ts`, `ui/icons.ts`, `ui/files-model.ts`,
 * `ui/fs-model.ts`, `ui/commit-model.ts` and `ui/commit-store.ts`, with the
 * backend a fake `FsGateway` (`tests/helpers/fs-fixture.ts` over
 * `tests/helpers/commits-fixture.ts`) — no HTTP, no module stubbing, no clock.
 * Booted once per file by `tests/helpers/ui-files-panel-fixture.ts` and reset
 * before every test (`resetPanel`).
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
  textsOf,
  type FakeElement,
} from '../helpers/fake-dom.ts';
import {
  HOME,
  SCRATCH,
  settle,
  mkProject as project,
} from '../helpers/fs-fixture.ts';
import { FILES_PANEL_SOURCES, sleep, readSources } from '../helpers/helpers.ts';
import {
  bindRootNow,
  dirRow,
  dom,
  ed,
  expand,
  fileRow,
  focusSession,
  homeWorld,
  liveSession,
  mkSession,
  panel,
  type PaneSlot,
  repaint,
  resetPanel,
  root,
  shapeOf,
  st,
  type ViewLike,
} from '../helpers/ui-files-panel-fixture.ts';

// Which root the panel is standing in right now, so a test can name a row by
// the same relative path it always did. Declared HERE because the tests below
// assign it and an imported binding is read-only; the fixture's helpers read
// and write it through `bindRootNow`.
let rootNow = HOME;
bindRootNow({
  get: () => rootNow,
  set: (p: string): void => {
    rootNow = p;
  },
});

beforeEach(resetPanel);

// ---------------------------------------------------------------------------
// A file row as a source: click, drag, chord (Nocturne A10)
// ---------------------------------------------------------------------------

/** The panes of the tab the app is standing in. */
function slotsNow(): PaneSlot[] {
  return (st.activeView() as ViewLike).slots;
}

/** Is this file open ANYWHERE at all — as a tab of any pane of any tab? */
function anyFileSlot(): boolean {
  return st.state.views.some((v) =>
    v.slots.some((slot) => st.slotTabIds(slot).some((id) => id.startsWith('f:'))),
  );
}

test('with nothing running, a file row opens into the Home tab — never a nameless one', async () => {
  await homeWorld();
  await expand('web', 'web/src');
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'non-vacuity: the Home subject');

  (fileRow('web/src/store.ts')).click();
  const v = st.activeView() as ViewLike;
  assert.deepEqual(v.root, { kind: 'home' });
  assert.equal(st.state.views[0]?.id, v.id, 'Home is the fixed first tab');
  assert.deepEqual(shapeOf(v), ['*web/src/store.ts']);
});

test('a session WITHOUT a project lists its OWN working directory, headed by its name', async () => {
  // The A10 gap B2 closes: the header says the session's name, the tree lists
  // the folder that session is really running in, and the file still opens
  // into the Home tab (which tab a file lands in is a view-model rule part B4
  // revisits — B2 only makes the ROOT real).
  st.setProjects([]);
  st.setSessions([mkSession('s9', { title: 'scratch shell', command: 'bash' })]);
  focusSession('s9');
  st.state.leftPanel = 'files';
  rootNow = SCRATCH;
  panel.render();
  await settle();
  assert.equal(textsOf(root, 'files-proj')[0], 'scratch shell', 'non-vacuity: not the Home subject');
  assert.deepEqual(
    textsOf(root, 'files-name'),
    ['web', 'server', 'launcher', 'shared', 'README.md', 'LICENSE'],
    'the session s own working directory, listed for real',
  );
  await expand('web', 'web/src');

  fileRow('web/src/store.ts').click();
  assert.deepEqual((st.activeView() as ViewLike).root, { kind: 'home' });
});

test('a file row is a pointer drag source — and says so, naming its keyboard twin', async () => {
  await liveSession();
  const file = fileRow('web/src/Pane.tsx');
  assert.match(file.title, /ctrl\+alt\+enter/, `the row must name its twin: ${file.title}`);
  assert.match(file.title, /Drag/);

  // A drag past the threshold must NOT also fire the row's click (ui/dnd.ts
  // swallows it), so the file does not open twice and in the wrong place.
  dispatch(file, 'pointerdown', { clientX: 10, clientY: 10, pointerId: 4 });
  assert.equal(file.classList.contains('is-dragging'), false, 'not yet: 0px is not a drag');
  dispatch(dom.body, 'pointermove', { clientX: 60, clientY: 40, pointerId: 4 });
  assert.equal(file.classList.contains('is-dragging'), true, 'the row recedes once picked up');
  assert.equal(byClass(dom.body, 'drag-ghost').length, 1, 'one ghost, carrying the name');
  assert.equal(byClass(dom.body, 'drag-ghost')[0]?.textContent, 'Pane.tsx', 'a NAME, never a path');

  dispatch(dom.body, 'pointerup', { clientX: 60, clientY: 40, pointerId: 4 });
  assert.equal(byClass(dom.body, 'drag-ghost').length, 0, 'the ghost goes with the gesture');
  assert.equal(file.classList.contains('is-dragging'), false);
  assert.equal(anyFileSlot(), false, 'a drag onto nothing opens nothing');
  // ui/dnd.ts swallows the click that a finished drag would otherwise fire,
  // for 80ms of REAL time. Wait it out, or the next test's click is eaten.
  await sleep(90);
});

test('ctrl+alt+enter on a focused row splits the focused pane — the twin of the edge drop', async () => {
  await liveSession();
  // One pane in the project tab: the only split it offers is left/right.
  (fileRow('web/src/store.ts')).click();
  const v = st.activeView() as ViewLike;
  assert.equal(v.slots.length, 1, 'non-vacuity: one pane to split');

  const file = fileRow('web/src/Pane.tsx');
  file.focus();
  const e = dispatch(file, 'keydown', { key: 'Enter', ctrlKey: true, altKey: true });
  assert.equal(e.defaultPrevented, true, 'the row owns the chord, so nothing else may act on it');
  assert.deepEqual(shapeOf(st.activeView()), ['*web/src/Pane.tsx', '*web/src/store.ts'],
    'the new file took the left half of the pane it split — its OWN editor pane');
  assert.equal(slotsNow().length, 2, 'the chord splits; it never adds to the strip');
});

test('the chord is ctrl+alt+enter only: AltGr, plain Enter and ctrl+enter are left alone', async () => {
  await liveSession();
  const file = fileRow('web/src/Pane.tsx');
  file.focus();
  for (const init of [
    { key: 'Enter' },
    { key: 'Enter', altKey: true },
    // AltGr reports as ctrl+alt on European layouts: taking it would make a
    // keyboard character untypeable (frontend-terminal-quirks).
    { key: 'Enter', ctrlKey: true, altKey: true, altGraph: true },
    { key: 'w', ctrlKey: true, altKey: true },
  ]) {
    const e = dispatch(file, 'keydown', init);
    assert.equal(e.defaultPrevented, false, `${JSON.stringify(init)} is not this row's key`);
  }
  // ctrl+enter left this list in B10a: it is the panel's own "add this row to
  // the selection" (the twin of ctrl+space and of a ctrl+click), so it IS
  // taken — and it still opens nothing.
  const toggle = dispatch(file, 'keydown', { key: 'Enter', ctrlKey: true });
  assert.equal(toggle.defaultPrevented, true, 'ctrl+enter chooses the focused row');
  assert.equal(anyFileSlot(), false, 'and nothing opened');
});

test('`is-open` follows the TABS, in any tab, active chip or not (A10b)', async () => {
  // The A10 spelling of this asked whether the file was a PANE (`slotKey`).
  // Since A10b a file is a CHIP in a strip and a pane's key is its own `e:<n>`,
  // so that question could never say yes again — a silently dead class.
  await liveSession();
  const isOpen = (rel: string): boolean => fileRow(rel).classList.contains('is-open');
  assert.equal(isOpen('web/src/Pane.tsx'), false, 'non-vacuity: nothing is open yet');

  (fileRow('web/src/Pane.tsx')).click();
  panel.render();
  assert.equal(isOpen('web/src/Pane.tsx'), true);

  // A second file joins the same strip. The first one is no longer the ACTIVE
  // chip, and it is still open — the class is about the file being on screen's
  // strip, not about which chip is up.
  (fileRow('web/src/store.ts')).click();
  panel.render();
  assert.deepEqual(shapeOf(st.activeView()), ['web/src/Pane.tsx *web/src/store.ts']);
  assert.equal(isOpen('web/src/Pane.tsx'), true, 'a background chip is open too');
  assert.equal(isOpen('web/src/store.ts'), true);
  assert.equal(isOpen('web/src/TabStrip.tsx'), false, 'and only the files that are really open');

  // Another tab entirely — the session's own, which keeps the panel rooted at
  // the same project so the rows are still drawn. The row still says the file
  // is on screen, because it is: the class is about the FILE, not about which
  // tab is in front.
  focusSession('s1');
  repaint();
  assert.equal(isOpen('web/src/Pane.tsx'), true, 'open somewhere is open');

  // And it goes away with the strip: the panel must never ground a row for a
  // file nothing shows.
  const owner = st.state.views.find((v) => v.slots.some((x) => x.kind === 'editor')) as ViewLike;
  owner.slots = owner.slots.filter((x) => x.kind !== 'editor');
  repaint();
  assert.equal(isOpen('web/src/Pane.tsx'), false);
  assert.equal(isOpen('web/src/store.ts'), false);
});

test('the header follows the VIEW root while a FILE pane is focused, not the tab\'s session', () => {
  // The trap this closes: a folder tab holding a file pane beside a terminal
  // from another project would flip the header to that project the moment the
  // file pane took the focus — a tree headed by a folder it is not about.
  st.setProjects([project('p1', 'api'), project('p2', 'tools')]);
  st.setSessions([mkSession('s1', { projectId: 'p2' })]);
  st.state.views = [
    {
      id: 'vf',
      root: { kind: 'project', id: 'p1' },
      slots: [ed('web/src/Pane.tsx'), { kind: 'session', id: 's1' }],
      focused: 0,
      l3: 'L',
      split: { col: 0.5, row: 0.5 },
    },
  ];
  st.state.activeViewId = 'vf';
  st.state.leftPanel = 'files';
  repaint();
  assert.equal(textsOf(root, 'files-proj')[0], 'api', "the FILE pane's tab, not the terminal's project");

  // Focus the terminal instead: now the session's project is the subject.
  (st.state.views[0] as ViewLike).focused = 1;
  repaint();
  assert.equal(textsOf(root, 'files-proj')[0], 'tools');
});

test('a DIFF pane is about its tab too, and Home reads Home', () => {
  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  st.state.views = [
    {
      id: 'vh',
      root: { kind: 'home' },
      slots: [st.newEditorSlot([{ kind: 'diff', hash: 'a1b2c3d', path: 'web/src/Pane.tsx' }])],
      focused: 0,
      l3: 'L',
      split: { col: 0.5, row: 0.5 },
    },
  ];
  st.state.activeViewId = 'vh';
  st.state.leftPanel = 'files';
  repaint();
  assert.equal(textsOf(root, 'files-proj')[0], 'Home');
  assert.equal(
    (byKey(root, 'ftab:commits') as FakeElement).disabled,
    true,
    'and Home has no repository, however the panel got there',
  );
});

test('a file pane in a ROOTLESS tab is about THAT tab session, not the first alive anywhere', async () => {
  // A file reaches a plain session tab by a drop on a terminal pane edge, or by
  // ctrl+alt+enter. The tab has no folder, so the fallback used to name the
  // first live session ANYWHERE — an unrelated project in the header, and the
  // next file opened into that project's folder.
  st.setProjects([project('p1', 'api'), project('p2', 'tools')]);
  st.setSessions([mkSession('s2', { projectId: 'p1' }), mkSession('s1', { projectId: 'p2' })]);
  st.state.views = [
    { id: 'vo', root: null, slots: [{ kind: 'session', id: 's2' }], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
    {
      id: 'vf',
      root: null,
      slots: [ed('web/src/Pane.tsx'), { kind: 'session', id: 's1' }],
      focused: 0,
      l3: 'L',
      split: { col: 0.5, row: 0.5 },
    },
  ];
  st.state.activeViewId = 'vf';
  st.state.leftPanel = 'files';
  repaint();
  await settle();
  assert.equal(
    textsOf(root, 'files-proj')[0],
    'tools',
    "the tab's own session — `api` is another tab's story",
  );

  // And the header and the landing tab can never disagree: the next row opens
  // into the folder the header names.
  rootNow = '/work/tools';
  await expand('web', 'web/src');
  fileRow('web/src/store.ts').click();
  assert.deepEqual((st.activeView() as ViewLike).root, { kind: 'project', id: 'p2' });
});

test('a file pane in a rootless tab with NO session of its own reads Home', async () => {
  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s2', { projectId: 'p1' })]);
  st.state.views = [
    { id: 'vo', root: null, slots: [{ kind: 'session', id: 's2' }], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
    { id: 'vf', root: null, slots: [ed('web/src/Pane.tsx')], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
  ];
  st.state.activeViewId = 'vf';
  st.state.leftPanel = 'files';
  repaint();
  await settle();
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'no folder and no session: Home, not `api`');

  rootNow = HOME;
  await expand('web', 'web/src');
  fileRow('web/src/store.ts').click();
  assert.deepEqual((st.activeView() as ViewLike).root, { kind: 'home' });
});

test('every file row carries its type icon, decorative, including the ones behind a closed folder', async () => {
  await liveSession();
  const icons = byClass(root, 'files-icon');
  assert.ok(icons.length > 0);
  for (const b of icons) assert.equal(b.getAttribute('aria-hidden'), 'true');
  assert.equal(byClass(root, 'files-badge').length, 0, 'the A5 text chips are gone');
  const kindOf = new Map(icons.map((b) => [b.getAttribute('data-icon'), b.getAttribute('data-kind')]));
  assert.equal(kindOf.get('typescript'), 'ts', '.ts and .tsx: one logo, one family');
  assert.equal(kindOf.get('markdown'), 'md');
  assert.equal(kindOf.get('npm'), 'npm', 'package.json is npm’s file');
  assert.equal(kindOf.get('certificate'), 'text', 'LICENSE is a licence, not an unknown file');
  for (const b of icons) assert.equal(b.textContent, '', `${b.getAttribute('data-icon')}: a glyph, never letters`);

  // The families that only appear once a closed folder is opened.
  await expand('launcher');
  const opened = new Map(byClass(root, 'files-icon').map((b) => [b.getAttribute('data-icon'), b.getAttribute('data-kind')]));
  assert.equal(opened.get('terminal-window'), 'ps');
  assert.equal(opened.get('javascript'), 'js', 'a .mjs is JavaScript, not an unknown type');
});

test('the caret is decoration: aria-hidden, and the folder row itself states the state', async () => {
  await liveSession();
  for (const c of byClass(root, 'files-caret')) assert.equal(c.getAttribute('aria-hidden'), 'true');
  const web = dirRow('web');
  assert.equal(web.children[0]?.textContent, '▾');
  assert.equal(web.getAttribute('aria-expanded'), 'true');
});

test('no honesty line is left in the panel at all — every tab is real (B3)', async () => {
  // B2 made the Files tab real, B3 the Commits tab. The one quiet "Example
  // data until…" line went with the mock it was about, and the function that
  // drew it went with it.
  await liveSession();
  assert.deepEqual(textsOf(root, 'files-note'), [], 'a real listing needs no apology');

  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  assert.deepEqual(textsOf(root, 'files-note'), []);

  const src = readSources(...FILES_PANEL_SOURCES);
  for (const dead of ['placeholderNote', 'Example data', 'files-mock', 'MOCK_COMMITS']) {
    assert.equal(src.includes(dead), false, `${dead} died with part B3`);
  }
  (byKey(root, 'ftab:files') as FakeElement).click(); // the tab is panel-local state
});
