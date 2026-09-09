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
 *  - planConversation/resumeSpawn: the pure argv table.
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
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { HistoryEntry, Project, SessionInfo } from '../shared/protocol.ts';
import { planConversation, resumeSpawn, stripConversationArgs } from '../server/conversation.ts';
import { HISTORY_MAX, SessionHistory } from '../server/history.ts';
import {
  api,
  createSession,
  startTestServer,
  waitUntil,
  type TestServer,
} from './helpers.ts';

/**
 * A `claude` test double resolved via PATH. Records the argv it was called with
 * as `$AI_SM_TEST_SHIM_OUT/argv-<n>` (n = 1, 2, ... in launch order) and then
 * sleeps, so the session stays 'running' until the test ends it. The launches
 * in this file are strictly sequential, so the numbering never races.
 */
const CLAUDE_DOUBLE = `#!/bin/sh
out="$AI_SM_TEST_SHIM_OUT"
i=1
while [ -e "$out/argv-$i" ]; do i=$((i+1)); done
: > "$out/argv-$i.part"
for a in "$@"; do printf '%s\\n' "$a" >> "$out/argv-$i.part"; done
mv "$out/argv-$i.part" "$out/argv-$i"
printf 'claude double ready\\n'
sleep 300
`;

interface Fixture {
  server: TestServer;
  root: string;
  workDir: string;
  shimOut: string;
  claudeConfigDir: string;
  cleanup: () => Promise<void>;
}

/**
 * A server whose PATH resolves `claude` to the double, with a scratch config
 * dir. `seedHistory` writes a history.json BEFORE the server boots, which is
 * the only way to exercise a file this version did not write itself (an older
 * or hand-edited one) through the real load -> list -> resume path.
 */
async function fixture(
  seedHistory?: (workDir: string) => readonly unknown[],
): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-history-')));
  const dataDir = join(root, 'data');
  const workDir = join(root, 'work');
  const shimDir = join(root, 'bin');
  const shimOut = join(root, 'shim-out');
  const claudeConfigDir = join(root, 'claude-config');
  await mkdir(workDir);
  await mkdir(shimDir);
  await mkdir(shimOut);
  await mkdir(claudeConfigDir);
  await writeFile(join(shimDir, 'claude'), CLAUDE_DOUBLE, { mode: 0o755 });
  if (seedHistory !== undefined) {
    await mkdir(dataDir, { mode: 0o700, recursive: true });
    await writeFile(
      join(dataDir, 'history.json'),
      JSON.stringify(seedHistory(workDir), null, 2) + '\n',
      { mode: 0o600 },
    );
  }

  const server = await startTestServer({
    dataDir,
    env: {
      AI_SM_TEST_SHIM_OUT: shimOut,
      // The double must WIN over any real claude, for this server process only.
      PATH: `${shimDir}:${process.env['PATH'] ?? ''}`,
      // Never touch the user's own ~/.claude from a test.
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    },
  });
  return {
    server,
    root,
    workDir,
    shimOut,
    claudeConfigDir,
    cleanup: async () => {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** The argv of the n-th `claude` launch, one token per line. */
async function shimArgv(shimOut: string, n: number): Promise<string[]> {
  const file = join(shimOut, `argv-${n}`);
  const raw = await waitUntil(
    async () => {
      try {
        return await readFile(file, 'utf8');
      } catch {
        return undefined;
      }
    },
    `the claude double's argv-${n} file`,
    10_000,
  );
  return raw.split('\n').filter((line) => line !== '');
}

async function history(server: TestServer): Promise<HistoryEntry[]> {
  const res = await api(server, 'GET', '/api/history');
  assert.equal(res.status, 200, `GET /api/history: ${JSON.stringify(res.body)}`);
  return res.body as HistoryEntry[];
}

async function historyOnDisk(server: TestServer): Promise<HistoryEntry[]> {
  return JSON.parse(await readFile(join(server.dataDir, 'history.json'), 'utf8')) as HistoryEntry[];
}

/** Claude Code's transcript directory name for a cwd (non-alphanumerics -> '-'). */
function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Run `fn` with CLAUDE_CONFIG_DIR pointed at `dir`, restoring the previous
 * value (or its absence) afterwards.
 *
 * MANDATORY around anything that can reach `pruneUnsaid` IN THIS PROCESS —
 * i.e. every direct `SessionHistory.list()` call below. `claudeConfigDir()`
 * falls back to `~/.claude`, so without this a unit test would stat the
 * developer's (and the user's) own Claude Code data directory. The server-
 * backed tests get the same guarantee from `fixture()`'s env instead.
 */
async function withClaudeConfig<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env['CLAUDE_CONFIG_DIR'];
  process.env['CLAUDE_CONFIG_DIR'] = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = prev;
  }
}

