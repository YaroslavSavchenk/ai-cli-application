---
type: decision
created: 2026-09-22
updated: 2026-09-23
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

## From the scope doc (moved 2026-09-23)

Verbatim wording of the `.claude/PROJECT-SCOPE.md` bullet before part O1 condensed it; the scope doc holds the current rule.

### Features (decided) — Commit view and editor panes

- **Commit view and editor panes** (Nocturne A6, landed 2026-09-13; file
  panes since A10 and file TABS inside them since A10b, both 2026-09-15;
  the commit view and the diff tabs on real data since B3, 2026-09-21; the
  file body on the real file since B4, 2026-09-22): the commit view
  is one more column in the middle row, mounted as a flex sibling in the
  order Projects, Files, commit view, pane grid, Sessions. The **commit
  view** replaces the pane area (the grid is
  `hidden`; terminals are NOT disposed and `panes.render()` refuses to
  build or reconcile while the grid is hidden — a deferred render runs on
  return): card on neutral-900, "Back to sessions", title, author initial
  avatar, "committed <when>" with the full date and time, `Committed by
  <name>` when the committer differs, the message body, the branch chip
  (absent on a detached head), the short-hash chip, "Open on GitHub" ONLY
  when `origin` is on github.com (absent otherwise, never disabled — user
  decision 2026-09-21), `N files changed +A -D` with a
  five-block bar, one collapsible block per file with a unified diff and
  "Open file" / "Changes". The Files panel's Commits tab shows the
  selected commit (message, meta, per-file rows that fold the view's
  blocks, "All commits"). An **editor pane** is a pane like a terminal
  (same card, same 38 px header, the terminal ground): its header is a
  strip of 26 px tab chips (file name, amber dot when unsaved, `×` per tab —
  a `×` here closes files and ends nothing),
  a grab area, and the pane's own `×` ("Close this pane and its N files");
  the body is the ACTIVE tab's line-number gutter + textarea with the
  file's text and a bottom bar (`Save` / `Saving…` / `Saved`), or a
  read-only diff for a "Changes in <hash>" tab (from the commit view).
  Switching tabs swaps the body only —
  neighbouring terminals are never resized or re-attached, and a tab's
  caret survives a round trip. Opening a file never narrows the grid.
  **Editor live** (B4, landed 2026-09-22; user decisions in
  `memory/decisions/b4-editor-live.md`, spec
  `.claude/plans/nocturne/PLAN-B4.md`): the body reads the file through
  `GET /api/fs/read` (text only, 1 MiB at most, UTF-8 without a NUL byte;
  a refusal — 413 too large, 415 not text, 403, 404 — is drawn as the
  pane's one sentence, no field, no Save; line endings and a BOM are
  preserved across a save, text travels LF-normalised). `Save` (the
  button, or Ctrl+S while the keyboard is in the text — the only place
  the app takes that key; a terminal keeps its XOFF) writes in place
  through `PUT /api/fs/write` with the STAMP it read (the server's
  SHA-256 of the bytes on disk, opaque to the page); a file that changed
  since answers 409 `This file changed on disk since you opened it.`, a
  vanished one 404, and the bottom bar offers `Overwrite` (my text wins,
  no stamp, recreates a gone file) and `Load from disk` (my changes go);
  keystrokes typed while a write is out stay unsaved. A CLEAN tab
  FOLLOWS its file on disk: the active tab of every editor pane on screen
  re-reads with `if=<stamp>` on one shared 5 s timer (skipped while the
  document is hidden, the body parked, a request out, or after a refusal),
  a change lands in place with the caret clamped and the scroll kept — a
  dirty tab is never touched by a follow answer or a follow refusal, and a
  follow answer that a save overtook is dropped. Unsaved text lives only
  in memory, keyed by path so the same file in two panes shares it; it is
  NEVER dropped without a question: an OPEN that would evict the fourth tab
  of a full strip (the amendment below), closing a file tab, an editor pane or
  a whole tab that would orphan unsaved text (a file still shown elsewhere
  is not lost) asks `Discard unsaved changes to <name>?` / `… to N files?`
  (`Discard` in danger ink, `Keep editing` the default and Esc — the
  delete dialog's shape), and a reload or window close goes through the
  browser's `beforeunload` question while any file is unsaved (disarmed
  for the app's own restart handoff and auth-loss reload). KNOWN LIMITS,
  recorded: the backend's grace timer after the last window closed is the
  one door that cannot ask; a HARD LINK inside the boundary to a file
  outside it (or to the data dir's own files) is read and written through
  — `realpath` cannot see it, the planter already runs as the user, the
  requester already holds the shell-spawning token; an `nlink` refusal was
  rejected because pnpm's store is hard links; a file being edited by the
  editor and rewritten by a tool at the same instant is settled by the
  stamp, never merged. Server side (`server/fstext.ts`): the same anchor
  boundary as `/api/fs/create`, the data dir refused, the fd judged before
  the path is trusted (`O_NOFOLLOW|O_NONBLOCK`, a regular file only — a
  FIFO, socket, device or planted link answers 415 without a hang), the
  stamp compared and the bytes written on ONE descriptor (inode, mode,
  links and owner stay; a read-only file answers 403), counts-only logging.
  The last mock module (`web/src/ui/files-mock.ts`) went with this part.
  The pane chords (Ctrl+Alt+arrows,
  Ctrl+Alt+W, Ctrl+Alt+PageUp/PageDown unshifted, Ctrl+Alt+M) and the
  tab-switch chords (Ctrl+Alt+1..9) are ignored while a commit view is up;
  Ctrl+Alt+Shift+PageUp/PageDown (reorder tabs) stays live. Esc closes the commit view
  (rank: after every dialog, before drawers and the Files panel) and hands
  the keyboard to the terminal. New `ChangeKind` `'screen'` = something
  other than the panes fills the pane area; the pane module ignores it.
  Code surfaces (editor, diff, paths) draw plain glyphs — no font
  ligatures — like the terminal. Since B4 nothing in the app is mock: the
  editor draws the file, the commit view and the diff tabs draw the
  repository. Esc inside a file pane's textarea
  belongs to the textarea and closes nothing.
