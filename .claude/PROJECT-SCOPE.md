# Project Scope — AI CLI Session Manager

Single source of truth for what this project is and the decisions already made.
Skills and agents reference this file instead of duplicating it. Update it when
a decision changes; never let it silently drift from reality.

## What we are building

A GUI to run and manage multiple AI CLI sessions (Claude Code first; Codex CLI,
Gemini CLI and others later) side by side — and, since 2026-09-08 (user's
call, "alles moet mogelijk"), plain terminal sessions (WSL shell or
PowerShell) next to them. Each session is a real interactive terminal
running inside WSL; the GUI adds project management, launch presets, and
multi-pane layouts on top.

## Architecture (decided)

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
  UI presence** (decided 2026-07-19, user's call, reversing the earlier
  indefinite-survival promise; rationale in
  `memory/decisions/lifecycle-bound-backend.md`): a presence WebSocket counts
  open windows; when the last closes, a grace timer (~30 s) lets reloads
  reattach harmlessly, then the backend ends all sessions, removes
  runtime.json, and exits. **Implemented 2026-07-19**:
  presence channel `/ws/presence`; grace 30 s (env `AI_SM_GRACE_MS`) plus a
  120 s startup grace until the first-ever presence (env
  `AI_SM_STARTUP_GRACE_MS`). The crash-safe journal that once backed a
  `--continue` relaunch (`journal.json` → `previous.json`, `/api/previous`)
  is **replaced 2026-09-06 by the session history** (next bullet).
  Manual `-Stop` remains as an override. Added 2026-07-19: the presence
  channel answers `ping`/`pong` (latency; inbound frames capped 1 KiB,
  zero lifecycle effect) and authed `GET /api/runtime` exposes
  `startedAt` (uptime) — both feeding the statusline. Added 2026-09-06:
  `GET /api/runtime` also returns `serverCommit` (short git hash of the
  running backend, or null) and `webBuild` (the `assets/index-*.js` it is
  serving, or null); the UI's boot log line prints both beside its own
  `__BUILD_ID__` so a stale backend is visible in the log.
- **Session history with real per-conversation resume — decided and shipped
  2026-09-06, user's call** (reverses the 2026-07-19 "per-id `--resume` is a
  fiction" cut; rationale in `memory/decisions/session-history-resume.md`).
  Every session the app launches is kept across backend runs in
  `history.json` (data dir, 0600, atomic, bounded to 200 entries, oldest
  ENDED entries drop first, live ones never). Mechanism: a claude-kind
  session (`basename(command) === 'claude'`) whose client args carry no
  `--continue`/`-c`/`--resume`/`-r`/`--session-id` is spawned with an
  injected `--session-id <app session uuid>` (PTY argv only — never in
  `SessionInfo.args`, same rule as the injected `--settings`), so the app
  knows the Claude conversation id; resuming spawns `claude <base args>
  --resume <id>` server-side (`POST /api/history/:id/resume`). Every end
  reason is listed (user-kill, exit, shutdown, crash — crash stamped at
  boot for entries left open). Claude conversations whose transcript is
  PROVABLY absent (nothing was ever said) are pruned at list time: only when
  `<CLAUDE_CONFIG_DIR|~/.claude>/projects/<encoded realpath(cwd)>/` exists
  and `<id>.jsonl` is missing — every uncertainty keeps the entry. Requires
  **Claude Code ≥ 2.1.263** (`--session-id`, `--resume <id>`, `--effort`
  verified there); no version probe exists. **Known limit:** a launch with
  "Continue last conversation" (`--continue`) can never be pinned — its
  entry resumes with `--continue` again (most recent conversation in that
  folder) and its button reads "start again". A client-supplied
  `--session-id <uuid>` / `--resume <uuid>` (custom command) is adopted as
  the key. Blank session name → title = project name.
