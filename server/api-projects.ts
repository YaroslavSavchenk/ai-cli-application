/**
 * The project /api routes: list/create (register or create a directory),
 * clone a repo into a new project, and delete a project — plus the display
 * name a clone url yields (shared with the GitHub clone route).
 *
 * Split from server/api.ts (O8, 2026-09-23): a pure move, behaviour and
 * error sentences unchanged. Siblings: server/api.ts (dispatcher, gates,
 * access log, static serving), api-http.ts (shared response/body plumbing),
 * api-app.ts, api-github.ts, api-projects.ts, api-fs.ts, api-git.ts,
 * api-sessions.ts (one route family each).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, isAbsolute } from 'node:path';
import type { CloneProjectRequest, CreateProjectRequest } from '../shared/protocol.ts';
import { isExistingDirectory } from './projects.ts';
import { createLocalDir, cloneRepo, ScaffoldError } from './scaffold.ts';
import { describeError } from './config.ts';
import { NEXT, readJsonBody, sendError, sendJson, type ApiContext, type RouteResult } from './api-http.ts';

/**
 * Derive a display name from a clone url — the last path/host segment with a
 * trailing `.git` stripped (e.g. https://github.com/owner/repo.git -> "repo",
 * git@github.com:owner/repo.git -> "repo"). Purely a display string stored in
 * projects.json; never used as a path. Length-capped. Undefined if empty.
 */
export function repoNameFromUrl(url: string): string | undefined {
  const trimmed = url.replace(/[/]+$/, '');
  const segment = trimmed.split(/[/:]/).pop() ?? '';
  const name = segment.replace(/\.git$/i, '').trim();
  return name === '' ? undefined : name.slice(0, 128);
}

/** /api/projects, /api/projects/clone, /api/projects/:id. */
export async function projectRoutes(
  ctx: ApiContext,
  method: string,
  pathname: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<RouteResult> {
  const { projects, log } = ctx;

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
        // /api/github/clone dest guard (server/api-github.ts), which 400s an un-normalized
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
      // NORMALIZE, DON'T REJECT (deliberate; /api/github/clone (server/api-github.ts) 400s an
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

  return NEXT;
}
