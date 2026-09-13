/**
 * `web/src/ui/files.ts` — the Files panel (Nocturne A5) driven through the REAL
 * module: the grip dragged with real pointer events, the arrow keys pressed,
 * folder rows clicked, tabs switched — against the REAL `web/src/state.ts`,
 * `ui/util.ts`, `ui/icons.ts`, `ui/files-model.ts` and `ui/files-mock.ts`.
 *
 * WHY, next to `tests/ui-files-model.test.ts`. That file pins the model's
 * arithmetic; this one pins the PLUMBING between it and the panel, which is
 * where a silent regression fits: a grip that resizes without pointer capture
 * (the pointer leaves the 6px strip and the drag dies mid-gesture), a drag
 * that never commits (the width is lost on the next chrome rebuild), a width
 * that skips the clamp (a 3px panel or a panel wider than the window), a
 * folder that stops toggling, a tab that renders the other tab's body. Every
 * one of those keeps `ui-files-model.test.ts` green.
 *
 * Plus the shell wiring in `web/src/main.ts` that no unit can reach: the panel
 * is constructed, it is a flex sibling BEFORE the grid (so opening it narrows
 * the panes and the existing fit -> ws `resize` chain fires), the Files button
 * really toggles, and visibility goes through `filesPanelVisible()`. Those are
 * read from the source — main.ts's own import graph reaches @xterm/xterm, a
 * browser bundle — and each assertion is written so that deleting the wiring
 * it names fails it.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, colour, the amber pulse actually animating, that a drag really
 * reflows a PTY, hit-testing, screen-reader output.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project, SessionInfo } from '../shared/protocol.ts';
import {
  byClass,
  byKey,
  descendants,
  dispatch,
  installDom,
  textsOf,
  type FakeElement,
} from './fake-dom.ts';

const dom = installDom();

// The modules are imported through a computed URL: the server tsconfig must
// not walk the browser type graph (web/tsconfig.json owns that).
const here = dirname(fileURLToPath(import.meta.url));
const st = (await import(new URL('../web/src/state.ts', import.meta.url).href)) as StateModule;
const F = (await import(new URL('../web/src/ui/files.ts', import.meta.url).href)) as FilesModule;
const M = (await import(new URL('../web/src/ui/files-model.ts', import.meta.url).href)) as ModelModule;
const MOCK = (await import(new URL('../web/src/ui/files-mock.ts', import.meta.url).href)) as MockModule;

interface StateModule {
  state: {
    sessions: Map<string, SessionInfo>;
    projects: Project[];
    views: { id: string; sessions: string[]; focused: number }[];
    activeViewId: string;
    drawer: string | null;
    leftPanel: 'files' | null;
    filesWidth: number;
    history: unknown[];
  };
  FILES_W_MIN: number;
  FILES_W_MAX: number;
  FILES_W_DEFAULT: number;
  setSessions(list: SessionInfo[]): void;
  setProjects(list: Project[]): void;
  subscribe(fn: (kind: string) => void): void;
  toggleLeftPanel(p: 'files'): void;
  filesPanelVisible(): boolean;
}
interface FilesModule {
  initFilesPanel(host: unknown): { render(): void };
}
interface ModelModule {
  buildTree(files: readonly { path: string }[]): unknown[];
  treeRows(nodes: readonly unknown[], open: ReadonlySet<string>): { path: string; dir: boolean; busy: boolean }[];
}
interface MockModule {
  MOCK_FILES: { path: string; add?: number; del?: number; editing?: boolean }[];
  MOCK_OPEN_FOLDERS: string[];
  MOCK_COMMITS: { hash: string; message: string; author: string; when: string; add: number; del: number }[];
  MOCK_BRANCH: string;
}

const host = dom.doc.createElement('aside');
dom.body.append(host);
const panel = F.initFilesPanel(host);
const root = host.children[0] as FakeElement;

/** Everything `notify()` emitted since the last reset. */
const kinds: string[] = [];
st.subscribe((k) => {
  kinds.push(k);
});

