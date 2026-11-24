/**
 * The OOM order inside WSL — PLAN-QUALITY Q16 (`.claude/plans/PLAN-QUALITY.md`
 * § Parts, Q16): every PTY child's `oom_score_adj` is raised to 500 right
 * after its spawn (server/pty-table.ts `raiseOomScore`), in the pty-host and
 * in the in-process fallback; the backend and the pty-host keep the value
 * they started with.
 *
 * How: two real backends (`startTestServer`), one over a real pty-host
 * (`ptyHost: 'socket'`) and one with in-process PTYs; a bash session prints
 * its `$$` and the test reads `/proc/<pid>/oom_score_adj` of the session, the
 * backend and the pty-host.
 *
 * Why it matters: 2026-11-24 WSL ran out of memory and the kernel's choice
 * took the backend and the pty-host down with every session. A session the
 * killer takes can be resumed; the app that would resume it cannot.
 *
 * A refused write (spied `fs.writeFileSync`, the one failure this machine
 * cannot produce on demand) is one `warn` line and the spawn goes on.
 *
 * NOT claimed: a real OOM kill (the order is the kernel's); a child the CLI
 * forks in the instant between its exec and the write keeps 0.
 */
import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createInProcessPtyHost } from '../../server/pty-host-api.ts';
import type { PtyExitRecord } from '../../server/pty-table.ts';
import { startTestServer, waitUntil, wsUrl, WsClient, createSession, type TestServer } from '../helpers/helpers.ts';
import { makeHostDir, teardownHosts, trackPty } from '../helpers/pty-host-fixture.ts';
import { hostPidOf, shellPid } from '../helpers/pty-host-backend-fixture.ts';

const servers: TestServer[] = [];
after(async () => {
  for (const s of servers) await s.stop();
  await teardownHosts();
});

/** What a process started with: the backend and the pty-host inherit this test's own value. */
const INHERITED = readFileSync('/proc/self/oom_score_adj', 'utf8').trim();

function scoreOf(pid: number): string {
  return readFileSync(`/proc/${pid}/oom_score_adj`, 'utf8').trim();
}

/** A bash session on `server` and the pid of its shell. */
async function sessionPid(server: TestServer): Promise<number> {
  const info = await createSession(server, {
    command: 'bash', args: ['-c', 'echo "pid $$"; sleep 300'], cwd: '/tmp', cols: 80, rows: 24,
  });
  const ws = await WsClient.connect(wsUrl(server, info.id));
  try {
    const pid = shellPid(await ws.waitForOutput('pid '));
    trackPty(pid);
    return pid;
  } finally {
    await ws.close();
  }
}

test('over a pty-host: the session reads 500, the pty-host and the backend keep their own value', async () => {
  const server = await startTestServer({ dataDir: await makeHostDir('q16-socket-'), ptyHost: 'socket' });
  servers.push(server);
  const pid = await sessionPid(server);
  assert.equal(scoreOf(pid), '500', 'the session is the OOM killer\'s first choice');
  assert.equal(scoreOf(hostPidOf(server.dataDir)), INHERITED, 'the pty-host is not raised');
  assert.equal(scoreOf(server.child.pid as number), INHERITED, 'the backend is not raised');
});

test('in-process PTYs (the fallback): the session reads 500, the backend keeps its own value', async () => {
  const server = await startTestServer({ ptyHost: 'inproc' });
  servers.push(server);
  const pid = await sessionPid(server);
  assert.equal(scoreOf(pid), '500');
  assert.equal(scoreOf(server.child.pid as number), INHERITED);
});

test('a refused oom_score_adj write is one warn line, and the session still spawns and runs', async () => {
  const lines: string[] = [];
  const host = createInProcessPtyHost((level, message) => void lines.push(`${level} ${message}`));
  const exits = new Map<string, PtyExitRecord>();
  host.listen({ output: () => {}, exit: (id, record) => exits.set(id, record) });
  const real = fs.writeFileSync;
  // syncBuiltinESMExports pushes the spy into server/pty-table.ts's named import.
  const spy = mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    if (String(args[0]).endsWith('/oom_score_adj')) throw Object.assign(new Error('refused'), { code: 'EACCES' });
    return real(...args);
  });
  syncBuiltinESMExports();
  const id = `q16-refused-${process.pid}`;
  try {
    const { pid } = await host.spawn({
      id, file: 'bash', argv: ['-c', 'exit 7'], cwd: '/tmp',
      env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
      cols: 80, rows: 24,
    });
    assert.ok(pid > 1, 'the spawn went on');
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal((await waitUntil(() => exits.get(id), 'the session to exit')).code, 7, 'and ran to its own end');
  assert.deepEqual(lines.filter((l) => l.includes('oom_score_adj')), [`warn [session] ${id}: oom_score_adj not raised (EACCES)`]);
});