interface UnitStore {
  store: SessionHistory;
  /** The history.json this store owns. */
  file: string;
  /** Scratch root (also used as a CLAUDE_CONFIG_DIR with no `projects/`). */
  root: string;
  /** Every `<level> <message>` the store logged. */
  lines: string[];
}

/** A SessionHistory over a scratch file, with its log captured — no server. */
async function unitStore(name: string): Promise<UnitStore> {
  const root = await mkdtemp(join(tmpdir(), `ai-sm-history-${name}-`));
  const lines: string[] = [];
  const log = (level: string, msg: string): void => void lines.push(`${level} ${msg}`);
  const file = join(root, 'history.json');
  return { store: new SessionHistory(file, log as never), file, root, lines };
}

/** A SessionInfo for the unit-level store, with only the fields a test varies. */
function infoOf(over: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    title: over.id,
    command: 'claude',
    args: [],
    cwd: '/tmp/work',
    status: 'running',
    cols: 80,
    rows: 24,
    createdAt: '2026-09-06T10:00:00.000Z',
    attention: false,
    ...over,
  };
}

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
// (f) the HISTORY_MAX bound — the class directly, no server involved
// ---------------------------------------------------------------------------

function fakeInfo(n: number): SessionInfo {
  const id = `session-${String(n).padStart(4, '0')}`;
  return {
    id,
    title: `s${n}`,
    command: 'bash',
    args: [],
    cwd: '/tmp',
    status: 'running',
    cols: 80,
    rows: 24,
    // Strictly increasing, so "oldest lastUsedAt" is unambiguous.
    createdAt: new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString(),
    attention: false,
  };
}

