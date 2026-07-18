---
name: frontend-designer
description: Design and style the frontend of this app with a distinctive, intentional visual identity. Use before writing or changing ANY UI code — layout, styling, components, theming, colors, fonts. It enforces a hard filter against generic AI-generated aesthetics.
---

# Frontend design for the AI CLI Session Manager

Read `.claude/PROJECT-SCOPE.md` first. If the harness skill `frontend-design`
is available in your session, load that too — this file is the project-specific
filter and identity on top of it.

## What this app IS (design identity)

A keyboard-driven power tool for people who live in terminals. The terminal
pane is the hero; every pixel of chrome exists to serve it. The design
language should feel like it belongs to the lineage of tmux, vim statuslines,
DAWs, and mission-control panels — dense, precise, calm under load — not to
the lineage of SaaS landing pages.

This does NOT mean "default dark dashboard." It means the aesthetic must be
*derived from the terminal*: monospace type used deliberately (not as lazy
decoration), a palette that harmonizes with the xterm color scheme, 1px
precision lines, structural focus states, information density worn proudly.

## HARD REJECT LIST — the slop filter

If the design (or generated code) contains ANY of the following, it fails.
Do not tweak it — redesign it:

- Purple/violet-to-blue gradients, or any "hero gradient" background.
- Glassmorphism: blurred translucent cards, `backdrop-filter` haze.
- The default-Tailwind look: Inter/system font + `rounded-2xl` cards +
  soft drop shadows + gray-50 background. Any one of these can be fine;
  the combination is the template.
- Generic SaaS dashboard shell (icon sidebar + topbar + card grid) applied
  without thought.
- Emoji as icons; sparkle/robot/magic-wand "AI" iconography.
- Centered empty-state illustrations with friendly copy.
- Evenly-distributed timid palettes; decoration that carries no information.
- Fonts chosen by reflex: Inter, Roboto, Arial, and also the AI-favorite
  Space Grotesk. Pick type with intent (e.g. a characterful mono like
  JetBrains Mono, Berkeley Mono, Commit Mono, IBM Plex Mono for UI accents —
  paired with a restrained UI face if mixing).

## Required process

1. **Brief before code.** Write a short design brief: the chosen direction in
   one sentence, and the tokens — palette (with the xterm 16-color scheme it
   harmonizes with), type choices, spacing scale, radii, border treatment.
   For nontrivial UI work, show the brief to the user before implementing.
2. **Tokens first.** All values live as CSS custom properties in one tokens
   file. No hardcoded colors/sizes scattered through components.
3. **One direction, fully committed.** Refined-minimal and dense-industrial
   both work; halfway does not. Intentionality over intensity.
4. **Slop-filter pass.** After building, screenshot-test mentally against the
   reject list, then ask: *"Placed next to 100 AI-generated dashboards, is
   this instantly distinguishable? Does every element carry information or
   structure? Would a tmux power user feel at home?"* Any "no" → redesign
   that part, don't polish it.

## Terminal-specific rules (non-negotiable)

- The terminal pane dominates; chrome recedes. Tabs, statusbars and pane
  headers are thin, quiet, and information-bearing (project name, model,
  mode, attention state) — never decorative.
- The xterm.js theme and the app palette are ONE system, defined together in
  the tokens file. Never let the surrounding UI clash with the terminal
  colors.
- Focus is structural, not glowy: the focused pane gets a crisp accent
  border/edge, unfocused panes dim slightly. Always visible, never ambiguous.
- Attention badges (session waiting for input) must be readable at a glance
  from another tab — a strong accent, not a subtle dot.
- Density over whitespace, but with a strict spacing scale so density reads
  as order, not clutter.
- Every interactive element must be keyboard-reachable; hover-only
  affordances are forbidden.
- Motion: functional micro-transitions only (pane focus, badge arrival,
  layout changes). Nothing animates for decoration; nothing exceeds ~150ms.
