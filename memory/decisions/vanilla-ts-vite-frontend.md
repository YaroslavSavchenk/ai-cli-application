---
type: decision
created: 2026-07-18
updated: 2026-07-18
tags: [frontend, tooling]
---
# Frontend: vanilla TypeScript + Vite, no UI framework

**Status:** decided (2026-07-18, user's call)

The browser frontend is plain TypeScript built with Vite. No React, no
Svelte, no component framework. State management is a small hand-rolled
store; DOM work is direct.

**Why:** xterm.js is imperative — it mounts into a DOM node and owns it, so
a declarative framework adds an impedance mismatch exactly where this app
does most of its work. UI state is modest (tabs, layouts, project list,
badges), and zero framework churn fits the terminal-power-tool ethos of
[[anti-slop-design-direction]]. Smallest bundle, fastest startup, everything
in our control.

Consequence for agents: `terminal-ui` must not introduce a UI framework or
heavy dependency — genuine needs get flagged in reports, not added.

## Rejected alternatives

- **React + Vite** — familiar, huge ecosystem; rejected for the
  imperative/declarative friction around xterm mounts and unneeded weight.
- **Svelte + Vite** — compiles away nicely; rejected to avoid adding a
  toolchain/idiom the whole agent team must stay consistent with.

Related: [[pty-requirements]], [[agent-team-and-dev-flow]]
