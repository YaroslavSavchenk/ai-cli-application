# A9b — Select a folder, paste files into it, and a row context menu (mock transport)

Status: DECIDED 2026-09-16 (user); Phase 0 started 2026-09-16. Part A9b of
`PLAN-NOCTURNE.md`, extending `.claude/PLAN-A9.md` (the drop half) and standing
on the same mock transport until B10 (real upload endpoint, host clipboard,
security review). Written by the orchestrator from the Plan agent's design;
line numbers drift — this file names functions and regions, never lines.

## User decisions (fixed)

1. SELECTION: one click on a folder row selects it AND toggles it open/closed
   exactly as today. The selection stays visible after the focus leaves the
   panel (into a terminal), until another row is chosen or Escape is pressed
   inside the panel. The copy strip names the selected folder. Single
   selection only.
2. PASTE: when the clipboard carries FILES and a folder is selected, Ctrl+V /
   Ctrl+Shift+V copies into that folder from ANYWHERE, a focused terminal
   included (files carry no text, so the terminal loses nothing). A TEXT paste
   in a terminal is untouched. With no selection the destination stays the A9
   rule (the folder row that last held the keyboard, else the panel root, else
   the active tab's root) and the A9 guard stands: inside a terminal or an
   editable, no selection means the app does nothing.
3. CONTEXT MENU, a new Nocturne primitive: folder row = `Open` / `Close`
   (whichever applies), `Copy`, `Paste`, `Copy files here…`; file row =
   `Open`, `Open beside`, `Copy`. `Copy` and `Paste` are visible but DISABLED
   with a plain one-line explanation until B10 — a page cannot read files from
   the operating system's clipboard except inside a paste event, and cannot
   put files on it; the Windows host does both in B10. No file operations (new
   folder, rename, delete) — not asked.
4. Orchestrator defaults: see the last section (adopted 2026-09-16 by the
   orchestrator; the user has not confirmed them one by one).

## Facts checked (Plan agent, 2026-09-16)

- **Nothing in `web/src` handles a right-click.** No `contextmenu` listener, no
  `auxclick`, no `button === 2` anywhere; `launcher/host/AiSessionManagerHost.cs`
  sets no context-menu option, so the WebView2 default (menus on) stands. Today
  a right-click anywhere in the app opens the SYSTEM menu.
- **Inside a terminal that system menu is xterm's own arrangement.** The bundled
  `@xterm/xterm` registers a `contextmenu` listener on its element which calls
  `rightClickHandler` → `moveTextAreaUnderMouseCursor` + `textarea.value =
  selectionText; textarea.select()`, and it does NOT call `preventDefault()`. So
  the system menu opens and its Copy/Paste act on the terminal's selection.
  A9b must leave every byte of this alone.
- **Only plain Ctrl+V produces a `paste` event inside a terminal.**
  `TerminalView`'s `attachCustomKeyEventHandler` (`ui/terminal.ts`) matches
  `isPasteChord` (ctrl+shift+v, shift+insert) FIRST, calls `preventDefault()`
  and serves the paste itself through `navigator.clipboard.readText()` — which
  can never see a file list. Plain Ctrl+V is deliberately not intercepted, so
  the browser's own paste fires on xterm's helper textarea and the window
  listener in `ui/filedrop.ts` (`onPaste`, CAPTURE) sees it. This is a KNOWN
  LIMIT of decision 2 inside a terminal; §2 states it and §7 verifies it.
- `filedrop.ts` `onPaste` today: acts only when `clipboardData.files.length > 0
  && !isTerminalTarget(target) && !isEditableTarget(target) && !modalOpen()`,
  then `preventDefault()` + `offer()`. It does NOT `stopPropagation()`, so
  xterm's own textarea paste handler still runs after it — harmless while the
  app never acts inside a terminal, load-bearing the moment it does (§2).
- `files.ts` `initFilesPanel()` keeps `openFolders` as instance state, not in
  `state.ts`; `sig()` gates the rebuild and `rebuild()` re-creates every row and
  restores the keyboard by `data-k`. There is no selection concept today.
- `files.ts` `pasteDestination()` / `focusedFolderName()` / `noteFocus()`: the
  destination is a MEMORY of the folder row that last held the keyboard inside
  the panel, cleared when focus leaves it or when the row is rebuilt away;
  `syncCopyTitle()` refreshes the strip button's `title` on every document
  `focusin` and in `rebuild()`. The strip's visible label is the constant
  `COPY_LABEL`, so the destination is today invisible.
- `ui/launch.ts`'s permissions popover is the closest existing idiom: `setHelp()`
  opens/closes, a WINDOW CAPTURE `keydown` takes Escape only while it is open and
  `stopPropagation()`s it so `main.ts`'s ladder never sees that key, a DOCUMENT
  CAPTURE `pointerdown` closes it on a press outside the popover and its button,
  and a `focusin` outside closes it too. `ui/picker.ts` is the create-on-open /
  remove-on-close idiom, one at a time, focus restored to `restoreTo` when it is
  still `isConnected`.
- `main.ts`'s Escape ladder is a window BUBBLE listener guarded by
  `!fromTerminal(e.target)`; its last two arms are the drawer and the Files
  panel (`filesAside.contains(document.activeElement)` → `toggleLeftPanel`).
  `tests/ui-files-panel.test.ts` bounds that whole branch under 4000 characters.
  A `keydown` listener on `.files-view` runs (bubble phase) before it, which is
  how A9b spends Escape on the selection without touching the ladder.
- `app.css`: `.files-row:hover` and `.files-row.is-open` (A10) are BOTH
  `--color-neutral-900`; `.files-row.is-dir.is-drop` (A9) is a dashed accent
  outline plus a `--color-accent-900` ground; the base focus ring is
  `outline: var(--tick) solid var(--color-accent); outline-offset: 1px`;
  `.files-row.is-busy` is `animation: pulse` (opacity 1 → .3). A selected state
  therefore cannot be a neutral-900 ground and cannot be an outline.
- `tokens.css` z-scale: toast 46, modal 50, modal-top 51, overlay 60, ghost 70.
  There is no menu layer.
- `tests/fake-dom.ts` dispatches with a real capture → target → bubble order and
  `stopPropagation`, hit-tests `elementFromPoint` from rects a test sets, has
  settable `innerWidth`/`innerHeight`, a real `activeElement`/`focus()`, and
  records timers instead of firing them. It measures nothing: `getBoundingClientRect`
  answers only the rect a test set. So all menu geometry must be a pure function.
- The app's selected-state class is already `is-sel` (`.ns-card.is-sel`,
  `.sg-tab.is-sel`), and its grammar is "accent edge plus full ink".

