# Plan B10a — Select several files and folders, and delete them (Nocturne Track B)

Status: LANDED 2026-09-20 (`0293848`; the user's ask the same day B10 landed:
"maak het ook zo, dat ik meerdere mappen, files kan selecteren en deze ook
verwijderen. Want er is nog geen verwijderknop"; then "ga door met b10a";
log `memory/log/2026-09/nocturne/2026-09-20-nocturne-b10a.md`; user-verified
on Windows the same day: "alles werkt").
Parent: `.claude/PLAN-NOCTURNE.md` part B10a. A9b (2026-09-16) gave the Files
panel ONE selected folder; A9c + B2 gave it `New file` / `New folder`; B10
(2026-09-20) gave it a real write. B10a widens the selection to many rows and
adds the app's FIRST DELETE PRIMITIVE. Runs through `/dev-flow` (lean rules
1–11); `security-auditor` mandatory on phase 1; `/verify-terminal` once at the
end, scoped. Designed by the Plan agent 2026-09-20; line numbers drift — verify
by reading. Decisions rationale: `memory/decisions/b10a-multi-select-and-delete.md`.

## User decisions (2026-09-20)

- **D1 several rows.** The selection becomes MANY rows — files and folders,
  and it may span different parent folders (a tree, not one view).
- **D2 delete is PERMANENT, with ONE confirmation per action.** No trash
  (rejected: the freedesktop trash — the app would not show it and Explorer's
  Recycle Bin never sees it). Buttons `Delete` (danger) · `Cancel`; Esc =
  Cancel. The question names the count, and for one item its name; for a
  folder it says out loud that everything inside goes with it.
- **D3 the anchors are never deletable.** The panel's root row and every
  registered project root: the menu entry is ABSENT there, the key does
  nothing, and the server refuses too — a target that IS an anchor and a
  target that CONTAINS one (the parent of a project root; security review).
- **D4 `Copy` on a multi-selection** puts ALL selected paths on the clipboard;
  the host channel takes ≤ 100, more is refused with one sentence.

## Orchestrator defaults (recorded 2026-09-20, not asked; each a cheap flip ⟲)

- ⟲ Explorer semantics: click = select (a folder click still toggles it
  open/closed — A9b); ctrl+click toggles; shift+click = the anchor..row range
  over the VISIBLE rows in tree order; ctrl+a = every visible row; Escape
  clears; ↑/↓ move focus without changing the selection, shift+↑/↓ extend,
  ctrl+↑/↓ move focus only, ctrl+space / ctrl+enter toggle the focused row.
  The tree had NO arrow keys before B10a — this is new surface.
- ⟲ `Delete` in the row menu (Explorer's rule: the whole selection when the
  clicked row is in it, else that row alone) and on the Delete key (with or
  without shift) with the focus in the panel.
- ⟲ Destination with a multi-selection (copy strip, `pasteDestination()`, a
  files paste) = the ANCHOR row's folder when it is a folder, else its PARENT.
  No count line in the strip; the count lives in the question, the menu's
  accessible label and the flash.
- ⟲ Anchor rows inside a selection are dropped from a delete silently; the
  question counts what will really go.
- ⟲ After the delete: affected parents refreshed ONCE, successes leave the
  selection, FAILURES stay selected, one statusline flash. A single item's
  failure shows the SERVER's sentence (it says why).
- ⟲ A child under an ancestor deleted earlier IN THE SAME REQUEST counts as
  deleted; a path already gone before the request answers 404.
- ⟲ No progress surface (`rm -r` per item has no callback); rows wear `is-busy`.
- ⟲ No selection cap; the ACTION is capped at 100 items (413 above, nothing
  touched). `Copy` on a selection = one `winpath` call per path (≤ 100).
- ⟲ No `role="tree"` / `aria-multiselectable` retrofit (selected rows carry
  `aria-current`; the menu label names the count). The selection still clears
  when the panel hides (A9b).

## Facts checked (Plan agent, 2026-09-20 — read and measured)

- `web/src/ui/files.ts` had NO arrow-key navigation; rows are `<button>`s in
  tab order. The selection was one path, module-local, painted from the path.
- `is-sel` was set on FOLDER rows only (accent-900 ground + 2px inset accent
  box-shadow — never a border: a pixel of panel width is a PTY resize).
