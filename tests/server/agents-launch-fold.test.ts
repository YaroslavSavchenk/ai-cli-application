/**
 * server/agents-fold.ts — Nocturne C2 (.claude/plans/nocturne/PLAN-C2.md §
 * The rule 1-2): the session transcript's fold, foldTurnLine. A question
 * (`AskUserQuestion`, `ExitPlanMode`) reads 'waiting' with the question flag
 * until its answer; a background launch (`Agent` / `Task` / `Workflow`, and a
 * `SendMessage` that resumed a subagent) stays open until a task
 * notification names its tool_use id — as a `user` line or as a
 * `queued_command` attachment. Background shells, foreground calls, unknown
 * ids, sidechain and meta lines change nothing; both maps are capped.
 *
 * How: the pure fold called directly on lines shaped like this machine's
 * transcripts (`tests/helpers/agents-fixture.ts` § C2) — no I/O, the clock
 * passed in.
 *
 * Why it matters: a launch the fold misses lets the mascot come while
 * Claude's subagents still work (the user's report that started C2); a close
 * it misses keeps a session 'Working' until the liveness fallback gives up.
 *
 * NOT claimed here: the liveness rule and the session verdict (agents,
 * workflow directories, the clock) — `tests/server/agents-launch-watcher.test.ts`;
 * ExitPlanMode's real line shape (none on this machine; built like
 * AskUserQuestion's).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldTurnLine, newTurnFold, type TurnFold } from '../../server/agents-fold.ts';
import {
  REAL,
  METADATA_LINES,
  agentLaunch,
  agoIso,
  answerLine,
  asyncAgentText,
  notificationLine,
  notificationText,
  queuedNotificationLine,
  questionLine,
  resumeText,
  toolId,
  toolResultLine,
  toolUseLine,
  workflowLaunch,
  workflowText,
} from '../helpers/agents-fixture.ts';

const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const AT = '2026-09-26T11:59:00.000Z';
const AGENT = 'a790bda5878f4d7ef';
const RUN = 'wf_998cfcac-d41';

function fold(lines: string[], seenMs = NOW): TurnFold {
  const acc = newTurnFold();
  for (const line of lines) foldTurnLine(acc, line, seenMs);
  return acc;
}

/** The open launches as `[tool_use id, kind, ref]` rows, oldest first. */
function open(acc: TurnFold): [string, string, string][] {
  return [...acc.launches].map(([id, l]) => [id, l.kind, l.ref]);
}

// ---------------------------------------------------------------------------
// Questions (§ The rule 1)
// ---------------------------------------------------------------------------

test('C2 fold: AskUserQuestion and ExitPlanMode read waiting WITH the question flag; the answer reads working', () => {
  for (const name of ['AskUserQuestion', 'ExitPlanMode']) {
    const acc = fold([REAL.prompt, questionLine(AT, toolId(1), name)]);
    assert.equal(acc.turn, 'waiting', name);
    assert.equal(acc.asking, true, `${name}: a question, not an ended turn`);
    // Claude Code writes only metadata until the answer: none of it counts.
    for (const line of METADATA_LINES) foldTurnLine(acc, line, NOW);
    assert.equal(acc.turn, 'waiting', `${name}: metadata changes nothing`);
    assert.equal(acc.asking, true, `${name}: metadata changes nothing`);
    foldTurnLine(acc, answerLine(AT, toolId(1)), NOW);
    assert.equal(acc.turn, 'working', `${name}: answered`);
    assert.equal(acc.asking, false, `${name}: answered`);
  }
});

test('C2 fold: an ended turn and an interrupt are waiting WITHOUT the question flag; a later line clears the flag', () => {
  assert.deepEqual([fold([REAL.endTurn]).turn, fold([REAL.endTurn]).asking], ['waiting', false]);
  // The user rejects a question with Esc: the error result, then the interrupt.
  const acc = fold([
    questionLine(AT, toolId(1)),
    toolResultLine(AT, toolId(1), "The user doesn't want to proceed with this tool use."),
    REAL.interruptForTool,
  ]);
  assert.deepEqual([acc.turn, acc.asking], ['waiting', false]);
  // A question whose line also ends the turn is still a question.
  const ended = fold([
    JSON.stringify({
      type: 'assistant',
      message: { stop_reason: 'end_turn', content: [{ type: 'tool_use', id: toolId(2), name: 'ExitPlanMode' }] },
    }),
  ]);
  assert.deepEqual([ended.turn, ended.asking], ['waiting', true]);
  // Another tool's name, or a question name in a TEXT block, is no question.
  for (const line of [
    toolUseLine(AT, toolId(3), 'AskUserQuestions'),
    JSON.stringify({ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'AskUserQuestion' }] } }),
    JSON.stringify({ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: ['AskUserQuestion'] }] } }),
  ]) {
    assert.deepEqual([fold([line]).turn, fold([line]).asking], ['working', false], line);
  }
});

