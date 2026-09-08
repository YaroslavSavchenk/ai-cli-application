# AI CLI Session Manager

A web app for running and managing multiple AI CLI sessions (Claude Code
first; the launched agent is a configurable command + args, so other CLIs
work too) side by side. A Node.js backend inside WSL2 spawns each session in
a real pseudo-terminal (node-pty), streams I/O over WebSocket, and serves a
vanilla-TypeScript frontend (xterm.js) with projects, launch presets, and
multi-pane tab layouts. Sessions are server-side objects: hiding a pane,
switching tabs, or reloading the page never ends them, and reattaching
replays the full scrollback. The backend's lifetime is bound to UI presence
(decided and implemented 2026-07-19; see
`memory/decisions/lifecycle-bound-backend.md`): closing the last app window
starts a ~30 s grace timer, after which the backend ends all sessions and
exits — nothing keeps running in the background. A crash-safe session
history keeps every session the app ever launched, across runs, and can
resume any of them (a Claude session resumes ITS OWN conversation: the
backend pins each launch with `--session-id <uuid>` and resumes with
`--resume <id>`).

## Install

The app is a web UI served from **inside** your WSL2 Linux distro, plus a small
Windows-side launcher that opens it in its own window. There is no installer
and no system-wide install: you clone the repository into WSL and make a
shortcut. Nothing needs administrator rights.

### Before you start

- **Windows 10 or 11 with WSL2** and a Linux distro — Ubuntu recommended
  (`wsl --install -d Ubuntu` in PowerShell if you have none yet).
- **Node.js 24 or newer, inside WSL** — `node -v` in the distro must print
  `v24.` or higher. The server runs its TypeScript directly, which needs that
  version.
- **The AI CLI you want to run, installed inside WSL** — Claude Code for the
  built-in Claude sessions. This app only *launches* it; it never installs it,
  and it never installs npm packages by itself. (Resuming a specific past
  conversation needs Claude Code 2.1.263 or newer.) Plain terminal sessions
  (WSL shell, PowerShell) need nothing extra.
- **The WebView2 Evergreen runtime, on Windows** — it ships with Microsoft
  Edge, so any current Windows already has it. Without it the launcher quietly
  falls back to an Edge window.
- **Build tools inside WSL** — `sudo apt install -y build-essential python3`
  (node-pty, the terminal layer, is compiled from source on Linux; it ships no
  linux-x64 prebuild).

### 1. Clone it, inside WSL

    git clone https://github.com/YaroslavSavchenk/ai-cli-application.git
    cd ai-cli-application

Pick a path on the Linux filesystem (`/home/you/...`, not `/mnt/c/...`) built
only from letters, digits, `.`, `_`, `-` and `/` — the launcher refuses
anything else, spaces included. The location is yours to choose: the launcher works out where
the repository is from where it sits. If you move the clone later, re-run
step 4.

### 2. Install and build, inside WSL

    npm install
    npm run build

`npm install` compiles node-pty from source, which is what the build tools
above are for. `npm run build` bundles the frontend into `web/dist`.

### 3. The app window (optional, but recommended)

Without this step the app opens in an Edge window and the taskbar shows the
Edge logo. With it, the app gets its own window, its own taskbar button and its
own icon. Two ways to get it — both end with the same four files in
`launcher/host/build/`:

