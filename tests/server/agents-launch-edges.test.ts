/**
 * server/agents.ts — Nocturne C2 (.claude/plans/nocturne/PLAN-C2.md § The
 * rule 3-5), the edges: tests the C2 test gate found missing from
 * `tests/server/agents-launch-watcher.test.ts`. The session verdict looks at
 * EVERY running row (not only the four on the wire) and every open launch
 * (a dead one opened first hides nothing); a subagent past B7's 64-agent
 * tracking cap has no row, so only its launch time speaks; an interrupt ends
 * the turn like `end_turn` (a live launch keeps it working); `ExitPlanMode`
 * beats background work like `AskUserQuestion`; the first of two notices
 * changes nothing; a session with no subagents directory is timed by launch
 * alone and never fails a poll; and `turnEnded` (C1) is set when the LAST
 * launch goes stale or is closed while the main turn stays ended — the
 * combined verdict's move, not the main verdict's. A launched subagent whose
 * row just FINISHED keeps the turn working for FINISH_GRACE_MS, so its
 * notice landing a poll later flashes no mascot (a planted end stamp ahead
 * of the clock gets no grace).
 *
 * How: a real AgentsWatcher over a real temp `<root>/-slug/<uuid>/subagents`
 * tree on a clock the test steps (`clocked`, `tests/helpers/agents-fixture.ts`);
 * the `turnEnded` cases wire it to a real SessionManager with a frame-keeping
 * fake client (`wired`), as server/index.ts does.
 *
 * Why it matters: each of these is a place where the mascot would come while
 * Claude's background work still runs (the user's report that started C2), or
 * never come once it is over.
 *
 * NOT claimed here: the main rules — `tests/server/agents-launch-watcher.test.ts`;
 * the fold's parsing — `tests/server/agents-launch-fold.test.ts`; the
 * workflow scan's own boundary — `tests/server/agents-workflows.test.ts`; the
 * page and the pane that draw `turn` / `turnEnded` (the DEV check in PLAN-C2
 * § Gates). `ExitPlanMode`'s real line shape: none on this machine, built like
 * `AskUserQuestion`'s.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sleep } from '../helpers/helpers.ts';
import {
  MAX_AGENTS,
  NO_REPORT_MS,
  NOW_S,
  REAL,
  STALE_MS,
  agentLaunch,
  agoIso,
  appendLines,
  appendMain,
  assistantLine,
  clocked,
  makeWatcher,
  notificationLine,
  queuedNotificationLine,
  questionLine,
  runningAgent,
  startTracking,
  toolId,
  toolResultLine,
  turnsOf,
  userLine,
  waitForReport,
  waitInfo,
  wired,
  workflowLaunch,
  writeMeta,
} from '../helpers/agents-fixture.ts';

const AGENT = 'a790bda5878f4d7ef';
const OTHER = 'b31c0ffee';
const RUN = 'wf_998cfcac-d41';

/** FINISH_GRACE_MS in server/agents.ts (not exported; kept in step here). */
const FINISH_GRACE_MS = 10_000;

// ---------------------------------------------------------------------------
// Which rows and which launches the verdict looks at
// ---------------------------------------------------------------------------

test('C2 edges: a launched subagent that is the FIFTH running row — off the wire — still keeps the ended turn working', async () => {
  const { w, clock } = await clocked();
  try {
    // Four agents that started earlier take the wire's four running rows
    // (B11 (d): running rows oldest first); the launched one is fifth.
    for (let i = 0; i < 4; i++) {
      await writeMeta(w.dir, `b${i}`, { agentType: `early-${i}`, description: '' });
      await appendLines(w.dir, `b${i}`, [userLine(`2026-09-26T09:0${i}:00.000Z`)]);
    }
    await writeMeta(w.dir, AGENT, { agentType: 'backend-pty', description: 'B4 phase 1' });
    await appendLines(w.dir, AGENT, [userLine('2026-09-26T10:00:00.000Z')]);
    await appendMain(w, [...agentLaunch(agoIso(clock.now, STALE_MS + 60_000), toolId(1), AGENT), REAL.endTurn]);
    startTracking(w);
    const first = await waitForReport(w.seen, (r) => r.turn !== undefined);
    assert.deepEqual(first.counts, { running: 5, finished: 0 });
    assert.equal(first.agents.some((a) => a.id === AGENT), false, 'precondition: its row is not on the wire');
    assert.equal(first.turn, 'working', 'its row runs: the turn is not over');
    await appendLines(w.dir, AGENT, [assistantLine(new Date().toISOString(), 'm1', { output_tokens: 1 }, 'end_turn')]);
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    assert.deepEqual(turnsOf(w), ['working', 'waiting']);
  } finally {
    await w.cleanup();
  }
});

