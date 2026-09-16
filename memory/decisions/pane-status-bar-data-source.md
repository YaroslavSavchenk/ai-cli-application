---
type: decision
created: 2026-09-16
updated: 2026-09-16
tags: [nocturne, status-bar, statusline, telemetry]
---
# Pane status bar data source (open decision 2, part B1)

**Status:** decided 2026-09-16 (user; the orchestrator's advice)

Context: Nocturne part B1 (`.claude/PLAN-NOCTURNE.md`) renders a configurable
status bar under each terminal with Model, Permission mode, Git branch, Cost,
Context, Account usage, Active skill, Session time, Lines changed. Since A3
the pane bar states only what the app knows from argv (Model, Mode, Time);
the rest was open decision 2. Asked 2026-09-16 when the user chose the next
part (they picked A9b first; B1 follows).

Decided: **reuse the payload Claude Code already hands
`server/statusline.mjs`** on every turn (model, cost, context %, account
usage %, lines changed, plus the branch the script probes). The script writes
a per-session snapshot into the app data dir the way it already caches the
branch (`statusline-cache.json`: 0600, wiped at boot, keyed so entries stay
bounded), the backend carries it in the session info, and the pane bar
renders the SAME checklist as Settings → Status bar. Active skill has no
source in that payload and is dropped honestly — no placeholder.

Known consequence, accepted: the same values then stand twice on screen
(Claude's own line inside the terminal, see [[2026-07-26-statusline-phase]],
and the pane bar under it) unless the user switches Claude's line off in the
checklist.

## Rejected alternatives
- **Claude Code hooks** per session (via the per-session settings file):
  more moving parts, and the payload already carries every value except
  Active skill. Reconsider for open decision 3 (files the session touches,
  B2), where the payload has nothing.
- **Keep only Claude's own status line, no app strip** (the 2026-07-25
  choice as-is): B1 would then be nothing but the checklist that already
  exists; the v3 design the user chose in full ([[nocturne-full-switch]])
  has the pane bar.
