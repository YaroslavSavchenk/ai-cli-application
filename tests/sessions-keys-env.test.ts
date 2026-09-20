/**
 * A saved API key reaches the CHILD ENVIRONMENT of that tool's session — and
 * nothing else's (Nocturne B5).
 *
 * Proven through a REAL PTY: fake `gemini` and `claude` executables on the test
 * server's PATH print the variable they were given, and the test reads it back
 * over the session WebSocket. The injection is keyed on `basename(command)`, so
 * the same launch through `bash` must see nothing.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  api,
  createSession,
  readServerLog,
  startTestServer,
  wsUrl,
  WsClient,
  type TestServer,
} from './helpers.ts';

const SAVED_GEMINI = 'AIza-saved-0PENSESAME-11';
const SAVED_CLAUDE = 'sk-ant-saved-0PENSESAME-22';
const INHERITED_GEMINI = 'AIza-inherited-from-the-shell-33';

/** Prints the variable and exits; the scrollback keeps the line for attach. */
const printer = (variable: string): string => `#!/bin/sh
printf '%s\\n' "K=$${variable}"
`;

/** Prints every argv token (`A:<token>`) BEFORE the variable line. */
const argvPrinter = (variable: string): string => `#!/bin/sh
for a in "$@"; do printf 'A:%s\\n' "$a"; done
printf '%s\\n' "K=$${variable}"
`;

let root: string;
let binDir: string;
let workDir: string;
/** No key variables in its own environment. */
let plain: TestServer;
/** GEMINI_API_KEY set OUTSIDE the app, as a user's shell would. */
let inherited: TestServer;

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-keysenv-')));
  binDir = join(root, 'bin');
  workDir = join(root, 'work');
  await mkdir(binDir);
  await mkdir(workDir);
  await writeFile(join(binDir, 'gemini'), printer('GEMINI_API_KEY'), { mode: 0o755 });
  // grok's double also echoes its argv: the key must reach the ENVIRONMENT and
  // nothing else — an argv is world-readable in `ps` for every process of this user.
  await writeFile(join(binDir, 'grok'), argvPrinter('XAI_API_KEY'), { mode: 0o755 });
  // The claude double also receives the `--settings` / `--session-id`
  // injections; this test asserts the ENV line only.
  await writeFile(join(binDir, 'claude'), printer('ANTHROPIC_API_KEY'), { mode: 0o755 });
  const path = `${binDir}:${process.env['PATH'] ?? ''}`;
  plain = await startTestServer({
    env: { PATH: path, ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', XAI_API_KEY: '' },
  });
  inherited = await startTestServer({
    env: { PATH: path, ANTHROPIC_API_KEY: '', GEMINI_API_KEY: INHERITED_GEMINI, XAI_API_KEY: '' },
  });
});