**Download it** (no build step): grab
`AiSessionManagerHost-win-x64.zip` from the
[Releases page](https://github.com/YaroslavSavchenk/ai-cli-application/releases),
optionally check it against the `SHA256SUMS.txt` published beside it
(`Get-FileHash .\AiSessionManagerHost-win-x64.zip -Algorithm SHA256` in
PowerShell, or `sha256sum -c --ignore-missing SHA256SUMS.txt` in WSL, where a
file downloaded on Windows sits under `/mnt/c/Users/<you>/Downloads`;
`Get-FileHash` prints the hash in UPPERCASE while the file lists it in
lowercase, so a difference in case is not a mismatch), and extract its four
files into `launcher/host/build/` inside your clone — you have
to create that folder. The easiest way is Explorer: type

    \\wsl.localhost\<distro>\<your clone>\launcher\host\build

in the address bar — with your own distro name and the Linux path of your clone,
for example `\\wsl.localhost\Ubuntu\home\you\ai-cli-application\launcher\host\build`
— create the missing folder, and drop the files in. The zip has no folder inside it, so "extract
here" is right.

**Or build it yourself** — from Windows:

    powershell -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\<distro>\<your clone>\launcher\build-host.ps1"

No .NET SDK needed: it compiles with the C# compiler that is already part of
Windows, and downloads the WebView2 SDK it links against over HTTPS, refusing
to use it unless its size and SHA-256 match the pinned values. See
[launcher/README.md](launcher/README.md).

### 4. Make the shortcut, from Windows

    powershell -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\<distro>\<your clone>\launcher\make-shortcut.ps1"

(again with your own distro name and clone path; run it from the Windows Run dialog,
the Explorer address bar, or any Windows terminal). This creates an **"AI
Session Manager"** shortcut on the Desktop and in the Start Menu. Re-run it any
time — after moving the clone, or after building the window from step 3.

### 5. Double-click "AI Session Manager"

The first launch after a Windows reboot has to start the WSL virtual machine
first: expect **10–30 seconds where nothing visible happens**. Later launches
take a second or two. No console window ever appears; if the launch fails you
get an error box telling you what went wrong.

### Updating

Inside WSL, in the clone:

    git pull
    npm install     # only when dependencies changed

Then, in the app: **Settings → Restart backend**. The app notices new code on
disk by itself and offers the restart; it rebuilds the frontend as part of it,
and refuses the whole thing (changing nothing) if anything about the new
version does not check out.

### Worth knowing

- **The downloadable window is not code-signed.** It is compiled by GitHub
  Actions from the source of the tag it is published under, and the WebView2
  SDK it uses is verified by SHA-256 during that build — but there is no
  certificate on the exe. The first time you run it, Windows SmartScreen may
  say "Windows protected your PC": choose **More info → Run anyway**. If you
  would rather not, build it yourself (step 3, second option) or skip the step
  entirely.
- **Everything runs locally.** The backend binds `127.0.0.1` on a port it picks
  itself and is reachable only from your own machine; the window is locked to
  that address. Nothing about your sessions leaves the machine through this
  app.
- **The app never installs anything.** It launches the CLIs you already have,
  and it will refuse to restart rather than run `npm install` for you.

## Run it (Windows + WSL2)

Double-click the "AI Session Manager" icon from the install above. No console
appears; the launcher attaches to a running backend (or starts one detached
inside WSL), waits for it to become healthy, and opens the UI in the native
WebView2 host window when that host is present and the WebView2 runtime is
installed — otherwise an Edge `--app` window, then the default browser.
`launcher/launch.cmd` is the visible/debug path with the same logic.
Configuration, switches (`-Silent`, `-Status`, `-Stop`, `-NoBrowser`), pinning,
cold-boot expectations, and troubleshooting: see
[launcher/README.md](launcher/README.md).

## Develop (inside WSL)

Requires Node >= 24 (the server runs its TypeScript directly via native type
stripping).

    npm install
    npm run build       # bundle the frontend into web/dist
    npm start           # start the backend (serves web/dist, auto-picks a port)
    npm test            # backend test suite (spawns real servers and PTYs)
    npm run typecheck   # tsc over server/shared/tests and web

The backend binds `127.0.0.1` on an OS-assigned port and writes
`runtime.json` to its data dir; open `http://127.0.0.1:<port>/` with the
port from that file. The one exception to the auto-pick is a restart handoff
(see "Restarting the backend"), where the replacement process is asked to try
the previous port first and falls back to an auto-picked one if it is taken.
The server logs to `server.log` in the data dir, never stdout.

Continuous integration (`.github/workflows/ci.yml`) runs the typecheck, the
frontend build, the committed-icon check and the test suite on every push to
`main` and every pull request. Those jobs live in
`.github/workflows/verify.yml`, which the release workflow calls too, so a
release is gated on exactly the checks CI runs.

### Release process

Tagging is the whole release: pushing a `v0.1.1` tag starts
`.github/workflows/release.yml`. It runs the **full verification suite on the
tagged commit** — the typecheck, the frontend build, the committed-icon check
and the test suite, the same `.github/workflows/verify.yml` jobs CI runs — and
in parallel builds the native WebView2 host on a Windows runner with
`launcher/build-host.ps1`, packaging the four resulting files as
`AiSessionManagerHost-win-x64.zip` (flat, no folder inside) together with a
`sha256sum`-compatible `SHA256SUMS.txt`. The publish job waits for **both**, so
a failing test blocks the release: nothing is ever published from a commit the
suite did not pass. On success both files are attached to a GitHub Release for
that tag, with install notes and the zip's hash in the release body. Nothing
else is released — the app itself is installed by cloning the repository.

The recommended way to tag is:

    npm run release -- v0.1.1
    npm run release -- v0.1.1 --dry-run   # run every check, tag nothing

`scripts/release.sh` refuses to create the tag unless the commit is already
proven: exactly one `vX.Y.Z` argument, `gh` installed and logged in, a clean
working tree on `main`, `HEAD` equal to `origin/main` after a fetch, the tag
unused locally and on origin, and — the point of the whole thing — a **CI run
for exactly this commit that concluded `success`** (no run yet, still running,
or failed all stop it, printing the run's URL). Only then does it
`git tag -a` and `git push origin`. `--dry-run` performs every check and prints
what it would do without tagging or pushing. Tagging by hand
(`git tag v0.1.1 && git push origin v0.1.1`) still works and is gated by the
workflow anyway — the script just moves the failure from five minutes after the
push to before it, so you do not end up with a dead tag.

Running the workflow by hand (`workflow_dispatch`) builds and
uploads the same two files as a workflow artifact, which is the way to test a
change to it; dispatched from a branch it releases nothing, but dispatched on a
`v*` tag it publishes exactly like a tag push (the publish job's condition is
the ref, not the trigger). Re-running a publish for a tag that already has a
release re-uploads both assets over the old ones and rewrites the release notes,
so the hash in the body always matches the attached zip. The version lives only in the
tag; `package.json` has no version field.

## App data

Lives in `~/.ai-session-manager/` (override with `AI_SM_DATA_DIR`, absolute
path):

- `projects.json` — saved projects
- `prefs.json` — server-side UI preferences (the settings panel; localStorage
  cannot be used because the auto-picked port changes the origin)
- `github.json` — the GitHub credential, user-only readable (mode 0600);
  written after a successful connection (device flow, or a pasted token stored
  with "remember"), deleted on disconnect. Never sent to the browser. It is
  **not encrypted** — see the honesty note in the GitHub section below
- `runtime.json` — runtime discovery (port, auth token, pid, startedAt);
  removed on clean shutdown, with one deliberate exception: a restart handoff
  leaves the file in place, because by then it describes the replacement
  process the launcher has to find
- `history.json` — every session the app launched, across runs (atomically
  rewritten on every session create/exit/delete and at shutdown; entries left
  open by a crash are stamped `crash` at the next boot). Feeds `GET
  /api/history` and `POST /api/history/:id/resume`; bounded at 200 entries,
  where the oldest ended one drops first
- `session-settings/` — one Claude Code settings file per session (directory
  mode 0700), holding only the status-line command the session is launched
  with; emptied at boot, since no session survives a restart
- `statusline-cache.json` — the status line's git-branch cache, user-only
  readable (mode 0600), written by the script Claude Code runs and keyed by its
  session id; deleted at boot
- `server.log` — backend log: one line per event, `<ISO> [level] [component]
  message`, at `debug`/`info`/`warn`/`error`. **Everything is logged by
  default** — boot banner (node version, pid, data dir, effective log level,
  every `AI_SM_*` override, the server commit and the frontend bundle being
  served), every HTTP request, every WebSocket upgrade/attach/resize, session
  lifecycle, history decisions, and the browser's own lines shipped through
  `POST /api/client-log` (tagged `[client]`). Minimum level: `AI_SM_LOG_LEVEL`
  (`debug|info|warn|error`, default `debug`). Rotated at 10 MiB through two
  generations (`server.log.1`, `server.log.2`), so at most ~30 MiB on disk; if
  the rename cannot happen (something is in the way of `server.log.1`) the live
  file is truncated instead, so logging never stops. Two anti-flood limits, since
  any web page on the machine can send unauthenticated requests to the port: a
  logged request path is cut at 256 characters, and **unauthenticated requests
  and rejected upgrades share a budget of 60 log lines per minute**, after which
  the file says how many it suppressed. The budget keys on the auth token, not
  on the status code, so `/health` and the page itself are metered too — and a
  request that carried the token is never metered, whatever it answered.
  Terminal input and PTY output are summarized once a second as byte counts. Secrets are never written to it: not the auth
  token, the GitHub token, request bodies, `Authorization` headers,
  query-string values, or PTY input/output

## Restarting the backend

Settings → BACKEND → `Restart backend` replaces the running backend with a
fresh one on the same port, without closing the window. The app also watches
for a newer version on disk — changed dependencies, a new commit, a missing or
rebuilt frontend build, frontend sources newer than the build being served, or
an edited server file — and offers the same restart through a notice and a
small `update` mark in the top bar.

What happens, in order. Nothing is torn down until a replacement has been
proven, so a restart that cannot succeed leaves the running backend exactly as
it was — same process, same sessions, same screens:

1. **dependencies** — if `node_modules` is missing or older than
   `package-lock.json`, the restart is refused and asks you to install them
   yourself (never automatically: `node-pty` is a native module and an install
   runs lifecycle scripts);
2. **the frontend is rebuilt** into `web/dist-next` with the project's own
   vite and verified (`index.html`, the entry bundle, `build-id.json`). It is
   only staged there — the old build keeps being served — so a failed build is
   refused with `web/dist` untouched. This is what makes a restart after a
   `git pull` serve the new UI;
3. **a standby backend** is started, boots completely — everything except
   binding the port — and reports in. A replacement that fails to boot is
   refused here. Until it says `go` that process writes nothing at all: the
   data dir still belongs to the backend that is serving;
4. **only then is the new frontend swapped in** (`web/dist` → `web/dist-prev`,
   `web/dist-next` → `web/dist`), so new screens never end up in front of the
   old backend. A served directory is only moved aside when it looks like a
   frontend build (an `index.html` plus its entry bundle); anything else is
   refused with nothing renamed. A swap that fails puts the old build back,
   stops the standby and refuses too.

Only then does the old process end every running session (each one is stamped
in `history.json`, so it keeps its entry and can be resumed from HISTORY),
close its listener, tell the standby to take the port, wait until that one
answers `/health`, and answer the browser and exit. Running sessions do not
survive this — the app never pretends otherwise.

The route is `POST /api/restart` (same token and Origin/Host check as every
other `/api` route). It answers `202` with the new port once the replacement
is healthy, `409` when a restart is already running, `422` when one of the
four steps above refused (**the old backend is untouched and still
serving**), `500` when the replacement failed after the handoff had begun, and
`503` in a process with no restart mechanism wired. A refused restart also
leaves `web/dist-next` removed.

A failed handoff is **not** a rollback: past the fourth step the sessions are
already ended and the listener is already closed, so the old process exits
either way and the app asks you to start it again from the desktop shortcut.
That window is now as small as "the replacement booted but could not bind".

Three environment variables belong to this handoff only — the app sets them on
the process it starts, and there is no reason to set them by hand:

- `AI_SM_PORT_HINT` — the port the replacement should try first (1-65535); a
  taken port falls back once to an auto-picked one, and the UI then says the
  window has to be relaunched
- `AI_SM_RESTARTED_FROM` — the pid of the process being replaced, written to
  `server.log` so the two runs read as one story
- `AI_SM_STANDBY` — set to `1` on the standby: it boots but does not listen
  until the old process hands the port over, and until then it does not write
  in the data dir at all. Without a parent it exits by itself (immediately if
  the parent goes away, otherwise 30 seconds after it reported ready)

One more variable belongs to the same machinery: `AI_SM_WEB_DIST_DIR`
(absolute path, default `web/dist` in the repo) moves the built frontend the
server SERVES, and with it the `-next`/`-prev` directories a restart renames.
It exists so the tests can drive a real restart against a copy instead of
rebuilding the repo's own `web/dist`; leave it unset otherwise. A value that is
relative, ends in a separator, holds a `.` or `..` segment, or is the root
makes the server refuse to start, much like `AI_SM_DATA_DIR`. Sessions never
inherit it, or any of the three variables above.

## GitHub connection

The app can list your GitHub repositories, clone one into a new project, and
create a new repository. There are **two ways to connect, and exactly one
credential is active at a time** — connecting one way replaces the other.

### A. Paste a token (no server setup)

Works out of the box, with nothing configured. In the app: **New Project →
GitHub → paste a token**. The server checks it against GitHub (`GET /user`,
then `GET /user/repos?per_page=1`) and shows you which account it resolved to
before it counts as connected.

Recommended token: a **fine-grained personal access token limited to the
repositories you want, with an expiry**. That is strictly less powerful — and
therefore safer — than the device flow below, which asks for read/write on
every repository of the account and usually does not expire (a device-flow
token expires in 8 hours only if the OAuth App enables expiring user tokens,
which this app cannot refresh).

"Remember this token" (on by default) writes it to `github.json`. Turn it off
and the credential lives **only in the running backend process**, which exits
about 30 seconds after the last window closes; you paste again next time.

### B. Sign in with GitHub (needs a one-time server setup)

The device flow needs an OAuth App, which is a one-time setup by whoever runs
the manager:

1. Register an **OAuth App** on GitHub (Settings → Developer settings → OAuth
   Apps → New OAuth App) and **enable Device Flow** for it. No client secret
   is needed or stored — the device flow of a public app does not use one.
2. Start the backend with the App's client id in the environment:

       AI_SM_GITHUB_CLIENT_ID=Iv1.your_client_id npm start

   (For the Windows launcher, set it in the environment the WSL command
   inherits.) Absent or empty ⇒ only this sign-in path is unavailable; pasting
   a token still works and nothing else changes.
3. In the app, open **New Project → GitHub → Connect with GitHub**, then enter
   the shown code at `github.com/login/device`. The requested scope is `repo`
   (list + clone + create + push, no re-auth).

### What "Disconnect" does, and what it does not

Disconnect deletes the local copy (`github.json`) and clears the in-memory
credential. **It revokes nothing on GitHub.** To actually kill the credential:
a pasted token under GitHub Settings → Developer settings → Personal access
tokens; a device-flow grant under GitHub Settings → Applications.

### How the credential is stored (stated plainly)

Server-side only: `github.json`, mode 0600, never returned to the browser,
never written to `server.log`, and never put in `prefs.json`. It is **not
encrypted and not in a keychain** — there is no OS keyring in this environment,
and an encryption key stored on the same disk protects against nobody who can
read the file. On Windows + WSL2, note that file permissions do not stop a
process running as your Windows user: the WSL filesystem is reachable through
`\\wsl.localhost\...` as root inside the distro, so every file in the data dir
is readable that way regardless of its mode. The honest promise is "stored on
this machine, readable by your own user account" — which is also why a
short-lived, repository-scoped token is the better credential to hand it.

Never paste a token somebody else gave you.

Clones started from the GitHub repo list land in
`<home>/projects/<owner>/<repo>`, so two repositories with the same name from
different owners can both exist locally. The URL-clone tab keeps its
user-chosen destination.

`AI_SM_GITHUB_API_BASE` exists **only for offline tests** — it re-points the
REST base and is refused unless it is a loopback origin (the server exits 1
rather than start), so it can never be a production or GitHub-Enterprise
setting.

## More

- Architecture, decisions, hard constraints: `.claude/PROJECT-SCOPE.md`
- Frontend design system: `web/DESIGN.md`
- Wire contract (REST, WebSocket, discovery file): `shared/protocol.ts`
