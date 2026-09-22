/**
 * POST /api/fs/delete — the app's FIRST delete primitive (Nocturne B10a).
 *
 *   POST /api/fs/delete
 *     content-type: application/json            (415 otherwise)
 *     body: { "paths": ["<abs>", …] }           (≤ MAX_DELETE_ITEMS, ≤ 64 KiB)
 *     200 { results: [{ ok: true } | { ok: false, status, error }, …] }
 *
 * PERMANENT: unlink / rm -r, no trash, no undo (user decision 2026-09-20,
 * memory/decisions/b10a-multi-select-and-delete.md — the freedesktop trash was
 * rejected because neither this app nor Explorer's Recycle Bin would show it).
 * The single confirmation the client puts in front of this call is the only
 * stop there is.
 *
 * THE BATCH IS A UNIT OF TRANSPORT, NEVER OF OUTCOME. Each path is judged and
 * deleted on its own, in request order, and a failure never stops the items
 * after it; the response is a 200 whenever the REQUEST is well-formed, with one
 * index-keyed result per path. No path and no name travels back — the caller
 * built the list, and a field no row renders is a field that leaks for free.
 *
 * SECURITY POSTURE, said out loud. This route destroys data, so it is worth
 * being explicit about what it is and is not. It is NOT what stands between an
 * attacker and the user's files: a caller holding the app token can already
 * POST /api/sessions and `rm -rf` anything through a spawned shell. What this
 * boundary buys is that the FILES PANEL cannot be talked into deleting
 * something the panel could never show — the same rule the rest of the panel
 * lives by, applied to the one operation that cannot be taken back:
 *
 *   1. never outside the anchors  — home + every registered project root, via
 *      resolveUnderAllowed() on the entry's PARENT (realpath, the same call
 *      createEntry() makes), so a `..` that lexically leaves the boundary, a
 *      relative path, a NUL or a planted parent symlink landing outside is a
 *      refusal before any syscall;
 *   2. never an anchor ITSELF    — the panel root and every project root are
 *      refused (FS_DELETE_ANCHOR): one stray Ctrl+A must not be able to remove
 *      the home folder or a whole project;
 *   3. never the data dir        — the folder holding the auth token,
 *      prefs.json and history.json, neither as the target nor as a parent;
 *   4. never THROUGH a symlink   — MEASURED on node v24.14.0, not assumed:
 *      `rm(p, { recursive: true })` lstats the final component (its ENOENT says
 *      `lstat`), so a link — to a file, to a directory, or dangling — is
 *      UNLINKED and its target is untouched, and links found inside a deleted
 *      tree are unlinked the same way. tests/fs-delete.test.ts plants both and
 *      asserts the outside target survives.
 *
 * A NON-SYMLINK TARGET NEEDS NO SECOND REALPATH: its parent is already real
 * (resolveUnderAllowed returns a realpath) and the name is a plain segment, so
 * the anchor and data-dir comparisons run on the lexical `join(parentReal,
 * name)` — which is the very path `rm` is then called on. A SYMLINK is not
 * resolved either: unlinking a link changes nothing at the other end, so a link
 * into a project or into the data dir is an ordinary deletable row.
 *
 * KNOWN LIMIT — MOUNT POINTS. `rm -r` here has no one-file-system flag (Node
 * exposes none): a filesystem mounted UNDER home (a USB stick at
 * `~/media/stick`, a bind mount) is walked and deleted like any other folder.
 * The user can see it in the panel and it is inside their own home, so this is
 * the same answer `rm -rf ~/media/stick` gives in a terminal — recorded so it
 * is a known property, not a surprise.
 *
 * TOCTOU between the realpath and the rm is the accepted, documented position
 * of server/fsbrowse.ts — the same window, for the same reasons.
 *
 * ASYNCHRONOUS: `rm` from `node:fs/promises`, never `rmSync` — a synchronous
 * delete of a 20k-file tree blocked every PTY for 400 ms (measured, B10a). The
 * cap of MAX_DELETE_ITEMS bounds the number of roots, not the size of one tree.
 *
 * IDENTITY (B13, 2026-09-22; `.claude/plans/nocturne/PLAN-B13.md`): besides the
 * string comparisons, a target whose `dev:ino` lies on the walked chain of an
 * anchor, a STORED project path or the CONFIGURED data dir is refused
 * (server/fsprotect.ts) — a symlink deeper in such a chain, and a drvfs case
 * variant, pass every string test. A walk hung past 3 s answers 503.
 *
 * LOGGING: counts and statuses only. Never a name, never a path, never a body
 * value — a 5xx logs the error CLASS and its FRAMES, never `describeError`:
 * rm's EACCES message quotes the failing path TWICE (measured:
 * `EACCES, Permission denied: <p> '<p>'`).
 *
 * Erasable TypeScript only; relative imports carry explicit .ts extensions.
 */
