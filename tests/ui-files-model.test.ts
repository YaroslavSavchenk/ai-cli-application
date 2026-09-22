/**
 * Nocturne part A5 — the Files panel's LOGIC, and the state rules the panel
 * hangs on.
 *
 * Two halves, both driven through the real modules:
 *
 *   1. `web/src/ui/files-model.ts` — flat path list → tree, tree → the rows a
 *      render actually draws (indent, caret, which rows pulse), the
 *      since-last-commit summary, the plural copy, and the per-extension
 *      badge table. This is the half that survives part B2 unchanged: the
 *      mock module is replaced by `git diff --numstat`, and every rule below
 *      still has to hold.
 *   2. `web/src/state.ts` — the width clamp (200..520), the toggle semantics
 *      (opening Files closes the Projects drawer; a drawer never writes the
 *      wish) and the visibility rule (`leftPanel === 'files'` AND the Projects
 *      drawer is not open — only ONE left panel at a time, and no session is
 *      required; user decision 2026-09-15, deviates from v3).
 *
 * The mock module is checked too, but only for the things that would make the
 * panel lie about itself: it must carry the numbers the summary row prints and
 * it must not have drifted into a second author.
 *
 * NOT claimed here (needs a browser, `.claude/skills/verify-terminal/SKILL.md`):
 * that the panel is laid out or coloured as specified, that the drag really
 * resizes a PTY, or that anything is legible.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionInfo } from '../shared/protocol.ts';
import {
  badgeFor,
  buildTree,
  commitsHeaderText,
  diffSummary,
  summaryText,
  treeRows,
  type FileChange,
} from '../web/src/ui/files-model.ts';
import { branchLabel } from '../web/src/ui/commit-model.ts';

// state.ts touches localStorage inside function bodies; same shim as tests/ui-state.test.ts.
class MemoryStorage {
  #map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.#map.has(k) ? (this.#map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.#map.set(k, v);
  }
  removeItem(k: string): void {
    this.#map.delete(k);
  }
  clear(): void {
    this.#map.clear();
  }
}
const memoryStorage = new MemoryStorage();
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = memoryStorage;
const st = await import('../web/src/state.ts');

function mkSession(id: string, status: SessionInfo['status'] = 'running'): SessionInfo {
  return {
    id,
    title: id,
    command: 'bash',
    args: [],
    cwd: '/tmp',
    status,
    cols: 80,
    rows: 24,
    createdAt: new Date().toISOString(),
    attention: false,
  };
}

beforeEach(() => {
  memoryStorage.clear();
  st.state.sessions = new Map();
  st.state.projects = [];
  st.state.views = [];
  st.state.activeViewId = '';
  st.state.drawer = null;
  st.state.leftPanel = 'files';
  st.state.filesWidth = st.FILES_W_DEFAULT;
});

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

const SAMPLE: FileChange[] = [
  { path: 'web/src/main.ts', add: 10, del: 2 },
  { path: 'web/src/ui/files.ts', add: 5, del: 0, editing: true },
  { path: 'web/README.md' },
  { path: 'server/index.ts', add: 1, del: 1 },
  { path: 'LICENSE' },
];

test('buildTree: flat paths become folders and files, in the order they arrived', () => {
  const tree = buildTree(SAMPLE);
  assert.deepEqual(
    tree.map((n) => `${n.name}${n.dir ? '/' : ''}`),
    ['web/', 'server/', 'LICENSE'],
    'roots keep input order — no invented sorting (B2 decides that with real data)',
  );
  const web = tree[0];
  assert.equal(web?.path, 'web');
  assert.deepEqual(
    (web?.children ?? []).map((n) => n.name),
    ['src', 'README.md'],
  );
  const src = web?.children[0];
  assert.equal(src?.dir, true);
  assert.deepEqual(
    (src?.children ?? []).map((n) => n.name),
    ['main.ts', 'ui'],
    'a folder discovered through a later path is created where it was first seen',
  );
});

test('buildTree: a folder carries the sums and the editing flag of everything beneath it', () => {
  const tree = buildTree(SAMPLE);
  const web = tree[0];
  assert.equal(web?.add, 15, 'web = 10 + 5');
  assert.equal(web?.del, 2);
  assert.equal(web?.editing, true, 'a folder holding an edited file is busy');
  const server = tree[1];
  assert.equal(server?.editing, false, 'a folder with nothing being edited is not');
  const license = tree[2];
  assert.equal(license?.dir, false);
  assert.equal(license?.add, 0);
});

test('buildTree: an empty list is an empty tree, and a stray empty path is ignored', () => {
  assert.deepEqual(buildTree([]), []);
  assert.deepEqual(buildTree([{ path: '' }]), []);
});

test('treeRows: indent is 8 + depth * 14, and the caret states the folder', () => {
  const open = new Set(['web', 'web/src', 'web/src/ui', 'server']);
  const rows = treeRows(buildTree(SAMPLE), open);
  const byPath = new Map(rows.map((r) => [r.path, r]));
  assert.equal(byPath.get('web')?.indent, 8);
  assert.equal(byPath.get('web/src')?.indent, 22);
  assert.equal(byPath.get('web/src/ui')?.indent, 36);
  assert.equal(byPath.get('web/src/ui/files.ts')?.indent, 50);
  assert.equal(byPath.get('web')?.caret, '▾');
  assert.equal(byPath.get('web/src/main.ts')?.caret, '', 'a file has no caret');
});

test('treeRows: a closed folder hides its whole subtree, and reopening brings it back', () => {
  const closed = treeRows(buildTree(SAMPLE), new Set(['web']));
  assert.deepEqual(
    closed.map((r) => r.path),
    ['web', 'web/src', 'web/README.md', 'server', 'LICENSE'],
    'web/src is drawn but closed, so nothing under it is',
  );
  const opened = treeRows(buildTree(SAMPLE), new Set(['web', 'web/src']));
  assert.ok(opened.some((r) => r.path === 'web/src/main.ts'));
  assert.equal(
    opened.some((r) => r.path === 'web/src/ui/files.ts'),
    false,
    'web/src/ui is still closed',
  );
});

test('treeRows: the amber pulse marks the edited file AND every folder above it, nothing else', () => {
  const open = new Set(['web', 'web/src', 'web/src/ui', 'server']);
  const rows = treeRows(buildTree(SAMPLE), open);
  const busy = rows.filter((r) => r.busy).map((r) => r.path);
  assert.deepEqual(busy, ['web', 'web/src', 'web/src/ui', 'web/src/ui/files.ts']);
  const editing = rows.filter((r) => r.editing).map((r) => r.path);
  assert.deepEqual(editing, ['web/src/ui/files.ts'], 'only a FILE is ever "editing"');
});

test('treeRows: a file knows whether it carries a diff — that is what decides its ink', () => {
  const rows = treeRows(buildTree(SAMPLE), new Set(['web', 'web/src']));
  const main = rows.find((r) => r.path === 'web/src/main.ts');
  assert.equal(main?.hasDiff, true);
  assert.equal(main?.add, 10);
  assert.equal(main?.del, 2);
  const readme = rows.find((r) => r.path === 'web/README.md');
  assert.equal(readme?.hasDiff, false, 'an untouched file shows no numbers');
});

// ---------------------------------------------------------------------------
// Summary + copy
// ---------------------------------------------------------------------------

test('diffSummary: totals, and only files with a real diff are counted', () => {
  const s = diffSummary(SAMPLE);
  assert.deepEqual(s, { add: 16, del: 3, files: 3 });
  assert.deepEqual(diffSummary([]), { add: 0, del: 0, files: 0 });
  assert.deepEqual(
    diffSummary([{ path: 'a.ts', add: 0, del: 0 }]),
    { add: 0, del: 0, files: 0 },
    'a zero-line entry is not a changed file',
  );
});

test('counts are pluralised in both tabs (README-v3 copy rule)', () => {
  assert.equal(summaryText(1), 'since last commit in 1 file');
  assert.equal(summaryText(0), 'since last commit in 0 files');
  assert.equal(summaryText(7), 'since last commit in 7 files');
  assert.equal(commitsHeaderText('main', 1), 'main, 1 commit');
  assert.equal(commitsHeaderText('main', 5), 'main, 5 commits');
  assert.equal(commitsHeaderText('release', 0), 'release, 0 commits');
});

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

test('badgeFor: the v3 table, including the families that share a colour', () => {
  assert.deepEqual(badgeFor('main.ts'), { label: 'TS', kind: 'ts' });
  assert.deepEqual(badgeFor('App.tsx'), { label: 'TSX', kind: 'ts' });
  assert.deepEqual(badgeFor('x.js'), { label: 'JS', kind: 'js' });
  assert.deepEqual(badgeFor('x.jsx'), { label: 'JSX', kind: 'js' });
  assert.deepEqual(badgeFor('make-icon.mjs'), { label: 'JS', kind: 'js' });
  assert.deepEqual(badgeFor('a.py'), { label: 'PY', kind: 'py' });
  assert.deepEqual(badgeFor('README.md'), { label: 'MD', kind: 'md' });
  assert.deepEqual(badgeFor('package.json'), { label: '{ }', kind: 'json' });
  assert.deepEqual(badgeFor('launch.ps1'), { label: 'PS', kind: 'ps' });
  assert.deepEqual(badgeFor('app.css'), { label: 'CSS', kind: 'css' });
  assert.deepEqual(badgeFor('index.html'), { label: '<>', kind: 'html' });
  assert.deepEqual(badgeFor('run.sh'), { label: 'SH', kind: 'sh' });
  assert.deepEqual(badgeFor('ci.yml'), { label: 'YML', kind: 'yml' });
  assert.deepEqual(badgeFor('ci.yaml'), { label: 'YML', kind: 'yml' });
  // `.toml` is NOT a family: README-v3 lists thirteen marks and TML is none of
  // them, so it falls through to the neutral chip like any other unknown type.
  assert.deepEqual(badgeFor('Cargo.toml'), { label: '·', kind: 'plain' });
  assert.deepEqual(badgeFor('main.rs'), { label: 'RS', kind: 'rs' });
  assert.deepEqual(badgeFor('main.go'), { label: 'GO', kind: 'go' });
});

test('badgeFor: an unknown type, a dotfile and a file with no extension all get the neutral mark', () => {
  assert.deepEqual(badgeFor('LICENSE'), { label: '·', kind: 'plain' });
  assert.deepEqual(badgeFor('.gitignore'), { label: '·', kind: 'plain' });
  assert.deepEqual(badgeFor('notes.xyz'), { label: '·', kind: 'plain' });
  assert.deepEqual(badgeFor('MAIN.TS'), { label: 'TS', kind: 'ts' }, 'the extension is case-insensitive');
  assert.deepEqual(badgeFor('archive.tar.gz'), { label: '·', kind: 'plain' }, 'only the LAST extension counts');
});

// ---------------------------------------------------------------------------
// The renderer's own fixture — the shape the live tabs really hand it
// ---------------------------------------------------------------------------

/**
 * The shape part B2's `Changes` tab really hands this renderer: a flat list of
 * repo-relative paths, numbers only where git has them. It replaces the
 * `MOCK_FILES` this test used to read (part B2 deleted that half of
 * `ui/files-mock.ts`, B3 the commits half and B4 the module), and it is HERE
 * because the arithmetic below is about the renderer, not about anybody's
 * data.
 */
