/**
 * Restart and the sessions' fate — Nocturne D9 P4
 * (`.claude/plans/nocturne/PLAN-D9.md` § Defaults, decision 27): the
 * RestartController keeps the sessions (teardown told `keep`) whenever the new
 * backend can adopt them, and otherwise refuses with 409 `sessions-would-end`
 * BEFORE anything is torn down — unless the caller said `endSessions: true`,
 * when the teardown ends them (`end`). Running sessions inside this backend
 * (no pty-host) are refused before the build; an incompatible pty-host, or none
 * the standby could reach while sessions run, after the standby reported in.
 *
 * How: RestartController in-process with every OS-touching dependency
 * injected (`harness` in `tests/helpers/restart-fixture.ts`): the session
 * facts and the standby's pty-host verdict are the inputs, the events, the
 * fates the teardown received and the outcome are what is asserted.
 *
 * Why it matters: a wrong verdict either ends every session of a user who was
 * promised they keep running, or hands the next backend a pty-host it cannot
 * adopt (the sessions then die as a `crash` with no warning).
 *
 * NOT claimed here: the probe itself and a real restart over a real pty-host —
 * `tests/server/restart-survive.test.ts`, `tests/server/restart-incompatible.test.ts`;
 * the route's body — `tests/server/restart-route.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESTART_SESSIONS_WOULD_END } from '../../shared/protocol.ts';
import { REFUSED_SESSIONS_WOULD_END } from '../../server/restart.ts';
import { harness } from '../helpers/restart-fixture.ts';

const WOULD_END = { error: REFUSED_SESSIONS_WOULD_END, code: RESTART_SESSIONS_WOULD_END };

test('a compatible pty-host keeps the running sessions: no refusal, the teardown is told to keep them', async () => {
  const h = harness({ facts: () => ({ running: 3, inProcess: 0 }), ptyHost: 'compatible' });
  const outcome = await h.controller.request();
  assert.equal(outcome.status, 202, JSON.stringify(outcome.body));
  assert.deepEqual(h.fates, ['keep']);
  assert.ok(
    h.logLines.includes('[info] [restart] the sessions stay with the pty-host for the new backend'),
    h.logLines.join(' | '),
  );
});

test('running sessions inside this backend: 409 sessions-would-end before anything is built or spawned', async () => {
  const h = harness({ facts: () => ({ running: 2, inProcess: 2 }) });
  const outcome = await h.controller.request();
  assert.equal(outcome.status, 409);
  assert.deepEqual(outcome.body, WOULD_END);
  assert.equal(outcome.onFlushed, null, 'a refusal never exits the process');
  assert.deepEqual(h.events, [], 'no dependency check, no build, no standby, no teardown');
  assert.equal(h.controller.inProgress, false);
  assert.ok(
    h.logLines.some((l) => l.startsWith('[warn]') && l.includes('2 running session(s) live inside this backend')),
    h.logLines.join(' | '),
  );
});

test('one running session inside this backend is enough for the 409 before the build', async () => {
  const h = harness({ facts: () => ({ running: 1, inProcess: 1 }) });
  const outcome = await h.controller.request();
  assert.equal(outcome.status, 409);
  assert.deepEqual(outcome.body, WOULD_END);
  assert.deepEqual(h.events, [], 'no build is spent on a restart the user has not agreed to yet');
});

test('an incompatible pty-host with running sessions: 409 after the standby, which is stopped with the staged build dropped', async () => {
  const h = harness({ facts: () => ({ running: 1, inProcess: 0 }), ptyHost: 'incompatible' });
  const outcome = await h.controller.request();
  assert.equal(outcome.status, 409);
  assert.deepEqual(outcome.body, WOULD_END);
  assert.deepEqual(
    h.events,
    ['deps', 'build', 'standby', 'stop', 'discard'],
    'nothing swapped, nothing torn down: the running backend is whole',
  );
  assert.deepEqual(h.fates, []);
});

test('no pty-host the standby could reach while sessions run is refused the same way', async () => {
  const h = harness({ facts: () => ({ running: 1, inProcess: 0 }), ptyHost: 'none' });
  const outcome = await h.controller.request();
  assert.equal(outcome.status, 409);
  assert.deepEqual(outcome.body, WOULD_END);
  assert.deepEqual(h.events, ['deps', 'build', 'standby', 'stop', 'discard']);
});

test('endSessions: true lets a restart that cannot keep the sessions through, and the teardown ends them', async () => {
  for (const [name, facts, ptyHost] of [
    ['in-process', { running: 1, inProcess: 1 }, 'compatible'],
    ['incompatible', { running: 1, inProcess: 0 }, 'incompatible'],
    ['unreachable', { running: 2, inProcess: 0 }, 'none'],
  ] as const) {
    const h = harness({ facts: () => facts, ptyHost });
    const outcome = await h.controller.request(undefined, { endSessions: true });
    assert.equal(outcome.status, 202, `${name}: ${JSON.stringify(outcome.body)}`);
    assert.deepEqual(h.fates, ['end'], name);
    assert.ok(
      h.logLines.some((l) => l.includes('restart requested by the ui') && l.includes('(ending the sessions allowed)')),
      `${name}: the request line says the user allowed it`,
    );
  }
});

test('endSessions: true is a permission, not an order: sessions that can be kept are kept', async () => {
  const h = harness({ facts: () => ({ running: 2, inProcess: 0 }), ptyHost: 'compatible' });
  const outcome = await h.controller.request(undefined, { endSessions: true });
  assert.equal(outcome.status, 202);
  assert.deepEqual(h.fates, ['keep']);
});

test('with nothing running there is never a 409; an incompatible holder of exited sessions is still ended at the teardown', async () => {
  for (const ptyHost of ['compatible', 'incompatible', 'none'] as const) {
    const h = harness({ facts: () => ({ running: 0, inProcess: 0 }), ptyHost });
    const outcome = await h.controller.request();
    assert.equal(outcome.status, 202, `${ptyHost}: ${JSON.stringify(outcome.body)}`);
    assert.deepEqual(h.fates, [ptyHost === 'incompatible' ? 'end' : 'keep'], ptyHost);
  }
});

test('the refusal is retryable: the same controller answers the next request', async () => {
  let inProcess = 1;
  const h = harness({ facts: () => ({ running: 1, inProcess }), ptyHost: 'compatible' });
  assert.equal((await h.controller.request()).status, 409);
  inProcess = 0;
  const outcome = await h.controller.request();
  assert.equal(outcome.status, 202, 'a 409 sessions-would-end leaves no single-flight lock behind');
  assert.deepEqual(h.fates, ['keep']);
});
