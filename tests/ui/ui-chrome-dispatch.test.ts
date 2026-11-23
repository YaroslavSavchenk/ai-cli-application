/**
 * `web/src/ui/chrome-dispatch-model.ts` — which of the shell's six chrome
 * renderers a change notification reaches (Quality Q12,
 * `.claude/plans/PLAN-QUALITY.md`). `web/src/main-shell.ts` used to run all
 * six on every `notify`; it now runs only the ones whose kinds are listed.
 *
 * How: the REAL state module (`helpers/ui-state-fixture.ts`) — every setter
 * that changes something a renderer reads is called, the kinds it notifies are
 * collected, and at least one of them must reach that renderer. One table per
 * renderer, so a new read without its kind fails under that renderer's name.
 * The statusline is also driven end to end on the DOM double through the
 * dispatch, the way main-shell.ts wires it.
 *
 * Why it matters: a kind missing from a renderer's list is a readout that
 * silently stops updating — a tab that keeps a dead session's name, a badge
 * that never clears. Nothing crashes.
 *
 * NOT claimed: main-shell.ts's own wiring of the table (a source read in
 * `tests/ui/ui-files-panel-shell.test.ts`), and the panes, which subscribe on
 * their own (`ui/panes.ts`).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ChangeKind } from '../../web/src/state.ts';
import { byClass, installDom, type FakeElement } from '../helpers/fake-dom.ts';
import { mkHistoryEntry, mkRuntime } from '../helpers/helpers.ts';
import { sessionInfo } from '../helpers/session-info.ts';
import { REOPEN, ftab, memoryStorage, resetState, st } from '../helpers/ui-state-fixture.ts';
import {
  RENDERS_ON,
  renderersFor,
  type ChromeRenderer,
} from '../../web/src/ui/chrome-dispatch-model.ts';

const dom = installDom();
// The double brings its own storage; `resetState()` clears the fixture's, so
// the store must read and write that one (a tab saved by one test would
// otherwise come back in the next).
(globalThis as unknown as { localStorage: typeof memoryStorage }).localStorage = memoryStorage;
const bar = await import('../../web/src/ui/statusline.ts');

const PROJECT = { id: 'p1', name: 'api', path: '/home/you/projects/api', createdAt: '2026-09-22T10:00:00.000Z' };

/** Every kind notified since the last `kindsOf`, typed as the dispatch reads it. */
const kinds: ChangeKind[] = [];
st.subscribe((k) => {
  kinds.push(k);
});

/** The kinds `fn` notified, each once. */
function kindsOf(fn: () => void): ChangeKind[] {
  kinds.length = 0;
  fn();
  return [...new Set(kinds)];
}

/** A booted store: Home, one project, two running sessions in their own tabs. */
function boot(): void {
  resetState();
  st.initServer([PROJECT], []);
  st.loadUi(REOPEN);
  st.setSessions([sessionInfo({ id: 's1', projectId: 'p1' }), sessionInfo({ id: 's2' })]);
  st.closeCommitView();
}

beforeEach(boot);

type Row = [what: string, change: () => void];


/** Bring up a tab that is not the active one. */
function activateAnother(): void {
  const other = st.state.views.find((v) => v.id !== st.state.activeViewId);
  assert.ok(other !== undefined, 'precondition: a second tab exists');
  st.setActiveView(other.id);
}

/** Every change in `rows` notifies at least one kind that reaches `renderer`. */
function assertReaches(renderer: ChromeRenderer, rows: Row[]): void {
  for (const [what, change] of rows) {
    boot();
    const got = kindsOf(change);
    assert.ok(got.length > 0, `${renderer}: "${what}" notified nothing — the row tests nothing`);
    assert.ok(
      got.some((k) => renderersFor(k).includes(renderer)),
      `${renderer}: "${what}" notifies ${got.join('+')}, and none of it reaches the renderer`,
    );
  }
}

const sessionRows: Row[] = [
  ['a session appears', () => st.setSessions([...st.state.sessions.values(), sessionInfo({ id: 's3' })])],
  ['a session is renamed by the poll', () => st.setSessions([sessionInfo({ id: 's1', title: 'renamed' }), sessionInfo({ id: 's2' })])],
  ['a BEL arrives', () => st.setAttention('s1', true)],
  ['a session exits', () => st.markExited('s1', 0)],
  ['a session is ended', () => st.removeSessionEverywhere('s2')],
];

test('the order is the order the six always ran in, and no renderer is listed twice', () => {
  assert.deepEqual(
    RENDERS_ON.map(([r]) => r),
    ['chrome', 'tabs', 'status', 'sessionsDrawer', 'projectsDrawer', 'filesPanel'],
  );
  assert.deepEqual(renderersFor('sessions'), ['chrome', 'tabs', 'status', 'sessionsDrawer', 'projectsDrawer', 'filesPanel']);
});