function mkSession(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    title: id,
    command: 'claude',
    args: [],
    cwd: '/tmp',
    status: 'running',
    cols: 80,
    rows: 24,
    createdAt: new Date().toISOString(),
    attention: false,
    ...over,
  } as SessionInfo;
}

function project(id: string, name: string): Project {
  return { id, name, path: `/home/tester/${name}`, createdAt: new Date().toISOString() } as Project;
}

/** A live session in a project, with its own view — the panel's normal world. */
function liveSession(): void {
  st.setProjects([project('p1', 'api')]);
  st.setSessions([mkSession('s1', { projectId: 'p1' })]);
  st.state.leftPanel = 'files';
  kinds.length = 0;
  panel.render();
}

const grip = byClass(root, 'files-grip')[0] as FakeElement;
const body = byClass(root, 'files-body')[0] as FakeElement;
const summary = byClass(root, 'files-sum')[0] as FakeElement;

beforeEach(() => {
  dom.storage.clear();
  st.state.sessions = new Map();
  st.state.projects = [];
  st.state.views = [];
  st.state.activeViewId = '';
  st.state.drawer = null;
  st.state.history = [];
  st.state.leftPanel = 'files';
  st.state.filesWidth = st.FILES_W_DEFAULT;
  host.style.width = `${st.FILES_W_DEFAULT}px`;
  grip.setAttribute('aria-valuenow', String(st.FILES_W_DEFAULT));
  kinds.length = 0;
  dom.doc.activeElement = dom.body;
});

// ---------------------------------------------------------------------------
// The grip: drag, keyboard, commit
// ---------------------------------------------------------------------------

test('the grip is a real separator control: role, bounds, current value, keyboard-reachable', () => {
  assert.equal(grip.getAttribute('role'), 'separator');
  assert.equal(grip.getAttribute('aria-orientation'), 'vertical');
  assert.equal(grip.getAttribute('aria-valuemin'), '200');
  assert.equal(grip.getAttribute('aria-valuemax'), '520');
  assert.equal(grip.getAttribute('aria-valuenow'), '300');
  assert.equal(grip.tabIndex, 0, 'a control that only exists under a pointer is forbidden here');
  assert.equal(host.style.width, '300px', 'the panel is as wide as the state says at construction');
});

test('dragging the grip resizes live, and only the RELEASE commits the width', () => {
  dispatch(grip, 'pointerdown', { clientX: 100, pointerId: 7 });
  assert.ok(grip.hasPointerCapture(7), 'capture, so the pointer may leave the 6px strip');
  dispatch(grip, 'pointermove', { clientX: 150, pointerId: 7 });
  assert.equal(st.state.filesWidth, 350);
  assert.equal(host.style.width, '350px');
  assert.equal(grip.getAttribute('aria-valuenow'), '350');
  assert.deepEqual(kinds, [], 'a notify per pointermove would rebuild the chrome at 60Hz');

  dispatch(grip, 'pointerup', { clientX: 150, pointerId: 7 });
  assert.deepEqual(kinds, ['panel'], 'the release commits exactly once');
  assert.equal(grip.hasPointerCapture(7), false, 'and gives the pointer back');
  assert.equal(st.state.filesWidth, 350, 'the committed width is the dragged one');
});

test('a drag past either bound stops at the bound, it does not run away', () => {
  dispatch(grip, 'pointerdown', { clientX: 100, pointerId: 1 });
  dispatch(grip, 'pointermove', { clientX: 4000, pointerId: 1 });
  assert.equal(st.state.filesWidth, st.FILES_W_MAX);
  assert.equal(host.style.width, '520px');
  dispatch(grip, 'pointermove', { clientX: -4000, pointerId: 1 });
  assert.equal(st.state.filesWidth, st.FILES_W_MIN);
  assert.equal(host.style.width, '200px');
  dispatch(grip, 'pointerup', { clientX: -4000, pointerId: 1 });
});

