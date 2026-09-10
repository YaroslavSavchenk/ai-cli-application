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
| `config-common.ps1` | shared distro / app-path resolution (env → config file → derived → nothing) and the allow-list every value passes; dot-sourced by both PowerShell scripts, and by every installer helper |
| `start-backend.sh` | Linux side: detached (`setsid`) backend start; prefers a bundled runtime, falls back to PATH/nvm |
| `run-update.ps1` | Windows side of the in-app update: re-hashes the Setup exe the backend downloaded, then runs it silently (`/SILENT /SUPPRESSMSGBOXES /NORESTART /LOG=`) and removes the staging directory |
| `build-host.ps1` | one-time build of the native WebView2 host (fetches the WebView2 SDK, compiles with the in-box csc — no .NET SDK) |
| `host/AiSessionManagerHost.cs` | source of the native host window (Tier 1) |
| `host/build/` | build output (exe + WebView2 DLLs) — build it, or unzip the release asset here; **git-ignored, never committed** |
| `app.ico` / `make-icon.mjs` | the icon and the script that generates it |

## Installed layout (the Setup) vs a clone

Two shapes run the same scripts.

**A developer clone**: `launcher/` sits inside the repo, Windows reaches it as
`\\wsl.localhost\<distro>\<clone>\launcher`, and that path states both the
distro and the repo — nothing to configure.

