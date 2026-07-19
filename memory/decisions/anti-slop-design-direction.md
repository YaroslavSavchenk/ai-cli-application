---
type: decision
created: 2026-07-18
updated: 2026-07-18
tags: [design, frontend]
---
# Anti-slop design direction

**Status:** decided (2026-07-18)

The user's explicit, emphatic requirement (2026-07-18): the frontend must NOT
look like generic AI-generated UI — "no standard simple ai gui", and the
design process has to actively filter that out. This is a hard product
requirement, not a preference: a functional UI that looks like an AI template
is a **failed deliverable**.

Implementation: `.claude/skills/frontend-designer/SKILL.md` carries the
enforcement — a hard reject list (purple gradients, glassmorphism,
default-Tailwind combo, SaaS dashboard shell, emoji-as-icons, reflex fonts
including Space Grotesk), a required brief-before-code + tokens-first
process, and a final "distinguishable next to 100 AI dashboards?" filter
pass. The `terminal-ui` agent has that skill preloaded so it cannot do
visual work without it.

Chosen identity: the aesthetic derives from the terminal itself — lineage of
tmux, vim statuslines, DAWs, mission control. Dense, precise, keyboard-first;
xterm color scheme and app palette designed as one token system; structural
(not glowy) focus states; thin information-bearing chrome.

Realized direction v1 (2026-07-18 MVP): **"phosphor instrument panel"** —
warm graphite, mono-only, radius 0, 1px lines, no shadows/gradients, green
focus + amber attention accents. Replaced 2026-07-19.

Realized direction v2 (2026-07-19, SHIPPED): **"steam blend"** implemented —
Steam charcoal-blue surface ramp (#0b0e13 terminals → #28323e raised),
light blue (#66c0f4/#1a9fff) as the ONLY interactive accent, green/amber/
gray status semantics kept, bundled Barlow (OFL) for chrome + mono for all
data, radius ~3px, elevation only on the drag ghost. Full brief +
slop-filter pass in `web/DESIGN.md`; tokens in `web/src/styles/tokens.css`;
reference mockups in `design-mocks/`. Shipped together with the
sessions-as-tabs / drag-to-split interaction model.

**UPDATE 2026-07-19 — aesthetic under revision by user feedback**: after
first real use the user asked for a full GUI redesign — "it needs to feel
like a proper application or look like a good website." The ANTI-SLOP RULE
STANDS unchanged (that's the decision this note records); the *phosphor
skin* is what's being replaced. Phosphor's hard bans on radius/shadow were
skin commitments, not project law — a polished app direction may use
restrained radius/elevation if it stays distinctive. Direction chosen 2026-07-19 from rendered mockups (user: "mix of both",
blend defined by orchestrator): **"steam blend"** — Steam charcoal-blue
surface family with light-blue as the only interactive accent; from the
faithful mock: warmth, softer layering, green primary New-session button,
human status labels; from the terminal mock: mono-for-data typography,
dense rows, flat chrome (radius ~3px, elevation only on the drag ghost),
amber inverse attention badges; status semantics unchanged (green running /
amber attention / gray exited). Reference mockups committed under
`design-mocks/`. Also requested the same day: a new interaction model —
sessions as tabs, drag a tab onto another to form split views
([[frontend-terminal-quirks]] plumbing still applies).

Related: [[agent-team-and-dev-flow]], [[pty-requirements]]
