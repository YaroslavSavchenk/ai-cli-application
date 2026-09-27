/**
 * server/agents-verdict.ts via server/agents.ts — the Nocturne C2 fix after
 * the DEV check (.claude/plans/nocturne/PLAN-C2.md § Fix after the DEV check):
 * a turn the transcript says RUNS reads 'waiting' once the session's terminal
 * title has been Claude Code's idle mark for TITLE_IDLE_MS (3 s) — a question,
 * a plan approval or a permission prompt on screen. It beats open background
 * work like a transcript question; the 3 s count from when the turn STARTED
 * if that is later, so a turn that starts under a long-idle title (a task
 * notification's line landing before the spinner, a turn that ended and
 * restarted within one read, a transcript read afresh after it shrank) does
 * not flip at once, while a line that lands in a turn already running does
 * not restart the count; the stamp is asked for by session id; a
 * transcript that says 'waiting' is untouched by the title; no title stamp
 * (no callback, undefined, a stamp ahead of the clock) leaves the verdict as
 * it was. `turnEnded` (C1) follows: set when the idle title crosses 3 s,
 * cleared by the spinner.
 *
 * How: a real AgentsWatcher over a real temp transcript tree on a clock the
 * test steps, its `titleIdleSince` a stamp the test drives; the `turnEnded`
 * cases wire it to a real SessionManager (`wired`,
 * `tests/helpers/agents-fixture.ts`), and the last case runs the whole chain:
 * a PTY printing the titles, the manager's own stamp, the verdict, the frame.
 *
 * Why it matters: Claude Code 2.1.283 writes a question's line only after the
 * answer and a permission prompt writes nothing, so without this the pane
 * read Working while Claude waited on the user (the user's DEV-check report).
 * Too eager, and every turn end with background work alive flashes a mascot.
 *
 * NOT claimed here: the scan of the title bytes
 * (`tests/server/sessions-output-scan.test.ts`); the stamp's own rules
 * (`tests/server/sessions-title.test.ts`); a real Claude Code session (the
 * DEV check, `.claude/plans/nocturne/PLAN-C2.md` § Gates).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sleep, waitUntil } from '../helpers/helpers.ts';
import {
  NO_REPORT_MS,
  OTHER_UUID,
  REAL,
  STALE_MS,
  TITLE_BASH,
  agentLaunch,
  agoIso,
  appendMain,
  mainFile,
  makeWatcher,
  notificationLine,
  queuedNotificationLine,
  runningAgent,
  sendTitle,
  startTracking,
  toolId,
  turnsOf,
  waitForReport,
  waitInfo,
  wired,
  type Harness,
} from '../helpers/agents-fixture.ts';

/** TITLE_IDLE_MS in server/agents-verdict.ts (not exported; kept in step here). */
const TITLE_IDLE_MS = 3_000;

const AGENT = 'a790bda5878f4d7ef';

/** A watcher on a stepped clock whose title stamp the test sets. */
async function titled(): Promise<{ w: Harness; clock: { now: number }; title: { since: number | undefined } }> {
  const clock = { now: Date.now() };
  const title: { since: number | undefined } = { since: undefined };
  const w = await makeWatcher({ now: () => clock.now, titleIdleSince: () => title.since });
  return { w, clock, title };
}

test('C2 title verdict: a running turn under an idle title reads working until 3 s, waiting FROM 3 s, working again on the spinner', async () => {
  const { w, clock, title } = await titled();
  try {
    await appendMain(w, [REAL.prompt, REAL.toolUse]);
    startTracking(w);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    title.since = clock.now;
    clock.now = title.since + TITLE_IDLE_MS - 1;
    await sleep(NO_REPORT_MS);
    assert.deepEqual(turnsOf(w), ['working'], 'one ms short of 3 s: still working');
    clock.now = title.since + TITLE_IDLE_MS;
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    title.since = undefined; // The spinner: Claude works again.
    await waitForReport(w.seen, (r) => r.turn === 'working');
    assert.deepEqual(turnsOf(w), ['working', 'waiting', 'working'], 'each change reported once, no line written');
  } finally {
    await w.cleanup();
  }
});

