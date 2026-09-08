/**
 * Manual backend restart — the same-port handoff (server/restart.ts,
 * POST /api/restart) and the child-side AI_SM_PORT_HINT fallback.
 *
 * Three layers, because each answers a different question:
 *   1. the CONTROLLER with injected deps — the sequence, its order, the 409
 *      guard, the two failure paths, and that the process only ever leaves
 *      AFTER the response is flushed;
 *   2. the ROUTE against a real in-process http server — the token gate, the
 *      Origin/Host parity, 405, and the exact wire shapes (a fake runner, so
 *      nothing is spawned);
 *   3. one REAL restart of a real backend on a scratch data dir — the child
 *      keeps the port, the old pid is gone, runtime.json belongs to the child
 *      (never unlinked by the parent), the killed session is stamped
 *      'shutdown' in history, and the presence socket is closed 1012.
 *
 * SAFETY: every process here is one this file started, on a temp data dir. The
 * real-restart test adopts the CHILD it caused and SIGTERMs it by the pid in
 * the child's own runtime.json.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Duplex } from 'node:stream';
import type {
  HistoryEntry,
  RestartResponse,
  RuntimeInfo,
  RuntimeStatusResponse,
} from '../shared/protocol.ts';
import {
  createStandbyStarter,
  RestartController,
  RestartRefusal,
  RESTART_IN_PROGRESS,
  REFUSED_BUILD,
  REFUSED_DEPENDENCIES,
  REFUSED_STANDBY,
  type FrontendBuild,
  type RestartDeps,
  type StandbyChild,
  type RestartOutcome,
  type RestartRunner,
} from '../server/restart.ts';
import {
  buildFrontend,
  commitFrontend,
  discardFrontend,
  revertFrontend,
  swapFrontend,
  BUILD_KILL_GRACE_MS,
  BUILD_OUTPUT_TAIL_BYTES,
} from '../server/webbuild.ts';
import { createUpdateChecker, readWebBuild } from '../server/buildinfo.ts';
import { createRequestHandler } from '../server/api.ts';
import { createUpgradeHandler } from '../server/ws.ts';
import { LifecycleController } from '../server/lifecycle.ts';
import { createLogger, createRefusalLimiter, scoped } from '../server/config.ts';
import { SessionHistory } from '../server/history.ts';
import { SessionManager } from '../server/sessions.ts';
import { ProjectStore } from '../server/projects.ts';
import { PrefsStore } from '../server/prefs.ts';
import { GithubConnection } from '../server/github.ts';
import {
  api,
  createSession,
  destroyAllAndSettle,
  presenceUrl,
  projectRoot,
  rawRequest,
  readServerLog,
  removeTempDir,
  startTestServer,
  waitForLogLines,
  waitUntil,
  WsClient,
} from './helpers.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ai-sm-restart-'));
}

/**
 * A private copy of the repo's built frontend for a REAL restart to chew on.
 *
 * A restart REBUILDS and SWAPS the directory it serves. Without this the two
 * real-restart tests below would rebuild `web/dist` in the working tree twice
 * per `npm test`: a developer's running backend would light its update pill
 * after every test run, and for the length of the two renames `web/dist` would
 * not exist at all — while other test files (tests/auth.test.ts) fetch `/`.
 * AI_SM_WEB_DIST_DIR points the server at this copy instead; `dist-next` and
 * `dist-prev` are created beside it, inside the temp dir.
 */
