---
type: knowledge
created: 2026-07-18
updated: 2026-07-18
tags: [wsl, windows]
---
# WSL ↔ Windows interop facts

Facts this project's Windows integration relies on:

- **Localhost forwarding**: a server bound to `127.0.0.1` inside WSL2 is
  reachable from Windows at `http://localhost:<port>`. No need to bind
  `0.0.0.0` — and binding it would be a security hole
  ([[localhost-security-model]]).
- **Windows binaries are callable from inside WSL**: `wsl.exe`,
  `powershell.exe`, `cmd.exe` all work via interop; `wslpath` translates
  paths both directions. This is how agents test launcher logic without
  leaving WSL (see the `wsl-launcher` agent).
- **What can't be verified from WSL**: anything visual or login-session-bound
  on Windows (the Edge `--app` window appearing, taskbar pinning, Startup
  entries). These always end up as a manual checklist for the user.
- **Cold boot**: if the WSL VM is down, the first `wsl.exe` call pays a
  multi-second startup cost — launcher must show progress, not time out.
- **Process lifetime**: a process started via `wsl.exe` dies when that
  `wsl.exe` parent is killed — detachment (`setsid`/systemd) inside WSL is
  what breaks the chain ([[detached-backend]]). WSL supports systemd user
  services on current versions.
- **Dev environment**: repo at `/home/sava/projects/ai-cli-application`;
  Obsidian/Explorer reach it via `\\wsl$\Ubuntu\...`.

Related: [[thin-windows-launcher]], [[web-app-inside-wsl]]
