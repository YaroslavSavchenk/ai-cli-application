# Memory Index

Map of content for the project memory vault. One line per note, newest-first
within sections. Update this file every time a note is added, renamed, or
superseded. Conventions live in `.claude/skills/memory/SKILL.md`.

## Decisions

- [[web-app-inside-wsl]] — why the app is a web app served from WSL, not a Windows-native Electron app
- [[detached-backend]] — backend outlives every window; setsid MVP, systemd user service later
- [[thin-windows-launcher]] — health-check → start via wsl.exe → Edge --app window; Tauri is the upgrade path
- [[agent-team-and-dev-flow]] — the subagent roster, strict lanes, and the develop→review→fix loop
- [[anti-slop-design-direction]] — terminal-derived visual identity; hard reject list for generic AI aesthetics

## Knowledge

- [[pty-requirements]] — why every session needs a real PTY and what breaks without resize propagation
- [[wsl-interop]] — localhost forwarding, calling Windows binaries from WSL, cold-boot delay
- [[localhost-security-model]] — the drive-by-web-page threat; token auth, Origin/Host checks, argv spawning

## Log

- [[2026-07-18-project-setup]] — scope agreed, agent team + dev-flow built, memory vault created
