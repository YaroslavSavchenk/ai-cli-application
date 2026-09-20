# A10b — Editor pane with file tabs: implementation spec

Status: LANDED 2026-09-15 (log `2026-09-15-nocturne-a10b`); earlier: DECIDED 2026-09-15 (user's correction on the A10 Windows check,
confirmed with a mockup); Phases 0/1A/1B landed 2026-09-15 (parked once on
`wip/a10b` for a usage limit, resumed the same night); review + fix cycle
done; verify-terminal in progress. Part
A10b of `PLAN-NOCTURNE.md`. Written by the orchestrator from the Plan agent's
design; line numbers drift — cite by function name, verify by reading.

## User decisions (fixed)

1. Files must NOT each become their own pane. ONE editor pane per group with an
   inner file-tab strip (file tabs + read-only diff tabs, dirty dot, `×`), like
   the A6 editor column had. Clicking a Files row ADDS a tab to the focused
   editor pane of the root's folder tab (creates the pane when there is none;
   RAISES the tab when the path is already open anywhere in that view; a
   focused terminal slot sends the tab to the view's first editor pane).
2. A split appears only when a file tab is dragged to a pane's edge (a new
   editor pane holding that tab) — or by the keyboard twin. A file tab dragged
   onto another editor pane MOVES there. Terminal panes stay mixable beside
   editor panes (1/2/4 as now). `Home` tab and all A10 decisions stand.
3. Closing the last tab of an editor pane closes the pane (existing `closeSlot`
   ladder: project tab closes when empty, Home stays).
4. Orchestrator defaults: a file tab dragged onto the BOTTOM strip or reordered
   within its own strip = not built (each would need its own chord; record as
   the first things to add if asked); a Files row dropped on an editor pane's
   centre ADDS a tab (never replaces); on a terminal centre still refused with
   `A terminal pane cannot hold files. Drop on an edge to split.`; chords:
   ctrl+alt+PageUp/PageDown (unshifted) = previous/next tab in the focused
   editor pane (`[`/`]` are AltGr on NL/BE/DE layouts — unreachable here),
   ctrl+alt+m = move the active tab to the next editor pane of the view, or
   into a new split beside the focused pane when there is none; ctrl+alt+w
   closes the ACTIVE TAB (last tab closes the pane); ctrl+alt+enter unchanged
   (Files row → split). The count pill keeps counting PANES.

## 1. Model (Phase 0: `state.ts`, `slots-model.ts`, `editor-model.ts`)

```ts
export type EditorTab =
  | { kind: 'file'; path: string }
  | { kind: 'diff'; hash: string; path: string };
export type PaneSlot =
  | { kind: 'session'; id: string }
  | { kind: 'editor'; id: string; tabs: EditorTab[]; active: number }; // REPLACES file/diff
```
- `file`/`diff` slot kinds are REPLACED, not kept (two representations of "a
  file on screen" = the alias-layer trap; the user's bug is exactly the door a
  surviving `file` kind leaves open). `tabs` never empty while the slot lives;
  `0 <= active < tabs.length`.
- `editor-model.ts` adds `tabIdOf(t)` = `fileTabId(path)` / `diffTabId(hash,path)`
  (the `state.edits` key contract, one spelling). `slotKey` for an editor slot
  returns the slot's OWN generated id `e:<n>` (`newEditorSlot(tabs)`) — a key
  derived from the active tab would make every tab add/close/switch look like a
  different pane (teardown, caret lost, focus stolen). TAB ID ≠ SLOT KEY: say
  it in the doc comment.
- Functions: `openFile(root, path, label)` keeps its signature, semantics =
  raise-if-open-anywhere-in-the-view, else add to the target editor pane
  (focused editor → first editor → new pane via `insertSlots(v, 0, 'fill', …)`
  when there is room, else `'full'`); `openDiff` the same with a diff tab;
  `openTabAt(viewId, slot, where: Zone | 'replace', tab)` REPLACES `openFileAt`
  (`'replace'` on an editor slot = add + raise, on a session slot =
  `'session-centre'`; zones as before); `moveTab(viewId, fromSlot, tabIndex,
  toSlot)` (raise-not-duplicate when the target holds the id; an emptied source
  pane is removed — capture the target's `slotKey` BEFORE `removeAtSlot`, the
  2×2 remap moves indices); `moveTabToSplit(viewId, fromSlot, tabIndex, atSlot,
  zone)` (`'full'` only when the source keeps other tabs — a pane whose last tab
  leaves frees its own pane; hold slot KEYS across every mutation, never
  indices); `closeTab(viewId, slot, tabIndex)` (active clamps to
  `min(active, len-1)`; last tab → `closeSlot`); `closeActiveTab`,
  `setActiveTab`, `cycleTab(dir)`, `activeTabOf`, `slotTabIds`.
  `pruneOrphanEdits()` walks tabs and runs ONCE at the END of every mover
  (never midway — a tab in transit is on no pane). `closeSlot` unchanged
  (closes a pane with all its tabs; still refuses session slots).
