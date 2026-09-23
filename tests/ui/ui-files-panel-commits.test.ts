/**
 * `web/src/ui/files.ts` — the Commits tab (part B3, Nocturne A11): the list
 * asks for ten from the root the Changes tab sends, `Show more` pinned to the
 * head of page one, the poll, empty / detached / refused / dead-backend
 * states, a root change, and the tab at Home appearing and going away with
 * the sessions. Split out of `ui-files-panel.test.ts`.
 *
 * Seam: the REAL `web/src/ui/files.ts` on the shared DOM double, against the
 * REAL `web/src/state.ts`, `ui/util.ts`, `ui/icons.ts`, `ui/files-model.ts`,
 * `ui/fs-model.ts`, `ui/commit-model.ts` and `ui/commit-store.ts`, with the
 * backend a fake `FsGateway` (`tests/helpers/fs-fixture.ts` over
 * `tests/helpers/commits-fixture.ts`) — no HTTP, no module stubbing, no clock.
 * Booted once per file by `tests/helpers/ui-files-panel-fixture.ts` and reset
 * before every test (`resetPanel`).
 *
 * Why it matters: a history mixed from two roots, or a dead commit row,
 * reads as the repository's real history.
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
  textsOf,
  type FakeElement,
} from '../helpers/fake-dom.ts';
import {
  FakeApiError,
  HOME,
  PROJ,
  PROJ2,
  repoAnswer,
  settle,
  mkProject as project,
} from '../helpers/fs-fixture.ts';
import {
  BRANCH,
  EMPTY_PAGE,
  NOT_A_REPO,
  HEAD,
  SUMMARIES,
  TOTAL,
  hashOf,
  pageOf,
} from '../helpers/commits-fixture.ts';
import {
  aliveSessionCount,
  bindRootNow,
  changeCalls,
  commitsCalls,
  dom,
  focusSession,
  fx,
  homeWorld,
  liveSession,
  mkSession,
  panel,
  resetPanel,
  root,
  st,
  summary,
  viewRender,
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

test('the Commits tab swaps the body and hides the summary; both tabs say which is up', async () => {
  await liveSession();
  const files = byKey(root, 'ftab:files') as FakeElement;
  const commits = byKey(root, 'ftab:commits') as FakeElement;
  assert.equal(files.getAttribute('aria-pressed'), 'true');
  assert.equal(commits.getAttribute('aria-pressed'), 'false');

  commits.click();
  await settle();
  assert.equal(commits.getAttribute('aria-pressed'), 'true');
  assert.equal(files.getAttribute('aria-pressed'), 'false');
  assert.equal(summary.hidden, true, 'a file summary over a commit list would be a lie');
  assert.equal(byClass(root, 'files-row').length, 0);
  // The header states the branch and the REPOSITORY's total, not the number of
  // rows on screen: the list holds one page of ten.
  assert.equal(textsOf(root, 'files-branch')[0], `${BRANCH}, ${TOTAL} commits`);

  const rows = byClass(root, 'commit-row');
  assert.equal(rows.length, 10, 'the first page is ten (user decision D1)');
  assert.ok(TOTAL > 10, 'non-vacuity: the history is longer than one page');
  const first = SUMMARIES[0] as (typeof SUMMARIES)[number];
  assert.equal(textsOf(root, 'commit-msg')[0], first.subject);
  assert.equal(textsOf(root, 'commit-hash')[0], first.shortHash, 'the SHORT hash in the row');
  assert.equal(textsOf(root, 'commit-author')[0], first.author);
  assert.equal(textsOf(root, 'commit-date')[0], '21 Sep 2026', 'the absolute date');
  assert.ok(rows[0]?.textContent.includes('3 hours ago'), 'and the relative time beside it');
  assert.ok(rows[0]?.textContent.includes(`+${first.add}`));
  assert.ok(rows[0]?.textContent.includes(`-${first.del}`));
  // The full date and time is the tooltip, not a fourth line.
  assert.equal(
    (byClass(rows[0] as FakeElement, 'commit-when')[0] as FakeElement).title,
    '21 Sep 2026 at 09:00',
  );
  // A6: a commit row opens the full commit view, by the FULL hash.
  assert.equal(rows[0]?.tagName, 'BUTTON', 'a commit row is a control now, not a card');
  assert.equal(rows[0]?.getAttribute('data-k'), `commit:${first.hash}`);
  assert.equal(rows[0]?.textContent.includes(first.hash), false, 'forty characters are not a row');

  files.click();
  assert.equal(summary.hidden, true, 'the summary belongs to Changes, not to a folder listing');
  assert.ok(byClass(root, 'files-row').length > 0, 'and the tree comes back');
});

test('the list asks for TEN, from the root the Changes tab sends, and says Loading first', async () => {
  await liveSession();
  fx.hold();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  assert.deepEqual(textsOf(root, 'files-row'), ['Loading…'], 'no rows are invented meanwhile');
  fx.release();
  await settle();
  assert.deepEqual(commitsCalls, [{ root: PROJ, limit: 10, skip: 0, from: undefined }]);
  assert.equal(byClass(root, 'commit-row').length, 10);
});

test('`Show more` loads ten more, PINNED to the head of page one', async () => {
  await liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  const more = byKey(root, 'commit:more') as FakeElement;
  assert.notEqual(more, null, 'there is an older page, so the row is there');
  assert.equal(more.textContent, 'Show more');
  assert.equal(more.tagName, 'BUTTON', 'an ordinary button in tab order — no new chord');

  more.click();
  await settle();
  assert.deepEqual(commitsCalls[1], { root: PROJ, limit: 10, skip: 10, from: HEAD });
  assert.equal(byClass(root, 'commit-row').length, TOTAL, 'both pages are on screen');
  assert.deepEqual(
    textsOf(root, 'commit-hash'),
    SUMMARIES.map((c) => c.shortHash),
    'in order, with nothing repeated and nothing skipped',
  );
  assert.equal(byKey(root, 'commit:more'), null, 'and the row goes when there is no more');
});

test('a page still in flight disables the row and says so, and a second press asks nothing', async () => {
  await liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  fx.hold();
  (byKey(root, 'commit:more') as FakeElement).click();
  const busy = byKey(root, 'commit:more') as FakeElement;
  assert.equal(busy.textContent, 'Loading…');
  assert.equal(busy.disabled, true);
  busy.click();
  assert.equal(commitsCalls.length, 2, 'one request, not two');
  fx.release();
  await settle();
  assert.equal(byClass(root, 'commit-row').length, TOTAL);
});

test('the poll asks page ONE: the same head changes nothing, a new head resets the list', async () => {
  await liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  (byKey(root, 'commit:more') as FakeElement).click();
  await settle();
  assert.equal(byClass(root, 'commit-row').length, TOTAL, 'two pages loaded');

  const tick = dom.win.intervals[0] as { fn: () => void };
  assert.equal(dom.win.intervals[0]?.ms, 5000, 'the Changes tab`s own rule');
  tick.fn();
  await settle();
  assert.deepEqual(commitsCalls[2], { root: PROJ, limit: 10, skip: 0, from: undefined });
  assert.equal(byClass(root, 'commit-row').length, TOTAL, 'same head: the loaded pages stay');

  // A commit landed: the head moved, so the pinned pages under it are no longer
  // reachable from it and the list goes back to page one.
  const moved = hashOf(99);
  fx.setCommits((_root, limit, skip) => ({ ...pageOf(limit, skip), head: moved }));
  tick.fn();
  await settle();
  assert.equal(byClass(root, 'commit-row').length, 10, 'back to one page');
  // And the next `Show more` pins to the NEW head.
  (byKey(root, 'commit:more') as FakeElement).click();
  await settle();
  assert.equal((commitsCalls[commitsCalls.length - 1] as { from: string }).from, moved);
});

test('a commit row is never a dead click: the history may answer BEFORE the repository', async () => {
  // `setRoot()` nulls the Changes answer while the Commits tab stays up (the
  // wished tab survives an unknown `isRepo`), and the two requests race. The
  // row opens the view with the root it was read from; the repository is
  // filled in when its own answer lands.
  await liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  // Both roots are repositories; only the history answers for now.
  fx.setChanges((r) => (r === PROJ2 ? repoAnswer({ repoRoot: PROJ2 }) : repoAnswer()));
  fx.setCommits((_r, limit, skip) => pageOf(limit, skip));
  fx.holdIf((c) => c.kind === 'changes');

  st.setProjects([project('p1', 'api'), project('p2', 'tools')]);
  st.setSessions([mkSession('s2', { projectId: 'p2' })]);
  focusSession('s2');
  rootNow = PROJ2;
  panel.render();
  await settle();
  assert.ok(byClass(root, 'commit-row').length > 0, 'the list answered first');

  (byKey(root, `commit:${HEAD}`) as FakeElement).click();
  assert.equal(st.state.openCommit, HEAD, 'the click DID something');
  assert.deepEqual(
    st.state.openCommitAt,
    { root: PROJ2, repoRoot: null },
    'the root now, the repository later',
  );

  fx.release();
  await settle();
  assert.deepEqual(
    st.state.openCommitAt,
    { root: PROJ2, repoRoot: PROJ2 },
    'the Changes answer for the same root fills it in',
  );
  st.closeCommitView();
  viewRender();
  rootNow = PROJ;
});

test('a root change while page one is in flight asks the NEW root at once', async () => {
  // `dropCommits()` has to clear the flight marker too: with it left set, the
  // render that follows thinks a request for the new root is already out and
  // the list waits for the next poll tick — five seconds, or forever with the
  // panel hidden.
  await liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  fx.holdIf((c) => c.kind === 'commits');
  // A root change with page one still out.
  st.setSessions([mkSession('s2', { projectId: 'p2' })]);
  st.setProjects([project('p1', 'api'), project('p2', 'tools')]);
  focusSession('s2');
  rootNow = PROJ2;
  panel.render();
  await settle();
  const asked = commitsCalls.map((c) => c.root);
  assert.ok(asked.includes(PROJ2), `the new root was asked at once: ${asked.join(' ')}`);
  fx.release();
  await settle();
  // The answer for the root we LEFT never paints.
  assert.equal(byClass(root, 'commit-row').length, 0, 'PROJ2 is no repository, so no rows');
  rootNow = PROJ;
});

test('`Show more` while the POLL is in flight still loads the page', async () => {
  // Two questions, two flight markers: a tick about page one may not swallow
  // the only way to see older commits.
  await liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  fx.hold(); // the poll tick below stays out
  (dom.win.intervals[0] as { fn: () => void }).fn();
  const afterTick = commitsCalls.length;
  const more = byKey(root, 'commit:more') as FakeElement;
  assert.equal(more.disabled, false, 'a poll does not disable the row');
  assert.equal(more.textContent, 'Show more');
  more.click();
  assert.equal(commitsCalls.length, afterTick + 1, 'the page really was asked for');
  assert.deepEqual(commitsCalls[commitsCalls.length - 1], {
    root: PROJ,
    limit: 10,
    skip: 10,
    from: HEAD,
  });
  fx.release();
  await settle();
  assert.equal(byClass(root, 'commit-row').length, TOTAL, 'and both pages are on screen');
});

test('ONE poll timer: it follows the visible tab and goes with the panel', async () => {
  await liveSession();
  assert.equal(dom.win.intervals.length, 0, 'the Files tab polls nothing');
  (byKey(root, 'ftab:changes') as FakeElement).click();
  await settle();
  assert.equal(dom.win.intervals.length, 1, 'Changes arms it');
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  assert.equal(dom.win.intervals.length, 1, 'Commits keeps exactly ONE, not a second');
  assert.equal(dom.win.intervals[0]?.ms, 5000);

  // A tick asks the VISIBLE tab's question, and only that one.
  const commitsBefore = commitsCalls.length;
  const changesBefore = changeCalls.length;
  (dom.win.intervals[0] as { fn: () => void }).fn();
  await settle();
  assert.equal(commitsCalls.length, commitsBefore + 1, 'the history was re-asked');
  assert.equal(changeCalls.length, changesBefore, 'and the diff was not');

  st.state.leftPanel = null;
  panel.render();
  assert.equal(dom.win.intervals.length, 0, 'a panel nobody can see costs nothing');
  st.state.leftPanel = 'files';
  panel.render();
  await settle();
  assert.equal(dom.win.intervals.length, 1, 'and it comes back with the panel');
  (byKey(root, 'ftab:files') as FakeElement).click();
  assert.equal(dom.win.intervals.length, 0, 'leaving both watching tabs clears it');
});

test('an empty repository names its branch and says there is nothing yet', async () => {
  fx.setCommits(() => EMPTY_PAGE);
  await liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  assert.equal(textsOf(root, 'files-branch')[0], BRANCH, 'the branch alone — 0 commits is not a count');
  assert.deepEqual(textsOf(root, 'files-row'), ['No commits yet.']);
  assert.equal(byClass(root, 'commit-row').length, 0);
  assert.equal(byKey(root, 'commit:more'), null);
});

test('a root that stopped being a repository draws NOTHING, never `No commits yet.`', async () => {
  // An empty repository and a folder with no repository are two different
  // facts. The Changes probe is what takes the tab away on the next render;
  // until it does, this tab says nothing rather than the wrong thing — and it
  // asks nothing either, so a held answer can never become a request loop.
  await liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  fx.setCommits(() => NOT_A_REPO);
  const before = commitsCalls.length;
  (dom.win.intervals[0] as { fn: () => void }).fn();
  await settle();
  assert.equal(byClass(root, 'commit-row').length, 0);
  assert.deepEqual(textsOf(root, 'files-row'), [], 'not one sentence about a repository');
  panel.render();
  panel.render();
  await settle();
  assert.equal(commitsCalls.length, before + 1, 'and a repaint asks nothing');
});

test('a detached head has no branch to name, and says the one word for that', async () => {
  fx.setCommits((_root, limit, skip) => ({ ...pageOf(limit, skip), branch: null }));
  await liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  assert.equal(textsOf(root, 'files-branch')[0], `Detached, ${TOTAL} commits`);
});

test('a refused history draws the SERVER`s sentence, in the danger ink', async () => {
  fx.setCommits(() => new FakeApiError(500, 'The app could not read this repository.'));
  await liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  const row = byClass(root, 'files-row')[0] as FakeElement;
  assert.equal(row.textContent, 'The app could not read this repository.');
  assert.equal(row.classList.contains('is-err'), true, 'the danger ink every refusal wears');
  assert.equal(byClass(root, 'commit-row').length, 0);
});

test('a `Show more` that fails keeps the rows it could not extend', async () => {
  await liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  fx.setCommits(() => new FakeApiError(404, 'This commit is no longer there.'));
  (byKey(root, 'commit:more') as FakeElement).click();
  await settle();
  assert.equal(byClass(root, 'commit-row').length, 10, 'the loaded page is still true');
  const states = textsOf(root, 'files-row');
  assert.ok(states.includes('This commit is no longer there.'), states.join(' | '));
});

test('a dead backend gets the app`s own sentence, never a status code', async () => {
  fx.setCommits(() => new FakeApiError(502, 'HTTP 502'));
  await liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  assert.deepEqual(textsOf(root, 'files-row'), ['The app could not reach the service.']);
});

test('the history is re-read when the ROOT moves, and never mixed with the old one', async () => {
  await liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  assert.equal(byClass(root, 'commit-row').length, 10);

  // Away to a folder that is not a repository: the tab goes, and with it the
  // history that belonged to the other root.
  st.setSessions([]);
  st.state.views = [];
  st.state.activeViewId = '';
  rootNow = HOME;
  panel.render();
  await settle();
  assert.equal(byClass(root, 'commit-row').length, 0, 'no row of the old repository survives');
});

// ---------------------------------------------------------------------------
// The Commits tab at Home (Nocturne A11)
// ---------------------------------------------------------------------------

test('with nothing alive there is no repository, so the Commits tab is not viewable', () => {
  // User decision 2026-09-15: the panel is up from the first paint, headed
  // `Home` — and a home folder is not a repository, so a commit list there
  // would be a view on nothing.
  st.state.leftPanel = 'files';
  st.state.drawer = null;
  panel.render();
  assert.equal(textsOf(root, 'files-proj')[0], 'Home', 'non-vacuity: this is the Home state');

  const commits = byKey(root, 'ftab:commits') as FakeElement;
  const files = byKey(root, 'ftab:files') as FakeElement;
  assert.equal(commits.disabled, true, 'really disabled, not merely dimmed');
  assert.equal(commits.getAttribute('aria-disabled'), 'true');
  assert.equal(commits.title, 'No repository at Home', 'and it says why, on hover and aloud');
  assert.equal(files.disabled, false, 'the tree is still there to look at');
  assert.equal(files.getAttribute('aria-pressed'), 'true');
});

test('the last session exiting takes the Commits tab away under the user, and lands on Files', async () => {
  await liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  assert.equal(
    (byKey(root, 'ftab:commits') as FakeElement).getAttribute('aria-pressed'),
    'true',
    'non-vacuity: the panel really is standing on Commits',
  );
  assert.equal((byKey(root, 'ftab:commits') as FakeElement).disabled, false);

  st.markExited('s1', 0);
  panel.render();
  await settle();
  assert.equal(textsOf(root, 'files-proj')[0], 'Home');
  assert.equal(aliveSessionCount(), 0, 'non-vacuity: nothing is running');

  const commits = byKey(root, 'ftab:commits') as FakeElement;
  const files = byKey(root, 'ftab:files') as FakeElement;
  assert.equal(commits.disabled, true);
  assert.equal(commits.getAttribute('aria-disabled'), 'true');
  assert.equal(commits.title, 'No repository at Home');
  assert.equal(commits.getAttribute('aria-pressed'), 'false', 'the panel did not stay on it');
  assert.equal(files.getAttribute('aria-pressed'), 'true');
  assert.equal(files.classList.contains('is-on'), true);
  assert.ok(byClass(root, 'files-row').length >= 6, 'and the tree is what it fell back to');
  assert.equal(byClass(root, 'commit-row').length, 0, 'no commit list survives the fall back');
});

test('a session appearing again gives the Commits tab back, title and all', async () => {
  st.state.leftPanel = 'files';
  panel.render();
  assert.equal(
    (byKey(root, 'ftab:commits') as FakeElement).disabled,
    true,
    'non-vacuity: it starts unavailable',
  );

  await liveSession();
  const commits = byKey(root, 'ftab:commits') as FakeElement;
  assert.equal(commits.disabled, false);
  assert.equal(commits.getAttribute('aria-disabled'), null, 'the reason is gone with the state');
  assert.equal(commits.title, '');

  commits.click();
  await settle();
  assert.equal(commits.getAttribute('aria-pressed'), 'true', 'and it leads somewhere again');
  assert.equal(textsOf(root, 'files-branch')[0], `${BRANCH}, ${TOTAL} commits`);
  (byKey(root, 'ftab:files') as FakeElement).click(); // the tab is panel-local state
});

test('clicking the disabled Commits tab switches nothing (the fake DOM still fires it)', async () => {
  // fake-dom's click() dispatches whatever the button's `disabled` says — a
  // real browser fires nothing — so this pins the panel's own guard, which is
  // what keeps a stray programmatic click out of a view on nothing.
  await homeWorld();
  const commits = byKey(root, 'ftab:commits') as FakeElement;
  assert.equal(commits.disabled, true, 'non-vacuity: the guard is the subject here');

  commits.click();
  assert.equal(commits.getAttribute('aria-pressed'), 'false');
  assert.equal(commits.classList.contains('is-on'), false);
  assert.equal((byKey(root, 'ftab:files') as FakeElement).getAttribute('aria-pressed'), 'true');
  assert.ok(byClass(root, 'files-row').length >= 6, 'still the tree');
  assert.equal(byClass(root, 'commit-row').length, 0);
});
