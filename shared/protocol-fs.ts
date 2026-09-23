/**
 * Wire shapes for the Files panel on the real file system: entries, create, upload, Windows path, delete, rename, editor read/write.
 *
 * Split from shared/protocol.ts (O8, 2026-09-23) — a pure move; the wire
 * contract is unchanged. Import from shared/protocol.ts, which re-exports
 * everything here. Sibling pieces: 
 *   protocol.ts (the single import point), protocol-settings.ts, protocol-runtime.ts, protocol-github.ts, protocol-fs.ts, protocol-git.ts.
 */

// ---------------------------------------------------------------------------
// Files panel on the real file system (Nocturne B2 + A9c, .claude/plans/nocturne/PLAN-B2.md)
// ---------------------------------------------------------------------------
//
// Three routes, all under /api (token-gated like every other one), all
// confined by server/fsbrowse.ts resolveUnderAllowed to an ANCHOR LIST
// (realpath-based): the user's HOME, plus the path of every project registered
// in projects.json — a project the user registered outside home is theirs too
// (user decision 2026-09-16). The picker's /api/fs/list and /api/fs/mkdir are
// NOT confined at all — they choose a project folder anywhere on the machine,
// and the folder about to become a project is by definition not an anchor yet.
// Every error is a CONSTANT sentence in the server module; nothing a client
// sent is ever echoed back.

/** GET /api/fs/entries?path=<abs> — one entry of one folder's listing. */
export interface FsEntry {
  /** Last path segment. UNTRUSTED display text — textContent, never innerHTML. */
  name: string;
  /** A directory, or a symlink that resolves to one. */
  dir: boolean;
}

/** GET /api/fs/entries?path=<abs> (path omitted = the user's home). */
export interface FsEntriesResponse {
  /** The RESOLVED absolute path that was listed (the client keys its cache on it). */
  path: string;
  /** Folders first, then files; case-insensitive natural order; at most the cap. */
  entries: FsEntry[];
  /** Entries NOT in `entries` because the folder is larger than the cap. 0 normally. */
  truncated: number;
}

/** POST /api/fs/create — one empty file or one directory, strictly under an anchor. */
export interface FsCreateRequest {
  /** Absolute path of the EXISTING folder it goes in. */
  dir: string;
  /** A single safe path segment (server/fsbrowse.ts isSafeSegment). */
  name: string;
  kind: 'file' | 'folder';
}

/** 201. The created thing's absolute path. */
export interface FsCreateResponse {
  path: string;
}

// ---------------------------------------------------------------------------
// Real file upload + the Windows form of a path (Nocturne B10, .claude/plans/nocturne/PLAN-B10.md)
// ---------------------------------------------------------------------------
//
// PUT /api/fs/upload?dir=<abs dest>&rel=<relative path>&mode=replace|new
//   content-type: application/octet-stream     (415 otherwise)
//   content-length: <n>                        (411 when absent or chunked)
//   body: the file's bytes, verbatim           -> 201 FsUploadResponse
//
// ONE raw-body PUT per file, never multipart: a raw body lets the server refuse
// on content-length BEFORE reading a byte, and a multipart parser would be a new
// security-relevant parser in a repo with two runtime dependencies. The
// destination goes through the SAME anchor boundary as /api/fs/create
// (server/fsbrowse.ts resolveUnderAllowed); `rel` is split on `/` and every
// segment passes isSafeSegment, so it can never escape the destination.

/** The biggest single file the upload route accepts, in bytes. The client's
 *  MAX_ITEM_BYTES is this constant; there is one number, not two. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** The only body type PUT /api/fs/upload accepts. A cross-site form post cannot
 *  set it, so it is a CSRF guard beside the Origin/Host/token gate. */
export const UPLOAD_CONTENT_TYPE = 'application/octet-stream';

/**
 * How one uploaded file meets a name that is already taken.
 *  - 'replace': the existing file is replaced atomically (rename over it).
 *  - 'new':     the name must be free; 409 otherwise. The default of every
 *               file the client did not plan as a deliberate overwrite.
 */
export type FsUploadMode = 'replace' | 'new';

/** 201 of PUT /api/fs/upload. The bytes that really landed — no path: the
 *  caller built it, and a field no row renders is a field that leaks for free. */
export interface FsUploadResponse { bytes: number }

/** GET /api/fs/winpath?path=<abs> — the Windows form of a path inside the
 *  boundary, for the native host's clipboard (part B10 phase 3). */
export interface FsWinPathResponse { windowsPath: string }