test('a pointermove without a captured drag changes nothing (the grip is not a hover slider)', () => {
  dispatch(grip, 'pointermove', { clientX: 900, pointerId: 3 });
  assert.equal(st.state.filesWidth, 300);
  assert.equal(host.style.width, '300px');
  assert.deepEqual(kinds, []);

  // A non-primary button never starts one either.
  dispatch(grip, 'pointerdown', { clientX: 100, pointerId: 3, button: 2 });
  assert.equal(grip.hasPointerCapture(3), false);
  dispatch(grip, 'pointermove', { clientX: 900, pointerId: 3 });
  assert.equal(st.state.filesWidth, 300);
});

test('after the release the drag is over: a stray move is ignored', () => {
  dispatch(grip, 'pointerdown', { clientX: 100, pointerId: 2 });
  dispatch(grip, 'pointermove', { clientX: 120, pointerId: 2 });
  dispatch(grip, 'pointerup', { clientX: 120, pointerId: 2 });
  kinds.length = 0;
  dispatch(grip, 'pointermove', { clientX: 500, pointerId: 2 });
  assert.equal(st.state.filesWidth, 320, 'the width the user let go of');
  assert.deepEqual(kinds, []);
});

test('a cancelled pointer (the OS took it) ends the drag like a release', () => {
  dispatch(grip, 'pointerdown', { clientX: 100, pointerId: 5 });
  dispatch(grip, 'pointermove', { clientX: 140, pointerId: 5 });
  kinds.length = 0;
  dispatch(grip, 'pointercancel', { clientX: 140, pointerId: 5 });
  assert.equal(grip.hasPointerCapture(5), false);
  assert.deepEqual(kinds, ['panel']);
  assert.equal(st.state.filesWidth, 340);
});

test('the keyboard is the twin of the drag: arrows nudge 16px, Home resets, both commit', () => {
  dispatch(grip, 'keydown', { key: 'ArrowRight' });
  assert.equal(st.state.filesWidth, 316);
  assert.equal(host.style.width, '316px');
  dispatch(grip, 'keydown', { key: 'ArrowLeft' });
  dispatch(grip, 'keydown', { key: 'ArrowLeft' });
  assert.equal(st.state.filesWidth, 284);
  assert.deepEqual(kinds, ['panel', 'panel', 'panel'], 'every nudge is a committed width');

  const e = dispatch(grip, 'keydown', { key: 'Home' });
  assert.equal(st.state.filesWidth, st.FILES_W_DEFAULT);
  assert.equal(e.defaultPrevented, true, 'Home must not scroll the shell');

  const other = dispatch(grip, 'keydown', { key: 'PageUp' });
  assert.equal(other.defaultPrevented, false, 'keys the grip does not own are left alone');
});

test('Enter resets the width too, and the title promises exactly what the grip does', () => {
  // The pane dividers (ui/panes.ts) promise 'double-click or enter resets it.'
  // and implement Enter; this separator must not diverge from its own twin.
  st.state.filesWidth = 500;
  const e = dispatch(grip, 'keydown', { key: 'Enter' });
  assert.equal(st.state.filesWidth, st.FILES_W_DEFAULT);
  assert.equal(e.defaultPrevented, true);
  assert.match(grip.title, /home, enter or double-click/, `the title still hides a gesture: ${grip.title}`);
});

test('the keyboard cannot nudge past the bounds either', () => {
  st.state.filesWidth = st.FILES_W_MIN;
  for (let i = 0; i < 3; i += 1) dispatch(grip, 'keydown', { key: 'ArrowLeft' });
  assert.equal(st.state.filesWidth, st.FILES_W_MIN);
  st.state.filesWidth = st.FILES_W_MAX;
  for (let i = 0; i < 3; i += 1) dispatch(grip, 'keydown', { key: 'ArrowRight' });
  assert.equal(st.state.filesWidth, st.FILES_W_MAX);
});

test('double-clicking the grip resets the width', () => {
  st.state.filesWidth = 480;
  dispatch(grip, 'dblclick');
  assert.equal(st.state.filesWidth, st.FILES_W_DEFAULT);
  assert.equal(host.style.width, '300px');
  assert.deepEqual(kinds, ['panel']);
});

