/**
 * GET /api/fs/read + PUT /api/fs/write — the editor pane's ONE read and ONE
 * write (Nocturne B4 phase 1, `.claude/plans/nocturne/PLAN-B4.md` §1 of phase 1).
 *
 *   GET /api/fs/read?path=<abs>[&if=<stamp>]
 *     200 { changed: false, stamp }                       (`if` still current)
 *     200 { changed: true, stamp, text, eol, bom }        (text is LF-normalised)
 *
 *   PUT /api/fs/write
 *     body: { path, text, eol, bom, expect? }             (JSON, LF-normalised text)
 *     200 { stamp, bytes }
 *
 * `stamp` is the SHA-256 of the bytes ON DISK, opaque to the client — never an
 * mtime (a 1 s-granularity mtime on drvfs cannot tell two saves in the same
 * second apart, and a hash also answers "the bytes came back identical").
 *
 * A SAVE WRITES IN PLACE: open, compare, `ftruncate`, write, `fsync`, close —
 * never a temp file plus rename. The inode number, the mode, the owner and
 * every hard link therefore survive a save, and a file the user cannot write
 * answers 403 instead of being REPLACED through a writable parent folder (which
 * is exactly what a rename-based save does). The stamp is compared on the SAME
 * fd that is then truncated and written, so the check-to-write window is closed
 * entirely: nothing can slip between the comparison and the write.
 *
 * WHAT KEEPS BOTH ROUTES INSIDE THE BOUNDARY, in the order it is applied:
 *   1. `resolveUnderAllowed()` — the SAME call createEntry() and the upload
 *      make: absolute, NUL-free, realpathed, contained in home or a registered
 *      project root. A symlink INSIDE the boundary is therefore READ AND
 *      WRITTEN AT ITS TARGET (editing through a link edits the file it names);
 *      a link that lands outside every anchor is a 403, like a listing.
 *   2. `isUnderDataDir()` — the folder holding the auth token, prefs.json and
 *      history.json is not a place to edit files. NOT a security boundary (a
 *      caller holding the token can spawn a shell) — a category rule, the same
 *      one createEntry() and the upload apply.
 *   3. THE OPEN IS JUDGED, NEVER THE PATH TWICE: `O_NOFOLLOW | O_NONBLOCK`,
 *      then `fstatSync(fd)` must say a REGULAR file before the first read or
 *      write. Every later syscall uses that fd, so no second path lookup can
 *      land somewhere else.
 *   4. A create (only when `expect` is absent — the pane's `Overwrite` of a
 *      file that is gone) resolves the PARENT through the boundary and checks
 *      the final NAME with `isSafeSegment` + the 255-BYTE limit, then opens
 *      `O_CREAT|O_EXCL|O_NOFOLLOW`: a link planted at that name is never
 *      followed, it answers EEXIST / ELOOP instead.
 * TOCTOU between the realpath and the open is the accepted, documented position
 * of server/fsbrowse.ts — the same window, for the same reasons (a process able
 * to plant a symlink in the user's home at that instant already runs as that
 * user). The write's compare-then-write on ONE fd closes the check-to-write
 * window entirely, which is the half that would otherwise cost data.
 *
 * HARD LINKS ARE NOT SEEN. A hard link is a second NAME for one inode, not a
 * path to follow, so nothing above can notice it: a link inside home whose
 * inode lives OUTSIDE every anchor — or IS a file of the data dir — passes
 * `resolveUnderAllowed()` and `isUnderDataDir()` (both judge the PATH, and this
 * path is legitimately in home), and the in-place write then goes THROUGH the
 * link into the shared inode. MEASURED: `ln <dataDir>/runtime.json
 * ~/work/hl-runtime.json` reads 200 with the auth token in the body and writes
 * 200 over runtime.json itself; `ln <outside>/secret.txt ~/work/hl.txt` reads
 * 200 and writes the outside file. ACCEPTED, for the reasons the symlink TOCTOU
 * above is accepted: planting the link already requires running AS this user,
 * Windows cannot make a Linux hard link through `\\wsl.localhost`,
 * `fs.protected_hardlinks` limits the rest, and the requester holds the token
 * that can already spawn a shell. An `nlink > 1` refusal was REJECTED: pnpm's
 * `node_modules/.pnpm/**` files are hard links into its store, so such a rule
 * would refuse to open half the real files of a project. The two
 * `KNOWN LIMIT:` tests in tests/fs-text.test.ts keep this behaviour explicit.
 *
 * MEASURED ON node v24.14.0 / Linux 6.6.87.2-microsoft-standard-WSL2, not
 * assumed (each of these decides a status code below):
 *   - `openSync(dir, O_RDONLY|O_NOFOLLOW|O_NONBLOCK)` SUCCEEDS on a directory;
 *     `fstat().isDirectory()` is what refuses it (400). With O_RDWR the kernel
 *     answers EISDIR at the open instead — so both routes answer 400 for a
 *     folder, by two different paths.
 *   - A FIFO opens immediately under `O_NONBLOCK` (O_RDONLY and O_RDWR alike)
 *     and `fstat().isFIFO()` refuses it (415). WITHOUT O_NONBLOCK the O_RDONLY
 *     open BLOCKS THE WHOLE SERVER until a writer appears —
 *     memory/knowledge/fifo-open-blocks-main-thread.md, and `O_NOFOLLOW` is no
 *     defence against it.
 *   - A UNIX-DOMAIN SOCKET cannot be opened at all: `open(2)` answers ENXIO
 *     BEFORE there is an fd, so `fstat` never gets to judge it — the errno
 *     table is what answers 415 for it (MEASURED without ENXIO in that table: a
 *     500 plus an `[error] fs read failed (FsBrowseError)` line).
 *   - A symlink at the final component answers ELOOP under `O_NOFOLLOW` (both
 *     routes), which is reachable here only as a race or a planted name.
 *   - `chmod 0444` + O_RDWR answers EACCES (403); a 0444 file is still READ.
 *
 * LOGGING: counts and statuses only. Never a path, never a byte of text, never
 * a stamp — a 5xx logs the error CLASS, its FRAMES and the errno CODE
 * (`code=ENXIO`, a constant identifier), never `describeError`, because an
 * errno message quotes the path it failed on.
 *
 * Erasable TypeScript only; relative imports carry explicit .ts extensions.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, resolve } from 'node:path';
import {
  FS_TEXT_MAX_BYTES,
  type FsEol,
  type FsReadResponse,
  type FsWriteResponse,
} from '../shared/protocol.ts';
import { errorClass, errorFrames, type Logger } from './config.ts';
import {
  FsBrowseError,
  FS_PATH_BAD,
  MAX_NAME_BYTES,
  isSafeSegment,
  isUnderDataDir,
  resolveUnderAllowed,
} from './fsbrowse.ts';
import { FS_DISK_FULL } from './fsupload.ts';
import { isExistingDirectory } from './projects.ts';

/**
 * The user-facing sentences of these two routes. CONSTANTS, every one of them:
 * server/api.ts records a refusal message in `responseReason` for the access
 * log, and that channel never carries anything derived from a request. They are
 * also the copy the editor pane renders verbatim, so not one of them may carry
 * a path, a name, an errno or a stamp.
 *
 * `FS_PATH_BAD` (400) and `FS_OUTSIDE_HOME` (403) are reused from
 * server/fsbrowse.ts unchanged, and `FS_DISK_FULL` (507) from
 * server/fsupload.ts: a malformed path is a malformed path, and a full disk is
 * a full disk.
 */
