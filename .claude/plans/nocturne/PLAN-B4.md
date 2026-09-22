# Plan B4 — Editor live: read a file, edit it, save it to disk (Nocturne Track B)

Status: LANDED 2026-09-22 (log `memory/log/2026-09/nocturne/2026-09-22-nocturne-b4.md`; suite 3033 → 3103; verify-terminal B4-1…6 + sanity 1–4 PASS; awaiting the user's Windows check); earlier: STARTED 2026-09-22 (user: "continue werken aan de app"; next row in the status table; decisions D1–D4 asked the same day, before the developer started).
Parent: `.claude/plans/PLAN-NOCTURNE.md` part B4. A6 (2026-09-13) drew the
editor on `MOCK_FILE_CONTENTS`; A10 / A10b (2026-09-15) made it a pane with
file tabs; B2 (2026-09-16) made every path real, so every file opened from the
Files panel or a commit view has said `The app cannot read this file yet.`
since. B4 makes the editor read the file, write it back, follow it on disk,
survive a reload and refuse to lose unsaved text silently — and deletes the
last of `web/src/ui/files-mock.ts`. Runs through `/dev-flow` (lean rules
1–11); `security-auditor` mandatory on phase 1 (a new READ and the app's
second WRITE primitive, both on a client path); `/verify-terminal` once at the
end, scoped (typing and saving beside two live panes must never resize or
re-attach them). Line numbers drift — verify by reading.

## User decisions (2026-09-22)

- **D1 unsaved text is never dropped without a question.** Closing a file tab,
  an editor pane or a whole tab that would orphan unsaved text asks `Discard
  unsaved changes to <name>?` (one file) / `Discard unsaved changes to N
  files?` (several), buttons `Discard` (danger) and `Keep editing` (default,
  Esc). Reload and window close go through the browser's own `beforeunload`
  question while any file is unsaved. The backend's grace timer (the last
  window closed, nothing left to ask) is the one door with no question —
  known limit, recorded in the scope doc. Rejected: no confirmation (the dot
  alone); auto-save.
- **D2 open editor tabs survive a reload.** File and diff tabs join the
  localStorage v2 bag beside the session slots (user decision 10 of A10b,
  2026-09-15, ran "until B4"). Unsaved text does not survive — D1's
  `beforeunload` question is what stands between the user and that loss.
- **D3 a clean tab follows its file on disk.** The ACTIVE tab of every editor
  pane on screen re-reads its file when the bytes on disk change (the 5 s
  rhythm of the Files panel's Changes poll). A tab with unsaved text is never
  overwritten from disk. Rejected: read once, a Reload button.
- **D4 a save onto a file that changed on disk is refused, then the user
  chooses.** Save sends the version it read; a mismatch answers 409 `This file
  changed on disk since you opened it.` and the pane offers `Overwrite` (my
  text wins) and `Load from disk` (my changes go). Rejected: always overwrite.

## Orchestrator defaults (recorded 2026-09-22, not asked; each a cheap flip ⟲)

- ⟲ Ctrl+S saves the ACTIVE file while the keyboard is in its text; anywhere
  else the chord is untouched (a terminal keeps its XOFF). Listed in the
  shortcuts overlay under the editor's chords.
- ⟲ Text only, 1 MiB at most (`FS_TEXT_MAX_BYTES`). Larger: 413 `This file is
  too large to open here.` A NUL byte or invalid UTF-8: 415 `This file is not
  text, so the editor cannot show it.` Both are drawn as the pane's one
  sentence, no field, no Save (the B2 branch, with a real reason).
- ⟲ Line endings and a BOM are preserved: the server sends LF text plus
  `eol` (`lf` / `crlf`, the kind of the FIRST line break; an empty or one-line
  file is `lf`) and `bom`; the client hands both back on save and the server
  restores them. A file with mixed endings comes back uniform.
- ⟲ The version stamp is the SHA-256 of the bytes on disk, opaque to the
  client (never mtime: a 9p mount and a clock step both lie about time).
- ⟲ A save writes IN PLACE (open, compare, truncate, write, fsync), never
  through a temp file: the inode, its mode, its hard links and its owner stay
  what they were, and a file the user cannot write answers 403 instead of
  being replaced through a writable folder. The stamp is compared on the SAME
  file descriptor that is then written, so nothing can slip between the check
  and the write.
- ⟲ A file that vanished between open and Save: with `expect` set, 404 `This
  file is no longer there.` and the same two buttons — `Overwrite` recreates
  it, `Load from disk` shows the read error.
- ⟲ Disk follow ticks only while the document is visible, skips a tab whose
  request is still out, and never touches the caret when nothing changed. When
  the text changed, the caret goes to `min(old caret, new length)` and the
  scroll offset is kept; a file that became unreadable shows the sentence.
- ⟲ Disk follow uses the read route with `if=<stamp>`; a match costs one
  small JSON answer and no body. No new poll interval: `ui/editor-store.ts`
  owns the one timer for every registered body.
- ⟲ A persisted diff tab is re-fetched on load like any other; a persisted
  file tab whose file is gone shows the read error, the tab stays (the user
  closes it). A file open in two panes is still ONE text (`state.edits`).
- ⟲ The A10 rule stands: the editor pane's header, chips and `×` are
  unchanged; what B4 adds to the pane is the bottom bar's contents (Save,
  the conflict bar) and a sentence branch.
