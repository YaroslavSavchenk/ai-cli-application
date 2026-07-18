# Windows launcher

Thin Windows-side launcher for the AI CLI Session Manager backend that runs
inside WSL2. It reads the backend's discovery file
(`~/.ai-session-manager/runtime.json` inside the distro, via `wsl.exe cat`),
health-checks the discovered port on `http://127.0.0.1:<port>/health`, and:

- **healthy** → opens the UI (Edge `--app` chromeless window; default
  browser as fallback);
- **absent or stale** (dead pid / failed health) → starts the backend
  **detached** (`setsid`, via `start-backend.sh`), waits for
  runtime.json + health, then opens the UI.

The backend is never a child of the launcher or the browser window —
closing the window (or the launcher) never kills sessions. Stop it
explicitly with `-Stop`.

The port is auto-picked by the backend; nothing is ever hardcoded. Always
`127.0.0.1`, never `localhost` (the server binds IPv4 only; `::1` fails).

## Setup (once)

Open `launch.ps1` and check the config block at the top:

- `$Distro` — your WSL distro name (default `Ubuntu`). If the exact name is
  not installed but exactly one installed distro starts with it (e.g. only
  `Ubuntu-24.04`), the launcher uses that one and says so. No match, or an
  ambiguous match (`Ubuntu-22.04` **and** `Ubuntu-24.04`), is an error that
  lists what `wsl.exe -l -q` reports — then set the exact name here.
- `$RepoPath` — Linux path of the repo (default
  `/home/sava/projects/ai-cli-application`).
- `$DataDir` — backend data dir (default `~/.ai-session-manager`).

Each value can also be overridden per-invocation via the environment
variables `AI_SM_DISTRO`, `AI_SM_REPO_PATH`, `AI_SM_DATA_DIR` (used by
automated tests; normally leave them unset).

## Run

From Windows (Explorer double-click, Run dialog, or a terminal):

    \\wsl.localhost\Ubuntu-24.04\home\sava\projects\ai-cli-application\launcher\launch.cmd

or directly:

    powershell -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\Ubuntu-24.04\home\sava\projects\ai-cli-application\launcher\launch.ps1"

Switches:

- `-Status` — print backend state from runtime.json (port, pid, startedAt;
  the auth token is never printed) and the health-check result.
  Exit code 0 = running and healthy, 1 = not running or stale.
- `-Stop` — graceful shutdown: SIGTERM to the pid from runtime.json, then
  confirm the server removed runtime.json. Running sessions die with the
  server — stop deliberately.
- `-NoBrowser` — do everything except opening the UI (for scripts/tests).

## Cold boot note

The first launch after a Windows boot has to boot the WSL VM: expect several
extra seconds. The launcher polls for up to 90 s with progress dots — let it
finish. Warm launches attach in about a second.

## Pin to taskbar

You cannot pin a `.cmd` directly. Create a shortcut instead:

1. Right-click the desktop → New → Shortcut.
2. Target:

       powershell.exe -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\Ubuntu-24.04\home\sava\projects\ai-cli-application\launcher\launch.ps1"

3. Name it (e.g. "AI Sessions"), then right-click the shortcut →
   Pin to taskbar. (Optionally set "Run: Minimized" in the shortcut
   properties so the console flash is less visible.)

Alternatively: once the Edge app window is open, right-click its taskbar
icon → Pin — that pins the web app itself; the launcher is then only needed
after a reboot or `-Stop`.

## Troubleshooting

- Backend log: `~/.ai-session-manager/server.log` inside the distro.
- `-Status` says stale → the backend crashed or was SIGKILLed; the next
  plain launch starts a fresh one automatically.
- The launcher requires Node ≥ 24 inside WSL (nvm installs are detected
  explicitly by `start-backend.sh`).