- **`resolveUnderAllowed()` REALPATHS the path it is given** — it follows a
  final symlink. Deleting its answer would delete a symlink's TARGET. The
  boundary is therefore applied to the PARENT and the final component is
  handed to `rm` unresolved — the `createEntry()` / `fsupload.ts` shape.
- `fs.rm` on Node 24.14.0 (measured): a symlink to a dir, to a file or dangling
  is UNLINKED, target untouched; links inside a tree are not followed; ENOENT
  message says `lstat`; EACCES message quotes the path TWICE → `describeError`
  banned; `recursive:false` on a dir throws `ERR_FS_EISDIR`; `rmSync` blocked
  the event loop 404 ms for 20k files → the async `fs/promises` `rm` is used.
- `readJsonBodySafe` exists because a throwing `JSON.parse` once put a pasted
  credential in `server.log`; this body carries PATHS, so it must use it.
- The danger idiom is red INK + red OUTLINE, never a fill (`.ns-card.is-danger`,
  the armed `End`); no `btn-danger` existed — B10a adds it as the third member
  of `.btn-accent` / `.btn-quiet`. `--color-ink-on-danger` stays reserved for
  the dead-pane banner (a state, not an action).
- `context-menu-model.ts` states "no separators, no counts" — amended in one
  place with the reason. `host-bridge.ts` `copyPathsToClipboard` takes a list.
- `tests/ui-a8-dialogs.test.ts` guards the dialog prefixes (`sc-`/`ut-`/`rs-`/
  `fd-`); `dd-` joins it. `tests/ui-copy-rule.test.ts` scans every literal.

## 1. Contract (Phase 0 + the backend's protocol block)

### `shared/protocol.ts` (Phase 1 owns the block)

```ts
/** Items one delete request may carry. The same number the host clipboard takes. */
export const MAX_DELETE_ITEMS = 100;
/** POST /api/fs/delete. Absolute paths, in the order the tree drew them. */
export interface FsDeleteRequest { paths: string[] }
/** One item's outcome, at the index of its path in the request. `error` is one
 *  of the server's CONSTANT sentences — never derived from the path. */
export type FsDeleteResult = { ok: true } | { ok: false; status: number; error: string };
/** 200. Same length and order as `paths`; a per-item refusal is not a request failure. */
export interface FsDeleteResponse { results: FsDeleteResult[] }
```

ONE request per confirmed action, never one per item: the user answered ONE
question, one request carries its whole answer, one access-log line records
it, and the cap is enforceable where it means something. Index-keyed, no path
back.

### `web/src/ui/files-select-model.ts` — rewritten in place (Phase 0)

`Selection { keys: ReadonlySet<string>; anchor: string | null }`, `EMPTY`,
`isSelected`, `size`, `keyPath`, `keyIsDir`, `afterRowActivate`, `afterToggle`,
`afterRange(sel, key, visible)`, `afterSelectAll(sel, visible)`,
`afterMenuOpen`, `afterEscape`, `afterPanelHidden`, `prunedTo(sel, root)`,
`without(sel, done)`, `destinationPath(sel)`, and unchanged `selectedName`,
`copyIntoText`, `COPY_LABEL`, `takesPaste`; `copyStripLabel(destPath)` takes
the destination PATH and derives the name itself (`selectedName`). Row keys are the tree's own identity (`fdir:<path>` / `ffile:<path>`).

### `web/src/ui/delete-model.ts` (new, DOM-free — FULL mutation gate)

`DeleteItem { path, name, dir, parentName, parentPath }`, `itemsFor({ clicked,
selection, visible, undeletable })` (Explorer's rule; anchors dropped here and
nowhere else; tree order), `pathsOf`, `deleteQuestion`, `deleteSubLine`,
`deletedFlash(ok, total, name)`, `failedKeys(items, results)`, `parentsOf`,
`copiedFlash(ok, total, name)` (the clipboard sentences live here too, under
the same gate — scope review 2026-09-20), `TOO_MANY_TO_DELETE`,
`TOO_MANY_TO_COPY` (both built from `MAX_DELETE_ITEMS`), `DELETE_RUNNING`,
`NOTHING_DELETED`.

### Byte-exact copy

