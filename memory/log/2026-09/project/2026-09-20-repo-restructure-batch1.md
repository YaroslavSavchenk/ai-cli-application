---
type: log
created: 2026-09-20
updated: 2026-09-20
tags: [repo, layout, memory, skill]
---
# 2026-09-20 — repo restructure: the skill, and batch 1 (the vault)

The user asked for the whole repo to be restructured, a skill for it first.
A second session was building Nocturne B10 in the same checkout.

## What landed

- `a25e4c1` — `/restructure-repo`: the procedure plus `find-refs.sh` (every
  textual reference to a path about to move; exit 1 = references found).
- Batch 1 — the 48 work-log entries into `memory/log/<YYYY-MM>/<area>/`,
  `memory/INDEX.md` regrouped (decisions and knowledge by theme, log by
  month; 103 links before and after), the memory skill's § Layout, the one
  path citation outside the vault (`.claude/PLAN-B5.md`), a `## Repository
  layout` map in `README.md`. Rules and the full map: [[repo-layout]].
- Baseline and after: suite 2594 / 0.

## Worth remembering

- Wikilinks resolve by filename — 48 moves, zero link edits. The price is
  that basenames must stay unique across the vault.
- Two sessions, one checkout: the peer's uncommitted `memory/INDEX.md` edit
  was in the tree when batch 1 started. Agreed by message: no `git add -A`
  over the other session's files, INDEX untouched until the peer committed
  (`d2adabb`), a message before the first move and the hash after the push.

## Next

Batches 2–4 (plans, design folders, tests and code) start only after B10
lands — `.claude/PLAN-RESTRUCTURE.md`. Each needs its move map approved by
the user first.