const FIXTURE: FileChange[] = [
  { path: 'web/src/App.tsx', add: 12, del: 4 },
  { path: 'web/src/Pane.tsx', add: 8, del: 6, editing: true },
  { path: 'web/src/TabStrip.tsx' },
  { path: 'server/ws.ts', add: 6, del: 0 },
  { path: 'README.md' },
];

test('a flat change list becomes the tree the panel draws, and the summary it prints', () => {
  const s = diffSummary(FIXTURE);
  assert.deepEqual(s, { add: 26, del: 10, files: 3 });
  assert.equal(summaryText(s.files), 'since last commit in 3 files');
  // Every folder the caller says is open must exist in the tree built from the
  // same list, or the panel opens with a set of names that mean nothing.
  const open = ['web', 'web/src', 'server'];
  const rows = treeRows(buildTree(FIXTURE), new Set(open));
  const dirs = new Set(rows.filter((r) => r.dir).map((r) => r.path));
  for (const f of open) assert.ok(dirs.has(f), `open folder ${f} is in the tree`);
  assert.ok(rows.some((r) => r.busy), 'an edited file pulses, and so does the spine above it');
});

test('the commits header states the BRANCH and the repository`s own total, pluralised', () => {
  // Part B3: the count is `rev-list --count`, not the number of rows drawn —
  // the list holds one page of ten and the header is about the repository.
  assert.equal(commitsHeaderText('main', 5), 'main, 5 commits');
  assert.equal(commitsHeaderText('main', 1), 'main, 1 commit');
  assert.equal(commitsHeaderText('main', 214), 'main, 214 commits');
  // A detached head has no branch to name, and the word for that is the same
  // one on every surface (`ui/commit-model.ts`).
  assert.equal(commitsHeaderText(branchLabel(null), 214), 'Detached, 214 commits');
  assert.equal(branchLabel('main'), 'main');
  assert.equal(branchLabel(''), 'Detached', 'an empty name is no name');
});

