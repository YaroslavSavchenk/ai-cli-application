/**
 * POST /api/fs/rename — rename ONE entry in place (Nocturne B13).
 *
 *   POST /api/fs/rename
 *     content-type: application/json            (415 otherwise)
 *     body: { "path": "<abs>", "name": "<new>" } (≤ RENAME_MAX_BYTES)
 *     200 {}                                    (no path back — see below)
 *
 * SAME FOLDER ONLY: the new name is one plain segment, so the entry never
 * moves between folders. NEVER REPLACES: a taken name is a 409 (user decision
 * D1, `.claude/plans/nocturne/PLAN-B13.md`) — replacing would be a hidden
 * permanent delete. NO PATH COMES BACK: the server works on the realpath'd
 * parent, while the client's tree is keyed by the path as SHOWN (which may pass
 * through a symlinked folder), so the client builds the new path itself.
 *
 * SECURITY POSTURE, said out loud. This route grants NO new privilege: a caller
 * holding the app token can already POST /api/sessions and `mv` anything
 * through a spawned shell. The only new thing is a same-folder rename INSIDE
 * the boundary (home + every registered project root, via
 * resolveUnderAllowed on the PARENT), never of an anchor or of a folder that
 * contains one (D2), never of or into the data dir, and never replacing an
 * existing entry. The TOCTOU window between the parent's realpath and the
 * syscalls is the one server/fsbrowse.ts already accepts, for the same reasons.
 *
 * ATOMICITY. Node has no no-clobber rename (no renameat2/RENAME_NOREPLACE;
 * `fs.rename` replaces), so:
 *   - NOT A DIRECTORY (a file, or ANY symlink — one to a folder included):
 *     link(src, dst) is the atomic "only if absent" (EEXIST for any taken
 *     name, a dangling symlink included; Linux link(2) does not follow a final
 *     symlink), then unlink(src). A crash BETWEEN the two leaves both names —
 *     a visible, harmless duplicate, never a lost file.
 *   - A DIRECTORY cannot be hard-linked: lstat(dst) then rename(src, dst). A
 *     `dst` created in that window makes rename fail ENOTEMPTY (a non-empty
 *     folder) or ENOTDIR (a file); only an EMPTY folder created in exactly that
 *     window can be replaced silently. Accepted: nothing is lost with it.
 *   - LINK REFUSED (drvfs — a project under /mnt/c — or, on ext4, a file the
 *     user does not own under protected_hardlinks=1, which answers EPERM): the
 *     same lstat-then-rename fallback as server/fsupload.ts, with the same
 *     named race — an entry created in that window is replaced.
 *   - CASE-ONLY (`readme` -> `README`) when `dst` already resolves to the SAME
 *     dev+ino: lstat(dst) then rename. Named race: on a case-sensitive
 *     filesystem a DIFFERENT entry swapped in at `dst` between the two calls
 *     is replaced. Only a process of the same user can do that swap, in a
 *     window of one syscall — the same position as the other windows here.
 *
 * ASYNC ONLY (`node:fs/promises`): a synchronous rm once froze every PTY. The
 * one sync call left is the existing realpathSync inside resolveUnderAllowed.
 *
 * LOGGING: the status only. Never a name, never a path, never err.message — a
 * 5xx logs errorClass + errorFrames.
 *
 * Erasable TypeScript only; relative imports carry explicit .ts extensions.
 */
import { link, lstat, readdir, realpath, rename, unlink } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { FsRenameResponse } from '../shared/protocol.ts';
import { errorClass, errorFrames, isJsonContentType, type Logger } from './config.ts';
import {
  FsBrowseError,
  FS_ALREADY_EXISTS,
  FS_NAME_NOT_ALLOWED,
  FS_PATH_BAD,
  MAX_NAME_BYTES,
  anchorsFor,
  holdsConfiguredDataDir,
  holdsStoredProject,
  isDataDirUnder,
  isSafeSegment,
  isUnder,
  isUnderDataDir,
  resolveUnderAllowed,
} from './fsbrowse.ts';
import {
  FS_PROTECT_UNAVAILABLE,
  PROTECT_TIMEOUT_MS,
  ProtectTimeoutError,
  identityOf,
  protectedSetForRequest,
  withTimeout,
} from './fsprotect.ts';

/**
 * The route's own sentences. CONSTANTS: server/api.ts records a refusal in the
 * access log's `reason=`, so not one may carry a path, a name or an errno.
 * `FS_ALREADY_EXISTS`, `FS_NAME_NOT_ALLOWED` and `FS_PATH_BAD` are reused.
 */