export const FS_TEXT_NO_READ_PERMISSION = 'You do not have permission to read this file.';
export const FS_TEXT_NO_WRITE_PERMISSION = 'You do not have permission to change this file.';
export const FS_TEXT_DATA_DIR_REFUSED = "The app's own folder is not a place to edit files.";
export const FS_TEXT_GONE = 'This file is no longer there.';
export const FS_TEXT_CONFLICT = 'This file changed on disk since you opened it.';
export const FS_TEXT_TOO_BIG = 'This file is too large to open here.';
export const FS_TEXT_NOT_TEXT = 'This file is not text, so the editor cannot show it.';
export const FS_TEXT_READ_FAILED = 'The app could not read this file.';
export const FS_TEXT_SAVE_FAILED = 'The app could not save this file.';

/**
 * Body cap of the WRITE route — NOT the generic MAX_BODY_BYTES (1 MiB), and the
 * global one is deliberately left alone. A 1 MiB text is legal, and JSON
 * escaping can SEXTUPLE it: every byte of a text made of C0 control characters
 * costs SIX (`\u001b`), and a 1 MiB file of ESC bytes is a file the READ route
 * serves 200 — so the factor is 6, not 4, or a file this editor opens could not
 * be saved (MEASURED at factor 4: read 200, save 413). The other UTF-8 forms
 * stay well under it (`\n`, `\"`, `\\` are 2×; a lone U+2028 is 3 UTF-8 bytes to
 * 6 JSON ones). Plus 4096 for `path`, `eol`, `bom`, `expect` and the braces.
 * Anything past this is refused before it is parsed; the TEXT itself is still
 * capped at FS_TEXT_MAX_BYTES after encoding.
 */
