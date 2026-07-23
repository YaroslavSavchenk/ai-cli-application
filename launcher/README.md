# Windows launcher

Thin Windows-side launcher for the AI CLI Session Manager backend that runs
inside WSL2. It reads the backend's discovery file
(`~/.ai-session-manager/runtime.json` inside the distro, via `wsl.exe cat`),
health-checks the discovered port on `http://127.0.0.1:<port>/health`, and:

- **healthy** → opens the UI through a three-tier fallback:
  - **Tier 1 — native WebView2 host** (`host/build/AiSessionManagerHost.exe`,
    built by `build-host.ps1`): a real window that owns its own
    AppUserModelID (`AiSessionManager`, matched on the launching shortcut), so
    the Windows **taskbar** button shows `app.ico` instead of the Edge logo.
    Used only when the exe is built **and** the WebView2 Evergreen runtime is
    present; any real failure (missing runtime, init throw, no ready signal in
    ~8 s) falls through.
  - **Tier 2 — Edge `--app`** chromeless window (the original MVP shell), if
    Edge is found at either install layout or via its `msedge.exe` App-Paths
    registration;
  - **Tier 3 — default browser** (regular tab) with an auto-dismissing warning
    popup on the silent path.
- **absent or stale** (dead pid / failed health) → starts the backend
  **detached** (`setsid`, via `start-backend.sh`), waits for
  runtime.json + health, then opens the UI (same three tiers).

The backend is never a child of the launcher or the browser window — it
starts in its own session and outlives the launcher console. Its lifetime
is instead bound to UI presence (decided and implemented 2026-07-19; see
`memory/decisions/lifecycle-bound-backend.md`): every app window holds a
presence WebSocket, and when the last one closes the backend waits a ~30 s
grace period (so reloads and accidental closes reattach harmlessly), then
ends all sessions, removes runtime.json, and exits. **Closing the window
ends your sessions** — nothing keeps running in the background. `-Stop`
shuts down immediately, skipping the grace. On the next start the sessions
drawer offers the previous run's sessions for one-click relaunch (Claude
sessions resume with `--continue`).

The port is auto-picked by the backend; nothing is ever hardcoded. Always
`127.0.0.1`, never `localhost` (the server binds IPv4 only; `::1` fails).

## Files

| File | Role |
| --- | --- |
| `make-shortcut.ps1` | run once: creates the "AI Session Manager" shortcuts (and stamps their `System.AppUserModel.ID`) |
| `launch-silent.vbs` | what the shortcuts run — fully hidden launch, no console ever |
| `launch.ps1` | the actual launcher logic (all switches + the three UI tiers) |
| `launch.cmd` | visible/debug path: same launcher with a console you can read |
| `start-backend.sh` | Linux side: detached (`setsid`) backend start |
| `build-host.ps1` | one-time build of the native WebView2 host (fetches the WebView2 SDK, compiles with the in-box csc — no .NET SDK) |
| `host/AiSessionManagerHost.cs` | source of the native host window (Tier 1) |
| `host/build/` | build output (exe + WebView2 DLLs) — **git-ignored, never committed** |
| `app.ico` / `make-icon.mjs` | the icon and the script that generates it |

## Setup (once)

From Windows (Run dialog, Explorer address bar, or any terminal):

    powershell -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\Ubuntu-24.04\home\sava\projects\ai-cli-application\launcher\make-shortcut.ps1"

(or from inside WSL, in the repo:
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File launcher/make-shortcut.ps1`)

This creates **"AI Session Manager"** on the Desktop and in the Start Menu
(user scope, no admin), pointing at `wscript.exe launch-silent.vbs`. The
icon is copied to `%LOCALAPPDATA%\ai-session-manager\app.ico` so it renders
even while WSL is down (the `\\wsl.localhost` share is unreachable until
the VM boots). Re-running the script just overwrites the shortcuts and
refreshes the icon copy — safe any time the repo moves or the icon
changes.

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

## Native host (taskbar icon)

Tier 1 is a tiny native **WebView2** window whose only job is Windows taskbar
identity: the process sets its AppUserModelID to `AiSessionManager` (before any
window is created), and `make-shortcut.ps1` stamps the **same** string on the
Desktop/Start-Menu `.lnk` via `System.AppUserModel.ID`. Because the two match
byte-for-byte and the process owns both, Windows groups the window under the
shortcut and draws `app.ico`. The Edge `--app` window cannot do this (Chromium
stamps its own per-URL AUMID that carries the churning auto-picked port).

Build it once (needs network the first time, for the WebView2 NuGet package):

    powershell -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\Ubuntu-24.04\home\sava\projects\ai-cli-application\launcher\build-host.ps1"

(or from inside WSL: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File launcher/build-host.ps1`)

What it does:

- Compiles `host/AiSessionManagerHost.cs` with the **in-box** Framework C#
  compiler (`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`) — no
  .NET SDK required — into `host/build/AiSessionManagerHost.exe`, a tiny
  framework-dependent x64 exe with `app.ico` embedded as its Win32 icon.
- Downloads the pinned `Microsoft.Web.WebView2` NuGet package (`1.0.3405.78`)
  over HTTPS, **verifies its size + SHA-256**, and extracts the three DLLs it
  needs beside the exe (`Microsoft.Web.WebView2.Core.dll`,
  `...WinForms.dll`, `WebView2Loader.dll`). Nothing from the package is
  committed; the whole `host/build/` folder is git-ignored.

