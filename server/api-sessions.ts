/**
 * The session /api routes: list and create sessions (the spawn request), the
 * cross-run history (list, forget, resume) and one session's seen/delete —
 * plus the terminal-size bound the WebSocket layer shares.
 *
 * Q17 (.claude/plans/quality/PLAN-Q17.md § P1 3) added /api/previous-exit:
 * the previous run's notice, the resume of its sessions (the history resume
 * path, `resumeEntry`) and its dismissal.
 *
 * Split from server/api.ts (O8, 2026-09-23): a pure move, behaviour and
 * error sentences unchanged. Siblings: server/api.ts (dispatcher, gates,
 * access log, static serving), api-http.ts (shared response/body plumbing),
 * api-app.ts, api-github.ts, api-projects.ts, api-fs.ts, api-git.ts,
 * api-sessions.ts (one route family each).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { TITLE_MAX_CHARS } from '../shared/protocol.ts';
import type {
  CreateSessionRequest,
  HistoryEntry,
  PreviousExitResumeResponse,
  ResumeHistoryRequest,
  SessionInfo,
} from '../shared/protocol.ts';
import { isExistingDirectory } from './projects.ts';
import { planConversation, resumeSpawn } from './conversation.ts';
import { isStringArray, isValidDim, MAX_TERM_DIM } from './config.ts';
import { describeError } from './config-log.ts';
import { ConversationStarting } from './sessions.ts';
import {
  NEXT,
  readJsonBody,
  readJsonBodySafe,
  sendError,
  sendErrorAndClose,
  sendJson,
  sendNoContent,
  type ApiContext,
  type RouteResult,
} from './api-http.ts';

/** POST /api/sessions refusing a resume of a conversation that is still live. */
export const CONVERSATION_RUNNING = 'That conversation is already running.';

/** A history entry whose session is live: DELETE and resume refuse it (409). */
const SESSION_RUNNING = 'that session is still running';
const HISTORY_NOT_FOUND = 'history entry not found';

/**
 * POST /api/previous-exit/resume spawns at this size; the pane's first
 * `resize` gives the PTY its real one (the route takes no body).
 */
const PREVIOUS_EXIT_COLS = 80;
const PREVIOUS_EXIT_ROWS = 24;
/** POST /api/previous-exit/* bodies are ignored; this much is still read. */
const PREVIOUS_EXIT_MAX_BODY_BYTES = 1024;

/** What one resume of a history entry came to: the new session, or the route's status and sentence. */
type ResumeOutcome =
  | { ok: true; info: SessionInfo }
  | { ok: false; status: number; error: string };

/**
 * Resume one history entry — THE path of POST /api/history/:id/resume and of
 * POST /api/previous-exit/resume: 409 while it is live (or its spawn is in
 * flight, D9 P3 § Risks (c)), 400 when its folder is gone, 500 when the spawn
 * fails; `resumeSpawn` composes the argv.
 */
async function resumeEntry(ctx: ApiContext, entry: HistoryEntry, cols: number, rows: number): Promise<ResumeOutcome> {
  const { projects, sessions, log } = ctx;
  if (entry.ended === null) return { ok: false, status: 409, error: SESSION_RUNNING };
  if (!isExistingDirectory(entry.cwd)) {
    return { ok: false, status: 400, error: 'the folder this session ran in no longer exists' };
  }
  // A project deleted since the launch must not resurrect its id.
  const projectId =
    entry.projectId !== undefined && projects.get(entry.projectId) !== undefined
      ? entry.projectId
      : undefined;
  const spawn = resumeSpawn(entry);
  try {
    const info = await sessions.create({
      ...(projectId !== undefined ? { projectId } : {}),
      cwd: entry.cwd,
      command: spawn.command,
      args: spawn.args,
      title: entry.title,
      cols,
      rows,
      historyId: entry.id,
    });
    return { ok: true, info };
  } catch (err) {
    // D9 P3 (§ Risks (c)): a second resume of this entry while the first
    // one's spawn is still in flight.
    if (err instanceof ConversationStarting) return { ok: false, status: 409, error: SESSION_RUNNING };
    log('error', `history resume spawn failed: ${describeError(err)}`);
    return { ok: false, status: 500, error: 'could not start the session' };
  }
}

/**
 * GET /api/previous-exit, POST /api/previous-exit/resume and
 * /api/previous-exit/dismiss (Q17, .claude/plans/quality/PLAN-Q17.md § P1 3).
 * Shapes: shared/protocol.ts `PreviousExitNotice`, `PreviousExitResumeResponse`.
 */