export const FS_WRITE_MAX_BODY_BYTES = FS_TEXT_MAX_BYTES * 6 + 4096;

/**
 * Linux PATH_MAX. A path longer than this cannot name anything, and without
 * this gate the kernel's ENAMETOOLONG from `realpathSync` arrives as a 500 for
 * what is plainly a path problem (MEASURED: a 400-byte final segment answered
 * `The app could not read this folder.` before this check existed).
 */
export const MAX_PATH_BYTES = 4096;

/**
 * True when no file can ever be at `raw`: the whole path over PATH_MAX, or ONE
 * segment over the filesystem's 255-BYTE NAME_MAX. Pure, and it refuses BEFORE
 * any syscall — which is also what lets the write route tell "this file is not
 * there, create it" (404) apart from "this is not a path" (400).
 *
 * BYTES, not characters: `é` is one UTF-16 code unit and two bytes, the same
 * trap createEntry() documents.
 */
export function pathTooLong(raw: string): boolean {
  if (Buffer.byteLength(raw, 'utf8') > MAX_PATH_BYTES) return true;
  return raw.split('/').some((segment) => Buffer.byteLength(segment, 'utf8') > MAX_NAME_BYTES);
}

/** A stamp as it travels: sha256, lower-case hex, nothing else. */
const STAMP_RE = /^[0-9a-f]{64}$/;

/** True when `value` is a stamp this server could have produced. */
export function isStamp(value: unknown): value is string {
  return typeof value === 'string' && STAMP_RE.test(value);
}

/** The stamp of some bytes: their SHA-256, hex. The ONLY stamp function. */
export function stampOf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** What a readable text file decodes to. */
export interface DecodedText {
  /** LF-normalised, BOM stripped. */
  text: string;
  /** The kind of the FIRST line break; `lf` when there is none. */
  eol: FsEol;
  /** The file started with U+FEFF. */
  bom: boolean;
}

/**
 * Bytes as editable text, or null when they are not text at all.
 *
 * NULL for exactly two reasons, and both are the 415 sentence:
 *   - a NUL byte ANYWHERE. It is the one signal that separates "a file with an
 *     odd encoding" from "a binary", and a NUL cannot survive the round trip
 *     through a textarea and a JSON body anyway.
 *   - not valid UTF-8 (`TextDecoder('utf-8', { fatal: true })` throws). The
 *     alternative — the replacement character — would show the user a file and
 *     then SAVE U+FFFD over the bytes it could not read.
 *
 * `eol` is the kind of the FIRST line break, so a mixed file comes back uniform
 * on the next save (the decided behaviour, not a bug): the text is normalised
 * to LF here and encodeText() puts ONE kind back.
 *
 * A LONE `\r` (old-Mac line endings) is not a line break here: it survives
 * unchanged through decode and encode, which keeps the round trip byte-exact
 * for files nobody should have to guess about.
 */
export function decodeText(buf: Buffer): DecodedText | null {
  // Before the decoder: a NUL is legal UTF-8, so only this test catches it.
  if (buf.includes(0)) return null;
  let raw: string;
  try {
    // `ignoreBOM: true` is the OPPOSITE of what its name suggests, and getting
    // it wrong was a real bug this test suite caught: the DEFAULT
    // (`ignoreBOM: false`) makes the decoder SWALLOW a leading U+FEFF, so the
    // file's BOM never reached the check below and every BOM file came back
    // `bom: false` — and was then saved without its BOM. `true` = "leave the
    // BOM in the string", which is what lets this function report it.
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    return null; // Not UTF-8 — a latin-1 text, a JPEG, a compiled binary.
  }
  const bom = raw.charCodeAt(0) === 0xfeff;
  const body = bom ? raw.slice(1) : raw;
  const firstLf = body.indexOf('\n');
  const eol: FsEol = firstLf > 0 && body.charCodeAt(firstLf - 1) === 0x0d ? 'crlf' : 'lf';
  // ALL CRLF pairs, not just the first: the text the client edits is LF-only,
  // and `eol` is what puts the file's own ending back.
  return { text: body.replace(/\r\n/g, '\n'), eol, bom };
}

