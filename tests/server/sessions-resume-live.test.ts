/**
 * POST /api/sessions refuses to resume a conversation that is still running
 * (Nocturne B5): the new-session dialog can launch `claude --resume <uuid>` for
 * a per-conversation entry, and two claude processes on one transcript corrupt
 * it. POST /api/history/:id/resume has always refused this case; the direct
 * spawn route must refuse it with the same 409.
 *
 * The real `claude` is never spawned — a double on PATH records its argv and
 * sleeps, like the one in tests/server/history.test.ts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionInfo } from '../../shared/protocol.ts';
import {
  api,
  createSession,
  startTestServer,
  waitUntil,
  type TestServer,
  makeTempDir,
  removeTempDir,
} from '../helpers/helpers.ts';

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

let root: string;
let shimOut: string;
let workDir: string;
let server: TestServer;

before(async () => {
  root = await realpath(await makeTempDir('ai-sm-livresume-'));
  const binDir = join(root, 'bin');
  shimOut = join(root, 'shim-out');
  workDir = join(root, 'work');
  await mkdir(binDir);
  await mkdir(shimOut);
  await mkdir(workDir);
  await writeFile(join(binDir, 'claude'), CLAUDE_DOUBLE, { mode: 0o755 });
  server = await startTestServer({
    env: {
      AI_SM_TEST_SHIM_OUT: shimOut,
      PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
      CLAUDE_CONFIG_DIR: join(root, 'claude-config'),
    },
  });
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (root !== undefined) await removeTempDir(root);
});

/** The argv of the n-th claude launch, one token per line. */
async function argv(n: number): Promise<string[]> {
  const raw = await waitUntil(
    async () => {
      try {
        return await readFile(join(shimOut, `argv-${n}`), 'utf8');
      } catch {
        return undefined;
      }
    },
    `claude launch #${n}`,
  );
  return raw.split('\n').filter((line) => line !== '');
}

/** How many launches the double has recorded so far. */
async function launches(): Promise<number> {
  return (await readdir(shimOut)).filter((name) => /^argv-\d+$/.test(name)).length;
}

test('a --resume / -r of a LIVE conversation is 409 and spawns nothing', async () => {
  const live = await createSession(server, {
    command: 'claude',
    args: [],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  const first = await argv(1);
  const idIndex = first.indexOf('--session-id');
  assert.notEqual(idIndex, -1, `the injected --session-id is missing from ${JSON.stringify(first)}`);
  const conversationId = first[idIndex + 1] as string;
  assert.match(conversationId, /^[0-9a-f-]{36}$/);
  assert.equal(await launches(), 1);

  for (const args of [
    ['--resume', conversationId],
    ['-r', conversationId],
    [`--resume=${conversationId}`],
    ['--model', 'sonnet', '--resume', conversationId],
  ]) {
    const res = await api(server, 'POST', '/api/sessions', {
      command: 'claude',
      args,
      cwd: workDir,
      cols: 80,
      rows: 24,
    });
    assert.equal(res.status, 409, `args ${JSON.stringify(args)}`);
    assert.deepEqual(res.body, { error: 'That conversation is already running.' });
  }
  assert.equal(await launches(), 1, 'a refused resume must not have spawned a pty');

  // A conversation this server never saw is not refused.
  const unknown = await api(server, 'POST', '/api/sessions', {
    command: 'claude',
    args: ['--resume', '11111111-2222-4333-8444-555555555555'],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  assert.equal(unknown.status, 201, JSON.stringify(unknown.body));
  await api(server, 'DELETE', `/api/sessions/${(unknown.body as SessionInfo).id}`);

  // Once the live session ends, the same request is allowed.
  assert.equal((await api(server, 'DELETE', `/api/sessions/${live.id}`)).status, 200);
  const again = await api(server, 'POST', '/api/sessions', {
    command: 'claude',
    args: ['--resume', conversationId],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  const info = again.body as SessionInfo;
  assert.deepEqual(info.args, ['--resume', conversationId], "the client's argv is stored verbatim");
  await api(server, 'DELETE', `/api/sessions/${info.id}`);
});

test('a non-claude command carrying the same --resume argv is never touched by the gate', async () => {
  const before = await launches();
  const live = await createSession(server, {
    command: 'claude',
    args: [],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  const recorded = await argv(before + 1);
  const conversationId = recorded[recorded.indexOf('--session-id') + 1] as string;
  assert.match(conversationId, /^[0-9a-f-]{36}$/);

  // Only claude-kind launches map onto conversations (server/conversation.ts).
  const shell = await api(server, 'POST', '/api/sessions', {
    command: 'bash',
    args: ['-c', 'printf done', '--resume', conversationId],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  assert.equal(shell.status, 201, JSON.stringify(shell.body));
  await api(server, 'DELETE', `/api/sessions/${(shell.body as SessionInfo).id}`);
  await api(server, 'DELETE', `/api/sessions/${live.id}`);
});
