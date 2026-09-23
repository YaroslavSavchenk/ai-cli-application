/**
 * Manual backend restart — the same-port handoff (server/restart.ts,
 * POST /api/restart): the CONTROLLER with injected deps. The sequence and its
 * order (preflight first, teardown only then, 202), the 409 guard, the failure
 * paths, and that the process only ever leaves AFTER the response is flushed;
 * then the PREFLIGHT — every 422 refusal (dependencies out of step, a failed
 * build, a standby that never gets ready or dies before the swap, a swap that
 * fails) leaves the running backend exactly as it found it, and is retryable.
 *
 * How: RestartController in-process with every OS-touching dependency
 * injected and a fake clock (`harness` in `tests/helpers/restart-fixture.ts`)
 * — nothing is spawned, built or killed.
 *
 * Why (2026-09-08): a restart must never kill a working backend for a
 * replacement that cannot run.
 *
 * NOT claimed here: the real build + swap — `tests/server/restart-webbuild.test.ts`,
 * `tests/server/restart-webbuild-failures.test.ts`; the standby —
 * `tests/server/restart-standby.test.ts`; the route —
 * `tests/server/restart-route.test.ts`; a REAL restart —
 * `tests/server/restart-real.test.ts`; installed mode —
 * `tests/server/restart-installed.test.ts`; closeAll —
 * `tests/server/restart-closeall.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Duplex } from 'node:stream';
import type { RestartResponse, RuntimeInfo } from '../../shared/protocol.ts';
import {
  RestartController,
  RESTART_IN_PROGRESS,
  REFUSED_BUILD,
  REFUSED_DEPENDENCIES,
  REFUSED_STANDBY,
} from '../../server/restart.ts';
import { waitUntil } from '../helpers/helpers.ts';
import { FAKE_BUILD, OLD_PID, OLD_PORT, harness, within } from '../helpers/restart-fixture.ts';

// ---------------------------------------------------------------------------
// 1. The controller, with every OS-touching dependency injected
// ---------------------------------------------------------------------------

/**
 * Wait for the controller's DEFERRED exit without sleeping.
 *
 * `#exitAfterFlush` defers the exit with `setImmediate` so the access-log line
 * for this very request is written first. A `setImmediate` scheduled after it
 * therefore runs after it — FIFO inside one check phase — which makes this an
 * ordering guarantee, not a wait.
 *
 * It replaces an `await delay(20)`: a 20 ms TIMER racing an immediate is only
 * ordered while the event loop is idle, and under full-suite load the timer
 * won (measured 2026-09-06: 1 failure in 4 `npm test` runs, `exits` still []).
 */
