/**
 * The commit view's file blocks (Nocturne A6, LIVE since B3): one collapsible
 * block per file, a diff asked for once per block, the fold boundary of ten,
 * the capped / binary / refused states, stale and late answers dropped, a
 * throwing gateway, and the repository landing late. Split out of
 * `ui-a6-screens.test.ts`.
 *
 * Seam: the REAL `web/src/ui/commit-view.ts` on the shared DOM double, against
 * the REAL `web/src/state.ts`, `ui/util.ts`, `ui/icons.ts`,
 * `ui/commit-store.ts` and the A6 models — with the backend a plain fake
 * object (`tests/helpers/fs-fixture.ts`) over the fixture history
 * (`tests/helpers/commits-fixture.ts`), booted once per file by
 * `tests/helpers/ui-a6-screens-fixture.ts` and reset before every test.
 *
 * Why it matters: a file block whose fold state disagrees with the Files panel
 * row that folded it, a diff asked for twice per fold, or a stale answer
 * painting over the commit the user actually opened all keep the model tests
 * green.
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
import { FakeApiError, settle } from '../helpers/fs-fixture.ts';
import {
  BINARY_PATH,
  REPO_ROOT,
  GONE_PATH,
  GONE_TEXT,
  HEAD,
  TOO_LARGE_PATH,
  WIDE,
  detailOf,
  diffOf,
  hashOf,
} from '../helpers/commits-fixture.ts';
import { readSource } from '../helpers/helpers.ts';
import {
  AT,
  C0,
  CV,
  F0,
  ROOT,
  STORE,
  blockPaths,
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
// Blocks, folds and diffs
// ---------------------------------------------------------------------------

test('the two back controls carry a DRAWN chevron and plain words, never a glyph in the sentence', async () => {
  await open(HEAD);
  const back = byKey(commitRoot, 'commit:back') as FakeElement;
  assert.equal(back.tagName, 'BUTTON');
  assert.equal(back.textContent, 'Back to sessions', 'the label is words only');
  const svg = back.children[0] as FakeElement;
  assert.equal(svg.tagName, 'SVG');
  assert.equal(svg.getAttribute('aria-hidden'), 'true', 'the chevron is geometry');
});

test('Back to sessions closes the view and hands the keyboard back', async () => {
  await open(HEAD);
  (byKey(commitRoot, 'commit:back') as FakeElement).click();
  assert.equal(st.state.openCommit, null);
  assert.equal(handBacks, 1, 'without this the focus falls to <body>');
  assert.equal(byClass(commitRoot, 'commit-vmsg').length, 0, 'and the view is empty again');
});

test('one collapsible block per file: path, numbers, caret, and the diff itself', async () => {
  await open(HEAD);
  const blocks = byClass(commitRoot, 'diff-block');
  assert.equal(blocks.length, C0.files.length);
  assert.deepEqual(blockPaths(), C0.files.map((f) => f.path));

  const first = blocks[0] as FakeElement;
  assert.ok(first.textContent.includes(`+${F0.add}`));
  assert.ok(first.textContent.includes(`-${F0.del}`));
  const toggle = byKey(commitRoot, `diff:${HEAD}:${F0.path}`) as FakeElement;
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'the first ten are open');
  assert.equal((toggle.children[0] as FakeElement).textContent, '▾');
  assert.equal((toggle.children[0] as FakeElement).getAttribute('aria-hidden'), 'true');

  // The diff rows: TWO numbers, a sign and the text, with the kind on the row.
  const rows = byClass(first, 'diff-line');
  const lines = diffOf(HEAD, F0.path).lines;
  assert.equal(rows.length, lines.length, 'a block draws exactly the lines it was given');
  const kinds = rows.map((r) => r.dataset.kind);
  assert.deepEqual(kinds, lines.map((l) => l.kind), 'the ground of a row is its meaning');
  const gutters = byClass(rows[1] as FakeElement, 'diff-n');
  assert.equal(gutters.length, 2, 'the OLD file and the NEW one are numbered side by side');
  assert.deepEqual(
    gutters.map((g) => g.textContent),
    ['1', '1'],
  );
  // A row that exists on one side only leaves the other gutter blank, and a
  // hunk header has no number at all.
  const del = rows.find((r) => r.dataset.kind === 'del') as FakeElement;
  assert.deepEqual(byClass(del, 'diff-n').map((g) => g.textContent), ['2', '']);
  const hunk = rows.find((r) => r.dataset.kind === 'hunk') as FakeElement;
  assert.deepEqual(byClass(hunk, 'diff-n').map((g) => g.textContent), ['', '']);
  assert.equal(textsOf(hunk, 'diff-t')[0], lines[0]?.text);
  // Every number is decoration beside a row that already says what it is.
  for (const g of byClass(first, 'diff-n')) assert.equal(g.getAttribute('aria-hidden'), 'true');
});

test('a block asks for its diff ONCE, whatever the screen does afterwards', async () => {
  await open(HEAD);
  assert.deepEqual(fx.diffCalls, C0.files.map((f) => `${HEAD} ${f.path}`), 'one per open block');
  const toggle = byKey(commitRoot, `diff:${HEAD}:${F0.path}`) as FakeElement;
  toggle.click();
  await settle();
  (byKey(commitRoot, `diff:${HEAD}:${F0.path}`) as FakeElement).click();
  await settle();
  view.render();
  await settle();
  assert.equal(
    fx.diffCalls.filter((c) => c === `${HEAD} ${F0.path}`).length,
    1,
    'folding and unfolding is not a second request',
  );
});

test('a file block folds and unfolds, and only its own diff goes with it', async () => {
  await open(HEAD);
  const before = byClass(commitRoot, 'diff-line').length;
  const inFirst = byClass(byClass(commitRoot, 'diff-block')[0] as FakeElement, 'diff-line').length;
  assert.ok(inFirst > 0 && before > inFirst, 'non-vacuity: two blocks with diffs');

  (byKey(commitRoot, `diff:${HEAD}:${F0.path}`) as FakeElement).click();
  assert.equal(st.commitFileCollapsed(HEAD, F0.path), true);
  assert.equal(byClass(commitRoot, 'diff-line').length, before - inFirst);
  const toggle = byKey(commitRoot, `diff:${HEAD}:${F0.path}`) as FakeElement;
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal((toggle.children[0] as FakeElement).textContent, '▸');
  assert.equal(byClass(commitRoot, 'diff-block').length, C0.files.length, 'the block itself stays');

  toggle.click();
  assert.equal(byClass(commitRoot, 'diff-line').length, before, 'and the diff comes back');
});

test('the first ten blocks are open, the rest are folded and cost no request', async () => {
  await open(WIDE);
  const wide = detailOf(WIDE) as NonNullable<ReturnType<typeof detailOf>>;
  assert.ok(wide.files.length > CV.OPEN_BLOCKS, `non-vacuity: ${wide.files.length} files`);
  assert.equal(byClass(commitRoot, 'diff-block').length, wide.files.length, 'every file has a block');
  const open10 = wide.files.slice(0, CV.OPEN_BLOCKS).map((f) => f.path);
  const folded = wide.files.slice(CV.OPEN_BLOCKS).map((f) => f.path);
  for (const path of open10) {
    const t = byKey(commitRoot, `diff:${WIDE}:${path}`) as FakeElement;
    assert.equal(t.getAttribute('aria-expanded'), 'true', path);
  }
  for (const path of folded) {
    const t = byKey(commitRoot, `diff:${WIDE}:${path}`) as FakeElement;
    assert.equal(t.getAttribute('aria-expanded'), 'false', path);
  }
  assert.deepEqual(fx.diffCalls, open10.map((p) => `${WIDE} ${p}`), 'ten requests, not twelve');

  // Unfolding one asks for exactly that file, and nothing else.
  const last = folded[folded.length - 1] as string;
  (byKey(commitRoot, `diff:${WIDE}:${last}`) as FakeElement).click();
  await settle();
  assert.equal(fx.diffCalls[fx.diffCalls.length - 1], `${WIDE} ${last}`);
  assert.equal(fx.diffCalls.length, CV.OPEN_BLOCKS + 1);
});

test('the fold boundary is TEN — the number, not whatever the constant says', async () => {
  // The test above reads `CV.OPEN_BLOCKS` for both halves of its split, so it
  // stays green when the boundary moves (10 -> 11 survived the part-B3
  // mutation gate). Ten is a DECISION — `.claude/plans/nocturne/PLAN-B3.md`
  // D1 and §"the FIRST 10 file blocks unfolded", which is also the request
  // budget the plan costs out (ten diffs, at most forty git spawns) — so the
  // literal belongs in an assertion.
  assert.equal(CV.OPEN_BLOCKS, 10, 'the exported constant itself');
  await open(WIDE);
  const wide = detailOf(WIDE) as NonNullable<ReturnType<typeof detailOf>>;
  assert.equal(wide.files.length, 12, 'non-vacuity: the fixture commit really changes twelve files');
  const expanded = byClass(commitRoot, 'diff-toggle').filter(
    (t) => t.getAttribute('aria-expanded') === 'true',
  );
  assert.equal(expanded.length, 10, 'ten blocks open on arrival, twelve drawn');
  assert.equal(fx.diffCalls.length, 10, 'and exactly ten diffs asked for');
});

test('a capped file list says how many are missing, in the body', async () => {
  await open(WIDE);
  const wide = detailOf(WIDE) as { truncated: number };
  assert.equal(wide.truncated, 3, 'non-vacuity: the fixture really was capped');
  assert.deepEqual(textsOf(commitRoot, 'commit-more'), ['3 more files are not shown.']);
});

test('a binary file, a capped diff and a refused one each say WHICH nothing it is', async () => {
  await open(hashOf(2));
  const notes = textsOf(commitRoot, 'diff-note');
  assert.ok(notes.includes('Binary file.') === false, 'this commit holds no binary file');
  assert.ok(notes.includes("This file's changes are too large to show."), notes.join(' | '));
  // The server's own sentence, verbatim, in the block it belongs to.
  const gone = byClass(commitRoot, 'diff-block').find(
    (b) => textsOf(b, 'diff-path')[0] === GONE_PATH,
  ) as FakeElement;
  assert.deepEqual(textsOf(gone, 'diff-note'), [GONE_TEXT]);
  assert.equal((byClass(gone, 'diff-note')[0] as FakeElement).classList.contains('is-bad'), true);
  assert.equal(byClass(gone, 'diff-line').length, 0, 'a sentence is never a numbered row');

  // And the binary one, in the commit that holds it: no numbers on its header
  // either, because there are no lines to count.
  await open(hashOf(1));
  const bin = byClass(commitRoot, 'diff-block').find(
    (b) => textsOf(b, 'diff-path')[0] === BINARY_PATH,
  ) as FakeElement;
  assert.deepEqual(textsOf(bin, 'diff-note'), ['Binary file.']);
  assert.equal(byClass(bin, 'files-num').length, 0, '+0 -0 would claim it changed nothing');
});

test('a capped diff draws the sentence and not one row', async () => {
  await open(hashOf(2));
  const big = byClass(commitRoot, 'diff-block').find(
    (b) => textsOf(b, 'diff-path')[0] === TOO_LARGE_PATH,
  ) as FakeElement;
  assert.deepEqual(textsOf(big, 'diff-note'), ["This file's changes are too large to show."]);
  assert.equal(byClass(big, 'diff-line').length, 0);
});

test('a commit that answers 404 shows the server`s sentence AND keeps the way out', async () => {
  // The pane grid is hidden on `openCommit !== null`, so an unresolvable hash
  // (a rewritten history, a pruned commit) must never leave an empty middle
  // row with no control in it.
  await open('f'.repeat(40));
  assert.equal(byClass(commitRoot, 'commit-vmsg').length, 0, 'nothing is invented');
  assert.deepEqual(textsOf(commitRoot, 'commit-missing'), [GONE_TEXT]);
  assert.equal((byClass(commitRoot, 'commit-missing')[0] as FakeElement).classList.contains('is-bad'), true);
  const back = byKey(commitRoot, 'commit:back') as FakeElement;
  assert.notEqual(back, null, 'the exit is the point of this state');
  assert.equal(dom.doc.activeElement, back, 'and it holds the keyboard');
  back.click();
  assert.equal(st.state.openCommit, null);
  assert.equal(handBacks, 1);
  assert.equal(byClass(commitRoot, 'commit-missing').length, 0, 'and the screen is empty again');
});

test('a backend that never answers gets the app`s own sentence, not a code', async () => {
  fx.commitFails = new FakeApiError(500, 'GIT_READ_FAILED');
  await open(HEAD);
  assert.deepEqual(textsOf(commitRoot, 'commit-missing'), ['The app could not reach the service.']);
  assert.notEqual(byKey(commitRoot, 'commit:back'), null);
});

test('a STALE answer is dropped: the commit the user opened last is the one drawn', async () => {
  // Two opens, the first one still in flight. Without the generation guard the
  // slow answer repaints the screen over the commit that is actually open.
  fx.holdIf((c) => c.kind === 'commit');
  st.openCommitView(HEAD, AT);
  await settle();
  st.state.openCommit = null;
  view.render();
  st.openCommitView(hashOf(1), AT);
  fx.release();
  await settle();
  const second = detailOf(hashOf(1)) as NonNullable<ReturnType<typeof detailOf>>;
  assert.equal(textsOf(commitRoot, 'commit-vmsg')[0], second.commit.subject, 'the LAST one opened');
  assert.deepEqual(blockPaths(), second.files.map((f) => f.path));
});

test('an answer that lands after the view CLOSED paints nothing at all', async () => {
  fx.holdIf((c) => c.kind === 'commit');
  st.openCommitView(HEAD, AT);
  await settle();
  st.closeCommitView();
  fx.release();
  await settle();
  assert.equal(byClass(commitRoot, 'commit-vmsg').length, 0, 'a closed screen stays closed');
  assert.equal(byClass(commitRoot, 'diff-block').length, 0);
});

test('a DIFF that lands after the view closed is DROPPED in the store, not delivered', async () => {
  // The generation check on the diff answer (`ui/commit-store.ts`, `askDiff`)
  // had no test: deleting it kept every screen assertion green, because the
  // stale answer writes into an entry nobody reads any more. What it DOES
  // reach is the store's version and the painter the view registered — a
  // repaint (and, with no painter, a `'screen'` notification) for a commit
  // that is not on screen. The contract is the module's own header: "the
  // answer for a commit nobody is looking at any more can never paint over
  // the one that is".
  fx.holdIf((c) => c.kind === 'commit-diff');
  st.openCommitView(HEAD, AT);
  await settle();
  assert.ok(fx.diffCalls.length > 0, 'non-vacuity: diffs really were in flight');
  st.closeCommitView();
  await settle();
  const closed = STORE.commitVersion();
  fx.release();
  await settle();
  assert.equal(STORE.commitVersion(), closed, 'the late answer moved nothing in the store');
  assert.equal(byClass(commitRoot, 'diff-block').length, 0, 'and the screen stayed closed');
});

test('closing and opening the SAME commit asks again — the cache dies with the screen', async () => {
  await open(HEAD);
  st.closeCommitView();
  await open(HEAD);
  assert.equal(fx.commitCalls.length, 2, 'a new visit is a new question');
});

test('a gateway that throws SYNCHRONOUSLY leaves the screen whole and says so', async () => {
  // `encodeURIComponent` throws a URIError on a lone surrogate, and a path is
  // git's verbatim bytes — so the injected client function really can throw
  // where a promise was expected. It must become the block's own sentence, not
  // a render that dies with the header replaced and the body not.
  const boom = {
    commit: () => Promise.resolve(detailOf(HEAD) as NonNullable<ReturnType<typeof detailOf>>),
    commitDiff: () => {
      throw new URIError('URI malformed');
    },
  };
  STORE.setCommitGateway(boom);
  try {
    await open(HEAD);
    assert.equal(byClass(commitRoot, 'diff-block').length, C0.files.length, 'the body is whole');
    assert.ok(byClass(commitRoot, 'commit-vmsg').length === 1, 'and so is the header');
    const notes = textsOf(commitRoot, 'diff-note');
    assert.deepEqual(notes, C0.files.map(() => 'The app could not reach the service.'));
    assert.notEqual(byKey(commitRoot, 'commit:back'), null, 'the way out is still there');
  } finally {
    st.closeCommitView();
    STORE.setCommitGateway(fx.gateway);
  }
});

test('a commit whose OWN call throws synchronously keeps the exit too', async () => {
  const boom = {
    commit: () => {
      throw new URIError('URI malformed');
    },
    commitDiff: () => Promise.resolve(diffOf(HEAD, F0.path)),
  };
  STORE.setCommitGateway(boom);
  try {
    await open(HEAD);
    assert.deepEqual(textsOf(commitRoot, 'commit-missing'), ['The app could not reach the service.']);
    assert.notEqual(byKey(commitRoot, 'commit:back'), null);
  } finally {
    st.closeCommitView();
    STORE.setCommitGateway(fx.gateway);
  }
});

test('a lone surrogate in a path is a REJECTION from the real client, never a throw', async () => {
  // The real `web/src/api.ts` function, called the way the store calls it.
  const api = (await import(new URL('../../web/src/api.ts', import.meta.url).href)) as {
    gitCommitDiff(root: string, hash: string, path: string): Promise<unknown>;
    gitCommit(root: string, hash: string): Promise<unknown>;
    gitCommits(root: string, limit: number, skip: number, from?: string): Promise<unknown>;
  };
  const lone = 'a\ud800b';
  await assert.rejects(() => api.gitCommitDiff(ROOT, HEAD, lone), { name: 'URIError' });
  await assert.rejects(() => api.gitCommit(lone, HEAD), { name: 'URIError' });
  await assert.rejects(() => api.gitCommits(lone, 10, 0), { name: 'URIError' });
  // Non-vacuity: the same call with a sane path gets past the encoding and
  // fails on the FETCH instead (there is no server in this runner).
  await assert.rejects(() => api.gitCommitDiff(ROOT, HEAD, 'a/b.ts'), (err: Error) => err.name !== 'URIError');
});

test('`Open file` WAITS for the repository instead of being a dead click', async () => {
  // The history and the Changes answer are two requests and the history can
  // win: the commit opens, and the one control that needs the repository says
  // it is not ready — with a reason a reader can reach, and a statusline line
  // for a pointer.
  st.openCommitView(HEAD, { root: ROOT, repoRoot: null });
  await settle();
  const btn = byKey(commitRoot, `diffopen:${F0.path}`) as FakeElement;
  assert.equal(btn.getAttribute('aria-disabled'), 'true');
  assert.equal(btn.disabled, false, 'it stays reachable by the keyboard');
  assert.equal(btn.title, 'The app is still reading this repository.');
  btn.click();
  assert.equal(st.state.openCommit, HEAD, 'the screen stays');
  assert.equal(paneHandovers, 0, 'and nothing was opened');
  assert.equal((st.activeView() as View | null)?.slots.length ?? 0, 0, 'no pane at all');

  // `Changes` needs only the REQUEST root, so it works right away.
  (byKey(commitRoot, `diffchanges:${HEAD}:${F0.path}`) as FakeElement).click();
  assert.deepEqual(tabsOf(st.activeView() as View), [
    { kind: 'diff', hash: HEAD, path: F0.path, root: ROOT },
  ]);
});

test('the repository landing LATE turns `Open file` into a control, with no reopen', async () => {
  st.openCommitView(HEAD, { root: ROOT, repoRoot: null });
  await settle();
  assert.equal(
    (byKey(commitRoot, `diffopen:${F0.path}`) as FakeElement).getAttribute('aria-disabled'),
    'true',
  );
  // This is what the Files panel calls when its Changes answer for that same
  // root lands.
  st.noteCommitRepoRoot(ROOT, REPO_ROOT);
  await settle();
  const btn = byKey(commitRoot, `diffopen:${F0.path}`) as FakeElement;
  assert.equal(btn.getAttribute('aria-disabled'), null, 'the reason is gone with the state');
  btn.click();
  assert.deepEqual(tabsOf(st.activeView() as View), [
    { kind: 'file', path: `${REPO_ROOT}/${F0.path}` },
  ]);
  // Opening the file closed the view, and the screen forgot where it read.
  assert.equal(st.state.openCommitAt, null);
});

test('a diff landing repaints ONE block, not the whole body', async () => {
  // Ten parallel answers used to mean ten teardowns of up to ten times two
  // thousand rows. The block nodes of the files that did NOT answer must
  // survive, and so must the header row of the one that did (the keyboard
  // lives on its buttons).
  fx.holdIf((c) => c.kind === 'commit-diff');
  await open(HEAD);
  const before = byClass(commitRoot, 'diff-block');
  const rowBefore = byKey(commitRoot, `diff:${HEAD}:${F0.path}`) as FakeElement;
  assert.equal(before.length, C0.files.length, 'non-vacuity: the blocks are drawn');
  fx.release();
  await settle();
  const after = byClass(commitRoot, 'diff-block');
  assert.equal(after.length, before.length);
  for (const [i, block] of after.entries()) {
    assert.equal(block, before[i], `block ${i} is the SAME node, not a rebuild`);
  }
  assert.equal(
    byKey(commitRoot, `diff:${HEAD}:${F0.path}`),
    rowBefore,
    'the header row survived, so the keyboard never moved',
  );
  assert.equal(
    byClass(after[0] as FakeElement, 'diff-line').length,
    diffOf(HEAD, F0.path).lines.length,
    'and the rows really did arrive',
  );
});

test('a diff answering while its block is FOLDED does not unfold it', async () => {
  fx.holdIf((c) => c.kind === 'commit-diff');
  await open(HEAD);
  st.toggleCommitFile(HEAD, F0.path);
  assert.equal(st.commitFileCollapsed(HEAD, F0.path), true);
  fx.release();
  await settle();
  const block = byClass(commitRoot, 'diff-block')[0] as FakeElement;
  assert.equal(byClass(block, 'diff-line').length, 0, 'a fold is the user`s, not the answer`s');
  assert.equal(
    (byKey(commitRoot, `diff:${HEAD}:${F0.path}`) as FakeElement).getAttribute('aria-expanded'),
    'false',
  );
});

test('a repository path is drawn in the order it is STORED (bidi spoof)', () => {
  // `src/x<RLO>txt.sj` draws as `src/js.txt` unless the surface pins the
  // order. Every place a repo path (or a file name out of one) is drawn
  // carries the rule.
  const css = readSource('web', 'src', 'styles', 'app.css');
  for (const sel of ['.diff-path', '.commit-fpath-t', '.pane-tab-pick']) {
    const at = css.indexOf(`${sel} {`);
    assert.notEqual(at, -1, `${sel} has a rule`);
    const rule = css.slice(at, css.indexOf('}', at));
    assert.match(rule, /unicode-bidi: isolate-override;/, `${sel} pins the order`);
    assert.match(rule, /direction: ltr;/, `${sel} draws left to right`);
  }
  // The panel row keeps its front-truncation: the BOX stays right-to-left and
  // the text inside it is the part that is pinned.
  const box = css.slice(css.indexOf('.commit-fpath {'), css.indexOf('}', css.indexOf('.commit-fpath {')));
  assert.match(box, /direction: rtl;/, 'the front-truncation trick survived');
});
