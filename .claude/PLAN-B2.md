# B2 + A9c — The Files panel reads the real file system, and rows can create files

Status: DECIDED 2026-09-16 (user); LANDED 2026-09-16 (Phase 0 `14fb911`, Brief A `5cfee81`, Brief B `c8416e3`, Brief C `15bff78`); user-verified on Windows 2026-09-17 ("alles werkt"). Parts B2 and A9c of
`PLAN-NOCTURNE.md` (plan decision 11 + the A9c note), pulled forward out of the
Track B order on the user's ask after the A9b check. It makes the panel that A5
drew, A6/A10/A10b wired and A9/A9b made a drop target stand on real data, and it
gives the A9b row menu its first WRITE. Written by the orchestrator from the
Plan agent's design; line numbers drift — this file names functions and regions,
never lines.

## User decisions (fixed)

1. The Files panel stops showing example data. It becomes a REAL file browser
   fed by the backend: root = the user's home directory when no session is
   focused (header `Home`), the focused session's project root otherwise
   (decision 11, 2026-09-15).
2. The v3 git-changes list survives as a `Changes` tab beside `Files` and
   `Commits`: `git diff --numstat` plus untracked files, per project root,
   through the backend. `Commits` stays A5 mock until B3 and keeps its one
   quiet honesty line.
3. A11's rule — Commits (and now Changes) only where a repository can be — is
   from now on decided by a REAL probe (`git rev-parse --show-toplevel` at the
   root), not by "the header does not read Home".
4. **A9c**: the row context menu gains `New file` and `New folder` on folder
   rows AND for the panel root; an inline name row appears in the tree at the
   target folder in edit mode (Explorer-style: type a name, Enter creates,
   Escape cancels; the new item is selected or opened after creation);
   creation is REAL through a backend endpoint that creates an empty file or a
   directory strictly under the user's home. Security review mandatory.
5. REAL over visual-only: there is NO honesty-line mock step for either part.
6. Orchestrator defaults: see the last section but one (adopted 2026-09-16 by
   the orchestrator; the user has not confirmed them one by one).

OUT of scope, said here so nobody reads it into the briefs:
- **File CONTENT read and write is B4.** A file row opens a pane; that pane has
  no text (§5 fixes the words it shows instead).
- **The drop/paste upload transport and the host clipboard are B10.** B2 makes
  A9's destinations REAL PATHS behind the names so B10 has nothing to redo; the
  A9 rule "the UI shows a NAME, never a path" is untouched.
- **Rename and delete are not asked for** and are not built. `New file` and
  `New folder` are the only writes.
- **Cost / telemetry is B1.**
- **Open decision 3 (which files a session is touching → the amber pulse) is
  NOT settled here.** The pulse simply does not show: nothing sets `editing`, so
  `busy` is false on every row. `.files-row.is-busy` and the `busy` field stay
  exactly as they are, unused, until decision 3 is the user's to make.

## Facts checked (Plan agent, 2026-09-16)