function afterDeferredExit(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

test('restart controller: preflights FIRST, tears down only then, and answers 202', async () => {
  const h = harness();
  const outcome = await h.controller.request();

  assert.equal(outcome.status, 202);
  assert.deepEqual(
    h.events,
    ['deps', 'build', 'standby', 'swap', 'teardown', 'go', 'commit'],
    'the whole point: dependencies, a staged build and a proven standby BEFORE anything is torn ' +
      'down; the new screens are swapped in only once their backend exists, the port is ' +
      'handed over only once the listener is closed, and the swap is committed (its backup ' +
      'dropped) only once `go` is out and no refusal can follow',
  );
  assert.deepEqual(
    h.spawned,
    [{ portHint: OLD_PORT, restartedFrom: OLD_PID }],
    'the child is told which port to try and which pid it replaces',
  );
  assert.ok(
    h.logLines.some((l) =>
      l.includes('preflight: frontend build ok (build id 20260908-1200-abc1234, asset assets/index-New.js, 42ms'),
    ),
    `the build is logged by id and asset: ${h.logLines.join(' | ')}`,
  );
  assert.ok(
    h.logLines.some((l) => l.includes('preflight: standby backend ready (pid 9999)')),
    'and so is the standby',
  );
  assert.ok(
    h.logLines.some((l) => l.includes('preflight: frontend swapped in (build id 20260908-1200-abc1234)')),
    'and the swap itself, which is the step that changes what the browser gets',
  );
  const body = outcome.body as RestartResponse;
  assert.deepEqual(
    Object.keys(body).sort(),
    ['port', 'samePort', 'startedAt'],
    'exactly the three documented fields — never the auth token',
  );
  assert.equal(body.port, OLD_PORT);
  assert.equal(body.samePort, true);
  assert.equal(body.startedAt, '2026-09-06T12:00:00.000Z', "the CHILD's startedAt, not ours");
  assert.ok(
    h.logLines.some((l) => l.includes('restart requested by the ui: sessions=2 presence=1 attached=3')),
    `the one request line carries the counts: ${h.logLines.join(' | ')}`,
  );

  // The process leaves only when the route says the bytes are out.
  assert.deepEqual(h.exits, [], 'nothing exits before the response is flushed');
  assert.ok(outcome.onFlushed !== null);
  outcome.onFlushed();
  assert.deepEqual(h.exits, [], 'and not synchronously either: the bytes go out first');
  await afterDeferredExit(); // The exit is deferred one tick so the access log line is written.
  assert.deepEqual(h.exits, [0], 'then exactly one exit(0)');
  outcome.onFlushed();
  await afterDeferredExit();
  assert.deepEqual(h.exits, [0], 'and never twice, whoever calls it again');
});

test('restart controller: a child on a DIFFERENT port answers samePort:false with the real port', async () => {
  const other: RuntimeInfo = {
    port: OLD_PORT + 7,
    token: 'unused',
    pid: OLD_PID + 1,
    startedAt: '2026-09-06T12:00:01.000Z',
  };
  const h = harness({ runtime: () => other });
  const outcome = await h.controller.request();
  const body = outcome.body as RestartResponse;

  assert.equal(outcome.status, 202);
  assert.equal(body.port, OLD_PORT + 7, 'the port the child actually took');
  assert.equal(body.samePort, false, 'the flag the UI keys on: the window cannot follow');
  assert.ok(
    h.logLines.some((l) => l.includes(`took port ${OLD_PORT + 7}, not the hinted ${OLD_PORT}`)),
    'and the log says so',
  );
});

test('restart controller: runtime.json still naming OUR pid is not a handoff — it waits for the child', async () => {
  let reads = 0;
  const ours: RuntimeInfo = {
    port: OLD_PORT,
    token: 'unused',
    pid: OLD_PID,
    startedAt: '2026-09-06T11:59:00.000Z',
  };
  const child: RuntimeInfo = { ...ours, pid: OLD_PID + 1, startedAt: '2026-09-06T12:00:02.000Z' };
  const h = harness({
    runtime: () => {
      reads += 1;
      return reads < 5 ? ours : child; // Our own file, then the child's.
    },
  });
  const outcome = await h.controller.request();
  assert.equal(outcome.status, 202);
  assert.equal((outcome.body as RestartResponse).startedAt, '2026-09-06T12:00:02.000Z');
  assert.ok(reads >= 5, 'it polled until the pid changed');
});

test('restart controller: a second request while one runs is 409 and changes NOTHING', async () => {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness();
  // Make the first request hang inside the health probe.
  const controller = new RestartController({
    log: (level, message) => h.logLines.push(`[${level}] ${message}`),
    counts: () => ({ sessions: 0, presence: 0, attached: 0 }),
    port: () => OLD_PORT,
    pid: OLD_PID,
    teardown: () => h.events.push('teardown'),
    dependenciesReady: () => true,
    buildFrontend: () => Promise.resolve(FAKE_BUILD),
    swapFrontend: () => {
      h.events.push('swap');
      return { hadPrevious: true };
    },
    revertFrontend: () => h.events.push('revert'),
    commitFrontend: () => h.events.push('commit'),
    discardFrontend: () => h.events.push('discard'),
    startStandby: (env) => {
      h.events.push('standby');
      h.spawned.push(env);
      return Promise.resolve({
        pid: 1,
        dead: () => false,
        stop: () => undefined,
        go: () => h.events.push('go'),
      });
    },
    readRuntime: () => ({
      port: OLD_PORT,
      token: 'unused',
      pid: OLD_PID + 1,
      startedAt: '2026-09-06T12:00:03.000Z',
    }),
    probeHealth: async () => {
      await gate;
      return true;
    },
    exit: (code) => h.exits.push(code),
  });

  const first = controller.request();
  try {
    // Let the preflight finish and the teardown run; the first request then hangs
    // in the health probe, which is the state a second POST must meet.
    await waitUntil(() => (controller.inProgress ? true : undefined), 'the teardown to run', 5_000, 1);
    const second = await within(controller.request(), 'the second POST');

    assert.equal(second.status, 409);
    assert.deepEqual(second.body, { error: RESTART_IN_PROGRESS });
    assert.equal(second.onFlushed, null, 'a refused restart must not exit the process');
    assert.deepEqual(
      h.events,
      ['standby', 'swap', 'teardown', 'go', 'commit'],
      'one standby, one swap, one teardown, one go — not two of anything',
    );
  } finally {
    release(); // Even on a failed assertion: a held gate would hang the file.
  }
  const done = await first;
  assert.equal(done.status, 202);
  assert.deepEqual(h.spawned.length, 1);
});

test('restart controller: a child that never becomes healthy answers 500 — and still leaves', async () => {
  const h = harness({ healthy: () => false, timeoutMs: 15_000 });
  const outcome = await h.controller.request();

  assert.equal(outcome.status, 500);
  assert.deepEqual(outcome.body, {
    error: 'restart failed: the new backend did not come back in time; relaunch from the desktop shortcut',
  });
  assert.ok(outcome.onFlushed !== null, 'sessions are dead and the listener is closed: it cannot stay');
  outcome.onFlushed();
  await afterDeferredExit();
  assert.deepEqual(h.exits, [0]);
  assert.ok(
    h.logLines.some((l) => l.startsWith('[error]') && l.includes('did not take over within 15000ms')),
    `the failure is an error line: ${h.logLines.join(' | ')}`,
  );
});

test('restart controller: the in-flight request socket is the ONE thing teardown must spare', async () => {
  // The route hands `req.socket` down so the teardown can skip it; without that
  // the 202 is written into a destroyed socket and the UI sees a network error
  // from a restart that actually succeeded.
  let spared: Duplex | undefined;
  let called = 0;
  const controller = new RestartController({
    log: () => undefined,
    counts: () => ({ sessions: 0, presence: 0, attached: 0 }),
    port: () => OLD_PORT,
    pid: OLD_PID,
    teardown: (keepSocket) => {
      called += 1;
      spared = keepSocket;
    },
    dependenciesReady: () => true,
    buildFrontend: () => Promise.resolve(FAKE_BUILD),
    swapFrontend: () => ({ hadPrevious: true }),
    revertFrontend: () => undefined,
    commitFrontend: () => undefined,
    discardFrontend: () => undefined,
    startStandby: () =>
      Promise.resolve({ pid: 1, dead: () => false, stop: () => undefined, go: () => undefined }),
    readRuntime: () => ({
      port: OLD_PORT,
      token: 'unused',
      pid: OLD_PID + 1,
      startedAt: '2026-09-06T12:00:04.000Z',
    }),
    probeHealth: () => Promise.resolve(true),
    exit: () => undefined,
  });

  const socket = { marker: 'the POST /api/restart connection' } as unknown as Duplex;
  const outcome = await controller.request(socket);
  assert.equal(outcome.status, 202);
  assert.equal(called, 1, 'teardown runs exactly once');
  assert.equal(spared, socket, 'and it is told which socket carries the answer');
});

test('restart controller: inProgress latches ON and never clears — the SIGTERM guard depends on it', async () => {
  // server/index.ts reads this flag in shutdown() and in the uncaughtException
  // handler: while it is true, neither may run the teardown again and — the
  // part that matters — neither may unlink runtime.json, which by then
  // describes the CHILD. So the flag must survive past the response.
  const h = harness();
  assert.equal(h.controller.inProgress, false, 'a fresh process is not restarting');
  const outcome = await h.controller.request();
  assert.equal(outcome.status, 202);
  assert.equal(h.controller.inProgress, true, 'still latched after a successful handoff');

  // And after a FAILED handoff too: the sessions are dead and the listener is
  // closed either way, so a later SIGTERM must still not touch runtime.json.
  const failed = harness({ healthy: () => false, timeoutMs: 1_000 });
  assert.equal((await failed.controller.request()).status, 500);
  assert.equal(failed.controller.inProgress, true, 'latched after a failed handoff as well');
});

test('restart controller: a teardown that throws answers 500, spawns NOTHING, and still exits', async () => {
  // The one state this process may never be left in: sessions half-killed, the
  // listener in an unknown state, no child spawned, and the request rejecting
  // into the route's generic 400 handler — a live pid serving nothing while
  // runtime.json still names it. #failure exits, so the launcher can start over.
  const h = harness({ teardownThrows: true });
  const outcome = await h.controller.request();

  assert.equal(outcome.status, 500);
  assert.deepEqual(outcome.body, {
    error: 'restart failed: the old backend could not step aside; relaunch from the desktop shortcut',
  });
  assert.deepEqual(
    h.events,
    ['deps', 'build', 'standby', 'swap', 'teardown', 'commit'],
    'the standby is never told to go after a failed teardown — the port may still be held — ' +
      'but the swap IS committed: nothing can revert now (the sessions are gone) and the new ' +
      'build is what a relaunch from the shortcut will serve, so <dist>-prev has no use left',
  );

  assert.ok(
    h.logLines.some((l) => l.startsWith('[error]') && l.includes('restart teardown failed')),
    'the failure is in the log, with the class + frames only',
  );
  assert.ok(
    !h.logLines.some((l) => l.includes('server.close blew up')),
    'the thrown MESSAGE never reaches the log line',
  );

  assert.notEqual(outcome.onFlushed, null, 'a failed handoff still leaves');
  outcome.onFlushed?.();
  await afterDeferredExit();
  assert.deepEqual(h.exits, [0], 'exit(0) once the 500 is on the wire');
  assert.equal(h.controller.inProgress, true, 'latched: a later SIGTERM must not unlink runtime.json');
});

test('restart controller: a runtime.json with an out-of-range port or an unparsable startedAt is NOT a handoff', async () => {
  // A half-written or corrupted file must read as "not written yet": the port
  // is probed, logged and handed to the UI as a navigation target, and
  // startedAt goes straight into a log line.
  for (const bad of [
    { port: 0 },
    { port: -1 },
    { port: 65536 },
    { port: 8080.5 },
    { startedAt: 'not a date' },
    { startedAt: '' },
  ] as Partial<RuntimeInfo>[]) {
    const h = harness({
      timeoutMs: 1_000,
      runtime: () => ({
        port: OLD_PORT,
        token: 'unused',
        pid: OLD_PID + 1,
        startedAt: '2026-09-06T12:00:00.000Z',
        ...bad,
      }),
    });
    const outcome = await h.controller.request();
    assert.equal(outcome.status, 500, `${JSON.stringify(bad)} must not count as a live child`);
  }

  // ... while the very same file with a valid port and date IS the handoff.
  const good = harness();
  assert.equal((await good.controller.request()).status, 202);
});

test('restart controller: a standby that dies between "ready" and "go" is 500 — the teardown already ran', async () => {
  // The one window the preflight cannot close: the standby proved it can boot,
  // the old process tore itself down, and only THEN the child died. Sessions
  // are gone and nothing is listening, so this exits like any failed handoff.
  const h = harness({ goThrows: true });
  const outcome = await h.controller.request();

  assert.equal(outcome.status, 500);
  assert.deepEqual(outcome.body, {
    error: 'restart failed: could not start the new backend; relaunch from the desktop shortcut',
  });
  assert.deepEqual(
    h.events,
    ['deps', 'build', 'standby', 'swap', 'teardown', 'go', 'commit'],
    'the swap is committed on this failure too: no <dist>-prev is left behind',
  );
  assert.ok(
    h.logLines.some(
      (l) => l.startsWith('[error]') && l.includes('handing the port to the standby backend failed'),
    ),
    'the detail belongs in the log, not in the response',
  );
  assert.notEqual(outcome.onFlushed, null, 'and this process still leaves');
});

// ---------------------------------------------------------------------------
// 1b. The PREFLIGHT — 422, and the old backend untouched
// ---------------------------------------------------------------------------
//
// The whole reason this exists (2026-09-08): a restart must never kill a
// working backend for a replacement that cannot run. Every refusal below has to
// leave the process EXACTLY as it found it — no teardown, no spawn, no exit,
// and `inProgress` still false so the user can fix the problem and try again.

test('preflight: dependencies out of step is 422 — no teardown, no standby, nothing exits', async () => {
  const h = harness({ depsReady: false });
  const outcome = await h.controller.request();

  assert.equal(outcome.status, 422);
  assert.deepEqual(outcome.body, { error: REFUSED_DEPENDENCIES });
  assert.equal(
    (outcome.body as { error: string }).error,
    'Dependencies changed. Install them in the project folder, then restart.',
  );
  assert.deepEqual(h.events, ['deps'], 'it stops at the very first check');
  assert.deepEqual(h.spawned, []);
  assert.equal(outcome.onFlushed, null, 'a refused restart must never exit the process');
  assert.deepEqual(h.exits, []);
  assert.equal(h.controller.inProgress, false, 'nothing was torn down: a later SIGTERM is a NORMAL shutdown');
  assert.ok(
    h.logLines.some((l) => l.startsWith('[error]') && l.includes(REFUSED_DEPENDENCIES)),
    `the refusal is logged at error: ${h.logLines.join(' | ')}`,
  );
});

test('preflight: a failed frontend build is 422 and the running backend keeps serving', async () => {
  const h = harness({ buildRefusal: REFUSED_BUILD });
  const outcome = await h.controller.request();

  assert.equal(outcome.status, 422);
  assert.deepEqual(outcome.body, { error: "The app's screens could not be rebuilt." });
  assert.ok(
    !REFUSED_BUILD.includes('log'),
    'and it never points at server.log: the user cannot open that from the GUI',
  );
  assert.deepEqual(h.events, ['deps', 'build'], 'no standby is spawned for a build that failed');
  assert.equal(h.controller.inProgress, false);
  assert.deepEqual(h.exits, []);
});

test('preflight: a build that fails because vite is MISSING refuses with the dependency message', async () => {
  // server/webbuild.ts throws a RestartRefusal naming the dependency reason;
  // the controller must pass that through rather than flatten it to "build".
  const h = harness({ buildRefusal: REFUSED_DEPENDENCIES });
  const outcome = await h.controller.request();
  assert.equal(outcome.status, 422);
  assert.deepEqual(outcome.body, { error: REFUSED_DEPENDENCIES });
});

test('preflight: a standby that never reports ready is 422 — the old process is still whole', async () => {
  const h = harness({ standbyThrows: true });
  const outcome = await h.controller.request();

  assert.equal(outcome.status, 422);
  assert.deepEqual(outcome.body, { error: 'The new backend did not start.' });
  assert.deepEqual(
    h.events,
    ['deps', 'build', 'standby', 'discard'],
    'the teardown is never reached — and the staged build is dropped, never swapped in',
  );
  assert.equal(h.controller.inProgress, false);
  assert.deepEqual(h.exits, []);
  assert.ok(
    h.logLines.some((l) => l.startsWith('[error]') && l.includes(REFUSED_STANDBY)),
    'and the log says which step refused',
  );
});

test('preflight: a standby that dies AFTER reporting ready is 422 — before the swap, nothing moved', async () => {
  // The window the "did it boot?" check cannot cover: it reported ready and
  // then fell over. Caught inside the preflight, so the staged build is dropped
  // and the user keeps the old screens on the old backend.
  const h = harness({ standbyDies: 'before-swap' });
  const outcome = await h.controller.request();

  assert.equal(outcome.status, 422);
  assert.deepEqual(outcome.body, { error: REFUSED_STANDBY });
  assert.deepEqual(
    h.events,
    ['deps', 'build', 'standby', 'discard'],
    'no swap and no teardown: the running backend is whole',
  );
  assert.equal(
    h.events.filter((e) => e === 'discard').length,
    1,
    'and the staged build is really dropped — exactly once, by the controller itself: a ' +
      'web/dist-next left behind is a build the NEXT restart could inherit half of',
  );
  assert.equal(h.controller.inProgress, false);
  assert.deepEqual(h.exits, []);
  assert.equal(outcome.onFlushed, null, 'and nothing may exit this process');
});

test('preflight: a standby that dies between the swap and the teardown is 422, NOT a torn-down 500', async () => {
  // The last look before the point of no return (server/restart.ts). Without it
  // the teardown runs, `go` reaches nobody, and the user loses every session to
  // a 500 — for a replacement that was already dead before anything was touched.
  const h = harness({ standbyDies: 'after-swap' });
  const outcome = await h.controller.request();

  assert.equal(outcome.status, 422);
  assert.deepEqual(outcome.body, { error: REFUSED_STANDBY });
  assert.deepEqual(
    h.events,
    ['deps', 'build', 'standby', 'swap', 'revert(hadPrevious=true)'],
    'the teardown is never reached — the sessions and the listener survive, and the swap that ' +
      'already happened is UNDONE: a 422 means nothing changed, web/dist included',
  );
  assert.equal(h.controller.inProgress, false, 'a later SIGTERM is still an ORDINARY shutdown');
  assert.deepEqual(h.exits, []);
  assert.equal(outcome.onFlushed, null);
  assert.ok(
    h.logLines.some((l) => l.startsWith('[error]') && l.includes('died after reporting ready')),
    `and the log says which step refused: ${h.logLines.join(' | ')}`,
  );
});

test('preflight: a swap that fails is 422, and the standby it kept waiting is stopped', async () => {
  const h = harness({ swapThrows: true });
  const outcome = await h.controller.request();

  assert.equal(outcome.status, 422);
  assert.deepEqual(outcome.body, { error: REFUSED_BUILD });
  assert.deepEqual(
    h.events,
    ['deps', 'build', 'standby', 'swap', 'stop', 'discard'],
    'the replacement is killed and the staged build dropped: no orphan, no leftovers',
  );
  assert.equal(h.controller.inProgress, false);
  assert.deepEqual(h.exits, []);
});

test('preflight: a refusal is RETRYABLE — the next POST runs the whole sequence again', async () => {
  // A latched flag after a refusal would leave the user with a permanently
  // 409-ing restart button on a backend that is perfectly healthy.
  let ready = false;
  const events: string[] = [];
  const controller = new RestartController({
    log: () => undefined,
    counts: () => ({ sessions: 0, presence: 0, attached: 0 }),
    port: () => OLD_PORT,
    pid: OLD_PID,
    teardown: () => events.push('teardown'),
    dependenciesReady: () => ready,
    buildFrontend: () => Promise.resolve(FAKE_BUILD),
    swapFrontend: () => ({ hadPrevious: true }),
    revertFrontend: () => undefined,
    commitFrontend: () => undefined,
    discardFrontend: () => undefined,
    startStandby: () =>
      Promise.resolve({ pid: 7, dead: () => false, stop: () => undefined, go: () => events.push('go') }),
    readRuntime: () => ({
      port: OLD_PORT,
      token: 'unused',
      pid: OLD_PID + 1,
      startedAt: '2026-09-08T12:00:00.000Z',
    }),
    probeHealth: () => Promise.resolve(true),
    exit: () => undefined,
  });

  assert.equal((await controller.request()).status, 422, 'refused while node_modules is behind');
  assert.deepEqual(events, [], 'and it really did nothing');
  ready = true; // The user ran npm install.
  assert.equal((await controller.request()).status, 202, 'the retry goes all the way through');
  assert.deepEqual(events, ['teardown', 'go']);
});

test('preflight: a second POST while the preflight runs is 409, not a second build', async () => {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const controller = new RestartController({
    log: () => undefined,
    counts: () => ({ sessions: 0, presence: 0, attached: 0 }),
    port: () => OLD_PORT,
    pid: OLD_PID,
    teardown: () => events.push('teardown'),
    dependenciesReady: () => true,
    buildFrontend: async () => {
      events.push('build');
      await gate; // A real vite build takes seconds; the button can be hit twice.
      return FAKE_BUILD;
    },
    swapFrontend: () => ({ hadPrevious: true }),
    revertFrontend: () => undefined,
    commitFrontend: () => undefined,
    discardFrontend: () => undefined,
    startStandby: () =>
      Promise.resolve({ pid: 7, dead: () => false, stop: () => undefined, go: () => events.push('go') }),
    readRuntime: () => ({
      port: OLD_PORT,
      token: 'unused',
      pid: OLD_PID + 1,
      startedAt: '2026-09-08T12:00:01.000Z',
    }),
    probeHealth: () => Promise.resolve(true),
    exit: () => undefined,
  });

  const first = controller.request();
  try {
    assert.equal(controller.inProgress, false, 'a preflight has torn down NOTHING yet');
    const second = await within(controller.request(), 'the second POST during the preflight');
    assert.equal(second.status, 409, 'but it is still a restart in flight');
    assert.deepEqual(second.body, { error: RESTART_IN_PROGRESS });
    assert.equal(second.onFlushed, null);
  } finally {
    release(); // Even on a failed assertion: a held gate would hang the file.
  }
  assert.equal((await first).status, 202);
  assert.deepEqual(events, ['build', 'teardown', 'go'], 'exactly one build and one teardown');
});
