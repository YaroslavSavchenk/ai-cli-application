/**
 * SessionManager's injectable `PtyHost` — Nocturne D9 P2
 * (`.claude/plans/nocturne/PLAN-D9.md` § Risks, the P1 gate's C9): the
 * manager talks to whatever host it is given, and `destroy` hands the id
 * back to it with `forget`.
 *
 * How: a recording fake `PtyHost` passed to the constructor
 * (tests/helpers/fake-pty-host.ts); no PTY is started, so the calls the
 * manager makes are the whole observable.
 *
 * Why it matters: the host keeps a session's ring (up to 1 MiB) until it is
 * forgotten. With the in-process host a missing `forget` was invisible to
 * every test; in the pty-host process it is a leak that outlives the backend.
 *
 * Also: `ptyEnv` strips the pty-host's own seams, so a backend started from
 * inside a session does not inherit its parent's session holder settings.
 *
 * NOT claimed: what the host does with `forget` (`pty-host-conformance.test.ts`);
 * the P3 wiring (adopt, lost hosts, pending spawns: `sessions-adopt.test.ts`,
 * `pty-host-crash.test.ts`).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { ptyEnv } from '../../server/sessions-env.ts';
import type { PtyHost } from '../../server/pty-host-api.ts';
import type { SessionManager } from '../../server/sessions.ts';
import { removeTempDir } from '../helpers/helpers.ts';
import { fakeHostManager, fakePtyHost as fakeHost } from '../helpers/fake-pty-host.ts';

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await removeTempDir(d);
});

async function manager(host: PtyHost): Promise<SessionManager> {
  return (await fakeHostManager(host, dirs)).sessions;
}

test('the manager spawns through the host it was given and listens to it', async () => {
  const host = fakeHost();
  const sessions = await manager(host);
  assert.ok(host.events() !== undefined, 'the manager registered as the one listener');
  const info = await sessions.create({ cwd: '/', command: 'bash', args: ['-l'], cols: 100, rows: 30 });
  assert.equal(host.spawned[0]?.id, info.id, 'the manager chose the id and passed it');
  assert.deepEqual(host.spawned[0]?.argv, ['-l']);
  assert.deepEqual([host.spawned[0]?.cols, host.spawned[0]?.rows], [100, 30]);
});

test('destroy kills through the host and then forgets the id there', async () => {
  const host = fakeHost();
  const sessions = await manager(host);
  const { id } = await sessions.create({ cwd: '/', command: 'bash', args: [], cols: 80, rows: 24 });
  host.calls.length = 0;
  assert.equal(sessions.destroy(id), true);
  // D9 P3: the blob is marked deleted first, so a backend that dies inside the
  // kill ladder does not adopt the session back (pty-host-adopt.test.ts).
  assert.deepEqual(host.calls, [`set-meta ${id}`, `kill ${id} ladder`, `forget ${id}`], 'mark, kill, then forget');
});

test('destroying an exited session forgets it without a kill', async () => {
  const host = fakeHost();
  const sessions = await manager(host);
  const { id } = await sessions.create({ cwd: '/', command: 'bash', args: [], cols: 80, rows: 24 });
  host.events()?.exit(id, { code: 0, signal: null, at: 1 });
  host.calls.length = 0;
  sessions.destroy(id);
  assert.deepEqual(host.calls, [`forget ${id}`]);
});

test('a PTY never inherits the pty-host seams of the backend that started it', () => {
  const seams = ['AI_SM_PTY_HOST', 'AI_SM_PTY_HOST_IDLE_MS', 'AI_SM_PTY_HOST_ORPHAN_MS', 'AI_SM_PTY_HOST_BUILD'];
  const saved = seams.map((name) => [name, process.env[name]] as const);
  try {
    for (const name of seams) process.env[name] = '1';
    const env = ptyEnv();
    for (const name of seams) assert.equal(env[name], undefined, `${name} must not reach a session`);
    assert.equal(env['TERM'], 'xterm-256color', 'the rest of the env is composed as before');
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
