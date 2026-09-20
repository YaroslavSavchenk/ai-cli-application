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

**Later same day — redesign SHIPPED** (e901cf8, 88c716e): sessions-as-tabs
+ drag-to-split (custom pointer DnD, keyboard equivalents for every drag,
localStorage v2 + v1 migration) and the steam-blend reskin (full token
rewrite, Barlow OFL bundled, DESIGN.md v2). 39/39 + 8/8 + 37/37 probe
checks. Drive-by fixes: replay no longer re-answers terminal queries from
scrollback; BEL-in-OSC no longer raises phantom attention (regression
test, 31/31). Intentional UX change confirmed: tab close ×  kills that
view's sessions (armed confirm) — consistent with no-background-sessions.
Backlog: MAX_VIEWS not enforced at runtime (pre-existing); tab-reorder
keyboard path is chord-only; .sess-here blue on non-interactive metadata.
Sonnet-writes/fable-reviews pilot proposed to user, awaiting answer.

Next: **Tauri shell** (last queued phase). User still needs one
`-Stop` + relaunch to activate lifecycle + new UI on the live backend.
