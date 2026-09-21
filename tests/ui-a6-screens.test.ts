/**
 * The commit view (Nocturne A6, re-pointed by A10, LIVE since B3) driven
 * through the REAL `web/src/ui/commit-view.ts` on the shared DOM double,
 * against the REAL `web/src/state.ts`, `ui/util.ts`, `ui/icons.ts`,
 * `ui/commit-store.ts` and the A6 models — with the backend a plain fake
 * object (`tests/fs-fixture.ts`) over the fixture history
 * (`tests/commits-fixture.ts`).
 *
 * WHY, next to `ui-commit-model.test.ts`. That file pins the arithmetic and
 * the copy; this one pins the PLUMBING, which is where the silent regressions
 * live: a back button that closes nothing, a file block whose fold state
 * disagrees with the Files panel row that folded it, an `Open file` that opens
 * a repo-relative path nothing can read, a diff asked for twice per fold, a
 * stale answer painting over the commit the user actually opened, a screen
 * that leaves the keyboard on <body>. Every one of those keeps the model tests
 * green.
 *
 * THE EDITOR HALF OF THIS FILE IS GONE WITH THE EDITOR COLUMN (part A10): a
 * file is a PANE now, so its body is pinned in `tests/ui-file-pane.test.ts`,
 * its chrome in `tests/ui-pane-a10.test.ts` and its tab chip in
 * `tests/ui-tabs-a10.test.ts`.
 *
 * Plus the shell wiring in `web/src/main.ts` and the pane-area guard in
 * `web/src/ui/panes.ts`, read from the source — main.ts's import graph reaches
 * @xterm/xterm, a browser bundle. Each assertion is written so that deleting
 * the wiring it names fails it.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, colour, a pane really reflowing a PTY, focus policy, scrolling,
 * screen-reader output.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  byClass,
  byKey,
  descendants,
  dispatch,
  installDom,
  textsOf,
  type FakeElement,
} from './fake-dom.ts';
import { FakeApiError, PROJ, makeFixture, settle } from './fs-fixture.ts';
import {
  BINARY_PATH,
  GITHUB,
  REPO_ROOT,
  GONE_PATH,
  GONE_TEXT,
  HEAD,
  NO_GITHUB,
  NOW,
  SUMMARIES,
  TOO_LARGE_PATH,
  WIDE,
  detailOf,
  diffOf,
  hashOf,
} from './commits-fixture.ts';

const dom = installDom();
const here = dirname(fileURLToPath(import.meta.url));

type EditorTab =
  | { kind: 'file'; path: string }
  | { kind: 'diff'; hash: string; path: string; root: string };
/**
 * A10b: a pane is a terminal or an EDITOR holding a strip of file/diff tabs.
 * The commit view's two openers go through `st.openFile` / `st.openDiff`, so
 * what they produce is an editor SLOT whose strip holds the tab — never a
 * `file` slot, which no longer exists.
 */
interface Slot {
  kind: 'session' | 'editor';
  id?: string;
  tabs?: EditorTab[];
  active?: number;
}

/** The tabs of every editor pane of a view, in pane then strip order. */
function tabsOf(v: View): EditorTab[] {
  return v.slots.flatMap((s) => s.tabs ?? []);
}
interface View {
  id: string;
  root: { kind: 'home' } | { kind: 'project'; id: string } | null;
  slots: Slot[];
  focused: number;
}
interface StateModule {
  state: {
    openCommit: string | null;
    openCommitAt: { root: string; repoRoot: string | null } | null;
    commitCollapsed: Set<string>;
    edits: Map<string, string>;
    views: View[];
    activeViewId: string;
  };
  subscribe(fn: (kind: string) => void): void;
  openCommitView(hash: string, at: { root: string; repoRoot: string | null }): void;
  /** Part B3: the repository behind the open commit, learned late. */
  noteCommitRepoRoot(root: string, repoRoot: string): void;
  closeCommitView(): void;
  toggleCommitFile(hash: string, path: string): void;
  commitFileCollapsed(hash: string, path: string): boolean;
  activeView(): View | null;
  openFile(root: { kind: 'home' }, path: string, label: string): string;
  openDiff(root: { kind: 'home' }, hash: string, path: string, repoRoot: string): string;
  closeSlot(viewId: string, index: number): boolean;
  closeTab(viewId: string, slot: number, tabIndex: number): boolean;
  editorFileId(path: string): string;
  editorDirty(id: string | null): boolean;
  setEdit(id: string, text: string): void;
  saveEdit(id: string): string | null;
}