- ⟲ No autosave, no undo history beyond the textarea's own, no syntax
  colouring, no file watcher (inotify) — polling, as the panel.

## Frozen protocol (`shared/protocol.ts`, written by the orchestrator in phase 0)

```ts
// --- Editor (Nocturne B4) — GET /api/fs/read, PUT /api/fs/write --------------
/** The most bytes the editor reads or writes; larger answers 413. */
export const FS_TEXT_MAX_BYTES = 1024 * 1024;
export type FsEol = 'lf' | 'crlf';
/**
 * GET /api/fs/read?path=<abs>&if=<stamp, optional>
 * `text` is LF-normalised; `eol` and `bom` say what the file used so a write can
 * restore them. `stamp` is opaque (the server's hash of the bytes on disk).
 * With `if` equal to the current stamp the answer is `{ changed: false, stamp }`.
 */
export type FsReadResponse =
  | { changed: false; stamp: string }
  | { changed: true; stamp: string; text: string; eol: FsEol; bom: boolean };
/**
 * PUT /api/fs/write — body FsWriteRequest (JSON), `text` LF-normalised.
 * `expect` = the stamp the text was edited from; a mismatch answers 409, a file
 * that is gone 404; absent = write regardless (the Overwrite button).
 */
export interface FsWriteRequest { path: string; text: string; eol: FsEol; bom: boolean; expect?: string }
export interface FsWriteResponse { stamp: string; bytes: number }
```

Client (`web/src/api.ts`, phase 0): `fsRead(path, ifStamp?)`, `fsWrite(body)`
— the same `request<T>` shape as `fsCreate`. The JSON body of a write is under
the existing `MAX_BODY_BYTES` (1 MiB) only when the text is; the route raises
its own body cap to `FS_TEXT_MAX_BYTES * 6 + 4096` (JSON escaping of a C0
control byte is six bytes, `\u001b`; 4× was the spec's first number and the
scope review measured a 1 MiB ANSI log that read 200 and saved 413) and
refuses the TEXT above `FS_TEXT_MAX_BYTES` with 413.

## Phase 1 — backend (`backend-pty`)