test('the latency pong and the commit view reach only what reads them', () => {
  // The two kinds that fire most without touching the strip, the drawers or
  // the tree: `conn` on every 5 s pong whose round trip moved, `screen` on
  // every commit-view toggle.
  assert.deepEqual(renderersFor('conn'), ['chrome', 'status']);
  assert.deepEqual(renderersFor('screen'), ['filesPanel']);
});

test('updateChrome hears the attention count, the drawers, the Files toggle and the connection', () => {
  assertReaches('chrome', [
    ...sessionRows,
    ['the seen ack', () => {
      st.setAttention('s1', true);
      st.markSeenLocally('s1');
    }],
    ['the Sessions drawer opens', () => st.openDrawer('sessions')],
    ['the Projects drawer toggles', () => st.toggleDrawer('projects')],
    ['the Files panel toggles', () => st.toggleLeftPanel('files')],
    ['the backend goes away', () => st.setBackendReachable(false)],
  ]);
});

test('the tab strip hears the views, the sessions in them and the project names', () => {
  assertReaches('tabs', [
    ...sessionRows,
    ['another tab is activated', activateAnother],
    ['a file opens as a tab', () => st.openFile({ kind: 'home' }, '/home/you/a.ts', 'a.ts')],
    ['a project is renamed', () => st.setProjects([{ ...PROJECT, name: 'web' }])],
  ]);
});

test('the statusline hears the sessions, the active tab, the latency and the uptime', () => {
  assertReaches('status', [
    ...sessionRows,
    ['another tab is activated', activateAnother],
    ['a pane is added beside a session', () => st.openTabAt(st.state.views[1]?.id ?? '', 0, 'right', ftab('/home/you/b.ts'))],
    ['the pong measures a new round trip', () => st.setWsLatency(42)],
    ['the backend restarted', () => st.setRuntime(mkRuntime('2026-09-22T11:00:00.000Z'))],
  ]);
});

test('the Sessions drawer hears its toggle, the sessions, the history and the project names', () => {
  assertReaches('sessionsDrawer', [
    ...sessionRows,
    ['it opens', () => st.openDrawer('sessions')],
    ['it closes', () => {
      st.openDrawer('sessions');
      st.closeDrawer();
    }],
    ['the history arrives', () => st.setHistory([mkHistoryEntry('h1')])],
    ['a project is renamed', () => st.setProjects([{ ...PROJECT, name: 'web' }])],
  ]);
});

test('the Projects drawer hears its toggle, the projects and the running count', () => {
  assertReaches('projectsDrawer', [
    ...sessionRows,
    ['it opens', () => st.openDrawer('projects')],
    ['a project is added', () => st.setProjects([PROJECT, { ...PROJECT, id: 'p2', name: 'web' }])],
  ]);
});

test('the Files panel hears its visibility, its root, the open commit and the files open as tabs', () => {
  assertReaches('filesPanel', [
    ...sessionRows,
    ['the Files toggle', () => st.toggleLeftPanel('files')],
    ['the Projects drawer borrows the left column', () => st.openDrawer('projects')],
    ['the panel is dragged wider', () => st.setFilesWidth(st.state.filesWidth + 40, true)],
    ['the focus moves to another tab', activateAnother],
    ['a session is focused', () => st.focusSession('s2')],
    ['a project is removed', () => st.setProjects([])],
    ['a file opens as a tab', () => st.openFile({ kind: 'home' }, '/home/you/a.ts', 'a.ts')],
    ['a commit opens', () => st.openCommitView('a'.repeat(40), { root: '/home/you/projects/api', repoRoot: null })],
  ]);
});

// ---------------------------------------------------------------------------
// The statusline, end to end through the dispatch
// ---------------------------------------------------------------------------

const root = dom.doc.createElement('div') as unknown as FakeElement;
bar.initStatusline(root as unknown as HTMLElement, { openShortcuts: () => {} });
st.subscribe((kind) => {
  if (renderersFor(kind).includes('status')) bar.render();
});
const segs = (): string[] => byClass(root, 'status-seg').map((n) => n.textContent);

test('through the dispatch, the statusline shows a new latency, a new session and a new pane', () => {
  bar.render();
  st.setWsLatency(17);
  assert.ok(segs().includes('Latency 17 ms'), segs().join(' / '));
  st.setSessions([...st.state.sessions.values(), sessionInfo({ id: 's3' })]);
  assert.ok(segs().includes('3 sessions'), segs().join(' / '));
  st.setActiveViewIndex(0);
  assert.ok(segs().includes('0 panes'), `Home is up, and empty: ${segs().join(' / ')}`);
  st.setActiveViewIndex(1);
  assert.ok(segs().includes('1 pane'), `the first session's tab: ${segs().join(' / ')}`);
  st.openTabAt(st.state.activeViewId, 0, 'right', ftab('/home/you/b.ts'));
  assert.ok(segs().includes('2 panes'), `a file pane beside it: ${segs().join(' / ')}`);
});