- **There is no home boundary in the filesystem code today.** `server/fsbrowse.ts`
  `listDirs()` accepts ANY absolute path (`isAbsolute` → `normalize` → `readdirSync`)
  and `mkdirIn()` accepts any existing directory as `parent`. `web/src/ui/picker.ts`
  even offers a `Root` quick zone and walks to `/`. So the brief's "reuse the
  picker's home-boundary code" has nothing to reuse: §2 ADDS that code, in
  `fsbrowse.ts`, for the new routes only. What IS reusable and is reused
  verbatim: `isSafeSegment()` (1..255 chars, no `/` or `\`, no byte < 0x20, no
  all-dots name) and `isExistingDirectory()` from `server/projects.ts`.
- **The route idiom.** `server/api.ts` gates every `/api/` path on
  `tokenMatches` + `hostAllowed` + `originAllowed` before any route runs
  (`/health` is the only exception), answers errors through `sendError(res,
  status, message)` → `{ error: message }`, and records that message in
  `responseReason` for the access log — whose doc comment states the contract
  the new routes must keep: **every message is a CONSTANT string in the module
  or a constant sentence from a `*Error` class; nothing derived from a body, a
  query or a path is ever put there.** `FsBrowseError(status, message)` is that
  class for `fsbrowse.ts`; the new routes extend it rather than invent a second.
- **The access log already reduces a query to `?…`** and `tests/logging.test.ts`
  pins that a `?path=` value never reaches `server.log`. `web/src/api.ts`
  `request()` does the same on the browser side (`const route = cut === -1 ? path
  : path.slice(0,cut) + ' ?…'`), so a listing URL carrying an absolute path is
  already safe in both logs.
- **Absolute paths are already in the browser and already in `server.log`.**
  `Project.path` is part of the `Project` the UI lists, `SessionInfo.cwd` is
  "Absolute working directory the PTY was spawned in" and is sent to the page on
  every `/api/sessions`, and `server/sessions.ts` logs `session <id> spawned: …
  in <cwd>`. So B2 introduces no new class of path exposure; the copy rule
  ("the UI shows a NAME") is a UI rule, and the log rule that B2 adds (§8) is
  "directories may be logged as the session spawn line already does; the NAME a
  user types for a new file may not — that is user content, like PTY bytes".
- **`runGit` in `server/scaffold.ts` cannot serve B2**: `stdio: 'ignore'`, on
  purpose ("unbounded git output can never grow our memory"). `git diff
  --numstat` needs stdout, so §1 adds a SEPARATE capture runner with an explicit
  byte cap rather than loosening that one. `server/statusline.mjs` is the
  precedent for the shape (`spawnSync('git', ['branch','--show-current'], …)`,
  argv, no shell, a timeout, null on anything odd).
- **`files.ts` reads NO api module today.** It takes `onLeaveScreen` as an
  injected callback precisely so its import graph never reaches `ui/panes.ts` →
  `@xterm/xterm` (which kills `node --test`). §9 keeps that discipline: the
  backend reaches the panel as an INJECTED gateway from `main.ts`, not an
  `import * as api`. That is also what keeps `tests/ui-files-panel.test.ts`
  drivable without the `registerHooks` module-stub machinery
  `tests/ui-picker-dom.test.ts` needs.
- **`files.ts` `listingFor(dest)` is SYNCHRONOUS** and answers from
  `buildTree(MOCK_FILES)`; `filedrop.ts` `offer()` calls it inline while
  building the `DropRequest`. A real listing is a fetch, so `offer()` becomes
  async (§4). Its doc comment already promises "Part B2 replaces this with the
  real listing of the real folder, and the signature does not change" — that
  promise is broken on purpose and the reason is written into the new comment.
- **`files-mock.ts` cannot be deleted by B2.** `MOCK_COMMITS` / `MOCK_BRANCH` /
  `mockCommitByHash` belong to B3 and `MOCK_FILE_CONTENTS` / `mockFileContent` /
  `saveMockFile` / `NO_EXAMPLE_CONTENT` belong to B4 — read by `commit-view.ts`
  and `file-pane.ts`. `MOCK_COMMITS` does NOT depend on `MOCK_FILES` (it is
  built from `withCounts(paths)` over `mockFileContent`), so the FILES half
  (`MOCK_FILES`, `MOCK_FILE_ROWS`, `MOCK_EDITING`, `MOCK_OPEN_FOLDERS` and the
  init loop at the bottom of the module) comes out cleanly and the rest stays.
  `memory/BACKLOG.md` says "when B2/B3 land, delete the mock module"; B2 deletes
  its half and the backlog item narrows to B3/B4.
- **Every current file row carries `+N -N`** (`treeRows` → `hasDiff`, and
  `.files-name.has-diff` is the top of the ink ramp). In a real browser those
  numbers are a property of a repository, not of a folder, so §7 moves them —
  and the `.files-sum` summary row — to the `Changes` tab. `files-model.ts`
  (`buildTree`, `treeRows`, `diffSummary`, `summaryText`, `badgeFor`,
  `caretGlyph`) is UNCHANGED by B2 (Phase 0 amendment: it gained ONE export,
  `rowIndent(depth)`, so both trees share one indent arithmetic — the `▸` glyph
  is allowlisted by that file's name and a value import both ways would be a
  cycle, so the vocabulary stays there and `fs-model.ts` imports it): its input shape `FileChange[]` was written
  as "exactly what a numstat walk produces", and that is what B2 hands it.
- **The row keys are `data-k="fdir:<path>"` / `"ffile:<path>"`** and three
  modules parse them by prefix: `files.ts` (`openRowMenuFor`, `folderNameOf`)
  and `filedrop.ts` (`resolveTarget`). They all end in `fileName(path)` from
  `slots-model.ts` (last non-empty segment), which is correct for an absolute
  path without one line of change.
- **`st.openFile(root, path, label)`** stores the tab as `f:<path>` and logs only
  `name=<label>`; `slotTitle` → `tabTitle` → `fileName(path)`. An absolute path
  is therefore already safe as a tab key and can never print in a chip or a log
  line.
- **`tests/fake-dom.ts` measures nothing** and records timers instead of firing
  them; `installDom()` gives a real capture → target → bubble dispatch, a real
  `activeElement`, `dataset`, `style`, `classList` and a one-selector
  `querySelector`. Anything B2 or A9c decides by geometry has to be a pure
  function, and anything it decides by a clock has to be reachable through an
  injected seam.
- **`isEditableTarget()` in `keys.ts` answers true for any `INPUT`**, so the
  A9c name input is an editable: `takesPaste` will still take a FILES paste
  while it has the keyboard when a folder is selected (harmless — the drop
  dialog opens over the panel), and a TEXT paste into it is never the app's.
  Nothing to change; §6 states it so nobody re-derives it.
- `app.css` Files-panel section: `.files-row` is `height: var(--files-row-h)`,
  `display:flex`; `.files-name` is `flex:1; min-width:0; overflow:hidden;
  text-overflow: ellipsis` — the A9b ellipsis rule that keeps a long name from
  widening the panel. `.files-view .files-row.is-sel` is the accent ground +
  inset tick. `.files-note` is the quiet-line idiom (11.5px,
  `--color-neutral-600`).
- `tests/ui-picker-dom.test.ts` is the established way to stub `../api.ts` for a
  DOM test (`registerHooks` + a source string); `tests/projects.test.ts` +
  `tests/helpers.ts` are the established way to test a ROUTE (a real server
  child process on a `mkdtemp` data dir, discovered through `runtime.json`,
  driven with `api(server, 'GET', …)`).

## 1. The API

Three new routes, all authed like every other `/api` route, all answering the
existing `{ error }` shape with CONSTANT sentences.

### 1a. `GET /api/fs/entries?path=<abs>` — one folder's contents

An ABSOLUTE PATH in the query, not a root id + relative path. Justification,
against the picker's shape: `/api/fs/list` already takes `?path=<abs>` and its
logging is already pinned (`?…`, never values); the client already holds real
absolute paths (`Project.path`, `SessionInfo.cwd`) so a root-id registry would
be a SECOND source of truth for "where is this project" that can disagree with
`projects.json`; and the server must validate the path either way, so a root id
buys no safety — the boundary in §2 does.

`path` omitted → the user's home. That is deliberate: the panel's very first
request both resolves home and lists it, so nothing in the panel has to learn
"what is home" from a second place (`newproject.ts` resolves it from one
`fs/list`; the panel does not have to copy that dance).

```ts
// shared/protocol.ts
export interface FsEntry {
  /** Last path segment. UNTRUSTED display text — textContent, never innerHTML. */
  name: string;
  /** A directory, or a symlink that resolves to one. */
  dir: boolean;
}
export interface FsEntriesResponse {
  /** The RESOLVED absolute path that was listed (the client keys its cache on it). */
  path: string;
  entries: FsEntry[];
  /** Entries NOT in `entries` because the folder is larger than the cap. 0 normally. */
  truncated: number;
}
```

Per-entry fields are `name` and `dir` and nothing else: no size, no mtime, no
mode, no symlink flag — a row shows a caret, a folder mark or a badge, and a
name, and a field no row renders is a field that leaks for free.

Limits and states:
- `MAX_ENTRIES = 1000` after sorting. Above it the first 1000 are returned and
  `truncated` carries the number left out; the panel draws one quiet non-row at
  the end of that folder (§3).
- Sorting is SERVER-SIDE, because truncation is: the window must be the first
  N of the final order or `truncated` is a lie. Comparator: folders before
  files, then case-insensitive natural order
  (`Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })`), ties
  broken by raw code units so the order is total and stable. Exported from
  `fsbrowse.ts` and unit-tested directly.
- Broken symlinks are skipped (the same `statSync`-in-a-`try` the picker
  already does).
- Errors: 400 `PATH_BAD`, 403 `OUTSIDE_HOME`, 403 `NO_PERMISSION`, 404
  `GONE`, 500 `READ_FAILED` — the sentences are in §1d.

### 1b. `POST /api/fs/create` — one empty file or one directory

```ts
export interface FsCreateRequest {
  /** Absolute path of the EXISTING folder it goes in. */
  dir: string;
  /** A single safe path segment (server/fsbrowse.ts isSafeSegment). */
  name: string;
  kind: 'file' | 'folder';
}
/** 201. The created thing's absolute path. */
export interface FsCreateResponse { path: string }
```

- `dir` goes through the same resolution and the same boundary as §1a, plus
  `isExistingDirectory`.
- `name` goes through `isSafeSegment` UNCHANGED — that function is the whole
  vocabulary, and it is the reason the target can never escape `dir`. Hidden
  names (a leading `.`) ARE allowed: `.env`, `.gitignore` and `.claude` are
  things people create, and a rule that forbids them would be a rule about
  nothing.
- `kind: 'folder'` → `mkdirSync(target)`, NOT recursive, exactly as `mkdirIn`.
- `kind: 'file'` → `closeSync(openSync(target, 'wx'))`. `wx` is
  `O_CREAT|O_EXCL|O_WRONLY`: it fails `EEXIST` rather than truncating, and
  `O_EXCL` refuses to follow a symlink at the final component — so a
  pre-planted `~/notes/x -> /etc/shadow` cannot be written through. That is the
  reason the flag is named in the code comment.
- Mapping: `EEXIST` → 409, `EACCES`/`EPERM` → 403, `ENOENT`/`ENOTDIR` → 404,
  anything else → 500. Same table `mkdirIn` already has.

### 1c. `GET /api/git/changes?root=<abs>` — the Changes tab

```ts
export type ChangeStatus = 'modified' | 'new' | 'deleted' | 'renamed';
export interface ChangedFile {
  /** Path relative to the REPOSITORY root, `/` separated. */
  path: string;
  /** null for a binary file (numstat prints `-`), and for an untracked file. */
  add: number | null;
  del: number | null;
  status: ChangeStatus;
}
export interface GitChangesResponse {
  isRepo: boolean;
  /** The repository's own root. null when isRepo is false. */
  repoRoot: string | null;
  /** Current branch, or null on a detached head. An EMPTY repository still names
   *  its branch (`git branch --show-current` prints `main` with no commits —
   *  measured by Brief A, 2026-09-16; the spec first said null). */
  branch: string | null;
  files: ChangedFile[];
  /** Files left out because the repository is larger than the cap. */
  truncated: number;
}
```

Mechanics, all argv, no shell, `GIT_TERMINAL_PROMPT=0`, cwd = the resolved root:
1. `git rev-parse --show-toplevel` → a non-zero exit is NOT an error: it is
   `{ isRepo: false, repoRoot: null, branch: null, files: [], truncated: 0 }`.
2. `git rev-parse --verify HEAD` → tells an EMPTY repository (no commit yet)
   from a normal one.
3. `git diff --numstat -z HEAD` (or, with no HEAD, skipped) → the numbers.
   `-z` because the rename form is `<add>\t<del>\t\0<old>\0<new>\0` and the
   non-`-z` form quotes and escapes non-ASCII names; both are traps and both
   get a fixture.
4. `git status --porcelain=v1 -z --untracked-files=normal` → the status letters
   and the untracked set. `??` → `status: 'new'`, `add`/`del` null; `D` →
   `'deleted'`; `R` → `'renamed'` (the new path is the row). A STAGED add
   (`A `) keeps its numstat counts with `status: 'new'`. An untracked
   DIRECTORY arrives as ONE row with a trailing slash (`sub/`) — kept verbatim
   by the server (measured, Brief A); **Brief B decides how `buildTree` draws
   a path ending in `/`** (a naive split makes an empty-named leaf).
   `--untracked-files=normal` on purpose: `all` walks into every ignored-but-
   present directory and is how a `node_modules` turns one tab into a minute of
   CPU.
- `MAX_CHANGED_FILES = 2000`, then `truncated`.
- The capture runner: `spawn('git', args, { shell:false, cwd, stdio:
  ['ignore','pipe','ignore'], windowsHide:true })`, 5 s timeout → SIGKILL,
  stdout capped at 2 MiB → kill + 500. stderr is `'ignore'`, like `runGit`:
  git's error text is never captured, so it can never reach a response or a log
  line.
- The repository root may be an ANCESTOR of the panel root (a project registered
  at `web/` inside a repo). The tab is about the repository, so the paths are
  repo-relative and the tree is the repository's. §7 says that out loud in the
  header line instead of pretending. (Open decision 1 at the end.)

### 1d. The sentences

All constants in `server/fsbrowse.ts` / `server/git.ts`, all plain, all free of
any path or name the client sent:

| where | status | sentence |
|---|---|---|
| list, create, changes | 400 | `The app cannot open that folder.` |
| list, create, changes | 403 | `This folder is outside your home folder.` |
| list, changes | 403 | `You do not have permission to read this folder.` |
| create | 403 | `You do not have permission to create it here.` |
| create | 403 | `The app's own folder is not a place to create files.` |
| list, changes | 404 | `This folder is no longer there.` |
| create | 404 | `That folder is no longer there.` |
| create | 400 | `That name is not allowed.` |
| create | 409 | `Something with that name already exists here.` |
| list | 500 | `The app could not read this folder.` |
| create | 500 | `The app could not create it.` |
| changes | 500 | `The app could not read this repository.` |