/**
 * Text as the bytes to put on disk — the exact inverse of decodeText() for
 * every file whose line endings are uniform (pinned by a property test).
 *
 * `\n` → `\r\n` when `eol` is `crlf`, and NOTHING else is touched: a stray `\r`
 * the client sends is written as sent. That is the literal rule from the spec,
 * and it is what makes the round trip byte-exact — the client never sends a
 * `\r\n` (the field normalises to LF), so the doubling that rule would produce
 * for one is unreachable from the app.
 */
export function encodeText(text: string, eol: FsEol, bom: boolean): Buffer {
  const body = eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text;
  return Buffer.from(bom ? `\uFEFF${body}` : body, 'utf8');
}

/** What both routes need from server/api.ts. Injected, so this module has no HTTP policy of its own. */
export interface TextDeps {
  /** The registered project roots, read from the store PER REQUEST (anchors). */
  projects: () => string[];
  /** The `[fs]`-scoped logger. */
  log: Logger;
  /** 2xx answers. */
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  /** A refusal decided AFTER the body was read; the connection stays reusable. */
  sendError: (res: ServerResponse, status: number, message: string) => void;
  /**
   * A refusal decided BEFORE the body is read (405, 413). It answers
   * `connection: close` so a client streaming a 4 MiB body into a server that
   * has already said no is cut off instead of drained.
   */
  sendErrorAndClose: (res: ServerResponse, status: number, message: string) => void;
  /**
   * server/api.ts readJsonBodySafe — NEVER the throwing reader: a JSON parse
   * error quotes a fragment of the body, and this body is the user's text.
   */
  readJson: (
    req: IncomingMessage,
    maxBytes: number,
  ) => Promise<{ ok: true; value: unknown } | { ok: false; reason: 'too-large' | 'invalid-json' }>;
}

/**
 * Read exactly `size` bytes from `fd`, or as many as there are.
 *
 * The size comes from the `fstat` of this same fd, so a file GROWING under the
 * read is cut at what it was (and its stamp is the stamp of what was read — the
 * next 5 s poll answers `changed: true` and the pane follows). A file that
 * SHRANK gives a short read, and the buffer is trimmed to what arrived rather
 * than padded with zero bytes, which would read as a binary.
 */
function readAll(fd: number, size: number): Buffer {
  const buf = Buffer.allocUnsafe(size);
  let read = 0;
  while (read < size) {
    // `position: null` — read from the fd's own offset, so the loop advances.
    const n = readSync(fd, buf, read, size - read, null);
    if (n === 0) break; // EOF: the file shrank under the read.
    read += n;
  }
  return read === size ? buf : buf.subarray(0, read);
}

/**
 * An errno as an identifier for a LOG line: ` code=ENXIO`, or `''` when the
 * error carries no errno. A constant from the kernel's own vocabulary and
 * nothing else — never a message, never a path (an errno message quotes the
 * path it failed on, which is why this module may not log `describeError`), so
 * the shape is checked before the code is printed.
 *
 * It is what makes a 5xx line diagnosable at all: textErrorFor() maps the raw
 * error to an FsBrowseError, and that mapped error is what the catch site sees.
 */
export function errnoTag(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? ` code=${code}` : '';
}

/**
 * One errno, as the refusal it earns. PURE, and the ONE place either route maps
 * a kernel answer — so the table can be read (and tested) as a table.
 *
 * `read` picks the sentence and the fallback of the failing side. Everything
 * not listed is a 500 with the route's own sentence, logged as class + frames +
 * `code=<ERRNO>`: the raw code is carried ON the mapped error (never in the
 * message the user reads), because the mapped error is all the catch site gets.
 */
export function textErrorFor(code: string | undefined, read: boolean): FsBrowseError {
  const mapped = mapErrno(code, read);
  if (typeof code === 'string') (mapped as FsBrowseError & { code?: string }).code = code;
  return mapped;
}

