/**
 * `web/src/ui/files.ts` — the Changes tab (part B2 §7) and the B2 fix round
 * (2026-09-16): the repository's own tree and summary, a changed row opening
 * the file at its repository path, the capped note, late git answers and
 * failures for a root the panel left, the 5 s poll only while Changes is
 * visible, the system menu on state rows, and the Home tab staying HOME.
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
 * Why it matters: a late git answer that lights or kills the tabs of the
 * root the user is in lies about the repository in front of them.
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
  FakeApiError,
  HOME,
  NO_REPO,
  PROJ,
  PROJ2,
  repoAnswer,
  settle,
  mkProject as project,
} from '../helpers/fs-fixture.ts';
import {
  aliveSessionCount,
  bindRootNow,
  body,
  changeCalls,
  dirRow,
  dom,
  entryCalls,
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
  st,
  summary,
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
// The Changes tab (part B2 §7)
// ---------------------------------------------------------------------------

test('Changes draws the repository s own tree, its summary and nothing about folders', async () => {
  await liveSession();
  const changes = byKey(root, 'ftab:changes') as FakeElement;
  assert.equal(changes.textContent, 'Changes', 'the third tab, between Files and Commits');
  assert.equal(changes.disabled, false, 'the root is inside a repository');

  changes.click();
  await settle();
  assert.equal(summary.hidden, false, 'the summary moved here with the numbers');
  assert.deepEqual(textsOf(root, 'files-num').slice(0, 2), ['+26', '-12']);
  assert.equal(textsOf(root, 'files-sum-text')[0], 'since last commit in 5 files');
  // The header line names the REPOSITORY, never its path — it can be an
  // ancestor of the folder the Files tab lists, which is exactly why it is
  // said out loud.
  assert.equal(textsOf(root, 'files-branch')[0], 'api, main');

  // Repo-relative paths, drawn by the A5 renderer: folders first as they were
  // built, every row a NAME.
  assert.deepEqual(
    byClass(root, 'files-row').map((r) => r.textContent.replace(/^[▾▸]/, '').trim()),
    ['web', 'server', 'README.md', 'launcher'],
    'the tree starts closed, in git s own order, and an untracked file is one row',
  );
  (byKey(root, 'gdir:web') as FakeElement).click();
  (byKey(root, 'gdir:web/src') as FakeElement).click();
  assert.deepEqual(
    byClass(root, 'files-row')
      .map((r) => r.textContent.replace(/^[▾▸]/, '').trim())
      .slice(0, 4),
    ['web', 'src', 'App.tsx+12-4', 'Pane.tsx+8-6'],
    'a changed file carries its numbers here, where they are about a commit',
  );
  assert.equal(
    byClass(root, 'files-row').some((r) => r.textContent.includes('README.md+')),
    false,
    'an untracked file was never diffed, so it carries no numbers at all',
  );
  (byKey(root, 'ftab:files') as FakeElement).click();
});

test('a changed file row opens the file at its REPOSITORY s path, not the panel root s', async () => {
  await liveSession();
  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  (byKey(root, 'gdir:server') as FakeElement).click();
  (byKey(root, 'gfile:server/ws.ts') as FakeElement).click();
  const tabs = st.state.views.flatMap((v) => v.slots.flatMap((slot) => st.slotTabIds(slot)));
  assert.ok(tabs.includes(`f:${PROJ}/server/ws.ts`), `absolute, from the repo root: ${tabs.join(' ')}`);
  (byKey(root, 'ftab:files') as FakeElement).click();
});

test('the Changes tab s capped note is its LAST row, under the rows it is about', async () => {
  // Same rule as the tree's own cap: the note says what is MISSING from the
  // rows above it, so above them it would be a note about nothing yet.
  fx.changesFor = (r) => (r === PROJ ? repoAnswer({ truncated: 2 }) : NO_REPO);
  await liveSession();
  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  const rows = byClass(body, 'files-row');
  assert.ok(rows.length > 1, 'non-vacuity: there is a tree for the note to be under');
  assert.ok(
    rows.some((r) => r.textContent.includes('web')),
    'non-vacuity: the repository s own rows are the ones above it',
  );
  const note = rows[rows.length - 1] as FakeElement;
  assert.equal(note.textContent, '2 more items are not shown here.');
  assert.equal(note.classList.contains('is-state'), true);
  assert.equal(note.tagName, 'DIV', 'a state is not a control');
  assert.equal(note.style.paddingLeft, '8px', 'at the root s own indent');
  (byKey(root, 'ftab:files') as FakeElement).click();
});

test('a late git answer for the root we LEFT never lights the tabs', async () => {
  // The git answer is also the PROBE: it decides whether `Changes` and
  // `Commits` exist at all. An answer from the repository the panel has already
  // left is therefore the one that would offer a repository at a folder that
  // has none — and open a commit list belonging to somewhere else.
  fx.holdIf((c) => c.kind === 'changes' && c.path === PROJ);
  await liveSession();
  assert.ok(changeCalls.includes(PROJ), 'non-vacuity: the probe for the project went out');

  // Back to Home, which is no repository at all, and its probe answers at once.
  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  rootNow = HOME;
  panel.render();
  await settle();
  assert.ok(changeCalls.includes(HOME), 'non-vacuity: the probe followed the root');

  fx.release();
  await settle();
  // Force the repaint a stale answer would ride in on: the tab states are
  // painted by `rebuild()`, so a cache poisoned behind the signature shows up
  // at the next one, not at the answer itself.
  dirRow('web').click();
  await settle();
  for (const k of ['changes', 'commits']) {
    const b = byKey(root, `ftab:${k}`) as FakeElement;
    assert.equal(b.disabled, true, `${k} may not be lit by the repository we left`);
    assert.equal(b.title, 'No repository at Home');
  }

  // Non-vacuity for the assertion above: a repository answer for THIS root does
  // light them, so "disabled" is a verdict and not the only state reachable here.
  fx.changesFor = () => repoAnswer({ repoRoot: HOME });
  st.state.leftPanel = null;
  panel.render();
  st.state.leftPanel = 'files';
  panel.render();
  await settle();
  assert.equal((byKey(root, 'ftab:commits') as FakeElement).disabled, false);
});

test('a clean repository says so in one sentence, and shows no summary', async () => {
  fx.changesFor = (r) => (r === PROJ ? repoAnswer({ files: [] }) : NO_REPO);
  await liveSession();
  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  assert.equal(summary.hidden, true, '+0 -0 in 0 files says the same thing twice');
  const rows = byClass(root, 'files-row');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.textContent, 'No changes since the last commit.');
  assert.equal(rows[0]?.classList.contains('is-state'), true);
  (byKey(root, 'ftab:files') as FakeElement).click();
});

test('no repository: Changes and Commits are really disabled, and say where', async () => {
  await homeWorld();
  for (const k of ['changes', 'commits']) {
    const b = byKey(root, `ftab:${k}`) as FakeElement;
    assert.equal(b.disabled, true, `${k} is really disabled, not merely dimmed`);
    assert.equal(b.getAttribute('aria-disabled'), 'true');
    assert.equal(b.title, 'No repository at Home', 'and it says why, on hover and aloud');
  }
  assert.equal((byKey(root, 'ftab:files') as FakeElement).disabled, false);
});

test('the probe is REAL: a home folder that IS a repository offers both tabs', async () => {
  // A11's stopgap was "the header does not read Home". Since B2 it is the
  // git answer for the root, so this — a home directory under version
  // control — is a state the panel can now be honest about.
  fx.changesFor = () => ({
    isRepo: true,
    repoRoot: HOME,
    branch: 'main',
    files: [{ path: 'README.md', add: 1, del: 0, status: 'modified' as const }],
    truncated: 0,
  });
  await homeWorld();
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'non-vacuity: this is the Home subject');
  assert.equal((byKey(root, 'ftab:changes') as FakeElement).disabled, false);
  assert.equal((byKey(root, 'ftab:commits') as FakeElement).disabled, false);
  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  assert.equal(textsOf(root, 'files-branch')[0], 'you, main', 'the repository, by NAME');
  (byKey(root, 'ftab:files') as FakeElement).click();
});

test('the panel falls back to Files when the tab it stood on loses its repository', async () => {
  await liveSession();
  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  assert.equal(
    (byKey(root, 'ftab:changes') as FakeElement).getAttribute('aria-pressed'),
    'true',
    'non-vacuity: the panel really is standing on Changes',
  );

  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  rootNow = HOME;
  panel.render();
  await settle();
  assert.equal((byKey(root, 'ftab:changes') as FakeElement).disabled, true);
  assert.equal(
    (byKey(root, 'ftab:files') as FakeElement).getAttribute('aria-pressed'),
    'true',
    'the panel cannot keep standing on a tab that leads nowhere',
  );
});

test('the 5 s poll exists only while Changes is the visible tab and the panel is up', async () => {
  await liveSession();
  assert.equal(dom.win.intervals.length, 0, 'the Files tab polls nothing at all');

  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  assert.equal(dom.win.intervals.length, 1, 'one timer, and only here');
  assert.equal(dom.win.intervals[0]?.ms, 5000, 'CHANGES_POLL_MS');

  const before = changeCalls.length;
  (dom.win.intervals[0] as { fn: () => void }).fn();
  await settle();
  assert.equal(changeCalls.length, before + 1, 'a tick re-asks git');

  // A tick while a request is still in flight is skipped, not queued.
  fx.hold();
  (dom.win.intervals[0] as { fn: () => void }).fn();
  (dom.win.intervals[0] as { fn: () => void }).fn();
  assert.equal(changeCalls.length, before + 2, 'one request, not two');
  fx.release();
  await settle();

  // Hiding the panel drops the timer; so does leaving the tab.
  st.state.leftPanel = null;
  panel.render();
  assert.equal(dom.win.intervals.length, 0, 'a panel nobody can see costs nothing');
  st.state.leftPanel = 'files';
  panel.render();
  await settle();
  assert.equal(dom.win.intervals.length, 1, 'and it comes back with the panel');
  (byKey(root, 'ftab:files') as FakeElement).click();
  assert.equal(dom.win.intervals.length, 0, 'the tab switch clears it');
});

test('Changes refreshes on tab open and on a root change, and the tree does not poll', async () => {
  await liveSession();
  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  const opened = changeCalls.length;
  assert.ok(opened > 0, 'non-vacuity: opening the tab asked');
  const listings = entryCalls.length;

  // A root change asks again — for the NEW root — and re-reads that folder.
  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  rootNow = HOME;
  panel.render();
  await settle();
  assert.equal(changeCalls[changeCalls.length - 1], HOME, 'the probe follows the root');
  assert.ok(entryCalls.length > listings, 'and so does the listing');
});

test('a late git FAILURE for the root we left does not take the current repository away', async () => {
  // `changes` is both the data and the probe, so a stale refusal does two
  // things at once: it blanks the tree and it disables the two tabs — on a root
  // whose own git call answered perfectly well.
  fx.changesFor = (r) =>
    r === PROJ ? new FakeApiError(500, 'The app could not read this repository.') : repoAnswer({ repoRoot: HOME });
  fx.holdIf((c) => c.kind === 'changes' && c.path === PROJ);
  await liveSession();

  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  rootNow = HOME;
  panel.render();
  await settle();
  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  assert.equal(textsOf(root, 'files-branch')[0], 'you, main', 'non-vacuity: this root has a repository');

  fx.release();
  await settle();
  // Force the repaint a stale answer would ride in on: what the tabs and the
  // rows say is painted by `rebuild()`, so a poisoned state surfaces at the
  // next one and not at the answer itself. Opening a folder of this tab's own
  // tree is the cheapest one — it asks git nothing.
  (byKey(root, 'gdir:web') as FakeElement).click();
  await settle();
  assert.equal(
    byClass(root, 'files-row').some((r) => r.textContent.includes('could not read this repository')),
    false,
    'the refusal belongs to the repository we left',
  );
  assert.equal((byKey(root, 'ftab:changes') as FakeElement).disabled, false);
  assert.equal((byKey(root, 'ftab:commits') as FakeElement).disabled, false);
  // Leave the Changes tree as it was found: its open set is the panel's own
  // instance state and outlives one test, exactly as the app's does.
  (byKey(root, 'gdir:web') as FakeElement).click();
  (byKey(root, 'ftab:files') as FakeElement).click();
});

test('the git answer that fails puts the SERVER s sentence where the rows would be', async () => {
  fx.changesFor = (r) =>
    r === PROJ ? new FakeApiError(500, 'The app could not read this repository.') : NO_REPO;
  await liveSession();
  // The tab is disabled — `isRepo` is unknown — so the sentence is reached
  // through the tab that is still standing: the panel never strands the user
  // on a screen with nothing on it.
  assert.equal((byKey(root, 'ftab:changes') as FakeElement).disabled, true);
  assert.equal((byKey(root, 'ftab:changes') as FakeElement).title, 'No repository at api');
});

// ---------------------------------------------------------------------------
// The fix round (part B2, 2026-09-16)
// ---------------------------------------------------------------------------

test('a right-click on a STATE row and on a Changes row is left to the system menu', async () => {
  // A row that has no actions may not EAT the gesture: preventing before the
  // key was read left `Loading…`, a refusal and every `Changes` row with no app
  // menu AND no system menu — a right-click that did nothing at all.
  await liveSession();
  fx.hold();
  dirRow('launcher').click();
  const stateRow = byClass(root, 'files-row').find((r) => r.textContent === 'Loading…') as FakeElement;
  assert.ok(stateRow !== undefined, 'non-vacuity: a state row is on screen');
  const onState = dispatch(stateRow, 'contextmenu', { clientX: 10, clientY: 10 });
  assert.equal(onState.defaultPrevented, false, 'the app took a right-click it has no menu for');
  assert.equal(byClass(dom.body, 'cm-menu').length, 0, 'and opened nothing');
  fx.release();
  await settle();

  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  const changeRow = byKey(root, 'gdir:web') as FakeElement;
  assert.ok(changeRow !== null, 'non-vacuity: a Changes row is on screen');
  const onChange = dispatch(changeRow, 'contextmenu', { clientX: 10, clientY: 10 });
  assert.equal(onChange.defaultPrevented, false, 'a repo-relative row has no actions either');
  assert.equal(byClass(dom.body, 'cm-menu').length, 0);
  (byKey(root, 'ftab:files') as FakeElement).click();
});

test('a changed file row promises only what it does', async () => {
  await liveSession();
  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  const folder = byKey(root, 'gdir:server') as FakeElement;
  if (folder.getAttribute('aria-expanded') !== 'true') folder.click();
  const row = byKey(root, 'gfile:server/ws.ts') as FakeElement;
  assert.ok(row !== null, 'non-vacuity: the changed file row is on screen');
  assert.equal(row.title, 'Open in a pane.', 'no drag, no chord, no menu — so it names none of them');
  assert.equal(row.getAttribute('aria-haspopup'), null, 'it opens no menu');
  // And the TREE row, which really is all three, keeps its own sentence.
  (byKey(root, 'ftab:files') as FakeElement).click();
  assert.match(fileRow('web/src/Pane.tsx').title, /ctrl\+alt\+enter/);
});

test('only a §1d-shaped sentence reaches a row; anything else is the app s own line', async () => {
  // `request()` invents `HTTP <status>` when a body carries no `error`, and an
  // older backend answers the picker's lowercase vocabulary. Neither is a
  // sentence this app wrote, and neither may be printed as one.
  await liveSession();
  for (const [message, shown] of [
    ['not found', 'The app could not reach the service.'],
    ['HTTP 502', 'The app could not reach the service.'],
    ['permission denied', 'The app could not reach the service.'],
    ['You do not have permission to read this folder.', 'You do not have permission to read this folder.'],
  ] as const) {
    failWith.set(`${PROJ}/launcher`, new FakeApiError(500, message));
    await reopen('launcher');
    const row = byClass(root, 'files-row').find((r) => r.classList.contains('is-err')) as FakeElement;
    assert.ok(row !== undefined, `non-vacuity: no refusal row for ${message}`);
    assert.equal(row.textContent, shown, `${message} is rendered as ${row.textContent}`);
  }
  failWith.clear();
  await reopen('launcher');
});

test('moving between two repositories keeps the Changes tab — unknown is not "no"', async () => {
  // `setRoot` drops the old git answer, so for the width of one call the panel
  // does not know. Falling back on "not yet" took the tab away from anyone
  // switching projects — the one tab they were watching, lost twice a click.
  fx.setChanges((r) => (r === PROJ || r === PROJ2 ? repoAnswer({ repoRoot: r }) : NO_REPO));
  await liveSession();
  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  assert.equal(
    (byKey(root, 'ftab:changes') as FakeElement).getAttribute('aria-pressed'),
    'true',
    'non-vacuity: standing on Changes over repository A',
  );

  // Repository B, with its answer held: the tab is still the one on screen.
  fx.hold();
  st.setProjects([project('p1', 'api'), project('p2', 'tools')]);
  st.setSessions([mkSession('s2', { projectId: 'p2' })]);
  focusSession('s2');
  panel.render();
  assert.equal(
    (byKey(root, 'ftab:changes') as FakeElement).getAttribute('aria-pressed'),
    'true',
    'the wished tab survives the unknown window',
  );
  fx.release();
  await settle();
  assert.equal(
    (byKey(root, 'ftab:changes') as FakeElement).getAttribute('aria-pressed'),
    'true',
    'and B s answer keeps it',
  );
  assert.equal((byKey(root, 'ftab:changes') as FakeElement).disabled, false);

  // A root with NO repository is the definite no: only then does it fall back.
  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  rootNow = HOME;
  panel.render();
  await settle();
  assert.equal((byKey(root, 'ftab:files') as FakeElement).getAttribute('aria-pressed'), 'true');
  assert.equal((byKey(root, 'ftab:changes') as FakeElement).disabled, true);

  // …and the wish is remembered: a repository again brings the tab back.
  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  focusSession('s1');
  rootNow = PROJ;
  panel.render();
  await settle();
  assert.equal(
    (byKey(root, 'ftab:changes') as FakeElement).getAttribute('aria-pressed'),
    'true',
    'the tab the user chose comes back with its repository',
  );
  (byKey(root, 'ftab:files') as FakeElement).click();
});

test('the Home tab is HOME, whatever is running in another tab', async () => {
  // User decision 2026-09-16. Until part B2 the last rung was "the first live
  // session anywhere", which only chose a NAME over a mock. It now chooses a
  // FOLDER, and a tree about a session nobody is looking at is a tree about
  // the wrong thing.
  await liveSession();
  assert.equal(textsOf(root, 'files-proj')[0], 'api', 'non-vacuity: the session s tab is up');

  const home = st.state.views.find((v) => v.root !== null && v.root.kind === 'home') as ViewLike;
  assert.ok(home !== undefined, 'non-vacuity: the fixed Home tab exists');
  st.state.activeViewId = home.id;
  rootNow = HOME;
  panel.render();
  await settle();
  assert.equal(aliveSessionCount(), 1, 'non-vacuity: the session is still running');
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'the header follows the tab, not the session');
  assert.deepEqual(
    textsOf(root, 'files-name'),
    ['web', 'server', 'launcher', 'shared', 'README.md', 'LICENSE'],
    'and so does the tree',
  );
  assert.deepEqual(F.filesPanelDestination(), { path: HOME, name: 'Home' });
});
