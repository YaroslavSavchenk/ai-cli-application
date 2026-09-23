---
type: decision
created: 2026-09-20
updated: 2026-09-23
tags: [nocturne, files, drop, upload, clipboard, host, security]
---
# B10: real file copy into WSL + copy-to-clipboard via the host

**Status:** decided 2026-09-20 (user; all three the orchestrator's advice).
Asked before the developer briefs (lean rule 6), while the Plan agent
designed on the same assumptions. Part B10 of `.claude/plans/PLAN-NOCTURNE.md`
(A9 = the visual half with a mock transport, landed 2026-09-15; A9b's
context-menu `Copy` / `Paste` inert until here). Spec `.claude/plans/nocturne/PLAN-B10.md`.

## 1. Scope — both halves, the host last
B10 = (a) the real upload for a drop, a paste with files on the clipboard
and `Copy files here…` (one pipeline), AND (b) `Copy` from the app's file
system to the Windows clipboard through the native host
(`Clipboard.SetFileDropList` with `\\wsl.localhost\<distro>\…`, reached by a
web message; Edge fallback = at most the path as text). The host half is its
own LAST phase (`wsl-launcher`; needs the user's Windows build and check),
and only then do the A9b menu entries go live. No dragging OUT of the app
(unchanged 2026-09-15 decision).
- Rejected: upload only now (the menu's Copy would stay a dead entry for
  another part).

## 2. Folder conflicts — one choice per drop, Replace = merge
`Replace`: an existing folder is merged, same-named files inside are
overwritten. `Keep both`: the whole folder lands under the Explorer name
(`web (2)`). `Skip`: the whole folder is skipped. Files: overwrite /
`keepBothName` / skip. Closest to Explorer while keeping ONE dialog per
drop (decision of 2026-09-15).
- Rejected: Replace = empty the folder first (destroys files the user never
  dragged).

## 3. Limits per drop
50 MiB per file and 200 top-level items (A9) stay; NEW: 2000 files and
1 GiB per drop, counted over the recursive walk done BEFORE the conflict
question. Over any limit = the drop is refused up front with one sentence;
nothing partial.
- Rejected: 10000 files / 4 GiB (browser memory with thousands of `File`
  objects); no recursive limit (a `node_modules` drop runs for minutes).

## 4. Hide during a copy + a quiet client log (user, 2026-09-20, scope review of phase 2)
A 2000-file drop can hold the aria-modal card for minutes; A9's inert
Esc/×/backdrop were harmless on a 60 ms mock. Decided: `Esc` / `×` / backdrop
HIDE the card, the copy runs on (the restart dialog's `Hide` precedent); the
result then arrives as one statusline flash (`Copied 37 files into src. 2
failed.`); a new drop during a run is refused (`A copy is still running.`).
Still no cancel. And: a successful per-file upload is NOT logged in the
browser log (200-line buffer, 200/min server budget — a 500-file drop would
blind the log for a minute); refusals and the one `drop: …` summary line stay.
- Rejected: keep blocking (a running Claude session untouchable for minutes);
  log every call (the scope rule, bent for this one route like the server's
  quiet list).

## Orchestrator defaults (recorded, not asked)
Progress counts write units (files + empty folders), not rows — `137 of
2000`, never `0 of 1` for one dragged folder. Rejections in hooks never wedge
the card.
Partial failure inside a folder: the folder stays one row — `Copied`, or
`Failed` with the note `N of M files failed`; what copied stays.

Related: [[localhost-security-model]], [[b5-tools-keys-and-shells]] (the
0600 / boundary precedents), [[2026-09-15-nocturne-a9]],
[[2026-09-16-nocturne-a9b]].

## From the scope doc (moved 2026-09-23)

Verbatim wording of the `.claude/PROJECT-SCOPE.md` bullet before part O1 condensed it; the scope doc holds the current rule.

### Features (decided) — Files panel

- **Files panel** (Nocturne A5, landed 2026-09-13; visual, mocked until
  B2/B3): a third middle-row column left of the pane grid (after the
  Projects drawer), flex sibling like the drawers so opening or dragging it
  refits every pane through the one fit → ws resize seam. Tabs Files
  (summary row, tree with folder icons and a real icon per file type —
  since B12, 2026-09-22: language logos from Simple Icons, category glyphs
  from Phosphor, coloured by `--badge-<kind>-fg`; the same B12 put the real
  Claude / Codex / Gemini / Grok marks, one uniform single-colour style from
  LobeHub, on the New session and Settings tiles, the tab strip, the pane
  header, the Sessions rows and the agents table header; inline SVG path
  data, no icon package — per-file
  +/-, amber pulse on files being edited and their ancestor folders) and
  Commits (message, hash, author, relative time, +/-; DISABLED with the
  title "No repository at Home" while the header reads `Home`, the panel
  falling back to Files — user decision 2026-09-15, part A11; since B2 the
  rule is a real probe of the panel's root, a project-less session's folder
  included; LIVE since B3, 2026-09-21 — the commits bullet below);
  header shows the
  focused session's project name (its title when it has no project); when
  the focused pane is a file or diff, the tab's root folder (since A10);
  when the focused session has exited, the first session still alive
  anywhere; `Home` when nothing is alive. Resizable 200–520 px by its right edge (pointer, arrow keys,
  home/enter/double-click resets to 300). Shown whenever the wish is on
  and the Projects drawer is closed — a session is NOT a condition (user
  decision 2026-09-15, deviates from v3's `alive.length > 0`: the panel is
  up from the first paint, "you always start at home"). Only ONE left
  panel at a time (user decision 2026-09-15, deviates from v3): the Files
  toggle closes the Projects drawer when it opens, the Projects drawer
  HIDES Files while it is open without touching the wish (Files returns
  when it closes), and pressing Files while hidden behind Projects closes
  Projects and shows Files. Esc closes it only when focus is inside it and
  hands the keyboard back to the terminal (with no terminal, to a visible
  control, never `<body>`); since A9b a first Esc clears a folder
  selection instead, the next one closes. It is NOT a keyboard owner: an open Files panel
  never blocks the window-activation refocus of the terminal
  (`OPEN_FOCUS_OWNER_SELECTOR` excludes it). Until B2 (Files, Changes) and B3 (Commits) landed, each tab
  carried one quiet "Example data until the panel reads your …" line; both
  are gone — every tab reads the real folder and the real repository. **B2 + A9c (started 2026-09-16, `.claude/plans/nocturne/PLAN-B2.md`)**
  turn the panel into a REAL file browser (root = the user's home, or the
  focused session's project root — with NOTHING focused the root is home,
  user decision 2026-09-16, replacing A5's "first live session anywhere"
  header rule for the panel; lazy per-folder listings, no poll; the
  git changes become a `Changes` tab fed by `git diff --numstat` +
  `git status --porcelain -z`, polled every 5 s only while that tab is
  visible; `Commits` is live since B3, 2026-09-21) and give the row menu `New file`
  / `New folder` / `Refresh` (inline name row at the child indent, Enter
  creates for real, Escape or blur cancels, the refusal is a second row in
  danger ink) plus a panel-ROOT menu (Copy files here…, New file, New
  folder, Refresh) on a right-click of the tree's background or the menu
  chord with the focus in the panel — Files tab only. Backend (landed with
  Brief A): `GET /api/fs/entries`, `POST /api/fs/create`, since B10
  `PUT /api/fs/upload` and `GET /api/fs/winpath` (the upload bullet below),
  since B10a `POST /api/fs/delete` (the delete bullet below), since B13
  `POST /api/fs/rename` (the rename bullet below), since B4
  `GET /api/fs/read` and `PUT /api/fs/write` (the editor bullet below),
  `GET /api/git/changes`, all token-gated, all confined to a realpath
  boundary = the user's HOME or any REGISTERED project's path — a registered
  project is the user's own choice and anchors its WHOLE subtree, no floor
  (a project at `/` anchors only `/` itself, since containment is
  `anchor + sep`); the picker's `/api/fs/list` + `/api/fs/mkdir` stay
  machine-wide on purpose (user decision 2026-09-16), constant error sentences, counts-not-names in
  `server.log`, git via argv only with `core.fsmonitor` off,
  `GIT_OPTIONAL_LOCKS=0`, and since B3 `GIT_NO_LAZY_FETCH=1`,
  `GIT_LITERAL_PATHSPECS=1` and `LC_ALL=C` in the one shared environment,
  stdout capped and a 5 s kill. Test seam
  `AI_SM_HOME_OVERRIDE` (absolute, normalized, never root, existing dir;
  refused at boot with a `server.log` line; never inherited by PTYs)
  moves that home for route tests only. Since A9 (2026-09-15) the panel and
  the pane area are DROP TARGETS for files and folders dragged from Windows
  Explorer: a folder row (its own name), the panel's non-folder area (the
  panel's root), a pane (a terminal pane: its session's project, else the
  tab's root folder, else not a target with "This session has no project
  folder yet."; a file or diff pane: the tab's root folder, else the tab's
  first session's project, else "This tab has no project folder yet." —
  the same order the Files header uses, so one screen never names two
  folders), or the empty pane area of an empty tab. The destination is
  always a NAME, never a path; a cursor-following ghost says "Copy N items
  into <name>" (or "Copy files into <name>" when the browser states no
  count) or "Drop on a folder or a pane."; a window-level guard cancels
  file drops from the first line of boot, so a stray drop can never
  navigate the app away; nothing
  changes layout during a drag (outlines and the pane overlay only). After
  the drop one dialog per drop: conflicts Explorer-style (Skip · Replace ·
  Keep both, the choice covers every conflict of that drop, Esc = Skip),
  then per-item Copied / Skipped / Failed rows, then one result sentence.
  **Transport is REAL since Nocturne B10 (2026-09-20, spec
  `.claude/plans/nocturne/PLAN-B10.md`, rationale `memory/decisions/b10-file-copy-and-clipboard.md`):**
  the client walks dropped folders first (`readEntries` loop, depth ≤ 64),
  refuses a drop up front over 200 top-level items, 2000 files or 1 GiB
  (user's limits; one sentence, nothing partial), asks the ONE conflict
  question against the real listing (folder Replace = merge, Keep both =
  `web (2)`, Skip = the whole folder), then uploads one file at a time with
  `PUT /api/fs/upload` (raw body, `mode=replace|new`, empty folders through
  `POST /api/fs/create`); a single file over 50 MiB is that row's `Failed`
  (server-enforced 413). Rows settle from real responses, progress counts
  files; Esc / × / backdrop HIDE the card while the copy runs on and the
  result then arrives as one statusline flash (user, 2026-09-20; no cancel);
  a new drop during a run is refused (`A copy is still running.`). The panel
  re-reads the destination once after the whole drop. Successful per-file
  uploads are not logged in the browser log (one `drop: N files, X MB, F
  failed` line is the record; user 2026-09-20). The keyboard/button twin is the
  permanent copy strip under the panel header (native file chooser; it
  reads "Copy files here…", or "Copy files into <folder>…" once a row is
  selected — the ANCHOR row's own folder, or a selected FILE's parent),
  Ctrl+Alt+C on a focused folder row (the picker for that folder), and
  pasting with files on the clipboard; all use the same destination rule as
  the drag (the selection's destination first — A9b, 2026-09-16: one click
  on a folder row selects it and toggles it, the selection stays visible
  after the focus leaves the panel, Escape inside the panel or hiding the
  panel clears it; **since B10a (2026-09-20, spec `.claude/plans/nocturne/PLAN-B10a.md`) the
  selection is MANY rows, files included**, Explorer-style: ctrl+click
  toggles, shift+click ranges over the visible rows, ctrl+a takes every
  visible row, ↑/↓ move focus, shift+↑/↓ extend, ctrl+↑/↓ move focus only,
  ctrl+space / ctrl+enter toggle the focused row, the last-touched row is
  the ANCHOR — then the focused folder row, else the panel root, else the
  active tab's root). A right-click on a row (or the
  ContextMenu key / Shift+F10 on the focused row) opens a Nocturne context
  menu — a new primitive, `ui/context-menu.ts`, not a modal: folder rows
  offer Open or Close, Copy, Paste, Copy files here…, since A9c
  (2026-09-16) New file, New folder, Refresh, and since B10a — behind the
  menu's ONE hairline, in danger ink, the only entry that cannot be taken
  back — Delete; file rows Open, Open beside, Copy, ──, Delete; since B13
  (2026-09-22) `Rename` sits directly above that hairline on a single
  file row and on a single folder row that is no anchor and holds no
  project (F2 on the focused row = the same; an inline name row, the stem
  pre-selected; open editor tabs follow the rename with their unsaved text). An ANCHOR
  row (the panel root, the home folder, a registered project root) has NO
  Delete at all, not a disabled one. `Copy` and `Delete` act on the whole
  selection when the clicked row is in it, else on that row (Explorer's
  rule); the menu's accessible label then reads `actions for 3 selected
  items`. Since B10 (2026-09-20) `Copy` is LIVE inside the native
  host window only: the backend maps the row's path to its Windows form
  (`GET /api/fs/winpath`, behind the same home/project boundary; `/mnt/<d>`
  → `D:\…`, else `\\wsl.localhost\<distro>\…`), the page posts one
  string `copy-files\n<path>…` through `chrome.webview.postMessage`, and
  the host (origin-locked, shape-checked, `Clipboard.SetFileDropList`, a
  count in `host.log` and never a path) answers `copy-files ok <n>` /
  `copy-files failed`; in the Edge `--app` fallback the entry stays disabled
  with `This window cannot put files on the clipboard.` `Paste` stays
  disabled for good (a page sees files only inside a real paste event, and
  copying the host's clipboard files would need a read-anywhere primitive
  this app refuses to have; user's decision 2026-09-20) — the keyboard paste
  is the door. A right-click
  selects a row (folder or file) without toggling it, and leaves a
  selection alone when the row is already in it. Right-clicks anywhere else —
  a terminal above all — are never touched, so the system menu (xterm's
  own copy/paste arrangement) stays. Sessions panel
  (right, 300 px) restyled in the same part: "Running now" / "Earlier",
  "Side by side", "Continue" / "Start again", armed "End" / "Forget".
  Since Nocturne A6 (2026-09-13) the commit rows and the tree's file rows
  are live: a commit opens the commit view, a file opens a tab in the
  editor pane of its root folder's tab (A10 replaced the A6 editor column,
  A10b brought the file tabs back inside the pane).
