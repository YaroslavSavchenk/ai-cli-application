/**
 * The state contract behind the commit view (gate additions, test-engineer A6;
 * re-pointed by A10 and B3): which change notifies `screen` or `ui`, what a
 * re-open keeps, whose unsaved text a close drops, where the keyboard lands,
 * that every commit the list can open really draws, and that the screen's
 * classes all have a rule in app.css. Split out of `ui-a6-screens.test.ts`.
 *
 * Seam: the REAL `web/src/ui/commit-view.ts` on the shared DOM double, against
 * the REAL `web/src/state.ts`, `ui/util.ts`, `ui/icons.ts`,
 * `ui/commit-store.ts` and the A6 models — with the backend a plain fake
 * object (`tests/helpers/fs-fixture.ts`) over the fixture history
 * (`tests/helpers/commits-fixture.ts`), booted once per file by
 * `tests/helpers/ui-a6-screens-fixture.ts` and reset before every test.
 *
 * Why it matters: a notify kind that grows a pane behind the view, or a close
 * that drops another file's unsaved text, looks fine until the user returns.
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
  descendants,
  textsOf,
  type FakeElement,
} from '../helpers/fake-dom.ts';
import { settle } from '../helpers/fs-fixture.ts';
import {
  GONE_PATH,
  HEAD,
  SUMMARIES,
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
  F1,
  MODEL,
  ROOT,
  blockPaths,
  commitRoot,
  dom,
  fx,
  open,
  resetScreen,
  st,
  tabsOf,
  view,
  type View,
} from '../helpers/ui-a6-screens-fixture.ts';

beforeEach(resetScreen);

// ---------------------------------------------------------------------------
// Gate additions (test-engineer, A6; re-pointed by A10 and B3): the state
// contract behind this screen — which change notifies, what a re-open keeps,
// and whose unsaved text a close drops.
// ---------------------------------------------------------------------------

/** Everything `notify()` emitted since `kinds.length = 0`. */
const kinds: string[] = [];
st.subscribe((k) => {
  kinds.push(k);
});

test('the commit view notifies `screen`, a pane notifies `ui`, and a keystroke notifies NOTHING', () => {
  // `screen` is what main.ts's one layout owner listens on (a change that
  // stayed silent would leave the grid hidden with nothing over it); a pane is
  // ordinary pane-area chrome, so it rides `ui` like every other tab change.
  const only = (fn: () => void): string[] => {
    kinds.length = 0;
    fn();
    return kinds;
  };
  assert.deepEqual(only(() => st.openCommitView(HEAD, AT)), ['screen']);
  assert.deepEqual(only(() => st.toggleCommitFile(HEAD, F0.path)), ['screen']);
  assert.deepEqual(only(() => st.closeCommitView()), ['screen']);
  // Creating the Home tab is itself a `ui` change; count what OPENING costs,
  // not what the first-ever tab costs.
  st.openFile({ kind: 'home' }, 'seed/first.ts', 'first.ts');
  assert.deepEqual(only(() => st.openFile({ kind: 'home' }, 'a/one.ts', 'one.ts')), ['ui']);
  assert.deepEqual(only(() => st.openDiff({ kind: 'home' }, HEAD, 'a/one.ts', ROOT)), ['ui']);
  // A keystroke must not notify: a chrome rebuild per character would take the
  // caret with it (ui/file-pane.ts updates the gutter in place instead).
  assert.deepEqual(only(() => st.setEdit('f:a/one.ts', 'typed')), []);
  assert.deepEqual(only(() => st.saveEdit('f:a/one.ts')), ['ui'], 'saving is a chrome change');
  assert.deepEqual(only(() => st.saveEdit('f:a/one.ts')), [], 'saving a clean file changes nothing');
  const home = st.state.views[0] as View;
  assert.deepEqual(only(() => st.closeSlot(home.id, 0)), ['ui']);
  assert.deepEqual(only(() => st.closeSlot(home.id, 9)), [], 'closing nothing is a no-op');
});

test('an ANSWER notifies `screen` and nothing else — no pane is built behind the view', async () => {
  // THE A6 RULE (memory: frontend-terminal-quirks): while the grid is hidden
  // nothing may build, reconcile or measure a terminal. `ui/panes.ts` renders
  // on `'ui'` alone, so every async answer this screen takes must ride
  // `'screen'` — and a diff landing behind a fold must ride it too.
  fx.hold();
  st.openCommitView(HEAD, AT);
  kinds.length = 0;
  fx.release();
  await settle();
  assert.ok(kinds.length > 0, 'non-vacuity: answers really did land');
  assert.deepEqual([...new Set(kinds)], ['screen']);
  st.closeCommitView();
});

