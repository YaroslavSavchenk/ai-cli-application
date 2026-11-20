/**
 * What `pty-host.log` may hold — Nocturne D9 P2
 * (`.claude/plans/nocturne/PLAN-D9.md` § Defaults: "Never logs bytes or
 * env"): lifecycle and counts, never a byte of output or input, an env value,
 * an argv entry or the token.
 *
 * How: a real pty-host child (`tests/helpers/pty-host-fixture.ts`) runs a
 * session whose env, argv, input and output each carry a sentinel, through
 * the backend's own client; the log is read after the host has shut down.
 *
 * Why it matters: the env of a CLI carries the user's API key, and what is
 * typed into a shell can be a password. 0600 does not keep the Windows user
 * out of the file (memory/knowledge/wsl-0600-not-a-boundary.md) — not writing
 * the secret is the protection.
 *
 * NOT claimed: server.log (`logging*.test.ts`).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectPtyHost } from '../../server/pty-host-client.ts';
import { waitUntil } from '../helpers/helpers.ts';
import { ENV, hostLog, startHost, teardownHosts, trackPty } from '../helpers/pty-host-fixture.ts';

after(async () => {
  await teardownHosts();
});

test('pty-host.log names the session and its counts, never its env, argv, input, output or the token', async () => {
  const h = await startHost();
  const owner = await connectPtyHost({ dataDir: h.dataDir, takeover: false });
  let text = '';
  let exited = false;
  owner.listen({
    output: (_id, data) => (text += data),
    exit: () => {
      exited = true;
    },
  });
  const id = randomUUID();
  const { pid } = await owner.spawn({
    id,
    file: 'bash',
    argv: ['--norc', '-i', '-c', 'echo SENTINEL-ARGV-7f3a >/dev/null; exec bash --norc -i'],
    cwd: '/',
    env: { ...ENV, ANTHROPIC_API_KEY: 'sk-SENTINEL-ENV-9c1d', PS1: '$ ' },
    cols: 80,
    rows: 24,
  });
  trackPty(pid);
  owner.write(id, 'echo SENTINEL-IN-2b8e; echo "SENTINEL-OUT-$((3*1000+5))"\r');
  await waitUntil(() => (text.includes('SENTINEL-OUT-3005') ? true : undefined), 'the output');
  owner.write(id, 'echo $ANTHROPIC_API_KEY\r');
  await waitUntil(() => (text.includes('sk-SENTINEL-ENV-9c1d') ? true : undefined), 'the env reached the pty');
  owner.write(id, 'exit\r');
  await waitUntil(() => (exited ? true : undefined), 'the session to end');
  owner.shutdownAll();
  assert.equal(await h.exited, 0);

  const log = hostLog(h.dataDir);
  assert.match(log, new RegExp(`${id} spawned pid ${pid} \\(80x24, 4 arg\\(s\\), \\d+ env var\\(s\\)\\)`));
  assert.match(log, new RegExp(`${id} exited \\(code \\d+, signal \\S+, \\d+ output bytes\\)`));
  for (const secret of ['SENTINEL-ARGV', 'SENTINEL-ENV', 'SENTINEL-IN', 'SENTINEL-OUT', h.file.token, 'bash']) {
    assert.ok(!log.includes(secret), `pty-host.log must not contain ${secret === h.file.token ? 'the token' : secret}`);
  }
});
