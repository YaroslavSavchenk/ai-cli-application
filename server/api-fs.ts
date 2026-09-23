/**
 * The filesystem /api routes: the folder picker's list and mkdir (anywhere on
 * the machine) and the Files panel's routes (confined to home or a registered
 * project root): entries, create, read, write, upload, delete, rename and the
 * Windows form of a path. The boundary itself lives in server/fsbrowse.ts and
 * the per-route modules; this file supplies the HTTP policy they are handed.
 *
 * Split from server/api.ts (O8, 2026-09-23): a pure move, behaviour and
 * error sentences unchanged. Siblings: server/api.ts (dispatcher, gates,
 * access log, static serving), api-http.ts (shared response/body plumbing),
 * api-app.ts, api-github.ts, api-projects.ts, api-fs.ts, api-git.ts,
 * api-sessions.ts (one route family each).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FsCreateRequest, FsMkdirRequest, FsWinPathResponse } from '../shared/protocol.ts';
import {
  createEntry,
  listEntries,
  listDirs,
  mkdirIn,
  resolveUnderAllowed,
  FsBrowseError,
  FS_CREATE_FAILED,
  FS_NAME_NOT_ALLOWED,
  FS_PATH_BAD,
  FS_READ_FAILED,
} from './fsbrowse.ts';
import { handleDelete } from './fsdelete.ts';
import { handleRename } from './fsrename.ts';
import { handleRead, handleWrite } from './fstext.ts';
import { handleUpload } from './fsupload.ts';
import { FS_PATH_NOT_MAPPABLE, windowsPathForClipboard } from './winpath.ts';
import { describeError, errorClass, errorFrames } from './config.ts';
import {
  NEXT,
  readJsonBody,
  readJsonBodySafe,
  sendError,
  sendErrorAndClose,
  sendJson,
  type ApiContext,
  type RouteResult,
} from './api-http.ts';

/** /api/fs/* — list, mkdir, entries, create, read, write, upload, delete, rename, winpath. */
export async function fsRoutes(
  ctx: ApiContext,
  method: string,
  pathname: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<RouteResult> {
  const { log, fsLog, projectAnchors } = ctx;

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

  // --- Filesystem: one folder's entries (the Files panel) -----------------
  //
  // CONFINED TO HOME OR A REGISTERED PROJECT ROOT, unlike /api/fs/list and
  // /api/fs/mkdir above. Deliberate asymmetry, documented at both sites: the
  // picker's job is to choose a folder anywhere on the machine (a project
  // about to be registered is not registered yet), the panel's job is to
  // browse what is yours. server/fsbrowse.ts resolveUnderAllowed() is the
  // boundary, and the anchor list is read from the store PER REQUEST — a
  // project registered a second ago counts, and a deleted one stops
  // counting.
  if (pathname === '/api/fs/entries') {
    if (method === 'GET') {
      const requested = url.searchParams.get('path') ?? undefined;
      try {
        const body = listEntries(requested, projectAnchors());
        fsLog(
          'debug',
          `GET /api/fs/entries -> 200, ${body.entries.length} entries` +
            (body.truncated > 0 ? `, ${body.truncated} not shown` : ''),
        );
        sendJson(res, 200, body);
      } catch (err) {
        if (err instanceof FsBrowseError) {
          fsLog('debug', `GET /api/fs/entries -> ${err.status}`);
          sendError(res, err.status, err.message);
        } else {
          // errorClass + FRAMES, never describeError: an errno message quotes
          // the path it failed on, and a create's would quote the NAME.
          fsLog('error', `fs entries failed (${errorClass(err)}) ${errorFrames(err)}`);
          sendError(res, 500, FS_READ_FAILED);
        }
      }
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }

  // --- Filesystem: create one empty file or one folder (A9c) --------------
  if (pathname === '/api/fs/create') {
    if (method === 'POST') {
      const body = (await readJsonBody(req)) as Partial<FsCreateRequest>;
      if (typeof body.dir !== 'string') {
        sendError(res, 400, FS_PATH_BAD);
        return;
      }
      if (typeof body.name !== 'string') {
        sendError(res, 400, FS_NAME_NOT_ALLOWED);
        return;
      }
      if (body.kind !== 'file' && body.kind !== 'folder') {
        sendError(res, 400, FS_PATH_BAD);
        return;
      }
      const kind = body.kind;
      try {
        const created = createEntry(body.dir, body.name, kind, projectAnchors());
        fsLog('info', `POST /api/fs/create ${kind} -> 201`);
        sendJson(res, 201, created);
      } catch (err) {
        if (err instanceof FsBrowseError) {
          fsLog('info', `POST /api/fs/create ${kind} -> ${err.status}`);
          sendError(res, err.status, err.message);
        } else {
          fsLog('error', `fs create failed (${errorClass(err)}) ${errorFrames(err)}`);
          sendError(res, 500, FS_CREATE_FAILED);
        }
      }
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }

  // --- Filesystem: the editor's file READ and WRITE (B4) ------------------
  //
  // The whole of both routes lives in server/fstext.ts (the boundary, the
  // O_NOFOLLOW|O_NONBLOCK opens, the fstat rule, the stamp compare and the
  // in-place write). What stays here is this file's own policy: how a
  // response is written, how a body is read SAFELY (readJsonBodySafe never
  // lets a parse error — which quotes the user's TEXT — escape), and that a
  // refusal taken before the body is read closes the connection. The write's
  // body cap is the route's own (FS_WRITE_MAX_BODY_BYTES), passed by the
  // module to readJson: the generic MAX_BODY_BYTES stays 1 MiB.
  if (pathname === '/api/fs/read') {
    handleRead(req, res, url, {
      projects: projectAnchors,
      log: fsLog,
      sendJson,
      sendError,
      sendErrorAndClose,
      readJson: readJsonBodySafe,
    });
    return;
  }

  if (pathname === '/api/fs/write') {
    await handleWrite(req, res, {
      projects: projectAnchors,
      log: fsLog,
      sendJson,
      sendError,
      sendErrorAndClose,
      readJson: readJsonBodySafe,
    });
    return;
  }

  // --- Filesystem: upload ONE file (B10) ----------------------------------
  //
  // The whole route lives in server/fsupload.ts; what stays here is the
  // policy this file owns — how a response is written, and the fact that
  // every refusal of that route closes the connection (sendErrorAndClose).
  if (pathname === '/api/fs/upload') {
    await handleUpload(req, res, url, {
      projects: projectAnchors,
      log: fsLog,
      sendJson,
      sendErrorAndClose,
    });
    return;
  }

  // --- Filesystem: PERMANENT delete of a selection (B10a) -----------------
  //
  // The app's first delete primitive; the whole route (boundary, anchor and
  // data-dir refusals, per-item outcomes) lives in server/fsdelete.ts. What
  // stays here is this file's own policy: how a response is written, how a
  // body is read SAFELY (readJsonBodySafe never lets a parse error — which
  // quotes the body — escape), and that a refusal taken before the body is
  // read closes the connection.
  if (pathname === '/api/fs/delete') {
    await handleDelete(req, res, {
      projects: projectAnchors,
      log: fsLog,
      sendJson,
      sendError,
      sendErrorAndClose,
      readJson: readJsonBodySafe,
    });
    return;
  }

  // --- Filesystem: RENAME one entry in place (B13) ------------------------
  //
  // Same split as the delete above: the boundary, the anchor and data-dir
  // refusals and the no-clobber rename live in server/fsrename.ts; this file
  // supplies how a response is written and the SAFE body reader.
  if (pathname === '/api/fs/rename') {
    await handleRename(req, res, {
      projects: projectAnchors,
      log: fsLog,
      sendJson,
      sendError,
      sendErrorAndClose,
      readJson: readJsonBodySafe,
    });
    return;
  }

  // --- Filesystem: the WINDOWS form of a path (B10, the host's clipboard) --
  //
  // Same anchor boundary as a listing, so only something inside home or a
  // registered project can ever reach the Windows clipboard. The distro comes
  // from THIS process's environment, never from the client.
  if (pathname === '/api/fs/winpath') {
    if (method === 'GET') {
      const requested = url.searchParams.get('path');
      if (requested === null) {
        fsLog('info', 'GET /api/fs/winpath -> 400');
        sendError(res, 400, FS_PATH_BAD);
        return;
      }
      try {
        const real = resolveUnderAllowed(requested, { projects: projectAnchors() });
        const windowsPath = windowsPathForClipboard(real, process.env.WSL_DISTRO_NAME);
        if (windowsPath === undefined) {
          fsLog('info', 'GET /api/fs/winpath -> 422');
          sendError(res, 422, FS_PATH_NOT_MAPPABLE);
          return;
        }
        fsLog('debug', 'GET /api/fs/winpath -> 200');
        sendJson(res, 200, { windowsPath } satisfies FsWinPathResponse);
      } catch (err) {
        if (err instanceof FsBrowseError) {
          fsLog('info', `GET /api/fs/winpath -> ${err.status}`);
          sendError(res, err.status, err.message);
        } else {
          // errorClass + FRAMES, never describeError: an errno message quotes
          // the path it failed on.
          fsLog('error', `fs winpath failed (${errorClass(err)}) ${errorFrames(err)}`);
          sendError(res, 500, FS_READ_FAILED);
        }
      }
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }

  return NEXT;
}
