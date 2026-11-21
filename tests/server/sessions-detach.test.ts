/**
 * `SessionManager.detachAll` — Nocturne D9 P4 (`.claude/plans/nocturne/PLAN-D9.md`
 * § Defaults: "Restart/update ⇒ detachAll() (flush meta, detach, close WS 1012,
 * history NOT stamped)"; § Risks (a), the pending spawn): what a restart that
 * keeps the sessions does to them before the new backend adopts them.
 *
 * How: the real SessionManager and SessionHistory over the recording fake
 * `PtyHost` (tests/helpers/fake-pty-host.ts), whose spawns can be held
 * unanswered; the calls the manager makes and the blobs it parks are the
 * observable. The same handoff end to end: `restart-survive.test.ts`.
 *
 * Why it matters: a detach that kills or stamps ends the sessions it promised
 * to keep; one that forgets the scan offset makes the new backend re-raise a
 * bell the user already looked at; one that leaves a spawn in flight hands
 * the next backend a session no history entry was ever written for; one that
 * re-kills a session the user just deleted cuts its graceful ladder short.
 *
 * NOT claimed: the wire (`pty-host-reattach.test.ts`), the restart's choice
 * between detach and end (`restart-sessions-fate.test.ts`).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionMeta } from '../../server/sessions-meta.ts';
import { removeTempDir } from '../helpers/helpers.ts';
import { fakeHostManager, fakePtyHost } from '../helpers/fake-pty-host.ts';

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await removeTempDir(d);
});

const LAUNCH = { cwd: '/tmp', command: 'bash', args: ['-l'], cols: 80, rows: 24 };

test('detachAll parks every blob at its current offset and says goodbye; nothing is killed or stamped', async () => {
  const host = fakePtyHost();
  const { sessions, history } = await fakeHostManager(host, dirs);
  const running = await sessions.create(LAUNCH);
  const exited = await sessions.create(LAUNCH);
  host.events()?.output(running.id, 'hello\r\n', 0);
  host.events()?.exit(exited.id, { code: 3, signal: null, at: Date.now() });
  host.calls.length = 0;

  sessions.detachAll();

  assert.deepEqual(
    host.calls,
    [`set-meta ${running.id}`, `set-meta ${exited.id}`, 'detach'],
    'one blob per session, then the goodbye: no kill, no forget, no shutdown-all',
  );
  assert.equal(parseSessionMeta(host.metas.get(running.id) ?? null)?.scannedTo, 7, 'the scan stood after the 7 bytes it saw');
  assert.equal(history.get(running.id)?.ended, null, 'the running session is still live in history');
  assert.equal(history.get(exited.id)?.ended?.reason, 'exit', 'the exited one keeps its own end');
});

test('a spawn still in flight at detachAll is killed and handed back BEFORE the goodbye, and never registered', async () => {
  const host = fakePtyHost({ hold: true });
  const lines: string[] = [];
  const { sessions, history } = await fakeHostManager(host, dirs, (level, msg) => void lines.push(`${level} ${msg}`));
  const created = sessions.create(LAUNCH);
  const id = host.spawned[0]?.id as string;

  sessions.detachAll();

  const kill = host.calls.indexOf(`kill ${id} now`);
  const forget = host.calls.indexOf(`forget ${id}`);
  const detach = host.calls.indexOf('detach');
  assert.ok(kill >= 0 && forget > kill && detach > forget, `kill, forget, then detach: ${host.calls.join(', ')}`);
  host.answer(id);
  await assert.rejects(created, /shutting down/);
  assert.deepEqual(sessions.list(), []);
  assert.equal(history.get(id), undefined, 'no history entry: the next backend must not adopt a session nobody launched');
  assert.ok(
    lines.includes('info [session] detached for a restart: 0 running and 0 exited session(s) left with the pty-host, 1 spawn(s) in flight ended'),
    lines.join(' | '),
  );
});

test('a session deleted while its kill ladder still runs is left to that ladder: not killed again, not counted as a spawn', async () => {
  const host = fakePtyHost();
  const lines: string[] = [];
  const { sessions } = await fakeHostManager(host, dirs, (level, msg) => void lines.push(`${level} ${msg}`));
  const deleted = await sessions.create(LAUNCH);
  sessions.destroy(deleted.id); // DELETE: the ladder starts; its exit has not come back yet.
  host.calls.length = 0;

  sessions.detachAll();

  assert.deepEqual(host.calls, ['detach'], 'the DELETE ladder in the pty-host finishes the PTY; detach adds no kill to it');
  assert.ok(
    lines.includes('info [session] detached for a restart: 0 running and 0 exited session(s) left with the pty-host, 0 spawn(s) in flight ended'),
    lines.join(' | '),
  );
});

test('after detachAll no new spawn is even asked for', async () => {
  const host = fakePtyHost();
  const { sessions } = await fakeHostManager(host, dirs);
  sessions.detachAll();
  await assert.rejects(sessions.create(LAUNCH), /shutting down/);
  assert.deepEqual(host.spawned, []);
});