test('C2 title verdict: the idle-title question BEATS a live background launch', async () => {
  const { w, clock, title } = await titled();
  try {
    await runningAgent(w, AGENT);
    // The launch's result is the last counting line: the transcript says the turn runs.
    await appendMain(w, [REAL.prompt, ...agentLaunch(agoIso(clock.now, 1_000), toolId(1), AGENT)]);
    title.since = clock.now - 10 * TITLE_IDLE_MS;
    startTracking(w);
    const first = await waitForReport(w.seen, (r) => r.turn !== undefined);
    assert.equal(first.turn, 'working', 'first sight dates the turn: its 3 s start now');
    clock.now += TITLE_IDLE_MS;
    const asked = await waitForReport(w.seen, (r) => r.turn === 'waiting');
    assert.equal(asked.counts.running, 1, 'Claude waits on the user while the agent does run');
    title.since = undefined;
    await waitForReport(w.seen, (r) => r.turn === 'working');
  } finally {
    await w.cleanup();
  }
});

test('C2 title verdict: a turn that STARTS under a long-idle title (a notice before the spinner) does not flip at once', async () => {
  // The review's probe: the turn ended with a launch alive under a title idle
  // for ten minutes; the launch reports back as a counting user line, and
  // Claude Code's spinner title has not come yet.
  const { w, clock, title } = await titled();
  try {
    title.since = clock.now - 10 * 60_000;
    await appendMain(w, [REAL.prompt, ...agentLaunch(agoIso(clock.now, 60_000), toolId(1), AGENT), REAL.endTurn]);
    startTracking(w);
    assert.equal((await waitForReport(w.seen, (r) => r.turn !== undefined)).turn, 'working', 'the launch is alive');
    // A minute on — the turn read at first sight is long over; the launch still lives.
    clock.now += 60_000;
    const started = clock.now;
    await appendMain(w, [notificationLine(agoIso(clock.now, 0), toolId(1), AGENT)]);
    // A row written AFTER the line: the poll that shows it read the line first
    // (the main transcript is read before the rows), at `started`.
    await runningAgent(w, 'b0');
    await waitForReport(w.seen, (r) => r.counts.running === 1);
    clock.now = started + TITLE_IDLE_MS - 1;
    await sleep(NO_REPORT_MS);
    assert.equal(turnsOf(w).includes('waiting'), false, 'the new turn gets its own 3 s: no flash');
    // No spinner ever came: from 3 s after the turn started, Claude waits on the user.
    clock.now = started + TITLE_IDLE_MS;
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
  } finally {
    await w.cleanup();
  }
});

test('C2 title verdict: a working line that lands while the turn ALREADY runs does not restart its 3 s', async () => {
  // A permission prompt can sit on screen while Claude Code appends lines
  // that change nothing (a tool result, the next tool call): the 3 s count
  // from when the turn started, not from its latest line.
  const { w, clock, title } = await titled();
  try {
    await appendMain(w, [REAL.prompt, REAL.toolUse]);
    startTracking(w);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    title.since = clock.now;
    clock.now += TITLE_IDLE_MS - 1_000;
    await appendMain(w, [REAL.toolResult, REAL.toolUse]);
    // A row written AFTER the lines: the poll that shows it read them first.
    await runningAgent(w, 'b0');
    await waitForReport(w.seen, (r) => r.counts.running === 1);
    assert.equal(turnsOf(w).includes('waiting'), false, 'under 3 s: working');
    clock.now = title.since + TITLE_IDLE_MS;
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
  } finally {
    await w.cleanup();
  }
});

test('C2 title verdict: a turn that ENDS and STARTS again within one read is dated at that read — its new 3 s start then', async () => {
  const { w, clock, title } = await titled();
  try {
    await appendMain(w, [REAL.prompt, REAL.toolUse]);
    startTracking(w);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    clock.now += 60_000;
    const read = clock.now;
    // One write, so one read: the turn's end and the next prompt together.
    await appendMain(w, [REAL.endTurn, REAL.prompt]);
    await runningAgent(w, 'b0');
    await waitForReport(w.seen, (r) => r.counts.running === 1);
    // The title turned idle at the end of the old turn, ten seconds ago; the
    // spinner of the new one has not come yet.
    title.since = read - 10_000;
    clock.now = read + TITLE_IDLE_MS - 1;
    await sleep(NO_REPORT_MS);
    assert.deepEqual(turnsOf(w).filter((t) => t === 'waiting'), [], 'the new turn gets its own 3 s: no flash');
    clock.now = read + TITLE_IDLE_MS;
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
  } finally {
    await w.cleanup();
  }
});

