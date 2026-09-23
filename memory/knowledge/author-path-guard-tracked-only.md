---
type: knowledge
created: 2026-09-16
updated: 2026-09-16
tags: [testing, ci, privacy, gotcha]
---
# The author-path guard sees tracked files only

`tests/repo/no-author-paths.test.ts` (the repo is public) refuses any tracked
file carrying the author's home path, Windows user or handle. It walks
`git ls-files`, so a NEW file that is still untracked passes the local suite
and fails on CI the moment it is committed. Bitten 2026-09-16 (A9b Phase 0,
`951ff90` → fixed in `f8ce641`): example paths spelled with the author's real home in a new
test file and a doc comment.

**How to apply:** developer briefs say it outright — example paths use the
placeholder `/home/you/...`; before the final suite run, `git add -N <new
file>` (intent-to-add) so the guard scans it. The orchestrator checks
`git grep sava -- <new files>` before every commit that adds files.
See the orchestrator's auto-memory note `project-state-next-steps` (outside the vault) for the CI-before-squash rule it joins.
