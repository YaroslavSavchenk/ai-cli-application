/**
 * PUT /api/fs/upload — the ONE real file write this app offers the browser
 * (Nocturne B10 phase 1, `.claude/PLAN-B10.md` §2). Drop, paste and
 * `Copy files here…` all end here, one request per file.
 *
 *   PUT /api/fs/upload?dir=<abs dest>&rel=<relative path>&mode=replace|new
 *     content-type: application/octet-stream     (415 otherwise)
 *     content-length: <n>                        (411 when absent or chunked)
 *     body: the file's bytes, verbatim
 *     201 { bytes }
 *
 * RAW BODY, NOT MULTIPART, and that is a security decision before it is a
 * performance one: a multipart parser would be a new security-relevant parser
 * in a repo with exactly two runtime dependencies, while a raw body lets this
 * route refuse on `content-length` BEFORE it reads a byte. The query carries the
 * destination because `url.searchParams.get()` decodes UTF-8 percent-encoding
 * (a header value cannot carry a non-Latin-1 name without hand-rolled
 * encoding), and because the access log already reduces every query to `?…`.
 *
 * WHAT KEEPS THE WRITE INSIDE THE BOUNDARY, in the order it is applied:
 *   1. `resolveUnderAllowed()` on `dir` — the SAME call createEntry() makes:
 *      absolute, realpathed, contained in home or a registered project root.
 *   2. `rel` split on `/`, every segment through `isSafeSegment()` AND the
 *      255-BYTE name limit, depth capped — so `..`, `.`, an empty segment, an
 *      absolute `rel` and a control character all die before any syscall.
 *   3. Every folder this module BUILDS with mkdir is resolved again, PER LEVEL,
 *      and re-checked against the anchors (and the finished parent against the
 *      data-dir rule): `mkdir` on an existing symlink answers EEXIST, so
 *      without that re-check a planted `sub -> /etc` would take the write —
 *      and the next mkdir — with it.
 *   4. The temp file is opened O_EXCL|O_NOFOLLOW, and the publish step is
 *      `rename`/`link`, neither of which follows a symlink at the final
 *      component: a pre-planted `notes.txt -> /etc/passwd` is REPLACED, never
 *      written through.
 * TOCTOU between the realpath and the syscalls is the accepted, documented
 * position of server/fsbrowse.ts — the same one, for the same reasons.
 *
 * LOGGING: counts and statuses only. Never a name, never a path, never a query
 * value, never a byte of the body — a 5xx logs the error CLASS and its FRAMES,
 * never `describeError`, because an errno message quotes the path it failed on.
 *
 * Erasable TypeScript only; relative imports carry explicit .ts extensions.
 */
import { randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
  createWriteStream,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_CONTENT_TYPE,
  type FsUploadMode,
  type FsUploadResponse,
} from '../shared/protocol.ts';
import { errorClass, errorFrames, type Logger } from './config.ts';
import {
  FsBrowseError,
  FS_ALREADY_EXISTS,
  FS_CREATE_PARENT_GONE,
  FS_DATA_DIR_REFUSED,
  FS_NAME_NOT_ALLOWED,
  FS_NO_CREATE_PERMISSION,
  FS_PATH_BAD,
  MAX_NAME_BYTES,
  isSafeSegment,
  isUnderDataDir,
  resolveUnderAllowed,
} from './fsbrowse.ts';
import { isExistingDirectory } from './projects.ts';

/**
 * The new user-facing sentences of this route. CONSTANTS, like every other
 * refusal: server/api.ts records the message in `responseReason` for the access
 * log, and that channel never carries anything derived from a request.
 */
export const FS_UPLOAD_TOO_BIG = 'That file is larger than the copy limit.';
export const FS_UPLOAD_FAILED = 'The app could not copy that file.';
export const FS_UPLOAD_INCOMPLETE = 'That file did not arrive completely.';
export const FS_DISK_FULL = 'There is no room left on the disk.';

/**
 * How many segments `rel` may carry. A drop walks the tree the browser handed
 * it; 64 is deeper than any real project and shallow enough that the mkdir loop
 * is bounded.
 */