const st = (await import(new URL('../web/src/state.ts', import.meta.url).href)) as StateModule;
const CV = (await import(new URL('../web/src/ui/commit-view.ts', import.meta.url).href)) as {
  initCommitView(
    host: unknown,
    onLeaveScreen: () => void,
    onOpenPane: () => void,
    now?: () => number,
  ): { render(): void };
  /** The one diff renderer, shared with a diff PANE (ui/file-pane.ts). */
  diffBox(asked: unknown): FakeElement;
  OPEN_BLOCKS: number;
};
const STORE = (await import(new URL('../web/src/ui/commit-store.ts', import.meta.url).href)) as {
  setCommitGateway(gw: unknown): void;
  /** Every change the store makes; a reader's render signature carries it. */
  commitVersion(): number;
};
const MODEL = (await import(new URL('../web/src/ui/commit-model.ts', import.meta.url).href)) as {
  blockDomId(hash: string, path: string): string;
};

/**
 * THE BACKEND IS A FAKE (part B3). The commit view takes its two questions
 * through the gateway `ui/commit-store.ts` owns, injected here exactly as
 * main.ts injects the real one — so the whole screen, every state it passes
 * through and every request it does NOT make are driven with no HTTP and no
 * module stubbing.
 */
const fx = makeFixture();
STORE.setCommitGateway(fx.gateway);

/**
 * The commit every test below opens, and the two roots it is read from — two
 * DIFFERENT folders on purpose: the panel asks git from the folder it is
 * standing in (`root`, here a subfolder), while a commit names its files
 * relative to the REPOSITORY (`repoRoot`). One value for both would make the
 * two-field design untestable: every assertion would pass whichever field the
 * code happened to read.
 */
const C0 = detailOf(HEAD) as NonNullable<ReturnType<typeof detailOf>>;
const ROOT = `${PROJ}/web`;
const AT = { root: ROOT, repoRoot: REPO_ROOT };
const F0 = C0.files[0] as { path: string; add: number | null; del: number | null };
const F1 = C0.files[1] as { path: string; add: number | null; del: number | null };

const commitHost = dom.doc.createElement('section');
dom.body.append(commitHost);

/** The view leaves in two directions; main.ts points both at the pane area. */
let handBacks = 0;
let paneHandovers = 0;
const view = CV.initCommitView(
  commitHost,
  () => {
    handBacks += 1;
  },
  () => {
    paneHandovers += 1;
  },
  () => NOW,
);

/** The shell's own dispatch: the screen re-renders on every change. */
st.subscribe(() => {
  view.render();
});

const commitRoot = commitHost.children[0] as FakeElement;

/** Open a commit the way the Files panel does, and let its answer land. */
async function open(hash: string): Promise<void> {
  st.openCommitView(hash, AT);
  await settle();
}

/** The paths of the blocks currently drawn, in order. */
function blockPaths(): string[] {
  return textsOf(commitRoot, 'diff-path');
}

