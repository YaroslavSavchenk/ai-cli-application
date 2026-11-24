# Development

Running from a clone, developing inside WSL, and the test suite. How code is
written here: [CONTRIBUTING.md](../CONTRIBUTING.md); how tests are written:
[tests/README.md](../tests/README.md); the architecture and the hard
constraints: [.claude/PROJECT-SCOPE.md](../.claude/PROJECT-SCOPE.md).

## From source

Cloning the repository and running it from there still works, unchanged, and
needs no Setup. It needs WSL2 with a Linux distribution, and Claude Code inside
it for Claude sessions — but not the glibc 2.35 floor of the
[install](install.md#before-you-start): that one belongs to the Setup's
prebuilt bundle, and a clone compiles against whatever your distribution has,
so the floor is Node's own. Inside WSL it needs **Node.js 24 or newer**
(`node -v` must print `v24.` or higher — the server runs its TypeScript
directly) and **build tools** (`sudo apt install -y build-essential python3`;
node-pty, the terminal layer, is compiled from source and ships no linux-x64
prebuild).

### 1. Clone it, inside WSL

    git clone https://github.com/YaroslavSavchenk/ai-cli-application.git
    cd ai-cli-application

Pick a path on the Linux filesystem (`/home/you/...`, not `/mnt/c/...`) built
only from letters, digits, `.`, `_`, `-` and `/` — the launcher refuses
anything else, spaces included. The location is yours to choose: the launcher
works out where the repository is from where it sits. If you move the clone
later, re-run step 4.

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
— create the missing folder, and drop the files in. The zip has no folder
inside it, so "extract here" is right.

**Or build it yourself** — from Windows:

    powershell -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\<distro>\<your clone>\launcher\build-host.ps1"

No .NET SDK needed: it compiles with the C# compiler that is already part of
Windows, and downloads the WebView2 SDK it links against over HTTPS, refusing
to use it unless its size and SHA-256 match the pinned values. See
[launcher/README.md](../launcher/README.md).

### 4. Make the shortcut, from Windows

    powershell -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\<distro>\<your clone>\launcher\make-shortcut.ps1"

(again with your own distro name and clone path; run it from the Windows Run
dialog, the Explorer address bar, or any Windows terminal). This creates an
**"AI Session Manager"** shortcut on the Desktop and in the Start Menu. Re-run
it any time — after moving the clone, or after building the window from step 3.

### 5. Double-click "AI Session Manager"

The first launch after a Windows reboot has to start the WSL virtual machine
first: expect **10–30 seconds where nothing visible happens**. Later launches
take a second or two. No console window ever appears; if the launch fails you
get an error box telling you what went wrong. What the launcher does, its
switches and troubleshooting: [launcher/README.md](../launcher/README.md).

### Updating a clone

Inside WSL, in the clone:

    git pull
    npm install     # only when dependencies changed

Then, in the app: **Settings → Background service → Restart service**. The app
notices new code on disk by itself and offers the restart; it rebuilds the
frontend as part of it, and refuses the whole thing (changing nothing) if
anything about the new version does not check out. (An installed copy updates
differently — see [install.md § Updating](install.md#updating).) The restart
step by step: [restart-and-recovery.md](restart-and-recovery.md).

## Develop (inside WSL)

Requires Node >= 24 (the server runs its TypeScript directly via native type
stripping).

    npm install
    npm run build       # bundle the frontend into web/dist
    npm start           # start the backend (serves web/dist, tries its last port first)
    npm test            # backend test suite (spawns real servers and PTYs)
    npm run typecheck   # tsc over server/shared/tests and web

Every test has a 120 s timeout (`--test-timeout`): the suite starts real
backend children, and a hang there must cost one red test, not a stalled CI
job. The slowest test today takes a few seconds. The timeout alone does not
end a file whose test left a server listening or a child attached — the
file's process then never exits and `npm test` never returns (measured on
Node 24.14, Q7) — so the test scripts also load an exit guard
(`--import=./tests/helpers/exit-guard.ts`): a file still holding a server,
socket, child or timer 60 s after its tests and hooks finished is ended
with exit code 1 and a line naming what it held, so the run goes red
instead of stalling. (`--test-force-exit` is not used: on Node 24.14 it drops test
results from the report.) `tests/repo/test-scripts.test.ts` pins both.

The backend binds `127.0.0.1` and writes `runtime.json` to its data dir; open
`http://127.0.0.1:<port>/` with the port from that file. The port is sticky:
the port last bound is remembered in `last-port.json` and tried first, so the
origin — and everything the browser scopes to it, the tab layout included —
survives a restart. A restart handoff's hint beats the remembered port (see
[restart-and-recovery.md](restart-and-recovery.md)), and an OS-assigned port
is the fallback when the port tried first is taken; a remembered port that was
busy is kept, not overwritten, so the next start tries it again. The server
logs to `server.log` in the data dir, never stdout. Everything in the data
dir: [app-data.md](app-data.md).

## Continuous integration

Continuous integration (`.github/workflows/ci.yml`) runs the typecheck, the
frontend build, the committed-icon check, the test suite and a full build of
the self-contained Linux bundle (including its boot smoke test) on every push
to `main` and every pull request. Those jobs live in
`.github/workflows/verify.yml` — they surface as the checks
`verify / typecheck + build`, `verify / backend test suite` and
`verify / linux bundle` — and the release workflow calls the same file, so a
release is gated on exactly the checks CI runs. Releasing: [release.md](release.md).

## Test-only environment seams

`AI_SM_UPDATE_API_BASE` is a seam for the in-app update check (the anonymous
`releases/latest` request an installed app makes). It is loopback-only — a
non-loopback value makes the server exit 1 before it listens — and, while it
is set, it also becomes the only origin an update file may be downloaded from.
Two timing seams belong to the same machinery and are equally test-only:
`AI_SM_UPDATE_FIRST_MS` (how long after startup the first check runs; 20 s by
default) and `AI_SM_UPDATE_INTERVAL_MS` (how often afterwards; 1 hour by
default). Both are floored at 1000 ms — they move a clock that talks to
api.github.com, and a smaller value would be a request flood rather than a
faster test. A developer clone never checks for updates at all, and neither
does a bundle whose version is `0.0.0-*`.

The GitHub REST seam, `AI_SM_GITHUB_API_BASE`, is the same kind of switch:
[github.md § Test-only seam](github.md#test-only-seam). The restart's own
variables (`AI_SM_PORT_HINT`, `AI_SM_RESTARTED_FROM`, `AI_SM_STANDBY`,
`AI_SM_WEB_DIST_DIR`): [restart-and-recovery.md § Environment
variables](restart-and-recovery.md#environment-variables).
