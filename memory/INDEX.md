# Memory Index

Map of content for the project memory vault. One line per note, newest-first
within sections. Update this file every time a note is added, renamed, or
superseded. Conventions live in `.claude/skills/memory/SKILL.md`.

## Decisions

- [[lifecycle-bound-backend]] — sessions die with the app (presence WS + grace timer); crash-safe session journal with relaunch
- [[auto-port-discovery]] — backend auto-picks its port; runtime.json discovery file carries port + auth token
- [[vanilla-ts-vite-frontend]] — no UI framework; vanilla TS + Vite around imperative xterm.js
- [[web-app-inside-wsl]] — why the app is a web app served from WSL, not a Windows-native Electron app
- [[detached-backend]] — partially superseded by [[lifecycle-bound-backend]]: setsid detachment from the launcher stands; window-close survival (and the systemd user service plan) reversed
- [[thin-windows-launcher]] — health-check → start via wsl.exe → Edge --app window; Tauri is the upgrade path
- [[agent-team-and-dev-flow]] — the subagent roster, strict lanes, and the develop→review→fix loop
- [[anti-slop-design-direction]] — terminal-derived visual identity; hard reject list for generic AI aesthetics

## Knowledge

- [[pty-requirements]] — why every session needs a real PTY and what breaks without resize propagation
- [[wsl-interop]] — localhost forwarding, calling Windows binaries from WSL, cold-boot delay
- [[localhost-security-model]] — the drive-by-web-page threat; token auth, Origin/Host checks, argv spawning
- [[frontend-terminal-quirks]] — AltGr vs Ctrl+Alt chords, xterm detached-mount trap, attention poll latency, token rotation

## Log

- [[2026-07-19-lifecycle-and-pivots]] — lifecycle reversal implemented; steam-blend direction chosen; caveman + model-assignment process changes
- [[2026-07-18-mvp-build]] — backend + frontend + launcher landed via dev-flow workflows; backlog and manual-pass list
- [[2026-07-18-project-setup]] — scope agreed, agent team + dev-flow built, memory vault created