export const FS_RENAME_GONE = 'That item is no longer there.';
export const FS_NO_RENAME_PERMISSION = 'You do not have permission to rename this.';
export const FS_RENAME_ANCHOR = 'The app cannot rename your home folder or a project folder.';
export const FS_RENAME_DATA_DIR = "The app's own folder cannot be renamed.";
export const FS_RENAME_BUSY = 'That item is in use right now.';
export const FS_RENAME_FAILED = 'The app could not rename that.';

/** The whole legitimate body is one path (PATH_MAX 4096) and one name. */
export const RENAME_MAX_BYTES = 16 * 1024;

/**
 * link(2) refusals that mean "this filesystem does not do hard links" (drvfs),
 * as opposed to "the name is taken" or "you may not": the fallback runs.
 */
const LINK_UNSUPPORTED = new Set(['EPERM', 'EXDEV', 'ENOSYS', 'ENOTSUP']);

/** A name this route accepts: one safe segment of at most 255 UTF-8 BYTES
 *  (isSafeSegment counts UTF-16 units — `é` is one unit and two bytes). */
function isRenamableName(name: string): boolean {
  return isSafeSegment(name) && Buffer.byteLength(name, 'utf8') <= MAX_NAME_BYTES;
}

/**
 * One errno, as the answer the request gets. PURE — no logging, no fs — so the
 * table is tested directly (tests/server/fs-rename.test.ts).
 */
export function renameErrorFor(code: string | undefined): FsBrowseError {
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return new FsBrowseError(404, FS_RENAME_GONE);
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return new FsBrowseError(403, FS_NO_RENAME_PERMISSION);
    // EEXIST from link(2); ENOTEMPTY/EISDIR from rename(2) when a dst appeared
    // in the lstat-then-rename window.
    case 'EEXIST':
    case 'ENOTEMPTY':
    case 'EISDIR':
      return new FsBrowseError(409, FS_ALREADY_EXISTS);
    case 'EBUSY':
    case 'ETXTBSY':
      return new FsBrowseError(409, FS_RENAME_BUSY);
    case 'ENAMETOOLONG':
      return new FsBrowseError(400, FS_NAME_NOT_ALLOWED);
    default:
      return new FsBrowseError(500, FS_RENAME_FAILED);
  }
}

/** Run an fs call; an errno becomes the route's answer. */
async function fsCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw renameErrorFor((err as NodeJS.ErrnoException).code);
  }
}

