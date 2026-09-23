/**
 * `web/src/ui/files.ts` — the Commits tab while a commit is open (Nocturne
 * A6): the tab as the commit view's selected state, the view closing with the
 * session or an orphaned panel, file rows that fold blocks in the view and
 * name them, All commits handing the keyboard back, and a rebuild keeping the
 * keyboard where it was. Split out of `ui-files-panel.test.ts`.
 *
 * Seam: the REAL `web/src/ui/files.ts` on the shared DOM double, against the
 * REAL `web/src/state.ts`, `ui/util.ts`, `ui/icons.ts`, `ui/files-model.ts`,
 * `ui/fs-model.ts`, `ui/commit-model.ts` and `ui/commit-store.ts`, with the
 * backend a fake `FsGateway` (`tests/helpers/fs-fixture.ts` over
 * `tests/helpers/commits-fixture.ts`) — no HTTP, no module stubbing, no clock.
 * Booted once per file by `tests/helpers/ui-files-panel-fixture.ts` and reset
 * before every test (`resetPanel`).
 *
 * Why it matters: a commit view that outlives the folder it came from shows
 * a commit of a repository the user is no longer in.
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
  descendants,
  textsOf,
  type FakeElement,
} from '../helpers/fake-dom.ts';
import {
  FakeApiError,
  PROJ,
  settle,
} from '../helpers/fs-fixture.ts';
import {
  EMPTY_PAGE,
  HEAD,
  SUMMARIES,
  detailOf,
  pageOf,
} from '../helpers/commits-fixture.ts';
import { readSource } from '../helpers/helpers.ts';
import {
  dirRow,
  dom,
  fx,
  handBacks,
  liveSession,
  MODEL,
  panel,
  resetPanel,
  root,
  st,
  viewRender,
} from '../helpers/ui-files-panel-fixture.ts';

beforeEach(resetPanel);

// ---------------------------------------------------------------------------
// The Commits tab while a commit is open (Nocturne A6)
// ---------------------------------------------------------------------------

/** Open the Commits tab, let it load, then open the commit at `i`. */
async function openCommit(i = 0): Promise<(typeof SUMMARIES)[number]> {
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  const c = SUMMARIES[i] as (typeof SUMMARIES)[number];
  (byKey(root, `commit:${c.hash}`) as FakeElement).click();
  // The commit VIEW is what fetches; main.ts renders it before this panel.
  viewRender();
  await settle();
  panel.render();
  return c;
}

test('clicking a commit opens the commit view, and the tab becomes its selected state', async () => {
  await liveSession();
  const first = await openCommit();
  const detail = detailOf(first.hash) as NonNullable<ReturnType<typeof detailOf>>;
  assert.equal(st.state.openCommit, first.hash, 'the panel opens the view, it does not draw it');
  // It carries WHERE it was read from: the root the Changes tab sends, and the
  // repository its file paths are relative to.
  assert.deepEqual(st.state.openCommitAt, { root: PROJ, repoRoot: PROJ });

  // The selected state: a back control, the message, the meta line, and one
  // row per file — the commit list itself is gone.
  const sel = byClass(root, 'files-selhd')[0] as FakeElement;
  assert.equal(sel.hidden, false);
  assert.equal(textsOf(root, 'files-selmsg')[0], first.subject);
  assert.equal(textsOf(root, 'commit-hash')[0], first.shortHash);
  assert.ok(sel.textContent.includes(first.author) && sel.textContent.includes('3 hours ago'));
  assert.equal(byClass(root, 'commit-row').length, 0, 'the list gave way to the one commit');
  // The SERVER's own count (a capped commit draws fewer rows than it changed),
  // and the same number the commit view states.
  assert.equal(textsOf(root, 'files-branch')[0], `${detail.commit.files} files changed`);
  assert.deepEqual(textsOf(root, 'commit-fpath'), detail.files.map((f) => f.path));
  const nums = byClass(root, 'commit-file')[0] as FakeElement;
  assert.ok(nums.textContent.includes(`+${(detail.files[0] as { add: number }).add}`));
  // ONE request for that commit, made by the view — the panel adds none.
  assert.deepEqual(fx.commitCalls, [`${PROJ} ${first.hash}`]);
});

test('ending the session closes ITS commit view — a commit never outlives the folder it came from', async () => {
  // User report 2026-09-21: the session was ended with the commit view up and
  // the view stayed, showing a repository nothing on screen stood for.
  await liveSession();
  const first = await openCommit();
  assert.equal(st.state.openCommit, first.hash, 'non-vacuity: the view is up');
  // Same root, another render: the view stays (a poll tick or an info frame
  // must never close it).
  panel.render();
  await settle();
  assert.equal(st.state.openCommit, first.hash, 'a render about the SAME folder closes nothing');
  // The session goes: the panel's subject is no longer that project.
  st.setSessions([]);
  panel.render();
  await settle();
  assert.equal(st.state.openCommit, null, 'the view went with the session');
  assert.equal(st.state.openCommitAt, null);
});

