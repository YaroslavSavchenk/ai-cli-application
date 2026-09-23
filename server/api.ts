/**
 * REST routes + static serving of the built frontend (web/dist).
 *
 * Every /api route requires "X-Auth-Token: <token>" (timing-safe compare).
 * /health is unauthenticated and returns exactly {"ok":true}.
 * Host must be localhost:<port> or 127.0.0.1:<port>; an Origin header, when
 * present, must be http://localhost:<port> or http://127.0.0.1:<port>.
 *
 * The auth token reaches the UI by serve-time injection: web/dist/index.html
 * (and, since Nocturne C1, web/dist/mascot.html) contains the literal
 * placeholder __AUTH_TOKEN__ which is replaced when serving / and
 * /mascot.html (the injected pages are never cacheable).
 *
 * ACCESS LOG (2026-09-06): every request writes ONE line on completion —
 * method, pathname, status, duration, response bytes, and for 4xx/5xx the
 * constant refusal sentence. Never the query string's values (only `?…`),
 * never a body, never a header, never the token. /assets/* logs at debug.
 * A successful poll is counted instead of written: one summary line a minute
 * (Quality P4, server/poll-log.ts).
 *
 * CACHING (Quality P3b, 2026-09-23): the content-hashed Vite output under
 * /assets/ is `immutable` for a year; the two entry documents stay
 * `no-store`; every other static file keeps no cache header.
 *
 * POST /api/client-log ships the BROWSER's own log lines into server.log
 * (`[client] …`), because the page's console dies with the tab while
 * server.log is the only channel a detached backend has. Limits and
 * normalization rules live with writeClientLog() below.
 *
 * SPLIT BY ROUTE FAMILY (O8, 2026-09-23). This file keeps the gates (Host,
 * Origin, token), the dispatcher, the client-log writer, static serving and
 * the access log; the /api routes themselves live in api-app.ts, api-github.ts,
 * api-projects.ts, api-fs.ts, api-git.ts and api-sessions.ts, and the shared
 * response/body plumbing in api-http.ts. Every name this file exported before
 * the split is still exported from here.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type {
  ClientLogEntry,
  HealthResponse,
  ToolAvailability,
  UpdateStatus,
} from '../shared/protocol.ts';
import { tokenMatches, hostAllowed, originAllowed } from './auth.ts';
import { ProjectStore } from './projects.ts';
import { PrefsStore } from './prefs.ts';
import { SessionManager, ptyEnv } from './sessions.ts';
import { SessionHistory } from './history.ts';
import { KeyStore } from './keys.ts';
import { cachedProbe } from './tools.ts';
import { GithubConnection } from './github.ts';
import type { RestartRunner } from './restart.ts';
import type { UpdateRunner } from './update-install.ts';
import {
  createWindowLimiter,
  errorClass,
  errorFrames,
  oneLine,
  scoped,
  LOG_LEVELS,
  MAX_LOGGED_ROUTE_CHARS,
  type LogLevel,
  type Logger,
} from './config.ts';
import {
  declaresBody,
  responseBytes,
  responseNote,
  responseReason,
  sendError,
  sendErrorAndClose,
  sendJson,
  NEXT,
  type ApiContext,
  type RouteFamily,
} from './api-http.ts';
import {
  appRoutes,
  CLIENT_LOG_MAX_ENTRIES,
  CLIENT_LOG_MAX_MESSAGE,
  CLIENT_LOG_MAX_PER_MINUTE,
} from './api-app.ts';
import { githubRoutes } from './api-github.ts';
import { projectRoutes } from './api-projects.ts';
import { fsRoutes } from './api-fs.ts';
import { gitRoutes } from './api-git.ts';
import { sessionRoutes } from './api-sessions.ts';
import { type PollTally, isQuietPoll } from './poll-log.ts';

// The route families moved out of this file by the O8 split (2026-09-23);
// every name importable from server/api.ts before it still is.
export {
  PREFS_MAX_BYTES,
  validMascotPref,
  KEYS_MAX_BYTES,
  KEYS_NOT_AVAILABLE,
  UPDATE_UP_TO_DATE,
  CLIENT_LOG_MAX_BYTES,
  CLIENT_LOG_MAX_ENTRIES,
  CLIENT_LOG_MAX_MESSAGE,
  CLIENT_LOG_MAX_PER_MINUTE,
} from './api-app.ts';
export { GITHUB_REPO_NAME_MAX, GITHUB_TOKEN_MAX_BYTES, GITHUB_TOKEN_MAX_CHARS } from './api-github.ts';
export { MAX_TERM_DIM, CONVERSATION_RUNNING } from './api-sessions.ts';

/**
 * The route families, in the order their blocks stood in handleApi() before
 * the split. First match wins, so this ORDER is the routing table.
 */
