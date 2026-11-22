/**
 * A clean stop waits for the pty-host's `shutdown-all` to leave the backend —
 * server/index.ts `shutdown()` over server/pty-host-broker.ts `flushed()`,
 * Nocturne D9 P3 (`.claude/plans/nocturne/PLAN-D9.md` § Defaults, decision
 * 25: a clean stop still ends the sessions; the P2 note: a frame still queued
 * in user space dies with the process).
 *
 * How: a real backend child (`startTestServer`, `ptyHost: 'socket'`) on a 0700
 * temp data dir and the real pty-host it starts. The pty-host is stopped
 * (SIGSTOP, by the pid in its state file) so it reads nothing; a megabyte of
 * input through the session's WebSocket then fills the socket's kernel buffers
 * and the rest waits in the backend. A `seen` sent after the input, and read
 * back as `attention: false` over REST, proves the backend has taken every
 * input frame before it is sent SIGTERM. The pty-host is let go (SIGCONT) only
 * once the backend has begun its shutdown — the `shutdown-all` frame is queued
 * behind the input by then.
 *
 * Why it matters: a backend that exits without waiting loses the frame; the
 * pty-host then sees its owner vanish without a word, as after a crash, and
 * keeps every PTY for the orphan grace (and the next boot adopts them) — a
 * stop that did not stop the sessions.
 *
 * NOT claimed: the bound of the wait (EXIT_FLUSH_MS, a pty-host that never
 * reads again), `flushed()` itself (`pty-host-broker.test.ts`), Windows.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionInfo } from '../../shared/protocol.ts';
import { api, createSession, startTestServer, waitForLog, waitUntil, wsUrl, WsClient } from '../helpers/helpers.ts';
import { hostLog, makeHostDir, teardownHosts, trackHost, trackPty } from '../helpers/pty-host-fixture.ts';
import { hostPidOf, pidAlive, shellPid } from '../helpers/pty-host-backend-fixture.ts';

after(async () => {
  await teardownHosts();
});

/** Input sent while the pty-host reads nothing: well past a Unix socket's kernel buffers (~200 KiB). */
const INPUT_CHUNKS = 16;
const INPUT_CHUNK = 'x'.repeat(64 * 1024);

test('a clean stop with the shutdown frame stuck behind a backed-up socket still ends the sessions and the pty-host', async () => {
  const dataDir = await makeHostDir('d9-stop-flush-');
  const server = await startTestServer({ dataDir, ptyHost: 'socket' });
  let hostPid = 0;
  try {
    // Raw and silent: the input is swallowed whole, nothing is echoed back.
    const { id } = await createSession(server, {
      cwd: '/tmp',
      command: 'bash',
      args: ['-c', `echo "pid $$"; stty raw -echo; printf 'ready\\a'; exec cat >/dev/null`],
      cols: 80,
      rows: 24,
    });
    const ws = await WsClient.connect(wsUrl(server, id));
    const pid = shellPid(await ws.waitForOutput('ready'));
    trackPty(pid);
    hostPid = hostPidOf(dataDir);
    trackHost(hostPid);
    const attention = async (): Promise<boolean | undefined> =>
      ((await api(server, 'GET', '/api/sessions')).body as SessionInfo[]).find((s) => s.id === id)?.attention;
    await waitUntil(async () => ((await attention()) === true ? true : undefined), 'the bell to raise attention');
    process.kill(hostPid, 'SIGSTOP');
    try {
      for (let i = 0; i < INPUT_CHUNKS; i += 1) ws.send({ type: 'input', data: INPUT_CHUNK });
      ws.send({ type: 'seen' });
      await waitUntil(async () => ((await attention()) === false ? true : undefined), 'the backend to take every input frame');
      server.child.kill('SIGTERM');
      // Either it is waiting for the frame now, or it has already left without it.
      await Promise.race([waitForLog(server, 'received SIGTERM, shutting down'), server.exit]);
    } finally {
      process.kill(hostPid, 'SIGCONT');
    }
    await server.exit;
    const verdict = await waitUntil(() => {
      const log = hostLog(dataDir);
      if (log.includes('shutting down (the owner asked)')) return 'shutdown-all';
      if (log.includes('owner connection lost without detach')) return 'lost without a word';
      return undefined;
    }, 'the pty-host to read the end of its owner');
    assert.equal(verdict, 'shutdown-all', `the frame reached the pty-host before the backend left:\n${hostLog(dataDir)}`);
    await waitUntil(() => (pidAlive(pid) ? undefined : true), 'the session to be ended');
    await waitUntil(() => (pidAlive(hostPid) ? undefined : true), 'the pty-host to exit');
  } finally {
    await server.stop();
  }
});
