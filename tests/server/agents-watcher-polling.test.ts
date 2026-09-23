/**
 * server/agents.ts AgentsWatcher — the poll itself (Nocturne B7,
 * .claude/plans/nocturne/PLAN-B7.md): delivery (an empty table is never
 * announced, an unchanged list is delivered once), track/untrack/stop, a
 * throwing consumer or a vanished directory never taking the poll down; the
 * boundary RE-CHECKED on every poll for the components appended after
 * subagentsDirFor() (a symlinked `<uuid>`, a forged log line); and the
 * per-tick read budget (4 MiB per file, 16 MiB per tick by default, 1 MiB per
 * line, 1024 meta names per poll).
 *
 * How: a real watcher over a real temp directory (`makeWatcher` in
 * `tests/helpers/agents-fixture.ts`) with byte-exact transcript fixtures —
 * the caps are byte counts, so a file at the cap and one byte past it are
 * both written.
 *
 * Why: a watcher that one hostile file can stall, crash or push into an
 * unbounded read takes every session's agent list with it.
 *
 * NOT claimed here: the rows themselves — `tests/server/agents-watcher.test.ts`;
 * the main-transcript share of the budget — `tests/server/agents-turn.test.ts`,
 * `tests/server/agents-turn-edges.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionAgent } from '../../shared/protocol.ts';
import { AgentsWatcher, type AgentsReport } from '../../server/agents.ts';
import { sleep, makeTempDir, waitUntil } from '../helpers/helpers.ts';
import {
  ESC,
  UUID,
  OTHER_UUID,
  MAX_AGENTS,
  MAX_RUNNING_ROWS,
  NOW_S,
  assistantLine,
  type Seen,
  makeWatcher,
  writeMeta,
  appendLines,
  waitFor,
  waitForReport,
  MANY_POLLS_MS,
  NO_REPORT_MS,
  WATCHER_POLL_MS,
} from '../helpers/agents-fixture.ts';

// ---------------------------------------------------------------------------
// AgentsWatcher — delivery and lifecycle
// ---------------------------------------------------------------------------

test('watcher: no directory, no agents, no callback — an empty table is never announced', async () => {
  const w = await makeWatcher({ create: false });
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir); // Claude Code has not created it yet.
    // The one turn-only report is a condition; that nothing follows it is the
    // silence after it.
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    await sleep(NO_REPORT_MS);
    // B11: no agent table is announced — but the session's own transcript is
    // not there either (its slug folder is still PENDING, B11 F1), so it sits
    // at its first prompt: ONE turn-only report, not a single agent row.
    const turnOnly = [{ agents: [], counts: { running: 0, finished: 0 }, turn: 'waiting' }];
    assert.deepEqual(w.seen.map((s) => s.report), turnOnly);
    // And an existing but empty directory is the same: nothing new to say.
    await mkdir(w.dir, { recursive: true });
    await sleep(NO_REPORT_MS);
    assert.deepEqual(w.seen.map((s) => s.report), turnOnly);
  } finally {
    await w.cleanup();
  }
});

test('watcher: an unchanged list is delivered exactly once', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'b6', { agentType: 'a', description: 'b' });
    await appendLines(w.dir, 'b6', [assistantLine('2026-09-16T10:00:00.000Z', 'm1', { output_tokens: 1 }, 'end_turn')]);
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length === 1);
    await sleep(NO_REPORT_MS); // Ten more polls over an unchanged directory.
    assert.equal(w.seen.length, 1, 'one broadcast per real change, and none for a re-read');
  } finally {
    await w.cleanup();
  }
});

test('watcher: untrack() stops this session and leaves the others polling', async () => {
  const w = await makeWatcher();
  try {
    const second = join(w.root, '-slug', OTHER_UUID, 'subagents');
    await mkdir(second, { recursive: true });
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'b7', { agentType: 'one', description: '' });
    await writeMeta(second, 'b8', { agentType: 'two', description: '' });
    w.watcher.track('sess-1', w.dir);
    w.watcher.track('sess-2', second);
    await waitFor(w.seen, () => w.seen.some((s) => s.id === 'sess-1') && w.seen.some((s) => s.id === 'sess-2'));
    assert.equal(w.watcher.trackedCount, 2);

    w.watcher.untrack('sess-1');
    assert.equal(w.watcher.trackedCount, 1);
    const before = w.seen.filter((s) => s.id === 'sess-1').length;
    await writeMeta(w.dir, 'b9', { agentType: 'late', description: '' });
    await writeMeta(second, 'ba', { agentType: 'also late', description: '' });
    await waitFor(w.seen, () => w.seen.filter((s) => s.id === 'sess-2').length >= 2);
    assert.equal(w.seen.filter((s) => s.id === 'sess-1').length, before, 'the untracked session says nothing more');
    // untrack() on a session that was never tracked is a no-op, not an error.
    w.watcher.untrack('sess-does-not-exist');
  } finally {
    await w.cleanup();
  }
});

test('watcher: track() with the SAME directory keeps the offsets; another one replaces the state', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'bb', { agentType: 'first', description: '' });
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length === 1);
    const calls = w.seen.length;
    w.watcher.track('sess-1', w.dir); // The status line reports the same path every turn.
    await sleep(NO_REPORT_MS);
    assert.equal(w.seen.length, calls, 'the same path is a no-op, not a re-read');

    // A resumed conversation reports a DIFFERENT transcript: fresh state.
    const second = join(w.root, '-slug', OTHER_UUID, 'subagents');
    await mkdir(second, { recursive: true });
    await writeMeta(second, 'bc', { agentType: 'second', description: '' });
    w.watcher.track('sess-1', second);
    const rows = await waitFor(w.seen, (a) => a[0]?.name === 'second');
    assert.deepEqual(rows.map((r) => r.id), ['bc'], 'nothing from the old directory survived');
  } finally {
    await w.cleanup();
  }
});

test('watcher: stop() detaches, is idempotent, and forgets every tracked session', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'bd', { agentType: 'a', description: '' });
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length === 1);

    w.watcher.stop();
    w.watcher.stop(); // Idempotent: the shutdown path can reach it twice.
    assert.equal(w.watcher.trackedCount, 0);
    const calls = w.seen.length;
    await writeMeta(w.dir, 'be', { agentType: 'late', description: '' });
    await sleep(NO_REPORT_MS);
    assert.equal(w.seen.length, calls, 'nothing is delivered after stop()');
    // track() after stop() is refused rather than silently queued.
    w.watcher.track('sess-2', w.dir);
    assert.equal(w.watcher.trackedCount, 0);
  } finally {
    await w.cleanup();
  }
});

test('watcher: a consumer that throws does not take the poll down', async () => {
  const w = await makeWatcher();
  try {
    let calls = 0;
    w.watcher.start((id, report) => {
      calls++;
      w.seen.push({ id, agents: report.agents, report });
      if (calls === 1) throw new Error('consumer exploded');
    });
    await writeMeta(w.dir, 'bf', { agentType: 'a', description: '' });
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length === 1);
    await writeMeta(w.dir, 'c0', { agentType: 'b', description: '' });
    const rows = await waitFor(w.seen, (a) => a.length === 2);
    assert.equal(rows.length, 2, 'the second change still arrived');
    assert.equal(
      w.logs.some((l) => l.startsWith('warn: ') && l.includes('consumer threw')),
      true,
      w.logs.join('\n'),
    );
  } finally {
    await w.cleanup();
  }
});

test('watcher: a directory that disappears mid-flight is a skipped poll, not a crash', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'c1', { agentType: 'a', description: '' });
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length === 1);
    const calls = w.seen.length;
    const rows = w.seen[w.seen.length - 1]?.agents;
    await rm(join(w.root, '-slug'), { recursive: true, force: true });
    await sleep(NO_REPORT_MS);
    // The last list stands — what those agents cost is still true. (B11: the
    // transcript's parent is gone too, so the turn becomes unknown: that is the
    // one delivery allowed, and it carries the same rows.)
    assert.equal(w.seen.length <= calls + 1, true, `${w.seen.length - calls} extra deliveries`);
    for (const s of w.seen.slice(calls)) {
      assert.deepEqual(s.agents, rows);
      assert.equal(s.report.turn, undefined);
    }
    assert.equal(w.watcher.trackedCount, 1, 'still tracked: the directory may come back');
  } finally {
    await w.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The boundary, RE-CHECKED: the components appended after subagentsDirFor()
// ---------------------------------------------------------------------------

test('watcher: a symlink at the <uuid> component is refused on every poll, not followed', async () => {
  // subagentsDirFor() realpaths the TRANSCRIPT's directory only; `<uuid>` and
  // `subagents` are appended after it, and readdir/stat follow every component
  // (O_NOFOLLOW guards the final file, not the path to it). Without the
  // per-poll re-check this delivered a meta file from outside the root.
  const base = realpathSync(await makeTempDir('ai-sm-agentsym-'));
  const root = join(base, 'projects');
  const slug = join(root, '-slug');
  const outside = join(base, 'outside');
  await mkdir(slug, { recursive: true });
  await mkdir(join(outside, 'subagents'), { recursive: true });
  await writeMeta(join(outside, 'subagents'), 'ab', { agentType: 'stolen', description: 'from outside' });
  await symlink(outside, join(slug, UUID));
  const logs: string[] = [];
  const seen: Seen[] = [];
  const watcher = new AgentsWatcher((level, message) => logs.push(`${level}: ${message}`), {
    projectsRoot: root,
    pollMs: WATCHER_POLL_MS,
  });
  try {
    watcher.start((id, report) => seen.push({ id, agents: report.agents, report }));
    watcher.track('sess-1', join(slug, UUID, 'subagents'));
    // The refusal is a condition; that it is logged ONCE is the silence over
    // the fifteen polls after it.
    await waitUntil(
      () => (logs.some((l) => l.includes('resolves outside the projects root')) ? true : undefined),
      'the refusal line',
      5_000,
      10,
    );
    await sleep(MANY_POLLS_MS);
    // B11: the session's own transcript (`<slug>/<uuid>.jsonl`, inside the
    // root) does not exist, so a turn-only 'waiting' report is expected — but
    // not one agent from outside.
    assert.equal(
      seen.every((s) => s.agents.length === 0 && s.report.counts.running + s.report.counts.finished === 0),
      true,
      `nothing from outside the root ever reaches a client; got ${JSON.stringify(seen)}`,
    );
    const refusals = logs.filter(
      (l) => l.startsWith('debug: ') && l.includes('resolves outside the projects root'),
    );
    // ONCE for the tracked directory, not once per 2 s poll: the check runs
    // forever while the session lives and would bury server.log.
    assert.equal(refusals.length, 1, logs.join('\n'));

    // The control: the same watcher reads a directory that really is inside.
    const honest = join(slug, OTHER_UUID, 'subagents');
    await mkdir(honest, { recursive: true });
    await writeMeta(honest, 'cd', { agentType: 'honest', description: '' });
    watcher.track('sess-2', honest);
    await waitFor(seen, (a) => a[0]?.name === 'honest');
  } finally {
    watcher.stop();
    await rm(base, { recursive: true, force: true });
  }
});

test('watcher: a path in a log line can never forge one', async () => {
  const w = await makeWatcher({ create: false });
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    // A directory name carrying a newline and an ESC: legal on Linux, and it
    // reaches server.log verbatim without oneLine().
    const nasty = join(w.root, `-slug\n2026-01-01T00:00:00.000Z [error] forged${ESC}[31m`, UUID, 'subagents');
    w.watcher.track('sess-1', nasty);
    assert.equal(w.logs.length >= 1, true);
    for (const line of w.logs) {
      assert.equal(/[\u0000-\u001F\u007F-\u009F]/.test(line), false, JSON.stringify(line));
    }
    assert.equal(w.logs.some((l) => l.includes('tracking')), true, w.logs.join(' | '));
  } finally {
    await w.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The per-tick read budget
// ---------------------------------------------------------------------------

/** A transcript that starts with one counted message and is then padded to ~`mib` MiB. */
async function writePadded(dir: string, id: string, tokens: number, mib: number): Promise<void> {
  const head = `${assistantLine('2026-09-16T10:00:00.000Z', `m-${id}`, { output_tokens: tokens })}\n`;
  const pad = `${JSON.stringify({ type: 'attachment', pad: 'x'.repeat(1_000) })}\n`;
  const lines = [head];
  for (let written = head.length; written < mib * 1024 * 1024; written += pad.length) lines.push(pad);
  await writeFile(join(dir, `agent-${id}.jsonl`), lines.join(''), { mode: 0o600 });
}