test('C2 fold: a question on a sidechain or meta line is not the session asking', () => {
  for (const extra of [{ isSidechain: true }, { isMeta: true }]) {
    const acc = fold([REAL.prompt, toolUseLine(AT, toolId(1), 'AskUserQuestion', extra)]);
    assert.deepEqual([acc.turn, acc.asking], ['working', false], JSON.stringify(extra));
  }
});

// ---------------------------------------------------------------------------
// Background launches and their notifications (§ The rule 2)
// ---------------------------------------------------------------------------

test('C2 fold: an Agent launch (text-block result) stays open until a user-line notification names its tool_use id', () => {
  const acc = fold([REAL.prompt, ...agentLaunch(AT, toolId(1), AGENT), REAL.endTurn]);
  assert.deepEqual(open(acc), [[toolId(1), 'agent', AGENT]]);
  assert.equal(acc.launches.get(toolId(1))?.atMs, Date.parse(AT), 'dated by the tool_use line');
  assert.equal(acc.pending.size, 0, 'the result settled the pending tool_use');
  assert.deepEqual([acc.turn, acc.asking], ['waiting', false], 'the fold alone says the turn ended');
  foldTurnLine(acc, notificationLine(AT, toolId(1), AGENT), NOW);
  assert.deepEqual(open(acc), []);
  assert.equal(acc.turn, 'working', 'the notification starts a turn');
});

test('C2 fold: a Workflow launch (plain-string result) takes its run id from the Transcript dir, and closes by notification', () => {
  const acc = fold([...workflowLaunch(AT, toolId(1), RUN)]);
  assert.deepEqual(open(acc), [[toolId(1), 'workflow', RUN]]);
  foldTurnLine(acc, notificationLine(AT, toolId(1), 'w094cbwm2'), NOW);
  assert.deepEqual(open(acc), []);
});

test('C2 fold: a notification delivered as a queued_command ATTACHMENT closes too, and does not count as a turn line', () => {
  const acc = fold([...agentLaunch(AT, toolId(1), AGENT), REAL.endTurn]);
  foldTurnLine(acc, queuedNotificationLine(AT, toolId(1), AGENT), NOW);
  assert.deepEqual(open(acc), []);
  assert.equal(acc.turn, 'waiting', 'an attachment is not a counting line');
  // A queue-operation line naming the id is NOT a delivery: nothing closes.
  const queued = fold([...agentLaunch(AT, toolId(2), AGENT)]);
  foldTurnLine(queued, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: notificationText(toolId(2), AGENT) }), NOW);
  assert.deepEqual(open(queued), [[toolId(2), 'agent', AGENT]]);
  // Nor is an attachment of another type, or a queued prompt that is not a notice.
  foldTurnLine(queued, JSON.stringify({ type: 'attachment', attachment: { type: 'edited_text_file', prompt: notificationText(toolId(2), AGENT) } }), NOW);
  foldTurnLine(queued, JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: `hi ${notificationText(toolId(2), AGENT)}` } }), NOW);
  assert.deepEqual(open(queued), [[toolId(2), 'agent', AGENT]]);
});