// ---------------------------------------------------------------------------
// What it renders
// ---------------------------------------------------------------------------

test('with no live session the panel renders nothing at all', () => {
  st.state.leftPanel = 'files';
  panel.render();
  assert.equal(st.filesPanelVisible(), false);
  assert.equal(body.children.length, 0, 'no tree is built for a session that does not exist');
});

test('a live session fills the panel: the summary the model computes, then the tree', () => {
  liveSession();
  assert.deepEqual(textsOf(root, 'files-num').slice(0, 2), ['+176', '-46']);
  assert.equal(textsOf(root, 'files-sum-text')[0], 'since last commit in 5 files');
  assert.equal(summary.hidden, false);

  const expected = M.treeRows(M.buildTree(MOCK.MOCK_FILES), new Set(MOCK.MOCK_OPEN_FOLDERS));
  const rows = byClass(root, 'files-row');
  assert.equal(rows.length, expected.length, 'one row per row the model produced');
  assert.ok(rows.length >= 10, 'non-vacuity: the tree really has rows');
  assert.deepEqual(
    rows.map((r) => r.textContent.replace(/^[▾▸]/, '').trim()),
    expected.map((r) => {
      const f = MOCK.MOCK_FILES.find((x) => x.path === r.path);
      const name = r.path.split('/').pop() as string;
      if (r.dir) return name;
      const badge = badgeLabel(name);
      const nums = (f?.add ?? 0) > 0 || (f?.del ?? 0) > 0 ? `+${f?.add ?? 0}-${f?.del ?? 0}` : '';
      return `${badge}${name}${nums}`;
    }),
    'every row prints its badge, its NAME (never a path) and its numbers',
  );
});

function badgeLabel(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const table: Record<string, string> = {
    ts: 'TS',
    tsx: 'TSX',
    js: 'JS',
    jsx: 'JSX',
    mjs: 'JS',
    md: 'MD',
    json: '{ }',
    ps1: 'PS',
  };
  return table[ext] ?? '·';
}

test('the header names the project of the focused session, and the session itself when it has none', () => {
  liveSession();
  assert.equal(textsOf(root, 'files-proj')[0], 'api');

  // A fresh world: the ACTIVE view deliberately keeps a dead pane (state.ts
  // reconcileViews skips it), so a bare setSessions would leave the header on
  // the session that is gone — which is the pane's own story, not the panel's.
  st.state.views = [];
  st.state.activeViewId = '';
  st.setSessions([mkSession('s2', { title: 'scratch shell', command: 'bash' })]);
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
  st.state.leftPanel = 'files';
  panel.render();
  assert.equal(textsOf(root, 'files-proj')[0], 'api', 'non-vacuity: it starts on the focused one');

  // `s1` ends; the ACTIVE view keeps its pane, `s2` is still running.
  st.setSessions([mkSession('s2', { title: 'notes' })]);
  st.state.views = [
    { id: 'v1', sessions: ['s1'], focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } },
  ] as never;
  st.state.activeViewId = 'v1';
  panel.render();
  assert.equal(st.filesPanelVisible(), true, 'non-vacuity: the panel is still up');
  assert.equal(textsOf(root, 'files-proj')[0], 'notes', 'the first session still alive');

  // The last rung. With nothing alive the chrome hides the panel entirely
  // (`filesPanelVisible()` is the same "is anything running" question), so it
  // cannot be reached through render() — it is the guard that keeps the header
  // from ever being empty, and it must stay a sentence rather than ''.
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'files.ts'), 'utf8');
  assert.match(src, /return 'No session';/);
  assert.equal(/return '';/.test(src), false, 'a blank header is never an answer');
});

test('the amber pulse is on the edited file and every folder above it, and nowhere else', () => {
  liveSession();
  const busy = byClass(root, 'files-row')
    .filter((r) => r.classList.contains('is-busy'))
    .map((r) => (r.textContent.replace(/^[▾▸]/, '') || '').trim());
  assert.deepEqual(busy, ['web', 'src', 'TSXPane.tsx+87-22'], 'the spine of the one edited file');
});

