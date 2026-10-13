---
type: decision
created: 2026-10-13
updated: 2026-10-13
tags: [nocturne, d6, d5, claude-code, compatibility, permissions]
---
# D6 — Claude Code compatibility guard (and the D5 permission flag)

**Status:** decided 2026-10-13 (user). Spec: `.claude/plans/nocturne/PLAN-D6.md`.

The user's ask, 2026-09-15: Anthropic changing a flag or behaviour that the
app relies on must be VISIBLE in the app, not buried in `server.log`.

Decided by the user, 2026-10-13:
1. **The out-of-range notice offers the app's own Check for updates only**,
   with no link to the GitHub releases page (decision 18).
2. **It can be hidden until a different Claude Code version is seen**, and
   the hiding survives a restart (decision 19). A dead launch is new
   evidence and brings it back. A replay of an old dead pane after a page
   reload is NOT new evidence: only a session created after the page loaded
   counts, and each session counts once.
3. **"Always ask" passes `--permission-mode manual`** (decision 17, amended).
   `manual` is the name Claude Code documents (2.1.287's list:
   `acceptEdits / auto / bypassPermissions / manual / dontAsk / plan`), and
   it is accepted since 2.1.200, below our 2.1.263 floor. The hidden
   `default` still works, but it could be dropped without notice.

Orchestrator defaults, within those decisions:
- One home for the range: `CLAUDE_SUPPORTED` in `shared/claude-compat.ts`.
  `testedUpTo` is exact, so a newer PATCH counts as newer.
- The probe runs once after listen and never delays boot. It probes again
  when the binary changes, at most once a minute.
- The newest release-notes draft must say `Verified with Claude Code <testedUpTo>.`
  (`tests/release/claude-tested-version.test.ts`).
- On a developer clone the notice hides Check for updates, the same rule
  as Settings.
- The early-exit line, capped and with escapes, controls and bidi
  characters stripped, is the one place PTY output reaches `server.log`
  (one WARN line). `.claude/PROJECT-SCOPE.md` names that exception.

**Why:** a version number alone proves nothing, so the early-exit flag is
the runtime evidence. And the notice never blocks launching; the user
decides. Related: [[session-history-resume]] (the floor),
[[no-code-in-ui-copy]] (the banner line is an exempt kind of terminal
content).
