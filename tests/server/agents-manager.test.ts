/**
 * server/agents.ts wiring into SessionManager (Nocturne B7,
 * .claude/plans/nocturne/PLAN-B7.md): which sessions are polled and where the
 * projects root is — setReport (a silent no-op for an unknown id, one `info`
 * broadcast per REAL change), isLive, destroy() and the exit untracking, the
 * exit finishing only the RUNNING rows, claudeProjectsDir following
 * CLAUDE_CONFIG_DIR like server/history.ts, and the watcher's refusal of a
 * tracked directory logged once (and its becoming legal logged once).
 *
 * How: a real SessionManager on a temp dir with the watcher the B7 wiring
 * hands it, and a fake `ws` client that keeps every frame so "exactly one
 * broadcast per real change" is countable (`makeManager`, `FakeClient` in
 * `tests/helpers/agents-fixture.ts`); real PTYs where a session must exit.
 *
 * NOT claimed here: the B11 turn on the same frames —
 * `tests/server/agents-turn.test.ts`, `tests/server/agents-turn-edges.test.ts`;
 * the UI that draws the rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionAgent, SessionInfo } from '../../shared/protocol.ts';
import { AgentsWatcher } from '../../server/agents.ts';
import { resolveDataPaths, type Logger } from '../../server/config.ts';
import { SessionHistory } from '../../server/history.ts';
import { SessionManager } from '../../server/sessions.ts';
import { sleep, makeTempDir, waitUntil } from '../helpers/helpers.ts';
import {
  UUID,
  type Seen,
  writeMeta,
  waitFor,
  FakeClient,
  makeManager,
  ROW,
  report,
  MANY_POLLS_MS,
  WATCHER_POLL_MS,
} from '../helpers/agents-fixture.ts';

// ---------------------------------------------------------------------------
// The wiring: which sessions are polled, and where the root is
// ---------------------------------------------------------------------------

test('SessionManager.setReport: an unknown id is a silent no-op, and never creates a session', async () => {
  // A poll can land after the session was deleted, and a list of subagents is
  // not a session: the only trace is a debug line.
  const m = await makeManager();
  try {
    m.manager.setReport('no-such-session', report([ROW], { turn: 'working' }));
    assert.equal(m.manager.has('no-such-session'), false);
    assert.equal(m.manager.list().length, 0);
    assert.equal(
      m.logs.some((l) => l.includes('no-such-session agents ignored: no such session')),
      true,
      `the refusal is logged; logs were ${JSON.stringify(m.logs)}`,
    );
  } finally {
    await m.cleanup();
  }
});

test('SessionManager.setReport: one `info` broadcast per REAL change, carrying agents + agentCounts', async () => {
  const m = await makeManager();
  try {
    const info = m.manager.create({ command: 'bash', args: ['-c', 'sleep 30'], cwd: m.root, cols: 80, rows: 24 });
    const client = new FakeClient();
    assert.equal(m.manager.attach(info.id, client.asWs()), true);
    assert.equal(client.agentFrames().length, 0, 'the attach info carries no agents yet');
    const base = client.infoFrames().length;

    m.manager.setReport(info.id, report([ROW]));
    assert.equal(client.agentFrames().length, 1);
    assert.deepEqual(client.agentFrames()[0]?.agents, [ROW]);
    assert.deepEqual(client.agentFrames()[0]?.agentCounts, { running: 1, finished: 0 });
    // And the session itself holds it, for a client that attaches later.
    assert.deepEqual(m.manager.get(info.id)?.agents, [ROW]);

    // The same report again, as DIFFERENT objects with equal fields: what the
    // watcher delivers on every poll of an idle agent. Not news, not a frame.
    m.manager.setReport(info.id, report([{ ...ROW }]));
    assert.equal(client.infoFrames().length, base + 1, 'an unchanged report is not a broadcast');

    // One field moved: exactly one more frame.
    m.manager.setReport(info.id, report([{ ...ROW, tokens: 12_500 }]));
    assert.equal(client.agentFrames().length, 2);
    assert.equal(client.agentFrames()[1]?.agents?.[0]?.tokens, 12_500);

    // Only the COUNT moved (a sixth agent beyond the rows): a change too.
    m.manager.setReport(info.id, report([{ ...ROW, tokens: 12_500 }], { counts: { running: 5, finished: 0 } }));
    assert.equal(client.agentFrames().length, 3);
    assert.deepEqual(client.agentFrames()[2]?.agentCounts, { running: 5, finished: 0 });

    // Every agent went away: both fields go ABSENT (never an empty table) —
    // still one frame, not none.
    m.manager.setReport(info.id, report([]));
    assert.equal(client.infoFrames().length, base + 4);
    const cleared = client.infoFrames()[base + 3] as SessionInfo;
    assert.equal(cleared.agents, undefined);
    assert.equal(cleared.agentCounts, undefined);
    assert.equal('agents' in cleared, false, 'absent, not undefined-valued');

    m.manager.destroy(info.id);
  } finally {
    await m.cleanup();
  }
});

test('SessionManager.isLive: an id that was never a session is not live', async () => {
  // The index.ts callback asks this before tracking; an unknown id must be a
  // plain false, not a throw and not a truthy undefined.
  const m = await makeManager();
  try {
    assert.equal(m.manager.isLive('never-existed'), false);
    assert.equal(m.manager.has('never-existed'), false);
  } finally {
    await m.cleanup();
  }
});

test('SessionManager: destroy() untracks the session as well as the exit does', async () => {
  const m = await makeManager();
  try {
    const info = m.manager.create({ command: 'bash', args: ['-c', 'sleep 30'], cwd: m.root, cols: 80, rows: 24 });
    m.watcher.track(info.id, join(m.root, 'subagents'));
    assert.equal(m.watcher.trackedCount, 1);
    m.manager.destroy(info.id);
    assert.equal(m.watcher.trackedCount, 0, 'a deleted session is no longer polled');
  } finally {
    await m.cleanup();
  }
});

test('SessionManager: isLive is false for an EXITED session, which stays listed', async () => {
  // The B7 call site in server/index.ts gates agents.track() on this. has()
  // cannot answer it: a session stays listed after its PTY exits, so a
  // snapshot landing after onExit (a 150 ms debounce, or a 2 s poll) would
  // re-track a dead session and never untrack it again.
  const root = realpathSync(await makeTempDir('ai-sm-islive-'));
  const log: Logger = () => {};
  const watcher = new AgentsWatcher(log, { projectsRoot: root, pollMs: 60_000 });
  const history = new SessionHistory(join(root, 'history.json'), log);
  history.load();
  const manager = new SessionManager(log, history, undefined, undefined, watcher);
  try {
    const info = manager.create({ command: 'bash', args: ['-c', 'exit 0'], cwd: root, cols: 80, rows: 24 });
    assert.equal(manager.isLive(info.id), true);
    watcher.track(info.id, join(root, 'subagents'));
    assert.equal(watcher.trackedCount, 1);

    await waitUntil(
      () => (manager.get(info.id)?.status === 'exited' ? true : undefined),
      'the session to exit',
      10_000,
      20,
    );
    assert.equal(manager.has(info.id), true, 'still listed until DELETE...');
    assert.equal(manager.isLive(info.id), false, '...but not live');
    assert.equal(watcher.trackedCount, 0, 'onExit untracked it');
    manager.destroy(info.id);
  } finally {
    watcher.stop();
    manager.destroyAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('config: claudeProjectsDir follows CLAUDE_CONFIG_DIR, like server/history.ts does', async () => {
  // A user who set the variable would otherwise get a table that never
  // appears, with nothing in the log to say why.
  const base = realpathSync(await makeTempDir('ai-sm-cfgdir-'));
  const dataBefore = process.env['AI_SM_DATA_DIR'];
  const claudeBefore = process.env['CLAUDE_CONFIG_DIR'];
  try {
    process.env['AI_SM_DATA_DIR'] = join(base, 'data');
    delete process.env['CLAUDE_CONFIG_DIR'];
    const fallback = resolveDataPaths().claudeProjectsDir;
    assert.equal(fallback, join(homedir(), '.claude', 'projects'));

    process.env['CLAUDE_CONFIG_DIR'] = join(base, 'elsewhere');
    assert.equal(resolveDataPaths().claudeProjectsDir, join(base, 'elsewhere', 'projects'));

    // An empty value is not a setting: the home default stands.
    process.env['CLAUDE_CONFIG_DIR'] = '';
    assert.equal(resolveDataPaths().claudeProjectsDir, fallback);
  } finally {
    if (dataBefore === undefined) delete process.env['AI_SM_DATA_DIR'];
    else process.env['AI_SM_DATA_DIR'] = dataBefore;
    if (claudeBefore === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = claudeBefore;
    await rm(base, { recursive: true, force: true });
  }
});

test('watcher: the refusal is logged once, and a directory that becomes legal says so once', async () => {
  const base = realpathSync(await makeTempDir('ai-sm-agentonce-'));
  const root = join(base, 'projects');
  const slug = join(root, '-slug');
  const outside = join(base, 'outside');
  await mkdir(slug, { recursive: true });
  await mkdir(join(outside, 'subagents'), { recursive: true });
  const link = join(slug, UUID);
  await symlink(outside, link);
  const logs: string[] = [];
  const seen: Seen[] = [];
  const watcher = new AgentsWatcher((level, message) => logs.push(`${level}: ${message}`), {
    projectsRoot: root,
    pollMs: WATCHER_POLL_MS,
  });
  const count = (needle: string): number => logs.filter((l) => l.includes(needle)).length;
  try {
    watcher.start((id, report) => seen.push({ id, agents: report.agents, report }));
    watcher.track('sess-1', join(link, 'subagents'));
    // The refusal is a condition; ONCE is the silence over many polls after it.
    await waitUntil(
      () => (count('resolves outside the projects root') > 0 ? true : undefined),
      'the refusal line',
      5_000,
      10,
    );
    await sleep(MANY_POLLS_MS);
    assert.equal(count('resolves outside the projects root'), 1, logs.join('\n'));

    // The user (or an installer) replaces the symlink with the real thing.
    await rm(link, { force: true });
    await mkdir(join(link, 'subagents'), { recursive: true });
    await writeMeta(join(link, 'subagents'), 'ab', { agentType: 'honest', description: '' });
    await waitFor(seen, (a) => a[0]?.name === 'honest');
    await waitUntil(
      () => (count('now inside the projects root') > 0 ? true : undefined),
      'the recovery line',
      5_000,
      10,
    );
    await sleep(MANY_POLLS_MS); // Fifteen more polls, all of them legal now.
    assert.equal(count('now inside the projects root'), 1, 'the recovery is said once too');
    assert.equal(count('resolves outside the projects root'), 1, 'and the refusal is not repeated');
  } finally {
    watcher.stop();
    await rm(base, { recursive: true, force: true });
  }
});

test('SessionManager: a RUNNING agent row is finished by the exit, and only that row', async () => {
  // Claude Code runs its subagents in-process: none of them outlives the host
  // session, and a row left 'running' would tick in the browser forever.
  const root = realpathSync(await makeTempDir('ai-sm-exitrows-'));
  const log: Logger = () => {};
  const history = new SessionHistory(join(root, 'history.json'), log);
  history.load();
  const manager = new SessionManager(log, history);
  try {
    const info = manager.create({ command: 'bash', args: ['-c', 'exit 0'], cwd: root, cols: 80, rows: 24 });
    const done: SessionAgent = {
      id: 'aa',
      name: 'done',
      task: 't',
      startedAt: '2026-09-22T10:00:00.000Z',
      endedAt: '2026-09-22T10:05:00.000Z',
      tokens: 5,
      state: 'finished',
    };
    const live: SessionAgent = {
      id: 'bb',
      name: 'live',
      task: 't',
      startedAt: '2026-09-22T10:01:00.000Z',
      tokens: 9,
      state: 'running',
    };
    manager.setReport(info.id, report([done, live], { counts: { running: 3, finished: 7 }, turn: 'working' }));

    await waitUntil(
      () => (manager.get(info.id)?.status === 'exited' ? true : undefined),
      'the session to exit',
      10_000,
      20,
    );
    const rows = manager.get(info.id)?.agents as SessionAgent[];
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], done, 'a finished row is not touched');
    assert.equal(rows[1]?.state, 'finished');
    assert.equal(rows[1]?.tokens, 9, 'and it keeps what it cost');
    const endedAt = rows[1]?.endedAt as string;
    assert.equal(new Date(endedAt).toISOString(), endedAt, 'ISO-8601');
    assert.ok(Math.abs(Date.now() - Date.parse(endedAt)) < 60_000, 'the exit clock, not a fabricated one');
    // B11: the totals follow the same fact, and the turn is dropped.
    assert.deepEqual(manager.get(info.id)?.agentCounts, { running: 0, finished: 10 });
    assert.equal(manager.get(info.id)?.turn, undefined);
    manager.destroy(info.id);
  } finally {
    manager.destroyAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('SessionManager: a session with NO agents gets no list at exit', async () => {
  const root = realpathSync(await makeTempDir('ai-sm-exitnorows-'));
  const log: Logger = () => {};
  const history = new SessionHistory(join(root, 'history.json'), log);
  history.load();
  const manager = new SessionManager(log, history);
  try {
    const info = manager.create({ command: 'bash', args: ['-c', 'exit 0'], cwd: root, cols: 80, rows: 24 });
    await waitUntil(
      () => (manager.get(info.id)?.status === 'exited' ? true : undefined),
      'the session to exit',
      10_000,
      20,
    );
    assert.equal(manager.get(info.id)?.agents, undefined, 'absent, never an empty table');
    manager.destroy(info.id);
  } finally {
    manager.destroyAll();
    await rm(root, { recursive: true, force: true });
  }
});