test('C2 fold: a SendMessage that RESUMED a subagent is a launch of that agent; one that only queued a message is not', () => {
  const acc = fold([toolUseLine(AT, toolId(1), 'SendMessage'), toolResultLine(AT, toolId(1), [{ type: 'text', text: resumeText(AGENT) }])]);
  assert.deepEqual(open(acc), [[toolId(1), 'agent', AGENT]]);
  foldTurnLine(acc, notificationLine(AT, toolId(1), AGENT), NOW);
  assert.deepEqual(open(acc), []);
  const queued = JSON.stringify({ success: true, message: `Message queued for delivery to ${AGENT}.` });
  const cross = JSON.stringify({ success: true, message: '“Ack batch 1” → uds:/run/user/1000/x.sock' });
  for (const text of [queued, cross, '{not json', `{"success":true,"message":"Resuming agent x","pad":"${'x'.repeat(5_000)}"}`]) {
    const other = fold([toolUseLine(AT, toolId(2), 'SendMessage'), toolResultLine(AT, toolId(2), text)]);
    assert.deepEqual(open(other), [], text.slice(0, 60));
    assert.equal(other.pending.size, 0, 'settled all the same');
  }
});

test('C2 fold: the older `Task` name counts as Agent; a FOREGROUND Agent result is no launch', () => {
  const task = fold([toolUseLine(AT, toolId(1), 'Task'), toolResultLine(AT, toolId(1), asyncAgentText(AGENT))]);
  assert.deepEqual(open(task), [[toolId(1), 'agent', AGENT]], 'string content works for Agent too');
  const sync = fold([toolUseLine(AT, toolId(2), 'Agent'), toolResultLine(AT, toolId(2), [{ type: 'text', text: 'Done. The fix is in server/x.ts.' }])]);
  assert.deepEqual(open(sync), []);
  assert.equal(sync.pending.size, 0);
});

test('C2 fold: background shells never count, and launch text in ANOTHER tool\'s result is not a launch', () => {
  const acc = fold([
    toolUseLine(AT, toolId(1), 'Bash', { run_in_background: true }),
    toolResultLine(AT, toolId(1), 'Command running in background with ID: bbzefsptz. Output is being written to: /tmp/x'),
    toolUseLine(AT, toolId(2), 'Monitor'),
    toolResultLine(AT, toolId(2), 'Monitoring bbzefsptz'),
    // `echo "Async agent launched …"` in a shell prints exactly the Agent tool's text.
    toolUseLine(AT, toolId(3), 'Bash'),
    toolResultLine(AT, toolId(3), asyncAgentText(AGENT)),
    toolUseLine(AT, toolId(4), 'Read'),
    toolResultLine(AT, toolId(4), workflowText(RUN)),
  ]);
  assert.deepEqual(open(acc), []);
  assert.equal(acc.pending.size, 0, 'only launch tools are remembered at all');
});

test('C2 fold: notifications for unknown ids, a result whose tool_use came before the tail, and a notice mid-text are ignored', () => {
  const acc = fold([...agentLaunch(AT, toolId(1), AGENT)]);
  foldTurnLine(acc, notificationLine(AT, toolId(9), 'bhx73a1eg'), NOW); // a background Bash's notice
  foldTurnLine(acc, toolResultLine(AT, toolId(8), asyncAgentText('ab')), NOW); // its tool_use never seen
  foldTurnLine(acc, JSON.stringify({ type: 'user', message: { content: `see ${notificationText(toolId(1), AGENT)}` } }), NOW);
  // The id tag is looked for in the notice's head only — one quoted deep in its result does not close.
  const deep = `<task-notification>\n<task-id>x</task-id>\n<result>${'r'.repeat(2_000)}<tool-use-id>${toolId(1)}</tool-use-id></result>`;
  foldTurnLine(acc, JSON.stringify({ type: 'user', origin: { kind: 'task-notification' }, message: { content: deep } }), NOW);
  assert.deepEqual(open(acc), [[toolId(1), 'agent', AGENT]]);
});

test('C2 fold: launch lines on a sidechain or meta line, and results the same, are not the session\'s', () => {
  const side = fold([toolUseLine(AT, toolId(1), 'Agent', { isSidechain: true }), toolResultLine(AT, toolId(1), asyncAgentText(AGENT))]);
  assert.deepEqual(open(side), []);
  const sideResult = fold([
    toolUseLine(AT, toolId(2), 'Agent'),
    JSON.stringify({ ...JSON.parse(toolResultLine(AT, toolId(2), asyncAgentText(AGENT))), isSidechain: true }),
  ]);
  assert.deepEqual(open(sideResult), []);
  assert.equal(sideResult.pending.size, 1, 'the tool_use waits for a result of its own');
  const closedBySidechain = fold([...agentLaunch(AT, toolId(3), AGENT)]);
  foldTurnLine(closedBySidechain, JSON.stringify({ ...JSON.parse(notificationLine(AT, toolId(3), AGENT)), isSidechain: true }), NOW);
  assert.deepEqual(open(closedBySidechain), [[toolId(3), 'agent', AGENT]]);
});