test('a HIDDEN panel closes an orphaned commit view too', async () => {
  await liveSession();
  const first = await openCommit();
  assert.equal(st.state.openCommit, first.hash);
  st.toggleLeftPanel('files');
  panel.render();
  await settle();
  assert.equal(st.state.openCommit, first.hash, 'hiding the panel alone closes nothing');
  st.setSessions([]);
  panel.render();
  await settle();
  assert.equal(st.state.openCommit, null);
  st.toggleLeftPanel('files');
});

test('the selected state says Loading, then the SERVER`s sentence if it cannot be read', async () => {
  await liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  fx.hold();
  (byKey(root, `commit:${HEAD}`) as FakeElement).click();
  viewRender();
  panel.render();
  assert.deepEqual(textsOf(root, 'files-row'), ['Loading…']);
  assert.notEqual(byKey(root, 'commit:all'), null, 'the way back is there before the answer');
  fx.release();
  await settle();
  assert.ok(byClass(root, 'commit-file').length > 0);

  st.closeCommitView();
  viewRender();
  fx.commitFails = new FakeApiError(404, 'This commit is no longer there.');
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  (byKey(root, `commit:${HEAD}`) as FakeElement).click();
  viewRender();
  await settle();
  panel.render();
  const row = byClass(root, 'files-row')[0] as FakeElement;
  assert.equal(row.textContent, 'This commit is no longer there.');
  assert.equal(row.classList.contains('is-err'), true);
});

test('a binary file states no numbers, and a capped file list says how many are missing', async () => {
  await liveSession();
  // The commit with the binary file, and the one whose file list was capped.
  const binary = await openCommit(1);
  const detail = detailOf(binary.hash) as NonNullable<ReturnType<typeof detailOf>>;
  const bin = detail.files.find((f) => f.add === null) as { path: string };
  const row = byKey(root, `cfile:${bin.path}`) as FakeElement;
  assert.equal(byClass(row, 'files-num').length, 0, '+0 -0 would claim it changed nothing');
  st.closeCommitView();
  viewRender();

  const wide = await openCommit(3);
  const w = detailOf(wide.hash) as { truncated: number };
  assert.equal(w.truncated, 3, 'non-vacuity');
  const states = textsOf(root, 'files-row');
  assert.ok(states.includes('3 more files are not shown.'), states.join(' | '));
});

test('a file row in the selected state folds that file in the view, and says which state it is in', async () => {
  await liveSession();
  const first = await openCommit();
  const detail = detailOf(first.hash) as NonNullable<ReturnType<typeof detailOf>>;
  const path = (detail.files[0] as { path: string }).path;

  const row = byKey(root, `cfile:${path}`) as FakeElement;
  assert.equal(row.tagName, 'BUTTON');
  assert.equal(row.getAttribute('aria-expanded'), 'true', 'the first ten open');
  row.click();
  assert.equal(st.commitFileCollapsed(first.hash, path), true, 'the SAME key the view folds by');
  const after = byKey(root, `cfile:${path}`) as FakeElement;
  assert.equal(after.getAttribute('aria-expanded'), 'false');
  assert.equal(after.classList.contains('is-collapsed'), true, 'a folded file recedes');

  // The other file is untouched.
  const other = (detail.files[1] as { path: string }).path;
  assert.equal(st.commitFileCollapsed(first.hash, other), false);
});

test('a file row NAMES the block it expands — the block lives in another region', async () => {
  // `aria-expanded` with nothing to point at leaves a reader with "expanded
  // what?": the block is in the commit VIEW, not in this panel.
  await liveSession();
  const first = await openCommit();
  const detail = detailOf(first.hash) as NonNullable<ReturnType<typeof detailOf>>;
  assert.ok(detail.files.length > 1, 'non-vacuity: more than one row');
  for (const f of detail.files) {
    const row = byKey(root, `cfile:${f.path}`) as FakeElement;
    assert.equal(
      row.getAttribute('aria-controls'),
      MODEL.blockDomId(first.hash, f.path),
      `${f.path}: the id the view gives that block`,
    );
  }
});

test('All commits closes the whole view and hands the keyboard back', async () => {
  await liveSession();
  await openCommit();

  const back = byKey(root, 'commit:all') as FakeElement;
  assert.equal(back.textContent, 'All commits', 'words only — the chevron is a drawn mark beside them');
  back.click();
  viewRender();
  panel.render();
  assert.equal(st.state.openCommit, null, 'one commit is open or none is');
  assert.equal(handBacks, 1);
  assert.equal((byClass(root, 'files-selhd')[0] as FakeElement).hidden, true);
  assert.equal(byClass(root, 'commit-row').length, 10, 'the list is back, page one');
});

