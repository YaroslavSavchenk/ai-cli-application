/**
 * The git /api routes of the Files panel: what changed since the last commit
 * (the Changes tab) and the history, one commit, one file's diff (the
 * Commits tab). GET only; one log line of COUNTS per request.
 *
 * Split from server/api.ts (O8, 2026-09-23): a pure move, behaviour and
 * error sentences unchanged. Siblings: server/api.ts (dispatcher, gates,
 * access log, static serving), api-http.ts (shared response/body plumbing),
 * api-app.ts, api-github.ts, api-projects.ts, api-fs.ts, api-git.ts,
 * api-sessions.ts (one route family each).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FsBrowseError, FS_PATH_BAD } from './fsbrowse.ts';
import { changesFor, GIT_READ_FAILED } from './git.ts';
import {
  commitDiffFor,
  commitFor,
  commitsFor,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_SKIP,
  MIN_LIMIT,
  requireHash,
  requireInt,
  requirePath,
} from './git-log.ts';
import { errorClass, errorFrames } from './config.ts';
import { NEXT, sendError, sendJson, type ApiContext, type RouteResult } from './api-http.ts';

/** /api/git/changes, /api/git/commits, /api/git/commit, /api/git/commit-diff. */
export async function gitRoutes(
  ctx: ApiContext,
  method: string,
  pathname: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<RouteResult> {
  const { gitLog, projectAnchors } = ctx;

  // --- Git: what changed since the last commit (the Changes tab) ----------
  if (pathname === '/api/git/changes') {
    if (method === 'GET') {
      const root = url.searchParams.get('root');
      if (root === null) {
        sendError(res, 400, FS_PATH_BAD);
        return;
      }
      try {
        const body = await changesFor(root, gitLog, projectAnchors());
        gitLog(
          'debug',
          `GET /api/git/changes -> 200, repo=${body.isRepo}, ${body.files.length} files` +
            (body.truncated > 0 ? `, ${body.truncated} not shown` : ''),
        );
        sendJson(res, 200, body);
      } catch (err) {
        if (err instanceof FsBrowseError) {
          gitLog('debug', `GET /api/git/changes -> ${err.status}`);
          sendError(res, err.status, err.message);
        } else {
          gitLog('error', `git changes failed (${errorClass(err)}) ${errorFrames(err)}`);
          sendError(res, 500, GIT_READ_FAILED);
        }
      }
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }

  // --- Git: the history, one commit, one file's diff (the Commits tab, B3) --
  //
  // The same shape as /api/git/changes above, three times: GET only, `root`
  // required, ONE log line of COUNTS, an FsBrowseError is its own status and
  // sentence, anything else is a class + frames at error and the constant
  // 500. Never a hash, a path, a subject, an author or the remote url — the
  // remote url can hold a token, and server/git-log.ts is where that is kept.
  if (pathname === '/api/git/commits') {
    if (method === 'GET') {
      const root = url.searchParams.get('root');
      if (root === null) {
        sendError(res, 400, FS_PATH_BAD);
        return;
      }
      try {
        const limit = requireInt(url.searchParams.get('limit'), MIN_LIMIT, MAX_LIMIT, DEFAULT_LIMIT);
        const skip = requireInt(url.searchParams.get('skip'), 0, MAX_SKIP, 0);
        const fromRaw = url.searchParams.get('from');
        const from = fromRaw === null || fromRaw === '' ? null : requireHash(fromRaw);
        const body = await commitsFor(root, { limit, skip, from }, gitLog, projectAnchors());
        gitLog(
          'debug',
          `GET /api/git/commits -> 200, repo=${body.isRepo}, ${body.commits.length} commits` +
            (body.more ? ', more' : ''),
        );
        sendJson(res, 200, body);
      } catch (err) {
        if (err instanceof FsBrowseError) {
          gitLog('debug', `GET /api/git/commits -> ${err.status}`);
          sendError(res, err.status, err.message);
        } else {
          gitLog('error', `git commits failed (${errorClass(err)}) ${errorFrames(err)}`);
          sendError(res, 500, GIT_READ_FAILED);
        }
      }
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }

  if (pathname === '/api/git/commit') {
    if (method === 'GET') {
      const root = url.searchParams.get('root');
      if (root === null) {
        sendError(res, 400, FS_PATH_BAD);
        return;
      }
      try {
        const hash = requireHash(url.searchParams.get('hash'));
        const body = await commitFor(root, hash, gitLog, projectAnchors());
        gitLog(
          'debug',
          `GET /api/git/commit -> 200, ${body.files.length} files` +
            (body.truncated > 0 ? `, ${body.truncated} not shown` : ''),
        );
        sendJson(res, 200, body);
      } catch (err) {
        if (err instanceof FsBrowseError) {
          gitLog('debug', `GET /api/git/commit -> ${err.status}`);
          sendError(res, err.status, err.message);
        } else {
          gitLog('error', `git commit failed (${errorClass(err)}) ${errorFrames(err)}`);
          sendError(res, 500, GIT_READ_FAILED);
        }
      }
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }

  if (pathname === '/api/git/commit-diff') {
    if (method === 'GET') {
      const root = url.searchParams.get('root');
      if (root === null) {
        sendError(res, 400, FS_PATH_BAD);
        return;
      }
      try {
        const hash = requireHash(url.searchParams.get('hash'));
        const path = requirePath(url.searchParams.get('path'));
        const body = await commitDiffFor(root, hash, path, gitLog, projectAnchors());
        gitLog(
          'debug',
          `GET /api/git/commit-diff -> 200, ` +
            (body.binary ? 'binary' : body.tooLarge ? 'too large' : `${body.lines.length} lines`),
        );
        sendJson(res, 200, body);
      } catch (err) {
        if (err instanceof FsBrowseError) {
          gitLog('debug', `GET /api/git/commit-diff -> ${err.status}`);
          sendError(res, err.status, err.message);
        } else {
          gitLog('error', `git commit diff failed (${errorClass(err)}) ${errorFrames(err)}`);
          sendError(res, 500, GIT_READ_FAILED);
        }
      }
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }

  return NEXT;
}
