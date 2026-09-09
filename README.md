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

Download **`AI-Session-Manager-Setup-<version>.exe`** from the
[Releases page](https://github.com/YaroslavSavchenk/ai-cli-application/releases)
and run it. That is the install. The Setup carries the whole app — backend,
frontend and its own Node runtime — puts it inside your WSL2 Linux
distribution, and leaves an **AI Session Manager** shortcut on the Desktop and
in the Start Menu. It installs for your user only, it never asks for
administrator rights, and it installs nothing else unless you tick it.

### Before you start

- **Windows 10 or 11 with WSL2, and a Linux distribution.** If either is
  missing, the Setup says so, shows the one command that fixes it —
  `wsl --install`, in a PowerShell started as administrator — and stops. It
  never elevates itself and never installs a distribution behind your back.
- **A distribution with glibc 2.35 or newer**: Ubuntu 22.04 and later, Debian
  12 and later. An older one is refused by name, with the version it has and
  the version it needs.
- **Claude Code inside that distribution**, if you want Claude sessions. The
  Setup offers to install it for you — switched off by default, on a page that
  shows the exact command and the site it comes from. Plain terminal sessions
  (WSL shell, PowerShell) need nothing extra. Resuming a specific past
  conversation needs Claude Code 2.1.263 or newer.

Nothing else: no Node, no git and no build tools inside the distribution — the
Setup brings the runtime the app runs on. On the Windows side the app window
uses the WebView2 runtime that comes with Microsoft Edge, so a current Windows
already has it; without it the launcher quietly falls back to an Edge window.

### Running the Setup

The exe is not code-signed, so Windows may greet it with "Windows protected
your PC": choose **More info → Run anyway** (the reasoning is under
[Worth knowing](#worth-knowing)).

The wizard then asks, in order:

1. **the WSL check** — is WSL 2 there, is there a distribution, is its glibc
   new enough. This is where it stops if something is missing, with the exact
   command that fixes it;
2. **which distribution** to install into — always asked, also when there is
   only one, so you can see which one it picked;
3. **which folder inside Linux** — the default is `.ai-session-manager/app` in
   your Linux home directory. Whatever you type must end in `/app` with at
   least two folders above it (`/home/you/.ai-session-manager/app`), and may
   use only letters, digits, `.`, `_`, `-` and `/` — no spaces, no quotes. The
   uninstaller relies on that shape, so the wizard refuses anything else;
4. **optional extras** — the consent page. It appears only when something is
   actually missing, every box starts off, and each entry names the exact
   command and the site it downloads from. Today the only entry is Claude Code.
   Nothing third-party is ever installed silently;
5. **shortcuts** — one tick box, "Create a desktop shortcut", on by default.
   The Start Menu entry is always made;
6. **ready** — it names both destinations, the Windows one and the Linux one,
   and says whether anything extra will be installed.

Then it unpacks and is done. Double-click **AI Session Manager**. The first
launch after a Windows reboot has to start the WSL virtual machine first:
expect **10–30 seconds where nothing visible happens**. Later launches take a
second or two. No console window ever appears; if a launch fails you get an
error box telling you what went wrong.

Your projects, session history and settings live inside Linux in
`~/.ai-session-manager/`, next to the app but separate from it, and no install,
upgrade or uninstall ever touches them.

### Updating

Download the newer `AI-Session-Manager-Setup-<version>.exe` and run it. It
upgrades in place, keeps everything, and you may leave the app open while it
runs. Afterwards the app notices the new version by itself and offers the
restart that moves it there — through the notice in the window, or under
**Settings → Restart backend**. Sessions that are open at that moment end;
they keep their place in HISTORY and can be resumed.

### Uninstalling

Windows Settings → **Apps** → "AI Session Manager" → Uninstall, like any other
app. It asks one question — whether to also remove the app files inside your
Linux distribution — and that one defaults to No. Either way your projects,
session history and settings stay: nothing in `~/.ai-session-manager/` is
removed.

### From source (developers)

Cloning the repository and running it from there still works, unchanged, and
needs no Setup. It needs WSL2 with a Linux distribution, and Claude Code inside
it for Claude sessions — but not the glibc 2.35 floor above: that one belongs
to the Setup's prebuilt bundle, and a clone compiles against whatever your
distribution has, so the floor is Node's own. Inside WSL it needs
**Node.js 24 or newer** (`node -v` must print `v24.` or higher — the server
runs its TypeScript directly) and **build tools**
(`sudo apt install -y build-essential python3`; node-pty, the terminal layer,
is compiled from source and ships no linux-x64 prebuild).

#### 1. Clone it, inside WSL

    git clone https://github.com/YaroslavSavchenk/ai-cli-application.git
    cd ai-cli-application

Pick a path on the Linux filesystem (`/home/you/...`, not `/mnt/c/...`) built
only from letters, digits, `.`, `_`, `-` and `/` — the launcher refuses
anything else, spaces included. The location is yours to choose: the launcher works out where
the repository is from where it sits. If you move the clone later, re-run
step 4.

#### 2. Install and build, inside WSL

    npm install
    npm run build

`npm install` compiles node-pty from source, which is what the build tools
above are for. `npm run build` bundles the frontend into `web/dist`.

#### 3. The app window (optional, but recommended)

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

#### 4. Make the shortcut, from Windows

    powershell -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\<distro>\<your clone>\launcher\make-shortcut.ps1"

(again with your own distro name and clone path; run it from the Windows Run dialog,
the Explorer address bar, or any Windows terminal). This creates an **"AI
Session Manager"** shortcut on the Desktop and in the Start Menu. Re-run it any
time — after moving the clone, or after building the window from step 3.

#### 5. Double-click "AI Session Manager"

The first launch after a Windows reboot has to start the WSL virtual machine
first: expect **10–30 seconds where nothing visible happens**. Later launches
take a second or two. No console window ever appears; if the launch fails you
get an error box telling you what went wrong.

#### Updating a clone

Inside WSL, in the clone:

    git pull
    npm install     # only when dependencies changed

Then, in the app: **Settings → Restart backend**. The app notices new code on
disk by itself and offers the restart; it rebuilds the frontend as part of it,
and refuses the whole thing (changing nothing) if anything about the new
version does not check out. (An installed copy updates differently — see
[Updating](#updating) above.)

### Worth knowing

- **Neither downloadable exe is code-signed.** Both the Setup and the native
  window inside it are built by GitHub Actions from the source of the tag they
  are published under — the WebView2 SDK verified by SHA-256, the bundled Node
  runtime verified against nodejs.org's own checksums during that build — but
  there is no certificate on either file. The first time you run one, Windows
  SmartScreen may say "Windows protected your PC": choose **More info → Run
  anyway**. Every release lists the SHA-256 of every download, so you can check
  what you got before you run it (`Get-FileHash <file> -Algorithm SHA256` in
  PowerShell prints it in uppercase, the published list is lowercase — a
  difference in case is not a mismatch).
- **Everything runs locally.** The backend binds `127.0.0.1` on a port it picks
  itself and is reachable only from your own machine; the window is locked to
  that address. Nothing about your sessions leaves the machine through this
  app.
- **The app never installs anything behind your back.** The Setup asks before
  it installs anything third-party, and it is the only part that installs
  anything at all: the app itself launches the CLIs you already have, and it
  will refuse to restart rather than run `npm install` for you.

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

Every test has a 120 s timeout (`--test-timeout`): the suite starts real
backend children, and a hang there must cost one red test, not a stalled CI
job. The slowest test today takes a few seconds.

The backend binds `127.0.0.1` on an OS-assigned port and writes
`runtime.json` to its data dir; open `http://127.0.0.1:<port>/` with the
port from that file. The one exception to the auto-pick is a restart handoff
(see "Restarting the backend"), where the replacement process is asked to try
the previous port first and falls back to an auto-picked one if it is taken.
The server logs to `server.log` in the data dir, never stdout.

Continuous integration (`.github/workflows/ci.yml`) runs the typecheck, the
frontend build, the committed-icon check, the test suite and a full build of
the self-contained Linux bundle (including its boot smoke test) on every push
to `main` and every pull request. Those jobs live in
`.github/workflows/verify.yml` — they surface as the checks
`verify / typecheck + build`, `verify / backend test suite` and
`verify / linux bundle` — and the release workflow calls the same file, so a
release is gated on exactly the checks CI runs.

### Release process

Tagging is the whole release: pushing a `v0.1.1` tag starts
`.github/workflows/release.yml`, which builds four things and publishes them
together:

- `AI-Session-Manager-Setup-<version>.exe` — the Windows Setup, compiled with
  Inno Setup on a Windows runner. This is the app;
- `ai-session-manager-linux-x64.tar.gz` — the self-contained Linux bundle the
  Setup unpacks inside WSL (backend, production dependencies, built frontend,
  pinned Node runtime), built on **ubuntu-22.04** so its glibc floor is 2.35;
- `AiSessionManagerHost-win-x64.zip` — the four files of the native WebView2
  host window, flat, no folder inside, for people running from a clone;
- `SHA256SUMS.txt` — one `sha256sum`-compatible list covering all three plus
  the four files inside the zip, rehashed in the publish job from the files it
  is about to attach.

Five jobs: `verify` (the **full verification suite on the tagged commit** — the
same `.github/workflows/verify.yml` jobs CI runs), `host` and `bundle` in
parallel, `installer` after those two (it needs both binaries), and the publish
job after all four. So a failing test blocks the release: nothing is ever
published from a commit the suite did not pass, and no bundle ships that did
not boot in its own smoke test. The release body leads with the Setup, then the
bundle, then the host zip, and carries the Setup's SHA-256.

The Node runtime the bundle ships is defined once per workflow file, as
`NODE_VERSION`; `tests/release-workflow.test.ts` pins that `verify.yml` and
`release.yml` agree on it, that every action is pinned to a commit SHA, and
that nothing is published from anything but a `v*` tag.

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

Running the workflow by hand (`workflow_dispatch`) builds all four artifacts
and uploads them as workflow artifacts without publishing anything — that is
how a Setup gets tested on Windows before a tag exists, and it is the way to
test a change to the workflow itself. Its version is then `0.0.0-dev+<short
sha>`, which nothing can mistake for a release. Dispatched on a `v*` tag it
publishes exactly like a tag push (the publish job's condition is the ref, not
the trigger). Re-running a publish for a tag that already has a release
re-uploads every asset over the old ones and rewrites the release notes, so the
hashes in the body always match the attached files. The version lives only in
the tag; `package.json` has no version field. `scripts/build-bundle.sh` also
runs by hand — `scripts/build-bundle.sh --version v0.1.1 --node 24.20.0` — for
building a bundle locally; the Node version that CI actually ships is the
`NODE_VERSION` pinned in `.github/workflows/verify.yml`, not the one in that
example.

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
- `runtime.json` — runtime discovery (port, auth token, pid, startedAt, and
  `appDir`, the directory the running backend was started from);
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

`AI_SM_UPDATE_API_BASE` is the same kind of seam for the in-app update check
(the anonymous `releases/latest` request an installed app makes). It is
loopback-only under the same rule — a non-loopback value makes the server exit
1 before it listens — and, while it is set, it also becomes the only origin an
update file may be downloaded from. Two timing seams belong to the same
machinery and are equally test-only: `AI_SM_UPDATE_FIRST_MS` (how long after
startup the first check runs; 20 s by default) and `AI_SM_UPDATE_INTERVAL_MS`
(how often afterwards; 6 hours by default). Both are floored at 1000 ms — they
move a clock that talks to api.github.com, and a smaller value would be a
request flood rather than a faster test. A developer clone never checks for
updates at all, and neither does a bundle whose version is `0.0.0-*`.

## More

- Architecture, decisions, hard constraints: `.claude/PROJECT-SCOPE.md`
- Frontend design system: `web/DESIGN.md`
- Wire contract (REST, WebSocket, discovery file): `shared/protocol.ts`
