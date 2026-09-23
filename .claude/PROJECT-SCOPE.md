# Project Scope — AI CLI Session Manager

Single source of truth for what this project is and the decisions already made.
Skills and agents reference this file instead of duplicating it. Update it when
a decision changes; never let it silently drift from reality.

## What we are building

A GUI to run and manage multiple AI CLI sessions (Claude Code first; Codex,
Gemini CLI and Grok live since Nocturne B5, 2026-09-20) side by side — and, since 2026-09-08 (user's
call, "alles moet mogelijk"), plain terminal sessions (WSL shell or
PowerShell) next to them. Each session is a real interactive terminal
running inside WSL; the GUI adds project management, launch presets, and
multi-pane layouts on top.

## Architecture (decided)

Each bullet is the current rule. Dated history, rejected alternatives and the
full pre-2026-09-23 wording of every condensed bullet live in the note named
at its end (`## From the scope doc (moved 2026-09-23)`).

- **Web app running inside WSL.** A Node.js backend runs in WSL2 (Ubuntu). It
  spawns each session in a real pseudo-terminal via **node-pty**, streams I/O
  over **WebSocket**, and serves the frontend over HTTP.
- **Frontend: vanilla TypeScript + Vite** — no UI framework (decided
  2026-07-18). Terminal rendering via **xterm.js**, one instance per visible
  pane. WebGL renderer, fit addon for sizing, bounded scrollback.
- **Sessions are first-class server-side objects.** The PTY and its state live
  in the backend; the browser is only a view. Sessions keep running when their
  pane is hidden; reopening a window reattaches with scrollback replayed.