/** textErrorFor()'s table itself, without the errno-carrying step. */
function mapErrno(code: string | undefined, read: boolean): FsBrowseError {
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return new FsBrowseError(404, FS_TEXT_GONE);
    case 'EACCES':
    case 'EPERM':
    // A read-only mount is not a permission the user holds, but it is the same
    // answer from where they sit: this file cannot be changed by you, here.
    case 'EROFS':
    // Writing a file that is being executed right now. Same category.
    case 'ETXTBSY':
      return new FsBrowseError(403, read ? FS_TEXT_NO_READ_PERMISSION : FS_TEXT_NO_WRITE_PERMISSION);
    // A directory. The READ side never gets here (O_RDONLY on a directory
    // SUCCEEDS on Linux — measured; the fstat rule answers 400 instead); the
    // WRITE side does, because O_RDWR on a directory is EISDIR.
    case 'EISDIR':
      return new FsBrowseError(400, FS_PATH_BAD);
    // O_NOFOLLOW met a symlink at the final component: a race, or a link
    // planted at a name that was free a moment ago. The SAME category answer a
    // FIFO or a device gets — not a regular file, so not something this editor
    // touches. `fstat` cannot be the one to say it, because O_NOFOLLOW refuses
    // before there is an fd to stat.
    case 'ELOOP':
    // A UNIX-DOMAIN SOCKET (and a FIFO or device the kernel has no reader or no
    // backing for): `open(2)` answers ENXIO BEFORE there is an fd, so the fstat
    // rule cannot be the one to refuse it. Same category as a FIFO — not a
    // regular file, so not something this editor touches; without this case it
    // was the default 500 plus an `[error]` line.
    case 'ENXIO':
      return new FsBrowseError(415, FS_TEXT_NOT_TEXT);
    case 'ENAMETOOLONG':
      return new FsBrowseError(400, FS_PATH_BAD);
    case 'ENOSPC':
    case 'EDQUOT':
      return new FsBrowseError(507, FS_DISK_FULL);
    default:
      return new FsBrowseError(500, read ? FS_TEXT_READ_FAILED : FS_TEXT_SAVE_FAILED);
  }
}

/** The fstat rule, shared by both routes: a REGULAR file or nothing. Returns its size. */
function requireRegular(fd: number): number {
  const st = fstatSync(fd);
  // A folder is a PATH mistake, not an encoding one — the pane must not offer
  // "this is not text" for something the user can browse into.
  if (st.isDirectory()) throw new FsBrowseError(400, FS_PATH_BAD);
  // A FIFO, a character or block device. The O_NONBLOCK in the open is what
  // makes it possible to be standing here at all with a FIFO. A unix-domain
  // SOCKET never reaches this stat: its open fails ENXIO before there is an fd,
  // so the errno table is what answers 415 for it.
  if (!st.isFile()) throw new FsBrowseError(415, FS_TEXT_NOT_TEXT);
  return st.size;
}

// ---------------------------------------------------------------------------
// GET /api/fs/read
// ---------------------------------------------------------------------------

/**
 * The whole read route. Answers every status itself (including 405) and never
 * throws: a rejection here would land in api.ts's generic handler, which is one
 * more place a path could reach a log line.
 */
