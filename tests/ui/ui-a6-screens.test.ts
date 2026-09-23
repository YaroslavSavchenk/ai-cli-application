/**
 * The commit view (Nocturne A6, re-pointed by A10, LIVE since B3): the screen
 * itself (header from the server's answer, one request per commit, the
 * loading state), `Open on GitHub` (user decision D2) and the two openers
 * (`Open file`, `Changes`). Blocks, folds and diffs are in
 * `ui-a6-screens-blocks.test.ts`, the shell wiring in
 * `ui-a6-screens-shell.test.ts`, the state contract in
 * `ui-a6-screens-state.test.ts`.
 *
 * Seam: the REAL `web/src/ui/commit-view.ts` on the shared DOM double, against
 * the REAL `web/src/state.ts`, `ui/util.ts`, `ui/icons.ts`,
 * `ui/commit-store.ts` and the A6 models — with the backend a plain fake
 * object (`tests/helpers/fs-fixture.ts`) over the fixture history
 * (`tests/helpers/commits-fixture.ts`), booted once per file by
 * `tests/helpers/ui-a6-screens-fixture.ts` and reset before every test.
 *
 * WHY, next to `ui-commit-model.test.ts`. That file pins the arithmetic and
 * the copy; this one pins the PLUMBING, which is where the silent regressions
 * live: a back button that closes nothing, an `Open file` that opens a
 * repo-relative path nothing can read, a GitHub button for a repository that
 * has none. Every one of those keeps the model tests green.
 *
 * THE EDITOR HALF OF THIS FILE IS GONE WITH THE EDITOR COLUMN (part A10): a
 * file is a PANE now, so its body is pinned in `tests/ui/ui-file-pane.test.ts`,
 * its chrome in `tests/ui/ui-pane-a10.test.ts` and its tab chip in
 * `tests/ui/ui-tabs-a10.test.ts`.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, colour, a pane really reflowing a PTY, focus policy, scrolling,
 * screen-reader output.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  byClass,
  byKey,
  textsOf,
  type FakeElement,
} from '../helpers/fake-dom.ts';
import { settle } from '../helpers/fs-fixture.ts';
import {
  GITHUB,
  REPO_ROOT,
  HEAD,
  NO_GITHUB,
  detailOf,
  hashOf,
} from '../helpers/commits-fixture.ts';
import { readSource } from '../helpers/helpers.ts';
import {
  AT,
  C0,
  F0,
  F1,
  ROOT,
  commitRoot,
  dom,
  fx,
  handBacks,
  open,
  paneHandovers,
  resetScreen,
  st,
  tabsOf,
  view,
  type View,
} from '../helpers/ui-a6-screens-fixture.ts';

beforeEach(resetScreen);

// ---------------------------------------------------------------------------
// The commit view
// ---------------------------------------------------------------------------

test('a closed commit view renders nothing at all', () => {
  assert.equal(byClass(commitRoot, 'commit-vmsg').length, 0);
  assert.equal(byClass(commitRoot, 'diff-block').length, 0);
});

test('an opened commit fills the header from the SERVER`s own answer', async () => {
  await open(HEAD);
  assert.equal(textsOf(commitRoot, 'commit-vmsg')[0], C0.commit.subject);
  assert.equal(textsOf(commitRoot, 'commit-vauthor')[0], C0.commit.author);
  assert.equal(textsOf(commitRoot, 'commit-avatar')[0], C0.commit.author.charAt(0).toUpperCase());
  assert.ok(commitRoot.textContent.includes('committed 3 hours ago'), commitRoot.textContent);
  assert.equal(textsOf(commitRoot, 'commit-vwhen')[0], '21 Sep 2026 at 09:00', 'the full date too');
  assert.equal(textsOf(commitRoot, 'commit-branch')[0], 'main');
  assert.equal(textsOf(commitRoot, 'commit-vhash')[0], C0.commit.shortHash, 'the SHORT hash');
  assert.equal(commitRoot.textContent.includes(HEAD), false, 'forty characters are not a chip');
  // The message body, when there is one: the user's own text, wrapped.
  assert.equal(textsOf(commitRoot, 'commit-vtext')[0], C0.body);
  assert.ok((C0.body ?? '').includes('\n'), 'non-vacuity: this commit really has a body');
  // …and it lives in the SCROLLER, never in the fixed header: a 40-line
  // message in the header took the whole card and left the files no room and
  // nothing to scroll (user report 2026-09-21).
  const scroller = byClass(commitRoot, 'commit-vbody')[0] as FakeElement;
  const fixedHead = byClass(commitRoot, 'commit-vhd')[0] as FakeElement;
  assert.equal(byClass(scroller, 'commit-vtext').length, 1, 'the body scrolls with the files');
  assert.equal(byClass(fixedHead, 'commit-vtext').length, 0, 'and is not in the fixed header');

  const sum = byClass(commitRoot, 'commit-vsum')[0] as FakeElement;
  assert.ok(sum.textContent.includes(`${C0.commit.files} files changed`));
  assert.ok(sum.textContent.includes(`+${C0.commit.add}`));
  assert.ok(sum.textContent.includes(`-${C0.commit.del}`));
  assert.equal(byClass(commitRoot, 'commit-bar-b').length, 5, 'the bar is always five blocks');

  // The avatar is decoration; the name beside it is the content.
  assert.equal((byClass(commitRoot, 'commit-avatar')[0] as FakeElement).getAttribute('aria-hidden'), 'true');
});

test('ONE request per commit, and the panel beside it adds none', async () => {
  await open(HEAD);
  assert.deepEqual(fx.commitCalls, [`${ROOT} ${HEAD}`], 'the root is the one the panel sends');
  view.render();
  view.render();
  await settle();
  assert.equal(fx.commitCalls.length, 1, 'a repaint is not a question');
});

test('a commit still loading says so and already has its way out', async () => {
  fx.hold();
  st.openCommitView(HEAD, AT);
  assert.deepEqual(textsOf(commitRoot, 'commit-missing'), ['Loading…']);
  assert.notEqual(byKey(commitRoot, 'commit:back'), null, 'the exit exists before the answer');
  assert.equal(byClass(commitRoot, 'diff-block').length, 0, 'nothing is invented meanwhile');
  fx.release();
  await settle();
  assert.equal(byClass(commitRoot, 'commit-missing').length, 0);
  assert.ok(byClass(commitRoot, 'diff-block').length > 0);
});

test('`Committed by` appears only when the committer is somebody else', async () => {
  await open(HEAD);
  assert.equal(C0.committer, null, 'non-vacuity: this one was committed by its author');
  assert.equal(byClass(commitRoot, 'commit-vby').length, 0);

  const other = detailOf(hashOf(1)) as NonNullable<ReturnType<typeof detailOf>>;
  assert.equal(other.committer, 'Fable', 'non-vacuity: this one was not');
  await open(hashOf(1));
  assert.deepEqual(textsOf(commitRoot, 'commit-vby'), ['Committed by Fable']);
});

test('no honesty line is left anywhere on this screen — the mock is gone', async () => {
  await open(HEAD);
  const src = readSource('web', 'src', 'ui', 'commit-view.ts');
  for (const dead of ['placeholderNote', 'Example commit', 'files-mock', 'syntheticDiff']) {
    assert.equal(src.includes(dead), false, `${dead} died with part B3`);
  }
  assert.equal(byClass(commitRoot, 'commit-note').length, 0);
});

// ---------------------------------------------------------------------------
// `Open on GitHub` (user decision D2)
// ---------------------------------------------------------------------------

test('`Open on GitHub` is a BUTTON, and only when the repository really has one', async () => {
  await open(HEAD);
  const gh = byKey(commitRoot, 'commit:gh') as FakeElement;
  assert.notEqual(gh, null, 'the fixture repository has an origin on github.com');
  assert.equal(gh.textContent, 'Open on GitHub');
  assert.equal(gh.tagName, 'BUTTON', 'the host drops a link navigation');
  assert.equal(gh.getAttribute('href'), null);
  assert.equal(gh.disabled, false);
  // No address, no host name, in the label or the tooltip (copy rule).
  for (const text of [gh.textContent, gh.title]) {
    assert.equal(/https?:\/\//.test(text), false, `an address in UI copy: ${text}`);
  }
  const src = readSource('web', 'src', 'ui', 'commit-view.ts');
  assert.equal(/el\('a'|setAttribute\('href'|\.href =/.test(src), false, 'not even a `#`');
});

test('a repository with no github origin gets NO button — absent, not disabled', async () => {
  assert.equal((detailOf(NO_GITHUB) as { github: unknown }).github, null, 'non-vacuity');
  await open(NO_GITHUB);
  assert.equal(byKey(commitRoot, 'commit:gh'), null);
  assert.equal(commitRoot.textContent.includes('Open on GitHub'), false);
  // And a commit that has NOT answered yet shows none either: a control that
  // is there but refuses is a promise the app has not checked.
  fx.hold();
  st.state.openCommit = null;
  view.render();
  st.openCommitView(HEAD, AT);
  assert.equal(byKey(commitRoot, 'commit:gh'), null, 'not while it is loading');
  fx.release();
  await settle();
  assert.notEqual(byKey(commitRoot, 'commit:gh'), null);
});

test('its click calls the ONE exit with the commit`s address, and logs no address', async () => {
  await open(HEAD);
  const opened: string[][] = [];
  const win = dom.win as unknown as { open?: (u: string, t: string, f: string) => void };
  win.open = (u, t, f) => {
    opened.push([u, t, f]);
  };
  (byKey(commitRoot, 'commit:gh') as FakeElement).click();
  assert.deepEqual(opened, [
    [`https://github.com/${GITHUB.owner}/${GITHUB.repo}/commit/${HEAD}`, '_blank', 'noopener,noreferrer'],
  ]);
  delete win.open;
  // The log line is the SHAPE of the act; the address is nobody's business.
  const src = readSource('web', 'src', 'ui', 'commit-view.ts');
  assert.match(src, /log\.debug\('open commit on github'\)/);
  assert.equal(src.includes('window.open('), false, 'it goes through the shared exit');
  assert.match(src, /import \{ openExternal \} from '\.\/open-external\.ts';/);
});

// ---------------------------------------------------------------------------
// The two openers
// ---------------------------------------------------------------------------

// The ORDER is open-then-close (one layout pass); this test states the END
// STATE both orders share, and the order itself is pinned by 'both openers
// open the pane BEFORE closing the view' below.
test('`Open file` opens the WORKING-TREE file, by the same ABSOLUTE path a panel row hands over', async () => {
  await open(HEAD);
  (byKey(commitRoot, `diffopen:${F1.path}`) as FakeElement).click();
  assert.equal(st.state.openCommit, null, 'the pane lives in the row the view was covering');
  const v = st.activeView() as View;
  assert.deepEqual(v.root, { kind: 'home' }, 'no session, no project: the file lands at Home');
  assert.equal(v.slots.length, 1, 'ONE editor pane (A10b: a file is a tab, not a pane)');
  // A commit names its files relative to the REPOSITORY; the tab carries the
  // absolute path, exactly like a `Changes` row (ui/files.ts).
  assert.deepEqual(
    tabsOf(v),
    [{ kind: 'file', path: `${REPO_ROOT}/${F1.path}` }],
    'joined onto the REPOSITORY, not onto the folder the request was made from',
  );
  assert.notEqual(REPO_ROOT, ROOT, 'non-vacuity: the two roots really differ');
  assert.equal(handBacks, 0, 'this is not the way BACK; it is the way into the file');
  assert.equal(paneHandovers, 1, 'and the keyboard goes with it');
});

test('`Changes` opens the read-only diff pane, carrying the root it is read from', async () => {
  await open(HEAD);
  (byKey(commitRoot, `diffchanges:${HEAD}:${F0.path}`) as FakeElement).click();
  assert.equal(st.state.openCommit, null);
  assert.deepEqual(
    tabsOf(st.activeView() as View),
    [{ kind: 'diff', hash: HEAD, path: F0.path, root: ROOT }],
    'the tab carries the REQUEST root — the repository root may sit outside every anchor',
  );
  assert.equal(paneHandovers, 1, 'a diff has no field to land in, so the pane takes the keyboard');
});

test('a full tab keeps the screen and says so, instead of closing for a pane it never opened', async () => {
  await open(HEAD);
  // A10b narrowed this state to ONE shape: four panes AND not one of them an
  // editor. With an editor pane anywhere in the tab the file is a TAB of it and
  // costs no pane, so four terminals is the only way a file still has nowhere
  // to go — and it is the state where the screen must stay up.
  st.state.views = [
    {
      id: 'home',
      root: { kind: 'home' },
      slots: ['one', 'two', 'three', 'four'].map((n) => ({ kind: 'session' as const, id: `s:${n}` })),
      focused: 0,
    },
  ];
  st.state.activeViewId = 'home';
  (byKey(commitRoot, `diffopen:${F1.path}`) as FakeElement).click();
  assert.equal(st.state.openCommit, HEAD, 'the screen is still up');
  assert.equal(paneHandovers, 0, 'and nothing took the keyboard away from it');
  assert.equal((st.activeView() as View).slots.length, 4, 'no fifth pane was opened');
});

test('both openers open the pane BEFORE closing the view — one layout pass, not two', () => {
  // The pane area is covered while the pane is added, so ui/panes.ts refuses
  // to build anything; closing the view then unhides the grid and the deferred
  // render draws the new layout ONCE. The other order builds the panes twice.
  const src = readSource('web', 'src', 'ui', 'commit-view.ts');
  for (const [key, opener, call] of [
    ['diffopen', 'openFile', 'openFileGuarded('],
    ['diffchanges', 'changes', 'openDiffGuarded('],
  ] as [string, string, string][]) {
    const from = src.indexOf(`const ${opener} = button(`);
    assert.notEqual(from, -1, `non-vacuity: the ${key} handler was found`);
    const body = src.slice(from, src.indexOf('});', from));
    // Both indexes must EXIST: `-1 < n` is true for any n, and that is exactly
    // how this pin went vacuous when the B4 guard renamed the opener.
    assert.notEqual(body.indexOf(call), -1, `${key}: the guarded opener is in the handler`);
    assert.notEqual(body.indexOf('st.closeCommitView()'), -1, `${key}: the close is in the handler`);
    assert.ok(
      body.indexOf(call) < body.indexOf('st.closeCommitView()'),
      `${key}: the pane is opened before the view closes`,
    );
    assert.ok(body.includes('onOpenPane()'), `${key}: and the keyboard follows it`);
  }
});

test('a file from a commit lands in the tab the view was standing over', async () => {
  // The root is the ACTIVE tab's own (the Files panel that opened this commit
  // was reading the same tab); a project tab keeps its files together.
  st.state.views = [
    { id: 'home', root: { kind: 'home' }, slots: [], focused: 0 },
    { id: 'proj', root: { kind: 'project', id: 'p1' }, slots: [], focused: 0 },
  ];
  st.state.activeViewId = 'proj';
  await open(HEAD);
  (byKey(commitRoot, `diffopen:${F1.path}`) as FakeElement).click();
  assert.equal(st.state.activeViewId, 'proj');
  assert.deepEqual(tabsOf(st.activeView() as View), [
    { kind: 'file', path: `${REPO_ROOT}/${F1.path}` },
  ]);
  assert.deepEqual(
    st.state.views.map((v) => v.slots.length),
    [0, 1],
    'and Home was left alone',
  );
});