test('re-opening the SAME commit keeps the folds; a different one starts fresh', async () => {
  await open(HEAD);
  st.toggleCommitFile(HEAD, F0.path);
  assert.equal(st.state.commitCollapsed.size, 1);

  kinds.length = 0;
  st.openCommitView(HEAD, AT);
  assert.deepEqual(kinds, [], 'opening what is already open is not a change');
  assert.equal(st.commitFileCollapsed(HEAD, F0.path), true, 'and it does not unfold the user');
  assert.equal(byClass(commitRoot, 'diff-block').length, C0.files.length);

  await open(hashOf(1));
  const second = detailOf(hashOf(1)) as NonNullable<ReturnType<typeof detailOf>>;
  assert.equal(st.commitFileCollapsed(HEAD, F0.path), false, 'another commit inherits no fold');
  assert.deepEqual(blockPaths(), second.files.map((f) => f.path));
});

test('closing the commit view empties the fold set — a closed view remembers nothing', async () => {
  await open(HEAD);
  st.toggleCommitFile(HEAD, F0.path);
  st.toggleCommitFile(HEAD, F1.path);
  assert.equal(st.state.commitCollapsed.size, 2);
  st.closeCommitView();
  assert.equal(st.state.commitCollapsed.size, 0, 'the set cannot grow across visits');
  assert.equal(st.state.openCommitAt, null, 'and the screen forgets where it was reading');
  kinds.length = 0;
  st.closeCommitView();
  assert.deepEqual(kinds, [], 'closing a closed view is a no-op');
  // And the next visit to the SAME commit is fully expanded again.
  await open(HEAD);
  assert.equal(st.commitFileCollapsed(HEAD, F0.path), false);
});

test('closing an editor pane leaves every other file’s unsaved text alone', () => {
  st.openFile({ kind: 'home' }, 'a/one.ts', 'one.ts');
  st.openFile({ kind: 'home' }, 'a/two.ts', 'two.ts');
  st.setEdit('f:a/one.ts', 'one typed');
  st.setEdit('f:a/two.ts', 'two typed');
  const home = st.state.views[0] as View;
  // A10b: the second file is a TAB of the first file's pane, so closing that
  // ONE pane takes both files off the screen — and only the text of files no
  // tab shows any more is dropped.
  assert.equal(home.slots.length, 1, 'non-vacuity: both files are tabs of ONE Home pane');
  assert.equal(tabsOf(home).length, 2);

  st.closeTab(home.id, 0, tabsOf(home).findIndex((t) => t.path === 'a/two.ts'));
  assert.equal(st.editorDirty('f:a/one.ts'), true, 'the other file is untouched');
  assert.equal(st.state.edits.get('f:a/one.ts'), 'one typed');
  // The closed file was on no other pane, so its text goes with it
  // (PROJECT-SCOPE: dropped when the LAST pane showing that file closes).
  // `closeTab` is the state MUTATOR: since part B4 the question about unsaved
  // text stands in FRONT of it (`closeTabGuarded`, ui/unsaved.ts), never in it.
  assert.equal(st.state.edits.has('f:a/two.ts'), false);
  assert.deepEqual(tabsOf(st.state.views[0] as View), [{ kind: 'file', path: 'a/one.ts' }]);
});

test('the keyboard lands on the way out when a commit opens, and stays put while folding', async () => {
  // The screen changed under the user; the focus has to go somewhere it can
  // leave from, or the keyboard falls to <body> (the rule the drawers follow).
  await open(HEAD);
  assert.equal(dom.doc.activeElement, byKey(commitRoot, 'commit:back'), 'focus lands on the way out');

  // And a fold rebuilds the whole body, so the control that was pressed has to
  // be handed the keyboard back by its `data-k`, not lost with its node.
  const toggle = byKey(commitRoot, `diff:${HEAD}:${F0.path}`) as FakeElement;
  toggle.focus();
  toggle.click();
  const after = byKey(commitRoot, `diff:${HEAD}:${F0.path}`) as FakeElement;
  assert.notEqual(after, toggle, 'non-vacuity: the block really was rebuilt');
  assert.equal(dom.doc.activeElement, after, 'the same control keeps the keyboard');

  // Re-rendering an unchanged view does not yank the focus a second time.
  const focused = dom.doc.activeElement;
  view.render();
  assert.equal(dom.doc.activeElement, focused);
});