test('C2 title verdict: a transcript that SHRANK is read afresh — its running turn is dated at that read, like a first sight', async () => {
  const { w, clock, title } = await titled();
  try {
    await appendMain(w, [REAL.prompt, REAL.toolResult, REAL.toolUse, REAL.toolResult, REAL.toolUse]);
    startTracking(w);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    title.since = clock.now;
    clock.now += TITLE_IDLE_MS;
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    clock.now += 60_000;
    const read = clock.now;
    // Replaced whole (a rename, so no poll sees it empty) by a shorter file.
    const staged = `${mainFile(w)}.new`;
    await writeFile(staged, `${REAL.prompt}\n${REAL.toolUse}\n`, { mode: 0o600 });
    await rename(staged, mainFile(w));
    await waitForReport(w.seen, (r) => r.turn === 'working');
    clock.now = read + TITLE_IDLE_MS - 1;
    await sleep(NO_REPORT_MS);
    assert.deepEqual(turnsOf(w), ['working', 'waiting', 'working'], 'the re-read turn gets its own 3 s');
    clock.now = read + TITLE_IDLE_MS;
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
  } finally {
    await w.cleanup();
  }
});

test('C2 title verdict: the title stamp is asked for by SESSION ID — one session idle for long never turns another running session waiting', async () => {
  const clock = { now: Date.now() };
  const asked = new Set<string>();
  const w = await makeWatcher({
    now: () => clock.now,
    titleIdleSince: (id) => {
      asked.add(id);
      return id === 'sess-1' ? clock.now - 10 * TITLE_IDLE_MS : undefined;
    },
  });
  try {
    const otherDir = join(w.root, '-slug', OTHER_UUID, 'subagents');
    await mkdir(otherDir, { recursive: true });
    await appendMain(w, [REAL.prompt, REAL.toolUse]);
    await writeFile(join(w.root, '-slug', `${OTHER_UUID}.jsonl`), `${REAL.prompt}\n${REAL.toolUse}\n`, { mode: 0o600 });
    startTracking(w);
    w.watcher.track('sess-2', otherDir);
    const turnOf = (id: string): (string | undefined)[] => w.seen.filter((s) => s.id === id).map((s) => s.report.turn);
    await waitUntil(() => (turnOf('sess-1').length > 0 && turnOf('sess-2').length > 0 ? true : undefined), 'both first reports');
    clock.now += TITLE_IDLE_MS;
    await waitUntil(() => (turnOf('sess-1').includes('waiting') ? true : undefined), 'sess-1 waiting');
    await sleep(NO_REPORT_MS);
    assert.deepEqual(turnOf('sess-2'), ['working'], 'sess-2 has no idle title: it works on');
    assert.deepEqual([...asked].sort(), ['sess-1', 'sess-2'], 'asked with the session ids, nothing else');
  } finally {
    await w.cleanup();
  }
});

test('C2 title verdict: a transcript that says WAITING is untouched by the title — launches decide, as before', async () => {
  const { w, clock, title } = await titled();
  try {
    // The turn ended with a launch alive, under a title idle for minutes: working.
    await appendMain(w, [...agentLaunch(agoIso(clock.now, 1_000), toolId(1), AGENT), REAL.endTurn]);
    title.since = clock.now - 10 * TITLE_IDLE_MS;
    startTracking(w);
    assert.equal((await waitForReport(w.seen, (r) => r.turn !== undefined)).turn, 'working');
    // The launch reports back (an attachment: no counting line): waiting, idle title or not.
    await appendMain(w, [queuedNotificationLine(agoIso(clock.now, 0), toolId(1), AGENT)]);
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    title.since = undefined;
    await sleep(NO_REPORT_MS);
    assert.deepEqual(turnsOf(w), ['working', 'waiting'], 'a spinner title does not make an ended turn working');
  } finally {
    await w.cleanup();
  }
});

