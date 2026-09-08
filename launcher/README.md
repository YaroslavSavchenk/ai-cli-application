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
shuts down immediately, skipping the grace. Nothing is lost: every session
is kept in the backend's session history and can be resumed later, on this
run or any future one (a Claude session resumes its own conversation, pinned
at launch with `--session-id` and resumed with `--resume`).

The port is auto-picked by the backend; nothing is ever hardcoded. Always
`127.0.0.1`, never `localhost` (the server binds IPv4 only; `::1` fails).

## Files

| File | Role |
| --- | --- |
| `make-shortcut.ps1` | run once: creates the "AI Session Manager" shortcuts (and stamps their `System.AppUserModel.ID`) |
| `launch-silent.vbs` | what the shortcuts run — fully hidden launch, no console ever |
| `launch.ps1` | the actual launcher logic (all switches + the three UI tiers) |
| `launch.cmd` | visible/debug path: same launcher with a console you can read |
| `config-common.ps1` | shared distro / repo-path resolution, dot-sourced by both PowerShell scripts |
| `start-backend.sh` | Linux side: detached (`setsid`) backend start |
| `build-host.ps1` | one-time build of the native WebView2 host (fetches the WebView2 SDK, compiles with the in-box csc — no .NET SDK) |
| `host/AiSessionManagerHost.cs` | source of the native host window (Tier 1) |
| `host/build/` | build output (exe + WebView2 DLLs) — build it, or unzip the release asset here; **git-ignored, never committed** |
| `app.ico` / `make-icon.mjs` | the icon and the script that generates it |

## Setup (once)

From Windows (Run dialog, Explorer address bar, or any terminal) — replace
`<distro>` and the path with your own clone:

    powershell -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\<distro>\<your clone>\launcher\make-shortcut.ps1"

