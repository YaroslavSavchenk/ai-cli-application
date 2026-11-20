---
type: log
created: 2026-11-20
updated: 2026-11-20
tags: [nocturne, mascot, overlay, host, d8]
---
# 2026-11-20 — D8: the mascot steps back while the app is active

**Asked (user):** "maak ook zo dat wanneer de app open is mascotte niet
zichtbaar is, dat hij verwijnt, kleine effect". Decision 24 (asked before
the developers started): "open" = the app window is the ACTIVE window; the
effect = slide back behind the edge (~250 ms, short fade). Replaces
decision 14's "shown even with the app in front" for visibility only.

## Built (branch `d8-mascot-steps-back`)

- Host (`launcher/host/AiSessionManagerHost-overlay*.cs`): the foreground
  hook computes active = `GetForegroundWindow()` is the main form or
  root-owned by it (overlay excluded by handle); posts
  `{"type":"app-active","active":true|false}` to the overlay view only on a
  change, and again after every successful overlay NavigationCompleted.
  `GetForegroundWindow()` instead of the hook's hwnd: queued events lag.
- Page: strict `parseAppActive`/`onAppActive` in `web/src/ui/host-bridge.ts`
  (one `onHostMessage` home with `onFocusSession`); pure `nextPresence` /
  `drawnState` in the model; `MascotPresence` (`web/src/mascot/presence.ts`)
  out → leaving → away; the view animates `.pm-stage.pm-away` (`pmRetreat`
  250 ms) and reports the whole stage as rects while leaving, `[]` once away,
  real rects before the entrance on return. A click reaction finishes first.

## Review

Security clean. Scope: 0 blockers; 5 should/nits fixed (a retreat still
running after `destroy()` would render + post — `view.destroy()` now bumps
the `leave` token). Test-gate: 10 mutants, 2 survived — the presence's and
the view's "called-back slide" guards masked each other in the wired page;
each layer now has its own test. Host: 5 mutants by its developer, all
killed; compiled with csc to a scratch exe.

## Lesson

Two redundant guards in two layers each need a test of their own layer —
an end-to-end test passes with either one missing.
