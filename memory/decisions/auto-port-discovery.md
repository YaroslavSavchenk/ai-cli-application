---
type: decision
created: 2026-07-18
updated: 2026-07-18
tags: [architecture, launcher]
---
# Auto-picked port with a discovery file

**Status:** decided (2026-07-18, user's call)

The backend binds `127.0.0.1:0` — the OS assigns a free port — and publishes
a runtime discovery file `~/.ai-session-manager/runtime.json` containing
`{ port, token, pid, startedAt }`, user-only readable (0600). Everything
that needs the backend (the [[thin-windows-launcher]] via `wsl.exe cat`,
tests, tooling) resolves the port through this file; nothing hardcodes one.

**Why:** zero port-conflict risk, ever. And the discovery file earns its
keep twice — it's also the natural home for the auth token that
[[localhost-security-model]] already requires, so launcher bootstrap and
security bootstrap become one mechanism. Stale-file handling (dead pid or
failed health check → start fresh) doubles as the single-instance check.

## Rejected alternatives

- **Fixed port 3777 with env override** — simpler launcher, and was the
  recommended option; the user chose auto-pick for guaranteed
  conflict-freedom. The extra launcher complexity is contained in one
  read-discovery-file step.

Related: [[detached-backend]], [[wsl-interop]]
