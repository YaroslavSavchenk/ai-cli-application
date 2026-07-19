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

The backend is never a child of the launcher or the browser window — as
implemented today, closing the window (or the launcher) never kills
sessions; stop explicitly with `-Stop`. (Decided 2026-07-19, not yet
implemented: backend lifetime will instead be bound to UI presence —
sessions end after a ~30 s grace once the last window closes; see
`memory/decisions/lifecycle-bound-backend.md`.)

The port is auto-picked by the backend; nothing is ever hardcoded. Always
`127.0.0.1`, never `localhost` (the server binds IPv4 only; `::1` fails).

## Files

| File | Role |
| --- | --- |
| `make-shortcut.ps1` | run once: creates the "AI Session Manager" shortcuts |
| `launch-silent.vbs` | what the shortcuts run — fully hidden launch, no console ever |
| `launch.ps1` | the actual launcher logic (all switches live here) |
| `launch.cmd` | visible/debug path: same launcher with a console you can read |
| `start-backend.sh` | Linux side: detached (`setsid`) backend start |
| `app.ico` / `make-icon.mjs` | the icon and the script that generates it |

## Setup (once)

From Windows (Run dialog, Explorer address bar, or any terminal):

    powershell -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\Ubuntu-24.04\home\sava\projects\ai-cli-application\launcher\make-shortcut.ps1"

(or from inside WSL, in the repo:
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File launcher/make-shortcut.ps1`)

This creates **"AI Session Manager"** on the Desktop and in the Start Menu
(user scope, no admin), pointing at `wscript.exe launch-silent.vbs` with
`app.ico`. Re-running it just overwrites the shortcuts — safe any time the
repo moves.

Config lives at the top of `launch.ps1` (make-shortcut.ps1 shares the same
defaults):

- `$Distro` — default `Ubuntu-24.04` (this machine's install). An exact
  match is used silently. If the configured name is not installed but
  exactly one installed distro starts with it (e.g. `Ubuntu` → a lone
  `Ubuntu-22.04`), the launcher uses that one and prints a notice. No
  match, or an ambiguous match (`Ubuntu-22.04` **and** `Ubuntu-24.04`), is
  an error that lists what `wsl.exe -l -q` reports — set the exact name.
- `$RepoPath` — Linux path of the repo (default
  `/home/sava/projects/ai-cli-application`).
- `$DataDir` — backend data dir (default `~/.ai-session-manager`).

Each value can also be overridden per-invocation via the environment
variables `AI_SM_DISTRO`, `AI_SM_REPO_PATH`, `AI_SM_DATA_DIR` (used by
automated tests; normally leave them unset).

## Run

**Double-click the "AI Session Manager" icon.** Nothing flashes, no console
appears; the Edge app window opens when the backend is ready. If the launch
fails, a native error box tells you what went wrong and points you at
`launch.cmd` for the full console output.

Icon-click = `wscript.exe launch-silent.vbs` = hidden
`powershell launch.ps1 -Silent`. Same logic, three entry points:

- `launch.cmd` — the **visible/debug path**: run it from Explorer or a
  terminal whenever you want to watch the launcher work (progress dots,
  distro resolution, error details). Takes the same switches.
- `launch.ps1` switches:
  - `-Silent` — no console assumed: any failure surfaces as a native
    message box (with a hint to run `launch.cmd`) instead of console text.
    Success shows nothing until the Edge app window opens. This is what
    the shortcut/VBS path uses; rarely typed by hand.
  - `-Status` — print backend state from runtime.json (port, pid,
    startedAt; the auth token is never printed) and the health-check
    result. Exit code 0 = running and healthy, 1 = not running or stale.
  - `-Stop` — graceful shutdown: SIGTERM to the pid from runtime.json,
    then confirm the server removed runtime.json. Running sessions die
    with the server — stop deliberately.
  - `-NoBrowser` — do everything except opening the UI (scripts/tests).

## Cold boot expectations

The first click after a Windows reboot has to boot the WSL VM **and** the
backend: expect **~10–30 s where nothing visible happens** — that is normal
for the silent path; the window appears when the backend is healthy. The
launcher polls for up to 90 s before declaring failure (as a message box
when silent). Warm launches — backend already running — attach and open the
window in about a second.

## Pinning

- Start Menu: the shortcut makes "AI Session Manager" findable in Start
  search — right-click it there → Pin to Start / Pin to taskbar.
- Desktop: right-click the desktop icon → Pin to taskbar.
- Do **not** pin the Edge app window itself: an Edge `--app` pin bakes in
  the URL, and with auto-picked ports it goes stale after a backend
  restart. Pin the launcher shortcut; it always resolves the current port.

## Icon

`app.ico` is generated — never hand-edited — by `make-icon.mjs` (plain
Node, no deps): 16/32/48/256 px, 32bpp BMP entries, phosphor design
language (warm-graphite square, 1px border, green `>_`).

    node launcher/make-icon.mjs           # regenerate + self-verify
    node launcher/make-icon.mjs --check   # verify committed bytes match a fresh render

## Troubleshooting

- **Error box appeared** (silent launch failed) → run `launch.cmd` for the
  full console story; the box text names the same cause.
- Backend log: `~/.ai-session-manager/server.log` inside the distro.
- `launch.cmd -Status` says stale → the backend crashed or was SIGKILLed;
  the next plain launch starts a fresh one automatically.
- Nothing at all happens on double-click and no error box → check that
  `\\wsl.localhost\Ubuntu-24.04\...\launcher` is reachable in Explorer
  (WSL may need `wsl.exe --update` if the share is broken), then re-run
  `make-shortcut.ps1`.
- Blank/generic icon on the shortcut right after a reboot → Explorer could
  not read `app.ico` over `\\wsl.localhost` before WSL was up; it fixes
  itself once WSL has booted (first launch). The icon cache usually keeps
  it correct after that.
- The launcher requires Node ≥ 24 inside WSL (nvm installs are detected
  explicitly by `start-backend.sh`).
