/**
 * Persistent session history with REAL resume (decided 2026-09-06).
 *
 * Contract under test:
 *  - a claude-kind session is pinned to a conversation: the server injects
 *    `--session-id <uuid>` into the CHILD ARGV while SessionInfo.args stays the
 *    client's own argv (same discipline as the `--settings` status-line flag);
 *  - POST /api/history/:id/resume respawns THAT conversation with
 *    `<base args> --resume <id>`, moves the entry's sessionId to the new
 *    session, advances lastUsedAt and keeps createdAt;
 *  - a live entry is 409 for both resume and forget; a vanished cwd is 400;
 *  - claude conversations whose transcript is provably absent are pruned, and
 *    every uncertainty (no `projects/` directory at all) keeps the entry;
 *  - the store is bounded at HISTORY_MAX, dropping the oldest ENDED entry and
 *    never a live one;
 *  - a session launched into a project defaults its title to the PROJECT name;
 *
 * This file holds the server-backed half — the pinning, resume, prune and
 * project-title contract, the two client-argv shapes end to end, and the two
 * guards that keep a wrong id off the filesystem and off the argv. Split out
 * by topic (PLAN-RESTRUCTURE O6): the `SessionHistory` class directly (the
 * HISTORY_MAX bound, stamping, forgetting, boot repair) in
 * `history-store.test.ts`, and planConversation/resumeSpawn — the pure argv
 * table — in `history-argv.test.ts`. The harness is
 * `tests/helpers/history-fixture.ts`.
 *
 * The real `claude` binary is never spawned (interactive, slow, and it would
 * touch the user's own Claude data): a `claude` TEST DOUBLE on PATH records its
 * argv and sleeps, exactly like the `git` double in the GitHub clone tests.
 * CLAUDE_CONFIG_DIR always points at a scratch directory, so nothing here ever
 * reads the user's ~/.claude.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { HistoryEntry, Project, SessionInfo } from '../../shared/protocol.ts';
import {
  api,
  createSession,
} from '../helpers/helpers.ts';
import {
  fixture,
  shimArgv,
  history,
  historyOnDisk,
  encodeCwd,
  withClaudeConfig,
  unitStore,
  infoOf,
  CLIENT_UUID,
} from '../helpers/history-fixture.ts';

test('a claude session is pinned with an injected --session-id that never enters SessionInfo.args, and resume spawns --resume <id>', async () => {
  const f = await fixture();
  try {
    const info = await createSession(f.server, {
      command: 'claude',
      args: ['--model', 'sonnet'],
      cwd: f.workDir,
      cols: 80,
      rows: 24,
    });

    // (a) the CHILD argv carries both injections; the session's args carry neither.
    const argv1 = await shimArgv(f.shimOut, 1);
    assert.deepEqual(info.args, ['--model', 'sonnet'], 'SessionInfo.args stays the client argv');
    assert.equal(info.statusline, true);
    const idIdx = argv1.indexOf('--session-id');
    assert.ok(idIdx >= 0, `child argv must carry --session-id, got ${JSON.stringify(argv1)}`);
    assert.equal(argv1[idIdx + 1], info.id, '--session-id must be the app session id');
    assert.equal(argv1.filter((a) => a === '--session-id').length, 1, 'exactly one --session-id');
    assert.ok(argv1.includes('--settings'), 'the status-line injection still happens');
    assert.deepEqual(argv1.slice(0, 2), ['--model', 'sonnet'], 'client args come first, verbatim');

    // The history entry IS the conversation, keyed by the conversation id.
    const created = await historyOnDisk(f.server);
    assert.equal(created.length, 1);
    const entry0 = created[0] as HistoryEntry;
    assert.equal(entry0.id, info.id);
    assert.equal(entry0.conversation, true);
    assert.equal(entry0.sessionId, info.id);
    assert.deepEqual(entry0.args, ['--model', 'sonnet'], 'base args carry no injected flag');
    assert.equal(entry0.ended, null, 'a running session is live in history');

    // (b) end it, then resume THAT conversation.
    assert.equal((await api(f.server, 'DELETE', `/api/sessions/${info.id}`)).status, 200);
    const listed = await history(f.server);
    assert.equal(listed.length, 1, `the ended session must be listed, got ${JSON.stringify(listed)}`);
    assert.equal(listed[0]?.ended?.reason, 'user-kill', 'a session ended with x is history, not lost');

    const resumed = await api(f.server, 'POST', `/api/history/${info.id}/resume`, {
      cols: 100,
      rows: 30,
    });
    assert.equal(resumed.status, 201, `resume: ${JSON.stringify(resumed.body)}`);
    const next = resumed.body as SessionInfo;
    assert.notEqual(next.id, info.id, 'a resume is a NEW session');
    assert.deepEqual(
      next.args,
      ['--model', 'sonnet', '--resume', info.id],
      'the resume argv is the base args plus --resume <conversation id>',
    );
    assert.equal(next.cols, 100);
    assert.equal(next.rows, 30);
    assert.equal(next.cwd, f.workDir);
    assert.equal(next.title, info.title, 'the title travels with the entry');

    const argv2 = await shimArgv(f.shimOut, 2);
    assert.deepEqual(argv2.slice(0, 4), ['--model', 'sonnet', '--resume', info.id]);
    assert.ok(!argv2.includes('--session-id'), 'never --resume AND --session-id together');
    assert.ok(!argv2.includes('--continue'), 'a pinned conversation never falls back to --continue');
    assert.ok(argv2.includes('--settings'), 'the resume gets a FRESH status-line settings file');

    // ONE entry still, moved onto the new session; createdAt is the first launch.
    const after = await historyOnDisk(f.server);
    assert.equal(after.length, 1, 'a resume updates the entry instead of forking a new one');
    const entry1 = after[0] as HistoryEntry;
    assert.equal(entry1.id, info.id, 'the conversation id is the stable key');
    assert.equal(entry1.sessionId, next.id, 'sessionId moves to the latest launch');
    assert.equal(entry1.createdAt, entry0.createdAt, 'createdAt stays the first launch');
    assert.ok(
      entry1.lastUsedAt > entry0.lastUsedAt,
      `lastUsedAt must advance (${entry0.lastUsedAt} -> ${entry1.lastUsedAt})`,
    );
    assert.equal(entry1.ended, null, 'the resumed entry is live again');
    assert.deepEqual(entry1.args, ['--model', 'sonnet'], 'base args never accumulate --resume');

    // (c) a live entry is 409 for resume AND for forget.
    const reResume = await api(f.server, 'POST', `/api/history/${info.id}/resume`, {
      cols: 80,
      rows: 24,
    });
    assert.equal(reResume.status, 409, `resuming a live entry must be 409: ${JSON.stringify(reResume.body)}`);
    const forgetLive = await api(f.server, 'DELETE', `/api/history/${info.id}`);
    assert.equal(forgetLive.status, 409, 'forgetting a live entry must be 409');
    assert.deepEqual(await history(f.server), [], 'a live entry is never listed');

    // Unknown ids stay 404 on both routes; bad dims are 400.
    assert.equal((await api(f.server, 'POST', '/api/history/nope/resume', { cols: 80, rows: 24 })).status, 404);
    assert.equal((await api(f.server, 'DELETE', '/api/history/nope')).status, 404);
    assert.equal((await api(f.server, 'POST', `/api/history/${info.id}/resume`, { cols: 0, rows: 24 })).status, 400);
    assert.equal((await api(f.server, 'GET', `/api/history/${info.id}/resume`)).status, 405);
  } finally {
    await f.cleanup();
  }
});

test('resume is 400 when the session folder is gone, and drops a projectId whose project was deleted', async () => {
  const f = await fixture();
  const gone = join(f.root, 'vanishing');
  await mkdir(gone);
  try {
    const project = (await api(f.server, 'POST', '/api/projects', {
      name: 'Vanishing',
      path: gone,
    })).body as Project;
    const info = await createSession(f.server, {
      command: 'bash',
      args: ['-c', 'sleep 300'],
      projectId: project.id,
      cols: 80,
      rows: 24,
    });
    assert.equal((await api(f.server, 'DELETE', `/api/sessions/${info.id}`)).status, 200);
    assert.equal((await api(f.server, 'DELETE', `/api/projects/${project.id}`)).status, 200);

    // The project is gone but the folder is still there: resume works, without
    // resurrecting the dead project id.
    const ok = await api(f.server, 'POST', `/api/history/${info.id}/resume`, { cols: 80, rows: 24 });
    assert.equal(ok.status, 201, `resume: ${JSON.stringify(ok.body)}`);
    const respawned = ok.body as SessionInfo;
    assert.equal(respawned.projectId, undefined, 'a deleted project must not come back');
    assert.deepEqual(respawned.args, ['-c', 'sleep 300'], 'a non-claude command gets no resume flag');
    assert.equal((await api(f.server, 'DELETE', `/api/sessions/${respawned.id}`)).status, 200);

    // (d) now the folder itself is gone.
    await rm(gone, { recursive: true, force: true });
    const res = await api(f.server, 'POST', `/api/history/${info.id}/resume`, { cols: 80, rows: 24 });
    assert.equal(res.status, 400, `a vanished cwd must be 400: ${JSON.stringify(res.body)}`);
    assert.match(String((res.body as { error: string }).error), /no longer exists/);
    // It stays listed — the user decides whether to forget it.
    assert.equal((await history(f.server)).length, 1);
  } finally {
    await f.cleanup();
  }
});

test('pruneUnsaid: no projects/ dir prunes nothing; a conversation with a transcript is kept, one without is dropped', async () => {
  const f = await fixture();
  try {
    // Two claude conversations in the same cwd, both ended.
    const a = await createSession(f.server, {
      command: 'claude', args: [], cwd: f.workDir, cols: 80, rows: 24, title: 'said something',
    });
    await shimArgv(f.shimOut, 1);
    assert.equal((await api(f.server, 'DELETE', `/api/sessions/${a.id}`)).status, 200);
    const b = await createSession(f.server, {
      command: 'claude', args: [], cwd: f.workDir, cols: 80, rows: 24, title: 'said nothing',
    });
    await shimArgv(f.shimOut, 2);
    assert.equal((await api(f.server, 'DELETE', `/api/sessions/${b.id}`)).status, 200);

    // (e1) `<configDir>/projects` does not exist -> we have not found Claude's
    // home at all, so NOTHING may be pruned.
    assert.ok(!existsSync(join(f.claudeConfigDir, 'projects')));
    const both = await history(f.server);
    assert.equal(both.length, 2, `no projects/ dir must prune nothing, got ${JSON.stringify(both)}`);

    // (e2)+(e3) projects/ exists, with a transcript for A only.
    const projectDir = join(f.claudeConfigDir, 'projects', encodeCwd(f.workDir));
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${a.id}.jsonl`), '{"type":"user"}\n');

    const kept = await history(f.server);
    assert.deepEqual(
      kept.map((e) => e.id),
      [a.id],
      `only the conversation with a transcript may survive, got ${JSON.stringify(kept.map((e) => e.title))}`,
    );
    const disk = await historyOnDisk(f.server);
    assert.deepEqual(disk.map((e) => e.id), [a.id], 'the prune must persist to history.json');
  } finally {
    await f.cleanup();
  }
});

test('a session launched into a project is titled after the PROJECT, not the command', async () => {
  const f = await fixture();
  try {
    const project = (await api(f.server, 'POST', '/api/projects', {
      name: 'Weather Machine',
      path: f.workDir,
    })).body as Project;

    const noTitle = await createSession(f.server, {
      command: 'bash', args: ['-c', 'sleep 300'], projectId: project.id, cols: 80, rows: 24,
    });
    assert.equal(noTitle.title, 'Weather Machine', 'an absent title takes the project name');

    const blankTitle = await createSession(f.server, {
      command: 'bash', args: ['-c', 'sleep 300'], projectId: project.id, title: '   ',
      cols: 80, rows: 24,
    });
    assert.equal(blankTitle.title, 'Weather Machine', 'a blank title takes the project name');

    const own = await createSession(f.server, {
      command: 'bash', args: ['-c', 'sleep 300'], projectId: project.id, title: 'my name',
      cols: 80, rows: 24,
    });
    assert.equal(own.title, 'my name', 'an explicit title always wins');

    // Emptiness is decided on the TRIMMED title, so the trimmed title is what
    // gets stored — never a name padded with the user's stray spaces.
    const padded = await createSession(f.server, {
      command: 'bash', args: ['-c', 'sleep 300'], projectId: project.id, title: '  x  ',
      cols: 80, rows: 24,
    });
    assert.equal(padded.title, 'x', 'a padded title is stored trimmed');
    const paddedEntry = (await historyOnDisk(f.server)).find((e) => e.sessionId === padded.id);
    assert.notEqual(paddedEntry, undefined, 'the padded launch must have a history entry');
    assert.equal(paddedEntry?.title, 'x', 'the history entry carries the trimmed title too');

    const noProject = await createSession(f.server, {
      command: 'bash', args: ['-c', 'sleep 300'], cwd: f.workDir, cols: 80, rows: 24,
    });
    // With no project the fallback is the FOLDER the session runs in, never
    // the raw command (2026-09-08): a project-less terminal used to be titled
    // `bash`, a command name in the chrome the UI copy rule forbids, and the
    // folder name is what HISTORY already groups it under.
    assert.equal(
      noProject.title,
      basename(f.workDir),
      'with no project the cwd last segment is the fallback',
    );
    assert.notEqual(noProject.title, 'bash', 'the raw command must never be the title');
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// (j) the two client-argv shapes end to end, against a real server
// ---------------------------------------------------------------------------

test('a client-supplied --session-id=<uuid> is ADOPTED end to end: nothing is injected, and resume targets that conversation', async () => {
  const f = await fixture();
  try {
    const info = await createSession(f.server, {
      command: 'claude',
      args: [`--session-id=${CLIENT_UUID}`, '--model', 'sonnet'],
      cwd: f.workDir,
      cols: 80,
      rows: 24,
    });
    const argv1 = await shimArgv(f.shimOut, 1);
    assert.equal(
      argv1.filter((a) => a === '--session-id' || a.startsWith('--session-id=')).length,
      1,
      `exactly one session id may reach the child, got ${JSON.stringify(argv1)}`,
    );
    assert.deepEqual(argv1.slice(0, 3), [`--session-id=${CLIENT_UUID}`, '--model', 'sonnet']);
    assert.deepEqual(info.args, [`--session-id=${CLIENT_UUID}`, '--model', 'sonnet']);

    const created = await historyOnDisk(f.server);
    assert.equal(created.length, 1);
    assert.equal(created[0]?.id, CLIENT_UUID, 'the entry is keyed by the CLIENT conversation id');
    assert.equal(created[0]?.conversation, true);
    assert.equal(created[0]?.sessionId, info.id);
    assert.deepEqual(created[0]?.args, ['--model', 'sonnet'], 'the base args carry no session flag');

    // A transcript exists for it, so the prune keeps it whatever the fixture's
    // config dir looks like.
    const projectDir = join(f.claudeConfigDir, 'projects', encodeCwd(f.workDir));
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${CLIENT_UUID}.jsonl`), '{"type":"user"}\n');

    assert.equal((await api(f.server, 'DELETE', `/api/sessions/${info.id}`)).status, 200);
    assert.deepEqual((await history(f.server)).map((e) => e.id), [CLIENT_UUID]);

    const resumed = await api(f.server, 'POST', `/api/history/${CLIENT_UUID}/resume`, {
      cols: 80,
      rows: 24,
    });
    assert.equal(resumed.status, 201, `resume: ${JSON.stringify(resumed.body)}`);
    assert.deepEqual((resumed.body as SessionInfo).args, ['--model', 'sonnet', '--resume', CLIENT_UUID]);
    const argv2 = await shimArgv(f.shimOut, 2);
    assert.deepEqual(argv2.slice(0, 4), ['--model', 'sonnet', '--resume', CLIENT_UUID]);
    assert.ok(
      !argv2.some((a) => a === '--session-id' || a.startsWith('--session-id=')),
      'a resume never carries a session id next to --resume',
    );
    assert.equal((await historyOnDisk(f.server)).length, 1, 'still one entry');

    assert.equal(
      (await api(f.server, 'DELETE', `/api/sessions/${(resumed.body as SessionInfo).id}`)).status,
      200,
    );
  } finally {
    await f.cleanup();
  }
});

test('a claude session launched with --continue is NOT pinned: its resume continues with --continue and keeps the one entry', async () => {
  const f = await fixture();
  try {
    const info = await createSession(f.server, {
      command: 'claude',
      args: ['--continue', '--model', 'opus'],
      cwd: f.workDir,
      cols: 80,
      rows: 24,
    });
    const argv1 = await shimArgv(f.shimOut, 1);
    assert.ok(argv1.includes('--continue'), 'the client flag reaches the child');
    assert.ok(
      !argv1.some((a) => a === '--session-id' || a.startsWith('--session-id=')),
      `--continue and --session-id must never be emitted together, got ${JSON.stringify(argv1)}`,
    );

    const created = await historyOnDisk(f.server);
    assert.equal(created.length, 1);
    assert.equal(created[0]?.id, info.id, 'an unpinnable launch is keyed by the app session id');
    assert.equal(created[0]?.conversation, false);
    assert.deepEqual(created[0]?.args, ['--model', 'opus'], '--continue is stripped from the base args');

    assert.equal((await api(f.server, 'DELETE', `/api/sessions/${info.id}`)).status, 200);
    // conversation:false, so the transcript prune never considers it.
    await mkdir(join(f.claudeConfigDir, 'projects'), { recursive: true });
    assert.deepEqual((await history(f.server)).map((e) => e.id), [info.id]);

    const resumed = await api(f.server, 'POST', `/api/history/${info.id}/resume`, {
      cols: 80,
      rows: 24,
    });
    assert.equal(resumed.status, 201, `resume: ${JSON.stringify(resumed.body)}`);
    const next = resumed.body as SessionInfo;
    assert.deepEqual(next.args, ['--model', 'opus', '--continue'], 'best effort: --continue again');

    const argv2 = await shimArgv(f.shimOut, 2);
    assert.equal(argv2.filter((a) => a === '--continue').length, 1, 'exactly one --continue');
    assert.ok(
      !argv2.some((a) => a === '--session-id' || a.startsWith('--session-id=')),
      'the resume must not pin a conversation it cannot know',
    );

    const after = await historyOnDisk(f.server);
    assert.equal(after.length, 1, 'the resume updates the entry instead of forking a new one');
    assert.equal(after[0]?.id, info.id, 'the entry key is stable across the resume');
    assert.equal(after[0]?.sessionId, next.id, 'sessionId moves to the new launch');
    assert.equal(after[0]?.conversation, false, 'still not a conversation');
    assert.deepEqual(after[0]?.args, ['--model', 'opus'], 'base args never accumulate --continue');
    assert.equal(after[0]?.ended, null, 'the entry is live again');

    assert.equal((await api(f.server, 'DELETE', `/api/sessions/${next.id}`)).status, 200);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (k) the two guards that keep a wrong id off the filesystem / off the argv
// ---------------------------------------------------------------------------

test('pruneUnsaid: the encoded-cwd limit is EXACTLY 200 — a 200-char name is judged, a 201-char one is unknowable and kept', async () => {
  const u = await unitStore('cwdlimit');
  const config = join(u.root, 'claude-config');
  const root = await realpath(u.root);
  // encodeCwd is a 1:1 character substitution, so the encoded name is exactly
  // as long as the path. Past 200 Claude Code truncates + hashes the directory
  // name, which we do not reproduce: guessing there would delete real history.
  const at = (len: number): string => {
    const n = len - root.length - 1;
    assert.ok(n >= 1 && n <= 255, `scratch root ${root} is too long for a ${len}-char cwd`);
    return join(root, 'b'.repeat(n));
  };
  const cwd200 = at(200);
  const cwd201 = at(201);
  assert.equal(cwd200.length, 200);
  assert.equal(cwd201.length, 201);
  const UUID = (n: string): string => `${n.repeat(8)}-1111-4111-8111-111111111111`;
  const atLimit = UUID('a');
  const overLimit = UUID('b');
  try {
    await mkdir(cwd200);
    await mkdir(cwd201);
    u.store.load();
    for (const [key, cwd] of [
      [atLimit, cwd200],
      [overLimit, cwd201],
    ] as const) {
      const info = infoOf({ id: `s-${key}`, cwd });
      u.store.recordCreate(info, { id: key, conversation: true, baseArgs: [] });
      u.store.markEnded(info.id, 'exit', 0);
    }
    // Both per-cwd directories exist and NEITHER holds a transcript: the only
    // thing separating the two entries is the length of the encoded name.
    await mkdir(join(config, 'projects', encodeCwd(cwd200)), { recursive: true });
    await mkdir(join(config, 'projects', encodeCwd(cwd201)), { recursive: true });

    const listed = await withClaudeConfig(config, () => u.store.list());
    assert.deepEqual(
      listed.map((e) => e.id),
      [overLimit],
      'a 200-char encoded cwd is judged (pruned); a 201-char one is kept',
    );
    const disk = JSON.parse(await readFile(u.file, 'utf8')) as HistoryEntry[];
    assert.deepEqual(disk.map((e) => e.id), [overLimit], 'and that verdict persists');
  } finally {
    await rm(u.root, { recursive: true, force: true });
  }
});

test('a history.json claiming a conversation under a NON-uuid id resumes with --continue: `--resume <not-a-uuid>` never reaches the child', async () => {
  // What an older/hand-edited file looks like. `--resume` needs a real uuid, so
  // honouring this claim would spawn a claude that errors out — and it would
  // let an id that is not a uuid reach a transcript path.
  const LEGACY_ID = 'legacy-entry/../../etc';
  const f = await fixture((workDir) => [
    {
      id: LEGACY_ID,
      conversation: true,
      sessionId: 'old-session',
      cwd: workDir,
      command: 'claude',
      args: ['--model', 'opus'],
      title: 'legacy',
      createdAt: '2026-09-05T09:00:00.000Z',
      lastUsedAt: '2026-09-05T09:00:00.000Z',
      ended: { at: '2026-09-05T10:00:00.000Z', reason: 'shutdown' },
    },
  ]);
  try {
    const listed = await history(f.server);
    assert.equal(listed.length, 1, 'the entry survives the boot — it is usable, only its claim is not');
    assert.equal(listed[0]?.id, LEGACY_ID);
    assert.equal(
      listed[0]?.conversation,
      false,
      'the conversation claim is coerced away at load: no --resume target exists',
    );

    const resumed = await api(
      f.server,
      'POST',
      `/api/history/${encodeURIComponent(LEGACY_ID)}/resume`,
      { cols: 80, rows: 24 },
    );
    assert.equal(resumed.status, 201, `resume: ${JSON.stringify(resumed.body)}`);
    const info = resumed.body as SessionInfo;
    assert.deepEqual(info.args, ['--model', 'opus', '--continue'], 'best effort, never --resume');

    const argv = await shimArgv(f.shimOut, 1);
    assert.ok(argv.includes('--continue'), `--continue must reach the child, got ${JSON.stringify(argv)}`);
    assert.ok(
      !argv.some((a) => a === '--resume' || a.startsWith('--resume=') || a === '-r'),
      `no resume flag may reach the child, got ${JSON.stringify(argv)}`,
    );
    assert.ok(
      !argv.some((a) => a.includes('legacy-entry')),
      `the non-uuid id must never reach the argv, got ${JSON.stringify(argv)}`,
    );

    const disk = await historyOnDisk(f.server);
    assert.equal(disk.length, 1, 'the resume updates the entry instead of forking a new one');
    assert.equal(disk[0]?.id, LEGACY_ID, 'the entry key is stable');
    assert.equal(disk[0]?.conversation, false, 'and it is still not a conversation');
    assert.equal(disk[0]?.sessionId, info.id, 'sessionId moves to the new launch');

    assert.equal((await api(f.server, 'DELETE', `/api/sessions/${info.id}`)).status, 200);
  } finally {
    await f.cleanup();
  }
});
