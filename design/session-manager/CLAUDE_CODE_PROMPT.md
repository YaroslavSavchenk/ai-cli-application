Implement the multi-session AI CLI manager web GUI in this repo, using the
design handoff in `design_handoff_session_manager/`.

Read these first, in order:
1. `design_handoff_session_manager/README.md` — the full spec (screens, layout,
   tokens, interactions, state model). This is the source of truth for look and
   behavior.
2. `design_handoff_session_manager/session-manager-prototype.html` — a working
   HTML prototype of the design. Open/read it to see exact styling and every
   interaction in action.
3. This repo's `web/DESIGN.md` and `web/src/styles/tokens.css` — the real
   "steam blend" design direction and token source. Where the handoff and these
   differ, THESE win; map the handoff's hex values onto the existing tokens
   rather than hard-coding new ones.

Important:
- The HTML files are DESIGN REFERENCES, not code to copy. Recreate the design in
  this project's real front-end stack (in `web/`), following its existing
  patterns, components, and libraries. If no framework is set up yet, use
  React + xterm.js (the natural fit for a keyboard-driven terminal SPA) and set
  it up cleanly.
- Replace ALL mocked data in the prototype with the real backend wiring: one
  WebSocket per session carrying live PTY output with scrollback replay on
  reattach, a presence WebSocket per window for the lifecycle-bound backend, and
  connection/health derived from the launcher's runtime.json. Sessions are
  server-owned and must survive hidden panes.
- The terminal body in each pane must be a real terminal renderer (xterm.js),
  themed with the background + text-ramp system described in the handoff. Status
  colors (green running / amber attention / red exited) are semantic and never
  themed.
- Get the core interaction model right: a TAB is a SCREEN (a group of 1–4
  sessions shown as a split grid), not a single session. Split/merge by dragging
  tabs, pop-out via the ⇱ button, and splits MUST persist across tab switches.
- Match the hi-fi styling faithfully: Barlow for chrome, JetBrains Mono for all
  data/terminal, tight radii (≤12px), 1px lines over shadows, Steam light-blue
  as the one interactive accent. No gradients-as-flood, no glass, no emoji.

Build it incrementally and keep it runnable: start with the app shell + tab/
screen model + one live session, then splits, then the drawers, launch dialog,
theming, and finally the boot/empty/attention lifecycle states. Ask me before
introducing any new dependency beyond the terminal renderer.