// ---------------------------------------------------------------------------
// State: width, toggle, visibility
// ---------------------------------------------------------------------------

test('the width clamps to 200..520 and never becomes a fraction or a NaN', () => {
  assert.equal(st.FILES_W_MIN, 200);
  assert.equal(st.FILES_W_MAX, 520);
  assert.equal(st.FILES_W_DEFAULT, 300);
  assert.equal(st.clampFilesWidth(300), 300);
  assert.equal(st.clampFilesWidth(199), 200);
  assert.equal(st.clampFilesWidth(-4000), 200);
  assert.equal(st.clampFilesWidth(521), 520);
  assert.equal(st.clampFilesWidth(99999), 520);
  assert.equal(st.clampFilesWidth(301.6), 302);
  assert.equal(st.clampFilesWidth(Number.NaN), 300);
});

test('setFilesWidth stores the clamped value and hands it back to the caller', () => {
  assert.equal(st.setFilesWidth(1000, false), 520);
  assert.equal(st.state.filesWidth, 520);
  assert.equal(st.setFilesWidth(120), 200);
  assert.equal(st.state.filesWidth, 200);
});

test('toggling Files: it opens, it closes, and opening it closes the Projects drawer', () => {
  st.state.leftPanel = null;
  st.state.drawer = 'projects';
  st.toggleLeftPanel('files');
  assert.equal(st.state.leftPanel, 'files');
  assert.equal(st.state.drawer, null, 'two left panels at once would squeeze the terminal');

  st.toggleLeftPanel('files');
  assert.equal(st.state.leftPanel, null, 'the same toggle closes it');
});

test('toggling Files leaves the SESSIONS drawer alone (it is on the other side)', () => {
  st.state.leftPanel = null;
  st.state.drawer = 'sessions';
  st.toggleLeftPanel('files');
  assert.equal(st.state.drawer, 'sessions');
});

