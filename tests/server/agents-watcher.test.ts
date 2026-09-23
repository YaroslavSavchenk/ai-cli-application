/**
 * server/agents.ts AgentsWatcher — the rows (Nocturne B7,
 * .claude/plans/nocturne/PLAN-B7.md): a meta file with or without its
 * transcript, the transcript read INCREMENTALLY and re-read after it shrank,
 * the pinned-clock stale rule (strictly past 15 minutes), the row caps and the
 * tracked cap, and every file that is not what its name says (a symlink, a
 * directory, a FIFO, a bad name, a meta that is not JSON, an over-long line),
 * and a meta caught half-written (Q3, .claude/plans/PLAN-QUALITY.md).
 *
 * How: a real watcher over a real temp `<root>/<slug>/<uuid>/subagents`
 * directory, waiting on its reports (`makeWatcher`, `waitFor` in
 * `tests/helpers/agents-fixture.ts`); the clock is injected where the stale
 * rule is the claim. Every byte here comes from a file this process did not
 * write, so these are hostile-input tests.
 *
 * The honesty rule (B1, memory/decisions/pane-status-bar-data-source.md): no
 * value the files did not carry — a transcript without a timestamp falls back
 * to the meta file's mtime, never to "now".
 *
 * NOT claimed here: track/untrack/stop, the per-poll boundary re-check and the
 * read budget — `tests/server/agents-watcher-polling.test.ts`; the pure
 * boundary and fold — `tests/server/agents.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, rename, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionAgent } from '../../shared/protocol.ts';
import { type AgentsReport } from '../../server/agents.ts';
import { sleep } from '../helpers/helpers.ts';
import {
  ESC,
  NUL,
  DEL,
  STALE_MS,
  MAX_AGENTS,
  MAX_RUNNING_ROWS,
  MAX_LINE,
  NOW_S,
  assistantLine,
  userLine,
  makeWatcher,
  writeMeta,
  appendLines,
  waitFor,
  waitForReport,
  NO_REPORT_MS,
} from '../helpers/agents-fixture.ts';

// ---------------------------------------------------------------------------
// AgentsWatcher
// ---------------------------------------------------------------------------

test('watcher: a meta with no transcript yet is a RUNNING row started at the meta mtime', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'a0053196a4ba8146d', {
      agentType: 'test-engineer',
      description: 'Test gate B2 Brief B (lean)',
      toolUseId: 'toolu_019YPEzehde7kJMZHpGpYP4s',
      spawnDepth: 1,
      requestShape: 'background',
      requestNonInteractive: true,
      model: 'opus',
    }, NOW_S);
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 1);
    assert.equal(w.seen[0]?.id, 'sess-1');
    assert.deepEqual(rows, [
      {
        id: 'a0053196a4ba8146d',
        name: 'test-engineer',
        task: 'Test gate B2 Brief B (lean)',
        // The meta's mtime, NOT "now" — the honesty rule.
        startedAt: new Date(NOW_S * 1_000).toISOString(),
        tokens: 0,
        state: 'running',
      },
    ]);
  } finally {
    await w.cleanup();
  }
});

test('watcher: the transcript is read INCREMENTALLY as it grows, and the row follows', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'ff01', { agentType: 'backend-pty', description: 'B7' });
    await appendLines(w.dir, 'ff01', [
      userLine('2026-09-16T10:00:00.000Z'),
      assistantLine('2026-09-16T10:00:10.000Z', 'm1', { input_tokens: 100, output_tokens: 20 }),
    ]);
    w.watcher.track('sess-1', w.dir);
    let rows = await waitFor(w.seen, (a) => a[0]?.tokens === 120);
    assert.equal(rows[0]?.state, 'running');
    assert.equal(rows[0]?.startedAt, '2026-09-16T10:00:00.000Z', 'the FIRST line, not the meta mtime');

    // Appending more only reads the new bytes; the old ones are not re-folded.
    await appendLines(w.dir, 'ff01', [
      assistantLine('2026-09-16T10:00:20.000Z', 'm2', { input_tokens: 1, output_tokens: 9 }),
      assistantLine('2026-09-16T10:00:21.000Z', 'm3', { output_tokens: 30 }, 'end_turn'),
    ]);
    rows = await waitFor(w.seen, (a) => a[0]?.state === 'finished');
    assert.equal(rows[0]?.tokens, 160, 'nothing was counted twice');
    assert.equal(rows[0]?.endedAt, '2026-09-16T10:00:21.000Z');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a line split across two polls is folded once, when it is complete', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'ff02', { agentType: 'a', description: 'b' });
    const line = assistantLine('2026-09-16T10:00:00.000Z', 'm1', { output_tokens: 42 });
    const cut = Math.floor(line.length / 2);
    // Half a line: a real transcript being appended to looks exactly like this.
    await appendFile(join(w.dir, 'agent-ff02.jsonl'), line.slice(0, cut));
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length === 1);
    assert.equal(w.seen[w.seen.length - 1]?.agents[0]?.tokens, 0, 'half a line is not a message');
    await appendFile(join(w.dir, 'agent-ff02.jsonl'), `${line.slice(cut)}\n`);
    const rows = await waitFor(w.seen, (a) => a[0]?.tokens === 42);
    assert.equal(rows[0]?.tokens, 42);
  } finally {
    await w.cleanup();
  }
});

test('watcher: a transcript that SHRANK is re-read from 0 with its counters reset', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'ff03', { agentType: 'a', description: 'b' });
    await appendLines(w.dir, 'ff03', [
      userLine('2026-09-16T10:00:00.000Z'),
      assistantLine('2026-09-16T10:00:01.000Z', 'm1', { output_tokens: 500 }),
    ]);
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a[0]?.tokens === 500);

    // Truncated and rewritten with something smaller.
    await truncate(join(w.dir, 'agent-ff03.jsonl'), 0);
    await appendLines(w.dir, 'ff03', [assistantLine('2026-09-16T11:00:00.000Z', 'm9', { output_tokens: 7 })]);
    const rows = await waitFor(w.seen, (a) => a[0]?.tokens === 7);
    assert.equal(rows[0]?.tokens, 7, 'the old file is gone, and so is what it said');
    assert.equal(rows[0]?.startedAt, '2026-09-16T11:00:00.000Z');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a running agent untouched for 15 minutes is finished, at its OWN last stamp', async () => {
  // A killed agent (TaskStop, a usage-limit abort) leaves no end marker. The
  // clock is pinned so the rule is exercised without waiting for it.
  const pinned = Date.now() + STALE_MS + 60_000;
  const w = await makeWatcher({ now: () => pinned });
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'ff04', { agentType: 'security-auditor', description: 'review' }, 1_758_000_000);
    await appendLines(w.dir, 'ff04', [
      userLine('2026-09-16T10:00:00.000Z'),
      assistantLine('2026-09-16T10:04:00.000Z', 'm1', { output_tokens: 9 }), // no end_turn
    ]);
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 1);
    assert.equal(rows[0]?.state, 'finished');
    assert.equal(rows[0]?.endedAt, '2026-09-16T10:04:00.000Z', 'the last line it wrote, never the clock');
    assert.equal(rows[0]?.startedAt, '2026-09-16T10:00:00.000Z');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a stale meta with no transcript at all ends where it started', async () => {
  const pinned = Date.now() + STALE_MS + 60_000;
  const w = await makeWatcher({ now: () => pinned });
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'ff05', { agentType: 'a', description: 'b' }, 1_758_000_000);
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 1);
    const iso = new Date(1_758_000_000_000).toISOString();
    assert.deepEqual(rows, [
      { id: 'ff05', name: 'a', task: 'b', startedAt: iso, endedAt: iso, tokens: 0, state: 'finished' },
    ]);
  } finally {
    await w.cleanup();
  }
});

test('watcher: a live agent just under the stale line is still running', async () => {
  const pinned = Date.now() + STALE_MS - 60_000;
  const w = await makeWatcher({ now: () => pinned });
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'ff06', { agentType: 'a', description: 'b' });
    await appendLines(w.dir, 'ff06', [userLine('2026-09-16T10:00:00.000Z')]);
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 1);
    assert.equal(rows[0]?.state, 'running');
    assert.equal('endedAt' in (rows[0] as object), false, 'a running row carries no end');
  } finally {
    await w.cleanup();
  }
});

test('watcher: EXACTLY 15 minutes of silence is still running — the rule is strictly past it', async () => {
  // The stale rule is `now - lastActivity > STALE_MS`, not `>=`: a tool call
  // that takes the full ten minutes Claude Code allows must never turn a live
  // agent's dot grey, so the boundary second itself belongs to the living.
  const metaS = 1_758_000_000;
  const pinned = metaS * 1_000 + STALE_MS; // exactly the cap, to the millisecond
  const w = await makeWatcher({ now: () => pinned });
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'ff07', { agentType: 'a', description: 'b' }, metaS);
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 1);
    assert.equal(rows[0]?.state, 'running', 'at exactly STALE_MS it is not stale yet');

    // One millisecond later it is, and that is the other side of the same line.
    const w2 = await makeWatcher({ now: () => pinned + 1 });
    try {
      w2.watcher.start((id, report) => w2.seen.push({ id, agents: report.agents, report }));
      await writeMeta(w2.dir, 'ff07', { agentType: 'a', description: 'b' }, metaS);
      w2.watcher.track('sess-1', w2.dir);
      const later = await waitFor(w2.seen, (a) => a.length === 1);
      assert.equal(later[0]?.state, 'finished');
    } finally {
      await w2.cleanup();
    }
  } finally {
    await w.cleanup();
  }
});

test('watcher: with nothing running, ONE finished row is sent — the most recent — and the count has them all', async () => {
  // B11 (d): at most one finished row, the latest `endedAt`; every finished
  // agent is in counts.finished, so the frontend draws `+4 finished`.
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    for (let i = 0; i < 5; i++) {
      const id = `d${i}`;
      await writeMeta(w.dir, id, { agentType: `fin-${i}`, description: '' });
      await appendLines(w.dir, id, [
        userLine('2026-09-16T09:00:00.000Z'),
        assistantLine(`2026-09-16T11:0${i}:00.000Z`, `m${i}`, { output_tokens: 1 }, 'end_turn'),
      ]);
    }
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length === 1 && a[0]?.state === 'finished');
    await waitForReport(w.seen, (r) => r.counts.finished === 5);
    // Ten polls of settling time: nothing more may arrive.
    await sleep(NO_REPORT_MS);
    const last = w.seen[w.seen.length - 1]?.report as AgentsReport;
    assert.deepEqual(last.agents.map((r) => r.name), ['fin-4'], `the freshest result only; got ${JSON.stringify(last)}`);
    assert.deepEqual(last.counts, { running: 0, finished: 5 });
    assert.equal(
      w.seen.every((s) => s.agents.length <= 1),
      true,
      'no delivery ever carried more than one finished row',
    );
  } finally {
    await w.cleanup();
  }
});

test('watcher: a SYMLINK named like a transcript is refused, not followed', async () => {
  // The meta's twin (a symlinked meta is already pinned above): a transcript
  // is opened O_NOFOLLOW too, so a link planted over `agent-<id>.jsonl` cannot
  // turn the watcher into a reader of any file this user owns.
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    const bait = join(w.root, 'not-a-transcript.jsonl');
    await writeFile(
      bait,
      `${userLine('2026-09-16T10:00:00.000Z')}\n${assistantLine('2026-09-16T10:01:00.000Z', 'm1', { output_tokens: 999 }, 'end_turn')}\n`,
      { mode: 0o600 },
    );
    await writeMeta(w.dir, 'ea', { agentType: 'link-victim', description: '' }, NOW_S);
    await symlink(bait, join(w.dir, 'agent-ea.jsonl'));
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 1);
    assert.equal(rows[0]?.name, 'link-victim');
    assert.equal(rows[0]?.tokens, 0, 'the linked file was never read');
    assert.equal(rows[0]?.state, 'running');
    assert.equal(rows[0]?.startedAt, new Date(NOW_S * 1_000).toISOString(), 'the meta mtime, not the bait');
    // And it stays that way over the next polls: the refusal is not a race.
    await sleep(NO_REPORT_MS);
    const last = w.seen[w.seen.length - 1]?.agents as SessionAgent[];
    assert.equal(last[0]?.tokens, 0);
    assert.equal(last[0]?.state, 'running');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a DIRECTORY named like a meta makes no row at all', async () => {
  // readdir gives names, not kinds: without the isFile() check a directory
  // called `agent-<hex>.meta.json` would invent a whole agent that never ran.
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await mkdir(join(w.dir, 'agent-dd.meta.json'), { recursive: true });
    await writeMeta(w.dir, 'ab', { agentType: 'real-one', description: '' }, NOW_S);
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length >= 1);
    await sleep(NO_REPORT_MS);
    const last = w.seen[w.seen.length - 1]?.agents as SessionAgent[];
    assert.equal(last.length, 1, `only the real agent; got ${JSON.stringify(last)}`);
    assert.equal(last[0]?.id, 'ab');
    assert.equal(rows.length, 1);
  } finally {
    await w.cleanup();
  }
});

test('watcher: five running + five finished → the four OLDEST running rows, no finished row, counts 5/5', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    // Five running, started 10:00, 10:01, … (the meta mtime does not decide the
    // order once there are lines: the FIRST line does).
    for (let i = 0; i < 5; i++) {
      const id = `b${i}`;
      await writeMeta(w.dir, id, { agentType: `run-${i}`, description: 'x' });
      await appendLines(w.dir, id, [userLine(`2026-09-16T10:0${i}:00.000Z`)]);
    }
    // Five finished, ending 11:00 … 11:04.
    for (let i = 0; i < 5; i++) {
      const id = `c${i}`;
      await writeMeta(w.dir, id, { agentType: `fin-${i}`, description: 'x' });
      await appendLines(w.dir, id, [
        userLine('2026-09-16T09:00:00.000Z'),
        assistantLine(`2026-09-16T11:0${i}:00.000Z`, `m${i}`, { output_tokens: 1 }, 'end_turn'),
      ]);
    }
    w.watcher.track('sess-1', w.dir);
    const report = await waitForReport(w.seen, (r) => r.counts.running === 5 && r.counts.finished === 5);
    assert.equal(report.agents.length, MAX_RUNNING_ROWS);
    assert.deepEqual(
      report.agents.map((r) => r.name),
      ['run-0', 'run-1', 'run-2', 'run-3'],
      'running oldest-first, first four; four run, so no finished row',
    );
  } finally {
    await w.cleanup();
  }
});

test(`watcher: at most ${MAX_AGENTS} agents are tracked, newest meta first`, async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    // 70 metas with strictly increasing mtimes: the 6 oldest fall off the
    // MAX_AGENTS window, so the oldest row is the 7th-oldest meta.
    // All within the last two minutes, so nothing is stale; strictly
    // increasing, so "newest meta first" has one answer.
    const base = NOW_S - 100;
    for (let i = 0; i < 70; i++) {
      await writeMeta(w.dir, `d${i.toString(16).padStart(2, '0')}`, { agentType: `a${i}`, description: '' }, base + i);
    }
    w.watcher.track('sess-1', w.dir);
    const report = await waitForReport(w.seen, (r) => r.counts.running === MAX_AGENTS);
    assert.deepEqual(
      report.agents.map((r) => r.name),
      ['a6', 'a7', 'a8', 'a9'],
      'a0-a5 were never tracked; the rest are the oldest of those that were',
    );
    // The count covers the TRACKED agents only: the six beyond MAX_AGENTS are
    // beyond both the list and the count.
    assert.deepEqual(report.counts, { running: MAX_AGENTS, finished: 0 });
  } finally {
    await w.cleanup();
  }
});

test('watcher: a file that is not `agent-<hex>.meta.json` is never opened', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    for (const name of [
      'agent-.meta.json',
      'agent-XYZ.meta.json', // not lowercase hex
      'agent-a0.meta.json.bak',
      'agent-a0.json',
      `agent-${'a'.repeat(33)}.meta.json`, // past the 32-character cap
      'meta.json',
      'notes.txt',
      '..meta.json',
    ]) {
      await writeFile(join(w.dir, name), JSON.stringify({ agentType: 'planted', description: 'planted' }));
    }
    await writeMeta(w.dir, 'ab', { agentType: 'real', description: '' });
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length >= 1);
    assert.deepEqual(rows.map((r) => r.name), ['real']);
  } finally {
    await w.cleanup();
  }
});

test('watcher: a SYMLINK named like a meta is refused, and the row keeps the honest fallback', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    const secret = join(w.root, 'secret.json');
    await writeFile(secret, JSON.stringify({ agentType: 'stolen', description: 'from outside the directory' }));
    await symlink(secret, join(w.dir, 'agent-ac.meta.json'));
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 1);
    assert.deepEqual(rows[0]?.name, 'agent', 'O_NOFOLLOW: nothing from the link target reaches the row');
    assert.equal(rows[0]?.task, '');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a FIFO named like a transcript never blocks the poll', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'ad', { agentType: 'fifo-victim', description: '' });
    execFileSync('mkfifo', [join(w.dir, 'agent-ad.jsonl')]);
    w.watcher.track('sess-1', w.dir);
    // If the FIFO were opened and read, this would never come back.
    const rows = await waitFor(w.seen, (a) => a.length === 1, 3_000);
    assert.equal(rows[0]?.name, 'fifo-victim');
    assert.equal(rows[0]?.tokens, 0);
  } finally {
    await w.cleanup();
  }
});

test('watcher: meta strings are control-stripped and capped at 64 / 120', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'ae', {
      agentType: `${ESC}[31mred${NUL}\n${'n'.repeat(200)}`,
      description: `${DEL}${'t'.repeat(300)}`,
    });
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 1);
    const name = rows[0]?.name as string;
    const task = rows[0]?.task as string;
    assert.equal(name.length, 64);
    assert.equal(task.length, 120);
    assert.equal(/[\u0000-\u001F\u007F-\u009F]/.test(name), false, 'no ESC reaches a terminal or the DOM');
    assert.equal(/[\u0000-\u001F\u007F-\u009F]/.test(task), false);
    assert.equal(name.startsWith('[31mred'), true, 'the ESC became a space, the text stayed');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a meta that is not JSON, or has no agentType, still makes an honest row', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'b1', 'not json at all');
    await writeMeta(w.dir, 'b2', { model: 'opus' }); // no agentType, no description
    await writeMeta(w.dir, 'b3', { agentType: 42, description: ['x'] }); // wrong types
    await writeMeta(w.dir, 'b4', `{"agentType":"big","description":"${'x'.repeat(9_000)}"}`); // over 8 KiB
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 4);
    for (const row of rows) {
      assert.equal(row.name, 'agent', `${row.id}: the fallback, never a guess`);
      assert.equal(row.task, '');
    }
  } finally {
    await w.cleanup();
  }
});

test('watcher: a meta caught EMPTY is read again once its write lands with the same mtime (Q3)', async () => {
  // The race (.claude/plans/PLAN-QUALITY.md § Q3): a poll lands between the
  // meta's creation and its write, and the write keeps the same coarse mtime.
  // The JSON arrives by rename from a sibling pinned to that same mtime, so no
  // poll can ever see a different mtime in between — only the size changes.
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'c1', '', NOW_S);
    w.watcher.track('sess-1', w.dir);
    // One poll has read the empty meta: its row is out, on the placeholder.
    const first = await waitFor(w.seen, (a) => a.length === 1);
    assert.equal(first[0]?.name, 'agent');
    const staged = join(w.dir, 'staged.tmp');
    await writeFile(staged, JSON.stringify({ agentType: 'honest', description: 'late write' }));
    await utimes(staged, NOW_S, NOW_S);
    await rename(staged, join(w.dir, 'agent-c1.meta.json'));
    const rows = await waitFor(w.seen, (a) => a[0]?.name === 'honest', 2_000);
    assert.equal(rows[0]?.task, 'late write');
    assert.equal(rows[0]?.startedAt, new Date(NOW_S * 1_000).toISOString(), 'the mtime really stayed put');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a meta that stays broken is not read again on every poll (Q3)', async () => {
  // Every read of a broken meta logs its debug line, so the lines count the
  // reads. Transcript growth proves later polls really ran.
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'c2', 'not json at all');
    await writeMeta(w.dir, 'c3', `{"agentType":"big","description":"${'x'.repeat(9_000)}"}`); // over 8 KiB
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length === 2);
    for (let i = 1; i <= 3; i++) {
      await appendLines(w.dir, 'c2', [assistantLine(`2026-09-16T10:00:0${i}.000Z`, `m${i}`, { output_tokens: 1 })]);
      await waitFor(w.seen, (a) => a.find((r) => r.id === 'c2')?.tokens === i);
    }
    assert.equal(w.logs.filter((l) => l.includes('agent c2: meta is not JSON')).length, 1);
    assert.equal(w.logs.filter((l) => l.includes('agent c3: meta unreadable')).length, 1);
  } finally {
    await w.cleanup();
  }
});

test('watcher: the TAIL of a dropped over-long line is never parsed as a line of its own', async () => {
  // A line that is still unterminated when the poll ends and is already past
  // MAX_LINE is given up on, and reading RESYNCS at the next newline. Without
  // that resync the remainder of the abandoned line arrives as a "line" of its
  // own on the next poll — and a planted transcript can make that remainder
  // valid JSON, which is how a discarded line would put numbers on the wire.
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'fe', { agentType: 'resync', description: '' }, NOW_S);
    // 1.2 MiB with no newline yet: past MAX_LINE, so the carry is dropped.
    await appendFile(join(w.dir, 'agent-fe.jsonl'), 'x'.repeat(1_200_000), { mode: 0o600 });
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length === 1);

    // The rest of that same line is a complete assistant message, followed by
    // a real line. Only the real one may be believed.
    const ghost = assistantLine('2026-09-16T09:00:00.000Z', 'ghost', { output_tokens: 777 }, 'end_turn');
    await appendFile(join(w.dir, 'agent-fe.jsonl'), `${ghost}\n${userLine('2026-09-16T10:00:00.000Z')}\n`);
    const rows = await waitFor(w.seen, (a) => a[0]?.startedAt === '2026-09-16T10:00:00.000Z');
    assert.equal(rows[0]?.tokens, 0, 'the tail of the dropped line was not a message');
    assert.equal(rows[0]?.state, 'running', 'and its end_turn never counted');
  } finally {
    await w.cleanup();
  }
});

test('watcher: an agentType that CLEANS to nothing falls back to `agent`', async () => {
  // Not the same case as a MISSING agentType: this meta carries a string, and
  // it survives clean() as ''. An empty name is not a name to draw, so the row
  // must show the honest placeholder rather than a blank cell.
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'c1', { agentType: `${ESC}${NUL}${DEL}   \n\t`, description: 'still a task' });
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 1);
    assert.equal(rows[0]?.name, 'agent');
    assert.equal(rows[0]?.task, 'still a task', 'the description was there and is kept');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a task longer than 120 characters is CAPPED, not dropped', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'c2', { agentType: 'x'.repeat(65), description: `${'t'.repeat(121)}TAIL` });
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 1);
    assert.equal(rows[0]?.task, 't'.repeat(120), 'the first 120 characters, and nothing after them');
    assert.equal(rows[0]?.name, 'x'.repeat(64));
  } finally {
    await w.cleanup();
  }
});

test('watcher: equal stamps are broken by id, so the order is stable both halves', async () => {
  // Two agents that started in the same millisecond (the orchestrator spawned
  // them in one turn) must not swap places between polls: the table would
  // flicker and every poll would broadcast a "change".
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    // The meta mtimes run the OTHER way round, so the order below can only
    // come from the id tie-break: without it a stable sort leaves the agents
    // in the order the directory listing produced (newest meta first).
    let mtime = NOW_S - 1;
    for (const id of ['ff', 'a1', '0b']) {
      await writeMeta(w.dir, id, { agentType: `run-${id}`, description: '' }, mtime--);
      await appendLines(w.dir, id, [userLine('2026-09-16T10:00:00.000Z')]);
    }
    for (const id of ['ee', 'b2', '0c']) {
      await writeMeta(w.dir, id, { agentType: `fin-${id}`, description: '' }, mtime--);
      await appendLines(w.dir, id, [
        userLine('2026-09-16T09:00:00.000Z'),
        assistantLine('2026-09-16T11:00:00.000Z', `m-${id}`, { output_tokens: 1 }, 'end_turn'),
      ]);
    }
    w.watcher.track('sess-1', w.dir);
    const report = await waitForReport(w.seen, (r) => r.counts.running === 3 && r.counts.finished === 3);
    assert.deepEqual(
      report.agents.map((r) => r.id),
      ['0b', 'a1', 'ff', '0c'],
      'running first (ids ascending on a tie), then the one finished row (ids ascending on a tie)',
    );
  } finally {
    await w.cleanup();
  }
});

test('watcher: a line past 1 MiB is skipped unparsed and reading resyncs at the next one', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'b5', { agentType: 'a', description: '' });
    const huge = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-16T10:00:00.000Z',
      message: { id: 'huge', stop_reason: 'end_turn', usage: { output_tokens: 999_999 }, pad: 'x'.repeat(MAX_LINE + 1) },
    });
    await appendLines(w.dir, 'b5', [huge, assistantLine('2026-09-16T10:01:00.000Z', 'small', { output_tokens: 3 })]);
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a[0]?.tokens === 3);
    assert.equal(rows[0]?.tokens, 3, 'the over-long line contributed nothing');
    assert.equal(rows[0]?.state, 'running', 'and its end_turn was never read');
  } finally {
    await w.cleanup();
  }
});