export function handleRead(req: IncomingMessage, res: ServerResponse, url: URL, deps: TextDeps): void {
  const { log } = deps;
  /**
   * Every refusal: the status on the `[fs]` channel, then the response.
   *
   * DEBUG, not info: the access log already writes one info line per request
   * with the route, the status, the duration and `reason=<sentence>`, and an
   * open editor pane polls this route every 5 s — at info a refused poll would
   * write two identical lines every five seconds for as long as the pane is
   * open. A 5xx is logged ONCE more, by its thrower, with class + frames.
   */
  const refuse = (status: number, message: string): void => {
    log('debug', `GET /api/fs/read -> ${status}`);
    deps.sendError(res, status, message);
  };

  if ((req.method ?? 'GET') !== 'GET') {
    // sendErrorAndClose: a POST/PUT to this route may be streaming a body into
    // a server that has already said no.
    deps.sendErrorAndClose(res, 405, 'method not allowed');
    return;
  }

  // --- The request, before any syscall --------------------------------------
  const rawPath = url.searchParams.get('path');
  if (rawPath === null || rawPath === '') {
    refuse(400, FS_PATH_BAD);
    return;
  }
  if (pathTooLong(rawPath)) {
    // No file can be at a path this long: a 400, not the 500 an
    // ENAMETOOLONG from realpath would otherwise become.
    refuse(400, FS_PATH_BAD);
    return;
  }
  const rawIf = url.searchParams.get('if');
  // An EMPTY `if` counts as absent (a client that has no stamp yet may send the
  // parameter empty); anything else must be a stamp this server could have made.
  const ifStamp = rawIf === null || rawIf === '' ? undefined : rawIf;
  if (ifStamp !== undefined && !isStamp(ifStamp)) {
    refuse(400, FS_PATH_BAD);
    return;
  }

  let fd: number | undefined;
  try {
    const real = resolveUnderAllowed(rawPath, {
      projects: deps.projects(),
      gone: FS_TEXT_GONE,
      denied: FS_TEXT_NO_READ_PERMISSION,
    });
    if (isUnderDataDir(real)) throw new FsBrowseError(403, FS_TEXT_DATA_DIR_REFUSED);

    // O_NOFOLLOW: `real` is a realpath, so a symlink standing here is a race or
    // a planted name, never the link the user asked to edit (that one was
    // followed by realpath, and its TARGET is what `real` names).
    // O_NONBLOCK: a FIFO would otherwise block the whole server in this open.
    try {
      fd = openSync(
        real,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
    } catch (err) {
      throw textErrorFor((err as NodeJS.ErrnoException).code, true);
    }
    // The fd is judged BEFORE the first read: a directory (400), a FIFO or a
    // device (415), and the cap BEFORE a byte is read.
    const size = requireRegular(fd);
    if (size > FS_TEXT_MAX_BYTES) throw new FsBrowseError(413, FS_TEXT_TOO_BIG);

    const bytes = readAll(fd, size);
    const decoded = decodeText(bytes);
    if (decoded === null) throw new FsBrowseError(415, FS_TEXT_NOT_TEXT);
    const stamp = stampOf(bytes);

    if (ifStamp === stamp) {
      // The 5 s disk follow, matched: no text, no body worth the name. The
      // count is the WORD `unchanged` — never the stamp that matched.
      log('debug', 'GET /api/fs/read -> 200, unchanged');
      deps.sendJson(res, 200, { changed: false, stamp } satisfies FsReadResponse);
      return;
    }
    log('debug', `GET /api/fs/read -> 200, ${bytes.byteLength} bytes`);
    deps.sendJson(res, 200, {
      changed: true,
      stamp,
      text: decoded.text,
      eol: decoded.eol,
      bom: decoded.bom,
    } satisfies FsReadResponse);
  } catch (err) {
    const mapped =
      err instanceof FsBrowseError
        ? err
        : textErrorFor((err as NodeJS.ErrnoException).code, true);
    if (mapped.status >= 500) {
      // errorClass + FRAMES + the errno CODE, never describeError: an errno
      // message quotes the path it failed on, while the code is a constant.
      log('error', `fs read failed (${errorClass(err)})${errnoTag(err)} ${errorFrames(err)}`);
    }
    refuse(mapped.status, mapped.message);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already closed, or a broken fd: nothing left to do with it.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// PUT /api/fs/write
// ---------------------------------------------------------------------------

/** The body, once every field has been judged. */
interface WriteRequest {
  path: string;
  bytes: Buffer;
  /** undefined = write regardless (the pane's `Overwrite`, which also recreates a gone file). */
  expect: string | undefined;
}

/**
 * The body as this route will act on it, or the refusal one field earns.
 * PURE: no fs, no logging, so the whole gate can be tested as a function.
 */
function readBody(value: unknown): WriteRequest | FsBrowseError {
  const body = (value ?? {}) as Record<string, unknown>;
  const path = body['path'];
  const text = body['text'];
  const eol = body['eol'];
  const bom = body['bom'];
  if (typeof path !== 'string' || path === '') return new FsBrowseError(400, FS_PATH_BAD);
  // Before any syscall: a path no file can be at is a 400. Without it the
  // create branch below could never be reached for such a path either — a
  // realpath that fails ENAMETOOLONG is not the 404 that says "create it".
  if (pathTooLong(path)) return new FsBrowseError(400, FS_PATH_BAD);
  if (typeof text !== 'string') return new FsBrowseError(400, FS_PATH_BAD);
  if (eol !== 'lf' && eol !== 'crlf') return new FsBrowseError(400, FS_PATH_BAD);
  if (typeof bom !== 'boolean') return new FsBrowseError(400, FS_PATH_BAD);
  const rawExpect = body['expect'];
  // Absent, null or EMPTY all mean "no expectation" — the Overwrite button.
  // Anything else must be a stamp this server could have produced.
  const expect =
    rawExpect === undefined || rawExpect === null || rawExpect === '' ? undefined : rawExpect;
  if (expect !== undefined && !isStamp(expect)) return new FsBrowseError(400, FS_PATH_BAD);
  const bytes = encodeText(text, eol, bom);
  // The cap is on the BYTES, after encoding: a 1 MiB text of CRLF lines is more
  // than 1 MiB on disk, and the file is what the limit is about.
  if (bytes.byteLength > FS_TEXT_MAX_BYTES) return new FsBrowseError(413, FS_TEXT_TOO_BIG);
  return { path, bytes, expect };
}

/** `encoded` onto `fd` from position 0, as many syscalls as it takes. */
function writeAll(fd: number, encoded: Buffer): void {
  let written = 0;
  while (written < encoded.byteLength) {
    // The POSITION is explicit: the compare above read the file, so the fd's own
    // offset sits at the end of the OLD bytes.
    written += writeSync(fd, encoded, written, encoded.byteLength - written, written);
  }
}

/**
 * Write `encoded` into the file `fd` names: compare, truncate, write, fsync.
 * The fd is the ONE thing this function trusts — it was opened O_NOFOLLOW and
 * fstat'ed by the caller.
 */
function writeInPlace(fd: number, encoded: Buffer, expect: string | undefined): void {
  const size = requireRegular(fd);
  if (expect !== undefined) {
    // The bytes are read to be HASHED, so the cap applies here too — a 40 MiB
    // file cannot be pulled into memory to be told it changed.
    if (size > FS_TEXT_MAX_BYTES) throw new FsBrowseError(413, FS_TEXT_TOO_BIG);
    if (stampOf(readAll(fd, size)) !== expect) {
      throw new FsBrowseError(409, FS_TEXT_CONFLICT);
    }
  }
  // With `expect` ABSENT (the pane's `Overwrite`) there is no compare and no
  // size or text check: a file the READ side refused as too large (413) or as
  // not text (415) is truncated to the text the user typed — intended, "mine
  // wins" is what the button says.
  //
  // ONE fd from here to the end: nothing can slip between the comparison and
  // the write, and the inode, mode, owner and every hard link survive.
  ftruncateSync(fd, 0);
  writeAll(fd, encoded);
  // The editor's save is a user action with an expectation behind it: the bytes
  // are on the disk when the 200 is answered, not in a page cache that a
  // power loss would drop.
  fsyncSync(fd);
}

/**
 * The whole write route. Answers every status itself (including 405) and never
 * throws, for the same reason the read route does not.
 */
export async function handleWrite(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TextDeps,
): Promise<void> {
  const { log } = deps;
  const refuse = (status: number, message: string, close = false): void => {
    // DEBUG for a refusal, like the read route: the access log already carries
    // the route, the status and the sentence at info.
    log('debug', `PUT /api/fs/write -> ${status}`);
    if (close) deps.sendErrorAndClose(res, status, message);
    else deps.sendError(res, status, message);
  };

  if ((req.method ?? 'GET') !== 'PUT') {
    deps.sendErrorAndClose(res, 405, 'method not allowed');
    return;
  }

  // NO content-type check, deliberately, and unlike POST /api/fs/delete: the
  // pane must be able to read a 415 as ONE sentence ("this file is not text"),
  // and POST /api/fs/create — the other route this one is modelled on — checks
  // none either. What stands in front of this route is the token gate plus the
  // Host/Origin rules in server/api.ts, which no cross-site form can satisfy.
  const read = await deps.readJson(req, FS_WRITE_MAX_BODY_BYTES);
  if (!read.ok) {
    // The parse failure is NOT reported with its error — it would quote the
    // user's text. A body past the cap gets the one 413 sentence and the
    // connection closed (the upload's rule): it is still streaming.
    if (read.reason === 'too-large') refuse(413, FS_TEXT_TOO_BIG, true);
    else refuse(400, FS_PATH_BAD);
    return;
  }
  const body = readBody(read.value);
  if (body instanceof FsBrowseError) {
    refuse(body.status, body.message);
    return;
  }

  let fd: number | undefined;
  try {
    // --- The target -------------------------------------------------------
    //
    // `real` null = the file is not there AND `expect` is absent: the pane's
    // `Overwrite` of a file that was deleted under it (spec D3). Then, and only
    // then, the PARENT is what goes through the boundary — resolveUnderAllowed
    // answers 404 for the FILE path, so there is nothing else to resolve.
    let real: string | null;
    try {
      real = resolveUnderAllowed(body.path, {
        projects: deps.projects(),
        gone: FS_TEXT_GONE,
        denied: FS_TEXT_NO_WRITE_PERMISSION,
      });
    } catch (err) {
      if (body.expect === undefined && err instanceof FsBrowseError && err.status === 404) {
        real = null;
      } else {
        throw err;
      }
    }

    if (real !== null) {
      if (isUnderDataDir(real)) throw new FsBrowseError(403, FS_TEXT_DATA_DIR_REFUSED);
      try {
        // No O_CREAT: this branch is for a file that EXISTS. O_NOFOLLOW +
        // O_NONBLOCK for the same two reasons the read has them.
        fd = openSync(
          real,
          fsConstants.O_RDWR | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
        );
      } catch (err) {
        throw textErrorFor((err as NodeJS.ErrnoException).code, false);
      }
      writeInPlace(fd, body.bytes, body.expect);
    } else {
      // --- The create case ---------------------------------------------------
      // The path was absolute and NUL-free (resolveUnderAllowed refuses those
      // with a 400, which is not the 404 that brought us here), so it is safe
      // to take it apart lexically: `resolve` only collapses `.` and `..`.
      const lex = resolve(body.path);
      const name = basename(lex);
      // The whole vocabulary of a name, exactly as createEntry() and the upload
      // apply it: no `/`, no `\`, no control character, no all-dots name, and
      // the filesystem's 255-BYTE limit (isSafeSegment counts UTF-16 CODE
      // UNITS — `é` is one unit and two bytes).
      if (!isSafeSegment(name) || Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
        throw new FsBrowseError(400, FS_PATH_BAD);
      }
      const parentReal = resolveUnderAllowed(dirname(lex), {
        projects: deps.projects(),
        gone: FS_TEXT_GONE,
        denied: FS_TEXT_NO_WRITE_PERMISSION,
      });
      if (!isExistingDirectory(parentReal)) throw new FsBrowseError(404, FS_TEXT_GONE);
      if (isUnderDataDir(parentReal)) throw new FsBrowseError(403, FS_TEXT_DATA_DIR_REFUSED);
      const target = resolve(parentReal, name);
      try {
        // O_EXCL is the point: it fails EEXIST rather than truncating, and
        // together with O_NOFOLLOW it refuses to follow a link planted at this
        // name — a pre-planted `notes.txt -> /etc/passwd` is never written
        // through. Mode 0666 minus the umask: an ordinary user file.
        fd = openSync(
          target,
          fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            fsConstants.O_NOFOLLOW,
          0o666,
        );
        writeAll(fd, body.bytes);
        fsyncSync(fd);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw textErrorFor(code, false);
        // SOMETHING stands at the name now — a sibling process recreated the
        // file, or a link is planted there. `expect` is absent, so the user
        // asked to write REGARDLESS: take the ordinary in-place path, which
        // opens O_NOFOLLOW and therefore answers ELOOP (415) for a link
        // instead of writing through it.
        try {
          fd = openSync(
            target,
            fsConstants.O_RDWR | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
          );
        } catch (again) {
          throw textErrorFor((again as NodeJS.ErrnoException).code, false);
        }
        writeInPlace(fd, body.bytes, undefined);
      }
    }

    log('info', `PUT /api/fs/write -> 200, ${body.bytes.byteLength} bytes`);
    deps.sendJson(res, 200, {
      stamp: stampOf(body.bytes),
      bytes: body.bytes.byteLength,
    } satisfies FsWriteResponse);
  } catch (err) {
    const mapped =
      err instanceof FsBrowseError
        ? err
        : textErrorFor((err as NodeJS.ErrnoException).code, false);
    if (mapped.status >= 500) {
      log('error', `fs write failed (${errorClass(err)})${errnoTag(err)} ${errorFrames(err)}`);
    }
    refuse(mapped.status, mapped.message);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already closed, or a broken fd: nothing left to do with it.
      }
    }
  }
}