test('a folder row toggles its subtree; a file row is inert until the editor (A6)', () => {
  liveSession();
  const server = byKey(root, 'fdir:server') as FakeElement;
  assert.equal(server.tagName, 'BUTTON');
  assert.equal(server.getAttribute('aria-expanded'), 'true');
  const before = byClass(root, 'files-row').length;

  server.click();
  assert.equal((byKey(root, 'fdir:server') as FakeElement).getAttribute('aria-expanded'), 'false');
  assert.equal(byClass(root, 'files-row').length, before - 3, 'the three server/ files went with it');
  assert.equal(
    byClass(root, 'files-row').some((r) => r.textContent.includes('ws.ts')),
    false,
  );

  (byKey(root, 'fdir:server') as FakeElement).click();
  assert.equal(byClass(root, 'files-row').length, before, 'and come back');

  const file = byClass(root, 'files-row').find((r) => r.classList.contains('is-file')) as FakeElement;
  assert.equal(file.tagName, 'DIV', 'a dead button would be a lie to the keyboard');
});

test('every file row carries a colour-family badge, including the ones behind a closed folder', () => {
  liveSession();
  const badges = byClass(root, 'files-badge');
  assert.ok(badges.length > 0);
  for (const b of badges) assert.equal(b.getAttribute('aria-hidden'), 'true');
  const kindOf = new Map(badges.map((b) => [b.textContent, b.dataset.kind]));
  assert.equal(kindOf.get('TSX'), 'ts');
  assert.equal(kindOf.get('TS'), 'ts', 'one family, two marks');
  assert.equal(kindOf.get('MD'), 'md');
  assert.equal(kindOf.get('{ }'), 'json');
  assert.equal(
    kindOf.get('·'),
    'plain',
    'the neutral chip is on screen too: the mock carries a file whose type the table does not know',
  );

  // The families that only appear once a closed folder is opened.
  (byKey(root, 'fdir:launcher') as FakeElement).click();
  const opened = new Map(byClass(root, 'files-badge').map((b) => [b.textContent, b.dataset.kind]));
  assert.equal(opened.get('PS'), 'ps');
  assert.equal(opened.get('JS'), 'js', 'a .mjs is JavaScript, not an unknown type');
});

test('the caret is decoration: aria-hidden, and the folder row itself states the state', () => {
  liveSession();
  for (const c of byClass(root, 'files-caret')) assert.equal(c.getAttribute('aria-hidden'), 'true');
  const web = byKey(root, 'fdir:web') as FakeElement;
  assert.equal(web.children[0]?.textContent, '▾');
  assert.equal(web.getAttribute('aria-expanded'), 'true');
});

test('both tabs say, quietly and first, that what is under them is not the real repository', () => {
  // The panel carries the user's REAL project name over `ui/files-mock.ts`
  // content. Until B2/B3 read the repository, one plain line per tab keeps
  // that from reading as a report about their files.
  liveSession();
  assert.deepEqual(textsOf(root, 'files-note'), [
    'Example data until the panel reads your project.',
  ]);
  assert.equal(
    (body.children[0] as FakeElement).classList.contains('files-note'),
    true,
    'first thing in the body',
  );

  (byKey(root, 'ftab:commits') as FakeElement).click();
  assert.deepEqual(textsOf(root, 'files-note'), [
    'Example data until the panel reads your commits.',
  ]);
  assert.equal((body.children[0] as FakeElement).classList.contains('files-note'), true);

  // ONE render site, so B2/B3 remove it by deleting one function and one
  // argument — not by hunting two branches.
  const src = readFileSync(join(here, '..', 'web', 'src', 'ui', 'files.ts'), 'utf8');
  assert.equal(src.split('placeholderNote(').length - 1, 2, 'one definition, one call site');

  (byKey(root, 'ftab:files') as FakeElement).click(); // the tab is panel-local state
});

