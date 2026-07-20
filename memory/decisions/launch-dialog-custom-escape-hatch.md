---
type: decision
created: 2026-07-20
updated: 2026-07-20
tags: [design, frontend, launch]
---
# Launch dialog gets a custom-command escape hatch

**Status:** decided (2026-07-20, user's call)

The R3 modal launch dialog as specced by the handoff (§8) was claude-only —
`command: 'claude'` hardcoded, no free-text field. The scope-reviewer flagged
the contradiction with the decided Feature "the launched 'agent' is a
configurable command + args, which is what makes multi-CLI support free":
with the launcher tab retired, no GUI path could launch a brand-new
non-claude session (only previous-run replay and raw REST).

**User's decision:** add a custom escape hatch — a fourth preset chip
`custom · any command` that reveals a free-text command field
(whitespace-split argv, no quoting, no shell) and disables the
claude-specific fields (model / resume / permission cards, dimmed not
hidden). Preset chips exit custom mode; project-row `+` opens also exit it
(project intent implies a claude session — fixer round 2). Composition stays
single-path: `currentSpawn()` feeds both the preview and the POST, so the
preview can never diverge from what spawns.

## Rejected alternative

- **Claude-only for now** (ship exactly per handoff §8, narrow the Feature
  bullet, first-class presets for other CLIs when they land): rejected by
  the user in direct answer.

## Notes

- Parsing lives in the pure module `web/src/ui/launch-args.ts`
  (`parseCustomCommand`, `previewLine`, `SpawnSpec`) — DOM/xterm-free so
  `node:test` covers it.
- The handoff is silent on custom commands, so the anti-slop reject list
  applied to the addition; the chip follows the existing
  `name · payload` label convention and reuses existing tokens only.

Related: [[handoff-design-primary]], [[anti-slop-design-direction]],
[[2026-07-20-r3-launch-dialog]]
