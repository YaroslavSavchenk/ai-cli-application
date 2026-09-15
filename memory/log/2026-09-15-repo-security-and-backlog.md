---
type: log
created: 2026-09-15
updated: 2026-09-15
tags: [security, ci, github, backlog, review]
---
# 2026-09-15 (night) — repo security tab, CI hardening, honest score

Same evening as the A10b land and the mascot merge (their own logs). After
the user's A10b verdict the session turned to the repository itself.

## What landed (main `bc0018e`…`694311b`)

- **CI red after the mascot merge, twice**: a test reading a design handoff
  at module load (handoffs live in `.git/info/exclude`, absent on the
  runner) → skip-guard like `nocturne-tokens.test.ts`; then a pre-existing
  race in `restart.test.ts` (`env > file` polled by `existsSync`) → atomic
  rename. Lesson: a locally green suite can be red on a runner that has no
  handoff folders — verify WIP branches in CI before squashing.
- **`workflow_dispatch` on verify.yml**: `gh workflow run verify.yml --ref
  <branch>`; first manual run green.
- **Security tab complete** (user: "ik wil ze alle 3"): `SECURITY.md` (the
  localhost threat model as scope), private vulnerability reporting ON,
  CodeQL (`codeql.yml`: javascript-typescript + actions without a build on
  ubuntu; **C# with a traced manual build on windows-latest** via
  `build-host.ps1` after the no-build scan reported 56 % resolved calls),
  Dependabot alerts + security updates ON (first alerts postcss/nanoid
  fixed by a lockfile bump). 12 CodeQL alerts, all in `tests/`, dismissed
  by the user as "used in tests". Pinned by `release-workflow.test.ts`
  (codeql.yml in `ALL`, job shape, one commit for all action uses).
- **Backlog grew four sections** from the user's questions: Claude Code
  CLI compatibility guard (version probe + in-app notice + runtime
  breakage detection); engineering-quality debt (file splits, text pins,
  byte guard, mock removal, second-machine smoke); for-other-users gaps
  (signing (user), worktree/diff flow (user), contributor surface, public
  README, portability checks, first run); optimisation round AFTER
  feature-complete (replay, editor persistence, bundle 660 kB, polling →
  push, log volume, render path, startup, suite time, memory).

## Assessments given (orchestrator's, on request)

Critical score: 8/10 for the author's own use, 5/10 for other users, 7/10
engineering, 6.5 overall; ~8.5 against the average AI-built project.
Competitive field (Sept 2026): Claude Code's own Agent View + desktop
multi-session, Conductor (Mac), Claude Squad (TUI), Vibe Kanban, Wave
Terminal (closest architecture); Crystal deprecated → Nimbalyst. Gap this
app fills: Windows/WSL + real PTY panes for any CLI + sessions that outlive
the window; gap it lacks: worktree-per-task and a diff/PR flow. Takedown
risk judged low (official CLI as a subprocess, documented flags); the
pixel-art Claude mascot is the one trademark-adjacent element (noted, not
acted on).

Related: [[2026-09-15-nocturne-a10b]], [[2026-09-15-peek-mascot-phase1]],
[[localhost-security-model]], [[2026-09-08-cicd-gate]]
