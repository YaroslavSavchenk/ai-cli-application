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

## O4 — how a test is written

`tests/README.md`: layout, one topic per file ≤ 800 lines, the header (what ·
how · why · NOT claimed), behaviour-sentence names, the cheapest seam that
proves the claim, condition waits not clocks, clean-up, the one allowed
skip. `tests/repo/file-size.test.ts` enforces the size half with a
shrink-only list of 52 grandfathered files (38 test modules, 14 source);
both directions mutation-checked (a file dropped from the list → red; a
file under its limit left on it → red). Cited from `CLAUDE.md`, the
`test-engineer` agent and `/dev-flow`.

## O5 — duplicated test code into `tests/helpers/`

108 files, net −251 lines, test names byte-exact (sorted name list diffed
against the baseline: only the two new guard tests added), no assertion
changed — the few that moved went into helpers verbatim. Folded: 32 sleeps →
`sleep`, 12 `setImmediate` turns → `nextImmediate`, 7 root skips →
`SKIP_IF_ROOT`/`IS_ROOT`, 201 `mkdtemp` → `makeTempDir(Sync)`, 156 `rm`
clean-ups → `removeTempDir` (only where an AST scope check proved the
variable is that temp dir), 112 source reads → `readSource`, `FakeApiError`
one home, `onPath`/`trackedFiles`/`exists`/`git` and a dozen UI helpers
(new `tests/helpers/source-scan.ts`). Durations of every wait kept exactly.

Left open, report only (a later test-hardening pass, not this plan): sleeps
that stand in for a condition — `update-check-route` :326/:345/:364/:412,
`ui-dnd-a10` ×6 + `ui-files-panel` :1221 (`sleep(90)` past the 80 ms click
swallow), `git-commits` :1729 / `git-changes` :495 (`sleep(500)`), and
hand-rolled polling loops in `agents` and `telemetry` that `waitUntil` could
replace. Line numbers as of `O5`'s commit.

## Worth remembering

- "Split it so it runs faster" is a wrong reason given for a right move: the
  module graph loads whole either way. The gain is reading cost — for agents
  that is tokens and time. Said so before asking the questions.
- A read-only survey (janitor, report only) can run in parallel with a mover
  if it greps recursively and edits nothing.