/**
 * A transcript of EXACTLY `bytes` bytes whose last line is (or is not) the
 * `end_turn` that finishes the agent. The size is exact because the read caps
 * are byte counts: a file at the cap is read in one poll, one byte past it is
 * not.
 */
async function writeSized(dir: string, id: string, bytes: number, ending: 'end_turn' | 'open'): Promise<void> {
  const tail =
    ending === 'end_turn'
      ? `${assistantLine('2026-09-16T11:00:00.000Z', `m-${id}`, { output_tokens: 1 }, 'end_turn')}\n`
      : '';
  const pad = `${JSON.stringify({ type: 'attachment', pad: 'x'.repeat(1_000) })}\n`;
  const chunks: string[] = [];
  let size = tail.length;
  while (size + pad.length <= bytes) {
    chunks.push(pad);
    size += pad.length;
  }
  const rest = bytes - size;
  if (rest > 0) chunks.push(`${'x'.repeat(rest - 1)}\n`); // junk, skipped: not JSON
  chunks.push(tail);
  const text = chunks.join('');
  assert.equal(Buffer.byteLength(text), bytes, 'the fixture is exactly the size the cap is about');
  await writeFile(join(dir, `agent-${id}.jsonl`), text, { mode: 0o600 });
}

test('watcher: the REFUSAL log line cannot be forged either', async () => {
  // The twin of the tracking log above, at the other path that logs a path:
  // the directory refused for resolving outside the root. That string is the
  // one from the snapshot, so a newline in it would write a whole fake line
  // into server.log — and an ESC would repaint the terminal reading it.
  const base = realpathSync(await makeTempDir('ai-sm-agentlog-'));
  const root = join(base, 'projects');
  const outside = join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(join(outside, UUID, 'subagents'), { recursive: true });
  const nasty = `-slug\n2026-01-01T00:00:00.000Z [error] forged${ESC}[31m`;
  await symlink(outside, join(root, nasty));
  const logs: string[] = [];
  const seen: Seen[] = [];
  const watcher = new AgentsWatcher((level, message) => logs.push(`${level}: ${message}`), {
    projectsRoot: root,
    pollMs: WATCHER_POLL_MS,
  });
  try {
    watcher.start((id, report) => seen.push({ id, agents: report.agents, report }));
    watcher.track('sess-1', join(root, nasty, UUID, 'subagents'));
    // Wait for the first refusal (a condition), then ten more polls, each of
    // which refuses and logs.
    await waitUntil(
      () => (logs.some((l) => l.includes('resolves outside the projects root')) ? true : undefined),
      'the refusal line',
      5_000,
      10,
    );
    await sleep(NO_REPORT_MS);
    assert.deepEqual(seen, [], 'nothing outside the root is ever delivered');
    assert.equal(
      logs.some((l) => l.includes('resolves outside the projects root')),
      true,
      logs.join(' | '),
    );
    for (const line of logs) {
      assert.equal(/[\u0000-\u001F\u007F-\u009F]/.test(line), false, JSON.stringify(line));
    }
  } finally {
    watcher.stop();
    await rm(base, { recursive: true, force: true });
  }
});