- **Backend starts detached** from the launcher process (setsid), started on
  demand — it must never die with the launcher console. **Lifetime: bound to
  UI presence** (user's call 2026-07-19): the presence WebSocket
  `/ws/presence` counts open windows; when the last closes, a 30 s grace
  (`AI_SM_GRACE_MS`) lets reloads reattach, then the backend ends all
  sessions, removes runtime.json and exits; a 120 s startup grace
  (`AI_SM_STARTUP_GRACE_MS`) runs until the first-ever presence. Manual
  `-Stop` overrides. The presence channel answers `ping`/`pong` (inbound
  frames ≤ 1 KiB, no lifecycle effect). Authed `GET /api/runtime` body is
  exactly `{ startedAt, serverCommit, version, installed, webBuild, update }`.
  History: `memory/decisions/lifecycle-bound-backend.md`.
- **Session history with real per-conversation resume** (user's call
  2026-09-06). Every launched session is kept in `history.json` (data dir,
  0600, atomic, ≤ 200 entries, oldest ENDED entries drop first, live ones
  never). A claude-kind session (`isClaudeCommand(command)`, `shared/protocol-settings.ts`:
  the command's last `/` or `\` segment is exactly `claude`) whose
  client args carry no `--continue`/`-c`/`--resume`/`-r`/`--session-id` gets
  an injected `--session-id <app session uuid>` (PTY argv only — never in
  `SessionInfo.args`); `POST /api/history/:id/resume` spawns `claude <base
  args> --resume <id>`. End reasons: user-kill, exit, shutdown, crash
  (stamped at boot). A conversation is pruned only when its projects folder
  exists and `<id>.jsonl` is missing — every uncertainty keeps it. Needs
  Claude Code ≥ 2.1.263; no version probe. Known limit: a `--continue`
  launch cannot be pinned (resumes with `--continue`, button "start again").
  A client-supplied `--session-id`/`--resume <uuid>` is adopted as the key.
  A blank session name makes the title the project name (the Launch Name
  placeholder is the selected project's name).
  History: `memory/decisions/session-history-resume.md`.
- **Logging: everything, by default** (user's call 2026-09-06). `server.log`
  is the backend's ONLY diagnostic channel; `<ISO> [level] [component]
  message`, levels `debug|info|warn|error`, `AI_SM_LOG_LEVEL` (default
  `debug`). **Never written:** the app
  token, the GitHub token, stored API keys, request/response bodies,
  `Authorization`, query-string values, PTY bytes (terminal I/O is byte
  COUNTS, ≤ 1 line/s/session), error MESSAGES of request failures (class +
  frames only). The browser logs through `POST /api/client-log` (authed;
  body ≤ 64 KiB → 413, ≤ 50 entries, message ≤ 2048 chars truncated,
  lines one-lined, 200 entries/min); UI actions are logged as SHAPE, never
  raw custom command text. Lines for requests without a valid token share
  ONE 60 lines/min budget (one limiter for HTTP and WS); a token-bearing
  request is never metered. Rotation 10 MiB → `.1` → `.2` (≤ 30 MiB total,
  0600; a failed rename truncates). 0600 is hygiene only — "never write the
  secret" is the control. `launcher/run-update.ps1` stdout is piped in
  (≤ 64 KiB). History: `memory/decisions/scope-history.md`
  § Architecture — Logging.
- **Manual backend restart + "new version" notice; preflight first.**
  `GET /api/runtime.update = { available, reason }` (cached ≤ 5 s, UI polls
  30 s; raw reasons never reach UI copy; installed mode has the one reason
  `a new version is installed`). `POST /api/restart` runs a preflight while
  the old backend is fully intact: dependency check (the app NEVER runs
  `npm install`), frontend build into `web/dist-next` (installed mode:
  verify the target bundle instead), then a **standby child**
  (`AI_SM_STANDBY=1`, messages-only IPC) that boots, binds nothing, reports
  `standby-ready`. Any refusal = **`422 { error }`, old backend and
  `web/dist` untouched** — the two logged exceptions: a restore whose own
  rename fails, and a `dist-prev` that vanished under the app. Then: swap dist, end sessions like `shutdown()`
  (history keeps them), close the listener, `go`, wait for the child's
  `runtime.json` + `/health`, `202 { port, startedAt, samePort }`, exit
  without unlinking `runtime.json`. **Same port is a hard constraint** (the
  WebView2 host locks the exact origin); the child falls back once to
  auto-pick (`samePort: false`). Sessions do NOT survive a restart. A
  failed handoff after teardown is `500` + exit, not a rollback. `409` while
  in flight or while an update installs; `503` with no runner. Seams:
  `AI_SM_PORT_HINT`, `AI_SM_RESTARTED_FROM`, `AI_SM_STANDBY`,
  `AI_SM_WEB_DIST_DIR` (absolute, normalized, never root; a bad value is
  refused with a `server.log` line); PTYs inherit none of them (nor
  `AI_SM_HOME_OVERRIDE`). UI: Settings → Background service
  `Restart service`, toast + amber `Update` pill; the dialog can be hidden
  during the preflight, locked during reconnect. A page whose token is
  rejected without having asked for a restart probes `/health` for 5 s and
  reloads once on the same origin; only silence shows the reload panel.
  Code: `server/restart.ts`, `server/index-restart.ts`. History:
  `memory/decisions/backend-restart-same-port.md`,
  `memory/decisions/restart-preflight-standby.md`.
- **Port: the last one first, auto-pick as the fallback** (amended
  2026-09-22, B6 decision 5 — the tab layout in localStorage is tied to the
  origin incl. port). `<dataDir>/last-port.json` (0600, atomic, integer
  1024–65535, opened `O_NOFOLLOW|O_NONBLOCK`, `fstat` first) is tried first
  through the restart hint path (`AI_SM_PORT_HINT` beats it); a busy port
  falls back to an OS-assigned one WITHOUT overwriting the remembered port.
  Binds `127.0.0.1`; publishes `~/.ai-session-manager/runtime.json` (port,
  auth token, pid, startedAt, `appDir`; user-only readable) that the
  launcher reads via `wsl.exe cat`. No fixed port anywhere. Code:
  `server/last-port.ts`. History: `memory/decisions/scope-history.md`
  § Architecture — Port.
- **Windows-side launcher** (thin): reads the discovery file,
  health-checks, else starts the backend via `wsl.exe -d <distro> -- ...`,
  waits for file + health, opens the UI. Distro and repo path precedence:
  `AI_SM_DISTRO`/`AI_SM_REPO_PATH` → `launcher-config.json` beside the
  scripts (corrupt = ERROR) → derived from `$PSScriptRoot`
  (`\\wsl.localhost\<distro>\<path>\launcher`) → EMPTY defaults (nothing
  resolvable = a message, never someone else's repo). One allow-list in
  `launcher/config-common.ps1` (`Test-AiSmLinuxPath`,
  `Test-AiSmDistroName`, `Test-AiSmDataDir`;
  `^/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*\z` for the path,
  `^[A-Za-z0-9._-]+\z` for the distro — `\z`, not `$`), shared with
  `installer/helpers/*.ps1` — the injection-safety gate; a derived-but-invalid
  value FAILS. Any NEW `wsl.exe` call with positional args uses `--exec`.
  **The window is a WebView2 host** (own AppUserModelID +
  `app.ico`; Edge `--app` fallback when the runtime is absent): navigation
  locked to `127.0.0.1:<port>`; ONE sanctioned exit — a user-initiated
  off-origin `window.open` for `http`/`https` goes to the default browser
  (scheme allowlist enforced in C#; every other scheme and every popup is
  dropped); refocuses web content on activation; clipboard-read granted to
  the launch origin only; `AreHostObjectsAllowed` off; ONE page→host
  message, `copy-files\n<windows path>…` (origin locked, 1..100 paths,
  shape-checked, the whole message refused on the first bad path,
  `Clipboard.SetFileDropList`, `host.log` counts only, no clipboard READ,
  no drag out); dark DWM window chrome. Tauri stays the later upgrade. History: `memory/decisions/native-webview2-host.md`.
- **Release build / distribution.** `.github/workflows/verify.yml` is the
  one definition of "verified" (checks `verify / typecheck + build`,
  `verify / backend test suite` on ubuntu-latest, `verify / linux bundle`
  — the bundle job alone on ubuntu-22.04, glibc 2.35 floor);
  `ci.yml` calls it on push to `main` and every PR. A `v*` tag runs
  `release.yml` (`verify`, `host`, `bundle`, `installer`, `release`): assets
  Setup exe, bundle tarball, host zip, one `SHA256SUMS.txt`; a red suite
  blocks the publish; `workflow_dispatch` publishes nothing off a tag. One
  `NODE_VERSION` feeds setup-node and `build-bundle.sh --node`. Actions
  SHA-pinned, `permissions: {}`, `contents: write` only on `release`, no
  `${{ }}` inside `run:`. Tag only via `npm run release -- vX.Y.Z`
  (`scripts/release.sh`: clean tree, `main` = `origin/main`, unused tag, CI
  green for that commit). Binaries never committed; both exes unsigned;
  version only in the tag. Commits use the noreply address;
  `tests/repo/no-author-paths.test.ts` guards author paths. History:
  `memory/decisions/scope-history.md` § Architecture — Release build.
- **Installer and self-contained bundle** (user's call 2026-09-08). WSL
  side: `ai-session-manager-linux-x64.tar.gz` (pinned Node 24 verified
  against nodejs.org `SHASUMS256.txt`, node-pty built on ubuntu-22.04,
  built `web/dist`, `start-backend.sh`, version marker) — users need no
  Node, git or build tools. Explicit opt-in for anything third-party: a
  consent page lists each item, nothing third-party is installed silently.
  Inno Setup, unsigned, per-user, with uninstaller. No WSL2/distro →
  explain and stop, never elevate. Layout: WSL
  `~/.ai-session-manager/app/<version>/` + `current` (app dir must end in
  `/app`, ≥ 3 segments, so the uninstall guard — allow-listed, ends in
  `/app`, holds ≥ 1 `<v>/bundle.json` — is checkable; data dir untouched); Windows
  `%LOCALAPPDATA%\Programs\AI Session Manager\` + `install-info.txt`.
  Retention: `current` + one previous + any live dir; reinstalling the
  running version is refused. **Every `wsl.exe` call in the installer
  helpers uses `--exec`**; tarball over stdin — no Windows path ever
  reaches a Linux command line. Backend **installed mode**:
  bundle version in the banner, no dependency check, bundled `web/dist`.
  `AI_SM_NODE_DIST_BASE` (test-only) is `file://…` or
  `https://nodejs.org/dist` only. History:
  `memory/decisions/installer-and-self-contained-bundle.md`.
- **In-app update** (user's call 2026-09-09: a notification and ONE
  button). Installed mode only (a clone or `0.0.0*` bundle makes no
  request, `422`). Check (`server/update-release.ts`): 20 s after listen,
  then 6 h; one GET to GitHub `releases/latest` with ETag, no credentials,
  15 s timeout, 1 MiB body cap; drafts and prereleases skipped, the tag must
  match the version shape; asset names and URLs must EQUAL what the backend
  constructs; ≤ 200 MiB;
  `<dataDir>/update-check.json` caches the release descriptor (`latest`),
  never the verdict. `POST /api/update` (`202` · `409` · `422` · `503`),
  progress `GET /api/update/status`, `POST /api/update/check` runs a check
  now. `server/update-install.ts`: `SHA256SUMS.txt` then the Setup as a
  `.part` hashed inline — the `.part` → `.exe` rename after the check is the
  ONLY way a runnable file exists; redirects ≤ 3 to `github.com` /
  `*.githubusercontent.com`; runs `launcher/run-update.ps1` (re-hash, then
  Setup `/SILENT /SUPPRESSMSGBOXES /NORESTART`) via `powershell.exe` by
  full path, argv only. A Setup still running after 15 min counts as
  failed, but the single flight stays HELD until it exits;
  `SetupMutex=AiSessionManagerSetup` is the second lock. The Setup
  closes nothing (host binaries promoted at next start); the UI then
  continues into the same-port restart. Seams `AI_SM_UPDATE_API_BASE`
  (loopback only, refuse-to-start otherwise), `AI_SM_UPDATE_FIRST_MS`,
  `AI_SM_UPDATE_INTERVAL_MS` (floored at 1000 ms).
  History: `memory/decisions/in-app-update.md`.
- WSL2 localhost forwarding is how Windows reaches the backend.

## Features (decided)

Same shape as Architecture: the current rule here, history and the full
pre-2026-09-23 wording in the note named at the end of each bullet.

- **Projects**: stored in a `projects.json` — `{ id, name, path,
  defaultModel, defaultMode, createdAt }` (full schema: `shared/protocol.ts`). UI shows the project *name* everywhere (a project-less terminal session,
  launched into the home folder, is grouped under that folder's last
  segment in the Sessions panel's `Earlier` list — never a full path); the raw path
  appears only as secondary metadata inside the manage-projects view (needed
  to disambiguate add/delete). "Add project" = browse to a directory + give
  it a name.
- **Launch dialog = a short form** (`New session`). `Tool` = a card
  radiogroup (roving tabindex, arrow keys): **Claude Code · Codex · Gemini
  CLI · Grok · Terminal · Other**. A tool the backend cannot find on the
  PATH it spawns with (`GET /api/tools`, stat-only, cached 5 s) is inert
  (`Not installed`); until the first answer every probed (non-composable)
  card is inert with no sub-line at all. `Other` = the custom command
  + args escape hatch. `Terminal` → shells **Bash** (`/bin/bash -l`) ·
  **Zsh** · **PowerShell** (`powershell.exe -NoLogo` via interop; `pwsh.exe`
  not adopted) · **Command Prompt** (`cmd.exe`; the SERVER appends `/k pushd
  <windows path of the cwd>` only when the cwd and distro pass the
  allow-list shape, else plain `cmd.exe` + a warn line). Shared: Name
  (optional), Project, Cancel, **Start session**. Tool controls: Model ·
  Effort · Permissions (`Always ask` · `Auto edits` · `Read only` · `No
  prompts`) · Start from (fresh / the last conversation / an ENDED
  conversation of the project → `--resume <id>`, `409` when it is live).
  The per-tool argv mapping lives ONLY in `web/src/ui/launch-args.ts`
  (order model → permission → effort → start tail, pinned byte-exact);
  `composeSpawn()` is the one composition path. One on-demand permissions
  info popover (Esc closes it first); no command preview. Gemini CLI and Grok show `Add key` when
  no key is saved or inherited. The launched agent stays a configurable
  command + args. History: `memory/decisions/scope-history.md` § Features
  — Launch dialog; spec `.claude/plans/nocturne/PLAN-B5.md`.
- **Stored API keys + spawn-time injections.** `<dataDir>/keys.json`
  (0600, atomic, `{ claude?, gemini?, grok? }`): never logged (the log
  carries only `key saved/cleared/rejected for <tool>`), never returned to
  the page, never in argv; 1–4096 printable non-space ASCII, gated on save
  AND load. Routes: `GET /api/tools`, `GET /api/keys` (`saved`/`env`),
  `PUT /api/keys/:tool` (JSON only, 8 KiB cap), `DELETE /api/keys/:tool`. Injections in
  `server/sessions.ts` (by the command's last `/` or `\` segment, `commandBase`; PTY-only, re-applied on
  resume): a SAVED key → `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` /
  `XAI_API_KEY` (beats an inherited one); `cmd.exe` with no args →
  `/k pushd`. No keys for Codex. History:
  `memory/decisions/b5-tools-keys-and-shells.md`.
- **Ending a session = a signal ladder on the process GROUP.** `DELETE
  /api/sessions/:id`: SIGHUP, +2 s SIGTERM to `-pid`, +3 s SIGKILL to
  `-pid`, each rung skipped once the group is gone. Shutdown/restart:
  SIGHUP + immediate group SIGKILL. Known limits: a `setsid` escapee or a
  root-owned member survives. History:
  `memory/decisions/b5-tools-keys-and-shells.md` § Features (decided) —
  Ending a session (rationale § 5).
- **The commits routes** (`server/git-log.ts`, on the one git runner, same
  home/project boundary): `GET /api/git/commits`, `/api/git/commit`,
  `/api/git/commit-diff`; `limit` 1..50 (default 10). Every client string
  gated BEFORE argv (40-hex hash + `rev-parse --verify`, strict integers,
  `path` relative after `--`). Nothing the repository configures may run
  or reshape: `--no-show-signature --no-notes --no-color --no-ext-diff
  --no-textconv --no-renames --diff-merges=first-parent --encoding=UTF-8
  -O/dev/null`, `--no-walk` on single-commit calls, `GIT_NO_LAZY_FETCH=1`. No e-mail address anywhere; credentials in
  `origin` never leave the server; counts-only logging. Page: 10 rows +
  `Show more`, one 5 s interval shared with Changes. Known limit: the whole
  repository's object store is readable through `commit-diff`. History:
  `memory/decisions/b3-commits-live.md`; also
  `memory/knowledge/git-read-calls-run-repo-config.md`.
- **The upload route** (`server/fsupload.ts`). `PUT
  /api/fs/upload?dir&rel&mode=replace|new`, one file per request,
  `content-length` required (411), 413 over 50 MiB before a byte is read,
  refusals with `connection: close`. Boundary `resolveUnderAllowed`; every
  `rel` segment `isSafeSegment` + ≤ 255 bytes, depth ≤ 64; every folder it
  builds is re-checked right after `mkdir`; bytes land in an
  `O_EXCL|O_NOFOLLOW` `.part` published by `rename` (replace) or
  `link`+`unlink` (new; EEXIST → 409) — never follows the final component,
  so `Replace` over a symlink replaces the LINK. Stateless. `GET /api/fs/winpath` maps a boundary-checked path
  to its Windows form (`server/winpath.ts`). History:
  `memory/decisions/scope-history.md` § Features — The upload route.
- **The delete route — PERMANENT** (user: no trash, one confirmation per
  action). `POST /api/fs/delete { paths }`, body via `readJsonBodySafe`
  (512 KiB), ≤ 100 items (more → 413, nothing touched), per-item `{ ok }` /
  constant sentence, no path back. The PARENT through
  `resolveUnderAllowed`; refused: an anchor or anything containing one, the
  data dir; async `rm(recursive)` on the lexical path — a symlink is
  unlinked, never followed; never `rmSync` (it blocks every PTY). History:
  `memory/decisions/b10a-multi-select-and-delete.md`.
- **The rename route** (`server/fsrename.ts`). `POST /api/fs/rename { path,
  name }` → `200 {}`; same folder only; delete's checks, anchors also
  checked as the path STORED in `projects.json` and through any symlink on
  its chain; a taken name is NEVER replaced (409). Delete AND rename also refuse by IDENTITY
  (`server/fsprotect.ts`: `dev:ino` of every anchor, stored project path and
  the data dir; cached 5 s; a walk past 3 s → 503). History:
  `memory/decisions/b13-rename-in-files-panel.md`.
- **Tabs and layouts**: **sessions are tabs**; dragging one tab onto
  another forms a split. A view holds 0–4 SLOTS, each a session or an
  EDITOR pane holding file and read-only diff TABS (≤ 4 per strip,
  `MAX_TABS = 4`: a fifth file evicts position 4, a move into a full pane is
  refused). A fixed `Home` tab is always first, never draggable or
  closable. A file opens as a tab of the editor pane in the tab of its root
  folder (created on demand; never duplicated). Every drag has a
  keyboard/button equivalent (the shortcuts overlay). The arrangement is
  client-local localStorage schema v2 (views with `root` and `slots`;
  editor slots persisted as paths, never unsaved TEXT; every entry gated on
  read; `run` = the backend's `startedAt`: with `Reopen tabs on start` OFF
  views return only for the run that wrote them). Sessions exist
  independently of tabs/panes/splits. History:
  `memory/decisions/anti-slop-design-direction.md`.
- **Files panel**: a middle-row column left of the pane grid, one fit →
  ws resize seam; tabs Files / Changes / Commits, all on real data. Root =
  the user's home or the focused session's project root (nothing focused =
  home). Shown whenever wished and the Projects drawer is closed — only ONE
  left panel at a time; not a keyboard owner (`OPEN_FOCUS_OWNER_SELECTOR`
  excludes it). Esc acts only with focus inside it: a first Esc clears a
  folder selection, the next closes it and hands the keyboard back to the
  terminal (else a visible control, never `<body>`). Backend (all token-gated,
  realpath boundary = HOME or any REGISTERED project's path, constant error
  sentences, counts-not-names in `server.log`): `GET /api/fs/entries`,
  `POST /api/fs/create`, `PUT /api/fs/upload`, `GET /api/fs/winpath`,
  `POST /api/fs/delete`, `POST /api/fs/rename`, `GET /api/fs/read`,
  `PUT /api/fs/write`, `GET /api/git/changes`; the picker's `/api/fs/list`
  + `/api/fs/mkdir` stay machine-wide (user decision 2026-09-16). Git via
  argv only, `core.fsmonitor` off, `GIT_OPTIONAL_LOCKS=0`,
  `GIT_NO_LAZY_FETCH=1`, `GIT_LITERAL_PATHSPECS=1`, `LC_ALL=C`, stdout
  capped, 5 s kill. Test seam `AI_SM_HOME_OVERRIDE` (absolute, normalized,
  never root, an existing dir; refused at boot). Drop targets for
  Windows Explorer files (destination always a NAME; window-level guard so
  a stray drop never navigates; a TEXT drag onto a terminal is cancelled);
  one dialog per drop (Skip · Replace · Keep both); limits 200 top-level
  items, 2000 files, 1 GiB per drop, 50 MiB per file; one file at a time,
  no cancel. Twins: the copy strip, Ctrl+Alt+C, paste with files. Multi-row
  Explorer-style selection. Row context menu (`ui/context-menu.ts`):
  Delete behind the one hairline, `Rename` (F2) — an ANCHOR row has no
  Delete; `Copy` works in the native host only; `Paste` stays disabled for
  good. Right-clicks elsewhere (a terminal) are never touched. History:
  `memory/decisions/b10-file-copy-and-clipboard.md`.
- **Commit view and editor panes.** The **commit view** replaces the pane
  area (grid `hidden`, terminals NOT disposed, `panes.render()` refuses
  while hidden); `Open on GitHub` only for a github.com `origin`, absent
  otherwise. An **editor pane** is a pane like a terminal: a strip of file
  tabs (`×` closes files, ends nothing), the active tab's body; switching
  tabs never resizes neighbouring terminals. **Editor live**: `GET
  /api/fs/read` (text only, ≤ 1 MiB, UTF-8 without NUL; eol + BOM kept,
  text travels LF-normalised) and `PUT /api/fs/write` with the SHA-256
  STAMP it read (`409 This file changed on disk since you opened it.`, then
  `Overwrite` / `Load from disk`). Ctrl+S is taken only inside a file
  pane's text (a terminal keeps its XOFF); Esc in that textarea closes
  nothing. A
  clean tab follows its file (5 s, `if=<stamp>`); a dirty tab is never
  touched. Unsaved text is NEVER dropped without a question (`Discard` /
  `Keep editing`, `beforeunload` — disarmed for the app's own restart
  handoff and the auth-loss reload); the backend grace timer is the one
  door that cannot ask. Known limit: a hard link inside the boundary to a
  file outside it is read and written through. `server/fstext.ts`: the
  anchor boundary, fd judged before the path (`O_NOFOLLOW|O_NONBLOCK`,
  regular file only), stamp and write on ONE descriptor. While a commit
  view is up the pane chords and the tab-switch chords (Ctrl+Alt+1..9) are
  ignored; Ctrl+Alt+Shift+PageUp/PageDown stays live. Esc closes the commit
  view ranked after every dialog, before drawers and the Files panel.
  Nothing in the app is mock. History:
  `memory/decisions/b4-editor-live.md`.
- **Attention badges**: surface when a hidden session is waiting for input.
  Implemented: BEL (0x07) detection in output. Possible later: OSC
  sequences, Claude Code hooks.
- **Peek mascot** (Nocturne C1). The user's pixel-art Claude
  (`design/peek-mascot/`) peeks around the right edge of the app window's
  monitor, over other programs, one per PENDING session, max 3. Pending =
  `SessionInfo.turnEnded` (kept until Claude works again or the session
  ends) or a BEL `attention` (until the pane is looked at). `/mascot.html`
  carries the auth token, polls every 2 s, rises after 1.5 s; the Windows
  host keeps a TopMost, no-activate, transparent WebView2 window whose
  REGION is the reported rects (never hidden). `prefs.mascot = { enabled }`
  (default ON). History: `memory/decisions/scope-history.md` § Features —
  Peek mascot; spec `.claude/plans/nocturne/PLAN-C1.md`.
- **App settings panel** — persisted server-side in `prefs.json` via
  `/api/prefs`; a left-nav modal: Status bar, Preferences (API keys: one
  password field per keyed tool, a key never comes back; **Tools**:
  `prefs.tools.hidden`, at least one card stays; **Defaults**:
  `prefs.behaviour` — `Reopen tabs on start`, `Confirm before ending a
  session` (the armed two-step on every door that ends a session), `Follow
  output`), Keyboard (the whole table from `web/src/ui/shortcuts-rows.ts`),
  Terminal colours (presets + custom ground and text, terminal only,
  `web/src/ui/theme.ts`, `prefs.theme = { ground, text }`; Nocturne = no
  override), Background service (version, uptime, `Restart service`,
  `Check for updates`). The old "decided four" and their backends stay
  deleted. Launch pre-selection: per-project defaults in `projects.json`,
  hardcoded fallback; a per-launch choice always wins. History:
  `memory/decisions/terminal-colours-shape.md`.
- **Terminal status line.** Claude Code draws its OWN status line: the
  backend writes `<dataDir>/session-settings/<id>.json` and appends
  `--settings <file>` (that session only; `~/.claude/settings.json` is
  NEVER read or written, `CLAUDE_CONFIG_DIR` untouched), pointing at
  `server/statusline.mjs`, which re-reads `prefs.json` each call. Items only
  when on AND honest. Known limit: permission mode = the LAUNCH mode.
  Sessions with their own `--settings` and non-claude commands are left
  alone. Data-dir artifacts wiped at boot: `session-settings/` (0700),
  `statusline-cache.json`, `statusline-snapshots/`. History:
  `memory/decisions/scope-history.md` § Features — Terminal status line.
- **Pane status bar** (Nocturne B1). The strip under each terminal renders
  the Settings → Status bar checklist from the payload Claude Code hands
  `server/statusline.mjs`, via a per-session snapshot
  `<dataDir>/statusline-snapshots/<appSessionId>.json` (keyed by the APP
  id), watched by `server/telemetry.ts` (untrusted input: 8 KiB cap, gated,
  capped, clamped) → `SessionInfo.telemetry` → `info` frame. Two switches: `Inside
  the terminal` (off by default) and `Under the terminal` (on). History:
  `memory/decisions/scope-history.md` § Features — Pane status bar; spec
  `.claude/plans/nocturne/PLAN-B1.md`.
- **Background agents table** (Nocturne B7). Fed by Claude Code's own
  transcripts under `<CLAUDE_CONFIG_DIR|~/.claude>/projects/…/subagents/`;
  the snapshot's `transcript_path` is untrusted and refused unless it
  resolves inside `DataPaths.claudeProjectsDir`, re-checked every poll.
  `server/agents.ts` polls 2 s with read budgets, `O_NOFOLLOW`, regular
  files only → `SessionInfo.agents` / `agentCounts` (≤ 4 running rows,
  then the one most recently finished only when fewer than 4 run; `+N`
  totals). Shown only with `paneAgents` on (default OFF),
  never empty, never for non-claude sessions. Nothing written under
  `~/.claude`. History: `memory/decisions/scope-history.md` § Features —
  Background agents table; spec `.claude/plans/nocturne/PLAN-B7.md`.
- **Session state: Working vs. Waiting for you** (Nocturne B11). A Claude
  session's readout comes from its own transcript (B7 boundary and
  budgets): the last counting line decides `waiting` or `working`;
  `SessionInfo.turn`, dropped at exit. Order: Needs your answer (BEL) >
  Finished > Waiting for you > Working. Waiting shows on the session's own
  pane, row and tab dot only; badges, `Needs you`, `attention`, `seen` and
  notifications stay BEL-only. Known limit: a permission prompt reads
  Working unless the BEL fires. History:
  `memory/decisions/scope-history.md` § Features — Session state.
- **Session pane header** (A3; End session since B8). Left to right: state
  dot, session name, project NAME, spacer, state pill, degraded-connection
  chip, `Own tab` (multi-pane only), and an **End session** button that
  ENDS the session (`killSession`) under `Confirm before ending a session`.
  No chord. Editor panes keep their own `×`. History:
  `memory/decisions/scope-history.md` § Features — Session pane header.
- **Project creation + GitHub integration.** The app creates projects
  (new folder with an `Initialize git repo` toggle, default on; clone by
  URL; clone from the GitHub list into `<home>/projects/<owner>/<repo>`;
  create a GitHub repo). Auth: **OAuth device flow**, scope `repo`, plus a
  **pasted token** as a second path (remembered by default, toggle off =
  memory only). Tokens live **server-side** (0600), never in localStorage,
  never returned to the page; the UI claims nothing stronger than "stored
  on this machine, readable by your own user account". Every GitHub
  endpoint behind token-auth + Origin/Host; git via argv; token requests
  `redirect: 'error'`. `AI_SM_GITHUB_API_BASE` is test-only, loopback-only
  (`127.0.0.1`, `localhost`, `[::1]`; no userinfo, path, query or
  fragment); anything else exits 1 before `listen`, no `runtime.json`; it
  moves neither the device-flow URLs nor the clone host-lock. History:
  `memory/decisions/github-integration.md`,
  `memory/decisions/github-token-paste-path.md`.
- **No commands, flags, or code in the UI** (user's call 2026-07-25). The
  GUI speaks plain human language; CLI syntax belongs in the terminal.
  Permission modes render `Always ask` / `Auto edits` / `Read only` / `No
  prompts` (`PERM_SHORT`); resume reads **The last conversation in this
  project**; the known agent shows as `Claude Code`, the shells as `Bash` /
  `PowerShell`; no command preview, no variable names in the chrome.
  Known exceptions (aligning them is open, backlog): the in-terminal
  status line's `MODE_LABELS` incl. `plan`, its Settings preview, the Add a
  project dialog's `never ask (dangerous)`. Carve-out: the Setup wizard's
  WSL and consent pages MUST show the exact fix and third-party commands.
  Exempt: the custom-command field and terminal content. **UI language
  stays English.** A UI copy rule only — docs, code, commits and briefs are
  unaffected. History: `memory/decisions/scope-history.md` § Features —
  No commands, flags, or code in the UI.

## Hard technical constraints

- Every session needs a **real PTY** — the hosted CLIs are full TUIs (raw
  mode, alt screen, cursor control). Capturing stdout is not an option.
- **Resize must propagate**: pane resize → xterm.js fit addon → `pty.resize()`,
  or TUIs render garbage.
- Keyboard input goes **to the terminal** (Ctrl+C etc. must reach the PTY);
  app-level shortcuts must not collide with TUI keybindings. A focused
  terminal forwards every key to the PTY except the app's Ctrl+Alt family
  (arrows, digits, t, /, PageUp/PageDown shifted and — since A10b —
  unshifted, w since A10, m since A10b; on a terminal pane Ctrl+Alt+W,
  Ctrl+Alt+PageUp/PageDown and Ctrl+Alt+M do nothing and are swallowed,
  recorded 2026-09-15; Ctrl+Alt+M's bytes equal Alt+Enter's, which stays
  untouched). The app takes
  exactly four extra chords (plus, since B4, Ctrl+S while the keyboard is
  inside a file pane's text — a key the textarea takes, not a window
  chord — and, since A9b, the files-only paste EVENT
  described below — an event, not a chord — and, while the keyboard is
  INSIDE the Files panel, the ContextMenu key / Shift+F10 that open the
  row's menu on a focused row or the panel's own menu elsewhere in it
  (A9c, 2026-09-16), and since B10a (2026-09-20) Delete, ctrl+a, ↑/↓,
  shift+↑/↓, ctrl+↑/↓, ctrl+space and ctrl+enter, and since B13 (2026-09-22)
  F2 — all on the panel root's
  own bubble-phase listener, so a focused terminal never sees any of them
  taken): `Ctrl+Shift+V` and `Shift+Insert` paste the
  clipboard into the terminal (2026-09-08; plain Ctrl+V is NOT intercepted —
  xterm sends it to the program in the terminal, which Claude Code uses
  itself; a paste that carries FILES is taken — and opens the drop dialog —
  when the target is neither a terminal nor an editable field (A9), OR when
  a row is selected in the Files panel (a file's parent is then the
  destination, B10a), a focused terminal included
  (A9b, user decision 2026-09-16: files carry no text, so the terminal
  loses nothing; the app then also stops propagation so xterm's own paste
  handler never types a stray `text/plain` into the PTY); a text paste is
  never the app's; inside a terminal only plain Ctrl+V can carry files,
  because Ctrl+Shift+V and Shift+Insert are served from `readText()`), and `Ctrl+Shift+C` and `Ctrl+Insert` copy the terminal selection
  (2026-09-10, user report "ik mag niks kopieren vanuit de sessies") — taken
  ONLY while a selection exists; with nothing selected they are left alone
  (xterm sends no bytes for either chord anyway), and plain Ctrl+C always
  stays the interrupt. Discoverable (user's ask, 2026-09-08 "hoezo ctrl+shift+v?"; the
  top-bar `?` button was dropped by the Nocturne chrome, part A2, 2026-09-10 —
  the v3 handoff has none): the statusline's "Keyboard shortcuts" button, the
  `?` key and Ctrl+Alt+/ open the shortcuts overlay, whose paste and copy rows
  carry a one-line why; Settings → Keyboard draws the same table from the
  same rows module (B6, 2026-09-22; A7's three-row excerpt and its `all
  shortcuts` link are gone). When the window regains focus the
  keyboard goes back to the focused pane unless a dialog, drawer, overlay
  or editable field owns it. OSC 8 hyperlinks printed by a CLI open in the
  system browser on **Ctrl+click** (`http`/`https` only, no confirm
  dialog — the modifier is the second gesture, as in Windows Terminal and
  VS Code). Known limit (2026-09-08): a reply xterm generates while a
  replay is being written is dropped on purpose (the live session already
  answered those queries), so a program that BLOCKS on a terminal query —
  PowerShell on `ESC[6n` — can hang if that query is replayed into a pane
  attaching in that few-ms window; not observed (attach beats the interop
  start), no fix designed yet.
- Focused pane must be clearly indicated when multiple panes are visible.

## Environment

- Development happens inside WSL2 Ubuntu at `/home/you/projects/ai-cli-application`.
- The user runs Windows + WSL2; the app must work in that setup first.

## Process

Nontrivial changes follow the development loop in
`.claude/skills/dev-flow/SKILL.md`: a developer agent implements, reviewers
(`scope-reviewer`, `security-auditor`, `test-engineer`) gate the change, the
`fixer` resolves findings, and the loop repeats until clean, then a final
verification gate. Reviewers never edit code; the fixer never adds features;
the `janitor` keeps the repo tidy between features.

Project memory is an Obsidian-style vault at `memory/` (conventions in
`.claude/skills/memory/SKILL.md`): this file holds the current truth; the
vault holds the *why*, rejected alternatives, learnings, and the work log.
Recall from it before nontrivial work; write back after decisions and
landed features.

**Repo layout is a standard (decided 2026-09-20, user's call; rationale and
move maps in `memory/decisions/repo-layout.md`).** `README.md` § Repository
layout is the map of where things live. The work log is
`memory/log/<YYYY-MM>/<area>/` (areas: nocturne, backend, ui, launcher,
github, release, project); `memory/decisions/` and `memory/knowledge/` are
flat, with `memory/INDEX.md` grouped by theme. `tests/repo/vault-layout.test.ts`
enforces the vault rules (placement, unique basenames, INDEX coverage, no
dead `memory/…md` citation in any tracked file). Every move of files or
folders follows `.claude/skills/restructure-repo/SKILL.md`; the remaining
batches (design folders, tests and code) are in
`.claude/plans/PLAN-RESTRUCTURE.md`.

**Planning has one shape (decided 2026-09-20, user's call; conventions in
`.claude/plans/README.md`).** A master plan is `.claude/plans/PLAN-<NAME>.md`
and opens with a status table — the one place that says where the work
stands; the spec of a part is `.claude/plans/<name>/PLAN-<ID>.md`, written
before the developer starts, carrying a `Status:` line, and it never moves
(code and tests cite specs by path). A landing updates the spec's status,
the part's table row, the index in that README and the vault in the same
commit. `tests/repo/plans-layout.test.ts` enforces the layout, the status lines,
the table-to-file agreement and that every plan citation in a tracked file
resolves (`memory/log/` exempt: history).

## Open decisions (do not treat as settled)

Repo visibility — DONE: PUBLIC since 2026-09-09 (vault included). Branch protection — DONE 2026-09-09: ruleset `protect-main` blocks force-push + deletion on `main`, no required checks (direct pushes stay possible).
- ~~One-click installer — FUTURE~~ **DECIDED 2026-09-08 (user: "tijd om hiervan een app te maken, zodat andere mensen dit makkelijk kunnen gebruiken"), IN PROGRESS.** See the Architecture bullet "Installer and self-contained bundle" and `memory/decisions/installer-and-self-contained-bundle.md`. Remaining sub-decisions live there; the visibility flip itself is still the user's hand.

(Settled 2026-09-08, user's call — "de update moet echt bulletproof zijn":
**update after a `git pull` without `npm run build`.** The restart always
rebuilds `web/dist` itself as part of a preflight that runs while the old
backend is intact, refuses with `422` when dependencies changed or the build
or the replacement's boot fails, and only then hands over. Rejected: a
"needs a build" reason with no action; documenting the limit. Rationale in
`memory/decisions/restart-preflight-standby.md`.)

(Settled 2026-07-25, user's call: **how a cloned project ties back to its
remote — option (b), owner-qualified clone paths.** App clones from the
GitHub repo list land at **`<home>/projects/<owner>/<repo>`** instead of
`<home>/projects/<repo>`, so `acme/api` and `myorg/api` can both exist
locally — which removes the 409 *and* the mis-identification underneath it:
`clonedProject()` matches on the `<owner>/<repo>` path tail first and only
falls back to the bare basename for projects registered before this change.
Rejected: (a) adding an optional `remote`/`fullName` to `Project` — more
explicit, but it leaves the two-repos-one-folder 409 in place and changes
the `projects.json` schema; (c) accepting the limit. The URL-clone tab keeps
its user-chosen destination (default unchanged) — the owner is only known
for sure on the GitHub-list path. The `KNOWN LIMIT` test that pinned this
becomes a real behavioral test.)

(Settled 2026-07-25: **lost final PTY output after session exit — FIXED.**
Root cause was not node-pty event ordering but **libuv**: on POLLHUP
`uv__stream_io` short-circuits to a synthetic EOF without re-reading, so
bytes still held by the kernel are discarded. `server/sessions-output.ts`
(`rescueFinalOutput`, called from `server/sessions.ts`) now wraps `destroy` on node-pty's internal master read stream and
synchronously drains the fd there, feeding bytes into the same handler
`onData` uses — one ingress, no clock, loop ends on EIO/EAGAIN/0. This
depends on two undeclared node-pty internals (`fd`, `_socket`) and on
node-pty's own `pty_nonblock(master)` for the non-blocking guarantee that
makes a synchronous read safe, so **`node-pty` is pinned exactly to
1.1.0** (user's decision) and a version bump means re-running
`tests/server/sessions-tail.test.ts`. Accepted limit: a multi-byte character
split across the fabricated-EOF boundary can render as one replacement
character — rare, bounded, pinned by a test (user's decision not to close
it). Detail in `memory/knowledge/pty-exit-data-race.md`.)

(Settled 2026-07-23, user's call: project creation + GitHub integration
added to scope — see the Features bullet. GitHub auth = OAuth device flow;
v1 = the full clone + create shape. Rationale in
`memory/decisions/github-integration.md`.)

(Settled 2026-07-23: the Edge `--app` taskbar showing the Edge logo instead
of `app.ico` is fixed by bringing the native host forward as a lightweight
WebView2 window — see the launcher Architecture bullet. Root cause: Chromium
(Edge 150 here) stamps a non-installed `--app` window with its own per-URL
AppUserModelID that includes the churning auto-picked port, and our launch
chain runs Edge as a grandchild of the shortcut (wscript→powershell→edge),
so a shortcut's AUMID never reaches the window. The lightweight
profile+shortcut attempt was proven structurally impossible for this
architecture (no code shipped); PWA-install stays closed (non-installable
manifest + churning port). Only a process that owns BOTH its window and its
shortcut can make the two AUMIDs match — hence the WebView2 host. The
favicon itself is valid and already correct for the in-window icon.
Rationale in `memory/decisions/native-webview2-host.md`.)

(Settled 2026-07-20, user's call — reversing the 2026-07-19 triage
recommendations: the hi-fi handoff in `design/` is now the **primary design
source**; `web/DESIGN.md` is rewritten to transcribe it rather than override
it. Both structural conflicts went the handoff's way: the **tab strip moves
to a dedicated bottom strip** above the statusline, and the **launch UI
becomes a modal dialog** (replaced launcher-as-tab; landed with R3,
2026-07-20, including a user-decided `custom · any command` escape-hatch
chip preserving arbitrary command + args launches).
Unaffected by the flip: architecture (vanilla TS + Vite stands — the handoff
prompt itself defers to the existing stack; no new npm dependencies, fonts
self-hosted), and the three fiction cuts stay cut — they are lifecycle
impossibilities, not looks. Rationale, and the cuts themselves (formerly
enumerated in the now-removed `design/GAP-ANALYSIS.md`), in
`memory/decisions/handoff-design-primary.md`.)

(Settled 2026-07-18: port auto-pick + discovery file, amended 2026-09-22 —
the last port is tried first, `last-port.json`; vanilla TS + Vite
frontend; app data — projects.json, runtime.json, last-port.json (2026-09-22), history.json (2026-09-06,
replacing journal.json + previous.json), prefs.json (added 2026-07-20: server-side UI prefs, since
localStorage died with every auto-picked-port origin change), server.log —
lives in `~/.ai-session-manager/` (override: `AI_SM_DATA_DIR`), schema in
`shared/protocol.ts` (with its topic modules `shared/protocol-*.ts`). Rationale in `memory/decisions/`.)

(Settled 2026-07-19: backend lifetime bound to UI presence — see the
Architecture bullet; implemented the same day: presence WS + grace timers,
session journal with boot rotation, previous-sessions relaunch API and
drawer UI — the journal/previous part superseded 2026-09-06 by the session
history bullet.)

(Settled 2026-07-19: full GUI redesign, user's call after real use — the
anti-slop rule stands unchanged, but the phosphor skin was replaced by
the **"steam blend"** direction chosen from rendered mockups (committed under
`design-mocks/` until 2026-09-21; kept by the git tag `legacy-ui`); and the interaction model becomes sessions-as-tabs with
drag-to-split — see the Tabs-and-layouts bullet. Both shipped 2026-07-19:
the tab model, then the steam-blend skin (brief + slop-filter pass in
`web/DESIGN.md`; tokens in `web/src/styles/tokens.css`; chrome typeface was
self-hosted Barlow, OFL license committed beside the woff2 assets). Blend
definition and rationale in
`memory/decisions/anti-slop-design-direction.md`. **Superseded 2026-09-10**:
the steam-blend skin is the *Legacy UI* (git tag `legacy-ui`), replaced
completely by the **Nocturne** design, which ships as v0.4.0
(`.claude/plans/PLAN-NOCTURNE.md`; `design/session-manager/README-v3.md`).
Part A1 landed the Nocturne tokens and swapped the chrome typeface to
self-hosted **Inter** — the Barlow woff2 files and its OFL are gone. Since
B8 (2026-09-22) `web/DESIGN.md` describes the Nocturne app; the steam-blend
brief lives on only in git history.)
