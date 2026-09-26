/**
 * server/agents.ts + server/agents-workflows.ts — Nocturne C2
 * (.claude/plans/nocturne/PLAN-C2.md § The rule 3-5): the SESSION verdict.
 * A turn that ended reads 'working' while a background launch it left open is
 * alive — launched less than STALE_MS ago, its subagent's row running (not
 * finished, not stale), or its workflow run's agent transcripts written less
 * than STALE_MS ago — and 'waiting' once none is; a question reads 'waiting'
 * whatever runs. SessionManager's `turnEnded` (C1) follows this verdict:
 * set on its working -> waiting move only.
 *
 * How: a real AgentsWatcher over a real temp `<root>/-slug/<uuid>/subagents`
 * tree, fed transcripts shaped like this machine's
 * (`tests/helpers/agents-fixture.ts` § C2), its clock injected so the
 * STALE_MS edges are stepped, not slept; file ages set with utimes. The
 * `turnEnded` cases wire it to a real SessionManager with a frame-keeping
 * fake client, as server/index.ts does.
 *
 * Why it matters: this is the user's report that started C2 — the mascot came
 * while the session's subagents still worked. And the fallback is what keeps
 * a launch that never reports back from holding 'Working' forever.
 *
 * NOT claimed here: the fold's parsing of launches, notifications and
 * questions — `tests/server/agents-launch-fold.test.ts`; the workflow scan's
 * own boundary and its MAX_WORKFLOW_SCAN cap —
 * `tests/server/agents-workflows.test.ts`; the mascot and the pane that read
 * `turn` / `turnEnded` (the DEV check in PLAN-C2 § Gates).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sleep } from '../helpers/helpers.ts';
import {
  STALE_MS,
  REAL,
  MANY_POLLS_MS,
  NO_REPORT_MS,
  agentLaunch,
  agoIso,
  answerLine,
  appendLines,
  appendMain,
  assistantLine,
  clocked,
  mainFile,
  notificationLine,
  queuedNotificationLine,
  questionLine,
  resumeText,
  runningAgent,
  startTracking,
  toolId,
  toolResultLine,
  toolUseLine,
  turnsOf,
  userLine,
  waitForReport,
  waitInfo,
  wired,
  workflowLaunch,
  type Harness,
} from '../helpers/agents-fixture.ts';

const AGENT = 'a790bda5878f4d7ef';
const RUN = 'wf_998cfcac-d41';

/** An `agent-<hex>.jsonl` in a workflow run's directory, `ageMs` old. */
async function workflowAgent(w: Harness, runId: string, name: string, ageMs: number): Promise<string> {
  const dir = join(w.dir, 'workflows', runId);
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, `${userLine(new Date().toISOString())}\n`);
  const at = (Date.now() - ageMs) / 1_000;
  await utimes(file, at, at);
  return file;
}

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

test('C2 watcher: an ended turn reads WORKING while the subagent it launched runs, WAITING once that agent finishes', async () => {
  const { w, clock } = await clocked();
  try {
    await runningAgent(w, AGENT);
    // Launched long enough ago that only the agent's own row speaks for it.
    await appendMain(w, [REAL.prompt, ...agentLaunch(agoIso(clock.now, STALE_MS + 60_000), toolId(1), AGENT), REAL.endTurn]);
    startTracking(w);
    const first = await waitForReport(w.seen, (r) => r.turn !== undefined);
    assert.equal(first.turn, 'working', 'the first readout already knows the agent runs');
    assert.deepEqual(first.counts, { running: 1, finished: 0 });
    await appendLines(w.dir, AGENT, [assistantLine(new Date().toISOString(), 'm1', { output_tokens: 1 }, 'end_turn')]);
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    assert.deepEqual(turnsOf(w), ['working', 'waiting'], 'no waiting blip before the agent finished');
  } finally {
    await w.cleanup();
  }
});

test('C2 watcher: a STALE subagent row (no write for STALE_MS) does not keep it working; a fresh write does', async () => {
  const { w, clock } = await clocked();
  try {
    await runningAgent(w, AGENT);
    const stale = (Date.now() - STALE_MS - 5_000) / 1_000;
    await utimes(join(w.dir, `agent-${AGENT}.jsonl`), stale, stale);
    await appendMain(w, [...agentLaunch(agoIso(clock.now, STALE_MS + 60_000), toolId(1), AGENT), REAL.endTurn]);
    startTracking(w);
    const first = await waitForReport(w.seen, (r) => r.turn !== undefined);
    assert.equal(first.turn, 'waiting', 'a killed agent that never reported back');
    assert.equal(first.agents[0]?.state, 'finished', "B7's own row says it is over");
    await appendLines(w.dir, AGENT, [userLine(new Date().toISOString())]);
    await waitForReport(w.seen, (r) => r.turn === 'working');
  } finally {
    await w.cleanup();
  }
});