import { lstat, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  MAX_DELETE_ITEMS,
  type FsDeleteResult,
  type FsDeleteResponse,
} from '../shared/protocol.ts';
import { errorClass, errorFrames, type Logger } from './config.ts';
import {
  FsBrowseError,
  FS_NAME_NOT_ALLOWED,
  FS_PATH_BAD,
  MAX_NAME_BYTES,
  anchorsFor,
  holdsConfiguredDataDir,
  holdsStoredProject,
  isDataDirUnder,
  isSafeSegment,
  isUnderDataDir,
  resolveUnderAllowed,
} from './fsbrowse.ts';
import {
  FS_PROTECT_UNAVAILABLE,
  ProtectTimeoutError,
  identityOf,
  protectedSetForRequest,
  type ProtectedSet,
} from './fsprotect.ts';

/**
 * The new user-facing sentences. They live HERE rather than beside the browse
 * family in server/fsbrowse.ts because every one of them is about deleting —
 * fsbrowse's `FS_DATA_DIR_REFUSED` ("…not a place to create files") would be
 * the wrong sentence on this route. `FS_PATH_BAD` and `FS_NAME_NOT_ALLOWED`
 * are reused from there unchanged: a malformed path is a malformed path.
 *
 * CONSTANTS, all of them: server/api.ts records a whole-request refusal in
 * `responseReason` for the access log, and per-item ones land verbatim in
 * `results[i].error`, so not one of them may carry a path, a name or an errno.
 */
export const FS_DELETE_GONE = 'That item is no longer there.';
export const FS_NO_DELETE_PERMISSION = 'You do not have permission to delete this.';
export const FS_DELETE_ANCHOR = 'The app cannot delete your home folder or a project folder.';
export const FS_DELETE_DATA_DIR = "The app's own folder is not a place to delete from.";
export const FS_DELETE_BUSY = 'That item is in use right now.';
export const FS_DELETE_CHANGED = 'Something changed inside it while it was being deleted.';
export const FS_DELETE_FAILED = 'The app could not delete that.';
/**
 * Built from the cap so the sentence and the number can never drift apart.
 * Still a constant: nothing in it comes from a request.
 */
export const FS_DELETE_TOO_MANY = `Too many items. Delete up to ${MAX_DELETE_ITEMS} at a time.`;

/**
 * Dedicated body cap — NOT the generic 1 MiB. The whole legitimate body is
 * `{"paths":[…]}` with at most MAX_DELETE_ITEMS paths, and Linux PATH_MAX is
 * 4096: 512 KiB leaves ~5200 bytes per path at the cap, so a full selection of
 * genuinely deep paths can never be refused for being "too many items" when it
 * is not. (At 64 KiB — the first cut — the budget was ~650 bytes per path and
 * 100 deep paths answered that sentence falsely.) Anything past this is still
 * refused before it is parsed, and it answers the SAME 413 + sentence a
 * too-long list does: from the client's side both mean "this selection is too
 * much for one request".
 */
export const DELETE_MAX_BYTES = 512 * 1024;

/** How many times rm retries a transient ENOTEMPTY/EBUSY, and how long between. */
export const DELETE_MAX_RETRIES = 3;
export const DELETE_RETRY_DELAY_MS = 50;

/**
 * `application/json`, with or without parameters (charset), case-insensitive.
 * A TWIN of the private helper of the same name in server/api.ts: three lines,
 * copied rather than exported, so this module keeps no import of the HTTP layer
 * it is injected into. If one changes, change both.
 */
