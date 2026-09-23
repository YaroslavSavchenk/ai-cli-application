# A10 — Editor as panes in the tab strip: implementation spec

Status: LANDED 2026-09-15 (log `2026-09-15-nocturne-a10`); earlier: DECIDED 2026-09-15 (user); Phases 0, 1A, 1B landed 2026-09-15; review/fix cycle 1 in progress. Part A10 of
`PLAN-NOCTURNE.md`. Written by the orchestrator from the Plan agent's design;
line numbers are from commit `03b55c8` and DRIFT — use them as a starting
point, verify by reading.

## User decisions (fixed, do not re-open)

1. A file opens FULL in the pane area as a pane in a tab of the bottom strip —
   no half-screen editor column, no empty state beside it.
2. One tab per ROOT FOLDER, named after it (`Home`, or the project name);
   every file opened from that folder is a pane in that tab; layouts 1/2/4.
3. FREE MIXING: a pane is a terminal, a file, or a read-only diff; a file may
   sit beside a terminal in one tab.
4. A FIXED `Home` tab: always present, ALWAYS FIRST in the strip, never
   draggable, never closable, never dissolved (may stand empty).
5. Drag (pointer events, see §3): reorder tabs, swap panes within a tab, drag
   a file row from the Files panel onto a pane / pane edge / tab chip. Moving
   an open file to another tab was NOT asked. Every drag has a keyboard twin.
6. Closing the last file pane of a PROJECT folder tab closes that tab unless it
   still holds a terminal; `Home` never closes.