const ROUTE_FAMILIES: readonly RouteFamily[] = [
  appRoutes,
  githubRoutes,
  projectRoutes,
  fsRoutes,
  gitRoutes,
  sessionRoutes,
];

/** Anti-framing headers: the authenticated UI must never be embeddable cross-origin. */
const FRAME_PROTECTION_HEADERS = {
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
} as const;

/**
 * For the Vite output under /assets/ only (Quality P3b, 2026-09-23 — P0 found
 * every load re-downloading ~1.2 MB). Safe to cache for a year because every
 * name there carries its content hash (`index-<hash>.js`, the fonts): a
 * restart or update swaps web/dist, a new build gets NEW names, and the
 * `no-store` entry document — fetched fresh every load — is what points at
 * them. A stale asset can never be asked for by a current page.
 */
const HASHED_ASSET_CACHE = 'public, max-age=31536000, immutable';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export interface ApiDeps {
  token: string;
  getPort: () => number;
  /** The startedAt the backend wrote to runtime.json at boot (ISO-8601). */
  getStartedAt: () => string;
  projects: ProjectStore;
  prefs: PrefsStore;
  sessions: SessionManager;
  history: SessionHistory;
  github: GithubConnection;
  /**
   * Stored API keys (server/keys.ts). Absent in unit-test harnesses that build
   * the handler directly: /api/keys then answers 503 instead of pretending
   * there is a store — the same discipline as `restart` and `update` below.
   */
  keys?: KeyStore;
  /**
   * GET /api/tools seam. Absent -> a cache over `probeTools(ptyEnv())`, i.e.
   * the PATH a session is really spawned with. Tests inject a probe with their
   * own environment and clock.
   */
  tools?: () => Promise<ToolAvailability>;
  webDistDir: string;
  /** Short git hash of the running server code, or null (GET /api/runtime). */
  serverCommit?: string | null;
  /**
   * INSTALLED MODE (2026-09-08): the bundle version this process runs from, or
   * null on a developer clone (GET /api/runtime).
   */
  serverVersion?: string | null;
  /** True when this backend runs from an installed bundle (GET /api/runtime). */
  installed?: boolean;
  /** Hashed frontend entry bundle being served, or null (GET /api/runtime). */
  webAsset?: string | null;
  /**
   * Live "is the code on disk newer than this process" probe for
   * GET /api/runtime (server/buildinfo.ts, cached ~5 s). Absent in unit-test
   * harnesses that construct the handler directly: then nothing is ever
   * reported as available.
   */
  checkUpdate?: () => UpdateStatus;
  /**
   * POST /api/update/check (Nocturne B6): run the release check NOW and resolve
   * the SAME composed status `checkUpdate` returns. Absent when this backend has
   * no checker at all (a developer clone, or a bundle whose version is not a
   * release) and in unit-test harnesses: the route then answers 503 instead of
   * pretending. SERIALISATION is the provider's job (server/index.ts shares one
   * in-flight promise), so two windows asking at once ask GitHub once.
   */
  updateCheck?: () => Promise<UpdateStatus>;
  /**
   * The same-port restart mechanism (server/restart.ts). Absent in unit-test
   * harnesses: POST /api/restart then answers 503 instead of pretending.
   */
  restart?: RestartRunner;
  /**
   * IN-APP UPDATE (phase E): the download/verify/install pipeline
   * (server/update-install.ts). Absent in unit-test harnesses and in a
   * developer clone's harnesses: POST /api/update then answers 503 instead of
   * pretending. Present-but-not-installed answers 422 with a plain sentence.
   */
  update?: UpdateRunner;
  log: Logger;
  /**
   * The budget for UNAUTHENTICATED log lines, SHARED with the WebSocket upgrade
   * handler (constructed in server/index.ts). One instance, so the ceiling the
   * README states is the ceiling that holds — two independent limiters would
   * silently double it.
   */
  allowRefusalLine: () => boolean;
  /** Clock SEAM for the client-log budget window; tests inject one. */
  now?: () => number;
  /**
   * The poll counter (server/poll-log.ts), owned and stopped by
   * server/index.ts so shutdown writes the last window.
   */
  polls: PollTally;
}