| case | string |
|---|---|
| question, one file | `Delete README.md? This cannot be undone.` |
| question, one folder | `Delete web and everything inside it? This cannot be undone.` |
| question, N items, one parent | `Delete 3 items from src? This cannot be undone.` |
| question, N items, several parents | `Delete 3 items? This cannot be undone.` |
| second line (N > 1 and a folder among them) | `Folders are deleted with everything inside them.` |
| buttons | `Delete` (danger) · `Cancel` (holds the keyboard); Esc / backdrop = Cancel |
| flash, one done | `Deleted README.md.` (an unnameable item: `Deleted 1 item.`) |
| flash, N done | `Deleted 3 items.` |
| flash, partial | `Deleted 2 of 3 items.` |
| flash, nothing (N > 1) | `Nothing was deleted.` |
| flash, nothing (N = 1) | the server's sentence when it passes the panel's sentence gate, else `Nothing was deleted.` |
| over the cap, delete | `Too many items. Delete up to 100 at a time.` |
| over the cap, copy | `Too many items. Copy up to 100 at a time.` |
| a copy is running | `A copy is still running.` (B10, reused) |
| a delete is running | `A delete is still running.` |
| copy, one done | `Copied README.md to the clipboard.` (B10, unchanged) |
| copy, N done | `Copied 3 items to the clipboard.` |
| copy, partial | `Copied 2 of 3 items to the clipboard.` |
| menu label, several | `actions for 3 selected items` |

Server sentences (constants): `FS_DELETE_GONE = 'That item is no longer there.'`,
`FS_NO_DELETE_PERMISSION = 'You do not have permission to delete this.'`,
`FS_DELETE_ANCHOR = 'The app cannot delete your home folder or a project folder.'`,
`FS_DELETE_DATA_DIR = "The app's own folder is not a place to delete from."`,
`FS_DELETE_BUSY = 'That item is in use right now.'`,
`FS_DELETE_CHANGED = 'Something changed inside it while it was being deleted.'`,
`FS_DELETE_FAILED = 'The app could not delete that.'`,
`FS_DELETE_TOO_MANY = 'Too many items. Delete up to 100 at a time.'`.
`FS_PATH_BAD` / `FS_NAME_NOT_ALLOWED` reused. No path, flag, command or key
name anywhere.

## 2. Backend (Phase 1 — `backend-pty`, `security-auditor` MANDATORY)

`server/fsdelete.ts`, `handleDelete` wired in `handleApi` like `handleUpload`.

**Whole request:** `POST` only (405); `content-type: application/json` (415);
body via `readJsonBodySafe(req, 512 KiB)` — never the throwing reader (a parse
error would put paths in the log); too-large → 413 `FS_DELETE_TOO_MANY`;
invalid JSON / `paths` not an array / empty → 400 `FS_PATH_BAD`; length > 100
→ 413 `FS_DELETE_TOO_MANY` with NOTHING deleted (checked before the loop); a
non-string element = per-item 400. The refusals close the connection like the
upload route's. Anchors (`anchorsFor(projects)`) are computed once per request.

**Per item, in request order, sequentially (never `Promise.all`):**
1. `lex = resolve(raw)` — absolute before resolve, NUL refused (400
   `FS_PATH_BAD`); `name = basename(lex)` through `isSafeSegment` + ≤ 255
   bytes (400 `FS_NAME_NOT_ALLOWED`) — `/`, `..`, a trailing `/` die here by
   normalisation, not by hope.
2. `parentReal = resolveUnderAllowed(dirname(lex))` — realpath + anchors; an
   intermediate symlink is judged by its REAL location (a link to `/etc` →
   403, the kernel would unlink there).
3. Data dir refused as PARENT and as TARGET and as a folder CONTAINING it
   (403 `FS_DELETE_DATA_DIR`) — parent-only would let
   `paths:['<home>/.ai-session-manager']` delete the token, prefs and history.
4. `target = join(parentReal, name)`. Anchor refusal (403 `FS_DELETE_ANCHOR`):
   `target` equals an anchor, or CONTAINS one (`isUnderPath(anchor, target)`);
   a non-symlink target is realpathed for this comparison only; a symlink is
   exempt from the realpath halves (a link INTO a project is just a link).
5. `await rm(target, { recursive: true, force: false, maxRetries: 3,
   retryDelay: 50 })` (`node:fs/promises`) — the final component is never
   resolved: a symlink is unlinked, a file unlinked, a directory recursed
   without following links inside. Async so a `node_modules` delete does not
   freeze every PTY (measured 404 ms blocked with `rmSync`).
