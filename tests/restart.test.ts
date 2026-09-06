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
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Duplex } from 'node:stream';
import type { HistoryEntry, RestartResponse, RuntimeInfo } from '../shared/protocol.ts';
import {
  RestartController,
  RESTART_IN_PROGRESS,
  type RestartDeps,
  type RestartOutcome,
  type RestartRunner,
} from '../server/restart.ts';
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
  presenceUrl,
  rawRequest,
  readServerLog,
  startTestServer,
  waitUntil,
  WsClient,
} from './helpers.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ai-sm-restart-'));
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

const OLD_PID = 4242;
const OLD_PORT = 41000;

function harness(opts: {
  /** runtime.json contents, evaluated on every poll. */
  runtime?: () => RuntimeInfo | undefined;
  healthy?: (port: number) => boolean;
  spawnThrows?: boolean;
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
    spawnChild: (env) => {
      events.push('spawn');
      if (opts.spawnThrows === true) throw new Error('EACCES nope');
      spawned.push(env);
      return 9999;
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

test('restart controller: tears down BEFORE spawning, hands the old port over as a hint, answers 202', async () => {
  const h = harness();
  const outcome = await h.controller.request();

  assert.equal(outcome.status, 202);
  assert.deepEqual(h.events, ['teardown', 'spawn'], 'teardown runs first: the port must be free');
  assert.deepEqual(
    h.spawned,
    [{ portHint: OLD_PORT, restartedFrom: OLD_PID }],
    'the child is told which port to try and which pid it replaces',
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
    spawnChild: (env) => {
      h.events.push('spawn');
      h.spawned.push(env);
      return 1;
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
  // NO await in between: the guard is set before the first suspension point,
  // which is exactly what makes a second POST land on 409 rather than on a
  // second teardown. A sleep here would hide a guard set too late.
  assert.equal(controller.inProgress, true, 'in flight from the synchronous part of request()');
  const second = await controller.request();

  assert.equal(second.status, 409);
  assert.deepEqual(second.body, { error: RESTART_IN_PROGRESS });
  assert.equal(second.onFlushed, null, 'a refused restart must not exit the process');
  assert.deepEqual(h.events, ['teardown', 'spawn'], 'one teardown, one spawn — not two');

  release();
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
    spawnChild: () => 1,
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
  assert.deepEqual(h.events, ['teardown'], 'the child is NEVER spawned after a failed teardown');
  assert.deepEqual(h.spawned, []);

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

test('restart controller: a spawn that throws answers 500 without leaking the errno text into the body', async () => {
  const h = harness({ spawnThrows: true });
  const outcome = await h.controller.request();

  assert.equal(outcome.status, 500);
  assert.deepEqual(outcome.body, {
    error: 'restart failed: could not start the new backend; relaunch from the desktop shortcut',
  });
  assert.ok(
    h.logLines.some((l) => l.startsWith('[error]') && l.includes('spawning the new backend failed')),
    'the detail belongs in the log, not in the response',
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
  try {
    await fn(ctx);
  } finally {
    sessions.destroyAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
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
  const server = await startTestServer();
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

    // The log tells the whole story across both processes.
    const log = await readServerLog(server);
    assert.match(log, /\[restart\] restart requested by the ui: sessions=1 presence=1 attached=0/);
    assert.match(log, /restart teardown: listener closed, 1 websocket\(s\) closed 1012/);
    assert.match(log, new RegExp(`\\[restart\\] new backend spawned \\(pid \\d+\\), port hint ${server.port}`));
    assert.match(log, new RegExp(`\\[boot\\] restarted from pid ${oldPid}`));
    assert.match(log, new RegExp(`\\[boot\\] port hint ${server.port} taken`));
    assert.match(log, /\[restart\] handoff complete: pid \d+ on 127\.0\.0\.1:\d+ \(samePort=true/);
    assert.ok(!log.includes(server.token), 'no token anywhere in the log');
    assert.ok(!log.includes(child.token), 'not the new one either');
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

test('REAL restart: a SIGTERM racing the handoff never deletes runtime.json out from under the child', async () => {
  // The guard in index.ts: once a restart has torn everything down, the normal
  // shutdown path (SIGTERM, SIGINT, idle grace) must NOT run again — its
  // unlink() would blind the launcher by removing the CHILD's discovery file.
  // The race is timed by the log line the old process writes right after the
  // spawn; whoever wins it, the invariant below must hold.
  const server = await startTestServer();
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
  } finally {
    const adopted = childPid;
    if (adopted !== undefined && isAlive(adopted)) {
      process.kill(adopted, 'SIGTERM');
      await waitUntil(() => (isAlive(adopted) ? undefined : true), 'the child to exit', 10_000).catch(
        () => process.kill(adopted, 'SIGKILL'),
      );
    }
    await server.stop();
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
      (await import('node:fs')).readFileSync(join(dir, 'server.log'), 'utf8').includes(
        'closed 3 websocket(s) with code 1012: service restart',
      ),
      'and the count reaches the log exactly once',
    );
  } finally {
    // The grace timer the last presence close armed is a REAL 10-minute timer:
    // without this the file's event loop never drains and `node --test` hangs.
    lifecycle.stop();
    sessions.destroyAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