export function createRequestHandler(
  deps: ApiDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  const { token, projects, prefs, sessions, history, github, keys, webDistDir, log, polls } = deps;
  const tools = deps.tools ?? cachedProbe({ env: () => ptyEnv() });
  const httpLog = scoped(log, 'http');
  const clientLog = scoped(log, 'client');
  /**
   * The Files panel's own lines (B2). WHAT MAY BE WRITTEN, exactly: a listing
   * logs the route, the status and a COUNT — never an entry name; a create logs
   * the KIND and the outcome — never the name the user typed; a git call logs
   * the subcommand and the exit status — never stderr and never a path out of
   * git's output. Directories are not secret (server/sessions.ts already logs
   * `spawned … in <cwd>`); what a user TYPES is, exactly like PTY bytes.
   */
  const fsLog = scoped(log, 'fs');
  const gitLog = scoped(log, 'git');
  /**
   * The registered project roots, as the Files panel's boundary anchors (user
   * decision 2026-09-16). Read from the store on EVERY request and never
   * cached: an anchor list that outlives a `DELETE /api/projects/:id` is a
   * boundary that disagrees with projects.json.
   */
  const projectAnchors = (): string[] => projects.list().map((p) => p.path);

  // Global (all clients) client-log budget: a fixed window, so a runaway page
  // cannot fill the disk. The SAME window machinery the access log uses — one
  // policy, one implementation. State lives with the handler, not a request.
  const allowClientEntry = createWindowLimiter({
    log: clientLog,
    max: CLIENT_LOG_MAX_PER_MINUTE,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    exceeded: (max) =>
      `rate limit reached (${max} entries/minute); ` +
      'further client entries are dropped until the window resets',
    summary: (n) => `suppressed ${n} client log entr(ies) in the last window`,
  });

  // Budget for UNAUTHENTICATED log lines, shared with the ws upgrade handler.
  const allowRefusalLine = deps.allowRefusalLine;

  /**
   * Responses whose request PASSED the token check. Metering is decided on
   * TRUST, not on status: an unauthenticated 200 (`/health`, `/`, a static
   * asset) is just as much a disk-filling primitive as an unauthenticated 404,
   * and an authenticated 4xx is a real diagnostic that must never be dropped.
   */
  const authenticated = new WeakSet<ServerResponse>();

  /** May this response's log line be written? Authenticated: always. */
  const mayLog = (res: ServerResponse): boolean =>
    authenticated.has(res) || allowRefusalLine();

  /**
   * Write one batch of browser log entries into server.log as `[client] …`.
   *
   * Every value here is UNTRUSTED and is normalized rather than refused:
   *   - an unknown/missing `level` becomes 'info';
   *   - an unparsable `at` becomes server time, and a valid one is re-rendered
   *     from Date (so only an ISO string we produced is ever printed) and shown
   *     alongside the server timestamp, which makes clock skew visible;
   *   - `message` is stripped of control characters — a newline would otherwise
   *     forge a second, fully-shaped log line — then truncated to
   *     CLIENT_LOG_MAX_MESSAGE characters;
   *   - past CLIENT_LOG_MAX_ENTRIES the rest of the batch is dropped;
   *   - past CLIENT_LOG_MAX_PER_MINUTE entries in the current minute everything
   *     is dropped, with exactly ONE warn line per window.
   */
  function writeClientLog(entries: unknown[]): void {
    const accepted = entries.slice(0, CLIENT_LOG_MAX_ENTRIES);
    if (entries.length > accepted.length) {
      clientLog(
        'debug',
        `batch of ${entries.length} entries truncated to ${CLIENT_LOG_MAX_ENTRIES}`,
      );
    }
    for (const raw of accepted) {
      if (!allowClientEntry()) continue;
      const entry = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<ClientLogEntry>;
      const level: LogLevel =
        typeof entry.level === 'string' && (LOG_LEVELS as readonly string[]).includes(entry.level)
          ? (entry.level as LogLevel)
          : 'info';
      const message = oneLine(typeof entry.message === 'string' ? entry.message : '').slice(
        0,
        CLIENT_LOG_MAX_MESSAGE,
      );
      let at = new Date().toISOString();
      if (typeof entry.at === 'string' && entry.at.length <= 64) {
        const parsed = Date.parse(entry.at);
        // Re-rendered from the parsed value: only an ISO string WE produced is
        // ever written, so the field cannot smuggle anything into the line.
        if (!Number.isNaN(parsed)) at = new Date(parsed).toISOString();
      }
      clientLog(level, `${message} (client at ${at})`);
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = deps.getPort();
    if (!hostAllowed(req.headers.host, port)) {
      sendError(res, 403, 'forbidden host');
      return;
    }
    const origin = Array.isArray(req.headers.origin)
      ? req.headers.origin[0]
      : req.headers.origin;
    if (!originAllowed(origin, port)) {
      // A refused request that announces a body ends the connection: Node
      // otherwise drains what a caller declared (up to a 50 MiB upload) just to
      // keep a connection alive that this server has already refused.
      if (declaresBody(req)) sendErrorAndClose(res, 403, 'forbidden origin');
      else sendError(res, 403, 'forbidden origin');
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && pathname === '/health') {
      const health: HealthResponse = { ok: true };
      sendJson(res, 200, health);
      return;
    }

    if (pathname.startsWith('/api/')) {
      const provided = req.headers['x-auth-token'];
      const providedToken = Array.isArray(provided) ? provided[0] : provided;
      if (!tokenMatches(token, providedToken)) {
        // Same rule as the Origin gate above: never drain a body for a caller
        // that has already been refused.
        if (declaresBody(req)) sendErrorAndClose(res, 401, 'unauthorized');
        else sendError(res, 401, 'unauthorized');
        return;
      }
      // From here the caller holds the token: its log lines are never metered.
      authenticated.add(res);
      await handleApi(method, pathname, url, req, res);
      return;
    }

    if (method === 'GET' || method === 'HEAD') {
      await serveStatic(pathname, res);
      return;
    }

    sendError(res, 404, 'not found');
  }

  /** What every route family reads (server/api-http.ts ApiContext). */
  const ctx: ApiContext = {
    deps,
    projects,
    prefs,
    sessions,
    history,
    github,
    keys,
    tools,
    log,
    fsLog,
    gitLog,
    projectAnchors,
    writeClientLog,
  };

  async function handleApi(
    method: string,
    pathname: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    for (const routes of ROUTE_FAMILIES) {
      if ((await routes(ctx, method, pathname, url, req, res)) !== NEXT) return;
    }

    sendError(res, 404, 'not found');
  }

  // --- Static frontend ------------------------------------------------------
  async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    // The two UNHASHED entry documents: `index.html` (the app) and
    // `mascot.html` (the peek-mascot page, a second vite entry). Both are
    // `no-store`, because both name HASHED asset bundles that disappear on the
    // next build — a heuristically cached copy would ask for an asset that is
    // gone and render nothing, with no error anywhere. BOTH carry the
    // auth-token placeholder and get it replaced the same way (Nocturne C1:
    // the mascot page polls /api/sessions and /api/prefs), under the same
    // no-store and frame-protection headers — the second page holding the
    // token is guarded exactly like the first, nothing weaker.
    if (pathname === '/' || pathname === '/index.html' || pathname === '/mascot.html') {
      const entry = pathname === '/mascot.html' ? 'mascot.html' : 'index.html';
      try {
        const html = await readFile(join(webDistDir, entry), 'utf8');
        const page = html.replaceAll('__AUTH_TOKEN__', token);
        responseBytes.set(res, Buffer.byteLength(page));
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          ...FRAME_PROTECTION_HEADERS,
        });
        res.end(page);
      } catch {
        sendError(res, 404, 'frontend not built (web/dist missing)');
      }
      return;
    }
    // Path traversal protection: resolve inside webDistDir only.
    const decoded = decodeURIComponent(pathname);
    const resolved = normalize(join(webDistDir, decoded));
    if (!resolved.startsWith(webDistDir + sep)) {
      sendError(res, 403, 'forbidden');
      return;
    }
    // Only a file that EXISTS under web/dist/assets/: a 404 there (sendError
    // below) carries no cache header, so an asset that appears later — a
    // build finishing — is not hidden behind a cached miss.
    const hashed = resolved.startsWith(join(webDistDir, 'assets') + sep);
    try {
      const content = await readFile(resolved);
      responseBytes.set(res, content.byteLength);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(resolved)] ?? 'application/octet-stream',
        ...(hashed ? { 'cache-control': HASHED_ASSET_CACHE } : {}),
        ...FRAME_PROTECTION_HEADERS,
      });
      res.end(content);
    } catch {
      sendError(res, 404, 'not found');
    }
  }

  return (req, res) => {
    // --- ACCESS LOG -------------------------------------------------------
    // One line per request, on completion. WHAT IS DELIBERATELY ABSENT: query
    // STRING values (a query could carry a credential in future — only its
    // presence is noted, as `?…`), request bodies, the Authorization/
    // X-Auth-Token header, and the token itself. Static asset hits log at
    // debug so a page load does not swamp the file.
    //
    // TWO CAPS make this line safe to write for an UNAUTHENTICATED request —
    // and every request is unauthenticated until the token check inside
    // handle() says otherwise: the pathname is truncated to
    // MAX_LOGGED_ROUTE_CHARS (it is attacker-chosen and otherwise unbounded),
    // and the line goes through a per-minute budget (allowRefusalLine) so a
    // page hammering 127.0.0.1 cannot rotate the file away in seconds. The
    // budget keys on TRUST, not on status: `/health` and `/` answer 200 to any
    // no-cors page, so metering only 4xx would leave the hole wide open.
    const startedNs = process.hrtime.bigint();
    const method = req.method ?? '?';
    let route = '?';
    let hasQuery = false;
    try {
      const parsed = new URL(req.url ?? '/', `http://127.0.0.1:${deps.getPort()}`);
      route = parsed.pathname.slice(0, MAX_LOGGED_ROUTE_CHARS);
      hasQuery = parsed.search !== '';
    } catch {
      // Unparseable request target — the route stays unknown rather than raw.
    }
    res.once('close', () => {
      const ms = Number(process.hrtime.bigint() - startedNs) / 1e6;
      const status = res.writableFinished ? res.statusCode : 0;
      const bytes = responseBytes.get(res);
      const reason = responseReason.get(res);
      const note = responseNote.get(res);
      const parts = [
        `${method} ${route}${hasQuery ? ' ?…' : ''} ->`,
        res.writableFinished ? String(status) : 'aborted',
        `in ${ms.toFixed(1)}ms`,
      ];
      if (bytes !== undefined) parts.push(`(${bytes} B)`);
      // reason= is a REFUSAL reason, process-wide: 4xx/5xx only.
      if (status >= 400 && reason !== undefined) parts.push(`reason=${JSON.stringify(reason)}`);
      // note= is the success channel (B6: POST /api/update/check's outcome).
      // A constant string either way, and never on a refusal line.
      if (status < 400 && note !== undefined) parts.push(`note=${JSON.stringify(note)}`);
      // An authenticated request's line is ALWAYS written, whatever its status:
      // a 4xx or 5xx there is a real diagnostic, and its caller already holds
      // the token. Everything else shares the one budget.
      if (!mayLog(res)) return;
      // A successful, prompt poll is counted, not written (Quality P4): the
      // summary line in server/poll-log.ts is its record. A failed or slow
      // one falls through to its own line below, as loud as before.
      if (isQuietPoll(method, route, status, ms)) {
        polls.count(method, route, status);
        return;
      }
      // The log-shipping POST is demoted: it fires every couple of seconds per
      // open window and logging it at info would roughly double the steady
      // state volume of the file it is feeding (its prompt 2xx is counted
      // above; this keeps a SLOW one at debug). The update-progress GET is
      // demoted for the same reason — the UI polls it at 1 Hz for the whole
      // install (and once per page boot), so at info it would bury everything
      // else in the file.
      const quiet =
        route.startsWith('/assets/') ||
        status === 304 ||
        (route === '/api/client-log' && status >= 200 && status < 300) ||
        (route === '/api/update/status' && status === 200) ||
        // The Changes tab polls this every 5 s for as long as it is the
        // visible tab. At info it would bury every other line in the file;
        // anything but a 200 is still info (or error), because a refusal there
        // is the diagnostic.
        (route === '/api/git/changes' && status === 200) ||
        // The Commits tab polls /api/git/commits on the same 5 s rule, and one
        // open commit view fires /api/git/commit-diff once per FILE BLOCK — a
        // 40-file commit is 40 access lines. Same trade as above: only the 200
        // is demoted, a refusal stays info (or error) because that is the
        // diagnostic.
        (route === '/api/git/commits' && status === 200) ||
        (route === '/api/git/commit' && status === 200) ||
        (route === '/api/git/commit-diff' && status === 200) ||
        // One upload per FILE: a 2000-file drop would otherwise write 2000
        // access lines. A refusal there is still info (or error) — that is the
        // diagnostic.
        (route === '/api/fs/upload' && status >= 200 && status < 300) ||
        // An open editor pane polls /api/fs/read every 5 s to follow the file
        // on disk (B4), and a `changed: false` answer is the common one. The
        // save is demoted with it so one Ctrl+S burst does not out-shout the
        // rest of the file; a refusal on either stays info (or error), because
        // that is the diagnostic.
        (route === '/api/fs/read' && status === 200) ||
        (route === '/api/fs/write' && status === 200);
      httpLog(status >= 500 ? 'error' : quiet ? 'debug' : 'info', parts.join(' '));
    });

    handle(req, res).catch((err: unknown) => {
      // NEITHER HALF OF THIS LINE MAY CARRY REQUEST DATA. `String(err)` embeds a
      // fragment of the BODY — Node quotes ~10 characters of the input in a
      // JSON.parse SyntaxError — and `req.url` carries the QUERY STRING. Both
      // land in server.log, which survives into server.log.1 and is readable
      // from Windows whatever its 0600 mode says. So: the error's CLASS name
      // (constant, from the runtime) and the PATHNAME only, which is still
      // enough to find the failing route.
      // The STACK is safe to add (frame lines are file:line only, produced by
      // the runtime) — the MESSAGE is not, and errorFrames() drops it.
      const kind = errorClass(err);
      const frames = errorFrames(err);
      // Reachable without a token (a malformed %-escape in a static path throws
      // a URIError), so an UNAUTHENTICATED throw shares the budget. An
      // authenticated one — a body that fails to parse — is always written.
      if (mayLog(res)) {
        log(
          'error',
          `request ${req.method ?? '?'} ${route} failed (${kind})${frames === '' ? '' : ` ${frames}`}`,
        );
      }
      if (!res.headersSent) {
        sendError(res, 400, 'bad request');
      } else {
        res.end();
      }
    });
  };
}
