# Plans — where they live and how they are written

Decided 2026-09-20 (user's call; rationale in
`memory/decisions/repo-layout.md`). `tests/plans-layout.test.ts` enforces the
checkable half of this file. `.claude/PROJECT-SCOPE.md` stays the current
truth about the app; a plan says what will be built next and in which order.

## Layout

```
.claude/plans/
  README.md                       this file: the convention + the index below
  PLAN-<NAME>.md                  a MASTER plan: one body of work, its parts, their order and status
  RELEASE-NOTES-<version>-draft.md
  <name>/                         the part specs of PLAN-<NAME>.md (lower-case <name>)
    PLAN-<ID>.md                  one part; <ID> spelled exactly as the master plan spells it (A9b, B10a)
```

A part spec is born in `<name>/` and **never moves** — not when it lands, not
when it is dropped. Code comments and tests cite specs by path, so a path that
changed at every landing would mean edits in `server/` and `web/` for a
bookkeeping event. Live or landed is read from the master plan's status table
and from the spec's own `Status:` line, not from the folder.

## The master plan

1. Starts with `# Plan: <title>`, then a line `Status: see the table below
   (updated <date>)`, then **the status table — the ONE place that says where
   the work stands**: one row per part, columns `Part · What · State · Spec ·
   Landed`. States: `todo` · `started` · `landed` · `verified` (landed and
   checked by the user on Windows) · `dropped`. No status prose above the
   table; what happened goes in the vault's work log.
2. Then: the decision that started it, fixed rules for every part, the parts
   (short bullets per part — detail belongs to the part spec), open decisions
   (numbered, struck through with date and outcome when settled, never
   deleted), suggested order.
3. A part is started only on the user's word ("begin aan <id>").

## A part spec

1. `# <ID> — <what it does, in the user's words>`.
2. Line 3 is `Status: <STATE> <YYYY-MM-DD> (…)` with STATE one of `DRAFT` ·
   `DECIDED` · `STARTED` · `LANDED` · `DROPPED`; after a landing it names the
   commit hashes and the user's Windows verdict. Older states stay behind it
   as history (`LANDED … ; earlier: DECIDED …`).
3. It names its parent (`Part B10 of .claude/plans/PLAN-NOCTURNE.md`).
4. Written before the developer starts, with the user's decisions already
   asked (dev-flow lean rule 6). Frozen signatures, file list, phases, the
   test gate, the final gate. Line numbers drift — say so where you use them.
5. Not every part needs one: a part small enough to brief from the master
   plan's bullets has no spec, and its table row says `—`.

## When a part lands — in the landing commit

1. Spec: `Status: LANDED <date> (<hashes>…)`.
2. Master plan: the part's row (`State`, `Landed`), nothing else.
3. Index below: the spec's line, if it is new.
4. Vault: the work-log entry at `memory/log/<YYYY-MM>/<area>/`, its INDEX
   line, decision notes for what the user decided (the `/memory` skill).
5. `.claude/PROJECT-SCOPE.md` when the landed part changed the current truth.

## Citing a plan

Full path from the repo root — `.claude/plans/nocturne/PLAN-B10.md`, with
`§ <n>` for a section. The bare filename is fine inside `.claude/plans/`
itself. Either form must resolve, in every tracked file; only
`memory/log/` is exempt (history keeps the paths of its day — the move map in
`memory/decisions/repo-layout.md` translates them).

## Moving or renaming anything here

Through `/restructure-repo`, like every other move in this repo.

## Index

Master plans:

- `PLAN-NOCTURNE.md` — the Nocturne redesign, Track A (UI), Track B (function), Track C (mascot); ships as v0.4.0
- `PLAN-RESTRUCTURE.md` — the repo restructure, in batches
- `RELEASE-NOTES-v0.4.0-draft.md` — finalised in Nocturne part B8

Part specs, `nocturne/`:

- `PLAN-A9.md` — drop files and folders from Windows Explorer (visual half)
- `PLAN-A9b.md` — select a folder, paste files into it, the row context menu
- `PLAN-A10.md` — the editor as panes in the tab strip
- `PLAN-A10b.md` — the editor pane with file tabs
- `PLAN-B1.md` — the pane status bar on Claude Code's own data
- `PLAN-B2.md` — the Files panel on the real file system, plus New file / New folder (A9c)
- `PLAN-B5.md` — the New session dialog live for every tool
- `PLAN-B10.md` — real file copy into WSL, Copy to the Windows clipboard
- `PLAN-B10a.md` — select several files and folders, and delete them
