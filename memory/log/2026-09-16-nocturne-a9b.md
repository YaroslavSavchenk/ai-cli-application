---
type: log
created: 2026-09-16
updated: 2026-09-16
tags: [nocturne, frontend, files, clipboard, context-menu, testing, review]
---
# 2026-09-16 — Nocturne A9b LANDED: select a folder, paste files into it, a row context menu (mock transport)

User's ask (2026-09-15, after the A9 Windows check): "dragging works, copying
does not yet" — Ctrl+C on files in Explorer, SELECT a folder in the app
(visible), Ctrl+V pastes there; plus a right-click menu on rows. Chosen
2026-09-16 over B1 ("start met de volgende stap"). Spec `.claude/PLAN-A9B.md`
(Plan agent, opus); B10 stays the functional half.

## Decisions (user, 2026-09-16, all three the orchestrator's advice)

(a) one click on a folder row selects it AND toggles it; the selection stays
visible after the focus leaves the panel, until another row, Escape in the
panel, or the panel hiding; the copy strip names it. (b) a FILES paste lands
in the selected folder from anywhere, a focused terminal included (files
carry no text); a text paste is never the app's; no selection = the A9 rule.
(c) a Nocturne context menu: folder rows Open/Close, Copy, Paste, Copy files
here…; file rows Open, Open beside, Copy; Copy and Paste visibly disabled
with a one-line reason until B10 — a browser page cannot read files from the
OS clipboard outside a paste event, nor put files on it. No file operations.
Same day, open decision 2 (B1 data source) settled: the statusline payload
via a per-session cache ([[pane-status-bar-data-source]]).

## What landed (four commits, `951ff90` → `665b28d` → `8873ec6` → `ca9e624`)

- **Phase 0** `ui/files-select-model.ts` (selection transitions, strip label,
  `takesPaste = files && !modalOpen && ((!inTerminal && !inEditable) ||
  selected)`), `ui/context-menu-model.ts` (entries per row kind, flip-then-
  clamp geometry with the margin counted in the flip threshold, wrapping
  navigation), `isContextMenuChord` (ContextMenu / shift+F10, ctrl/alt/meta/
  AltGr rejected). `copyIntoText` moved into the model, re-exported.
- **Brief 1** selection state in `files.ts` (module-local, path-keyed, in
  `sig()`, survives rebuilds; Escape owned by the panel root, the ladder
  untouched), `pasteDestination()` selection first, strip label variable +
  clamped to one line, `.files-row.is-sel` (accent-900 ground + `--tick`
  inset mark, `aria-current`), `onPaste` on `takesPaste` with
  `preventDefault` + `stopPropagation` on a taken paste (xterm's own textarea
  paste would otherwise type a stray `text/plain` into the PTY).
- **Brief 2** `ui/context-menu.ts` (`cm-`, one menu, create/remove, fixed on
  body, NOT a modal, roving focus, seven close triggers + panel hidden, the
  card swallows the browser's own `contextmenu` after the menu key),
  delegated `contextmenu` on the panel root acting only inside `.files-row`
  (`instanceof Element` — the folder icon is an SVG), `--z-menu: 47`,
  `aria-haspopup` on rows, shortcuts rows.

## Lessons

- `tests/no-author-paths.test.ts` scans TRACKED files only: Phase 0 passed
  locally while untracked and failed on CI ([[author-path-guard-tracked-only]]).
- The fake DOM made every `createElementNS` node an `HTMLElement`, so the
  SVG-target bug was invisible to the suite and found only in the browser;
  `tests/fake-dom.ts` now tells SVG from HTML.
- `text-overflow: ellipsis` draws nothing on an anonymous flex item — the
  copy strip became `display: block` + `line-height`.
- Inside a focused terminal only plain Ctrl+V can carry files: `ui/terminal.ts`
  serves Ctrl+Shift+V / Shift+Insert from `readText()` (known limit, in the
  overlay).
- Chromium's own `contextmenu` can follow a prevented Menu-key keydown with
  the focused menu item as target — the card prevents it itself.

## Review

Per phase: scope-reviewer + test-engineer, fixer once each (Phase 0: 2
findings; Brief 1: 7 → 5 fixed + 2 doc; Brief 2: 5 → 4 fixed + 1 doc), 0
disputed. Mutation probes 74 / 17 / 32, every survivor closed. Suite
**2093 → 2231**. Janitor: comments only. Browser evidence per brief (headless
Chromium/Edge over CDP against a scratch backend): files paste in a live Bash
pane with a selection → dialog, nothing reaches the PTY; text paste bracketed
and unchanged; 0 `resize` lines during selection, paste, menu open/flip/
close; right-click in a terminal never prevented. Final verify-terminal gate (test-engineer, headless Chromium 149 over CDP,
scratch backend on `8873ec6`): standard checks 1/2/4/7 PASS; §7 items 1–6
PASS — text paste 26/27 bytes bracketed on both paths; files paste with a
selection → dialog, 0 input bytes over 16.8 s (no ^V), keyboard back in the
terminal; no selection → 12 bytes = empty bracketed paste as before A9b; 0
`resize` lines while the menu opened, flipped and closed; right-click on
screen / pane header / tab strip / statusline never prevented and xterm's
`rightClickHandler` still moves its textarea; ContextMenu key and shift+F10
in a terminal reach xterm (`ESC[21;2~`). Headless caveat: a real OS ctrl+v
cannot be dispatched there, the paste EVENT was synthesised.

## Owed to the user (Windows)

Ctrl+C on files in Explorer → click a folder → Ctrl+V with a terminal
focused; the look of the selected row and the menu in WebView2; plus the A9
checks still open (Explorer drag, copy-strip look). A developer's environment
note, not a code finding: WSL2 localhost forwarding did not work on this
machine during Brief 2 (Windows could not reach a WSL-bound port); worth a
glance if the launcher ever fails to connect.

## Next

B1 (configurable status bar; data source decided) on "begin aan B1"; then
B5, B2, B10 (real copy + host clipboard, which makes the menu's Copy/Paste
live), per the plan order.
