/**
 * server/agents.ts — Nocturne B11 (.claude/plans/nocturne/PLAN-B11.md): the
 * turn read from the session's OWN transcript (turnOfLine, sameReport, the
 * watcher's tail-first read, its share of the tick budget, truncation, and
 * the symlink / FIFO / parent-swap refusals at the main transcript) and the
 * list rule (d) — which running and finished rows are sent — plus the turn on
 * SessionManager's frames (turn-only reports, the exit dropping `turn`).
 *
 * How: turnOfLine on REAL-shaped lines cut down from real Claude Code 2.1.27x
 * transcripts; a real watcher over a real temp directory and a real
 * SessionManager with a frame-keeping fake client
 * (`tests/helpers/agents-fixture.ts`).
 *
 * NOT claimed here: the mutants the B11 review and mutation gates found —
 * `tests/server/agents-turn-edges.test.ts`; B7's rows —
 * `tests/server/agents-watcher.test.ts`; the pane bar that draws the turn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerMessage, SessionAgent, SessionInfo } from '../../shared/protocol.ts';
import { sameReport, turnOfLine, type AgentsReport } from '../../server/agents.ts';
import { sleep, makeTempDir } from '../helpers/helpers.ts';
import {
  UUID,
  OTHER_UUID,
  MAX_RUNNING_ROWS,
  TURN_TAIL_BYTES,
  assistantLine,
  makeWatcher,
  writeMeta,
  waitForReport,
  FakeClient,
  makeManager,
  ROW,
  report,
  REAL,
  mainFile,
  appendMain,
  filler,
  plantAgents,
} from '../helpers/agents-fixture.ts';

// ---------------------------------------------------------------------------
// Nocturne B11 — the turn (the session's own transcript) and the list rule
// (.claude/plans/nocturne/PLAN-B11.md)
// ---------------------------------------------------------------------------

test('turnOfLine: every rule of PLAN-B11 § The turn rule, on real-shaped lines', () => {
  // A prompt, a tool_result and a task-notification start (or continue) a turn.
  assert.equal(turnOfLine(REAL.prompt), 'working');
  assert.equal(turnOfLine(REAL.toolResult), 'working');
  assert.equal(turnOfLine(REAL.taskNotification), 'working');
  // An interrupt ends it — both of Claude Code's wordings.
  assert.equal(turnOfLine(REAL.interrupt), 'waiting');
  assert.equal(turnOfLine(REAL.interruptForTool), 'waiting');
  // A local slash command and its output start nothing.
  for (const line of [REAL.commandName, REAL.commandMessage, REAL.commandStdout, REAL.commandStderr, REAL.commandCaveat]) {
    assert.equal(turnOfLine(line), undefined, line);
  }
  // Meta and sidechain lines never count, whatever they say.
  assert.equal(turnOfLine(REAL.meta), undefined);
  assert.equal(turnOfLine(REAL.sidechain), undefined);
  assert.equal(
    turnOfLine(JSON.stringify({ type: 'assistant', isSidechain: true, message: { stop_reason: 'end_turn' } })),
    undefined,
  );
  // An API error / a synthetic message: Claude is not going on by itself.
  assert.equal(turnOfLine(REAL.synthetic), 'waiting');
  assert.equal(turnOfLine(REAL.apiError), 'waiting');
  assert.equal(turnOfLine(REAL.syntheticOnly), 'waiting');
  // Stop reasons.
  for (const stop of ['end_turn', 'stop_sequence', 'refusal', 'max_tokens']) {
    assert.equal(turnOfLine(assistantLine('2026-09-22T10:00:00.000Z', 'm', undefined, stop)), 'waiting', stop);
  }
  for (const stop of ['tool_use', 'pause_turn', null]) {
    assert.equal(turnOfLine(assistantLine('2026-09-22T10:00:00.000Z', 'm', undefined, stop)), 'working', String(stop));
  }
  assert.equal(turnOfLine(JSON.stringify({ type: 'assistant', message: { id: 'm' } })), 'working', 'no stop_reason key');
  assert.equal(turnOfLine(JSON.stringify({ type: 'assistant' })), 'working', 'no message at all');
  // The first TEXT block decides, not the first block.
  assert.equal(
    turnOfLine(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'image', source: {} }, { type: 'text', text: '[Request interrupted by user]' }] },
      }),
    ),
    'waiting',
  );
  // A prefix only counts at the START of the text.
  assert.equal(
    turnOfLine(JSON.stringify({ type: 'user', message: { content: 'what does <command-name> mean?' } })),
    'working',
  );
});

test('turnOfLine: total — garbage, other types and hostile shapes never throw and never count', () => {
  for (const line of [
    '',
    'not json',
    '{"type":"user"',
    'null',
    '42',
    '"user"',
    '[]',
    '[{"type":"user"}]',
    JSON.stringify({ type: 'system', subtype: 'turn_duration' }),
    JSON.stringify({ type: 'attachment' }),
    JSON.stringify({ type: 'summary' }),
    JSON.stringify({ type: 'User', message: { content: 'x' } }),
    JSON.stringify({ message: { stop_reason: 'end_turn' } }),
  ]) {
    assert.equal(turnOfLine(line), undefined, line);
  }
  // Wrong-typed fields inside a counting type: still a verdict, never a throw.
  assert.equal(turnOfLine(JSON.stringify({ type: 'user', message: { content: 42 } })), 'working');
  assert.equal(turnOfLine(JSON.stringify({ type: 'user', message: { content: [null, 7, { type: 'text', text: 9 }] } })), 'working');
  assert.equal(turnOfLine(JSON.stringify({ type: 'user', message: 'x' })), 'working');
  assert.equal(turnOfLine(JSON.stringify({ type: 'assistant', message: { stop_reason: 7 } })), 'working');
  assert.equal(turnOfLine(JSON.stringify({ type: 'assistant', isApiErrorMessage: 'true', message: { stop_reason: 'tool_use' } })), 'working', 'only a real true');
  assert.equal(turnOfLine(JSON.stringify({ type: 'user', isMeta: 'true', message: { content: 'x' } })), 'working', 'only a real true');
  assert.equal(turnOfLine(undefined as unknown as string), undefined);
});

test('sameReport: rows, both counts and the turn all count', () => {
  const a: AgentsReport = { agents: [], counts: { running: 1, finished: 2 }, turn: 'working' };
  assert.equal(sameReport(undefined, undefined), true);
  assert.equal(sameReport(a, undefined), false);
  assert.equal(sameReport(undefined, a), false);
  assert.equal(sameReport(a, { agents: [], counts: { running: 1, finished: 2 }, turn: 'working' }), true);
  assert.equal(sameReport(a, { ...a, turn: 'waiting' }), false);
  assert.equal(sameReport(a, { agents: [], counts: { running: 1, finished: 2 } }), false, 'turn absent is a change');
  assert.equal(sameReport(a, { ...a, counts: { running: 2, finished: 2 } }), false);
  assert.equal(sameReport(a, { ...a, counts: { running: 1, finished: 3 } }), false);
  const row: SessionAgent = { id: 'aa', name: 'n', task: 't', startedAt: '2026-09-22T10:00:00.000Z', tokens: 1, state: 'running' };
  assert.equal(sameReport({ ...a, agents: [row] }, { ...a, agents: [{ ...row }] }), true);
  assert.equal(sameReport({ ...a, agents: [row] }, { ...a, agents: [{ ...row, tokens: 2 }] }), false);
});

test('watcher: a MISSING transcript reads waiting — a turn-only report, no agents, no subagents dir needed', async () => {
  // Claude Code creates the transcript at the first prompt: until then the
  // session sits at that prompt. The subagents dir does not exist either (most
  // sessions never spawn one), and the report still goes out.
  const w = await makeWatcher({ create: false });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    const report = await waitForReport(w.seen, (r) => r.turn === 'waiting');
    assert.deepEqual(report, { agents: [], counts: { running: 0, finished: 0 }, turn: 'waiting' });
    await sleep(120);
    assert.equal(w.seen.length, 1, 'an unchanged turn is delivered once');
  } finally {
    await w.cleanup();
  }
});

test('watcher: the turn follows the transcript as it grows — prompt, tool, answer, interrupt', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await appendMain(w, [REAL.prompt]);
    w.watcher.track('sess-1', w.dir);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    await appendMain(w, [REAL.toolUse, REAL.toolResult]);
    await sleep(100);
    assert.equal(w.seen[w.seen.length - 1]?.report.turn, 'working');
    await appendMain(w, [REAL.endTurn]);
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    // A local command after the answer changes nothing.
    await appendMain(w, [REAL.commandName, REAL.commandStdout]);
    await sleep(100);
    assert.equal(w.seen[w.seen.length - 1]?.report.turn, 'waiting');
    await appendMain(w, [REAL.prompt]);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    await appendMain(w, [REAL.interrupt]);
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    // Only real changes were delivered: working, waiting, working, waiting.
    assert.deepEqual(
      w.seen.map((s) => s.report.turn),
      ['working', 'waiting', 'working', 'waiting'],
    );
  } finally {
    await w.cleanup();
  }
});

test('watcher: a transcript with no counting line has NO turn and says nothing', async () => {
  const w = await makeWatcher({ create: false });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    await appendMain(w, [REAL.meta, REAL.commandName, JSON.stringify({ type: 'system' }), 'torn{']);
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await sleep(200);
    assert.equal(w.seen.length, 0, 'no agents and no turn: nothing to announce');
  } finally {
    await w.cleanup();
  }
});

test('watcher: first sight reads only the TAIL — a counting line before the last MiB is never seen', async () => {
  const w = await makeWatcher({ create: false });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    // A prompt at the head, then more than TURN_TAIL_BYTES of lines that do
    // not count: read from 0 the verdict would be 'working'; the tail says nothing.
    await writeFile(mainFile(w), `${REAL.prompt}\n${filler(TURN_TAIL_BYTES + 64 * 1024)}`, { mode: 0o600 });
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await sleep(200);
    assert.equal(w.seen.length, 0, `the head was read; got ${JSON.stringify(w.seen[0]?.report)}`);
    // And from here on it is incremental: the next line is seen.
    await appendMain(w, [REAL.endTurn]);
    const report = await waitForReport(w.seen, (r) => r.turn !== undefined);
    assert.equal(report.turn, 'waiting');
  } finally {
    await w.cleanup();
  }
});

test('watcher: the tail drops its PARTIAL first line, and keeps one that starts exactly at the boundary', async () => {
  // (a) A counting line straddling the boundary is dropped: its second half is
  //     not JSON, and it must not be half-parsed either.
  const a = await makeWatcher({ create: false });
  try {
    await mkdir(join(a.root, '-slug'), { recursive: true });
    const tail = filler(TURN_TAIL_BYTES - 100); // strictly less than the tail
    const straddle = JSON.stringify({ type: 'user', message: { content: 'go' }, pad: 'y'.repeat(400) });
    const body = `${filler(8 * 1024)}${straddle}\n${tail}`;
    // The boundary (size - TAIL) falls inside `straddle`.
    assert.ok(Buffer.byteLength(tail) < TURN_TAIL_BYTES && Buffer.byteLength(tail) + straddle.length + 1 > TURN_TAIL_BYTES);
    await writeFile(mainFile(a), body, { mode: 0o600 });
    a.watcher.start((id, report) => a.seen.push({ id, agents: report.agents, report }));
    a.watcher.track('sess-1', a.dir);
    await sleep(200);
    assert.equal(a.seen.length, 0, `the partial first line counted; got ${JSON.stringify(a.seen[0]?.report)}`);
  } finally {
    await a.cleanup();
  }
  // (b) A whole line beginning EXACTLY at size - TAIL is kept.
  const b = await makeWatcher({ create: false });
  try {
    await mkdir(join(b.root, '-slug'), { recursive: true });
    const first = `${REAL.endTurn}\n`;
    const rest = filler(TURN_TAIL_BYTES - first.length - 2_000);
    const pad = TURN_TAIL_BYTES - first.length - Buffer.byteLength(rest);
    const tail = `${first}${rest}${'z'.repeat(pad - 1)}\n`; // junk line: not JSON, skipped
    assert.equal(Buffer.byteLength(tail), TURN_TAIL_BYTES);
    await writeFile(mainFile(b), `${REAL.prompt}\n${filler(4 * 1024)}${tail}`, { mode: 0o600 });
    b.watcher.start((id, report) => b.seen.push({ id, agents: report.agents, report }));
    b.watcher.track('sess-1', b.dir);
    const report = await waitForReport(b.seen, (r) => r.turn !== undefined);
    assert.equal(report.turn, 'waiting', 'the line at the boundary is the verdict, not the prompt before it');
  } finally {
    await b.cleanup();
  }
});

test('watcher: the main transcript SHARES the tick budget — its tail is read over several ticks', async () => {
  const w = await makeWatcher({ create: false, readBudgetBytes: 256 * 1024 });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    // Prompt first, the answer 600 KiB later: one 256 KiB tick sees the prompt
    // only, and the answer arrives a few ticks on.
    await writeFile(mainFile(w), `${REAL.prompt}\n${filler(600 * 1024)}${REAL.endTurn}\n`, { mode: 0o600 });
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    assert.equal(w.seen[0]?.report.turn, 'working', 'the first tick could not reach the answer');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a main transcript that SHRANK is re-read from its tail with the verdict reset', async () => {
  const w = await makeWatcher({ create: false });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    await appendMain(w, [REAL.prompt, REAL.toolUse, REAL.toolResult, REAL.endTurn]);
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    await writeFile(mainFile(w), `${REAL.prompt}\n`, { mode: 0o600 });
    await waitForReport(w.seen, (r) => r.turn === 'working');
    assert.equal(w.logs.some((l) => l.includes('transcript shrank, re-reading its tail')), true, w.logs.join(' | '));
  } finally {
    await w.cleanup();
  }
});

test('watcher: a SYMLINK at the main transcript is refused — even one pointing inside the root — and logged once', async () => {
  const w = await makeWatcher({ create: false });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    const decoy = join(w.root, '-slug', `${OTHER_UUID}.jsonl`);
    await writeFile(decoy, `${REAL.prompt}\n`, { mode: 0o600 });
    await symlink(decoy, mainFile(w));
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await sleep(250);
    assert.equal(w.seen.length, 0, `followed the symlink; got ${JSON.stringify(w.seen[0]?.report)}`);
    const refusals = w.logs.filter((l) => l.includes('resolves outside the projects root, refused'));
    assert.equal(refusals.length, 1, `once, not once per poll; logs ${JSON.stringify(w.logs)}`);
    // A symlink out of the tree, to a file that would say something: same.
    const outside = realpathSync(await makeTempDir('ai-sm-turn-out-'));
    try {
      await writeFile(join(outside, 'secret.jsonl'), `${REAL.endTurn}\n`, { mode: 0o600 });
      await rm(mainFile(w));
      await symlink(join(outside, 'secret.jsonl'), mainFile(w));
      await sleep(200);
      assert.equal(w.seen.length, 0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    // Replaced by a real file: read again, and the recovery is logged.
    await rm(mainFile(w));
    await writeFile(mainFile(w), `${REAL.endTurn}\n`, { mode: 0o600 });
    const report = await waitForReport(w.seen, (r) => r.turn !== undefined);
    assert.equal(report.turn, 'waiting');
    assert.equal(w.logs.some((l) => l.includes('now inside the projects root, reading it again')), true);
  } finally {
    await w.cleanup();
  }
});

test('watcher: a DANGLING symlink at the main transcript is not "missing" — no turn, never waiting', async () => {
  const w = await makeWatcher({ create: false });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    await symlink(join(w.root, 'nowhere.jsonl'), mainFile(w));
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await sleep(200);
    assert.equal(w.seen.length, 0, `got ${JSON.stringify(w.seen[0]?.report)}`);
  } finally {
    await w.cleanup();
  }
});

test('watcher: a PARENT directory swapped for a symlink out of the root is refused per poll', async () => {
  // subagentsDirFor checked the parent once, at track(); the watcher checks it
  // again on every poll, so a symlink planted afterwards is caught.
  const w = await makeWatcher({ create: false });
  const outside = realpathSync(await makeTempDir('ai-sm-turn-parent-'));
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    await appendMain(w, [REAL.prompt]);
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    await writeFile(join(outside, `${UUID}.jsonl`), `${REAL.endTurn}\n`, { mode: 0o600 });
    await rm(join(w.root, '-slug'), { recursive: true, force: true });
    await symlink(outside, join(w.root, '-slug'));
    // The verdict goes AWAY (refused), it never becomes the outside file's 'waiting'.
    const report = await waitForReport(w.seen, (r) => r.turn === undefined);
    assert.deepEqual(report, { agents: [], counts: { running: 0, finished: 0 } });
    await sleep(150);
    assert.equal(w.seen.some((s) => s.report.turn === 'waiting'), false);
    assert.equal(w.logs.filter((l) => l.includes('resolves outside the projects root, refused')).length, 1);
  } finally {
    await w.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test('watcher: a FIFO at the main transcript never blocks the poll and gives no turn', async () => {
  const w = await makeWatcher();
  try {
    execFileSync('mkfifo', [mainFile(w)]);
    await writeMeta(w.dir, 'ae', { agentType: 'still-polled', description: '' });
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    const report = await waitForReport(w.seen, (r) => r.agents.length === 1);
    assert.equal(report.turn, undefined);
  } finally {
    await w.cleanup();
  }
});

test('watcher: a tracked directory not shaped `<parent>/<uuid>/subagents` derives no transcript', async () => {
  const w = await makeWatcher({ create: false });
  try {
    const odd = join(w.root, '-slug', 'not-a-uuid', 'subagents');
    await mkdir(odd, { recursive: true });
    await writeFile(join(w.root, '-slug', 'not-a-uuid.jsonl'), `${REAL.prompt}\n`, { mode: 0o600 });
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', odd);
    await sleep(200);
    assert.equal(w.seen.length, 0);
  } finally {
    await w.cleanup();
  }
});

for (const [running, finished, rows, label] of [
  [6, 10, ['run-0', 'run-1', 'run-2', 'run-3'], '4 rows, +2 working, +10 finished'],
  [3, 5, ['run-0', 'run-1', 'run-2', 'fin-4'], '3 rows + the latest finished, +4 finished'],
  [4, 2, ['run-0', 'run-1', 'run-2', 'run-3'], '4 rows, +2 finished'],
  [0, 12, ['fin-11'], '1 finished row, +11 finished'],
] as const) {
  test(`watcher: the list rule, B11 (d) — ${running} running + ${finished} finished → ${label}`, async () => {
    const w = await makeWatcher();
    try {
      w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
      await plantAgents(w.dir, running, finished);
      w.watcher.track('sess-1', w.dir);
      const report = await waitForReport(w.seen, (r) => r.counts.running === running && r.counts.finished === finished);
      assert.deepEqual(report.agents.map((r) => r.name), rows);
      // What the frontend derives from it: `+N working` and `+N finished`.
      const runningRows = report.agents.filter((r) => r.state === 'running').length;
      const finishedRows = report.agents.length - runningRows;
      assert.equal(runningRows <= MAX_RUNNING_ROWS, true);
      assert.equal(finishedRows <= 1, true);
      assert.equal(finishedRows === 1, running < MAX_RUNNING_ROWS, 'a finished row exactly when fewer than 4 run');
    } finally {
      await w.cleanup();
    }
  });
}

test('watcher: agents AND a turn travel in one report; the turn changing alone is a delivery', async () => {
  const w = await makeWatcher();
  try {
    await plantAgents(w.dir, 1, 0);
    await appendMain(w, [REAL.prompt, REAL.toolUse]);
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    const first = await waitForReport(w.seen, (r) => r.agents.length === 1 && r.turn === 'working');
    assert.deepEqual(first.counts, { running: 1, finished: 0 });
    const calls = w.seen.length;
    // The orchestrator ends its turn while its agent still runs: waiting.
    await appendMain(w, [REAL.endTurn]);
    const next = await waitForReport(w.seen, (r) => r.turn === 'waiting');
    assert.equal(w.seen.length, calls + 1);
    assert.deepEqual(next.agents.map((r) => r.name), ['run-0'], 'the rows are unchanged');
  } finally {
    await w.cleanup();
  }
});

test('SessionManager.setReport: a turn-only report sets `turn` and no agent fields; the turn moving is one frame', async () => {
  const m = await makeManager();
  try {
    const info = m.manager.create({ command: 'bash', args: ['-c', 'sleep 30'], cwd: m.root, cols: 80, rows: 24 });
    const client = new FakeClient();
    assert.equal(m.manager.attach(info.id, client.asWs()), true);
    const base = client.infoFrames().length;

    m.manager.setReport(info.id, report([], { turn: 'waiting' }));
    assert.equal(client.infoFrames().length, base + 1);
    const s = client.infoFrames()[base] as SessionInfo;
    assert.equal(s.turn, 'waiting');
    assert.equal('agents' in s, false, 'no agents: absent, never an empty table');
    assert.equal('agentCounts' in s, false);

    m.manager.setReport(info.id, report([], { turn: 'waiting' }));
    assert.equal(client.infoFrames().length, base + 1, 'unchanged: no frame');

    m.manager.setReport(info.id, report([], { turn: 'working' }));
    assert.equal(client.infoFrames().length, base + 2);
    assert.equal(m.manager.get(info.id)?.turn, 'working');

    // Unknown again (a refused path): the field goes absent, one frame.
    m.manager.setReport(info.id, report([]));
    assert.equal(client.infoFrames().length, base + 3);
    assert.equal('turn' in (client.infoFrames()[base + 2] as SessionInfo), false);
    assert.equal(m.manager.get(info.id)?.turn, undefined);
    m.manager.destroy(info.id);
  } finally {
    await m.cleanup();
  }
});

test('SessionManager: the exit drops `turn` in the frame before `exit`, and a later report cannot bring it back', async () => {
  const m = await makeManager();
  try {
    const info = m.manager.create({ command: 'bash', args: ['-c', 'sleep 0.3'], cwd: m.root, cols: 80, rows: 24 });
    const client = new FakeClient();
    assert.equal(m.manager.attach(info.id, client.asWs()), true);
    m.manager.setReport(info.id, report([], { turn: 'working' }));
    assert.equal(m.manager.get(info.id)?.turn, 'working');

    const deadline = Date.now() + 10_000;
    while (m.manager.get(info.id)?.status !== 'exited') {
      if (Date.now() >= deadline) throw new Error('the session never exited');
      await sleep(20);
    }
    assert.equal(m.manager.get(info.id)?.turn, undefined);
    const exitAt = client.frames.findIndex((f) => f.type === 'exit');
    assert.ok(exitAt > 0);
    const before = client.frames[exitAt - 1];
    assert.equal(before?.type, 'info', 'one info frame right before the exit');
    assert.equal('turn' in (before as Extract<ServerMessage, { type: 'info' }>).session, false);

    // A poll racing the untrack: ignored on an exited session.
    const frames = client.frames.length;
    m.manager.setReport(info.id, report([ROW], { turn: 'waiting' }));
    assert.equal(m.manager.get(info.id)?.turn, undefined);
    assert.equal(m.manager.get(info.id)?.agents, undefined);
    assert.equal(client.frames.length, frames, 'no frame');
    assert.equal(m.logs.some((l) => l.includes(`${info.id} agents ignored: session exited`)), true);
    m.manager.destroy(info.id);
  } finally {
    await m.cleanup();
  }
});
