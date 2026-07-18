---
type: decision
created: 2026-07-18
updated: 2026-07-18
tags: [architecture]
---
# Web app running inside WSL

**Status:** decided (2026-07-18)

The app is a web application: a Node.js backend running inside WSL2 Ubuntu
(node-pty + WebSocket + HTTP) serving an xterm.js frontend to a browser on
Windows. WSL2's localhost forwarding carries the traffic. See
[[thin-windows-launcher]] for how it starts and [[detached-backend]] for its
lifetime.

**Why:** every project and every CLI (claude, etc.) lives inside WSL — running
the backend there means no Windows↔WSL path translation, no interop layer in
the hot path, and `claude` is spawned directly. Fastest path to working
software; upgrades cleanly to a native shell later.

## Rejected alternatives

- **Windows Electron/Tauri app spawning `wsl.exe` per session** — works (ConPTY
  passes TUIs through), but drags every session through interop and forces
  `wslpath` translation everywhere the UI touches files. Kept as a possible
  future *shell* around the web app, not as the architecture.
- **Pure terminal solution (tmux)** — already exists, but fails the actual
  product goals: GUI project launcher, mode presets, per-tab grid layouts.

Related: [[pty-requirements]], [[localhost-security-model]]
