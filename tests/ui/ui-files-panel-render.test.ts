/**
 * `web/src/ui/files.ts` — what the Files panel renders (Nocturne A5, part
 * B2): the header (Home, the focused session's project, or the session
 * itself), the tree as the gateway's own answer, lazy listings and the states
 * they pass through (Loading…, empty, capped, refused), the generation that
 * drops a late answer for a root the panel left, one listing in flight per
 * folder, and a folder row that toggles its subtree while a file row opens a
 * pane. Split out of `ui-files-panel.test.ts`.
 *
 * Seam: the REAL `web/src/ui/files.ts` on the shared DOM double, against the
 * REAL `web/src/state.ts`, `ui/util.ts`, `ui/icons.ts`, `ui/files-model.ts`,
 * `ui/fs-model.ts`, `ui/commit-model.ts` and `ui/commit-store.ts`, with the
 * backend a fake `FsGateway` (`tests/helpers/fs-fixture.ts` over
 * `tests/helpers/commits-fixture.ts`) — no HTTP, no module stubbing, no clock.
 * Booted once per file by `tests/helpers/ui-files-panel-fixture.ts` and reset
 * before every test (`resetPanel`).
 *
 * Why it matters: a late answer painting the old root's folder over the new
 * one looks like a real listing — the user acts on files that are not there;
 * a folder that stops toggling or a tab that renders the other tab's body
 * keeps `ui-files-model.test.ts` green.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, colour, the amber pulse actually animating, that a drag really
 * reflows a PTY, hit-testing, screen-reader output.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Project } from '../../shared/protocol.ts';
import {
  byClass,
  textsOf,
  type FakeElement,
} from '../helpers/fake-dom.ts';
import {
  FakeApiError,
  HOME,
  PROJ,
  settle,
  mkProject as project,
} from '../helpers/fs-fixture.ts';
import { FILES_PANEL_SOURCES, readSource, readSources } from '../helpers/helpers.ts';
import {
  aliveSessionCount,
  bindRootNow,
  body,
  destName,
  dirRow,
  entryCalls,
  expand,
  F,
  failWith,
  fileRow,
  focusSession,
  fx,
  homeWorld,
  liveSession,
  mkSession,
  panel,
  reopen,
  resetPanel,
  root,
  shapeOf,
  st,
  summary,
  type ViewLike,
} from '../helpers/ui-files-panel-fixture.ts';
import { readAppCss } from '../helpers/tokens-helpers.ts';

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
// What it renders
// ---------------------------------------------------------------------------

test('with no session at all the panel is still up, headed Home', async () => {
  // User decision 2026-09-15: the Files panel no longer waits for a session.
  st.state.drawer = null;
  await homeWorld();
  assert.equal(st.filesPanelVisible(), true);
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'a name, never a path');
  assert.deepEqual(
    textsOf(root, 'files-name'),
    ['web', 'server', 'launcher', 'shared', 'README.md', 'LICENSE'],
    'and the tree is really drawn — the HOME folder, learned from the first listing',
  );
});

test('exited sessions with no pane of their own leave the header on Home', async () => {
  // Added by the test gate (2026-09-15). `setSessions([])` is not the only
  // empty world: sessions that ENDED stay in state (state.ts markExited keeps
  // them and their pane). With no view focused, the alive-scan finds nothing.
  st.setProjects([project('p1', 'api')]);
  st.setSessions([
    mkSession('s1', { projectId: 'p1', status: 'exited' }),
    mkSession('s2', { title: 'notes', status: 'exited' }),
  ]);
  st.state.views = [];
  st.state.activeViewId = '';
  st.state.drawer = null;
  await homeWorld();
  assert.equal(st.filesPanelVisible(), true, 'no session is a condition any more');
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'nothing alive, so nothing to name');
  assert.ok(byClass(root, 'files-row').length >= 6, 'and the tree is drawn all the same');
});

test('a focused pane whose session EXITED, with nothing else alive, is headed Home', () => {
  // Added by the test gate (2026-09-15). The real path: state.ts markExited
  // flips status in place and reconcileViews KEEPS the dead pane, so after the
  // last session quits the focused pane still points at an exited session.
  // Until this change the panel was hidden in exactly that state; now it is on
  // screen, and the brief says the header reads `Home` when nothing is alive.
  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  focusSession('s1');
  st.state.leftPanel = 'files';
  st.state.drawer = null;
  panel.render();
  assert.equal(textsOf(root, 'files-proj')[0], 'api', 'non-vacuity: it starts on the live one');

  st.markExited('s1', 0);
  panel.render();
  assert.equal(st.filesPanelVisible(), true, 'the panel survives the exit');
  assert.equal(aliveSessionCount(), 0, 'non-vacuity: nothing is running');
  assert.equal(
    textsOf(root, 'files-proj')[0],
    'Home',
    'a dead session is not what a mock file tree is about',
  );
});

test('the Projects drawer takes the left side, and closing it gives the panel back', async () => {
  await liveSession();
  assert.equal(textsOf(root, 'files-proj')[0], 'api', 'non-vacuity: the panel is up');

  // Projects opens: only one left panel at a time. The panel stops rebuilding
  // (the chrome hides its aside) but nothing about the wish is written.
  st.state.drawer = 'projects';
  st.setProjects([project('p1', 'renamed')]);
  panel.render();
  assert.equal(st.filesPanelVisible(), false);
  assert.equal(st.state.leftPanel, 'files', 'the drawer never writes the wish');
  assert.equal(textsOf(root, 'files-proj')[0], 'api', 'a hidden panel does not rebuild itself');

  st.state.drawer = null;
  panel.render();
  assert.equal(st.filesPanelVisible(), true, 'closing Projects brings Files back by itself');
  assert.equal(textsOf(root, 'files-proj')[0], 'renamed', 'and it repaints what it missed');
});

test('the Files tab is the gateway s own answer, in the gateway s own order', async () => {
  await liveSession();
  // The panel asked for the root and for each folder that was opened, and for
  // nothing else: no walk, no prefetch, no poll. (`liveSession()` registers the
  // project before the session, so the root passes through Home on the way —
  // that listing is filtered out here and pinned by the root-change tests.)
  assert.deepEqual(
    entryCalls.filter((p) => p !== HOME),
    [PROJ, `${PROJ}/web`, `${PROJ}/web/src`, `${PROJ}/server`],
  );
  assert.equal(summary.hidden, true, 'a folder listing has no commits to be since');
  assert.deepEqual(textsOf(body, 'files-num'), [], 'and no per-row +N -N either');

  const rows = byClass(root, 'files-row');
  assert.ok(rows.length >= 10, 'non-vacuity: the tree really has rows');
  assert.deepEqual(
    rows.map((r) => r.textContent.replace(/^[▾▸]/, '').trim()),
    [
      'web',
      'src',
      'App.tsx',
      'Pane.tsx',
      'TabStrip.tsx',
      'store.ts',
      'DESIGN.md',
      'package.json',
      'server',
      'pty-pool.ts',
      'ws.ts',
      'presence.ts',
      'launcher',
      'shared',
      'README.md',
      'LICENSE',
    ],
    'every row prints its NAME — never a path — in the server s order',
  );
  // B12: and before it, its type's icon (a folder its glyph), no letters.
  assert.deepEqual(
    rows.map((r) => {
      const ic = (r.children as FakeElement[]).find((c) => c.classList.contains('files-icon'));
      return ic === undefined ? 'dir' : ic.getAttribute('data-icon');
    }),
    [
      'dir', 'dir', 'typescript', 'typescript', 'typescript', 'typescript', 'markdown', 'npm',
      'dir', 'typescript', 'typescript', 'typescript', 'dir', 'dir', 'book-open', 'certificate',
    ],
  );
  // The KEY is the absolute path (part B2): that is what the row menu, the
  // drop layer and part B10 all act on.
  assert.equal(fileRow('web/src/Pane.tsx').getAttribute('data-k'), `ffile:${PROJ}/web/src/Pane.tsx`);
  assert.equal(
    byClass(root, 'files-name').some((n) => n.textContent.includes('/')),
    false,
    'a path never reaches a label',
  );
});

test('a folder is fetched once per expand, and re-expanding it never flashes Loading…', async () => {
  await liveSession();
  const before = entryCalls.length;
  dirRow('web').click(); // close
  assert.deepEqual(entryCalls.length, before, 'closing asks nothing');

  // Re-opening ALWAYS re-asks (cache-then-revalidate) — but the cached rows
  // are on screen the whole time, so nothing flashes.
  fx.hold();
  dirRow('web').click();
  assert.equal(entryCalls.length, before + 1, 'one request');
  assert.equal(
    byClass(root, 'files-row').some((r) => r.textContent.includes('Loading…')),
    false,
    'a folder that already answered never goes back to Loading…',
  );
  assert.ok(byClass(root, 'files-row').some((r) => r.textContent.includes('DESIGN.md')));
  fx.release();
  await settle();
  assert.equal(entryCalls.length, before + 1, 'and the answer starts no second one');
});

test('a folder that has never answered says Loading…, at the indent of its own children', async () => {
  await liveSession();
  fx.hold();
  dirRow('launcher').click();
  const rows = byClass(root, 'files-row');
  const loading = rows.find((r) => r.textContent === 'Loading…') as FakeElement;
  assert.ok(loading !== undefined, `non-vacuity: ${rows.map((r) => r.textContent).join(' | ')}`);
  assert.equal(loading.tagName, 'DIV', 'a state is not a control: there is nothing to press');
  assert.equal(loading.classList.contains('is-state'), true);
  assert.equal(loading.classList.contains('is-err'), false);
  // The child indent of `launcher`, which is a top-level row: 8 + 1 * 14.
  assert.equal(loading.style.paddingLeft, '22px');
  assert.equal(byClass(loading, 'files-name')[0]?.textContent, 'Loading…', 'it ellipsises like a name');

  fx.release();
  await settle();
  assert.equal(
    byClass(root, 'files-row').some((r) => r.textContent === 'Loading…'),
    false,
    'and the rows replace it in the same place',
  );
  assert.ok(byClass(root, 'files-row').some((r) => r.textContent.includes('launch.ps1')));
});

test('an empty folder says so, a capped one says how many rows are missing', async () => {
  await liveSession();
  // `shared` is the capped folder in the fixture (the fake answers
  // `truncated: 3` for it) and it holds the empty one.
  await expand('shared');
  const note = byClass(root, 'files-row').find((r) => r.textContent.includes('not shown here'));
  assert.equal(note?.textContent, '3 more items are not shown here.');
  assert.equal(note?.classList.contains('is-state'), true);
  assert.equal(note?.tagName, 'DIV');
  assert.equal(
    byClass(root, 'files-row').indexOf(note as FakeElement),
    byClass(root, 'files-row').findIndex((r) => r.textContent.includes('protocol.ts')) + 1,
    'the quiet note is the LAST child of the folder it is about',
  );

  await expand('shared/empty');
  const empty = byClass(root, 'files-row').find((r) => r.textContent === 'Empty folder');
  assert.ok(empty !== undefined, 'an empty folder is a state, not a blank line');
  assert.equal(empty.classList.contains('is-state'), true);
  assert.equal(empty.style.paddingLeft, '36px', 'at the indent its children would have had');
});

test('a folder the server refuses says the SERVER s own sentence, in danger ink', async () => {
  await liveSession();
  failWith.set(`${PROJ}/launcher`, new FakeApiError(403, 'You do not have permission to read this folder.'));
  await reopen('launcher');
  const row = byClass(root, 'files-row').find((r) =>
    r.textContent.includes('You do not have permission'),
  ) as FakeElement;
  assert.ok(row !== undefined, 'the backend s reason is rendered inline, verbatim');
  assert.equal(row.textContent, 'You do not have permission to read this folder.');
  assert.equal(row.classList.contains('is-state'), true);
  assert.equal(row.classList.contains('is-err'), true, 'a refusal is the one state in danger ink');
  assert.equal(row.tagName, 'DIV');
});

test('the ROOT s own states replace the whole tree, in the same words', async () => {
  await homeWorld();
  // The root moves to a project folder that is not there any anymore: the
  // server's own sentence is the WHOLE body, and no stale tree stands behind it.
  rootNow = '/work/gone';
  st.setProjects([{ id: 'p9', name: 'gone', path: '/work/gone', createdAt: '' } as Project]);
  st.setSessions([mkSession('s9', { projectId: 'p9' })]);
  focusSession('s9');
  panel.render();
  await settle();
  const rows = byClass(root, 'files-row');
  assert.equal(rows.length, 1, 'one state row, and no tree behind it');
  assert.equal(rows[0]?.textContent, 'This folder is no longer there.');
  assert.equal(rows[0]?.classList.contains('is-err'), true);
  assert.equal(rows[0]?.style.paddingLeft, '8px', 'the root s own indent');
});

test('a late answer for the root we LEFT never paints over the one we are in', async () => {
  await liveSession();
  fx.hold();
  // The root moves to Home while the project's listing is still in flight.
  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  rootNow = HOME;
  panel.render();
  fx.release();
  await settle();
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'non-vacuity: the root really moved');
  assert.ok(byClass(root, 'files-row').length > 0);
  assert.equal(
    byClass(root, 'files-row').every((r) => (r.getAttribute('data-k') ?? '').includes(HOME)),
    true,
    'every row on screen belongs to the root the header names',
  );
});

test('a root change drops the OLD root s listings: coming back re-reads, it never remembers', async () => {
  // `openFolders`, `listings` and the selection are all keyed by absolute
  // path, so most of them simply stop matching on a root change — but a cache
  // entry does not: it is still the answer for that exact folder, and keeping
  // it is how a panel shows a folder the way it looked two projects ago,
  // silently and with no `Loading…` to say so.
  await homeWorld();
  assert.ok(
    byClass(root, 'files-name').some((n) => n.textContent === 'README.md'),
    'non-vacuity: Home has answered and its rows are drawn',
  );

  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  focusSession('s1');
  panel.render();
  await settle();

  // Back to Home with the answer still travelling: what is on screen in that
  // moment is the whole question.
  fx.hold();
  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  panel.render();
  assert.deepEqual(
    byClass(root, 'files-row').map((r) => r.textContent),
    ['Loading…'],
    'the root is asked again, not answered from before',
  );
  fx.release();
  await settle();
  assert.ok(
    byClass(root, 'files-name').some((n) => n.textContent === 'README.md'),
    'and the answer fills the tree in',
  );
});

test('a late listing is dropped even when it names a folder in the NEW root too', async () => {
  // The GENERATION, not the path, is what makes an answer stale. The root
  // leaves Home and comes back, so the listing still travelling is for the very
  // folder the tree is standing in again — the one case a path comparison
  // cannot see, and the one this app really meets (a click on a session's pane,
  // then back to Home before the first listing has landed).
  await homeWorld();
  let first = true;
  fx.holdIf((c) => {
    if (c.kind !== 'entries' || c.path !== HOME || !first) return false;
    first = false;
    return true;
  });
  // Returning to the panel re-reads the root: THAT listing is the held one, and
  // `holdIf` reads its answer now, so it carries the folder as it is today.
  st.state.leftPanel = null;
  panel.render();
  st.state.leftPanel = 'files';
  panel.render();
  assert.deepEqual(entryCalls.slice(-1), [HOME], 'non-vacuity: one listing is in flight');

  // The folder changes under the app, and the root leaves and comes back.
  fx.tree.set(HOME, [{ name: 'later', dir: true }, { name: 'NOW.md', dir: false }]);
  fx.tree.set(`${HOME}/later`, []);
  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  focusSession('s1');
  panel.render();
  await settle();
  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  panel.render();
  await settle();
  assert.equal(
    byClass(root, 'files-name').some((n) => n.textContent === 'NOW.md'),
    true,
    'non-vacuity: the fresh listing for the root we came back to is on screen',
  );

  fx.release();
  await settle();
  // Not now — and not at the next repaint either, which is where a cache
  // poisoned behind the signature would surface.
  const later = dirRow('later');
  assert.ok(later !== null, 'non-vacuity: the fresh tree is still the one drawn');
  later.click();
  await settle();
  assert.equal(
    byClass(root, 'files-name').some((n) => n.textContent === 'README.md'),
    false,
    'the listing of the root we left never reaches the tree we are in',
  );
  assert.equal(byClass(root, 'files-name').some((n) => n.textContent === 'NOW.md'), true);
});

test('a late REFUSAL for the root we left never replaces the tree we are in', async () => {
  // The failure path of the same rule, and the louder one: an error is drawn
  // instead of the WHOLE folder, so a refusal arriving from the root the panel
  // has left would blank a tree that is perfectly readable.
  await homeWorld();
  let first = true;
  fx.holdIf((c) => {
    if (c.kind !== 'entries' || c.path !== HOME || !first) return false;
    first = false;
    return true;
  });
  // The held answer is READ now, so it is this refusal that travels.
  failWith.set(HOME, new FakeApiError(403, 'You do not have permission to read this folder.'));
  st.state.leftPanel = null;
  panel.render();
  st.state.leftPanel = 'files';
  panel.render();
  failWith.delete(HOME);

  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  focusSession('s1');
  panel.render();
  await settle();
  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  panel.render();
  await settle();
  assert.ok(
    byClass(root, 'files-name').some((n) => n.textContent === 'README.md'),
    'non-vacuity: the root we came back to has answered with its rows',
  );

  fx.release();
  await settle();
  dirRow('web').click();
  await settle();
  assert.equal(
    byClass(root, 'files-row').some((r) => r.textContent.includes('You do not have permission')),
    false,
    'the sentence belongs to the root that asked for it, and that root is gone',
  );
  assert.ok(byClass(root, 'files-name').some((n) => n.textContent === 'DESIGN.md'));
});

test('one listing per folder is in flight at a time: a second ask is dropped, not queued', async () => {
  await homeWorld();
  entryCalls.length = 0;
  fx.hold();
  // Returning to the panel re-reads its root (cache-then-revalidate). Doing it
  // three times while the first answer is still travelling must ask ONCE: a
  // panel the user flips through would otherwise pile up one request per visit,
  // and every one of them would repaint the tree when it landed.
  for (let i = 0; i < 3; i += 1) {
    st.state.leftPanel = null;
    panel.render();
    st.state.leftPanel = 'files';
    panel.render();
  }
  assert.deepEqual(entryCalls, [HOME], 'three returns, one request');

  fx.release();
  await settle();
  // The dedupe is per FLIGHT, not a cache: once the answer has landed the next
  // return asks again, which is the revalidate half of the contract.
  st.state.leftPanel = null;
  panel.render();
  st.state.leftPanel = 'files';
  panel.render();
  assert.deepEqual(entryCalls, [HOME, HOME]);
});

test('a root change prunes the open folders, the cache and a selection outside it', async () => {
  await liveSession();
  dirRow('web/src').click(); // select + toggle: the selection is under the project
  await settle();
  assert.deepEqual(
    F.selectedFolder(),
    { path: `${PROJ}/web/src`, name: 'src' },
    'non-vacuity: it is selected, and it carries the real folder behind its name',
  );

  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  rootNow = HOME;
  panel.render();
  await settle();
  assert.equal(destName(F.selectedFolder()), null, 'a folder nobody can see may not take a paste');
  assert.equal(
    byClass(root, 'files-row').some((r) => r.textContent.includes('App.tsx')),
    false,
    'and the tree is the new root s top level, closed',
  );
});

test('the header names the project of the focused session, and the session itself when it has none', async () => {
  await liveSession();
  assert.equal(textsOf(root, 'files-proj')[0], 'api');

  // A fresh world: the ACTIVE view deliberately keeps a dead pane (state.ts
  // reconcileViews skips it), so a bare setSessions would leave the header on
  // the session that is gone — which is the pane's own story, not the panel's.
  st.state.views = [];
  st.state.activeViewId = '';
  st.setSessions([mkSession('s2', { title: 'scratch shell', command: 'bash' })]);
  focusSession('s2');
  panel.render();
  assert.equal(
    textsOf(root, 'files-proj')[0],
    'scratch shell',
    'a project-less session says what it is — never a path, never blank',
  );
});

test('a dead focused pane does not blank the header — it names what is left, or says there is nothing', () => {
  // state.ts reconcileViews keeps the ACTIVE view's dead pane on purpose, so
  // with a second session alive the panel stays on screen while its focused
  // session is gone. A headerless tree is a tree about nothing.
  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' }), mkSession('s2', { title: 'notes' })]);
  focusSession('s1');
  st.state.leftPanel = 'files';
  panel.render();
  assert.equal(textsOf(root, 'files-proj')[0], 'api', 'non-vacuity: it starts on the focused one');

  // `s1` ends; the ACTIVE view keeps its pane, `s2` is still running in
  // ANOTHER tab. Until part B2 the header borrowed that other session's name;
  // since the user decision of 2026-09-16 it does not — the panel lists a real
  // folder now, and the folder of a session nobody is looking at is not what
  // this screen is about. `Home` is the honest answer, and the tab holding s2
  // is one click away.
  st.setSessions([mkSession('s2', { title: 'notes' })]);
  st.state.views = [
    { id: 'v1', root: null, slots: [{ kind: 'session', id: 's1' }], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
  ];
  st.state.activeViewId = 'v1';
  panel.render();
  assert.equal(st.filesPanelVisible(), true, 'non-vacuity: the panel is still up');
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'a dead pane names no other tab s session');

  // And with nothing running at all it is the same answer, from the same rung.
  st.setSessions([]);
  panel.render();
  assert.equal(st.filesPanelVisible(), true, 'the panel survives the last session');
  assert.equal(textsOf(root, 'files-proj')[0], 'Home');

  const src = readSources(...FILES_PANEL_SOURCES);
  // A11 turned the lookup into one `subject()` the header and `repoKnown()`
  // both read; the constant it falls back to is still the guard here.
  assert.match(src, /name: 'Home', home: true/);
  assert.equal(/return '';/.test(src), false, 'a blank header is never an answer');
});

test('nothing in the tree pulses: no source says which files a session is touching', async () => {
  // Plan open decision 3 is the user's and is NOT settled by part B2, so
  // `editing` is never set and the amber pulse never shows. The CSS hook and
  // the `busy` field stay exactly where they are, unused, until the source of
  // that fact is chosen — which is why this is a test and not a deletion.
  await liveSession();
  assert.ok(byClass(root, 'files-row').length > 6, 'non-vacuity: there is a tree to look at');
  assert.deepEqual(
    byClass(root, 'files-row').filter((r) => r.classList.contains('is-busy')),
    [],
    'a guessed pulse would be the panel inventing what a session is doing',
  );
  const app = readAppCss();
  assert.match(app, /\.files-row\.is-busy \{/, 'the hook survives for whenever the source arrives');
});

test('a folder row toggles its subtree; a file row opens that file as a PANE (A10)', async () => {
  await liveSession();
  const server = dirRow('server');
  assert.equal(server.tagName, 'BUTTON');
  assert.equal(server.getAttribute('aria-expanded'), 'true');
  const before = byClass(root, 'files-row').length;

  server.click();
  assert.equal((dirRow('server')).getAttribute('aria-expanded'), 'false');
  assert.equal(byClass(root, 'files-row').length, before - 3, 'the three server/ files went with it');
  assert.equal(
    byClass(root, 'files-row').some((r) => r.textContent.includes('ws.ts')),
    false,
  );

  (dirRow('server')).click();
  assert.equal(byClass(root, 'files-row').length, before, 'and come back');

  // A10b: the file lands as a TAB of the editor pane of its root folder's tab
  // — here the focused session's project (A10 opened a pane per file; the user
  // asked for one pane with a strip instead).
  const file = fileRow('web/src/Pane.tsx');
  assert.equal(file.tagName, 'BUTTON', 'a row that opens a file is a button, not a hover');
  file.click();
  const v = st.activeView() as ViewLike;
  assert.deepEqual(v.root, { kind: 'project', id: 'p1' }, 'the project of the focused session');
  assert.deepEqual(shapeOf(v), ['*web/src/Pane.tsx']);
  assert.equal(st.state.activeViewId, v.id, 'and the app goes there');

  panel.render();
  assert.equal(
    (fileRow('web/src/Pane.tsx')).classList.contains('is-open'),
    true,
    'the tree says where the panes are standing',
  );
  assert.equal(
    (fileRow('web/src/store.ts')).classList.contains('is-open'),
    false,
    'and only there',
  );

  // Opening the same file twice must not spend a second pane — or a second
  // CHIP — on a copy: the second click RAISES what is already open (A10b).
  (fileRow('web/src/store.ts')).click();
  assert.deepEqual(shapeOf(st.activeView()), ['web/src/Pane.tsx *web/src/store.ts'],
    'the second file is a TAB of the same pane, and it is the one showing');
  (fileRow('web/src/Pane.tsx')).click();
  assert.equal((st.activeView() as ViewLike).slots.length, 1, 'still one pane');
  assert.deepEqual(shapeOf(st.activeView()), ['*web/src/Pane.tsx web/src/store.ts'],
    'and the first file was raised where it stood, never opened twice');
});
