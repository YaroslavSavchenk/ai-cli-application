---
type: log
created: 2026-09-21
updated: 2026-09-21
tags: [repo, layout, design]
---
# 2026-09-21 — repo restructure batch 3: one home for the design sources

The user asked for both remaining batches. Batch 3 landed; batch 4 (`tests/`
into subfolders) is parked because a second session started working in the
same checkout while batch 3 was half-way.

## What landed

- One `design/` home: `session-manager/` and `peek-mascot/` (the two live
  handoffs, still local-only), `archive/handoff-v1/`, a `design/README.md`
  that says which folder is what. `design-mocks/` deleted ahead of B8. Move
  map and the reasoning about not tracking the handoffs: [[repo-layout]].
- 24 files of citations rewritten; `tests/nocturne-tokens.test.ts` and
  `tests/ui-mascot-view.test.ts` read the new locations.

## Worth remembering

- "continue" after a proposal with a publish-or-not choice is approval of the
  plan, not of the publishing. Take the reversible branch and ask again.
- The second session appeared AFTER the precondition check. `ListAgents` at
  the start of a batch is not enough for a long batch: check again before the
  commit, stage by pathspec, never `git add -A` with a peer in the tree.

## Next

Batch 4 only when no other session is editing `tests/`, `server/` or `web/`.
