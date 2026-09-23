/**
 * Shared helpers for the logging tests (`tests/server/logging.test.ts`,
 * `tests/server/logging-client-log.test.ts`, `tests/server/logging-hardening.test.ts`,
 * `tests/server/logging-polls.test.ts`): a temp dir for an in-process logger,
 * a raw POST to /api/client-log on a real server child with a chosen token and
 * Origin, and the production request handler mounted in-process with an
 * injected clock (moved here from logging-client-log.test.ts, Quality P4).
 */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger, scoped, createRefusalLimiter, type Logger } from '../../server/config.ts';
import { PollTally } from '../../server/poll-log.ts';
import { ProjectStore } from '../../server/projects.ts';
import { PrefsStore } from '../../server/prefs.ts';
import { SessionHistory } from '../../server/history.ts';
import { SessionManager } from '../../server/sessions.ts';
import { GithubConnection } from '../../server/github.ts';
import { createRequestHandler } from '../../server/api.ts';
import {
  destroyAllAndSettle,
  rawRequest,
  makeTempDirSync,
  removeTempDir,
  type TestServer,
} from './helpers.ts';

export function tempDir(): string {
  return makeTempDirSync('ai-sm-log-');
}

export async function postClientLog(
  server: TestServer,
  body: unknown,
  opts: { token?: string; origin?: string } = {},
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token !== '') headers['x-auth-token'] = opts.token ?? server.token;
  if (opts.origin !== undefined) headers['origin'] = opts.origin;
  const res = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/client-log',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: res.body };
}

/**
 * The per-minute client-log budget lives INSIDE createRequestHandler
 * (server/api.ts) and reads the clock through a bare `Date.now()`, so the
 * window reset cannot be reached from a spawned server without waiting a real
 * minute. It CAN be reached by mounting the very same handler in this process
 * and moving the clock: the handler is exported, and `Date.now` is the only
 * time source the budget consults.
 *
 * This is a real HTTP server with the real request handler — not a hand-rolled
 * req/res double — so the auth gate, the body reader, the entry caps and the
 * budget are all the production code paths.
 */
export interface InProcessApi {
  port: number;
  token: string;
  logFile: string;
  readLog: () => string;
  /** Move the INJECTED clock forward; the real one is never monkeypatched. */
  advance: (ms: number) => void;
}

/**
 * `makePolls`, when given, builds the handler's poll counter from the
 * handler's own log (Quality P4: a test drives the summary's timer by hand);
 * without it the fixture builds a plain one. Either way it is stopped at
 * teardown.
 */
export async function withInProcessApi(
  fn: (ctx: InProcessApi) => Promise<void>,
  makePolls?: (log: Logger, now: () => number) => PollTally,
): Promise<void> {
  const dir = tempDir();
  const logFile = join(dir, 'server.log');
  const log = createLogger(logFile, 'debug');
  const token = 'a'.repeat(64);
  // The clock SEAM the budgets read (ApiDeps.now / createWindowLimiter.now).
  // Injected, not monkeypatched: a global Date.now swap also moves the log's
  // own timestamps and anything else that happens to run in this process.
  let offsetMs = 0;
  const now = (): number => Date.now() + offsetMs;
  const history = new SessionHistory(join(dir, 'history.json'), log);
  const sessions = new SessionManager(log, history);
  // `boundPort` (not server.address()) because getPort is captured while the
  // server is still being constructed — a self-referential initializer.
  let boundPort = 0;
  const polls =
    makePolls === undefined ? new PollTally({ log: scoped(log, 'http'), now }) : makePolls(scoped(log, 'http'), now);
  const server: Server = createServer(
    createRequestHandler({
      token,
      getPort: () => boundPort,
      getStartedAt: () => new Date().toISOString(),
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
      log,
      allowRefusalLine: createRefusalLimiter(scoped(log, 'http'), now),
      now,
      polls,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  boundPort = port;
  let bodyThrew = false;
  try {
    await fn({
      port,
      token,
      logFile,
      readLog: () => {
        try {
          return readFileSync(logFile, 'utf8');
        } catch {
          return '';
        }
      },
      advance: (ms) => {
        offsetMs += ms;
      },
    });
  } catch (err) {
    bodyThrew = true;
    throw err;
  } finally {
    // destroyAll() only kills the ptys; node-pty's `exit` lands ticks later and
    // its handler appends to server.log — a write that recreates the file in
    // the middle of the removal below and fails it with ENOTEMPTY.
    // A settle TIMEOUT must never replace the body's error: without this, a
    // failed assertion is reported as a teardown timeout and the real failure
    // is invisible.
    // Stashed, not thrown here: a throw inside `finally` would skip the two
    // cleanups below, leaking the listener (so `node --test` never drains) and
    // the temp dir. It is rethrown after them.
    let settleErr: { err: unknown } | undefined;
    polls.stop();
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
