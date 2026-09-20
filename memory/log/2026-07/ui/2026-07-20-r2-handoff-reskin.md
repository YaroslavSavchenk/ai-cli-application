---
type: log
created: 2026-07-20
updated: 2026-07-20
tags: [milestone, design, frontend]
---
# 2026-07-20 — R2: full reskin to the handoff design

Session opened on the queued R2 work. Before any code, the user settled all
three direction questions — and mid-flight added one scope item.

**Decisions (start of session, recorded in [[handoff-design-primary]]):**
bottom tab strip and modal launch dialog (both AGAINST the on-file
recommendations), then the big one mid-turn: "Follow the design from that
handoff design. Thats the main now" — precedence flipped, the handoff became
the primary design source and `web/DESIGN.md` was rewritten to transcribe
it. GAP-ANALYSIS revised; the old "Skipped — repo wins" list superseded.
Fiction cuts and the no-new-deps rule survived the flip.

**Landed (R2, dev-flow, terminal-ui developer):** tokens.css remapped to the
handoff palette; Barlow 500/700 + JetBrains Mono 400/500/700 bundled (OFL);
shell restructured (44px gradient topbar / 272·296px drawers / bottom
Steam-style tab strip / 23px statusline); theme system — 10 terminal
backgrounds × 10 text ramps through `--xt-*`, live repaint, scanline toggle,
`ai-sm:theme:v1`; statusline `ws ms · sessions·panes · awaiting · up · pty
ok`; pane model/permission tags from args; drawer upgrades; centered empty
state (zero views now legal — no launcher-tab resurrection; schema stayed
v2).

**Flow stats:** 1 review round — scope-reviewer found exactly one minor
(DESIGN.md deviations list omitted the statusline `?` button move; fixed
inline by orchestrator, reviewer-prescribed one-liner). test-engineer wrote
33 tests (util arg-parsing/uptime, state zero-views + migration, presence
ping RTT) → suite 35→68, all green. verify-terminal: 9/9 PASS on the
current tree — including a real `claude` TUI launch via the UI (draw, keys,
clean exit; prompt submission and permission-prompt interaction deferred to
the user's manual pass, zero API tokens). Janitor: removed dead `fmtAge`,
flagged pre-existing dead `--z-overlay` token, confirmed the `(R3)` tokens
in tokens.css are intentional forward declarations.

**Queued next:**
- R3 — modal launch dialog (settled shape) + honest boot steps, per
  `design/GAP-ANALYSIS.md`.
- **App settings panel — user-gated, do NOT build until explicit go**
  (recorded in PROJECT-SCOPE Features): persistent settings (usage limit,
  model, more TBD) applying to future sessions. Clarify shape with the user
  first. test-engineer flag relevant then: `state.ts` `subscribe()` has no
  unsubscribe — a settings panel with dynamic subviews will need one.

Related: [[handoff-design-primary]], [[2026-07-19-design-handoff-and-r1]],
[[anti-slop-design-direction]], [[frontend-terminal-quirks]]