- **Logging: everything, by default — decided and shipped 2026-09-06,
  user's call** ("log everything"; trigger: the new UI ran against a stale
  backend, `/api/history` 404'd silently and nothing in the log said so).
  `server.log` in the data dir is the backend's ONLY diagnostic channel
  (detached process, stdio on /dev/null). One line per event,
  `<ISO> [level] [component] message`, levels `debug|info|warn|error`,
  minimum from env `AI_SM_LOG_LEVEL` (**default `debug`**). Logged: boot
  banner (node, pid, data dir, level, every set `AI_SM_*` override —
  redacted by name pattern and when a URL carries userinfo — server commit,
  frontend build), every HTTP request (method, pathname cut at 256 chars,
  `?…` for a query — never its values — status, ms, bytes), every WS
  upgrade/attach/detach/resize, session lifecycle, history load/list/prune
  decisions, lifecycle count transitions, store load/save, errors with
  stacks. Terminal input and PTY output are byte COUNTS summarized at most
  once per second per session — never content. Never written: the app
  token, the GitHub token, request/response bodies, `Authorization`,
  query-string values, PTY bytes; the generic request-failure line prints
  the error class and stack frames only, never the message (Node quotes ~10
  chars of a request body in `JSON.parse` errors — measured leak lesson of
  2026-07-25). The browser ships its own lines (errors, unhandled
  rejections, every API call as `path ?…` + status, WS open/close/reconnect,
  UI actions as SHAPE — never raw custom command text) through
  **`POST /api/client-log`** (token + Origin/Host like every route; body
  ≤ 64 KiB → 413, ≤ 50 entries, message ≤ 2048 chars truncated, C0/C1/U+2028/9
  stripped so one entry = one line, global 200 entries/min then dropped with
  one warn per window; tagged `[client]`). Anti-flood, because any web page
  can hit the port unauthenticated (a no-cors GET carries no Origin):
  lines for requests that did not carry a valid token — `/health`, the page
  and its assets, 401/403, a 404 on a mistyped route, rejected upgrades —
  share ONE budget of 60 log lines/min (one limiter instance for HTTP and
  WS), then one suppression count per window; a request that carried the
  token is never metered, whatever it answered (a token-bearing 404 on
  `/api/history` — the stale-backend symptom — is always written). Known
  limit: a page load spends ~6 unauthenticated slots, so ~10 reloads in a
  minute exhaust the window for that minute.
  Metering on STATUS (4xx only) was the first cut — review showed an
  unauthenticated `/health` flood still wiped the log in minutes.
  Rotation 10 MiB → `server.log.1` → `.2` (≤ 30 MiB, all 0600); if the
  rename fails the live file is truncated so logging never stops. 0600 is
  hygiene only — the Windows user reads every WSL file — so "never write the
  secret" is the actual control.
