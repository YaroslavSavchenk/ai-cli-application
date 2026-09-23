---
type: decision
created: 2026-07-19
updated: 2026-09-23
tags: [architecture, lifecycle]
---
# Lifecycle-bound backend — sessions die with the app

**Status:** decided (2026-07-19, user's call — supersedes the survival
promise in [[detached-backend]])

After a day of real use the user reversed the core lifetime decision: "when
I close the app the sessions must close on their own, so they don't run in
the background." No orphaned Claude sessions, no invisible resource use.

Mechanism (implemented 2026-07-19):

- The UI holds a **presence WebSocket** (control channel) to the backend;
  the backend counts connected windows.
- Last window gone → **grace timer (~30 s, tunable)** so F5 reloads and
  accidental closes reattach harmlessly → then the backend kills all PTYs,
  removes runtime.json, and **exits**. Nothing stays behind.
- The backend still *starts* detached from the launcher process (that part
  of [[detached-backend]] stands — it must not die with the launcher
  console); what changed is that its lifetime is now bound to UI presence
  instead of being indefinite.

Crash safety (same user message: "if the pc gets turned off, everything
isn't damaged"):

- All state files were already atomic-write; stale runtime.json after a
  hard cut is already handled by health-check-before-trust.
- NEW: a crash-safe **session journal** (atomic, in the data dir): entries
  for live sessions, marked closed on clean end. On next backend start,
  unclean entries surface in the UI as "previous sessions" with one-click
  relaunch — claude sessions respawn with `--continue`, so the conversation
  resumes (Claude Code persists its own history; nothing is lost but the
  scrollback pixels). **Superseded 2026-09-06 by
  [[session-history-resume]]**: the journal became a cumulative
  `history.json` with per-conversation `--resume`; the lifecycle part of
  this decision is unchanged.

Consequences:

- The systemd-user-service roadmap item is obsolete (no long-running
  backend to manage).
- Launcher README's "sessions survive window close" story must be rewritten.
- `-Stop` remains as manual override; `-Status` unchanged.

Rejected alternative: keeping survival as an opt-in "keep running in
background" toggle — deferred; may return later as a per-session pin, but
the default the user wants is strict no-background.

Related: [[wsl-interop]], [[auto-port-discovery]]

## From the scope doc (moved 2026-09-23)

Verbatim wording of the `.claude/PROJECT-SCOPE.md` bullet before part O1 condensed it; the scope doc holds the current rule.

### Architecture (decided) — Backend starts detached

- **Backend starts detached** from the launcher process (setsid), started on
  demand — it must never die with the launcher console. **Lifetime: bound to
  UI presence** (decided 2026-07-19, user's call, reversing the earlier
  indefinite-survival promise; rationale in
  `memory/decisions/lifecycle-bound-backend.md`): a presence WebSocket counts
  open windows; when the last closes, a grace timer (~30 s) lets reloads
  reattach harmlessly, then the backend ends all sessions, removes
  runtime.json, and exits. **Implemented 2026-07-19**:
  presence channel `/ws/presence`; grace 30 s (env `AI_SM_GRACE_MS`) plus a
  120 s startup grace until the first-ever presence (env
  `AI_SM_STARTUP_GRACE_MS`). The crash-safe journal that once backed a
  `--continue` relaunch (`journal.json` → `previous.json`, `/api/previous`)
  is **replaced 2026-09-06 by the session history** (next bullet).
  Manual `-Stop` remains as an override. Added 2026-07-19: the presence
  channel answers `ping`/`pong` (latency; inbound frames capped 1 KiB,
  zero lifecycle effect) and authed `GET /api/runtime` exposes
  `startedAt` (uptime) — both feeding the statusline. Added 2026-09-06:
  `GET /api/runtime` also returns `serverCommit` (short git hash of the
  running backend, or null) and `webBuild` (the `assets/index-*.js` it is
  serving, or null); the UI's boot log line prints both beside its own
  `__BUILD_ID__` so a stale backend is visible in the log. Added
  2026-09-08 (installer phase A): `version` (the bundle version, null in a
  developer clone) and `installed` (boolean) — the body is exactly
  `{ startedAt, serverCommit, version, installed, webBuild, update }`.
