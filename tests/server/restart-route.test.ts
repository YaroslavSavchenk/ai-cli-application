/**
 * Manual restart — the ROUTES on the wire. POST /api/restart against a real
 * in-process http server with a FAKE runner (nothing is spawned): the token
 * gate, Origin/Host parity, 405, 503 without a restart mechanism, a body that
 * is never parsed, and the exact wire shapes of 202/409/422/500 (a 422 keeps
 * the connection and never carries an exit hook). And GET /api/runtime: the
 * update reason must reach the browser byte-for-byte, under the key the UI
 * reads — tests/server/buildinfo-update-check.test.ts proves the checker picks
 * the reason, the UI tests map it to a sentence; this is the wire in between.
 *
 * How: the production request handler (server/api.ts) mounted in this process
 * on a real HTTP server, with an injected runner or a real update checker on
 * a temp checkout.
 *
 * NOT claimed here: the controller behind the route —
 * `tests/server/restart.test.ts`; a real restart —
 * `tests/server/restart-real.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { RuntimeStatusResponse } from '../../shared/protocol.ts';
import {
  RESTART_IN_PROGRESS,
  REFUSED_BUILD,
  REFUSED_DEPENDENCIES,
  REFUSED_STANDBY,
  type RestartOutcome,
  type RestartRunner,
} from '../../server/restart.ts';
import { createUpdateChecker } from '../../server/buildinfo.ts';
import { createRequestHandler } from '../../server/api.ts';
import { createLogger, createRefusalLimiter, scoped } from '../../server/config.ts';
import { PollTally } from '../../server/poll-log.ts';
import { SessionHistory } from '../../server/history.ts';
import { SessionManager } from '../../server/sessions.ts';
import { ProjectStore } from '../../server/projects.ts';
import { PrefsStore } from '../../server/prefs.ts';
import { GithubConnection } from '../../server/github.ts';
import { destroyAllAndSettle, rawRequest, removeTempDir } from '../helpers/helpers.ts';
import { tempDir, harness } from '../helpers/restart-fixture.ts';

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
  const polls = new PollTally({ log: scoped(log, 'http') });
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
      polls,
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
    polls.stop();
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
// tests/server/buildinfo.test.ts proves the CHECKER picks the right reason; the UI
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
  const polls = new PollTally({ log: scoped(log, 'http') });
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
      polls,
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
    polls.stop();
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