6. ENOENT under a path already deleted in this request → `{ ok: true }`;
   otherwise the errno table (`deleteErrorFor`, exported, unit-tested):
   ENOENT/ENOTDIR → 404 GONE; EACCES/EPERM/EROFS → 403 NO_PERMISSION;
   ENOTEMPTY → 409 CHANGED; EBUSY/ETXTBSY → 409 BUSY; ENAMETOOLONG → 400
   NAME_NOT_ALLOWED; `ERR_FS_EISDIR` → 500 (unreachable tripwire); else 500.

**Logging:** one `[fs] POST /api/fs/delete -> 200, 3 ok, 1 failed` at info;
per-item debug lines by INDEX; a 5xx adds one `error` line with `errorClass` +
`errorFrames` — never `describeError` or `err.message` (rm's messages quote the
path). Not on the quiet list: a delete is the line a reader looks for.

**What a token holder can and cannot do:** no new privilege (a token holder
can spawn `rm -rf`). New is an irreversible primitive one request wide, bounded
by: entries OF a folder inside home/projects only; never an anchor, never a
folder containing one, never the data dir; never through a symlink; ≤ 100
named items, no globs. Not defended, recorded: deleting one's own files a
folder at a time; the TOCTOU window `fsbrowse.ts` already records; a mount
point under home is walked and deleted (`rm` has no one-file-system flag).

## 3. Frontend (Phase 2 — `terminal-ui`, `/frontend-designer` applies)

- **Selection** in `ui/files.ts`: `let selected: Selection = EMPTY`;
  module-local, not persisted, painted from the keys (`sig()`); `is-sel` on
  file rows too (the existing recipe, no new colour); `aria-current="true"` on
  every selected row; `prunedTo` on a root change; the mouse: shift →
  `afterRange` (no toggle/open), ctrl → `afterToggle` (no toggle/open), plain →
  `afterRowActivate` + A9b's toggle / today's open. A modifier means "I am
  choosing", not "I am going there".
- **Row menu**: `RowSubject` gains `deletable` (not the panel root, not a
  registered project path — best effort; the server is the authority) and
  `count`; `MenuItem` gains `danger?` and `separated?`. Folder: `Open`/`Close`,
  `Copy`, `Paste` (disabled, `PASTE_NOTE`), `Copy files here…`, `New file`,
  `New folder`, `Refresh`, ──, `Delete`; file: `Open`, `Open beside`, `Copy`,
  ──, `Delete`; an anchor row: no separator, no `Delete`; the root menu
  unchanged. `Delete` plain, no count. DOM: `div.cm-sep` (`role="separator"`,
  1px `--color-neutral-800`, `--space-1` margins) appended to the box, not to
  `entries`; `.cm-item.is-danger .cm-label { color: var(--color-danger) }`,
  hover ground unchanged.
- **`ui/delete-dialog.ts`** (`dd-`): the drop dialog's idiom; strings only, no
  path, no items; `.dd-title` = the question, optional `.dd-sub`, footer
  `Cancel` (`btn-quiet`, holds the keyboard) · `Delete` (`btn-danger`); no `×`;
  backdrop = Cancel. `.btn-danger`: same height/padding/radius as the pair,
  `border: var(--line) solid var(--color-danger)`, `color: var(--color-danger)`,
  hover `background: var(--color-danger-tint)`. Never a red fill.
- **Destination** with a selection: `destinationPath(selected)` through the
  existing `destinationOf` chain; `copyStripLabel(destName)`.
- **`Copy` on a selection**: `itemsFor` → > 100 refused → one `winPath` per
  item sequentially → `copyPathsToClipboard(all)` → the count sentences.
- **Keyboard** on the panel root's bubble-phase `keydown` (a focused terminal
  never sees it): `Delete`, `ctrl+a`, `↑`/`↓`, `shift+↑/↓`, `ctrl+↑/↓`,
  `ctrl+space` / `ctrl+enter`, `Escape` (A9b). Delete-arm guards in order: not
  editable; Files tab up; no modal; `isDropRunning()` → the B10 sentence; a
  delete in flight → `DELETE_RUNNING`; nothing deletable → nothing at all.
  Esc ladder in `main.ts`: `isDeleteDialogOpen()` after the folder picker,
  before the drop dialog. Shortcuts overlay: two rows (ctrl/shift-click +
  `delete`, with the note that there is no undo and no recycle bin).
