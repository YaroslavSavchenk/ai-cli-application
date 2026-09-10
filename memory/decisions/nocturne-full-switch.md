---
type: decision
created: 2026-09-10
updated: 2026-09-10
tags: [design, frontend, nocturne]
---
# Nocturne: full switch, Legacy UI kept only as a git tag

**Status:** decided (2026-09-10, user's call); in progress — A1 landed 2026-09-10

The user's v3 design handoff ("Nocturne", `design_handoff_session_manager/`)
replaces the steam-blend skin of v0.3.x wholesale. The old skin is from now on
the **Legacy UI**, preserved only as git tag `legacy-ui` (= `2281465`, the
last commit before A1). No side-by-side mode, no toggle, no theme variants;
the terminal theme popover dies in A8/B8. Nocturne ships as v0.4.0. The plan
with 16 parts (A1–A8 UI first, B1–B8 functionality) lives in
`.claude/PLAN-NOCTURNE.md`; each part starts only on the user's "begin aan
<id>". Supersedes [[handoff-design-primary]] for visuals (the v2 handoff is
consulted only for interaction details v3 lacks) and the "phosphor" /
"steam blend" realisations in [[anti-slop-design-direction]] (the anti-slop
RULE itself stands).

## A1 implementation decisions (2026-09-10)

- **Alias layer, not a rewrite.** `tokens.css` defines the Nocturne
  primitives verbatim (`--color-*`, `--space-*`, `--radius-*`, `--shadow-*`)
  plus README-v3's oklch semantics, and re-points every Legacy role token
  (`--bg-app`, `--acc`, `--sh-pane`, …) at them under a `LEGACY ALIAS LAYER`
  header. `app.css` (3.5k lines, zero hex) recolours untouched; A2–A7 migrate
  components to the primitives; A8 deletes the alias block. Gradients
  collapsed to flat surface/bg (Nocturne's interface has none).
- **xterm palette = exact sRGB hex of the oklch semantics** (ground
  `#0b0d14`, ok `#5bbd74`, attn `#f7c56d`, danger `#f2716a`; blue/magenta/
  cyan chosen on the same OKLCH lightness scale) because xterm.js's colour
  parser takes only hex/rgb(); pinned by `tests/nocturne-tokens.test.ts`.
- **Inter self-hosted** (Google's *latin* variable woff2, 48256 B, OFL) —
  the frontend-designer reject list bans Inter-by-reflex; the handoff's
  deliberate choice is sanctioned (skill text amended). See
  [[google-fonts-subset-trap]] for the latin-ext mistake.
- **Icon** rendered from `app-icon.svg` geometry by `make-icon.mjs` (SDF
  rounded tile + gradient, transparent corners, AND mask), `--check` stays
  the CI gate; `--check --preview` together is refused.
- Host DWM colours → `#161826` / `#e4e7f5` / `#3f424d` (`--color-bg`,
  neutral-200, neutral-800); the border tracks `--edge-strong`, since `--edge`
  is now a translucent `color-mix`. Needs a Windows rebuild.

## Rejected alternatives

- Side-by-side Legacy/Nocturne or a theme toggle — doubles every UI part's
  work and keeps the popover alive; user said full switch.
- Rewriting `app.css` in A1 — the alias layer gives the recolour for free and
  keeps A1 inside one rate-limited session.
- Phosphor icon package — open decision #5, untouched (A1 adds no icon set).
