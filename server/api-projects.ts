/**
 * The project /api routes: list/create (register or create a directory),
 * clone a repo into a new project, edit (PATCH: name + launch preferences,
 * Nocturne D1, `.claude/plans/nocturne/PLAN-D1.md`) and delete a project —
 * plus the display name a clone url yields (shared with the GitHub clone route).
 *
 * Split from server/api.ts (O8, 2026-09-23): a pure move, behaviour and
 * error sentences unchanged. Siblings: server/api.ts (dispatcher, gates,
 * access log, static serving), api-http.ts (shared response/body plumbing),
 * api-app.ts, api-github.ts, api-projects.ts, api-fs.ts, api-git.ts,
 * api-sessions.ts (one route family each).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, isAbsolute } from 'node:path';
import {
  isClaudePermissionMode,
  isProjectEffort,
  type CloneProjectRequest,
  type CreateProjectRequest,
  type UpdateProjectRequest,
} from '../shared/protocol.ts';
import { isExistingDirectory } from './projects.ts';
import { createLocalDir, cloneRepo, ScaffoldError } from './scaffold.ts';
import { describeError } from './config.ts';
import { plainObject } from './sanitise.ts';
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

/**
 * A stored model id reaches the claude argv as `--model <id>` (an argv array,
 * never a shell): it may not start with `-`, so it can never read as a flag.
 * A pattern, not the model pool — a new model must not need a backend change
 * (the UI offers only the pool). Matches aliases (`opus`) and full ids.
 */
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;

type ProjectPrefs = Pick<UpdateProjectRequest, 'defaultModel' | 'defaultPerm' | 'defaultEffort'>;

/**
 * The launch preferences out of a POST or PATCH body — the one home of their
 * rules. `nullClears` (PATCH) admits `null` = delete the preference; POST has
 * nothing to delete. An absent field stays absent. Returns the refusal
 * sentence when any field is invalid, so the caller writes nothing.
 */
function readPrefs(body: Record<string, unknown>, nullClears: boolean): { prefs: ProjectPrefs } | { error: string } {
  const prefs: ProjectPrefs = {};
  const { defaultModel, defaultPerm, defaultEffort } = body;
  if (defaultModel === null && nullClears) prefs.defaultModel = null;
  else if (typeof defaultModel === 'string' && MODEL_ID.test(defaultModel)) prefs.defaultModel = defaultModel;
  else if (defaultModel !== undefined) {
    return { error: 'defaultModel must be a model id: lowercase letters, digits, dots and dashes' };
  }
  if (defaultPerm === null && nullClears) prefs.defaultPerm = null;
  else if (isClaudePermissionMode(defaultPerm)) prefs.defaultPerm = defaultPerm;
  else if (defaultPerm !== undefined) {
    return { error: "defaultPerm must be 'default', 'acceptEdits', 'plan' or 'bypassPermissions'" };
  }
  if (defaultEffort === null && nullClears) prefs.defaultEffort = null;
  else if (isProjectEffort(defaultEffort)) prefs.defaultEffort = defaultEffort;
  else if (defaultEffort !== undefined) {
    return { error: "defaultEffort must be 'low', 'medium', 'high', 'xhigh' or 'max'" };
  }
  return { prefs };
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
      const raw = plainObject(await readJsonBody(req));
      if (raw === undefined) {
        sendError(res, 400, 'request body must be a JSON object');
        return;
      }
      const body = raw as Partial<CreateProjectRequest>;
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
      const read = readPrefs(raw, false);
      if ('error' in read) {
        sendError(res, 400, read.error);
        return;
      }
      const { defaultModel, defaultPerm, defaultEffort } = read.prefs;
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
        ...(typeof defaultModel === 'string' ? { defaultModel } : {}),
        ...(body.defaultMode !== undefined ? { defaultMode: body.defaultMode } : {}),
        ...(typeof defaultPerm === 'string' ? { defaultPerm } : {}),
        ...(typeof defaultEffort === 'string' ? { defaultEffort } : {}),
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
    if (method === 'PATCH') {
      // Everything is checked before the store is touched: a 400 writes nothing.
      const body = plainObject(await readJsonBody(req));
      if (body === undefined) {
        sendError(res, 400, 'request body must be a JSON object');
        return;
      }
      // Same rule as POST: a string, stored trimmed, not empty. Never the path.
      const { name } = body;
      if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
        sendError(res, 400, 'name must be a non-empty string');
        return;
      }
      const read = readPrefs(body, true);
      if ('error' in read) {
        sendError(res, 400, read.error);
        return;
      }
      const updated = projects.update(id, {
        ...(typeof name === 'string' ? { name: name.trim() } : {}),
        ...read.prefs,
      });
      if (updated === undefined) {
        sendError(res, 404, 'project not found');
        return;
      }
      sendJson(res, 200, updated);
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }

  return NEXT;
}
