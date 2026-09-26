---
type: decision
created: 2026-09-26
updated: 2026-09-26
tags: [nocturne, mascot, session-state, subagents, workflows, transcript]
---
# C2: one session verdict — Working while background work runs, Waiting when Claude asks

**Status:** decided 2026-09-26 (user; each time the recommended option, asked
before the developer started).

User: "de mascotte verschijnt wanneer main sessie niks doet, maar wel
subagents hebt. Dat is niet de bedoeling. het detectie moet ook op
subagents werken, workflows en questions dat claude kan stellen" — and
"maar ook niet alleen mascotte, maar ook dat bolletje dat zelf waiting for
you".

- **Questions:** `AskUserQuestion` AND plan approval (`ExitPlanMode`) bring
  the mascot.
- **A question's mascot leaves when it is answered** (same as a finished
  turn since C1 decision 14 changed), not when the pane is looked at.
- **One rule everywhere:** `SessionInfo.turn` itself changes, so the pane
  dot/pill, the drawer row, the tab dot, `N waiting for you`, the Sessions
  badge (one helper, `web/src/ui/session-state.ts`) and the mascot
  (`turnEnded`) always agree.

**How it is read (all from Claude Code's own transcript, measured
2026-09-26):**

- A background launch = an `Agent`/`Task`/`Workflow` `tool_use` whose
  `tool_result` starts `Async agent launched` / `Workflow launched in
  background`, or a `SendMessage` whose result says `Resuming agent`.
- It closes when a `<task-notification>` (or a `queued_command` attachment
  carrying one) names its `tool_use` id.
- Alive = launched less than 15 min ago, OR its B7 row runs (or finished
  less than 10 s ago), OR its `subagents/workflows/<runId>/agent-*.jsonl`
  files are fresh.
- Background shells never count. The permission prompt stays BEL-only.

**Rejected alternatives:**

- **File activity alone** (B7's running rows plus a workflows-dir scan, no
  launch tracking): it cannot tell "the main session waits for this" from
  "something ran", and it flashes between workflow phases. Kept only as the
  liveness fallback.
- **Launch/notification alone:** a launch that never reports back (a killed
  process, a resumed session's old tail — measured: 5 of 1128 launches on
  this machine) would hold Working forever.
- **Mascot-only rule** (leave the pane readout as B11 had it): rejected by
  the user. Two surfaces disagreeing was the complaint.
- **Hooks** for question/permission events: rejected as in B7/B11 (the app
  reads Claude Code's files, it installs nothing into it).

Spec `.claude/plans/nocturne/PLAN-C2.md`. Supersedes the B11 line "an
orchestrating session that ended its turn while its background agents run
reads waiting" ([[b11-session-turn-readout]]). Related: [[c1-peek-mascot]],
[[b7-background-agents-source]].