Files: `server/fstext.ts` (NEW: both routes' logic, pure helpers exported),
`server/api.ts` (two routes beside `/api/fs/create`, access-log demotion of a
200 read/write like `/api/fs/upload`), `tests/fs-text.test.ts` (NEW; real
temp folders through `tests/fs-fixture.ts` as `fs-create.test.ts` does).

1. **Boundary, identical to `createEntry` / upload:** `path` through
   `resolveUnderAllowed(path, { projects, gone: <the 404 sentence>, denied:
   <the 403 sentence> })` — absolute, realpathed, contained in home or a
   registered project root; `isUnderDataDir(real)` → 403
   `FS_DATA_DIR_REFUSED`-style sentence (`The app's own folder is not a place
   to edit files.`). A NUL, a relative path, an empty path: 400
   `FS_PATH_BAD`. 405 for any other method. The realpath of a symlink INSIDE
   the boundary is the file that is read and written (editing through a link
   edits its target); a link whose target is outside is 403 like a listing.
2. **Open, then judge the fd — never the path twice.** Read: `openSync(real,
   O_RDONLY | O_NOFOLLOW | O_NONBLOCK)` (the FIFO lesson,
   `memory/knowledge/fifo-open-blocks-main-thread.md`: a planted FIFO must
   not hang the main thread, and `O_NOFOLLOW` is not a FIFO defence);
   `fstatSync` must say a REGULAR file, else 415 (a directory: 400
   `FS_PATH_BAD`); `size > FS_TEXT_MAX_BYTES` → 413 before a byte is read;
   read exactly `size` bytes through that fd (a file growing under the read
   is cut at `size`; the stamp is of what was read). Write: `openSync(real,
   O_RDWR | O_NOFOLLOW | O_NONBLOCK)` (no `O_CREAT`), same fstat rule, read
   the current bytes, hash, compare with `expect` (409 on mismatch), then
   `ftruncateSync(fd, 0)`, `writeSync` the encoded bytes in a loop until all
   are out, `fsyncSync`, close. `expect` absent: same open, no compare;
   `ENOENT` with `expect` absent → create with `'wx'`-style
   `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` in the (already resolved) parent, so
   a link planted at the name is never followed. `EACCES`/`EPERM` → 403
   `You do not have permission to change this file.`; `ENOSPC`/`EDQUOT` →
   507 `FS_DISK_FULL` (reuse the upload's constant); `EISDIR` → 400.
3. **Text rules, pure and exported:** `decodeText(buf): { text, eol, bom } |
   null` (null = a NUL byte anywhere or `TextDecoder('utf-8', { fatal: true
   })` throws; strips a leading U+FEFF into `bom`; `eol` from the first `\r\n`
   or `\n`; returns LF text); `encodeText(text, eol, bom): Buffer` (LF →
   `\r\n` when `crlf`; a text the client sends with a stray `\r` is written
   as sent — the client never sends one, the textarea normalises);
   `stampOf(buf): string` (sha256 hex). `encodeText(decodeText(b)) === b`
   for every uniform-ending file — a property test over a few fixtures.
4. **Request gates before any syscall:** `path` a string; `if` and `expect`
   `^[0-9a-f]{64}$` when present (else 400); `text` a string, `eol` one of
   the two, `bom` boolean; the JSON body over the route's cap → 413 and the
   connection closed (`sendErrorAndClose`, the upload's rule); text over
   `FS_TEXT_MAX_BYTES` after encoding → 413 `This file is too large to open
   here.` (one 413 sentence, shared).
5. **Logging: counts only.** `GET /api/fs/read -> 200, 1284 bytes` /
   `-> 200, unchanged` / `-> 413`; `PUT /api/fs/write -> 200, 1301 bytes` /
   `-> 409`. Never a path, never a byte of text, never a stamp. 5xx = class +
   frames (`errorClass` / `errorFrames`), never `describeError`. A 200 read or
   write is demoted from the access log like `/api/fs/upload`.
6. **Sentences (constants, one each):** 400 `FS_PATH_BAD`; 403
   `You do not have permission to read this file.` / `You do not have
   permission to change this file.` / `The app's own folder is not a place to
   edit files.` / `FS_OUTSIDE_HOME`; 404 `This file is no longer there.`;
   409 `This file changed on disk since you opened it.`; 413 `This file is
   too large to open here.`; 415 `This file is not text, so the editor cannot
   show it.`; 500 `The app could not read this file.` / `The app could not
   save this file.`; 507 `FS_DISK_FULL`.
7. **Tests** (`tests/fs-text.test.ts`): round trip LF / CRLF / BOM / empty
   file / no trailing newline / mixed endings become uniform; `if` match →
   `changed:false`; size cap at exactly 1 MiB and 1 MiB + 1; NUL → 415;
   invalid UTF-8 → 415; a directory → 400; a FIFO (real `mkfifo`) → 415
   WITHOUT hanging (a timeout on the test); symlink inside → target
   written, symlink outside → 403, link planted at a missing name +
   `expect` absent → not followed; 409 on a changed file with the old stamp,
   200 with the new; 404 with `expect` on a deleted file, 200 create without;
   read-only file (`chmod 0444`, skipped as root) → 403 and the bytes
   unchanged; data dir → 403; every method other than GET/PUT → 405; token
   required; one log line per request with no path in it; the write leaves
   the inode number and mode unchanged (`statSync().ino` before and after).

### Phase 1 amendments (2026-09-22, after the scope + security review; they win over the items above)

- Body cap factor 6, not 4 (above).
- `ENXIO` (a unix socket: `open(2)` fails before there is an fd) → 415, the
  same category answer as a FIFO; a real socket in the tests, no `[error]`
  line.
- **Hard links — KNOWN LIMIT, recorded and pinned, not refused.** A hard link
  has no target for `realpath` to resolve, so a link planted inside home to a
  file outside every anchor, or to the data dir's `runtime.json`, is read and
  written THROUGH (measured: the token came back in a body; `runtime.json`
  was overwritten in place). Same posture as the symlink TOCTOU in
  `server/fsbrowse.ts`: the planter already runs as the user (Windows cannot
  make a Linux hard link through `\\wsl.localhost`, `fs.protected_hardlinks`
  limits the rest), the requester already holds the token that spawns a
  shell — zero privilege gained. An `nlink > 1` refusal was weighed and
  rejected: pnpm's `node_modules/.pnpm/**` are hard links into its store,
  and refusing to edit them (with a permission sentence) is the wrong trade.
  Written in the module header, the scope doc's known limits, and a test
  that PINS the accepted behaviour.
- A 5xx log line carries the errno CODE beside the class (`code=ENXIO`) — a
  constant identifier, never a path.
- `Overwrite` (`expect` absent) over a file the read side refused (too large,
  binary) lands: "mine wins" is what the button says; pinned by a test.
- Tests added: `textErrorFor` as a unit table (ENOSPC/EDQUOT → 507, EROFS/
  ETXTBSY → 403), the 403 read sentence, the socket, the two hard-link pins,
  the Overwrite-over-binary pin.

## Phase 2 — frontend (`terminal-ui`, `/frontend-designer` applies)

Files: `web/src/ui/file-pane.ts` (the real body), `web/src/ui/editor-store.ts`
(NEW — injected gateway, the one poll timer, registered bodies),
`web/src/ui/editor-model.ts` (pure helpers: the discard sentence, caret
clamp, conflict states), `web/src/ui/unsaved.ts` (NEW — the D1 question and
the guarded closers), `web/src/ui/editor-pane.ts` (chip `×` and pane `×` go
through the guards), `web/src/ui/tabs.ts` (a view's `×` goes through the
guard), `web/src/main.ts` (Ctrl+S, Ctrl+Alt+W through the guard,
`beforeunload`, gateway wiring), `web/src/ui/shortcuts.ts` (Ctrl+S row),
`web/src/state.ts` (persist editor slots; `dirtyLostBy`), `web/src/ui/files-mock.ts`
(DELETED with its tests' imports), `web/src/styles/app.css` (the conflict
bar), tests: `tests/ui-file-pane.test.ts`, `tests/ui-editor-model.test.ts`,
`tests/ui-state.test.ts` (persistence), a new `tests/ui-unsaved.test.ts`.

1. **Gateway, injected** like `CommitGateway`: `EditorGateway { read(path,
   ifStamp?), write(body) }` in `editor-store.ts`; `main.ts` wires
   `api.fsRead` / `api.fsWrite`. No `api.ts` import inside `file-pane.ts`.
2. **The body reads on build.** `Loading…` (quiet), then the field with the
   text, gutter and Save, or the server's sentence verbatim (danger ink only
   for a refusal, quiet ink for 404). The body remembers `stamp`, `eol`,
   `bom`. A body built for a path with unsaved text in `state.edits` (second
   pane of the same file, or a re-raised tab) still READS once — for the
   stamp — and shows the unsaved text, not the disk's. The `Example …` line,
   `CANNOT_READ`, `placeholderNote`, `mockFileContent`, `saveMockFile` and
   `files-mock.ts` are deleted; the BACKLOG's mock item is ticked in the
   landing.
3. **Save** (button, Ctrl+S in the field): `write({ path, text, eol, bom,
   expect: stamp })`; while out the button reads `Saving…` and is disabled;
   200 → `saveEdit(id)`, the new stamp, `Saved`, caret kept; 409 / 404 → the
   CONFLICT BAR replaces the bottom bar's left half: the server's sentence,
   `Overwrite` (write again with no `expect`) and `Load from disk` (read,
   replace the text, `saveEdit` drops the unsaved entry, caret clamped); any
   other error → the sentence in the bar, Save re-enabled. The text stays
   dirty until a write succeeds.
4. **Disk follow (D3):** `editor-store.ts` registers every file body; one
   `setInterval` of 5 s (`FOLLOW_MS`), ticking only while
   `document.visibilityState === 'visible'`; per body: `root.isConnected &&
   !dirty && !inFlight && stamp !== null` → `read(path, stamp)`; `changed:
   false` → nothing; `changed: true` → new text, gutter, stamp, caret
   `min(old, len)`, scroll kept; an error → the sentence branch replaces the
   field (the tab stays). A dirty body is never polled, so the user's text is
   never touched. `dispose()` of the pane unregisters its bodies.
5. **Unsaved question (D1):** `state.dirtyLostBy(viewId, slot, tab?)` (pure,
   exported, tested): the dirty file ids among the tabs the operation removes
   that no OTHER surviving tab shows. `ui/unsaved.ts`: `confirmDiscard(ids):
   Promise<boolean>` (a dialog in the delete dialog's shape — `Discard` is
   the danger button, `Keep editing` the default and Esc) and the three
   guarded closers `closeTabGuarded`, `closeSlotGuarded`, `closeViewGuarded`
   that ask only when the list is non-empty and then call the state mutator.
   Every door goes through them: the chip `×`, the pane `×`, Ctrl+Alt+W,
   the bottom-strip tab `×`, the context menu's close if any. Ending a
   SESSION never removes an editor tab (A10b) and is not a door.
   `beforeunload` in `main.ts`: `preventDefault()` + `returnValue` while
   `state.edits.size > 0`. The A6 known gap is closed: the scope doc's
   sentence about "no confirm" goes.
6. **Persistence (D2):** `persistView` writes editor slots as
   `{ kind:'editor', tabs, active }` with file tabs `{ kind:'file', path }`
   and diff tabs `{ kind:'diff', root, hash, path }`; `validateView` reads
   them back through gates (path: non-empty string, no NUL, absolute; hash
   `^[0-9a-f]{40}$`; root a string; unknown kinds dropped; at most the
   pane's tab cap; a slot with zero valid tabs dropped) and a fresh
   `newEditorSlot`. A view with only editor slots SURVIVES (the "no slots →
   drop unless Home" rule stays for zero slots). `focused` is no longer
   remapped away from editor slots. No schema bump: an older build ignores
   the editor entries (it already skips non-session slots). The `// B4:`
   comments in `state.ts` go.
7. **Chrome, `/frontend-designer`:** the conflict bar is the pane's bottom
   bar with the sentence in danger ink and two quiet buttons; `Saving…` is
   the Save button's own label; the read sentence sits where the B2 sentence
   sat. No new colours, no new tokens; `Loading…` in `--color-fg-quiet`
   (whatever the commit view's loading line uses). Copy rules: no decorative
   separators, plural forms, no code in copy.
8. **Tests:** the body reads through the gateway double (text, gutter,
   stamp); the second pane of a dirty file shows the unsaved text; Save →
   write body carries `expect`; 409 → conflict bar; `Overwrite` → no
   `expect`; `Load from disk` → the entry is dropped; the poll skips dirty
   and detached bodies and stops when hidden; a changed answer clamps the
   caret; `dirtyLostBy` on the four doors (shared file in two panes is not
   lost by closing one); the guarded closers call the mutator only after
   `true`; persistence round trip with a hostile bag (relative path, short
   hash, unknown kind, 40 tabs); `beforeunload` armed only while dirty;
   Ctrl+S in the field saves, in a terminal reaches the PTY; the shortcuts
   row; the mock-count test in `ui-a8-block-rules` (or wherever the count
   lives) now asserts ZERO.

## Amendment (2026-09-22, the user's Windows check: "ik kan oneindig veel tabs open hebben, limiteer dat met 4")

- **Four tabs per editor pane** (files and diffs together); the persistence
  cap follows (`MAX_TABS = 4`, was 16).
- **Opening a fifth evicts the tab in position 4** (the last one) and the new
  tab takes that place, active. A tab already in the strip is raised and
  evicts nothing. A new pane never evicts.
- D1 holds: an evicted tab with unsaved text no other tab shows gets the
  `Discard unsaved changes to <name>?` question first; `Keep editing`
  cancels the open (orchestrator's default, D1-consistent).
- Moving a tab into a full pane (drag onto its centre, Ctrl+Alt+M) is
  refused with `This pane already holds 4 files.` — never an eviction on a
  drag. An edge drop (new pane) is unaffected.

## Gates

- Phase 0 (orchestrator): protocol + client functions, `npm run typecheck`.
- Phases 1 and 2 run in PARALLEL (disjoint files). Per phase: readers (scope
  always; security on phase 1, and on phase 2 for the persistence reader and
  the `beforeunload` / Ctrl+S key capture only) → ONE fix round → test gate
  (phase 1 = FULL mutation probe, hard constraint: path boundary and a write
  primitive; phase 2 ≤ ~10 mutants).
- Final: full suite once by the orchestrator, `/verify-terminal` scoped to
  "type and save in a file pane beside two live panes: zero resize / attach
  lines, cols/rows unchanged; Ctrl+S with a terminal focused reaches the
  PTY; a file rewritten from the terminal (`echo >> file`) shows up in the
  clean tab within 5 s", janitor, the Windows checklist for the user (the
  `beforeunload` question from the host window on close and on reload; a
  CRLF file round trip through Notepad; a file Claude Code edits beside the
  pane; Overwrite and Load from disk).
- Landing: this Status line, the table row, the README index line, the scope
  doc's Commit-view-and-editor bullet (the "mock until B4" and "no confirm"
  sentences, the four doors, the B4 routes in the Files-panel route list),
  the BACKLOG's mock and reload items, the vault log entry + decision note,
  commit + push, CI watched to green.