after(async () => {
  if (plain !== undefined) await plain.stop();
  if (inherited !== undefined) await inherited.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

/** Spawn `command` in the fixture dir and return everything it printed. */
async function spawnAndRead(
  server: TestServer,
  command: string,
  args: string[] = [],
): Promise<string> {
  const info = await createSession(server, { command, args, cwd: workDir, cols: 80, rows: 24 });
  const client = await WsClient.connect(wsUrl(server, info.id));
  try {
    return await client.waitForOutput('K=');
  } finally {
    await client.close();
    await api(server, 'DELETE', `/api/sessions/${info.id}`);
  }
}

/** The `K=<value>` line the fake tool printed, without the trailing CR/LF. */
function keyLine(output: string): string {
  const line = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('K='));
  assert.ok(line !== undefined, `no K= line in ${JSON.stringify(output)}`);
  return line;
}

test('with no key saved, a gemini session sees no variable at all', async () => {
  assert.equal(keyLine(await spawnAndRead(plain, 'gemini')), 'K=');
});

test('a saved key reaches the gemini PTY, and only the tool it belongs to', async () => {
  assert.equal((await api(plain, 'PUT', '/api/keys/gemini', { key: SAVED_GEMINI })).status, 200);
  assert.equal(keyLine(await spawnAndRead(plain, 'gemini')), `K=${SAVED_GEMINI}`);

  // Same variable name, different command: `bash` is not a keyed tool, so the
  // environment is untouched.
  const viaBash = await spawnAndRead(plain, 'bash', ['-c', 'printf "%s\\n" "K=$GEMINI_API_KEY"']);
  assert.equal(keyLine(viaBash), 'K=', 'only the tool the key belongs to gets it');

  // And a different keyed tool does not get gemini's key either.
  assert.equal(keyLine(await spawnAndRead(plain, 'grok')), 'K=');
});

test('a claude session gets ANTHROPIC_API_KEY alongside the settings/session-id injection', async () => {
  assert.equal((await api(plain, 'PUT', '/api/keys/claude', { key: SAVED_CLAUDE })).status, 200);
  const info = await createSession(plain, {
    command: 'claude',
    args: [],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  // The client's argv stays the client's argv, whatever was injected.
  assert.deepEqual(info.args, []);
  const client = await WsClient.connect(wsUrl(plain, info.id));
  try {
    assert.equal(keyLine(await client.waitForOutput('K=')), `K=${SAVED_CLAUDE}`);
  } finally {
    await client.close();
    await api(plain, 'DELETE', `/api/sessions/${info.id}`);
  }
});

test('the key goes into the environment ONLY: not into the PTY argv, not into server.log', async () => {
  const GROK_KEY = 'xai-argv-0PENSESAME-77';
  assert.equal((await api(plain, 'PUT', '/api/keys/grok', { key: GROK_KEY })).status, 200);
  const info = await createSession(plain, {
    command: 'grok',
    args: ['--foo', 'bar'],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  const client = await WsClient.connect(wsUrl(plain, info.id));
  let output: string;
  try {
    output = await client.waitForOutput('K=');
  } finally {
    await client.close();
    await api(plain, 'DELETE', `/api/sessions/${info.id}`);
  }
  assert.equal(keyLine(output), `K=${GROK_KEY}`, 'the environment really carries it');
  const argv = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('A:'))
    .map((l) => l.slice(2));
  assert.deepEqual(argv, ['--foo', 'bar'], 'the PTY argv is exactly the client argv');
  assert.deepEqual(info.args, ['--foo', 'bar']);
  assert.equal(output.includes(GROK_KEY), true);
  for (const token of argv) assert.equal(token.includes('xai-'), false);

  const log = await readServerLog(plain);
  assert.equal(log.includes(GROK_KEY), false, 'the spawn line logs the argv — the key is not in it');
  assert.equal(log.includes(GROK_KEY.slice(0, 12)), false, 'not even a fragment');
  assert.ok(log.includes(`session ${info.id} spawned:`), 'the spawn line is there to be searched');
  assert.equal((await api(plain, 'DELETE', '/api/keys/grok')).status, 200);
});

test('a keyed tool launched by ABSOLUTE PATH still gets its variable (basename rule)', async () => {
  // The custom-command escape hatch (`/home/you/bin/gemini`) must behave like
  // the card: every injection in create() is keyed on basename(command).
  assert.equal((await api(plain, 'PUT', '/api/keys/gemini', { key: SAVED_GEMINI })).status, 200);
  assert.equal(
    keyLine(await spawnAndRead(plain, join(binDir, 'gemini'))),
    `K=${SAVED_GEMINI}`,
    'a full path to the same executable is the same tool',
  );
});

test('DELETE /api/keys/:tool stops the injection', async () => {
  assert.equal((await api(plain, 'DELETE', '/api/keys/gemini')).status, 200);
  assert.equal(keyLine(await spawnAndRead(plain, 'gemini')), 'K=');
});

test('a saved key overrides one inherited from the backend environment; without one the inherited value stays', async () => {
  assert.equal(keyLine(await spawnAndRead(inherited, 'gemini')), `K=${INHERITED_GEMINI}`);

  assert.equal(
    (await api(inherited, 'PUT', '/api/keys/gemini', { key: SAVED_GEMINI })).status,
    200,
  );
  assert.equal(
    keyLine(await spawnAndRead(inherited, 'gemini')),
    `K=${SAVED_GEMINI}`,
    'saving a key is the later, explicit act — it wins',
  );

  assert.equal((await api(inherited, 'DELETE', '/api/keys/gemini')).status, 200);
  assert.equal(
    keyLine(await spawnAndRead(inherited, 'gemini')),
    `K=${INHERITED_GEMINI}`,
    'forgetting the saved key restores the inherited environment, it does not clear it',
  );
});
