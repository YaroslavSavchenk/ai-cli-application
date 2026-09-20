---
type: log
created: 2026-07-18
updated: 2026-07-18
tags: [milestone]
---
# 2026-07-18 — Project setup

First working day. No application code yet — scope, team, and memory
infrastructure were built.

What happened:

- Product idea discussed and scoped: GUI manager for multiple AI CLI
  sessions (Claude Code first), projects, launch presets, 1–4 pane grid
  layouts per tab, WSL-first. Captured in `.claude/PROJECT-SCOPE.md`.
- Architecture decided: [[web-app-inside-wsl]], [[detached-backend]],
  [[thin-windows-launcher]].
- Meta-skills created: `/create-skill`, `/create-agent` (both scope-aware).
- Quality skills created: `/frontend-designer` (per
  [[anti-slop-design-direction]]) and `/verify-terminal`.
- Agent team + process built per [[agent-team-and-dev-flow]]:
  4 developers, 3 reviewers, fixer, janitor; loop codified in `/dev-flow`.
- Memory vault (this one) created; conventions in
  `.claude/skills/memory/SKILL.md`; `/dev-flow` now recalls from and writes
  back to memory.

Later the same day: environment verified ready (Node 24.14, npm 11.9,
native build toolchain for node-pty, claude CLI 2.1.214), `CLAUDE.md`
created, everything committed (repo-local git identity configured). The two
blocking decisions were settled by the user: [[auto-port-discovery]] and
[[vanilla-ts-vite-frontend]]. Remaining open decision: projects.json
location/schema details.

Next: implementation plan, then MVP build through `/dev-flow`.
