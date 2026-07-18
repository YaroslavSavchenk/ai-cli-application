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
- **Process lifetime — verified the hard way (2026-07-18, kernel
  6.6.87.2)**: the textbook `setsid nohup cmd &` pattern DIES ~3s after the
  spawning `wsl.exe` exits — backgrounded jobs are reaped with the interop
  session. What survives: FOREGROUND `setsid --fork nohup cmd` (bash waits
  for the intermediate parent, so the daemon is reparented into its own
  session before wsl.exe exits). Proven across repeated launches; the
  daemon ends up session leader under `/init` ([[detached-backend]],
  implemented in launcher/start-backend.sh).
- **nvm node is invisible to `wsl.exe`-spawned login shells**: they resolve
  `/usr/bin/node` (v18 here) because the bashrc interactive guard precedes
  nvm init. Any script run via `wsl.exe -- bash -lc` must source
  `$NVM_DIR/nvm.sh` explicitly and enforce the required version.
- **Edge on this machine uses the new EdgeCore layout**
  (`C:\Program Files (x86)\Microsoft\EdgeCore\<ver>\msedge.exe`); the
  classic `Edge\Application` path holds no real binary. Launchers must
  probe both. Also: a pinned Edge `--app` tile bakes in the port — with
  auto-picked ports it goes stale after a backend restart; pin the launcher
  shortcut instead.
- **The distro here is `Ubuntu-24.04`, not `Ubuntu`** — never hardcode a
  distro name; the launcher does unique-prefix auto-resolution with a
  guided error listing installed distros.
- **Dev environment**: repo at `/home/sava/projects/ai-cli-application`;
  Obsidian/Explorer reach it via `\\wsl$\Ubuntu\...`.

Related: [[thin-windows-launcher]], [[web-app-inside-wsl]]
