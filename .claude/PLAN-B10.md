# Plan B10 — Real file copy into the WSL file system, and copy-to-clipboard via the host (Nocturne Track B)

Status: LANDED 2026-09-20 (`5779d23`; started the same day on the user's "ga door
met b10", next in the plan order after B5; verify-terminal 11/11 PASS; user-verified
on Windows the same day: "alles werkt"). Parent: `.claude/PLAN-NOCTURNE.md` part A9 + B10. A9 (2026-09-15) and A9b
(2026-09-16) built the visual half on a mock transport; A9c + B2 (2026-09-16) made
the Files panel a real browser. B10 replaces the pretence with a real write, and
makes the A9b context-menu `Copy` live through the native host. Runs through
`/dev-flow` (lean rules 1–11); `security-auditor` mandatory on phases 1 and 3 (a
new file-write primitive from a browser origin, and a new page→native message
channel); `/verify-terminal` once at the end. Designed by the Plan agent
2026-09-20 from the seams as read; line numbers drift — verify by reading.
Decisions rationale: `memory/decisions/b10-file-copy-and-clipboard.md`.

## User decisions (2026-09-20, all three the orchestrator's advice)

- **D1 scope.** B10 = (a) real upload for drop + paste + `Copy files here…`, and
  (b) copy-to-clipboard from the app through the native host
  (`Clipboard.SetFileDropList` with `\\wsl.localhost\<distro>\…`), which makes the
  A9b row menu's `Copy` live. The host half is the LAST phase, gated on the user's
  own Windows build + check. **No drag OUT of the app** (§4, last paragraph). The
  row menu's `Paste` does NOT go live (orchestrator, 2026-09-20: a page sees files
  only inside a real `paste` event; the host could read the clipboard's file list,
  but copying those would need a read-anywhere server primitive this app
  deliberately lacks) — it keeps `PASTE_NOTE`, which already points at the
  keyboard, where paste works.
- **D2 folder conflicts, one choice per drop.** `Replace` = merge into the existing
  folder, same-named files inside overwritten; `Keep both` = the whole folder lands
  as `web (2)` and everything inside is new; `Skip` = the whole folder skipped.
  Files: replace overwrites, keep-both takes `keepBothName`, skip is skipped.
