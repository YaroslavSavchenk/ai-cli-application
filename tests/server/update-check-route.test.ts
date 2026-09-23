/**
 * POST /api/update/check — "Check for updates" (Nocturne B6, spec
 * `.claude/plans/nocturne/PLAN-B6.md`).
 *
 * The route over a REAL http server with the real request handler, and a FAKE
 * ReleaseChecker behind the deps seam: nothing here touches the network, and
 * the fake is what makes "two clicks make one request" observable.
 *
 * What is proved: the method and auth gates, 503 when this backend has no
 * checker at all, the composed status on the wire byte-for-byte, that a body is
 * never parsed, that a failed check answers the LAST known status instead of a
 * 5xx, that concurrent callers share one check, and that the outcome reaches
 * the access line through `responseNote` (note=, the 2xx channel; reason= stays
 * refusals only) — as a constant, never remote text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdateRelease, UpdateStatus } from '../../shared/protocol.ts';
import { UPDATE_NEW_VERSION_AVAILABLE } from '../../shared/protocol.ts';
import { createRequestHandler, UPDATE_UP_TO_DATE } from '../../server/api.ts';
import { UPDATE_NOT_AVAILABLE } from '../../server/update-install.ts';
import { UPDATE_NEW_VERSION_INSTALLED } from '../../server/bundle.ts';
import { composeUpdateStatus, type ReleaseChecker } from '../../server/update-release.ts';
import { createLogger, createRefusalLimiter, scoped } from '../../server/config.ts';
import { SessionHistory } from '../../server/history.ts';
import { SessionManager } from '../../server/sessions.ts';
import { ProjectStore } from '../../server/projects.ts';
import { PrefsStore } from '../../server/prefs.ts';
import { GithubConnection } from '../../server/github.ts';
import {
  destroyAllAndSettle,
  projectRoot,
  rawRequest,
  readServerLog,
  removeTempDir,
  startTestServer,
} from '../helpers/helpers.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ai-sm-update-check-'));
}

const RELEASE: UpdateRelease = {
  version: '0.4.0',
  setupName: 'AI-Session-Manager-Setup-0.4.0.exe',
  setupUrl: 'https://example.invalid/releases/AI-Session-Manager-Setup-0.4.0.exe',
  sumsUrl: 'https://example.invalid/releases/SHA256SUMS.txt',
  size: 1234,
};

interface FakeChecker extends ReleaseChecker {
  /** How many times the route caused a check. */
  calls: number;
  /** Resolve the check that is waiting (only with `manual: true`). */
  finish: () => void;
  /** What `status()` answers after the next check resolves. */
  next: UpdateStatus;
  /**
   * The next `checkNow()` FAILS: it resolves (checkNow never rejects) without
   * applying `next`, exactly like a network error — the previous status stands.
   */
  failNext: boolean;
}

/**
 * A ReleaseChecker that never leaves the process. `manual` holds `checkNow()`
 * open so two requests can be in flight at the same time — the only way to see
 * whether the dep really shares one check.
 */
function fakeChecker(opts: { manual?: boolean } = {}): FakeChecker {
  let status: UpdateStatus = { available: false, reason: null };
  let release: (() => void) | undefined;
  const checker: FakeChecker = {
    calls: 0,
    next: { available: false, reason: null },
    failNext: false,
    finish: () => release?.(),
    status: () => status,
    release: () => (status.available ? RELEASE : undefined),
    checkNow: () => {
      checker.calls += 1;
      const apply = (): void => {
        // A failed check leaves the last known status untouched.
        if (checker.failNext) checker.failNext = false;
        else status = checker.next;
      };
      if (opts.manual !== true) {
        apply();
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        release = () => {
          apply();
          resolve();
        };
      });
    },
    start: () => {},
    stop: () => {},
  };
  return checker;
}

interface RouteCtx {
  port: number;
  token: string;
  checker: FakeChecker;
  /** The server.log this handler writes — the access line lives here. */
  logFile: string;
}