test('a drawer never touches the WISH — but Projects HIDES Files while it is open', () => {
  // User decision 2026-09-15: only one left panel at a time. Projects borrows
  // the left side; it does not take the wish with it, so closing it gives the
  // user their default panel back instead of costing them one.
  st.state.leftPanel = 'files';
  st.toggleDrawer('projects');
  assert.equal(st.state.drawer, 'projects');
  assert.equal(st.state.leftPanel, 'files', 'the wish survives; the layout is the user`s to make');
  assert.equal(st.filesPanelVisible(), false, 'two left panels at once is what this forbids');

  st.closeDrawer();
  assert.equal(st.state.leftPanel, 'files');
  assert.equal(st.filesPanelVisible(), true, 'closing Projects brings Files back by itself');

  st.toggleDrawer('sessions');
  assert.equal(st.state.leftPanel, 'files');
  assert.equal(st.filesPanelVisible(), true, 'the Sessions drawer is on the other side');
  st.closeDrawer();
  assert.equal(st.state.leftPanel, 'files');
});

test('openDrawer(projects) hides Files exactly like the toggle does', () => {
  st.state.leftPanel = 'files';
  st.state.drawer = null;
  st.openDrawer('projects');
  assert.equal(st.filesPanelVisible(), false);
  assert.equal(st.state.leftPanel, 'files', 'and it never writes the wish');
  st.openDrawer('projects');
  assert.equal(st.filesPanelVisible(), false, 'opening it twice is still once');
  st.closeDrawer();
  assert.equal(st.filesPanelVisible(), true);
});

test('pressing Files while it is hidden behind Projects SHOWS it (wish kept)', () => {
  st.state.leftPanel = 'files';
  st.state.drawer = 'projects';
  st.toggleLeftPanel('files');
  assert.equal(st.state.drawer, null, 'the drawer that was covering it steps aside');
  assert.equal(st.state.leftPanel, 'files', 'the wish is never flipped off by a button the user cannot see');
  assert.equal(st.filesPanelVisible(), true);

  // And from there the same button still closes it.
  st.toggleLeftPanel('files');
  assert.equal(st.state.leftPanel, null);
  assert.equal(st.filesPanelVisible(), false);
});

test('visibility = the user wants it AND Projects is not covering the left side', () => {
  // No session is involved: user decision 2026-09-15 dropped that condition,
  // so the panel is up on an empty app (its header then reads Home).
  st.state.leftPanel = 'files';
  st.state.drawer = null;
  assert.equal(st.aliveSessionCount(), 0);
  assert.equal(st.filesPanelVisible(), true, 'the panel opens with nothing running');

  st.initServer([], [mkSession('s1')]);
  assert.equal(st.aliveSessionCount(), 1);
  assert.equal(st.filesPanelVisible(), true);

  st.state.leftPanel = null;
  assert.equal(st.filesPanelVisible(), false, 'closed is closed, session or no session');
});

test('an EXITED session does not close the panel, and the toggle still records the wish', () => {
  st.initServer([], [mkSession('s1', 'exited'), mkSession('s2', 'exited')]);
  assert.equal(st.aliveSessionCount(), 0, 'non-vacuity: nothing is alive');
  st.state.leftPanel = null;
  st.toggleLeftPanel('files');
  assert.equal(st.state.leftPanel, 'files', 'the button always answers');
  assert.equal(st.filesPanelVisible(), true, 'and the panel it opens stays open');
});

test('the panel starts WANTED, so it appears by itself with the first session', () => {
  // A module-level default, which this runner's shared singleton cannot show
  // after the reset above — so it is read where it is declared.
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'src', 'state.ts'),
    'utf8',
  );
  const init = src.slice(src.indexOf('export const state: AppState = {'));
  assert.ok(init.length > 100, 'non-vacuity: the state initializer was found');
  assert.match(init.slice(0, 400), /leftPanel: 'files',/);
  assert.match(init.slice(0, 400), /filesWidth: FILES_W_DEFAULT,/);
});

// ===========================================================================
// Gap closure (test-engineer, A5 gate): the shapes a real `git diff --numstat`
// walk will hand this model in part B2 — deep spines, unsorted input, implicit
// folders — plus the edges the panel's own arithmetic hangs on.
// ===========================================================================

test('buildTree ORDER RULE: input order, verbatim — folders are not hoisted, nothing is sorted', () => {
  // The rule the code implements (files-model.ts buildTree): a node appears
  // where its path was FIRST seen, siblings keep that order, and folders are
  // NOT grouped before files. git already returns a stable order; inventing a
  // second one is B2's decision to make with real data, not this model's.
  const tree = buildTree([
    { path: 'zeta.md' },
    { path: 'alpha/one.ts' },
    { path: 'beta.md' },
    { path: 'alpha/two.ts' },
  ]);
  assert.deepEqual(
    tree.map((n) => `${n.name}${n.dir ? '/' : ''}`),
    ['zeta.md', 'alpha/', 'beta.md'],
    'a file BEFORE a folder stays before it (no folders-first, no alphabetical)',
  );
  assert.deepEqual(
    (tree[1]?.children ?? []).map((n) => n.name),
    ['one.ts', 'two.ts'],
    'and a second file in a known folder joins it in arrival order',
  );
});