## 1. Selection (`web/src/ui/files.ts`)

Module-instance state beside `openFolders`, keyed by PATH: `let selected: string
| null`. NOT in `state.ts` — it is not server state, it is not persisted (the
tree itself is still `ui/files-mock.ts`), and no module outside the panel renders
it. `state.ts` and the localStorage schema do not change by one line.

- A folder row ACTIVATION selects it and toggles it open/closed, in that order.
  The row is a `<button>`, so Enter and Space are the same activation — the
  gesture has its keyboard twin for free. A file row never selects.
- The selection is part of `sig()`, so a change repaints the tree; `rebuild()`
  sets `is-sel` from the path, which is why the selection survives every
  rebuild, every folder toggle, every subject change and every tab switch. A
  selected folder whose ANCESTOR is collapsed keeps its selection: the path is
  still a real folder and the copy strip keeps naming it out loud.
- Cleared by: another folder row, Escape inside the panel, and the panel leaving
  the screen (`filesPanelVisible()` false — a destination nobody can see must
  not silently take a paste from a terminal).
- Escape is owned HERE, not in `main.ts`: a `keydown` listener on the panel root
  clears the selection and `stopPropagation()`s the key, exactly as the row-level
  ctrl+alt+c and ctrl+alt+enter chords already do. With nothing selected it does
  not stop, so the second Escape closes the panel through the ladder as today.
  The ladder in `main.ts` is untouched.
- `pasteDestination()` gains one rung at the TOP: the selected folder's name,
  then today's chain (last focused folder row → panel root → active tab's root).
  `selectedFolder(): string | null` is exported for the drop layer.
- The copy strip says which one it means: `copyStripLabel()` renders
  `Copy files here…` with nothing selected and `Copy files into src…` with a
  selection, and the `title` keeps the full `Copy files into src` sentence. One
  wording for both, and for the drag ghost: `copyIntoText()` MOVES from
  `filedrop.ts` into the new DOM-free model and is re-exported from `filedrop.ts`
  for its existing readers.
