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
  `__BUILD_ID__` so a stale backend is visible in the log. Added
  2026-09-08 (installer phase A): `version` (the bundle version, null in a
  developer clone) and `installed` (boolean) — the body is exactly
  `{ startedAt, serverCommit, version, installed, webBuild, update }`.
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
  Start from "The last conversation in this project" (`--continue`; until
  2026-09-10 the "Continue last conversation" checkbox) can never be pinned — its
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
  Since phase E (2026-09-09) one more source: `launcher/run-update.ps1`'s
  stdout, piped by the backend (bounded 64 KiB, `debug` on exit 0, `warn`
  otherwise, every line through `oneLine()`), which on failure includes the
  last 30 lines of the Setup's own `setup.log`.
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
  source changed` (web/src, web/index.html, web/mascot.html, web/public, vite.config.ts or
  shared/ newer than `web/dist/build-id.json`), `server files edited`.
  **Installed mode (2026-09-08) emits exactly one reason instead of these
  six: `a new version is installed`** — `<app>/current` resolves to a
  sibling version dir with a valid `bundle.json` other than the one this
  process runs from (a half-finished or out-of-tree `current` never lights
  the pill).
  Cached ≤ 5 s; the UI polls every 30 s while visible; the raw reason never
  reaches the UI copy (mapped to plain sentences).
  `POST /api/restart` (authed) runs a **preflight while the old backend is
  fully intact** — sessions alive, listener open, data dir untouched:
  (1) dependency check → refuse; the app NEVER runs `npm install` (native
  `node-pty`, lifecycle scripts) — the user installs by hand; (2) frontend
  build, always: vite via `process.execPath` + argv array from the repo
  root into `web/dist-next`, verified (index.html, entry bundle,
  `build-id.json`), old dist served meanwhile — **in installed mode
  (2026-09-08) steps 1–2 become "verify the target bundle"**: `current`
  must resolve to a direct child of `<app>/` holding a valid `bundle.json`,
  `server/index.ts`, an executable `node/bin/node` and a built `web/dist`;
  nothing is built, staged or swapped, and the standby is spawned from the
  TARGET's own runtime (`<target>/node/bin/node <target>/server/index.ts`);
  (3) a **standby child**
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
  resumable from the session history), close the listener, send `go`, wait for the
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
  alive); the pill then reads `Restarting` and re-opens it; every outcome
  re-opens it; it locks only during the reconnect gap; closing it hands
  focus back to the element it was opened from when that is still visible
  (the Settings button, the toast), else to the terminal. PTY sessions
  inherit none of the `AI_SM_*` handoff/seam vars (the four here plus
  `AI_SM_HOME_OVERRIDE`, B2). `web/dist-next/` and `web/dist-prev/` are
  gitignored. UI: Settings → Background service (`Restart service`, since Nocturne A7 2026-09-13), a dismissible
  `New version available` toast, a persistent amber `Update` pill after
  dismissal, a confirmation that names the running sessions and says they
  stay in History (plus a note when dependencies must be installed first);
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
- **Port: the last one first, auto-pick as the fallback** (decided
  2026-07-18 as auto-pick only; amended 2026-09-22, Nocturne B6 decision 5,
  user's call: the tab layout lives in localStorage, which is tied to the
  origin INCLUDING the port, so a new port on every start threw the layout
  away). The backend remembers the port it bound in
  `<dataDir>/last-port.json` (0600, atomic, gated on read to an integer
  1024–65535 — a missing file is the silent first run, anything else is
  ignored with one debug line; opened `O_NOFOLLOW|O_NONBLOCK` and judged by
  `fstat` first, so a planted FIFO or link cannot hang the boot) and tries it first
  on every start through the same hint path a restart handoff uses
  (`AI_SM_PORT_HINT` beats the file; a busy port falls back to an
  OS-assigned one — `last port N busy, auto-picked M, keeping N for next
  time`: the remembered port is NOT overwritten by a fallback, so a
  transient squatter — typically another process's outgoing connection
  holding that number as its ephemeral source port for a moment — cannot
  move the origin for good). It binds `127.0.0.1`
  and publishes a runtime discovery file
  (`~/.ai-session-manager/runtime.json`: port, auth token, pid, startedAt,
  and since 2026-09-08 `appDir` — the app root the process was loaded from
  (a realpath under Node's default symlink resolution), so an installer never
  prunes a live version dir; user-only readable) that the launcher and tools read — from Windows via
  `wsl.exe cat`. No fixed port anywhere.
- **Windows-side launcher** (thin): reads the discovery file and
  health-checks the discovered port; if the file is absent or stale, starts
  the backend via `wsl.exe -d <distro> -- ...` (**distro and repo path are
  derived from the launcher's own location — added 2026-09-08**: Windows sees
  the scripts as `\\wsl.localhost\<distro>\<linux path>\launcher`, which
  states both. `launcher/config-common.ps1` is dot-sourced by `launch.ps1` and
  `make-shortcut.ps1` so the two can never disagree. Precedence (installer
  phase B, 2026-09-09): `AI_SM_DISTRO`/`AI_SM_REPO_PATH` → **`launcher-config.json`
  beside the scripts** (written by the Setup; a corrupt or non-string file is
  an ERROR, never a fall-through) → derived from `$PSScriptRoot` → the
  built-in defaults, which are now **EMPTY**: nothing resolvable = a
  message naming the three fixes, never someone else's repo. Every value,
  whatever its source, passes the same allow-list — defined ONCE in
  `config-common.ps1` (`Test-AiSmLinuxPath`, `Test-AiSmDistroName`,
  `Test-AiSmDataDir`; `^/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*\z` for the path,
  `^[A-Za-z0-9._-]+\z` for the distro — `\z`, not `$`, which in .NET admits
  a trailing newline) and shared with every `installer/helpers/*.ps1` — which
  is the injection-safety gate, and a derived-but-invalid value FAILS instead
  of falling back to a default, so the launcher never starts a backend for a
  repo the user does not have. When the scripts are NOT on a UNC
  path (an installed copy) the WebView2 host runs in place from `host\`;
  the `%LOCALAPPDATA%` staging copy + `Unblock-File` pass is kept for any
  `\\` path (the repo-clone case). Distro keeps
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
  launch origin only (all other permissions denied silently). **Since
  Nocturne B10 (2026-09-20) the host also carries ONE page→host message
  channel**, `WebMessageReceived`, origin-locked to the launch origin
  before a byte of the message is read: the string `copy-files\n<windows
  path>…` (1..100 paths, each already mapped and boundary-checked by the
  backend's `GET /api/fs/winpath`) is shape-checked only (UNC
  `\\wsl.localhost\<distro>\…` or `<Letter>:\…`, no control chars, no
  `/`, no `.`/`..` segment or distro, none of `* ? " < > | :`, no trailing
  dot or space; the whole message refused on the first bad path), put on
  the clipboard with `Clipboard.SetFileDropList` (STA UI thread, one 100 ms
  retry), and answered `copy-files ok <n>` / `copy-files failed`; nothing
  is opened, resolved or executed; `host.log` records a count and an
  exception CLASS, never a path or a message; `AreHostObjectsAllowed` is
  off; the `.cs` targets .NET Framework 4.7.2 explicitly so paths of 260+
  chars work. No drag OUT of the app, no clipboard READ in the host. Its **window chrome is dark** (added 2026-07-24): DWM caption /
  text / border colors + immersive dark mode, matching the `--color-bg`,
  `--color-neutral-200` and `--color-neutral-800` tokens (the Legacy alias
  names `--bg-app`/`--text-hd`/`--edge` died in Nocturne A8, 2026-09-14), because the DWM-drawn caption is outside
  the page and showed a white bar above the dark UI when maximized. The
  user chose this **DWM-coloring route over a frameless window with a
  custom in-page title strip**; frameless stays available as a later
  upgrade if the separate bar starts to grate. A full **Tauri** shell (tray,
  native folder picker) remains the later upgrade; this host is the minimum
  that fixes the taskbar identity.
- **Release build / distribution — added 2026-09-08 (user's go; CI/CD
  gate the same day: "before every deployment everything is tested
  automatically", "cicd moet in github staan"); extended 2026-09-09 for the
  installable product.** One reusable workflow, `.github/workflows/verify.yml`
  (`on: workflow_call`), is the single definition of "verified": a `check`
  job (`npm ci`, `npm run typecheck`, `npm run build`, `node
  launcher/make-icon.mjs --check`), a `test` job (`npm ci`, `npm run build`,
  `npm test` — the full suite, real servers and PTYs, on ubuntu-latest) and,
  since 2026-09-09, a `bundle` job on **ubuntu-22.04** (glibc 2.35 floor)
  that runs `scripts/build-bundle.sh` with its smoke test and uploads
  nothing — CI proves the same build the release ships. Status-check names:
  `verify / typecheck + build`, `verify / backend test suite`, `verify /
  linux bundle`. `.github/workflows/ci.yml` calls it on push to `main` and
  every PR. A `v*` tag push runs `.github/workflows/release.yml` with five
  jobs: `verify` (the reusable workflow on the tagged commit), `host`
  (windows: `launcher/build-host.ps1` → `AiSessionManagerHost-win-x64.zip`),
  `bundle` (ubuntu-22.04: computes the version ONCE — the tag, or
  `0.0.0-dev+<sha>` off-tag — into `VERSION.txt` and builds
  `ai-session-manager-linux-x64.tar.gz`), `installer` (windows, `needs:
  [host, bundle]`: lays out `installer/payload/`, refuses loudly when
  `ISCC.exe` is absent, compiles `AI-Session-Manager-Setup-<version>.exe`),
  and `release` (`needs: [verify, host, bundle, installer]`: re-hashes every
  downloaded asset into ONE `SHA256SUMS.txt`, `sha256sum -c`, then `gh
  release create --verify-tag` with the four assets — Setup exe first in the
  notes, bundle tarball, host zip, checksums, the unsigned-binary paragraph).
  A red suite or a failed bundle/installer blocks the publish; a re-run is
  idempotent (`--clobber`, notes refreshed). `workflow_dispatch` builds all
  artifacts and publishes nothing unless dispatched on a `v*` tag — **this
  is how the Setup.exe reaches the user for a Windows test before a version
  is tagged (user's call 2026-09-09: v0.2.0 only after that test)**. One
  `NODE_VERSION` per workflow file (equal in both, pinned by test) feeds
  setup-node AND `build-bundle.sh --node`, so the suite runs on the exact
  runtime that gets bundled. Actions are GitHub-owned and SHA-pinned;
  `permissions: {}` at the top, `contents: read` on build jobs, `contents:
  write` only on `release`; `persist-credentials: false`; no `${{ }}` inside
  `run:`. Tagging is done with `npm run release -- vX.Y.Z [--dry-run]`
  (`scripts/release.sh`): it refuses unless the tree is clean, the branch is
  `main`, `HEAD` equals `origin/main`, the tag is unused locally and on
  origin, and the `CI` run for exactly that commit concluded success; only
  then `git tag -a` + `git push origin refs/tags/<tag>`. Binaries are never
  committed (`dist-release/`, `build/`, `installer/payload/` gitignored);
  both exes are unsigned (SmartScreen note in the READMEs); the version lives
  only in the tag. Branch protection: ruleset `protect-main` (force-push +
  deletion blocked, no required checks) since 2026-09-09.
  **Go-public decisions (user, 2026-09-09):** the `memory/` vault goes public
  with the repo; commits use `182082793+YaroslavSavchenk@users.noreply.github.com`
  (set repo-locally; history is not rewritten, so older commits keep the
  author's e-mail and 13 of them still contain the old home path);
  `tests/no-author-paths.test.ts` is the standing guard against the author's
  paths re-entering tracked files; the repo was flipped to PUBLIC on 2026-09-09 right after phase D
  landed and CI was green; **v0.2.0 is tagged only after the user has tested the Setup.exe on
  Windows** (a `workflow_dispatch` run produces it as the
  `AI-Session-Manager-Setup` artifact).
- **Installer and self-contained bundle — decided 2026-09-08 (user's call:
  "a real app, frontend + backend, so other people can use it easily"),
  IN PROGRESS; supersedes "the app itself is never packaged" above.**
  Four user decisions: (1) the WSL side is a **self-contained bundle**
  (`ai-session-manager-linux-x64.tar.gz`, built in CI: pinned official Node
  24 runtime verified against nodejs.org `SHASUMS256.txt`, backend, production
  `node_modules` with node-pty compiled on ubuntu-22.04 for glibc reach,
  built `web/dist`, `start-backend.sh`, a version marker) — end users need no
  Node, git or build tools; (2) **explicit opt-in for anything third-party**
  the installer offers to install (e.g. Claude Code inside the distro) — a
  consent page lists each item, nothing third-party is ever installed
  silently; (3) **Inno Setup**, unsigned, per-user (no admin), with an
  uninstaller, built on the windows runner (ISCC preinstalled); (4) **no
  WSL2 / no distro → explain and stop** (`wsl --install` message, never
  elevates). Working layout: WSL `~/.ai-session-manager/app/<version>/` +
  `current` symlink (data dir untouched by install/uninstall); Windows
  `%LOCALAPPDATA%\Programs\AI Session Manager\` with launcher scripts,
  icon, host exe and an installer-written launcher config (distro + app
  path; precedence env → config file → UNC-derived → defaults, same
  allow-list gate) plus `install-info.txt` (`distro`/`appDir`/`version`,
  key=value, the uninstaller's only input). The WSL app dir MUST end in
  `/app` with ≥ 3 segments — enforced at install time so the uninstall guard
  (allow-listed, ends in `/app`, holds ≥ 1 `<v>/bundle.json`) is always
  checkable; the Windows dir page is disabled (`/DIR=` still works).
  Retention: `current` + one previous + whatever a live pid runs from (read
  from `runtime.json.appDir` + `kill -0`); a same-version reinstall of the
  RUNNING version is refused (close or restart first). **Every `wsl.exe`
  invocation in the installer helpers uses `--exec`** (measured 2026-09-08:
  with `--` wsl.exe re-joins argv and the default shell expands `$1`/`$(…)`
  before `sh -c` sees them; the launcher's older `-- bash -lc "<one
  string>"` start line is safe only because that string holds nothing but
  allow-listed values — any NEW call with positional args uses `--exec`);
  the constant unpack/remove scripts contain no double quotes, positional
  args are allow-listed first, and the tarball travels over stdin so no
  Windows path ever reaches a Linux command line. Test-only seams:
  `-DryRun` on all helpers (prints the exact argv) and `wsl-probe.ps1
  -ListFile` (a committed UTF-16LE `wsl -l -v` fixture). Backend gains an **installed mode** (version marker
  present): banner shows the bundle version, dependency check skipped, the
  restart preflight serves the bundled `web/dist` instead of rebuilding,
  `update.available` = `current` points at a different version dir than the
  running process. v1 updates = run the newer Setup.exe (upgrades in place,
  keeps data), then the in-app restart. ~~In-app update *checking* over the
  network is out of scope~~ — **REVERSED 2026-09-09 evening, user's call
  ("melding en hetzelfde knop, zoals andere apps"): phase E adds the
  in-app updater** (see the bullet "In-app update" below); the "Check for
  updates" link stays as the manual fallback. The clone-and-`git pull`
  developer path keeps working unchanged. The repo goes **public** (user
  flips; go-public prep = phase D). Release assets become: Setup exe, bundle
  tar.gz, host zip, `SHA256SUMS.txt`.
  **`AI_SM_NODE_DIST_BASE` is a test-only seam of `scripts/build-bundle.sh`**
  (2026-09-08, same precedent): it may only be `file://…` or
  `https://nodejs.org/dist`; anything else makes the script refuse before any
  download, so "verified against nodejs.org's SHASUMS256.txt" can never
  silently mean "verified against a mirror that agrees with itself". The sums
  file itself is not signature-checked (accepted for v1). The bundle job is the
  `verify / linux bundle` check in `verify.yml` and the `bundle` job in
  `release.yml` (phase C, 2026-09-09).
- **In-app update — decided 2026-09-09 evening (user's call: a
  notification and ONE button, like other apps; the same experience the
  clone-based app had with "New version available → Restart"), phase E.**
  Installed mode only; a developer clone and a `0.0.0*` bundle make no
  outbound request and answer `422` on `POST /api/update`. **Check**
  (`server/update-release.ts`): 20 s after `listen`, then every 6 h (15 min
  backoff × 3 on failure; never in a standby child), one GET to
  `api.github.com/repos/<owner>/<repo>/releases/latest` with ETag /
  `If-None-Match`, no credentials, 15 s timeout, 1 MiB body cap; the release
  passes only if not draft/prerelease, the tag matches the version shape,
  the Setup asset name and both asset URLs EQUAL what the backend constructs
  itself, and the size is ≤ 200 MiB; the answer is cached in
  `<dataDir>/update-check.json` (0600, atomic, ≤ 8 KiB, every field gated on
  read; what is cached is the LATEST RELEASE DESCRIPTOR (`latest`), never the
  verdict — the ETag validates only the payload, so "newer than what I run" is
  decided at USE time; the field was renamed `release` → `latest` on purpose,
  so a file in the old shape fails the read and costs one unconditional 200).
  Precedence: `a new version is installed` (the bundle on disk moved)
  beats `a new version is available` (online); `/api/runtime.update.release`
  carries the offer. **Button** (`POST /api/update`, authed, no body:
  `202 {version}` · `409` in flight · `422` nothing / not installed · `503`
  no updater; progress via `GET /api/update/status` polled at 1 Hz;
  since Nocturne B6 (2026-09-22) `POST /api/update/check`, authed, no body,
  runs the release check NOW — a check already in flight, the periodic
  one included, is shared, never doubled — and answers the same composed
  status `/api/runtime` carries, 503 without a checker; its access line
  carries `note="<constant sentence>"`, the one 2xx route that logs an
  outcome, `reason=` stays a refusal word):
  `server/update-install.ts` downloads `SHA256SUMS.txt` then the Setup as
  `<dataDir>/updates/<version>/<name>.part` with the SHA-256 computed inline,
  exact size, 200 MiB cap, 60 s idle / 15 min total, free-space precheck,
  manual redirects ≤ 3 hops to `github.com` / `*.githubusercontent.com`
  only; a mismatch unlinks the `.part` — the `.part` → `.exe` rename after
  the check is the ONLY way a runnable file ever exists. It then probes
  `%TEMP%` once (`cmd.exe /c echo %TEMP%` → validated → `wslpath -u`), stages
  the exe + `launcher/run-update.ps1` (from the bundle) there through the
  drvfs mount, and runs `powershell.exe` by full path with argv only
  (`-File run-update.ps1 -SetupPath … -ExpectedSha … -LogPath …`); the
  script re-hashes with `Get-FileHash`, refuses on mismatch (exit 2), and
  runs the Setup `/SILENT /SUPPRESSMSGBOXES /NORESTART`; a Setup that has
  not returned after 15 min counts as failed, but the single flight stays
  HELD until that child really exits (a second `Update` answers `409` until
  then; `SetupMutex=AiSessionManagerSetup` is the second lock against two
  concurrent Setups), and the idle-shutdown deferral that an install earns
  ends with the install's active states, never with a held flight. The
  script's stdout is piped into `server.log` (bounded 64 KiB, `debug` on
  exit 0, `warn` otherwise, incl. the last 30 lines of Inno's `setup.log`
  on failure). `POST /api/restart` answers `409` while an install is
  downloading/verifying/installing (a handoff would wipe the `.part`). **The Setup closes nothing
  (flow B)**: `CloseApplications=no` stays, there is no `[Run]`; Windows
  scripts are replaced (not in use), the host binaries land in
  `{app}\host\next` and are promoted to `{app}\host` by the launcher at the
  NEXT start (`Move-AiSmHostNext`, retries, never fails a launch); the WSL
  bundle is unpacked and `current` flipped by the existing helper with its
  live-dir guards; then the existing installed-mode checker reports `a new
  version is installed` and the UI continues AUTOMATICALLY into the proven
  same-port `POST /api/restart` handoff — sessions end like Restart, the session history
  keeps them, the page reloads on the same origin. A silent upgrade reuses
  the previous install's distro and app dir from `install-info.txt`
  (`LoadPreviousInstall`, read via `WizardDirValue` — `{app}` cannot be
  expanded in `InitializeWizard`), never the WSL default. Rejected: closing
  and relaunching the app from the Setup (the old backend survives the 30 s
  grace, so the relaunch attaches to it; `CloseApplications=yes` makes the
  wizard ask too). UI: toast verb `Update` vs `Restart now` by reason; one
  dialog (`Update the app?` → `Downloading… n%` → `Verifying…` →
  `Installing…` → the restart phases); failure = `Nothing was updated` + a
  constant sentence + `Download it yourself` (the one sanctioned browser
  exit); pill `Updating`; a reload mid-install re-adopts progress. Test
  seams: `AI_SM_UPDATE_API_BASE` (loopback-only, refuse-to-start otherwise;
  collapses the asset allow-list to itself), `AI_SM_UPDATE_FIRST_MS`,
  `AI_SM_UPDATE_INTERVAL_MS` (floored at 1000 ms with a boot warning, capped
  at the timer maximum). The exe stays unsigned (signing declined
  2026-09-09); a backend-written file carries no Mark-of-the-Web, so
  SmartScreen does not interrupt this route. Details and rejected
  alternatives: `memory/decisions/in-app-update.md`.
- WSL2 localhost forwarding is how Windows reaches the backend.

## Features (decided)

- **Projects**: stored in a `projects.json` — `{ id, name, path,
  defaultModel, defaultMode, createdAt }` (full schema: `shared/protocol.ts`). UI shows the project *name* everywhere (a project-less terminal session,
  launched into the home folder, is grouped under that folder's last
  segment in the Sessions panel's `Earlier` list — never a full path); the raw path
  appears only as secondary metadata inside the manage-projects view (needed
  to disambiguate add/delete). "Add project" = browse to a directory + give
  it a name.
- **Launch dialog = a short form (reshaped 2026-09-06, user's call: "far
  too many unnecessary things, no effort choice, too much code-ish text —
  plain short words, no explanation"); kind switch added 2026-09-08, user's
  call; Nocturne layout (part A4) 2026-09-10, user's calls on the three v3
  conflicts.** Header `New session`, no subtitle; the modal is anchored at a
  stable top so switching Tool never moves the grid under the pointer.
  First group `Tool` = a 2-per-row card radiogroup (roving tabindex, arrow
  keys): **Claude Code · Codex · Gemini CLI · Grok · Terminal · Other**.
  **Since Nocturne B5 (2026-09-18, spec `.claude/plans/nocturne/PLAN-B5.md`) all four AI
  tools are live**; a card whose executable the backend cannot find on the
  PATH of the very environment it spawns sessions with (`GET /api/tools`,
  a stat-only probe cached 5 s, fetched on every dialog open) is inert
  (`aria-disabled`, never selectable, skipped by the arrows, sub-line
  `Not installed`), and until the first answer every non-composable card is
  inert with no sub-line at all — the dialog never flashes a row of enabled
  cards that then go dark. `Other` is the 2026-07-20 custom-command escape
  hatch as the sixth card (user's call 2026-09-10, v3 has none) and reveals
  the mono Command field. `Terminal` reveals `Shell` cards **Bash**
  (`/bin/bash -l`) · **Zsh** (`zsh -l`, B5) · **PowerShell** (`powershell.exe
  -NoLogo` through WSL interop, ~8 s cold start, UNC-form prompt; v3's
  `pwsh.exe` NOT adopted — not installed, plan decision 6) · **Command
  Prompt** (B5, plan decision 6: `cmd.exe` through interop; the client sends
  NO args and the SERVER appends `/k pushd <windows path of the cwd>` — cmd
  refuses a UNC working directory and would land in `C:\Windows` — computed
  by a pure function (`/mnt/<d>/…` → `D:\…`, else
  `\\wsl.localhost\<WSL_DISTRO_NAME>\…`) and appended ONLY when the cwd
  matches the launcher's allow-list shape without dot segments and the distro
  name is well-formed, since cmd parses its own command line; otherwise plain
  `cmd.exe` plus one warn line — the user is not told in the UI, recorded),
  in the project folder or, with no project, the home folder. The
  tool-specific controls are hidden AND disabled for the other kinds (hidden,
  not dimmed). Shared by all kinds: Name (optional; placeholder = the
  selected project's name) and Project on one row, Cancel and **Start
  session** (was Launch). The Claude Code set is exactly Model · **Effort**
  (`default`, `low`, `medium`, `high`, `xhigh` shown as "Extra high", `max`
  → `--effort <v>`, default emits nothing) · **Permissions** as a 2×2 card
  radiogroup `Always ask` · `Auto edits` · `Read only` · `No prompts`
  (danger red) · **Start from** `A fresh conversation` / `The last
  conversation in this project` (`--continue`; replaced the checkbox) / one
  entry per ENDED conversation of the selected project (B5: the Earlier
  section's entries, newest first, `<title>, <relative time>`; with no
  project, home-folder conversations; choosing one presets Name and emits
  `--resume <id>` in place of `--continue`; the server answers `409 That
  conversation is already running.` when that entry is live and the dialog
  shows it). The other tools reuse the same controls with their own
  vocabularies — the mapping lives in `web/src/ui/launch-args.ts` ONLY, argv
  order fixed model → permission → effort → start tail, pinned byte-exact:
  **Codex** (models `Default` + the documented GPT ids; Effort `Default`,
  `minimal`…`xhigh` → `-c model_reasoning_effort=<v>`; Always ask `-a
  on-request -s read-only`, Auto edits `-a on-request -s workspace-write`,
  Read only `-a never -s read-only`, No prompts
  `--dangerously-bypass-approvals-and-sandbox`; Start from `A fresh session`
  / `The last session` (`resume --last`) / `Pick an earlier session`
  (`resume`, Codex's own picker), options before the subcommand);
  **Gemini CLI** (models `Auto` (emits nothing), `Pro`, `Flash`, `Flash
  Lite` → `-m`; NO effort control (no flag exists); `--approval-mode
  auto_edit|plan|yolo`, Always ask emits nothing; Start from fresh / `The
  last session` = `-r latest`); **Grok** (Grok Build, xAI's own CLI — built
  from its docs, not installed here: models `Default`, `Grok 4.6`; Effort
  `Default`, low, medium, high → `--effort`; only Always ask (nothing) and No
  prompts (`--always-approve`) — `Auto edits` and `Read only` are inert
  cards with the hint `Grok switches this inside the session`; Start from
  fresh / `The last session` = `--continue`). `modelLabel()` names every id
  the dialog can emit the way the dialog showed it (ids unique across the
  four tables); an unknown id (a custom command) is echoed verbatim. **One
  info button** beside the Permissions label opens a short plain explanation
  of the four modes (`PERM_HELP`, the same four generic lines for every tool
  — an accepted approximation of Codex's sandbox semantics) — with the B5
  key notice and the Grok hint the only explanatory copy in the dialog
  (user's call 2026-09-10: labels only on the cards, one on-demand
  explanation); Esc closes that popover first. v3's command preview is left
  out (user's call 2026-09-10; the no-code rule stands). **API keys (B5,
  plan decision 4, user 2026-09-18):** Gemini CLI and Grok show a quiet
  notice `Needs an API key, or sign in inside the terminal the first time.`
  + `Add key` (→ Settings → Preferences, that tool's field focused) when no
  key is saved AND the backend's own environment lacks the variable; Claude
  Code (login is the norm) and Codex (a key alone does not sign it in — it
  signs in inside the terminal, no field) show none. `composeSpawn()` is
  the ONE composition path for all kinds, and every pre-A4 dialog state
  emits byte-identical argv (pinned through the real dialog by
  `tests/ui-launch-dialog.test.ts`). GONE since 2026-09-06: the
  subtitle, the preset chips, the readable launch summary / ink well, the
  footer note, per-card permission descriptions, hint text and
  mechanic-explaining tooltips. The launched "agent" is still a
  configurable command + args (multi-CLI support stays free).
- **Stored API keys + the B5 spawn-time injections (Nocturne B5,
  2026-09-18; rationale `memory/decisions/b5-tools-keys-and-shells.md`).**
  `<dataDir>/keys.json` (0600, atomic, `{ claude?, gemini?, grok? }`) is
  the fourth data-dir artifact holding a secret — the same ceiling as the
  GitHub token: the value is never logged (only `key saved/cleared/rejected
  for <tool>`), never returned to the page, never in argv. Values are gated
  to 1–4096 printable non-space ASCII on save AND on load, so a hand-edited
  file can never put a control character into an environment. Routes (token
  + Origin/Host like every `/api` route): `GET /api/tools` →
  `ToolAvailability` (an async stat-only PATH lookup in `ptyEnv()`'s PATH —
  the probe and a spawn can never disagree — cached 5 s, never a spawn,
  relative/empty PATH entries skipped); `GET /api/keys` → `KeyStatus`
  (`saved` / `env` booleans); `PUT /api/keys/:tool` (`{ key }`, JSON only,
  8 KiB cap, `400 That does not look like an API key.` / `Unknown tool.`);
  `DELETE /api/keys/:tool` (idempotent). Two NEW narrow injections in
  `server/sessions.ts`, beside `--settings` and `--session-id`, both by
  `basename(command)`, PTY-only, never in `SessionInfo.args`, re-applied on
  resume: (1) a SAVED key becomes that tool's variable in the child
  environment (`ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `XAI_API_KEY`; a
  saved key beats an inherited one, no saved key = untouched, so a variable
  set in the user's shell still reaches the CLI; known consequence: the CLI's
  own child processes inherit it, as with any env-var key); (2) `cmd.exe`
  launched with NO client args gets `/k pushd <windows path>` (see the
  launch-dialog bullet). `POST /api/sessions` answers `409` when a
  client-supplied `--resume <uuid>` targets a history entry that is still
  live. Not built by decision: keys for Codex; `pwsh.exe`.
- **Ending a session = a signal ladder on the process GROUP (2026-09-20,
  found by B5's verify-terminal pass; rationale in
  `memory/decisions/b5-tools-keys-and-shells.md` § 5).** `DELETE
  /api/sessions/:id` sends SIGHUP (`pty.kill()`, what a closing terminal
  sends), then after 2 s SIGTERM to `-pid`, then after 3 more s SIGKILL to
  `-pid` — node-pty's forkpty child is a session leader, so the negative pid
  reaches every descendant the CLI spawned; each rung is skipped once the
  whole group is gone (`process.kill(-pid, 0)` → ESRCH; a live group pins
  its leader's pid number, so the probe cannot hit a reused pid). Server
  shutdown and restart send SIGHUP + immediate group SIGKILL, including for
  ladders still in flight for sessions already removed. Why: Gemini CLI 0.60
  (a wrapper that relaunches itself as a child) ignores SIGHUP and SIGTERM
  sent to the leader alone, so an ended session kept running with the
  stored `GEMINI_API_KEY` in its environment after the user had removed the
  key. Known limits, recorded: a descendant that `setsid`s out of the group
  escapes the ladder (same uid — it could read the key anyway); a root-owned
  member survives silently; shutdown's SIGHUP+SIGKILL in one tick loses
  in-flight shell history (UX, user's call).
- **The commits routes (Nocturne B3, 2026-09-21; spec
  `.claude/plans/nocturne/PLAN-B3.md`, rationale
  `memory/decisions/b3-commits-live.md` and
  `memory/knowledge/git-read-calls-run-repo-config.md`).** Three authed GETs
  beside `/api/git/changes`, same home/project boundary on `root`, in
  `server/git-log.ts` on B2's one git runner: `GET /api/git/commits?root&limit
  (1..50, default 10)&skip&from` (the history of HEAD, newest first, `total`
  from `rev-list --count` — a floor when that times out — `more`, paging
  pinned by `from=<head of page one>`; not a repository = 200 `isRepo:false`;
  an empty one = `branch` + `head:null`), `GET /api/git/commit?root&hash`
  (subject, body ≤ 8 KiB, author NAME, committer name only when it differs,
  both dates, parents, branch, the files with `+a -d` ≤ 2000 then `truncated`,
  and `github: { owner, repo } | null` parsed from `origin` — github.com
  only, https and the ssh/scp spellings, a credential in the URL discarded
  and never in a response or a log line), `GET
  /api/git/commit-diff?root&hash&path` (one file of one commit as numbered
  lines; `binary`; `tooLarge` past 2000 lines, decided from numstat before
  the patch is asked for). Every client string is gated BEFORE argv: `hash` /
  `from` `^[0-9a-f]{40}$` then `rev-parse --verify --quiet <h>^{commit}`
  (400 `The app cannot open that commit.` / 404 `This commit is no longer
  there.`), `limit` / `skip` strict integers, `path` relative without
  `.`/`..`/NUL and only after `--`. Nothing the repository configures may run
  or reshape: `--no-show-signature --no-notes --no-color --no-ext-diff
  --no-textconv --no-renames --diff-merges=first-parent --encoding=UTF-8
  -O/dev/null`, `--no-walk` on the three single-commit calls (a walking `log
  -1 -- <path>` answers with an ANCESTOR's diff — measured), and
  `GIT_NO_LAZY_FETCH=1` in the shared environment — found by the security
  review: a partial-clone config with one missing object made `log`,
  `rev-parse` and B2's shipped `diff` RUN the transport program the repository
  named. Records are `%x01`-led with `%x00` between fields (git cuts `%s` at
  a NUL, so no commit can forge one); subject, names, body and diff text are
  control-stripped and capped, file paths are git's verbatim bytes (they must
  round-trip as a pathspec; the page draws them as text, bidi-isolated). No
  e-mail address anywhere. Logging: one line per request, counts only. The
  page: 10 rows + `Show more` (user decision), three-line rows (subject;
  hash, author, `+a -d`; date + relative time), one 5 s interval shared with
  the Changes tab, the first ten file blocks unfolded and fetched in
  parallel, the rest on unfold, one block repainted per answer, never a pane
  render while the grid is hidden. Known limits, recorded: the object store
  of the WHOLE repository is readable through `commit-diff` (a tracked file
  above a project anchor included — B2's whole-repository reach; a token
  holder can already spawn a shell); a git older than the CVE-2024-32004
  backport ignores `GIT_NO_LAZY_FETCH`; a file of few enormous lines ends at
  the 2 MiB cap with the constant 500; `/api/git/changes` still 500s on a
  broken repo-local `diff.orderFile`.
- **The upload route (Nocturne B10, 2026-09-20; spec `.claude/plans/nocturne/PLAN-B10.md`
  §2).** `PUT /api/fs/upload?dir=<abs>&rel=<relative>&mode=replace|new`,
  body `application/octet-stream`, ONE file per request, `content-length`
  required (411 otherwise; 413 over 50 MiB BEFORE a byte is read), `201
  { bytes }`. Every refusal answers with `connection: close` + an explicit
  `content-length` (Node then RSTs the unread body within milliseconds;
  measured, no timer). Boundary: `resolveUnderAllowed` on `dir` (the same
  call as `/api/fs/create`), `rel` split on `/` with every segment
  `isSafeSegment` + ≤ 255 bytes, depth ≤ 64, no `..`/empty/absolute/U+FFFD;
  every intermediate folder the route builds is realpathed and re-checked
  against the anchors AND the data-dir refusal right after its `mkdir` (an
  end-only check created folders outside the boundary before the 403 —
  measured); the bytes land in `.upload-<32 hex>.part` opened
  `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` in the destination and are published
  by `rename` (replace) or `link`+`unlink` (new; EEXIST → 409, a dangling
  symlink included) — neither follows the final component, so `Replace`
  over a symlink replaces the LINK. Stateless: no drop id, no server-side
  per-drop counters, no boot sweep, the server never scans the home;
  `.part` files are not hidden from listings and `.git` is not
  special-cased. Logging: counts and statuses only (a 2xx and a 4xx `[fs]`
  line at debug, one `error` line with class + frames for a 5xx, never a
  name, a query value or a byte). `GET /api/fs/winpath?path=<abs>` maps a
  boundary-checked path to its Windows form for the host's clipboard
  (`server/winpath.ts` `windowsPathForClipboard`: wider than the cmd.exe
  allow-list on purpose — spaces, Unicode, `&`, parentheses pass; `\ / : *
  ? " < > |`, control chars, `.`/`..`, a trailing dot or space do not; 422
  when unmappable). Known limits, recorded: a `.part` orphan survives only
  a `kill -9`; the drvfs `link()` fallback is untested here; Windows
  reserved device names (`CON`, `NUL`) pass on Linux and are Explorer's
  problem on paste.
- **The delete route (Nocturne B10a, 2026-09-20; spec `.claude/plans/nocturne/PLAN-B10a.md`
  §2; rationale `memory/decisions/b10a-multi-select-and-delete.md`) — the
  app's first delete primitive, PERMANENT (user's decision: no trash, one
  confirmation `Delete 3 items from src? This cannot be undone.` in the
  page).** `POST /api/fs/delete { paths }`, ONE request per confirmed
  action, ≤ 100 items (413 above with nothing touched), body through
  `readJsonBodySafe` (512 KiB), `200 { results }` index-keyed — per item
  `{ ok: true }` or `{ ok: false, status, error }` with a CONSTANT sentence,
  no path back. Per item: absolute + NUL-free, the name through
  `isSafeSegment` + 255 bytes, the PARENT through `resolveUnderAllowed`
  (realpath + anchors — an intermediate symlink is judged by its real
  location), refused: a target that IS or CONTAINS an anchor (home, a
  project root — the parent of a project root too), the data dir as parent,
  target or container; then one asynchronous `rm(recursive)` on the lexical
  `join(parentReal, name)` — the final component is never resolved, so a
  symlink is unlinked and its target untouched, wherever it points, and
  links inside a tree are not followed; a child under an ancestor deleted
  in the same request answers ok. Async because `rmSync` on 20k files
  blocked every PTY for 400 ms (measured). Logging: one `[fs] POST
  /api/fs/delete -> 200, 3 ok, 1 failed` line at info, per-item debug by
  index, a 5xx with class + frames only (rm's messages quote the path
  twice). Known limits, recorded: a mount point under home is walked and
  deleted (`rm` has no one-file-system flag); the TOCTOU window
  `fsbrowse.ts` records; a token holder could always `rm -rf` through a
  shell — the boundary adds no privilege, it keeps the irreversible verb
  inside home + projects and away from the anchors and the data dir.
- **Tabs and layouts**: interaction model redesigned (decided 2026-07-19,
  user request; recorded in
  `memory/decisions/anti-slop-design-direction.md`): **sessions are tabs**,
  and dragging one tab onto another forms a split view. **Implemented
  2026-07-19**: every session lives in exactly one view (= tab); since
  Nocturne A10 (2026-09-15, user decisions) a view holds 0–4 SLOTS, each a
  session or (since A10b, the user's correction the same day) an EDITOR
  pane holding file and read-only diff TABS, mixed freely; a fixed `Home` tab
  (root = the user's home) is always first in the strip, never draggable,
  never closable, and may stand empty; a file opened from the Files panel
  becomes a TAB of the focused editor pane in the tab of its root folder
  (`Home` or the project's tab, created on demand; a new editor pane only
  when the tab has none; a file already open anywhere in that tab is
  raised, never duplicated; a project tab closes with its last pane unless
  it still holds a terminal). Drag a tab onto a tab/pane to merge into a
  split, drag a pane header to the strip to extract (sessions only), drag
  along the strip to reorder, drag a Files row onto a pane edge to open it
  in a split, onto the centre of an editor pane to add it there as a tab
  (the centre of a terminal pane refuses: "A terminal pane cannot hold
  files. Drop on an edge to split."), onto a folder tab's chip to append,
  drag a file TAB onto a pane edge to open it in a new editor pane beside
  (a pane whose last tab leaves frees its own pane) or onto another editor
  pane to move it there (reordering within a strip and dragging a tab to
  the bottom strip are not built), onto the
  empty pane area of an empty tab to open or merge there; files from
  Windows Explorer onto a folder row, the panel, a pane or an empty tab
  (A9; a TEXT drag from another program onto a terminal is cancelled so
  nothing reaches the PTY unbracketed — user decision 2026-09-15) — every drag
  has a keyboard/button equivalent (see the shortcuts overlay;
  Ctrl+Alt+Enter on a focused Files row opens it beside the focused pane,
  Ctrl+Alt+W closes the ACTIVE TAB of the focused editor pane — the last
  tab closes the pane — and does nothing on a terminal, Ctrl+Alt+PageUp /
  PageDown switch the file tab of the focused editor pane, Ctrl+Alt+M
  moves the active tab to the next editor pane of the tab or into a new
  split beside it; the count pill on a tab chip counts PANES, four files in
  one strip are one pane). The arrangement is client-local, persisted as localStorage
  schema v2 with migration from v1 (since Nocturne A5, 2026-09-13, the
  same v2 bag also carries the Files panel's wish and width; since A10 each
  view carries `root` and `slots`; since B4 (2026-09-22, user decision)
  EDITOR slots persist too — file tabs as `{kind:'file', path}`, diff tabs
  as `{kind:'diff', root, hash, path}`, at most 4 tabs per strip: the writer
  caps and the reader drops the tail, and 4 is the LIVE cap too since the B4
  amendment (2026-09-22, the user's Windows check "ik kan oneindig veel tabs
  open hebben, limiteer dat met 4" — `MAX_TABS = 4`, opening a fifth file
  evicts the tab in position 4, a MOVE into a full pane is refused), every
  entry gated on read
  (absolute path of at most 4096 characters, no NUL, 40-hex hash, absolute diff
  root, unknown kinds dropped) — unsaved TEXT is never written to the
  bag; `sessions: string[]` is still
  read as legacy, and the reader ignores unknown keys, so no bump; a
  pre-A10 build reading a post-A10 bag drops every view, a pre-B4 build
  drops a non-Home view whose only panes are editor panes). Since Nocturne
  B6 (2026-09-22, decision 3) the bag also carries `run`, the backend's
  `startedAt` at save time: with `Reopen tabs on start` OFF the views come
  back only for the run that wrote them (an F5, and the reload after
  `Restart service` or an update, which re-stamps the bag with the child's
  `startedAt` before reloading); a fresh app start opens on Home. ON
  (factory) restores them on every load — which, since the port is sticky
  (Architecture § Port), now includes a fresh app start. An unknown run
  (the runtime check failed) keeps the tabs, and a known stamp is never
  overwritten with null. Either way,
  sessions exist independently of tabs/panes/splits.
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
  since B10a `POST /api/fs/delete` (the delete bullet below), since B4
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
  back — Delete; file rows Open, Open beside, Copy, ──, Delete. An ANCHOR
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
- **Commit view and editor panes** (Nocturne A6, landed 2026-09-13; file
  panes since A10 and file TABS inside them since A10b, both 2026-09-15;
  the commit view and the diff tabs on real data since B3, 2026-09-21; the
  file body on the real file since B4, 2026-09-22): the commit view
  is one more column in the middle row, mounted as a flex sibling in the
  order Projects, Files, commit view, pane grid, Sessions. The **commit
  view** replaces the pane area (the grid is
  `hidden`; terminals are NOT disposed and `panes.render()` refuses to
  build or reconcile while the grid is hidden — a deferred render runs on
  return): card on neutral-900, "Back to sessions", title, author initial
  avatar, "committed <when>" with the full date and time, `Committed by
  <name>` when the committer differs, the message body, the branch chip
  (absent on a detached head), the short-hash chip, "Open on GitHub" ONLY
  when `origin` is on github.com (absent otherwise, never disabled — user
  decision 2026-09-21), `N files changed +A -D` with a
  five-block bar, one collapsible block per file with a unified diff and
  "Open file" / "Changes". The Files panel's Commits tab shows the
  selected commit (message, meta, per-file rows that fold the view's
  blocks, "All commits"). An **editor pane** is a pane like a terminal
  (same card, same 38 px header, the terminal ground): its header is a
  strip of 26 px tab chips (file name, amber dot when unsaved, `×` per tab —
  a `×` here closes files and ends nothing),
  a grab area, and the pane's own `×` ("Close this pane and its N files");
  the body is the ACTIVE tab's line-number gutter + textarea with the
  file's text and a bottom bar (`Save` / `Saving…` / `Saved`), or a
  read-only diff for a "Changes in <hash>" tab (from the commit view).
  Switching tabs swaps the body only —
  neighbouring terminals are never resized or re-attached, and a tab's
  caret survives a round trip. Opening a file never narrows the grid.
  **Editor live** (B4, landed 2026-09-22; user decisions in
  `memory/decisions/b4-editor-live.md`, spec
  `.claude/plans/nocturne/PLAN-B4.md`): the body reads the file through
  `GET /api/fs/read` (text only, 1 MiB at most, UTF-8 without a NUL byte;
  a refusal — 413 too large, 415 not text, 403, 404 — is drawn as the
  pane's one sentence, no field, no Save; line endings and a BOM are
  preserved across a save, text travels LF-normalised). `Save` (the
  button, or Ctrl+S while the keyboard is in the text — the only place
  the app takes that key; a terminal keeps its XOFF) writes in place
  through `PUT /api/fs/write` with the STAMP it read (the server's
  SHA-256 of the bytes on disk, opaque to the page); a file that changed
  since answers 409 `This file changed on disk since you opened it.`, a
  vanished one 404, and the bottom bar offers `Overwrite` (my text wins,
  no stamp, recreates a gone file) and `Load from disk` (my changes go);
  keystrokes typed while a write is out stay unsaved. A CLEAN tab
  FOLLOWS its file on disk: the active tab of every editor pane on screen
  re-reads with `if=<stamp>` on one shared 5 s timer (skipped while the
  document is hidden, the body parked, a request out, or after a refusal),
  a change lands in place with the caret clamped and the scroll kept — a
  dirty tab is never touched by a follow answer or a follow refusal, and a
  follow answer that a save overtook is dropped. Unsaved text lives only
  in memory, keyed by path so the same file in two panes shares it; it is
  NEVER dropped without a question: an OPEN that would evict the fourth tab
  of a full strip (the amendment below), closing a file tab, an editor pane or
  a whole tab that would orphan unsaved text (a file still shown elsewhere
  is not lost) asks `Discard unsaved changes to <name>?` / `… to N files?`
  (`Discard` in danger ink, `Keep editing` the default and Esc — the
  delete dialog's shape), and a reload or window close goes through the
  browser's `beforeunload` question while any file is unsaved (disarmed
  for the app's own restart handoff and auth-loss reload). KNOWN LIMITS,
  recorded: the backend's grace timer after the last window closed is the
  one door that cannot ask; a HARD LINK inside the boundary to a file
  outside it (or to the data dir's own files) is read and written through
  — `realpath` cannot see it, the planter already runs as the user, the
  requester already holds the shell-spawning token; an `nlink` refusal was
  rejected because pnpm's store is hard links; a file being edited by the
  editor and rewritten by a tool at the same instant is settled by the
  stamp, never merged. Server side (`server/fstext.ts`): the same anchor
  boundary as `/api/fs/create`, the data dir refused, the fd judged before
  the path is trusted (`O_NOFOLLOW|O_NONBLOCK`, a regular file only — a
  FIFO, socket, device or planted link answers 415 without a hang), the
  stamp compared and the bytes written on ONE descriptor (inode, mode,
  links and owner stay; a read-only file answers 403), counts-only logging.
  The last mock module (`web/src/ui/files-mock.ts`) went with this part.
  The pane chords (Ctrl+Alt+arrows,
  Ctrl+Alt+W, Ctrl+Alt+PageUp/PageDown unshifted, Ctrl+Alt+M) and the
  tab-switch chords (Ctrl+Alt+1..9) are ignored while a commit view is up;
  Ctrl+Alt+Shift+PageUp/PageDown (reorder tabs) stays live. Esc closes the commit view
  (rank: after every dialog, before drawers and the Files panel) and hands
  the keyboard to the terminal. New `ChangeKind` `'screen'` = something
  other than the panes fills the pane area; the pane module ignores it.
  Code surfaces (editor, diff, paths) draw plain glyphs — no font
  ligatures — like the terminal. Since B4 nothing in the app is mock: the
  editor draws the file, the commit view and the diff tabs draw the
  repository. Esc inside a file pane's textarea
  belongs to the textarea and closes nothing.
- **Attention badges**: surface when a hidden session is waiting for input.
  Implemented: BEL (0x07) detection in output. Possible later: OSC
  sequences, Claude Code hooks.
- **Peek mascot — Nocturne C1 (user's ask 2026-09-15; decisions 12–16
  settled by the user 2026-09-22; spec `.claude/plans/nocturne/PLAN-C1.md`).**
  The user's own pixel-art Claude (`design/peek-mascot/`, 1:1) peeks around
  the right edge of the monitor the APP WINDOW is on — outside the app
  window, over other programs, borderless fullscreen and video (a true
  exclusive-fullscreen game cannot be drawn over: accepted limit). One
  mascot per session that is PENDING; max 3, oldest `pendingSince` first.
  A Claude session whose turn ENDED (`SessionInfo.turnEnded`, set by the
  server only on a working → waiting move of the B11 turn readout) shows
  one even with the app in front and keeps it until Claude works again or
  the session ends — looking does not send it away (user, 2026-09-22, on
  the Windows check). A BEL (`attention`) shows one until the pane is
  looked at (the `seen` ack clears `attention` only). The statusline, Sessions badge and
  `Needs you` pill stay BEL-only (B11). The page `/mascot.html` now carries
  the auth token like `index.html` (same no-store and frame protection),
  polls `/api/sessions` + `/api/prefs` every 2 s, shows a rise only after it
  held 1.5 s (no flash for a turn ending in the pane the user watches), and
  reports `mascot-count` (+ click-through rects) and, after a click's laugh
  or wave, `mascot-open` to the Windows host, which keeps a TopMost,
  no-activate, taskbar-less transparent WebView2 window whose window REGION
  is the union of the reported rects — empty (draws nothing, takes no
  clicks) while the count is 0; the window is never hidden, because a hidden
  WebView2 is throttled by Chromium after 5 min and a mascot would arrive up
  to a minute late. The host declares no DPI awareness (like the main
  window), so on a >100 % monitor Windows scales the art. It reloads a
  crashed mascot page (capped) and re-places on display changes; and, on `mascot-open`, brings the app to the front and posts
  `focus-session` to the main page. `prefs.mascot = { enabled }` (Settings →
  Preferences, `Peek mascot`, default ON) is the one prefs key the server
  validates. Under the OS reduced-motion setting the art stands still.
- **App settings panel — GO given 2026-07-20; contents REVERSED 2026-07-25
  (user decision).** A checklist-style settings surface persisted
  server-side in `prefs.json` via `/api/prefs`. The 2026-07-20 "decided
  four" (default model, default permission mode, auto-run startup command,
  read-only usage display) are DELETED — their backends too (`/api/usage`,
  `/api/telemetry`, the auto-run registry, the global launch-defaults
  store). Since Nocturne A7 (2026-09-13) the panel is a v3 left-nav modal
  with five pages: Status bar (the status-line checklist, next bullet),
  Preferences (API keys LIVE since B5, 2026-09-18 — plan decision 4: one
  password field with Show / Save / Remove per keyed tool, Claude Code
  `ANTHROPIC_API_KEY` ("Uses your Claude login. A saved key is used
  instead."), Gemini CLI `GEMINI_API_KEY`, Grok `XAI_API_KEY`; Codex has no
  field ("Signs in inside the terminal"); the page only ever learns saved /
  not saved / `Set outside the app` from `GET /api/keys`, a key never comes
  back, the field is cleared on save and on close, under an `API keys`
  heading since B6; **Tools** (Nocturne B6, 2026-09-22, decision 1: one
  toggle per card of the New session dialog, a hidden card is absent from
  the grid and a hidden pre-selection falls back to the first visible card,
  the last visible card refuses with `Keep at least one tool visible.`,
  the key rows stay for hidden tools; `prefs.tools.hidden`, clamped on read
  so at least one card always stays); **Defaults** (B6: `Reopen tabs on
  start` — see Tabs and layouts, `Confirm before ending a session` — the
  armed two-step on every door that ends a session — the tab `×`, the
  Sessions panel's end control, the exited banner's `End session` and, since
  B8, the pane header's End session button — off = one click, the
  B4 unsaved-text question never switched off, `Follow output` — every
  write ends at the bottom even after scrolling up, off = xterm's rule;
  `prefs.behaviour`, factory on / on / off; the notifications row was
  dropped until C1, decision 2); the page lead reads `Your tools and how
  the app behaves.`), Keyboard (B6: the WHOLE shortcuts table, drawn from
  `web/src/ui/shortcuts-rows.ts`, the one source the overlay reads too),
  Terminal colours (LIVE since B9, 2026-09-22; shape decided 2026-09-13, plan
  decision 10: presets + custom ground and text, ground + text only, terminal
  only, status colours never themed, no top-bar switch — see
  `memory/decisions/terminal-colours-shape.md`; the six preset cards and the
  two custom fields paint every open terminal at once through
  `web/src/ui/theme.ts` — the six `:root` slots `--term-bg`, `--xt-fg`,
  `--xt-white`, `--xt-bright-white`, `--xt-cursor`, `--xt-bright-black` →
  `themeFromTokens()` — and Nocturne is the ABSENCE of those overrides, so
  the default is exactly `tokens.css`; the choice persists as
  `prefs.theme = { ground, text }`, a lower-case hex pair (the Legacy
  `{ bg, fg, scan }` index shape is still read, never written), localStorage
  is only the cache; the server write is debounced 300 ms and serialised,
  flushed when the dialog closes; the dialog's re-read on open ADOPTS the
  server pair (paint + cache, never a write back, skipped while a write of
  this window is pending); only terminal surfaces follow the ground — the
  editor, the diff and the file chip sit on `--color-term`, and the pane
  status bar's ink takes the theme's quiet and ordinary steps so it stays
  readable on any ground; spec `.claude/plans/nocturne/PLAN-B9.md`), Background service
  (version, uptime, `Restart service`; since B6, decision 4, `Check for
  updates` asks `POST /api/update/check` and answers on the page —
  `You have the newest version.` / `Version <tag> is available.` with an
  `Update` button that opens the update confirm through its own source
  `settings-update` / `A new version is installed. Restart the service to
  use it.` / `Could not check for updates.` — then re-fetches the runtime so
  the pill and the toast agree; hidden when the app is not installed).
  The same part restyled the `Add a project` dialog (header, tabs
  `New folder` / `Clone a repository` / `From GitHub`, checklist rows,
  footer) and the folder picker (`pk-` block) onto the Nocturne primitives,
  behaviour and request bodies unchanged.
  Launch-dialog pre-selection comes from per-project defaults in
  `projects.json` (which stay — a separate feature) with a hardcoded
  fallback, and since B6 falls back to the first visible card when the
  chosen one is hidden; a per-launch choice always wins.
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
  (0700, wiped at boot), `statusline-cache.json` (0600, a ~5 s
  git-branch cache, wiped at boot) and, since Nocturne B1,
  `statusline-snapshots/` (0700, wiped at boot; one 0600 file per app
  session id, written by the script, see the next bullet).
- **Pane status bar — Nocturne B1, 2026-09-17 (decision 2 of
  `.claude/plans/PLAN-NOCTURNE.md`, user 2026-09-16; spec `.claude/plans/nocturne/PLAN-B1.md`).**
  The strip under each terminal (back since A3 with Model / Mode / Time
  from argv) renders the SAME checklist as Settings → Status bar, fed by
  the payload Claude Code hands `server/statusline.mjs`: the server passes
  the script a fourth argument, the absolute path of a per-session
  snapshot (`<dataDir>/statusline-snapshots/<appSessionId>.json`, keyed by
  the APP id — a resumed conversation's `session_id` is the old one, and
  the app never guesses a mapping); the script writes it atomically, only
  when the drawable values changed, regardless of whether Claude's own
  line is on; `server/telemetry.ts` watches the directory (filename gate,
  `O_NOFOLLOW`, regular file only, 8 KiB cap, every string
  control-stripped and capped, every number finite and clamped — the data
  dir is not a boundary) and hands the result to the session manager,
  which sets `SessionInfo.telemetry` and re-sends the existing `info`
  frame when it changed. Items, in the v3 order: Model (what Claude
  reports beats the argv guess), Mode (argv, launch mode), Branch, Cost
  (> 0 only), Context, Usage (amber at ≥ 80 %), Time (running sessions
  only), Changed (`+a -r` when either > 0). The checklist has TWO
  switches — `Inside the terminal` (`enabled`, Claude's own line) and
  `Under the terminal` (`paneBar`) — the bar ON and Claude's line OFF by
  default (user's call 2026-09-17 after seeing both: "het staat nu
  dubbel"); both on shows the same values twice; `Session time` is a checklist row the pane bar alone
  honours. Active skill has no source and is dropped, no placeholder. An
  exited session keeps its last values; Time drops. The script reads
  `paneBar` for one thing only: skipping the git probe when nobody would
  show the branch.
- **Background agents table — Nocturne B7, 2026-09-22 (the B7 row's open
  decision, user 2026-09-22; spec `.claude/plans/nocturne/PLAN-B7.md`).**
  The table under the pane status bar (name, task, time, tokens; A3 built
  it empty) is fed by Claude Code's OWN transcripts: per session Claude
  Code writes `<CLAUDE_CONFIG_DIR|~/.claude>/projects/<slug>/<session-id>/subagents/agent-<hex>.meta.json`
  (agent type, task) and `agent-<hex>.jsonl` (timestamps, `message.id`,
  `stop_reason`, `usage`). The status-line script adds the payload's
  `transcript_path` to the B1 snapshot; the backend derives the subagents
  directory from it and, because the snapshot is untrusted, refuses the
  path unless it is absolute, normalised, `<uuid>.jsonl`, and its parent
  realpath sits inside the real projects root (`DataPaths.claudeProjectsDir`,
  the first directory outside the data dir this app reads for live data);
  the directory actually opened is realpath-checked again on every poll.
  `server/agents.ts` polls it every 2 s (no inotify: the directory does not
  exist before the first subagent), reads meta files ≤ 8 KiB and transcripts
  incrementally (offset + carry, ≤ 4 MiB per file and ≤ 16 MiB per tick
  across everything, lines ≤ 1 MiB, `O_NOFOLLOW`, regular files only),
  and hands `SessionInfo.agents` to the session manager, which re-sends
  `info` on a real change only. A row: name = agent type, task =
  description (control-stripped, 64/120), started = the first line's
  timestamp (the meta's mtime before there is one), tokens = the billed
  total across unique `message.id`s (input + cache creation + cache read +
  output — a 15-minute agent reads `12.5M`), finished when the last
  user/assistant line is an assistant `end_turn` or the file has not grown
  for 15 min (a killed agent leaves no marker). Wire list (B11, replacing
  B7's 3 finished / 8 rows): at most 4 running rows (oldest first), then —
  only when fewer than 4 run — the one most recently finished;
  `SessionInfo.agentCounts` carries the totals so the table ends in
  `+N working` / `+N finished` and nothing is silently hidden; 64 agents
  tracked per session. Since B11 the table shows only when Settings →
  Status bar → "Background agents under the terminal" (`paneAgents`,
  default OFF) is on: Claude Code draws its own task list inside the
  terminal and cannot hide it. The table is never rendered empty, never
  for a non-claude session, keeps its rows after exit, and its ink and
  both hairlines under the terminal take the terminal theme's steps (the
  B9 constraint). Tracking stops at exit and removal, and at exit every row still
  `running` becomes `finished` with the exit's own time (Claude Code runs
  its subagents in-process, so none outlived it) in one extra `info`
  frame before `exit`; a snapshot for a dead or unknown session is
  ignored. No hooks, no env var, nothing
  written under `~/.claude`.
- **Session state: Working vs. Waiting for you — Nocturne B11 (decided
  2026-09-22, user's call).** A PTY does not say whether the program is
  generating or idle, so a Claude session's readout comes from its OWN
  transcript (`<uuid>.jsonl`, derived from the tracked subagents dir, the
  same boundary and budgets as B7, first sight reads the last 1 MiB only):
  the last line that counts decides — an assistant `end_turn` /
  `stop_sequence` / `refusal` / `max_tokens`, a synthetic API error, or a
  user interrupt → `waiting`; a prompt, a tool result, a task
  notification, an assistant `tool_use` → `working`; local slash commands
  and meta lines do not count. A transcript that does not exist yet (the
  first prompt) reads `waiting`. `SessionInfo.turn` carries it, dropped at
  exit. Readout order: Needs your answer (BEL, amber pulsing) > Finished
  (grey) > Waiting for you (amber still) > Working (green pulsing, turn
  known) > Working (green still, no turn readout — every non-claude
  session). Waiting shows on the session's own pane, drawer row and tab dot
  only: the statusline's `N waiting for you`, the top bar's Sessions badge,
  the tab's `Needs you` pill, `attention`, `seen` and every notification
  stay BEL-only (user, 2026-09-22, on the B11 check — B11 first counted
  waiting sessions there too). Known limit:
  Claude Code's permission prompt writes nothing to the transcript, so it
  reads Working unless the BEL fires.
- **Session pane header — Nocturne A3, End session button since B8
  (user's decision 2026-09-22; spec `.claude/plans/nocturne/PLAN-B8.md`).**
  A session pane's 38 px header holds, left to right: the state dot, the
  session name, the project NAME (never a path), a spacer, the state pill
  (the B11 word), the connection chip only while degraded (`Reconnecting` /
  `Lost`), `Own tab` only when the tab holds more than one pane, and — top
  right, on EVERY session pane, a one-pane tab included — an **End session**
  button (a quiet `X` icon, `aria-label` / `title` `End session`). It ENDS
  the session exactly like the tab `×` and the Sessions panel's end control
  do (`killSession`) — not "close the pane, keep it running" — and follows
  Settings → Preferences → `Confirm before ending a session`: on, the first
  click arms (`Sure?`) and the second ends; off, one click ends. A3 had kept
  ending off the pane header as a one-click destructive control; the confirm
  setting answers that. A press on the button never starts the header's
  pane drag. No keyboard chord (the tab `×` and the Sessions panel are
  keyboard-reachable). Editor panes keep their own `×`, which closes files
  and ends nothing.
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
  Carve-out (2026-09-08, user decision 2 of the installer): the Setup
  wizard's WSL and consent pages MUST show the exact `wsl …` fix commands
  (`wsl --install`, `wsl --install -d Ubuntu`, `wsl --set-version <name>
  2`) and the exact third-party command (`curl -fsSL
  https://claude.ai/install.sh | bash`) verbatim — informed consent and an
  actionable fix are the point there. The app's own chrome stays clean.
  The GUI speaks plain human language; CLI syntax belongs in the terminal, not
  in the chrome around it. Concretely: permission modes render as the short
  forms `Always ask` / `Auto edits` / `Read only` / `No prompts` (sentence
  case since Nocturne A4, 2026-09-10; one label table, `PERM_SHORT`; since
  2026-09-06 the long forms are gone; never `acceptEdits`, `plan`,
  `bypassPermissions`) — known exception: Claude Code's own in-terminal
  status line (`server/statusline.mjs` `MODE_LABELS`) still prints its
  older words incl. `plan`, and so does its Settings preview sample; the
  Add a project dialog's default-mode option still reads `never ask (dangerous)`;
  aligning all three is open (backlog) — resume reads
  **The last conversation in this project** (never `--continue`), and the launch dialog's
  argv command preview was replaced by a readable summary, itself **removed
  2026-09-06** and not brought back by the v3 design (user's call
  2026-09-10) (the fields are the statement of what will run; nothing
  explains itself, except the one on-demand permissions info popover
  decided 2026-09-10). Also out of the UI: the
  `git init` sample, the `/caveman` placeholder, `relaunch resumes claude with
  --continue`, `AI_SM_GITHUB_CLIENT_ID` in the GitHub setup card (that card
  says the server is missing a GitHub setting; the variable name lives in the
  README/docs, where acting on it belongs), the clone tab's `$ git clone <url>
  <dest>` preview (same treatment: `copies` / the pasted URL / `into folder:
  <dest>` — the URL stays, it is the user's own input), and the literal command
  name `claude` in the sessions drawer (the known agent renders as its product
  name `Claude Code`, the two built-in shells as `Bash` / `PowerShell` —
  `Bash` since 2026-09-10, formerly `WSL shell` — a no-project history
  entry titled before that keeps its stored `WSL shell` title until it ages
  out, no rewrite of `history.json`,
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
  shift+↑/↓, ctrl+↑/↓, ctrl+space and ctrl+enter — all on the panel root's
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
flat, with `memory/INDEX.md` grouped by theme. `tests/vault-layout.test.ts`
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
commit. `tests/plans-layout.test.ts` enforces the layout, the status lines,
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

(Settled 2026-07-18: port auto-pick + discovery file, amended 2026-09-22 —
the last port is tried first, `last-port.json`; vanilla TS + Vite
frontend; app data — projects.json, runtime.json, last-port.json (2026-09-22), history.json (2026-09-06,
replacing journal.json + previous.json), prefs.json (added 2026-07-20: server-side UI prefs, since
localStorage died with every auto-picked-port origin change), server.log —
lives in `~/.ai-session-manager/` (override: `AI_SM_DATA_DIR`), schema in
`shared/protocol.ts`. Rationale in `memory/decisions/`.)

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