test('buildTree: every ancestor is created implicitly — a folder never has to be listed', () => {
  const tree = buildTree([{ path: 'a/b/c/d/deep.ts', add: 3, del: 1 }]);
  const names: string[] = [];
  let node = tree[0];
  while (node !== undefined) {
    names.push(`${node.name}:${node.dir ? 'dir' : 'file'}:${node.path}`);
    node = node.children[0];
  }
  assert.deepEqual(names, [
    'a:dir:a',
    'b:dir:a/b',
    'c:dir:a/b/c',
    'd:dir:a/b/c/d',
    'deep.ts:file:a/b/c/d/deep.ts',
  ]);
});

test('buildTree: the sums climb the WHOLE spine, and a sibling branch stays at zero', () => {
  const tree = buildTree([
    { path: 'x/y/z/touched.ts', add: 4, del: 2, editing: true },
    { path: 'x/other/quiet.ts', add: 1, del: 0 },
  ]);
  const x = tree[0];
  assert.equal(x?.add, 5, 'x = 4 + 1');
  assert.equal(x?.del, 2);
  assert.equal(x?.editing, true);
  const y = x?.children[0];
  assert.equal(y?.name, 'y');
  assert.equal(y?.editing, true);
  assert.equal(y?.children[0]?.editing, true, 'z, the last folder above the file');
  const other = x?.children[1];
  assert.equal(other?.name, 'other');
  assert.equal(other?.editing, false, 'a sibling branch never pulses');
  assert.equal(other?.add, 1);
});

test('buildTree: a leading slash and a doubled slash are segments that do not exist', () => {
  const tree = buildTree([{ path: '/web//src/main.ts', add: 1 }]);
  assert.deepEqual(
    (tree[0]?.children ?? []).map((n) => n.path),
    ['web/src'],
    'empty segments are dropped, so the path keys stay the ones git prints',
  );
  assert.equal(tree[0]?.path, 'web');
});

test('buildTree: a missing add or del counts as zero, it is not NaN', () => {
  const tree = buildTree([{ path: 'a/only-add.ts', add: 7 }, { path: 'a/only-del.ts', del: 3 }]);
  assert.equal(tree[0]?.add, 7);
  assert.equal(tree[0]?.del, 3);
  assert.equal(tree[0]?.children[0]?.del, 0);
  assert.equal(tree[0]?.children[1]?.add, 0);
});

test('KNOWN LIMIT: a path listed as a file AND used as a folder keeps the first shape', () => {
  // `git diff --numstat` cannot produce both for one path, so this is an
  // impossible input, pinned rather than defended against: the first entry
  // decides, and the second entry's children hang under a FILE node, which
  // `treeRows` never descends into. If B2 ever feeds this model a listing
  // that CAN contain both, this is the test that must change first.
  const tree = buildTree([{ path: 'a', add: 1 }, { path: 'a/b.ts', add: 2 }]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0]?.dir, false, 'the file came first, so `a` stays a file');
  assert.equal(tree[0]?.children.length, 1, 'the child is built, but nothing renders it');
  const rows = treeRows(tree, new Set(['a']));
  assert.deepEqual(rows.map((r) => r.path), ['a'], 'the panel shows one row, never a half-tree');
});

test('KNOWN LIMIT: the same path twice adds up twice (a numstat walk lists a path once)', () => {
  assert.deepEqual(diffSummary([{ path: 'a.ts', add: 2, del: 1 }, { path: 'a.ts', add: 3, del: 1 }]), {
    add: 5,
    del: 2,
    files: 2,
  });
  const tree = buildTree([{ path: 'a.ts', add: 2 }, { path: 'a.ts', add: 3 }]);
  assert.equal(tree.length, 1, 'the tree still holds ONE node for the path');
  assert.equal(tree[0]?.add, 5);
});

test('treeRows: a folder row never prints numbers, even though its node carries the sums', () => {
  const rows = treeRows(buildTree(SAMPLE), new Set(['web']));
  const web = rows.find((r) => r.path === 'web');
  assert.equal(web?.add, 0);
  assert.equal(web?.del, 0);
  assert.equal(web?.hasDiff, false, 'the +/- column belongs to files; a folder is a spine');
  assert.equal(web?.editing, false, 'and a folder is never "editing" — it is `busy`');
});

test('treeRows: the open set is folders only — a FILE path in it changes nothing', () => {
  const open = new Set(['web', 'web/src', 'web/src/main.ts', 'LICENSE']);
  const rows = treeRows(buildTree(SAMPLE), open);
  const main = rows.find((r) => r.path === 'web/src/main.ts');
  assert.equal(main?.dir, false);
  assert.equal(main?.open, false);
  assert.equal(main?.caret, '');
  assert.equal(rows.filter((r) => r.path === 'LICENSE').length, 1);
});