/**
 * The real request handler on a real listener. `wire: false` builds it WITHOUT
 * the dep, which is exactly what a developer clone (no checker) looks like.
 *
 * The dep is the SAME shape server/index.ts builds: one module-level promise,
 * shared by everyone who asks while a check is in flight, cleared when it
 * settles, and the composed status read only AFTER the check resolved.
 */
async function withRoute(
  opts: { wire?: boolean; manual?: boolean; installed?: UpdateStatus },
  fn: (ctx: RouteCtx) => Promise<void>,
): Promise<void> {
  const dir = tempDir();
  const logFile = join(dir, 'server.log');
  const log = createLogger(logFile, 'debug');
  const token = 'd'.repeat(64);
  const history = new SessionHistory(join(dir, 'history.json'), log);
  const sessions = new SessionManager(log, history);
  const checker = fakeChecker({ ...(opts.manual === true ? { manual: true } : {}) });
  let inFlight: Promise<UpdateStatus> | undefined;
  const updateCheck = (): Promise<UpdateStatus> =>
    (inFlight ??= checker
      .checkNow()
      .then(() =>
        composeUpdateStatus(
          // The LOCAL half of the composition — an unpacked bundle sitting on
          // disk. server/index.ts feeds the same thing in through checkUpdate();
          // `installed` lets a test put something there.
          opts.installed ?? { available: false, reason: null },
          checker.status(),
        ),
      )
      .finally(() => {
        inFlight = undefined;
      }));
  let boundPort = 0;
  const server: Server = createServer(
    createRequestHandler({
      token,
      getPort: () => boundPort,
      getStartedAt: () => '2026-09-22T12:00:00.000Z',
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
      ...(opts.wire === false ? {} : { updateCheck }),
      log,
      allowRefusalLine: createRefusalLimiter(scoped(log, 'http')),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  boundPort = (server.address() as { port: number }).port;
  let bodyThrew = false;
  try {
    await fn({ port: boundPort, token, checker, logFile });
  } catch (err) {
    bodyThrew = true;
    throw err;
  } finally {
    // Same teardown discipline as tests/server/restart.test.ts: settle the (empty)
    // session manager before the temp dir goes, never let a teardown error
    // replace the body's failure, and always close the listener so `node
    // --test` can drain.
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
}

function post(ctx: RouteCtx, extra: Record<string, string> = {}, body?: string) {
  return rawRequest(ctx.port, {
    method: 'POST',
    path: '/api/update/check',
    headers: { 'x-auth-token': ctx.token, ...extra },
    ...(body === undefined ? {} : { body }),
  });
}

test('POST /api/update/check: no token is 401 and NO check is run', async () => {
  await withRoute({}, async (ctx) => {
    const res = await rawRequest(ctx.port, { method: 'POST', path: '/api/update/check' });
    assert.equal(res.status, 401);
    assert.deepEqual(JSON.parse(res.body), { error: 'unauthorized' });
    assert.equal(ctx.checker.calls, 0, 'an unauthenticated page can never make us call GitHub');
  });
});

test('POST /api/update/check: a foreign Origin and a foreign Host are 403, and nothing is checked', async () => {
  await withRoute({}, async (ctx) => {
    const evilOrigin = await post(ctx, { origin: 'http://evil.example' });
    assert.equal(evilOrigin.status, 403);
    assert.deepEqual(JSON.parse(evilOrigin.body), { error: 'forbidden origin' });

    const evilHost = await post(ctx, { host: 'evil.example' });
    assert.equal(evilHost.status, 403);
    assert.deepEqual(JSON.parse(evilHost.body), { error: 'forbidden host' });
    assert.equal(ctx.checker.calls, 0);
  });
});

test('POST /api/update/check: GET, PUT and DELETE are 405 — only POST checks', async () => {
  await withRoute({}, async (ctx) => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await rawRequest(ctx.port, {
        method,
        path: '/api/update/check',
        headers: { 'x-auth-token': ctx.token },
      });
      assert.equal(res.status, 405, `${method} is refused`);
      assert.deepEqual(JSON.parse(res.body), { error: 'method not allowed' });
    }
    assert.equal(ctx.checker.calls, 0);
  });
});

test('POST /api/update/check: 503 when this backend has no checker (a developer clone)', async () => {
  await withRoute({ wire: false }, async (ctx) => {
    const res = await post(ctx);
    assert.equal(res.status, 503);
    assert.deepEqual(JSON.parse(res.body), { error: UPDATE_NOT_AVAILABLE });
    assert.equal(
      UPDATE_NOT_AVAILABLE,
      'updates are not available in this process',
      'the same sentence GET /api/update/status already answers',
    );
  });
});

test('POST /api/update/check: 200 carries the composed status the check just produced', async () => {
  await withRoute({}, async (ctx) => {
    const nothing = await post(ctx);
    assert.equal(nothing.status, 200);
    assert.deepEqual(JSON.parse(nothing.body), { available: false, reason: null });
    assert.equal(ctx.checker.calls, 1, 'the check ran before the answer was composed');

    // The check finds a release: the SAME shape GET /api/runtime carries under
    // `update`, release and all — no remapping on the way out.
    ctx.checker.next = { available: true, reason: UPDATE_NEW_VERSION_AVAILABLE, release: RELEASE };
    const found = await post(ctx);
    assert.equal(found.status, 200);
    assert.deepEqual(JSON.parse(found.body), {
      available: true,
      reason: 'a new version is available',
      release: {
        version: '0.4.0',
        setupName: 'AI-Session-Manager-Setup-0.4.0.exe',
        setupUrl: 'https://example.invalid/releases/AI-Session-Manager-Setup-0.4.0.exe',
        sumsUrl: 'https://example.invalid/releases/SHA256SUMS.txt',
        size: 1234,
      },
    });
    assert.equal(ctx.checker.calls, 2);
    assert.ok(!found.body.includes(ctx.token), 'the token is NEVER in an update answer');
  });
});

test('POST /api/update/check: a FAILED check is 200 with the last known status, never a 5xx', async () => {
  await withRoute({}, async (ctx) => {
    // checkNow() never rejects — a network failure is a log line and leaves the
    // previous answer standing. The route must not invent an error out of it.
    // First a check that SUCCEEDS, so there is a last known status to keep.
    ctx.checker.next = { available: true, reason: UPDATE_NEW_VERSION_AVAILABLE, release: RELEASE };
    const found = await post(ctx);
    assert.equal((JSON.parse(found.body) as UpdateStatus).reason, 'a new version is available');

    // Now the check fails: it resolves without applying anything at all.
    ctx.checker.failNext = true;
    ctx.checker.next = { available: false, reason: null };
    const res = await post(ctx);
    assert.equal(res.status, 200, 'a failed check is never a 5xx');
    assert.equal(
      (JSON.parse(res.body) as UpdateStatus).reason,
      'a new version is available',
      'the last known status survives the failure',
    );
    assert.equal(ctx.checker.calls, 2, 'the failing check really ran');
  });
});

test('POST /api/update/check: a body is IGNORED, never parsed — no route to a 400 from attacker JSON', async () => {
  await withRoute({}, async (ctx) => {
    const res = await post(ctx, { 'content-type': 'application/json' }, '{ this is not json at all');
    assert.equal(res.status, 200, 'the body never reaches a parser');
    assert.deepEqual(JSON.parse(res.body), { available: false, reason: null });
    assert.equal(ctx.checker.calls, 1);
  });
});

test('POST /api/update/check: two concurrent POSTs run ONE check and both get the same answer', async () => {
  await withRoute({ manual: true }, async (ctx) => {
    ctx.checker.next = { available: true, reason: UPDATE_NEW_VERSION_AVAILABLE, release: RELEASE };
    const first = post(ctx);
    const second = post(ctx);
    // Both requests are in the handler before the check is allowed to finish:
    // the second one must adopt the promise the first one created.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(ctx.checker.calls, 1, 'the second click never doubles the GitHub request');
    ctx.checker.finish();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body, b.body, 'both callers see the same composed status');
    assert.equal(
      (JSON.parse(a.body) as UpdateStatus).reason,
      'a new version is available',
      'and it is the answer the shared check produced, not the stale one',
    );
    assert.equal(ctx.checker.calls, 1);
  });
});

test('POST /api/update/check: the shared promise is RELEASED — a later POST checks again', async () => {
  await withRoute({ manual: true }, async (ctx) => {
    const first = post(ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    ctx.checker.finish();
    assert.equal((await first).status, 200);

    ctx.checker.next = { available: true, reason: UPDATE_NEW_VERSION_AVAILABLE, release: RELEASE };
    const second = post(ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(ctx.checker.calls, 2, 'the in-flight promise did not survive its own check');
    ctx.checker.finish();
    assert.equal((JSON.parse((await second).body) as UpdateStatus).reason, 'a new version is available');
  });
});

test('POST /api/update/check: the outcome reaches the access line as a CONSTANT note', async () => {
  await withRoute({}, async (ctx) => {
    await post(ctx);
    ctx.checker.next = { available: true, reason: UPDATE_NEW_VERSION_AVAILABLE, release: RELEASE };
    await post(ctx);
    // The lines are written on response close; give the handler a tick.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const log = readFileSync(ctx.logFile, 'utf8');
    const notes = [
      ...log.matchAll(/POST \/api\/update\/check [^\n]*? note=("(?:[^"\\]|\\.)*")/g),
    ].map((m) => JSON.parse(m[1] as string) as string);
    assert.deepEqual(
      notes,
      [UPDATE_UP_TO_DATE, UPDATE_NEW_VERSION_AVAILABLE],
      'one line per request, carrying the outcome of that check',
    );
    assert.equal(UPDATE_UP_TO_DATE, 'up to date');
    // reason= stays what it is everywhere else: a REFUSAL reason. A 200 must
    // never wear one, or every log reader loses that invariant.
    const reasonsOn200 = [
      ...log.matchAll(/POST \/api\/update\/check [^\n]*? -> 200[^\n]*/g),
    ]
      .map((m) => m[0])
      .filter((line) => line.includes('reason='));
    assert.deepEqual(reasonsOn200, [], 'the 200 line carries note=, never reason=');
    assert.ok(!log.includes('example.invalid'), 'no URL from the release payload reaches the log');
    assert.ok(!log.includes('AI-Session-Manager-Setup'), 'nor the asset name');
    assert.ok(!log.includes(ctx.token), 'nor the token');
  });
});

/**
 * The note's CONTENT rule, from the attacker's side: everything a caller
 * controls on this request — a legitimate same-origin Origin, a query string, a
 * User-Agent, a body — is text the log must never repeat. The note is a
 * constant from server/api.ts, so an access line stays the same whatever the
 * browser sent.
 */
test('POST /api/update/check: nothing the CALLER sent reaches the access line', async () => {
  await withRoute({}, async (ctx) => {
    const res = await rawRequest(ctx.port, {
      method: 'POST',
      // A query string the handler has no business with: the line prints `?…`.
      path: '/api/update/check?probe=QUERYCANARY',
      headers: {
        'x-auth-token': ctx.token,
        // The real browser ALWAYS sends this, and it passes the origin gate.
        origin: `http://127.0.0.1:${ctx.port}`,
        'user-agent': 'AGENTCANARY/1.0',
        'content-type': 'application/json',
      },
      body: '{"note":"BODYCANARY"}',
    });
    assert.equal(res.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const log = readFileSync(ctx.logFile, 'utf8');
    for (const canary of ['QUERYCANARY', 'AGENTCANARY', 'BODYCANARY', `127.0.0.1:${ctx.port}`]) {
      assert.ok(!log.includes(canary), `${canary} must never reach server.log`);
    }
    const notes = [
      ...log.matchAll(/POST \/api\/update\/check [^\n]*? note=("(?:[^"\\]|\\.)*")/g),
    ].map((m) => JSON.parse(m[1] as string) as string);
    assert.deepEqual(notes, [UPDATE_UP_TO_DATE], 'the constant, and only the constant');
  });
});

/**
 * The concurrency above proves the SHAPE of the dep, built here from a fake
 * checker; server/index.ts builds the real one from the real ReleaseChecker and
 * cannot be imported (it is a boot script). This reads its source so the two
 * cannot drift apart silently: the dep exists only when there IS a checker, and
 * one in-flight promise is shared and then cleared.
 */
test('server/index.ts wires the dep from the release checker and shares one in-flight check', () => {
  const src = readFileSync(join(projectRoot, 'server', 'index.ts'), 'utf8');
  assert.match(src, /const checker = releaseChecker;/, 'the checker decides whether the dep exists');
  assert.match(src, /checker === undefined\s*\?\s*undefined/, 'no checker -> no dep -> the 503');
  assert.match(src, /updateCheckInFlight \?\?=/, 'concurrent callers share the promise');
  assert.match(src, /updateCheckInFlight = undefined;/, 'and it is cleared when the check settles');
  assert.match(src, /\{ updateCheck \}/, 'and the dep reaches the api deps object');
  // The COMPOSED status, not the checker's raw one: an unpacked bundle on disk
  // outranks a release that still has to be downloaded, and the route answers
  // the same thing GET /api/runtime does. `checker.status()` here would silently
  // drop that half (proved behaviourally at the deps seam one test below).
  assert.match(
    src,
    /\.then\(\(\) => checkUpdate\(\)\)/,
    'the answer is composed by checkUpdate(), never checker.status() raw',
  );
});

/**
 * The other half of the composition, at the deps seam: the dep resolves what
 * `checkUpdate()` returns, and an installed-on-disk bundle WINS over whatever
 * the online check just found. A dep that answered `checker.status()` raw would
 * tell a user with an unpacked bundle to download a release instead of
 * restarting into the one already on disk.
 */
test('POST /api/update/check: an unpacked bundle on disk OUTRANKS the release just found', async () => {
  const installed: UpdateStatus = { available: true, reason: UPDATE_NEW_VERSION_INSTALLED };
  await withRoute({ installed }, async (ctx) => {
    // The check itself finds a release — and it still loses.
    ctx.checker.next = { available: true, reason: UPDATE_NEW_VERSION_AVAILABLE, release: RELEASE };
    const res = await post(ctx);
    assert.equal(res.status, 200);
    assert.deepEqual(
      JSON.parse(res.body),
      { available: true, reason: 'a new version is installed' },
      'the local answer, with no `release` field to download',
    );
    assert.equal(ctx.checker.calls, 1, 'the online check still ran');
  });
});

/**
 * THE PROMISE THIS PROJECT MAKES ABOUT ITSELF, end to end: a developer clone
 * has no release checker at all, so the button cannot make an outbound request
 * — the route answers 503 before anything reaches the network. This boots the
 * REAL server/index.ts (this checkout has no bundle.json, so `releaseChecker`
 * is undefined), which is the one thing the source-shape test above cannot do.
 */
test('POST /api/update/check on a developer clone: 503 from the real backend, no outbound call', async () => {
  const server = await startTestServer();
  try {
    const res = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/update/check',
      headers: { 'x-auth-token': server.token },
    });
    assert.equal(res.status, 503, 'a clone never asks GitHub');
    assert.deepEqual(JSON.parse(res.body), { error: UPDATE_NOT_AVAILABLE });
    const log = await readServerLog(server);
    assert.ok(!log.includes('api.github.com'), 'and the log shows no release check at all');
  } finally {
    await server.stop();
  }
});

/**
 * The two access-line channels are gated on the status, and NEITHER branch is
 * reachable today (no route sets a note and then refuses, and `reason` is only
 * ever set by sendError/sendErrorAndClose, which are 4xx/5xx by construction).
 * They are the invariant the whole `responseNote` design rests on — `reason=`
 * means REFUSED, `note=` means a 2xx outcome — so they are pinned at the source
 * instead of being left to the first route that sets both.
 */
test('the access line gates note= to <400 and reason= to >=400', () => {
  const src = readFileSync(join(projectRoot, 'server', 'api.ts'), 'utf8');
  assert.match(
    src,
    /if \(status >= 400 && reason !== undefined\) parts\.push\(`reason=\$\{JSON\.stringify\(reason\)\}`\);/,
    'a 2xx can never wear a refusal reason',
  );
  assert.match(
    src,
    /if \(status < 400 && note !== undefined\) parts\.push\(`note=\$\{JSON\.stringify\(note\)\}`\);/,
    'and a refusal line can never wear a success note',
  );
});
