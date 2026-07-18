---
type: knowledge
created: 2026-07-18
updated: 2026-07-18
tags: [frontend, terminal]
---
# Frontend/terminal integration quirks

Non-obvious facts the browser side lives with (discovered during the MVP
build, 2026-07-18):

- **AltGr collides with Ctrl+Alt chords on European Windows layouts** —
  AltGr reports as ctrl+alt, so naive chord handling makes `{[]}`
  untypeable in terminals for German/Polish/etc. layouts. Guard: skip chord
  handling when `getModifierState('AltGraph')` is true (both the app
  handler and xterm's custom key handler). Tradeoff: right-Alt chords don't
  fire on those layouts.
- **xterm.js must open on an ATTACHED, measurable DOM node** — opening on a
  detached node silently breaks measurement and can permanently downgrade
  the WebGL renderer to its fallback. Append the pane root to the grid
  before constructing the terminal view.
- **Attention badges for non-attached sessions ride the 3s poll** — WS
  attention frames reach only attached sockets, and attention-clear doesn't
  broadcast at all ([[pty-requirements]]); cross-tab badge latency is up to
  one poll interval. Sub-second badges would need a backend events channel
  (backlog).
- **The auth token rotates every backend restart** — a page that survived a
  backend restart can never re-auth; 401/403 on the WS path means "dead,
  reload", not "retry". Known gap: the 3s session poll swallows 401/403
  after boot instead of surfacing the reload panel (backlog).
- **Drawer-as-flex-sibling doubles as a resize test** — the sessions/
  projects drawer resizes panes for real (fit → ws resize) instead of
  overlaying them, so merely opening a drawer exercises the whole resize
  chain.
- **xterm's internal z-indexes ESCAPE a non-isolated host** (found
  2026-07-18, first user bug): `.term-host` had `z-index: auto`, so xterm's
  link-layer canvas (z:2) stacked above the launcher form — visually
  perfect, but an invisible canvas ate every click in the pane area. Fix:
  `z-index: 0` on the host creates a stacking context. Lesson: any overlay
  sharing a pane with an xterm mount needs the mount isolated. Diagnostic
  that found it: `document.elementFromPoint()` at the target's center — a
  Playwright click timing out on "hit target" is this bug's signature.
- **Headless UI testing works in this WSL without sudo**: Playwright
  chromium + missing system libs obtained via `apt-get download` +
  `dpkg -x` + `LD_LIBRARY_PATH`. A probe script (goto page, capture
  console/pageerror, elementFromPoint, real click, screenshot) catches
  whole bug classes that typecheck/build/protocol tests cannot. Worth
  promoting into the test-engineer's toolkit as a proper smoke suite.
- **WebGL context-loss fallback is imperfect under SwiftShader**: after
  onContextLoss→dispose, an infinite INVALID_OPERATION delete-spam loop
  appeared in headless Chromium (rendering still worked via DOM renderer).
  Harmless on real GPUs so far; hardening candidate.

Related: [[vanilla-ts-vite-frontend]], [[anti-slop-design-direction]]