test('watcher: ONE file gives up at 4 MiB per poll, however much budget is left', async () => {
  // The per-file cap is what stops a planted 10 GB transcript from being read
  // into this process in one go. With the default (16 MiB) tick budget there
  // is room for all of this file, so only the per-file cap can hold it back:
  // the end marker sits past 4 MiB, so the FIRST list must still say running.
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'fa', { agentType: 'big-talker', description: '' }, NOW_S);
    await writeSized(w.dir, 'fa', 4 * 1024 * 1024 + 64 * 1024, 'end_turn');
    w.watcher.track('sess-1', w.dir);

    const first = await waitFor(w.seen, (a) => a.length === 1);
    assert.equal(first[0]?.state, 'running', 'the first 4 MiB carried no end marker');
    assert.equal(w.seen[0]?.agents[0]?.state, 'running', 'and that was the FIRST thing said');
    // The remainder arrives on a later tick, and the marker with it.
    const later = await waitFor(w.seen, (a) => a[0]?.state === 'finished');
    assert.equal(later[0]?.endedAt, '2026-09-16T11:00:00.000Z');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a line of exactly 1 MiB is parsed, one byte more is skipped', async () => {
  // MAX_LINE is a real boundary in both directions: a 120 KB tool result is an
  // ORDINARY transcript line and must be folded, while a line past the cap is
  // handed to nothing (JSON.parse on a megabyte of planted text is the cost
  // the cap exists to refuse). Pinned to the byte, so shrinking the cap is as
  // loud a change as removing it.
  const MiB = 1024 * 1024;
  /** An assistant line padded to exactly `bytes` bytes (the pad is plain ASCII). */
  const padded = (bytes: number, id: string, tokens: number): string => {
    const build = (pad: string): string =>
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-16T10:00:00.000Z',
        message: { id, stop_reason: 'tool_use', usage: { output_tokens: tokens }, pad },
      });
    const line = build('x'.repeat(bytes - build('').length));
    assert.equal(Buffer.byteLength(line), bytes, 'the fixture is exactly at the cap');
    return line;
  };
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'fc', { agentType: 'long-liner', description: '' }, NOW_S);
    await appendLines(w.dir, 'fc', [
      padded(MiB, 'at-the-cap', 11),
      padded(MiB + 1, 'past-the-cap', 22),
      assistantLine('2026-09-16T10:05:00.000Z', 'done', { output_tokens: 0 }, 'end_turn'),
    ]);
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a[0]?.state === 'finished');
    assert.equal(rows[0]?.tokens, 11, 'the 1 MiB line counted, the 1 MiB + 1 line did not');
  } finally {
    await w.cleanup();
  }
});

