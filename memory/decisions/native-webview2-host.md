---
type: decision
created: 2026-07-23
updated: 2026-09-26
tags: [launcher, windows, webview2, native-host, icon, chrome]
---
# Native WebView2 host to own the Windows taskbar icon

**Status:** decided (2026-07-23, user delegated the pick: "best, secure, not
that complicated")

## Problem

The Windows **taskbar** button for the launched app shows the Microsoft Edge
logo, not `app.ico`. The user wants it gone. The in-window icon is already
correct (`web/public/favicon.ico`, linked in `web/index.html`).

## Why the cheap fix is impossible (proven, no code shipped)

The `wsl-launcher` agent verified against the real machine (Edge 150,
`EdgeCore\150.0.4078.83\msedge.exe`) and STOPPED without shipping, for two
structural reasons — either fatal alone:

1. **The shortcut never launches Edge.** Chain is
   shortcut → `wscript.exe` (windowless) → `launch-silent.vbs` →
   `powershell launch.ps1` → `Start-Process msedge.exe --app=<url>`. Windows
   applies a shortcut's `System.AppUserModel.ID` only to the process it
   directly starts (wscript), never to a grandchild Edge window. And the
   shortcut *cannot* launch Edge directly — the URL/port isn't known until
   `launch.ps1` attaches-or-starts the backend and resolves the auto-picked
   port. The indirection is mandatory.
2. **Edge stamps its own per-URL AUMID on the `--app` window** (since
   Chromium v88), derived from profile path + app URL. The URL carries the
   churning `127.0.0.1:<port>`, so a static shortcut AUMID
   (`AiSessionManager`) can never match it. A dedicated
   `--user-data-dir` only splits it into a *separate Edge-logo* button — no
   icon benefit, at the cost of an isolated profile.

PWA-install (the normal escape) stays closed: non-installable manifest +
churning port (see [[localstorage-origin-port-churn]], [[auto-port-discovery]]).
Post-launch `SHGetPropertyStoreForWindow` HWND-stamping was considered and
rejected as unreliable (`--app` reuses an existing Edge PID; fragile
title-matching; races Chromium's own AUMID set).

## Decision

Bring the roadmapped native shell forward as a **lightweight WebView2 host
window** — NOT full Tauri:

- One process owns **both** the window AUMID and its shortcut AUMID, so they
  match and Windows draws `app.ico` for the taskbar group. This is the only
  reliable non-PWA path.
- Calls `SetCurrentProcessExplicitAppUserModelID("AiSessionManager")`
  before creating any window; window icon = `app.ico`; hosts a **WebView2**
  control pointed at the resolved `http://127.0.0.1:<port>/` (the host runs
  the same attach-or-start + port-resolution logic `launch.ps1` has today).
- Ships a Start-Menu/Desktop shortcut with matching
  `System.AppUserModel.ID` + `RelaunchIconResource` → `app.ico`.

## Why WebView2 host over Tauri (the "not that complicated" call)

- **No new language/toolchain.** The project is Node/Vite/PowerShell today;
  Tauri would add Rust + a cross-compile pipeline. WebView2's **Evergreen
  runtime already ships with Edge** (present on the user's Edge 150 box), so
  nothing to install at runtime.
- **Secure:** loads only `127.0.0.1:<port>`; navigation locked to that exact
  origin (in-frame AND new-window requests); devtools disabled; no new stored
  secret — the auth token is injected server-side into the served HTML
  (`window.__AUTH__`), never the URL, so the host handles no credential; no
  new network surface. As locked-down or more than today's Edge `--app`
  window. (Retention: the WebView2 profile under
  `%LOCALAPPDATA%\ai-session-manager\webview2` can cache that HTML like any
  browser profile — user-only dir, token is ephemeral per backend start; same
  posture as the Edge `--app` profile it replaces, no regression.)
- Full **Tauri** (tray, native folder picker) stays the later upgrade; this
  host is the minimum that fixes the taskbar identity.

## Open sub-questions for the build (dev-flow)

- How to acquire the WebView2 SDK assemblies without checking binaries into
  the repo (prefer NuGet/restore at build over vendored DLLs). Prefer a
  small **compiled** .NET host over fragile inline-PowerShell WinForms.
- Must preserve every current launcher mode: `-Status`, `-Stop`,
  `-NoBrowser`, `-Silent` message-box UX, lifecycle-bound presence, and the
  **fallback to the Edge `--app` window when the WebView2 runtime is absent**.
- Backend lifetime stays presence-bound: the host holds the presence WS like
  the browser window does today (see [[lifecycle-bound-backend]]).

## Follow-up decision (2026-07-24): dark window chrome, DWM route

Owning the window brought its **caption bar** with it — DWM draws it, the page
cannot, so a maximized host showed a white Windows caption + "AI Session
Manager" above the dark UI. User reported it; **user chose the DWM-coloring
route** (2026-07-24).

Shipped: on `HandleCreated`, `DwmSetWindowAttribute` sets immersive dark mode
(attribute `20`, legacy fallback `19`) plus `DWMWA_CAPTION_COLOR` (35),
`DWMWA_TEXT_COLOR` (36) and `DWMWA_BORDER_COLOR` (34) from the CSS tokens
(originally `--bg-app` `#171D25`, `--text-hd` `#AAB7C4`, `--edge` `#262F3B`;
since Nocturne A1 2026-09-10: `#161826` / `#E4E7F5` / `#3F424D` = `--color-bg`,
neutral-200, neutral-800 — see [[nocturne-full-switch]]). The color
attributes are **Windows 11 22000+ only**; on Windows 10 they fail and the
caption degrades to plain dark mode — acceptable, not worked around.

**Rejected (for now): frameless window + custom in-page title strip.** The
user's stated aesthetic preference, and the fully integrated result — but it
means removing the caption via `WM_NCCALCSIZE` while preserving resize edges,
Aero Snap and double-click-maximize, plus a host↔page message bridge for drag
and min/max/close (WebView2 has no Electron `-webkit-app-region`). Traded away
for ~20 lines with no window-interaction risk. Still available as a later
upgrade if the separate bar grates; revisit alongside the Tauri shell.

## Notes

- Lands through `/dev-flow`; it reworks the launch chain, so it wants a
  design pass first. Not a quick edit. (The 2026-07-24 chrome follow-up was
  one file / ~20 lines and went direct, per the trivial-edit carve-out.)
- The `wsl-launcher` agent's full structural proof is in this session's log.
- Keep the token constants in `AiSessionManagerHost.cs` in sync with
  `web/src/styles/tokens.css` — nothing enforces it (no C# in the test suite).

Related: [[thin-windows-launcher]], [[lifecycle-bound-backend]],
[[auto-port-discovery]], [[localhost-security-model]]

## From the scope doc (moved 2026-09-23)

Verbatim wording of the `.claude/PROJECT-SCOPE.md` bullet before part O1 condensed it; the scope doc holds the current rule.

### Architecture (decided) — Windows-side launcher

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

## Dev instance isolated (2026-09-26)

User: "doe dit in dev en niet in deze versie van session manager". A clone
launch used to stage and run the host in the installed app's own
`%LOCALAPPDATA%\ai-session-manager\`: its host.log, its WebView2 profile,
and so its browser process. A dev-host crash could take the live app down,
and with it the Claude session running inside it.

Now a CLONE launch with a non-default `AI_SM_DATA_DIR` passes the one fixed
switch `--dev-instance`, and the host uses
`%LOCALAPPDATA%\ai-session-manager-dev\` for all four of those things. The
installed launcher never passes it.

Rejected alternatives:

- a free path through an env var: the host must not take a directory from
  the environment;
- counting any non-default data dir as dev, the installed app included: an
  installed app with a custom data dir would have silently lost its tab
  layout, and its `-dev` folder would outlive the uninstaller.