test('the Commits tab swaps the body and hides the summary; both tabs say which is up', () => {
  liveSession();
  const files = byKey(root, 'ftab:files') as FakeElement;
  const commits = byKey(root, 'ftab:commits') as FakeElement;
  assert.equal(files.getAttribute('aria-pressed'), 'true');
  assert.equal(commits.getAttribute('aria-pressed'), 'false');

  commits.click();
  assert.equal(commits.getAttribute('aria-pressed'), 'true');
  assert.equal(files.getAttribute('aria-pressed'), 'false');
  assert.equal(summary.hidden, true, 'a file summary over a commit list would be a lie');
  assert.equal(byClass(root, 'files-row').length, 0);
  assert.equal(textsOf(root, 'files-branch')[0], 'main, 5 commits');

  const rows = byClass(root, 'commit-row');
  assert.equal(rows.length, MOCK.MOCK_COMMITS.length);
  const first = MOCK.MOCK_COMMITS[0] as MockModule['MOCK_COMMITS'][number];
  assert.equal(textsOf(root, 'commit-msg')[0], first.message);
  assert.equal(textsOf(root, 'commit-hash')[0], first.hash);
  assert.ok(rows[0]?.textContent.includes(first.when));
  assert.ok(rows[0]?.textContent.includes(`+${first.add}`));
  assert.equal(
    descendants(rows[0] as FakeElement).some((n) => n.tagName === 'BUTTON'),
    false,
    'A5 commit rows are inert: the commit view is A6',
  );

  files.click();
  assert.equal(summary.hidden, false);
  assert.ok(byClass(root, 'files-row').length > 0, 'and the tree comes back');
});

test('a rebuild keeps the keyboard where it was (folder rows are re-created wholesale)', () => {
  liveSession();
  const server = byKey(root, 'fdir:server') as FakeElement;
  server.focus();
  server.click();
  const after = byKey(root, 'fdir:server') as FakeElement;
  assert.notEqual(after, server, 'non-vacuity: the row really was rebuilt');
  assert.equal(dom.doc.activeElement, after, 'focus follows the same control, not the panel edge');
});

// ---------------------------------------------------------------------------
// The shell wiring (web/src/main.ts), read from the source
// ---------------------------------------------------------------------------

const MAIN = readFileSync(join(here, '..', 'web', 'src', 'main.ts'), 'utf8');

test('main.ts constructs the panel — on the aside it just created', () => {
  assert.ok(MAIN.includes('function buildShell'), 'non-vacuity: main.ts still builds the shell');
  assert.match(MAIN, /import \{ initFilesPanel \} from '\.\/ui\/files\.ts';/);
  assert.match(
    MAIN,
    /const filesPanel = initFilesPanel\(filesAside\);/,
    'the panel must be initialised with the files aside, or nothing is ever built',
  );
});

test('main.ts renders the panel on every state change AND once at boot', () => {
  const sub = MAIN.slice(MAIN.indexOf('st.subscribe('));
  assert.ok(sub.length > 200, 'non-vacuity: the subscribe block was found');
  const block = sub.slice(0, sub.indexOf('// ---- global keyboard'));
  const calls = block.split('filesPanel.render();').length - 1;
  assert.equal(calls, 2, 'once inside subscribe, once for the first paint');
});

test('the Files aside is a flex sibling BEFORE the grid — that is what resizes the panes', () => {
  assert.match(MAIN, /main\.append\(projAside, filesAside, grid, sessAside\);/);
});

test('the Files button is a live toggle, not the disabled placeholder A2 shipped', () => {
  assert.match(MAIN, /button\('tb-btn', 'Files', \(\) => st\.toggleLeftPanel\('files'\)\)/);
  assert.equal(
    /filesBtn\.disabled = true/.test(MAIN),
    false,
    'A5 turned the placeholder into a real control',
  );
});

