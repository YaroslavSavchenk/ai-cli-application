# Plan B3 — Commits live: the real history, the real diff, Open on GitHub (Nocturne Track B)

Status: LANDED 2026-09-21 (`1096e81`; log `memory/log/2026-09/nocturne/2026-09-21-nocturne-b3.md`; verify-terminal V1–V8 PASS; three fixes from the user's Windows check the same night — `9afc0e5` a long message no longer fills the view, `3e1c9f8` the view closes with its session, `d505913` a UTC date spelled `Z` (CI red until then); user-verified on Windows 2026-09-21: "de feature werkt naar behoren"); earlier: STARTED 2026-09-21 (user: "continue werken aan de app"; next row in the status table; decisions asked the same day, before the developer started).
Parent: `.claude/plans/PLAN-NOCTURNE.md` part B3. A5 (2026-09-13) drew the
Commits tab on `MOCK_COMMITS`, A6 the commit view and the `Changes in <hash>`
diff tab on `syntheticDiff()`; B2 (2026-09-16) gave the panel a hardened git
runner (`server/git.ts`) and a real `isRepo` probe. B3 replaces the commits
half of `web/src/ui/files-mock.ts` with `git log` / `git show` through the
backend and makes `Open on GitHub` work. Runs through `/dev-flow` (lean rules
1–11); `security-auditor` mandatory on phase 1 (new git subcommands, a client
string reaching argv, a remote URL that may hold a credential);
`/verify-terminal` once at the end, scoped (the commit view hides and returns
the pane grid). Line numbers drift — verify by reading.

## User decisions (2026-09-21)

- **D1 the list = the last 10 commits, with `Show more`.** Each press loads 10
  more. A row says the message, the short hash, WHO committed it, the DATE
  (absolute, e.g. `20 Sep 2026`) and the relative time, and `+a -d` ("met
  datums en andere dingen en ook door wie dit gecommit is").
- **D2 `Open on GitHub` = github.com only.** `origin` on github.com (https and
  the two ssh spellings) → the commit's page in the user's browser through the
  ONE sanctioned exit. Any other remote, or none: the button is ABSENT (not
  disabled). Rejected: GitLab / Bitbucket with an `Open in browser` label.

## Orchestrator defaults (recorded 2026-09-21, not asked; each a cheap flip ⟲)

- ⟲ The history of `HEAD` (the current branch, or the detached commit), newest
  first, merges included; a merge's numbers and diff are against its FIRST
  parent (`--diff-merges=first-parent`).
- ⟲ Renames are shown as a delete plus an add (`--no-renames`): one path per
  row, as the v3 rows draw it.
- ⟲ The list header keeps v3's `main, 214 commits` — the total from
  `rev-list --count`. Detached head: `Detached, 214 commits`. Empty
  repository: the header shows the branch alone, the body `No commits yet.`
- ⟲ Author = the AUTHOR name. The commit view adds `Committed by <name>` only
  when the committer's name differs, the full date and time, and the message
  BODY under the title when there is one. No e-mail address anywhere, no
  avatar from the network (the initial, as A6).
- ⟲ Refresh: on tab open, on root change, and the 5 s poll of the Changes tab's
  rule (only while Commits is the visible tab and the panel is on screen,
  skipped while a request is in flight). The poll asks for page one; when its
  `head` equals the held one nothing changes, otherwise the list resets to
  page one. An open commit view is never refreshed (a commit is immutable).
- ⟲ Paging is pinned: every `Show more` sends `from=<the head of page one>`, so
  a commit landing mid-browse never shifts or duplicates a row.
- ⟲ The commit view opens with at most the FIRST 10 file blocks unfolded; the
  others are folded and their diff is fetched on unfold. One request per file.
- ⟲ Limits: 2000 files per commit (`truncated`, as Changes), 2000 diff lines
  per file (`This file's changes are too large to show.`), a line's text cut
  at 2000 characters, a binary file says `Binary file.` and draws no lines.
- ⟲ `Open file` opens the WORKING-TREE file (the editor is B4's); nothing
  checks that the path still exists — B4 owns that refusal.
- ⟲ An `origin` URL that carries a user name or a password still gives the
  button; the credential part is discarded by the parser and never leaves the
  server, a response, or a log line.

## Frozen protocol (`shared/protocol.ts`, written by the orchestrator in phase 0)

```ts
/** One row of GET /api/git/commits. Strings are control-stripped and capped by the server. */
export interface GitCommitSummary {
  hash: string;          // 40 hex — the identity
  shortHash: string;     // git's own %h
  subject: string;       // ≤ 500 chars
  author: string;        // author NAME, ≤ 200 chars
  authoredAt: string;    // ISO 8601, strict (%aI)
  add: number;           // text lines only; a binary file adds 0
  del: number;
  files: number;         // files changed
}
/** GET /api/git/commits?root=<abs>&limit=<1..50>&skip=<0..>&from=<40 hex, optional> */
export interface GitCommitsResponse {
  isRepo: boolean;
  branch: string | null;        // as GitChangesResponse.branch
  head: string | null;          // 40 hex; null on an empty repository / not a repo
  total: number;                // rev-list --count of `from` (or HEAD); 0 when head is null
  commits: GitCommitSummary[];
  more: boolean;                // at least one older commit exists past this page
}
export interface GitCommitFile { path: string; add: number | null; del: number | null } // null = binary
/** GET /api/git/commit?root=<abs>&hash=<40 hex> */
export interface GitCommitResponse {
  commit: GitCommitSummary;
  body: string;                 // message without the subject, ≤ 8 KiB, '' when none
  committer: string | null;     // committer NAME when it differs from the author, else null
  committedAt: string;          // ISO 8601 (%cI)
  parents: number;              // 0 root, 1 normal, ≥ 2 merge
  branch: string | null;
  github: { owner: string; repo: string } | null;   // D2; the page builds the URL
  files: GitCommitFile[];
  truncated: number;
}
export type GitDiffLineKind = 'add' | 'del' | 'ctx' | 'hunk';
export interface GitDiffLine { kind: GitDiffLineKind; oldNo: number | null; newNo: number | null; text: string }
/** GET /api/git/commit-diff?root=<abs>&hash=<40 hex>&path=<repo-relative> */
export interface GitCommitDiffResponse { binary: boolean; tooLarge: boolean; lines: GitDiffLine[] }
```

Client (`web/src/api.ts`, phase 0): `gitCommits(root, limit, skip, from?)`,
`gitCommit(root, hash)`, `gitCommitDiff(root, hash, path)` — same `request<T>`
shape as `gitChanges`.

## Phase 1 — backend (`backend-pty`)

Files: `server/git.ts` (or a sibling `server/git-log.ts` importing the runner —
export `runGitCapture` / `capturedOrFail` / `GIT_ENV` rather than copying
them), `server/api.ts` (three GET routes beside `/api/git/changes`),
`server/github.ts` (remote parser beside `parseGithubRepoPath`),
`tests/server/git-commits.test.ts` (new), README/route docs where `/api/git/changes`
is listed.

1. **Boundary, identical to `changesFor`:** `root` through
   `resolveUnderAllowed(root, { projects, gone: FS_LIST_GONE, denied:
   FS_NO_READ_PERMISSION })`, `isExistingDirectory`, git runs with `cwd` = the
   resolved root. 405 for a non-GET; 400 `FS_PATH_BAD` on a missing `root`.
   Not a repository → `/commits` answers 200 `{ isRepo:false, … empty }`;
   `/commit` and `/commit-diff` answer 404 `This commit is no longer there.`
2. **Every client string is gated BEFORE argv.** `hash` and `from`:
   `^[0-9a-f]{40}$`, else 400 `The app cannot open that commit.`; then
   `rev-parse --verify --quiet <hash>^{commit}` must exit 0, else 404. `limit`
   integer 1..50 (default 10), `skip` integer 0..1 000 000, else 400. `path`:
   non-empty, ≤ 4096 bytes, no NUL, not absolute, no empty / `.` / `..`
   segment, else 400 `FS_PATH_BAD`; it reaches git ONLY after `--` and with
   `GIT_LITERAL_PATHSPECS=1` in the env (no glob, no `:(magic)`). git reads the
   OBJECT store for these calls, never the working tree, so no file outside
   the repository can be read through `path`.
3. **Nothing in the repository's config may run code or change the output.**
   On every `log` / `show` / `diff-tree`: `--no-show-signature` (a repo-local
   `log.showSignature` would spawn gpg), `--no-ext-diff`, `--no-textconv`
   (repo-local `diff.<driver>.textconv` / `diff.external` EXECUTE a program —
   prove it with a test like the fsmonitor one), `--no-color`, `--no-renames`,
   `--diff-merges=first-parent`, `--no-notes`, plus `LC_ALL=C` and
   `GIT_LITERAL_PATHSPECS=1` added to `GIT_ENV`. The developer MEASURES each
   against git 2.43.0 and records what was measured in the module comment.
4. **Parsing:** records are NUL / `%x01` framed (`-z`, a `--format` that starts
   each record with `%x01`), never line-split on text a commit message could
   contain. Pure exported parsers with fixtures: `parseLogRecords`,
   `parseUnifiedDiff` (hunk header → `oldNo` / `newNo`; `\ No newline at end of
   file` is a `ctx` row with both numbers null; stop at 2000 lines →
   `tooLarge`), `parseGithubRemote(url): { owner, repo } | null` (https,
   `git@github.com:o/r(.git)`, `ssh://git@github.com/o/r(.git)`; host exactly
   `github.com`, no port other than none; owner / repo `^[A-Za-z0-9._-]{1,100}$`,
   never `.` or `..`; userinfo discarded). The remote is read with
   `config --get remote.origin.url`; a failure is `github: null`, never an error.
5. **Strings out:** subject / author / committer / body / diff text have C0 +
   C1 + U+2028/9 stripped (body and nothing else keeps `\n`), then the caps
   above. Invalid UTF-8 arrives as U+FFFD — fine.
6. **Logging:** one line per request, counts only — `GET /api/git/commits ->
   200, repo=true, 10 commits, more`; `GET /api/git/commit -> 200, 7 files`;
   `GET /api/git/commit-diff -> 200, 148 lines` (or `binary` / `too large`).
   Never a hash, a path, a subject, an author, the remote URL; the debug trace
   line keeps `${sub} ${code}`. 5xx = class + frames (`errorClass` /
   `errorFrames`). Same access-log demotion as `/api/git/changes`.
7. **Sentences (constant, one each):** 400 `The app cannot open that commit.`,
   404 `This commit is no longer there.`, 500 `GIT_READ_FAILED`; the folder
   sentences are the existing ones.
8. Tests (`tests/server/git-commits.test.ts`, real fixture repositories as
   `tests/server/git-changes.test.ts`): paging + `more` + pinned `from`; total; empty
   repository; detached head; merge against first parent; root commit; binary
   file; rename as delete + add; a subject / author with control characters,
   NUL-adjacent framing bytes and `%x01`; hash gate (short, upper-case,
   leading `-`, a TREE's hash → 404); path gate (`..`, absolute, `:(glob)*`,
   `*.ts` matches literally); textconv / ext-diff / showSignature NOT executed
   (marker-file proof); remote with a token in it → owner / repo out, the
   token in no response and no log line; boundary / 405 / token; one log line
   without names; stdout flood and hang still killed for the new subcommands.

### Phase 1 amendments (2026-09-21, after the scope + security review; they win over the items above)

- **cwd.** After the `rev-parse --show-toplevel` probe every later call runs in
  the REPOSITORY ROOT, so `--numstat` paths and the `path` pathspec are the
  same string. That root is whatever git reports — usually an ancestor of the
  boundary-passed folder, but `core.worktree`, a `.git` gitfile or
  `objects/info/alternates` can point it anywhere the user can read. It is
  never returned and never logged. KNOWN LIMIT, recorded (same reach as B2's
  decision 1, "the tab is about the WHOLE repository"): `path` is resolved
  against that root, so the object store of the whole repository is readable
  through `/api/git/commit-diff`, tracked files ABOVE a project anchor
  included. A token holder can already spawn a shell; the boundary adds no
  privilege here.
- **No lazy fetch (security MUST-FIX, also B2's shipped Changes tab).**
  `GIT_NO_LAZY_FETCH=1` joins the shared `GIT_ENV`: a repository configured as
  a partial clone (`extensions.partialClone`, `remote.<n>.promisor`,
  `remote.<n>.uploadpack` or `core.sshCommand`) with one missing object made
  `log --numstat`, the `rev-parse` hash gate and B2's `diff --numstat` RUN the
  configured program (measured, git 2.43.0). Residual: a git older than the
  CVE-2024-32004 backport ignores the variable.
- **`git log -1 --no-walk`, never a walking `log -1 … -- <path>`.** With a
  pathspec, history simplification answers with the nearest ANCESTOR that
  touched the path — another commit's diff under the requested hash
  (measured). `git show` was not used because it implies `-p`.
- Flags also pinned: `--encoding=UTF-8` (`i18n.logOutputEncoding` re-encodes
  `%s`), `--unified=3` on the patch call, `-O/dev/null` (`diff.orderFile`
  naming a missing file exits 128).
- Framing: `%x01` starts a record, `%x00` separates the fields — git truncates
  `%s` / `%b` at a NUL, so no field can hold the separator.
- `from=`, `limit=`, `skip=` present but EMPTY count as absent. A bad `limit`
  or `skip` answers the 400 commit sentence (one 400 sentence exists).
- `GitCommitFile.path` is git's verbatim bytes — NOT stripped, NOT capped — so
  it round-trips as a pathspec; the page renders it through `textContent`.
  `authoredAt` / `committedAt` are `''` when git's value fails the strict ISO
  check. `shortHash` follows `core.abbrev` (1–40 hex). An empty repository
  answers `branch: "main"` with `head: null` — the page keys `No commits
  yet.` off `head`.
- `parseGithubRemote` also accepts the scp form without a user
  (`github.com:o/r`); the host compare is case-insensitive.
- `rev-list --count` timing out degrades `total` to a floor (rows kept), not a 500.
- The numstat pre-check bounds a diff's LINES; a file of few enormous lines
  still ends at the 2 MiB cap with the constant 500.
- No README or docs file lists routes; the scope doc's Files-panel bullet is
  the route list and the landing updates it.

## Phase 2 — frontend (`terminal-ui`, `/frontend-designer` applies)

Files: `web/src/ui/files.ts` (Commits tab), `web/src/ui/commit-view.ts`,
`web/src/ui/commit-model.ts`, `web/src/ui/files-model.ts`,
`web/src/ui/file-pane.ts` (diff tab body), `web/src/ui/files-mock.ts`
(commits half DELETED; B4's half stays), `web/src/ui/releases.ts` (or a small
shared `open-external.ts`), `web/src/main.ts` (gateway wiring),
`web/src/styles/{tokens,app}.css`, the tests under § 6 of the seam map below.

1. **Gateway, injected** like `FsGateway.changes`: `commits(root, limit, skip,
   from?)`, `commit(root, hash)`, `commitDiff(root, hash, path)`. No `api.ts`
   import inside `files.ts` / `commit-view.ts`.
2. **Commits tab:** header `commitsHeaderText(branch, total)`; rows per D1
   (subject, short hash, author, absolute date, relative time, `+a -d`; the
   layout at 200 px and at 520 px is the designer's, no decorative separators
   in text, plural forms); a quiet `Show more` row while `more`; states
   `Loading…`, `No commits yet.`, the server's sentence verbatim in danger
   ink, `UNREACHABLE_TEXT`. The A11 probe (`repoKnown()`) is untouched. The
   honesty line `Example data until the panel reads your commits.` is DELETED.
   `state.openCommit` holds the 40-hex hash; `data-k=commit:<hash>`.
3. **Commit view:** title, body (when any, pre-wrapped, plain glyphs), avatar
   initial, `committed <relative>` with the full date and time, `Committed by`
   (default above), branch chip (omitted on a detached head), short-hash chip,
   totals + five-block bar from the REAL numbers, file blocks with `Open
   file` / `Changes`; first 10 unfolded, the rest fetch on unfold; per-block
   `Loading…`, `Binary file.`, `This file's changes are too large to show.`,
   the server's sentence. `truncated > 0` → one row `N more files are not
   shown.` The honesty line `Example commit until the view reads your
   repository.` is DELETED. A view whose commit answers 404 keeps its exit
   (`Back to sessions`, Esc) — A6's rule for an unresolvable screen.
4. **Diff lines:** `DiffLine.n` → `oldNo` / `newNo`, two gutters, `hunk` rows
   in the quiet ink, `--diff-gut-w` widened (token only). Text through
   `textContent`, never markup. No ligatures (A6).
5. **`Open on GitHub` (D2):** rendered only when `github !== null`; a
   `<button>` (never an `<a href>` — the host drops those) whose click calls
   the ONE exit: `window.open('https://github.com/' + owner + '/' + repo +
   '/commit/' + hash, '_blank', 'noopener,noreferrer')`. The page re-checks
   owner / repo / hash against the same patterns before building the URL.
   Browser log line: the action's SHAPE (`open commit on github`), no URL.
6. **`Changes in <short hash>` tabs** read `commitDiff`; the tab label uses the
   short hash, the tab's identity the full one. Editor slots are not
   persisted (B4), so no migration.
7. **Mock removal:** `MOCK_COMMITS`, `MOCK_BRANCH`, `mockCommitByHash`,
   `counted`, `withCounts` go; `syntheticDiff` goes unless B4's half still
   needs it (then it stays, unexported to commits code). Tests that imported
   `MOCK_COMMITS` get a fixture in `tests/` fed through the gateway double;
   the "numbers counted from drawn rows" pin becomes "the header states the
   server's numbers and every fetched block draws exactly its `lines`".
   `memory/BACKLOG.md`'s mock-module item narrows to B4.

### Phase 2 amendments (2026-09-21, after the scope + security review; they win over the items above)

- Files also touched: `web/src/ui/commit-store.ts` (NEW — the open commit,
  once: injected gateway, generation guard, one diff ask per path),
  `web/src/ui/open-external.ts` (NEW — the ONE `window.open` B3 owns: exact
  `https:`, no credentials, `parsed.href === url`; `releases.ts` routes through
  it; the older OSC 8 exit in `terminal.ts` is untouched), `web/src/ui/fs-model.ts`
  (`UNREACHABLE_TEXT` / `messageOf` / `isSentence` moved there),
  `web/src/ui/slots-model.ts`, `web/src/ui/editor-pane.ts`, `web/src/state.ts`.
- The row is THREE lines: the subject; short hash, author, `+a -d`; the
  absolute date plus the relative time (full date and time as its title). At
  200 px a one-line meta row would clip its numbers; the row clips itself, so
  nothing in it can widen the panel.
- `state.openCommitAt { root, repoRoot }` is captured when a commit opens:
  `root` = the folder the panel asks git with (what every request sends),
  `repoRoot` = the repository the paths are relative to (from the Changes
  answer; `Open file` joins onto it). A diff tab carries the REQUEST root
  (`openDiff`'s 4th argument), never the repository root. A commit row is never
  a silent dead click while the Changes answer is still out.
- Refresh: ONE interval is shared with the Changes tab and dispatches on the
  tab that is visible when it fires. A poll answering `isRepo:false` holds an
  empty answer and draws nothing; the Changes probe is what moves the tab.
- The first ten blocks ask for their diff in parallel (ten requests, at most
  forty git spawns); a 2000-file commit is still ten requests. A failed diff
  is not retried while the view is open.
- `--diff-gut-w` is now the WHOLE gutter (88 px); one number column is
  `calc(var(--diff-gut-w) / 2)`. The token is not in the v3 handoff sheet, so
  the parity test is unaffected.
- `syntheticDiff`, `pathSeed` and `NO_EXAMPLE_CONTENT` (its only other reader)
  went with the mock; B4's half is `mockFileContent` / `saveMockFile` plus
  `file-pane.ts`'s own two sentences.
- Repository-controlled paths are drawn with `unicode-bidi: isolate` and
  `direction: ltr` (a right-to-left override in a file name cannot disguise
  which file a diff belongs to). Recorded, not fixed: two hostile paths can
  collide on `blockDomId` (an `aria-controls` link only — every action acts on
  the raw hash + path); in-flight requests are dropped by generation, not aborted.

## Gates

- Phase 0 (orchestrator): protocol + client functions, `npm run typecheck`.
- Phases 1 and 2 run in PARALLEL (disjoint files). Per phase: readers (scope
  always; security on phase 1, and on phase 2 for the `window.open` exit only)
  → ONE fix round → test gate (phase 1 = FULL mutation probe, hard
  constraint: argument handling and spawning; phase 2 ≤ ~10 mutants).
- Final: full suite once by the orchestrator, `/verify-terminal` scoped to
  "open a commit with two live panes, return, panes unchanged (cols/rows, no
  resize sent while hidden)", janitor, the Windows checklist for the user
  (`Open on GitHub` opens the default browser from the host window; the list
  at 200 px and 520 px; `Show more`; a merge commit; a binary file).
- Landing: this Status line, the table row, the README index line, the scope
  doc's Files-panel and Commit-view bullets, the vault log entry + decision
  note, commit + push.
