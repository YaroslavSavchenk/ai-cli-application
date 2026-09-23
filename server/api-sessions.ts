/**
 * The session /api routes: list and create sessions (the spawn request), the
 * cross-run history (list, forget, resume) and one session's seen/delete —
 * plus the terminal-size bound the WebSocket layer shares.
 *
 * Split from server/api.ts (O8, 2026-09-23): a pure move, behaviour and
 * error sentences unchanged. Siblings: server/api.ts (dispatcher, gates,
 * access log, static serving), api-http.ts (shared response/body plumbing),
 * api-app.ts, api-github.ts, api-projects.ts, api-fs.ts, api-git.ts,
 * api-sessions.ts (one route family each).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { CreateSessionRequest, ResumeHistoryRequest } from '../shared/protocol.ts';
import { isExistingDirectory } from './projects.ts';
import { planConversation, resumeSpawn } from './conversation.ts';
import { describeError, isStringArray } from './config.ts';
import { NEXT, readJsonBody, sendError, sendJson, type ApiContext, type RouteResult } from './api-http.ts';

export const MAX_TERM_DIM = 1000;
/** POST /api/sessions refusing a resume of a conversation that is still live. */
export const CONVERSATION_RUNNING = 'That conversation is already running.';

function isValidDim(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_TERM_DIM;
}

/** /api/sessions, /api/history, /api/history/:id(/resume), /api/sessions/:id(/seen). */
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

  return NEXT;
}