test('watcher: 4 MiB per poll is the cap TO THE BYTE', async () => {
  // A file of exactly 4 MiB + 1: the last byte is the newline that completes
  // the end marker, so a cap even one byte wider would finish the agent a poll
  // early — and a cap that wide is one that was not thought about.
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'fd', { agentType: 'exact', description: '' }, NOW_S);
    await writeSized(w.dir, 'fd', 4 * 1024 * 1024 + 1, 'end_turn');
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length === 1);
    assert.equal(w.seen[0]?.agents[0]?.state, 'running', 'the last byte was one byte too far');
    const later = await waitFor(w.seen, (a) => a[0]?.state === 'finished');
    assert.equal(later[0]?.endedAt, '2026-09-16T11:00:00.000Z');
  } finally {
    await w.cleanup();
  }
});

test('watcher: past 1024 meta names one poll stops scanning, and says so', async () => {
  // A planted directory with a million `agent-*.meta.json` entries must not
  // turn one tick into a million stat() calls on the thread that pumps every
  // PTY. The cap is a bound on syscalls, so the only honest witness is the
  // debug line that says the rest was ignored.
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    const body = JSON.stringify({ agentType: 'flood', description: '' });
    for (let i = 0; i < 1_100; i++) {
      await writeFile(join(w.dir, `agent-${i.toString(16).padStart(5, '0')}.meta.json`), body, { mode: 0o644 });
    }
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length > 0);
    assert.equal(
      w.logs.some((l) => l.includes('more than 1024 agent metas, rest ignored')),
      true,
      w.logs.join(' | '),
    );
    // And what it did deliver is still capped: four running rows, and the
    // count stops at the tracked cap.
    const last = w.seen[w.seen.length - 1]?.report as AgentsReport;
    assert.equal(last.agents.length, MAX_RUNNING_ROWS);
    assert.deepEqual(last.counts, { running: MAX_AGENTS, finished: 0 });
  } finally {
    await w.cleanup();
  }
});

