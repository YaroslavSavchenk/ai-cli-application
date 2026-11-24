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
  2026-07-18). Terminal rendering via **xterm.js**, one instance per pane of the
  active tab AND of recently seen tabs (since 2026-09-23, PLAN-QUALITY P5:
  an inactive tab's terminals stay alive, hidden, at most
  `MAX_LIVE_TERMINALS` = 12; the least recently seen tab is disposed first
  and replays on return; a hidden pane sends no resize and acks no BEL).
  WebGL renderer (its context released explicitly on dispose), fit addon
  for sizing, bounded scrollback.
- **Sessions are first-class server-side objects.** The PTY and its state live
  in the backend; the browser is only a view. Sessions keep running when their
  pane is hidden; reopening a window reattaches with scrollback replayed.
  Since Nocturne D9 P3 the PTYs are held by a per-data-dir **pty-host**
  process the backend starts (`server/pty-host-*.ts`; spec
  `.claude/plans/nocturne/PLAN-D9.md`): a backend CRASH leaves them running
  (orphan grace 10 min) and the next boot adopts them — same ids, same
  processes, scrollback and bells kept. Since D9 P4 a **restart or update
  keeps them too**: the old backend detaches (no history stamp, no kill) and
  the new one adopts them at its `go` (details under Manual backend restart).
  Closing the app window still ends them after the grace (decision 25). A
  dead VM (WSL out of memory, `wsl --shutdown`) cannot be survived: Q17
  brings those sessions back by RESUME (below, Session history). Since Q16
  every PTY child's `oom_score_adj` is raised to 500 right after spawn
  (`server/pty-table.ts`, pty-host and in-process alike), so the kernel
  picks a session before the backend or the pty-host (both stay at their
  inherited value); a failed write is one `warn`. A
  refused data dir (not ours, not 0700, socket path > 107 bytes) falls back
  to in-process PTYs with one `server.log` line.