test('every commit the list can open really draws — no hash opens a blank screen', async () => {
  // The panel opens a commit BY HASH and main.ts hides the pane grid on
  // `openCommit !== null`; a hash the view cannot resolve would leave an empty
  // middle row with no control in it. Every hash the Commits list offers must
  // therefore render a body.
  assert.ok(SUMMARIES.length >= 5, 'non-vacuity: there are commits to open');
  for (const c of SUMMARIES) {
    await open(c.hash);
    const detail = detailOf(c.hash) as NonNullable<ReturnType<typeof detailOf>>;
    assert.equal(textsOf(commitRoot, 'commit-vmsg')[0], c.subject, c.hash);
    assert.equal(byClass(commitRoot, 'diff-block').length, detail.files.length, c.hash);
    assert.notEqual(byKey(commitRoot, 'commit:back'), null, `${c.hash} has a way out`);
    st.closeCommitView();
  }
});

test('a diff is asked for BY COMMIT: the request carries the hash, not only the path', async () => {
  // The same path lives in more than one commit and `git show <hash> -- <path>`
  // answers differently for each, so the hash travels with every request — and
  // the renderer takes the ANSWER, which is what lets a diff PANE reuse it.
  await open(HEAD);
  for (const call of fx.diffCalls) assert.match(call, new RegExp(`^${HEAD} `));
  const src = readSource('web', 'src', 'ui', 'commit-view.ts');
  assert.match(src, /export function diffBox\(asked: Asked<GitCommitDiffResponse>\): HTMLElement/);
  assert.match(src, /askDiff\(f\.path\);/, 'the store is asked per file');
  const store = readSource('web', 'src', 'ui', 'commit-store.ts');
  assert.match(store, /gw\.commitDiff\(entry\.root, entry\.hash, path\)/, 'hash and root both travel');
  const fp = readSource('web', 'src', 'ui', 'file-pane.ts');
  assert.match(fp, /fetchDiff\(root, hash, path\)/, 'and so does the diff PANE (A10)');
  assert.match(fp, /diffBox\(asked\)/, 'which draws through the SAME renderer');
});

test('the header states the SERVER`s numbers, and every fetched block draws exactly its lines', async () => {
  // B3 replaced "the numbers are counted from the drawn rows" (a mock could
  // only be honest that way): the counts are git's now, and what this pins is
  // that the screen states them unchanged and invents no row of its own.
  let blocks = 0;
  for (const c of SUMMARIES.slice(0, 3)) {
    await open(c.hash);
    const detail = detailOf(c.hash) as NonNullable<ReturnType<typeof detailOf>>;
    const sum = byClass(commitRoot, 'commit-vsum')[0] as FakeElement;
    assert.ok(sum.textContent.includes(`+${c.add}`), `${c.hash}: the server's add`);
    assert.ok(sum.textContent.includes(`-${c.del}`), `${c.hash}: the server's del`);
    assert.ok(sum.textContent.includes(`${c.files} files changed`), c.hash);
    for (const f of detail.files) {
      const block = byClass(commitRoot, 'diff-block').find(
        (b) => textsOf(b, 'diff-path')[0] === f.path,
      ) as FakeElement | undefined;
      assert.ok(block, `${c.hash} ${f.path} has a block`);
      if (f.add !== null) {
        assert.ok(block.textContent.includes(`+${f.add}`), `${c.hash} ${f.path}: +`);
        assert.ok(block.textContent.includes(`-${f.del}`), `${c.hash} ${f.path}: -`);
      }
      const answer = diffOf(c.hash, f.path);
      const drawn = byClass(block, 'diff-line').length;
      const expected = f.path === GONE_PATH ? 0 : answer.lines.length;
      assert.equal(drawn, expected, `${c.hash} ${f.path}: rows drawn`);
      blocks++;
    }
    st.closeCommitView();
  }
  assert.ok(blocks >= 5, `non-vacuity: ${blocks} blocks counted`);
});