test('watcher: the DEFAULT tick budget is 16 MiB — a fifth 4 MiB file waits for the next tick', async () => {
  // The same claim the explicit-budget test makes, but about the default the
  // server actually runs with: no readBudgetBytes here. Five agents, each with
  // a transcript exactly at the per-file cap, so four of them spend the whole
  // budget and the fifth is still untouched when the first list goes out.
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    for (let i = 1; i <= 5; i++) {
      const id = `f${i}`;
      // Descending mtimes, so the order the files are offered the budget in is
      // f1 … f5 and not the directory's own.
      await writeMeta(w.dir, id, { agentType: `big-${i}`, description: '' }, NOW_S - i);
      await writeSized(w.dir, id, 4 * 1024 * 1024, 'end_turn');
    }
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length > 0);
    const firstList = w.seen[0]?.agents as SessionAgent[];
    assert.equal(
      firstList.some((r) => r.state === 'running'),
      true,
      `one tick cannot read 20 MiB; first list was ${JSON.stringify(firstList)}`,
    );
    // And nothing is lost: every agent ends up finished, each counted once.
    const settled = await waitForReport(w.seen, (r) => r.counts.running === 0 && r.counts.finished === 5);
    assert.deepEqual(settled.agents.map((r) => r.tokens), [1]);
  } finally {
    await w.cleanup();
  }
});