The host navigates only to the resolved `http://127.0.0.1:<port>/` and is
**navigation-locked** to that origin (127.0.0.1/localhost); it monitors nothing
and kills nothing — backend lifetime stays presence-bound exactly as with the
browser window. Requirement: the **WebView2 Evergreen runtime** (ships with
Edge). If it is absent, the launcher silently uses the Edge `--app` window
instead. If the exe is not built, the launcher uses Edge too — building the
host is optional, it only upgrades the taskbar icon.

The host writes two files under `%LOCALAPPDATA%\ai-session-manager\`:
`host-ready` (its pid, once the window is coming up — the launcher waits for
this to confirm Tier 1 succeeded) and `host.log` (UTC-stamped fatal/init
diagnostics). Its WebView2 profile lives in
`%LOCALAPPDATA%\ai-session-manager\webview2\`.

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
  - `-Stop` — immediate shutdown, no grace period: SIGTERM to the pid from
    runtime.json, then confirm the server removed runtime.json. Running
    sessions end right away; the next start offers them for relaunch as a
    previous run.
  - `-NoBrowser` — do everything except opening the UI (scripts/tests).

## Cold boot expectations

The first click after a Windows reboot has to boot the WSL VM **and** the
backend: expect **~10–30 s where nothing visible happens** — that is normal
for the silent path; the window appears when the backend is healthy. The
launcher polls for up to 90 s before declaring failure (as a message box
when silent).

Because the backend exits when the last window closes, most launches are
cold starts of the backend (a few seconds once the WSL VM is up). A warm
attach — window open in about a second — only happens while the backend is
still alive: another app window is open, or you relaunch within the ~30 s
grace after closing the last one. After a fresh start, the sessions drawer
offers the previous run's sessions for relaunch instead.

A started backend never lingers unused: if the launcher fails to open a
window (or you close it before it connects), the backend exits on its own
after a ~120 s startup grace with no window ever connected.

## Pinning

- Start Menu: the shortcut makes "AI Session Manager" findable in Start
  search — right-click it there → Pin to Start / Pin to taskbar.
- Desktop: right-click the desktop icon → Pin to taskbar.
- Pin the **launcher shortcut**, never the app window: the shortcut always
  resolves the current auto-picked port, and it carries the
  `AiSessionManager` AppUserModelID that matches the native host window (Tier
  1), so a pinned shortcut and the live window share one taskbar button
  showing `app.ico`. Re-run `make-shortcut.ps1` after building the host so the
  shortcut carries that AUMID.
- With Tier 2 (Edge fallback) do **not** pin the Edge app window itself: an
  Edge `--app` pin bakes in the URL, goes stale after a backend restart, and
  shows the Edge logo.

## Icon

`app.ico` is generated — never hand-edited — by `make-icon.mjs` (plain
Node, no deps): 16/32/48/256 px, 32bpp BMP entries, phosphor design
language (warm-graphite square, 1px border, green `>_`).

The same script also emits the **web icon set** into `web/public/` (copied to
the dist root by Vite and served by the backend), so the Edge `--app`
chromeless window gets a real window/taskbar icon instead of the Edge logo:

| Output | What |
| --- | --- |
| `web/public/favicon.ico` | byte-identical to `app.ico` |
| `web/public/icon-192.png` | 192 px, PNG RGBA (node:zlib only, no deps) |
| `web/public/icon-512.png` | 512 px, PNG RGBA |
| `web/public/manifest.json` | names the icon set; **not** installable — no `display`/`start_url`, so no PWA pins the auto-picked port |

`web/index.html` declares them (`<link rel="icon">` × 3, `<link
rel="manifest">`, `<meta name="theme-color" content="#1b222c">`). All five
outputs are committed artifacts.

    node launcher/make-icon.mjs           # regenerate all 5 outputs + self-verify
    node launcher/make-icon.mjs --check   # verify committed outputs match a fresh render

`--check` compares ICO/JSON bytes exactly and PNG *pixels* (decoded), so a
differing zlib build never trips a false failure.

After regenerating, re-run `make-shortcut.ps1` so the Windows-local copy at
`%LOCALAPPDATA%\ai-session-manager\app.ico` (what the shortcuts actually
display) picks up the new bytes. Web icon changes need a `npm run build` to
reach the dist root.

## Troubleshooting

- **Error box appeared** (silent launch failed) → run `launch.cmd` for the
  full console story; the box text names the same cause.
- Backend log: `~/.ai-session-manager/server.log` inside the distro.
- `launch.cmd -Status` says stale → the backend crashed or was SIGKILLed;
  the next plain launch starts a fresh one automatically and offers the
  crashed run's sessions for relaunch.
- Nothing at all happens on double-click and no error box → check that
  `\\wsl.localhost\Ubuntu-24.04\...\launcher` is reachable in Explorer
  (WSL may need `wsl.exe --update` if the share is broken), then re-run
  `make-shortcut.ps1`.
- Blank/generic icon on the shortcut → the local icon copy at
  `%LOCALAPPDATA%\ai-session-manager\app.ico` is missing (the shortcut
  normally reads the local copy; it falls back to the WSL share only if
  that copy failed — see the warning printed by `make-shortcut.ps1`).
  Re-run `make-shortcut.ps1` to restore it.
- The launcher requires Node ≥ 24 inside WSL (nvm installs are detected
  explicitly by `start-backend.sh`).
