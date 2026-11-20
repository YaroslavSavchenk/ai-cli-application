---
type: decision
created: 2026-09-22
updated: 2026-11-20
tags: [nocturne, mascot, overlay, host, session-state]
---
# Peek mascot: when, where, what a click does (part C1, decisions 12–16)

**Status:** decided 2026-09-22 (user, asked before the developers started;
the recommended option each time except the monitor).

- **When (14):** ~~until the user LOOKS at it~~ — changed the same evening
  on the Windows check (user: "hij mag niet zomaar verdwijnen. Alleen als de
  sessie weer aan het werk gaat of wanneer ik een sessie afsluit. zelfs met
  open app moet dit gebeuren"): one mascot per Claude session whose turn
  ENDED (working → waiting, `turnEnded`), shown even with the app in front,
  until that session works again or ends; looking or clicking does not send
  it away. A BEL (`attention`) still shows one until the pane is looked at.
  Max 3.
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

## After the release (2026-09-26)

- **Black box around the mascot**: the colour-key transparency died after
  any resize of the overlay ([[webview2-colour-key-loses-transparency]]).
  The overlay now uses WebView2 visual hosting (DirectComposition,
  per-pixel alpha).
- **Fullscreen** (user: "verschijnt mascotte niet, maar moet wel"): the
  user's game ran borderless. The overlay was above it, and it showed there
  once the mascot was switched back on (it had been off in Settings since
  2026-09-23). The overlay now also re-asserts topmost on every foreground
  change and every count message, for fullscreen windows that are
  themselves topmost. Decision 15 (true exclusive fullscreen) stands.
- **What counts** changed in C2: [[c2-mascot-waits-for-background-work]].

## D8 (2026-11-20): steps back while the app is active

User: "maak ook zo dat wanneer de app open is mascotte niet zichtbaar is,
dat hij verwijnt, kleine effect". Decision 24 replaces decision 14's
"shown even with the app in front" — for VISIBILITY only; which sessions
count (C1/C2) is unchanged. While the app window (or a window it
root-owns) is the foreground window, the stage slides back behind the edge
(250 ms, short fade) and the mascots peek out again when another program is
active. Rejected: hiding whenever the app is merely visible; a fade on the
spot; a wave first. Spec `.claude/plans/nocturne/PLAN-D8.md`.