7. A file dropped on the CENTRE of a terminal pane is REJECTED (flash "drop on
   an edge to split"); edges split. Centre of a file pane = replace.
8. The A6 `Changes in <hash>` read-only diff stays as a third pane kind `diff`.
9. Orchestrator defaults: a new session keeps getting its own rootless tab (a
   terminal reaches a folder tab only by drag or chord); a file opened while
   the Files panel shows a session WITHOUT a project goes to `Home` (A10 gap,
   B2 closes it with the real file-browser root); chords = existing
   ctrl+alt+shift+arrows (swap panes), ctrl+alt+shift+pgup/pgdn (reorder tabs),
   ctrl+alt+1..9 (switch tab) plus NEW ctrl+alt+enter (focused file row → open
   in a split beside the focused pane) and ctrl+alt+w (close the focused
   file/diff pane; nothing on a session pane).
10. Mock text stays (`ui/files-mock.ts`); B4 makes files real. File/diff slots
    are NOT persisted before B4.

## 1. Data model (Phase 0)

```ts
export type PaneSlot =
  | { kind: 'session'; id: string }
  | { kind: 'file'; path: string }
  | { kind: 'diff'; hash: string; path: string };

export type ViewRoot = { kind: 'home' } | { kind: 'project'; id: string };

export interface ViewState {
  id: string;
  root: ViewRoot | null;   // null = plain session tab
  slots: PaneSlot[];       // RENAMED from `sessions` (tsc enumerates every site)
  focused: number;
  l3: L3;
  split: { col: number; row: number };
}
```

- Helpers in `state.ts`: `slotKey(s)` → `'s:<id>' | 'f:<path>' | 'd:<hash>:<path>'`
  where file/diff keys are EXACTLY `fileTabId(path)` / `diffTabId(hash,path)`
  from `editor-model.ts` (the `state.edits` key contract); `sessionIds(v)`;
  `isFolderView(v)`; `ensureHomeView()`; `viewForRoot(root)` (find or create +
  notify); `openFile(root, path, label)`; `openFileAt(viewId, slot, zone|'replace', path)`
  → result incl. rejection reasons (`full`, `session-centre`); `closeSlot(viewId, index)`;
  `movePane(dir)` (renamed from `moveSession`, kind-blind).
- `Home` = a real `ViewState` with `root = {kind:'home'}`. `ensureHomeView()`
  after `reconcileViews()` in `loadUi()` and at the top of `reconcileViews()`;
  it is ALWAYS `state.views[0]` — `reorderView`/`moveActiveViewBy` never move
  it or move another view before it; `closeView`/`dissolveView` refuse it.
- A ROOTED view may hold ZERO slots; a rootless view keeps today's dissolve
  rule. A PROJECT-rooted view with zero slots after a close IS removed
  (decision 6); Home never.
- Root for a file = the Files panel's `subject()`: `Home` → home view; focused
  session with `projectId` → project view (created on demand); no project →
  Home. Pure function `rootForSubject()` in NEW DOM-free `ui/slots-model.ts`
  (also `viewLabel()`, `slotTitle()`, and the pure drop geometry `zoneForPoint()`).
- `state.editor` DELETED; `state.edits` KEPT keyed by `f:<path>` (same file in
  two panes shares its unsaved text). Deleted: `openEditorTab`, `closeEditorTab`,
  `setEditorActive`, `activeEditorTab`, `editorVisible`; from `editor-model.ts`:
  `EditorState`, `openTab`, `closeTab`, `setActive`, `activeTab`. Kept:
  `editorFileId`, `setEdit`, `editorDirty`, `editText`, `saveEdit`, `tabKind`,
  `fileTabId`, `diffTabId`, `gutterText`, `saveLabel`.
- `viewStatus` gains `'none'` (no session slots → no dot). `viewAttention`
  reads session slots only. `attentionCount`/`aliveSessionCount` unchanged.
- Persistence (`ai-sm:ui:v2`, localStorage only; the server stores no views):
  `saveUi` writes `root` and ONLY session slots; `validateView` decodes `root`,
  keeps a zero-slot view only when it is Home (`// B4: file slots persist; drop
  this exception.`); `migrateV1` emits session slots + `root:null`.
- `reconcileViews` prunes SESSION slots against `state.sessions` only — a path
  is not a session id; a rooted view emptied this way is not dissolved.
- `insertSlots` (was `insertSessions`), `removeAtSlot`, `dropZonesFor`,
  `swapPanes`, `movePane`, `neighbors`: kind-blind; index by `slotKey`, never
  by `indexOf(string)`. `focusSession`, `viewOfSession`, `moveSessionToView`,
  `extractSession`, `replaceSessionInView`, `upsertSession`: session-specific,
  keep; no file twins for move-to-view/extract.

## 2. Sites that assume a slot is a session (Phase 1A/1B)

`panes.ts`: `Slot` interface → shared chrome + per-kind payload; `'sessions'`
subscriber and the 15 s tick skip non-session slots; `gridHidden()` UNCHANGED
and still the first statement of `render()`; `requestTerminalFocus()` keeps
its name, body focuses the file textarea / diff header chip / terminal (nine
callers untouched, `handBackKeyboard` works as is); `focusedPaneDims()` must
never fall to 80x24 because a file is focused (try another slot of the view,
then `lastGoodDims`); `render()` gets a zero-slot empty branch BEFORE
`viewLayout`; its rebuild signature stays LAYOUT-only (view id, count, l3 —
kinds in the signature would re-attach every terminal on a swap, verify
check 8); `reconcileSlot`
converts IN PLACE (session→file: `view.dispose()` THEN `termHost.replaceChildren()`;
file→session: tear down the file body, `new TerminalView` on the attached
root, `connect()`), never through a full rebuild that re-attaches other
terminals; `applyFocus` key includes `slotKey`; file pane header = file name +
dirty dot + `×` (a `×` on a FILE pane does not break the A3 no-close rule,
which is about ending sessions); session headers unchanged; `updateHeader/
updateStatus/updateNote/relaunch` session-only; `armDrag` spec carries
`slotKey`, file headers are drag sources.
`tabs.ts`: label = root name or joined slot titles; pill "N panes in this tab";
dirty dot when any file slot of the view has an entry in `state.edits`; no
status dot on `'none'`; Home: no `×`, no drag; a file-only folder tab closes
without the armed two-step (nothing is killed); `killView` loops session slots.
`dnd.ts`: `DragSpec` = `tab | pane{viewId,slot,slotKey,label} | file{path,label}`;
`resolve()` counts slots; pane drag → swap works for files, `extract`/
`move-to-view` null for a file spec; file drag → `open-file{slot,zone|'replace'}`
or `open-file-tab{viewId}`; `drop()` calls `st.openFileAt`. Strip drop zones
never target position 0 (Home).
`statusline.ts`: `N panes` = `v.slots.length`; `N sessions` unchanged.
`files.ts`: `subject()` must follow the VIEW's `root` when the focused slot is
a file/diff (else the header flips to an unrelated project); rows call
`st.openFile(rootForSubject(...), path, name)`; `is-open` = some slot shows
this path; rows are drag sources with `title` naming ctrl+alt+enter; `files.ts`
must NOT import `panes.ts` (xterm kills `node --test`).
`keys.ts`: NO CHANGE — the pane area must not become a focus owner
(`files-panel-focus-owner-trap`); the textarea is already an editable target.
Pin both with a test.
`main.ts`: delete `initEditor`, `editorAside`, `is-narrow`, `editor.render()`;
KEEP the hidden-grid / `refreshPaneArea` lines in `applyScreenLayout`;
commit view's focus callback → `requestTerminalFocus`; chords:
`moveSession` → `movePane`, add ctrl+alt+w; ctrl+alt+enter lives on the
focused Files ROW (files.ts keydown), so it is NOT in the terminal allowlist;
no new Esc arm
(Esc inside a textarea belongs to the textarea; `fromTerminal` tests
`.term-host`, a file pane is not one).
`terminal.ts`: the fit → ws resize seam does not change by one line; the ONLY
edit is the ctrl+alt passthrough allowlist (~255–266): add `w` (a focused
terminal would otherwise eat the chord; on a terminal pane it does nothing
and is swallowed — recorded in PROJECT-SCOPE.md).
`shortcuts.ts`: "move session between panes" → "move the focused pane (swap)";
new rows for the two chords and the file drag gestures with their twins.
`editor.ts` deleted → NEW `ui/file-pane.ts` (one file's body: honesty note,
gutter, textarea, Save; diff kind = `diffBody()` read-only) carrying the A6
lessons: body not rebuilt per keystroke, a path without mock text = note + no
Save, `font-variant-ligatures: none`. `commit-view.ts` re-points `Open file` /
`Changes` to `st.openFile` / a diff slot.
CSS: pane card / pane header / empty state / tab strip blocks change;
`.editor-*` block deleted (zero users; class-parity tests); `.pane-drop`
+ `[data-zone]` reused with copy `Open here / beside / above / below`.
Tests to rewrite: `ui-a6-screens` (editor half), `ui-editor-model`,
`ui-state`, `ui-files-panel`, `ui-pane-a3` (source pins), `ui-a8-dialogs:76`
(`editor` family), `ui-a7-parity`.

## 3. Drag: pointer events, not HTML5 DnD

Same contract as `dnd.ts` today (controlled ghost, `elementFromPoint`,
Escape cancels, post-drag click swallowed). Extra reason: A9/B10 needs the
window's HTML5 `dragover`/`drop` for REAL files from Explorer; in-app drags
stay off that channel. No `draggable` attribute anywhere in `web/src`.
Drop geometry on a pane reuses the bands of `dnd.ts` + `dropZonesFor`: centre
= replace (file pane) / reject (session pane); outer band = split at the zone
the band maps to; full tab = existing `reject-full` flash. File row → tab chip
= append (reject when full).

## 4. Phases

- **Phase 0 — MODEL** (first, alone): `state.ts`, NEW `ui/slots-model.ts`,
  `ui/editor-model.ts` prune, tests `ui-state`, `ui-editor-model`, NEW
  `ui-slots-model`. No DOM, no xterm, no CSS. The tree may not typecheck
  at the end of Phase 0 where `panes.ts`/`tabs.ts`/`dnd.ts`/`editor.ts`/
  `files.ts`/`main.ts` still read `sessions`/`state.editor` — Phase 0 leaves
  the OLD consumers compiling by whatever minimal shim is honest (preferred:
  none; a temporary `sessions` getter is acceptable only if marked
  `// A10 Phase 1 removes`), and reports exactly which sites remain.
- **Phase 1A — GRID + TABS + SHELL**: `panes.ts`, `tabs.ts`, NEW `file-pane.ts`,
  delete `editor.ts`, `commit-view.ts` buttons, `statusline.ts` panes count,
  `main.ts` SHELL + `applyScreenLayout` region only, `app.css` blocks pane
  card / pane header / empty state / tab strip / delete editor block.
- **Phase 1B — DRAG + KEYBOARD + FILES SOURCE** (parallel with 1A): `dnd.ts`,
  `files.ts`, `shortcuts.ts`, `terminal.ts` allowlist only, `main.ts` KEYDOWN
  region only, `app.css` drag-and-drop strip states + `.pane-drop` rules only,
  `tests/helpers/fake-dom.ts` gains settable `getBoundingClientRect` +
  `elementFromPoint` stubs; pure geometry tested via `slots-model.ts`.
- Overlap: 1A/1B share `main.ts` and `app.css` in disjoint regions named by
  block header/class, never by line.

## 5. Terminal-seam risks → verify-terminal

Full 1–9 after Phase 1, with: check 4 ×3 (terminal + file in layout 2 with
divider drag; 2 terminals + 2 files switching 4→2→1; window resize WHILE the
file textarea is focused — neighbour terminal must reflow); check 6 across
folder tabs; check 7 with a file pane focused (BEL badge raised and kept);
check 8 while swapping file/terminal panes with ctrl+alt+shift+arrows during
`find / | head -5000` — `server.log` shows no `attach` for untouched slots;
check 3 after open/close of a file pane beside `vim`; check 2 extra: `cat -v`
prints nothing on ctrl+alt+w (swallowed by the allowlist) and DOES print
ctrl+alt+enter's bytes (left alone: the chord lives on a Files row); check 9 launched while a file
pane is focused (the 80x24 regression).
