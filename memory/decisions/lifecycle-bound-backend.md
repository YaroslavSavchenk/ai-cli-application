---
type: decision
created: 2026-07-19
updated: 2026-07-19
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
  scrollback pixels).

Consequences:

- The systemd-user-service roadmap item is obsolete (no long-running
  backend to manage).
- Launcher README's "sessions survive window close" story must be rewritten.
- `-Stop` remains as manual override; `-Status` unchanged.

Rejected alternative: keeping survival as an opt-in "keep running in
background" toggle — deferred; may return later as a per-session pin, but
the default the user wants is strict no-background.

Related: [[wsl-interop]], [[auto-port-discovery]]
