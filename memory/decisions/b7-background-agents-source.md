---
type: decision
created: 2026-09-22
updated: 2026-09-22
tags: [nocturne, background-agents, transcripts, telemetry]
---
# Background agents table data source (part B7)

**Status:** decided 2026-09-22 (user; the orchestrator's advice)

Context: the v3 pane has a "Background agents" table (name, task, time,
tokens) under the status bar; A3 built it and shipped it empty because
nothing in the app knew about subagents. The B7 row carried the open
decision since 2026-09-10. Asked 2026-09-22 when the user said "continue
werken aan dit app" and B7 was the next row.

Decided: **Claude Code's own transcripts.** Per session Claude Code writes
`~/.claude/projects/<slug>/<session-id>/subagents/agent-<hex>.meta.json`
(agent type, task description, model) and `agent-<hex>.jsonl` (one line per
event with a timestamp; assistant lines carry `message.id`, `stop_reason`
and `usage`). The status-line payload the app already receives
([[pane-status-bar-data-source]]) carries `transcript_path`, so the script
adds it to the B1 snapshot and the backend derives the subagents directory
from it — no configuration on the user's side, and the app's own session id
is never used (a resumed conversation's Claude id is the old one).

Shape (orchestrator defaults, spec `.claude/plans/nocturne/PLAN-B7.md`):
the transcript path is untrusted and refused unless absolute, normalised,
`<uuid>.jsonl`, and realpath-inside `~/.claude/projects`; a 2 s poll per
tracked session (the directory does not exist before the first subagent, so
`fs.watch` cannot start there); incremental bounded reads with an offset;
tokens = the billed total across unique `message.id`s (input + cache
creation + cache read + output — the figure Claude Code itself reports;
output-only is the flip); finished = last user/assistant line is an
assistant `end_turn`, or no growth for 15 min (a killed agent leaves no end
marker); the wire list capped at 8 rows / 3 finished, running first; the
table never rendered empty; the B9 colour constraint (themed ink and
hairlines) lands in the same part.

## Rejected alternatives
- **Claude Code hooks** (`SubagentStart` / `SubagentStop` in the user's
  `~/.claude/settings.json`): the payload carries no tokens, and it is a
  second mechanism to install and keep alive — the same reason decision 2
  rejected hooks.
- **Dropping the part** (an honest empty table, as the plan allowed): the
  data exists on disk today; only the finding was missing.
