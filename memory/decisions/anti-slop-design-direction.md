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

Related: [[agent-team-and-dev-flow]], [[pty-requirements]]
