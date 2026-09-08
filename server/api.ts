/**
 * REST routes + static serving of the built frontend (web/dist).
 *
 * Every /api route requires "X-Auth-Token: <token>" (timing-safe compare).
 * /health is unauthenticated and returns exactly {"ok":true}.
 * Host must be localhost:<port> or 127.0.0.1:<port>; an Origin header, when
 * present, must be http://localhost:<port> or http://127.0.0.1:<port>.
 *
 * The auth token reaches the UI by serve-time injection: web/dist/index.html
 * contains the literal placeholder __AUTH_TOKEN__ which is replaced when
 * serving / (the injected page is never cacheable).
 *
 * ACCESS LOG (2026-09-06): every request writes ONE line on completion —
 * method, pathname, status, duration, response bytes, and for 4xx/5xx the
 * constant refusal sentence. Never the query string's values (only `?…`),
 * never a body, never a header, never the token. /assets/* logs at debug.
 *
 * POST /api/client-log ships the BROWSER's own log lines into server.log
 * (`[client] …`), because the page's console dies with the tab while
 * server.log is the only channel a detached backend has. Limits and
 * normalization rules live with writeClientLog() below.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type {
  ClientLogEntry,
  ClientLogRequest,
  CloneProjectRequest,
  CreateProjectRequest,
  CreateSessionRequest,
  FsMkdirRequest,
  GithubCloneRequest,
  GithubCreateRepoRequest,
  GithubReposResponse,
  GithubTokenRequest,
  ResumeHistoryRequest,
  RuntimeStatusResponse,
  UpdateStatus,
  UiPrefs,
} from '../shared/protocol.ts';
import { tokenMatches, hostAllowed, originAllowed } from './auth.ts';
import { ProjectStore, isExistingDirectory } from './projects.ts';
import { PrefsStore } from './prefs.ts';
import { SessionManager } from './sessions.ts';
import { SessionHistory } from './history.ts';
import { resumeSpawn } from './conversation.ts';
import { GithubConnection, GithubError, parseGithubRepoPath } from './github.ts';
import { listDirs, mkdirIn, FsBrowseError } from './fsbrowse.ts';
import { createLocalDir, cloneRepo, ScaffoldError } from './scaffold.ts';
import type { RestartRunner } from './restart.ts';
import {
  createWindowLimiter,
  describeError,
  errorClass,
  errorFrames,
  oneLine,
  scoped,
  LOG_LEVELS,
  MAX_LOGGED_ROUTE_CHARS,
  type LogLevel,
  type Logger,
} from './config.ts';

const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_TERM_DIM = 1000;
/** Prefs is a small opaque bag (theme today) — well under the generic cap. */
export const PREFS_MAX_BYTES = 64 * 1024;
/** Bound on a new GitHub repo name (GitHub itself caps at 100; be generous). */
export const GITHUB_REPO_NAME_MAX = 200;
/**
 * Dedicated body cap for POST /api/github/token — NOT the generic 1 MiB. The
 * whole legitimate body is `{"token":"…","remember":true}` with a token of at
 * most 1024 characters, so anything past 4 KiB is refused before it is read
 * into memory, let alone parsed.
 */
export const GITHUB_TOKEN_MAX_BYTES = 4096;
/** Bound on the pasted token itself (mirrors github.ts MAX_PASTED_TOKEN_LEN). */
export const GITHUB_TOKEN_MAX_CHARS = 1024;

// --- POST /api/client-log limits (the contract the frontend codes against) ---
/** Read cap on the batch body; anything larger is 413 before it is parsed. */
export const CLIENT_LOG_MAX_BYTES = 64 * 1024;
/** Entries accepted per request; the remainder of a longer batch is dropped. */
export const CLIENT_LOG_MAX_ENTRIES = 50;
/** Per-entry message cap, in characters. Longer messages are TRUNCATED, not rejected. */
export const CLIENT_LOG_MAX_MESSAGE = 2048;
/** Entries per minute across ALL clients; past this they are dropped (one warn/min). */
export const CLIENT_LOG_MAX_PER_MINUTE = 200;
// Window length: the shared LOG_WINDOW_MS default of createWindowLimiter.

/** Anti-framing headers: the authenticated UI must never be embeddable cross-origin. */
const FRAME_PROTECTION_HEADERS = {
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
} as const;

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
  webDistDir: string;
  /** Short git hash of the running server code, or null (GET /api/runtime). */
  serverCommit?: string | null;
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
   * The same-port restart mechanism (server/restart.ts). Absent in unit-test
   * harnesses: POST /api/restart then answers 503 instead of pretending.
   */
  restart?: RestartRunner;
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
}

