# B13 — Rename files and folders in the Files panel

Status: LANDED 2026-09-23 (one commit; the user tested it on Windows before the commit: "ik heb het al getest en hij werkt"); earlier: STARTED 2026-09-22 (decisions asked and answered the same day; the
user: "eerst hernoemen, daarna de release" — v0.4.0 waits for this part).
Part B13 of `.claude/plans/PLAN-NOCTURNE.md`. B10a gave the Files panel
multi-select and the app's first delete primitive; A9c + B2 gave the inline
name row (`New file` / `New folder`); B10 gave the link-then-fallback publish
step. B13 adds a same-folder RENAME on those three. Runs through `/dev-flow`
(lean rules 1–11); `security-auditor` mandatory on phase 1; `/verify-terminal`
once at the end, scoped. Designed by the Plan agent 2026-09-22. Line numbers
are from 2026-09-22 and drift — verify by reading.

## User decisions (2026-09-22)

- **D1 a taken name is REFUSED.** No replace question: replacing would be a
  hidden permanent delete. The sentence `Something with that name already
  exists here.` shows under the input; the typed text stays.
- **D2 the anchors are never renamable** — home, the panel root, every
  registered project root, and every folder that CONTAINS one. The menu entry
  is absent, F2 does nothing, and the server refuses too (same rule as
  B10a's D3). Renaming a project belongs on the Projects surface, later.
- **D3 open editor tabs FOLLOW the rename.** Every `file` tab at or under the
  old path points to the new path; unsaved text moves with it (B4: unsaved
  text is never dropped silently). Diff tabs are left alone. Caret and scroll
  position are lost — recorded, not fixed.
- **D4 a folder with a running session inside is renamable, with a note.**
  A second line under the name row while it is open: `A session is working
  inside this folder. It keeps running; its folder shows the old name.` The
  shell keeps the moved directory; the app's cwd label and resume history
  (keyed by cwd) go stale — accepted.

## Orchestrator defaults (2026-09-22, not asked; each a cheap flip ⟲)

- ⟲ Starts two ways: **F2** on the focused tree row, and `Rename` in the row
  menu (no pointer-only controls). Single row only — a multi-selection has no
  entry and F2 acts on the focused row alone.
- ⟲ Same folder only. Move and cut are out of scope; the request carries a
  `name`, not a destination, so a move cannot be expressed.
- ⟲ Same name as before: no request, the row closes. Case-only renames are
  supported, including on case-insensitive drvfs.
- ⟲ Same name rules as create: `nameProblem` on the client; `isSafeSegment`
  plus ≤ 255 bytes on the server. Windows-invalid characters on `/mnt/c` are
  not refused (same as create).
- ⟲ The input is pre-filled with the old name. A file: the part before the
  last dot is selected (a leading-dot name like `.env` whole); a folder: the
  whole name. Selection happens on first focus only.
- ⟲ Enter commits; Escape cancels and returns focus to the row; blur cancels
  (same as create); a menu opening, a tab switch, a root change or the panel
  hiding cancel too. One name row at a time, create or rename.
- ⟲ Success: no flash — the renamed row is the evidence; it becomes the
  selection and takes focus once its folder's listing is back. Nothing
  changes optimistically.
- ⟲ Failure: the server's sentence under the input if it passes
  `isSentence`, else `The app could not rename that.`; text and focus stay.
- ⟲ Guards: a copy in flight → `COPY_RUNNING`; a delete in flight →
  `DELETE_RUNNING`; a rename in flight makes the input read-only.
- ⟲ Menu: `Rename` directly above the separator before `Delete`, plain label.
- ⟲ Shortcuts overlay: one row `f2` "rename the focused row"; the keys
  sentence in `web/src/ui/shortcuts.ts` (~:55) gains "f2".

## Found while designing

- **The response carries no path.** The server works on the realpath'd
  parent; the tree is keyed by the path as SHOWN (which may pass through a
  symlinked folder). The client builds the new path itself:
  `dirname(old) + '/' + name`. `commitCreate` (`files.ts` ~:2050, `res.path`)
  has this latent bug for a create inside a symlinked folder — BACKLOG, not
  fixed in B13.
- **Node has no no-clobber rename** (no `renameat2`/`RENAME_NOREPLACE`;
  `fs.rename` replaces). `link(2)` fails EEXIST on any taken name (dangling
  symlinks included) and does not follow a final symlink on Linux —
  `server/fsupload.ts` ~:444-470 already uses link first, then lstat + rename
  when link is refused (EPERM/EXDEV/ENOSYS on drvfs). Folders cannot be
  hard-linked.
- **Editor tabs are keyed by path**: tab id `f:<path>`
  (`web/src/ui/editor-model.ts` ~:31), unsaved text in `state.edits` under that
  id (`web/src/state.ts` ~:2159), pane bodies cached by id
  (`web/src/ui/editor-pane.ts` ~:150-185), a file body captures its path when
  built (`web/src/ui/file-pane.ts` ~:99). Without a remap a rename turns the
  tab into a 404 and strands the unsaved text.
- `isAnchor()` on the client (`files.ts` ~:1605) covers panel root, home and
  every project root ITSELF — not a folder that CONTAINS a project (scope
  review 2026-09-22). `deletable` is therefore not enough for Rename: the menu
  row gets its own `renamable` (not an anchor AND no registered project at or
  under it), and F2 uses the same predicate.

## § 1 Server — `POST /api/fs/rename` in a new `server/fsrename.ts`

Contract (`shared/protocol.ts`, next to `FsDelete*` ~:1300):
`FsRenameRequest { path: string; name: string }` → 200 `FsRenameResponse {}`
(no path back, see above).

Request handling, wired in `handleApi` beside `/api/fs/delete`
(`server/api.ts` ~:1463), same deps shape as delete: `POST` only (405), JSON
content-type (415), body via `readJsonBodySafe(req, 16 KiB)` — too large 413
`FS_PATH_BAD`; refusals before the body is read close the connection. A
non-string `path` → 400 `FS_PATH_BAD`; a non-string `name` → 400
`FS_NAME_NOT_ALLOWED`. Anchors read once per request.

Checks, IN THIS ORDER (the order is the security property):

1. `raw` absolute, no NUL — before `resolve()`. `lex = resolve(raw)`,
   `old = basename(lex)`; `old` passes `isSafeSegment` and ≤ 255 bytes.
2. `lex` itself an anchor → 403 `FS_RENAME_ANCHOR` — lexically, before the
   parent resolve (the B10a lesson).
3. `parentReal = resolveUnderAllowed(dirname(lex), {projects, gone, denied})`
   — an intermediate symlink is judged by where it really lands.
4. `name` passes `isSafeSegment` and ≤ 255 bytes (400) — this is why
   `join(parentReal, name)` cannot leave the parent. `name === old` → 200,
   nothing done.
5. `src = join(parentReal, old)`, `dst = join(parentReal, name)`:
   - anchors: refuse if `src` is an anchor or contains one
     (`isUnderPath(anchor, src)`), or if `dst` is an anchor path;
   - data dir: refuse on `isUnderDataDir(parentReal) || isUnderDataDir(src)
     || isDataDirUnder(src) || isUnderDataDir(dst)`;
   - a symlink `src` is NOT realpath'd: the entry itself is renamed;
     `rename(2)`/`link(2)` never follow the final component.
6. `st = await lstat(src)`; ENOENT → 404.

Atomicity — `node:fs/promises` only (the one sync call stays the existing
`realpathSync` in `resolveUnderAllowed`):

- **Not a directory** (file or any symlink, a symlink to a folder included):
  `await link(src, dst)` (EEXIST on any taken name = atomic no-clobber), then
  `await unlink(src)`. If the unlink fails: `unlink(dst)` back, return the
  mapped error. Link refused with EPERM/EXDEV/ENOSYS/ENOTSUP (drvfs): lstat
  `dst` (409 if present) then `rename`, the race named in a comment as in
  `fsupload.ts`. A crash between link and unlink leaves two names —
  documented.
- **Directory:** lstat `dst` (409 if present), then `rename(src, dst)`. Named
  race: a `dst` created in that window gets ENOTEMPTY (non-empty folder) or
  ENOTDIR (file); only an EMPTY folder created in the window can be replaced
  silently — documented as accepted.
- **Case-only rename:** `lstat(dst)` has the same `dev`+`ino` as `src` and
  `name.toLowerCase() === old.toLowerCase()` → same entry on a
  case-insensitive filesystem → `rename(src, dst)` directly. Afterwards, if
  `readdir(parent)` still LISTS `old` (POSIX no-op on hard links), 409 — not
  `lstat(src)`, which still finds the entry after a good rename on
  case-insensitive drvfs (scope review 2026-09-22).

Errors (`renameErrorFor(code)`, exported, pure):

| errno | status | sentence |
|---|---|---|
| ENOENT, ENOTDIR | 404 | `FS_RENAME_GONE` |
| EACCES, EPERM, EROFS | 403 | `FS_NO_RENAME_PERMISSION` |
| EEXIST, ENOTEMPTY, EISDIR | 409 | `FS_ALREADY_EXISTS` (reused) |
| EBUSY, ETXTBSY | 409 | `FS_RENAME_BUSY` |
| ENAMETOOLONG | 400 | `FS_NAME_NOT_ALLOWED` |
| anything else | 500 | `FS_RENAME_FAILED` |

Sentences: `FS_RENAME_GONE` `That item is no longer there.` ·
`FS_NO_RENAME_PERMISSION` `You do not have permission to rename this.` ·
`FS_RENAME_ANCHOR` `The app cannot rename your home folder or a project
folder.` · `FS_RENAME_DATA_DIR` `The app's own folder cannot be renamed.` ·
`FS_RENAME_BUSY` `That item is in use right now.` · `FS_RENAME_FAILED` `The
app could not rename that.` (`FS_ALREADY_EXISTS` must read `Something with
that name already exists here.` — check the existing constant; if it reads
otherwise, the client shows D1's sentence for a 409.)

Logging: `POST /api/fs/rename -> <status>` at info; a 5xx logs only
`errorClass` + `errorFrames` — never a name, a path or `err.message`.

Header comment, security posture: no new privilege (a token holder already
has a shell); the only new thing is a same-folder rename inside the
boundary, never of an anchor or the data dir, never replacing an existing
entry; the TOCTOU window is the one `fsbrowse.ts` already accepts.

## § 2 Client

Protocol and plumbing: `web/src/api.ts` `fsRename(path, name)` beside
`fsDelete` (~:594); `FsGateway` (`files.ts` ~:242) gains `rename(path, name)`,
wired in `main.ts` where `delete` is.

`web/src/ui/rename-model.ts` (new, no DOM, full mutation gate):
`stemRange(name, isDir)`, `renamedPath(old, name)`,
`remapPath(p, from, to)` (exact or under `from + '/'`, else unchanged),
`remapKeys(sel, from, to)` (rewrites `fdir:`/`ffile:` keys and the anchor),
`canRename({ isAnchor, count })`, the sentence constants and D4's note.

Menu (`web/src/ui/context-menu-model.ts`): `MenuAction` (~:40) gains
`'rename'`; `itemsFor` (~:154) adds `Rename` above the separator when
`row.renamable && row.count === 1` (D2, see "Found while designing"); the
header copy list (~:15) gains `Rename`; `runMenuAction` (`files.ts` ~:1456):
`rename` → `startRename(key)`.

Keyboard (`onSelectionKey`, `files.ts` ~:1191): `F2`, no modifiers, no modal
open, a tree row focused → `startRename(activeTreeKey())`, `preventDefault` +
`stopPropagation`; an anchor row does nothing. Nothing else in `web/src`
binds F2; F2 with a TERMINAL focused still goes to the PTY.

Name row reuse (`files.ts` ~:1844-2220): lift the input-building code of
`insertNameRow` (~:2156-2218) into `nameRowEl({depth, kind, label, value,
busy, error, note, onEnter, onEscape, onBlur})`; create keeps its behaviour
(`tests/ui/ui-files-create.test.ts` stays green UNCHANGED — the regression gate).
Sibling state `renaming: { path, dir, error } | null` with its own text, busy
flag, token and return key and the same cancel set; `dropCreate` becomes
`dropNaming`. In `fileRows` (~:2880) the row whose key equals the renaming
key is swapped for the name row: same depth, same `--files-row-h`, no width
change; accessible label `new name for <kind>`. Row gone after a re-listing
→ the rename is dropped (mirrors `createRowIndex === -1`). `paint()`
(~:2726) keeps the input's text and focus across rebuilds, like `creating`.
D4's note shows when any live session's cwd is at or under the folder.

Commit (`commitRename`): `nameProblem`, then the unchanged-name no-op, then
`fs.rename`, token- and generation-guarded like `commitCreate`
(~:2032-2080). Success, with `to = renamedPath(path, name)`: `openFolders`
and `listings` keys through `remapPath` (loop shape of `finishDelete`
~:1703); `selected = remapKeys(...)`, the renamed row the selection;
`st.retargetFiles(path, to)`; `fetchFolder(dirname)`; a focus promise like
`focusCreated` (~:1907) aimed at the new key. Failure: sentence under the
input, text kept, input focused.

Editor tabs (`web/src/state.ts`, new `retargetFiles(from, to)` near
`saveEdit` ~:2178): every view, every editor slot, every `kind:'file'` tab
whose path matches `remapPath` — rewrite the path, dedupe within a strip;
move matching `state.edits` keys `f:<old>` → `f:<new>`; `notify('ui')`
(persists). `editor-pane.ts` ~:150 already disposes bodies whose id vanished
and builds the new id, which reads the moved edit. A save in flight at the
old path lands on the existing 404 choice — known limit, recorded.

Copy: plain words, no path and no key name in any sentence, no count on the
entry, no separator besides the existing one before `Delete`.

## § 3 Phases

- **Phase 0 (`generalist-dev`, parallel with phase 1):** protocol block,
  `rename-model.ts`, menu-model entry. Tests:
  `tests/ui/ui-rename-model.test.ts` (full mutation gate),
  `tests/ui/ui-context-menu-model.test.ts` extended.
- **Phase 1 (`backend-pty`):** `server/fsrename.ts` + `api.ts` wiring.
  Reviewers scope + **security-auditor (mandatory)** + test-engineer; one fix
  round; FULL mutation probe (path boundary = hard constraint).
  `tests/server/fs-rename.test.ts` (real server child on the `fs-fixture` home): a
  file, a folder with contents, a symlink to a folder (link renamed, target
  untouched), a dangling link; a taken name (file, folder, dangling link) →
  409 with both entries unchanged on disk; case-only on ext4; names `a/b`,
  `..`, `.`, `\0`, 256 bytes of `é`, empty; sources relative,
  `<home>/x/..`, home, a project root, the parent of a project root, the data
  dir, a child of it, a folder containing it; an intermediate symlink out
  (403) and in (renames at the real location); 405/415/413/401 with
  `connection: close`; the `renameErrorFor` table; no name or path in
  `server.log`, no path in the body. The drvfs fallback is untestable here —
  named, as in `fsupload.ts`.
- **Phase 2 (`terminal-ui`, `/frontend-designer`):** the `files.ts` refactor
  and rename flow, `state.retargetFiles`, the gateway, the shortcuts row.
  Reviewers scope + test-engineer (~10 mutants).
  `tests/ui/ui-files-rename.test.ts`: F2 and the menu both open the row in
  place with the stem selected; Esc, blur, a menu opening cancel; same name
  sends nothing; a 409 sentence under the input with the text kept; success
  refetches the parent once, selects and focuses the new key; open folders
  under a renamed folder stay open; anchor rows have no entry and F2 does
  nothing; a multi-selection has no entry; D4's note shows for a session
  cwd inside. `ui-editor-pane` / `ui-unsaved` extended: a dirty tab follows a
  file rename and a folder rename with its text intact; diff tabs untouched.

## § 4 Final gate

Full suite → `/verify-terminal` (standard 1 and 4, plus: F2 with a terminal
focused reaches the PTY; F2 on a Files row and every key typed in the name
row send zero PTY bytes; Esc order name row → selection → panel; a real
rename of a folder holding an open dirty file, checked on disk and in the
tab; zero `resize` lines) → janitor → docs (decision note, log entry,
BACKLOG: move/cut follow-up + the create realpath-key bug) → commit + push,
CI watched → the user's Windows check → then release v0.4.0 on the user's go.

## § 5 What review changed (2026-09-22) — the code is the truth where § 1–§ 2 differ

- **Identity protection** (security review, three rounds): new
  `server/fsprotect.ts` walks every anchor, every STORED project path and the
  CONFIGURED `dataDirPath()` component by component (async `lstat`, bigint,
  symlink targets spliced, `..` from the real folder, 40 hops) and records the
  `dev:ino` of every entry passed. Rename (`lstat(src)`) and DELETE
  (`lstat(target)`) refuse a hit — a symlink deeper in a chain and a drvfs
  case variant pass every string test. Cached 5 s (promise, keyed on the root
  list); a walk hung past `PROTECT_TIMEOUT_MS` 3000 answers 503
  `FS_PROTECT_UNAVAILABLE` (`The app could not check this folder right now.`)
  and is not cached; a request that times out waits on the running walk
  instead of starting another (libuv pool). Delete fetches the set once per
  request.
- Lexical layers kept in front: `holdsStoredProject` (lex, src, dst,
  `join(dirname(lex), name)`) and `holdsConfiguredDataDir` (lex, src) in
  `server/fsbrowse.ts`, in rename AND delete; N5
  `dstIsStoredProjectLocation` compares `dst` with each same-named stored
  project path's realpath'd parent + basename.
- Case-only: a `dst` with a different `dev+ino` → 409 at once; the confirm is
  `readdir`-based (see § 1).
- Rollback: `unlink(src)` failing with ENOENT keeps `dst` and answers 200;
  other errnos roll back.
- The link fallback is also reached on ext4 (EPERM under
  `protected_hardlinks=1`); both it and the drvfs case-only branch are tested
  in-process with spies (`tests/server/fs-rename.test.ts`).
- Client: `canRename({ renamable, count })`; `nameRowEl` takes
  `{indent, caret, icon, label, value, busy, error, note, onEnter, onEscape,
  onBlur}`; a rename row is KEPT while a folder above it is being re-read
  (dropped otherwise); a rename is refused before the request when unsaved
  text is open at or under the new path (`A tab with unsaved changes is
  already open under that name.`), and `retargetFiles` never overwrites an
  existing edit; the refusal line WRAPS (browser gate: it was cut to
  `…already exis…`).
