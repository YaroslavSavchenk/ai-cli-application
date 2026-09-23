/**
 * The app's own /api routes: runtime status, the manual restart, the in-app
 * update (install, progress, check now), client log shipping, UI prefs, the
 * launchable-tools probe and the stored API keys — with the limits and
 * constant sentences those routes own.
 *
 * Split from server/api.ts (O8, 2026-09-23): a pure move, behaviour and
 * error sentences unchanged. Siblings: server/api.ts (dispatcher, gates,
 * access log, static serving), api-http.ts (shared response/body plumbing),
 * api-app.ts, api-github.ts, api-projects.ts, api-fs.ts, api-git.ts,
 * api-sessions.ts (one route family each).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ClientLogRequest,
  RuntimeStatusResponse,
  SaveKeyRequest,
  UiPrefs,
} from '../shared/protocol.ts';
import { isKeyedTool } from '../shared/protocol.ts';
import { ptyEnv } from './sessions.ts';
import { KEY_NOT_SHAPED, KEY_UNKNOWN_TOOL } from './keys.ts';
import { UPDATE_BLOCKS_RESTART, UPDATE_NOT_AVAILABLE } from './update-install.ts';
import { isJsonContentType } from './config.ts';
import {
  NEXT,
  readJsonBody,
  readJsonBodySafe,
  responseNote,
  responseReason,
  sendError,
  sendJson,
  type ApiContext,
  type RouteResult,
} from './api-http.ts';

/** Prefs is a small opaque bag (theme, statusLine, behaviour, tools, mascot …) — well under the generic cap. */
export const PREFS_MAX_BYTES = 64 * 1024;

/**
 * Nocturne C1 (PLAN-C1.md § The toggle): the `mascot` prefs key is absent, or
 * exactly `{ enabled: boolean }` — a plain object with that one key and a real
 * boolean (no `"false"`, no `0`, no null, no extra keys). Anything else would
 * reach /mascot.html as a value it has to guess at.
 */
export function validMascotPref(v: unknown): boolean {
  if (v === undefined) return true;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && keys[0] === 'enabled' && typeof (v as { enabled: unknown }).enabled === 'boolean';
}
/**
 * Dedicated body cap for PUT /api/keys/:tool — NOT the generic 1 MiB. The whole
 * legitimate body is `{"key":"…"}` with a key of at most KEY_MAX_CHARS (4096),
 * so anything past 8 KiB is refused before it is read into memory.
 */
export const KEYS_MAX_BYTES = 8192;
/** A unit harness built the handler without a KeyStore (cf. ApiDeps.restart). */
export const KEYS_NOT_AVAILABLE = 'key storage is not available in this process';
/**
 * What POST /api/update/check puts in the access line's note= when the check
 * came back with nothing to offer (`UpdateStatus.reason === null`). A CONSTANT,
 * like every other logged value — the remote release never names itself in the
 * log.
 */
export const UPDATE_UP_TO_DATE = 'up to date';

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