beforeEach(async () => {
  st.state.openCommit = null;
  st.state.openCommitAt = null;
  st.state.commitCollapsed = new Set();
  st.state.edits = new Map();
  st.state.views = [];
  st.state.activeViewId = '';
  handBacks = 0;
  paneHandovers = 0;
  dom.doc.activeElement = dom.body;
  fx.reset();
  view.render();
  await settle();
});

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
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'commit-view.ts'), 'utf8');
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
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'commit-view.ts'), 'utf8');
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
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'commit-view.ts'), 'utf8');
  assert.match(src, /log\.debug\('open commit on github'\)/);
  assert.equal(src.includes('window.open('), false, 'it goes through the shared exit');
  assert.match(src, /import \{ openExternal \} from '\.\/open-external\.ts';/);
});

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
  const api = (await import(new URL('../web/src/api.ts', import.meta.url).href)) as {
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
  const css = readFileSync(join(here, '..', 'web', 'src', 'styles', 'app.css'), 'utf8');
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
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'commit-view.ts'), 'utf8');
  for (const [key, opener, call] of [
    ['diffopen', 'openFile', 'st.openFile('],
    ['diffchanges', 'changes', 'st.openDiff('],
  ] as [string, string, string][]) {
    const from = src.indexOf(`const ${opener} = button(`);
    assert.notEqual(from, -1, `non-vacuity: the ${key} handler was found`);
    const body = src.slice(from, src.indexOf('});', from));
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

// ---------------------------------------------------------------------------
// The shell wiring (web/src/main.ts) and the pane-area guard (ui/panes.ts)
// ---------------------------------------------------------------------------

const MAIN = readFileSync(join(here, '..', 'web', 'src', 'main.ts'), 'utf8');
const PANES = readFileSync(join(here, '..', 'web', 'src', 'ui', 'panes.ts'), 'utf8');

test('main.ts builds the commit screen as a flex sibling of the grid, and NO editor column', () => {
  assert.ok(MAIN.includes('function buildShell'), 'non-vacuity: main.ts still builds the shell');
  // Both hand-overs land in the pane area since A10: back to the panes, or into
  // the pane a file was just opened in. The focused pane knows which it is.
  assert.match(
    MAIN,
    /const commitView = initCommitView\(commitAside, requestTerminalFocus, requestTerminalFocus\);/,
  );
  assert.match(
    MAIN,
    /main\.append\(projAside, filesAside, commitAside, grid, sessAside\);/,
    'the middle row is Projects, Files, the commit screen, the panes and Sessions',
  );
  // The editor column is gone with part A10: a file is a pane, and the grid
  // keeps the whole row (the user's complaint about the half-width panes).
  for (const dead of ['initEditor', 'editorAside', 'is-narrow', 'editorVisible']) {
    assert.equal(MAIN.includes(dead), false, `${dead} died with the editor column`);
  }
});

test('ONE owner decides who occupies the pane area, and it runs BEFORE the panes do', () => {
  // Order matters: when a commit view closes, the grid must already be visible
  // by the time ui/panes.ts is asked to render, or the rebuild it refuses
  // while hidden would be refused for good.
  const layout = MAIN.indexOf('st.subscribe(applyScreenLayout);');
  const panes = MAIN.indexOf('initPanes(grid,');
  assert.ok(layout !== -1 && panes !== -1, 'non-vacuity: both wirings were found');
  assert.ok(layout < panes, 'the layout owner subscribes first');

  const body = MAIN.slice(MAIN.indexOf('function applyScreenLayout'), layout);
  assert.match(body, /commitAside\.hidden = !commitOpen;/);
  assert.match(body, /grid\.hidden = commitOpen;/);
  assert.match(body, /if \(wasHidden && !grid\.hidden\) refreshPaneArea\(\);/);
  assert.match(MAIN, /applyScreenLayout\(\);\n\s*updateChrome\(\);/, 'and once at boot');
});

test('the panes refuse to render at all against a hidden grid — the WebGL trap', () => {
  // xterm must open on an attached, MEASURABLE node; constructing a
  // TerminalView on a `display: none` grid can permanently downgrade the WebGL
  // renderer and leaves it at xterm's default 80x24, which `connect()` then
  // sends to a PTY that is not. A rebuild is not the only construction site:
  // `reconcileSlot()` builds one too when a slot's session changes (a swap
  // chord, an exited pane's relaunch resolving), so the guard stands at the TOP
  // of `render()` — one copy, before anything is read or touched.
  assert.match(PANES, /function gridHidden\(\): boolean \{[\s\S]*grid\.hidden !== false;/);
  assert.match(PANES, /export function refreshPaneArea\(\): void \{\s*render\(\);/, 'the replay is the first thing refreshPaneArea does');
  const render = PANES.slice(PANES.indexOf('function render(): void'), PANES.indexOf('function renderEmpty'));
  assert.ok(render.length > 200 && render.length < 3000, 'non-vacuity: the render function was found');
  assert.equal(render.split('if (gridHidden()) return;').length - 1, 1, 'exactly one guard');
  assert.match(
    render,
    /function render\(\): void \{(\s*\/\/[^\n]*\n)*\s*if \(gridHidden\(\)\) return;/,
    'and it is the FIRST statement, so the reconcile path is covered too',
  );
  assert.ok(
    render.indexOf('if (gridHidden()) return;') < render.indexOf('st.activeView()'),
    'nothing is read before the guard',
  );
  assert.match(
    readFileSync(join(here, '..', 'web', 'src', 'styles', 'app.css'), 'utf8'),
    /\[hidden\] \{\s*display: none !important;/,
    'the hidden flag has to be real for the guard to mean anything',
  );
});

test('the grid coming back on screen acks the focused pane\'s attention itself — not the next window activation', () => {
  // applyFocus() early-returns on an unchanged focus key, so after Back the
  // badge raised under the view stayed until the next window focus (verify
  // run 2026-09-13). refreshPaneArea() takes that ack, gated on a visible
  // grid AND a focused window.
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'panes.ts'), 'utf8');
  const fn = /export function refreshPaneArea\(\): void \{[\s\S]*?\n\}/.exec(src);
  assert.ok(fn, 'refreshPaneArea found');
  assert.match(fn[0], /render\(\);/);
  assert.match(fn[0], /if \(gridHidden\(\) \|\| !document\.hasFocus\(\)\) return;/, 'gated on visible grid + focused window');
  assert.match(fn[0], /clearAttentionIfPending\(s\)/, 'acks the focused slot');
  assert.ok(fn[0].indexOf('render();') < fn[0].indexOf('clearAttentionIfPending'), 'render first, ack after');
});

test('a hidden grid acknowledges NO attention badge on a live BEL or an info frame either (verify-terminal A6 b)', () => {
  // The window-focus gate (R2) was not the path a live BEL takes: the
  // onAttention and onInfo acks in slotEvents() decided on "focused pane +
  // document has focus" alone, so a BEL under the commit view was seen 1 ms
  // after it was raised (server.log: attention raised → seen). Both
  // predicates must also ask whether the grid is on screen.
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'panes.ts'), 'utf8');
  const onInfo = /onInfo: \(info: SessionInfo\) => \{[\s\S]*?clearAttentionIfPending\(s\);/.exec(src);
  assert.ok(onInfo, 'onInfo ack block found');
  assert.match(onInfo[0], /document\.hasFocus\(\) &&\s*!gridHidden\(\)/, 'info-frame ack is gated on a visible grid');
  const onAttn = /onAttention: \(\) => \{[\s\S]*?ackSeen\(pay, sessionId\);/.exec(src);
  assert.ok(onAttn, 'onAttention ack block found');
  assert.match(onAttn[0], /document\.hasFocus\(\) &&\s*!gridHidden\(\)/, 'live BEL ack is gated on a visible grid');
});

test('a hidden grid acknowledges NO attention badge on window refocus (scope review R2)', () => {
  // Scenario: a session BELs while the commit view covers the panes, the tab
  // strip shows "Needs you", the user alt-tabs away and back. Without the
  // guard the refocus listener acks a terminal that was never on screen and
  // the badge is gone. The deferred applyFocus() on return acks it honestly.
  const listener = PANES.slice(
    PANES.indexOf("window.addEventListener('focus'"),
    PANES.indexOf('function gridHidden'),
  );
  assert.ok(listener.length > 100, 'non-vacuity: the refocus listener was found');
  assert.match(listener, /if \(gridHidden\(\)\) return;/, 'the hidden grid stands down');
  assert.ok(
    listener.indexOf('if (gridHidden()) return;') < listener.indexOf('clearAttentionIfPending'),
    'and it stands BEFORE anything is acknowledged',
  );
});

test('a hidden grid is never MEASURED for a new PTY either (scope review R3)', () => {
  // `New session` (top bar, Ctrl+Alt+T) and the drawer's resume stay reachable
  // while the commit view is up; proposeDims() on a `display: none` terminal
  // falls back to 80x24 and the first screenful lands wrapped in the
  // scrollback, which the later attach reconcile cannot repair.
  const dims = PANES.slice(
    PANES.indexOf('export function focusedPaneDims'),
    PANES.indexOf('function render(): void'),
  );
  assert.ok(dims.length > 100 && dims.length < 1600, 'non-vacuity: the function was found');
  assert.match(dims, /if \(!gridHidden\(\) &&/, 'a hidden grid is never measured');
  assert.match(dims, /st\.state\.sessions\.get\(id\)/, 'the focused session states its own size');
  assert.match(dims, /info\.status === 'running'/, 'and only a running one is believed');
  assert.match(dims, /return lastGoodDims \?\? \{ cols: 80, rows: 24 \};/, 'then the last good dims');
  assert.ok(
    dims.indexOf('gridHidden()') < dims.indexOf('proposeDims()'),
    'nothing is measured before the guard',
  );
  // And `lastGoodDims` is fed from the one place a view reports its size.
  assert.match(PANES, /onDims: \(cols, rows\) => \{\s*lastGoodDims = \{ cols, rows \};/);
});

test('nothing narrows the grid any more — the panes keep the whole row (A10)', () => {
  const css = readFileSync(join(here, '..', 'web', 'src', 'styles', 'app.css'), 'utf8');
  assert.equal(css.includes('is-narrow'), false, 'the 46% rule died with the editor column');
  assert.equal(css.includes('.editor-'), false, 'and so did the whole editor family');
  // Non-vacuity: the pane area itself is definitely still styled here.
  assert.match(css, /\.grid \{/);
});

test('Escape closes the commit view, ranked under the dialogs and over the drawers', () => {
  const from = MAIN.indexOf("e.key === 'Escape'");
  assert.notEqual(from, -1, 'non-vacuity: the Escape branch was found');
  const branch = MAIN.slice(from, MAIN.indexOf('// ---- reliability'));
  const arms = branch.split('} else if');
  const commitArm = arms.findIndex((a) => a.includes('st.closeCommitView();'));
  const drawerArm = arms.findIndex((a) => a.includes('st.closeDrawer();'));
  const launchArm = arms.findIndex((a) => a.includes('closeLaunchDialog();'));
  assert.ok(commitArm !== -1 && drawerArm !== -1 && launchArm !== -1, 'non-vacuity: three arms found');
  assert.ok(launchArm < commitArm, 'every dialog outranks the commit view');
  assert.ok(commitArm < drawerArm, 'and the commit view outranks the drawer/panel arms');
  assert.match(arms[commitArm] as string, /!isEditable\(e\.target\)/, 'a field keeps its own Escape');
  assert.match(arms[commitArm] as string, /st\.closeCommitView\(\);[\s\S]*requestTerminalFocus\(\);/);
});

test('the pane chords stand down while the commit view covers the panes', () => {
  // Ctrl+Alt+Arrow, Ctrl+Alt+Shift+Arrow and Ctrl+Alt+1..9 move focus between,
  // swap sessions inside, and switch panes NOBODY CAN SEE while the view is up.
  const from = MAIN.indexOf("if (e.ctrlKey && e.altKey");
  assert.notEqual(from, -1, 'non-vacuity: the chord block was found');
  const block = MAIN.slice(from, MAIN.indexOf("if (e.key === '?'", from));
  assert.match(block, /const paneChord =/);
  assert.match(block, /if \(paneChord && st\.state\.openCommit !== null\) return;/);
  // It has to stand BEFORE the three calls it guards, or it guards nothing.
  const guard = block.indexOf('if (paneChord && st.state.openCommit !== null) return;');
  for (const call of ['st.moveFocus(', 'st.movePane(', 'st.setActiveViewIndex(']) {
    const at = block.indexOf(call);
    assert.notEqual(at, -1, `non-vacuity: ${call} is in this block`);
    assert.ok(guard < at, `${call} runs after the guard`);
  }
  // And the chords that open something of their own are NOT swallowed.
  assert.ok(block.indexOf('openLaunchDialog();') > guard);
  assert.match(block, /k === 't' \|\| k === 'T'/);
});

test('`paneChord` names EVERY chord that moves a pane, the digits included', () => {
  // Gate addition: "the guard stands before the calls" stays true if the guard
  // covers only the arrows, and Ctrl+Alt+1..9 would still switch to a tab
  // nobody can see. The SET itself is the contract.
  const at = MAIN.indexOf('const paneChord =');
  assert.notEqual(at, -1, 'non-vacuity: the set was found');
  const expr = MAIN.slice(at, MAIN.indexOf(';', at));
  for (const key of ["k === 'ArrowLeft'", "k === 'ArrowRight'", "k === 'ArrowUp'", "k === 'ArrowDown'"]) {
    assert.ok(expr.includes(key), `${key} is a pane chord`);
  }
  assert.match(expr, /k\.length === 1 && k >= '1' && k <= '9'/, 'and so is Ctrl+Alt+1..9');
  // The three handlers this set exists for are exactly the three pane moves —
  // read from the branches that follow, so a fourth one cannot be forgotten.
  const block = MAIN.slice(
    MAIN.indexOf('if (e.ctrlKey && e.altKey'),
    MAIN.indexOf("if (e.key === '?'", at),
  );
  const guarded = ['st.moveFocus(', 'st.movePane(', 'st.setActiveViewIndex('];
  for (const call of guarded) {
    const keyFor = call === 'st.setActiveViewIndex(' ? "k >= '1' && k <= '9'" : "k === 'ArrowLeft'";
    assert.ok(block.includes(keyFor), `${call} is reached by a key the set names`);
  }
});

test('neither screen is persisted: the UI bag writes the same keys it did in A5', () => {
  const src = readFileSync(join(here, '..', 'web', 'src', 'state.ts'), 'utf8');
  const save = src.slice(src.indexOf('function saveUi'), src.indexOf('function loadUi'));
  assert.ok(save.length > 200, 'non-vacuity: saveUi was found');
  for (const key of ['openCommit', 'edits', 'commitCollapsed']) {
    assert.equal(save.includes(key), false, `${key} is a place the user stands, not a preference`);
  }
});

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
  // Still no confirm before B4 owns the disk write; the amber dot is the warning.
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
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'commit-view.ts'), 'utf8');
  assert.match(src, /export function diffBox\(asked: Asked<GitCommitDiffResponse>\): HTMLElement/);
  assert.match(src, /askDiff\(f\.path\);/, 'the store is asked per file');
  const store = readFileSync(join(here, '..', 'web', 'src', 'ui', 'commit-store.ts'), 'utf8');
  assert.match(store, /gw\.commitDiff\(entry\.root, entry\.hash, path\)/, 'hash and root both travel');
  const fp = readFileSync(join(here, '..', 'web', 'src', 'ui', 'file-pane.ts'), 'utf8');
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
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'commit-view.ts'), 'utf8');
  assert.equal(src.includes('innerHTML'), false, 'nothing here ever parses a string');
});

test('code surfaces draw plain glyphs — ONE ligature rule, named as a design-system rule', () => {
  // The terminal renders no ligatures; an editor that prints `===` as one long
  // glyph shows code the pane beside it cannot show, and hides the difference
  // between `==` and `===`.
  const css = readFileSync(join(here, '..', 'web', 'src', 'styles', 'app.css'), 'utf8');
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
  // (The file and diff PANES are covered by `tests/ui-file-pane.test.ts`.)
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
  const css = readFileSync(join(here, '..', 'web', 'src', 'styles', 'app.css'), 'utf8');
  const missing = [...seen].filter((c) => !css.includes(`.${c}`)).sort();
  assert.deepEqual(missing, [], `classes with no rule in app.css: ${missing.join(', ')}`);
});
