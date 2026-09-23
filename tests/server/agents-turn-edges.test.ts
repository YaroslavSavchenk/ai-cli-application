/**
 * server/agents.ts — Nocturne B11 (.claude/plans/nocturne/PLAN-B11.md), the
 * edges: tests for the mutants the B11 test review and the B11 mutation gate
 * found the suite letting through — the list rule ordering by TIME, a
 * transcript of exactly TURN_TAIL_BYTES, no stale rule for the turn, a
 * missing parent vs a missing transcript, the PENDING slug folder (and one
 * created as a symlink out of the root), ENAMETOOLONG / EACCES lookups, a
 * sibling `<root>-evil`, the tail resync, round-robin budget sharing, the
 * 4 MiB per-file cap on the main transcript, an untrack mid-sweep, and a
 * finished-total-only change being one frame.
 *
 * How: real watchers over real temp directories, subagentsDirFor in-process,
 * and a real SessionManager with a frame-keeping fake client
 * (`tests/helpers/agents-fixture.ts`). The EACCES cases skip as root
 * (`IS_ROOT`): root bypasses the permission bits they rely on.
 *
 * NOT claimed here: the B11 rules themselves — `tests/server/agents-turn.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { AgentsWatcher, subagentsDirFor } from '../../server/agents.ts';
import { sleep, IS_ROOT, makeTempDir } from '../helpers/helpers.ts';
import {
  UUID,
  OTHER_UUID,
  TURN_TAIL_BYTES,
  makeRoot,
  assistantLine,
  userLine,
  type Seen,
  makeWatcher,
  writeMeta,
  appendLines,
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
// B11 test-review additions: mutants the tests in agents-turn.test.ts let through
// ---------------------------------------------------------------------------

test('watcher: the list rule orders by TIME, not by id — oldest-started running rows, latest-ended finished row', async () => {
  // The ids run AGAINST the clock here, so a sort that falls back to the id
  // (or reads startedAt where endedAt decides) picks the wrong rows. In the
  // four-example tests above ids and times agree, which hides exactly that.
  const w = await makeWatcher();
  try {
    // Five running: b0 started LAST, b4 FIRST → rows b4, b3, b2, b1.
    for (let i = 0; i < 5; i++) {
      await writeMeta(w.dir, `b${i}`, { agentType: `run-b${i}`, description: '' });
      await appendLines(w.dir, `b${i}`, [userLine(`2026-09-16T10:${String(20 - i).padStart(2, '0')}:00.000Z`)]);
    }
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    const five = await waitForReport(w.seen, (r) => r.counts.running === 5);
    assert.deepEqual(five.agents.map((r) => r.name), ['run-b4', 'run-b3', 'run-b2', 'run-b1']);
  } finally {
    await w.cleanup();
  }

  const v = await makeWatcher();
  try {
    // Two running + three finished. c1 ENDED last but STARTED first; c0 and c2
    // bracket it on id, so neither id order nor startedAt order lands on c1.
    await plantAgents(v.dir, 2, 0);
    const fin: [string, string, string][] = [
      ['c0', '2026-09-16T09:10:00.000Z', '2026-09-16T11:10:00.000Z'],
      ['c1', '2026-09-16T09:00:00.000Z', '2026-09-16T11:30:00.000Z'],
      ['c2', '2026-09-16T09:20:00.000Z', '2026-09-16T11:20:00.000Z'],
    ];
    for (const [id, start, end] of fin) {
      await writeMeta(v.dir, id, { agentType: `fin-${id}`, description: '' });
      await appendLines(v.dir, id, [userLine(start), assistantLine(end, `m-${id}`, { output_tokens: 1 }, 'end_turn')]);
    }
    v.watcher.start((id, report) => v.seen.push({ id, agents: report.agents, report }));
    v.watcher.track('sess-1', v.dir);
    const r = await waitForReport(v.seen, (x) => x.counts.running === 2 && x.counts.finished === 3);
    assert.deepEqual(r.agents.map((a) => a.name), ['run-0', 'run-1', 'fin-c1'], 'the one most recently FINISHED');
  } finally {
    await v.cleanup();
  }
});

test('watcher: a transcript of EXACTLY TURN_TAIL_BYTES is read from byte 0 — its first line counts', async () => {
  // The boundary of `size > TURN_TAIL_BYTES`: at equality the whole file is
  // the tail, so nothing is partial and the first line must not be dropped.
  const w = await makeWatcher({ create: false });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    const first = `${REAL.prompt}\n`;
    const rest = filler(TURN_TAIL_BYTES - first.length - 4_000);
    const pad = TURN_TAIL_BYTES - first.length - Buffer.byteLength(rest);
    const body = `${first}${rest}${'z'.repeat(pad - 1)}\n`; // last line: junk, skipped
    assert.equal(Buffer.byteLength(body), TURN_TAIL_BYTES);
    await writeFile(mainFile(w), body, { mode: 0o600 });
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    const report = await waitForReport(w.seen, (r) => r.turn !== undefined);
    assert.equal(report.turn, 'working', 'the prompt at byte 0 is the verdict');
  } finally {
    await w.cleanup();
  }
});

test('watcher: NO stale rule for the turn — a long tool call hours old still reads working', async () => {
  // Agents go stale after STALE_MS; the session's own turn never does
  // (PLAN-B11 § The turn rule: "a long tool call is still working").
  const w = await makeWatcher({ create: false, now: () => Date.now() + 24 * 60 * 60 * 1000 });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    await appendMain(w, [REAL.prompt, REAL.toolUse]);
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    const report = await waitForReport(w.seen, (r) => r.turn !== undefined);
    assert.equal(report.turn, 'working');
    await sleep(150);
    assert.deepEqual(w.seen.map((s) => s.report.turn), ['working'], 'never flips to waiting by age');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a MISSING PARENT directory is not a missing transcript — no turn, never waiting', async () => {
  // Only `<parent>/<uuid>.jsonl` absent inside an existing parent — or a slug
  // folder that is ONE missing component directly under the real root (B11
  // F1, pending) — means "at the first prompt". A parent missing deeper than
  // that, or missing outside the root, may not be read at all.
  const w = await makeWatcher({ create: false });
  const outside = realpathSync(await makeTempDir('ai-sm-turn-noparent-'));
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    // Two missing components: `<root>/-a` and `<root>/-a/-b`.
    w.watcher.track('sess-deep', join(w.root, '-a', '-b', UUID, 'subagents'));
    // One missing component — but under a directory that is NOT the root.
    w.watcher.track('sess-outside', join(outside, '-slug', UUID, 'subagents'));
    // One missing component under a subfolder of the root, not the root itself.
    await mkdir(join(w.root, '-x'), { recursive: true });
    w.watcher.track('sess-nested', join(w.root, '-x', '-slug', UUID, 'subagents'));
    await sleep(200);
    assert.equal(w.seen.length, 0, `got ${JSON.stringify(w.seen[0])}`);
  } finally {
    await w.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test('subagentsDirFor: a slug folder that is ONE missing component under the real root is accepted (pending), nothing else', async () => {
  const r = await makeRoot();
  try {
    // Claude Code has never opened this folder: `<root>/<slug>` is not there.
    const fresh = join(r.root, '-home-u-projects-new');
    assert.equal(subagentsDirFor(join(fresh, `${UUID}.jsonl`), r.root), join(fresh, UUID, 'subagents'));
    // Two missing components.
    assert.equal(subagentsDirFor(join(r.root, '-a', '-b', `${UUID}.jsonl`), r.root), null);
    // One missing component under a subfolder of the root, not the root itself.
    assert.equal(subagentsDirFor(join(r.slug, '-deeper', `${UUID}.jsonl`), r.root), null);
    // One missing component outside the root.
    assert.equal(subagentsDirFor(join(r.base, '-slug', `${UUID}.jsonl`), r.root), null);
    // A DANGLING symlink wearing the slug's name exists for lstat: not pending.
    await symlink(join(r.base, 'nowhere'), join(r.root, '-dangling'));
    assert.equal(subagentsDirFor(join(r.root, '-dangling', `${UUID}.jsonl`), r.root), null);
    // The lexical checks still come first: a bad name is refused even when pending.
    assert.equal(subagentsDirFor(join(fresh, 'not-a-uuid.jsonl'), r.root), null);
    assert.equal(subagentsDirFor(`${fresh}/../-evil/${UUID}.jsonl`, r.root), null);
    // A root reached through a symlink: the pending path is built from the REAL root.
    const alias = join(r.base, 'alias');
    await symlink(r.root, alias);
    assert.equal(
      subagentsDirFor(join(alias, '-home-u-projects-new', `${UUID}.jsonl`), r.root),
      join(r.root, '-home-u-projects-new', UUID, 'subagents'),
    );
  } finally {
    await r.cleanup();
  }
});

test('watcher: PENDING slug folder — waiting, then the folder appears and the transcript is read (tool_use → working)', async () => {
  const w = await makeWatcher({ create: false }); // `<root>/-slug` does not exist
  try {
    const dir = subagentsDirFor(mainFile(w), w.root);
    assert.equal(dir, w.dir, 'index.ts would track it');
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    const first = await waitForReport(w.seen, (r) => r.turn === 'waiting');
    assert.deepEqual(first, { agents: [], counts: { running: 0, finished: 0 }, turn: 'waiting' });
    // The first prompt: Claude Code creates the folder and the transcript.
    await mkdir(join(w.root, '-slug'), { recursive: true });
    await appendMain(w, [REAL.prompt, REAL.toolUse]);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    // And its subagents are read from the same, now real, folder.
    await mkdir(w.dir, { recursive: true });
    await writeMeta(w.dir, 'ab', { agentType: 'late', description: '' });
    const withAgent = await waitForReport(w.seen, (r) => r.agents.length === 1);
    assert.equal(withAgent.turn, 'working');
  } finally {
    await w.cleanup();
  }
});

test('watcher: PENDING slug folder created as a SYMLINK out of the root is refused — no turn, no agents', async () => {
  const w = await makeWatcher({ create: false });
  const outside = realpathSync(await makeTempDir('ai-sm-turn-pendsym-'));
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    // What the outside tree would say, if it were read: a verdict and an agent.
    await writeFile(join(outside, `${UUID}.jsonl`), `${REAL.prompt}\n`, { mode: 0o600 });
    await mkdir(join(outside, UUID, 'subagents'), { recursive: true });
    await writeMeta(join(outside, UUID, 'subagents'), 'cd', { agentType: 'stolen', description: '' });
    await symlink(outside, join(w.root, '-slug'));
    const report = await waitForReport(w.seen, (r) => r.turn === undefined);
    assert.deepEqual(report, { agents: [], counts: { running: 0, finished: 0 } });
    await sleep(150);
    assert.equal(w.seen.some((s) => s.report.turn === 'working' || s.agents.length > 0), false, JSON.stringify(w.seen));
    assert.equal(w.logs.some((l) => l.includes('resolves outside the projects root, refused')), true, w.logs.join(' | '));
  } finally {
    await w.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test('watcher: the tick budget is shared ROUND ROBIN — a busy first session cannot starve a later one', async () => {
  // 256 KiB per tick. Session A (tracked first) needs its whole 1 MiB tail read
  // before its verdict: 5 ticks. Session B needs one small line. In a fixed
  // order B would get nothing until A caught up; round robin starts B first
  // within two ticks, so B's verdict arrives while A is still reading.
  const root = realpathSync(await makeTempDir('ai-sm-agentrr-'));
  const seen: Seen[] = [];
  const watcher = new AgentsWatcher(() => {}, { projectsRoot: root, pollMs: 40, readBudgetBytes: 256 * 1024 });
  try {
    const slugA = join(root, '-a');
    const slugB = join(root, '-b');
    await mkdir(slugA, { recursive: true });
    await mkdir(slugB, { recursive: true });
    await writeFile(join(slugA, `${UUID}.jsonl`), `${filler(2 * 1024 * 1024)}${REAL.endTurn}\n`, { mode: 0o600 });
    await writeFile(join(slugB, `${OTHER_UUID}.jsonl`), `${REAL.prompt}\n`, { mode: 0o600 });
    watcher.start((id, report) => seen.push({ id, agents: report.agents, report }));
    watcher.track('sess-a', join(slugA, UUID, 'subagents'));
    watcher.track('sess-b', join(slugB, OTHER_UUID, 'subagents'));
    const deadline = Date.now() + 10_000;
    while (!seen.some((s) => s.id === 'sess-a' && s.report.turn === 'waiting')) {
      if (Date.now() >= deadline) throw new Error(`A never got its verdict; ${JSON.stringify(seen.map((s) => [s.id, s.report.turn]))}`);
      await sleep(10);
    }
    const order = seen.map((s) => `${s.id}:${s.report.turn}`);
    assert.equal(order[0], 'sess-b:working', `B went first, while A was still reading; order ${JSON.stringify(order)}`);
    assert.deepEqual(order, ['sess-b:working', 'sess-a:waiting']);
  } finally {
    watcher.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('watcher: the 4 MiB PER-FILE cap holds on the main transcript — a 5 MiB growth takes at least two ticks', async () => {
  // A 64 MiB tick budget would read it all at once; MAX_READ_PER_POLL must
  // not. `now()` is called once per session per tick (the report), so it
  // doubles as a tick counter.
  let ticks = 0;
  const w = await makeWatcher({
    create: false,
    readBudgetBytes: 64 * 1024 * 1024,
    now: () => {
      ticks++;
      return Date.now();
    },
  });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    await appendMain(w, [REAL.prompt]);
    const at: number[] = [];
    w.watcher.start((id, report) => {
      at.push(ticks);
      w.seen.push({ id, agents: report.agents, report });
    });
    w.watcher.track('sess-1', w.dir);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    const before = ticks; // every tick up to here saw none of the growth
    await appendFile(mainFile(w), `${filler(5 * 1024 * 1024)}${REAL.endTurn}\n`, { mode: 0o600 });
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    const verdictTick = at[at.length - 1] as number;
    assert.equal(verdictTick - before >= 2, true, `verdict ${verdictTick - before} tick(s) after the growth began`);
  } finally {
    await w.cleanup();
  }
});

// ---------------------------------------------------------------------------
// B11 mutation gate: tests for the mutants the suite let through
// ---------------------------------------------------------------------------

test('subagentsDirFor: a slug name the filesystem cannot even look up (ENAMETOOLONG) is not pending', async () => {
  // pendingSlug accepts ONLY a truly missing folder (lstat ENOENT); any other
  // lstat error — here a 300-byte component — is a refusal, not "not there yet".
  const r = await makeRoot();
  try {
    assert.equal(subagentsDirFor(join(r.root, 's'.repeat(300), `${UUID}.jsonl`), r.root), null);
  } finally {
    await r.cleanup();
  }
});

test('watcher: a tracked directory whose last component is not `subagents` derives no transcript', async () => {
  const w = await makeWatcher({ create: false });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    await appendMain(w, [REAL.prompt]); // `<root>/-slug/<UUID>.jsonl` would say working
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', join(w.root, '-slug', UUID, 'elsewhere'));
    await sleep(200);
    assert.equal(w.seen.length, 0, `got ${JSON.stringify(w.seen[0]?.report)}`);
  } finally {
    await w.cleanup();
  }
});

test('watcher: a main transcript under a SIBLING of the root (`<root>-evil`) is refused, not prefix-matched', async () => {
  const w = await makeWatcher({ create: false });
  const evil = `${w.root}-evil`;
  try {
    await mkdir(join(evil, '-slug'), { recursive: true });
    await writeFile(join(evil, '-slug', `${UUID}.jsonl`), `${REAL.prompt}\n`, { mode: 0o600 });
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', join(evil, '-slug', UUID, 'subagents'));
    await sleep(200);
    assert.equal(w.seen.length, 0, `got ${JSON.stringify(w.seen[0]?.report)}`);
    assert.equal(w.logs.some((l) => l.includes('resolves outside the projects root, refused')), true, w.logs.join(' | '));
  } finally {
    await w.cleanup();
    await rm(evil, { recursive: true, force: true });
  }
});

test('watcher: a transcript that cannot be looked up (EACCES) is not "missing" — no turn, never waiting', { skip: IS_ROOT }, async () => {
  // Only lstat ENOENT means "at the first prompt"; a parent folder this user
  // may not search is an unreadable transcript, not an absent one.
  const w = await makeWatcher({ create: false });
  const parent = join(w.root, '-slug');
  try {
    await mkdir(parent, { recursive: true });
    await appendMain(w, [REAL.endTurn]);
    await chmod(parent, 0o600); // no search bit: realpath and lstat of the file fail EACCES
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await sleep(200);
    assert.equal(w.seen.length, 0, `got ${JSON.stringify(w.seen[0]?.report)}`);
  } finally {
    await chmod(parent, 0o700).catch(() => {});
    await w.cleanup();
  }
});

test('watcher: a main transcript that becomes UNOPENABLE loses its verdict — the old one is not kept', { skip: IS_ROOT }, async () => {
  const w = await makeWatcher({ create: false });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    await appendMain(w, [REAL.prompt]);
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    await chmod(mainFile(w), 0o000); // realpath still resolves; open() is EACCES
    const report = await waitForReport(w.seen, (r) => r.turn === undefined);
    assert.deepEqual(report, { agents: [], counts: { running: 0, finished: 0 } });
  } finally {
    await chmod(mainFile(w), 0o600).catch(() => {});
    await w.cleanup();
  }
});

test('watcher: the tail RESYNCS — a partial first line that would parse from mid-line is still dropped', async () => {
  // The line straddling the boundary is `xxx… {"type":"user",…}`: not JSON as a
  // whole, but its bytes from the boundary on (`␠{…}`, the read starts one byte
  // early) ARE. Only the resync keeps that half from counting as 'working'.
  const w = await makeWatcher({ create: false });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    const json = JSON.stringify({ type: 'user', message: { content: 'go' } });
    const rest = filler(TURN_TAIL_BYTES - json.length - 1 - 3_000);
    const pad = TURN_TAIL_BYTES - json.length - 1 - Buffer.byteLength(rest);
    const tail = `${json}\n${rest}${'z'.repeat(pad - 1)}\n`; // last line: junk, skipped
    assert.equal(Buffer.byteLength(tail), TURN_TAIL_BYTES);
    await writeFile(mainFile(w), `${filler(8 * 1024)}${'x'.repeat(500)} ${tail}`, { mode: 0o600 });
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await sleep(200);
    assert.equal(w.seen.length, 0, `the partial first line counted; got ${JSON.stringify(w.seen[0]?.report)}`);
  } finally {
    await w.cleanup();
  }
});

test('watcher: bytes read from the MAIN transcript are spent from the tick budget — agents wait their turn', async () => {
  // 256 KiB per tick and a 1 MiB tail on the main transcript: the first tick's
  // budget is gone before the agent's transcript is reached, so the agent row
  // first appears from its meta alone (0 tokens), and its tokens only later.
  const w = await makeWatcher({ readBudgetBytes: 256 * 1024 });
  try {
    await writeFile(mainFile(w), filler(2 * 1024 * 1024), { mode: 0o600 });
    await writeMeta(w.dir, 'ad', { agentType: 'budgeted', description: '' });
    await appendLines(w.dir, 'ad', [userLine('2026-09-16T10:00:00.000Z'), assistantLine('2026-09-16T10:00:01.000Z', 'm1', { output_tokens: 7 })]);
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await waitForReport(w.seen, (r) => r.agents[0]?.tokens === 7);
    assert.equal(w.seen[0]?.report.agents[0]?.tokens, 0, `the main read did not spend the budget; ${JSON.stringify(w.seen[0]?.report)}`);
  } finally {
    await w.cleanup();
  }
});

test('watcher: a session untracked by the consumer MID-SWEEP is not polled on its stale record', async () => {
  const root = realpathSync(await makeTempDir('ai-sm-agentsweep-'));
  const seen: string[] = [];
  const watcher = new AgentsWatcher(() => {}, { projectsRoot: root, pollMs: 20 });
  try {
    for (const [slug, uuid] of [['-a', UUID], ['-b', OTHER_UUID]] as const) {
      await mkdir(join(root, slug), { recursive: true });
      await writeFile(join(root, slug, `${uuid}.jsonl`), `${REAL.prompt}\n`, { mode: 0o600 });
    }
    // Tracked before start: the first sweep (tick 0) visits A, then B.
    watcher.track('sess-a', join(root, '-a', UUID, 'subagents'));
    watcher.track('sess-b', join(root, '-b', OTHER_UUID, 'subagents'));
    watcher.start((id) => {
      seen.push(id);
      if (id === 'sess-a') watcher.untrack('sess-b'); // e.g. B exited meanwhile
    });
    const deadline = Date.now() + 5_000;
    while (!seen.includes('sess-a')) {
      if (Date.now() >= deadline) throw new Error('A never reported');
      await sleep(10);
    }
    await sleep(100);
    assert.deepEqual(seen, ['sess-a'], 'B was untracked before its turn in the same sweep');
  } finally {
    watcher.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('SessionManager.setReport: only the FINISHED total moving is a change too — one frame', async () => {
  const m = await makeManager();
  try {
    const info = m.manager.create({ command: 'bash', args: ['-c', 'sleep 30'], cwd: m.root, cols: 80, rows: 24 });
    const client = new FakeClient();
    assert.equal(m.manager.attach(info.id, client.asWs()), true);
    m.manager.setReport(info.id, report([ROW], { counts: { running: 1, finished: 0 } }));
    const n = client.infoFrames().length;
    m.manager.setReport(info.id, report([ROW], { counts: { running: 1, finished: 3 } }));
    assert.equal(client.infoFrames().length, n + 1);
    assert.deepEqual(m.manager.get(info.id)?.agentCounts, { running: 1, finished: 3 });
    m.manager.destroy(info.id);
  } finally {
    await m.cleanup();
  }
});