(or from inside WSL, in the repo:
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File launcher/make-shortcut.ps1`
— that is the easy way: no UNC path to type. Add `-DryRun` to print the
resolved config and shortcut target and exit without creating anything.)

This creates **"AI Session Manager"** on the Desktop and in the Start Menu
(user scope, no admin), pointing at `wscript.exe launch-silent.vbs`. The
icon is copied to `%LOCALAPPDATA%\ai-session-manager\app.ico` so it renders
even while WSL is down (the `\\wsl.localhost` share is unreachable until
the VM boots). Re-running the script just overwrites the shortcuts and
refreshes the icon copy — safe any time the repo moves or the icon
changes.

**No configuration needed for a fresh clone.** The distro and the repo path
are *derived from where the launcher itself lives*: Windows sees these
scripts as `\\wsl.localhost\<distro>\<linux path>\launcher` (or the older
`\\wsl$\...`), which states both values, so a clone at
`/home/them/ai-cli-application` on `Ubuntu-22.04` just works. The
derivation lives in `config-common.ps1` and is shared by `launch.ps1` and
`make-shortcut.ps1`, so the two can never disagree.

Precedence for `$Distro` and `$RepoPath`, highest first:

1. the environment variables `AI_SM_DISTRO` / `AI_SM_REPO_PATH` — a supported
   override (also what the automated tests use); normally unnecessary, because
   the derivation below already covers a clone anywhere;
2. **derived from the launcher's own location** — the normal case;
3. the hardcoded defaults at the top of `launch.ps1` /
   `make-shortcut.ps1` (`Ubuntu-24.04`, `/home/sava/projects/ai-cli-application`).
   These only matter when the launcher folder was **copied out of the
   repo** onto a normal drive path (`C:\...`), where there is nothing to
   derive.

Every launch that is not `-Silent` prints one line saying what it resolved
and from where, e.g.
`Config: distro 'Ubuntu-22.04', repo '/home/them/ai-cli-application' (from launcher location)`.

Notes:

- Whatever the source, both values must pass a strict allow-list (absolute
  Linux path, and letters, digits, `.`, `_`, `-`, `/` only) — that check is
  what keeps them safe to put on a WSL command line. **A repo path with a
  space in it is refused**, and it is never silently replaced by the default
  (that would start a backend for a repo you don't have). An environment
  override is no way around this: `AI_SM_REPO_PATH` and `AI_SM_DISTRO` are
  checked against exactly the same character set. The real fix for a clone at,
  say, `/home/you/My Projects/app` is to clone it again into a path the
  allow-list accepts; for a distro whose name holds other characters, to
  re-import it under a plain name (`wsl --export`, then `wsl --import`).
- The distro name still auto-resolves by unique prefix: if the resolved
  name is not installed but exactly one installed distro starts with it
  (e.g. `Ubuntu` → a lone `Ubuntu-22.04`), that one is used with a notice.
  No match, or an ambiguous match (`Ubuntu-22.04` **and** `Ubuntu-24.04`),
  is an error listing what `wsl.exe -l -q` reports — set `AI_SM_DISTRO` to
  the exact name.
- `$DataDir` — backend data dir, default `~/.ai-session-manager`, at the
  top of `launch.ps1`; override with `AI_SM_DATA_DIR`.

## Native host (taskbar icon)

Tier 1 is a tiny native **WebView2** window whose only job is Windows taskbar
identity: the process sets its AppUserModelID to `AiSessionManager` (before any
window is created), and `make-shortcut.ps1` stamps the **same** string on the
Desktop/Start-Menu `.lnk` via `System.AppUserModel.ID`. Because the two match
byte-for-byte and the process owns both, Windows groups the window under the
shortcut and draws `app.ico`. The Edge `--app` window cannot do this (Chromium
stamps its own per-URL AUMID that carries the churning auto-picked port).

Build it once (needs network the first time, for the WebView2 NuGet package):

    powershell -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\<distro>\<your clone>\launcher\build-host.ps1"

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

### Or download it

Every GitHub Release attaches **`AiSessionManagerHost-win-x64.zip`** — the
exe plus the three WebView2 DLLs, built by GitHub Actions from the tagged
source with the same pinned, hash-verified WebView2 SDK `build-host.ps1`
uses — next to a `SHA256SUMS.txt` for the release assets.

1. Download the zip (and `SHA256SUMS.txt` if you want to check it:
   `Get-FileHash AiSessionManagerHost-win-x64.zip -Algorithm SHA256` in
   PowerShell — it prints UPPERCASE hex while the file lists lowercase, so a
   difference in case is not a mismatch — or `sha256sum -c --ignore-missing
   SHA256SUMS.txt` inside WSL, run in the download folder — a Windows download
   lives under `/mnt/c/Users/<you>/Downloads` — where `--ignore-missing` is what
   lets the file's five entries be checked against the one or two you actually
   downloaded).
2. Extract its **contents** into `launcher/host/build/` — create that
   folder; it is git-ignored and empty in a fresh clone. From Windows that
   is `\\wsl.localhost\<distro>\<your clone>\launcher\host\build\`
   in Explorer; from inside WSL, `unzip AiSessionManagerHost-win-x64.zip -d
   launcher/host/build`.
3. Start the app as usual — the next launch finds the exe and uses Tier 1.

`AiSessionManagerHost.exe` must sit directly in `host/build/`, beside
`Microsoft.Web.WebView2.Core.dll`, `Microsoft.Web.WebView2.WinForms.dll`
and `WebView2Loader.dll` (no extra subfolder).

About the SmartScreen warning: this exe is **not code-signed**, because
signing needs a paid certificate. In practice you should not see a warning
— the launcher copies the exe to `%LOCALAPPDATA%\ai-session-manager\host\`
and runs `Unblock-File` on the copy before starting it, and files coming in
through the WSL share carry no Mark-of-the-Web for Windows to react to. If
Windows does show "Windows protected your PC", it is because the download
itself was marked: choose **More info → Run anyway**. Only do that for a
zip you downloaded from this project's own releases page and, ideally, whose
SHA-256 matches `SHA256SUMS.txt`. If you would rather not trust a
prebuilt binary at all, run `build-host.ps1` — it produces exactly the same
four files from the source in your clone, and skipping the host entirely
just means the Edge `--app` window (Tier 2) with the Edge taskbar icon.

**Dark window chrome.** The caption bar and border are drawn by DWM, not by
the page, so a maximized window used to show the default light Windows caption
above the dark UI. On every handle creation the host applies
`DwmSetWindowAttribute`: immersive dark mode (attribute `20`, falling back to
the legacy `19`) plus caption / text / border colors taken straight from
`web/src/styles/tokens.css` — `--bg-app` `#171D25`, `--text-hd` `#AAB7C4`,
`--edge` `#262F3B`. The three color attributes need **Windows 11 build
22000+**; on Windows 10 they fail harmlessly and the caption stays in plain
dark mode. Every failure path is non-fatal and logged — this is cosmetic and
must never break the window. Keep the constants in sync if those tokens change.
The Edge `--app` fallback window is unaffected and still shows a light caption.

**Keyboard focus, links and the clipboard.** Four behaviours the host adds
for the page:

- **Focus comes back on activation.** WebView2 draws the page in its own child
  window, so the host window could become active again — after an Alt-Tab, or
  after a link opened the system browser and the user clicked back on the
  title bar — with nothing in the page holding the keyboard: typing and
  pasting went nowhere (an OAuth "paste your code here" prompt is where this
  bites). The host now re-focuses the web content on every window activation
  and after every completed navigation.
- **External links open in your default browser.** A link the page opens in a
  new window (`window.open`, `target=_blank`, ctrl-click) that points outside
  the app's own origin is handed to Windows' default browser, in its own
  process. Three conditions, all required: the request must be **user
  initiated** (WebView2's own `IsUserInitiated` — a scripted `window.open` the
  page fires by itself is dropped), the scheme must be exactly `http` or
  `https`, and the target must be off-origin. WebView2 never opens a popup of
  its own. This is the only way out of the origin lock, and it is one-way: the
  host window itself still cannot navigate anywhere but the launch origin.
  `host.log` records such a hand-off as scheme + host only, never the full URL
  (an OAuth link carries secrets in its query).
- **A same-origin new-window request is dropped**, not navigated. The handler
  once redirected such a request into the existing window; it no longer does,
  because a link printed inside a terminal pane could then replace the running
  app with any page on that origin — an unauthenticated 401, say — and this
  window has no address bar and no back button to return from it. Nothing in
  the app opens a same-origin new window.
- **Clipboard read is granted to the app's own origin**, so the page can offer
  a paste command that reads the Windows clipboard (`Ctrl+Shift+V`). Every
  other permission request, and any request from any other origin, is denied
  silently — the host answers them itself, so WebView2 never shows a prompt.

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
    sessions end right away; they stay in the session history and can be
    resumed on the next start.
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
grace after closing the last one. After a fresh start, the session history
is still there and any of its sessions can be resumed.

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
  the next plain launch starts a fresh one automatically, and the sessions
  the crash cut short are in the session history, ready to resume.
- Nothing at all happens on double-click and no error box → check that
  `\\wsl.localhost\<distro>\...\launcher` is reachable in Explorer
  (WSL may need `wsl.exe --update` if the share is broken), then re-run
  `make-shortcut.ps1`.
- Launcher starts the **wrong** repo or distro → run `launch.cmd -Status`
  and read the `Config:` line: it names both values and where they came
  from. `from built-in default` means the launcher folder is not inside the
  repo (copied out); `from AI_SM_...` means an environment variable is set.
- Blank/generic icon on the shortcut → the local icon copy at
  `%LOCALAPPDATA%\ai-session-manager\app.ico` is missing (the shortcut
  normally reads the local copy; it falls back to the WSL share only if
  that copy failed — see the warning printed by `make-shortcut.ps1`).
  Re-run `make-shortcut.ps1` to restore it.
- The launcher requires Node ≥ 24 inside WSL (nvm installs are detected
  explicitly by `start-backend.sh`).
