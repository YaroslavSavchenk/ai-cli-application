---
type: log
created: 2026-07-19
updated: 2026-07-19
tags: [milestone]
---
# 2026-07-19 — Lifecycle reversal implemented; design + process pivots

Landed (commits 8e0ef2a → 60036b3 on origin/main):

- **GUI polish + silent launcher** (8e0ef2a) — dividers, session move/swap,
  relaunch, reload panel; launch-silent.vbs + Desktop/Start-Menu shortcuts
  with generated icon; Ubuntu-24.04 baked default.
- **First real user bug** (804c003, previous day's session): xterm z-index
  escape made the launcher unclickable — see [[frontend-terminal-quirks]].
- **Steam mockups** → user chose "mix of both" → **steam blend** direction
  recorded in [[anti-slop-design-direction]]; sessions-as-tabs +
  drag-to-split model decided, NOT yet implemented.
- **Lifecycle phase** (60036b3) — [[lifecycle-bound-backend]] implemented:
  presence WS, grace timers (30 s / 120 s startup), journal.json →
  previous.json rotation with crash stamping, /api/previous relaunch
  offers, frontend presence client + previous-run drawer. 35/35 e2e
  checks, 30/30 tests. Claude continuity rule refined in code:
  RESUME_FLAGS = ['--continue','-c','--resume','-r'] (aliases count;
  literal spec would double the flag).
- **Process changes**: caveman compression mode standing (skill +
  CLAUDE.md + all agent contracts); model assignment — sonnet pinned on
  scope-reviewer/test-engineer/janitor/generalist-dev, session model kept
  for developers/security-auditor/fixer.

Pattern worth remembering: THREE session-limit interruptions this phase;
each time the dying fixer had already applied most/all of its edits —
always VERIFY findings against the tree before re-running a fixer
(grep the claimed defect; it may be fixed).

Deployment note: the user's live backend still runs pre-lifecycle code;
next `-Stop` + relaunch activates sessions-die-with-app behavior.

Backlog added this phase: previous.json rotation drops un-dismissed offers
from run N-2; relaunch tooltip wording when entry already carries a resume
flag; .sess-row.is-prev hover cue on non-interactive rows.

Next: **steam-blend redesign phase** (sessions-as-tabs, drag-to-split),
then Tauri shell.
