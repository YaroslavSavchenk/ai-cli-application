# A9 — Drop files and folders from Windows Explorer (visual half, mock transport)

Status: DECIDED 2026-09-15 (user); Phase 0 started 2026-09-15. Part A9 of
`PLAN-NOCTURNE.md` (B10 = the functional half: real upload endpoint under the
user's home, path checks, limits, security review, copy-to-clipboard via the
native host). Written by the orchestrator from the Plan agent's design; line
numbers drift — verify by reading.

## User decisions (fixed)

1. Drop targets = BOTH Files-panel folder rows and terminal/file panes; also
   the Files panel's non-folder area (→ the panel's root) and the empty pane
   area of an empty tab (→ that tab's root).
2. Conflicts = ask per drop, Explorer-style: `Replace` / `Keep both` / `Skip`;
   ONE dialog per drop, the choice covers every conflict in that drop (so NO
   "apply to all" checkbox — the sentence names the count instead).
3. No dragging OUT of the app. Copy-to-clipboard from the app's file system is
   B10 (native host `Clipboard.SetFileDropList` with `\\wsl.localhost\...`).
4. A drop on a terminal pane of a session WITHOUT a project is NOT a target;
   the flash reads `This session has no project folder yet.` (the app may not
   show a path and cannot name the folder; B10 may fill it in when the backend
   can answer with a NAME).
5. Non-`Files` external drags (text from another program) onto a TERMINAL are
   cancelled (protects the PTY from an unbracketed paste; Ctrl+Shift+V stays
   the way to paste). Small behaviour change, recorded.
6. Orchestrator defaults: one `Copy files here…` button in the Files-panel
   header is the keyboard/button twin (native picker, `<input type=file
   multiple>`); no separate folder-picker button; the destination is always a
   NAME (`Home`, project name, folder name), never a path; mock transport with
   a mandatory honesty line until B10.

## Facts checked (Plan agent, 2026-09-15)

- The native host (`launcher/host/AiSessionManagerHost.cs`, WebView2 SDK
  1.0.3405.78) does not block external drops: `AllowExternalDrop` defaults to
  true, no setting touches drag/drop; the Edge `--app` fallback allows drops
  natively. A9 is visible on Windows without host changes (still to be seen in
  the user's dev window). The host has NO web-message channel and NO clipboard
  write today — B10 adds `WebMessageReceived` + `SetFileDropList` (+ distro
  arg → security review).
- Paste of files needs no permission: the `paste` event does not pass
  `PermissionRequested`.
- During `dragover` Chromium exposes only `dataTransfer.types`; `getAsFile()`
  / `webkitGetAsEntry()` return null until `drop`. So the drag says `N items`,
  the dialog says `2 files and 1 folder`.
- xterm registers no drop handler, but its helper textarea takes a TEXT drop
  as typed input; an un-cancelled FILE drop NAVIGATES the window to the file.

## 1. Events (`web/src/ui/filedrop.ts`, new)

- `dragenter/dragover/dragleave/drop` on `window`, CAPTURE phase. External =
  `types` includes `Files`. `dragover` calls `preventDefault()` for EVERY
  `Files` drag anywhere in the window (otherwise no `drop` fires and a
  mis-aimed drop navigates the app away); validity is expressed through
  `dropEffect = 'copy' | 'none'` and the highlight. `drop` always
  `preventDefault()`, acts only on a resolved target. Non-`Files` drags whose
  target is inside `.term-host` are cancelled (decision 5), nothing else.
- Ending: on `drop`; on a `dragleave` outside the viewport (`relatedTarget
  === null`); and a 300 ms watchdog stamped by `dragover`. No enter/leave
  counting. Escape does NOT cancel an OS drag — the overlay must not claim it.
- In-app pointer drags and external drags never meet: no `draggable` anywhere
  (pinned), plus `dnd.ts` exports `isDragging()` and filedrop ignores every
  external event while it is true. Add a mirror pin: no `dragstart` listener
  in `web/src`.
- A modal up (`OPEN_MODAL_SELECTOR = '.modal-scrim:not([hidden])'`, new in
  `keys.ts` beside the focus-owner selectors — NOT the focus-owner selector,
  drawers must not disable pane drops) → every target invalid.
- Folders: `webkitGetAsEntry()` in `drop` only, TOP LEVEL only (`name`,
  `isDirectory`); recursion via repeated `readEntries()` and byte totals are
  B10. `MAX_ITEMS = 200` top-level items, more → refused with one sentence.
  `getAsFile()?.size` for files drives the mock `Failed` outcome
  (`MAX_ITEM_BYTES = 50 MiB`, the same constant B10 enforces server-side).
- Paste: `window` `paste` with `clipboardData.files.length > 0`, acting ONLY
  when `!fromTerminal(target) && !isEditable(target)` (helpers in `main.ts`
  / `keys.ts`); plain Ctrl+V in a terminal or textarea stays theirs.
  Destination = `pasteDestination()` = focused Files folder row, else the
  panel root (`subject()` name), else the active tab's root — the SAME
  function the header button uses.

## 2. Targets and visuals

Resolve with `elementFromPoint` + `closest`, in order: `.files-row.is-dir` →
that folder (its own name); anywhere else in `.files-view` → the panel root
(`subject().name`); `.pane[data-slot]` → the view's `root` name, else the
session's project name, else NOT a target (decision 4); `.empty-state` → the
active view's root; nothing / modal / commit view → invalid.
Visuals (no layout change anywhere — outlines, fixed ghost, absolute overlay;
a width change would fire every pane's ResizeObserver → PTY resize storm):
`.files-row.is-dir.is-drop` and `.files-view.is-drop` = the `.empty-state.is-drop`
recipe (accent-900 ground + dashed accent inset outline); panes reuse
`.pane-drop` with NO `data-zone` (whole-pane box) and label `Copy into <dest>`
(external drops never split a pane); a `.drag-ghost` follows the cursor for
the whole drag with `Copy 3 items into src`, or `Drop on a folder or a pane.`
+ `.is-invalid` over nothing (matches the OS no-drop cursor);
`body.is-filedrag` joins the `body.is-dnd` no-select rule. The statusline
only flashes refusals after release.

## 3. After the drop (`web/src/ui/drop-dialog.ts`, prefix `fd-`)

One dialog per drop, created on open / removed on close (`picker.ts` idiom),
`.modal-scrim fd-scrim` + `.fd-modal[role=dialog][aria-modal=true]`,
`trapTab`. Three states in one card:
- **Conflicts** (only when any): `README.md already exists in src` /
  `3 items already exist in src`; buttons `Replace` · `Keep both` · `Skip`;
  `Keep both` names like Explorer (`report (2).md`, incrementing). Esc and
  `×` = `Skip` (one decision per drop, the non-destructive one; cancelling
  the whole drop would throw away the non-conflicting items too).
- **Copying**: `Copying 3 items into src`, one row per top-level item with
  `Copied` / `Skipped` / `Failed` (+ note `larger than the copy limit`),
  progress `2 of 3`; mock stagger 60 ms per item via `setTimeout`.
- **Result**: `Copied 2 files into src. 1 skipped.` + `Close`.
Honesty line in the copying AND result states, from ONE call site marked
`// PLACEHOLDER MARKER — DELETE WITH THE MOCK (B10)`: `Nothing is copied yet.
This is what the copy will look like until the app can write files.`
Mock conflict = a top-level name present in the destination's listing from
`buildTree(MOCK_FILES)` (dropping `README.md` or `web` on the root shows the
dialog — the demo path). Esc ladder in `main.ts`: after the folder picker,
before the new-project dialog.

## 4. Keyboard/button twin

`Copy files here…` in the Files-panel header (a folder row is a `<button>`
and cannot nest one), acting on `pasteDestination()`, its `title` naming the
live destination (`Copy files into src`). Native chooser = plain Chromium
file chooser, not a `PermissionRequested` kind. Shortcuts overlay gains one
gesture row: drag files from Explorer onto a folder or a pane → copy them
into that folder; twin = the header button, or paste with files on the
clipboard.

## 5. Model (`web/src/ui/drop-model.ts`, DOM-free, Phase 0)

No `state.ts` change, no new notify kind (drag visuals go straight to the
DOM like `dnd.ts`; the dialog owns its state). Frozen signatures:

```ts
export const MAX_ITEM_BYTES = 50 * 1024 * 1024;
export const MAX_ITEMS = 200;
export interface DropItem { name: string; dir: boolean; bytes: number | null }
export type Choice = 'replace' | 'keep-both' | 'skip';
export type Outcome = 'copied' | 'skipped' | 'failed';
export interface ItemResult { name: string; state: Outcome; note?: string }
export function hasFiles(types: readonly string[]): boolean;
export function dragCountText(n: number): string;        // '1 item' | '3 items'
export function itemsText(items: DropItem[]): string;    // '2 files and 1 folder'
export function destLine(n: number, dest: string): string; // 'Copy 3 items into src'
export const DROP_HINT: string;                          // 'Drop on a folder or a pane.'
export function conflictsOf(items: DropItem[], listing: readonly string[]): string[];
export function conflictTitle(conflicts: string[], dest: string): string;
export function keepBothName(name: string, taken: readonly string[]): string;
export function planResults(items: DropItem[], listing: readonly string[], choice: Choice): ItemResult[];
export function progressText(done: number, total: number, dest: string): string;
export function resultText(results: ItemResult[], dest: string): string;
export function tooMany(n: number): boolean;
```

## 6. Phases

- **Phase 0** (alone): `drop-model.ts` + `tests/ui-drop-model.test.ts`.
- **Brief 1 — dialog**: `drop-dialog.ts`, `main.ts` ESC-LADDER region + one
  import, `app.css` ONE new `fd-` section; tests `ui-a9-drop.test.ts` (class
  parity, tokens-only, no colour literal, both states carry the honesty line,
  Esc/× = Skip, focus trap + return).
- **Brief 2 — targets/ghost/paste/twin**: `filedrop.ts`, `files.ts` (header
  button; folder rows already carry `data-k="fdir:<path>"`), `keys.ts`
  (+`OPEN_MODAL_SELECTOR`), `dnd.ts` (+`isDragging()` only),
  `shortcuts.ts` (one row), `main.ts` INIT region (one `initFileDrop` line),
  `app.css` drag-state rules only, `tests/fake-dom.ts` (`dataTransfer` /
  `clipboardData` / `relatedTarget` on events, `makeDataTransfer` helper,
  settable `innerWidth/innerHeight`; the picker is tested through an injected
  `openPicker` seam). Tests: `ui-filedrop.test.ts`.
- Overlap: `main.ts` (two regions by comment header) and `app.css` (two
  sections by block header). Same contract as A10.

## 7. Risks → verify

No line of the fit → ws resize seam, `TerminalView`, the allowlist, or
`state.ts` changes. verify-terminal after A9: (a) drag a file over a focused
terminal running `cat -v` and drop it — nothing printed, page did not
navigate; (b) terminal focused, Ctrl+V with files on the Windows clipboard —
app does nothing, PTY gets the plain Ctrl+V byte as before (Windows-only
check for the user); (c) a drag must not change any pane's cols/rows
(server.log shows no `resize` during a drag).
