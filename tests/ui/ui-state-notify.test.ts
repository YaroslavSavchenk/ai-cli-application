/**
 * `web/src/state.ts` — which change notifies which kind: every tab and pane
 * mutator notifies `ui`, the conn-state setters feeding the R2
 * statusline/topbar dot notify `conn`, and the session-history setters
 * (`GET /api/history` -> drawer) notify `sessions`. Split out of
 * `ui-state.test.ts`.
 *
 * Seam: the real module, imported once per file by
 * `tests/helpers/ui-state-fixture.ts` after an in-memory `localStorage` shim
 * (`state.ts` is DOM-free except for the Web Storage global, which plain
 * `node --test` does not provide), so `loadUi`/`saveUi` exercise the real
 * persistence code paths; the module singleton is reset before every test.
 *
 * Why it matters: a mutator that notifies the wrong kind is never redrawn
 * (`ui/panes.ts` ignores `screen` on purpose).
 *
 * NOT claimed: how the panes render the arrangement in a browser
 * (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkHistoryEntry as mkHistory } from '../helpers/helpers.ts';
import {
  REOPEN,
  REPO,
  collectKinds,
  ftab,
  home,
  resetState,
  st,
} from '../helpers/ui-state-fixture.ts';

before(() => {
  resetState();
});

beforeEach(() => {
  resetState();
});

// ---------------------------------------------------------------------------
// Conn-state setters (R2 statusline/topbar dot) notify 'conn'
// ---------------------------------------------------------------------------

test("every tab and pane mutator notifies 'ui' — an editor pane is a PANE", () => {
  // Not 'screen': that kind means "something OTHER than the panes fills the
  // pane area" (the commit view), and `ui/panes.ts` ignores it on purpose. A
  // file pane that announced itself with 'screen' would never be drawn.
  st.initServer([], []);
  st.loadUi(REOPEN);
  const { kinds } = collectKinds();
  const only = (fn: () => void): string[] => {
    kinds.length = 0;
    fn();
    return [...new Set(kinds)];
  };

  const h = () => home().id;
  assert.deepEqual(only(() => st.openFile({ kind: 'home' }, 'a.ts', 'a.ts')), ['ui']);
  assert.deepEqual(only(() => st.openFile({ kind: 'home' }, 'b.ts', 'b.ts')), ['ui'], 'a tab add');
  assert.deepEqual(only(() => st.openDiff({ kind: 'home' }, '474d891', 'a.ts', REPO)), ['ui']);
  assert.deepEqual(only(() => st.setActiveTab(h(), 0, 0)), ['ui']);
  assert.deepEqual(only(() => st.cycleTab(1)), ['ui']);
  assert.deepEqual(only(() => st.openTabAt(h(), 0, 'left', ftab('c.ts'))), ['ui']);
  assert.deepEqual(only(() => st.moveTab(h(), 1, 0, 0)), ['ui']);
  assert.deepEqual(only(() => st.moveTabToSplit(h(), 0, 0, 0, 'top')), ['ui']);
  assert.deepEqual(only(() => st.movePane('right')), ['ui']);
  assert.deepEqual(only(() => st.closeTab(h(), 0, 0)), ['ui']);
  assert.deepEqual(only(() => st.closeSlot(h(), 0)), ['ui']);
  assert.deepEqual(only(() => st.openFile({ kind: 'project', id: 'p1' }, 'c.ts', 'c.ts')), ['ui']);
  // A rejection is silent: nothing changed, so nothing re-renders.
  assert.deepEqual(only(() => st.openTabAt('nope', 0, 'left', ftab('d.ts'))), []);
  assert.deepEqual(only(() => st.moveTab('nope', 0, 0, 1)), []);
  assert.deepEqual(only(() => st.moveTabToSplit('nope', 0, 0, 1, 'left')), []);
  assert.deepEqual(only(() => st.closeTab('nope', 0, 0)), []);
  assert.deepEqual(only(() => st.closeSlot('nope', 0)), []);
  assert.deepEqual(only(() => st.cycleTab(1)), [], 'and so is a chord with no editor pane up');
});

test("saveEdit notifies 'ui' (the dot it clears lives on a pane header) and a clean file is silent", () => {
  st.initServer([], []);
  st.loadUi(REOPEN);
  const { kinds } = collectKinds();
  const id = st.editorFileId('a.ts');

  st.setEdit(id, 'typed');
  assert.deepEqual(kinds, [], 'a keystroke never notifies — it would take the caret with it');
  assert.equal(st.editorDirty(id), true);
  assert.equal(st.editText(id), 'typed');

  assert.equal(st.saveEdit(id), 'typed', 'the caller writes it where it belongs');
  assert.deepEqual(kinds, ['ui']);
  assert.equal(st.editorDirty(id), false);
  assert.equal(st.saveEdit(id), null);
  assert.deepEqual(kinds, ['ui'], 'saving a clean file changes nothing');
});

test('setWsLatency: notifies conn on change, is a no-op on the same value, notifies again on null', () => {
  const { kinds } = collectKinds();
  st.setWsLatency(42);
  assert.equal(st.state.wsLatencyMs, 42);
  assert.deepEqual(kinds, ['conn']);

  st.setWsLatency(42); // unchanged
  assert.deepEqual(kinds, ['conn'], 'setting the same latency again must not renotify');

  st.setWsLatency(null); // presence socket lost
  assert.equal(st.state.wsLatencyMs, null);
  assert.deepEqual(kinds, ['conn', 'conn']);
});

test('setRuntime: notifies conn on change, is a no-op when the answer repeats', () => {
  // The ONE runtime setter (a dedicated setServerStartedAt existed and was
  // dead: main.ts has always fed the whole /api/runtime answer through here).
  const { kinds } = collectKinds();
  const iso = new Date().toISOString();
  const answer = {
    startedAt: iso,
    serverCommit: 'a1b2c3d',
    // Installed-mode fields (2026-09-08): a developer clone answers null/false.
    version: null,
    installed: false,
    webBuild: 'assets/index-Br1e6z0Q.js',
    update: { available: false, reason: null },
  };
  st.setRuntime(answer);
  assert.equal(st.state.serverStartedAt, iso);
  assert.equal(st.state.serverCommit, 'a1b2c3d');
  assert.deepEqual(kinds, ['conn']);

  st.setRuntime(answer);
  assert.deepEqual(kinds, ['conn'], 'the same runtime answer again must not renotify');

  st.setRuntime({ ...answer, update: { available: true, reason: 'frontend rebuilt' } });
  assert.deepEqual(st.state.update, { available: true, reason: 'frontend rebuilt' });
  assert.deepEqual(kinds, ['conn', 'conn'], 'a new update verdict is a change');
});

test('setRuntime: an INSTALLED backend carries its version and flag beside the commit', () => {
  // Installer phase C (2026-09-08). The panel's `version` fact and the
  // `Check for updates` link both read these two; a poll that dropped them
  // would silently turn an installed app back into a developer clone on screen.
  const { kinds } = collectKinds();
  const iso = new Date().toISOString();
  const installed = {
    startedAt: iso,
    // A packaged tree has no git checkout to read a hash from.
    serverCommit: null,
    version: 'v0.2.0',
    installed: true,
    webBuild: 'assets/index-Br1e6z0Q.js',
    update: { available: false, reason: null },
  };
  st.setRuntime(installed);
  assert.equal(st.state.version, 'v0.2.0');
  assert.equal(st.state.installed, true);
  assert.equal(st.state.serverCommit, null);
  assert.deepEqual(kinds, ['conn']);

  st.setRuntime(installed);
  assert.deepEqual(kinds, ['conn'], 'the same installed answer again must not renotify');

  // A newer bundle taking the port is a change even when nothing else moved.
  st.setRuntime({ ...installed, version: 'v0.3.0' });
  assert.equal(st.state.version, 'v0.3.0');
  assert.deepEqual(kinds, ['conn', 'conn'], 'a new bundle version is a change');

  // …and so is the mode itself flipping, which is what a handover to a
  // developer clone on the same port would look like.
  st.setRuntime({ ...installed, version: null, installed: false, serverCommit: 'a1b2c3d' });
  assert.equal(st.state.installed, false);
  assert.equal(st.state.version, null, 'a clone must not keep the previous run’s version');
  assert.equal(st.state.serverCommit, 'a1b2c3d');
  assert.deepEqual(kinds, ['conn', 'conn', 'conn']);
});

test('setBackendReachable: notifies conn on toggle, is a no-op when unchanged', () => {
  const { kinds } = collectKinds();
  assert.equal(st.state.backendReachable, true, 'precondition: defaults reachable');

  st.setBackendReachable(true); // unchanged
  assert.deepEqual(kinds, []);

  st.setBackendReachable(false);
  assert.equal(st.state.backendReachable, false);
  assert.deepEqual(kinds, ['conn']);

  st.setBackendReachable(false); // unchanged
  assert.deepEqual(kinds, ['conn']);

  st.setBackendReachable(true);
  assert.deepEqual(kinds, ['conn', 'conn']);
});

// ---------------------------------------------------------------------------
// Session-history setters (GET /api/history -> drawer) notify 'sessions'
// ---------------------------------------------------------------------------

test('setHistory: replaces the list and notifies sessions every time (a refetch always publishes)', () => {
  const { kinds } = collectKinds();
  st.setHistory([mkHistory('a'), mkHistory('b')]);
  assert.deepEqual(st.state.history.map((h) => h.id), ['a', 'b']);
  assert.deepEqual(kinds, ['sessions']);

  // Even an identical-looking refetch republishes: the drawer re-renders from
  // whatever the server just said, and history.ts debounces the fetches.
  st.setHistory([mkHistory('a'), mkHistory('b')]);
  assert.deepEqual(kinds, ['sessions', 'sessions']);
});

test('removeHistory: drops the matching entry and notifies; an unknown id changes nothing and stays silent', () => {
  st.setHistory([mkHistory('a'), mkHistory('b')]);
  const { kinds } = collectKinds();

  st.removeHistory('no-such-entry');
  assert.deepEqual(st.state.history.map((h) => h.id), ['a', 'b']);
  assert.deepEqual(kinds, [], 'a miss must not renotify');

  st.removeHistory('a');
  assert.deepEqual(st.state.history.map((h) => h.id), ['b']);
  assert.deepEqual(kinds, ['sessions']);

  // The entry KEY is what is matched, never the session id it last ran under.
  st.removeHistory('s-b');
  assert.deepEqual(st.state.history.map((h) => h.id), ['b'], 'sessionId is not the key');
  assert.deepEqual(kinds, ['sessions']);
});

test('clearHistory: empties the list once and is silent when there is nothing to clear', () => {
  st.setHistory([mkHistory('a')]);
  const { kinds } = collectKinds();

  st.clearHistory();
  assert.deepEqual(st.state.history, []);
  assert.deepEqual(kinds, ['sessions']);

  st.clearHistory();
  assert.deepEqual(kinds, ['sessions'], 'clearing an empty list must not renotify');
});

test('projectName resolves to the NAME — never the path, never the id', () => {
  // The copy rule (PROJECT-SCOPE, 2026-07-25) says the raw path appears only in
  // the manage-projects view. Every other surface asks this function, including
  // the restart confirmation's list of sessions about to be closed, so a path
  // leaking out of here would leak into that dialog.
  st.setProjects([
    {
      id: 'p1',
      name: 'Session Manager',
      path: '/home/you/projects/ai-cli-application',
      createdAt: '2026-09-06T12:00:00.000Z',
    },
    {
      id: 'p2',
      name: 'notes',
      path: '/home/you/projects/acme/notes',
      createdAt: '2026-09-06T12:00:00.000Z',
    },
  ]);

  assert.equal(st.projectName('p1'), 'Session Manager');
  assert.equal(st.projectName('p2'), 'notes');
  for (const id of ['p1', 'p2']) {
    const label = st.projectName(id) as string;
    assert.ok(!label.includes('/'), `no path separator in "${label}"`);
    assert.notEqual(label, id, 'and it is not the raw id either');
  }
  assert.equal(st.projectName('gone'), null, 'an unknown id is null, never a fabricated label');
  assert.equal(st.projectName(undefined), null, 'a session with no project is null');
  st.setProjects([]);
});
