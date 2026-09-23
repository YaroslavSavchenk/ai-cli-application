/**
 * Command Prompt: the server-injected working-directory tail (Nocturne B5).
 *
 * `cmd.exe` refuses a UNC working directory, so a `cmd.exe` launch with NO
 * client arguments is spawned as `cmd.exe /k pushd <windows path of cwd>`. The
 * tail is PTY argv only: SessionInfo.args and the history entry keep the
 * client's `[]`, and a resume composes it again.
 *
 * A fake `cmd.exe` on the test server's PATH echoes its argv back through the
 * PTY — no Windows interop is needed (and none exists on CI).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HistoryEntry, SessionInfo } from '../../shared/protocol.ts';
import {
  api,
  createSession,
  readServerLog,
  startTestServer,
  waitForLog,
  wsUrl,
  WsClient,
  type TestServer,
} from '../helpers/helpers.ts';

const DISTRO = 'Ubuntu-24.04';

/** Echoes the argv it was launched with, one token per line, then exits. */
const CMD_DOUBLE = `#!/bin/sh
for a in "$@"; do printf 'A:%s\\n' "$a"; done
printf 'DONE\\n'
`;

let root: string;
let binDir: string;
let workDir: string;
let spacedDir: string;
/** WSL_DISTRO_NAME set, as inside a real WSL distro. */
let server: TestServer;
/** WSL_DISTRO_NAME empty — the shape the injection refuses. */
let noDistro: TestServer;

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-cmd-')));
  binDir = join(root, 'bin');
  workDir = join(root, 'work');
  spacedDir = join(root, 'with space');
  await mkdir(binDir);
  await mkdir(workDir);
  await mkdir(spacedDir);
  await writeFile(join(binDir, 'cmd.exe'), CMD_DOUBLE, { mode: 0o755 });
  // A second, NON-cmd double with the same behaviour: the tail belongs to
  // cmd.exe alone, not to "any launch that carries no arguments".
  await writeFile(join(binDir, 'zsh'), CMD_DOUBLE, { mode: 0o755 });
  const path = `${binDir}:${process.env['PATH'] ?? ''}`;
  server = await startTestServer({ env: { PATH: path, WSL_DISTRO_NAME: DISTRO } });
  noDistro = await startTestServer({ env: { PATH: path, WSL_DISTRO_NAME: '' } });
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (noDistro !== undefined) await noDistro.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

/** The argv the double reported, read off the session's own scrollback. */
async function argvOf(target: TestServer, info: SessionInfo): Promise<string[]> {
  const client = await WsClient.connect(wsUrl(target, info.id));
  try {
    const out = await client.waitForOutput('DONE');
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('A:'))
      .map((line) => line.slice(2));
  } finally {
    await client.close();
  }
}

/** The windows path the server should have composed for `cwd`. */
const uncPathFor = (cwd: string): string =>
  `\\\\wsl.localhost\\${DISTRO}${cwd.replace(/\//g, '\\')}`;

test('cmd.exe with no client args is spawned with /k pushd <windows path>; args stay []', async () => {
  const info = await createSession(server, {
    command: 'cmd.exe',
    args: [],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  assert.deepEqual(info.args, [], 'the injected tail must never enter SessionInfo.args');
  assert.deepEqual(await argvOf(server, info), ['/k', 'pushd', uncPathFor(workDir)]);

  const history = (await api(server, 'GET', '/api/history')).body as HistoryEntry[];
  const entry = history.find((e) => e.cwd === workDir && e.command === 'cmd.exe');
  assert.ok(entry !== undefined, 'the launch must be in the history');
  assert.deepEqual(entry.args, [], "history stores the client's argv, not the injected one");

  // A RESUME re-injects: the tail is composed from the cwd every time, so an
  // entry recorded on one boot still opens in the right folder on the next.
  const resumed = await api(server, 'POST', `/api/history/${entry.id}/resume`, {
    cols: 80,
    rows: 24,
  });
  assert.equal(resumed.status, 201, JSON.stringify(resumed.body));
  const resumedInfo = resumed.body as SessionInfo;
  assert.deepEqual(resumedInfo.args, []);
  assert.deepEqual(await argvOf(server, resumedInfo), ['/k', 'pushd', uncPathFor(workDir)]);
});

test('client args are never touched: cmd.exe /c dir gets no tail', async () => {
  const info = await createSession(server, {
    command: 'cmd.exe',
    args: ['/c', 'dir'],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  assert.deepEqual(await argvOf(server, info), ['/c', 'dir']);
  assert.deepEqual(info.args, ['/c', 'dir']);
});

test('cmd.exe launched by absolute path gets the same tail (basename rule)', async () => {
  const info = await createSession(server, {
    command: join(binDir, 'cmd.exe'),
    args: [],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  assert.deepEqual(await argvOf(server, info), ['/k', 'pushd', uncPathFor(workDir)]);
  assert.deepEqual(info.args, []);
});

test('only cmd.exe gets a tail: another shell with no arguments is spawned bare', async () => {
  const info = await createSession(server, {
    command: 'zsh',
    args: [],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  assert.deepEqual(await argvOf(server, info), [], 'no argument may be invented for a shell');
  assert.deepEqual(info.args, []);
});

test('a cwd cmd could reinterpret is refused, and the refusal is logged once', async () => {
  const before = (await readServerLog(server)).split('cmd.exe: working directory not passed').length;
  const info = await createSession(server, {
    command: 'cmd.exe',
    args: [],
    cwd: spacedDir,
    cols: 80,
    rows: 24,
  });
  assert.deepEqual(await argvOf(server, info), [], 'a refused shape spawns a plain cmd.exe');
  assert.deepEqual(info.args, []);
  const log = await waitForLog(server, 'cmd.exe: working directory not passed (path shape)');
  assert.equal(
    log.split('cmd.exe: working directory not passed').length,
    before + 1,
    'exactly one warn line per refused launch',
  );
  assert.equal(log.includes('with space'), true, 'the cwd is already in the spawn line, unquoted');
});

test('without WSL_DISTRO_NAME the session opens plain and says so in the log', async () => {
  const info = await createSession(noDistro, {
    command: 'cmd.exe',
    args: [],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  assert.deepEqual(await argvOf(noDistro, info), []);
  assert.deepEqual(info.args, []);
  await waitForLog(noDistro, 'cmd.exe: working directory not passed (no distro)');

  const history = (await api(noDistro, 'GET', '/api/history')).body as HistoryEntry[];
  const entry = history.find((e) => e.command === 'cmd.exe');
  assert.ok(entry !== undefined);
  assert.deepEqual(entry.args, []);
});
