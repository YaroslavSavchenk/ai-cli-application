/**
 * Per-session `--settings` injection: the mechanism that gives an app-launched
 * claude session Claude Code's own status line.
 *
 * Two layers, both real:
 *   - the pure argv helpers (mode parsing, an existing --settings, shell
 *     quoting) — the part that decides what goes into a SHELL string, so it is
 *     pinned against client-controlled bytes; and
 *   - the whole path through a running server: POST /api/sessions with a stub
 *     executable NAMED `claude`, then read the settings file off disk and the
 *     spawned argv out of the PTY's own output. Nothing is mocked; the argv the
 *     assertions see is the argv the process received.
 *
 * The invariants that matter beyond "it works":
 *   - SessionInfo.args NEVER contains the injected flag (a journal relaunch
 *     must re-inject a fresh file, not point at one wiped at boot).
 *   - a client's own --settings is never overridden.
 *   - non-claude commands are untouched — the launcher stays generic.
 *   - the file is gone when the session exits or is deleted, and the whole
 *     directory is wiped at boot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import {
  hasSettingsArg,
  parsePermissionMode,
  shellQuote,
  SessionSettingsStore,
  STATUSLINE_REFRESH_SECONDS,
} from '../server/session-settings.ts';
import type { SessionInfo } from '../shared/protocol.ts';
import {
  api,
  createSession,
  projectRoot,
  startTestServer,
  waitUntil,
  WsClient,
  wsUrl,
  type TestServer,
} from './helpers.ts';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('parsePermissionMode: absent -> default; the four known values pass; anything else is unknown', () => {
  assert.equal(parsePermissionMode([]), 'default');
  assert.equal(parsePermissionMode(['--model', 'opus']), 'default');
  assert.equal(parsePermissionMode(['--permission-mode', 'acceptEdits']), 'acceptEdits');
  assert.equal(parsePermissionMode(['--permission-mode', 'plan']), 'plan');
  assert.equal(parsePermissionMode(['--permission-mode', 'bypassPermissions']), 'bypassPermissions');
  assert.equal(parsePermissionMode(['--permission-mode=plan']), 'plan');
  // Claude Code 2.1.220 also accepts auto/manual/dontAsk — real modes we have
  // no honest label for, so they are 'unknown' (the item is then omitted)
  // rather than being drawn as "always ask".
  assert.equal(parsePermissionMode(['--permission-mode', 'dontAsk']), 'unknown');
  assert.equal(parsePermissionMode(['--permission-mode', '; rm -rf /']), 'unknown');
  assert.equal(parsePermissionMode(['--permission-mode']), 'unknown');
  // Last occurrence wins, matching the CLI parser.
  assert.equal(parsePermissionMode(['--permission-mode', 'plan', '--permission-mode', 'acceptEdits']), 'acceptEdits');
});

test('hasSettingsArg: both spellings of a client-supplied --settings are respected', () => {
  assert.equal(hasSettingsArg([]), false);
  assert.equal(hasSettingsArg(['--model', 'opus']), false);
  assert.equal(hasSettingsArg(['--settings', '/tmp/mine.json']), true);
  assert.equal(hasSettingsArg(['--settings={"a":1}']), true);
  assert.equal(hasSettingsArg(['--settingsx', 'no']), false);
});

test('shellQuote: safe paths pass through, hostile ones cannot escape the quotes', () => {
  assert.equal(shellQuote('/home/sava/.ai-session-manager/prefs.json'), '/home/sava/.ai-session-manager/prefs.json');
  assert.equal(shellQuote('acceptEdits'), 'acceptEdits');
  assert.equal(shellQuote('/data dir/prefs.json'), "'/data dir/prefs.json'");
  assert.equal(shellQuote('/a;rm -rf ~/b'), "'/a;rm -rf ~/b'");
  assert.equal(shellQuote("/it's/here"), "'/it'\\''s/here'");
  assert.equal(shellQuote('$(id)`id`'), "'$(id)`id`'");
  assert.equal(shellQuote(''), "''");
});

// ---------------------------------------------------------------------------
// The store itself — file modes, the shell string, the id guard
// ---------------------------------------------------------------------------

/** A store rooted at a fresh temp dir; `logs` records everything it says. */
async function makeStore(dirName = 'session-settings'): Promise<{
  root: string;
  dir: string;
  store: SessionSettingsStore;
  logs: string[];
}> {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-store-'));
  const dir = join(root, dirName);
  const logs: string[] = [];
  const store = new SessionSettingsStore(
    {
      dir,
      scriptPath: join(projectRoot, 'server', 'statusline.mjs'),
      prefsFile: join(root, 'prefs.json'),
      nodePath: process.execPath,
    },
    (level, message) => logs.push(`${level}: ${message}`),
  );
  return { root, dir, store, logs };
}