function isJsonContentType(value: string | string[] | undefined): boolean {
  if (typeof value !== 'string') return false;
  return value.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/**
 * One errno, as the answer that ITEM gets. PURE — no logging, no fs — so the
 * table can be tested directly (tests/fs-delete.test.ts) instead of only
 * through filesystem states that are hard to produce on purpose.
 *
 * ENOENT is a 404 here; the CALLER turns it into `{ ok: true }` when an
 * ancestor was deleted earlier in the same request (see deleteOne).
 */
export function deleteErrorFor(code: string | undefined): FsBrowseError {
  switch (code) {
    // ENOTDIR = a component of the path is a file, which for a delete means
    // the same thing ENOENT does: the thing asked about is not there.
    case 'ENOENT':
    case 'ENOTDIR':
      return new FsBrowseError(404, FS_DELETE_GONE);
    // EROFS is a read-only mount — not a permission the user holds, but the
    // same answer from where they sit: this cannot be deleted by you, here.
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return new FsBrowseError(403, FS_NO_DELETE_PERMISSION);
    // ENOTEMPTY after `recursive: true` AND the retries means something is
    // still WRITING into the tree while it is being removed.
    case 'ENOTEMPTY':
      return new FsBrowseError(409, FS_DELETE_CHANGED);
    // A mount point, or a running executable's own file.
    case 'EBUSY':
    case 'ETXTBSY':
      return new FsBrowseError(409, FS_DELETE_BUSY);
    case 'ENAMETOOLONG':
      return new FsBrowseError(400, FS_NAME_NOT_ALLOWED);
    // TRIPWIRE, unreachable today: Node raises ERR_FS_EISDIR only for a
    // NON-recursive rm of a directory, and this route always passes
    // `recursive: true`. If it ever appears in server.log, the options object
    // stopped being what this comment says it is.
    case 'ERR_FS_EISDIR':
      return new FsBrowseError(500, FS_DELETE_FAILED);
    default:
      return new FsBrowseError(500, FS_DELETE_FAILED);
  }
}

/** `p` is `root` itself or something under it. String test on resolved paths. */
function isUnderPath(p: string, root: string): boolean {
  return p === root || p.startsWith(root + sep);
}

/**
 * True when `p` is inside — or is — something this same request already
 * deleted. The ONE thing that turns a "not there" into `{ ok: true }`:
 * selecting a folder AND a file inside it is an ordinary Explorer selection,
 * and both are gone at the end, which is what was asked for. A missing path
 * with no such ancestor stays a 404.
 *
 * TWO CALL SITES, and the FIRST is the one that fires in practice: a child of a
 * deleted folder has no parent left, so `resolveUnderAllowed(dirname())` throws
 * 404 before any rm is attempted. The second (an ENOENT from `rm` itself) is
 * the narrow race where the parent still resolves but the entry is already
 * gone — a sibling process, or a link whose target vanished.
 */
function coveredBy(p: string, removed: readonly string[]): boolean {
  return removed.some((done) => isUnderPath(p, done));
}

/**
 * Delete ONE path, and never throw: the result is the return value, so the loop
 * over a batch cannot be interrupted by any single item.
 *
 * `projects` and `anchors` are read ONCE per request by the caller, so every
 * item in one batch is judged against the same anchor list — anchorsFor()
 * caches a realpath for 5 s, and a batch that outlives that window must not
 * start disagreeing with itself halfway through. `removed` is what this request
 * has already deleted (see the ENOENT rule at the bottom).
 *
 * ORDER IS THE SECURITY PROPERTY:
 *   1. the raw path is absolute and NUL-free BEFORE `resolve()` — `resolve('x')`
 *      silently anchors to the server's own cwd, which would turn a rejected
 *      relative path into a real one (memory/knowledge/path-normalization-
 *      delete-primitive);
 *   2. the last segment passes isSafeSegment and the 255-BYTE name limit — the
 *      whole vocabulary of a name here, and the reason join(parentReal, name)
 *      can never leave the parent;
 *   3. the PARENT goes through resolveUnderAllowed — realpath + anchors — so
 *      the item is judged where the kernel would land, not where the string
 *      looks like it points;
 *   4. an anchor is refused as the target AND as anything the target contains;
 *   5. the data dir is refused the same way — as parent, as target, and as
 *      something the target would take with it;
 *   6. only then does anything get removed.
 */
async function deleteOne(
  raw: unknown,
  projects: readonly string[],
  anchors: readonly string[],
  removed: string[],
  index: number,
  log: Logger,
  getProtectedSet: () => Promise<ProtectedSet>,
): Promise<FsDeleteResult> {
  try {
    if (typeof raw !== 'string' || raw === '' || !isAbsolute(raw) || raw.includes('\0')) {
      throw new FsBrowseError(400, FS_PATH_BAD);
    }
    // LEXICAL only, and only after isAbsolute: it collapses `.` and `..` so the
    // parent that gets resolved is the one this path really names. A `..` that
    // walks out of the boundary is then refused by the anchors below, not here.
    const lex = resolve(raw);
    const name = basename(lex);
    // `/` (basename ''), a `..` that survived, a control character, a name over
    // 255 BYTES (isSafeSegment counts UTF-16 code units — `é` is one unit and
    // two bytes, the same trap createEntry() documents).
    if (!isSafeSegment(name) || Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
      throw new FsBrowseError(400, FS_NAME_NOT_ALLOWED);
    }
    // The anchors THEMSELVES, lexically, before the parent is resolved: the
    // home folder's parent lies outside the boundary, so resolving it first
    // would answer "outside your home folder" for the one path the anchor
    // sentence exists for (found by the B10a verify-terminal pass).
    if (anchors.includes(lex)) throw new FsBrowseError(403, FS_DELETE_ANCHOR);
    let parentReal: string;
    try {
      parentReal = resolveUnderAllowed(dirname(lex), {
        projects,
        gone: FS_DELETE_GONE,
        denied: FS_NO_DELETE_PERMISSION,
      });
    } catch (err) {
      // The PARENT is gone because THIS request deleted it a moment ago: the
      // item the user selected is gone, which is what they asked for. Compared
      // lexically, because there is no parent left to realpath.
      if (err instanceof FsBrowseError && err.status === 404 && coveredBy(lex, removed)) {
        return { ok: true };
      }
      throw err;
    }
    const target = join(parentReal, name);
    // CONTAINMENT RUNS BOTH WAYS, and the second direction is the one that was
    // missing until it was measured (2026-09-20 review).
    //
    // THE ANCHORS FIRST: an anchor is refused as the target AND as anything the
    // target contains — `isUnderPath(anchor, target)` covers both. MEASURED
    // before the fix: with a project registered at `<home>/projects/foo`,
    // `paths:['<home>/projects']` answered ok and the project was gone, so
    // Ctrl+A in the Home tab plus one confirmation removed every project under
    // `~/projects`. Home is judged here rather than by the data-dir rule below
    // (the default data dir lives inside home, so both would refuse it) because
    // "your home folder" is the sentence that tells the user what happened.
    //
    // AND THE STORED PROJECT PATHS, lexically (B13 security review): a project
    // registered THROUGH a symlink (`<home>/proj-link`, or `<home>/lnk/proj`
    // with `lnk` a link) has a realpath anchor that never equals the link's own
    // path, so the realpath test alone let the link — the name the project is
    // registered under — be deleted. Judged on `lex` (as asked) and `target`
    // (under the real parent).
    if (
      anchors.some((anchor) => isUnderPath(anchor, target)) ||
      holdsStoredProject(lex, projects) ||
      holdsStoredProject(target, projects)
    ) {
      throw new FsBrowseError(403, FS_DELETE_ANCHOR);
    }
    // THEN THE DATA DIR, both ways too: the PARENT test stops a delete INSIDE
    // it, and `isDataDirUnder` stops `rm -r` on a folder that CONTAINS it. With
    // a custom AI_SM_DATA_DIR at `<home>/dd/data`, deleting `<home>/dd` would
    // otherwise take the auth token, prefs.json, history.json and runtime.json
    // with it. NOT a security boundary — a token holder can rm it through a
    // shell — but the Files panel must not do it by accident.
    // The CONFIGURED data dir path is judged lexically too (B13 security review):
    // with AI_SM_DATA_DIR running through a symlink, the LINK holding it is not
    // under the real data dir, yet deleting it cuts the backend off its token.
    if (
      isUnderDataDir(parentReal) ||
      isUnderDataDir(target) ||
      isDataDirUnder(target) ||
      holdsConfiguredDataDir(lex) ||
      holdsConfiguredDataDir(target)
    ) {
      throw new FsBrowseError(403, FS_DELETE_DATA_DIR);
    }
    // THE REALPATH COMPARISONS RUN ON `target` AND NOTHING ELSE (the lexical
    // stored-project and configured-data-dir tests above take `lex` too).
    // There was a second pass here that realpathed a non-symlink target and
    // compared again; the
    // 2026-09-20 gate proved it dead and it is gone: `parentReal` is already a
    // realpath and `name` is a plain segment, so for a non-symlink
    // `realpath(target) === target` — a tripwire `if (targetReal !== target)
    // throw` survived the whole suite. A SYMLINK needs no comparison either:
    // unlinking a link changes nothing at the other end, so a link into a
    // project or into the data dir is an ordinary deletable row.

    // BY IDENTITY, the check the strings above cannot make (B13 security
    // re-review, server/fsprotect.ts): the entry itself — lstat, NOT followed
    // — must not be on the kernel's walk to an anchor, a stored project path
    // or the configured data dir. That catches a symlink DEEPER in a chain
    // (`<home>/a/lnk/proj` with `a -> b`, `b/lnk -> c`: deleting `b/lnk`) and a
    // drvfs case variant (`/mnt/c/work/proj` vs the anchor `.../Proj`). The
    // string tests stay as a first line: cheap, synchronous, uncached.
    let targetStat;
    try {
      // BIGINT: a drvfs inode can exceed 2^53 (server/fsprotect.ts realFs).
      targetStat = await lstat(target, { bigint: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' && coveredBy(target, removed)) return { ok: true };
      throw deleteErrorFor(code);
    }
    let protectedSet: ProtectedSet;
    try {
      protectedSet = await getProtectedSet();
    } catch (err) {
      // FAIL SAFE: without the set nothing is deleted.
      if (err instanceof ProtectTimeoutError) throw new FsBrowseError(503, FS_PROTECT_UNAVAILABLE);
      throw err;
    }
    const hit = protectedSet.get(identityOf(targetStat));
    if (hit === 'anchor') throw new FsBrowseError(403, FS_DELETE_ANCHOR);
    if (hit === 'data') throw new FsBrowseError(403, FS_DELETE_DATA_DIR);

    try {
      // ONE call for every kind of entry, and the PROMISES rm, never rmSync:
      // MEASURED, `rmSync` of a 20k-file tree blocked the event loop for 404 ms
      // with zero timer ticks — no PTY byte, no resize, no presence ping moved
      // while a `node_modules` was being deleted. The async one yields between
      // entries, which is the whole difference.
      //
      // MEASURED on node v24.14.0 for both forms: rm lstats the final
      // component, so a symlink (to a file, to a directory, or dangling) is
      // UNLINKED and never followed, a file is unlinked and a directory is
      // walked — and links found INSIDE a tree are unlinked the same way.
      // `force: false` so a vanished item is a 404 rather than a silent
      // success; the retries ride out a transient ENOTEMPTY/EBUSY from
      // something still writing into the tree.
      await rm(target, {
        recursive: true,
        force: false,
        maxRetries: DELETE_MAX_RETRIES,
        retryDelay: DELETE_RETRY_DELAY_MS,
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // A path UNDER something this same request already deleted is not a
      // failure: the item the user selected is gone, which is exactly what they
      // asked for. The COMMON form of that (a child of a deleted folder) is
      // answered earlier, where the vanished parent fails to resolve; this is
      // the race where the parent still resolves and the entry does not.
      if (code === 'ENOENT' && coveredBy(target, removed)) {
        return { ok: true };
      }
      throw deleteErrorFor(code);
    }
    removed.push(target);
    return { ok: true };
  } catch (err) {
    const mapped =
      err instanceof FsBrowseError ? err : new FsBrowseError(500, FS_DELETE_FAILED);
    if (mapped.status >= 500 && mapped.status !== 503) {
      // errorClass + FRAMES, never describeError: rm's errno message quotes the
      // path it failed on, twice.
      log('error', `fs delete failed (${errorClass(err)}) ${errorFrames(err)}`);
      log('debug', `delete item ${index} -> 500`);
      return { ok: false, status: 500, error: FS_DELETE_FAILED };
    }
    log('debug', `delete item ${index} -> ${mapped.status}`);
    return { ok: false, status: mapped.status, error: mapped.message };
  }
}

/** What the route needs from server/api.ts. Injected, so this module has no HTTP policy of its own. */
export interface DeleteDeps {
  /** The registered project roots, read from the store PER REQUEST (anchors). */
  projects: () => string[];
  /** The `[fs]`-scoped logger. */
  log: Logger;
  /** 2xx answers. */
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  /** A refusal decided AFTER the body was read; the connection stays reusable. */
  sendError: (res: ServerResponse, status: number, message: string) => void;
  /**
   * A refusal decided BEFORE the body is read (405/415/413). It answers
   * `connection: close` so a client streaming a body into a server that has
   * already said no is cut off instead of drained.
   */
  sendErrorAndClose: (res: ServerResponse, status: number, message: string) => void;
  /**
   * server/api.ts readJsonBodySafe — NEVER the throwing reader: a JSON parse
   * error quotes a fragment of the body, and this body is nothing but paths.
   */
  readJson: (
    req: IncomingMessage,
    maxBytes: number,
  ) => Promise<{ ok: true; value: unknown } | { ok: false; reason: 'too-large' | 'invalid-json' }>;
}

/**
 * The whole route. Answers every status itself (including 405) and never
 * throws: a rejection here would land in api.ts's generic handler, which is one
 * more place a path could reach a log line.
 */
export async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DeleteDeps,
): Promise<void> {
  const { log } = deps;
  // DEBUG, not info, for a whole-request refusal: the access log already writes
  // one info line per request with the route, the status and `reason=<sentence>`.
  const refuse = (status: number, message: string, close: boolean): void => {
    log('debug', `POST /api/fs/delete -> ${status}`);
    if (close) deps.sendErrorAndClose(res, status, message);
    else deps.sendError(res, status, message);
  };

  if ((req.method ?? 'GET') !== 'POST') {
    deps.sendErrorAndClose(res, 405, 'method not allowed');
    return;
  }
  if (!isJsonContentType(req.headers['content-type'])) {
    refuse(415, 'content-type must be application/json', true);
    return;
  }

  const read = await deps.readJson(req, DELETE_MAX_BYTES);
  if (!read.ok) {
    // A body past the cap is the same answer a list past the cap gets: too much
    // for one request. The parse failure is NOT reported with its error — it
    // would quote the paths.
    if (read.reason === 'too-large') refuse(413, FS_DELETE_TOO_MANY, true);
    else refuse(400, FS_PATH_BAD, false);
    return;
  }
  const paths = (read.value as { paths?: unknown } | null)?.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    refuse(400, FS_PATH_BAD, false);
    return;
  }
  if (paths.length > MAX_DELETE_ITEMS) {
    // NOTHING is deleted: the cap is checked before the first item runs, so an
    // over-long selection is never half-applied.
    refuse(413, FS_DELETE_TOO_MANY, false);
    return;
  }

  // ONE read of the store for the whole batch: every item is judged against the
  // same anchor list, and a project registered mid-batch cannot widen it. The
  // anchors are resolved ONCE here too — anchorsFor() memoises a realpath for
  // 5 s, and a batch that deletes a large tree can outlive that window, so
  // resolving per item would let the boundary change halfway through a request.
  const projects = deps.projects();
  const anchors = anchorsFor(projects);
  // What this request has already removed, for the parent-before-child rule.
  const removed: string[] = [];
  // SEQUENTIAL, and never Promise.all: `results[i]` must belong to `paths[i]`,
  // the parent-before-child rule reads what earlier items removed, and a
  // hundred concurrent recursive deletes would be a worse neighbour than the
  // synchronous version this replaced. A non-string element is that ITEM's 400
  // — the rest of the batch is still answered.
  // The protected-entry set (server/fsprotect.ts), fetched ONCE per request and
  // only when an item gets that far: every item is judged against the same
  // set, and a set that TIMED OUT answers 503 for the rest of the batch at once
  // instead of making each of up to 100 items wait out its own timer.
  let setPromise: Promise<ProtectedSet> | null = null;
  const getProtectedSet = (): Promise<ProtectedSet> => {
    setPromise ??= protectedSetForRequest(projects, anchors);
    return setPromise;
  };
  const results: FsDeleteResult[] = [];
  for (let i = 0; i < paths.length; i += 1) {
    results.push(await deleteOne(paths[i], projects, anchors, removed, i, log, getProtectedSet));
  }
  const ok = results.filter((r) => r.ok).length;
  log('info', `POST /api/fs/delete -> 200, ${ok} ok, ${results.length - ok} failed`);
  deps.sendJson(res, 200, { results } satisfies FsDeleteResponse);
}