test('history is bounded at HISTORY_MAX: the oldest ENDED entry drops, a live one never does', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-history-unit-'));
  const file = join(root, 'history.json');
  const lines: string[] = [];
  const log = (level: string, msg: string): void => void lines.push(`${level} ${msg}`);
  try {
    assert.equal(HISTORY_MAX, 200);
    const store = new SessionHistory(file, log as never);
    store.load();

    // 200 entries; the oldest (n=0) stays LIVE, everything else is ended.
    for (let n = 0; n < HISTORY_MAX; n += 1) {
      const info = fakeInfo(n);
      store.recordCreate(info, { id: info.id, conversation: false, baseArgs: [] });
      if (n > 0) store.markEnded(info.id, 'exit', 0);
    }
    // `list()` prunes first, and the prune resolves CLAUDE_CONFIG_DIR at call
    // time: pointed at `root` (which has no `projects/`) it prunes nothing and,
    // more importantly, never stats the real ~/.claude of whoever runs this.
    const listed = await withClaudeConfig(root, () => store.list());
    assert.equal(listed.length, HISTORY_MAX - 1, 'the live entry is not listed');

    // The 201st entry pushes the OLDEST ENDED one (n=1) out; n=0 is live.
    const extra = fakeInfo(HISTORY_MAX);
    store.recordCreate(extra, { id: extra.id, conversation: false, baseArgs: [] });
    const ids = JSON.parse(await readFile(file, 'utf8')) as HistoryEntry[];
    assert.equal(ids.length, HISTORY_MAX, 'the bound holds on disk');
    assert.ok(ids.some((e) => e.id === 'session-0000'), 'a LIVE entry is never dropped');
    assert.ok(!ids.some((e) => e.id === 'session-0001'), 'the oldest ENDED entry is the victim');
    assert.ok(ids.some((e) => e.id === 'session-0002'), 'the next-oldest survives');
    assert.ok(ids.some((e) => e.id === extra.id), 'the new entry is kept');

    // All-live: nothing may be dropped, even past the bound.
    const allLive = new SessionHistory(join(root, 'live.json'), log as never);
    allLive.load();
    for (let n = 0; n <= HISTORY_MAX; n += 1) {
      const info = fakeInfo(n);
      allLive.recordCreate(info, { id: info.id, conversation: false, baseArgs: [] });
    }
    const live = JSON.parse(await readFile(join(root, 'live.json'), 'utf8')) as HistoryEntry[];
    assert.equal(live.length, HISTORY_MAX + 1, 'live entries are never sacrificed to the bound');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (h) planConversation / resumeSpawn — the pure argv table
// ---------------------------------------------------------------------------

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CLIENT_UUID = '11111111-2222-3333-4444-555555555555';

test('planConversation: injects for a bare claude launch, adopts a client uuid, never fights a picker flag', () => {
  // Non-claude: never touched, never a conversation.
  const bash = planConversation('bash', ['-c', 'sleep 300'], SID);
  assert.deepEqual(bash, {
    id: SID,
    conversation: false,
    baseArgs: ['-c', 'sleep 300'],
    spawnArgs: ['-c', 'sleep 300'],
    injected: [],
  });
  // ...even when the argv happens to contain look-alike flags.
  assert.deepEqual(planConversation('/bin/sh', ['-c', 'x'], SID).spawnArgs, ['-c', 'x']);

  // Bare claude launch: inject.
  const bare = planConversation('claude', ['--model', 'opus'], SID);
  assert.deepEqual(bare, {
    id: SID,
    conversation: true,
    baseArgs: ['--model', 'opus'],
    spawnArgs: ['--model', 'opus', '--session-id', SID],
    injected: ['--session-id', SID],
  });
  // An absolute path to claude is still claude.
  assert.deepEqual(planConversation('/usr/bin/claude', [], SID).spawnArgs, ['--session-id', SID]);

  // --continue: no injection (the two flags must never be emitted together).
  const cont = planConversation('claude', ['--continue', '--model', 'opus'], SID);
  assert.equal(cont.conversation, false);
  assert.equal(cont.id, SID);
  assert.deepEqual(cont.spawnArgs, ['--continue', '--model', 'opus'], 'argv untouched');
  assert.deepEqual(cont.baseArgs, ['--model', 'opus'], '--continue is stripped from the base args');
  assert.deepEqual(planConversation('claude', ['-c'], SID).spawnArgs, ['-c']);

  // A client-supplied --session-id uuid IS the conversation; nothing injected.
  const adopted = planConversation('claude', ['--session-id', CLIENT_UUID, '--model', 'opus'], SID);
  assert.deepEqual(adopted, {
    id: CLIENT_UUID,
    conversation: true,
    baseArgs: ['--model', 'opus'],
    spawnArgs: ['--session-id', CLIENT_UUID, '--model', 'opus'],
    injected: [],
  });

  // So is a --resume / -r uuid.
  assert.equal(planConversation('claude', ['--resume', CLIENT_UUID], SID).id, CLIENT_UUID);
  assert.equal(planConversation('claude', ['--resume', CLIENT_UUID], SID).conversation, true);
  assert.equal(planConversation('claude', ['-r', CLIENT_UUID], SID).id, CLIENT_UUID);
  assert.equal(planConversation('claude', [`--resume=${CLIENT_UUID}`], SID).id, CLIENT_UUID);

  // Valueless --resume (the interactive picker) and a non-uuid value: we cannot
  // know which conversation it will be, so no injection and no conversation.
  for (const args of [['--resume'], ['-r'], ['--resume', 'yesterday'], ['--session-id', 'not-a-uuid']]) {
    const plan = planConversation('claude', args, SID);
    assert.equal(plan.conversation, false, `${JSON.stringify(args)} must not claim a conversation`);
    assert.equal(plan.id, SID);
    assert.deepEqual(plan.spawnArgs, args, `${JSON.stringify(args)} must be spawned verbatim`);
  }
  // A dangling --resume before another flag keeps that flag.
  assert.deepEqual(planConversation('claude', ['--resume', '--model', 'opus'], SID).baseArgs, [
    '--model',
    'opus',
  ]);
});

test('stripConversationArgs removes only the resume/session flags (and their values)', () => {
  assert.deepEqual(
    stripConversationArgs([
      '--model', 'opus',
      '--session-id', CLIENT_UUID,
      '--permission-mode', 'plan',
      '-r', 'abc',
      '--continue',
      '-c',
      '--effort', 'high',
      '--settings', '/tmp/x.json',
      '--weird-unknown',
    ]),
    [
      '--model', 'opus',
      '--permission-mode', 'plan',
      '--effort', 'high',
      '--settings', '/tmp/x.json',
      '--weird-unknown',
    ],
  );
  // A value is only eaten when it does not look like a flag.
  assert.deepEqual(stripConversationArgs(['-r', '--model', 'opus']), ['--model', 'opus']);
  assert.deepEqual(stripConversationArgs(['--session-id']), []);
  assert.deepEqual(stripConversationArgs([]), []);
});

test('resumeSpawn: --resume for a pinned conversation, --continue for claude without one, bare argv otherwise', () => {
  assert.deepEqual(
    resumeSpawn({ id: CLIENT_UUID, conversation: true, command: 'claude', args: ['--model', 'opus'] }),
    { command: 'claude', args: ['--model', 'opus', '--resume', CLIENT_UUID] },
  );
  assert.deepEqual(
    resumeSpawn({ id: 'app-session-id', conversation: false, command: 'claude', args: ['--model', 'opus'] }),
    { command: 'claude', args: ['--model', 'opus', '--continue'] },
  );
  assert.deepEqual(
    resumeSpawn({ id: 'app-session-id', conversation: false, command: 'bash', args: ['-c', 'sleep 1'] }),
    { command: 'bash', args: ['-c', 'sleep 1'] },
  );
});

test('planConversation: the --flag=value forms are recognised, uppercase uuids count, and a client picker flag is never fought', () => {
  // `--session-id=<uuid>`: adopted exactly like the space-separated form, and
  // nothing is injected on top of it.
  const eq = planConversation('claude', [`--session-id=${CLIENT_UUID}`, '--model', 'opus'], SID);
  assert.deepEqual(eq, {
    id: CLIENT_UUID,
    conversation: true,
    baseArgs: ['--model', 'opus'],
    spawnArgs: [`--session-id=${CLIENT_UUID}`, '--model', 'opus'],
    injected: [],
  });

  // A uuid is a uuid whatever its case (Claude Code accepts either).
  const upper = CLIENT_UUID.toUpperCase();
  assert.equal(planConversation('claude', [`--session-id=${upper}`], SID).id, upper);
  assert.equal(planConversation('claude', ['-r', upper], SID).conversation, true);

  // `=<not a uuid>` forms: we cannot pin them, so no injection, argv verbatim.
  for (const args of [
    ['--session-id=not-a-uuid'],
    ['--session-id='],
    ['--resume=yesterday'],
    ['--resume='],
    ['-r', 'yesterday'],
  ]) {
    const plan = planConversation('claude', args, SID);
    assert.equal(plan.conversation, false, `${JSON.stringify(args)} must not claim a conversation`);
    assert.equal(plan.id, SID);
    assert.deepEqual(plan.spawnArgs, args, `${JSON.stringify(args)} must be spawned verbatim`);
    assert.deepEqual(plan.injected, [], 'nothing may be reported as injected');
    assert.deepEqual(plan.baseArgs, [], 'the picker flag is stripped from the base args');
  }

  // `-c` with other flags: the base args keep everything else.
  assert.deepEqual(planConversation('claude', ['-c', '--model', 'opus'], SID).baseArgs, [
    '--model',
    'opus',
  ]);

  // A client that typed BOTH a picker and a session id is passed through as-is
  // (the id wins as the entry key); we never ADD a flag next to one of theirs.
  const both = planConversation('claude', ['--continue', '--session-id', CLIENT_UUID], SID);
  assert.equal(both.id, CLIENT_UUID);
  assert.equal(both.conversation, true);
  assert.deepEqual(both.spawnArgs, ['--continue', '--session-id', CLIENT_UUID], 'argv untouched');
  assert.deepEqual(both.baseArgs, [], 'a resume of it starts from the bare args');

  // The injection is exactly two tokens appended at the END, nothing reordered.
  const injected = planConversation('claude', ['--model', 'opus', '--effort', 'high'], SID);
  assert.deepEqual(injected.spawnArgs, [
    '--model',
    'opus',
    '--effort',
    'high',
    '--session-id',
    SID,
  ]);
  assert.equal(injected.spawnArgs.length, injected.baseArgs.length + 2);
  // `injected` names those tokens EXPLICITLY — the caller must not have to
  // diff spawnArgs against the client argv to find them.
  assert.deepEqual(injected.injected, ['--session-id', SID]);

  // Non-claude commands are untouched even when they carry the very flags this
  // module knows — `claude` must be the basename, not a substring.
  for (const command of ['bash', '/bin/sh', 'claude-code', 'myclaude', 'node']) {
    const plan = planConversation(command, ['--session-id', CLIENT_UUID, '--continue'], SID);
    assert.equal(plan.conversation, false, `${command} must never be treated as claude`);
    assert.equal(plan.id, SID);
    assert.deepEqual(plan.spawnArgs, ['--session-id', CLIENT_UUID, '--continue']);
    assert.deepEqual(plan.baseArgs, ['--session-id', CLIENT_UUID, '--continue'],
      'a non-claude command keeps its args verbatim, strip included');
  }
});

test('stripConversationArgs: the =value forms go too, a dangling flag eats nothing, and a flag-shaped value is kept', () => {
  assert.deepEqual(
    stripConversationArgs([
      `--session-id=${CLIENT_UUID}`,
      '--model',
      'opus',
      '--resume=yesterday',
      '--settings',
      '/tmp/x.json',
    ]),
    ['--model', 'opus', '--settings', '/tmp/x.json'],
  );
  // A dangling flag at the end: nothing left to eat.
  assert.deepEqual(stripConversationArgs(['--model', 'opus', '-r']), ['--model', 'opus']);
  assert.deepEqual(stripConversationArgs(['--model', 'opus', '--continue']), ['--model', 'opus']);
  // A `-`-leading token after the flag is NOT its value — it survives.
  assert.deepEqual(stripConversationArgs(['--session-id', '-x']), ['-x']);
  // `--session-idle` is not `--session-id`: only the exact flag and its
  // `=`-form are removed.
  assert.deepEqual(stripConversationArgs(['--session-idle', '5']), ['--session-idle', '5']);
  assert.deepEqual(stripConversationArgs(['--resumed', 'x']), ['--resumed', 'x']);
});

// ---------------------------------------------------------------------------
// (i) SessionHistory stamping / forgetting / boot repair — the class directly
// ---------------------------------------------------------------------------

test('markEnded: the FIRST stamp wins — a later exit never overwrites user-kill, and unknown ids are no-ops', async () => {
  const u = await unitStore('stamp');
  try {
    u.store.load();
    const info = infoOf({ id: 'sess-1', command: 'bash' });
    u.store.recordCreate(info, { id: 'entry-1', conversation: false, baseArgs: [] });

    u.store.markEnded('sess-1', 'user-kill');
    const first = u.store.get('entry-1') as HistoryEntry;
    assert.equal(first.ended?.reason, 'user-kill');
    assert.equal(first.exitCode, undefined, 'a kill records no exit code');
    const stampedAt = first.ended?.at as string;
    assert.equal(new Date(stampedAt).toISOString(), stampedAt, 'ended.at must be ISO-8601');

    // The async onExit that follows every kill must change NOTHING — neither
    // the reason, nor the timestamp, nor the exit code.
    u.store.markEnded('sess-1', 'exit', 0);
    const second = u.store.get('entry-1') as HistoryEntry;
    assert.equal(second.ended?.reason, 'user-kill', 'the exit stamp must be a no-op');
    assert.equal(second.ended?.at, stampedAt, 'the first stamp keeps its timestamp');
    assert.equal(second.exitCode, undefined, 'a no-op stamp must not smuggle in an exit code');

    // Shutdown-then-exit is the same story.
    u.store.recordCreate(infoOf({ id: 'sess-2', command: 'bash' }), {
      id: 'entry-2',
      conversation: false,
      baseArgs: [],
    });
    u.store.endAllLive('shutdown');
    u.store.markEnded('sess-2', 'exit', 137);
    const e2 = u.store.get('entry-2') as HistoryEntry;
    assert.equal(e2.ended?.reason, 'shutdown');
    assert.equal(e2.exitCode, undefined);

    // An unknown session id is a silent no-op, and endAllLive with nothing live
    // must not rewrite the file at all.
    const before = await readFile(u.file, 'utf8');
    u.store.markEnded('no-such-session', 'exit', 1);
    u.store.endAllLive('shutdown');
    assert.equal(await readFile(u.file, 'utf8'), before, 'a no-op must not touch history.json');

    // A natural exit DOES record its code (the positive control for the above).
    u.store.recordCreate(infoOf({ id: 'sess-3', command: 'bash' }), {
      id: 'entry-3',
      conversation: false,
      baseArgs: [],
    });
    u.store.markEnded('sess-3', 'exit', 5);
    assert.equal((u.store.get('entry-3') as HistoryEntry).exitCode, 5);

    // get()/list() hand out COPIES, `ended` included: a caller that mutates
    // what it got must not reach into the store's own entry.
    const copy = u.store.get('entry-3') as HistoryEntry;
    (copy.ended as { reason: string }).reason = 'tampered';
    assert.equal((u.store.get('entry-3') as HistoryEntry).ended?.reason, 'exit');
    const listed = await withClaudeConfig(u.root, () => u.store.list());
    const fromList = listed.find((e) => e.id === 'entry-3') as HistoryEntry;
    (fromList.ended as { reason: string }).reason = 'tampered';
    assert.equal((u.store.get('entry-3') as HistoryEntry).ended?.reason, 'exit');
  } finally {
    await rm(u.root, { recursive: true, force: true });
  }
});

test('forget: an ended entry goes and persists; a LIVE entry is refused; an unknown id is false', async () => {
  const u = await unitStore('forget');
  try {
    u.store.load();
    u.store.recordCreate(infoOf({ id: 'live-session', command: 'bash' }), {
      id: 'live',
      conversation: false,
      baseArgs: [],
    });
    u.store.recordCreate(infoOf({ id: 'dead-session', command: 'bash' }), {
      id: 'dead',
      conversation: false,
      baseArgs: [],
    });
    u.store.markEnded('dead-session', 'exit', 0);

    assert.equal(u.store.forget('live'), false, 'a running session is not forgettable');
    assert.notEqual(u.store.get('live'), undefined, 'the refused entry stays');
    assert.equal(u.store.forget('nope'), false, 'an unknown id is false, not a throw');
    assert.equal(u.store.forget('dead'), true);
    assert.equal(u.store.get('dead'), undefined);
    assert.equal(u.store.forget('dead'), false, 'forgetting twice is false the second time');

    const disk = JSON.parse(await readFile(u.file, 'utf8')) as HistoryEntry[];
    assert.deepEqual(disk.map((e) => e.id), ['live'], 'the removal must persist to history.json');

    // forgetAllEnded keeps the live one.
    u.store.recordCreate(infoOf({ id: 'dead-2-session', command: 'bash' }), {
      id: 'dead-2',
      conversation: false,
      baseArgs: [],
    });
    u.store.markEnded('dead-2-session', 'exit', 0);
    u.store.forgetAllEnded();
    const after = JSON.parse(await readFile(u.file, 'utf8')) as HistoryEntry[];
    assert.deepEqual(after.map((e) => e.id), ['live'], 'forget-all never drops a live entry');
  } finally {
    await rm(u.root, { recursive: true, force: true });
  }
});

test('load(): unusable records are skipped, thin ones get conservative defaults, and every ended:null entry is stamped crash', async () => {
  const u = await unitStore('load');
  try {
    // A real conversation key is UUID-shaped: `conversation: true` is only
    // honoured for one (it reaches `--resume <id>` and a transcript path).
    const COMPLETE_ID = '9f3c2d51-1111-4111-8111-1111111111aa';
    const complete: HistoryEntry = {
      id: COMPLETE_ID,
      conversation: true,
      sessionId: 'session-abc',
      projectId: 'p1',
      cwd: '/home/you/projects/web-ui',
      command: 'claude',
      args: ['--model', 'opus'],
      title: 'Web UI',
      createdAt: '2026-09-01T10:00:00.000Z',
      lastUsedAt: '2026-09-05T10:00:00.000Z',
      ended: { at: '2026-09-05T11:00:00.000Z', reason: 'exit' },
      exitCode: 3,
    };
    const raw = [
      complete,
      // Left live by a previous run -> 'crash' at boot.
      { ...complete, id: 'was-live', sessionId: 'session-live', ended: null, exitCode: undefined },
      // Unusable: each is missing or malforms a field a resume depends on.
      { conversation: true, command: 'bash', cwd: '/tmp', args: [] }, // no id
      { id: '', command: 'bash', cwd: '/tmp', args: [] }, // empty id
      { id: 'no-command', cwd: '/tmp', args: [] },
      { id: 'empty-command', command: '', cwd: '/tmp', args: [] },
      { id: 'no-cwd', command: 'bash', args: [] },
      { id: 'bad-args', command: 'bash', cwd: '/tmp', args: [1, 2] },
      { id: 'no-args', command: 'bash', cwd: '/tmp' },
      null,
      42,
      'a string',
      ['an array'],
      // Everything optional missing: the defaults must be conservative.
      { id: 'thin', command: '/usr/bin/claude', cwd: '/tmp/x', args: ['--model', 'opus'] },
      // A half-written `ended` is not an end at all -> crash-stamped.
      { id: 'bad-ended', command: 'bash', cwd: '/tmp', args: [], ended: { at: 123 } },
      // Hand-edited: claims a conversation under an id `--resume` could never
      // target. Usable, but the claim is coerced away.
      { id: 'not-a-uuid', conversation: true, command: 'claude', cwd: '/tmp', args: [] },
    ];
    await writeFile(u.file, JSON.stringify(raw, null, 2), { mode: 0o600 });

    u.store.load();

    assert.ok(
      u.lines.some((l) => l.includes('11 unusable entries ignored')),
      `the skipped records must be logged, got: ${u.lines.join(' | ')}`,
    );
    assert.ok(
      u.lines.some((l) => l === "info history loaded: 5 entries (4 stamped 'crash')"),
      `boot must log the load, got: ${u.lines.join(' | ')}`,
    );

    const disk = JSON.parse(await readFile(u.file, 'utf8')) as HistoryEntry[];
    assert.deepEqual(
      disk.map((e) => e.id),
      [COMPLETE_ID, 'was-live', 'thin', 'bad-ended', 'not-a-uuid'],
      'only the usable records survive, in file order',
    );

    // An intact entry survives byte for byte.
    assert.deepEqual(disk[0], complete);

    // The thin record's defaults.
    const thin = disk[2] as HistoryEntry;
    assert.equal(thin.conversation, false, 'conversation defaults to false — never claim a resume target');
    // The gate, not the default: `conversation: true` on a non-uuid id is a
    // claim we must not honour — resumeSpawn would emit `--resume not-a-uuid`.
    assert.equal(
      (disk[4] as HistoryEntry).conversation,
      false,
      'conversation is coerced to false unless the id is UUID-shaped',
    );
    assert.equal(disk[0]?.conversation, true, 'a UUID-keyed conversation is still honoured');
    assert.equal(thin.sessionId, 'thin', 'sessionId falls back to the entry id');
    assert.equal(thin.title, 'x', 'the title falls back to basename(cwd) — never the command word');
    assert.notEqual(thin.title, 'claude', 'a repaired record never names its command');
    assert.equal(thin.createdAt, new Date(0).toISOString());
    assert.equal(thin.lastUsedAt, thin.createdAt, 'lastUsedAt falls back to createdAt');
    assert.equal(thin.projectId, undefined);
    assert.equal(thin.exitCode, undefined);
    assert.deepEqual(thin.args, ['--model', 'opus'], 'the args a resume needs survive');

    // All three repairs carry the SAME boot timestamp and the crash reason.
    const crashed = [disk[1], disk[2], disk[3], disk[4]] as HistoryEntry[];
    for (const e of crashed) {
      assert.equal(e.ended?.reason, 'crash', `${e.id} must be stamped crash`);
      const at = e.ended?.at as string;
      assert.equal(new Date(at).toISOString(), at, 'ended.at must be ISO-8601');
    }
    assert.equal(crashed[0]?.ended?.at, crashed[1]?.ended?.at, 'one boot, one timestamp');
    assert.equal(crashed[1]?.ended?.at, crashed[2]?.ended?.at);

    // A second load is idempotent: nothing is live any more, so nothing is
    // re-stamped and the reasons stay what they were.
    const store2 = new SessionHistory(u.file, ((): void => {}) as never);
    store2.load();
    const disk2 = JSON.parse(await readFile(u.file, 'utf8')) as HistoryEntry[];
    assert.deepEqual(disk2, disk, 'a second boot must not change a repaired file');
  } finally {
    await rm(u.root, { recursive: true, force: true });
  }
});

test('pruneUnsaid drops ONLY a uuid-keyed claude conversation with no transcript — every uncertainty keeps the entry', async () => {
  const u = await unitStore('prune');
  const config = join(u.root, 'claude-config');
  // REAL directories: the prune canonicalizes the cwd with realpath, because
  // Claude Code names the transcript directory from the CHILD's process.cwd()
  // — the physical, normalized path, not the string we stored.
  const root = await realpath(u.root);
  const cwd = join(root, 'work');
  const linkedCwd = join(root, 'linked-work'); // symlink -> cwd
  const trailingCwd = `${cwd}/`; // same folder, different string
  const longCwd = join(root, 'a'.repeat(210));
  await mkdir(cwd);
  await mkdir(longCwd);
  await symlink(cwd, linkedCwd);
  const UUID = (n: string): string => `${n.repeat(8)}-1111-4111-8111-111111111111`;
  const withTranscript = UUID('1');
  const noTranscript = UUID('2');
  const notClaude = UUID('3');
  const stillLive = UUID('4');
  const notAConversation = UUID('5');
  const longPath = UUID('6');
  const viaSymlink = UUID('7');
  const viaTrailingSlash = UUID('8');
  try {
    u.store.load();
    const add = (
      key: string,
      over: Partial<SessionInfo>,
      opts: { conversation?: boolean; live?: boolean } = {},
    ): void => {
      const info = infoOf({ id: `s-${key}`, cwd, ...over });
      u.store.recordCreate(info, {
        id: key,
        conversation: opts.conversation ?? true,
        baseArgs: [],
      });
      if (opts.live !== true) u.store.markEnded(info.id, 'exit', 0);
    };
    add(withTranscript, {});
    add(noTranscript, {});
    add(notClaude, { command: 'bash' });
    add(stillLive, {}, { live: true });
    add(notAConversation, {}, { conversation: false });
    add(longPath, { cwd: longCwd });
    add('not-a-uuid-key', {});
    add(viaSymlink, { cwd: linkedCwd });
    add(viaTrailingSlash, { cwd: trailingCwd });

    // (1) No `projects/` directory at all: Claude's home was not found, so
    // NOTHING may be pruned — not even the entry that has no transcript.
    await withClaudeConfig(config, () => u.store.pruneUnsaid());
    assert.equal(
      (JSON.parse(await readFile(u.file, 'utf8')) as HistoryEntry[]).length,
      9,
      'without a projects/ directory the prune must be a no-op',
    );

    // (1b) `projects/` exists but holds NO per-cwd directory — what a change to
    // Claude Code's per-cwd naming scheme would look like from here. Our
    // encoding is then unproven, so the answer is UNKNOWN and NOTHING is
    // pruned: a whole history must never be wiped from inside a GET.
    await mkdir(join(config, 'projects'), { recursive: true });
    await withClaudeConfig(config, () => u.store.pruneUnsaid());
    assert.equal(
      (JSON.parse(await readFile(u.file, 'utf8')) as HistoryEntry[]).length,
      9,
      'an empty projects/ (no per-cwd directory) must prune nothing',
    );

    // (2) The per-cwd directory exists, holding a transcript for the entries
    // that said something. The symlinked cwd ALSO gets an (empty) directory
    // under its own un-canonicalized encoding: the prune must never look there,
    // or the symlinked entry would read as transcript-less and be destroyed.
    const realDir = join(config, 'projects', encodeCwd(cwd));
    await mkdir(realDir, { recursive: true });
    await mkdir(join(config, 'projects', encodeCwd(linkedCwd)), { recursive: true });
    for (const id of [withTranscript, viaSymlink, viaTrailingSlash]) {
      await writeFile(join(realDir, `${id}.jsonl`), '{}\n');
    }

    const listed = await withClaudeConfig(config, () => u.store.list());
    assert.deepEqual(
      listed.map((e) => e.id).sort(),
      [
        notAConversation,
        notClaude,
        withTranscript,
        longPath,
        viaSymlink,
        viaTrailingSlash,
        'not-a-uuid-key',
      ].sort(),
      'only the transcript-less claude conversation may be dropped',
    );
    assert.ok(
      listed.some((e) => e.id === viaSymlink),
      'a symlinked cwd resolves to the transcript under its realpath — never pruned',
    );
    assert.ok(
      listed.some((e) => e.id === viaTrailingSlash),
      'a trailing-slash cwd normalizes to the same folder — never pruned',
    );
    assert.ok(
      listed.every((e) => e.id !== stillLive),
      'a live entry is never listed (and was never a prune candidate)',
    );
    assert.notEqual(u.store.get(stillLive), undefined, 'the live entry is still in the store');

    const disk = JSON.parse(await readFile(u.file, 'utf8')) as HistoryEntry[];
    assert.ok(!disk.some((e) => e.id === noTranscript), 'the prune must persist');
    assert.equal(disk.length, 8);
    assert.ok(
      u.lines.some((l) => l === 'info history pruned: 1 claude conversation(s) with no transcript'),
      `the prune must be logged, got: ${u.lines.join(' | ')}`,
    );

    // (3) Idempotent: a second prune has nothing left to drop and reports
    // nothing. DEBUG lines are excluded: since the comprehensive-logging pass
    // (2026-09-06) every prune call writes a `prune checked N candidate(s),
    // pruned M` summary at debug, plus one debug line per PRUNE verdict (a KEPT
    // entry gets none). What must stay silent is the info/warn/error channel:
    // no summary line when there was no victim.
    const reportable = (): string[] => u.lines.filter((l) => !l.startsWith('debug '));
    const linesBefore = reportable().length;
    await withClaudeConfig(config, () => u.store.pruneUnsaid());
    assert.equal(reportable().length, linesBefore, 'a prune with no victims must be silent');
    assert.equal((JSON.parse(await readFile(u.file, 'utf8')) as HistoryEntry[]).length, 8);

    // (4) A cwd that no longer exists cannot be canonicalized -> UNKNOWN -> the
    // entry stays, transcript or not.
    await rm(cwd, { recursive: true, force: true });
    await withClaudeConfig(config, () => u.store.pruneUnsaid());
    assert.equal(
      (JSON.parse(await readFile(u.file, 'utf8')) as HistoryEntry[]).length,
      8,
      'an unresolvable cwd keeps its entry',
    );
  } finally {
    await rm(u.root, { recursive: true, force: true });
  }
});

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