export const MAX_REL_DEPTH = 64;

/**
 * `rel` as the segments it names, or null when it is not a relative path this
 * route will build.
 *
 * The whole vocabulary is `isSafeSegment` plus the filesystem's 255-BYTE name
 * limit, so `..`, `.`, `...`, an empty segment (which is what a leading `/`, a
 * trailing `/` and `a//b` all produce), a backslash, a control character and a
 * NUL are each refused here — before any syscall sees them. Split on `/` only:
 * `\` is not a separator on Linux, and isSafeSegment refuses it in a name.
 */
export function splitRel(rel: string): string[] | null {
  if (typeof rel !== 'string' || rel === '') return null;
  const segments = rel.split('/');
  if (segments.length === 0 || segments.length > MAX_REL_DEPTH) return null;
  for (const segment of segments) {
    if (!isSafeSegment(segment)) return null;
    // isSafeSegment counts UTF-16 CODE UNITS; NAME_MAX is 255 BYTES. Same check
    // createEntry() makes, for the same reason: without it a 250-character `é`
    // name is a kernel ENAMETOOLONG (a 500-byte name) reported as a 500.
    if (Buffer.byteLength(segment, 'utf8') > MAX_NAME_BYTES) return null;
    // U+FFFD is what percent-decoding produces from bytes that are not valid
    // UTF-8 — an overlong `%C0%AF` arrives here as `\uFFFD\uFFFD`. The client
    // never sends one (a name it read from the filesystem round-trips), so a
    // replacement character means the name was mangled or hand-built, and a
    // file called `??` is not what anybody dropped.
    if (segment.includes('\uFFFD')) return null;
  }
  return segments;
}

/**
 * The declared body length, or null when this request may not be read at all:
 * no `content-length`, a malformed one, a duplicated one — or any
 * `transfer-encoding`, because a chunked body has no length to refuse on and
 * this route's whole safety property is refusing BEFORE the first byte.
 *
 * The cap itself is the caller's: an absent length is a 411 and an over-cap one
 * is a 413, and those are different answers.
 */