function webDistCopy(): { dir: string; served: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sm-webdist-'));
  const served = join(dir, 'dist');
  const source = join(projectRoot, 'web', 'dist');
  if (existsSync(source)) cpSync(source, served, { recursive: true });
  else mkdirSync(served, { recursive: true });
  return { dir, served, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** What the repo's own web/dist IS, so a test can prove it did not move. */
function repoWebDist(): { buildId: string | null; asset: string | null; indexMtime: string | null } {
  return readWebBuild(join(projectRoot, 'web', 'dist'));
}

// ---------------------------------------------------------------------------
// 1. The controller, with every OS-touching dependency injected
// ---------------------------------------------------------------------------

interface Harness {
  controller: RestartController;
  events: string[];
  spawned: { portHint: number; restartedFrom: number }[];
  exits: number[];
  logLines: string[];
}

/** The build a stubbed preflight reports — never a real vite run. */
const FAKE_BUILD: FrontendBuild = { buildId: '20260908-1200-abc1234', asset: 'assets/index-New.js', ms: 42 };

const OLD_PID = 4242;
const OLD_PORT = 41000;

function harness(opts: {
  /** runtime.json contents, evaluated on every poll. */
  runtime?: () => RuntimeInfo | undefined;
  healthy?: (port: number) => boolean;
  /** Preflight 1: false = node_modules out of step. */
  depsReady?: boolean;
  /** Preflight 2: the reason a build refuses, or undefined for a good build. */
  buildRefusal?: string;
  /** Preflight 3: the standby never reports ready. */
  standbyThrows?: boolean;
  /** Preflight 3b: the standby reported ready and then died before the teardown. */
  standbyDies?: 'before-swap' | 'after-swap';
  /** Preflight 4: the swap of the staged build fails. */
  swapThrows?: boolean;
  /** Preflight 4b: was there a served build for the swap to move aside? */
  hadPreviousDist?: boolean;
  /** The handoff itself: `go` throws (the standby died between ready and go). */
  goThrows?: boolean;
  teardownThrows?: boolean;
  timeoutMs?: number;
} = {}): Harness {
  const events: string[] = [];
  const spawned: { portHint: number; restartedFrom: number }[] = [];
  const exits: number[] = [];
  const logLines: string[] = [];
  // A fake clock the fake sleep advances: a 15 s timeout costs no real time.
  let clock = 1_000_000;
  const childRuntime: RuntimeInfo = {
    port: OLD_PORT,
    token: 'unused',
    pid: OLD_PID + 1,
    startedAt: '2026-09-06T12:00:00.000Z',
  };
  const deps: RestartDeps = {
    log: (level, message) => logLines.push(`[${level}] ${message}`),
    counts: () => ({ sessions: 2, presence: 1, attached: 3 }),
    port: () => OLD_PORT,
    pid: OLD_PID,
    teardown: () => {
      events.push('teardown');
      if (opts.teardownThrows === true) throw new Error('server.close blew up');
    },
    dependenciesReady: () => {
      events.push('deps');
      return opts.depsReady ?? true;
    },
    buildFrontend: () => {
      events.push('build');
      if (opts.buildRefusal !== undefined) {
        return Promise.reject(new RestartRefusal(opts.buildRefusal, 'vite exited code=1 signal=null'));
      }
      return Promise.resolve(FAKE_BUILD);
    },
    swapFrontend: () => {
      events.push('swap');
      if (opts.swapThrows === true) {
        throw new RestartRefusal(REFUSED_BUILD, 'the new build could not be moved into place');
      }
      return { hadPrevious: opts.hadPreviousDist ?? true };
    },
    revertFrontend: (swap) => events.push(`revert(hadPrevious=${swap.hadPrevious})`),
    commitFrontend: () => events.push('commit'),
    discardFrontend: () => events.push('discard'),
    startStandby: (env) => {
      events.push('standby');
      if (opts.standbyThrows === true) return Promise.reject(new Error('the standby exited early'));
      spawned.push(env);
      return Promise.resolve({
        pid: 9999,
        // 'before-swap' is caught inside the preflight, 'after-swap' by the
        // last look the controller takes before the teardown.
        dead: () => {
          if (opts.standbyDies === 'before-swap') return true;
          return opts.standbyDies === 'after-swap' && events.includes('swap');
        },
        stop: () => events.push('stop'),
        go: () => {
          events.push('go');
          if (opts.goThrows === true) throw new Error('ERR_IPC_CHANNEL_CLOSED');
        },
      });
    },
    readRuntime: opts.runtime ?? ((): RuntimeInfo => childRuntime),
    probeHealth: (port) => Promise.resolve(opts.healthy?.(port) ?? true),
    exit: (code) => exits.push(code),
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
  return { controller: new RestartController(deps), events, spawned, exits, logLines };
}

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

/**
 * Await `p`, but never for longer than `ms`.
 *
 * The 409 guard is what the two tests below are FOR, and a regression that
 * removes it does not turn them red — it makes the second request run the whole
 * sequence, block on the very gate the first request is holding, and hang
 * `npm test` forever. (Measured: dropping `|| this.#preflighting` from
 * server/restart.ts hangs the file instead of failing it.) A hang is a strictly
 * worse failure mode than an assertion, so this bound turns it back into one.
 */
async function within<T>(p: Promise<T>, what: string, ms = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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

// ---------------------------------------------------------------------------
// 1c. The frontend build + swap (server/webbuild.ts) on a real filesystem
// ---------------------------------------------------------------------------
//
// vite itself is stubbed (the REAL restart test at the bottom runs the real
// one); what is exercised here is the part that can destroy a working app: the
// verification and the two renames. Build and swap are SEPARATE calls — the
// restart only swaps once the replacement backend has reported ready — so the
// tests below call them in that order, with the sabotage in between.

/** A fake `vite build`: writes what `write` says, then exits with `code`. */
function fakeVite(behaviour: {
  code: number;
  stdout?: string;
  stderr?: string;
  write?: (outDir: string) => void;
}): (cmd: string, args: string[]) => ChildProcess {
  return (_cmd: string, args: string[]): ChildProcess => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (): boolean => true;
    const outDir = args[args.indexOf('--outDir') + 1] as string;
    setImmediate(() => {
      behaviour.write?.(outDir);
      if (behaviour.stdout !== undefined) child.stdout.emit('data', Buffer.from(behaviour.stdout));
      if (behaviour.stderr !== undefined) child.stderr.emit('data', Buffer.from(behaviour.stderr));
      child.emit('close', behaviour.code, null);
    });
    return child as unknown as ChildProcess;
  };
}

/** A complete build output: the three files webbuild.ts insists on. */
function writeBuild(outDir: string, id: string, asset = 'index-NEWNEW00.js'): void {
  mkdirSync(join(outDir, 'assets'), { recursive: true });
  writeFileSync(join(outDir, 'index.html'), `<!doctype html><!--${id}-->`);
  writeFileSync(join(outDir, 'assets', asset), '//new');
  writeFileSync(join(outDir, 'build-id.json'), `{"id":"${id}"}\n`);
}

/** A repo root with an installed vite and an already-built web/dist. */
function buildFixture(): { root: string; dist: string; lines: string[] } {
  const root = tempDir();
  mkdirSync(join(root, 'node_modules', 'vite', 'bin'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '// not run in these tests');
  const dist = join(root, 'web', 'dist');
  writeBuild(dist, '20260101-0000-oldold0', 'index-OLDOLD00.js');
  return { root, dist, lines: [] };
}

test('web build: a good build is STAGED, then swapped in, and dist-next is gone afterwards', async () => {
  const fx = buildFixture();
  const nextDir = join(fx.root, 'web', 'dist-next');
  try {
    const opts = {
      repoRoot: fx.root,
      webDistDir: fx.dist,
      log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
        fx.lines.push(`[${level}] ${message}`),
      spawnFn: fakeVite({
        code: 0,
        stdout: 'transforming...\n✓ built in 184ms\n',
        write: (outDir: string) => writeBuild(outDir, '20260908-1200-newnew1'),
      }),
    };
    const result = await buildFrontend(opts);

    // BEFORE the swap: the user is still on the old screens. This is the whole
    // reason the two halves are separate — the standby is proven in between.
    assert.equal(
      readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
      '{"id":"20260101-0000-oldold0"}',
      'the served build is untouched until the swap',
    );
    assert.ok(existsSync(join(nextDir, 'build-id.json')), 'and the new one is staged beside it');

    swapFrontend(opts);

    assert.deepEqual(
      { buildId: result.buildId, asset: result.asset },
      { buildId: '20260908-1200-newnew1', asset: 'assets/index-NEWNEW00.js' },
    );
    assert.ok(result.ms >= 0);
    assert.equal(readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(), '{"id":"20260908-1200-newnew1"}');
    assert.ok(existsSync(join(fx.dist, 'assets', 'index-NEWNEW00.js')), 'the new bundle is being served');
    assert.ok(!existsSync(join(fx.dist, 'assets', 'index-OLDOLD00.js')), 'and the old one is gone');
    assert.ok(!existsSync(join(fx.root, 'web', 'dist-next')), 'no scratch dir left behind');
    // The backup OUTLIVES the swap on purpose: the standby can still be found
    // dead before the teardown, and that answers 422 — which promises web/dist
    // is unchanged. Only `commitFrontend` (called once `go` is out) drops it.
    assert.ok(existsSync(join(fx.root, 'web', 'dist-prev')), 'the old build is kept as a backup');
    commitFrontend(opts);
    assert.ok(!existsSync(join(fx.root, 'web', 'dist-prev')), 'and the commit is what removes it');
    assert.ok(
      fx.lines.some((l) => l.startsWith('[debug]') && l.includes('vite output') && l.includes('built in 184ms')),
      `the bounded vite tail is logged at debug: ${fx.lines.join(' | ')}`,
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: revertFrontend puts the OLD build back, so a post-swap refusal changes nothing', () => {
  // The window the swap opens: the standby can still be found dead between the
  // swap and the teardown, and that is a 422 — which the contract says leaves
  // web/dist UNCHANGED. The backup kept by the swap is what makes that true.
  const fx = buildFixture();
  const opts = {
    webDistDir: fx.dist,
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
      fx.lines.push(`[${level}] ${message}`),
  };
  try {
    writeBuild(join(fx.root, 'web', 'dist-next'), '20260908-1200-newnew1');
    const swapped = swapFrontend(opts);
    assert.equal(swapped.hadPrevious, true, 'a build WAS moved aside');
    assert.equal(readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(), '{"id":"20260908-1200-newnew1"}');

    revertFrontend({ ...opts, hadPrevious: swapped.hadPrevious });

    assert.equal(
      readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
      '{"id":"20260101-0000-oldold0"}',
      'the served build is byte-for-byte the one that was there before the swap',
    );
    assert.ok(existsSync(join(fx.dist, 'assets', 'index-OLDOLD00.js')), 'old bundle back');
    assert.ok(!existsSync(join(fx.dist, 'assets', 'index-NEWNEW00.js')), 'new bundle gone');
    assert.ok(!existsSync(join(fx.root, 'web', 'dist-next')), 'and no staging dir is left');
    assert.ok(!existsSync(join(fx.root, 'web', 'dist-prev')), 'and no backup either');
    assert.ok(
      fx.lines.some((l) => l.startsWith('[info]') && l.includes('the refused restart changed nothing')),
      `the restore is one line in the log: ${fx.lines.join(' | ')}`,
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: with NO previous dist, a post-swap refusal leaves the served path ABSENT again', async () => {
  // The other half of "every 422 leaves web/dist unchanged": when there was no
  // web/dist at all (the `frontend build missing` reason — exactly the state
  // that lights the pill), the swap moves nothing aside, so undoing it means
  // REMOVING the new build. Leaving it would serve screens built for the
  // replacement from the backend that refused to be replaced.
  const fx = buildFixture();
  rmSync(fx.dist, { recursive: true, force: true }); // No frontend at all.
  const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string): number =>
    fx.lines.push(`[${level}] ${message}`);
  const events: string[] = [];
  try {
    const controller = new RestartController({
      log,
      counts: () => ({ sessions: 1, presence: 1, attached: 1 }),
      port: () => OLD_PORT,
      pid: OLD_PID,
      teardown: () => events.push('teardown'),
      dependenciesReady: () => true,
      buildFrontend: async () =>
        buildFrontend({
          repoRoot: fx.root,
          webDistDir: fx.dist,
          log,
          spawnFn: fakeVite({
            code: 0,
            stdout: 'built\n',
            write: (outDir: string) => writeBuild(outDir, '20260908-1200-newnew1'),
          }),
        }),
      swapFrontend: () => swapFrontend({ webDistDir: fx.dist, log }),
      revertFrontend: (swap) => revertFrontend({ webDistDir: fx.dist, log, ...swap }),
      commitFrontend: () => commitFrontend({ webDistDir: fx.dist }),
      discardFrontend: () => discardFrontend({ webDistDir: fx.dist }),
      startStandby: () =>
        Promise.resolve({
          pid: 12,
          // Alive through the preflight, dead by the last look before teardown.
          dead: () => existsSync(join(fx.dist, 'index.html')),
          stop: () => events.push('stop'),
          go: () => events.push('go'),
        }),
      readRuntime: () => undefined,
      probeHealth: () => Promise.resolve(false),
      exit: (code) => events.push(`exit${code}`),
    });

    const outcome = await controller.request();

    assert.equal(outcome.status, 422);
    assert.deepEqual(outcome.body, { error: REFUSED_STANDBY });
    assert.deepEqual(events, [], 'nothing was torn down and nothing exited');
    assert.ok(!existsSync(fx.dist), 'the served directory is absent again, exactly as it was');
    assert.ok(!existsSync(join(fx.root, 'web', 'dist-next')), 'no staged build survives');
    assert.ok(!existsSync(join(fx.root, 'web', 'dist-prev')), 'and no backup was invented');
    assert.ok(
      fx.lines.some(
        (l) =>
          l.startsWith('[info]') &&
          l.includes('the refused restart changed nothing') &&
          l.includes('there is none now'),
      ),
      `and one line says the served path is empty again: ${fx.lines.join(' | ')}`,
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: a LEGACY dist without build-id.json is still a frontend build and swaps fine', () => {
  // The guard decides what may be MOVED ASIDE, and a web/dist built before
  // build-id.json existed is a real frontend build. Requiring the id here would
  // refuse every restart on such a tree forever — with a message about screens
  // that could not be rebuilt, which is not what happened.
  const fx = buildFixture();
  rmSync(join(fx.dist, 'build-id.json'), { force: true });
  const opts = {
    webDistDir: fx.dist,
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
      fx.lines.push(`[${level}] ${message}`),
  };
  try {
    writeBuild(join(fx.root, 'web', 'dist-next'), '20260908-1200-newnew1');

    const swapped = swapFrontend(opts);

    assert.deepEqual(swapped, { hadPrevious: true });
    assert.equal(readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(), '{"id":"20260908-1200-newnew1"}');
    assert.ok(
      existsSync(join(fx.root, 'web', 'dist-prev', 'assets', 'index-OLDOLD00.js')),
      'the legacy build is the backup, entry bundle and all',
    );
    // …and it comes back byte-for-byte on a refusal, id file or not.
    revertFrontend({ ...opts, ...swapped });
    assert.ok(existsSync(join(fx.dist, 'assets', 'index-OLDOLD00.js')), 'the legacy bundle is served again');
    assert.ok(!existsSync(join(fx.dist, 'build-id.json')), 'and it is still the id-less build it was');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: a newline in the served path can never forge a second log line', async () => {
  // AI_SM_WEB_DIST_DIR is an environment value and a directory name may hold a
  // newline on Linux. Interpolated raw, `<dir>\n2026-… [error] …` would read as
  // an entry this process never wrote.
  const fx = buildFixture();
  const name = 'ev\nil [error] [restart] forged';
  const evil = join(fx.root, 'web', name);
  mkdirSync(evil, { recursive: true }); // Exists, but is NOT a frontend build.
  const lines: string[] = [];
  const opts = {
    repoRoot: fx.root,
    webDistDir: evil,
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
      lines.push(`[${level}] ${message}`),
    spawnFn: fakeVite({
      code: 0,
      stdout: 'built\n',
      write: (outDir: string) => writeBuild(outDir, '20260908-1200-newnew1'),
    }),
  };
  try {
    // Logs the staging dir twice: 'building the frontend into …' and 'staged in …'.
    await buildFrontend(opts);
    // …and this logs the served dir in its refusal line.
    assert.throws(
      () => swapFrontend(opts),
      (err: unknown) => err instanceof RestartRefusal && err.refusal === REFUSED_BUILD,
      'no index.html: refused, whatever the directory is called',
    );

    assert.ok(lines.length >= 3, `the paths really were logged: ${lines.length} lines`);
    for (const line of lines) {
      assert.ok(!line.includes('\n'), `one event is one line: ${JSON.stringify(line)}`);
      assert.ok(!line.includes('\r'), `no carriage returns either: ${JSON.stringify(line)}`);
    }
    assert.ok(
      lines.some((l) => l.includes('il [error] [restart] forged')),
      `and the path is still readable, just flattened: ${JSON.stringify(lines)}`,
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: swapFrontend REFUSES to rename a directory that is not a frontend build', () => {
  // AI_SM_WEB_DIST_DIR is an env value, and this code renames what it names and
  // later deletes the backup. A value like the user's projects folder must not
  // become `projects-prev` and then vanish.
  const fx = buildFixture();
  const stranger = join(fx.root, 'not-a-build');
  mkdirSync(join(stranger, 'src'), { recursive: true });
  writeFileSync(join(stranger, 'README.md'), '# a real folder of the user\n');
  writeFileSync(join(stranger, 'src', 'main.ts'), 'export const x = 1;\n');
  const opts = {
    webDistDir: stranger,
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
      fx.lines.push(`[${level}] ${message}`),
  };
  try {
    writeBuild(join(fx.root, 'not-a-build-next'), '20260908-1200-newnew1');

    assert.throws(
      () => swapFrontend(opts),
      (err: unknown) => err instanceof RestartRefusal && err.refusal === REFUSED_BUILD,
      'a swap onto something that is not a build is a refusal, not a rename',
    );

    assert.equal(readFileSync(join(stranger, 'README.md'), 'utf8'), '# a real folder of the user\n');
    assert.ok(existsSync(join(stranger, 'src', 'main.ts')), 'the directory is untouched, file for file');
    assert.ok(!existsSync(join(fx.root, 'not-a-build-prev')), 'NOTHING was renamed aside');
    assert.ok(!existsSync(join(fx.root, 'not-a-build-next')), 'and the staged build is dropped');
    assert.ok(
      fx.lines.some((l) => l.startsWith('[error]') && l.includes('is not a frontend build directory')),
      `and the log says exactly why: ${fx.lines.join(' | ')}`,
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('preflight: a standby dying after the REAL swap answers 422 with web/dist byte-identical', async () => {
  // The controller wired to the real filesystem halves, which is the only way
  // to prove the promise the docs make: every 422 leaves the served build
  // exactly as it was, and leaves no staging directory behind.
  const fx = buildFixture();
  try {
    writeBuild(join(fx.root, 'web', 'dist-next'), '20260908-1200-newnew1');
    const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string): number =>
      fx.lines.push(`[${level}] ${message}`);
    const events: string[] = [];
    const controller = new RestartController({
      log,
      counts: () => ({ sessions: 1, presence: 1, attached: 1 }),
      port: () => OLD_PORT,
      pid: OLD_PID,
      teardown: () => events.push('teardown'),
      dependenciesReady: () => true,
      // Already staged above: this test is about what happens AFTER the swap.
      buildFrontend: () => Promise.resolve(FAKE_BUILD),
      swapFrontend: () => swapFrontend({ webDistDir: fx.dist, log }),
      revertFrontend: (swap) => revertFrontend({ webDistDir: fx.dist, log, ...swap }),
      commitFrontend: () => commitFrontend({ webDistDir: fx.dist }),
      discardFrontend: () => discardFrontend({ webDistDir: fx.dist }),
      startStandby: () =>
        Promise.resolve({
          pid: 11,
          // Alive through the preflight, dead by the last look before teardown.
          dead: () => existsSync(join(fx.dist, 'assets', 'index-NEWNEW00.js')),
          stop: () => events.push('stop'),
          go: () => events.push('go'),
        }),
      readRuntime: () => undefined,
      probeHealth: () => Promise.resolve(false),
      exit: (code) => events.push(`exit${code}`),
    });

    const outcome = await controller.request();

    assert.equal(outcome.status, 422);
    assert.deepEqual(outcome.body, { error: REFUSED_STANDBY });
    assert.deepEqual(events, [], 'nothing was torn down, nothing was handed over, nothing exited');
    assert.equal(controller.inProgress, false);
    assert.equal(
      readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
      '{"id":"20260101-0000-oldold0"}',
      'the served build is the one that was there before the POST',
    );
    assert.ok(existsSync(join(fx.dist, 'assets', 'index-OLDOLD00.js')), 'down to the entry bundle');
    assert.ok(!existsSync(join(fx.root, 'web', 'dist-next')), 'no staged build survives the refusal');
    assert.ok(!existsSync(join(fx.root, 'web', 'dist-prev')), 'and no backup either');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: a FAILED build refuses and leaves the served web/dist byte-for-byte intact', async () => {
  const fx = buildFixture();
  try {
    await assert.rejects(
      buildFrontend({
        repoRoot: fx.root,
        webDistDir: fx.dist,
        log: (level, message) => fx.lines.push(`[${level}] ${message}`),
        spawnFn: fakeVite({
          code: 1,
          stderr: 'error during build: Could not resolve "./gone.ts"\n',
          write: (outDir) => {
            // A half-written output, exactly what a crashed bundler leaves.
            mkdirSync(outDir, { recursive: true });
            writeFileSync(join(outDir, 'index.html'), '<!doctype html>');
          },
        }),
      }),
      (err: unknown) => {
        assert.ok(err instanceof RestartRefusal);
        assert.equal(err.refusal, REFUSED_BUILD);
        return true;
      },
    );

    assert.equal(
      readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
      '{"id":"20260101-0000-oldold0"}',
      'the old build is untouched: the app the user is looking at keeps working',
    );
    assert.ok(existsSync(join(fx.dist, 'assets', 'index-OLDOLD00.js')));
    assert.ok(!existsSync(join(fx.root, 'web', 'dist-next')), 'the failed output is cleaned up');
    assert.ok(
      fx.lines.some((l) => l.startsWith('[error]') && l.includes('vite exited code=1')),
      'the reason is at error level',
    );
    assert.ok(
      fx.lines.some((l) => l.startsWith('[error]') && l.includes('Could not resolve')),
      'with the bounded output tail beside it',
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: a build that exits 0 but produced no build-id.json is NOT swapped in', async () => {
  for (const missing of ['build-id.json', 'index.html', join('assets', 'index-NEWNEW00.js')]) {
    const fx = buildFixture();
    try {
      await assert.rejects(
        buildFrontend({
          repoRoot: fx.root,
          webDistDir: fx.dist,
          log: (level, message) => fx.lines.push(`[${level}] ${message}`),
          spawnFn: fakeVite({
            code: 0,
            write: (outDir) => {
              writeBuild(outDir, '20260908-1200-newnew1');
              rmSync(join(outDir, missing));
            },
          }),
        }),
        (err: unknown) => err instanceof RestartRefusal && err.refusal === REFUSED_BUILD,
        `a build output without ${missing} must refuse`,
      );
      assert.equal(
        readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
        '{"id":"20260101-0000-oldold0"}',
      );
      assert.ok(!existsSync(join(fx.root, 'web', 'dist-next')));
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }
});

test('web build: no node_modules/vite/bin/vite.js refuses with the DEPENDENCY message, spawning nothing', async () => {
  const root = tempDir();
  try {
    const dist = join(root, 'web', 'dist');
    writeBuild(dist, '20260101-0000-oldold0', 'index-OLDOLD00.js');
    let spawned = 0;
    await assert.rejects(
      buildFrontend({
        repoRoot: root,
        webDistDir: dist,
        log: () => undefined,
        spawnFn: (): ChildProcess => {
          spawned += 1;
          return fakeVite({ code: 0 })('node', []);
        },
      }),
      (err: unknown) => err instanceof RestartRefusal && err.refusal === REFUSED_DEPENDENCIES,
    );
    assert.equal(spawned, 0, 'nothing is executed when the tree is not installed');
    assert.ok(existsSync(join(dist, 'build-id.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('web build: a build that hangs is killed at the timeout and refuses', async () => {
  const fx = buildFixture();
  const idle = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await assert.rejects(
      buildFrontend({
        repoRoot: fx.root,
        webDistDir: fx.dist,
        log: (level, message) => fx.lines.push(`[${level}] ${message}`),
        timeoutMs: 150,
        spawnFn: () => idle, // A REAL process that never finishes.
      }),
      (err: unknown) => err instanceof RestartRefusal && err.refusal === REFUSED_BUILD,
    );
    assert.ok(
      fx.lines.some((l) => l.startsWith('[error]') && l.includes('did not finish within 150ms')),
      `the timeout is logged: ${fx.lines.join(' | ')}`,
    );
    await waitUntil(() => (idle.killed || idle.exitCode !== null ? true : undefined), 'the hung build to be killed');
    assert.equal(
      readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
      '{"id":"20260101-0000-oldold0"}',
      'and the old build still stands',
    );
    assert.ok(
      !existsSync(join(fx.root, 'web', 'dist-next')),
      'and the half-written output of the killed build is cleaned up — the NEXT restart ' +
        'must not verify leftovers from this one',
    );
  } finally {
    idle.kill('SIGKILL');
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: the second rename failing RESTORES the old frontend — never a window without a UI', async () => {
  // The one genuinely dangerous moment in the whole feature: `dist` has already
  // been moved to `dist-prev`, so if `dist-next` -> `dist` fails and nothing
  // puts it back, the app serves NOTHING until someone rebuilds by hand.
  // Sabotage = the verified build output vanishes between the two renames.
  const fx = buildFixture();
  const nextDir = join(fx.root, 'web', 'dist-next');
  const prevDir = join(fx.root, 'web', 'dist-prev');
  try {
    const opts = {
      repoRoot: fx.root,
      webDistDir: fx.dist,
      log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
        fx.lines.push(`[${level}] ${message}`),
      spawnFn: fakeVite({
        code: 0,
        write: (outDir: string) => writeBuild(outDir, '20260908-1200-newnew1'),
      }),
    };
    await buildFrontend(opts);
    rmSync(nextDir, { recursive: true, force: true }); // The verified output vanishes.
    assert.throws(
      () => swapFrontend(opts),
      (err: unknown) => {
        assert.ok(err instanceof RestartRefusal);
        assert.equal(err.refusal, REFUSED_BUILD);
        assert.equal(err.message, 'the new build could not be moved into place');
        return true;
      },
    );

    // THE assertion of this test: the app the user is looking at is back.
    assert.ok(existsSync(fx.dist), 'web/dist exists again');
    assert.equal(
      readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
      '{"id":"20260101-0000-oldold0"}',
      'and it is the OLD build, restored byte-for-byte',
    );
    assert.ok(existsSync(join(fx.dist, 'assets', 'index-OLDOLD00.js')), 'with its own entry bundle');
    assert.ok(!existsSync(prevDir), 'the backup was consumed by the restore, not left lying around');
    assert.ok(!existsSync(nextDir), 'and no scratch dir survives either');
    assert.ok(
      fx.lines.some((l) => l.startsWith('[error]') && l.includes('could not move the new frontend into place')),
      `the failure is one error line: ${fx.lines.join(' | ')}`,
    );
    assert.ok(
      !fx.lines.some((l) => l.includes('the OLD frontend could not be restored')),
      'and the loud "both renames failed" line is NOT printed when the restore worked',
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: the FIRST rename failing refuses without touching the served build', async () => {
  // `dist` -> `dist-prev` is refused (the parent directory is not writable), so
  // the swap never starts. Nothing has moved, so there is nothing to restore —
  // and the refusal must still name the build reason, not a crash.
  if (process.getuid?.() === 0) return; // root ignores the mode bits; nothing to prove.
  const fx = buildFixture();
  const webDir = join(fx.root, 'web');
  try {
    const opts = {
      repoRoot: fx.root,
      webDistDir: fx.dist,
      log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
        fx.lines.push(`[${level}] ${message}`),
      spawnFn: fakeVite({
        code: 0,
        write: (outDir: string) => writeBuild(outDir, '20260908-1200-newnew1'),
      }),
    };
    await buildFrontend(opts);
    chmodSync(webDir, 0o500); // web/ is no longer writable: no rename can happen.
    assert.throws(
      () => swapFrontend(opts),
      (err: unknown) => {
        assert.ok(err instanceof RestartRefusal);
        assert.equal(err.refusal, REFUSED_BUILD);
        assert.equal(err.message, 'the old build could not be moved aside');
        return true;
      },
    );
    chmodSync(webDir, 0o700);
    assert.equal(
      readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
      '{"id":"20260101-0000-oldold0"}',
      'the served build never moved',
    );
    assert.ok(
      fx.lines.some((l) => l.startsWith('[error]') && l.includes('could not move the old frontend aside')),
      `the failure is one error line: ${fx.lines.join(' | ')}`,
    );
  } finally {
    chmodSync(webDir, 0o700);
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: a repo with NO web/dist yet builds straight into place', async () => {
  // A fresh checkout (web/dist is gitignored): there is nothing to move aside,
  // so `hadDist` is false and the restore path must never be entered.
  const root = tempDir();
  try {
    mkdirSync(join(root, 'node_modules', 'vite', 'bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '// not run');
    const dist = join(root, 'web', 'dist');
    mkdirSync(join(root, 'web'), { recursive: true });
    assert.ok(!existsSync(dist), 'the starting point: nothing built');

    const lines: string[] = [];
    const opts = {
      repoRoot: root,
      webDistDir: dist,
      log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
        lines.push(`[${level}] ${message}`),
      spawnFn: fakeVite({
        code: 0,
        write: (outDir: string) => writeBuild(outDir, '20260908-1200-first01'),
      }),
    };
    const result = await buildFrontend(opts);
    swapFrontend(opts);

    assert.equal(result.buildId, '20260908-1200-first01');
    assert.ok(existsSync(join(dist, 'index.html')));
    assert.ok(existsSync(join(dist, 'assets', 'index-NEWNEW00.js')));
    assert.ok(!existsSync(join(root, 'web', 'dist-next')));
    assert.ok(!existsSync(join(root, 'web', 'dist-prev')));
    assert.ok(
      !lines.some((l) => l.startsWith('[error]')),
      `nothing failed: ${lines.join(' | ')}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('web build: a leftover dist-next from a crashed earlier run is wiped BEFORE the build, never inherited', async () => {
  // If a previous restart died between "vite wrote dist-next" and the swap, a
  // complete-looking stale output is sitting there. Two ways it could be
  // promoted, both refused:
  for (const [why, behaviour] of [
    // 1. this build FAILS and the only complete output on disk is the leftover;
    ['a failed build', { code: 1, stderr: 'boom\n' }],
    // 2. this build "succeeds" but writes only part of its output — without the
    //    pre-build wipe the stale index.html and stale bundle fill the gaps and
    //    a verified-looking mix of two builds gets swapped in.
    [
      'a partial build',
      {
        code: 0,
        write: (outDir: string): void => {
          mkdirSync(outDir, { recursive: true });
          writeFileSync(join(outDir, 'build-id.json'), '{"id":"20260908-1200-partial"}\n');
        },
      },
    ],
  ] as [string, Parameters<typeof fakeVite>[0]][]) {
    const fx = buildFixture();
    const nextDir = join(fx.root, 'web', 'dist-next');
    try {
      writeBuild(nextDir, '20260102-0000-stale00', 'index-STALE000.js');
      await assert.rejects(
        buildFrontend({
          repoRoot: fx.root,
          webDistDir: fx.dist,
          log: () => undefined,
          spawnFn: fakeVite(behaviour),
        }),
        (err: unknown) => err instanceof RestartRefusal && err.refusal === REFUSED_BUILD,
        why,
      );
      assert.equal(
        readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
        '{"id":"20260101-0000-oldold0"}',
        `${why}: the stale output was never promoted`,
      );
      assert.ok(
        !existsSync(join(fx.dist, 'assets', 'index-STALE000.js')),
        `${why}: and its bundle never reached web/dist`,
      );
      assert.ok(!existsSync(nextDir));
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }
});

test('web build: a vite that IGNORES SIGTERM is SIGKILLed after the grace — never left writing into dist-next', async () => {
  // The timeout kill is two steps: SIGTERM now, SIGKILL BUILD_KILL_GRACE_MS
  // later, and the escalation deliberately outlives the refusal (the promise
  // resolves at the SIGTERM). A vite that traps SIGTERM would otherwise keep
  // writing into web/dist-next long after the restart was refused — and the
  // NEXT restart wipes dist-next before building, so the two would race.
  assert.equal(BUILD_KILL_GRACE_MS, 2_000, 'the shipped grace');
  const fx = buildFixture();
  const stubborn = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    await assert.rejects(
      buildFrontend({
        repoRoot: fx.root,
        webDistDir: fx.dist,
        log: (level, message) => fx.lines.push(`[${level}] ${message}`),
        timeoutMs: 100,
        spawnFn: () => stubborn,
      }),
      (err: unknown) => err instanceof RestartRefusal && err.refusal === REFUSED_BUILD,
    );
    assert.equal(stubborn.exitCode, null, 'the SIGTERM alone did not move it: that is the point');
    const how = await waitUntil(
      () => (stubborn.signalCode === null && stubborn.exitCode === null ? undefined : stubborn.signalCode),
      `the stubborn build to be SIGKILLed ${BUILD_KILL_GRACE_MS}ms after the SIGTERM`,
    );
    assert.equal(how, 'SIGKILL', 'the escalation is real, not a comment');
    assert.equal(
      readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
      '{"id":"20260101-0000-oldold0"}',
      'and the served build never moved',
    );
  } finally {
    stubborn.kill('SIGKILL');
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("web build: vite's output is logged as a BOUNDED tail with the full byte count beside it", async () => {
  // vite draws progress with control characters and a broken build can print
  // megabytes. Only the last BUILD_OUTPUT_TAIL_BYTES reach server.log — bounded
  // on the way IN, so a runaway build cannot grow this process either — and the
  // count is the FULL size, so the log never lies about how much was dropped.
  assert.equal(BUILD_OUTPUT_TAIL_BYTES, 4_096, 'the shipped bound');
  const fx = buildFixture();
  const stdout = `HEADMARKER${'a'.repeat(5_000)}\n`; // 5011 bytes
  const stderr = `${'b'.repeat(100)}TAILMARKER\n`; //    111 bytes
  const total = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
  assert.equal(total, 5_122, 'the fixture is the arithmetic this test asserts');
  try {
    await buildFrontend({
      repoRoot: fx.root,
      webDistDir: fx.dist,
      log: (level, message) => fx.lines.push(`[${level}] ${message}`),
      spawnFn: fakeVite({
        code: 0,
        stdout,
        stderr,
        write: (outDir: string) => writeBuild(outDir, '20260908-1200-newnew1'),
      }),
    });
    const line = fx.lines.find((l) => l.includes('vite output'));
    assert.ok(line !== undefined, `the tail is logged: ${fx.lines.join(' | ')}`);
    const marker = `vite output ${total} bytes, last ${BUILD_OUTPUT_TAIL_BYTES} bytes: `;
    assert.ok(line.includes(marker), `both counts are named verbatim: ${line.slice(0, 120)}`);
    const tail = line.slice(line.indexOf(marker) + marker.length);
    assert.ok(
      Buffer.byteLength(tail) <= BUILD_OUTPUT_TAIL_BYTES,
      `the logged tail is ${Buffer.byteLength(tail)} bytes, over the ${BUILD_OUTPUT_TAIL_BYTES} bound`,
    );
    assert.ok(tail.includes('TAILMARKER'), 'it is the LAST bytes, across both streams');
    assert.ok(!tail.includes('HEADMARKER'), 'and the first 1026 bytes were dropped, not kept');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: a spawn that never starts (child `error`) refuses with `could not run vite`', async () => {
  // The `close` path covers a vite that ran and failed. This is the other one:
  // ENOENT/EACCES on the binary itself, where no exit code ever arrives — an
  // unhandled 'error' on a ChildProcess is an uncaught exception that would
  // take the whole backend down instead of refusing the restart.
  const fx = buildFixture();
  try {
    await assert.rejects(
      buildFrontend({
        repoRoot: fx.root,
        webDistDir: fx.dist,
        log: (level, message) => fx.lines.push(`[${level}] ${message}`),
        spawnFn: (): ChildProcess => {
          const child = new EventEmitter() as EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
            kill: () => boolean;
          };
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = (): boolean => true;
          setImmediate(() => child.emit('error', new Error('spawn EACCES')));
          return child as unknown as ChildProcess;
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof RestartRefusal);
        assert.equal(err.refusal, REFUSED_BUILD);
        assert.match(err.message, /could not run vite: .*spawn EACCES/);
        return true;
      },
    );
    assert.ok(
      fx.lines.some((l) => l.startsWith('[error]') && l.includes('could not run vite')),
      `the reason is one error line: ${fx.lines.join(' | ')}`,
    );
    assert.equal(
      readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
      '{"id":"20260101-0000-oldold0"}',
      'the app the user is looking at is untouched',
    );
    assert.ok(!existsSync(join(fx.root, 'web', 'dist-next')), 'and nothing is staged');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: when the restore ALSO fails, the loud both-renames-failed line is printed', async () => {
  // The worst outcome in the feature: dist is already at dist-prev, the new
  // build cannot be moved in, AND putting the old one back fails too. The line
  // that names it is the only thing standing between the user and a silently
  // empty web/dist, so it is asserted rather than assumed.
  //
  // Staging it needs two failures. The first: the verified output vanishes
  // (same sabotage as the restore-works test). The second: something occupies
  // web/dist as a NON-EMPTY directory before the restore runs — rename(2) onto
  // a non-empty directory is ENOTEMPTY. The only code that runs between the two
  // is the injected logger, which is exactly where a real racing process would
  // have fitted, so the squatter is created from there.
  const fx = buildFixture();
  const nextDir = join(fx.root, 'web', 'dist-next');
  const prevDir = join(fx.root, 'web', 'dist-prev');
  try {
    const opts = {
      repoRoot: fx.root,
      webDistDir: fx.dist,
      log: (level: 'debug' | 'info' | 'warn' | 'error', message: string): void => {
        fx.lines.push(`[${level}] ${message}`);
        if (message.includes('could not move the new frontend into place')) {
          mkdirSync(join(fx.dist, 'assets'), { recursive: true });
          writeFileSync(join(fx.dist, 'assets', 'squatter.js'), '//');
        }
      },
      spawnFn: fakeVite({
        code: 0,
        write: (outDir: string) => writeBuild(outDir, '20260908-1200-newnew1'),
      }),
    };
    await buildFrontend(opts);
    rmSync(nextDir, { recursive: true, force: true });
    assert.throws(
      () => swapFrontend(opts),
      (err: unknown) =>
        err instanceof RestartRefusal &&
        err.refusal === REFUSED_BUILD &&
        err.message === 'the new build could not be moved into place',
    );
    assert.ok(
      fx.lines.some((l) => l.startsWith('[error]') && l.includes('and the OLD frontend could not be restored')),
      `the both-failed line is written at error level: ${fx.lines.join(' | ')}`,
    );
    // And the old build is still ON DISK, not deleted: dist-prev is what a
    // human (or the next restart) can put back by hand.
    assert.ok(existsSync(prevDir), 'dist-prev survives a failed restore — nothing was destroyed');
    assert.equal(
      readFileSync(join(prevDir, 'build-id.json'), 'utf8').trim(),
      '{"id":"20260101-0000-oldold0"}',
      'and it is the old build, intact',
    );
    assert.ok(!existsSync(nextDir), 'the staged output is still cleaned up');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('the staging directories a restart creates are gitignored — a crashed restart leaves no commit bait', () => {
  // web/dist-next lives for the length of a build (up to 120 s) and web/dist-prev
  // for the length of two renames; a restart that dies in between leaves one on
  // disk. Neither is ever committed — and an ignored path is the only thing that
  // keeps `git status` honest for the developer who looks right after a crash.
  const ignore = readFileSync(join(projectRoot, '.gitignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim());
  for (const entry of ['web/dist/', 'web/dist-next/', 'web/dist-prev/']) {
    assert.ok(ignore.includes(entry), `.gitignore must list ${entry}: ${ignore.join(' | ')}`);
  }
});

// ---------------------------------------------------------------------------
// 1d. createStandbyStarter — the parent side of the IPC handshake
// ---------------------------------------------------------------------------
//
// This glue used to live inline in server/index.ts, where it could only be
// exercised by spawning a real backend: a 20 s ready timeout, a child dying at
// the wrong moment and a `send` on a closed channel are all states that are
// expensive or impossible to stage that way. It is a factory with an injected
// `spawn` now, so every one of them is a few lines here.

/** A ChildProcess stand-in: nothing is spawned, every call is recorded. */
function fakeChild(): ChildProcess & {
  sent: unknown[];
  killed: string[];
  disconnects: number;
  unrefs: number;
  connectedFlag: boolean;
} {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child['pid'] = 31337;
  child['sent'] = [];
  child['killed'] = [];
  child['disconnects'] = 0;
  child['unrefs'] = 0;
  child['connectedFlag'] = true;
  Object.defineProperty(child, 'connected', { get: () => child['connectedFlag'] });
  child['send'] = (message: unknown, cb?: (err: Error | null) => void): boolean => {
    if (child['connectedFlag'] !== true) {
      cb?.(new Error('ERR_IPC_CHANNEL_CLOSED'));
      return false;
    }
    (child['sent'] as unknown[]).push(message);
    cb?.(null);
    return true;
  };
  child['kill'] = (signal?: string): boolean => {
    (child['killed'] as string[]).push(signal ?? 'SIGTERM');
    return true;
  };
  child['disconnect'] = (): void => {
    child['disconnects'] = (child['disconnects'] as number) + 1;
  };
  child['unref'] = (): void => {
    child['unrefs'] = (child['unrefs'] as number) + 1;
  };
  return child as unknown as ChildProcess & {
    sent: unknown[];
    killed: string[];
    disconnects: number;
    unrefs: number;
    connectedFlag: boolean;
  };
}

/** A starter over one fake child, with the spawn arguments captured. */
function standbyHarness(over: { readyTimeoutMs?: number } = {}): {
  start: (env: { portHint: number; restartedFrom: number }) => Promise<StandbyChild>;
  child: ReturnType<typeof fakeChild>;
  spawns: { cmd: string; args: string[]; opts: Record<string, unknown> }[];
  lines: string[];
} {
  const child = fakeChild();
  const spawns: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const lines: string[] = [];
  const start = createStandbyStarter({
    entry: '/repo/server/index.ts',
    cwd: '/repo',
    log: (level, message) => lines.push(`[${level}] ${message}`),
    spawnFn: (cmd, args, opts) => {
      spawns.push({ cmd, args, opts: opts as unknown as Record<string, unknown> });
      return child;
    },
    ...(over.readyTimeoutMs !== undefined ? { readyTimeoutMs: over.readyTimeoutMs } : {}),
  });
  return { start, child, spawns, lines };
}

test('standby starter: spawns this node binary with an argv array, an ipc channel and the handoff env', async () => {
  const h = standbyHarness();
  const pending = h.start({ portHint: 41000, restartedFrom: 4242 });
  const spawn0 = h.spawns[0];
  assert.ok(spawn0 !== undefined, 'exactly one spawn');
  assert.equal(spawn0.cmd, process.execPath, 'never a shell, never a PATH lookup');
  assert.deepEqual(spawn0.args, ['/repo/server/index.ts']);
  assert.equal(spawn0.opts['cwd'], '/repo');
  assert.equal(spawn0.opts['detached'], true);
  assert.deepEqual(spawn0.opts['stdio'], ['ignore', 'ignore', 'ignore', 'ipc']);
  const env = spawn0.opts['env'] as Record<string, string>;
  assert.equal(env['AI_SM_PORT_HINT'], '41000');
  assert.equal(env['AI_SM_RESTARTED_FROM'], '4242');
  assert.equal(env['AI_SM_STANDBY'], '1');

  h.child.emit('message', { type: 'standby-ready' });
  const standby = await within(pending, 'standby-ready');
  assert.equal(standby.pid, 31337);
  assert.equal(standby.dead(), false);

  standby.go();
  assert.deepEqual(h.child.sent, [{ type: 'go' }], 'the handoff is one message, nothing else');
  assert.equal(h.child.disconnects, 1, 'and the channel is closed after it is written');
  assert.equal(h.child.unrefs, 1, 'the child is unref\'d: it outlives us');
});

test('standby starter: a message that is not exactly `standby-ready` is ignored, not obeyed', async () => {
  const h = standbyHarness({ readyTimeoutMs: 60 });
  const pending = h.start({ portHint: 41000, restartedFrom: 4242 });
  for (const junk of [null, 'standby-ready', 42, { type: 'standby-readyish' }, { type: 42 }, {}]) {
    h.child.emit('message', junk);
  }
  await assert.rejects(
    within(pending, 'the starter'),
    /did not report ready within 60ms/,
    'none of that counted as a report',
  );
  assert.deepEqual(h.child.killed, ['SIGTERM'], 'and the timed-out standby is killed, not left running');
});

test('standby starter: a child that exits BEFORE ready rejects with the exit status', async () => {
  const h = standbyHarness();
  const pending = h.start({ portHint: 41000, restartedFrom: 4242 });
  h.child.emit('exit', 1, null);
  await assert.rejects(within(pending, 'the starter'), /exited early \(code=1 signal=null\)/);
  assert.deepEqual(h.child.killed, ['SIGTERM'], 'the kill is unconditional: a half-dead child must not linger');
});

test('standby starter: a spawn error before ready rejects, and never resolves later', async () => {
  const h = standbyHarness();
  const pending = h.start({ portHint: 41000, restartedFrom: 4242 });
  h.child.emit('error', new Error('EACCES'));
  await assert.rejects(within(pending, 'the starter'), /could not be spawned/);
  // A late report must not resurrect a settled promise.
  h.child.emit('message', { type: 'standby-ready' });
});

test('standby starter: a death AFTER ready sets dead() and makes go() throw SYNCHRONOUSLY', async () => {
  // The 2026-09-08 finding: `go` reported its failure only in the async send
  // callback, so the caller waited out the full takeover timeout for a backend
  // that no longer existed.
  for (const die of [
    (c: ReturnType<typeof fakeChild>): void => void c.emit('exit', 0, null),
    (c: ReturnType<typeof fakeChild>): void => void c.emit('disconnect'),
    (c: ReturnType<typeof fakeChild>): void => void c.emit('error', new Error('EPIPE')),
  ]) {
    const h = standbyHarness();
    const pending = h.start({ portHint: 41000, restartedFrom: 4242 });
    h.child.emit('message', { type: 'standby-ready' });
    const standby = await within(pending, 'standby-ready');
    assert.equal(standby.dead(), false, 'alive until it is not');

    die(h.child);
    assert.equal(standby.dead(), true, 'the death is visible BEFORE the teardown');
    assert.throws(() => standby.go(), /died before the handoff/, 'and go() refuses at once');
    assert.deepEqual(h.child.sent, [], 'nothing was written into a dead channel');
    assert.ok(
      h.lines.some((l) => l.startsWith('[warn]') && l.includes('gone before the handoff')),
      `the log names it: ${h.lines.join(' | ')}`,
    );
  }
});

test('standby starter: a closed channel makes go() throw instead of failing in a callback', async () => {
  const h = standbyHarness();
  const pending = h.start({ portHint: 41000, restartedFrom: 4242 });
  h.child.emit('message', { type: 'standby-ready' });
  const standby = await within(pending, 'standby-ready');

  h.child.connectedFlag = false; // Closed, but no event fired yet.
  assert.equal(standby.dead(), false, 'nothing has told us it died');
  assert.throws(() => standby.go(), /closed the ipc channel/);
  assert.deepEqual(h.child.sent, []);
});

test('standby starter: stop() kills a standby a later refusal decided not to use', async () => {
  const h = standbyHarness();
  const pending = h.start({ portHint: 41000, restartedFrom: 4242 });
  h.child.emit('message', { type: 'standby-ready' });
  const standby = await within(pending, 'standby-ready');

  standby.stop();
  assert.deepEqual(h.child.killed, ['SIGTERM']);
  // Our own kill must not be reported as a surprise death.
  h.child.emit('exit', null, 'SIGTERM');
  assert.ok(
    !h.lines.some((l) => l.includes('gone before the handoff')),
    `a kill we asked for is not a death to warn about: ${h.lines.join(' | ')}`,
  );
});

// ---------------------------------------------------------------------------
// 2. The route: auth parity and the wire shapes, with a FAKE runner
// ---------------------------------------------------------------------------

interface RouteCtx {
  port: number;
  token: string;
  calls: number;
  /** The `keepSocket` argument of every request() the route made. */
  sockets: (Duplex | undefined)[];
}

/** A real http server wired to the real request handler and a scripted runner. */
async function withRoute(
  outcome: RestartOutcome | (() => RestartOutcome) | 'no-runner',
  fn: (ctx: RouteCtx) => Promise<void>,
): Promise<void> {
  const dir = tempDir();
  const log = createLogger(join(dir, 'server.log'), 'debug');
  const token = 'c'.repeat(64);
  const history = new SessionHistory(join(dir, 'history.json'), log);
  const sessions = new SessionManager(log, history);
  const ctx: RouteCtx = { port: 0, token, calls: 0, sockets: [] };
  const runner: RestartRunner | undefined =
    outcome === 'no-runner'
      ? undefined
      : {
          inProgress: false,
          request: (keepSocket?: Duplex) => {
            ctx.calls += 1;
            ctx.sockets.push(keepSocket);
            return Promise.resolve(typeof outcome === 'function' ? outcome() : outcome);
          },
        };
  let boundPort = 0;
  const server: Server = createServer(
    createRequestHandler({
      token,
      getPort: () => boundPort,
      getStartedAt: () => '2026-09-06T12:00:00.000Z',
      projects: new ProjectStore(join(dir, 'projects.json'), log),
      prefs: new PrefsStore(join(dir, 'prefs.json'), log),
      sessions,
      history,
      github: new GithubConnection({
        file: join(dir, 'github.json'),
        log,
        clientId: undefined,
        apiBase: 'https://api.github.com',
      }),
      webDistDir: join(dir, 'dist'),
      ...(runner === undefined ? {} : { restart: runner }),
      log,
      allowRefusalLine: createRefusalLimiter(scoped(log, 'http')),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  boundPort = (server.address() as { port: number }).port;
  ctx.port = boundPort;
  let bodyThrew = false;
  try {
    await fn(ctx);
  } catch (err) {
    bodyThrew = true;
    throw err;
  } finally {
    // destroyAll() only kills the ptys; their exit handlers write server.log a
    // few ticks later and would race the rm() below (ENOTEMPTY).
    // A settle TIMEOUT must never replace the body's error: without this, a
    // failed assertion is reported as a teardown timeout and the real failure
    // is invisible.
    // Stashed, not thrown here: a throw inside `finally` would skip the two
    // cleanups below, leaking the listener (so `node --test` never drains) and
    // the temp dir. It is rethrown after them.
    let settleErr: { err: unknown } | undefined;
    try {
      await destroyAllAndSettle(sessions, join(dir, 'server.log'));
    } catch (err) {
      if (bodyThrew) console.error(err);
      else settleErr = { err };
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(dir);
    if (settleErr) throw settleErr.err;
  }
}

const OK_202: RestartOutcome = {
  status: 202,
  body: { port: 5555, startedAt: '2026-09-06T12:00:05.000Z', samePort: true },
  onFlushed: null,
};

test('POST /api/restart: no token is 401 and NOTHING is restarted', async () => {
  await withRoute(OK_202, async (ctx) => {
    const res = await rawRequest(ctx.port, { method: 'POST', path: '/api/restart' });
    assert.equal(res.status, 401);
    assert.deepEqual(JSON.parse(res.body), { error: 'unauthorized' });
    assert.equal(ctx.calls, 0, 'the mechanism is never even reached');
  });
});

test('POST /api/restart: a foreign Origin and a foreign Host are 403 before the token is looked at', async () => {
  await withRoute(OK_202, async (ctx) => {
    const evilOrigin = await rawRequest(ctx.port, {
      method: 'POST',
      path: '/api/restart',
      headers: { 'x-auth-token': ctx.token, origin: 'http://evil.example' },
    });
    assert.equal(evilOrigin.status, 403);
    assert.deepEqual(JSON.parse(evilOrigin.body), { error: 'forbidden origin' });

    const evilHost = await rawRequest(ctx.port, {
      method: 'POST',
      path: '/api/restart',
      headers: { 'x-auth-token': ctx.token, host: 'evil.example' },
    });
    assert.equal(evilHost.status, 403);
    assert.deepEqual(JSON.parse(evilHost.body), { error: 'forbidden host' });
    assert.equal(ctx.calls, 0, 'a cross-origin page can never spawn a backend');
  });
});

test('POST /api/restart: GET is 405; the 202 body is exactly {port,startedAt,samePort} and holds no token', async () => {
  await withRoute(OK_202, async (ctx) => {
    const get = await rawRequest(ctx.port, {
      path: '/api/restart',
      headers: { 'x-auth-token': ctx.token },
    });
    assert.equal(get.status, 405);
    assert.equal(ctx.calls, 0);

    const res = await rawRequest(ctx.port, {
      method: 'POST',
      path: '/api/restart',
      headers: { 'x-auth-token': ctx.token },
    });
    assert.equal(res.status, 202);
    assert.deepEqual(JSON.parse(res.body), {
      port: 5555,
      startedAt: '2026-09-06T12:00:05.000Z',
      samePort: true,
    });
    // The process exits right after these bytes. Without `Connection: close`
    // the browser may reuse this very socket for its first GET /health and get
    // an answer from the DYING process, in the window before it exits.
    assert.equal(res.headers['connection'], 'close');
    assert.ok(!res.body.includes(ctx.token), 'the token is NEVER in the restart response');
    assert.equal(ctx.calls, 1);
    // The teardown kills every other connection; without this argument it would
    // kill the one the answer has to travel over, and a successful restart
    // would look like a network failure in the UI.
    assert.equal(ctx.sockets.length, 1);
    const kept = ctx.sockets[0];
    assert.ok(kept !== undefined, 'the route hands its own connection down to be spared');
    assert.equal(typeof (kept as unknown as { destroy?: unknown }).destroy, 'function', 'and it is a real socket');
  });
});

test('POST /api/restart: the 409 and 500 outcomes reach the wire verbatim', async () => {
  await withRoute(
    { status: 409, body: { error: RESTART_IN_PROGRESS }, onFlushed: null },
    async (ctx) => {
      const res = await rawRequest(ctx.port, {
        method: 'POST',
        path: '/api/restart',
        headers: { 'x-auth-token': ctx.token },
      });
      assert.equal(res.status, 409);
      assert.deepEqual(JSON.parse(res.body), { error: 'restart already in progress' });
      // 409 changed nothing: this process stays, so its connection may stay too.
      assert.notEqual(res.headers['connection'], 'close');
    },
  );
  await withRoute(
    { status: 500, body: { error: 'restart failed: nope; relaunch from the desktop shortcut' }, onFlushed: null },
    async (ctx) => {
      const res = await rawRequest(ctx.port, {
        method: 'POST',
        path: '/api/restart',
        headers: { 'x-auth-token': ctx.token },
      });
      assert.equal(res.status, 500);
      assert.deepEqual(JSON.parse(res.body), {
        error: 'restart failed: nope; relaunch from the desktop shortcut',
      });
      // A failed handoff exits too — same socket rule as the 202.
      assert.equal(res.headers['connection'], 'close');
    },
  );
});

test('POST /api/restart: a 422 refusal reaches the wire verbatim and KEEPS the connection alive', async () => {
  // A refusal is the one non-202 answer after which this process goes on
  // serving. Marking that socket `close` would be a lie about a backend that
  // never moved — and the UI's very next act on a refusal is to resume its
  // polls over exactly these keep-alive connections.
  for (const refusal of [REFUSED_DEPENDENCIES, REFUSED_BUILD, REFUSED_STANDBY]) {
    await withRoute({ status: 422, body: { error: refusal }, onFlushed: null }, async (ctx) => {
      const res = await rawRequest(ctx.port, {
        method: 'POST',
        path: '/api/restart',
        headers: { 'x-auth-token': ctx.token },
      });
      assert.equal(res.status, 422, refusal);
      assert.deepEqual(JSON.parse(res.body), { error: refusal }, 'the server sentence, byte for byte');
      assert.notEqual(res.headers['connection'], 'close', 'nothing was torn down: the socket lives on');
      assert.ok(!res.body.includes(ctx.token), 'and no token, on any status');
      assert.equal(ctx.calls, 1);
    });
  }
});

test('POST /api/restart: a 422 outcome must never carry an exit hook — the route would kill a healthy process', async () => {
  // Defence in depth for the wiring itself: api.ts passes `outcome.onFlushed`
  // straight into res.end() for every status. A refusal that arrived with a
  // hook would exit a backend that refused precisely in order to stay alive.
  let exits = 0;
  await withRoute(
    { status: 422, body: { error: REFUSED_BUILD }, onFlushed: () => (exits += 1) },
    async (ctx) => {
      const res = await rawRequest(ctx.port, {
        method: 'POST',
        path: '/api/restart',
        headers: { 'x-auth-token': ctx.token },
      });
      assert.equal(res.status, 422);
    },
  );
  // The controller is the side that guarantees this (`onFlushed: null` on 422);
  // the assertion below is what pins that guarantee at the CONTROLLER, where it
  // belongs, rather than trusting the route to second-guess it.
  const refused = await harness({ depsReady: false }).controller.request();
  assert.equal(refused.status, 422);
  assert.equal(refused.onFlushed, null, 'a 422 hands the route nothing that could exit');
  assert.equal(exits, 1, 'and if it ever did, the route WOULD call it — hence the rule above');
});

test('POST /api/restart: a process with no restart mechanism answers 503, never a fake 202', async () => {
  // Unit harnesses build the request handler without a runner (ApiDeps.restart
  // is optional). Such a process must SAY it cannot restart — a 202 there would
  // leave the UI polling /health for a backend nobody ever replaced.
  await withRoute('no-runner', async (ctx) => {
    const res = await rawRequest(ctx.port, {
      method: 'POST',
      path: '/api/restart',
      headers: { 'x-auth-token': ctx.token },
    });
    assert.equal(res.status, 503);
    assert.deepEqual(JSON.parse(res.body), { error: 'restart is not available in this process' });
  });
});

test('POST /api/restart: a body is IGNORED, never parsed — no route to a 400 from attacker JSON', async () => {
  await withRoute(OK_202, async (ctx) => {
    const res = await rawRequest(ctx.port, {
      method: 'POST',
      path: '/api/restart',
      headers: { 'x-auth-token': ctx.token, 'content-type': 'application/json' },
      body: '{ this is not json at all',
    });
    assert.equal(res.status, 202, 'the body never reaches a parser');
    assert.equal(ctx.calls, 1);
  });
});

// ---------------------------------------------------------------------------
// 2b. The update reason on the wire: GET /api/runtime
// ---------------------------------------------------------------------------
//
// tests/buildinfo.test.ts proves the CHECKER picks the right reason; the UI
// tests prove each reason maps to a plain sentence. What is untested in between
// is the wire: the reason string is a contract between the two, so it must
// reach the browser byte-for-byte, under the key the UI reads, with no
// remapping and no summarising on the way out.

/** A minimal checkout the real update checker can be pointed at. */
function updateRepoFixture(): { root: string; webDist: string; startedAt: string; startedMs: number } {
  const root = tempDir();
  const startedMs = Date.UTC(2026, 8, 6, 12, 0, 0);
  mkdirSync(join(root, 'server'), { recursive: true });
  mkdirSync(join(root, 'shared'), { recursive: true });
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  mkdirSync(join(root, 'web', 'src'), { recursive: true });
  mkdirSync(join(root, 'web', 'dist', 'assets'), { recursive: true });
  writeFileSync(join(root, 'server', 'index.ts'), 'server\n');
  writeFileSync(join(root, 'shared', 'protocol.ts'), 'types\n');
  writeFileSync(join(root, 'package-lock.json'), '{}\n');
  writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}\n');
  writeFileSync(join(root, 'web', 'src', 'main.ts'), 'ui\n');
  writeFileSync(join(root, 'web', 'index.html'), '<!doctype html>\n');
  writeFileSync(join(root, 'vite.config.ts'), 'config\n');
  writeFileSync(join(root, 'web', 'dist', 'index.html'), '<!doctype html>\n');
  writeFileSync(join(root, 'web', 'dist', 'assets', 'index-AAAAAAAA.js'), 'bundle\n');
  writeFileSync(join(root, 'web', 'dist', 'build-id.json'), '{"id":"20260908-1200-aaaaaaa"}\n');
  // Everything older than the run; the build newer than the sources it came
  // from. That is an up-to-date checkout: no reason, nothing to report.
  const old = new Date(startedMs - 60_000);
  for (const rel of [
    ['server', 'index.ts'],
    ['shared', 'protocol.ts'],
    ['package-lock.json'],
    ['node_modules', '.package-lock.json'],
    ['vite.config.ts'],
    ['web', 'index.html'],
    ['web', 'src', 'main.ts'],
    ['web', 'dist', 'index.html'],
    ['web', 'dist', 'assets', 'index-AAAAAAAA.js'],
  ]) {
    utimesSync(join(root, ...rel), old, old);
  }
  const built = new Date(startedMs - 30_000);
  utimesSync(join(root, 'web', 'dist', 'build-id.json'), built, built);
  return {
    root,
    webDist: join(root, 'web', 'dist'),
    startedAt: new Date(startedMs).toISOString(),
    startedMs,
  };
}

/** A real http server whose /api/runtime is fed by `checkUpdate`. */
async function withRuntimeRoute(
  checkUpdate: (() => { available: boolean; reason: string | null }) | undefined,
  startedAt: string,
  fn: (ctx: { port: number; token: string }) => Promise<void>,
): Promise<void> {
  const dir = tempDir();
  const log = createLogger(join(dir, 'server.log'), 'debug');
  const token = 'd'.repeat(64);
  const history = new SessionHistory(join(dir, 'history.json'), log);
  const sessions = new SessionManager(log, history);
  let boundPort = 0;
  const server: Server = createServer(
    createRequestHandler({
      token,
      getPort: () => boundPort,
      getStartedAt: () => startedAt,
      projects: new ProjectStore(join(dir, 'projects.json'), log),
      prefs: new PrefsStore(join(dir, 'prefs.json'), log),
      sessions,
      history,
      github: new GithubConnection({
        file: join(dir, 'github.json'),
        log,
        clientId: undefined,
        apiBase: 'https://api.github.com',
      }),
      webDistDir: join(dir, 'dist'),
      ...(checkUpdate === undefined ? {} : { checkUpdate }),
      log,
      allowRefusalLine: createRefusalLimiter(scoped(log, 'http')),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  boundPort = (server.address() as { port: number }).port;
  let bodyThrew = false;
  try {
    await fn({ port: boundPort, token });
  } catch (err) {
    bodyThrew = true;
    throw err;
  } finally {
    // Same late-writer race as the other in-process harness: wait for the pty
    // exit lines before the dir goes away.
    // A settle TIMEOUT must never replace the body's error: without this, a
    // failed assertion is reported as a teardown timeout and the real failure
    // is invisible.
    // Stashed, not thrown here: a throw inside `finally` would skip the two
    // cleanups below, leaking the listener (so `node --test` never drains) and
    // the temp dir. It is rethrown after them.
    let settleErr: { err: unknown } | undefined;
    try {
      await destroyAllAndSettle(sessions, join(dir, 'server.log'));
    } catch (err) {
      if (bodyThrew) console.error(err);
      else settleErr = { err };
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(dir);
    if (settleErr) throw settleErr.err;
  }
}

test('GET /api/runtime: each of the three frontend update reasons reaches the wire VERBATIM', async () => {
  // Not a stub: the REAL checker over a real checkout, sabotaged three ways.
  for (const [what, sabotage, expected] of [
    [
      'no build-id.json',
      (fx: ReturnType<typeof updateRepoFixture>): void =>
        rmSync(join(fx.webDist, 'build-id.json')),
      'frontend build missing',
    ],
    [
      'web/dist rebuilt after this process started',
      (fx: ReturnType<typeof updateRepoFixture>): void => {
        const when = new Date(fx.startedMs + 60_000);
        utimesSync(join(fx.webDist, 'index.html'), when, when);
      },
      'frontend rebuilt',
    ],
    [
      'a pulled web/src newer than the build',
      (fx: ReturnType<typeof updateRepoFixture>): void => {
        // Newer than build-id.json (started-30s), still older than startedAt,
        // so it can only be the SOURCE reason, never `rebuilt`.
        const when = new Date(fx.startedMs - 10_000);
        utimesSync(join(fx.root, 'web', 'src', 'main.ts'), when, when);
      },
      'frontend source changed',
    ],
  ] as [string, (fx: ReturnType<typeof updateRepoFixture>) => void, string][]) {
    const fx = updateRepoFixture();
    try {
      sabotage(fx);
      const checkUpdate = createUpdateChecker({
        repoRoot: fx.root,
        serverDir: join(fx.root, 'server'),
        sharedDir: join(fx.root, 'shared'),
        webDistDir: fx.webDist,
        bootCommit: null,
        bootAsset: () => 'assets/index-AAAAAAAA.js',
        startedAt: () => fx.startedAt,
      });
      await withRuntimeRoute(checkUpdate, fx.startedAt, async (ctx) => {
        const res = await rawRequest(ctx.port, {
          path: '/api/runtime',
          headers: { 'x-auth-token': ctx.token },
        });
        assert.equal(res.status, 200, what);
        const body = JSON.parse(res.body) as RuntimeStatusResponse;
        assert.deepEqual(
          body.update,
          { available: true, reason: expected },
          `${what}: the raw reason string is what the UI maps to a sentence`,
        );
      });
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }
});

test('GET /api/runtime: an up-to-date checkout, and a backend with no checker at all, both report NO update', async () => {
  // The notice must never cry wolf, and a process wired without a checker must
  // answer the honest default rather than omitting the key (the UI reads it
  // unconditionally).
  const fx = updateRepoFixture();
  try {
    const checkUpdate = createUpdateChecker({
      repoRoot: fx.root,
      serverDir: join(fx.root, 'server'),
      sharedDir: join(fx.root, 'shared'),
      webDistDir: fx.webDist,
      bootCommit: null,
      bootAsset: () => 'assets/index-AAAAAAAA.js',
      startedAt: () => fx.startedAt,
    });
    await withRuntimeRoute(checkUpdate, fx.startedAt, async (ctx) => {
      const res = await rawRequest(ctx.port, {
        path: '/api/runtime',
        headers: { 'x-auth-token': ctx.token },
      });
      assert.deepEqual((JSON.parse(res.body) as RuntimeStatusResponse).update, { available: false, reason: null });
    });
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
  await withRuntimeRoute(undefined, '2026-09-06T12:00:00.000Z', async (ctx) => {
    const res = await rawRequest(ctx.port, {
      path: '/api/runtime',
      headers: { 'x-auth-token': ctx.token },
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body) as RuntimeStatusResponse;
    assert.deepEqual(body.update, { available: false, reason: null }, 'the key is always there');
  });
});

// ---------------------------------------------------------------------------
// 3. One REAL restart, end to end, on a scratch data dir
// ---------------------------------------------------------------------------

/** Read a runtime.json straight from disk (the launcher's own view). */
function readRuntime(file: string): RuntimeInfo | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RuntimeInfo;
  } catch {
    return undefined;
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('REAL restart: same port, new pid, old pid gone, runtime.json owned by the child, sessions stamped shutdown', async () => {
  // The restart rebuilds and swaps the frontend it SERVES; point it at a copy so
  // this test never touches the repo's own web/dist (asserted at the end).
  const web = webDistCopy();
  const repoDistBefore = repoWebDist();
  const server = await startTestServer({ env: { AI_SM_WEB_DIST_DIR: web.served } });
  const oldPid = server.child.pid as number;
  let childPid: number | undefined;
  try {
    // A real PTY session and a presence window, so the handoff has something to
    // end and someone to say goodbye to.
    const session = await createSession(server, {
      cwd: '/tmp',
      command: 'bash',
      args: ['-i'],
      title: 'restart-victim',
      cols: 80,
      rows: 24,
    });
    const presence = await WsClient.connect(presenceUrl(server));

    // runtime.json must be present at EVERY instant of the handoff, not merely
    // at the end: the parent tears down before it spawns, and an unlink there
    // would leave a window in which the launcher sees no backend and starts a
    // second one. The child recreates the file, so a check taken afterwards
    // cannot tell the difference — hence a monitor that samples throughout.
    // (A false PASS needs the sampler to miss a ~200 ms window; a false FAIL is
    // impossible: an absent file IS the violation.)
    let everAbsent = false;
    let samples = 0;
    let stopMonitor = false;
    const monitor = (async (): Promise<void> => {
      while (!stopMonitor) {
        samples += 1;
        if (!existsSync(server.runtimeFile)) {
          everAbsent = true;
          return;
        }
        await delay(1);
      }
    })();

    const res = await api(server, 'POST', '/api/restart');
    assert.equal(res.status, 202, `restart must be accepted: ${JSON.stringify(res.body)}`);
    const body = res.body as RestartResponse;
    assert.deepEqual(Object.keys(body).sort(), ['port', 'samePort', 'startedAt']);
    assert.equal(body.samePort, true, 'the hinted port must be taken back (the host window is locked to it)');
    assert.equal(body.port, server.port, 'and it is the SAME port the UI is talking to');
    assert.ok(!JSON.stringify(body).includes(server.token), 'no token in the handoff body');

    // The child owns runtime.json now — the restart path must NOT unlink it.
    const child = await waitUntil(
      () => {
        const rt = readRuntime(server.runtimeFile);
        return rt !== undefined && rt.pid !== oldPid ? rt : undefined;
      },
      "runtime.json to name the child's pid",
    );
    childPid = child.pid;
    assert.equal(child.port, server.port, "the child's own file agrees on the port");
    assert.equal(child.startedAt, body.startedAt, 'the 202 quoted the child, not itself');
    assert.notEqual(child.token, server.token, 'the child generated a FRESH token');
    stopMonitor = true;
    await monitor;
    assert.ok(samples > 50, `the monitor must actually have sampled the handoff (${samples} samples)`);
    assert.equal(everAbsent, false, 'runtime.json is never unlinked by a restart, not even for an instant');
    assert.ok(existsSync(server.runtimeFile), 'and it is there at the end too');

    // The old process is gone, exit code 0.
    const exit = await Promise.race([server.exit, delay(15_000).then(() => undefined)]);
    assert.ok(exit !== undefined, 'the old process must exit after handing over');
    assert.equal(exit.code, 0, `a handoff is a clean exit (code=${exit.code} signal=${exit.signal})`);
    assert.equal(isAlive(oldPid), false, 'the old pid is really gone');

    // The presence socket was told it is a restart, not an error.
    await waitUntil(() => (presence.closed ? true : undefined), 'the presence socket to close');
    assert.equal(presence.closeInfo?.code, 1012, 'presence closes 1012 "service restart"');
    assert.equal(presence.closeInfo?.reason, 'service restart');

    // The child serves on the same port, with its own token.
    const health = await fetch(`http://127.0.0.1:${child.port}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), '{"ok":true}');
    const stale = await fetch(`http://127.0.0.1:${child.port}/api/history`, {
      headers: { 'x-auth-token': server.token },
    });
    assert.equal(stale.status, 401, 'the OLD token is worthless against the new process');

    // The killed session is in HISTORY, stamped 'shutdown' — resumable exactly
    // like after a normal shutdown. (No 'restart' end reason exists, by design.)
    const listed = await fetch(`http://127.0.0.1:${child.port}/api/history`, {
      headers: { 'x-auth-token': child.token },
    });
    assert.equal(listed.status, 200);
    const entries = (await listed.json()) as HistoryEntry[];
    const entry = entries.find((e) => e.title === 'restart-victim');
    assert.ok(entry !== undefined, `the session must be in history: ${JSON.stringify(entries)}`);
    assert.equal(entry.ended?.reason, 'shutdown', 'the same stamp a normal shutdown leaves');
    assert.ok(entry.id === session.id || entry.id.length > 0);

    // The child SERVES the freshly built screens and knows it does: it reads
    // web/dist at `go`, not at module load (the parent swapped it in while the
    // child was waiting). Without that, /api/runtime would name the OLD bundle
    // and the update check would light the pill on a backend restarted seconds
    // ago — the exact symptom the restart button exists to remove.
    const built = readWebBuild(web.served);
    const runtimeRes = await fetch(`http://127.0.0.1:${child.port}/api/runtime`, {
      headers: { 'x-auth-token': child.token },
    });
    assert.equal(runtimeRes.status, 200);
    const runtime = (await runtimeRes.json()) as RuntimeStatusResponse;
    assert.equal(runtime.webBuild, built.asset, 'the child names the bundle it actually serves');
    assert.notEqual(runtime.webBuild, null);
    assert.deepEqual(
      runtime.update,
      { available: false, reason: null },
      `a just-restarted backend has nothing to update to: ${JSON.stringify(runtime.update)}`,
    );

    // The log tells the whole story across both processes.
    const log = await readServerLog(server);
    assert.match(log, /\[restart\] restart requested by the ui: sessions=1 presence=1 attached=0/);
    // The preflight, in order, BEFORE the teardown line.
    assert.match(log, /\[restart\] preflight: dependencies, frontend build, standby backend/);
    assert.match(log, /\[restart\] preflight: dependencies ok/);
    assert.match(
      log,
      /\[restart\] preflight: frontend build ok \(build id [A-Za-z0-9._+-]+, asset assets\/index-[A-Za-z0-9_-]+\.js, \d+ms/,
      'the real vite build is logged by id and asset',
    );
    assert.match(log, /\[restart\] preflight: standby backend ready \(pid \d+\), booted and holding/);
    assert.match(log, /\[boot\] standby: ready, waiting for the handoff from pid \d+/);
    assert.ok(
      log.indexOf('preflight: standby backend ready') < log.indexOf('restart teardown: listener closed'),
      'the standby must be PROVEN before anything is torn down',
    );
    assert.match(log, /restart teardown: listener closed, 1 websocket\(s\) closed 1012/);
    assert.match(log, new RegExp(`\\[restart\\] go sent: new backend spawned \\(pid \\d+\\), port hint ${server.port}`));
    assert.match(log, /\[boot\] standby: handoff received from pid \d+, taking the port/);
    assert.match(log, new RegExp(`\\[boot\\] restarted from pid ${oldPid}`));
    assert.match(log, new RegExp(`\\[boot\\] port hint ${server.port} taken`));
    assert.match(log, /\[restart\] handoff complete: pid \d+ on 127\.0\.0\.1:\d+ \(samePort=true/);
    assert.ok(!log.includes(server.token), 'no token anywhere in the log');
    assert.ok(!log.includes(child.token), 'not the new one either');

    // The real build landed in the COPY, and only there.
    const rebuilt = readWebBuild(web.served);
    assert.ok(rebuilt.buildId !== null && rebuilt.asset !== null, 'the copy holds a complete build');
    assert.ok(!existsSync(join(web.dir, 'dist-next')), 'no staging dir survives a completed restart');
    assert.ok(!existsSync(join(web.dir, 'dist-prev')), 'and no backup either');
    assert.deepEqual(
      repoWebDist(),
      repoDistBefore,
      "the repo's own web/dist is byte-identical: a test run must never rebuild the tree it runs in",
    );
    assert.ok(
      !existsSync(join(projectRoot, 'web', 'dist-next')) &&
        !existsSync(join(projectRoot, 'web', 'dist-prev')),
      'and it leaves no staging dirs in the repo either',
    );
  } finally {
    // Kill the CHILD this test caused, then let the helper clean up the rest.
    const adopted = childPid;
    if (adopted !== undefined && isAlive(adopted)) {
      process.kill(adopted, 'SIGTERM');
      await waitUntil(() => (isAlive(adopted) ? undefined : true), 'the child to exit', 10_000).catch(
        () => process.kill(adopted, 'SIGKILL'),
      );
    }
    await server.stop();
    web.remove();
  }
});

test('AI_SM_WEB_DIST_DIR: a bad value makes the server refuse to start — exit 1, no runtime.json, and it SAYS so in server.log', async () => {
  // The seam names the directory a restart REBUILDS, RENAMES and whose backup
  // it later DELETES, and the one the static-file guard measures paths against.
  //   - relative: resolves against whatever cwd was inherited, so the swap
  //     could rename a directory nobody meant to touch;
  //   - unnormalized ('/x/', '/x/../y', '/'): `startsWith(webDistDir + sep)` in
  //     server/api.ts fails for EVERY asset (a 403 UI), and `<dir>-prev` of a
  //     trailing-slash value is a sibling nobody meant.
  // Refused before listen, publishing nothing — and the REASON goes to
  // server.log, because a detached backend's stderr is /dev/null and the log is
  // the only channel the user has.
  const cases: { value: string; expect: RegExp }[] = [
    { value: 'web/dist', expect: /AI_SM_WEB_DIST_DIR must be an absolute path/ },
    { value: './web/dist', expect: /AI_SM_WEB_DIST_DIR must be an absolute path/ },
    { value: '../dist', expect: /AI_SM_WEB_DIST_DIR must be an absolute path/ },
    { value: '/tmp/x/', expect: /AI_SM_WEB_DIST_DIR must be a normalized absolute directory path/ },
    { value: '/tmp/x/../y', expect: /AI_SM_WEB_DIST_DIR must be a normalized absolute directory path/ },
    { value: '/', expect: /AI_SM_WEB_DIST_DIR must be a normalized absolute directory path/ },
  ];
  for (const { value, expect } of cases) {
    const root = mkdtempSync(join(tmpdir(), 'ai-sm-webdist-refuse-'));
    const dataDir = join(root, 'data');
    try {
      const child = spawn(process.execPath, [join(projectRoot, 'server', 'index.ts')], {
        cwd: projectRoot,
        env: {
          ...process.env,
          AI_SM_DATA_DIR: dataDir,
          AI_SM_WEB_DIST_DIR: value,
          AI_SM_STARTUP_GRACE_MS: '600000',
          AI_SM_GRACE_MS: '600000',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString('utf8');
      });
      // 30 s, not 10: the pass path exits in well under a second, so this only
      // bounds a FAILING mutant — and a 10 s bound flaked once under load, with
      // this refusing boot competing with the real servers this file spawns.
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once('exit', (code, signal) => resolve({ code, signal })),
      );
      clearTimeout(timer);
      assert.equal(exit.code, 1, `${value}: must exit 1 (signal ${exit.signal})`);
      assert.match(stderr, expect, value);
      assert.ok(
        !existsSync(join(dataDir, 'runtime.json')),
        `${value}: a refused start must publish no discovery file`,
      );
      // The line the USER can actually see: stderr is /dev/null in production.
      const logFile = join(dataDir, 'server.log');
      assert.ok(existsSync(logFile), `${value}: the refusal must still have written server.log`);
      const serverLog = readFileSync(logFile, 'utf8');
      assert.match(
        serverLog,
        new RegExp(`\\[error\\] refusing to start: ${expect.source}`),
        `${value}: the reason must reach server.log, not only stderr: ${serverLog}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('AI_SM_PORT_HINT: a busy hint falls back ONCE to an auto-picked port and says so', async () => {
  // Occupy a port, then hand that very port to a fresh backend as its hint.
  const squatter = createNetServer();
  await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  const busyPort = (squatter.address() as { port: number }).port;
  let server: Awaited<ReturnType<typeof startTestServer>> | undefined;
  try {
    server = await startTestServer({ env: { AI_SM_PORT_HINT: String(busyPort) } });
    assert.notEqual(server.port, busyPort, 'it must not have stolen the busy port');
    assert.ok(server.port > 0);

    const health = await fetch(`${server.baseUrl}/health`);
    assert.equal(health.status, 200, 'and it is serving on the auto-picked one');

    const log = await readServerLog(server);
    assert.ok(
      log.includes(`port hint ${busyPort} busy, auto-picked ${server.port}`),
      `the fallback is one explicit line: ${log.split('\n').filter((l) => l.includes('hint')).join(' | ')}`,
    );
    assert.ok(
      log.includes(`listening on 127.0.0.1:${server.port}`),
      'and the usual listening line still names the real port',
    );
  } finally {
    if (server !== undefined) await server.stop();
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  }
});

test('AI_SM_RESTARTED_FROM: a plain pid is printed, anything else is named invalid on ONE line', async () => {
  const ok = await startTestServer({ env: { AI_SM_RESTARTED_FROM: '4242' } });
  try {
    assert.ok((await readServerLog(ok)).includes('restarted from pid 4242'));
  } finally {
    await ok.stop();
  }

  // A log line is a text record: a newline in the value would forge a second,
  // fake line, and free text would let it say whatever it likes.
  const forged = await startTestServer({
    env: { AI_SM_RESTARTED_FROM: '1\n2026-09-06T00:00:00.000Z [error] [restart] handoff failed' },
  });
  try {
    const log = await readServerLog(forged);
    assert.ok(log.includes('restarted from pid <invalid>'), 'a non-pid is never printed as a pid');
    assert.ok(
      !/^\S+ \[error\] \[restart\] handoff failed/m.test(log),
      'and it can never start a line of its own',
    );
  } finally {
    await forged.stop();
  }
});

test('AI_SM_PORT_HINT: a nonsense value is refused loudly and the port is auto-picked', async () => {
  const server = await startTestServer({ env: { AI_SM_PORT_HINT: '99999999' } });
  try {
    assert.ok(server.port > 0 && server.port <= 65_535);
    const log = await readServerLog(server);
    assert.ok(
      log.includes('AI_SM_PORT_HINT must be a port number 1-65535, got "99999999"; auto-picking instead'),
      'the refusal names the rule and the value',
    );
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// 3b. The STANDBY child, driven directly over IPC (no restart, no vite)
// ---------------------------------------------------------------------------
//
// Preflight step 3 spawns `server/index.ts` with AI_SM_STANDBY=1 and an IPC
// channel; the child does the ENTIRE boot except `listen`, answers
// `standby-ready`, and then waits. The whole safety of the feature rests on
// what that child does NOT do while it waits: it must not bind the port, must
// not write runtime.json (the file still describes the LIVE parent), and must
// never outlive the parent that forgot it. Driving it straight over IPC pins
// exactly that, in a second, without a build.

/** A free loopback port, released again before it is handed on as a hint. */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Spawn a standby child exactly the way server/index.ts's startStandby does. */
function spawnStandby(dataDir: string, portHint: number, extraEnv: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, [join(projectRoot, 'server', 'index.ts')], {
    cwd: projectRoot,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: {
      ...process.env,
      AI_SM_DATA_DIR: dataDir,
      AI_SM_STARTUP_GRACE_MS: '600000',
      AI_SM_GRACE_MS: '600000',
      AI_SM_PORT_HINT: String(portHint),
      AI_SM_RESTARTED_FROM: '4242',
      AI_SM_STANDBY: '1',
      ...extraEnv,
    },
  });
}

/** Resolve on the child's first `{type:'standby-ready'}`; reject if it dies first. */
function standbyReady(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.on('message', (message) => {
      if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'standby-ready') {
        resolve();
      }
    });
    child.on('exit', (code, signal) => reject(new Error(`standby exited early (code=${code} signal=${signal})`)));
    child.on('error', (err) => reject(err));
  });
}

/** Resolve with the child's exit, whatever it is. */
function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

test('standby child: reports ready, binds NOTHING, writes NO runtime.json, and leaves when the parent goes away', async () => {
  const dataDir = tempDir();
  const runtimeFile = join(dataDir, 'runtime.json');
  const hint = await freePort();
  const child = spawnStandby(dataDir, hint);
  const exited = exitOf(child);
  try {
    await within(standbyReady(child), 'standby-ready', 30_000);

    // The three things a waiting standby must NOT have done. runtime.json still
    // belongs to the live parent — a child that wrote it here would point the
    // launcher at a process that is listening on nothing.
    assert.ok(!existsSync(runtimeFile), 'runtime.json is the PARENT\'s until the handoff');
    await assert.rejects(
      fetch(`http://127.0.0.1:${hint}/health`),
      'the hinted port is still free: the standby has not bound it',
    );

    // A message that is not the one word it obeys changes nothing. Proven by
    // what follows rather than by a sleep: a child that had taken this as `go`
    // would be listening and would IGNORE the disconnect below instead of
    // exiting on it.
    child.send({ type: 'go-ahead-then' });
    child.send('go');

    child.disconnect();
    const exit = await within(exited, 'the standby to exit on the parent going away', 30_000);
    assert.deepEqual(exit, { code: 0, signal: null }, 'an orphaned standby leaves quietly, code 0');
    assert.ok(!existsSync(runtimeFile), 'and it never wrote a discovery file at all');

    const log = readFileSync(join(dataDir, 'server.log'), 'utf8');
    assert.match(log, /\[boot\] standby: ready, waiting for the handoff from pid 4242/);
    assert.match(log, /\[boot\] standby: the parent went away before the handoff; exiting/);
    assert.ok(!/listening on 127\.0\.0\.1:/.test(log), 'it never listened, and never said it did');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited.catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('standby child: `go` is what makes it take the hinted port and publish runtime.json', async () => {
  const dataDir = tempDir();
  const runtimeFile = join(dataDir, 'runtime.json');
  const hint = await freePort();
  const child = spawnStandby(dataDir, hint);
  const exited = exitOf(child);
  try {
    await within(standbyReady(child), 'standby-ready', 30_000);
    assert.ok(!existsSync(runtimeFile));

    child.send({ type: 'go' });
    const rt = await waitUntil(
      () => {
        const parsed = readRuntime(runtimeFile);
        return parsed !== undefined && typeof parsed.port === 'number' ? parsed : undefined;
      },
      'the standby to publish runtime.json after `go`',
      30_000,
    );
    assert.equal(rt.port, hint, 'it took the hinted port — the host window is locked to it');
    assert.equal(rt.pid, child.pid, 'and the file names this very child');

    const health = await fetch(`http://127.0.0.1:${rt.port}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), '{"ok":true}');

    const log = readFileSync(join(dataDir, 'server.log'), 'utf8');
    assert.match(log, /\[boot\] standby: handoff received from pid 4242, taking the port/);
    assert.match(log, new RegExp(`\\[boot\\] port hint ${hint} taken`));
    assert.ok(!log.includes(rt.token), 'the token is never logged');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await within(exited, 'the standby to stop', 15_000).catch(() => child.kill('SIGKILL'));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('standby child: `go` drops a leftover dist-prev, and waiting NEVER touches it', async () => {
  // The parent drops the swap's backup the moment `go` is out (restart.ts), but
  // a parent that dies in that instant leaves `<dist>-prev` behind forever — a
  // second copy of the whole UI in the tree, and bait for the next restart. So
  // the child commits the swap too (server/index.ts, on `go`).
  //
  // The other half is the one that must NOT happen: while the standby waits,
  // the parent is still whole and can still REFUSE — `revertFrontend` needs
  // that backup to keep the "every 422 leaves web/dist unchanged" promise. A
  // child that tidied up early would destroy the only copy of the old build.
  const web = webDistCopy();
  const prevDir = join(web.dir, 'dist-prev');
  // What a parent's swap leaves behind: the OLD build, moved aside.
  mkdirSync(prevDir, { recursive: true });
  writeFileSync(join(prevDir, 'index.html'), '<!doctype html><title>old</title>\n');
  writeFileSync(join(prevDir, 'build-id.json'), '{"id":"20260908-0000-old0000"}\n');
  const servedBefore = readWebBuild(web.served);

  const dataDir = tempDir();
  const runtimeFile = join(dataDir, 'runtime.json');
  const hint = await freePort();
  const child = spawnStandby(dataDir, hint, { AI_SM_WEB_DIST_DIR: web.served });
  const exited = exitOf(child);
  try {
    await within(standbyReady(child), 'standby-ready', 30_000);
    assert.ok(
      existsSync(prevDir),
      'a WAITING standby leaves the backup alone: the parent can still revert onto it',
    );

    child.send({ type: 'go' });
    // runtime.json is published by beginListening(), which runs AFTER the
    // commit — so this wait is the commit's own happens-before, not a sleep.
    const rt = await waitUntil(
      () => {
        const parsed = readRuntime(runtimeFile);
        return parsed !== undefined && typeof parsed.port === 'number' ? parsed : undefined;
      },
      'the standby to publish runtime.json after `go`',
      30_000,
    );
    assert.equal(rt.port, hint);
    assert.ok(!existsSync(prevDir), 'the handoff commits the swap: no dist-prev survives it');
    assert.deepEqual(
      readWebBuild(web.served),
      servedBefore,
      'and the build it now serves is the swapped-in one, untouched by the cleanup',
    );
    assert.ok(!existsSync(join(web.dir, 'dist-next')), 'nothing staged is invented either');
    assert.ok(
      !existsSync(join(projectRoot, 'web', 'dist-prev')) &&
        !existsSync(join(projectRoot, 'web', 'dist-next')),
      "and the repo's own web/dist keeps no staging dirs",
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await within(exited, 'the standby to stop', 15_000).catch(() => child.kill('SIGKILL'));
    rmSync(dataDir, { recursive: true, force: true });
    web.remove();
  }
});

/**
 * A data dir that looks like a LIVE parent's: its discovery file, a history
 * with a session still running, the settings file that session was launched
 * with, and the status line's cache.
 */
function liveParentDataDir(): { dir: string; snapshot: () => string } {
  const dir = tempDir();
  writeFileSync(
    join(dir, 'runtime.json'),
    JSON.stringify({ port: 41234, token: 'p'.repeat(64), pid: 4242, startedAt: '2026-09-08T10:00:00.000Z' }) + '\n',
  );
  writeFileSync(
    join(dir, 'history.json'),
    JSON.stringify([
      {
        id: '11111111-2222-3333-4444-555555555555',
        sessionId: '11111111-2222-3333-4444-555555555555',
        conversation: true,
        cwd: '/tmp',
        command: 'claude',
        args: [],
        title: 'a session the PARENT is still running',
        createdAt: '2026-09-08T10:00:01.000Z',
        lastUsedAt: '2026-09-08T10:00:01.000Z',
        ended: null,
      },
    ]) + '\n',
  );
  mkdirSync(join(dir, 'session-settings'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'session-settings', '11111111-2222-3333-4444-555555555555.json'), '{"statusLine":{}}\n');
  writeFileSync(join(dir, 'statusline-cache.json'), '{"11111111":{"branch":"main"}}\n');

  /** Everything the parent owns, as one comparable string (content + mtime). */
  const snapshot = (): string => {
    const parts: string[] = [];
    for (const rel of [
      'runtime.json',
      'history.json',
      'statusline-cache.json',
      join('session-settings', '11111111-2222-3333-4444-555555555555.json'),
    ]) {
      const path = join(dir, rel);
      if (!existsSync(path)) {
        parts.push(`${rel}: GONE`);
        continue;
      }
      parts.push(`${rel}: ${statSync(path).mtimeMs} ${readFileSync(path, 'utf8')}`);
    }
    return parts.join('\n');
  };
  return { dir, snapshot };
}

test('standby child: booting touches NOTHING in the parent\'s data dir — history is read, never stamped', async () => {
  // The child boots inside a data dir whose owner is still SERVING. The boot
  // that an ordinary start does — stamp every live history entry 'crash' and
  // rewrite the file, wipe session-settings/, unlink the statusline cache —
  // would rewrite a live process's history and delete the --settings files its
  // running claude sessions are using.
  const parent = liveParentDataDir();
  const before = parent.snapshot();
  const child = spawnStandby(parent.dir, await freePort());
  const exited = exitOf(child);
  try {
    await within(standbyReady(child), 'standby-ready', 30_000);
    assert.equal(parent.snapshot(), before, 'a standby that reported ready has written nothing');

    const log = readFileSync(join(parent.dir, 'server.log'), 'utf8');
    assert.match(
      log,
      /history loaded read-only: 1 entries \(nothing stamped, nothing written\)/,
      `the read-only load is what the log says it is: ${log}`,
    );
    assert.ok(!/stamped 'crash'/.test(log), "and nothing was stamped 'crash'");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited.catch(() => undefined);
    rmSync(parent.dir, { recursive: true, force: true });
  }
});

test('standby child: a SIGTERM before `go` leaves the LIVE parent\'s files exactly as they were', async () => {
  // The parent's own ready-timeout path SIGTERMs the standby. The ordinary
  // shutdown that signal normally runs would unlink runtime.json — the file
  // that describes the parent, which is still serving — and stamp its live
  // sessions 'shutdown'. The launcher would then start a SECOND backend.
  const parent = liveParentDataDir();
  const before = parent.snapshot();
  const child = spawnStandby(parent.dir, await freePort());
  const exited = exitOf(child);
  try {
    await within(standbyReady(child), 'standby-ready', 30_000);
    child.kill('SIGTERM');
    const exit = await within(exited, 'the standby to exit on SIGTERM', 30_000);
    assert.deepEqual(exit, { code: 0, signal: null }, 'it leaves quietly, code 0');

    assert.equal(
      parent.snapshot(),
      before,
      'runtime.json, history.json and session-settings/ are byte-identical, mtimes included',
    );
    const log = readFileSync(join(parent.dir, 'server.log'), 'utf8');
    assert.match(
      log,
      /standby: received SIGTERM before the handoff; exiting without touching the data dir/,
      `the guarded path is the one that ran: ${log}`,
    );
    assert.ok(
      !log.includes('received SIGTERM, shutting down'),
      'never the ordinary shutdown, which unlinks runtime.json',
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited.catch(() => undefined);
    rmSync(parent.dir, { recursive: true, force: true });
  }
});

test('a PTY session never inherits the handoff variables — they describe the BACKEND, not the terminal', async () => {
  // server/sessions.ts spawns with `...process.env`. A session started by a
  // backend that came from a handoff would otherwise carry AI_SM_STANDBY,
  // AI_SM_PORT_HINT, AI_SM_RESTARTED_FROM and AI_SM_WEB_DIST_DIR into the
  // user's shell — where a
  // backend launched from inside that terminal would read them and try to boot
  // as somebody's standby on somebody's port.
  const outDir = tempDir();
  const envFile = join(outDir, 'env.txt');
  const web = webDistCopy();
  const server = await startTestServer({
    env: {
      AI_SM_STANDBY: '1', // No IPC channel here, so this boots normally (warned).
      AI_SM_PORT_HINT: '41000',
      AI_SM_RESTARTED_FROM: '4242',
      AI_SM_WEB_DIST_DIR: web.served,
    },
  });
  try {
    await createSession(server, {
      cwd: '/tmp',
      command: 'bash',
      args: ['-lc', `env > ${envFile}; sleep 30`],
      title: 'env-probe',
      cols: 80,
      rows: 24,
    });
    const env = await waitUntil(
      () => (existsSync(envFile) ? readFileSync(envFile, 'utf8') : undefined),
      'the session to dump its environment',
      15_000,
    );
    const names = env
      .split('\n')
      .map((line) => line.split('=')[0])
      .filter((name): name is string => name !== undefined);
    assert.ok(
      names.includes('AI_SM_DATA_DIR'),
      `the environment really is the backend's (non-vacuity): ${names.filter((n) => n.startsWith('AI_SM_')).join(', ')}`,
    );
    for (const banned of [
      'AI_SM_STANDBY',
      'AI_SM_PORT_HINT',
      'AI_SM_RESTARTED_FROM',
      // Same family: it names the directory a restart renames and deletes the
      // backup of, so a backend launched from inside a session must not inherit
      // the parent's served path.
      'AI_SM_WEB_DIST_DIR',
    ]) {
      assert.ok(!names.includes(banned), `${banned} must not reach a session`);
    }
  } finally {
    await server.stop();
    rmSync(outDir, { recursive: true, force: true });
    web.remove();
  }
});

test('AI_SM_STANDBY set by hand, with no IPC channel, boots NORMALLY instead of waiting forever', async () => {
  // The variable is ours, but it lives in the environment, and an environment
  // is a thing users copy. Without a channel there is nobody to say `go`, so
  // hanging on it would be a backend that never serves and never explains.
  const server = await startTestServer({ env: { AI_SM_STANDBY: '1' } });
  try {
    const health = await fetch(`${server.baseUrl}/health`);
    assert.equal(health.status, 200, 'it is serving');
    const log = await readServerLog(server);
    assert.ok(
      log.includes('AI_SM_STANDBY is set but this process has no IPC channel; starting normally'),
      `and it says exactly why: ${log.split('\n').filter((l) => l.includes('STANDBY')).join(' | ')}`,
    );
  } finally {
    await server.stop();
  }
});

test('REAL restart: a SIGTERM racing the handoff never deletes runtime.json out from under the child', async () => {
  // The guard in index.ts: once a restart has torn everything down, the normal
  // shutdown path (SIGTERM, SIGINT, idle grace) must NOT run again — its
  // unlink() would blind the launcher by removing the CHILD's discovery file.
  // The race is timed by the log line the old process writes right after the
  // spawn; whoever wins it, the invariant below must hold.
  const web = webDistCopy();
  const repoDistBefore = repoWebDist();
  const server = await startTestServer({ env: { AI_SM_WEB_DIST_DIR: web.served } });
  const oldPid = server.child.pid as number;
  let childPid: number | undefined;
  try {
    void api(server, 'POST', '/api/restart').catch(() => undefined); // May never answer: we kill it.
    await waitUntil(
      async () => ((await readServerLog(server)).includes('new backend spawned') ? true : undefined),
      'the spawn line',
      15_000,
      5,
    );
    try {
      process.kill(oldPid, 'SIGTERM');
    } catch {
      // Already exited on its own — the handoff simply won the race.
    }

    const child = await waitUntil(
      () => {
        const rt = readRuntime(server.runtimeFile);
        return rt !== undefined && rt.pid !== oldPid ? rt : undefined;
      },
      'runtime.json to survive and name the child',
    );
    childPid = child.pid;
    assert.ok(existsSync(server.runtimeFile), 'runtime.json must still be there');
    assert.equal(isAlive(child.pid), true, 'the child is alive and owns the file');
    const health = await fetch(`http://127.0.0.1:${child.port}/health`);
    assert.equal(health.status, 200, 'and it is serving');

    const exit = await Promise.race([server.exit, delay(15_000).then(() => undefined)]);
    assert.ok(exit !== undefined, 'the old process is gone');
    assert.equal(exit.code, 0, `and left cleanly (code=${exit.code} signal=${exit.signal})`);

    // The invariant above is timing-dependent (the unlink can land before the
    // child ever creates the file), so the GUARD itself is asserted directly:
    // the signal must have taken the restart-aware exit, never the ordinary
    // shutdown that unlinks runtime.json.
    const log = await readServerLog(server);
    assert.match(
      log,
      /received SIGTERM while a restart is in progress; exiting without further teardown/,
      `the SIGTERM must hit the guarded path: ${log
        .split('\n')
        .filter((l) => l.includes('received SIGTERM'))
        .join(' | ')}`,
    );
    assert.ok(
      !log.includes('received SIGTERM, shutting down'),
      'and never the ordinary teardown, which would unlink the file',
    );
    assert.deepEqual(repoWebDist(), repoDistBefore, "the repo's own web/dist never moved");
  } finally {
    const adopted = childPid;
    if (adopted !== undefined && isAlive(adopted)) {
      process.kill(adopted, 'SIGTERM');
      await waitUntil(() => (isAlive(adopted) ? undefined : true), 'the child to exit', 10_000).catch(
        () => process.kill(adopted, 'SIGKILL'),
      );
    }
    await server.stop();
    web.remove();
  }
});

// ---------------------------------------------------------------------------
// 4. upgrade.closeAll — the teardown's WebSocket half
// ---------------------------------------------------------------------------
//
// The restart teardown closes every live socket with 1012 "service restart" and
// LOGS the count; server/index.ts then destroys only the connections that were
// NOT WebSockets, so the close frames can flush. Both halves lean on closeAll
// returning the number of sockets it actually closed: an overstated count is a
// lie in the log, and a socket left open is a client that keeps its old token
// against a new process.

test('upgrade.closeAll: closes every OPEN socket with 1012 and counts each one exactly once', async () => {
  const dir = tempDir();
  const log = createLogger(join(dir, 'server.log'), 'debug');
  const token = 'd'.repeat(64);
  const history = new SessionHistory(join(dir, 'history.json'), log);
  const sessions = new SessionManager(log, history);
  const lifecycle = new LifecycleController({
    onIdleShutdown: () => undefined,
    log,
    graceMs: 600_000,
    startupGraceMs: 600_000,
  });
  let boundPort = 0;
  const upgrade = createUpgradeHandler({
    token,
    getPort: () => boundPort,
    sessions,
    lifecycle,
    log,
    allowRefusalLine: createRefusalLimiter(scoped(log, 'http')),
  });
  const server: Server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  server.on('upgrade', upgrade);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  boundPort = (server.address() as { port: number }).port;

  const logFile = join(dir, 'server.log');
  let bodyThrew = false;
  try {
    assert.equal(upgrade.closeAll(1012, 'service restart'), 0, 'nothing connected, nothing closed');

    // One session channel and two presence windows: closeAll spans BOTH servers.
    const session = sessions.create({
      cwd: '/tmp',
      command: 'bash',
      args: ['-lc', 'sleep 30'],
      title: 'closeall',
      cols: 80,
      rows: 24,
    });
    const base = `ws://127.0.0.1:${boundPort}`;
    const attached = await WsClient.connect(`${base}/ws/sessions/${session.id}?token=${token}`);
    const w1 = await WsClient.connect(`${base}/ws/presence?token=${token}`);
    const w2 = await WsClient.connect(`${base}/ws/presence?token=${token}`);

    assert.equal(upgrade.closeAll(1012, 'service restart'), 3, 'the session socket AND both windows');
    // Immediately after: the same sockets are CLOSING, not OPEN. Counting them
    // again would double the number the teardown line prints.
    assert.equal(upgrade.closeAll(1012, 'service restart'), 0, 'only OPEN sockets are counted');

    for (const client of [attached, w1, w2]) {
      await waitUntil(() => (client.closed ? true : undefined), 'the client to see the close', 10_000);
      assert.equal(client.closeInfo?.code, 1012, 'the "come back in a moment" code, not an error');
      assert.equal(client.closeInfo?.reason, 'service restart');
    }
    assert.ok(
      (await import('node:fs')).readFileSync(logFile, 'utf8').includes(
        'closed 3 websocket(s) with code 1012: service restart',
      ),
      'and the count reaches the log exactly once',
    );
    // The SERVER half of those three closes writes to server.log as well, and
    // can land after the client saw the frame. Wait for it here, so nothing is
    // still appending into `dir` when the finally removes it.
    await waitForLogLines(
      logFile,
      {
        [`detached session ${session.id} code=1012`]: 1,
        'presence disconnected code=1012': 2,
      },
      'the server side of all three closes to be logged',
    );
  } catch (err) {
    bodyThrew = true;
    throw err;
  } finally {
    // The grace timer the last presence close armed is a REAL 10-minute timer:
    // without this the file's event loop never drains and `node --test` hangs.
    lifecycle.stop();
    // NOT a bare destroyAll(): node-pty's `exit` fires ticks later and its
    // handler appends to server.log, which recreated the file mid-rm() and
    // failed this test with ENOTEMPTY on a loaded CI runner (run 34248854109).
    // A settle TIMEOUT must never replace the body's error: without this, a
    // failed assertion is reported as a teardown timeout and the real failure
    // is invisible.
    // Stashed, not thrown here: a throw inside `finally` would skip the two
    // cleanups below, leaking the listener (so `node --test` never drains) and
    // the temp dir. It is rethrown after them.
    let settleErr: { err: unknown } | undefined;
    try {
      await destroyAllAndSettle(sessions, logFile);
    } catch (err) {
      if (bodyThrew) console.error(err);
      else settleErr = { err };
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(dir);
    if (settleErr) throw settleErr.err;
  }
});