/**
 * Bytes and failure reason of a response, recorded where the body is produced
 * so the access log can report them without monkey-patching res.end.
 *
 * The reason is ONLY ever a sendError message, and every one of those is a
 * CONSTANT string in this file (or a constant sentence from GithubError /
 * ScaffoldError / FsBrowseError). Nothing derived from a request body, a query
 * string or a credential is ever stored here — that is the whole reason this is
 * a separate channel instead of "log whatever the handler threw".
 */
const responseBytes = new WeakMap<ServerResponse, number>();
const responseReason = new WeakMap<ServerResponse, string>();

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  onFlushed?: () => void,
): void {
  const text = JSON.stringify(body);
  responseBytes.set(res, Buffer.byteLength(text));
  res.writeHead(status, { 'content-type': 'application/json' });
  // The callback exists for exactly one caller: POST /api/restart, whose
  // process must not leave before the bytes are on the wire.
  if (onFlushed === undefined) res.end(text);
  else res.end(text, onFlushed);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  responseReason.set(res, message);
  sendJson(res, status, { error: message });
}

async function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    bytes += buf.byteLength;
    if (bytes > maxBytes) throw new Error('body too large');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw === '') return {};
  return JSON.parse(raw) as unknown;
}

/**
 * SECRET-SAFE body read: returns a RESULT instead of throwing, so the caller can
 * answer 400 without ever touching the thrown error.
 *
 * WHY THIS EXISTS (measured, not theoretical). `readJsonBody` lets JSON.parse
 * throw, and the generic handler at the bottom of this file logs
 * `request … failed: ${String(err)}`. Node embeds a fragment of the INPUT in
 * that error — `JSON.parse('ghp_S3CRET_TOKEN_VALUE_1234567890')` produces
 * `SyntaxError: Unexpected token 'g', "ghp_S3CRET"... is not valid JSON` — so a
 * malformed POST /api/github/token body would have appended part of the pasted
 * credential to server.log, which survives into server.log.1 and is readable
 * from Windows through \\wsl.localhost\ whatever its 0600 mode says.
 *
 * The error object therefore never leaves this function: the caller learns only
 * WHICH rule failed, never anything derived from the bytes.
 */
type BodyRead = { ok: true; value: unknown } | { ok: false; reason: 'too-large' | 'invalid-json' };

async function readJsonBodySafe(req: IncomingMessage, maxBytes: number): Promise<BodyRead> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      bytes += buf.byteLength;
      if (bytes > maxBytes) return { ok: false, reason: 'too-large' };
      chunks.push(buf);
    }
  } catch {
    // Aborted/!broken request stream. Nothing parsed, nothing to say.
    return { ok: false, reason: 'invalid-json' };
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    // Deliberately NOT rethrown and NOT logged: the caught SyntaxError quotes
    // the input. See the comment above.
    return { ok: false, reason: 'invalid-json' };
  }
}

/** `application/json`, with or without parameters (charset), case-insensitive. */
function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const type = value.split(';')[0]?.trim().toLowerCase();
  return type === 'application/json';
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isValidDim(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_TERM_DIM;
}

/**
 * Derive a display name from a clone url — the last path/host segment with a
 * trailing `.git` stripped (e.g. https://github.com/owner/repo.git -> "repo",
 * git@github.com:owner/repo.git -> "repo"). Purely a display string stored in
 * projects.json; never used as a path. Length-capped. Undefined if empty.
 */
function repoNameFromUrl(url: string): string | undefined {
  const trimmed = url.replace(/[/]+$/, '');
  const segment = trimmed.split(/[/:]/).pop() ?? '';
  const name = segment.replace(/\.git$/i, '').trim();
  return name === '' ? undefined : name.slice(0, 128);
}