export function parseContentLength(headers: IncomingHttpHeaders): number | null {
  if (headers['transfer-encoding'] !== undefined) return null;
  const raw = headers['content-length'];
  if (typeof raw !== 'string') return null; // absent, or duplicated into an array
  if (!/^\d{1,15}$/.test(raw)) return null; // no sign, no whitespace, no exponent
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** The three query parameters, or the refusal one of them earns. */
interface UploadParams {
  dir: string;
  rel: string;
  mode: FsUploadMode;
}

function readParams(url: URL): UploadParams | FsBrowseError {
  // Duplicate parameters resolve to the FIRST value — `.get()`'s documented
  // behaviour, and the reason a second `?dir=` cannot smuggle a destination past
  // the one that was checked.
  const dir = url.searchParams.get('dir');
  const rel = url.searchParams.get('rel');
  const mode = url.searchParams.get('mode');
  if (dir === null || dir === '') return new FsBrowseError(400, FS_PATH_BAD);
  if (rel === null || rel === '') return new FsBrowseError(400, FS_NAME_NOT_ALLOWED);
  if (mode !== 'replace' && mode !== 'new') return new FsBrowseError(400, FS_PATH_BAD);
  return { dir, rel, mode };
}

/** `application/octet-stream`, with or without parameters, case-insensitive. */
function isUploadContentType(value: string | string[] | undefined): boolean {
  if (typeof value !== 'string') return false;
  return value.split(';')[0]?.trim().toLowerCase() === UPLOAD_CONTENT_TYPE;
}

/** Thrown by the counting transform; never reaches a log or a response body. */
class UploadTooBigError extends Error {}

/**
 * True when NOTHING stands at `path` — not a file, not a folder, and not a
 * dangling symlink. `lstatSync` never follows the final component, which is the
 * whole difference from existsSync.
 */
function isVacant(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (err) {
    // ENOENT is the only "free" answer; anything else (EACCES on the parent,
    // ELOOP) is a reason to refuse rather than to overwrite.
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * The same category rule POST /api/fs/create applies: the folder holding the
 * auth token, prefs.json and history.json is not a drop target. NOT a security
 * boundary — a caller holding the token can already POST /api/fs/mkdir anywhere
 * — but nothing may be CREATED there on the way to finding that out.
 */
function refuseDataDir(real: string): void {
  if (isUnderDataDir(real)) throw new FsBrowseError(403, FS_DATA_DIR_REFUSED);
}

/** Every FsBrowseError this module maps an errno to, in one place. */
function fsErrorFor(
  code: string | undefined,
  fallback: FsBrowseError,
  overrides: Record<string, FsBrowseError> = {},
): FsBrowseError {
  if (code !== undefined && overrides[code] !== undefined) return overrides[code];
  if (code === 'EEXIST' || code === 'EISDIR' || code === 'ENOTEMPTY') {
    return new FsBrowseError(409, FS_ALREADY_EXISTS);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new FsBrowseError(403, FS_NO_CREATE_PERMISSION);
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new FsBrowseError(404, FS_CREATE_PARENT_GONE);
  }
  if (code === 'ENAMETOOLONG') return new FsBrowseError(400, FS_NAME_NOT_ALLOWED);
  if (code === 'ENOSPC' || code === 'EDQUOT') return new FsBrowseError(507, FS_DISK_FULL);
  return fallback;
}

/** What the route needs from server/api.ts. Injected, so this module has no HTTP policy of its own. */
export interface UploadDeps {
  /** The registered project roots, read from the store PER REQUEST (anchors). */
  projects: () => string[];
  /** The `[fs]`-scoped logger. */
  log: Logger;
  /** 2xx answers. */
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  /**
   * A refusal that answers `connection: close` and ends the connection once the
   * response has flushed. EVERY refusal of this route uses it: they all happen
   * before the body is consumed, and a server that said no must not leave a
   * client streaming 50 MiB into a connection nobody will read.
   */
  sendErrorAndClose: (res: ServerResponse, status: number, message: string) => void;
}

/**
 * The whole route. Answers every status itself (including 405) and never
 * throws: a rejection here would land in api.ts's generic handler, which is one
 * more place a path could reach a log line.
 */
export async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: UploadDeps,
): Promise<void> {
  const { log } = deps;
  /**
   * Every refusal: the status on the `[fs]` channel, then the response that
   * ends the connection.
   *
   * DEBUG, not info, for a 4xx: the access log already writes one info line per
   * request with the route, the status, the duration and `reason=<sentence>`,
   * so an info line here would double every refused row of a 2000-file drop.
   * A 5xx is logged ONCE, by its caller, with errorClass + errorFrames.
   */
  const refuse = (status: number, message: string): void => {
    if (status < 500) log('debug', `PUT /api/fs/upload -> ${status}`);
    deps.sendErrorAndClose(res, status, message);
  };

  if ((req.method ?? 'GET') !== 'PUT') {
    deps.sendErrorAndClose(res, 405, 'method not allowed');
    return;
  }

  const params = readParams(url);
  if (params instanceof FsBrowseError) {
    refuse(params.status, params.message);
    return;
  }

  // --- Everything that can be judged from the HEADERS, before a single byte --
  const declared = parseContentLength(req.headers);
  if (declared === null) {
    refuse(411, FS_UPLOAD_INCOMPLETE);
    return;
  }
  if (declared > MAX_UPLOAD_BYTES) {
    refuse(413, FS_UPLOAD_TOO_BIG);
    return;
  }
  if (!isUploadContentType(req.headers['content-type'])) {
    refuse(415, FS_UPLOAD_FAILED);
    return;
  }

  // --- The destination ------------------------------------------------------
  const segments = splitRel(params.rel);
  if (segments === null) {
    refuse(400, FS_NAME_NOT_ALLOWED);
    return;
  }

  let parentReal: string;
  try {
    const anchored = resolveUnderAllowed(params.dir, {
      projects: deps.projects(),
      gone: FS_CREATE_PARENT_GONE,
      denied: FS_NO_CREATE_PERMISSION,
    });
    if (!isExistingDirectory(anchored)) {
      throw new FsBrowseError(404, FS_CREATE_PARENT_GONE);
    }
    // The data-dir rule is applied BEFORE the first mkdir and again after every
    // level below (2026-09-20 review): applying it only to the finished parent
    // still let `dir=<data dir>&rel=a/b/x.bin`, `rel=.ai-session-manager/…` and
    // a planted `todata -> <data dir>` link CREATE folders in the folder that
    // holds the auth token, and only then refuse. No mkdirSync may ever target
    // it.
    refuseDataDir(anchored);
    // Intermediate folders, one segment at a time. EEXIST is success (a merge
    // into a folder that is already there — D2); ENOTDIR or a name that is a
    // FILE is that item failing (409), not a server fault.
    //
    // THE RE-CHECK IS PER LEVEL, not once at the end (plan §2 step 6 asks for
    // the end; per level is strictly stronger and costs one realpath per
    // segment): `mkdir` on an existing SYMLINK answers EEXIST, so a planted
    // `sub -> /etc` would otherwise take the NEXT mkdir with it and this route
    // would create a directory outside the boundary before refusing the write.
    // Checking each level means nothing is ever created outside it.
    let built = anchored;
    for (const segment of segments.slice(0, -1)) {
      built = join(built, segment);
      try {
        mkdirSync(built);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          throw fsErrorFor(code, new FsBrowseError(500, FS_UPLOAD_FAILED), {
            // A path component that is a FILE (ENOTDIR) is not a vanished
            // parent — it is a name clash, the same 409 a file meeting a file
            // gets, and the client reports that ITEM as failed (D2/D4).
            // DEFENSIVE — unreachable today, see the per-level check below: the
            // anchored dir is checked isExistingDirectory and every built level
            // is re-checked, so this mkdir's parent is always a real directory
            // and the observed 409 comes from that check, not from here.
            ENOTDIR: new FsBrowseError(409, FS_ALREADY_EXISTS),
          });
        }
      }
      built = resolveUnderAllowed(built, {
        projects: deps.projects(),
        gone: FS_CREATE_PARENT_GONE,
        denied: FS_NO_CREATE_PERMISSION,
      });
      refuseDataDir(built);
      if (!isExistingDirectory(built)) {
        // EEXIST above was a FILE, not a folder.
        throw new FsBrowseError(409, FS_ALREADY_EXISTS);
      }
    }
    parentReal = built;
  } catch (err) {
    if (err instanceof FsBrowseError) {
      if (err.status >= 500) {
        log('error', `fs upload failed (${errorClass(err)}) ${errorFrames(err)}`);
      }
      refuse(err.status, err.message);
      return;
    }
    // errorClass + FRAMES, never describeError: an errno message quotes the
    // path it failed on. ONE line per 5xx — refuse() adds none.
    log('error', `fs upload failed (${errorClass(err)}) ${errorFrames(err)}`);
    refuse(500, FS_UPLOAD_FAILED);
    return;
  }

  const name = segments[segments.length - 1] as string;
  const target = join(parentReal, name);

  // --- The temp file --------------------------------------------------------
  //
  // A FIXED-LENGTH name, never `.<original name>.part`: a 255-byte name plus a
  // prefix is ENAMETOOLONG. O_EXCL so it is ours alone; O_NOFOLLOW so a planted
  // link of that (unguessable) name cannot take the write elsewhere. Mode 0666
  // minus the umask — an ordinary user file, not a secret.
  const part = join(parentReal, `.upload-${randomUUID().replace(/-/g, '')}.part`);
  let fd: number;
  try {
    fd = openSync(
      part,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o666,
    );
  } catch (err) {
    const mapped = fsErrorFor(
      (err as NodeJS.ErrnoException).code,
      new FsBrowseError(500, FS_UPLOAD_FAILED),
    );
    if (mapped.status >= 500) {
      log('error', `fs upload failed (${errorClass(err)}) ${errorFrames(err)}`);
    }
    refuse(mapped.status, mapped.message);
    return;
  }

  let published = false;
  let written = 0;
  try {
    // --- The body ----------------------------------------------------------
    const counter = new Transform({
      transform(chunk: Buffer, _enc, done): void {
        written += chunk.byteLength;
        // DEFENSIVE AND UNREACHABLE TODAY (2026-09-20): `declared` is proven
        // <= MAX_UPLOAD_BYTES above, and Node's parser never hands the handler
        // more bytes than content-length. It stays because the counter is the
        // only thing between a future streamed body and the cap.
        if (written > declared || written > MAX_UPLOAD_BYTES) {
          done(new UploadTooBigError());
          return;
        }
        done(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, createWriteStream(part, { fd, autoClose: true }));
      // DEFENSIVE — unreachable today: a client that stops short half-closes,
      // which aborts the request stream, so pipeline rejects before this line.
      if (written !== declared) throw new Error('short body');
    } catch (err) {
      if (err instanceof UploadTooBigError) {
        refuse(413, FS_UPLOAD_TOO_BIG);
        return;
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOSPC' || code === 'EDQUOT') {
        refuse(507, FS_DISK_FULL);
        return;
      }
      // A client that aborted, a stream that broke, a body shorter than it
      // declared. The answer usually goes into a socket nobody is listening to
      // — the `finally` below, which removes the part file, is the point.
      refuse(400, FS_UPLOAD_INCOMPLETE);
      return;
    }

    // --- Publish ------------------------------------------------------------
    try {
      if (params.mode === 'replace') {
        // rename(2) never follows the final component of the new path: a
        // pre-planted `notes.txt -> /etc/passwd` is REPLACED, and the swap is
        // atomic — a reader sees the old file or the new one, never a partial.
        renameSync(part, target);
      } else {
        try {
          // link(2) fails EEXIST if the name is taken AT ALL, a dangling
          // symlink included. That is the atomic "create only if absent".
          linkSync(part, target);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EXDEV' || code === 'ENOSYS') {
            // FALLBACK, and it is NOT atomic: hard links are not guaranteed on
            // drvfs (a project registered under /mnt/c), so the existence test
            // and the rename are two steps with a window between them. A file
            // created in that window is overwritten. Accepted: the alternative
            // is no upload at all on a Windows-mounted project.
            //
            // lstat, NOT existsSync: existsSync FOLLOWS the link, so a DANGLING
            // symlink standing at the target would read as "free" and the
            // rename would replace it — where link(2) answers EEXIST for any
            // name that is taken at all. UNTESTED, and it cannot be tested
            // here: no filesystem in this checkout refuses link(2), so this
            // branch is reachable on drvfs only.
            if (!isVacant(target)) throw new FsBrowseError(409, FS_ALREADY_EXISTS);
            renameSync(part, target);
            published = true; // The part file IS the published file now.
          } else {
            throw err;
          }
        }
        if (!published) {
          // The part file is now a second link to the published file; dropping
          // it is bookkeeping, not a failure if it does not work.
          try {
            unlinkSync(part);
          } catch {
            // Left behind, visible, deletable. Never worth failing an upload.
          }
        }
      }
      published = true;
    } catch (err) {
      if (err instanceof FsBrowseError) {
        refuse(err.status, err.message);
        return;
      }
      const mapped = fsErrorFor(
        (err as NodeJS.ErrnoException).code,
        new FsBrowseError(500, FS_UPLOAD_FAILED),
      );
      if (mapped.status >= 500) {
        log('error', `fs upload failed (${errorClass(err)}) ${errorFrames(err)}`);
      }
      refuse(mapped.status, mapped.message);
      return;
    }

    log('debug', 'PUT /api/fs/upload -> 201');
    deps.sendJson(res, 201, { bytes: written } satisfies FsUploadResponse);
  } finally {
    if (!published) {
      // EVERY failure path passes here: the part file never outlives the
      // request that made it. The only orphan left is a kill -9 / power loss,
      // which is visible in the listing and deletable by the user.
      try {
        unlinkSync(part);
      } catch {
        // Already gone (published, or never created) — nothing to do.
      }
    }
  }
}
