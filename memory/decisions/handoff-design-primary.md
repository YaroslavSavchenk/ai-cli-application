---
type: decision
created: 2026-07-20
updated: 2026-07-20
tags: [design, frontend]
---
# Handoff design is the primary design source

**Status:** decided (2026-07-20, user's call); **superseded for visuals 2026-09-10 by [[nocturne-full-switch]]** (v3 handoff; v2 consulted only for interaction details)

Three calls made together at the start of the R2 session, reversing the
2026-07-19 triage recommendations:

1. **Precedence flipped.** The user's hi-fi handoff (`design/README.md` +
   `session-manager-prototype.html`) is now the primary source for look and
   layout ("Follow the design from that handoff design. Thats the main
   now"). `web/DESIGN.md` is rewritten to transcribe the handoff;
   `web/src/styles/tokens.css` is remapped to the handoff's values. The old
   rule — repo steam-blend tokens win, handoff supplies features — lasted
   one day.
2. **Tab strip: dedicated bottom strip** above the statusline (Steam-style),
   not topbar tabs.
3. **Launch UI: modal dialog** (R3), replacing launcher-as-tab. The launcher
   tab also loses its empty-state role to the handoff's centered empty
   state.

## What the flip does NOT change

- Architecture: vanilla TS + Vite, xterm.js, server-owned sessions
  ([[vanilla-ts-vite-frontend]]). The handoff prompt itself defers to the
  established stack.
- The three fiction cuts (grace countdown, launcher boot-overlay steps,
  per-id `--resume`) — lifecycle impossibilities, not looks; see
  [[2026-07-19-design-handoff-and-r1]] and [[lifecycle-bound-backend]].
- No new npm dependencies: Phosphor icons skipped (prototype text glyphs
  used); JetBrains Mono self-hosted as an asset like Barlow (OFL).
- The anti-slop RULE ([[anti-slop-design-direction]]) — but its enforcement
  target moves: the handoff is the user's own design, so its gradient
  topbar, backdrop blur, glow shadows, and 12px radii are user-sanctioned,
  not slop. The frontend-designer reject list still applies wherever the
  handoff is silent.

## Rejected alternatives

- **Keep topbar tabs / launcher-in-tab** (the on-file recommendations):
  rejected by the user in direct answer to both questions.
- **Steam-blend token supremacy**: rejected — the user built the handoff in
  an external tool after using the real app and wants that exact look, not
  a token-mapped approximation.

Related: [[anti-slop-design-direction]], [[2026-07-19-design-handoff-and-r1]]