test('C2 fold: a launch is dated by its tool_use line — else first sight; a stamp later than first sight is clamped', () => {
  const stamped = fold([...agentLaunch(agoIso(NOW, 3_600_000), toolId(1), AGENT)]);
  assert.equal(stamped.launches.get(toolId(1))?.atMs, NOW - 3_600_000);
  const unstamped = fold([toolUseLine(undefined, toolId(2), 'Agent'), toolResultLine(AT, toolId(2), asyncAgentText(AGENT))]);
  assert.equal(unstamped.launches.get(toolId(2))?.atMs, NOW, 'no stamp: the time the fold first saw it');
  for (const bad of ['2999-01-01T00:00:00.000Z', 'yesterday', '', 42]) {
    const line = JSON.stringify({ ...JSON.parse(toolUseLine(AT, toolId(3), 'Agent')), timestamp: bad });
    const acc = fold([line, toolResultLine(AT, toolId(3), asyncAgentText(AGENT))]);
    assert.equal(acc.launches.get(toolId(3))?.atMs, NOW, `timestamp ${JSON.stringify(bad)}: never later than first sight`);
  }
});

test('C2 fold: refs of the wrong shape are dropped to "" — the launch itself stays, timed only', () => {
  const cases: [string[], string][] = [
    [agentLaunch(AT, toolId(1), 'A790BDA5'), 'upper-case agent id'],
    [agentLaunch(AT, toolId(2), 'a'.repeat(33)), 'agent id past 32 hex'],
    [agentLaunch(AT, toolId(3), '../../etc'), 'agent id with a path'],
    [workflowLaunch(AT, toolId(4), 'wf_../../../etc'), 'run id with a path'],
    [workflowLaunch(AT, toolId(5), 'wf_998cfcac-d41/..'), 'run id with a trailing segment'],
    [workflowLaunch(AT, toolId(6), 'wf_998CFCAC-d41'), 'run id upper case'],
    [workflowLaunch(AT, toolId(7), `wf_998cfcac-d41${'-abc'.repeat(5)}`), 'run id past its groups'],
    [[toolUseLine(AT, toolId(8), 'Workflow'), toolResultLine(AT, toolId(8), 'Workflow launched in background. Task ID: w1\nno dir here')], 'no Transcript dir'],
    [[toolUseLine(AT, toolId(9), 'SendMessage'), toolResultLine(AT, toolId(9), JSON.stringify({ message: 'Resuming agent x', resumedAgentId: 7 }))], 'resumed id not a string'],
  ];
  for (const [lines, what] of cases) {
    const acc = fold(lines);
    assert.equal(acc.launches.size, 1, `${what}: still a launch`);
    assert.equal([...acc.launches.values()][0]?.ref, '', `${what}: no ref`);
  }
  // A longer uuid prefix of the measured run-id shape is accepted.
  assert.equal(fold(workflowLaunch(AT, toolId(10), 'wf_998cfcac-d41a-4b2c')).launches.get(toolId(10))?.ref, 'wf_998cfcac-d41a-4b2c');
});

