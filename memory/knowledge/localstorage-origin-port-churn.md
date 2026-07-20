---
type: knowledge
created: 2026-07-20
updated: 2026-07-20
tags: [frontend, architecture, persistence]
---
# localStorage does not survive backend restarts (auto-port = origin churn)

Found 2026-07-20 from a user bug report: "the theme resets every time I
close the app and reopen it."

- The backend binds an **OS-assigned port every run** (decided architecture,
  [[auto-port-discovery]]); `runtime.json` is removed on exit.
- localStorage is **per-origin**, and the origin is `127.0.0.1:<port>` — so
  every backend restart lands the UI on a fresh origin with empty storage.
- Consequence: ALL client-side persistence is per-backend-run only. Affected
  keys: `ai-sm:theme:v1` (visible symptom — theme resets) and `ai-sm:ui:v2`
  (layout — mostly moot, sessions die with the backend per
  [[lifecycle-bound-backend]] anyway).
- Reopening while the backend is still alive (grace window / other window
  open) keeps the port → same origin → storage intact. That is why the
  symptom is "resets when I close the app", not "resets on reload".

**Rule going forward:** anything that must survive a backend restart
belongs server-side in `~/.ai-session-manager/` (the prefs.json /
`/api/prefs` substrate), never in localStorage. localStorage is a same-run
cache at best. This is also the substrate the settings panel needs.

**Fix implemented same day** (see [[2026-07-20-theme-persistence-launcher]]):
`prefs.json` + authed `GET/PUT /api/prefs`, theme as first consumer;
persistence proven live across a port/token change with no default flash.

Related: [[auto-port-discovery]], [[lifecycle-bound-backend]],
[[frontend-terminal-quirks]]