test('switching to the Files tab while a commit is open keeps the VIEW open', async () => {
  await liveSession();
  const first = await openCommit();

  (byKey(root, 'ftab:files') as FakeElement).click();
  assert.equal(st.state.openCommit, first.hash, 'only the PANEL is gated on the tab, never the view');
  assert.equal((byClass(root, 'files-selhd')[0] as FakeElement).hidden, true);
  assert.ok(byClass(root, 'files-row').length > 0, 'the tree is what the Files tab shows');

  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  assert.equal((byClass(root, 'files-selhd')[0] as FakeElement).hidden, false, 'and back again');
  st.closeCommitView();
  viewRender();
  (byKey(root, 'ftab:files') as FakeElement).click();
});

test('a timestamp the server could not read costs the row its third line, not a NaN', async () => {
  // `authoredAt` arrives EMPTY when git's own date failed the server's strict
  // ISO check. An empty date line, an `Invalid Date` or a NaN would each be a
  // claim; two lines are the truth.
  fx.setCommits((_root, limit, skip) => {
    const page = pageOf(limit, skip);
    return { ...page, commits: page.commits.map((c) => ({ ...c, authoredAt: '' })) };
  });
  await liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  const row = byClass(root, 'commit-row')[0] as FakeElement;
  assert.equal(byClass(row, 'commit-when').length, 0, 'no line at all, rather than an empty one');
  assert.equal(/NaN|Invalid/.test(row.textContent), false, row.textContent);
  assert.ok(row.textContent.includes((SUMMARIES[0] as { author: string }).author), 'the rest stands');
});

test('a long abbreviation (core.abbrev) never widens the panel — the row clips, the numbers stay', async () => {
  // git abbreviates to whatever the repository says, 1..40 characters. The row
  // may not be sized for seven: the hash keeps its own width and elides, the
  // author gives up space first, and the numbers are always drawn.
  fx.setCommits((_root, limit, skip) => {
    const page = pageOf(limit, skip);
    return { ...page, commits: page.commits.map((c) => ({ ...c, shortHash: c.hash })) };
  });
  await liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  const row = byClass(root, 'commit-row')[0] as FakeElement;
  assert.equal(textsOf(row, 'commit-hash')[0], (SUMMARIES[0] as { hash: string }).hash);
  assert.equal(byClass(row, 'files-num').length, 2, 'both numbers are still drawn');
  const app = readSource('web', 'src', 'styles', 'app.css');
  const rule = app.slice(app.indexOf('.commit-hash {'), app.indexOf('}', app.indexOf('.commit-hash {')));
  assert.match(rule, /max-width:/, 'the chip has a ceiling');
  assert.match(rule, /text-overflow: ellipsis;/, 'and a cut hash SHOWS that it is cut');
  const rowRule = app.slice(app.indexOf('.commit-row {'), app.indexOf('}', app.indexOf('.commit-row {')));
  assert.match(rowRule, /overflow: hidden;/, 'nothing in a row may widen the panel');
});

test('every class the Commits tab renders has a rule in app.css (a typo is an invisible row)', async () => {
  const seen = new Set<string>();
  const collect = (): void => {
    for (const n of [root, ...descendants(root)]) {
      for (const c of n.className.split(/\s+/)) if (c !== '') seen.add(c);
    }
  };
  await liveSession();
  (byKey(root, 'ftab:commits') as FakeElement).click();
  await settle();
  collect(); // the list, with its `Show more` row
  (byKey(root, 'commit:more') as FakeElement).click();
  await settle();
  collect();
  await openCommit(3); // the selected state, with a capped file list
  collect();
  st.closeCommitView();
  viewRender();
  panel.render();
  fx.setCommits(() => EMPTY_PAGE);
  st.state.leftPanel = null;
  panel.render();
  st.state.leftPanel = 'files';
  panel.render();
  await settle();
  collect(); // an empty repository

  assert.ok(seen.size > 10, `non-vacuity: ${seen.size} classes were collected`);
  const css = readSource('web', 'src', 'styles', 'app.css');
  const missing = [...seen].filter((c) => !css.includes(`.${c}`)).sort();
  assert.deepEqual(missing, [], `classes with no rule in app.css: ${missing.join(', ')}`);
});

test('a rebuild keeps the keyboard where it was (folder rows are re-created wholesale)', async () => {
  await liveSession();
  const server = dirRow('server');
  server.focus();
  server.click();
  const after = dirRow('server');
  assert.notEqual(after, server, 'non-vacuity: the row really was rebuilt');
  assert.equal(dom.doc.activeElement, after, 'focus follows the same control, not the panel edge');
});