/** lstat that answers null for "nothing there" instead of throwing. */
async function lstatOrNull(p: string): Promise<BigIntStats | null> {
  try {
    return await lstat(p, { bigint: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw renameErrorFor((err as NodeJS.ErrnoException).code);
  }
}

/**
 * N5, by LOCATION (B13 test gate): `dst` is where a STORED project path would
 * land. The text test (holdsStoredProject(dst)) misses a stored path that runs
 * through a symlink: project stored as `<home>/g1-link/stale` (`g1-link ->
 * g1-real`, `stale` gone) is re-pointed by renaming `<home>/g1-real/other` to
 * `stale`. So each stored path whose NAME is `name` is located the way the
 * kernel would: realpath(dirname(P)) + basename(P). Only those paths cost a
 * realpath (usually none), and they are raced against the protected-set timer
 * — a dead mount under a stored path must not hang the route. A parent that
 * does not resolve is skipped: nothing can land there.
 *
 * KNOWN LIMIT: the compare is TEXT, so on a case-insensitive drvfs a
 * case-variant `name` (`Stale` for a stored `stale`) is not caught.
 */
async function dstIsStoredProjectLocation(
  dst: string,
  name: string,
  projects: readonly string[],
): Promise<boolean> {
  const candidates = projects
    .filter((p) => typeof p === 'string' && isAbsolute(p))
    .map((p) => resolve(p))
    .filter((p) => basename(p) === name);
  if (candidates.length === 0) return false;
  const located = await withTimeout(
    Promise.all(
      candidates.map(async (p) => {
        try {
          return join(await realpath(dirname(p)), basename(p));
        } catch {
          return null;
        }
      }),
    ),
    PROTECT_TIMEOUT_MS,
  );
  return located.includes(dst);
}

/**
 * Judge and perform ONE rename; throws FsBrowseError (or anything, mapped to a
 * 500 by the caller). ORDER IS THE SECURITY PROPERTY — see the numbered steps.
 */
async function renameOne(
  raw: string,
  name: string,
  projects: readonly string[],
  anchors: readonly string[],
): Promise<void> {
  // 1. Absolute and NUL-free BEFORE resolve(): resolve('x') anchors to the
  //    server's own cwd, which would turn a rejected relative path into a real
  //    one. Then the OLD last segment is a plain name (`/` has basename '').
  if (raw === '' || !isAbsolute(raw) || raw.includes('\0')) {
    throw new FsBrowseError(400, FS_PATH_BAD);
  }
  const lex = resolve(raw);
  const old = basename(lex);
  if (!isRenamableName(old)) throw new FsBrowseError(400, FS_NAME_NOT_ALLOWED);

  // 2. An anchor ITSELF, lexically, before the parent is resolved: home's
  //    parent lies outside the boundary, and resolving it first would answer
  //    "outside your home folder" for the one path the anchor sentence is for.
  if (anchors.includes(lex)) throw new FsBrowseError(403, FS_RENAME_ANCHOR);

  // 3. The PARENT through the boundary: an intermediate symlink is judged by
  //    where it really lands.
  const parentReal = resolveUnderAllowed(dirname(lex), {
    projects,
    gone: FS_RENAME_GONE,
    denied: FS_NO_RENAME_PERMISSION,
  });

  // 4. The NEW name is one plain segment — the reason join(parentReal, name)
  //    can never leave the parent. The same name is a no-op success.
  if (!isRenamableName(name)) throw new FsBrowseError(400, FS_NAME_NOT_ALLOWED);
  if (name === old) return;

  // 5. Anchors and data dir, on the lexical join under the REAL parent. A
  //    symlink `src` is NOT realpath'd: the entry itself is renamed, and
  //    rename(2)/link(2) never follow the final component.
  const src = join(parentReal, old);
  const dst = join(parentReal, name);
  //    The STORED project paths and the CONFIGURED data dir path are judged
  //    LEXICALLY as well (B13 security review), on `lex` (as asked) and `src`
  //    (under the real parent): a project registered through a symlink, or an
  //    AI_SM_DATA_DIR that runs through one, has a realpath that never equals
  //    the link's own path — so the realpath tests alone let the LINK holding
  //    a project or the data dir be renamed out from under it.
  if (
    anchors.some((anchor) => isUnder(anchor, src)) ||
    anchors.includes(dst) ||
    holdsStoredProject(lex, projects) ||
    holdsStoredProject(src, projects) ||
    // N5: nothing may be renamed ONTO the path a project is stored under (a
    // stale project would silently come back pointing at the wrong folder).
    holdsStoredProject(dst, projects) ||
    holdsStoredProject(join(dirname(lex), name), projects)
  ) {
    throw new FsBrowseError(403, FS_RENAME_ANCHOR);
  }
  if (
    isUnderDataDir(parentReal) ||
    isUnderDataDir(src) ||
    isDataDirUnder(src) ||
    isUnderDataDir(dst) ||
    holdsConfiguredDataDir(lex) ||
    holdsConfiguredDataDir(src)
  ) {
    throw new FsBrowseError(403, FS_RENAME_DATA_DIR);
  }

  // 6. Only now touch the entry: lstat it (NOT followed) and refuse by
  //    IDENTITY when it is on the kernel's walk to an anchor, a stored project
  //    or the configured data dir (server/fsprotect.ts). The string tests above
  //    stay as a first line — cheap, synchronous, and not subject to the set's
  //    5 s cache — but this is the check that also catches a symlink deeper in
  //    a chain and a drvfs case variant.
  // BIGINT: a drvfs inode can exceed 2^53 (server/fsprotect.ts realFs).
  const st = await fsCall(() => lstat(src, { bigint: true }));
  let set;
  try {
    // N5 by location, before the identity set: `dst` must not be where a
    // stored project path lands (see dstIsStoredProjectLocation).
    if (await dstIsStoredProjectLocation(dst, name, projects)) {
      throw new FsBrowseError(403, FS_RENAME_ANCHOR);
    }
    set = await protectedSetForRequest(projects, anchors);
  } catch (err) {
    // FAIL SAFE: without the set nothing is renamed.
    if (err instanceof ProtectTimeoutError) throw new FsBrowseError(503, FS_PROTECT_UNAVAILABLE);
    throw err;
  }
  const hit = set.get(identityOf(st));
  if (hit === 'anchor') throw new FsBrowseError(403, FS_RENAME_ANCHOR);
  if (hit === 'data') throw new FsBrowseError(403, FS_RENAME_DATA_DIR);

  // CASE-ONLY rename (`readme` -> `README`): on a case-insensitive filesystem
  // (drvfs) `dst` IS `src`, and link would answer EEXIST. Same dev+ino means
  // the same entry — rename directly. On POSIX the same dev+ino can also be
  // two hard links whose names differ only in case, where rename(2) is a
  // silent no-op: if the OLD name is still listed afterwards, the name was
  // really taken.
  if (name.toLowerCase() === old.toLowerCase()) {
    const there = await lstatOrNull(dst);
    if (there !== null) {
      if (there.dev !== st.dev || there.ino !== st.ino) {
        throw new FsBrowseError(409, FS_ALREADY_EXISTS);
      }
      await fsCall(() => rename(src, dst));
      const listed = await fsCall(() => readdir(parentReal));
      if (listed.includes(old)) throw new FsBrowseError(409, FS_ALREADY_EXISTS);
      return;
    }
  }

  if (st.isDirectory()) {
    // A folder cannot be hard-linked. The window between these two calls is
    // named in the header: a folder or file created in it makes rename fail
    // (ENOTEMPTY/ENOTDIR); only an EMPTY folder created there is replaced.
    if ((await lstatOrNull(dst)) !== null) throw new FsBrowseError(409, FS_ALREADY_EXISTS);
    await fsCall(() => rename(src, dst));
    return;
  }

  // A file or any symlink: link is the atomic no-clobber.
  try {
    await link(src, dst);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== undefined && LINK_UNSUPPORTED.has(code)) {
      // FALLBACK, NOT atomic: an entry created between this lstat and the
      // rename is replaced. lstat, not exists: a DANGLING symlink at `dst` is
      // taken. REACHABLE ON EXT4 TOO, not only drvfs: with
      // /proc/sys/fs/protected_hardlinks=1 (the Ubuntu default) link(2)
      // answers EPERM for a file the user does not own — e.g. a root-owned
      // file in a folder of their own — and rename is then the only way.
      if ((await lstatOrNull(dst)) !== null) throw new FsBrowseError(409, FS_ALREADY_EXISTS);
      await fsCall(() => rename(src, dst));
      return;
    }
    throw renameErrorFor(code);
  }
  try {
    await unlink(src);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // The old name is ALREADY gone (moved or removed by someone else between
    // the link and the unlink): `dst` is now the only name the file has, so
    // undoing it would lose the file. Keep it — the rename's outcome holds.
    if (code === 'ENOENT') return;
    // Undo the new name so the user is left with exactly what they had.
    // Best-effort: if even this fails, two names for one file is still no loss.
    await unlink(dst).catch(() => undefined);
    throw renameErrorFor(code);
  }
}

/** What the route needs from server/api.ts — the same shape as DeleteDeps. */
export interface RenameDeps {
  /** The registered project roots, read from the store PER REQUEST (anchors). */
  projects: () => string[];
  /** The `[fs]`-scoped logger. */
  log: Logger;
  /** 2xx answers. */
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  /** A refusal decided AFTER the body was read. */
  sendError: (res: ServerResponse, status: number, message: string) => void;
  /** A refusal decided BEFORE the body is read: answers `connection: close`. */
  sendErrorAndClose: (res: ServerResponse, status: number, message: string) => void;
  /** server/api.ts readJsonBodySafe — never the throwing reader (a parse error quotes the body). */
  readJson: (
    req: IncomingMessage,
    maxBytes: number,
  ) => Promise<{ ok: true; value: unknown } | { ok: false; reason: 'too-large' | 'invalid-json' }>;
}

/** The whole route. Answers every status itself and never throws. */
export async function handleRename(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RenameDeps,
): Promise<void> {
  const { log } = deps;
  const answer = (status: number, message: string, close: boolean): void => {
    log('info', `POST /api/fs/rename -> ${status}`);
    if (close) deps.sendErrorAndClose(res, status, message);
    else deps.sendError(res, status, message);
  };

  if ((req.method ?? 'GET') !== 'POST') {
    answer(405, 'method not allowed', true);
    return;
  }
  if (!isJsonContentType(req.headers['content-type'])) {
    answer(415, 'content-type must be application/json', true);
    return;
  }
  const read = await deps.readJson(req, RENAME_MAX_BYTES);
  if (!read.ok) {
    if (read.reason === 'too-large') answer(413, FS_PATH_BAD, true);
    else answer(400, FS_PATH_BAD, false);
    return;
  }
  const body = read.value as { path?: unknown; name?: unknown } | null;
  const raw = body?.path;
  const name = body?.name;
  if (typeof raw !== 'string') {
    answer(400, FS_PATH_BAD, false);
    return;
  }
  if (typeof name !== 'string') {
    answer(400, FS_NAME_NOT_ALLOWED, false);
    return;
  }

  // ONE read of the store and ONE anchor list for the whole request.
  const projects = deps.projects();
  const anchors = anchorsFor(projects);
  try {
    await renameOne(raw, name, projects, anchors);
  } catch (err) {
    // 503 is a refusal with its own sentence (the protected set timed out),
    // not a failure worth an error line.
    if (err instanceof FsBrowseError && (err.status < 500 || err.status === 503)) {
      answer(err.status, err.message, false);
      return;
    }
    // errorClass + FRAMES, never describeError: an errno message quotes paths.
    log('error', `fs rename failed (${errorClass(err)}) ${errorFrames(err)}`);
    answer(500, err instanceof FsBrowseError ? err.message : FS_RENAME_FAILED, false);
    return;
  }
  log('info', 'POST /api/fs/rename -> 200');
  deps.sendJson(res, 200, {} satisfies FsRenameResponse);
}
