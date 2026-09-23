/**
 * `web/src/ui/settings.ts` — the Settings panel's Status bar page (Nocturne
 * A7): the live checklist, its preview strip, the `statusLine` prefs write,
 * the pane repaint on every toggle, and the notice that names the running
 * sessions that cannot grow a status line; plus the A7 gate's late-answer
 * cases (a slow `getPrefs()` re-read, an answer after close). Split out of
 * `ui-settings-panel.test.ts`.
 *
 * Seam: the REAL module against the DOM double in `tests/helpers/fake-dom.ts`,
 * booted once per file by `tests/helpers/ui-settings-panel-fixture.ts` (the real
 * `ui/util.ts`, `ui/launch-args.ts`, `ui/statusline-model.ts`,
 * `ui/term-colours.ts` and `ui/term-colours-model.ts` take part; only the
 * non-pure imports are stubbed — see the fixture). Tests in one file share the
 * one panel and run in order.
 *
 * Why it matters: a toggle that stops writing `statusLine`, a preview that
 * disagrees with the rows, or a late re-read that undoes the user's toggle all
 * look fine on screen until the next session starts.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, colour rendering, that a native colour swatch opens a picker,
 * hit-testing, screen-reader output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionInfo } from '../../shared/protocol.ts';
import { byClass, textsOf, type FakeElement } from '../helpers/fake-dom.ts';
import {
  H,
  panel,
  panelOf,
  reopen,
  repaintHook,
  row,
  settle,
  statusPatch,
} from '../helpers/ui-settings-panel-fixture.ts';

// `repaints` counts `ui/panes.ts` repaintStatus calls — counted so the pane
// bar's live refresh is pinned here rather than left to a browser check.
// reopen() zeroes it through the fixture's hook.
let repaints = 0;
repaintHook.bump = (): void => {
  repaints += 1;
};
repaintHook.reset = (): void => {
  repaints = 0;
};

// ===========================================================================
// Status bar — the live checklist
// ===========================================================================

test('the Status bar page renders the three switches, the eight items and their captions', async () => {
  await reopen();
  const page = panelOf('status');
  assert.equal(byClass(page, 'sg-title')[0]?.textContent, 'Status bar');
  assert.equal(
    byClass(page, 'sg-lead')[0]?.textContent,
    'Choose what each session shows under its terminal. Saved on this computer.',
  );
  const labels = byClass(page, 'sg-rows')
    .flatMap((g) => byClass(g, 'sg-rowlb'))
    .map((n) => n.textContent);
  assert.deepEqual(labels, [
    // Nocturne B1: the two PLACES a status bar can be, then the items they share.
    'Inside the terminal',
    'Under the terminal',
    // Nocturne B11: the Background agents table, its own switch beside the bar.
    'Background agents under the terminal',
    'Model',
    'Permission mode',
    'Git branch',
    'Cost so far',
    'Session time',
    'Lines changed',
    'Context used',
    'Account usage',
  ]);
  assert.deepEqual(textsOf(page, 'sg-cap'), [
    'Claude Code’s own line, drawn at the bottom of the terminal',
    'the app’s bar below the terminal',
    'the agents a session runs, also listed by Claude Code itself',
    'shows the mode the session was started with',
    'under the terminal only',
    'works with a Claude Pro or Max account, and appears after the session’s first reply',
  ]);
  // The sample beside a row IS the text the status line draws.
  assert.equal(byClass(row(page, 'Model'), 'sg-val')[0]?.textContent, 'opus');
  assert.equal(byClass(row(page, 'Session time'), 'sg-val')[0]?.textContent, '2h 15m');
});

test('the lead under the preview names the both-on consequence', async () => {
  await reopen();
  const leads = textsOf(panelOf('status'), 'sg-lead');
  assert.equal(
    leads[1],
    'A session shows nothing until its first reply, and when Claude asks you to trust a folder it has not worked in before the line stays blank until you do. With both on, the same values show twice.',
  );
});

test('the preview strip shows the enabled items, and says so when there are none', async () => {
  await reopen();
  const page = panelOf('status');
  const bar = byClass(page, 'sg-prevbar')[0] as FakeElement;
  // Claude's line is off by factory default (2026-09-17): the preview opens
  // on its empty state and fills once that switch is on.
  assert.equal(byClass(bar, 'sg-prevempty')[0]?.textContent, 'Nothing selected, the bar is hidden');
  row(page, 'Inside the terminal').click();
  assert.equal(statusPatch().enabled, true);
  // The first label is the strip's own marker: the samples are invented, and
  // `$0.42` / `5h 38%` must not read as the user's own numbers.
  assert.deepEqual(textsOf(bar, 'sg-prevlb'), [
    'Example',
    'Model',
    'Permission mode',
    'Git branch',
    'Cost so far',
    'Context used',
  ]);
  assert.equal(bar.children[0]?.textContent, 'Example', 'and it comes FIRST, before any item');
  assert.equal(byClass(bar, 'sg-previtem').length, 5, 'the marker is not an item');
  assert.deepEqual(textsOf(bar, 'sg-prevval'), ['opus', 'always ask', 'git:main', '$0.42', 'ctx 62%']);

  row(page, 'Cost so far').click();
  assert.equal(statusPatch().cost, false, 'the toggle is persisted');
  assert.equal(
    textsOf(bar, 'sg-prevlb').includes('Cost so far'),
    false,
    'and the preview agrees with the rows',
  );

  row(page, 'Inside the terminal').click();
  assert.equal(statusPatch().enabled, false);
  assert.equal(byClass(bar, 'sg-prevempty')[0]?.textContent, 'Nothing selected, the bar is hidden');
});

test('the preview is Claude’s own line: it never shows Session time, and ignores the pane bar', async () => {
  await reopen();
  const page = panelOf('status');
  const bar = byClass(page, 'sg-prevbar')[0] as FakeElement;
  assert.equal(row(page, 'Session time').getAttribute('aria-pressed'), 'true', 'it is on by default');
  assert.equal(
    textsOf(bar, 'sg-prevlb').includes('Session time'),
    false,
    'the line Claude draws is handed no start time, so it can never print one',
  );
  assert.equal(textsOf(bar, 'sg-prevval').includes('2h 15m'), false);
  // Turning the pane bar off leaves that line exactly as it was.
  const before = textsOf(bar, 'sg-prevlb');
  row(page, 'Under the terminal').click();
  assert.equal(statusPatch().paneBar, false);
  assert.deepEqual(textsOf(bar, 'sg-prevlb'), before);
});

test('the items dim only when BOTH places are off — one bar left is still a bar', async () => {
  await reopen();
  const page = panelOf('status');
  const itemsWrap = byClass(page, 'sg-items')[0] as FakeElement;

  // Factory: Claude's line OFF, the bar under the terminal ON — one place is
  // enough to keep the items live.
  assert.equal(row(page, 'Inside the terminal').getAttribute('aria-pressed'), 'false');
  assert.equal(row(page, 'Under the terminal').getAttribute('aria-pressed'), 'true');
  assert.equal(row(page, 'Model').disabled, false, 'the bar under the terminal reads them');
  assert.equal(itemsWrap.classList.contains('is-disabled'), false);

  row(page, 'Under the terminal').click();
  assert.equal(row(page, 'Model').disabled, true, 'now there is nowhere left to draw them');
  assert.ok(itemsWrap.classList.contains('is-disabled'));
  assert.deepEqual(
    [statusPatch().enabled, statusPatch().paneBar],
    [false, false],
    'both switches are persisted off',
  );

  row(page, 'Inside the terminal').click();
  assert.equal(row(page, 'Model').disabled, false, "Claude's line alone is a place too");
  assert.equal(itemsWrap.classList.contains('is-disabled'), false);
  row(page, 'Under the terminal').click();
  assert.deepEqual([statusPatch().enabled, statusPatch().paneBar], [true, true]);
});

test('every toggle repaints the panes at once — the bar must not wait for a session event', async () => {
  await reopen();
  const page = panelOf('status');
  // Opening re-reads the stored bag (another window may have changed it), and
  // that read is a repaint reason of its own.
  assert.equal(repaints, 1, 'the re-read on open repaints once');
  repaints = 0;
  row(page, 'Session time').click();
  assert.equal(repaints, 1);
  row(page, 'Under the terminal').click();
  assert.equal(repaints, 2);
  const reset = byClass(page, 'sg-textbtn').find((b) => b.textContent === 'Reset to defaults');
  assert.ok(reset !== undefined);
  reset.click();
  assert.equal(repaints, 3, 'Reset to defaults is a change too');
});

test('a toggle writes the whole resolved config, and Reset to defaults restores the factory set', async () => {
  await reopen();
  const page = panelOf('status');
  row(page, 'Lines changed').click();
  const on = statusPatch();
  assert.deepEqual(on, {
    enabled: false,
    model: true,
    mode: true,
    branch: true,
    cost: true,
    lines: true,
    context: true,
    usage: false,
    paneBar: true,
    time: true,
    paneAgents: false,
  });
  assert.equal(row(page, 'Lines changed').getAttribute('aria-pressed'), 'true');

  // The two B1 keys are real members of that write, not defaults left implicit.
  row(page, 'Session time').click();
  assert.equal(statusPatch().time, false);
  row(page, 'Under the terminal').click();
  assert.equal(statusPatch().paneBar, false);

  const reset = byClass(page, 'sg-textbtn').find((b) => b.textContent === 'Reset to defaults');
  assert.ok(reset !== undefined, 'the page carries Reset to defaults');
  reset.click();
  const back = statusPatch();
  assert.equal(back.lines, false, 'back to the factory off-state');
  assert.deepEqual(
    [back.enabled, back.paneBar, back.time],
    [false, true, true],
    'Reset restores the factory places (the bar, not the line) and Session time',
  );
  assert.equal(row(page, 'Lines changed').getAttribute('aria-pressed'), 'false');
  assert.equal(row(page, 'Under the terminal').getAttribute('aria-pressed'), 'true');
  assert.equal(row(page, 'Session time').getAttribute('aria-pressed'), 'true');
});

test('the debug line of a write names both places', async () => {
  await reopen();
  H.logs.length = 0;
  row(panelOf('status'), 'Model').click();
  const line = H.logs.find((l) => l.startsWith('debug prefs statusLine:'));
  assert.ok(line !== undefined, 'a write is logged');
  assert.ok(line.includes('enabled=false'), line);
  assert.ok(line.includes('paneBar=true'), line);
  assert.ok(line.includes('time=true'), line);
  assert.ok(line.includes('paneAgents=false'), line);
});

test('Background agents under the terminal: OFF by default, its own switch, persisted and repainted', async () => {
  await reopen();
  const page = panelOf('status');
  const agents = row(page, 'Background agents under the terminal');
  // Default OFF (user, 2026-09-22): Claude Code lists its agents itself.
  assert.equal(agents.getAttribute('aria-pressed'), 'false');
  assert.equal(byClass(agents, 'sg-box')[0]?.textContent ?? '', '');
  repaints = 0;
  agents.click();
  assert.equal(statusPatch().paneAgents, true, 'the switch is persisted with the whole config');
  assert.equal(agents.getAttribute('aria-pressed'), 'true');
  assert.equal(repaints, 1, 'the panes repaint at once, so the table appears without a session event');
  // It is NOT one of the items: turning both bars off does not disable it.
  row(page, 'Under the terminal').click();
  assert.equal(statusPatch().paneBar, false);
  assert.equal(agents.disabled, false, 'the table does not depend on either bar');
  assert.equal(statusPatch().paneAgents, true, 'and flipping a bar leaves it as it was');
  // Reset to defaults switches it back off.
  const reset = byClass(page, 'sg-textbtn').find((b) => b.textContent === 'Reset to defaults');
  assert.ok(reset !== undefined);
  reset.click();
  assert.equal(statusPatch().paneAgents, false);
  assert.equal(agents.getAttribute('aria-pressed'), 'false');
});

test('the notice names the running sessions that cannot grow a status line, and only then', async () => {
  const sess = (over: Partial<SessionInfo>): SessionInfo =>
    ({
      id: 's1',
      // A session launched without a name keeps the raw command as its title —
      // the case the notice has to render as the product name instead.
      title: 'claude',
      command: 'claude',
      args: [],
      cwd: '/home/tester',
      projectId: 'p1',
      status: 'running',
      startedAt: new Date().toISOString(),
      ...over,
    }) as SessionInfo;

  H.sessions = new Map();
  await reopen();
  const notice = byClass(panelOf('status'), 'sg-notice')[0] as FakeElement;
  assert.equal(notice.hidden, true, 'silent when every session has one');

  H.sessions = new Map([
    ['s1', sess({ id: 's1', statusline: false })],
    ['s2', sess({ id: 's2', title: 'planner', statusline: true })],
    ['s3', sess({ id: 's3', title: 'gone', statusline: false, status: 'exited' })],
  ]);
  // The poll notifies while the panel is open.
  for (const fn of H.subscribers) fn('sessions');
  assert.equal(notice.hidden, false);
  const names = byClass(notice, 'sg-notice-names')[0] as FakeElement;
  assert.equal(names.textContent, 'Claude Code', 'a title that is just the command renders as the product name');
  H.sessions = new Map();
  for (const fn of H.subscribers) fn('sessions');
  assert.equal(notice.hidden, true);
});

// ===========================================================================
// Test-engineer additions (A7 gate) — the branches the cases above leave open:
// the late `getPrefs()` answer, a late answer after close, and the notice's
// same-name qualifier.
// ===========================================================================

test('a slow re-read on open never undoes a toggle the user already made', async () => {
  // settings.ts counts writes since this open and drops a late `getPrefs()`
  // answer when there are any; without that guard the panel would silently flip
  // a row back under the user's hand.
  panel.close();
  H.writes.length = 0;
  let release!: () => void;
  H.gate = new Promise<void>((res) => {
    release = res;
  });
  // What the other window has on disk: everything off.
  H.prefs = {
    statusLine: {
      enabled: false,
      model: false,
      mode: false,
      branch: false,
      cost: false,
      lines: false,
      context: false,
      usage: false,
    },
  };
  panel.open();
  await settle();
  const page = panelOf('status');
  // The answer has NOT landed yet, so the rows still show the in-memory config.
  assert.equal(row(page, 'Model').getAttribute('aria-pressed'), 'true');
  row(page, 'Model').click();
  assert.equal(statusPatch().model, false, 'the user turned Model off');
  release();
  await settle();
  await settle();
  assert.equal(
    row(page, 'Model').getAttribute('aria-pressed'),
    'false',
    'the stored bag must not overwrite a fresh choice',
  );
  assert.equal(
    row(page, 'Inside the terminal').getAttribute('aria-pressed'),
    'false',
    'the factory default (off) still stands, the late answer changed nothing',
  );
  H.gate = null;
  H.prefs = {};
});

test('a re-read that answers after the panel is closed changes nothing', async () => {
  panel.close();
  let release!: () => void;
  H.gate = new Promise<void>((res) => {
    release = res;
  });
  H.prefs = { statusLine: { enabled: false, model: false } };
  panel.open();
  await settle();
  const page = panelOf('status');
  const before = row(page, 'Model').getAttribute('aria-pressed');
  panel.close();
  release();
  await settle();
  await settle();
  assert.equal(row(page, 'Model').getAttribute('aria-pressed'), before, 'a closed panel takes no answer');
  H.gate = null;
  H.prefs = {};
});

/** A running claude session with no status line — the notice's whole input. */
function staleSess(
  id: string,
  title: string,
  projectId: string | undefined,
  command = 'claude',
): SessionInfo {
  return {
    id,
    title,
    command,
    args: [],
    cwd: '/home/tester',
    projectId,
    status: 'running',
    statusline: false,
    startedAt: new Date().toISOString(),
  } as unknown as SessionInfo;
}

