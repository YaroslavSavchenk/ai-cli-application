---
type: decision
created: 2026-09-22
updated: 2026-09-22
tags: [nocturne, editor, files, security, persistence]
---
# B4: the editor pane reads, saves, follows and survives

**Status:** decided 2026-09-22 (user: "continue werken aan de app" — B4 was
the next row of the status table; four questions asked before the developer
started). Part B4 of `.claude/plans/PLAN-NOCTURNE.md`; spec
`.claude/plans/nocturne/PLAN-B4.md`.

## 1. Unsaved text is never dropped without a question (user)
Closing a file tab, an editor pane or a whole tab that would orphan unsaved
text asks `Discard unsaved changes to <name>?` (several: `… to N files?`),
`Discard` (danger) / `Keep editing` (default, Esc). Reload and window close
go through the browser's own `beforeunload` question. The backend's grace
timer after the last window closed is the one door that cannot ask — known
limit, recorded in the scope doc.
- Rejected: no confirmation (the amber dot alone, the A6–B3 state);
  auto-save (no Save button, a write per keystroke — the user's text would
  reach disk before they meant it to).
- A file open in two panes is ONE text (`state.edits` keyed by path):
  closing one of the two loses nothing and asks nothing.

## 2. Open editor tabs survive a reload (user)
File and diff tabs are written into the localStorage v2 bag beside the
session slots — the A10b exception ("editor slots are not persisted until
B4", user decision 10 of 2026-09-15) ends here. Unsaved TEXT does not
survive; decision 1's `beforeunload` question stands between the user and
that loss. The reader gates every persisted tab (absolute path, no NUL,
40-hex hash, unknown kinds dropped, the pane's tab cap); no schema bump — an
older build already skipped non-session slots.

## 3. A clean tab follows its file on disk (user)
The ACTIVE tab of every editor pane on screen re-reads its file when the
bytes on disk change, on the same 5 s rhythm as the Files panel — so a file
Claude Code rewrites in the terminal beside the pane updates in place. A
tab with unsaved text is never overwritten from disk.
- Rejected: read once with a Reload button — in an app whose point is
  watching an agent edit a project, a stale editor beside a live terminal
  is a lie.
- Cost: one small request per visible clean tab per 5 s (`if=<stamp>`, no
  body when unchanged), none while the document is hidden.

## 4. A save onto a file that changed on disk is refused, then the user chooses (user)
Save sends the stamp it read; a mismatch answers 409 `This file changed on
disk since you opened it.` and the pane offers `Overwrite` (my text wins)
and `Load from disk` (my changes go). A file that vanished answers 404 with
the same two buttons (`Overwrite` recreates it).
- Rejected: always overwrite — silent loss of what the agent just wrote.

## Orchestrator defaults (recorded, not asked; each a cheap flip)
Ctrl+S saves while the keyboard is in the text field, untouched elsewhere
(a terminal keeps its XOFF); text only, 1 MiB at most (413), a NUL byte or
invalid UTF-8 refused (415) — both drawn as the pane's one sentence, no
field; line endings (`eol` = the FIRST line break's kind, a mixed file
comes back uniform) and a BOM preserved across a save, text LF-normalised
on the wire; the stamp is the SHA-256 of the bytes on disk, opaque to the
client (never mtime — a 9p mount and a clock step both lie about time); a
save writes IN PLACE on one file descriptor (open, compare, truncate,
write, fsync — inode, mode, hard links and owner stay; a read-only file
answers 403 instead of being replaced through a writable folder; the
compare and the write share the fd, so nothing slips between them); the
path boundary is `/api/fs/create`'s (home + every registered project root,
the data dir refused, a symlink judged by where it lands); polling, not
inotify; no autosave, no syntax colouring. `files-mock.ts` — the last mock
module — is deleted with this part.

## Related
[[b3-commits-live]] (the diff tabs this pane also holds),
[[b10a-multi-select-and-delete]] (the confirm dialog's shape),
[[fifo-open-blocks-main-thread]] (the read's open flags),
[[path-normalization-delete-primitive]] (the boundary),
[[log-everything]] (counts, never contents).