/** GET /api/runtime, POST /api/restart, /api/update*, /api/client-log, /api/prefs, /api/tools, /api/keys*. */
export async function appRoutes(
  ctx: ApiContext,
  method: string,
  pathname: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<RouteResult> {
  const { deps, prefs, tools, keys, writeClientLog } = ctx;

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
        version: deps.serverVersion ?? null,
        installed: deps.installed ?? false,
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
  // every other /api route (applied in server/api.ts, before handleApi runs). NO BODY IS
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
    // AN INSTALL IN FLIGHT OUTRANKS A RESTART. The handoff ends this process,
    // and the child wipes <dataDir>/updates at boot — so a restart started
    // while the Setup is being downloaded, verified or run would delete the
    // half-written `.part` (or abandon a running Setup) with nothing left to
    // report it. Same 409 shape as "another restart is in flight", which is
    // exactly how the UI already reads it.
    if (deps.update?.holdsProcess === true) {
      responseReason.set(res, UPDATE_BLOCKS_RESTART);
      sendJson(res, 409, { error: UPDATE_BLOCKS_RESTART });
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

  // --- In-app update (download + verify + run the Setup on Windows) -------
  //
  // Same gate as every other /api route (token + Origin/Host parity, applied
  // before handleApi runs) and, like /api/restart, NO BODY IS READ: the only
  // thing this route can start is the update the backend itself found and
  // gated in server/update-release.ts. A periodic check can never install
  // anything — only this user-initiated POST can.
  if (pathname === '/api/update') {
    if (method !== 'POST') {
      sendError(res, 405, 'method not allowed');
      return;
    }
    if (deps.update === undefined) {
      sendError(res, 503, UPDATE_NOT_AVAILABLE);
      return;
    }
    const outcome = await deps.update.request();
    if (outcome.status === 202) {
      sendJson(res, 202, outcome.body);
      return;
    }
    // 409 (one already running) and 422 (nothing to install / not an
    // installed app) both carry { error } — a CONSTANT sentence from
    // server/update-install.ts, so it is safe in the access log's reason=.
    const error = (outcome.body as { error?: string }).error ?? 'update refused';
    responseReason.set(res, error);
    sendJson(res, outcome.status, outcome.body);
    return;
  }

  // Progress readout: polled at 1 Hz while busy and once at page boot, so a
  // reload adopts an install that is already running. Constant sentences
  // only (UPDATE_ERROR_* in shared/protocol.ts) — never remote text.
  if (pathname === '/api/update/status') {
    if (method !== 'GET') {
      sendError(res, 405, 'method not allowed');
      return;
    }
    if (deps.update === undefined) {
      sendError(res, 503, UPDATE_NOT_AVAILABLE);
      return;
    }
    sendJson(res, 200, deps.update.status());
    return;
  }

  // --- Check for updates now (Nocturne B6) --------------------------------
  //
  // Same gate as every other /api route and, like /api/update, NO BODY IS
  // READ: this route takes no arguments — it only asks, right now, the
  // question the backend otherwise asks on a timer.
  //
  // A FAILED CHECK IS NOT A 5xx. ReleaseChecker.checkNow() resolves whatever
  // happened (a network failure is a log line of its own), so the answer is
  // the LAST known status and the UI can say "nothing new" without inventing
  // an error it cannot explain.
  if (pathname === '/api/update/check') {
    if (method !== 'POST') {
      sendError(res, 405, 'method not allowed');
      return;
    }
    if (deps.updateCheck === undefined) {
      sendError(res, 503, UPDATE_NOT_AVAILABLE);
      return;
    }
    const status = await deps.updateCheck();
    // The outcome rides the ONE access line rather than a second log line —
    // as note=, NOT reason=: this is a 200, and reason= means "refused"
    // everywhere else in the file. `status.reason` is a constant sentence from
    // shared/protocol.ts (or null), never text from the GitHub payload.
    responseNote.set(res, status.reason ?? UPDATE_UP_TO_DATE);
    sendJson(res, 200, status);
    return;
  }

  // --- Client log shipping ------------------------------------------------
  //
  // The browser is only a view, and its console dies with the tab; server.log
  // is the only diagnostic channel that survives. This route lets the UI ship
  // its own lines into it, tagged `[client]`.
  //
  // SECURITY / ABUSE, all enforced below: token auth + Host/Origin parity
  // (inherited from the gate in server/api.ts — any web page can reach this port), a
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

  // --- UI prefs (opaque bag; only `mascot`'s shape is checked, C1) -------
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
      // The bag stays opaque except for the one key the server now vets
      // (Nocturne C1, PLAN-C1.md § The toggle): `mascot`, when present, is
      // exactly `{ enabled: boolean }`.
      if (!validMascotPref((body as Record<string, unknown>)['mascot'])) {
        sendError(res, 400, 'prefs.mascot must be {"enabled": true|false}');
        return;
      }
      prefs.replace(body as UiPrefs);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }

  // --- Launchable tools: a PATH probe of the spawn environment ------------
  // No spawn, no shell, no network (server/tools.ts); cached ≤ 5 s, and
  // AWAITED — the probe stats every PATH entry and must not hold the loop.
  if (pathname === '/api/tools') {
    if (method === 'GET') {
      sendJson(res, 200, await tools());
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }

  // --- Stored API keys (Nocturne B5) --------------------------------------
  //
  // The same secret discipline as POST /api/github/token, for the same
  // reason — a credential arrives in the BODY and nowhere else:
  //   * GET answers saved/not-saved only. No route here ever returns a key,
  //     in any form, not even to the authenticated page that saved it.
  //   * the body read is readJsonBodySafe with a dedicated small cap, so a
  //     malformed body can never put a JSON.parse error quoting the key into
  //     server.log.
  //   * content-type must be application/json: a cross-site form post cannot
  //     set that header, so the Origin/Host checks are not the only guard.
  //   * KeyStore logs the tool name and nothing else.
  if (pathname === '/api/keys') {
    if (method === 'GET') {
      if (keys === undefined) {
        sendError(res, 503, KEYS_NOT_AVAILABLE);
        return;
      }
      // The environment a session is really spawned with — otherwise the page
      // would be told about a variable the CLI never sees.
      sendJson(res, 200, keys.status(ptyEnv()));
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }

  const keyMatch = /^\/api\/keys\/([^/]+)$/.exec(pathname);
  if (keyMatch !== null) {
    if (method !== 'PUT' && method !== 'DELETE') {
      sendError(res, 405, 'method not allowed');
      return;
    }
    if (keys === undefined) {
      sendError(res, 503, KEYS_NOT_AVAILABLE);
      return;
    }
    const tool = decodeURIComponent(keyMatch[1] as string);
    if (!isKeyedTool(tool)) {
      sendError(res, 400, KEY_UNKNOWN_TOOL);
      return;
    }
    if (method === 'DELETE') {
      keys.clear(tool);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (!isJsonContentType(req.headers['content-type'])) {
      sendError(res, 415, 'content-type must be application/json');
      return;
    }
    const read = await readJsonBodySafe(req, KEYS_MAX_BYTES);
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
    // KeyStore validates and logs `key rejected for <tool>`; the value itself
    // never leaves this statement.
    if (!keys.save(tool, (body as Partial<SaveKeyRequest>).key)) {
      sendError(res, 400, KEY_NOT_SHAPED);
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  return NEXT;
}