// ---------------------------------------------------------------------------
// Permanent delete (Nocturne B10a) — POST /api/fs/delete
// ---------------------------------------------------------------------------
//
// The app's FIRST delete primitive. PERMANENT: no trash, no undo (user
// decision 2026-09-20, memory/decisions/b10a-multi-select-and-delete.md), so
// the ONE confirmation the client shows before it calls this is the only stop.
//
// ONE REQUEST PER CONFIRMED ACTION: the client asks once, the user confirms
// once, and the whole selection travels in a single POST. The BATCH is the unit
// of transport, never of outcome: each path is judged and deleted
// independently, in request order, and a failure never stops the ones after it.
// The request is therefore a 200 whenever it is WELL-FORMED — a partial batch is
// an ordinary answer, not an error — and `results` is INDEX-KEYED to `paths`,
// carrying a status and a constant sentence per item. NO PATH COMES BACK: the
// caller built the list, and a field no row renders is a field that leaks for
// free.
//
// The boundary is server/fsbrowse.ts resolveUnderAllowed, exactly as for
// /api/fs/create and /api/fs/upload (home + every registered project root),
// plus two refusals this route adds: an ANCHOR itself (the panel root, a
// project root) is never deletable, and neither is the app's own data dir. A
// symlink is UNLINKED, never followed: the link goes, whatever it points at.

/** Paths one POST /api/fs/delete may carry. */
export const MAX_DELETE_ITEMS = 100;

/** POST /api/fs/delete body: absolute paths inside the boundary, in any order. */
export interface FsDeleteRequest { paths: string[] }

/** One item's fate, index-keyed to the request (no path comes back). */
export type FsDeleteResult = { ok: true } | { ok: false; status: number; error: string };

/** 200 of POST /api/fs/delete — always 200 when the REQUEST is well-formed;
 *  each item carries its own status, so a partial batch is an ordinary answer. */
export interface FsDeleteResponse { results: FsDeleteResult[] }

// ---------------------------------------------------------------------------
// Rename in place (Nocturne B13) — POST /api/fs/rename
// ---------------------------------------------------------------------------
//
// A SAME-FOLDER rename of one entry (`.claude/plans/nocturne/PLAN-B13.md` § 1).
// Same boundary as /api/fs/delete: never an anchor (home, a project root, or a
// folder that contains one), never the data dir, and NEVER replacing an entry
// that already has the new name (409, user decision D1 — a replace would be a
// hidden permanent delete). A symlink is renamed itself, never followed.
//
// NO PATH COMES BACK: the server works on the realpath'd parent, the tree is
// keyed by the path as SHOWN (which may pass through a symlinked folder), so
// the client builds the new path itself: `dirname(path) + '/' + name`.

/** POST /api/fs/rename body: the entry's absolute path and its new name
 *  (one plain segment: no `/`, no `\`, no control character, not all dots,
 *  at most 255 UTF-8 bytes). */
export interface FsRenameRequest { path: string; name: string }

/** 200 of POST /api/fs/rename — empty on purpose (see above). A rename to the
 *  SAME name is a 200 with nothing done. Refusals are `{ error }` + status. */
export type FsRenameResponse = Record<string, never>;

// ---------------------------------------------------------------------------
// Editor (Nocturne B4) — GET /api/fs/read, PUT /api/fs/write
// ---------------------------------------------------------------------------
//
// The editor pane's ONE read and ONE write (`.claude/plans/nocturne/PLAN-B4.md`).
// Both take an absolute path through the same anchor boundary as
// /api/fs/create (home + every registered project root, the data dir refused).
// Text only: at most FS_TEXT_MAX_BYTES, UTF-8, no NUL byte — anything else is
// refused with a sentence (413 too large, 415 not text), never sent as bytes.
//
// `stamp` is the server's hash of the bytes on disk, OPAQUE to the client. A
// read with `if=<stamp>` answers `{ changed: false }` when the file is still
// those bytes (the 5 s disk follow costs no body then); a write with
// `expect: <stamp>` is refused with 409 when the file changed since (user
// decision D4) — the client never computes a stamp, only hands one back.
//
// Text travels LF-normalised both ways; `eol` and `bom` say what the file used
// so a write restores them. Neither the path nor a byte of text is ever logged.

/** The most bytes the editor reads or writes; larger answers 413. */
export const FS_TEXT_MAX_BYTES = 1024 * 1024;

/** The line ending a file uses — the kind of its FIRST line break; `lf` when it has none. */
export type FsEol = 'lf' | 'crlf';

/**
 * GET /api/fs/read?path=<abs>&if=<stamp, optional>. With `if` equal to the
 * current stamp the answer is `{ changed: false, stamp }` and carries no text.
 */
export type FsReadResponse =
  | { changed: false; stamp: string }
  | { changed: true; stamp: string; text: string; eol: FsEol; bom: boolean };

/**
 * PUT /api/fs/write — JSON body, `text` LF-normalised. `expect` = the stamp the
 * text was edited from: a mismatch answers 409, a file that is gone 404; absent
 * = write regardless (the editor's `Overwrite`, which also recreates a gone file).
 */
export interface FsWriteRequest {
  path: string;
  text: string;
  eol: FsEol;
  bom: boolean;
  expect?: string;
}

/** 200 of PUT /api/fs/write: the new stamp and the bytes that landed. */
export interface FsWriteResponse { stamp: string; bytes: number }
