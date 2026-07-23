---
type: decision
created: 2026-07-23
updated: 2026-07-23
tags: [launcher, windows, webview2, native-host, icon]
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
   (`Anthropic.AiSessionManager`) can never match it. A dedicated
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
- Calls `SetCurrentProcessExplicitAppUserModelID("Anthropic.AiSessionManager")`
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
- **Secure:** loads only `127.0.0.1:<port>`; navigation locked to that
  origin; no devtools; no new stored secret (auth token flows via the URL
  the launcher already builds); no new network surface. As locked-down or
  more than today's Edge `--app` window.
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

## Notes

- Lands through `/dev-flow`; it reworks the launch chain, so it wants a
  design pass first. Not a quick edit.
- The `wsl-launcher` agent's full structural proof is in this session's log.

Related: [[thin-windows-launcher]], [[lifecycle-bound-backend]],
[[auto-port-discovery]], [[localhost-security-model]]