- **D3 limits.** 50 MiB per file (A9), 200 top-level items (A9), NEW 2000 files and
  1 GiB per drop. Over a DROP-LEVEL cap (files, bytes, top-level items) = the drop
  is refused up front with one sentence, nothing partial. Orchestrator refinement
  2026-09-20 (keeps A9's measured behaviour, matches Explorer): ONE file over the
  per-file cap does NOT refuse the drop — that row is planned `Failed` with
  `larger than the copy limit` and everything else copies, exactly as A9 does
  today. The client walks folders recursively BEFORE the conflict question, so
  counts and bytes are known; a `File` whose size the browser hides counts as 0 in
  the total and the server still enforces per-file bytes.
- **D4 partial failure inside a folder** (orchestrator default, recorded). The
  folder stays ONE row: `Copied`, or `Failed` with the note `3 of 12 files
  failed`. What copied stays.

Orchestrator defaults recorded 2026-09-20 (not asked; flip = one branch each):
no cancel during a copy (a half-copied tree cannot be undone honestly; Esc keeps
doing nothing); in-flight `.upload-<uuid>.part` files are NOT hidden from the
listing (§2); the clipboard path is mapped by the BACKEND (`GET /api/fs/winpath`),
not by the host from a new distro argument; `Replace` over a symlink replaces the
LINK, the file it pointed at is untouched (the only semantic `rename`/`link`
offer; release-notes line).

## Facts checked (Plan agent, 2026-09-20 — read, not assumed)

- `server/fsbrowse.ts` `resolveUnderAllowed()` is the whole boundary: `isAbsolute`
  BEFORE `resolve`, containment on the **realpath** against the anchor list (home
  + every registered project root, per request, realpath memoized 5 s), NUL
  refused, TOCTOU accepted and documented. `createEntry()` adds `isSafeSegment` +
  `MAX_NAME_BYTES` (255 BYTES, not characters) + the data-dir refusal + `'wx'`
  (`O_CREAT|O_EXCL|O_WRONLY`). All of it is reusable as-is.
- `server/api.ts`: `handle()` gates Host, then Origin, then `/api/*` token
  (timing-safe) before `handleApi()` sees anything. Bodies are read per route;
  `MAX_BODY_BYTES = 1 MiB` is a JSON cap, there is **no** streamed-body path today.
  `responseReason` is a WeakMap of CONSTANT sentences only. The access log prints
  `?…` for any query — never its values — and demotes chatty routes to `debug`.
- `server/winpath.ts` (B5) already owns the WSL→Windows mapping: `windowsPathFor()`,
  `isDistroName()`, tested in `tests/winpath.test.ts`. Its allow-list
  (`[A-Za-z0-9._-]` segments) exists because **cmd.exe parses its own command
  line** — that reason does not apply to a clipboard path.
- `launcher/host/AiSessionManagerHost.cs`: `[STAThread] Main`, args[0] = the URL,
  navigation locked to the exact launch origin, `PermissionRequested` grants
  `ClipboardRead` for our origin only, `NewWindowRequested` handled. There is **no**
  `WebMessageReceived`, no clipboard WRITE, and the host does not know the distro
  name. Built by `launcher/build-host.ps1` with the in-box Framework `csc.exe`
  (C# 5, .NET Framework 4.7.2, `/reference:` Core + WinForms + System.Windows.Forms
  + System.Drawing): **no `System.Text.Json`** is available.
- `web/src`: no `chrome.webview` use anywhere today (grepped).
- `web/src/ui/filedrop.ts` reads only top-level items (`webkitGetAsEntry`), and
  `offer()` is already async against the REAL listing (B2). `main.ts` hands the
  dialog `dest.name` only — the dialog has never seen a path, and B10 keeps it
  that way.
- `web/src/ui/drop-dialog.ts` carries the mock in three places: `STEP_MS`,
  `resolveNext()`, and `HONEST_COPYING` / `honestyLine()` behind the marker
  `// PLACEHOLDER MARKER — DELETE WITH THE MOCK (B10)`.
- The card is already bounded (`.fd-modal { max-height: min(88vh, 100%) }`,
  `.fd-list { max-height: 168px; overflow-y: auto }`), so a 200-row list changes
  no layout outside the scrim — the A9 "no resize storm" evidence still holds.
- `package.json` has exactly two runtime dependencies (`node-pty`, `ws`). Adding a
  multipart parser would be a third; it is not going to happen.
- Tests: server routes run against a REAL server child with a fixture home
  (`AI_SM_HOME_OVERRIDE`, `tests/fs-create.test.ts`), and `tests/helpers.ts`
  `rawRequest()` already sends a verbatim body with an explicit `content-length`.
  The Files panel is driven through an injected `FsGateway` (`tests/fs-fixture.ts`).
  Host-side PowerShell/C# sources are already scanned as TEXT by
  `tests/launcher-config.test.ts`, `tests/nocturne-tokens.test.ts`.

To be re-verified in the browser during Phase 2 (established, not measured here):
`FileSystemEntry` handles captured synchronously in `drop` stay usable after the
event; `readEntries()` yields at most ~100 entries per call and must be looped;
`fetch()` with a `File`/`Blob` body sets `content-length` itself and never uses
chunked encoding.

## 1. Contract (Phase 0)

### `shared/protocol.ts` (owned by the Phase 1 developer, names FIXED)

```ts
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
```

### `web/src/ui/drop-model.ts` (the A9 frozen module — additive only; Phase 0 developer)

Every A9 signature stays byte-identical, `planResults` included (its tests pin it).
`MAX_ITEM_BYTES` is re-pointed at `MAX_UPLOAD_BYTES`; the value does not change.

```ts
/** Files one drop may carry in total, folders walked (D3). */
export const MAX_DROP_FILES = 2000;
/** Bytes one drop may carry in total (D3). */
export const MAX_DROP_BYTES = 1024 * 1024 * 1024;

/** One top-level item, resolved against the destination and the answer. */
export interface PlannedItem {
  item: DropItem;
  /** It clashed with a name in the destination's listing. */
  conflict: boolean;
  /** 'upload' | 'skipped' | 'failed' — 'failed' only for a single file over
   *  MAX_ITEM_BYTES (D3 refinement: that row fails, the drop goes on). */
  plan: 'upload' | 'skipped' | 'failed';
  /** The name it lands under: its own, or the `keep both` name. */
  target: string;
  /** `saved as report (2).md`, `larger than the copy limit`, or undefined. */
  note?: string;
}

/** The ONE plan both the dialog's rows and the uploader read (D2/D4). */
export function planTargets(
  items: readonly DropItem[], listing: readonly string[], choice: Choice,
): PlannedItem[];

/** Per-file write mode (D2): a deliberate overwrite, or a name that must be free. */
export function uploadMode(choice: Choice, conflict: boolean): FsUploadMode;

/** The refusal a walk's DROP-LEVEL totals earn, or null (D3). One sentence, no
 *  numbers the user did not cause. A single oversized file is NOT a refusal. */
export function dropRefusal(files: number, bytes: number): string | null;

/** The note a failed row carries, from the STATUS the server answered. */
export function failNote(status: number): string;

/** A folder that partly failed (D4): `3 of 12 files failed`. */
export function partialNote(failed: number, total: number): string;
```

`planResults()` is re-implemented over `planTargets()` and keeps its exact output
(the A9 tests are the gate).

Byte-exact new copy:

| where | string |
|---|---|
| flash, too many files | `Too many files. Drop up to 2000 files at a time.` |
| flash, too many bytes | `Too much at once. Drop up to 1 GB at a time.` |
| flash, walk failed | `The app could not read what was dropped.` |
| note, 409 | `something with that name is already there` |
| note, 413 | `larger than the copy limit` (the A9 constant, unchanged) |
| note, 403 | `not allowed in that folder` |
| note, 404 | `that folder is no longer there` |
| note, 507 | `no room left on the disk` |
| note, 400/422 | `that name is not allowed` |
| note, anything else | `could not be copied` |
| note, partial folder | `3 of 12 files failed` |
| flash, clipboard ok | `Copied README.md to the clipboard.` |
| flash, clipboard failed | `The app could not copy that to the clipboard.` |
| `COPY_NOTE` (rewritten) | `This window cannot put files on the clipboard.` |
| `PASTE_NOTE` | unchanged |

No flag, no path, no command, no key name in any of them; the destination is still
always a NAME.

## 2. Backend (Phase 1 — `backend-pty`, `security-auditor` mandatory)

### Transport: ONE raw-body `PUT` per file. Not multipart.

A multipart parser is a new security-relevant parser in a repo with two runtime
dependencies and no parser to reuse; a raw body lets the server refuse on
`content-length` **before reading a byte**; the browser sets `content-length`
itself for a `Blob` body, so "no chunked" is free; and `File` bodies stream from
disk, so a 50 MiB file never sits in either process's heap. The cost — one request
per file — is one keep-alive round trip on loopback.

### `server/fsupload.ts` (new)

```
PUT /api/fs/upload?dir=<abs dest>&rel=<relative path>&mode=replace|new
  content-type: application/octet-stream     (415 otherwise)
  content-length: <n>                        (411 when absent or chunked)
  body: the file's bytes, verbatim
  201 { bytes }
```

Why the QUERY and not headers: `url.searchParams.get()` decodes UTF-8
percent-encoding correctly (a header value cannot carry a non-Latin-1 name without
hand-rolled encoding), the access log already reduces every query to `?…` on both
sides, and `?path=` is what `/api/fs/entries` and `/api/git/changes` already use.
Duplicate parameters resolve to the FIRST value via `.get()`.

Order of operations, every one load-bearing:

1. `method !== 'PUT'` → 405. `dir`/`rel`/`mode` missing or not strings → 400
   `FS_PATH_BAD` / `FS_NAME_NOT_ALLOWED`.
2. `transfer-encoding` present → 411; `content-length` absent or not a
   non-negative integer → 411; `> MAX_UPLOAD_BYTES` → **413 before the body is
   touched**; `content-type` not `application/octet-stream` → 415. EVERY refusal
   of this route (amended 2026-09-20: not only these four — the 403/404/409
   destination refusals are decided before the body is read too) answers
   through `sendErrorAndClose()` (new in `api.ts`): explicit `content-length` +
   `connection: close`, nothing more. Measured (mutation gate 2026-09-20):
   without the explicit length Node frames the JSON chunked; without `close`
   the socket lingers and drains the refused body; WITH `close` Node's own
   `destroySoon()` at response finish RSTs the unread body within 1–4 ms, and
   the response still reaches every client that keeps reading (the drop
   client, `fetch`, does) — a client that only writes sees EPIPE whatever
   timer sits behind it, so the 250 ms linger the developer first added was
   dead weight and is gone. The gate's own 401/403 answer the same way when a
   request declares a body.
3. `parent = resolveUnderAllowed(dir, { projects: projectAnchors(), gone:
   FS_CREATE_PARENT_GONE, denied: FS_NO_CREATE_PERMISSION })` — the SAME call
   `createEntry` makes. Then `isExistingDirectory(parent)` → 404.
4. `rel` split on `/`: at least one segment, every segment through
   `isSafeSegment()` (no `/`, no `\`, no control char, no all-dots name, 1..255
   chars) **and** `Buffer.byteLength(seg,'utf8') <= MAX_NAME_BYTES`. Anything else
   → 400 `FS_NAME_NOT_ALLOWED`. `..`, `.`, `` and an absolute `rel` all die here.
   Depth cap 64.
5. Every segment but the last is created with `mkdirSync(join(...))`, EEXIST
   tolerated. A FILE standing where a folder must go (D2's merge meeting a
   file) is answered 409 `FS_ALREADY_EXISTS` by step 6's per-level check
   (the mkdir's own ENOTDIR arm is defensive and unreachable, gate 2026-09-20).
6. **Every folder this route BUILDS is realpathed and re-checked against the
   anchors AND the data-dir refusal immediately after its `mkdir`, per level —
   not once at the end** (amended 2026-09-20 after the developer measured it:
   `mkdir` on an existing symlink answers EEXIST, so an end-only check let
   `rel=escape/deeper/x` create `<outside>/deeper` before the 403; the
   security-auditor then found the same for the data dir — `dir=<dataDir>` or
   a symlink into it created empty folders there before the 403). The data-dir
   check runs on the anchored destination BEFORE the loop and on every built
   level; nothing is ever created outside the boundary or inside the data dir.
7. Temp file: `join(parentReal, '.upload-' + randomUUID().replace(/-/g,'') +
   '.part')`, opened with `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`, mode `0o666` (the
   umask makes it the user's normal 0644 — ordinary user files, not secrets). A
   fixed-length temp name, never `.<original name>.…`: a 255-byte name plus a
   prefix is ENAMETOOLONG.
8. The request stream is piped in, counting bytes. `> content-length` or
   `> MAX_UPLOAD_BYTES` → destroy, unlink the part, 413. Stream error / client
   abort / `written !== declared` → unlink the part, 400 `FS_UPLOAD_INCOMPLETE`
   (usually into a socket nobody is listening to — the unlink is the point).
   `ENOSPC` anywhere → unlink, 507 `FS_DISK_FULL`.
9. Publish, and this is where the mode lives:
   - `replace` → `renameSync(part, target)`. `rename(2)` never follows the final
     component of the new path: a pre-planted `notes.txt -> /etc/passwd` is
     REPLACED, never written through, and the swap is atomic.
   - `new` → `linkSync(part, target)` then `unlinkSync(part)`. `link(2)` fails
     EEXIST if the name is taken **at all**, dangling symlink included → 409.
     That is the atomic "create only if absent". FALLBACK, because hard links are
     not guaranteed on drvfs (a project registered under `/mnt/c`): on `EPERM` /
     `EXDEV` / `ENOSYS`, fall back to `existsSync(target)` → 409, else `rename`.
     The fallback is commented as the non-atomic path it is.
   On any failure the part file is unlinked in a `finally`.
10. `201 { bytes }`.

Status table: 400 bad path / bad name / incomplete · 403 outside the boundary, no
permission, the app's own folder · 404 destination gone · 405 · 409 exists or a
file stands where a folder must go · 411 no length / chunked · 413 over the cap ·
415 wrong type · 500 anything else · 507 disk full.

New sentence constants (constants, like every other refusal, because they land in
`responseReason`): `FS_UPLOAD_TOO_BIG = 'That file is larger than the copy limit.'`,
`FS_UPLOAD_FAILED = 'The app could not copy that file.'`,
`FS_UPLOAD_INCOMPLETE = 'That file did not arrive completely.'`,
`FS_DISK_FULL = 'There is no room left on the disk.'`. Everything else is reused
verbatim from `fsbrowse.ts`.

### Empty folders reuse `POST /api/fs/create`

A folder with no files in it produces no upload, so the client creates it segment by
segment through the A9c route, treating 409 as success. Zero new backend surface
for the folder case; `/api/fs/create` already carries the identical boundary, name
and data-dir rules.

### `GET /api/fs/winpath?path=<abs>` → `FsWinPathResponse`

For the clipboard (phase 3). `resolveUnderAllowed()` on the path (so only something
inside the boundary can ever reach the Windows clipboard), then a NEW pure function
in `server/winpath.ts`:

```ts
/** Segments a Windows path may carry: no control chars, no `\ / : * ? " < > |`,
 *  no `.`/`..` segment, no trailing dot or space (Windows trims them). WIDER than
 *  WSL_PATH_SHAPE on purpose: that one exists because cmd.exe parses its own
 *  command line, and nothing parses a clipboard path. */
export function windowsPathForClipboard(path: string, distro: string | undefined): string | undefined;
```

Same `/mnt/<d>/…` → `D:\…` rule as `windowsPathFor`, same `\\wsl.localhost\<distro>\…`
otherwise, `distro` from the server's own `WSL_DISTRO_NAME`. Unmappable → 422
`FS_PATH_NOT_MAPPABLE = 'That file cannot be reached from Windows.'`

### Stateless: no drop id, no server-side per-drop counters

The 2000-file and 1 GiB caps are CLIENT-side guardrails against an accidental drag
of a whole disk; the only security-relevant cap is per request, and it is enforced
per request. A server-side per-drop ledger would need a drop identity, an expiry and
a cleanup path, and it would defend nothing: a caller holding the token can already
`POST /api/fs/create` in a loop — and can spawn a shell, which is the feature.

### Logging

Counts and statuses only, never a name, never a byte of content, never the query's
values. The `[http]` access line is the info-level record of every request
(route, status, ms, the constant `reason=` sentence); the `[fs]` channel adds
`PUT /api/fs/upload -> <status>` at `debug` for a 2xx AND a 4xx (amended
2026-09-20: a 4xx `[fs]` line at info duplicated the access line — a 2000-row
409 storm stays ~240 KiB against the 10 MiB rotation), and ONE `error` line with
`errorClass`/`errorFrames` (never `describeError` — an errno message quotes the
path) for a 5xx. `/api/fs/upload` with a 2xx joins the `quiet` list in the access
log beside `/api/client-log` and `/api/git/changes`.

### What a hostile page on localhost can do with this route

Nothing it could not already do. The gate order is Host → Origin → token, all three
before the route exists; a foreign page cannot read the token (it is injected into
our own HTML at serve time and the response is uncacheable), cannot set
`content-type: application/octet-stream` from a form, and cannot read a cross-origin
response to learn anything. A caller that DOES hold the token already owns the
machine by design (`POST /api/sessions` spawns a shell), so the boundary here is not
about privilege — it is about not adding a way to write OUTSIDE home + registered
projects, and that is what `resolveUnderAllowed` on the destination, the per-segment
`isSafeSegment` on `rel`, the post-`mkdir` realpath re-check, `O_NOFOLLOW` on the
temp file and `rename`/`link` on the final component together buy. The token itself
is readable from Windows (`wsl-0600-not-a-boundary`) — unchanged by this part.

### `.git` is NOT special-cased, and `.part` files are NOT hidden

`.git` is a real folder, `listEntries` already lists it, the user can already write
into it from any terminal this app spawns, and a blocklist is a lie with a
maintenance cost. In-flight `.upload-<uuid>.part` files are likewise left visible:
hiding a name pattern from the listing would make a crashed upload's leftover
invisible forever and would need a delete primitive to sweep it. Instead: the part
file is unlinked on every failure path the server can observe (error, abort,
over-length, publish failure), the client refreshes the panel only AFTER the whole
drop, and the only surviving orphan is a `kill -9` / power loss — visible, ordinary,
and deletable by the user. **No boot sweep. The server never scans the home.**

## 3. Frontend (Phase 2 — `terminal-ui`; `frontend-designer` applies to any new state)

### `web/src/ui/drop-walk.ts` (new, DOM-light, injectable)

```ts
export interface WalkedFile { top: number; rel: string; file: File }  // rel: '' = the top-level file itself
export interface WalkedFolder { top: number; rel: string }  // an EMPTY folder; rel '' = the top-level folder itself
export interface WalkResult {
  items: DropItem[];            // one per TOP-LEVEL thing, the A9 shape
  files: WalkedFile[];          // every file, in top-level order then tree order
  folders: WalkedFolder[];      // folders that hold no files (keyed by top: a keep-both rename applies)
  bytes: number; biggest: number; unreadable: number;
}
export function walkDrop(tops: readonly DroppedTop[]): Promise<WalkResult>;
```

`filedrop.ts` captures `webkitGetAsEntry()` / `getAsFile()` SYNCHRONOUSLY in `drop`
(as today) and hands the handles over; the recursion is a `readEntries()` loop per
directory (it returns ~100 at a time and must be called until it answers `[]`),
depth capped at 64, and it stops early the moment the file count passes
`MAX_DROP_FILES` — so a junction loop cannot spin the page. A file whose `size` the
browser hides counts as 0 in `bytes` (D3) and the server still enforces its cap. A
directory that cannot be read increments `unreadable`.

### `web/src/ui/drop-upload.ts` (new, DOM-free, gateway injected)

```ts
export interface UploadGateway {
  put(dir: string, rel: string, mode: FsUploadMode, body: Blob): Promise<void>;  // throws ApiError(status)
  folder(dir: string, name: string): Promise<void>;                              // 409 = success
}
export interface DropRun {
  plan(choice: Choice): ItemResult[];
  start(choice: Choice, on: {
    settled(index: number, result: ItemResult): void;
    progress(done: number, total: number): void;
  }): Promise<ItemResult[]>;
}
export function createDropRun(args: {
  dest: Destination; items: DropItem[]; listing: readonly string[];
  walk: WalkResult; gateway: UploadGateway;
}): DropRun;
```

- Top-level items are processed **in the dropped order**, one at a time; inside a
  folder, files go **one at a time too**. Sequential, deliberately: the rows then
  settle in the order the list draws them, `N of M` is honest, and a pool of 3
  would buy round-trip time on a loopback socket that is already keep-alive.
- Per file: `mode = uploadMode(choice, conflictOfItsTopLevelItem)` (D2), `rel` =
  `target + '/' + relInsideTheDrop` (the target is the keep-both name when there is
  one). Folders with no files are created through `gateway.folder` per missing
  segment. A top-level file planned `failed` (over the per-file cap) is never sent.
- Per top-level item the runner counts failures; the row settles as `Copied`,
  `Skipped`, or `Failed` with `partialNote(failed, total)` (D4) or `failNote(status)`
  for a single file. **What copied stays** — nothing is rolled back, ever.
- No cancel. **Hide (user, 2026-09-20, the scope review's finding):** `Esc`,
  `×` and the backdrop HIDE the card while the copy runs on untouched — the
  restart dialog's `Hide` idiom; when the run ends with the card hidden the
  result arrives as ONE statusline flash = `resultText(rows, dest)`; with the
  card up, the result phase paints as before. No reopen. While a run is in
  flight a new drop / paste / picker is refused with `A copy is still
  running.` before any walk (two runs would race the panel refresh).
- Progress counts WRITE UNITS (files + empty folders), not rows: one dragged
  folder of 2000 files reads `137 of 2000`, never `0 of 1` (orchestrator,
  2026-09-20). A row still settles as one row. `logDrop`'s `failed` counts
  failed FILES, one unit throughout.
- A rejection anywhere (`settled` hook, `logDrop`, `refreshAfterDrop`) never
  wedges the card: hooks run inside a try in the runner, the dialog's `.catch`
  paints the result phase from the rows it has.

### `web/src/ui/drop-dialog.ts` — the mock dies

Delete `STEP_MS`, `resolveNext()`, `HONEST_COPYING`, `honestyLine()`, the
`PLACEHOLDER MARKER` line and the `.fd-honest` paragraph (plus its CSS block —
janitor item). `DropRequest` gains `run: DropRun`; `choose(choice)` becomes
`rows = run.plan(choice)` → draw them pending → `run.start(choice, hooks)` → each
`settled` paints its row and scrolls it into view inside `.fd-list`
(`scrollIntoView({ block: 'nearest' })`, a scroll inside a bounded box — no layout
outside the scrim) → `resultText(finalRows, dest)` and the `result` phase. The
dialog still receives `dest` as a NAME only: `main.ts` closes the runner over the
`Destination`, so no path ever reaches this module.

### `web/src/ui/filedrop.ts`

`offer()` becomes: top-level count (`tooMany`, unchanged, before any walk) → `await
walkDrop(...)` → `dropRefusal(files, bytes)` → flash and stop if it answers (D3) →
`await listingFor(dest)` → `openDialog({ dest, items, listing, walk, returnFocus })`.
Paste and the `Copy files here…` picker enter the same `offer()` they enter today,
with `walkDrop` over plain files (a `<input type=file multiple>` **cannot** select a
folder — a browser fact, not a choice; `webkitdirectory` would be a second button
nobody asked for).

### After the copy

`web/src/ui/files.ts` gains `refreshAfterDrop(dest: Destination): void` — it
re-reads that folder **only when the panel already has a listing for it** (it is the
root, or an open folder), so a drop into a folder nobody expanded costs no request.
Called once, when the whole drop is over, which is also what keeps in-flight `.part`
files off the screen. The `Changes` tab's own 5 s poll picks the new files up by
itself.

### `web/src/api.ts`

`fsUpload(dir, rel, mode, body)` and `fsWinPath(path)`, both through the one place
that builds headers and logs (`request()` gains a raw-body branch that does not
force `content-type: application/json`). **User 2026-09-20 (scope review):** a
2xx on `PUT /api/fs/upload` is NOT logged per call — the client buffer holds
200 lines and the server takes 200/min, so a 500-file drop would blind the
browser log for a minute; refusals keep their warn line (`PUT /api/fs/upload ?…
-> 409`, no name, no query values), and the ONE summary line per drop at info,
`drop: 37 files, 12.4 MB, 0 failed` (counts only, `failed` = files), is the
record. Mirrors the server's quiet list for the same route.

### `web/src/ui/host-bridge.ts` (new) + the row menu's `Copy`

```ts
export function hasHostBridge(w?: WindowLike): boolean;                    // window.chrome?.webview != null
export function copyPathsToClipboard(paths: readonly string[], w?: WindowLike): Promise<boolean>;
```

The optional window-like argument is the test seam (default the real
`window`). `copyPathsToClipboard` resolves `false` after `REPLY_TIMEOUT_MS =
3000` with no reply (a clipboard held by another program; Phase 3's host
replies on both outcomes, the timeout is the belt) — the failure flash covers it.

`files.ts` `runMenuAction('copy', path, name)`: `FsGateway.winPath(path)` (injected
from `main.ts` as `api.fsWinPath` — `ui/files.ts` never imports `../api.ts`, B2 §9) →
`copyPathsToClipboard([windowsPath])` → flash `Copied ${name} to the clipboard.` or
`The app could not copy that to the clipboard.` `itemsFor()` takes the row subject
with `canCopy: hasHostBridge()`; false keeps the entry visibly disabled with the
rewritten `COPY_NOTE`. Folder rows and file rows use the identical path —
`SetFileDropList` copies a folder tree the way Explorer does. The bridge and the
`Copy` entry are built in Phase 2 but only become observable with Phase 3's host.

## 4. Host (Phase 3 — `wsl-launcher`, `security-auditor` mandatory, LAST)

`launcher/host/AiSessionManagerHost.cs`, beside the existing `Settings` lines in
`WebView_InitCompleted`:

```csharp
wv.CoreWebView2.Settings.IsWebMessageEnabled = true;   // default true; set where it is read
wv.CoreWebView2.WebMessageReceived += WebView_WebMessageReceived;
```

The handler, in order:

1. `IsLaunchOrigin(new Uri(e.Source))` — the exact scheme+host+port, the same test
   the permission and navigation handlers use. Anything else: ignore, one log line.
2. `e.TryGetWebMessageAsString(...)`, length ≤ 64 KiB. Split on `'\n'`. First line
   must be `copy-files`; the rest are paths, at most 100.
3. **The paths are already Windows paths** — `GET /api/fs/winpath` mapped them on
   the backend, behind `resolveUnderAllowed`. The host therefore needs no distro
   argument, `launch.ps1` needs no change, and the boundary lives where the boundary
   already lives. The host re-checks SHAPE only, and refuses the whole message on
   the first failure: each path is `\\wsl.localhost\<[A-Za-z0-9._-]+>\…` or
   `<Letter>:\…`; length ≤ 4096; no char < 0x20 or 0x7F; no `/`; no `..` segment;
   none of `* ? " < > | :` (the colon too — an NTFS alternate data stream
   suffix; the backend refuses it in a segment as well); no trailing dot or
   space; the distro slot is never `.` or `..` (review 2026-09-20). The
   message cap counts UTF-16 chars (65536), a protocol sanity cap, not a
   memory bound. The `.cs` carries `[assembly: TargetFramework(".NETFramework,
   Version=v4.7.2")]` so the CLR's 4.6.2+ path handling applies — without it
   every path of 260+ chars made `SetFileDropList` throw (review 2026-09-20);
   `AreHostObjectsAllowed = false` sits beside `IsWebMessageEnabled = true`.
4. `Clipboard.SetFileDropList(collection)` — `WebMessageReceived` fires on the UI
   thread of an `[STAThread]` process, so this is already the STA thread. Wrapped in
   try/catch with ONE retry after 100 ms (clipboard contention is the classic
   failure).
5. Reply `wv.CoreWebView2.PostWebMessageAsString("copy-files ok 3")` or
   `"copy-files failed"`. The page listens through
   `chrome.webview.addEventListener('message', …)` and flashes accordingly.

Strings, not JSON, in both directions: the Framework `csc.exe` this host is built
with has no `System.Text.Json`, and a newline-separated message with one kind and a
list of strings needs no parser at all. `build-host.ps1` needs no new `/reference:`
(`StringCollection` lives in `System.dll`, which the in-box `csc.rsp` adds) — a
one-line check on the first build. The host log records a COUNT, never a path —
and never an exception MESSAGE either: `SetFileDropList`'s `ArgumentException`
interpolates the offending path, so a catch logs `ex.GetType().Name` only (the
backend's errorClass rule; found by both reviewers 2026-09-20).

**Edge `--app` fallback:** `window.chrome.webview` is undefined there, so the row
menu's `Copy` stays visibly disabled with `This window cannot put files on the
clipboard.` Writing the UNC path as TEXT was rejected: pasting text into Explorer's
file list does nothing, and "Copy" that produces a string instead of a file is a
promise the entry did not make. (The flip, if the user wants it, is one
`navigator.clipboard.writeText` call in `host-bridge.ts`.)

**Drag OUT of the app — checked, still no.** WinForms `DoDragDrop` must be started
on the UI thread from inside a real mouse-down on a control the host owns, and it
blocks in its own modal loop until the drop. The WebView2 control hosts its own
child HWND and consumes the mouse itself, so there is no mouse-down for the host to
attach to; starting a drag from an asynchronous `WebMessageReceived` with no
captured pointer is not a shape the OS drag loop supports. Decision 3 of A9 stands.

## 5. Tests

**Phase 1 — `tests/fs-upload.test.ts`** (a real server child on a fixture home via
`AI_SM_HOME_OVERRIDE`, `rawRequest()` for verbatim bodies): a file lands with
byte-identical content (hash compare) and 201 `{ bytes }`; `rel` with subfolders
creates them; `replace` overwrites and `new` answers 409; a symlinked target is
REPLACED, not written through (write a victim file, plant a link, upload, assert
the victim is untouched and the link is gone); a symlinked INTERMEDIATE directory
pointing outside is refused by the post-mkdir realpath re-check; `..`, `/abs`, an
empty segment, a 300-byte name, a 256-character name, a NUL → 400; a path outside
home and outside every registered project → 403; the data dir → 403; a registered
project outside home → 201 (the anchor list); no `content-length` → 411; chunked →
411; `content-length` over the cap → 413 **and the socket closes without the body
being read**; a body shorter than `content-length` (client abort) → no `.part`
survives; wrong content-type → 415; GET/POST → 405; `server.log` never contains a
canary FILE NAME or a canary BYTE SEQUENCE (the `fs-create` canary idiom); 0-byte
file → 201. Plus `tests/winpath.test.ts`: the `windowsPathForClipboard` table
(spaces, Unicode, parentheses, `&`, refusals for control chars, `..`, `*`, trailing
dot/space) and `GET /api/fs/winpath` boundary/422 cases.
**Mutation gate: FULL** (path boundary + a new write primitive = hard constraint).

**Phase 2** — `tests/ui-drop-walk.test.ts` (a fake entry tree: nesting, the
`readEntries` 100-at-a-time loop, an empty folder, an unreadable folder, the
early stop at 2001 files, a size-less file counting 0), `tests/ui-drop-upload.test.ts`
(a fake `UploadGateway`: order, modes per D2, keep-both names inside a folder, D4's
partial note, `failNote` per status, a network throw, nothing rolled back, an
oversized top-level file never sent), `tests/ui-a9-drop.test.ts` extended (the
honesty line and its marker are GONE — asserted by absence so the mock cannot come
back; rows settle from the runner, not a timer; Esc during copying still does
nothing), and `tests/ui-filedrop.test.ts` extended (the D3 refusals flash before any
listing request; the picker path and the paste path reach the same `offer`).
`tests/ui-context-menu-model.test.ts` for `canCopy`. Fake DOM + `makeDataTransfer`
+ a fake `fetch`; **mutation cap ~10** (UI surface), full on `drop-upload.ts`'s
mode selection (it decides overwrites).

**Phase 3** — nothing runnable here: no Windows, no `csc.exe`, no clipboard. What
IS runnable is a source-shape test (`tests/host-webmessage.test.ts`, the idiom
`tests/launcher-config.test.ts` already uses on `.ps1`/`.cs` text): the origin check
is present in the handler, `IsWebMessageEnabled` is set where it is read, the
allow-list refuses `..` and control characters, no path is logged, and the reply is
sent on both outcomes. The behaviour itself is the user's Windows check.

## 6. Phases and agents

- **Phase 0 — `generalist-dev`**, in parallel with Phase 1 (no file overlap): the
  additive `drop-model.ts` (`planTargets`, `uploadMode`, `dropRefusal`, `failNote`,
  `partialNote`, the two new limits, `MAX_ITEM_BYTES` re-pointed), and
  `tests/ui-drop-model.test.ts` extended. `planResults`'s output must not move a
  byte. Imports `MAX_UPLOAD_BYTES` / `FsUploadMode` from `shared/protocol.ts`,
  which Phase 1 adds (names fixed above).
- **Phase 1 — backend** (`backend-pty` → `scope-reviewer` + `security-auditor` +
  `test-engineer`, ONE fix round, then the FULL mutation gate).
- **Phase 2 — frontend** (`terminal-ui`; `frontend-designer` applies to the copying
  state's row updates and the scroll-into-view; `scope-reviewer` + `test-engineer`,
  one fix round, ~10 mutants). Browser evidence under rule 8: a real drop of a real
  folder through headless CDP, and `0 resize` lines in `server.log` for the whole
  upload.
- **Phase 3 — host** (`wsl-launcher` → `scope-reviewer` + `security-auditor`).
  Gate: the user runs `launcher/build-host.ps1` and checks on Windows. Nothing here
  lands as "done" before that.

## 7. Final gate

`/verify-terminal` once, only the checks these seams touch: standard 1 (echo &
colours), 2 (raw keys), 4 (resize propagation) — plus B10's own, all feasible
headlessly (`Input.dispatchDragEvent` with real `files` worked in A9's gate;
`DOM.setFileInputFiles` drives the picker twin):

1. Drag a real folder from a file tree onto a Files row → the tree lands, every
   file byte-identical (`sha256sum -c`), the panel shows it after the dialog closes.
2. The same drop with a terminal running `cat -v` in the pane underneath → **zero**
   bytes reach the PTY and **zero** `resize` lines in `server.log` for the whole
   upload (nothing in this part changes layout).
3. A 2000-file drop: refused at 2001 with one sentence, accepted at 2000.
4. A conflict of each kind: Replace merges, Keep both lands `web (2)`, Skip leaves
   the original untouched (compare hashes before/after).
5. Paste with files on the clipboard while a terminal is focused → the dialog, a
   real copy, and the keyboard back in the terminal afterwards.
6. Windows check owed to the user: a real Explorer drag into the WebView2 host, and
   (phase 3) `Copy` on a row → paste in Explorer.

## 8. Out of scope (recorded)

Dragging OUT of the app. The row menu's `Paste`. Cancelling a copy in flight.
Per-byte progress for one large file (`fetch` has no upload-progress event; XHR
would be the flip). Resuming an interrupted drop. Preserving timestamps or
permissions from Windows. A folder PICKER (`webkitdirectory`). Any server-side copy
from a path outside the boundary (`/mnt/c/...` included). A9's `This session has no
project folder yet.` still cannot be filled in with a name — the backend has none to
give for a session without a project.