- Visual recipe (Nocturne "Color roles": the accent is an outline and a small
  mark, never a fill): ground `--color-accent-900`, a `--tick` accent mark on the
  leading edge as `box-shadow: inset`, name ink `--color-text`. No border, no
  padding, no size change — a selected row must not move the tree by a pixel
  (the A9 rule: a width change fires every pane's ResizeObserver).
- PRECEDENCE when states coincide on one row: the focus ring (solid accent
  outline) and the drop highlight (dashed accent outline) are the same CSS
  property, and the drop rule wins while a drag is in flight — during an
  operating-system drag the pointer is the subject, not the caret. Selection is a
  ground plus an inset mark, so it stays visible under BOTH. `is-open` (A10) and
  hover are neutral grounds and lose to the selected ground. The busy pulse is an
  opacity animation and keeps running over all of them.

## 2. Paste rule (`web/src/ui/filedrop.ts` `onPaste`)

The app never listens for a CHORD here; it listens for the `paste` EVENT, and
takes whichever keystroke the browser turned into one. The predicate, pure and
frozen in the model:

```
takesPaste = files && !modalOpen && ( (!inTerminal && !inEditable) || selected )
```

- Text-only clipboard: `files` is false, so never — a terminal's paste and a
  field's paste stay entirely their own, whatever else is on the clipboard.
- Files + a selected folder: taken even when the target is a terminal or an
  editable, and the destination is the selected folder (which `pasteDestination()`
  already answers first).
- Files + no selection: the A9 rule exactly — outside terminals and editables the
  fallback chain answers; inside one, nothing happens at all.
- A modal up keeps its A9 meaning: nothing in the window takes a paste.

When the app takes a paste inside a TERMINAL it must call `preventDefault()` AND
`stopPropagation()` on the capture phase. `preventDefault` alone leaves xterm's
own textarea `paste` handler to run; an Explorer clipboard that happens to carry
`text/plain` beside its files would then type that text into the PTY unbracketed
— the very accident A9 decision 5 exists to prevent. Focus is not moved: the
dialog's `returnFocus` is `document.activeElement` at paste time, so the terminal
gets the keyboard back when the card closes, through the machinery A9 already has.

KNOWN LIMIT, stated rather than papered over: inside a focused terminal only
plain Ctrl+V can carry files, because `ui/terminal.ts` takes Ctrl+Shift+V and
Shift+Insert itself and serves them from `navigator.clipboard.readText()`, which
cannot see a file list. `ui/terminal.ts` is NOT touched by A9b (terminal seam);
the shortcuts overlay says the limit in plain words.

`FileDropDeps` gains one member, `selectedFolder(): string | null`, wired in
`main.ts`'s INIT region beside the other six.

## 3. Context menu primitive (`web/src/ui/context-menu.ts`, new, prefix `cm-`)

One menu at a time, created on open and removed on close (`picker.ts` idiom),
appended to `document.body` and `position: fixed` — the drag ghost's precedent,
and the only mount that changes no layout anywhere. It is NOT a modal: no scrim,
no `.modal-scrim` (which would make `keys.ts` call it a focus owner and kill pane
drops), no `aria-modal`, no tab trap.

- Anatomy: `.cm-menu[role=menu][aria-label="actions for src"]` holding
  `.cm-item[role=menuitem]` buttons; a disabled entry is `aria-disabled="true"`
  (never the `disabled` attribute — it must stay reachable, because the one-line
  explanation under its label is the whole point) and carries `.cm-sub` with that
  sentence. No separator element, no icons, no counts.
- Look: the `ns-help` popover grammar — `--color-bg` ground, `--radius-md`,
  `--shadow-md`, `fadeUp .14s` with a `prefers-reduced-motion` opt-out; rows at
  `--files-row-h` with the `--color-neutral-900` hover; disabled ink
  `--color-neutral-700`, the sub-line `--color-neutral-600`; the base focus ring.
  Tokens only, no colour literal. New token `--z-menu: 47` — above the toast (a
  menu the user just opened may not be covered) and below every modal.
- Position: opened at the pointer for a right-click, at the focused row's leading
  edge and bottom for the keyboard. The geometry is the pure `menuPosition(at,
  size, viewport)` — flip before clamping (a menu near the right edge opens
  leftward, near the bottom upward), then clamp to a `MENU_MARGIN` inset so it is
  always whole. The flip threshold counts the margin too (`at.x + size.w >
  vp.w - MENU_MARGIN`), otherwise an 8 px band near the edge slides instead
  of flipping (scope review, Phase 0). The DOM module measures once after append and applies the point.
- Keyboard: roving focus, first item focused on open, `ArrowDown`/`ArrowUp` wrap,
  `Home`/`End`, `Enter`/`Space` activate, `Escape` closes and returns the
  keyboard to the row it came from. Disabled entries ARE reachable by the arrows
  and do nothing when activated. No type-ahead.
- Closes on: a choice, `Escape` (a WINDOW CAPTURE keydown that `stopPropagation()`s
  it, so `main.ts`'s ladder never sees that key — the `launch.ts` idiom), a
  DOCUMENT CAPTURE `pointerdown` outside the menu, `focusin` outside it, `scroll`
  in capture (the tree body scrolls), window `resize`, window `blur` (the user
  went to Explorer), and ANY rebuild of the panel — `rebuild()` calls
  `closeRowMenu()` first, because the menu is anchored to a row that is about to
  be replaced. The SELECTION survives that rebuild; the menu never does.

## 4. Row wiring (`web/src/ui/files.ts`)

- ONE delegated `contextmenu` listener on the panel root, not one per row (rows
  are rebuilt wholesale). It acts only when the event lands inside a
  `.files-row`: `preventDefault()` (so the system menu does not open over ours)
  and open the menu at the event point. Anywhere else in the panel, and
  everywhere else in the app — a terminal, the pane chrome, the tab strip, the
  statusline, the drawers, every dialog — the event is not touched and the system
  menu opens exactly as it does today.
- A right-click on a FOLDER row selects it (Explorer's behaviour) and does NOT
  toggle it open or closed: the toggle belongs to the primary click, and the menu
  offers `Open` / `Close` as a named entry. A right-click on a file row selects
  nothing.
- Keyboard twin on the focused row: the `ContextMenu` key and Shift+F10, matched
  by the new `isContextMenuChord()` in `ui/keys.ts` (same guards as the existing
  chord predicates: no alt, no meta, `getModifierState('AltGraph')` rejected),
  handled on the ROW with `preventDefault()` + `stopPropagation()` — the same
  ownership rule ctrl+alt+enter and ctrl+alt+c already follow, which is what keeps
  a focused terminal's own keys untouched.
- Actions map to what already exists: `Open`/`Close` = the row's own toggle;
  `Open` on a file = `st.openFile(currentRoot(), path, name)`; `Open beside` =
  the existing `openBeside()` (so it refuses through the one shared mapping in
  `dnd.ts`); `Copy files here…` = `openCopyFilesPicker(name)`; `Copy` and `Paste`
  are inert and carry their sentence.
- `shortcuts.ts` gains the new gestures, each naming its twin: click a folder row
  → select it and open or close it (twin: enter on the focused row); right-click
  a row in the Files panel → its actions (twin: the menu key or shift+f10); paste
  with files on the clipboard → copy them into the selected folder (note: inside
  a terminal that is plain ctrl+v; the other paste keys stay the terminal's). The
  overlay's closing sentence ("the paste and copy chords above are the only other
  keys the app takes") and its doc comment about the two rows that carry notes
  both need amending in the same edit.

## 5. Model (DOM-free, Phase 0)

No `state.ts` change, no new notify kind, no schema bump.

```ts
// web/src/ui/files-select-model.ts
export type Selection = string | null;                       // a folder PATH, never a name
export const COPY_LABEL = 'Copy files here…';
export function afterRowActivate(sel: Selection, path: string): Selection;
export function afterMenuOpen(sel: Selection, row: { dir: boolean; path: string }): Selection;
export function afterEscape(sel: Selection): Selection;
export function afterPanelHidden(sel: Selection): Selection;
export function selectedName(sel: Selection): string | null; // last path segment
export function copyIntoText(dest: string): string;          // 'Copy files into src' (moved from filedrop.ts)
export function copyStripLabel(sel: Selection): string;      // COPY_LABEL | 'Copy files into src…'
export interface PasteContext {
  files: boolean; selected: boolean; inTerminal: boolean; inEditable: boolean; modalOpen: boolean;
}
export function takesPaste(ctx: PasteContext): boolean;
```

```ts
// web/src/ui/context-menu-model.ts
export type MenuAction = 'toggle' | 'open' | 'open-beside' | 'copy' | 'paste' | 'copy-files';
export interface MenuItem { action: MenuAction; label: string; enabled: boolean; note?: string }
export interface RowSubject { dir: boolean; name: string; open: boolean }
export const COPY_NOTE: string;   // 'The app cannot put files on the clipboard yet.'
export const PASTE_NOTE: string;  // 'The menu cannot read the clipboard. Paste with the keyboard instead.'
export const MENU_MARGIN: number;
export function itemsFor(row: RowSubject): MenuItem[];
export function menuLabel(row: RowSubject): string;          // 'actions for src'
export function menuPosition(
  at: { x: number; y: number },
  size: { w: number; h: number },
  vp: { w: number; h: number },
): { x: number; y: number };
export function nextItem(count: number, from: number, step: number): number; // wrapping
```

```ts
// web/src/ui/keys.ts (addition)
export function isContextMenuChord(e: KeyChord): boolean;    // ContextMenu, or shift+F10; ctrl/alt/meta/AltGr all rejected (stricter than §4's list on purpose, house style of isPasteChord — accepted 2026-09-16)

// web/src/ui/context-menu.ts (Brief 2, DOM)
export interface RowMenuRequest {
  items: readonly MenuItem[];
  at: { x: number; y: number };
  label: string;
  returnFocus: HTMLElement | null;
  onChoose(action: MenuAction): void;
}
export function openRowMenu(req: RowMenuRequest): void;
export function closeRowMenu(): void;
export function isRowMenuOpen(): boolean;

// web/src/ui/files.ts (addition)
export function selectedFolder(): string | null;             // the SELECTED folder's name

// web/src/ui/filedrop.ts (FileDropDeps addition)
selectedFolder(): string | null;
```

## 6. Phases

- **Phase 0** (alone): `files-select-model.ts`, `context-menu-model.ts`,
  `keys.ts` (+`isContextMenuChord` only), the `copyIntoText` move with its
  re-export; tests `tests/ui-files-select-model.test.ts`,
  `tests/ui-context-menu-model.test.ts`, `tests/ui-keys.test.ts` (+the chord).
  No DOM, no CSS.
- **Brief 1 — selection, paste rule, strip, shortcuts**: `files.ts` SELECTION
  region (the state, `sig()`, `rebuild()`, the panel-root Escape listener,
  `pasteDestination()`, `selectedFolder()`, the strip label), `filedrop.ts`
  (`onPaste` predicate + `stopPropagation` + the new dep + the `copyIntoText`
  re-export), `main.ts` INIT region (one dep line), `shortcuts.ts` (three rows
  and the two sentences they change), `app.css` "Files panel" section only
  (`.files-row.is-sel`). Tests: `tests/ui-filedrop.test.ts` (the paste matrix,
  the stopPropagation, the wiring assertion) and NEW
  `tests/ui-files-select.test.ts`.
- **Brief 2 — the menu primitive and the rows**: NEW `context-menu.ts`,
  `files.ts` ROW MENU region (the delegated `contextmenu`, the row chord, the
  action map, `closeRowMenu()` at the top of `rebuild()`), `tokens.css`
  (+`--z-menu`), `app.css` ONE new `cm-` section at the end. Tests: NEW
  `tests/ui-context-menu.test.ts`.
- SEQUENCE, not parallel: both briefs edit `fileRows()` and both read the
  selection, so Brief 2 starts when Brief 1 has landed. Overlap contract for the
  files both touch: `files.ts` by NAMED REGION (`// ---- selection ----` and
  `// ---- the row menu ----`, block headers, never lines) and `app.css` by
  SECTION (Brief 1 stays inside "Files panel", Brief 2 adds one new section and
  touches no other).

Tests to write, by claim:
- paste matrix: files × selection × terminal × editable × modal, both that the
  app acts and that it does not; a text-only paste in a terminal is never ours; a
  taken paste inside a terminal stops propagating; the dialog gets the selected
  folder and hands the keyboard back to where the paste came from.
- selection: a click selects and toggles; Enter on a focused row does the same;
  the selection survives a rebuild, a folder toggle, a subject change and a tab
  switch; Escape inside the panel clears it WITHOUT closing the panel and the
  second Escape closes it; hiding the panel clears it; the strip label and title
  follow; `pasteDestination()` puts the selection first; class parity for
  `is-sel`.
- context menu: `cm-` class parity (no class without a rule, no rule without a
  setter), tokens only, no colour literal; opens on a right-click of a row and on
  NOTHING else (a right-click on the panel background, a pane, a terminal, the
  tab strip and the statusline is not even `preventDefault`ed); opens from the
  keyboard on the focused row and from no other key (AltGr and the ctrl variants
  are left alone); roving focus, arrows/Home/End wrap, Enter activates, Escape
  closes and returns focus; outside press, focus leaving, scroll, resize, blur
  and a panel rebuild each close it; disabled entries are `aria-disabled`, carry
  their sentence, and activating one does nothing; `menuPosition` flips and
  clamps at all four edges; a repo-wide scan that `files.ts` is the ONLY module
  in `web/src` registering a `contextmenu` listener (the mirror of A9's
  no-`dragstart` pin).

## 7. Risks → verify

No line of the fit → ws resize seam, `TerminalView`, the ctrl+alt allowlist or
`state.ts` changes. `/verify-terminal` after A9b, with:

1. a TEXT paste into a focused terminal still reaches the PTY unchanged and
   bracketed (both the browser's own ctrl+v and the ctrl+shift+v chord);
2. a FILES paste (plain ctrl+v) while a terminal is focused with a folder
   selected: the A9 dialog opens, `server.log` shows NO input bytes for that
   session — not even a ^V: xterm hands plain ctrl+v to the browser as a
   paste and writes no byte of its own (Brief 1 measured the no-selection
   case as 12 bytes = an empty bracketed paste, no 0x16; the final gate
   measures the taken case explicitly, scope review Brief 1) — and the
   terminal has the keyboard again once the card closes;
3. a FILES paste with a terminal focused and NO selection: nothing at all
   happens, and the PTY still receives the plain ctrl+v byte exactly as before;
4. `server.log` shows no `resize` line while the menu opens, flips near an edge
   and closes, and none when a row is selected or cleared;
5. a right-click INSIDE a terminal still opens the system menu and its Copy and
   Paste still act on the terminal's selection (xterm's `rightClickHandler` path,
   untouched); the same on the pane chrome, the tab strip and the statusline;
6. the menu key and shift+F10 inside a terminal are still the terminal's;
7. Windows, owed to the user in their own window: Ctrl+C on files in Explorer,
   then a click on a folder row in the app and Ctrl+V with a terminal focused;
   and the look of the menu and the selected row in the WebView2 host.

Unverified by the Plan agent (needs a real browser / the user's window):
whether Chromium fires a `paste` event for Ctrl+Shift+V outside an editable
(the spec listens for the event, not the chord, so it stays honest either way);
whether an Explorer file copy puts `text/plain` beside the file list (the
`stopPropagation()` guard is cheap and correct regardless); whether the fake DOM
needs a one-line `contextmenu` addition (Brief 2 checks).

## Orchestrator defaults (adopted 2026-09-16, not confirmed one by one)

- **The selection wins over the focus memory** for the paste destination and the
  strip, always. It is the only one of the two that says out loud where files
  will land. The ctrl+alt+c row chord keeps acting on the row it is pressed on.
- **A hidden panel clears the selection.** A destination nobody can see must not
  silently accept a paste from a terminal.
- **A collapsed ancestor does not clear it**: the copy strip keeps naming the
  folder, so the destination is never invisible.
- **A right-click selects a folder row and does not toggle it.**
- **Disabled menu entries stay arrow-reachable** (`aria-disabled`, not
  `disabled`), because their one-line explanation is the reason they exist.
- **No separator, no icons, no counts in the menu**; four entries and three
  entries are short enough to read as a list.
- **`ui/terminal.ts` is not touched**, so Ctrl+Shift+V and Shift+Insert inside a
  terminal keep their text-only meaning; the overlay says so. Closing that gap
  would mean letting the browser's own paste-as-plain-text through, which is a
  terminal-seam change and belongs with B10 if it is wanted at all.
- **The paste-from-anywhere rule needs a SELECTION**; the panel-root fallback
  keeps the A9 scope (outside terminals and editables only). The user's wording
  ties the new reach to a chosen folder, and a terminal quietly losing a paste
  to a folder nobody pointed at would be the opposite of "it must always be
  obvious where it lands".
- **`--z-menu: 47`** — above the toast, below every modal.
- **Escape lives in `files.ts`**, not as a new rung in `main.ts`'s ladder: the
  key is spent on a surface-local state, exactly as the row chords are, and the
  ladder's length bound in `tests/ui-files-panel.test.ts` stays intact.