**An installation** (`installer/`, see `installer/README.md`): the launcher
scripts are copied to a plain Windows path,
`%LOCALAPPDATA%\Programs\AI Session Manager\`, where nothing can be derived.
The Setup therefore writes **`launcher-config.json`** beside them:

    {
      "distro": "Ubuntu-24.04",
      "appPath": "/home/you/.ai-session-manager/app/current"
    }

Both keys are optional and both are checked against the same allow-list as
every other source. A file that exists but cannot be believed — not JSON, not
an object, a key that is not a non-empty string — is an **error**, never a
fall-through: an installed launcher with a damaged config stops with a
message instead of quietly starting a different backend. The installation
folder also holds `install-info.txt` (`distro`, `appDir`, `version`), which is
what the uninstaller reads before offering to remove the WSL side, and
`host\AiSessionManagerHost.exe`, which is run **in place** — the
`%LOCALAPPDATA%\ai-session-manager\host` staging copy exists only for the
clone case, where the exe would otherwise run from a UNC path.

The Setup never writes `host\` directly: it installs the host into
**`host\next\`**, and `launch.ps1` promotes that folder into `host\` at the
next start, just before it opens the window (`Move-AiSmHostNext` in
`config-common.ps1`). The reason is the in-app update: it runs the Setup while
the old host window is still open, and `CloseApplications=no` means those four
files are locked. Promotion copies each file with three 200 ms retries; if any
one of them is still in use, `next\` is left **whole** for the next launch and
the launch continues with the host that is installed — one printed line, no
error. It never fails a launch. (In practice all four files are locked
together, by the same open window; if a copy ever fails halfway, `next\` still
holds the complete set and the following launch copies it again.)

## Bundle layout (the installed app)

Installed from the Setup, the WSL side is **not a clone**: it is a
self-contained bundle unpacked at `~/.ai-session-manager/app/<version>/`, with
`~/.ai-session-manager/app/current` symlinked to the version in use. The data
dir (`~/.ai-session-manager/` itself — runtime.json, history, prefs,
server.log) is never touched by an install, an update or an uninstall.

    <version>/bundle.json            version marker: version, commit, nodeVersion, builtAt, platform, glibcMin
    <version>/node/bin/node          pinned official Node 24 (SHA-256 verified against nodejs.org)
    <version>/node/LICENSE
    <version>/package.json           (a bundle has no package-lock.json)
    <version>/node_modules/…         production deps only; node-pty compiled against the node above
    <version>/server/…               the backend (incl. statusline.mjs)
    <version>/shared/…
    <version>/web/dist/…             the built frontend
    <version>/launcher/start-backend.sh
    <version>/launcher/run-update.ps1  the Windows-side updater runner (copied out to %TEMP%, never run in Linux)

Built by `scripts/build-bundle.sh --version <vX.Y.Z> --node <24.x.y>` (see the
header of that script), which verifies the Node download against nodejs.org's
`SHASUMS256.txt` before extracting anything and refuses to finish unless the
bundle it just built boots, serves and shuts down cleanly.

`start-backend.sh` is the same script in both worlds, and it makes two choices
from where it lives:

- **which node** — `<app root>/node/bin/node` if that exists (a bundle: it is
  the runtime node-pty was compiled against, so it is used unprobed), otherwise
  a Node ≥ 24 from the login PATH, else from nvm (`nvm.sh` sourced explicitly —
  non-interactive login shells never see it);
- **from where** — it `cd`s to the **physical** directory containing itself
  (`cd -P`/`pwd -P`), so a start through `current/launcher/start-backend.sh`
  pins the server to that version directory. `current` may be moved by the next
  update while the server runs; its files must not move with it.

Its exit codes, as `launch.ps1` maps them to messages:

| Code | Meaning |
| --- | --- |
| 0 | started, detached (the launcher then polls runtime.json + `/health`) |
| 10 | app/repo directory missing, or `cd` failed |
| 11 | no usable node found (PATH and nvm both checked) |
| 12 | a node was found, but older than 24 |
| 13 | the data dir argument was not absolute after shell expansion |

11 and 12 are developer-clone codes: an installed bundle carries its own
runtime, so seeing either one there means the bundle is incomplete — reinstall.

## In-app update (the Windows half)

An installed app checks GitHub for a newer release and offers one **Update**
button. Everything up to "run the installer" happens in the backend, inside
WSL; this directory holds the last step.

1. The backend downloads the release's `AI-Session-Manager-Setup-<version>.exe`
   and `SHA256SUMS.txt`, verifies the exe against the sums file, and only then
   gives the file its `.exe` name.
2. It copies that exe **and `run-update.ps1`** (out of the running bundle,
   `<version>/launcher/run-update.ps1`) into a Windows staging directory,
   `%TEMP%\ai-session-manager-update\<version>\`.
3. It starts, by full path and argv only:

       powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass ^
         -File <staging>\run-update.ps1 ^
         -SetupPath <staging>\AI-Session-Manager-Setup-<version>.exe ^
         -ExpectedSha <64 lowercase hex> ^
         -LogPath <staging>\setup.log

`run-update.ps1` refuses anything that is not exactly that shape: the exe must
lie directly in the script's own directory, its name must match
`AI-Session-Manager-Setup-v<...>.exe`, the hash must be 64 lowercase hex
characters, and both Windows paths are charset-gated. It then **re-hashes the
file with `Get-FileHash`** — the backend already verified those bytes, but this
is the last moment before Windows executes them — `Unblock-File`s it, and runs
it with `Start-Process -Wait`. Its staging directory (exe, Setup log, the
script itself) is removed in a `finally`; that removal only ever applies to a
path holding an `ai-session-manager-update` segment, so the master copy in the
bundle can never delete anything.

| Exit | Meaning |
| --- | --- |
| 0 | the Setup ran and finished |
| 2 | the file did not match `-ExpectedSha`; it was **deleted** and nothing ran |
| 3 | this script refused (bad arguments, missing file, could not start) |
| other | the Setup's own exit code, unchanged |

`-DryRun` prints the exact `Start-Process` argv and exits 0 without hashing,
starting or deleting anything — that is how `tests/run-update.test.ts` pins
this interface from WSL.

The Setup itself reuses the distro and Linux folder recorded in
`install-info.txt` (never the machine default), replaces the bundle inside WSL
and moves `current`, and installs the new host into `host\next\`. The app then
continues into its normal **Restart backend** handoff, and the new host window
appears at the next launch, when `next\` is promoted.

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

The shortcut points at **the folder `make-shortcut.ps1` itself sits in**
whenever `launch-silent.vbs` is beside it — the `\\wsl.localhost` share in a
clone, `%LOCALAPPDATA%\Programs\AI Session Manager` after a Setup install —
and only falls back to building a `\\wsl.localhost\<distro>\<repo>\launcher`
path when it is not. So a launcher folder copied out of the repo onto a plain
Windows path makes its own folder the target, and that folder needs
`launcher-config.json` (what the Setup writes) or `AI_SM_DISTRO` /
`AI_SM_REPO_PATH` before anything it launches can resolve a distro and an app
path.

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
   the two sources below already cover both a clone and an installation;
2. **`launcher-config.json` next to the scripts** — what the Windows Setup
   writes (see the installed layout above). A corrupt one is an error, not a
   fall-through;
3. **derived from the launcher's own location** — the normal case for a
   clone;
4. the defaults at the top of `launch.ps1` / `make-shortcut.ps1`, which are
   **empty**. A launcher folder copied onto a plain Windows path with no
   config file and no environment variables therefore **fails with a
   message** naming all three ways to fix it — it does not start a backend
   for a repo that is not yours, in a distro you did not pick.

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
- There is **no built-in fallback repo or distro** any more. `launch.ps1
  -Status` on a launcher that can resolve nothing prints `No launcher
  configuration found: …` and exits 1.

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
exe plus the three WebView2 DLLs, built by the `native host (win-x64)` job of
`.github/workflows/release.yml` from the tagged source with the same pinned,
hash-verified WebView2 SDK `build-host.ps1` uses — next to a `SHA256SUMS.txt`
covering every asset of that release. The zip exists for people running from a
clone: the Windows Setup on the same release page already contains these four
files (the `windows setup` job feeds the same zip into it).

1. Download the zip (and `SHA256SUMS.txt` if you want to check it:
   `Get-FileHash AiSessionManagerHost-win-x64.zip -Algorithm SHA256` in
   PowerShell — it prints UPPERCASE hex while the file lists lowercase, so a
   difference in case is not a mismatch — or `sha256sum -c --ignore-missing
   SHA256SUMS.txt` inside WSL, run in the download folder — a Windows download
   lives under `/mnt/c/Users/<you>/Downloads` — where `--ignore-missing` is what
   lets the file's seven entries — the three downloads plus the four files
   inside this zip — be checked against the one or two you actually
   downloaded).
2. Extract its **contents** into `launcher/host/build/` — create that
   folder; it is git-ignored and empty in a fresh clone. From Windows that
   is `\\wsl.localhost\<distro>\<your clone>\launcher\host\build\`
   in Explorer; from inside WSL, `unzip AiSessionManagerHost-win-x64.zip -d
   launcher/host/build`.
3. Start the app as usual — the next launch finds the exe and uses Tier 1.

`AiSessionManagerHost.exe` must sit directly in `host/build/`, beside
`Microsoft.Web.WebView2.Core.dll`, `Microsoft.Web.WebView2.WinForms.dll`
and `WebView2Loader.dll` (no extra subfolder). An **installed** app keeps the
same four files one level up, in `host\` beside the launcher scripts, and
runs the exe from there directly; `launch.ps1` looks in `host\` first, then
`host\build\`.

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
`web/src/styles/tokens.css` — caption `--color-bg` `#161826`, text
`--color-neutral-200` `#E4E7F5` (what `--text-hd` aliases), border
`--color-neutral-800` `#3F424D`. The three color attributes need **Windows 11 build
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
Node, no deps): 16/32/48/256 px, 32bpp BMP entries, Nocturne design
language. The mark is transcribed from
`design_handoff_session_manager/app-icon.svg` (256-unit viewBox): a dark
rounded tile with a vertical gradient `#232532` → `#161826`, a 1px
`#3f424d` edge, a blurple `#b5abfc` chevron with round caps and joins, and a
light `#e9e9ed` cursor block. **Everything outside the rounded tile is
transparent** (the old phosphor icon was an opaque square): alpha now carries
the corners, and the ICO's 1bpp AND mask sets its bit for every alpha-0 pixel
so consumers that ignore the alpha channel still punch the corners out. The
16 px entry is a hand-placed pixel map (full-bleed tile, 1px corner cut, 2px
chevron, 4×2 cursor block) because anti-aliasing turns the mark to mush at
that size; 32/48/256 are the vector geometry at 4×4 supersampling.

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
rel="manifest">`, `<meta name="theme-color">`). `manifest.json` carries
`background_color` and `theme_color` `#161826` (`--color-bg`). All five
outputs are committed artifacts.

    node launcher/make-icon.mjs           # regenerate all 5 outputs + self-verify
    node launcher/make-icon.mjs --check   # verify committed outputs match a fresh render
    node launcher/make-icon.mjs --preview <dir>   # icon-preview-16/32/48/256.png, visual check only

`--check` compares ICO/JSON bytes exactly and PNG *pixels* (decoded), so a
differing zlib build never trips a false failure. `--preview` writes nothing
but those four throwaway PNGs and verifies nothing; it never touches a
committed output.

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
  from. `from config file` means `launcher-config.json` in the installation
  folder decides (re-run the Setup to rewrite it); `from launcher location`
  means it was derived from the clone's own path; `from AI_SM_...` means an
  environment variable is set.
- `No launcher configuration found` → the scripts are on a plain Windows
  path with no `launcher-config.json` and no environment variables. Install
  with the Setup, run them from inside the clone through
  `\\wsl.localhost\...`, or set `AI_SM_DISTRO` + `AI_SM_REPO_PATH`.
- Blank/generic icon on the shortcut → the local icon copy at
  `%LOCALAPPDATA%\ai-session-manager\app.ico` is missing (the shortcut
  normally reads the local copy; it falls back to the WSL share only if
  that copy failed — see the warning printed by `make-shortcut.ps1`).
  Re-run `make-shortcut.ps1` to restore it.
- The launcher requires Node ≥ 24 inside WSL (nvm installs are detected
  explicitly by `start-backend.sh`).