test('each file block carries the id the Files panel row points `aria-controls` at', async () => {
  await open(HEAD);
  const blocks = byClass(commitRoot, 'diff-block');
  assert.equal(blocks.length, C0.files.length, 'non-vacuity');
  const ids = blocks.map((b) => b.id);
  assert.deepEqual(
    ids,
    C0.files.map((f) => MODEL.blockDomId(HEAD, f.path)),
    'one id per file, derived from the same key the fold is remembered by',
  );
  assert.equal(new Set(ids).size, ids.length, 'and they are unique');
  for (const id of ids) assert.match(id, /^[A-Za-z][A-Za-z0-9_-]*$/, `${id} is a valid id`);
});

test('a diff row is TEXT, never markup — the user`s own source reaches textContent', async () => {
  const marked = { binary: false, tooLarge: false, lines: [
    { kind: 'add', oldNo: null, newNo: 1, text: '<img src=x onerror="boom">' },
  ] };
  const box = CV.diffBox({ k: 'ready', value: marked });
  assert.deepEqual(textsOf(box, 'diff-t'), ['<img src=x onerror="boom">']);
  assert.equal(byClass(box, 'diff-t').length, 1, 'one span, not a parsed tree');
  const src = readSource('web', 'src', 'ui', 'commit-view.ts');
  assert.equal(src.includes('innerHTML'), false, 'nothing here ever parses a string');
});

test('code surfaces draw plain glyphs — ONE ligature rule, named as a design-system rule', () => {
  // The terminal renders no ligatures; an editor that prints `===` as one long
  // glyph shows code the pane beside it cannot show, and hides the difference
  // between `==` and `===`.
  const css = readSource('web', 'src', 'styles', 'app.css');
  const at = css.indexOf('font-variant-ligatures: none');
  assert.notEqual(at, -1, 'the rule exists');
  assert.equal(
    css.split('font-variant-ligatures').length - 1,
    1,
    'ONE shared rule, not a copy per surface',
  );
  const rule = css.slice(css.lastIndexOf('/*', at), css.indexOf('}', at));
  for (const sel of [
    '.pane-text',
    '.pane-gutter',
    // Nocturne A10b: the A6 `.pane-dhash` header chip is gone with the file /
    // diff pane headers. What prints a path segment and a commit hash now is
    // the file-tab chip's label, so IT is what has to be in the rule.
    '.pane-tab-pick',
    '.diff-t',
    '.diff-path',
    '.commit-fpath',
    // Nocturne B3: a commit's own message body, drawn beside the diff.
    '.commit-vtext',
    // Nocturne A7: the Terminal colours preview is a terminal fragment, so it
    // joins the same rule instead of declaring a second copy.
    '.sg-tcprev',
  ]) {
    assert.ok(rule.includes(`${sel},`) || rule.includes(`${sel} {`), `${sel} is in the rule`);
  }
  assert.match(rule, /DESIGN-SYSTEM RULE[\s\S]*like the terminal/, 'and it says what it is');
});

test('every class the commit screen renders has a rule in app.css (a typo is an invisible block)', async () => {
  // Every state it has: a commit loading, an open one, a folded block, a
  // binary and a capped file, a capped file list, and a hash that is gone.
  // (The file and diff PANES are covered by `tests/ui/ui-file-pane.test.ts`.)
  const seen = new Set<string>();
  const collect = (root: FakeElement): void => {
    for (const el of [root, ...descendants(root)]) {
      for (const c of el.className.split(/\s+/)) if (c !== '') seen.add(c);
    }
  };
  fx.hold();
  st.openCommitView(HEAD, AT);
  collect(commitRoot);
  fx.release();
  await settle();
  collect(commitRoot);
  st.toggleCommitFile(HEAD, F0.path);
  collect(commitRoot);
  st.closeCommitView();
  await open(hashOf(1));
  collect(commitRoot);
  st.closeCommitView();
  await open(hashOf(2));
  collect(commitRoot);
  st.closeCommitView();
  await open(WIDE);
  collect(commitRoot);
  st.closeCommitView();
  await open('f'.repeat(40));
  collect(commitRoot);
  st.closeCommitView();

  assert.ok(seen.size > 25, `non-vacuity: ${seen.size} classes were collected`);
  const css = readSource('web', 'src', 'styles', 'app.css');
  const missing = [...seen].filter((c) => !css.includes(`.${c}`)).sort();
  assert.deepEqual(missing, [], `classes with no rule in app.css: ${missing.join(', ')}`);
});