test('C2 edges: a dead launch opened BEFORE a live one does not hide it — every open launch is looked at', async () => {
  const { w, clock } = await clocked();
  try {
    await runningAgent(w, AGENT);
    const old = agoIso(clock.now, STALE_MS + 60_000);
    await appendMain(w, [
      ...agentLaunch(old, toolId(1), OTHER), // no row at all: dead
      ...workflowLaunch(old, toolId(2), RUN), // no run directory: dead
      ...agentLaunch(old, toolId(3), AGENT), // its row runs
      REAL.endTurn,
    ]);
    startTracking(w);
    assert.equal((await waitForReport(w.seen, (r) => r.turn !== undefined)).turn, 'working');
  } finally {
    await w.cleanup();
  }
});

test('C2 edges: a launched subagent beyond the 64-agent tracking cap has no row to speak for it — its launch time alone does (the bound, PLAN-C2 § The rule 3)', async () => {
  const { w, clock } = await clocked();
  try {
    // 64 running agents with NEWER metas take every tracked place (B7: the
    // newest meta mtime wins); the launched agent's meta is older.
    for (let i = 0; i < MAX_AGENTS; i++) {
      const id = `c${i.toString(16).padStart(2, '0')}`;
      await writeMeta(w.dir, id, { agentType: 'x', description: '' }, NOW_S);
      await appendLines(w.dir, id, [userLine(new Date().toISOString())]);
    }
    await writeMeta(w.dir, AGENT, { agentType: 'backend-pty', description: 'resumed' }, NOW_S - 60);
    await appendLines(w.dir, AGENT, [userLine(new Date().toISOString())]);
    await appendMain(w, [...agentLaunch(agoIso(clock.now, STALE_MS + 60_000), toolId(1), AGENT), REAL.endTurn]);
    startTracking(w);
    const first = await waitForReport(w.seen, (r) => r.turn !== undefined);
    assert.equal(first.counts.running, MAX_AGENTS, 'precondition: the cap is full of newer agents');
    assert.equal(first.turn, 'waiting', 'untracked: nothing speaks for it past STALE_MS');
    // One newer agent goes: the launched one is tracked, and its running row speaks.
    await rm(join(w.dir, 'agent-c00.meta.json'));
    await waitForReport(w.seen, (r) => r.turn === 'working');
  } finally {
    await w.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Which waits are a turn that ENDED
// ---------------------------------------------------------------------------

test('C2 edges: an INTERRUPT ends the turn like end_turn — a live launch keeps it working until the launch goes stale', async () => {
  const cases: [string, (at: string) => string[]][] = [
    ['Esc during a turn', () => [REAL.interrupt]],
    [
      'Esc on a question',
      (at) => [
        questionLine(at, toolId(2)),
        toolResultLine(at, toolId(2), "The user doesn't want to proceed with this tool use."),
        REAL.interruptForTool,
      ],
    ],
  ];
  for (const [what, tail] of cases) {
    const { w, clock } = await clocked();
    try {
      const launchedAt = clock.now - 1_000;
      const at = new Date(launchedAt).toISOString();
      await appendMain(w, [...agentLaunch(at, toolId(1), AGENT), ...tail(at)]);
      startTracking(w);
      await waitForReport(w.seen, (r) => r.turn === 'working');
      clock.now = launchedAt + STALE_MS;
      await waitForReport(w.seen, (r) => r.turn === 'waiting');
      assert.deepEqual(turnsOf(w), ['working', 'waiting'], what);
    } finally {
      await w.cleanup();
    }
  }
});

test('C2 edges: ExitPlanMode wins over a running subagent too — waiting at once, working again once the plan is answered', async () => {
  const { w, clock } = await clocked();
  try {
    await runningAgent(w, AGENT);
    await appendMain(w, [
      ...agentLaunch(agoIso(clock.now, 1_000), toolId(1), AGENT),
      questionLine(agoIso(clock.now, 0), toolId(2), 'ExitPlanMode'),
    ]);
    startTracking(w);
    assert.equal((await waitForReport(w.seen, (r) => r.turn !== undefined)).turn, 'waiting');
    await appendMain(w, [toolResultLine(agoIso(clock.now, 0), toolId(2), 'User has approved your plan. You can now start coding.')]);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    assert.deepEqual(turnsOf(w), ['waiting', 'working']);
  } finally {
    await w.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Closing, and a session without a subagents directory
// ---------------------------------------------------------------------------

test('C2 edges: with TWO launches open the first notice changes nothing — the one that closes the LAST ends it', async () => {
  const { w, clock } = await clocked();
  try {
    await appendMain(w, [
      ...agentLaunch(agoIso(clock.now, 2_000), toolId(1), AGENT),
      ...workflowLaunch(agoIso(clock.now, 1_000), toolId(2), RUN),
      REAL.endTurn,
    ]);
    startTracking(w);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    await appendMain(w, [queuedNotificationLine(agoIso(clock.now, 0), toolId(1), AGENT)]);
    await sleep(NO_REPORT_MS);
    assert.deepEqual(turnsOf(w), ['working'], 'the workflow is still open');
    await appendMain(w, [queuedNotificationLine(agoIso(clock.now, 0), toolId(2), 'w094cbwm2')]);
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    assert.deepEqual(turnsOf(w), ['working', 'waiting']);
  } finally {
    await w.cleanup();
  }
});

test('C2 edges: a session with NO subagents directory times its workflow launch by launch alone — and never fails a poll', async () => {
  const clock = { now: Date.now() };
  const w = await makeWatcher({ now: () => clock.now, create: false });
  try {
    // Only the slug folder: the main transcript exists, `<uuid>/subagents` does not.
    await mkdir(join(w.root, '-slug'), { recursive: true });
    const launchedAt = clock.now - 1_000;
    await appendMain(w, [...workflowLaunch(new Date(launchedAt).toISOString(), toolId(1), RUN), REAL.endTurn]);
    startTracking(w);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    clock.now = launchedAt + STALE_MS;
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    assert.deepEqual(
      w.logs.filter((l) => l.includes('poll failed')),
      [],
      'nothing to scan is not an error',
    );
  } finally {
    await w.cleanup();
  }
});

// ---------------------------------------------------------------------------
// turnEnded (C1) on the combined verdict's move
// ---------------------------------------------------------------------------

test('C2 turnEnded: the last launch going STALE while the turn stays ended is news — set then, not before', async () => {
  const clock = { now: Date.now() };
  const s = await wired({ now: () => clock.now });
  try {
    await appendMain(s.w, [REAL.prompt]);
    s.w.watcher.track('sess-1', s.w.dir);
    await waitInfo(s.client, (i) => i.turn === 'working', 'working');
    const launchedAt = clock.now - 1_000;
    await appendMain(s.w, [...agentLaunch(new Date(launchedAt).toISOString(), toolId(1), AGENT), REAL.endTurn]);
    await sleep(NO_REPORT_MS);
    assert.equal(
      s.client.infoFrames().some((i) => i.turn === 'waiting' || i.turnEnded === true),
      false,
      'the main turn ended while its launch lives: not news',
    );
    clock.now = launchedAt + STALE_MS;
    const ended = await waitInfo(s.client, (i) => i.turn === 'waiting', 'waiting');
    assert.equal(ended.turnEnded, true, 'the combined verdict went working -> waiting');
    assert.equal(typeof ended.pendingSince, 'string');
  } finally {
    await s.cleanup();
  }
});

test('C2 turnEnded: notices closing both launches after the turn ended — news only on the LAST, the main verdict never moving', async () => {
  const s = await wired();
  try {
    await appendMain(s.w, [REAL.prompt]);
    s.w.watcher.track('sess-1', s.w.dir);
    await waitInfo(s.client, (i) => i.turn === 'working', 'working');
    const now = new Date().toISOString();
    await appendMain(s.w, [...agentLaunch(now, toolId(1), AGENT), ...agentLaunch(now, toolId(2), OTHER), REAL.endTurn]);
    // A queued_command attachment is no counting line: the main verdict stays 'waiting' from here on.
    await appendMain(s.w, [queuedNotificationLine(now, toolId(1), AGENT)]);
    await sleep(NO_REPORT_MS);
    assert.equal(
      s.client.infoFrames().some((i) => i.turn === 'waiting' || i.turnEnded === true),
      false,
      'one launch is still open: not news',
    );
    await appendMain(s.w, [queuedNotificationLine(now, toolId(2), OTHER)]);
    const ended = await waitInfo(s.client, (i) => i.turn === 'waiting', 'waiting');
    assert.equal(ended.turnEnded, true, 'the last launch closed: the combined verdict went working -> waiting');
  } finally {
    await s.cleanup();
  }
});

/**
 * A session whose ended turn is held only by a launched subagent's ROW: the
 * launch is older than STALE_MS, the agent runs. Returns the clock, which
 * stands at the moment the agent will write its end line.
 */
async function heldByRow(): Promise<{ s: Awaited<ReturnType<typeof wired>>; clock: { now: number } }> {
  const clock = { now: Date.now() };
  const s = await wired({ now: () => clock.now });
  await runningAgent(s.w, AGENT);
  await appendMain(s.w, [REAL.prompt, ...agentLaunch(agoIso(clock.now, STALE_MS + 60_000), toolId(1), AGENT), REAL.endTurn]);
  s.w.watcher.track('sess-1', s.w.dir);
  const first = await waitInfo(s.client, (i) => i.turn !== undefined && i.agents?.length === 1, 'the running row');
  assert.equal(first.turn, 'working', 'only the running row keeps it working');
  return { s, clock };
}

test('C2 turnEnded: a launched agent that FINISHED keeps the ended turn working for FINISH_GRACE_MS — then, with no notice, waiting is news', async () => {
  const { s, clock } = await heldByRow();
  try {
    const endedAt = clock.now;
    await appendLines(s.w.dir, AGENT, [assistantLine(new Date(endedAt).toISOString(), 'm1', { output_tokens: 1 }, 'end_turn')]);
    const done = await waitInfo(s.client, (i) => i.agents?.[0]?.state === 'finished', 'the finished row');
    assert.equal(done.turn, 'working', 'the notice lands a moment after the last line: not news yet');
    clock.now = endedAt + FINISH_GRACE_MS - 1;
    await sleep(NO_REPORT_MS);
    assert.equal(s.client.infoFrames().some((i) => i.turn === 'waiting' || i.turnEnded === true), false, 'inside the grace');
    clock.now = endedAt + FINISH_GRACE_MS;
    const ended = await waitInfo(s.client, (i) => i.turn === 'waiting', 'waiting');
    assert.equal(ended.turnEnded, true, 'no notice came: the agent is over, and so is the turn');
  } finally {
    await s.cleanup();
  }
});

test('C2 turnEnded: the notice landing INSIDE the grace never sets it — only the real end of the turn does', async () => {
  const { s, clock } = await heldByRow();
  try {
    const endedAt = clock.now;
    await appendLines(s.w.dir, AGENT, [assistantLine(new Date(endedAt).toISOString(), 'm1', { output_tokens: 1 }, 'end_turn')]);
    await waitInfo(s.client, (i) => i.agents?.[0]?.state === 'finished', 'the finished row');
    clock.now = endedAt + FINISH_GRACE_MS / 2;
    await appendMain(s.w, [notificationLine(new Date(clock.now).toISOString(), toolId(1), AGENT)]);
    await sleep(NO_REPORT_MS);
    clock.now = endedAt + FINISH_GRACE_MS * 2; // Past the grace: the notice's own line holds it now.
    await sleep(NO_REPORT_MS);
    assert.equal(s.client.infoFrames().some((i) => i.turn === 'waiting' || i.turnEnded === true), false, 'no flash');
    await appendMain(s.w, [REAL.endTurn]);
    const ended = await waitInfo(s.client, (i) => i.turn === 'waiting', 'the real end');
    assert.equal(ended.turnEnded, true);
    assert.equal(s.client.infoFrames().filter((i) => i.turnEnded === true).length, 1, 'set once, at the real end');
  } finally {
    await s.cleanup();
  }
});

test('C2 edges: a finished row whose end stamp is AHEAD of the clock gets no grace — a planted date cannot hold working', async () => {
  const { w, clock } = await clocked();
  try {
    await runningAgent(w, AGENT);
    await appendLines(w.dir, AGENT, [assistantLine(agoIso(clock.now, -60_000), 'm1', { output_tokens: 1 }, 'end_turn')]);
    await appendMain(w, [...agentLaunch(agoIso(clock.now, STALE_MS + 60_000), toolId(1), AGENT), REAL.endTurn]);
    startTracking(w);
    const first = await waitForReport(w.seen, (r) => r.turn !== undefined);
    assert.equal(first.agents[0]?.state, 'finished');
    assert.equal(first.turn, 'waiting');
  } finally {
    await w.cleanup();
  }
});