- **After a delete** the focus never lands on `<body>`: the nearest surviving
  tree row, else the Files tab button (scope review 2026-09-20); `openFolders`
  and `listings` under a deleted folder are pruned.
- **The act** (panel-owned): `itemsFor` → `[]` = nothing; > 100 →
  `TOO_MANY_TO_DELETE`; `openDeleteDialog` → on confirm rows `is-busy`,
  `fs.delete(pathsOf(items))` (new `FsGateway.delete`, `api.fsDelete`) → each
  parent in `parentsOf` refreshed once when listed, `selected = without(…)`
  (failures stay), one flash; a rejected request = `NOTHING_DELETED`, selection
  intact. Nothing removed optimistically from the tree. Whole-request `error`
  texts (415/405) are never rendered verbatim — `FS_DELETE_FAILED` client-side.
- `ui/files.ts` never imports `../api.ts` (gateway injection, B2 §9).

## 4. Tests

- **Phase 0** — `tests/ui-files-select-model.test.ts` (rewritten: the
  transition table), `tests/ui-delete-model.test.ts` (sentences byte for byte,
  `itemsFor` cases, `pathsOf` order, `parentsOf`, `failedKeys` alignment, the
  cap sentences equal the server's). FULL mutation gate on `delete-model.ts`.
- **Phase 1** — `tests/fs-delete.test.ts` (real server child on a fixture
  home): file / empty folder / tree; the symlink pair (a link to a folder:
  link gone, `victim/keep.txt` intact; a link INSIDE a deleted folder); a
  dangling link; the boundary table (outside home, data dir as target /
  parent / container, `/`, `<home>/work/..`, home, a project root nested in
  home, a project root outside home, a FILE inside that project); the parent
  of a project root refused; intermediate symlinks in `dirname` (outside →
  403, inside → deletes at the real location); ordering (`[parent, child]`
  both ok, already-gone 404, a bad element leaves its neighbours answered);
  caps (101 → 413 nothing touched; 0 → 400; body over the cap → 413); 405,
  415, 401 with `connection: close`; the errno table through `deleteErrorFor`;
  a big tree does not stall a concurrent `GET /health`; the NAME canary never
  in `server.log`, no path in any result. FULL mutation gate.
- **Phase 2** — `tests/ui-files-delete.test.ts` (the real panel on the
  fixture gateway: selection semantics through real clicks, `is-sel` +
  `aria-current` parity, `Delete` present/absent per row kind, the separator
  once and not an arrow stop, Cancel deletes nothing, `Delete` sends exactly
  the paths in tree order, the Delete key cases, ctrl+a, shift+↑↓,
  ctrl+space, both cap refusals, one refresh per affected parent, the flash
  sentences incl. the server-sentence substitution, failures stay selected,
  `Copy` on three rows), `tests/ui-context-menu-model.test.ts` extended,
  `tests/ui-a8-dialogs.test.ts` with `dd-` as a fifth prefix, the Esc-ladder
  pin. ~10 mutants. Browser evidence: ctrl+click three rows across two
  parents, Delete, confirm → exactly those three gone; 0 `resize` lines.

## 5. Phases and agents

Phase 0 (`generalist-dev`) ∥ Phase 1 (`backend-pty` → scope + security +
test-engineer, one fix round, FULL gate) → Phase 2 (`terminal-ui` → scope +
test-engineer, one fix round, ~10 mutants) → full suite → `/verify-terminal`
→ janitor → docs → commit.

## 6. Final gate

`/verify-terminal` scoped: standard 1, 2, 4, plus (1) the Delete key never
reaches a focused terminal, and with a Files row focused it opens the dialog
with zero PTY bytes; (2) Esc precedence: the confirmation, then the
selection, then the panel, then the terminal; (3) ctrl+a in the panel selects
rows, not the page's text, and still reaches a focused terminal's program;
(4) a real multi-row delete across two parents, verified on disk, one refresh
per parent; (5) 0 `resize` lines for the whole sequence.

## 7. Out of scope (recorded)

Cut / move (a follow-up: a server-side `rename` with two boundary checks).
Rename (the A9c inline name row is the surface it would reuse). Trash or undo
(D2). A progress surface. A batch `GET /api/fs/winpath`. Deleting from the
`Changes` tab. A `role="tree"` retrofit. A selection that survives the panel
leaving the screen. Any delete not named row by row (no globs, no "delete
this folder's contents").