- **Backend starts detached** from the launcher process (setsid), started on
  demand — it must never die with the launcher console. **Lifetime: bound to
  UI presence** (user's call 2026-07-19): the presence WebSocket
  `/ws/presence` counts open windows; when the last closes, a 30 s grace
  (`AI_SM_GRACE_MS`) lets reloads reattach, then the backend ends all
  sessions, removes its own runtime.json (only while the file still names
  its pid and startedAt — D2) and exits; a 120 s startup grace
  (`AI_SM_STARTUP_GRACE_MS`) runs until the first-ever presence. Manual
  `-Stop` overrides (since D9 P5 it also SIGTERMs a live pty-host when no
  backend is left — cmdline-checked pid from `pty-host.json`). The presence
  channel answers `ping`/`pong` (inbound frames ≤ 1 KiB, no lifecycle effect).
  The session socket (since Q9, 2026-11-22) ignores a frame that is not a
  JSON object, closes an inbound frame over 16 MiB with 1009 (the browser
  sends input in ≤ 1 MiB frames), and closes a client with more than 16 MiB
  unsent with 1013 — that client reconnects at the maximum backoff and gets
  the replay; the session is untouched. Authed `GET /api/runtime` body is
  exactly `{ startedAt, serverCommit, version, installed, webBuild, update,
  claude, ptyHost }` (`claude` since D6: `{ version, compat, min, testedUpTo }`;
  `ptyHost` since D9 P3: `{ build, proto }` of the pty-host holding the
  sessions, or null).
  Since Q17 every shutdown path first writes `<dataDir>/last-exit.json`
  (0600, atomic, read FIFO-safe): `{ at, startedAt, why: 'signal' |
  'presence-grace' | 'restart' | 'other', signal?, presence, sessions,
  bootId?, seen? }` — `sessions` are HISTORY ids only (live ones plus those
  that ended `exit`/`crash` in the 3 s before the signal: on a VM poweroff
  the pty-host can die first), never argv, cwd or names.
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
  (stamped at boot for an entry no pty-host still holds, and since D9 P3 for
  the sessions of a pty-host lost under a running backend). A conversation is pruned only when its projects folder
  exists and `<id>.jsonl` is missing — every uncertainty keeps it. Needs
  Claude Code ≥ 2.1.263: the supported range (2.1.263, tested up to 2.1.287)
  lives in `shared/claude-compat.ts`, and one `claude --version` probe (argv
  only, after listen, re-run when the binary changes) places the installed
  version against it — it never blocks a launch (D6). Known limit: a `--continue`
  launch cannot be pinned (resumes with `--continue`, button "start again").
  A client-supplied `--session-id`/`--resume <uuid>` is adopted as the key.
  A blank session name makes the title the project name (the Launch Name
  placeholder is the selected project's name).
  **After an unexpected stop** (Q17, `.claude/plans/quality/PLAN-Q17.md`):
  the boot judges `last-exit.json` (`server/previous-exit*.ts`) —
  unexpected = a `signal` record with presence > 0, or crash stamps with no
  newer record. Cause: `oom` (VM rebooted — `boot_id` differs, `btime` the
  fallback — and `journalctl -b -1 -k -r -o short-iso --no-pager -g "Out of
  memory: Killed process"`, argv only, 5 s, 64 KiB, run only after a reboot,
  has a line in the run's window: the largest kill's process name,
  sanitised to `[A-Za-z0-9._-]` ≤ 32, and its RSS in MiB), `wsl-stopped`
  (rebooted, no line or journal unreadable), `stopped`, `crash` (`at` =
  `history.json` mtime). One `info` verdict line. Routes: `GET
  /api/previous-exit` (`200 { at, cause, detail, sessions }` / `204`),
  `POST /api/previous-exit/resume` (the history resume path, one at a time
  at 80×24, idempotent — a second call gets empty lists; items carry
  `previousSessionId`, the layout's remap key), `POST
  /api/previous-exit/dismiss` (`204`, record marked `seen`, never deleted).
  An unread notice repeats until resumed, dismissed or superseded. The UI:
  after 10 s unreachable (not during its own restart/update) an offline
  panel, "The app stopped responding", with `Restart` in the WebView2 host
  (host message `relaunch`); a page relaunched that way (`localStorage`
  `aism.recover`, ≤ 10 min old) resumes at once and says "N sessions
  resumed"; any other boot offers `Resume N sessions` + `Dismiss` with the
  cause sentence. Resumed sessions take their old tab/pane places from a
  layout snapshot read before `loadUi` prunes it; one that fails stays in
  History.
  History: `memory/decisions/session-history-resume.md`.
- **Logging: everything, by default** (user's call 2026-09-06; since 2026-09-23
  a successful poll of `/api/sessions`, `/api/runtime`, `/api/prefs`,
  `/api/update/status`, `/api/client-log` or `POST /api/fs/media-ticket`
  (D7) is one `debug` summary line a minute; a served `GET /api/fs/media`
  (200/206) is a `debug` access line, a failed or ≥ 1 s poll is written at once —
  `memory/decisions/log-everything.md`). `server.log`
  is the backend's ONLY diagnostic channel; `<ISO> [level] [component]
  message`, levels `debug|info|warn|error`, `AI_SM_LOG_LEVEL` (default
  `debug`). **Never written:** the app
  token, the GitHub token, stored API keys, request/response bodies,
  `Authorization`, query-string values, PTY bytes (terminal I/O is byte
  COUNTS, ≤ 1 line/s/session; the one exception, D6: a Claude launch that
  exits non-zero within 3 s logs its first output line at WARN — ≤ 200 chars,
  escape-, control- and bidi-stripped), error MESSAGES of request failures (class +
  frames only). The browser logs through `POST /api/client-log` (authed;
  body ≤ 64 KiB → 413, ≤ 50 entries, message ≤ 2048 chars truncated,
  lines one-lined, 200 entries/min); UI actions are logged as SHAPE, never
  raw custom command text. Lines for requests without a valid token share
  ONE 60 lines/min budget (one limiter for HTTP and WS); a token-bearing
  request is never metered. Rotation 10 MiB → `.1` → `.2` (≤ 30 MiB total,
  0600; a failed rename truncates). 0600 is hygiene only — "never write the
  secret" is the control. `launcher/run-update.ps1` stdout is piped in
  (≤ 64 KiB). Since D9 a second channel: the pty-host process writes its own
  `<dataDir>/pty-host.log` (same format, levels and rotation, honours
  `AI_SM_LOG_LEVEL`) — lifecycle, ids, pids and counts only, never PTY bytes,
  env, argv or its token. History: `memory/decisions/scope-history.md`
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
  rename fails, and a `dist-prev` that vanished under the app. Then: swap dist, hand the
  sessions over (below), close the listener, `go`, wait for the child's
  `runtime.json` + `/health`, `202 { port, startedAt, samePort }`, exit
  without unlinking `runtime.json`. **Same port is a hard constraint** (the
  WebView2 host locks the exact origin); the child falls back once to
  auto-pick (`samePort: false`). **Sessions survive a restart and an update**
  (Nocturne D9 P4, `memory/decisions/pty-host-session-survival.md`; one
  caveat: the first release carrying D9 is installed by a pre-D9 backend,
  so that one update still ends the sessions): the
  standby probes the pty-host (a `probe` connection, `list-count`) and
  reports `ptyHost: compatible|incompatible|none` in `standby-ready`; the
  teardown first writes `last-exit.json` with `why: 'restart'` (the
  child's boot has nothing to tell; it replaces an unread older notice),
  then DETACHES (`detachAll`: blobs flushed, a spawn in flight
  ended, the pty-host connection closed with `detach`, history NOT stamped)
  and the child adopts every session at `go` — same id, pid and scrollback.
  When they cannot be kept — running sessions inside the backend (no
  pty-host), or a pty-host the new code cannot adopt (`incompatible`, or
  `none` while sessions run) — the answer is `409 { error, code:
  'sessions-would-end' }` before anything is torn down (no sessions
  running: never), and the UI asks a second time, saying they WILL end, with
  `Restart anyway` = `POST /api/restart { endSessions: true }` (the one body
  field the route reads; 1 KiB, JSON only; a permission, not an order);
  those sessions then end like `shutdown()` (history `shutdown`, resumable,
  decision 27). A failed handoff after teardown is `500` + exit, not a
  rollback. `409` while in flight or while an update installs; `503` with no
  runner. Seams:
  `AI_SM_PORT_HINT`, `AI_SM_RESTARTED_FROM`, `AI_SM_STANDBY`,
  `AI_SM_WEB_DIST_DIR` (absolute, normalized, never root; a bad value is
  refused with a `server.log` line); since D9 also `AI_SM_PTY_HOST`
  (`inproc` = PTYs in the backend, a test seam refused in installed mode;
  any other value refuses the start), `AI_SM_PTY_HOST_IDLE_MS` (pty-host
  idle exit, default 60 s) and `AI_SM_PTY_HOST_ORPHAN_MS` (orphan grace,
  default 10 min, floor 1 s), passed to the pty-host the backend starts.
  PTYs inherit none of them (nor `AI_SM_HOME_OVERRIDE`, nor the pty-host's
  `AI_SM_PTY_HOST_BUILD`). UI: Settings → Background service
  `Restart service`, toast + amber `Update` pill; the dialog can be hidden
  during the preflight, locked during reconnect. A page whose token is
  rejected without having asked for a restart probes `/health` for 5 s and
  reloads once on the same origin; only silence shows the reload panel.
  Its "did not come back" state carries `Restart` in the host (Q17).
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
  the launch origin only; `AreHostObjectsAllowed` off; TWO page→host
  messages. `relaunch` (Q17: the bare word, ordinal, origin-locked, single
  flight; the host re-runs the launcher that started it — path and data dir
  from `relaunch.txt`, which `launch.ps1` writes beside the host's
  `host.log` just before starting it: line 1 the `launch.ps1` path, line 2
  the data dir, shape-checked, read once; a dev record whose data dir
  ends in `.ai-session-manager` or holds a `.`/`..` segment is refused — with that data
  dir in `AI_SM_DATA_DIR`; success = the new window is up and this one
  closes; exit ≠ 0 or 120 s = reply `relaunch-failed`, window stays). And
  `copy-files\n<windows path>…` (origin locked, 1..100 paths,
  shape-checked, the whole message refused on the first bad path,
  `Clipboard.SetFileDropList`, `host.log` counts only, no clipboard READ,
  no drag out); dark DWM window chrome. Tauri stays the later upgrade.
  **A dev instance never touches the installed app** (user, 2026-09-26): a
  CLONE launch on a non-default `AI_SM_DATA_DIR` passes the fixed switch
  `--dev-instance`, and the host keeps its staged copy, sentinel, `host.log`
  and WebView2 profile in `%LOCALAPPDATA%\ai-session-manager-dev\` (own
  browser process); the host takes that one exact switch and nothing else
  on its command line (the Restart path comes only from `relaunch.txt`).
  History: `memory/decisions/native-webview2-host.md`.
- **Release build / distribution.** `.github/workflows/verify.yml` is the
  one definition of "verified" (checks `verify / typecheck + build`,
  `verify / backend test suite` and, since D9 P3, `verify / backend test
  suite (pty-host)` — the server, release and repo tests
  (`npm run test:server`, since Q10) with every test backend over a real
  pty-host — on ubuntu-latest, `verify / linux bundle`
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
  Retention: `current` + one previous + any live dir — a live backend's
  (`runtime.json`) and, since D9 P5, a live pty-host's (`pty-host.json`
  `appDir`, read in-distro, the token never crosses); reinstalling the
  running backend's version is refused (a pty-host's is not: it loaded all
  its code at start). **Every `wsl.exe` call in the installer
  helpers uses `--exec`**; tarball over stdin — no Windows path ever
  reaches a Linux command line. Backend **installed mode**:
  bundle version in the banner, no dependency check, bundled `web/dist`.
  `AI_SM_NODE_DIST_BASE` (test-only) is `file://…` or
  `https://nodejs.org/dist` only. History:
  `memory/decisions/installer-and-self-contained-bundle.md`.
- **In-app update** (user's call 2026-09-09: a notification and ONE
  button). Installed mode only (a clone or `0.0.0*` bundle makes no
  request, `422`). Check (`server/update-release.ts`): 20 s after listen,
  then hourly (6 h until 2026-10-13); one GET to GitHub `releases/latest` with ETag, no credentials,
  15 s timeout, 1 MiB body cap; drafts and prereleases skipped, the tag must
  match the version shape; asset names and URLs must EQUAL what the backend
  constructs; ≤ 200 MiB;
  `<dataDir>/update-check.json` caches the release descriptor (`latest`),
  never the verdict. `POST /api/update` (`202` · `409` · `422` · `503`),
  progress `GET /api/update/status`, `POST /api/update/check` runs a check
  now. `server/update-install.ts`: `SHA256SUMS.txt` then the Setup as a
  `.part` hashed inline — the `.part` → `.exe` rename after the check is the
  ONLY way a runnable file exists; redirects ≤ 3 to `github.com` /
  `*.githubusercontent.com`; runs (`server/update-interop.ts`)
  `launcher/run-update.ps1` (re-hash, then
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
  defaultModel, defaultPerm, defaultEffort, createdAt }` (`defaultMode`:
  legacy, read only; full schema: `shared/protocol.ts`). Editable via `PATCH
  /api/projects/:id` — name and preferences, never the path (D1, 2026-10-13). UI shows the project *name* everywhere (a project-less terminal session,
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
  (order model → permission → effort → start tail, pinned byte-exact;
  Claude Code's `Always ask` passes `--permission-mode manual` explicitly
  since D5, 2026-10-13 — with no flag Claude Code picked its own mode, and
  `manual` is the name 2.1.287 documents (`default` is hidden there),
  accepted since Claude Code 2.1.200 per its changelog, below the 2.1.263
  floor; the app's stored value stays `default`, mapped in
  `CLAUDE_PERMISSION_FLAG` in `shared/protocol.ts`, the one permission
  table the server reads back too);
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
  SIGHUP + immediate group SIGKILL (a restart that keeps the sessions, D9
  P4, signals nothing). With a pty-host (D9) the ladder runs in
  that process; a pty-host LOST under a running backend (crash, kill) ⇒ the
  backend probes and SIGKILLs each of its sessions' groups itself, the
  sessions exit with code 137 and history says `crash`. Known limits: a `setsid` escapee or a
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
  folder (created on demand; never duplicated — one exception, D7: an SVG
  may be open twice, as its picture and as text, id `f:<path>:text`). Every drag has a
  keyboard/button equivalent (the shortcuts overlay). The arrangement is
  client-local localStorage schema v2 (views with `root` and `slots`;
  editor slots persisted as paths, never unsaved TEXT; every entry gated on
  read; `run` = the backend's `startedAt`: with `Reopen tabs on start` OFF
  views return only for the run that wrote them — except Q17's resume after
  an unexpected stop, which rebuilds the views holding resumed sessions from
  a snapshot taken before that check). Sessions exist
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
  `PUT /api/fs/write`, `POST /api/fs/media-ticket`, `GET /api/git/changes`
  — plus `GET /api/fs/media`, the ONE `/api` route without the token header
  (D7: an `<img>`/`<video>`/`<iframe>` src cannot carry it; a ticket stands
  in, see Editor live); the picker's `/api/fs/list`
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
  **Media viewer (D7)**: an image (`png jpg jpeg gif webp avif bmp ico
  svg`), a video (`mp4 webm mov m4v mkv ogv`) or a PDF — the kind is the
  extension, `shared/media-kind.ts` — opens as a viewer body in the same
  editor tab (`web/src/ui/media-pane.ts`): Fit / 100 %, `<video controls>`
  without autoplay, WebView2's own PDF viewer in an iframe; an SVG is a
  picture with `Edit as text`. `POST /api/fs/media-ticket {path}` (token)
  → `{ ticket, size, mtimeMs, ino }`: 32 random bytes, in memory, bound to
  ONE realpath, 10 min sliding, ≤ 64 alive, the SAME ticket while
  size:mtimeMs:ino is unchanged. `GET /api/fs/media?path=&t=` needs that
  ticket instead of the token (Host/Origin gates kept), streams one Range
  from the fd it judged (same boundary and open as `/api/fs/read`),
  Content-Type from the table only, `nosniff`, `no-store`, CORP
  same-origin, `X-Frame-Options: SAMEORIGIN`; a sandbox CSP on SVG only
  (Chromium's PDF viewer refuses a sandboxed document). The app token
  never goes in a URL. A visible media tab rides the editor's one 5 s
  follow timer: an image swaps to the new file after it decoded; a video
  or PDF shows `Changed on disk` + `Reload` instead.
  `server/fsmedia.ts`.
  Nothing in the app is mock. History:
  `memory/decisions/b4-editor-live.md`.
- **Attention badges**: surface when a hidden session is waiting for input.
  Implemented: BEL (0x07) detection in output. Possible later: OSC
  sequences, Claude Code hooks.
- **Peek mascot** (Nocturne C1). The user's pixel-art Claude
  (`design/peek-mascot/`) peeks around the right edge of the app window's
  monitor, over other programs, one per PENDING session, max 3. Pending =
  `SessionInfo.turnEnded` (the session verdict `turn` went working →
  waiting — so not while its background subagents / workflows run, and yes
  when Claude asks a question, a plan approval or a permission (C2); kept until Claude
  works again or the session ends) or a BEL `attention` (until the pane is
  looked at). `/mascot.html`
  carries the auth token, polls every 2 s, rises after 1.5 s; the Windows
  host keeps a topmost (re-asserted while a mascot shows and on every
  foreground change), no-activate WebView2 window in VISUAL hosting
  (DirectComposition, per-pixel alpha — a colour key lost its transparency
  after any resize) whose REGION is the reported rects (never hidden). `prefs.mascot = { enabled }`
  (default ON). While the app window (or a window it root-owns) is the
  foreground window no mascot shows (D8, decision 24): the stage slides back
  behind the edge (250 ms) and peeks out again when the user leaves; the
  host posts `{"type":"app-active","active":true|false}` on a change and
  after each successful load, and the page reports `"rects":[]` while away. History: `memory/decisions/scope-history.md` § Features —
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
  `server/statusline.mjs`, which re-reads `prefs.json` each call (installed
  mode, D9 P5: node and script named through `<app>/current/…`, never a
  version dir — a session adopted after an update outlives the dir it was
  spawned from; `server/bundle.ts` `statuslinePaths`). Items only
  when on AND honest. Known limit: permission mode = the LAUNCH mode.
  Sessions with their own `--settings` and non-claude commands are left
  alone. Data-dir artifacts wiped at boot: `session-settings/` (0700),
  `statusline-cache.json`, `statusline-snapshots/` — except (D9 P3) the
  `<id>.json` files of the sessions a pty-host still holds, and the whole
  `statusline-cache.json` when any session is adopted (its keys are Claude's
  own session ids; the script drops stale entries itself). History:
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
  `SessionInfo.turn`, dropped at exit. Since C2 (user, 2026-09-26: one rule
  for the pane and the mascot) a pending `AskUserQuestion` / `ExitPlanMode`
  reads `waiting`, and an ended turn reads `working` while a background
  launch it made (`Agent`/`Task`/`Workflow`, a `SendMessage` resume) is
  still open (no task notification yet) and alive (< 15 min old, or its
  B7 row / workflow run files live); background shells never count. Spec
  `.claude/plans/nocturne/PLAN-C2.md`. Order: Needs your answer (BEL) >
  Finished > Waiting for you > Working. Waiting shows on the session's own
  pane, row and tab dot only; badges, `Needs you`, `attention`, `seen` and
  notifications stay BEL-only. Since the C2 DEV check (user, 2026-09-27): Claude
  Code writes an open question's line only after the answer, so the verdict
  also reads Claude Code's OSC 0/2 terminal title. The transcript says the
  turn runs, and the title has been idle (`✳ `) for at least 3 s (counted
  from the later of that and the verdict turning working) → `waiting`. This
  covers a question, a plan approval AND a permission prompt, and it beats
  open launches. Only a derived `titleIdleSince` stamp is kept; the title
  text is never stored, logged or sent. Known limit: a Claude Code that sets
  no title keeps the transcript-only verdict. History:
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
  status line's `MODE_LABELS` incl. `plan`, its Settings preview (the Add
  a project dialog's `never ask (dangerous)` is gone since D1, 2026-10-13). Carve-out: the Setup wizard's
  WSL and consent pages MUST show the exact fix and third-party commands.
  Exempt: the custom-command field, terminal content, and the pane's
  early-exit banner line (D6: Claude Code's own first output line, shown as
  text). **UI language
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

None open. Settled ones — repository visibility (public since 2026-09-09), the
one-click installer (decided 2026-09-08, shipped in v0.2.0 on 2026-09-09; see
the Architecture bullet "Installer and self-contained bundle") and the earlier
"(Settled …)" records — are in `memory/decisions/scope-history.md` § From the
scope doc § Open decisions.