- Unchanged and kind-blind: `insertSlots`, `removeAtSlot`, `dropZonesFor`,
  `swapPanes`, `movePane`, `neighbors`, `mergeViews`, `reconcileViews`,
  `viewStatus`, `ensureHomeView`, persistence (editor slots still never
  written or read; `// B4:` marker stays), `state.edits`.
- `slots-model.ts`: `slotTitle` for an editor slot = the ACTIVE tab's title via
  new `tabTitle(t)` (`fileName(path)` / `Changes in <hash>`); `viewLabel`,
  `zoneForPoint` unchanged (only what `'replace'` DOES changed).

## 2. Pane + strip (Phase 1A: `panes.ts`, NEW `ui/editor-pane.ts`, `tabs.ts`)

- NEW `web/src/ui/editor-pane.ts` (node-safe: imports state/util/dnd/
  slots-model/editor-model/file-pane only, NEVER `panes.ts`):
  `editorPane(hd, body) → { update(slot, viewId, slotIndex), focus(),
  holdsFocus(), dispose() }`. Owns the strip DOM in the header, a
  `Map<tabId, PaneBody>` of DETACHED bodies (textarea value/selection survive
  detachment → caret survives a tab round-trip; GC entries whose tab is gone;
  `dispose()` clears the Map or a pane converted back resurrects stale
  textareas), and a `sig` = tab ids + active + dirty bits: unchanged sig → only
  `bodies.get(active).update()` (a keystroke costs nothing else); body swap
  ONLY when the active id changed. `focus()` = the textarea, or the chip for a
  diff tab.
- Strip DOM (NOT the A6 `.editor-*` names — `ui-a6-screens` pins their
  absence): `.pane-tabs[role=group][aria-label="open files"]` (flex,
  `min-width:0`, `overflow-x:auto`) > `.pane-tab[.is-on]` (drag source) >
  `button.pane-tab-pick` (label, `aria-pressed`) + reused `.pane-dirty` +
  sr-only + reused `button.pane-x` (`Close <label>`, stopPropagation, never
  raises); after the strip the reused `.pane-gap` = the PANE's own grab area,
  then the pane `×` (`Close this pane and its N files`; twin = ctrl+alt+w until
  empty). Chip height literal `26px` (no new token — the 144-token pin). New
  CSS section `/* ---- editor pane tabs (Nocturne A10b) ----` INSERTED after
  the `pane header (38px)` block, never appended at EOF (A9's `fd-` block
  lives there).
- `panes.ts`: `FilePayload`+`DiffPayload` → one `EditorPayload {kind:'editor',
  id, pane}`; `buildFilePane`/`buildDiffPane` → `buildEditorPane`;
  `updateFileHeader` deleted; `reconcileSlot` same key + editor → `pane.update`
  (the branch that makes a tab add cheap), different key → teardown + build;
  `teardown` editor → `pane.dispose()` before emptying, session branch
  UNTOUCHED (dispose THEN replaceChildren, pinned); `requestTerminalFocus`
  editor → `pane.focus()`; `focusedPaneDims` code unchanged (doc only; ladder
  ORDER stays pinned); `applyFocus` key gains the ACTIVE TAB id (a tab switch
  re-hands the keyboard, a keystroke does not) and bails when
  `pane.holdsFocus()` (arrowing across chips is not thrown into the textarea);
  the header `armDrag(hd, 'button', …)` STAYS: chips and × are buttons so the
  pane drag bails on them and the chip's own inner `armDrag` fires first — pin
  both; `makeSpec` label = `slotTitle`; rebuild key stays `(view id, count,
  l3)` — tab ids in it would re-attach every terminal on a tab switch;
  `gridHidden()` first in `render()` untouched.
- `tabs.ts`: `viewDirty` over tabs; chip label follows the active tab through
  `slotTitle`; count pill counts panes.
- `commit-view.ts` / `files.ts` row click: calls unchanged, now add-tab.

## 3. Drag (Phase 1B: `dnd.ts`, `files.ts` four spots, `main.ts` keydown,
`terminal.ts` allowlist, `shortcuts.ts`)