export function createRequestHandler(
  deps: ApiDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  const { token, projects, prefs, sessions, history, github, webDistDir, log } = deps;
  const httpLog = scoped(log, 'http');
  const clientLog = scoped(log, 'client');

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
      sendError(res, 403, 'forbidden origin');
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname.startsWith('/api/')) {
      const provided = req.headers['x-auth-token'];
      const providedToken = Array.isArray(provided) ? provided[0] : provided;
      if (!tokenMatches(token, providedToken)) {
        sendError(res, 401, 'unauthorized');
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

  async function handleApi(
    method: string,
    pathname: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // --- Runtime status -----------------------------------------------------
    if (pathname === '/api/runtime') {
      if (method === 'GET') {
        // startedAt + build identity ONLY — port/token/pid stay out of the
        // browser-facing API. The two build fields exist so the UI can tell it
        // is talking to a STALE backend (2026-09-06 incident); they are public
        // build metadata, not secrets.
        const body: RuntimeStatusResponse = {
          startedAt: deps.getStartedAt(),
          serverCommit: deps.serverCommit ?? null,
          webBuild: deps.webAsset ?? null,
          // Computed here, not at boot: the whole point is to notice code that
          // landed AFTER this process started. Cheap (a few stats + .git/HEAD)
          // and cached inside the checker, so a 30 s UI poll costs nothing.
          update: deps.checkUpdate?.() ?? { available: false, reason: null },
        };
        sendJson(res, 200, body);
        return;
      }
      sendError(res, 405, 'method not allowed');
      return;
    }

    // --- Manual restart (same-port handoff) ---------------------------------
    //
    // State-changing, so it sits behind the SAME token + Origin/Host gate as
    // every other /api route (applied above, before handleApi runs). NO BODY IS
    // READ: there is nothing to configure, and not reading is one less parser
    // between an unauthenticated-until-proven caller and a process spawn.
    //
    // The response is the LAST thing this process does: server/restart.ts has
    // already ended the sessions and closed the listener by the time we answer,
    // and its onFlushed hook exits the process once these bytes are out.
    if (pathname === '/api/restart') {
      if (method !== 'POST') {
        sendError(res, 405, 'method not allowed');
        return;
      }
      if (deps.restart === undefined) {
        sendError(res, 503, 'restart is not available in this process');
        return;
      }
      // The socket carrying THIS request is the one exception to the teardown.
      const outcome = await deps.restart.request(req.socket);
      // 202 and 500 both mean this process is leaving; 409 and 422 live on. A
      // dying process must not hand the browser a REUSABLE socket: the very
      // next request is `GET /health`, and on a keep-alive connection it would
      // travel back to THIS process in the window before it exits, answering
      // for a backend on its way out instead of the child that replaced it.
      if (outcome.status === 202 || outcome.status === 500) res.setHeader('connection', 'close');
      if (outcome.status === 202) {
        sendJson(res, 202, outcome.body, outcome.onFlushed ?? undefined);
        return;
      }
      // 409 (one already running), 422 (the preflight refused — this backend is
      // untouched and still serving) and 500 (the handoff failed after the
      // teardown) all carry { error }. The message is a CONSTANT from
      // server/restart.ts — nothing derived from a request — so it is safe in
      // the access log's reason=.
      const error = (outcome.body as { error?: string }).error ?? 'restart failed';
      responseReason.set(res, error);
      sendJson(res, outcome.status, outcome.body, outcome.onFlushed ?? undefined);
      return;
    }

    // --- Client log shipping ------------------------------------------------
    //
    // The browser is only a view, and its console dies with the tab; server.log
    // is the only diagnostic channel that survives. This route lets the UI ship
    // its own lines into it, tagged `[client]`.
    //
    // SECURITY / ABUSE, all enforced below: token auth + Host/Origin parity
    // (inherited from the gate above — any web page can reach this port), a
    // 64 KiB read cap, 50 entries per request, a 2048-character message cap, a
    // 200-entries-per-minute global budget, and control-character stripping so a
    // newline in a message can never forge a second, fake log line.
    if (pathname === '/api/client-log') {
      if (method !== 'POST') {
        sendError(res, 405, 'method not allowed');
        return;
      }
      // Read wrapped: a malformed batch must not reach a logger that would
      // quote its bytes (same rule as /api/github/token).
      const read = await readJsonBodySafe(req, CLIENT_LOG_MAX_BYTES);
      if (!read.ok) {
        if (read.reason === 'too-large') sendError(res, 413, 'request body is too large');
        else sendError(res, 400, 'invalid JSON body');
        return;
      }
      const body = read.value;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        sendError(res, 400, 'invalid JSON body');
        return;
      }
      const entries = (body as Partial<ClientLogRequest>).entries;
      if (!Array.isArray(entries)) {
        sendError(res, 400, 'entries must be an array');
        return;
      }
      writeClientLog(entries);
      res.writeHead(204);
      res.end();
      return;
    }

    // --- UI prefs (opaque bag; server never interprets contents) -----------
    if (pathname === '/api/prefs') {
      if (method === 'GET') {
        sendJson(res, 200, prefs.get());
        return;
      }
      if (method === 'PUT') {
        const body = await readJsonBody(req, PREFS_MAX_BYTES);
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          sendError(res, 400, 'prefs body must be a JSON object');
          return;
        }
        prefs.replace(body as UiPrefs);
        sendJson(res, 200, { ok: true });
        return;
      }
      sendError(res, 405, 'method not allowed');
      return;
    }

    // --- GitHub connection (device flow OR a pasted token) -----------------
    // The credential stays 100% server-side (github.ts / github.json, 0600).
    // These handlers only ever surface status, the user_code, and repo
    // metadata — never the token, in any form.
    if (pathname === '/api/github/status') {
      if (method === 'GET') {
        sendJson(res, 200, github.status());
        return;
      }
      sendError(res, 405, 'method not allowed');
      return;
    }

    if (pathname === '/api/github/device') {
      if (method === 'POST') {
        const result = await github.startDeviceFlow();
        if (result.ok) {
          sendJson(res, 200, {
            userCode: result.userCode,
            verificationUri: result.verificationUri,
            expiresAt: result.expiresAt,
          });
          return;
        }
        if (result.reason === 'not-configured') {
          sendJson(res, 409, { deviceFlowAvailable: false });
          return;
        }
        sendError(res, 502, 'failed to start github device flow');
        return;
      }
      sendError(res, 405, 'method not allowed');
      return;
    }

    // --- Connect with a PASTED GitHub token (the second credential path) ----
    //
    // SECURITY, in the order the checks run — every one of these is load-bearing
    // and was specified by a design gate that ran BEFORE this code existed:
    //
    //   * POST ONLY. A GET would put the credential in the request line, and
    //     from there into access logs, history and referrers. 405 otherwise.
    //   * The BODY is the only ingress. Nothing here reads the query string, a
    //     path segment, or a header of our own — so no copy of the token exists
    //     anywhere a URL is recorded.
    //   * `content-type: application/json` required (415 otherwise), so a form
    //     post or a text/plain drive-by never even reaches the parser.
    //   * A DEDICATED 4 KiB body cap, not the generic 1 MiB.
    //   * The body read is wrapped HERE (readJsonBodySafe) and its error is
    //     never rethrown and never logged — a JSON.parse error quotes the input,
    //     which for this route is the credential itself.
    //   * Log lines are CONSTANT strings ('github token accepted' / 'github
    //     token rejected', emitted inside github.ts). Never the token, its
    //     length, its prefix, the body, or GitHub's response body.
    //   * NO response on ANY path carries the token, a fragment, a length or a
    //     masked form: success answers the same GithubStatus the status route
    //     does, and every failure answers a fixed sentence.
    //
    // Inherited unchanged from the surrounding gate: X-Auth-Token + Host/Origin
    // parity (checked before this handler runs).
    if (pathname === '/api/github/token') {
      if (method !== 'POST') {
        sendError(res, 405, 'method not allowed');
        return;
      }
      const contentType = Array.isArray(req.headers['content-type'])
        ? req.headers['content-type'][0]
        : req.headers['content-type'];
      if (!isJsonContentType(contentType)) {
        sendError(res, 415, 'content-type must be application/json');
        return;
      }
      const read = await readJsonBodySafe(req, GITHUB_TOKEN_MAX_BYTES);
      if (!read.ok) {
        if (read.reason === 'too-large') {
          sendError(res, 413, 'request body is too large');
        } else {
          sendError(res, 400, 'invalid JSON body');
        }
        return;
      }
      const body = read.value;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        sendError(res, 400, 'invalid JSON body');
        return;
      }
      const parsed = body as Partial<GithubTokenRequest>;
      if (typeof parsed.token !== 'string' || parsed.token.trim() === '') {
        sendError(res, 400, 'token is required');
        return;
      }
      // Length is checked WITHOUT quoting any part of the value.
      if (parsed.token.length > GITHUB_TOKEN_MAX_CHARS) {
        sendError(res, 400, `token must be at most ${GITHUB_TOKEN_MAX_CHARS} characters`);
        return;
      }
      if (typeof parsed.remember !== 'boolean') {
        sendError(res, 400, 'remember must be a boolean');
        return;
      }
      try {
        const result = await github.connectWithToken(parsed.token, parsed.remember);
        if (result.ok) {
          sendJson(res, 200, result.status);
        } else {
          sendError(res, result.status, result.message);
        }
      } catch {
        // Nothing here throws today, and if it ever does the error must not
        // reach the generic logger below — it could have the body in scope.
        log('error', 'github token request failed');
        sendError(res, 502, 'failed to verify the token with GitHub');
      }
      return;
    }

    if (pathname === '/api/github/disconnect') {
      if (method === 'POST') {
        await github.disconnect();
        sendJson(res, 200, { ok: true });
        return;
      }
      sendError(res, 405, 'method not allowed');
      return;
    }

    if (pathname === '/api/github/repos') {
      if (method === 'GET') {
        const q = url.searchParams.get('q') ?? undefined;
        try {
          const body: GithubReposResponse = { repos: await github.listRepos(q) };
          sendJson(res, 200, body);
        } catch (err) {
          if (err instanceof GithubError) {
            sendError(res, err.status, err.message);
          } else {
            log('error', 'github repos request failed');
            sendError(res, 502, 'failed to list github repositories');
          }
        }
        return;
      }
      // Create a new GitHub repo. Token stays server-side (Authorization header
      // only, inside github.ts). The frontend chains create -> clone; this does
      // NOT auto-clone.
      if (method === 'POST') {
        const body = (await readJsonBody(req)) as Partial<GithubCreateRepoRequest>;
        if (typeof body.name !== 'string' || body.name.trim() === '') {
          sendError(res, 400, 'name is required');
          return;
        }
        if (body.name.length > GITHUB_REPO_NAME_MAX) {
          sendError(res, 400, `name must be at most ${GITHUB_REPO_NAME_MAX} characters`);
          return;
        }
        if (typeof body.private !== 'boolean') {
          sendError(res, 400, 'private must be a boolean');
          return;
        }
        if (body.description !== undefined && typeof body.description !== 'string') {
          sendError(res, 400, 'description must be a string');
          return;
        }
        try {
          const repo = await github.createRepo({
            name: body.name.trim(),
            private: body.private,
            ...(body.description !== undefined ? { description: body.description } : {}),
          });
          sendJson(res, 201, repo);
        } catch (err) {
          if (err instanceof GithubError) {
            sendError(res, err.status, err.message);
          } else {
            log('error', 'github create repo request failed');
            sendError(res, 502, 'failed to create github repository');
          }
        }
        return;
      }
      sendError(res, 405, 'method not allowed');
      return;
    }

    // --- Clone a connected user's repo (token-authenticated) into a project --
    // The stored credential (device flow OR pasted token — the clone path does
    // not care which) is used server-side via GIT_ASKPASS-through-env; it
    // never reaches argv, the clone url, .git/config, a response, or the log.
    if (pathname === '/api/github/clone') {
      if (method === 'POST') {
        const body = (await readJsonBody(req)) as Partial<GithubCloneRequest>;
        if (typeof body.cloneUrl !== 'string' || body.cloneUrl === '') {
          sendError(res, 400, 'cloneUrl is required');
          return;
        }
        // Absolute AND already normalized. A dest carrying a `..`/`.` component
        // (or a trailing slash) READS as one directory and RESOLVES to another,
        // which is exactly what would let the clone's own failure cleanup act on
        // a directory this request never created. Refused at the boundary, in
        // the existing 400 vocabulary; github.ts normalizes again so in-process
        // callers get the same guarantee. REJECTING is right HERE and only
        // here: this dest is app-generated (`<projects>/<owner>/<repo>` from
        // the repo list), so no legitimate value ever carries a `..`. The two
        // /api/projects routes below take user-typed destinations that are
        // already stored in projects.json, so they NORMALIZE instead of
        // refusing — see PATH NORMALIZATION in server/scaffold.ts.
        if (
          typeof body.dest !== 'string' ||
          !isAbsolute(body.dest) ||
          resolve(body.dest) !== body.dest
        ) {
          sendError(res, 400, 'dest must be an absolute path');
          return;
        }
        if (body.name !== undefined && typeof body.name !== 'string') {
          sendError(res, 400, 'name must be a string');
          return;
        }
        try {
          await github.cloneAuthenticated(body.cloneUrl, body.dest);
        } catch (err) {
          if (err instanceof GithubError) {
            sendError(res, err.status, err.message);
          } else {
            log('error', 'github clone failed');
            sendError(res, 502, 'failed to clone repository');
          }
          return;
        }
        // OWNER-QUALIFIED NAMES (settled 2026-07-25). The UI shows project NAMES
        // everywhere, so `acme/api` and `myorg/api` must not both register as
        // "api". The repo basename is kept while it is free; the moment a project
        // already carries that name, THIS clone registers as `<owner>/<repo>`,
        // derived from the (already host-locked) clone url. Deterministic — no
        // counters, no timestamps, no reordering of the existing name precedence
        // (explicit name → url-derived → dest basename). If `<owner>/<repo>` is
        // itself taken (same repo registered twice at different paths) that name
        // is still used rather than inventing a suffix.
        const preferred =
          body.name !== undefined && body.name.trim() !== ''
            ? body.name.trim()
            : (repoNameFromUrl(body.cloneUrl) ?? basename(body.dest));
        const qualified = parseGithubRepoPath(body.cloneUrl);
        const taken = projects.list().some((p) => p.name === preferred);
        const name =
          taken && qualified !== undefined ? `${qualified.owner}/${qualified.repo}` : preferred;
        const project = projects.create({ name, path: body.dest });
        sendJson(res, 201, project);
        return;
      }
      sendError(res, 405, 'method not allowed');
      return;
    }

    // --- Projects -----------------------------------------------------------
    if (pathname === '/api/projects') {
      if (method === 'GET') {
        sendJson(res, 200, projects.list());
        return;
      }
      if (method === 'POST') {
        const body = (await readJsonBody(req)) as Partial<CreateProjectRequest>;
        if (typeof body.name !== 'string' || body.name.trim() === '') {
          sendError(res, 400, 'name is required');
          return;
        }
        if (typeof body.path !== 'string') {
          sendError(res, 400, 'path must be an absolute path to an existing directory');
          return;
        }
        // Validate the cheap fields BEFORE any filesystem side effect, so a bad
        // defaultMode never leaves a freshly created directory behind.
        if (body.defaultModel !== undefined && typeof body.defaultModel !== 'string') {
          sendError(res, 400, 'defaultModel must be a string');
          return;
        }
        if (
          body.defaultMode !== undefined &&
          body.defaultMode !== 'standard' &&
          body.defaultMode !== 'skip-permissions'
        ) {
          sendError(res, 400, "defaultMode must be 'standard' or 'skip-permissions'");
          return;
        }
        if (body.create !== undefined && typeof body.create !== 'boolean') {
          sendError(res, 400, 'create must be a boolean');
          return;
        }
        if (body.gitInit !== undefined && typeof body.gitInit !== 'boolean') {
          sendError(res, 400, 'gitInit must be a boolean');
          return;
        }
        let createdPath = body.path;
        if (body.create === true) {
          // CREATE mode: make the directory (mkdir recursive, no clobber), then
          // register it. gitInit defaults to true.
          //
          // NORMALIZE, DON'T REJECT (deliberate; the mirror of the
          // /api/github/clone dest guard above, which 400s an un-normalized
          // dest). createLocalDir resolves the path before any filesystem
          // decision and RETURNS what it created, and that resolved value is
          // what gets registered — so the directory git ran in, the one a
          // failed `git init` may clean up, and the one in projects.json can
          // never be three different places. Rationale for the split: see
          // PATH NORMALIZATION in server/scaffold.ts.
          try {
            createdPath = await createLocalDir(body.path, body.gitInit ?? true);
          } catch (err) {
            if (err instanceof ScaffoldError) {
              sendError(res, err.status, err.message);
            } else {
              log('error', `createLocalDir failed: ${describeError(err)}`);
              sendError(res, 500, 'failed to create project directory');
            }
            return;
          }
        } else if (!isExistingDirectory(body.path)) {
          // REGISTER mode (default): path must already be an existing directory.
          sendError(res, 400, 'path must be an absolute path to an existing directory');
          return;
        }
        const project = projects.create({
          name: body.name.trim(),
          path: createdPath,
          ...(body.defaultModel !== undefined ? { defaultModel: body.defaultModel } : {}),
          ...(body.defaultMode !== undefined ? { defaultMode: body.defaultMode } : {}),
        });
        sendJson(res, 201, project);
        return;
      }
      sendError(res, 405, 'method not allowed');
      return;
    }

    // --- Clone a repo into a new project directory --------------------------
    // MUST precede the /api/projects/:id matcher below, else "clone" is read as
    // a project id.
    if (pathname === '/api/projects/clone') {
      if (method === 'POST') {
        const body = (await readJsonBody(req)) as Partial<CloneProjectRequest>;
        if (typeof body.url !== 'string' || body.url === '') {
          sendError(res, 400, 'url is required');
          return;
        }
        if (typeof body.dest !== 'string' || !isAbsolute(body.dest)) {
          sendError(res, 400, 'dest must be an absolute path');
          return;
        }
        if (body.name !== undefined && typeof body.name !== 'string') {
          sendError(res, 400, 'name must be a string');
          return;
        }
        // NORMALIZE, DON'T REJECT (deliberate; /api/github/clone above 400s an
        // un-normalized dest instead). cloneRepo resolves the dest before any
        // filesystem decision and RETURNS it, and every value derived below —
        // the fallback name and the registered path — comes from that resolved
        // dest, never from the raw string. Rationale for the split: see PATH
        // NORMALIZATION in server/scaffold.ts.
        let destAbs: string;
        try {
          destAbs = await cloneRepo(body.url, body.dest);
        } catch (err) {
          if (err instanceof ScaffoldError) {
            sendError(res, err.status, err.message);
          } else {
            log('error', 'clone failed');
            sendError(res, 500, 'failed to clone repository');
          }
          return;
        }
        const name =
          body.name !== undefined && body.name.trim() !== ''
            ? body.name.trim()
            : (repoNameFromUrl(body.url) ?? basename(destAbs));
        const project = projects.create({ name, path: destAbs });
        sendJson(res, 201, project);
        return;
      }
      sendError(res, 405, 'method not allowed');
      return;
    }

    const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(pathname);
    if (projectMatch !== null) {
      const id = decodeURIComponent(projectMatch[1] as string);
      if (method === 'DELETE') {
        if (!projects.remove(id)) {
          sendError(res, 404, 'project not found');
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      sendError(res, 405, 'method not allowed');
      return;
    }

    // --- Filesystem browsing ------------------------------------------------
    if (pathname === '/api/fs/list') {
      if (method === 'GET') {
        const requested = url.searchParams.get('path') ?? undefined;
        try {
          sendJson(res, 200, listDirs(requested));
        } catch (err) {
          if (err instanceof FsBrowseError) {
            sendError(res, err.status, err.message);
          } else {
            log('error', `fs list failed: ${describeError(err)}`);
            sendError(res, 500, 'failed to list directory');
          }
        }
        return;
      }
      sendError(res, 405, 'method not allowed');
      return;
    }

    // --- Filesystem: make a single subdirectory (folder-picker mkdir) -------
    if (pathname === '/api/fs/mkdir') {
      if (method === 'POST') {
        const body = (await readJsonBody(req)) as Partial<FsMkdirRequest>;
        if (typeof body.parent !== 'string') {
          sendError(res, 400, 'parent must be an absolute path to an existing directory');
          return;
        }
        if (typeof body.name !== 'string') {
          sendError(res, 400, 'name must be a single safe path segment');
          return;
        }
        try {
          sendJson(res, 201, mkdirIn(body.parent, body.name));
        } catch (err) {
          if (err instanceof FsBrowseError) {
            sendError(res, err.status, err.message);
          } else {
            log('error', `mkdir failed: ${describeError(err)}`);
            sendError(res, 500, 'failed to create directory');
          }
        }
        return;
      }
      sendError(res, 405, 'method not allowed');
      return;
    }

    // --- Sessions -----------------------------------------------------------
    if (pathname === '/api/sessions') {
      if (method === 'GET') {
        sendJson(res, 200, sessions.list());
        return;
      }
      if (method === 'POST') {
        const body = (await readJsonBody(req)) as Partial<CreateSessionRequest>;
        if (typeof body.command !== 'string' || body.command === '') {
          sendError(res, 400, 'command is required');
          return;
        }
        if (!isStringArray(body.args)) {
          sendError(res, 400, 'args must be an array of strings');
          return;
        }
        if (!isValidDim(body.cols) || !isValidDim(body.rows)) {
          sendError(res, 400, `cols and rows must be integers between 1 and ${MAX_TERM_DIM}`);
          return;
        }
        if (body.title !== undefined && typeof body.title !== 'string') {
          sendError(res, 400, 'title must be a string');
          return;
        }
        let projectId: string | undefined;
        let projectPath: string | undefined;
        let projectName: string | undefined;
        if (body.projectId !== undefined) {
          if (typeof body.projectId !== 'string') {
            sendError(res, 400, 'projectId must be a string');
            return;
          }
          const project = projects.get(body.projectId);
          if (project === undefined) {
            sendError(res, 400, 'unknown projectId');
            return;
          }
          projectId = project.id;
          projectPath = project.path;
          projectName = project.name;
        }
        let cwd: string | undefined;
        if (body.cwd !== undefined) {
          if (typeof body.cwd !== 'string' || !isExistingDirectory(body.cwd)) {
            sendError(res, 400, 'cwd must be an absolute path to an existing directory');
            return;
          }
          cwd = body.cwd;
        } else {
          cwd = projectPath;
        }
        if (cwd === undefined) {
          sendError(res, 400, 'cwd or projectId is required');
          return;
        }
        // Default title: the PROJECT's name (what the launch dialog's
        // placeholder promises), not the literal command name. With no project
        // resolved SessionManager falls back to the cwd's last segment — the
        // folder the user picked, the same name HISTORY groups it under, and
        // never a command name in the chrome (UI copy rule).
        const givenTitle = typeof body.title === 'string' && body.title.trim() !== ''
          ? body.title.trim()
          : undefined;
        const title = givenTitle ?? projectName;
        try {
          const info = sessions.create({
            ...(projectId !== undefined ? { projectId } : {}),
            cwd,
            command: body.command,
            args: body.args,
            ...(title !== undefined ? { title } : {}),
            cols: body.cols,
            rows: body.rows,
          });
          sendJson(res, 201, info);
        } catch (err) {
          log('error', `session spawn failed: ${describeError(err)}`);
          sendError(res, 500, 'could not start the session');
        }
        return;
      }
      sendError(res, 405, 'method not allowed');
      return;
    }

    // --- Session history (history.json, across runs) ------------------------
    if (pathname === '/api/history') {
      if (method === 'GET') {
        sendJson(res, 200, history.list());
        return;
      }
      if (method === 'DELETE') {
        history.forgetAllEnded();
        sendJson(res, 200, { ok: true });
        return;
      }
      sendError(res, 405, 'method not allowed');
      return;
    }

    const historyMatch = /^\/api\/history\/([^/]+)(\/resume)?$/.exec(pathname);
    if (historyMatch !== null) {
      const id = decodeURIComponent(historyMatch[1] as string);
      const isResume = historyMatch[2] === '/resume';
      if (isResume && method !== 'POST') {
        sendError(res, 405, 'method not allowed');
        return;
      }
      if (!isResume && method !== 'DELETE') {
        sendError(res, 405, 'method not allowed');
        return;
      }
      const entry = history.get(id);
      if (entry === undefined) {
        sendError(res, 404, 'history entry not found');
        return;
      }
      if (!isResume) {
        // DELETE: a live entry is not forgettable — its session is running.
        if (entry.ended === null) {
          sendError(res, 409, 'that session is still running');
          return;
        }
        history.forget(id);
        sendJson(res, 200, { ok: true });
        return;
      }
      const body = (await readJsonBody(req)) as Partial<ResumeHistoryRequest>;
      if (!isValidDim(body.cols) || !isValidDim(body.rows)) {
        sendError(res, 400, `cols and rows must be integers between 1 and ${MAX_TERM_DIM}`);
        return;
      }
      if (entry.ended === null) {
        sendError(res, 409, 'that session is still running');
        return;
      }
      if (!isExistingDirectory(entry.cwd)) {
        sendError(res, 400, 'the folder this session ran in no longer exists');
        return;
      }
      // A project deleted since the launch must not resurrect its id.
      const projectId =
        entry.projectId !== undefined && projects.get(entry.projectId) !== undefined
          ? entry.projectId
          : undefined;
      const spawn = resumeSpawn(entry);
      try {
        const info = sessions.create({
          ...(projectId !== undefined ? { projectId } : {}),
          cwd: entry.cwd,
          command: spawn.command,
          args: spawn.args,
          title: entry.title,
          cols: body.cols,
          rows: body.rows,
          historyId: entry.id,
        });
        sendJson(res, 201, info);
      } catch (err) {
        log('error', `history resume spawn failed: ${describeError(err)}`);
        sendError(res, 500, 'could not start the session');
      }
      return;
    }

    const sessionMatch = /^\/api\/sessions\/([^/]+)(\/seen)?$/.exec(pathname);
    if (sessionMatch !== null) {
      const id = decodeURIComponent(sessionMatch[1] as string);
      const isSeen = sessionMatch[2] === '/seen';
      if (isSeen && method === 'POST') {
        if (!sessions.markSeen(id)) {
          sendError(res, 404, 'session not found');
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      if (!isSeen && method === 'DELETE') {
        if (!sessions.destroy(id)) {
          sendError(res, 404, 'session not found');
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      sendError(res, 405, 'method not allowed');
      return;
    }

    sendError(res, 404, 'not found');
  }

  // --- Static frontend ------------------------------------------------------
  async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    if (pathname === '/' || pathname === '/index.html') {
      try {
        const html = await readFile(join(webDistDir, 'index.html'), 'utf8');
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
    try {
      const content = await readFile(resolved);
      responseBytes.set(res, content.byteLength);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(resolved)] ?? 'application/octet-stream',
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
      const parts = [
        `${method} ${route}${hasQuery ? ' ?…' : ''} ->`,
        res.writableFinished ? String(status) : 'aborted',
        `in ${ms.toFixed(1)}ms`,
      ];
      if (bytes !== undefined) parts.push(`(${bytes} B)`);
      if (status >= 400 && reason !== undefined) parts.push(`reason=${JSON.stringify(reason)}`);
      // An authenticated request's line is ALWAYS written, whatever its status:
      // a 4xx or 5xx there is a real diagnostic, and its caller already holds
      // the token. Everything else shares the one budget.
      if (!mayLog(res)) return;
      // The log-shipping POST is demoted: it fires every couple of seconds per
      // open window and logging it at info would roughly double the steady
      // state volume of the file it is feeding.
      const quiet =
        route.startsWith('/assets/') ||
        status === 304 ||
        (route === '/api/client-log' && status >= 200 && status < 300);
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
