---
type: decision
created: 2026-09-22
updated: 2026-09-22
tags: [nocturne, files, rename, security, editor]
---
# B13: rename files and folders in the Files panel

**Status:** decided 2026-09-22 (user: "begin aan b13 … hernoemen", then
"eerst hernoemen, daarna de release" — v0.4.0 waits for this part). Part
B13 of `.claude/plans/PLAN-NOCTURNE.md`; spec
`.claude/plans/nocturne/PLAN-B13.md`. Builds on
[[b10a-multi-select-and-delete]] (anchors, the delete primitive) and
[[b4-editor-live]] (unsaved text is never dropped silently).

## User decisions (asked before the developer started)
1. **A taken name is refused**, never replaced: `Something with that name
   already exists here.` under the input, the typed text kept. Rejected:
   a replace question — a hidden permanent delete.
2. **Home, the panel root, every project root and every folder that
   CONTAINS a project are never renamable** — menu entry absent, F2 does
   nothing, the server refuses. Renaming a project belongs on the Projects
   surface (later).
3. **Open editor tabs follow the rename**, unsaved text with them; diff tabs
   stay. Caret and scroll are lost (recorded).
4. **A folder with a running session inside is renamable**, with a note
   under the name row: `A session is working inside this folder. It keeps
   running; its folder shows the old name.`

## Orchestrator defaults (not asked; cheap flips)
F2 on the focused row + `Rename` in the row menu (single row); same folder
only (no move — the request carries a name, not a destination); the stem
before the last dot is pre-selected; Enter commits, Esc / blur / menu / tab
switch / root change / hidden panel cancel; no success flash; the response
carries no path (the client builds it — the tree is keyed by the SHOWN
path, the server works on the realpath'd parent).

## Decided during review
- **Protection by identity, not by path text** (security review, two
  rounds): string compares missed a project registered through a symlink,
  a symlink deeper in a project's or the data dir's chain, and — pre-existing,
  also in delete — a case variant on drvfs (`realpath` keeps the request's
  case there). `server/fsprotect.ts` walks every anchor, stored project path
  and the configured data dir component by component and records the
  `dev:ino` (bigint — drvfs inos are NTFS seq << 48) of every entry passed;
  rename and delete refuse a source in that set. Cached 5 s; a walk that
  hangs past 3 s answers 503 (fail safe) and is not cached. Measured: every
  case spelling of `/mnt/c/Windows` has one `dev:ino`.
- **A rename is refused when unsaved text is already open under the new
  name** (scope review): `A tab with unsaved changes is already open under
  that name.` — otherwise the tab move would overwrite it.
- Known limits: a case variant of a STALE project's name on drvfs is not
  caught by the dst check (text compare); a hard link to a protected
  symlink, or an inode reused within 5 s, is over-refused (safe direction).