test('the notice qualifies same-named sessions with their project, and lists each one', async () => {
  const sess = staleSess;

  H.projectNames = { p1: 'Alpha', p2: 'Beta' };
  // Two sessions whose title IS the command: both render as the product name, so
  // the label collides and the project is what tells them apart.
  H.sessions = new Map([
    ['a', sess('a', 'claude', 'p1')],
    ['b', sess('b', 'claude', 'p2')],
    ['c', sess('c', 'planner', 'p1')],
  ]);
  await reopen();
  const notice = byClass(panelOf('status'), 'sg-notice')[0] as FakeElement;
  assert.equal(notice.hidden, false);
  assert.equal(
    (byClass(notice, 'sg-notice-names')[0] as FakeElement).textContent,
    'Claude Code (Alpha), Claude Code (Beta), planner',
    'a colliding label takes its project as a qualifier; a unique one does not',
  );

  // A colliding label with NO project stays bare — an invented qualifier would
  // name something the session does not have.
  H.sessions = new Map([
    ['a', sess('a', 'claude', undefined)],
    ['b', sess('b', 'claude', undefined)],
  ]);
  for (const fn of H.subscribers) fn('sessions');
  assert.equal(
    (byClass(notice, 'sg-notice-names')[0] as FakeElement).textContent,
    'Claude Code, Claude Code',
  );
  H.sessions = new Map();
  H.projectNames = {};
  for (const fn of H.subscribers) fn('sessions');
  assert.equal(notice.hidden, true);
});

test('a claude launched by absolute PATH is named by the PRODUCT name, never by its path', async () => {
  // `sessionsWithoutStatusLine()` matches on the BASENAME of the command
  // (statusline-model.ts), and since 2026-09-13 so does `commandLabel()`
  // (launch-args.ts, the `isClaudeCommand` rule) — so a session started as
  // `/usr/local/bin/claude` reaches this notice AND reads as the product name.
  // A raw path here would be a command in UI chrome (PROJECT-SCOPE copy rule,
  // 2026-07-25).
  H.projectNames = { p1: 'Alpha' };
  H.sessions = new Map([['a', staleSess('a', '/usr/local/bin/claude', 'p1', '/usr/local/bin/claude')]]);
  await reopen();
  const notice = byClass(panelOf('status'), 'sg-notice')[0] as FakeElement;
  assert.equal(notice.hidden, false, 'the basename match puts it in the notice');
  assert.equal(
    (byClass(notice, 'sg-notice-names')[0] as FakeElement).textContent,
    'Claude Code',
    'the basename rule names it, and the path never reaches the copy',
  );
  H.sessions = new Map();
  H.projectNames = {};
  for (const fn of H.subscribers) fn('sessions');
});