test('the settings file is 0600 inside a 0700 directory — nothing else on the machine may read or replace it', async () => {
  const s = await makeStore();
  try {
    s.store.resetDir();
    assert.equal((await stat(s.dir)).mode & 0o777, 0o700, 'directory user-only');
    const file = s.store.write('11111111-2222-3333-4444-555555555555', 'plan');
    assert.equal(file, s.store.fileFor('11111111-2222-3333-4444-555555555555'));
    assert.equal((await stat(file as string)).mode & 0o777, 0o600, 'file user-only');
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test('write() creates the directory when it is missing, and remove() is idempotent', async () => {
  const s = await makeStore();
  try {
    // No resetDir() first: a write must still land (mkdir recursive, 0700).
    const file = s.store.write('abc-123', 'default') as string;
    assert.equal((await stat(s.dir)).mode & 0o777, 0o700);
    JSON.parse(await readFile(file, 'utf8'));
    s.store.remove('abc-123');
    await assert.rejects(readFile(file, 'utf8'), /ENOENT/);
    s.store.remove('abc-123'); // second time: a missing file is not an error
    s.store.remove('never-existed');
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test('a data dir holding spaces and quotes is QUOTED into the shell command, never able to reshape it', async () => {
  // statusLine.command is run through a shell by Claude Code, so the only
  // defence for an awkward (or hostile) data-dir path is the quoting.
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-store-'));
  const awkward = join(root, "it's a dir; rm -rf $HOME");
  const logs: string[] = [];
  try {
    const store = new SessionSettingsStore(
      {
        dir: join(awkward, 'session-settings'),
        scriptPath: join(awkward, 'statusline.mjs'),
        prefsFile: join(awkward, 'prefs.json'),
        nodePath: process.execPath,
      },
      (level, message) => logs.push(`${level}: ${message}`),
    );
    // Whole paths are single-quoted (with the embedded quote escaped); the mode
    // and the node path need no quoting and stay bare.
    const q = (p: string): string => `'${p.replaceAll("'", "'\\''")}'`;
    const cmd = store.command('bypassPermissions');
    assert.equal(
      cmd,
      `${process.execPath} ${q(join(awkward, 'statusline.mjs'))} bypassPermissions ${q(join(awkward, 'prefs.json'))}`,
    );
    // Round-trip through a REAL shell: word-split the command line exactly as
    // the shell would before exec'ing it. Four words out — the hostile bytes
    // stay inside word 2 and 4 instead of becoming commands.
    const words = execFileSync('/bin/sh', ['-c', `for a in ${cmd}; do printf '[%s]\\n' "$a"; done`], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    assert.deepEqual(words, [
      `[${process.execPath}]`,
      `[${awkward}/statusline.mjs]`,
      '[bypassPermissions]',
      `[${awkward}/prefs.json]`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an id that is not a plain server-generated id is REFUSED, never turned into a path', async () => {
  const s = await makeStore();
  try {
    s.store.resetDir();
    for (const bad of ['../escape', 'a/b', '', '.', 'x'.repeat(65), 'has space', '-leading', 'nul\u0000byte']) {
      assert.equal(s.store.write(bad, 'default'), undefined, `id ${JSON.stringify(bad)} must be refused`);
    }
    assert.deepEqual(await readdir(s.dir), [], 'a refused id writes no file at all');
    assert.equal(s.logs.length, 8, 'every refusal is logged');
    assert.ok(s.logs.every((l) => l.startsWith('warn: refusing to write session settings')));
    // The shape a real session id has still passes.
    assert.notEqual(s.store.write('0f2a5c8e-1b3d-4f60-9a77-2c1e5b8d4a09', 'default'), undefined);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test('resetDir() wipes whatever is in the directory and recreates it 0700', async () => {
  const s = await makeStore();
  try {
    await mkdir(s.dir, { recursive: true });
    await writeFile(join(s.dir, 'left-over.json'), '{}');
    await mkdir(join(s.dir, 'nested'), { recursive: true });
    await writeFile(join(s.dir, 'nested', 'deep.json'), '{}');
    s.store.resetDir();
    assert.deepEqual(await readdir(s.dir), [], 'nothing survives, not even a subdirectory');
    assert.equal((await stat(s.dir)).mode & 0o777, 0o700);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Through a real server + a real PTY
// ---------------------------------------------------------------------------

/** A stub executable named `claude` that echoes its argv and then blocks. */
async function makeStubClaude(): Promise<{ dir: string; bin: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ai-sm-stubclaude-'));
  const bin = join(dir, 'claude');
  await writeFile(bin, '#!/bin/bash\necho "ARGV<$*>"\nexec sleep 300\n');
  await chmod(bin, 0o755);
  return { dir, bin };
}

/** The argv line the stub printed, read out of the session's own PTY output. */
async function spawnedArgv(server: TestServer, id: string): Promise<string> {
  const client = await WsClient.connect(wsUrl(server, id));
  try {
    const out = await client.waitForOutput('ARGV<');
    return /ARGV<([^>]*)>/.exec(out)?.[1] ?? '';
  } finally {
    await client.close();
  }
}

test('a claude session gets a per-session settings file, the exact statusLine JSON, and --settings in its REAL argv', async () => {
  const server = await startTestServer();
  const stub = await makeStubClaude();
  try {
    const session = await createSession(server, {
      command: stub.bin,
      args: ['--model', 'opus', '--permission-mode', 'acceptEdits'],
      cwd: projectRoot,
      cols: 80,
      rows: 24,
    });
    assert.equal(session.statusline, true, 'the session reports that a status line was injected');
    assert.deepEqual(
      session.args,
      ['--model', 'opus', '--permission-mode', 'acceptEdits'],
      'SessionInfo.args stays the CLIENT argv — the injected flag must not reach the journal',
    );

    const file = join(server.dataDir, 'session-settings', `${session.id}.json`);
    const written = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(written), ['statusLine'], 'the file carries NOTHING but statusLine');
    assert.deepEqual(written['statusLine'], {
      type: 'command',
      command: `${process.execPath} ${join(projectRoot, 'server', 'statusline.mjs')} acceptEdits ${join(server.dataDir, 'prefs.json')}`,
      refreshInterval: STATUSLINE_REFRESH_SECONDS,
    });

    const argv = await spawnedArgv(server, session.id);
    assert.equal(argv, `--model opus --permission-mode acceptEdits --settings ${file}`);

    // Same rule one layer down: the journal (and therefore any relaunch offer)
    // must not carry a path this run's boot wipe already deleted.
    const journal = JSON.parse(await readFile(join(server.dataDir, 'journal.json'), 'utf8')) as {
      id: string;
      args: string[];
    }[];
    assert.deepEqual(journal.find((e) => e.id === session.id)?.args, [
      '--model',
      'opus',
      '--permission-mode',
      'acceptEdits',
    ]);
  } finally {
    await rm(stub.dir, { recursive: true, force: true });
    await server.stop();
  }
});

test('no --permission-mode -> the settings command says `default`; an unknown one says `unknown`', async () => {
  const server = await startTestServer();
  const stub = await makeStubClaude();
  try {
    const script = join(projectRoot, 'server', 'statusline.mjs');
    const prefs = join(server.dataDir, 'prefs.json');
    const bare = await createSession(server, { command: stub.bin, args: [], cwd: projectRoot, cols: 80, rows: 24 });
    const bareFile = JSON.parse(
      await readFile(join(server.dataDir, 'session-settings', `${bare.id}.json`), 'utf8'),
    ) as { statusLine: { command: string } };
    assert.equal(bareFile.statusLine.command, `${process.execPath} ${script} default ${prefs}`);

    const odd = await createSession(server, {
      command: stub.bin,
      args: ['--permission-mode', 'dontAsk'],
      cwd: projectRoot,
      cols: 80,
      rows: 24,
    });
    const oddFile = JSON.parse(
      await readFile(join(server.dataDir, 'session-settings', `${odd.id}.json`), 'utf8'),
    ) as { statusLine: { command: string } };
    assert.equal(oddFile.statusLine.command, `${process.execPath} ${script} unknown ${prefs}`);
  } finally {
    await rm(stub.dir, { recursive: true, force: true });
    await server.stop();
  }
});

test('a client that brings its own --settings is left completely alone', async () => {
  const server = await startTestServer();
  const stub = await makeStubClaude();
  try {
    const session = await createSession(server, {
      command: stub.bin,
      args: ['--settings', '/tmp/mine.json'],
      cwd: projectRoot,
      cols: 80,
      rows: 24,
    });
    assert.equal(session.statusline, undefined, 'no injection claimed');
    const argv = await spawnedArgv(server, session.id);
    assert.equal(argv, '--settings /tmp/mine.json', 'argv untouched');
    const dir = await readdir(join(server.dataDir, 'session-settings'));
    assert.deepEqual(dir, [], 'no settings file written');
  } finally {
    await rm(stub.dir, { recursive: true, force: true });
    await server.stop();
  }
});

test('a non-claude command is never touched (the launcher stays generic)', async () => {
  const server = await startTestServer();
  try {
    const session = await createSession(server, {
      command: '/bin/bash',
      args: ['-lc', 'echo ARGV<none>; sleep 300'],
      cwd: projectRoot,
      cols: 80,
      rows: 24,
    });
    assert.equal(session.statusline, undefined);
    const dir = await readdir(join(server.dataDir, 'session-settings'));
    assert.deepEqual(dir, [], 'no settings file for a non-claude session');
  } finally {
    await server.stop();
  }
});

test('the settings file is removed when the session EXITS and when it is DELETED', async () => {
  const server = await startTestServer();
  const stub = await makeStubClaude();
  const shortLived = join(stub.dir, 'quick');
  try {
    // A `claude` that exits immediately: same basename rule, different lifetime.
    await mkdir(shortLived);
    const quickBin = join(shortLived, 'claude');
    await writeFile(quickBin, '#!/bin/bash\nexit 7\n');
    await chmod(quickBin, 0o755);

    const exiting = await createSession(server, { command: quickBin, args: [], cwd: projectRoot, cols: 80, rows: 24 });
    assert.equal(exiting.statusline, true);
    const exitingFile = join(server.dataDir, 'session-settings', `${exiting.id}.json`);
    await waitUntil(
      async () => ((await readdir(join(server.dataDir, 'session-settings'))).includes(`${exiting.id}.json`) ? undefined : true),
      'the settings file to disappear when the PTY exits',
    );
    await assert.rejects(readFile(exitingFile, 'utf8'), /ENOENT/);

    const killed = await createSession(server, { command: stub.bin, args: [], cwd: projectRoot, cols: 80, rows: 24 });
    const killedFile = join(server.dataDir, 'session-settings', `${killed.id}.json`);
    await readFile(killedFile, 'utf8'); // exists while running
    const del = await api(server, 'DELETE', `/api/sessions/${killed.id}`);
    assert.equal(del.status, 200);
    await assert.rejects(readFile(killedFile, 'utf8'), /ENOENT/);
  } finally {
    await rm(stub.dir, { recursive: true, force: true });
    await server.stop();
  }
});

test('boot wipes BOTH status-line leftovers: the session-settings directory (0700) and statusline-cache.json', async () => {
  // Neither can outlive a restart: no session survives one, so every settings
  // file names a dead session and every cache entry is keyed by a claude
  // session id that can never come back. The cache matters for a second reason
  // — it is a file any process running as this user can write, and the script
  // prints its contents into the terminal, so a leftover is a poisoned string
  // waiting for a session id collision.
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-settings-boot-'));
  const dataDir = join(root, 'data');
  const settingsDir = join(dataDir, 'session-settings');
  const cacheFile = join(dataDir, 'statusline-cache.json');
  try {
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, 'stale-from-last-run.json'), '{"statusLine":{}}');
    await writeFile(
      cacheFile,
      JSON.stringify({ 'sess-from-last-run': { at: Date.now(), branch: 'zombie', cwd: '/tmp' } }),
    );
    const server = await startTestServer({ dataDir });
    try {
      const entries = await readdir(settingsDir);
      assert.deepEqual(entries, [], 'the previous run left nothing behind');
      assert.equal((await stat(settingsDir)).mode & 0o777, 0o700, 'directory is user-only');
      await assert.rejects(readFile(cacheFile, 'utf8'), /ENOENT/, 'the branch cache is deleted at boot');
      assert.deepEqual(
        (await readdir(dataDir)).filter((f) => f.includes('statusline')),
        [],
        'and nothing cache-shaped is left in its place',
      );
    } finally {
      await server.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the `--settings=<value>` spelling suppresses injection too, through the whole server path', async () => {
  const server = await startTestServer();
  const stub = await makeStubClaude();
  try {
    const session = await createSession(server, {
      command: stub.bin,
      args: ['--settings={"statusLine":{"type":"command","command":"whoami"}}'],
      cwd: projectRoot,
      cols: 80,
      rows: 24,
    });
    assert.equal(session.statusline, undefined, 'no injection claimed');
    const argv = await spawnedArgv(server, session.id);
    assert.equal(argv, '--settings={"statusLine":{"type":"command","command":"whoami"}}');
    assert.deepEqual(await readdir(join(server.dataDir, 'session-settings')), [], 'no settings file written');
  } finally {
    await rm(stub.dir, { recursive: true, force: true });
    await server.stop();
  }
});

test('the file the SERVER writes is 0600 in a 0700 directory (not just the unit-level store)', async () => {
  const server = await startTestServer();
  const stub = await makeStubClaude();
  try {
    const session = await createSession(server, { command: stub.bin, args: [], cwd: projectRoot, cols: 80, rows: 24 });
    const dir = join(server.dataDir, 'session-settings');
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, `${session.id}.json`))).mode & 0o777, 0o600);
  } finally {
    await rm(stub.dir, { recursive: true, force: true });
    await server.stop();
  }
});

test('relaunching from the remembered argv re-injects a FRESH file (the point of keeping the flag out of args)', async () => {
  const server = await startTestServer();
  const stub = await makeStubClaude();
  try {
    const first = await createSession(server, {
      command: stub.bin,
      args: ['--permission-mode', 'plan'],
      cwd: projectRoot,
      cols: 80,
      rows: 24,
    });
    const firstFile = join(server.dataDir, 'session-settings', `${first.id}.json`);
    await readFile(firstFile, 'utf8');
    assert.equal((await api(server, 'DELETE', `/api/sessions/${first.id}`)).status, 200);
    await assert.rejects(readFile(firstFile, 'utf8'), /ENOENT/);

    // A relaunch offer replays command + the REMEMBERED args, nothing else.
    const again = await createSession(server, {
      command: stub.bin,
      args: first.args,
      cwd: projectRoot,
      cols: 80,
      rows: 24,
    });
    assert.notEqual(again.id, first.id);
    assert.equal(again.statusline, true, 'the relaunched session gets its own status line');
    const againFile = join(server.dataDir, 'session-settings', `${again.id}.json`);
    const body = JSON.parse(await readFile(againFile, 'utf8')) as { statusLine: { command: string } };
    assert.ok(body.statusLine.command.includes(' plan '), 'the permission mode survives the round trip');
    assert.equal((await spawnedArgv(server, again.id)).includes(firstFile), false, 'never points at the deleted file');
  } finally {
    await rm(stub.dir, { recursive: true, force: true });
    await server.stop();
  }
});

test('a settings-panel write reaches an ALREADY RUNNING session: the script re-reads prefs.json every run', async () => {
  // The whole live-update promise in one place: the server tells claude to run
  // `statusline.mjs … <dataDir>/prefs.json`, PUT /api/prefs rewrites that exact
  // file, and the next invocation draws the new answer with nothing restarted.
  const server = await startTestServer();
  const stub = await makeStubClaude();
  try {
    const session = await createSession(server, { command: stub.bin, args: [], cwd: projectRoot, cols: 80, rows: 24 });
    const written = JSON.parse(
      await readFile(join(server.dataDir, 'session-settings', `${session.id}.json`), 'utf8'),
    ) as { statusLine: { command: string } };
    const [nodePath, scriptPath, mode, prefsPath] = written.statusLine.command.split(' ');
    assert.equal(prefsPath, join(server.dataDir, 'prefs.json'));

    const payload = JSON.stringify({
      session_id: session.id,
      cwd: projectRoot,
      model: { id: 'claude-opus-5', display_name: 'Opus 5' },
      cost: { total_cost_usd: 1.5 },
      context_window: { used_percentage: 10 },
    });
    const run = (): string =>
      execFileSync(nodePath as string, [scriptPath as string, mode as string, prefsPath as string], {
        input: payload,
        encoding: 'utf8',
      }).replace(/\n$/, '');

    const only = { enabled: true, model: true, mode: false, branch: false, cost: false, lines: false, context: false, usage: false };
    assert.equal((await api(server, 'PUT', '/api/prefs', { statusLine: only })).status, 200);
    assert.equal(run(), 'Opus 5', 'the panel turned everything but the model off');

    assert.equal(
      (await api(server, 'PUT', '/api/prefs', { statusLine: { ...only, cost: true, context: true } })).status,
      200,
    );
    assert.equal(run(), 'Opus 5 | $1.50 | ctx 10%', 'two more items, no restart');

    assert.equal((await api(server, 'PUT', '/api/prefs', { statusLine: { ...only, enabled: false } })).status, 200);
    assert.equal(run(), '', 'the master switch blanks the bar of a running session');
  } finally {
    await rm(stub.dir, { recursive: true, force: true });
    await server.stop();
  }
});

test('the endpoints this phase retired are GONE — no handler answers /api/usage or /api/telemetry', async () => {
  // The per-pane strip and the usage ledger were removed with their features
  // (server/usage.ts, server/telemetry.ts). A 404 here is what proves the
  // routes went with them rather than lingering as dead, authed surface.
  const server = await startTestServer();
  try {
    for (const path of ['/api/usage', '/api/telemetry']) {
      for (const method of ['GET', 'POST']) {
        const res = await api(server, method, path);
        assert.equal(res.status, 404, `${method} ${path}`);
      }
    }
  } finally {
    await server.stop();
  }
});

test('GET /api/sessions keeps reporting `statusline` for a listed session', async () => {
  const server = await startTestServer();
  const stub = await makeStubClaude();
  try {
    const session = await createSession(server, { command: stub.bin, args: [], cwd: projectRoot, cols: 80, rows: 24 });
    const listed = ((await api(server, 'GET', '/api/sessions')).body as SessionInfo[]).find((s) => s.id === session.id);
    assert.equal(listed?.statusline, true);
  } finally {
    await rm(stub.dir, { recursive: true, force: true });
    await server.stop();
  }
});