test('C2 watcher: the launch time alone keeps it working for STALE_MS — the edge is exclusive', async () => {
  const { w, clock } = await clocked();
  try {
    const launchedAt = clock.now - 60_000;
    // No row for this agent at all: nothing but the launch time speaks for it.
    await appendMain(w, [...agentLaunch(new Date(launchedAt).toISOString(), toolId(1), AGENT), REAL.endTurn]);
    startTracking(w);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    clock.now = launchedAt + STALE_MS - 1;
    await sleep(NO_REPORT_MS);
    assert.deepEqual(turnsOf(w), ['working'], 'one ms before STALE_MS it is still alive');
    clock.now = launchedAt + STALE_MS;
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    assert.deepEqual(turnsOf(w), ['working', 'waiting']);
  } finally {
    await w.cleanup();
  }
});

test('C2 watcher: a launch line WITHOUT a timestamp is alive for STALE_MS from first sight, never forever', async () => {
  const { w, clock } = await clocked();
  try {
    const firstSight = clock.now;
    await appendMain(w, [toolUseLine(undefined, toolId(1), 'Agent'), ...agentLaunch(agoIso(clock.now, 0), toolId(1), AGENT).slice(1), REAL.endTurn]);
    startTracking(w);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    clock.now = firstSight + STALE_MS;
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
  } finally {
    await w.cleanup();
  }
});

