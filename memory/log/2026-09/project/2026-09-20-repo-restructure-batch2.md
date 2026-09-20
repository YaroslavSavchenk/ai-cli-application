---
type: log
created: 2026-09-20
updated: 2026-09-20
tags: [repo, layout, plans, process]
---
# 2026-09-20 (evening) — repo restructure batch 2: the plans, and one shape for planning

After B10 and B10a had landed and the other session had closed, the user:
restructure the planning and fix how it is done, if that is not written down.
It was not — eleven `PLAN-*.md` files loose in `.claude/`, three spellings of
a part id in filenames, stale `Status:` lines on landed specs, and a master
plan whose status was one paragraph of 3 000 characters.

## What landed

- 12 × `git mv` into `.claude/plans/` and `.claude/plans/nocturne/`; 56 files
  of citations rewritten. Rules, move map and rejected layouts: [[repo-layout]].
- `.claude/plans/README.md` — the convention: layout, what a master plan and
  a part spec look like, the landing checklist, how to cite a plan, the index.
- `PLAN-NOCTURNE.md` opens with a status table (26 parts: 19 landed or
  verified, C1 started, B3 next); the old paragraph is kept verbatim under
  `## Status history`. `PLAN-RESTRUCTURE.md` got the same head.
- `tests/plans-layout.test.ts` (7 tests) — probed with a loose plan, a spec
  with a bad status and no table row, and a dead citation in `shared/`: each
  turned the right tests red.
- Ground rule in `CLAUDE.md`, a paragraph under Process in the scope doc,
  lean rule 6 of the dev-flow skill now names where a spec is written.

## Worth remembering

- The first proposal was a `landed/` folder. Counting citations first killed
  it: 45 code and test files cite specs by path. Measure the references
  before choosing the layout, not after.
- A mechanical rewrite across `server/` and `web/` needs no reviewer when it
  can be proven: every changed line was checked to equal the path mapping
  applied to its old self (50 of 50).
- A `pgrep -f` wait loop matches its own command line and never ends.

## Next

Batch 3 (design folders) and batch 4 (tests and code) — each with its move
map to the user first. Nocturne: B3 on the user's word.
