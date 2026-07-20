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
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type {
  CreateProjectRequest,
  CreateSessionRequest,
  RuntimeStatusResponse,
  UiPrefs,
} from '../shared/protocol.ts';
import { tokenMatches, hostAllowed, originAllowed } from './auth.ts';
import { ProjectStore, isExistingDirectory } from './projects.ts';
import { PrefsStore } from './prefs.ts';
import { SessionManager } from './sessions.ts';
import { SessionJournal } from './journal.ts';
import { listDirs, FsBrowseError } from './fsbrowse.ts';
import type { Logger } from './config.ts';

const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_TERM_DIM = 1000;
/** Prefs is a small opaque bag (theme today) — well under the generic cap. */
export const PREFS_MAX_BYTES = 64 * 1024;

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
  journal: SessionJournal;
  webDistDir: string;
  log: Logger;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
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

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isValidDim(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_TERM_DIM;
}

export function createRequestHandler(
  deps: ApiDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  const { token, projects, prefs, sessions, journal, webDistDir, log } = deps;

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
        // startedAt ONLY — port/token/pid stay out of the browser-facing API.
        const body: RuntimeStatusResponse = { startedAt: deps.getStartedAt() };
        sendJson(res, 200, body);
        return;
      }
      sendError(res, 405, 'method not allowed');
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
        if (typeof body.path !== 'string' || !isExistingDirectory(body.path)) {
          sendError(res, 400, 'path must be an absolute path to an existing directory');
          return;
        }
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
        const project = projects.create({
          name: body.name.trim(),
          path: body.path,
          ...(body.defaultModel !== undefined ? { defaultModel: body.defaultModel } : {}),
          ...(body.defaultMode !== undefined ? { defaultMode: body.defaultMode } : {}),
        });
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
            sendError(res, 500, 'failed to list directory');
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
        try {
          const info = sessions.create({
            ...(projectId !== undefined ? { projectId } : {}),
            cwd,
            command: body.command,
            args: body.args,
            ...(body.title !== undefined ? { title: body.title } : {}),
            cols: body.cols,
            rows: body.rows,
          });
          sendJson(res, 201, info);
        } catch (err) {
          log('error', `session spawn failed: ${String(err)}`);
          sendError(res, 500, `failed to spawn session: ${String(err)}`);
        }
        return;
      }
      sendError(res, 405, 'method not allowed');
      return;
    }

    // --- Previous sessions (journal of the previous run) --------------------
    if (pathname === '/api/previous') {
      if (method === 'GET') {
        sendJson(res, 200, journal.listPrevious());
        return;
      }
      if (method === 'DELETE') {
        journal.dismissAllPrevious();
        sendJson(res, 200, { ok: true });
        return;
      }
      sendError(res, 405, 'method not allowed');
      return;
    }

    const previousMatch = /^\/api\/previous\/([^/]+)$/.exec(pathname);
    if (previousMatch !== null) {
      const id = decodeURIComponent(previousMatch[1] as string);
      if (method === 'DELETE') {
        if (!journal.dismissPrevious(id)) {
          sendError(res, 404, 'previous session not found');
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      sendError(res, 405, 'method not allowed');
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
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          ...FRAME_PROTECTION_HEADERS,
        });
        res.end(html.replaceAll('__AUTH_TOKEN__', token));
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
    handle(req, res).catch((err: unknown) => {
      log('error', `request ${req.method ?? '?'} ${req.url ?? '?'} failed: ${String(err)}`);
      if (!res.headersSent) {
        sendError(res, 400, 'bad request');
      } else {
        res.end();
      }
    });
  };
}