test('C2 title verdict: no callback, an undefined stamp, or one AHEAD of the clock leave a running turn working', async () => {
  const clock = { now: Date.now() };
  for (const [what, since] of [
    ['no callback', null],
    ['undefined', (): number | undefined => undefined],
    ['ahead of the clock', (): number | undefined => clock.now + 60_000],
    ['NaN', (): number | undefined => Number.NaN],
  ] as const) {
    const w = await makeWatcher({
      now: () => clock.now,
      ...(since === null ? {} : { titleIdleSince: since }),
    });
    try {
      await appendMain(w, [REAL.prompt, REAL.toolUse]);
      startTracking(w);
      await waitForReport(w.seen, (r) => r.turn === 'working');
      clock.now += STALE_MS; // Any amount of time: no stale rule for a running turn.
      await sleep(NO_REPORT_MS);
      assert.deepEqual(turnsOf(w), ['working'], what);
    } finally {
      await w.cleanup();
    }
  }
});

test('C2 title verdict: a session with no transcript verdict gets none from its title', async () => {
  const { w, clock, title } = await titled();
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    await appendMain(w, [REAL.meta, REAL.commandName]);
    title.since = clock.now - 10 * TITLE_IDLE_MS;
    startTracking(w);
    await sleep(NO_REPORT_MS);
    assert.equal(w.seen.length, 0, 'no turn, nothing to announce');
  } finally {
    await w.cleanup();
  }
});

test('C2 title turnEnded: set when the idle title crosses 3 s, cleared by the spinner — with a live launch too', async () => {
  const clock = { now: Date.now() };
  const title: { since: number | undefined } = { since: undefined };
  const s = await wired({ now: () => clock.now, titleIdleSince: () => title.since });
  try {
    await appendMain(s.w, [REAL.prompt, ...agentLaunch(agoIso(clock.now, 1_000), toolId(1), AGENT)]);
    s.w.watcher.track('sess-1', s.w.dir);
    await waitInfo(s.client, (i) => i.turn === 'working', 'working');
    title.since = clock.now;
    clock.now += TITLE_IDLE_MS;
    const asked = await waitInfo(s.client, (i) => i.turn === 'waiting', 'waiting');
    assert.equal(asked.turnEnded, true, 'the combined verdict went working -> waiting: the mascot comes');
    assert.equal(typeof asked.pendingSince, 'string');
    title.since = undefined;
    const back = await waitInfo(s.client, (i) => i.turn === 'working', 'working again');
    assert.equal('turnEnded' in back, false, 'answered: the mascot leaves');
    assert.equal('pendingSince' in back, false);
  } finally {
    await s.cleanup();
  }
});

test('C2 title turnEnded: the REAL chain — a PTY printing the idle title, the manager stamp, the verdict, the frame', async () => {
  const offset = { ms: 0 };
  const s = await wired({ now: () => Date.now() + offset.ms, args: TITLE_BASH, titleIdleSince: 'manager' });
  try {
    await appendMain(s.w, [REAL.prompt, REAL.toolUse]);
    s.w.watcher.track('sess-1', s.w.dir);
    await waitInfo(s.client, (i) => i.turn === 'working', 'working');
    await sendTitle(s.m.manager, s.id, s.client, 'idle');
    await sleep(NO_REPORT_MS);
    assert.equal(s.m.manager.get(s.id)?.turn, 'working', 'idle for less than 3 s: still working');
    offset.ms = TITLE_IDLE_MS; // Three seconds on, without waiting them.
    const asked = await waitInfo(s.client, (i) => i.turn === 'waiting', 'waiting');
    assert.equal(asked.turnEnded, true);
    await sendTitle(s.m.manager, s.id, s.client, 'spin');
    const back = await waitInfo(s.client, (i) => i.turn === 'working', 'working again');
    assert.equal('turnEnded' in back, false);
  } finally {
    await s.cleanup();
  }
});