test('the chrome hides the panel through filesPanelVisible(), never through the wish alone', () => {
  assert.match(MAIN, /const filesShown = st\.filesPanelVisible\(\);/);
  assert.match(MAIN, /filesAside\.hidden = !filesShown;/);
  // `aria-pressed` states what is ON SCREEN; only the CSS class carries the
  // wish. Announcing an open panel while nothing is rendered is a lie to a
  // screen reader, and the wish is true by default from the first paint.
  assert.match(MAIN, /filesBtn\.setAttribute\('aria-pressed', filesShown \? 'true' : 'false'\);/);
  assert.match(MAIN, /filesBtn\.classList\.toggle\('is-on', filesOn\);/);
});

test('Escape closes the panel only when the focus is inside it', () => {
  const from = MAIN.indexOf("e.key === 'Escape'");
  assert.notEqual(from, -1, 'non-vacuity: the Escape branch was found');
  const branch = MAIN.slice(from, MAIN.indexOf('// ---- reliability'));
  assert.ok(branch.length > 200 && branch.length < 3000, 'non-vacuity: and it is the handler, not the file');
  assert.match(branch, /filesAside\.contains\(document\.activeElement\)/);
  assert.match(branch, /st\.toggleLeftPanel\('files'\)/);
});

test('Escape hands the keyboard back to the terminal, in BOTH branches that close a surface', () => {
  // The surface that held the focus disappears; without this the focus falls
  // to <body> and typing goes nowhere until the next window activation (the
  // same fix ui-restart-guards.test.ts pins for the restart dialog).
  assert.match(MAIN, /import \{[^}]*requestTerminalFocus[^}]*\} from '\.\/ui\/panes\.ts';/s);
  const from = MAIN.indexOf("e.key === 'Escape'");
  const branch = MAIN.slice(from, MAIN.indexOf('// ---- reliability'));
  const arms = branch.split('} else if');
  const drawerArm = arms.find((a) => a.includes('st.closeDrawer();'));
  const filesArm = arms.find((a) => a.includes("st.toggleLeftPanel('files');"));
  assert.ok(drawerArm !== undefined && filesArm !== undefined, 'non-vacuity: both arms were found');
  assert.match(drawerArm, /st\.closeDrawer\(\);[\s\S]*requestTerminalFocus\(\);/);
  assert.match(filesArm, /st\.toggleLeftPanel\('files'\);[\s\S]*requestTerminalFocus\(\);/);
});

// ---------------------------------------------------------------------------
// The other half of a badge: its colour pair has to exist
// ---------------------------------------------------------------------------

test('every colour family the model can emit is defined in tokens.css and mapped in app.css', () => {
  // `badgeFor()` only NAMES a family; `--badge-<kind>-bg/fg` and the
  // `[data-kind]` rule are what make the chip visible. A kind added or renamed
  // on one side only renders an unstyled chip, which no DOM test can see.
  const model = readFileSync(join(here, '..', 'web', 'src', 'ui', 'files-model.ts'), 'utf8');
  const tokens = readFileSync(join(here, '..', 'web', 'src', 'styles', 'tokens.css'), 'utf8');
  const app = readFileSync(join(here, '..', 'web', 'src', 'styles', 'app.css'), 'utf8');
  const kinds = new Set(Array.from(model.matchAll(/kind: '([a-z]+)'/g), (m) => m[1] as string));
  assert.ok(kinds.size >= 13, `non-vacuity: found ${kinds.size} families in files-model.ts`);
  assert.ok(kinds.has('plain'), 'the fallback family is one of them');

  const missing: string[] = [];
  for (const k of kinds) {
    if (!tokens.includes(`--badge-${k}-bg:`)) missing.push(`tokens.css --badge-${k}-bg`);
    if (!tokens.includes(`--badge-${k}-fg:`)) missing.push(`tokens.css --badge-${k}-fg`);
    // `plain` is the base rule's own colour, so it needs no data-kind selector.
    if (k !== 'plain' && !app.includes(`.files-badge[data-kind='${k}']`)) {
      missing.push(`app.css .files-badge[data-kind='${k}']`);
    }
  }
  assert.deepEqual(missing, [], 'a badge family with no colours is an invisible mark');
  assert.match(app, /\.files-badge \{[^}]*background: var\(--badge-plain-bg\)/s, 'the base chip IS plain');
});