test('treeRows: indent keeps stepping past the third level (8 + depth * 14)', () => {
  const files: FileChange[] = [{ path: 'a/b/c/d/e/leaf.ts', add: 1 }];
  const open = new Set(['a', 'a/b', 'a/b/c', 'a/b/c/d', 'a/b/c/d/e']);
  const rows = treeRows(buildTree(files), open);
  assert.deepEqual(
    rows.map((r) => r.indent),
    [8, 22, 36, 50, 64, 78],
  );
  assert.deepEqual(
    rows.map((r) => r.depth),
    [0, 1, 2, 3, 4, 5],
  );
});

test('treeRows: a closed folder deep in the spine cuts everything below it', () => {
  const files: FileChange[] = [{ path: 'a/b/c/leaf.ts', add: 1, editing: true }];
  const rows = treeRows(buildTree(files), new Set(['a', 'a/b/c']));
  assert.deepEqual(rows.map((r) => r.path), ['a', 'a/b'], 'a/b is closed; opening a/b/c is moot');
  assert.deepEqual(rows.filter((r) => r.busy).map((r) => r.path), ['a', 'a/b'], 'the pulse still reaches what IS drawn');
});

test('diffSummary: one-sided diffs count as changed, and a missing number is not a change', () => {
  assert.deepEqual(diffSummary([{ path: 'a.ts', add: 5 }]), { add: 5, del: 0, files: 1 });
  assert.deepEqual(diffSummary([{ path: 'a.ts', del: 5 }]), { add: 0, del: 5, files: 1 });
  assert.deepEqual(diffSummary([{ path: 'a.ts' }]), { add: 0, del: 0, files: 0 });
  assert.deepEqual(
    diffSummary([{ path: 'a.ts', editing: true }]),
    { add: 0, del: 0, files: 0 },
    'a file being edited has not changed anything until it has',
  );
});

test('badgeFor: multi-dot names take the LAST extension, and case never matters', () => {
  assert.deepEqual(badgeFor('ui-files-model.test.ts'), { label: 'TS', kind: 'ts' });
  assert.deepEqual(badgeFor('index.d.ts'), { label: 'TS', kind: 'ts' });
  assert.deepEqual(badgeFor('vite.config.MJS'), { label: 'JS', kind: 'js' });
  assert.deepEqual(badgeFor('App.TSX'), { label: 'TSX', kind: 'ts' });
  assert.deepEqual(badgeFor('CI.YAML'), { label: 'YML', kind: 'yml' });
});

test('badgeFor: a name with no usable extension is the neutral mark, never a guess', () => {
  assert.deepEqual(badgeFor('Makefile'), { label: '·', kind: 'plain' });
  assert.deepEqual(badgeFor('LICENSE.'), { label: '·', kind: 'plain' }, 'a trailing dot is not an extension');
  assert.deepEqual(badgeFor('.env'), { label: '·', kind: 'plain' }, 'a dotfile has no extension');
  assert.deepEqual(badgeFor(''), { label: '·', kind: 'plain' });
  assert.deepEqual(badgeFor('.eslintrc.json'), { label: '{ }', kind: 'json' }, 'a dotfile WITH one does');
});

test('badgeFor: every kind in the table is reachable, and `plain` only by falling through', () => {
  const kinds = new Set(
    [
      'a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.py', 'a.md', 'a.json',
      'a.ps1', 'a.css', 'a.html', 'a.sh', 'a.yml', 'a.yaml', 'a.rs', 'a.go',
    ].map((n) => badgeFor(n).kind),
  );
  assert.deepEqual(
    Array.from(kinds).sort(),
    ['css', 'go', 'html', 'js', 'json', 'md', 'ps', 'py', 'rs', 'sh', 'ts', 'yml'],
    'the 12 colour families the panel styles — losing one silently would drop a colour',
  );
  assert.equal(badgeFor('a.xyz').kind, 'plain');
});

test('commitsHeaderText: the branch is printed verbatim, whatever it is called', () => {
  assert.equal(commitsHeaderText('feature/files-panel', 2), 'feature/files-panel, 2 commits');
  assert.equal(commitsHeaderText('main', 100), 'main, 100 commits');
});

// ---------------------------------------------------------------------------
// State: the notifications the chrome hangs on
// ---------------------------------------------------------------------------

const kinds: string[] = [];
st.subscribe((k: string) => {
  kinds.push(k);
});

test('clampFilesWidth: infinities and fractions land on a whole, in-range number', () => {
  assert.equal(st.clampFilesWidth(Number.POSITIVE_INFINITY), st.FILES_W_DEFAULT);
  assert.equal(st.clampFilesWidth(Number.NEGATIVE_INFINITY), st.FILES_W_DEFAULT);
  assert.equal(st.clampFilesWidth(0), 200);
  assert.equal(st.clampFilesWidth(200.4), 200);
  assert.equal(st.clampFilesWidth(519.5), 520);
  assert.equal(st.clampFilesWidth(520.6), 520, 'rounding never escapes the bound');
  assert.equal(Number.isInteger(st.clampFilesWidth(333.333)), true);
});