- **Manual backend restart + "new version" notice — decided 2026-09-06,
  user's call; preflight-first ("bulletproof update") decided 2026-09-08,
  user's call** (rationale in `memory/decisions/backend-restart-same-port.md`
  and `memory/decisions/restart-preflight-standby.md`).
  Authed `GET /api/runtime` carries `update: { available, reason }` — true
  when the code on disk is newer than the running process. Reasons, in
  precedence order: `dependencies changed` (package-lock.json newer than
  node_modules/.package-lock.json, or node_modules missing), `server code
  changed (a → b)` (git HEAD moved since boot), `frontend build missing`
  (no `web/dist`, no entry bundle, or no `build-id.json`), `frontend
  rebuilt` (dist newer than `startedAt` / entry bundle renamed), `frontend
  source changed` (web/src, web/index.html, web/public, vite.config.ts or
  shared/ newer than `web/dist/build-id.json`), `server files edited`.
  Cached ≤ 5 s; the UI polls every 30 s while visible; the raw reason never
  reaches the UI copy (mapped to plain sentences).
  `POST /api/restart` (authed) runs a **preflight while the old backend is
  fully intact** — sessions alive, listener open, data dir untouched:
  (1) dependency check → refuse; the app NEVER runs `npm install` (native
  `node-pty`, lifecycle scripts) — the user installs by hand; (2) frontend
  build, always: vite via `process.execPath` + argv array from the repo
  root into `web/dist-next`, verified (index.html, entry bundle,
  `build-id.json`), old dist served meanwhile; (3) a **standby child**
  spawned detached with a messages-only IPC channel and `AI_SM_STANDBY=1`
  that boots completely (imports, config, read-only history load) but
  binds nothing and touches nothing in the data dir, then reports
  `standby-ready`; a child that never reports, dies, or times out is
  refused. Any refusal answers **`422 { error }` with the old backend
  untouched and `web/dist` unchanged** (dist-next removed). Only after all
  three: swap dist-next into `web/dist` (restore on failure → 422; only a
  directory that looks like a frontend build — `index.html` + an entry
  bundle — is ever moved aside; `dist-prev` is kept until the handoff and
  reverted if the standby dies before teardown — including restoring an
  ABSENT `web/dist` — so every 422 leaves `web/dist` as it was — the two logged exceptions are a restore whose own rename fails, and a `dist-prev` that vanished under the app), end sessions exactly like `shutdown()` (history stamped `shutdown` →
  resumable from HISTORY), close the listener, send `go`, wait for the
  child's `runtime.json` + `/health`, answer `202 { port, startedAt,
  samePort }` (Connection: close) and exit WITHOUT unlinking
  `runtime.json`. The child on `go` runs the crash-stamp history load,
  resets session-settings, reads the swapped web build, and listens on the
  hinted port, falling back once to auto-pick (`samePort: false` → the UI
  says relaunch from the shortcut). Before `go` the child exits by itself
  on parent disconnect or a timeout measured from `standby-ready`, and its
  signal/uncaught handlers never unlink or write anything. **Same port is
  a hard constraint**: the WebView2 host locks navigation to the exact
  launch origin including the port. The hint is a handoff detail, not a
  fixed port — auto-pick stands. Sessions do NOT survive a restart
  (decided; no fiction). **A failed handoff after teardown is still not a
  rollback** (`500` + exit; the UI says relaunch) — that window is now only
  "the proven child could not bind". `409` for a second request while a
  preflight or handoff is in flight; `503` when no restart runner is wired
  (test harnesses). Env seams that belong to this handoff only:
  `AI_SM_PORT_HINT`, `AI_SM_RESTARTED_FROM`, `AI_SM_STANDBY`; and
  `AI_SM_WEB_DIST_DIR` (absolute and normalized, never root; the SERVED dist
  dir, so tests can drive a real restart without rebuilding the repo's
  `web/dist`; a bad value is refused with a `server.log` line). The
  restart dialog can be hidden during the preflight (sessions are still
  alive); the pill then reads `restarting…` and re-opens it; every outcome
  re-opens it; it locks only during the reconnect gap; closing it hands
  focus back to the element it was opened from when that is still visible
  (the Settings button, the toast), else to the terminal. PTY sessions
  inherit none of the four `AI_SM_*` handoff/seam vars. `web/dist-next/` and `web/dist-prev/` are
  gitignored. UI: Settings → BACKEND (`Restart backend`), a dismissible
  `New version available` toast, a persistent amber `update` pill after
  dismissal, a confirmation that names the running sessions and says they
  stay in HISTORY (plus a note when dependencies must be installed first);
  the dialog says "Preparing the new version…" while the preflight runs,
  "Reconnecting…" during the health wait, and on `422` "Nothing was
  restarted" with Close/Try again and the polls resumed. During the
  preflight the dialog can be put away (`Hide`, Esc, ×) WITHOUT aborting
  anything — every session is still alive and reachable, the flow runs on
  and the outcome re-opens it; during "Reconnecting…" it stays locked.
  A page whose token is rejected after boot WITHOUT having asked for a
  restart (another window restarted the backend) probes `/health` for 5 s
  and reloads once on the same origin; only silence shows the reload
  panel. The boot panel settles every step even when a handler throws
  (2026-09-08 incident: a bundle built from inside `web/` shipped a bare
  `__BUILD_ID__`; now
  `web/vite.config.ts` re-exports the root config and main.ts reads the id
  through `typeof`).
- **Port: auto-picked** (decided 2026-07-18). The backend binds `127.0.0.1`
  on an OS-assigned free port and publishes a runtime discovery file
  (`~/.ai-session-manager/runtime.json`: port, auth token, pid, startedAt;
  user-only readable) that the launcher and tools read — from Windows via
  `wsl.exe cat`. No fixed port anywhere.
- **Windows-side launcher** (thin): reads the discovery file and
  health-checks the discovered port; if the file is absent or stale, starts
  the backend via `wsl.exe -d <distro> -- ...` (**distro and repo path are
  derived from the launcher's own location — added 2026-09-08**: Windows sees
  the scripts as `\\wsl.localhost\<distro>\<linux path>\launcher`, which
  states both. `launcher/config-common.ps1` is dot-sourced by `launch.ps1` and
  `make-shortcut.ps1` so the two can never disagree. Precedence:
  `AI_SM_DISTRO`/`AI_SM_REPO_PATH` → derived from `$PSScriptRoot` → the
  hardcoded defaults `Ubuntu-24.04` / `/home/sava/projects/ai-cli-application`,
  reachable only when the launcher folder was copied OUT of the repo. Every
  value, whatever its source, passes the same allow-list —
  `^/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$` for the path, `^[A-Za-z0-9._-]+$` for
  the distro — which is the injection-safety gate, and a derived-but-invalid
  value FAILS instead of falling back to a default, so the launcher never
  starts a backend for a repo the user does not have. Distro keeps
  unique-prefix auto-resolution. Non-`-Silent` launches print one `Config:`
  line naming both values and their source; `make-shortcut.ps1 -DryRun` prints
  the resolution and the shortcut target without creating anything.), waits for
  file + health,
  then opens the UI. MVP launcher is a script + Edge `--app` chromeless window.
  **Native host brought forward (decided 2026-07-23):** a lightweight
  **WebView2** host window (uses the Evergreen runtime already present with
  Edge; no Rust toolchain) replaces the Edge `--app` window so the app owns
  its process → its own AppUserModelID + `app.ico` on the Windows taskbar
  (the Edge `--app` window cannot — see the icon note under Open decisions).
  It navigates only to `127.0.0.1:<port>`, navigation locked to that origin,
  and falls back to the Edge `--app` window if the WebView2 runtime is
  absent. **One sanctioned, one-way exit (2026-09-08, the `/login` fix):**
  a user-initiated off-origin `window.open` for an exact `http`/`https`
  target is handed to the user's default browser (ShellExecute, separate
  process; scheme allowlist enforced in C#, `host.log` records
  scheme+host only); every other scheme and every popup is dropped, and
  top-level navigation stays locked. The host also returns keyboard focus
  to the web content on window activation (the WebView2 control does not
  do that by itself after an Alt-Tab) and grants clipboard-read to the
  launch origin only (all other permissions denied silently). Its **window chrome is dark** (added 2026-07-24): DWM caption /
  text / border colors + immersive dark mode, matching the `--bg-app`,
  `--text-hd` and `--edge` tokens, because the DWM-drawn caption is outside
  the page and showed a white bar above the dark UI when maximized. The
  user chose this **DWM-coloring route over a frameless window with a
  custom in-page title strip**; frameless stays available as a later
  upgrade if the separate bar starts to grate. A full **Tauri** shell (tray,
  native folder picker) remains the later upgrade; this host is the minimum
  that fixes the taskbar identity.
- **Release build / distribution — added 2026-09-08, user's go.** The app
  itself is never packaged: it is installed by cloning the repo into WSL
  (`README.md` → Install). The only published artifact is the Windows-side
  native host window. A `v*` tag push runs `.github/workflows/release.yml`: an
  ubuntu `check` job (`npm ci`, `npm run typecheck`, `npm run build`, `node
  launcher/make-icon.mjs --check`), a windows `host` job running the existing
  `launcher/build-host.ps1` and packaging exactly the four build outputs flat
  as `AiSessionManagerHost-win-x64.zip` beside a `sha256sum`-compatible
  `SHA256SUMS.txt`, and a `release` job publishing both with `gh release create
  --verify-tag` (idempotent: a re-run uploads with `--clobber` and refreshes
  the notes). `workflow_dispatch` builds the same two files as a workflow
  artifact without releasing (unless dispatched on a `v*` tag).
  `.github/workflows/ci.yml` runs typecheck + build + icon check + `npm test`
  on push to `main` and every PR. Binaries are still never committed
  (`dist-release/` gitignored beside `launcher/host/build/`); the exe is
  unsigned (SmartScreen note in both READMEs); the version lives only in the
  tag. **Repo visibility is a separate, still-open user decision** — the
  Install section and the release download only work for others once the repo
  is public.
- WSL2 localhost forwarding is how Windows reaches the backend.

## Features (decided)

- **Projects**: stored in a `projects.json` — `{ id, name, path,
  defaultModel, defaultMode, createdAt }` (full schema: `shared/protocol.ts`). UI shows the project *name* everywhere (a project-less terminal session,
  launched into the home folder, is grouped under that folder's last
  segment in HISTORY — never a full path); the raw path
  appears only as secondary metadata inside the manage-projects view (needed
  to disambiguate add/delete). "Add project" = browse to a directory + give
  it a name.
- **Launch dialog = a short form (reshaped 2026-09-06, user's call: "far
  too many unnecessary things, no effort choice, too much code-ish text —
  plain short words, no explanation"); kind switch added 2026-09-08, user's
  call.** Header `New session`; first row `Session` = a segmented
  radiogroup `Claude · Terminal · Other` (same idiom as Mode); `Terminal`
  reveals a `Shell` row `WSL shell` (`/bin/bash -l`) · `PowerShell`
  (`powershell.exe -NoLogo` through WSL interop, ~8 s cold start, UNC-form
  prompt) in the project folder or, with no project, the home folder;
  `Other` reveals the mono Command field (the 2026-07-20 custom-command
  escape hatch — the footer toggle it used to live behind is gone, the
  hatch itself stays); the claude-only controls are hidden AND disabled for
  the other two kinds (hidden, not dimmed: dimmed plus the Shell row
  overflowed the dialog). Name, Project, Cancel and Launch are shared by
  all kinds; the claude-only set is exactly Model · Effort · Mode ·
  Continue. Fields: Name
  (placeholder = the selected project's name) · Project · Model · **Effort**
  (`default`, `low`, `medium`, `high`, `xhigh`, `max` → `--effort <v>`,
  default emits nothing) · Mode as one segmented row of the short labels
  `always ask` · `auto edits` · `read-only` · `no prompts` (danger red) ·
  a `Continue last conversation` checkbox (`--continue`) · Cancel · Launch.
  `composeSpawn()` is the ONE composition path for all three kinds. GONE: the subtitle, the preset chips, the readable
  launch summary / ink well, the footer note, the permission descriptions,
  hint text and mechanic-explaining tooltips. Per-id resume lives in the
  sessions drawer's HISTORY section, grouped per project folder. The
  launched "agent" is still a configurable command + args (multi-CLI
  support stays free).
- **Tabs and layouts**: interaction model redesigned (decided 2026-07-19,
  user request; recorded in
  `memory/decisions/anti-slop-design-direction.md`): **sessions are tabs**,
  and dragging one tab onto another forms a split view. **Implemented
  2026-07-19**: every session lives in exactly one view (= tab) holding 1–4
  panes; drag a tab onto a tab/pane to merge into a split, drag a pane
  header to the strip to extract, drag along the strip to reorder — every
  drag has a keyboard/button equivalent (see the shortcuts overlay). The
  arrangement is client-local, persisted as localStorage schema v2 with
  migration from v1. Either way, sessions exist independently of
  tabs/panes/splits.
- **Attention badges**: surface when a hidden session is waiting for input.
  Implemented: BEL (0x07) detection in output. Possible later: OSC
  sequences, Claude Code hooks.
- **App settings panel — GO given 2026-07-20; contents REVERSED 2026-07-25
  (user decision).** A checklist-style settings surface persisted
  server-side in `prefs.json` via `/api/prefs`. The 2026-07-20 "decided
  four" (default model, default permission mode, auto-run startup command,
  read-only usage display) are DELETED — their backends too (`/api/usage`,
  `/api/telemetry`, the auto-run registry, the global launch-defaults
  store). The panel now holds ONLY status-line configuration (next bullet).
  Launch-dialog pre-selection comes from per-project defaults in
  `projects.json` (which stay — a separate feature) with a hardcoded
  fallback; a per-launch choice always wins.
- **Terminal status line — decided 2026-07-25, shipped 2026-07-26,
  replacing the 2026-07-24 per-pane status strip (removed).** Claude Code
  draws its OWN status line inside each app-launched claude session; the
  app no longer renders a telemetry strip. Mechanism: the backend writes a
  per-session settings file (`<dataDir>/session-settings/<id>.json`) and
  appends `--settings <file>` to the spawned argv — key-level merge, that
  session only; the user's `~/.claude/settings.json` is NEVER read or
  written, and `CLAUDE_CONFIG_DIR` stays untouched. The file points Claude
  Code at `server/statusline.mjs`, which re-reads `prefs.json` on every
  invocation, so panel toggles reach RUNNING sessions live (~2 s), no
  restart. Items (each rendered only when toggled on AND an honest value
  exists): model, permission mode, git branch, cost, lines changed,
  context %, account usage % — the formerly-deferred `usage %` is now REAL
  via the payload's rate-limit data (Claude Pro/Max accounts, present
  after the first response). Known limit, documented in the UI: the
  permission-mode item shows the LAUNCH mode — Claude Code's payload
  carries no live mode, so a mid-session change (shift+tab) is not
  reflected. A blank line is normal for: sessions started before this
  feature (the panel names them and says to end + start them again), a
  not-yet-trusted workspace, and the moments before the first reply.
  Sessions whose client args already carry `--settings`, and non-claude
  commands, are left alone. Data-dir artifacts: `session-settings/`
  (0700, wiped at boot) and `statusline-cache.json` (0600, a ~5 s
  git-branch cache, wiped at boot).
- **Project creation + GitHub integration — GO given 2026-07-23, user's
  call; shape decided the same day.** The app stops being a passive
  registrar of existing directories and can *create* projects itself, and
  it grows a first-class GitHub connection. Decided pieces:
  - **GitHub auth = OAuth device flow** (user's choice 2026-07-23 over a
    pasted PAT or reusing the local `gh` CLI): the app registers as a
    GitHub OAuth app, the user approves a device code, and a scoped,
    revocable token is stored **server-side** in the data dir beside
    `prefs.json` (never in localStorage, never returned to the browser).
  - **A pasted token is a SECOND credential path — decided and LANDED
    2026-07-25, user's request.** Extends (does not replace) the
    device-flow decision: an "add token" affordance stores a user-pasted
    GitHub token server-side and uses it wherever the device-flow token is
    used. It needs no OAuth App, so it makes the feature usable before the
    client id exists — hence `configured` becomes `deviceFlowAvailable` and
    must never hide the paste affordance. **Persisted by default with a
    "remember this token" toggle** (off = process-memory only, gone when the
    backend exits). A security design gate ran *before* any code: storage
    ceiling is 0600 + discipline (no keyring exists here, verified; same-disk
    encryption is theatre), the UI must claim nothing stronger than "stored on
    this machine, readable by your own user account", it must recommend a
    fine-grained token limited to selected repositories with an expiry (which
    is strictly safer than our own `repo`-scoped device flow), show the
    resolved account before accepting, warn against pasting a token someone
    else supplied, and branch the revocation copy on the credential source.
    Full constraint list and refusals in
    `memory/decisions/github-token-paste-path.md`.
  - **v1 is the full shape** (user's call over a local-only first slice):
    (1) **create a local project** — new directory + register in
    `projects.json`, with an **"Initialize git repo" toggle (default on)**
    controlling the `git init` (decided 2026-07-24, reconciling the
    prototype's "no git init" caption with the earlier always-init: user
    chose a per-create toggle); (2) **clone** — from a pasted git URL
    (the Phase 2a foundation, no GitHub account needed) and, once connected,
    by picking from the user's in-app repo list (Phase 2c); (3) **create a
    new GitHub repo** from the app (local + create/push the remote).
    Phasing (implementation, 2026-07-24): **2a** = local create + URL clone +
    folder picker (landed); **2b** = GitHub OAuth device-flow connection +
    repo listing; **2c** = clone-by-picking + create-repo.
  - **OAuth scope = `repo` (write) up front** (decided 2026-07-24, over a
    read-only-then-escalate flow): a single device-flow grant covers list +
    clone + create-repo + push with no re-auth, matching the full v1 shape.
    The prototype's "read-only by default" caption is superseded.
  - **Security gate (non-negotiable):** the OAuth token is a new stored
    credential on a localhost service that already spawns shells. Every
    GitHub-touching endpoint stays behind the same token-auth +
    Origin/Host parity as the rest of `/api`; the GitHub token itself is
    never exposed to the page. `git clone`/`git init`/repo-create run via
    argv spawning (no shell string interpolation), into user-chosen paths
    validated the same way project paths already are. Token-bearing
    requests set `redirect: 'error'` (added 2026-07-24) so the guarantee
    that a credential never follows a redirect is enforced here rather
    than inherited from the runtime's fetch implementation. Threat-model
    detail in `memory/decisions/github-integration.md`.
  - **`AI_SM_GITHUB_API_BASE` is a test-only seam** (decided 2026-07-24,
    user's call, over gating it behind a build/run mode). It overrides the
    `api.github.com` REST base so the *connected* HTTP paths can be tested
    offline — the server spawns as a child process in tests, so no
    in-process seam can reach it. It is **loopback-only** (`127.0.0.1`,
    `localhost`, `[::1]`, no userinfo, no path/query/fragment) and any
    other value makes the server **refuse to start** (exit 1 before
    `listen`, no `runtime.json`), so it can never be a legitimate
    production or GHES setting. It moves neither the device-flow URLs nor
    the clone host-lock to `github.com`. Unlike the other `AI_SM_*` knobs
    this one has no production use by construction; that is deliberate and
    recorded rather than hidden.

- **No commands, flags, or code in the UI — decided 2026-07-25, user's call.**
  The GUI speaks plain human language; CLI syntax belongs in the terminal, not
  in the chrome around it. Concretely: permission modes render as **Always
  ask** / **Auto-approve edits** / **Read-only planning** / **Never ask ·
  dangerous** (never `acceptEdits`, `plan`, `bypassPermissions`) — since
  2026-09-06 the launch dialog uses the short forms `always ask` / `auto
  edits` / `read-only` / `no prompts` everywhere — resume reads
  **Continue last conversation** (never `--continue`), and the launch dialog's
  argv command preview was replaced by a readable summary, itself **removed
  2026-09-06** (the fields are the statement of what will run; nothing
  explains itself). Also out of the UI: the
  `git init` sample, the `/caveman` placeholder, `relaunch resumes claude with
  --continue`, `AI_SM_GITHUB_CLIENT_ID` in the GitHub setup card (that card
  says the server is missing a GitHub setting; the variable name lives in the
  README/docs, where acting on it belongs), the clone tab's `$ git clone <url>
  <dest>` preview (same treatment: `copies` / the pasted URL / `into folder:
  <dest>` — the URL stays, it is the user's own input), and the literal command
  name `claude` in the sessions drawer (the known agent renders as its product
  name `Claude Code`, the two built-in shells as `WSL shell` / `PowerShell`,
  in the active list AND the history rows; a user-typed custom command
  still echoes verbatim). The new-project dialog's
  **`standard` default-permission option was dropped** rather than renamed —
  it behaved identically to "no default", so a plain-language label would have
  promised enforcement it never delivered; a `standard` already stored in
  `projects.json` is still accepted. **UI language stays English** with
  plain words (user's call over a Dutch or mixed-language UI). Exempt by
  construction: the **custom-command field** (its content IS a command the user
  types — user's call to leave it unchanged) and terminal content itself.
  Docs, code, commit messages and agent briefs are unaffected — this is a UI
  copy rule.

## Hard technical constraints

- Every session needs a **real PTY** — the hosted CLIs are full TUIs (raw
  mode, alt screen, cursor control). Capturing stdout is not an option.
- **Resize must propagate**: pane resize → xterm.js fit addon → `pty.resize()`,
  or TUIs render garbage.
- Keyboard input goes **to the terminal** (Ctrl+C etc. must reach the PTY);
  app-level shortcuts must not collide with TUI keybindings. The app takes
  exactly two extra chords (2026-09-08): `Ctrl+Shift+V` and `Shift+Insert`
  paste the clipboard into the terminal (plain Ctrl+V is NOT intercepted —
  xterm sends it to the program in the terminal, which Claude Code uses
  itself). Discoverable (user's ask, 2026-09-08 "hoezo ctrl+shift+v?"): a
  `?` button in the top bar beside the gear opens the shortcuts overlay,
  whose paste row carries a one-line why; Settings has a KEYS section with
  the paste chords, Ctrl+click for links, and an `all shortcuts` link. When the window regains focus the
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

- Development happens inside WSL2 Ubuntu at `/home/sava/projects/ai-cli-application`.
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

## Open decisions (do not treat as settled)

Repo visibility (private today) — the release/Install docs are written for a public repo; going public also publishes the `memory/` vault, the author's home path in launcher defaults, and git author emails (2026-09-08).

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
bytes still held by the kernel are discarded. `server/sessions.ts` now
wraps `destroy` on node-pty's internal master read stream and
synchronously drains the fd there, feeding bytes into the same handler
`onData` uses — one ingress, no clock, loop ends on EIO/EAGAIN/0. This
depends on two undeclared node-pty internals (`fd`, `_socket`) and on
node-pty's own `pty_nonblock(master)` for the non-blocking guarantee that
makes a synchronous read safe, so **`node-pty` is pinned exactly to
1.1.0** (user's decision) and a version bump means re-running
`tests/sessions-tail.test.ts`. Accepted limit: a multi-byte character
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

(Settled 2026-07-18: port auto-pick + discovery file; vanilla TS + Vite
frontend; app data — projects.json, runtime.json, history.json (2026-09-06,
replacing journal.json + previous.json), prefs.json (added 2026-07-20: server-side UI prefs, since
localStorage dies with every auto-picked-port origin change), server.log —
lives in `~/.ai-session-manager/` (override: `AI_SM_DATA_DIR`), schema in
`shared/protocol.ts`. Rationale in `memory/decisions/`.)

(Settled 2026-07-19: backend lifetime bound to UI presence — see the
Architecture bullet; implemented the same day: presence WS + grace timers,
session journal with boot rotation, previous-sessions relaunch API and
drawer UI — the journal/previous part superseded 2026-09-06 by the session
history bullet.)

(Settled 2026-07-19: full GUI redesign, user's call after real use — the
anti-slop rule stands unchanged, but the phosphor skin is being replaced by
the **"steam blend"** direction chosen from rendered mockups committed under
`design-mocks/`; and the interaction model becomes sessions-as-tabs with
drag-to-split — see the Tabs-and-layouts bullet. Both shipped 2026-07-19:
the tab model, then the steam-blend skin (brief + slop-filter pass in
`web/DESIGN.md`; tokens in `web/src/styles/tokens.css`; chrome typeface is
self-hosted Barlow, OFL license committed beside the woff2 assets). Blend
definition and rationale in
`memory/decisions/anti-slop-design-direction.md`.)
