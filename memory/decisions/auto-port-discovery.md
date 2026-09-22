---
type: decision
created: 2026-07-18
updated: 2026-09-22
tags: [architecture, launcher]
---
# Auto-picked port with a discovery file

**Status:** decided (2026-07-18, user's call); **amended 2026-09-22** (user's call, Nocturne B6 decision 5, [[b6-settings-live]]): the backend now REMEMBERS the port it bound in `<dataDir>/last-port.json` and tries it first on every start — precedence `AI_SM_PORT_HINT` (a restart handoff) > the file > auto-pick; a busy remembered port falls back to an OS-assigned one for that run and is NOT overwritten (a transient squatter must not move the origin for good). Auto-pick is the fallback, not the rule. Why: the tab layout lives in localStorage, keyed by origin including the port ([[localstorage-origin-port-churn]]), so a new port per start threw it away and made `Reopen tabs on start` inert. Everything below is the original decision as recorded.

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