test('watcher: one tick spends a GLOBAL byte budget — a big backlog is spread over ticks', async () => {
  // Without it, the first poll of a 30-agent session parses tens of MB of JSON
  // on the thread that pumps every PTY.
  const w = await makeWatcher({ readBudgetBytes: 1024 * 1024 });
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    // `e1` has the newer meta, so it is offered the budget first.
    await writeMeta(w.dir, 'e1', { agentType: 'first', description: '' }, NOW_S);
    await writeMeta(w.dir, 'e2', { agentType: 'second', description: '' }, NOW_S - 10);
    await writePadded(w.dir, 'e1', 111, 3);
    await writePadded(w.dir, 'e2', 222, 3);
    w.watcher.track('sess-1', w.dir);

    const byId = (rows: SessionAgent[], id: string): SessionAgent | undefined => rows.find((r) => r.id === id);
    // The first list already knows e1's opening message and nothing of e2's:
    // one tick could not read both files.
    const first = await waitFor(w.seen, (a) => byId(a, 'e1')?.tokens === 111);
    assert.equal(byId(first, 'e2')?.tokens, 0, 'the budget stopped before the second file');

    // And the rest arrives over the following ticks, counted exactly once.
    const later = await waitFor(w.seen, (a) => byId(a, 'e2')?.tokens === 222);
    assert.equal(byId(later, 'e1')?.tokens, 111, 'nothing was read twice');
    assert.equal(w.seen.length >= 2, true, `spread over ${w.seen.length} deliveries`);
  } finally {
    await w.cleanup();
  }
});