test('C2 watcher: a SendMessage that resumed a subagent keeps it working while that agent runs', async () => {
  const { w, clock } = await clocked();
  try {
    await runningAgent(w, AGENT);
    const old = agoIso(clock.now, STALE_MS + 60_000);
    await appendMain(w, [
      toolUseLine(old, toolId(1), 'SendMessage'),
      toolResultLine(old, toolId(1), [{ type: 'text', text: resumeText(AGENT) }]),
      REAL.endTurn,
    ]);
    startTracking(w);
    assert.equal((await waitForReport(w.seen, (r) => r.turn !== undefined)).turn, 'working');
    await appendLines(w.dir, AGENT, [assistantLine(new Date().toISOString(), 'm1', { output_tokens: 1 }, 'end_turn')]);
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
  } finally {
    await w.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Notifications and questions
// ---------------------------------------------------------------------------

test('C2 watcher: the notification closes the launch — a user line, then Claude ends its turn: waiting', async () => {
  const { w, clock } = await clocked();
  try {
    await appendMain(w, [REAL.prompt, ...agentLaunch(agoIso(clock.now, 1_000), toolId(1), AGENT), REAL.endTurn]);
    startTracking(w);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    // Claude takes the result up (working), then ends its turn with nothing left open.
    await appendMain(w, [notificationLine(agoIso(clock.now, 0), toolId(1), AGENT)]);
    await sleep(NO_REPORT_MS);
    assert.deepEqual(turnsOf(w), ['working']);
    await appendMain(w, [REAL.endTurn]);
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    assert.deepEqual(turnsOf(w), ['working', 'waiting']);
  } finally {
    await w.cleanup();
  }
});

test('C2 watcher: a notification delivered as a queued_command ATTACHMENT closes it at once', async () => {
  const { w, clock } = await clocked();
  try {
    await appendMain(w, [...agentLaunch(agoIso(clock.now, 1_000), toolId(1), AGENT), REAL.endTurn]);
    startTracking(w);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    await appendMain(w, [queuedNotificationLine(agoIso(clock.now, 0), toolId(1), AGENT)]);
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
  } finally {
    await w.cleanup();
  }
});

test('C2 watcher: a notification for ANOTHER id leaves the launch open', async () => {
  const { w, clock } = await clocked();
  try {
    await appendMain(w, [...agentLaunch(agoIso(clock.now, 1_000), toolId(1), AGENT), REAL.endTurn]);
    startTracking(w);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    await appendMain(w, [queuedNotificationLine(agoIso(clock.now, 0), toolId(2), 'bhx73a1eg')]);
    await sleep(NO_REPORT_MS);
    assert.deepEqual(turnsOf(w), ['working']);
  } finally {
    await w.cleanup();
  }
});

test('C2 watcher: a question WINS over background work — waiting while the agent runs; the answer works again', async () => {
  const { w, clock } = await clocked();
  try {
    await runningAgent(w, AGENT);
    await appendMain(w, [...agentLaunch(agoIso(clock.now, 1_000), toolId(1), AGENT), questionLine(agoIso(clock.now, 0), toolId(2))]);
    startTracking(w);
    assert.equal((await waitForReport(w.seen, (r) => r.turn !== undefined)).turn, 'waiting');
    await appendMain(w, [answerLine(agoIso(clock.now, 0), toolId(2))]);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    // The turn ends while the agent still runs: working stays.
    await appendMain(w, [REAL.endTurn]);
    await sleep(NO_REPORT_MS);
    assert.deepEqual(turnsOf(w), ['waiting', 'working']);
  } finally {
    await w.cleanup();
  }
});

test('C2 watcher: a main verdict of working is working with or without launches; no launch leaves waiting as it is', async () => {
  const { w, clock } = await clocked();
  try {
    await appendMain(w, [...agentLaunch(agoIso(clock.now, STALE_MS * 4), toolId(1), AGENT), REAL.toolUse]);
    startTracking(w);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    await appendMain(w, [REAL.endTurn]);
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
  } finally {
    await w.cleanup();
  }
});

test('C2 watcher: a transcript that SHRANK forgets its launches with its verdict', async () => {
  const { w, clock } = await clocked();
  try {
    await appendMain(w, [...agentLaunch(agoIso(clock.now, 1_000), toolId(1), AGENT), REAL.endTurn]);
    startTracking(w);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    await writeFile(mainFile(w), `${REAL.endTurn}\n`);
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
  } finally {
    await w.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Workflows (server/agents-workflows.ts)
// ---------------------------------------------------------------------------

test('C2 watcher: a workflow run keeps it working while an agent transcript in its directory is fresh', async () => {
  const { w, clock } = await clocked();
  try {
    const file = await workflowAgent(w, RUN, 'agent-a06017135345ffb54.jsonl', 0);
    await appendMain(w, [...workflowLaunch(agoIso(clock.now, STALE_MS + 60_000), toolId(1), RUN), REAL.endTurn]);
    startTracking(w);
    assert.equal((await waitForReport(w.seen, (r) => r.turn !== undefined)).turn, 'working');
    const stale = (Date.now() - STALE_MS - 5_000) / 1_000;
    await utimes(file, stale, stale);
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    assert.deepEqual(turnsOf(w), ['working', 'waiting']);
    assert.equal(w.seen.at(-1)?.agents.length, 0, 'workflow agents do not join the B7 table');
  } finally {
    await w.cleanup();
  }
});

test('C2 watcher: in a run directory only a REGULAR `agent-<hex>.jsonl` is a sign of life', async () => {
  const { w, clock } = await clocked();
  try {
    const live = await workflowAgent(w, RUN, 'agent-a1.jsonl', STALE_MS + 5_000);
    const dir = join(w.dir, 'workflows', RUN);
    // Fresh, but not a name (or a kind) that counts.
    await writeFile(join(dir, 'agent-a1.meta.json'), '{}');
    await writeFile(join(dir, 'notes.jsonl'), 'x');
    await writeFile(join(dir, 'agent-ZZ.jsonl'), 'x');
    await writeFile(join(dir, 'agent-a2.jsonl.bak'), 'x');
    await mkdir(join(dir, 'agent-bb.jsonl'));
    await writeFile(join(w.root, 'fresh-target.jsonl'), 'x');
    await symlink(join(w.root, 'fresh-target.jsonl'), join(dir, 'agent-cc.jsonl'));
    await appendMain(w, [...workflowLaunch(agoIso(clock.now, STALE_MS + 60_000), toolId(1), RUN), REAL.endTurn]);
    startTracking(w);
    assert.equal((await waitForReport(w.seen, (r) => r.turn !== undefined)).turn, 'waiting');
    const now = Date.now() / 1_000;
    await utimes(live, now, now);
    await waitForReport(w.seen, (r) => r.turn === 'working');
  } finally {
    await w.cleanup();
  }
});

test('C2 watcher: a workflow run directory reached through a SYMLINK is refused — even inside the root — and logged once', async () => {
  for (const at of ['run', 'workflows'] as const) {
    const { w, clock } = await clocked();
    try {
      // A fresh agent transcript, but in a directory elsewhere under the root.
      const elsewhere = join(w.root, 'elsewhere');
      await mkdir(join(elsewhere, RUN), { recursive: true });
      await writeFile(join(elsewhere, RUN, 'agent-a1.jsonl'), 'x');
      if (at === 'run') {
        await mkdir(join(w.dir, 'workflows'), { recursive: true });
        await symlink(join(elsewhere, RUN), join(w.dir, 'workflows', RUN));
      } else {
        await symlink(elsewhere, join(w.dir, 'workflows'));
      }
      await appendMain(w, [...workflowLaunch(agoIso(clock.now, STALE_MS + 60_000), toolId(1), RUN), REAL.endTurn]);
      startTracking(w);
      assert.equal((await waitForReport(w.seen, (r) => r.turn !== undefined)).turn, 'waiting', at);
      await sleep(MANY_POLLS_MS);
      const logged = w.logs.filter((l) => l.includes('workflow run directory resolves elsewhere, refused'));
      assert.equal(logged.length, 1, `${at}: logged once, not once per poll`);
      assert.deepEqual(turnsOf(w), ['waiting'], at);
    } finally {
      await w.cleanup();
    }
  }
});

test('C2 watcher: a workflow launch with no run directory yet is timed by its launch alone', async () => {
  const { w, clock } = await clocked();
  try {
    const launchedAt = clock.now - 1_000;
    await appendMain(w, [...workflowLaunch(new Date(launchedAt).toISOString(), toolId(1), RUN), REAL.endTurn]);
    startTracking(w);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    clock.now = launchedAt + STALE_MS;
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
  } finally {
    await w.cleanup();
  }
});

// ---------------------------------------------------------------------------
// turnEnded (C1) follows the session verdict
// ---------------------------------------------------------------------------

test('C2 turnEnded: an ended turn with a subagent still running is NOT news; the real end after its notification is', async () => {
  const s = await wired();
  try {
    await appendMain(s.w, [REAL.prompt]);
    s.w.watcher.track('sess-1', s.w.dir);
    await waitInfo(s.client, (i) => i.turn === 'working', 'working');
    // The launch and the ended turn land BEFORE the agent's row exists, so the
    // poll that shows the row has read them: a waiting blip would be visible.
    await appendMain(s.w, [...agentLaunch(new Date().toISOString(), toolId(1), AGENT), REAL.endTurn]);
    await runningAgent(s.w, AGENT);
    const running = await waitInfo(s.client, (i) => i.agents?.length === 1, 'the agent row');
    assert.equal(running.turn, 'working');
    assert.equal('turnEnded' in running, false, 'Claude is not done: no mascot');
    assert.equal(s.client.infoFrames().some((i) => i.turnEnded === true), false, 'never set on the way');

    await appendMain(s.w, [notificationLine(new Date().toISOString(), toolId(1), AGENT), REAL.endTurn]);
    const ended = await waitInfo(s.client, (i) => i.turn === 'waiting', 'waiting');
    assert.equal(ended.turnEnded, true, 'the session verdict went working -> waiting');
    assert.equal(typeof ended.pendingSince, 'string');
  } finally {
    await s.cleanup();
  }
});

test('C2 turnEnded: a question sets it at once; the answer clears it', async () => {
  const s = await wired();
  try {
    await appendMain(s.w, [REAL.prompt, ...agentLaunch(new Date().toISOString(), toolId(1), AGENT)]);
    s.w.watcher.track('sess-1', s.w.dir);
    await waitInfo(s.client, (i) => i.turn === 'working', 'working');
    await appendMain(s.w, [questionLine(new Date().toISOString(), toolId(2))]);
    const asked = await waitInfo(s.client, (i) => i.turn === 'waiting', 'the question');
    assert.equal(asked.turnEnded, true, 'a question brings the mascot, background work or not');
    await appendMain(s.w, [answerLine(new Date().toISOString(), toolId(2))]);
    const answered = await waitInfo(s.client, (i) => i.turn === 'working' && i.turnEnded !== true, 'the answer');
    assert.equal('pendingSince' in answered, false);
  } finally {
    await s.cleanup();
  }
});

test('C2 turnEnded: first sight of an old transcript whose launch is long dead reads waiting — a first readout, not news', async () => {
  const s = await wired();
  try {
    await appendMain(s.w, [REAL.prompt, ...agentLaunch('2026-09-01T10:00:00.000Z', toolId(1), AGENT), REAL.endTurn]);
    s.w.watcher.track('sess-1', s.w.dir);
    const first = await waitInfo(s.client, (i) => i.turn !== undefined, 'a readout');
    assert.equal(first.turn, 'waiting');
    assert.equal('turnEnded' in first, false);
    await sleep(NO_REPORT_MS);
    assert.equal(s.client.infoFrames().filter((i) => i.turn !== undefined).length, 1, 'no working blip first');
  } finally {
    await s.cleanup();
  }
});

test('C2 watcher: a launch whose result line arrives TORN across two polls is still read as one', async () => {
  const { w, clock } = await clocked();
  try {
    const [use, result] = agentLaunch(agoIso(clock.now, 1_000), toolId(1), AGENT) as [string, string];
    await appendMain(w, [REAL.prompt, use]);
    await appendFile(mainFile(w), result.slice(0, 40));
    startTracking(w);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    await appendFile(mainFile(w), `${result.slice(40)}\n${REAL.endTurn}\n`);
    await sleep(NO_REPORT_MS);
    assert.deepEqual(turnsOf(w), ['working'], 'the launch was read whole: the ended turn stays working');
  } finally {
    await w.cleanup();
  }
});
