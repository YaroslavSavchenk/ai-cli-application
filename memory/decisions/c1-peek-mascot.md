---
type: decision
created: 2026-09-22
updated: 2026-09-22
tags: [nocturne, mascot, overlay, host, session-state]
---
# Peek mascot: when, where, what a click does (part C1, decisions 12–16)

**Status:** decided 2026-09-22 (user, asked before the developers started;
the recommended option each time except the monitor).

- **When (14):** one mascot per session that is PENDING — Claude ended its
  turn (the B11 readout went working → waiting, `turnUnseen`) or rang the
  bell (`attention`) — until the user LOOKS at it (the BEL ack: that pane
  focused with the window in front). Max 3. Rejected: BEL-only; everything
  waiting even after it was seen.
- **Where (12):** the monitor the APP WINDOW is on (not the pointer's — the
  orchestrator's advice — nor the primary).
- **Click (13):** the design's laugh or wave, then the app comes to the front
  on that session (which acks it).
- **Toggle:** Settings → Preferences, `Peek mascot`, default ON.
- **Exclusive fullscreen (15):** accepted as a known limit.
- **Reduced motion (16):** the same art, standing still.

Counts the user reads (statusline, Sessions badge, `Needs you`) stay
BEL-only ([[b11-session-turn-readout]]); only the mascot counts a finished
turn.

Spec `.claude/plans/nocturne/PLAN-C1.md`. Related: [[native-webview2-host]],
[[nocturne-full-switch]].