test('C2 fold: tool_use ids of the wrong shape are never remembered', () => {
  for (const id of ['', 'x'.repeat(129), 'toolu_1 2', 'toolu_1/..', 'toolu_\u001b[31m', 42]) {
    const lines = [
      JSON.stringify({ type: 'assistant', timestamp: AT, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Agent' }] } }),
      JSON.stringify({ type: 'user', timestamp: AT, message: { content: [{ type: 'tool_result', tool_use_id: id, content: asyncAgentText(AGENT) }] } }),
    ];
    const acc = fold(lines);
    assert.equal(acc.pending.size + acc.launches.size, 0, JSON.stringify(id));
  }
  assert.equal(fold(agentLaunch(AT, 'x'.repeat(128), AGENT)).launches.size, 1, '128 characters is still an id');
});

test('C2 fold: at most 64 launches and 64 pending tool_uses are kept — the OLDEST go first', () => {
  const lines: string[] = [];
  for (let i = 0; i < 70; i++) lines.push(...agentLaunch(AT, toolId(i), AGENT));
  const acc = fold(lines);
  assert.equal(acc.launches.size, 64);
  assert.equal(acc.launches.has(toolId(5)), false, 'the 6th-oldest is forgotten');
  assert.equal(acc.launches.has(toolId(6)), true);
  assert.equal(acc.launches.has(toolId(69)), true, 'the newest is kept');

  const pending = fold(Array.from({ length: 70 }, (_, i) => toolUseLine(AT, toolId(100 + i), 'Workflow')));
  assert.equal(pending.pending.size, 64);
  assert.equal(pending.pending.has(toolId(105)), false);
  assert.equal(pending.pending.has(toolId(169)), true);
  // A result for a forgotten tool_use is simply unknown.
  foldTurnLine(pending, toolResultLine(AT, toolId(100), workflowText(RUN)), NOW);
  assert.equal(pending.launches.size, 0);
});

test('C2 fold: total — hostile shapes in the launch bookkeeping never throw', () => {
  const acc = newTurnFold();
  for (const line of [
    JSON.stringify({ type: 'assistant', message: { content: [null, 7, 'x', { type: 'tool_use' }, { type: 'tool_use', name: 'Agent', id: {} }] } }),
    JSON.stringify({ type: 'user', message: { content: [null, { type: 'tool_result' }, { type: 'tool_result', tool_use_id: 'toolu_1', content: 42 }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [null, { type: 'text', text: 7 }] }] } }),
    JSON.stringify({ type: 'attachment', attachment: 'queued_command' }),
    JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: 42 } }),
    JSON.stringify({ type: 'attachment' }),
    JSON.stringify({ type: 'user', message: { content: '<task-notification><tool-use-id></tool-use-id>' } }),
    'not json',
    '',
  ]) {
    assert.doesNotThrow(() => foldTurnLine(acc, line, NOW), line);
  }
  assert.doesNotThrow(() => foldTurnLine(acc, undefined as unknown as string, NOW));
  assert.equal(acc.launches.size, 0);
});

test('C2 fold: a launch or pending tool_use READ AGAIN becomes the newest — the cap then forgets the next-oldest', () => {
  // remember() sets the id as the NEWEST entry. A Map keeps an updated key in
  // its old place, so without the delete-then-set a launch read twice (a line
  // Claude Code wrote again) would still be the first one the cap forgets.
  const lines: string[] = [];
  for (let i = 0; i < 64; i++) lines.push(...agentLaunch(AT, toolId(i), AGENT));
  lines.push(...agentLaunch(AT, toolId(0), AGENT), ...agentLaunch(AT, toolId(64), AGENT));
  const acc = fold(lines);
  assert.equal(acc.launches.size, 64);
  assert.equal(acc.launches.has(toolId(0)), true, 'read again: now the newest, kept');
  assert.equal(acc.launches.has(toolId(1)), false, 'the oldest after it is the one forgotten');

  const uses: string[] = [];
  for (let i = 0; i < 64; i++) uses.push(toolUseLine(AT, toolId(100 + i), 'Workflow'));
  uses.push(toolUseLine(AT, toolId(100), 'Workflow'), toolUseLine(AT, toolId(164), 'Workflow'));
  const pending = fold(uses);
  assert.equal(pending.pending.size, 64);
  assert.equal(pending.pending.has(toolId(100)), true, 'pending read again: kept');
  assert.equal(pending.pending.has(toolId(101)), false, 'pending: the next-oldest forgotten');
});

test('C2 fold: the run id is the Transcript dir\'s LAST segment — parents that also hold `/subagents/workflows/` do not hide it', () => {
  const dir = `/home/you/subagents/workflows/old/.claude/projects/-home-you-app/0f2a5c8e-1b3d-4f60-9a77-2c1e5b8d4a09/subagents/workflows/${RUN}`;
  const text = `Workflow launched in background. Task ID: w094cbwm2\nSummary: s\nTranscript dir: ${dir}\n`;
  const acc = fold([toolUseLine(AT, toolId(1), 'Workflow'), toolResultLine(AT, toolId(1), text)]);
  assert.deepEqual(open(acc), [[toolId(1), 'workflow', RUN]]);
});
