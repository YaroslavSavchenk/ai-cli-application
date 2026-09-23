/**
 * The GitHub /api routes: connection status, the device flow, a pasted token,
 * disconnect, list/create repos, and the authenticated clone into a project.
 * The credential never leaves server/github.ts — these handlers surface only
 * status, the user_code and repo metadata.
 *
 * Split from server/api.ts (O8, 2026-09-23): a pure move, behaviour and
 * error sentences unchanged. Siblings: server/api.ts (dispatcher, gates,
 * access log, static serving), api-http.ts (shared response/body plumbing),
 * api-app.ts, api-github.ts, api-projects.ts, api-fs.ts, api-git.ts,
 * api-sessions.ts (one route family each).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, isAbsolute, resolve } from 'node:path';
import type {
  GithubCloneRequest,
  GithubCreateRepoRequest,
  GithubReposResponse,
  GithubTokenRequest,
} from '../shared/protocol.ts';
import { GithubError, parseGithubRepoPath } from './github.ts';
import { isJsonContentType } from './config.ts';
import { repoNameFromUrl } from './api-projects.ts';
import {
  NEXT,
  readJsonBody,
  readJsonBodySafe,
  sendError,
  sendJson,
  type ApiContext,
  type RouteResult,
} from './api-http.ts';

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

/** /api/github/* — status, device, token, disconnect, repos, clone. */
export async function githubRoutes(
  ctx: ApiContext,
  method: string,
  pathname: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<RouteResult> {
  const { projects, github, log } = ctx;

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
      // reach the generic logger in server/api.ts — it could have the body in scope.
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
      // /api/projects routes (server/api-projects.ts) take user-typed destinations that are
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

  return NEXT;
}
