---
type: decision
created: 2026-07-18
updated: 2026-07-18
tags: [process, agents]
---
# Agent team and the dev-flow loop

**Status:** decided (2026-07-18)

Development runs through the loop in `.claude/skills/dev-flow/SKILL.md`:
brief → developer implements → reviewers gate in parallel → fixer resolves
findings → re-review → (max 3 cycles) → final gate → report. The user asked
for exactly this shape ("developer, then reviewer, then fixer, then reviewer
etc.") on 2026-07-18.

Roster: developers `backend-pty`, `terminal-ui`, `wsl-launcher`,
`generalist-dev`; reviewers `scope-reviewer` (always), `security-auditor`
(conditional), `test-engineer` (suite gate); plus `fixer` and `janitor`.
Skills as quality gates: `frontend-designer`, `verify-terminal`.

**Why the lanes are strict** (reviewers never fix, fixer never adds features,
janitor never refactors): re-review is only meaningful if reviewers didn't
write the fix; the fixer is only auditable if its diff maps 1:1 to findings.
**Why max 3 fix cycles:** unresolved findings after 3 rounds mean a genuine
disagreement or a missing decision — that goes to the user, not into an
infinite loop.

Supporting principles baked into the files:

- Every agent's first instruction: read `.claude/PROJECT-SCOPE.md` — one file
  re-educates the whole team when scope changes.
- Agents get scope facts *restated only where their work hinges on them*;
  the scope doc stays the single source of truth.
- Deliberately lean roster — unused helper agents are meta-slop.

Related: [[anti-slop-design-direction]], [[localhost-security-model]]
