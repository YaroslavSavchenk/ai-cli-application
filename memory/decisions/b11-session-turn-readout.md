---
type: decision
created: 2026-09-22
updated: 2026-09-22
tags: [nocturne, session-state, transcripts, background-agents]
---
# Session state Working vs. Waiting for you, the agents-table switch, the many-agents rule (part B11)

**Status:** decided 2026-09-22 (user, on the B7 Windows check); the
many-agents reading confirmed by the user at the start of B11 ("Klopt,
begin B11"); implemented the same day.

Context: a PTY does not say whether the program is generating or idle, so
every live session read "Working" — also a Claude session that had ended
its turn. And with B7 live the agents stood twice on screen: Claude Code's
own inline task list and the app's table.

Decided (user):
- **Words and colours:** Working = green pulsing; Waiting for you = amber
  still; Needs your answer (BEL) = amber pulsing, unchanged; Finished = grey.
  ~~The statusline's `N waiting for you` counts waiting sessions too.~~
  Reverted the same evening on the Windows check (user: "dat daaronder mag
  weg"; chose "terug naar alleen BEL"): the statusline and the Sessions
  badge count BELs only; Waiting for you shows on the pane, drawer row and
  tab dot.
- **Source:** the session's own Claude transcript (the B7 boundary, one
  more file) — the last line that counts decides.
- **The agents table behind a switch**, Settings → Status bar, default OFF:
  Claude Code's own list cannot be hidden without `disableAgentView`, which
  kills background agents.
- **Many agents:** at most 4 running rows (oldest first) + `+N working`; one
  finished row (the latest) only when fewer than 4 run; the rest `+N
  finished`; totals on the wire.
- **Order:** before B8, ships in v0.4.0.

Orchestrator defaults (flippable): pulse only where the turn is KNOWN (a
shell keeps still green Working); the tab dot follows, the tab's `Needs
you` pill stays BEL-only; the Sessions badge counts like the statusline;
waiting never notifies (attention stays BEL-only). Known limit: the
permission prompt writes nothing to the transcript → Working unless BEL.

Spec: `.claude/plans/nocturne/PLAN-B11.md`. Related:
[[b7-background-agents-source]], [[pane-status-bar-data-source]].
