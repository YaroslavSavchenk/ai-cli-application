---
type: log
created: 2026-07-19
updated: 2026-07-19
tags: [milestone, design]
---
# 2026-07-19 (late) — Design handoff triage; statusline backend landed

User dropped a hi-fi design handoff into `design/` (spec + working HTML
prototype + prompt) made in an external tool after using the phase-5 app.
Full feature audit of `web/src` against it → `design/GAP-ANALYSIS.md` is
the canonical plan; PROJECT-SCOPE gained two open decisions (bottom tab
strip vs topbar; modal launcher vs in-tab). Precedence rule from the user's
prompt applied throughout: repo's DESIGN.md/tokens win on look, handoff
supplies missing features.

**Landed (R1, dev-flow, all reviewers clean, zero findings):** presence-WS
`ping`/`pong` (latency; dedicated presenceWss, maxPayload 1024 → 1009
close, provably zero lifecycle coupling) + authed `GET /api/runtime` →
`{startedAt}` (uptime). 35/35 tests. Queued for next session: R2 (theme
system + chrome/statusline richness), R3 (launcher upgrade + honest boot
steps) — briefs sketched in the gap analysis.

Non-obvious lessons (the reason the gap analysis exists):

- **Prototype features can be fictions of the real architecture.** Three
  handoff features died on inspection, not implementation: the grace
  countdown (any window able to show it holds the presence socket that
  prevents it — [[lifecycle-bound-backend]]), the boot overlay's
  backend-start steps (launcher opens the browser only after health), and
  per-session `--resume <id>` (journal stores our ids, not Claude
  conversation ids). Check every designed feature against the lifecycle
  model before briefing a developer.
- **Pane model/permission tags need zero backend**: derivable from
  `SessionInfo.args` — resist adding protocol fields for display data.

Backlog added: session-WS `maxPayload` still ws-default 100 MiB
(authed-only exposure, security note, not urgent).

Related: [[anti-slop-design-direction]], [[2026-07-19-lifecycle-and-pivots]]
