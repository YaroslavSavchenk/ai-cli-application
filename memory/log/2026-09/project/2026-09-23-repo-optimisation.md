---
type: log
created: 2026-09-23
updated: 2026-09-23
tags: [repo, layout, tests, optimisation]
---
# 2026-09-23 — repo optimisation: tests into folders, then the code itself

The user put "herstructureren van het filesysteem" on the day's list and
widened it: optimise the codebase — duplicates, unused code, long files
split — "bij tests wil ik dit vooral toepassen", with written rules for how a
test is written. Four questions asked up front, all answered with the
recommendation: tests first, then source · test > 800 / source > 1 000 lines
is split · pieces stay flat with a prefix · rules in `tests/README.md`.
Decision and move map: [[repo-layout]]; plan rows O4–O8 in
`.claude/plans/PLAN-RESTRUCTURE.md`.

## Batch 4 — `tests/` into subfolders

160 × `git mv` into `ui/ server/ release/ repo/ helpers/`, `fixtures/`
stays. Baseline and result: 3710 / 0 / 0 skipped. A script normalised every
changed hunk by the path mapping; nine hunks differed, all expected (globs,
README map, two tests that scanned the flat folder). Citations in 76 files
outside `tests/` rewritten; `memory/log/` keeps its paths.

## Worth remembering

- "Split it so it runs faster" is a wrong reason given for a right move: the
  module graph loads whole either way. The gain is reading cost — for agents
  that is tokens and time. Said so before asking the questions.
- A read-only survey (janitor, report only) can run in parallel with a mover
  if it greps recursively and edits nothing.
