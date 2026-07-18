---
type: decision
created: 2026-07-18
updated: 2026-07-18
tags: [launcher, windows]
---
# Thin Windows launcher

**Status:** decided (2026-07-18)

Launch flow: health-check `http://localhost:<port>/health` → if silent, start
the backend detached via `wsl.exe -d Ubuntu -- ...` → poll health until up →
open the UI. MVP launcher is a script + Edge `--app=<url>` chromeless window
(pin-to-taskbar makes it feel native, zero framework). A **Tauri** shell is
the planned upgrade when we want a real icon, tray, and native folder picker.

**Why:** the backend and UI already live in WSL ([[web-app-inside-wsl]]);
the Windows side only needs to bootstrap and display. Keeping it a dumb
bootstrapper means all logic stays testable inside WSL, and the health-check
gives single-instance behavior for free.

Known friction: cold WSL boot adds seconds — the launcher must wait
gracefully (splash/spinner), not error out. See [[wsl-interop]].

## Rejected alternatives

- **Electron** — heavyweight for what is a bootstrap + webview job.
- **Plain browser tab** — works but feels like a website; `--app` window is
  the same effort with a far better feel.

Related: [[detached-backend]]