- `DragSpec` += `{kind:'filetab', viewId, slot, slotKey, tab, tabId, label}`
  (stale spec → resolves to nothing). `resolve()`: pane edge (any pane kind) →
  `open-tab-split{slot, zone, ok}` (`ok=false` when the zone is not offered or
  full while the source keeps other tabs); centre of ANOTHER editor pane →
  `move-tab{slot}` (whole-pane box via `showPaneDrop(slot, '', 'Move it here')`
  — `delete dataset.zone`, the same shape A9's filedrop uses); centre of a
  session pane → `reject-session` (invalid ghost, flash on release); own pane,
  bottom strip, tab chips, empty state → `null`, no visuals. `begin()` dims the
  CHIP only for a filetab spec (the pane is not leaving). `drop()` →
  `moveTabToSplit` / `moveTab` / `openTabAt` through `flashOpenResult`.
- Files-ROW drag: `resolve()` unchanged; `'replace'` on an editor pane now adds
  (state); `OPEN_LABEL.replace` `Open here` stays true.
- `files.ts` (inside `initFilesPanel` only; A9 owns the module top and the copy
  row): `pathIsOpen` and `sig()` walk tabs (`is-open` = any view); `openBeside`
  → `openTabAt(v.id, v.focused, where, {kind:'file', path})`.
- Chords (three-way pin main.ts / allowlist / ROWS): ctrl+alt+PageUp/PageDown
  → `cycleTab` (allowlist drops the `shiftKey` qualifier on PageUp/PageDown;
  the shifted branch in main.ts must be tested BEFORE the unshifted one);
  ctrl+alt+m → move active tab to the next editor pane, else new split
  (`dropZonesFor(v, v.focused, 1)[0]`); ctrl+alt+w → `closeActiveTab`
  (allowlist unchanged); ctrl+alt+enter unchanged and still OFF the allowlist.
  `paneChord` gains PageUp/PageDown (unshifted) and `m` so both stand down
  under the commit view. ROWS: rebase onto A9's array; reword ctrl+alt+w
  (`close the active file tab (the last one closes its pane)`, twin `× on the
  tab`), the file-row-on-editor-centre row (`open it there as a tab`, twin
  `click the row`), new rows for pgup/pgdn (twin `click a tab in the pane
  header`), ctrl+alt+m, and the two file-tab gestures (twin ctrl+alt+m).
- Recorded wart: `files.ts destinationOfPane` (A9) answers null for an editor
  slot in a ROOTLESS tab → `This session has no project folder yet.` Same as
  for a file slot today; not a regression.

## 4. Tests

Phase 0 (`ui-state`, `ui-slots-model`, `ui-editor-model`): second file =
TAB in the same pane (pane count 1); same path raises; focused terminal → first
editor pane; no room → `'full'`; `openTabAt` zone matrix + `'replace'` adds on
editor / `'session-centre'` on session; `moveTabToSplit` capacity rule and
focus on the NEW pane after the 2×2 remap; `moveTab` raise-not-duplicate,
emptied source closes, a dirty file's text SURVIVES the move; `closeTab`
active clamp + last-tab ladder; **`slotKey` stability across add/close/switch**
(kills the derived-key mutant); `pruneOrphanEdits` over tabs; persistence never
writes/reads an editor slot; `tabIdOf` byte-equal to `fileTabId`/`diffTabId`.
Phase 1A: NEW `ui-editor-pane.test.ts` (real DOM via fake-dom driving the real
module): chips in order, one `.is-on`, dirty dot + sr-only, `×` closes THAT
tab without raising, same textarea NODE after a tab round-trip, 20 keystrokes
= node identical + chips rebuilt at most once, closed tab leaves the Map,
chip = `armDrag` source with `filetab` spec, chip pointerdown does not arm the
pane drag; `ui-pane-a10` pins rewritten (rebuild key without tab ids, focus key
carries the active tab id, no chip DOM left in panes.ts); `ui-tabs-a10`
(`viewDirty` over tabs, chip names the active tab, pill = panes);
`ui-a6-screens` `.editor-` absence still green.
Phase 1B: `ui-dnd-a10` filetab cases (edge → split zone; another editor centre
→ move + whole-pane box; terminal centre → invalid + state untouched; strip /
chip / own pane → null + no visuals; row on editor centre adds; stale tabId →
nothing); `ui-files-panel` (`is-open` for a tab; second click raises); the
three-way chord pins incl. pgup/pgdn and `m`.
Mutation targets: raise-vs-add branch, `closeTab` clamp, `moveTabToSplit`
capacity, derived `slotKey`, strip sig without the dirty bit, `holdsFocus`
guard removed, `showPaneDrop` zone delete.

## 5. Terminal seam → verify-terminal after Phase 1

Tab switch must NOT resize the neighbour terminal (`top` beside, cycle tabs
20×, zero `resize` lines in server.log); a split from a tab drag MUST (count
changes → rebuild → replay, A10's existing cost); editor↔terminal swap converts
in place (check 8, no `attach` for untouched slots); check 9 with an editor
pane focused (80x24 regression door); check 2: `cat -v` prints nothing for
ctrl+alt+pgup/pgdn/m/w and still prints ctrl+alt+enter's bytes; check 7 with
an editor pane focused; check 3 open/close tabs beside `vim`; A9 re-check:
Explorer drag over an editor pane → whole-pane `Copy into <name>` box.

## 6. Phasing

Gate: A9 committed first. Phase 0 (model, alone; no shim — the `tsc` error
list is the checklist) → Phase 1A (pane + strip + tabs + CSS block inserted
after `pane header`) ∥ Phase 1B (dnd + files four spots + keydown + allowlist
+ ROWS). Neither appends at EOF of `app.css`. Then verify-terminal, scope doc
(`PROJECT-SCOPE.md` tabs/panes + keyboard bullets), `web/DESIGN.md`, vault log.