async function previousExitRoutes(
  ctx: ApiContext,
  method: string,
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<RouteResult> {
  const action = pathname === '/api/previous-exit' ? 'notice'
    : pathname === '/api/previous-exit/resume' ? 'resume'
      : pathname === '/api/previous-exit/dismiss' ? 'dismiss'
        : undefined;
  if (action === undefined) return NEXT;
  if (method !== (action === 'notice' ? 'GET' : 'POST')) {
    sendError(res, 405, 'method not allowed');
    return;
  }
  const previousExit = ctx.deps.previousExit;
  if (previousExit === undefined) {
    sendError(res, 503, 'the previous run is not known to this server');
    return;
  }
  if (action === 'notice') {
    const notice = await previousExit.notice();
    if (notice === null) sendNoContent(res);
    else sendJson(res, 200, notice);
    return;
  }
  // The body is ignored, but still bounded: nothing past 1 KiB is drained.
  const body = await readJsonBodySafe(req, PREVIOUS_EXIT_MAX_BODY_BYTES);
  if (!body.ok && body.reason === 'too-large') {
    // Still streaming: the refusal closes the connection (the upload's rule,
    // api-http.ts `sendErrorAndClose`) instead of draining what is left.
    sendErrorAndClose(res, 413, 'request body is too large');
    return;
  }
  if (action === 'dismiss') {
    await previousExit.dismiss();
    sendNoContent(res);
    return;
  }
  const answer: PreviousExitResumeResponse = { resumed: [], failed: [] };
  // One at a time: a burst of N claude spawns at once is what the box that
  // just ran out of memory needs least.
  for (const historyId of await previousExit.take()) {
    const entry = ctx.history.get(historyId);
    if (entry === undefined) {
      answer.failed.push({ historyId, error: HISTORY_NOT_FOUND });
      continue;
    }
    // Read BEFORE the resume: the entry's sessionId becomes the new one.
    const previousSessionId = entry.sessionId;
    const resumed = await resumeEntry(ctx, entry, PREVIOUS_EXIT_COLS, PREVIOUS_EXIT_ROWS);
    if (resumed.ok) answer.resumed.push({ historyId, previousSessionId, session: resumed.info });
    else answer.failed.push({ historyId, error: resumed.error });
  }
  ctx.log('info', `previous-exit resume: ${answer.resumed.length} resumed, ${answer.failed.length} failed`);
  sendJson(res, 200, answer);
}

/** /api/sessions, /api/history, /api/history/:id(/resume), /api/previous-exit(/resume|/dismiss), /api/sessions/:id(/seen). */
export async function sessionRoutes(
  ctx: ApiContext,
  method: string,
  pathname: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<RouteResult> {
  const { projects, sessions, history, log } = ctx;

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
      if (typeof body.title === 'string' && body.title.length > TITLE_MAX_CHARS) {
        sendError(res, 400, `title must be at most ${TITLE_MAX_CHARS} characters`);
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
      // A launch that ADOPTS a conversation id from its own args (the new
      // session dialog's per-conversation resume sends `--resume <uuid>`)
      // must be refused while that conversation is still running — two
      // claude processes on one transcript corrupt it, and POST
      // /api/history/:id/resume already refuses exactly this case. The probe
      // id is a fresh uuid, so `plan.id !== probeId` is true only when the
      // key came from the CLIENT's argv, never from the injection.
      const probeId = randomUUID();
      const plan = planConversation(body.command, body.args, probeId);
      if (plan.conversation && plan.id !== probeId) {
        const live = history.get(plan.id);
        if (live !== undefined && live.ended === null) {
          sendError(res, 409, CONVERSATION_RUNNING);
          return;
        }
      }
      try {
        const info = await sessions.create({
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
        // D9 P3 (§ Risks (c)): the same conversation is being spawned by a
        // request that passed the check above a moment earlier.
        if (err instanceof ConversationStarting) {
          sendError(res, 409, CONVERSATION_RUNNING);
          return;
        }
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
      sendError(res, 404, HISTORY_NOT_FOUND);
      return;
    }
    if (!isResume) {
      // DELETE: a live entry is not forgettable — its session is running.
      if (entry.ended === null) {
        sendError(res, 409, SESSION_RUNNING);
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
    const resumed = await resumeEntry(ctx, entry, body.cols, body.rows);
    if (resumed.ok) sendJson(res, 201, resumed.info);
    else sendError(res, resumed.status, resumed.error);
    return;
  }

  // --- The previous run's end (Q17, server/previous-exit.ts) ---------------
  if (pathname.startsWith('/api/previous-exit')) {
    return previousExitRoutes(ctx, method, pathname, req, res);
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

  return NEXT;
}