test('setFilesWidth notifies the chrome on a COMMIT and stays silent during the drag', () => {
  kinds.length = 0;
  st.setFilesWidth(400, false);
  assert.deepEqual(kinds, [], 'a live drag must not rebuild the chrome per pointermove');
  st.setFilesWidth(400, true);
  assert.deepEqual(kinds, ['panel']);
  kinds.length = 0;
  st.setFilesWidth(410);
  assert.deepEqual(kinds, ['panel'], 'committing is the default');
});

test('toggleLeftPanel: closing Files leaves every drawer alone', () => {
  st.state.leftPanel = 'files';
  st.state.drawer = 'sessions';
  kinds.length = 0;
  st.toggleLeftPanel('files');
  assert.equal(st.state.leftPanel, null);
  assert.equal(st.state.drawer, 'sessions', 'closing Files is not a layout change on the left');
  assert.deepEqual(kinds, ['panel']);
});

test('toggleLeftPanel: pressing Files while Projects covers it announces both changes', () => {
  // The wish is already 'files', so nothing about it changes — what the press
  // does is take the left side back, and both halves of that are announced.
  st.state.leftPanel = 'files';
  st.state.drawer = 'projects';
  kinds.length = 0;
  st.toggleLeftPanel('files');
  assert.deepEqual(kinds, ['drawer', 'panel']);
  assert.equal(st.state.leftPanel, 'files');
  assert.equal(st.state.drawer, null);
});

test('a drawer change is ONE notify: main.ts re-renders the chrome on every kind', () => {
  // Hiding and showing the Files panel through the Projects drawer needs no
  // extra 'panel' notify — main.ts subscribes one kind-agnostic listener that
  // runs updateChrome() and filesPanel.render() for any change.
  st.state.leftPanel = 'files';
  st.state.drawer = null;
  kinds.length = 0;
  st.toggleDrawer('projects');
  assert.deepEqual(kinds, ['drawer']);
  kinds.length = 0;
  st.closeDrawer();
  assert.deepEqual(kinds, ['drawer']);
  kinds.length = 0;
  st.openDrawer('projects');
  assert.deepEqual(kinds, ['drawer']);
});

test('toggleLeftPanel: opening Files over the Projects drawer announces both changes', () => {
  st.state.leftPanel = null;
  st.state.drawer = 'projects';
  kinds.length = 0;
  st.toggleLeftPanel('files');
  assert.deepEqual(kinds, ['drawer', 'panel'], 'the drawer closed AND the panel opened');
});

test('toggleLeftPanel: with no drawer open it is one change', () => {
  st.state.leftPanel = null;
  st.state.drawer = null;
  kinds.length = 0;
  st.toggleLeftPanel('files');
  assert.deepEqual(kinds, ['panel']);
  assert.equal(st.state.leftPanel, 'files');
});

test('toggleLeftPanel: over the Sessions drawer it is one change too (other side)', () => {
  st.state.leftPanel = null;
  st.state.drawer = 'sessions';
  kinds.length = 0;
  st.toggleLeftPanel('files');
  assert.deepEqual(kinds, ['panel']);
  assert.equal(st.state.drawer, 'sessions');
});

test('aliveSessionCount counts what has not exited — and the panel no longer follows it', () => {
  st.state.drawer = null;
  st.initServer([], [mkSession('a'), mkSession('b', 'exited'), mkSession('c')]);
  assert.equal(st.aliveSessionCount(), 2);
  st.state.leftPanel = 'files';
  assert.equal(st.filesPanelVisible(), true);

  st.state.sessions = new Map([['b', mkSession('b', 'exited')]]);
  assert.equal(st.aliveSessionCount(), 0);
  assert.equal(
    st.filesPanelVisible(),
    true,
    'the last live session leaving does NOT take the panel with it (user decision 2026-09-15)',
  );

  st.state.sessions = new Map();
  st.state.leftPanel = null;
  st.initServer([], [mkSession('d')]);
  assert.equal(st.filesPanelVisible(), false, 'a live session does not re-open a panel the user closed');
});

// ---------------------------------------------------------------------------
// The left side, closed: the states a wrong `opening` clause or a stray
// saveUi() would break. Added by the test gate (2026-09-15).
// ---------------------------------------------------------------------------

test('toggleDrawer(projects) twice is a round trip: Files is hidden, then back, wish untouched', () => {
  st.state.leftPanel = 'files';
  st.state.drawer = null;
  assert.equal(st.filesPanelVisible(), true, 'non-vacuity: it starts on screen');

  st.toggleDrawer('projects');
  assert.equal(st.state.drawer, 'projects');
  assert.equal(st.filesPanelVisible(), false);

  st.toggleDrawer('projects');
  assert.equal(st.state.drawer, null, 'the same button closes what it opened');
  assert.equal(st.state.leftPanel, 'files', 'and the wish rode through both presses');
  assert.equal(st.filesPanelVisible(), true, 'peeking at Projects never costs the user their panel');
});

