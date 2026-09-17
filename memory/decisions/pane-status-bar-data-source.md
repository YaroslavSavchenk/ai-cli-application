---
type: decision
created: 2026-09-16
updated: 2026-09-17
tags: [nocturne, status-bar, statusline, telemetry]
---
# Pane status bar data source (open decision 2, part B1)

**Status:** decided 2026-09-16 (user; the orchestrator's advice)

Context: Nocturne part B1 (`.claude/PLAN-NOCTURNE.md`) renders a configurable
status bar under each terminal with Model, Permission mode, Git branch, Cost,
Context, Account usage, Active skill, Session time, Lines changed. Since A3
the pane bar states only what the app knows from argv (Model, Mode, Time);
the rest was open decision 2. Asked 2026-09-16 when the user chose the next
part (they picked A9b first; B1 follows).

Decided: **reuse the payload Claude Code already hands
`server/statusline.mjs`** on every turn (model, cost, context %, account
usage %, lines changed, plus the branch the script probes). The script writes
a per-session snapshot into the app data dir the way it already caches the
branch (`statusline-cache.json`: 0600, wiped at boot, keyed so entries stay
bounded), the backend carries it in the session info, and the pane bar
renders the SAME checklist as Settings → Status bar. Active skill has no
source in that payload and is dropped honestly — no placeholder.

Known consequence, accepted: the same values then stand twice on screen
(Claude's own line inside the terminal, see [[2026-07-26-statusline-phase]],
and the pane bar under it) unless the user switches Claude's line off in the
checklist.

## Rejected alternatives
- **Claude Code hooks** per session (via the per-session settings file):
  more moving parts, and the payload already carries every value except
  Active skill. Reconsider for open decision 3 (files the session touches,
  B2), where the payload has nothing.
- **Keep only Claude's own status line, no app strip** (the 2026-07-25
  choice as-is): B1 would then be nothing but the checklist that already
  exists; the v3 design the user chose in full ([[nocturne-full-switch]])
  has the pane bar.

## Implemented 2026-09-17 (B1, [[2026-09-17-nocturne-b1]])

Shape as built, with the orchestrator's defaults the user has not confirmed
one by one: the snapshot is keyed by the APP session id (a fourth argument
to the script — a resumed conversation's `session_id` is the old id, so the
payload key was never safe), one file per session in
`<dataDir>/statusline-snapshots/`; the checklist gained a second switch
(`paneBar`, the bar under the terminal) beside `enabled` (Claude's line),
both ON by default, and a `Session time` row the pane bar alone honours.
Spec `.claude/PLAN-B1.md`.

## Default flipped 2026-09-17 (user, on the Windows check of B1)

The user saw both surfaces at once in the dev window ("het staat nu dubbel
in") and chose, from three options: **the bar under the terminal ON,
Claude's own line OFF by default** (the orchestrator's recommendation — the
bar is the v3 design's place for these values). `enabled` is now `false` in
both factory tables (`server/statusline.mjs` `DEFAULT_CONFIG`,
`ui/statusline-model.ts` FACTORY); a user who explicitly stored
`enabled: true` keeps Claude's line. Rejected: Claude's line only (B1 off by
default), both on (the duplicate the user objected to).
