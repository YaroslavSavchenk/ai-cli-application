---
type: knowledge
created: 2026-09-13
updated: 2026-09-13
tags: [frontend, xterm, testing, mock, gotcha]
---
# Covering the pane grid, and keeping a mock honest — A6 lessons

From [[2026-09-13-nocturne-a6]]; extends [[frontend-terminal-quirks]] and
[[files-panel-focus-owner-trap]].

- **Hide the grid, refuse ALL pane work, replay on return.** A full-screen
  view over the panes sets `grid.hidden`; terminals are kept, not disposed.
  Guarding two of three `render()` branches is not a guard: the reconcile
  branch (session swap, exited-pane relaunch) constructs `TerminalView` on a
  `display:none` node, skips the fit (<20 px) and sends `resize 80x24` to a
  live PTY. One `if (gridHidden()) return;` as the FIRST statement, and the
  screen-layout subscriber (registered before `initPanes`) calls
  `refreshPaneArea()` on unhide. Same rule for every other reader of pane
  geometry or visibility: the window-focus attention ack, the LIVE BEL ack
  and the info-frame ack in `slotEvents()` (a review gated the first, the
  browser gate caught the other two: `attention raised` → `seen` 1 ms
  later under the view), `focusedPaneDims()` for a new session (use the
  running session's own cols/rows, then last good dims).
- **Chords that move invisible panes stand down** while the view is up;
  tab-strip chords stay (the strip is visible).
- **Open the new surface before closing the old one**: opening the editor
  tab first and closing the commit view second gives one layout pass (panes
  rebuilt straight at 46 %) and keeps a button alive through its own click
  handler; then focus the thing you opened.
- **Code surfaces draw plain glyphs** (`font-variant-ligatures: none` on
  editor/diff/paths) — the terminal does, and `===` rendered as `≡` is a
  wrong readout of a file. One shared rule, named as a design-system rule.
- **A mock's numbers must be counted from what the mock draws**, never
  typed. Two lessons inside: (1) model-vs-model tests pass while the
  RENDERER uses a different input (the seed) — test the rows on screen
  against the header; (2) a uniform synthetic rule gives a uniform ratio
  (every five-block bar 3/2) — seed per path so a bar shows something.
- **A missing mock datum is a note, not content**: `null` + one sentence
  row; a sentence with a line number beside it reads as file content.
- **A screen state that can be unresolvable keeps its exit** (`This commit
  is not available.` + Back) — the grid is hidden, Esc is the only other
  way out.
- **`history.list()` sorted by millisecond ISO string only** → ties in the
  same ms left the order to array position and flaked 1 in 4 full runs;
  insertion index as the secondary key.
- All `main.ts` / `panes.ts` wiring can only be pinned by source regex under
  `node --test` (importing `panes.ts` pulls `@xterm/xterm`); behaviour proof
  stays a browser-gate item — list those explicitly in the verify brief.