test('toggleLeftPanel: with NO drawer open the Files button still CLOSES Files', () => {
  // Regression guard for the `|| state.drawer === 'projects'` clause in
  // `opening`: widen it by a character and the panel becomes unclosable.
  st.state.leftPanel = 'files';
  st.state.drawer = null;
  st.toggleLeftPanel('files');
  assert.equal(st.state.leftPanel, null, 'the toggle is still a toggle');
  assert.equal(st.state.drawer, null);
  assert.equal(st.filesPanelVisible(), false);

  st.toggleLeftPanel('files');
  assert.equal(st.state.leftPanel, 'files', 'and it opens again from there');
  assert.equal(st.filesPanelVisible(), true);
});

test('toggleLeftPanel over the SESSIONS drawer closes Files and leaves the drawer standing', () => {
  st.state.leftPanel = 'files';
  st.state.drawer = 'sessions';
  assert.equal(st.filesPanelVisible(), true, 'non-vacuity: the two share the screen');
  st.toggleLeftPanel('files');
  assert.equal(st.state.leftPanel, null, 'only PROJECTS makes a press mean "show me"');
  assert.equal(st.state.drawer, 'sessions');
  assert.equal(st.filesPanelVisible(), false);
});

test('a persisted closed wish survives loadUi — and Projects opening and closing never opens it', () => {
  memoryStorage.setItem(
    'ai-sm:ui:v2',
    JSON.stringify({ views: [], active: null, leftPanel: null, filesWidth: 420 }),
  );
  st.loadUi();
  assert.equal(st.state.leftPanel, null, 'a literal null is the user closing it');
  assert.equal(st.state.filesWidth, 420, 'non-vacuity: the same bag was really read');
  assert.equal(st.filesPanelVisible(), false);

  st.toggleDrawer('projects');
  assert.equal(st.filesPanelVisible(), false);
  st.toggleDrawer('projects');
  assert.equal(st.state.drawer, null);
  assert.equal(st.state.leftPanel, null, 'the drawer path never invents a wish');
  assert.equal(st.filesPanelVisible(), false, 'closed stays closed with the left side free');
});

test('the drawer path does not WRITE the wish: no saveUi on open, close or openDrawer', () => {
  st.state.leftPanel = 'files';
  st.state.drawer = null;
  st.saveUi();
  const written = JSON.parse(memoryStorage.getItem('ai-sm:ui:v2') as string) as Record<string, unknown>;
  assert.equal(written.leftPanel, 'files', 'non-vacuity: saveUi really wrote the wish');
  // A key saveUi never emits: any re-write by the drawer path erases it.
  memoryStorage.setItem('ai-sm:ui:v2', JSON.stringify({ ...written, gateMark: 'drawer-path' }));

  st.toggleDrawer('projects');
  st.closeDrawer();
  st.openDrawer('projects');
  st.closeDrawer();

  const after = JSON.parse(memoryStorage.getItem('ai-sm:ui:v2') as string) as Record<string, unknown>;
  assert.equal(after.gateMark, 'drawer-path', 'storage was not rewritten, so saveUi was not called');
  assert.equal(after.leftPanel, 'files');
  assert.equal(st.state.leftPanel, 'files');
  assert.equal(st.filesPanelVisible(), true);
});

test('toggleLeftPanel DOES persist the wish (the counterweight to the drawer path)', () => {
  st.state.leftPanel = 'files';
  st.state.drawer = null;
  st.saveUi();
  st.toggleLeftPanel('files');
  const after = JSON.parse(memoryStorage.getItem('ai-sm:ui:v2') as string) as Record<string, unknown>;
  assert.equal(after.leftPanel, null, 'closing the panel is the user speaking, and it survives a reload');
});

test('an untracked DIRECTORY (git`s `sub/`) is a folder row with no children', () => {
  // MEASURED against this repository (part B2, 2026-09-16): `git status
  // --porcelain` reports an untracked directory as ONE row with a trailing
  // slash — `b2check-tmp/` — and says nothing about what is inside it. A naive
  // split makes that a FILE row called `b2check-tmp`, which claims a file that
  // does not exist; an empty-named leaf is worse still.
  const roots = buildTree([{ path: 'sub/' }, { path: 'web/new-dir/' }, { path: 'a.ts', add: 1 }]);
  assert.deepEqual(
    roots.map((n) => [n.path, n.dir, n.children.length]),
    [
      ['sub', true, 0],
      ['web', true, 1],
      ['a.ts', false, 0],
    ],
  );
  const web = roots[1] as { children: { path: string; dir: boolean }[] };
  assert.deepEqual(web.children.map((c) => [c.path, c.dir]), [['web/new-dir', true]]);

  // It draws as a folder row with NO caret and no numbers: there is nothing
  // under it to disclose, and a disclosure mark that opens onto an empty tree
  // is a promise the data cannot keep. The folder that DOES hold something
  // keeps its caret.
  const rows = treeRows(roots, new Set(['sub']));
  assert.deepEqual(
    rows.map((r) => [r.path, r.dir, r.caret, r.hasDiff]),
    [
      ['sub', true, '', false],
      ['web', true, '▸', false],
      ['a.ts', false, '', true],
    ],
  );
});
