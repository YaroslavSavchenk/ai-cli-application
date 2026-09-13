---
type: knowledge
created: 2026-09-13
updated: 2026-09-13
tags: [frontend, keyboard, focus, gotcha, testing]
---
# A panel that is open by default must not be a "focus owner" — and other A5 lessons

Found in [[2026-09-13-nocturne-a5]]; sits beside [[frontend-terminal-quirks]].

- **`OPEN_FOCUS_OWNER_SELECTOR` is a screen-level gate**: while any match
  is visible, `refocusTerminal()` (window focus / visibilitychange) does
  nothing. Giving the always-open Files panel the shared `drawer` class
  silently disabled the terminal refocus for the whole app — the exact
  2026-09-08 `/login` symptom, invisible to every test because the keys
  tests drove synthetic documents. Rule: a surface that is normally open
  may own focus INSIDE it (element-level `FOCUS_OWNER_SELECTOR`) but never
  the screen. `tests/ui-keys.test.ts` now pins "an open Files panel does
  not own the keyboard" AND requires the literal markup to exist.
- **Reuse a class for CSS, not for semantics.** Shared drawer styling via a
  second selector is fine; sharing the class name hands every JS query on
  that class a new, unintended element.
- **Mock data over a real name needs a marker.** Plan-sanctioned mock data
  rendered under the user's real project name reads as real; one quiet
  sentence per tab from ONE function (`placeholderNote()`) keeps the honesty
  rule and is a one-line deletion in B2/B3.
- **A persisted wish needs its own title.** Once `leftPanel: null` survives
  a reload, "Opens when a session is running" on the Files button becomes a
  false promise; the sentence belongs to the wanted-but-not-shown state only.
- **`tests/fake-dom.ts`** is the shared DOM double (pointer events with
  capture, `style`, `dataset`, `click()`, attribute selectors, recorded
  timers). It drives the real `files.ts` / `sessions.ts` modules with a
  fake store; the older inline double in `tests/ui-launch-dialog.test.ts`
  has select/option semantics the shared one lacks — merging them changes
  assertions, so they stay two (janitor 2026-09-13).
- Separator keyboard contract for this app: arrow keys nudge, home / enter /
  double-click reset, focus ring = the lit strip (`outline: none`), hover a
  dimmer tint than focus/drag.
