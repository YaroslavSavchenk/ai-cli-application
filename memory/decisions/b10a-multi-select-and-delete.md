---
type: decision
created: 2026-09-20
updated: 2026-09-20
tags: [nocturne, files, delete, selection, security]
---
# B10a: multi-select in the Files panel + permanent delete with one confirmation

**Status:** decided 2026-09-20 (user's ask right after B10 landed: "maak het
ook zo, zodat ik meerdere mappen, files kan selecteren en deze ook
verwijderen. Want er is nog geen verwijderknop"). Part B10a of
`.claude/plans/PLAN-NOCTURNE.md`; spec `.claude/plans/nocturne/PLAN-B10a.md` (moves with the
repo restructure's batch 2).

## 1. Delete is PERMANENT, with one confirmation per action (user)
`Delete 3 items from src? This cannot be undone.` (single item: its name; a
folder: "and everything inside it"), `Delete` (danger) · `Cancel`, Esc =
Cancel. No trash.
- Rejected: the freedesktop trash under `~/.local/share/Trash` — the app
  would not show it and Explorer's Recycle Bin never sees it; a half-feature.

## Orchestrator defaults (recorded, not asked; each a cheap flip)
Explorer selection semantics: click selects (a folder click still toggles it
open/closed, A9b), Ctrl+click toggles, Shift+click ranges over the visible
rows, Ctrl+A = every visible row, Esc clears, Shift+arrows extend; a
selection may span parents (a tree, not one view). `Delete` in the row menu
(the whole selection when the clicked row is in it, else that row) and on
the Delete key inside the panel. The panel root and every registered project
root are never deletable (anchors; the server refuses them too). `Copy` on a
selection puts every selected path on the clipboard (≤ 100). After a delete:
affected parents refreshed once, selection cleared, one flash
(`Deleted 3 items.` / `Deleted 2 of 3 items.`). Backend: one boundary-checked
delete route, `rm -r` semantics, symlinks unlinked never followed, anchors
and the data dir refused, counts only in the log — the app's first delete
primitive, security-auditor mandatory.

Settled by the orchestrator on the Plan agent's list (2026-09-20, not asked):
arrow keys are BUILT (↑/↓ move focus, Shift+↑/↓ extend, Ctrl+Space toggles —
the tree had no arrow keys at all; Explorer parity); anchor rows inside a
selection are dropped silently and the question counts the rest; a single
item's failure shows the SERVER's sentence (it says why); `Copy` on a
selection costs one `winpath` call per path (≤ 100 loopback round trips;
no batch route); no `role="tree"` / `aria-multiselectable` retrofit
(recorded limitation; selected rows carry `aria-current`, the menu's label
names the count); the selection still clears when the panel hides (A9b).
Backend: ONE batch `POST /api/fs/delete` (one question → one request → one
log line), 200 with index-keyed results, ≤ 100 items (413 above, nothing
touched), the boundary on the PARENT (`resolveUnderAllowed(dirname)` +
`join(parentReal, name)`); the final component is handed to `rm` unresolved
— a symlink is unlinked, its target untouched — and a non-symlink target is
realpathed for the ANCHOR comparison only; refused: a target that is an
anchor, a target that CONTAINS an anchor (the parent of a project root —
found by the security review), the data dir as parent or as target, or a
folder containing it; `rm` is asynchronous (a `node_modules` delete blocked
every PTY for seconds when it was `rmSync` — scope review); a child under an
ancestor deleted in the same request counts as done. Known limit: a mount
point under home is walked and deleted (no one-file-system flag).

Out of scope, recorded: cut/move, rename, trash, undo, a progress surface,
a batch winpath route, deleting from the Changes tab.

Related: [[b10-file-copy-and-clipboard]], [[2026-09-16-nocturne-a9b]],
[[2026-09-16-nocturne-b2-a9c]].