The client renders the server's sentence verbatim (the picker's rule: honest
states only, the backend's own reason inline), so these ARE user-facing copy
and they follow the copy rules: no path, no flag, no command, no key name, one
sentence, full stop.

## 2. The path boundary

AMENDED 2026-09-16 (user, the orchestrator's advice, after the Brief A scope
review): the boundary is **the user's home OR the path of any project
registered in `projects.json`** — a project the user registered at
`/mnt/c/work/app` must show its files and its changes, not
`This folder is outside your home folder.` Anchors = `[HOME, ...every
Project.path]`, each realpathed; the containment test below runs against the
list (`real === anchor || real.startsWith(anchor + sep)` for ANY anchor). The
anchor list is read per request from the projects store (a project registered
a second ago counts), never cached at module load. Everything else in this
section stands, except: the home anchor is resolved LAZY and memoized through
`server/config.ts` `resolveHomeBoundary()` (seam `AI_SM_HOME_OVERRIDE`,
validated at boot — never at module load), the function is
`resolveUnderAllowed`, and the three entry points take `projectPaths` as a
REQUIRED argument (see §9). Rejected: home only (a registered project outside
home would be half usable); an anchor floor (a project at `/` authorises only
`/` itself because containment is `anchor + sep`; any other registered path is
the user's own choice and IS an anchor for its whole subtree).

ONE new function, in `server/fsbrowse.ts`, used by all three new routes and by
nothing else:

```ts
/** The home the boundary is about. `homedir()`, realpathed once at module load. */
const HOME = realpathSync(homedir());

/**
 * Resolve a client path to the one value every consumer below reads, or throw.
 * ORDER IS LOAD-BEARING (memory/knowledge/path-normalization-delete-primitive):
 * isAbsolute BEFORE resolve — `resolve('x')` silently anchors to the server's
 * own cwd — and the containment test is on the REALPATH, because `resolve()`
 * is lexical and the kernel is not.
 */
function resolveUnderHome(raw: string): string;   // as landed: resolveUnderAllowed(raw, { projects, gone, denied }), §9
```

1. `typeof raw === 'string' && isAbsolute(raw)` else 400.
2. `const lex = resolve(raw)` — one value, and every consumer below reads THIS
   one, never `raw`.
3. `const real = realpathSync(lex)` — ENOENT/ENOTDIR → 404, EACCES → 403.
4. `real === HOME || real.startsWith(HOME + sep)` else 403 `OUTSIDE_HOME`.
5. Return `real`.

For `POST /api/fs/create` the parent is resolved this way and the target is
`join(real, name)` with `name` already reduced to a single safe segment — so the
target is under `real` by construction and needs no second test.

**Symlinks: followed, and the boundary is checked AFTER following.** A symlink
inside home pointing inside home behaves like a plain folder. A symlink pointing
OUTSIDE home is still LISTED as an entry (hiding it would be a lie about what is
in the folder) but asking for its contents answers 403 with
`This folder is outside your home folder.`, which the panel renders in that
folder's own slot — the same error state §3 already needs, so no extra field in
`FsEntry`, no extra UI state, and no second code path. Recommended over
hiding, because a symlink farm in `~` is a normal developer setup and a folder
that silently is not there is the worse surprise.

**Dotfiles: shown.** A developer's home is `.ssh`, `.config`, `.claude`,
`.gitconfig`; a browser that hides them shows a home nobody recognises, and B10
would then let a user drop files into a folder the panel refuses to admit
exists. No toggle (not asked).

**`node_modules` and `.git`: listed, no magic hiding.** They are real folders;
the `MAX_ENTRIES` cap is what makes them cheap, not a blocklist. A blocklist is
a lie with a maintenance cost.

**Refused for WRITES: the app's own data dir.** `POST /api/fs/create` answers
403 `The app's own folder is not a place to create files.` when the resolved
`dir` is the data dir or under it. It is still LISTED (it is a real folder in
home). This is not a security boundary — a caller holding the token can already
`POST /api/fs/mkdir` anywhere — it is a category rule: the folder that holds the
auth token, `prefs.json` and `history.json` is not a scratch pad, and an
accidental `New file` in it is a support case nobody wants.

**`/api/fs/list` and `/api/fs/mkdir` are NOT changed.** They serve the project
picker, whose whole job is choosing a folder anywhere on the machine (it has a
`Root` quick zone). Narrowing them would break Add-a-project, the GitHub clone
destination and four tests. The asymmetry is documented at both sites, in the
style `path-normalization-delete-primitive` demands ("so it reads as a choice,
not a mistake"), and §8 hands the security reviewer the question of whether
`/api/fs/mkdir` should grow the same boundary as a follow-up.

## 3. The loading model

ONE strategy: **lazy per folder on expand, cache-then-revalidate, explicit
Refresh, no poll.**

- `openFolders` stays a `Set<string>` of ABSOLUTE paths.
- A new `listings: Map<string, FolderState>` beside it, keyed by the same
  absolute paths:
  `{ k:'loading' } | { k:'ready'; entries; truncated } | { k:'error'; message }`.
- Expanding a folder ALWAYS starts a request. If the cache already holds a
  `ready` for it, the cached rows are drawn immediately and replaced when the
  answer lands — so re-expanding never flashes a `Loading…` row, and the listing
  is never more than one gesture old.
- Own writes invalidate exactly one folder: after a successful
  `POST /api/fs/create`, the target's parent is refetched (§6).
- The ROOT is (re)fetched when the panel becomes visible, when the root changes
  (§4), and on Refresh.
- Refresh is a menu entry, not a header control: the header at 200 px already
  holds three tabs and the panel's name. `Refresh` sits in the folder row's menu
  (refetch that folder) and in the new panel-root menu (refetch the root and
  drop every cached listing under it).
- **No poll and no `fs.watch`.** `fs.watch` is not recursive on Linux, so it
  would mean one watcher per open folder plus a rebuild storm on `npm install`;
  a timer over N open folders is real work every few seconds for a surface that
  changes when the USER changes it. A listing that is one gesture old is not a
  lie as long as re-reading it is one visible press. (The `Changes` tab is the
  opposite case and DOES poll — §7 — because a session editing files is exactly
  what that tab is for.)
- In-flight requests are keyed by path; a second expand of the same folder
  joins the first. Every answer is dropped if the root changed under it (a
  generation counter bumped by `setRoot`), so a slow listing of the old root can
  never paint over the new one.

**States, in the Nocturne idiom, at the child indent of the folder they belong
to, each exactly `--files-row-h` tall so no row moves:**

- `.files-row.is-state` — a `<div>`, not a button: nothing to press. It carries
  a `.files-name` so it inherits the ellipsis rule.
- `Loading…` while a folder has no cached entries and a request is in flight.
  No spinner glyph: a spinner in a 26 px row is decoration, and the A9 rule (a
  visual must not change a row's height, because a panel width change fires
  every pane's ResizeObserver) makes an inline animation not worth its risk.
- `Empty folder` for a `ready` with zero entries.
- The server's own sentence for an `error` (§1d), in `--color-danger` ink.
- `<n> more items are not shown here.` as the LAST child row when
  `truncated > 0` (singular `1 more item is not shown here.`).
- The ROOT's own three states replace the whole tree body, same words.

## 4. Root, and destinations that are real paths

### 4a. The root

`subject()` is unchanged — it still answers the NAME the header prints. Beside
it, a new `rootPath(): string | null`:

1. the focused pane is a file or a diff and its tab has a root → `Home` → the
   home path; a project root → that `Project.path`;
2. the focused pane is a live session → its project's `Project.path`, else that
   session's `cwd` (a real folder the app already knows; HISTORY already groups
   project-less sessions by its last segment);
3. nothing focused → the home path. DECIDED 2026-09-16 (user, the
   orchestrator's advice, after the Brief B scope review): on the fixed `Home`
   tab with no focused pane the panel shows HOME, not the project of "the
   first session still alive anywhere" (the A5 header rule) — since B2 that
   rule would decide a whole tree, and the user's own home would be
   unreachable while any session lives. The header follows the same root.
   A session's project shows as soon as one of its panes is focused;
4. the home path is not known yet (the first `GET /api/fs/entries` has not
   answered) → null, and the tree shows `Loading…`.

The header still prints `subject().name` and still never prints a path. For a
project-less session the header says the session's title and the tree lists that
session's working directory — one screen, one folder, two honest names for it.

**When the root changes**, `openFolders`, `listings` and `selected` are keyed by
absolute path, so they simply stop matching and the tree collapses to the new
root's top level. That is not enough on its own for the SELECTION: a `selected`
path under the old root would keep naming a folder nobody can see while
`pasteDestination()` still answered it. So `setRoot(next)` explicitly: clears
`selected` when it is not under `next`, prunes `openFolders` and `listings` to
paths under `next`, bumps the generation counter, and fetches `next`.

### 4b. `Destination` — one type, threaded everywhere

```ts
// web/src/ui/fs-model.ts
/** A real folder: the PATH the transport needs, the NAME the UI is allowed to show. */
export interface Destination { path: string; name: string }
```

`filedrop.ts` re-exports it for its existing readers. `FileDropDeps` changes,
member for member:

```ts
export type PaneDest = { dest: Destination } | { dest: null; why: 'session' | 'tab' };
export interface FileDropDeps {
  openDialog(req: DropRequest): void;
  listingFor(dest: Destination): Promise<readonly string[]>;   // was sync, was by name
  destinationOfPane(paneEl: HTMLElement): PaneDest;
  destinationOfActiveView(): Destination | null;
  filesPanelDestination(): Destination | null;
  pasteDestination(): Destination | null;
  selectedFolder(): Destination | null;
  openPicker?(take: (files: readonly FileLike[]) => void): void;
  flash?(msg: string): void;
}
export interface DropRequest {
  dest: Destination;                 // the dialog renders dest.name and nothing else
  items: DropItem[];
  listing: readonly string[];
  returnFocus: HTMLElement | null;
}
```

- Every place that today builds a name — `resolveTarget()`'s `fdir:` branch,
  `destinationOfPane`, `destinationOfActiveView`, `filesPanelDestination`,
  `pasteDestination` — now builds `{ path, name }` where `name` is
  `fileName(path)` and, at a root, `Home` or the project's own name. The
  ghost, the dialog, the strip button's label and its title all keep reading
  `.name`, so not one visible string changes. `drop-model.ts` is UNCHANGED:
  `destLine(n, dest)`, `conflictTitle`, `progressText`, `resultText` keep taking
  a `string`, and the caller passes `dest.name`. B10 then posts `dest.path` and
  has nothing to redo.
- `offer()` becomes `async`: it `await`s `listingFor(dest)` before opening the
  dialog. `returnFocus` is captured BEFORE the await (it already is), a refusal
  (`tooMany`, zero items) still flashes without any request, and a listing that
  FAILS opens the dialog with an EMPTY listing — a drop must not be lost because
  a folder could not be read, and "no known conflicts" is the non-destructive
  reading. The drop-dialog contract does not change.
- `listingFor(dest)` fetches `GET /api/fs/entries?path=<dest.path>` on the drop
  and returns `entries.map(e => e.name)`. It does NOT read the panel's cache:
  the destination is usually a folder nobody expanded, and a conflict answer
  from a stale cache is the one place a stale listing IS a lie (it decides
  whether a file is overwritten).
- **A session pane without a project becomes a TARGET** named by the last
  segment of its `cwd` (orchestrator default, §Defaults). The `'session'`
  refusal sentence stays for the genuinely nameless case and `'tab'` is
  unchanged.

## 5. File rows → editor panes

`st.openFile(currentRoot(), r.path, r.name)` is unchanged except that `r.path`
is now an absolute path. `f:<abs path>` is a fine tab key, `tabTitle` already
reduces it to `fileName`, and the debug line already logs `name=<label>` and not
the path. `rootForSubject()` and the A10 "which tab does this file land in" rule
are NOT touched by B2 (that is a view-model change; the A10 gap for a
project-less session stays open and B4 revisits it).

**What the pane shows for a real file, NOW.** Today `file-pane.ts` reads
`mockFileContent(path)` and, on `null`, draws `NO_EXAMPLE_CONTENT`
(`There is no example content for this file yet.`) with no Save, plus the strip
line `Example content until the app reads your files.` With absolute paths the
mock map never matches, so every file pane already takes that branch — only the
WORDS are now wrong, because they promise example content for a file that is
real.

So, in `file-pane.ts` only:
- the empty-body line becomes `The app cannot read this file yet.` (a new
  constant in `file-pane.ts`, not in `files-mock.ts`);
- the `placeholderNote()` strip line is DELETED with its single call site —
  there is no example content left to warn about;
- Save stays absent (nothing to write until B4);
- `commit-view.ts` is UNTOUCHED: its diff blocks really are mock until B3, so
  `NO_EXAMPLE_CONTENT` keeps its words and its home in `files-mock.ts`.

Recommended wording, and why not the alternatives: `File contents arrive in a
later part.` leaks the plan's vocabulary into the chrome; `Coming soon` is a
promise with no date. `The app cannot read this file yet.` is what is true, in
the app's own voice, and it dies in B4 with the module that reads files.

## 6. A9c — the inline create row

### 6a. The menu

`context-menu-model.ts` gains two actions and one new list:

```ts
export type MenuAction =
  | 'toggle' | 'open' | 'open-beside' | 'copy' | 'paste' | 'copy-files'
  | 'new-file' | 'new-folder' | 'refresh';

export function itemsFor(row: RowSubject): MenuItem[];   // folder rows gain
  // …, { 'copy-files', COPY_LABEL }, { 'new-file', 'New file' },
  //    { 'new-folder', 'New folder' }, { 'refresh', 'Refresh' }
export function itemsForRoot(name: string): MenuItem[];  // NEW: the panel's own
  // [ Copy files here…, New file, New folder, Refresh ]
export function rootMenuLabel(name: string): string;     // 'actions for Home'
```

File rows are unchanged (`Open`, `Open beside`, `Copy`) — a file does not hold
files, and offering "new file beside this one" would be a second destination
rule nobody asked for. Creation sits at the BOTTOM of the folder list, beside
`Copy files here…`: the two are the same idea ("put something in this folder").

The panel ROOT menu opens on a right-click anywhere in `.files-view` that is not
a row — today that event is left to the system menu, and A9c is the ask that
changes it. Its keyboard twin: the ContextMenu key / Shift+F10 while the focus
is inside the panel and NOT on a row, taken by the existing panel-root
`keydown` listener (which already owns Escape there), `preventDefault` +
`stopPropagation` as the row chord does.

### 6b. The row

State, one at a time, beside `selected`:
`let creating: { dir: string; kind: 'file' | 'folder'; error: string | null } | null`.

- Choosing `New file` / `New folder` for folder `P`: expand `P` first (fetching
  it if needed — you must see where the thing lands), set `creating`, repaint.
  For the panel root, `dir` is the root path and no expansion is needed.
- `rebuild()` inserts, as the FIRST child row of `P` (or the first row of the
  body for the root), a `.files-row.is-new` — a `<div>`, not a button, at the
  child indent, holding the caret spacer, the folder mark (for a folder) or the
  neutral badge (for a file), and an `<input class="files-newname">` with
  `aria-label` `new folder name` / `new file name`, `spellcheck=false`,
  `autocapitalize=off`. It takes the keyboard on the repaint that created it.
- Enter → validate → `POST /api/fs/create`. Escape → cancel, and
  `stopPropagation()` so the panel's Escape listener does not also clear the
  selection. Blur → CANCEL, not commit: a blur here is a menu opening, an
  Alt-Tab or a rebuild, and creating a file from a half-typed name is worse than
  losing three keystrokes. (Explorer commits on blur; this app does not have
  Explorer's undo.)
- While a request is in flight the input is `readOnly` and the row wears
  `.is-busy` — the existing opacity pulse, which changes no height.
- Validation is INLINE, never a modal: a second `.files-row.is-newerr` row
  directly beneath, same height, danger ink, holding one sentence. (Inserting a
  row in a scrolling list changes no PANEL WIDTH, so the A9 no-layout-shift rule
  is respected — that rule is about the panel's width firing every pane's
  ResizeObserver, not about the tree's scroll height.)
- Client-side rules mirror `isSafeSegment` exactly, so the ordinary mistakes
  never cost a request: empty → `Type a name first.`; `/` or `\` →
  `A name cannot contain a slash.`; all dots → `That name is not allowed.`; a
  control character → `That name is not allowed.`; longer than 255 →
  `That name is too long.` A leading dot is fine.
- A 409 renders the SERVER's sentence (`Something with that name already exists
  here.`) in the same row; so does every other failure. The input keeps its text
  and the keyboard, so the fix is one edit away.
- On success: refetch `dir`; then a folder is SELECTED (and expanded) and a file
  is OPENED (`st.openFile(currentRoot(), path, name)`); either way the keyboard
  lands on the new row (`data-k` is known from the response path).
- `creating` is cancelled by: Escape, blur, a tab switch, a root change, the
  panel leaving the screen, and any menu opening — the same list `closeRowMenu()`
  already has, plus the two that are about the tree.

### 6c. Copy

`New file` · `New folder` · `Refresh` — three labels, no ellipsis (the name row
IS the dialog, so nothing is "opening"), no icons, no counts, no key names.
`shortcuts.ts` gains one gesture row: *right-click the Files panel's background
→ its actions (twin: the menu key or shift+f10 with the focus in the panel)*,
and the existing row-menu row's note grows the two new entries.

## 7. The Changes tab

Three tabs: `Files` · `Changes` · `Commits`. `Files` is the browser (§3), and it
loses the per-row `+N -N` and the `.files-sum` summary row — those are facts
about a repository, not about a folder, and they move here whole.

- Rows come from `GitChangesResponse.files` mapped to the SAME `FileChange[]`
  the A5 model already eats, and drawn by the SAME `buildTree` + `treeRows`
  renderer, with its own open-folder set. Recommended over a flat list: the v3
  reference shows a tree, the renderer exists and is tested, and a flat list of
  repo-relative paths is the one place this panel would have to print
  path-shaped text. `status: 'new'` rows carry no numbers (the numberless row is
  already a state `treeRows` draws); deleted rows carry their `-N` and no `+`.
- Summary row: `+A -D` + `summaryText(n)` → `since last commit in 7 files`,
  unchanged functions.
- Empty: `No changes since the last commit.`
- Not a repository: the tab is DISABLED (really disabled, `aria-disabled`, a
  `title`), exactly as A11 does for Commits, with the title `No repository at
  <name>` — where `<name>` is `subject().name`, so the sentence works for `Home`
  and for a project. The panel falls back to `Files` when it was standing on a
  tab that just became unavailable (the existing `setTab` guard, generalised).
- **A11's rule is now a real probe.** `repoKnown()` stops being `!subject().home`
  and becomes `changes.isRepo`, from the last answer for the current root. While
  the answer is unknown (`null`) the tab is disabled with the same
  `No repository at <name>` title and enables itself when the answer arrives
  (a third transient title would be noise). `Commits` uses the same probe, so
  a home folder that IS a repository now offers both tabs, and a project
  registered outside a repository offers neither — both more honest than the
  A11 stopgap.
- Refresh: on tab open, on root change, and a poll every `CHANGES_POLL_MS =
  5000` **only while the Changes tab is the visible tab and the panel is on
  screen**, skipped while a request is in flight. This is the one poll B2 adds,
  and it is justified where §3's is not: the tab exists to watch a session
  change files. The timer is created and cleared by the tab switch, so a hidden
  panel costs nothing.
- `Commits` keeps `MOCK_COMMITS` and keeps its one quiet line
  (`Example data until the panel reads your commits.`), now the only one in the
  panel. The Files tab's half of `placeholderNote()` is deleted; the function
  survives for the Commits tab until B3.

## 8. Security review scope (mandatory, `security-auditor`, on the backend brief)

Hand the reviewer this list, not "review the diff":

1. **Traversal.** `..`, doubled slashes, a trailing `/..`, a relative path, an
   empty string, a NUL in the query, a path that is a prefix of home as a STRING
   but not a child (`/home/userevil` vs `/home/user`) — the `startsWith(HOME +
   sep)` form is exactly what defends the last one and must be tested for it.
2. **Symlink escape**, both directions: a symlink in home to `/etc`; a symlink
   chain; a symlink swapped between the `realpath` and the `readdir`/`open`
   (TOCTOU — accept it for a localhost single-user service and say so, the
   window is not exploitable by anything that does not already hold the token);
   and the `wx` flag as the defence for the final component of a create.
3. **Writes into the app's own data dir** — refused. DECIDED 2026-09-16 (security
   review): refusing is enough; `/api/fs/mkdir` keeps NO boundary (it creates one
   empty directory with a safe name and cannot overwrite or follow a symlink).
4. **Name injection.** `isSafeSegment` is the only vocabulary; check that
   nothing downstream re-parses the name, that a name is never interpolated into
   a shell string (nothing here spawns a shell), and that a name never reaches
   `innerHTML` in the panel (`textContent`, like the picker).
5. **Listing enumeration.** These routes turn a token into a filesystem reader
   for the whole home tree. That is the product, and the token is the boundary —
   but check the rate: the caps (`MAX_ENTRIES`, `MAX_CHANGED_FILES`, the git
   timeout and stdout cap) are what keeps one page from turning the backend into
   a `find /`.
6. **Error text.** No message may contain anything the client sent. All are
   module constants — the `responseReason` contract in `api.ts` depends on it,
   and a violation writes a path into the access log's refusal field.
7. **Auth.** All three routes are under `/api/` so the gate is structural; the
   check is that they are added to the token-required lists in
   `tests/github-token.test.ts` and `tests/ui-api-auth.test.ts`.
8. **`log everything` vs path privacy.** The rule B2 writes down:
   *directories may be logged* (the backend already logs
   `session <id> spawned: … in <cwd>`), *contents and user-typed names may not*
   (that is the PTY-bytes rule: counts, never content). Concretely: a listing
   logs the route, the status and `<n> entries` — never a name; a create logs
   the KIND and the outcome — never the name the user typed; a git call logs the
   subcommand and the exit status — never stderr, never a path from the output.
9. **Git.** argv only, `shell:false`, `GIT_TERMINAL_PROMPT=0`, a cwd that has
   already passed the boundary, stderr discarded, stdout capped, SIGKILL on
   timeout, and no user value ever placed where git could read it as an option
   (the only user value is the cwd, which is not an argument).

## 9. Model (DOM-free, Phase 0)

No `state.ts` change, no new notify kind, no localStorage schema bump. The panel
keeps `openFolders`, `listings`, `selected` and `creating` as instance state:
none of it is server state and none of it survives a reload.

```ts
// web/src/ui/fs-model.ts  (NEW)
export interface FsEntry { name: string; dir: boolean }
export interface Destination { path: string; name: string }

export const MAX_NAME_LEN = 255;
export const LOADING_TEXT = 'Loading…';
export const EMPTY_TEXT = 'Empty folder';
export const NO_CHANGES_TEXT = 'No changes since the last commit.';

export type FolderState =
  | { k: 'loading' }
  | { k: 'ready'; entries: readonly FsEntry[]; truncated: number }
  | { k: 'error'; message: string };

export type NameProblem = 'empty' | 'slash' | 'dots' | 'control' | 'too-long';
export function nameProblem(raw: string): NameProblem | null;   // mirrors isSafeSegment
export function nameProblemText(p: NameProblem): string;

export function joinPath(dir: string, name: string): string;
export function parentPath(p: string): string;
export function isUnder(path: string, root: string): boolean;   // === or startsWith(root + '/')
export function destinationOf(path: string, root: string, rootName: string): Destination;
export function truncatedText(n: number): string;               // '1 more item…' | 'N more items…'

/** One rendered row of the live tree, the same shape `treeRows` emits plus the states. */
export interface FsRow {
  kind: 'dir' | 'file' | 'state';
  path: string;      // '' for a state row
  name: string;      // the state row's sentence for kind 'state'
  depth: number;
  indent: number;    // 8 + depth * 14 — the A5 constants, one definition
  open: boolean;
  caret: '' | '▾' | '▸';
}
/** The whole tree, from the cache and the open set. Pure; the panel only paints it. */
export function fsRows(
  root: string,
  open: ReadonlySet<string>,
  listings: ReadonlyMap<string, FolderState>,
): FsRow[];

/** Where the A9c name row goes, given the rows and the target folder. */
export function createRowIndex(rows: readonly FsRow[], dir: string, root: string): number;

/** GitChangesResponse.files -> the A5 renderer's input. Unchanged renderer. */
export function changesToFiles(files: readonly ChangedFile[]): FileChange[];
```

```ts
// web/src/ui/context-menu-model.ts  (additions)
export function itemsForRoot(name: string): MenuItem[];
export function rootMenuLabel(name: string): string;
// MenuAction gains 'new-file' | 'new-folder' | 'refresh'
```

```ts
// web/src/ui/files.ts  (the injected backend seam — NOT an import of ../api.ts)
export interface FsGateway {
  entries(path?: string): Promise<FsEntriesResponse>;
  create(dir: string, name: string, kind: 'file' | 'folder'): Promise<FsCreateResponse>;
  changes(root: string): Promise<GitChangesResponse>;
}
export function initFilesPanel(host: HTMLElement, onLeaveScreen: () => void, fs: FsGateway): FilesPanel;

// changed signatures, all now real paths behind the names
export function filesPanelDestination(): Destination | null;
export function pasteDestination(): Destination | null;
export function selectedFolder(): Destination | null;
export function destinationOfActiveView(): Destination | null;
export function destinationOfPane(paneEl: HTMLElement): PaneDest;
export function listingFor(dest: Destination): Promise<readonly string[]>;
```

```ts
// web/src/api.ts  (additions, the existing request() idiom)
export function fsEntries(path?: string): Promise<FsEntriesResponse>;
export function fsCreate(dir: string, name: string, kind: 'file'|'folder'): Promise<FsCreateResponse>;
export function gitChanges(root: string): Promise<GitChangesResponse>;
```

```ts
// server/fsbrowse.ts  (additions; listDirs/mkdirIn/isSafeSegment UNCHANGED)
export function listEntries(requested: string | undefined): FsEntriesResponse;
// Brief A as landed (+ follow-up 2026-09-16): test seam AI_SM_HOME_OVERRIDE (validated
// at boot like AI_SM_WEB_DIST_DIR, never inherited by PTYs); the boundary is an ANCHOR
// LIST (home + every registered project path, read per request in api.ts
// projectAnchors()): resolveUnderAllowed(raw, { projects?, gone?, denied? }),
// listEntries(requested, projectPaths), createEntry(dir, name, kind, projectPaths),
// changesFor(root, log, projectPaths) — projectPaths defaults to [] (fail-safe narrow);
// git runs with GIT_CONFIG_COUNT=1 core.fsmonitor=false and GIT_OPTIONAL_LOCKS=0; one
// [git] log line per request; /api/git/changes 200s are debug in the access log;
// names over 255 BYTES are 400; homeRoot() removed (the old name resolveUnderHome is
// history). Still true: the resolver takes the 404/403 sentences (list and create
// differ) and is exported for git.ts; changesFor takes the logger; an OMITTED ?path= is
// home, an EMPTY ?path= is 400 (unlike /api/fs/list); a path outside every anchor that
// does not exist answers 404 before 403.
export function createEntry(dir: string, name: string, kind: 'file'|'folder'): FsCreateResponse;
export function compareEntries(a: FsEntry, b: FsEntry): number;   // pure, unit-tested

// server/git.ts  (NEW)
export function changesFor(root: string): Promise<GitChangesResponse>;
export function parseNumstatZ(out: string): Map<string, { add: number|null; del: number|null }>;
export function parsePorcelainZ(out: string): { path: string; status: ChangeStatus }[];
```

Why an INJECTED gateway rather than `import * as api` in `files.ts`: the module
already refuses to import `ui/panes.ts` so it stays drivable under `node --test`,
and the same discipline keeps `tests/ui-files-panel.test.ts`,
`ui-files-select.test.ts`, `ui-context-menu.test.ts` and the new create test on a
plain fake object instead of the `registerHooks` module-stub harness. `main.ts`
passes the real one in its INIT region, one line.

## 10. Phases

- **Phase 0 — MODEL** (`terminal-ui`, alone, parallel with Brief A):
  `web/src/ui/fs-model.ts` + `tests/ui-fs-model.test.ts` (+ `rowIndent` exported
  from `files-model.ts`). No DOM, no CSS, no api, no state. LANDED 2026-09-16.
- **Brief A — BACKEND** (`backend-pty`, parallel with Phase 0):
  `shared/protocol.ts` (the five new interfaces), `server/fsbrowse.ts`
  (`resolveUnderHome`, `listEntries`, `createEntry`, `compareEntries`, the new
  sentences), NEW `server/git.ts`, `server/api.ts` (three route blocks, placed
  after the existing `--- Filesystem …` blocks), `web/src/api.ts` (three client
  functions). Tests: NEW `tests/fs-entries.test.ts`, `tests/fs-create.test.ts`,
  `tests/git-changes.test.ts` — real http against a booted server on a scratch
  data dir (`tests/helpers.ts` `startTestServer` + `api()`, the
  `tests/projects.test.ts` idiom), with a `mkdtemp` fixture tree (a dotfile, a
  symlink inside home, a symlink outside home, a broken symlink, a 1200-entry
  folder, a `git init`ed repo with a commit, a modified file, a binary file, an
  untracked file, a rename, and a repo with no commit at all) and direct unit
  tests of `compareEntries`, `parseNumstatZ`, `parsePorcelainZ`. **Security
  review gate on this brief, scope = §8.**
- **Brief B — THE LIVE PANEL** (`terminal-ui`, after Phase 0 AND Brief A):
  `files.ts` regions `// ---- the tree ----`, `// ---- the root ----`,
  `// ---- destinations ----`, `// ---- changes ----`; `filedrop.ts`
  (the `Destination` threading, async `offer`, the dep contract);
  `main.ts` INIT region (the gateway, one line, plus the dep rewiring);
  `files-mock.ts` (delete `MOCK_FILES`, `MOCK_FILE_ROWS`, `MOCK_EDITING`,
  `MOCK_OPEN_FOLDERS` and the init loop; keep the contents and commits halves
  with a comment naming B3/B4); `file-pane.ts` (the two copy changes of §5);
  `app.css` "Files panel" section only (`.files-row.is-state`, the `Changes`
  tab reusing the `files-tab` rules). Tests: rewrite `ui-files-panel`,
  `ui-files-select`, `ui-context-menu`, `ui-filedrop`, `ui-drop-model`,
  `ui-files-model`, `ui-file-pane`, `ui-commit-model` (its `MOCK_FILES` pin).
- **Brief C — A9c** (`terminal-ui`, after Brief B): `context-menu-model.ts`
  (two actions, `itemsForRoot`, `rootMenuLabel`), `files.ts` region
  `// ---- creating a file or a folder ----` + the panel-root menu in the
  existing `// ---- the row menu ----` region, `app.css` ONE new block
  (`.files-row.is-new`, `.files-newname`, `.files-row.is-newerr`),
  `shortcuts.ts` (one row + one note). Tests: NEW
  `tests/ui-files-create.test.ts`, additions to `ui-context-menu-model`.
- **SEQUENCE, not parallel, for B and C**: both edit `fileRows()` and both read
  the tree state. Overlap contract, the A9b one: `files.ts` by NAMED REGION
  (block headers, never lines), `app.css` by SECTION (B stays inside "Files
  panel", C adds one new block and touches no other), `context-menu-model.ts`
  belongs to C alone, `shared/protocol.ts` and `web/src/api.ts` to A alone.

### Mock removal — every reader, and how it migrates

| reader | uses | after B2 |
|---|---|---|
| `web/src/ui/files.ts` | `MOCK_FILES`, `MOCK_OPEN_FOLDERS`, `MOCK_BRANCH`, `MOCK_COMMITS`, `mockCommitByHash` | keeps only the four commits symbols (B3) |
| `web/src/ui/file-pane.ts` | `mockFileContent`, `saveMockFile`, `NO_EXAMPLE_CONTENT` | keeps `mockFileContent`/`saveMockFile` for the edits map until B4; stops using `NO_EXAMPLE_CONTENT` (§5) |
| `web/src/ui/commit-view.ts` | `mockFileContent`, `NO_EXAMPLE_CONTENT`, `MOCK_COMMITS` | untouched (B3/B4) |
| `tests/ui-files-model.test.ts` | `MOCK_FILES`, `MOCK_OPEN_FOLDERS` | those assertions move to a FIXTURE listing declared in the test; `MOCK_BRANCH`/`MOCK_COMMITS` assertions stay |
| `tests/ui-files-panel.test.ts` | `MOCK_FILES`, `MOCK_OPEN_FOLDERS` (and the rows named `README.md`, `web`, `src`, `server` throughout) | a fixture tree served by the fake `FsGateway`, with the SAME names so the assertions read the same; every tree test gains an `await` for the first listing |
| `tests/ui-files-select.test.ts` | `MOCK_OPEN_FOLDERS` as the starting shape | same fixture gateway; the "restore between tests" helper resets the fake instead of the mock |
| `tests/ui-context-menu.test.ts` | `MOCK_OPEN = ['web','web/src','server']` (its own copy) and rows `web`, `server`, `README.md` | same fixture gateway; the local `MOCK_OPEN` constant becomes the fixture's open set |
| `tests/ui-drop-model.test.ts` | `MOCK_FILES` for the conflict listing | a literal listing array in the test — `conflictsOf` never cared where the names came from |
| `tests/ui-commit-model.test.ts` | `MOCK_FILES` numbers-come-from-one-derivation pin | the `MOCK_FILES` half of that test is deleted; the commits half stays |
| `tests/ui-a6-screens.test.ts`, `ui-file-pane`, `ui-editor-pane` | contents + commits only | untouched |

`memory/BACKLOG.md`'s "Mock data out of production code" item and its
"`MOCK_FILES` is an exported const mutated at module init" item are BOTH closed
by Brief B; the backlog entry narrows to "B3/B4 own what is left".

### Tests, by claim

**Backend (Brief A)**
- absolute-only, normalized once: a relative path, `..`, `//`, an empty string
  and a NUL each answer the documented status, and none of them lists anything;
- `<home>evil` is not under `<home>`; `<home>` itself is;
- a symlink inside home lists; a symlink out of home is LISTED as an entry but
  403s when listed; a broken symlink is skipped;
- dotfiles, `node_modules` and `.git` are all present in a listing;
- sort: folders first, then case-insensitive natural (`img9` before `img10`,
  `Apple` before `banana`), total and stable;
- 1200 entries → 1000 returned + `truncated: 200`, and the 1000 are the FIRST of
  the sorted order;
- create: a file, a folder, a hidden name; duplicate → 409; `/`, `\`, `..`,
  `...`, empty, 256 chars, a control char → 400; a 255-char name → 201; a
  missing parent → 404; the data dir → 403; `wx` does not truncate an existing
  file and does not follow a symlink;
- changes: a repo with a modification, a deletion, a rename, an untracked file
  and a binary file produces the documented rows; a non-repo answers
  `isRepo:false` and not an error; a repo with no commit answers every file as
  `new`; a path with a space, a `"` and a non-ASCII name survives `-z`;
- caps: the git stdout cap and the 5 s timeout each end the call without hanging
  the request;
- every new route requires the token (added to the existing lists);
- `server.log` after a listing, a create and a changes call contains no entry
  name, no created name and no git stderr — and DOES contain the request lines.

**Frontend (Briefs B and C)**
- the tree is the gateway's answer, in the gateway's order; a folder expands with
  one request and re-expands from cache without a `Loading…` flash;
- `Loading…`, `Empty folder`, the server's error sentence and the truncated note
  each appear exactly where §3 says, each as a non-button at `--files-row-h`;
- a root change clears a selection that is not under the new root, prunes the
  open set and the cache, and a LATE answer for the old root never paints;
- destinations: `pasteDestination()`, `filesPanelDestination()`,
  `destinationOfPane()` and `destinationOfActiveView()` each answer a
  `{path,name}` whose `name` is byte-identical to what A9/A9b already showed
  (a parity test against the old expectations), and whose `path` is the real
  folder;
- the drop dialog is opened with the REAL listing fetched at drop time, and with
  an EMPTY listing when that fetch fails — and the drop still happens;
- a file row opens `f:<absolute path>`, the chip reads the file name, and the
  pane body reads `The app cannot read this file yet.` with no Save and no
  example-content line;
- Changes: rows and summary from the fake gateway, the empty sentence, the
  disabled tab with its title when `isRepo` is false, the fallback to `Files`
  when the tab it stood on became unavailable, the poll only while that tab is
  visible (through the fake-DOM's recorded timers, never a real clock);
- A9c: the two entries appear on folder rows and on the root menu and NOT on
  file rows; the name row lands at the target's indent with the folder expanded;
  Enter posts `{dir,name,kind}`; Escape cancels WITHOUT clearing the selection
  and without closing the panel; blur cancels; each name rule shows its sentence
  without a request; a 409 shows the server's sentence and keeps the text; a
  successful folder is selected and expanded, a successful file is opened, and
  the keyboard lands on the new row; one create at a time;
- class parity for `.files-row.is-state`, `.is-new`, `.is-newerr` (no class
  without a rule, no rule without a setter), tokens only, no colour literal;
- copy-rule scan over every new sentence (no path, no command, no key name,
  plural forms, state words).

## 11. Risks → verify (`/verify-terminal` after Brief B, again after Brief C)

Nothing here touches the fit → ws resize seam, `TerminalView`, the ctrl+alt
allowlist or `state.ts`. The checks that matter are the ones a real file system
introduces:

1. `server.log` shows NO `resize` line while a folder expands, while a listing
   refreshes, while the Changes tab polls, while the name row opens and while a
   file is created. (A row inserted into the tree must not change the panel's
   width; the A9 rule is that a width change fires every pane's ResizeObserver.)
2. The panel's width is unchanged by a 200-character file name and by a deeply
   nested path — the A9b ellipsis rule, now over names the app did not choose.
3. A folder with thousands of entries (`~/.cache`, a `node_modules`) lists
   inside the cap, draws its truncated note, and the panel stays responsive; the
   backend does not grow while it is listed repeatedly.
4. The A9 checks, now with real destinations: drag from Explorer onto a real
   folder row (the ghost names that folder), onto the panel background (the
   root's name), onto a pane; the conflict dialog lists the REAL names in the
   destination; a drop on a session pane WITHOUT a project is now a target named
   by its working directory's last segment.
5. The A9b paste matrix once more (files × selection × terminal × editable ×
   modal), plus: a TEXT paste into the A9c name input is the input's own and
   reaches no drop dialog.
6. Escape ladder, in order: inside the name row it cancels the create; then it
   clears the selection; then it closes the panel. Three presses, three
   different things, and the terminal has the keyboard at the end.
7. A right-click on the panel BACKGROUND now opens the app's menu; a right-click
   in a terminal, on the pane chrome, the tab strip and the statusline still
   opens the system menu (xterm's own arrangement, untouched).
8. Windows, owed to the user in their own window: the real home tree in the
   WebView2 host (dotfiles, `\\wsl.localhost` symlinks, a `node_modules`);
   creating a file and a folder from the row menu and from the panel-root menu;
   the Changes tab against this repository with a claude session editing files
   in it; and a file row opening a pane that says it cannot read the file yet.

Unverified by the Plan agent (needs a real browser or the user's window): how a
listing of several hundred rows scrolls in the 200–520 px panel; whether a
`realpath` of a `\\wsl.localhost` mount inside home ever resolves outside it
(WSL drvfs mounts live at `/mnt`, outside home, so the 403 branch is the
expected one and the row will say so); whether the 5 s Changes poll is felt on a
large repository (the cap and the timeout bound it, the interval is one
constant to change); the exact `git diff --numstat -z` rename form and the
`--porcelain=v1 -z` shape are stated from knowledge — Brief A pins them with
fixtures; whether `tests/fake-dom.ts` round-trips an `<input>`'s `value`,
`readOnly`, `select()` (Brief C may owe it one small addition).

## Orchestrator defaults (adopted 2026-09-16, not confirmed one by one)

- **One listing route taking an absolute path**, shaped like `/api/fs/list`,
  rather than a root id + relative path. Justified in §1a.
- **`/api/fs/list` and `/api/fs/mkdir` keep their current, boundary-free scope**;
  only the new routes are confined to home. Narrowing the picker would break
  Add-a-project and is a separate decision (§8 item 3 hands it to the reviewer).
- **Symlinks are followed and judged by their realpath**; one pointing out of
  home is shown but not enterable, and says so in the row.
- **Dotfiles, `node_modules` and `.git` are listed.** No hiding, no toggle.
- **1000 entries per folder, then a quiet "N more items are not shown here."**
- **No poll and no watcher for the Files tree** (expand + create + Refresh);
  **a 5 s poll for the Changes tab while it is the visible tab.**
- **Blur cancels the A9c name row**, it does not commit.
- **Hidden names are allowed** when creating.
- **The app's own data dir is listed but never written into.**
- **A session pane without a project becomes a drop target**, named by the last
  segment of its working directory. This softens A9 user decision 4, which was
  written as "the app may not show a path and cannot name the folder; B10 may
  fill it in when the backend can answer with a NAME" — B2 is where that name
  arrives, and HISTORY already names such sessions the same way.
- **The Files tab loses the `+N -N` numbers and the summary row to the Changes
  tab.** A browser does not know about commits.
- **`repoKnown()` becomes the real `isRepo` probe** for BOTH Changes and
  Commits, replacing A11's `!home` stopgap; a home folder that is a repository
  now offers both tabs.
- **The file pane says `The app cannot read this file yet.`** and drops the
  example-content line (§5).
- **The backend reaches the panel as an injected gateway**, not an import.

## Open decisions (the user's)

1. **What `Changes` means when the panel root is INSIDE a repository but is not
   its top level** (a project registered at `web/` in this repo): DECIDED
   2026-09-16 (user, the orchestrator's advice) — the WHOLE repository's
   changes, because that is what `git` answers and what the summary sentence
   "since the last commit" is about; the tab's header names the repository.
   Rejected: filtering to the panel root's subtree (an extra rule, and a count
   that no longer matches what git reports).
2. **Open decision 3 (the amber pulse) stays open.** Nothing sets `editing`, so
   the pulse never shows; the CSS hook and the `busy` field are kept untouched
   for whenever the source is chosen.
